import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as managerProduction from "../shared/scripts/managed-config.mjs";

const canonicalOrigin = "https://parley.weldra.dev/mcp";
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const managerPath = join(repositoryRoot, "shared", "scripts", "managed-config.mjs");
const windowsTestSid = "S-1-5-21-1-2-3-4";
const windowsFixtureExecutable = "C:\\Windows\\System32\\fixture.exe";

function verifiedWindowsAcl() {
  return {
    code: 0,
    stdout: Buffer.from(`${JSON.stringify({
      currentUserSid: windowsTestSid,
      daclProtected: true,
      accessRules: [{
        sid: windowsTestSid,
        type: "Allow",
        rights: 2_032_127,
        inherited: false,
        inheritance: 0,
        propagation: 0,
      }],
    })}\n`),
    stderr: Buffer.alloc(0),
  };
}

function hermeticConfigFileOps(overrides) {
  const windowsDefaults = (overrides?.platform ?? process.platform) === "win32"
    ? {
        windowsEnvironment: { SystemRoot: "C:\\Windows", windir: "C:\\Windows" },
        windowsSystemPathResolver: async () => ({ executable: windowsFixtureExecutable, prefixArgs: [] }),
        processRunner: async () => verifiedWindowsAcl(),
      }
    : {};
  return { ...windowsDefaults, ...(overrides ?? {}) };
}

const manager = {
  ...managerProduction,
  applyCodexManual(options) {
    return managerProduction.applyCodexManual({
      ...options,
      configFileOps: hermeticConfigFileOps(options?.configFileOps),
    });
  },
  switchCodexOAuth(options) {
    return managerProduction.switchCodexOAuth({
      ...options,
      configFileOps: hermeticConfigFileOps(options?.configFileOps),
    });
  },
};

async function canonicalTemporaryDirectory(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function acceptedCodexExecutable(root) {
  const directory = join(root, "bin");
  await mkdir(directory, { recursive: true });
  const path = join(directory, process.platform === "win32" ? "codex.cmd" : "codex");
  await writeFile(path, process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
  if (process.platform !== "win32") {
    await chmod(path, 0o755);
  }
  return directory;
}

function runtimeSentinel(letter = "m") {
  return ["p", "n"].join("") + "_" + letter.repeat(24);
}

async function acceptedCodexHostValidator() {}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}

async function temporaryFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...await temporaryFiles(path));
    } else if (entry.name.endsWith(".tmp") || entry.name.endsWith(".backup")) {
      results.push(path);
    }
  }
  return results;
}

function runManager(args, { environment, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
    child.stdin.end(input);
  });
}

async function withCodexProfile(run) {
  const root = await canonicalTemporaryDirectory("parley-codex-managed-config-");
  const profileDir = join(root, "profile");
  const configPath = join(profileDir, "config.toml");
  const initialConfig = [
    "model = \"gpt-5.6\"",
    "",
    "[mcp_servers.unrelated]",
    "url = \"https://example.invalid/mcp\"",
    "",
  ].join("\n");
  await mkdir(profileDir, { recursive: true });
  await writeFile(configPath, initialConfig);
  try {
    await run({ root, profileDir, configPath, initialConfig });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Codex manager resolves an exact config.toml profile path", () => {
  const home = join(tmpdir(), "parley codex home");
  assert.equal(typeof manager.resolveCodexPaths, "function");
  assert.deepEqual(manager.resolveCodexPaths({ environment: {}, home }), {
    configPath: join(home, ".codex", "config.toml"),
    directory: join(home, ".codex"),
  });
  const profileDir = join(home, "isolated profile");
  assert.deepEqual(manager.resolveCodexPaths({ environment: { CODEX_HOME: profileDir }, home }), {
    configPath: join(profileDir, "config.toml"),
    directory: profileDir,
  });
  assert.throws(() => manager.resolveCodexPaths({ environment: { CODEX_HOME: "relative" }, home }), /absolute/i);
});

test("Codex manual manager owns one private contiguous block and reverses it byte-for-byte", async () => {
  await withCodexProfile(async ({ root, profileDir, configPath, initialConfig }) => {
    const token = runtimeSentinel();
    assert.equal(typeof manager.applyCodexManual, "function");
    assert.equal(typeof manager.switchCodexOAuth, "function");

    await manager.applyCodexManual({ profileDir, token, canonicalOrigin, hostValidator: acceptedCodexHostValidator });
    const configured = await readFile(configPath, "utf8");
    assert.match(configured, /BEGIN PARLEY MANAGED MANUAL OVERRIDE/);
    assert.match(configured, /\[mcp_servers\.parley\]/);
    assert.match(configured, /http_headers = \{ Authorization = "Bearer /);
    assert.equal(countOccurrences(configured, token), 1);
    assert.ok(configured.startsWith(initialConfig));
    assert.equal(await temporaryFiles(root).then((files) => files.length), 0);

    const firstBytes = await readFile(configPath);
    await manager.applyCodexManual({ profileDir, token, canonicalOrigin, hostValidator: acceptedCodexHostValidator });
    assert.deepEqual(await readFile(configPath), firstBytes);

    await manager.switchCodexOAuth({ profileDir, canonicalOrigin, hostValidator: acceptedCodexHostValidator });
    assert.deepEqual(await readFile(configPath), Buffer.from(initialConfig));
    assert.equal(await temporaryFiles(root).then((files) => files.length), 0);
  });
});

test("Codex manual manager rejects each unowned Parley form without changing config bytes", async (context) => {
  const conflicts = [
    "[mcp_servers.parley]\nurl = \"https://parley.weldra.dev/mcp\"\n",
    "mcp_servers.parley.url = \"https://parley.weldra.dev/mcp\"\n",
    "[mcp_servers]\nparley = { url = \"https://parley.weldra.dev/mcp\" }\n",
    "[\"mcp_servers\".parley]\nurl = \"https://parley.weldra.dev/mcp\"\n",
    "[\"mcp_servers\".\"parley\"]\nurl = \"https://parley.weldra.dev/mcp\"\n",
    "\"mcp_servers\".parley.url = \"https://parley.weldra.dev/mcp\"\n",
    "[mcp_servers]\n\"parley\" = { url = \"https://parley.weldra.dev/mcp\" }\n",
    "mcp_servers = { \"parley\" = { url = \"https://parley.weldra.dev/mcp\" } }\n",
    "mcp_servers = { \"p\\u0061rley\" = { url = \"https://parley.weldra.dev/mcp\" } }\n",
    "[\"\\U0000006Dcp_servers\".parley]\nurl = \"https://parley.weldra.dev/mcp\"\n",
    "[mcp_servers.\"\\U00000070arley\"]\nurl = \"https://parley.weldra.dev/mcp\"\n",
    "[mcp_servers.\"\\U00110000\"]\nurl = \"https://parley.weldra.dev/mcp\"\n",
    "[mcp_servers.]\nurl = \"https://parley.weldra.dev/mcp\"\n",
    "[\"mcp_servers\\q\".parley]\nurl = \"https://parley.weldra.dev/mcp\"\n",
    "[\"\\u006dcp_servers\\q\".parley]\nurl = \"https://parley.weldra.dev/mcp\"\n",
    "[\"\\u006dcp_servers\\u000\".parley]\nurl = \"https://parley.weldra.dev/mcp\"\n",
    "[\"\\U0000006Dcp_servers\\U0000\".parley]\nurl = \"https://parley.weldra.dev/mcp\"\n",
  ];
  for (const conflict of conflicts) {
    await context.test(conflict.split("\n", 1)[0], async () => {
      await withCodexProfile(async ({ profileDir, configPath, initialConfig }) => {
        await writeFile(configPath, `${initialConfig}${conflict}`);
        const original = await readFile(configPath);
        await assert.rejects(
          manager.applyCodexManual({
            profileDir,
            token: runtimeSentinel(),
            canonicalOrigin,
            hostValidator: acceptedCodexHostValidator,
          }),
          /unowned|conflict|Parley/i,
        );
        assert.deepEqual(await readFile(configPath), original);
      });
    });
  }
});

test("Codex manager preserves clearly unrelated quoted top-level TOML bytes", async () => {
  await withCodexProfile(async ({ profileDir, configPath, initialConfig }) => {
    const unrelated = `${initialConfig}[\"unrelated\".extension]\nenabled = true\n`;
    await writeFile(configPath, unrelated);
    const original = await readFile(configPath);
    await manager.applyCodexManual({
      profileDir,
      token: runtimeSentinel("q"),
      canonicalOrigin,
      hostValidator: acceptedCodexHostValidator,
    });
    assert.ok((await readFile(configPath)).subarray(0, original.length).equals(original));
    await manager.switchCodexOAuth({ profileDir, canonicalOrigin, hostValidator: acceptedCodexHostValidator });
    assert.deepEqual(await readFile(configPath), original);
  });
});

test("Codex manager rejects malformed unrelated quoted TOML before mutation", async () => {
  await withCodexProfile(async ({ profileDir, configPath, initialConfig }) => {
    const malformed = `${initialConfig}[\"unrelated\\q\".extension]\nenabled = true\n`;
    await writeFile(configPath, malformed);
    const original = await readFile(configPath);
    await assert.rejects(
      manager.applyCodexManual({
        profileDir,
        token: runtimeSentinel("r"),
        canonicalOrigin,
        hostValidator: acceptedCodexHostValidator,
      }),
      /unowned|conflict|Parley/i,
    );
    assert.deepEqual(await readFile(configPath), original);
  });
});

test("Codex manual manager invokes the selected-profile host validator after promotion", async () => {
  await withCodexProfile(async ({ profileDir, configPath, initialConfig }) => {
    const calls = [];
    await manager.applyCodexManual({
      profileDir,
      token: runtimeSentinel("v"),
      canonicalOrigin,
      hostValidator: async ({ configPath: validatedPath, profileDir: validatedProfile }) => {
        calls.push({ validatedPath, validatedProfile, observed: await readFile(validatedPath) });
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].validatedPath, configPath);
    assert.equal(calls[0].validatedProfile, profileDir);
    assert.match(calls[0].observed.toString("utf8"), /BEGIN PARLEY MANAGED MANUAL OVERRIDE/);
    assert.match((await readFile(configPath, "utf8")), /BEGIN PARLEY MANAGED MANUAL OVERRIDE/);
    assert.ok((await readFile(configPath, "utf8")).startsWith(initialConfig));
  });
});

test("Codex manual manager restores exact profile bytes when host validation rejects the promoted config", async () => {
  await withCodexProfile(async ({ profileDir, configPath, initialConfig }) => {
    await assert.rejects(
      manager.applyCodexManual({
        profileDir,
        token: runtimeSentinel("r"),
        canonicalOrigin,
        hostValidator: async () => {
          throw new Error("synthetic host parse failure");
        },
      }),
      /host parse failure/i,
    );
    assert.deepEqual(await readFile(configPath), Buffer.from(initialConfig));
  });
});

test("Codex OAuth removal validates the selected candidate and restores its manual bytes on host failure", async () => {
  await withCodexProfile(async ({ profileDir, configPath, initialConfig }) => {
    await manager.applyCodexManual({
      profileDir,
      token: runtimeSentinel("o"),
      canonicalOrigin,
      hostValidator: acceptedCodexHostValidator,
    });
    const manualBytes = await readFile(configPath);
    const calls = [];
    await assert.rejects(
      manager.switchCodexOAuth({
        profileDir,
        canonicalOrigin,
        hostValidator: async ({ configPath: validatedPath, profileDir: validatedProfile }) => {
          calls.push({ validatedPath, validatedProfile, observed: await readFile(validatedPath) });
          throw new Error("synthetic host removal parse failure");
        },
      }),
      /host removal parse failure/i,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].validatedPath, configPath);
    assert.equal(calls[0].validatedProfile, profileDir);
    assert.deepEqual(calls[0].observed, Buffer.from(initialConfig));
    assert.deepEqual(await readFile(configPath), manualBytes);
  });
});

test("Codex manual manager restores original bytes when the host process is unavailable", async () => {
  await withCodexProfile(async ({ profileDir, configPath, initialConfig }) => {
    await assert.rejects(
      manager.applyCodexManual({
        profileDir,
        token: runtimeSentinel("u"),
        canonicalOrigin,
        hostValidator: (input) => manager.validateCodexHostProfile({
          ...input,
          hostRunner: async () => {
            throw new Error("synthetic unavailable host process");
          },
        }),
      }),
      /Codex host configuration validation failed/i,
    );
    assert.deepEqual(await readFile(configPath), Buffer.from(initialConfig));
  });
});

test("Codex host validation fails deterministically when its host runner is unavailable", async () => {
  await withCodexProfile(async ({ profileDir, configPath }) => {
    assert.equal(typeof manager.validateCodexHostProfile, "function");
    await assert.rejects(
      manager.validateCodexHostProfile({
        profileDir,
        configPath,
        hostRunner: async () => {
          throw new Error("synthetic missing Codex binary");
        },
      }),
      /Codex host configuration validation failed/i,
    );
  });
});

test("Codex host validation receives only the exact selected CODEX_HOME and static command arguments", async () => {
  await withCodexProfile(async ({ profileDir, configPath }) => {
    const calls = [];
    await manager.validateCodexHostProfile({
      profileDir,
      configPath,
      hostExecutableResolver: async () => process.platform === "win32"
        ? "C:\\trusted-bin\\codex.exe"
        : "/opt/parley-fixture/codex",
      hostRunner: async (input) => {
        calls.push(input);
        return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].environment.CODEX_HOME, profileDir);
    assert.equal(calls[0].configPath, configPath);
    assert.equal(JSON.stringify(calls[0].args).includes(runtimeSentinel("z")), false);
  });
});

test("Codex host validation resolves the Windows CLI before invoking the trusted command processor", async () => {
  await withCodexProfile(async ({ profileDir, configPath }) => {
    const resolvedCodex = "C:\\trusted-bin\\codex.cmd";
    const calls = [];
    await manager.validateCodexHostProfile({
      profileDir,
      configPath,
      platform: "win32",
      environment: {
        SystemRoot: "C:\\Windows",
        windir: "C:\\Windows",
        PATH: "C:\\trusted-bin",
        PATHEXT: ".EXE;.CMD",
      },
      hostExecutableResolver: async (name) => {
        assert.equal(name, "codex");
        return resolvedCodex;
      },
      hostRunner: async (input) => {
        calls.push(input);
        return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, "C:\\Windows\\System32\\cmd.exe");
    assert.match(calls[0].args.at(-1), /C:\\trusted-bin\\codex\.cmd/i);
    assert.doesNotMatch(calls[0].args.at(-1), /^codex\s/i);
  });
});

test("Codex PowerShell wrapper resolves Node outside the project before sending a token", async () => {
  const powershell = await readFile(join(repositoryRoot, "hosts", "codex", "scripts", "connect-manual.ps1"), "utf8");
  assert.match(powershell, /FileName\s*=\s*\$nodePath/i);
  assert.doesNotMatch(powershell, /FileName\s*=\s*["']node["']/i);
  assert.match(powershell, /&\s+\$nodePath\s+\$manager\s+codex\s+oauth/i);
  assert.doesNotMatch(powershell, /&\s+node\b/i);
});

test("Codex rollback preserves the Windows ACL runner and system-path seam", async () => {
  await withCodexProfile(async ({ profileDir, configPath, initialConfig }) => {
    const calls = [];
    await assert.rejects(
      manager.applyCodexManual({
        profileDir,
        token: runtimeSentinel("w"),
        canonicalOrigin,
        hostValidator: async () => {
          throw new Error("synthetic host validation failure");
        },
        configFileOps: {
          platform: "win32",
          windowsEnvironment: { SystemRoot: "C:\\Windows", windir: "C:\\Windows" },
          windowsSystemPathResolver: async () => ({ executable: windowsFixtureExecutable, prefixArgs: [] }),
          processRunner: async (command) => {
            assert.equal(command, windowsFixtureExecutable);
            calls.push(command);
            return verifiedWindowsAcl();
          },
        },
      }),
      /synthetic host validation failure/i,
    );
    assert.deepEqual(calls, [windowsFixtureExecutable, windowsFixtureExecutable]);
    assert.deepEqual(await readFile(configPath), Buffer.from(initialConfig));
  });
});

test("Codex CLI preserves the unsafe rollback remedy without exposing nested causes", () => {
  assert.equal(typeof manager.publicCliError, "function");
  const remedy = "Parley could not safely restore the selected Codex profile after a failed change. Check config.toml before retrying.";
  assert.equal(manager.publicCliError(new Error(remedy), "Codex"), remedy);
  assert.equal(
    manager.publicCliError(new AggregateError([new Error("synthetic internal detail"), new Error(remedy)], "outer failure"), "Codex"),
    remedy,
  );
  assert.equal(
    manager.publicCliError(new Error("synthetic host parser failure"), "Codex"),
    "Parley Codex configuration could not be updated. No changes were kept.",
  );
});

test("Codex CLI reads a manual token only from stdin and keeps it out of terminal output", async (context) => {
  if (process.platform === "win32") {
    context.skip("direct CLI mutation uses the real Windows ACL boundary; deterministic ACL behavior is covered separately");
    return;
  }
  const root = await canonicalTemporaryDirectory("parley-codex-managed-cli-");
  const profileDir = join(root, "profile");
  const token = runtimeSentinel("c");
  try {
    const executableDirectory = await acceptedCodexExecutable(root);
    const result = await runManager([managerPath, "codex", "manual"], {
      environment: {
        ...process.env,
        CODEX_HOME: profileDir,
        PATH: `${executableDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      },
      input: `${token}\n`,
    });
    assert.equal(result.code, 0, result.stderr.toString("utf8"));
    assert.match(result.stdout.toString("utf8"), /configured/i);
    assert.doesNotMatch(result.stdout.toString("utf8"), new RegExp(token));
    assert.doesNotMatch(result.stderr.toString("utf8"), new RegExp(token));
    const files = await readdir(profileDir);
    assert.deepEqual(files, ["config.toml"]);
    assert.equal(countOccurrences(await readFile(join(profileDir, "config.toml"), "utf8"), token), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
