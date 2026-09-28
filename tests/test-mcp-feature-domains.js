#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { mcpUsageSummary } = require("../dist/mcp-usage");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-mcp-domains-"));
const events = path.join(root, ".pkm", "state", "mcp-usage", "events");
fs.mkdirSync(events, { recursive: true });
fs.writeFileSync(path.join(events, "one.json"), JSON.stringify({
  sessionId: "session-a", occurredAt: "2026-09-26T10:00:00Z", domain: "skillRouter",
  success: true, inputBytes: 100, outputBytes: 300, durationMs: 12.5, resultCount: 2,
  estimatedTokenEquivalent: 100, reportedTokens: { input: 0, output: 0 },
}));
fs.writeFileSync(path.join(events, "two.json"), JSON.stringify({
  sessionId: "session-a", occurredAt: "2026-09-26T10:00:01Z", domain: "knowledge",
  success: false, inputBytes: 40, outputBytes: 80, durationMs: 7.5, resultCount: 0,
  estimatedTokenEquivalent: 30, reportedTokens: { input: 11, output: 13 },
}));

const summary = mcpUsageSummary(root);
assert.strictEqual(summary.sessions.length, 1);
assert.strictEqual(summary.sessions[0].calls, 2);
assert.strictEqual(summary.sessions[0].successes, 1);
assert.strictEqual(summary.sessions[0].inputBytes, 140);
assert.strictEqual(summary.sessions[0].estimatedTokenEquivalent, 130);
assert.strictEqual(summary.sessions[0].reportedInputTokens, 11);
assert.strictEqual(summary.sessions[0].domains.skillRouter.resultCount, 2);
assert(summary.measurementNote.includes("estimates unless"), "estimated and provider-reported tokens must be distinguished");

const mcpSource = fs.readFileSync(path.join(__dirname, "../src/mcp.ts"), "utf8");
const uiSource = fs.readFileSync(path.join(__dirname, "../src/webview/panel/50-mcp.js"), "utf8");
assert(mcpSource.includes('if "automation" in _FEATURE_DOMAINS:'), "Automation registration must be conditional");
assert(mcpSource.includes('@_feature_tool("skillRouter")'), "Skill Router tools must be gated at registration");
assert(mcpSource.includes('@_feature_tool("knowledge")'), "Knowledge tools must be gated at registration");
assert(mcpSource.includes("class ToolUsageMiddleware(Middleware)"), "tool observations must cover the MCP call boundary");
assert(uiSource.includes("PKM does not claim access to Copilot's total conversation tokens"), "empty metrics UI must state the measurement boundary");
assert(uiSource.includes("provider-reported tokens"), "reported tokens must be displayed separately");

fs.rmSync(root, { recursive: true, force: true });
console.log("MCP feature domains test: registration gates and observable evidence semantics OK");
