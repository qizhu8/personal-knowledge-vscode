import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const execute = promisify(execFile);

export async function verifyIsolatedManagedGeneration(managedRoot, generation) {
  if (typeof managedRoot !== "string" || !isAbsolute(managedRoot) || resolve(managedRoot) !== managedRoot
      || await fs.realpath(managedRoot) !== managedRoot) throw new Error("An absolute nonlinked isolated root is required");
  const marker = JSON.parse(await fs.readFile(join(managedRoot, ".pkm-isolated-migration"), "utf8"));
  if (marker.schema !== "pkm.isolated-managed-migration/v1") throw new Error("Invalid isolated managed root marker");
  if (typeof generation !== "string" || !/^[a-f0-9-]{36}$/.test(generation)) throw new Error("Invalid isolated generation");
  const manifest = JSON.parse(await fs.readFile(join(managedRoot, "generations", generation, "manifest.json"), "utf8"));
  const launcher = await fs.readFile(join(managedRoot, "launch.py"));
  if (createHash("sha256").update(launcher).digest("hex") !== manifest.launcherSha256)
    throw new Error("Isolated launcher integrity mismatch");
  await execute(manifest.interpreters.python.path, ["-I", "-S", join(managedRoot, "launch.py"), "--verify-generation", generation],
    { timeout: 60_000, maxBuffer: 1024 * 1024 });
  return manifest;
}

export async function isolatedManagedLaunch(managedRoot) {
  const pointer = JSON.parse(await fs.readFile(join(managedRoot, "latest-generation.json"), "utf8"));
  const manifest = await verifyIsolatedManagedGeneration(managedRoot, pointer.generation);
  return { command: manifest.interpreters.python.path, args: ["-I", "-S", join(managedRoot, "launch.py")],
    cwd: managedRoot, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } };
}
