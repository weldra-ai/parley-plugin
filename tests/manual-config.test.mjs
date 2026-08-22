import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as manager from "../shared/scripts/managed-config.mjs";

const canonicalOrigin = "https://parley.weldra.dev/mcp";
const managerPath = join(dirname(fileURLToPath(import.meta.url)), "..", "shared", "scripts", "managed-config.mjs");

function runtimeSentinel(letter = "m") {
  return ["p", "n"].join("") + "_" + letter.repeat(24);
}

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
  const root = await mkdtemp(join(tmpdir(), "parley-codex-managed-config-"));
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

    await manager.applyCodexManual({ profileDir, token, canonicalOrigin });
    const configured = await readFile(configPath, "utf8");
    assert.match(configured, /BEGIN PARLEY MANAGED MANUAL OVERRIDE/);
    assert.match(configured, /\[mcp_servers\.parley\]/);
    assert.match(configured, /http_headers = \{ Authorization = "Bearer /);
    assert.equal(countOccurrences(configured, token), 1);
    assert.ok(configured.startsWith(initialConfig));
    assert.equal(await temporaryFiles(root).then((files) => files.length), 0);

    const firstBytes = await readFile(configPath);
    await manager.applyCodexManual({ profileDir, token, canonicalOrigin });
    assert.deepEqual(await readFile(configPath), firstBytes);

    await manager.switchCodexOAuth({ profileDir, canonicalOrigin });
    assert.deepEqual(await readFile(configPath), Buffer.from(initialConfig));
    assert.equal(await temporaryFiles(root).then((files) => files.length), 0);
  });
});

test("Codex manual manager rejects each unowned Parley form without changing config bytes", async (context) => {
  const conflicts = [
    "[mcp_servers.parley]\nurl = \"https://parley.weldra.dev/mcp\"\n",
    "mcp_servers.parley.url = \"https://parley.weldra.dev/mcp\"\n",
    "[mcp_servers]\nparley = { url = \"https://parley.weldra.dev/mcp\" }\n",
  ];
  for (const conflict of conflicts) {
    await context.test(conflict.split("\n", 1)[0], async () => {
      await withCodexProfile(async ({ profileDir, configPath, initialConfig }) => {
        await writeFile(configPath, `${initialConfig}${conflict}`);
        const original = await readFile(configPath);
        await assert.rejects(
          manager.applyCodexManual({ profileDir, token: runtimeSentinel(), canonicalOrigin }),
          /unowned|conflict|Parley/i,
        );
        assert.deepEqual(await readFile(configPath), original);
      });
    });
  }
});

test("Codex CLI reads a manual token only from stdin and keeps it out of terminal output", async () => {
  const root = await mkdtemp(join(tmpdir(), "parley-codex-managed-cli-"));
  const profileDir = join(root, "profile");
  const token = runtimeSentinel("c");
  try {
    const result = await runManager([managerPath, "codex", "manual"], {
      environment: { ...process.env, CODEX_HOME: profileDir },
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
