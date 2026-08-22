#!/usr/bin/env node
/**
 * Create unsigned, local-only native-artifact evidence for a later release report.
 *
 * This command snapshots the exact default build artifacts before it validates,
 * scans, and hashes them. It never starts a host profile, OAuth flow, remote
 * connection, deployment, signature, publication, or beta test.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOSTS } from "./build.mjs";
import { runNativeValidators } from "./native-validate.mjs";
import { scanForSecrets } from "./scan-secrets.mjs";
import { validateArtifacts } from "./validate.mjs";

const GIT_SHA = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const OPTION_NAMES = new Set(["--backend-sha", "--plugin-tag", "--output"]);

function projectRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!OPTION_NAMES.has(argument)) {
      throw new Error("unsupported argument");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || Object.hasOwn(options, argument)) {
      throw new Error("invalid command arguments");
    }
    options[argument] = value;
    index += 1;
  }
  for (const name of ["--backend-sha", "--plugin-tag", "--output"]) {
    if (!Object.hasOwn(options, name)) {
      throw new Error("missing required command argument");
    }
  }
  return options;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sourceVersion(root) {
  let packageJson;
  try {
    packageJson = JSON.parse((await readFile(join(root, "package.json"))).toString("utf8"));
  } catch {
    throw new Error("source package version is unavailable");
  }
  if (typeof packageJson.version !== "string" || !VERSION.test(packageJson.version)) {
    throw new Error("source package version is invalid");
  }
  return packageJson.version;
}

async function copyArtifactPath(source, destination) {
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) {
    throw new Error("artifact snapshot refused a symbolic link");
  }
  if (stat.isFile()) {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(source));
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error("artifact snapshot found an unsupported input type");
  }
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    await copyArtifactPath(join(source, entry.name), join(destination, entry.name));
  }
}

async function treeDigest(root, relativePath = "") {
  const stat = await lstat(root);
  if (stat.isSymbolicLink()) {
    throw new Error("artifact snapshot changed during certification");
  }
  if (stat.isFile()) {
    return [[relativePath, sha256(await readFile(root))]];
  }
  if (!stat.isDirectory()) {
    throw new Error("artifact snapshot changed during certification");
  }
  const result = [[`${relativePath}/`, "directory"]];
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    result.push(...await treeDigest(join(root, entry.name), childRelativePath));
  }
  return result;
}

async function artifactTreeDigest(outputDir, version) {
  const entries = [];
  for (const host of [...HOSTS].sort()) {
    const archiveName = `parley-${host}-${version}.zip`;
    for (const filename of [archiveName, `${archiveName}.sha256`]) {
      const path = join(outputDir, filename);
      entries.push([filename, sha256(await readFile(path))]);
    }
    entries.push(...await treeDigest(join(outputDir, host), `${host}`));
  }
  return JSON.stringify(entries);
}

async function artifactInventory(outputDir, version) {
  const artifacts = [];
  for (const host of [...HOSTS].sort()) {
    const filename = `parley-${host}-${version}.zip`;
    artifacts.push({ host, sha256: sha256(await readFile(join(outputDir, filename))) });
  }
  return artifacts;
}

export async function snapshotArtifactDirectory({ artifactDir, version }) {
  const outputDir = await mkdtemp(join(tmpdir(), "parley-artifact-snapshot-"));
  try {
    for (const host of [...HOSTS].sort()) {
      const archiveName = `parley-${host}-${version}.zip`;
      await copyArtifactPath(join(artifactDir, archiveName), join(outputDir, archiveName));
      await copyArtifactPath(join(artifactDir, `${archiveName}.sha256`), join(outputDir, `${archiveName}.sha256`));
      await copyArtifactPath(join(artifactDir, host), join(outputDir, host));
    }
    const digest = await artifactTreeDigest(outputDir, version);
    const artifacts = await artifactInventory(outputDir, version);
    return {
      outputDir,
      artifacts,
      async assertUnchanged() {
        if (await artifactTreeDigest(outputDir, version) !== digest) {
          throw new Error("artifact snapshot changed during certification");
        }
      },
      async cleanup() {
        await rm(outputDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

export async function createLocalArtifactInventory({ backendSha, pluginTag, outputPath, root = projectRoot() }) {
  if (GIT_SHA.test(backendSha) === false) {
    throw new Error("backend SHA is invalid");
  }
  const version = await sourceVersion(root);
  if (pluginTag !== `v${version}`) {
    throw new Error("plugin tag does not match the source version");
  }
  const snapshot = await snapshotArtifactDirectory({ artifactDir: join(root, "dist"), version });
  try {
    await snapshot.assertUnchanged();
    const validation = await validateArtifacts({ root, outputDir: snapshot.outputDir });
    if (validation.version !== version) {
      throw new Error("artifact version does not match the source version");
    }
    await snapshot.assertUnchanged();
    await scanForSecrets({ root: snapshot.outputDir });
    await snapshot.assertUnchanged();
    await runNativeValidators({ root, outputDir: snapshot.outputDir });
    await snapshot.assertUnchanged();

    const inventory = {
      schema_version: 1,
      report_kind: "local_artifact_inventory",
      signed: false,
      backend_git_sha: backendSha,
      plugin: {
        tag: pluginTag,
        version,
        artifacts: snapshot.artifacts,
      },
      local_artifact_gates: {
        plugin_validate: true,
        plugin_secret_scan: true,
        native_validators: true,
      },
    };
    await writeFile(outputPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
    return inventory;
  } finally {
    await snapshot.cleanup();
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    await createLocalArtifactInventory({
      backendSha: options["--backend-sha"],
      pluginTag: options["--plugin-tag"],
      outputPath: resolve(options["--output"]),
    });
    console.log("Wrote unsigned local artifact inventory.");
  } catch {
    console.error("Local host inventory failed; check local artifact gates and arguments.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
