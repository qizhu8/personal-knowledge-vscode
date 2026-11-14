import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError, documentId, type Actor } from "./contracts.js";
import { documentPath } from "./document-path.js";
import { decodeMarkdown, scanMarkdown } from "./markdown.js";
import type { Storage } from "./storage.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => JSON.stringify(value);
const fail = (code: string, message: string, unknown = false): never => {
  throw new CoreError(code, message, unknown ? "unknown" : undefined);
};
const rowSchema = z.strictObject({
  path: z.string(), sha256: digest, mode: z.enum(["100644", "100755"]), bytes: z.string(),
});
const admissionSchema = z.strictObject({
  schema: z.literal("pkm.legacy-knowledge-recovery-admission/v1"),
  workspaceId: z.string().uuid(), workspaceRoot: z.string(), actorId: z.string().min(1),
  authorityId: z.string().min(1), evidenceRoot: z.string(), auditRoot: z.string(),
  rootPin: z.string(), planSha256: digest, planBytes: z.string(), rows: z.array(rowSchema).max(1000),
});
type Admission = z.infer<typeof admissionSchema>;
type Row = z.infer<typeof rowSchema>;
const reportSchema = z.strictObject({
  schema: z.literal("pkm.knowledge-recovery-result/v1"), knowledge_root: z.string(),
  plan_sha256: digest, started_at: z.string(), restored: z.array(z.string()),
  identical: z.array(z.string()), preserved_existing: z.array(z.string()), completed_at: z.string().optional(),
});
const intentSchema = z.strictObject({
  operationId: z.string().uuid(), admissionSha256: digest, admission: admissionSchema, auditPin: z.string().nullable(),
  report: reportSchema, reportPath: z.string(), cursor: z.number().int().nonnegative(),
  rows: z.array(z.strictObject({ row: rowSchema, status: z.enum(["restore", "identical", "preserve-existing"]) })),
  staged: z.strictObject({ path: z.string(), target: z.string(), pin: z.string() }).nullable(),
});
type Intent = z.infer<typeof intentSchema>;
const ddl = `
CREATE TABLE IF NOT EXISTS legacy_knowledge_recovery_admissions (admission_sha256 TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS legacy_knowledge_recovery_intent (singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS legacy_knowledge_recovery_receipts (operation_id TEXT PRIMARY KEY, payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS legacy_knowledge_recovery_admissions_no_update BEFORE UPDATE ON legacy_knowledge_recovery_admissions BEGIN SELECT RAISE(ABORT,'knowledge recovery admission immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_knowledge_recovery_admissions_no_delete BEFORE DELETE ON legacy_knowledge_recovery_admissions BEGIN SELECT RAISE(ABORT,'knowledge recovery admission immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_knowledge_recovery_receipts_no_update BEFORE UPDATE ON legacy_knowledge_recovery_receipts BEGIN SELECT RAISE(ABORT,'knowledge recovery receipt immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_knowledge_recovery_receipts_no_delete BEFORE DELETE ON legacy_knowledge_recovery_receipts BEGIN SELECT RAISE(ABORT,'knowledge recovery receipt immutable'); END;`;
const pin = (stat: { dev: number | bigint; ino: number | bigint } | undefined) => {
  if (!stat) return fail("INVALID_DOCUMENT", "Recovery file identity is missing.");
  return `${stat.dev}:${stat.ino}`;
};
function canonicalRoot(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path) fail("INVALID_ARGUMENT", "Recovery roots must be exact absolute native-host selections.");
  let current = path;
  for (;;) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_ARGUMENT", "Recovery roots and parents must be regular directories.");
    if (dirname(current) === current) break;
    current = dirname(current);
  }
  if (realpathSync(path) !== path) fail("INVALID_ARGUMENT", "Recovery roots cannot use aliases.");
  return path;
}
function readRegular(path: string) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    fail("INVALID_DOCUMENT", "Recovery refuses linked or nonregular files.");
  if (before.size > 16_777_216) fail("NOT_AVAILABLE", "Recovery file exceeds the bounded native snapshot size.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (pin(before) !== pin(after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) fail("CONFLICT", "Recovery source changed while reading.");
    return bytes;
  } finally { closeSync(fd); }
}
function checkedRow(row: Row) {
  const parts = row.path.split("/"), area = parts.shift();
  if ((area !== "notes" && area !== "skills") || !documentPath.safeParse(parts.join("/")).success
    || parts[0]?.toLowerCase() === "system")
    fail("NOT_AVAILABLE", "Recovery currently supports portable non-System Note/Skill Markdown only; no assets or Board descriptors.");
  const bytes = Buffer.from(row.bytes, "base64");
  if (bytes.toString("base64") !== row.bytes || sha(bytes) !== row.sha256)
    fail("INVALID_DOCUMENT", "Recovery payload digest changed.");
  const raw = bytes.toString("utf8");
  if (!Buffer.from(raw).equals(bytes)) fail("NOT_AVAILABLE", "Native recovered Markdown requires valid UTF-8.");
  const parsed = decodeMarkdown("recovery-preview", raw, parts.join("/"), area as "notes" | "skills");
  if (parsed.metadata.get("documentKind") === "todo-board")
    fail("NOT_AVAILABLE", "Todo Boards require their paired native admission, not raw recovery.");
  return bytes;
}
function destination(root: string, path: string, create = false) {
  const parts = path.split("/"), full = join(root, ...parts);
  let directory = root;
  for (const part of parts.slice(0, -1)) {
    directory = join(directory, part);
    let stat = lstatSync(directory, { throwIfNoEntry: false });
    if (!stat && create) {
      mkdirSync(directory, { mode: 0o700 });
      flushDirectory(dirname(directory));
      stat = lstatSync(directory);
    }
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_DOCUMENT", "Recovery destination parents must be real directories.");
  }
  return full;
}
function flushDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function snapshot(root: string, rows: Row[]) {
  return rows.map(row => {
    checkedRow(row);
    const path = destination(root, row.path), stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) {
      if (lstatSync(path.replace(/\.md$/i, ".assets"), { throwIfNoEntry: false })
        || row.path.startsWith("notes/") && lstatSync(join(root, "boards", ...row.path.split("/").slice(1).join("/").replace(/\.md$/i, "").split("/"),
          "pkm-todo-board.json"), { throwIfNoEntry: false }))
        fail("NOT_AVAILABLE", "Recovery cannot adopt orphan assets or existing native Board authority.");
      return { row, status: "restore" as const };
    }
    const bytes = readRegular(path);
    return { row, status: sha(bytes) === row.sha256 ? "identical" as const : "preserve-existing" as const };
  });
}
function validateFutureDocuments(root: string, rows: ReturnType<typeof snapshot>) {
  const existing = scanMarkdown(root), ids = new Set(existing.map(document => document.record.id));
  const knowledgeIds = new Set(existing.flatMap(document => {
    const id = document.metadata.get("knowledgeId");
    return typeof id === "string" ? [id] : [];
  }));
  for (const { row, status } of rows) {
    if (status !== "restore") continue;
    const [area, ...parts] = row.path.split("/"), path = parts.join("/");
    const parsed = decodeMarkdown("recovery-validation", checkedRow(row).toString("utf8"), path, area as "notes" | "skills");
    const values = parsed.metadata.toJS() as Record<string, unknown>, aliases = values.aliases;
    const prototypeIds = values.schema === "pkm.knowledge/v1" && values.revision !== undefined && values.deleted !== undefined
      && Array.isArray(aliases) ? [...new Set(aliases.filter((alias): alias is string =>
        typeof alias === "string" && alias.startsWith("note:") && documentId.safeParse(alias.slice(5)).success)
        .map(alias => alias.slice(5)))] : [];
    const identity = Object.prototype.hasOwnProperty.call(values, "documentId")
      ? values.documentId : prototypeIds.length === 1 ? prototypeIds[0] : values.knowledgeId;
    const filename = basename(path).replace(/\.md$/i, "");
    const id = identity === undefined ? area === "notes" && parts.length === 1 && documentId.safeParse(filename).success
      ? filename : `legacy_${sha(area === "notes" ? path : row.path).slice(0, 32)}` : identity;
    if (!documentId.safeParse(id).success || typeof id !== "string" || ids.has(id))
      fail("INVALID_DOCUMENT", "Recovery would introduce an invalid or duplicate native document identity.");
    ids.add(id as string);
    if (typeof values.knowledgeId === "string") {
      if (knowledgeIds.has(values.knowledgeId)) fail("CONFLICT", "Recovery would duplicate an existing Knowledge identity.");
      knowledgeIds.add(values.knowledgeId);
    }
  }
}
function validateSource(admission: Admission) {
  if (canonicalRoot(admission.evidenceRoot) !== admission.auditRoot
    || pin(lstatSync(admission.evidenceRoot)) !== admission.rootPin
    || !readRegular(join(admission.evidenceRoot, "plan.json")).equals(Buffer.from(admission.planBytes, "base64")))
    fail("CONFLICT", "Original recovery evidence changed after native approval.");
  canonicalRoot(join(admission.evidenceRoot, "blobs"));
  for (const row of admission.rows) if (!readRegular(join(admission.evidenceRoot, "blobs", row.sha256)).equals(checkedRow(row)))
    fail("CONFLICT", "Original recovery blob changed after native approval.");
}
function parseAdmission(payload: string, id: string) {
  if (sha(payload) !== id) fail("INVALID_DOCUMENT", "Recovery admission digest changed.");
  const admission = admissionSchema.parse(JSON.parse(payload));
  if (admission.auditRoot !== admission.evidenceRoot || sha(Buffer.from(admission.planBytes, "base64")) !== admission.planSha256
    || new Set(admission.rows.map(row => row.path)).size !== admission.rows.length)
    fail("INVALID_DOCUMENT", "Recovery admission bindings changed.");
  for (const row of admission.rows) checkedRow(row);
  const plan = JSON.parse(Buffer.from(admission.planBytes, "base64").toString("utf8")) as {
    schema?: unknown; knowledgeRoot?: unknown; files?: unknown;
  };
  if (plan.schema !== "pkm.knowledge-recovery/v1" || plan.knowledgeRoot !== admission.workspaceRoot
    || !Array.isArray(plan.files) || encode(plan.files.map(row => {
      const source = row as { path: unknown; sha256: unknown; mode: unknown };
      return { path: source.path, sha256: source.sha256, mode: source.mode };
    })) !== encode(admission.rows.map(({ path, sha256, mode }) => ({ path, sha256, mode }))))
    fail("INVALID_DOCUMENT", "Recovery payload differs from the original approved plan.");
  return admission;
}
function hasTables(db: DatabaseSync) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name GLOB 'legacy_knowledge_recovery_*'").get();
}
function parseIntent(db: DatabaseSync, payload: string, payloadSha256: string) {
  if (sha(payload) !== payloadSha256) fail("INVALID_DOCUMENT", "Recovery intent changed.");
  const intent = intentSchema.parse(JSON.parse(payload));
  const row = db.prepare("SELECT payload FROM legacy_knowledge_recovery_admissions WHERE admission_sha256=?").get(intent.admissionSha256);
  if (!row || encode(intent.admission) !== row.payload) fail("INVALID_DOCUMENT", "Recovery intent lacks its exact immutable admission.");
  parseAdmission(String(row!.payload), intent.admissionSha256);
  const paths = [...intent.report.restored, ...intent.report.identical, ...intent.report.preserved_existing];
  if (intent.cursor > intent.rows.length || intent.rows.length !== intent.admission.rows.length
    || encode(intent.rows.map(row => row.row)) !== encode(intent.admission.rows)
    || new Set(paths).size !== paths.length || paths.length !== intent.cursor
    || paths.some(path => !intent.rows.slice(0, intent.cursor).some(row => row.row.path === path))
    || intent.report.knowledge_root !== intent.admission.workspaceRoot
    || intent.report.plan_sha256 !== intent.admission.planSha256
    || dirname(intent.reportPath) !== intent.admission.auditRoot
    || !/^result-\d{8}T\d{12}\.json$/.test(basename(intent.reportPath)))
    fail("INVALID_DOCUMENT", "Recovery intent paths, cursor or report bindings changed.");
  return intent;
}
export function verifyLegacyKnowledgeRecovery(db: DatabaseSync, root: string, allowPending = false) {
  if (!hasTables(db)) return;
  if (![24, 25, 26, 27, 28].includes(Number(db.prepare("PRAGMA user_version").get()?.user_version)))
    fail("INVALID_DOCUMENT", "Native recovery authority requires downgrade-fenced schema version 24 through 28.");
  const expected = new (db.constructor as { new(path: string): DatabaseSync })(":memory:");
  try {
    expected.exec(ddl);
    const sql = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name GLOB 'legacy_knowledge_recovery_*' ORDER BY name";
    if (encode(db.prepare(sql).all()) !== encode(expected.prepare(sql).all()))
      fail("INVALID_DOCUMENT", "Recovery schema differs from its fixed native DDL.");
  } finally { expected.close(); }
  const workspaceId = JSON.parse(readRegular(join(root, ".pkm-next-workspace")).toString()).id;
  for (const row of db.prepare("SELECT admission_sha256,payload FROM legacy_knowledge_recovery_admissions").all()) {
    const admission = parseAdmission(String(row.payload), String(row.admission_sha256));
    if (admission.workspaceId !== workspaceId) fail("ACCESS_DENIED", "Recovery evidence belongs to another workspace.");
  }
  for (const row of db.prepare("SELECT payload,payload_sha256 FROM legacy_knowledge_recovery_receipts").all()) {
    if (sha(String(row.payload)) !== row.payload_sha256) fail("INVALID_DOCUMENT", "Recovery receipt changed.");
    const receipt = JSON.parse(String(row.payload)) as { admissionSha256: string; report: unknown; result: unknown };
    const source = db.prepare("SELECT payload FROM legacy_knowledge_recovery_admissions WHERE admission_sha256=?").get(receipt.admissionSha256);
    if (!source)
      fail("INVALID_DOCUMENT", "Recovery receipt lacks its native admission.");
    const report = reportSchema.parse(receipt.report), admission = parseAdmission(String(source!.payload), receipt.admissionSha256);
    const result = z.strictObject({ ok: z.literal(true), report: z.string(), restored: z.number().int().nonnegative(),
      identical: z.number().int().nonnegative(), preserved_existing: z.number().int().nonnegative() }).parse(receipt.result);
    const paths = [...report.restored, ...report.identical, ...report.preserved_existing];
    if (!report.completed_at || report.knowledge_root !== admission.workspaceRoot || report.plan_sha256 !== admission.planSha256
      || result.restored !== report.restored.length || result.identical !== report.identical.length
      || result.preserved_existing !== report.preserved_existing.length || new Set(paths).size !== paths.length
      || paths.length !== admission.rows.length || paths.some(path => !admission.rows.some(row => row.path === path))
      || dirname(result.report) !== admission.auditRoot || !/^result-\d{8}T\d{12}\.json$/.test(basename(result.report)))
      fail("INVALID_DOCUMENT", "Recovery receipt result or original plan bindings changed.");
  }
  const pending = db.prepare("SELECT payload,payload_sha256 FROM legacy_knowledge_recovery_intent WHERE singleton=1").get();
  if (pending) {
    parseIntent(db, String(pending.payload), String(pending.payload_sha256));
    if (!allowPending) fail("RECOVERY_REQUIRED", "Original recovery is incomplete; explicit native owner reconciliation is required.", true);
  }
}
export interface LegacyKnowledgeRecoveryAdmissionRequest {
  evidenceRoot: string;
  auditRoot: string;
  expectedPlanSha256: string;
  authorityId: string;
  authorize(request: Readonly<{ actorId: string; workspaceId: string; evidenceRoot: string; auditRoot: string;
    planSha256: string; authorityId: string }>): boolean;
}
export async function admitLegacyKnowledgeRecovery(storage: Storage, actor: Actor, request: LegacyKnowledgeRecoveryAdmissionRequest) {
  actor = Object.freeze({ ...actor });
  request = Object.freeze({ ...request });
  if (!actor.id || !actor.canWrite || actor.boardWorker || !request.authorityId || !digest.safeParse(request.expectedPlanSha256).success)
    fail("ACCESS_DENIED", "Explicit native recovery authority is required.");
  const workspaceId = await storage.workspaceId(), root = storage.workspaceRoot();
  const grant = Object.freeze({ actorId: actor.id, workspaceId, evidenceRoot: request.evidenceRoot,
    auditRoot: request.auditRoot, planSha256: request.expectedPlanSha256, authorityId: request.authorityId });
  if (request.authorize(grant) !== true) fail("ACCESS_DENIED", "Native host denied recovery evidence and external audit roots.");
  return storage.withWorkspaceExclusive(() => {
    storage.assertWorkspaceLease();
    const evidenceRoot = canonicalRoot(request.evidenceRoot);
    if (request.auditRoot !== evidenceRoot || evidenceRoot === root || evidenceRoot.startsWith(root + sep)
      || root.startsWith(evidenceRoot + sep)) fail("ACCESS_DENIED", "Recovery evidence and audit must share an explicitly approved external directory.");
    const planBytes = readRegular(join(evidenceRoot, "plan.json"));
    if (planBytes.length > 2_097_152 || sha(planBytes) !== request.expectedPlanSha256)
      fail("CONFLICT", "Recovery plan differs from the native reviewed digest.");
    const plan = z.object({ schema: z.literal("pkm.knowledge-recovery/v1"), knowledgeRoot: z.literal(root),
      files: z.array(z.object({ path: z.string(), sha256: digest, mode: z.enum(["100644", "100755"]) })).max(1000) })
      .parse(JSON.parse(planBytes.toString("utf8")));
    canonicalRoot(join(evidenceRoot, "blobs"));
    const rows = plan.files.map(row => ({ ...row, bytes: readRegular(join(evidenceRoot, "blobs", row.sha256)).toString("base64") }));
    if (rows.reduce((total, row) => total + Buffer.from(row.bytes, "base64").length, 0) > 16_777_216)
      fail("NOT_AVAILABLE", "Recovery payload exceeds the bounded native admission size.");
    if (new Set(rows.map(row => row.path)).size !== rows.length) fail("INVALID_ARGUMENT", "Duplicate recovery destination.");
    const admission: Admission = { schema: "pkm.legacy-knowledge-recovery-admission/v1", workspaceId,
      workspaceRoot: root, actorId: actor.id, authorityId: request.authorityId, evidenceRoot, auditRoot: request.auditRoot,
      rootPin: pin(lstatSync(evidenceRoot)), planSha256: request.expectedPlanSha256, planBytes: planBytes.toString("base64"), rows };
    validateFutureDocuments(root, snapshot(root, rows));
    validateSource(admission);
    const payload = encode(admission), id = sha(payload), db = storage.connectNative();
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (hasTables(db)) verifyLegacyKnowledgeRecovery(db, root);
        const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
        if (![23, 24, 25, 26, 27, 28].includes(version)) fail("INVALID_DOCUMENT", "Recovery admission requires a supported native workspace schema.");
        db.exec(ddl);
        db.exec(`PRAGMA user_version=${Math.max(version, 24)}`);
        db.prepare("INSERT OR IGNORE INTO legacy_knowledge_recovery_admissions VALUES(?,?)").run(id, payload);
        verifyLegacyKnowledgeRecovery(db, root);
        storage.assertWorkspaceLease();
        db.exec("COMMIT");
      } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    } finally { db.close(); }
    return { admissionSha256: id, planSha256: admission.planSha256 };
  });
}
function selectAdmission(db: DatabaseSync, root: string, actor: Actor, evidence: string) {
  if (!actor.id || actor.boardWorker || !hasTables(db)) fail("ACCESS_DENIED", "No native host-approved recovery evidence exists for this actor.");
  verifyLegacyKnowledgeRecovery(db, root);
  const matches = db.prepare("SELECT admission_sha256,payload FROM legacy_knowledge_recovery_admissions ORDER BY rowid DESC").all()
    .map(row => ({ id: String(row.admission_sha256), admission: parseAdmission(String(row.payload), String(row.admission_sha256)) }))
    .filter(row => row.admission.evidenceRoot === evidence && row.admission.actorId === actor.id);
  const found = matches[0];
  if (!found || found.admission.workspaceRoot !== root) fail("ACCESS_DENIED", "Recovery root was not approved for this actor and exact workspace path.");
  validateSource(found.admission);
  return found;
}
export const legacyKnowledgeRecoveryRequest = z.discriminatedUnion("tool", [
  z.strictObject({ tool: z.literal("knowledge_recovery_preview"), arguments: z.strictObject({ evidence_directory: z.string() }) }),
  z.strictObject({ tool: z.literal("knowledge_recovery_apply"), arguments: z.strictObject({
    evidence_directory: z.string(), approved_plan_sha256: z.string(),
  }) }),
]);
function assertNoPending(db: DatabaseSync, ownIntent = false) {
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    const name = String(row.name);
    if (ownIntent && name === "legacy_knowledge_recovery_intent") continue;
    if ((/^(?:pending_|legacy_.*_intent$)|_intents$|_pending$|journal/i.test(name))
      && db.prepare(`SELECT 1 FROM "${name.replaceAll('"', '""')}" LIMIT 1`).get())
      fail("RECOVERY_REQUIRED", "Another native workspace intent is unresolved.", true);
  }
  for (const [table, condition] of [
    ["legacy_memory_erasure_operations", "status<>'committed'"],
    ["coding_worker_effects", "state='intent'"],
    ["coding_worker_records", "kind IN ('worker','check-intent') AND json_extract(record,'$.status')='intent'"],
  ]) if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table!)
    && db.prepare(`SELECT 1 FROM ${table} WHERE ${condition} LIMIT 1`).get())
    fail("RECOVERY_REQUIRED", "Another native authority effect is unresolved.", true);
}
interface RecoveryCheckpoints { checkpoint(name: string): void }
function saveIntent(db: DatabaseSync, intent: Intent) {
  const payload = encode(intent);
  db.prepare("INSERT OR REPLACE INTO legacy_knowledge_recovery_intent VALUES(1,?,?)").run(payload, sha(payload));
}
function writeAudit(intent: Intent, create: boolean) {
  canonicalRoot(intent.admission.auditRoot);
  if (pin(lstatSync(intent.admission.auditRoot)) !== intent.admission.rootPin)
    fail("CONFLICT", "Native approved external audit directory changed.", true);
  const fd = openSync(intent.reportPath, constants.O_WRONLY | constants.O_NOFOLLOW | (create ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || !create && intent.auditPin !== pin(stat))
      fail("CONFLICT", "Recovery audit must remain its original exclusive native-owned file.", true);
    intent.auditPin = pin(stat);
    writeFileSync(fd, JSON.stringify(intent.report, null, 2));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  flushDirectory(intent.admission.auditRoot);
}
function runIntent(storage: Storage, db: DatabaseSync, intent: Intent, checkpoints?: RecoveryCheckpoints) {
  const root = storage.workspaceRoot();
  for (; intent.cursor < intent.rows.length; intent.cursor++) {
    storage.assertWorkspaceLease();
    const { row, status } = intent.rows[intent.cursor]!, bytes = checkedRow(row);
    if (status !== "restore") {
      intent.report[status === "identical" ? "identical" : "preserved_existing"].push(row.path);
      saveIntent(db, { ...intent, cursor: intent.cursor + 1 });
      continue;
    }
    const target = destination(root, row.path, true);
    if (lstatSync(target, { throwIfNoEntry: false })) {
      readRegular(target);
      intent.report.preserved_existing.push(row.path);
    } else {
      const stage = join(dirname(target), `.pkm-write-${randomUUID()}`);
      const fd = openSync(stage, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        writeFileSync(fd, bytes); fchmodSync(fd, row.mode === "100755" ? 0o755 : 0o644); fsyncSync(fd);
        intent.staged = { path: stage, target, pin: pin(fstatSync(fd)) };
      } finally { closeSync(fd); }
      flushDirectory(dirname(stage));
      saveIntent(db, intent);
      checkpoints?.checkpoint("after-stage");
      const staged = lstatSync(stage);
      if (!staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 1 || pin(staged) !== intent.staged!.pin
        || sha(readRegular(stage)) !== row.sha256)
        fail("CONFLICT", "Recovery stage changed before missing-only publication.", true);
      if (destination(root, row.path) !== target) fail("CONFLICT", "Recovery destination changed.", true);
      try {
        linkSync(stage, target);
        flushDirectory(dirname(target));
        checkpoints?.checkpoint("after-link");
        intent.report.restored.push(row.path);
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
        readRegular(target);
        intent.report.preserved_existing.push(row.path);
      }
      unlinkSync(stage); flushDirectory(dirname(stage)); intent.staged = null;
      checkpoints?.checkpoint("after-unlink");
    }
    saveIntent(db, { ...intent, cursor: intent.cursor + 1 });
    writeAudit(intent, false);
  }
  storage.assertWorkspaceLease();
  scanMarkdown(root);
  intent.report.completed_at = new Date().toISOString();
  writeAudit(intent, false);
  const result = { ok: true, report: intent.reportPath, restored: intent.report.restored.length,
    identical: intent.report.identical.length, preserved_existing: intent.report.preserved_existing.length };
  const payload = encode({ admissionSha256: intent.admissionSha256, report: intent.report, result });
  checkpoints?.checkpoint("before-commit");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO legacy_knowledge_recovery_receipts VALUES(?,?,?)").run(intent.operationId, payload, sha(payload));
    db.prepare("DELETE FROM legacy_knowledge_recovery_intent WHERE singleton=1").run();
    db.exec("COMMIT");
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  return result;
}
export async function legacyKnowledgeRecovery(storage: Storage, actor: Actor, input: z.infer<typeof legacyKnowledgeRecoveryRequest>,
  checkpoints?: RecoveryCheckpoints) {
  actor = Object.freeze({ ...actor });
  const request = legacyKnowledgeRecoveryRequest.parse(input);
  if (request.tool === "knowledge_recovery_apply" && !actor.canWrite) fail("ACCESS_DENIED", "Recovery application requires native write authority.");
  return storage.withWorkspaceExclusive(() => {
    storage.assertWorkspaceLease();
    const root = storage.workspaceRoot(), db = storage.connectNative();
    try {
      const { id, admission } = selectAdmission(db, root, actor, request.arguments.evidence_directory);
      const rows = snapshot(root, admission.rows);
      if (request.tool === "knowledge_recovery_preview") return {
        schema: "pkm.knowledge-recovery-preview/v1", knowledge_root: root, plan_sha256: admission.planSha256,
        counts: Object.fromEntries(["restore", "identical", "preserve-existing"].map(status => [status, rows.filter(row => row.status === status).length])),
        files: rows.map(row => ({ path: row.row.path, status: row.status })),
      };
      if (request.arguments.approved_plan_sha256 !== admission.planSha256) fail("CONFLICT", "Recovery plan changed after approval.");
      assertNoPending(db);
      validateFutureDocuments(root, rows);
      const started = new Date(), reportPath = join(admission.auditRoot, `result-${started.toISOString().replace(/[-:.]/g, "").replace("Z", "000")}.json`);
      const intent: Intent = { operationId: randomUUID(), admissionSha256: id, admission, rows, cursor: 0, staged: null,
        reportPath, auditPin: null, report: { schema: "pkm.knowledge-recovery-result/v1", knowledge_root: root,
          plan_sha256: admission.planSha256, started_at: started.toISOString(), restored: [], identical: [], preserved_existing: [] } };
      saveIntent(db, intent);
      checkpoints?.checkpoint("after-intent");
      writeAudit(intent, true);
      saveIntent(db, intent);
      checkpoints?.checkpoint("after-audit");
      return runIntent(storage, db, intent, checkpoints);
    } finally { db.close(); }
  });
}

export async function reconcileLegacyKnowledgeRecovery(storage: Storage, actor: Actor, request: {
  operationId: string; authorityId: string;
  authorize(binding: Readonly<{ actorId: string; workspaceId: string; operationId: string; intentSha256: string;
    evidenceRoot: string; auditRoot: string; reportPath: string; authorityId: string }>): boolean;
}) {
  actor = Object.freeze({ ...actor });
  request = Object.freeze({ ...request });
  if (!actor.id || !actor.canWrite || actor.boardWorker || !request.authorityId)
    fail("ACCESS_DENIED", "Explicit native recovery owner is required.");
  return storage.withWorkspaceExclusive(() => {
    storage.assertWorkspaceLease();
    const root = storage.workspaceRoot(), db = storage.connectNative();
    try {
      verifyLegacyKnowledgeRecovery(db, root, true);
      const row = db.prepare("SELECT payload,payload_sha256 FROM legacy_knowledge_recovery_intent WHERE singleton=1").get();
      if (!row) fail("NOT_FOUND", "No pending original recovery exists.");
      const intent = parseIntent(db, String(row!.payload), String(row!.payload_sha256));
      const binding = Object.freeze({ actorId: actor.id, workspaceId: intent.admission.workspaceId,
        operationId: intent.operationId, intentSha256: String(row!.payload_sha256), evidenceRoot: intent.admission.evidenceRoot,
        auditRoot: intent.admission.auditRoot, reportPath: intent.reportPath, authorityId: request.authorityId });
      if (intent.operationId !== request.operationId || intent.admission.actorId !== actor.id
        || intent.admission.workspaceRoot !== root || request.authorize(binding) !== true)
        fail("ACCESS_DENIED", "Native owner denied exact recovery intent reconciliation.");
      assertNoPending(db, true);
      validateSource(intent.admission);
      const pending = db.prepare("SELECT payload FROM legacy_knowledge_recovery_intent WHERE singleton=1").get();
      if (String(pending?.payload) !== row!.payload) fail("CONFLICT", "Recovery intent changed during native approval.", true);
      if (!intent.auditPin) {
        if (lstatSync(intent.reportPath, { throwIfNoEntry: false }))
          fail("RECOVERY_REQUIRED", "Unattributed external audit file requires manual native owner inspection; it was not overwritten.", true);
        writeAudit(intent, true);
        saveIntent(db, intent);
      } else {
        const stat = lstatSync(intent.reportPath);
        if (pin(stat) !== intent.auditPin || !stat.isFile() || stat.nlink !== 1)
          fail("CONFLICT", "Native recovery audit file changed.", true);
      }
      if (intent.staged) {
        const current = intent.rows[intent.cursor];
        if (!current || current.status !== "restore") fail("INVALID_DOCUMENT", "Recovery staging cursor changed.");
        const target = destination(root, current!.row.path), stage = intent.staged;
        if (stage.target !== target || dirname(stage.path) !== dirname(target) || !/^\.pkm-write-[a-f0-9-]{36}$/.test(basename(stage.path)))
          fail("INVALID_DOCUMENT", "Recovery staging path escaped its exact destination.");
        const staged = lstatSync(stage.path, { throwIfNoEntry: false }), published = lstatSync(target, { throwIfNoEntry: false });
        if (staged && (!staged.isFile() || staged.isSymbolicLink() || pin(staged) !== stage.pin
          || sha(readFileSync(stage.path)) !== current!.row.sha256 || staged.nlink > 2))
          fail("CONFLICT", "Native recovery stage changed.", true);
        if (published && pin(published) === stage.pin) {
          if (!published.isFile() || published.isSymbolicLink() || sha(readFileSync(target)) !== current!.row.sha256
            || published.nlink !== (staged ? 2 : 1)) fail("CONFLICT", "Native recovery publication changed.", true);
          if (staged) unlinkSync(stage.path);
          intent.report.restored.push(current!.row.path);
        } else if (published && staged) {
          readRegular(target); unlinkSync(stage.path);
          intent.report.preserved_existing.push(current!.row.path);
        } else if (staged) {
          linkSync(stage.path, target); flushDirectory(dirname(target)); unlinkSync(stage.path);
          intent.report.restored.push(current!.row.path);
        } else fail("RECOVERY_REQUIRED", "Native recovery staging evidence is missing; no write was replayed.", true);
        flushDirectory(dirname(target)); intent.staged = null; intent.cursor++;
        saveIntent(db, intent); writeAudit(intent, false);
      }
      return runIntent(storage, db, intent);
    } finally { db.close(); }
  });
}
