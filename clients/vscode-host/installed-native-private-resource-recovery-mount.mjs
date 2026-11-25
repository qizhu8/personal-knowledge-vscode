import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import { statfsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

const mounts = new WeakMap(), maximum = 67108864;
function fail(code) { throw Object.assign(new Error(code), { code }); }
async function namespaces() {
  return Object.fromEntries(await Promise.all(["user", "mnt", "net", "pid"].map(async name => [name, await readlink(`/proc/self/ns/${name}`)])));
}
/** Parent supplies its actual pre-unshare namespace witness, not a permission or a model/JSON grant. */
export async function mountInstalledNativePrivateResourceRecoveryParent({ directory, namespaceWitness }) {
  if (process.platform !== "linux" || !isAbsolute(directory ?? "") || resolve(directory) !== directory)
    fail("PRIVATE_RECOVERY_NAMESPACE_REQUIRED");
  const current = await namespaces();
  for (const name of ["user", "mnt", "net", "pid"])
    if (!/^[a-z]+:\[\d+\]$/.test(namespaceWitness?.[name] ?? "") || current[name] === namespaceWitness[name]) fail("PRIVATE_RECOVERY_NAMESPACE_REQUIRED");
  const uidMap = (await readFile("/proc/self/uid_map", "utf8")).trim().split(/\s+/);
  const status = await readFile("/proc/self/status", "utf8"), capability = /^CapEff:\s+([a-f0-9]+)$/m.exec(status)?.[1];
  if (uidMap.length !== 3 || uidMap[2] !== "1" || !capability || !(BigInt(`0x${capability}`) & (1n << 21n)))
    fail("PRIVATE_RECOVERY_NAMESPACE_CAPABILITY_REQUIRED");
  const base = resolve(homedir(), ".local/state/pkm-v5-recovery"), member = relative(base, directory);
  if (!member || member === ".." || member.startsWith(`..${sep}`) || isAbsolute(member)) fail("PRIVATE_RECOVERY_MOUNT_LOCATION_REQUIRED");
  const parent = resolve(directory, ".."), stat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 || await realpath(parent) !== parent)
    fail("PRIVATE_RECOVERY_PRIVATE_PARENT_REQUIRED");
  await mkdir(directory, { mode: 0o700 });
  let mounted = false;
  try {
    execFileSync("mount", ["--make-rprivate", "/"], { stdio: "pipe" });
    execFileSync("mount", ["-t", "tmpfs", "-o", "size=67108864,mode=0700,nosuid,nodev", "tmpfs", directory], { stdio: "pipe" });
    mounted = true;
    const root = await lstat(directory); assert.equal(statfsSync(directory).type, 0x01021994);
    const value = Object.freeze({ kind: "pkm.installed-private-recovery-tmpfs/v1", directory });
    mounts.set(value, { current, root: [root.dev, root.ino, root.uid, root.mode].join(":"), size: maximum, active: true });
    return value;
  } catch (error) {
    if (mounted) execFileSync("umount", [directory], { stdio: "pipe" });
    await rm(directory, { recursive: true, force: true }); throw error;
  }
}
export async function assertInstalledNativePrivateResourceRecoveryMount(value) {
  const state = mounts.get(value);
  if (!state?.active || JSON.stringify(await namespaces()) !== JSON.stringify(state.current)) fail("PRIVATE_RECOVERY_ACTUAL_MOUNT_REQUIRED");
  const root = await lstat(value.directory);
  if ([root.dev, root.ino, root.uid, root.mode].join(":") !== state.root || statfsSync(value.directory).type !== 0x01021994)
    fail("PRIVATE_RECOVERY_MOUNT_IDENTITY_CHANGED");
  return state;
}
/** Physical quota control only; no writes to managed source files, grants or journals. */
export async function resizeInstalledNativePrivateResourceRecoveryMount(value, size) {
  const state = await assertInstalledNativePrivateResourceRecoveryMount(value);
  if (!Number.isSafeInteger(size) || size < 1048576 || size > maximum) fail("PRIVATE_RECOVERY_CAPACITY_LIMIT_REQUIRED");
  execFileSync("mount", ["-t", "tmpfs", "-o", `remount,size=${size},mode=0700,nosuid,nodev`, "tmpfs", value.directory], { stdio: "pipe" });
  state.size = size; await assertInstalledNativePrivateResourceRecoveryMount(value);
  return { size, environmentFaultInjection: true };
}
/** Only after every owner/reader/editor and typed B1/fresh-B0 operation has closed. No lazy/force unmount. */
export async function releaseInstalledNativePrivateResourceRecoveryMount(value) {
  const state = await assertInstalledNativePrivateResourceRecoveryMount(value);
  execFileSync("umount", [value.directory], { stdio: "pipe" }); state.active = false;
  await rm(value.directory, { recursive: true, force: true });
}
