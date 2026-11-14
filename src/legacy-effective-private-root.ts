import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface LegacyPrivateRootGuard {
  device: string;
  inode: string;
  uid: string;
  mode: number;
  ancestors?: Array<{ path: string; device: string; inode: string; uid: string; mode: number }>;
  containers?: Array<{ path: ".pkm" | ".pkm/state"; device: string; inode: string; mode: number; ctimeNs: string }>;
}

/** A private ancestor protects legacy shared modes from other Unix users, not other processes of this user. */
export function legacyPrivateRootGuard(root: string): LegacyPrivateRootGuard | undefined {
  if (process.platform !== "linux" || process.getuid === undefined
    || resolve(root) !== root || realpathSync(root) !== root) return undefined;
  const stat = lstatSync(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid())
    || (stat.mode & 0o7002n) !== 0n) return undefined;
  const guard: LegacyPrivateRootGuard = {
    device: String(stat.dev), inode: String(stat.ino), uid: String(stat.uid), mode: Number(stat.mode & 0o777n),
  };
  if ((stat.mode & 0o077n) === 0n) return guard;
  const ancestors: NonNullable<LegacyPrivateRootGuard["ancestors"]> = [];
  let current = dirname(root);
  while (ancestors.length < 64) {
    const ancestor = lstatSync(current, { bigint: true });
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink() || ancestor.uid !== BigInt(process.getuid())
      || (ancestor.mode & 0o7002n) !== 0n) return undefined;
    ancestors.push({ path: current, device: String(ancestor.dev), inode: String(ancestor.ino),
      uid: String(ancestor.uid), mode: Number(ancestor.mode & 0o777n) });
    if ((ancestor.mode & 0o077n) === 0n) return { ...guard, ancestors };
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

export function sameLegacyPrivateRoot(root: string, guard: LegacyPrivateRootGuard): boolean {
  const actual = legacyPrivateRootGuard(root);
  if (!actual || actual.device !== guard.device || actual.inode !== guard.inode
    || actual.uid !== guard.uid || actual.mode !== guard.mode
    || JSON.stringify(actual.ancestors) !== JSON.stringify(guard.ancestors)) return false;
  return !guard.containers || guard.containers.every(entry => {
    const stat = lstatSync(join(root, entry.path), { bigint: true, throwIfNoEntry: false });
    return !!stat && stat.isDirectory() && !stat.isSymbolicLink() && String(stat.dev) === entry.device
      && String(stat.ino) === entry.inode && Number(stat.mode & 0o777n) === entry.mode
      && String(stat.ctimeNs) === entry.ctimeNs;
  });
}

export function legacyPathHasNoSymlinks(root: string, relative: string): boolean {
  if (!relative || relative.startsWith("/") || relative.split("/").some(part => !part || part === "." || part === "..")) return false;
  let current = root;
  for (const part of relative.split("/")) {
    current = join(current, part);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink() !== false) return false;
  }
  return true;
}
