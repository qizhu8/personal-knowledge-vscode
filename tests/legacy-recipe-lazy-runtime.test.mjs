import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { prepare, capture, open, load } from "./legacy-api-chat-recipes-fixtures.mjs";
const require = createRequire(import.meta.url);
const fixtureHelper = require("../legacy/tests/next-trial-electron/controlled-lazy-recipe-fixture.cjs");
const skip = !process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION && "Requires actual pinned original VSIX.";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(options = {}) {
  const prepared = prepare();
  const evidence = fixtureHelper.create({ fixture: prepared.fixture, root: prepared.originalRoot,
    extension: process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION, ...options });
  prepared.additionalRecipes = [evidence.recipe];
  return { prepared, evidence };
}
const effects = evidence => fs.existsSync(evidence.effects) ? fs.readFileSync(evidence.effects, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
async function settled(env) {
  for (let i = 0; i < 500; i++) {
    if (!env.lazyTrusted.owned.size && env.lazyTrusted.executions.length) { await wait(30); return; }
    await wait(10);
  }
  throw Error("Actual child did not settle.");
}
function projection(response) {
  const result = structuredClone(response);
  delete result.usage;
  const scrub = value => {
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value)) {
      if (["started_at", "completed_at", "last_heartbeat_at", "last_progress_at", "heartbeat_age_seconds", "progress_age_seconds"].includes(key))
        delete value[key];
      else scrub(value[key]);
    }
  };
  scrub(result);
  return result;
}

test("original real compiler/worker and Next durable executor match controlled lazy start/get/next receipts, side-effecting get and owned-child cancellation over real MCP + HTTP", { skip, timeout: 90000 }, async t => {
  const { prepared, evidence } = fixture();
  const oracle = spawnSync("python3", ["-B", "tests/next-trial-electron/legacy-lazy-contract-oracle.py",
    process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION, prepared.fixture], { encoding: "utf8", timeout: 45000 });
  assert.equal(oracle.status, 0, oracle.stderr + oracle.stdout);
  const old = JSON.parse(oracle.stdout).trace, before = capture(prepared.originalRoot);
  assert.equal(old.get_originally_misannotated_read_only.annotations.readOnlyHint, true);
  assert.equal(effects(evidence).length, 3);
  let env = await open(prepared, { library: true, publicApi: true, lazy: true }), mcp, http, client;
  t.after(async () => {
    await client?.close(); await mcp?.close();
    if (http) { http.server.closeAllConnections(); await new Promise(resolve => http.server.close(resolve)); }
    await env.close(); assert.deepEqual(capture(prepared.originalRoot), before);
    fs.rmSync(prepared.base, { recursive: true, force: true });
  });
  const actor = { id: prepared.actorId, canWrite: true, recipeProtocol: true }, token = randomUUID();
  http = await (await load("http")).startHttp(env.runtime.core, token, actor, 0);
  mcp = await (await load("recipe-mcp-http")).startRecipeMcpHttp(env.runtime.core, actor, token);
  client = new Client({ name: "controlled-lazy-actual-client", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  async function invoke(name, args, via = "mcp") {
    const operation = `mcp.tool.recipe_run_${name}`;
    const preview = await env.publicRecipes.previewLazy(env.binding, { operation, args });
    await env.publicRecipes.approveLazy(env.binding, { operation, args, previewDigest: preview.previewDigest });
    if (via === "http") {
      const response = await fetch(`${http.url}/v1/capability_call`, { method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ operation, version: 1, arguments: args }) });
      assert.equal(response.status, 200);
      const body = await response.json(); assert(!body.error, JSON.stringify(body)); return body.result;
    }
    const response = await client.callTool({ name: "capability_call",
      arguments: { operation, version: 1, arguments: args } });
    assert(!response.isError, JSON.stringify(response));
    assert.deepEqual(response.structuredContent, JSON.parse(response.content[0].text));
    return response.structuredContent;
  }
  const description = await env.runtime.core.dispatch("capabilities_describe", { operation: "mcp.tool.recipe_run_get" }, actor);
  assert.equal(description.result.readOnly, false);
  assert.match(description.result.authorization, /fresh exact native host/);
  assert.equal(description.result.idempotency, "explicit-consent-no-automatic-retry");
  assert((await env.runtime.core.dispatch("capability_read", { operation: "mcp.tool.recipe_run_get", version: 1,
    arguments: { run_id: "missing" } }, actor)).error);
  assert((await env.runtime.core.dispatch("capabilities_describe", { operation: "mcp.tool.recipe_run_get" },
    { ...actor, canWrite: false })).error);
  assert((await env.runtime.core.dispatch("capability_call", { operation: "mcp.tool.recipe_run_start", version: 1,
    arguments: { recipe_id: evidence.recipeId, command_id: "not-approved", inputs_json: '{"mode":"complete"}' } }, actor)).error);
  const startArgs = { recipe_id: evidence.recipeId, command_id: "controlled-lazy-success", inputs_json: '{"mode":"complete"}' };
  const trace = {};
  trace.revision_mismatch = await env.lazy.dispatch("mcp.tool.recipe_run_start", {
    recipe_id: evidence.recipeId, command_id: "invalid-source-revision",
    expected_revision: evidence.recipe.revision + 1,
  }, actor);
  trace.digest_mismatch = await env.lazy.dispatch("mcp.tool.recipe_run_start", {
    recipe_id: evidence.recipeId, command_id: "invalid-source-digest", expected_digest: "f".repeat(64),
  }, actor);
  trace.start = await invoke("start", startArgs);
  assert.equal(trace.start.run_id, "recipe_run_" + createHash("sha256").update(startArgs.command_id).digest("hex").slice(0, 24));
  trace.get_initial = await invoke("get", { run_id: trace.start.run_id }, "http");
  await wait(100); assert.equal(effects(evidence).length, 3);
  trace.next_first = await invoke("next", { run_id: trace.start.run_id, command_id: "first-request" });
  await settled(env);
  trace.read_first = await invoke("get", { run_id: trace.start.run_id }, "http");
  assert.equal(trace.read_first.current_result.counts.pending, 1);
  await wait(100); assert.equal(effects(evidence).length, 4);
  trace.replay_first = await invoke("next", { run_id: trace.start.run_id, command_id: "first-request" });
  assert.equal(trace.replay_first.replayed, true);
  assert.equal(trace.replay_first.version, trace.next_first.version, "Replay preserves original response, not current observed version.");
  trace.command_conflict = await invoke("next", { run_id: trace.start.run_id, command_id: "first-request", detail: "full" });
  trace.next_second = await invoke("next", { run_id: trace.start.run_id, command_id: "second-request" }, "http");
  await settled(env); trace.completed = await invoke("get", { run_id: trace.start.run_id });
  assert.equal(effects(evidence).length, 5);
  trace.cancel_start = await invoke("start", { recipe_id: evidence.recipeId,
    command_id: "controlled-lazy-cancel", inputs_json: '{"mode":"hold"}' });
  const cancel = trace.cancel_start.run_id;
  trace.invalid_progress = await invoke("progress", { run_id: cancel, node_id: "first",
    command_id: "too-early", progress_json: '{"cancellationRequested":true}' });
  trace.cancel_next = await invoke("next", { run_id: cancel, command_id: "claim-cancel" });
  for (let i = 0; i < 500 && effects(evidence).length < 6; i++) await wait(10);
  assert.equal(effects(evidence).length, 6);
  const concurrent = await invoke("next", { run_id: cancel, command_id: "running-not-second" }, "http");
  assert.equal(concurrent.next_action.node_id, "first");
  assert.equal(effects(evidence).length, 6);
  trace.cancel_progress = await invoke("progress", { run_id: cancel, node_id: "first",
    command_id: "cancel-request", progress_json: '{"cancellationRequested":true}' }, "http");
  await settled(env); trace.cancelled = await invoke("get", { run_id: cancel });
  trace.cancel_replayed = await invoke("progress", { run_id: cancel, node_id: "first",
    command_id: "cancel-request", progress_json: '{"cancellationRequested":true}' });
  assert.equal(trace.cancelled.status, "failed");
  assert.equal(trace.cancelled.current_result.completed_nodes[0].result.cancelled, true);
  assert.equal(effects(evidence).length, 6);
  for (const [name, response] of Object.entries(trace))
    assert.deepEqual(projection(response), projection(old[name]), `Actual original contract: ${name}`);
  assert(effects(evidence).every(effect => effect.literal === evidence.literal));
  assert(!fs.existsSync(path.join(prepared.fixture, "workspace", "NEVER-CREATED")));
});

test("manual intents survive generic NativeRuntime restart, in-flight host close becomes explicit unknown without replay, and actor/approval conflicts stay fenced", { skip, timeout: 60000 }, async t => {
  const { prepared, evidence } = fixture(), before = capture(prepared.originalRoot);
  let env = await open(prepared, { library: true, publicApi: true, lazy: true });
  t.after(async () => { await env.close(); assert.deepEqual(capture(prepared.originalRoot), before);
    fs.rmSync(prepared.base, { recursive: true, force: true }); });
  const actor = { id: prepared.actorId, canWrite: true, recipeProtocol: true };
  const dispatch = (name, args) => env.lazy.dispatch(`mcp.tool.recipe_run_${name}`, args, actor);
  const pending = await dispatch("start", { recipe_id: evidence.recipeId, command_id: "pending-restart", inputs_json: '{"mode":"complete"}' });
  assert.equal(pending.ok, true, JSON.stringify(pending));
  await env.close(); env = await open(prepared, { library: true, publicApi: true, lazy: true });
  await wait(100); assert.equal(effects(evidence).length, 0, "Generic startup scheduler must skip persisted explicit dispatch.");
  assert.equal((await dispatch("get", { run_id: pending.run_id })).current_result.counts.pending, 2);
  await dispatch("next", { run_id: pending.run_id, command_id: "first" }); await settled(env);
  await dispatch("get", { run_id: pending.run_id });
  await env.close(); env = await open(prepared, { library: true, publicApi: true, lazy: true });
  await wait(100); assert.equal(effects(evidence).length, 1, "Restart must not request the second step.");
  const held = await dispatch("start", { recipe_id: evidence.recipeId, command_id: "held-restart", inputs_json: '{"mode":"hold"}' });
  await dispatch("next", { run_id: held.run_id, command_id: "hold-first" });
  for (let i = 0; i < 500 && effects(evidence).length < 2; i++) await wait(10);
  assert.equal(effects(evidence).length, 2);
  await env.close(); env = await open(prepared, { library: true, publicApi: true, lazy: true });
  const unknown = await dispatch("get", { run_id: held.run_id });
  assert.equal(unknown.next_action.state, "launch-outcome-unknown");
  assert.equal(unknown.next_action.replay_allowed, false);
  await dispatch("next", { run_id: held.run_id, command_id: "fresh-command-is-not-replay-permission" });
  await wait(100); assert.equal(effects(evidence).length, 2);
  await assert.rejects(env.lazy.dispatch("mcp.tool.recipe_run_get", { run_id: held.run_id }, { ...actor, id: randomUUID() }), /authority/);
  const operation = "mcp.tool.recipe_run_next", args = { run_id: pending.run_id, command_id: "approval-conflict" };
  const preview = await env.publicRecipes.previewLazy(env.binding, { operation, args });
  await dispatch("progress", { run_id: held.run_id, node_id: "first", command_id: "mark-unknown", progress_json: '{"message":"inspect; never replay"}' });
  await env.publicRecipes.approveLazy(env.binding, { operation, args, previewDigest: preview.previewDigest });
  const denied = await env.runtime.core.dispatch("capability_call", { operation, version: 1,
    arguments: { ...args, command_id: "not-identical" } }, actor);
  assert.equal(denied.error.code, "ACCESS_DENIED");
  await dispatch("next", { run_id: pending.run_id, command_id: "privately-requested-before-public-call" });
  await settled(env);
  const conflict = await env.runtime.core.dispatch("capability_call", { operation, version: 1, arguments: args }, actor);
  assert.equal(conflict.error.code, "CONFLICT");
  assert.equal(effects(evidence).length, 3);
});

test("legacy untyped inputs require the host-only seam; executable drift denies before claim, while repaired exact authority permits one requested effect", { skip, timeout: 60000 }, async t => {
  const { prepared, evidence } = fixture({ untyped: true }), before = capture(prepared.originalRoot);
  const env = await open(prepared, { library: true, publicApi: true, lazy: true });
  let ordinary;
  t.after(async () => { ordinary?.close(); await env.close(); assert.deepEqual(capture(prepared.originalRoot), before);
    fs.rmSync(prepared.base, { recursive: true, force: true }); });
  const { WorkflowExecutor } = await load("workflow-executor"), catalog = await env.authority.catalog(env.binding);
  ordinary = new WorkflowExecutor(env.storage.connectNative(), { workspaceRoot: prepared.root, ownerId: randomUUID(),
    adapters: env.lazyTrusted.adapters, resolveRecipe: env.authority.resolveRecipe,
    assertOwner: () => env.storage.assertWorkspaceLease() });
  const inputs = { mode: "complete", literal: evidence.literal }, actor = { id: prepared.actorId, canWrite: true };
  const create = { operationId: randomUUID(), runId: "ordinary-untyped-denied",
    source: { kind: "recipe", recipeId: evidence.recipeId, expectedRevision: evidence.recipe.revision,
      expectedExecutableDigest: evidence.recipe.executableDigest, snapshotRevision: catalog.snapshotRevision },
    expectedExecutableDigest: evidence.recipe.executableDigest, inputs, deadline: Date.now() + 10000 };
  assert.throws(() => ordinary.create(actor.id, create), /Unknown workflow input/);
  assert.throws(() => ordinary.create(actor.id, { ...create, dispatchMode: "explicit" }), /dispatchMode|Unrecognized/);
  const started = await env.lazy.dispatch("mcp.tool.recipe_run_start", { recipe_id: evidence.recipeId,
    command_id: "untyped-legacy-intent", inputs_json: JSON.stringify(inputs) }, actor);
  assert.equal(started.ok, true, JSON.stringify(started));
  const original = fs.readFileSync(evidence.script);
  fs.writeFileSync(evidence.script, Buffer.concat([original, Buffer.from("\n// actual drift\n")]));
  const request = { operation: "mcp.tool.recipe_run_next", args: { run_id: started.run_id, command_id: "exact-first" } };
  await assert.rejects(env.publicRecipes.previewLazy(env.binding, request), /authority changed before dispatch/);
  await assert.rejects(env.lazy.dispatch(request.operation, request.args, actor), /authority changed before dispatch/);
  assert.equal(effects(evidence).length, 0);
  assert.equal((await env.lazy.dispatch("mcp.tool.recipe_run_get", { run_id: started.run_id }, actor)).current_result.counts.pending, 2);
  fs.writeFileSync(evidence.script, original);
  const preview = await env.publicRecipes.previewLazy(env.binding, request);
  await env.publicRecipes.approveLazy(env.binding, { ...request, previewDigest: preview.previewDigest });
  const response = await env.runtime.core.dispatch("capability_call",
    { operation: request.operation, version: 1, arguments: request.args }, { ...actor, recipeProtocol: true });
  assert(!response.error, JSON.stringify(response));
  await settled(env);
  assert.equal(effects(evidence).length, 1);
  const observed = await env.lazy.dispatch("mcp.tool.recipe_run_get", { run_id: started.run_id }, actor);
  assert.equal(observed.current_result.counts.pending, 1);
  assert.equal(JSON.parse(observed.current_result.completed_nodes[0].result.stdout).literal, evidence.literal);
});
