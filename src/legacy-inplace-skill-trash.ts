import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fchmodSync, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { isTrustedLinuxRootWriterFence, type LinuxRootWriterFence } from "./linux-root-writer-fence.js";
import { assertLinuxLegacyWritersQuiescent } from "./linux-legacy-writer-quiescence.js";
import { experimentalLegacySyncJournalSchema } from "./legacy-github-sync-journal.js";
import { resourcePath } from "./document-path.js";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const metadataSchema = z.strictObject({
  id: z.string().regex(/^(?:0|[1-9][0-9]*)-[a-f0-9]{10}$/),
  kind: z.literal("skill"), name: z.string().regex(/^[A-Za-z0-9_-]+$/),
  originalPath: z.string(), deletedAt: z.iso.datetime(), assetsPath: z.string().optional(),
});
const deletionSchema = z.strictObject({
  schema: z.literal(1), records: z.array(z.strictObject({ path: z.string(), deletedAt: z.iso.datetime() })).max(10000),
});
const bindingSchema = z.strictObject({
  workspaceId: z.uuid(), targetId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  configHash: z.string().regex(/^[a-f0-9]{64}$/), policyId: z.uuid(),
});
const ddl = `CREATE TABLE adoption (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), body TEXT NOT NULL, sha256 TEXT NOT NULL
) STRICT;`;
const receiptDdl = `CREATE TABLE original_receipt (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), body TEXT NOT NULL, sha256 TEXT NOT NULL
) STRICT;`;
const bindingDdl = `CREATE TABLE binding (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), body TEXT NOT NULL, sha256 TEXT NOT NULL
) STRICT;`;
const maximumBytes = 64 * 1024 * 1024;
const maximumSidecarBytes = 100 * 1024 * 1024;
function fail(message: string): never { throw new Error(`Original in-place Skill Trash: ${message}`); }

function directory(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid!())
    || (stat.mode & 0o7022n) !== 0n) fail(`unsafe directory: ${path}`);
  return stat;
}
function permissions(stat: { mode: bigint; uid: bigint; gid: bigint }) {
  return { mode: Number(stat.mode & 0o7777n), uid: String(stat.uid), gid: String(stat.gid) };
}
function readStable(file: string, maximum: number) {
  const before = lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maximum)
    || before.uid !== BigInt(process.getuid!()) || (before.mode & 0o7022n) !== 0n)
    fail(`unsafe file: ${file}`);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino) fail("file identity changed");
    const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true }), current = lstatSync(file, { bigint: true });
    if (bytes.length !== Number(before.size) || after.size !== before.size || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs || current.dev !== before.dev || current.ino !== before.ino
      || current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs) fail("file changed while reading");
    return { bytes, dev: String(before.dev), ino: String(before.ino), sha256: hash(bytes),
      mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs), ...permissions(before) };
  } finally { closeSync(fd); }
}
function portable(path: string): boolean {
  return resourcePath.safeParse(path).success;
}

function verifyInPlaceReceipt(receiptBody: string, sourceBody: string): void {
  const source = z.object({
    schema: z.literal("pkm.experimental-inplace-skill-trash-source/v2"),
    root: z.string(), rootDev: z.string(), rootIno: z.string(),
    journal: z.object({ base64: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough(),
    entries: z.array(z.object({
      metadata: z.object({ id: metadataSchema.shape.id }).passthrough(),
      files: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough()),
    }).passthrough()),
  }).passthrough().parse(JSON.parse(sourceBody));
  const receipt = z.strictObject({
    schema: z.literal("pkm.legacy-trash-inplace-receipt/v2"),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), root: z.string(),
    rootDev: z.string(), rootIno: z.string(), journalBase64: z.string(),
    files: z.array(z.strictObject({ id: metadataSchema.shape.id, path: z.string(), base64: z.string() })).max(8192),
  }).parse(JSON.parse(receiptBody));
  if (receipt.sourceSha256 !== hash(sourceBody) || receipt.root !== source.root
    || receipt.rootDev !== source.rootDev || receipt.rootIno !== source.rootIno
    || receipt.journalBase64 !== source.journal.base64
    || hash(Buffer.from(receipt.journalBase64, "base64")) !== source.journal.sha256)
    fail("in-place adoption receipt is not bound to its exact source");
  const expected = source.entries.flatMap(entry => entry.files.map(file => ({ id: entry.metadata.id, ...file })));
  if (receipt.files.length !== expected.length) fail("in-place adoption receipt has incomplete original bytes");
  let total = 0;
  for (const [index, file] of receipt.files.entries()) {
    const original = expected[index]!, bytes = Buffer.from(file.base64, "base64");
    total += bytes.length;
    if (total > maximumBytes || bytes.toString("base64") !== file.base64
      || file.id !== original.id || file.path !== original.path
      || bytes.length !== original.size || hash(bytes) !== original.sha256)
      fail("in-place adoption receipt bytes or identity differ from the original source");
  }
}

function originalSkillIdentity(root: string, rootStat: { dev: bigint; ino: bigint },
  metadata: z.infer<typeof metadataSchema>, metadataBytes: Buffer, journalSha256: string) {
  const timestamp = metadata.id.split("-")[0]!;
  const milliseconds = Number(timestamp), deletedAt = Date.parse(metadata.deletedAt);
  if (!Number.isSafeInteger(milliseconds) || !Number.isFinite(deletedAt)
    || new Date(deletedAt).toISOString() !== metadata.deletedAt
    || !metadataBytes.equals(Buffer.from(JSON.stringify(metadata, null, 2) + "\n")))
    fail("original Skill Trash identity is not exact filestore v1 format");
  return {
    schema: "pkm.original-skill-trash-identity/v1" as const,
    root, rootDev: String(rootStat.dev), rootIno: String(rootStat.ino),
    id: metadata.id, idTimestampMs: timestamp, deletedAt: metadata.deletedAt,
    originalPath: metadata.originalPath, name: metadata.name,
    metadataSha256: hash(metadataBytes), journalSha256,
  };
}

function openSidecar(path: string, schemaSql: string, fault: ((point: string) => void) | undefined, prefix: string,
  requireNew = false) {
  let created = false;
  try {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(fd); created = true;
    const parentFd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (requireNew) fail("a bound lock journal already exists");
  }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.uid !== process.getuid!()
    || (file.mode & 0o077) !== 0) fail("unsafe sidecar database");
  for (const suffix of ["-wal", "-shm"]) {
    try { lstatSync(`${path}${suffix}`); fail("unrecognized SQLite sidecar state"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  try {
    const pending = readStable(`${path}-journal`, maximumBytes).bytes;
    const initialIntent = file.size === 0 && pending.length === 512
      && pending.subarray(0, 12).equals(Buffer.alloc(12))
      && pending.readUInt32BE(16) === 0 && pending.readUInt32BE(20) === 512 && pending.readUInt32BE(24) === 4096
      && pending.subarray(28).equals(Buffer.alloc(484));
    if (!initialIntent) fail("unrecognized SQLite recovery journal");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  fault?.(`${prefix}sidecar-created`);
  const db = new DatabaseSync(path);
  try {
    fault?.(`${prefix}database-opened`);
    db.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
    const query = "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name";
    const tables = db.prepare(query).all();
    if (tables.length === 0 && (created || file.size === 0)) db.exec(schemaSql);
    else {
      const expected = new DatabaseSync(":memory:");
      try {
        expected.exec(schemaSql);
        const base = JSON.stringify(expected.prepare(query).all());
        if (schemaSql === ddl) expected.exec(receiptDdl);
        const upgraded = JSON.stringify(expected.prepare(query).all());
        if (JSON.stringify(tables) !== base && JSON.stringify(tables) !== upgraded) fail("unrecognized sidecar schema");
      } finally { expected.close(); }
    }
    return db;
  } catch (error) {
    try { if (db.isTransaction) db.exec("ROLLBACK"); } finally { db.close(); }
    throw error;
  }
}

function originalLockModule() {
  const load = createRequire(import.meta.url);
  const candidates = [new URL("../legacy/dist/runtime/cross-process-lock.js", import.meta.url),
    new URL("../legacy/dist/runtime/cross-process-lock.js", import.meta.url)];
  const originalLock = candidates.map(candidate => fileURLToPath(candidate)).find(candidate => {
    try { return lstatSync(candidate).isFile(); } catch { return false; }
  });
  if (!originalLock) fail("original target lock implementation is unavailable");
  return load(originalLock) as {
    withCrossProcessLockRejectAbandoned?<T>(path: string, owner: string, timeout: number, work: () => Promise<T>): Promise<T>;
    withCrossProcessLockBound?<T>(path: string, owner: string, timeout: number,
      binding: { nonce: string; acquiredAt: number }, work: () => Promise<T>): Promise<T>;
  };
}
function originalCrossProcessLock() {
  const { withCrossProcessLockRejectAbandoned: lock } = originalLockModule();
  if (typeof lock !== "function") fail("required original target lock implementation is unavailable");
  return lock;
}

type OriginalTrashPreparation = {
  mode: "isolated-experiment"; root: string; sidecar: string; targetId: string; fence: LinuxRootWriterFence;
  faultInjector?: (point: string) => void;
  /** Only the gated adoption preparation creates this inactive, original-layout receipt. */
  adoptionReceipt?: "in-place-v2";
};
type OriginalTrashBinding = Omit<OriginalTrashPreparation, "targetId"> & {
  syncJournal: string; binding: z.infer<typeof bindingSchema>;
};

/** Capture original authority before workspace or Sync state exists. */
export async function prepareExperimentalInPlaceSkillTrash(options: OriginalTrashPreparation) {
  return recordOriginalTrash(options);
}

/** Bind the unchanged original authority to an existing workspace and Sync journal. */
export async function admitExperimentalInPlaceSkillTrash(options: OriginalTrashBinding) {
  const binding = bindingSchema.parse(options.binding);
  const result = await recordOriginalTrash({ ...options, targetId: binding.targetId }, binding);
  return { ...result, binding };
}

async function recordOriginalTrash(options: OriginalTrashPreparation & { syncJournal?: string },
  binding?: z.infer<typeof bindingSchema>) {
  const root = resolve(options.root), sidecar = resolve(options.sidecar);
  const stateDir = dirname(dirname(sidecar));
  const journalFile = options.syncJournal === undefined ? undefined : resolve(options.syncJournal);
  if (process.platform !== "linux" || options.mode !== "isolated-experiment" || root !== options.root
    || options.adoptionReceipt !== undefined && options.adoptionReceipt !== "in-place-v2"
    || sidecar !== options.sidecar || journalFile !== options.syncJournal || !isAbsolute(sidecar)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(options.targetId)
    || basename(stateDir) !== "github-sync"
    || binding && journalFile !== join(stateDir, "experimental-next", `${options.targetId}.json`)
    || sidecar !== join(stateDir, "experimental-next", `${options.targetId}.original-trash.sqlite`)
    || relative(root, sidecar) === ""
    || !relative(root, sidecar).startsWith(`..${sep}`) || realpathSync(root) !== root
    || realpathSync(dirname(sidecar)) !== dirname(sidecar) || !isTrustedLinuxRootWriterFence(options.fence, root))
    fail("requires an isolated root, external sidecar and its real exclusive writer fence");
  const withCrossProcessLock = originalCrossProcessLock();
  directory(dirname(stateDir)); directory(stateDir); directory(dirname(sidecar));
  return withCrossProcessLock(join(stateDir, "targets-state.lock"), "experimental original Trash admission", 10000, async () => {
  const syncJournal = journalFile ? readStable(journalFile, 2 * 1024 * 1024) : undefined;
  if (binding && syncJournal) {
    const sync = experimentalLegacySyncJournalSchema.parse(JSON.parse(syncJournal.bytes.toString("utf8")));
    if (sync.workspaceId !== binding.workspaceId || sync.targetId !== binding.targetId
      || sync.configHash !== binding.configHash || sync.policyId !== binding.policyId
      || !["initial", "idle"].includes(sync.phase)) fail("Sync journal binding or phase differs");
  }
  options.fence.assertHeld();
  await assertLinuxLegacyWritersQuiescent(root);
  const rootStat = directory(root), skills = directory(join(root, "skills"));
  const directoryPins: Array<{ path: string; mtimeNs: bigint; ctimeNs: bigint }> = [];
  const pinDirectory = (path: string, stat: { mtimeNs: bigint; ctimeNs: bigint }) =>
    directoryPins.push({ path, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs });
  pinDirectory(root, rootStat); pinDirectory(join(root, "skills"), skills);
  const marker = binding ? readStable(join(root, ".pkm-next-workspace"), 4096) : undefined;
  if (binding && marker) {
    const identity = z.strictObject({ schema: z.literal("pkm.next-workspace/v2"), id: z.uuid() })
      .parse(JSON.parse(marker.bytes.toString("utf8")));
    if (identity.id !== binding.workspaceId) fail("original root workspace identity differs from Sync journal");
  }
  const stateDirectories = [join(root, ".pkm"), join(root, ".pkm", "state")].map(dir => {
    const stat = directory(dir);
    pinDirectory(dir, stat);
    if (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o7022n) !== 0n) fail("original state is writable by other users");
    return { dev: String(stat.dev), ino: String(stat.ino), ...permissions(stat) };
  });
  const journalStat = lstatSync(join(root, ".pkm", "state", "knowledge-deletions.json"));
  if (journalStat.uid !== process.getuid!() || (journalStat.mode & 0o7022) !== 0) fail("original deletion journal is writable by other users");
  const journal = readStable(join(root, ".pkm", "state", "knowledge-deletions.json"), 2 * 1024 * 1024);
  if (!Buffer.from(journal.bytes.toString("utf8")).equals(journal.bytes)) fail("journal is not exact UTF-8");
  const history = deletionSchema.parse(JSON.parse(journal.bytes.toString("utf8")));
  const records = new Map<string, string>();
  for (const record of history.records) {
    if (!portable(record.path) || !/^(notes|skills|papers|prompts|scripts)\//.test(record.path)
      || records.has(record.path.toLowerCase())) fail("ambiguous or unsupported original deletion record");
    records.set(record.path.toLowerCase(), record.deletedAt);
  }
  const trashPath = join(root, "skills", ".trash"), trashStat = directory(trashPath);
  pinDirectory(trashPath, trashStat);
  const names = readdirSync(trashPath).sort(), owned = new Set<string>();
  const identities = new Set<string>();
  if (names.length > 10000) fail("too many original Trash entries");
  let total = 0, count = 0;
  const receiptFiles: Array<{ id: string; path: string; base64: string }> = [];
  const entries = names.map(id => {
    if (!/^[0-9]+-[a-f0-9]{10}$/.test(id)) fail("unrecognized original Trash entry");
    const bucket = join(trashPath, id), bucketStat = directory(bucket), raw = readStable(join(bucket, "metadata.json"), 8192);
    pinDirectory(bucket, bucketStat);
    if (!Buffer.from(raw.bytes.toString("utf8")).equals(raw.bytes)) fail("metadata is not exact UTF-8");
    const metadata = metadataSchema.parse(JSON.parse(raw.bytes.toString("utf8")));
    const originalIdentity = originalSkillIdentity(root, rootStat, metadata, raw.bytes, journal.sha256);
    const original = metadata.originalPath;
    if (metadata.id !== id || !portable(original) || !/\.md$/.test(original)
      || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md$/.test(original)
      || original.split("/").at(-1) !== `${metadata.name}.md`
      || metadata.assetsPath !== undefined && metadata.assetsPath !== original.slice(0, -3) + ".assets")
      fail("original identity, path or paired asset binding differs");
    if (identities.has(metadata.name.toLowerCase())) fail("ambiguous original Skill identity");
    identities.add(metadata.name.toLowerCase());
    for (const destination of [original, ...(metadata.assetsPath ? [metadata.assetsPath] : [])]) {
      let current = join(root, "skills");
      for (const [index, part] of destination.split("/").entries()) {
        current = join(current, part);
        try {
          const item = lstatSync(current);
          if (index === destination.split("/").length - 1 || item.isSymbolicLink() || !item.isDirectory())
            fail("original restore destination is occupied or unsafe");
          directory(current);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
          throw error;
        }
      }
    }
    const expected = ["metadata.json", "payload", ...(metadata.assetsPath ? ["assets"] : [])].sort();
    if (JSON.stringify(readdirSync(bucket).sort()) !== JSON.stringify(expected)) fail("unknown original Trash bucket members");
    const files: Array<{ path: string; size: number; sha256: string; dev: string; ino: string;
      mode: number; uid: string; gid: string }> = [];
    const directories: Array<{ path: string; dev: string; ino: string; mode: number; uid: string; gid: string }> = [];
    const inspect = (full: string, target: string, depth: number) => {
      if (++count > 8192 || depth > 32 || !portable(target)) fail("Trash tree exceeds bounded portable layout");
      const stat = lstatSync(full, { bigint: true });
      if (stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o7022n) !== 0n)
        fail("unsafe original Trash member");
      if (stat.isDirectory()) {
        pinDirectory(full, stat);
        directories.push({ path: target, dev: String(stat.dev), ino: String(stat.ino), ...permissions(stat) });
        const children = readdirSync(full).sort();
        if (new Set(children.map(name => name.toLowerCase())).size !== children.length) fail("case-colliding assets");
        for (const child of children) inspect(join(full, child), `${target}/${child}`, depth + 1);
        const after = directory(full);
        if (stat.dev !== after.dev || stat.ino !== after.ino || stat.mtimeNs !== after.mtimeNs
          || stat.ctimeNs !== after.ctimeNs || JSON.stringify(children) !== JSON.stringify(readdirSync(full).sort()))
          fail("asset directory changed");
      } else {
        const file = readStable(full, maximumBytes - total); total += file.bytes.length;
        if (total > maximumBytes) fail("Trash byte limit exceeded");
        if (records.get(target.toLowerCase()) !== metadata.deletedAt || owned.has(target.toLowerCase()))
          fail("original deletion journal does not bind every Trash member exactly");
        owned.add(target.toLowerCase());
        if (options.adoptionReceipt) receiptFiles.push({ id, path: target, base64: file.bytes.toString("base64") });
        files.push({ path: target, size: file.bytes.length, sha256: file.sha256, dev: file.dev, ino: file.ino,
          mode: file.mode, uid: file.uid, gid: file.gid });
      }
    };
    inspect(join(bucket, "payload"), `skills/${original}`, 0);
    const payload = readStable(join(bucket, "payload"), 1024 * 1024).bytes;
    if (files.find(file => file.path === `skills/${original}`)?.sha256 !== hash(payload))
      fail("original Skill payload changed during identity validation");
    const text = payload.toString("utf8"), frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!Buffer.from(text).equals(payload) || !frontmatter || !text.slice(frontmatter[0].length).trim())
      fail("original Skill payload is not supported UTF-8 Markdown");
    const identity: unknown = parseYaml(frontmatter[1]!);
    if (!identity || typeof identity !== "object" || Array.isArray(identity)
      || (identity as Record<string, unknown>).name !== metadata.name) fail("original Skill content identity differs");
    if (metadata.assetsPath) inspect(join(bucket, "assets"), `skills/${metadata.assetsPath}`, 0);
    const after = directory(bucket);
    if (bucketStat.dev !== after.dev || bucketStat.ino !== after.ino || bucketStat.mtimeNs !== after.mtimeNs
      || bucketStat.ctimeNs !== after.ctimeNs || JSON.stringify(readdirSync(bucket).sort()) !== JSON.stringify(expected))
      fail("original Trash bucket changed");
    return { metadata, identity: originalIdentity, metadataBase64: raw.bytes.toString("base64"), metadataSha256: raw.sha256,
      metadataIdentity: { dev: raw.dev, ino: raw.ino, mode: raw.mode, uid: raw.uid, gid: raw.gid },
      bucketDev: String(bucketStat.dev), bucketIno: String(bucketStat.ino), bucketPermissions: permissions(bucketStat),
      files, directories };
  });
  if ([...records.keys()].some(path => path.startsWith("skills/") && !owned.has(path)))
    fail("unrecognized original Skills deletion record");
  const trashAfter = directory(trashPath), skillsAfter = directory(join(root, "skills")), rootAfter = directory(root);
  if (trashAfter.dev !== trashStat.dev || trashAfter.ino !== trashStat.ino || trashAfter.mtimeNs !== trashStat.mtimeNs
    || trashAfter.ctimeNs !== trashStat.ctimeNs || JSON.stringify(readdirSync(trashPath).sort()) !== JSON.stringify(names)
    || skillsAfter.dev !== skills.dev || skillsAfter.ino !== skills.ino
    || JSON.stringify(permissions(skillsAfter)) !== JSON.stringify(permissions(skills))
    || rootAfter.dev !== rootStat.dev || rootAfter.ino !== rootStat.ino
    || JSON.stringify(permissions(rootAfter)) !== JSON.stringify(permissions(rootStat)))
    fail("original root or Trash inventory changed");
  const body = JSON.stringify({ schema: "pkm.experimental-inplace-skill-trash-source/v2", root,
    rootDev: String(rootStat.dev), rootIno: String(rootStat.ino), rootPermissions: permissions(rootStat),
    skills: { dev: String(skills.dev), ino: String(skills.ino), ...permissions(skills) },
    trash: { dev: String(trashStat.dev), ino: String(trashStat.ino), ...permissions(trashStat) },
    stateDirectories,
    journal: { base64: journal.bytes.toString("base64"), sha256: journal.sha256, dev: journal.dev, ino: journal.ino,
      mode: journal.mode, uid: journal.uid, gid: journal.gid, mtimeNs: journal.mtimeNs, ctimeNs: journal.ctimeNs }, entries });
  const bindingBody = binding && marker ? JSON.stringify({
    schema: "pkm.experimental-inplace-skill-trash-binding/v1", sourceSha256: hash(body), binding,
    marker: { sha256: marker.sha256, dev: marker.dev, ino: marker.ino,
      mode: marker.mode, uid: marker.uid, gid: marker.gid },
  }) : undefined;
  const parent = directory(dirname(sidecar));
  if ((parent.mode & 0o077n) !== 0n || parent.uid !== BigInt(process.getuid!())) fail("sidecar parent is not private and owned");
  const bindingPath = `${sidecar}.binding`;
  if (!bindingBody) {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      try { lstatSync(`${bindingPath}${suffix}`); fail("prepared source already has a Sync binding or unknown binding state"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  const recheckSource = async () => {
    const journalAfter = readStable(join(root, ".pkm", "state", "knowledge-deletions.json"), 2 * 1024 * 1024);
    if (journalAfter.dev !== journal.dev || journalAfter.ino !== journal.ino || journalAfter.sha256 !== journal.sha256)
      fail("original deletion journal changed before sidecar commit");
    if (marker) {
      const markerAfter = readStable(join(root, ".pkm-next-workspace"), 4096);
      if (markerAfter.dev !== marker.dev || markerAfter.ino !== marker.ino || markerAfter.sha256 !== marker.sha256)
        fail("original root workspace identity changed before sidecar commit");
    }
    if (journalFile && syncJournal) {
      const syncAfter = readStable(journalFile, 2 * 1024 * 1024);
      if (syncAfter.dev !== syncJournal.dev || syncAfter.ino !== syncJournal.ino || syncAfter.sha256 !== syncJournal.sha256)
        fail("Sync journal changed before sidecar commit");
    }
    const sameDirectory = (path: string, expected: { dev: string; ino: string; mode: number; uid: string; gid: string }) => {
      const current = directory(path);
      if (String(current.dev) !== expected.dev || String(current.ino) !== expected.ino
        || JSON.stringify(permissions(current)) !== JSON.stringify({ mode: expected.mode, uid: expected.uid, gid: expected.gid }))
        fail("original directory identity or permissions changed before sidecar commit");
    };
    const sameFile = (path: string, expected: { dev: string; ino: string; sha256: string;
      mode: number; uid: string; gid: string }) => {
      const current = readStable(path, maximumBytes);
      if (current.dev !== expected.dev || current.ino !== expected.ino || current.sha256 !== expected.sha256
        || current.mode !== expected.mode || current.uid !== expected.uid || current.gid !== expected.gid)
        fail("original file identity, permissions or bytes changed before sidecar commit");
    };
    sameDirectory(root, { dev: String(rootStat.dev), ino: String(rootStat.ino), ...permissions(rootStat) });
    sameDirectory(join(root, "skills"), { dev: String(skills.dev), ino: String(skills.ino), ...permissions(skills) });
    sameDirectory(trashPath, { dev: String(trashStat.dev), ino: String(trashStat.ino), ...permissions(trashStat) });
    sameDirectory(join(root, ".pkm"), stateDirectories[0]!);
    sameDirectory(join(root, ".pkm", "state"), stateDirectories[1]!);
    if (marker) sameFile(join(root, ".pkm-next-workspace"), marker);
    sameFile(join(root, ".pkm", "state", "knowledge-deletions.json"), journal);
    for (const pin of directoryPins) {
      const current = directory(pin.path);
      if (current.mtimeNs !== pin.mtimeNs || current.ctimeNs !== pin.ctimeNs)
        fail("original directory changed before sidecar commit");
    }
    for (const entry of entries) {
      const bucket = join(trashPath, entry.metadata.id);
      sameDirectory(bucket, { dev: entry.bucketDev, ino: entry.bucketIno, ...entry.bucketPermissions });
      sameFile(join(bucket, "metadata.json"), { ...entry.metadataIdentity, sha256: entry.metadataSha256 });
      const assetPrefix = entry.metadata.assetsPath ? `skills/${entry.metadata.assetsPath}` : undefined;
      const memberPath = (member: string) => member === `skills/${entry.metadata.originalPath}` ? join(bucket, "payload")
        : assetPrefix && (member === assetPrefix || member.startsWith(`${assetPrefix}/`))
          ? join(bucket, "assets", member.slice(assetPrefix.length)) : fail("unrecognized original member path");
      for (const member of entry.files) sameFile(memberPath(member.path), member);
      for (const member of entry.directories) sameDirectory(memberPath(member.path), member);
    }
    options.fence.assertHeld();
    await assertLinuxLegacyWritersQuiescent(root);
  };
  const db = openSidecar(sidecar, ddl, options.faultInjector, "");
  try {
    const existing = db.prepare("SELECT body,sha256 FROM adoption WHERE singleton=1").get();
    const receiptTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='original_receipt'").get();
    if (receiptTable && !existing) fail("in-place adoption receipt has no original source");
    if (existing) {
      if (existing.body !== body || existing.sha256 !== hash(body)) fail("original source or Sync binding changed");
    } else db.prepare("INSERT INTO adoption VALUES(1,?,?)").run(body, hash(body));
    if (options.adoptionReceipt === "in-place-v2") {
      if (!receiptTable) db.exec(receiptDdl);
      const receiptBody = JSON.stringify({ schema: "pkm.legacy-trash-inplace-receipt/v2",
        sourceSha256: hash(body), root, rootDev: String(rootStat.dev), rootIno: String(rootStat.ino),
        journalBase64: journal.bytes.toString("base64"), files: receiptFiles });
      const existingReceipt = db.prepare("SELECT body,sha256 FROM original_receipt WHERE singleton=1").get();
      if (existingReceipt) {
        if (existingReceipt.body !== receiptBody || existingReceipt.sha256 !== hash(receiptBody))
          fail("in-place adoption receipt differs from the original source");
      } else if (receiptTable) fail("in-place adoption receipt is missing");
      else db.prepare("INSERT INTO original_receipt VALUES(1,?,?)").run(receiptBody, hash(receiptBody));
      options.faultInjector?.("receipt-written");
    } else if (receiptTable) {
      const row = db.prepare("SELECT body,sha256 FROM original_receipt WHERE singleton=1").get();
      if (!row || typeof row.body !== "string" || row.sha256 !== hash(row.body))
        fail("in-place adoption receipt is missing or corrupt");
      verifyInPlaceReceipt(row.body, body);
    }
    options.faultInjector?.("intent-written");
    await recheckSource();
    options.faultInjector?.("before-commit");
    await recheckSource();
    db.exec("COMMIT");
    options.faultInjector?.("committed");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally { db.close(); }
  if (bindingBody) {
    const bindingDb = openSidecar(bindingPath, bindingDdl, options.faultInjector, "binding-");
    try {
      const existing = bindingDb.prepare("SELECT body,sha256 FROM binding WHERE singleton=1").get();
      if (existing) {
        if (existing.body !== bindingBody || existing.sha256 !== hash(bindingBody)) fail("original source or Sync binding changed");
      } else bindingDb.prepare("INSERT INTO binding VALUES(1,?,?)").run(bindingBody, hash(bindingBody));
      options.faultInjector?.("binding-intent-written");
      await recheckSource();
      options.faultInjector?.("binding-before-commit");
      await recheckSource();
      bindingDb.exec("COMMIT");
      options.faultInjector?.("binding-committed");
    } catch (error) {
      if (bindingDb.isTransaction) bindingDb.exec("ROLLBACK");
      throw error;
    } finally { bindingDb.close(); }
  }
  return { sha256: hash(body), entries, originalJournalBase64: journal.bytes.toString("base64") };
  });
}

/** Read-only projection of the original filestore's journal update; it is not mutation authority. */
export function previewExperimentalOriginalSkillRestoreJournal(
  prepared: Awaited<ReturnType<typeof prepareExperimentalInPlaceSkillTrash>>, entryId: string,
) {
  const entries = prepared.entries.filter(entry => entry.metadata.id === entryId);
  if (entries.length !== 1) fail("restore requires one exact original Skill Trash identity");
  const entry = entries[0]!, bytes = Buffer.from(prepared.originalJournalBase64, "base64");
  if (bytes.toString("base64") !== prepared.originalJournalBase64 || bytes.length > 2 * 1024 * 1024
    || !Buffer.from(bytes.toString("utf8")).equals(bytes) || hash(bytes) !== entry.identity.journalSha256)
    fail("restore journal differs from original source proof");
  const history = deletionSchema.parse(JSON.parse(bytes.toString("utf8")));
  const paths = entry.files.map(file => file.path);
  const document = `skills/${entry.metadata.originalPath}`;
  const assets = entry.metadata.assetsPath ? `skills/${entry.metadata.assetsPath}/` : undefined;
  if (new Set(paths).size !== paths.length || !paths.includes(document)
    || paths.some(path => path !== document && (!assets || !path.startsWith(assets)))
    || paths.some(path => history.records.filter(record => record.path === path
      && record.deletedAt === entry.metadata.deletedAt).length !== 1))
    fail("restore paths do not match exact original deletion records");
  const removed = new Set(paths);
  const after = Buffer.from(JSON.stringify({ schema: 1,
    records: history.records.filter(record => !removed.has(record.path)) }, null, 2) + "\n");
  if (after.length > 2 * 1024 * 1024) fail("original restore journal after-image exceeds its bounded format");
  return {
    schema: "pkm.experimental-original-skill-restore-journal/v1" as const,
    root: entry.identity.root, rootDev: entry.identity.rootDev, rootIno: entry.identity.rootIno,
    entryId, deletedAt: entry.metadata.deletedAt, sourceSha256: prepared.sha256,
    beforeSha256: hash(bytes), afterSha256: hash(after), afterBase64: after.toString("base64"), restoredPaths: paths,
  };
}

const transitionDdl = `CREATE TABLE transition (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), body TEXT NOT NULL, sha256 TEXT NOT NULL
) STRICT;`;
const effectDdl = `CREATE TABLE effect (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), body TEXT NOT NULL, sha256 TEXT NOT NULL
) STRICT;`;
const transitionSchema = z.strictObject({
  schema: z.literal("pkm.experimental-original-journal-transition/v1"),
  root: z.string(), rootDev: z.string().regex(/^\d+$/), rootIno: z.string().regex(/^\d+$/),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), entryId: metadataSchema.shape.id,
  operationId: z.uuid().optional(),
  beforeSha256: z.string().regex(/^[a-f0-9]{64}$/), afterSha256: z.string().regex(/^[a-f0-9]{64}$/),
  beforeBase64: z.string().max(2_796_204), afterBase64: z.string().max(2_796_204),
  beforeDev: z.string().regex(/^\d+$/), beforeIno: z.string().regex(/^\d+$/),
  beforeMtimeNs: z.string().regex(/^-?\d+$/), beforeCtimeNs: z.string().regex(/^-?\d+$/),
  mode: z.number().int().min(0).max(0o777), uid: z.string().regex(/^\d+$/), gid: z.string().regex(/^\d+$/),
});
const effectSchema = z.strictObject({
  schema: z.literal("pkm.experimental-original-journal-effect/v1"),
  transitionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  tempDev: z.string().regex(/^\d+$/), tempIno: z.string().regex(/^\d+$/),
  tempMtimeNs: z.string().regex(/^-?\d+$/),
});
function exists(path: string) {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function sourceFromSidecar(path: string): Awaited<ReturnType<typeof prepareExperimentalInPlaceSkillTrash>> & {
  source: { root: string; rootDev: string; rootIno: string; rootPermissions: { mode: number; uid: string; gid: string };
    skills: { dev: string; ino: string; mode: number; uid: string; gid: string };
    trash: { dev: string; ino: string; mode: number; uid: string; gid: string };
    journal: { dev: string; ino: string; mtimeNs: string; ctimeNs: string; sha256: string;
      mode: number; uid: string; gid: string };
    stateDirectories: Array<{ dev: string; ino: string; mode: number; uid: string; gid: string }> };
} {
  readStable(path, maximumSidecarBytes);
  for (const suffix of ["-journal", "-wal", "-shm"]) if (exists(`${path}${suffix}`)) fail("unknown original source sidecar state");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name";
    const expected = new DatabaseSync(":memory:");
    try {
      expected.exec(ddl);
      const base = JSON.stringify(expected.prepare(schema).all());
      expected.exec(receiptDdl);
      const upgraded = JSON.stringify(expected.prepare(schema).all()), actual = JSON.stringify(db.prepare(schema).all());
      if (actual !== base && actual !== upgraded) fail("unrecognized source sidecar schema");
    } finally { expected.close(); }
    const row = db.prepare("SELECT body,sha256 FROM adoption WHERE singleton=1").get();
    if (!row || typeof row.body !== "string" || row.sha256 !== hash(row.body)) fail("original source sidecar changed");
    const source = JSON.parse(row.body);
    if (source.schema !== "pkm.experimental-inplace-skill-trash-source/v2" || !Array.isArray(source.entries)
      || typeof source.journal?.base64 !== "string" || hash(Buffer.from(source.journal.base64, "base64")) !== source.journal.sha256)
      fail("original source sidecar is malformed");
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='original_receipt'").get()) {
      const receipt = db.prepare("SELECT body,sha256 FROM original_receipt WHERE singleton=1").get();
      if (!receipt || typeof receipt.body !== "string" || receipt.sha256 !== hash(receipt.body))
        fail("in-place adoption receipt is missing or corrupt");
      verifyInPlaceReceipt(receipt.body, row.body);
    }
    return { sha256: row.sha256 as string, entries: source.entries, originalJournalBase64: source.journal.base64, source };
  } finally { db.close(); }
}

function validateOriginalTrashBeforeMovement(root: string, prepared: ReturnType<typeof sourceFromSidecar>, entryId: string) {
  const preview = previewExperimentalOriginalSkillRestoreJournal(prepared, entryId);
  const rootStat = directory(root), source = prepared.source;
  if (preview.root !== root || preview.rootDev !== String(rootStat.dev) || preview.rootIno !== String(rootStat.ino)
    || source.root !== root || source.rootDev !== String(rootStat.dev) || source.rootIno !== String(rootStat.ino)
    || JSON.stringify(permissions(rootStat)) !== JSON.stringify(source.rootPermissions))
    fail("original transition root permissions or identity changed");
  const sameDirectory = (path: string, expected: { dev: string; ino: string; mode: number; uid: string; gid: string }) => {
    if (!expected || JSON.stringify(pin(directory(path))) !== JSON.stringify(expected))
      fail("original transition directory identity or permissions changed");
  };
  sameDirectory(join(root, "skills"), source.skills);
  sameDirectory(join(root, "skills", ".trash"), source.trash);
  sameDirectory(join(root, ".pkm"), source.stateDirectories?.[0]!);
  sameDirectory(join(root, ".pkm", "state"), source.stateDirectories?.[1]!);
  const trash = join(root, "skills", ".trash");
  if (JSON.stringify(readdirSync(trash).sort()) !== JSON.stringify(prepared.entries.map(value => value.metadata.id).sort()))
    fail("original transition Trash membership changed");
  for (const entry of prepared.entries) {
    const parsedMetadata = metadataSchema.parse(entry.metadata);
    if (!portable(parsedMetadata.originalPath)
      || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md$/.test(parsedMetadata.originalPath)
      || parsedMetadata.originalPath.split("/").at(-1) !== `${parsedMetadata.name}.md`
      || parsedMetadata.assetsPath !== undefined && parsedMetadata.assetsPath !== parsedMetadata.originalPath.slice(0, -3) + ".assets"
      || [...entry.files, ...entry.directories].some(member => !portable(member.path)))
      fail("original transition source contains unsafe paths");
    const bucket = join(trash, entry.metadata.id);
    const metadata = readStable(join(bucket, "metadata.json"), 8192);
    if (metadata.bytes.toString("base64") !== entry.metadataBase64
      || JSON.stringify(originalSkillIdentity(root, rootStat, parsedMetadata, metadata.bytes, preview.beforeSha256)) !== JSON.stringify(entry.identity)
      || metadata.sha256 !== entry.metadataSha256 || metadata.dev !== entry.metadataIdentity.dev
      || metadata.ino !== entry.metadataIdentity.ino || metadata.mode !== entry.metadataIdentity.mode
      || metadata.uid !== entry.metadataIdentity.uid || metadata.gid !== entry.metadataIdentity.gid)
      fail("original transition metadata changed");
    const bucketStat = directory(bucket);
    if (String(bucketStat.dev) !== entry.bucketDev || String(bucketStat.ino) !== entry.bucketIno
      || JSON.stringify(permissions(bucketStat)) !== JSON.stringify(entry.bucketPermissions)
      || JSON.stringify(readdirSync(bucket).sort()) !== JSON.stringify(
        ["metadata.json", "payload", ...(entry.metadata.assetsPath ? ["assets"] : [])].sort()))
      fail("original transition bucket changed");
    const assetPrefix = entry.metadata.assetsPath ? `skills/${entry.metadata.assetsPath}` : undefined;
    const memberPath = (member: string) => member === `skills/${entry.metadata.originalPath}` ? join(bucket, "payload")
      : assetPrefix && (member === assetPrefix || member.startsWith(`${assetPrefix}/`))
        ? join(bucket, "assets", member.slice(assetPrefix.length)) : fail("unrecognized original transition member");
    for (const file of entry.files) {
      const current = readStable(memberPath(file.path), maximumBytes);
      if (current.sha256 !== file.sha256 || current.bytes.length !== file.size || current.dev !== file.dev
        || current.ino !== file.ino || current.mode !== file.mode || current.uid !== file.uid || current.gid !== file.gid)
        fail("original transition payload changed");
    }
    for (const member of entry.directories) {
      const current = directory(memberPath(member.path));
      if (String(current.dev) !== member.dev || String(current.ino) !== member.ino
        || JSON.stringify(permissions(current)) !== JSON.stringify({ mode: member.mode, uid: member.uid, gid: member.gid }))
        fail("original transition asset directory changed");
      const prefix = `${member.path}/`;
      const expected = [...entry.files, ...entry.directories].map(value => value.path)
        .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
        .map(path => path.slice(prefix.length)).sort();
      if (JSON.stringify(readdirSync(memberPath(member.path)).sort()) !== JSON.stringify(expected))
        fail("original transition asset membership changed");
    }
    for (const destination of [entry.metadata.originalPath, ...(entry.metadata.assetsPath ? [entry.metadata.assetsPath] : [])]) {
      let current = join(root, "skills");
      for (const [index, part] of destination.split("/").entries()) {
        current = join(current, part);
        if (!exists(current)) break;
        if (index === destination.split("/").length - 1) fail("original transition restore destination is occupied");
        directory(current);
      }
    }
  }
  return preview;
}

const boundLockDdl = `CREATE TABLE lock_records (
  kind TEXT PRIMARY KEY CHECK(kind IN ('intent','effect','cleanup','result')),
  body TEXT NOT NULL, sha256 TEXT NOT NULL
) STRICT;`;
const pinSchema = z.strictObject({
  dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/),
  mode: z.number().int().min(0).max(0o7777), uid: z.string().regex(/^\d+$/), gid: z.string().regex(/^\d+$/),
});
const boundIntentSchema = z.strictObject({
  schema: z.literal("pkm.experimental-original-journal-lock-intent/v1"),
  root: z.string(), rootPin: pinSchema, workspaceId: z.uuid(), workspacePin: pinSchema,
  workspaceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  workspaceMtimeNs: z.string().regex(/^-?\d+$/), workspaceCtimeNs: z.string().regex(/^-?\d+$/),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), entryId: metadataSchema.shape.id,
  targetId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), operationId: z.uuid(), attemptId: z.uuid(),
  nonce: z.uuid(), pid: z.number().int().positive(), pidNamespace: z.string().regex(/^pid:\[\d+\]$/),
  bootId: z.uuid(), acquiredAt: z.number().int().nonnegative(),
});
const boundEffectSchema = z.strictObject({
  schema: z.literal("pkm.experimental-original-journal-lock-effect/v1"),
  intentSha256: z.string().regex(/^[a-f0-9]{64}$/), directory: pinSchema, member: pinSchema,
  memberSha256: z.string().regex(/^[a-f0-9]{64}$/), memberMtimeNs: z.string(), memberCtimeNs: z.string(),
});
type BoundLockOptions = OriginalTrashPreparation & { entryId: string; workspaceId: string; operationId: string; attemptId: string };
/** The trusted caller must persist the prepared intent digest before lock acquisition. */
type BoundLockPreparedOptions = BoundLockOptions & { intentSha256: string };
type BoundLockAcquisitionOptions = BoundLockPreparedOptions & {
  /** Synchronously persist this pointer in the caller's trusted recovery journal before returning. */
  persistEffect: (binding: { intentSha256: string; effectSha256: string }) => void;
};
type BoundLockRecoveryOptions = BoundLockPreparedOptions & {
  effectSha256?: string; transitionSha256?: string; transitionEffectSha256?: string;
};
const lockOwner = "experimental original journal bound lock";
function processDomain() {
  const pidNamespace = readlinkSync("/proc/self/ns/pid");
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^pid:\[\d+\]$/.test(pidNamespace) || !z.uuid().safeParse(bootId).success)
    fail("bound lock process domain is unavailable");
  return { pidNamespace, bootId };
}
function pin(value: { dev: bigint; ino: bigint; mode: bigint; uid: bigint; gid: bigint }) {
  return { dev: String(value.dev), ino: String(value.ino), ...permissions(value) };
}
function boundLockContext(options: BoundLockOptions) {
  const root = resolve(options.root), sidecar = resolve(options.sidecar);
  if (options.mode !== "isolated-experiment" || process.platform !== "linux" || root !== options.root
    || sidecar !== options.sidecar || realpathSync(root) !== root
    || !isTrustedLinuxRootWriterFence(options.fence, root) || !metadataSchema.shape.id.safeParse(options.entryId).success
    || !z.uuid().safeParse(options.workspaceId).success || !z.uuid().safeParse(options.operationId).success
    || !z.uuid().safeParse(options.attemptId).success || !/^[A-Za-z0-9_-]{1,128}$/.test(options.targetId)
    || sidecar !== join(dirname(dirname(sidecar)), "experimental-next", `${options.targetId}.original-trash.sqlite`)
    || basename(dirname(dirname(sidecar))) !== "github-sync" || realpathSync(dirname(sidecar)) !== dirname(sidecar)
    || !relative(root, sidecar).startsWith(`..${sep}`))
    fail("bound lock requires the isolated source, workspace and exclusive root fence");
  options.fence.assertHeld();
  directory(dirname(dirname(dirname(sidecar))));
  directory(dirname(dirname(sidecar)));
  const parent = directory(dirname(sidecar));
  if ((parent.mode & 0o077n) !== 0n) fail("bound lock journal parent is not private");
  const rootStat = directory(root), source = sourceFromSidecar(sidecar);
  if (source.source.root !== root || source.source.rootDev !== String(rootStat.dev)
    || source.source.rootIno !== String(rootStat.ino) || JSON.stringify(source.source.rootPermissions) !== JSON.stringify(permissions(rootStat))
    || source.entries.filter(entry => entry.metadata.id === options.entryId).length !== 1)
    fail("bound lock original source identity differs");
  const workspace = readStable(join(root, ".pkm-next-workspace"), 4096);
  if ((workspace.mode & 0o077) !== 0) fail("bound lock workspace marker is not private");
  const marker = z.strictObject({ schema: z.literal("pkm.next-workspace/v2"), id: z.uuid() })
    .parse(JSON.parse(workspace.bytes.toString("utf8")));
  if (marker.id !== options.workspaceId) fail("bound lock workspace identity differs");
  validateOriginalTrashBeforeMovement(root, source, options.entryId);
  const pkm = directory(join(root, ".pkm")), state = directory(join(root, ".pkm", "state"));
  const pkmPin = source.source.stateDirectories?.[0];
  const statePin = source.source.stateDirectories?.[1];
  if (!pkmPin || !statePin || JSON.stringify(pin(pkm)) !== JSON.stringify(pkmPin)
    || JSON.stringify(pin(state)) !== JSON.stringify(statePin)) fail("bound lock state directory changed");
  const path = join(dirname(sidecar), `${options.targetId}.original-trash-lock-${options.operationId}-${options.attemptId}.sqlite`);
  const journalLock = join(root, ".pkm", "state", "knowledge-deletions.json.lock");
  return { root, source, rootPin: pin(rootStat),
    workspacePin: { dev: workspace.dev, ino: workspace.ino, mode: workspace.mode, uid: workspace.uid, gid: workspace.gid },
    workspaceSha256: workspace.sha256, workspaceMtimeNs: workspace.mtimeNs, workspaceCtimeNs: workspace.ctimeNs, path, journalLock };
}
function boundRow(db: DatabaseSync, kind: string): { body: string; sha256: string } | undefined {
  const row = db.prepare("SELECT body,sha256 FROM lock_records WHERE kind=?").get(kind);
  if (!row) return undefined;
  if (typeof row.body !== "string" || typeof row.sha256 !== "string" || hash(row.body) !== row.sha256)
    fail("bound lock journal record is corrupt");
  return { body: row.body, sha256: row.sha256 };
}
function putBoundRow(db: DatabaseSync, kind: string, value: unknown) {
  const body = JSON.stringify(value);
  db.prepare("INSERT INTO lock_records VALUES(?,?,?)").run(kind, body, hash(body));
}
function assertBoundIntent(intent: z.infer<typeof boundIntentSchema>, options: BoundLockOptions,
  context: ReturnType<typeof boundLockContext>) {
  if (intent.root !== context.root || JSON.stringify(intent.rootPin) !== JSON.stringify(context.rootPin)
    || intent.workspaceId !== options.workspaceId || JSON.stringify(intent.workspacePin) !== JSON.stringify(context.workspacePin)
    || intent.workspaceSha256 !== context.workspaceSha256 || intent.workspaceMtimeNs !== context.workspaceMtimeNs
    || intent.workspaceCtimeNs !== context.workspaceCtimeNs || intent.sourceSha256 !== context.source.sha256
    || intent.entryId !== options.entryId || intent.targetId !== options.targetId
    || intent.operationId !== options.operationId || intent.attemptId !== options.attemptId)
    fail("bound lock intent is not the exact source, workspace and operation");
}
function assertBoundLiveJournal(options: BoundLockRecoveryOptions, context: ReturnType<typeof boundLockContext>) {
  const journal = join(context.root, ".pkm", "state", "knowledge-deletions.json");
  const current = readStable(journal, 2 * 1024 * 1024), original = context.source.source.journal;
  const temp = `${journal}.${options.entryId}.next-restore-tmp`;
  const isBefore = current.sha256 === original.sha256 && current.dev === original.dev && current.ino === original.ino
    && current.mode === original.mode && current.uid === original.uid && current.gid === original.gid
    && current.mtimeNs === original.mtimeNs && current.ctimeNs === original.ctimeNs;
  const hasTemp = exists(temp);
  const path = `${options.sidecar}.journal-${options.entryId}`, effectPath = `${path}.effect`;
  const sidecarExists = (file: string) => ["", "-journal", "-wal", "-shm"].some(suffix => exists(`${file}${suffix}`));
  if (isBefore && !hasTemp) {
    if (!sidecarExists(path) && !sidecarExists(effectPath)) {
      if (options.transitionSha256 || options.transitionEffectSha256)
        fail("bound recovery journal pointers have no transition");
      return;
    }
    if (!options.transitionSha256 || sidecarExists(effectPath) || options.transitionEffectSha256)
      fail("bound recovery cannot classify an unresolved journal transition without its staged effect");
  }
  if (!options.transitionSha256 || (!isBefore || hasTemp) && !options.transitionEffectSha256)
    fail("bound recovery has no trusted journal successor pointers");
  if (!exists(path)) fail("bound recovery journal successor is missing");
  const intentDb = openSidecar(path, transitionDdl, undefined, "bound-transition-read-");
  let transition: z.infer<typeof transitionSchema>, transitionSha256: string;
  try {
    const row = intentDb.prepare("SELECT body,sha256 FROM transition WHERE singleton=1").get();
    if (!row || typeof row.body !== "string" || row.sha256 !== hash(row.body)
      || row.sha256 !== options.transitionSha256) fail("bound journal transition pointer differs");
    transition = transitionSchema.parse(JSON.parse(row.body)); transitionSha256 = String(row.sha256);
    intentDb.exec("COMMIT");
  } catch (error) {
    if (intentDb.isTransaction) intentDb.exec("ROLLBACK");
    throw error;
  } finally { intentDb.close(); }
  const preview = previewExperimentalOriginalSkillRestoreJournal(context.source, options.entryId);
  if (transition.root !== context.root || transition.rootDev !== context.rootPin.dev || transition.rootIno !== context.rootPin.ino
    || transition.sourceSha256 !== context.source.sha256 || transition.entryId !== options.entryId
    || transition.operationId !== options.operationId
    || transition.beforeSha256 !== preview.beforeSha256 || transition.afterSha256 !== preview.afterSha256
    || transition.beforeBase64 !== context.source.originalJournalBase64 || transition.afterBase64 !== preview.afterBase64
    || transition.beforeDev !== original.dev || transition.beforeIno !== original.ino
    || transition.beforeMtimeNs !== original.mtimeNs || transition.beforeCtimeNs !== original.ctimeNs
    || transition.mode !== original.mode || transition.uid !== original.uid || transition.gid !== original.gid)
    fail("bound journal transition differs from its original source and operation");
  if (isBefore && !hasTemp) return;
  if (!exists(effectPath)) fail("bound recovery journal successor is missing");
  const effectDb = openSidecar(effectPath, effectDdl, undefined, "bound-transition-effect-read-");
  try {
    const row = effectDb.prepare("SELECT body,sha256 FROM effect WHERE singleton=1").get();
    if (!row || typeof row.body !== "string" || row.sha256 !== hash(row.body)
      || row.sha256 !== options.transitionEffectSha256) fail("bound journal effect pointer differs");
    const effect = effectSchema.parse(JSON.parse(row.body));
    const staged = isBefore && hasTemp ? readStable(temp, 2 * 1024 * 1024) : current;
    if (effect.transitionSha256 !== transitionSha256 || (!isBefore && hasTemp)
      || staged.sha256 !== preview.afterSha256 || !staged.bytes.equals(Buffer.from(preview.afterBase64, "base64"))
      || staged.dev !== effect.tempDev || staged.ino !== effect.tempIno || staged.mtimeNs !== effect.tempMtimeNs
      || staged.mode !== transition.mode || staged.uid !== transition.uid || staged.gid !== transition.gid)
      fail("bound journal successor differs from its committed exact effect");
    effectDb.exec("COMMIT");
  } catch (error) {
    if (effectDb.isTransaction) effectDb.exec("ROLLBACK");
    throw error;
  } finally { effectDb.close(); }
}

/** Isolated lock protocol only; it does not authorize or execute a restore. */
export function prepareExperimentalBoundOriginalJournalLock(options: BoundLockOptions) {
  const context = boundLockContext(options);
  if (exists(context.path)) fail("bound lock attempt already exists");
  if (exists(context.journalLock)) fail("an original journal lock already exists");
  const intent = boundIntentSchema.parse({
    schema: "pkm.experimental-original-journal-lock-intent/v1", root: context.root, rootPin: context.rootPin,
    workspaceId: options.workspaceId, workspacePin: context.workspacePin, workspaceSha256: context.workspaceSha256,
    workspaceMtimeNs: context.workspaceMtimeNs, workspaceCtimeNs: context.workspaceCtimeNs,
    sourceSha256: context.source.sha256, entryId: options.entryId, targetId: options.targetId,
    operationId: options.operationId, attemptId: options.attemptId, nonce: randomUUID(), pid: process.pid,
    ...processDomain(), acquiredAt: Date.now(),
  });
  const db = openSidecar(context.path, boundLockDdl, options.faultInjector, "bound-prepare-", true);
  try {
    if (boundRow(db, "intent")) fail("bound lock attempt already exists");
    putBoundRow(db, "intent", intent);
    options.faultInjector?.("bound-prepare-written");
    options.fence.assertHeld();
    db.exec("COMMIT");
    options.faultInjector?.("bound-prepare-committed");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally { db.close(); }
  return { journal: context.path, intent, intentSha256: hash(JSON.stringify(intent)) };
}

/** Acquire exactly the precommitted nonce, pin the actual legacy lock, then run isolated work. */
export async function acquireExperimentalBoundOriginalJournalLock<T>(options: BoundLockAcquisitionOptions, work: () => Promise<T>) {
  const context = boundLockContext(options);
  if (typeof options.persistEffect !== "function") fail("bound lock requires a trusted durable effect pointer");
  if (!exists(context.path)) fail("bound lock intent is missing");
  const db = openSidecar(context.path, boundLockDdl, undefined, "bound-read-");
  let intent: z.infer<typeof boundIntentSchema>, intentSha256: string;
  try {
    const row = boundRow(db, "intent");
    if (!row || boundRow(db, "effect") || boundRow(db, "cleanup") || boundRow(db, "result"))
      fail("bound lock attempt is not an unused prepared intent");
    if (!/^[a-f0-9]{64}$/.test(options.intentSha256) || row.sha256 !== options.intentSha256)
      fail("bound lock intent pointer differs");
    intent = boundIntentSchema.parse(JSON.parse(row.body)); intentSha256 = row.sha256;
    assertBoundIntent(intent, options, context);
    const domain = processDomain();
    if (intent.pid !== process.pid || intent.pidNamespace !== domain.pidNamespace || intent.bootId !== domain.bootId)
      fail("bound lock intent belongs to another process domain");
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally { db.close(); }
  const lock = originalLockModule().withCrossProcessLockBound;
  if (typeof lock !== "function") fail("bound original lock implementation is unavailable");
  const result = await lock(context.journalLock, lockOwner, 10000, { nonce: intent.nonce, acquiredAt: intent.acquiredAt }, async () => {
    options.fence.assertHeld();
    options.faultInjector?.("bound-lock-acquired");
    await assertLinuxLegacyWritersQuiescent(context.root);
    assertBoundIntent(intent, options, boundLockContext(options));
    const lockDirectory = directory(context.journalLock), names = readdirSync(context.journalLock);
    const name = `${intent.nonce}.json`;
    if (names.length !== 1 || names[0] !== name) fail("bound lock directory contains unknown members");
    const member = readStable(join(context.journalLock, name), 4096);
    const expected = JSON.stringify({ pid: intent.pid, nonce: intent.nonce, acquiredAt: intent.acquiredAt, owner: lockOwner });
    if (member.bytes.toString("utf8") !== expected) fail("bound lock owner record changed");
    syncDirectory(context.journalLock);
    syncDirectory(dirname(context.journalLock));
    const effect = boundEffectSchema.parse({
      schema: "pkm.experimental-original-journal-lock-effect/v1", intentSha256,
      directory: pin(lockDirectory),
      member: { dev: member.dev, ino: member.ino, mode: member.mode, uid: member.uid, gid: member.gid },
      memberSha256: member.sha256, memberMtimeNs: member.mtimeNs, memberCtimeNs: member.ctimeNs,
    });
    const effectDb = openSidecar(context.path, boundLockDdl, undefined, "bound-effect-");
    try {
      const current = boundRow(effectDb, "intent");
      if (!current || current.sha256 !== intentSha256 || boundRow(effectDb, "effect"))
        fail("bound lock intent changed before effect commit");
      putBoundRow(effectDb, "effect", effect);
      options.faultInjector?.("bound-effect-written");
      options.fence.assertHeld();
      effectDb.exec("COMMIT");
      options.faultInjector?.("bound-effect-committed");
      if (options.persistEffect({ intentSha256, effectSha256: hash(JSON.stringify(effect)) }) !== undefined)
        fail("bound lock effect pointer must be persisted synchronously");
      options.faultInjector?.("bound-effect-anchored");
      options.fence.assertHeld();
    } catch (error) {
      if (effectDb.isTransaction) effectDb.exec("ROLLBACK");
      throw error;
    } finally { effectDb.close(); }
    const result = await work();
    options.fence.assertHeld();
    const releaseDb = openSidecar(context.path, boundLockDdl, undefined, "bound-release-");
    try {
      const current = boundRow(releaseDb, "intent"), committedEffect = boundRow(releaseDb, "effect");
      if (!current || current.sha256 !== intentSha256 || !committedEffect
        || committedEffect.body !== JSON.stringify(effect) || boundRow(releaseDb, "cleanup") || boundRow(releaseDb, "result"))
        fail("bound lock journal changed before release");
      putBoundRow(releaseDb, "cleanup", { schema: "pkm.experimental-original-journal-lock-cleanup/v1",
        intentSha256, effectSha256: committedEffect.sha256 });
      releaseDb.exec("COMMIT");
    } catch (error) {
      if (releaseDb.isTransaction) releaseDb.exec("ROLLBACK");
      throw error;
    } finally { releaseDb.close(); }
    return result;
  });
  options.fence.assertHeld();
  syncDirectory(dirname(context.journalLock));
  const resultDb = openSidecar(context.path, boundLockDdl, undefined, "bound-result-");
  try {
    const current = boundRow(resultDb, "intent"), effect = boundRow(resultDb, "effect"), cleanup = boundRow(resultDb, "cleanup");
    if (!current || current.sha256 !== intentSha256 || !effect || !cleanup || boundRow(resultDb, "result")
      || exists(context.journalLock)) fail("bound lock release is not exact");
    putBoundRow(resultDb, "result", { schema: "pkm.experimental-original-journal-lock-released/v1", intentSha256,
      effectSha256: effect.sha256, cleanupSha256: cleanup.sha256 });
    resultDb.exec("COMMIT");
  } catch (error) {
    if (resultDb.isTransaction) resultDb.exec("ROLLBACK");
    throw error;
  } finally { resultDb.close(); }
  return result;
}

/** Remove only a dead owner's exact, durably bound experimental lock. */
export async function recoverExperimentalBoundOriginalJournalLock(options: BoundLockRecoveryOptions) {
  boundLockContext(options);
  await assertLinuxLegacyWritersQuiescent(options.root);
  const context = boundLockContext(options);
  if (!exists(context.path)) fail("bound lock recovery intent is missing");
  const db = openSidecar(context.path, boundLockDdl, undefined, "bound-recovery-");
  try {
    const row = boundRow(db, "intent"), effectRow = boundRow(db, "effect");
    if (!row || boundRow(db, "result")) fail("bound lock recovery requires an exact unresolved intent");
    if (!/^[a-f0-9]{64}$/.test(options.intentSha256) || row.sha256 !== options.intentSha256)
      fail("bound lock intent pointer differs");
    const intent = boundIntentSchema.parse(JSON.parse(row.body));
    assertBoundIntent(intent, options, context);
    const domain = processDomain();
    if (intent.pidNamespace !== domain.pidNamespace || intent.bootId !== domain.bootId)
      fail("bound lock process domain differs; owner exit cannot be confirmed");
    try { process.kill(intent.pid, 0); fail("bound lock owner is still alive"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    assertBoundLiveJournal(options, context);
    if (!effectRow) {
      if (boundRow(db, "cleanup") || exists(context.journalLock)
        || exists(`${context.journalLock}.${intent.nonce}.pending`))
        fail("unbound original lock state requires review");
      putBoundRow(db, "result", { schema: "pkm.experimental-original-journal-lock-not-acquired/v1", intentSha256: row.sha256 });
      options.fence.assertHeld();
      db.exec("COMMIT");
      return { state: "not-acquired" as const, intentSha256: row.sha256 };
    }
    const effect = boundEffectSchema.parse(JSON.parse(effectRow.body));
    if (!options.effectSha256 || !/^[a-f0-9]{64}$/.test(options.effectSha256) || effectRow.sha256 !== options.effectSha256)
      fail("bound lock effect pointer differs or is missing");
    if (effect.intentSha256 !== row.sha256) fail("bound lock effect belongs to a different intent");
    const cleanup = { schema: "pkm.experimental-original-journal-lock-cleanup/v1",
      intentSha256: row.sha256, effectSha256: effectRow.sha256 };
    const priorCleanup = boundRow(db, "cleanup");
    if (priorCleanup && priorCleanup.body !== JSON.stringify(cleanup)) fail("bound lock cleanup intent changed");
    const lockDirectory = directory(context.journalLock), names = readdirSync(context.journalLock);
    const name = `${intent.nonce}.json`, member = readStable(join(context.journalLock, name), 4096);
    const expected = JSON.stringify({ pid: intent.pid, nonce: intent.nonce, acquiredAt: intent.acquiredAt, owner: lockOwner });
    if (names.length !== 1 || names[0] !== name || JSON.stringify(pin(lockDirectory)) !== JSON.stringify(effect.directory)
      || JSON.stringify({ dev: member.dev, ino: member.ino, mode: member.mode, uid: member.uid, gid: member.gid }) !== JSON.stringify(effect.member)
      || member.sha256 !== effect.memberSha256 || member.bytes.toString("utf8") !== expected
      || member.mtimeNs !== effect.memberMtimeNs || member.ctimeNs !== effect.memberCtimeNs)
      fail("bound lock identity or members changed");
    if (!priorCleanup) putBoundRow(db, "cleanup", cleanup);
    options.fence.assertHeld();
    db.exec("COMMIT");
    options.faultInjector?.("bound-cleanup-committed");
    options.fence.assertHeld();
    const rechecked = readStable(join(context.journalLock, name), 4096);
    if (rechecked.dev !== member.dev || rechecked.ino !== member.ino || rechecked.sha256 !== member.sha256
      || rechecked.mtimeNs !== member.mtimeNs || rechecked.ctimeNs !== member.ctimeNs
      || JSON.stringify(pin(directory(context.journalLock))) !== JSON.stringify(effect.directory)
      || JSON.stringify(readdirSync(context.journalLock)) !== JSON.stringify([name]))
      fail("bound lock changed before cleanup");
    unlinkSync(join(context.journalLock, name));
    rmdirSync(context.journalLock);
    syncDirectory(dirname(context.journalLock));
    options.faultInjector?.("bound-lock-removed");
    db.exec("BEGIN IMMEDIATE");
    if (boundRow(db, "result") || boundRow(db, "intent")?.sha256 !== row.sha256
      || boundRow(db, "effect")?.sha256 !== effectRow.sha256
      || boundRow(db, "cleanup")?.body !== JSON.stringify(cleanup))
      fail("bound lock journal changed after cleanup");
    putBoundRow(db, "result", { schema: "pkm.experimental-original-journal-lock-reconciled/v1",
      intentSha256: row.sha256, effectSha256: effectRow.sha256 });
    db.exec("COMMIT");
    return { state: "reconciled" as const, intentSha256: row.sha256, effectSha256: effectRow.sha256 };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally { db.close(); }
}

/**
 * Isolated journal-only experiment. It does not move Trash payloads or authorize adoption/Sync.
 * The old journal lock and held root fence cover every classification and replacement.
 */
export async function transitionExperimentalOriginalRestoreJournal(options: OriginalTrashPreparation & {
  entryId: string;
  boundLock?: Pick<BoundLockAcquisitionOptions, "workspaceId" | "operationId" | "attemptId" | "intentSha256" | "persistEffect"> & {
    resumeJournalIntentSha256?: string;
    resumeJournalEffectSha256?: string;
    persistJournalIntent: (binding: { transitionSha256: string }) => void;
    persistJournalEffect: (binding: { transitionSha256: string; transitionEffectSha256: string }) => void;
  };
}) {
  const root = resolve(options.root), sidecar = resolve(options.sidecar);
  if (options.mode !== "isolated-experiment" || process.platform !== "linux" || root !== options.root
    || sidecar !== options.sidecar || realpathSync(root) !== root
    || !/^[A-Za-z0-9_-]{1,128}$/.test(options.targetId)
    || !isTrustedLinuxRootWriterFence(options.fence, root) || !metadataSchema.shape.id.safeParse(options.entryId).success
    || sidecar !== join(dirname(dirname(sidecar)), "experimental-next", `${options.targetId}.original-trash.sqlite`)
    || basename(dirname(dirname(sidecar))) !== "github-sync" || realpathSync(dirname(sidecar)) !== dirname(sidecar)
    || !relative(root, sidecar).startsWith(`..${sep}`))
    fail("requires a real isolated root fence and its private original sidecar");
  const dir = directory(dirname(sidecar));
  if ((dir.mode & 0o077n) !== 0n) fail("sidecar parent is not private");
  const intentPath = `${sidecar}.journal-${options.entryId}`;
  const effectPath = `${intentPath}.effect`;
  const journal = join(root, ".pkm", "state", "knowledge-deletions.json");
  const temp = `${journal}.${options.entryId}.next-restore-tmp`;
  if (!exists(intentPath)) {
    if (exists(temp) || exists(effectPath)) fail("unknown journal transition state");
    await prepareExperimentalInPlaceSkillTrash(options);
  }
  const withLock = originalCrossProcessLock();
  const execute = async () => {
    options.fence.assertHeld();
    await assertLinuxLegacyWritersQuiescent(root);
    const prepared = sourceFromSidecar(sidecar);
    const preview = validateOriginalTrashBeforeMovement(root, prepared, options.entryId);
    const source = prepared.source;
    const originalJournal = Buffer.from(prepared.originalJournalBase64, "base64");
    const after = Buffer.from(preview.afterBase64, "base64");
    let intent = transitionSchema.optional().parse(undefined);
    const db = openSidecar(intentPath, transitionDdl, options.faultInjector, "transition-");
    try {
      const row = db.prepare("SELECT body,sha256 FROM transition WHERE singleton=1").get();
      if (row) {
        if (typeof row.body !== "string" || row.sha256 !== hash(row.body)) fail("unknown journal transition intent");
        if (options.boundLock && row.sha256 !== options.boundLock.resumeJournalIntentSha256)
          fail("existing journal transition has no matching trusted resume pointer");
        intent = transitionSchema.parse(JSON.parse(row.body));
      } else {
        if (options.boundLock?.resumeJournalIntentSha256 || options.boundLock?.resumeJournalEffectSha256)
          fail("trusted resume pointers have no existing journal transition");
        if (exists(temp) || exists(effectPath)) fail("unknown journal transition state");
        const before = readStable(journal, 2 * 1024 * 1024);
        if (!before.bytes.equals(originalJournal) || before.sha256 !== preview.beforeSha256
          || before.dev !== source.journal.dev || before.ino !== source.journal.ino
          || before.mtimeNs !== source.journal.mtimeNs || before.ctimeNs !== source.journal.ctimeNs)
          fail("original journal is not the exact prepared before-image");
        intent = transitionSchema.parse({ schema: "pkm.experimental-original-journal-transition/v1",
          root, rootDev: preview.rootDev, rootIno: preview.rootIno, sourceSha256: prepared.sha256,
          entryId: options.entryId, beforeSha256: preview.beforeSha256, afterSha256: preview.afterSha256,
          ...(options.boundLock ? { operationId: options.boundLock.operationId } : {}),
          beforeBase64: prepared.originalJournalBase64, afterBase64: preview.afterBase64,
          beforeDev: before.dev, beforeIno: before.ino, beforeMtimeNs: before.mtimeNs, beforeCtimeNs: before.ctimeNs,
          mode: before.mode, uid: before.uid, gid: before.gid });
        const body = JSON.stringify(intent);
        db.prepare("INSERT INTO transition VALUES(1,?,?)").run(body, hash(body));
      }
      if (intent.root !== root || intent.rootDev !== preview.rootDev || intent.rootIno !== preview.rootIno
        || intent.sourceSha256 !== prepared.sha256 || intent.entryId !== options.entryId
        || intent.operationId !== options.boundLock?.operationId
        || intent.beforeSha256 !== preview.beforeSha256 || intent.afterSha256 !== preview.afterSha256
        || intent.beforeBase64 !== prepared.originalJournalBase64 || intent.afterBase64 !== preview.afterBase64
        || intent.beforeDev !== source.journal.dev || intent.beforeIno !== source.journal.ino
        || intent.beforeMtimeNs !== source.journal.mtimeNs || intent.beforeCtimeNs !== source.journal.ctimeNs
        || intent.mode !== source.journal.mode || intent.uid !== source.journal.uid || intent.gid !== source.journal.gid)
        fail("journal transition intent differs from the original source");
      options.faultInjector?.("transition-intent-written");
      db.exec("COMMIT");
      options.faultInjector?.("transition-intent-committed");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    } finally { db.close(); }
    const body = JSON.stringify(intent), transitionSha256 = hash(body);
    if (options.boundLock) {
      if (typeof options.boundLock.persistJournalIntent !== "function"
        || options.boundLock.persistJournalIntent({ transitionSha256 }) !== undefined)
        fail("journal transition pointer must be persisted synchronously");
      options.faultInjector?.("transition-intent-anchored");
    }
    const current = readStable(journal, 2 * 1024 * 1024);
    if (current.mode !== intent.mode || current.uid !== intent.uid || current.gid !== intent.gid)
      fail("journal transition permissions changed");
    let effect: z.infer<typeof effectSchema> | undefined;
    if (exists(effectPath)) {
      const effectDb = openSidecar(effectPath, effectDdl, options.faultInjector, "effect-");
      try {
        const row = effectDb.prepare("SELECT body,sha256 FROM effect WHERE singleton=1").get();
        if (!row || typeof row.body !== "string" || row.sha256 !== hash(row.body)) fail("unknown journal transition effect");
        if (options.boundLock && row.sha256 !== options.boundLock.resumeJournalEffectSha256)
          fail("existing journal effect has no matching trusted resume pointer");
        effect = effectSchema.parse(JSON.parse(row.body));
        if (effect.transitionSha256 !== transitionSha256) fail("journal effect belongs to another intent");
        effectDb.exec("COMMIT");
      } catch (error) {
        if (effectDb.isTransaction) effectDb.exec("ROLLBACK");
        throw error;
      } finally { effectDb.close(); }
      if (options.boundLock) {
        if (typeof options.boundLock.persistJournalEffect !== "function"
          || options.boundLock.persistJournalEffect({ transitionSha256, transitionEffectSha256: hash(JSON.stringify(effect)) }) !== undefined)
          fail("journal successor pointers must be persisted synchronously");
      }
    } else if (options.boundLock?.resumeJournalEffectSha256) {
      fail("trusted journal effect pointer has no existing effect");
    }
    if (current.sha256 === intent.afterSha256 && current.bytes.equals(after)) {
      if (!effect || current.dev !== effect.tempDev || current.ino !== effect.tempIno
        || current.mtimeNs !== effect.tempMtimeNs || exists(temp))
        fail("after-image has no exact recorded effect identity");
      return { state: "applied" as const, ...preview };
    }
    if (current.sha256 !== intent.beforeSha256 || !current.bytes.equals(originalJournal)
      || current.dev !== intent.beforeDev || current.ino !== intent.beforeIno
      || current.mtimeNs !== intent.beforeMtimeNs || current.ctimeNs !== intent.beforeCtimeNs)
      fail("unknown journal transition state");
    if (!effect) {
      if (exists(temp)) fail("unknown journal transition temporary");
      const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, intent.mode);
      try { fchmodSync(fd, intent.mode); writeFileSync(fd, after); fsyncSync(fd); }
      finally { closeSync(fd); }
      syncDirectory(dirname(temp));
      options.faultInjector?.("transition-temporary-written");
      const staged = readStable(temp, 2 * 1024 * 1024);
      if (!staged.bytes.equals(after) || staged.mode !== intent.mode || staged.uid !== intent.uid || staged.gid !== intent.gid)
        fail("staged journal does not preserve exact bytes and permissions");
      effect = effectSchema.parse({ schema: "pkm.experimental-original-journal-effect/v1", transitionSha256,
        tempDev: staged.dev, tempIno: staged.ino, tempMtimeNs: staged.mtimeNs });
      const effectDb = openSidecar(effectPath, effectDdl, options.faultInjector, "effect-");
      try {
        const effectBody = JSON.stringify(effect);
        effectDb.prepare("INSERT INTO effect VALUES(1,?,?)").run(effectBody, hash(effectBody));
        options.faultInjector?.("transition-effect-written");
        effectDb.exec("COMMIT");
        options.faultInjector?.("transition-effect-durable");
      } catch (error) {
        if (effectDb.isTransaction) effectDb.exec("ROLLBACK");
        throw error;
      } finally { effectDb.close(); }
      options.faultInjector?.("transition-effect-committed");
    }
    const staged = readStable(temp, 2 * 1024 * 1024), before = readStable(journal, 2 * 1024 * 1024);
    if (!staged.bytes.equals(after) || staged.dev !== effect.tempDev || staged.ino !== effect.tempIno
      || staged.mtimeNs !== effect.tempMtimeNs || staged.mode !== intent.mode || staged.uid !== intent.uid || staged.gid !== intent.gid
      || before.sha256 !== intent.beforeSha256 || before.mode !== intent.mode || before.uid !== intent.uid || before.gid !== intent.gid
      || before.dev !== intent.beforeDev || before.ino !== intent.beforeIno
      || before.mtimeNs !== intent.beforeMtimeNs || before.ctimeNs !== intent.beforeCtimeNs)
      fail("journal changed before controlled atomic replacement");
    if (options.boundLock) {
      if (typeof options.boundLock.persistJournalEffect !== "function"
        || options.boundLock.persistJournalEffect({ transitionSha256, transitionEffectSha256: hash(JSON.stringify(effect)) }) !== undefined)
        fail("journal successor pointers must be persisted synchronously");
      options.faultInjector?.("transition-effect-anchored");
    }
    options.fence.assertHeld();
    await assertLinuxLegacyWritersQuiescent(root);
    renameSync(temp, journal);
    syncDirectory(dirname(journal));
    options.faultInjector?.("transition-applied");
    const result = readStable(journal, 2 * 1024 * 1024);
    if (!result.bytes.equals(after) || result.dev !== effect.tempDev || result.ino !== effect.tempIno
      || result.mtimeNs !== effect.tempMtimeNs || result.mode !== intent.mode || result.uid !== intent.uid || result.gid !== intent.gid)
      fail("journal after-image differs from the controlled effect");
    return { state: "applied" as const, ...preview };
  };
  if (options.boundLock)
    return acquireExperimentalBoundOriginalJournalLock({ ...options, ...options.boundLock }, execute);
  return withLock(`${journal}.lock`, "experimental original journal transition", 10000, execute);
}
