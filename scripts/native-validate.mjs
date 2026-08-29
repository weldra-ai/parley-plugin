import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function projectRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export function nativeValidatorPlan({ outputDir, root = projectRoot() } = {}) {
  return [
    {
      host: "codex",
      command: process.env.PYTHON ?? "python",
      args: [join(root, "tools", "codex-plugin-validator", "validate_plugin.py"), join(outputDir, "codex")],
    },
    {
      host: "claude",
      command: join(root, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
      args: ["plugin", "validate", join(outputDir, "claude"), "--strict"],
    },
    {
      host: "gemini",
      command: process.execPath,
      args: [
        join(root, "node_modules", "@google", "gemini-cli", "bundle", "gemini.js"),
        "extensions",
        "validate",
        join(outputDir, "gemini"),
      ],
    },
  ];
}

async function runCommand({ command, args }) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: projectRoot(), shell: false, stdio: "inherit" });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`validator exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`));
      }
    });
  });
}

export async function runNativeValidators({ outputDir, root, runner = runCommand } = {}) {
  for (const call of nativeValidatorPlan({ outputDir, root })) {
    try {
      await runner(call);
    } catch (error) {
      const title = call.host[0].toUpperCase() + call.host.slice(1);
      if (error?.code === "ENOENT") {
        throw new Error(`${title} native validator unavailable.`);
      }
      throw new Error(`${title} native validator failed.`);
    }
  }
}
