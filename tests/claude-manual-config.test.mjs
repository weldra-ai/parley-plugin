import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyClaudeManual,
  claudeManagedPaths,
  CLAUDE_MANUAL_SERVER_NAME,
  resolveClaudePaths,
  switchClaudeOAuth,
} from "../shared/scripts/managed-config.mjs";

const canonicalOrigin = "https://parley.weldra.dev/mcp";
const managerPath = join(dirname(fileURLToPath(import.meta.url)), "..", "shared", "scripts", "managed-config.mjs");

function runtimeSentinel(letter = "a") {
  return ["p", "n"].join("") + "_" + letter.repeat(24);
}

async function temporaryFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await temporaryFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".tmp")) {
      files.push(path);
    }
  }
  return files;
}

async function withProfile(run) {
  const root = await mkdtemp(join(tmpdir(), "parley-claude-managed-config-"));
  const profileDir = join(root, "profile");
  const helperSourcePath = join(root, "space-headers.mjs");
  const configPath = join(profileDir, ".claude.json");
  const initialConfig = `${JSON.stringify({
    unrelated: { preserve: true },
    mcpServers: { unrelated: { type: "http", url: "https://example.invalid/mcp" } },
  }, null, 2)}\n`;
  await mkdir(profileDir, { recursive: true });
  await writeFile(configPath, initialConfig);
  await writeFile(helperSourcePath, "process.stdout.write(JSON.stringify({ 'X-Space': 'fixture' }));\n");
  try {
    await run({ root, profileDir, helperSourcePath, configPath, initialConfig });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("Claude manager separates the default config file from the profile-local helper directory", () => {
  const home = join(tmpdir(), "parley managed home");
  assert.deepEqual(resolveClaudePaths({ environment: {}, home }), {
    configPath: join(home, ".claude.json"),
    directory: join(home, ".claude", "parley"),
    helperPath: join(home, ".claude", "parley", "claude-space-headers.mjs"),
    sidecarPath: join(home, ".claude", "parley", "claude-manual-override.json"),
  });

  const profile = join(home, "isolated profile");
  assert.deepEqual(resolveClaudePaths({ environment: { CLAUDE_CONFIG_DIR: profile }, home }), {
    configPath: join(profile, ".claude.json"),
    directory: join(profile, "parley"),
    helperPath: join(profile, "parley", "claude-space-headers.mjs"),
    sidecarPath: join(profile, "parley", "claude-manual-override.json"),
  });
  assert.throws(() => resolveClaudePaths({ environment: { CLAUDE_CONFIG_DIR: "relative" }, home }), /absolute/i);
});

test("Claude manual manager installs one owned same-endpoint override and removes it reversibly", async () => {
  await withProfile(async ({ profileDir, helperSourcePath, configPath }) => {
    const token = runtimeSentinel();
    const first = await applyClaudeManual({ profileDir, token, helperSourcePath, canonicalOrigin });
    const configured = JSON.parse(await readFile(configPath, "utf8"));
    const entry = configured.mcpServers[CLAUDE_MANUAL_SERVER_NAME];
    assert.deepEqual(configured.mcpServers.unrelated, { type: "http", url: "https://example.invalid/mcp" });
    assert.equal(entry.type, "http");
    assert.equal(entry.url, canonicalOrigin);
    assert.equal(entry.headers.Authorization, `Bearer ${token}`);
    assert.match(entry.headersHelper, /claude-space-headers\.mjs/);
    assert.notEqual(first.helperPath, helperSourcePath);
    assert.equal((await readFile(first.helperPath, "utf8")).includes(token), false);
    assert.equal((await readFile(first.sidecarPath, "utf8")).includes(token), false);
    const managedNames = await readdir(first.directory);
    assert.deepEqual(managedNames.sort(), ["claude-manual-override.json", "claude-space-headers.mjs"]);
    assert.equal(managedNames.some((name) => /tmp|backup|lock/i.test(name)), false);

    const firstBytes = await readFile(configPath);
    await applyClaudeManual({ profileDir, token, helperSourcePath, canonicalOrigin });
    assert.deepEqual(await readFile(configPath), firstBytes);

    await switchClaudeOAuth({ profileDir, canonicalOrigin });
    const restored = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(Object.hasOwn(restored.mcpServers, CLAUDE_MANUAL_SERVER_NAME), false);
    assert.deepEqual(restored.mcpServers.unrelated, { type: "http", url: "https://example.invalid/mcp" });
    await assert.rejects(readFile(first.helperPath));
    await assert.rejects(readFile(first.sidecarPath));
  });
});

test("Claude manual manager refuses an unowned Parley override without changing profile bytes", async () => {
  await withProfile(async ({ profileDir, helperSourcePath, configPath }) => {
    const conflict = JSON.parse(await readFile(configPath, "utf8"));
    conflict.mcpServers[CLAUDE_MANUAL_SERVER_NAME] = {
      type: "http",
      url: canonicalOrigin,
      headers: { Authorization: "Bearer unmanaged" },
    };
    await writeFile(configPath, `${JSON.stringify(conflict, null, 2)}\n`);
    const original = await readFile(configPath);
    await assert.rejects(
      applyClaudeManual({ profileDir, token: runtimeSentinel(), helperSourcePath, canonicalOrigin }),
      /conflict|owned/i,
    );
    assert.deepEqual(await readFile(configPath), original);
  });
});

test("Claude manual manager refuses a differently named same-endpoint override without changing profile bytes", async () => {
  await withProfile(async ({ profileDir, helperSourcePath, configPath }) => {
    const conflict = JSON.parse(await readFile(configPath, "utf8"));
    conflict.mcpServers.shadow = { type: "http", url: "https://PARLEY.WELDRA.DEV:443/mcp" };
    await writeFile(configPath, `${JSON.stringify(conflict, null, 2)}\n`);
    const original = await readFile(configPath);
    await assert.rejects(
      applyClaudeManual({ profileDir, token: runtimeSentinel(), helperSourcePath, canonicalOrigin }),
      /different MCP entry|same-endpoint/i,
    );
    assert.deepEqual(await readFile(configPath), original);
  });
});

test("Claude manual manager restores config, helper, and sidecar bytes after every injected transition failure", async () => {
  for (const failAt of ["helper-promotion", "sidecar-promotion", "config-promotion", "validation", "cleanup"]) {
    await withProfile(async ({ profileDir, helperSourcePath, configPath, initialConfig }) => {
      const original = await readFile(configPath);
      await assert.rejects(
        applyClaudeManual({
          profileDir,
          token: runtimeSentinel(),
          helperSourcePath,
          canonicalOrigin,
          failAt,
        }),
        /injected/i,
        failAt,
      );
      assert.deepEqual(await readFile(configPath), original, failAt);
      assert.equal(await readFile(configPath, "utf8"), initialConfig, failAt);
      const paths = claudeManagedPaths(profileDir);
      await assert.rejects(readFile(paths.helperPath), undefined, failAt);
      await assert.rejects(readFile(paths.sidecarPath), undefined, failAt);
      assert.equal((await readdir(paths.directory)).some((name) => /tmp|backup|lock/i.test(name)), false, failAt);
    });
  }
});

test("Claude OAuth switch restores every byte if cleanup fails after removing the stable helper", async () => {
  await withProfile(async ({ profileDir, helperSourcePath, configPath }) => {
    const token = runtimeSentinel();
    const paths = await applyClaudeManual({ profileDir, token, helperSourcePath, canonicalOrigin });
    const originals = {
      config: await readFile(configPath),
      helper: await readFile(paths.helperPath),
      sidecar: await readFile(paths.sidecarPath),
    };
    await assert.rejects(
      switchClaudeOAuth({ profileDir, canonicalOrigin, failAt: "cleanup-after-helper" }),
      /injected/i,
    );
    assert.deepEqual(await readFile(configPath), originals.config);
    assert.deepEqual(await readFile(paths.helperPath), originals.helper);
    assert.deepEqual(await readFile(paths.sidecarPath), originals.sidecar);
  });
});

test("Claude manager rejects an oversized manual token before writing profile data", async () => {
  await withProfile(async ({ profileDir, helperSourcePath, configPath }) => {
    const original = await readFile(configPath);
    const token = `pn_${"a".repeat(16_385)}`;
    await assert.rejects(
      applyClaudeManual({ profileDir, token, helperSourcePath, canonicalOrigin }),
      /invalid/i,
    );
    assert.deepEqual(await readFile(configPath), original);
  });
});

test("Claude manager rejects an active profile lock without changing profile bytes", async () => {
  await withProfile(async ({ profileDir, helperSourcePath, configPath }) => {
    const paths = claudeManagedPaths(profileDir);
    await mkdir(paths.directory, { recursive: true });
    await writeFile(join(paths.directory, ".claude-manual-config.lock"), "busy");
    const original = await readFile(configPath);
    await assert.rejects(
      applyClaudeManual({ profileDir, token: runtimeSentinel(), helperSourcePath, canonicalOrigin }),
      /configuration change holds|already in progress/i,
    );
    assert.deepEqual(await readFile(configPath), original);
  });
});

test("Claude manager serializes concurrent profile changes without leaving a lock", async () => {
  await withProfile(async ({ profileDir, helperSourcePath, configPath }) => {
    const results = await Promise.allSettled([
      applyClaudeManual({ profileDir, token: runtimeSentinel(), helperSourcePath, canonicalOrigin }),
      applyClaudeManual({ profileDir, token: runtimeSentinel(), helperSourcePath, canonicalOrigin }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.match(rejected.reason.message, /\.claude-manual-config\.lock/i);
    const configured = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(Object.hasOwn(configured.mcpServers, CLAUDE_MANUAL_SERVER_NAME), true);
    const paths = claudeManagedPaths(profileDir);
    assert.equal((await readdir(paths.directory)).some((name) => /lock/i.test(name)), false);
  });
});

test("Claude manager reports a conflict and active lock with token-safe next actions", async () => {
  await withProfile(async ({ profileDir, helperSourcePath, configPath }) => {
    const token = runtimeSentinel();
    const conflict = JSON.parse(await readFile(configPath, "utf8"));
    conflict.mcpServers.unrelated = { type: "http", url: canonicalOrigin };
    await writeFile(configPath, `${JSON.stringify(conflict, null, 2)}\n`);
    const conflictResult = await runManager([managerPath, "claude", "manual", "--helper-source", helperSourcePath], {
      environment: { ...process.env, CLAUDE_CONFIG_DIR: profileDir },
      input: `${token}\n`,
    });
    assert.equal(conflictResult.code, 1);
    const conflictStderr = conflictResult.stderr.toString("utf8");
    assert.match(conflictStderr, /\.claude\.json/i);
    assert.match(conflictStderr, /remove or rename/i);
    assert.doesNotMatch(conflictStderr, new RegExp(token));

    conflict.mcpServers.unrelated = { type: "http", url: "https://example.invalid/mcp" };
    await writeFile(configPath, `${JSON.stringify(conflict, null, 2)}\n`);
    const paths = claudeManagedPaths(profileDir);
    await mkdir(paths.directory, { recursive: true });
    await writeFile(join(paths.directory, ".claude-manual-config.lock"), "busy");
    const lockResult = await runManager([managerPath, "claude", "manual", "--helper-source", helperSourcePath], {
      environment: { ...process.env, CLAUDE_CONFIG_DIR: profileDir },
      input: `${token}\n`,
    });
    assert.equal(lockResult.code, 1);
    const lockStderr = lockResult.stderr.toString("utf8");
    assert.match(lockStderr, /\.claude-manual-config\.lock/i);
    assert.match(lockStderr, /retry/i);
    assert.doesNotMatch(lockStderr, new RegExp(token));
  });
});

test("Claude manager restores the transition if lock release fails", async () => {
  await withProfile(async ({ profileDir, helperSourcePath, configPath }) => {
    const original = await readFile(configPath);
    await assert.rejects(
      applyClaudeManual({
        profileDir,
        token: runtimeSentinel(),
        helperSourcePath,
        canonicalOrigin,
        failAt: "lock-release",
      }),
      /injected/i,
    );
    assert.deepEqual(await readFile(configPath), original);
    const paths = claudeManagedPaths(profileDir);
    await assert.rejects(readFile(paths.helperPath));
    await assert.rejects(readFile(paths.sidecarPath));
    assert.equal((await readdir(paths.directory)).some((name) => /tmp|backup|lock/i.test(name)), false);
  });
});

test("Claude manager leaves no bearer temporary file when post-promotion cleanup fails", async () => {
  await withProfile(async ({ root, profileDir, helperSourcePath, configPath }) => {
    const priorToken = runtimeSentinel("a");
    const newToken = runtimeSentinel("b");
    await applyClaudeManual({ profileDir, token: priorToken, helperSourcePath, canonicalOrigin });
    const originalConfig = await readFile(configPath);
    let cleanupCalls = 0;
    const temporaryRemover = async (path) => {
      cleanupCalls += 1;
      if (cleanupCalls === 3) {
        throw new Error("Injected temporary cleanup failure.");
      }
      await rm(path, { force: true });
    };

    await assert.rejects(
      applyClaudeManual({
        profileDir,
        token: newToken,
        helperSourcePath,
        canonicalOrigin,
        failAt: "validation",
        temporaryRemover,
      }),
      /safely restore|temporary cleanup/i,
    );
    assert.equal(cleanupCalls, 3, "the injected failure must occur after the direct config promotion");
    assert.deepEqual(await readFile(configPath), originalConfig);
    const leftovers = await temporaryFiles(root);
    assert.equal(leftovers.length, 0, "a cleanup failure after config promotion must not retain a bearer temporary");
  });
});

test("Claude manager rejects a symlinked helper source before modifying profile bytes", async (context) => {
  await withProfile(async ({ root, profileDir, helperSourcePath, configPath }) => {
    const helperLink = join(root, "linked-helper.mjs");
    try {
      await symlink(helperSourcePath, helperLink, "file");
    } catch (error) {
      if (error?.code === "EPERM") {
        context.skip("the Windows account cannot create a test-only file symlink");
        return;
      }
      throw error;
    }
    const original = await readFile(configPath);
    await assert.rejects(
      applyClaudeManual({ profileDir, token: runtimeSentinel(), helperSourcePath: helperLink, canonicalOrigin }),
      /symlink/i,
    );
    assert.deepEqual(await readFile(configPath), original);
  });
});

test("Claude OAuth switch refuses tampered ownership artifacts without modifying any bytes", async () => {
  await withProfile(async ({ profileDir, helperSourcePath, configPath }) => {
    const paths = await applyClaudeManual({
      profileDir,
      token: runtimeSentinel(),
      helperSourcePath,
      canonicalOrigin,
    });
    await writeFile(paths.helperPath, "tampered helper\n");
    const originals = {
      config: await readFile(configPath),
      helper: await readFile(paths.helperPath),
      sidecar: await readFile(paths.sidecarPath),
    };
    await assert.rejects(switchClaudeOAuth({ profileDir, canonicalOrigin }), /ownership|conflict/i);
    assert.deepEqual(await readFile(configPath), originals.config);
    assert.deepEqual(await readFile(paths.helperPath), originals.helper);
    assert.deepEqual(await readFile(paths.sidecarPath), originals.sidecar);
  });
});

test("Claude OAuth switch refuses tampered ownership sidecar without modifying any bytes", async () => {
  await withProfile(async ({ profileDir, helperSourcePath, configPath }) => {
    const paths = await applyClaudeManual({
      profileDir,
      token: runtimeSentinel(),
      helperSourcePath,
      canonicalOrigin,
    });
    await writeFile(paths.sidecarPath, "{\"schemaVersion\":999}\n");
    const originals = {
      config: await readFile(configPath),
      helper: await readFile(paths.helperPath),
      sidecar: await readFile(paths.sidecarPath),
    };
    await assert.rejects(switchClaudeOAuth({ profileDir, canonicalOrigin }), /ownership|conflict/i);
    assert.deepEqual(await readFile(configPath), originals.config);
    assert.deepEqual(await readFile(paths.helperPath), originals.helper);
    assert.deepEqual(await readFile(paths.sidecarPath), originals.sidecar);
  });
});

test("Claude direct manager invocation works from a path containing spaces and keeps the token out of output", async () => {
  const root = await mkdtemp(join(tmpdir(), "parley managed CLI "));
  const profileDir = join(root, "profile");
  const managerCopy = join(root, "manager with spaces", "managed config.mjs");
  const helperSourcePath = join(root, "space-headers.mjs");
  const token = runtimeSentinel();
  try {
    await mkdir(profileDir, { recursive: true });
    await mkdir(dirname(managerCopy), { recursive: true });
    await cp(managerPath, managerCopy);
    await writeFile(helperSourcePath, "process.stdout.write('{}\\n');\n");
    const result = await runManager([managerCopy, "claude", "manual", "--helper-source", helperSourcePath], {
      environment: { ...process.env, CLAUDE_CONFIG_DIR: profileDir },
      input: `${token}\n`,
    });
    assert.equal(result.code, 0, result.stderr.toString("utf8"));
    assert.match(result.stdout.toString("utf8"), /configured/i);
    assert.doesNotMatch(result.stdout.toString("utf8"), new RegExp(token));
    assert.doesNotMatch(result.stderr.toString("utf8"), new RegExp(token));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
