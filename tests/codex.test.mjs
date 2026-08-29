import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const codexRoot = join(repositoryRoot, "hosts", "codex");
const canonicalOrigin = "https://parley.weldra.dev/mcp";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("Codex native package is OAuth-first with one server and no bundled credential", async () => {
  const manifest = JSON.parse(await readFile(join(codexRoot, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "parley");
  assert.equal(manifest.mcpServers.parley.type, "http");
  assert.equal(manifest.mcpServers.parley.url, canonicalOrigin);
  assert.deepEqual(Object.keys(manifest.mcpServers), ["parley"]);
  assert.equal(Object.hasOwn(manifest.mcpServers.parley, "headers"), false);
  assert.equal(JSON.stringify(manifest.mcpServers.parley).toLowerCase().includes("token"), false);
  assert.equal(await exists(join(codexRoot, "README.md")), true);
  assert.equal(await exists(join(codexRoot, "scripts", "connect-manual.ps1")), true);
  assert.equal(await exists(join(codexRoot, "scripts", "connect-manual.sh")), true);
  assert.equal(await exists(join(codexRoot, "hooks", "hooks.json")), false);
});

test("Codex manual wrappers use hidden terminal input, stdin, and an exact OAuth rollback", async () => {
  const powershell = await readFile(join(codexRoot, "scripts", "connect-manual.ps1"), "utf8");
  const shell = await readFile(join(codexRoot, "scripts", "connect-manual.sh"), "utf8");
  const readme = await readFile(join(codexRoot, "README.md"), "utf8");

  assert.match(powershell, /Read-Host.+AsSecureString/i);
  assert.match(powershell, /RedirectStandardInput/i);
  assert.match(powershell, /Console\]::IsInputRedirected/i);
  assert.doesNotMatch(powershell, /-Token\b/i);
  assert.match(shell, /\[ ! -t 0 \].*\[ ! -t 1 \]/s);
  assert.match(shell, /stty -echo/);
  assert.match(shell, /node "\$manager" codex manual/);
  assert.match(shell, /--oauth/);
  assert.match(readme, /config\.toml/i);
  assert.match(readme, /only.*managed.*manual override/i);
  assert.match(readme, /quiet session-start/i);
  assert.match(readme, /do not guess.*main/i);
});

test("Codex and Gemini compatibility declarations are Windows-only until Task 14", async () => {
  const compatibility = JSON.parse(await readFile(join(repositoryRoot, "compatibility.json"), "utf8"));
  for (const host of ["codex", "gemini"]) {
    assert.deepEqual(compatibility.hosts[host].operatingSystems, ["windows"]);
    assert.match(compatibility.hosts[host].minimumSupport.certification, /Windows/i);
  }
});
