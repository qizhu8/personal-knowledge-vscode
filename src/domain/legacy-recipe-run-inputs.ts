import type { WorkflowDefinitionV1 } from "./project-recipes-workflow-contracts.js";
import { normalizeTypedValue } from "./project-recipes-value-contracts.js";

export function normalizeLegacyRecipeInputs(definition: WorkflowDefinitionV1, text: string): Record<string, unknown> {
  let supplied: unknown;
  try { supplied = JSON.parse(text || "{}"); }
  catch (error) { throw new Error(`inputs_json must be valid JSON: ${error instanceof Error ? error.message : "Invalid JSON"}`); }
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw new Error("inputs_json must decode to dict");
  const input = supplied as Record<string, unknown>, inputs: Record<string, unknown> = Object.create(null);
  if (!Object.keys(definition.spec.inputs).length) Object.assign(inputs, input);
  else for (const key of Object.keys(input))
    if (!Object.hasOwn(definition.spec.inputs, key)) throw new Error(`/inputs contains unknown fields: ${key}.`);
  for (const [key, descriptor] of Object.entries(definition.spec.inputs)) {
    const item = Object.hasOwn(input, key) ? input[key] : descriptor.default;
    if (item === undefined) { if (descriptor.required) throw new Error(`Required input missing: ${key}.`); continue; }
    inputs[key] = normalizeTypedValue(descriptor, item);
  }
  return inputs;
}
