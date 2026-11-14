import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryTurnAccounting } from "../dist/compute/memory-accounting.js";

const accounting = (provider = "http") => ({
  schema: "pkm.memory.model-accounting/v1",
  modelId: `${provider}:memory-fixture`,
  provider,
  durationMs: 12,
  timeoutMs: 1000,
  maxOutputTokens: 400,
  thinkingBudget: 2048,
});
const usage = {
  inputTokens: 10,
  outputTokens: 5,
  reasoningTokens: 2,
  cachedInputTokens: 3,
  copilotNanoAiu: 123_456_789,
};
const receipt = calls => ({ schema: "pkm.memory.turn-receipt/v1", calls });

test("Memory accounting preserves independent totals, coverage and exact credits", () => {
  const total = memoryTurnAccounting(receipt([
    { status: "complete", usage, accounting: accounting() },
    { status: "complete", usage: { inputTokens: 7, outputTokens: 3 }, accounting: accounting("vscode") },
    { status: "failed" },
    { status: "requested" },
    { status: "cancelled" },
  ]));
  assert.deepEqual(total.reportedUsage, { inputTokens: 17, outputTokens: 8 });
  assert.deepEqual([
    total.calls, total.reportedCalls, total.unreportedCalls, total.timedCalls, total.untimedCalls,
    total.pendingCalls, total.failedCalls, total.cancelledCalls,
  ], [5, 2, 3, 2, 3, 1, 1, 1]);
  assert.equal(total.observedDurationMs, 24);
  assert.deepEqual(total.credits, {
    source: "provider.copilot_usage.total_nano_aiu",
    status: "partial",
    reportedCalls: 1,
    totalCalls: 5,
    totalNanoAiu: "123456789",
    credits: "0.123456789",
  });
  const unknown = memoryTurnAccounting(receipt([{ status: "failed" }]));
  assert.equal(unknown.reportedUsage, undefined);
  assert.equal(unknown.observedDurationMs, undefined);
  assert.equal(unknown.credits.status, "not-reported");
});

test("Memory accounting rejects malformed receipts and precision overflow without fabricating usage", () => {
  for (const call of [
    { status: "complete", usage: { inputTokens: -1, outputTokens: 1 } },
    { status: "complete", usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 2 } },
    { status: "complete", accounting: { ...accounting(), durationMs: Number.NaN } },
    { status: "complete", accounting: { ...accounting(), thinkingBudget: -1 } },
  ]) assert.throws(() => memoryTurnAccounting(receipt([call])), /Invalid Memory/);
  assert.throws(() => memoryTurnAccounting(receipt([
    { status: "complete", usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 } },
    { status: "complete", usage: { inputTokens: 1, outputTokens: 1 } },
  ])), /precision/);
});
