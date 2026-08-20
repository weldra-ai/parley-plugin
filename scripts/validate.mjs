import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOSTS, readZipFiles } from "./build.mjs";

const REQUIRED_MANIFESTS = {
  codex: ".codex-plugin/plugin.json",
  claude: ".claude-plugin/plugin.json",
  gemini: "gemini-extension.json",
};
const ENFORCEMENT_MODES = new Set([
  "native",
  "pre-activation",
  "certified host-local helper",
  "omitting/disabling capability",
]);

function projectRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJson(bytes, label) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      throw new Error("not an object");
    }
    return value;
  } catch {
    throw new Error(`${label} must contain a JSON object.`);
  }
}

function assertObject(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function assertOneParleyServer(servers, canonicalOrigin, label) {
  const serverMap = assertObject(servers, `${label} mcpServers`);
  const names = Object.keys(serverMap);
  if (names.length !== 1 || names[0] !== "parley") {
    throw new Error(`${label} must expose exactly one logical parley server.`);
  }
  const server = assertObject(serverMap.parley, `${label} parley server`);
  const endpoint = server.url ?? server.httpUrl;
  if (endpoint !== canonicalOrigin) {
    throw new Error(`${label} must use the canonical MCP origin.`);
  }
  if (server.headers?.Authorization) {
    throw new Error(`${label} must use OAuth lifecycle mode without a static bearer header.`);
  }
}

function validateCodex(files, canonicalOrigin, version) {
  const manifest = parseJson(files.get(REQUIRED_MANIFESTS.codex), "Codex plugin manifest");
  if (manifest.name !== "parley" || manifest.version !== version || manifest.skills !== "./skills/") {
    throw new Error("Codex native manifest is invalid.");
  }
  assertObject(manifest.interface, "Codex plugin interface");
  assertOneParleyServer(manifest.mcpServers, canonicalOrigin, "Codex artifact");
}

function validateClaude(files, canonicalOrigin, version) {
  const manifest = parseJson(files.get(REQUIRED_MANIFESTS.claude), "Claude plugin manifest");
  const mcp = parseJson(files.get(".mcp.json"), "Claude MCP manifest");
  if (
    manifest.name !== "parley" ||
    manifest.version !== version ||
    typeof manifest.author?.name !== "string" ||
    manifest.author.name.length === 0
  ) {
    throw new Error("Claude native manifest is invalid.");
  }
  assertOneParleyServer(mcp.mcpServers, canonicalOrigin, "Claude artifact");
}

function validateGemini(files, canonicalOrigin, version) {
  const manifest = parseJson(files.get(REQUIRED_MANIFESTS.gemini), "Gemini extension manifest");
  if (manifest.name !== "parley" || manifest.version !== version) {
    throw new Error("Gemini native manifest is invalid.");
  }
  assertOneParleyServer(manifest.mcpServers, canonicalOrigin, "Gemini artifact");
}

const NATIVE_VALIDATORS = {
  codex: validateCodex,
  claude: validateClaude,
  gemini: validateGemini,
};

function validateCompatibility(compatibility) {
  if (compatibility.schemaVersion !== 1 || compatibility.lifecycleMode !== "oauth") {
    throw new Error("Compatibility declaration must use the canonical OAuth lifecycle.");
  }
  if (typeof compatibility.canonicalMcpOrigin !== "string" || !compatibility.canonicalMcpOrigin.startsWith("https://")) {
    throw new Error("Compatibility declaration must provide an HTTPS MCP origin.");
  }
  const hosts = assertObject(compatibility.hosts, "Compatibility hosts");
  for (const host of HOSTS) {
    const declaration = assertObject(hosts[host], `Compatibility for ${host}`);
    if (!Array.isArray(declaration.testedVersions) || !Array.isArray(declaration.operatingSystems) || !Array.isArray(declaration.authModes)) {
      throw new Error(`Compatibility for ${host} must record versions, operating systems, and auth modes.`);
    }
    if (!declaration.authModes.includes("oauth")) {
      throw new Error(`Compatibility for ${host} must declare OAuth support.`);
    }
    const minimum = assertObject(declaration.minimumSupport, `Minimum support for ${host}`);
    if (!ENFORCEMENT_MODES.has(minimum.enforcedBy)) {
      throw new Error(`Minimum support for ${host} has an invalid enforcement mode.`);
    }
    if (minimum.minimumVersion !== null && (typeof minimum.minimumVersion !== "string" || !/^\d+\.\d+\.\d+/.test(minimum.minimumVersion))) {
      throw new Error(`Minimum support for ${host} must use semver or null.`);
    }
  }
  return compatibility.canonicalMcpOrigin;
}

async function readArtifactFiles(archivePath) {
  const files = new Map();
  for (const entry of await readZipFiles(archivePath)) {
    files.set(entry.path, entry.data);
  }
  return files;
}

async function assertMaterializedManifest(outputDir, host, expected) {
  const actual = await readFile(join(outputDir, host, ...REQUIRED_MANIFESTS[host].split("/")));
  if (!actual.equals(expected)) {
    throw new Error(`${host} materialized artifact differs from its archive.`);
  }
}

export async function validateArtifacts({
  root = projectRoot(),
  outputDir = join(root, "dist"),
} = {}) {
  const packageJson = parseJson(await readFile(join(root, "package.json")), "package.json");
  const compatibility = parseJson(await readFile(join(root, "compatibility.json")), "compatibility.json");
  const canonicalOrigin = validateCompatibility(compatibility);
  const version = packageJson.version;
  if (typeof version !== "string") {
    throw new Error("package.json must provide a version.");
  }
  const sourceSkillHash = hash(await readFile(join(root, "shared", "skills", "parley", "SKILL.md")));
  const skillHashes = [];

  for (const host of HOSTS) {
    const archiveName = `parley-${host}-${version}.zip`;
    const archivePath = join(outputDir, archiveName);
    const archive = await readFile(archivePath);
    const archiveHash = hash(archive);
    const checksum = await readFile(`${archivePath}.sha256`, "utf8");
    if (checksum !== `${archiveHash}  ${archiveName}\n`) {
      throw new Error(`${host} artifact checksum is invalid.`);
    }
    const files = await readArtifactFiles(archivePath);
    const manifestPath = REQUIRED_MANIFESTS[host];
    if (!files.has(manifestPath) || !files.has("skills/parley/SKILL.md")) {
      throw new Error(`${host} artifact is missing required native files.`);
    }
    NATIVE_VALIDATORS[host](files, canonicalOrigin, version);
    await assertMaterializedManifest(outputDir, host, files.get(manifestPath));
    skillHashes.push(hash(files.get("skills/parley/SKILL.md")));
  }
  if (!skillHashes.every((candidate) => candidate === sourceSkillHash)) {
    throw new Error("Native artifacts do not share the canonical skill hash.");
  }
  return { version, skillSha256: sourceSkillHash };
}

async function main() {
  const result = await validateArtifacts();
  console.log(`Validated ${HOSTS.length} native artifacts for ${result.version}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Validation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
