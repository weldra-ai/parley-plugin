import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HOSTS, replaceMaterializedDirectory } from "./build.mjs";

const GEMINI_ALIASES = ["darwin.parley.zip", "linux.parley.zip", "win32.parley.zip"];

function projectRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function stageAsset(root, name, bytes) {
  const path = join(root, name);
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  return path;
}

export async function prepareReleaseAssets({ artifacts, outputDir } = {}) {
  if (!Array.isArray(artifacts) || artifacts.length !== HOSTS.length) {
    throw new Error("Release preparation requires exactly three native artifacts.");
  }
  const byHost = new Map(artifacts.map((artifact) => [artifact.host, artifact]));
  if (byHost.size !== HOSTS.length || HOSTS.some((host) => !byHost.has(host))) {
    throw new Error("Release preparation requires one artifact per native host.");
  }
  const versions = new Set(artifacts.map((artifact) => artifact.version));
  if (versions.size !== 1) {
    throw new Error("Release artifacts must share one version.");
  }

  const destination = resolve(outputDir ?? join(projectRoot(), "release"));
  await mkdir(dirname(destination), { recursive: true });
  const stage = await mkdtemp(join(dirname(destination), ".parley-release-"));
  const releaseNames = [];
  const geminiAliases = [];
  try {
    for (const host of HOSTS) {
      const artifact = byHost.get(host);
      const archive = await readFile(artifact.archivePath);
      const archiveName = basename(artifact.archivePath);
      const digest = hash(archive);
      if (artifact.sha256 !== undefined && artifact.sha256 !== digest) {
        throw new Error(`Release artifact digest changed for ${host}.`);
      }
      await stageAsset(stage, archiveName, archive);
      await stageAsset(stage, `${archiveName}.sha256`, Buffer.from(`${digest}  ${archiveName}\n`));
      releaseNames.push(archiveName, `${archiveName}.sha256`);
    }

    const geminiArchive = await readFile(byHost.get("gemini").archivePath);
    const geminiDigest = hash(geminiArchive);
    for (const alias of GEMINI_ALIASES) {
      await stageAsset(stage, alias, geminiArchive);
      await stageAsset(stage, `${alias}.sha256`, Buffer.from(`${geminiDigest}  ${alias}\n`));
      releaseNames.push(alias, `${alias}.sha256`);
      geminiAliases.push(join(destination, alias));
    }

    await replaceMaterializedDirectory(stage, destination);
    return {
      version: [...versions][0],
      releaseFiles: releaseNames.sort().map((name) => join(destination, name)),
      geminiAliases,
    };
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function main() {
  const root = projectRoot();
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const artifacts = HOSTS.map((host) => ({
    host,
    version: packageJson.version,
    archivePath: join(root, "dist", `parley-${host}-${packageJson.version}.zip`),
  }));
  const result = await prepareReleaseAssets({ artifacts, outputDir: join(root, "release") });
  console.log(`Prepared ${result.releaseFiles.length} release files for ${result.version}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Release preparation failed: ${error.message}`);
    process.exitCode = 1;
  });
}

