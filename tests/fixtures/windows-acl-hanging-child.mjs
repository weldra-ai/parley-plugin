import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [releaseMarker, role] = process.argv.slice(2);

if (role === "release") {
  setTimeout(() => {
    writeFileSync(releaseMarker, "released\n");
  }, 175);
} else {
  spawn(process.execPath, [process.argv[1], releaseMarker, "release"], {
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}
