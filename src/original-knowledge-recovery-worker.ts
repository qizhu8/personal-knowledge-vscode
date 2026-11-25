import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync, openSync,
  unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { CoreError } from "./contracts.js";
import { originalRecoveryDigest as digest } from "./original-knowledge-recovery-contracts.js";
import { assembleRecoveryOwner } from "./original-knowledge-recovery-assembly.js";
import { assertOriginalRecoveryPhase1Observation, assertOriginalRecoveryPhase1Stage, assertOriginalRecoveryPhase1Successor } from "./original-knowledge-recovery-guard.js";
import {
  ORIGINAL_RECOVERY_PHASE1_DDL, hasOriginalRecoveryState, originalRecoveryIndexRow,
  validateOriginalRecoveryProvenance, verifyOriginalRecoveryState, type OriginalRecoveryWorkerAdmission,
} from "./original-knowledge-recovery-state.js";
import { readRecoveryEvidence, readRecoveryFileAt, recoveryFileIdentity, sameRecoveryDirectory, withRecoveryDirectory, withRecoveryParent } from "./original-knowledge-recovery-files.js";
import { readOriginalMcpJournal, assertOriginalMcpPrivacy } from "./original-mcp-root-custody.js";
import { sha256 } from "./file-write.js";

function noPending(db: DatabaseSync, own?: string) {
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    const name = String(row.name);
    if (/^pending_|^(data_runtime_intents|migration_runtime_intents|legacy_note_workitems_intent|original_native_recovery_intents)$/.test(name)
      && name !== "original_native_recovery_intents"
      && db.prepare(`SELECT 1 FROM "${name}" LIMIT 1`).get())
      throw new CoreError("RECOVERY_REQUIRED", "Another durable native intent blocks owner repair.", "unknown");
  }
  if (hasOriginalRecoveryState(db)) {
    const pending = db.prepare("SELECT operation_id FROM original_native_recovery_intents LIMIT 1").get();
    if (pending && pending.operation_id !== own)
      throw new CoreError("RECOVERY_REQUIRED", "A prior owner repair requires explicit inspection; it was not replayed.", "unknown");
  }
}
/** This channel is reached only by Storage's genuine one-use WeakMap capsule forwarding. */
export function executeOriginalRecoveryWorker(db: DatabaseSync, root: string, admission: OriginalRecoveryWorkerAdmission,
  runtimeOwner: { ownerId?: string; fence?: number }) {
  const { plan, provenance } = admission;
  if (!(admission.control instanceof SharedArrayBuffer) || admission.control.byteLength !== 8
    || admission.actor?.id !== "mcp:external" || admission.actor.canWrite !== true
    || runtimeOwner.ownerId !== plan.observation.ownerId || runtimeOwner.fence !== plan.observation.fence
    || Atomics.compareExchange(new Int32Array(admission.control), 1, 0, 1) !== 0)
    throw new CoreError("ACCESS_DENIED", "A copied/stale recovery capsule cannot grant private owner effects.");
  const current = () => {
    const owner = db.prepare("SELECT owner_id,fence,lease_until FROM native_runtime_owner WHERE singleton=1").get();
    const journal = assertOriginalMcpPrivacy(root);
    if (Atomics.load(new Int32Array(admission.control), 0) !== 0 || !owner || owner.owner_id !== runtimeOwner.ownerId
      || owner.fence !== runtimeOwner.fence || Number(owner.lease_until) <= Date.now() || !journal
      || journal.workspaceId !== plan.observation.workspaceId || journal.plan.planSha256 !== provenance.session.binding.planSha256
      || provenance.sourceResult!.decision.expiresAtMs <= Date.now() || provenance.repairDecision!.expiresAtMs <= Date.now())
      throw new CoreError("ACCESS_DENIED", "Native recovery source/repair/owner authority expired or was revoked.", "unknown");
    withRecoveryParent(root, `${plan.owner.area}/${plan.owner.path}`, fd => {
      if (!sameRecoveryDirectory(recoveryFileIdentity(fstatSync(fd, { bigint: true })), plan.observation.parentIdentity)
        || !sameRecoveryDirectory(recoveryFileIdentity(lstatSync(root, { bigint: true })), plan.observation.rootIdentity))
        throw new CoreError("RECOVERY_REQUIRED", "Recovery's signed physical owner/parent changed.", "unknown");
    });
  };
  current();
  validateOriginalRecoveryProvenance(db, root, provenance, plan);
  verifyOriginalRecoveryState(db, root); noPending(db);
  if (db.prepare("SELECT 1 FROM receipts WHERE operation_id=?").get(plan.operationId))
    throw new CoreError("CONFLICT", "The recovery operation UUID already belongs to a receipt; it was not replayed.");
  const source = readRecoveryEvidence(plan.evidence, current);
  const assembled = assembleRecoveryOwner(db, root, plan.evidence, source, admission.custodyRow, {
    nativeHostReceiptSha256: plan.observation.nativeHostReceiptSha256, epoch: plan.observation.epoch,
    ownerId: runtimeOwner.ownerId!, fence: runtimeOwner.fence!,
  }, current);
  if (assembled.occupied) throw new CoreError("CONFLICT", "Existing destination bytes were preserved; no owner repair intent was created.");
  assertOriginalRecoveryPhase1Observation(plan, assembled.observation);
  let intent: Record<string, unknown> = { plan, provenance, custodyRow: admission.custodyRow, indexBefore: assembled.index, phase: "intent" };
  const persist = () => {
    const payload = JSON.stringify(intent);
    db.prepare("INSERT OR REPLACE INTO original_native_recovery_intents VALUES(1,?,?,?)").run(plan.operationId, payload, digest(payload));
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    current(); noPending(db);
    if (!hasOriginalRecoveryState(db)) db.exec(ORIGINAL_RECOVERY_PHASE1_DDL);
    persist(); db.exec("COMMIT");
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  try {
    return withRecoveryDirectory(plan.evidence.directory, evidenceFd => withRecoveryParent(root,
      `${plan.owner.area}/${plan.owner.path}`, (parentFd, leaf) => {
      current();
      const auditPath = `/proc/self/fd/${evidenceFd}/${plan.auditName}`;
      const auditFd = openSync(auditPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        const report = { schema: "pkm.knowledge-recovery-result/v1", knowledge_root: root,
          plan_sha256: plan.evidence.planSha256, started_at: new Date().toISOString(),
          restored: [] as string[], identical: [] as string[], preserved_existing: [] as string[], completed_at: undefined as string | undefined };
        const auditPin = recoveryFileIdentity(fstatSync(auditFd, { bigint: true }));
        const writeAudit = () => {
          current();
          const stat = fstatSync(auditFd, { bigint: true }), named = lstatSync(auditPath, { bigint: true });
          if (stat.ino !== named.ino || stat.dev !== named.dev || stat.nlink !== 1n
            || String(stat.ino) !== auditPin.inode || String(stat.dev) !== auditPin.device || stat.uid !== BigInt(process.getuid!())
            || Number(stat.mode & 0o777n) !== 0o600)
            throw new CoreError("RECOVERY_REQUIRED", "Exclusive recovery audit custody changed.", "unknown");
          const bytes = Buffer.from(JSON.stringify(report, null, 2));
          for (let offset = 0; offset < bytes.length;) offset += writeSync(auditFd, bytes, offset, bytes.length - offset, offset);
          ftruncateSync(auditFd, bytes.length); fsyncSync(auditFd); fsyncSync(evidenceFd);
        };
        writeAudit();
        intent = { ...intent, phase: "audit", auditPin }; persist();
        readRecoveryEvidence(plan.evidence, current, true);
        const stageName = `.pkm-write-${plan.operationId}`, stagePath = `/proc/self/fd/${parentFd}/${stageName}`;
        const target = `/proc/self/fd/${parentFd}/${leaf}`;
        const stageFd = openSync(stagePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try {
          current(); writeFileSync(stageFd, source.bytes); fchmodSync(stageFd, plan.owner.mode === "100755" ? 0o755 : 0o644);
          fsyncSync(stageFd); fsyncSync(parentFd);
          const stage = assertOriginalRecoveryPhase1Stage(plan, {
            operationId: plan.operationId, root, workspaceId: plan.observation.workspaceId, epoch: plan.observation.epoch,
            ownerId: runtimeOwner.ownerId, fence: runtimeOwner.fence,
            rootIdentity: recoveryFileIdentity(lstatSync(root, { bigint: true })),
            parentIdentity: recoveryFileIdentity(fstatSync(parentFd, { bigint: true })),
            stageName, targetPath: `${plan.owner.area}/${plan.owner.path}`, sha256: sha256(source.bytes),
            identity: recoveryFileIdentity(fstatSync(stageFd, { bigint: true })), pendingOperationIds: [plan.operationId],
          });
          intent = { ...intent, phase: "stage", stage }; persist();
          current(); noPending(db, plan.operationId);
          const checked = readRecoveryFileAt(parentFd, stageName, plan.owner.bytes, current);
          if (digest(checked.identity) !== digest(stage.identity) || sha256(checked.bytes) !== plan.owner.sha256
            || digest(originalRecoveryIndexRow(db, plan.owner.id)) !== plan.owner.indexRowSha256)
            throw new CoreError("RECOVERY_REQUIRED", "Recovery stage/retained index changed before publication.", "unknown");
          readRecoveryEvidence(plan.evidence, current, true);
          const fresh = assembleRecoveryOwner(db, root, plan.evidence, source, admission.custodyRow, {
            nativeHostReceiptSha256: plan.observation.nativeHostReceiptSha256, epoch: plan.observation.epoch,
            ownerId: runtimeOwner.ownerId!, fence: runtimeOwner.fence!,
          }, current, { path: `${plan.owner.area}/${plan.owner.path}`.replace(/[^/]+$/, stageName), identity: stage.identity });
          if (fresh.occupied || digest(fresh.owner) !== digest(plan.owner))
            throw new CoreError("RECOVERY_REQUIRED", "Owner/referrer scope changed before exclusive publication.", "unknown");
          try { linkSync(stagePath, target); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              report.preserved_existing.push(`${plan.owner.area}/${plan.owner.path}`); writeAudit();
            }
            throw error;
          }
          fsyncSync(parentFd); current();
          unlinkSync(stagePath); fsyncSync(parentFd);
          const published = readRecoveryFileAt(parentFd, leaf, plan.owner.bytes, current);
          if (published.identity.inode !== stage.identity.inode || sha256(published.bytes) !== plan.owner.sha256)
            throw new CoreError("RECOVERY_REQUIRED", "Publication is not the approved exclusive stage inode.", "unknown");
          report.restored.push(`${plan.owner.area}/${plan.owner.path}`); report.completed_at = new Date().toISOString();
          writeAudit();
          const successor = assertOriginalRecoveryPhase1Successor(plan, {
            operationId: plan.operationId, repairPlanSha256: plan.repairPlanSha256, root,
            workspaceId: plan.observation.workspaceId, epoch: plan.observation.epoch,
            ownerId: runtimeOwner.ownerId, fence: runtimeOwner.fence,
            rootIdentity: recoveryFileIdentity(lstatSync(root, { bigint: true })),
            parentIdentity: recoveryFileIdentity(fstatSync(parentFd, { bigint: true })),
            owner: plan.owner, path: `${plan.owner.area}/${plan.owner.path}`, sha256: sha256(published.bytes),
            physicalIdentity: published.identity, predecessorSha256: plan.owner.custodyPredecessorSha256,
            beforeIndexRowSha256: plan.owner.indexRowSha256, afterIndexRowSha256: digest(originalRecoveryIndexRow(db, plan.owner.id)),
            auditName: plan.auditName, auditPlanSha256: plan.evidence.planSha256, auditedRestored: report.restored,
          }, stage);
          const result = { ok: true, report: `${plan.evidence.directory}/${plan.auditName}`, restored: 1, identical: 0, preserved_existing: 0 };
          intent = { ...intent, phase: "published", successor }; persist();
          db.exec("BEGIN IMMEDIATE");
          try {
            current(); noPending(db, plan.operationId);
            const predecessor = plan.owner.custodyPredecessorSha256;
            const latest = db.prepare("SELECT digest FROM original_native_recovery_commits ORDER BY sequence DESC LIMIT 1").get()?.digest
              ?? readOriginalMcpJournal(root)!.plan.planSha256;
            if (latest !== predecessor) throw new CoreError("RECOVERY_REQUIRED", "Recovery custody predecessor changed.", "unknown");
            const payload = JSON.stringify({ plan, provenance, stage, successor, indexBefore: assembled.index,
              indexAfter: originalRecoveryIndexRow(db, plan.owner.id), result });
            db.prepare("INSERT INTO original_native_recovery_commits(operation_id,workspace_id,payload,predecessor_sha256,digest) VALUES(?,?,?,?,?)")
              .run(plan.operationId, plan.observation.workspaceId, payload, predecessor, digest({ predecessor, payload }));
            db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(plan.operationId, plan.repairPlanSha256, JSON.stringify(result),
              "mcp:external", "knowledge.recovery.owner", new Date().toISOString());
            db.prepare("DELETE FROM original_native_recovery_intents WHERE singleton=1").run();
            verifyOriginalRecoveryState(db, root); db.exec("COMMIT"); return result;
          } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
        } finally { closeSync(stageFd); }
      } finally { closeSync(auditFd); }
    }));
  } catch (error) {
    throw new CoreError("RECOVERY_REQUIRED", `Exact owner repair intent is durable; no failed Root replay was attempted. ${
      error instanceof Error ? error.message : "Native effect failed."}`, "unknown");
  }
}
