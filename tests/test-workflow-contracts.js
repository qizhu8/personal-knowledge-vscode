#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { canonicalJson, compileWorkflowDefinitionV1 } = require("../dist/workflow-contracts.js");

const root = path.resolve(__dirname, "..");
const contracts = path.join(root, "resources", "workflow-contracts", "v1");
const schema = JSON.parse(fs.readFileSync(path.join(contracts, "definition.schema.json"), "utf8"));
const orderRegistry = JSON.parse(fs.readFileSync(path.join(contracts, "canonical-order.json"), "utf8"));
const diagnosticRegistry = JSON.parse(fs.readFileSync(path.join(contracts, "diagnostics.json"), "utf8"));
const yamlProfile = JSON.parse(fs.readFileSync(path.join(contracts, "yaml-profile.json"), "utf8"));

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
  "/spec/nodes/*/dependsOn",
  "/spec/nodes/*/dependsOn/*/accept"
]);

const fixtures = path.join(contracts, "fixtures");
const positiveFixture = JSON.parse(fs.readFileSync(path.join(fixtures, "minimal-noop.json"), "utf8"));
const negativeFixture = JSON.parse(fs.readFileSync(path.join(fixtures, "rejected-duplicates.json"), "utf8"));
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
assert.deepStrictEqual(cycle.diagnostics.find(item => item.code === "E3203").details.witness, ["a", "b", "a"]);

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
assertDiagnostic(definition({ nodes: [{ nodeId: "done", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "done" }] }] }), "E3202", "/spec/nodes/done/dependsOn");

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

const valueContracts = require("../dist/workflows/value-contracts.js");
const originalNormalizePortDescriptor = valueContracts.normalizePortDescriptor;
valueContracts.normalizePortDescriptor = () => ({ type: "string", required: false, nullable: true, schema: {}, default: Symbol("invalid") });
try {
  const canonicalFailure = compileWorkflowDefinitionV1(definition({ inputs: { broken: {} } }));
  assert.strictEqual(canonicalFailure.ok, false);
  assert.strictEqual(canonicalFailure.diagnostics[0].code, "E4001");
  assert.strictEqual(canonicalFailure.diagnostics[0].phase, "P5");
} finally {
  valueContracts.normalizePortDescriptor = originalNormalizePortDescriptor;
}
console.log(`workflow contracts test: schema/profile/diagnostics and canonical digest ${compiled.executableDigest} OK`);