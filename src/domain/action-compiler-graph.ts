import { ACTION_COMPILER_LIMITS as L } from "../action-compiler-contracts.js";
import {
  actionComponents, componentDigest, moduleSnapshotDefinitions,
  originalDefinitionValue, originalDigest, schemaValueErrors,
  validateActionDefinition, type ActionDiagnostic, type ActionModuleSnapshot, type JsonRecord,
} from "./action-compiler-validation.js";

type CompiledGraph = { definition: JsonRecord; sourceMap: Array<{ sourcePointer: string; canonicalPointer: string; nodeId: string }> };
type NodeState = {
  id: string;
  actionId: string;
  definition: JsonRecord;
  inputs: JsonRecord;
  predecessors: Set<string>;
  basic: boolean;
  implementation?: string;
  sourceIndex: number;
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectSchema(properties: JsonRecord): JsonRecord {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

function valueTypeSchema(valueType: unknown): JsonRecord {
  if (valueType === "integer") return { type: "integer", minimum: -(2 ** 63), maximum: 2 ** 63 - 1 };
  if (typeof valueType === "string" && ["string", "number", "boolean", "object", "array", "null"].includes(valueType)) {
    return { type: valueType };
  }
  throw new Error("Choose an explicit supported component value type.");
}

function componentValue(name: string, valueType?: unknown): JsonRecord {
  const component = actionComponents()[name];
  if (!component) throw new Error("Unknown basic component.");
  const definition = structuredClone(component);
  if (valueType !== undefined) {
    const schema = valueTypeSchema(valueType);
    const input = definition.input_schema as JsonRecord;
    const output = definition.output_schema as JsonRecord;
    const inputProperties = input.properties as JsonRecord;
    const outputProperties = output.properties as JsonRecord;
    if ("value" in outputProperties) outputProperties.value = schema;
    if ("values" in outputProperties && isRecord(outputProperties.values)) {
      outputProperties.values.items = schema;
    }
    if (name === "core.constant") inputProperties.value = schema;
    if (name === "core.cast") {
      inputProperties.target_type = { type: "string", enum: [valueType], default: valueType };
    }
  }
  return {
    ...definition,
    content_hash: componentDigest(component),
  };
}

function referencedActions(steps: unknown, depth = 0): Set<string> {
  if (!Array.isArray(steps) || depth > L.pipelineDepth) throw new Error("Invalid or excessive component nesting.");
  const result = new Set<string>();
  for (const step of steps) {
    if (!isRecord(step)) throw new Error("Each body step must be an object.");
    if ("action_id" in step) {
      if (typeof step.action_id !== "string") throw new Error("Body Action ID must be a string.");
      result.add(step.action_id);
      continue;
    }
    const inputs = step.inputs ?? {};
    if (!isRecord(inputs)) throw new Error("Step inputs must be an object.");
    for (const field of ["then_steps", "else_steps", "default_steps", "body"]) {
      if (field in inputs) for (const child of referencedActions(inputs[field], depth + 1)) result.add(child);
    }
    if ("cases" in inputs) {
      if (!Array.isArray(inputs.cases)) throw new Error("Switch cases must be a list.");
      for (const item of inputs.cases) {
        if (!isRecord(item)) throw new Error("Switch cases must be objects.");
        for (const child of referencedActions(item.steps ?? [], depth + 1)) result.add(child);
      }
    }
  }
  return result;
}

function pinnedDependencyClosure(actionId: string, dependencies: JsonRecord, available: Map<string, JsonRecord>): void {
  const visited = new Set<string>();
  const visit = (pins: JsonRecord, ancestry: string[]): void => {
    if (ancestry.length > L.dependencyDepth || visited.size > L.dependencyCount) {
      throw new Error("Nested Action dependency budget exceeded.");
    }
    for (const [child, pin] of Object.entries(pins)) {
      if (ancestry.includes(child)) throw new Error("Nested Action cycle: " + [...ancestry, child].join(" -> "));
      const definition = available.get(child);
      if (!definition) throw new Error("Action is not registered or its ModuleSet is not loaded: " + child);
      if (definition.content_hash !== pin) throw new Error("Dependency is not pinned to the current contract: " + child);
      if (visited.has(child)) continue;
      visit(isRecord(definition.dependencies) ? definition.dependencies : {}, [...ancestry, child]);
      visited.add(child);
    }
  };
  visit(dependencies, [actionId]);
}

function graphCompile(graphValue: unknown, sources: ActionModuleSnapshot[]): CompiledGraph {
  if (!isRecord(graphValue) || !Array.isArray(graphValue.nodes) || !Array.isArray(graphValue.edges)
    || graphValue.nodes.length < 1 || graphValue.nodes.length > L.graphNodes || graphValue.edges.length > L.graphEdges) {
    throw new Error("A graph needs 1-100 blocks and at most 500 connections.");
  }
  if (sources.some(source => source.enabled !== true)) {
    throw new Error("Action is not enabled in the supplied ModuleSet snapshot.");
  }
  const available = moduleSnapshotDefinitions(sources);
  const components = actionComponents();
  const nodes = new Map<string, NodeState>();
  const dependencies: JsonRecord = {};
  const effects = new Set<string>();
  for (let index = 0; index < graphValue.nodes.length; index += 1) {
    const node = graphValue.nodes[index];
    if (!isRecord(node)) throw new Error("Duplicate or invalid block ID.");
    const identifier = node.id;
    if (typeof identifier !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(identifier) || nodes.has(identifier)) {
      throw new Error("Duplicate or invalid block ID.");
    }
    if (typeof node.action_id !== "string") throw new Error("Invalid graph Action ID.");
    const basic = node.action_id in components;
    const definition = basic
      ? componentValue(node.action_id, node.value_type)
      : available.get(node.action_id);
    if (!definition) throw new Error("Action is not registered or its ModuleSet is not loaded: " + node.action_id);
    if (node.content_hash !== definition.content_hash) throw new Error("Block contract changed: " + identifier);
    const parameters = isRecord(node.parameters) ? structuredClone(node.parameters) : {};
    const inputSchema = isRecord(definition.input_schema) ? definition.input_schema : {};
    const properties = isRecord(inputSchema.properties) ? inputSchema.properties : {};
    if (Object.keys(parameters).some(key => !(key in properties))) throw new Error("Unknown block parameter: " + identifier);
    for (const [field, value] of Object.entries(parameters)) {
      const issues = schemaValueErrors(properties[field], value);
      if (issues.length) throw new Error(`Contract violation at ${issues[0]!.path}: ${issues[0]!.code}`);
    }
    const implementation = basic ? node.implementation ?? "python" : undefined;
    if (basic) {
      const implementationList = definition.component_implementations as Array<JsonRecord> | undefined;
      if (!implementationList?.some(item => item.id === implementation)) throw new Error("Unsupported block implementation: " + identifier);
      const refs = referencedActions([{ id: identifier, component: node.action_id, inputs: parameters }]);
      for (const child of refs) {
        const childDefinition = available.get(child);
        if (!childDefinition) throw new Error("Action is not registered or its ModuleSet is not loaded: " + child);
        dependencies[child] = childDefinition.content_hash;
        for (const effect of Array.isArray(childDefinition.effects) ? childDefinition.effects : []) effects.add(String(effect));
      }
    } else {
      dependencies[definition.action_id as string] = definition.content_hash;
    }
    for (const effect of Array.isArray(definition.effects) ? definition.effects : []) effects.add(String(effect));
    nodes.set(identifier, {
      id: identifier,
      actionId: node.action_id,
      definition,
      inputs: parameters,
      predecessors: new Set(),
      basic,
      ...(typeof implementation === "string" ? { implementation } : {}),
      sourceIndex: index,
    });
  }

  const connected = new Set<string>();
  for (const edge of graphValue.edges) {
    if (!isRecord(edge) || typeof edge.source !== "string" || typeof edge.target !== "string"
      || typeof edge.output !== "string" || typeof edge.input !== "string") throw new Error("Invalid graph connection.");
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) throw new Error("Graph connection references an unknown block.");
    const sourceOutput = isRecord(source.definition.output_schema) && isRecord(source.definition.output_schema.properties)
      ? source.definition.output_schema.properties[edge.output] : undefined;
    const targetInput = isRecord(target.definition.input_schema) && isRecord(target.definition.input_schema.properties)
      ? target.definition.input_schema.properties[edge.input] : undefined;
    if (sourceOutput === undefined || targetInput === undefined
      || (isRecord(targetInput) && Object.keys(targetInput).length > 0
        && originalDigest(sourceOutput) !== originalDigest(targetInput))) {
      throw new Error("Incompatible typed ports; use an explicit conversion block.");
    }
    const key = `${edge.target}\u0000${edge.input}`;
    if (connected.has(key)) throw new Error("An input port accepts only one source.");
    connected.add(key);
    target.inputs[edge.input] = { $step: `${edge.source}.${edge.output}` };
    target.predecessors.add(edge.source);
  }

  const steps: JsonRecord[] = [];
  const sourceMap: CompiledGraph["sourceMap"] = [];
  const remaining = new Map(nodes);
  while (remaining.size) {
    const eligible = [...remaining].filter(([, node]) =>
      ![...node.predecessors].some(predecessor => remaining.has(predecessor)));
    if (!eligible.length) throw new Error("Action graph has a cycle.");
    for (const [identifier, node] of eligible) {
      const inputSchema = isRecord(node.definition.input_schema) ? node.definition.input_schema : {};
      const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
      if (required.some(key => typeof key === "string" && !(key in node.inputs))) {
        throw new Error("Missing required block inputs: " + identifier);
      }
      const step: JsonRecord = {
        id: identifier,
        [node.basic ? "component" : "action_id"]: node.actionId,
        inputs: node.inputs,
        ...(node.basic ? { output_schema: node.definition.output_schema } : {}),
        ...(node.basic && node.implementation !== "python" ? { implementation: node.implementation } : {}),
      };
      sourceMap.push({
        sourcePointer: `/nodes/${node.sourceIndex}`,
        canonicalPointer: `/implementations/0/steps/${steps.length}`,
        nodeId: identifier,
      });
      steps.push(step);
      remaining.delete(identifier);
    }
  }
  const outputNode = graphValue.output_node ?? steps.at(-1)?.id;
  if (typeof outputNode !== "string" || !nodes.has(outputNode)) throw new Error("Select a valid output block.");
  const outputDefinition = nodes.get(outputNode)!.definition;
  const outputSchema = isRecord(outputDefinition.output_schema) ? outputDefinition.output_schema : {};
  if (outputSchema.type !== "object" || !isRecord(outputSchema.properties) || !Object.keys(outputSchema.properties).length) {
    throw new Error("Graph output requires named object ports.");
  }
  pinnedDependencyClosure(String(graphValue.action_id), dependencies, available);
  const definition: JsonRecord = {
    schema: "pkm.action.definition/v1",
    action_id: graphValue.action_id,
    version: graphValue.version ?? 1,
    display_name: graphValue.name ?? graphValue.action_id,
    description: graphValue.name ?? "Graphical Action composition",
    graph: graphValue,
    input_schema: objectSchema({}),
    output_schema: outputSchema,
    effects: [...effects].sort(),
    dependencies,
    implementations: [{
      kind: "pipeline",
      platforms: ["Linux", "Windows", "Darwin"],
      steps,
      output: Object.fromEntries(Object.keys(outputSchema.properties).map(field => [field, { $step: `${outputNode}.${field}` }])),
    }],
    examples: [{ inputs: {} }],
  };
  const enriched = originalDefinitionValue(definition);
  const validation = validateActionDefinition(definition, available);
  if (validation.length) throw new Error(validation[0]!.message);
  return { definition: enriched, sourceMap };
}

export function compileActionGraph(graph: unknown, sources: ActionModuleSnapshot[]): {
  definition?: JsonRecord; sourceMap?: CompiledGraph["sourceMap"]; diagnostics?: ActionDiagnostic[];
} {
  try {
    return graphCompile(graph, sources);
  } catch (error) {
    return {
      diagnostics: [{
        path: "/",
        code: "semantic",
        message: error instanceof Error ? error.message : "Invalid Action graph.",
      }],
    };
  }
}
