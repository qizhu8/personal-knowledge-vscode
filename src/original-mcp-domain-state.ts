import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { coreDatabasePath } from "./workspace-storage-paths.js";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { originalMcpPrivateBytes, readOriginalMcpJournal } from "./original-mcp-root-custody.js";
import { readTodoBoard } from "./domain/todo-board.js";
import { legacyMemoryImportReceiptSchema } from "./domain/memory-import-contracts.js";
import { readMemoryScopeContinuity } from "./memory-scope-continuity.js";
import { legacyPrivateRootGuard } from "./legacy-effective-private-root.js";
import { originalMcpDomainIntentSchema, type OriginalMcpDomainIntent } from "./original-mcp-source-policy-contracts.js";
import { readOriginalMcpTodoGenesisSources, readPendingOriginalMcpTodoGenesis } from "./original-mcp-todo-genesis.js";
import { readOriginalMcpTodoGenesisAuthority, originalMcpTodoGenesisAuthorizedKeys } from "./original-mcp-todo-genesis-source.js";
import { readOriginalTodoRoleScope } from "./original-mcp-todo-role-scope.js";
export { originalMcpDomainIntentSchema, type OriginalMcpDomainIntent } from "./original-mcp-source-policy-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const slug = z.string().min(1).max(1024).refine(value =>
  value.split("/").every(part => !!part && !part.startsWith(".") && !/[\\:\u0000-\u001f]/u.test(part)));
export const originalMcpDomainDdl = `
CREATE TABLE original_mcp_domain_intents(
 domain TEXT PRIMARY KEY, payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL);
CREATE TABLE original_mcp_domain_commits(
 domain TEXT PRIMARY KEY, intent_sha256 TEXT NOT NULL);
CREATE TABLE original_mcp_domain_workers(
 receipt_sha256 TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TRIGGER original_mcp_domain_intents_no_update BEFORE UPDATE ON original_mcp_domain_intents
BEGIN SELECT RAISE(ABORT,'original domain intent immutable'); END;
CREATE TRIGGER original_mcp_domain_intents_no_delete BEFORE DELETE ON original_mcp_domain_intents
BEGIN SELECT RAISE(ABORT,'original domain intent immutable'); END;
CREATE TRIGGER original_mcp_domain_commits_no_update BEFORE UPDATE ON original_mcp_domain_commits
BEGIN SELECT RAISE(ABORT,'original domain commit immutable'); END;
CREATE TRIGGER original_mcp_domain_commits_no_delete BEFORE DELETE ON original_mcp_domain_commits
BEGIN SELECT RAISE(ABORT,'original domain commit immutable'); END;
CREATE TRIGGER original_mcp_domain_workers_no_update BEFORE UPDATE ON original_mcp_domain_workers
BEGIN SELECT RAISE(ABORT,'original domain worker admission immutable'); END;
CREATE TRIGGER original_mcp_domain_workers_no_delete BEFORE DELETE ON original_mcp_domain_workers
BEGIN SELECT RAISE(ABORT,'original domain worker admission immutable'); END;`;
export const originalMcpDomainHash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export const originalMcpDomainDirectory = (domain: "todo" | "memory") => `.pkm-next-${domain}`;
export function originalMcpDomainTemporary(intentSha256: string): string {
  digest.parse(intentSha256);
  const value = intentSha256.slice(0, 32);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
export interface OriginalMcpTodoSession {
  intentSha256: string; nativeHostReceiptSha256: string; actorId: "mcp:external"; decisionId: string; expiresAtMs: number;
  revocation: SharedArrayBuffer;
}
const todoSessions = new Map<string, OriginalMcpTodoSession>();
export const originalMcpWorkerSchema = z.strictObject({
  schema: z.literal("pkm.original-mcp-todo-worker/v1"), intentSha256: digest, nativeHostReceiptSha256: digest,
  sessionDecisionId: z.string().min(1).max(256), boardSlug: slug,
  actorId: z.string().regex(/^external:(?:copilot|claude|other):[a-zA-Z0-9_-]{1,80}$/),
  tokenSha256: digest, decisionId: z.string().min(1).max(256), expiresAtMs: z.number().int().positive(),
  receiptSha256: digest,
});
type Worker = z.infer<typeof originalMcpWorkerSchema>;
const todoWorkers = new Map<string, Map<string, Worker>>();
function readWorker(root: string, receiptSha256: string, database?: DatabaseSync): Worker {
  return withDatabase(root, database, db => {
    const state = readOriginalMcpDomain(root, "todo", db), session = todoSessions.get(root);
    if (!state?.committed || !session) fail();
    const row = db.prepare("SELECT payload FROM original_mcp_domain_workers WHERE receipt_sha256=?").get(receiptSha256);
    if (!row) fail();
    const worker = originalMcpWorkerSchema.parse(JSON.parse(String(row.payload))), { receiptSha256: sha, ...body } = worker;
    if (sha !== receiptSha256 || originalMcpDomainHash(body) !== sha || row.payload !== canonicalJson(worker)
      || worker.intentSha256 !== state.intent.intentSha256 || worker.sessionDecisionId !== session.decisionId
      || worker.nativeHostReceiptSha256 !== session.nativeHostReceiptSha256
      || worker.expiresAtMs > session.expiresAtMs || worker.expiresAtMs <= Date.now()
      || !state.intent.files.some(item => item.key === worker.boardSlug)) fail();
    return worker;
  });
}
export function activateOriginalMcpTodoWorker(root: string, receiptSha256: string, database?: DatabaseSync) {
  const worker = readWorker(root, receiptSha256, database);
  let grants = todoWorkers.get(root);
  if (!grants) { grants = new Map(); todoWorkers.set(root, grants); }
  grants.set(`${worker.boardSlug}\0${worker.actorId}`, worker);
}
export function authenticateOriginalMcpTodoWorker(root: string, boardSlug: string, tokenSha256: string): string {
  assertOriginalMcpTodoSession(root, "mcp:external");
  const worker = [...(todoWorkers.get(root)?.values() ?? [])].find(item => item.boardSlug === boardSlug && item.tokenSha256 === tokenSha256);
  if (!worker) throw new CoreError("ACCESS_DENIED", "Old Board grants are never inherited; fresh native worker re-enrollment is required.");
  readWorker(root, worker.receiptSha256);
  return worker.actorId;
}
export function originalMcpTodoSession(root: string): Readonly<OriginalMcpTodoSession> {
  if (!todoSessions.has(root)) throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "An imported Todo session is not a genesis source grant.");
  assertOriginalMcpTodoSession(root, "mcp:external");
  return { ...todoSessions.get(root)! };
}
export interface OriginalMcpTodoAuthority {
  readonly schema: "pkm.original-mcp-todo-authority/v1";
  readonly boardSlug: string; readonly actorId: string; readonly intentSha256: string;
  readonly nativeHostReceiptSha256: string; readonly sessionDecisionId: string; readonly expiresAtMs: number;
  readonly workerReceiptSha256?: string; readonly workerDecisionId?: string;
  readonly revocation: SharedArrayBuffer;
}
/** Read active authority only; retained Board owners and durable worker rows do not enroll an actor. */
export function readOriginalMcpTodoAuthority(root: string, actorId: string, boardSlug: string, database?: DatabaseSync):
Readonly<OriginalMcpTodoAuthority> {
  assertOriginalMcpTodoSession(root, actorId, database, boardSlug);
  const genesis = withDatabase(root, database, db => {
    if (!readOriginalMcpTodoGenesisSources(root, db).some(item => item.key === boardSlug)) return undefined;
    return readOriginalMcpTodoGenesisAuthority(root, db, actorId, boardSlug);
  });
  if (genesis) return Object.freeze({
    schema: "pkm.original-mcp-todo-authority/v1" as const, boardSlug, actorId,
    intentSha256: genesis.source.provenance.creationRequestSha256,
    nativeHostReceiptSha256: genesis.request.nativeHostReceiptSha256,
    sessionDecisionId: genesis.decision.decisionId, expiresAtMs: genesis.decision.expiresAtMs,
    revocation: genesis.revocation,
  });
  const state = readOriginalMcpDomain(root, "todo", database), session = todoSessions.get(root);
  if (!state?.committed || !session || !state.intent.files.some(item => item.key === boardSlug)) fail();
  const worker = actorId === session.actorId ? undefined : todoWorkers.get(root)?.get(`${boardSlug}\0${actorId}`);
  if (actorId !== session.actorId && !worker) fail();
  if (worker) readWorker(root, worker.receiptSha256, database);
  return Object.freeze({
    schema: "pkm.original-mcp-todo-authority/v1" as const, boardSlug, actorId,
    intentSha256: session.intentSha256, nativeHostReceiptSha256: session.nativeHostReceiptSha256,
    sessionDecisionId: session.decisionId, expiresAtMs: Math.min(session.expiresAtMs, worker?.expiresAtMs ?? Infinity),
    ...(worker ? { workerReceiptSha256: worker.receiptSha256, workerDecisionId: worker.decisionId } : {}),
    revocation: session.revocation,
  });
}
export function activateOriginalMcpTodoSession(root: string, session: OriginalMcpTodoSession, database?: DatabaseSync) {
  const state = readOriginalMcpDomain(root, "todo", database);
  if (!state?.committed || state.intent.intentSha256 !== session.intentSha256 || session.actorId !== "mcp:external"
    || !digest.safeParse(session.nativeHostReceiptSha256).success
    || !(session.revocation instanceof SharedArrayBuffer) || session.revocation.byteLength !== 4
    || Atomics.load(new Int32Array(session.revocation), 0) !== 0
    || !session.decisionId || session.expiresAtMs <= Date.now() || session.expiresAtMs > Date.now() + 30 * 60_000) fail();
  todoWorkers.delete(root);
  todoSessions.set(root, { ...session });
}
export function deactivateOriginalMcpTodoSession(root: string) { todoSessions.delete(root); todoWorkers.delete(root); }
export function assertOriginalMcpTodoSession(root: string, actorId: string, database?: DatabaseSync, boardSlug?: string) {
  if (!readOriginalMcpJournal(root)) return;
  const role = readOriginalTodoRoleScope(root, database, actorId);
  if (role) {
    if (boardSlug && boardSlug !== role.boardSlug) throw new CoreError("ACCESS_DENIED", "Todo role is scoped to one exact Board.");
    assertOriginalMcpTodoSession(root, "mcp:external", database, role.boardSlug);
    return;
  }
  if (boardSlug && withDatabase(root, database, db => readOriginalMcpTodoGenesisSources(root, db).some(item => item.key === boardSlug))) {
    withDatabase(root, database, db => readOriginalMcpTodoGenesisAuthority(root, db, actorId, boardSlug));
    return;
  }
  const session = todoSessions.get(root), state = readOriginalMcpDomain(root, "todo", database);
  if (!session || !state?.committed || session.intentSha256 !== state.intent.intentSha256 || session.expiresAtMs <= Date.now()
    || Atomics.load(new Int32Array(session.revocation), 0) !== 0) {
    if (!boardSlug && actorId === "mcp:external"
      && withDatabase(root, database, db => originalMcpTodoGenesisAuthorizedKeys(root, db, actorId).size > 0)) return;
    throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "ORIGINAL_BOARD_AND_WORKER_REBIND_REQUIRED: fresh exact native Todo source admission is required; old worker tokens grant nothing.");
  }
  if (boardSlug && !state.intent.files.some(item => item.key === boardSlug))
    throw new CoreError("ACCESS_DENIED", "The imported session does not admit this exact Board.");
  if (session.actorId !== actorId) {
    const worker = boardSlug ? todoWorkers.get(root)?.get(`${boardSlug}\0${actorId}`) : undefined;
    if (!worker) throw new CoreError("ACCESS_DENIED", "This worker has no fresh native grant for the exact Board.");
    readWorker(root, worker.receiptSha256, database);
  }
}
export function originalMcpTodoAuthorizedBoardKeys(root: string, actorId: string, database?: DatabaseSync): Set<string> {
  const role = readOriginalTodoRoleScope(root, database, actorId);
  if (role) {
    assertOriginalMcpTodoSession(root, "mcp:external", database, role.boardSlug);
    return new Set([role.boardSlug]);
  }
  return withDatabase(root, database, db => {
    const keys = originalMcpTodoGenesisAuthorizedKeys(root, db, actorId), state = readOriginalMcpDomain(root, "todo", db);
    const session = todoSessions.get(root);
    if (session && state?.committed && session.intentSha256 === state.intent.intentSha256
      && session.expiresAtMs > Date.now() && Atomics.load(new Int32Array(session.revocation), 0) === 0) {
      for (const item of state.intent.files) {
        if (session.actorId === actorId) keys.add(item.key);
        else {
          const worker = todoWorkers.get(root)?.get(`${item.key}\0${actorId}`);
          if (worker) { try { readWorker(root, worker.receiptSha256, db); keys.add(item.key); } catch { /* No retained worker authority. */ } }
        }
      }
    }
    return keys;
  });
}
export function readOriginalMcpTodoManifest(root: string, database?: DatabaseSync) {
  return withDatabase(root, database, db => {
    const state = readOriginalMcpDomain(root, "todo", db);
    const files = [...(state?.committed ? state.intent.files : []), ...readOriginalMcpTodoGenesisSources(root, db)];
    if (new Set(files.map(item => item.key)).size !== files.length) fail();
    return files;
  });
}
function fail(): never {
  throw new CoreError("RECOVERY_REQUIRED", "Original Todo/Memory custody, native domain receipt or publication changed; preserve it for reconciliation.");
}
function withDatabase<T>(root: string, supplied: DatabaseSync | undefined, work: (database: DatabaseSync) => T): T {
  const path = coreDatabasePath(root), stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
    || (stat.mode & 0o7002) !== 0 || !legacyPrivateRootGuard(root)) fail();
  const database = supplied ?? new DatabaseSync(path, { readOnly: true });
  try {
    if (database.prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file !== path) fail();
    return work(database);
  } finally { if (!supplied) database.close(); }
}
function verifyDdl(database: DatabaseSync) {
  const query = `SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name LIKE 'original_mcp_domain_%' ORDER BY name`;
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(originalMcpDomainDdl);
    if (JSON.stringify(database.prepare(query).all()) !== JSON.stringify(expected.prepare(query).all())) fail();
  } finally { expected.close(); }
}
export function readOriginalMcpDomain(root: string, domain: "todo" | "memory", database?: DatabaseSync):
  { intent: OriginalMcpDomainIntent; committed: boolean } | undefined {
  const journal = readOriginalMcpJournal(root);
  if (!journal) return;
  return withDatabase(root, database, db => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='original_mcp_domain_intents'").get()) return;
    verifyDdl(db);
    const row = db.prepare("SELECT * FROM original_mcp_domain_intents WHERE domain=?").get(domain);
    if (!row) return;
    const intent = originalMcpDomainIntentSchema.parse(JSON.parse(String(row.payload)));
    const { intentSha256, ...body } = intent;
    if (row.payload !== canonicalJson(intent) || row.payload_sha256 !== intentSha256
      || originalMcpDomainHash(body) !== intentSha256 || intent.domain !== domain || intent.root !== root
      || intent.workspaceId !== journal.workspaceId || intent.custodyPlanSha256 !== journal.plan.planSha256
      || intent.profileSha256 !== journal.plan.profileSha256
      || intent.sourceDetails.domain !== domain
      || new Set(intent.files.map(item => item.key)).size !== intent.files.length) fail();
    const hostRow = db.prepare("SELECT payload FROM original_mcp_native_host_admissions WHERE receipt_sha256=?")
      .get(intent.nativeHostReceiptSha256);
    if (!hostRow) fail();
    const host = JSON.parse(String(hostRow.payload)), { receiptSha256, ...hostBody } = host;
    if (originalMcpDomainHash(hostBody) !== receiptSha256 || receiptSha256 !== intent.nativeHostReceiptSha256
      || host.workspaceId !== intent.workspaceId || host.root !== root
      || host.planSha256 !== intent.custodyPlanSha256 || host.profileSha256 !== intent.profileSha256) fail();
    for (const item of intent.files) {
      if (domain === "memory" && (!/^explicit-[a-f0-9]{64}$/.test(item.key) || item.sourcePath || item.notePath || item.noteSha256
        || !item.stagedPath || !isAbsolute(item.stagedPath) || item.title)) fail();
      if (domain === "todo" && (item.sourcePath !== `notes/${item.key}.assets/pkm-todo-board.json`
        || item.notePath !== `notes/${item.key}.md` || !item.noteSha256 || item.stagedPath || !item.title)) fail();
    }
    const commit = db.prepare("SELECT intent_sha256 FROM original_mcp_domain_commits WHERE domain=?").get(domain);
    if (commit && commit.intent_sha256 !== intentSha256) fail();
    if (commit && domain === "memory") {
      const details = intent.sourceDetails;
      if (details.domain !== "memory") fail();
      const row = db.prepare("SELECT * FROM legacy_memory_imports WHERE singleton=1").get();
      if (!row) fail();
      const imported = legacyMemoryImportReceiptSchema.parse(JSON.parse(String(row.receipt_json)));
      const { receiptSha256, ...body } = imported;
      const binding = readMemoryScopeContinuity(db, intent.workspaceId);
      if (!binding || binding.schema !== "pkm.memory-scope-continuity/v2"
        || binding.actorId !== intent.actorId || binding.importPlanSha256 !== details.importPlanSha256
        || binding.sourceScopeSha256 !== details.sourceScopeSha256
        || imported.sourceDatabaseSha256 !== details.sourceDatabaseSha256 || imported.engineIdentity !== details.engineIdentity
        || imported.actorId !== intent.actorId || imported.records !== details.records || imported.revisions !== details.revisions
        || imported.receiptSha256 !== details.importReceiptSha256
        || createHash("sha256").update(JSON.stringify(body)).digest("hex") !== receiptSha256
        || imported.documents.length !== intent.files.length
        || imported.documents.some(item => !intent.files.some(file => file.key === item.id && file.sha256 === item.sha256)
          || item.path !== `notes/System/Memory/${item.id}.md`)) fail();
    }
    return { intent, committed: !!commit };
  });
}
export function originalMcpDomainFile(root: string, domain: "todo" | "memory", key: string): string {
  slug.parse(key);
  if (domain === "memory" && !/^explicit-[a-f0-9]{64}$/.test(key)) fail();
  const base = join(root, originalMcpDomainDirectory(domain));
  let directory = base;
  for (const part of ["", ...(domain === "todo" ? key.split("/") : [])]) {
    directory = part ? join(directory, part) : directory;
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o7077) !== 0) fail();
  }
  return join(directory, domain === "todo" ? "pkm-todo-board.json" : `${key}.md`);
}
/** Layout admission is a receipt check, not authority to execute a domain or revive a worker. */
export function verifyOriginalMcpDomainFiles(root: string, domain: "todo" | "memory", database?: DatabaseSync): string[] {
  return withDatabase(root, database, db => {
    const state = readOriginalMcpDomain(root, domain, db);
    const genesis = domain === "todo" ? readOriginalMcpTodoGenesisSources(root, db) : [];
    const genesisPending = domain === "todo" ? readPendingOriginalMcpTodoGenesis(root, db) : undefined;
    if (!state && !genesis.length && !genesisPending) fail();
    const files: OriginalMcpDomainIntent["files"] = [...(state?.intent.files ?? []), ...genesis];
    if (genesisPending) {
      const selected = genesisPending.plan.request.selection;
      if (files.some(item => item.key === selected.boardSlug)) fail();
      files.push({ key: selected.boardSlug, sha256: selected.backingSha256, sourcePath: selected.backingPath,
        notePath: selected.notePath, noteSha256: selected.descriptorSha256, title: genesisPending.plan.request.arguments.title });
    }
    if (new Set(files.map(item => item.key)).size !== files.length) fail();
    const required = new Set([...(state?.committed ? state.intent.files.map(item => item.key) : []), ...genesis.map(item => item.key)]);
    const staged: string[] = [];
    const initialBytes = (item: OriginalMcpDomainIntent["files"][number]) => {
      if (genesisPending?.plan.request.selection.boardSlug === item.key)
        return Buffer.from(genesisPending.plan.backing);
      const path = domain === "todo" ? join(root, item.sourcePath!) : item.stagedPath!;
      if (realpathSync(path) !== path) fail();
      if (domain === "memory") {
        const rel = relative(root, path);
        if (!rel || !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) fail();
      }
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
          || stat.size > (domain === "todo" ? 2_097_152 : 536_870_912) || (stat.mode & (domain === "todo" ? 0o7002 : 0o7077)) !== 0) fail();
        const bytes = readFileSync(fd), after = fstatSync(fd);
        if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs
          || createHash("sha256").update(bytes).digest("hex") !== item.sha256) fail();
        return bytes;
      } finally { closeSync(fd); }
    };
    const expected = new Map(files.map(item => [
      domain === "todo" ? `${item.key}/pkm-todo-board.json` : `${item.key}.md`, item.sha256,
    ]));
    if (state?.committed && domain === "memory") {
      for (const row of db.prepare(`SELECT id,digest FROM (
        SELECT json_extract(result,'$.id') AS id,json_extract(result,'$.documentSha256') AS digest,
          row_number() OVER (PARTITION BY json_extract(result,'$.id') ORDER BY rowid DESC) AS latest
        FROM receipts WHERE operation LIKE 'memory.record.%') WHERE latest=1`).all()) {
        if (typeof row.id !== "string" || !/^explicit-[a-f0-9]{64}$/.test(row.id)
          || !digest.safeParse(row.digest).success) fail();
        expected.set(`${row.id}.md`, String(row.digest));
        required.add(row.id);
      }
    }
    const table = domain === "todo" ? "pending_todo" : "pending_write";
    const pending = db.prepare(`SELECT 1 FROM sqlite_master WHERE name=?`).get(table)
      ? db.prepare(`SELECT * FROM ${table} WHERE singleton=1`).get() : undefined;
    const walk = (directory: string, prefix: string) => {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o7077) !== 0) fail();
      for (const name of readdirSync(directory)) {
        const path = join(directory, name), relative = prefix ? `${prefix}/${name}` : name;
        const stat = lstatSync(path);
        if (stat.isDirectory() && domain === "todo" && !stat.isSymbolicLink()) {
          slug.parse(name);
          if (!files.some(item => `${item.key}/pkm-todo-board.json`.startsWith(`${relative}/`))) fail();
          walk(path, relative); continue;
        }
        const importedTemporary = state && !state.committed && name === `.pkm-write-${originalMcpDomainTemporary(state.intent.intentSha256)}`;
        const genesisTemporary = genesisPending && prefix === genesisPending.plan.request.selection.boardSlug
          && name === `.pkm-write-${genesisPending.plan.request.operationId}`;
        const todoTemporary = domain === "todo" && pending && pending.board_slug === prefix
          && files.some(item => item.key === prefix) && name === `.pkm-write-${String(pending.operation_id)}`;
        if (importedTemporary || genesisTemporary || todoTemporary) {
          const bytes = originalMcpPrivateBytes(path, 536_870_912);
          const candidates = domain === "todo" ? files.filter(item => item.key === prefix) : files;
          if (!candidates.some(item => {
            const full = todoTemporary ? Buffer.from(String(pending!.after_json)) : initialBytes(item);
            return bytes.length <= full.length && bytes.equals(full.subarray(0, bytes.length));
          })) fail();
          staged.push(path); continue;
        }
        const bytes = originalMcpPrivateBytes(path, 536_870_912), actual = createHash("sha256").update(bytes).digest("hex");
        const key = domain === "todo" ? relative.replace(/\/pkm-todo-board\.json$/, "") : relative.replace(/\.md$/, "");
        if (domain === "todo" && !files.some(item => item.key === key)
          || domain === "memory" && !/^explicit-[a-f0-9]{64}\.md$/.test(relative)) fail();
        let wanted = expected.get(relative);
        if (state?.committed || genesis.some(item => item.key === key) || genesisPending?.plan.request.selection.boardSlug === key) {
          const row = domain === "todo"
            ? db.prepare(`SELECT result FROM receipts WHERE operation LIKE 'todo.%'
              AND json_extract(result,'$.board_slug')=? ORDER BY rowid DESC LIMIT 1`).get(key)
            : db.prepare(`SELECT result FROM receipts WHERE operation LIKE 'memory.record.%'
              AND json_extract(result,'$.id')=? ORDER BY rowid DESC LIMIT 1`).get(key);
          if (row) wanted = String(JSON.parse(String(row.result))[domain === "todo" ? "digest" : "documentSha256"]);
          if (pending && (domain === "todo" ? pending.board_slug === key
            : String(pending.operation).startsWith("memory.record.") && pending.document_id === key)) {
            const after = String(domain === "todo" ? pending.after_json : pending.after_markdown);
            if (actual === createHash("sha256").update(after).digest("hex")) wanted = actual;
          }
        }
        if (!wanted || actual !== wanted) fail();
        if (domain === "todo") readTodoBoard(bytes.toString("utf8"));
        expected.delete(relative);
      }
    };
    const directory = join(root, originalMcpDomainDirectory(domain));
    if (lstatSync(directory, { throwIfNoEntry: false })) walk(directory, "");
    else if (required.size || state?.committed) fail();
    if ([...expected.keys()].some(path => required.has(domain === "todo" ? path.replace(/\/pkm-todo-board\.json$/, "") : path.replace(/\.md$/, "")))) fail();
    return staged;
  });
}
