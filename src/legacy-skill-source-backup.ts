import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError, type Actor } from "./contracts.js";
import { resourcePath } from "./document-path.js";
import { inspectSkillSourceActivity, verifyGlobalSkillSourceReceipts } from "./host-composition-legacy-skill-source.js";
import { legacySkillSourceOperation, legacySkillSourceRemoveOperation, legacySkillSourceBridgeOperation } from "./host-composition-legacy-skill-source-contracts.js";
import { legacySkillBindingSchema, legacySkillManifestHash, legacySkillManifestSchema } from "./legacy-skill-lifecycle.js";
import { scanNativeLegacySkillSourceAndTarget } from "./legacy-skill-lifecycle-native.js";
import {
  captureNativeLegacySkillSourceSnapshotDigest, readNativeLegacySkillSourceHistory,
  adoptNativeLegacySkillSourceRoots,
  validateNativeLegacySkillSourceHistory, validateNativeLegacySkillSourceJournalSchema,
  type LegacySkillSourceAdoptionRow, type LegacySkillSourceNativeAuthority, type LegacySkillSourceRootAdoption,
  verifyNativeLegacySkillSourceBridge, verifyNativeLegacySkillSourceBridgeSql,
} from "./legacy-skill-source-native.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const json = JSON.stringify;
const fail = (message: string): never => { throw new CoreError("RECOVERY_AUTHORITY_REQUIRED", message, "unknown"); };
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const pinSchema = z.strictObject({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) });
const pathSchema = z.string().refine(path => isAbsolute(path) && resolve(path) === path);
const requestSchema = z.strictObject({
  schema: z.literal("pkm.native-skill-source-backup/v1"),
  actor: z.strictObject({ id: z.string().min(1), canWrite: z.literal(true), collaborationKind: z.literal("human") }),
  workspaceId: z.string().uuid(), workspaceRoot: pathSchema, destination: pathSchema,
  binding: legacySkillBindingSchema,
  roots: z.strictObject({ source: pathSchema, destination: pathSchema }),
  pins: z.strictObject({ source: pinSchema, destination: pinSchema }),
  sourceManifest: legacySkillManifestSchema, destinationManifest: legacySkillManifestSchema,
  historyHead: digestSchema, adoptionHead: digestSchema, snapshotDigest: digestSchema, epoch: z.string().min(1),
});
const backupPinSchema = z.strictObject({ request: requestSchema });
const historyRowSchema = z.strictObject({
  sequence: z.number().int().positive(), operation_id: z.string().uuid(), epoch: z.string().min(1),
  pins_json: z.string(), plan_json: z.string(), previous_sha256: digestSchema, entry_sha256: digestSchema,
});
const adoptionRowSchema = z.strictObject({
  sequence: z.number().int().positive(), history_sequence: z.number().int().positive(),
  request_json: z.string(), previous_sha256: digestSchema, entry_sha256: digestSchema,
});
export type NativeSkillSourceBackupRequest = z.infer<typeof requestSchema>;
export type SkillSourceBackupPin = z.infer<typeof backupPinSchema>;
export interface NativeSkillSourceRestoreRequest {
  schema: "pkm.native-skill-source-restore/v1";
  phase: "prepare" | "publish";
  backup: SkillSourceBackupPin;
  backupRoot: string;
  backupRootPin: { dev: string; ino: string };
  manifestSha256: string;
  destination: string;
  destinationParentPin: { dev: string; ino: string };
  stage: string | null;
  stagePin: { dev: string; ino: string } | null;
  adoption: LegacySkillSourceRootAdoption | null;
  adoptedSnapshotDigest: string | null;
  adoptedHead: string | null;
}

export interface NativeSkillSourceBackupAuthority {
  scope: "exclusive-native-disposable-fixture";
  actor: Actor;
  /** The native host must independently admit this exact workspace and exclude all external writers. */
  authorityForWorkspace(root: string, database: DatabaseSync): LegacySkillSourceNativeAuthority | undefined;
  /** Durable external approval, including epoch, snapshot anchor, old root admission and historic bundle bytes. */
  authorizeBackup(request: Readonly<NativeSkillSourceBackupRequest>): {
    requestSha256: string; epoch: string; expiresAt: number;
  } | null;
  /** Exact independent approval of original admission, copied snapshot and physical-stage/logical-final publication. */
  authorizeRestore?(request: Readonly<NativeSkillSourceRestoreRequest>): {
    requestSha256: string; epoch: string; expiresAt: number;
  } | null;
}

export function approveSkillSourceRestore(request: NativeSkillSourceRestoreRequest, policy: NativeSkillSourceBackupAuthority) {
  const decision = policy.authorizeRestore?.(Object.freeze(structuredClone(request)));
  if (!decision || decision.requestSha256 !== hash(json(request)) || decision.epoch !== request.backup.request.epoch
    || !Number.isSafeInteger(decision.expiresAt) || decision.expiresAt <= Date.now())
    fail("Canonical Skill source exact native restore/publication approval is absent, stale, or expired.");
}

export function skillSourceRootsAt(pin: SkillSourceBackupPin, root: string) {
  return {
    source: join(root, relative(pin.request.workspaceRoot, pin.request.roots.source)),
    destination: join(root, relative(pin.request.workspaceRoot, pin.request.roots.destination)),
  };
}

export function parseSkillSourceBackupPin(value: unknown, workspaceId: string): SkillSourceBackupPin {
  const parsed = backupPinSchema.safeParse(value);
  if (!parsed.success || parsed.data.request.workspaceId !== workspaceId
    || parsed.data.request.binding.workspaceId !== workspaceId
    || parsed.data.request.binding.actorId !== parsed.data.request.actor.id)
    return fail("Invalid canonical Skill source backup pin.");
  const pin = parsed.data;
  for (const root of Object.values(pin.request.roots)) {
    const local = relative(pin.request.workspaceRoot, root);
    if (!resourcePath.safeParse(local).success || !local.startsWith("packages/")
      || join(pin.request.workspaceRoot, local) !== root)
      return fail("Skill source backup roots are not workspace package fixtures.");
  }
  legacySkillManifestHash(pin.request.sourceManifest);
  legacySkillManifestHash(pin.request.destinationManifest);
  return pin;
}

function nativeAuthority(policy: NativeSkillSourceBackupAuthority | undefined, root: string, db: DatabaseSync) {
  if (!policy || policy.scope !== "exclusive-native-disposable-fixture" || policy.actor.canWrite !== true
    || policy.actor.collaborationKind !== "human" || typeof policy.authorityForWorkspace !== "function"
    || typeof policy.authorizeBackup !== "function")
    return fail("Canonical Skill source backup requires independent native disposable fixture authority.");
  const host = policy.authorityForWorkspace(root, db);
  if (!host || host.binding.actorId !== policy.actor.id || !host.authorize(policy.actor, host.binding))
    return fail("Canonical Skill source native workspace admission was denied.");
  host.assertOwner();
  verifyNativeLegacySkillSourceBridge(db, host);
  return { policy, host };
}

export function approveSkillSourceBackup(pin: SkillSourceBackupPin, policy: NativeSkillSourceBackupAuthority) {
  const decision = policy.authorizeBackup(Object.freeze(structuredClone(pin.request)));
  if (!decision || decision.requestSha256 !== hash(json(pin.request)) || decision.epoch !== pin.request.epoch
    || !Number.isSafeInteger(decision.expiresAt) || decision.expiresAt <= Date.now())
    fail("Canonical Skill source external snapshot approval is absent, stale, or expired.");
}

function verifyReceipts(db: DatabaseSync, pin: SkillSourceBackupPin, expectedSnapshot = pin.request.snapshotDigest) {
  if (!db.isTransaction) fail("Skill source exact receipt validation requires a transaction.");
  validateNativeLegacySkillSourceJournalSchema(db);
  const rows = db.prepare("SELECT * FROM legacy_skill_source_native_history ORDER BY sequence").all();
  const locals = db.prepare("SELECT * FROM legacy_skill_source_native_receipt ORDER BY operation_id").all();
  const globals = db.prepare("SELECT * FROM receipts WHERE operation IN (?,?,?) ORDER BY operation_id")
    .all(legacySkillSourceOperation, legacySkillSourceRemoveOperation, legacySkillSourceBridgeOperation);
  const genesis = rows[0] ? JSON.parse(String(rows[0].plan_json)) : undefined;
  if (genesis?.kind === "bridge") verifyNativeLegacySkillSourceBridgeSql(db, genesis);
  if (rows.length !== locals.length || rows.length !== globals.length
    || db.prepare("SELECT 1 FROM legacy_skill_source_native_intent LIMIT 1").get()
    || (db.prepare("SELECT 1 FROM legacy_skill_native_history LIMIT 1").get() && genesis?.kind !== "bridge")
    || db.prepare("SELECT 1 FROM legacy_skill_native_intent LIMIT 1").get())
    fail("Pending or mixed canonical and projection Skill history cannot be backed up.");
  verifyGlobalSkillSourceReceipts(db, pin.request.workspaceId, pin.request.actor);
  for (const row of rows) {
    const raw = JSON.parse(String(row.plan_json)), plan = raw.kind === "bridge" ? raw.genesis : raw;
    const local = locals.find(value => value.operation_id === row.operation_id);
    const fingerprint = hash(json({ actor: pin.request.actor, binding: plan.binding, input: raw.kind === "bridge" ? raw.input : plan.input }));
    if (!local || json(plan.binding) !== json(pin.request.binding) || local.fingerprint !== fingerprint)
      fail("Canonical Skill source receipt authenticated actor fingerprint or exact binding changed.");
  }
  const snapshotDigest = hash(json({
    intents: db.prepare("SELECT * FROM legacy_skill_source_native_intent ORDER BY singleton").all(),
    receipts: db.prepare("SELECT * FROM legacy_skill_source_native_receipt ORDER BY operation_id").all(),
    history: rows,
    adoptions: db.prepare("SELECT * FROM legacy_skill_source_native_adoption ORDER BY sequence").all(),
  }));
  if (snapshotDigest !== expectedSnapshot)
    fail("Canonical Skill source snapshot changed.");
}

export function captureSkillSourceBackup(db: DatabaseSync, workspaceRoot: string, workspaceId: string,
  destination: string, policy?: NativeSkillSourceBackupAuthority): SkillSourceBackupPin | undefined {
  if (!inspectSkillSourceActivity(db).active) return undefined;
  const admitted = nativeAuthority(policy, workspaceRoot, db);
  const history = readNativeLegacySkillSourceHistory(db, admitted.host, admitted.policy.actor, { verifyDestination: true });
  if (!history.last || !history.lastPins) return fail("Canonical Skill source has no completed installation.");
  const scan = scanNativeLegacySkillSourceAndTarget(db, () => admitted.host.assertOwner(), admitted.host.roots);
  const pin = parseSkillSourceBackupPin({ request: {
    schema: "pkm.native-skill-source-backup/v1", actor: admitted.policy.actor, workspaceId, workspaceRoot, destination,
    binding: admitted.host.binding, roots: admitted.host.roots, pins: scan.pins,
    sourceManifest: scan.sourceManifest, destinationManifest: scan.destinationManifest,
    historyHead: history.head, adoptionHead: history.adoptionHead,
    snapshotDigest: captureNativeLegacySkillSourceSnapshotDigest(db), epoch: admitted.host.epoch,
  } }, workspaceId);
  approveSkillSourceBackup(pin, admitted.policy);
  db.exec("BEGIN IMMEDIATE");
  try { verifyReceipts(db, pin); db.exec("COMMIT"); }
  catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  return pin;
}

export function verifySkillSourceBackup(db: DatabaseSync, root: string, pin: SkillSourceBackupPin,
  policy: NativeSkillSourceBackupAuthority) {
  const admitted = nativeAuthority(policy, pin.request.workspaceRoot, db);
  if (json(admitted.host.binding) !== json(pin.request.binding) || json(admitted.host.roots) !== json(pin.request.roots)
    || admitted.host.epoch !== pin.request.epoch)
    fail("Canonical Skill source backup native admission changed.");
  admitted.host.checkAnchor(pin.request.snapshotDigest);
  approveSkillSourceBackup(pin, policy);
  const rows = z.array(historyRowSchema).parse(db.prepare("SELECT * FROM legacy_skill_source_native_history ORDER BY sequence").all());
  const adoptions: LegacySkillSourceAdoptionRow[] = z.array(adoptionRowSchema)
    .parse(db.prepare("SELECT * FROM legacy_skill_source_native_adoption ORDER BY sequence").all());
  const history = validateNativeLegacySkillSourceHistory(
    rows, digest => admitted.host.bundleForDigest(digest), adoptions);
  const copiedRoots = skillSourceRootsAt(pin, root);
  const scan = scanNativeLegacySkillSourceAndTarget(db, () => admitted.host.assertOwner(), copiedRoots);
  if (!history.last || json(history.last.binding) !== json(pin.request.binding)
    || json(history.last.sourceAfterManifest) !== json(pin.request.sourceManifest)
    || json(history.last.destinationAfterManifest) !== json(pin.request.destinationManifest)
    || history.head !== pin.request.historyHead || history.adoptionHead !== pin.request.adoptionHead
    || json(history.lastPins) !== json(pin.request.pins)
    || history.lastRoots && json(history.lastRoots) !== json(pin.request.roots)
    || json(scan.sourceManifest) !== json(pin.request.sourceManifest)
    || json(scan.destinationManifest) !== json(pin.request.destinationManifest))
    fail("Canonical Skill source backup inventories or immutable history differ from native approval.");
  db.exec("BEGIN");
  try { verifyReceipts(db, pin); db.exec("COMMIT"); }
  catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
}

export function prepareSkillSourceAdoption(db: DatabaseSync, stage: string, destination: string,
  pin: SkillSourceBackupPin, policy: NativeSkillSourceBackupAuthority): LegacySkillSourceRootAdoption {
  const admitted = nativeAuthority(policy, stage, db);
  const physicalRoots = skillSourceRootsAt(pin, stage);
  if (json(admitted.host.roots) !== json(physicalRoots) || json(admitted.host.binding) !== json(pin.request.binding)
    || !admitted.host.approveAdoption || !admitted.host.reconcileAdoptionAnchor)
    fail("Canonical Skill source stage requires exact native physical-root admission and adoption callbacks.");
  admitted.host.checkAnchor(pin.request.snapshotDigest);
  const scan = scanNativeLegacySkillSourceAndTarget(db, () => admitted.host.assertOwner(), physicalRoots);
  if (json(scan.sourceManifest) !== json(pin.request.sourceManifest)
    || json(scan.destinationManifest) !== json(pin.request.destinationManifest))
    fail("Canonical Skill source copied inventories differ before root adoption.");
  const history = validateNativeLegacySkillSourceHistory(
    z.array(historyRowSchema).parse(db.prepare("SELECT * FROM legacy_skill_source_native_history ORDER BY sequence").all()),
    digest => admitted.host.bundleForDigest(digest),
    z.array(adoptionRowSchema).parse(db.prepare("SELECT * FROM legacy_skill_source_native_adoption ORDER BY sequence").all()));
  if (history.head !== pin.request.historyHead || history.adoptionHead !== pin.request.adoptionHead
    || json(history.lastPins) !== json(pin.request.pins)
    || history.lastRoots && json(history.lastRoots) !== json(pin.request.roots))
    fail("Canonical Skill source stage does not continue the independently approved old root lineage.");
  db.exec("BEGIN");
  try { verifyReceipts(db, pin); db.exec("COMMIT"); }
  catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  return {
    oldRoots: pin.request.roots, newRoots: skillSourceRootsAt(pin, destination),
    oldPins: pin.request.pins, newPins: scan.pins, physicalRoots,
    binding: pin.request.binding, historyHead: pin.request.historyHead,
    snapshotDigest: pin.request.snapshotDigest,
    sourceManifest: pin.request.sourceManifest, destinationManifest: pin.request.destinationManifest,
  };
}

export function adoptSkillSourceBackup(db: DatabaseSync, stage: string, request: LegacySkillSourceRootAdoption,
  policy: NativeSkillSourceBackupAuthority) {
  const admitted = nativeAuthority(policy, stage, db);
  const result = adoptNativeLegacySkillSourceRoots(db, admitted.host, policy.actor, request);
  return { snapshotDigest: captureNativeLegacySkillSourceSnapshotDigest(db), adoptionHead: result.adoptionHead };
}

export function verifyAdoptedSkillSourceBackup(db: DatabaseSync, stage: string, pin: SkillSourceBackupPin,
  request: LegacySkillSourceRootAdoption, snapshotDigest: string, adoptionHead: string, policy: NativeSkillSourceBackupAuthority) {
  const admitted = nativeAuthority(policy, stage, db);
  admitted.host.checkAnchor(snapshotDigest);
  const history = validateNativeLegacySkillSourceHistory(
    z.array(historyRowSchema).parse(db.prepare("SELECT * FROM legacy_skill_source_native_history ORDER BY sequence").all()),
    digest => admitted.host.bundleForDigest(digest),
    z.array(adoptionRowSchema).parse(db.prepare("SELECT * FROM legacy_skill_source_native_adoption ORDER BY sequence").all()));
  const scan = scanNativeLegacySkillSourceAndTarget(db, () => admitted.host.assertOwner(), request.physicalRoots ?? request.newRoots);
  const row = db.prepare("SELECT request_json FROM legacy_skill_source_native_adoption ORDER BY sequence DESC LIMIT 1").get();
  if (!history.last || json(history.last.binding) !== json(pin.request.binding)
    || json(history.last.sourceAfterManifest) !== json(request.sourceManifest)
    || json(history.last.destinationAfterManifest) !== json(request.destinationManifest)
    || history.head !== pin.request.historyHead || history.adoptionHead !== adoptionHead
    || json(history.lastRoots) !== json(request.newRoots) || json(history.lastPins) !== json(request.newPins)
    || row?.request_json !== json(request) || json(scan.pins) !== json(request.newPins)
    || json(scan.sourceManifest) !== json(request.sourceManifest) || json(scan.destinationManifest) !== json(request.destinationManifest))
    fail("Canonical Skill source adopted stage lineage, pins or full inventories changed.");
  db.exec("BEGIN");
  try { verifyReceipts(db, pin, snapshotDigest); db.exec("COMMIT"); }
  catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
}

export function verifyPublishedSkillSourceBackup(db: DatabaseSync, root: string, pin: SkillSourceBackupPin,
  request: LegacySkillSourceRootAdoption, snapshotDigest: string, adoptionHead: string, policy: NativeSkillSourceBackupAuthority) {
  const admitted = nativeAuthority(policy, root, db);
  if (json(admitted.host.roots) !== json(request.newRoots) || json(admitted.host.binding) !== json(pin.request.binding))
    fail("Published canonical Skill source lacks exact native final-root admission.");
  const history = readNativeLegacySkillSourceHistory(db, admitted.host, policy.actor, { verifyDestination: true });
  if (history.head !== pin.request.historyHead || history.adoptionHead !== adoptionHead
    || json(history.lastRoots) !== json(request.newRoots) || json(history.lastPins) !== json(request.newPins))
    fail("Published canonical Skill source adoption lineage changed.");
  db.exec("BEGIN");
  try { verifyReceipts(db, pin, snapshotDigest); db.exec("COMMIT"); }
  catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
}
