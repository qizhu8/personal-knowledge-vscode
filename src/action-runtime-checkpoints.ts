import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { CoreError } from "./contracts.js";
import { originalDigest, schemaValueErrors } from "./domain/action-compiler-validation.js";
export { checkpointResponse } from "./action-runtime-contracts.js";

const trigger = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("human") }),
  z.strictObject({ kind: z.literal("event"), name: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal("timer"), at: z.number().finite().nonnegative() }),
  z.strictObject({ kind: z.literal("dependency"), run_id: z.string().min(1),
    expected_version: z.number().safe().int().positive(), invocation_fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
]);
export const actionCheckpoint = z.strictObject({
  schema: z.literal("pkm.action.checkpoint/v1"),
  checkpoint_id: z.string().regex(/^checkpoint_[a-f0-9]{32}$/), run_id: z.string(), step: z.string(),
  kind: z.enum(["input", "approval", "artifact-review", "decision", "exception"]),
  state: z.enum(["waiting", "resolved", "expired", "cancelled"]),
  proposal: z.json(), proposal_digest: z.string().regex(/^[a-f0-9]{64}$/),
  evidence: z.array(z.json()), owner: z.string().min(1).max(256),
  created_at: z.number(), deadline: z.number().nullable(), timeout_behavior: z.enum(["review", "cancel"]),
  resume_token: z.string().regex(/^[a-f0-9]{48}$/), answer_schema: z.record(z.string(), z.json()),
  trigger, presentation: z.literal("json"), remaining_seconds: z.number().nonnegative(),
  answer: z.record(z.string(), z.json()).optional(), answer_digest: z.string().optional(),
  resolved_at: z.number().optional(), event_key: z.string().optional(),
  dispatch_at: z.number().finite().optional(),
});
export type ActionCheckpoint = z.infer<typeof actionCheckpoint>;
export function newActionCheckpoint(runId: string, nodeId: string, component: string,
  inputs: Record<string, unknown>, now: number, deadline: number): ActionCheckpoint {
  const waiting = component === "core.wait";
  const proposal = waiting ? { trigger: inputs.trigger } : inputs.proposal;
  const value = actionCheckpoint.parse({
    schema: "pkm.action.checkpoint/v1", checkpoint_id: `checkpoint_${randomUUID().replaceAll("-", "")}`,
    run_id: runId, step: nodeId, kind: waiting ? "decision" : inputs.kind,
    state: "waiting", proposal, proposal_digest: originalDigest(proposal), evidence: inputs.evidence ?? [],
    owner: waiting ? "scheduler" : inputs.owner ?? "user", created_at: now / 1000,
    deadline: inputs.deadline ?? null, timeout_behavior: inputs.timeout_behavior ?? "review",
    resume_token: randomBytes(24).toString("hex"), answer_schema: inputs.answer_schema ?? { type: "object" },
    trigger: waiting ? trigger.parse(inputs.trigger) : { kind: "human" }, presentation: "json",
    remaining_seconds: Math.max(0, deadline - now) / 1000,
  });
  if (!value.owner.trim() || Buffer.byteLength(JSON.stringify(value)) > 65_536)
    throw new CoreError("INVALID_ARGUMENT", "Checkpoint owner or proposal exceeds its bounds.");
  if (waiting && value.trigger.kind === "human")
    throw new CoreError("INVALID_ARGUMENT", "A durable wait requires a timer, event or dependency trigger.");
  try { new AjvJsonSchemaValidator().getValidator(value.answer_schema); }
  catch { throw new CoreError("INVALID_ARGUMENT", "Invalid checkpoint answer schema."); }
  return value;
}
export function checkActionCheckpointAnswer(checkpoint: ActionCheckpoint, answer: Record<string, unknown>) {
  if (schemaValueErrors(checkpoint.answer_schema, answer).length
    || !new AjvJsonSchemaValidator().getValidator(checkpoint.answer_schema)(answer).valid)
    throw new CoreError("INVALID_ARGUMENT", "Checkpoint answer violates its pinned answer schema.");
  if (Buffer.byteLength(JSON.stringify(answer)) > 65_536)
    throw new CoreError("RESOURCE_LIMIT", "Checkpoint answer exceeds 64 KiB.");
}
