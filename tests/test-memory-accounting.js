const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { memoryTurnAccounting } = require("../dist/memory/memory-accounting");
const { ChatMemoryService, MemoryModelError } = require("../dist/memory/chat-memory-service");

const accounting = (provider = "http") => ({
  schema: "pkm.memory.model-accounting/v1", modelId: `${provider}:memory-fixture`, provider,
  durationMs: 12, timeoutMs: 1000, maxOutputTokens: 400, thinkingBudget: 2048,
  inferenceTiming: { schema: "pkm.chat.inference-timing/v1", provider, startedAt: 100, finishedAt: 110,
    elapsedMs: 10, maxInactivityMs: 5, firstActivityMs: 1, firstPublicOutputMs: 2, outcome: "stream-ended" },
});
const intent = { text: JSON.stringify({ focus: ["new:1"], new: [{ key: "new:1", label: "Memory fixture" }] }),
  usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 2, cachedInputTokens: 3 }, accounting: accounting() };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-memory-accounting-"));
  const options = { extensionRoot: path.resolve(__dirname, ".."), python: process.env.PYTHON || "python3",
    database: path.join(directory, "memory.sqlite3"), identity: "memory-accounting-fixture" };
  const service = new ChatMemoryService(options);
  t.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { service, options };
}
const receipt = calls => ({ schema: "pkm.memory.turn-receipt/v1", calls });

test("Independent Memory totals retain coverage and never substitute zero for unknown usage", () => {
  const total = memoryTurnAccounting(receipt([
    { status: "complete", usage: intent.usage, accounting: accounting() },
    { status: "complete", usage: { inputTokens: 7, outputTokens: 3 }, accounting: accounting("vscode") },
    { status: "failed" }, { status: "requested" }, { status: "cancelled" },
  ]));
  assert.deepEqual(total.reportedUsage, { inputTokens: 17, outputTokens: 8 });
  assert.deepEqual([total.calls, total.reportedCalls, total.unreportedCalls, total.timedCalls, total.untimedCalls,
    total.pendingCalls, total.failedCalls, total.cancelledCalls], [5, 2, 3, 2, 3, 1, 1, 1]);
  assert.equal(total.observedDurationMs, 24);
  const unknown = memoryTurnAccounting(receipt([{ status: "failed" }]));
  assert.equal(unknown.reportedUsage, undefined);
  assert.equal(unknown.observedDurationMs, undefined);
  for (const call of [
    { status: "complete", usage: { inputTokens: -1, outputTokens: 1 } },
    { status: "complete", usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 2 } },
    { status: "complete", accounting: { ...accounting(), durationMs: NaN } },
    { status: "complete", accounting: { ...accounting(), thinkingBudget: -1 } },
  ]) assert.throws(() => memoryTurnAccounting(receipt([call])), /Invalid Memory/);
  assert.throws(() => memoryTurnAccounting(receipt([
    { status: "complete", usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 } },
    { status: "complete", usage: { inputTokens: 1, outputTokens: 1 } },
  ])), /precision/);
});

test("Real Memory prepare/extract receipts preserve separate totals and survive a Python worker restart", async t => {
  const { service } = fixture(t);
  const signal = new AbortController().signal;
  const prepared = await service.prepare("scope", "complete", { id: "u", text: "Remember this requirement" }, [], 5000, async () => intent, signal);
  assert.equal(prepared.receipt.accounting.reportedCalls, 1);
  assert.deepEqual(prepared.receipt.calls[0].accounting, accounting());
  const committed = await service.commit("scope", "complete", { id: "u", text: "Remember this requirement" }, { id: "a", text: "Acknowledged" },
    async request => {
      assert.equal(request.purpose, "extract");
      return { text: '{"statements":[]}', accounting: accounting("vscode") };
    }, signal);
  assert.deepEqual(committed.accounting.reportedUsage, intent.usage);
  assert.equal(committed.accounting.calls, 2);
  assert.equal(committed.accounting.unreportedCalls, 1);
  assert.equal(committed.accounting.observedDurationMs, 24);
  const client = await service.client;
  client.child.kill("SIGKILL"); await client.exit;
  assert.deepEqual(await service.receipt("complete"), committed);
});

test("Failed Memory inference records partial usage and timing, while unknown usage stays unknown", async t => {
  const { service } = fixture(t);
  const metadata = { ...accounting(), inferenceTiming: { ...accounting().inferenceTiming, outcome: "interrupted" } };
  const failed = await service.prepare("scope", "failed", { id: "u1", text: "Partial failure" }, [], 5000,
    async () => { throw new MemoryModelError("provider interrupted", { text: "must not apply",
      usage: { inputTokens: 9, outputTokens: 2 }, accounting: metadata }); }, new AbortController().signal);
  assert.equal(failed.receipt.accounting.failedCalls, 1);
  assert.deepEqual(failed.receipt.accounting.reportedUsage, { inputTokens: 9, outputTokens: 2 });
  assert.equal(failed.receipt.calls[0].accounting.inferenceTiming.outcome, "interrupted");
  const unknown = await service.prepare("scope", "unknown", { id: "u2", text: "No provider receipt" }, [], 5000,
    async () => { throw new Error("model unavailable"); }, new AbortController().signal);
  assert.equal(unknown.receipt.accounting.unreportedCalls, 1);
  assert.equal(unknown.receipt.accounting.reportedUsage, undefined);
});

test("Cancelled Memory calls persist observations but never apply late content, even after restart", async t => {
  const { service } = fixture(t);
  const abort = new AbortController();
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const running = service.prepare("scope", "cancelled", { id: "u", text: "Cancel me" }, [], 5000,
    async () => { started(); return new Promise(resolve => { release = resolve; }); }, abort.signal);
  const rejected = assert.rejects(running, /cancelled/i);
  await ready; abort.abort(); release(intent); await rejected;
  const record = await service.receipt("cancelled");
  assert.equal(record.phase, "cancelled");
  assert.equal(record.accounting.cancelledCalls, 1);
  assert.deepEqual(record.accounting.reportedUsage, intent.usage);
  assert.equal((await service.overview("scope")).topics.length, 0);
  const client = await service.client;
  client.child.kill("SIGKILL"); await client.exit;
  assert.deepEqual(await service.receipt("cancelled"), record);
  await assert.rejects(service.commit("scope", "cancelled", { id: "u", text: "User" }, { id: "a", text: "Late reply" },
    async () => { throw new Error("must not run"); }, new AbortController().signal), /never prepared/);
  assert.equal((await service.overview("scope")).topics.length, 0);
});

test("Python rejects malformed model metadata before mutating a pending step, and permits a valid continuation", async t => {
  const { service } = fixture(t);
  const client = await service.engine();
  const begun = await client.request({ method: "turn_begin", params: { scope: "scope", turn: "pending", input: { id: "u", text: "Metadata guard" } } });
  for (const params of [
    { usage: { inputTokens: true, outputTokens: 0 } },
    { usage: { inputTokens: 1, outputTokens: 0, cachedInputTokens: 2 } },
    { accounting: { ...accounting(), provider: "imaginary" } },
    { accounting: { ...accounting(), durationMs: -1 } },
    { accounting: { ...accounting(), inferenceTiming: { ...accounting().inferenceTiming, maxInactivityMs: 11 } } },
  ]) {
    await assert.rejects(client.request({ method: "turn_continue", params: { turn: "pending", output: intent.text, ...params } }), /Invalid Memory/);
    assert.deepEqual(await client.request({ method: "turn_receipt", params: { turn: "pending" } }), begun.receipt);
  }
  const continued = await client.request({ method: "turn_continue", params: { turn: "pending", output: intent.text,
    usage: intent.usage, accounting: accounting() } });
  assert.equal(continued.status, "ready");
  assert.equal(continued.receipt.calls[0].status, "complete");
});
