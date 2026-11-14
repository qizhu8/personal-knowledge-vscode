import { z } from "zod";

export const agentSnapshotIdentity = z.string().regex(/^agent_snapshot_[A-Za-z0-9_-]+$/).max(160);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const pin = { snapshotRevision: digest.optional() };
const recent = z.number().int().min(0).max(50).default(12);
const summary = z.strictObject({
  snapshotId: agentSnapshotIdentity, name: z.string().optional(), magicCode: z.string(),
  sourceSessionId: z.string(), sourceHostSessionId: z.string(), sourceHostKind: z.string(),
  task: z.string(), projectId: z.string(),
  agent: z.strictObject({ name: z.string(), product: z.string() }),
  reason: z.string(), createdAt: z.string(), recipeRunCount: z.number().int().nonnegative(),
  todoCount: z.number().int().nonnegative(), recoveryCount: z.number().int().nonnegative(),
  checkpoint: z.strictObject({
    checkpointId: z.string(), sequence: z.number(), createdAt: z.string(), reason: z.string(),
  }).nullable().optional(),
});
const adapters = z.strictObject({
  encryptedPayload: z.literal("unavailable"), networkRecovery: z.literal("unavailable"),
  vscode: z.literal("unavailable"), restore: z.literal("unavailable"),
});
const common = { ok: z.literal(true), snapshotRevision: digest, adapters };
const todo = z.strictObject({
  todoId: z.string().optional(), title: z.string().optional(), status: z.string().optional(),
  actionType: z.string().optional(), updatedAt: z.string().optional(),
  details: z.string().optional(), summary: z.string().optional(), recipeRunIds: z.array(z.string()).optional(),
});
export const agentSnapshotReadDefinitions = [
  {
    id: "agent.snapshot.list", readOnly: true,
    description: "List immutable, explicitly staged Agent Snapshots; Magic Codes identify records, not authorization.",
    input: z.strictObject({
      offset: z.number().int().min(0).max(512).default(0),
      limit: z.number().int().min(1).max(100).default(50), ...pin,
    }),
    output: z.strictObject({
      ...common, snapshots: z.array(summary), total: z.number().int().nonnegative(),
      nextOffset: z.number().int().nullable(),
    }),
  },
  {
    id: "agent.snapshot.get", readOnly: true,
    description: "Get captured Snapshot metadata by its original immutable identity, without restoring it.",
    input: z.strictObject({ snapshotId: agentSnapshotIdentity, ...pin }),
    output: z.strictObject({ ...common, snapshot: summary }),
  },
  {
    id: "agent.snapshot.read", readOnly: true,
    description: "Read a captured task, Todos, checkpoints, Recipe states and recent PKM conversation by Magic Code.",
    input: z.strictObject({
      magic_code: z.string().trim().toUpperCase().startsWith("PKM-SNAP-").max(160),
      recent_messages: recent, ...pin,
    }),
    output: z.strictObject({
      ...common, read_only: z.literal(true), snapshot: summary,
      source: z.enum(["pkm-chat", "external-agent"]), task: z.string(), status: z.string(),
      summary: z.string(), project_id: z.string(), todos: z.array(todo),
      checkpoints: z.array(z.strictObject({
        checkpointId: z.string().nullable(), sequence: z.number().nullable(),
        createdAt: z.string().nullable(), reason: z.string().nullable(),
      })),
      latest_checkpoint_state: z.json().nullable(), note: z.string(),
      recipe_runs: z.array(z.strictObject({
        runId: z.string(), recipeId: z.string(), recipeName: z.string(), status: z.string(),
        nodes: z.record(z.string(), z.string()),
      })).optional(),
      conversation: z.strictObject({
        message_count: z.number().int().nonnegative(),
        recent_messages: z.array(z.strictObject({ role: z.string(), status: z.string(), content: z.string() })),
      }).optional(),
    }),
  },
] as const;
