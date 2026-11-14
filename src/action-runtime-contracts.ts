import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/);
const source = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("inline"), definition: z.json() }),
  z.strictObject({
    kind: z.literal("moduleSet"), manifest: z.json(), files: z.record(z.string(), z.string()),
    enabled: z.boolean().optional(),
  }),
]);
const node = z.strictObject({
  nodeId: identity,
  state: z.enum(["pending", "running", "succeeded", "failed", "skipped", "cancelled", "unknown"]),
  reason: z.enum(["ACTION_EFFECT_CONSENT_REQUIRED", "ACTION_RESULT_PROTOCOL_INVALID",
    "ACTION_RESULT_PROTOCOL_OVERSIZED", "ACTION_RESULT_REPORTED_FAILURE", "ACTION_RESULT_REPORTED_BLOCKED",
    "ACTION_RESULT_ARTIFACT_UNSUPPORTED", "ACTION_COMPONENT_UNSUPPORTED", "ACTION_ARTIFACT_INPUT_UNAVAILABLE", "ACTION_ARTIFACT_QUOTA_EXCEEDED",
    "ACTION_BUILD_FAILED", "ACTION_BUILD_INTERRUPTED", "ACTION_BUILD_CHANGED", "ACTION_BUILD_OUTPUT_INVALID"]).optional(),
});
export type ActionNodeReason = NonNullable<z.infer<typeof node>["reason"]>;
export const ACTION_RUNTIME_LIMITS = Object.freeze({
  runs: 4096, events: 8192, steps: 1024, outputBytes: 65_536,
  snapshotBytes: 67_108_864, inputBytes: 67_108_864, deadlineMs: 86_400_000,
  jsonDepth: 32, jsonValues: 32_768, receipts: 16_384, drainMs: 5000,
});
const create = z.strictObject({
  operationId: z.uuid(), runId: identity, source, expectedDefinitionDigest: digest,
  deadline: z.number().safe().int().positive(), inputs: z.record(z.string(), z.json()).default({}),
});
const cancel = z.strictObject({
  operationId: z.uuid(), runId: identity, expectedVersion: z.number().safe().int().positive(),
});
const view = z.strictObject({
  schema: z.literal("pkm.action.runtime.run/v1"),
  runId: identity, version: z.number().safe().int().positive(),
  state: z.enum(["ready", "running", "succeeded", "failed", "cancelled", "cancelling", "unknown"]),
  actionId: z.string(), actionVersion: z.number().int(), definitionDigest: digest,
  source: z.json(), deadline: z.number().safe().int(), nodes: z.array(node),
  execution: z.literal("native-action-plan"),
});
const events = z.strictObject({
  runId: identity, after: z.number().safe().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(100),
});
const eventPage = z.strictObject({
  runId: identity, items: z.array(z.strictObject({
    sequence: z.number().int().positive(), kind: z.enum([
      "created", "run-started", "node-started", "node-succeeded", "node-failed",
      "node-skipped", "node-cancelled", "node-unknown", "run-succeeded", "run-failed",
      "run-cancelled", "run-unknown", "cancel-requested",
    ]),
    version: z.number().int().positive(), at: z.number().safe().int(),
    nodeId: identity.optional(),
    state: z.enum(["ready", "running", "succeeded", "failed", "cancelled", "cancelling", "unknown", "pending", "skipped"]),
  })).max(100),
  oldestSequence: z.number().int().nonnegative(), latestSequence: z.number().int().nonnegative(), gap: z.boolean(),
});

export const actionRuntimeDefinitions = [
  {
    id: "action.runtime.create", readOnly: false,
    description: "Create an actor-owned durable run from an original Action compiler source pinned to its exact definition digest.",
    input: create, output: view,
  },
  { id: "action.runtime.get", readOnly: true, description: "Read a gated Action run without exposing native step outputs.", input: z.strictObject({ runId: identity }), output: view },
  { id: "action.runtime.events", readOnly: true, description: "Read bounded, redacted Action node lifecycle events.", input: events, output: eventPage },
  {
    id: "action.runtime.cancel", readOnly: false,
    description: "Fence future Action dispatch and cancel owned work; started effects are unknown unless a strict receipt proves completion.",
    input: cancel, output: view,
  },
] as const;
export type ActionRuntimeOperation = typeof actionRuntimeDefinitions[number]["id"];
export type ActionRuntimeCreate = z.input<typeof create>;
export type ActionRuntimeCancel = z.infer<typeof cancel>;
export type ActionRuntimeRequest = { operation: ActionRuntimeOperation; args: unknown };
export type ActionRuntimeView = z.infer<typeof view>;
export type ActionRuntimeEventPage = z.infer<typeof eventPage>;
