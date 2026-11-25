import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { ChatTurnToolError } from "../dist/chat-turn.js";
import { createChatTurnDefinitions } from "../dist/chat-turn-contracts.js";
import { chatTurnFixture, chatTurnInput, chatTurnEvents } from "./chat-turn-fixtures.mjs";

const actor = "synthetic-actor";
const textModel = (text = "Synthetic answer.") => ({
  available: true, async *stream() { yield { type: "text", text }; yield { type: "finish", reason: "stop" }; },
});
const toolModel = {
  available: true,
  async *stream(request) {
    if (request.step === 1) {
      yield { type: "text", text: "Checking." };
      yield { type: "tool", id: "call-1", name: "synthetic.tool", arguments: { value: 1 } };
      yield { type: "usage", inputTokens: 50, outputTokens: 20 };
      yield { type: "finish", reason: "tool_calls" };
    } else {
      assert.equal(request.messages.at(-1).role, "tool");
      assert.equal(request.messages.at(-1).tool_call_id, "call-1");
      assert.equal(request.messages.at(-2).tool_calls[0].function.arguments, '{"value":1}');
      yield { type: "text", text: "Verified synthetic result." };
      yield { type: "finish", reason: "stop" };
    }
  },
};

function sessionHarness(t, options = {}) {
  const f = chatTurnFixture({ sessionBacked: true, model: textModel(), ...options });
  t.after(() => f.db.close());
  const call = (operation, args, identity = actor) => f.transaction(() => f.sessions.execute({ operation: `chat.session.${operation}`, args }, identity));
  const sessionId = "synthetic-session";
  call("create", { id: sessionId, title: "Server Chat", operationId: randomUUID(), expectedRevision: 0 });
  return { ...f, call, sessionId, input: extra => chatTurnInput({ expectedSessionRevision: 1, ...extra }) };
}

test("session turns atomically accept input, own context, discover and settle one durable transcript without replay", async t => {
  let dispatches = 0;
  const f = sessionHarness(t, { model: { available: true, async *stream(request) {
    dispatches++;
    assert.equal(f.call("messages", { id: f.sessionId }).items.at(-1).role, "user");
    if (dispatches === 2) assert.deepEqual(request.messages.slice(1).map(item => item.content),
      ["First", "Answer", "Second"]);
    yield { type: "text", text: "Answer" }; yield { type: "finish", reason: "stop" };
  } } });
  const input = f.input({ messages: [{ role: "user", content: "First" }] });
  const accepted = f.service.start(actor, input);
  const context = f.service.events(actor, input.id).events[0].data.sessionContext;
  assert.equal(context.sessionRevision, 2);
  assert.equal(context.authority, "native-host-only");
  assert.equal(context.retrieval.status, "not-injected");
  assert.deepEqual(context.sources.map(source => source.sequence), [1]);
  assert.match(context.sources[0].id, /^[a-f0-9]{64}$/);
  assert.match(context.sources[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(f.call("get", { id: f.sessionId }).revision, 2);
  assert.equal(f.service.activity().active, 1, "transport completion does not prove provider drain");
  assert.throws(() => f.call("archive", { id: f.sessionId, expectedRevision: 2, operationId: randomUUID() }), /owns this transcript/);
  assert.throws(() => f.service.start(actor, f.input({ expectedSessionRevision: 2 })), /owns this transcript/);
  await f.service.settled(actor, input.id);
  assert.equal(f.service.activity().active, 0);
  assert.deepEqual(f.service.start(actor, input), accepted);
  assert.equal(dispatches, 1);
  assert.deepEqual(f.service.list(actor, f.sessionId).items.map(item => item.id), [input.id]);
  assert.throws(() => f.service.list("other", f.sessionId), /not found/);
  const second = f.input({ expectedSessionRevision: 3, messages: [{ role: "user", content: "Second" }] });
  f.service.start(actor, second); await f.service.settled(actor, second.id);
  assert.deepEqual(f.service.events(actor, second.id).events[0].data.sessionContext.sources.map(source => source.sequence), [1, 2, 3]);
  const page = f.service.list(actor, f.sessionId, undefined, 1);
  assert.equal(page.next, input.id);
  assert.equal(f.service.list(actor, f.sessionId, page.next, 1).items[0].id, second.id);
  assert.deepEqual(f.call("messages", { id: f.sessionId }).items.map(item => item.content), ["First", "Answer", "Second", "Answer"]);
});

test("opaque raw turns remain compatible without claiming durable session context or later session history", async t => {
  let dispatches = 0;
  const f = sessionHarness(t, { model: { available: true, async *stream() {
    dispatches++;
    yield { type: "text", text: "Answer" }; yield { type: "finish", reason: "stop" };
  } } });
  const sessionId = "legacy-opaque-session";
  const raw = chatTurnInput({ sessionId, messages: [
    { role: "system", content: "Legacy caller-owned context." }, { role: "user", content: "Raw input" },
  ] });
  assert.throws(() => f.service.start(actor, { ...raw, expectedSessionRevision: 1 }), /not found/);
  const accepted = f.service.start(actor, raw);
  assert.equal(accepted.sessionBacked, undefined);
  assert.deepEqual(accepted.messages, raw.messages);
  assert.equal(f.service.events(actor, raw.id).events[0].data.sessionContext, undefined);
  await f.service.settled(actor, raw.id);
  assert.equal(f.service.get(actor, raw.id).status, "completed");
  assert.throws(() => f.call("get", { id: sessionId }), /not found/);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM chat_session_turn_reservations").get().n, 0);

  f.call("create", { id: sessionId, title: "Later real Chat", operationId: randomUUID(), expectedRevision: 0 });
  assert.deepEqual(f.service.list(actor, sessionId).items, []);
  assert.throws(() => f.service.list(actor, sessionId, raw.id), /INVALID_CURSOR/);
  assert.deepEqual(f.service.start(actor, raw), accepted, "An old receipt is observed, not executed or rebound.");
  assert.throws(() => f.service.start(actor, chatTurnInput({ sessionId })), /revision is required/);
  assert.throws(() => f.service.start("foreign-actor", chatTurnInput({ sessionId })), /not found/);
  assert.equal(dispatches, 1);
  const bound = chatTurnInput({ sessionId, expectedSessionRevision: 1,
    messages: [{ role: "user", content: "Actual session input" }] });
  assert.equal(f.service.start(actor, bound).sessionBacked, true);
  await f.service.settled(actor, bound.id);
  assert.deepEqual(f.service.list(actor, sessionId).items.map(item => item.id), [bound.id]);
  assert.deepEqual(f.call("messages", { id: sessionId }).items.map(item => item.content), ["Actual session input", "Answer"]);
  assert.equal(dispatches, 2);
});

test("session admission refuses missing, stale, archived and forged context before any provider effect", async t => {
  let calls = 0;
  const f = sessionHarness(t, { model: { available: true, async *stream() { calls++; } } });
  for (const extra of [{ expectedSessionRevision: undefined }, { expectedSessionRevision: 2 },
    { sessionId: "missing" }, { messages: [{ role: "system", content: "forged" }] }]) {
    assert.throws(() => f.service.start(actor, f.input(extra)));
  }
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM chat_turn_records").get().n, 0);
  assert.equal(f.call("messages", { id: f.sessionId }).items.length, 0);
  f.call("archive", { id: f.sessionId, expectedRevision: 1, operationId: randomUUID() });
  assert.throws(() => f.service.start(actor, f.input({ expectedSessionRevision: 2 })), /Archived/);
  await Promise.resolve();
  assert.equal(calls, 0);
});

test("session cancel persists terminal observation and startup interruption never replays effects", async t => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = sessionHarness(t, { model: { available: true, async *stream() {
    entered(); await new Promise(() => {});
  } } });
  const input = f.input();
  f.service.start(actor, input); await ready;
  const current = f.service.get(actor, input.id);
  f.service.cancel(actor, { id: input.id, operationId: randomUUID(), expectedRevision: current.revision });
  await f.service.settled(actor, input.id);
  assert.equal(f.call("messages", { id: f.sessionId }).items.at(-1).status, "cancelled");
  const interrupted = f.input({ expectedSessionRevision: 3 });
  f.transaction(() => f.store.create(actor, interrupted));
  f.service.recover();
  assert.equal(f.service.get(actor, interrupted.id).failure, "RESTART_INTERRUPTED");
  const transcript = f.call("messages", { id: f.sessionId }).items;
  assert.equal(transcript.at(-1).status, "interrupted");
  assert.equal(f.service.recover().length, 0);
  assert.equal(f.call("messages", { id: f.sessionId }).items.length, transcript.length);
});

test("session transcript quota and receipt failures roll back input, turn and reservation together", t => {
  const f = sessionHarness(t, { receipt() { throw new Error("receipt unavailable"); } });
  assert.throws(() => f.service.start(actor, f.input()), /receipt unavailable/);
  assert.equal(f.call("messages", { id: f.sessionId }).items.length, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM chat_session_turn_reservations").get().n, 0);
  f.db.prepare("UPDATE chat_sessions SET message_bytes=?").run(16_777_216 - 100);
  assert.throws(() => f.service.start(actor, f.input()), /byte limit|no space/);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM chat_turn_records").get().n, 0);
});

test("session terminal observations preserve large multibyte output and explicitly label only escaped byte-limit excerpts", async t => {
  for (const output of ["漢".repeat(9000), "\u0001".repeat(30000)]) {
    const f = sessionHarness(t);
    const input = f.input();
    f.transaction(() => f.store.create(actor, input));
    f.transaction(() => f.store.change(actor, input.id, 1, randomUUID(), "complete", {}, record => {
      record.status = "completed"; record.output = output; record.outputBytes = Buffer.byteLength(output);
    }));
    const terminal = f.call("messages", { id: f.sessionId }).items.at(-1);
    const turn = f.service.get(actor, input.id);
    assert.equal(turn.output, output);
    if (output.startsWith("漢")) assert.equal(terminal.content, output);
    else {
      assert(output.startsWith(terminal.content));
      assert(terminal.content.length < output.length);
      assert.match(terminal.contextLabels[0], /full output is retained/);
    }
  }
});

test("session composition interrupts pre-upgrade raw turns without inventing accepted transcript history", t => {
  const f = sessionHarness(t);
  const raw = chatTurnFixture({ db: f.db });
  const input = chatTurnInput({ sessionId: "pre-upgrade-unvalidated-session" });
  raw.transaction(() => raw.store.create(actor, input));
  assert.equal(f.service.recover()[0].status, "unknown");
  assert.equal(f.service.get(actor, input.id).failure, "RESTART_INTERRUPTED");
  assert.equal(f.call("messages", { id: f.sessionId }).items.length, 0);
});

test("full streaming model -> native approval -> tool -> second inference with durable events and receipts", async t => {
  let fixture, calls = 0;
  fixture = chatTurnFixture({
    model: toolModel,
    tools: {
      available: true,
      async execute(request) {
        calls++;
        assert.equal(fixture.db.isTransaction, false);
        const intent = fixture.service.get(actor, request.turnId);
        assert.equal(intent.status, "tool");
        assert.equal(intent.pendingTool.operationId, request.operationId);
        assert(fixture.db.prepare("SELECT 1 FROM synthetic_parent_receipts WHERE operation_id=?")
          .get(chatTurnEvents(fixture.service, actor, request.turnId).at(-1).operationId));
        request.onApproval({ executionId: "execution-1", status: "pending" });
        await Promise.resolve();
        request.onApproval({ executionId: "execution-1", status: "approved" });
        return { executionId: "execution-1", content: "Synthetic approved result." };
      },
    },
  });
  t.after(() => fixture.db.close());
  const input = chatTurnInput();
  const start = fixture.service.start(actor, input);
  assert.equal(start.status, "queued");
  assert.equal(fixture.service.get(actor, input.id).status, "queued");
  const done = await fixture.service.settled(actor, input.id);
  assert.equal(done.status, "completed");
  assert.equal(done.output, "Checking.Verified synthetic result.");
  assert.equal(done.step, 2);
  assert.equal(calls, 1);
  const events = chatTurnEvents(fixture.service, actor, input.id);
  assert.deepEqual(events.filter(event => event.type === "approval").map(event => event.data.status), ["pending", "approved"]);
  assert.equal(events.at(-1).sequence, done.revision);
  assert.equal(fixture.db.prepare("SELECT count(*) AS n FROM synthetic_parent_receipts").get().n, events.length);
  assert.deepEqual(fixture.service.start(actor, input), start);
  await fixture.service.settled(actor, input.id);
  assert.equal(calls, 1, "Receipt replay never dispatches.");
  assert.throws(() => fixture.service.get("another-actor", input.id), /NOT_FOUND/);
  assert.throws(() => fixture.service.events("another-actor", input.id), /NOT_FOUND/);
  assert.throws(() => fixture.service.events(actor, input.id, done.lastSequence + 1), /INVALID_CURSOR/);
});

test("unconfigured providers are unavailable and public schemas expose no approval/result authority or attachments", t => {
  const f = chatTurnFixture();
  t.after(() => f.db.close());
  assert.throws(() => f.service.start(actor, chatTurnInput()), /PROVIDER_UNAVAILABLE/);
  assert(!createChatTurnDefinitions().some(definition => definition.id === "chat.turn.start"));
  const definitions = createChatTurnDefinitions(true);
  assert.equal(definitions.length, 5);
  assert(!definitions.some(definition => /approve|result|resume/.test(definition.id)));
  assert.equal(definitions[0].input.safeParse({ ...chatTurnInput(), attachments: [] }).success, false);
});

test("CAS cancellation is durable, aborts native stream, and cannot be overwritten by late output", async t => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const f = chatTurnFixture({ model: { available: true, async *stream(request) {
    entered(request.signal);
    await blocked;
    yield { type: "text", text: "Late result." };
    yield { type: "finish", reason: "stop" };
  } } });
  t.after(() => f.db.close());
  const input = chatTurnInput();
  f.service.start(actor, input);
  const signal = await ready;
  const running = f.service.get(actor, input.id);
  assert.throws(() => f.service.cancel(actor, { id: input.id, expectedRevision: 1, operationId: randomUUID() }), /REVISION_CONFLICT/);
  const cancel = { id: input.id, expectedRevision: running.revision, operationId: randomUUID() };
  const cancelled = f.service.cancel(actor, cancel);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(signal.aborted, true);
  assert.deepEqual(f.service.cancel(actor, cancel), cancelled);
  assert.equal((await f.service.settled(actor, input.id)).status, "cancelled");
  assert(f.service.activity().active > 0, "Cancellation of observation does not retire an ignored-abort provider.");
  f.service.closeAdmission();
  assert.throws(() => f.service.start(actor, chatTurnInput()), /CLOSED/);
  assert(f.service.activity().active > 0, "Closing admission is not a claim that external effects retired.");
  await assert.rejects(f.service.close(), /EFFECTS_NOT_RETIRED/);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.activity().active, 0);
  await f.service.close();
  assert.equal(f.service.get(actor, input.id).output, "");
});

test("tool cancellation/uncertain result is never replayed and restart preserves the unknown effect", async t => {
  const directory = resolve("tests", `chat-turn-work-${randomUUID()}`);
  mkdirSync(directory);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = resolve(directory, "state.sqlite");
  let effects = 0;
  let f = chatTurnFixture({ path, model: toolModel, tools: {
    available: true, async execute() { effects++; throw new Error("Uncertain native tool error with secret details."); },
  } });
  const input = chatTurnInput();
  f.service.start(actor, input);
  const unknown = await f.service.settled(actor, input.id);
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.failure, "NATIVE_DEPENDENCY_FAILED");
  assert.equal(unknown.uncertain, true);
  assert(unknown.pendingTool);
  const before = chatTurnEvents(f.service, actor, input.id);
  f.db.close();
  f = chatTurnFixture({ path, model: toolModel, tools: { available: true, async execute() { effects++; throw new Error(); } } });
  t.after(() => f.db.close());
  assert.equal(f.service.recover().length, 0);
  assert.equal(f.service.get(actor, input.id).status, "unknown");
  assert.deepEqual(chatTurnEvents(f.service, actor, input.id), before);
  f.service.start(actor, input);
  await f.service.settled(actor, input.id);
  assert.equal(effects, 1);
});

test("durable reopen marks queued and in-flight intents unknown without invoking dependencies", t => {
  const directory = resolve("tests", `chat-turn-work-${randomUUID()}`);
  mkdirSync(directory);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = resolve(directory, "state.sqlite");
  let f = chatTurnFixture({ path });
  const queued = chatTurnInput();
  const tool = chatTurnInput();
  f.transaction(() => {
    f.store.create(actor, queued);
    f.store.create(actor, tool);
    f.store.change(actor, tool.id, 1, randomUUID(), "tool-intent", {}, record => {
      record.status = "tool";
      record.pendingTool = { operationId: randomUUID(), call: { id: "call-1", name: "synthetic.tool", arguments: {} } };
    });
  });
  f.db.close();
  let calls = 0;
  f = chatTurnFixture({ path, model: { available: true, async *stream() { calls++; } } });
  t.after(() => f.db.close());
  assert.equal(f.service.get(actor, queued.id).status, "queued", "Reads themselves never mutate/recover.");
  assert.equal(f.service.recover().length, 2);
  assert.equal(f.service.get(actor, queued.id).status, "unknown");
  assert.equal(f.service.get(actor, tool.id).status, "unknown");
  assert.equal(calls, 0);
  assert.equal(f.service.recover().length, 0);
});

test("parent receipt failure rolls back both intent and events before any external effect", async t => {
  let external = 0;
  const f = chatTurnFixture({
    model: { available: true, async *stream() { external++; } },
    receipt() { throw new Error("Parent receipt unavailable."); },
  });
  t.after(() => f.db.close());
  const input = chatTurnInput();
  assert.throws(() => f.service.start(actor, input), /Parent receipt/);
  assert.throws(() => f.service.get(actor, input.id), /NOT_FOUND/);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM chat_turn_events").get().n, 0);
  await Promise.resolve();
  assert.equal(external, 0);
  assert.throws(() => f.store.create(actor, input), /TRANSACTION_REQUIRED/);
});

test("invalid completions, duplicate calls, truncated streams, bounds and native refusal fail explicitly without dispatch", async t => {
  const cases = [
    { events: [{ type: "text", text: "Partial" }], failure: "INCOMPLETE_STREAM" },
    { events: [{ type: "finish", reason: "stop" }], failure: "INVALID_COMPLETION" },
    { events: [{ type: "text", text: "Partial" }, { type: "finish", reason: "length" }], failure: "OUTPUT_TRUNCATED" },
    { events: [{ type: "usage", inputTokens: -1, outputTokens: 1 }], failure: "INVALID_USAGE" },
    { events: [{ type: "tool", id: "same", name: "tool", arguments: {} }, { type: "tool", id: "same", name: "tool", arguments: {} }], failure: "INVALID_TOOL_CALL" },
    { events: [{ type: "text", text: "x".repeat(100) }], extra: { maxOutputTokens: 10 }, failure: "OUTPUT_LIMIT" },
    { events: [], extra: { maxInputTokens: 1 }, failure: "INPUT_TOKEN_LIMIT" },
  ];
  for (const item of cases) {
    let effects = 0;
    const f = chatTurnFixture({
      model: { available: true, async *stream() { for (const event of item.events) yield event; } },
      tools: { available: true, async execute() { effects++; throw new Error(); } },
    });
    t.after(() => f.db.close());
    const input = chatTurnInput(item.extra);
    f.service.start(actor, input);
    const result = await f.service.settled(actor, input.id);
    assert.equal(result.status, "failed");
    assert.equal(result.failure, item.failure);
    assert.equal(effects, 0);
  }
});

test("native denial is failed/not-committed; in-flight deadline is unknown and does not wait forever", async t => {
  for (const uncertain of [false, true]) {
    const f = chatTurnFixture({
      model: toolModel,
      tools: { available: true, async execute(request) {
        request.onApproval({ executionId: "execution-1", status: "pending" });
        if (uncertain) return new Promise(() => {});
        request.onApproval({ executionId: "execution-1", status: "denied" });
        throw new ChatTurnToolError("not-committed", "APPROVAL_DENIED");
      } },
    });
    t.after(() => f.db.close());
    const input = chatTurnInput({ deadlineMs: uncertain ? 25 : 5000 });
    f.service.start(actor, input);
    const result = await f.service.settled(actor, input.id);
    assert.equal(result.status, uncertain ? "unknown" : "failed");
    assert.equal(result.failure, uncertain ? "DEADLINE_EXCEEDED" : "APPROVAL_DENIED");
    assert.equal(result.uncertain, uncertain);
  }
});

test("hard step and event caps stop loops, preserve evidence and reserve space for terminal failure", async t => {
  let effects = 0;
  const f = chatTurnFixture({
    model: { available: true, async *stream(request) {
      yield { type: "tool", id: `call-${request.step}`, name: "synthetic.tool", arguments: {} };
      yield { type: "finish", reason: "tool_calls" };
    } },
    tools: { available: true, async execute() { effects++; return { executionId: "execution", content: "done" }; } },
  });
  t.after(() => f.db.close());
  const input = chatTurnInput({ maxSteps: 2 });
  f.service.start(actor, input);
  const done = await f.service.settled(actor, input.id);
  assert.equal(done.failure, "STEP_LIMIT");
  assert.equal(effects, 2);
  const g = chatTurnFixture({ model: { available: true, async *stream() {
    for (let index = 0; index < 2050; index++) yield { type: "text", text: "x" };
    yield { type: "finish", reason: "stop" };
  } } });
  t.after(() => g.db.close());
  const noisy = chatTurnInput({ deadlineMs: 20000 });
  g.service.start(actor, noisy);
  const exhausted = await g.service.settled(actor, noisy.id);
  assert.equal(exhausted.status, "failed");
  assert.equal(exhausted.failure, "EVENT_LIMIT");
  assert(exhausted.lastSequence <= 2048);
});

test("tool results preserve the original UTF-16 length boundary and failure response", async t => {
  for (const [label, result, failed] of [
    ["16000 ASCII characters", "x".repeat(16000), false],
    ["16001 ASCII characters", "x".repeat(16001), true],
    ["12000 multibyte characters", "汉".repeat(12000), false],
    ["non-string result", 42, true],
  ]) await t.test(label, async t => {
    const model = {
      available: true,
      async *stream(request) {
        if (request.step === 1) {
          yield { type: "tool", id: "call-1", name: "synthetic.tool", arguments: {} };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          const content = request.messages.at(-1).content;
          if (failed) assert.deepEqual(JSON.parse(content), { error: "Tool result exceeded the local limit." });
          else assert.equal(content, result);
          yield { type: "text", text: "Handled." };
          yield { type: "finish", reason: "stop" };
        }
      },
    };
    const fixture = chatTurnFixture({ model, tools: { available: true,
      async execute() { return { executionId: "execution-1", content: result }; } } });
    t.after(() => fixture.db.close());
    const input = chatTurnInput();
    fixture.service.start(actor, input);
    const done = await fixture.service.settled(actor, input.id);
    assert.equal(done.status, "completed", JSON.stringify(done));
    assert.equal(done.messages.find(message => message.role === "tool").content,
      failed ? JSON.stringify({ error: "Tool result exceeded the local limit." }) : result);
    assert.equal(fixture.service.events(actor, input.id).events.find(event => event.type === "tool-complete").data.resultStatus,
      failed ? "failed" : "complete");
  });
});
