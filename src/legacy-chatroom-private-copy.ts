import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { inspectLegacyChatroomArchive } from "./legacy-chatroom-continuation.js";
import type { Storage } from "./storage.js";

function overlaps(left: string, right: string): boolean {
  const inside = (a: string, b: string) => {
    const part = relative(a, b);
    return !part || part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
  };
  return inside(left, right) || inside(right, left);
}

/** Explicit disposable-copy import; never operates on the legacy live root. */
export function copyPrivateRoomArchive(storage: Storage, source: string, legacyRoot: string, roomId: string): string {
  const target = storage.workspaceRoot();
  storage.assertWorkspaceLease();
  if (!isAbsolute(source) || resolve(source) !== source || realpathSync(source) !== source
    || !isAbsolute(legacyRoot) || resolve(legacyRoot) !== legacyRoot || realpathSync(legacyRoot) !== legacyRoot
    || overlaps(source, target) || overlaps(source, legacyRoot))
    throw new Error("Private Room source overlaps a live or target root.");
  const sourceStat = lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink() || sourceStat.uid !== process.getuid?.()
    || (sourceStat.mode & 0o077) !== 0) throw new Error("Room source must be a private, owned copy.");
  const archive = inspectLegacyChatroomArchive(source, roomId);
  if (archive.files.some(file => file.path.includes("/meetings/")))
    throw new Error("The isolated archive-copy menu has no Meeting Note privacy admission; use the qualified owner's original-UI Meeting route.");
  const collection = join(target, "chatrooms");
  try { mkdirSync(collection, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const collectionStat = lstatSync(collection);
  if (!collectionStat.isDirectory() || collectionStat.isSymbolicLink() || realpathSync(collection) !== collection)
    throw new Error("Unsafe isolated Room collection.");
  const destination = join(collection, roomId);
  mkdirSync(destination, { mode: 0o700 });
  for (const file of archive.files) {
    storage.assertWorkspaceLease();
    const sourceFile = join(source, file.path);
    const input = openSync(sourceFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const before = fstatSync(input);
      if (!before.isFile() || before.nlink !== 1 || before.dev !== file.dev || before.ino !== file.ino
        || before.size !== file.size || before.mtimeMs !== file.mtimeMs) throw new Error("Room source changed.");
      bytes = readFileSync(input);
      const after = fstatSync(input);
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs || createHash("sha256").update(bytes).digest("hex") !== file.sha256)
        throw new Error("Room source changed during copy.");
    } finally { closeSync(input); }
    const output = openSync(join(destination, basename(file.path)),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, file.mode);
    try { fchmodSync(output, file.mode); writeFileSync(output, bytes); fsyncSync(output); } finally { closeSync(output); }
  }
  for (const directory of [destination, collection, target]) {
    const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  const copied = inspectLegacyChatroomArchive(target, roomId);
  const identity = (files: typeof archive.files) => files.map(({ path, sha256, size, mode }) => ({ path, sha256, size, mode }));
  if (inspectLegacyChatroomArchive(source, roomId).sourceFingerprint !== archive.sourceFingerprint
    || JSON.stringify(identity(copied.files)) !== JSON.stringify(identity(archive.files)))
    throw new Error("Room copy did not match its closed source.");
  storage.assertWorkspaceLease();
  return copied.sourceFingerprint;
}
