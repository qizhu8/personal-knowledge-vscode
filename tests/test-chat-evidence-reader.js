const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { readChatToolEvidence } = require("../dist/chat/chat-memory");
const { ApiChatStore } = require("../dist/chat/api-chat-store");
const { spawnSync } = require("node:child_process");

function message(taskId, callId, result, status = "complete") {
  return { id:randomUUID(), role:"assistant", content:"", taskId, status:"failed",
    toolCalls:[{ id:callId, name:"recorded-operation", arguments:'{"path":"original"}', status, result }] };
}
test("CTX-M13/M17: real store restart resolves original failed-response evidence; missing/stale/foreign IDs fail without replay", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-evidence-reader-"));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  const namespace = "0123456789abcdef", store = new ApiChatStore(directory, namespace), chat = store.create();
  chat.sessionId = `agent_session_${"a".repeat(32)}`;
  const body = "original output.\r\n".repeat(600) + "\ud83d\ude80 Tail NOT_SAVED: disk full.";
  const own = message(chat.sessionId, "original-call", body), otherTask = message("other-task", "foreign-call", "PRIVATE_OTHER_TASK");
  chat.messages = [own, otherTask];
  chat.includeHistory = true;
  store.save(chat);
  const restarted = new ApiChatStore(directory, namespace).load(chat.id, false);
  const initial = JSON.parse(readChatToolEvidence(restarted, own.id, { callId:"original-call" }));
  assert(initial.truncated);
  const start = body.indexOf("\ud83d\ude80");
  const tail = JSON.parse(readChatToolEvidence(restarted, own.id, { callId:"original-call", start, end:body.length, hash:initial.hash }));
  assert.equal(tail.content, body.slice(start));
  assert.equal(tail.truncated, false);
  assert.equal(tail.status, "complete", "Assistant failure does not erase independent recorded tool completion");
  assert.throws(() => readChatToolEvidence(restarted, own.id, { callId:"original-call", start:start + 1, end:body.length, hash:initial.hash }), /surrogate/);
  assert.throws(() => readChatToolEvidence(restarted, own.id, { callId:"foreign-call" }), /outside the current Task/);
  assert.throws(() => readChatToolEvidence({ ...restarted, id:randomUUID(), messages:[] }, own.id, { callId:"original-call" }), /missing/);
  restarted.messages[0].toolCalls[0].result += "changed";
  assert.throws(() => readChatToolEvidence(restarted, own.id, { callId:"original-call", start, end:body.length, hash:initial.hash }), /changed/);
  restarted.messages = [];
  assert.throws(() => readChatToolEvidence(restarted, own.id, { callId:"original-call" }), /missing/);
});

test("evidence reads honor History off, disambiguate reused call IDs, and retain failed outcomes/arguments", () => {
  const task = "task", first = message(task, "reused", "NOT_SAVED: disk full", "failed");
  const second = message(task, "reused", "Second outcome"), current = message(task, "active", "Running", "running");
  const chat = { sessionId:task, includeHistory:true, messages:[first, second, current] };
  assert.throws(() => readChatToolEvidence(chat, current.id, { callId:"reused" }), /ambiguous/);
  const failed = JSON.parse(readChatToolEvidence(chat, current.id, { callId:"reused", messageId:first.id }));
  assert.equal(failed.status, "failed");
  assert.equal(failed.content, "NOT_SAVED: disk full");
  const args = JSON.parse(readChatToolEvidence(chat, current.id, { callId:"reused", messageId:first.id, kind:"arguments" }));
  assert.equal(args.content, first.toolCalls[0].arguments);
  assert.throws(() => readChatToolEvidence(chat, current.id, { callId:"active" }), /terminal tool evidence/);
  chat.includeHistory = false;
  assert.throws(() => readChatToolEvidence(chat, current.id, { callId:"reused", messageId:first.id }), /History settings/);
  current.toolCalls[0].status = "failed";
  assert.equal(JSON.parse(readChatToolEvidence(chat, current.id, { callId:"active" })).content, "Running");
});

test("evidence ranges reject incomplete/oversized/transport-expanding input explicitly", () => {
  const own = message("task", "range", "\0".repeat(4000));
  const chat = { sessionId:"task", includeHistory:true, messages:[own] };
  const preview = JSON.parse(readChatToolEvidence(chat, own.id, { callId:"range" }));
  assert.equal(preview.truncated, true);
  assert(preview.nextStart > 0 && preview.nextStart < 4000);
  const hash = require("node:crypto").createHash("sha256").update(own.toolCalls[0].result).digest("hex");
  assert.equal(preview.hash, hash, "An expanding preview still exposes a usable handle");
  assert.throws(() => readChatToolEvidence(chat, own.id, { callId:"range", start:0, end:4000, hash }), /transport boundary/);
  const bounded = JSON.parse(readChatToolEvidence(chat, own.id, { callId:"range", start:0, end:1000, hash }));
  assert.equal(bounded.content.length, 1000);
  assert.equal(bounded.truncated, false, "Explicit exact-range reads are not shortened previews");
  for (const args of [{ start:0 }, { start:0, end:4001 }, { start:-1, end:1 }, { start:2, end:1 }]) {
    assert.throws(() => readChatToolEvidence(chat, own.id, { callId:"range", hash, ...args }), /Exact evidence ranges/);
  }
  delete own.toolCalls[0].result;
  assert.throws(() => readChatToolEvidence(chat, own.id, { callId:"range" }), /original tool evidence is unavailable/);
});

test("default preview preserves surrogate boundaries and exposes a handle for the remaining original text", () => {
  const source = "a".repeat(3999) + "\ud83d\ude80 tail";
  const own = message("task", "unicode", source), chat = { sessionId:"task", includeHistory:true, messages:[own] };
  const preview = JSON.parse(readChatToolEvidence(chat, own.id, { callId:"unicode" }));
  assert.equal(preview.content, "a".repeat(3999));
  assert.equal(preview.nextStart, 3999);
  const tail = JSON.parse(readChatToolEvidence(chat, own.id, { callId:"unicode", start:preview.nextStart, end:source.length, hash:preview.hash }));
  assert.equal(tail.content, "\ud83d\ude80 tail");
});

test("legacy duplicate tool IDs inside one stored response fail explicitly even with a response handle", () => {
  const own = message("task", "duplicate", "First recorded outcome");
  own.toolCalls.push({ ...own.toolCalls[0], result:"Conflicting recorded outcome" });
  const chat = { sessionId:"task", includeHistory:true, messages:[own] };
  assert.throws(() => readChatToolEvidence(chat, own.id, { callId:"duplicate", messageId:own.id }), /ambiguous/);
});

test("CTX-M17: abrupt owner-process exit preserves terminal evidence and explicitly marks unknown in-flight effects", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-crashed-evidence-"));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  const child = spawnSync(process.execPath, ["-e", `
    const { ApiChatStore } = require(process.argv[1]);
    const { randomUUID } = require("node:crypto");
    const store = new ApiChatStore(process.argv[2], "0123456789abcdef"), chat = store.create();
    store.startTask(chat, "Crash evidence acceptance");
    chat.includeHistory = true;
    chat.progress = { attemptId:randomUUID(), attempt:1, status:"running", ownerPid:process.pid,
      ownerHost:require("node:os").hostname(), startedAt:Date.now(), model:"fixture", steps:[] };
    const reply = { id:randomUUID(), role:"assistant", taskId:chat.sessionId, content:"Partial public output", status:"streaming",
      progress:chat.progress, toolCalls:[
        { id:"done-before-exit", name:"write_file", arguments:'{"path":"fixture"}', status:"complete", result:"Original terminal outcome; NOT approved." },
        { id:"pending-at-exit", name:"write_file", arguments:'{"path":"other"}', status:"running" },
      ] };
    chat.messages.push(reply);
    store.save(chat);
    require("node:fs").writeSync(1, JSON.stringify({ chatId:chat.id, replyId:reply.id }));
    process.exit(17);
  `, require.resolve("../dist/chat/api-chat-store"), directory], { encoding:"utf8", timeout:10000 });
  assert.equal(child.status, 17, child.stderr);
  const identity = JSON.parse(child.stdout), store = new ApiChatStore(directory, "0123456789abcdef");
  const chat = store.load(identity.chatId, false);
  assert.equal(store.recoverAbandoned(chat), true);
  assert.equal(chat.messages[0].status, "interrupted");
  assert.equal(chat.messages[0].content, "Partial public output");
  const original = JSON.parse(readChatToolEvidence(chat, identity.replyId, { callId:"done-before-exit" }));
  assert.equal(original.status, "complete");
  assert.equal(original.content, "Original terminal outcome; NOT approved.");
  const unknown = JSON.parse(readChatToolEvidence(chat, identity.replyId, { callId:"pending-at-exit" }));
  assert.equal(unknown.status, "failed");
  assert.match(unknown.content, /Execution may already have occurred/);
  const persisted = new ApiChatStore(directory, "0123456789abcdef").load(identity.chatId, false);
  assert.deepEqual(persisted.messages[0].toolCalls, chat.messages[0].toolCalls);
  assert.throws(() => readChatToolEvidence(persisted, identity.replyId, { callId:"lost-original" }), /missing/);
});
