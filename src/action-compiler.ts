import { z } from "zod";
import { CoreError } from "./contracts.js";
import {
  ACTION_COMPILER_LIMITS as L, actionCompilerDefinitions,
  type ActionCompilerOperation, type ActionCompilerRequest,
} from "./action-compiler-contracts.js";
import { compileActionGraph } from "./domain/action-compiler-graph.js";
import {
  actionDefinitionDiagnostics, builtinActionDefinitions, loadModuleSet,
  originalDefinitionValue, pythonCanonicalJson, portableActionDefinition, validateActionDefinition,
  type ActionDiagnostic, type ActionModuleSnapshot, type JsonRecord,
} from "./domain/action-compiler-validation.js";

export { ACTION_COMPILER_LIMITS, actionCompilerDefinitions } from "./action-compiler-contracts.js";
export type { ActionCompilerOperation, ActionCompilerRequest } from "./action-compiler-contracts.js";

const operation = (name: string) => actionCompilerDefinitions.find(item => item.id === name);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resourceLimit(message: string): never {
  throw new CoreError("RESOURCE_LIMIT", message);
}

function boundedJson(value: unknown, maximum: number): void {
  const pending = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let count = 0;
  let textBytes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > L.jsonValues || item.depth > L.jsonDepth) {
      resourceLimit("Action JSON exceeds the value-count or nesting-depth limit.");
    }
    if (typeof item.value === "string") {
      textBytes += Buffer.byteLength(item.value, "utf8");
      if (textBytes > maximum) resourceLimit("Action JSON exceeds the byte limit.");
      continue;
    }
    if (item.value === null || typeof item.value === "boolean") continue;
    if (typeof item.value === "number") {
      if (!Number.isFinite(item.value) || !Number.isSafeInteger(item.value) && Number.isInteger(item.value)) {
        throw new CoreError("INVALID_ARGUMENT", "Action JSON numbers must be finite and safe integers where integral.");
      }
      continue;
    }
    if (typeof item.value !== "object") throw new CoreError("INVALID_ARGUMENT", "Action input must be JSON.");
    if (seen.has(item.value)) throw new CoreError("INVALID_ARGUMENT", "Action input must not contain cycles or shared object references.");
    seen.add(item.value);
    const prototype = Object.getPrototypeOf(item.value);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
      throw new CoreError("INVALID_ARGUMENT", "Action input must contain only JSON objects.");
    }
    const descriptors = Object.getOwnPropertyDescriptors(item.value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item.value) && key === "length") continue;
      textBytes += Buffer.byteLength(key, "utf8");
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new CoreError("INVALID_ARGUMENT", "Action input cannot contain accessors.");
      }
      pending.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
  let serialized: string;
  try { serialized = JSON.stringify(value); }
  catch { throw new CoreError("INVALID_ARGUMENT", "Action input must be JSON."); }
  if (typeof serialized !== "string") throw new CoreError("INVALID_ARGUMENT", "Action input must be JSON.");
  if (Buffer.byteLength(serialized, "utf8") > maximum || textBytes > maximum) {
    resourceLimit("Action JSON exceeds the byte limit.");
  }
}

function checkedOutput(descriptor: typeof actionCompilerDefinitions[number], result: unknown): unknown {
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > L.outputBytes) {
    resourceLimit("Action compiler result exceeds the output byte limit; no partial result was returned.");
  }
  const checked = descriptor.output.safeParse(result);
  if (!checked.success) {
    throw new CoreError("INVALID_DOCUMENT", `Action compiler produced an invalid result: ${z.prettifyError(checked.error)}`);
  }
  return checked.data;
}

function definitionSource(source: ActionModuleSnapshot | { kind: "inline"; definition: unknown }, actionId?: string): {
  definition: unknown;
  available: Map<string, JsonRecord>;
  descriptor: JsonRecord;
  runtimeMetadata?: JsonRecord;
} {
  if (source.kind === "inline") {
    return {
      definition: source.definition,
      available: builtinActionDefinitions(),
      descriptor: { kind: "inline", ...(isRecord(source.definition) && typeof source.definition.action_id === "string"
        ? { action_id: source.definition.action_id } : {}) },
    };
  }
  const set = loadModuleSet(source);
  const selected = actionId ?? (set.definitions.size === 1 ? set.definitions.keys().next().value : undefined);
  if (typeof selected !== "string") throw new CoreError("INVALID_ARGUMENT", "Select an Action from the supplied ModuleSet snapshot.");
  const found = set.definitions.get(selected);
  if (!found) throw new CoreError("NOT_FOUND", "Action is not present in the supplied ModuleSet snapshot.");
  const available = builtinActionDefinitions();
  for (const [id, definition] of set.definitions) available.set(id, definition);
  return {
    definition: Object.fromEntries(Object.entries(portableActionDefinition(found)).filter(([key]) => key !== "knowledgeId")),
    available,
    runtimeMetadata: typeof found.knowledgeId === "string" ? { knowledgeId: found.knowledgeId } : undefined,
    descriptor: {
      kind: "moduleSet",
      module_set_id: set.projection.module_set_id,
      version: set.projection.version,
      action_id: selected,
    },
  };
}

function sourceMap(definition: JsonRecord): Array<{ sourcePointer: string; canonicalPointer: string; nodeId?: string }> {
  const mappings: Array<{ sourcePointer: string; canonicalPointer: string; nodeId?: string }> = [];
  const implementations = Array.isArray(definition.implementations) ? definition.implementations : [];
  for (let index = 0; index < implementations.length; index += 1) {
    const implementation = implementations[index];
    mappings.push({ sourcePointer: `/implementations/${index}`, canonicalPointer: `/implementations/${index}` });
    if (!isRecord(implementation) || !Array.isArray(implementation.steps)) continue;
    for (let stepIndex = 0; stepIndex < implementation.steps.length; stepIndex += 1) {
      const step = implementation.steps[stepIndex];
      mappings.push({
        sourcePointer: `/implementations/${index}/steps/${stepIndex}`,
        canonicalPointer: `/implementations/${index}/steps/${stepIndex}`,
        ...(isRecord(step) && typeof step.id === "string" ? { nodeId: step.id } : {}),
      });
    }
  }
  return mappings;
}

function compilerCapabilities(): JsonRecord {
  return {
    schema: "pkm.action.compiler.capabilities/v1",
    definitionSchema: "pkm.action.definition/v1",
    moduleSetSchema: "pkm.action.module-set/v1",
    runtimeStatus: "not-runnable-here",
    limits: L,
    implementationKinds: ["program", "pipeline", "mcp"],
    unavailable: ["persistence", "execution", "qualification", "host-path-reads", "provider", "network", "credentials", "module-set-discovery"],
  };
}

function moduleSetProjection(source: ActionModuleSnapshot): JsonRecord {
  const { projection } = loadModuleSet(source);
  return { ok: true, module_sets: [projection] };
}

function checkDefinition(args: { source: ActionModuleSnapshot | { kind: "inline"; definition: unknown }; actionId?: string }): JsonRecord {
  const input = definitionSource(args.source, args.actionId);
  let diagnostics = actionDefinitionDiagnostics(input.definition);
  if (!diagnostics.length) diagnostics = validateActionDefinition(input.definition, input.available);
  return {
    schema: "pkm.action.definition-check/v1",
    ok: diagnostics.length === 0,
    diagnostics,
    persisted: false,
    executed: false,
    readiness_checked: false,
    next_action: diagnostics.length ? "fix_definition" : "action_register",
  };
}

function compileDefinition(args: { source: ActionModuleSnapshot | { kind: "inline"; definition: unknown }; actionId?: string }): JsonRecord {
  const input = definitionSource(args.source, args.actionId);
  let diagnostics: ActionDiagnostic[] = actionDefinitionDiagnostics(input.definition);
  if (!diagnostics.length) diagnostics = validateActionDefinition(input.definition, input.available);
  if (diagnostics.length) {
    return {
      schema: "pkm.action.definition.compile/v1",
      status: "invalid",
      source: input.descriptor,
      diagnostics,
    };
  }
  if (!isRecord(input.definition)) throw new CoreError("INVALID_DOCUMENT", "Validated Action definition is not an object.");
  const definition = originalDefinitionValue({ ...input.definition, ...input.runtimeMetadata });
  const dependencies = isRecord(input.definition.dependencies) ? input.definition.dependencies : {};
  const implementations = Array.isArray(input.definition.implementations) ? input.definition.implementations : [];
  return {
    schema: "pkm.action.definition.compile/v1",
    status: "valid",
    source: input.descriptor,
    definitionDigest: String(definition.content_hash),
    canonicalJson: pythonCanonicalJson(definition),
    definition,
    plan: {
      action_id: definition.action_id,
      action_version: definition.version,
      dependencies: Object.keys(dependencies).sort().map(action_id => ({
        action_id, content_hash: dependencies[action_id],
      })),
      implementations: implementations.map((item, index) => ({
        index,
        kind: isRecord(item) ? item.kind : "",
        platforms: isRecord(item) && Array.isArray(item.platforms) ? item.platforms : [],
      })),
      sourceMap: sourceMap(input.definition),
    },
    runtimeStatus: "not-runnable-here",
  };
}

function compileGraph(args: { graph: unknown; sourceModules?: ActionModuleSnapshot[] }): JsonRecord {
  const compiled = compileActionGraph(args.graph, args.sourceModules ?? []);
  if (compiled.diagnostics) return {
    schema: "pkm.action.graph.compile/v1",
    status: "invalid",
    diagnostics: compiled.diagnostics,
  };
  const definition = compiled.definition!;
  return {
    schema: "pkm.action.graph.compile/v1",
    status: "valid",
    definition,
    canonicalJson: pythonCanonicalJson(definition),
    definitionDigest: String(definition.content_hash),
    sourceMap: compiled.sourceMap!,
    runtimeStatus: "not-runnable-here",
  };
}

export function readActionCompiler(request: ActionCompilerRequest): unknown {
  const descriptor = operation(String(request.operation));
  if (!descriptor) throw new CoreError("NOT_FOUND", "Unknown Action compiler read operation.");
  boundedJson(request.args, L.inputBytes);
  const parsed = descriptor.input.safeParse(request.args);
  if (!parsed.success) throw new CoreError("INVALID_ARGUMENT", z.prettifyError(parsed.error));
  const parsedValue = parsed.data as unknown as JsonRecord;
  if ((request.operation === "action.definition.check" || request.operation === "action.definition.compile")
    && isRecord(parsedValue.source) && parsedValue.source.kind === "inline") {
    boundedJson(parsedValue.source.definition, L.definitionBytes);
  }
  if (request.operation === "action.graph.compile") {
    boundedJson(parsedValue.graph, L.definitionBytes);
  }
  switch (request.operation as ActionCompilerOperation) {
    case "action.compiler.capabilities":
      return checkedOutput(descriptor, compilerCapabilities());
    case "action.definition.check":
      return checkedOutput(descriptor, checkDefinition(parsed.data as Parameters<typeof checkDefinition>[0]));
    case "action.definition.compile":
      return checkedOutput(descriptor, compileDefinition(parsed.data as Parameters<typeof compileDefinition>[0]));
    case "action.moduleSet.project":
      return checkedOutput(descriptor, moduleSetProjection(
        (parsed.data as { source: ActionModuleSnapshot }).source,
      ));
    case "action.graph.compile":
      return checkedOutput(descriptor, compileGraph(parsed.data as Parameters<typeof compileGraph>[0]));
  }
}

export function actionCompilerTransportFixture(
  operationName: ActionCompilerOperation, args: unknown, result: unknown,
): { operation: ActionCompilerOperation; args: unknown; result: unknown } {
  return { operation: operationName, args, result };
}
