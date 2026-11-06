const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const strings = JSON.parse(fs.readFileSync(path.join(root, "resources/locales/en.json"), "utf8")).strings;
const source = fs.readFileSync(path.join(root, "src/webview/panel/50-mcp.js"), "utf8");
function classes() {
  const values = new Set();
  return { add: value => values.add(value), remove: value => values.delete(value), contains: value => values.has(value) };
}
function fixture() {
  const messages = [], order = [], elements = new Map(), saved = {};
  const panels = ["general", "mcp"].map(settingsPanel => ({ dataset: { settingsPanel }, hidden: settingsPanel === "mcp" }));
  const action = { textContent: "" };
  const banner = { classList: classes(), dataset: {}, querySelector: () => action };
  elements.set("mcp-global-warning", banner);
  elements.set("mcp-global-warning-text", { textContent: "" });
  elements.set("mcp-python-path", { value: "/missing/python", scrollIntoView() { order.push("scroll"); }, focus() { assert.equal(panels[1].hidden, false); order.push("focus"); } });
  elements.set("mcp-python-status", { style: {}, innerHTML: "" });
  elements.set("mcp-completion-slot", { innerHTML: "" });
  const context = vm.createContext({
    console, state: { tab: "notes" }, uiI18n: {resolved:"en"}, esc: String, uiIcon: () => "", t: key => strings[key] || key, loadProfilingEnabled: false,
    vscode: { getState: () => saved, setState: data => Object.assign(saved, data), postMessage: message => messages.push(message) },
    ask: (command, data) => messages.push({ command, data: JSON.parse(JSON.stringify(data)) }),
    requestAnimationFrame: callback => callback(), setTimeout: () => 0, updateTabNav: () => {},
    document: {
      getElementById: id => elements.get(id) || null,
      querySelectorAll: () => [],
      querySelector(selector) {
        if (selector.includes("data-settings-owner")) return { querySelectorAll: selector => selector === "[data-settings-panel]" ? panels : [] };
        if (selector.includes('data-tab="mcp"')) return { click() { context.state.tab = "mcp"; order.push("tab"); } };
        if (selector.includes("workspace-button") || selector.includes('data-tab="notes"')) return { click() { order.push("knowledge"); } };
        return null;
      },
    }, window: {},
  });
  const core = ts.createSourceFile("core.js", fs.readFileSync(path.join(root, "src/webview/panel/00-core.js"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = core.statements.filter(statement => ts.isFunctionDeclaration(statement) && ["selectSettingsSubtab", "applySettingsSubtab"].includes(statement.name?.text));
  vm.runInContext("const settingsSubtabs = {mcp:'general'};\n" + declarations.map(statement => statement.getText(core)).join("\n"), context);
  vm.runInContext(fs.readFileSync(path.join(root, "src/webview/panel/06-help.js"), "utf8"), context);
  vm.runInContext(source, context);
  context.renderMcpPane = data => { context.rendered = context.mcpRuntimeProgressHtml(data); };
  return { context, messages, elements, action, banner, panels, order };
}
const healthy = () => ({
  installed: true, current: true, installedVersion: "2.13.6", expectedVersion: "2.13.6",
  store: { valid: true, path: "/knowledge" }, mcpPython: { valid: true, path: "/python" },
  mcpRuntime: { healthy: true }, automaticSetup: { state: "ready" },
});

test("missing Python is actionable, not an automatic promise; warning opens a visible input", () => {
  const f = fixture();
  const data = { ...healthy(), mcpPython: { valid: false }, automaticSetup: { state: "action-required", error: "Python 3.10+ was not found" } };
  f.context.mcpOnStatus(data);
  assert.match(f.elements.get("mcp-global-warning-text").textContent, /Python 3.10/);
  assert.equal(f.action.textContent, "Choose Python");
  assert(!f.banner.hidden);
  f.action.onclick();
  assert(f.order.indexOf("tab") < f.order.indexOf("focus"));
  assert.equal(f.panels[1].hidden, false);
  assert.doesNotMatch(f.context.renderMcpDashboard(data), /PKM will finish this automatically/);
});

test("cold Config navigation retains its target until the Python input exists", () => {
  const f = fixture();
  const input = f.elements.get("mcp-python-path");
  f.elements.delete("mcp-python-path");
  f.context.openMcpSetup("python");
  assert(!f.order.includes("focus"));
  f.elements.set("mcp-python-path", input);
  f.context.mcpOnStatus(healthy());
  assert(f.order.includes("focus"));
});

test("current code with unhealthy runtime remains actionable; an unknown client is not a permanent warning", () => {
  const f = fixture();
  f.context.mcpOnStatus({ ...healthy(), mcpRuntime: { healthy: false, error: "missing imports" } });
  assert(!f.banner.hidden);
  f.context.mcpOnStatus({ installed: true, current: true, lifecycle: { connectionState: "unverified" } });
  assert(f.banner.hidden);
  assert.equal(f.elements.get("mcp-global-warning-text").textContent, "");
});

test("validation failure and Later preserve a resumable guide; healthy success alone completes it", () => {
  const f = fixture();
  const data = { ...healthy(), mcpPython: { valid: false }, firstRunGuide: { visible: true, step: "python" } };
  f.context.mcpOnStatus(data);
  f.context.saveMcpPython({});
  assert.deepEqual(f.messages.map(message => message.command), ["mcpSetPython"]);
  f.context.renderMcpPythonResult({ valid: false, saved: false, error: "Invalid Python" });
  assert(!f.messages.some(message => message.command === "dismissIntegrationGuide"));
  f.context.deferIntegrationGuide();
  assert.match(f.context.renderGettingStarted(data), /Resume Python guide/);
  assert(!f.messages.some(message => message.command === "dismissIntegrationGuide"));
  f.context.renderMcpPythonResult({ valid: true, saved: true, version: "3.11", runtime: { healthy: true } });
  assert.equal(f.messages.filter(message => message.command === "dismissIntegrationGuide").length, 1);
});

test("progress survives an absent DOM node and rerender, preserving terminal errors", () => {
  const f = fixture();
  const progress = { phase: "installing-requirements", text: "Downloading requirements", startedAt: 1000, updatedAt: 3000, output: "<download>" };
  f.context.mcpOnStatus(healthy());
  f.context.renderMcpRuntimeProgress(progress);
  f.context.state.tab = "mcp";
  f.context.mcpOnStatus({ ...healthy(), automaticSetup: { state: "running" } });
  assert.match(f.context.rendered, /Downloading requirements/);
  assert.match(f.context.rendered, /2s observed/);
  f.context.renderMcpRuntimeProgress({ ...progress, phase: "error", text: "Download failed" });
  assert.match(f.context.mcpRuntimeProgressHtml(vm.runInContext("mcpStatusCache", f.context)), /Download failed/);
  assert.equal(vm.runInContext("mcpStatusCache.automaticSetup.state", f.context), "error");
  f.context.mcpOnStatus(healthy());
  assert.doesNotMatch(f.context.rendered, /Download failed/);
});

test("newer shared runtime is preserved; Basic Note uses the existing creation command", () => {
  const f = fixture();
  const data = { ...healthy(), newerThanExpected: true };
  f.context.mcpOnStatus(data);
  assert.match(f.action.textContent, /Review/);
  f.context.createGettingStartedNote({});
  assert.deepEqual(f.messages.filter(message => message.command === "createKnowledgeItem"), [{ command: "createKnowledgeItem", data: { area: "notes" } }]);
  assert.match(f.context.renderGettingStarted(data), /Notes and Skills work without/);
  assert.match(f.context.renderGettingStarted(data), /project interpreter/);
  assert.match(f.context.mcpSetupPresentation(healthy()).text, /client tool discovery is not verified/);
});

test("tour close and Escape defer without completion; explicit Finish completes the tour", () => {
  const handlers = {}, posts = [], layer = { classList: classes(), setAttribute() {} };
  const context = vm.createContext({
    document: {
      getElementById: id => ({ addEventListener: (event, handler) => { handlers[`${id}:${event}`] = handler; } }),
      addEventListener: (event, handler) => { handlers[event] = handler; }, body: { classList: classes() },
    }, window: { removeEventListener() {} }, vscode: { postMessage: message => posts.push(message) },
    initialLoadComplete: false,
  });
  vm.runInContext(fs.readFileSync(path.join(root, "src/webview/panel/05-onboarding.js"), "utf8"), context);
  context.clearExperienceTarget = () => {};
  context.experienceLayer = () => layer;
  const begin = () => vm.runInContext("Object.assign(experience,{automatic:true,version:'4.0.22',audience:'new',moduleIds:['chat']});", context);
  begin();
  handlers["coachmark-close:click"]();
  assert.equal(posts.length, 0);
  begin();
  handlers.keydown({ key: "Escape", preventDefault() {} });
  assert.equal(posts.length, 0);
  begin();
  context.completeTour();
  assert.equal(posts[0].command, "completeTourModules");
  context.queueInitialExperience({ kind: "tour", version: "4.0.22", audience: "new", moduleIds: ["chat"] });
  assert.equal(vm.runInContext("experience.pending", context), null);
});

test("Chinese setup has localized primary guidance and an actual Python installation link", () => {
  const f = fixture();
  const translated = JSON.parse(fs.readFileSync(path.join(root, "resources/locales/zh-hans.json"), "utf8")).strings;
  f.context.t = key => translated[key] || key;
  const data = { ...healthy(), mcpPython: { valid: false }, automaticSetup: { state: "action-required" } };
  assert.equal(f.context.mcpSetupPresentation(data).label, translated["config.setupChoosePython"]);
  const html = f.context.renderGettingStarted(data);
  assert(html.includes(translated["config.gettingStartedCreateNote"]));
  assert(html.includes(translated["config.setupPythonExplanation"]));
  assert(html.includes('href="https://www.python.org/downloads/"'));
});

test("active-client repair requires review rather than automatically retrying uncertain work", () => {
  const f = fixture();
  f.context.mcpOnStatus({ ...healthy(), automaticSetup: { state: "action-required", error: "close/reconnect clients and drain uncertain calls" } });
  f.action.onclick();
  assert.equal(f.action.textContent, "Review setup");
  assert.equal(f.messages.length, 0);
});
