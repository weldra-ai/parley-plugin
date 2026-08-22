import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import { buildArtifacts } from "../scripts/build.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, shell: false, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("local host inventory binds only build artifacts and is explicitly unsigned", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "parley-local-host-evidence-"));
  const output = join(outputRoot, "inventory.json");
  const artifactDir = join(outputRoot, "artifacts");
  try {
    await buildArtifacts({ version: "0.1.0", sourceDir: repositoryRoot, outputDir: artifactDir });
    const result = await run(process.execPath, [
      "scripts/certify-hosts.mjs",
      "--backend-sha", "a".repeat(40),
      "--plugin-tag", "v0.1.0",
      "--output", output,
      "--artifact-dir", artifactDir,
    ]);
    assert.equal(result.code, 0, result.stderr);
    const inventory = JSON.parse(await readFile(output, "utf8"));
    assert.equal(inventory.schema_version, 1);
    assert.equal(inventory.report_kind, "local_artifact_inventory");
    assert.equal(inventory.signed, false);
    assert.deepEqual(inventory.plugin.artifacts.map((artifact) => artifact.host), ["claude", "codex", "gemini"]);
    assert.ok(inventory.plugin.artifacts.every((artifact) => /^[0-9a-f]{64}$/.test(artifact.sha256)));
    assert.deepEqual(inventory.local_artifact_gates, {
      plugin_validate: true,
      plugin_secret_scan: true,
      native_validators: true,
    });
    assert.equal(Object.hasOwn(inventory, "host_certified"), false);
    assert.equal(Object.hasOwn(inventory, "stage"), false);
    assert.equal(Object.hasOwn(inventory, "production"), false);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
