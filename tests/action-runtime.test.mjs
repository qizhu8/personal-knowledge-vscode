import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { originalActionCompilerFixtures as original } from "./action-compiler-original-fixtures.mjs";
import { checkCaptureRecords } from "../scripts/migration.mjs";

const build = resolve(process.env.PKM_ACTION_BUILD ?? resolve(import.meta.dirname, "../dist"));
const load = path => import(pathToFileURL(resolve(build, path)).href);
const [{ actionRuntimeDefinitions, ActionRuntime }, { createActionProcessBridge }, { readActionCompiler },
  { originalDigest, actionComponents }, { ACTION_RUNTIME_ORIGINAL_PROVENANCE }] = await Promise.all([
  load("action-runtime.js"), load("action-runtime-process.js"), load("action-compiler.js"),
  load("domain/action-compiler-validation.js"), load("domain/action-runtime-original.js"),
]);

const hash = text => createHash("sha256").update(text).digest("hex");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const nextServerRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
async function until(predicate) {
  for (let index = 0; index < 400; index++) { if (predicate()) return; await delay(5); }
  throw new Error("Timed out waiting for Action runtime fixture.");
}
function definitionFor(code) {
  const definition = structuredClone(original.example);
  definition.implementations[0].program = "fixture";
  definition.implementations[0].args = ["-e", code];
  return definition;
}
function setup(t, code, effects) {
  const root = resolve("tests", `.action-runtime-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const database = new DatabaseSync(resolve(root, "store.sqlite"));
  const definition = definitionFor(code);
  if (effects) definition.effects = effects;
  const source = { kind: "inline", definition };
  const compiled = readActionCompiler({ operation: "action.definition.compile", args: { source } });
  assert.equal(compiled.status, "valid");
  const approvals = [];
  const bridge = createActionProcessBridge({
    database, workspaceRoot: root,
    commands: [{
      id: "fixture", executable: process.execPath, cwd: root, directChildOnly: true,
      arguments: [{ literal: "-e" }, { literal: code }],
      outputContractDigest: originalDigest(definition.output_schema), authorizationDigest: hash("fixture authorization"),
      authorizeDefinition: binding => binding.actorId === "alice" && binding.actionId === definition.action_id,
      authorizeData: ({ inputs }) => !JSON.stringify(inputs).includes("sensitive-example"),
      approve: async approval => { approvals.push(approval); return true; },
      redactOutput: output => ({ value: output.value }),
    }],
    limits: { graceMs: 20, closeDrainMs: 200 },
  });
  const runtime = new ActionRuntime(database, { workspaceRoot: root, adapters: bridge.adapters });
  t.after(async () => {
    await runtime.close({ drainMs: 100 });
    await bridge.close({ drainMs: 100 });
    database.close();
    rmSync(root, { recursive: true, force: true });
  });
  const create = (inputs = { value: "hello" }, sourceOverride = source) => runtime.create("alice", {
    operationId: randomUUID(), runId: `run-${randomUUID()}`, source: sourceOverride,
    expectedDefinitionDigest: compiled.definitionDigest, deadline: Date.now() + 5000, inputs,
  });
  return { root, database, runtime, bridge, approvals, definition, source, compiled, create };
}

test("Action compiler source executes through native direct-child bridge with durable public events", async t => {
  const code = "let s='';for await(const c of process.stdin)s+=c;const v=JSON.parse(s);console.log(JSON.stringify({value:v.value}))";
  const f = setup(t, code);
  const forgedSource = structuredClone(f.source);
  forgedSource.definition.implementations[0].args[1] = "process.exit(0)";
  const forgedCompile = readActionCompiler({ operation: "action.definition.compile", args: { source: forgedSource } });
  assert.equal(forgedCompile.status, "valid");
  assert.throws(() => f.runtime.create("alice", {
    operationId: randomUUID(), runId: `forged-${randomUUID()}`, source: forgedSource,
    expectedDefinitionDigest: forgedCompile.definitionDigest, deadline: Date.now() + 5000, inputs: { value: "hello" },
  }), /denied/);
  assert.equal(f.database.prepare("SELECT count(*) n FROM action_runtime_runs").get().n, 0);
  const createArgs = {
    operationId: randomUUID(), runId: `run-${randomUUID()}`, source: f.source,
    expectedDefinitionDigest: f.compiled.definitionDigest, deadline: Date.now() + 5000, inputs: { value: "hello" },
  };
  const created = f.runtime.create("alice", createArgs);
  assert.deepEqual(f.runtime.create("alice", createArgs), created);
  assert.equal(created.state, "ready");
  const result = await f.runtime.tick("alice", created.runId);
  assert.equal(result.state, "succeeded");
  assert.deepEqual(result.nodes, [{ nodeId: "action", state: "succeeded" }]);
  assert.equal(Object.hasOwn(result.nodes[0], "outputs"), false);
  assert.equal(f.approvals.length, 1);
  assert.equal(f.approvals[0].executableDigest, f.compiled.definitionDigest);
  assert.equal(f.approvals[0].actionId, f.definition.action_id);
  assert.equal(f.database.prepare("SELECT count(*) n FROM runtime_process_jobs WHERE state='SUCCEEDED'").get().n, 1);
  const processRecord = JSON.parse(f.database.prepare("SELECT record_json FROM runtime_process_jobs").get().record_json);
  assert.equal(processRecord.stdout, "");
  const events = f.runtime.events("alice", { runId: created.runId, after: 0, limit: 100 });
  assert.deepEqual(events.items.map(item => item.kind), ["created", "run-started", "node-started", "node-succeeded", "run-succeeded"]);
  assert.equal(JSON.stringify(events).includes("hello"), false);
});

test("Action component provenance checks source and capture from their declared roots", async () => {
  const issues = await checkCaptureRecords(
    ACTION_RUNTIME_ORIGINAL_PROVENANCE.records,
    resolve(nextServerRoot, ACTION_RUNTIME_ORIGINAL_PROVENANCE.sourceRoot),
    resolve(nextServerRoot, ACTION_RUNTIME_ORIGINAL_PROVENANCE.capturedRoot),
  );
  assert.deepEqual(issues, []);
});

test("strict result validation, failure, and sensitive-data policy fail closed", async t => {
  const badOutput = "console.log(JSON.stringify({value:42,extra:'no'}))";
  const bad = setup(t, badOutput);
  const run = bad.create();
  assert.equal((await bad.runtime.tick("alice", run.runId)).state, "unknown");
  assert.equal(bad.runtime.get("alice", run.runId).nodes[0].state, "unknown");

  const failing = setup(t, "process.exitCode=7");
  const failed = failing.create();
  assert.equal((await failing.runtime.tick("alice", failed.runId)).state, "failed");

  assert.throws(() => bad.create({ value: "sensitive-example" }), /denied/);
  assert.equal(bad.database.prepare("SELECT count(*) n FROM action_runtime_runs").get().n, 1);
});

test("cancellation fences a live child and preserves its unknown effect across restart", async t => {
  const code = "process.stdout.write('started');setInterval(()=>{},1000)";
  const f = setup(t, code);
  const created = f.create();
  const ticking = f.runtime.tick("alice", created.runId);
  await until(() => Number(f.database.prepare("SELECT count(*) n FROM runtime_process_jobs WHERE state='RUNNING'").get().n) === 1);
  const current = f.runtime.get("alice", created.runId);
  const cancelled = f.runtime.cancel("alice", {
    operationId: randomUUID(), runId: created.runId, expectedVersion: current.version,
  });
  assert.equal(cancelled.state, "cancelling");
  const result = await ticking;
  assert.equal(result.state, "unknown");
  assert.equal(result.nodes[0].state, "unknown");
  await until(() => Number(f.database.prepare("SELECT count(*) n FROM runtime_process_jobs WHERE state='RUNNING'").get().n) === 0);
  await f.runtime.close({ drainMs: 50 });
  const reopened = new ActionRuntime(f.database, { workspaceRoot: f.root, adapters: f.bridge.adapters });
  assert.equal(reopened.get("alice", created.runId).state, "unknown");
  const processJobs = f.database.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n;
  assert.equal((await reopened.tick("alice", created.runId)).state, "unknown");
  assert.equal(f.database.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n, processJobs);
  await reopened.close({ drainMs: 50 });
});

test("a real direct-child crash stays unknown across restart and event reads remain actor-owned", async t => {
  const f = setup(t, "process.kill(process.pid, 'SIGKILL')", ["remote-write"]);
  const created = f.create();
  const result = await f.runtime.tick("alice", created.runId);
  assert.equal(result.state, "unknown");
  assert.equal(result.nodes[0].state, "unknown");
  const page = f.runtime.events("alice", { runId: created.runId, after: 0, limit: 100 });
  assert.deepEqual(page.items.map(item => item.kind), [
    "created", "run-started", "node-started", "node-unknown", "run-unknown",
  ]);
  assert.equal(page.items.some(item => item.kind === "run-succeeded"), false);
  assert.throws(() => f.runtime.events("mallory", { runId: created.runId, after: 0, limit: 100 }),
    error => error.code === "NOT_FOUND");
  assert.equal(Number(f.database.prepare("SELECT count(*) n FROM runtime_process_jobs WHERE state='SUCCEEDED'").get().n), 0);

  await f.runtime.close({ drainMs: 50 });
  const reopened = new ActionRuntime(f.database, { workspaceRoot: f.root, adapters: f.bridge.adapters });
  assert.equal(reopened.get("alice", created.runId).state, "unknown");
  assert.deepEqual(reopened.events("alice", { runId: created.runId, after: 0, limit: 100 }), page);
  assert.equal((await reopened.tick("alice", created.runId)).state, "unknown");
  assert.equal(Number(f.database.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n), 1);
  await reopened.close({ drainMs: 50 });
});

test("a host crash during a real Action child recovers the durable run as unknown without replay", { timeout: 15000 }, async t => {
  const root = resolve("tests", `.action-runtime-host-crash-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  let host, hostExited = false;
  const waitForHostExit = () => new Promise(resolveExit => {
    if (hostExited) return resolveExit();
    host.once("exit", () => { hostExited = true; resolveExit(); });
  });
  const runId = `run-${randomUUID()}`;
  t.after(async () => {
    if (host && !hostExited) {
      const exited = waitForHostExit();
      host.kill("SIGKILL");
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const code = "setTimeout(()=>process.kill(process.pid,'SIGKILL'),1500)";
  const worker = resolve(import.meta.dirname, "action-runtime-crash-host.mjs");
  host = spawn(process.execPath, [worker, root, runId, code, JSON.stringify(definitionFor(code))], {
    cwd: root, env: { ...process.env, PKM_ACTION_BUILD: build }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  host.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  host.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`Action child did not start: ${stderr}`)), 5000);
    host.stdout.on("data", () => {
      if (!stdout.includes("ACTION_CHILD_RUNNING\n")) return;
      clearTimeout(timer);
      resolveReady();
    });
    host.once("exit", (codeValue, signal) => {
      hostExited = true;
      clearTimeout(timer);
      rejectReady(new Error(`Action host exited before child start (${codeValue}/${signal}): ${stderr}`));
    });
  });
  host.kill("SIGKILL");
  await waitForHostExit();
  await delay(1800);

  const database = new DatabaseSync(resolve(root, "store.sqlite"));
  const recovered = new ActionRuntime(database, { workspaceRoot: root, adapters: {} });
  assert.equal(recovered.get("alice", runId).state, "unknown");
  const page = recovered.events("alice", { runId, after: 0, limit: 100 });
  assert.deepEqual(page.items.map(item => item.kind), ["created", "run-started", "node-started", "run-unknown"]);
  assert.equal(page.items.some(item => item.kind === "run-succeeded"), false);
  assert.equal((await recovered.tick("alice", runId)).state, "unknown");
  assert.equal(Number(database.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n), 1);
  await recovered.close({ drainMs: 50 });
  database.close();
});

test("parallel Action branches execute concurrently and cyclic or oversized plans are rejected before writes", async t => {
  const root = resolve("tests", `.action-runtime-pipeline-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const database = new DatabaseSync(resolve(root, "store.sqlite"));
  const component = actionComponents()["core.constant"];
  const outputSchema = () => ({ type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false });
  const definition = {
    schema: "pkm.action.definition/v1", action_id: "fixture.parallel", version: 1,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    output_schema: outputSchema(), effects: ["pure"],
    implementations: [{
      kind: "pipeline", platforms: ["Linux", "Windows", "Darwin"],
      steps: [
        { id: "left", component: "core.constant", inputs: { value: 1 }, output_schema: outputSchema() },
        { id: "right", component: "core.constant", inputs: { value: 2 }, output_schema: outputSchema() },
      ],
      output: { value: { $step: "right.value" } },
    }],
  };
  const source = { kind: "inline", definition };
  const compiled = readActionCompiler({ operation: "action.definition.compile", args: { source } });
  assert.equal(compiled.status, "valid", JSON.stringify(compiled));
  const contractDigest = originalDigest(outputSchema());
  let active = 0, peak = 0;
  const componentAdapter = {
    id: "native-constant", version: 1, outputContractDigest: contractDigest,
    authorizationDigest: hash("constant authority"),
    authorizeDefinition: binding => binding.actorId === "alice" && binding.actionId === "core.constant",
    authorizeData: () => true,
    async execute(invocation) {
      active++; peak = Math.max(peak, active);
      await delay(30); active--;
      return { value: invocation.inputs.value };
    },
  };
  const runtime = new ActionRuntime(database, { workspaceRoot: root, adapters: { "component:core.constant": componentAdapter } });
  t.after(async () => { await runtime.close(); database.close(); rmSync(root, { recursive: true, force: true }); });
  const created = runtime.create("alice", {
    operationId: randomUUID(), runId: `parallel-${randomUUID()}`, source,
    expectedDefinitionDigest: compiled.definitionDigest, deadline: Date.now() + 5000, inputs: {},
  });
  const result = await runtime.tick("alice", created.runId);
  assert.equal(result.state, "succeeded");
  assert.equal(peak, 2);
  assert.equal(result.nodes.every(node => node.state === "succeeded"), true);
  assert.equal(JSON.stringify(result).includes('"outputs"'), false);

  const cycle = structuredClone(definition);
  cycle.implementations[0].steps[0].inputs.value = { $step: "right.value" };
  cycle.implementations[0].steps[1].inputs.value = { $step: "left.value" };
  const cycleSource = { kind: "inline", definition: cycle };
  const cycleCompile = readActionCompiler({ operation: "action.definition.compile", args: { source: cycleSource } });
  if (cycleCompile.status === "valid") {
    assert.throws(() => runtime.create("alice", {
      operationId: randomUUID(), runId: `cycle-${randomUUID()}`, source: cycleSource,
      expectedDefinitionDigest: cycleCompile.definitionDigest, deadline: Date.now() + 5000, inputs: {},
    }), /cycle/);
  }
  const oversized = structuredClone(definition);
  oversized.implementations[0].steps = Array.from({ length: 501 }, (_, index) => ({
    id: `step-${index}`, component: "core.constant", inputs: { value: index },
    output_schema: outputSchema(),
  }));
  const oversizedSource = { kind: "inline", definition: oversized };
  assert.equal(readActionCompiler({
    operation: "action.definition.compile", args: { source: oversizedSource },
  }).status, "invalid");
  assert.equal(database.prepare("SELECT count(*) n FROM action_runtime_runs").get().n, 1);
  assert.equal(component.action_id, "core.constant");
  assert.deepEqual(actionRuntimeDefinitions.map(item => item.id), [
    "action.runtime.create", "action.runtime.get", "action.runtime.events", "action.runtime.cancel",
  ]);
});
