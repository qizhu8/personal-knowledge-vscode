import { z } from "zod";
import { assertReportedRecipeNumbers } from "./legacy-recipe-reported-usage.js";

type Json = Record<string, any>;
const object = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const terminal = new Set(["succeeded", "failed", "skipped"]);
const blocked = "BLOCKED: Recipe inspection requires unavailable live reconciliation or terminal health authority; only already-finalized terminal runs are supported.";
export const originalRecipeRunGetInput = z.strictObject({ run_id: z.string(), detail: z.string().default("full") });
export const originalRecipeRunIdentity = z.string().regex(/^recipe_run_[\p{L}\p{N}_-]*$/u);
function integer(value: unknown = 0): number {
  const parsed = typeof value === "boolean" ? Number(value) : typeof value === "number" ? Math.trunc(value)
    : typeof value === "string" && /^[+-]?\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed)) throw new Error("BLOCKED: Original Recipe numeric accounting exceeds the native exact-integer envelope.");
  return parsed;
}
export function originalRecipeResponseDetail(value: string) {
  const detail = (value || "full").trim().toLowerCase();
  if (!["compact", "full"].includes(detail)) throw new Error("detail must be compact or full.");
  return detail;
}
export function parseOriginalTerminalRecipeRecord(runId: string, value: unknown): Json {
  assertReportedRecipeNumbers(value, "Original finalized Recipe record");
  if (!object(value) || value.schema !== "pkm.recipe.run/v1") throw new Error("Recipe run schema is unsupported.");
  if (value.runId !== runId) throw new Error("BLOCKED: Admitted Recipe run identity does not match its stored identity.");
  const run = value, nodes = run.definition?.spec?.nodes, records = run.nodes;
  if (!["completed", "failed"].includes(run.status) || !object(run.healthReceipt) || !Object.keys(run.healthReceipt).length || !Array.isArray(nodes)
    || !object(records) || !Array.isArray(run.definition?.spec?.completion?.requiredNodes)
    || nodes.some(node => !object(node) || typeof node.nodeId !== "string")
    || new Set(nodes.map(node => node.nodeId)).size !== nodes.length || Object.keys(records).length !== nodes.length
    || nodes.some(node => !Object.hasOwn(records, node.nodeId))
    || Object.values(records).some(node => !object(node) || !terminal.has(node.state))
    || run.definition.spec.completion.requiredNodes.some((id: unknown) => typeof id !== "string" || !Object.hasOwn(records, id)
      || run.status === "completed" && records[id].state !== "succeeded"))
    throw new Error(blocked);
  if (typeof run.recipeId !== "string" || !Number.isSafeInteger(run.version) || run.version < 1
    || !(run.recipeRevision === null || Number.isSafeInteger(run.recipeRevision))
    || typeof run.executableDigest !== "string") throw new Error("BLOCKED: Original Recipe terminal identity is malformed.");
  // Keep archived background/subflow ownership outside this source-only read slice.
  if (nodes.some(node => object(records[node.nodeId].background) || records[node.nodeId].childRunId))
    throw new Error("BLOCKED: Original Recipe command/subflow reconciliation requires a separately admitted native continuation.");
  return structuredClone(run);
}
function compare(left: string, right: string) {
  const a = Array.from(left, c => c.codePointAt(0)!), b = Array.from(right, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}
function usage(run: Json) {
  const value = run.usage || {}, measured = { input_tokens: 0, output_tokens: 0, total_tokens: 0,
    cached_input_tokens: 0, reasoning_tokens: 0, ...value.measuredTokens };
  for (const count of Object.values(measured)) integer(count);
  const costs = value.derivedCosts || {};
  if (!object(costs) || !Array.isArray(value.providers || []) || !Array.isArray(value.models || [])
    || !Array.isArray(value.records || [])) throw new Error("BLOCKED: Original Recipe usage has unsupported shape.");
  return {
    measured_tokens: measured, measured_total_tokens: measured.total_tokens,
    estimated_tokens: integer(value.estimatedTokens ?? 0), unknown_model_calls: integer(value.unknownModelCalls ?? 0),
    derived_cost_micros_by_currency: Object.fromEntries(Object.keys(costs).sort(compare).slice(0, 32).map(key => [key, costs[key]])),
    providers: (value.providers || []).slice(0, 32), models: (value.models || []).slice(0, 32),
    protocol_payload_estimate: { estimated_tokens: integer(value.protocolPayloadEstimate?.estimatedTokens ?? 0),
      method: "utf8-bytes-divided-by-4" },
    reported_attempts: integer(value.reportedAttempts ?? 0), records_retained: (value.records || []).length,
    records_truncated: integer(value.recordsTruncated ?? 0),
  };
}
/** Original _run_response projection only; never synchronizes, advances, locks, finalizes or executes. */
export function projectOriginalTerminalRecipeRun(run: Json, detail: "compact" | "full") {
  const records = run.nodes as Record<string, Json>, nodes = run.definition.spec.nodes as Json[];
  const counts: Record<string, number> = Object.fromEntries(["pending", "running", "succeeded", "failed"].map(state =>
    [state, Object.values(records).filter(record => record.state === state).length]));
  const skipped = Object.values(records).filter(record => record.state === "skipped").length;
  if (skipped) counts.skipped = skipped;
  const current: Json = { counts, progress: { completed: Object.keys(records).length, total: Object.keys(records).length,
    percent: 100, running_node_id: null } };
  if (run.loops && Object.keys(run.loops).length) current.control_state = { loops: Object.values(run.loops) };
  const response: Json = { schema: "pkm.recipe.api/v1", ok: true, run_id: run.runId, status: run.status, version: run.version,
    current_result: current, next_action: { kind: "none", reason: run.status === "completed" ? "recipe-completed" : "recipe-failed" },
    replayed: false };
  if (run.automation && Object.keys(run.automation).length) response.automation = run.automation;
  if (detail === "full") {
    current.completed_nodes = nodes.map(node => {
      const record = records[node.nodeId]!;
      return { node_id: node.nodeId, outcome: Object.hasOwn(record, "outcome") ? record.outcome : record.state,
        result: record.result ?? null, error: record.error ?? null };
    });
    response.recipe = { recipe_id: run.recipeId, revision: run.recipeRevision, executable_digest: run.executableDigest };
    response.usage = usage(run);
  }
  return response;
}
