import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ACTION_COMPILER_LIMITS, actionCompilerDefinitions, readActionCompiler,
} from "../dist/action-compiler.js";
import { componentDigest, originalDigest, pythonCanonicalJson } from "../dist/domain/action-compiler-validation.js";
import { ORIGINAL_ACTION_COMPILER_CAPTURE } from "../dist/domain/action-compiler-original.js";
import {
  originalActionCompilerFixtures as original,
  originalActionCompilerRegression,
  originalActionCompilerSource,
} from "./action-compiler-original-fixtures.mjs";
import { actionCompilerTransportFixture, moduleSetSource } from "./action-compiler-fixtures.mjs";
import { checkCaptureRecords } from "../scripts/migration.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const call = (operation, args) => {
  const result = readActionCompiler({ operation, args });
  return actionCompilerTransportFixture(operation, args, result);
};
const fixtureSource = (enabled = false) => moduleSetSource(
  structuredClone(original.moduleSet),
  { [`definitions/${original.example.action_id}.json`]: original.moduleSetFile },
  enabled,
);

function moduleSetWithFiles(extraFiles) {
  const source = fixtureSource();
  const files = { ...source.files, ...extraFiles };
  const manifest = structuredClone(source.manifest);
  manifest.files = Object.fromEntries(Object.entries(files).map(([name, text]) => [name, hash(text)]));
  delete manifest.package_hash;
  const packageHash = originalDigest(manifest);
  manifest.package_hash = packageHash;
  return moduleSetSource(manifest, files);
}

test("Action compiler exports only read-only deterministic operations", () => {
  assert.deepEqual(actionCompilerDefinitions.map(item => item.readOnly), [true, true, true, true, true]);
  const result = call("action.compiler.capabilities", {}).result;
  assert.equal(result.runtimeStatus, "not-runnable-here");
  assert.equal(result.definitionSchema, "pkm.action.definition/v1");
  assert.deepEqual(result.implementationKinds, ["program", "pipeline", "mcp"]);
  assert.equal(result.limits.inputBytes, ACTION_COMPILER_LIMITS.inputBytes);
  assert.ok(result.unavailable.includes("host-path-reads"));
});

test("original valid and invalid authoring diagnostics are preserved without mutation", () => {
  const definition = structuredClone(original.example);
  const valid = call("action.definition.check", { source: { kind: "inline", definition } });
  assert.deepEqual(valid.result, {
    schema: "pkm.action.definition-check/v1",
    ok: true,
    diagnostics: [],
    persisted: false,
    executed: false,
    readiness_checked: false,
    next_action: "action_register",
  });
  assert.deepEqual(definition, original.example);

  for (const fixture of original.diagnostics) {
    const result = call("action.definition.check", {
      source: { kind: "inline", definition: structuredClone(fixture.definition) },
    }).result;
    assert.equal(result.ok, false, fixture.id);
    assert.deepEqual(result.diagnostics, fixture.diagnostics, fixture.id);
    assert.equal(result.persisted, false);
    assert.equal(result.executed, false);
    assert.equal(result.readiness_checked, false);
  }
});

test("original diagnostic traversal order is pinned", () => {
  const result = call("action.definition.check", {
    source: { kind: "inline", definition: structuredClone(original.orderedDefinition) },
  }).result;
  assert.deepEqual(result.diagnostics, original.orderedDiagnostics);
  assert.deepEqual(result.diagnostics.map(item => item.path), [
    "/action_id", "/effects", "/implementations/0/platforms/0",
  ]);
});

test("original semantic definition failures remain non-mutating diagnostics", () => {
  const reserved = structuredClone(original.example);
  reserved.action_id = "core.delay";
  assert.equal(call("action.definition.check", { source: { kind: "inline", definition: reserved } }).result.diagnostics[0].message,
    "Invalid or reserved Action ID.");

  const missingDependency = structuredClone(original.example);
  missingDependency.dependencies = { "fixture.not.registered": "0".repeat(64) };
  assert.match(call("action.definition.check", {
    source: { kind: "inline", definition: missingDependency },
  }).result.diagnostics[0].message, /not registered or its ModuleSet is not loaded/);

  const invalidPipeline = structuredClone(original.example);
  invalidPipeline.implementations = [{
    kind: "pipeline",
    platforms: ["Linux"],
    steps: [{ id: "invalid", component: "missing", inputs: {} }],
  }];
  assert.equal(call("action.definition.check", {
    source: { kind: "inline", definition: invalidPipeline },
  }).result.diagnostics[0].message, "Unknown basic component.");

  const invalidReconciler = structuredClone(original.example);
  invalidReconciler.reconciler = { kind: "remote-resource" };
  assert.equal(call("action.definition.check", {
    source: { kind: "inline", definition: invalidReconciler },
  }).result.diagnostics[0].message,
  "Remote reconciler requires a pinned read-only lookup Action and exact success predicate/output.");
});

test("portable compilation preserves the original ModuleRuntime content digest", () => {
  const response = call("action.definition.compile", {
    source: { kind: "inline", definition: structuredClone(original.example) },
  });
  const result = response.result;
  assert.equal(result.status, "valid");
  assert.equal(result.definitionDigest, original.originalRuntimeContentHash);
  assert.equal(result.definition.content_hash, original.originalRuntimeContentHash);
  assert.equal(originalDigest(result.definition), original.originalRuntimeDigest);
  assert.equal(result.canonicalJson, pythonCanonicalJson(result.definition));
  assert.deepEqual(JSON.parse(result.canonicalJson), result.definition);
  assert.deepEqual(result.plan.implementations, [{
    index: 0, kind: "program", platforms: ["Linux", "Windows", "Darwin"],
  }]);
  assert.equal(response.operation, "action.definition.compile");
  assert.deepEqual(Object.keys(response), ["operation", "args", "result"]);
});

test("explicit ModuleSet projection verifies package and definition file pins", () => {
  const result = call("action.moduleSet.project", { source: fixtureSource() }).result;
  assert.deepEqual(result, {
    ok: true,
    module_sets: [{
      module_set_id: original.moduleSet.module_set_id,
      version: original.moduleSet.version,
      name: original.moduleSet.name,
      actions: original.moduleSet.actions,
      package_hash: original.moduleSet.package_hash,
      provenance: original.moduleSet.provenance,
      enabled: false,
    }],
  });
  const fromModule = call("action.definition.compile", {
    source: fixtureSource(), actionId: original.example.action_id,
  }).result;
  assert.equal(fromModule.status, "valid");
  assert.equal(fromModule.definitionDigest, original.originalRuntimeContentHash);
  const changed = fixtureSource();
  changed.files[`definitions/${original.example.action_id}.json`] += " ";
  assert.throws(() => call("action.moduleSet.project", { source: changed }), /file hash mismatch/);
  assert.throws(() => call("action.moduleSet.project", {
    source: moduleSetSource({ ...original.moduleSet, module_set_id: "../outside" }, { ...fixtureSource().files }),
  }), /Invalid installed ModuleSet manifest/);

  const withResource = moduleSetWithFiles({ "assets/resource.txt": "fixture" });
  withResource.manifest.resources = {
    [original.example.action_id]: { "pkm://knowledge/action_0123456789abcdef01234567": "assets/resource.txt" },
  };
  delete withResource.manifest.package_hash;
  withResource.manifest.package_hash = originalDigest(withResource.manifest);
  assert.equal(call("action.moduleSet.project", { source: withResource }).result.module_sets.length, 1);
  withResource.manifest.resources[original.example.action_id]["pkm://unknown/resource"] = "assets/resource.txt";
  delete withResource.manifest.package_hash;
  withResource.manifest.package_hash = originalDigest(withResource.manifest);
  assert.throws(() => call("action.moduleSet.project", { source: withResource }), /Unsupported or invalid PKM resource URL/);
});

test("original Action block graph compiles with dependency pins and a source map", () => {
  const components = ORIGINAL_ACTION_COMPILER_CAPTURE.componentDefinitions;
  const graph = {
    action_id: "example.graph.echo",
    version: 1,
    name: "Graph echo",
    nodes: [
      {
        id: "constant",
        action_id: "core.constant",
        value_type: "string",
        content_hash: componentDigest(components["core.constant"]),
        parameters: { value: "hello" },
      },
      {
        id: "echo",
        action_id: original.example.action_id,
        content_hash: original.originalRuntimeContentHash,
        parameters: {},
      },
    ],
    edges: [{ source: "constant", output: "value", target: "echo", input: "value" }],
    output_node: "echo",
  };
  const result = call("action.graph.compile", {
    graph,
    sourceModules: [fixtureSource(true)],
  }).result;
  assert.equal(result.status, "valid");
  assert.equal(result.definition.action_id, graph.action_id);
  assert.equal(result.definition.implementations[0].kind, "pipeline");
  assert.deepEqual(result.sourceMap, [
    { sourcePointer: "/nodes/0", canonicalPointer: "/implementations/0/steps/0", nodeId: "constant" },
    { sourcePointer: "/nodes/1", canonicalPointer: "/implementations/0/steps/1", nodeId: "echo" },
  ]);
  assert.equal(result.definitionDigest, result.definition.content_hash);
  assert.equal(
    originalDigest(Object.fromEntries(Object.entries(result.definition).filter(([key]) => key !== "content_hash"))),
    result.definitionDigest,
  );
  assert.equal(result.canonicalJson, pythonCanonicalJson(result.definition));
  const disabled = call("action.graph.compile", { graph, sourceModules: [fixtureSource(false)] }).result;
  assert.equal(disabled.status, "invalid");
  assert.match(disabled.diagnostics[0].message, /not enabled/);
});

test("graph node-count boundary is exact", () => {
  const hashValue = componentDigest(ORIGINAL_ACTION_COMPILER_CAPTURE.componentDefinitions["core.constant"]);
  const makeGraph = count => ({
    action_id: "example.graph.count",
    nodes: Array.from({ length: count }, (_, index) => ({
      id: `block-${index}`,
      action_id: "core.constant",
      value_type: "string",
      content_hash: hashValue,
      parameters: { value: "x" },
    })),
    edges: [],
    output_node: `block-${count - 1}`,
  });
  assert.equal(call("action.graph.compile", { graph: makeGraph(ACTION_COMPILER_LIMITS.graphNodes) }).result.status, "valid");
  const tooMany = call("action.graph.compile", { graph: makeGraph(ACTION_COMPILER_LIMITS.graphNodes + 1) }).result;
  assert.equal(tooMany.status, "invalid");
  assert.match(tooMany.diagnostics[0].message, /1-100 blocks/);
});

test("graph connection-count boundary is exact", () => {
  const graph = {
    action_id: "example.graph.edge-count",
    nodes: [{
      id: "constant",
      action_id: "core.constant",
      value_type: "string",
      content_hash: componentDigest(ORIGINAL_ACTION_COMPILER_CAPTURE.componentDefinitions["core.constant"]),
      parameters: { value: "x" },
    }],
    edges: [],
    output_node: "constant",
  };
  graph.edges = Array.from({ length: ACTION_COMPILER_LIMITS.graphEdges }, (_, index) => ({
    source: "missing", output: `out-${index}`, target: "missing", input: `in-${index}`,
  }));
  const exact = call("action.graph.compile", { graph }).result;
  assert.equal(exact.status, "invalid");
  assert.match(exact.diagnostics[0].message, /unknown block/);
  graph.edges.push({ source: "missing", output: "overflow", target: "missing", input: "overflow" });
  const overflow = call("action.graph.compile", { graph }).result;
  assert.equal(overflow.status, "invalid");
  assert.match(overflow.diagnostics[0].message, /at most 500 connections/);
});

test("definition and ModuleSet byte and file-count limits include the exact boundary", () => {
  const base = structuredClone(original.example);
  const blank = { ...base, description: "" };
  const exactDescriptionLength = ACTION_COMPILER_LIMITS.definitionBytes - Buffer.byteLength(JSON.stringify(blank));
  const exact = { ...base, description: "x".repeat(exactDescriptionLength) };
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), ACTION_COMPILER_LIMITS.definitionBytes);
  assert.equal(call("action.definition.check", { source: { kind: "inline", definition: exact } }).result.ok, true);
  assert.throws(() => call("action.definition.check", {
    source: { kind: "inline", definition: { ...exact, description: exact.description + "x" } },
  }), error => error.code === "RESOURCE_LIMIT");

  const exactCountFiles = {};
  for (let index = 0; index < ACTION_COMPILER_LIMITS.moduleFiles - 2; index += 1) {
    exactCountFiles[`assets/f-${index}.txt`] = "x";
  }
  const exactCount = moduleSetWithFiles(exactCountFiles);
  assert.equal(Object.keys(exactCount.manifest.files).length, ACTION_COMPILER_LIMITS.moduleFiles - 1);
  assert.equal(call("action.moduleSet.project", { source: exactCount }).result.module_sets.length, 1);
  exactCount.files["assets/overflow.txt"] = "x";
  exactCount.manifest.files["assets/overflow.txt"] = hash("x");
  delete exactCount.manifest.package_hash;
  exactCount.manifest.package_hash = originalDigest(exactCount.manifest);
  assert.throws(() => call("action.moduleSet.project", { source: exactCount }), /file\/action inventory/);

  const baseFile = fixtureSource().files[`definitions/${original.example.action_id}.json`];
  const firstLength = ACTION_COMPILER_LIMITS.moduleFileBytes;
  const secondLength = ACTION_COMPILER_LIMITS.moduleBytes - Buffer.byteLength(baseFile) - firstLength;
  const exactBytes = moduleSetWithFiles({
    "assets/a.bin": "a".repeat(firstLength),
    "assets/b.bin": "b".repeat(secondLength),
  });
  assert.equal(
    Object.values(exactBytes.files).reduce((total, text) => total + Buffer.byteLength(text), 0),
    ACTION_COMPILER_LIMITS.moduleBytes,
  );
  assert.equal(call("action.moduleSet.project", { source: exactBytes }).result.module_sets.length, 1);
  const overBytes = moduleSetWithFiles({
    "assets/a.bin": "a".repeat(firstLength),
    "assets/b.bin": "b".repeat(secondLength + 1),
  });
  assert.throws(() => call("action.moduleSet.project", { source: overBytes }), /ModuleSet exceeds 32 MiB/);
  assert.throws(() => call("action.moduleSet.project", {
    source: moduleSetWithFiles({ "assets/too-large.bin": "z".repeat(ACTION_COMPILER_LIMITS.moduleFileBytes + 1) }),
  }), /file exceeds/);
});

test("capture includes source validators and the original regression methods", () => {
  assert.match(originalActionCompilerSource.action_authoring.definition_schema, /def definition_schema/);
  assert.match(originalActionCompilerSource.action_modules.graph_definition, /def graph_definition/);
  assert.match(originalActionCompilerRegression["test-action-authoring.py"].test_schema_and_nonmutating_preflight, /persisted/);
  assert.match(originalActionCompilerRegression["test-action-modules.py"].test_numbered_math_ports_in_executable_graph, /graph_save/);
});

test("Action compiler capture hashes are repeatably current", async () => {
  const provenance = JSON.parse(await readFile(new URL("../migration/action-compiler-provenance.json", import.meta.url), "utf8"));
  assert.deepEqual(await checkCaptureRecords(provenance.files), []);
});

test("Action and Workflow compiler modules import in either order", () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  for (const sequence of [
    ["workflow-compiler.js", "action-compiler.js"],
    ["action-compiler.js", "workflow-compiler.js"],
  ]) {
    const code = `await import("./dist/${sequence[0]}"); await import("./dist/${sequence[1]}"); console.log("ready")`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ready/);
  }
});
