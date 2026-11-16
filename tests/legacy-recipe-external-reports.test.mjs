import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { prepare, capture, open, load } from "./legacy-api-chat-recipes-fixtures.mjs";
const require = createRequire(import.meta.url);
const helper = require("../legacy/tests/next-trial-electron/controlled-lazy-recipe-fixture.cjs");
const skip = !process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION && "Requires actual original VSIX.";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function setup(t) {
  const prepared = prepare();
  let env, before;
  t.after(async () => { try { await env?.close(); if (before) assert.deepEqual(capture(prepared.originalRoot), before); }
    finally { fs.rmSync(prepared.base, { recursive: true, force: true }); } });
  const command = helper.create({ fixture: prepared.fixture, root: prepared.originalRoot,
    extension: process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION });
  const { ProjectStore } = require(path.join(process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION, "dist/workflows/project-store.js"));
  const recipe = new ProjectStore(path.join(prepared.originalRoot, ".pkm/state")).list().recipes
    .find(row => row.name === "Universal Unknown Task");
  assert(recipe && recipe.definition.spec.nodes.length === 6);
  prepared.additionalRecipes = [recipe, command.recipe];
  fs.writeFileSync(path.join(prepared.fixture, "external-report-recipe.json"), JSON.stringify(recipe), { mode: 0o600 });
  const externalReports = ({ binding, canonicalJson }) => ({
    id: "fixture-explicit-universal-external-reporter",
    authorizationDigest: createHash("sha256").update(canonicalJson({ binding, recipeId: recipe.recipeId,
      executableDigest: recipe.executableDigest, authority: "external-caller-reported-not-agent-execution" })).digest("hex"),
    authorizeDefinition: candidate => candidate.actorId === binding.actorId && candidate.executableDigest === recipe.executableDigest
      && candidate.source?.kind === "recipe" && candidate.source.recipeId === recipe.recipeId
      && canonicalJson(candidate.node) === canonicalJson(recipe.definition.spec.nodes.find(node => node.nodeId === candidate.node.nodeId)),
  });
  return { prepared, recipe, externalReports,
    async open(options = {}) { before ??= capture(prepared.originalRoot);
      env = await open(prepared, { library: true, publicApi: true, lazy: true, externalReports, ...options }); return env; } };
}
function projection(response) {
  const result = structuredClone(response);
  const scrub = value => {
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value)) {
      if (["started_at", "completed_at", "last_heartbeat_at", "last_progress_at", "heartbeat_age_seconds", "progress_age_seconds"].includes(key)) delete value[key];
      else scrub(value[key]);
    }
  };
  scrub(result); return result;
}
test("actual original Universal Unknown Task report workflow matches real SDK MCP/HTTP, results/errors/usage/receipt replay; external caller performs its own real work", { skip, timeout: 90000 }, async t => {
  const fixture = setup(t), oracle = spawnSync("python3", ["-B", path.resolve(import.meta.dirname, "../legacy/tests/next-trial-electron/legacy-external-report-oracle.py"),
    process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION, fixture.prepared.fixture], { encoding: "utf8", timeout: 30000 });
  assert.equal(oracle.status, 0, oracle.stderr + oracle.stdout);
  const old = JSON.parse(oracle.stdout), env = await fixture.open();
  const actor = { id: env.actorId, canWrite: true, recipeProtocol: true }, token = randomUUID();
  const mcp = await (await load("recipe-mcp-http")).startRecipeMcpHttp(env.runtime.core, actor, token);
  const http = await (await load("http")).startHttp(env.runtime.core, token, actor, 0);
  const client = new Client({ name: "actual-external-report-caller", version: "1" });
  t.after(async () => { await client.close(); await mcp.close(); http.server.closeAllConnections();
    await new Promise(resolve => http.server.close(resolve)); });
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
      const body = await response.json(); assert(!body.error, JSON.stringify(body)); return body.result;
    }
    const response = await client.callTool({ name: "capability_call",
      arguments: { operation, version: 1, arguments: args } });
    assert(!response.isError, JSON.stringify(response)); return response.structuredContent;
  }
  const described = await env.runtime.core.dispatch("capabilities_describe", { operation: "mcp.tool.recipe_run_report" }, actor);
  assert(!described.error, JSON.stringify(described));
  assert.equal(described.result.readOnly, false);
  assert((await env.runtime.core.dispatch("capability_call", { operation: "mcp.tool.recipe_run_report", version: 1,
    arguments: old.reports[0].args }, actor)).error, "Report has its own exact approval, not start's grant.");
  assert((await env.runtime.core.dispatch("capability_read", { operation: "mcp.tool.recipe_run_report", version: 1,
    arguments: old.reports[0].args }, actor)).error);
  const start = await invoke("start", { recipe_id: fixture.recipe.recipeId, command_id: "universal-real-external-caller",
    inputs_json: '{"task":"Read the exact synthetic file and preserve its evidence."}' });
  assert.deepEqual(projection(start), projection(old.start));
  assert.deepEqual(projection(await invoke("get", { run_id: start.run_id })), projection(old.get_initial));
  assert.deepEqual(projection(await invoke("next", { run_id: start.run_id, command_id: "claim-universal-first" })), projection(old.next));
  assert.deepEqual(projection(await invoke("get", { run_id: start.run_id }, "http")), projection(old.get_claimed));
  assert.deepEqual(projection(await invoke("progress", old.progress_args, "http")), projection(old.progress_claimed));
  const direct = (args) => env.lazy.dispatch("mcp.tool.recipe_run_report", args, actor);
  assert.deepEqual(await direct({ ...old.reports[0].args, outcome: "unknown" }), old.bad_outcome);
  assert.deepEqual(await direct({ ...old.reports[0].args, usage_json: '{"estimated_tokens":true}' }), old.bad_usage);
  for (const invalid of old.usage_errors)
    assert.deepEqual(await direct(invalid.args), invalid.response);
  for (const [index, report] of old.reports.entries()) {
    const actualHash = createHash("sha256").update(fs.readFileSync(path.join(env.fixture, "workspace/recipe-input.txt"))).digest("hex");
    const result = JSON.parse(report.args.result_json); assert.equal(result.sha256, actualHash);
    fs.appendFileSync(path.join(env.fixture, "workspace/new-external-caller-effects.jsonl"),
      JSON.stringify({ node: report.args.node_id, sha256: actualHash }) + "\n", { mode: 0o600 });
    const value = await invoke("report", { ...report.args, result_json: JSON.stringify(result) }, index % 2 ? "http" : "mcp");
    assert.deepEqual(projection(value), projection(report.response), report.args.node_id);
  }
  assert.deepEqual(projection(await invoke("report", old.reports[0].args)), projection(old.replay));
  assert.deepEqual(await direct({ ...old.reports[0].args, result_json: '{"changed":true}' }), old.conflict);
  assert.deepEqual(projection(await invoke("get", { run_id: start.run_id })), projection(old.final));
  assert.deepEqual(projection(await invoke("start", { recipe_id: fixture.recipe.recipeId,
    command_id: "universal-real-external-failure",
    inputs_json: '{"task":"Read the exact synthetic file and preserve its evidence."}' })), projection(old.failure.start));
  assert.deepEqual(projection(await invoke("next", { run_id: old.failure.start.run_id,
    command_id: "claim-failure-first" })), projection(old.failure.next));
  for (const report of old.failure.reports)
    assert.deepEqual(projection(await invoke("report", report.args)), projection(report.response));
  assert.equal(fs.readFileSync(path.join(env.fixture, "workspace/new-external-caller-effects.jsonl"), "utf8").trim().split("\n").length, 6);
  assert.equal(env.lazyTrusted.executions.length, 0, "Manual reports never launch the command adapter or a fictitious agent.");
});
test("revoked external authority and oversized reports do not complete the pending Step, alter usage or claim a successor", { skip, timeout: 60000 }, async t => {
  const fixture = setup(t);
  let allowed = true;
  const env = await fixture.open({ externalReports: context => {
    const policy = fixture.externalReports(context);
    return { ...policy, authorizeDefinition: binding => allowed && policy.authorizeDefinition(binding) };
  } });
  const actor = { id: env.actorId, canWrite: true, recipeProtocol: true };
  const unsafeStart = await env.lazy.dispatch("mcp.tool.recipe_run_start", {
    recipe_id: fixture.recipe.recipeId, command_id: "cannot-round-external-input",
    inputs_json: '{"externalIdentifier":9007199254740993}' }, actor);
  assert.equal(unsafeStart.ok, false);
  assert.match(unsafeStart.error.message, /finite\/safe-integer/);
  const started = await env.lazy.dispatch("mcp.tool.recipe_run_start", {
    recipe_id: fixture.recipe.recipeId, command_id: "revocable-external-authority" }, actor);
  assert(started.ok, JSON.stringify(started));
  const claimed = await env.lazy.dispatch("mcp.tool.recipe_run_next", {
    run_id: started.run_id, command_id: "claim-revocable" }, actor);
  const request = { operation: "mcp.tool.recipe_run_report", args: { run_id: started.run_id,
    node_id: claimed.next_action.node_id, command_id: "report-revocable", outcome: "succeeded", result_json: "null" } };
  const oversized = await env.lazy.dispatch(request.operation, {
    ...request.args, result_json: JSON.stringify("x".repeat(61441)) }, actor);
  assert.equal(oversized.ok, false);
  assert.match(oversized.error.message, /bounded output budget/);
  for (const result_json of ["9007199254740993", '{"nested":[1e309]}']) {
    const unsafe = await env.lazy.dispatch(request.operation, { ...request.args, result_json }, actor);
    assert.equal(unsafe.ok, false);
    assert.match(unsafe.error.message, /finite\/safe-integer/);
  }
  const preview = await env.publicRecipes.previewLazy(env.binding, request);
  await env.publicRecipes.approveLazy(env.binding, { ...request, previewDigest: preview.previewDigest });
  allowed = false;
  const rejected = await env.runtime.core.dispatch("capability_call", {
    operation: request.operation, version: 1, arguments: request.args }, actor);
  assert.equal(rejected.error.code, "ACCESS_DENIED");
  let current = await env.lazy.dispatch("mcp.tool.recipe_run_get", { run_id: started.run_id }, actor);
  assert.equal(current.current_result.counts.running, 1);
  assert.equal(current.current_result.counts.pending, 5);
  assert.equal(current.usage.reported_attempts, 0);
  allowed = true;
  const accepted = await env.lazy.dispatch(request.operation, request.args, actor);
  assert(accepted.ok, JSON.stringify(accepted));
  current = await env.lazy.dispatch("mcp.tool.recipe_run_get", { run_id: started.run_id }, actor);
  assert.equal(current.current_result.counts.succeeded, 1);
  assert.equal(current.current_result.counts.pending, 4);
  assert.equal(current.current_result.completed_nodes[0].result, null);
  assert.equal(current.usage.reported_attempts, 1);
  assert.equal(env.lazyTrusted.executions.length, 0);
});
test("external report authority is opt-in; pending reports become UNKNOWN on restart and cannot resurrect lease proofs or execute successors", { skip, timeout: 60000 }, async t => {
  const fixture = setup(t);
  let env = await fixture.open({ externalReports: undefined });
  assert.equal(env.publicRecipes.available("mcp.tool.recipe_run_report"), false);
  const actor = { id: env.actorId, canWrite: true, recipeProtocol: true };
  const initial = await env.lazy.dispatch("mcp.tool.recipe_run_start", {
    recipe_id: fixture.recipe.recipeId, command_id: "without-reporter" }, actor);
  assert.equal(initial.ok, false);
  await env.close(); env = await fixture.open();
  const started = await env.lazy.dispatch("mcp.tool.recipe_run_start", {
    recipe_id: fixture.recipe.recipeId, command_id: "manual-report-interrupted" }, actor);
  assert(started.ok, JSON.stringify(started));
  const claimed = await env.lazy.dispatch("mcp.tool.recipe_run_next", {
    run_id: started.run_id, command_id: "claim-before-restart" }, actor);
  assert.equal(claimed.next_action.kind, "execute_node");
  await wait(20); await env.close(); env = await fixture.open();
  const report = await env.lazy.dispatch("mcp.tool.recipe_run_report", {
    run_id: started.run_id, node_id: claimed.next_action.node_id, command_id: "late-report", outcome: "succeeded" }, actor);
  assert.equal(report.ok, false);
  const progress = { operation: "mcp.tool.recipe_run_progress", args: { run_id: started.run_id,
    node_id: claimed.next_action.node_id, command_id: "cannot-hide-unknown", progress_json: '{"message":"still working"}' } };
  const progressPreview = await env.publicRecipes.previewLazy(env.binding, progress);
  await env.publicRecipes.approveLazy(env.binding, { ...progress, previewDigest: progressPreview.previewDigest });
  const annotation = await env.runtime.core.dispatch("capability_call", {
    operation: progress.operation, version: 1, arguments: progress.args }, actor);
  assert(!annotation.error, JSON.stringify(annotation));
  assert.equal(annotation.result.next_action.state, "launch-outcome-unknown");
  assert.equal(annotation.result.next_action.replay_allowed, false);
  assert.equal(annotation.result.current_result.counts.pending, 5);
  const read = await env.lazy.dispatch("mcp.tool.recipe_run_get", { run_id: started.run_id }, actor);
  assert.equal(read.next_action.state, "launch-outcome-unknown");
  assert.equal(read.next_action.replay_allowed, false);
  const next = await env.lazy.dispatch("mcp.tool.recipe_run_next", {
    run_id: started.run_id, command_id: "no-new-successor" }, actor);
  assert.equal(next.next_action.replay_allowed, false);
  assert.equal(next.current_result.counts.pending, 5);
  assert.equal(env.lazyTrusted.executions.length, 0);
});
