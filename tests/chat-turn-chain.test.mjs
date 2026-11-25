import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { chatTurnInput, chatTurnEvents } from "./chat-turn-fixtures.mjs";
import { createChatTurnChainFixture } from "./chat-turn-native-fixtures.mjs";
import { chatTurnFixture } from "./chat-turn-fixtures.mjs";
import { FakeToolCore, toolGatewayDocument } from "./tool-gateway-fixtures.mjs";
import { ToolGateway } from "../dist/tool-gateway.js";
import { createChatTurnToolPort } from "../dist/chat-turn-adapters.js";

test("actual provider SSE -> native Chat -> exact approval bridge -> gateway -> Core -> shared SQLite -> next inference", async t => {
  const f = createChatTurnChainFixture();
  t.after(() => f.db.close());
  const input = chatTurnInput();
  f.service.start("chain-actor", input);
  const result = await f.service.settled("chain-actor", input.id);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(f.counts(), { modelCalls: 2, toolEffects: 1 });
  assert.equal(f.reviews.length, 1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM synthetic_chain_documents").get().n, 1);
  const toolEvent = chatTurnEvents(f.service, "chain-actor", input.id).find(event => event.type === "tool-intent");
  assert.equal(f.db.prepare("SELECT operation_id FROM synthetic_chain_documents").get().operation_id, toolEvent.data.operationId);
  const approvals = chatTurnEvents(f.service, "chain-actor", input.id).filter(event => event.type === "approval");
  assert.deepEqual(approvals.map(event => event.data.status), ["pending", "approved"]);
  f.service.start("chain-actor", input);
  await f.service.settled("chain-actor", input.id);
  assert.deepEqual(f.counts(), { modelCalls: 2, toolEffects: 1 });
  assert.deepEqual(f.native.recover(), { unknown: 0 });
});

test("actual native reviewer denial blocks gateway and subsequent model step", async t => {
  const f = createChatTurnChainFixture({ deny: true });
  t.after(() => f.db.close());
  const input = chatTurnInput();
  f.service.start("chain-actor", input);
  const result = await f.service.settled("chain-actor", input.id);
  assert.equal(result.status, "failed");
  assert.equal(result.failure, "APPROVAL_DENIED");
  assert.deepEqual(f.counts(), { modelCalls: 1, toolEffects: 0 });
});

test("known not-committed tool failure is sanitized and returned to the next model round without replay", async t => {
  const f = createChatTurnChainFixture({ safeFailure: true });
  t.after(() => f.db.close());
  const input = chatTurnInput();
  f.service.start("chain-actor", input);
  const result = await f.service.settled("chain-actor", input.id);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(f.counts(), { modelCalls: 2, toolEffects: 1 });
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM synthetic_chain_documents").get().n, 0);
  assert.equal(f.db.prepare("SELECT status FROM execution_records").get().status, "failed");
  assert.equal(chatTurnEvents(f.service, "chain-actor", input.id)
    .find(event => event.type === "tool-complete").data.resultStatus, "failed");
  f.service.start("chain-actor", input);
  await f.service.settled("chain-actor", input.id);
  assert.deepEqual(f.counts(), { modelCalls: 2, toolEffects: 1 });
});

test("actual gateway/Core uncertain effect remains unknown, durable execution is not re-dispatched", async t => {
  const f = createChatTurnChainFixture({ unknown: true });
  t.after(() => f.db.close());
  const input = chatTurnInput();
  f.service.start("chain-actor", input);
  const result = await f.service.settled("chain-actor", input.id);
  assert.equal(result.status, "unknown");
  assert.equal(result.uncertain, true);
  assert.equal(f.db.prepare("SELECT status FROM execution_records").get().status, "unknown");
  f.service.start("chain-actor", input);
  await f.service.settled("chain-actor", input.id);
  assert.deepEqual(f.counts(), { modelCalls: 1, toolEffects: 1 });
});

test("cancelled Chat retains ignored-abort Core effect until actual retirement without overwriting terminal state", async t => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = createChatTurnChainFixture({ onEffect: async () => { entered(); await gate; } });
  t.after(() => f.db.close());
  const input = chatTurnInput();
  f.service.start("chain-actor", input);
  await ready;
  const current = f.service.get("chain-actor", input.id);
  f.service.cancel("chain-actor", { id: input.id, expectedRevision: current.revision, operationId: randomUUID() });
  const terminal = await f.service.settled("chain-actor", input.id);
  assert.equal(terminal.status, "cancelled");
  assert.equal(terminal.uncertain, true);
  assert.ok(f.native.tools.activity() > 0);
  assert.ok(f.service.activity().active > 0);
  await assert.rejects(f.service.close(), { code: "EFFECTS_NOT_RETIRED" });
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.activity().active, 0);
  assert.deepEqual(f.service.get("chain-actor", input.id), terminal);
  assert.deepEqual(f.counts(), { modelCalls: 1, toolEffects: 1 });
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM synthetic_chain_documents").get().n, 1);
  await f.service.close();
});

for (const [label, toolContent, expectToolLimit] of [
  ["multibyte", "汉".repeat(12000), false],
  ["near-boundary multibyte", "汉".repeat(15800), false],
  ["UTF-16 over limit", "x".repeat(16001), true],
  ["escaped output beyond generic approval ceiling", "\u0001".repeat(12000), true],
  ["JSON byte hard ceiling", "\u0001".repeat(16001), true],
]) test(`gateway and approval preserve ${label} tool output with no replay`, async t => {
  const f = createChatTurnChainFixture({ toolContent, expectToolLimit });
  t.after(() => f.db.close());
  const input = { ...chatTurnInput(), maxInputTokens: 200000 };
  f.service.start("chain-actor", input);
  const result = await f.service.settled("chain-actor", input.id);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(f.counts(), { modelCalls: 2, toolEffects: 1 });
  assert.equal(f.db.prepare("SELECT status FROM execution_records").get().status, "succeeded");
  assert.equal(chatTurnEvents(f.service, "chain-actor", input.id)
    .find(event => event.type === "tool-complete").data.resultStatus, expectToolLimit ? "failed" : "complete");
  f.service.start("chain-actor", input);
  await f.service.settled("chain-actor", input.id);
  assert.deepEqual(f.counts(), { modelCalls: 2, toolEffects: 1 });
});

test("oversized read-only gateway result is a known failed tool without replay", async t => {
  const f = chatTurnFixture();
  t.after(() => f.db.close());
  const core = new FakeToolCore();
  core.result = toolGatewayDocument({ content: "\u0001".repeat(16001) });
  const native = createChatTurnToolPort({
    workspaceId: "workspace",
    storage: { read: fn => fn(f.db), transaction: fn => f.transaction(() => fn(f.db)) },
    gateway(actor, turnId, verifyApproval) {
      return new ToolGateway({ dispatcher: core, actor: { id: actor, canWrite: false },
        context: { workspaceId: "workspace", turnId, contextDigest: "a".repeat(64) },
        catalog: [{ name: "read_document", operation: "knowledge.document.get" }],
        verifyApproval, legacyChatOutput: true, limits: { outputBytes: 96_002 } });
    },
  });
  const request = { actor: "actor", turnId: "turn", operationId: randomUUID(), signal: new AbortController().signal,
    call: { id: "call", name: "read_document", arguments: { id: "synthetic" } }, onApproval() { assert.fail(); } };
  const result = await native.tools.execute(request);
  assert.equal(result.resultStatus, "failed");
  assert.deepEqual(JSON.parse(result.content), { error: "Tool result exceeded the local limit." });
  assert.equal(f.db.prepare("SELECT status FROM execution_records").get().status, "failed");
  assert.equal(core.calls.length, 1);
});

test("cancelling while native reviewer is pending cancels exact approval and never executes late approval", async t => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const decision = new Promise(resolve => { release = resolve; });
  const f = createChatTurnChainFixture({ review: async request => { entered(request); return decision; } });
  t.after(() => f.db.close());
  const input = chatTurnInput();
  f.service.start("chain-actor", input);
  const request = await ready;
  const current = f.service.get("chain-actor", input.id);
  f.service.cancel("chain-actor", { id: input.id, expectedRevision: current.revision, operationId: randomUUID() });
  assert.equal((await f.service.settled("chain-actor", input.id)).status, "cancelled");
  assert.equal(f.native.approvals.list("chain-actor").requests[0].status, "cancelled");
  release({ actorId: request.actorId, decisionId: randomUUID(), decision: "approve" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.counts(), { modelCalls: 1, toolEffects: 0 });
});

test("tool absent from the native catalog returns an error result to the model without dispatch", async t => {
  const f = createChatTurnChainFixture();
  t.after(() => f.db.close());
  const input = chatTurnInput();
  f.service.start("chain-actor", input);
  const operationId = randomUUID();
  const result = await f.native.tools.execute({
    actor: "chain-actor", turnId: input.id, operationId, signal: new AbortController().signal,
    call: { id: "call-missing", name: "missing_tool", arguments: {} }, onApproval() { assert.fail("no approval"); },
  });
  assert.equal(result.executionId, `unavailable-${operationId}`);
  assert.deepEqual(JSON.parse(result.content), { error: "This tool is not enabled for the request." });
  assert.equal(result.resultStatus, "failed");
  assert.equal(f.counts().toolEffects, 0);
  await f.service.settled("chain-actor", input.id);
});
