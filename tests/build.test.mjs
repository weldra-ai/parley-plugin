import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename as renameFile,
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
  replaceMaterializedDirectory,
  writeFileAtomically,
} from "../scripts/build.mjs";
import { scanForSecrets } from "../scripts/scan-secrets.mjs";
import { validateArtifacts } from "../scripts/validate.mjs";
import { runNativeValidators } from "../scripts/native-validate.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const canonicalOrigin = "https://parley.weldra.dev/mcp";
const claudeHeadersHelper = "node \"${CLAUDE_PLUGIN_ROOT}/scripts/space-headers.mjs\" \"${CLAUDE_PROJECT_DIR}\"";
const skill = "---\nname: parley\ndescription: Shared Parley workflow seed.\n---\n\nConnect to Parley.\n";
const secretPrefixes = ["pn", "pa", "pr", "pc", "or", "wh", "evk"];
const publicIdentifierPrefixes = ["oc", "ac", "rf"];
const tokenSuffix = "K7nQg4sL2pV8xR5dZ1hM9cT6wB3yF0a";

function prefixedValue(prefix) {
  return `${prefix}_${tokenSuffix}`;
}

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
    settings: [{
      name: "Parley token",
      description: "Recovery-only manual Parley token.",
      envVar: "PARLEY_TOKEN",
      sensitive: true,
    }],
    mcpServers: {
      parley: {
        httpUrl: canonicalOrigin,
        headers: { Authorization: "Bearer ${PARLEY_TOKEN}" },
        oauth: { enabled: true },
      },
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
    mcpServers: {
      parley: {
        type: "http",
        url: canonicalOrigin,
        headersHelper: claudeHeadersHelper,
      },
    },
  });
  await writeJson(join(hosts, "claude", "hooks", "hooks.json"), {
    hooks: {
      SessionStart: [{
        hooks: [{
          type: "command",
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/hooks/session-reminder.mjs"],
          timeout: 3,
        }],
      }],
    },
  });
  await mkdir(join(hosts, "claude", "scripts"), { recursive: true });
  await writeFile(
    join(hosts, "claude", "scripts", "space-headers.mjs"),
    await readFile(join(repositoryRoot, "hosts", "claude", "scripts", "space-headers.mjs")),
  );
  await writeJson(join(hosts, "gemini", "gemini-extension.json"), geminiManifest());
  const skillPath = join(shared, "skills", "parley", "SKILL.md");
  await mkdir(dirname(skillPath), { recursive: true });
  await writeFile(skillPath, skill);
  await mkdir(join(shared, "commands"), { recursive: true });
  await writeFile(join(shared, "commands", "connect.md"), "Connect to Parley.\n");
  await mkdir(join(shared, "hooks"), { recursive: true });
  await writeFile(join(shared, "hooks", "session-reminder.mjs"), "process.exit(0);\n");
  await mkdir(join(shared, "scripts"), { recursive: true });
  await writeFile(join(shared, "scripts", "managed-config.mjs"), "export {};\n");
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
    const manager = await readFile(join(repositoryRoot, "shared", "scripts", "managed-config.mjs"));
    for (const artifact of result) {
      assert.equal(await readZipText(artifact.archivePath, "scripts/managed-config.mjs"), manager.toString("utf8"));
    }
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

test("transactional materialized-root replacement restores the complete prior root after promotion failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "parley-plugin-root-replace-"));
  try {
    const destination = join(root, "codex");
    const staged = join(root, "staged-codex");
    await mkdir(destination, { recursive: true });
    await mkdir(staged, { recursive: true });
    await writeFile(join(destination, "old.txt"), "previous complete root");
    await writeFile(join(staged, "new.txt"), "replacement root");

    await assert.rejects(
      replaceMaterializedDirectory(staged, destination, {
        rename: async (from, to) => {
          if (from === staged && to === destination) {
            throw new Error("simulated promotion interruption");
          }
          await renameFile(from, to);
        },
      }),
      /simulated promotion interruption/,
    );

    assert.equal(await readFile(join(destination, "old.txt"), "utf8"), "previous complete root");
    assert.deepEqual(await readdir(root), ["codex"]);
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

for (const prefix of secretPrefixes) {
  test(`secret scanner catches standalone ${prefix} source tokens without echoing values`, async () => {
    const secret = prefixedValue(prefix);
    await withFixture(async (sourceDir) => {
      await writeFile(join(sourceDir, "capture.log"), secret);
      await assert.rejects(
        scanForSecrets({ root: sourceDir }),
        (error) => {
          assert.doesNotMatch(error.message, new RegExp(secret));
          return /credential/i.test(error.message);
        },
      );
    });
  });

  test(`secret scanner catches standalone ${prefix} archive tokens without echoing values`, async () => {
    const secret = prefixedValue(prefix);
    await withFixture(async (sourceDir) => {
      const skillPath = join(sourceDir, "shared", "skills", "parley", "SKILL.md");
      await writeFile(skillPath, `${skill}\n${secret}\n`);
      const outputDir = join(sourceDir, "dist");
      const [artifact] = await buildArtifacts({ version: "0.1.0", outputDir, sourceDir });
      await assert.rejects(
        scanForSecrets({ root: artifact.archivePath }),
        (error) => {
          assert.doesNotMatch(error.message, new RegExp(secret));
          return /credential/i.test(error.message);
        },
      );
    });
  });
}

for (const prefix of publicIdentifierPrefixes) {
  test(`secret scanner permits public ${prefix} identifiers in source and archives`, async () => {
    const identifier = prefixedValue(prefix);
    await withFixture(async (sourceDir) => {
      await writeFile(join(sourceDir, "identifier.log"), identifier);
      assert.deepEqual(await scanForSecrets({ root: sourceDir }), { scanned: true });
      await rm(join(sourceDir, "identifier.log"));

      const skillPath = join(sourceDir, "shared", "skills", "parley", "SKILL.md");
      await writeFile(skillPath, `${skill}\n${identifier}\n`);
      const outputDir = join(sourceDir, "dist");
      const [artifact] = await buildArtifacts({ version: "0.1.0", outputDir, sourceDir });
      assert.deepEqual(await scanForSecrets({ root: artifact.archivePath }), { scanned: true });
    });
  });
}

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

test("validator rejects a materialized shared-skill byte mismatch", async () => {
  await withFixture(async (sourceDir) => {
    const outputDir = join(sourceDir, "dist");
    await buildArtifacts({ version: "0.1.0", outputDir, sourceDir });
    await writeFile(join(outputDir, "codex", "skills", "parley", "SKILL.md"), "tampered");
    await assert.rejects(
      validateArtifacts({ root: sourceDir, outputDir }),
      /materialized artifact differs/i,
    );
  });
});

test("validator rejects an extra materialized artifact file", async () => {
  await withFixture(async (sourceDir) => {
    const outputDir = join(sourceDir, "dist");
    await buildArtifacts({ version: "0.1.0", outputDir, sourceDir });
    await writeFile(join(outputDir, "claude", "unexpected.txt"), "extra");
    await assert.rejects(
      validateArtifacts({ root: sourceDir, outputDir }),
      /unexpected materialized artifact path/i,
    );
  });
});

test("validator rejects an extra empty materialized artifact directory", async () => {
  await withFixture(async (sourceDir) => {
    const outputDir = join(sourceDir, "dist");
    await buildArtifacts({ version: "0.1.0", outputDir, sourceDir });
    await mkdir(join(outputDir, "codex", "unexpected-directory"));
    await assert.rejects(
      validateArtifacts({ root: sourceDir, outputDir }),
      /unexpected materialized artifact path/i,
    );
  });
});

test("validator rejects a missing materialized artifact file", async () => {
  await withFixture(async (sourceDir) => {
    const outputDir = join(sourceDir, "dist");
    await buildArtifacts({ version: "0.1.0", outputDir, sourceDir });
    await rm(join(outputDir, "gemini", "gemini-extension.json"));
    await assert.rejects(
      validateArtifacts({ root: sourceDir, outputDir }),
      /missing materialized artifact path/i,
    );
  });
});

test("validator rejects a symlinked materialized artifact file", async () => {
  await withFixture(async (sourceDir) => {
    const outputDir = join(sourceDir, "dist");
    await buildArtifacts({ version: "0.1.0", outputDir, sourceDir });
    const skillPath = join(outputDir, "codex", "skills", "parley", "SKILL.md");
    await rm(skillPath);
    await symlink(join(sourceDir, "package.json"), skillPath, "file");
    await assert.rejects(
      validateArtifacts({ root: sourceDir, outputDir }),
      /symlinked materialized artifact/i,
    );
  });
});

test("validator pins compatibility and every host manifest to the trusted MCP origin", async () => {
  await withFixture(async (sourceDir) => {
    const changedOrigin = "https://coordinated-edit.example/mcp";
    const changedCompatibility = compatibility();
    changedCompatibility.canonicalMcpOrigin = changedOrigin;
    await writeJson(join(sourceDir, "compatibility.json"), changedCompatibility);

    const codex = pluginManifest();
    codex.mcpServers.parley.url = changedOrigin;
    await writeJson(join(sourceDir, "hosts", "codex", ".codex-plugin", "plugin.json"), codex);
    await writeJson(join(sourceDir, "hosts", "claude", ".mcp.json"), {
      mcpServers: { parley: { type: "http", url: changedOrigin } },
    });
    const gemini = geminiManifest();
    gemini.mcpServers.parley.httpUrl = changedOrigin;
    await writeJson(join(sourceDir, "hosts", "gemini", "gemini-extension.json"), gemini);

    const outputDir = join(sourceDir, "dist");
    await buildArtifacts({ version: "0.1.0", outputDir, sourceDir });
    await assert.rejects(
      validateArtifacts({ root: sourceDir, outputDir }),
      /trusted MCP origin/i,
    );
  });
});

test("native validation plans the pinned Codex, Claude, and Gemini gates without a skip path", async () => {
  const calls = [];
  await runNativeValidators({
    outputDir: join(repositoryRoot, "dist"),
    runner: async (call) => {
      calls.push(call);
    },
  });
  assert.deepEqual(calls.map((call) => call.host), ["codex", "claude", "gemini"]);
  assert.match(calls[0].args.join(" "), /tools[\\/]codex-plugin-validator[\\/]validate_plugin\.py/);
  assert.equal(calls[1].command, join(repositoryRoot, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
  assert.deepEqual(calls[1].args, ["plugin", "validate", join(repositoryRoot, "dist", "claude"), "--strict"]);
  assert.equal(calls[2].command, process.execPath);
  assert.deepEqual(calls[2].args, [join(repositoryRoot, "node_modules", "@google", "gemini-cli", "bundle", "gemini.js"), "extensions", "validate", join(repositoryRoot, "dist", "gemini")]);
});

test("native validation fails explicitly when a required host validator is unavailable", async () => {
  await assert.rejects(
    runNativeValidators({
      outputDir: join(repositoryRoot, "dist"),
      runner: async (call) => {
        if (call.host === "gemini") {
          const error = new Error("command not found");
          error.code = "ENOENT";
          throw error;
        }
      },
    }),
    /Gemini native validator unavailable/i,
  );
});

test("CI installs pinned native validators before pnpm validate", async () => {
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const ci = await readFile(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8");
  const pnpmWorkspace = await readFile(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
  const validatorGate = await readFile(join(repositoryRoot, "scripts", "validate.mjs"), "utf8");
  assert.equal(packageJson.devDependencies["@anthropic-ai/claude-code"], "2.1.237");
  assert.equal(packageJson.devDependencies["@google/gemini-cli"], "0.56.0");
  assert.match(ci, /actions\/setup-python@[0-9a-f]{40} # v5/);
  assert.match(ci, /python -m pip install --disable-pip-version-check -r tools\/codex-plugin-validator\/requirements\.txt/);
  assert.match(ci, /pnpm validate/);
  assert.match(validatorGate, /await runNativeValidators\(\{ outputDir: join\(projectRoot\(\), "dist"\) \}\)/);
  assert.match(validatorGate, /await syncMarketplaceSnapshots\(\{ root: projectRoot\(\), check: true \}\)/);
  assert.match(pnpmWorkspace, /'@anthropic-ai\/claude-code': true/);
  assert.match(pnpmWorkspace, /'@github\/keytar': false/);
  assert.match(pnpmWorkspace, /node-pty: false/);
});

test("workflows do not ask setup-node to cache pnpm before Corepack installs it", async () => {
  for (const workflowName of ["ci.yml", "release.yml"]) {
    const workflow = await readFile(join(repositoryRoot, ".github", "workflows", workflowName), "utf8");
    const lines = workflow.split(/\r?\n/);
    const start = lines.findIndex((line) => line.includes("uses: actions/setup-node@"));
    assert.notEqual(start, -1, `${workflowName} must configure Node`);
    const indentation = lines[start].match(/^\s*/)[0];
    const end = lines.findIndex((line, index) => index > start && line.startsWith(`${indentation}- `));
    const setupNodeStep = lines.slice(start, end === -1 ? undefined : end).join("\n");
    assert.doesNotMatch(setupNodeStep, /^\s+cache:\s*pnpm\s*$/m, workflowName);
  }
});

test("release imports and constrains the configured signer before verifying the exact tag", async () => {
  const release = await readFile(join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");
  const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");

  assert.match(release, /PARLEY_RELEASE_SIGNER_PUBLIC_KEY:\s*\$\{\{ vars\.PARLEY_RELEASE_SIGNER_PUBLIC_KEY \}\}/);
  assert.match(release, /PARLEY_RELEASE_SIGNER_FINGERPRINT:\s*\$\{\{ vars\.PARLEY_RELEASE_SIGNER_FINGERPRINT \}\}/);
  assert.match(release, /GNUPGHOME="\$\(mktemp -d\)"/);
  assert.match(release, /gpg --batch --homedir "\$\{GNUPGHOME\}" --import/);
  assert.match(release, /--with-colons --fingerprint/);
  assert.match(release, /tr -d '\[:space:\]' \| tr '\[:lower:\]' '\[:upper:\]'/);
  assert.match(release, /\^\(\[A-F0-9\]\{40\}\|\[A-F0-9\]\{64\}\)\$/);
  assert.match(release, /actual_fingerprints="\$\(gpg --batch --homedir "\$\{GNUPGHOME\}" --with-colons --fingerprint --list-keys/);
  assert.match(release, /actual_fingerprint_count="\$\(printf '%s\\n' "\$\{actual_fingerprints\}" \| sed '\/\^\$\/d' \| wc -l \| tr -d '\[:space:\]'\)"/);
  assert.match(release, /test "\$\{actual_fingerprint_count\}" = "1"/);
  assert.match(release, /actual_fingerprint="\$\{actual_fingerprints\}"/);
  assert.match(release, /test "\$\{expected_fingerprint\}" = "\$\{actual_fingerprint\}"/);
  assert.match(release, /git verify-tag "\$\{tag\}"/);
  assert.ok(release.indexOf('test "${actual_fingerprint_count}" = "1"') < release.indexOf('git verify-tag "${tag}"'));
  assert.match(readme, /PARLEY_RELEASE_SIGNER_PUBLIC_KEY/);
  assert.match(readme, /PARLEY_RELEASE_SIGNER_FINGERPRINT/);
});

test("release rejects private-key material in the configured public signer variable before tag verification", async () => {
  const release = await readFile(join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");
  const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");

  assert.match(release, /--with-colons --list-secret-keys/);
  assert.match(release, /\$1 == "sec" \|\| \$1 == "ssb"/);
  assert.match(release, /Configured signer public key must not contain private-key material/);
  assert.ok(release.indexOf('--import >/dev/null') < release.indexOf('--list-secret-keys'));
  assert.ok(release.indexOf('--list-secret-keys') < release.indexOf('actual_fingerprints'));
  assert.ok(release.indexOf('--list-secret-keys') < release.indexOf('git verify-tag "${tag}"'));
  assert.match(readme, /must not contain private-key material/i);
});

test("release publishes certified archives plus platform-selectable Gemini aliases", async () => {
  const release = await readFile(join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");
  assert.match(release, /pnpm prepare-release/);
  assert.match(release, /gh release create "\$\{GITHUB_REF_NAME\}" release\/\*/);
  assert.doesNotMatch(release, /gh release create[^\n]+dist\/\*/);
});

test("CI and release pin every required GitHub Action to the resolved immutable commit", async () => {
  const expectedPins = new Map([
    ["actions/checkout", { sha: "11d5960a326750d5838078e36cf38b85af677262", version: "v4" }],
    ["actions/setup-node", { sha: "49933ea5288caeca8642d1e84afbd3f7d6820020", version: "v4" }],
    ["actions/setup-python", { sha: "a26af69be951a213d495a4c3e4e4022e16d87065", version: "v5" }],
  ]);

  for (const workflowName of ["ci.yml", "release.yml"]) {
    const workflow = await readFile(join(repositoryRoot, ".github", "workflows", workflowName), "utf8");
    const actionUses = [...workflow.matchAll(/^\s*- uses:\s+(actions\/[^@\s]+)@([^\s#]+)(?:\s+#\s*([^\r\n]+))?$/gm)];
    assert.deepEqual(actionUses.map((match) => match[1]).sort(), [...expectedPins.keys()].sort());

    for (const [, action, ref, comment] of actionUses) {
      assert.match(ref, /^[0-9a-f]{40}$/);
      assert.equal(ref, expectedPins.get(action).sha);
      assert.equal(comment, expectedPins.get(action).version);
    }
  }
});
