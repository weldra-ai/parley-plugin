import assert from "node:assert/strict";
import { access, cp, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import { buildArtifacts } from "../scripts/build.mjs";
import { createLocalArtifactInventory } from "../scripts/certify-hosts.mjs";
import { validateArtifacts } from "../scripts/validate.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const tokenSuffix = "K7nQg4sL2pV8xR5dZ1hM9cT6wB3yF0a";

async function canonicalTemporaryDirectory(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

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

async function sourceFixture() {
  const root = await canonicalTemporaryDirectory("parley-certify-source-");
  await Promise.all([
    cp(join(repositoryRoot, "package.json"), join(root, "package.json")),
    cp(join(repositoryRoot, "compatibility.json"), join(root, "compatibility.json")),
    cp(join(repositoryRoot, "hosts"), join(root, "hosts"), { recursive: true }),
    cp(join(repositoryRoot, "shared"), join(root, "shared"), { recursive: true }),
  ]);
  return root;
}

test("local host inventory binds only build artifacts and is explicitly unsigned", async () => {
  const outputRoot = await canonicalTemporaryDirectory("parley-local-host-evidence-");
  const output = join(outputRoot, "inventory.json");
  try {
    await buildArtifacts({ version: "0.1.0", sourceDir: repositoryRoot, outputDir: join(repositoryRoot, "dist") });
    const result = await run(process.execPath, [
      "scripts/certify-hosts.mjs",
      "--backend-sha", "a".repeat(40),
      "--plugin-tag", "v0.1.0",
      "--output", output,
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

test("collector refuses an external secret-bearing artifact directory without producing an inventory", async () => {
  const outputRoot = await canonicalTemporaryDirectory("parley-external-artifact-injection-");
  const output = join(outputRoot, "inventory.json");
  const externalArtifacts = join(outputRoot, "external-artifacts");
  try {
    await buildArtifacts({ version: "0.1.0", sourceDir: repositoryRoot, outputDir: externalArtifacts });
    await writeFile(join(externalArtifacts, "injected-secret.txt"), `pn_${tokenSuffix}`);
    const result = await run(process.execPath, [
      "scripts/certify-hosts.mjs",
      "--backend-sha", "a".repeat(40),
      "--plugin-tag", "v0.1.0",
      "--output", output,
      "--artifact-dir", externalArtifacts,
    ]);
    assert.notEqual(result.code, 0);
    await assert.rejects(access(output));
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("collector secret scan covers built artifact bytes after source cleanup", async () => {
  const root = await sourceFixture();
  try {
    const secretPath = join(root, "hosts", "codex", "capture.log");
    await writeFile(secretPath, `pn_${tokenSuffix}`);
    await buildArtifacts({ version: "0.1.0", sourceDir: root, outputDir: join(root, "dist") });
    await rm(secretPath);
    await assert.rejects(
      createLocalArtifactInventory({
        backendSha: "a".repeat(40),
        pluginTag: "v0.1.0",
        outputPath: join(root, "inventory.json"),
        root,
      }),
      /credential/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact snapshot rejects a post-validation replacement", async () => {
  const { snapshotArtifactDirectory } = await import("../scripts/certify-hosts.mjs");
  assert.equal(typeof snapshotArtifactDirectory, "function");
  const outputRoot = await canonicalTemporaryDirectory("parley-snapshot-replacement-");
  const artifactDir = join(outputRoot, "artifacts");
  try {
    await buildArtifacts({ version: "0.1.0", sourceDir: repositoryRoot, outputDir: artifactDir });
    const snapshot = await snapshotArtifactDirectory({ artifactDir, version: "0.1.0" });
    try {
      await validateArtifacts({ root: repositoryRoot, outputDir: snapshot.outputDir });
      await writeFile(join(snapshot.outputDir, "codex", "skills", "parley", "SKILL.md"), "replacement");
      await assert.rejects(snapshot.assertUnchanged(), /snapshot changed during certification/i);
    } finally {
      await snapshot.cleanup();
    }
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("artifact snapshot rejects a symlinked or realpath-divergent dist root", async (context) => {
  const { snapshotArtifactDirectory } = await import("../scripts/certify-hosts.mjs");
  const outputRoot = await canonicalTemporaryDirectory("parley-snapshot-root-link-");
  const artifactDir = join(outputRoot, "artifacts");
  const linkedArtifactDir = join(outputRoot, "linked-artifacts");
  try {
    await buildArtifacts({ version: "0.1.0", sourceDir: repositoryRoot, outputDir: artifactDir });
    try {
      await symlink(artifactDir, linkedArtifactDir, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EACCES", "EPERM", "UNKNOWN"].includes(error?.code)) {
        context.skip("the platform does not permit a test artifact directory link");
        return;
      }
      throw error;
    }
    await assert.rejects(
      snapshotArtifactDirectory({ artifactDir: linkedArtifactDir, version: "0.1.0" }),
      /symbolic link|realpath/i,
    );
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("artifact snapshot detects a deterministic source replacement during copy", async () => {
  const { snapshotArtifactDirectory } = await import("../scripts/certify-hosts.mjs");
  const outputRoot = await canonicalTemporaryDirectory("parley-snapshot-source-replacement-");
  const artifactDir = join(outputRoot, "artifacts");
  const archive = join(artifactDir, "parley-codex-0.1.0.zip");
  let replaced = false;
  try {
    await buildArtifacts({ version: "0.1.0", sourceDir: repositoryRoot, outputDir: artifactDir });
    await assert.rejects(
      snapshotArtifactDirectory({
        artifactDir,
        version: "0.1.0",
        beforeRead: async (source) => {
          if (source === archive && !replaced) {
            replaced = true;
            await rename(source, `${source}.original`);
            await writeFile(source, "replacement artifact bytes");
          }
        },
      }),
      /source artifact tree changed|source file changed/i,
    );
    assert.equal(replaced, true);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("artifact snapshot detects a source-tree replacement after artifact copy", async () => {
  const { snapshotArtifactDirectory } = await import("../scripts/certify-hosts.mjs");
  const outputRoot = await canonicalTemporaryDirectory("parley-snapshot-post-copy-replacement-");
  const artifactDir = join(outputRoot, "artifacts");
  const archive = join(artifactDir, "parley-claude-0.1.0.zip");
  let replaced = false;
  try {
    await buildArtifacts({ version: "0.1.0", sourceDir: repositoryRoot, outputDir: artifactDir });
    await assert.rejects(
      snapshotArtifactDirectory({
        artifactDir,
        version: "0.1.0",
        afterCopy: async () => {
          replaced = true;
          await rename(archive, `${archive}.original`);
          await writeFile(archive, "replacement after copy");
        },
      }),
      /source artifact tree changed/i,
    );
    assert.equal(replaced, true);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("artifact snapshot rejects a source-child symlink swap during copy when permitted", async (context) => {
  const { snapshotArtifactDirectory } = await import("../scripts/certify-hosts.mjs");
  const outputRoot = await canonicalTemporaryDirectory("parley-snapshot-child-link-");
  const artifactDir = join(outputRoot, "artifacts");
  const archive = join(artifactDir, "parley-gemini-0.1.0.zip");
  const replacement = join(artifactDir, "replacement.zip");
  let swapped = false;
  try {
    await buildArtifacts({ version: "0.1.0", sourceDir: repositoryRoot, outputDir: artifactDir });
    await writeFile(replacement, "replacement artifact bytes");
    try {
      await assert.rejects(
        snapshotArtifactDirectory({
          artifactDir,
          version: "0.1.0",
          beforeRead: async (source) => {
            if (source === archive && !swapped) {
              swapped = true;
              await rm(source);
              await symlink(replacement, source, "file");
            }
          },
        }),
        /source artifact tree changed|symbolic link|source file changed/i,
      );
    } catch (error) {
      if (["EACCES", "EPERM", "UNKNOWN"].includes(error?.code)) {
        context.skip("the platform does not permit a test file link");
        return;
      }
      throw error;
    }
    assert.equal(swapped, true);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
