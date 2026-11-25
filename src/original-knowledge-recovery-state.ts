import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import {
  originalRecoveryDigest as digest, originalRecoverySourcePayloadSchema, originalRecoverySourceResultSchema,
  originalRecoveryRepairPayloadSchema, originalRecoveryRepairResultSchema, originalRecoverySignedSessionSchema,
  originalRecoveryPhase1Methods, parseOriginalRecoveryPhase1Payload,
} from "./original-knowledge-recovery-contracts.js";
import { readOriginalMcpJournal } from "./original-mcp-root-custody.js";
import { assertOriginalRecoveryPhase1Successor, type OriginalRecoveryPhase1RepairPlan } from "./original-knowledge-recovery-guard.js";

export const ORIGINAL_RECOVERY_PHASE1_DDL = `
CREATE TABLE original_native_recovery_intents(singleton INTEGER PRIMARY KEY CHECK(singleton=1),operation_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,digest TEXT NOT NULL) STRICT;
CREATE TABLE original_native_recovery_commits(sequence INTEGER PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,workspace_id TEXT NOT NULL,payload TEXT NOT NULL,predecessor_sha256 TEXT NOT NULL,digest TEXT NOT NULL) STRICT;
CREATE TRIGGER original_native_recovery_commits_no_update BEFORE UPDATE ON original_native_recovery_commits BEGIN SELECT RAISE(ABORT,'native recovery commits immutable'); END;
CREATE TRIGGER original_native_recovery_commits_no_delete BEFORE DELETE ON original_native_recovery_commits BEGIN SELECT RAISE(ABORT,'native recovery commits immutable'); END;
`;
export const originalRecoveryProvenanceSchema = z.strictObject({
  session: originalRecoverySignedSessionSchema,
  sourcePayload: originalRecoverySourcePayloadSchema, sourceResult: originalRecoverySourceResultSchema,
  repairPayload: originalRecoveryRepairPayloadSchema, repairDecision: originalRecoveryRepairResultSchema,
});
export type OriginalRecoveryProvenance = z.infer<typeof originalRecoveryProvenanceSchema>;
export interface OriginalRecoveryWorkerAdmission {
  plan: OriginalRecoveryPhase1RepairPlan;
  provenance: OriginalRecoveryProvenance;
  custodyRow: Record<string, unknown>;
  control: SharedArrayBuffer;
  actor: { id: "mcp:external"; canWrite: true };
}
export function hasOriginalRecoveryState(db: DatabaseSync) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name GLOB 'original_native_recovery_*'").get();
}
const fail = (message: string): never => { throw new CoreError("RECOVERY_REQUIRED", message, "unknown"); };
export function originalRecoveryIndexRow(db: DatabaseSync, id: string) {
  const row = db.prepare("SELECT id,title,revision,deleted,sha256,path,area FROM documents WHERE id=?").get(id);
  if (!row) fail("Recovery requires its retained canonical index row; no rescan/adoption was performed.");
  return { ...row! };
}
export function originalRecoveryRegistrationDigest(planSha256: string, inventorySha256: string,
  custodyRow: Record<string, unknown>, indexRow: Record<string, unknown>) {
  return digest({ schema: "pkm.original-recovery-registration/v1", planSha256, inventorySha256, custodyRow, indexRow });
}
export function originalRecoveryPredecessor(db: DatabaseSync, root: string) {
  const journal = readOriginalMcpJournal(root);
  if (!journal) fail("Recovery requires its exact Original custody.");
  return hasOriginalRecoveryState(db)
    ? String(db.prepare("SELECT digest FROM original_native_recovery_commits ORDER BY sequence DESC LIMIT 1").get()?.digest ?? journal!.plan.planSha256)
    : journal!.plan.planSha256;
}
export function validateOriginalRecoveryProvenance(db: DatabaseSync, root: string, value: unknown,
  plan: OriginalRecoveryPhase1RepairPlan) {
  const provenance = originalRecoveryProvenanceSchema.parse(value), { sourcePayload, sourceResult, repairPayload, repairDecision, session } = provenance;
  if (!sourceResult || !repairDecision) fail("Recovery history lacks its two separate native decisions.");
  parseOriginalRecoveryPhase1Payload(originalRecoveryPhase1Methods.source, sourcePayload, session);
  parseOriginalRecoveryPhase1Payload(originalRecoveryPhase1Methods.repair, repairPayload, session);
  const journal = readOriginalMcpJournal(root);
  const host = db.prepare("SELECT payload FROM original_mcp_native_host_admissions WHERE receipt_sha256=?")
    .get(plan.observation.nativeHostReceiptSha256);
  const stored = host ? JSON.parse(String(host.payload)) : undefined;
  const { receiptSha256, ...hostBody } = stored ?? {};
  if (!journal || !host || receiptSha256 !== digest(hostBody) || digest(hostBody) !== digest(repairPayload.binding)
    || digest(sourcePayload.binding) !== digest(repairPayload.binding)
    || sourcePayload.request.operationId !== plan.operationId || repairPayload.request.operationId !== plan.operationId
    || sourceResult!.decision.operationId !== plan.operationId || repairDecision!.operationId !== plan.operationId
    || sourceResult!.decision.requestSha256 !== sourcePayload.requestSha256 || repairDecision!.requestSha256 !== repairPayload.requestSha256
    || sourceResult!.decision.epoch !== session.epoch || repairDecision!.epoch !== session.epoch
    || digest(sourceResult!.evidence) !== sourceResult!.evidenceSha256 || digest(sourceResult!.evidence) !== digest(plan.evidence)
    || digest(sourcePayload.request.publicRequest) !== digest(repairPayload.request.publicRequest)
    || repairPayload.request.repairPlanSha256 !== plan.repairPlanSha256
    || root !== session.binding.root || journal.workspaceId !== session.binding.workspaceId
    || journal.plan.planSha256 !== session.binding.planSha256 || journal.plan.profileSha256 !== session.binding.profileSha256)
    fail("Recovery native history differs from its exact Root/Host/source/repair binding.");
  return provenance;
}
export function verifyOriginalRecoveryState(db: DatabaseSync, root: string, allowPending = false) {
  if (!hasOriginalRecoveryState(db)) return;
  if (Number(db.prepare("PRAGMA user_version").get()?.user_version) !== 23)
    fail("Phase1 recovery cannot activate private snapshot/schema24 authority.");
  const oracle = new (db.constructor as { new(path: string): DatabaseSync })(":memory:");
  try {
    oracle.exec(ORIGINAL_RECOVERY_PHASE1_DDL);
    const query = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name GLOB 'original_native_recovery_*' OR tbl_name IN ('original_native_recovery_intents','original_native_recovery_commits') ORDER BY name";
    if (digest(db.prepare(query).all()) !== digest(oracle.prepare(query).all()))
      fail("Unknown/altered recovery DDL is not a phase1 admission.");
  } finally { oracle.close(); }
  const journal = readOriginalMcpJournal(root);
  if (!journal) fail("Recovery DDL is restricted to its Original custody.");
  let predecessor = journal!.plan.planSha256, sequence = 0;
  for (const row of db.prepare("SELECT * FROM original_native_recovery_commits ORDER BY sequence").iterate()) {
    const payload = String(row.payload), body = JSON.parse(payload);
    if (row.sequence !== ++sequence || row.predecessor_sha256 !== predecessor || row.digest !== digest({ predecessor, payload })
      || row.operation_id !== body.plan.operationId || row.workspace_id !== journal!.workspaceId)
      fail("Recovery immutable custody/receipt sequence changed.");
    validateOriginalRecoveryProvenance(db, root, body.provenance, body.plan);
    assertOriginalRecoveryPhase1Successor(body.plan, body.successor, body.stage);
    if (digest(body.indexBefore) !== body.plan.owner.indexRowSha256 || digest(body.indexAfter) !== body.plan.owner.indexRowSha256
      || body.result?.ok !== true || body.result.restored !== 1 || body.result.identical !== 0 || body.result.preserved_existing !== 0
      || body.result.report !== `${body.plan.evidence.directory}/${body.plan.auditName}`)
      fail("Recovery receipt changed owner/index/output semantics.");
    predecessor = String(row.digest);
  }
  const pending = db.prepare("SELECT * FROM original_native_recovery_intents WHERE singleton=1").get();
  if (pending) {
    if (pending.digest !== digest(String(pending.payload))) fail("Recovery pending intent digest changed.");
    const intent = JSON.parse(String(pending.payload));
    validateOriginalRecoveryProvenance(db, root, intent.provenance, intent.plan);
    if (intent.plan.operationId !== pending.operation_id) fail("Recovery pending operation identity changed.");
    if (!allowPending) fail("Native owner repair is incomplete; retain its exact intent for explicit owner inspection. No crash replay is authorized.");
  } else if (!sequence) fail("Orphan recovery DDL has no native intent or immutable commitment.");
}
