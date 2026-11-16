import { mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

export function stageRetainedChatRuntime(directory) {
  const project = resolve(import.meta.dirname, "..");
  const extension = join(directory, "retained-extension"), runtime = join(extension, "runtime");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  // Preserve the frozen server's parent-extension admission check with an isolated layout.
  symlinkSync(join(project, "legacy", "dist"), join(extension, "dist"), "dir");
  for (const name of ["dist", "node_modules"])
    symlinkSync(join(project, name), join(runtime, name), "dir");
  return { extension, runtime };
}
