import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

// The frozen runtime snapshot is newer than these historical capture pins.
const collaborationSourceRevision = "371fcf85b36b6b1cc9c8022bd10e3a6ae4dd8088";

export function readCollaborationCaptureSource(source) {
  return execFileSync("git", ["show", `${collaborationSourceRevision}:${source}`], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
