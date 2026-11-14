import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError } from "./contracts.js";

export const nestedActionPlansDdl = `
CREATE TABLE IF NOT EXISTS native_action_nested_plans(
  actor_id TEXT NOT NULL, child_run_id TEXT NOT NULL, payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
  PRIMARY KEY(actor_id,child_run_id)
);
CREATE TRIGGER IF NOT EXISTS native_action_nested_plans_no_update
BEFORE UPDATE ON native_action_nested_plans BEGIN SELECT RAISE(ABORT,'native nested plan immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_action_nested_plans_no_delete
BEFORE DELETE ON native_action_nested_plans BEGIN SELECT RAISE(ABORT,'native nested plan immutable'); END;`;
const schema = z.strictObject({
  actorId: z.literal("mcp:external"), workspaceId: z.string().min(1), parentRunId: z.string().min(1),
  childRunId: z.string().min(1), sourceId: z.string().regex(/^artifact_[a-f0-9]{32}$/),
  childHash: z.string().regex(/^[a-f0-9]{64}$/),
  trustEpoch: z.string().min(1).max(256),
});
export type NestedActionPlan = z.infer<typeof schema>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function writeNestedActionPlan(db: DatabaseSync, plan: NestedActionPlan): void {
  const parsed = schema.parse(plan), payload = JSON.stringify(parsed);
  db.prepare("INSERT INTO native_action_nested_plans VALUES(?,?,?,?)")
    .run(parsed.actorId, parsed.childRunId, payload, hash(payload));
}

export function readNestedActionPlan(db: DatabaseSync, actorId: string, childRunId: string): NestedActionPlan | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_action_nested_plans'").get()) return undefined;
  const row = db.prepare("SELECT payload,payload_sha256 FROM native_action_nested_plans WHERE actor_id=? AND child_run_id=?")
    .get(actorId, childRunId);
  if (!row) return undefined;
  const text = String(row.payload);
  if (hash(text) !== row.payload_sha256) throw new CoreError("RECOVERY_CONFLICT", "Nested Action plan changed.");
  const plan = schema.parse(JSON.parse(text));
  if (plan.actorId !== actorId || plan.childRunId !== childRunId)
    throw new CoreError("RECOVERY_CONFLICT", "Nested Action plan identity changed.");
  return plan;
}

export function authorizeNestedArtifact(db: DatabaseSync, workspaceId: string, actorId: string, childRunId: string,
  rootRunId: string, artifactId: string, sourceId: string, activeParent?: string): void {
  const plan = readNestedActionPlan(db, actorId, childRunId);
  if (!plan || plan.workspaceId !== workspaceId || plan.parentRunId !== rootRunId || plan.sourceId !== sourceId)
    throw new CoreError("RECOVERY_CONFLICT", "Nested artifact root ownership changed.");
  if (rootRunId === childRunId || readNestedActionPlan(db, actorId, rootRunId))
    throw new CoreError("RECOVERY_CONFLICT", "Nested artifact root cannot itself be a nested Action.");
  const row = db.prepare("SELECT snapshot FROM action_runtime_runs WHERE actor_id=? AND run_id=?").get(actorId, rootRunId);
  if (!row) throw new CoreError("RECOVERY_CONFLICT", "Nested artifact parent is unavailable.");
  const parent = JSON.parse(String(row.snapshot)) as { state?: string; cancelRequested?: boolean;
    implementation?: { kind?: string };
    definition?: { dependencies?: Record<string, unknown> }; inputs?: { source?: { artifact_id?: string } };
    nodes?: Array<{ nodeId?: string; state?: string; outputs?: { artifact_id?: string } }> };
  if (parent.implementation?.kind !== "program" || parent.definition?.dependencies?.["core.artifact.copy"] !== plan.childHash
    || parent.inputs?.source?.artifact_id !== sourceId)
    throw new CoreError("RECOVERY_CONFLICT", "Nested artifact parent binding changed.");
  if (activeParent === rootRunId && parent.state === "running" && !parent.cancelRequested) return;
  if (parent.state === "succeeded" && parent.nodes?.length === 1 && parent.nodes[0]?.nodeId === "action"
    && parent.nodes[0]?.state === "succeeded" && parent.nodes[0]?.outputs?.artifact_id === artifactId
    && Object.keys(parent.nodes[0].outputs).length === 1) return;
  throw new CoreError("ACCESS_DENIED", "Nested artifact is not published by its successful root Action.");
}
