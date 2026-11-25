import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { originalDigest } from "./domain/action-compiler-validation.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const actionGcRecord = z.strictObject({
  schema: z.literal("pkm.native-action-gc/v1"), workspaceId: z.string().min(1), actorId: z.literal("mcp:external"), runId: z.string().min(1).max(128),
  definitionDigest: digest, version: z.number().safe().int().positive(), releaseOutputs: z.boolean(),
  nativeHostReceiptSha256: digest, operationId: z.string().uuid(),
  releasedArtifacts: z.array(z.strictObject({ artifactId: z.string(), digest, ownerRunId: z.string(), rootRunId: z.string() })).max(4096),
  gcState: z.enum(["completed", "retained"]),
});
export function readActionGcRecords(db: DatabaseSync, workspaceId: string) {
  const records: z.infer<typeof actionGcRecord>[] = [];
  const released = new Set<string>();
  for (const row of db.prepare(
    "SELECT actor_id,operation_id,fingerprint,result FROM action_runtime_receipts WHERE json_extract(result,'$.schema')='pkm.native-action-gc/v1' ORDER BY rowid").all()) {
    const value = actionGcRecord.parse(JSON.parse(String(row.result)));
    if (value.workspaceId !== workspaceId || value.actorId !== row.actor_id || value.operationId !== row.operation_id
      || originalDigest(value) !== row.fingerprint)
      throw new CoreError("RECOVERY_CONFLICT", "Native Action GC receipt binding changed.");
    if (records.length >= 4096) throw new CoreError("RESOURCE_LIMIT", "Native Action GC history exceeds its bound.");
    const rootRow = db.prepare("SELECT version,snapshot FROM action_runtime_runs WHERE actor_id=? AND run_id=?")
      .get(value.actorId, value.runId);
    const root = rootRow && JSON.parse(String(rootRow.snapshot));
    if (!root || root.runId !== value.runId || root.definitionDigest !== value.definitionDigest
      || Number(rootRow!.version) < value.version || !["succeeded", "failed", "cancelled"].includes(root.state))
      throw new CoreError("RECOVERY_CONFLICT", "Native Action GC lost its exact terminal root.");
    for (const item of value.releasedArtifacts) {
      const row = db.prepare("SELECT payload,payload_sha256 FROM legacy_action_artifacts WHERE id=?").get(item.artifactId);
      const metadata = row && JSON.parse(String(row.payload));
      if (!metadata || createHash("sha256").update(String(row!.payload)).digest("hex") !== row!.payload_sha256
        || metadata.kind !== "managed" || metadata.artifactId !== item.artifactId || metadata.workspaceId !== workspaceId
        || metadata.actorId !== value.actorId || metadata.digest !== item.digest || metadata.ownerRunId !== item.ownerRunId
        || (metadata.rootRunId ?? metadata.ownerRunId) !== item.rootRunId || item.rootRunId !== value.runId
        || released.has(item.artifactId))
        throw new CoreError("RECOVERY_CONFLICT", "Native Action GC release lost its immutable artifact/root binding.");
      released.add(item.artifactId);
    }
    records.push(value);
  }
  return records;
}
export function actionArtifactWasReleased(db: DatabaseSync, workspaceId: string, artifactId: string) {
  return readActionGcRecords(db, workspaceId).some(record => record.releasedArtifacts.some(item => item.artifactId === artifactId));
}
