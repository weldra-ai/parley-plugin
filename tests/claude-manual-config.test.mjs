import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, chmod, lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyClaudeManual,
  claudeManagedPaths,
  CLAUDE_MANUAL_SERVER_NAME,
  resolveClaudePaths,
  switchClaudeOAuth,
} from "../shared/scripts/managed-config.mjs";

const canonicalOrigin = "https://parley.weldra.dev/mcp";
const managerPath = join(dirname(fileURLToPath(import.meta.url)), "..", "shared", "scripts", "managed-config.mjs");
const hangingAclChildPath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "windows-acl-hanging-child.mjs");
const windowsTestSid = "S-1-5-21-1-2-3-4";

function verifiedWindowsAcl(sid = windowsTestSid, accessRules) {
  const ownerRule = {
    sid,
    type: "Allow",
    rights: 2_032_127,
    inherited: false,
    inheritance: 0,
    propagation: 0,
  };
  return {
    code: 0,
    stdout: Buffer.from(`${JSON.stringify({
      currentUserSid: sid,
      daclProtected: true,
      accessRules: accessRules ?? [ownerRule],
    })}\n`),
    stderr: Buffer.alloc(0),
  };
}

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

test("Claude CLI keeps the unsafe rollback remedy for nested aggregate failures without exposing causes", async () => {
  await withProfile(async ({ root }) => {
    const probePath = join(root, "managed-config-cli-error-probe.mjs");
    const source = await readFile(managerPath, "utf8");
    await writeFile(probePath, source);
    const { publicCliError } = await import(pathToFileURL(probePath).href);
    const token = runtimeSentinel("rollback");
    const internalPath = join(root, "profile", "parley", "retained-stage.tmp");
    const unsafeRollback = new AggregateError(
      [new AggregateError([new Error(`restore failed for ${internalPath} with ${token}`)], "nested restoration failure")],
      "Claude configuration change failed (injected transition failure); Parley could not safely restore the selected Claude profile after a failed change. Check .claude.json before retrying.",
    );

    const publicMessage = publicCliError(unsafeRollback);
    assert.equal(
      publicMessage,
      "Parley could not safely restore the selected Claude profile after a failed change. Check .claude.json before retrying.",
    );
    assert.doesNotMatch(publicMessage, new RegExp(token));
    assert.doesNotMatch(publicMessage, new RegExp(internalPath.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")));
    assert.equal(
      publicCliError(new AggregateError([new Error(`restored ${token}`)], "Configuration write and cleanup both failed.")),
      "Parley Claude configuration could not be updated. No changes were kept.",
    );
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
    assert.ok(cleanupCalls >= 3, "the injected failure must occur after atomic config promotion");
    assert.deepEqual(await readFile(configPath), originalConfig);
    const leftovers = await temporaryFiles(root);
    assert.equal(leftovers.length, 0, "a cleanup failure after config promotion must not retain a bearer temporary");
  });
});

test("Claude config stages a bearer at 0600 before replacing a permissive profile", async () => {
  await withProfile(async ({ profileDir, helperSourcePath, configPath }) => {
    const token = runtimeSentinel("c");
    const original = await readFile(configPath);
    await chmod(configPath, 0o666);
    let staged = false;
    await applyClaudeManual({
      profileDir,
      token,
      helperSourcePath,
      canonicalOrigin,
      configFileOps: {
        onStaged: async ({ temporary, target, mode }) => {
          staged = true;
          assert.equal(target, configPath);
          assert.equal(mode, 0o600);
          assert.deepEqual(await readFile(target), original);
          assert.doesNotMatch(await readFile(target, "utf8"), new RegExp(token));
          if (process.platform !== "win32") {
            assert.equal((await lstat(temporary)).mode & 0o077, 0);
          }
        },
      },
    });
    assert.equal(staged, true);
    if (process.platform !== "win32") {
      assert.equal((await lstat(configPath)).mode & 0o077, 0);
    }
  });
});

test("Claude config preserves original bytes after partial staging and interrupted promotion", async () => {
  for (const [name, configFileOps] of [
    [
      "partial staging write",
      {
        temporaryWriter: async (handle, bytes) => {
          await handle.write(bytes.subarray(0, 12));
          throw new Error("Injected partial config write failure.");
        },
      },
    ],
    [
      "interrupted promotion",
      {
        promoter: async () => {
          throw new Error("Injected config promotion interruption.");
        },
      },
    ],
  ]) {
    await withProfile(async ({ root, profileDir, helperSourcePath, configPath }) => {
      const original = await readFile(configPath);
      await assert.rejects(
        applyClaudeManual({
          profileDir,
          token: runtimeSentinel("d"),
          helperSourcePath,
          canonicalOrigin,
          configFileOps,
        }),
        /partial config write|promotion interruption/i,
        name,
      );
      assert.deepEqual(await readFile(configPath), original, name);
      assert.equal((await temporaryFiles(root)).length, 0, name);
    });
  }
});

test("Claude config scrubs a retained staging file before a cleanup failure", async () => {
  await withProfile(async ({ profileDir, helperSourcePath, configPath }) => {
    const token = runtimeSentinel("e");
    const originalToken = runtimeSentinel("h");
    await applyClaudeManual({ profileDir, token: originalToken, helperSourcePath, canonicalOrigin });
    const original = await readFile(configPath);
    let retainedTemporary = null;
    await assert.rejects(
      applyClaudeManual({
        profileDir,
        token,
        helperSourcePath,
        canonicalOrigin,
        configFileOps: {
          temporaryWriter: async (handle, bytes) => {
            await handle.write(bytes);
            throw new Error("Injected config write failure.");
          },
          temporaryRemover: async (path) => {
            retainedTemporary = path;
            throw new Error("Injected config cleanup failure.");
          },
        },
      }),
      (error) => {
        assert.equal(error instanceof AggregateError, true);
        assert.match(error.errors.map(({ message }) => message).join("\n"), /config cleanup/i);
        return true;
      },
    );
    assert.notEqual(retainedTemporary, null);
    const residue = await readFile(retainedTemporary);
    assert.equal(residue.byteLength, 0);
    assert.doesNotMatch(residue.toString("utf8"), new RegExp(token));
    assert.doesNotMatch(residue.toString("utf8"), new RegExp(originalToken));
    assert.deepEqual(await readFile(configPath), original);
  });
});

test("Claude rollback restores config, changed helper, and distinct sidecar after one restoration cleanup failure", async () => {
  await withProfile(async ({ root, profileDir, helperSourcePath, configPath }) => {
    await writeFile(helperSourcePath, "original helper bytes\n");
    const paths = await applyClaudeManual({
      profileDir,
      token: runtimeSentinel("f"),
      helperSourcePath,
      canonicalOrigin,
    });
    const sidecar = JSON.parse(await readFile(paths.sidecarPath, "utf8"));
    sidecar.marker = "original-sidecar-bytes";
    const originalSidecar = Buffer.from(`${JSON.stringify(sidecar, null, 2)}\n`);
    await writeFile(paths.sidecarPath, originalSidecar);
    const originalConfig = await readFile(configPath);
    const originalHelper = await readFile(paths.helperPath);
    await writeFile(helperSourcePath, "changed helper bytes\n");

    let cleanupCalls = 0;
    const temporaryRemover = async (path, options = {}) => {
      cleanupCalls += 1;
      const failingHelperRestore = options.targetPath === paths.helperPath
        ? cleanupCalls > 1
        : options.targetPath === undefined && cleanupCalls === 3;
      if (failingHelperRestore) {
        throw new Error("Injected helper restoration cleanup failure.");
      }
      await rm(path, { force: true });
    };

    const attemptedToken = runtimeSentinel("g");
    await assert.rejects(
      applyClaudeManual({
        profileDir,
        token: attemptedToken,
        helperSourcePath,
        canonicalOrigin,
        failAt: "validation",
        temporaryRemover,
      }),
      /safely restore/i,
    );
    assert.deepEqual(await readFile(configPath), originalConfig);
    assert.deepEqual(await readFile(paths.helperPath), originalHelper);
    assert.deepEqual(await readFile(paths.sidecarPath), originalSidecar);
    for (const path of await temporaryFiles(root)) {
      const residue = await readFile(path, "utf8");
      assert.doesNotMatch(residue, new RegExp(attemptedToken));
    }
  });
});

test("Claude config syncs its parent after every POSIX promotion, including rollback", async () => {
  await withProfile(async ({ profileDir, helperSourcePath }) => {
    const events = [];
    const configFileOps = {
      platform: "linux",
      ownerPrivateVerifier: async () => {},
      temporaryWriter: async (handle, bytes) => {
        events.push("write");
        await handle.writeFile(bytes);
      },
      promoter: async (temporary, target) => {
        events.push("rename");
        await rename(temporary, target);
      },
      rollbackPromoter: async (temporary, target) => {
        events.push("rollback-rename");
        await rename(temporary, target);
      },
      directoryOpener: async (directory, flags) => {
        events.push(`open:${directory}:${flags}`);
        return {
          sync: async () => events.push("directory-sync"),
          close: async () => events.push("directory-close"),
        };
      },
    };

    await assert.rejects(
      applyClaudeManual({
        profileDir,
        token: runtimeSentinel("i"),
        helperSourcePath,
        canonicalOrigin,
        failAt: "validation",
        configFileOps,
      }),
      /injected validation failure/i,
    );
    assert.deepEqual(events.map((event) => event.replace(/^open:.*:r$/, "directory-open")), [
      "write",
      "rename",
      "directory-open",
      "directory-sync",
      "directory-close",
      "rollback-rename",
      "directory-open",
      "directory-sync",
      "directory-close",
    ]);
  });
});

test("Claude config preserves a primary staging error alongside cleanup failure", async () => {
  await withProfile(async ({ profileDir, helperSourcePath, configPath }) => {
    const original = await readFile(configPath);
    await assert.rejects(
      applyClaudeManual({
        profileDir,
        token: runtimeSentinel("j"),
        helperSourcePath,
        canonicalOrigin,
        configFileOps: {
          temporaryWriter: async () => {
            throw new Error("Injected primary config staging failure.");
          },
          temporaryRemover: async () => {
            throw new Error("Injected config cleanup failure.");
          },
        },
      }),
      (error) => {
        assert.equal(error instanceof AggregateError, true);
        assert.match(error.errors[0].message, /primary config staging/i);
        assert.match(error.errors[1].message, /config cleanup/i);
        return true;
      },
    );
    assert.deepEqual(await readFile(configPath), original);
  });
});

test("Claude config validates a fully-qualified Windows ACL command and its verified SID DACL before bearer write", async () => {
  await withProfile(async ({ profileDir, helperSourcePath }) => {
    const token = runtimeSentinel("k");
    const calls = [];
    const systemPath = process.execPath;
    await applyClaudeManual({
      profileDir,
      token,
      helperSourcePath,
      canonicalOrigin,
      configFileOps: {
        platform: "win32",
        windowsSystemPathResolver: async () => ({ executable: systemPath, prefixArgs: [] }),
        processRunner: async (command, args, options) => {
          calls.push({ command, args, options });
          assert.equal(options.shell, false);
          assert.equal(options.timeoutMs, 3_000);
          assert.equal(command, systemPath);
          assert.equal(isAbsolute(command), true);
          assert.equal(args.some((argument) => String(argument).includes(token)), false);
          return verifiedWindowsAcl();
        },
        temporaryWriter: async (handle, bytes) => {
          assert.equal(calls.length, 1);
          await handle.writeFile(bytes);
        },
      },
    });
    assert.equal(calls.length, 1);
  });
});

test("Claude config fails closed before bearer write when a successful Windows ACL command reports a broad DACL", async () => {
  await withProfile(async ({ profileDir, helperSourcePath, configPath }) => {
    const token = runtimeSentinel("l");
    const original = await readFile(configPath);
    let retainedTemporary = null;
    let attemptedWrite = false;
    await assert.rejects(
      applyClaudeManual({
        profileDir,
        token,
        helperSourcePath,
        canonicalOrigin,
        configFileOps: {
          platform: "win32",
          windowsSystemPathResolver: async () => ({ executable: process.execPath, prefixArgs: [] }),
          processRunner: async () => verifiedWindowsAcl(windowsTestSid, [
            {
              sid: windowsTestSid,
              type: "Allow",
              rights: 2_032_127,
              inherited: false,
              inheritance: 0,
              propagation: 0,
            },
            {
              sid: "S-1-1-0",
              type: "Allow",
              rights: 2_032_127,
              inherited: false,
              inheritance: 0,
              propagation: 0,
            },
          ]),
          temporaryWriter: async () => {
            attemptedWrite = true;
          },
          temporaryRemover: async (path) => {
            retainedTemporary = path;
            throw new Error("Injected cleanup failure.");
          },
        },
      }),
      (error) => {
        assert.equal(error instanceof AggregateError, true);
        assert.match(error.errors.map(({ message }) => message).join("\n"), /DACL/i);
        return true;
      },
    );
    assert.equal(attemptedWrite, false);
    assert.notEqual(retainedTemporary, null);
    assert.equal((await readFile(retainedTemporary)).byteLength, 0);
    assert.deepEqual(await readFile(configPath), original);
  });
});

test("Claude config rejects inconsistent Windows system roots before the bearer writer runs", async () => {
  await withProfile(async ({ profileDir, helperSourcePath, configPath }) => {
    const original = await readFile(configPath);
    let attemptedWrite = false;
    await assert.rejects(
      applyClaudeManual({
        profileDir,
        token: runtimeSentinel("m"),
        helperSourcePath,
        canonicalOrigin,
        configFileOps: {
          platform: "win32",
          windowsEnvironment: { SystemRoot: "C:\\Windows", windir: "D:\\Windows" },
          processRunner: async () => {
            assert.fail("an inconsistent system root must fail before launching an ACL subprocess");
          },
          temporaryWriter: async () => {
            attemptedWrite = true;
          },
        },
      }),
      /SystemRoot.*windir/i,
    );
    assert.equal(attemptedWrite, false);
    assert.deepEqual(await readFile(configPath), original);
  });
});

test("Claude config reaps a real timed-out Windows ACL child before staging cleanup when its descendant has ignored stdio", async () => {
  await withProfile(async ({ root, profileDir, helperSourcePath, configPath }) => {
    const original = await readFile(configPath);
    const releaseMarker = join(root, "acl-child-released");
    let attemptedWrite = false;
    let cleanupObservedRelease = false;
    await assert.rejects(
      applyClaudeManual({
        profileDir,
        token: runtimeSentinel("n"),
        helperSourcePath,
        canonicalOrigin,
        configFileOps: {
          platform: "win32",
          windowsAclTimeoutMs: 500,
          windowsAclTerminationGraceMs: 50,
          windowsAclReapTimeoutMs: 1_000,
          windowsSystemPathResolver: async () => ({
            executable: process.execPath,
            prefixArgs: [hangingAclChildPath, releaseMarker],
          }),
          temporaryWriter: async () => {
            attemptedWrite = true;
          },
          temporaryRemover: async (path) => {
            try {
              cleanupObservedRelease = (await readFile(releaseMarker, "utf8")) === "released\n";
            } catch {
              cleanupObservedRelease = false;
            }
            await rm(path, { force: true });
          },
        },
      }),
      /timed out/i,
    );
    assert.equal(attemptedWrite, false);
    assert.equal(cleanupObservedRelease, true, "cleanup must wait for the production reaping window, not inherited pipes");
    assert.deepEqual(await readFile(configPath), original);
  });
});

test("Claude rollback preserves the Windows ACL runner and system-path seam", async () => {
  await withProfile(async ({ profileDir, helperSourcePath, configPath }) => {
    const original = await readFile(configPath);
    const calls = [];
    const systemPath = process.execPath;
    await assert.rejects(
      applyClaudeManual({
        profileDir,
        token: runtimeSentinel("o"),
        helperSourcePath,
        canonicalOrigin,
        failAt: "validation",
        configFileOps: {
          platform: "win32",
          windowsSystemPathResolver: async () => ({ executable: systemPath, prefixArgs: [] }),
          processRunner: async (command) => {
            assert.equal(command, systemPath);
            calls.push(command);
            return verifiedWindowsAcl();
          },
        },
      }),
      /injected validation failure/i,
    );
    assert.deepEqual(calls, [systemPath, systemPath]);
    assert.deepEqual(await readFile(configPath), original);
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
