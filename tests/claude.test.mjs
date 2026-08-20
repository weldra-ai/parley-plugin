import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildArtifacts } from "../scripts/build.mjs";
import { validateArtifacts } from "../scripts/validate.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const claudeRoot = join(repositoryRoot, "hosts", "claude");
const helperPath = join(claudeRoot, "scripts", "space-headers.mjs");
const canonicalOrigin = "https://parley.weldra.dev/mcp";
const helperCommand = "node \"${CLAUDE_PLUGIN_ROOT}/scripts/space-headers.mjs\" \"${CLAUDE_PROJECT_DIR}\"";

function run(command, args, { cwd, environment = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

async function runGit(cwd, ...args) {
  const result = await run("git", args, { cwd });
  assert.equal(result.signal, null, result.stderr.toString("utf8"));
  assert.equal(result.code, 0, result.stderr.toString("utf8"));
  return result.stdout.toString("utf8");
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function compatibility() {
  const host = {
    testedVersions: [],
    operatingSystems: ["windows", "macos", "linux"],
    authModes: ["oauth"],
    minimumSupport: {
      minimumVersion: null,
      enforcedBy: "omitting/disabling capability",
      capability: "host-specific lifecycle automation",
      certification: "pending",
    },
  };
  return {
    schemaVersion: 1,
    canonicalMcpOrigin: canonicalOrigin,
    lifecycleMode: "oauth",
    hosts: { codex: host, claude: host, gemini: host },
  };
}

function claudeManifest() {
  return {
    name: "parley",
    version: "0.1.0",
    description: "Parley coordination for coding agents.",
    author: { name: "Weldra" },
  };
}

function claudeMcp({
  headers,
  headersHelper = helperCommand,
} = {}) {
  const server = {
    type: "http",
    url: canonicalOrigin,
    headersHelper,
  };
  if (headers !== undefined) {
    server.headers = headers;
  }
  return {
    mcpServers: {
      parley: server,
    },
  };
}

async function makeArtifactFixture(mcp = claudeMcp(), helperSource = "process.stdout.write('{}\\n');\n") {
  const root = await mkdtemp(join(tmpdir(), "parley-claude-artifact-"));
  await writeJson(join(root, "package.json"), { version: "0.1.0" });
  await writeJson(join(root, "compatibility.json"), compatibility());
  await writeJson(join(root, "hosts", "claude", ".claude-plugin", "plugin.json"), claudeManifest());
  await writeJson(join(root, "hosts", "claude", ".mcp.json"), mcp);
  await writeJson(join(root, "hosts", "claude", "hooks", "hooks.json"), {
    hooks: {
      SessionStart: [{
        hooks: [{
          type: "command",
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/hooks/session-reminder.mjs"],
          timeout: 3,
        }],
      }],
    },
  });
  await mkdir(join(root, "hosts", "claude", "scripts"), { recursive: true });
  await writeFile(join(root, "hosts", "claude", "scripts", "space-headers.mjs"), helperSource);
  await writeJson(join(root, "hosts", "codex", ".codex-plugin", "plugin.json"), {
    name: "parley",
    version: "0.1.0",
    skills: "./skills/",
    interface: {},
    mcpServers: { parley: { type: "http", url: canonicalOrigin } },
  });
  await writeJson(join(root, "hosts", "gemini", "gemini-extension.json"), {
    name: "parley",
    version: "0.1.0",
    mcpServers: { parley: { httpUrl: canonicalOrigin } },
  });
  await mkdir(join(root, "shared", "skills", "parley"), { recursive: true });
  await writeFile(join(root, "shared", "skills", "parley", "SKILL.md"), "---\nname: parley\ndescription: fixture\n---\n");
  await mkdir(join(root, "shared", "commands"), { recursive: true });
  await writeFile(join(root, "shared", "commands", "connect.md"), "fixture\n");
  await mkdir(join(root, "shared", "hooks"), { recursive: true });
  await writeFile(join(root, "shared", "hooks", "session-reminder.mjs"), "process.exit(0);\n");
  await mkdir(join(root, "shared", "scripts"), { recursive: true });
  await writeFile(join(root, "shared", "scripts", "managed-config.mjs"), "export {};\n");
  return root;
}

async function withArtifactFixture(mcp, runFixture, helperSource) {
  const root = await makeArtifactFixture(mcp, helperSource);
  try {
    await runFixture(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function loadHelper() {
  return import(pathToFileURL(helperPath).href);
}

async function makeRepository(root, name, remote = null) {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await runGit(directory, "init", "--quiet");
  if (remote) {
    await runGit(directory, "remote", "add", remote.name, remote.url);
  }
  return directory;
}

test("Claude artifact is OAuth-only and has a SessionStart-only reminder", async () => {
  const manifest = JSON.parse(await readFile(join(claudeRoot, ".claude-plugin", "plugin.json"), "utf8"));
  const mcp = JSON.parse(await readFile(join(claudeRoot, ".mcp.json"), "utf8"));
  const hooks = JSON.parse(await readFile(join(claudeRoot, "hooks", "hooks.json"), "utf8"));

  assert.equal(Object.hasOwn(manifest, "userConfig"), false);
  assert.deepEqual(mcp, claudeMcp());
  assert.deepEqual(hooks, {
    hooks: {
      SessionStart: [{
        hooks: [{
          type: "command",
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/hooks/session-reminder.mjs"],
          timeout: 3,
        }],
      }],
    },
  });
  assert.equal(JSON.stringify(hooks).includes("UserPromptSubmit"), false);
});

test("Claude compatibility records the lower-capability explicit-space fallback without a plugin minimum", async () => {
  const compatibility = JSON.parse(await readFile(join(repositoryRoot, "compatibility.json"), "utf8"));
  const claude = compatibility.hosts.claude;

  assert.deepEqual(claude.testedVersions, ["2.1.193", "2.1.195", "2.1.237"]);
  assert.deepEqual(claude.authModes, ["oauth", "manual"]);
  assert.equal(claude.minimumSupport.minimumVersion, null);
  assert.match(claude.minimumSupport.certification, /2\.1\.193.*transport-only.*explicit-space.*2\.1\.195.*headersHelper.*2\.1\.237/i);
});

test("Claude README documents the lower-capability explicit-space recovery without guessing", async () => {
  const readme = await readFile(join(claudeRoot, "README.md"), "utf8");

  assert.match(readme, /SPACE_REQUIRED/i);
  assert.match(readme, /retry[\s\S]*explicit.*space/i);
  assert.match(readme, /later.*space-aware.*call/i);
  assert.match(readme, /ambiguous Git.*never retry/i);
});

test("Claude manual and OAuth command wrappers keep credentials out of arguments and history", async () => {
  const manualPowerShell = await readFile(join(claudeRoot, "scripts", "connect-manual.ps1"), "utf8");
  const manualShell = await readFile(join(claudeRoot, "scripts", "connect-manual.sh"), "utf8");
  const oauthPowerShell = await readFile(join(claudeRoot, "scripts", "connect-oauth.ps1"), "utf8");
  const oauthShell = await readFile(join(claudeRoot, "scripts", "connect-oauth.sh"), "utf8");

  assert.match(manualPowerShell, /Read-Host.+AsSecureString/i);
  assert.match(manualPowerShell, /RedirectStandardInput/i);
  assert.doesNotMatch(manualPowerShell, /-Token\b/i);
  assert.match(manualShell, /stty -echo/);
  assert.match(manualShell, /node "\$manager" claude manual/);
  assert.doesNotMatch(manualShell, /\$token[^\n]*node/i);
  assert.match(oauthPowerShell, /managed-config\.mjs/);
  assert.match(oauthShell, /node "\$script_dir\/managed-config\.mjs" claude oauth/);
});

test("Claude validator accepts only an OAuth-only bundled entry", async () => {
  await withArtifactFixture(claudeMcp(), async (root) => {
    const outputDir = join(root, "dist");
    await buildArtifacts({ version: "0.1.0", sourceDir: root, outputDir });
    await assert.doesNotReject(validateArtifacts({ root, outputDir }));
  });

});

test("validator rejects an artifact whose shared manual configuration manager drifts from source", async () => {
  await withArtifactFixture(claudeMcp(), async (root) => {
    const outputDir = join(root, "dist");
    await buildArtifacts({ version: "0.1.0", sourceDir: root, outputDir });
    await writeFile(join(root, "shared", "scripts", "managed-config.mjs"), "export const drift = true;\n");
    await assert.rejects(
      validateArtifacts({ root, outputDir }),
      /shared manual configuration manager/i,
    );
  });
});

test("Claude validator rejects every bundled Authorization source", async (context) => {
  const cases = [
    ["literal", claudeMcp({ headers: { Authorization: "Bearer aaaaaaaaaaaaaaaaaaaa" } })],
    ["case-insensitive second authorization", claudeMcp({
      headers: { Authorization: "Bearer one", authorization: "Bearer alternative" },
    })],
    ["proxy authorization", claudeMcp({
      headers: { "Proxy-Authorization": "Bearer alternative" },
    })],
    ["helper", claudeMcp({ headersHelper: "echo '{\"Authorization\":\"Bearer forbidden\"}'" })],
    ["helper output", claudeMcp(), "process.stdout.write('{\"Authorization\":\"Bearer alternate\"}');\n"],
  ];

  for (const [name, mcp, helperSource] of cases) {
    await context.test(name, async () => {
      await withArtifactFixture(mcp, async (root) => {
        const outputDir = join(root, "dist");
        await buildArtifacts({ version: "0.1.0", sourceDir: root, outputDir });
        await assert.rejects(validateArtifacts({ root, outputDir }), /headersHelper|Authorization|auth/i);
      }, helperSource);
    });
  }
});

test("Claude helper selects dual-mode roots and emits only proven spaces", async () => {
  const { selectProjectRoot, spaceHeaders } = await loadHelper();
  const root = await mkdtemp(join(tmpdir(), "parley-claude-helper-"));
  try {
    const origin = "https://github.com/weldra-ai/parley.git";
    const originRepo = await makeRepository(root, "origin", { name: "origin", url: origin });
    const noRemoteRepo = await makeRepository(root, "no-remote");
    const nonOriginRepo = await makeRepository(root, "non-origin", { name: "upstream", url: origin });
    const originAndUpstreamRepo = await makeRepository(root, "origin-and-upstream", { name: "origin", url: origin });
    await runGit(originAndUpstreamRepo, "remote", "add", "upstream", "ssh://git@example.invalid/upstream.git");
    const ambiguousOriginRepo = await makeRepository(root, "ambiguous", { name: "origin", url: origin });
    await runGit(ambiguousOriginRepo, "config", "--add", "remote.origin.url", "ssh://example.invalid/second.git");
    const nonRepository = join(root, "not-a-repository");
    await mkdir(nonRepository);

    assert.equal(selectProjectRoot(originRepo, root, helperPath), await realpath(originRepo));
    assert.equal(
      selectProjectRoot("${CLAUDE_PROJECT_DIR}", originRepo, helperPath),
      await realpath(originRepo),
    );
    assert.equal(selectProjectRoot("${CLAUDE_PROJECT_DIR}", claudeRoot, helperPath), null);
    assert.equal(selectProjectRoot("./relative", root, helperPath), null);

    assert.deepEqual(await spaceHeaders(originRepo), { "X-Space": origin });
    assert.deepEqual(await spaceHeaders(noRemoteRepo), { "X-Space": "main" });
    assert.deepEqual(await spaceHeaders(nonOriginRepo), {});
    assert.deepEqual(await spaceHeaders(originAndUpstreamRepo), { "X-Space": origin });
    assert.deepEqual(await spaceHeaders(ambiguousOriginRepo), {});
    assert.deepEqual(await spaceHeaders(nonRepository), {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude helper rejects duplicate and malformed remote-name output", async () => {
  const { spaceHeaders } = await loadHelper();
  const responsesFor = (remoteOutput) => [
    { code: 0, stdout: Buffer.from("true\n") },
    { code: 0, stdout: Buffer.from(remoteOutput) },
  ];
  for (const [name, remoteOutput] of [
    ["duplicate", "origin\norigin\n"],
    ["malformed", "origin remote\n"],
  ]) {
    const responses = responsesFor(remoteOutput);
    const headers = await spaceHeaders("fixture", {
      runGit: async () => responses.shift(),
    });
    assert.deepEqual(headers, {}, name);
  }
});

test("Claude helper fails closed for missing Git and emits parseable escaped JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "parley-claude-helper-process-"));
  try {
    const escapedRemote = "ssh://git@example.invalid/a\"quoted\"-repo.git";
    const repo = await makeRepository(root, "repository", { name: "origin", url: escapedRemote });
    const normal = await run(process.execPath, [helperPath, repo], { cwd: claudeRoot });
    assert.equal(normal.code, 0, normal.stderr.toString("utf8"));
    assert.deepEqual(JSON.parse(normal.stdout.toString("utf8")), { "X-Space": escapedRemote });

    const noGitEnvironment = { ...process.env, PATH: "", Path: "" };
    const missingGit = await run(process.execPath, [helperPath, repo], {
      cwd: repo,
      environment: noGitEnvironment,
    });
    assert.equal(missingGit.code, 0, missingGit.stderr.toString("utf8"));
    assert.deepEqual(JSON.parse(missingGit.stdout.toString("utf8")), {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude helper fails closed on malformed Git output, command failure, and one aggregate deadline", async () => {
  const { runLocalGit, spaceHeaders } = await loadHelper();
  const malformed = await spaceHeaders("fixture", {
    runGit: async () => ({ code: 0, stdout: Buffer.from([0xff]) }),
  });
  assert.deepEqual(malformed, {});

  const failed = await spaceHeaders("fixture", {
    runGit: async () => ({ code: 1, stdout: Buffer.alloc(0) }),
  });
  assert.deepEqual(failed, {});

  const started = performance.now();
  const timedOut = await spaceHeaders("fixture", {
    deadlineMs: 25,
    runGit: async () => new Promise(() => {}),
  });
  assert.deepEqual(timedOut, {});
  assert.ok(performance.now() - started < 250, "the aggregate deadline must bound a stalled command");

  const root = await mkdtemp(join(tmpdir(), "parley-claude-helper-reap-"));
  try {
    const hangingGit = join(root, "hanging-git.mjs");
    await writeFile(hangingGit, "setInterval(() => {}, 1_000);\n");
    const spawnedStarted = performance.now();
    const spawnedTimedOut = await spaceHeaders(root, {
      deadlineMs: 150,
      runGit: (cwd, args, timeoutMs) => runLocalGit(cwd, args, timeoutMs, {
        command: process.execPath,
        commandArguments: [hangingGit],
      }),
    });
    assert.deepEqual(spawnedTimedOut, {});
    assert.ok(performance.now() - spawnedStarted < 500, "a killed Git child must not keep the helper alive");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude helper runs only the local Git decision table and never shells a main fallback", async () => {
  const { spaceHeaders } = await loadHelper();
  const calls = [];
  const responses = [
    { code: 0, stdout: Buffer.from("true\n") },
    { code: 0, stdout: Buffer.from("origin\n") },
    { code: 0, stdout: Buffer.from("ssh://git@example.invalid/repo.git\n") },
  ];
  const headers = await spaceHeaders("fixture", {
    runGit: async (cwd, args, timeoutMs) => {
      calls.push({ cwd, args, timeoutMs });
      return responses.shift();
    },
  });
  assert.deepEqual(headers, { "X-Space": "ssh://git@example.invalid/repo.git" });
  assert.deepEqual(calls.map(({ cwd, args }) => [cwd, args]), [
    ["fixture", ["rev-parse", "--is-inside-work-tree"]],
    ["fixture", ["remote"]],
    ["fixture", ["config", "--get-all", "remote.origin.url"]],
  ]);
  for (const { timeoutMs } of calls) {
    assert.ok(timeoutMs > 0 && timeoutMs <= 8000);
  }

  const helperSource = await readFile(helperPath, "utf8");
  assert.doesNotMatch(helperSource, /\|\|\s*echo\s+main/i);
});
