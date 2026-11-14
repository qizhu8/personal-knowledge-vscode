import { constants, lstatSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { bundleError, bundlePath, type BundleFile } from "./subscription-bundle-validation.js";

function realRoot(value: string): string {
  const root = resolve(value);
  for (let current = root; ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) bundleError("UNSAFE_STAGE");
    if (current === dirname(current)) return root;
  }
}
/** Exclusively host-owned scratch root; host must prevent concurrent same-user ancestor renames.
 * Node has no openat: this is not an adapter for attacker-controlled filesystem roots.
 */
export async function withBundleStage<T>(
  root: string, files: readonly BundleFile[], signal: AbortSignal,
  consume: (stage: string) => Promise<T>,
): Promise<T> {
  const parent = realRoot(root);
  const stat = lstatSync(parent);
  if ((stat.mode & 0o022) !== 0 || typeof process.getuid === "function" && stat.uid !== process.getuid()) bundleError("UNSAFE_STAGE");
  const stage = join(parent, `.subscription-bundle-${randomBytes(16).toString("hex")}`);
  mkdirSync(stage, { mode: 0o700 });
  try {
    for (const file of files) {
      if (signal.aborted) bundleError("CANCELLED");
      realRoot(stage);
      const components = bundlePath(file.stagePath).split("/");
      let current = stage;
      for (const part of components.slice(0, -1)) {
        current = join(current, part);
        try { mkdirSync(current, { mode: 0o700 }); } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        }
        realRoot(current);
      }
      const fd = openSync(join(current, components.at(-1)!), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content)); fsyncSync(fd); } finally { closeSync(fd); }
    }
    if (signal.aborted) bundleError("CANCELLED");
    return await consume(stage);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
