import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArtifacts, readZipEntries } from "../scripts/build.mjs";

const sharedWorkflowPaths = [
  "skills/parley/SKILL.md",
  "hooks/session-reminder.mjs",
  "scripts/managed-config.mjs",
  "commands/connect.md",
  "commands/connect-manual.md",
  "commands/status.md",
  "commands/disconnect.md",
];

test("shared Parley skill has discriminating frontmatter without copied tool schemas", async () => {
  const skill = await readFile("shared/skills/parley/SKILL.md", "utf8");
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);

  assert.ok(frontmatter, "SKILL.md must start with YAML frontmatter");
  assert.match(frontmatter[1], /^name:\s*parley\s*$/m);
  assert.match(frontmatter[1], /^description:\s*Use when\b/m);
  assert.doesNotMatch(skill, /\b(?:inputSchema|outputSchema|properties)\s*:/);
});

test("shared Parley skill retries lower-capability space-aware calls only after SPACE_REQUIRED", async () => {
  const skill = await readFile("shared/skills/parley/SKILL.md", "utf8");

  assert.match(skill, /SPACE_REQUIRED[\s\S]{0,220}side-effect-free/i);
  assert.match(skill, /resolve Git context[\s\S]{0,180}retry that same call[\s\S]{0,120}explicit `space`/i);
  assert.match(skill, /explicit `space`[\s\S]{0,180}(?:rest|remainder) of the session/i);
  assert.match(skill, /literal `main` only after positively proving this repository has no remotes/i);
});

test("build materializes the complete shared workflow into every native artifact", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "parley-plugin-shared-workflow-"));
  try {
    const artifacts = await buildArtifacts({ version: "0.1.0", outputDir });
    for (const artifact of artifacts) {
      const paths = new Set((await readZipEntries(artifact.archivePath)).map((entry) => entry.path));
      for (const sharedPath of sharedWorkflowPaths) {
        assert.ok(paths.has(sharedPath), `${artifact.host} is missing ${sharedPath}`);
      }
      assert.equal(paths.has("hooks/manual-unread.mjs"), false, `${artifact.host} includes an unused credential-bearing hook`);
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("shared command guides carry native command frontmatter", async () => {
  for (const command of ["connect", "connect-manual", "status", "disconnect"]) {
    const guide = await readFile(`shared/commands/${command}.md`, "utf8");
    assert.match(guide, /^---\r?\ndescription:\s*\S[\s\S]*?\r?\n---\r?\n/);
  }
});
