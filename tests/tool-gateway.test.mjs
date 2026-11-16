import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { TOOL_GATEWAY_LIMITS, ToolGateway, toolResultContent, toolApprovalDigest } from "../dist/tool-gateway.js";
import { CoreError } from "../dist/contracts.js";
import { Core } from "../dist/core.js";
import {
  createToolGatewayFixture, FakeToolCore, toolGatewayActor, toolGatewayContext, toolGatewayDocument,
  toolGatewayReadRequest as read, toolGatewayWriteRequest as write,
} from "./tool-gateway-fixtures.mjs";
import {
  capabilityTools, nativeToolCapabilities, projectNativeCapabilityEvent,
  ChatToolScheduler, chatToolResultContext, chatToolBatchContext, executeChatToolBatch,
} from "../dist/domain/tool-gateway-original.js";
import {
  toolArgumentsDigest, toolCanonicalJson, toolCatalogDigest, validateToolCatalogPage,
} from "../dist/domain/tool-gateway-projection.js";

const execute = (gateway, request, signal = new AbortController().signal) => gateway.execute(request, { signal });
test("gateway projects static schemas, binds normalized approval and invokes fake Core with authenticated actor", async () => {
  const fixture = createToolGatewayFixture();
  const discovery = await fixture.gateway.discover();
  assert.equal(discovery.items[0].parameters.properties.id.type, "string");
  assert.equal(discovery.items[0].execution, "parallel-read");
  assert.equal(discovery.items[1].approvalRequired, true);
  await assert.rejects(fixture.gateway.discover({ revision: "b".repeat(64) }), { code: "CONFLICT" });
  assert.equal((await execute(fixture.gateway, read)).status, "complete");
  const normalized = fixture.gateway.prepare(write);
  assert.equal(normalized.arguments.title, "Synthetic");
  assert.equal(normalized.arguments.operationId, write.operationId);
  assert.ok(Object.isFrozen(normalized.arguments));
  assert.equal((await execute(fixture.gateway, write)).error.code, "APPROVAL_REQUIRED");
  const approval = fixture.approve(write);
  const result = await execute(fixture.gateway, { ...write, approval });
  assert.equal(result.status, "complete");
  assert.equal(result.effect, "committed");
  assert.equal(result.retry, "never");
  assert.equal(fixture.core.calls[1].method, "capability_call");
  assert.deepEqual(fixture.core.calls[1].actor, toolGatewayActor);
  assert.equal(JSON.parse(toolResultContent(result)).title, "Synthetic");
  assert.equal((await execute(fixture.gateway, { ...write, approval })).error.code, "CONFLICT");
});
test("discovery is not authorization, reads cannot mutate, caller role overrides and forged results are rejected", async () => {
  const fixture = createToolGatewayFixture();
  fixture.core.deny = true;
  assert.equal((await fixture.gateway.discover()).items.length, 2);
  const denied = await execute(fixture.gateway, read);
  assert.equal(denied.error.code, "ACCESS_DENIED");
  assert.equal(denied.effect, "not-committed");
  assert.doesNotMatch(JSON.stringify(denied), /must-not-leak/);
  for (const request of [
    { ...read, actor: { id: "admin", canWrite: true } },
    { ...read, result: { status: "succeeded" } },
    { ...read, operationId: write.operationId },
    { ...read, arguments: { ...read.arguments, content: "overwrite" } },
    { name: "run_process", arguments: { command: "echo forbidden" } },
  ]) assert.notEqual((await execute(fixture.gateway, request)).status, "complete");
  const readonly = createToolGatewayFixture({ actor: { id: "readonly", canWrite: false } });
  assert.equal((await readonly.gateway.discover()).items.length, 1);
  assert.equal((await execute(readonly.gateway, write)).error.code, "ACCESS_DENIED");
  assert.equal(readonly.core.calls.length, 0);
});
test("approval is bound to exact normalized arguments, operation, actor, workspace, turn and context", async () => {
  const fixture = createToolGatewayFixture();
  const approval = fixture.approve(write);
  assert.equal((await execute(fixture.gateway, {
    ...write, arguments: { ...write.arguments, title: "Changed" }, approval,
  })).error.code, "APPROVAL_REQUIRED");
  const binding = fixture.gateway.prepare(write);
  for (const patch of [
    { operation: "knowledge.document.update" }, { actorId: "other" }, { workspaceId: "other" },
    { turnId: "other" }, { contextDigest: "b".repeat(64) }, { operationId: "other" },
    { arguments: { ...binding.arguments, content: "Changed" } },
  ]) assert.notEqual(toolApprovalDigest(binding), toolApprovalDigest({ ...binding, ...patch }));
  assert.equal(fixture.core.calls.length, 0);
  const other = createToolGatewayFixture({ verifyApproval: async () => false });
  assert.equal((await execute(other.gateway, { ...write, approval })).error.code, "APPROVAL_REQUIRED");
  assert.equal(other.core.calls.length, 0);
});
test("native-only memory cannot be authorized by generic approval or catalog binding", () => {
  for (const operation of ["memory.record.confirm", "memory.record.revise", "memory.record.revoke"])
    assert.throws(() => createToolGatewayFixture({
      catalog: [{ name: "memory", operation }], verifyApproval: async () => true,
    }), { code: "NOT_AVAILABLE" });
});
test("approval and authorization checks are cancellable before dispatch", async () => {
  const fixture = createToolGatewayFixture({ authorize: async () => new Promise(() => {}) });
  const controller = new AbortController();
  const pending = execute(fixture.gateway, read, controller.signal);
  controller.abort();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(result.effect, "not-committed");
  assert.equal(fixture.core.calls.length, 0);
});
test("uncertain mutation timeout and cancellation are explicit unknown, never automatically retried", async () => {
  for (const mode of ["hang", "unknown", "throw"]) {
    const fixture = createToolGatewayFixture({ limits: { callTimeoutMs: 10 } });
    fixture.core.mode = mode;
    const request = { ...write, approval: fixture.approve(write) };
    const result = await execute(fixture.gateway, request);
    assert.equal(result.status, "unknown");
    assert.equal(result.effect, "unknown");
    assert.equal(result.retry, "never");
    assert.equal((await execute(fixture.gateway, request)).error.code, "CONFLICT");
    assert.equal(fixture.core.calls.length, 1);
  }
  const fixture = createToolGatewayFixture();
  fixture.core.mode = "hang";
  const controller = new AbortController();
  const pending = execute(fixture.gateway, { ...write, approval: fixture.approve(write) }, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.equal((await pending).effect, "unknown");
});
test("results are schema checked, bounded and redacted; errors never disclose dispatcher messages", async () => {
  const fixture = createToolGatewayFixture();
  fixture.core.result = {
    id: "synthetic", title: "Credentials", content: "Bearer TOPSECRET password=HIDDEN https://user:pass@example.invalid",
    revision: 1, deleted: false, sha256: "a".repeat(64),
  };
  const result = await execute(fixture.gateway, read);
  assert.doesNotMatch(JSON.stringify(result), /TOPSECRET|HIDDEN|user:pass/);
  assert.match(JSON.stringify(result), /REDACTED/);
  fixture.core.result = { forged: true };
  assert.equal((await execute(fixture.gateway, read)).error.code, "INVALID_RESULT");
  fixture.core.result = {
    id: "synthetic", title: "Large", content: "x".repeat(16000), revision: 1, deleted: false, sha256: "a".repeat(64),
  };
  assert.equal((await execute(fixture.gateway, read)).error.code, "OUTPUT_LIMIT");
});
test("finite call budget, deadline, portable JSON and in-flight denial are enforced", async () => {
  const fixture = createToolGatewayFixture({ limits: { calls: 1 } });
  assert.equal((await execute(fixture.gateway, read)).status, "complete");
  assert.equal((await execute(fixture.gateway, read)).error.code, "STEP_LIMIT");
  const expired = createToolGatewayFixture({ limits: { turnTimeoutMs: 1 } });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await execute(expired.gateway, read)).error.code, "DEADLINE_EXCEEDED");
  const cycle = {}; cycle.self = cycle;
  assert.equal((await execute(createToolGatewayFixture().gateway, { ...read, arguments: cycle })).error.code, "INVALID_ARGUMENT");
  const denied = createToolGatewayFixture({ authorize: async () => false });
  assert.equal((await execute(denied.gateway, read)).error.code, "ACCESS_DENIED");
  assert.equal(denied.core.calls.length, 0);
});
test("captured original capability binding keeps exact read/mutation schema, native text and discovery semantics", async () => {
  const leaf = { name: "synthetic_read", description: "Synthetic", parameters: { type: "object" }, execution: "parallel-read",
    execute: async () => "original native text" };
  const definitions = nativeToolCapabilities([leaf], []);
  const tools = capabilityTools([leaf], definitions, true);
  const discover = tools.find(item => item.name === "capabilities_search");
  const result = JSON.parse(await discover.execute({}, new AbortController().signal));
  assert.equal(result.total, 1);
  const invoke = tools.find(item => item.name === "capability_read");
  const args = { operation: definitions[0].id, version: 1, arguments: {} };
  assert.equal(await invoke.execute(args, new AbortController().signal), "original native text");
  assert.equal(projectNativeCapabilityEvent({
    id: "call", name: "capability_read", arguments: JSON.stringify(args), status: "complete",
  }, definitions).name, leaf.name);
  assert.deepEqual(chatToolResultContext({ onToolResultContext: () => "context" }, {}), { role: "system", content: "context" });
  assert.throws(() => chatToolBatchContext({ onToolResultsContext: () => "x".repeat(2001) }, [{}]));
});
test("captured original tool batch consumes async execution, preserves output order and exclusive barriers", async () => {
  const order = [];
  const scheduler = new ChatToolScheduler(2);
  const signal = new AbortController().signal;
  await Promise.all([
    scheduler.schedule({ execution: "parallel-read" }, signal, async () => { order.push("read"); }),
    scheduler.schedule(undefined, signal, async () => { order.push("write"); }),
  ]);
  assert.deepEqual(order, ["read", "write"]);
  const messages = [];
  const loop = { summarizing: false, beforeRound: async () => {}, reuse: () => undefined, record() {}, remember() {} };
  await executeChatToolBatch([
    { id: "one", type: "function", function: { name: "read_document", arguments: '{"id":"synthetic"}' } },
  ], {
    tools: [{ name: "read_document", description: "Read", parameters: {}, execution: "parallel-read",
      execute: async arguments_ => toolResultContent(await execute(createToolGatewayFixture().gateway, { name: "read_document", arguments: arguments_ })) }],
  }, messages, loop, signal, 1);
  assert.equal(messages[0].tool_call_id, "one");
  assert.equal(JSON.parse(messages[0].content).id, "synthetic");
});
test("capture provenance verifies actual source paths and deterministic generated hash", async () => {
  const records = JSON.parse(await readFile(new URL("../migration/tool-gateway-provenance.json", import.meta.url), "utf8"));
  const hash = data => createHash("sha256").update(data).digest("hex");
  for (const item of records.files) {
    assert.equal(hash(await readFile(new URL(`../legacy/${item.source}`, import.meta.url))), item.sourceSha256);
    assert.equal(hash(await readFile(new URL(`../${item.captured}`, import.meta.url))), item.capturedSha256);
  }
});
test("Core-reported precommit conflict remains not-committed, not unknown", async () => {
  const core = new FakeToolCore();
  core.dispatch = async () => { throw new CoreError("CONFLICT", "private diagnostic"); };
  const fixture = createToolGatewayFixture({ core });
  const result = await execute(fixture.gateway, { ...write, approval: fixture.approve(write) });
  assert.equal(result.error.code, "CONFLICT");
  assert.equal(result.effect, "not-committed");
  assert.equal(result.retry, "never");
});
test("constructor rejects unknown operations and cannot weaken required mutation approval", async () => {
  assert.throws(() => createToolGatewayFixture({ catalog: [{ name: "unknown", operation: "unregistered.tool.exec" }] }), { code: "NOT_AVAILABLE" });
  const gateway = new ToolGateway({
    dispatcher: new FakeToolCore(), actor: toolGatewayActor, context: toolGatewayContext,
    catalog: [{ name: "create_document", operation: "knowledge.document.create", approvalRequired: false }],
  });
  assert.equal((await execute(gateway, write)).error.code, "APPROVAL_REQUIRED");
});
test("the larger legacy Chat output ceiling is explicit and leaves generic gateways bounded", async () => {
  const core = new FakeToolCore();
  core.result = toolGatewayDocument({ content: "汉".repeat(12000) });
  const generic = createToolGatewayFixture({ core });
  assert.equal((await execute(generic.gateway, { name: "read_document", arguments: { id: "synthetic" } })).error.code, "OUTPUT_LIMIT");
  assert.throws(() => createToolGatewayFixture({ limits: { outputBytes: 96_002 } }), { code: "INVALID_ARGUMENT" });
  const chat = createToolGatewayFixture({ core, legacyChatOutput: true, limits: { outputBytes: 96_002 } });
  const result = await execute(chat.gateway, { name: "read_document", arguments: { id: "synthetic" } });
  assert.equal(result.status, "complete");
  assert.equal(result.result.content, core.result.content);
  assert.throws(() => createToolGatewayFixture({ legacyChatOutput: true, limits: { outputBytes: 96_003 } }),
    { code: "INVALID_ARGUMENT" });
});
test("the complete trusted static registry is paged within bounded output and retains its canonical revision", async () => {
  const gateway = new ToolGateway({
    dispatcher: new FakeToolCore(), actor: toolGatewayActor, context: toolGatewayContext,
  });
  const secondGateway = new ToolGateway({
    dispatcher: new FakeToolCore(), actor: toolGatewayActor, context: toolGatewayContext,
  });
  assert.equal(gateway.revision, secondGateway.revision);
  const pages = [];
  let offset = 0;
  for (;;) {
    const page = await gateway.discover({ offset, limit: 10, revision: gateway.revision });
    assert(page.items.length <= 10);
    assert(Buffer.byteLength(JSON.stringify(page)) <= 131_072);
    pages.push(page);
    if (page.nextOffset === null) break;
    assert(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  const items = pages.flatMap(page => page.items);
  assert.equal(items.length, pages[0].total);
  assert.equal(new Set(items.map(item => item.operation)).size, items.length);
  assert(items.some(item => item.operation === "action.moduleSet.project"));
  assert(items.some(item => item.operation === "channel.runtime.reply"));
  assert.equal(toolCatalogDigest(items), gateway.revision);
  assert.equal(toolCatalogDigest(items.slice(0, 10)), toolArgumentsDigest(items.slice(0, 10)));
  assert.throws(() => toolArgumentsDigest(items), { code: "INVALID_ARGUMENT" });
});
test("catalog descriptor and page projections reject untrusted or oversized structures", async () => {
  const gateway = new ToolGateway({
    dispatcher: new FakeToolCore(), actor: toolGatewayActor, context: toolGatewayContext,
  });
  const page = await gateway.discover({ limit: 10 });
  assert.throws(() => toolCatalogDigest([{ ...page.items[0], unexpected: true }]), { code: "INVALID_RESULT" });
  assert.throws(() => toolCatalogDigest([{ ...page.items[0], description: "x".repeat(131_073) }]), { code: "INVALID_RESULT" });
  assert.throws(() => validateToolCatalogPage({ ...page, items: [...page.items, page.items[0]] }), { code: "INVALID_RESULT" });
  const expandedPage = { ...page, items: page.items.map(item => ({ ...item, description: "x".repeat(30_000) })) };
  assert.throws(() => validateToolCatalogPage(expandedPage), { code: "INVALID_RESULT" });
});
test("tool argument canonicalization retains its original node, depth and byte bounds", () => {
  const fixture = createToolGatewayFixture();
  assert.equal(toolCanonicalJson(Array.from({ length: 8_191 }, () => null)), JSON.stringify(Array.from({ length: 8_191 }, () => null)));
  assert.throws(() => toolCanonicalJson(Array.from({ length: 8_192 }, () => null)), { code: "INVALID_ARGUMENT" });
  let depth16 = {};
  let cursor = depth16;
  for (let i = 0; i < 16; i++) cursor = cursor.child = {};
  assert.doesNotThrow(() => toolCanonicalJson(depth16));
  cursor.child = {};
  assert.throws(() => toolCanonicalJson(depth16), { code: "INVALID_ARGUMENT" });
  assert.throws(() => fixture.gateway.prepare({
    name: "read_document", arguments: { id: "x", extra: Array.from({ length: 8_192 }, () => null) },
  }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => fixture.gateway.prepare({
    name: "read_document", arguments: { id: "x".repeat(TOOL_GATEWAY_LIMITS.argumentBytes + 1) },
  }), { code: "INVALID_ARGUMENT" });
});
test("actual Core envelopes, per-call denials, registered methods and unknown effects are preserved", async () => {
  const fakeStorage = {
    calls: [],
    async request(request) {
      this.calls.push(request);
      return {
        id: "synthetic", title: request.args.title ?? "Synthetic", content: request.args.content ?? "",
        revision: 1, deleted: false, sha256: "a".repeat(64),
      };
    },
  };
  const core = new Core(fakeStorage);
  const fixture = createToolGatewayFixture({ dispatcher: core });
  assert.equal((await execute(fixture.gateway, read)).status, "complete");
  assert.equal((await execute(fixture.gateway, { ...write, approval: fixture.approve(write) })).status, "complete");
  assert.equal(fakeStorage.calls[1].actorId, toolGatewayActor.id);
  assert.equal(fakeStorage.calls[1].args.operationId, write.operationId);
  const deniedCore = {
    dispatch: (method, input) => core.dispatch(method, input, { id: "downgraded", canWrite: false }),
  };
  const denied = createToolGatewayFixture({ dispatcher: deniedCore });
  const result = await execute(denied.gateway, { ...write, approval: denied.approve(write) });
  assert.equal(result.error.code, "ACCESS_DENIED");
  assert.equal(result.effect, "not-committed");
  assert.equal(fakeStorage.calls.length, 2);
  const uncertain = createToolGatewayFixture({
    dispatcher: { dispatch: async () => ({
      schema: "pkm.next-result/v1", requestId: "synthetic",
      error: { code: "INTERNAL", message: "secret=private", effect: "unknown" },
    }) },
  });
  const unknown = await execute(uncertain.gateway, { ...write, approval: uncertain.approve(write) });
  assert.equal(unknown.status, "unknown");
  assert.doesNotMatch(JSON.stringify(unknown), /private/);
});
