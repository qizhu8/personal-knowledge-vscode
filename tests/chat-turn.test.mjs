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
  assert.equal(definitions.length, 4);
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
  release();
  await new Promise(resolve => setImmediate(resolve));
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
