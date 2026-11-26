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
    { generation: first, runtimeBuild: "a".repeat(64), compatible: true },
    { generation: second, runtimeBuild: "b".repeat(64), compatible: true },
  ];
  const sent = [], slot = { innerHTML: "", contains: () => false };
  let onMessage;
  const ui = {
    window: { addEventListener: (_, listener) => { onMessage = listener; } },
    vscode: { getState: () => ({}), postMessage: value => sent.push(value) },
    helpText: en => en, esc: value => String(value),
    document: { getElementById: () => slot },
    setTimeout: () => 1, clearTimeout: () => {},
  };
  vm.createContext(ui);
  vm.runInContext(readFileSync(join(__dirname, "../src/webview/panel/50-mcp.js"), "utf8"), ui);
  const active = (generation, phase = "accepting", backendPid = 100) => ({
    generation, phase, backendPid, inFlight: 0, uncertain: 0, backgroundActive: 0, backgroundUncertain: 0,
  });
  const reply = (requestId, data) => onMessage({ data: { command: "mcpBackendSwitchResult", data: { requestId, ...data } } });
  const applyDisabled = () => /id="mcp-backend-apply"[^>]*disabled/.test(slot.innerHTML);
  ui.requestMcpBackend("Read");
  reply(1, { error: "unbound" });
  assert.match(slot.innerHTML, /no verified live-switch binding/);
  assert(applyDisabled());
  ui.requestMcpBackend("Read");
  reply(2, { active: active(first), serviceId, candidates });
  ui.selectMcpBackend(second);
  assert.equal(sent.length, 2, "Selecting a target does not send anything to the host.");
  assert.match(slot.innerHTML, new RegExp(`<strong>Accepting calls</strong>\\s*<code>${first}`));
  assert(!applyDisabled());
  ui.requestMcpBackend("Apply");
  ui.requestMcpBackend("Apply");
  assert.equal(sent.length, 3, "Duplicate apply cannot dispatch while pending.");
  assert.equal(sent[2].generation, second);
  assert.equal(sent[2].activeGeneration, first);
  reply(2, { error: "unbound" });
  reply(3, { active: active(first, "draining"), serviceId, progress: true });
  assert.match(slot.innerHTML, new RegExp(`<strong>Draining calls</strong>\\s*<code>${first}`));
  assert(applyDisabled());
  reply(3, { active: active(second, "accepting", 200), serviceId, candidates, outcome: "completed" });
  assert.match(slot.innerHTML, new RegExp(`<strong>Accepting calls</strong>\\s*<code>${second}`));
  assert.match(slot.innerHTML, /confirmed completion/);
  ui.selectMcpBackend(first);
  ui.requestMcpBackend("Apply");
  assert.equal(sent[3].activePid, 200);
  reply(4, { active: active(second, "accepting", 200), serviceId, candidates, outcome: "unknownOutcome" });
  assert.match(slot.innerHTML, /do not retry or replay/);
  assert(applyDisabled());
  assert.equal(sent.length, 4);
});
