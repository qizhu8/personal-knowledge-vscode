const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChatBudgetLedger, recordChatBudgetTransport, recordChatBudgetUsage, chatBudgetUsage, recordChatBudgetRuntime, recordChatInferenceTiming, recordChatWorkerBudget, recordChatInvocationBudget, validChatInvocationBudget } = require("../dist/chat/chat-budget-ledger");
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
const invocation = (overrides = {}) => ({
  schema: "pkm.chat.invocation-budget/v1", id: "tool:original-call", owner: "tool", label: "run_process",
  status: "running", startedAt: 1000, elapsedMs: 0, activeMs: 0, userWaitMs: 0,
  timingSource: "pkm.invocation-clock-excluding-tracked-user-wait", ...overrides,
});

test("invocation budgets replace only the same original running observation and keep waits separate", () => {
  const items = [], initial = invocation();
  recordChatInvocationBudget(items, initial);
  initial.label = "mutated";
  assert.equal(items[0].label, "run_process");
  const complete = invocation({ status: "complete", finishedAt: 2100, elapsedMs: 1100, activeMs: 100, userWaitMs: 1000 });
  recordChatInvocationBudget(items, complete);
  recordChatInvocationBudget(items, complete);
  assert.equal(items.length, 1, "Repeated observations are not new calls or additive usage");
  assert.equal(items[0].activeMs, 100);
  assert.equal(items[0].deadlineMs, undefined, "Missing tool deadlines are not unlimited capacity or the model idle timeout");
  const before = JSON.stringify(items);
  for (const patch of [{ label: "different" }, { startedAt: 2000 }, { status: "failed" }, { elapsedMs: 1200, userWaitMs: 1100 }]) {
    assert.throws(() => recordChatInvocationBudget(items, { ...complete, ...patch }), /identity or terminal/);
    assert.equal(JSON.stringify(items), before);
  }
});

test("malformed invocation observations fail before mutation rather than inventing valid clocks", () => {
  for (const patch of [
    { id: "" }, { owner: "model" }, { status: "success" }, { startedAt: NaN }, { elapsedMs: Infinity },
    { activeMs: -1 }, { elapsedMs: 10, activeMs: 11 }, { elapsedMs: 10, userWaitMs: 9 },
    { status: "complete" }, { finishedAt: 900 }, { finishedAt: 1100 }, { deadlineMs: { value: 0, method: "configured", source: "guard" } },
    { deadlineMs: { value: 10, method: "estimated", source: "guard" } }, { detail: "x".repeat(1025) },
  ]) {
    const items = [];
    assert.equal(validChatInvocationBudget(invocation(patch)), false, JSON.stringify(patch));
    assert.throws(() => recordChatInvocationBudget(items, invocation(patch)), /Invalid invocation/);
    assert.deepEqual(items, []);
  }
  const items = [invocation({ elapsedMs: 100, activeMs: 50, userWaitMs: 50 })];
  assert.throws(() => recordChatInvocationBudget(items, invocation()), /cannot be replaced/);
});

test("invocation accounting survives Snapshot without a model round, and reload preserves unknown completion and observed time", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-invocation-ledger-"));
  try {
    const store = new ApiChatStore(root, "aaaaaaaaaaaaaaaa"), chat = store.create();
    const running = invocation({ elapsedMs: 300, activeMs: 100, userWaitMs: 200 });
    chat.messages.push({ id: "answer", role: "assistant", content: "", status: "streaming", invocationBudgets: [running] });
    store.save(chat);
    const restored = store.load(chat.id), latest = restored.messages.at(-1);
    const observed = latest.invocationBudgets[0];
    assert.equal(observed.status, "interrupted");
    assert.equal(observed.finishedAt, undefined, "Reload is not the observed invocation end");
    assert.equal(observed.elapsedMs, 300, "No downtime or invented zero usage");
    assert.equal(observed.activeMs, 100);
    assert.match(observed.detail, /termination.*unknown/);
    const snapshot = apiChatHarnessSnapshot(restored);
    assert.deepEqual(snapshot.attempts.at(-1).invocationBudgets, latest.invocationBudgets);
    const nodes = [...build({ origin: "pkm-native", sessionId: "task", harness: snapshot }).graphs.values()].flatMap(graph => graph.nodes);
    const node = nodes.find(node => node.kind === "Invocation accounting");
    assert.equal(node.status, "interrupted");
    assert.equal(node.info.userWaitMs, 200);
    assert.equal(node.executable, false);
    latest.invocationBudgets.push(structuredClone(observed));
    store.save(restored);
    assert.throws(() => store.load(chat.id), /Unsupported chat history/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

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

test("actual transport timing and shared worker quota use their own units and do not invent provider tokens", () => {
  const value = receipt();
  recordChatInferenceTiming(value.ledger, { schema: "pkm.chat.inference-timing/v1", provider: "http",
    startedAt: 100, finishedAt: 200, elapsedMs: 100, maxInactivityMs: 40, firstActivityMs: 40,
    firstPublicOutputMs: 90, outcome: "stream-ended" });
  assert.equal(row(value, "model-idle").consumed.value, 40);
  assert.equal(row(value, "model-elapsed").consumed.value, 100);
  assert.equal(row(value, "first-public-output").consumed.value, 90);
  assert.equal(row(value, "output").consumed, undefined);
  recordChatWorkerBudget(value.ledger, { treeId: "same-root-tree", active: 4, quota: 5, maximum: 10 });
  assert.equal(row(value, "worker-quota").consumed.value, 4);
  assert.equal(row(value, "worker-quota").limit.value, 10);
  assert.match(row(value, "worker-quota").note, /share the same tree/);
  recordChatWorkerBudget(value.ledger, { treeId: "same-root-tree", active: 4, quota: 2, maximum: 2 });
  assert.equal(row(value, "worker-quota").consumed.value, 4, "A configuration change does not hide already active workers");
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
