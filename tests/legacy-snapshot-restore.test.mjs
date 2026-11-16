import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createAgentRuntime } from "../dist/agent-runtime.js";
import { initializeAgentRuntimeSchema } from "../dist/agent-runtime-store.js";
import { initializeLegacySnapshotRestoreSchema, validateLegacySnapshotRestoreStaging } from "../dist/legacy-snapshot-restore.js";
import { legacySnapshotRestoreDefinitions, LEGACY_SNAPSHOT_RESTORE_TABLES } from "../dist/legacy-snapshot-restore-contracts.js";
import { at, code, fixture, hash, payloadFixture, sourceOracle, readSnapshotOriginal } from "./legacy-snapshot-restore-captures.mjs";

test("snapshot originals bind the complete historical generation, source role and authenticated archive without path fallback", async t => {
  const path = "src/agent-sessions/agent-snapshots.ts";
  await assert.rejects(readSnapshotOriginal("src/chat/chat-history-storage.ts"), /path\/role\/digest binding/);
  await assert.rejects(readSnapshotOriginal(path, { kind: "captured" }), /path\/role\/digest binding/);
  await assert.rejects(readSnapshotOriginal(path, { sha256: "4f3f6c628ae8be43f71e60202349bbfa3302542290e38ec67898ad43d79a258b" }),
    /path\/role\/digest binding/);
  const root = fileURLToPath(new URL(`.snapshot-auth-${randomUUID()}/`, import.meta.url));
  t.after(() => rm(root, { recursive: true, force: true }));
  const relative = "migration/evidence/snapshot-authentication-originals.zip";
  await mkdir(join(root, "migration/evidence"), { recursive: true });
  const bytes = await readFile(new URL(`../${relative}`, import.meta.url));
  await writeFile(join(root, relative), Buffer.concat([bytes, Buffer.from("tampered")]));
  await assert.rejects(readSnapshotOriginal(path, { root }), error => error.evidenceReason === "archive-hash-changed");
});

test("original restore oracle: exact quiescent task/tree/checkpoint/Recipe and normalized Chat; original identity and bytes immutable", async t => {
  const oracle = sourceOracle();
  for (const terminal of [false, true]) {
    const payload = payloadFixture();
    if (terminal) payload.session.todos.forEach(todo => { todo.status = "succeeded"; });
    const f = fixture(payload); t.after(f.close);
    assert.deepEqual(oracle.decrypt(f.snapshot), payload);
    const originalBytes = Buffer.from(f.bytes), args = f.input();
    const restored = await f.runtime.restorePaused(f.token, args);
    assert.equal(restored.state, "paused");
    assert.equal(restored.replay, "never");
    const staging = f.runtime.readStaged(f.token, { restoreId: restored.restoreId });
    assert.doesNotThrow(() => validateLegacySnapshotRestoreStaging(f.binding, restored.restoreId, staging));
    assert.throws(() => validateLegacySnapshotRestoreStaging(f.binding, "0".repeat(64), staging), code("STATE_TAMPERED"));
    const expected = oracle(payload, f.snapshot, restored.sessionId, restored.restoreId);
    delete expected.session.provenance.magicCode;
    assert.deepEqual(staging.task, { task: payload.session.task, status: "paused", ...expected.session });
    assert.deepEqual(staging.recipes, expected.recipeRuns);
    assert.deepEqual(staging.checkpoints, expected.session.checkpoints);
    assert.deepEqual(staging.history, payload);
    assert.deepEqual(staging.transcript, payload.session.nativeChat.messages.map(original => {
      const message = structuredClone(original);
      if (message.taskId) message.taskId = restored.sessionId;
      if (message.status === "streaming") message.status = "interrupted";
      if (message.toolCalls) message.toolCalls = message.toolCalls.map(call => call.status === "running"
        ? { ...call, status: "failed", result: call.result || "Interrupted before the Snapshot was recovered." } : call);
      return message;
    }));
    const messages = f.chat.execute({ operation: "chat.session.messages", args: { id: restored.chatId } }, f.owner.actorId);
    assert.equal(messages.items.length, 2);
    assert.equal(messages.items[1].status, "interrupted");
    assert.equal(messages.items[1].toolCalls[0].status, "failed");
    assert.deepEqual(messages.items[0].metadata.budgetReceipts, payload.session.nativeChat.messages[0].metadata.budgetReceipts);
    assert.equal(f.calls.includes("resume"), false);
    assert.deepEqual(await f.runtime.restorePaused(f.token, args), restored);
    await assert.rejects(f.runtime.restorePaused(f.token, f.input()), code("DUPLICATE_SNAPSHOT"));
    assert.deepEqual(f.bytes, originalBytes);
    const stored = f.db.prepare("SELECT original FROM legacy_snapshot_restore_originals").get().original;
    assert.deepEqual(Buffer.from(stored), originalBytes);
    const before = f.calls.length;
    assert.deepEqual(f.restart().get(f.token, { restoreId: restored.restoreId }), restored);
    assert.equal(f.calls.length, before);
  }
});

test("strict intent schemas, native approval/key epoch/revocation/tamper and unsupported state fail closed, no partial writes", async t => {
  const oracle = sourceOracle();
  assert.equal(typeof oracle, "function");
  const base = fixture(); t.after(base.close);
  for (const field of ["actorId", "nativeOwnerId", "magicCode", "token", "keyEpoch", "oracle", "approved", "workerId", "model", "prompt"]) {
    assert.equal(legacySnapshotRestoreDefinitions[0].input.safeParse({ ...base.input(), [field]: "fake" }).success, false);
  }
  assert.throws(() => initializeLegacySnapshotRestoreSchema(base.db), code("TRANSACTION_REQUIRED"));
  await assert.rejects(base.runtime.restorePaused({ ...base.owner }, base.input()), code("UNAUTHORIZED"));
  await assert.rejects(base.runtime.restorePaused(base.foreign, base.input()), code("SOURCE_TAMPERED"));
  for (const [field, value, error] of [
    ["approved", false, "APPROVAL_REQUIRED"], ["epoch", "expired", "KEY_EXPIRED"],
    ["safe", false, "SAFE_POLICY_REQUIRED"], ["lease", false, "LEASE_LOST"],
    ["time", base.binding.expiresAt, "AUTHORITY_EXPIRED"],
  ]) {
    const previous = base[field]; base[field] = value;
    await assert.rejects(base.runtime.restorePaused(base.token, base.input()), code(error));
    base[field] = previous;
    assert.equal(base.db.prepare("SELECT count(*) n FROM legacy_snapshot_restore_records").get().n, 0);
  }
  const bytes = base.bytes; base.bytes = Buffer.concat([bytes, Buffer.from(" ")]);
  await assert.rejects(base.runtime.restorePaused(base.token, base.input()), code("SOURCE_TAMPERED")); base.bytes = bytes;
  const corrupt = fixture(); t.after(corrupt.close);
  corrupt.snapshot.payload.tag = Buffer.alloc(16, 5).toString("base64url");
  corrupt.bytes = Buffer.from(JSON.stringify(corrupt.snapshot));
  corrupt.binding.cipherSha256 = hash(corrupt.bytes);
  await assert.rejects(corrupt.runtime.restorePaused(corrupt.token, corrupt.input()), code("CIPHERTEXT_INVALID"));
  const expiring = fixture(); t.after(expiring.close);
  expiring.host.key = async () => { expiring.epoch = "rotated-during-key"; return expiring.key; };
  await assert.rejects(expiring.runtime.restorePaused(expiring.token, expiring.input()), code("KEY_EXPIRED"));
  assert.equal(expiring.db.prepare("SELECT count(*) n FROM legacy_snapshot_restore_originals").get().n, 0);
  const revoking = fixture(); t.after(revoking.close);
  revoking.host.validateSafeState = async () => { revoking.approved = false; return true; };
  await assert.rejects(revoking.runtime.restorePaused(revoking.token, revoking.input()), code("APPROVAL_REQUIRED"));
  assert.equal(revoking.db.prepare("SELECT count(*) n FROM chat_sessions").get().n, 0);
  const rollback = fixture(); t.after(rollback.close);
  rollback.db.exec("BEGIN IMMEDIATE");
  rollback.chat.execute({ operation: "chat.session.create", args: {
    operationId: randomUUID(), id: rollback.binding.targetChatId, expectedRevision: 0, title: "Existing target",
  } }, rollback.owner.actorId);
  rollback.db.exec("COMMIT");
  await assert.rejects(rollback.runtime.restorePaused(rollback.token, rollback.input()));
  assert.equal(rollback.db.prepare("SELECT count(*) n FROM legacy_snapshot_restore_originals").get().n, 0);
  assert.equal(rollback.db.prepare("SELECT count(*) n FROM legacy_snapshot_restore_receipts").get().n, 0);
  for (const mutate of [
    p => { p.session.authVerifier = "synthetic-sensitive-field"; },
    p => { p.session.nativeChat.messageHistory = { path: "never-follow" }; },
    p => { p.session.nativeChat.messages[0].delegations = []; },
    p => { p.session.nativeChat.messages[0].invocationBudgets = []; },
    p => { p.session.nativeChat.plans = []; },
    p => { p.session.liveness = { owner: { transportId: "retired" } }; },
    p => { p.session.todos[0].recipeRunId = "recipe_run_missing"; },
    p => { p.recipeRuns[1].nodes.leaf.childRunId = "recipe_run_parent"; },
    p => { p.session.checkpoints[0].state.accessToken = "not-persisted"; },
    p => { p.session.nativeChat.messages[0].content = "Bearer syntheticSensitive"; },
    p => { p.session.nativeChat.messages.push({ role: "system", id: "unsupported", content: "unsupported", status: "complete" }); },
    p => { p.session.origin = "external"; },
  ]) {
    const payload = payloadFixture(); mutate(payload);
    const f = fixture(payload); t.after(f.close);
    await assert.rejects(f.runtime.restorePaused(f.token, f.input()), error => ["SECRET_STATE", "UNSUPPORTED_STATE"].includes(error?.code));
    for (const table of LEGACY_SNAPSHOT_RESTORE_TABLES.filter(table => !table.endsWith("_schema"))) {
      assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
    }
  }
  const args = base.input(), restored = await base.runtime.restorePaused(base.token, args);
  const sessionId = base.binding.targetSessionId;
  base.binding.targetSessionId = "changed_native_target";
  await assert.rejects(base.runtime.restorePaused(base.token, args), code("OP_CONFLICT"));
  base.binding.targetSessionId = sessionId;
  base.approved = false;
  await assert.rejects(base.runtime.restorePaused(base.token, args), code("APPROVAL_REQUIRED"));
  base.approved = true; base.epoch = "expired";
  await assert.rejects(base.runtime.control(base.token, "resume", { opId: randomUUID(), restoreId: restored.restoreId, expectedRevision: 1 }), code("KEY_EXPIRED"));
  base.epoch = base.binding.keyEpoch;
  base.db.prepare("UPDATE legacy_snapshot_restore_staging SET record='{}' WHERE kind='task'").run();
  assert.throws(() => base.runtime.readStaged(base.token, { restoreId: restored.restoreId }), code("STATE_TAMPERED"));
  for (const kind of ["task", "recipes", "checkpoints", "transcript", "history"]) {
    const tampered = fixture(); t.after(tampered.close);
    const original = await tampered.runtime.restorePaused(tampered.token, tampered.input());
    const staging = structuredClone(tampered.runtime.readStaged(tampered.token, { restoreId: original.restoreId }));
    if (kind === "task") staging.task.task = "changed-task";
    if (kind === "recipes") staging.recipes[0].nodes.nested.state = "running";
    if (kind === "checkpoints") staging.checkpoints[0].state.summary = "changed-checkpoint";
    if (kind === "transcript") staging.transcript[0].content = "changed-transcript";
    if (kind === "history") staging.history.session.nativeChat.plans = [];
    const text = JSON.stringify(staging[kind]);
    tampered.db.prepare("UPDATE legacy_snapshot_restore_staging SET record=?,sha256=? WHERE kind=?")
      .run(text, hash(text), kind);
    const record = { ...original, planSha256: hash(JSON.stringify({ binding: tampered.binding, staging })) };
    tampered.db.prepare("UPDATE legacy_snapshot_restore_records SET record=?").run(JSON.stringify(record));
    assert.throws(() => validateLegacySnapshotRestoreStaging(tampered.binding, original.restoreId, staging), code("STATE_TAMPERED"));
    assert.throws(() => tampered.restart().readStaged(tampered.token, { restoreId: original.restoreId }), code("STATE_TAMPERED"));
    await assert.rejects(tampered.restart().control(tampered.token, "resume", {
      opId: randomUUID(), restoreId: original.restoreId, expectedRevision: 1,
    }), code("STATE_TAMPERED"));
    assert.equal(tampered.db.prepare("SELECT count(*) n FROM legacy_snapshot_restore_effects").get().n, 0);
  }
  const denied = fixture(); t.after(denied.close);
  const paused = await denied.runtime.restorePaused(denied.token, denied.input());
  let executions = 0, inspections = 0;
  denied.host.control = {
    resume: async () => { executions++; throw new Error("unknown effect"); },
    cancel: async () => { executions++; },
    inspect: async () => { inspections++; throw new Error("unexpected inspection"); },
  };
  denied.safe = false;
  await assert.rejects(denied.restart().control(denied.token, "resume", {
    opId: randomUUID(), restoreId: paused.restoreId, expectedRevision: 1,
  }), code("SAFE_POLICY_REQUIRED"));
  assert.equal(executions, 0);
  denied.safe = true;
  const unknown = await denied.runtime.control(denied.token, "resume", {
    opId: randomUUID(), restoreId: paused.restoreId, expectedRevision: 1,
  });
  denied.safe = false;
  await assert.rejects(denied.restart().confirmNative(denied.token, {
    opId: randomUUID(), restoreId: paused.restoreId, expectedRevision: unknown.revision,
  }), code("SAFE_POLICY_REQUIRED"));
  assert.equal(inspections, 0);
  assert.equal(executions, 1);
  const revoked = fixture(); t.after(revoked.close);
  const revokePaused = await revoked.runtime.restorePaused(revoked.token, revoked.input());
  revoked.host.control = denied.host.control;
  revoked.host.validateSafeState = async () => { revoked.approved = false; return true; };
  await assert.rejects(revoked.restart().control(revoked.token, "resume", {
    opId: randomUUID(), restoreId: revokePaused.restoreId, expectedRevision: 1,
  }), code("APPROVAL_REQUIRED"));
  assert.equal(executions, 1);
  assert.equal(revoked.db.prepare("SELECT count(*) n FROM legacy_snapshot_restore_effects").get().n, 0);
});

test("explicit local native Agent/Chat mapping executes lifecycle only after journal COMMIT; cancellation confirmed; uncertain effects never replay on restart", async t => {
  sourceOracle();
  const f = fixture(); t.after(f.close);
  f.db.exec("BEGIN IMMEDIATE"); initializeAgentRuntimeSchema(f.db); f.db.exec("COMMIT");
  const handles = new Map();
  const native = createAgentRuntime(f.db, {
    tasks: [{ key: "fixture.local-only", title: "Approved synthetic local lifecycle", capabilities: [] }],
    assertOwner: () => { assert.equal(f.lease, true); }, now: () => at,
    host: {
      resolveOwner: f.host.resolveOwner,
      spawn: async invocation => {
        assert.equal(f.db.isTransaction, false);
        assert.equal(f.db.prepare("SELECT count(*) n FROM legacy_snapshot_restore_effects WHERE state='unknown'").get().n, 1);
        f.calls.push("native-spawn");
        handles.set(invocation.sessionId, "running");
        return { state: "running", handle: invocation.sessionId };
      },
      inspect: async invocation => ({ state: handles.get(invocation.sessionId) ?? "unknown", handle: invocation.sessionId }),
      cancel: async invocation => { f.calls.push("native-cancel"); handles.set(invocation.sessionId, "cancelled"); },
    },
  });
  let mapped;
  f.host.control = {
    resume: async (binding, staging, effectId) => {
      assert.equal(f.db.isTransaction, false);
      assert.equal(staging.task.status, "paused");
      const chat = f.chat.execute({ operation: "chat.session.get", args: { id: binding.targetChatId } }, binding.actorId);
      assert.equal(chat.metadata.sessionId, binding.targetSessionId);
      assert.equal(effectId.length, 64);
      mapped = (await native.spawn(f.token, { opId: randomUUID(), taskKey: "fixture.local-only" })).session;
    },
    cancel: async () => {
      assert.equal(f.db.isTransaction, false);
      await native.cancel(f.token, { opId: randomUUID(), id: mapped.id, expectedRevision: mapped.revision });
    },
    inspect: async binding => {
      const actual = native.get(f.token, { id: mapped.id });
      return { sessionId: binding.targetSessionId, chatId: binding.targetChatId,
        state: actual.state === "running" ? "native-controlled" : actual.state === "cancelled" ? "cancelled" : "unknown" };
    },
  };
  const restored = await f.runtime.restorePaused(f.token, f.input());
  const resumed = await f.runtime.control(f.token, "resume", { opId: randomUUID(), restoreId: restored.restoreId, expectedRevision: 1 });
  assert.equal(resumed.state, "native-controlled");
  assert.equal(native.list(f.token).items.length, 1);
  const cancelled = await f.runtime.control(f.token, "cancel", { opId: randomUUID(), restoreId: restored.restoreId, expectedRevision: resumed.revision });
  assert.equal(cancelled.state, "cancelled");
  assert.equal(native.get(f.token, { id: mapped.id }).state, "cancelled");
  const before = f.calls.length; assert.equal(f.restart().get(f.token, { restoreId: restored.restoreId }).state, "cancelled");
  assert.equal(f.calls.length, before);
  const uncertain = fixture(); t.after(uncertain.close);
  const paused = await uncertain.runtime.restorePaused(uncertain.token, uncertain.input());
  await assert.rejects(uncertain.runtime.control(uncertain.token, "resume", { opId: randomUUID(), restoreId: paused.restoreId, expectedRevision: 1 }), code("NATIVE_MAPPING_UNAVAILABLE"));
  let effects = 0;
  uncertain.host.control = {
    resume: async () => { effects++; throw new Error("unknown model/tool/process/collaboration result"); },
    cancel: async () => { throw new Error("unknown cancellation"); },
    inspect: async () => { throw new Error("no native mapping confirmation"); },
  };
  const controlArgs = { opId: randomUUID(), restoreId: paused.restoreId, expectedRevision: 1 };
  const unknown = await uncertain.runtime.control(uncertain.token, "resume", controlArgs);
  assert.equal(unknown.state, "resume-unknown"); assert.equal(effects, 1);
  const restarted = uncertain.restart();
  assert.equal(restarted.get(uncertain.token, { restoreId: paused.restoreId }).state, "resume-unknown");
  await restarted.control(uncertain.token, "resume", controlArgs);
  await assert.rejects(restarted.control(uncertain.token, "resume", { ...controlArgs, opId: randomUUID(), expectedRevision: unknown.revision }), code("UNKNOWN_EFFECT"));
  assert.equal(effects, 1);
  assert.equal(restarted.pending(uncertain.token).length, 1);
  let inspections = 0;
  uncertain.host.control.inspect = async binding => {
    inspections++;
    return { sessionId: binding.targetSessionId, chatId: "counterfeit-chat", state: "native-controlled" };
  };
  const confirmArgs = { opId: randomUUID(), restoreId: paused.restoreId, expectedRevision: unknown.revision };
  assert.equal((await restarted.confirmNative(uncertain.token, confirmArgs)).state, "resume-unknown");
  uncertain.host.control.inspect = async binding => {
    inspections++;
    return { sessionId: binding.targetSessionId, chatId: binding.targetChatId, state: "native-controlled" };
  };
  assert.equal((await restarted.confirmNative(uncertain.token, confirmArgs)).state, "native-controlled");
  await restarted.confirmNative(uncertain.token, confirmArgs);
  assert.equal(inspections, 2);
  assert.equal(restarted.pending(uncertain.token).length, 0);
  assert.equal(effects, 1);
  for (const delayedConfirmation of [false, true]) {
    const cancelling = fixture(); t.after(cancelling.close);
    let resumeCalls = 0, cancelCalls = 0;
    cancelling.host.control = {
      resume: async () => { resumeCalls++; throw new Error("unknown original effect"); },
      cancel: async () => { cancelCalls++; if (delayedConfirmation) throw new Error("unknown cancellation"); },
      inspect: async binding => ({
        sessionId: binding.targetSessionId, chatId: binding.targetChatId, state: "cancelled",
      }),
    };
    const paused = await cancelling.runtime.restorePaused(cancelling.token, cancelling.input());
    const resumed = await cancelling.runtime.control(cancelling.token, "resume", {
      opId: randomUUID(), restoreId: paused.restoreId, expectedRevision: paused.revision,
    });
    assert.equal(resumed.state, "resume-unknown");
    const cancelArgs = { opId: randomUUID(), restoreId: paused.restoreId, expectedRevision: resumed.revision };
    const result = await cancelling.runtime.control(cancelling.token, "cancel", cancelArgs);
    if (delayedConfirmation) {
      assert.equal(result.state, "cancel-unknown");
      assert.equal(cancelling.runtime.pending(cancelling.token).length, 2);
      assert.deepEqual(await cancelling.runtime.control(cancelling.token, "cancel", cancelArgs), result);
      await assert.rejects(cancelling.runtime.control(cancelling.token, "cancel", {
        ...cancelArgs, opId: randomUUID(), expectedRevision: result.revision,
      }), code("UNKNOWN_EFFECT"));
      assert.equal(cancelling.runtime.pending(cancelling.token).length, 2);
      const restarted = cancelling.restart();
      assert.equal((await restarted.confirmNative(cancelling.token, {
        opId: randomUUID(), restoreId: paused.restoreId, expectedRevision: result.revision,
      })).state, "cancelled");
      assert.equal(restarted.pending(cancelling.token).length, 0);
    } else {
      assert.equal(result.state, "cancelled");
      assert.equal(cancelling.runtime.pending(cancelling.token).length, 0);
    }
    assert.equal(resumeCalls, 1);
    assert.equal(cancelCalls, 1);
    assert.equal(cancelling.db.prepare("SELECT count(*) n FROM legacy_snapshot_restore_effects WHERE state='confirmed'").get().n, 2);
  }
});

test("schema/backup hooks preserve exact original cipher and safe state/receipts after database restore; no startup dispatch or counterfeit identity", async t => {
  sourceOracle();
  const source = fixture(); t.after(source.close);
  const args = source.input(), restored = await source.runtime.restorePaused(source.token, args);
  source.db.exec("PRAGMA user_version=17");
  const targetDb = new DatabaseSync(":memory:");
  const target = fixture(source.payload, targetDb); t.after(target.close);
  // Parent backup hook: copy the shared SQL table contents, no filesystem or real backup root.
  const tables = [...LEGACY_SNAPSHOT_RESTORE_TABLES.filter(table => !table.endsWith("_schema")), "chat_sessions", "chat_session_messages"];
  targetDb.exec("BEGIN IMMEDIATE");
  for (const table of tables) {
    const rows = source.db.prepare(`SELECT * FROM ${table}`).all();
    for (const row of rows) targetDb.prepare(`INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`)
      .run(...Object.values(row));
  }
  targetDb.exec("PRAGMA user_version=17; COMMIT");
  assert.equal(target.calls.length, 0);
  assert.deepEqual(target.runtime.get(target.token, { restoreId: restored.restoreId }), restored);
  assert.deepEqual(target.runtime.readStaged(target.token, { restoreId: restored.restoreId }),
    source.runtime.readStaged(source.token, { restoreId: restored.restoreId }));
  assert.deepEqual(await target.runtime.restorePaused(target.token, args), restored);
  assert.deepEqual(Buffer.from(targetDb.prepare("SELECT original FROM legacy_snapshot_restore_originals").get().original), source.bytes);
  assert.equal(targetDb.prepare("PRAGMA user_version").get().user_version, 17);
  assert.throws(() => target.runtime.get(target.foreign, { restoreId: restored.restoreId }), code("NOT_FOUND"));
  targetDb.prepare("UPDATE legacy_snapshot_restore_originals SET original=?").run(Buffer.from("changed"));
  assert.throws(() => target.runtime.get(target.token, { restoreId: restored.restoreId }), code("STATE_TAMPERED"));
});
