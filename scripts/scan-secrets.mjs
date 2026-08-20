import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readZipFiles } from "./build.mjs";

const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);
const PLACEHOLDERS = new Set([
  "pn_EXAMPLE_TOKEN",
  "pn_PLACEHOLDER_TOKEN",
  "pn_REDACTED_TOKEN",
]);
const SECRET_PREFIXES = ["pn", "pa", "pr", "pc", "or", "wh", "evk"];
const PREFIXED_TOKEN_PATTERN = new RegExp(`\\b(?:${SECRET_PREFIXES.join("|")})_[A-Za-z0-9_-]+\\b`, "g");

function projectRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function entropy(value) {
  const counts = new Map();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function isAllowedPlaceholder(value) {
  return PLACEHOLDERS.has(value);
}

function containsCredentialMaterial(text) {
  for (const match of text.matchAll(PREFIXED_TOKEN_PATTERN)) {
    if (!isAllowedPlaceholder(match[0])) {
      return true;
    }
  }

  const namedCode = /\b(?:authorization[_ -]?code|oauth[_ -]?code)\b\s*[=:]\s*["']?([A-Za-z0-9_-]{20,})/gi;
  for (const match of text.matchAll(namedCode)) {
    if (!isAllowedPlaceholder(match[1])) {
      return true;
    }
  }

  const bearerAssignment = /\b(?:authorization|bearer[_ -]?token|access[_ -]?token)\b\s*[=:]\s*["']?(?:Bearer\s+)?([A-Za-z0-9._~+/=-]{20,})/gi;
  for (const match of text.matchAll(bearerAssignment)) {
    if (!isAllowedPlaceholder(match[1]) && entropy(match[1]) >= 3.5) {
      return true;
    }
  }
  return false;
}

async function collectFiles(root) {
  const stat = await lstat(root);
  if (stat.isSymbolicLink()) {
    throw new Error("Secret scan refused a symlinked input.");
  }
  if (stat.isFile()) {
    return [root];
  }
  if (!stat.isDirectory()) {
    throw new Error("Secret scan found an unsupported input type.");
  }
  const files = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const candidate = join(directory, entry.name);
      const candidateStat = await lstat(candidate);
      if (candidateStat.isSymbolicLink()) {
        throw new Error("Secret scan refused a symlinked input.");
      }
      if (candidateStat.isDirectory()) {
        await visit(candidate);
      } else if (candidateStat.isFile()) {
        files.push(candidate);
      } else {
        throw new Error("Secret scan found an unsupported input type.");
      }
    }
  };
  await visit(root);
  return files;
}

export class SecretScanError extends Error {
  constructor(count) {
    super(`Potential credential material was detected in ${count} input(s).`);
    this.name = "SecretScanError";
  }
}

export async function scanForSecrets({ root = projectRoot() } = {}) {
  const findings = [];
  for (const path of await collectFiles(resolve(root))) {
    if (extname(path).toLowerCase() === ".zip") {
      let entries;
      try {
        entries = await readZipFiles(path);
      } catch {
        throw new Error("Secret scan could not inspect an artifact archive.");
      }
      for (const entry of entries) {
        if (containsCredentialMaterial(entry.data.toString("utf8"))) {
          findings.push(path);
          break;
        }
      }
    } else if (containsCredentialMaterial((await readFile(path)).toString("utf8"))) {
      findings.push(path);
    }
  }
  if (findings.length > 0) {
    throw new SecretScanError(findings.length);
  }
  return { scanned: true };
}

async function main() {
  await scanForSecrets();
  console.log("Secret scan passed.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof SecretScanError ? error.message : "Secret scan failed closed.");
    process.exitCode = 1;
  });
}
