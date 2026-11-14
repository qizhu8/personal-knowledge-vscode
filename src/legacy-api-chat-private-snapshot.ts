import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { inspectLegacyApiChatArchive, type LegacyApiChatArchive, type LegacyApiChatEntity } from "./legacy-api-chat-archive.js";

function conflict(message: string): never {
  throw Object.assign(new Error(`LEGACY_CHAT_SOURCE_CONFLICT: ${message}`), { code: "LEGACY_CHAT_SOURCE_CONFLICT" });
}

function overlaps(a: string, b: string): boolean {
  const delta = relative(a, b);
  return delta === "" || (delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta));
}

function contents(archive: LegacyApiChatArchive) {
  return archive.files.map(({ path, kind, sha256, size }) => ({
    path, kind, ...(kind === "file" ? { sha256, size } : {}),
  }));
}

function checkedBytes(root: string, entity: LegacyApiChatEntity): Buffer {
  const fd = openSync(join(root, entity.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    const matches = (stat: typeof before) => stat.isFile() && stat.nlink === 1n
      && String(stat.dev) === entity.device && String(stat.ino) === entity.inode
      && String(stat.mtimeNs) === entity.mtimeNs && String(stat.ctimeNs) === entity.ctimeNs
      && Number(stat.size) === entity.size && (Number(stat.mode) & 0o777) === entity.mode;
    if (!matches(before)) conflict(`Source changed before copy: ${entity.path}`);
    const bytes = Buffer.alloc(entity.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) conflict(`Source truncated during copy: ${entity.path}`);
      offset += count;
    }
    if (!matches(fstatSync(fd, { bigint: true }))
      || createHash("sha256").update(bytes).digest("hex") !== entity.sha256)
      conflict(`Source changed during copy: ${entity.path}`);
    return bytes;
  } finally { closeSync(fd); }
}

const hostDirectory = ".pkm/state/api-chat-control/hosts";
const hostFile = /^\.pkm\/state\/api-chat-control\/hosts\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/;
type SourceState = {
  archive: LegacyApiChatArchive;
  hosts: Map<string, { entity: LegacyApiChatEntity; updatedAt: number; stable: string; bytes: Buffer }>;
};

function sourceState(root: string, archive: LegacyApiChatArchive): SourceState {
  const hosts: SourceState["hosts"] = new Map();
  for (const entity of archive.files) {
    if (entity.kind !== "file" || !hostFile.test(entity.path)) continue;
    const bytes = checkedBytes(root, entity), raw = bytes.toString("utf8");
    const value = JSON.parse(raw);
    // The old host writes compact JSON with Date.now(); other encodings retain
    // the original strict fingerprint and cannot qualify as a heartbeat.
    if (JSON.stringify(value) !== raw || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) continue;
    const { updatedAt, ...stable } = value;
    hosts.set(entity.path, { entity, updatedAt, stable: JSON.stringify(stable), bytes });
  }
  return { archive, hosts };
}

function readSourceState(root: string): SourceState | undefined {
  for (let attempt = 0; ; attempt++) {
    try {
      const archive = inspectLegacyApiChatArchive(root);
      return archive && sourceState(root, archive);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const hostRace = message.startsWith("LEGACY_CHAT_SOURCE_CONFLICT: Source changed ")
        && hostFile.test(message.slice(message.lastIndexOf(": ") + 2));
      const graphRace = message === "LEGACY_API_CHAT_BLOCKED: API Chat entities changed during graph verification.";
      if (attempt >= 2 || !hostRace && !graphRace) throw error;
    }
  }
}

function sameSource(before: SourceState, after: SourceState): boolean {
  const previous = new Map(before.archive.files.map(entity => [entity.path, entity]));
  if (before.archive.root !== after.archive.root || previous.size !== after.archive.files.length) return false;
  let advanced = false, directoryChanged = false;
  for (const entity of after.archive.files) {
    const old = previous.get(entity.path);
    if (!old) return false;
    if (entity.path === hostDirectory) {
      if (entity.kind !== "directory" || old.kind !== "directory" || entity.device !== old.device
        || entity.inode !== old.inode || entity.mode !== old.mode) return false;
      directoryChanged = JSON.stringify(old) !== JSON.stringify(entity);
      continue;
    }
    const oldHost = before.hosts.get(entity.path), newHost = after.hosts.get(entity.path);
    if (oldHost && newHost) {
      if (newHost.stable !== oldHost.stable || newHost.updatedAt < oldHost.updatedAt
        || entity.device !== old.device || entity.mode !== old.mode) return false;
      if (newHost.updatedAt === oldHost.updatedAt) {
        if (JSON.stringify(old) !== JSON.stringify(entity)) return false;
      } else advanced = true;
    } else if (JSON.stringify(old) !== JSON.stringify(entity)) return false;
  }
  return !directoryChanged || advanced;
}

/**
 * Copies only a validated archive into a new private directory. This is an
 * optimistic read, not a writer lock, point-in-time snapshot or root cutover.
 * The caller owns the private parent and must preserve failed copies for review.
 */
export function createLegacyChatPrivateSnapshot(sourceRoot: string, privateParent: string) {
  if (!isAbsolute(sourceRoot) || resolve(sourceRoot) !== sourceRoot || realpathSync(sourceRoot) !== sourceRoot
    || !isAbsolute(privateParent) || resolve(privateParent) !== privateParent || realpathSync(privateParent) !== privateParent
    || overlaps(sourceRoot, privateParent) || overlaps(privateParent, sourceRoot))
    throw new Error("Chat snapshot requires separate canonical source and private parent directories.");
  const parent = lstatSync(privateParent, { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink() || process.getuid === undefined
    || Number(parent.uid) !== process.getuid() || (Number(parent.mode) & 0o077) !== 0
    || (Number(parent.mode) & 0o7000) !== 0)
    throw new Error("Chat snapshot parent must be an owner-private directory.");
  const initial = readSourceState(sourceRoot);
  if (!initial) throw new Error("No supported Chat archive is available.");
  let lastSource: SourceState = initial;
  const original = lastSource.archive;
  const root = join(privateParent, `chat-snapshot-${randomUUID()}`);
  mkdirSync(root, { mode: 0o700 });
  const rootStat = lstatSync(root, { bigint: true });
  try {
    mkdirSync(join(root, ".pkm"), { mode: 0o700 });
    mkdirSync(join(root, ".pkm", "state"), { mode: 0o700 });
    const directories = original.files.filter(item => item.kind === "directory")
      .sort((a, b) => a.path.split("/").length - b.path.split("/").length);
    for (const entity of directories) mkdirSync(join(root, entity.path), { mode: 0o700 });
    for (const entity of original.files) if (entity.kind === "file")
      writeFileSync(join(root, entity.path), lastSource.hosts.get(entity.path)?.bytes ?? checkedBytes(sourceRoot, entity),
        { flag: "wx", mode: 0o600 });
    const afterSource = readSourceState(sourceRoot);
    if (!afterSource) conflict("Original archive changed while copying.");
    if (!sameSource(lastSource, afterSource)) conflict("Original archive changed while copying.");
    lastSource = afterSource;
    const copied = inspectLegacyApiChatArchive(root);
    if (!copied || JSON.stringify(contents(copied)) !== JSON.stringify(contents(original)))
      conflict("Copied archive does not match the validated original.");
    const assertSnapshotCurrent = () => {
      try {
        const nowParent = lstatSync(privateParent, { bigint: true }), nowRoot = lstatSync(root, { bigint: true });
        if (!nowParent.isDirectory() || nowParent.dev !== parent.dev || nowParent.ino !== parent.ino
          || Number(nowParent.uid) !== process.getuid?.() || (Number(nowParent.mode) & 0o7077) !== 0
          || !nowRoot.isDirectory() || nowRoot.dev !== rootStat.dev || nowRoot.ino !== rootStat.ino
          || Number(nowRoot.uid) !== process.getuid?.() || (Number(nowRoot.mode) & 0o7077) !== 0
          || realpathSync(privateParent) !== privateParent || realpathSync(root) !== root)
          conflict("Snapshot directory identity or privacy changed.");
        const nextSource = readSourceState(sourceRoot);
        const currentCopy = inspectLegacyApiChatArchive(root);
        if (!nextSource || !currentCopy || currentCopy.sourceFingerprint !== copied.sourceFingerprint)
          conflict("Original or copied archive changed.");
        if (!sameSource(lastSource, nextSource)) conflict("Original or copied archive changed.");
        lastSource = nextSource;
      } catch (error) {
        if ((error as { code?: string }).code === "LEGACY_CHAT_SOURCE_CONFLICT") throw error;
        conflict(`Archive is unavailable or changed: ${error instanceof Error ? error.message : String(error)}`);
      }

    };
    assertSnapshotCurrent();
    return Object.freeze({ kind: "optimistic-snapshot" as const, root, assertSnapshotCurrent });
  } catch (error) {
    throw Object.assign(new Error(`LEGACY_CHAT_SOURCE_CONFLICT: Chat snapshot failed; preserve private copy at ${root}. `
      + (error instanceof Error ? error.message : "Unknown copy error."),
      { cause: error }), { code: "LEGACY_CHAT_SOURCE_CONFLICT" });
  }
}

/** Rebind an independently authorized, unchanged private copy, never a new archive copy. */
export function reopenLegacyChatPrivateSnapshot(sourceRoot: string, root: string, expectedFingerprint: string) {
  const parent = resolve(root, "..");
  if (!isAbsolute(sourceRoot) || resolve(sourceRoot) !== sourceRoot || realpathSync(sourceRoot) !== sourceRoot
    || !isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root
    || !/^chat-snapshot-[a-f0-9-]{36}$/.test(root.slice(parent.length + 1))
    || overlaps(sourceRoot, root) || overlaps(root, sourceRoot) || !/^[a-f0-9]{64}$/.test(expectedFingerprint))
    throw new Error("Chat recovery requires the exact private snapshot.");
  const initialParent = lstatSync(parent, { bigint: true }), initialRoot = lstatSync(root, { bigint: true });
  const privateDirectory = (stat: typeof initialRoot) => stat.isDirectory() && !stat.isSymbolicLink()
    && Number(stat.uid) === process.getuid?.() && (Number(stat.mode) & 0o7077) === 0;
  if (!privateDirectory(initialParent) || !privateDirectory(initialRoot))
    throw new Error("Chat recovery snapshot is not owner-private.");
  const copied = inspectLegacyApiChatArchive(root), source = readSourceState(sourceRoot);
  if (!copied || copied.sourceFingerprint !== expectedFingerprint || !source)
    conflict("Recovery archive is unavailable or changed.");
  const stable = (archive: LegacyApiChatArchive) => contents(archive).filter(item =>
    item.path !== hostDirectory && !item.path.startsWith(`${hostDirectory}/`)
    && !(item.kind === "directory" && /^\.pkm\/state\/api-chat-control\/requests\/[a-f0-9-]{36}$/.test(item.path)));
  if (JSON.stringify(stable(copied)) !== JSON.stringify(stable(source.archive)))
    conflict("Original Chat content changed since the selected snapshot.");
  let lastSource = source;
  const assertSnapshotCurrent = () => {
    try {
      const currentParent = lstatSync(parent, { bigint: true }), currentRoot = lstatSync(root, { bigint: true });
      if (!privateDirectory(currentParent) || !privateDirectory(currentRoot)
        || currentParent.dev !== initialParent.dev || currentParent.ino !== initialParent.ino
        || currentRoot.dev !== initialRoot.dev || currentRoot.ino !== initialRoot.ino
        || realpathSync(parent) !== parent || realpathSync(root) !== root)
        conflict("Recovery snapshot identity changed.");
      const nextSource = readSourceState(sourceRoot), currentCopy = inspectLegacyApiChatArchive(root);
      if (!nextSource || !currentCopy || currentCopy.sourceFingerprint !== expectedFingerprint
        || !sameSource(lastSource, nextSource))
        conflict("Recovery source or snapshot changed.");
      lastSource = nextSource;
    } catch (error) {
      if ((error as { code?: string }).code === "LEGACY_CHAT_SOURCE_CONFLICT") throw error;
      conflict(`Recovery archive is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  assertSnapshotCurrent();
  return Object.freeze({ kind: "optimistic-snapshot" as const, root, assertSnapshotCurrent });
}
