import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Core } from "../dist/core.js";
import { createAgentRuntime } from "../dist/agent-runtime.js";
import { createChatSessionStore } from "../dist/chat-session-store.js";
import { readTodoBoard, serializeTodoBoard } from "../dist/domain/todo-board.js";
import { sharedFixture, transports, call, human, actor, item, hash, at, originalCapture, sourceOracle } from "./host-composition-legacy-shared-captures.mjs";

test("actual original encrypted writer -> native import -> Core HTTP/MCP paused restore has exact source oracle and immutable ciphertext", async t => {
  const f = await sharedFixture(t), io = await transports(t, f.runtime.core);
  const args = f.restoreArgs();
  const result = await io.http("agent.snapshot.restore-paused", args);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.result.state, "paused");
  const restored = result.result;
  const expected = sourceOracle()(f.captured, f.snapshot, restored.sessionId, restored.restoreId);
  delete expected.session.provenance.magicCode;
  const rows = f.database.prepare("SELECT kind,record FROM legacy_snapshot_restore_staging").all();
  const stage = Object.fromEntries(rows.map(row => [row.kind, JSON.parse(row.record)]));
  assert.deepEqual(stage.task, { task: f.captured.session.task, status: "paused", ...expected.session });
  assert.deepEqual(stage.recipes, expected.recipeRuns);
  assert.deepEqual(stage.checkpoints, expected.session.checkpoints);
  assert.deepEqual(stage.history, f.captured);
  const chat = await f.runtime.core.dispatch("capability_read", { operation: "chat.session.messages", version: 1,
    arguments: { id: restored.chatId } }, human);
  assert.equal(chat.error, undefined);
  assert.equal(chat.result.items.length, 2);
  assert.equal(chat.result.items[1].status, "interrupted");
  assert.equal(chat.result.items[1].toolCalls[0].status, "failed");
  assert.deepEqual(chat.result.items[0].metadata.budgetReceipts, f.captured.session.nativeChat.messages[0].metadata.budgetReceipts);
  assert.deepEqual((await io.mcp("agent.snapshot.restore-paused", args)).result, restored);
  assert.equal((await io.http("agent.snapshot.restore-paused", f.restoreArgs())).error.code, "DUPLICATE_SNAPSHOT");
  assert.deepEqual(Buffer.from(f.database.prepare("SELECT original FROM legacy_snapshot_restore_originals").get().original), f.ciphertext);
  assert.deepEqual(await readFile(join(f.root, "agent-snapshot-reads/.pkm/state/agent-snapshots", `${f.snapshot.snapshotId}.json`)), f.ciphertext);
  const defaultCore = new Core(f.storage);
  assert.equal((await call(defaultCore, "agent.snapshot.restore-paused", args)).error.code, "NOT_AVAILABLE");
  await io.close();
  await f.restart();
  assert.deepEqual((await call(f.runtime.core, "agent.snapshot.restore-get", { restoreId: restored.restoreId })).result, restored);
});

test("trusted native approval, actor, receipt, expiry, epoch, safe-state, revocation and ciphertext guards cross transports", async t => {
  const f = await sharedFixture(t), io = await transports(t, f.runtime.core);
  const machine = await transports(t, f.runtime.core, { id: human.id, canWrite: true });
  f.state.approved = false;
  assert.equal((await io.http("agent.snapshot.restore-paused", f.restoreArgs())).error.code, "APPROVAL_REQUIRED");
  f.state.approved = true; f.state.safe = false;
  assert.equal((await io.mcp("agent.snapshot.restore-paused", f.restoreArgs())).error.code, "SAFE_POLICY_REQUIRED");
  f.state.safe = true; f.state.epoch = "rotated";
  assert.equal((await io.http("agent.snapshot.restore-paused", f.restoreArgs())).error.code, "KEY_EXPIRED");
  f.state.epoch = f.binding.keyEpoch;
  const expiry = f.binding.expiresAt; f.binding.expiresAt = Date.now() - 1;
  assert.equal((await io.mcp("agent.snapshot.restore-paused", f.restoreArgs())).error.code, "AUTHORITY_EXPIRED");
  f.binding.expiresAt = expiry;
  for (const field of ["actorId", "approved", "magicCode", "key", "oracle", "targetSessionId"])
    assert.equal((await io.http("agent.snapshot.restore-paused", { ...f.restoreArgs(), [field]: "forged" })).error.code, "INVALID_ARGUMENT");
  assert.equal((await call(f.runtime.core, "agent.snapshot.restore-paused", f.restoreArgs(), actor)).error.code, "NOT_AVAILABLE");
  assert.equal((await machine.http("agent.snapshot.restore-paused", f.restoreArgs())).error.code, "NOT_AVAILABLE");
  assert.equal((await io.mcp("agent.snapshot.restore-paused", { ...f.restoreArgs(), snapshotReceiptId: "foreign" })).error.code, "ACCESS_DENIED");
  const imported = join(f.root, "agent-snapshot-reads/.pkm/state/agent-snapshots", `${f.snapshot.snapshotId}.json`);
  await writeFile(imported, Buffer.concat([f.ciphertext, Buffer.from(" ")]));
  assert.equal((await io.http("agent.snapshot.restore-paused", f.restoreArgs())).error.code, "SOURCE_TAMPERED");
  await writeFile(imported, f.ciphertext);
  f.state.revoked = true;
  assert.equal((await io.http("agent.snapshot.restore-paused", f.restoreArgs())).error.code, "NOT_AVAILABLE");
  f.state.revoked = false;
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM legacy_snapshot_restore_records").get().n, 0);
});

test("HTTP/MCP inline writes execute all eleven original actions with exact whole Markdown, snapshots and historical global receipts", async t => {
  const f = await sharedFixture(t), io = await transports(t, f.runtime.core), workerIo = await transports(t, f.runtime.core, actor);
  const { writer, parser } = originalCapture();
  const captured = [];
  async function compare(command, who = human, upsert = false) {
    const before = await f.read(), request = { slug: "Original", expected_digest: hash(before), operationId: randomUUID(),
      ...(upsert ? { item: command } : { command }) };
    writer.setStorePath(f.source);
    const original = upsert ? writer.noteWorkItemExternalCommand("Original", request.expected_digest, {
      action: parser.readNoteWorkItems(before).items.some(value => value.id === command.id) ? "edit" : "create", item: command,
    }) : writer.noteWorkItemCommand("Original", request.expected_digest, command, {
      id: who.id, role: who.collaborationKind === "human" ? "user" : "worker",
    });
    const operation = `legacy.note.workitems.${upsert ? "upsert" : "command"}`;
    const response = await (who.id === actor.id ? workerIo.mcp : captured.length % 2 ? io.mcp : io.http)(operation, request);
    assert.equal(response.error, undefined, JSON.stringify(response));
    assert.deepEqual(response.result, JSON.parse(JSON.stringify({ ok: true, ...original })));
    assert.equal(await f.read(), await readFile(join(f.source, "notes/Original.md"), "utf8"));
    captured.push({ operation, request, result: response.result });
    return response.result;
  }
  await compare({ action: "create", item });
  await compare({ action: "claim", id: item.id });
  await compare({ action: "comment", id: item.id, text: "Exact transport comment" });
  await compare({ action: "release", id: item.id, reason: "Explicit original release" });
  await compare({ action: "assign", id: item.id, ownerId: human.id, reason: "Human assignment" });
  let snapshot = await compare({ action: "transition", id: item.id, state: "WIP" });
  await compare({ action: "edit", item: { ...snapshot.items[0], title: "Human exact edit" } });
  snapshot = await compare({ action: "transition", id: item.id, state: "Done", outcome: "Success", evidence: ["Original.assets/evidence.txt"] });
  await compare({ action: "accept", id: item.id, reason: "Human reviewed evidence" });
  await compare({ action: "reopen", id: item.id, reason: "Human requests followup" });
  await compare({ action: "delete", id: item.id, reason: "Human soft delete" });
  await compare({ action: "restore", id: item.id, reason: "Human restores source" });
  await compare({ ...item, id: "two", title: "MCP original fixed worker" }, actor, true);
  const first = captured[0];
  assert.deepEqual((await io.mcp(first.operation, first.request)).result, first.result);
  assert.equal((await io.http(first.operation, { ...first.request, command: { action: "claim", id: item.id } })).error.code, "CONFLICT");
  assert.equal((await workerIo.mcp(first.operation, first.request)).error.code, "CONFLICT");
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM legacy_inline_note_receipt").get().n, captured.length);
  assert.deepEqual((await io.mcp("legacy.note.workitems.read", { slug: "Original" }, "capability_read")).result,
    captured.at(-1).result);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM receipts WHERE operation_id=?").get(first.request.operationId).n, 1);
  const conflict = { ...f.restoreArgs(), opId: first.request.operationId };
  assert.equal((await io.http("agent.snapshot.restore-paused", conflict)).error.code, "CONFLICT");
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM legacy_snapshot_restore_originals").get().n, 0);
  assert.equal(await readFile(join(f.root, "notes/Original.assets/evidence.txt"), "utf8"), "untouched byte evidence");
});

test("inline protected acceptance, focus, authorization and source lineage stay fail-closed through Core/HTTP/MCP", async t => {
  const f = await sharedFixture(t), io = await transports(t, f.runtime.core), worker = await transports(t, f.runtime.core, actor);
  const args = { slug: "Original", expected_digest: hash(await f.read()), operationId: randomUUID(), command: { action: "create", item } };
  f.state.focus = false;
  assert.ok((await io.http("legacy.note.workitems.command", args)).error);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM legacy_inline_note_intent").get().n, 0);
  f.state.focus = true; f.state.revoked = true;
  assert.equal((await io.mcp("legacy.note.workitems.command", args)).error.code, "ACCESS_DENIED");
  f.state.revoked = false;
  const result = await io.http("legacy.note.workitems.command", args);
  assert.equal(result.error, undefined);
  const rejected = await worker.mcp("legacy.note.workitems.command", { slug: "Original", expected_digest: result.result.digest,
    operationId: randomUUID(), command: { action: "accept", id: item.id } });
  assert.ok(rejected.error);
  assert.equal((await io.http("legacy.note.workitems.command", { ...args, worker_token: "synthetic-token-not-an-inline-grant" })).error.code, "NOT_AVAILABLE");
  await writeFile(join(f.root, "notes/Original.md"), `${await f.read()}\nExternal edit`);
  assert.deepEqual((await io.mcp("legacy.note.workitems.command", args)).result, result.result);
  assert.equal((await io.http("legacy.note.workitems.command", { slug: "Original", expected_digest: hash(await f.read()),
    operationId: randomUUID(), command: { action: "claim", id: item.id } })).error.code, "CONFLICT");
});

test("source-qualified native Agent/Chat lifecycle, scoped cancellation and unknown restart require explicit native inspection, never replay", async t => {
  const f = await sharedFixture(t);
  const restored = (await call(f.runtime.core, "agent.snapshot.restore-paused", f.restoreArgs())).result;
  assert.ok(restored);
  const owner = { actorId: human.id, nativeOwnerId: f.binding.nativeOwnerId }, token = {}, handles = new Map();
  const makeNative = () => createAgentRuntime(f.database, {
    tasks: [{ key: "batch14.qualified-local", title: "Source-qualified synthetic local lifecycle", capabilities: [] }],
    assertOwner: () => { assert.ok(f.storage.workspaceLease()); }, now: () => at,
    host: {
      resolveOwner: value => value === token ? owner : undefined,
      spawn: async invocation => { assert.equal(f.database.isTransaction, false); handles.set(invocation.sessionId, "running");
        return { state: "running", handle: invocation.sessionId }; },
      inspect: async invocation => ({ state: handles.get(invocation.sessionId) ?? "unknown", handle: invocation.sessionId }),
      cancel: async invocation => { handles.set(invocation.sessionId, "cancelled"); },
    },
  });
  let native = makeNative();
  let mapped, resumes = 0, cancels = 0, uncertain = true, nativeObserved = false;
  f.pausedPolicy.control = {
    resume: async (binding, stage) => {
      resumes++; assert.deepEqual(stage.checkpoints, f.captured.session.checkpoints);
      const chat = createChatSessionStore(f.database).execute({ operation: "chat.session.get", args: { id: binding.targetChatId } }, human.id);
      assert.equal(chat.metadata.sessionId, binding.targetSessionId);
      mapped = (await native.spawn(token, { opId: randomUUID(), taskKey: "batch14.qualified-local" })).session;
      if (uncertain) throw new Error("synthetic interrupted native receipt");
    },
    cancel: async () => { cancels++; await native.cancel(token, { opId: randomUUID(), id: mapped.id, expectedRevision: mapped.revision }); },
    inspect: async binding => {
      const actual = native.get(token, { id: mapped.id });
      return { sessionId: binding.targetSessionId, chatId: binding.targetChatId,
        state: !nativeObserved ? "unknown" : actual.state === "cancelled" ? "cancelled" : actual.state === "running" ? "native-controlled" : "unknown" };
    },
  };
  const resume = { opId: randomUUID(), restoreId: restored.restoreId, expectedRevision: restored.revision };
  const resumed = await call(f.runtime.core, "agent.snapshot.resume-native", resume);
  // Optional control is configured before composition construction, not through a public request.
  assert.equal(resumed.error?.code, "NATIVE_MAPPING_UNAVAILABLE");
  await f.restart();
  native = makeNative();
  const io = await transports(t, f.runtime.core);
  const unknown = await io.http("agent.snapshot.resume-native", resume);
  assert.equal(unknown.result.state, "resume-unknown");
  assert.equal(resumes, 1);
  assert.equal((await io.mcp("legacy.note.workitems.command", { slug: "Original", expected_digest: hash(await f.read()),
    operationId: randomUUID(), command: { action: "create", item } })).error.code, "RECOVERY_REQUIRED");
  await io.close();
  await f.restart();
  native = makeNative();
  assert.equal(resumes, 1);
  const fresh = await transports(t, f.runtime.core);
  const confirmation = { opId: randomUUID(), restoreId: restored.restoreId, expectedRevision: unknown.result.revision };
  assert.equal((await fresh.mcp("agent.snapshot.confirm-native", confirmation)).result.state, "resume-unknown");
  nativeObserved = true; uncertain = false;
  assert.equal((await fresh.http("agent.snapshot.confirm-native", confirmation)).result.state, "native-controlled");
  const current = (await fresh.mcp("agent.snapshot.restore-get", { restoreId: restored.restoreId }, "capability_read")).result;
  const cancelled = await fresh.http("agent.snapshot.cancel-native", { opId: randomUUID(), restoreId: current.restoreId, expectedRevision: current.revision });
  assert.equal(cancelled.result.state, "cancelled");
  assert.equal(cancels, 1); assert.equal(resumes, 1);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM legacy_snapshot_restore_effects WHERE state='unknown'").get().n, 0);
});

test("original encrypted unsupported Chat state reaches native transport and is rejected without staging or replay", async t => {
  for (const mutate of [
    payload => { payload.session.nativeChat.plans = []; },
    payload => { payload.session.nativeChat.messages[0].invocationBudgets = []; },
    payload => { payload.session.liveness = { owner: { transportId: "retired-synthetic" } }; },
  ]) {
    const f = await sharedFixture(t, mutate), io = await transports(t, f.runtime.core);
    const result = await io.mcp("agent.snapshot.restore-paused", f.restoreArgs());
    assert.equal(result.error.code, "UNSUPPORTED_STATE");
    for (const table of ["legacy_snapshot_restore_originals", "legacy_snapshot_restore_records", "legacy_snapshot_restore_staging",
      "legacy_snapshot_restore_receipts", "legacy_snapshot_restore_effects", "chat_sessions"])
      assert.equal(f.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
    assert.deepEqual(await readFile(join(f.root, "agent-snapshot-reads/.pkm/state/agent-snapshots", `${f.snapshot.snapshotId}.json`)), f.ciphertext);
  }
});

test("an explicitly admitted attached Board retains its existing canonical bridge; inline-only admission never converts Board authority", async t => {
  const f = await sharedFixture(t);
  const slug = "Attached", note = "---\r\ntitle: Attached\r\ndocumentKind: todo-board\r\n---\r\n# Original Board note\r\n";
  const board = serializeTodoBoard([item]);
  await mkdir(join(f.root, "notes/Attached.assets"));
  await mkdir(join(f.root, "boards/Attached"), { recursive: true });
  await writeFile(join(f.root, "notes/Attached.md"), note);
  await writeFile(join(f.root, "notes/Attached.assets/pkm-todo-board.json"), board);
  await writeFile(join(f.root, "boards/Attached/pkm-todo-board.json"), board);
  f.inlinePolicy.admissions.push({ slug, sourceMarkdownDigest: hash(note) });
  await f.restart();
  const rejected = await call(f.runtime.core, "legacy.note.workitems.command", {
    slug, expected_digest: readTodoBoard(board).digest, operationId: randomUUID(), command: { action: "claim", id: item.id },
  }, actor);
  assert.equal(rejected.error.code, "NOT_AVAILABLE");
  f.nativeOptions.legacyNoteWorkItems = {
    admissions: [{ slug, sourceMarkdownDigest: hash(note), sourceBoardDigest: hash(board), nativeBoardDigest: hash(board) }],
    authorize: who => who.id === actor.id,
    recoveryActor: () => actor,
  };
  await f.restart();
  const io = await transports(t, f.runtime.core, actor), request = {
    slug, expected_digest: readTodoBoard(board).digest, operationId: randomUUID(), command: { action: "claim", id: item.id },
  };
  const result = await io.mcp("legacy.note.workitems.command", request);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.result.items[0].ownerId, actor.id);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM legacy_inline_note_receipt").get().n, 0);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM legacy_note_workitems_receipt").get().n, 1);
  assert.equal(await readFile(join(f.root, "notes/Attached.md"), "utf8"), note);
  assert.equal(await readFile(join(f.root, "notes/Attached.assets/pkm-todo-board.json"), "utf8"), board);
  assert.deepEqual((await io.http("legacy.note.workitems.command", request)).result, result.result);
});
