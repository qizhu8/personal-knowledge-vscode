import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readWorkflowCompiler, WORKFLOW_COMPILER_LIMITS as L } from "../dist/workflow-compiler.js";
import { workflowCompilerDefinitions } from "../dist/workflow-compiler-contracts.js";
import { compileWorkflowDefinitionV1, canonicalJson } from "../dist/domain/project-recipes-workflow-contracts.js";
import { checkCaptureRecords } from "../scripts/migration.mjs";
import { decodeMarkdown } from "../dist/markdown.js";
import { workflowCompilerTransportFixtures } from "./workflow-compiler-fixtures.mjs";

const root = fileURLToPath(new URL(".workflow-compiler-fixture", import.meta.url));
const nextRoot = fileURLToPath(new URL("..", import.meta.url));
const node = (nodeId, dependsOn = []) => ({ nodeId, kind: "pkm.step.noop/v1", config: {}, dependsOn });
const definition = (nodes = [node("done")]) => ({
  schema: "pkm.workflow.definition/v1",
  spec: { inputs: {}, nodes, outputs: {}, completion: { requiredNodes: [nodes.at(-1)?.nodeId ?? "done"] } },
});
const inline = (value, operation = "workflow.definition.compile") =>
  readWorkflowCompiler(root, { operation, args: { source: { kind: "inline", definition: value } } });
const fail = (action, code) => assert.throws(action, error => error.code === code);
const digest = value => createHash("sha256").update(value).digest("hex");

test("schema-only imports are safe in both orders, with no vscode runtime", () => {
  for (const order of [
    ["workflow-compiler-contracts", "contracts", "workflow-compiler"],
    ["workflow-compiler", "contracts", "workflow-compiler-contracts"],
    ["contracts", "workflow-compiler-contracts", "workflow-compiler"],
  ]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e",
      `for (const name of ${JSON.stringify(order)}) await import("./dist/"+name+".js");`],
    { cwd: nextRoot, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(workflowCompilerDefinitions.map(item => [item.id, item.readOnly]), [
    ["workflow.compiler.capabilities", true], ["workflow.definition.validate", true],
    ["workflow.definition.compile", true],
  ]);
});

test("complete minimal JSON fixtures and original digest/normalization parity", () => {
  for (const { operation, args, result } of workflowCompilerTransportFixtures) {
    assert.deepEqual(readWorkflowCompiler(root, { operation, args }), result);
  }
  const value = definition();
  const result = inline(value);
  const original = compileWorkflowDefinitionV1(value);
  assert.equal(original.ok, true);
  assert.deepEqual(result, {
    status: "valid", source: { kind: "inline" }, diagnostics: [], executableDigest: original.executableDigest,
    bindings: { status: "none", nodes: 0, knowledge: 0 }, runtimeStatus: "not-runnable-here",
    availability: [{
      kind: "pkm.step.noop/v1", runtimeAvailable: false, reason: "execution-not-migrated",
      adapterClass: "none", requiredCapabilities: [], builtInOnly: false,
    }],
    definition: original.model, canonicalJson: original.canonicalBytes.toString("utf8"),
    plan: {
      schema: "pkm.workflow.plan/v1", execution: "unavailable",
      nodes: [{ nodeId: "done", kind: "pkm.step.noop/v1" }], edges: [],
      order: ["done"], layers: [["done"]], depth: 1, requiredNodes: ["done"], traversalStrategy: "breadth-first",
      sourceMap: [{ nodeId: "done", sourcePointer: "/spec/nodes/0", canonicalPointer: "/spec/nodes/0", dependencies: [] }],
    },
  });
  const invalid = inline(null);
  assert.deepEqual(invalid, {
    status: "invalid", source: { kind: "inline" }, diagnostics: [{
      phase: "P3", code: "E3003", severity: "error", pointer: "", details: { expected: "object" },
      messageTemplateId: "workflow.schema.type", remediationClass: "author",
    }],
  });
  assert.equal("plan" in invalid, false);
  const validation = inline(value, "workflow.definition.validate");
  assert.equal(validation.status, "valid");
  assert.equal("plan" in validation, false);
  const repeated = definition([node("z"), node("a", [{ from: "z" }])]);
  assert.equal(inline(repeated).executableDigest, inline({
    ...repeated, spec: { ...repeated.spec, nodes: [...repeated.spec.nodes].reverse() },
  }).executableDigest);
});

test("graph, original source positions, dependencies, traversal and terminating loops", () => {
  const value = definition([node("z"), node("b", [{ from: "z" }, { from: "a" }]), node("a")]);
  value.spec.completion.requiredNodes = ["b"];
  const result = inline(value);
  assert.deepEqual(result.plan.order, ["a", "z", "b"]);
  assert.deepEqual(result.plan.layers, [["a", "z"], ["b"]]);
  assert.deepEqual(result.plan.sourceMap[1], {
    nodeId: "b", sourcePointer: "/spec/nodes/1", canonicalPointer: "/spec/nodes/1",
    dependencies: [
      { sourcePointer: "/spec/nodes/1/dependsOn/1", canonicalPointer: "/spec/nodes/1/dependsOn/0" },
      { sourcePointer: "/spec/nodes/1/dependsOn/0", canonicalPointer: "/spec/nodes/1/dependsOn/1" },
    ],
  });
  value.spec.traversalStrategy = "depth-first";
  assert.deepEqual(inline(value).plan.order, ["a", "z", "b"]);
  const loop = definition([
    node("check", [{ from: "work" }]),
    node("work", [{ from: "check", loop: { termination: { condition: " done ", maxIterations: 3 } } }]),
  ]);
  const compiledLoop = inline(loop);
  assert.equal(compiledLoop.status, "valid");
  assert.deepEqual(compiledLoop.plan.order, ["work", "check"]);
  assert.equal(compiledLoop.plan.edges.find(edge => edge.loop).loop.termination.condition, "done");
});

test("preserves original unknown kind/dependency/port/cycle diagnostics, no fallback", () => {
  for (const value of [
    definition([{ ...node("done"), kind: "unknown.kind/v1" }]),
    definition([node("done", [{ from: "missing" }])]),
    definition([node("done", [{ from: "done" }])]),
    definition([{ ...node("done"), ports: { inputs: 42, outputs: [] } }]),
    { schema: "wrong", spec: {} },
  ]) {
    const original = compileWorkflowDefinitionV1(value);
    assert.equal(original.ok, false);
    const result = inline(value);
    assert.equal(result.status, "invalid");
    assert.deepEqual(result.diagnostics, original.diagnostics);
    assert.deepEqual(Object.keys(result).sort(), ["diagnostics", "source", "status"]);
  }
  const cycle = inline(definition([node("b", [{ from: "a" }]), node("a", [{ from: "b" }])]));
  assert.deepEqual(cycle.diagnostics.find(item => item.code === "E3203").details.witness, ["a", "b", "a"]);
});

test("native/command/script/subflow capabilities explicitly cannot execute or publish", () => {
  const capabilities = readWorkflowCompiler(root, { operation: "workflow.compiler.capabilities", args: {} });
  assert.deepEqual(capabilities.limits, L);
  assert(capabilities.kinds.every(item => !item.runtimeAvailable));
  assert.equal(capabilities.kinds.find(item => item.kind === "pkm.step.native/v1").builtInOnly, true);
  const native = definition([{ ...node("done"), kind: "pkm.step.native/v1", config: { operation: "example", arguments: {} } }]);
  const result = inline(native);
  assert.equal(result.status, "valid");
  assert.deepEqual(result.availability, [{
    kind: "pkm.step.native/v1", runtimeAvailable: false, reason: "execution-not-migrated",
    adapterClass: "native", requiredCapabilities: ["pkm.capability.native"], builtInOnly: true,
  }]);
  for (const operation of ["run.create", "recipe_run_start", "workflow.definition.publish"]) {
    fail(() => readWorkflowCompiler(root, { operation, args: {} }), "NOT_FOUND");
  }
  for (const source of [
    { kind: "file", path: "/etc/passwd" }, { kind: "inline", definition: definition(), path: "secret" },
    { kind: "recipe", recipeId: "../outside", expectedRevision: 1, expectedExecutableDigest: "a".repeat(64) },
    { kind: "recipe", recipeId: "recipe", expectedRevision: 1 },
  ]) fail(() => readWorkflowCompiler(root, { operation: "workflow.definition.compile", args: { source } }), "INVALID_ARGUMENT");
});

test("exact node, edge and DAG depth boundaries", () => {
  const wide = count => definition(Array.from({ length: count }, (_, index) => node(`n${index}`)));
  assert.equal(inline(wide(L.nodes)).plan.nodes.length, L.nodes);
  fail(() => inline(wide(L.nodes + 1)), "RESOURCE_LIMIT");
  const chain = count => definition(Array.from({ length: count }, (_, index) =>
    node(`n${index}`, index ? [{ from: `n${index - 1}` }] : [])));
  assert.equal(inline(chain(L.dagDepth)).plan.depth, L.dagDepth);
  fail(() => inline(chain(L.dagDepth + 1)), "RESOURCE_LIMIT");
  const dense = count => {
    const nodes = Array.from({ length: 33 }, (_, index) => node(`n${index}`));
    let remaining = count;
    for (let target = 32; target >= 1; target--) for (let source = 0; source < target && remaining; source++, remaining--) {
      nodes[target].dependsOn.push({ from: `n${source}` });
    }
    return definition(nodes);
  };
  assert.equal(inline(dense(L.edges)).plan.edges.length, L.edges);
  fail(() => inline(dense(L.edges + 1)), "RESOURCE_LIMIT");
  const complexCycle = dense(L.edges - 1);
  complexCycle.spec.nodes[0].dependsOn = [{ from: "n32" }];
  fail(() => inline(complexCycle), "RESOURCE_LIMIT");
});

test("exact JSON input bytes/depth/value-count and output limit, rejects non-JSON", () => {
  const makeArgs = value => ({ source: { kind: "inline", definition: value } });
  const callArgs = args => readWorkflowCompiler(root, { operation: "workflow.definition.validate", args });
  const value = definition();
  value.spec.nodes[0].generalInstruction = "x";
  let args = makeArgs(value);
  value.spec.nodes[0].generalInstruction += "x".repeat(L.inputBytes - Buffer.byteLength(JSON.stringify(args)));
  assert.equal(Buffer.byteLength(JSON.stringify(args)), L.inputBytes);
  assert.equal(callArgs(args).status, "valid");
  value.spec.nodes[0].generalInstruction += "x";
  fail(() => callArgs(args), "RESOURCE_LIMIT");
  const nested = depth => {
    let value = null;
    for (let index = 0; index < depth; index++) value = { x: value };
    return value;
  };
  assert.equal(inline(nested(L.jsonDepth - 2)).status, "invalid");
  fail(() => inline(nested(L.jsonDepth - 1)), "RESOURCE_LIMIT");
  // Root, source object, kind string, definition array and its elements.
  assert.equal(inline(Array(L.jsonValues - 4).fill(null)).status, "invalid");
  fail(() => inline(Array(L.jsonValues - 3).fill(null)), "RESOURCE_LIMIT");
  const explosiveDiagnostics = Object.fromEntries(Array.from({ length: 6000 }, (_, index) => [`unknown${index}`, null]));
  fail(() => inline(explosiveDiagnostics), "RESOURCE_LIMIT");
  const exactOutput = Object.fromEntries(Array.from({ length: 4000 }, (_, index) => [`unknown${index}`, null]));
  let paddingKey = "padding";
  exactOutput[paddingKey] = null;
  const outputBytes = value => Buffer.byteLength(JSON.stringify({
    status: "invalid", source: { kind: "inline" }, diagnostics: compileWorkflowDefinitionV1(value).diagnostics,
  }));
  if ((L.outputBytes - outputBytes(exactOutput)) % 2) {
    delete exactOutput[paddingKey];
    paddingKey += "~";
    exactOutput[paddingKey] = null;
  }
  const padding = (L.outputBytes - outputBytes(exactOutput)) / 2;
  delete exactOutput[paddingKey];
  paddingKey += "x".repeat(padding);
  exactOutput[paddingKey] = null;
  assert.equal(outputBytes(exactOutput), L.outputBytes);
  assert.equal(Buffer.byteLength(JSON.stringify(inline(exactOutput))), L.outputBytes);
  delete exactOutput[paddingKey];
  exactOutput[`${paddingKey}x`] = null;
  fail(() => inline(exactOutput), "RESOURCE_LIMIT");
  for (const value of [undefined, NaN, Infinity, new Date(), () => {}, { get spec() { throw Error("getter executed"); } }]) {
    fail(() => inline(value), "INVALID_ARGUMENT");
  }
  const cyclic = {}; cyclic.self = cyclic;
  fail(() => inline(cyclic), "INVALID_ARGUMENT");
});

test("pinned isolated Recipe lookup, bindings, mismatch, missing, oversized and symlinks", async () => {
  await rm(root, { recursive: true, force: true });
  try {
    assert.equal(inline(definition()).status, "valid");
    assert.equal(existsSync(root), false, "inline compilation must not initialize a root");
    const compiled = compileWorkflowDefinitionV1(definition());
    const recipe = {
      schema: "pkm.knowledge/v1", knowledgeId: `knowledge_${digest("recipe_test").slice(0, 24)}`,
      aliases: ["recipe:recipe_test"],
      recipeId: "recipe_test", scope: "global", name: "Test", description: "", revision: 3,
      definition: definition(), executableDigest: compiled.executableDigest, category: "",
    };
    await mkdir(join(root, "recipes", "Uncategorized"), { recursive: true });
    const path = join(root, "recipes", "Uncategorized", "Test.recipe_test.json");
    await writeFile(path, JSON.stringify(recipe));
    const source = { kind: "recipe", recipeId: recipe.recipeId, expectedRevision: 3, expectedExecutableDigest: recipe.executableDigest };
    const read = (pin = source, documents = []) => readWorkflowCompiler(root, {
      operation: "workflow.definition.compile", args: { source: pin },
    }, documents);
    const result = read();
    assert.equal(result.status, "valid");
    assert.equal(result.source.revision, 3);
    assert.match(result.source.snapshotRevision, /^[a-f0-9]{64}$/);
    assert.equal(read({ ...source, snapshotRevision: result.source.snapshotRevision }).status, "valid");
    fail(() => read({ ...source, expectedRevision: 4 }), "CONFLICT");
    fail(() => read({ ...source, expectedExecutableDigest: "a".repeat(64) }), "CONFLICT");
    fail(() => read({ ...source, snapshotRevision: "a".repeat(64) }), "CONFLICT");
    fail(() => read({ ...source, recipeId: "missing" }), "NOT_FOUND");
    const raw = "---\nname: Verify\ndescription: \"\"\ntags: []\n---\nRun tests.\n";
    await mkdir(join(root, "skills", "Coding"), { recursive: true });
    await writeFile(join(root, "skills", "Coding", "Verify.md"), raw);
    const document = decodeMarkdown("skill_verify", raw, "Coding/Verify.md", "skills");
    recipe.nodeBindings = [{ nodeId: "done", bindings: [{
      bindingId: "binding", kind: "skill", knowledgeId: "Coding/Verify", usage: "required",
      contentHash: digest(canonicalJson({ name: "Verify", description: "", category: "Coding", tags: [], content: "Run tests.\n" })),
    }] }];
    await writeFile(path, JSON.stringify(recipe));
    assert.deepEqual(read(source, [document]).bindings, { status: "verified", nodes: 1, knowledge: 1 });
    fail(() => read(), "NOT_FOUND");
    recipe.nodeBindings[0].bindings[0].contentHash = "a".repeat(64);
    await writeFile(path, JSON.stringify(recipe));
    fail(() => read(source, [document]), "CONFLICT");
    recipe.nodeBindings[0].nodeId = "missing";
    await writeFile(path, JSON.stringify(recipe));
    fail(() => read(source, [document]), "INVALID_DOCUMENT");
    delete recipe.nodeBindings;
    recipe.definition = definition(Array.from({ length: L.nodes + 1 }, (_, index) => node(`n${index}`)));
    await writeFile(path, JSON.stringify(recipe));
    fail(() => read(), "RESOURCE_LIMIT");
    await writeFile(path, " ".repeat(L.inputBytes + 1));
    fail(() => read(), "RESOURCE_LIMIT");
    await rm(path);
    await symlink(join(root, "skills", "Coding", "Verify.md"), path);
    fail(() => read(), "INVALID_DOCUMENT");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("repeatable captured originals pass actual migration hash checker", async () => {
  const metadataPath = join(nextRoot, "migration", "workflow-compiler-provenance.json");
  const before = await readFile(metadataPath, "utf8");
  const result = spawnSync(process.execPath, ["scripts/capture-workflow-compiler.mjs", "--check"], { cwd: nextRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(metadataPath, "utf8"), before);
  const metadata = JSON.parse(before);
  assert(metadata.files.length >= 10);
  assert.deepEqual(await checkCaptureRecords(metadata.files, undefined, undefined, {
    dataset: "runtime-workflow-compiler-historical",
  }), []);
  const changed = structuredClone(metadata.files);
  changed[0].capturedSha256 = "0".repeat(64);
  assert.equal((await checkCaptureRecords(changed, undefined, undefined, {
    dataset: "runtime-workflow-compiler-historical",
  }))[0].kind, "captured");
});
