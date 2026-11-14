import { z } from "zod";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CoreError } from "./contracts.js";
import type { MarkdownRecord } from "./markdown.js";
import { buildProjectRecipeKnowledge, readProjectRecipes } from "./project-recipes.js";
import { projectRecipeSchema } from "./project-recipes-contracts.js";
import { compileWorkflowDefinitionV1 } from "./domain/project-recipes-workflow-contracts.js";
import { normalizeRecipeNodeBindings } from "./domain/workflow-compiler-bindings.js";
import { BUILTIN_NODE_KIND_IDS, createBuiltinNodeKindRegistry } from "./domain/workflow-compiler-catalog.js";
import { workflowPlan } from "./domain/workflow-compiler-plan.js";
import {
  WORKFLOW_COMPILER_LIMITS as L, workflowCompilerDefinitions, type WorkflowCompilerRequest,
} from "./workflow-compiler-contracts.js";

export { WORKFLOW_COMPILER_LIMITS, workflowCompilerDefinitions } from "./workflow-compiler-contracts.js";
export type { WorkflowCompilerOperation, WorkflowCompilerRequest } from "./workflow-compiler-contracts.js";

const registry = createBuiltinNodeKindRegistry(BUILTIN_NODE_KIND_IDS);
const compilerKinds = [
  "pkm.step.noop/v1", "pkm.step.command/v1", "pkm.step.script/v1", "pkm.step.pipeline/v1",
  "pkm.step.native/v1", "pkm.gate.human/v1", "pkm.subflow/v1",
];
function availability(kinds: string[]) {
  return [...new Set(kinds)].sort().map(kind => ({
    kind, runtimeAvailable: false as const, reason: "execution-not-migrated" as const,
    adapterClass: kind === "pkm.step.native/v1" ? "native" : registry[kind]!.adapterClass,
    requiredCapabilities: kind === "pkm.step.native/v1"
      ? ["pkm.capability.native"] : [...registry[kind]!.capabilityDeclarations],
    builtInOnly: kind === "pkm.step.native/v1",
  }));
}
function limit(message: string): never { throw new CoreError("RESOURCE_LIMIT", message); }

// Check depth/cycles before invoking recursive JSON schemas or the original canonicalizer.
function boundedJson(value: unknown, maximum: number): void {
  const stack = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let count = 0, textBytes = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++count > L.jsonValues || item.depth > L.jsonDepth) limit("Workflow JSON exceeds the value-count or nesting-depth limit.");
    if (typeof item.value === "string") {
      textBytes += Buffer.byteLength(item.value, "utf8");
      if (textBytes > maximum) limit("Workflow JSON exceeds the byte limit.");
      continue;
    }
    if (item.value === null || typeof item.value === "boolean") continue;
    if (typeof item.value === "number" && Number.isFinite(item.value)) continue;
    if (typeof item.value !== "object") throw new CoreError("INVALID_ARGUMENT", "Workflow input must be JSON.");
    if (seen.has(item.value)) throw new CoreError("INVALID_ARGUMENT", "Workflow input must not contain cycles or shared object references.");
    seen.add(item.value);
    const prototype = Object.getPrototypeOf(item.value);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
      throw new CoreError("INVALID_ARGUMENT", "Workflow input must contain only JSON objects.");
    }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item.value))) {
      if (Array.isArray(item.value) && key === "length") continue;
      if (!descriptor.enumerable || !("value" in descriptor)) throw new CoreError("INVALID_ARGUMENT", "Workflow input cannot contain accessors.");
      stack.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximum) limit("Workflow JSON exceeds the byte limit.");
}

function boundedGraph(value: unknown): void {
  const nodes = (value as { spec?: { nodes?: unknown } } | null)?.spec?.nodes;
  if (!Array.isArray(nodes)) return;
  if (nodes.length > L.nodes) limit(`Workflow exceeds ${L.nodes} nodes.`);
  let edges = 0;
  const outgoing = new Map<string, string[]>();
  const pending = new Map<string, number>();
  for (const node of nodes) {
    if (!node || typeof node !== "object" || typeof node.nodeId !== "string") continue;
    outgoing.set(node.nodeId, []);
    pending.set(node.nodeId, 0);
    if (Array.isArray(node.dependsOn)) edges += node.dependsOn.length;
  }
  if (edges > L.edges) limit(`Workflow exceeds ${L.edges} edges.`);
  for (const node of nodes) {
    if (!node || !Array.isArray(node.dependsOn) || !pending.has(node.nodeId)) continue;
    for (const dependency of node.dependsOn) {
      const termination = dependency?.loop?.termination;
      const terminating = typeof termination?.condition === "string" && !!termination.condition.trim()
        && Number.isSafeInteger(termination.maxIterations) && termination.maxIterations > 0;
      if (!dependency || terminating || !outgoing.has(dependency.from)) continue;
      outgoing.get(dependency.from)!.push(node.nodeId);
      pending.set(node.nodeId, pending.get(node.nodeId)! + 1);
    }
  }
  let ready = [...pending].filter(([, count]) => !count).map(([id]) => id);
  let depth = 0, visited = 0;
  while (ready.length) {
    if (++depth > L.dagDepth) limit(`Workflow exceeds DAG depth ${L.dagDepth}.`);
    visited += ready.length;
    const next: string[] = [];
    for (const id of ready) for (const target of outgoing.get(id)!) {
      pending.set(target, pending.get(target)! - 1);
      if (pending.get(target) === 0) next.push(target);
    }
    ready = next;
  }
  if (visited === pending.size) return;
  // Bound the original shortest-cycle witness search without replacing its diagnostics.
  let steps = 0;
  for (const id of outgoing.keys()) {
    const queue = [[id]];
    for (let index = 0; index < queue.length; index++) {
      if (++steps > L.cycleSearchSteps) limit("Workflow cyclic graph exceeds the cycle-search work limit.");
      const path = queue[index]!;
      for (const target of outgoing.get(path.at(-1)!)!) {
        if (!path.includes(target)) queue.push([...path, target]);
        if (queue.length > L.cycleSearchSteps) limit("Workflow cyclic graph exceeds the cycle-search work limit.");
      }
    }
  }
}

// The shared Recipe snapshot validates every source; bound definitions before that compiler runs.
function preflightRecipes(root: string): void {
  for (let ancestor = resolve(root); ; ancestor = dirname(ancestor)) {
    try {
      const stat = lstatSync(ancestor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoreError("INVALID_WORKSPACE", "Recipe root ancestors must be real directories.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(ancestor) === ancestor) break;
  }
  let entries = 0, bytes = 0;
  const walk = (directory: string, depth: number) => {
    if (depth > L.recipeDepth) limit(`Recipe source nesting exceeds ${L.recipeDepth} directories.`);
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoreError("INVALID_DOCUMENT", "Recipe source directories must not be symlinks.");
    const names = readdirSync(directory);
    entries += names.length;
    if (entries > L.recipeEntries) limit(`Recipe preflight exceeds ${L.recipeEntries} entries.`);
    for (const name of names) {
      const file = join(directory, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new CoreError("INVALID_DOCUMENT", "Recipe sources must not be symlinks.");
      if (stat.isDirectory()) { walk(file, depth + 1); continue; }
      if (!stat.isFile() || !name.endsWith(".json")) throw new CoreError("INVALID_DOCUMENT", "Recipe sources must be JSON files.");
      if (stat.size > L.inputBytes) limit("Recipe JSON exceeds the Workflow input byte limit.");
      bytes += stat.size;
      if (bytes > L.recipeBytes) limit("Recipe preflight exceeds 32 MiB.");
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) {
          throw new CoreError("CONFLICT", "Recipe source changed during preflight.");
        }
        const buffer = Buffer.alloc(Math.min(opened.size + 1, L.inputBytes + 1));
        let length = 0;
        while (length < buffer.length) {
          const count = readSync(fd, buffer, length, buffer.length - length, null);
          if (!count) break;
          length += count;
        }
        if (length !== opened.size) throw new CoreError("CONFLICT", "Recipe source changed during preflight.");
        const data = buffer.subarray(0, length);
        let value: unknown;
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)); }
        catch { throw new CoreError("INVALID_DOCUMENT", "Recipe source is not valid UTF-8 JSON."); }
        boundedJson(value, L.inputBytes);
        boundedGraph((value as { definition?: unknown } | null)?.definition);
      } finally { closeSync(fd); }
    }
  };
  try { walk(join(root, "recipes"), 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export function readWorkflowCompiler(
  root: string, request: WorkflowCompilerRequest, documents: MarkdownRecord[] = [],
  recipeOptions: Parameters<typeof readProjectRecipes>[3] = {},
): unknown {
  const descriptor = workflowCompilerDefinitions.find(item => item.id === String(request.operation));
  if (!descriptor) throw new CoreError("NOT_FOUND", "Unknown Workflow compiler read operation.");
  boundedJson(request.args, L.inputBytes);
  const parsed = descriptor.input.safeParse(request.args);
  if (!parsed.success) throw new CoreError("INVALID_ARGUMENT", z.prettifyError(parsed.error));
  if (request.operation === "workflow.compiler.capabilities") return checkedOutput(descriptor, {
    schema: "pkm.workflow.compiler.capabilities/v1", definitionSchema: "pkm.workflow.definition/v1",
    execution: "unavailable", formats: ["json-object"], limits: L, kinds: availability(compilerKinds),
    unavailable: ["run.create", "run.execute", "run.control", "definition.publish", "model", "provider", "network", "native-adapter", "subflow-execution"],
  });
  const args = parsed.data as z.infer<typeof workflowCompilerDefinitions[1]["input"]>;
  let definition: unknown;
  let source: Record<string, unknown>;
  let recipe: z.infer<typeof projectRecipeSchema> | undefined;
  if (args.source.kind === "inline") {
    definition = args.source.definition;
    source = { kind: "inline" };
  } else {
    preflightRecipes(root);
    const result = readProjectRecipes(root, { operation: "project.recipe.get", actorId: "workflow-compiler-read", args: {
      id: args.source.recipeId, expectedRevision: args.source.expectedRevision,
      expectedExecutableDigest: args.source.expectedExecutableDigest,
      ...(args.source.snapshotRevision ? { snapshotRevision: args.source.snapshotRevision } : {}),
    } }, documents, recipeOptions) as { item: z.infer<typeof projectRecipeSchema>; snapshotRevision: string };
    recipe = projectRecipeSchema.parse(result.item);
    definition = recipe.definition;
    source = { kind: "recipe", recipeId: recipe.recipeId, revision: recipe.revision,
      executableDigest: recipe.executableDigest, snapshotRevision: result.snapshotRevision };
    boundedJson(definition, L.inputBytes);
  }
  boundedGraph(definition);
  const compiled = compileWorkflowDefinitionV1(definition);
  if (!compiled.ok) return checkedOutput(descriptor, { status: "invalid", source, diagnostics: compiled.diagnostics });
  if (recipe && compiled.executableDigest !== recipe.executableDigest) throw new CoreError("CONFLICT", "Recipe executable digest changed.");
  const nodes = new Set(compiled.model.spec.nodes.map(node => node.nodeId));
  const nodeBindings = recipe?.nodeBindings ?? [];
  if (nodeBindings.some(node => !nodes.has(node.nodeId))) throw new CoreError("INVALID_DOCUMENT", "Recipe bindings reference an unknown node.");
  for (const node of nodeBindings) {
    if (new Set(node.bindings.map(binding => binding.bindingId)).size !== node.bindings.length) {
      throw new CoreError("INVALID_DOCUMENT", "Recipe binding identities are duplicated.");
    }
  }
  try { normalizeRecipeNodeBindings(nodeBindings, nodes); }
  catch (error) { throw new CoreError("INVALID_DOCUMENT", error instanceof Error ? error.message : "Invalid Recipe bindings."); }
  const knowledge = recipe ? buildProjectRecipeKnowledge(root, documents, [recipe]) : [];
  const result = {
    status: "valid", source, diagnostics: [], executableDigest: compiled.executableDigest,
    bindings: { status: knowledge.length ? "verified" : "none", nodes: nodeBindings.length, knowledge: knowledge.length },
    runtimeStatus: "not-runnable-here", availability: availability(compiled.model.spec.nodes.map(node => node.kind)),
  };
  if (request.operation === "workflow.definition.validate") return checkedOutput(descriptor, result);
  return checkedOutput(descriptor, {
    ...result, definition: compiled.model, canonicalJson: compiled.canonicalBytes.toString("utf8"),
    plan: workflowPlan(compiled.model, definition),
  });
}
function checkedOutput(descriptor: typeof workflowCompilerDefinitions[number], result: unknown): unknown {
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > L.outputBytes) limit("Workflow result exceeds the output byte limit; no partial result was returned.");
  const output = descriptor.output.safeParse(result);
  if (!output.success) throw new CoreError("INVALID_DOCUMENT", `Workflow compiler produced an invalid result: ${z.prettifyError(output.error)}`);
  return output.data;
}
