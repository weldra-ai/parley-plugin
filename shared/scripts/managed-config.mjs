import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, win32 as windowsPath } from "node:path";
import { fileURLToPath } from "node:url";

export const CLAUDE_MANUAL_SERVER_NAME = "parley-manual-override";
export const CLAUDE_PROFILE_FILE = ".claude.json";
export const CLAUDE_MANAGED_DIRECTORY = "parley";
export const CLAUDE_HELPER_FILE = "claude-space-headers.mjs";
export const CLAUDE_SIDECAR_FILE = "claude-manual-override.json";
export const CODEX_PROFILE_FILE = "config.toml";
export const CODEX_MANUAL_SERVER_NAME = "parley";
export const MAX_MANUAL_TOKEN_BYTES = 4_096;
const CODEX_MANAGED_BEGIN = "# BEGIN PARLEY MANAGED MANUAL OVERRIDE";
const CODEX_MANAGED_END = "# END PARLEY MANAGED MANUAL OVERRIDE";
const CODEX_HOST_VALIDATION_TIMEOUT_MS = 3_000;
const CODEX_HOST_VALIDATION_MAX_OUTPUT_BYTES = 4_096;
const WINDOWS_ACL_TIMEOUT_MS = 3_000;
const WINDOWS_ACL_MAX_OUTPUT_BYTES = 4_096;
const WINDOWS_ACL_TERMINATION_GRACE_MS = 250;
const WINDOWS_ACL_REAP_TIMEOUT_MS = 1_000;
const WINDOWS_FULL_CONTROL = 2_032_127;
const UNSAFE_CLAUDE_ROLLBACK_MESSAGE = "Parley could not safely restore the selected Claude profile after a failed change. Check .claude.json before retrying.";
const UNSAFE_CODEX_ROLLBACK_MESSAGE = "Parley could not safely restore the selected Codex profile after a failed change. Check config.toml before retrying.";

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

async function scrubTemporary(path) {
  let handle;
  try {
    handle = await open(path, "r+");
    await handle.truncate(0);
    await handle.sync();
  } finally {
    if (handle !== undefined) {
      await handle.close();
    }
  }
}

function boundedMilliseconds(value, fallback, label) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > 30_000) {
    throw new Error(`${label} must be a bounded positive integer.`);
  }
  return resolved;
}

function windowsEnvironmentValues(environment, name) {
  if (environment === null || typeof environment !== "object") {
    throw new Error("Windows system-root environment must be an object.");
  }
  const values = [];
  for (const [key, value] of Object.entries(environment)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      values.push(value);
    }
  }
  return values;
}

function normalizeWindowsSystemRoot(value, name) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    /[\r\n]/u.test(value) ||
    !/^[A-Za-z]:\\/u.test(value) ||
    value.split(/[\\/]/u).some((part) => part === "." || part === "..")
  ) {
    throw new Error(`Windows ${name} must be an absolute, normalized system-root path.`);
  }
  const normalized = windowsPath.normalize(value).replace(/\\+$/u, "");
  if (!/^[A-Za-z]:\\[^\\]+(?:\\[^\\]+)*$/u.test(normalized)) {
    throw new Error(`Windows ${name} must be an absolute, normalized system-root path.`);
  }
  return normalized;
}

function trustedWindowsSystemContext(windowsEnvironment = process.env) {
  const systemRootValues = windowsEnvironmentValues(windowsEnvironment, "SystemRoot");
  const windirValues = windowsEnvironmentValues(windowsEnvironment, "windir");
  if (systemRootValues.length !== 1 || windirValues.length !== 1) {
    throw new Error("Windows SystemRoot and windir must each be set exactly once.");
  }
  const systemRoot = normalizeWindowsSystemRoot(systemRootValues[0], "SystemRoot");
  const windir = normalizeWindowsSystemRoot(windirValues[0], "windir");
  if (systemRoot.toLowerCase() !== windir.toLowerCase()) {
    throw new Error("Windows SystemRoot and windir must identify the same system root.");
  }
  return {
    systemRoot,
    // Do not inherit the caller's environment: the ACL child has no reason to receive a credential.
    childEnvironment: { SystemRoot: systemRoot, windir: systemRoot },
  };
}

function defaultWindowsSystemPathResolver({ systemRoot }) {
  return {
    executable: windowsPath.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    prefixArgs: [],
  };
}

function validatedWindowsExecutable(resolved, { requireSystemPowerShell, systemRoot }) {
  if (
    resolved === null ||
    typeof resolved !== "object" ||
    typeof resolved.executable !== "string" ||
    !windowsPath.isAbsolute(resolved.executable) ||
    !/^[A-Za-z]:\\/u.test(resolved.executable) ||
    !Array.isArray(resolved.prefixArgs) ||
    resolved.prefixArgs.some((argument) => typeof argument !== "string" || argument.includes("\0"))
  ) {
    throw new Error("Windows ACL setup requires one trusted fully-qualified system executable.");
  }
  const executable = windowsPath.normalize(resolved.executable);
  if (requireSystemPowerShell) {
    const expected = windowsPath.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (executable.toLowerCase() !== expected.toLowerCase()) {
      throw new Error("Windows ACL setup requires the trusted SystemRoot PowerShell executable.");
    }
  }
  return { executable, prefixArgs: resolved.prefixArgs };
}

function powerShellLiteral(value) {
  return `'${value.replace(/'/gu, "''")}'`;
}

function windowsAclProofCommand(path) {
  const stagePath = powerShellLiteral(path);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$stagePath = ${stagePath}`,
    "$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$file = [System.IO.FileInfo]::new($stagePath)",
    "$acl = $file.GetAccessControl()",
    "$acl.SetAccessRuleProtection($true, $false)",
    "foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) { [void]$acl.RemoveAccessRuleSpecific($rule) }",
    "$fullControl = [Security.AccessControl.FileSystemRights]::FullControl",
    "$allow = [Security.AccessControl.AccessControlType]::Allow",
    "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($currentUser, $fullControl, $allow))",
    "$file.SetAccessControl($acl)",
    "$verified = $file.GetAccessControl()",
    "$rules = @($verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { [ordered]@{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); rights = [int]$_.FileSystemRights; inherited = [bool]$_.IsInherited; inheritance = [int]$_.InheritanceFlags; propagation = [int]$_.PropagationFlags } })",
    "[ordered]@{ currentUserSid = $currentUser.Value; ownerSid = $verified.GetOwner([Security.Principal.SecurityIdentifier]).Value; daclProtected = [bool]$verified.AreAccessRulesProtected; accessRules = $rules } | ConvertTo-Json -Compress -Depth 4",
  ].join("; ");
}

function waitForClose(closePromise, timeoutMs) {
  return new Promise((resolveResult) => {
    const timer = setTimeout(() => resolveResult(false), timeoutMs);
    closePromise.then(() => {
      clearTimeout(timer);
      resolveResult(true);
    });
  });
}

function waitForReapWindow(timeoutMs) {
  return new Promise((resolveResult) => setTimeout(resolveResult, timeoutMs));
}

async function terminateAndReap(child, closePromise, { terminationGraceMs, reapTimeoutMs }) {
  try {
    child.kill();
  } catch {
    // The close wait below determines whether the process was already gone.
  }
  if (!await waitForClose(closePromise, terminationGraceMs)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // A failed escalation still gets one bounded reaping wait.
    }
    if (!await waitForClose(closePromise, reapTimeoutMs)) {
      return false;
    }
  }
  // On Windows, close can precede a released descendant that inherited no tracked stdio. Keep the
  // credential-free staging file empty through one bounded reap window before any cleanup proceeds.
  await waitForReapWindow(reapTimeoutMs);
  return true;
}

function runBoundedProcess(
  command,
  args,
  {
    timeoutMs = WINDOWS_ACL_TIMEOUT_MS,
    terminationGraceMs = WINDOWS_ACL_TERMINATION_GRACE_MS,
    reapTimeoutMs = WINDOWS_ACL_REAP_TIMEOUT_MS,
    shell = false,
    env,
  } = {},
) {
  if (!windowsPath.isAbsolute(command) || shell !== false) {
    return Promise.reject(new Error("Windows ACL setup requires a fully-qualified executable without a shell."));
  }
  const boundedTimeoutMs = boundedMilliseconds(timeoutMs, WINDOWS_ACL_TIMEOUT_MS, "Windows ACL timeout");
  const boundedTerminationGraceMs = boundedMilliseconds(
    terminationGraceMs,
    WINDOWS_ACL_TERMINATION_GRACE_MS,
    "Windows ACL termination grace",
  );
  const boundedReapTimeoutMs = boundedMilliseconds(reapTimeoutMs, WINDOWS_ACL_REAP_TIMEOUT_MS, "Windows ACL reaping timeout");
  return new Promise((resolveResult, rejectResult) => {
    let child;
    let settled = false;
    let timer;
    let failureMessage = null;
    let failureCompletion = null;
    let closeResult;
    let closeResultResolve;
    const closePromise = new Promise((resolveClose) => {
      closeResultResolve = resolveClose;
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const settle = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const failAfterReap = (message) => {
      if (failureMessage !== null || settled) {
        return failureCompletion;
      }
      failureMessage = message;
      clearTimeout(timer);
      failureCompletion = terminateAndReap(child, closePromise, {
          terminationGraceMs: boundedTerminationGraceMs,
          reapTimeoutMs: boundedReapTimeoutMs,
        })
        .then((reaped) => {
          if (!reaped) {
            settle(() => rejectResult(new Error(`${message} Windows ACL child could not be reaped after bounded escalation.`)));
            return;
          }
          settle(() => rejectResult(new Error(message)));
        })
        .catch(() => {
          settle(() => rejectResult(new Error(`${message} Windows ACL child could not be reaped after bounded escalation.`)));
        });
      return failureCompletion;
    };
    try {
      child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      rejectResult(new Error("Could not run Windows owner-private ACL setup."));
      return;
    }
    const collect = (target) => (chunk) => {
      const bytes = Buffer.from(chunk);
      outputBytes += bytes.byteLength;
      if (outputBytes > WINDOWS_ACL_MAX_OUTPUT_BYTES) {
        failAfterReap("Windows owner-private ACL setup produced excessive output.");
        return;
      }
      target.push(bytes);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", () => failAfterReap("Could not run Windows owner-private ACL setup."));
    child.once("close", (code) => {
      closeResult = { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      closeResultResolve(closeResult);
      if (failureMessage !== null) {
        return;
      }
      settle(() => resolveResult(closeResult));
    });
    timer = setTimeout(() => failAfterReap("Windows owner-private ACL setup timed out."), boundedTimeoutMs);
  });
}

function assertBoundedWindowsResult(result, command) {
  if (
    result === null ||
    typeof result !== "object" ||
    !Number.isInteger(result.code) ||
    !Buffer.isBuffer(result.stdout) ||
    !Buffer.isBuffer(result.stderr) ||
    result.stdout.byteLength + result.stderr.byteLength > WINDOWS_ACL_MAX_OUTPUT_BYTES ||
    result.code !== 0
  ) {
    throw new Error(`Windows owner-private ACL setup failed while running ${command}.`);
  }
}

function assertVerifiedWindowsAcl(result, { requireOwner }) {
  let proof;
  try {
    proof = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw new Error("Windows owner-private ACL setup produced no verifiable DACL proof.");
  }
  if (
    proof === null ||
    Array.isArray(proof) ||
    typeof proof !== "object" ||
    typeof proof.currentUserSid !== "string" ||
    !/^S-1-\d+(?:-\d+)+$/u.test(proof.currentUserSid) ||
    (requireOwner && proof.ownerSid !== proof.currentUserSid) ||
    proof.daclProtected !== true ||
    !Array.isArray(proof.accessRules) ||
    proof.accessRules.length !== 1
  ) {
    throw new Error("Windows owner-private ACL verification rejected the staged DACL.");
  }
  const [rule] = proof.accessRules;
  if (
    rule === null ||
    typeof rule !== "object" ||
    rule.sid !== proof.currentUserSid ||
    rule.type !== "Allow" ||
    rule.rights !== WINDOWS_FULL_CONTROL ||
    rule.inherited !== false ||
    rule.inheritance !== 0 ||
    rule.propagation !== 0
  ) {
    throw new Error("Windows owner-private ACL verification rejected the staged DACL.");
  }
}

async function hardenWindowsTemporary(
  path,
  {
    processRunner = runBoundedProcess,
    windowsSystemPathResolver = defaultWindowsSystemPathResolver,
    windowsEnvironment = process.env,
    windowsAclTimeoutMs,
    windowsAclTerminationGraceMs,
    windowsAclReapTimeoutMs,
  } = {},
) {
  const { systemRoot, childEnvironment } = trustedWindowsSystemContext(windowsEnvironment);
  const resolved = await windowsSystemPathResolver({ systemRoot });
  const { executable, prefixArgs } = validatedWindowsExecutable(resolved, {
    requireSystemPowerShell: windowsSystemPathResolver === defaultWindowsSystemPathResolver,
    systemRoot,
  });
  const script = windowsAclProofCommand(path);
  const result = await processRunner(executable, [
    ...prefixArgs,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ], {
    shell: false,
    timeoutMs: boundedMilliseconds(windowsAclTimeoutMs, WINDOWS_ACL_TIMEOUT_MS, "Windows ACL timeout"),
    terminationGraceMs: boundedMilliseconds(
      windowsAclTerminationGraceMs,
      WINDOWS_ACL_TERMINATION_GRACE_MS,
      "Windows ACL termination grace",
    ),
    reapTimeoutMs: boundedMilliseconds(windowsAclReapTimeoutMs, WINDOWS_ACL_REAP_TIMEOUT_MS, "Windows ACL reaping timeout"),
    env: childEnvironment,
  });
  assertBoundedWindowsResult(result, executable);
  assertVerifiedWindowsAcl(result, { requireOwner: windowsSystemPathResolver === defaultWindowsSystemPathResolver });
}

async function syncParentDirectory(path, { platform = process.platform, directoryOpener = open } = {}) {
  if (platform === "win32") {
    // Node has no portable directory fsync contract on Windows. Rename provides atomic visibility and the
    // transaction provides in-process failure rollback; neither is a power-loss durability guarantee.
    return;
  }
  let handle;
  try {
    handle = await directoryOpener(dirname(path), "r");
    await handle.sync();
  } finally {
    if (handle !== undefined) {
      await handle.close();
    }
  }
}

async function verifyPosixOwnerPrivate(handle) {
  if (((await handle.stat()).mode & 0o077) !== 0) {
    throw new Error("Refusing to stage Claude configuration outside owner-private permissions.");
  }
}

async function atomicWrite(
  path,
  bytes,
  {
    failAt,
    phase,
    temporaryRemover = rm,
    temporaryWriter = (handle, content) => handle.writeFile(content),
    promoter = rename,
    onStaged,
    sensitive = false,
    platform = process.platform,
    directoryOpener = open,
    processRunner = runBoundedProcess,
    windowsSystemPathResolver = defaultWindowsSystemPathResolver,
    windowsEnvironment = process.env,
    windowsAclTimeoutMs,
    windowsAclTerminationGraceMs,
    windowsAclReapTimeoutMs,
    ownerPrivateVerifier = verifyPosixOwnerPrivate,
  } = {},
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomBytes(12).toString("hex")}.tmp`);
  let handle;
  let temporaryCreated = false;
  let promoted = false;
  let primaryError = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    temporaryCreated = true;
    await handle.chmod(0o600);
    if (platform === "win32" && sensitive) {
      await hardenWindowsTemporary(temporary, {
        processRunner,
        windowsSystemPathResolver,
        windowsEnvironment,
        windowsAclTimeoutMs,
        windowsAclTerminationGraceMs,
        windowsAclReapTimeoutMs,
      });
    } else if (platform !== "win32") {
      await ownerPrivateVerifier(handle);
    }
    await temporaryWriter(handle, bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await onStaged?.({ temporary, target: path, mode: 0o600 });
    failIfRequested(failAt, phase);
    await promoter(temporary, path);
    promoted = true;
    await syncParentDirectory(path, { platform, directoryOpener });
  } catch (error) {
    primaryError = error;
  }

  {
    const cleanupErrors = [];
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (sensitive && temporaryCreated && !promoted) {
      try {
        await scrubTemporary(temporary);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await temporaryRemover(temporary, { force: true, targetPath: path });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length === 1) {
      if (primaryError !== null) {
        throw new AggregateError([primaryError, cleanupErrors[0]], "Configuration write and cleanup both failed.");
      }
      throw cleanupErrors[0];
    }
    if (cleanupErrors.length > 1) {
      throw new AggregateError(
        primaryError === null ? cleanupErrors : [primaryError, ...cleanupErrors],
        "Failed to clean staged configuration safely.",
      );
    }
    if (primaryError !== null) {
      throw primaryError;
    }
  }
}

function configWriteOptions(configFileOps) {
  return {
    ...(configFileOps ?? {}),
    sensitive: true,
  };
}

function rollbackConfigFileOps(configFileOps) {
  const {
    platform,
    directoryOpener,
    ownerPrivateVerifier,
    rollbackPromoter,
    processRunner,
    windowsSystemPathResolver,
    windowsEnvironment,
    windowsAclTimeoutMs,
    windowsAclTerminationGraceMs,
    windowsAclReapTimeoutMs,
  } = configFileOps ?? {};
  return {
    platform,
    directoryOpener,
    ownerPrivateVerifier,
    promoter: rollbackPromoter,
    processRunner,
    windowsSystemPathResolver,
    windowsEnvironment,
    windowsAclTimeoutMs,
    windowsAclTerminationGraceMs,
    windowsAclReapTimeoutMs,
  };
}

async function writeClaudeConfig(path, bytes, { failAt, phase, configFileOps } = {}) {
  await atomicWrite(path, bytes, {
    failAt,
    phase,
    ...configWriteOptions(configFileOps),
  });
}

async function restore(path, original, { temporaryRemover } = {}) {
  if (original.exists) {
    await atomicWrite(path, original.bytes, { temporaryRemover });
  } else {
    await rm(path, { force: true });
  }
}

async function restoreClaudeConfig(path, original, { configFileOps } = {}) {
  if (original.exists) {
    await writeClaudeConfig(path, original.bytes, { configFileOps: rollbackConfigFileOps(configFileOps) });
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

async function restoreAll(paths, originals, { temporaryRemover, configFileOps } = {}) {
  const results = await Promise.allSettled([
    restoreClaudeConfig(paths.configPath, originals.config, { configFileOps }),
    restore(paths.helperPath, originals.helper, { temporaryRemover }),
    restore(paths.sidecarPath, originals.sidecar, { temporaryRemover }),
  ]);
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to restore one or more Claude profile artifacts.");
  }
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

function flattenErrors(error) {
  if (error instanceof AggregateError) {
    return error.errors.flatMap(flattenErrors);
  }
  return [error];
}

async function runClaudeTransaction(paths, failAt, transition, { temporaryRemover, configFileOps } = {}) {
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
        await restoreAll(paths, originals, { temporaryRemover, configFileOps });
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
    if (restoreError !== null || releaseError !== null) {
      const rollbackErrors = flattenErrors(error);
      if (restoreError !== null) {
        rollbackErrors.push(...flattenErrors(restoreError));
      }
      if (releaseError !== null) {
        rollbackErrors.push(...flattenErrors(releaseError));
      }
      const primaryMessage = error instanceof Error ? error.message : "the requested Claude configuration change";
      throw new AggregateError(
        rollbackErrors,
        `Claude configuration change failed (${primaryMessage}); ${UNSAFE_CLAUDE_ROLLBACK_MESSAGE}`,
      );
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
  temporaryRemover,
  configFileOps,
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
      await atomicWrite(paths.helperPath, helperBytes, { failAt, phase: "helper-promotion", temporaryRemover });
      await atomicWrite(paths.sidecarPath, encodeJson(metadata), { failAt, phase: "sidecar-promotion", temporaryRemover });
      await writeClaudeConfig(paths.configPath, encodeJson(value), {
        failAt,
        phase: "config-promotion",
        configFileOps,
      });
      await assertExistingOwned({ servers: (await loadConfig(paths.configPath)).value.mcpServers, paths, canonicalOrigin });
      failIfRequested(failAt, "validation");
      failIfRequested(failAt, "cleanup");
      return paths;
    }, { temporaryRemover, configFileOps });
}

export async function switchClaudeOAuth({
  profileDir,
  canonicalOrigin,
  failAt,
  temporaryRemover,
  configFileOps,
} = {}) {
  if (typeof canonicalOrigin !== "string" || !canonicalOrigin.startsWith("https://")) {
    throw new Error("Claude OAuth switch requires the canonical HTTPS MCP origin.");
  }
  const paths = profileDir === undefined ? resolveClaudePaths() : claudeManagedPaths(profileDir);
  return runClaudeTransaction(paths, failAt, async (value) => {
      const exists = await assertExistingOwned({ servers: value.mcpServers, paths, canonicalOrigin });
      if (exists) {
        delete value.mcpServers[CLAUDE_MANUAL_SERVER_NAME];
        await writeClaudeConfig(paths.configPath, encodeJson(value), {
          failAt,
          phase: "config-promotion",
          configFileOps,
        });
      }
      failIfRequested(failAt, "cleanup");
      await rm(paths.helperPath, { force: true });
      failIfRequested(failAt, "cleanup-after-helper");
      await rm(paths.sidecarPath, { force: true });
      failIfRequested(failAt, "cleanup-after-sidecar");
      return paths;
    }, { temporaryRemover, configFileOps });
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8.`);
  }
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function codexPaths(directory) {
  return {
    configPath: join(directory, CODEX_PROFILE_FILE),
    directory,
  };
}

export function codexManagedPaths(configDirectory) {
  if (typeof configDirectory !== "string" || !isAbsolute(configDirectory)) {
    throw new Error("Codex profile directory must be absolute.");
  }
  return codexPaths(resolve(configDirectory));
}

export function resolveCodexPaths({ environment = process.env, home = homedir() } = {}) {
  const candidate = environment.CODEX_HOME;
  if (candidate === undefined) {
    return codexPaths(join(resolve(home), ".codex"));
  }
  if (typeof candidate !== "string" || !isAbsolute(candidate)) {
    throw new Error("CODEX_HOME must be an absolute profile path.");
  }
  return codexManagedPaths(candidate);
}

function codexBlockPattern(canonicalOrigin) {
  const origin = escapeRegularExpression(canonicalOrigin);
  return new RegExp(
    `(?:^|\\n)${escapeRegularExpression(CODEX_MANAGED_BEGIN)}\\n# Parley original config: (present|absent)\\n\\[mcp_servers\\.parley\\]\\nurl = "${origin}"\\nhttp_headers = \\{ Authorization = "Bearer (pn_[A-Za-z0-9_-]{20,})" \\}\\n${escapeRegularExpression(CODEX_MANAGED_END)}\\n`,
    "g",
  );
}

function tomlCodeLine(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function decodeTomlBasicKey(content) {
  let decoded = "";
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character !== "\\") {
      if (character.codePointAt(0) < 0x20 || character === "\u007f") {
        return null;
      }
      decoded += character;
      continue;
    }
    index += 1;
    const escaped = content[index];
    const simpleEscapes = {
      b: "\b",
      t: "\t",
      n: "\n",
      f: "\f",
      r: "\r",
      '"': '"',
      "\\": "\\",
    };
    if (Object.hasOwn(simpleEscapes, escaped)) {
      decoded += simpleEscapes[escaped];
      continue;
    }
    const width = escaped === "u" ? 4 : escaped === "U" ? 8 : null;
    if (width === null) {
      return null;
    }
    const hexadecimal = content.slice(index + 1, index + 1 + width);
    if (hexadecimal.length !== width || !/^[0-9A-Fa-f]+$/u.test(hexadecimal)) {
      return null;
    }
    const codePoint = Number.parseInt(hexadecimal, 16);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return null;
    }
    decoded += String.fromCodePoint(codePoint);
    index += width;
  }
  return decoded;
}

function unparseableTomlKeyPath(segments, quoted, rawQuotedSegment) {
  const result = [...segments];
  if (
    result.length === 0 &&
    typeof rawQuotedSegment === "string" &&
    /^['"]mcp_servers(?:\\|['"]|$)/u.test(rawQuotedSegment)
  ) {
    result.push("mcp_servers");
  }
  return { segments: result, quoted, unparseable: true };
}

function tomlKeyPath(value) {
  const segments = [];
  let index = 0;
  let quoted = false;
  const whitespace = /\s/u;
  const bare = /[A-Za-z0-9_-]/u;
  const skipWhitespace = () => {
    while (index < value.length && whitespace.test(value[index])) {
      index += 1;
    }
  };
  skipWhitespace();
  while (index < value.length) {
    let segment;
    if (value[index] === '"' || value[index] === "'") {
      const quote = value[index];
      const start = index;
      index += 1;
      let escaped = false;
      while (index < value.length) {
        const character = value[index];
        index += 1;
        if (quote === '"' && escaped) {
          escaped = false;
        } else if (quote === '"' && character === "\\") {
          escaped = true;
        } else if (character === quote) {
          break;
        }
      }
      if (value[index - 1] !== quote) {
        return unparseableTomlKeyPath(segments, true, value.slice(start));
      }
      const raw = value.slice(start, index);
      segment = quote === '"' ? decodeTomlBasicKey(raw.slice(1, -1)) : raw.slice(1, -1);
      if (segment === null) {
        return unparseableTomlKeyPath(segments, true, raw);
      }
      quoted = true;
    } else {
      const start = index;
      while (index < value.length && bare.test(value[index])) {
        index += 1;
      }
      if (start === index) {
        return unparseableTomlKeyPath(segments, quoted);
      }
      segment = value.slice(start, index);
    }
    segments.push(segment);
    skipWhitespace();
    if (index === value.length) {
      return { segments, quoted, unparseable: false };
    }
    if (value[index] !== ".") {
      return unparseableTomlKeyPath(segments, quoted);
    }
    index += 1;
    skipWhitespace();
  }
  return unparseableTomlKeyPath(segments, quoted);
}

function tomlAssignmentKeyPath(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "=") {
      return tomlKeyPath(line.slice(0, index));
    }
  }
  return null;
}

function tomlTableKeyPath(line) {
  const trimmed = line.trim();
  const arrayTable = trimmed.startsWith("[[");
  const opener = arrayTable ? "[[" : "[";
  const closer = arrayTable ? "]]" : "]";
  if (!trimmed.startsWith(opener)) {
    return null;
  }
  if (!trimmed.endsWith(closer)) {
    return tomlKeyPath(trimmed.slice(opener.length));
  }
  return tomlKeyPath(trimmed.slice(opener.length, trimmed.length - closer.length));
}

function isAmbiguousCodexServerKeyPath(path) {
  if (path === null || path.segments[0] !== "mcp_servers") {
    return false;
  }
  // This is deliberately not a general TOML merger. Any quoted root/child segment or a root-level
  // mcp_servers construct is ambiguous ownership and therefore blocks a manual override.
  if (path.unparseable || path.quoted || path.segments.length < 2) {
    return true;
  }
  return path.segments[1] === CODEX_MANUAL_SERVER_NAME;
}

function hasUnownedCodexParleyForm(text) {
  for (const line of text.split(/\r?\n/u)) {
    const code = tomlCodeLine(line);
    const trimmed = code.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const path = trimmed.startsWith("[") ? tomlTableKeyPath(trimmed) : tomlAssignmentKeyPath(code);
    if (isAmbiguousCodexServerKeyPath(path)) {
      return true;
    }
  }
  return false;
}

function classifyCodexConfig(text, canonicalOrigin) {
  const begins = text.split(CODEX_MANAGED_BEGIN).length - 1;
  const ends = text.split(CODEX_MANAGED_END).length - 1;
  if (begins === 0 && ends === 0) {
    return hasUnownedCodexParleyForm(text) ? { kind: "unmanaged" } : { kind: "absent" };
  }
  if (begins !== 1 || ends !== 1) {
    return { kind: "unmanaged" };
  }
  const matches = [...text.matchAll(codexBlockPattern(canonicalOrigin))];
  if (matches.length !== 1 || matches[0].index === undefined) {
    return { kind: "unmanaged" };
  }
  const match = matches[0];
  const outside = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`;
  if (hasUnownedCodexParleyForm(outside)) {
    return { kind: "unmanaged" };
  }
  return {
    kind: "managed",
    index: match.index,
    bytes: match[0],
    originalWasAbsent: match[1] === "absent",
  };
}

function renderCodexManagedBlock({ canonicalOrigin, token, originalWasAbsent }) {
  assertToken(token);
  return [
    CODEX_MANAGED_BEGIN,
    `# Parley original config: ${originalWasAbsent ? "absent" : "present"}`,
    "[mcp_servers.parley]",
    `url = "${canonicalOrigin}"`,
    `http_headers = { Authorization = "Bearer ${token}" }`,
    CODEX_MANAGED_END,
    "",
  ].join("\n");
}

function codexCandidateForManual(text, classification, { canonicalOrigin, token, originalWasAbsent }) {
  const block = renderCodexManagedBlock({ canonicalOrigin, token, originalWasAbsent });
  if (classification.kind === "absent") {
    return `${text}${text.length > 0 ? "\n" : ""}${block}`;
  }
  if (classification.kind === "managed") {
    const prefix = classification.bytes.startsWith("\n") ? "\n" : "";
    return `${text.slice(0, classification.index)}${prefix}${block}${text.slice(classification.index + classification.bytes.length)}`;
  }
  throw new Error("The selected Codex profile contains an unowned Parley MCP configuration. Review or remove that entry, then retry.");
}

async function writeCodexConfig(path, bytes) {
  await atomicWrite(path, bytes, { sensitive: true });
}

async function restoreCodexConfig(path, original) {
  if (original.exists) {
    await writeCodexConfig(path, original.bytes);
  } else {
    await rm(path, { force: true });
  }
}

function copiedEnvironmentValue(environment, name) {
  const matches = Object.entries(environment)
    .filter(([key, value]) => key.toLowerCase() === name.toLowerCase() && typeof value === "string")
    .map(([, value]) => value);
  return matches.length === 1 ? matches[0] : undefined;
}

function codexHostValidationEnvironment(profileDir, environment) {
  const result = { CODEX_HOME: profileDir };
  for (const name of ["PATH", "PATHEXT", "SystemRoot", "windir", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP"]) {
    const value = copiedEnvironmentValue(environment, name);
    if (value !== undefined) {
      result[name] = value;
    }
  }
  return result;
}

function codexHostValidationInvocation(environment, platform) {
  if (platform === "win32") {
    const { systemRoot } = trustedWindowsSystemContext(environment);
    return {
      executable: windowsPath.join(systemRoot, "System32", "cmd.exe"),
      args: ["/d", "/s", "/c", "codex mcp list"],
    };
  }
  return { executable: "codex", args: ["mcp", "list"] };
}

function defaultCodexHostRunner({ executable, args, environment, timeoutMs }) {
  return new Promise((resolveResult) => {
    let child;
    let settled = false;
    let timedOut = false;
    let outputBytes = 0;
    const stdout = [];
    const stderr = [];
    let timer;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolveResult(result);
      }
    };
    const fail = () => {
      timedOut = true;
      try {
        child?.kill();
      } catch {
        // The bounded result below is intentionally token-safe.
      }
      finish({ code: null, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    };
    try {
      child = spawn(executable, args, {
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish({ code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
      return;
    }
    const collect = (target) => (chunk) => {
      if (settled) {
        return;
      }
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > CODEX_HOST_VALIDATION_MAX_OUTPUT_BYTES) {
        fail();
      } else {
        target.push(Buffer.from(chunk));
      }
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", fail);
    child.once("close", (code) => {
      finish({ code: timedOut ? null : code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    timer = setTimeout(fail, timeoutMs);
  });
}

export async function validateCodexHostProfile({
  profileDir,
  configPath,
  hostRunner = defaultCodexHostRunner,
  environment = process.env,
  platform = process.platform,
} = {}) {
  try {
    const paths = codexManagedPaths(profileDir);
    if (configPath !== paths.configPath || typeof hostRunner !== "function") {
      throw new Error("invalid host validation input");
    }
    const invocation = codexHostValidationInvocation(environment, platform);
    const result = await hostRunner({
      ...invocation,
      configPath: paths.configPath,
      profileDir: paths.directory,
      environment: codexHostValidationEnvironment(paths.directory, environment),
      timeoutMs: CODEX_HOST_VALIDATION_TIMEOUT_MS,
    });
    if (result === null || typeof result !== "object" || result.code !== 0) {
      throw new Error("host validator failed");
    }
  } catch {
    throw new Error("Codex host configuration validation failed.");
  }
}

async function commitCodexConfig(paths, original, candidate, canonicalOrigin, { expectedKind, hostValidator } = {}) {
  const candidateBytes = candidate === null ? null : Buffer.from(candidate, "utf8");
  if (candidateBytes !== null && original.exists && original.bytes.equals(candidateBytes)) {
    const verified = decodeUtf8(await readRegularFile(paths.configPath, "Codex profile"), "Codex profile");
    if (classifyCodexConfig(verified, canonicalOrigin).kind !== expectedKind) {
      throw new Error("Codex managed configuration validation failed.");
    }
    await hostValidator({ configPath: paths.configPath, profileDir: paths.directory });
    return;
  }
  try {
    if (candidateBytes === null) {
      await rm(paths.configPath, { force: true });
    } else {
      await writeCodexConfig(paths.configPath, candidateBytes);
    }
    const current = await snapshot(paths.configPath);
    const kind = current.exists
      ? classifyCodexConfig(decodeUtf8(current.bytes, "Codex profile"), canonicalOrigin).kind
      : "absent";
    if (kind !== expectedKind) {
      throw new Error("Codex managed configuration validation failed.");
    }
    await hostValidator({ configPath: paths.configPath, profileDir: paths.directory });
  } catch (error) {
    try {
      await restoreCodexConfig(paths.configPath, original);
    } catch {
      throw new Error(UNSAFE_CODEX_ROLLBACK_MESSAGE);
    }
    throw error;
  }
}

export async function applyCodexManual({ profileDir, token, canonicalOrigin, hostValidator = validateCodexHostProfile } = {}) {
  assertToken(token);
  if (typeof canonicalOrigin !== "string" || !canonicalOrigin.startsWith("https://")) {
    throw new Error("Codex manual override requires the canonical HTTPS MCP origin.");
  }
  if (typeof hostValidator !== "function") {
    throw new Error("Codex host configuration validation failed.");
  }
  const paths = profileDir === undefined ? resolveCodexPaths() : codexManagedPaths(profileDir);
  const original = await snapshot(paths.configPath);
  const text = original.exists ? decodeUtf8(original.bytes, "Codex profile") : "";
  const classification = classifyCodexConfig(text, canonicalOrigin);
  const candidate = codexCandidateForManual(text, classification, {
    canonicalOrigin,
    token,
    originalWasAbsent: classification.kind === "managed" ? classification.originalWasAbsent : !original.exists,
  });
  await commitCodexConfig(paths, original, candidate, canonicalOrigin, {
    expectedKind: "managed",
    hostValidator,
  });
  return paths;
}

export async function switchCodexOAuth({ profileDir, canonicalOrigin, hostValidator = validateCodexHostProfile } = {}) {
  if (typeof canonicalOrigin !== "string" || !canonicalOrigin.startsWith("https://")) {
    throw new Error("Codex OAuth switch requires the canonical HTTPS MCP origin.");
  }
  if (typeof hostValidator !== "function") {
    throw new Error("Codex host configuration validation failed.");
  }
  const paths = profileDir === undefined ? resolveCodexPaths() : codexManagedPaths(profileDir);
  const original = await snapshot(paths.configPath);
  if (!original.exists) {
    return paths;
  }
  const text = decodeUtf8(original.bytes, "Codex profile");
  const classification = classifyCodexConfig(text, canonicalOrigin);
  if (classification.kind === "absent") {
    return paths;
  }
  if (classification.kind !== "managed") {
    throw new Error("The selected Codex profile contains an unowned Parley MCP configuration. Review or remove that entry, then retry.");
  }
  const candidate = `${text.slice(0, classification.index)}${text.slice(classification.index + classification.bytes.length)}`;
  await commitCodexConfig(paths, original, classification.originalWasAbsent && candidate.length === 0 ? null : candidate, canonicalOrigin, {
    expectedKind: "absent",
    hostValidator,
  });
  return paths;
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
  if (!["claude", "codex"].includes(host) || !["manual", "oauth"].includes(mode)) {
    throw new Error("Usage: managed-config.mjs <claude|codex> <manual|oauth> [--helper-source PATH]");
  }
  const canonicalOrigin = "https://parley.weldra.dev/mcp";
  if (mode === "manual") {
    let token = await readManualToken();
    try {
      if (host === "claude") {
        await applyClaudeManual({ canonicalOrigin, token, helperSourcePath: helperSourceFromArgs(args) });
      } else {
        if (args.length !== 0) {
          throw new Error("Codex manual setup does not accept arguments.");
        }
        await applyCodexManual({ canonicalOrigin, token });
      }
    } finally {
      token = "";
    }
    process.stdout.write(`${host === "claude" ? "Claude" : "Codex"} manual connection configured.\n`);
  } else {
    if (args.length !== 0) {
      throw new Error("OAuth switch does not accept arguments.");
    }
    if (host === "claude") {
      await switchClaudeOAuth({ canonicalOrigin });
    } else {
      await switchCodexOAuth({ canonicalOrigin });
    }
    process.stdout.write(`${host === "claude" ? "Claude" : "Codex"} OAuth connection restored.\n`);
  }
}

function containsUnsafeRollback(error, message) {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.message === message || error.message.endsWith(`; ${message}`)) {
    return true;
  }
  return error instanceof AggregateError && error.errors.some((cause) => containsUnsafeRollback(cause, message));
}

export function publicCliError(error, host = "Claude") {
  if (containsUnsafeRollback(error, UNSAFE_CLAUDE_ROLLBACK_MESSAGE)) {
    return UNSAFE_CLAUDE_ROLLBACK_MESSAGE;
  }
  if (host === "Codex" && containsUnsafeRollback(error, UNSAFE_CODEX_ROLLBACK_MESSAGE)) {
    return UNSAFE_CODEX_ROLLBACK_MESSAGE;
  }
  const message = error instanceof Error ? error.message : "";
  if (
    message === "Manual token input is invalid." ||
    message.startsWith("The selected Claude profile's .claude.json") ||
    message.startsWith("Another Parley Claude configuration change holds .claude-manual-config.lock") ||
    message.startsWith("The selected Claude profile was restored, but .claude-manual-config.lock")
  ) {
    return message;
  }
  return `Parley ${host} configuration could not be updated. No changes were kept.`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const host = process.argv[2] === "codex" ? "Codex" : "Claude";
    process.stderr.write(`${publicCliError(error, host)}\n`);
    process.exitCode = 1;
  });
}
