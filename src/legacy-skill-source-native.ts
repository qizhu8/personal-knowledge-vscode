import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, mkdirSync, openSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Actor } from "./contracts.js";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { legacySkillBindingSchema, legacySkillManifestHash, legacySkillManifestSchema, type LegacySkillBinding, type LegacySkillManifest } from "./legacy-skill-lifecycle.js";
import { scanNativeLegacySkillSourceAndTarget, type LegacySkillRoots } from "./legacy-skill-lifecycle-native.js";
import { legacySkillSourceInstallInputSchema, legacySkillSourceRemoveInputSchema, prepareLegacySkillSourceInstall, prepareLegacySkillSourceRemove,
  validateLegacySkillSourceInstallPlan, validateLegacySkillSourceRemovePlan,
  type LegacySkillSourceInstallInput, type LegacySkillSourceInstallPlan, type LegacySkillSourceRemoveInput,
  type LegacySkillSourceRemovePlan } from "./legacy-skill-source.js";
import { legacySkillSourceBridgeInputSchema, type LegacySkillSourceBridgePlan } from "./legacy-skill-source.js";
import { captureBatch15SkillHistory } from "./host-composition-legacy-batch15-skill.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fail = (code: "ACCESS_DENIED" | "CONFLICT" | "INVALID_ARGUMENT" | "NOT_AVAILABLE" | "RECOVERY_REQUIRED", message: string, unknown = false): never => {
  throw new CoreError(code, message, unknown ? "unknown" : "not-committed");
};
const json = JSON.stringify;
type Pins = ReturnType<typeof scanNativeLegacySkillSourceAndTarget>["pins"];
type Snapshot = { intents: unknown[]; receipts: unknown[]; history: unknown[]; adoptions: unknown[] };
type Result = { operationId: string; sourceSha256: string; sourceManifestSha256: string; destinationSha256: string | null; destinationManifestSha256: string };
type Plan = LegacySkillSourceInstallPlan | LegacySkillSourceRemovePlan;
type Input = LegacySkillSourceInstallInput | LegacySkillSourceRemoveInput;
const isRemove = (plan: Plan): plan is LegacySkillSourceRemovePlan => "kind" in plan && plan.kind === "remove";
type Row = { operation_id: string; fingerprint: string; epoch: string; plan_json: string; pins_json: string; integrity: string };
type HistoryRow = { sequence: number; operation_id: string; epoch: string; pins_json: string; plan_json: string; previous_sha256: string; entry_sha256: string };
const pinSchema = z.strictObject({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) });
const pinsSchema = z.strictObject({ source: pinSchema, destination: pinSchema });
const rootPathSchema = z.string().min(1).max(4096).refine(path =>
  !path.includes("\0") && isAbsolute(path) && resolve(path) === path, "Root path must be canonical and absolute.");
const rootsSchema = z.strictObject({ source: rootPathSchema, destination: rootPathSchema }).refine(roots => {
  const a = relative(roots.source, roots.destination), b = relative(roots.destination, roots.source);
  const outside = (path: string) => path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
  return !!a && !!b && outside(a) && outside(b);
}, "Root paths must be disjoint.");
const adoptionRequestSchema = z.strictObject({
  oldRoots: rootsSchema, newRoots: rootsSchema, oldPins: pinsSchema, newPins: pinsSchema,
  physicalRoots: rootsSchema.optional(),
  binding: legacySkillBindingSchema, historyHead: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceManifest: legacySkillManifestSchema, destinationManifest: legacySkillManifestSchema,
});
export type LegacySkillSourceRootAdoption = z.infer<typeof adoptionRequestSchema>;
export type LegacySkillSourceAdoptionRow = { sequence: number; history_sequence: number; request_json: string; previous_sha256: string; entry_sha256: string };
function parsePins(value: string): Pins {
  let raw: unknown;
  try { raw = JSON.parse(value); } catch { return fail("CONFLICT", "Invalid Skill source root pins."); }
  const parsed = pinsSchema.safeParse(raw);
  if (!parsed.success || json(parsed.data) !== value) return fail("CONFLICT", "Invalid Skill source root pins.");
  return parsed.data;
}

export const LEGACY_SKILL_SOURCE_NATIVE_JOURNAL_DDL = `
CREATE TABLE IF NOT EXISTS legacy_skill_source_native_intent (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), operation_id TEXT NOT NULL UNIQUE,
 fingerprint TEXT NOT NULL, epoch TEXT NOT NULL, plan_json TEXT NOT NULL, pins_json TEXT NOT NULL, integrity TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS legacy_skill_source_native_receipt (
 operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, binding_json TEXT NOT NULL, result_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS legacy_skill_source_native_history (
 sequence INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, epoch TEXT NOT NULL, pins_json TEXT NOT NULL, plan_json TEXT NOT NULL,
 previous_sha256 TEXT NOT NULL, entry_sha256 TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS legacy_skill_source_native_adoption (
 sequence INTEGER PRIMARY KEY, history_sequence INTEGER NOT NULL, request_json TEXT NOT NULL,
 previous_sha256 TEXT NOT NULL, entry_sha256 TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS legacy_skill_source_receipt_no_update BEFORE UPDATE ON legacy_skill_source_native_receipt
BEGIN SELECT RAISE(ABORT, 'Skill source receipt is immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_skill_source_receipt_no_delete BEFORE DELETE ON legacy_skill_source_native_receipt
BEGIN SELECT RAISE(ABORT, 'Skill source receipt is immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_skill_source_history_no_update BEFORE UPDATE ON legacy_skill_source_native_history
BEGIN SELECT RAISE(ABORT, 'Skill source history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_skill_source_history_no_delete BEFORE DELETE ON legacy_skill_source_native_history
BEGIN SELECT RAISE(ABORT, 'Skill source history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_skill_source_adoption_no_update BEFORE UPDATE ON legacy_skill_source_native_adoption
BEGIN SELECT RAISE(ABORT, 'Skill source adoption is immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_skill_source_adoption_no_delete BEFORE DELETE ON legacy_skill_source_native_adoption
BEGIN SELECT RAISE(ABORT, 'Skill source adoption is immutable'); END;`;

const schemaNames = ["legacy_skill_source_native_intent", "legacy_skill_source_native_receipt", "legacy_skill_source_native_history",
  "legacy_skill_source_native_adoption", "legacy_skill_source_receipt_no_update", "legacy_skill_source_receipt_no_delete",
  "legacy_skill_source_history_no_update", "legacy_skill_source_history_no_delete", "legacy_skill_source_adoption_no_update", "legacy_skill_source_adoption_no_delete"];
export function validateNativeLegacySkillSourceJournalSchema(db: DatabaseSync) {
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(LEGACY_SKILL_SOURCE_NATIVE_JOURNAL_DDL);
    const sql = `SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name IN (${schemaNames.map(() => "?").join(",")}) ORDER BY name`;
    if (json(db.prepare(sql).all(...schemaNames)) !== json(expected.prepare(sql).all(...schemaNames)))
      fail("CONFLICT", "Skill source journal schema changed.");
  } finally { expected.close(); }
}
export function initializeNativeLegacySkillSourceJournal(db: DatabaseSync) {
  if (!db.isTransaction) fail("CONFLICT", "Skill source migration requires a transaction.");
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE name IN (${schemaNames.map(() => "?").join(",")}) LIMIT 1`).get(...schemaNames))
    validateNativeLegacySkillSourceJournalSchema(db);
  db.exec(LEGACY_SKILL_SOURCE_NATIVE_JOURNAL_DDL);
  validateNativeLegacySkillSourceJournalSchema(db);
}

/**
 * All native callbacks except the SQL hooks run outside transactions under the
 * exclusive owner fence. Anchor callbacks must use independent durable native
 * state: check compares exact snapshots, advance atomically records the next
 * snapshot, and reconcile explicitly verifies an interrupted advance from its
 * independently retained prior anchor to this exact approved operation. It
 * must not accept an arbitrary SQLite snapshot, even at initial admission.
 * SQL hooks must be synchronous and must never access the filesystem.
 * Bundle lookup must return independently pinned historic bytes, not journal data.
 * Bridge approval must independently retain the exact original receipt/history
 * snapshot, single-version/single-target admission, full inventories and root
 * pins. verifyBridge checks that retained approval, including after root
 * adoption; neither a request hash nor SQLite is approval. Bridge reconciliation
 * admits only the retained identical request and epoch from a known prior
 * native anchor. All original receipts remain unchanged.
 */
export interface LegacySkillSourceNativeAuthority {
  binding: LegacySkillBinding;
  roots: LegacySkillRoots;
  bundle: Buffer;
  bundleSha256: string;
  epoch: string;
  assertOwner(): void;
  authorize(actor: Readonly<Actor>, binding: Readonly<LegacySkillBinding>): boolean;
  approvePlan(actor: Readonly<Actor>, plan: Readonly<LegacySkillSourceInstallPlan>, pins: Readonly<Pins>, recovery: boolean): boolean;
  approveRemovePlan?(actor: Readonly<Actor>, plan: Readonly<LegacySkillSourceRemovePlan>, pins: Readonly<Pins>, recovery: boolean): boolean;
  approveBridge?(actor: Readonly<Actor>, plan: Readonly<LegacySkillSourceBridgePlan>, pins: Readonly<Pins>, recovery: boolean): boolean;
  verifyBridge?(plan: Readonly<LegacySkillSourceBridgePlan>, pins: Readonly<Pins>): boolean;
  reconcileBridgeAnchor?(snapshotDigest: string, actor: Readonly<Actor>, recovery: {
    plan: Readonly<LegacySkillSourceBridgePlan>; pins: Readonly<Pins>; committed: boolean;
  }): void;
  assertNoOtherPendingNative(): void;
  checkAnchor(snapshotDigest: string): void;
  advanceAnchor(beforeDigest: string, afterDigest: string): void;
  reconcileAnchor(snapshotDigest: string, actor: Readonly<Actor>, recovery: {
    plan: Readonly<LegacySkillSourceInstallPlan>; pins: Readonly<Pins>; committed: boolean;
  }): void;
  reconcileRemoveAnchor?(snapshotDigest: string, actor: Readonly<Actor>, recovery: {
    plan: Readonly<LegacySkillSourceRemovePlan>; pins: Readonly<Pins>; committed: boolean;
  }): void;
  approveAdoption?(actor: Readonly<Actor>, request: Readonly<LegacySkillSourceRootAdoption>): boolean;
  reconcileAdoptionAnchor?(snapshotDigest: string, actor: Readonly<Actor>, request: Readonly<LegacySkillSourceRootAdoption>): void;
  bundleForDigest(digest: string): Buffer | undefined;
  assertSqlOwner(db: DatabaseSync): void;
  assertNoOtherPendingSql(db: DatabaseSync): void;
  globalReceipt(db: DatabaseSync, operationId: string): { fingerprint: string; result: unknown } | null;
  writeGlobalReceipt(db: DatabaseSync, operationId: string, fingerprint: string, result: Result): void;
}

function outside(db: DatabaseSync) {
  if (db.isTransaction) fail("CONFLICT", "Native Skill source filesystem and authority require no SQL transaction.");
}
function tx<T>(db: DatabaseSync, host: LegacySkillSourceNativeAuthority, fn: () => T): T {
  outside(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    host.assertSqlOwner(db);
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
}
function snapshot(db: DatabaseSync): Snapshot {
  return {
    intents: db.prepare("SELECT * FROM legacy_skill_source_native_intent ORDER BY singleton").all(),
    receipts: db.prepare("SELECT * FROM legacy_skill_source_native_receipt ORDER BY operation_id").all(),
    history: db.prepare("SELECT * FROM legacy_skill_source_native_history ORDER BY sequence").all(),
    adoptions: db.prepare("SELECT * FROM legacy_skill_source_native_adoption ORDER BY sequence").all(),
  };
}
const snapshotHash = (s: Snapshot) => hash(json(s));
/** Captures the local SQL snapshot digest; this is not an independent trust anchor. */
export function captureNativeLegacySkillSourceSnapshotDigest(db: DatabaseSync) {
  outside(db);
  return snapshotHash(snapshot(db));
}
function anchored(db: DatabaseSync, host: LegacySkillSourceNativeAuthority): string {
  outside(db); host.assertOwner();
  const digest = snapshotHash(snapshot(db));
  host.checkAnchor(digest);
  host.assertOwner();
  return digest;
}
function sameSnapshot(db: DatabaseSync, expected: string) {
  if (snapshotHash(snapshot(db)) !== expected) fail("CONFLICT", "Skill source journal changed after native anchor check.");
}
function advance(db: DatabaseSync, host: LegacySkillSourceNativeAuthority, before: string) {
  outside(db);
  try { host.assertOwner(); host.advanceAnchor(before, snapshotHash(snapshot(db))); }
  catch { fail("RECOVERY_REQUIRED", "Native Skill source anchor advance is unknown; explicit recovery required.", true); }
}
function authorize(db: DatabaseSync, host: LegacySkillSourceNativeAuthority | undefined, actor: Actor) {
  outside(db);
  if (!host || !host.epoch || !legacySkillBindingSchema.safeParse(host.binding).success
    || !Buffer.isBuffer(host.bundle) || hash(host.bundle) !== host.bundleSha256)
    return fail("NOT_AVAILABLE", "Native Skill source authority and independently pinned bundle are required.");
  host.assertOwner();
  if (!actor?.id || !actor.canWrite || actor.id !== host.binding.actorId || host.authorize(actor, host.binding) !== true)
    return fail("ACCESS_DENIED", "Native Skill source actor is not approved.");
  return host;
}
function entryHash(sequence: number, operationId: string, epoch: string, pinsJson: string, planJson: string, previous: string) {
  return hash(json({ sequence, operationId, epoch, pinsJson, planJson, previous }));
}
function adoptionHash(sequence: number, historySequence: number, requestJson: string, previous: string) {
  return hash(json({ sequence, historySequence, requestJson, previous }));
}
const bridgeSchema = z.strictObject({
  kind: z.literal("bridge"),
  actor: z.strictObject({ id: z.string().min(1), canWrite: z.literal(true), collaborationKind: z.literal("human") }),
  roots: rootsSchema, epoch: z.string().min(1), input: legacySkillSourceBridgeInputSchema,
  legacy: z.strictObject({ rows: z.array(z.unknown()).nonempty(), locals: z.array(z.unknown()).nonempty(), globals: z.array(z.unknown()).nonempty() }),
  genesis: z.unknown(),
});
export function validateNativeLegacySkillSourceBridge(value: unknown, bundleForDigest: (digest: string) => Buffer | undefined): LegacySkillSourceBridgePlan {
  const parsed = bridgeSchema.safeParse(value);
  if (!parsed.success) return fail("CONFLICT", "Invalid Skill source bridge.");
  const request = parsed.data, bundle = bundleForDigest(request.input.bundleSha256);
  if (!bundle) return fail("NOT_AVAILABLE", "Bridge genesis bundle is not independently available.");
  const genesis = validateLegacySkillSourceInstallPlan(request.genesis, bundle, request.input.bundleSha256);
  const { legacyHistorySha256, ...input } = request.input;
  if (hash(json(request.legacy)) !== legacyHistorySha256 || json(genesis.input) !== json(input)
    || genesis.binding.actorId !== request.actor.id || genesis.source.beforeBase64 !== genesis.source.afterBase64
    || genesis.destinationBeforeBase64 !== genesis.destinationAfterBase64
    || json(genesis.sourceBeforeManifest) !== json(genesis.sourceAfterManifest)
    || json(genesis.destinationBeforeManifest) !== json(genesis.destinationAfterManifest))
    return fail("CONFLICT", "Bridge genesis is not an exact no-effect existing installation.");
  const plan = { ...request, genesis };
  if (json(plan) !== json(value)) return fail("CONFLICT", "Noncanonical Skill bridge.");
  return plan;
}
export function verifyNativeLegacySkillSourceBridgeSql(db: DatabaseSync, plan: LegacySkillSourceBridgePlan) {
  const captured = captureBatch15SkillHistory(db, plan.genesis.binding.workspaceId);
  const legacy = JSON.parse(json({ rows: captured.rows, locals: captured.locals, globals: captured.globals })) as LegacySkillSourceBridgePlan["legacy"];
  const head = [...captured.heads.values()][0];
  if (json(legacy) !== json(plan.legacy) || captured.heads.size !== 1 || !head
    || json(head.admission.binding) !== json(plan.genesis.binding)
    || head.sourceSha256 !== plan.input.sourceSha256
    || head.result.destinationSha256 !== plan.input.destinationSha256
    || head.result.manifestSha256 !== plan.input.destinationManifestSha256
    || captured.globals.length !== captured.rows.length)
    fail("CONFLICT", "Bridge legacy receipts, binding or original head changed.");
  for (const row of captured.rows) {
    const record = JSON.parse(String(row.record));
    if (json(record.actor) !== json(plan.actor) || record.input.sourceSha256 !== plan.input.sourceSha256
      || json(record.admission.binding) !== json(plan.genesis.binding))
      fail("CONFLICT", "Bridge requires one exact authenticated legacy actor, source version and target binding.");
  }
}
/** Validates historical plans using independent bundle versions, never current source bytes. */
export function validateNativeLegacySkillSourceHistory(rows: readonly HistoryRow[], bundleForDigest: (digest: string) => Buffer | undefined,
  adoptions: readonly LegacySkillSourceAdoptionRow[] = []) {
  let previous = "0".repeat(64), last: Plan | undefined;
  let lastPins: Pins | undefined;
  let lastRoots: LegacySkillRoots | undefined, adoptionHead = "0".repeat(64), adoptionIndex = 0;
  function applyAdoptions(historySequence: number) {
    while (adoptionIndex < adoptions.length && adoptions[adoptionIndex]!.history_sequence === historySequence) {
      const row = adoptions[adoptionIndex]!;
      if (row.sequence !== adoptionIndex + 1 || row.previous_sha256 !== adoptionHead
        || row.entry_sha256 !== adoptionHash(row.sequence, row.history_sequence, row.request_json, row.previous_sha256))
        fail("CONFLICT", "Skill source root adoption chain is invalid.");
      let raw: unknown;
      try { raw = JSON.parse(row.request_json); } catch { return fail("CONFLICT", "Invalid Skill source root adoption."); }
      const parsed = adoptionRequestSchema.safeParse(raw);
      if (!parsed.success || json(parsed.data) !== row.request_json || !last || !lastPins
        || parsed.data.historyHead !== previous || json(parsed.data.binding) !== json(last.binding)
        || json(parsed.data.oldPins) !== json(lastPins)
        || (lastRoots && json(parsed.data.oldRoots) !== json(lastRoots))
        || legacySkillManifestHash(parsed.data.sourceManifest) !== legacySkillManifestHash(last.sourceAfterManifest))
        return fail("CONFLICT", "Skill source root adoption does not continue its history.");
      legacySkillManifestHash(parsed.data.destinationManifest);
      lastPins = parsed.data.newPins;
      lastRoots = parsed.data.newRoots;
      adoptionHead = row.entry_sha256;
      adoptionIndex++;
    }
  }
  for (let i = 0; i < rows.length; i++) {
    applyAdoptions(i);
    const row = rows[i]!;
    if (!row.epoch || row.sequence !== i + 1 || row.previous_sha256 !== previous
      || row.entry_sha256 !== entryHash(row.sequence, row.operation_id, row.epoch, row.pins_json, row.plan_json, previous))
      fail("CONFLICT", "Skill source history chain is invalid.");
    const pins = parsePins(row.pins_json);
    if (lastPins && json(lastPins) !== json(pins)) fail("CONFLICT", "Skill source history root identities changed.");
    let raw: unknown;
    try { raw = JSON.parse(row.plan_json); } catch { return fail("CONFLICT", "Invalid Skill source history."); }
    let plan: Plan;
    if (typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "bridge") {
      const bridge = validateNativeLegacySkillSourceBridge(raw, bundleForDigest);
      if (i !== 0 || bridge.epoch !== row.epoch) fail("CONFLICT", "Bridge must be the exact source genesis.");
      plan = bridge.genesis;
    } else if (typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "remove") {
      plan = validateLegacySkillSourceRemovePlan(raw);
    } else {
      const parsed = z.object({ input: legacySkillSourceInstallInputSchema }).safeParse(raw);
      if (!parsed.success) return fail("CONFLICT", "Invalid Skill source history.");
      const digest = parsed.data.input.bundleSha256, bundle = bundleForDigest(digest);
      if (!bundle) return fail("NOT_AVAILABLE", "Historical Skill bundle is not independently available.");
      plan = validateLegacySkillSourceInstallPlan(raw, bundle, digest);
    }
    if (json(raw && typeof raw === "object" && "kind" in raw && raw.kind === "bridge" ? raw : plan) !== row.plan_json || plan.input.operationId !== row.operation_id
      || (last && (json(last.binding) !== json(plan.binding)
        || legacySkillManifestHash(last.sourceAfterManifest) !== legacySkillManifestHash(plan.sourceBeforeManifest))))
      fail("CONFLICT", "Skill source history transitions are inconsistent.");
    previous = row.entry_sha256;
    last = plan;
    lastPins = pins;
  }
  applyAdoptions(rows.length);
  if (adoptionIndex !== adoptions.length) fail("CONFLICT", "Skill source root adoptions are out of sequence.");
  return { head: previous, last, lastPins, lastRoots, adoptionHead };
}
function readHistory(db: DatabaseSync, host: LegacySkillSourceNativeAuthority) {
  verifyNativeLegacySkillSourceBridge(db, host);
  return validateNativeLegacySkillSourceHistory(db.prepare("SELECT * FROM legacy_skill_source_native_history ORDER BY sequence").all() as unknown as HistoryRow[],
    digest => host.bundleForDigest(digest), db.prepare("SELECT * FROM legacy_skill_source_native_adoption ORDER BY sequence").all() as unknown as LegacySkillSourceAdoptionRow[]);
}
/** Native approval and independently anchored SQL only: no fixture filesystem scan. */
export function verifyNativeLegacySkillSourceBridge(db: DatabaseSync, host: LegacySkillSourceNativeAuthority) {
  const row = db.prepare("SELECT * FROM legacy_skill_source_native_history WHERE sequence=1").get() as unknown as HistoryRow | undefined;
  const intent = pending(db);
  const raw = row ? JSON.parse(row.plan_json) : intent ? JSON.parse(intent.plan_json) : undefined;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_skill_native_history'").get()) {
    if (raw?.kind === "bridge") fail("CONFLICT", "Bridge original legacy journal is absent.");
    return undefined;
  }
  if (!raw || raw.kind !== "bridge") {
    if (db.prepare("SELECT 1 FROM legacy_skill_native_history LIMIT 1").get())
      fail("CONFLICT", "Legacy history lacks independently authorized bridge genesis.");
    return undefined;
  }
  const bridge = validateNativeLegacySkillSourceBridge(raw, digest => host.bundleForDigest(digest));
  const pins = parsePins((row ?? intent)!.pins_json);
  if (json(bridge.genesis.binding) !== json(host.binding) || !host.verifyBridge || host.verifyBridge(bridge, pins) !== true)
    fail("ACCESS_DENIED", "Independent existing Skill bridge approval is absent.");
  verifyNativeLegacySkillSourceBridgeSql(db, bridge);
  return bridge;
}
export function replayNativeLegacySkillSourceBridgeHistory(db: DatabaseSync, authority: LegacySkillSourceNativeAuthority | undefined, actor: Actor) {
  const host = authorize(db, authority, actor);
  const before = anchored(db, host);
  if (pending(db)) fail("RECOVERY_REQUIRED", "Pending source bridge fences legacy replay.", true);
  const bridge = verifyNativeLegacySkillSourceBridge(db, host);
  if (!bridge) fail("NOT_AVAILABLE", "Legacy replay requires authorized source bridge.");
  readHistory(db, host);
  tx(db, host, () => sameSnapshot(db, before));
  return bridge;
}
export function readNativeLegacySkillSourceHistory(db: DatabaseSync, authority: LegacySkillSourceNativeAuthority | undefined, actor: Actor,
  options?: { verifyDestination?: boolean }) {
  const host = authorize(db, authority, actor);
  const anchor = anchored(db, host);
  const history = readHistory(db, host);
  const intent = pending(db);
  if (options?.verifyDestination && intent)
    fail("RECOVERY_REQUIRED", "Cannot verify the completed destination while a Skill source intent is pending.", true);
  if (history.last && !intent) {
    const scan = scanNativeLegacySkillSourceAndTarget(db, () => host.assertOwner(), host.roots);
    if (json(history.last.binding) !== json(host.binding)
      || json(history.lastPins) !== json(scan.pins)
      || (history.lastRoots && json(history.lastRoots) !== json(host.roots))
      || legacySkillManifestHash(history.last.sourceAfterManifest) !== legacySkillManifestHash(scan.sourceManifest))
      fail("CONFLICT", "Current Skill source differs from its anchored history.");
    if (options?.verifyDestination && legacySkillManifestHash(history.last.destinationAfterManifest) !== legacySkillManifestHash(scan.destinationManifest))
      fail("CONFLICT", "Current Skill destination differs from the last installation.");
  }
  tx(db, host, () => sameSnapshot(db, anchor));
  return history;
}
function fingerprint(actor: Actor, binding: LegacySkillBinding, input: Input) {
  return hash(json({ actor, binding, input }));
}
function result(plan: Plan): Result {
  return { operationId: plan.input.operationId, sourceSha256: isRemove(plan) ? plan.input.sourceSha256 : plan.source.afterSha256,
    sourceManifestSha256: legacySkillManifestHash(plan.sourceAfterManifest),
    destinationSha256: isRemove(plan) ? null : hash(Buffer.from(plan.destinationAfterBase64, "base64")),
    destinationManifestSha256: legacySkillManifestHash(plan.destinationAfterManifest) };
}
function receipt(db: DatabaseSync, host: LegacySkillSourceNativeAuthority, operationId: string, fp: string) {
  const global = host.globalReceipt(db, operationId);
  const local = db.prepare("SELECT fingerprint,binding_json,result_json FROM legacy_skill_source_native_receipt WHERE operation_id=?").get(operationId) as { fingerprint: string; binding_json: string; result_json: string } | undefined;
  if (!global && !local) return null;
  if (!global || !local || global.fingerprint !== fp || local.fingerprint !== fp || local.binding_json !== json(host.binding))
    return fail("CONFLICT", "Skill source operation ID or receipt conflicts.");
  let value: Result;
  try { value = JSON.parse(local.result_json) as Result; } catch { return fail("CONFLICT", "Invalid Skill source receipt."); }
  if (value.operationId !== operationId || json(global.result) !== json(value))
    return fail("CONFLICT", "Global and local Skill source receipts disagree.");
  return value;
}
function pending(db: DatabaseSync): Row | undefined {
  return db.prepare("SELECT operation_id,fingerprint,epoch,plan_json,pins_json,integrity FROM legacy_skill_source_native_intent WHERE singleton=1").get() as Row | undefined;
}
function rowIntegrity(row: Omit<Row, "integrity">) { return hash(json(row)); }
function parsePending(row: Row, host: LegacySkillSourceNativeAuthority) {
  const { integrity, ...rest } = row;
  if (integrity !== rowIntegrity(rest) || row.epoch !== host.epoch) return fail("CONFLICT", "Skill source intent or owner epoch changed.");
  let raw: unknown;
  try { raw = JSON.parse(row.plan_json); }
  catch { return fail("CONFLICT", "Malformed Skill source intent."); }
  const pins = parsePins(row.pins_json);
  const plan = typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "remove"
    ? validateLegacySkillSourceRemovePlan(raw) : validateLegacySkillSourceInstallPlan(raw, host.bundle, host.bundleSha256);
  if (json(plan) !== row.plan_json || plan.input.operationId !== row.operation_id || json(plan.binding) !== json(host.binding))
    return fail("CONFLICT", "Skill source intent binding changed.");
  return { plan, pins };
}

type Step = { directory?: string; file?: string; bytes?: Buffer; removeFile?: string; removeDirectory?: string; manifest: LegacySkillManifest };
function steps(before: LegacySkillManifest, after: LegacySkillManifest, file: string, bytes: Buffer): Step[] {
  let manifest = [...before];
  const output: Step[] = [{ manifest }];
  for (const entry of after) {
    if (entry.kind === "directory" && !manifest.some(item => item.path === entry.path)) {
      manifest = [...manifest, entry].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      output.push({ directory: entry.path, manifest });
    }
  }
  const desired = after.find(item => item.path === file)!;
  const current = manifest.find(item => item.path === file);
  if (json(current) !== json(desired)) {
    manifest = [...manifest.filter(item => item.path !== file), desired].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    output.push({ file, bytes, manifest });
  }
  if (json(manifest) !== json(after)) fail("CONFLICT", "Skill source plan has unexpected filesystem effects.");
  return output;
}
function removalSteps(plan: LegacySkillSourceRemovePlan): Step[] {
  let manifest = plan.destinationBeforeManifest;
  const output: Step[] = [{ manifest }];
  if (plan.destinationBeforeBase64 !== null) {
    manifest = manifest.filter(item => item.path !== "pkm-skills/SKILL.md");
    output.push({ removeFile: "pkm-skills/SKILL.md", manifest });
    if (!plan.destinationAfterManifest.some(item => item.path === "pkm-skills")) {
      manifest = manifest.filter(item => item.path !== "pkm-skills");
      output.push({ removeDirectory: "pkm-skills", manifest });
    }
  }
  if (json(manifest) !== json(plan.destinationAfterManifest)) fail("CONFLICT", "Skill removal plan has unexpected filesystem effects.");
  return output;
}
function syncDir(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function inspectPlan(db: DatabaseSync, host: LegacySkillSourceNativeAuthority, plan: Plan, pins: Pins) {
  const scan = scanNativeLegacySkillSourceAndTarget(db, () => host.assertOwner(), host.roots);
  if (json(scan.pins) !== json(pins)) fail("CONFLICT", "Skill source root identity changed.");
  const source = isRemove(plan) ? [{ manifest: plan.sourceBeforeManifest }]
    : steps(plan.sourceBeforeManifest, plan.sourceAfterManifest, "System/PKM/PKM Skills.md", Buffer.from(plan.source.afterBase64, "base64"));
  const target = isRemove(plan) ? removalSteps(plan)
    : steps(plan.destinationBeforeManifest, plan.destinationAfterManifest, "pkm-skills/SKILL.md", Buffer.from(plan.destinationAfterBase64, "base64"));
  const sourceIndex = source.findIndex(step => json(step.manifest) === json(scan.sourceManifest));
  const targetIndex = target.findIndex(step => json(step.manifest) === json(scan.destinationManifest));
  if (sourceIndex < 0 || targetIndex < 0) fail("CONFLICT", "Unrecognized Skill source inventory or staging residue; manual recovery required.", true);
  return { source, target, sourceIndex, targetIndex };
}
function apply(db: DatabaseSync, host: LegacySkillSourceNativeAuthority, actor: Actor, plan: Plan, pins: Pins) {
  for (;;) {
    authorize(db, host, actor);
    const state = inspectPlan(db, host, plan, pins);
    const nextSource = state.source[state.sourceIndex + 1], nextTarget = state.target[state.targetIndex + 1];
    const step = nextSource ?? nextTarget;
    if (!step) return;
    const root = nextSource ? host.roots.source : host.roots.destination;
    host.assertOwner();
    if (step.directory) {
      const path = join(root, step.directory);
      mkdirSync(path, { mode: 0o700 });
      syncDir(join(path, ".."));
    } else if (step.removeFile) {
      unlinkSync(join(root, step.removeFile));
      syncDir(join(root, "pkm-skills"));
    } else if (step.removeDirectory) {
      rmdirSync(join(root, step.removeDirectory));
      syncDir(root);
    } else {
      const path = join(root, step.file!), directory = join(path, "..");
      const temporary = join(directory, `.pkm-skill-source-${plan.input.operationId}`);
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      try { writeFileSync(fd, step.bytes!); fsyncSync(fd); } finally { closeSync(fd); }
      host.assertOwner();
      renameSync(temporary, path);
      syncDir(directory);
    }
  }
}
function approved(host: LegacySkillSourceNativeAuthority, actor: Actor, plan: Plan, pins: Pins, recovery: boolean) {
  const decision = isRemove(plan) ? host.approveRemovePlan?.(actor, plan, pins, recovery) : host.approvePlan(actor, plan, pins, recovery);
  if (decision !== true) fail("ACCESS_DENIED", "Exact Skill source plan was not natively approved.");
}
function commit(db: DatabaseSync, host: LegacySkillSourceNativeAuthority, actor: Actor, row: Row, plan: Plan, pins: Pins) {
  authorize(db, host, actor);
  const state = inspectPlan(db, host, plan, pins);
  if (state.sourceIndex !== state.source.length - 1 || state.targetIndex !== state.target.length - 1)
    fail("CONFLICT", "Skill source after state is incomplete.", true);
  host.assertNoOtherPendingNative();
  const before = anchored(db, host), output = result(plan), history = readHistory(db, host);
  if (history.last && (json(history.last.binding) !== json(plan.binding)
    || json(history.lastPins) !== json(pins)
    || (history.lastRoots && json(history.lastRoots) !== json(host.roots))
    || legacySkillManifestHash(history.last.sourceAfterManifest) !== legacySkillManifestHash(plan.sourceBeforeManifest)))
    fail("CONFLICT", "Skill source intent does not continue its history.");
  tx(db, host, () => {
    sameSnapshot(db, before); host.assertNoOtherPendingSql(db);
    if (json(pending(db)) !== json(row) || receipt(db, host, row.operation_id, row.fingerprint))
      fail("CONFLICT", "Skill source intent changed before commit.");
    const sequence = db.prepare("SELECT COUNT(*) AS n FROM legacy_skill_source_native_history").get() as { n: number };
    const seq = sequence.n + 1, entry = entryHash(seq, row.operation_id, row.epoch, row.pins_json, row.plan_json, history.head);
    host.writeGlobalReceipt(db, row.operation_id, row.fingerprint, output);
    db.prepare("INSERT INTO legacy_skill_source_native_receipt VALUES(?,?,?,?)").run(row.operation_id, row.fingerprint, json(plan.binding), json(output));
    db.prepare("INSERT INTO legacy_skill_source_native_history VALUES(?,?,?,?,?,?,?)")
      .run(seq, row.operation_id, row.epoch, row.pins_json, row.plan_json, history.head, entry);
    db.prepare("DELETE FROM legacy_skill_source_native_intent WHERE singleton=1").run();
  });
  advance(db, host, before);
  return output;
}
export function executeNativeLegacySkillSource(db: DatabaseSync, authority: LegacySkillSourceNativeAuthority | undefined, actor: Actor, inputValue: unknown) {
  return executeSource(db, authority, actor, inputValue, false);
}
export function executeNativeLegacySkillSourceBridge(db: DatabaseSync, authority: LegacySkillSourceNativeAuthority | undefined,
  actor: Actor, inputValue: unknown, recovery = false) {
  const host = authorize(db, authority, actor);
  const input = legacySkillSourceBridgeInputSchema.parse(inputValue);
  if (actor.collaborationKind !== "human" || !host.approveBridge || !host.verifyBridge || !host.reconcileBridgeAnchor)
    return fail("NOT_AVAILABLE", "Exact independent native bridge authority is required.");
  const fp = hash(json({ actor, binding: host.binding, input }));
  let row = pending(db), plan: LegacySkillSourceBridgePlan, pins: Pins, committed = false;
  const existing = db.prepare("SELECT * FROM legacy_skill_source_native_history WHERE operation_id=?").get(input.operationId) as unknown as HistoryRow | undefined;
  if (row || existing) {
    const saved = row ?? existing!;
    plan = validateNativeLegacySkillSourceBridge(JSON.parse(saved.plan_json), digest => host.bundleForDigest(digest));
    pins = parsePins(saved.pins_json);
    committed = !!existing;
    if (saved.operation_id !== input.operationId || saved.epoch !== host.epoch || json(plan.input) !== json(input)
      || json(plan.actor) !== json(actor) || json(plan.genesis.binding) !== json(host.binding)
      || (row && (row.fingerprint !== fp || row.integrity !== rowIntegrity({
        operation_id: row.operation_id, fingerprint: row.fingerprint, epoch: row.epoch, plan_json: row.plan_json, pins_json: row.pins_json,
      }))))
      return fail("CONFLICT", "Bridge retry requires the identical request, actor and live epoch.", true);
    if (!recovery && !committed) return fail("RECOVERY_REQUIRED", "Bridge intent requires explicit native retry.", true);
  } else {
    if (recovery || db.prepare("SELECT 1 FROM legacy_skill_source_native_history LIMIT 1").get())
      return fail("CONFLICT", "Bridge can only admit untouched ordered source genesis.");
    const captured = captureBatch15SkillHistory(db, host.binding.workspaceId);
    const legacy = JSON.parse(json({ rows: captured.rows, locals: captured.locals, globals: captured.globals })) as LegacySkillSourceBridgePlan["legacy"];
    const scan = scanNativeLegacySkillSourceAndTarget(db, () => host.assertOwner(), host.roots);
    const { legacyHistorySha256: _legacyDigest, ...genesisInput } = input;
    const genesis = prepareLegacySkillSourceInstall(host.binding, genesisInput, scan.source, host.bundle, scan.sourceManifest, scan.destination, scan.destinationManifest);
    plan = validateNativeLegacySkillSourceBridge({ kind: "bridge", actor, roots: host.roots, epoch: host.epoch,
      input, legacy, genesis }, digest => host.bundleForDigest(digest));
    pins = scan.pins;
    const head = [...captured.heads.values()][0];
    if (!head)
      return fail("CONFLICT", "Bridge requires one workspace package binding.");
    const root = resolve(host.roots.source, ...head.admission.sourceRelative.split("/").map(() => ".."));
    if (join(root, head.admission.sourceRelative) !== host.roots.source
      || join(root, head.admission.destinationRelative) !== host.roots.destination)
      return fail("CONFLICT", "Bridge physical roots differ from original admission.");
  }
  verifyNativeLegacySkillSourceBridgeSql(db, plan);
  if (host.approveBridge(actor, plan, pins, recovery) !== true || host.verifyBridge(plan, pins) !== true)
    return fail("ACCESS_DENIED", "Exact native bridge approval was denied.");
  host.assertNoOtherPendingNative();
  if (recovery) {
    host.reconcileBridgeAnchor(snapshotHash(snapshot(db)), actor, { plan, pins, committed });
  }
  let before = anchored(db, host);
  if (committed) {
    readHistory(db, host);
    const replay = tx(db, host, () => { sameSnapshot(db, before); verifyNativeLegacySkillSourceBridgeSql(db, plan); return receipt(db, host, input.operationId, fp); });
    if (!replay) return fail("CONFLICT", "Bridge receipt is missing.");
    return replay;
  }
  host.assertNoOtherPendingNative();
  if (!row) {
    const partial = { operation_id: input.operationId, fingerprint: fp, epoch: host.epoch, plan_json: json(plan), pins_json: json(pins) };
    row = { ...partial, integrity: rowIntegrity(partial) };
    tx(db, host, () => {
      sameSnapshot(db, before); host.assertNoOtherPendingSql(db); verifyNativeLegacySkillSourceBridgeSql(db, plan);
      if (pending(db) || receipt(db, host, input.operationId, fp)) fail("CONFLICT", "Bridge admission changed.");
      db.prepare("INSERT INTO legacy_skill_source_native_intent VALUES(1,?,?,?,?,?,?)")
        .run(row!.operation_id, row!.fingerprint, row!.epoch, row!.plan_json, row!.pins_json, row!.integrity);
    });
    advance(db, host, before);
  }
  const scan = scanNativeLegacySkillSourceAndTarget(db, () => host.assertOwner(), host.roots);
  if (json(scan.pins) !== json(pins) || json(scan.sourceManifest) !== json(plan.genesis.sourceBeforeManifest)
    || json(scan.destinationManifest) !== json(plan.genesis.destinationBeforeManifest))
    return fail("CONFLICT", "Bridge approved physical inventory changed.", true);
  host.assertNoOtherPendingNative();
  before = anchored(db, host);
  const output = result(plan.genesis);
  tx(db, host, () => {
    sameSnapshot(db, before); host.assertNoOtherPendingSql(db); verifyNativeLegacySkillSourceBridgeSql(db, plan);
    if (json(pending(db)) !== json(row) || db.prepare("SELECT 1 FROM legacy_skill_source_native_history LIMIT 1").get())
      fail("CONFLICT", "Bridge source genesis changed.");
    host.writeGlobalReceipt(db, input.operationId, fp, output);
    db.prepare("INSERT INTO legacy_skill_source_native_receipt VALUES(?,?,?,?)").run(input.operationId, fp, json(host.binding), json(output));
    db.prepare("INSERT INTO legacy_skill_source_native_history VALUES(?,?,?,?,?,?,?)")
      .run(1, input.operationId, host.epoch, json(pins), json(plan), "0".repeat(64), entryHash(1, input.operationId, host.epoch, json(pins), json(plan), "0".repeat(64)));
    db.prepare("DELETE FROM legacy_skill_source_native_intent WHERE singleton=1").run();
  });
  advance(db, host, before);
  return output;
}
export function executeNativeLegacySkillSourceRemove(db: DatabaseSync, authority: LegacySkillSourceNativeAuthority | undefined, actor: Actor, inputValue: unknown) {
  return executeSource(db, authority, actor, inputValue, true);
}
function executeSource(db: DatabaseSync, authority: LegacySkillSourceNativeAuthority | undefined, actor: Actor, inputValue: unknown, remove: boolean) {
  const host = authorize(db, authority, actor), parsed = (remove ? legacySkillSourceRemoveInputSchema : legacySkillSourceInstallInputSchema).safeParse(inputValue);
  if (!parsed.success) return fail("INVALID_ARGUMENT", "Invalid Skill source request.");
  const input = parsed.data, fp = fingerprint(actor, host.binding, input);
  const anchor = anchored(db, host);
  const replay = tx(db, host, () => { sameSnapshot(db, anchor); return receipt(db, host, input.operationId, fp); });
  if (replay) {
    readNativeLegacySkillSourceHistory(db, host, actor, { verifyDestination: true });
    return replay;
  }
  host.assertNoOtherPendingNative();
  if (pending(db)) return fail("RECOVERY_REQUIRED", "Pending Skill source intent requires explicit recovery.", true);
  const history = readHistory(db, host);
  if (remove && !history.last) fail("CONFLICT", "Skill removal requires an anchored canonical source history.");
  const scan = scanNativeLegacySkillSourceAndTarget(db, () => host.assertOwner(), host.roots);
  if (history.last && (json(history.last.binding) !== json(host.binding)
    || json(history.lastPins) !== json(scan.pins)
    || (history.lastRoots && json(history.lastRoots) !== json(host.roots))
    || legacySkillManifestHash(history.last.sourceAfterManifest) !== legacySkillManifestHash(scan.sourceManifest)))
    fail("CONFLICT", "Current Skill source differs from its anchored history.");
  const plan = remove
    ? prepareLegacySkillSourceRemove(host.binding, input, scan.source, scan.sourceManifest, scan.destination, scan.destinationManifest)
    : prepareLegacySkillSourceInstall(host.binding, input, scan.source, host.bundle, scan.sourceManifest, scan.destination, scan.destinationManifest);
  if (isRemove(plan)) validateLegacySkillSourceRemovePlan(plan);
  else validateLegacySkillSourceInstallPlan(plan, host.bundle, host.bundleSha256);
  approved(host, actor, plan, scan.pins, false);
  const before = anchored(db, host);
  const partial = { operation_id: input.operationId, fingerprint: fp, epoch: host.epoch, plan_json: json(plan), pins_json: json(scan.pins) };
  const row = { ...partial, integrity: rowIntegrity(partial) };
  tx(db, host, () => {
    sameSnapshot(db, before); host.assertNoOtherPendingSql(db);
    if (pending(db) || receipt(db, host, input.operationId, fp)) fail("CONFLICT", "Skill source admission changed.");
    db.prepare("INSERT INTO legacy_skill_source_native_intent VALUES(1,?,?,?,?,?,?)")
      .run(row.operation_id, row.fingerprint, row.epoch, row.plan_json, row.pins_json, row.integrity);
  });
  advance(db, host, before);
  host.assertNoOtherPendingNative();
  anchored(db, host);
  try { apply(db, host, actor, plan, scan.pins); return commit(db, host, actor, row, plan, scan.pins); }
  catch (error) { if (error instanceof CoreError) throw error; return fail("RECOVERY_REQUIRED", "Skill source effects are unknown; explicit recovery required.", true); }
}
export function inspectNativeLegacySkillSource(db: DatabaseSync, authority: LegacySkillSourceNativeAuthority | undefined, actor: Actor) {
  const host = authorize(db, authority, actor), anchor = anchored(db, host);
  const row = tx(db, host, () => { sameSnapshot(db, anchor); return pending(db); });
  if (!row) {
    readNativeLegacySkillSourceHistory(db, host, actor);
    return null;
  }
  const { plan, pins } = parsePending(row, host);
  const history = readHistory(db, host);
  if (history.last && (json(history.last.binding) !== json(plan.binding)
    || json(history.lastPins) !== json(pins)
    || (history.lastRoots && json(history.lastRoots) !== json(host.roots))
    || legacySkillManifestHash(history.last.sourceAfterManifest) !== legacySkillManifestHash(plan.sourceBeforeManifest)))
    fail("CONFLICT", "Skill source intent does not continue its history.");
  const state = inspectPlan(db, host, plan, pins);
  return { operationId: row.operation_id, sourceStep: state.sourceIndex, sourceSteps: state.source.length - 1,
    destinationStep: state.targetIndex, destinationSteps: state.target.length - 1 };
}

/**
 * Adopts an already copied, completed history. Native approval must independently
 * verify old/new logical paths and any distinct physical staging paths,
 * identities and complete inventories, and the
 * anchor transition; it must not rely on the request or SQLite as authority.
 * No adoption is permitted while a source intent is pending.
 */
export function adoptNativeLegacySkillSourceRoots(db: DatabaseSync, authority: LegacySkillSourceNativeAuthority | undefined,
  actor: Actor, requestValue: unknown) {
  const host = authorize(db, authority, actor), parsed = adoptionRequestSchema.safeParse(requestValue);
  if (!parsed.success) return fail("INVALID_ARGUMENT", "Invalid Skill source root adoption.");
  const request = parsed.data;
  if (!host.approveAdoption || !host.reconcileAdoptionAnchor)
    return fail("NOT_AVAILABLE", "Independent Skill source root adoption authority is required.");
  const physicalRoots = request.physicalRoots ?? request.newRoots;
  if (json(request.binding) !== json(host.binding) || json(physicalRoots) !== json(host.roots)
    || json(request.oldRoots) === json(request.newRoots) || json(request.oldPins) === json(request.newPins))
    fail("CONFLICT", "Skill source root adoption identity differs.");
  if (pending(db)) fail("RECOVERY_REQUIRED", "Pending Skill source intent cannot be adopted.", true);
  host.assertNoOtherPendingNative();
  const history = readHistory(db, host);
  const rows = db.prepare("SELECT * FROM legacy_skill_source_native_adoption ORDER BY sequence").all() as unknown as LegacySkillSourceAdoptionRow[];
  const last = rows.at(-1), replay = last?.request_json === json(request);
  if (host.approveAdoption(actor, request) !== true) fail("ACCESS_DENIED", "Exact Skill source root adoption was not approved.");
  const scan = scanNativeLegacySkillSourceAndTarget(db, () => host.assertOwner(), physicalRoots);
  if (json(scan.pins) !== json(request.newPins)
    || json(scan.sourceManifest) !== json(request.sourceManifest)
    || json(scan.destinationManifest) !== json(request.destinationManifest))
    fail("CONFLICT", "Adopted Skill roots do not match the exact approved inventories.");
  if (!history.last || history.head !== request.historyHead || json(history.last.binding) !== json(request.binding)
    || legacySkillManifestHash(history.last.sourceAfterManifest) !== legacySkillManifestHash(request.sourceManifest))
    fail("CONFLICT", "Adoption does not match the completed source history.");
  if (replay) {
    if (json(history.lastPins) !== json(request.newPins) || json(history.lastRoots) !== json(request.newRoots))
      fail("CONFLICT", "Adopted Skill source lineage changed.");
  } else if (json(history.lastPins) !== json(request.oldPins)
    || (history.lastRoots && json(history.lastRoots) !== json(request.oldRoots))) {
    fail("CONFLICT", "Adoption does not continue the current root lineage.");
  }
  if (replay) {
    host.reconcileAdoptionAnchor(snapshotHash(snapshot(db)), actor, request);
    const anchor = anchored(db, host);
    tx(db, host, () => { sameSnapshot(db, anchor); host.assertNoOtherPendingSql(db); if (pending(db)) fail("CONFLICT", "Skill source intent appeared during adoption."); });
    return { historyHead: history.head, adoptionHead: history.adoptionHead };
  }
  const before = anchored(db, host);
  if (request.snapshotDigest !== before) fail("CONFLICT", "Skill source adoption snapshot is stale.");
  const sequence = rows.length + 1, historySequence = db.prepare("SELECT COUNT(*) AS n FROM legacy_skill_source_native_history").get() as { n: number };
  const requestJson = json(request), entry = adoptionHash(sequence, historySequence.n, requestJson, history.adoptionHead);
  tx(db, host, () => {
    sameSnapshot(db, before); host.assertNoOtherPendingSql(db);
    if (pending(db)) fail("CONFLICT", "Skill source intent appeared during adoption.");
    db.prepare("INSERT INTO legacy_skill_source_native_adoption VALUES(?,?,?,?,?)")
      .run(sequence, historySequence.n, requestJson, history.adoptionHead, entry);
  });
  advance(db, host, before);
  return { historyHead: history.head, adoptionHead: entry };
}
export function recoverNativeLegacySkillSource(db: DatabaseSync, authority: LegacySkillSourceNativeAuthority | undefined, actor: Actor, inputValue: unknown) {
  return recoverSource(db, authority, actor, inputValue, false);
}
export function recoverNativeLegacySkillSourceRemove(db: DatabaseSync, authority: LegacySkillSourceNativeAuthority | undefined, actor: Actor, inputValue: unknown) {
  return recoverSource(db, authority, actor, inputValue, true);
}
function recoverSource(db: DatabaseSync, authority: LegacySkillSourceNativeAuthority | undefined, actor: Actor, inputValue: unknown, remove: boolean) {
  const host = authorize(db, authority, actor), parsed = (remove ? legacySkillSourceRemoveInputSchema : legacySkillSourceInstallInputSchema).safeParse(inputValue);
  if (!parsed.success) return fail("INVALID_ARGUMENT", "Invalid Skill source recovery request.");
  const input = parsed.data, fp = fingerprint(actor, host.binding, input);
  const candidate = pending(db);
  let candidatePlan: Plan, candidatePins: Pins;
  if (candidate) {
    if (candidate.operation_id !== input.operationId || candidate.fingerprint !== fp)
      return fail("CONFLICT", "Recovery must match the pending Skill source request.");
    ({ plan: candidatePlan, pins: candidatePins } = parsePending(candidate, host));
  } else {
    const historical = db.prepare("SELECT * FROM legacy_skill_source_native_history WHERE operation_id=?").get(input.operationId) as HistoryRow | undefined;
    if (!historical || historical.epoch !== host.epoch) return fail("CONFLICT", "Recovery has no matching same-epoch Skill source operation.");
    const history = readHistory(db, host);
    const lastRow = db.prepare("SELECT sequence FROM legacy_skill_source_native_history ORDER BY sequence DESC LIMIT 1").get() as { sequence: number } | undefined;
    if (historical.sequence !== lastRow?.sequence || !history.lastPins
      || (history.lastRoots && json(history.lastRoots) !== json(host.roots)))
      return fail("CONFLICT", "Committed Skill source recovery is not the current root and history head.");
    let raw: unknown;
    try { raw = JSON.parse(historical.plan_json); }
    catch { return fail("CONFLICT", "Malformed committed Skill source history."); }
    candidatePins = history.lastPins;
    candidatePlan = remove ? validateLegacySkillSourceRemovePlan(raw)
      : validateLegacySkillSourceInstallPlan(raw, host.bundle, host.bundleSha256);
  }
  if (isRemove(candidatePlan) !== remove || json(candidatePlan.binding) !== json(host.binding) || json(candidatePlan.input) !== json(input))
    fail("CONFLICT", "Skill source recovery request differs.");
  const observed = inspectPlan(db, host, candidatePlan, candidatePins);
  if (!candidate && (observed.sourceIndex !== observed.source.length - 1 || observed.targetIndex !== observed.target.length - 1))
    fail("CONFLICT", "Committed Skill source after state differs.");
  approved(host, actor, candidatePlan, candidatePins, true);
  if (isRemove(candidatePlan)) {
    const reconcile = host.reconcileRemoveAnchor;
    if (!reconcile) return fail("NOT_AVAILABLE", "Native Skill removal reconciliation authority is required.");
    reconcile(snapshotHash(snapshot(db)), actor, { plan: candidatePlan, pins: candidatePins, committed: !candidate });
  } else host.reconcileAnchor(snapshotHash(snapshot(db)), actor, { plan: candidatePlan, pins: candidatePins, committed: !candidate });
  const anchor = anchored(db, host);
  const existing = tx(db, host, () => { sameSnapshot(db, anchor); return { row: pending(db), replay: receipt(db, host, input.operationId, fp) }; });
  if (existing.replay) return existing.replay;
  const row = existing.row;
  if (!row || row.operation_id !== input.operationId || row.fingerprint !== fp)
    return fail("CONFLICT", "Recovery must match the pending Skill source request.");
  const { plan, pins } = parsePending(row, host);
  if (json(plan.input) !== json(input)) fail("CONFLICT", "Skill source recovery request differs.");
  const history = readHistory(db, host);
  if (history.last && (json(history.last.binding) !== json(plan.binding)
    || json(history.lastPins) !== json(pins)
    || (history.lastRoots && json(history.lastRoots) !== json(host.roots))
    || legacySkillManifestHash(history.last.sourceAfterManifest) !== legacySkillManifestHash(plan.sourceBeforeManifest)))
    fail("CONFLICT", "Skill source recovery does not continue its history.");
  host.assertNoOtherPendingNative();
  inspectPlan(db, host, plan, pins);
  approved(host, actor, plan, pins, true);
  try { apply(db, host, actor, plan, pins); return commit(db, host, actor, row, plan, pins); }
  catch (error) { if (error instanceof CoreError) throw error; return fail("RECOVERY_REQUIRED", "Skill source recovery effects are unknown.", true); }
}
