const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatBudgetLedger, recordChatBudgetTransport, recordChatBudgetUsage, chatBudgetUsage, recordChatBudgetRuntime } = require("../dist/chat/chat-budget-ledger");
const { ApiChatStore, apiChatHarnessSnapshot } = require("../dist/chat/api-chat-store");
const { build } = require("../src/webview/agent-harness");

function receipt(prices = {}) {
  const value = {
    schema: "pkm.chat.budget/v1", at: 1, round: 0, modelId: "fixture", countingMethod: "utf8-byte-estimate",
    requested: { contextWindow: 4096, outputTokens: 512, modelTimeoutMs: 1800000, activeReviewMs: 1800000, toolRoundReview: 30 },
    effective: { inputBudget: 3584, outputTokens: 512 },
    consumed: { estimatedInputTokens: 1000, activeMs: 100 },
    selectedReferenceIds: [], status: "prepared",
  };
  value.ledger = createChatBudgetLedger(value, { currency: "USD", ...prices });
  return value;
}
const row = (value, id) => value.ledger.entries.find(item => item.id === id);

test("budget ledger preserves owner/unit/source and never substitutes estimates for provider usage", () => {
  const value = receipt();
  assert.equal(value.ledger.thinkingPolicy, "provider-default");
  assert.equal(row(value, "input").consumed.method, "estimated");
  assert.equal(row(value, "input").limit.value, 3584);
  assert.equal(row(value, "input").scope, "round");
  assert.equal(row(value, "active-review").scope, "attempt-cumulative");
  assert.equal(row(value, "active-review").enforcement, "review-trigger");
  assert.equal(row(value, "model-idle").unit, "milliseconds");
  for (const id of ["provider-input", "output", "reasoning", "cost", "worker-quota"]) {
    assert.equal(row(value, id).consumed, undefined);
    assert(row(value, id).unavailable);
  }
  assert.equal(chatBudgetUsage([value]), undefined);
  value.transport = { inputTokens: 900, countingMethod: "vscode-countTokens-plus-overhead" };
  recordChatBudgetTransport(value);
  assert.equal(row(value, "transport-input").consumed.method, "local-measured");
  assert.equal(row(value, "provider-input").consumed, undefined);
  value.transport = { inputTokens: 1100, countingMethod: "utf8-byte-estimate" };
  recordChatBudgetTransport(value);
  assert.equal(row(value, "transport-input").consumed.method, "estimated");
});

test("cumulative usage frames replace a round snapshot, while distinct rounds accumulate once", () => {
  const a = receipt({ inputPricePerMillion: 1, outputPricePerMillion: 2 });
  recordChatBudgetUsage(a.ledger, { inputTokens: 100, outputTokens: 30, reasoningTokens: 20, cachedInputTokens: 40 });
  recordChatBudgetUsage(a.ledger, { inputTokens: 100, outputTokens: 30, reasoningTokens: 20, cachedInputTokens: 40 });
  assert.equal(a.ledger.usageFrames, 2);
  assert.equal(row(a, "visible-output").consumed.value, 10);
  assert.equal(row(a, "reasoning").consumed.value, 20);
  assert.equal(row(a, "reasoning").limit, undefined);
  assert.equal(row(a, "cost").consumed.value, 0.00016);
  assert.equal(row(a, "cost").consumed.method, "estimated");
  const b = receipt();
  b.round = 1;
  recordChatBudgetUsage(b.ledger, { inputTokens: 10, outputTokens: 5 });
  assert.deepEqual(chatBudgetUsage([a, b]), { inputTokens: 110, outputTokens: 35 });
  assert.equal(row(b, "reasoning").consumed, undefined, "Unreported reasoning is not zero");
  assert.equal(row(b, "cost").consumed, undefined, "Unknown prices are not free");
  recordChatBudgetUsage(a.ledger, { inputTokens: 100, outputTokens: 30 });
  assert.equal(row(a, "reasoning").consumed, undefined, "Latest partial metadata cannot preserve an older complete breakdown");
});

test("invalid provider quantities cannot mutate accounting or create success-shaped totals", () => {
  const value = receipt();
  for (const usage of [
    { inputTokens: NaN, outputTokens: 1 }, { inputTokens: 1.5, outputTokens: 2 },
    { inputTokens: 1, outputTokens: -1 }, { inputTokens: 1, outputTokens: 2, reasoningTokens: 3 },
    { inputTokens: 1, outputTokens: 2, cachedInputTokens: 2 },
  ]) {
    const before = JSON.stringify(value.ledger);
    assert.throws(() => recordChatBudgetUsage(value.ledger, usage), /usage is invalid/);
    assert.equal(JSON.stringify(value.ledger), before);
  }
});

test("tracked waiting is excluded from active execution and does not become model idle", () => {
  const value = receipt();
  recordChatBudgetRuntime(value.ledger, 1200, 81200, 3);
  assert.equal(row(value, "active-review").consumed.value, 1200);
  assert.equal(row(value, "user-wait").consumed.value, 80000);
  assert.equal(row(value, "tool-calls").consumed.value, 3);
  assert.equal(row(value, "model-idle").consumed, undefined);
  assert.throws(() => recordChatBudgetRuntime(value.ledger, 100, 10, 0), /exceed elapsed/);
  assert.throws(() => recordChatBudgetRuntime(value.ledger, NaN, 10, 0), /Invalid budget/);
});

test("round-only loop review remains supported without inventing an active-time limit", () => {
  const value = receipt();
  delete value.requested.activeReviewMs;
  value.ledger = createChatBudgetLedger(value, { currency: "USD" });
  assert.equal(row(value, "active-review").limit, undefined);
  assert.match(row(value, "active-review").note, /No active-time gate/);
  assert.equal(row(value, "active-review").consumed.value, 100);
  assert.equal(row(value, "tool-round-review").limit.value, 30);
});

test("ledger survives persistence/Snapshot, recovery records interruption without fabricated downtime usage, and old receipts remain readable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-budget-ledger-"));
  try {
    const store = new ApiChatStore(root, "aaaaaaaaaaaaaaaa");
    const chat = store.create();
    chat.sessionId = "agent_session_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const budget = receipt();
    chat.messages.push({ id: "answer", role: "assistant", taskId: chat.sessionId, content: "partial", status: "streaming", budgetReceipts: [budget] });
    store.save(chat);
    const restored = store.load(chat.id);
    const latest = restored.messages.at(-1);
    assert.equal(latest.status, "interrupted");
    assert.equal(latest.budgetReceipts[0].ledger.outcome.status, "interrupted");
    assert.equal(row(latest.budgetReceipts[0], "active-review").consumed.value, 100, "Recovery does not fabricate active runtime from downtime");
    const snapshot = apiChatHarnessSnapshot(restored);
    assert.deepEqual(snapshot.attempts.at(-1).budgetReceipts, latest.budgetReceipts);
    const graphs = build({ origin: "pkm-native", sessionId: "task", harness: snapshot }).graphs;
    const nodes = [...graphs.values()].flatMap(graph => graph.nodes);
    assert(nodes.some(node => node.kind === "Budget accounting" && node.info.id === "reasoning" && node.status === "unavailable"));
    delete latest.budgetReceipts[0].ledger;
    assert.doesNotThrow(() => build({ origin: "pkm-native", sessionId: "task", harness: apiChatHarnessSnapshot(restored) }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
