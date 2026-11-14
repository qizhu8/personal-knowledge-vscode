import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Actor } from "./contracts.js";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { legacyClassificationPreview, readOriginalClassificationPreview, type LegacyClassificationPreview } from "./legacy-asset-provider.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const relativePath = z.string().min(1).max(2048).refine(v => !v.startsWith("/") && v.split("/").every(p => !!p && p !== "." && p !== ".." && !/[\\\x00-\x1f:]/.test(p)));
const entrySchema = z.strictObject({ path: relativePath, kind: z.enum(["file", "directory"]), sha256: digest.nullable(), mode: z.number().int().min(0).max(0o777) });
const pinSchema = z.strictObject({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) });
const effectSchema = z.strictObject({ id: digest, asset: relativePath, target: relativePath, before: z.string().nullable(), after: z.string().nullable(), mode: z.number().int().min(0).max(0o777) });
/** This is deliberately not the original partial-success classification API.
 * It rejects the entire selection on any unsupported/stale entry and returns
 * no original journalId or skipped list. Never register it under a legacy ID. */
export const LEGACY_CLASSIFICATION_NATIVE_CONTRACT = "pkm.legacy-classification.native-strict/v1" as const;
export const legacyClassificationNativeRequest = z.discriminatedUnion("action", [
  z.strictObject({ contract: z.literal(LEGACY_CLASSIFICATION_NATIVE_CONTRACT), action: z.literal("apply"), operationId: uuid, previewId: digest, layoutSha256: digest, proposalIds: z.array(digest).min(1).max(1000) }),
  z.strictObject({ contract: z.literal(LEGACY_CLASSIFICATION_NATIVE_CONTRACT), action: z.literal("rollback"), operationId: uuid, applyOperationId: uuid, layoutSha256: digest }),
]);
export const legacyClassificationNativeResult = z.strictObject({ operationId: uuid, action: z.enum(["apply", "rollback"]), applied: z.array(digest) });
const actorSchema = z.strictObject({ id: z.string().min(1).max(256), canWrite: z.literal(true), collaborationKind: z.enum(["human", "agent", "browser"]).optional() });
const intentSchema = z.strictObject({
  request: legacyClassificationNativeRequest, actor: actorSchema, workspaceId: z.string().min(1).max(256), sourceRootId: digest,
  rootPin: pinSchema, before: z.array(entrySchema).max(10000), effects: z.array(effectSchema).min(1).max(1000),
  proposals: z.array(legacyClassificationPreview.shape.proposals.element).max(1000), result: legacyClassificationNativeResult,
});
export type LegacyClassificationNativeIntent = z.infer<typeof intentSchema>;
type Entry = z.infer<typeof entrySchema>;
type Effect = z.infer<typeof effectSchema>;
type Request = z.infer<typeof legacyClassificationNativeRequest>;
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const fail = (code: "ACCESS_DENIED" | "CONFLICT" | "INVALID_ARGUMENT" | "NOT_AVAILABLE", message: string): never => { throw new CoreError(code, message); };
const encode = (v: unknown) => JSON.stringify(v);
const target = (asset: string) => /\.md$/i.test(asset) ? asset : `${asset.slice(0, asset.lastIndexOf("/") + 1)}.${asset.slice(asset.lastIndexOf("/") + 1)}.pkm-classification`;

export const LEGACY_CLASSIFICATION_NATIVE_DDL = `
CREATE TABLE IF NOT EXISTS legacy_classification_native_intent (singleton INTEGER PRIMARY KEY CHECK(singleton=1), operation_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS legacy_classification_native_receipt (operation_id TEXT PRIMARY KEY, payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS legacy_classification_native_receipt_no_update BEFORE UPDATE ON legacy_classification_native_receipt BEGIN SELECT RAISE(ABORT, 'classification receipt immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_classification_native_receipt_no_delete BEFORE DELETE ON legacy_classification_native_receipt BEGIN SELECT RAISE(ABORT, 'classification receipt immutable'); END;`;
export const LEGACY_CLASSIFICATION_ADOPTION_DDL = `
CREATE TABLE IF NOT EXISTS legacy_classification_native_adoption (adoption_id TEXT PRIMARY KEY, payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS legacy_classification_native_adoption_no_update BEFORE UPDATE ON legacy_classification_native_adoption BEGIN SELECT RAISE(ABORT, 'classification adoption immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_classification_native_adoption_no_delete BEFORE DELETE ON legacy_classification_native_adoption BEGIN SELECT RAISE(ABORT, 'classification adoption immutable'); END;`;

export const nativeClassificationAdoptionSchema = z.strictObject({
  schema: z.literal("pkm.legacy-classification-root-adoption/v1"),
  adoptionId: uuid,
  operationId: uuid,
  workspaceId: z.string().min(1).max(256),
  sourceRootId: digest,
  sourceRelative: relativePath.refine(value => value.startsWith("packages/")),
  sourceManifestSha256: digest,
  sourceBackupRoot: z.string().min(1).max(4096).refine(value => isAbsolute(value) && resolve(value) === value),
  sourceBackupRootPin: pinSchema,
  sourceRoot: z.string().min(1).max(4096).refine(value => isAbsolute(value) && resolve(value) === value),
  sourceRootPin: pinSchema,
  destination: z.string().min(1).max(4096).refine(value => isAbsolute(value) && resolve(value) === value),
  destinationParent: z.strictObject({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }),
  destinationWorkspacePin: pinSchema,
  destinationRootPin: pinSchema,
  stageParent: z.strictObject({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }),
  genesisSha256: digest,
  historySha256: digest,
  receiptCount: z.number().int().min(1).max(10000),
  layoutSha256: digest,
  layout: z.array(entrySchema).max(10000),
  actorId: z.string().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)),
  authorityId: z.string().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)),
  policyIdentity: z.string().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)),
  sourceEpoch: z.number().int().min(0),
  trustedEpoch: z.number().int().min(0),
  expiresAt: z.number().int().positive(),
});
const adoptionSchema = nativeClassificationAdoptionSchema;
export type LegacyClassificationAdoption = z.infer<typeof adoptionSchema>;

export function verifyNativeClassificationAdoptionSchema(db: DatabaseSync) {
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(LEGACY_CLASSIFICATION_ADOPTION_DDL);
    const query = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name IN ('legacy_classification_native_adoption','legacy_classification_native_adoption_no_update','legacy_classification_native_adoption_no_delete') ORDER BY name";
    if (encode(db.prepare(query).all()) !== encode(expected.prepare(query).all())) return fail("CONFLICT", "Classification adoption schema differs from the exact DDL.");
  } finally { expected.close(); }
}

export function inspectNativeClassificationAdoptions(db: DatabaseSync): LegacyClassificationAdoption[] {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_classification_native_adoption'").get();
  if (!table) return [];
  verifyNativeClassificationAdoptionSchema(db);
  return db.prepare("SELECT adoption_id,payload,payload_sha256 FROM legacy_classification_native_adoption ORDER BY rowid").all().map(row => {
    if (typeof row.payload !== "string" || sha(row.payload) !== row.payload_sha256) return fail("CONFLICT", "Corrupt classification adoption record.");
    let value: unknown;
    try { value = JSON.parse(row.payload); } catch { return fail("CONFLICT", "Corrupt classification adoption record."); }
    const parsed = adoptionSchema.safeParse(value);
    if (!parsed.success || parsed.data.adoptionId !== row.adoption_id || encode(parsed.data) !== row.payload)
      return fail("CONFLICT", "Invalid classification adoption record.");
    return parsed.data;
  });
}

export function verifyNativeClassificationSchema(db: DatabaseSync) {
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(LEGACY_CLASSIFICATION_NATIVE_DDL);
    const query = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name IN ('legacy_classification_native_intent','legacy_classification_native_receipt','legacy_classification_native_receipt_no_update','legacy_classification_native_receipt_no_delete') ORDER BY name";
    if (encode(db.prepare(query).all()) !== encode(expected.prepare(query).all())) return fail("CONFLICT", "Classification schema differs from the exact DDL.");
  } finally { expected.close(); }
}
/** Callbacks are native-only, never supplied by a request. The owner must exclude
 * all external filesystem writers for the complete operation and recovery.
 * The global receipt callbacks run synchronously inside SQLite transactions. */
export interface LegacyClassificationNativeHost {
  assertOwnedDisposableFixture(): void;
  authorize(actor: Readonly<Actor>, workspaceId: string, rootId: string, action: Request["action"]): boolean;
  authorizeRoot(workspaceId: string, rootId: string, root: string): boolean;
  approveRecovery(actor: Readonly<Actor>, intent: LegacyClassificationNativeIntent): boolean;
  assertAdoptionAnchor?(adoption: Readonly<LegacyClassificationAdoption>): void;
  previewOriginal(root: string): LegacyClassificationPreview;
  assertNoOtherPending(db: DatabaseSync): void;
  globalReceipt(db: DatabaseSync, id: string): { fingerprint: string; result: unknown } | null;
  writeGlobalReceipt(db: DatabaseSync, id: string, fingerprint: string, result: unknown): void;
  afterEffect?(index: number): void;
  afterStage?(index: number): void;
}
export interface LegacyClassificationNativeScope { workspaceId: string; sourceRootId: string; root: string }

function noSql(db: DatabaseSync) { if (db.isTransaction) fail("CONFLICT", "Filesystem access inside a transaction is forbidden."); }
function owner(host: Pick<LegacyClassificationNativeHost, "assertOwnedDisposableFixture"> | undefined) {
  if (!host || typeof host.assertOwnedDisposableFixture !== "function") return fail("NOT_AVAILABLE", "No trusted disposable filesystem owner.");
  host.assertOwnedDisposableFixture();
}
function rootPin(root: string) {
  if (process.platform === "win32" || !constants.O_NOFOLLOW || !isAbsolute(root) || resolve(root) !== root) return fail("NOT_AVAILABLE", "Normalized Unix no-follow root required.");
  const parsed = parse(root); let current = parsed.root;
  for (const part of root.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = join(current, part); const s = lstatSync(current);
    if (!s.isDirectory() || s.isSymbolicLink()) return fail("CONFLICT", "Unsafe root ancestry.");
  }
  const s = lstatSync(root, { bigint: true }); return { dev: String(s.dev), ino: String(s.ino) };
}
export function readNativeClassificationFile(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s = fstatSync(fd); if (!s.isFile() || s.nlink !== 1 || s.size > 2_097_152) return fail("CONFLICT", "Unsupported file layout."); const data = readFileSync(fd); if (data.length > 2_097_152) return fail("CONFLICT", "File grew beyond limit."); return data; }
  finally { closeSync(fd); }
}
const readFile = readNativeClassificationFile;
export function scanNativeClassification(db: DatabaseSync, host: Pick<LegacyClassificationNativeHost, "assertOwnedDisposableFixture"> | undefined, root: string) {
  noSql(db); owner(host); const pin = rootPin(root); const entries: Entry[] = []; let total = 0;
  function walk(dir: string, prefix: string, depth: number) {
    if (depth > 32) return fail("CONFLICT", "Layout depth exceeds limit.");
    for (const name of readdirSync(dir).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (!relativePath.safeParse(rel).success || entries.length >= 10000) return fail("CONFLICT", "Unsupported layout.");
      const file = join(dir, name), stat = lstatSync(file);
      if (stat.isSymbolicLink()) return fail("CONFLICT", "Symbolic links are not supported.");
      if (stat.isDirectory()) { entries.push({ path: rel, kind: "directory", sha256: null, mode: stat.mode & 0o777 }); walk(file, rel, depth + 1); }
      else if (stat.isFile()) { const content = readFile(file); total += content.length; if (total > 33_554_432) return fail("CONFLICT", "Layout exceeds byte limit."); entries.push({ path: rel, kind: "file", sha256: sha(content), mode: stat.mode & 0o777 }); }
      else return fail("CONFLICT", "Special files are not supported.");
    }
  }
  walk(root, "", 0); entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (encode(rootPin(root)) !== encode(pin)) return fail("CONFLICT", "Root changed during scan.");
  return { pin, entries, layoutSha256: sha(encode(entries)) };
}
export function nativeClassificationMetadata(content: Buffer, classification: Record<string, string>) {
  const text = content.toString("utf8"); if (!Buffer.from(text).equals(content)) return fail("CONFLICT", "Markdown must be UTF-8.");
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "", source = text.slice(bom.length), eol = source.includes("\r\n") ? "\r\n" : "\n";
  const line = `pkmClassification: ${JSON.stringify(classification)}`, match = /^---\r?\n([\s\S]*?)(\r?\n)---(?=\r?\n|$)/.exec(source);
  if (!match) { if (source.startsWith("---")) return fail("CONFLICT", "Unsupported frontmatter."); return Buffer.from(`${bom}---${eol}${line}${eol}---${eol}${source}`); }
  let header = match[1]!;
  if (/^pkmClassification:/m.test(header)) {
    const existing = /^pkmClassification: (\{[^\r\n]*\})$/m.exec(header); if (!existing) return fail("CONFLICT", "Unsupported metadata.");
    JSON.parse(existing[1]!); header = header.replace(/^pkmClassification:.*$/m, line);
  } else header += `${eol}${line}`;
  return Buffer.from(`${bom}---${eol}${header}${match[2]}---${source.slice(match[0].length)}`);
}
const metadata = nativeClassificationMetadata;
function decode(value: string | null) {
  if (value === null) return null;
  const b = Buffer.from(value, "base64"); if (b.toString("base64") !== value || b.length > 2_097_152) return fail("CONFLICT", "Invalid backup encoding."); return b;
}
function states(intent: LegacyClassificationNativeIntent) {
  const all: Entry[][] = [intent.before.map(e => ({ ...e }))];
  for (const effect of intent.effects) {
    const previous = all.at(-1)!, found = previous.find(e => e.path === effect.target), before = decode(effect.before), after = decode(effect.after);
    if ((found?.kind === "directory") || (found?.sha256 ?? null) !== (before ? sha(before) : null) || (found && found.mode !== effect.mode) || (!found && effect.mode !== 0o600))
      return fail("CONFLICT", "Invalid before image.");
    const next = previous.filter(e => e.path !== effect.target);
    if (after) next.push({ path: effect.target, kind: "file", sha256: sha(after), mode: effect.mode });
    next.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); all.push(next);
  }
  return all;
}
/** Validate stored or backup-restored intents before trusting any effect. */
export function validateNativeClassificationIntent(value: unknown): LegacyClassificationNativeIntent {
  const parsed = intentSchema.safeParse(value); if (!parsed.success) return fail("CONFLICT", "Invalid classification intent.");
  const i = parsed.data;
  if (i.request.operationId !== i.result.operationId || i.request.action !== i.result.action
    || i.effects.some(e => !/^(skills|notes|scripts|components|actions|recipes|papers)\//.test(e.asset) || e.target !== target(e.asset))
    || new Set(i.effects.map(e => e.target)).size !== i.effects.length
    || new Set(i.before.map(e => e.path)).size !== i.before.length
    || i.before.some((e, n) => (e.kind === "directory") !== (e.sha256 === null) || (n > 0 && i.before[n - 1]!.path >= e.path))
    || i.effects.some(e => !i.before.some(entry => entry.path === e.asset && entry.kind === "file")
      || !i.before.some(entry => entry.path === e.target.slice(0, e.target.lastIndexOf("/")) && entry.kind === "directory"))
    || sha(encode(i.before)) !== i.request.layoutSha256
    || (i.request.action === "apply" && encode(i.request.proposalIds) !== encode(i.effects.map(e => e.id)))
    || encode(i.effects.map(e => e.id)) !== encode(i.result.applied)) return fail("CONFLICT", "Invalid classification intent binding.");
  states(i);
  if (i.request.action === "rollback") {
    if (i.proposals.length) return fail("CONFLICT", "Rollback cannot contain independent proposals.");
    return i;
  }
  if (i.proposals.length !== i.effects.length) return fail("CONFLICT", "Missing original proposal evidence.");
  for (let n = 0; n < i.effects.length; n++) {
    const e = i.effects[n]!, p = i.proposals[n]!;
    const asset = i.before.find(entry => entry.path === p.asset);
    const prior = decode(e.before), after = decode(e.after);
    const unsigned = { id: "", type: p.type, asset: p.asset, locator: p.locator, hash: p.hash, target: p.target,
      targetHash: p.targetHash, classification: p.classification, evidence: p.evidence };
    if (p.type !== "classification" || p.relatedAsset !== undefined || p.suggestion !== undefined
      || p.evidence.some(item => item.confidence < 0 || item.confidence > 1)
      || sha(encode(unsigned)) !== p.id || e.id !== p.id || e.asset !== p.asset || e.target !== p.target
      || asset?.kind !== "file" || asset.sha256 !== p.hash || (prior ? sha(prior) : null) !== p.targetHash || !after)
      return fail("CONFLICT", "Classification proposal evidence does not bind effect.");
    let derived: Buffer;
    try {
      if (p.target === p.asset) {
        if (!prior || sha(prior) !== p.hash) return fail("CONFLICT", "Markdown source image mismatch.");
        derived = metadata(prior, p.classification);
      } else {
        if (prior) {
          const existing = JSON.parse(prior.toString("utf8"));
          if (existing?.schema !== "pkm.asset-classification/v1" || existing.asset !== p.locator)
            return fail("CONFLICT", "Unsupported preexisting classification sidecar.");
        }
        derived = Buffer.from(JSON.stringify({ schema: "pkm.asset-classification/v1", asset: p.locator, classification: p.classification }, null, 2) + "\n");
      }
    } catch { return fail("CONFLICT", "Invalid source classification metadata."); }
    if (!derived.equals(after)) return fail("CONFLICT", "Classification effect differs from original source semantics.");
  }
  return i;
}
function transaction<T>(db: DatabaseSync, fn: () => T): T {
  noSql(db); db.exec("BEGIN IMMEDIATE"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (e) { db.exec("ROLLBACK"); throw e; }
}
function fingerprint(i: LegacyClassificationNativeIntent) { return sha(encode({ actor: i.actor, workspaceId: i.workspaceId, sourceRootId: i.sourceRootId, request: i.request })); }
function row(db: DatabaseSync, table: "legacy_classification_native_intent" | "legacy_classification_native_receipt", id?: string) {
  const r = id ? db.prepare(`SELECT operation_id,payload,payload_sha256 FROM ${table} WHERE operation_id=?`).get(id) : db.prepare(`SELECT operation_id,payload,payload_sha256 FROM ${table}`).get();
  if (!r) return null;
  if (typeof r.payload !== "string" || sha(r.payload) !== r.payload_sha256) return fail("CONFLICT", "Corrupt classification journal.");
  let value: unknown; try { value = JSON.parse(r.payload); } catch { return fail("CONFLICT", "Corrupt classification journal."); }
  const i = validateNativeClassificationIntent(value); if (i.request.operationId !== r.operation_id) return fail("CONFLICT", "Journal ID mismatch."); return i;
}
export function inspectNativeClassificationPending(db: DatabaseSync) { return row(db, "legacy_classification_native_intent"); }
export function inspectNativeClassificationReceipt(db: DatabaseSync, operationId: string) { return row(db, "legacy_classification_native_receipt", operationId); }
function authorize(host: LegacyClassificationNativeHost | undefined, actor: Actor, scope: LegacyClassificationNativeScope, action: Request["action"]) {
  owner(host); const a = actorSchema.safeParse(actor);
  if (!a.success || !scope.workspaceId || !digest.safeParse(scope.sourceRootId).success) return fail("ACCESS_DENIED", "Writable actor and native scope required.");
  let allowed = false; try { allowed = host!.authorize(a.data, scope.workspaceId, scope.sourceRootId, action) === true && host!.authorizeRoot(scope.workspaceId, scope.sourceRootId, scope.root) === true; } catch { /* deny */ }
  if (!allowed) return fail("ACCESS_DENIED", "Native classification authority denied."); return a.data;
}
function sameRequest(i: LegacyClassificationNativeIntent, actor: Actor, scope: LegacyClassificationNativeScope, request: Request) {
  return encode(i.actor) === encode(actor) && i.workspaceId === scope.workspaceId && i.sourceRootId === scope.sourceRootId && encode(i.request) === encode(request);
}
function receipt(db: DatabaseSync, host: LegacyClassificationNativeHost, id: string) {
  const i = inspectNativeClassificationReceipt(db, id), global = host.globalReceipt(db, id);
  if (!i && !global) return null;
  if (!i || !global || global.fingerprint !== fingerprint(i) || encode(global.result) !== encode(i.result)) return fail("CONFLICT", "Global classification receipt mismatch.");
  return i;
}
/** Call during startup and backup validation under the host's workspace fence.
 * The global receipt namespace and database must be in the same backup. */
export function inspectNativeClassificationHistory(db: DatabaseSync, host: LegacyClassificationNativeHost) {
  return inspectClassificationHistory(db, host, true);
}
function inspectClassificationHistory(db: DatabaseSync, host: LegacyClassificationNativeHost, nativeAuthority: boolean) {
  verifyNativeClassificationSchema(db);
  const rows = db.prepare("SELECT operation_id FROM legacy_classification_native_receipt ORDER BY rowid").all();
  const receipts = rows.map(r => {
    if (typeof r.operation_id !== "string") return fail("CONFLICT", "Invalid classification receipt ID.");
    return receipt(db, host, r.operation_id) ?? fail("CONFLICT", "Missing classification receipt.");
  });
  const pending = inspectNativeClassificationPending(db);
  if (pending && (host.globalReceipt(db, pending.request.operationId) || receipts.some(i => i.request.operationId === pending.request.operationId)))
    return fail("CONFLICT", "Pending classification already has a receipt.");
  const adoptions = inspectNativeClassificationAdoptions(db);
  let lineageHead = receipts[0]?.rootPin ?? pending?.rootPin;
  const lineageRootPins = lineageHead ? [{ ...lineageHead }] : [];
  const lineagePins = new Set(lineageRootPins.map(encode));
  let lineageSourceRelative: string | undefined;
  for (const adoption of adoptions) {
    if (!host.assertAdoptionAnchor || !lineageHead
      || adoption.workspaceId !== (receipts[0] ?? pending)?.workspaceId
      || adoption.sourceRootId !== (receipts[0] ?? pending)?.sourceRootId
      || lineageSourceRelative !== undefined && adoption.sourceRelative !== lineageSourceRelative
      || encode(adoption.sourceRootPin) !== encode(lineageHead)
      || encode(adoption.destinationRootPin) === encode(adoption.sourceRootPin)
      || lineagePins.has(encode(adoption.destinationRootPin))
      || adoption.receiptCount > receipts.length
      || sha(encode(receipts.slice(0, adoption.receiptCount))) !== adoption.historySha256
      || !receipts[0] || sha(encode(receipts[0].before)) !== adoption.genesisSha256
      || encode(states(receipts[adoption.receiptCount - 1]!).at(-1)) !== encode(adoption.layout)
      || sha(encode(adoption.layout)) !== adoption.layoutSha256)
      return fail("CONFLICT", "Classification adoption lineage is cyclic or disconnected.");
    if (nativeAuthority) {
      noSql(db);
      try { host.assertAdoptionAnchor(adoption); } catch { return fail("ACCESS_DENIED", "Native classification adoption authority denied."); }
    }
    lineageSourceRelative = adoption.sourceRelative;
    lineageHead = adoption.destinationRootPin;
    lineageRootPins.push({ ...lineageHead });
    lineagePins.add(encode(lineageHead));
  }
  for (const i of pending ? [...receipts, pending] : receipts) {
    if (i.request.action !== "rollback") continue;
    const apply = receipts.find(r => r.request.operationId === (i.request.action === "rollback" ? i.request.applyOperationId : ""));
    if (!apply || apply.request.action !== "apply" || apply.actor.id !== i.actor.id || apply.workspaceId !== i.workspaceId
      || apply.sourceRootId !== i.sourceRootId
      || !lineagePins.has(encode(apply.rootPin)) || !lineagePins.has(encode(i.rootPin))
      || encode(states(apply).at(-1)) !== encode(i.before)
      || encode([...apply.effects].reverse().map(e => ({ ...e, before: e.after, after: e.before }))) !== encode(i.effects))
      return fail("CONFLICT", "Classification rollback history is disconnected.");
  }
  return { receipts, pending, adoptions, rootPins: lineageRootPins };
}
function authenticatedClassificationTransaction<T>(db: DatabaseSync, host: LegacyClassificationNativeHost,
  fn: (history: ReturnType<typeof inspectNativeClassificationHistory>) => T) {
  const authenticated = inspectNativeClassificationHistory(db, host);
  return transaction(db, () => {
    host.assertNoOtherPending(db);
    const history = inspectClassificationHistory(db, host, false);
    if (encode(history) !== encode(authenticated)) return fail("CONFLICT", "Classification authenticated history changed before SQL admission.");
    return fn(history);
  });
}

export function validateNativeClassificationAdoptionLineage(
  db: DatabaseSync,
  host: LegacyClassificationNativeHost,
  value: { workspaceId: string; sourceRootId: string; currentRootPin: { dev: string; ino: string } },
): { rootPins: Array<{ dev: string; ino: string }>; adoptions: LegacyClassificationAdoption[] } {
  const history = inspectNativeClassificationHistory(db, host);
  const adoptions = history.adoptions;
  const rootPins = history.rootPins.length ? history.rootPins : [{ ...value.currentRootPin }];
  const head = rootPins.at(-1);
  if (adoptions.some(adoption => adoption.workspaceId !== value.workspaceId || adoption.sourceRootId !== value.sourceRootId))
    return fail("CONFLICT", "Classification adoption scope differs.");
  if (head && encode(head) !== encode(value.currentRootPin))
    return fail("CONFLICT", "Classification adoption does not anchor the current root.");
  if (!history.receipts.length && history.pending && encode(history.pending.rootPin) !== encode(value.currentRootPin))
    return fail("CONFLICT", "Classification history root is not the current root.");
  return { rootPins, adoptions };
}

const scanSchema = z.strictObject({
  pin: pinSchema, entries: z.array(entrySchema).max(10000), layoutSha256: digest,
});
const historyScopeSchema = z.strictObject({ workspaceId: z.string().min(1).max(256), sourceRootId: digest });
/** Pure check over a previously authenticated, insertion-ordered journal and
 * an authoritative native scan. The caller must fence filesystem writers and
 * authenticate the journal, global receipts and any external epoch separately. */
export function validateNativeClassificationHistoryLayout(
  historyValue: { receipts: LegacyClassificationNativeIntent[]; pending: LegacyClassificationNativeIntent | null },
  scopeValue: { workspaceId: string; sourceRootId: string },
  scanValue: ReturnType<typeof scanNativeClassification>,
  rootPinsValue?: Array<{ dev: string; ino: string }>,
): { status: "untracked" | "committed" | "pending"; appliedEffects: number | null } {
  const scope = historyScopeSchema.safeParse(scopeValue), scan = scanSchema.safeParse(scanValue);
  if (!scope.success || !scan.success || !historyValue || !Array.isArray(historyValue.receipts)
    || !("pending" in historyValue)) return fail("CONFLICT", "Invalid classification history or scan.");
  const entries = scan.data.entries;
  const rootPins = rootPinsValue ?? [scan.data.pin];
  const allowedRootPins = new Set(rootPins.map(pin => encode(pin)));
  if (sha(encode(entries)) !== scan.data.layoutSha256
    || entries.some((e, n) => (e.kind === "directory") !== (e.sha256 === null) || (n > 0 && entries[n - 1]!.path >= e.path)))
    return fail("CONFLICT", "Invalid classification scan.");
  const receipts = historyValue.receipts.map(validateNativeClassificationIntent);
  const pending = historyValue.pending === null ? null : validateNativeClassificationIntent(historyValue.pending);
  const all = pending ? [...receipts, pending] : receipts;
  if (!all.length) return { status: "untracked", appliedEffects: null };
  const ids = new Set<string>(), previous = new Map<string, LegacyClassificationNativeIntent>();
  let head: Entry[] | undefined;
  for (const i of all) {
    if (i.workspaceId !== scope.data.workspaceId || i.sourceRootId !== scope.data.sourceRootId
      || !allowedRootPins.has(encode(i.rootPin)) || ids.has(i.request.operationId))
      return fail("CONFLICT", "Classification history scope, root or operation ID differs.");
    if (head && encode(i.before) !== encode(head)) return fail("CONFLICT", "Classification history layouts are disconnected.");
    if (i.request.action === "rollback") {
      const apply = previous.get(i.request.applyOperationId);
      if (!apply || apply.request.action !== "apply" || apply.actor.id !== i.actor.id
        || encode(states(apply).at(-1)) !== encode(i.before)
        || encode([...apply.effects].reverse().map(e => ({ ...e, before: e.after, after: e.before }))) !== encode(i.effects))
        return fail("CONFLICT", "Classification rollback history is disconnected.");
    }
    ids.add(i.request.operationId); previous.set(i.request.operationId, i);
    head = states(i).at(-1)!;
  }
  if (!pending) {
    if (encode(entries) !== encode(head) || encode(rootPins.at(-1)) !== encode(scan.data.pin))
      return fail("CONFLICT", "Current layout differs from classification history.");
    return { status: "committed", appliedEffects: null };
  }
  const variants = states(pending);
  const matches = variants.flatMap((state, index) => encode(state) === encode(entries) ? [index] : []);
  if (matches.length !== 1 || encode(rootPins.at(-1)) !== encode(scan.data.pin))
    return fail("CONFLICT", "Unknown or ambiguous classification pending layout.");
  return { status: "pending", appliedEffects: matches[0]! };
}
function syncDirectory(dir: string) { const fd = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
export function publishNativeClassificationEffect(root: string, effect: Effect, host: Pick<LegacyClassificationNativeHost, "afterStage">, index: number) {
  const destination = join(root, effect.target), before = decode(effect.before), after = decode(effect.after);
  let current: Buffer | null = null; try { current = readFile(destination); } catch (e: any) { if (e?.code !== "ENOENT") throw e; }
  if ((current ? sha(current) : null) !== (before ? sha(before) : null)) return fail("CONFLICT", "Target changed before publication.");
  if (!after) { unlinkSync(destination); syncDirectory(dirname(destination)); return; }
  const stage = join(dirname(destination), `.pkm-classification-${randomUUID()}.pending`);
  const fd = openSync(stage, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, effect.mode);
  try { fchmodSync(fd, effect.mode); writeFileSync(fd, after); fsyncSync(fd); } finally { closeSync(fd); }
  host.afterStage?.(index);
  renameSync(stage, destination); syncDirectory(dirname(destination));
}
const applyEffect = publishNativeClassificationEffect;
function resume(db: DatabaseSync, host: LegacyClassificationNativeHost, scope: LegacyClassificationNativeScope, intent: LegacyClassificationNativeIntent) {
  authenticatedClassificationTransaction(db, host, history => {
    if (encode(history.pending) !== encode(intent))
      return fail("CONFLICT", "Classification intent changed before publication.");
  });
  const variants = states(intent), scan = scanNativeClassification(db, host, scope.root);
  if (encode(scan.pin) !== encode(intent.rootPin)) return fail("CONFLICT", "Root identity changed.");
  const matches = variants.flatMap((state, index) => encode(state) === encode(scan.entries) ? [index] : []);
  if (matches.length !== 1) return fail("CONFLICT", "Unknown or ambiguous classification outcome remains fenced.");
  for (let n = matches[0]!; n < intent.effects.length; n++) {
    authorize(host, intent.actor, scope, intent.request.action);
    const check = scanNativeClassification(db, host, scope.root);
    if (encode(check.pin) !== encode(intent.rootPin) || encode(check.entries) !== encode(variants[n])) return fail("CONFLICT", "Layout changed before effect.");
    applyEffect(scope.root, intent.effects[n]!, host, n); host.afterEffect?.(n);
  }
  const final = scanNativeClassification(db, host, scope.root);
  if (encode(final.entries) !== encode(variants.at(-1)) || encode(final.pin) !== encode(intent.rootPin)) return fail("CONFLICT", "Final layout differs.");
  authorize(host, intent.actor, scope, intent.request.action);
  authenticatedClassificationTransaction(db, host, history => {
    const pending = history.pending;
    if (!pending || encode(pending) !== encode(intent) || receipt(db, host, intent.request.operationId)) return fail("CONFLICT", "Intent changed before receipt.");
    host.writeGlobalReceipt(db, intent.request.operationId, fingerprint(intent), intent.result);
    const payload = encode(intent); db.prepare("INSERT INTO legacy_classification_native_receipt VALUES(?,?,?)").run(intent.request.operationId, payload, sha(payload));
    db.prepare("DELETE FROM legacy_classification_native_intent WHERE singleton=1").run();
  });
  return intent.result;
}
export function executeNativeClassification(db: DatabaseSync, host: LegacyClassificationNativeHost | undefined, scope: LegacyClassificationNativeScope, actorValue: Actor, requestValue: unknown) {
  const request = legacyClassificationNativeRequest.safeParse(requestValue); if (!request.success) return fail("INVALID_ARGUMENT", "Invalid classification request.");
  const actor = authorize(host, actorValue, scope, request.data.action), h = host!;
  verifyNativeClassificationSchema(db);
  const prior = authenticatedClassificationTransaction(db, h, history => { if (history.pending) return fail("CONFLICT", "Classification recovery required."); return receipt(db, h, request.data.operationId); });
  if (prior) { if (!sameRequest(prior, actor, scope, request.data)) return fail("CONFLICT", "Operation ID reused."); return prior.result; }
  const scan = scanNativeClassification(db, h, scope.root);
  if (scan.layoutSha256 !== request.data.layoutSha256) return fail("CONFLICT", "Source layout changed.");
  let effects: Effect[];
  const proposals: LegacyClassificationPreview["proposals"] = [];
  if (request.data.action === "apply") {
    const preview = readOriginalClassificationPreview({ actor, workspaceId: scope.workspaceId, sourceRootId: scope.sourceRootId, sourceRootPath: scope.root }, { readOriginalClassificationPreview: root => h.previewOriginal(root) });
    if (preview.truncated || preview.id !== request.data.previewId || new Set(request.data.proposalIds).size !== request.data.proposalIds.length) return fail("CONFLICT", "Preview is stale, truncated, or ambiguous.");
    effects = request.data.proposalIds.map(id => {
      const p = preview.proposals.find(item => item.id === id);
      if (!p || p.type !== "classification") return fail("CONFLICT", "Only original classification proposals are executable.");
      proposals.push(p);
      const asset = scan.entries.find(e => e.path === p.asset), dest = scan.entries.find(e => e.path === p.target);
      if (asset?.kind !== "file" || asset.sha256 !== p.hash || (dest?.sha256 ?? null) !== p.targetHash || dest?.kind === "directory") return fail("CONFLICT", "Asset or target changed.");
      const original = readFile(join(scope.root, p.asset)), before = dest ? readFile(join(scope.root, p.target)) : null;
      const after = p.target === p.asset ? metadata(original, p.classification) : Buffer.from(JSON.stringify({ schema: "pkm.asset-classification/v1", asset: p.locator, classification: p.classification }, null, 2) + "\n");
      return { id, asset: p.asset, target: p.target, before: before?.toString("base64") ?? null, after: after.toString("base64"), mode: dest?.mode ?? 0o600 };
    });
  } else {
    const applyId = request.data.applyOperationId;
    const original = transaction(db, () => receipt(db, h, applyId));
    if (!original || original.request.action !== "apply" || original.actor.id !== actor.id || original.workspaceId !== scope.workspaceId || original.sourceRootId !== scope.sourceRootId) return fail("CONFLICT", "Matching actor-bound apply receipt required.");
    const lineage = validateNativeClassificationAdoptionLineage(db, h, {
      workspaceId: scope.workspaceId, sourceRootId: scope.sourceRootId, currentRootPin: scan.pin,
    });
    if (!lineage.rootPins.some(pin => encode(pin) === encode(original.rootPin))
      || encode(states(original).at(-1)) !== encode(scan.entries)) return fail("CONFLICT", "Applied layout changed before rollback.");
    effects = [...original.effects].reverse().map(e => ({ ...e, before: e.after, after: e.before }));
  }
  const intent = validateNativeClassificationIntent({ request: request.data, actor, workspaceId: scope.workspaceId, sourceRootId: scope.sourceRootId, rootPin: scan.pin, before: scan.entries, effects, proposals, result: { operationId: request.data.operationId, action: request.data.action, applied: effects.map(e => e.id) } });
  if (states(intent).some((state, index, list) => list.findIndex(other => encode(other) === encode(state)) !== index)) return fail("CONFLICT", "No-op or ambiguous effect is unsupported.");
  authenticatedClassificationTransaction(db, h, history => { if (history.pending || receipt(db, h, request.data.operationId)) return fail("CONFLICT", "Admission changed."); const payload = encode(intent); db.prepare("INSERT INTO legacy_classification_native_intent VALUES(1,?,?,?)").run(request.data.operationId, payload, sha(payload)); });
  return resume(db, h, scope, intent);
}
export function recoverNativeClassification(db: DatabaseSync, host: LegacyClassificationNativeHost | undefined, scope: LegacyClassificationNativeScope, actorValue: Actor, requestValue: unknown) {
  const request = legacyClassificationNativeRequest.safeParse(requestValue); if (!request.success) return fail("INVALID_ARGUMENT", "Invalid recovery request.");
  const actor = authorize(host, actorValue, scope, request.data.action), h = host!;
  verifyNativeClassificationSchema(db);
  const intent = authenticatedClassificationTransaction(db, h, history => history.pending);
  if (!intent || !sameRequest(intent, actor, scope, request.data)) return fail("CONFLICT", "Recovery requires the identical authenticated request.");
  let allowed = false; try { allowed = h.approveRecovery(actor, intent) === true; } catch { /* deny */ }
  if (!allowed) return fail("ACCESS_DENIED", "Recovery authority denied.");
  return resume(db, h, scope, intent);
}
