import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { createOriginalMcpActionCustodyFixture } from "./original-mcp-action-domain-fixture.mjs";

process.env.PKM_ACTION_SOURCE_IDENTITY = "frozen-original-v2";
const [{ openOriginalMcpRoot }, { createOriginalMcpNativeHost }, domain,
  { createOriginalMcpActionRuntime }, { originalDigest }] = await Promise.all([
  import("../dist/original-mcp-root.js"), import("../dist/original-mcp-native-host.js"), import("../dist/original-mcp-action-domain.js"),
  import("../dist/original-mcp-action-runtime.js"), import("../dist/domain/action-compiler-validation.js"),
]);
const hash = value => createHash("sha256").update(value).digest("hex");
const actor = { id: "mcp:external", canWrite: true };
const oracle = JSON.parse(await readFile(new URL("./fixtures/original-public-mcp-discovery.json", import.meta.url), "utf8"));
const value = response => response.structuredContent;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, options = {}) {
  const { directory, root, cleanup, old, moduleRaw, plan, selection, custody, oldSettings } =
    await createOriginalMcpActionCustodyFixture(t, options);
  let allowed = true, typedDecisions = true, trusted = true, current = true, host, nativePolicy, authority, opened;
  let effectsAllowed = true, effectHook, statusHook;
  const reviews = [], effects = [], lifetime = new AbortController();
  const prepareNative = async storage => {
    await domain.declareOriginalMcpActionNativeFootprint(storage, custody);
    const epoch = randomUUID(), token = randomBytes(32).toString("hex"), sockets = new Set();
    const server = createServer(socket => {
      sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.setEncoding("utf8");
      let input = "";
      socket.on("data", async data => {
        input += data; if (!input.includes("\n")) return;
        const request = JSON.parse(input.slice(0, input.indexOf("\n")));
        assert.equal(request.storePath, root); assert.equal(request.token, token);
        if (request.operation === "status") await statusHook?.();
        const base = { ok: trusted, trusted, trustEpoch: epoch };
        if (request.operation === "effect_consent") {
          assert.equal(request.trustEpoch, epoch);
          assert.equal(request.effectContext.kind, "pipeline");
          assert.match(request.effectContext.inputDigest, /^[a-f0-9]{64}$/);
          const binding = JSON.parse(request.effectContext.inputPreview);
          assert.equal(originalDigest(binding), request.effectContext.inputDigest);
          assert.equal(binding.automaticReplay, false);
          assert.equal(binding.capsuleSha256, custody.capsuleSha256);
          effects.push(binding); await effectHook?.();
          socket.end(`${JSON.stringify({ ...base, ok: effectsAllowed && trusted, trusted,
            consented: effectsAllowed, ...(!effectsAllowed ? { reason: "EFFECT_CONSENT_DENIED" } : {}) })}\n`);
          return;
        }
        if (request.operation !== "source_admission") { socket.end(`${JSON.stringify(base)}\n`); return; }
        const binding = request.sourceAdmission;
        assert.equal(binding.schema, "pkm.native-action-source-request/v1");
        assert.equal(binding.root, root); assert.equal(binding.capsuleSha256, custody.capsuleSha256);
        assert.equal(binding.profileSha256, plan.profileSha256); assert.equal(binding.epoch, epoch);
        assert.equal(binding.actorId, "mcp:external"); assert.equal(binding.noExecution, true);
        assert.match(binding.requestSha256, /^[a-f0-9]{64}$/);
        reviews.push(binding);
        socket.end(`${JSON.stringify({ ...base, ok: allowed && trusted, consented: true, ...(allowed && trusted && typedDecisions ? {
          sourceDecision: { schema: "pkm.native-action-source-decision/v1", scope: "original-action-source-state/v1",
            root, workspaceId: binding.workspaceId, actorId: binding.actorId, profileSha256: binding.profileSha256,
            epoch, capsuleSha256: binding.capsuleSha256, requestSha256: binding.requestSha256, noExecution: true,
            decisionId: `source-review-${randomUUID()}`, expiresAtMs: Date.now() + 60_000 },
        } : {}) })}\n`);
      });
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = server.address();
    await mkdir(join(root, ".pkm-action-authority"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, ".pkm-action-authority/host-authority.json"), JSON.stringify({
      schema: "pkm.action.host-authority/v1", host: "127.0.0.1", port: endpoint.port, token, trust_epoch: epoch, store_path: root,
    }), { mode: 0o600 });
    authority = { async dispose() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
    const owned = authority; cleanup.push(() => owned.dispose());
    const configuration = JSON.parse(await readFile(join(root, ".pkm-action-authority/host-authority.json"), "utf8"));
    host = await createOriginalMcpNativeHost(storage, {
      profileSha256: plan.profileSha256, sourceCatalogSha256: oracle.metadataSha256,
      authorityId: "native-action-fixture-current-profile", epoch: options.wrongEpoch ? "model-only-not-Action" : configuration.trust_epoch,
      signal: lifetime.signal, assertCurrent() { if (!current) throw new Error("Native profile revoked."); },
      async authorizeAdmission() { return true; }, async authorizePublic() { return true; },
      models: { configuration: { aiEndpoint: "https://not-called.invalid/v1", aiModel: "not-called" }, registryAvailability: {},
        async credentialAvailable() { return false; }, async authorizeRequest() { return false; },
        transport: { supports: () => false, async open() { throw new Error("Model grant cannot grant Action authority."); } } },
    });
    if (options.noPolicy) return { hostServices: { action: { adapters: {} } } };
    nativePolicy = await domain.createOriginalMcpActionNativePolicy(storage, host, custody);
    return nativePolicy.options;
  };
  const start = async () => {
    opened = await openOriginalMcpRoot(plan, { prepareNative }); cleanup.push(() => opened.owner.close());
    const full = await opened.owner.ensureFull();
    const adapter = await createOriginalMcpActionRuntime(opened.owner, actor, host);
    cleanup.push(() => adapter.close());
    return { ...opened, full, adapter, host, nativePolicy };
  };
  return { directory, root, plan, custody, selection, old, moduleRaw, oldSettings, start, reviews, effects, cleanup,
    setAllowed: value => { allowed = value; }, setTrusted: value => { trusted = value; },
    setTypedDecisions: value => { typedDecisions = value; },
    setEffectsAllowed: value => { effectsAllowed = value; }, setEffectHook: value => { effectHook = value; },
    setStatusHook: value => { statusHook = value; },
    setCurrent: value => { current = value; } };
}
const call = async (running, tool, args = {}) => value(await running.adapter.invoke(tool, args));
const invokeArgs = (definition, key, inputs = {}) => ({ action_id: definition.action_id,
  content_hash: definition.content_hash, inputs, idempotency_key: key });
async function settled(running, id, state) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const run = await call(running, "action_run_get", { run_id: id });
    if (run.state === state) return run;
    await pause(10);
  }
  throw new Error(`Native invocation ${id} did not reach ${state}.`);
}
function counts(running) {
  const database = running.storage.connectNative();
  try {
    return { runs: database.prepare("SELECT count(*) n FROM action_runtime_runs").get().n,
      processes: database.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n };
  } finally { database.close(); }
}

test("selected Action B0 really backs auxiliary sources, ModuleSets and executable bytes without a whole-root size gate", async t => {
  const f = await fixture(t, { large: true });
  assert.equal((await stat(join(f.root, "action-sources/unselected-large.bin"))).size, 25 * 1024 ** 3);
  assert(!f.custody.files.some(file => file.path.endsWith("unselected-large.bin")));
  const proof = f.custody.toolchains[0], saved = f.custody.files.find(file => file.path === proof.capsulePath);
  assert.equal(hash(await readFile(join(f.custody.backup, "blobs", saved.blob))), proof.sha256);
  await assert.rejects(domain.captureOriginalMcpActionCustody(f.plan, { backup: join(f.directory, "bad-toolchain"),
    selection: { ...f.selection, toolchains: [{ ...f.selection.toolchains[0], sha256: hash("not the installed runtime") }] } }), { code: "CONFLICT" });
  const running = await f.start();
  await assert.rejects(call(running, "action_run_get", { run_id: f.old.waiting.run_id }), /ORIGINAL_ACTION_SOURCE_ADMISSION_REQUIRED/);
  const session = await domain.admitOriginalMcpActionDomain(running.owner, actor, running.host, running.nativePolicy);
  assert.deepEqual(session.importedRunIds, f.selection.runIds); assert.equal(session.automaticReplay, false);
  assert.equal((await call(running, "action_module_sets")).module_sets[0].enabled, false);
  assert.equal((await call(running, "action_get", { action_id: f.old.review.action_id })).knowledgeId, f.old.review.knowledgeId);
  await assert.rejects(call(running, "action_run_get", { run_id: f.old.unselected }), /ORIGINAL_ACTION_SOURCE_ADMISSION_REQUIRED/);
  assert.deepEqual(await readFile(join(f.root, ".pkm/state/actions/settings.json")), f.oldSettings);
});

test("genuine old waiting Run resumes on the same canonical engine with a rotated token and preserves retained old notifications", async t => {
  const f = await fixture(t), running = await f.start(), lease = { ...running.owner.workspaceLease() };
  const admitted = await domain.admitOriginalMcpActionDomain(running.owner, actor, running.host, running.nativePolicy);
  const checkpoint = (await call(running, "action_run_checkpoints", { run_id: f.old.waiting.run_id })).checkpoints[0];
  const history = (await call(running, "action_run_checkpoints", { run_id: f.old.waiting.run_id, include_history: true })).checkpoints;
  assert.equal(history.length, 2); assert.equal(history[0].checkpoint_id, f.old.priorCheckpoint);
  assert.equal(history[0].state, "resolved"); assert.deepEqual(history[0].answer, {});
  assert.equal(checkpoint.checkpoint_id, f.old.waiting.checkpoint.checkpoint_id);
  assert.notEqual(checkpoint.resume_token, f.old.waiting.checkpoint.resume_token);
  const response = { run_id: f.old.waiting.run_id, checkpoint_id: checkpoint.checkpoint_id,
    resume_token: f.old.waiting.checkpoint.resume_token, proposal_digest: checkpoint.proposal_digest,
    answer: { approved: true }, event_key: "fresh-native-answer" };
  await assert.rejects(call(running, "action_checkpoint_respond", response), { code: "ACCESS_DENIED" });
  await call(running, "action_checkpoint_respond", { ...response, resume_token: checkpoint.resume_token });
  const completed = await call(running, "action_run_wait", { run_id: f.old.waiting.run_id, wait_seconds: 1 });
  assert.equal(completed.state, "succeeded"); assert.deepEqual(completed.output, { value: { approved: true } });
  assert(completed.version > f.old.waiting.execution.version);
  assert.equal(completed.execution.phase, "completed"); assert.equal(completed.execution.workerPid, null);
  const events = await call(running, "action_run_events", { run_id: f.old.waiting.run_id });
  assert(events.events.some(event => event.sequence === 7 && event.payload.remote_id === "actual-retained-notification"));
  assert.equal(events.gap, true);
  assert.deepEqual((await call(running, "action_run_get", { run_id: f.old.success.run_id })).output, { value: "kept-old-output" });
  const db = running.storage.connectNative();
  try {
    assert.equal(db.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM action_runtime_runs").get().n, 3);
    assert.throws(() => db.prepare("DELETE FROM original_mcp_action_domain_intents").run(), /immutable/);
  } finally { db.close(); }
  assert.equal(domain.verifyOriginalMcpActionDomain(running.storage).receiptSha256, admitted.receiptSha256);
  assert.deepEqual(running.owner.workspaceLease(), lease);
  await writeFile(join(f.root, "action-sources/proof.txt"), "Modified after native source admission.", { mode: 0o600 });
  await assert.rejects(call(running, "action_run_get", { run_id: f.old.waiting.run_id }), { code: "RECOVERY_CONFLICT" });
});

test("a backed old cancellation intent remains a denial and never resumes its suspended checkpoint", async t => {
  const f = await fixture(t, { cancelled: true }), running = await f.start();
  await domain.admitOriginalMcpActionDomain(running.owner, actor, running.host, running.nativePolicy);
  const run = await call(running, "action_run_get", { run_id: f.old.waiting.run_id });
  assert.equal(run.state, "cancelled"); assert.equal(run.checkpoint.state, "cancelled");
  await assert.rejects(call(running, "action_checkpoint_respond", { run_id: run.run_id, checkpoint_id: run.checkpoint.checkpoint_id,
    resume_token: run.checkpoint.resume_token, proposal_digest: run.checkpoint.proposal_digest,
    answer: { approved: true }, event_key: "cannot-revive-cancelled" }), { code: "CONFLICT" });
  assert.equal(domain.verifyOriginalMcpActionNativeFootprint(f.root).b1Qualification, "B1_UNQUALIFIED");
  await assert.rejects(call(running, "action_run_recover"), /ORIGINAL_ACTION_RUN_COVERAGE_REQUIRED/);
});

test("abandoned workers and old qualification grants become review state; manual evidence requires fresh Action approval and never replays", async t => {
  const f = await fixture(t), running = await f.start();
  await domain.admitOriginalMcpActionDomain(running.owner, actor, running.host, running.nativePolicy);
  const unknown = await call(running, "action_run_get", { run_id: f.old.abandoned.run_id });
  assert.equal(unknown.state, "outcome_unknown");
  assert.equal(unknown.capability_hash, undefined); assert.equal(unknown.launcher_pid, undefined);
  const status = await call(running, "action_validation_status");
  assert.equal(status.worker_pid, null);
  assert(status.jobs.some(job => job.state === "outcome_unknown"));
  assert(status.jobs.some(job => job.state === "blocked"));
  await call(running, "action_validation_resume");
  await pause(30);
  await assert.rejects(call(running, "action_validate", { action_id: f.old.review.action_id, content_hash: f.old.review.content_hash }),
    /ACTION_CODE_REVIEW_REQUIRED/);
  const request = { run_id: f.old.abandoned.run_id, expected_version: unknown.version, kind: "manual",
    evidence: { reason: "Operator independently checked the original effect receipt.", output: { value: "manually-proven" } }, outcome: "succeeded" };
  await assert.rejects(call(running, "action_run_reconcile", { ...request, expected_version: f.old.abandoned.execution.version }), { code: "CONFLICT" });
  f.setAllowed(false);
  await assert.rejects(call(running, "action_run_reconcile", request), /ACTION_SOURCE_ADMISSION_RPC_REQUIRED/);
  assert.equal((await call(running, "action_run_get", { run_id: request.run_id })).state, "outcome_unknown");
  f.setAllowed(true);
  assert.deepEqual((await call(running, "action_run_reconcile", request)).output, { value: "manually-proven" });
  await assert.rejects(call(running, "action_run_reconcile", request), { code: "CONFLICT" });
  const db = running.storage.connectNative();
  try { assert.equal(db.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n, 0); }
  finally { db.close(); }
});

test("source admission is exact-owner/current Action authority, never a model grant, callback, readonly actor or altered capsule", async t => {
  const f = await fixture(t), running = await f.start();
  await assert.rejects(domain.createOriginalMcpActionNativePolicy(running.storage, running.host, f.custody, {
    nativeAuthority: { kind: "pkm.original-native-action-authority/v1", root: f.root,
      workspaceId: running.workspaceId, profileSha256: f.plan.profileSha256, epoch: running.host.receipt.epoch,
      capsuleSha256: f.custody.capsuleSha256, signal: new AbortController().signal,
      assertCurrent() {}, async close() {} },
  }), /NATIVE_ACTION_PRODUCER_LOCATOR_REQUIRED/);
  await assert.rejects(domain.admitOriginalMcpActionDomain(running.owner, actor, running.host,
    { options: running.nativePolicy.options, authorize: () => true }), /concrete native Action policy/);
  await assert.rejects(domain.admitOriginalMcpActionDomain(running.owner, { ...actor, canWrite: false }, running.host, running.nativePolicy), { code: "ACCESS_DENIED" });
  f.setTypedDecisions(false);
  await assert.rejects(domain.admitOriginalMcpActionDomain(running.owner, actor, running.host, running.nativePolicy), /ACTION_SOURCE_ADMISSION_RPC_REQUIRED/);
  f.setTypedDecisions(true);
  f.setAllowed(false);
  await assert.rejects(domain.admitOriginalMcpActionDomain(running.owner, actor, running.host, running.nativePolicy), /ACTION_SOURCE_ADMISSION_RPC_REQUIRED/);
  const db = running.storage.connectNative();
  try { assert.equal(db.prepare("SELECT count(*) n FROM action_runtime_runs").get().n, 0); } finally { db.close(); }
  f.setAllowed(true);
  await writeFile(join(f.root, "action-sources/proof.txt"), "Changed after independent B0.", { mode: 0o600 });
  await assert.rejects(domain.admitOriginalMcpActionDomain(running.owner, actor, running.host, running.nativePolicy), { code: "RECOVERY_CONFLICT" });
  const other = await fixture(t, { wrongEpoch: true });
  await assert.rejects(other.start(), /ACTION_NATIVE_EPOCH_BINDING_REQUIRED/);
});

test("owner restart does not revive an Action source session, old validation worker or pending continuation", async t => {
  const f = await fixture(t), first = await f.start();
  await domain.admitOriginalMcpActionDomain(first.owner, actor, first.host, first.nativePolicy);
  await first.adapter.close(); await first.owner.close();
  const second = await f.start();
  await assert.rejects(call(second, "action_run_get", { run_id: f.old.waiting.run_id }), /ORIGINAL_ACTION_SOURCE_ADMISSION_REQUIRED/);
  await domain.admitOriginalMcpActionDomain(second.owner, actor, second.host, second.nativePolicy);
  assert.equal((await call(second, "action_run_get", { run_id: f.old.waiting.run_id })).state, "waiting");
  assert.equal((await call(second, "action_run_get", { run_id: f.old.abandoned.run_id })).state, "outcome_unknown");
  assert.equal((await call(second, "action_validation_status")).worker_pid, null);
  const db = second.storage.connectNative();
  try {
    assert.equal(db.prepare("SELECT count(*) n FROM action_runtime_runs").get().n, 3);
    assert.equal(db.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n, 0);
  } finally { db.close(); }
  f.setCurrent(false);
  await assert.rejects(call(second, "action_run_get", { run_id: f.old.waiting.run_id }), { code: "ACCESS_DENIED" });
});

test("native action_call really computes selected source outputs and resumes its own checkpoints with exact separate consent", async t => {
  const f = await fixture(t), running = await f.start();
  await domain.admitOriginalMcpActionDomain(running.owner, actor, running.host, running.nativePolicy);
  const args = invokeArgs(f.old.review, "new reviewed invocation"), initial = await call(running, "action_call", args);
  assert.equal(initial.launch_reused, false);
  for (const answer of [{}, { approved: true }]) {
    const waiting = await settled(running, initial.run_id, "waiting");
    await call(running, "action_checkpoint_respond", { run_id: initial.run_id,
      checkpoint_id: waiting.checkpoint.checkpoint_id, resume_token: waiting.checkpoint.resume_token,
      proposal_digest: waiting.checkpoint.proposal_digest, answer, event_key: `answer-${waiting.checkpoint.step}` });
  }
  assert.deepEqual((await settled(running, initial.run_id, "succeeded")).output, { value: { approved: true } });
  const repeat = await call(running, "action_call", args);
  assert.equal(repeat.run_id, initial.run_id); assert.equal(repeat.launch_reused, true);
  await assert.rejects(call(running, "action_call", { ...args, inputs: { changed: true } }), /pinned schema|different inputs/);
  const module = await call(running, "action_get", { action_id: f.moduleRaw.action_id });
  await assert.rejects(call(running, "action_call", invokeArgs(module, args.idempotency_key)), { code: "CONFLICT" });
  const computed = await call(running, "action_call", invokeArgs(module, "selected member"));
  assert.deepEqual((await settled(running, computed.run_id, "succeeded")).output, { value: 7 });
  assert.equal(f.effects.length, 2, "Idempotent retrieval does not confer another execution grant.");
  assert.equal(f.effects[0].operation, "action_call");
  const { knowledgeId: _knowledgeId, ...definition } = f.moduleRaw;
  const unauthorized = await running.full.runtime.core.dispatch("capability_call", { operation: "action.runtime.create", version: 1,
    arguments: { operationId: randomUUID(), runId: `action_run_${randomUUID().replaceAll("-", "")}`,
      source: { kind: "inline", definition }, expectedDefinitionDigest: module.content_hash,
      deadline: Date.now() + 30_000, inputs: {} } }, actor);
  assert.equal(unauthorized.error?.code, "FORBIDDEN", "A source receipt or another Run's grant cannot create a new Core Run.");
  assert.deepEqual(counts(running), { runs: 5, processes: 0 });
  assert.equal((await call(running, "action_module_sets")).module_sets[0].enabled, false, "Scoped member consent does not globally activate its package.");
  assert.equal(domain.verifyOriginalMcpActionDomain(running.storage).capsuleSha256, f.custody.capsuleSha256);
  assert.deepEqual(await readFile(join(f.root, ".pkm/state/actions/settings.json")), f.oldSettings);
});

test("source/public approval, old grants and aborted or revoked consent cannot publish a new native invocation", async t => {
  const f = await fixture(t), running = await f.start();
  await domain.admitOriginalMcpActionDomain(running.owner, actor, running.host, running.nativePolicy);
  const args = invokeArgs(f.old.review, "denied invocation");
  f.setEffectsAllowed(false);
  await assert.rejects(call(running, "action_call", args), /ACTION_EFFECT_CONSENT_REQUIRED/);
  assert.deepEqual(counts(running), { runs: 3, processes: 0 });
  f.setEffectsAllowed(true);
  const controller = new AbortController();
  f.setEffectHook(() => { controller.abort(); });
  await assert.rejects(running.adapter.invoke("action_call", { ...args, idempotency_key: "aborted" }, controller.signal), { name: "AbortError" });
  assert.equal(counts(running).runs, 3);
  f.setEffectHook(() => { f.setTrusted(false); });
  await assert.rejects(call(running, "action_call", args), /native|trusted/i);
  assert.equal(counts(running).runs, 3);
  f.setTrusted(true); f.setEffectHook(undefined);
  await assert.rejects(call(running, "action_call", invokeArgs(f.old.echo, "old program grant", { value: "must not execute" })),
    /ACTION_NATIVE_EFFECT_HANDLER_REQUIRED/);
  await assert.rejects(call(running, "action_call", { ...args, trigger: { kind: "timer", at: 1 } }), /ACTION_NATIVE_SCHEDULE_REQUIRED/);
  await assert.rejects(call(running, "action_call", { ...args, project_id: "not-an-admitted-project" }), /ACTION_NATIVE_PROJECT_BINDING_REQUIRED/);
  assert.equal(counts(running).runs, 3);
});

test("restart preserves a new waiting Run without restoring its invocation grant; exact continuation needs fresh native consent", async t => {
  const f = await fixture(t), first = await f.start();
  await domain.admitOriginalMcpActionDomain(first.owner, actor, first.host, first.nativePolicy);
  const args = invokeArgs(f.old.review, "native restart"), initial = await call(first, "action_call", args);
  const waiting = await settled(first, initial.run_id, "waiting");
  await first.adapter.close(); await first.owner.close();
  const second = await f.start();
  await assert.rejects(call(second, "action_run_get", { run_id: initial.run_id }), /ORIGINAL_ACTION_SOURCE_ADMISSION_REQUIRED/);
  await domain.admitOriginalMcpActionDomain(second.owner, actor, second.host, second.nativePolicy);
  const repeat = await call(second, "action_call", args);
  assert.equal(repeat.run_id, initial.run_id); assert.equal(repeat.state, "waiting"); assert.equal(repeat.launch_reused, true);
  assert.equal(f.effects.length, 1);
  const scan = await call(second, "action_run_safety_scan");
  assert.equal(scan.ok, false); assert(scan.blocked.includes(initial.run_id)); assert.deepEqual(scan.dispatched, []);
  const response = { run_id: initial.run_id, checkpoint_id: waiting.checkpoint.checkpoint_id,
    resume_token: waiting.checkpoint.resume_token, proposal_digest: waiting.checkpoint.proposal_digest,
    answer: {}, event_key: "fresh-continuation" };
  f.setEffectsAllowed(false);
  await assert.rejects(call(second, "action_checkpoint_respond", response), /ACTION_EFFECT_CONSENT_REQUIRED/);
  assert.equal((await call(second, "action_run_get", { run_id: initial.run_id })).version, waiting.version);
  f.setEffectsAllowed(true);
  await call(second, "action_checkpoint_respond", response);
  assert.equal(f.effects.at(-1).operation, "action_checkpoint_respond");
  for (let attempt = 0; attempt < 200; attempt++) {
    const next = await settled(second, initial.run_id, "waiting");
    if (next.checkpoint.step === "review") break;
    await pause(10);
  }
  await call(second, "action_run_cancel", { run_id: initial.run_id });
  assert.equal((await call(second, "action_run_get", { run_id: initial.run_id })).state, "cancelled");
  assert.deepEqual(counts(second), { runs: 4, processes: 0 });
});

test("cancellation while real native dispatch awaits current authority is uncertain and is never replayed after restart", async t => {
  const f = await fixture(t), first = await f.start();
  await domain.admitOriginalMcpActionDomain(first.owner, actor, first.host, first.nativePolicy);
  const module = await call(first, "action_get", { action_id: f.moduleRaw.action_id });
  const args = invokeArgs(module, "uncertain native dispatch");
  f.setEffectHook(() => {
    let statuses = 0;
    f.setStatusHook(() => ++statuses > 1 ? pause(200) : undefined);
  });
  const created = await call(first, "action_call", args);
  await settled(first, created.run_id, "running");
  const cancelled = await call(first, "action_run_cancel", { run_id: created.run_id });
  assert.equal(cancelled.cancel_requested, true); assert.equal(cancelled.remote_rollback, false);
  assert.equal((await settled(first, created.run_id, "outcome_unknown")).output, undefined);
  f.setStatusHook(undefined); f.setEffectHook(undefined);
  await first.adapter.close(); await first.owner.close();
  const second = await f.start();
  await domain.admitOriginalMcpActionDomain(second.owner, actor, second.host, second.nativePolicy);
  const repeat = await call(second, "action_call", args);
  assert.equal(repeat.state, "outcome_unknown"); assert.equal(repeat.launch_reused, true);
  assert.equal(f.effects.length, 1);
  assert.deepEqual(counts(second), { runs: 4, processes: 0 });
});

test("consumed invocation admission without a published Run is retained and never retried, even after owner restart", async t => {
  const f = await fixture(t), first = await f.start();
  await domain.admitOriginalMcpActionDomain(first.owner, actor, first.host, first.nativePolicy);
  const args = invokeArgs(f.old.review, "interrupted publication"), engine = first.full.runtime.services.hostServices.actionRuntime;
  const create = engine.create;
  engine.create = () => { throw new Error("Injected interruption after durable consent consumption."); };
  try { await assert.rejects(call(first, "action_call", args), /Injected interruption/); }
  finally { engine.create = create; }
  await assert.rejects(call(first, "action_call", args), /ACTION_INVOCATION_RECONCILIATION_REQUIRED/);
  assert.deepEqual(counts(first), { runs: 3, processes: 0 }); assert.equal(f.effects.length, 1);
  await first.adapter.close(); await first.owner.close();
  const second = await f.start();
  await domain.admitOriginalMcpActionDomain(second.owner, actor, second.host, second.nativePolicy);
  await assert.rejects(call(second, "action_call", args), /ACTION_INVOCATION_RECONCILIATION_REQUIRED/);
  assert.deepEqual(counts(second), { runs: 3, processes: 0 }); assert.equal(f.effects.length, 1);
});
