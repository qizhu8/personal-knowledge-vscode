import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, symlinkSync, unlinkSync, readdirSync, linkSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ChatTurnStore } from "../dist/chat-turn-store.js";
import { chatTurnStartInput } from "../dist/chat-turn-contracts.js";
import { createCodingWorkerWorkspace, createCodingWorkerManagerHost, recoverCodingWorkerEffects, codingWorkerHash } from "../dist/coding-worker.js";
import { codingFixture, until, addSource } from "./coding-worker-fixtures.mjs";

test("native fragmented SSE read -> structured patch -> real Node checks -> frozen disjoint merge -> functional E2E; bad task repairs", async t => {
  const f = codingFixture(t, { badFirst: true });
  f.start();
  const run = await f.terminal();
  assert.equal(run.state, "succeeded", JSON.stringify(run));
  assert(f.peak() >= 2, "two native model worker stages overlap");
  assert.equal(run.tasks.find(task => task.definition.taskId === "clamp").attempts.length, 2);
  assert(f.calls.some(call => call.capsule.repairReason?.includes("Native coding check failed")));
  assert(f.calls.every(call => call.request.tools.every(tool => ["source.read", "source.list"].includes(tool.function.name))));
  assert.match(readFileSync(resolve(f.integratedRoot(), "add.mjs"), "utf8"), /a \+ b/);
  assert.match(readFileSync(resolve(f.integratedRoot(), "clamp.mjs"), "utf8"), /Math\.max/);
  const jobs = f.processDatabase.prepare("SELECT record_json FROM runtime_process_jobs").all().map(row => JSON.parse(row.record_json));
  assert.equal(jobs.length, 4, "two successful workers, failed native check, and whole-source native E2E");
  assert(jobs.every(job => job.state === "SUCCEEDED" && job.stdout === "" && job.stderr === ""));
  const records = f.db.prepare("SELECT record FROM coding_worker_records").all().map(row => row.record).join("");
  assert.doesNotMatch(records, /redact-this-native-diagnostic/);
  const manifest = f.composition.native.manifest(f.owner, run.runId, run.freeze);
  assert.equal(manifest.changes.length, 2);
  assert.deepEqual(manifest.changes.map(change => change.path), ["add.mjs", "clamp.mjs"]);
  assert(f.receipts.some(receipt => receipt.kind === "merge"));
  assert(f.receipts.some(receipt => receipt.kind === "check"));
  assert(f.receipts.every(receipt => !JSON.stringify(receipt).includes(f.root)));
  f.assertOriginals();
});

test("two stages are isolated; validation rejects changed source and never accepts a model self-check claim", async t => {
  const f = codingFixture(t);
  await f.admit();
  const a = f.workerInput("add"), b = f.workerInput("clamp");
  const [da, db] = await Promise.all([f.composition.host.worker(a, f.signal), f.composition.host.worker(b, f.signal)]);
  assert.notEqual(f.stageRoot(da), f.stageRoot(db));
  assert.equal(readFileSync(resolve(f.stageRoot(da), "clamp.mjs"), "utf8"), "export function clamp(n) { return n; }\n");
  assert.equal(readFileSync(resolve(f.stageRoot(db), "add.mjs"), "utf8"), addSource);
  assert.equal((await f.validate(a, da)).ok, true);
  writeFileSync(resolve(f.stageRoot(da), "add.mjs"), addSource);
  await assert.rejects(f.validate(a, da), /DELIVERY_STALE/);
  await assert.rejects(f.composition.host.freeze({
    owner: f.owner, runId: a.runId, effectId: randomUUID(),
    deliveries: [{ taskId: "add", attemptId: a.attemptId, delivery: da }, { taskId: "clamp", attemptId: b.attemptId, delivery: db }],
  }, f.signal), /DELIVERY_STALE/);
  f.assertOriginals();
});

test("frozen merge beforehash conflict escalates without overwrite; stale E2E contract/proof is fenced", async t => {
  const f = codingFixture(t);
  await f.admit();
  const inputs = [f.workerInput("add"), f.workerInput("clamp")];
  const deliveries = await Promise.all(inputs.map(input => f.composition.host.worker(input, f.signal)));
  for (let i = 0; i < inputs.length; i++) assert.equal((await f.validate(inputs[i], deliveries[i])).ok, true);
  const frozen = await f.composition.host.freeze({
    owner: f.owner, runId: "direct-run", effectId: randomUUID(),
    deliveries: inputs.map((input, i) => ({ taskId: input.task.taskId, attemptId: input.attemptId, delivery: deliveries[i] })),
  }, f.signal);
  const target = resolve(f.integratedRoot(), "add.mjs"), externallyChanged = "export function add(a,b) { return 999; }\n";
  writeFileSync(target, externallyChanged);
  const rejected = await f.composition.host.integrate({ owner: f.owner, runId: "direct-run", freeze: frozen.pin, effectId: randomUUID() }, f.signal);
  assert.equal(rejected.ok, false); assert.equal(rejected.taskId, "add");
  assert.equal(readFileSync(target, "utf8"), externallyChanged);
  // Explicit host fixture repair restores the base; the adapter itself never overwrites a conflict.
  writeFileSync(target, addSource);
  const integration = await f.composition.host.integrate({ owner: f.owner, runId: "direct-run", freeze: frozen.pin, effectId: randomUUID() }, f.signal);
  assert.equal(integration.ok, true);
  await assert.rejects(f.composition.host.verify({ owner: f.owner, runId: "direct-run", freeze: frozen.pin,
    integration: integration.pin, contract: { ...f.contract, revision: 2 }, effectId: randomUUID() }, f.signal), /CONTRACT_STALE/);
  const proof = await f.composition.host.verify({ owner: f.owner, runId: "direct-run", freeze: frozen.pin,
    integration: integration.pin, contract: f.contract, effectId: randomUUID() }, f.signal);
  assert.equal(proof.ok, true);
  writeFileSync(target, externallyChanged);
  await assert.rejects(f.composition.host.verify({ owner: f.owner, runId: "direct-run", freeze: frozen.pin,
    integration: integration.pin, contract: f.contract, effectId: randomUUID() }, f.signal), /INTEGRATION_STALE/);
  f.assertOriginals();
});

test("wrong actor, task hash, task owner, allowedpath and beforehash are fenced before effects", async t => {
  const f = codingFixture(t);
  await f.admit();
  const input = f.workerInput("add");
  await assert.rejects(f.composition.host.worker({ ...input, owner: { ...f.owner, actorId: "other" } }, f.signal), /OWNER/);
  await assert.rejects(f.composition.host.worker({ ...input, task: { ...input.task, objective: "wrong task" } }, f.signal), /TASK_AUTHORITY/);
  await assert.rejects(f.composition.host.worker({ ...input, task: { ...input.task, writeScope: ["check.mjs"] } }, f.signal), /TASK_AUTHORITY/);
  const delivery = await f.composition.host.worker({ ...input, workerId: "owned-worker" }, f.signal);
  await assert.rejects(f.composition.host.worker(f.workerInput("add", { workerId: "wrong-worker" }), f.signal), /TASK_OWNER/);
  await assert.rejects(f.composition.host.worker({ ...input, workerId: "owned-worker" }, f.signal), /WORKER_REPLAY_FORBIDDEN/);
  assert.throws(() => f.composition.native.receipt({ ...f.owner, nativeOwnerId: "other" }, input.runId, delivery.pin), /OWNER/);
  f.assertOriginals();
});

for (const attack of ["traversal", "absolute", "check-script", "wrong-hash", "extra-shell", "ambiguous", "self-check"])
  test(`structured proposal ${attack} cannot acquire executable/file authority`, async t => {
    const f = codingFixture(t, { proposal(proposal) {
      if (attack === "traversal") proposal.patches[0].path = "../escape.mjs";
      if (attack === "absolute") proposal.patches[0].path = "/escape.mjs";
      if (attack === "check-script") proposal.patches[0].path = "check.mjs";
      if (attack === "wrong-hash") proposal.patches[0].beforeHash = "0".repeat(64);
      if (attack === "extra-shell") proposal.shell = "node -e arbitrary";
      if (attack === "ambiguous") proposal.patches[0].edits = [{ before: "a", after: "x" }];
      if (attack === "self-check") proposal.proof = { ok: true };
      return proposal;
    } });
    await f.admit();
    await assert.rejects(f.composition.host.worker(f.workerInput("add"), f.signal));
    assert.equal(f.db.prepare("SELECT count(*) n FROM coding_worker_records WHERE kind='delivery'").get().n, 0);
    assert.equal(f.db.prepare("SELECT count(*) n FROM coding_worker_effects WHERE effect_id LIKE '%.patch'").get().n, 0);
    f.assertOriginals();
  });

test("root/path symlinks, hardlinks and source pins fail closed; no source writes", async t => {
  const f = codingFixture(t);
  const path = resolve(f.sourceRoot, "add.mjs");
  unlinkSync(path); symlinkSync(resolve(f.sourceRoot, "clamp.mjs"), path);
  assert.throws(() => createCodingWorkerWorkspace({ ...f.workspaceOptions, workspaceId: `new-${randomUUID()}` }), /UNSAFE_FILE/);
  unlinkSync(path); writeFileSync(path, addSource);
  const hardlink = resolve(f.sourceRoot, "hardlinked.mjs"); linkSync(path, hardlink);
  assert.throws(() => createCodingWorkerWorkspace({ ...f.workspaceOptions, workspaceId: `new-${randomUUID()}` }), /UNSAFE_FILE/);
  unlinkSync(hardlink);
  const nested = resolve(f.sourceRoot, "nested"); mkdirSync(nested);
  const nestedLink = resolve(f.sourceRoot, "nested-link"); symlinkSync(nested, nestedLink);
  assert.throws(() => createCodingWorkerWorkspace({ ...f.workspaceOptions, workspaceId: `new-${randomUUID()}`,
    files: [{ path: "nested-link/file.mjs", beforeHash: codingWorkerHash(""), writable: true }] }), /SYMLINK/);
  const link = resolve(f.root, "linked-stages"); symlinkSync(f.stageParent, link);
  assert.throws(() => createCodingWorkerWorkspace({ ...f.workspaceOptions, workspaceId: `new-${randomUUID()}`, stageParent: link }), /SYMLINK/);
  assert.throws(() => createCodingWorkerWorkspace({ ...f.workspaceOptions, workspaceId: `new-${randomUUID()}`, stageParent: process.cwd() }), /REAL_WORKTREE/);
  assert.throws(() => createCodingWorkerWorkspace({ ...f.workspaceOptions, workspaceId: `new-${randomUUID()}`,
    files: f.workspaceOptions.files.map(file => ({ ...file, beforeHash: "0".repeat(64) })) }), /SOURCE_PIN/);
  await f.admit();
  const input = f.workerInput("add"), delivery = await f.composition.host.worker(input, f.signal);
  const stageFile = resolve(f.stageRoot(delivery), "add.mjs");
  unlinkSync(stageFile); symlinkSync(resolve(f.sourceRoot, "add.mjs"), stageFile);
  await assert.rejects(f.validate(input, delivery), /UNSAFE_FILE/);
  f.assertOriginals();
});

for (const crash of ["intent", "after-files"])
  test(`durable ${crash} crash journal observes exact before/after; restart unknown never auto-patches`, async t => {
    const f = codingFixture(t, { workspace: { fault(point, effectId) {
      if (effectId.endsWith(".patch") && point === crash) throw new Error("HOST_CRASH");
    } } });
    await f.admit();
    const input = f.workerInput("add");
    await assert.rejects(f.composition.host.worker(input, f.signal), /HOST_CRASH/);
    const row = JSON.parse(f.db.prepare("SELECT record FROM coding_worker_effects WHERE effect_id=?").get(`${input.effectId}.patch`).record);
    assert.equal(row.state, "intent");
    assert.equal(row.changes[0].before, addSource);
    assert.equal(row.changes[0].beforeHash, codingWorkerHash(addSource));
    const target = resolve(f.stageParent, row.stage, "add.mjs"), bytes = readFileSync(target, "utf8");
    assert.equal(bytes, crash === "intent" ? row.changes[0].before : row.changes[0].after);
    const recovered = recoverCodingWorkerEffects(f.workspaceOptions);
    assert.equal(recovered[0].outcome, "unknown");
    assert.equal(recovered[0].observation, crash === "intent" ? "before" : "after");
    assert.equal(readFileSync(target, "utf8"), bytes);
    assert.equal(f.composition.native.recover().length, 0);
    await assert.rejects(f.composition.host.worker(input, f.signal), /FENCED/);
    assert.throws(() => createCodingWorkerWorkspace(f.workspaceOptions), /RESTART_REQUIRES_NEW_CAPABILITY/);
    assert.equal(recoverCodingWorkerEffects(f.workspaceOptions).length, 0);
    f.assertOriginals();
  });

test("bounded k and conservatively durable run budgets survive retries", async t => {
  const f = codingFixture(t, { bounds: { concurrent: 1, turns: 1, runInputTokens: 65536, runOutputTokens: 8192 } });
  await f.admit();
  const values = await Promise.allSettled(["add", "clamp"].map(id => f.composition.host.worker(f.workerInput(id), f.signal)));
  assert.equal(values.filter(value => value.status === "fulfilled").length, 1);
  assert.match(values.find(value => value.status === "rejected").reason.message, /RUN_BUDGET/);
  assert.equal(f.peak(), 1);
  assert.equal(f.db.prepare("SELECT turns FROM coding_worker_budget WHERE run_id='direct-run'").get().turns, 1);
  f.assertOriginals();
});

test("partially applied two-file Integrator crash is durably mixed/unknown; recovery never completes or overwrites it", async t => {
  const f = codingFixture(t, { workspace: { fault(point, effectId) {
    if (effectId === "merge-crash" && point === "after-file") throw new Error("MERGE_CRASH");
  } } });
  await f.admit();
  const inputs = [f.workerInput("add"), f.workerInput("clamp")];
  const deliveries = await Promise.all(inputs.map(input => f.composition.host.worker(input, f.signal)));
  for (let index = 0; index < inputs.length; index++) assert.equal((await f.validate(inputs[index], deliveries[index])).ok, true);
  const frozen = await f.composition.host.freeze({ owner: f.owner, runId: "direct-run", effectId: randomUUID(),
    deliveries: inputs.map((input, index) => ({ taskId: input.task.taskId, attemptId: input.attemptId, delivery: deliveries[index] })),
  }, f.signal);
  await assert.rejects(f.composition.host.integrate({
    owner: f.owner, runId: "direct-run", freeze: frozen.pin, effectId: "merge-crash",
  }, f.signal), /MERGE_CRASH/);
  const beforeRecovery = ["add.mjs", "clamp.mjs"].map(path => readFileSync(resolve(f.integratedRoot(), path), "utf8"));
  const recovered = f.composition.native.recover();
  assert.deepEqual(recovered, [{ effectId: "merge-crash", outcome: "unknown", observation: "mixed" }]);
  assert.deepEqual(["add.mjs", "clamp.mjs"].map(path => readFileSync(resolve(f.integratedRoot(), path), "utf8")), beforeRecovery);
  assert.equal(f.db.prepare("SELECT count(*) n FROM coding_worker_records WHERE kind='integration'").get().n, 0);
  await assert.rejects(f.composition.host.integrate({
    owner: f.owner, runId: "direct-run", freeze: frozen.pin, effectId: randomUUID(),
  }, f.signal), /FENCED/);
  f.assertOriginals();
});

test("native check timeout is unknown, not failed repair evidence; cancellation/drain leaves no owned child", async t => {
  const baseline = process.getActiveResourcesInfo().filter(name => name === "ProcessWrap").length;
  const f = codingFixture(t, { bounds: { deadlineMs: 150 }, source: {
    "check.mjs": 'setTimeout(() => console.log(JSON.stringify({ok:true})), 5000);\n',
  } });
  await f.admit();
  const input = f.workerInput("add"), delivery = await f.composition.host.worker(input, f.signal);
  await assert.rejects(f.validate(input, delivery), /NATIVE_CHECK_UNKNOWN|FENCED/);
  assert.equal(f.db.prepare("SELECT count(*) n FROM coding_worker_records WHERE kind='accepted'").get().n, 0);
  await f.composition.native.close();
  await until(() => process.getActiveResourcesInfo().filter(name => name === "ProcessWrap").length <= baseline);
  f.assertOriginals();
});

test("restart with a completed delivery cannot reuse old capability/proof in a new host; interrupted work remains unknown", async t => {
  const f = codingFixture(t);
  await f.admit();
  const input = f.workerInput("add"), delivery = await f.composition.host.worker(input, f.signal);
  await f.validate(input, delivery);
  await f.composition.native.close();
  assert.throws(() => createCodingWorkerWorkspace(f.workspaceOptions), /RESTART_REQUIRES_NEW_CAPABILITY/);
  const newWorkspace = createCodingWorkerWorkspace({ ...f.workspaceOptions, workspaceId: `restart-${randomUUID()}` });
  const next = createCodingWorkerManagerHost({
    workspace: newWorkspace, provider: f.provider, transaction: f.transaction,
    resolveOwner: value => value === f.token ? f.owner : undefined, plan: async () => f.result, authorizeTask: () => true,
  });
  await assert.rejects(next.host.validate({ owner: f.owner, runId: input.runId, task: input.task, attemptId: input.attemptId,
    delivery, effectId: randomUUID() }, f.signal), /DELIVERY_BINDING/);
  await next.native.close();
  f.assertOriginals();
});

test("urgent targeted feedback fences only the affected attempt; cancelled run cannot reuse proofs or launch", async t => {
  let held = true;
  const f = codingFixture(t, { onModel: async call => {
    if (call.capsule.task.taskId === "clamp" && held) await until(() => !held);
  } });
  f.start();
  await until(() => f.calls.some(call => call.capsule.task.taskId === "clamp"));
  let run = f.runtime.get(f.token, { runId: "code-run" });
  f.runtime.feedback(f.token, { operationId: randomUUID(), runId: run.runId, expectedVersion: run.version,
    taskId: "clamp", urgent: true, message: "Keep target 0..10; rerun fresh attempt." });
  held = false;
  run = await f.terminal();
  assert.notEqual(run.state, "succeeded", "unknown cancelled inference never manufactures completion");
  assert.equal(run.tasks.find(task => task.definition.taskId === "add").attempts.length, 1, "targeted feedback does not retry another worker");
  assert(f.calls.every(call => call.capsule.allowedPaths.every(path => path === `${call.capsule.task.taskId}.mjs`)));
  await f.admit("cancelled-direct");
  await f.composition.host.cancel({ owner: f.owner, runId: "cancelled-direct", effectId: randomUUID() });
  await assert.rejects(f.composition.host.worker(f.workerInput("add", { runId: "cancelled-direct" }), f.signal), /FENCED/);
  f.assertOriginals();
});

test("source policy and check denial block native child launch; immutable check hashes are in acceptance pin", async t => {
  const f = codingFixture(t, { workspace: { authorizeCheck: () => false } });
  await f.admit();
  const input = f.workerInput("add"), delivery = await f.composition.host.worker(input, f.signal);
  await assert.rejects(f.validate(input, delivery), /CHECK_AUTHORITY/);
  assert.equal(f.db.prepare("SELECT count(*) n FROM coding_worker_records WHERE kind='accepted'").get().n, 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM coding_worker_records WHERE kind='check-intent'").get().n, 0);
  writeFileSync(resolve(f.stageRoot(delivery), "check.mjs"), 'console.log(JSON.stringify({ok:true}));');
  await assert.rejects(f.validate(input, delivery), /DELIVERY_STALE/);
  assert(readdirSync(f.stageParent).every(name => name.startsWith("stage-")));
  assert.throws(() => createCodingWorkerManagerHost({ workspace: {}, transaction: f.transaction }), /CAPABILITY_REQUIRED/);
  f.assertOriginals();
});

test("coding recovery is workspace-owned and never marks unrelated shared Chat turns interrupted", async t => {
  const f = codingFixture(t);
  const unrelated = new ChatTurnStore(f.db, { receipt() {} });
  f.transaction(() => unrelated.create(f.owner.actorId, chatTurnStartInput.parse({
    id: "unrelated-native-chat", sessionId: "unrelated-session", operationId: randomUUID(), expectedRevision: 0,
    messages: [{ role: "user", content: "Unrelated native conversation." }],
  })));
  assert.equal(f.composition.native.recover().length, 0);
  assert.equal(unrelated.get(f.owner.actorId, "unrelated-native-chat").status, "queued");
  assert.throws(() => createCodingWorkerManagerHost({
    workspace: f.workspace, provider: f.provider, transaction: f.transaction,
    resolveOwner: () => f.owner, plan: async () => f.result, authorizeTask: () => true,
  }), /CAPABILITY_ALREADY_BOUND/);
  f.assertOriginals();
});

test("volatile or reduced-synchronous journals cannot claim durable source effects", t => {
  const f = codingFixture(t);
  const volatile = new DatabaseSync(":memory:");
  assert.throws(() => createCodingWorkerWorkspace({ ...f.workspaceOptions, workspaceId: `memory-${randomUUID()}`,
    processDatabase: volatile }), /DURABLE_DISTINCT_JOURNALS_REQUIRED/);
  volatile.close();
  f.db.exec("PRAGMA synchronous=NORMAL");
  assert.throws(() => createCodingWorkerWorkspace({ ...f.workspaceOptions, workspaceId: `normal-${randomUUID()}` }), /DURABLE_DISTINCT_JOURNALS_REQUIRED/);
  f.db.exec("PRAGMA synchronous=FULL");
  assert.throws(() => createCodingWorkerWorkspace({ ...f.workspaceOptions, workspaceId: `denied-${randomUUID()}`,
    authorizeSource: () => false }), /SOURCE_POLICY/);
  f.assertOriginals();
});
