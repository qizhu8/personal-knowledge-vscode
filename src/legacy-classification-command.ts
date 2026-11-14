import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Actor } from "./contracts.js";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { legacyClassificationJournal, legacyClassificationPreview, type LegacyClassificationPreview } from "./legacy-asset-provider.js";
import { legacyClassificationCommandRequest, legacyClassificationCommandResult, legacyClassificationSourceResult } from "./legacy-classification-command-contracts.js";
import {
  nativeClassificationMetadata, publishNativeClassificationEffect, readNativeClassificationFile,
  scanNativeClassification, type LegacyClassificationNativeScope,
  nativeClassificationAdoptionSchema, type LegacyClassificationAdoption,
} from "./legacy-classification-native.js";

const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const json = (v: unknown) => JSON.stringify(v);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const safePath = z.string().refine(v => !v.startsWith("/") && v.split("/").every(p => !!p && p !== "." && p !== ".." && !/[\\\x00-\x1f:]/.test(p)));
const entry = z.strictObject({ path: safePath, kind: z.enum(["file", "directory"]), sha256: digest.nullable(), mode: z.number().int().min(0).max(0o777) });
const pin = z.strictObject({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) });
const effect = z.strictObject({ id: digest, asset: safePath, target: safePath, before: z.string().nullable(), after: z.string().nullable(), mode: z.number().int().min(0).max(0o777) });
const step = z.strictObject({ effect, item: digest, kind: z.enum(["journal", "target"]) });
const outcome = z.strictObject({ id: digest, reason: legacyClassificationSourceResult.shape.skipped.element.shape.reason.nullable() });
const intentSchema = z.strictObject({
  request: z.discriminatedUnion("action", [legacyClassificationCommandRequest.options[1], legacyClassificationCommandRequest.options[2]]),
  actor: z.strictObject({ id: z.string().min(1), canWrite: z.literal(true), collaborationKind: z.enum(["human", "agent", "browser"]).optional() }),
  workspaceId: z.string().min(1), sourceRootId: digest, rootPin: pin,
  before: z.array(entry).max(10000), preview: legacyClassificationPreview.nullable(),
  journalId: z.string().uuid(), journal: legacyClassificationJournal,
  steps: z.array(step).max(2000), outcomes: z.array(outcome).max(1000),
  cursor: z.number().int().nonnegative(), completed: z.array(z.boolean()).max(2000),
});
type Intent = z.infer<typeof intentSchema>;
type Entry = z.infer<typeof entry>;
type Effect = z.infer<typeof effect>;
const journalDirectory = ".pkm/state/asset-classification";
const journalPath = (id: string) => `${journalDirectory}/${id}.json`;
const target = (asset: string) => /\.md$/i.test(asset) ? asset : `${asset.slice(0, asset.lastIndexOf("/") + 1)}.${asset.slice(asset.lastIndexOf("/") + 1)}.pkm-classification`;
const fail = (message: string, code: "CONFLICT" | "ACCESS_DENIED" | "INVALID_ARGUMENT" | "NOT_AVAILABLE" = "CONFLICT"): never => { throw new CoreError(code, message, "unknown"); };
function nativeAssert(fn: () => void, message: string) {
  try { fn(); } catch { return fail(message, "ACCESS_DENIED"); }
}
function pendingAnchor(host: LegacyClassificationCommandHost, i: Intent | null) {
  nativeAssert(() => host.assertPendingAnchor(Object.freeze({ operationId: i?.request.operationId ?? null, payloadSha256: i ? hash(json(i)) : null })),
    "Independent native original classification pending authority denied.");
}
const bytes = (s: string | null) => {
  if (s === null) return null;
  const value = Buffer.from(s, "base64");
  if (value.toString("base64") !== s || value.length > 2_097_152) return fail("Invalid classification image.");
  return value;
};
function advance(layout: Entry[], e: Effect) {
  const prior = layout.find(v => v.path === e.target), before = bytes(e.before), after = bytes(e.after);
  if (prior?.kind === "directory" || (prior?.sha256 ?? null) !== (before === null ? null : hash(before))
    || !layout.some(v => v.path === e.target.slice(0, e.target.lastIndexOf("/")) && v.kind === "directory")
    || prior && prior.mode !== e.mode) return fail("Invalid original-compatible before image.");
  const next = layout.filter(v => v.path !== e.target);
  if (after !== null) next.push({ path: e.target, kind: "file", sha256: hash(after), mode: e.mode });
  return next.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function current(i: Intent) {
  let layout = i.before;
  for (let n = 0; n < i.cursor; n++) if (i.completed[n]) layout = advance(layout, i.steps[n]!.effect);
  return layout;
}
function result(i: Intent) {
  const order = i.request.action === "apply" ? [...new Set(i.request.proposalIds)] : [...i.journal.entries].reverse().map(e => e.id);
  return legacyClassificationCommandResult.parse({ action: i.request.action, operationId: i.request.operationId,
    sourceResult: { journalId: i.journalId, applied: order.filter(id => i.outcomes.find(o => o.id === id)?.reason === null),
      skipped: order.flatMap(id => { const o = i.outcomes.find(o => o.id === id); return o?.reason ? [{ id, reason: o.reason }] : []; }) } });
}
export const LEGACY_CLASSIFICATION_COMMAND_DDL = `
CREATE TABLE IF NOT EXISTS legacy_classification_command_intent(singleton INTEGER PRIMARY KEY CHECK(singleton=1),operation_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,payload_sha256 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS legacy_classification_command_receipt(operation_id TEXT PRIMARY KEY,payload TEXT NOT NULL,payload_sha256 TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS legacy_classification_command_receipt_no_update BEFORE UPDATE ON legacy_classification_command_receipt BEGIN SELECT RAISE(ABORT,'original classification receipt immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_classification_command_receipt_no_delete BEFORE DELETE ON legacy_classification_command_receipt BEGIN SELECT RAISE(ABORT,'original classification receipt immutable'); END;
CREATE TABLE IF NOT EXISTS legacy_classification_command_adoption(adoption_id TEXT PRIMARY KEY,payload TEXT NOT NULL,payload_sha256 TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS legacy_classification_command_adoption_no_update BEFORE UPDATE ON legacy_classification_command_adoption BEGIN SELECT RAISE(ABORT,'original classification adoption immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_classification_command_adoption_no_delete BEFORE DELETE ON legacy_classification_command_adoption BEGIN SELECT RAISE(ABORT,'original classification adoption immutable'); END;`;

export interface LegacyClassificationCommandHost {
  assertOwnedDisposableFixture(): void;
  authorize(actor: Readonly<Actor>, scope: Readonly<LegacyClassificationNativeScope>, action: "preview" | "apply" | "rollback"): boolean;
  previewOriginal(root: string): LegacyClassificationPreview;
  /** Native retained source preview, not request-supplied proposals. */
  reviewedPreview(id: string): LegacyClassificationPreview | undefined;
  /** Native fixture-only UUID injection; never request JSON. Defaults to crypto.randomUUID. */
  fixtureJournalId?(): string;
  isPrivate(asset: string): boolean;
  assertHistoryAnchor(value: Readonly<{ workspaceId: string; sourceRootId: string; rootPin: z.infer<typeof pin>; genesisSha256: string; historySha256: string }>): void;
  assertAdoptionAnchor?(value: Readonly<LegacyClassificationAdoption>): void;
  approveHistoryTransition(value: Readonly<{ previousSha256: string; nextSha256: string; operationId: string }>): boolean;
  /** Independent native pending-head trust, including absence; not a rehashed SQL payload grant. */
  assertPendingAnchor(value: Readonly<{ operationId: string | null; payloadSha256: string | null }>): void;
  approvePendingTransition(value: Readonly<{ operationId: string; previousSha256: string | null; nextSha256: string | null }>): boolean;
  approveRecovery(actor: Readonly<Actor>, intent: Readonly<Intent>): boolean;
  assertNoOtherPending(db: DatabaseSync): void;
  globalReceipt(db: DatabaseSync, id: string): { fingerprint: string; result: unknown } | null;
  writeGlobalReceipt(db: DatabaseSync, id: string, fingerprint: string, result: unknown): void;
  beforeEffect?(index: number): void;
  afterStage?(index: number): void;
  afterEffect?(index: number): void;
}
function authorize(db: DatabaseSync, host: LegacyClassificationCommandHost | undefined, scope: LegacyClassificationNativeScope, actor: Actor, action: "preview" | "apply" | "rollback") {
  if (db.isTransaction) return fail("Filesystem owner called inside SQLite transaction.");
  if (!host || !actor.canWrite || actor.collaborationKind !== "human" || !scope.workspaceId || !digest.safeParse(scope.sourceRootId).success
    || !["assertOwnedDisposableFixture", "authorize", "previewOriginal", "reviewedPreview", "isPrivate",
      "assertHistoryAnchor", "approveHistoryTransition", "assertPendingAnchor", "approvePendingTransition", "approveRecovery", "assertNoOtherPending", "globalReceipt", "writeGlobalReceipt"]
      .every(k => typeof host[k as keyof LegacyClassificationCommandHost] === "function"))
    return fail("Native original classification authority required.", "ACCESS_DENIED");
  nativeAssert(() => host.assertOwnedDisposableFixture(), "Native original classification fixture ownership denied.");
  let allowed = false;
  try { allowed = host.authorize(Object.freeze({ ...actor }), Object.freeze({ ...scope }), action) === true; } catch { /* deny */ }
  if (!allowed) return fail("Native original classification authority denied.", "ACCESS_DENIED");
  return host;
}
function tx<T>(db: DatabaseSync, fn: () => T) {
  if (db.isTransaction) return fail("Original classification requires the pure SQL owner.");
  db.exec("BEGIN IMMEDIATE");
  try { const value = fn(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; }
}
export function verifyLegacyClassificationCommandSchema(db: DatabaseSync) {
  const expected = new (db.constructor as typeof import("node:sqlite").DatabaseSync)(":memory:");
  try {
    expected.exec(LEGACY_CLASSIFICATION_COMMAND_DDL);
    const query = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'legacy_classification_command_%' ORDER BY name";
    if (json(db.prepare(query).all()) !== json(expected.prepare(query).all())) return fail("Original classification DDL differs.");
  } finally { expected.close(); }
}
function parse(row: Record<string, unknown>): Intent {
  if (typeof row.payload !== "string" || hash(row.payload) !== row.payload_sha256) return fail("Corrupt original classification record.");
  let value: unknown; try { value = JSON.parse(row.payload); } catch { return fail("Corrupt original classification JSON."); }
  const parsed = intentSchema.safeParse(value);
  if (!parsed.success) return fail("Invalid original classification intent.");
  const i = parsed.data;
  if (json(i) !== row.payload || i.request.operationId !== row.operation_id || i.cursor !== i.completed.length || i.cursor > i.steps.length
    || hash(json(i.before)) !== i.request.layoutSha256 || new Set(i.before.map(e => e.path)).size !== i.before.length
    || i.before.some((e, n) => (e.kind === "directory") !== (e.sha256 === null) || n > 0 && i.before[n - 1]!.path >= e.path)
    || i.request.action === "apply" && (!i.preview || i.preview.id !== i.request.previewId || hash(json(i.preview.proposals)) !== i.preview.id)
    || i.request.action === "rollback" && i.journalId !== i.request.journalId) return fail("Original classification intent binding differs.");
  for (const s of i.steps) {
    if (s.item !== s.effect.id || s.kind === "target" && (!/^(skills|notes|scripts|components|actions|recipes|papers)\//.test(s.effect.asset) || s.effect.target !== target(s.effect.asset))
      || s.kind === "journal" && (i.request.action !== "apply" || s.effect.target !== journalPath(i.journalId)))
      return fail("Unsafe original classification step.");
    if (s.kind === "journal") {
      const content = bytes(s.effect.after);
      if (!content) return fail("Missing original journal image.");
      const journal = legacyClassificationJournal.parse(JSON.parse(content.toString("utf8")));
      if (!journal.entries.length || json(journal.entries) !== json(i.journal.entries.slice(0, journal.entries.length))
        || journal.entries.at(-1)?.id !== s.item || json(journal) !== content.toString("utf8")) return fail("Original journal prefix differs.");
    } else if (i.request.action === "apply") {
      const p = i.preview!.proposals.find(p => p.id === s.item), e = i.journal.entries.find(e => e.id === s.item);
      if (!p || !e || p.type !== "classification" || p.target !== s.effect.target || p.asset !== s.effect.asset
        || p.hash !== i.before.find(e => e.path === p.asset)?.sha256 || p.targetHash !== e.beforeHash
        || s.effect.before !== e.before || hash(bytes(s.effect.after)!) !== e.afterHash)
        return fail("Original classification proposal/image differs.");
      const derived = p.target === p.asset ? nativeClassificationMetadata(bytes(s.effect.before)!, p.classification)
        : Buffer.from(jsonSidecar(p));
      if (!derived.equals(bytes(s.effect.after)!)) return fail("Original classification writer bytes differ.");
    } else {
      const e = i.journal.entries.find(e => e.id === s.item);
      if (!e || s.effect.after !== e.before || hash(bytes(s.effect.before)!) !== e.afterHash || s.effect.mode !== e.mode)
        return fail("Original rollback image differs.");
    }
  }
  current(i);
  return i;
}
function jsonSidecar(p: LegacyClassificationPreview["proposals"][number]) {
  return JSON.stringify({ schema: "pkm.asset-classification/v1", asset: p.locator, classification: p.classification }, null, 2) + "\n";
}
const fingerprint = (i: Intent) => hash(json({ actor: i.actor, workspaceId: i.workspaceId, sourceRootId: i.sourceRootId, request: i.request }));
export function inspectLegacyClassificationCommand(db: DatabaseSync, host?: Pick<LegacyClassificationCommandHost, "globalReceipt" | "assertAdoptionAnchor">) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_classification_command_receipt'").get())
    return { receipts: [] as Intent[], pending: null as Intent | null, adoptions: [] as LegacyClassificationAdoption[], rootPins: [] as z.infer<typeof pin>[] };
  verifyLegacyClassificationCommandSchema(db);
  const receipts = db.prepare("SELECT operation_id,payload,payload_sha256 FROM legacy_classification_command_receipt ORDER BY rowid").all().map(parse);
  const pendingRow = db.prepare("SELECT operation_id,payload,payload_sha256 FROM legacy_classification_command_intent").get();
  const pending = pendingRow ? parse(pendingRow) : null;
  const adoptions = db.prepare("SELECT adoption_id,payload,payload_sha256 FROM legacy_classification_command_adoption ORDER BY rowid").all().map(row => {
    if (typeof row.payload !== "string" || hash(row.payload) !== row.payload_sha256) return fail("Corrupt original classification adoption.");
    let value: unknown;
    try { value = JSON.parse(row.payload); } catch { return fail("Invalid original classification adoption JSON."); }
    const parsed = nativeClassificationAdoptionSchema.safeParse(value);
    if (!parsed.success || parsed.data.adoptionId !== row.adoption_id || json(parsed.data) !== row.payload)
      return fail("Invalid original classification adoption binding.");
    return parsed.data;
  });
  const first = receipts[0] ?? pending;
  const rootPins = first ? [{ ...first.rootPin }] : [];
  const seenPins = new Set(rootPins.map(json));
  for (let index = 0; index < adoptions.length; index++) {
    const a = adoptions[index]!, previous = adoptions[index - 1];
    const prefix = receipts.slice(0, a.receiptCount);
    if (!first || a.workspaceId !== first.workspaceId || a.sourceRootId !== first.sourceRootId
      || json(a.sourceRootPin) !== json(rootPins.at(-1)) || seenPins.has(json(a.destinationRootPin))
      || a.receiptCount > receipts.length || hash(json(prefix)) !== a.historySha256
      || hash(json(first.before)) !== a.genesisSha256 || json(current(prefix.at(-1)!)) !== json(a.layout)
      || hash(json(a.layout)) !== a.layoutSha256
      || adoptions[0]!.sourceRelative !== a.sourceRelative
      || previous && (a.receiptCount < previous.receiptCount || a.sourceRoot !== join(previous.destination, a.sourceRelative)))
      return fail("Original classification adoption lineage is disconnected or cyclic.");
    if (host) {
      if (!host.assertAdoptionAnchor) return fail("Native original classification adoption authority required.", "ACCESS_DENIED");
      if (db.isTransaction) return fail("Native original classification adoption authority cannot run inside SQLite transactions.");
      nativeAssert(() => host.assertAdoptionAnchor!(Object.freeze(a)), "Native original classification adoption authority denied.");
    }
    rootPins.push({ ...a.destinationRootPin }); seenPins.add(json(a.destinationRootPin));
  }
  const all = pending ? [...receipts, pending] : receipts;
  for (let n = 0; n < all.length; n++) {
    const i = all[n]!;
    const adoption = adoptions.filter(a => a.receiptCount <= n).at(-1);
    const expectedRootPin = adoption?.destinationRootPin ?? first!.rootPin;
    if (all.slice(0, n).some(v => v.request.operationId === i.request.operationId)
      || json(i.rootPin) !== json(expectedRootPin)
      || n > 0 && (all[n - 1]!.workspaceId !== i.workspaceId
        || all[n - 1]!.sourceRootId !== i.sourceRootId || json(current(all[n - 1]!)) !== json(i.before)))
      return fail("Original classification ordered history is disconnected.");
    if (i.request.action === "rollback") {
      const apply = receipts.slice(0, n).find(r => r.request.action === "apply" && r.journalId === i.journalId);
      const actual = apply?.steps.filter((s, index) => s.kind === "journal" && apply.completed[index]).at(-1)?.effect.after;
      if (!apply || apply.actor.id !== i.actor.id || !actual || bytes(actual)!.toString("utf8") !== json(i.journal)) return fail("Original rollback journal provenance differs.");
    }
    if (n < receipts.length && i.cursor !== i.steps.length) return fail("Incomplete original classification receipt.");
    if (host) {
      const global = host.globalReceipt(db, i.request.operationId);
      if (n < receipts.length ? !global || global.fingerprint !== fingerprint(i) || json(global.result) !== json(result(i)) : !!global)
        return fail("Original classification global receipt differs.");
    }
  }
  return { receipts, pending, adoptions, rootPins };
}
export function validateLegacyClassificationCommandLayout(
  history: ReturnType<typeof inspectLegacyClassificationCommand>,
  scope: Pick<LegacyClassificationNativeScope, "workspaceId" | "sourceRootId">,
  scan: ReturnType<typeof scanNativeClassification>,
  logicalPin = scan.pin,
) {
  const first = history.receipts[0] ?? history.pending;
  if (first && (first.workspaceId !== scope.workspaceId || first.sourceRootId !== scope.sourceRootId
    || json(history.rootPins?.at(-1)) !== json(logicalPin))) return fail("Original classification historical root differs.");
  const head = history.pending ?? history.receipts.at(-1);
  if (head) {
    const layout = current(head), next = history.pending?.steps[head.cursor];
    if (json(scan.entries) !== json(layout) && (!next || json(scan.entries) !== json(advance(layout, next.effect))))
      return fail("Unknown original classification outcome or staged residue.");
  }
  return { status: history.pending ? "pending" as const : first ? "committed" as const : "untracked" as const,
    appliedEffects: history.pending?.cursor ?? null };
}
export function verifyLegacyClassificationCommandHistory(db: DatabaseSync, host: LegacyClassificationCommandHost, scope: LegacyClassificationNativeScope) {
  const history = inspectLegacyClassificationCommand(db, host);
  pendingAnchor(host, history.pending);
  const scan = scanNativeClassification(db, host, scope.root), first = history.receipts[0] ?? history.pending;
  validateLegacyClassificationCommandLayout(history, scope, scan);
  nativeAssert(() => host.assertHistoryAnchor(Object.freeze({ workspaceId: scope.workspaceId, sourceRootId: scope.sourceRootId, rootPin: first?.rootPin ?? scan.pin,
    genesisSha256: hash(json(first?.before ?? scan.entries)), historySha256: hash(json(history.receipts)) })), "Independent native original classification history/epoch authority denied.");
  return { ...history, scan };
}
function persist(db: DatabaseSync, host: LegacyClassificationCommandHost, i: Intent) {
  const row = db.prepare("SELECT payload_sha256 FROM legacy_classification_command_intent WHERE operation_id=?").get(i.request.operationId);
  const previous = row ? String(row.payload_sha256) : null, payload = json(i);
  if (!previous || !host.approvePendingTransition(Object.freeze({ operationId: i.request.operationId, previousSha256: previous, nextSha256: hash(payload) })))
    return fail("Native original classification pending transition denied.", "ACCESS_DENIED");
  tx(db, () => { host.assertNoOtherPending(db); const payload = json(i);
    const result = db.prepare("UPDATE legacy_classification_command_intent SET payload=?,payload_sha256=? WHERE operation_id=? AND payload_sha256=?").run(payload, hash(payload), i.request.operationId, previous);
    if (result.changes !== 1) return fail("Original classification pending head changed."); });
}
function resume(db: DatabaseSync, host: LegacyClassificationCommandHost, scope: LegacyClassificationNativeScope, i: Intent, receipts: Intent[]) {
  for (; i.cursor < i.steps.length;) {
    authorize(db, host, scope, i.actor, i.request.action);
    pendingAnchor(host, i);
    tx(db, () => host.assertNoOtherPending(db));
    const s = i.steps[i.cursor]!, layout = current(i), next = advance(layout, s.effect);
    let scan = scanNativeClassification(db, host, scope.root);
    if (json(scan.pin) !== json(i.rootPin)) return fail("Original classification root changed.");
    const skip = s.kind === "target" && i.outcomes.some(o => o.id === s.item && o.reason !== null);
    let done = false;
    if (skip) {
      if (json(scan.entries) !== json(layout)) return fail("Original skipped item layout changed.");
    } else if (json(scan.entries) === json(next) && json(next) !== json(layout)) done = true;
    else if (json(scan.entries) === json(layout)) {
      try {
        host.beforeEffect?.(i.cursor);
        publishNativeClassificationEffect(scope.root, s.effect, host, i.cursor);
        done = true;
      } catch (error) {
        scan = scanNativeClassification(db, host, scope.root);
        if (json(scan.pin) !== json(i.rootPin) || json(scan.entries) !== json(layout)) throw error;
        i.outcomes = i.outcomes.filter(o => o.id !== s.item);
        i.outcomes.push({ id: s.item, reason: "unsafe-or-unavailable" });
        if (s.kind === "journal") {
          const following = i.steps.slice(i.cursor + 1).find(step => step.kind === "journal");
          if (following) following.effect.before = s.effect.before;
        }
      }
      if (done) host.afterEffect?.(i.cursor);
    } else return fail("Unknown original classification outcome remains fenced.");
    if (done && s.kind === "target") i.outcomes.push({ id: s.item, reason: null });
    i.completed.push(done); i.cursor++; persist(db, host, i);
  }
  authorize(db, host, scope, i.actor, i.request.action);
  const scan = scanNativeClassification(db, host, scope.root);
  if (json(scan.pin) !== json(i.rootPin) || json(scan.entries) !== json(current(i))) return fail("Original classification final layout differs.");
  if (!host.approveHistoryTransition(Object.freeze({ previousSha256: hash(json(receipts)), nextSha256: hash(json([...receipts, i])), operationId: i.request.operationId })))
    return fail("Original classification history transition denied.", "ACCESS_DENIED");
  pendingAnchor(host, i);
  if (!host.approvePendingTransition(Object.freeze({ operationId: i.request.operationId, previousSha256: hash(json(i)), nextSha256: null })))
    return fail("Original classification receipt pending transition denied.", "ACCESS_DENIED");
  authorize(db, host, scope, i.actor, i.request.action);
  const value = result(i);
  const authenticatedHistory = inspectLegacyClassificationCommand(db, host);
  tx(db, () => {
    host.assertNoOtherPending(db);
    const stored = inspectLegacyClassificationCommand(db);
    if (json(stored) !== json(authenticatedHistory) || !stored.pending || json(stored.pending) !== json(i)
      || host.globalReceipt(db, i.request.operationId)) return fail("Original classification receipt admission changed.");
    host.writeGlobalReceipt(db, i.request.operationId, fingerprint(i), value);
    const payload = json(i); db.prepare("INSERT INTO legacy_classification_command_receipt VALUES(?,?,?)").run(i.request.operationId, payload, hash(payload));
    db.prepare("DELETE FROM legacy_classification_command_intent WHERE singleton=1").run();
  });
  return value;
}
export function executeLegacyClassificationCommand(db: DatabaseSync, hostValue: LegacyClassificationCommandHost | undefined, scope: LegacyClassificationNativeScope, actor: Actor, value: unknown) {
  const parsed = legacyClassificationCommandRequest.safeParse(value);
  if (!parsed.success) return fail("Invalid original classification command.", "INVALID_ARGUMENT");
  const request = parsed.data, host = authorize(db, hostValue, scope, actor, request.action);
  const history = verifyLegacyClassificationCommandHistory(db, host, scope);
  tx(db, () => host.assertNoOtherPending(db));
  if (request.action === "preview") {
    if (history.pending) return fail("Original classification recovery required.");
    const preview = legacyClassificationPreview.parse(host.previewOriginal(scope.root));
    if (preview.root !== scope.root || hash(json(preview.proposals)) !== preview.id) return fail("Invalid source preview.");
    return { action: "preview" as const, sourceResult: preview };
  }
  const retry = history.receipts.find(i => i.request.operationId === request.operationId);
  const identical = (i: Intent) => json(i.request) === json(request) && json(i.actor) === json(actor) && i.workspaceId === scope.workspaceId && i.sourceRootId === scope.sourceRootId;
  if (retry) { if (!identical(retry)) return fail("Original classification operation ID reused."); return result(retry); }
  if (history.pending) {
    if (!identical(history.pending) || !host.approveRecovery(actor, history.pending)) return fail("Identical native-approved original classification recovery required.", "ACCESS_DENIED");
    if (history.pending.request.action === "apply"
      && json(host.reviewedPreview(history.pending.request.previewId)) !== json(history.pending.preview))
      return fail("Original recovery preview differs from retained native source evidence.");
    return resume(db, host, scope, history.pending, history.receipts);
  }
  if (host.globalReceipt(db, request.operationId)) return fail("Original classification global operation ID collision.");
  if (request.layoutSha256 !== history.scan.layoutSha256) return fail("Original classification native source CAS differs.");
  if (!history.scan.entries.some(e => e.path === journalDirectory && e.kind === "directory"))
    return fail("Native fixture genesis must provision the source journal directory.", "NOT_AVAILABLE");
  const journalId = request.action === "apply" ? (host.fixtureJournalId?.() ?? randomUUID()) : request.journalId;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(journalId)) return fail("Original native fixture journal ID must be UUIDv4.", "INVALID_ARGUMENT");
  const i: Intent = { request, actor: intentSchema.shape.actor.parse(actor), workspaceId: scope.workspaceId, sourceRootId: scope.sourceRootId,
    rootPin: history.scan.pin, before: history.scan.entries, preview: null, journalId,
    journal: { schema: 1, entries: [] }, steps: [], outcomes: [], cursor: 0, completed: [] };
  let simulated = i.before;
  const add = (e: Effect, kind: "journal" | "target") => { simulated = advance(simulated, e); i.steps.push({ effect: e, item: e.id, kind }); };
  const read = (p: string) => simulated.find(e => e.path === p) ? readNativeClassificationFile(join(scope.root, p)) : null;
  if (request.action === "apply") {
    const preview = legacyClassificationPreview.parse(host.reviewedPreview(request.previewId));
    if (preview.root !== scope.root || preview.id !== request.previewId || hash(json(preview.proposals)) !== preview.id
      || request.proposalIds.some(id => !preview.proposals.some(p => p.id === id))) return fail("Explicit proposal IDs from the retained original preview are required.", "INVALID_ARGUMENT");
    i.preview = preview;
    let previousJournal: Buffer | null = null;
    if (i.before.some(e => e.path === journalPath(i.journalId))) return fail("Original UUID journal collision.");
    for (const id of [...new Set(request.proposalIds)]) {
      const p = preview.proposals.find(p => p.id === id)!;
      if (p.type !== "classification") { i.outcomes.push({ id, reason: "review-only" }); continue; }
      if (!/^(skills|notes|scripts|components|actions|recipes|papers)\//.test(p.asset) || p.target !== target(p.asset))
        return fail("Unsafe original proposal target.");
      if (host.isPrivate(p.asset)) { i.outcomes.push({ id, reason: "privacy-changed-since-preview" }); continue; }
      if (simulated.find(e => e.path === p.asset)?.sha256 !== p.hash || (simulated.find(e => e.path === p.target)?.sha256 ?? null) !== p.targetHash) {
        i.outcomes.push({ id, reason: "changed-since-preview" }); continue;
      }
      let before: Buffer | null, after: Buffer;
      try { before = read(p.target); after = p.target === p.asset ? nativeClassificationMetadata(readNativeClassificationFile(join(scope.root, p.asset)), p.classification) : Buffer.from(jsonSidecar(p)); }
      catch { i.outcomes.push({ id, reason: "unsafe-or-unavailable" }); continue; }
      const mode = simulated.find(e => e.path === p.target)?.mode ?? 0o600;
      i.journal.entries.push({ id, asset: p.asset, target: p.target, before: before?.toString("base64") ?? null, beforeHash: p.targetHash, afterHash: hash(after), mode });
      const journal = Buffer.from(json(i.journal));
      add({ id, asset: p.asset, target: journalPath(i.journalId), before: previousJournal?.toString("base64") ?? null, after: journal.toString("base64"), mode: 0o600 }, "journal");
      previousJournal = journal;
      add({ id, asset: p.asset, target: p.target, before: before?.toString("base64") ?? null, after: after.toString("base64"), mode }, "target");
    }
  } else {
    const apply = history.receipts.find(r => r.request.action === "apply" && r.journalId === request.journalId);
    if (!apply || apply.actor.id !== actor.id) return fail("Actor-bound original UUID journal receipt required.");
    const actual = apply.steps.filter((s, index) => s.kind === "journal" && apply.completed[index]).at(-1)?.effect.after;
    if (!actual) return fail("Original apply did not publish a journal.", "NOT_AVAILABLE");
    i.journal = legacyClassificationJournal.parse(JSON.parse(bytes(actual)!.toString("utf8")));
    const onDisk = readNativeClassificationFile(join(scope.root, journalPath(i.journalId)));
    if (!onDisk.equals(Buffer.from(json(i.journal)))) return fail("Opaque original journal bytes changed.");
    for (const e of [...i.journal.entries].reverse()) {
      const existing = simulated.find(v => v.path === e.target), currentHash = existing?.sha256 ?? null;
      if (currentHash === e.beforeHash) { i.outcomes.push({ id: e.id, reason: "already-restored-or-not-written" }); continue; }
      if (currentHash !== e.afterHash) { i.outcomes.push({ id: e.id, reason: "changed-since-apply" }); continue; }
      const before = readNativeClassificationFile(join(scope.root, e.target));
      add({ id: e.id, asset: e.asset, target: e.target, before: before.toString("base64"), after: e.before, mode: e.mode }, "target");
    }
  }
  const payload = json(i);
  parse({ operation_id: request.operationId, payload, payload_sha256: hash(payload) });
  if (!host.approvePendingTransition(Object.freeze({ operationId: i.request.operationId, previousSha256: null, nextSha256: hash(payload) })))
    return fail("Original classification intent authority denied.", "ACCESS_DENIED");
  const authenticatedHistory = inspectLegacyClassificationCommand(db, host);
  tx(db, () => { host.assertNoOtherPending(db);
    const stored = inspectLegacyClassificationCommand(db);
    if (json(stored) !== json(authenticatedHistory) || stored.pending || host.globalReceipt(db, request.operationId)) return fail("Original classification admission changed.");
    db.prepare("INSERT INTO legacy_classification_command_intent VALUES(1,?,?,?)").run(request.operationId, payload, hash(payload)); });
  return resume(db, host, scope, i, history.receipts);
}
