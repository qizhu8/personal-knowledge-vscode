import assert from "node:assert/strict";
import { canonicalJson, compileWorkflowDefinitionV1 } from "../dist/domain/project-recipes-workflow-contracts.js";

const schema = {"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"pkm.workflow.definition/v1","title":"PKM Workflow Definition v1","type":"object","additionalProperties":false,"required":["schema","spec"],"properties":{"schema":{"const":"pkm.workflow.definition/v1"},"spec":{"type":"object","additionalProperties":false,"required":["inputs","nodes","outputs","completion"],"properties":{"inputs":{"type":"object","additionalProperties":{"$ref":"#/$defs/port"}},"nodes":{"type":"array","minItems":1,"uniqueItems":true,"x-pkm-order":"set","x-pkm-sort-key":["nodeId"],"items":{"oneOf":[{"$ref":"#/$defs/noopNode"},{"$ref":"#/$defs/commandNode"},{"$ref":"#/$defs/scriptNode"},{"$ref":"#/$defs/pipelineNode"},{"$ref":"#/$defs/nativeNode"},{"$ref":"#/$defs/humanGateNode"},{"$ref":"#/$defs/subflowNode"}]}},"outputs":{"type":"object","additionalProperties":{"$ref":"#/$defs/port"}},"trigger":{"$ref":"#/$defs/trigger"},"completion":{"type":"object","additionalProperties":false,"required":["requiredNodes"],"properties":{"requiredNodes":{"type":"array","minItems":1,"uniqueItems":true,"x-pkm-order":"set","x-pkm-sort-key":["$value"],"items":{"$ref":"#/$defs/identifier"}}}}}}},"$defs":{"identifier":{"type":"string","pattern":"^[A-Za-z][A-Za-z0-9._-]{0,127}$"},"trigger":{"type":"object","additionalProperties":false,"required":["kind","expression","timezone"],"properties":{"kind":{"const":"cron"},"expression":{"type":"string","pattern":"^\\S+(?:\\s+\\S+){4}$"},"timezone":{"type":"string","minLength":1}}},"port":{"type":"object","additionalProperties":false,"required":["type","required","nullable","schema"],"properties":{"type":{"enum":["object","array","string","boolean","int64","decimal","null","artifact","secret-handle"]},"required":{"type":"boolean"},"nullable":{"type":"boolean"},"schema":{"type":"object"},"default":true},"allOf":[{"if":{"properties":{"type":{"const":"object"}}},"then":{"properties":{"schema":{"$ref":"#/$defs/objectSchema"}}}},{"if":{"properties":{"type":{"const":"array"}}},"then":{"properties":{"schema":{"$ref":"#/$defs/arraySchema"}}}},{"if":{"properties":{"type":{"enum":["string","boolean","int64","decimal","null","artifact","secret-handle"]}}},"then":{"properties":{"schema":{"type":"object","maxProperties":0}}}}]},"objectSchema":{"type":"object","additionalProperties":false,"required":["properties"],"properties":{"properties":{"type":"object","additionalProperties":{"$ref":"#/$defs/port"}}}},"arraySchema":{"type":"object","additionalProperties":false,"required":["items"],"properties":{"items":{"$ref":"#/$defs/port"},"minItems":{"type":"integer","minimum":0},"maxItems":{"type":"integer","minimum":0}}},"noopNode":{"type":"object","additionalProperties":false,"required":["nodeId","kind","config","dependsOn"],"properties":{"nodeId":{"$ref":"#/$defs/identifier"},"kind":{"const":"pkm.step.noop/v1"},"config":{"type":"object","maxProperties":0},"generalInstruction":{"type":"string","minLength":1},"ports":{"$ref":"#/$defs/nodePorts"},"control":{"$ref":"#/$defs/nodeControl"},"dependsOn":{"type":"array","uniqueItems":true,"x-pkm-order":"set","x-pkm-sort-key":["from","accept"],"items":{"$ref":"#/$defs/dependency"}}}},"commandNode":{"type":"object","additionalProperties":false,"required":["nodeId","kind","config","dependsOn"],"properties":{"nodeId":{"$ref":"#/$defs/identifier"},"kind":{"const":"pkm.step.command/v1"},"config":{"type":"object","additionalProperties":false,"required":["program","args"],"properties":{"program":{"type":"string","minLength":1,"pattern":"^[^\\r\\n\\u0000]+$"},"args":{"type":"array","x-pkm-order":"semantic","x-pkm-sort-key":["$index"],"items":{"type":"string","pattern":"^[^\\u0000]*$"}},"timeoutSeconds":{"type":"integer","minimum":1,"maximum":3600,"default":300},"maxOutputBytes":{"type":"integer","minimum":1024,"maximum":1048576,"default":65536},"cwd":{"type":"string","minLength":1,"pattern":"^[^\\r\\n\\u0000]+$"}}},"generalInstruction":{"type":"string","minLength":1},"ports":{"$ref":"#/$defs/nodePorts"},"control":{"$ref":"#/$defs/nodeControl"},"dependsOn":{"type":"array","uniqueItems":true,"x-pkm-order":"set","x-pkm-sort-key":["from","accept"],"items":{"$ref":"#/$defs/dependency"}}}},"scriptNode":{"type":"object","additionalProperties":false,"required":["nodeId","kind","config","dependsOn"],"properties":{"nodeId":{"$ref":"#/$defs/identifier"},"kind":{"const":"pkm.step.script/v1"},"config":{"type":"object","additionalProperties":false,"required":["runtime","script"],"properties":{"runtime":{"enum":["bash","powershell","python"]},"script":{"type":"string","minLength":1,"pattern":"^[^\\u0000]+$"},"args":{"type":"array","x-pkm-order":"semantic","x-pkm-sort-key":["$index"],"items":{"type":"string","pattern":"^[^\\u0000]*$"}},"environmentId":{"$ref":"#/$defs/identifier"},"timeoutSeconds":{"type":"integer","minimum":1,"maximum":3600,"default":300},"maxOutputBytes":{"type":"integer","minimum":1024,"maximum":1048576,"default":65536},"cwd":{"type":"string","minLength":1,"pattern":"^[^\\r\\n\\u0000]+$"}},"allOf":[{"if":{"properties":{"runtime":{"const":"python"}},"required":["runtime"]},"then":{"required":["environmentId"]},"else":{"not":{"required":["environmentId"]}}}]},"generalInstruction":{"type":"string","minLength":1},"ports":{"$ref":"#/$defs/nodePorts"},"control":{"$ref":"#/$defs/nodeControl"},"dependsOn":{"type":"array","uniqueItems":true,"x-pkm-order":"set","x-pkm-sort-key":["from","accept"],"items":{"$ref":"#/$defs/dependency"}}}},"pipelineNode":{"type":"object","additionalProperties":false,"required":["nodeId","kind","config","dependsOn"],"properties":{"nodeId":{"$ref":"#/$defs/identifier"},"kind":{"const":"pkm.step.pipeline/v1"},"config":{"oneOf":[{"type":"object","additionalProperties":false,"required":["executor","program","args"],"properties":{"executor":{"const":"command"},"program":{"$ref":"#/$defs/commandNode/properties/config/properties/program"},"args":{"$ref":"#/$defs/commandNode/properties/config/properties/args"},"cwd":{"$ref":"#/$defs/commandNode/properties/config/properties/cwd"},"timeoutSeconds":{"$ref":"#/$defs/commandNode/properties/config/properties/timeoutSeconds"},"maxOutputBytes":{"$ref":"#/$defs/commandNode/properties/config/properties/maxOutputBytes"}}},{"type":"object","additionalProperties":false,"required":["executor","runtime","script"],"properties":{"executor":{"const":"script"},"runtime":{"$ref":"#/$defs/scriptNode/properties/config/properties/runtime"},"script":{"$ref":"#/$defs/scriptNode/properties/config/properties/script"},"args":{"$ref":"#/$defs/scriptNode/properties/config/properties/args"},"environmentId":{"$ref":"#/$defs/scriptNode/properties/config/properties/environmentId"},"cwd":{"$ref":"#/$defs/scriptNode/properties/config/properties/cwd"},"timeoutSeconds":{"$ref":"#/$defs/scriptNode/properties/config/properties/timeoutSeconds"},"maxOutputBytes":{"$ref":"#/$defs/scriptNode/properties/config/properties/maxOutputBytes"}},"allOf":[{"$ref":"#/$defs/scriptNode/properties/config/allOf/0"}]}]},"generalInstruction":{"$ref":"#/$defs/scriptNode/properties/generalInstruction"},"ports":{"$ref":"#/$defs/nodePorts"},"control":{"$ref":"#/$defs/nodeControl"},"dependsOn":{"$ref":"#/$defs/scriptNode/properties/dependsOn"}}},"nativeNode":{"type":"object","additionalProperties":false,"required":["nodeId","kind","config","dependsOn"],"properties":{"nodeId":{"$ref":"#/$defs/identifier"},"kind":{"const":"pkm.step.native/v1"},"config":{"type":"object","additionalProperties":false,"required":["operation","arguments"],"properties":{"operation":{"$ref":"#/$defs/identifier"},"arguments":{"type":"object","propertyNames":{"$ref":"#/$defs/identifier"},"additionalProperties":{"type":"string","pattern":"^[^\\u0000]*$"}}}},"generalInstruction":{"type":"string","minLength":1},"ports":{"$ref":"#/$defs/nodePorts"},"control":{"$ref":"#/$defs/nodeControl"},"dependsOn":{"type":"array","uniqueItems":true,"x-pkm-order":"set","x-pkm-sort-key":["from","accept"],"items":{"$ref":"#/$defs/dependency"}}}},"humanGateNode":{"type":"object","additionalProperties":false,"required":["nodeId","kind","config","dependsOn"],"properties":{"nodeId":{"$ref":"#/$defs/identifier"},"kind":{"const":"pkm.gate.human/v1"},"config":{"type":"object","additionalProperties":false,"required":["prompt","inputKind"],"properties":{"prompt":{"type":"string","minLength":1},"inputKind":{"enum":["approval","text","choice"]},"choices":{"type":"array","minItems":2,"uniqueItems":true,"x-pkm-order":"set","x-pkm-sort-key":["$value"],"items":{"type":"string","minLength":1}}},"allOf":[{"if":{"properties":{"inputKind":{"const":"choice"}}},"then":{"required":["choices"]},"else":{"not":{"required":["choices"]}}}]},"generalInstruction":{"type":"string","minLength":1},"ports":{"$ref":"#/$defs/nodePorts"},"control":{"$ref":"#/$defs/nodeControl"},"dependsOn":{"type":"array","uniqueItems":true,"x-pkm-order":"set","x-pkm-sort-key":["from","accept"],"items":{"$ref":"#/$defs/dependency"}}}},"subflowNode":{"type":"object","additionalProperties":false,"required":["nodeId","kind","config","dependsOn"],"properties":{"nodeId":{"$ref":"#/$defs/identifier"},"kind":{"const":"pkm.subflow/v1"},"config":{"type":"object","additionalProperties":false,"required":["recipeId","revision","executableDigest"],"properties":{"recipeId":{"$ref":"#/$defs/identifier"},"revision":{"type":"integer","minimum":1},"executableDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}}},"generalInstruction":{"type":"string","minLength":1},"ports":{"$ref":"#/$defs/nodePorts"},"control":{"$ref":"#/$defs/nodeControl"},"dependsOn":{"type":"array","uniqueItems":true,"x-pkm-order":"set","x-pkm-sort-key":["from","accept"],"items":{"$ref":"#/$defs/dependency"}}}},"dependency":{"type":"object","additionalProperties":false,"required":["from","accept","required"],"properties":{"from":{"$ref":"#/$defs/identifier"},"fromOutput":{"$ref":"#/$defs/identifier"},"toInput":{"$ref":"#/$defs/identifier"},"loop":{"$ref":"#/$defs/loopEdge"},"accept":{"type":"array","minItems":1,"uniqueItems":true,"x-pkm-order":"set","x-pkm-sort-key":["$value"],"items":{"type":"string","minLength":1}},"required":{"const":true}}},"loopEdge":{"type":"object","additionalProperties":false,"required":["termination"],"properties":{"termination":{"type":"object","additionalProperties":false,"required":["condition","maxIterations"],"properties":{"condition":{"type":"string","minLength":1},"maxIterations":{"type":"integer","minimum":1}}}}},"nodePorts":{"type":"object","additionalProperties":false,"required":["inputs","outputs"],"properties":{"inputs":{"type":"array","uniqueItems":true,"x-pkm-order":"set","x-pkm-sort-key":["$value"],"items":{"$ref":"#/$defs/identifier"}},"outputs":{"type":"array","uniqueItems":true,"x-pkm-order":"set","x-pkm-sort-key":["$value"],"items":{"$ref":"#/$defs/identifier"}}}},"nodeControl":{"oneOf":[{"type":"object","additionalProperties":false,"required":["mode"],"properties":{"mode":{"const":"single"}}},{"type":"object","additionalProperties":false,"required":["mode","count"],"properties":{"mode":{"const":"repeat"},"count":{"oneOf":[{"type":"object","additionalProperties":false,"required":["kind","value"],"properties":{"kind":{"const":"fixed"},"value":{"type":"integer","minimum":1}}},{"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"const":"dynamic"}}}]}}},{"type":"object","additionalProperties":false,"required":["mode","kind","cases"],"properties":{"mode":{"const":"branch"},"kind":{"enum":["if","switch"]},"dynamicCases":{"const":true},"cases":{"type":"array","minItems":1,"uniqueItems":true,"x-pkm-order":"set","x-pkm-sort-key":["$value"],"items":{"$ref":"#/$defs/identifier"}}}}]}}};
const orderRegistry = {"schema":"pkm.workflow.canonical-order/v1","arrays":{"/spec/nodes":{"order":"set","sortKey":["nodeId"]},"/spec/nodes/*/config/args":{"order":"semantic","sortKey":["$index"]},"/spec/nodes/*/config/choices":{"order":"set","sortKey":["$value"]},"/spec/nodes/*/ports/inputs":{"order":"set","sortKey":["$value"]},"/spec/nodes/*/ports/outputs":{"order":"set","sortKey":["$value"]},"/spec/nodes/*/control/cases":{"order":"set","sortKey":["$value"]},"/spec/nodes/*/dependsOn":{"order":"set","sortKey":["from","fromOutput","toInput","accept","loop"]},"/spec/nodes/*/dependsOn/*/accept":{"order":"set","sortKey":["$value"]},"/spec/completion/requiredNodes":{"order":"set","sortKey":["$value"]}}};
const diagnosticRegistry = {"schema":"pkm.workflow.diagnostics/v1","codes":{"E3001":{"severity":"error","messageTemplateId":"workflow.schema.unknownField","remediationClass":"author"},"E3002":{"severity":"error","messageTemplateId":"workflow.schema.invalidIdentifier","remediationClass":"author"},"E3003":{"severity":"error","messageTemplateId":"workflow.schema.type","remediationClass":"author"},"E3004":{"severity":"error","messageTemplateId":"workflow.schema.nonEmptySet","remediationClass":"author"},"E3005":{"severity":"error","messageTemplateId":"workflow.schema.const","remediationClass":"author"},"E3006":{"severity":"error","messageTemplateId":"workflow.schema.duplicateSetKey","remediationClass":"author"},"E3007":{"severity":"error","messageTemplateId":"workflow.schema.noopConfig","remediationClass":"author"},"E3008":{"severity":"error","messageTemplateId":"workflow.schema.unsupported","remediationClass":"author"},"E3009":{"severity":"error","messageTemplateId":"workflow.schema.unsupportedFoundationField","remediationClass":"author"},"E3010":{"severity":"error","messageTemplateId":"workflow.schema.invalidPort","remediationClass":"author"},"E3101":{"severity":"error","messageTemplateId":"workflow.registry.unknownNodeKind","remediationClass":"registry"},"E3201":{"severity":"error","messageTemplateId":"workflow.graph.unknownRequiredNode","remediationClass":"author"},"E3202":{"severity":"error","messageTemplateId":"workflow.graph.invalidDependency","remediationClass":"author"},"E3203":{"severity":"error","messageTemplateId":"workflow.graph.cycle","remediationClass":"author"},"E4001":{"severity":"error","messageTemplateId":"workflow.canonical.invalidValue","remediationClass":"author"}}};
const yamlProfile = {"schema":"pkm.workflow.yaml-profile/v1","encoding":"UTF-8","allowBom":false,"documentCount":1,"yamlVersion":"1.2","scalarKeysOnly":true,"rejectDuplicateKeys":true,"allowMergeKeys":false,"implicitScalarTyping":false,"limits":{"sourceBytes":1048576,"nestingDepth":64,"scalarBytes":262144,"collectionEntries":100000,"aliasExpansionDepth":32,"aliasReferences":10000,"expandedNodes":100000}};

function visitSchemas(value) {
  if (!value || typeof value !== "object") return;
  if (value.type === "array") {
    assert(["set", "semantic"].includes(value["x-pkm-order"]), "every registered array declares x-pkm-order");
    assert(Array.isArray(value["x-pkm-sort-key"]) && value["x-pkm-sort-key"].length, "every registered array declares a total sort key");
  }
  Object.values(value).forEach(visitSchemas);
}

visitSchemas(schema);
assert.strictEqual(schema.$id, "pkm.workflow.definition/v1");
assert.strictEqual(yamlProfile.schema, "pkm.workflow.yaml-profile/v1");
assert.strictEqual(yamlProfile.limits.aliasExpansionDepth, 32);
assert.deepStrictEqual(Object.keys(orderRegistry.arrays).sort(), [
  "/spec/completion/requiredNodes",
  "/spec/nodes",
  "/spec/nodes/*/config/args",
  "/spec/nodes/*/config/choices",
  "/spec/nodes/*/control/cases",
  "/spec/nodes/*/dependsOn",
  "/spec/nodes/*/dependsOn/*/accept",
  "/spec/nodes/*/ports/inputs",
  "/spec/nodes/*/ports/outputs"
]);

const positiveFixture = {"name":"minimal-noop","input":{"schema":"pkm.workflow.definition/v1","spec":{"inputs":{},"nodes":[{"nodeId":"complete","kind":"pkm.step.noop/v1","config":{},"dependsOn":[]}],"outputs":{},"completion":{"requiredNodes":["complete"]}}},"canonical":"{\"schema\":\"pkm.workflow.definition/v1\",\"spec\":{\"completion\":{\"requiredNodes\":[\"complete\"]},\"inputs\":{},\"nodes\":[{\"config\":{},\"dependsOn\":[],\"kind\":\"pkm.step.noop/v1\",\"nodeId\":\"complete\"}],\"outputs\":{}}}","executableDigest":"52b97c67277843962d5ad7914ec9f456d22ca0213bbb32b4b8196659b84d2f35"};
const negativeFixture = {"name":"rejected-duplicates","input":{"schema":"pkm.workflow.definition/v1","extra":true,"spec":{"inputs":{},"nodes":[{"nodeId":"complete","kind":"pkm.step.noop/v1","config":{},"dependsOn":[]},{"nodeId":"complete","kind":"pkm.step.noop/v1","config":{},"dependsOn":[]}],"outputs":{},"completion":{"requiredNodes":["complete"]}}},"diagnostics":[{"phase":"P3","code":"E3001","severity":"error","pointer":"/extra","details":{"key":"extra"},"messageTemplateId":"workflow.schema.unknownField","remediationClass":"author"},{"phase":"P3","code":"E3006","severity":"error","pointer":"/spec/nodes","details":{"nodeId":"complete"},"messageTemplateId":"workflow.schema.duplicateSetKey","remediationClass":"author"}]};
const compiled = compileWorkflowDefinitionV1(positiveFixture.input);
assert.strictEqual(compiled.ok, true);
assert.strictEqual(compiled.canonicalBytes.toString("utf8"), positiveFixture.canonical);
assert.strictEqual(compiled.executableDigest, positiveFixture.executableDigest);

const invalid = compileWorkflowDefinitionV1(negativeFixture.input);
assert.strictEqual(invalid.ok, false);
assert.deepStrictEqual(invalid.diagnostics, negativeFixture.diagnostics);
for (const item of invalid.diagnostics) assert(diagnosticRegistry.codes[item.code], `diagnostic ${item.code} must be registered`);

const typed = compileWorkflowDefinitionV1({
  ...positiveFixture.input,
  spec: {
    ...positiveFixture.input.spec,
    inputs: { count: { type: "int64", required: true, nullable: false, schema: {}, default: "2" } },
    outputs: { ratio: { type: "decimal", required: true, nullable: false, schema: {}, default: "1.500" } }
  }
});
assert.strictEqual(typed.ok, true);
assert.strictEqual(typed.model.spec.outputs.ratio.default, "1.5");
const invalidPort = compileWorkflowDefinitionV1({ ...positiveFixture.input, spec: { ...positiveFixture.input.spec, inputs: { name: { type: "string" } } } });
assert.strictEqual(invalidPort.ok, false);
assert.strictEqual(invalidPort.diagnostics[0].code, "E3010");
assert(diagnosticRegistry.codes.E3010);

const graphControls = compileWorkflowDefinitionV1({
  ...positiveFixture.input,
  spec: {
    ...positiveFixture.input.spec,
    nodes: [
      { nodeId: "directions", kind: "pkm.step.noop/v1", config: {}, generalInstruction: "  Clarify the reusable brief before planning.  ", dependsOn: [], ports: { inputs: ["brief"], outputs: ["directions", "risks"] }, control: { mode: "single" } },
      { nodeId: "explore", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "directions", fromOutput: "directions", toInput: "direction", accept: ["succeeded"], required: true }], ports: { inputs: ["direction"], outputs: ["candidate"] }, control: { mode: "repeat", count: { kind: "dynamic" } } },
      { nodeId: "optimize", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "explore", fromOutput: "candidate", toInput: "candidate", accept: ["succeeded"], required: true }], ports: { inputs: ["candidate"], outputs: ["best"] }, control: { mode: "repeat", count: { kind: "fixed", value: 8 } } },
      { nodeId: "route", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "optimize", fromOutput: "best", toInput: "result", accept: ["succeeded"], required: true }], ports: { inputs: ["result"], outputs: ["accept", "revise"] }, control: { mode: "branch", kind: "switch", cases: ["accept", "revise"], dynamicCases: true } }
    ],
    completion: { requiredNodes: ["route"] },
    trigger: { kind: "cron", expression: "0 9 * * 1", timezone: "UTC" }
  }
});
assert.strictEqual(graphControls.ok, true);
assert.strictEqual(graphControls.model.spec.nodes.find(node => node.nodeId === "directions").generalInstruction, "Clarify the reusable brief before planning.");
assert.deepStrictEqual(graphControls.model.spec.nodes.find(node => node.nodeId === "explore").control, { mode: "repeat", count: { kind: "dynamic" } });
assert.deepStrictEqual(graphControls.model.spec.nodes.find(node => node.nodeId === "route").ports.outputs, ["accept", "revise"]);
assert.strictEqual(graphControls.model.spec.nodes.find(node => node.nodeId === "route").control.dynamicCases, true);
assert.deepStrictEqual(graphControls.model.spec.trigger, { kind: "cron", expression: "0 9 * * 1", timezone: "UTC" });

const traversal = compileWorkflowDefinitionV1(definition({ traversalStrategy: "depth-first" }));
assert.strictEqual(traversal.ok, true);
assert.strictEqual(traversal.model.spec.traversalStrategy, "depth-first");
assertDiagnostic(definition({ traversalStrategy: "random" }), "E3005", "/spec/traversalStrategy");
const childDigest = "a".repeat(64);
const subflow = compileWorkflowDefinitionV1(definition({
  nodes: [{ nodeId: "child", kind: "pkm.subflow/v1", config: { recipeId: "recipe_child", revision: 3, executableDigest: childDigest }, dependsOn: [] }],
  completion: { requiredNodes: ["child"] }
}));
assert.strictEqual(subflow.ok, true);
assert.deepStrictEqual(subflow.model.spec.nodes[0].config, { recipeId: "recipe_child", revision: 3, executableDigest: childDigest });
assertDiagnostic(definition({ nodes: [{ nodeId: "child", kind: "pkm.subflow/v1", config: { recipeId: "recipe_child", revision: 0, executableDigest: "bad" }, dependsOn: [] }] }), "E3005", "/spec/nodes/0/config/revision");
assertDiagnostic(definition({ nodes: [{ nodeId: "child", kind: "pkm.subflow/v1", config: { recipeId: "recipe_child", revision: 1, executableDigest: "bad" }, dependsOn: [] }] }), "E3005", "/spec/nodes/0/config/executableDigest");

const executable = compileWorkflowDefinitionV1(definition({
  nodes: [{ nodeId: "download", kind: "pkm.step.command/v1", config: {
    program: "python3", args: ["scripts/download-log.py", "${inputs.runId}"], cwd: "${inputs.workspace}"
  }, dependsOn: [] }],
  completion: { requiredNodes: ["download"] }
}));
assert.strictEqual(executable.ok, true);
assert.deepStrictEqual(executable.model.spec.nodes[0].config, {
  program: "python3", args: ["scripts/download-log.py", "${inputs.runId}"],
  timeoutSeconds: 300, maxOutputBytes: 65536, cwd: "${inputs.workspace}"
});
assertDiagnostic(definition({ nodes: [{ nodeId: "run", kind: "pkm.step.command/v1", config: { program: "python3", args: [], timeoutSeconds: 0 }, dependsOn: [] }] }), "E3005", "/spec/nodes/0/config/timeoutSeconds");

const pythonScript = compileWorkflowDefinitionV1(definition({
  nodes: [{ nodeId: "analyze", kind: "pkm.step.script/v1", config: {
    runtime: "python", environmentId: "analysis-env", script: "print('ready')"
  }, dependsOn: [] }],
  completion: { requiredNodes: ["analyze"] }
}));
assert.strictEqual(pythonScript.ok, true);
assert.deepStrictEqual(pythonScript.model.spec.nodes[0].config, {
  runtime: "python", script: "print('ready')", environmentId: "analysis-env",
  timeoutSeconds: 300, maxOutputBytes: 65536
});
const parameterizedScript = compileWorkflowDefinitionV1(definition({
  inputs: { path: { type: "string", required: true, nullable: false, schema: {} } },
  nodes: [{ nodeId: "transfer", kind: "pkm.step.script/v1", config: {
    runtime: "python", environmentId: "analysis-env", script: "import sys; print(sys.argv[1:])",
    args: ["${inputs.path}", "", "--overwrite=false"]
  }, dependsOn: [] }],
  completion: { requiredNodes: ["transfer"] }
}));
assert.strictEqual(parameterizedScript.ok, true, JSON.stringify(parameterizedScript.diagnostics));
assert.deepStrictEqual(parameterizedScript.model.spec.nodes[0].config.args,
  ["${inputs.path}", "", "--overwrite=false"]);
const pipelineDefinition = JSON.parse(JSON.stringify(parameterizedScript.model));
pipelineDefinition.spec.nodes[0].kind = "pkm.step.pipeline/v1";
pipelineDefinition.spec.nodes[0].config.executor = "script";
const pipeline = compileWorkflowDefinitionV1(pipelineDefinition);
assert.strictEqual(pipeline.ok, true, JSON.stringify(pipeline.diagnostics));
assert.strictEqual(pipeline.model.spec.nodes[0].kind, "pkm.step.pipeline/v1");
assert.strictEqual(pipeline.model.spec.nodes[0].config.executor, "script");
assert.deepStrictEqual(pipeline.model.spec.nodes[0].config.args,
  ["${inputs.path}", "", "--overwrite=false"]);
for (const args of ["one string", [null], ["embedded\0null"]]) {
  assertDiagnostic(definition({ nodes: [{ nodeId: "run", kind: "pkm.step.script/v1",
    config: { runtime: "bash", script: "echo ready", args }, dependsOn: [] }] }), "E3003", "/spec/nodes/0/config/args");
}
assertDiagnostic(definition({ nodes: [{ nodeId: "run", kind: "pkm.step.script/v1", config: { runtime: "python", script: "print('no fallback')" }, dependsOn: [] }] }), "E3005", "/spec/nodes/0/config/environmentId");

const nativeOperation = compileWorkflowDefinitionV1(definition({
  inputs: {
    reason: { type: "string", required: false, nullable: false, schema: {}, default: "manual" },
  },
  nodes: [{ nodeId: "snapshot", kind: "pkm.step.native/v1", config: {
    operation: "agent_session_snapshot_create",
    arguments: { state_json: "", reason: "${inputs.reason}" },
  }, dependsOn: [] }],
  completion: { requiredNodes: ["snapshot"] },
}));
assert.strictEqual(nativeOperation.ok, true);
assert.deepStrictEqual(nativeOperation.model.spec.nodes[0].config, {
  operation: "agent_session_snapshot_create",
  arguments: { reason: "${inputs.reason}", state_json: "" },
});
assertDiagnostic(definition({
  nodes: [{ nodeId: "snapshot", kind: "pkm.step.native/v1", config: {
    operation: "invalid operation", arguments: {},
  }, dependsOn: [] }],
}), "E3002", "/spec/nodes/0/config/operation");
assertDiagnostic(definition({ nodes: [{ nodeId: "run", kind: "pkm.step.script/v1", config: { runtime: "bash", script: "echo ready", environmentId: "invalid-for-bash" }, dependsOn: [] }] }), "E3005", "/spec/nodes/0/config/environmentId");
assertDiagnostic(definition({ nodes: [{ nodeId: "run", kind: "pkm.step.script/v1", config: { runtime: "ruby", script: "puts 'no'" }, dependsOn: [] }] }), "E3005", "/spec/nodes/0/config/runtime");

const humanGate = compileWorkflowDefinitionV1(definition({
  nodes: [{ nodeId: "permission", kind: "pkm.gate.human/v1", config: {
    prompt: "Proceed with the download?", inputKind: "approval"
  }, dependsOn: [] }],
  completion: { requiredNodes: ["permission"] }
}));
assert.strictEqual(humanGate.ok, true);
assert.deepStrictEqual(humanGate.model.spec.nodes[0].config, { prompt: "Proceed with the download?", inputKind: "approval" });
assertDiagnostic(definition({ nodes: [{ nodeId: "choose", kind: "pkm.gate.human/v1", config: { prompt: "Choose", inputKind: "choice", choices: ["only"] }, dependsOn: [] }] }), "E3004", "/spec/nodes/0/config/choices");
assertDiagnostic(definition({ trigger: { kind: "cron", expression: "daily", timezone: "UTC" } }), "E3005", "/spec/trigger/expression");
assertDiagnostic(definition({ trigger: { kind: "cron", expression: "0 9 * * *", timezone: "" } }), "E3005", "/spec/trigger/timezone");

const cycle = compileWorkflowDefinitionV1({
  ...positiveFixture.input,
  spec: {
    ...positiveFixture.input.spec,
    nodes: [
      { nodeId: "b", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "a", accept: ["succeeded"], required: true }] },
      { nodeId: "a", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "b", accept: ["succeeded"], required: true }] }
    ],
    completion: { requiredNodes: ["b"] }
  }
});
assert.strictEqual(cycle.ok, false);
const cycleDiagnostic = cycle.diagnostics.find(item => item.code === "E3203");
assert.deepStrictEqual(cycleDiagnostic.details.witness, ["a", "b", "a"]);
assert.strictEqual(cycleDiagnostic.details.cycle, "a → b → a");
assert.deepStrictEqual(cycleDiagnostic.details.edges, [{ from: "a", to: "b" }, { from: "b", to: "a" }]);
assert.deepStrictEqual(cycleDiagnostic.details.suggestedLoopEdge, { from: "b", to: "a" });
assert.deepStrictEqual(cycleDiagnostic.details.remediation, {
  action: "declare-terminating-loop-edge",
  requiredFields: ["loop.termination.condition", "loop.termination.maxIterations"]
});

const selfCycle = compileWorkflowDefinitionV1({
  ...positiveFixture.input,
  spec: {
    ...positiveFixture.input.spec,
    nodes: [{ nodeId: "retry", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "retry", accept: ["again"], required: true }] }],
    completion: { requiredNodes: ["retry"] }
  }
});
assert.strictEqual(selfCycle.ok, false);
assert.strictEqual(selfCycle.diagnostics.find(item => item.code === "E3203").details.cycle, "retry → retry");

const terminatingSelfLoop = compileWorkflowDefinitionV1({
  ...positiveFixture.input,
  spec: {
    ...positiveFixture.input.spec,
    nodes: [{ nodeId: "retry", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "retry", accept: ["again"], required: true, loop: { termination: { condition: "done", maxIterations: 5 } } }] }],
    completion: { requiredNodes: ["retry"] }
  }
});
assert.strictEqual(terminatingSelfLoop.ok, true, JSON.stringify(terminatingSelfLoop.diagnostics));

const terminatingLoop = compileWorkflowDefinitionV1({
  ...positiveFixture.input,
  spec: {
    ...positiveFixture.input.spec,
    nodes: [
      { nodeId: "check", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "work", accept: ["continue"], required: true }] },
      { nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "check", accept: ["repeat"], required: true, loop: { termination: { condition: "score >= target", maxIterations: 25 } } }] }
    ],
    completion: { requiredNodes: ["check"] }
  }
});
assert.strictEqual(terminatingLoop.ok, true, JSON.stringify(terminatingLoop.diagnostics));
assert.deepStrictEqual(terminatingLoop.model.spec.nodes.find(node => node.nodeId === "work").dependsOn[0].loop, { termination: { condition: "score >= target", maxIterations: 25 } });

const unboundedLoop = {
  ...positiveFixture.input,
  spec: {
    ...positiveFixture.input.spec,
    nodes: [
      { nodeId: "check", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "work", accept: ["continue"], required: true }] },
      { nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "check", accept: ["repeat"], required: true, loop: { termination: { condition: "done" } } }] }
    ],
    completion: { requiredNodes: ["check"] }
  }
};
assertDiagnostic(unboundedLoop, "E3005", "/spec/nodes/1/dependsOn/0/loop/termination/maxIterations");
assertDiagnostic(unboundedLoop, "E3203", "/spec/nodes");

const repeated = compileWorkflowDefinitionV1(positiveFixture.input);
assert.strictEqual(repeated.ok, true);
assert.strictEqual(repeated.canonicalBytes.toString("hex"), compiled.canonicalBytes.toString("hex"));
assert.strictEqual(repeated.executableDigest, compiled.executableDigest);

assert.strictEqual(canonicalJson({ z: -0, a: "é" }), '{"a":"é","z":0}');
assert.throws(() => canonicalJson("\ud800"), /surrogate/);

function diagnosticsFor(input) {
  const result = compileWorkflowDefinitionV1(input);
  assert.strictEqual(result.ok, false);
  return result.diagnostics;
}

function assertDiagnostic(input, code, pointer) {
  const item = diagnosticsFor(input).find(diagnostic => diagnostic.code === code && diagnostic.pointer === pointer);
  assert(item, `expected ${code} at ${pointer}`);
  return item;
}

function definition(spec = {}) {
  return {
    schema: "pkm.workflow.definition/v1",
    spec: {
      inputs: {},
      nodes: [{ nodeId: "done", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
      outputs: {},
      completion: { requiredNodes: ["done"] },
      ...spec
    }
  };
}

for (const malformed of [null, [], "workflow"]) {
  assertDiagnostic(malformed, "E3003", "");
}
assertDiagnostic({ schema: "wrong", "extra~/field": true, spec: null }, "E3001", "/extra~0~1field");
assertDiagnostic({ schema: "wrong", spec: null }, "E3008", "/schema");
assertDiagnostic({ schema: "pkm.workflow.definition/v1", spec: null }, "E3003", "/spec");
assertDiagnostic(definition({ surprise: true }), "E3001", "/spec/surprise");
assertDiagnostic(definition({ inputs: null }), "E3003", "/spec/inputs");
assertDiagnostic(definition({ outputs: [] }), "E3003", "/spec/outputs");
assertDiagnostic(definition({ nodes: null }), "E3004", "/spec/nodes");
assertDiagnostic(definition({ nodes: [] }), "E3004", "/spec/nodes");
assertDiagnostic(definition({ nodes: [null] }), "E3003", "/spec/nodes/0");

const invalidNode = definition({
  nodes: [{
    nodeId: "1bad",
    kind: "unknown.step/v1",
    config: { forbidden: true },
    dependsOn: "not-an-array",
    extra: true
  }]
});
assertDiagnostic(invalidNode, "E3001", "/spec/nodes/0/extra");
assertDiagnostic(invalidNode, "E3002", "/spec/nodes/0/nodeId");
assertDiagnostic(invalidNode, "E3101", "/spec/nodes/0/kind");
assertDiagnostic(invalidNode, "E3007", "/spec/nodes/0/config");
assertDiagnostic(invalidNode, "E3003", "/spec/nodes/0/dependsOn");
assertDiagnostic(definition({ nodes: [{ nodeId: "done", kind: "pkm.step.noop/v1", config: null, dependsOn: [] }] }), "E3007", "/spec/nodes/0/config");
assertDiagnostic(definition({ nodes: [{ nodeId: "done", kind: "pkm.step.noop/v1", config: {}, generalInstruction: 42, dependsOn: [] }] }), "E3003", "/spec/nodes/0/generalInstruction");
assertDiagnostic(definition({ nodes: [{ nodeId: "done", kind: "pkm.step.noop/v1", config: {}, generalInstruction: "   ", dependsOn: [] }] }), "E3005", "/spec/nodes/0/generalInstruction");

for (const nodeId of [42, "e\u0301", `a${"b".repeat(128)}`]) {
  assertDiagnostic(definition({ nodes: [{ nodeId, kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }] }), "E3002", "/spec/nodes/0/nodeId");
}

const dependencyBase = dependency => definition({
  nodes: [
    { nodeId: "start", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] },
    { nodeId: "done", kind: "pkm.step.noop/v1", config: {}, dependsOn: [dependency] }
  ]
});
assertDiagnostic(dependencyBase(null), "E3003", "/spec/nodes/1/dependsOn/0");
assertDiagnostic(dependencyBase({ from: "start", accept: [], required: true }), "E3004", "/spec/nodes/1/dependsOn/0/accept");
assertDiagnostic(dependencyBase({ from: "start", accept: "succeeded", required: true }), "E3004", "/spec/nodes/1/dependsOn/0/accept");
assertDiagnostic(dependencyBase({ from: "start", accept: [false], required: true }), "E3004", "/spec/nodes/1/dependsOn/0/accept");
assertDiagnostic(dependencyBase({ from: "start", accept: [""], required: true }), "E3004", "/spec/nodes/1/dependsOn/0/accept");
assertDiagnostic(dependencyBase({ from: "start", accept: ["succeeded"], required: false }), "E3005", "/spec/nodes/1/dependsOn/0/required");
assertDiagnostic(dependencyBase({ from: "start", accept: ["succeeded", "succeeded"], required: true }), "E3006", "/spec/nodes/1/dependsOn/0/accept");
assertDiagnostic(dependencyBase({ from: 1, accept: ["succeeded"], required: true }), "E3002", "/spec/nodes/1/dependsOn/0/from");
assertDiagnostic(dependencyBase({ from: "start", accept: ["succeeded"], required: true, extra: true }), "E3001", "/spec/nodes/1/dependsOn/0/extra");

const defaultDependency = compileWorkflowDefinitionV1(dependencyBase({ from: "start" }));
assert.strictEqual(defaultDependency.ok, true);
assert.deepStrictEqual(defaultDependency.model.spec.nodes[0].dependsOn[0], { from: "start", accept: ["succeeded"], required: true });

const duplicateDependency = dependencyBase({ from: "start", accept: ["failed"], required: true });
duplicateDependency.spec.nodes[1].dependsOn.push({ from: "start", accept: ["failed"], required: true });
assertDiagnostic(duplicateDependency, "E3006", "/spec/nodes/1/dependsOn");
assertDiagnostic(dependencyBase({ from: "missing", accept: ["succeeded"], required: true }), "E3202", "/spec/nodes/done/dependsOn");
assertDiagnostic(definition({ nodes: [{ nodeId: "done", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "done" }] }] }), "E3203", "/spec/nodes");

for (const completion of [null, [], "done"]) {
  assertDiagnostic(definition({ completion }), "E3003", "/spec/completion");
}
assertDiagnostic(definition({ completion: { requiredNodes: ["done"], extra: true } }), "E3001", "/spec/completion/extra");
for (const requiredNodes of [undefined, "done", [], [false], ["missing"]]) {
  assertDiagnostic(definition({ completion: requiredNodes === undefined ? {} : { requiredNodes } }), "E3201", "/spec/completion/requiredNodes");
}
assertDiagnostic(definition({ completion: { requiredNodes: ["done", "done"] } }), "E3006", "/spec/completion/requiredNodes");
const nestedCompletionDiagnostics = diagnosticsFor(definition({ completion: { extra: true } }));
assert.deepStrictEqual(nestedCompletionDiagnostics.map(item => item.pointer), ["/spec/completion/extra", "/spec/completion/requiredNodes"]);

const indexedNodeDiagnostics = diagnosticsFor(definition({ nodes: Array.from({ length: 11 }, () => null) }));
assert.deepStrictEqual(
  indexedNodeDiagnostics.filter(item => item.pointer.startsWith("/spec/nodes/")).map(item => item.pointer),
  Array.from({ length: 11 }, (_, index) => `/spec/nodes/${index}`)
);

const parentFirstDiagnostics = diagnosticsFor(definition({
  nodes: [
    { nodeId: "done", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] },
    { nodeId: "done", kind: "pkm.step.noop/v1", config: null, dependsOn: [] }
  ]
}));
assert.deepStrictEqual(parentFirstDiagnostics.map(item => item.pointer), ["/spec/nodes", "/spec/nodes/1/config"]);

const malformedPorts = definition({ inputs: { "bad/key": {}, "1bad": {} } });
assertDiagnostic(malformedPorts, "E3002", "/spec/inputs/1bad");
assertDiagnostic(malformedPorts, "E3002", "/spec/inputs/bad~1key");

const throwingPorts = {};
Object.defineProperty(throwingPorts, "port", { enumerable: true, get() { throw new TypeError("port getter failed"); } });
assert.throws(() => compileWorkflowDefinitionV1(definition({ inputs: throwingPorts })), /port getter failed/);

const ordered = compileWorkflowDefinitionV1(definition({
  inputs: {
    aa: { type: "boolean", required: true, nullable: false, schema: {} },
    a: { type: "boolean", required: true, nullable: false, schema: {} }
  },
  nodes: [
    { nodeId: "done", kind: "pkm.step.noop/v1", config: {}, dependsOn: [
      { from: "aa", accept: ["z", "a"], required: true },
      { from: "a", accept: ["succeeded"], required: true }
    ] },
    { nodeId: "aa", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] },
    { nodeId: "a", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }
  ],
  completion: { requiredNodes: ["done", "a"] }
}));
assert.strictEqual(ordered.ok, true);
assert.deepStrictEqual(ordered.model.spec.completion.requiredNodes, ["a", "done"]);
assert.deepStrictEqual(ordered.model.spec.nodes.map(node => node.nodeId), ["a", "aa", "done"]);
assert.deepStrictEqual(ordered.model.spec.nodes[2].dependsOn.map(item => item.from), ["a", "aa"]);
assert.deepStrictEqual(ordered.model.spec.nodes[2].dependsOn[1].accept, ["a", "z"]);

const complexCycles = diagnosticsFor(definition({
  nodes: [
    { nodeId: "a", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "c" }, { from: "b" }] },
    { nodeId: "b", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "a" }, { from: "c" }] },
    { nodeId: "c", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "b" }, { from: "a" }] },
    { nodeId: "x", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "y" }] },
    { nodeId: "y", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "x" }] }
  ],
  completion: { requiredNodes: ["a"] }
})).filter(item => item.code === "E3203");
assert.deepStrictEqual(complexCycles.map(item => item.details.witness), [["a", "b", "a"], ["x", "y", "x"]]);

const chordedCycle = diagnosticsFor(definition({
  nodes: [
    { nodeId: "a", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "c" }] },
    { nodeId: "b", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "a" }, { from: "c" }] },
    { nodeId: "c", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "b" }] },
    { nodeId: "z", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "c" }] }
  ],
  completion: { requiredNodes: ["z"] }
})).find(item => item.code === "E3203");
assert.deepStrictEqual(chordedCycle.details.witness, ["b", "c", "b"]);

assert.strictEqual(canonicalJson(null), "null");
assert.strictEqual(canonicalJson(true), "true");
assert.strictEqual(canonicalJson(false), "false");
assert.strictEqual(canonicalJson(1.25), "1.25");
assert.strictEqual(canonicalJson([null, true, "x"]), '[null,true,"x"]');
assert.strictEqual(canonicalJson({ aa: 2, a: 1 }), '{"a":1,"aa":2}');
assert.throws(() => canonicalJson(Infinity), /Non-finite/);
assert.throws(() => canonicalJson(-Infinity), /Non-finite/);
assert.throws(() => canonicalJson("\udc00"), /surrogate/);
for (const unsupported of [undefined, Symbol("value"), 1n, () => {}]) {
  assert.throws(() => canonicalJson(unsupported), /Unsupported canonical JSON type/);
}

import * as capturedValueContracts from "../dist/domain/project-recipes-value-contracts.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const valueContracts = { ...capturedValueContracts };
const module = { exports: {} };
const localRequire = createRequire(import.meta.url);
const compilerSource = readFileSync(new URL("../src/domain/project-recipes-workflow-contracts.ts", import.meta.url), "utf8");
const compilerCommonJs = ts.transpileModule(compilerSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
}).outputText;
runInNewContext(compilerCommonJs, {
  exports: module.exports, module, Buffer,
  require: name => name === "./project-recipes-value-contracts.js" ? valueContracts : localRequire(name),
});
const compileWorkflowWithMutableValues = module.exports.compileWorkflowDefinitionV1;
const originalNormalizePortDescriptor = valueContracts.normalizePortDescriptor;
valueContracts.normalizePortDescriptor = () => ({ type: "string", required: false, nullable: true, schema: {}, default: Symbol("invalid") });
try {
  const canonicalFailure = compileWorkflowWithMutableValues(definition({ inputs: { broken: {} } }));
  assert.strictEqual(canonicalFailure.ok, false);
  assert.strictEqual(canonicalFailure.diagnostics[0].code, "E4001");
  assert.strictEqual(canonicalFailure.diagnostics[0].phase, "P5");
} finally {
  valueContracts.normalizePortDescriptor = originalNormalizePortDescriptor;
}
console.log(`workflow contracts test: schema/profile/diagnostics and canonical digest ${compiled.executableDigest} OK`);