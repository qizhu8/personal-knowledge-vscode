const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const helpSource = fs.readFileSync(path.join(root, "src/webview/panel/06-help.js"), "utf8");
const core = fs.readFileSync(path.join(root, "src/webview/panel/00-core.js"), "utf8");
const html = fs.readFileSync(path.join(root, "src/webview/panel.html"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ load = async () => {}, clipboard = async () => {} } = {}) {
  const requests = [], actions = [], errors = [];
  const status = { textContent: "" };
  const article = { querySelectorAll: () => [] };
  const detail = {
    innerHTML: "",
    querySelector: selector => selector === ".pkm-help-content" ? article
      : selector === ".pkm-help-toc" ? { appendChild() {} } : { addEventListener() {} },
  };
  const context = vm.createContext({
    state: { tab: "help" }, uiI18n: { resolved: "en" },
    workspaceSurfaces: { help: ["help"], knowledge: ["notes", "skills"], settings: ["mcp"] },
    ask: (command, data, button, silent) => requests.push({ command, data, button, silent }),
    openMcpSetup: target => actions.push(["setup", target]),
    loadMarkdownLibraries: load, marked: { parse: content => `<h1>${content}</h1>` },
    navigator: { clipboard: { writeText: clipboard } },
    console: { error: (...args) => errors.push(args) },
    esc: value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    document: {
      getElementById: () => detail,
      querySelector: selector => selector === ".pkm-help-status" ? status
        : { click: () => actions.push(["tab", selector]) },
      createElement: () => ({ textContent: "" }),
    },
  });
  vm.runInContext(helpSource, context);
  return { context, requests, actions, status, detail, errors };
}

test("Help is a sixth question-mark workspace with full-width, persistent, cold-load navigation", () => {
  assert.match(html, /data-workspace="settings"[\s\S]*data-workspace="help"[^>]*><span class="codicon codicon-question"/);
  assert.match(html, /data-workspace-group="help"[\s\S]*role="tablist" aria-label="Help views"[\s\S]*data-tab="help">Help<\/button>/);
  assert.match(core, /help:\['help'\]/);
  assert.match(core, /help:'Help'/);
  assert.match(core, /help:'help'/);
  assert.match(core, /help:'helpGuide'/);
  const navigation = fs.readFileSync(path.join(root, "src/webview/panel/20-knowledge.js"), "utf8");
  assert.match(navigation, /workspaceRoutes:.*\[state.workspace\]: state.tab/);
  assert.match(navigation, /const fullWidthTab = \['help'/);
  assert.match(navigation, /state.tab === 'help'[\s\S]*?showHelpTab\(\)/);
  assert.match(fs.readFileSync(path.join(root, "src/webview/panel/60-init.js"), "utf8"), /state.tab === 'help'\) showHelpTab\(true\)/);
  assert.match(fs.readFileSync(path.join(root, "dist/webview/panel.js"), "utf8"), /function showHelpTab/);
});

test("Host reads whitelisted bundled guides without a store or runtime; read failures remain errors", async () => {
  const source = fs.readFileSync(path.join(root, "src/ui/help-guide.ts"), "utf8");
  const exports = {};
  vm.runInNewContext(ts.transpile(source, { module: ts.ModuleKind.CommonJS }), { exports, require, Buffer });
  for (const [requested, expected] of [["en", "en"], ["zh-hans", "zh-hans"], ["../../package", "en"], ["ja", "en"]]) {
    const result = await exports.readHelpGuide(root, requested);
    assert.equal(result.language, expected);
    assert.match(result.content, /^# /);
  }
  await assert.rejects(() => exports.readHelpGuide(path.join(root, "tests/missing-help-host"), "en"), /ENOENT/);
  assert.doesNotMatch(source, /ensureSetup|store|ensureMcp|execFile/);
  const host = fs.readFileSync(path.join(root, "src/extension.ts"), "utf8");
  const handler = host.slice(host.indexOf('case "helpGuide"'), host.indexOf('case "panelViewState"'));
  assert.match(handler, /log.error/);
  assert.match(handler, /data: \{ language, requestId, error: message \}/);
  assert.doesNotMatch(handler, /ensureSetup|ensureMcp|store|execFile/);
});

test("guide links are real surfaces and both packaged documents contain useful copy-only requests", () => {
  const ast = ts.createSourceFile("core.js", core, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const mapping = ast.statements.find(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations[0]?.name.getText(ast) === "workspaceSurfaces");
  const surfaces = vm.runInNewContext(mapping.getText(ast) + "\nworkspaceSurfaces");
  const allowed = new Set([...Object.values(surfaces).flat(), "setup", "chat"]);
  for (const language of ["en", "zh-hans"]) {
    const content = fs.readFileSync(path.join(root, `resources/help/${language}.md`), "utf8");
    assert.equal((content.match(/^## /gm) || []).length, 14);
    assert.equal((content.match(/^```agent/gm) || []).length, 13);
    for (const [, destination] of content.matchAll(/\]\(pkm-help:([^)]+)\)/g)) assert(allowed.has(destination), destination);
    assert.doesNotMatch(content, /<script|javascript:|command:|https?:\/\//);
  }
  const ignore = fs.readFileSync(path.join(root, ".vscodeignore"), "utf8");
  assert.doesNotMatch(ignore, /^resources\/help/m);
  assert.match(ignore, /^docs\/\*\*/m);
});

test("cold Help requests are silent and unsupported UI languages have an explicit English fallback", async () => {
  const f = fixture();
  f.context.uiI18n.resolved = "ar";
  f.context.showHelpTab();
  assert.equal(f.requests[0].command, "helpGuide");
  assert.equal(f.requests[0].data.language, "en");
  assert.equal(f.requests[0].button, null);
  assert.equal(f.requests[0].silent, true);
  f.context.helpOnGuide({ language: "en", content: "Guide", requestId: 1 });
  await tick();
  assert.match(f.detail.innerHTML, /English is shown/);
  assert.match(f.detail.innerHTML, /lang="en" dir="ltr"/);
  f.context.showHelpTab();
  await tick();
  assert.equal(f.requests.length, 1, "cached content is reused");
});

test("locale and request fences prevent stale responses or async renders from taking over", async () => {
  let release;
  const f = fixture({ load: () => new Promise(resolve => { release = resolve; }) });
  f.context.showHelpTab();
  f.context.showHelpTab(true);
  f.context.helpOnGuide({ language: "en", content: "Stale", requestId: 1 });
  assert.match(f.detail.innerHTML, /Loading/);
  f.context.helpOnGuide({ language: "en", content: "Current", requestId: 2 });
  f.context.state.tab = "notes";
  f.detail.innerHTML = "Preserve current Note";
  release();
  await tick();
  assert.equal(f.detail.innerHTML, "Preserve current Note");
  f.context.state.tab = "help";
  f.context.uiI18n.resolved = "zh-hans";
  f.context.showHelpTab();
  f.context.helpOnGuide({ language: "en", error: "Old English error", requestId: 2 });
  assert.doesNotMatch(f.detail.innerHTML, /Old English error/);
});

test("read and Markdown failures show a retry; retry issues a fresh read", async () => {
  const f = fixture();
  f.context.showHelpTab();
  f.context.helpOnGuide({ language: "en", error: "<missing>", requestId: 1 });
  assert.match(f.detail.innerHTML, /role="alert"/);
  assert.match(f.detail.innerHTML, /&lt;missing&gt;/);
  assert.match(f.detail.innerHTML, /showHelpTab\(true\)/);
  f.context.showHelpTab(true);
  assert.equal(f.requests[1].data.requestId, 2);
  f.context.marked = undefined;
  f.context.helpOnGuide({ language: "en", content: "Guide", requestId: 2 });
  await tick();
  assert.match(f.detail.innerHTML, /renderer did not load/);
  assert.equal(f.errors.length, 1);
});

test("copy preserves exact text, never runs a request, and clipboard denial is actionable", async () => {
  const copied = [];
  const f = fixture({ clipboard: async text => copied.push(text) });
  const text = "Read [PKM path].\nDo not modify anything.\n";
  await f.context.copyHelpRequest(text);
  assert.deepEqual(copied, [text]);
  assert.equal(f.requests.length, 0);
  assert.match(f.status.textContent, /nothing has been executed/);
  const denied = fixture({ clipboard: async () => { throw new Error("Denied"); } });
  await denied.context.copyHelpRequest(text);
  assert.match(denied.status.textContent, /copy it manually/);
  assert.equal(denied.errors.length, 1);
});

test("internal navigation is allowlisted; setup opens existing guidance and Chat only opens its UI", () => {
  const f = fixture();
  f.context.openHelpDestination("notes");
  f.context.openHelpDestination("setup");
  f.context.openHelpDestination("chat");
  assert.equal(f.actions[0][0], "tab");
  assert.equal(f.actions[1][1], "python");
  assert.equal(f.requests[0].command, "openApiChat");
  f.context.openHelpDestination('notes"] command:delete');
  assert.equal(f.actions.length, 2);
  assert.equal(f.requests.length, 1);
  assert.match(f.status.textContent, /not available/);
});
