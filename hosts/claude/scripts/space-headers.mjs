import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT_PLACEHOLDER = "${CLAUDE_PROJECT_DIR}";
const GIT_DEADLINE_MS = 8_000;
const PROCESS_CLEANUP_MARGIN_MS = 50;

function realpathOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function selectProjectRoot(projectArg, cwd, helperPath) {
  const pluginRoot = realpathOrNull(resolve(dirname(helperPath), ".."));
  if (pluginRoot === null) {
    return null;
  }
  if (typeof projectArg === "string" && isAbsolute(projectArg) && !projectArg.includes("${")) {
    return realpathOrNull(projectArg);
  }
  if (projectArg !== PROJECT_ROOT_PLACEHOLDER) {
    return null;
  }
  const candidate = realpathOrNull(cwd);
  if (candidate === null || candidate === pluginRoot || candidate.startsWith(`${pluginRoot}${sep}`)) {
    return null;
  }
  return candidate;
}

export function runLocalGit(cwd, args, timeoutMs, {
  command = "git",
  commandArguments = [],
} = {}) {
  return new Promise((resolvePromise) => {
    const stdout = [];
    let settled = false;
    let timedOut = false;
    let child;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ...result, stdout: Buffer.concat(stdout) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child?.kill("SIGKILL");
    }, timeoutMs);
    try {
      child = spawn(command, [...commandArguments, ...args], {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.once("error", () => finish({ code: null }));
      child.once("close", (code) => finish({ code, timedOut }));
    } catch {
      finish({ code: null });
    }
  });
}

function decodeUtf8(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function exactLines(value) {
  if (value === "") {
    return [];
  }
  const normalized = value.replaceAll("\r\n", "\n");
  if (normalized.includes("\r") || !normalized.endsWith("\n")) {
    return null;
  }
  const lines = normalized.slice(0, -1).split("\n");
  return lines.every((line) => line.length > 0) ? lines : null;
}

function remoteNames(value) {
  const lines = exactLines(value);
  if (lines === null) {
    return null;
  }
  if (new Set(lines).size !== lines.length || lines.some((line) => /[\s\x00-\x1f\x7f]/u.test(line))) {
    return null;
  }
  return lines;
}

async function runBeforeDeadline(root, args, { runGit, now, deadline }) {
  const remaining = Math.floor(deadline - now());
  if (remaining <= 0) {
    return null;
  }
  const commandTimeout = Math.max(1, remaining - PROCESS_CLEANUP_MARGIN_MS);
  let timer;
  const timeout = new Promise((resolvePromise) => {
    timer = setTimeout(() => resolvePromise(null), remaining);
  });
  let result;
  try {
    result = await Promise.race([Promise.resolve(runGit(root, args, commandTimeout)), timeout]);
  } finally {
    clearTimeout(timer);
  }
  if (result === null || now() > deadline || result?.code !== 0) {
    return null;
  }
  return decodeUtf8(result.stdout);
}

export async function spaceHeaders(root, {
  deadlineMs = GIT_DEADLINE_MS,
  now = () => performance.now(),
  runGit = runLocalGit,
} = {}) {
  if (typeof root !== "string" || !Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    return {};
  }
  try {
    const deadline = now() + deadlineMs;
    const inWorkTree = await runBeforeDeadline(root, ["rev-parse", "--is-inside-work-tree"], {
      runGit,
      now,
      deadline,
    });
    if (inWorkTree !== "true\n" && inWorkTree !== "true\r\n") {
      return {};
    }
    const remoteOutput = await runBeforeDeadline(root, ["remote"], { runGit, now, deadline });
    const remotes = remoteOutput === null ? null : remoteNames(remoteOutput);
    if (remotes === null) {
      return {};
    }
    if (remotes.length === 0) {
      return { "X-Space": "main" };
    }
    if (!remotes.includes("origin")) {
      return {};
    }
    const originOutput = await runBeforeDeadline(root, ["config", "--get-all", "remote.origin.url"], {
      runGit,
      now,
      deadline,
    });
    const origins = originOutput === null ? null : exactLines(originOutput);
    if (origins === null || origins.length !== 1) {
      return {};
    }
    return { "X-Space": origins[0] };
  } catch {
    return {};
  }
}

async function main() {
  const helperPath = fileURLToPath(import.meta.url);
  const root = selectProjectRoot(process.argv[2], process.cwd(), helperPath);
  const headers = root === null ? {} : await spaceHeaders(root);
  process.stdout.write(`${JSON.stringify(headers)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stdout.write("{}\n");
  });
}
