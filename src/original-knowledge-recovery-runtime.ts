import { randomUUID } from "node:crypto";
import type { Actor } from "./contracts.js";
import { CoreError } from "./contracts.js";
import type { Storage } from "./storage.js";
import type { OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import {
  originalRecoveryDigest as digest, originalRecoveryPublicRequestSchema,
  originalRecoverySourcePayloadSchema, originalRecoveryRepairPayloadSchema,
} from "./original-knowledge-recovery-contracts.js";
import {
  getOriginalRecoveryPhase1Port, approveOriginalRecoverySource, originalRecoveryApprovedEvidence,
  assertOriginalRecoverySourceGrant, sealOriginalRecoverySourceCapture, previewOriginalRecoverySourceCapture,
  approveOriginalRecoveryRepair, createOriginalRecoveryWorkerCapsule, releaseOriginalRecoveryWorkerCapsule,
} from "./original-knowledge-recovery-native.js";
import { captureOriginalRecoveryCustodyProof, readOriginalRecoveryCustodyProof, closeOriginalRecoveryCustodyProof,
  assembleRecoveryOwner } from "./original-knowledge-recovery-assembly.js";
import { planOriginalRecoveryPhase1Repair } from "./original-knowledge-recovery-guard.js";
import { readRecoveryEvidence } from "./original-knowledge-recovery-files.js";
import { verifyOriginalRecoveryState } from "./original-knowledge-recovery-state.js";

export async function dispatchOriginalKnowledgeRecovery(storage: Storage, host: OriginalMcpNativeHost,
  actor: Readonly<Actor>, tool: string, args: Record<string, unknown>, signal?: AbortSignal) {
  if (actor.id !== "mcp:external" || actor.boardWorker || tool === "knowledge_recovery_apply" && !actor.canWrite)
    throw new CoreError("ACCESS_DENIED", "Recovery does not widen native actor write authority.");
  const port = getOriginalRecoveryPhase1Port(storage, host);
  if (!port) throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "Recovery requires the current separate native evidence/repair producer.");
  const publicRequest = originalRecoveryPublicRequestSchema.parse({ tool, version: 1, arguments: args, argumentsDigest: digest(args) });
  const { receiptSha256, ...binding } = host.receipt, operationId = randomUUID();
  const request = { schema: "pkm.original-recovery-source-request/v1" as const, operationId,
    nativeHostReceiptSha256: receiptSha256, publicRequest };
  return storage.withWorkspaceExclusive(async () => {
    storage.assertWorkspaceLease();
    const preflight = storage.connectNative();
    try { verifyOriginalRecoveryState(preflight, storage.workspaceRoot()); } finally { preflight.close(); }
    const grant = await approveOriginalRecoverySource(port, originalRecoverySourcePayloadSchema.parse({
      binding, defaultDecision: "deny", request, requestSha256: digest(request),
    }), signal);
    const current = () => { storage.assertWorkspaceLease(); assertOriginalRecoverySourceGrant(port, grant); };
    const evidence = originalRecoveryApprovedEvidence(port, grant);
    const proof = await captureOriginalRecoveryCustodyProof(storage, port, grant);
    try {
      const custody = readOriginalRecoveryCustodyProof(storage, proof), source = readRecoveryEvidence(evidence, current);
      const db = storage.connectNative();
      let assembled;
      try {
        verifyOriginalRecoveryState(db, storage.workspaceRoot());
        assembled = assembleRecoveryOwner(db, storage.workspaceRoot(), evidence, source, custody.row, {
          nativeHostReceiptSha256: receiptSha256, epoch: host.receipt.epoch, ...storage.workspaceLease(),
        }, current);
      } finally { db.close(); }
      const capture = sealOriginalRecoverySourceCapture(port, grant, evidence, assembled.capture);
      if (tool === "knowledge_recovery_preview") return previewOriginalRecoverySourceCapture(port, capture);
      if (assembled.occupied) throw new CoreError("CONFLICT", "Occupied destination bytes were preserved; missing-owner repair approval was not requested.");
      const auditName = `result-${new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "000")}.json`;
      const plan = planOriginalRecoveryPhase1Repair({
        operationId, evidence, owner: assembled.owner, observation: assembled.observation, capture: assembled.capture, auditName,
      });
      const repairRequest = {
        schema: "pkm.original-recovery-repair-request/v1" as const, operationId,
        nativeHostReceiptSha256: receiptSha256, publicRequest, evidence, owner: plan.owner,
        rootIdentity: plan.observation.rootIdentity, parentIdentity: plan.observation.parentIdentity,
        ownerId: plan.observation.ownerId, fence: plan.observation.fence, repairPlanSha256: plan.repairPlanSha256, auditName,
      };
      const repair = await approveOriginalRecoveryRepair(port, capture, plan, originalRecoveryRepairPayloadSchema.parse({
        binding, defaultDecision: "deny", request: repairRequest, requestSha256: digest(repairRequest),
      }));
      current(); custody.current();
      const capsule = createOriginalRecoveryWorkerCapsule(port, repair, proof);
      try { return await storage.requestOriginalRecovery(capsule); }
      finally { releaseOriginalRecoveryWorkerCapsule(storage, capsule); }
    } finally { closeOriginalRecoveryCustodyProof(proof); }
  });
}
