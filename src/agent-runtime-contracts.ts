import { z } from "zod";

export const AGENT_RUNTIME_LIMITS = Object.freeze({
  depth: 8, fanout: 8, treeNodes: 64, sessionsPerActor: 256, receiptsPerActor: 4096,
  requestBytes: 8192, snapshotBytes: 65536, page: 100,
});
export const agentRuntimeId = z.string().regex(/^agent_session_[a-f0-9-]{36}$/).max(64);
export const agentRuntimeKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/);
export const agentRuntimeDigest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const opId = z.string().uuid();
export const agentRuntimeState = z.enum([
  "intent", "spawn-unknown", "running", "cancel-requested", "completed", "failed", "cancelled",
]);
export const agentRuntimeRecord = z.strictObject({
  schema: z.literal("pkm.agent.runtime/v1"), id: agentRuntimeId, treeId: agentRuntimeId,
  parentId: agentRuntimeId.nullable(), groupId: z.string().regex(/^agent_group_[a-f0-9]{64}$/),
  taskKey: agentRuntimeKey, title: z.string().min(1).max(120), policyDigest: agentRuntimeDigest,
  depth: z.number().int().min(0).max(AGENT_RUNTIME_LIMITS.depth),
  revision, state: agentRuntimeState, createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  restoredFrom: z.strictObject({ snapshotId: z.string().regex(/^agent_snapshot_synthetic_[A-Za-z0-9_-]{1,80}$/), digest: agentRuntimeDigest }).nullable(),
});
export type AgentRuntimeRecord = z.infer<typeof agentRuntimeRecord>;
export const agentRuntimeTask = z.strictObject({
  key: agentRuntimeKey, title: z.string().trim().min(1).max(120),
  capabilities: z.array(agentRuntimeKey).max(16).refine(items => new Set(items).size === items.length),
});
export type AgentRuntimeTask = z.infer<typeof agentRuntimeTask>;
export const agentRuntimeSnapshot = z.strictObject({
  schema: z.literal("pkm.agent.runtime.synthetic-snapshot/v1"), synthetic: z.literal(true),
  snapshotId: z.string().regex(/^agent_snapshot_synthetic_[A-Za-z0-9_-]{1,80}$/),
  nodes: z.array(z.strictObject({
    sourceId: agentRuntimeKey, parentSourceId: agentRuntimeKey.nullable(), taskKey: agentRuntimeKey,
  })).min(1).max(AGENT_RUNTIME_LIMITS.treeNodes),
});
export type AgentRuntimeSnapshot = z.infer<typeof agentRuntimeSnapshot>;
export const agentRuntimeReceipt = z.strictObject({
  opId, operation: z.enum(["spawn", "cancel", "restore", "reconnect"]), ids: z.array(agentRuntimeId).min(1).max(AGENT_RUNTIME_LIMITS.treeNodes),
  rootId: agentRuntimeId, revision,
});
export type AgentRuntimeReceipt = z.infer<typeof agentRuntimeReceipt>;
const mutationResult = z.strictObject({ receipt: agentRuntimeReceipt, session: agentRuntimeRecord });
const spawn = z.strictObject({
  opId, taskKey: agentRuntimeKey, parentId: agentRuntimeId.optional(), expectedParentRevision: revision.optional(),
}).refine(value => (value.parentId === undefined) === (value.expectedParentRevision === undefined),
  "A child reservation requires its parent's revision.");
const pin = { snapshotId: agentRuntimeSnapshot.shape.snapshotId, digest: agentRuntimeDigest };

/** Schema-only integration inventory. No transport registration, actor argument or host completion endpoint. */
export const agentRuntimeDefinitions = [
  { id: "agent.runtime.spawn", readOnly: false, description: "Spawn a task from the configured native task policy; no caller-supplied prompt or permission grant.", input: spawn, output: mutationResult },
  { id: "agent.runtime.cancel", readOnly: false,
    description: "Cancel an actor-owned Agent subtree using exact revision; external cancellation is best-effort and reconciled by the host.",
    input: z.strictObject({ opId, id: agentRuntimeId, expectedRevision: revision }), output: mutationResult },
  { id: "agent.runtime.restore", readOnly: false,
    description: "Restore only an exact host-pinned synthetic snapshot; native host policy is required.",
    input: z.strictObject({ opId, ...pin }), output: mutationResult },
  { id: "agent.runtime.get", readOnly: true, description: "Read a trusted actor-owned Agent session.", input: z.strictObject({ id: agentRuntimeId }), output: agentRuntimeRecord },
  { id: "agent.runtime.list", readOnly: true,
    description: "Page trusted actor-owned Agent sessions; owner identity is supplied by the native host.",
    input: z.strictObject({
      treeId: agentRuntimeId.optional(), offset: z.number().int().min(0).max(256).default(0),
      limit: z.number().int().min(1).max(AGENT_RUNTIME_LIMITS.page).default(50),
    }), output: z.strictObject({ items: z.array(agentRuntimeRecord).max(100), total: z.number().int().nonnegative() }) },
  { id: "agent.runtime.reconnect", readOnly: false,
    description: "Reconcile a native-owned Agent handle without blindly replaying spawn.",
    input: z.strictObject({ opId, id: agentRuntimeId, expectedRevision: revision }), output: agentRuntimeRecord },
] as const;
export type AgentRuntimeSpawnInput = z.input<typeof spawn>;
export type AgentRuntimeRestoreInput = { opId: string; snapshotId: string; digest: string };
export type AgentRuntimeCancelInput = { opId: string; id: string; expectedRevision: number };
