import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError, type StorageRequest } from "./contracts.js";
import type { Storage } from "./storage.js";
import { decodeMarkdown, encodeMarkdown } from "./markdown.js";
import { serializeTodoBoard } from "./domain/todo-board.js";
import { assertOriginalMcpPrivacy, originalMcpPrivateTopLevels, originalMcpPrivateBytes } from "./original-mcp-root-custody.js";
import { atomicFileCreateNoReplace } from "./file-write.js";
import { todoDefinitions } from "./todo-definitions.js";
import { interruptExperimentalTodoGenesisPublication, type ExperimentalTodoGenesisFaultControl } from "./original-mcp-todo-genesis-fault.js";
import { verifyOriginalMcpDomainFiles } from "./original-mcp-domain-state.js";
import { assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import {
  originalMcpTodoGenesisArgumentsSchema, originalMcpTodoGenesisBytesDigest as hash,
  originalMcpTodoGenesisRequestDigest as digest, validateOriginalMcpTodoGenesisPlan,
  validateOriginalMcpTodoGenesisProvenance, type OriginalMcpTodoGenesisPlan,
  type OriginalMcpTodoGenesisProvenance, type OriginalMcpTodoGenesisRequest,
  originalMcpTodoGenesisFilesystemIdentitySchema, type OriginalMcpTodoGenesisFilesystemIdentity,
} from "./original-mcp-todo-genesis-contracts.js";

export const ORIGINAL_MCP_TODO_GENESIS_PENDING_OPERATION = "todo.board.create+signed-genesis";
export const ORIGINAL_MCP_TODO_GENESIS_DDL = `
CREATE TABLE IF NOT EXISTS original_todo_genesis_pending(
 operation_id TEXT PRIMARY KEY, creation_plan TEXT NOT NULL, creation_provenance TEXT NOT NULL,
 fingerprint TEXT NOT NULL, review_provenance TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS original_todo_genesis_sources(
 board_slug TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS original_todo_genesis_sources_no_update BEFORE UPDATE ON original_todo_genesis_sources
BEGIN SELECT RAISE(ABORT,'Todo genesis source is immutable'); END;
CREATE TRIGGER IF NOT EXISTS original_todo_genesis_sources_no_delete BEFORE DELETE ON original_todo_genesis_sources
BEGIN SELECT RAISE(ABORT,'Todo genesis source is immutable'); END;`;
export interface OriginalMcpTodoGenesisAdmission {
  plan: OriginalMcpTodoGenesisPlan; provenance: OriginalMcpTodoGenesisProvenance; revocation: SharedArrayBuffer;
}
export interface OriginalMcpTodoGenesisSourceReceipt {
  key: string; sha256: string; sourcePath: string; notePath: string; noteSha256: string; title: string;
  operationId: string; sourceId: string;
  provenance: Readonly<{
    root: string; workspaceId: string; custodyPlanSha256: string; profileSha256: string; catalogSha256: string;
    nativeHostReceiptSha256: string; nativeEpoch: string; creationRequestSha256: string; decisionId: string;
    publicationRequestSha256: string; publicationNativeHostReceiptSha256: string; publicationNativeEpoch: string;
    publicationDecisionId: string;
  }>;
}
export interface OriginalMcpTodoGenesisCustodyTransition {
  schema: "pkm.original-todo-genesis-custody-transition/v1";
  root: string; workspaceId: string; custodyPlanSha256: string; profileSha256: string; catalogSha256: string;
  operationId: string; sourceId: string; status: "pending" | "committed";
  creation: OriginalMcpTodoGenesisProvenance;
  before: ReadonlyArray<{ path: string; state: "absent" | "present"; identity?: OriginalMcpTodoGenesisFilesystemIdentity }>;
  after: ReadonlyArray<{ path: string; state: "absent" | "present"; identity?: OriginalMcpTodoGenesisFilesystemIdentity }>;
  temporary: ReadonlyArray<OriginalMcpTodoGenesisFilesystemIdentity>;
  canonical: Readonly<{ operation: string; operationId: string; actorId: string; fingerprint: string; resultSha256: string }>;
}
const sourceSchema = z.strictObject({
  schema: z.literal("pkm.original-todo-genesis-source/v1"),
  creation: z.unknown(), creationProvenance: z.unknown(), finalReview: z.unknown(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  result: z.object({ actorId: z.literal("mcp:external"), board_slug: z.string(),
    digest: z.string().regex(/^[a-f0-9]{64}$/), title: z.string(), counts: z.record(z.string(), z.number().int()) }),
  filesystem: z.array(originalMcpTodoGenesisFilesystemIdentitySchema).min(5).max(8),
});
function fail(code: string, message = code, effect: "not-committed" | "unknown" = "not-committed"): never {
  throw new CoreError(code, message, effect);
}
function hasTable(db: DatabaseSync, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}
function assertGenesisSchema(db: DatabaseSync, root: string) {
  if (db.prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file !== join(root, "core.sqlite"))
    fail("NATIVE_AUTHORITY_REQUIRED", "Todo genesis requires the same Root database.");
  const expected = new DatabaseSync(":memory:");
  const query = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'original_todo_genesis_%' ORDER BY name";
  try {
    expected.exec(ORIGINAL_MCP_TODO_GENESIS_DDL);
    if (digest(db.prepare(query).all()) !== digest(expected.prepare(query).all()))
      fail("RECOVERY_CONFLICT", "Todo genesis source schema differs from its closed protocol.", "unknown");
  } finally { expected.close(); }
}
function assertGenesisRootProvenance(root: string, db: DatabaseSync, plan: OriginalMcpTodoGenesisPlan) {
  const journal = assertOriginalMcpPrivacy(root), request = plan.request;
  const row = db.prepare("SELECT payload FROM original_mcp_native_host_admissions WHERE receipt_sha256=?")
    .get(request.nativeHostReceiptSha256);
  if (!journal || !row || request.root !== root || request.workspaceId !== journal.workspaceId
    || request.custodyPlanSha256 !== journal.plan.planSha256 || request.profileSha256 !== journal.plan.profileSha256
    || request.privacySha256 !== journal.plan.privacySha256)
    fail("RECOVERY_CONFLICT", "Todo genesis provenance belongs to another Root/custody binding.", "unknown");
  const host = JSON.parse(String(row.payload)), { receiptSha256, ...binding } = host;
  if (digest(binding) !== receiptSha256 || receiptSha256 !== request.nativeHostReceiptSha256
    || binding.root !== root || binding.workspaceId !== request.workspaceId
    || binding.planSha256 !== request.custodyPlanSha256 || binding.profileSha256 !== request.profileSha256
    || binding.sourceCatalogSha256 !== request.catalogSha256 || binding.epoch !== request.nativeEpoch
    || binding.actorId !== "mcp:external" || !Array.isArray(binding.domains) || !binding.domains.includes("mcp-public"))
    fail("RECOVERY_CONFLICT", "Todo genesis Host provenance changed.", "unknown");
}
function fileHash(path: string): string | undefined {
  const before = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!before) return undefined;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!())
    || before.size > 2097152n || Number(before.mode) & 0o7077) fail("TODO_GENESIS_TARGET_CONFLICT");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.ctimeNs !== before.ctimeNs
      || after.mtimeNs !== before.mtimeNs || after.size !== before.size
      || current.dev !== before.dev || current.ino !== before.ino || current.ctimeNs !== before.ctimeNs)
      fail("TODO_GENESIS_TARGET_CONFLICT");
    return hash(bytes);
  } finally { closeSync(fd); }
}
function directoryIdentity(root: string, relative: string) {
  const stat = lstatSync(join(root, relative), { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid!())
    || Number(stat.mode) & 0o7077) fail("TODO_GENESIS_EXISTING_CATEGORY_REQUIRED");
  return { path: relative, device: String(stat.dev), inode: String(stat.ino), uid: String(stat.uid),
    mode: Number(stat.mode) & 0o777 };
}
function assertManagedAncestors(root: string, request: OriginalMcpTodoGenesisRequest) {
  for (const expected of request.selection.managedAncestors ?? []) {
    const stat = lstatSync(join(root, expected.path), { throwIfNoEntry: false });
    if (expected.state === "absent") {
      if (stat) fail("CONFLICT", "The exact genesis namespace appeared after review.");
    } else if (!stat || digest(directoryIdentity(root, expected.path)) !== digest(expected.identity))
      fail("TODO_GENESIS_ANCESTOR_CHANGED");
  }
}
function filesystemIdentity(root: string, path: string): OriginalMcpTodoGenesisFilesystemIdentity {
  const stat = lstatSync(join(root, path), { bigint: true });
  if (stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid!()) || Number(stat.mode) & 0o7077
    || !stat.isFile() && !stat.isDirectory()) fail("RECOVERY_CONFLICT", "Genesis filesystem identity changed.", "unknown");
  return { path, kind: stat.isDirectory() ? "directory" : "file", device: String(stat.dev), inode: String(stat.ino),
    uid: String(stat.uid), mode: Number(stat.mode) & 0o777, sha256: stat.isFile() ? fileHash(join(root, path))! : null };
}
function filesystemPaths(request: OriginalMcpTodoGenesisRequest): string[] {
  const selected = request.selection;
  return [...new Set([...(selected.managedAncestors?.map(item => item.path) ?? []), selected.pairPath,
    dirname(selected.canonicalBoardPath), selected.notePath, selected.backingPath, selected.canonicalBoardPath])];
}
function privacyHash(root: string) {
  const path = join(root, ".pkm/content-privacy.json");
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) fail("TODO_GENESIS_PRIVACY_CHANGED");
  return hash(stat ? readFileSync(path) : "");
}
function absence(root: string, request: OriginalMcpTodoGenesisRequest, db: DatabaseSync) {
  const selection = request.selection;
  if (originalMcpPrivateTopLevels(root, "notes").has(request.arguments.category || request.arguments.title))
    fail("ACCESS_DENIED", "Todo genesis selects public Notes only.");
  if (privacyHash(root) !== request.privacySha256) fail("TODO_GENESIS_PRIVACY_CHANGED");
  for (const identity of selection.ancestors)
    if (digest(directoryIdentity(root, identity.path)) !== digest(identity)) fail("TODO_GENESIS_ANCESTOR_CHANGED");
  assertManagedAncestors(root, request);
  for (const path of [selection.notePath, selection.pairPath, dirname(selection.canonicalBoardPath)])
    if (lstatSync(join(root, path), { throwIfNoEntry: false })) fail("CONFLICT", "Todo genesis never overwrites or converts an occupied target.");
  if (hasTable(db, "original_todo_genesis_sources") && db.prepare("SELECT 1 FROM original_todo_genesis_sources WHERE board_slug=?").get(selection.boardSlug)
    || db.prepare("SELECT 1 FROM legacy_note_workitems_admission WHERE slug=?").get(selection.boardSlug)
    || db.prepare("SELECT 1 FROM documents WHERE path=? AND area='notes'").get(selection.notePath.slice(6)))
    fail("CONFLICT", "Todo genesis source identity is already occupied.");
}
function directoryDigest(root: string, path: string, operationId: string): string | undefined {
  if (!lstatSync(join(root, path), { throwIfNoEntry: false })) return undefined;
  const identity = directoryIdentity(root, path), names = readdirSync(join(root, path)).sort();
  if (names.some(name => name !== "pkm-todo-board.json" && name !== `.pkm-write-${operationId}`))
    fail("RECOVERY_CONFLICT", "Todo genesis pair contains an unowned entry.", "unknown");
  return digest({ identity, files: names.map(name => ({ name, sha256: fileHash(join(root, path, name)) })) });
}
function beforeSelection(root: string, request: OriginalMcpTodoGenesisRequest, sourceIndex: "absent" | "present") {
  const selection = request.selection;
  const target = (sha256: string | undefined) => sha256 === undefined
    ? { state: "absent" as const } : { state: "present" as const, sha256 };
  return {
    note: target(fileHash(join(root, selection.notePath))),
    backing: target(fileHash(join(root, selection.backingPath))),
    pair: target(directoryDigest(root, selection.pairPath, request.operationId)),
    canonicalBoard: target(fileHash(join(root, selection.canonicalBoardPath))),
    canonicalDirectory: target(directoryDigest(root, dirname(selection.canonicalBoardPath), request.operationId)), sourceIndex,
  };
}
function assertReviewSnapshot(root: string, request: OriginalMcpTodoGenesisRequest) {
  if (privacyHash(root) !== request.privacySha256
    || originalMcpPrivateTopLevels(root, "notes").has(request.arguments.category || request.arguments.title))
    fail("TODO_GENESIS_PRIVACY_CHANGED");
  for (const identity of request.selection.ancestors)
    if (digest(directoryIdentity(root, identity.path)) !== digest(identity)) fail("TODO_GENESIS_ANCESTOR_CHANGED");
  assertManagedAncestors(root, request);
  if (digest(beforeSelection(root, request, request.selection.expectedBefore.sourceIndex)) !== digest(request.selection.expectedBefore))
    fail("CONFLICT", "Todo genesis/recovery target changed during exact native review.");
}
function assertPendingPublicationContent(root: string, plan: OriginalMcpTodoGenesisPlan) {
  const actual = beforeSelection(root, plan.request, "absent");
  for (const [target, expected] of [[actual.note, plan.request.selection.descriptorSha256],
    [actual.backing, plan.request.selection.backingSha256], [actual.canonicalBoard, plan.request.selection.backingSha256]] as const) {
    if (target.state === "present" && target.sha256 !== expected)
      fail("RECOVERY_CONFLICT", "Published pending genesis bytes differ from the exact approved plan.", "unknown");
  }
}
function creationIdentity(plan: OriginalMcpTodoGenesisPlan) {
  const { nativeHostReceiptSha256: _host, nativeEpoch: _epoch, phase: _phase, selection, ...request } = plan.request;
  const { expectedBefore: _before, ancestors: _ancestors, managedAncestors: _managed, ...identity } = selection;
  return digest({ request, selection: identity, descriptor: plan.descriptor, backing: plan.backing });
}
function planBody(root: string, host: OriginalMcpNativeHost, args: z.infer<typeof originalMcpTodoGenesisArgumentsSchema>,
  operationId: string) {
  const custody = assertOriginalMcpPrivacy(root);
  if (!custody) fail("NATIVE_AUTHORITY_REQUIRED");
  const boardSlug = args.category ? `${args.category}/${args.title}` : args.title;
  const documentId = `board-${operationId}`, notePath = `notes/${boardSlug}.md`;
  const decoded = decodeMarkdown(documentId, encodeMarkdown(documentId, args.title, "", 1, false, undefined, `${boardSlug}.md`), `${boardSlug}.md`);
  decoded.metadata.set("type", "todo"); decoded.metadata.set("documentKind", "todo-board");
  decoded.metadata.set("tags", []); decoded.metadata.set("created", new Date().toISOString());
  const descriptor = `---\n${decoded.metadata.toString()}---\n`, backing = serializeTodoBoard([]);
  const ancestors = [".", "notes", ...(args.category ? [`notes/${args.category}`] : [])].map(path => directoryIdentity(root, path));
  const managedAncestors = [".pkm-next-todo", ...(args.category ? [`.pkm-next-todo/${args.category}`] : [])]
    .map(path => lstatSync(join(root, path), { throwIfNoEntry: false })
      ? { path, state: "present" as const, identity: directoryIdentity(root, path) }
      : { path, state: "absent" as const });
  const request: OriginalMcpTodoGenesisRequest = {
    schema: "pkm.original-mcp-todo-genesis-request/v1", phase: "create",
    operation: "mcp.tool.todo_board_create", operationId, actorId: "mcp:external",
    root, workspaceId: host.receipt.workspaceId, profileSha256: host.receipt.profileSha256,
    custodyPlanSha256: host.receipt.planSha256, catalogSha256: host.receipt.sourceCatalogSha256,
    nativeHostReceiptSha256: host.receipt.receiptSha256, nativeEpoch: z.string().uuid().parse(host.receipt.epoch),
    arguments: args, argumentsSha256: digest(args), privacySha256: privacyHash(root),
    selection: { boardSlug, documentId, knowledgeId: z.string().parse(decoded.metadata.get("knowledgeId")), sourceId: randomUUID(),
      notePath, pairPath: `notes/${boardSlug}.assets`, backingPath: `notes/${boardSlug}.assets/pkm-todo-board.json`,
      canonicalBoardPath: `.pkm-next-todo/${boardSlug}/pkm-todo-board.json`, descriptorSha256: hash(descriptor),
      backingSha256: hash(backing), layout: "pkm.original-todo-genesis/v1",
      expectedBefore: { note: { state: "absent" }, pair: { state: "absent" }, backing: { state: "absent" },
        canonicalBoard: { state: "absent" }, canonicalDirectory: { state: "absent" }, sourceIndex: "absent" }, ancestors, managedAncestors },
    noExecution: true, noWorkerEnrollment: true, noReviewerDelegation: true,
  };
  return { request, descriptor, backing };
}
export async function prepareOriginalMcpTodoGenesis(storage: Storage, host: OriginalMcpNativeHost,
  input: unknown, operationId: string): Promise<OriginalMcpTodoGenesisPlan> {
  const args = originalMcpTodoGenesisArgumentsSchema.parse(input); z.string().uuid().parse(operationId);
  assertOriginalMcpNativeHost(host, storage);
  return storage.withWorkspaceExclusive(() => {
    storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
    const body = planBody(storage.workspaceRoot(), host, args, operationId);
    const plan = validateOriginalMcpTodoGenesisPlan({ ...body, planSha256: digest(body) });
    const db = storage.connectNative();
    try { absence(storage.workspaceRoot(), plan.request, db); } finally { db.close(); }
    return plan;
  });
}
async function prepareReview(storage: Storage, host: OriginalMcpNativeHost, creation: OriginalMcpTodoGenesisPlan,
  phase: "recover" | "activate-source") {
  assertOriginalMcpNativeHost(host, storage);
  const root = storage.workspaceRoot();
  if (creation.request.root !== root || creation.request.profileSha256 !== host.receipt.profileSha256
    || creation.request.workspaceId !== host.receipt.workspaceId || creation.request.custodyPlanSha256 !== host.receipt.planSha256
    || creation.request.catalogSha256 !== host.receipt.sourceCatalogSha256)
    fail("NATIVE_AUTHORITY_REQUIRED", "Todo genesis review belongs to another Root/source binding.");
  if (phase === "recover") assertPendingPublicationContent(root, creation);
  const request = { ...creation.request, phase, nativeHostReceiptSha256: host.receipt.receiptSha256,
    nativeEpoch: z.string().uuid().parse(host.receipt.epoch),
    selection: { ...creation.request.selection, ancestors: creation.request.selection.ancestors.map(item => directoryIdentity(root, item.path)),
      managedAncestors: creation.request.selection.managedAncestors?.map(item => lstatSync(join(root, item.path), { throwIfNoEntry: false })
        ? { path: item.path, state: "present" as const, identity: directoryIdentity(root, item.path) }
        : { path: item.path, state: "absent" as const }),
      expectedBefore: beforeSelection(root, creation.request, phase === "recover" ? "absent" : "present") } };
  const body = { request, descriptor: creation.descriptor, backing: creation.backing };
  return validateOriginalMcpTodoGenesisPlan({ ...body, planSha256: digest(body) });
}
export async function preparePendingOriginalMcpTodoGenesis(storage: Storage, host: OriginalMcpNativeHost) {
  return storage.withWorkspaceExclusive(async () => {
    const db = storage.connectNative();
    try {
      if (!hasTable(db, "original_todo_genesis_pending")) return undefined;
      const rows = db.prepare("SELECT creation_plan FROM original_todo_genesis_pending").all();
      if (rows.length > 1) fail("RECOVERY_CONFLICT", "Multiple Todo genesis intents require reconciliation.", "unknown");
      if (!rows.length) return undefined;
      return prepareReview(storage, host, validateOriginalMcpTodoGenesisPlan(JSON.parse(String(rows[0]!.creation_plan))), "recover");
    } finally { db.close(); }
  });
}
export async function prepareOriginalMcpTodoGenesisSourceActivation(storage: Storage, host: OriginalMcpNativeHost, slug: string) {
  return storage.withWorkspaceExclusive(async () => {
    const db = storage.connectNative();
    try {
      const entry = readOriginalMcpTodoGenesisSources(storage.workspaceRoot(), db).find(file => file.key === slug);
      if (!entry) fail("NOT_AVAILABLE", "Todo genesis source identity is not admitted.");
      const row = db.prepare("SELECT payload FROM original_todo_genesis_sources WHERE board_slug=?").get(slug)!;
      const source = sourceSchema.parse(JSON.parse(String(row.payload)));
      return prepareReview(storage, host, validateOriginalMcpTodoGenesisPlan(source.creation), "activate-source");
    } finally { db.close(); }
  });
}
export function assertOriginalMcpTodoGenesisSourceActivationCurrent(root: string, value: OriginalMcpTodoGenesisPlan) {
  const plan = validateOriginalMcpTodoGenesisPlan(value);
  if (plan.request.phase !== "activate-source" || plan.request.root !== root) fail("NATIVE_AUTHORITY_REQUIRED");
  assertReviewSnapshot(root, plan.request);
}
function canonicalRequest(plan: OriginalMcpTodoGenesisPlan): StorageRequest {
  return { operation: "todo.board.create", actorId: "mcp:external",
    args: { board_slug: plan.request.selection.boardSlug, operationId: plan.request.operationId } };
}
export function assertOriginalMcpTodoGenesisAdmission(root: string, db: DatabaseSync, request: StorageRequest,
  admission: OriginalMcpTodoGenesisAdmission) {
  const plan = validateOriginalMcpTodoGenesisPlan(admission.plan);
  const provenance = validateOriginalMcpTodoGenesisProvenance(admission.provenance);
  if (!(admission.revocation instanceof SharedArrayBuffer) || admission.revocation.byteLength !== 4
    || Atomics.load(new Int32Array(admission.revocation), 0) !== 0
    || digest(provenance.request) !== digest(plan.request) || digest(request) !== digest(canonicalRequest(plan))
    || plan.request.root !== root || plan.request.workspaceId !== JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8")).id
    || provenance.decision.expiresAtMs <= Date.now() || provenance.decision.expiresAtMs > Date.now() + 120000
    || privacyHash(root) !== plan.request.privacySha256 || request.boardWorker)
    fail("NATIVE_AUTHORITY_REQUIRED", "Todo genesis requires its current exact private admission.");
  assertGenesisRootProvenance(root, db, plan);
  const host = db.prepare("SELECT payload FROM original_mcp_native_host_admissions WHERE receipt_sha256=?")
    .get(plan.request.nativeHostReceiptSha256);
  if (!host) fail("NATIVE_AUTHORITY_REQUIRED");
  const receipt = JSON.parse(String(host.payload));
  if (receipt.epoch !== plan.request.nativeEpoch || receipt.profileSha256 !== plan.request.profileSha256
    || receipt.planSha256 !== plan.request.custodyPlanSha256 || receipt.sourceCatalogSha256 !== plan.request.catalogSha256)
    fail("NATIVE_AUTHORITY_REQUIRED");
  return plan;
}
export function prepareOriginalMcpTodoGenesisIntent(root: string, db: DatabaseSync, request: StorageRequest,
  admission: OriginalMcpTodoGenesisAdmission) {
  if (!db.isTransaction) fail("TRANSACTION_BOUNDARY");
  assertGenesisSchema(db, root);
  const plan = assertOriginalMcpTodoGenesisAdmission(root, db, request, admission);
  if (plan.request.phase !== "create") fail("NATIVE_AUTHORITY_REQUIRED", "Recovery requires its separate fresh-review channel.");
  const fingerprint = digest({ request, genesisPlanSha256: plan.planSha256 });
  const existing = db.prepare("SELECT fingerprint,actor_id,operation,result FROM receipts WHERE operation_id=?").get(plan.request.operationId);
  if (existing) {
    if (existing.fingerprint !== fingerprint || existing.actor_id !== request.actorId || existing.operation !== request.operation)
      fail("CONFLICT", "Todo genesis operation identity belongs to another request.");
    return { result: JSON.parse(String(existing.result)) as Record<string, unknown> };
  }
  absence(root, plan.request, db);
  if (db.prepare("SELECT 1 FROM pending_todo WHERE singleton=1").get()
    || db.prepare("SELECT 1 FROM original_todo_genesis_pending LIMIT 1").get()) fail("RECOVERY_REQUIRED");
  const result = { actorId: "mcp:external", board_slug: plan.request.selection.boardSlug,
    digest: hash(plan.backing), title: plan.request.arguments.title,
    counts: { workitems: 0, userstories: 0, deleted: 0, accepted: 0, todo: 0, active: 0, blocked: 0, "on-hold": 0, completed: 0 } };
  db.prepare("INSERT INTO original_todo_genesis_pending VALUES(?,?,?,?,?)")
    .run(plan.request.operationId, JSON.stringify(plan), JSON.stringify(admission.provenance),
      fingerprint, JSON.stringify(admission.provenance));
  db.prepare("INSERT INTO pending_todo VALUES(1,?,?,?,?,?,?,?,?)").run(plan.request.operationId, fingerprint,
    request.actorId, ORIGINAL_MCP_TODO_GENESIS_PENDING_OPERATION, plan.request.selection.boardSlug, null, plan.backing, JSON.stringify(result));
  return { pending: true };
}
function sync(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function createFile(root: string, path: string, raw: string, operationId: string, beforePublication: () => void) {
  const full = join(root, path), existing = fileHash(full);
  if (existing !== undefined) {
    if (existing !== hash(raw)) fail("RECOVERY_CONFLICT", "Todo genesis publication target changed.", "unknown");
    return;
  }
  atomicFileCreateNoReplace(full, raw, operationId, beforePublication);
}
export function finalizeOriginalMcpTodoGenesis(root: string, db: DatabaseSync, request: StorageRequest,
  admission: OriginalMcpTodoGenesisAdmission, experimentalFault?: ExperimentalTodoGenesisFaultControl) {
  const review = assertOriginalMcpTodoGenesisAdmission(root, db, request, admission);
  const row = db.prepare("SELECT * FROM original_todo_genesis_pending WHERE operation_id=?").get(review.request.operationId);
  const plan = row && validateOriginalMcpTodoGenesisPlan(JSON.parse(String(row.creation_plan)));
  const todo = db.prepare("SELECT * FROM pending_todo WHERE singleton=1").get();
  if (!db.isTransaction || !row || !plan || creationIdentity(review) !== creationIdentity(plan)
    || !["create", "recover"].includes(review.request.phase)
    || !todo || todo.operation !== ORIGINAL_MCP_TODO_GENESIS_PENDING_OPERATION || todo.operation_id !== row.operation_id
    || todo.fingerprint !== row.fingerprint || todo.after_json !== plan.backing || todo.actor_id !== request.actorId)
    fail("RECOVERY_CONFLICT", "Todo genesis compound intent lost its exact binding.", "unknown");
  for (const table of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pending_%'").all()) {
    if (typeof table.name !== "string" || !/^[a-z_]+$/.test(table.name)) fail("RECOVERY_CONFLICT");
    if (table.name !== "pending_todo" && db.prepare(`SELECT 1 FROM "${table.name}" LIMIT 1`).get())
      fail("RECOVERY_REQUIRED", "Another compound intent blocks Todo genesis recovery.", "unknown");
  }
  if (review.request.phase === "create") absence(root, review.request, db);
  else assertReviewSnapshot(root, review.request);
  const selection = plan.request.selection;
  for (const directory of [...(review.request.selection.managedAncestors?.map(item => item.path) ?? []),
    selection.pairPath, dirname(selection.canonicalBoardPath)]) {
    const full = join(root, directory);
    if (!lstatSync(full, { throwIfNoEntry: false })) { mkdirSync(full, { mode: 0o700 }); sync(dirname(full)); }
    directoryIdentity(root, directory);
  }
  for (const [path, raw] of [[selection.notePath, plan.descriptor], [selection.backingPath, plan.backing],
    [selection.canonicalBoardPath, plan.backing]] as const) {
    assertOriginalMcpTodoGenesisAdmission(root, db, request, admission);
    createFile(root, path, raw, plan.request.operationId,
      () => { assertOriginalMcpTodoGenesisAdmission(root, db, request, admission); });
    if (path === selection.backingPath && experimentalFault) {
      assertOriginalMcpTodoGenesisAdmission(root, db, request, admission);
      interruptExperimentalTodoGenesisPublication(root, admission, experimentalFault);
    }
  }
  if (readdirSync(join(root, selection.pairPath)).join("") !== "pkm-todo-board.json"
    || readdirSync(join(root, dirname(selection.canonicalBoardPath))).join("") !== "pkm-todo-board.json")
    fail("RECOVERY_CONFLICT", "Todo genesis owned pair contains an unexpected entry.", "unknown");
  const record = decodeMarkdown(selection.documentId, plan.descriptor, selection.notePath.slice(6)).record;
  db.prepare("INSERT INTO documents(id,title,revision,deleted,sha256,path,area) VALUES(?,?,?,?,?,?,?)")
    .run(record.id, record.title, record.revision, 0, record.sha256, record.path, record.area);
  const result = JSON.parse(String(todo.result));
  const payload = sourceSchema.parse({ schema: "pkm.original-todo-genesis-source/v1", creation: plan,
    creationProvenance: JSON.parse(String(row.creation_provenance)), finalReview: admission.provenance, fingerprint: row.fingerprint, result,
    filesystem: filesystemPaths(plan.request).map(path => filesystemIdentity(root, path)) });
  db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(plan.request.operationId, row.fingerprint,
    JSON.stringify(result), request.actorId, request.operation, new Date().toISOString());
  db.prepare("INSERT INTO original_todo_genesis_sources VALUES(?,?,?,?)")
    .run(selection.boardSlug, plan.request.operationId, JSON.stringify(payload), digest(payload));
  db.prepare(`INSERT INTO legacy_note_workitems_admission
    (slug,source_markdown_sha256,source_board_sha256,native_board_sha256,admitted_at) VALUES(?,?,?,?,?)`)
    .run(selection.boardSlug, selection.descriptorSha256, selection.backingSha256, selection.backingSha256, new Date().toISOString());
  db.prepare("DELETE FROM original_todo_genesis_pending WHERE operation_id=?").run(plan.request.operationId);
  db.prepare("DELETE FROM pending_todo WHERE singleton=1").run();
  return result as Record<string, unknown>;
}
export function readOriginalMcpTodoGenesisSources(root: string, db: DatabaseSync): OriginalMcpTodoGenesisSourceReceipt[] {
  if (!hasTable(db, "original_todo_genesis_sources")) return [];
  assertGenesisSchema(db, root);
  return db.prepare("SELECT * FROM original_todo_genesis_sources ORDER BY board_slug").all().map(row => {
    const source = sourceSchema.parse(JSON.parse(String(row.payload)));
    const plan = validateOriginalMcpTodoGenesisPlan(source.creation);
    const provenance = validateOriginalMcpTodoGenesisProvenance(source.creationProvenance);
    const finalReview = validateOriginalMcpTodoGenesisProvenance(source.finalReview);
    assertGenesisRootProvenance(root, db, plan);
    const reviewedBody = { request: finalReview.request, descriptor: plan.descriptor, backing: plan.backing };
    const reviewedPlan = validateOriginalMcpTodoGenesisPlan({ ...reviewedBody, planSha256: digest(reviewedBody) });
    if (plan.request.phase !== "create" || !["create", "recover"].includes(finalReview.request.phase)
      || creationIdentity(reviewedPlan) !== creationIdentity(plan))
      fail("RECOVERY_CONFLICT", "Todo genesis publication provenance changed its exact creation identity.", "unknown");
    assertGenesisRootProvenance(root, db, reviewedPlan);
    if (source.filesystem.length !== filesystemPaths(plan.request).length
      || new Set(source.filesystem.map(item => item.path)).size !== source.filesystem.length
      || source.filesystem.some(item => !filesystemPaths(plan.request).includes(item.path)))
      fail("RECOVERY_CONFLICT", "Genesis filesystem receipt lost its exact paths.", "unknown");
    for (const before of source.filesystem) {
      const after = filesystemIdentity(root, before.path);
      if (before.path === plan.request.selection.canonicalBoardPath) {
        if (after.kind !== "file" || after.mode !== before.mode || after.uid !== before.uid) fail("RECOVERY_CONFLICT");
      } else if (digest(after) !== digest(before)) fail("RECOVERY_CONFLICT", "Genesis immutable filesystem identity changed.", "unknown");
    }
    const receipt = db.prepare("SELECT * FROM receipts WHERE operation_id=?").get(plan.request.operationId);
    const current = db.prepare(`SELECT result FROM receipts WHERE operation LIKE 'todo.%'
      AND json_extract(result,'$.board_slug')=? ORDER BY rowid DESC LIMIT 1`).get(plan.request.selection.boardSlug);
    const currentDigest = current && z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/) }).parse(JSON.parse(String(current.result))).digest;
    const canonicalDigest = fileHash(join(root, plan.request.selection.canonicalBoardPath));
    const pending = db.prepare("SELECT * FROM pending_todo WHERE singleton=1 AND board_slug=?")
      .get(plan.request.selection.boardSlug);
    const pendingAfter = pending && todoDefinitions.some(definition => definition.id === pending.operation && !definition.readOnly)
      && pending.before_sha256 === currentDigest && hash(String(pending.after_json)) === canonicalDigest;
    if (source.creation === undefined || digest(source) !== row.payload_sha256
      || row.board_slug !== plan.request.selection.boardSlug || row.operation_id !== plan.request.operationId
      || digest(provenance.request) !== digest(plan.request) || plan.request.root !== root
      || !receipt || receipt.actor_id !== "mcp:external" || receipt.operation !== "todo.board.create"
      || receipt.fingerprint !== source.fingerprint || receipt.result !== JSON.stringify(source.result)
      || source.fingerprint !== digest({ request: canonicalRequest(plan), genesisPlanSha256: plan.planSha256 })
      || fileHash(join(root, plan.request.selection.notePath)) !== plan.request.selection.descriptorSha256
      || fileHash(join(root, plan.request.selection.backingPath)) !== plan.request.selection.backingSha256
      || currentDigest !== canonicalDigest && !pendingAfter)
      fail("RECOVERY_CONFLICT", "Todo genesis source or canonical publication receipt changed.", "unknown");
    return { key: plan.request.selection.boardSlug, sha256: plan.request.selection.backingSha256,
      sourcePath: plan.request.selection.backingPath, notePath: plan.request.selection.notePath,
      noteSha256: plan.request.selection.descriptorSha256, title: plan.request.arguments.title,
      operationId: plan.request.operationId, sourceId: plan.request.selection.sourceId,
      provenance: Object.freeze({ root, workspaceId: plan.request.workspaceId,
        custodyPlanSha256: plan.request.custodyPlanSha256, profileSha256: plan.request.profileSha256,
        catalogSha256: plan.request.catalogSha256, nativeHostReceiptSha256: plan.request.nativeHostReceiptSha256,
        nativeEpoch: plan.request.nativeEpoch, creationRequestSha256: digest(plan.request),
        decisionId: provenance.decision.decisionId, publicationRequestSha256: digest(finalReview.request),
        publicationNativeHostReceiptSha256: finalReview.request.nativeHostReceiptSha256,
        publicationNativeEpoch: finalReview.request.nativeEpoch, publicationDecisionId: finalReview.decision.decisionId }) };
  });
}
export function originalMcpTodoGenesisCustodyExceptions(root: string, db: DatabaseSync) {
  const selections = readOriginalMcpTodoGenesisSources(root, db).map(source => {
    const row = db.prepare("SELECT payload FROM original_todo_genesis_sources WHERE board_slug=?").get(source.key)!;
    return validateOriginalMcpTodoGenesisPlan(sourceSchema.parse(JSON.parse(String(row.payload))).creation).request;
  });
  const pendingSelections: OriginalMcpTodoGenesisRequest[] = [];
  if (hasTable(db, "original_todo_genesis_pending")) {
    assertGenesisSchema(db, root);
    const rows = db.prepare("SELECT * FROM original_todo_genesis_pending").all();
    if (rows.length > 1) fail("RECOVERY_CONFLICT", "Multiple Todo genesis footprint intents are invalid.", "unknown");
    for (const row of rows) {
      const plan = validateOriginalMcpTodoGenesisPlan(JSON.parse(String(row.creation_plan)));
      const provenance = validateOriginalMcpTodoGenesisProvenance(JSON.parse(String(row.creation_provenance)));
      const pending = db.prepare("SELECT * FROM pending_todo WHERE singleton=1").get();
      if (plan.request.root !== root || plan.request.operationId !== row.operation_id
        || digest(plan.request) !== digest(provenance.request) || !pending
        || pending.operation !== ORIGINAL_MCP_TODO_GENESIS_PENDING_OPERATION
        || pending.operation_id !== row.operation_id || pending.fingerprint !== row.fingerprint
        || pending.actor_id !== "mcp:external" || pending.board_slug !== plan.request.selection.boardSlug
        || pending.after_json !== plan.backing || row.fingerprint !== digest({
          request: canonicalRequest(plan), genesisPlanSha256: plan.planSha256,
        })) fail("RECOVERY_CONFLICT", "Todo genesis footprint lacks its exact compound intent.", "unknown");
      assertGenesisRootProvenance(root, db, plan);
      if (db.prepare("SELECT 1 FROM original_todo_genesis_sources WHERE operation_id=? OR board_slug=?")
        .get(plan.request.operationId, plan.request.selection.boardSlug))
        fail("RECOVERY_CONFLICT", "A committed Todo genesis cannot retain a pending publication allowance.", "unknown");
      selections.push(plan.request);
      pendingSelections.push(plan.request);
    }
  }
  const files = new Set<string>(), directories = new Set<string>(), temporaries = new Set<string>();
  for (const request of selections) {
    const selection = request.selection;
    for (const path of [selection.notePath, selection.backingPath, selection.canonicalBoardPath]) {
      files.add(path);
    }
    directories.add(selection.pairPath); directories.add(dirname(selection.canonicalBoardPath));
  }
  for (const request of pendingSelections)
    for (const path of [request.selection.notePath, request.selection.backingPath, request.selection.canonicalBoardPath])
      temporaries.add(`${dirname(path)}/.pkm-write-${request.operationId}`);
  return { files, directories, temporaries };
}
export function readPendingOriginalMcpTodoGenesis(root: string, db: DatabaseSync) {
  if (!hasTable(db, "original_todo_genesis_pending")) return undefined;
  assertGenesisSchema(db, root);
  const rows = db.prepare("SELECT * FROM original_todo_genesis_pending").all();
  if (!rows.length) return undefined;
  if (rows.length !== 1) fail("RECOVERY_CONFLICT", "Multiple Todo genesis compound intents are invalid.", "unknown");
  const row = rows[0]!, plan = validateOriginalMcpTodoGenesisPlan(JSON.parse(String(row.creation_plan)));
  const provenance = validateOriginalMcpTodoGenesisProvenance(JSON.parse(String(row.creation_provenance)));
  const pending = db.prepare("SELECT * FROM pending_todo WHERE singleton=1").get();
  if (plan.request.operationId !== row.operation_id || digest(provenance.request) !== digest(plan.request)
    || !pending || pending.operation !== ORIGINAL_MCP_TODO_GENESIS_PENDING_OPERATION || pending.operation_id !== row.operation_id
    || pending.actor_id !== "mcp:external" || pending.board_slug !== plan.request.selection.boardSlug
    || pending.fingerprint !== row.fingerprint || pending.before_sha256 !== null || pending.after_json !== plan.backing
    || row.fingerprint !== digest({ request: canonicalRequest(plan), genesisPlanSha256: plan.planSha256 })
    || db.prepare("SELECT 1 FROM original_todo_genesis_sources WHERE operation_id=? OR board_slug=?")
      .get(row.operation_id, pending.board_slug))
    fail("RECOVERY_CONFLICT", "Todo genesis pending data lacks its canonical compound intent.", "unknown");
  assertGenesisRootProvenance(root, db, plan);
  return { plan, provenance, fingerprint: String(row.fingerprint), result: JSON.parse(String(pending.result)) as unknown };
}
export function readOriginalMcpTodoGenesisCustodyTransitions(root: string, db: DatabaseSync): OriginalMcpTodoGenesisCustodyTransition[] {
  const committed = readOriginalMcpTodoGenesisSources(root, db).map(source => {
    const row = db.prepare("SELECT payload FROM original_todo_genesis_sources WHERE board_slug=?").get(source.key)!;
    const payload = sourceSchema.parse(JSON.parse(String(row.payload)));
    return { plan: validateOriginalMcpTodoGenesisPlan(payload.creation),
      provenance: validateOriginalMcpTodoGenesisProvenance(payload.creationProvenance),
      fingerprint: payload.fingerprint, result: payload.result, status: "committed" as const };
  });
  const pending = readPendingOriginalMcpTodoGenesis(root, db);
  if (pending) {
    assertPendingPublicationContent(root, pending.plan);
    if (lstatSync(join(root, ".pkm-next-todo"), { throwIfNoEntry: false }))
      verifyOriginalMcpDomainFiles(root, "todo", db);
  }
  const entries = [...committed, ...(pending ? [{ ...pending, status: "pending" as const }] : [])];
  return entries.map(entry => {
    const request = entry.plan.request, selected = request.selection;
    const before: Array<{ path: string; state: "absent" | "present"; identity?: OriginalMcpTodoGenesisFilesystemIdentity }> =
      request.selection.ancestors.map(identity => ({ path: identity.path, state: "present",
        identity: { ...identity, kind: "directory", sha256: null } }));
    for (const ancestor of selected.managedAncestors ?? [])
      before.push(ancestor.state === "absent" ? { path: ancestor.path, state: "absent" } : {
        path: ancestor.path, state: "present", identity: { ...ancestor.identity, kind: "directory", sha256: null },
      });
    for (const path of [selected.notePath, selected.pairPath, selected.backingPath,
      dirname(selected.canonicalBoardPath), selected.canonicalBoardPath]) before.push({ path, state: "absent" });
    const after = [...new Set(before.map(item => item.path))].map(path => lstatSync(join(root, path), { throwIfNoEntry: false })
      ? { path, state: "present" as const, identity: filesystemIdentity(root, path) } : { path, state: "absent" as const });
    if (entry.status === "pending") {
      const approved = new Map([[selected.notePath, selected.descriptorSha256],
        [selected.backingPath, selected.backingSha256], [selected.canonicalBoardPath, selected.backingSha256]]);
      if (after.some(item => item.state === "present" && approved.has(item.path)
        && item.identity.sha256 !== approved.get(item.path)))
        fail("RECOVERY_CONFLICT", "Pending genesis changed while its validated transition was assembled.", "unknown");
    }
    const temporary: OriginalMcpTodoGenesisFilesystemIdentity[] = [];
    for (const [path, raw] of [[selected.notePath, entry.plan.descriptor], [selected.backingPath, entry.plan.backing],
      [selected.canonicalBoardPath, entry.plan.backing]] as const) {
      const name = `${dirname(path)}/.pkm-write-${request.operationId}`;
      if (!lstatSync(join(root, name), { throwIfNoEntry: false })) continue;
      if (entry.status !== "pending") fail("RECOVERY_CONFLICT", "Committed genesis grants no temporary-file exception.", "unknown");
      const bytes = originalMcpPrivateBytes(join(root, name), 2097152), expected = Buffer.from(raw);
      if (bytes.length > expected.length || !bytes.equals(expected.subarray(0, bytes.length)))
        fail("RECOVERY_CONFLICT", "Genesis temporary differs from the exact compound intent.", "unknown");
      const identity = filesystemIdentity(root, name);
      if (identity.sha256 !== hash(bytes)) fail("RECOVERY_CONFLICT", "Genesis temporary changed during inspection.", "unknown");
      temporary.push(identity);
    }
    return {
      schema: "pkm.original-todo-genesis-custody-transition/v1", root, workspaceId: request.workspaceId,
      custodyPlanSha256: request.custodyPlanSha256, profileSha256: request.profileSha256, catalogSha256: request.catalogSha256,
      operationId: request.operationId, sourceId: selected.sourceId, status: entry.status, creation: entry.provenance,
      before, after, temporary, canonical: { operation: entry.status === "pending" ? ORIGINAL_MCP_TODO_GENESIS_PENDING_OPERATION : "todo.board.create",
        operationId: request.operationId, actorId: "mcp:external", fingerprint: entry.fingerprint, resultSha256: digest(entry.result) },
    };
  });
}
export function assertNoPendingOriginalMcpTodoGenesis(db: DatabaseSync) {
  if (hasTable(db, "original_todo_genesis_pending") && db.prepare("SELECT 1 FROM original_todo_genesis_pending LIMIT 1").get())
    fail("RECOVERY_AUTHORITY_REQUIRED", "Pending Todo genesis needs a fresh exact signed recovery review.", "unknown");
}
