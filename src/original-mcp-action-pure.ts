import { z } from "zod";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { ACTION_COMPILER_LIMITS as L } from "./action-compiler-contracts.js";
import { compileActionGraph } from "./domain/action-compiler-graph.js";
import {
  actionComponents, actionDefinitionDiagnostics, schemaValueErrors, type ActionDiagnostic,
} from "./domain/action-compiler-validation.js";
import { ORIGINAL_LEGACY_ACTION_MCP } from "./domain/legacy-action-mcp-original.js";

type Json = Record<string, unknown>;
const object = z.record(z.string(), z.json());
const request = z.discriminatedUnion("tool", [
  z.strictObject({ tool: z.literal("action_templates"), arguments: z.strictObject({}) }),
  z.strictObject({ tool: z.literal("action_definition_check"), arguments: z.strictObject({ definition: object }) }),
  z.strictObject({ tool: z.literal("action_graph_check"), arguments: z.strictObject({ graph: object }) }),
]);

// Only this operation is complete without the original registry, settings or readiness history.
export const originalMcpPureActionOperationIds: readonly string[] = Object.freeze(["mcp.tool.action_templates"]);

export function originalMcpPureActionTool(tool: string): boolean {
  return ["action_templates", "action_definition_check", "action_graph_check"].includes(tool);
}

function isObject(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function runtimeRequired(reason: string): never {
  throw new CoreError("NATIVE_AUTHORITY_REQUIRED", `ACTION_FULL_RUNTIME_REQUIRED: ${reason}`);
}

function boundedInput(value: unknown): void {
  const pending = [{ value, depth: 0 }], seen = new Set<object>();
  let count = 0, bytes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > L.jsonValues || item.depth > L.jsonDepth || bytes > L.inputBytes)
      throw new CoreError("RESOURCE_LIMIT", "Action JSON exceeds the value-count, nesting-depth or byte limit.");
    if (item.value === null || typeof item.value === "boolean") continue;
    if (typeof item.value === "string") { bytes += Buffer.byteLength(item.value); continue; }
    if (typeof item.value === "number") {
      if (!Number.isFinite(item.value) || Number.isInteger(item.value) && !Number.isSafeInteger(item.value))
        throw new CoreError("INVALID_ARGUMENT", "Action JSON numbers must be finite and safe integers where integral.");
      continue;
    }
    if (typeof item.value !== "object" || seen.has(item.value))
      throw new CoreError("INVALID_ARGUMENT", "Action input must be JSON without cycles or shared object references.");
    seen.add(item.value);
    if (![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(item.value)))
      throw new CoreError("INVALID_ARGUMENT", "Action input must contain only JSON objects.");
    for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(item.value))) {
      if (Array.isArray(item.value) && key === "length") continue;
      if (!property.enumerable || !("value" in property))
        throw new CoreError("INVALID_ARGUMENT", "Action input cannot contain accessors.");
      bytes += Buffer.byteLength(key);
      pending.push({ value: property.value, depth: item.depth + 1 });
    }
  }
  if (bytes > L.inputBytes || Buffer.byteLength(JSON.stringify(value)) > L.inputBytes)
    throw new CoreError("RESOURCE_LIMIT", "Action JSON exceeds the byte limit.");
}

function boundedOutput(value: Json): Json {
  if (Buffer.byteLength(JSON.stringify(value)) > L.outputBytes)
    throw new CoreError("RESOURCE_LIMIT", "Action compiler result exceeds the output byte limit; no partial result was returned.");
  return value;
}

function closedComponentBodies(steps: unknown, depth = 0): boolean {
  if (!Array.isArray(steps) || depth > 12) return false;
  for (const step of steps) {
    if (!isObject(step) || Object.hasOwn(step, "action_id")) return false;
    const inputs = step.inputs ?? {};
    if (!isObject(inputs)) return false;
    for (const field of ["then_steps", "else_steps", "default_steps", "body"]) {
      if (Object.hasOwn(inputs, field) && !closedComponentBodies(inputs[field], depth + 1)) return false;
    }
    if (Object.hasOwn(inputs, "cases")) {
      if (!Array.isArray(inputs.cases)) return false;
      for (const item of inputs.cases) {
        if (!isObject(item) || !closedComponentBodies(item.steps ?? [], depth + 1)) return false;
      }
    }
  }
  return true;
}

function componentOnlyGraph(graph: Json): boolean {
  if (!Array.isArray(graph.nodes)) return false;
  const components = actionComponents();
  for (const node of graph.nodes) {
    if (!isObject(node) || typeof node.action_id !== "string" || !Object.hasOwn(components, node.action_id)) return false;
    // The existing compiler does not implement these top-level exclusiveMinimum checks.
    if (node.action_id === "core.poll" || node.action_id === "core.monitor") return false;
    if (node.value_type === null || node.implementation === null) return false;
    if (node.parameters !== undefined && !isObject(node.parameters)) return false;
    if (!closedComponentBodies([{ inputs: node.parameters ?? {} }])) return false;
  }
  if (graph.edges !== undefined && !Array.isArray(graph.edges)) return false;
  const ids = new Set(graph.nodes.filter(isObject).map(node => node.id));
  for (const edge of (graph.edges ?? []) as unknown[]) {
    if (!isObject(edge) || !["source", "target", "output", "input"].every(key => typeof edge[key] === "string")
      || !ids.has(edge.source) || !ids.has(edge.target)) return false;
  }
  return typeof graph.action_id === "string" && /^[a-z][a-z0-9_.-]{2,100}$/.test(graph.action_id)
    && (graph.version === undefined || Number.isSafeInteger(graph.version))
    && (graph.name === undefined || typeof graph.name === "string")
    && (graph.output_node === undefined || typeof graph.output_node === "string");
}

function originalRequiredDiagnostics(diagnostics: ActionDiagnostic[]): ActionDiagnostic[] {
  const result: ActionDiagnostic[] = [];
  for (let index = 0; index < diagnostics.length;) {
    const first = diagnostics[index]!;
    if (first.code !== "required") { result.push(first); index++; continue; }
    const parent = first.path.slice(0, first.path.lastIndexOf("/"));
    let end = index + 1;
    while (end < diagnostics.length && diagnostics[end]!.code === "required"
      && diagnostics[end]!.path.slice(0, diagnostics[end]!.path.lastIndexOf("/")) === parent) end++;
    const missing = diagnostics.slice(index, end);
    // Original expands the whole missing-field group for each jsonschema required error.
    for (let count = 0; count < missing.length; count++) result.push(...missing);
    index = end;
  }
  return result;
}

function qualifiedDefinitionDiagnostics(definition: Json): ActionDiagnostic[] {
  const diagnostics = actionDefinitionDiagnostics(definition);
  for (const diagnostic of diagnostics) {
    const value = diagnostic.path.slice(1).split("/").reduce<unknown>((current, part) =>
      isObject(current) || Array.isArray(current)
        ? (current as Json)[part.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined, definition);
    if (!["required", "enum", "type", "anyOf", "pattern", "const", "minItems", "minimum", "maximum"].includes(diagnostic.code)
      || diagnostic.message.startsWith("is not ")
      || diagnostic.code === "anyOf" && typeof value !== "string")
      return runtimeRequired("This Original authoring diagnostic is outside the qualified pure schema subset.");
  }
  return originalRequiredDiagnostics(diagnostics);
}

function originalParameterError(graph: Json): string | undefined {
  const components = actionComponents();
  for (const node of graph.nodes as Json[]) {
    const schema = structuredClone(components[node.action_id as string]!.input_schema) as Json;
    const properties = schema.properties as Json;
    if (node.value_type !== undefined) {
      if (node.action_id === "core.constant")
        properties.value = node.value_type === "integer"
          ? { type: "integer", minimum: -(2 ** 63), maximum: 2 ** 63 - 1 } : { type: node.value_type };
      if (node.action_id === "core.cast")
        properties.target_type = { type: "string", enum: [node.value_type], default: node.value_type };
    }
    for (const [field, value] of Object.entries((node.parameters ?? {}) as Json)) {
      const errors = schemaValueErrors(properties[field], value).map(error => {
        const path = error.path === "/" ? [] : error.path.slice(1).split("/")
          .map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"));
        if (error.code === "required") path.pop();
        return { code: error.code, path,
          key: `[${path.map(part => /^\d+$/.test(part) ? part : `'${part}'`).join(", ")}]` };
      }).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
      if (errors.length) return `Contract violation at /${errors[0]!.path.join("/")}: ${errors[0]!.code}`;
    }
  }
  return undefined;
}

const originalGraphErrors = [
  "A graph needs 1-100 blocks and at most 500 connections.",
  "Duplicate or invalid block ID.",
  "Choose an explicit supported component value type.",
  "Incompatible typed ports; use an explicit conversion block.",
  "An input port accepts only one source.",
  "Action graph has a cycle.",
  "Select a valid output block.",
  "Graph output requires named object ports.",
];
const originalGraphErrorPrefixes = [
  "Block contract changed: ", "Unknown block parameter: ", "Unsupported block implementation: ",
  "Missing required block inputs: ", "Contract violation at /",
];

/**
 * No owner, host, filesystem, provider or module-discovery port is accepted here.
 * Valid definitions still need the original revision check. Graph Action references
 * still need completed_dependencies/availability, even for builtin Actions.
 */
export function invokeOriginalMcpPureAction(tool: string, args: Record<string, unknown>): Json {
  if (tool === "action_capabilities")
    return runtimeRequired("Action capabilities include private settings, host identity and enabled-provider discovery.");
  boundedInput(args);
  const input = request.parse({ tool, arguments: args });
  if (input.tool === "action_templates") return structuredClone(ORIGINAL_LEGACY_ACTION_MCP.templates);
  if (input.tool === "action_definition_check") {
    const diagnostics = qualifiedDefinitionDiagnostics(input.arguments.definition);
    if (!diagnostics.length)
      return runtimeRequired("A schema-valid definition requires the original dependency closure and registry revision check.");
    return boundedOutput({ schema: "pkm.action.definition-check/v1", ok: false, diagnostics,
      persisted: false, executed: false, readiness_checked: false, next_action: "fix_definition" });
  }
  const graph = input.arguments.graph;
  if (!componentOnlyGraph(graph))
    return runtimeRequired("Only closed basic-component graphs are pure; Action references require registry/module discovery and readiness.");
  const compiled = compileActionGraph(Object.hasOwn(graph, "edges") ? graph : { ...graph, edges: [] }, []);
  if (!compiled.definition) {
    let message = compiled.diagnostics?.[0]?.message;
    if (message?.startsWith("Contract violation at /")) message = originalParameterError(graph) ?? message;
    if (message && (originalGraphErrors.includes(message) || originalGraphErrorPrefixes.some(prefix => message.startsWith(prefix))))
      throw new CoreError("INVALID_ARGUMENT", message);
    return runtimeRequired("This graph diagnostic is outside the qualified pure compiler subset.");
  }
  return boundedOutput({ ...Object.fromEntries(Object.entries(compiled.definition).filter(([key]) =>
    !["knowledgeId", "source_id", "implementation_hash", "content_hash"].includes(key))), graph });
}
