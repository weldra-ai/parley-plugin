import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename as renameFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HOSTS = ["codex", "claude", "gemini"];
export const SHARED_PATHS = ["skills/parley"];

const ZIP_EPOCH = 315532800;
const REQUIRED_MANIFESTS = {
  codex: ".codex-plugin/plugin.json",
  claude: ".claude-plugin/plugin.json",
  gemini: "gemini-extension.json",
};

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) {
      current = (current >>> 1) ^ (current & 1 ? 0xedb88320 : 0);
    }
    table[value] = current >>> 0;
  }
  return table;
})();

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function projectRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function safeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Artifact path must be a non-empty relative path.");
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    posix.isAbsolute(normalized) ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`Artifact path traversal is not permitted: ${value}`);
  }
  const result = posix.normalize(normalized);
  if (result === "." || result === ".." || result.startsWith("../")) {
    throw new Error(`Artifact path traversal is not permitted: ${value}`);
  }
  return result;
}

function nativePath(root, relativePath) {
  return join(root, ...safeRelativePath(relativePath).split("/"));
}

function parseSourceDateEpoch(value) {
  const text = String(value ?? process.env.SOURCE_DATE_EPOCH ?? ZIP_EPOCH);
  if (!/^\d+$/.test(text)) {
    throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer.");
  }
  const timestamp = Number(text);
  if (!Number.isSafeInteger(timestamp)) {
    throw new Error("SOURCE_DATE_EPOCH must be a safe integer.");
  }
  return timestamp;
}

function assertVersion(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Artifact version must be strict semver.");
  }
}

async function collectFiles(root, relativeRoot = "") {
  let stat;
  try {
    stat = await lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Required artifact source is missing: ${root}`);
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Symlinked artifact source is not permitted: ${root}`);
  }
  if (stat.isFile()) {
    return [{ path: safeRelativePath(relativeRoot), data: await readFile(root) }];
  }
  if (!stat.isDirectory()) {
    throw new Error(`Unsupported artifact source type: ${root}`);
  }

  const files = [];
  const visit = async (directory, prefix) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const entryStat = await lstat(entryPath);
      if (entryStat.isSymbolicLink()) {
        throw new Error(`Symlinked artifact source is not permitted: ${entryPath}`);
      }
      if (entryStat.isDirectory()) {
        await visit(entryPath, relativePath);
      } else if (entryStat.isFile()) {
        files.push({ path: safeRelativePath(relativePath), data: await readFile(entryPath) });
      } else {
        throw new Error(`Unsupported artifact source type: ${entryPath}`);
      }
    }
  };
  await visit(root, relativeRoot);
  return files;
}

function parseJson(bytes, label) {
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("not an object");
    }
    return parsed;
  } catch {
    throw new Error(`${label} must contain a JSON object.`);
  }
}

function crc32(bytes) {
  let current = 0xffffffff;
  for (const byte of bytes) {
    current = crcTable[(current ^ byte) & 0xff] ^ (current >>> 8);
  }
  return (current ^ 0xffffffff) >>> 0;
}

function dosDateTime(timestamp) {
  const date = new Date(Math.max(timestamp, ZIP_EPOCH) * 1000);
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { dosTime, dosDate };
}

function timestampFromDos(dosTime, dosDate) {
  const second = (dosTime & 0x1f) * 2;
  const minute = (dosTime >>> 5) & 0x3f;
  const hour = (dosTime >>> 11) & 0x1f;
  const day = dosDate & 0x1f;
  const month = ((dosDate >>> 5) & 0x0f) - 1;
  const year = ((dosDate >>> 9) & 0x7f) + 1980;
  return Date.UTC(year, month, day, hour, minute, second) / 1000;
}

function buildZip(files, timestamp) {
  const localParts = [];
  const centralParts = [];
  const { dosTime, dosDate } = dosDateTime(timestamp);
  let offset = 0;

  for (const file of [...files].sort((left, right) => comparePaths(left.path, right.path))) {
    const name = Buffer.from(file.path, "utf8");
    const checksum = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, name, file.data);
    centralParts.push(central, name);
    offset += local.length + name.length + file.data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function parseZip(bytes) {
  let endOffset = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) {
      endOffset = index;
      break;
    }
  }
  if (endOffset < 0) {
    throw new Error("Artifact archive is missing its ZIP directory.");
  }
  const count = bytes.readUInt16LE(endOffset + 10);
  let offset = bytes.readUInt32LE(endOffset + 16);
  const entries = [];
  const paths = new Set();
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Artifact archive has an invalid ZIP directory entry.");
    }
    const method = bytes.readUInt16LE(offset + 10);
    const dosTime = bytes.readUInt16LE(offset + 12);
    const dosDate = bytes.readUInt16LE(offset + 14);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const path = safeRelativePath(bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
    if (method !== 0 || paths.has(path)) {
      throw new Error("Artifact archive has unsupported or duplicate entries.");
    }
    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error("Artifact archive has an invalid local ZIP entry.");
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) {
      throw new Error("Artifact archive entry is truncated.");
    }
    paths.add(path);
    entries.push({
      path,
      data: bytes.subarray(dataStart, dataEnd),
      timestamp: timestampFromDos(dosTime, dosDate),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function materialize(files, destination) {
  for (const file of files) {
    const outputPath = nativePath(destination, file.path);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, file.data);
  }
}

async function stageHost({ sourceDir, stagingRoot, host, version, sharedPaths }) {
  const files = new Map();
  const addFiles = async (root, prefix = "") => {
    for (const file of await collectFiles(root, prefix)) {
      if (files.has(file.path)) {
        throw new Error(`Duplicate artifact target path: ${file.path}`);
      }
      files.set(file.path, file.data);
    }
  };

  await addFiles(join(sourceDir, "hosts", host));
  for (const sharedPath of sharedPaths) {
    await addFiles(join(sourceDir, "shared", ...sharedPath.split("/")), sharedPath);
  }

  const manifestPath = REQUIRED_MANIFESTS[host];
  const manifestBytes = files.get(manifestPath);
  if (manifestBytes === undefined) {
    throw new Error(`Missing required manifest for ${host}: ${manifestPath}`);
  }
  const manifest = parseJson(manifestBytes, `${host} manifest`);
  if (manifest.version !== version) {
    throw new Error(`Host manifest version disagreement for ${host}.`);
  }
  manifest.version = version;
  files.set(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));

  const skillPath = "skills/parley/SKILL.md";
  const skill = files.get(skillPath);
  if (skill === undefined) {
    throw new Error(`Missing required shared skill: ${skillPath}`);
  }
  const stageDir = join(stagingRoot, host);
  const stagedFiles = [...files].map(([path, data]) => ({ path, data }));
  await materialize(stagedFiles, stageDir);
  const orderedFiles = await collectFiles(stageDir);
  return { host, stageDir, files: orderedFiles, skillSha256: hash(skill) };
}

export async function writeFileAtomically(destination, bytes, { rename = renameFile } = {}) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = join(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function existingPath(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function replaceMaterializedDirectory(
  stagedDirectory,
  destination,
  { rename = renameFile, remove = rm, stat = existingPath } = {},
) {
  await mkdir(dirname(destination), { recursive: true });
  const backup = `${destination}.backup`;
  const staged = await stat(stagedDirectory);
  if (staged === null || !staged.isDirectory() || staged.isSymbolicLink()) {
    throw new Error("Materialized artifact staging root must be a real directory.");
  }

  const existingDestination = await stat(destination);
  const existingBackup = await stat(backup);
  if (existingDestination === null && existingBackup !== null) {
    await rename(backup, destination);
  } else if (existingDestination !== null && existingBackup !== null) {
    await remove(backup, { recursive: true, force: true });
  }

  let movedPreviousRoot = false;
  let promoted = false;
  try {
    if (await stat(destination)) {
      await rename(destination, backup);
      movedPreviousRoot = true;
    }
    await rename(stagedDirectory, destination);
    promoted = true;
    if (movedPreviousRoot) {
      await remove(backup, { recursive: true, force: true });
    }
  } catch (error) {
    if (movedPreviousRoot && (await stat(backup))) {
      try {
        await rename(backup, destination);
      } catch (restoreError) {
        throw new Error(`Materialized artifact promotion failed and prior root restoration failed: ${restoreError.message}`);
      }
    }
    throw error;
  } finally {
    if (!promoted) {
      await remove(stagedDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function buildArtifacts({
  version,
  outputDir = join(projectRoot(), "dist"),
  sourceDir = projectRoot(),
  sourceDateEpoch,
  sharedPaths = SHARED_PATHS,
} = {}) {
  assertVersion(version);
  const normalizedSharedPaths = sharedPaths.map(safeRelativePath);
  if (new Set(normalizedSharedPaths).size !== normalizedSharedPaths.length) {
    throw new Error("Duplicate declared shared paths are not permitted.");
  }
  const timestamp = parseSourceDateEpoch(sourceDateEpoch);
  const absoluteSource = resolve(sourceDir);
  const absoluteOutput = resolve(outputDir);
  await mkdir(absoluteOutput, { recursive: true });
  const stagingRoot = await mkdtemp(join(absoluteOutput, ".stage-"));
  try {
    const prepared = [];
    for (const host of HOSTS) {
      prepared.push(await stageHost({
        sourceDir: absoluteSource,
        stagingRoot,
        host,
        version,
        sharedPaths: normalizedSharedPaths,
      }));
    }

    const artifacts = [];
    for (const preparedHost of prepared) {
      const archiveName = `parley-${preparedHost.host}-${version}.zip`;
      const archivePath = join(absoluteOutput, archiveName);
      const archive = buildZip(preparedHost.files, timestamp);
      const sha256 = hash(archive);
      await writeFileAtomically(archivePath, archive);
      await writeFileAtomically(
        `${archivePath}.sha256`,
        Buffer.from(`${sha256}  ${archiveName}\n`),
      );
      await replaceMaterializedDirectory(preparedHost.stageDir, join(absoluteOutput, preparedHost.host));
      artifacts.push({
        host: preparedHost.host,
        version,
        archivePath,
        sha256,
        skillSha256: preparedHost.skillSha256,
      });
    }
    return artifacts;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function readZipEntries(archivePath) {
  return parseZip(await readFile(archivePath)).map(({ path, timestamp }) => ({ path, timestamp }));
}

export async function readZipText(archivePath, entryPath) {
  const normalizedPath = safeRelativePath(entryPath);
  const entry = parseZip(await readFile(archivePath)).find((candidate) => candidate.path === normalizedPath);
  if (entry === undefined) {
    throw new Error(`Artifact archive is missing ${normalizedPath}.`);
  }
  return entry.data.toString("utf8");
}

export async function readZipFiles(archivePath) {
  return parseZip(await readFile(archivePath));
}

async function main() {
  const root = projectRoot();
  const packageJson = parseJson(await readFile(join(root, "package.json")), "package.json");
  const artifacts = await buildArtifacts({ version: packageJson.version, sourceDir: root, outputDir: join(root, "dist") });
  console.log(`Built ${artifacts.length} deterministic Parley artifacts for ${packageJson.version}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Build failed: ${error.message}`);
    process.exitCode = 1;
  });
}
