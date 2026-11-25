import { z } from "zod";
import { CoreError } from "../host-composition-legacy-batch15-errors.js";
import type { WorkflowDefinitionV1, WorkflowNodeV1 } from "./project-recipes-workflow-contracts.js";
import { normalizeTypedValue } from "./project-recipes-value-contracts.js";
import type { Step } from "./workflow-executor-state.js";
import { WORKFLOW_EXECUTOR_LIMITS as L } from "./workflow-executor-limits.js";

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/);
export const workflowValueBinding = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("input"), name: id }),
  z.strictObject({ kind: z.literal("node-output"), nodeId: id, output: id }),
]);
export const workflowRuntimeBindings = z.strictObject({
  nodes: z.record(id, z.strictObject({
    repeat: z.strictObject({ source: workflowValueBinding,
      semantics: z.enum(["count", "collection"]), itemInput: id.optional() }).optional(),
    cases: workflowValueBinding.optional(),
  })).default({}),
  outputs: z.record(id, workflowValueBinding).default({}),
  trigger: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("manual") }),
    z.strictObject({ mode: z.literal("automation"), consentId: z.uuid(),
      dueAt: z.number().safe().int().positive(), expiresAt: z.number().safe().int().positive(),
      maxLatenessMs: z.number().safe().int().min(0).max(60_000) }),
  ]).optional(),
});
export type WorkflowRuntimeBindings = z.infer<typeof workflowRuntimeBindings>;
export const ORIGINAL_RECIPE_METADATA_SEMANTICS = "original-recipe-metadata/v1" as const;
const originalControlsEnvelope = z.strictObject({
  schema: z.literal("pkm.workflow.runtime-controls/v1"), bindings: workflowRuntimeBindings,
});
export function workflowRuntimeBindingsFromOriginalInputs(
  definition: WorkflowDefinitionV1, inputs: Record<string, unknown>,
): WorkflowRuntimeBindings | undefined {
  const descriptor = definition.spec.inputs.workflowControls;
  if (!descriptor || descriptor.type !== "string" || !descriptor.required
    || !Object.hasOwn(inputs, "workflowControls")) return undefined;
  const text = normalizeTypedValue(descriptor, inputs.workflowControls);
  if (typeof text !== "string") return undefined;
  let candidate: unknown;
  try { candidate = JSON.parse(text); } catch { return undefined; }
  if (!candidate || typeof candidate !== "object"
    || (candidate as { schema?: unknown }).schema !== "pkm.workflow.runtime-controls/v1") return undefined;
  const envelope = originalControlsEnvelope.parse(candidate);
  validateRuntimeBindings(definition, envelope.bindings);
  return envelope.bindings;
}
type ValueBinding = z.infer<typeof workflowValueBinding>;
const invalid = (message: string): never => { throw new CoreError("RUNTIME_BINDING_INVALID", message); };
export function bindingValue(binding: ValueBinding, inputs: Record<string, unknown>, steps: Step[]): unknown {
  const values = binding.kind === "input" ? inputs : steps.find(step => step.nodeId === binding.nodeId && step.state === "succeeded")?.outputs;
  const key = binding.kind === "input" ? binding.name : binding.output;
  if (!values || !Object.hasOwn(values, key)) return invalid("Runtime binding has no authoritative value.");
  return values[key];
}
export function validateRuntimeBindings(definition: WorkflowDefinitionV1, bindings: WorkflowRuntimeBindings) {
  const nodes = definition.spec.nodes;
  function source(binding: ValueBinding, node?: WorkflowNodeV1) {
    if (binding.kind === "input") {
      if (!Object.hasOwn(definition.spec.inputs, binding.name)) invalid("Binding references an undeclared input.");
    } else {
      const producer = nodes.find(item => item.nodeId === binding.nodeId);
      if (!producer || !producer.ports?.outputs.includes(binding.output)) invalid("Binding references an undeclared output port.");
      if (node && !node.dependsOn.some(edge => !edge.loop && edge.from === binding.nodeId
        && edge.accept.length === 1 && edge.accept[0] === "succeeded")) invalid("Control producer requires a succeeded dependency.");
    }
  }
  for (const key of Object.keys(bindings.nodes)) if (!nodes.some(node => node.nodeId === key)) invalid("Unknown control node.");
  for (const node of nodes) {
    const binding = bindings.nodes[node.nodeId];
    const repeat = node.control?.mode === "repeat" && node.control.count.kind === "dynamic";
    const cases = node.control?.mode === "branch" && node.control.dynamicCases;
    if (!!binding?.repeat !== !!repeat || !!binding?.cases !== !!cases) invalid("Every dynamic control requires exactly its explicit binding.");
    if (binding?.repeat) {
      source(binding.repeat.source, node);
      if (binding.repeat.semantics === "collection" && !binding.repeat.itemInput) invalid("Collection repeat requires an explicit item input.");
      if (binding.repeat.itemInput && !node.ports?.inputs.includes(binding.repeat.itemInput)) invalid("Repeat item input is undeclared.");
    }
    if (binding?.cases) source(binding.cases, node);
  }
  for (const [name, binding] of Object.entries(bindings.outputs)) {
    if (!Object.hasOwn(definition.spec.outputs, name)) invalid("Unknown run output binding.");
    source(binding);
  }
  for (const [name, descriptor] of Object.entries(definition.spec.outputs)) {
    if (!bindings.outputs[name] && descriptor.required && descriptor.default === undefined) invalid("Required run output needs an explicit source.");
  }
  if (!!definition.spec.trigger !== !!bindings.trigger) invalid("Cron definitions require an explicit manual or automation delivery choice.");
}
export function resolveRuntimeNode(node: WorkflowNodeV1, bindings: WorkflowRuntimeBindings,
  inputs: Record<string, unknown>, steps: Step[], iteration: number): { node: WorkflowNodeV1; inputs: Record<string, unknown> } {
  const binding = bindings.nodes[node.nodeId];
  let resolved = node;
  if (binding?.repeat) {
    const value = bindingValue(binding.repeat.source, inputs, steps);
    const count = binding.repeat.semantics === "collection" ? Array.isArray(value) ? value.length : NaN
      : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(count) || Number(count) < 1 || Number(count) > L.iterations) invalid("Dynamic repeat count must be 1–64; empty collections do not imply success.");
    if (binding.repeat.semantics === "collection") inputs = { ...inputs, [binding.repeat.itemInput!]: (value as unknown[])[iteration] };
    resolved = { ...resolved, control: { mode: "repeat", count: { kind: "fixed", value: Number(count) } } };
  }
  if (binding?.cases) {
    const cases = bindingValue(binding.cases, inputs, steps);
    const control = node.control;
    if (control?.mode !== "branch") return invalid("Cases require a branch control.");
    if (!Array.isArray(cases) || !cases.length || new Set(cases).size !== cases.length
      || cases.some(item => typeof item !== "string" || !control.cases.includes(item))) invalid("Dynamic cases must be a nonempty unique subset of declared graph outcomes.");
    resolved = { ...resolved, control: { ...control, cases: cases as string[], dynamicCases: true } };
  }
  return { node: resolved, inputs };
}
export function resolveRunOutputs(definition: WorkflowDefinitionV1, bindings: WorkflowRuntimeBindings,
  inputs: Record<string, unknown>, steps: Step[]) {
  const outputs: Record<string, unknown> = {};
  for (const [name, descriptor] of Object.entries(definition.spec.outputs)) {
    const value = bindings.outputs[name] ? bindingValue(bindings.outputs[name], inputs, steps) : descriptor.default;
    if (value === undefined) { if (descriptor.required) invalid("Required run output is missing."); continue; }
    outputs[name] = normalizeTypedValue(descriptor, value);
  }
  return outputs;
}
