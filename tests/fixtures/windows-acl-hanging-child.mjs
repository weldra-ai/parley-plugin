import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [releaseMarker, role] = process.argv.slice(2);

if (role === "release") {
  setTimeout(() => {
    try {
      writeFileSync(releaseMarker, "released\n");
    } catch {
      // The focused regression may fail before its profile fixture is torn down.
    }
  }, 800);
} else {
  const descendant = spawn(process.execPath, [process.argv[1], releaseMarker, "release"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  descendant.unref();
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}
