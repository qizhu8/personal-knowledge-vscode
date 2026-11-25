import { createHash, randomUUID } from "node:crypto";
import { coreDatabasePath } from "./workspace-storage-paths.js";
import {
  chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError, type Actor } from "./contracts.js";
import type { Storage } from "./storage.js";
import { runLegacyMcpPython } from "./legacy-mcp-python.js";
import { decodeMarkdown, scanMarkdown } from "./markdown.js";
import { documentPath } from "./document-path.js";
import { MigrationRuntime } from "./migration-runtime.js";
import { previewTrashLifecycle } from "./trash-lifecycle.js";
import { verifySnapshotSchedule } from "./legacy-knowledge-snapshot-scheduler-state.js";
import { inspectLegacyRootPkmPrivacyState } from "./legacy-root-pkm-state.js";
import { assertOriginalMcpPrivacy } from "./original-mcp-root-custody.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => JSON.stringify(value);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const areas = ["skills", "notes", "papers", "prompts", "scripts"] as const;
const stateRelative = "packages/knowledge-snapshots";
const tools = ["knowledge_snapshot_status", "knowledge_snapshot_create", "knowledge_snapshot_configure",
  "knowledge_snapshot_restore_preview", "knowledge_snapshot_restore_apply"] as const;
const toolSchema = z.enum(tools);
const defaultTools = tools.filter(tool => tool !== "knowledge_snapshot_configure");
const rowSchema = z.strictObject({ path: z.string(), bytes: z.string(), sha256: digest, mode: z.number().int().min(0).max(0o777) });
const treeSchema = z.strictObject({ directories: z.array(z.string()), files: z.array(rowSchema) });
type Tree = z.infer<typeof treeSchema>;
const admissionSchema = z.strictObject({ workspaceId: z.string(), workspaceRoot: z.string(), actorId: z.literal("mcp:external"),
  authorityId: z.string().min(1), privateGitRoot: z.string(), rootPin: z.string(),
  allowedTools: z.array(toolSchema).min(1).refine(value => new Set(value).size === value.length) });
type Admission = z.infer<typeof admissionSchema>;
const ddl = `
CREATE TABLE IF NOT EXISTS legacy_knowledge_snapshot_admission(singleton INTEGER PRIMARY KEY CHECK(singleton=1),payload TEXT NOT NULL,sha256 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS legacy_knowledge_snapshot_events(sequence INTEGER PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,sha256 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS legacy_knowledge_snapshot_intent(singleton INTEGER PRIMARY KEY CHECK(singleton=1),payload TEXT NOT NULL,sha256 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS legacy_knowledge_snapshot_stage(singleton INTEGER PRIMARY KEY CHECK(singleton=1),operation_id TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS legacy_knowledge_snapshot_admission_no_update BEFORE UPDATE ON legacy_knowledge_snapshot_admission BEGIN SELECT RAISE(ABORT,'snapshot admission immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_knowledge_snapshot_admission_no_delete BEFORE DELETE ON legacy_knowledge_snapshot_admission BEGIN SELECT RAISE(ABORT,'snapshot admission immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_knowledge_snapshot_events_no_update BEFORE UPDATE ON legacy_knowledge_snapshot_events BEGIN SELECT RAISE(ABORT,'snapshot event immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_knowledge_snapshot_events_no_delete BEFORE DELETE ON legacy_knowledge_snapshot_events BEGIN SELECT RAISE(ABORT,'snapshot event immutable'); END;`;
const invocationSchema = z.strictObject({
  tool: toolSchema,
  args: z.record(z.string(), z.unknown()), operationId: z.string().uuid(),
});
const changeSchema = z.strictObject({ path: z.string(), before_sha256: digest.nullable(),
  target: z.object({ object: z.string().regex(/^[a-f0-9]{40}$/), mode: z.enum(["100644", "100755"]), sha256: digest,
    bytes: z.string().optional() }).nullable(), action: z.enum(["restore", "trash"]),
});
const intentSchema = z.strictObject({
  admission: admissionSchema, operationId: z.string().uuid(), fingerprint: digest,
  tool: z.string(), args: z.record(z.string(), z.unknown()), before: treeSchema, after: treeSchema,
  result: z.record(z.string(), z.unknown()), corpus: digest, changes: z.array(changeSchema),
  cursor: z.number().int().nonnegative(), published: z.boolean(),
  trashOperationId: z.string().uuid().nullable(),
  targetCorpus: digest.nullable(),
  beforeInventory: z.record(z.string(), z.strictObject({ mode: z.enum(["100644", "100755"]), sha256: digest })),
  schedulerApplied: z.boolean(),
  privacySha256: digest.nullable(),
});
type Intent = z.infer<typeof intentSchema>;
export interface LegacyKnowledgeSnapshotBinding {
  workspaceId: string; workspaceRoot: string; actorId: string; authorityId: string; privateGitRoot: string;
  rootPin?: string;
  allowedTools: readonly z.infer<typeof toolSchema>[];
}
export interface LegacyKnowledgeSnapshotHost {
  authorize(binding: Readonly<LegacyKnowledgeSnapshotBinding & { operation: string }>): boolean;
  /** Must durably install/remove the exact host-owned schedule, idempotently by operationId. */
  configureSchedule?(request: Readonly<LegacyKnowledgeSnapshotBinding & {
    enabled: boolean; local_time: string; timezone: string; unit: string; operationId: string;
  }>): Promise<void>;
  checkpoint?(phase: string): void;
}
function fail(code: string, message: string, unknown = false): never { throw new CoreError(code, message, unknown ? "unknown" : undefined); }
const pin = (path: string) => { const stat = lstatSync(path); return `${stat.dev}:${stat.ino}`; };
function checkedRoot(path: string) {
  if (resolve(path) !== path) fail("UNSAFE_PATH", "Snapshot host roots must be exact canonical absolute paths.");
  for (let current = path;; current = dirname(current)) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("UNSAFE_PATH", "Snapshot roots must not contain links.");
    if (dirname(current) === current) break;
  }
  if (realpathSync(path) !== path) fail("UNSAFE_PATH", "Snapshot roots cannot be aliases.");
}
function safePath(path: string) {
  if (!path || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === ".." || /[\u0000-\u001f:]/.test(part)))
    fail("UNSAFE_PATH", "Snapshot path is not a safe relative content path.");
}
function regularBytes(path: string, links = 1): Buffer {
  checkedRoot(dirname(path));
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== links)
    fail("UNSAFE_PATH", "Snapshot data must be exact owned, unlinked regular files.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd), bytes = readFileSync(fd), after = fstatSync(fd), current = lstatSync(path);
    checkedRoot(dirname(path));
    const fields = ["dev", "ino", "size", "mtimeMs", "ctimeMs", "mode", "nlink"] as const;
    if ([opened, after, current].some(stat => !stat.isFile() || stat.isSymbolicLink()
      || fields.some(field => stat[field] !== before[field])) || bytes.length !== before.size)
      fail("SOURCE_CHANGED", "Snapshot data changed while being read through its pinned file descriptor.");
    return bytes;
  } finally { closeSync(fd); }
}
function tree(root: string, absent = false, publication?: Pick<Intent, "operationId" | "after">): Tree {
  const directories: string[] = [], files: Tree["files"] = [];
  if (!lstatSync(root, { throwIfNoEntry: false })) {
    if (absent) return { directories, files };
    fail("INVALID_WORKSPACE", "Snapshot repository state is missing.");
  }
  checkedRoot(root);
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), address = relative(root, path).split("\\").join("/");
      safePath(address);
      const stat = lstatSync(path);
      if (publication && name === `.pkm-snapshot-${publication.operationId}`) {
        if (!stat.isFile() || stat.isSymbolicLink() || ![1, 2].includes(stat.nlink))
          fail("RECOVERY_CONFLICT", "Private Git temporary publication is not owned regular data.", true);
        if (stat.nlink === 2 && !publication.after.files.some(row => {
          if (dirname(row.path) !== dirname(address)) return false;
          const target = lstatSync(join(root, row.path), { throwIfNoEntry: false });
          return target?.isFile() && !target.isSymbolicLink() && target.ino === stat.ino && target.dev === stat.dev && target.nlink === 2;
        })) fail("RECOVERY_CONFLICT", "Private Git temporary has an unowned hardlink.", true);
        continue;
      }
      const ownedHardlink = stat.nlink === 2 && publication && (() => {
        const temporary = lstatSync(join(dirname(path), `.pkm-snapshot-${publication.operationId}`), { throwIfNoEntry: false });
        return temporary?.isFile() && !temporary.isSymbolicLink() && temporary.dev === stat.dev && temporary.ino === stat.ino && temporary.nlink === 2;
      })();
      if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1 && !ownedHardlink))
        fail("UNSAFE_PATH", "Snapshot state refuses linked or nonregular files.");
      if (stat.isDirectory()) { directories.push(address); walk(path); }
      else {
        const bytes = regularBytes(path, stat.nlink), after = lstatSync(path);
        if (stat.ino !== after.ino || stat.dev !== after.dev || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs)
          fail("SOURCE_CHANGED", "Snapshot state changed during inspection.");
        files.push({ path: address, bytes: bytes.toString("base64"), sha256: hash(bytes), mode: stat.mode & 0o777 });
      }
    }
  };
  walk(root);
  return { directories, files };
}
function inspectActiveKnowledge(root: string) {
  for (const area of areas) {
    const base = join(root, area);
    if (!lstatSync(base, { throwIfNoEntry: false })) continue;
    checkedRoot(base);
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        if (name === ".git" || name === ".trash") continue;
        const path = join(directory, name), stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
          fail("UNSAFE_PATH", "Active Knowledge snapshots refuse linked and nonregular content.");
        if (stat.isDirectory()) walk(path);
      }
    };
    walk(base);
  }
}
function privacy(root: string): string | null {
  const directory = join(root, ".pkm");
  if (!lstatSync(directory, { throwIfNoEntry: false })) return null;
  checkedRoot(directory);
  try { return inspectLegacyRootPkmPrivacyState(root)?.privacySha256 ?? null; }
  catch { fail("INVALID_WORKSPACE", "Original .pkm state is not in the exact bounded privacy-only layout."); }
}
function checkedTree(value: unknown): Tree {
  const parsed = treeSchema.parse(value), names = new Set<string>();
  for (const row of parsed.files) {
    safePath(row.path);
    if (names.has(row.path) || hash(Buffer.from(row.bytes, "base64")) !== row.sha256
      || Buffer.from(row.bytes, "base64").toString("base64") !== row.bytes) fail("INVALID_WORKSPACE", "Snapshot tree payload changed.");
    names.add(row.path);
  }
  for (const path of parsed.directories) { safePath(path); if (names.has(path)) fail("INVALID_WORKSPACE", "Snapshot paths collide."); names.add(path); }
  return parsed;
}
function syncDirectory(path: string) {
  if (process.platform !== "win32") { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
}
function writeExclusive(path: string, bytes: Buffer, mode: number) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  chmodSync(path, mode);
  syncDirectory(dirname(path));
}
function materialize(root: string, value: Tree) {
  mkdirSync(root, { mode: 0o700, recursive: true });
  for (const path of value.directories) mkdirSync(join(root, path), { recursive: true, mode: 0o700 });
  for (const row of value.files) {
    mkdirSync(dirname(join(root, row.path)), { recursive: true, mode: 0o700 });
    writeExclusive(join(root, row.path), Buffer.from(row.bytes, "base64"), row.mode);
  }
}
async function original(root: string, state: string, operation: string, args: Record<string, unknown> = {}) {
  return await runLegacyMcpPython(fileURLToPath(new URL("../compat/legacy-knowledge-snapshots.py", import.meta.url)), [],
    { root, state, operation, args }) as Record<string, any>;
}
export async function legacyKnowledgeSnapshotTiming(storage: Storage, local_time: string, timezone: string, now: Date) {
  return original(storage.workspaceRoot(), join(storage.workspaceRoot(), stateRelative), "timing",
    { local_time, timezone, now: now.toISOString() });
}
export function assertLegacyKnowledgeSnapshotHost(storage: Storage, db: DatabaseSync, actor: Actor,
  host: LegacyKnowledgeSnapshotHost, operation: string) {
  storage.assertWorkspaceLease();
  const admission = active(db);
  if (!admission) fail("ACCESS_DENIED", "Native snapshot host requires its immutable admission.");
  authorize(admission, actor, host, operation, storage.workspaceRoot());
  return admission;
}
export function inspectLegacyKnowledgeSnapshotSchedulerEnrollment(root: string, expectedSha256?: string): {
  schema: "pkm.native-snapshot-scheduler/v1"; workspaceId: string; actorId: "mcp:external"; admissionSha256: string;
};
export function inspectLegacyKnowledgeSnapshotSchedulerEnrollment(db: DatabaseSync, root: string, expectedSha256?: string): {
  schema: "pkm.native-snapshot-scheduler/v1"; workspaceId: string; actorId: "mcp:external"; admissionSha256: string;
};
export function inspectLegacyKnowledgeSnapshotSchedulerEnrollment(rootOrDb: string | DatabaseSync,
  rootOrSha?: string, expected?: string) {
  const owned = typeof rootOrDb === "string", root = owned ? rootOrDb : rootOrSha!;
  const expectedSha256 = owned ? rootOrSha : expected;
  checkedRoot(root);
  const path = coreDatabasePath(root), before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    fail("UNSAFE_PATH", "Scheduler enrollment requires an existing unlinked native database.");
  const db = owned ? new DatabaseSync(path, { readOnly: true }) : rootOrDb;
  try {
    const main = db.prepare("PRAGMA database_list").all().find(row => row.name === "main");
    if (!main?.file || resolve(String(main.file)) !== path)
      fail("ACCESS_DENIED", "Native scheduler enrollment inspection must use this exact workspace database.");
    if (owned) db.exec("BEGIN");
    verifyLegacyKnowledgeSnapshots(db, root);
    const admission = active(db);
    if (!admission || admission.actorId !== "mcp:external" || admission.workspaceRoot !== root || admission.rootPin !== pin(root)
      || admission.privateGitRoot !== join(root, stateRelative, "repository.git")
      || !["knowledge_snapshot_configure", "knowledge_snapshot_create"].every(tool => admission.allowedTools.some(allowed => allowed === tool)))
      fail("ACCESS_DENIED", "Native scheduler requires an existing exact-root enrollment authorizing configuration and creation.");
    const row = db.prepare("SELECT sha256 FROM legacy_knowledge_snapshot_admission WHERE singleton=1").get()!;
    if (expectedSha256 !== undefined && (!digest.safeParse(expectedSha256).success || row.sha256 !== expectedSha256))
      fail("ACCESS_DENIED", "Native scheduler admission digest differs from its immutable host opt-in.");
    const current = lstatSync(path);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.ino !== before.ino || current.dev !== before.dev)
      fail("SOURCE_CHANGED", "Native scheduler enrollment database identity changed during inspection.");
    if (owned) db.exec("COMMIT");
    return { schema: "pkm.native-snapshot-scheduler/v1" as const, workspaceId: admission.workspaceId,
      actorId: "mcp:external" as const, admissionSha256: String(row.sha256) };
  } finally { if (owned) db.close(); }
}
function transaction<T>(storage: Storage, db: DatabaseSync, work: () => T): T {
  storage.assertWorkspaceLease(); db.exec("BEGIN IMMEDIATE");
  try { const result = work(); storage.assertWorkspaceLease(); db.exec("COMMIT"); return result; }
  catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
}
function active(db: DatabaseSync): Admission | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_knowledge_snapshot_admission' AND type='table'").get()) return;
  const row = db.prepare("SELECT * FROM legacy_knowledge_snapshot_admission WHERE singleton=1").get();
  if (!row || hash(String(row.payload)) !== row.sha256) fail("INVALID_WORKSPACE", "Snapshot immutable admission is incomplete.");
  return admissionSchema.parse(JSON.parse(String(row.payload)));
}
function authorize(admission: Admission, actor: Actor, host: LegacyKnowledgeSnapshotHost, operation: string, root: string) {
  if (!actor || operation !== "knowledge_snapshot_status" && !actor.canWrite
    || actor.id !== admission.actorId || actor.boardWorker || root !== admission.workspaceRoot
    || pin(root) !== admission.rootPin || admission.privateGitRoot !== join(root, stateRelative, "repository.git")
    || !["admit", "reconcile"].includes(operation) && !admission.allowedTools.some(tool => tool === operation)
    || typeof host?.authorize !== "function" || host.authorize(Object.freeze({ ...admission, operation })) !== true)
    fail("ACCESS_DENIED", "Exact host-admitted snapshot actor, workspace and private local Git authority are required.");
}
export async function admitLegacyKnowledgeSnapshots(storage: Storage, actor: Actor, request: {
  authorityId: string; authorize: LegacyKnowledgeSnapshotHost["authorize"]; allowedTools?: z.infer<typeof toolSchema>[];
}) {
  if (!actor?.canWrite || actor.id !== "mcp:external" || actor.boardWorker || !request.authorityId?.trim())
    fail("ACCESS_DENIED", "Only the fixed native-host external principal can admit Knowledge snapshots.");
  const root = storage.workspaceRoot(), workspaceId = await storage.workspaceId();
  const proposed = { workspaceId, workspaceRoot: root, actorId: actor.id, authorityId: request.authorityId,
    privateGitRoot: join(root, stateRelative, "repository.git"),
    allowedTools: [...(request.allowedTools ?? defaultTools)] };
  if (typeof request.authorize !== "function" || request.authorize(Object.freeze({ ...proposed, operation: "admit" })) !== true)
    fail("ACCESS_DENIED", "Host snapshot approval is required before accessing a private repository.");
  return storage.withWorkspaceExclusive(async () => {
    checkedRoot(root);
    const db = storage.connectNative();
    try {
      const existing = active(db);
      if (existing) verifyLegacyKnowledgeSnapshots(db, root);
      else {
        const bootstrapPrivacySha256 = storage.rootAdoptionBootstrapPrivacySha256();
        if (bootstrapPrivacySha256) assertLegacyKnowledgeSnapshotAdoptionBootstrap(db, root, bootstrapPrivacySha256);
        else verifyLegacyKnowledgeSnapshots(db, root);
      }
      if (existing) {
        authorize(existing, actor, { authorize: request.authorize }, "admit", root);
        if (existing.authorityId !== request.authorityId || encode(existing.allowedTools) !== encode(proposed.allowedTools))
          fail("CONFLICT", "Snapshot admission already has a different immutable authority or tool scope.");
        return { privateGitRoot: existing.privateGitRoot, workspaceId };
      }
      if (lstatSync(join(root, stateRelative), { throwIfNoEntry: false })) fail("CONFLICT", "An unreceipted private snapshot root cannot be adopted.");
      if (![23, 24, 27, 28].includes(Number(db.prepare("PRAGMA user_version").get()?.user_version)))
        fail("INVALID_WORKSPACE", "Snapshot admission requires a supported native predecessor schema; no downgrade is permitted.");
      const admission = admissionSchema.parse({ ...proposed, rootPin: pin(root) });
      transaction(storage, db, () => {
        authorize(admission, { id: proposed.actorId, canWrite: true }, { authorize: request.authorize }, "admit", root);
        db.exec(ddl);
        db.exec(`PRAGMA user_version=${Math.max(25, Number(db.prepare("PRAGMA user_version").get()?.user_version))}`);
        const payload = encode(admission);
        db.prepare("INSERT INTO legacy_knowledge_snapshot_admission VALUES(1,?,?)").run(payload, hash(payload));
      });
      return { privateGitRoot: admission.privateGitRoot, workspaceId };
    } finally { db.close(); }
  });
}
function latestTree(db: DatabaseSync): Tree {
  const row = db.prepare("SELECT payload FROM legacy_knowledge_snapshot_events ORDER BY sequence DESC LIMIT 1").get();
  return row ? checkedTree(JSON.parse(String(row.payload)).state) : { directories: [], files: [] };
}
export function assertLegacyKnowledgeSnapshotPrivacyRoot(db: DatabaseSync, root: string): void {
  if (!active(db) || privacy(root) === null)
    fail("INVALID_WORKSPACE", "Original content privacy requires an explicitly admitted private snapshot workspace and exact policy file.");
  verifyLegacyKnowledgeSnapshots(db, root, true);
}
export function assertLegacyKnowledgeSnapshotAdoptionBootstrap(
  db: DatabaseSync, root: string, expectedPrivacySha256: string,
): void {
  const state = inspectLegacyRootPkmPrivacyState(root);
  if (!state || state.privacySha256 !== expectedPrivacySha256
    || !/^[a-f0-9]{64}$/.test(expectedPrivacySha256)) {
    fail("RECOVERY_REQUIRED", "Original .pkm bootstrap bytes differ from the pending adoption journal.");
  }
  const objects = db.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'legacy_knowledge_snapshot_*'").all();
  if (objects.length || lstatSync(join(root, stateRelative), { throwIfNoEntry: false })) {
    fail("RECOVERY_REQUIRED", "Snapshot bootstrap refuses existing admission, journal or private repository state.");
  }
}
export function verifyLegacyKnowledgeSnapshots(db: DatabaseSync, root: string, allowPending = false,
  archivedModes?: ReadonlyMap<string, number>) {
  if (assertOriginalMcpPrivacy(root)) {
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    if (![0, 23].includes(version)
      || db.prepare("SELECT 1 FROM sqlite_master WHERE name GLOB 'legacy_knowledge_snapshot_*' LIMIT 1").get())
      fail("INVALID_WORKSPACE", "Archive-only original MCP custody cannot activate private snapshot authority.");
    return;
  }
  const policy = privacy(root);
  const hasPrivacyDirectory = !!lstatSync(join(root, ".pkm"), { throwIfNoEntry: false });
  const schemaQuery = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name GLOB 'legacy_knowledge_snapshot_*' ORDER BY name";
  const objects = db.prepare(schemaQuery).all();
  if (objects.length) {
    const expected = new DatabaseSync(":memory:");
    try {
      expected.exec(ddl);
      if (encode(objects) !== encode(expected.prepare(schemaQuery).all()))
        fail("INVALID_WORKSPACE", "Private snapshot schema differs from its fixed native DDL.");
    } finally { expected.close(); }
  }
  const stageTable = db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_knowledge_snapshot_stage' AND type='table'").get();
  const stageOperation = stageTable ? db.prepare("SELECT operation_id FROM legacy_knowledge_snapshot_stage WHERE singleton=1").get()?.operation_id : undefined;
  if (stageOperation) z.string().uuid().parse(stageOperation);
  const packages = join(root, "packages");
  if (lstatSync(packages, { throwIfNoEntry: false })) {
    checkedRoot(packages);
    for (const name of readdirSync(packages).filter(name => name.startsWith(".snapshot-stage-"))) {
      if (name !== `.snapshot-stage-${stageOperation}`)
        fail("RECOVERY_CONFLICT", "An unowned private snapshot stage requires explicit host inspection.", true);
      tree(join(packages, name));
    }
  }
  if (stageOperation && !allowPending) fail("RECOVERY_REQUIRED", "Private snapshot preparation requires its exact host reconciliation.", true);
  const admission = active(db);
  verifySnapshotSchedule(db);
  if (hasPrivacyDirectory && (!admission || policy === null))
    fail("INVALID_WORKSPACE", "Generic or empty .pkm roots are not admitted native snapshot privacy.");
  if (!admission) {
    if ([25, 26].includes(Number(db.prepare("PRAGMA user_version").get()?.user_version)))
      fail("INVALID_WORKSPACE", "Schema25 requires its immutable private snapshot authority.");
    if (lstatSync(join(root, stateRelative), { throwIfNoEntry: false })) fail("INVALID_WORKSPACE", "Unreceipted private snapshot state is not authoritative.");
    return;
  }
  if (![25, 26, 27, 28].includes(Number(db.prepare("PRAGMA user_version").get()?.user_version)))
    fail("INVALID_WORKSPACE", "Private snapshot authority requires schema version25.");
  if (admission.workspaceId !== JSON.parse(regularBytes(join(root, ".pkm-next-workspace")).toString("utf8")).id
    || admission.privateGitRoot !== join(admission.workspaceRoot, stateRelative, "repository.git"))
    fail("INVALID_WORKSPACE", "Private snapshot admission is not bound to this workspace identity.");
  let previous: string | null = null;
  const seen = new Set<string>();
  for (const row of db.prepare("SELECT * FROM legacy_knowledge_snapshot_events ORDER BY sequence").all()) {
    const payload = String(row.payload);
    if (hash(payload) !== row.sha256) fail("INVALID_WORKSPACE", "Snapshot event digest changed.");
    const event = z.strictObject({ workspaceId: z.string(), actorId: z.literal("mcp:external"),
      operationId: z.string().uuid(), fingerprint: digest, tool: toolSchema, args: z.record(z.string(), z.unknown()),
      result: z.record(z.string(), z.unknown()), state: treeSchema, previous: digest.nullable() }).parse(JSON.parse(payload));
    if (event.previous !== previous || event.workspaceId !== admission.workspaceId || event.actorId !== admission.actorId
      || event.operationId !== row.operation_id || seen.has(event.operationId)
      || event.fingerprint !== hash(encode({ actorId: event.actorId, tool: event.tool, args: event.args, operationId: event.operationId })))
      fail("INVALID_WORKSPACE", "Snapshot event authority chain changed.");
    checkedTree(event.state); previous = String(row.sha256); seen.add(event.operationId);
  }
  const pending = db.prepare("SELECT * FROM legacy_knowledge_snapshot_intent WHERE singleton=1").get();
  if (pending) {
    if (hash(String(pending.payload)) !== pending.sha256) fail("RECOVERY_CONFLICT", "Snapshot intent digest changed.", true);
    const intent = intentSchema.parse(JSON.parse(String(pending.payload)));
    if (encode(intent.admission) !== encode(admission) || encode(intent.before) !== encode(latestTree(db)))
      fail("RECOVERY_CONFLICT", "Snapshot intent lost its immutable admission or parent state.", true);
    checkedTree(intent.after);
    inspectPublication(root, intent);
    if (!allowPending) fail("RECOVERY_REQUIRED", "Private snapshot mutation needs its exact explicitly authorized host reconciliation.", true);
    return;
  }
  const current = tree(join(root, stateRelative), true);
  if (archivedModes) {
    for (const row of current.files) {
      const mode = archivedModes.get(`${stateRelative}/${row.path}`);
      if (mode === undefined) fail("INVALID_WORKSPACE", "Private snapshot archive omitted an owned source mode.");
      row.mode = mode;
    }
  }
  if (encode(current) !== encode(latestTree(db)))
    fail("INVALID_WORKSPACE", "Private snapshot repository or metadata differs from its committed native owner receipt.");
}

function assertOtherPendingClear(db: DatabaseSync) {
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    const name = String(row.name);
    if (name === "legacy_knowledge_snapshot_intent" || !/^(?:pending_|.*_intent(?:s)?$)/.test(name)) continue;
    if (db.prepare(`SELECT 1 FROM "${name}" LIMIT 1`).get()) fail("RECOVERY_REQUIRED", "Another native pending operation fences snapshot access.", true);
  }
}
function validateRestoreChanges(root: string, changes: Intent["changes"]) {
  for (const change of changes) {
    const [area, ...parts] = change.path.split("/"), path = parts.join("/");
    if (!["notes", "skills", "papers"].includes(String(area)) || !documentPath.safeParse(path).success
      || path.split("/").some(part => part.toLowerCase() === "system")
      || lstatSync(join(root, area!, path.replace(/\.md$/i, ".assets")), { throwIfNoEntry: false }))
      fail("NOT_AVAILABLE", "Snapshot restore currently supports standalone portable non-System Markdown, not assets or directory conversion.");
    for (const bytes of [change.target ? Buffer.from(change.target.bytes!, "base64") : undefined,
      change.before_sha256 && lstatSync(join(root, change.path), { throwIfNoEntry: false }) ? regularBytes(join(root, change.path)) : undefined]) {
      if (!bytes) continue;
      const text = bytes.toString("utf8");
      if (!Buffer.from(text).equals(bytes)) fail("NOT_AVAILABLE", "Snapshot restore requires native-valid UTF-8 Markdown.");
      const document = decodeMarkdown("snapshot-preview", text, path, area as "notes" | "skills" | "papers");
      if (document.metadata.get("documentKind") === "todo-board" || document.metadata.has("memory")
        || document.record.deleted) fail("NOT_AVAILABLE", "Board, Memory and deleted descriptors require their own dedicated snapshot authority.");
    }
    if (change.target && hash(Buffer.from(change.target.bytes!, "base64")) !== change.target.sha256)
      fail("INVALID_DOCUMENT", "Snapshot target blob digest changed.");
  }
}
function validateFutureKnowledge(root: string, stage: string, changes: Intent["changes"]) {
  const future = join(stage, ".native-future"), changed = new Set(changes.map(change => change.path));
  mkdirSync(join(future, "notes"), { recursive: true, mode: 0o700 });
  try {
    for (const { record } of scanMarkdown(root)) {
      const path = `${record.area}/${record.path}`;
      if (changed.has(path)) continue;
      const destination = join(future, path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeExclusive(destination, regularBytes(join(root, path)), 0o600);
    }
    for (const change of changes) if (change.target) {
      const destination = join(future, change.path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeExclusive(destination, Buffer.from(change.target.bytes!, "base64"), 0o600);
    }
    scanMarkdown(future);
  } finally { rmSync(future, { recursive: true, force: true }); }
}
function saveIntent(storage: Storage, db: DatabaseSync, intent: Intent) {
  const payload = encode(intentSchema.parse(intent));
  transaction(storage, db, () => db.prepare("INSERT OR REPLACE INTO legacy_knowledge_snapshot_intent VALUES(1,?,?)").run(payload, hash(payload)));
}
function reconcileIndex(db: DatabaseSync, root: string) {
  const documents = scanMarkdown(root);
  db.prepare("DELETE FROM documents").run();
  for (const { record } of documents) db.prepare("INSERT INTO documents(id,title,revision,deleted,sha256,path,area) VALUES(?,?,?,?,?,?,?)")
    .run(record.id, record.title, record.revision, Number(record.deleted), record.sha256, record.path, record.area);
}
function inspectPublication(root: string, intent: Pick<Intent, "before" | "after" | "operationId">) {
  const base = join(root, stateRelative), current = tree(base, true, intent), { before, after } = intent;
  const prior = new Map(before.files.map(row => [row.path, row]));
  const targets = new Map(after.files.map(row => [row.path, row]));
  for (const row of current.files) {
    if (!targets.has(row.path) || ![prior.get(row.path), targets.get(row.path)].some(pin => pin?.sha256 === row.sha256 && pin.mode === row.mode))
      fail("RECOVERY_CONFLICT", "Private Git state changed outside its committed publication.", true);
  }
  if (before.files.some(row => !current.files.some(item => item.path === row.path)))
    fail("RECOVERY_CONFLICT", "Committed private Git state lost an owned file.", true);
  for (const path of current.directories) if (!after.directories.includes(path)) fail("RECOVERY_CONFLICT", "Unowned private Git directory appeared.", true);
  if (before.files.some(row => !targets.has(row.path))) fail("RECOVERY_CONFLICT", "Snapshot publication cannot silently remove existing private objects.", true);
}
function publishTree(root: string, before: Tree, after: Tree, operationId: string) {
  const base = join(root, stateRelative), prior = new Map(before.files.map(row => [row.path, row]));
  inspectPublication(root, { before, after, operationId });
  mkdirSync(base, { recursive: true, mode: 0o700 });
  for (const path of after.directories) mkdirSync(join(base, path), { recursive: true, mode: 0o700 });
  for (const directory of new Set(after.files.map(row => dirname(join(base, row.path))))) {
    const temporary = join(directory, `.pkm-snapshot-${operationId}`);
    if (lstatSync(temporary, { throwIfNoEntry: false })) unlinkSync(temporary);
  }
  for (const row of after.files) {
    const destination = join(base, row.path);
    if (lstatSync(destination, { throwIfNoEntry: false }) && hash(regularBytes(destination)) === row.sha256) continue;
    const temporary = join(dirname(destination), `.pkm-snapshot-${operationId}`);
    writeExclusive(temporary, Buffer.from(row.bytes, "base64"), row.mode);
    try {
      const present = lstatSync(destination, { throwIfNoEntry: false });
      if (present) {
        if (!present.isFile() || present.nlink !== 1 || hash(regularBytes(destination)) !== prior.get(row.path)?.sha256)
          fail("RECOVERY_CONFLICT", "Private Git publication target changed.", true);
        // Existing refs/metadata are rewritten only under the exact immutable before/after journal.
        renameSync(temporary, destination);
      } else linkSync(temporary, destination);
    } finally { if (lstatSync(temporary, { throwIfNoEntry: false })) unlinkSync(temporary); }
    syncDirectory(dirname(destination));
  }
}
async function applyIntent(storage: Storage, db: DatabaseSync, intent: Intent, host: LegacyKnowledgeSnapshotHost) {
  const root = storage.workspaceRoot();
  storage.assertWorkspaceLease();
  inspectActiveKnowledge(root);
  if (privacy(root) !== intent.privacySha256) fail("RECOVERY_CONFLICT", "Current privacy policy changed during snapshot mutation; no weakening or implicit restore is permitted.", true);
  authorize(intent.admission, { id: intent.admission.actorId, canWrite: true }, host, intent.tool, root);
  validateRestoreChanges(root, intent.changes.slice(intent.cursor));
  const expected = structuredClone(intent.beforeInventory);
  for (const change of intent.changes.slice(0, intent.cursor)) {
    if (change.target) expected[change.path] = { mode: change.target.mode, sha256: change.target.sha256 };
    else delete expected[change.path];
  }
  const actual = (await original(root, join(root, stateRelative), "inventory")).files;
  storage.assertWorkspaceLease();
  authorize(intent.admission, { id: intent.admission.actorId, canWrite: true }, host, intent.tool, root);
  inspectPublication(root, intent);
  const same = (value: unknown) => encode(Object.entries(value as object).sort()) === encode(Object.entries(actual).sort());
  const currentChange = intent.changes[intent.cursor];
  const variants = [structuredClone(expected)];
  if (currentChange) {
    const absent = structuredClone(expected); delete absent[currentChange.path]; variants.push(absent);
    if (currentChange.target) {
      const restored = structuredClone(absent);
      restored[currentChange.path] = { mode: currentChange.target.mode, sha256: currentChange.target.sha256 }; variants.push(restored);
    }
  }
  if (!variants.some(same)) fail("RECOVERY_CONFLICT", "Knowledge differs from every exact committed restore phase.", true);
  if (intent.tool === "knowledge_snapshot_configure" && !intent.schedulerApplied) {
    if (!host.configureSchedule) fail("RECOVERY_AUTHORITY_REQUIRED", "Exact host scheduler reconciliation is required.", true);
    const args = z.strictObject({ enabled: z.boolean().default(true), local_time: z.string().default("17:00"),
      timezone: z.string().default("America/Los_Angeles") }).parse(intent.args);
    await host.configureSchedule(Object.freeze({ ...intent.admission, ...args,
      unit: String(intent.result.unit), operationId: intent.operationId }));
    intent.schedulerApplied = true; saveIntent(storage, db, intent);
    host.checkpoint?.("scheduled");
  }
  const migration = new MigrationRuntime({ database: db, root, workspaceId: intent.admission.workspaceId,
    transaction: work => transaction(storage, db, work), reconcileIndex: () => reconcileIndex(db, root),
    assertOperationAvailable: operationId => {
      if (db.prepare("SELECT 1 FROM receipts WHERE operation_id=?").get(operationId))
        fail("CONFLICT", "Snapshot Trash operation ID already has a native receipt.");
    }, trash: { layoutVersion: "pkm.trash-lifecycle/v1" } });
  try {
    for (; intent.cursor < intent.changes.length; ) {
      const change = intent.changes[intent.cursor]!, [area, ...parts] = change.path.split("/"), path = parts.join("/");
      storage.assertWorkspaceLease();
      if (change.before_sha256) {
        const target = join(root, change.path);
        if (!intent.trashOperationId) {
          if (hash(regularBytes(target)) !== change.before_sha256) fail("CONFLICT", "Knowledge changed after snapshot restore preview.");
          intent.trashOperationId = randomUUID(); saveIntent(storage, db, intent);
          host.checkpoint?.("trash-prepared");
        }
        const prior = db.prepare("SELECT * FROM receipts WHERE operation_id=?").get(intent.trashOperationId);
        if (prior && (prior.actor_id !== intent.admission.actorId || prior.operation !== "knowledge.trash.move"))
          fail("RECOVERY_CONFLICT", "Snapshot Trash receipt has a different native owner.", true);
        if (!prior) {
          const nativePending = db.prepare("SELECT * FROM migration_runtime_intents").all();
          if (nativePending.length) {
            if (nativePending.length !== 1 || nativePending[0]!.operation_id !== intent.trashOperationId
              || nativePending[0]!.actor_id !== intent.admission.actorId || nativePending[0]!.operation !== "knowledge.trash.move")
              fail("RECOVERY_CONFLICT", "A different native Trash operation cannot be recovered by this snapshot owner.", true);
            await migration.recover();
          } else {
            if (hash(regularBytes(target)) !== change.before_sha256)
              fail("RECOVERY_CONFLICT", "Restore source changed before its journalled Trash operation began.", true);
            const preview = previewTrashLifecycle(root, { area, path, kind: "document" });
            await migration.dispatch({ operation: "knowledge.trash.move", actorId: intent.admission.actorId, args: {
              area, path, kind: "document", operationId: intent.trashOperationId, expectedTreeSha256: preview.treeSha256,
              expectedScanRevision: preview.scanRevision, entryIdFormat: "original",
            } });
          }
        }
        host.checkpoint?.("trashed");
      }
      if (change.target) {
        const destination = join(root, change.path);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        checkedRoot(dirname(destination));
        if (lstatSync(destination, { throwIfNoEntry: false })) {
          if (hash(regularBytes(destination)) !== change.target.sha256) fail("RECOVERY_CONFLICT", "Restore destination appeared.", true);
        } else writeExclusive(destination, Buffer.from(change.target.bytes!, "base64"), change.target.mode === "100755" ? 0o755 : 0o644);
      }
      host.checkpoint?.("restored");
      intent.cursor++; intent.trashOperationId = null; saveIntent(storage, db, intent);
    }
    const inspectedCorpus = String((await original(root, join(root, stateRelative), "inventory")).sha256);
    if (inspectedCorpus !== (intent.targetCorpus ?? intent.corpus)) fail("RECOVERY_CONFLICT", "Knowledge differs from the exact committed snapshot restore target.", true);
    if (!intent.published) {
      publishTree(root, intent.before, intent.after, intent.operationId);
      intent.published = true; saveIntent(storage, db, intent);
    }
    host.checkpoint?.("published");
    const finalCorpus = String((await original(root, join(root, stateRelative), "inventory")).sha256);
    storage.assertWorkspaceLease();
    authorize(intent.admission, { id: intent.admission.actorId, canWrite: true }, host, intent.tool, root);
    if (finalCorpus !== (intent.targetCorpus ?? intent.corpus) || privacy(root) !== intent.privacySha256)
      fail("RECOVERY_CONFLICT", "Knowledge or current privacy changed during private Git publication; intent remains pending.", true);
    const state = tree(join(root, stateRelative));
    if (encode(state) !== encode(intent.after)) fail("RECOVERY_CONFLICT", "Snapshot published state differs from its journal.", true);
    transaction(storage, db, () => {
      reconcileIndex(db, root);
      const previous = db.prepare("SELECT sha256 FROM legacy_knowledge_snapshot_events ORDER BY sequence DESC LIMIT 1").get()?.sha256 ?? null;
      const payload = encode({ workspaceId: intent.admission.workspaceId, actorId: intent.admission.actorId,
        operationId: intent.operationId, fingerprint: intent.fingerprint, tool: intent.tool, args: intent.args,
        result: intent.result, state, previous });
      db.prepare("INSERT INTO legacy_knowledge_snapshot_events(operation_id,payload,sha256) VALUES(?,?,?)").run(intent.operationId, payload, hash(payload));
      db.prepare("DELETE FROM legacy_knowledge_snapshot_intent WHERE singleton=1").run();
    });
    return intent.result;
  } finally { migration.close(); }
}

export async function legacyKnowledgeSnapshot(storage: Storage, actor: Actor, invocation: z.infer<typeof invocationSchema>,
  host: LegacyKnowledgeSnapshotHost) {
  const parsed = invocationSchema.parse(invocation), principal = { ...actor };
  return storage.withWorkspaceExclusive(async () => {
    const root = storage.workspaceRoot(), db = storage.connectNative();
    let stage: string | undefined;
    try {
      verifyLegacyKnowledgeSnapshots(db, root);
      const admission = active(db);
      if (!admission) fail("ACCESS_DENIED", "Knowledge snapshots require explicit host admission, not public paths.");
      authorize(admission, principal, host, parsed.tool, root);
      assertOtherPendingClear(db);
      inspectActiveKnowledge(root);
      scanMarkdown(root);
      const fingerprint = hash(encode({ actorId: principal.id, ...parsed }));
      const prior = db.prepare("SELECT payload FROM legacy_knowledge_snapshot_events WHERE operation_id=?").get(parsed.operationId);
      if (prior) {
        const event = JSON.parse(String(prior.payload));
        if (event.fingerprint !== fingerprint) fail("CONFLICT", "Snapshot operationId belongs to a different immutable request.");
        return event.result;
      }
      const operation = parsed.tool.replace("knowledge_snapshot_", "");
      if (operation === "status") {
        z.strictObject({}).parse(parsed.args);
        const result = await original(root, join(root, stateRelative), "status");
        storage.assertWorkspaceLease();
        verifyLegacyKnowledgeSnapshots(db, root);
        authorize(admission, principal, host, parsed.tool, root);
        result.repository = admission.privateGitRoot;
        return result;
      }
      stage = join(root, "packages", `.snapshot-stage-${parsed.operationId}`);
      transaction(storage, db, () => db.prepare("INSERT INTO legacy_knowledge_snapshot_stage VALUES(1,?)").run(parsed.operationId));
      const before = latestTree(db);
      materialize(stage, before);
      host.checkpoint?.("staged");
      let result: Record<string, any>, changes: Intent["changes"] = [], targetCorpus: string | null = null;
      const inventory = await original(root, stage, "inventory"), corpus = String(inventory.sha256);
      const privacySha256 = privacy(root);
      if (operation === "create") {
        const args = z.strictObject({ reason: z.string().default("manual") }).parse(parsed.args);
        result = await original(root, stage, "create", args);
      } else if (operation === "restore_preview") {
        const args = z.strictObject({ tag: z.string() }).parse(parsed.args);
        result = await original(root, stage, "preview", args);
      } else if (operation === "configure") {
        const args = z.strictObject({ enabled: z.boolean().default(true), local_time: z.string().default("17:00"),
          timezone: z.string().default("America/Los_Angeles") }).parse(parsed.args);
        if (!host.configureSchedule) fail("NOT_AVAILABLE", "Persistent scheduling requires an explicitly authorized native scheduler; no system units were changed.");
        const timing = await original(root, stage, "timing", args);
        const unit = `pkm-knowledge-snapshot-${hash(root).slice(0, 16)}`;
        result = { ...args, unit, updated_utc: new Date().toISOString(), ...timing };
        const schedule = join(stage, "schedule.json");
        if (lstatSync(schedule, { throwIfNoEntry: false })) unlinkSync(schedule);
        writeExclusive(schedule, Buffer.from(JSON.stringify(result, null, 2)), 0o600);
      } else {
        const args = z.strictObject({ preview_id: z.string().regex(/^[a-f0-9]{32}$/), approved_sha256: digest }).parse(parsed.args);
        const plan = await original(root, stage, "plan", args);
        changes = z.array(changeSchema).parse(plan.changes);
        targetCorpus = String(plan.target_inventory_sha256);
        validateRestoreChanges(root, changes);
        validateFutureKnowledge(root, stage, changes);
        if (!lstatSync(join(root, "notes/.trash"), { throwIfNoEntry: false }))
          fail("NOT_AVAILABLE", "Native Trash must be explicitly provisioned before snapshot restore.");
        const safety = await original(root, stage, "create", { reason: `before-restore:${plan.tag}` });
        if (String((await original(root, stage, "inventory")).sha256) !== corpus) fail("CONFLICT", "Knowledge changed while preparing restore safety snapshot.");
        result = { schema: "pkm.snapshot-restore-result/v1", status: "completed", before_snapshot: safety.tag,
          target_snapshot: plan.tag, applied: changes.map(change => change.path),
          receipt: join(root, stateRelative, "restores", `${args.preview_id}.json`), privacy_preserved: true };
        mkdirSync(join(stage, "restores"), { recursive: true, mode: 0o700 });
        if (lstatSync(join(stage, "restores", `${args.preview_id}.json`), { throwIfNoEntry: false }))
          unlinkSync(join(stage, "restores", `${args.preview_id}.json`));
        writeExclusive(join(stage, "restores", `${args.preview_id}.json`), Buffer.from(JSON.stringify(result, null, 2)), 0o600);
      }
      if (String((await original(root, stage, "inventory")).sha256) !== corpus) fail("SOURCE_CHANGED", "Knowledge changed before snapshot publication.");
      if (privacy(root) !== privacySha256) fail("SOURCE_CHANGED", "Current privacy policy changed while preparing a snapshot.");
      const after = tree(stage);
      const intent = intentSchema.parse({ admission, operationId: parsed.operationId, fingerprint, tool: parsed.tool,
        args: parsed.args, before, after, result, corpus, changes, cursor: 0, published: false, trashOperationId: null, targetCorpus,
        beforeInventory: inventory.files, schedulerApplied: false, privacySha256 });
      saveIntent(storage, db, intent);
      host.checkpoint?.("intent");
      return await applyIntent(storage, db, intent, host);
    } catch (error) {
      const pending = active(db) && db.prepare("SELECT 1 FROM legacy_knowledge_snapshot_intent WHERE singleton=1").get();
      if (pending) throw new CoreError(error instanceof CoreError ? error.code : "SNAPSHOT_PENDING",
        `Private snapshot intent is committed; explicit exact-owner reconciliation is required. ${error instanceof Error ? error.message : String(error)}`, "unknown");
      throw error;
    } finally {
      if (stage) {
        tree(stage, true);
        rmSync(stage, { recursive: true, force: true });
        transaction(storage, db, () => db.prepare("DELETE FROM legacy_knowledge_snapshot_stage WHERE singleton=1 AND operation_id=?").run(parsed.operationId));
      }
      db.close();
    }
  });
}
export async function invokeAdmittedLegacyKnowledgeSnapshot(storage: Storage, actor: Actor,
  invocation: z.infer<typeof invocationSchema>) {
  const admission = await storage.withWorkspaceExclusive(() => {
    const db = storage.connectNative();
    try {
      verifyLegacyKnowledgeSnapshots(db, storage.workspaceRoot());
      const current = active(db);
      if (!current) fail("ACCESS_DENIED", "Native snapshot tools have no explicit host admission.");
      return current;
    } finally { db.close(); }
  });
  const approved = encode(admission);
  return legacyKnowledgeSnapshot(storage, actor, invocation, {
    authorize: binding => {
      const { operation, ...current } = binding;
      return encode(current) === approved && admission.allowedTools.some(tool => tool === operation);
    },
  });
}
export async function reconcileLegacyKnowledgeSnapshots(storage: Storage, actor: Actor, host: LegacyKnowledgeSnapshotHost) {
  return storage.withWorkspaceExclusive(async () => {
    const db = storage.connectNative();
    try {
      verifyLegacyKnowledgeSnapshots(db, storage.workspaceRoot(), true);
      const admission = active(db);
      if (!admission) fail("ACCESS_DENIED", "Private snapshot reconciliation requires its original admitted host.");
      authorize(admission, actor, host, "reconcile", storage.workspaceRoot());
      const stage = db.prepare("SELECT operation_id FROM legacy_knowledge_snapshot_stage WHERE singleton=1").get();
      if (stage) {
        const path = join(storage.workspaceRoot(), "packages", `.snapshot-stage-${z.string().uuid().parse(stage.operation_id)}`);
        tree(path, true);
        rmSync(path, { recursive: true, force: true });
        transaction(storage, db, () => db.prepare("DELETE FROM legacy_knowledge_snapshot_stage WHERE singleton=1").run());
      }
      const row = db.prepare("SELECT payload FROM legacy_knowledge_snapshot_intent WHERE singleton=1").get();
      if (!row) return;
      const intent = intentSchema.parse(JSON.parse(String(row.payload)));
      authorize(intent.admission, actor, host, "reconcile", storage.workspaceRoot());
      return await applyIntent(storage, db, intent, host);
    } finally { db.close(); }
  });
}
