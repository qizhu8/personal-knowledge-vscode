import { createHash } from "node:crypto";
import { z } from "zod";
import {
  originalRecoveryDigest, originalRecoveryIdentitySchema,
  validateOriginalRecoveryEvidence, validateOriginalRecoveryRegisteredOwner,
  type OriginalRecoveryEvidence, type OriginalRecoveryRegisteredOwner,
} from "./original-knowledge-recovery-contracts.js";
import { planOriginalKnowledgeRecovery, type OriginalRecoveryCapture } from "./original-knowledge-recovery-planner.js";

export const originalRecoveryPhase1ObservationSchema = z.strictObject({
  root: z.string(), workspaceId: z.string().uuid(), nativeHostReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  epoch: z.string().uuid(), ownerId: z.string().uuid(), fence: z.number().int().positive(),
  rootIdentity: originalRecoveryIdentitySchema, parentIdentity: originalRecoveryIdentitySchema,
  owner: z.unknown(), destination: z.literal("missing"),
  pendingOperationIds: z.array(z.string()).max(0),
});
export interface OriginalRecoveryRepairDraftInput {
  operationId: string;
  evidence: OriginalRecoveryEvidence;
  owner: OriginalRecoveryRegisteredOwner;
  observation: z.infer<typeof originalRecoveryPhase1ObservationSchema>;
  capture: OriginalRecoveryCapture;
  auditName: string;
}
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }

/** Pure preconditions only. JSON observations and this draft never grant native effects. */
export function planOriginalRecoveryPhase1Repair(input: OriginalRecoveryRepairDraftInput) {
  const evidence = validateOriginalRecoveryEvidence(input.evidence);
  const owner = validateOriginalRecoveryRegisteredOwner(input.owner), observed = originalRecoveryPhase1ObservationSchema.parse(input.observation);
  const actualOwner = validateOriginalRecoveryRegisteredOwner(observed.owner), row = evidence.files[0]!;
  const path = `${owner.area}/${owner.path}`, preview = planOriginalKnowledgeRecovery(input.capture);
  if (originalRecoveryDigest(owner) !== originalRecoveryDigest(actualOwner)
    || observed.root !== evidence.knowledgeRoot || input.capture.knowledgeRoot !== observed.root
    || input.capture.expectedPlanSha256 !== evidence.planSha256 || preview.plan_sha256 !== evidence.planSha256
    || row.path !== path || row.sha256 !== owner.sha256 || row.mode !== owner.mode || row.identity.size !== owner.bytes
    || preview.files.length !== 1 || preview.files[0]?.path !== path || preview.files[0]?.status !== "restore")
    fail("RECOVERY_OWNER_REPAIR_PRECONDITION_CHANGED");
  const plan = JSON.parse(Buffer.from(input.capture.planBytes).toString("utf8")) as {
    files: { path: string; sha256: string; mode: string }[];
  };
  const blob = input.capture.blobs.get(row.sha256);
  if (plan.files[0]?.mode !== owner.mode || !blob || blob.byteLength !== owner.bytes
    || createHash("sha256").update(blob).digest("hex") !== owner.sha256)
    fail("RECOVERY_OWNER_REPAIR_PRECONDITION_CHANGED");
  z.string().uuid().parse(input.operationId);
  z.string().regex(/^result-\d{8}T\d{12}\.json$/).parse(input.auditName);
  const body = {
    schema: "pkm.original-recovery-owner-plan/v1" as const, operationId: input.operationId,
    evidence, owner, observation: { ...observed, owner: actualOwner }, auditName: input.auditName,
  };
  return { ...body, repairPlanSha256: originalRecoveryDigest(body) };
}
export type OriginalRecoveryPhase1RepairPlan = ReturnType<typeof planOriginalRecoveryPhase1Repair>;

/** Missing-state preflight before reserving an intent; never replay an unknown prefix. */
export function assertOriginalRecoveryPhase1Observation(plan: OriginalRecoveryPhase1RepairPlan,
  observedValue: unknown) {
  const { repairPlanSha256, ...body } = plan;
  const observed = originalRecoveryPhase1ObservationSchema.parse(observedValue);
  const owner = validateOriginalRecoveryRegisteredOwner(observed.owner);
  if (originalRecoveryDigest(body) !== repairPlanSha256
    || originalRecoveryDigest({ ...observed, owner }) !== originalRecoveryDigest(plan.observation))
    fail("RECOVERY_OWNER_REPAIR_PRECONDITION_CHANGED");
}

export const originalRecoveryPhase1SuccessorSchema = z.strictObject({
  operationId: z.string().uuid(), repairPlanSha256: z.string().regex(/^[a-f0-9]{64}$/),
  root: z.string(), workspaceId: z.string().uuid(), epoch: z.string().uuid(),
  ownerId: z.string().uuid(), fence: z.number().int().positive(),
  rootIdentity: originalRecoveryIdentitySchema, parentIdentity: originalRecoveryIdentitySchema,
  owner: z.unknown(), path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  physicalIdentity: originalRecoveryIdentitySchema,
  predecessorSha256: z.string().regex(/^[a-f0-9]{64}$/),
  beforeIndexRowSha256: z.string().regex(/^[a-f0-9]{64}$/),
  afterIndexRowSha256: z.string().regex(/^[a-f0-9]{64}$/),
  auditName: z.string(), auditPlanSha256: z.string().regex(/^[a-f0-9]{64}$/),
  auditedRestored: z.array(z.string()).length(1),
});
function sameDirectoryIdentity(a: z.infer<typeof originalRecoveryIdentitySchema>, b: typeof a) {
  return a.device === b.device && a.inode === b.inode && a.uid === b.uid && a.mode === b.mode && a.links === b.links;
}
export const originalRecoveryPhase1StageSchema = z.strictObject({
  operationId: z.string().uuid(), root: z.string(), workspaceId: z.string().uuid(), epoch: z.string().uuid(),
  ownerId: z.string().uuid(), fence: z.number().int().positive(),
  rootIdentity: originalRecoveryIdentitySchema, parentIdentity: originalRecoveryIdentitySchema,
  stageName: z.string(), targetPath: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  identity: originalRecoveryIdentitySchema, pendingOperationIds: z.array(z.string()).length(1),
});
export function assertOriginalRecoveryPhase1Stage(plan: OriginalRecoveryPhase1RepairPlan, value: unknown) {
  const stage = originalRecoveryPhase1StageSchema.parse(value), before = plan.observation;
  if (stage.operationId !== plan.operationId || stage.root !== before.root || stage.workspaceId !== before.workspaceId
    || stage.epoch !== before.epoch || stage.ownerId !== before.ownerId || stage.fence !== before.fence
    || !sameDirectoryIdentity(stage.rootIdentity, before.rootIdentity)
    || !sameDirectoryIdentity(stage.parentIdentity, before.parentIdentity)
    || stage.stageName !== `.pkm-write-${plan.operationId}` || stage.targetPath !== `${plan.owner.area}/${plan.owner.path}`
    || stage.sha256 !== plan.owner.sha256 || stage.identity.size !== plan.owner.bytes || stage.identity.links !== 1
    || stage.identity.device !== before.parentIdentity.device || stage.identity.uid !== before.parentIdentity.uid
    || stage.identity.mode !== (plan.owner.mode === "100755" ? 0o755 : 0o644)
    || stage.pendingOperationIds[0] !== plan.operationId)
    fail("RECOVERY_OWNER_REPAIR_STAGE_CHANGED");
  return stage;
}
/** Verify the successful publication/audit image without re-admitting a lost Root or changing identity. */
export function assertOriginalRecoveryPhase1Successor(plan: OriginalRecoveryPhase1RepairPlan, value: unknown, stageValue: unknown) {
  const stage = assertOriginalRecoveryPhase1Stage(plan, stageValue);
  const successor = originalRecoveryPhase1SuccessorSchema.parse(value);
  const owner = validateOriginalRecoveryRegisteredOwner(successor.owner);
  const before = plan.observation, path = `${plan.owner.area}/${plan.owner.path}`;
  const { repairPlanSha256, ...body } = plan;
  if (originalRecoveryDigest(body) !== repairPlanSha256 || successor.repairPlanSha256 !== repairPlanSha256
    || successor.operationId !== plan.operationId || successor.root !== before.root
    || successor.workspaceId !== before.workspaceId || successor.epoch !== before.epoch
    || successor.ownerId !== before.ownerId || successor.fence !== before.fence
    || !sameDirectoryIdentity(successor.rootIdentity, before.rootIdentity)
    || !sameDirectoryIdentity(successor.parentIdentity, before.parentIdentity)
    || originalRecoveryDigest(owner) !== originalRecoveryDigest(plan.owner)
    || successor.path !== path || successor.sha256 !== plan.owner.sha256
    || successor.physicalIdentity.size !== plan.owner.bytes
    || successor.physicalIdentity.links !== 1
    || successor.physicalIdentity.device !== stage.identity.device || successor.physicalIdentity.inode !== stage.identity.inode
    || successor.physicalIdentity.uid !== before.parentIdentity.uid
    || successor.physicalIdentity.mode !== (plan.owner.mode === "100755" ? 0o755 : 0o644)
    || successor.predecessorSha256 !== plan.owner.custodyPredecessorSha256
    || successor.beforeIndexRowSha256 !== plan.owner.indexRowSha256
    || successor.afterIndexRowSha256 !== plan.owner.indexRowSha256
    || successor.auditName !== plan.auditName || successor.auditPlanSha256 !== plan.evidence.planSha256
    || successor.auditedRestored[0] !== path)
    fail("RECOVERY_OWNER_REPAIR_SUCCESSOR_CHANGED");
  return successor;
}
