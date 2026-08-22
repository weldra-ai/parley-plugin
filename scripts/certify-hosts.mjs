#!/usr/bin/env node
/**
 * Create unsigned, local-only native-artifact evidence for a later release report.
 *
 * This command validates built archives and native manifests. It never starts a host
 * profile, OAuth flow, remote connection, deployment, signature, publication, or
 * beta test, so its output is deliberately not a release certification report.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOSTS } from "./build.mjs";
import { runNativeValidators } from "./native-validate.mjs";
import { scanForSecrets } from "./scan-secrets.mjs";
import { validateArtifacts } from "./validate.mjs";

const GIT_SHA = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function projectRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!new Set(["--backend-sha", "--plugin-tag", "--output", "--artifact-dir"]).has(argument)) {
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

async function artifactInventory({ root, artifactDir, version }) {
  const artifacts = [];
  for (const host of [...HOSTS].sort()) {
    const filename = `parley-${host}-${version}.zip`;
    artifacts.push({ host, sha256: sha256(await readFile(join(artifactDir, filename))) });
  }
  return artifacts;
}

export async function createLocalArtifactInventory({ backendSha, pluginTag, outputPath, root = projectRoot(),
  artifactDir = join(root, "dist") }) {
  if (GIT_SHA.test(backendSha) === false) {
    throw new Error("backend SHA is invalid");
  }
  const validation = await validateArtifacts({ root, outputDir: artifactDir });
  if (VERSION.test(validation.version) === false || pluginTag !== `v${validation.version}`) {
    throw new Error("plugin tag does not match the built version");
  }
  await scanForSecrets({ root });
  await runNativeValidators({ root, outputDir: artifactDir });

  const inventory = {
    schema_version: 1,
    report_kind: "local_artifact_inventory",
    signed: false,
    backend_git_sha: backendSha,
    plugin: {
      tag: pluginTag,
      version: validation.version,
      artifacts: await artifactInventory({ root, artifactDir, version: validation.version }),
    },
    local_artifact_gates: {
      plugin_validate: true,
      plugin_secret_scan: true,
      native_validators: true,
    },
  };
  await writeFile(outputPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  return inventory;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const root = projectRoot();
    await createLocalArtifactInventory({
      backendSha: options["--backend-sha"],
      pluginTag: options["--plugin-tag"],
      outputPath: resolve(options["--output"]),
      root,
      artifactDir: resolve(options["--artifact-dir"] ?? join(root, "dist")),
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
