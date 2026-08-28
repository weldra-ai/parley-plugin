import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildArtifacts,
  replaceMaterializedDirectory,
  writeFileAtomically,
} from "./build.mjs";

function projectRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function catalogs(version) {
  return {
    codex: {
      name: "weldra",
      interface: { displayName: "Weldra" },
      plugins: [{
        name: "parley",
        source: { source: "local", path: "./plugins/parley" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      }],
    },
    claude: {
      $schema: "https://json.schemastore.org/claude-code-marketplace.json",
      name: "weldra",
      version,
      description: "Weldra plugins for agent coordination.",
      owner: { name: "Weldra" },
      plugins: [{
        name: "parley",
        description: "OAuth-first Parley coordination for coding agents.",
        version,
        author: { name: "Weldra" },
        source: "./plugins/claude/parley",
        category: "productivity",
      }],
    },
  };
}

async function collectTree(root, prefix = "") {
  const stat = await lstat(root).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Marketplace snapshot root is missing or unsafe: ${root}`);
  }
  const files = new Map();
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(root, entry.name);
    const childStat = await lstat(path);
    if (childStat.isSymbolicLink()) {
      throw new Error(`Symlinked marketplace snapshot entry is not permitted: ${relative}`);
    }
    if (childStat.isDirectory()) {
      for (const [child, bytes] of await collectTree(path, relative)) files.set(child, bytes);
    } else if (childStat.isFile()) {
      files.set(relative, await readFile(path));
    } else {
      throw new Error(`Unsupported marketplace snapshot entry: ${relative}`);
    }
  }
  return files;
}

async function assertFile(path, expected) {
  const actual = await readFile(path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (actual === null || !actual.equals(expected)) {
    throw new Error(`Marketplace catalog is stale: ${path}`);
  }
}

async function assertTree(actualRoot, expectedRoot) {
  const actual = await collectTree(actualRoot);
  const expected = await collectTree(expectedRoot);
  if (
    actual.size !== expected.size ||
    [...expected].some(([path, bytes]) => !actual.get(path)?.equals(bytes))
  ) {
    throw new Error(`Marketplace package is stale: ${actualRoot}`);
  }
}

export async function syncMarketplaceSnapshots({
  root = projectRoot(),
  check = false,
} = {}) {
  const absoluteRoot = resolve(root);
  const packageJson = JSON.parse(await readFile(join(absoluteRoot, "package.json"), "utf8"));
  const expectedCatalogs = catalogs(packageJson.version);
  const stagingRoot = await mkdtemp(join(tmpdir(), "parley-marketplace-sync-"));
  try {
    await buildArtifacts({
      version: packageJson.version,
      sourceDir: absoluteRoot,
      outputDir: stagingRoot,
    });

    const codexCatalogPath = join(absoluteRoot, ".agents", "plugins", "marketplace.json");
    const claudeCatalogPath = join(absoluteRoot, ".claude-plugin", "marketplace.json");
    const codexPluginPath = join(absoluteRoot, "plugins", "parley");
    const claudePluginPath = join(absoluteRoot, "plugins", "claude", "parley");

    if (check) {
      await assertFile(codexCatalogPath, jsonBytes(expectedCatalogs.codex));
      await assertFile(claudeCatalogPath, jsonBytes(expectedCatalogs.claude));
      await assertTree(codexPluginPath, join(stagingRoot, "codex"));
      await assertTree(claudePluginPath, join(stagingRoot, "claude"));
    } else {
      await replaceMaterializedDirectory(join(stagingRoot, "codex"), codexPluginPath);
      await replaceMaterializedDirectory(join(stagingRoot, "claude"), claudePluginPath);
      await writeFileAtomically(codexCatalogPath, jsonBytes(expectedCatalogs.codex));
      await writeFileAtomically(claudeCatalogPath, jsonBytes(expectedCatalogs.claude));
    }

    return {
      version: packageJson.version,
      codexCatalogPath,
      claudeCatalogPath,
      codexPluginPath,
      claudePluginPath,
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) {
    throw new Error("Usage: node scripts/sync-marketplaces.mjs [--check]");
  }
  const check = args.includes("--check");
  const result = await syncMarketplaceSnapshots({ check });
  console.log(`${check ? "Verified" : "Synchronized"} marketplace snapshots for ${result.version}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Marketplace synchronization failed: ${error.message}`);
    process.exitCode = 1;
  });
}

