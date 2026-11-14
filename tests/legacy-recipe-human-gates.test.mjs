import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { LegacyRecipeLazyRuntime } from "../dist/legacy-recipe-lazy-runtime.js";
import { LegacyRecipeExternalReports } from "../dist/legacy-recipe-external-reports.js";
import { compileWorkflowDefinitionV1 } from "../dist/domain/project-recipes-workflow-contracts.js";
import { NativeRecipePublicApi } from "../dist/native-recipe-public-api.js";
import { WorkflowExecutor } from "../dist/workflow-executor.js";

async function setup(t, config = { inputKind: "approval", prompt: "Approve synthetic operation?" }) {
  const definition = { schema: "pkm.workflow.definition/v1", spec: {
    inputs: {}, outputs: {}, completion: { requiredNodes: ["gate"] },
    nodes: [{ nodeId: "gate", kind: "pkm.gate.human/v1", config, control: { mode: "single" }, dependsOn: [],
      ...(config.inputKind === "approval" ? { ports: { inputs: [], outputs: ["approved", "rejected"] } } : {}) }],
  } };
  const compiled = compileWorkflowDefinitionV1(definition);
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  const recipe = { recipeId: "human-gate-fixture", revision: 1, definition: compiled.model,
    executableDigest: compiled.executableDigest, nodeBindings: [] };
  const root = resolve(`.migration-test-work/human-gate-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(resolve(root, "workflow.sqlite"));
  const actor = { id: "fixture-user", canWrite: true };
  let lazy, external, allowed = true;
  const open = () => {
    external = new LegacyRecipeExternalReports({
      id: "fixture-human-gate", authorizationDigest: "a".repeat(64), humanGates: true,
      authorizeDefinition: binding => allowed && binding.actorId === actor.id
        && binding.executableDigest === recipe.executableDigest,
    });
    lazy = new LegacyRecipeLazyRuntime(database, {
      actorId: actor.id, root, bindingFingerprint: "b".repeat(64), ownerId: randomUUID(),
      adapters: {}, externalReports: external, assertOwner() {}, requestCancel() {},
      catalog: async () => ({ recipes: [recipe], snapshotRevision: "c".repeat(64) }),
      resolveRecipe: source => ({ status: "valid", definition: recipe.definition,
        executableDigest: recipe.executableDigest, source }),
    });
  };
  open();
  t.after(() => { lazy.close(); database.close(); return rm(root, { recursive: true, force: true }); });
  const call = (name, args) => lazy.dispatch(`mcp.tool.recipe_run_${name}`, args, actor);
  const started = await call("start", { recipe_id: recipe.recipeId, command_id: "gate-start" });
  assert.equal(started.ok, true, JSON.stringify(started));
  const claimed = await call("next", { run_id: started.run_id, command_id: "gate-claim" });
  assert.equal(claimed.next_action.kind, "request_user_input", JSON.stringify(claimed));
  const input = {
    run_id: started.run_id, node_id: "gate", challenge_id: claimed.next_action.challenge_id,
    command_id: "gate-user-input", response_json: '{"approved":true}', detail: "full",
  };
  const binding = { root, actorId: actor.id, namespace: "fixture", chatId: "gate-chat",
    bindingFingerprint: "b".repeat(64) };
  const publicApi = new NativeRecipePublicApi({ binding, lazy, uiApprovals: true,
    recipes: { catalog: async () => ({ recipes: [recipe], snapshotRevision: "c".repeat(64) }) } });
  return { call, input, claimed, database, actor, binding, publicApi, recipe, get external() { return external; },
    revoke() { allowed = false; }, restart() { lazy.close(); open(); } };
}

test("human gate requires exact explicit input; agent reports, stale challenges and malformed approval do not complete it", async t => {
  const env = await setup(t);
  assert.throws(() => env.external.submit(env.input.run_id, "gate", "succeeded", {}, ""), /cannot be replaced/);
  const reported = await env.call("report", { run_id: env.input.run_id, node_id: "gate",
    outcome: "succeeded", command_id: "forged-gate-report", result_json: '{"approved":true}' });
  assert.equal(reported.ok, false);
  for (const patch of [{ challenge_id: "stale" }, { response_json: '{"approved":"true"}' },
    { response_json: '{"approved":null}' }, { node_id: "other" }]) {
    const invalid = await env.call("submit_input", { ...env.input, ...patch });
    assert.equal(invalid.ok, false, JSON.stringify(invalid));
  }
  const result = await env.call("submit_input", env.input);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "completed");
  assert.equal(result.current_result.completed_nodes[0].outcome, "approved");
  assert.deepEqual(result.current_result.completed_nodes[0].result, { approved: true });
  assert.equal((await env.call("submit_input", env.input)).replayed, true);
  assert.equal((await env.call("submit_input", { ...env.input, response_json: '{"approved":false}' })).ok, false);
  assert.equal((await env.call("submit_input", { ...env.input, command_id: "second-approval" })).ok, false);
});

test("waiting gate survives host restart without approving or losing its challenge; rejection is explicit", async t => {
  const env = await setup(t);
  env.restart();
  const inspected = await env.call("get", { run_id: env.input.run_id });
  assert.equal(inspected.next_action.kind, "request_user_input", JSON.stringify(inspected));
  assert.equal(inspected.next_action.challenge_id, env.input.challenge_id);
  const result = await env.call("submit_input", { ...env.input, response_json: '{"approved":false}' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.current_result.completed_nodes[0].outcome, "rejected");
  assert.deepEqual(result.current_result.completed_nodes[0].result, { approved: false });
  env.restart();
  const final = await env.call("get", { run_id: env.input.run_id });
  assert.equal(final.status, "completed");
  assert.deepEqual(final.current_result.completed_nodes[0].result, { approved: false });
});

test("revoked gate authority rejects input without reserving or completing it", async t => {
  const env = await setup(t);
  env.revoke();
  await assert.rejects(env.call("submit_input", env.input), /authority changed/);
  assert.equal(env.database.prepare("SELECT count(*) AS n FROM legacy_recipe_lazy_receipts WHERE command_id=?")
    .get(env.input.command_id).n, 0);
});

test("public human input requires a fresh exact host decision; protocol bearer and agent report do not approve it", async t => {
  const env = await setup(t), operation = "mcp.tool.recipe_run_submit_input";
  const actor = { ...env.actor, recipeProtocol: true };
  await assert.rejects(env.publicApi.dispatch(operation, env.input, actor), /Fresh separate host approval/);
  const preview = await env.publicApi.previewLazy(env.binding, { operation, args: env.input });
  await env.publicApi.approveLazy(env.binding, { operation, args: env.input, previewDigest: preview.previewDigest });
  await assert.rejects(env.publicApi.dispatch(operation, { ...env.input,
    response_json: '{"approved":false}' }, actor), /Fresh separate host approval/);
  const progress = await env.call("progress", { run_id: env.input.run_id, node_id: "gate",
    command_id: "gate-human-wait-progress", progress_json: '{"message":"Still awaiting the user"}' });
  assert.equal(progress.next_action.kind, "request_user_input", JSON.stringify(progress));
  await assert.rejects(env.publicApi.dispatch(operation, env.input, actor), /state changed/);
  const fresh = await env.publicApi.previewLazy(env.binding, { operation, args: env.input });
  await env.publicApi.approveLazy(env.binding, { operation, args: env.input, previewDigest: fresh.previewDigest });
  const result = await env.publicApi.dispatch(operation, env.input, actor);
  assert.equal(result.status, "completed");
  assert.equal(result.current_result.completed_nodes[0].outcome, "approved");
  await assert.rejects(env.publicApi.dispatch(operation, env.input, actor), /Fresh separate host approval/);
});

test("accepted input journal survives interruption before completion, without permitting a different approval or replaying effects", async t => {
  const env = await setup(t);
  env.external.submitHumanInput = () => { throw Error("synthetic interruption after durable human input"); };
  const interrupted = await env.call("submit_input", env.input);
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.effect, "unknown");
  env.restart();
  const duplicate = await env.call("submit_input", env.input);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.effect, "unknown");
  assert.equal((await env.call("submit_input", { ...env.input,
    command_id: "replace-recorded-input", response_json: '{"approved":false}' })).ok, false);
  const resumed = await env.call("next", { run_id: env.input.run_id, command_id: "resume-journaled-human-input", detail: "full" });
  assert.equal(resumed.status, "completed", JSON.stringify(resumed));
  assert.deepEqual(resumed.current_result.completed_nodes[0].result, { approved: true });
});

test("human wait lease expiry releases the old challenge wait without converting it into an unknown external effect", async t => {
  const env = await setup(t), database = new DatabaseSync(":memory:");
  const epoch = Date.now() + 10000;
  let now = epoch;
  const external = new LegacyRecipeExternalReports({ id: "lease-human", authorizationDigest: "a".repeat(64),
    humanGates: true, authorizeDefinition: () => true });
  const host = new WorkflowExecutor(database, { workspaceRoot: env.binding.root, ownerId: "lease-host",
    adapters: { "pkm.gate.human/v1": external.adapter }, leaseMs: 40, clock: () => now });
  t.after(() => { host.close(); database.close(); });
  host.create(env.actor.id, { operationId: randomUUID(), runId: "gate-lease",
    source: { kind: "inline", definition: env.recipe.definition },
    expectedExecutableDigest: env.recipe.executableDigest, inputs: {}, deadline: epoch + 10000 });
  const waiting = host.tick(env.actor.id, "gate-lease");
  now = epoch + 41;
  const expired = await waiting;
  assert.equal(expired.state, "running", JSON.stringify(expired));
  assert.equal(expired.nodes[0].state, "pending");
  assert.equal(expired.nodes[0].effect, "not-started");
  const resumed = host.tick(env.actor.id, "gate-lease");
  await new Promise(resolve => setImmediate(resolve));
  external.submitHumanInput("gate-lease", "gate", external.validateHumanInput("gate-lease", "gate", { approved: false }));
  const final = await resumed;
  assert.equal(final.state, "succeeded", JSON.stringify(final));
  assert.equal(final.nodes[0].branch, "rejected");
});

for (const [config, response, outcome] of [
  [{ inputKind: "approval", prompt: "Explicit decision with supplemental evidence" },
    { approved: false, evidence: { origin: "synthetic-human" } }, "rejected"],
  [{ inputKind: "text", prompt: "Enter fixture evidence" }, { text: "verified", evidence: "synthetic" }, "succeeded"],
  [{ inputKind: "choice", choices: ["keep", "discard"], prompt: "Choose" }, { choice: "discard", evidence: "synthetic" }, "discard"],
]) test(`human ${config.inputKind} gate records only the configured submitted outcome`, async t => {
  const env = await setup(t, config);
  const result = await env.call("submit_input", { ...env.input, response_json: JSON.stringify(response) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.current_result.completed_nodes[0].outcome, outcome);
  assert.deepEqual(result.current_result.completed_nodes[0].result, response);
});
