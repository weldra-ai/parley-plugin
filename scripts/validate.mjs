import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOSTS, readZipFiles } from "./build.mjs";
import { runNativeValidators } from "./native-validate.mjs";
import { syncMarketplaceSnapshots } from "./sync-marketplaces.mjs";

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
export const TRUSTED_MCP_ORIGIN = "https://parley.weldra.dev/mcp";
const CLAUDE_HEADERS_HELPER = "node \"${CLAUDE_PLUGIN_ROOT}/scripts/space-headers.mjs\" \"${CLAUDE_PROJECT_DIR}\"";
const TRUSTED_CLAUDE_SPACE_HELPER_SHA256 = "b03210c959f1efdbdaabf816ab1c5382acd3571f648d99a522cf5e03fb00df7b";
const FORBIDDEN_AUTH_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
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
  if (server.headers !== undefined) {
    const headers = assertObject(server.headers, `${label} headers`);
    for (const name of Object.keys(headers)) {
      if (FORBIDDEN_AUTH_HEADER_NAMES.has(name.toLowerCase())) {
        throw new Error(`${label} must use OAuth lifecycle mode without a static bearer header.`);
      }
    }
  }
  return server;
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
  if (Object.hasOwn(manifest, "userConfig")) {
    throw new Error("Claude OAuth artifact must not declare userConfig credentials.");
  }
  const server = assertOneParleyServer(mcp.mcpServers, canonicalOrigin, "Claude artifact");
  if (Object.hasOwn(server, "headers")) {
    throw new Error("Claude OAuth artifact must not define static MCP headers.");
  }
  if (server.headersHelper !== CLAUDE_HEADERS_HELPER) {
    throw new Error("Claude headersHelper must be the bundled space-only helper.");
  }
  const helper = files.get("scripts/space-headers.mjs");
  if (helper === undefined || hash(helper) !== TRUSTED_CLAUDE_SPACE_HELPER_SHA256) {
    throw new Error("Claude headersHelper must exactly match the trusted space-only output contract.");
  }
  if (files.get("scripts/managed-config.mjs") === undefined) {
    throw new Error("Claude artifact must include the shared manual configuration manager.");
  }
  const hooks = parseJson(files.get("hooks/hooks.json"), "Claude hooks manifest");
  const hookGroups = assertObject(hooks.hooks, "Claude hooks");
  const sessionStart = hookGroups.SessionStart;
  if (
    Object.keys(hookGroups).length !== 1 ||
    !Array.isArray(sessionStart) ||
    sessionStart.length !== 1 ||
    !Array.isArray(sessionStart[0]?.hooks) ||
    sessionStart[0].hooks.length !== 1
  ) {
    throw new Error("Claude artifact must declare only its SessionStart reminder hook.");
  }
  const reminder = sessionStart[0].hooks[0];
  if (
    reminder?.type !== "command" ||
    reminder.command !== "node" ||
    !Array.isArray(reminder.args) ||
    reminder.args.length !== 1 ||
    reminder.args[0] !== "${CLAUDE_PLUGIN_ROOT}/hooks/session-reminder.mjs" ||
    reminder.timeout !== 3
  ) {
    throw new Error("Claude SessionStart reminder hook is invalid.");
  }
}

function validateGemini(files, canonicalOrigin, version) {
  const manifest = parseJson(files.get(REQUIRED_MANIFESTS.gemini), "Gemini extension manifest");
  if (manifest.name !== "parley" || manifest.version !== version) {
    throw new Error("Gemini native manifest is invalid.");
  }
  const settings = manifest.settings;
  if (
    !Array.isArray(settings) ||
    settings.length !== 1 ||
    settings[0] === null ||
    typeof settings[0] !== "object" ||
    Array.isArray(settings[0]) ||
    Object.keys(settings[0]).length !== 4 ||
    settings[0].name !== "Parley token" ||
    settings[0].description !== "Recovery-only manual Parley token." ||
    settings[0].envVar !== "PARLEY_TOKEN" ||
    settings[0].sensitive !== true
  ) {
    throw new Error("Gemini artifact must declare exactly one sensitive PARLEY_TOKEN setting.");
  }
  const servers = assertObject(manifest.mcpServers, "Gemini artifact mcpServers");
  if (Object.keys(servers).length !== 1 || !Object.hasOwn(servers, "parley")) {
    throw new Error("Gemini artifact must expose exactly one logical parley server.");
  }
  const server = assertObject(servers.parley, "Gemini artifact parley server");
  const allowedServerFields = new Set(["httpUrl", "headers", "oauth"]);
  if (Object.keys(server).some((field) => !allowedServerFields.has(field))) {
    throw new Error("Gemini artifact must not declare a second authentication source.");
  }
  if (server.httpUrl !== canonicalOrigin) {
    throw new Error("Gemini artifact must use the canonical MCP origin.");
  }
  if (
    server.headers === null ||
    typeof server.headers !== "object" ||
    Array.isArray(server.headers) ||
    Object.keys(server.headers).length !== 1 ||
    server.headers.Authorization !== "Bearer ${PARLEY_TOKEN}"
  ) {
    throw new Error("Gemini artifact may use only its declared sensitive PARLEY_TOKEN placeholder.");
  }
  if (
    server.oauth === null ||
    typeof server.oauth !== "object" ||
    Array.isArray(server.oauth) ||
    Object.keys(server.oauth).length !== 1 ||
    server.oauth.enabled !== true
  ) {
    throw new Error("Gemini artifact must enable OAuth on the same Parley server.");
  }
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
  if (compatibility.canonicalMcpOrigin !== TRUSTED_MCP_ORIGIN) {
    throw new Error("Compatibility declaration must equal the trusted MCP origin.");
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
  return TRUSTED_MCP_ORIGIN;
}

async function readArtifactFiles(archivePath) {
  const files = new Map();
  for (const entry of await readZipFiles(archivePath)) {
    files.set(entry.path, entry.data);
  }
  return files;
}

async function collectMaterializedFiles(root) {
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Missing materialized artifact root.");
    }
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Materialized artifact root must be a real directory.");
  }

  const files = new Map();
  const directories = new Set();
  const visit = async (directory, prefix = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        throw new Error(`Symlinked materialized artifact entry: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        directories.add(relativePath);
        await visit(path, relativePath);
      } else if (stat.isFile()) {
        files.set(relativePath, await readFile(path));
      } else {
        throw new Error(`Unsupported materialized artifact entry: ${relativePath}`);
      }
    }
  };
  await visit(root);
  return { files, directories };
}

async function assertMaterializedParity(outputDir, host, archivedFiles) {
  const { files: materializedFiles, directories: materializedDirectories } = await collectMaterializedFiles(join(outputDir, host));
  const archivedDirectories = new Set();
  for (const path of archivedFiles.keys()) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      archivedDirectories.add(segments.slice(0, index).join("/"));
    }
  }
  for (const [path, expected] of archivedFiles) {
    const actual = materializedFiles.get(path);
    if (actual === undefined) {
      throw new Error(`Missing materialized artifact path for ${host}: ${path}`);
    }
    if (!actual.equals(expected)) {
      throw new Error(`${host} materialized artifact differs from its archive: ${path}`);
    }
  }
  for (const path of materializedFiles.keys()) {
    if (!archivedFiles.has(path)) {
      throw new Error(`Unexpected materialized artifact path for ${host}: ${path}`);
    }
  }
  for (const path of archivedDirectories) {
    if (!materializedDirectories.has(path)) {
      throw new Error(`Missing materialized artifact path for ${host}: ${path}`);
    }
  }
  for (const path of materializedDirectories) {
    if (!archivedDirectories.has(path)) {
      throw new Error(`Unexpected materialized artifact path for ${host}: ${path}`);
    }
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
  const sourceManualConfigHash = hash(await readFile(join(root, "shared", "scripts", "managed-config.mjs")));
  const skillHashes = [];
  const manualConfigHashes = [];

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
    await assertMaterializedParity(outputDir, host, files);
    skillHashes.push(hash(files.get("skills/parley/SKILL.md")));
    const manualConfig = files.get("scripts/managed-config.mjs");
    if (manualConfig === undefined) {
      throw new Error(`${host} artifact is missing the shared manual configuration manager.`);
    }
    manualConfigHashes.push(hash(manualConfig));
  }
  if (!skillHashes.every((candidate) => candidate === sourceSkillHash)) {
    throw new Error("Native artifacts do not share the canonical skill hash.");
  }
  if (!manualConfigHashes.every((candidate) => candidate === sourceManualConfigHash)) {
    throw new Error("Native artifacts do not share the canonical shared manual configuration manager.");
  }
  return { version, skillSha256: sourceSkillHash };
}

async function main() {
  const result = await validateArtifacts();
  await runNativeValidators({ outputDir: join(projectRoot(), "dist") });
  await syncMarketplaceSnapshots({ root: projectRoot(), check: true });
  console.log(`Validated ${HOSTS.length} native artifacts for ${result.version}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Validation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
