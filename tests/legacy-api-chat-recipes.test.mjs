import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { prepare, capture, open, load } from "./legacy-api-chat-recipes-fixtures.mjs";

const skip = !process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION && "Requires actual pinned original VSIX extraction.";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate) {
  for (let index = 0; index < 300; index++) {
    const value = await read();
    if (predicate(value)) return value;
    await wait(20);
  }
  throw new Error("Actual Recipe runtime did not reach expected durable state.");
}
const request = (env, state, mode) => ({ namespace: env.binding.namespace, chatId: env.binding.chatId,
  operationId: randomUUID(), expectedDigest: state.digest, recipeId: env.evidence.recipeId, inputs: { mode } });
async function setup(t, options) {
  const prepared = prepare(), before = capture(prepared.originalRoot);
  let env;
  t.after(async () => {
    try { await env?.close(); assert.deepEqual(capture(prepared.originalRoot), before); }
    finally { fs.rmSync(prepared.base, { recursive: true, force: true }); }
  });
  env = await open(prepared, options);
  return env;
}

test("actual old Recipe API evidence stays inert; fresh native create executes fixed local IO and pure reads never re-execute", { skip, timeout: 60000 }, async t => {
  const env = await setup(t), state = await env.authority.state(env.binding);
  assert.equal(state.originalRuns.find(run => run.runId === env.evidence.unknownRunId).state, "unknown");
  assert.equal(state.originalRuns.find(run => run.runId === env.evidence.completedRunId).state, "completed");
  assert(state.originalRuns.every(run => run.replay === "never" && run.execution === "historical-only"));
  const input = request(env, state, "complete");
  const created = await env.authority.create(env.binding, input);
  const done = await until(() => env.authority.state(env.binding), value => value.runs.some(run => run.runId === created.runId && run.state === "succeeded"));
  assert.equal(done.runs[0].nodes[1].outputs.sha256, env.evidence.inputSha256);
  assert.equal(fs.readFileSync(env.effects, "utf8").trim().split("\n").length, 1);
  for (let index = 0; index < 4; index++) await env.authority.state(env.binding);
  await assert.rejects(env.authority.create(env.binding, input), /never automatically recreated/);
  assert.equal(fs.readFileSync(env.effects, "utf8").trim().split("\n").length, 1);
  assert.deepEqual(env.runtime.services.workflow.list("unrelated-actor"), []);
});

test("strict HTTP Recipe routes bind actual native execution to the exact projected source, actor and Chat", { skip, timeout: 60000 }, async t => {
  const require = createRequire(import.meta.url), prepared = prepare(), before = capture(prepared.originalRoot);
  let storage, runtime, authority, ui;
  t.after(async () => {
    try {
      await ui?.close(); authority?.close(); await runtime?.close(); await storage?.close();
      assert.deepEqual(capture(prepared.originalRoot), before);
    } finally { fs.rmSync(prepared.base, { recursive: true, force: true }); }
  });
  const fixture = require("../legacy/tests/next-trial-electron/api-chat-fixture.cjs");
  const descriptor = fixture.create({ extension: path.resolve("."), root: prepared.root });
  fs.mkdirSync(path.join(prepared.root, "notes"), { mode: 0o700 });
  fs.writeFileSync(path.join(prepared.root, "notes/Existing.md"), "---\ntitle: Existing\nrevision: 1\n---\nPrivate projected HTTP fixture.\n", { mode: 0o600 });
  // This current-format projection deliberately does not claim original ProjectStore same-root adoption.
  const projection = path.join(prepared.base, "explicit-http-projection");
  const { RecipeFilesystemStore } = require("../legacy/dist/workflows/recipe-filesystem-store.js");
  new RecipeFilesystemStore(path.join(projection, ".pkm/state")).put(prepared.evidence.recipe);
  fs.cpSync(path.join(projection, "recipes"), path.join(prepared.root, "recipes"), { recursive: true });
  const nonce = randomUUID();
  fs.writeFileSync(path.join(prepared.base, "in-place-fixture-token"), nonce, { mode: 0o600 });
  const options = require("../legacy/tests/next-trial-electron/in-place-options.cjs").options;
  const adoption = await load("legacy-root-adoption");
  const plan = await adoption.prepareLegacyRootAdoptionExperimental(prepared.root,
    options({ fixture: prepared.base, root: prepared.root, nonce }));
  storage = (await adoption.resumeLegacyRootAdoptionExperimental(prepared.root,
    options({ fixture: prepared.base, root: prepared.root, nonce, workspaceId: plan.workspaceId }))).storage;
  const { inspectLegacyApiChatArchive } = await load("legacy-api-chat-archive");
  const { canonicalJson, compileWorkflowDefinitionV1 } = await load("domain/project-recipes-workflow-contracts");
  const { LegacyApiChatRecipes } = await load("legacy-api-chat-recipes");
  const { createNativeRuntime } = await load("native-runtime");
  const { startLegacyApiChatUiHost } = await load("legacy-api-chat-ui-host");
  const archive = inspectLegacyApiChatArchive(prepared.root), identity = { namespace: fixture.namespace, chatId: descriptor.inline };
  const binding = { root: prepared.root, workspaceId: plan.workspaceId, actorId: prepared.actorId,
    sourceFingerprint: archive.sourceFingerprint, ...identity };
  let held;
  const trusted = require("../legacy/tests/next-trial-electron/trusted-local-recipe-adapter.cjs").create({
    fixture: prepared.fixture, nonce: prepared.nonce, actorId: prepared.actorId, recipeId: prepared.evidence.recipeId,
    executableDigest: prepared.evidence.recipeExecutableDigest, definition: compileWorkflowDefinitionV1(prepared.evidence.definition).model,
    inputSha256: prepared.evidence.inputSha256, canonicalJson, onHeld: value => { held = value; },
  });
  authority = new LegacyApiChatRecipes({ ...binding, assertLease: () => storage.assertWorkspaceLease(),
    authorize: async candidate => JSON.stringify(candidate) === JSON.stringify(binding), adapters: trusted.adapters });
  runtime = await createNativeRuntime({ storage, workspaceId: plan.workspaceId,
    workflow: { adapters: authority.adapters, leaseMs: 30000 } });
  authority.bindRuntime(runtime.core, runtime.services.workflow);
  ui = await startLegacyApiChatUiHost({ storage, actorId: prepared.actorId, chats: [identity],
    authorize: async () => true, recipes: authority, provider: async () => { throw new Error("No model/network provider in Recipe route test."); } });
  const rpc = (input, actor = prepared.actorId) => fetch(`${ui.endpoint}/rpc`, { method: "POST",
    headers: { authorization: `Bearer ${ui.bearer}`, "x-pkm-native-actor": actor, "content-type": "application/json" },
    body: JSON.stringify(input) });
  assert.equal((await rpc({ method: "recipe-state", ...identity }, randomUUID())).status, 403);
  assert.notEqual((await rpc({ method: "recipe-state", ...identity, root: prepared.root })).status, 200);
  assert.notEqual((await rpc({ method: "recipe-state", ...identity, chatId: randomUUID() })).status, 200);
  const read = async () => {
    const response = await rpc({ method: "recipe-state", ...identity });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).value;
  };
  let state = await read();
  const create = mode => ({ ...identity, operationId: randomUUID(), expectedDigest: state.digest,
    recipeId: prepared.evidence.recipeId, inputs: { mode } });
  const input = create("complete");
  assert.notEqual((await rpc({ method: "recipe-create", input: { ...input, command: "untrusted" } })).status, 200);
  let response = await rpc({ method: "recipe-create", input });
  assert.equal(response.status, 200, await response.clone().text());
  state = await until(read, value => value.runs.some(run => run.state === "succeeded"));
  assert.equal(state.runs[0].nodes[1].outputs.sha256, prepared.evidence.inputSha256);
  assert.notEqual((await rpc({ method: "recipe-create", input })).status, 200);
  response = await rpc({ method: "recipe-create", input: create("cancel") });
  assert.equal(response.status, 200, await response.clone().text());
  const runId = (await response.json()).value.runId;
  await until(() => held, Boolean);
  state = await read();
  const run = state.runs.find(run => run.runId === runId);
  const cancel = { ...identity, operationId: randomUUID(), expectedDigest: state.digest, runId, expectedVersion: run.version };
  assert.notEqual((await rpc({ method: "recipe-cancel", input: { ...cancel, expectedVersion: run.version - 1 } })).status, 200);
  response = await rpc({ method: "recipe-cancel", input: cancel });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).value.state, "cancelled");
  assert.equal(fs.readFileSync(trusted.effects, "utf8").trim().split("\n").length, 1);
});

test("cancel fences actual held execution, rejects stale CAS and never claims rollback or runs a successor", { skip, timeout: 60000 }, async t => {
  let held, env, changeSource = false;
  env = await setup(t, { onHeld: value => { held = value; }, authorize: async (_binding, operation) => {
    if (operation === "cancel" && changeSource) {
      const directory = path.join(env.root, "recipes/Synthetic");
      fs.appendFileSync(path.join(directory, fs.readdirSync(directory).find(name => name.endsWith(".json"))), "\n");
    }
    return true;
  } });
  const input = request(env, await env.authority.state(env.binding), "cancel");
  const created = await env.authority.create(env.binding, input);
  await until(() => held, Boolean);
  let state = await env.authority.state(env.binding), run = state.runs.find(run => run.runId === created.runId);
  const cancel = { namespace: env.binding.namespace, chatId: env.binding.chatId, expectedDigest: state.digest,
    operationId: randomUUID(), runId: run.runId, expectedVersion: run.version - 1 };
  await assert.rejects(env.authority.cancel(env.binding, cancel), /CONFLICT/);
  state = await env.authority.state(env.binding); run = state.runs.find(run => run.runId === created.runId);
  changeSource = true;
  await assert.rejects(env.authority.cancel(env.binding, { ...cancel, expectedDigest: state.digest,
    operationId: randomUUID(), expectedVersion: run.version }), /changed during approval/);
  changeSource = false;
  state = await env.authority.state(env.binding); run = state.runs.find(run => run.runId === created.runId);
  assert.equal(run.state, "running");
  const result = await env.authority.cancel(env.binding, { ...cancel, operationId: randomUUID(),
    expectedDigest: state.digest, expectedVersion: run.version });
  assert.equal(result.state, "cancelled");
  assert.equal(result.nodes.find(node => node.nodeId === "record").effect, "unknown");
  assert.equal(fs.existsSync(env.effects), false);
  await wait(50);
  assert.equal((await env.authority.state(env.binding)).runs[0].state, "cancelled");
});

test("definition/input/scope changes and rejected fresh human approval cannot dispatch trusted effects", { skip, timeout: 60000 }, async t => {
  let decision = true;
  let env, changeSource = false;
  env = await setup(t, { authorize: async (_binding, operation) => {
    if (operation === "create" && changeSource) {
      const directory = path.join(env.root, "recipes/Synthetic");
      const file = fs.readdirSync(directory).find(name => name.endsWith(".json"));
      fs.appendFileSync(path.join(directory, file), "\n");
    }
    return operation === "read" || decision;
  } });
  const state = await env.authority.state(env.binding);
  await assert.rejects(env.authority.create(env.binding, { ...request(env, state, "complete"), chatId: randomUUID() }), /scope/);
  await assert.rejects(env.authority.create(env.binding, request(env, state, "shell")), /FORBIDDEN/);
  decision = false;
  await assert.rejects(env.authority.create(env.binding, request(env, state, "complete")), /fresh exact/);
  decision = true; changeSource = true;
  await assert.rejects(env.authority.create(env.binding, request(env, state, "complete")), /changed during approval/);
  await assert.rejects(env.authority.state({ ...env.binding, actorId: randomUUID() }), /fresh exact/);
  assert.deepEqual((await env.authority.state(env.binding)).runs, []);
  assert.equal(fs.existsSync(env.effects), false);
});

test("real SIGKILL after fsync effect preserves native UNKNOWN and original history; restarts and reads never replay", { skip, timeout: 60000 }, async t => {
  const prepared = prepare(), before = capture(prepared.originalRoot), config = path.join(prepared.base, "crash-config.json");
  fs.writeFileSync(config, JSON.stringify(prepared), { mode: 0o600 });
  let child, env;
  t.after(async () => {
    try {
      if (child?.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
      await env?.close();
      assert.deepEqual(capture(prepared.originalRoot), before);
    } finally { fs.rmSync(prepared.base, { recursive: true, force: true }); }
  });
  child = fork(new URL("./legacy-api-chat-recipes-crash-worker.mjs", import.meta.url), [config], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const held = await new Promise((resolve, reject) => {
    child.on("message", value => { if (value.type === "actual-effect-held") resolve(value); });
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`Crash worker exited before effect ${code}/${signal}`)));
  });
  const effects = path.join(prepared.fixture, "native-recipe-effects.jsonl"), bytes = fs.readFileSync(effects, "utf8");
  assert.equal(bytes.trim().split("\n").length, 1);
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  const closed = new DatabaseSync(path.join(prepared.root, "core.sqlite"), { readOnly: true });
  try {
    const records = closed.prepare("SELECT record FROM workflow_executor_assignments WHERE run_id=?").all(held.runId)
      .map(row => JSON.parse(row.record));
    assert(records.some(record => record.scheduler.lease?.expiresAt > Date.now()),
      "Restart must fence the dead host before its persisted lease expires.");
  } finally { closed.close(); }
  env = await open(prepared);
  let state = await env.authority.state(env.binding);
  assert.equal(state.runs.find(run => run.runId === held.runId).state, "unknown");
  assert.equal(state.runs[0].nodes.find(node => node.nodeId === "record").effect, "unknown");
  for (let index = 0; index < 4; index++) await env.authority.state(env.binding);
  const hex = held.runId.slice("recipe_native_".length);
  await assert.rejects(env.authority.create(env.binding, { ...request(env, state, "crash"),
    operationId: [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-") }),
  /never automatically recreated/);
  assert.equal(fs.readFileSync(effects, "utf8"), bytes);
  const bypass = await env.runtime.core.dispatch("capability_call", { operation: "workflow.executor.create", version: 1,
    arguments: { operationId: randomUUID(), runId: "unapproved-restart-run",
      source: { kind: "inline", definition: prepared.evidence.definition },
      expectedExecutableDigest: prepared.evidence.recipeExecutableDigest, deadline: Date.now() + 10000, inputs: { mode: "complete" } } },
  { id: prepared.actorId, canWrite: true });
  assert.equal(bypass.error.code, "FORBIDDEN", "Restart cannot inherit prior adapter grants.");
  await env.close(); env = await open(prepared);
  state = await env.authority.state(env.binding);
  assert.equal(state.runs[0].state, "unknown");
  assert.equal(env.runtime.services.workflow.events(prepared.actorId, held.runId)
    .filter(event => event.kind === "host-interrupted-without-replay").length, 1);
  assert.equal(fs.readFileSync(effects, "utf8"), bytes);
});
