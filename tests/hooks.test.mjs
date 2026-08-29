import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const sessionReminderPath = fileURLToPath(
  new URL("../shared/hooks/session-reminder.mjs", import.meta.url),
);

test("OAuth session reminder emits one credential-free line", async () => {
  const source = await readFile(sessionReminderPath, "utf8");
  assert.equal(
    source,
    'process.stdout.write("Parley is connected. Check the Parley inbox before starting work.\\n");\n',
  );
  assert.doesNotMatch(source, /fetch|Authorization|PARLEY_TOKEN|CLAUDE_PLUGIN_OPTION/i);
});
