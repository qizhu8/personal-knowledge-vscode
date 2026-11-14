import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { createChatSessionStore, initializeChatSessionSchema, CHAT_SESSION_TABLES } from "../dist/chat-session.js";
import { chatSessionDefinitions, CHAT_SESSION_LIMITS } from "../dist/chat-session-contracts.js";
import { chatSessionApiFixture, chatSessionExpected, chatSessionFixture as fixture } from "./chat-session-fixtures.mjs";
import { checkCaptureRecords } from "../scripts/migration.mjs";

function harness(t) {
  const directory = resolve("tests", `chat-session-work-${randomUUID()}`);
  mkdirSync(directory);
  const file = resolve(directory, "synthetic.sqlite");
  let db;
  let store;
  function open() {
    db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; BEGIN IMMEDIATE");
    initializeChatSessionSchema(db);
    db.exec("CREATE TABLE IF NOT EXISTS fixture_receipts(operation_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL); COMMIT");
    store = createChatSessionStore(db, { now: () => chatSessionExpected.now });
  }
  open();
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const api = {
    get db() { return db; }, file,
    reopen() { db.close(); open(); },
    raw(request, actorId = fixture.actorId) { return store.execute(request, actorId); },
    call(request, actorId = fixture.actorId) {
      const definition = chatSessionDefinitions.find(item => item.id === request.operation);
      if (definition.readOnly) return definition.output.parse(store.execute(request, actorId));
      db.exec("BEGIN IMMEDIATE");
      try {
        const key = request.args.operationId;
        const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
        const previous = db.prepare("SELECT * FROM fixture_receipts WHERE operation_id=?").get(key);
        if (previous) {
          if (previous.actor_id !== actorId || previous.fingerprint !== fingerprint) throw Object.assign(new Error("Receipt conflict"), { code: "CONFLICT" });
          db.exec("COMMIT");
          return definition.output.parse(JSON.parse(previous.result));
        }
        const result = definition.output.parse(store.execute(request, actorId));
        db.prepare("INSERT INTO fixture_receipts VALUES(?,?,?,?)").run(key, actorId, fingerprint, JSON.stringify(result));
        db.exec("COMMIT");
        return result;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
  return api;
}
const request = (operation, args) => ({ operation: `chat.session.${operation}`, args });
function append(expectedRevision, id, content = "fixture", extra = {}) {
  return request("append", {
    operationId: randomUUID(), id: fixture.create.args.id, expectedRevision,
    message: { id, role: "assistant", content, status: "complete", ...extra },
  });
}
function code(expected) { return error => error.code === expected; }

test("fresh shared database, exact public fixtures, receipt replay, durable reopen and archive", t => {
  const h = harness(t);
  assert.deepEqual(CHAT_SESSION_TABLES, ["chat_session_schema", "chat_sessions", "chat_session_messages"]);
  assert.deepEqual(h.call(fixture.create), chatSessionExpected.created);
  assert.equal(h.call(fixture.get).id, fixture.create.args.id);
  assert.deepEqual(h.call(fixture.list).items, [chatSessionExpected.created]);
  const appended = h.call(fixture.append);
  assert.equal(appended.message.sequence, 1);
  assert.deepEqual(h.call(fixture.append), appended);
  h.reopen();
  assert.deepEqual(h.call(fixture.append), appended);
  const page = h.call(fixture.messages);
  assert.deepEqual(page.items, [appended.message]);
  assert.deepEqual(page.items[0].metadata, fixture.append.args.message.metadata);
  assert.equal(page.lastSequence, 1);
  const archive = h.call(fixture.archive);
  assert.equal(archive.revision, 3);
  assert.equal(archive.archivedAt, chatSessionExpected.now);
  assert.equal(h.call(fixture.list).items.length, 0);
  assert.equal(h.call(request("list", { includeArchived: true })).items.length, 1);
  assert.throws(() => h.call(append(3, "after-archive")), code("CONFLICT"));
  h.reopen();
  assert.deepEqual(h.call(fixture.get), archive);
  assert.deepEqual(h.call(fixture.messages).items, [appended.message]);
  assert.equal(Number(h.db.prepare("PRAGMA user_version").get().user_version), 0, "component never owns parent schema version");
});

test("complete HTTP/MCP fixture sequence has schema-valid exact store responses", t => {
  const h = harness(t);
  for (const step of chatSessionApiFixture.steps) {
    assert.deepEqual(h.call(step.storeRequest), step.expectedResult);
    assert.deepEqual(step.http.body, step.mcp.arguments);
    assert.equal(step.http.path, `/v1/${step.mcp.name}`);
    const definition = chatSessionDefinitions.find(item => item.id === step.storeRequest.operation);
    assert(definition.input.safeParse(step.http.body.arguments).success);
  }
});

test("mutations require UUID operation IDs, CAS and parent transaction; failed parent receipt rolls back state", t => {
  const h = harness(t);
  assert.throws(() => h.raw(fixture.create), code("TRANSACTION_REQUIRED"));
  assert.throws(() => h.call({ ...fixture.create, args: { ...fixture.create.args, operationId: "bad" } }), code("INVALID_INPUT"));
  h.db.exec("BEGIN IMMEDIATE");
  h.raw(fixture.create);
  h.db.exec("ROLLBACK");
  assert.throws(() => h.call(fixture.get), code("NOT_FOUND"));
  h.call(fixture.create);
  h.call(fixture.append);
  assert.throws(() => h.call(append(1, "stale")), code("CONFLICT"));
  assert.throws(() => h.call(append(2, fixture.append.args.message.id)), code("CONFLICT"));
  assert.throws(() => h.call({ ...fixture.append, args: { ...fixture.append.args, message: { ...fixture.append.args.message, content: "changed" } } }), code("CONFLICT"));
  assert.equal(h.call(fixture.messages).items.length, 1);
});

test("two simultaneous SQLite writers serialize CAS; exactly one append commits", async t => {
  const h = harness(t);
  h.call(fixture.create);
  const storeUrl = new URL("../dist/chat-session.js", import.meta.url).href;
  const workerSource = `
    const {parentPort,workerData}=require("node:worker_threads");
    (async()=>{
      const {DatabaseSync}=await import("node:sqlite");
      const {createChatSessionStore}=await import(workerData.storeUrl);
      const db=new DatabaseSync(workerData.file);
      db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
      parentPort.postMessage({ready:true});
      parentPort.once("message",()=>{
        let result;
        try { db.exec("BEGIN IMMEDIATE"); createChatSessionStore(db).execute(workerData.request,workerData.actor);
          db.exec("COMMIT"); result="committed";
        } catch(error) {if(db.isTransaction) db.exec("ROLLBACK"); result=error.code||error.message;}
        db.close(); parentPort.postMessage({result});
      });
    })().catch(error=>{throw error;});
  `;
  const workers = [0, 1].map(index => new Worker(workerSource, { eval: true, workerData: {
    storeUrl, file: h.file, actor: fixture.actorId, request: append(1, `simultaneous-${index}`),
  } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
    worker.once("error", reject); worker.once("message", resolve);
  })));
  const results = workers.map(worker => new Promise((resolve, reject) => {
    worker.once("error", reject); worker.once("message", value => resolve(value.result));
  }));
  for (const worker of workers) worker.postMessage("go");
  assert.deepEqual((await Promise.all(results)).sort(), ["CONFLICT", "committed"]);
  assert.equal(h.call(fixture.messages).items.length, 1);
  h.reopen();
  assert.equal(h.call(fixture.get).revision, 2);
});

test("ordered reconnect cursors do not duplicate and survive reopen/new appends", t => {
  const h = harness(t);
  h.call(fixture.create);
  for (let index = 0; index < 7; index++) h.call(append(index + 1, `ordered-${index}`));
  const first = h.call(request("messages", { id: fixture.create.args.id, limit: 3 }));
  assert.deepEqual(first.items.map(item => item.sequence), [1, 2, 3]);
  h.reopen();
  const second = h.call(request("messages", { id: fixture.create.args.id, limit: 3, cursor: first.nextCursor }));
  assert.deepEqual(second.items.map(item => item.sequence), [4, 5, 6]);
  const third = h.call(request("messages", { id: fixture.create.args.id, cursor: second.nextCursor }));
  assert.deepEqual(third.items.map(item => item.sequence), [7]);
  const empty = h.call(request("messages", { id: fixture.create.args.id, cursor: third.nextCursor }));
  assert.equal(empty.items.length, 0);
  assert.equal(empty.nextCursor, third.nextCursor);
  h.call(append(8, "new-after-reconnect"));
  assert.deepEqual(h.call(request("messages", { id: fixture.create.args.id, cursor: empty.nextCursor })).items.map(item => item.sequence), [8]);
  assert.throws(() => h.call(request("messages", { id: fixture.create.args.id, afterSequence: 999 })), code("CURSOR_LOST"));
  assert.throws(() => h.call(request("messages", { id: fixture.create.args.id, cursor: "invalid" })), code("CURSOR_INVALID"));
  h.db.prepare("DELETE FROM chat_session_messages WHERE actor_id=? AND chat_id=? AND sequence=2").run(fixture.actorId, fixture.create.args.id);
  assert.throws(() => h.call(fixture.messages), code("CURSOR_LOST"));
});

test("trusted actor partition, strict authority exclusion, cross-query cursors and stale list cursors", t => {
  const h = harness(t);
  h.call(fixture.create);
  h.call(fixture.append);
  const privateCursor = h.call(fixture.messages).nextCursor;
  assert.throws(() => h.call(fixture.get, "other-actor"), code("NOT_FOUND"));
  assert.equal(h.call(fixture.list, "other-actor").items.length, 0);
  const otherCreate = { ...fixture.create, args: { ...fixture.create.args, operationId: randomUUID() } };
  h.call(otherCreate, "other-actor");
  assert.throws(() => h.call(request("messages", { id: fixture.create.args.id, cursor: privateCursor }), "other-actor"), code("CURSOR_INVALID"));
  assert.equal(h.call(fixture.messages, "other-actor").items.length, 0);
  assert.throws(() => h.raw({ ...fixture.get, args: { ...fixture.get.args, actorId: fixture.actorId } }, "other-actor"), code("INVALID_INPUT"));
  assert.throws(() => h.raw(fixture.get, ""), code("UNAUTHORIZED"));
  assert.throws(() => h.call({ ...fixture.create, args: { ...fixture.create.args, operationId: randomUUID(), id: "authority", permissionGrants: ["*"] } }), code("INVALID_INPUT"));
  for (let index = 0; index < 2; index++) h.call({
    ...fixture.create, args: { ...fixture.create.args, operationId: randomUUID(), id: `list-${index}` },
  });
  const list = h.call(request("list", { limit: 1 }));
  assert.equal(list.items.length, 1);
  assert(list.nextCursor);
  const page = h.call(request("list", { limit: 1, cursor: list.nextCursor }));
  assert.notEqual(page.items[0].id, list.items[0].id);
  assert.throws(() => h.call(request("messages", { id: fixture.create.args.id, cursor: list.nextCursor })), code("CURSOR_INVALID"));
  h.call(append(2, "stales-list"));
  assert.throws(() => h.call(request("list", { limit: 1, cursor: list.nextCursor })), code("CURSOR_STALE"));
});

test("portable metadata and inert recorded tool observations survive reopen without tool replay", t => {
  const h = harness(t);
  h.call(fixture.create);
  const result = h.call(append(1, "interrupted", "Recorded partial result", {
    status: "streaming", recordedAt: chatSessionExpected.now, taskId: "task-1", inputId: "input-1",
    model: "fixture-model", contextLabels: ["Synthetic context"], elapsedMs: 125,
    metadata: {
      schema: "pkm.chat.transcript-metadata/v1",
      usage: { inputTokens: 10, outputTokens: 3 },
      retrieval: { schema: "pkm.chat.retrieval/v1", selectedCount: 1, candidates: [] },
      reasoningSummaries: [{ round: 1, text: "Recorded summary" }],
    },
    toolCalls: [{ id: "uncertain-call", name: "run_process", arguments: '{"fixture":true}', status: "running" }],
  }));
  assert.equal(result.message.status, "interrupted");
  assert.equal(result.message.toolCalls[0].status, "failed");
  assert.match(result.message.toolCalls[0].result, /may already have occurred/);
  assert.equal(result.message.replay, "never");
  h.reopen();
  assert.deepEqual(h.call(fixture.messages).items, [result.message]);
  const capabilities = h.call(request("capabilities", {}));
  assert.equal(capabilities.generation, "unavailable");
  assert(capabilities.unavailable.includes("tool-execution"));
});

test("UTF-8 message/page bounds, bounded JSON depth and unknown stored schemas fail closed", t => {
  const h = harness(t);
  h.call(fixture.create);
  assert.throws(() => h.call(append(1, "oversize", "中".repeat(50_000))), code("LIMIT_EXCEEDED"));
  assert.equal(h.call(fixture.get).revision, 1);
  for (let index = 0; index < 6; index++) h.call(append(index + 1, `unicode-${index}`, "中".repeat(40_000)));
  const page = h.call(request("messages", { id: fixture.create.args.id, limit: 100 }));
  assert.equal(page.items.length, 4);
  assert(page.hasMore);
  assert(Buffer.byteLength(JSON.stringify(page.items)) < CHAT_SESSION_LIMITS.pageBytes);
  assert.throws(() => h.call(request("messages", { id: fixture.create.args.id, limit: 101 })), code("INVALID_INPUT"));
  let nested = "leaf";
  for (let index = 0; index < 25; index++) nested = { nested };
  assert.throws(() => h.call(append(7, "too-deep", "", { metadata: { schema: "pkm.chat.transcript-metadata/v1", usage: nested } })), code("INVALID_INPUT"));
  assert.throws(() => h.call(append(7, "unknown-meta", "", { metadata: { schema: "pkm.chat.transcript-metadata/v99" } })), code("INVALID_INPUT"));
  h.db.prepare("UPDATE chat_session_messages SET record=json_set(record,'$.schema','unknown') WHERE sequence=1").run();
  assert.throws(() => h.call(fixture.messages), code("STATE_CORRUPT"));
  h.db.prepare("UPDATE chat_sessions SET record=json_set(record,'$.schema','unknown')").run();
  assert.throws(() => h.call(fixture.get), code("STATE_CORRUPT"));
  h.db.prepare("UPDATE chat_session_schema SET version=999").run();
  assert.throws(() => h.call(fixture.get), code("UNSUPPORTED_SCHEMA"));
  assert.throws(() => h.reopen(), code("UNSUPPORTED_SCHEMA"));
});

test("component schema migration is transactional, independently versioned and repeatable", () => {
  const db = new DatabaseSync(":memory:");
  try {
    assert.throws(() => initializeChatSessionSchema(db), code("TRANSACTION_REQUIRED"));
    db.exec("PRAGMA user_version=123; BEGIN IMMEDIATE");
    initializeChatSessionSchema(db);
    initializeChatSessionSchema(db);
    db.exec("COMMIT");
    assert.equal(Number(db.prepare("PRAGMA user_version").get().user_version), 123);
    assert.equal(Number(db.prepare("SELECT version FROM chat_session_schema").get().version), 1);
  } finally { db.close(); }
});

test("original capture provenance matches both source and captured hashes", async () => {
  const provenance = JSON.parse(readFileSync(new URL("../migration/chat-sessions-provenance.json", import.meta.url), "utf8"));
  assert.deepEqual(await checkCaptureRecords(provenance.files), []);
});
