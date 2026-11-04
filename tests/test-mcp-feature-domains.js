#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { mcpUsageSummary } = require("../dist/mcp/mcp-usage");

async function main() {
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-mcp-domains-"));
try {
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

const summary = await mcpUsageSummary(root);
assert.strictEqual(summary.sessions.length, 1);
assert.strictEqual(summary.sessions[0].calls, 2);
assert.strictEqual(summary.sessions[0].successes, 1);
assert.strictEqual(summary.sessions[0].inputBytes, 140);
assert.strictEqual(summary.sessions[0].estimatedTokenEquivalent, 130);
assert.strictEqual(summary.sessions[0].reportedInputTokens, 11);
assert.strictEqual(summary.sessions[0].domains.skillRouter.resultCount, 2);
assert(summary.measurementNote.includes("estimates unless"), "estimated and provider-reported tokens must be distinguished");

const limited = await mcpUsageSummary(root, 1);
assert.strictEqual(limited.sessions[0].calls, 1, "event limit must still apply");
fs.writeFileSync(path.join(events, "incomplete.json"), "{");
fs.mkdirSync(path.join(events, "not-an-event.json"));
assert.deepStrictEqual(await mcpUsageSummary(root), summary, "partial observations and directories must not break usage");
assert.deepStrictEqual((await mcpUsageSummary(path.join(root, "missing"))).sessions, []);

const originalStat = fs.promises.stat;
let release;
let entered;
const started = new Promise(resolve => { entered = resolve; });
const barrier = new Promise(resolve => { release = resolve; });
fs.promises.stat = async (...args) => {
  entered();
  await barrier;
  return originalStat(...args);
};
let pending;
try {
  pending = mcpUsageSummary(root);
  await started;
  let ticked = false;
  await new Promise(resolve => setImmediate(() => { ticked = true; resolve(); }));
  assert(ticked, "Extension Host event loop must remain available while usage I/O is pending");
} finally {
  release();
  fs.promises.stat = originalStat;
  if (pending) await pending;
}
fs.promises.stat = async () => { throw Object.assign(new Error("usage access denied"), { code: "EACCES" }); };
try {
  await assert.rejects(mcpUsageSummary(root), /usage access denied/, "I/O errors must not become empty success");
} finally {
  fs.promises.stat = originalStat;
}

const mcpSource = fs.readFileSync(path.join(__dirname, "../src/mcp/mcp.ts"), "utf8");
const uiSource = fs.readFileSync(path.join(__dirname, "../src/webview/panel/50-mcp.js"), "utf8");
const extensionSource = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
const statusSource = extensionSource.match(/function mcpPanelStatusData\([\s\S]*?\n\}/)?.[0] || "";
assert(statusSource.includes("deferred: true"), "automatic status must mark usage as not loaded");
assert(!statusSource.includes("mcpUsageSummary("), "automatic status must never scan the usage ledger");
assert(extensionSource.includes("await mcpUsageSummary(activeStorePath)"), "explicit usage refresh must await asynchronous I/O");

const context = vm.createContext({ Date, state: { tab: "other" }, updateGlobalMcpWarning() {} });
vm.runInContext(`let mcpStatusCache = null; let mcpStatusUpdatedAt = 0;\n${
  uiSource.slice(uiSource.indexOf("function mcpOnStatus("), uiSource.indexOf("function mcpOnGenerated("))
}`, context);
vm.runInContext(`
  mcpOnStatus({store:{path:'root-a'},usage:{deferred:true}});
  mcpOnUsage({sessions:[{calls:2}]});
  mcpOnStatus({store:{path:'root-a'},usage:{sessions:[],deferred:true}});
  if (mcpStatusCache.usage.sessions[0]?.calls !== 2) throw Error('same-root refresh discarded loaded evidence');
  mcpOnStatus({store:{path:'root-b'},usage:{sessions:[],deferred:true}});
  if (!mcpStatusCache.usage.deferred || mcpStatusCache.usage.sessions.length) throw Error('evidence crossed Knowledge Roots');
  mcpOnUsage({storePath:'root-a',sessions:[{calls:99}]});
  if (!mcpStatusCache.usage.deferred) throw Error('late usage response crossed Knowledge Roots');
  mcpOnUsage({storePath:'root-b',sessions:[{calls:3}]});
  if (mcpStatusCache.usage.sessions[0]?.calls !== 3) throw Error('current-root usage response was lost');
`, context);
assert(mcpSource.includes('if "automation" in _FEATURE_DOMAINS:'), "Automation registration must be conditional");
assert(mcpSource.includes('@_feature_tool("skillRouter")'), "Skill Router tools must be gated at registration");
assert(mcpSource.includes('@_feature_tool("knowledge")'), "Knowledge tools must be gated at registration");
assert(mcpSource.includes("class ToolUsageMiddleware(Middleware)"), "tool observations must cover the MCP call boundary");
assert(uiSource.includes("PKM does not claim access to Copilot's total conversation tokens"), "empty metrics UI must state the measurement boundary");
assert(uiSource.includes("provider-reported tokens"), "reported tokens must be displayed separately");

console.log("MCP feature domains test: registration gates and observable evidence semantics OK");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
