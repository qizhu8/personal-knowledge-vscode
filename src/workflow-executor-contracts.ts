import { z } from "zod";
import { workflowCompilerSource } from "./workflow-compiler-contracts.js";

export const WORKFLOW_EXECUTOR_LIMITS = Object.freeze({
  steps: 1024, iterations: 64, outputBytes: 65_536, snapshotBytes: 1_048_576,
  events: 8192, runs: 4096, receipts: 16_384, assignmentsPerRun: 2048,
  leaseMs: 300_000, deadlineMs: 86_400_000,
});
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const workflowExecutorCreate = z.strictObject({
  operationId: z.uuid(), runId: id, source: workflowCompilerSource,
  expectedExecutableDigest: digest, deadline: z.number().safe().int().positive(),
  inputs: z.record(z.string(), z.json()).default({}),
});
export const workflowExecutorCancel = z.strictObject({
  operationId: z.uuid(), runId: id, expectedVersion: z.number().safe().int().positive(),
});
export const workflowExecutorResult = z.strictObject({
  status: z.enum(["succeeded", "failed", "unknown"]),
  outputs: z.record(z.string(), z.json()),
  branch: z.string().optional(),
  termination: z.record(z.string(), z.boolean()).optional(),
});
export const workflowExecutorView = z.strictObject({
  schema: z.literal("pkm.workflow.executor.run/v1"),
  runId: id, version: z.number().int().positive(),
  state: z.enum(["ready", "running", "succeeded", "failed", "cancelled", "unknown"]),
  executableDigest: digest, source: z.json(), deadline: z.number().int(),
  steps: z.number().int().nonnegative(),
  nodes: z.array(z.strictObject({
    nodeId: id, state: z.enum(["pending", "offered", "claimed", "running", "succeeded", "failed", "skipped", "cancelled", "unknown"]),
    iteration: z.number().int().nonnegative(), effect: z.enum(["not-started", "known", "unknown"]),
    outputs: z.record(z.string(), z.json()), branch: z.string().optional(),
  })),
  execution: z.literal("native-injected"),
  dispatchMode: z.literal("explicit").optional(),
});
export const workflowExecutorDefinitions = [
  {
    id: "workflow.executor.create", readOnly: false,
    description: "Pin a compiled definition and exact installed native adapter contracts. Creates intent only; no step dispatch in the public transaction.",
    input: workflowExecutorCreate, output: workflowExecutorView,
  },
  {
    id: "workflow.executor.get", readOnly: true,
    description: "Read an owned durable native-executor run, including interrupted unknown effects.",
    input: z.strictObject({ runId: id }), output: workflowExecutorView,
  },
  {
    id: "workflow.executor.cancel", readOnly: false,
    description: "Fence future step results. Running distributed effects remain unknown; cancellation does not prove rollback.",
    input: workflowExecutorCancel, output: workflowExecutorView,
  },
] as const;
export type WorkflowExecutorCreate = z.input<typeof workflowExecutorCreate>;
export type WorkflowExecutorCancel = z.infer<typeof workflowExecutorCancel>;
export type WorkflowStepResult = z.infer<typeof workflowExecutorResult>;
