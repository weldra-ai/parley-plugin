import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildArtifacts,
  readZipEntries,
  readZipText,
  writeFileAtomically,
} from "../scripts/build.mjs";
import { scanForSecrets } from "../scripts/scan-secrets.mjs";
import { validateArtifacts } from "../scripts/validate.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const canonicalOrigin = "https://parley.weldra.dev/mcp";
const skill = "---\nname: parley\ndescription: Shared Parley workflow seed.\n---\n\nConnect to Parley.\n";

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function pluginManifest() {
  return {
    name: "parley",
    version: "0.1.0",
    description: "Parley coordination for coding agents.",
    author: { name: "Weldra" },
    skills: "./skills/",
    mcpServers: {
      parley: { type: "http", url: canonicalOrigin },
    },
    interface: {
      displayName: "Parley",
      shortDescription: "Coordinate coding agents.",
      longDescription: "Use Parley to coordinate coding agents.",
      developerName: "Weldra",
      category: "Productivity",
      capabilities: [],
      defaultPrompt: "Connect this agent to Parley.",
    },
  };
}

function claudeManifest() {
  return {
    name: "parley",
    version: "0.1.0",
    description: "Parley coordination for coding agents.",
    author: { name: "Weldra" },
  };
}

function geminiManifest() {
  return {
    name: "parley",
    version: "0.1.0",
    description: "Parley coordination for coding agents.",
    mcpServers: {
      parley: { httpUrl: canonicalOrigin },
    },
  };
}

function compatibility() {
  const host = {
    testedVersions: [],
    operatingSystems: ["windows", "macos", "linux"],
    authModes: ["oauth"],
    minimumSupport: {
      minimumVersion: null,
      enforcedBy: "omitting/disabling capability",
      capability: "host-specific lifecycle automation",
      certification: "pending",
    },
  };
  return {
    schemaVersion: 1,
    canonicalMcpOrigin: canonicalOrigin,
    lifecycleMode: "oauth",
    hosts: { codex: host, claude: host, gemini: host },
  };
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "parley-plugin-source-"));
  const hosts = join(root, "hosts");
  const shared = join(root, "shared");
  await writeJson(join(root, "package.json"), { version: "0.1.0" });
  await writeJson(join(root, "compatibility.json"), compatibility());
  await writeJson(join(hosts, "codex", ".codex-plugin", "plugin.json"), pluginManifest());
  await writeJson(join(hosts, "claude", ".claude-plugin", "plugin.json"), claudeManifest());
  await writeJson(join(hosts, "claude", ".mcp.json"), {
    mcpServers: { parley: { type: "http", url: canonicalOrigin } },
  });
  await writeJson(join(hosts, "gemini", "gemini-extension.json"), geminiManifest());
  const skillPath = join(shared, "skills", "parley", "SKILL.md");
  await mkdir(dirname(skillPath), { recursive: true });
  await writeFile(skillPath, skill);
  return root;
}

async function withFixture(run) {
  const root = await makeFixture();
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("all native artifacts share one version and byte-identical skill", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "parley-plugin-build-"));
  try {
    const result = await buildArtifacts({ version: "0.1.0", outputDir });
    assert.deepEqual(
      result.map((artifact) => artifact.version),
      ["0.1.0", "0.1.0", "0.1.0"],
    );
    assert.equal(result[0].skillSha256, result[1].skillSha256);
    assert.equal(result[1].skillSha256, result[2].skillSha256);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("build produces byte-identical sorted archives with fixed timestamps", async () => {
  await withFixture(async (sourceDir) => {
    const firstOutput = join(sourceDir, "first");
    const secondOutput = join(sourceDir, "second");
    const first = await buildArtifacts({
      version: "0.1.0",
      outputDir: firstOutput,
      sourceDir,
      sourceDateEpoch: "1700000000",
    });
    const second = await buildArtifacts({
      version: "0.1.0",
      outputDir: secondOutput,
      sourceDir,
      sourceDateEpoch: "1700000000",
    });

    for (let index = 0; index < first.length; index += 1) {
      assert.equal(first[index].sha256, second[index].sha256);
      assert.deepEqual(
        await readFile(first[index].archivePath),
        await readFile(second[index].archivePath),
      );
      const entries = await readZipEntries(first[index].archivePath);
      assert.deepEqual(
        entries.map((entry) => entry.path),
        [...entries.map((entry) => entry.path)].sort(),
      );
      assert.ok(entries.every((entry) => entry.timestamp === 1700000000));
    }
  });
});

test("build stages the shared skill into every native artifact without mutating source", async () => {
  await withFixture(async (sourceDir) => {
    const manifestPath = join(sourceDir, "hosts", "codex", ".codex-plugin", "plugin.json");
    const sourceManifest = await readFile(manifestPath, "utf8");
    const outputDir = join(sourceDir, "dist");
    const artifacts = await buildArtifacts({ version: "0.1.0", outputDir, sourceDir });

    for (const artifact of artifacts) {
      assert.equal(await readZipText(artifact.archivePath, "skills/parley/SKILL.md"), skill);
    }
    assert.equal(await readFile(manifestPath, "utf8"), sourceManifest);
  });
});

test("build rejects declared shared traversal before reading host files", async () => {
  await assert.rejects(
    buildArtifacts({
      version: "0.1.0",
      outputDir: join(tmpdir(), "parley-plugin-unused"),
      sourceDir: repositoryRoot,
      sharedPaths: ["../outside"],
    }),
    /traversal/i,
  );
});

test("build rejects symlinked source files", async () => {
  await withFixture(async (sourceDir) => {
    const linkPath = join(sourceDir, "shared", "skills", "parley", "linked.md");
    await symlink(join(sourceDir, "package.json"), linkPath, "file");
    await assert.rejects(
      buildArtifacts({ version: "0.1.0", outputDir: join(sourceDir, "dist"), sourceDir }),
      /symlink/i,
    );
  });
});

test("build rejects colliding host and shared target paths", async () => {
  await withFixture(async (sourceDir) => {
    const collision = join(sourceDir, "hosts", "codex", "skills", "parley", "SKILL.md");
    await mkdir(dirname(collision), { recursive: true });
    await writeFile(collision, skill);
    await assert.rejects(
      buildArtifacts({ version: "0.1.0", outputDir: join(sourceDir, "dist"), sourceDir }),
      /duplicate/i,
    );
  });
});

test("build rejects any host manifest that disagrees with the package version", async () => {
  await withFixture(async (sourceDir) => {
    const path = join(sourceDir, "hosts", "gemini", "gemini-extension.json");
    const manifest = geminiManifest();
    manifest.version = "0.0.9";
    await writeJson(path, manifest);
    await assert.rejects(
      buildArtifacts({ version: "0.1.0", outputDir: join(sourceDir, "dist"), sourceDir }),
      /version disagreement/i,
    );
  });
});

test("atomic artifact writes preserve a prior file and clean temporary output on rename failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "parley-plugin-atomic-"));
  try {
    const target = join(root, "artifact.zip");
    await writeFile(target, "previous");
    await assert.rejects(
      writeFileAtomically(target, Buffer.from("replacement"), {
        rename: async () => {
          throw new Error("simulated rename interruption");
        },
      }),
      /simulated rename interruption/,
    );
    assert.equal(await readFile(target, "utf8"), "previous");
    assert.deepEqual(await readdir(root), ["artifact.zip"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secret scanning fails closed for source and archive credential material without echoing it", async () => {
  const secret = ["pn", "K7nQg4sL2pV8xR5dZ1hM9cT6wB3yF0a"].join("_");
  await withFixture(async (sourceDir) => {
    await writeFile(join(sourceDir, "capture.log"), secret);
    await assert.rejects(
      scanForSecrets({ root: sourceDir }),
      (error) => {
        assert.doesNotMatch(error.message, new RegExp(secret));
        return /credential/i.test(error.message);
      },
    );
    await rm(join(sourceDir, "capture.log"));

    const skillPath = join(sourceDir, "shared", "skills", "parley", "SKILL.md");
    await writeFile(skillPath, `${skill}${secret}`);
    await buildArtifacts({ version: "0.1.0", outputDir: join(sourceDir, "dist"), sourceDir });
    await writeFile(skillPath, skill);
    await assert.rejects(
      scanForSecrets({ root: sourceDir }),
      (error) => {
        assert.doesNotMatch(error.message, new RegExp(secret));
        return /credential/i.test(error.message);
      },
    );
  });
});

test("validator rejects artifacts that expose more than one logical Parley server", async () => {
  await withFixture(async (sourceDir) => {
    const manifest = pluginManifest();
    manifest.mcpServers.extra = { type: "http", url: canonicalOrigin };
    await writeJson(join(sourceDir, "hosts", "codex", ".codex-plugin", "plugin.json"), manifest);
    const outputDir = join(sourceDir, "dist");
    await buildArtifacts({ version: "0.1.0", outputDir, sourceDir });
    await assert.rejects(
      validateArtifacts({ root: sourceDir, outputDir }),
      /exactly one logical parley server/i,
    );
  });
});

test("validator rejects a Claude artifact without native author metadata", async () => {
  await withFixture(async (sourceDir) => {
    const manifest = claudeManifest();
    delete manifest.author;
    await writeJson(join(sourceDir, "hosts", "claude", ".claude-plugin", "plugin.json"), manifest);
    const outputDir = join(sourceDir, "dist");
    await buildArtifacts({ version: "0.1.0", outputDir, sourceDir });
    await assert.rejects(
      validateArtifacts({ root: sourceDir, outputDir }),
      /Claude native manifest is invalid/i,
    );
  });
});
