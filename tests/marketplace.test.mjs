import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildArtifacts } from "../scripts/build.mjs";
import { syncMarketplaceSnapshots } from "../scripts/sync-marketplaces.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function collectFiles(root, prefix = "") {
  const files = new Map();
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [child, bytes] of await collectFiles(path, relative)) files.set(child, bytes);
    } else if (entry.isFile()) {
      files.set(relative, await readFile(path));
    } else {
      throw new Error(`Unsupported marketplace entry: ${relative}`);
    }
  }
  return files;
}

async function assertTreeEquals(actualRoot, expectedRoot) {
  const actual = await collectFiles(actualRoot);
  const expected = await collectFiles(expectedRoot);
  assert.deepEqual([...actual.keys()], [...expected.keys()]);
  for (const [path, bytes] of expected) assert.deepEqual(actual.get(path), bytes, path);
}

test("Codex and Claude catalogs expose one installable Parley package", async () => {
  const packageJson = await readJson(join(repositoryRoot, "package.json"));
  const codex = await readJson(join(repositoryRoot, ".agents", "plugins", "marketplace.json"));
  const claude = await readJson(join(repositoryRoot, ".claude-plugin", "marketplace.json"));

  assert.deepEqual(codex, {
    name: "weldra",
    interface: { displayName: "Weldra" },
    plugins: [{
      name: "parley",
      source: { source: "local", path: "./plugins/parley" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    }],
  });
  assert.equal(claude.name, "weldra");
  assert.equal(claude.version, packageJson.version);
  assert.deepEqual(claude.owner, { name: "Weldra" });
  assert.deepEqual(claude.plugins, [{
    name: "parley",
    description: "OAuth-first Parley coordination for coding agents.",
    version: packageJson.version,
    author: { name: "Weldra" },
    source: "./plugins/claude/parley",
    category: "productivity",
  }]);
});

test("committed marketplace packages are byte-identical to deterministic native artifacts", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "parley-marketplace-artifacts-"));
  try {
    await buildArtifacts({
      version: (await readJson(join(repositoryRoot, "package.json"))).version,
      sourceDir: repositoryRoot,
      outputDir,
    });
    await assertTreeEquals(join(repositoryRoot, "plugins", "parley"), join(outputDir, "codex"));
    await assertTreeEquals(join(repositoryRoot, "plugins", "claude", "parley"), join(outputDir, "claude"));
    await syncMarketplaceSnapshots({ root: repositoryRoot, check: true });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("marketplace synchronization stages on the repository filesystem", async () => {
  const sentinel = new Error("staging factory reached");
  await assert.rejects(
    syncMarketplaceSnapshots({
      root: repositoryRoot,
      check: true,
      stagingDirectoryFactory: async (prefix) => {
        assert.equal(dirname(prefix), repositoryRoot);
        throw sentinel;
      },
    }),
    sentinel,
  );
});

test("README gives one exact native install path per host without claiming availability", async () => {
  const packageJson = await readJson(join(repositoryRoot, "package.json"));
  const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
  assert.match(readme, /codex plugin marketplace add weldra-ai\/parley-plugin/);
  assert.match(readme, /codex plugin add parley@weldra/);
  assert.match(readme, /claude plugin marketplace add weldra-ai\/parley-plugin/);
  assert.match(readme, /claude plugin install parley@weldra/);
  assert.match(readme, /gemini extensions install https:\/\/github\.com\/weldra-ai\/parley-plugin[^\n]+--skip-settings/);
  assert.doesNotMatch(readme, /gemini extensions install[^\n]+--ref[^\n]+--auto-update/);
  assert.deepEqual(
    [...readme.matchAll(/(?:--ref |parley-plugin@)(v\d+\.\d+\.\d+)/g)].map((match) => match[1]),
    Array(3).fill(`v${packageJson.version}`),
  );
  assert.match(readme, /public repository exists/i);
  assert.doesNotMatch(readme, /until `weldra-ai\/parley-plugin` exists publicly/i);
  assert.match(readme, /not yet available/i);
});
