#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { todoUsageSummary } = require("../dist/mcp-usage.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-todo-usage-"));
try {
  const sessionId = "agent_session_test";
  const todoId = "todo_test";
  const directory = path.join(root, ".pkm", "state", "mcp-usage", "todos", sessionId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${todoId}.json`), JSON.stringify({
    schema: "pkm.mcp.todo-usage/v1",
    agentSessionId: sessionId,
    todoId,
    calls: 4,
    successes: 3,
    inputBytes: 600,
    outputBytes: 1400,
    durationMs: 37.5,
    estimatedTokens: 500,
    firstUsedAt: "2026-09-30T00:00:00Z",
    lastUsedAt: "2026-09-30T00:01:00Z",
    domains: { automation: { calls: 3 }, skillRouter: { calls: 1 } },
    tools: { recipe_run_report: { calls: 2 }, skill_context: { calls: 1 }, recipe_run_next: { calls: 1 } },
  }));

  const usage = todoUsageSummary(root, sessionId, todoId, [{
    usage: {
      measuredTokens: { input_tokens: 100, output_tokens: 25, cached_input_tokens: 50, reasoning_tokens: 5, total_tokens: 130 },
      estimatedTokens: 80,
      unknownModelCalls: 1,
      measuredReports: 1,
      estimatedReports: 1,
      providers: ["copilot"],
      models: ["test-model"],
    },
  }]);
  assert.deepStrictEqual(usage.protocol, {
    observed: true,
    quality: "estimated",
    calls: 4,
    successes: 3,
    failures: 1,
    inputBytes: 600,
    outputBytes: 1400,
    durationMs: 37.5,
    estimatedTokens: 500,
    firstUsedAt: "2026-09-30T00:00:00Z",
    lastUsedAt: "2026-09-30T00:01:00Z",
    domains: { automation: 3, skillRouter: 1 },
    tools: { recipe_run_report: 2, skill_context: 1, recipe_run_next: 1 },
  });
  assert.strictEqual(usage.model.quality, "partial");
  assert.deepStrictEqual(usage.model.measuredTokens, {
    inputTokens: 100, outputTokens: 25, cachedInputTokens: 50, reasoningTokens: 5, totalTokens: 130,
  });
  assert.strictEqual(usage.model.estimatedTokens, 80);
  assert.strictEqual(usage.model.unknownModelCalls, 1);
  assert.deepStrictEqual(usage.credit, { quality: "unknown", premiumRequests: null });

  const unknown = todoUsageSummary(root, sessionId, "todo_missing", []);
  assert.strictEqual(unknown.protocol.observed, false);
  assert.strictEqual(unknown.protocol.quality, "unknown");
  assert.strictEqual(unknown.model.quality, "unknown");
  assert.strictEqual(unknown.credit.quality, "unknown");
  console.log("Todo usage aggregation: protocol estimates and model quality stay separate");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
