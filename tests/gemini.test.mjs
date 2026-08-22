import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildArtifacts } from "../scripts/build.mjs";
import { validateArtifacts } from "../scripts/validate.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const geminiRoot = join(repositoryRoot, "hosts", "gemini");
const canonicalOrigin = "https://parley.weldra.dev/mcp";
const geminiBinary = join(repositoryRoot, "node_modules", "@google", "gemini-cli", "bundle", "gemini.js");
const authorizationHeader = ["Author", "ization"].join("").toLowerCase();

function runtimeSentinel() {
  return ["p", "n"].join("") + "_" + "SENTINEL_NOT_FOR_LOGS";
}

function run(command, args, { environment = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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
    child.once("close", (code) => resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  });
}

async function fixtureWithGeminiManifest(manifest, runFixture) {
  const root = await mkdtemp(join(tmpdir(), "parley-gemini-validator-"));
  try {
    for (const name of ["package.json", "compatibility.json"]) {
      await cp(join(repositoryRoot, name), join(root, name));
    }
    await cp(join(repositoryRoot, "hosts"), join(root, "hosts"), { recursive: true });
    await cp(join(repositoryRoot, "shared"), join(root, "shared"), { recursive: true });
    await writeFile(join(root, "hosts", "gemini", "gemini-extension.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await runFixture(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withCaptureServer(runCapture) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, [authorizationHeader]: request.headers[authorizationHeader] });
    response.statusCode = 401;
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    await runCapture({ baseUrl: `http://127.0.0.1:${port}/mcp`, requests });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function capturePinnedGeminiHeader(baseUrl) {
  const root = await mkdtemp(join(tmpdir(), "parley-gemini-capture-"));
  const transportChunk = join(repositoryRoot, "node_modules", "@google", "gemini-cli", "bundle", "chunk-MYCBWRZE.js");
  const resolverChunk = join(repositoryRoot, "node_modules", "@google", "gemini-cli", "bundle", "chunk-C5FHWCAU.js");
  const transportUrl = pathToFileURL(transportChunk).href;
  const resolverUrl = pathToFileURL(resolverChunk).href;
  const loaderPath = join(root, "loader.mjs");
  const driverPath = join(root, "driver.mjs");
  try {
    await writeFile(loaderPath, [
      `const target = ${JSON.stringify(transportUrl)};`,
      "export async function load(url, context, nextLoad) {",
      "  const loaded = await nextLoad(url, context);",
      "  if (url !== target) return loaded;",
      "  return { ...loaded, source: `${loaded.source}\\nexport { connectToMcpServer };\\n`, shortCircuit: true };",
      "}",
      "",
    ].join("\n"));
    await writeFile(driverPath, [
      "import { readFile } from 'node:fs/promises';",
      `import { connectToMcpServer } from ${JSON.stringify(transportUrl)};`,
      `import { resolveEnvVarsInObject } from ${JSON.stringify(resolverUrl)};`,
      "const manifest = JSON.parse(await readFile(process.env.PARLEY_TEST_MANIFEST, 'utf8'));",
      "const token = ['p', 'n'].join('') + '_' + 'SENTINEL_NOT_FOR_LOGS';",
      "const resolved = resolveEnvVarsInObject(manifest, { PARLEY_TOKEN: token });",
      "const server = resolved.mcpServers.parley;",
      "server.httpUrl = process.env.PARLEY_TEST_URL;",
      "try {",
      "  await connectToMcpServer('0.56.0', 'parley-loopback-capture', server, false, {",
      "    getDirectories: () => [],",
      "    onDirectoriesChanged: () => () => {},",
      "  }, { sanitizationConfig: {}, emitMcpDiagnostic: () => {} });",
      "} catch {",
      "  // The loopback endpoint deliberately has no OAuth metadata; the request capture is the assertion.",
      "}",
      "",
    ].join("\n"));
    const profile = join(root, "profile");
    const result = await run(process.execPath, [
      "--experimental-loader",
      pathToFileURL(loaderPath).href,
      driverPath,
    ], {
      environment: {
        ...process.env,
        GEMINI_CLI_HOME: profile,
        GEMINI_CLI_NO_RELAUNCH: "1",
        CI: "1",
        NO_COLOR: "1",
        PARLEY_TEST_MANIFEST: join(geminiRoot, "gemini-extension.json"),
        PARLEY_TEST_URL: baseUrl,
      },
    });
    assert.equal(result.code, 0, result.stderr.toString("utf8"));
    const output = `${result.stdout}${result.stderr}`;
    assert.doesNotMatch(output, new RegExp(runtimeSentinel()));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Gemini 0.56.0 declares one OAuth-enabled server and its one sensitive manual setting", async () => {
  const manifest = JSON.parse(await readFile(join(geminiRoot, "gemini-extension.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.mcpServers), ["parley"]);
  assert.deepEqual(manifest.settings, [{
    name: "Parley token",
    description: "Recovery-only manual Parley token.",
    envVar: "PARLEY_TOKEN",
    sensitive: true,
  }]);
  assert.deepEqual(manifest.mcpServers.parley, {
    httpUrl: canonicalOrigin,
    headers: { Authorization: "Bearer ${PARLEY_TOKEN}" },
    oauth: { enabled: true },
  });
});

test("pinned Gemini expands the sensitive setting into the live loopback Authorization header only", async () => {
  const token = runtimeSentinel();
  await withCaptureServer(async ({ baseUrl, requests }) => {
    await capturePinnedGeminiHeader(baseUrl);
    assert.equal(requests[0]?.[authorizationHeader], `Bearer ${token}`);
  });
  const manifest = await readFile(join(geminiRoot, "gemini-extension.json"), "utf8");
  assert.doesNotMatch(manifest, new RegExp(token));
});

test("Gemini manual wrapper delegates only to the native interactive sensitive-setting UI", async () => {
  const powershell = await readFile(join(geminiRoot, "scripts", "connect-manual.ps1"), "utf8");
  const shell = await readFile(join(geminiRoot, "scripts", "connect-manual.sh"), "utf8");
  const readme = await readFile(join(geminiRoot, "README.md"), "utf8");

  for (const source of [powershell, shell]) {
    assert.match(source, /gemini extensions config parley PARLEY_TOKEN --scope user/);
    assert.doesNotMatch(source, /Read-Host|stty|StandardInput|PARLEY_TOKEN\s*=/i);
  }
  assert.match(readme, /valid stored OAuth.*override.*manual/i);
  assert.match(readme, /does not.*switch away/i);
  assert.match(readme, /no.*credential-clear|no.*logout/i);
  assert.match(readme, /quiet session-start/i);
  assert.doesNotMatch(readme, /parley-manual/i);
});

test("validator allows only the declared Gemini sensitive placeholder and fails closed otherwise", async () => {
  const manifest = {
    name: "parley",
    version: "0.1.0",
    description: "Parley coordination for coding agents.",
    settings: [{
      name: "Parley token",
      description: "Recovery-only manual Parley token.",
      envVar: "PARLEY_TOKEN",
      sensitive: true,
    }],
    mcpServers: {
      parley: {
        httpUrl: canonicalOrigin,
        headers: { Authorization: "Bearer ${PARLEY_TOKEN}" },
        oauth: { enabled: true },
      },
    },
  };
  await fixtureWithGeminiManifest(manifest, async (root) => {
    const outputDir = join(root, "dist");
    await buildArtifacts({ version: "0.1.0", sourceDir: root, outputDir });
    await assert.doesNotReject(validateArtifacts({ root, outputDir }));

    manifest.settings = [];
    await writeFile(join(root, "hosts", "gemini", "gemini-extension.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await buildArtifacts({ version: "0.1.0", sourceDir: root, outputDir });
    await assert.rejects(validateArtifacts({ root, outputDir }), /sensitive.*PARLEY_TOKEN|placeholder/i);
  });
});

test("pinned Gemini validates the OAuth-plus-manual extension without persisting a manual token", async () => {
  const profile = await mkdtemp(join(tmpdir(), "parley-gemini-clean-profile-"));
  try {
    const result = await run(process.execPath, [geminiBinary, "extensions", "validate", geminiRoot], {
      environment: {
        ...process.env,
        GEMINI_CLI_HOME: profile,
        GEMINI_CLI_NO_RELAUNCH: "1",
        CI: "1",
        NO_COLOR: "1",
      },
    });
    assert.equal(result.code, 0, result.stderr.toString("utf8"));
    const output = `${result.stdout}${result.stderr}`;
    assert.doesNotMatch(output, new RegExp(runtimeSentinel()));
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
