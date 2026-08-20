import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CLAUDE_MANUAL_SERVER_NAME = "parley-manual-override";
export const CLAUDE_PROFILE_FILE = ".claude.json";
export const CLAUDE_MANAGED_DIRECTORY = "parley";
export const CLAUDE_HELPER_FILE = "claude-space-headers.mjs";
export const CLAUDE_SIDECAR_FILE = "claude-manual-override.json";
export const MAX_MANUAL_TOKEN_BYTES = 4_096;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function failIfRequested(failAt, phase) {
  if (failAt !== undefined && failAt === phase) {
    throw new Error(`Injected ${phase} failure.`);
  }
}

async function snapshot(path) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symlinked managed path: ${path}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Managed path must be a regular file: ${path}`);
    }
    return { exists: true, bytes: await readFile(path) };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, bytes: null };
    }
    throw error;
  }
}

async function readRegularFile(path, label) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink.`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} must be a regular file.`);
  }
  return readFile(path);
}

async function atomicWrite(path, bytes, { failAt, phase } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomBytes(12).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    failIfRequested(failAt, phase);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function restore(path, original) {
  if (original.exists) {
    await atomicWrite(path, original.bytes);
  } else {
    await rm(path, { force: true });
  }
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

function encodeJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function assertToken(value) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_MANUAL_TOKEN_BYTES ||
    !/^pn_[A-Za-z0-9_-]{20,}$/.test(value)
  ) {
    throw new Error("Manual token input is invalid.");
  }
}

function claudePaths(configPath, directory) {
  return {
    configPath,
    directory,
    helperPath: join(directory, CLAUDE_HELPER_FILE),
    sidecarPath: join(directory, CLAUDE_SIDECAR_FILE),
  };
}

export function resolveClaudePaths({ environment = process.env, home = homedir() } = {}) {
  const candidate = environment.CLAUDE_CONFIG_DIR;
  if (candidate === undefined) {
    const resolvedHome = resolve(home);
    return claudePaths(
      join(resolvedHome, CLAUDE_PROFILE_FILE),
      join(resolvedHome, ".claude", CLAUDE_MANAGED_DIRECTORY),
    );
  }
  if (typeof candidate !== "string" || !isAbsolute(candidate)) {
    throw new Error("CLAUDE_CONFIG_DIR must be an absolute profile path.");
  }
  return claudeManagedPaths(candidate);
}

export function claudeManagedPaths(configDirectory) {
  if (typeof configDirectory !== "string" || !isAbsolute(configDirectory)) {
    throw new Error("Claude profile directory must be absolute.");
  }
  const profileDir = resolve(configDirectory);
  return claudePaths(
    join(profileDir, CLAUDE_PROFILE_FILE),
    join(profileDir, CLAUDE_MANAGED_DIRECTORY),
  );
}

export function claudeHeadersHelper(helperPath) {
  return `node "${helperPath}" "${"${CLAUDE_PROJECT_DIR}"}"`;
}

function sidecarFor({ canonicalOrigin, helperPath, helperBytes }) {
  return {
    schemaVersion: 1,
    host: "claude",
    serverName: CLAUDE_MANUAL_SERVER_NAME,
    url: canonicalOrigin,
    helperPath,
    helperSha256: sha256(helperBytes),
  };
}

async function loadConfig(path) {
  const original = await snapshot(path);
  if (!original.exists) {
    return { original, value: { mcpServers: {} } };
  }
  const value = parseJson(original.bytes, "Claude profile");
  if (value.mcpServers === undefined) {
    value.mcpServers = {};
  }
  if (value.mcpServers === null || Array.isArray(value.mcpServers) || typeof value.mcpServers !== "object") {
    throw new Error("Claude profile mcpServers must be an object.");
  }
  return { original, value };
}

async function readOwnedSidecar(paths, canonicalOrigin) {
  const sidecar = parseJson(await readFile(paths.sidecarPath), "Claude manual sidecar");
  const helper = await readFile(paths.helperPath);
  if (
    sidecar.schemaVersion !== 1 ||
    sidecar.host !== "claude" ||
    sidecar.serverName !== CLAUDE_MANUAL_SERVER_NAME ||
    sidecar.url !== canonicalOrigin ||
    sidecar.helperPath !== paths.helperPath ||
    sidecar.helperSha256 !== sha256(helper)
  ) {
    throw new Error("Claude manual override ownership metadata conflicts with the managed shape.");
  }
  return { sidecar, helper };
}

function ownedEntry(entry, paths, canonicalOrigin) {
  return (
    entry !== null &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    entry.type === "http" &&
    entry.url === canonicalOrigin &&
    entry.headers !== null &&
    typeof entry.headers === "object" &&
    !Array.isArray(entry.headers) &&
    Object.keys(entry.headers).length === 1 &&
    typeof entry.headers.Authorization === "string" &&
    /^Bearer pn_[A-Za-z0-9_-]{20,}$/.test(entry.headers.Authorization) &&
    entry.headersHelper === claudeHeadersHelper(paths.helperPath)
  );
}

function normalizedMcpEndpoint(value) {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function assertNoCompetingParleyEndpoint(servers, canonicalOrigin) {
  const canonical = normalizedMcpEndpoint(canonicalOrigin);
  for (const name of Object.keys(servers)) {
    if (name === CLAUDE_MANUAL_SERVER_NAME) {
      continue;
    }
    const candidate = servers[name];
    const endpoint = normalizedMcpEndpoint(candidate?.url ?? candidate?.httpUrl);
    if (endpoint !== null && endpoint === canonical) {
      throw new Error("The selected Claude profile's .claude.json contains a different MCP entry for the Parley endpoint. Remove or rename it, then retry.");
    }
  }
}

async function assertExistingOwned({ servers, paths, canonicalOrigin }) {
  assertNoCompetingParleyEndpoint(servers, canonicalOrigin);
  const entry = servers[CLAUDE_MANUAL_SERVER_NAME];
  const artifactsPresent = (await snapshot(paths.helperPath)).exists || (await snapshot(paths.sidecarPath)).exists;
  if (entry === undefined) {
    if (artifactsPresent) {
      await readOwnedSidecar(paths, canonicalOrigin);
    }
    return false;
  }
  if (!ownedEntry(entry, paths, canonicalOrigin) || !artifactsPresent) {
    throw new Error("The selected Claude profile's .claude.json contains an unowned or malformed Parley manual override. Review or remove that override, then retry.");
  }
  await readOwnedSidecar(paths, canonicalOrigin);
  return true;
}

async function restoreAll(paths, originals) {
  await restore(paths.configPath, originals.config);
  await restore(paths.helperPath, originals.helper);
  await restore(paths.sidecarPath, originals.sidecar);
}

async function acquireProfileLock(paths, { failAt } = {}) {
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const directory = await lstat(paths.directory);
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error("Claude managed directory must be a real directory.");
  }
  const lockPath = join(paths.directory, ".claude-manual-config.lock");
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.chmod(0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("Another Parley Claude configuration change holds .claude-manual-config.lock in the selected profile. Wait for it to finish; if none is running, remove that stale lock and retry.");
    }
    throw error;
  }
  let closed = false;
  let removed = false;
  let injectedFailure = false;
  return async () => {
    if (!injectedFailure && failAt === "lock-release") {
      injectedFailure = true;
      failIfRequested(failAt, "lock-release");
    }
    if (!closed) {
      await handle.close();
      closed = true;
    }
    if (!removed) {
      await rm(lockPath, { force: true });
      removed = true;
    }
  };
}

async function runClaudeTransaction(paths, failAt, transition) {
  const releaseLock = await acquireProfileLock(paths, { failAt });
  let originals = null;
  try {
    const { original: config, value } = await loadConfig(paths.configPath);
    originals = {
      config,
      helper: await snapshot(paths.helperPath),
      sidecar: await snapshot(paths.sidecarPath),
    };
    const result = await transition(value);
    await releaseLock();
    return result;
  } catch (error) {
    let restoreError = null;
    if (originals !== null) {
      try {
        await restoreAll(paths, originals);
      } catch (caught) {
        restoreError = caught;
      }
    }
    let releaseError = null;
    try {
      await releaseLock();
    } catch (caught) {
      releaseError = caught;
    }
    if (restoreError !== null) {
      throw new Error("Parley could not safely restore the selected Claude profile after a failed change. Check .claude.json before retrying.");
    }
    if (releaseError !== null) {
      throw new Error("The selected Claude profile was restored, but .claude-manual-config.lock could not be removed. After confirming no setup is running, remove that stale lock and retry.");
    }
    throw error;
  }
}

export async function applyClaudeManual({
  profileDir,
  token,
  helperSourcePath,
  canonicalOrigin,
  failAt,
} = {}) {
  assertToken(token);
  if (typeof canonicalOrigin !== "string" || !canonicalOrigin.startsWith("https://")) {
    throw new Error("Claude manual override requires the canonical HTTPS MCP origin.");
  }
  if (typeof helperSourcePath !== "string" || !isAbsolute(helperSourcePath)) {
    throw new Error("Claude manual override requires an absolute helper source path.");
  }
  const helperBytes = await readRegularFile(helperSourcePath, "Claude helper source");
  const paths = profileDir === undefined ? resolveClaudePaths() : claudeManagedPaths(profileDir);
  return runClaudeTransaction(paths, failAt, async (value) => {
      await assertExistingOwned({ servers: value.mcpServers, paths, canonicalOrigin });
      const metadata = sidecarFor({ canonicalOrigin, helperPath: paths.helperPath, helperBytes });
      value.mcpServers[CLAUDE_MANUAL_SERVER_NAME] = {
        type: "http",
        url: canonicalOrigin,
        headers: { Authorization: `Bearer ${token}` },
        headersHelper: claudeHeadersHelper(paths.helperPath),
      };
      await atomicWrite(paths.helperPath, helperBytes, { failAt, phase: "helper-promotion" });
      await atomicWrite(paths.sidecarPath, encodeJson(metadata), { failAt, phase: "sidecar-promotion" });
      await atomicWrite(paths.configPath, encodeJson(value), { failAt, phase: "config-promotion" });
      await assertExistingOwned({ servers: (await loadConfig(paths.configPath)).value.mcpServers, paths, canonicalOrigin });
      failIfRequested(failAt, "validation");
      failIfRequested(failAt, "cleanup");
      return paths;
    });
}

export async function switchClaudeOAuth({
  profileDir,
  canonicalOrigin,
  failAt,
} = {}) {
  if (typeof canonicalOrigin !== "string" || !canonicalOrigin.startsWith("https://")) {
    throw new Error("Claude OAuth switch requires the canonical HTTPS MCP origin.");
  }
  const paths = profileDir === undefined ? resolveClaudePaths() : claudeManagedPaths(profileDir);
  return runClaudeTransaction(paths, failAt, async (value) => {
      const exists = await assertExistingOwned({ servers: value.mcpServers, paths, canonicalOrigin });
      if (exists) {
        delete value.mcpServers[CLAUDE_MANUAL_SERVER_NAME];
        await atomicWrite(paths.configPath, encodeJson(value), { failAt, phase: "config-promotion" });
      }
      failIfRequested(failAt, "cleanup");
      await rm(paths.helperPath, { force: true });
      failIfRequested(failAt, "cleanup-after-helper");
      await rm(paths.sidecarPath, { force: true });
      failIfRequested(failAt, "cleanup-after-sidecar");
      return paths;
    });
}

async function readManualToken() {
  const chunks = [];
  let length = 0;
  let combined = null;
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_MANUAL_TOKEN_BYTES + 2) {
        bytes.fill(0);
        throw new Error("Manual token input is invalid.");
      }
      chunks.push(bytes);
    }
    combined = Buffer.concat(chunks);
    const value = new TextDecoder("utf-8", { fatal: true }).decode(combined).replace(/\r?\n$/, "");
    assertToken(value);
    return value;
  } finally {
    combined?.fill(0);
    for (const chunk of chunks) {
      chunk.fill(0);
    }
  }
}

function helperSourceFromArgs(args) {
  const index = args.indexOf("--helper-source");
  const value = index < 0 ? undefined : args[index + 1];
  if (typeof value !== "string" || index + 2 !== args.length) {
    throw new Error("Manual setup requires exactly one --helper-source path.");
  }
  return value;
}

async function main() {
  const [host, mode, ...args] = process.argv.slice(2);
  if (host !== "claude" || !["manual", "oauth"].includes(mode)) {
    throw new Error("Usage: managed-config.mjs claude <manual|oauth> [--helper-source PATH]");
  }
  const canonicalOrigin = "https://parley.weldra.dev/mcp";
  if (mode === "manual") {
    let token = await readManualToken();
    try {
      await applyClaudeManual({ canonicalOrigin, token, helperSourcePath: helperSourceFromArgs(args) });
    } finally {
      token = "";
    }
    process.stdout.write("Claude manual connection configured.\n");
  } else {
    if (args.length !== 0) {
      throw new Error("OAuth switch does not accept arguments.");
    }
    await switchClaudeOAuth({ canonicalOrigin });
    process.stdout.write("Claude OAuth connection restored.\n");
  }
}

function publicCliError(error) {
  const message = error instanceof Error ? error.message : "";
  if (
    message === "Manual token input is invalid." ||
    message.startsWith("The selected Claude profile's .claude.json") ||
    message.startsWith("Another Parley Claude configuration change holds .claude-manual-config.lock") ||
    message.startsWith("The selected Claude profile was restored, but .claude-manual-config.lock") ||
    message.startsWith("Parley could not safely restore the selected Claude profile")
  ) {
    return message;
  }
  return "Parley Claude configuration could not be updated. No changes were kept.";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${publicCliError(error)}\n`);
    process.exitCode = 1;
  });
}
