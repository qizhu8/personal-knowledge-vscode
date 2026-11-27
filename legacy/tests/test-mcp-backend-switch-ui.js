const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("Settings keeps selection separate from manager observations and locks unknown outcomes", () => {
  const first = "53e6cab2-f06f-47e7-9e45-03c7c19335ac";
  const second = "41ca1427-cc2a-4654-ab68-3844434b6124";
  const serviceId = "50ea9a20-9c4a-48ba-8abe-4bc2891bc574";
  const candidates = [
    { mode: "original", version: "2.19.0", generation: first, runtimeBuild: "a".repeat(64), compatible: true },
    { mode: "bundled-v5", version: "0.1.0", generation: second, runtimeBuild: "b".repeat(64), compatible: true },
  ];
  const sent = [], slot = { innerHTML: "", contains: () => false };
  let onMessage;
  const ui = {
    state: { tab: "mcp" },
    window: { addEventListener: (_, listener) => { onMessage = listener; } },
    vscode: { getState: () => ({}), postMessage: value => sent.push(value) },
    helpText: en => en, esc: value => String(value),
    document: { getElementById: () => slot },
    setTimeout: () => 1, clearTimeout: () => {},
  };
  vm.createContext(ui);
  vm.runInContext(readFileSync(join(__dirname, "../src/webview/panel/50-mcp.js"), "utf8"), ui);
  const active = (generation, phase = "accepting", backendPid = 100) => ({
    ...candidates.find(item => item.generation === generation),
    generation, phase, backendPid, inFlight: 0, uncertain: 0, backgroundActive: 0, backgroundUncertain: 0,
  });

  const reply = (requestId, data) => onMessage({ data: { command: "mcpBackendSwitchResult", data: { requestId, ...data } } });
  const applyDisabled = () => /id="mcp-backend-apply"[^>]*disabled/.test(slot.innerHTML);
  ui.requestMcpBackend("Read");
  reply(1, { error: "unbound" });
  assert.match(slot.innerHTML, /native pkm provider/);
  assert(applyDisabled());
  ui.requestMcpBackend("Read");
  reply(2, { active: active(first), serviceId, candidates });
  ui.selectMcpBackend(second);
  assert.equal(sent.length, 2, "Selecting a target does not send anything to the host.");
  assert.match(slot.innerHTML, /Original MCP · Accepting calls<\/strong>\s*<span>MCP version v2\.19\.0/);
  assert.match(slot.innerHTML, /Bundled v5 MCP · v0\.1\.0<\/option>/);
  const visible = slot.innerHTML.replace(/<details[\s\S]*?<\/details>/g, "").replace(/<[^>]*>/g, "");
  assert(!visible.includes(first));
  assert(!visible.includes("a".repeat(64)));
  assert.match(slot.innerHTML, /<details[^>]*>\s*<summary>Diagnostic details/);
  assert(!applyDisabled());
  ui.requestMcpBackend("Apply");
  ui.requestMcpBackend("Apply");
  assert.equal(sent.length, 3, "Duplicate apply cannot dispatch while pending.");
  assert.equal(sent[2].generation, second);
  assert.equal(sent[2].activeGeneration, first);
  assert.equal(sent[2].runtimeBuild, "b".repeat(64), "Display versions never replace the exact switch digest.");
  reply(2, { error: "unbound" });
  reply(3, { active: active(first, "draining"), serviceId, progress: true });
  assert.match(slot.innerHTML, /Original MCP · Draining calls<\/strong>\s*<span>MCP version v2\.19\.0/);
  assert(applyDisabled());
  reply(3, { active: active(second, "accepting", 200), serviceId, candidates, outcome: "completed" });
  assert.match(slot.innerHTML, /Bundled v5 MCP · Accepting calls<\/strong>\s*<span>MCP version v0\.1\.0/);
  assert.match(slot.innerHTML, /confirmed completion/);
  ui.selectMcpBackend(first);
  ui.requestMcpBackend("Apply");
  assert.equal(sent[3].activePid, 200);
  assert.doesNotMatch(slot.innerHTML, /confirmed completion/,
    "A new switch must not report the previous switch as completed while the current result is pending.");
  reply(4, { active: active(second, "accepting", 200), serviceId, candidates, outcome: "unknownOutcome" });
  assert.match(slot.innerHTML, /do not retry or replay/);
  assert(applyDisabled());
  assert.equal(sent.length, 4);
});

test("Reloaded Settings automatically follows backend startup, failures and recovery without user refresh", () => {
  const sent = [], timers = new Map(), slot = { innerHTML: "", contains: () => false };
  let onMessage, timerId = 0;
  const ui = {
    state: { tab: "mcp" },
    window: { addEventListener: (_, listener) => { onMessage = listener; } },
    vscode: { getState: () => ({}), postMessage: value => sent.push(value) },
    helpText: en => en, esc: value => String(value).replace(/</g, "&lt;"),
    document: { getElementById: () => slot },
    tabCacheIsFresh: () => true, ask: () => {},
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
  };
  vm.createContext(ui);
  vm.runInContext(readFileSync(join(__dirname, "../src/webview/panel/50-mcp.js"), "utf8"), ui);
  vm.runInContext("mcpStatusCache = {}; renderMcpPane = () => refreshMcpBackendSection();", ui);
  const reply = data => onMessage({ data: { command: "mcpBackendSwitchResult",
    data: { requestId: sent.at(-1).requestId, ...data } } });
  const advance = delay => {
    const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
    assert(entry, `Expected a ${delay}ms timer`);
    timers.delete(entry[0]);
    entry[1].callback();
  };
  ui.showMcpTab();
  assert.match(slot.innerHTML, /Loading backend status/);
  assert.doesNotMatch(slot.innerHTML, /MCP version Not verified/);
  assert.equal(sent.length, 1);
  ui.showMcpTab();
  assert.equal(sent.length, 1, "Opening Settings twice does not duplicate the pending status request.");
  reply({ error: "notAdmitted" });
  assert.match(slot.innerHTML, /Backend not started/);
  assert.doesNotMatch(slot.innerHTML, /<span>MCP version/);
  const notStartedMarkup = slot.innerHTML;
  advance(10_000);
  assert.equal(slot.innerHTML, notStartedMarkup, "Background reads do not introduce loading text or toggle controls.");
  assert.equal(sent.length, 2, "Backend startup is checked automatically.");
  reply({ active: { mode: "original", version: "2.19.0", phase: "accepting", backendPid: 100,
    generation: "original", runtimeBuild: "a".repeat(64), inFlight: 0, uncertain: 0, backgroundUncertain: 0 } });
  assert.match(slot.innerHTML, /MCP version v2\.19\.0/);
  const stable = { active: { mode: "original", version: "2.19.0", phase: "accepting", backendPid: 100,
    generation: "original", runtimeBuild: "a".repeat(64), inFlight: 0, uncertain: 0, backgroundUncertain: 0 } };
  let writes = 0, markup = slot.innerHTML;
  Object.defineProperty(slot, "innerHTML", { get: () => markup, set: value => { writes++; markup = value; } });
  advance(30_000);
  reply(stable);
  assert.equal(writes, 0, "Identical status never replaces DOM or collapses diagnostic details.");
  assert.doesNotMatch(markup, /Reading manager status/);
  advance(30_000);
  reply({ error: "busy" });
  assert.equal(writes, 0, "A concurrent host operation does not replace known status with a transient busy state.");
  ui.document.hidden = true;
  const beforeHidden = sent.length;
  advance(30_000);
  assert.equal(sent.length, beforeHidden, "Hidden windows do not query the host.");
  ui.document.hidden = false;
  advance(30_000);
  reply({ error: "loadingFailed", detail: "Admission denied <root>" });
  assert.match(slot.innerHTML, /Backend status failed/);
  assert.match(slot.innerHTML, /Admission denied &lt;root>/);
  advance(10_000);
  advance(30_000);
  assert.match(slot.innerHTML, /Manager status could not be verified/);
  advance(10_000);
  reply({ active: { mode: "bundled-v5", version: "0.1.0", phase: "accepting", backendPid: 100,
    generation: "v5", runtimeBuild: "b".repeat(64), inFlight: 0, uncertain: 0, backgroundUncertain: 0 } });
  assert.match(slot.innerHTML, /MCP version v0\.1\.0/);
  assert(sent.every(message => message.command === "mcpBackendSwitchRead"), "Automatic updates never start or switch a backend.");
  ui.state.tab = "notes";
  const beforeLeaving = sent.length;
  advance(30_000);
  assert.equal(sent.length, beforeLeaving, "Polling stops after leaving Settings.");
  ui.state.tab = "mcp";
  ui.showMcpTab();
  reply({ outcome: "unknownOutcome" });
  assert.equal(timers.size, 0, "Unknown switch outcomes still require explicit review; no operation is replayed.");
});
