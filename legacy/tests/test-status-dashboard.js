const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const Module = require("node:module");
const { RetrievalWorkerManager } = require("../dist/retrieval/retrieval-worker");
const { normalizeGitHubSyncTarget } = require("../dist/sync/github-sync");

let panel, messages, handlers;
const vscode = {
  Uri: { joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts) }) },
  ViewColumn: { Active: 1 },
  window: { createWebviewPanel: () => panel, showErrorMessage: async () => {} },
  commands: { executeCommand: async command => messages.push({ command }) },
};
const originalLoad = Module._load;
let dashboardModule;
try {
  Module._load = function (name, ...args) { return name === "vscode" ? vscode : originalLoad.call(this, name, ...args); };
  dashboardModule = require("../dist/ui/status-dashboard");
} finally { Module._load = originalLoad; }
const { indexBuildPercent, dashboardSyncTargets, StatusDashboard } = dashboardModule;

test("Status bar has a stable PKM Status label and opens the Status dashboard", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
  const runtime = source.slice(source.indexOf("function registerExtensionHostRuntime("));
  assert.match(runtime, /status\.text = "PKM Status";/);
  assert.match(runtime, /status\.command = "personalKnowledge\.hostStatus";/);
  assert.match(runtime, /registerCommand\("personalKnowledge\.hostStatus", async \(\) => \{\s*await dashboard\.open\(\);/);
});

test("Index percentages require real valid counters, never null coercion or guessed completion", () => {
  for (const progress of [undefined, { current: null, total: 100 }, { current: 0, total: null },
    { current: 0, total: 0 }, { current: 3, total: 2 }, { current: -1, total: 3 },
    { current: 1, total: Infinity }, { current: NaN, total: 3 }]) assert.equal(indexBuildPercent(progress), undefined);
  assert.equal(indexBuildPercent({ current: 0, total: 10 }), 0);
  assert.equal(indexBuildPercent({ current: 1, total: 3 }), 33);
  assert.equal(indexBuildPercent({ current: 10, total: 10 }), 100);
});

test("Sync summary preserves errors, local repair, partial entities and explicit auto-off", () => {
  const target = normalizeGitHubSyncTarget({ id: "primary", name: "Primary", repository: "/fixture.git",
    automation: { enabled: true, initialSyncCompleted: true } });
  target.lastSync = { at: "2026-10-20T07:00:00Z", commit: "base", fingerprints: {} };
  target.lastFailure = { at: "2026-10-20T08:00:00Z", error: "publication failed", reason: "manual" };
  const one = runtime => dashboardSyncTargets([target], { primary: runtime })[0];
  assert.equal(one({ status: "scheduled" }).status, "error");
  assert.equal(one({ status: "syncing" }).status, "syncing");
  assert.equal(one({ status: "needs-attention", detail: "Local content needs repair. Remote has not been fetched." }).status, "needs-attention");
  target.lastSync.at = "2026-10-20T09:00:00Z";
  assert.equal(one({ status: "scheduled" }).status, "scheduled");
  assert.equal(one({ status: "error" }).status, "error", "an error without a timestamp is not proven superseded");
  assert.equal(one({ status: "error", lastAttemptAt: "2026-10-20T08:00:00Z", lastError: "old failure" }).status, "scheduled");
  target.lastSync.entityBases = { pending: "old-base" };
  assert.equal(one({ status: "scheduled" }).status, "partial");
  target.lastSync.entityBases = {};
  target.automation.enabled = false;
  assert.equal(one({ status: "paused" }).status, "paused");
  assert.equal(dashboardSyncTargets([target], {})[0].status, "paused");
});

test("Read-only index observation neither starts nor rebuilds a worker and preserves background build phase", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-status-observer-"));
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/status");
    assert.equal(request.headers["x-pkm-retrieval-token"], "test-token");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(status));
  });
  let status = { ok: true, ready: true, ready_generation: 1, building_generation: 2, building_revision: "next",
    work_state: "indexing", work_current: 2, work_total: 8, work_detail: "Indexing 2/8 documents" };
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const manager = new RetrievalWorkerManager(root, "/must-not-start.py", "/no-python", "fixture");
  manager.ensure = async () => { throw new Error("Observation must not ensure/start/recover a worker"); };
  assert.equal(await manager.observeStatus(), undefined);
  assert(!fs.existsSync(path.join(root, "worker.json")));
  fs.writeFileSync(path.join(root, "worker.json"), JSON.stringify({ port: server.address().port, pid: process.pid, token: "test-token" }));
  const observed = await manager.observeStatus();
  assert.equal(observed.ready, true, "an older ready generation continues serving");
  assert.equal(manager.lifecycleStatus().state, "working", "submission/old serving readiness does not mean the new generation finished");
  assert.deepEqual(manager.lifecycleStatus().progress, { current: 2, total: 8, unit: "documents" });
  status.work_current = null; status.work_total = null;
  await manager.observeStatus();
  assert.equal(manager.lifecycleStatus().progress, undefined);
  status = { ...status, building_revision: "", work_state: "idle", ready_generation: 2 };
  await manager.observeStatus();
  assert.equal(manager.lifecycleStatus().state, "ready");
});

test("Index observation remains cancellable while a response body is stalled", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-status-stalled-"));
  const server = http.createServer((_request, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.flushHeaders(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, "worker.json"), JSON.stringify({ port: server.address().port, pid: process.pid, token: "test-token" }));
  const manager = new RetrievalWorkerManager(root, "/unused", "/unused", "fixture");
  const start = Date.now();
  await assert.rejects(manager.observeStatus(), /abort|timed out/i);
  assert(Date.now() - start < 4000, "the 2-second status deadline covers reading the body, not only receiving headers");
});

test("Dashboard refresh is non-reentrant, hidden views stop polling, disposal drops late observations", async () => {
  messages = []; handlers = {};
  const subscription = () => ({ dispose() {} });
  panel = {
    visible: true, reveal() {}, dispose() { handlers.dispose?.(); },
    webview: {
      cspSource: "test-resource:", html: "", asWebviewUri: uri => ({ toString: () => uri.fsPath }),
      postMessage: async message => { messages.push(message); },
      onDidReceiveMessage: listener => { handlers.message = listener; return subscription(); },
    },
    onDidChangeViewState: listener => { handlers.visibility = listener; return subscription(); },
    onDidDispose: listener => { handlers.dispose = listener; return subscription(); },
  };
  let reads = 0, release;
  const source = () => { reads++; return new Promise(resolve => { release = resolve; }); };
  const dashboard = new StatusDashboard({ extensionUri: { fsPath: path.resolve(__dirname, "..") } }, source, async () => {});
  try {
    await dashboard.open();
    assert.match(panel.webview.html, /default-src 'none'/);
    handlers.message({ type: "ready" }); handlers.message({ type: "refresh" });
    assert.equal(reads, 1);
    panel.visible = false; handlers.visibility(); release({ updatedAt: "hidden" });
    await new Promise(setImmediate);
    assert.equal(messages.length, 0);
    handlers.message({ type: "refresh" });
    assert.equal(reads, 1);
    panel.visible = true; handlers.visibility();
    assert.equal(reads, 2);
    dashboard.dispose(); release({ updatedAt: "disposed" });
    await new Promise(setImmediate);
    assert.equal(messages.length, 0, "closing never publishes a late snapshot or leaves a polling timer");
  } finally { dashboard.dispose(); }
});
