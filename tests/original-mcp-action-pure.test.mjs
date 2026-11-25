import "./original-todo-role-source-loader.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import childProcess from "node:child_process";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { originalActionCompilerFixtures } from "./action-compiler-original-fixtures.mjs";
import { originalPureActionOracle } from "./original-mcp-action-pure-oracle.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Run through the existing private framework isolate.py.");
const { actionComponents, componentDigest } = await import("../src/domain/action-compiler-validation.ts");
const { invokeOriginalMcpPureAction } = await import("../src/original-mcp-action-pure.ts");

const request = (tool, args = {}) => ({ tool, arguments: args });
function node(id = "value", actionId = "core.constant", parameters = { value: "closed graph" }, extra = {}) {
  return { id, action_id: actionId, content_hash: componentDigest(actionComponents()[actionId]), parameters, ...extra };
}
const minimalGraph = () => ({ action_id: "example.closed.graph", nodes: [node()] });
const graphRequest = graph => request("action_graph_check", { graph });
const invoke = input => invokeOriginalMcpPureAction(input.tool, input.arguments);

function withoutAuthority(work) {
  const restore = [];
  let attempts = 0;
  for (const [object, names] of [
    [fs, ["readFile", "readFileSync", "writeFile", "writeFileSync", "open", "openSync", "stat", "statSync",
      "lstat", "lstatSync", "access", "accessSync", "existsSync", "readdir", "readdirSync", "realpathSync", "mkdirSync"]],
    [fsp, ["readFile", "writeFile", "open", "stat", "lstat", "access", "readdir", "realpath", "mkdir"]],
    [childProcess, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]],
    [net, ["connect", "createConnection", "createServer"]],
  ]) {
    for (const name of names) {
      const original = object[name];
      object[name] = () => { attempts++; throw new Error(`Pure Action attempted ${name}`); };
      restore.push(() => { object[name] = original; });
    }
  }
  syncBuiltinESMExports();
  try { return work(); }
  finally {
    for (const reset of restore.reverse()) reset();
    syncBuiltinESMExports();
    assert.equal(attempts, 0, "Pure dispatch must not even attempt file, process or network IO.");
  }
}

async function fixture(t) {
  const directory = resolve("tests", `.action-pure-${randomUUID()}`);
  await fsp.mkdir(directory, { mode: 0o700 });
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return cases => originalPureActionOracle(directory, cases);
}

test("closed Original templates return the complete catalogue without creating or executing a template", async t => {
  const oracle = await fixture(t), input = request("action_templates");
  const [expected] = oracle([input]);
  const actual = withoutAuthority(() => invoke(input));
  assert.deepEqual(actual, expected.result);
  actual.templates[0].inputs.seconds = 999;
  assert.deepEqual(withoutAuthority(() => invoke(input)), expected.result);
});

test("closed component graphs preserve Original minimal/default and typed graph results without resolving file parameters", async t => {
  const oracle = await fixture(t);
  const graphs = [
    minimalGraph(),
    { action_id: "example.typed.graph", name: "", nodes: [
      node("source", "core.constant", { value: "42" }, { value_type: "string" }),
      node("cast", "core.cast", { target_type: "integer" }, { value_type: "integer", implementation: "javascript" }),
    ], edges: [{ source: "source", output: "value", target: "cast", input: "value" }] },
    { action_id: "example.file.metadata", nodes: [
      node("path", "core.file-path", { path: "private-workspace/credentials.json", must_exist: true }),
    ] },
  ];
  const inputs = graphs.map(graphRequest), expected = oracle(inputs);
  for (let index = 0; index < inputs.length; index++) {
    assert.ok(expected[index].result, JSON.stringify(expected[index]));
    const graphBefore = structuredClone(inputs[index]);
    assert.deepEqual(withoutAuthority(() => invoke(inputs[index])), expected[index].result);
    assert.deepEqual(inputs[index], graphBefore, "Compilation must not mutate caller-owned graph inputs.");
  }
});

test("invalid graph pins, parameters, ports and cycles retain actual Original errors", async t => {
  const oracle = await fixture(t);
  const graphs = [
    { action_id: "example.empty.graph", nodes: [] },
    { action_id: "example.stale.graph", nodes: [{ ...node(), content_hash: "0".repeat(64) }] },
    { action_id: "example.extra.parameter", nodes: [node("value", "core.constant", { value: 1, unexpected: true })] },
    { action_id: "example.parameter.type", nodes: [node("sleep", "core.sleep", { seconds: 301 })] },
    { action_id: "example.required.parameter", nodes: [
      node("question", "core.user-action", { prompt: "Choose", options: [{}], test_choice: 0 }),
    ] },
    { action_id: "example.duplicate.graph", nodes: [node(), node()] },
    { action_id: "example.ports.graph", nodes: [
      node("source", "core.constant", { value: "x" }, { value_type: "string" }),
      node("target", "core.sleep", {}),
    ], edges: [{ source: "source", output: "value", target: "target", input: "seconds" }] },
    { action_id: "example.cycle.graph", nodes: [node("a"), node("b")], edges: [
      { source: "a", output: "value", target: "b", input: "value" },
      { source: "b", output: "value", target: "a", input: "value" },
    ] },
  ];
  const inputs = graphs.map(graphRequest), expected = oracle(inputs);
  for (let index = 0; index < inputs.length; index++) {
    assert.equal(expected[index].error?.type, "ValueError", JSON.stringify(expected[index]));
    assert.throws(() => withoutAuthority(() => invoke(inputs[index])), error =>
      error.code === "INVALID_ARGUMENT" && error.message === expected[index].error.message);
  }
});

test("definition schema errors are exact, while valid definitions stop at the real private registry boundary", async t => {
  const oracle = await fixture(t);
  const definitions = [{}, ...originalActionCompilerFixtures.diagnostics.map(item => item.definition)];
  const inputs = definitions.map(definition => request("action_definition_check", { definition }));
  const expected = oracle(inputs);
  for (let index = 0; index < inputs.length; index++)
    assert.deepEqual(withoutAuthority(() => invoke(inputs[index])), expected[index].result);
  const valid = request("action_definition_check", { definition: originalActionCompilerFixtures.example });
  const [boundary] = oracle([valid]);
  assert.match(boundary.boundary, /private workspace metadata/);
  assert.throws(() => withoutAuthority(() => invoke(valid)), error =>
    error.code === "NATIVE_AUTHORITY_REQUIRED" && /ACTION_FULL_RUNTIME_REQUIRED.*registry revision/.test(error.message));
});

test("Action references, capabilities and referrer/root injection cannot acquire private state or execution authority", async t => {
  const oracle = await fixture(t);
  const hidden = { id: "query", action_id: "private.query", inputs: { path: "private-workspace/credentials.json" } };
  const inputs = [
    graphRequest({ action_id: "example.private.graph", nodes: [{ ...node(), action_id: "private.query" }] }),
    graphRequest({ action_id: "example.builtin.graph", nodes: [{ ...node(), action_id: "core.delay" }] }),
    graphRequest({ action_id: "example.nested.graph", nodes: [
      node("loop", "core.for", { items: [], body: [hidden], value: null, max_iterations: 1 }),
    ] }),
    request("action_capabilities"),
    request("action_definition_check", { definition: { ...originalActionCompilerFixtures.example,
      input_schema: { $ref: "file:///private-workspace/credentials.json" } } }),
    request("action_definition_check", { definition: { ...originalActionCompilerFixtures.example,
      implementations: [{ kind: "program", platforms: ["Linux"], program: "" }] } }),
    graphRequest({ action_id: "example.poll.graph", nodes: [
      node("poll", "core.poll", { body: [], condition: true, value: null,
        interval_seconds: 0, timeout_seconds: 1, max_iterations: 1 }),
    ] }),
  ];
  for (const input of inputs)
    assert.throws(() => withoutAuthority(() => invoke(input)), error =>
      error.code === "NATIVE_AUTHORITY_REQUIRED" && error.message.startsWith("ACTION_FULL_RUNTIME_REQUIRED:"));
  const boundaries = oracle([inputs[0], inputs[2]]);
  assert(boundaries.every(value => /private workspace metadata/.test(value.boundary)), JSON.stringify(boundaries));
  for (const args of [{ root: "private-workspace" }, { referrer: "file:///private-workspace/credentials.json" },
    { sourceModules: [] }, { credentials: {} }])
    assert.throws(() => withoutAuthority(() => invokeOriginalMcpPureAction("action_templates", args)));
  let getterCalled = false;
  const untrusted = Object.defineProperty({}, "definition", { enumerable: true, get() { getterCalled = true; return {}; } });
  assert.throws(() => withoutAuthority(() => invokeOriginalMcpPureAction("action_definition_check", untrusted)),
    error => error.code === "INVALID_ARGUMENT" && /accessors/.test(error.message));
  assert.equal(getterCalled, false);
});
