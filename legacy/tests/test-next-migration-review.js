const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function panel() {
  const detail = { style: {}, innerHTML: "" };
  const buttons = new Map();
  const asks = [];
  const context = {
    document: { getElementById(id) {
      if (id === "detail") return detail;
      if (id === "migration-review" || id === "background-process-refresh") {
        if (!buttons.has(id)) buttons.set(id, {});
        return buttons.get(id);
      }
      return null;
    } },
    state: { tab: "backgroundTasks" },
    esc: value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    mcpLaunchAttributionHtml: () => "",
    problemGuidanceHtml: () => "Inventory unavailable",
    helpText: value => value,
    ask: (...args) => asks.push(args),
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, "../src/webview/panel/52-background-tasks.js"), "utf8");
  vm.runInContext(`${source}; this.tasks = backgroundTasksOnSnapshot; this.processes = backgroundProcessesOnSnapshot;`, context);
  context.tasks({ tasks: [] });
  return { context, detail, buttons, asks };
}

test("opt-in review requests only existing process observation and never approves cutover", () => {
  const { context, detail, buttons, asks } = panel();
  assert.match(detail.innerHTML, /Review next-server migration blockers/);
  assert.doesNotMatch(detail.innerHTML, /Production migration: not authorized/);
  assert.deepEqual(asks, []);
  buttons.get("migration-review").onclick();
  assert.equal(asks.length, 1);
  assert.equal(asks[0][0], "backgroundProcesses");
  assert.match(detail.innerHTML, /Loading migration observations/);
  context.processes({ sampledAt: "fixture-time", processes: [] });
  assert.match(detail.innerHTML, /0 recognized MCP processes/);
  assert.match(detail.innerHTML, /not authorized or verified/);
  assert.match(detail.innerHTML, /cannot prove their absence or a drain receipt, even when empty/);
  assert.match(detail.innerHTML, /Trusted next-server endpoint, workspace, actor and credential binding are not established/);
  assert.match(detail.innerHTML, /No connection, service, root or settings were changed/);
  buttons.get("migration-review").onclick();
  assert.equal(asks.length, 2);
  assert.match(detail.innerHTML, /Loading migration observations/);
});

test("review reports synthetic busy, stale and failed observations without trusting identity", () => {
  const { context, detail, buttons } = panel();
  buttons.get("migration-review").onclick();
  const process = (pid, runtime, runtimeError) => ({
    pid, parentPid: 1, elapsedSeconds: 1, rssBytes: 1, kind: "mcp",
    entryPath: "/fixture", runtime, runtimeError,
  });
  context.processes({ sampledAt: "<fixture>", processes: [
    process(1, { fresh: true, phase: "draining", inFlight: 1, uncertainCalls: 1 }),
    process(2, { fresh: false, phase: "drained", inFlight: 0, uncertainCalls: 0 }),
    process(3, { fresh: true, phase: "drained", inFlight: 0, uncertainCalls: 0 }, "unavailable"),
    process(4, { fresh: true, phase: "drained", inFlight: "0", uncertainCalls: 0 }),
  ] });
  assert.match(detail.innerHTML, /4 recognized MCP processes; 3 with unknown lifecycle evidence; 1 reporting in-flight or uncertain calls/);
  assert.match(detail.innerHTML, /Sample: &lt;fixture&gt;/);
  assert.doesNotMatch(detail.innerHTML, /Production migration: ready/);
  context.processes({ error: "fixture failure", processes: [] });
  assert.match(detail.innerHTML, /Process inventory failed or is invalid; writer state is unknown/);
  assert.match(detail.innerHTML, /not authorized or verified/);
  context.processes({});
  assert.match(detail.innerHTML, /Process inventory failed or is invalid; writer state is unknown/);
});

test("existing production host observation feeds the review and preserves failure as unknown", async () => {
  const { context: ui, detail, buttons } = panel();
  buttons.get("migration-review").onclick();
  const extension = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
  const start = extension.indexOf('    case "backgroundProcesses": {');
  const end = extension.indexOf('\n    case "retrievalPerformance":', start);
  assert(start >= 0 && end > start);
  const ts = require("typescript");
  const branch = extension.slice(start, end);
  const source = ts.transpileModule(`async function dispatch() { switch ("backgroundProcesses") { ${branch} } }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  let fail = false, calls = 0;
  const host = {
    readInstalledExtensionBuild: () => ({ buildId: "fixture" }),
    context: { extensionPath: "/fixture", extension: { id: "fixture" } },
    loadedExtensionBuild: undefined,
    backgroundProcessInventory: { async snapshot() {
      calls++;
      if (fail) throw new Error("fixture unavailable");
      return { sampledAt: "fixture", processes: [] };
    } },
    respond: message => { assert.equal(message.command, "backgroundProcesses"); ui.processes(message.data); },
    log: { warn() {} },
    os: { hostname: () => "fixture" },
    process: { platform: "linux" },
  };
  vm.createContext(host);
  vm.runInContext(source, host);
  await host.dispatch();
  assert.equal(calls, 1);
  assert.match(detail.innerHTML, /0 recognized MCP processes/);
  assert.match(detail.innerHTML, /cannot prove their absence/);
  fail = true;
  await host.dispatch();
  assert.equal(calls, 2);
  assert.match(detail.innerHTML, /Process inventory failed or is invalid; writer state is unknown/);
});
