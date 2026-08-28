import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { buildArtifacts } from "../scripts/build.mjs";
import { prepareReleaseAssets } from "../scripts/prepare-release-assets.mjs";

test("Gemini release aliases are platform-selectable copies of the certified artifact", async () => {
  const buildDir = await mkdtemp(join(tmpdir(), "parley-release-build-"));
  const releaseDir = await mkdtemp(join(tmpdir(), "parley-release-assets-"));
  try {
    const artifacts = await buildArtifacts({ version: "0.1.0", outputDir: buildDir });
    const result = await prepareReleaseAssets({ artifacts, outputDir: releaseDir });
    const gemini = artifacts.find((artifact) => artifact.host === "gemini");
    const geminiBytes = await readFile(gemini.archivePath);

    assert.deepEqual(
      result.geminiAliases.map((path) => basename(path)),
      ["darwin.parley.zip", "linux.parley.zip", "win32.parley.zip"],
    );
    for (const path of result.geminiAliases) assert.deepEqual(await readFile(path), geminiBytes);
    assert.equal(result.releaseFiles.length, 12);
  } finally {
    await rm(buildDir, { recursive: true, force: true });
    await rm(releaseDir, { recursive: true, force: true });
  }
});

