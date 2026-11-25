import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { assertLegacyUiDeletionWriteTarget } from "./legacy-ui-deletion-journal.js";
import { checkedDocumentPath, checkedResourcePath, documentPath } from "./document-path.js";
import { coreDatabasePath } from "./workspace-storage-paths.js";

export const NATIVE_BOARD_LIFECYCLE_OPERATION = "private.native-board-lifecycle";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const boardKey = z.string().min(1).max(1024).refine(value =>
  value.split("/").every(part => !!part && !part.startsWith(".") && !/[\\:\u0000-\u001f]/.test(part)));
const common = {
  boardSlug: boardKey, operationId: z.uuid(), expectedDigest: digest, expectedDocumentDigest: digest,
};
export const nativeBoardLifecycleInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("move"), ...common, destinationPath: documentPath,
    title: z.string().min(1).max(4096).optional(), description: z.string().max(65_536).optional(),
    tags: z.array(z.string().max(1024)).max(256).optional() }),
  z.strictObject({ kind: z.literal("trash"), ...common }),
  z.strictObject({ kind: z.literal("restore"), ...common }),
]);
export type NativeBoardLifecycleInput = z.infer<typeof nativeBoardLifecycleInput>;
export const nativeBoardGenesisSchema = z.strictObject({
  workspaceId: z.string().min(1).max(200), boardKey, noteId: identity, firstOperationId: z.uuid(),
  markdownPath: documentPath, markdown: z.string().max(1_048_576), markdownSha256: digest,
  backingPath: z.string().max(2048).nullable(), backing: z.string().max(2_097_152),
  backingSha256: digest,
});
export type NativeBoardGenesis = z.infer<typeof nativeBoardGenesisSchema>;
export const nativeBoardEventSchema = z.strictObject({
  schema: z.literal("pkm.native-board-lifecycle/v1"),
  workspaceId: z.string().min(1).max(200), boardKey, noteId: identity,
  input: nativeBoardLifecycleInput, previousDigest: digest.nullable(),
  genesisDigest: digest, beforePath: documentPath, path: documentPath,
  status: z.enum(["active", "trashed"]), title: z.string().max(4096),
  documentSha256: digest, aliases: z.array(documentPath).min(1).max(1024),
  trashPlan: z.string().max(16_000_000).nullable(),
});
export type NativeBoardLifecycleEvent = z.infer<typeof nativeBoardEventSchema>;
export function nativeBoardLifecycleResult(event: NativeBoardLifecycleEvent) {
  return { operationId: event.input.operationId, kind: event.input.kind, boardSlug: event.boardKey,
    noteId: event.noteId, path: event.path, status: event.status, title: event.title,
    digest: event.input.expectedDigest, documentDigest: event.documentSha256,
    aliases: event.aliases, eventDigest: boardLifecycleHash(event) };
}
export const nativeBoardPlanSchema = z.strictObject({
  kind: z.literal("native-board-lifecycle"), event: nativeBoardEventSchema,
  genesis: nativeBoardGenesisSchema,
  movePlan: z.string().max(16_000_000).nullable(),
  beforeSource: z.string().max(1_048_576).nullable(),
  updatedSource: z.string().max(1_048_576).nullable(),
  trashPlan: z.string().max(16_000_000).nullable(),
});
export type NativeBoardLifecyclePlan = z.infer<typeof nativeBoardPlanSchema>;
export const nativeBoardLifecycleDdl = `
CREATE TABLE IF NOT EXISTS native_board_genesis (
  board_key TEXT PRIMARY KEY, payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS native_board_lifecycle_event (
  sequence INTEGER PRIMARY KEY, operation_id TEXT UNIQUE NOT NULL, board_key TEXT NOT NULL,
  payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS native_board_genesis_no_update BEFORE UPDATE ON native_board_genesis
BEGIN SELECT RAISE(ABORT, 'Board genesis is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_board_genesis_no_delete BEFORE DELETE ON native_board_genesis
BEGIN SELECT RAISE(ABORT, 'Board genesis is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_board_lifecycle_no_update BEFORE UPDATE ON native_board_lifecycle_event
BEGIN SELECT RAISE(ABORT, 'Board lifecycle history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_board_lifecycle_no_delete BEFORE DELETE ON native_board_lifecycle_event
BEGIN SELECT RAISE(ABORT, 'Board lifecycle history is immutable'); END;`;
function fail(message: string): never { throw new CoreError("RECOVERY_CONFLICT", message, "unknown"); }
export function boardLifecycleHash(value: unknown): string { return hash(JSON.stringify(value)); }
export function boardLifecycleFingerprint(input: NativeBoardLifecycleInput): string {
  return boardLifecycleHash({ operation: NATIVE_BOARD_LIFECYCLE_OPERATION, actorId: "user:local", args: input });
}
export function boardLifecycleWorkspace(root: string): string {
  const marker = privateRead(join(root, ".pkm-next-workspace"), 16_384);
  const value = JSON.parse(marker.toString("utf8"));
  if (typeof value.id !== "string" || !value.id) fail("Board lifecycle requires its exact workspace identity.");
  return value.id;
}
function privateRead(path: string, limit: number): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit
    || before.uid !== process.getuid?.() || (before.mode & 0o7077) !== 0)
    fail("Board lifecycle authority is not private owned single-link data.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd), bytes = readFileSync(fd), after = fstatSync(fd), current = lstatSync(path);
    if (opened.dev !== before.dev || opened.ino !== before.ino || after.size !== before.size
      || after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs
      || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
      || current.ctimeMs !== before.ctimeMs || current.mtimeMs !== before.mtimeMs || bytes.length !== before.size)
      fail("Board lifecycle authority changed during read.");
    return bytes;
  } finally { closeSync(fd); }
}
export function withBoardLifecycleDatabase<T>(root: string, supplied: DatabaseSync | undefined, work: (db: DatabaseSync) => T): T | undefined {
  if (supplied) return work(supplied);
  const path = coreDatabasePath(root);
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.())
    fail("Board lifecycle requires the private workspace database.");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (exists(db, "native_board_genesis") && db.prepare("SELECT 1 FROM native_board_genesis LIMIT 1").get()) {
      const directory = lstatSync(root);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.()
        || (directory.mode & 0o7077) !== 0 || (stat.mode & 0o7022) !== 0)
        fail("Enabled Board lifecycle requires a private owned root and non-shared writable database.");
    }
    return work(db);
  } finally { db.close(); }
}
function exists(db: DatabaseSync, name: string) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function checkedGenesis(raw: string, expected: unknown, workspaceId: string): NativeBoardGenesis {
  const genesis = nativeBoardGenesisSchema.parse(JSON.parse(raw));
  if (hash(raw) !== expected || genesis.workspaceId !== workspaceId || hash(genesis.markdown) !== genesis.markdownSha256
    || hash(genesis.backing) !== genesis.backingSha256
    || genesis.markdownPath !== `${genesis.boardKey}.md`
    || genesis.backingPath !== null && genesis.backingPath !== `${genesis.boardKey}.assets/pkm-todo-board.json`)
    fail("Board genesis lost its immutable source/workspace binding.");
  return genesis;
}
export function readNativeBoardLifecyclePending(db: DatabaseSync, root: string): NativeBoardLifecyclePlan | undefined {
  if (!exists(db, "pending_document_lifecycle")) return undefined;
  const row = db.prepare("SELECT * FROM pending_document_lifecycle WHERE singleton=1").get();
  if (!row || row.operation !== NATIVE_BOARD_LIFECYCLE_OPERATION) return undefined;
  const plan = nativeBoardPlanSchema.parse(JSON.parse(String(row.plan)));
  const event = plan.event, genesis = plan.genesis;
  if (row.actor_id !== "user:local" || row.operation_id !== event.input.operationId
    || row.fingerprint !== boardLifecycleFingerprint(event.input)
    || event.workspaceId !== boardLifecycleWorkspace(root) || event.workspaceId !== genesis.workspaceId
    || event.boardKey !== event.input.boardSlug || event.boardKey !== genesis.boardKey || event.noteId !== genesis.noteId
    || event.genesisDigest !== boardLifecycleHash(genesis))
    fail("Board lifecycle pending envelope lost its exact user/workspace/source binding.");
  const stored = exists(db, "native_board_genesis") ? db.prepare("SELECT * FROM native_board_genesis WHERE board_key=?").get(event.boardKey) : undefined;
  if (!stored || stored.payload !== JSON.stringify(genesis) || stored.payload_sha256 !== event.genesisDigest)
    fail("Board lifecycle pending intent lacks its exact immutable genesis.");
  checkedGenesis(String(stored.payload), stored.payload_sha256, event.workspaceId);
  return plan;
}
export function readNativeBoardLifecycleEvents(root: string, database?: DatabaseSync): NativeBoardLifecycleEvent[] {
  return withBoardLifecycleDatabase(root, database, db => {
    if (!exists(db, "native_board_lifecycle_event")) return [];
    const workspaceId = boardLifecycleWorkspace(root), result: NativeBoardLifecycleEvent[] = [];
    const latest = new Map<string, { event: NativeBoardLifecycleEvent; digest: string }>();
    for (const row of db.prepare("SELECT * FROM native_board_lifecycle_event ORDER BY sequence").all()) {
      const event = nativeBoardEventSchema.parse(JSON.parse(String(row.payload))), digest = hash(String(row.payload));
      const before = latest.get(event.boardKey);
      const genesisRow = db.prepare("SELECT * FROM native_board_genesis WHERE board_key=?").get(event.boardKey);
      if (!genesisRow) fail("Board lifecycle lost its genesis.");
      const genesis = checkedGenesis(String(genesisRow.payload), genesisRow.payload_sha256, workspaceId);
      const receipt = db.prepare("SELECT * FROM receipts WHERE operation_id=?").get(event.input.operationId);
      const expectedAliases = [...new Set([...(before?.event.aliases ?? [genesis.markdownPath]), event.path])];
      if (event.workspaceId !== workspaceId || event.boardKey !== row.board_key || event.boardKey !== event.input.boardSlug
        || event.noteId !== genesis.noteId || row.operation_id !== event.input.operationId || row.payload_sha256 !== digest
        || event.genesisDigest !== genesisRow.payload_sha256 || event.previousDigest !== (before?.digest ?? null)
        || event.beforePath !== (before?.event.path ?? genesis.markdownPath)
        || !before && genesis.firstOperationId !== event.input.operationId
        || event.status !== (event.input.kind === "trash" ? "trashed" : "active")
        || (before?.event.status === "trashed") !== (event.input.kind === "restore")
        || event.input.kind !== "move" && event.path !== event.beforePath
        || event.input.kind === "move" && event.path !== event.input.destinationPath
        || JSON.stringify(event.aliases) !== JSON.stringify(expectedAliases)
        || !receipt || receipt.operation !== NATIVE_BOARD_LIFECYCLE_OPERATION || receipt.actor_id !== "user:local"
        || receipt.fingerprint !== boardLifecycleFingerprint(event.input)
        || String(receipt.result) !== JSON.stringify(nativeBoardLifecycleResult(event)))
        fail("Board lifecycle receipt, identity, aliases or transition chain changed.");
      latest.set(event.boardKey, { event, digest }); result.push(event);
    }
    return result;
  }) ?? [];
}
export function nativeBoardLifecycleCatalog(root: string, database?: DatabaseSync): Map<string, NativeBoardLifecycleEvent> {
  return new Map(readNativeBoardLifecycleEvents(root, database).map(event => [event.boardKey, event]));
}
export function readNativeBoardGenesis(root: string, key: string, database?: DatabaseSync): NativeBoardGenesis | undefined {
  return withBoardLifecycleDatabase(root, database, db => {
    if (!exists(db, "native_board_genesis")) return undefined;
    const row = db.prepare("SELECT * FROM native_board_genesis WHERE board_key=?").get(key);
    if (!row) return undefined;
    const genesis = checkedGenesis(String(row.payload), row.payload_sha256, boardLifecycleWorkspace(root));
    if (!readNativeBoardLifecycleEvents(root, db).some(event => event.input.operationId === genesis.firstOperationId)
      && readNativeBoardLifecyclePending(db, root)?.event.input.operationId !== genesis.firstOperationId)
      fail("Board genesis has no bound durable operation or receipt.");
    return genesis;
  });
}
export function resolveNativeBoardKey(root: string, locator: string, database?: DatabaseSync, includeTrashed = false): string {
  const path = locator.endsWith(".md") ? locator : `${locator}.md`;
  const matches = [...nativeBoardLifecycleCatalog(root, database).values()]
    .filter(event => event.boardKey === locator || event.noteId === locator || event.aliases.includes(path));
  if (matches.length > 1) fail("Board locator resolves to multiple retained identities.");
  if (!matches.length) return locator;
  if (!includeTrashed && matches[0]!.status === "trashed")
    throw new CoreError("NOT_FOUND", "Board is in Trash; restore its exact identity before using it.");
  return matches[0]!.boardKey;
}
export function assertNativeBoardLifecycleFiles(root: string, event: NativeBoardLifecycleEvent, database?: DatabaseSync): void {
  const pending = withBoardLifecycleDatabase(root, database, db => readNativeBoardLifecyclePending(db, root));
  if (pending?.event.boardKey === event.boardKey || event.status === "trashed") return;
  const markdown = privateRead(checkedDocumentPath(root, event.path, false, "notes"), 1_048_576);
  if (hash(markdown) !== event.documentSha256) fail("Board descriptor differs from its latest file-lifecycle receipt.");
  const genesis = readNativeBoardGenesis(root, event.boardKey, database);
  if (!genesis) fail("Live Board lost its immutable genesis.");
  let path: string;
  try { path = checkedResourcePath(root, `${event.path.replace(/\.md$/i, ".assets")}/pkm-todo-board.json`, false, "notes"); }
  catch (error) {
    if (!genesis.backingPath && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (genesis.backingPath) {
    if (hash(privateRead(path, 2_097_152)) !== genesis.backingSha256)
      fail("Relocated original Board backing differs from its immutable source.");
  } else {
    try { lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    fail("Native-backed Board cannot ignore an appearing original backing.");
  }
}
export function assertNativeBoardWriteTarget(root: string, path: string, database?: DatabaseSync, ownerKey?: string, includePairedAssets = true): void {
  withBoardLifecycleDatabase(root, database, db => assertLegacyUiDeletionWriteTarget(db, root, `notes/${path}`, includePairedAssets));
  for (const event of nativeBoardLifecycleCatalog(root, database).values()) {
    if (event.boardKey !== ownerKey && event.aliases.some(alias => alias.toLowerCase() === path.toLowerCase()))
      throw new CoreError("CONFLICT", "Destination is reserved by a retained Board identity/alias.");
  }
}
/** Original provenance bytes remain immutable; only a bound durable Board operation can relocate their live descriptor. */
export function readNativeBoardGenesisSource(root: string, path: string, expectedSha256: string | undefined, database?: DatabaseSync): Buffer | undefined {
  if (!expectedSha256) return undefined;
  return withBoardLifecycleDatabase(root, database, db => {
    if (!exists(db, "native_board_genesis")) return undefined;
    const events = readNativeBoardLifecycleEvents(root, db), pending = readNativeBoardLifecyclePending(db, root);
    const workspaceId = boardLifecycleWorkspace(root);
    for (const row of db.prepare("SELECT * FROM native_board_genesis").all()) {
      const genesis = checkedGenesis(String(row.payload), row.payload_sha256, workspaceId);
      const markdown = path === `notes/${genesis.markdownPath}`, backing = genesis.backingPath !== null && path === `notes/${genesis.backingPath}`;
      if (!markdown && !backing) continue;
      if (!events.some(event => event.input.operationId === genesis.firstOperationId)
        && pending?.event.input.operationId !== genesis.firstOperationId)
        fail("Unbound Board genesis cannot replace an original source.");
      const bytes = Buffer.from(markdown ? genesis.markdown : genesis.backing);
      if (hash(bytes) !== expectedSha256) fail("Board genesis differs from the original immutable provenance pin.");
      return bytes;
    }
    return undefined;
  });
}
