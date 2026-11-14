import { z } from "zod";
import { workflowCompilerSource } from "./workflow-compiler-contracts.js";

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().safe().positive();
const node = z.strictObject({
  nodeId: id, state: z.enum(["pending", "attempting", "waiting-retry", "checkpointed", "paused",
    "reconciling", "blocked", "succeeded", "failed", "cancelled"]), version,
  attemptId: z.string().optional(),
});
export const workflowRuntimeRun = z.strictObject({
  runId: id, version, state: z.enum(["ready", "running", "blocked", "succeeded", "failed", "cancelled"]),
  executableDigest: digest, definitionDigest: digest, definition: z.json(),
  source: z.json(), nodes: z.array(node), deadline: z.number().finite(),
  execution: z.literal("host-only-noop"),
});
const lookup = { runId: id };
const mutation = { operationId: z.string().uuid() };
export const workflowRuntimeDefinitions = [
  {
    id: "workflow.run.create", readOnly: false,
    description: "Pin a compiled definition and exact executable digest in a durable actor-scoped run. Does not execute steps. Only single-pass noop DAGs are runnable by the trusted host; other definitions remain blocked.",
    input: z.strictObject({ ...lookup, ...mutation, source: workflowCompilerSource,
      expectedExecutableDigest: digest, deadline: z.number().finite().positive() }),
    output: workflowRuntimeRun,
  },
  { id: "workflow.run.get", readOnly: true, description: "Read a durable actor-scoped pinned run; never recompile.",
    input: z.strictObject(lookup), output: workflowRuntimeRun },
  { id: "workflow.run.events", readOnly: true, description: "Read ordered committed events, pinned to a run version.",
    input: z.strictObject({ ...lookup, expectedVersion: version, after: z.number().int().safe().nonnegative().default(0),
      limit: z.number().int().min(1).max(100).default(50) }),
    output: z.strictObject({ runId: id, version, items: z.array(z.strictObject({
      sequence: version, kind: z.string(), version, nodeId: id.optional(), state: z.string(),
    })), nextAfter: z.number().int().safe().nonnegative().nullable() }) },
  { id: "workflow.run.ready-nodes", readOnly: true, description: "Inspect deterministic dependency order. Blocked/terminal runs have no runnable nodes.",
    input: z.strictObject({ ...lookup, expectedVersion: version }),
    output: z.strictObject({ runId: id, version, nodes: z.array(id) }) },
  { id: "workflow.run.cancel", readOnly: false, description: "Cancel a nonterminal side-effect-free run using an exact version. No provider or approval effects.",
    input: z.strictObject({ ...lookup, ...mutation, expectedVersion: version }), output: workflowRuntimeRun },
] as const;
export type WorkflowRuntimeRequest = {
  operation: typeof workflowRuntimeDefinitions[number]["id"];
  args: Record<string, unknown>;
};
