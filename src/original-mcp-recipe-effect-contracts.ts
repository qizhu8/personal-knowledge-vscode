import { z } from "zod";
import { resolve } from "node:path";
import { canonicalJson, compileWorkflowDefinitionV1 } from "./domain/project-recipes-workflow-contracts.js";
import { originalNativeRecipeSessionSchema, originalNativeRecipePayloadSchemas, originalNativeRecipeDigest } from "./original-mcp-native-recipe-contracts.js";
import { registeredPythonSelectionSchema } from "./host-python-environment.js";
import { resolveRuntimeNode, workflowRuntimeBindingsFromOriginalInputs } from "./domain/workflow-executor-bindings.js";
import { originalRecipeLoops } from "./domain/workflow-executor-original-loops.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.uuid();
export const originalRecipeEffectMethod = "recipe.effect.approve" as const;
export const recipeEffectFileSchema = z.strictObject({
  path: z.string().min(1).max(4096), sha256: digest, bytes: z.number().safe().int().positive(), identity: z.string().min(1).max(1024),
});
export const originalRecipeEffectRequest = z.strictObject({
  schema: z.literal("pkm.original-recipe-effect-request/v1"),
  root: z.string().min(1).max(4096), workspaceId: uuid, actorId: z.literal("mcp:external"),
  profileSha256: digest, epoch: uuid, sourcePlanSha256: digest, sourceRecordSha256: digest, nativeHostReceiptSha256: digest,
  recipeId: z.string().min(1).max(256), revision: z.number().safe().int().positive(), executableDigest: digest,
  runId: z.string().regex(/^recipe_run_[a-f0-9]{24}$/), nodeId: z.string().min(1).max(128), invocationId: uuid,
  definition: z.json(), inputs: z.record(z.string(), z.json()), inputsDigest: digest,
  sourceInputs: z.record(z.string(), z.json()), controlOutputs: z.record(z.string(), z.record(z.string(), z.json())),
  executionSemantics: z.enum(["static-original/v1", "original-recipe-metadata/v1", "native-runtime-bindings/v1"]),
  iteration: z.number().safe().int().min(0).max(1023), runtimeControl: z.json().nullable(),
  loopContext: z.array(z.strictObject({ loopId: z.string().min(1).max(256), iteration: z.number().safe().int().min(1).max(64),
    maxIterations: z.number().safe().int().min(1).max(64), condition: z.string().min(1).max(4096) })).max(64),
  program: z.string().min(1).max(4096).nullable(),
  deadline: z.number().safe().int().positive(),
  cwd: z.strictObject({ path: z.string().min(1).max(4096), identity: z.string().min(1).max(1024) }),
  arguments: z.array(z.string().max(32768)).max(128),
  executable: recipeEffectFileSchema.nullable(), sources: z.array(recipeEffectFileSchema).max(4),
  script: z.string().max(16384).nullable(), environmentId: z.string().max(128).nullable(),
  authority: z.strictObject({
    scope: z.literal("exact-recipe-owned-direct-child/v1"), shell: z.literal(false),
    inheritedEnvironment: z.literal(false), credentials: z.literal(false), automaticReplay: z.literal(false),
  }),
}).superRefine((value, context) => {
  const compiled = compileWorkflowDefinitionV1(value.definition);
  const node = compiled.ok && compiled.model.spec.nodes.find(item => item.nodeId === value.nodeId);
  if (!compiled.ok || compiled.executableDigest !== value.executableDigest || !node
    || node.kind !== "pkm.step.command/v1" && node.kind !== "pkm.step.script/v1"
    || value.executionSemantics === "static-original/v1" && node.control && node.control.mode !== "single"
    || node.dependsOn.some(edge => edge.loop) && value.executionSemantics !== "original-recipe-metadata/v1"
    || originalNativeRecipeDigest(value.inputs) !== value.inputsDigest
    || node.kind === "pkm.step.command/v1" && (!value.executable || value.script !== null || value.environmentId !== null)
    || node.kind === "pkm.step.script/v1" && (node.config.runtime !== "python"
      || node.config.environmentId !== value.environmentId || value.script === null || value.executable !== null))
    context.addIssue({ code: "custom", message: "Exact static Recipe effect definition/inputs binding required." });
  if (node && (node.kind === "pkm.step.command/v1" || node.kind === "pkm.step.script/v1")) {
    try {
      let control = node.control;
      if (value.executionSemantics === "original-recipe-metadata/v1") {
        const { dynamicCases: _dynamic, ...branch } = node.control?.mode === "branch" ? node.control : { dynamicCases: undefined };
        control = node.control?.mode === "repeat" ? { mode: "single" }
          : node.control?.mode === "branch" ? branch as typeof node.control : node.control;
      }
      else if (value.executionSemantics === "native-runtime-bindings/v1") {
        const bindings = workflowRuntimeBindingsFromOriginalInputs(compiled.ok ? compiled.model : value.definition as never, value.sourceInputs);
        if (!bindings) throw new Error("Explicit declared native control bindings are required.");
        control = resolveRuntimeNode(node, bindings, value.sourceInputs, Object.entries(value.controlOutputs)
          .map(([nodeId, outputs]) => ({ nodeId, outputs, state: "succeeded", effect: "known", iteration: 0 })), value.iteration).node.control;
      }
      if (canonicalJson(control ?? null) !== canonicalJson(value.runtimeControl)
        || value.executionSemantics === "original-recipe-metadata/v1" && value.iteration !== 0 && !value.loopContext.length)
        throw new Error("Exact execution semantics, iteration and resolved control are required.");
      const loops = value.executionSemantics === "original-recipe-metadata/v1" && compiled.ok
        ? originalRecipeLoops(compiled.model).filter(loop => loop.body.includes(value.nodeId)) : [];
      if (loops.length !== value.loopContext.length || loops.some(loop => {
        const context = value.loopContext.find(item => item.loopId === loop.loopId);
        return !context || context.condition !== loop.condition || context.maxIterations !== loop.maxIterations
          || context.iteration > loop.maxIterations;
      })) throw new Error("Exact bounded original loop context is required.");
      if (canonicalJson((node.config.args ?? []).map(arg => renderRecipeEffectText(arg, value.inputs))) !== canonicalJson(value.arguments)
        || resolve(value.root, renderRecipeEffectText(node.config.cwd || ".", value.inputs)) !== value.cwd.path
        || node.kind === "pkm.step.command/v1" && renderRecipeEffectText(node.config.program, value.inputs) !== value.program
        || node.kind === "pkm.step.script/v1" && value.program !== null
        || node.kind === "pkm.step.script/v1" && renderRecipeEffectText(node.config.script, value.inputs) !== value.script)
        throw new Error("Materialized command does not match the reviewed source.");
    } catch (error) { context.addIssue({ code: "custom", message: String(error) }); }
  }
});
export const originalRecipeEffectDecision = z.strictObject({
  schema: z.literal("pkm.original-recipe-effect-decision/v1"),
  scope: z.literal("exact-recipe-owned-direct-child/v1"),
  root: z.string(), workspaceId: uuid, actorId: z.literal("mcp:external"), profileSha256: digest, epoch: uuid,
  sourcePlanSha256: digest, sourceRecordSha256: digest, runId: z.string(), nodeId: z.string(), invocationId: uuid,
  requestSha256: digest, executableSha256: digest, decisionId: uuid, expiresAtMs: z.number().safe().int().positive(),
  environment: registeredPythonSelectionSchema.nullable(), automaticReplay: z.literal(false),
}).nullable();
export const originalRecipeEffectPayload = z.strictObject({
  binding: originalNativeRecipePayloadSchemas["recipe.source.approve"].shape.binding,
  request: originalRecipeEffectRequest,
});
export type OriginalRecipeEffectRequest = z.infer<typeof originalRecipeEffectRequest>;
export type OriginalRecipeEffectDecision = NonNullable<z.infer<typeof originalRecipeEffectDecision>>;
export function parseOriginalRecipeEffectPayload(value: unknown, inputSession: unknown) {
  const session = originalNativeRecipeSessionSchema.parse(inputSession), payload = originalRecipeEffectPayload.parse(value);
  const { binding, request } = payload, signed = session.binding;
  if (binding.root !== signed.root || binding.workspaceId !== signed.workspaceId || binding.planSha256 !== signed.planSha256
    || binding.profileSha256 !== signed.profileSha256 || binding.sourceCatalogSha256 !== signed.catalogSha256
    || binding.authorityId !== `native-rpc:${session.brokerId}` || binding.epoch !== session.activationId
    || request.root !== signed.root || request.workspaceId !== signed.workspaceId || request.profileSha256 !== signed.profileSha256
    || request.epoch !== session.activationId || session.epoch !== session.activationId)
    throw new Error("NATIVE_RECIPE_EFFECT_BINDING_MISMATCH");
  return payload;
}
export function assertOriginalRecipeEffectDecision(input: unknown, request: OriginalRecipeEffectRequest): OriginalRecipeEffectDecision | null {
  const decision = originalRecipeEffectDecision.parse(input);
  if (!decision) return null;
  if (decision.root !== request.root || decision.workspaceId !== request.workspaceId || decision.actorId !== request.actorId
    || decision.profileSha256 !== request.profileSha256 || decision.epoch !== request.epoch
    || decision.sourcePlanSha256 !== request.sourcePlanSha256 || decision.sourceRecordSha256 !== request.sourceRecordSha256
    || decision.runId !== request.runId || decision.nodeId !== request.nodeId || decision.invocationId !== request.invocationId
    || decision.requestSha256 !== originalNativeRecipeDigest(request) || decision.expiresAtMs <= Date.now()
    || decision.expiresAtMs > request.deadline || decision.expiresAtMs > Date.now() + 300000
    || request.executable && (decision.executableSha256 !== request.executable.sha256 || decision.environment !== null)
    || request.environmentId && (!decision.environment || decision.environment.handle.environmentId !== request.environmentId
      || decision.environment.handle.workspaceId !== request.workspaceId || decision.environment.handle.actorId !== request.actorId))
    throw new Error("NATIVE_RECIPE_EFFECT_DECISION_MISMATCH");
  return decision;
}
export function renderRecipeEffectText(text: string, inputs: Record<string, unknown>) {
  return text.replace(/\$\{inputs\.([A-Za-z][A-Za-z0-9._-]{0,127})\}/g, (_match, key: string) => {
    let value: unknown = inputs;
    for (const part of key.split(".")) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, part))
        throw new Error("Recipe command references missing input: " + key);
      value = (value as Record<string, unknown>)[part];
    }
    return value === null ? "" : typeof value === "string" ? value : canonicalJson(value);
  });
}
