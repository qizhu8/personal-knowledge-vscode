import { z } from "zod";
import { boundedChatJson, chatSessionMessageInput } from "./chat-session-contracts.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const json = z.json().refine(boundedChatJson);
const strings = z.array(id).max(1024);
const todo = z.strictObject({
  todoId: id, title: z.string().max(12000), status: z.enum(["pending", "running", "paused", "succeeded", "failed", "skipped"]),
  details: z.string().max(12000).optional(), summary: z.string().max(12000).optional(),
  actionType: z.string().max(128).optional(), recipeRunId: id.optional(), recipeRunIds: strings.optional(),
  createdAt: z.string().optional(), updatedAt: z.string().optional(), startedAt: z.string().optional(),
  pausedAt: z.string().optional(), pauseReason: z.string().optional(), resumedAt: z.string().optional(),
});
const checkpoint = z.strictObject({
  checkpointId: id, sequence: z.number().int().positive(), createdAt: z.string(), reason: z.string(),
  state: json,
});
const node = z.strictObject({
  state: z.enum(["pending", "running", "paused", "succeeded", "failed", "skipped", "completed"]),
  childRunId: id.optional(), childRecipeId: id.optional(),
  result: json.optional(), progress: json.optional(),
});
const run = z.strictObject({
  schema: z.literal("pkm.recipe.run/v1").optional(),
  runId: id, recipeId: id, recipeName: z.string().optional(), status: z.string(),
  agentSessionId: id.optional(), nodes: z.record(id, node), receipts: json.optional(),
  parent: z.strictObject({ runId: id, nodeId: id.optional() }).optional(),
  createdAt: z.string().optional(), updatedAt: z.string().optional(),
});
export const legacySnapshotRestorePayload = z.strictObject({
  session: z.strictObject({
    schema: z.literal("pkm.agent.session/v1"), sessionId: id, task: z.string().max(12000),
    status: z.string(), summary: z.string().max(12000).optional(), projectId: z.string().optional(),
    origin: z.string(), hostKind: z.string(), runtimeOwner: z.string().optional(), hostSessionId: id.optional(),
    agent: z.strictObject({ name: z.string(), product: z.string() }).optional(),
    createdAt: z.string().optional(), updatedAt: z.string().optional(),
    todos: z.array(todo).max(1024), checkpoints: z.array(checkpoint).max(1024),
    recipeRunIds: strings.optional(),
    recipeTreeEdges: z.array(z.strictObject({
      fromRunId: id, toRunId: id, nodeId: id.optional(),
    })).max(1024).optional(),
    nativeChat: z.strictObject({
      id: id.optional(), messages: z.array(chatSessionMessageInput).max(10000),
      workflowMode: z.literal("chat").optional(), includeHistory: z.boolean().optional(),
      modelProvider: z.enum(["vscode", "openai-compatible", "azure-openai"]).optional(),
      modelProfileId: z.string().optional(), vscodeModelId: z.string().optional(), vscodeModelLabel: z.string().optional(),
      contextWindow: z.number().int().positive().optional(), maxOutputTokens: z.number().int().positive().optional(),
    }).optional(),
  }),
  recipeRuns: z.array(run).max(1024),
});
export type LegacySnapshotRestorePayload = z.infer<typeof legacySnapshotRestorePayload>;
const restoreInput = z.strictObject({ opId: z.string().uuid(), snapshotReceiptId: id, cipherSha256: digest });
const controlInput = z.strictObject({ opId: z.string().uuid(), restoreId: digest, expectedRevision: z.number().int().positive() });
const result = z.strictObject({
  restoreId: digest, revision: z.number().int().positive(),
  state: z.enum(["paused", "resume-unknown", "native-controlled", "cancel-unknown", "cancelled"]),
  chatId: id, sessionId: id, planSha256: digest, replay: z.literal("never"),
});
/** Intent-only inventory. No actor, key, oracle, authority grant, model or worker result input. */
export const legacySnapshotRestoreDefinitions = [
  { id: "agent.snapshot.restore-paused", readOnly: false, input: restoreInput, output: result },
  { id: "agent.snapshot.resume-native", readOnly: false, input: controlInput, output: result },
  { id: "agent.snapshot.cancel-native", readOnly: false, input: controlInput, output: result },
  { id: "agent.snapshot.restore-get", readOnly: true, input: z.strictObject({ restoreId: digest }), output: result },
  { id: "agent.snapshot.confirm-native", readOnly: false, input: controlInput, output: result },
] as const;
export const LEGACY_SNAPSHOT_RESTORE_SCHEMA_VERSION = 1;
export const LEGACY_SNAPSHOT_RESTORE_TABLES = [
  "legacy_snapshot_restore_schema", "legacy_snapshot_restore_originals", "legacy_snapshot_restore_records",
  "legacy_snapshot_restore_staging", "legacy_snapshot_restore_receipts", "legacy_snapshot_restore_effects",
] as const;
export const legacySnapshotRestoreIntegration = Object.freeze({
  schemaVersion: LEGACY_SNAPSHOT_RESTORE_SCHEMA_VERSION,
  supported: ["source-qualified-quiescent-restore", "task-todos", "recipe-tree-remapping", "checkpoints",
    "validated-user-assistant-history", "explicit-native-controlled-resume", "native-confirmed-cancel", "explicit-native-confirmation"],
  unavailable: ["automatic-resume", "spawn", "production-models", "processes", "collaboration",
    "packed-messageHistory", "plans", "authVerifier", "credentials", "delegations", "unvalidated-budgets",
    "unrecognized-fields", "full-original-runtime-resume"],
  core: "parent authenticates actor and holds native owner lease; shared schema transaction; no transport wired",
  host: "resolveOwner/loadImportedSnapshot/epoch/key/approve/validateSafeState/assertBinding; native control optional",
  configuration: "native callbacks only; policySha256 and expiry pinned; no Magic Code authorization",
  pending: "effects in unknown state require native confirmation; restart never invokes an adapter",
  backup: "parent backs up all exported tables and Chat tables together; original ciphertext bytes immutable",
  acceptance: "formal-review seam only; not full Agents workstream acceptance or production switch",
});
