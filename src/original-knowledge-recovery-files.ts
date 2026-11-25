import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { CoreError } from "./contracts.js";
import {
  originalRecoveryDigest as digest, type OriginalRecoveryEvidence, type originalRecoveryIdentitySchema,
} from "./original-knowledge-recovery-contracts.js";
import type { z } from "zod";
import { sha256 } from "./file-write.js";

export type RecoveryIdentity = z.infer<typeof originalRecoveryIdentitySchema>;
export const recoveryFileIdentity = (s: BigIntStats): RecoveryIdentity => ({
  device: String(s.dev), inode: String(s.ino), uid: String(s.uid), mode: Number(s.mode & 0o777n),
  links: Number(s.nlink), size: Number(s.size), mtime: String(s.mtimeNs), ctime: String(s.ctimeNs),
});
const fail = (): never => { throw new CoreError("RECOVERY_REQUIRED", "Recovery physical custody changed; no unrestricted path was followed."); };
export function sameRecoveryDirectory(a: RecoveryIdentity, b: RecoveryIdentity) {
  return ["device", "inode", "uid", "mode", "links"].every(key => a[key as keyof RecoveryIdentity] === b[key as keyof RecoveryIdentity]);
}
export function withRecoveryDirectory<T>(path: string, work: (fd: number) => T): T {
  if (process.platform !== "linux" || !isAbsolute(path) || resolve(path) !== path || path === "/") fail();
  let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of path.split("/").filter(Boolean)) {
      const next = openSync(`/proc/self/fd/${fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const previous = fd; fd = next; closeSync(previous);
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isDirectory() || stat.mode & 0o002n) fail();
    }
    const stat = fstatSync(fd, { bigint: true });
    if (stat.uid !== BigInt(process.getuid!()) || stat.mode & 0o077n) fail();
    return work(fd);
  } finally { closeSync(fd); }
}
export function withRecoveryParent<T>(root: string, path: string, work: (fd: number, leaf: string) => T): T {
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[\\\0]/.test(part))) fail();
  return withRecoveryDirectory(root, rootFd => {
    let fd = rootFd;
    try {
      for (const part of parts.slice(0, -1)) {
        const next = openSync(`/proc/self/fd/${fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        if (fd !== rootFd) closeSync(fd);
        fd = next;
        const stat = fstatSync(fd, { bigint: true });
        if (!stat.isDirectory() || stat.uid !== BigInt(process.getuid!()) || stat.mode & 0o002n) fail();
      }
      return work(fd, parts.at(-1)!);
    } finally { if (fd !== rootFd) closeSync(fd); }
  });
}
export function readRecoveryFileAt(directoryFd: number, name: string, maximum: number, current: () => void) {
  current();
  const path = `/proc/self/fd/${directoryFd}/${name}`, before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!())
    || before.mode & 0o7002n || before.size > BigInt(maximum)) fail();
  const identity = recoveryFileIdentity(before), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (digest(recoveryFileIdentity(fstatSync(fd, { bigint: true }))) !== digest(identity)) fail();
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < buffer.length) {
      current();
      const count = readSync(fd, buffer, size, buffer.length - size, size);
      if (!count) break;
      size += count;
    }
    current();
    if (size !== Number(before.size) || digest(recoveryFileIdentity(fstatSync(fd, { bigint: true }))) !== digest(identity)
      || digest(recoveryFileIdentity(lstatSync(path, { bigint: true }))) !== digest(identity)) fail();
    return { bytes: Buffer.from(buffer.subarray(0, size)), identity };
  } finally { closeSync(fd); }
}
/** Only callers behind the genuine source/worker capsule may select this external manifest. */
export function readRecoveryEvidence(evidence: OriginalRecoveryEvidence, current: () => void, auditCreated = false) {
  return withRecoveryDirectory(evidence.directory, fd => {
    const directory = recoveryFileIdentity(fstatSync(fd, { bigint: true }));
    if (!(auditCreated ? sameRecoveryDirectory(directory, evidence.directoryIdentity)
      : digest(directory) === digest(evidence.directoryIdentity))) fail();
    const plan = readRecoveryFileAt(fd, "plan.json", 2_097_152, current);
    if (digest(plan.identity) !== digest(evidence.planIdentity) || sha256(plan.bytes) !== evidence.planSha256) fail();
    const row = evidence.files[0]!, blobs = openSync(`/proc/self/fd/${fd}/blobs`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(blobs, { bigint: true });
      if (stat.uid !== BigInt(process.getuid!()) || stat.mode & 0o077n) fail();
      const blob = readRecoveryFileAt(blobs, row.sha256, 16_777_216, current);
      if (digest(blob.identity) !== digest(row.identity) || sha256(blob.bytes) !== row.sha256) fail();
      return { planBytes: plan.bytes, bytes: blob.bytes };
    } finally { closeSync(blobs); }
  });
}
