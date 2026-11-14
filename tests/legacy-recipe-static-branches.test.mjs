import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { prepare, capture, open, load } from "./legacy-api-chat-recipes-fixtures.mjs";
const require = createRequire(import.meta.url);
const helper = require("../legacy/tests/next-trial-electron/legacy-static-branch-fixture.cjs");
const skip = !process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION && "Requires actual original VSIX.";

function project(response, original, native) {
  const copy = structuredClone(response);
  const scrub = value => {
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value)) {
      if (["started_at", "completed_at", "last_heartbeat_at", "last_progress_at",
        "heartbeat_age_seconds", "progress_age_seconds"].includes(key)) delete value[key];
      else scrub(value[key]);
    }
  };
  scrub(copy);
  if (copy.recipe?.recipe_id === native.recipeId) {
    assert.equal(copy.recipe.revision, native.revision);
    copy.recipe.recipe_id = original.recipeId;
    copy.recipe.revision = original.revision;
  }
  return copy;
}

async function setup(t) {
  const prepared = prepare(), extension = process.env.PKM_TEST_LEGACY_RECIPE_EXTENSION;
  let env, expectedSave, before;
  t.after(async () => { try { await env?.close(); if (before) assert.deepEqual(capture(prepared.originalRoot), before); }
    finally { fs.rmSync(prepared.base, { recursive: true, force: true }); } });
  require("../legacy/tests/next-trial-electron/controlled-lazy-recipe-fixture.cjs").create({
    extension, fixture: prepared.fixture, root: prepared.originalRoot });
  const evidence = helper.create({ extension, root: prepared.originalRoot, fixture: prepared.fixture });
  const oracle = spawnSync("python3", ["-B", "tests/next-trial-electron/legacy-static-branch-oracle.py",
    extension, prepared.fixture], { encoding: "utf8", timeout: 30000 });
  assert.equal(oracle.status, 0, oracle.stderr + oracle.stdout);
  const old = JSON.parse(oracle.stdout);
  before = capture(prepared.originalRoot);
  const { canonicalJson } = await load("domain/project-recipes-workflow-contracts");
  env = await open(prepared, { library: true, publicApi: { authorizeMutation(request) {
    if (!expectedSave || request.operation !== "recipe.library.save" || request.actor.id !== prepared.actorId
      || canonicalJson(request.args) !== canonicalJson(expectedSave)) return false;
    expectedSave = undefined; return true;
  } } });
  const actor = { id: prepared.actorId, canWrite: true, recipeProtocol: true };
  const draft = await env.authority.editor(env.binding, { namespace: env.binding.namespace, chatId: env.binding.chatId,
    recipeId: prepared.evidence.recipeId, copy: true });
  const fields = Object.fromEntries(["name", "category", "description", "definition", "metadata", "editorLayout", "nodeBindings", "methodology"]
    .filter(key => key in evidence.recipe).map(key => [key, evidence.recipe[key]]));
  fields.nodeBindings = [];
  const args = { namespace: env.binding.namespace, chatId: env.binding.chatId, operationId: randomUUID(),
    expectedDigest: draft.digest, recipeId: draft.recipe.recipeId, expectedRevision: 0, fields };
  const token = randomUUID(), http = await (await load("http")).startHttp(env.runtime.core, token, actor, 0);
  let native;
  try {
    const save = () => fetch(`${http.url}/v1/capability_call`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "recipe.library.save", version: 1, arguments: args }) });
    assert.equal((await save()).status, 403, "Bearer alone cannot author a native definition.");
    expectedSave = args;
    const saved = await (await save()).json(); assert(!saved.error, JSON.stringify(saved));
    native = (await env.authority.catalog(env.binding)).recipes.find(row => row.recipeId === draft.recipe.recipeId);
    assert(native && native.recipeId !== evidence.recipe.recipeId);
    assert.equal(native.executableDigest, evidence.recipe.executableDigest);
    assert.equal(native.revision, 1);
  } finally { http.server.closeAllConnections(); await new Promise(resolve => http.server.close(resolve)); }
  await env.close(); env = undefined;
  const reports = context => helper.policy({ fixture: prepared.fixture, ...context, recipe: native });
  return { prepared, evidence, old, native, actor, reports,
    translate: args => args.recipe_id ? { ...args, recipe_id: native.recipeId } : args,
    project: response => project(response, evidence.recipe, native),
    async open(options = {}) {
      env = await open(prepared, { library: true, publicApi: true, lazy: true, externalReports: reports, ...options }); return env;
    } };
}

test("user-authored static branches saved over actual native HTTP match original dispatch/result/skip/join/cancellation semantics over SDK MCP and HTTP", { skip, timeout: 90000 }, async t => {
  const fixture = await setup(t), env = await fixture.open();
  const token = randomUUID(), mcp = await (await load("recipe-mcp-http")).startRecipeMcpHttp(env.runtime.core, fixture.actor, token);
  const http = await (await load("http")).startHttp(env.runtime.core, token, fixture.actor, 0);
  const client = new Client({ name: "actual-static-evidence-caller", version: "1" });
  t.after(async () => { await client.close(); await mcp.close(); http.server.closeAllConnections();
    await new Promise(resolve => http.server.close(resolve)); });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  async function invoke(name, args, via = "mcp") {
    args = fixture.translate(args);
    const operation = `mcp.tool.recipe_run_${name}`;
    const preview = await env.publicRecipes.previewLazy(env.binding, { operation, args });
    await env.publicRecipes.approveLazy(env.binding, { operation, args, previewDigest: preview.previewDigest });
    if (via === "http") {
      const response = await fetch(`${http.url}/v1/capability_call`, { method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ operation, version: 1, arguments: args }) });
      const body = await response.json(); assert(!body.error, JSON.stringify(body)); return body.result;
    }
    const response = await client.callTool({ name: "capability_call", arguments: { operation, version: 1, arguments: args } });
    assert(!response.isError, JSON.stringify(response)); return response.structuredContent;
  }
  assert.match(JSON.stringify(fixture.old.original_tutorial_start), /succeeded|accept/);
  const equal = (actual, expected) => assert.deepEqual(fixture.project(actual), fixture.project(expected));
  for (const [scenario, old] of Object.entries(fixture.old.scenarios)) {
    equal(await invoke("start", old.start_args), old.start);
    equal(await invoke("next", old.next_args, "http"), old.next);
    assert((await env.runtime.core.dispatch("capability_call", { operation: "mcp.tool.recipe_run_report", version: 1,
      arguments: old.reports[0].args }, fixture.actor)).error, "Every branch report needs its own fresh exact native decision.");
    equal(await env.lazy.dispatch("mcp.tool.recipe_run_report", {
      ...old.reports[0].args, outcome: "succeeded" }, fixture.actor), old.bad_case);
    for (const [index, report] of old.reports.entries()) {
      const nodeId = report.args.node_id;
      if (scenario === "cancel" && index === 1) equal(await invoke("progress", old.progress_args, "http"), old.progress);
      if (scenario === "io-failure" && index === 1)
        assert.throws(() => fs.readFileSync(path.join(env.fixture, "workspace/caller-missing-input")), { code: "ENOENT" });
      if (scenario !== "inspection-failure" && (index === 0 || ["valid", "invalid"].includes(scenario))) {
        const work = helper.perform({ fixture: env.fixture, scenario, nodeId, inputs: old.inputs });
        assert.equal(work.outcome, report.args.outcome);
        assert.deepEqual(work.result, JSON.parse(report.args.result_json));
      }
      equal(await invoke("report", report.args, index % 2 ? "http" : "mcp"), report.response);
    }
    equal(await invoke("get", { run_id: old.start.run_id }), old.final);
    equal(await invoke("report", old.reports[0].args, "http"), old.replay);
    equal(await env.lazy.dispatch("mcp.tool.recipe_run_report", {
      ...old.reports[0].args, result_json: '{"changed":true}' }, fixture.actor), old.conflict);
  }
  assert.equal(env.lazyTrusted.executions.length, 0);
  for (const scenario of ["cancel", "io-failure", "inspection-failure"])
    assert(!fs.existsSync(path.join(env.fixture, `workspace/branch-${scenario}/archive.json`)));
});

test("static branches remain explicitly gated; revoked reports and fenced restart retain the selected case without replaying or switching paths", { skip, timeout: 90000 }, async t => {
  const fixture = await setup(t);
  let env = await fixture.open({ externalReports: context => ({ ...fixture.reports(context), staticBranches: false }) });
  const args = { ...fixture.old.scenarios.invalid.start_args, recipe_id: fixture.native.recipeId, command_id: "static-branch-interrupted" };
  const denied = await env.lazy.dispatch("mcp.tool.recipe_run_start", args, fixture.actor);
  assert.equal(denied.ok, false);
  await env.close();
  let allowed = true;
  const options = { externalReports: context => {
    const policy = fixture.reports(context);
    return { ...policy, authorizeDefinition: binding => allowed && policy.authorizeDefinition(binding) };
  } };
  env = await fixture.open(options);
  const started = await env.lazy.dispatch("mcp.tool.recipe_run_start", args, fixture.actor);
  assert(started.ok, JSON.stringify(started));
  await env.lazy.dispatch("mcp.tool.recipe_run_next", { run_id: started.run_id, command_id: "claim-static-before-restart" }, fixture.actor);
  const work = helper.perform({ fixture: env.fixture, scenario: "interrupted", nodeId: "inspect", inputs: fixture.old.scenarios.invalid.inputs });
  const report = { run_id: started.run_id, node_id: "inspect", command_id: "choose-invalid-before-restart",
    outcome: work.outcome, result_json: JSON.stringify(work.result), detail: "full" };
  const request = { operation: "mcp.tool.recipe_run_report", args: report };
  const preview = await env.publicRecipes.previewLazy(env.binding, request);
  await env.publicRecipes.approveLazy(env.binding, { ...request, previewDigest: preview.previewDigest });
  allowed = false;
  assert.equal((await env.runtime.core.dispatch("capability_call", { operation: request.operation,
    arguments: report, version: 1 }, fixture.actor)).error.code, "ACCESS_DENIED");
  allowed = true;
  const chosen = await env.lazy.dispatch(request.operation, report, fixture.actor);
  assert.equal(chosen.next_action.node_id, "repair");
  assert.equal(chosen.current_result.completed_nodes.find(node => node.node_id === "inspect").outcome, "invalid");
  assert.equal(chosen.current_result.completed_nodes.find(node => node.node_id === "record-valid").outcome, "skipped");
  await env.close(); env = await fixture.open(options);
  for (const name of ["get", "next", "progress"]) {
    const observed = await env.lazy.dispatch(`mcp.tool.recipe_run_${name}`, { run_id: started.run_id,
      ...(name !== "get" ? { command_id: "after-restart-" + name } : {}),
      ...(name === "progress" ? { node_id: "repair", progress_json: '{"message":"inspection only"}' } : {}), detail: "full" }, fixture.actor);
    assert.equal(observed.next_action.replay_allowed, false);
    assert.equal(observed.current_result.counts.pending, 1);
    assert.equal(observed.current_result.completed_nodes.find(node => node.node_id === "inspect").outcome, "invalid");
    assert.equal(observed.current_result.completed_nodes.find(node => node.node_id === "record-valid").outcome, "skipped");
  }
  const late = await env.lazy.dispatch("mcp.tool.recipe_run_report", { run_id: started.run_id, node_id: "repair",
    command_id: "cannot-finish-unknown", outcome: "succeeded", result_json: "null" }, fixture.actor);
  assert.equal(late.ok, false);
  assert(!fs.existsSync(path.join(env.fixture, "workspace/branch-interrupted/repaired.txt")));
  assert.equal(fs.readFileSync(path.join(env.fixture, "new-static-branch-effects.jsonl"), "utf8").trim().split("\n").length, 1);
});
