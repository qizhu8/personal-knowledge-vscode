import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, writeSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as NativeDatabase } from "node:sqlite";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { sha256 } from "./file-write.js";
import {
  originalNativeTrashDigest as digest, originalNativeTrashIdentitySchema, originalNativeTrashLimits,
  originalNativeTrashProvenanceSchema, originalNativeTrashSelectionV1Schema, originalNativeTrashSelectionV2Schema, originalNativeTrashSelectionV3Schema,
  validateOriginalNativeTrashProvenance, type OriginalNativeTrashIdentity,
} from "./original-native-trash-contracts.js";
import { readOriginalMcpJournal, type OriginalMcpPlan } from "./original-mcp-root-custody.js";
import { assertOriginalTrashAttempt, assertOriginalTrashCommit, type OriginalTrashAttempt } from "./original-native-trash-native.js";
import { legacyPrivateRootGuard, sameLegacyPrivateRoot } from "./legacy-effective-private-root.js";
import { currentOriginalMcpColdSqliteReadContext, originalMcpColdSqliteReadDatabase,
  originalMcpCoreHasRollbackJournal, type OriginalMcpSqliteReadDatabase } from "./original-mcp-cold-sqlite-read.js";
  import { opaqueTrashArea, opaqueTrashPair, type TrashCustodyArea } from "./opaque-trash-contracts.js";

export const originalTrashHistoryPath = ".pkm/state/knowledge-deletions.json";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const transitionBody = {
  operationId: z.string().uuid(),
  action: z.enum(["move", "restore"]), planSha256: hash, predecessorSha256: hash,
  historyBefore: z.string().max(2_097_152).nullable(), historyAfter: z.string().max(2_097_152),
  controlBefore: z.array(originalNativeTrashIdentitySchema).max(originalNativeTrashLimits.entries),
};
const transitionV1 = z.strictObject({ ...transitionBody,
  schema: z.literal("pkm.original-native-trash-transition/v1"), selection: originalNativeTrashSelectionV1Schema });
const transitionV2 = z.strictObject({ ...transitionBody,
  schema: z.literal("pkm.original-native-trash-transition/v2"), selection: originalNativeTrashSelectionV2Schema });
const transitionV3 = z.strictObject({ ...transitionBody,
  schema: z.literal("pkm.original-native-trash-transition/v3"), selection: originalNativeTrashSelectionV3Schema });
export const originalTrashTransitionBodySchema = z.discriminatedUnion("schema", [transitionV1, transitionV2, transitionV3]);
export const originalTrashTransitionSchema = z.discriminatedUnion("schema", [
  transitionV1.extend({ provenance: originalNativeTrashProvenanceSchema }),
  transitionV2.extend({ provenance: originalNativeTrashProvenanceSchema }),
  transitionV3.extend({ provenance: originalNativeTrashProvenanceSchema }),
]);
export type OriginalTrashTransitionBody = z.infer<typeof originalTrashTransitionBodySchema>;
export type OriginalTrashTransition = z.infer<typeof originalTrashTransitionSchema>;
export const ORIGINAL_NATIVE_TRASH_DDL = `
CREATE TABLE IF NOT EXISTS original_native_trash_commits (
 sequence INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
 transition_json TEXT NOT NULL, plan_json TEXT NOT NULL, after_json TEXT NOT NULL, predecessor_sha256 TEXT NOT NULL,
 digest TEXT NOT NULL
) STRICT;`;
function fail(message: string): never { throw new CoreError("RECOVERY_CONFLICT", message, "unknown"); }
function pathParts(path: string) {
  if (path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === ".." || part.includes("\\")
    || part.includes("\0"))) fail("Original Trash requires exact root-relative paths.");
  return path.split("/");
}
export function originalTrashIdentity(root: string, path: string): OriginalNativeTrashIdentity | undefined {
  let full = root;
  const parts = pathParts(path);
  for (const [index, part] of parts.entries()) {
    full = join(full, part);
    const stat = lstatSync(full, { bigint: true, throwIfNoEntry: false });
    if (!stat) return undefined;
    if (stat.isSymbolicLink() || index < parts.length - 1 && !stat.isDirectory()
      || !stat.isDirectory() && !stat.isFile() || stat.uid !== BigInt(process.getuid!())
      || stat.mode & 0o7002n || stat.isFile() && stat.nlink !== 1n)
      fail("Original Trash custody refuses linked, unsafe or foreign-owned paths.");
  }
  const stat = lstatSync(full, { bigint: true });
  return {
    path, kind: stat.isDirectory() ? "directory" : "file", device: String(stat.dev), inode: String(stat.ino),
    mode: Number(stat.mode & 0o777n), uid: String(stat.uid), gid: String(stat.gid), size: String(stat.size),
    mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
    sha256: stat.isFile() ? sha256(originalTrashRead(root, path)) : null,
  };
}
export function originalTrashRead(root: string, path: string, maximum = originalNativeTrashLimits.bytes): Buffer {
  let full = root;
  for (const part of pathParts(path)) {
    full = join(full, part);
    const stat = lstatSync(full, { bigint: true });
    if (stat.isSymbolicLink()) fail("Original Trash reads do not follow links.");
  }
  const before = lstatSync(full, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!())
    || before.size > BigInt(maximum)) fail("Original Trash file exceeds its exact ownership or byte bounds.");
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const pin = (stat: typeof before) => [stat.dev, stat.ino, stat.mode, stat.uid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  try {
    if (pin(before) !== pin(fstatSync(fd, { bigint: true }))) fail("Original Trash file identity changed before read.");
    const bytes = readFileSync(fd);
    if (bytes.length !== Number(before.size) || pin(before) !== pin(fstatSync(fd, { bigint: true }))
      || pin(before) !== pin(lstatSync(full, { bigint: true }))) fail("Original Trash file changed during read.");
    return bytes;
  } finally { closeSync(fd); }
}
export function originalTrashTree(root: string, base: string): OriginalNativeTrashIdentity[] {
  const rows: OriginalNativeTrashIdentity[] = [];
  let bytes = 0;
  const walk = (path: string, depth: number) => {
    const row = originalTrashIdentity(root, path);
    if (!row || rows.length >= originalNativeTrashLimits.entries || depth > 32)
      fail("Original Trash requires a complete bounded link-free tree.");
    rows.push(row); bytes += Number(row.size);
    if (bytes > originalNativeTrashLimits.bytes) fail("Original Trash tree exceeds its reviewed byte bound.");
    if (row.kind === "directory") for (const name of readdirSync(join(root, path)).sort()) walk(`${path}/${name}`, depth + 1);
  };
  walk(base, 0); return rows;
}
export function originalTrashControls(root: string, entryId: string, area: TrashCustodyArea = "notes", sourcePath?: string): OriginalNativeTrashIdentity[] {
  const rows = [".pkm", ".pkm/state", originalTrashHistoryPath, `${area}/.trash`]
    .flatMap(path => { const row = originalTrashIdentity(root, path); return row ? [row] : []; });
  const bucket = `${area}/.trash/${entryId}`;
  if (originalTrashIdentity(root, bucket)) rows.push(...originalTrashTree(root, bucket));
  if (opaqueTrashArea.safeParse(area).success && sourcePath) {
    const parts = `${area}/${sourcePath}`.split("/");
    for (let i = 1; i < parts.length; i++) {
      const row = originalTrashIdentity(root, parts.slice(0, i).join("/"));
      if (row) rows.push(row);
    }
    for (const path of [`${area}/${sourcePath}`, ...(opaqueTrashPair(sourcePath) ? [`${area}/${opaqueTrashPair(sourcePath)}`] : [])])
      if (originalTrashIdentity(root, path)) rows.push(...originalTrashTree(root, path));
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path, "en"));
}
const historySchema = z.strictObject({ schema: z.literal(1), records: z.array(z.strictObject({
  path: z.string().min(1).max(2048), deletedAt: z.string().datetime(),
})).max(16_384) });
export function originalTrashHistoryImage(root: string): Buffer | null {
  if (!originalTrashIdentity(root, originalTrashHistoryPath)) return null;
  const bytes = originalTrashRead(root, originalTrashHistoryPath, 1_048_576);
  const parsed = historySchema.parse(JSON.parse(bytes.toString("utf8")));
  if (new Set(parsed.records.map(row => row.path)).size !== parsed.records.length
    || parsed.records.some(row => !/^(notes|skills|papers|scripts|prompts)\//.test(row.path) || row.path.split("/").some(part => part === ".." || part === ".trash")))
    fail("Original deletion history is not an exact bounded original journal.");
  return bytes;
}
export function originalTrashHistoryAfter(before: Buffer | null, paths: string[], deletedAt: string, action: "move" | "restore"): Buffer {
  const old = before ? historySchema.parse(JSON.parse(before.toString("utf8"))) : { schema: 1 as const, records: [] };
  const records = old.records.filter(row => !paths.includes(row.path));
  if (action === "move") records.push(...paths.map(path => ({ path, deletedAt })));
  return Buffer.from(JSON.stringify({ schema: 1, records }, null, 2) + "\n");
}
export function validateOriginalTrashTransition(value: unknown): OriginalTrashTransition {
  const transition = originalTrashTransitionSchema.parse(value), { provenance, ...body } = transition;
  validateOriginalNativeTrashProvenance(provenance);
  const subject = provenance.request.subject;
  const before = transition.historyBefore === null ? null : Buffer.from(transition.historyBefore, "base64");
  const after = Buffer.from(transition.historyAfter, "base64");
  if (subject.action !== transition.action || subject.operationId !== transition.operationId
    || provenance.request.schema !== (transition.schema === "pkm.original-native-trash-transition/v1"
      ? "pkm.original-native-trash-request/v1" : transition.schema === "pkm.original-native-trash-transition/v2"
        ? "pkm.original-native-trash-request/v2" : "pkm.original-native-trash-request/v3")
    || subject.transitionSha256 !== digest(body) || subject.custodyPredecessorSha256 !== transition.predecessorSha256
    || digest(subject.selection[0]) !== digest(transition.selection)
    || subject.historyBeforeSha256 !== (before ? sha256(before) : null) || subject.historyAfterSha256 !== sha256(after))
    fail("Original Trash transition lost its exact native request/image binding.");
  return transition;
}
export function originalTrashPredecessor(database: DatabaseSync, planSha256: string): string {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='original_native_trash_commits'").get())
    return planSha256;
  return String(database.prepare("SELECT digest FROM original_native_trash_commits ORDER BY sequence DESC LIMIT 1").get()?.digest ?? planSha256);
}
export function originalTrashStageName(operationId: string) { return `.pkm-next-original-trash-${z.string().uuid().parse(operationId)}.history`; }
function sync(root: string, path = "") {
  const fd = openSync(join(root, path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function inspectOriginalTrashHistoryPhase(root: string, transition: OriginalTrashTransition): "before" | "after" {
  validateOriginalTrashTransition(transition);
  const current = originalTrashHistoryImage(root), before = transition.historyBefore === null ? null : Buffer.from(transition.historyBefore, "base64");
  const after = Buffer.from(transition.historyAfter, "base64");
  if (current?.equals(after)) return "after";
  if (current === null && before === null || current && before && current.equals(before)) return "before";
  fail("Original deletion history changed outside its receipt-bound transition.");
}
export function applyOriginalTrashHistory(root: string, transition: OriginalTrashTransition, attempt: OriginalTrashAttempt,
  fault?: (point: string) => void) {
  const current = () => assertOriginalTrashAttempt(attempt, transition);
  current();
  if (inspectOriginalTrashHistoryPhase(root, transition) === "after") return;
  const bytes = Buffer.from(transition.historyAfter, "base64"), stage = originalTrashStageName(transition.operationId);
  const existing = originalTrashIdentity(root, stage);
  if (existing) {
    const prior = originalTrashRead(root, stage, 1_048_576);
    if (!bytes.subarray(0, prior.length).equals(prior)) fail("The exact pending history stage contains unknown bytes.");
  }
  const fd = openSync(join(root, stage), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid!())) fail("Unsafe history stage.");
    for (let offset = Number(stat.size); offset < bytes.length;) {
      current(); offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  sync(root); fault?.("original-history-staged");
  current();
  if (inspectOriginalTrashHistoryPhase(root, transition) !== "before"
    || !originalTrashRead(root, stage, 1_048_576).equals(bytes)) fail("Original history CAS changed before publication.");
  if (!originalTrashIdentity(root, ".pkm/state")) { mkdirSync(join(root, ".pkm/state"), { mode: 0o700 }); sync(root, ".pkm"); }
  if (originalTrashIdentity(root, ".pkm/state")?.kind !== "directory") fail("Original state parent is not a real directory.");
  current(); renameSync(join(root, stage), join(root, originalTrashHistoryPath));
  sync(root, ".pkm/state"); sync(root); fault?.("original-history-published");
}
export function commitOriginalTrashSuccessor(database: DatabaseSync, workspaceId: string, root: string,
  transitionValue: OriginalTrashTransition, planJson: string) {
  const transition = validateOriginalTrashTransition(transitionValue);
  assertOriginalTrashCommit(root, transition);
  if (!database.isTransaction) fail("Original Trash successor must share the canonical receipt transaction.");
  if (inspectOriginalTrashHistoryPhase(root, transition) !== "after") fail("Original history effects are not complete.");
  const sequence = Number(database.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM original_native_trash_commits").get()!.n);
  const transitionJson = JSON.stringify(transition), afterJson = JSON.stringify(originalTrashControls(root, transition.selection.entryId, transition.selection.area, transition.selection.path));
  const binding = [sequence, workspaceId, transition.operationId, transitionJson, planJson, afterJson, transition.predecessorSha256];
  database.prepare("INSERT INTO original_native_trash_commits VALUES(?,?,?,?,?,?,?,?)").run(...binding, digest(binding));
}
export function readOriginalTrashSuccessors(database: OriginalMcpSqliteReadDatabase, workspaceId: string, root: string, planSha256: string) {
  const controls = new Map<string, OriginalNativeTrashIdentity | null>();
  let predecessor = planSha256;
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='original_native_trash_commits'").get())
    return { controls, predecessor, transitions: [] as OriginalTrashTransition[] };
  const transitions: OriginalTrashTransition[] = [];
  for (const row of database.prepare("SELECT * FROM original_native_trash_commits ORDER BY sequence").all()) {
    const transition = validateOriginalTrashTransition(JSON.parse(String(row.transition_json)));
    const after = z.array(originalNativeTrashIdentitySchema).max(originalNativeTrashLimits.entries).parse(JSON.parse(String(row.after_json)));
    const receipt = database.prepare("SELECT * FROM receipts WHERE operation_id=?").get(transition.operationId);
    const subject = transition.provenance.request.subject;
    const plan = JSON.parse(String(row.plan_json)), { originalTrash: planTransition, ...basePlan } = plan;
    const args = transition.action === "move"
      ? { operationId: plan.operationId, area: plan.area, path: plan.path, kind: plan.targetKind,
        expectedTreeSha256: plan.expectedTreeSha256, expectedScanRevision: plan.expectedScanRevision, entryIdFormat: "original" }
      : { operationId: plan.operationId, entryId: plan.entryId, expectedScanRevision: plan.expectedScanRevision };
    const request = { operation: subject.operation, actorId: subject.actorId, args };
    const expectedResult = { operationId: transition.operationId, action: transition.action === "move" ? "trash" : "restore",
      entryId: transition.selection.entryId, area: transition.selection.area, path: transition.selection.path };
    if (row.workspace_id !== workspaceId || row.operation_id !== transition.operationId
      || row.predecessor_sha256 !== predecessor || transition.predecessorSha256 !== predecessor
      || subject.root !== root || subject.workspaceId !== workspaceId || subject.custodyPlanSha256 !== planSha256
      || row.digest !== digest([row.sequence, workspaceId, row.operation_id, row.transition_json, row.plan_json, row.after_json, predecessor])
      || digest(planTransition) !== digest(transition) || sha256(JSON.stringify(basePlan)) !== transition.planSha256
      || plan.area !== transition.selection.area || plan.path !== transition.selection.path
      || plan.entryId !== transition.selection.entryId
      || (transition.schema === "pkm.original-native-trash-transition/v3"
        ? plan.targetKind !== "opaque" || plan.documentPins.length !== 0 || digest(plan.opaqueFile) !== digest(transition.selection.file)
        : plan.targetKind !== "document" || plan.documentPins.length !== 1)
      || digest(args) !== subject.canonicalArgumentsDigest
      || !receipt || receipt.actor_id !== subject.actorId || receipt.operation !== subject.operation
      || receipt.fingerprint !== sha256(JSON.stringify(request)) || digest(JSON.parse(String(receipt.result))) !== digest(expectedResult))
      fail("Original Trash custody successor lacks its exact canonical receipt and predecessor.");
    if (transition.schema !== "pkm.original-native-trash-transition/v1") {
      const paths = [...plan.moves].sort((a, b) => a.slot === b.slot ? 0 : a.slot === "payload" ? -1 : 1)
        .flatMap(move => move.entries.filter((entry: { kind: string; path: string }) => entry.kind === "file"
          && !entry.path.split("/").some(part => part.startsWith(".")))
          .map((entry: { path: string }) => `${plan.area}/${move.originalPath}${entry.path ? `/${entry.path}` : ""}`));
      const before = transition.historyBefore === null ? null : Buffer.from(transition.historyBefore, "base64");
      if (plan.operationId !== transition.operationId || plan.actorId !== subject.actorId
        || transition.schema === "pkm.original-native-trash-transition/v2" && (
          plan.documentPins[0].id !== transition.selection.document.id
          || plan.documentPins[0].revision !== transition.selection.document.revision
          || plan.documentPins[0].sha256 !== transition.selection.document.sha256)
        || !originalTrashHistoryAfter(before, paths, plan.deletedAt, transition.action).equals(Buffer.from(transition.historyAfter, "base64")))
        fail("Skill/Paper custody requires exact document pins and its ordered original pair-history transition.");
    }
    const trashRoot = `${transition.selection.area}/.trash`;
    const opaqueSourcePaths = transition.schema === "pkm.original-native-trash-transition/v3"
      ? plan.moves.flatMap((move: { originalPath: string; entries: { path: string }[] }) =>
        move.entries.map(entry => `${plan.area}/${move.originalPath}${entry.path ? `/${entry.path}` : ""}`)) : [];
    const opaqueParents = transition.schema === "pkm.original-native-trash-transition/v3"
      ? `${plan.area}/${plan.path}`.split("/").slice(0, -1).map((_part: string, i: number, parts: string[]) => parts.slice(0, i + 1).join("/")) : [];
    const allowed = (path: string) => [".pkm", ".pkm/state", originalTrashHistoryPath, trashRoot].includes(path)
      || opaqueSourcePaths.includes(path) || opaqueParents.includes(path)
      || path === `${trashRoot}/${transition.selection.entryId}` || path.startsWith(`${trashRoot}/${transition.selection.entryId}/`);
    if (transition.controlBefore.some(row => !allowed(row.path)) || after.some(row => !allowed(row.path)))
      fail("An original Trash successor cannot change unrelated custody paths.");
    const bucket = `${trashRoot}/${transition.selection.entryId}`;
    const payloadRows = transition.action === "move" ? plan.moves.flatMap((move: { slot: string; originalPath: string; entries: Array<{
      path: string; kind: string; dev: number; ino: number; size: number; sha256: string | null;
    }> }) => move.entries.map(entry => ({ ...entry, path: `${bucket}/${move.slot}${entry.path ? `/${entry.path}` : ""}` }))) : [];
    const allowedAfter = new Set([".pkm", ".pkm/state", originalTrashHistoryPath, trashRoot,
      ...opaqueParents, ...(transition.action === "restore" ? opaqueSourcePaths : []),
      ...(transition.action === "move" ? [bucket, `${bucket}/metadata.json`, ...payloadRows.map((row: { path: string }) => row.path)] : [])]);
    const restoredRows = transition.schema === "pkm.original-native-trash-transition/v3" && transition.action === "restore"
      ? plan.moves.flatMap((move: { originalPath: string; entries: { path: string; kind: string; dev: number; ino: number; size: number; sha256: string | null }[] }) =>
        move.entries.map(entry => ({ ...entry, path: `${plan.area}/${move.originalPath}${entry.path ? `/${entry.path}` : ""}` }))) : [];
    if (after.some(row => !allowedAfter.has(row.path))
      || [...payloadRows, ...restoredRows].some((entry: { path: string; kind: string; dev: number; ino: number; size: number; sha256: string | null }) => {
        const row = after.find(row => row.path === entry.path);
        return !row || row.kind !== entry.kind || row.device !== String(entry.dev) || row.inode !== String(entry.ino)
          || row.kind === "file" && (row.size !== String(entry.size) || row.sha256 !== entry.sha256);
      }) || after.find(row => row.path === originalTrashHistoryPath)?.sha256 !== sha256(Buffer.from(transition.historyAfter, "base64"))
      || transition.action === "move" && after.find(row => row.path === `${bucket}/metadata.json`)?.sha256 !== transition.selection.metadataSha256)
      fail("Original Trash successor rows do not prove the exact original payload, pair, metadata and history images.");
    for (const before of transition.controlBefore) {
      const prior = controls.get(before.path);
      if (prior !== undefined && digest(prior) !== digest(before)) fail("Original Trash custody predecessor rows changed.");
      controls.set(before.path, null);
    }
    for (const row of after) controls.set(row.path, row);
    predecessor = String(row.digest); transitions.push(transition);
  }
  return { controls, predecessor, transitions };
}
function openOriginalTrashCustodyDatabase(root: string) {
  if (originalMcpCoreHasRollbackJournal(root)) fail("Original Trash custody refuses rollback/hot journals before reading.");
  const guard = legacyPrivateRootGuard(root), path = join(root, "core.sqlite");
  if (!guard) fail("Original Trash custody requires an owned private same-root ancestor.");
  const identity = (stat: BigIntStats) =>
    [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink].join(":");
  const checked = () => {
    if (!sameLegacyPrivateRoot(root, guard)) fail("Original Trash Core database root protection changed.");
    for (const name of ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm"]) {
      const stat = lstatSync(join(root, name), { bigint: true, throwIfNoEntry: false });
      if (!stat && name !== "core.sqlite") continue;
      if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
        || stat.uid !== BigInt(process.getuid!()) || stat.mode & 0o7002n)
        fail("Original Trash custody requires owned, safe single-link same-root Core database files.");
    }
    return lstatSync(path, { bigint: true });
  };
  const auxiliary = () => ["core.sqlite-wal", "core.sqlite-shm"].map(name => {
    const stat = lstatSync(join(root, name), { bigint: true, throwIfNoEntry: false });
    return stat ? identity(stat) : null;
  });
  const before = checked(), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let database: NativeDatabase | undefined;
  let auxiliaryPins: ReturnType<typeof auxiliary> | undefined;
  const assertCurrent = () => {
    const pathPin = identity(checked()), descriptorPin = identity(fstatSync(fd, { bigint: true }));
    if (pathPin !== identity(before) || descriptorPin !== identity(before)) {
      console.error("PKM original Trash custody file pin changed:", {
        file: "core.sqlite", expected: identity(before), pathPin, descriptorPin,
      });
      fail("Original Trash Core database identity or permissions changed while reading custody.");
    }
    if (auxiliaryPins) {
      const actual = auxiliary();
      if (digest(actual) !== digest(auxiliaryPins)) {
        console.error("PKM original Trash custody file pin changed:", {
          files: ["core.sqlite-wal", "core.sqlite-shm"], expected: auxiliaryPins, actual,
        });
        fail("Original Trash Core WAL/SHM identity or permissions changed while reading custody.");
      }
    }
  };
  try {
    assertCurrent();
    database = new NativeDatabase(path, { readOnly: true });
    database.exec("BEGIN");
    // SQLite establishes its WAL/SHM handles lazily on the first read, not at construction.
    database.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
    auxiliaryPins = auxiliary();
    assertCurrent();
    return { database, assertCurrent, close() {
      try { if (database!.isTransaction) database!.exec("ROLLBACK"); }
      finally { try { database!.close(); } finally { closeSync(fd); } }
    } };
  } catch (error) { try { database?.close(); } finally { closeSync(fd); } throw error; }
}
/** Admission validates persisted effects, not renewable native authority. */
export async function originalTrashCustodyExceptions(plan: OriginalMcpPlan,
  baseline: (path: string) => OriginalNativeTrashIdentity | undefined) {
  const controls = new Map<string, OriginalNativeTrashIdentity | null>(), managedNames = new Set<string>();
  const root = plan.root, journal = readOriginalMcpJournal(root);
  if (!journal || !lstatSync(join(root, "core.sqlite"), { throwIfNoEntry: false }))
    return { controls, managedNames };
  const context = currentOriginalMcpColdSqliteReadContext(plan);
  if (!context && !lstatSync(join(root, "core.sqlite-wal"), { throwIfNoEntry: false })
    && !lstatSync(join(root, "core.sqlite-shm"), { throwIfNoEntry: false }))
    fail("A sidecar-free native database requires its genuine cold-fence read context.");
  const reader = context ? { database: originalMcpColdSqliteReadDatabase(context, plan),
    assertCurrent() { currentOriginalMcpColdSqliteReadContext(plan); }, close() {} }
    : openOriginalTrashCustodyDatabase(root);
  const { database } = reader;
  try {
    const hasCommits = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='original_native_trash_commits'").get()
      && database.prepare("SELECT 1 FROM original_native_trash_commits LIMIT 1").get();
    const pending = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='migration_runtime_intents'").get()
      ? database.prepare("SELECT * FROM migration_runtime_intents WHERE operation IN ('knowledge.trash.move','knowledge.trash.restore')").all()
      : [];
    reader.assertCurrent();
    if (!hasCommits && !pending.length) return { controls, managedNames };
    const committed = readOriginalTrashSuccessors(database, journal.workspaceId, root, plan.planSha256);
    for (const transition of committed.transitions) {
      for (const row of transition.controlBefore) {
        const previous = controls.has(row.path) ? controls.get(row.path) : baseline(row.path);
        if (digest(previous ?? null) !== digest(row)) fail("Original Trash custody does not descend from the independently retained B0 rows.");
      }
      const commit = database.prepare("SELECT after_json FROM original_native_trash_commits WHERE operation_id=?").get(transition.operationId)!;
      const after = z.array(originalNativeTrashIdentitySchema).parse(JSON.parse(String(commit.after_json)));
      for (const row of transition.controlBefore) controls.set(row.path, null);
      for (const row of after) controls.set(row.path, row);
    }
    if (pending.length > 1) fail("Original Trash custody permits only one exact pending writer intent.");
    if (!pending.length) return { controls, managedNames };
    const row = pending[0]!, { deserializeTrashLifecyclePlan, inspectTrashLifecycleRecovery } = await import("./trash-lifecycle.js");
    const lifecycle = deserializeTrashLifecyclePlan(String(row.plan_json));
    if (!lifecycle.originalTrash) fail("Old original-root Trash journals do not carry this protocol; explicit offline recovery is required.");
    const transition = validateOriginalTrashTransition(lifecycle.originalTrash), subject = transition.provenance.request.subject;
    const request = JSON.parse(String(row.request_json));
    if (row.workspace_id !== journal.workspaceId || row.root_path !== root || row.operation_id !== lifecycle.operationId
      || row.actor_id !== lifecycle.actorId || row.operation !== subject.operation
      || row.digest !== sha256(JSON.stringify([row.operation_id, row.workspace_id, row.root_path, row.actor_id, row.operation,
        row.fingerprint, row.request_json, row.plan_json]))
      || row.fingerprint !== sha256(JSON.stringify(request)) || request.actorId !== row.actor_id || request.operation !== row.operation
      || digest(request.args) !== subject.canonicalArgumentsDigest || transition.predecessorSha256 !== committed.predecessor
      || subject.custodyPlanSha256 !== plan.planSha256 || subject.root !== root || subject.workspaceId !== journal.workspaceId
      || database.prepare("SELECT 1 FROM receipts WHERE operation_id=?").get(lifecycle.operationId))
      fail("Pending original Trash custody lost its native request, canonical intent or predecessor.");
    for (const before of transition.controlBefore) {
      const previous = controls.has(before.path) ? controls.get(before.path) : baseline(before.path);
      if (digest(previous ?? null) !== digest(before)) fail("Pending original Trash does not descend from the exact custody predecessor.");
    }
    inspectTrashLifecycleRecovery(root, lifecycle);
    const historyPhase = inspectOriginalTrashHistoryPhase(root, transition), current = originalTrashControls(root, lifecycle.entryId, transition.selection.area, transition.selection.path);
    for (const before of transition.controlBefore) controls.set(before.path, null);
    for (const actual of current) {
      const before = transition.controlBefore.find(row => row.path === actual.path);
      if (before && actual.kind === "directory"
        && ["device", "inode", "mode", "uid", "gid", "kind"].some(key =>
          actual[key as keyof typeof actual] !== before[key as keyof typeof before]))
        fail("Pending original Trash directory identity changed outside its selected effects.");
      if (actual.path === originalTrashHistoryPath && historyPhase === "before"
        && digest(actual) !== digest(before ?? null)) fail("Pending original deletion history identity changed.");
      controls.set(actual.path, actual);
    }
    const stage = originalTrashStageName(lifecycle.operationId), staged = originalTrashIdentity(root, stage);
    if (staged) {
      const bytes = originalTrashRead(root, stage, 1_048_576), after = Buffer.from(transition.historyAfter, "base64");
      if (bytes.length > after.length || !after.subarray(0, bytes.length).equals(bytes))
        fail("Pending original history stage contains unknown bytes.");
      managedNames.add(stage);
    }
    return { controls, managedNames };
  } finally { try { reader.assertCurrent(); } finally { reader.close(); } }
}
export async function originalTrashPreservedBuckets(root: string, area: string): Promise<Set<string>> {
  const { readOriginalMcpJournal } = await import("./original-mcp-root-custody.js");
  const journal = readOriginalMcpJournal(root), result = new Set<string>();
  if (!journal) fail("Original Trash preservation requires the independent original custody journal.");
  const { openOriginalMcpCustodyReader } = await import("./original-mcp-root.js");
  const reader = await openOriginalMcpCustodyReader(journal.plan), base = `${area}/.trash`;
  try {
    for (const source of reader.entries(base)) {
      if (source.path === base) continue;
      const { blob: _blob, mutable: _mutable, ...expected } = source;
      if (digest(originalTrashIdentity(root, source.path)) !== digest(expected))
        fail("A preserved original Trash bucket changed without an exact native receipt.");
      result.add(source.path.slice(base.length + 1).split("/")[0]!);
    }
    return result;
  } finally { reader.close(); }
}
