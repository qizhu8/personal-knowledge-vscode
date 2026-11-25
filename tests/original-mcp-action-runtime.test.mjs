import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { createOriginalMcpNativeHost, originalMcpRequestDigest, withOriginalMcpPublicRequest } from "../dist/original-mcp-native-host.js";
import { createOriginalMcpActionRuntime, originalMcpActionOperationIds } from "../dist/original-mcp-action-runtime.js";
import { readActionCompiler } from "../dist/action-compiler.js";
import { actionComponents, builtinActionDefinitions, originalDefinitionValue, originalDigest } from "../dist/domain/action-compiler-validation.js";
import { pureComponentAdapter } from "../dist/action-pure-components.js";
import { appendOriginalActionValidation } from "../dist/original-mcp-action-validation.js";
import { originalActionCompilerFixtures } from "./action-compiler-original-fixtures.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const actor = { id: "mcp:external", canWrite: true };
const oracle = JSON.parse(await readFile(new URL("./fixtures/original-public-mcp-discovery.json", import.meta.url), "utf8"));
const actual = oracle.describes.map(item => JSON.parse(item.response.content[0].text));
const text = response => JSON.parse(response.content[0].text);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(work) {
  for (let i = 0; i < 400; i++) { const value = await work(); if (value) return value; await delay(10); }
  throw new Error("Native Action fixture did not settle.");
}
function controlAdapter(component) {
  const definition = actionComponents()[component];
  return {
    id: `native-fixture-${component}`, version: 1, outputContractDigest: originalDigest(definition.output_schema),
    authorizationDigest: originalDigest(definition),
    authorizeDefinition: binding => binding.actorId === actor.id && binding.step?.component === component
      && originalDigest(binding.definition) === originalDigest(definition),
    authorizeData: binding => binding.actorId === actor.id,
    async execute() { throw new Error("Intrinsic checkpoints must not execute a generic caller function."); },
  };
}
function checkpointDefinition({ component = "core.checkpoint", inputs, twice = false } = {}) {
  const schema = { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"], additionalProperties: false };
  const review = { id: "review", component, inputs: inputs ?? {
    kind: "approval", proposal: { $literal: { action: "continue", revision: "exact fixture" } }, answer_schema: { $literal: schema },
  } };
  return {
    schema: "pkm.action.definition/v1", action_id: "fixture.checkpoint", version: 1, description: "Exact durable fixture checkpoint.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    output_schema: { type: "object", properties: { value: {} }, required: ["value"], additionalProperties: false },
    dependencies: {}, effects: component === "core.wait" ? ["pure"] : ["human-input"],
    implementations: [{ id: "native", kind: "pipeline", platforms: ["Linux", "Windows", "Darwin"],
      steps: [review, ...(twice ? [{ ...review, id: "second", inputs: { ...review.inputs, proposal: { $step: "review.value" } } }] : [])],
      output: { value: { $step: twice ? "second.value" : "review.value" } } }],
    examples: [{ inputs: {} }],
  };
}
const processCode = "let s='';for await(const c of process.stdin)s+=c;const v=JSON.parse(s);await new Promise(r=>setTimeout(r,150));console.log(JSON.stringify({value:v.value}))";
async function fixture(t, options = {}) {
  const directory = resolve("tests", `.original-action-${randomUUID()}`), root = join(directory, "root"), cleanup = [];
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, ".pkm/state/actions/runs/old"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "notes/Entry.md"), "---\ntitle: Entry\n---\nOriginal source remains intact.\n", { mode: 0o600 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  const oldSettings = '{"implementation_bindings":{"fixture.checkpoint":"old-host"},"permission":"not a grant"}';
  await writeFile(join(root, ".pkm/state/actions/settings.json"), oldSettings, { mode: 0o600 });
  await writeFile(join(root, ".pkm/state/actions/runs/old/run.json"),
    '{"run_id":"old","state":"running","worker_pid":1,"resume_token":"not-authority"}', { mode: 0o600 });
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    await rm(directory, { recursive: true, force: true });
  });
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"),
    operatorId: "native-action-fixture", profileSha256: hash("native-action-profile"),
    limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16_777_216, maxFileBytes: 8_388_608 } });
  let host, policy, allowed = true, current = true, publicHook;
  const lifetime = new AbortController(), approvals = [];
  const builtin = builtinActionDefinitions().get("core.cast.string-to-float");
  const pure = pureComponentAdapter("action:core.cast.string-to-float", originalDigest(builtin.output_schema));
  assert(pure);
  const prepareNative = async storage => {
    policy = {
      profileSha256: plan.profileSha256, sourceCatalogSha256: oracle.metadataSha256, authorityId: "synthetic-native-action-profile",
      epoch: "synthetic-native-epoch", signal: lifetime.signal,
      assertCurrent() { if (!current) throw new Error("Revoked native profile."); },
      async authorizeAdmission() { return true; },
      async authorizePublic(request) { approvals.push(request); await publicHook?.(request); return allowed; },
      models: { configuration: { aiEndpoint: "https://not-invoked.invalid/v1", aiModel: "not-invoked" }, registryAvailability: {},
        async credentialAvailable() { return false; }, async authorizeRequest() { return false; },
        transport: { supports: () => false, async open() { throw new Error("No model dispatch in Action control tests."); } } },
    };
    host = await createOriginalMcpNativeHost(storage, policy);
    return { ...(options.noEngine ? {} : { hostServices: { action: {
      adapters: { "component:core.checkpoint": controlAdapter("core.checkpoint"), "component:core.wait": controlAdapter("core.wait"),
        "action:core.cast.string-to-float": options.slowPure ? { ...pure, async execute(invocation, context) {
          await delay(100); return pure.execute(invocation, context);
        } } : pure,
        "component:core.constant": pureComponentAdapter("component:core.constant", originalDigest(actionComponents()["core.constant"].output_schema)) },
      process: { commands: [{ id: "fixture", executable: process.execPath, cwd: root, directChildOnly: true,
        arguments: [{ literal: "--input-type=module" }, { literal: "-e" }, { literal: processCode }],
        outputContractDigest: originalDigest(originalActionCompilerFixtures.example.output_schema), authorizationDigest: hash("native fixture echo"),
        authorizeDefinition: binding => binding.actorId === actor.id && binding.actionId === "fixture.echo",
        authorizeData: binding => binding.actorId === actor.id,
        approve: async () => true, redactOutput: output => ({ value: output.value }) }],
      limits: { graceMs: 20, closeDrainMs: 200 } },
    } } }) };
  };
  const opened = await openOriginalMcpRoot(plan, { prepareNative });
  cleanup.push(() => opened.owner.close());
  const full = await opened.owner.ensureFull();
  const adapter = await createOriginalMcpActionRuntime(opened.owner, actor, host);
  cleanup.push(() => adapter.close());
  const invoke = async (tool, args = {}, signal) => {
    const result = await adapter.invoke(tool, args, signal);
    assert.deepEqual(result.structuredContent, text(result), "Original structured and text payloads agree.");
    return result.structuredContent;
  };
  const core = async (operation, args, principal = actor) => {
    const response = await full.runtime.core.dispatch(operation === "action.runtime.create" || operation === "action.runtime.cancel"
      ? "capability_call" : "capability_read", { operation, version: 1, arguments: args }, principal);
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result;
  };
  const create = async definition => {
    const source = { kind: "inline", definition: JSON.parse(JSON.stringify(definition)) };
    const compiled = readActionCompiler({ operation: "action.definition.compile", args: { source } });
    assert.equal(compiled.status, "valid", JSON.stringify(compiled));
    const run = await core("action.runtime.create", { operationId: randomUUID(), runId: `run-${randomUUID()}`, source,
      expectedDefinitionDigest: compiled.definitionDigest, deadline: Date.now() + 30_000, inputs: definition.action_id === "fixture.echo" ? { value: "actual echo" } : {} });
    return run;
  };
  return { ...opened, full, root, plan, host, adapter, invoke, core, create, builtin: originalDefinitionValue(builtin), cleanup,
    oldSettings, approvals, prepareNative, nativeHost: () => host, policy: () => policy, setPublicHook: value => { publicHook = value; },
    setAllowed: value => { allowed = value; }, setCurrent: value => { current = value; } };
}
async function waiting(f, definition = checkpointDefinition()) {
  const run = await f.create(definition);
  await until(async () => (await f.core("action.runtime.get", { runId: run.runId })).state === "waiting");
  const checkpoint = (await f.invoke("action_run_checkpoints", { run_id: run.runId })).checkpoints[0];
  return { run, checkpoint };
}
const answer = (run, checkpoint, replacement = {}) => ({ run_id: run.runId, checkpoint_id: checkpoint.checkpoint_id,
  resume_token: checkpoint.resume_token, proposal_digest: checkpoint.proposal_digest, answer: { approved: true },
  event_key: "fixture-answer", ...replacement });

test("local Action adapter pins genuine actual151 IDs, owner, actor and fresh native public approvals", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.adapter.operationIds, originalMcpActionOperationIds);
  for (const id of f.adapter.operationIds) assert(actual.some(item => item.id === id), id);
  const lease = { ...f.owner.workspaceLease() };
  const { run } = await waiting(f);
  assert.equal((await f.invoke("action_run_wait", { run_id: run.runId, wait_seconds: 0 })).wait_expired, true);
  await assert.rejects(createOriginalMcpActionRuntime({}, actor, f.host), { code: "STORAGE_UNAVAILABLE" });
  await assert.rejects(createOriginalMcpActionRuntime(f.owner, { id: "other", canWrite: true }, f.host), { code: "ACCESS_DENIED" });
  const other = await fixture(t);
  await assert.rejects(createOriginalMcpActionRuntime(f.owner, actor, other.host), { code: "ACCESS_DENIED" });
  const readonly = await createOriginalMcpActionRuntime(f.owner, { ...actor, canWrite: false }, f.host); f.cleanup.push(() => readonly.close());
  await assert.rejects(readonly.invoke("action_run_cancel", { run_id: run.runId }), { code: "ACCESS_DENIED" });
  await assert.rejects(f.invoke("action_run_events", { run_id: run.runId, after_sequence: -1 }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(f.invoke("action_run_events", { run_id: run.runId, legacy_worker_token: "old" }), { code: "INVALID_ARGUMENT" });
  f.setAllowed(false);
  await assert.rejects(f.invoke("action_run_cancel", { run_id: run.runId }), { code: "ACCESS_DENIED" });
  assert.equal((await f.core("action.runtime.get", { runId: run.runId })).state, "waiting");
  f.setAllowed(true);
  const cancelled = await f.invoke("action_run_cancel", { run_id: run.runId });
  assert.equal(cancelled.cancel_requested, true); assert.equal(cancelled.remote_rollback, false);
  assert.equal((await f.core("action.runtime.get", { runId: run.runId })).state, "cancelled");
  assert.deepEqual(f.owner.workspaceLease(), lease);
  assert.equal(await readFile(join(f.root, ".pkm/state/actions/settings.json"), "utf8"), f.oldSettings);
});

test("real checkpoint answers bind exact tokens, proposal, schema and original Run; no answer grants effect permission", async t => {
  const f = await fixture(t), { run, checkpoint } = await waiting(f, checkpointDefinition({ twice: true }));
  const oldVersion = (await f.core("action.runtime.get", { runId: run.runId })).version;
  await assert.rejects(f.invoke("action_checkpoint_respond", answer(run, checkpoint, { resume_token: "old" })), { code: "ACCESS_DENIED" });
  await assert.rejects(f.invoke("action_checkpoint_respond", answer(run, checkpoint, { proposal_digest: hash("different") })), { code: "ACCESS_DENIED" });
  await assert.rejects(f.invoke("action_checkpoint_respond", answer(run, checkpoint, { answer: { approved: "yes" } })), { code: "INVALID_ARGUMENT" });
  assert.equal((await f.core("action.runtime.get", { runId: run.runId })).version, oldVersion);
  assert.equal((await f.invoke("action_checkpoint_respond", answer(run, checkpoint))).replayed, false);
  await until(async () => (await f.invoke("action_run_checkpoints", { run_id: run.runId })).checkpoints[0]?.step === "second");
  const history = (await f.invoke("action_run_checkpoints", { run_id: run.runId, include_history: true })).checkpoints;
  assert.equal(history.length, 2);
  assert.equal(history[0].state, "resolved"); assert.deepEqual(history[1].proposal, { approved: true });
  await assert.rejects(f.invoke("action_checkpoint_respond", answer(run, checkpoint)), { code: "CONFLICT" });
  assert.equal((await f.invoke("action_checkpoint_respond", answer(run, history[1]))).replayed, false);
  await until(async () => (await f.core("action.runtime.get", { runId: run.runId })).state === "succeeded");
  assert.deepEqual((await f.invoke("action_run_wait", { run_id: run.runId, wait_seconds: 0 })).output, { value: { approved: true } });
  assert.equal((await f.invoke("action_checkpoint_respond", answer(run, history[1]))).replayed, true);
  await assert.rejects(f.invoke("action_checkpoint_respond", answer(run, history[1], { answer: { approved: false } })), { code: "CONFLICT" });
  const database = f.storage.connectNative();
  try {
    assert.equal(database.prepare("SELECT count(*) n FROM action_runtime_runs WHERE actor_id=?").get(actor.id).n, 1);
    assert.equal(database.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n, 0);
  } finally { database.close(); }
});

test("native approval reuse requires the exact host and arguments, and caller mutations cannot change the approved request", async t => {
  const f = await fixture(t), first = await waiting(f), second = await waiting(f);
  const tool = "action_run_events", args = { run_id: first.run.runId };
  const approval = { operation: `mcp.tool.${tool}`, version: 1, tool, readOnly: true, arguments: args, argumentsDigest: originalMcpRequestDigest(args) };
  let before = f.approvals.length;
  await withOriginalMcpPublicRequest(f.storage, f.host, approval, () => f.adapter.invoke(tool, args));
  assert.equal(f.approvals.length - before, 1, "An exact outer native scope is reused once.");
  before = f.approvals.length;
  await withOriginalMcpPublicRequest(f.storage, f.host, approval, () => f.adapter.invoke(tool, { run_id: second.run.runId }));
  assert.equal(f.approvals.length - before, 2, "Same tool but different arguments requires its own approval.");
  const otherHost = await createOriginalMcpNativeHost(f.storage, { ...f.policy(), authorityId: "another-fixture-native-host" });
  f.cleanup.push(() => otherHost.close());
  before = f.approvals.length;
  await withOriginalMcpPublicRequest(f.storage, otherHost, approval, () => f.adapter.invoke(tool, args));
  assert.equal(f.approvals.length - before, 2, "Another branded host cannot lend an approval.");
  const caller = { run_id: first.run.runId };
  f.setPublicHook(() => { caller.run_id = second.run.runId; });
  await f.adapter.invoke("action_run_cancel", caller);
  f.setPublicHook(undefined);
  assert.equal((await f.core("action.runtime.get", { runId: first.run.runId })).state, "cancelled");
  assert.equal((await f.core("action.runtime.get", { runId: second.run.runId })).state, "waiting");
});

test("all five intrinsic human checkpoint kinds complete with actual typed answers", async t => {
  const f = await fixture(t);
  for (const kind of ["input", "approval", "artifact-review", "decision", "exception"]) {
    const definition = checkpointDefinition();
    definition.implementations[0].steps[0].inputs.kind = kind;
    const { run, checkpoint } = await waiting(f, definition);
    assert.equal(checkpoint.kind, kind);
    await f.invoke("action_checkpoint_respond", answer(run, checkpoint));
    const result = await f.invoke("action_run_wait", { run_id: run.runId, wait_seconds: 1 });
    assert.equal(result.state, "succeeded");
    assert.deepEqual(result.output, { value: { approved: true } });
  }
});

test("event wait, deduplicated wake, timer scan and checkpoint expiry have real canonical effects", async t => {
  const f = await fixture(t);
  const { run, checkpoint } = await waiting(f, checkpointDefinition({ component: "core.wait", inputs: {
    trigger: { $literal: { kind: "event", name: "fixture-ready" } },
  } }));
  await assert.rejects(f.invoke("action_checkpoint_respond", answer(run, checkpoint)), { code: "ACCESS_DENIED" });
  await assert.rejects(f.invoke("action_run_wake", { run_id: run.runId, event_key: "one", event_name: "wrong" }), { code: "CONFLICT" });
  assert.equal((await f.invoke("action_run_wake", { run_id: run.runId, event_key: "one", event_name: "fixture-ready" })).replayed, false);
  assert.equal((await f.invoke("action_run_wake", { run_id: run.runId, event_key: "one", event_name: "fixture-ready" })).replayed, true);
  await assert.rejects(f.invoke("action_run_wake", { run_id: run.runId, event_key: "two", event_name: "fixture-ready" }), { code: "CONFLICT" });
  await until(async () => (await f.core("action.runtime.get", { runId: run.runId })).state === "succeeded");
  const timer = await waiting(f, checkpointDefinition({ component: "core.wait", inputs: {
    trigger: { $literal: { kind: "timer", at: Date.now() / 1000 - 1 } },
  } }));
  await f.invoke("action_run_safety_scan", { limit: 8 });
  await until(async () => (await f.core("action.runtime.get", { runId: timer.run.runId })).state === "succeeded");
  const dependency = await waiting(f, checkpointDefinition({ component: "core.wait", inputs: {
    trigger: { $literal: { kind: "dependency", run_id: timer.run.runId, expected_version: 1 } },
  } }));
  const resolved = await f.invoke("action_run_wait", { run_id: dependency.run.runId, wait_seconds: 1 });
  assert.equal(resolved.state, "succeeded");
  assert.deepEqual(resolved.output, { value: { run_id: timer.run.runId } });
  const cancelled = await waiting(f);
  await f.invoke("action_run_cancel", { run_id: cancelled.run.runId });
  const blocked = await waiting(f, checkpointDefinition({ component: "core.wait", inputs: {
    trigger: { $literal: { kind: "dependency", run_id: cancelled.run.runId, expected_version: 1 } },
  } }));
  assert((await f.invoke("action_run_safety_scan", { limit: 32 })).reviewed.includes(blocked.run.runId));
  assert.equal((await f.core("action.runtime.get", { runId: blocked.run.runId })).state, "unknown");
  for (const behavior of ["review", "cancel"]) {
    const expired = await waiting(f, checkpointDefinition({ inputs: { kind: "decision", proposal: {}, deadline: Date.now() / 1000 - 1,
      timeout_behavior: behavior } }));
    await assert.rejects(f.invoke("action_checkpoint_respond", answer(expired.run, expired.checkpoint)), { code: "CONFLICT" });
    assert((await f.invoke("action_run_safety_scan", { limit: 32 })).reviewed.includes(expired.run.runId));
    assert.equal((await f.core("action.runtime.get", { runId: expired.run.runId })).state, behavior === "review" ? "unknown" : "cancelled");
  }
});

test("original event retention exposes real gaps instead of silently dropping a durable cursor", async t => {
  const f = await fixture(t), definition = checkpointDefinition();
  definition.effects = ["pure"];
  definition.implementations[0].steps = Array.from({ length: 130 }, (_, index) => ({
    id: `number-${index}`, component: "core.constant", implementation: "javascript", inputs: { value: index },
  }));
  definition.implementations[0].output = { value: { $step: "number-129.value" } };
  const run = await f.create(definition);
  await until(async () => (await f.core("action.runtime.get", { runId: run.runId })).state === "succeeded");
  const page = await f.invoke("action_run_events", { run_id: run.runId, after_sequence: 0 });
  assert.equal(page.events.length, 256); assert.equal(page.gap, true);
  assert.equal(page.events.at(-1).sequence, page.next_sequence);
  assert.deepEqual((await f.invoke("action_run_events", { run_id: run.runId, after_sequence: page.next_sequence })).events, []);
});

test("original event replay has retained cursors and aborting wait never cancels the canonical Run", async t => {
  const f = await fixture(t), { run } = await waiting(f);
  const page = await f.invoke("action_run_events", { run_id: run.runId, after_sequence: 0 });
  assert(page.events.some(item => item.kind === "checkpoint-created"));
  assert.deepEqual(await f.invoke("action_run_events", { run_id: run.runId, after_sequence: 0 }), page);
  const update = await f.invoke("action_run_wait", { run_id: run.runId, after_sequence: 0, wait_seconds: 30 });
  assert.equal(update.event_update, true); assert.equal(update.completed, false);
  const abort = new AbortController();
  const pending = f.invoke("action_run_wait", { run_id: run.runId, wait_seconds: 30, after_sequence: page.next_sequence }, abort.signal);
  setTimeout(() => abort.abort(), 20);
  await assert.rejects(pending, error => error.name === "AbortError");
  assert.equal((await f.core("action.runtime.get", { runId: run.runId })).state, "waiting");
  await assert.rejects(f.invoke("action_run_wait", { run_id: run.runId, wait_seconds: 301 }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(f.core("action.runtime.events", { runId: run.runId, after: 0, limit: 100 }, { id: "other", canWrite: true }), { code: "NOT_FOUND" });
  const draining = assert.rejects(f.invoke("action_run_wait", { run_id: run.runId, wait_seconds: 30, after_sequence: page.next_sequence }),
    error => error.name === "AbortError" || ["CLOSED", "ACCESS_DENIED"].includes(error.code));
  await f.adapter.close(); await draining;
  assert.equal((await f.core("action.runtime.get", { runId: run.runId })).state, "waiting", "Closing this adapter does not cancel or close the canonical engine.");
});

test("builtin validation executes real canonical examples, stores evidence and cannot self-admit old or effectful code", async t => {
  const f = await fixture(t);
  const result = await f.invoke("action_validate", { action_id: f.builtin.action_id, content_hash: f.builtin.content_hash });
  assert.equal(result.status, "passed"); assert(result.evidence.length > 0);
  for (const proof of result.evidence) {
    assert.equal((await f.core("action.runtime.get", { runId: proof.run_id })).state, "succeeded"); assert.equal(proof.passed, true);
  }
  const status = await f.invoke("action_validation_status");
  assert(status.jobs.some(job => job.state === "succeeded" && job.evidence.length === result.evidence.length));
  await assert.rejects(f.invoke("action_validate", { action_id: f.builtin.action_id, content_hash: hash("stale") }), { code: "CONFLICT" });
  await assert.rejects(f.invoke("action_validation_enqueue", { action_id: "old.custom", content_hash: hash("old"), allow_effects: true }),
    /ACTION_CODE_REVIEW_REQUIRED/);
  const effectful = originalDefinitionValue(builtinActionDefinitions().get("core.artifact.copy"));
  await assert.rejects(f.invoke("action_validation_enqueue", { action_id: effectful.action_id, content_hash: effectful.content_hash, allow_effects: true }),
    /ACTION_EFFECT_CONSENT_REQUIRED/);
  const enqueued = await f.invoke("action_validation_enqueue", { action_id: f.builtin.action_id, content_hash: f.builtin.content_hash, priority: "idle" });
  await until(async () => (await f.invoke("action_validation_status")).jobs.find(job => job.job_id === enqueued.job_id)?.state === "succeeded");
  assert.equal((await f.invoke("action_validation_cancel", { job_id: enqueued.job_id })).remote_rollback, false);
});

test("one durable validation worker deduplicates demand, cancels active qualification and does not replay uncertain work", async t => {
  const f = await fixture(t, { slowPure: true });
  const first = await f.invoke("action_validation_enqueue", { action_id: f.builtin.action_id, content_hash: f.builtin.content_hash, priority: "idle" });
  const second = await f.invoke("action_validation_enqueue", { action_id: f.builtin.action_id, content_hash: f.builtin.content_hash, priority: "demand" });
  assert.equal(first.job_id, second.job_id);
  const cancelled = await f.invoke("action_validation_cancel", { job_id: first.job_id });
  assert.equal(cancelled.remote_rollback, false);
  assert(cancelled.job.cancel_requested || cancelled.job.state === "cancelled");
  await until(async () => ["cancelled", "outcome_unknown"].includes(
    (await f.invoke("action_validation_status")).jobs.find(job => job.job_id === first.job_id).state));
  const db = f.storage.connectNative();
  let runs;
  try { runs = db.prepare("SELECT count(*) n FROM action_runtime_runs").get().n; } finally { db.close(); }
  await f.invoke("action_validation_resume");
  await delay(50);
  const after = f.storage.connectNative();
  try {
    assert.equal(after.prepare("SELECT count(*) n FROM action_runtime_runs").get().n, runs);
    appendOriginalActionValidation(after, f.workspaceId, { job_id: `validation_${"b".repeat(32)}`, key: "durably-queued-native-pure",
      action_id: f.builtin.action_id, content_hash: f.builtin.content_hash, priority: 0, allow_effects: false, queued_at: 1,
      state: "queued", stage: "queued", depends_on: [] });
  } finally { after.close(); }
  await f.invoke("action_validation_resume");
  await until(async () => (await f.invoke("action_validation_status")).jobs.find(job => job.key === "durably-queued-native-pure").state === "succeeded");
});

test("canonical-owner restart preserves checkpoints and selection without replaying prior native work", async t => {
  const f = await fixture(t), { run, checkpoint } = await waiting(f);
  const definition = structuredClone(originalActionCompilerFixtures.example);
  definition.action_id = "fixture.echo";
  definition.implementations = ["first", "second"].map(id => ({ id, kind: "program", platforms: ["Linux", "Windows", "Darwin"],
    program: "fixture", args: ["--input-type=module", "-e", processCode] }));
  const source = { kind: "inline", definition }, compiled = readActionCompiler({ operation: "action.definition.compile", args: { source } });
  f.full.runtime.services.hostServices.actionRuntime.selectImplementation(actor.id, source, compiled.definitionDigest, "second");
  await f.adapter.close(); await f.owner.close();
  const reopened = await openOriginalMcpRoot(f.plan, { prepareNative: f.prepareNative });
  f.cleanup.push(() => reopened.owner.close());
  const full = await reopened.owner.ensureFull();
  const adapter = await createOriginalMcpActionRuntime(reopened.owner, actor, f.nativeHost());
  f.cleanup.push(() => adapter.close());
  assert.deepEqual(text(await adapter.invoke("action_run_checkpoints", { run_id: run.runId })).checkpoints[0], checkpoint);
  await delay(30);
  const before = reopened.storage.connectNative();
  try { assert.equal(before.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n, 0); } finally { before.close(); }
  await adapter.invoke("action_checkpoint_respond", answer(run, checkpoint));
  assert.deepEqual(text(await adapter.invoke("action_run_wait", { run_id: run.runId, wait_seconds: 1 })).output, { value: { approved: true } });
  const created = await full.runtime.core.dispatch("capability_call", { operation: "action.runtime.create", version: 1, arguments: {
    operationId: randomUUID(), runId: `run-${randomUUID()}`, source, expectedDefinitionDigest: compiled.definitionDigest,
    deadline: Date.now() + 30_000, inputs: { value: "after restart" },
  } }, actor);
  assert.equal(created.error, undefined);
  assert.deepEqual(text(await adapter.invoke("action_run_wait", { run_id: created.result.runId, wait_seconds: 1 })).output, { value: "after restart" });
  const after = reopened.storage.connectNative();
  try {
    assert.equal(JSON.parse(after.prepare("SELECT snapshot FROM action_runtime_runs WHERE run_id=?").get(created.result.runId).snapshot).implementation.id, "second");
    assert.equal(after.prepare("SELECT count(*) n FROM action_runtime_runs").get().n, 2);
    assert.equal(after.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n, 1);
  } finally { after.close(); }
});

test("implementation selection is actor/revision scoped, durable, compatible and changes actual engine choice", async t => {
  const f = await fixture(t), definition = structuredClone(originalActionCompilerFixtures.example);
  definition.action_id = "fixture.echo";
  definition.implementations = ["first", "second"].map(id => ({ id, kind: "program", platforms: ["Linux", "Windows", "Darwin"],
    program: "fixture", args: ["--input-type=module", "-e", processCode] }));
  const source = { kind: "inline", definition }, compiled = readActionCompiler({ operation: "action.definition.compile", args: { source } });
  const engine = f.full.runtime.services.hostServices.actionRuntime;
  await assert.rejects(f.create(definition), { code: "CONFLICT" });
  assert.throws(() => engine.selectImplementation(actor.id, source, compiled.definitionDigest, "missing"), { code: "INVALID_ARGUMENT" });
  engine.selectImplementation(actor.id, source, compiled.definitionDigest, "second");
  const run = await f.create(definition);
  const db = f.storage.connectNative();
  try { assert.equal(JSON.parse(db.prepare("SELECT snapshot FROM action_runtime_runs WHERE run_id=?").get(run.runId).snapshot).implementation.id, "second"); }
  finally { db.close(); }
  await until(async () => (await f.core("action.runtime.get", { runId: run.runId })).state === "succeeded");
  const result = engine.getOwnedResult(actor.id, run.runId, compiled.definition);
  assert.deepEqual(result, { value: "actual echo" });
  const pipeline = checkpointDefinition();
  pipeline.action_id = "fixture.pipeline-choice"; pipeline.effects = ["pure"];
  pipeline.implementations = ["one", "two"].map((id, index) => ({ id, kind: "pipeline", platforms: ["Linux", "Windows", "Darwin"],
    steps: [{ id: "number", component: "core.constant", implementation: "javascript", inputs: { value: index } }],
    output: { value: { $step: "number.value" } } }));
  const pipelineSource = { kind: "inline", definition: pipeline };
  const pipelineCompiled = readActionCompiler({ operation: "action.definition.compile", args: { source: pipelineSource } });
  engine.selectImplementation(actor.id, pipelineSource, pipelineCompiled.definitionDigest, "two");
  const pipelineRun = await f.create(pipeline);
  assert.deepEqual((await f.invoke("action_run_wait", { run_id: pipelineRun.runId, wait_seconds: 1 })).output, { value: 1 });
  const selected = await f.invoke("action_implementation_select", { action_id: f.builtin.action_id, implementation_id: f.builtin.implementations[0].id });
  assert.equal(selected.ok, true);
  await assert.rejects(f.invoke("action_implementation_select", { action_id: "old.custom", implementation_id: "old-host" }), /ACTION_SOURCE_ADMISSION_REQUIRED/);
});

test("recovery preserves current owned workers, fences abandoned effects and never replays old validation or archived runs", async t => {
  const f = await fixture(t), definition = structuredClone(originalActionCompilerFixtures.example);
  definition.action_id = "fixture.echo"; definition.implementations[0] = { id: "native", kind: "program",
    platforms: ["Linux", "Windows", "Darwin"], program: "fixture", args: ["--input-type=module", "-e", processCode] };
  const run = await f.create(definition);
  await until(async () => (await f.core("action.runtime.get", { runId: run.runId })).state === "running");
  assert(!(await f.invoke("action_run_recover")).reconciled.includes(run.runId));
  await until(async () => (await f.core("action.runtime.get", { runId: run.runId })).state === "succeeded");
  const db = f.storage.connectNative();
  try {
    const row = db.prepare("SELECT snapshot FROM action_runtime_runs WHERE run_id=?").get(run.runId), snapshot = JSON.parse(row.snapshot);
    snapshot.state = "running"; snapshot.nodes[0].state = "running"; snapshot.nodes[0].outputs = undefined;
    db.prepare("UPDATE action_runtime_runs SET snapshot=? WHERE run_id=?").run(JSON.stringify(snapshot), run.runId);
    appendOriginalActionValidation(db, f.workspaceId, { job_id: `validation_${"a".repeat(32)}`, key: "old-native-runtime",
      action_id: f.builtin.action_id, content_hash: f.builtin.content_hash, priority: 0, allow_effects: false, queued_at: 1,
      state: "running", stage: "test", depends_on: [], worker: "dead-native-epoch", run_id: run.runId });
  } finally { db.close(); }
  assert((await f.invoke("action_run_recover")).reconciled.includes(run.runId));
  assert.equal((await f.core("action.runtime.get", { runId: run.runId })).state, "unknown");
  assert.equal((await f.invoke("action_validation_status")).jobs.find(job => job.key === "old-native-runtime").state, "outcome_unknown");
  await f.invoke("action_validation_resume");
  await delay(30);
  const current = f.storage.connectNative();
  try {
    assert.equal(current.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n, 1);
    assert.equal(current.prepare("SELECT count(*) n FROM action_runtime_runs").get().n, 1);
  } finally { current.close(); }
  assert.match(await readFile(join(f.root, ".pkm/state/actions/runs/old/run.json"), "utf8"), /not-authority/);
});

test("missing canonical native Action policy never becomes an empty successful status or recovered history", async t => {
  const f = await fixture(t, { noEngine: true });
  for (const tool of ["action_validation_status", "action_run_recover", "action_validation_resume"])
    await assert.rejects(f.invoke(tool), /ACTION_NATIVE_ENGINE_REQUIRED/);
  await assert.rejects(f.invoke("action_cosmos_configure", { bindings: [] }), /ACTION_NATIVE_ENGINE_REQUIRED/);
  f.setCurrent(false);
  await assert.rejects(f.invoke("action_run_recover"), { code: "ACCESS_DENIED" });
});
