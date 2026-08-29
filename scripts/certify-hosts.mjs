#!/usr/bin/env node
/**
 * Create unsigned, local-only native-artifact evidence for a later release report.
 *
 * This command snapshots the exact default build artifacts before it validates,
 * scans, and hashes them. It never starts a host profile, OAuth flow, remote
 * connection, deployment, signature, publication, or beta test.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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

const SOURCE_CHANGED = "source artifact tree changed during snapshot";
const SNAPSHOT_CHANGED = "artifact snapshot changed during certification";

function sameIdentity(left, right) {
  // Windows reports dev=0 for path lstat but a volume id for FileHandle.stat.
  // An unknown path device must not obscure the stable inode/type/timestamp checks.
  return (left.dev === 0 || right.dev === 0 || left.dev === right.dev)
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.isFile() === right.isFile()
    && left.isDirectory() === right.isDirectory()
    && left.isSymbolicLink() === right.isSymbolicLink();
}

function identityRecord(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs];
}

async function safeLstat(path, failure) {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new Error(failure);
  }
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error(failure);
  }
  return stat;
}

async function stableReadFile(source, { failure, beforeRead } = {}) {
  const before = await safeLstat(source, failure);
  if (!before.isFile()) {
    throw new Error(failure);
  }
  if (beforeRead) {
    await beforeRead(source);
  }
  let handle;
  try {
    handle = await open(source, "r");
    const opened = await handle.stat();
    if (!sameIdentity(before, opened)) {
      throw new Error(failure);
    }
    const bytes = await handle.readFile();
    const after = await safeLstat(source, failure);
    const handleAfter = await handle.stat();
    if (!sameIdentity(before, after) || !sameIdentity(opened, handleAfter)) {
      throw new Error(failure);
    }
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message === failure) {
      throw error;
    }
    throw new Error(failure);
  } finally {
    await handle?.close();
  }
}

async function stableTreeDigest(root, relativePath = "", { failure, beforeRead } = {}) {
  const before = await safeLstat(root, failure);
  if (before.isFile()) {
    const bytes = await stableReadFile(root, { failure, beforeRead });
    return [[relativePath, sha256(bytes), identityRecord(before)]];
  }
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const afterListing = await safeLstat(root, failure);
  if (!sameIdentity(before, afterListing)) {
    throw new Error(failure);
  }
  const result = [[`${relativePath}/`, "directory", identityRecord(before)]];
  for (const entry of entries) {
    const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    result.push(...await stableTreeDigest(join(root, entry.name), childRelativePath, { failure, beforeRead }));
  }
  const afterChildren = await safeLstat(root, failure);
  if (!sameIdentity(before, afterChildren)) {
    throw new Error(failure);
  }
  return result;
}

async function copyArtifactPath(source, destination, { beforeRead } = {}) {
  const stat = await safeLstat(source, SOURCE_CHANGED);
  if (stat.isFile()) {
    const bytes = await stableReadFile(source, { failure: SOURCE_CHANGED, beforeRead });
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    return;
  }
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const afterListing = await safeLstat(source, SOURCE_CHANGED);
  if (!sameIdentity(stat, afterListing)) {
    throw new Error(SOURCE_CHANGED);
  }
  for (const entry of entries) {
    await copyArtifactPath(join(source, entry.name), join(destination, entry.name), { beforeRead });
  }
  const afterChildren = await safeLstat(source, SOURCE_CHANGED);
  if (!sameIdentity(stat, afterChildren)) {
    throw new Error(SOURCE_CHANGED);
  }
}

async function assertArtifactRoot(artifactDir) {
  const resolved = resolve(artifactDir);
  let stat;
  let canonical;
  try {
    stat = await lstat(resolved);
    canonical = await realpath(resolved);
  } catch {
    throw new Error("artifact snapshot refused an invalid artifact root");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("artifact snapshot refused a symbolic link artifact root");
  }
  if (canonical !== resolved) {
    throw new Error("artifact snapshot refused a realpath-divergent artifact root");
  }
  return { resolved, canonical, stat };
}

async function artifactInventory(outputDir, version) {
  const artifacts = [];
  for (const host of [...HOSTS].sort()) {
    const filename = `parley-${host}-${version}.zip`;
    artifacts.push({
      host,
      sha256: sha256(await stableReadFile(join(outputDir, filename), { failure: SNAPSHOT_CHANGED })),
    });
  }
  return artifacts;
}

export async function snapshotArtifactDirectory({ artifactDir, version, beforeRead, afterCopy }) {
  const outputDir = await mkdtemp(join(tmpdir(), "parley-artifact-snapshot-"));
  try {
    const sourceRoot = await assertArtifactRoot(artifactDir);
    const sourceDigest = JSON.stringify(await stableTreeDigest(sourceRoot.resolved, "", { failure: SOURCE_CHANGED }));
    await copyArtifactPath(sourceRoot.resolved, outputDir, { beforeRead });
    if (afterCopy) {
      await afterCopy();
    }
    const sourceAfterCopy = await assertArtifactRoot(artifactDir);
    if (sourceAfterCopy.canonical !== sourceRoot.canonical || !sameIdentity(sourceRoot.stat, sourceAfterCopy.stat)) {
      throw new Error(SOURCE_CHANGED);
    }
    if (JSON.stringify(await stableTreeDigest(sourceRoot.resolved, "", { failure: SOURCE_CHANGED })) !== sourceDigest) {
      throw new Error(SOURCE_CHANGED);
    }
    const digest = JSON.stringify(await stableTreeDigest(outputDir, "", { failure: SNAPSHOT_CHANGED }));
    return {
      outputDir,
      async assertUnchanged() {
        if (JSON.stringify(await stableTreeDigest(outputDir, "", { failure: SNAPSHOT_CHANGED })) !== digest) {
          throw new Error(SNAPSHOT_CHANGED);
        }
      },
      async finalArtifactInventory() {
        await this.assertUnchanged();
        const artifacts = await artifactInventory(outputDir, version);
        await this.assertUnchanged();
        return artifacts;
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
    const artifacts = await snapshot.finalArtifactInventory();

    const inventory = {
      schema_version: 1,
      report_kind: "local_artifact_inventory",
      signed: false,
      backend_git_sha: backendSha,
      plugin: {
        tag: pluginTag,
        version,
        artifacts,
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
