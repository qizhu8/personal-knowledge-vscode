const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const help = read("src/webview/panel/06-help.js");
const strings = JSON.parse(read("resources/locales/en.json")).strings;

function fixture() {
  const actions = [], requests = [], warnings = [];
  const elements = new Map();
  const heading = { scrollIntoView: () => actions.push("scroll"), focus: () => actions.push("focus") };
  const detail = { innerHTML: "" };
  const button = {}, guide = {}, text = { textContent: "" };
  const banner = { dataset: {}, hidden: false, classList: { add() {}, remove() {} },
    querySelector: selector => selector === ".mcp-help-action" ? guide : button };
  elements.set("detail", detail);
  elements.set("mcp-global-warning", banner);
  elements.set("mcp-global-warning-text", text);
  elements.set("mcp-runtime-status", heading);
  elements.set("mcp-python-path", heading);
  elements.set("mcp-lifecycle", heading);
  elements.set("mcp-regenerate-server-code", heading);
  elements.set("env-out", detail);
  const context = vm.createContext({
    console: { error: (...args) => warnings.push(args) }, Date, Map, Set,
    state: { tab: "notes" }, uiI18n: { resolved: "en" }, settingsSubtabs: {},
    workspaceSurfaces: { help:["help"], knowledge:["notes"], settings:["mcp"] },
    t: key => strings[key] || key,
    esc: value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    uiIcon: () => "", humanSizeJs: () => "", loadProfilingEnabled: false,
    ask: (command, data) => requests.push({ command, data }),
    selectSettingsSubtab: (...args) => actions.push(args), applySettingsSubtab() {},
    requestAnimationFrame: callback => callback(), setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    tabCacheIsFresh: () => true,
    document: {
      getElementById: id => elements.get(id) || null,
      querySelector: selector => ({ click: () => { context.state.tab = selector.includes('"help"') ? "help" : "mcp"; actions.push(selector); } }),
      querySelectorAll: () => [], addEventListener() {},
    },
    vscode: { getState: () => ({}), setState() {}, postMessage: message => requests.push(message) },
    window: { addEventListener() {} },
  });
  vm.runInContext(help, context);
  vm.runInContext(read("src/webview/panel/50-mcp.js"), context);
  vm.runInContext(read("src/webview/panel/30-environments.js"), context);
  vm.runInContext(read("src/webview/panel/51-skill-router.js"), context);
  return { context, actions, requests, warnings, elements, detail, button, guide, text, banner };
}
const healthy = () => ({ installed:true, current:true, store:{ valid:true, path:"/knowledge" },
  mcpPython:{ valid:true, path:"/python", version:"3.11" }, mcpRuntime:{ healthy:true, exists:true },
  automaticSetup:{ state:"ready" } });

test("cold and stale MCP navigation inspects status without maintenance; fresh navigation reuses metadata", () => {
  const f = fixture();
  f.context.renderMcpPane = () => f.actions.push("render");
  f.context.renderMcpLoading = () => f.actions.push("loading");
  f.context.tabCacheIsFresh = updatedAt => updatedAt === 100;
  vm.runInContext("mcpStatusCache = null; mcpStatusUpdatedAt = 0", f.context);
  f.context.showMcpTab();
  assert.equal(f.requests.at(-1).command, "mcpStatus");
  assert(f.actions.includes("loading"));
  f.context.input = healthy();
  vm.runInContext("mcpStatusCache = input; mcpStatusUpdatedAt = 100", f.context);
  f.requests.length = 0;
  f.context.showMcpTab();
  assert.equal(f.requests.length, 0);
  vm.runInContext("mcpStatusUpdatedAt = 0", f.context);
  f.context.showMcpTab();
  assert.equal(f.requests.at(-1).command, "mcpStatus");
  assert(!f.requests.some(request => request.command === "checkMcp"));
});

test("problem guidance keeps errors escaped and routes only to known Help sections", () => {
  const f = fixture();
  const html = f.context.problemGuidanceHtml("<error>", "Inspect first", "", "setup");
  assert.match(html, /&lt;error&gt;/);
  assert.match(html, /openHelpSection\('setup'\)/);
  assert.throws(() => f.context.problemGuidanceHtml("error", "next", "", "command:delete"));
  f.context.openHelpSection("setup");
  assert.equal(f.context.state.tab, "help");
  assert.equal(vm.runInContext("helpPendingSection", f.context), 11);
  assert.equal(f.requests.length, 0, "reading guidance does not install or execute");
});

test("missing root, Python, runtime, server and setup errors have distinct meaningful actions", () => {
  const cases = [
    [{ ...healthy(), store:{valid:false} }, "Choose Knowledge Root", "store"],
    [{ ...healthy(), mcpPython:{valid:false} }, "Choose Python", "python"],
    [{ ...healthy(), mcpRuntime:{healthy:false,error:"Bad imports"} }, "Review environment repair", "runtime"],
    [{ ...healthy(), installed:false,current:false }, "Review server setup", "setup"],
    [{ ...healthy(), current:false }, "Review component update", "setup"],
    [{ ...healthy(), automaticSetup:{state:"error",error:"pip failed"} }, "Review setup output", "retry"],
  ];
  for (const [data, label, kind] of cases) {
    const f = fixture();
    const presentation = f.context.mcpSetupPresentation(data);
    assert.equal(presentation.label, label);
    assert.equal(presentation.kind, kind);
  }
});

test("banner navigation never starts runtime repair or server generation; root uses existing chooser", () => {
  for (const data of [
    { ...healthy(), mcpRuntime:{healthy:false,error:"imports failed"} },
    { ...healthy(), installed:false,current:false },
    { ...healthy(), automaticSetup:{state:"error",error:"pip failed"} },
  ]) {
    const f = fixture();
    f.context.input = data;
    vm.runInContext("mcpStatusCache = input", f.context);
    f.context.updateGlobalMcpWarning(data);
    f.button.onclick();
    assert(f.actions.includes("focus"));
    assert.equal(f.requests.length, 0);
  }
  const f = fixture();
  f.context.input = { ...healthy(), store:{valid:false} };
  vm.runInContext("mcpStatusCache = input", f.context);
  f.context.mcpSetupAction({});
  assert.equal(f.requests[0].command, "reconfigureKnowledgeRoot");
});

test("unknown client health stays non-warning; active uncertain calls route to lifecycle", () => {
  const f = fixture();
  f.context.updateGlobalMcpWarning({ installed:true,current:true,lifecycle:{connectionState:"unverified"} });
  assert(f.banner.hidden);
  const data = { ...healthy(), lifecycle:{instances:[{heartbeatFresh:true,uncertainCalls:1}]} };
  f.context.updateGlobalMcpWarning(data);
  assert(!f.banner.hidden);
  assert.match(f.text.textContent, /Do not replay/);
  f.button.onclick();
  assert(f.actions.includes("focus"));
  assert.equal(f.requests.length, 0);
  f.context.updateGlobalMcpWarning(healthy());
  assert(f.banner.hidden);
});

test("missing component rows offer setup navigation instead of claiming an automatic fix", () => {
  const f = fixture();
  const html = f.context.renderMcpDashboard({ ...healthy(), current:false, knowledgeVersion:"2", installedKnowledgeVersion:"1" });
  assert.match(html, /Review component setup/);
  assert.match(html, /openMcpSetup\('server'\)/);
  assert.match(f.context.mcpRuntimeProgressHtml({ ...healthy(), automaticSetup:{state:"error",error:"pip failure"} }), /Review active clients/);
});

test("ordinary missing envs and managed MCP envs do not offer the same repair", () => {
  const f = fixture();
  f.context.environments = [
    {id:"ordinary",name:"Ordinary",manager:"venv",missing:true,path:"/env"},
    {id:"managed",name:"PKM",manager:"venv",missing:true,path:"/pkm",isMcpRuntime:true},
  ];
  vm.runInContext("envCache = environments", f.context);
  const ordinary = f.context.envCardHtml(f.context.environments[0], 0);
  assert.match(ordinary, /Select environment folder/);
  assert.doesNotMatch(ordinary, /Review MCP runtime repair/);
  const managed = f.context.envCardHtml(f.context.environments[1], 0);
  assert.match(managed, /Review MCP runtime repair/);
  assert.doesNotMatch(managed, /Select environment folder/);
  f.context.onEnvPackages({id:"ordinary",error:"pip is missing",packages:[]});
  assert.match(f.detail.innerHTML, /pip is missing/);
  assert.doesNotMatch(f.detail.innerHTML, /0 packages/);
  f.context.onEnvFolderDetected({ok:false,error:"no interpreter"});
  assert.match(f.detail.innerHTML, /Select environment folder/);
  f.context.onEnvSize({id:"managed",error:"du failed"});
  assert.match(f.detail.innerHTML, /Size is unknown, not zero/);
  assert.doesNotMatch(f.detail.innerHTML, /Review MCP runtime repair|Select environment folder/);
  assert.match(f.detail.innerHTML, /openHelpSection\('tools'\)/);
});

test("model setup, readiness and performance errors have explicit safe review actions", () => {
  const f = fixture();
  assert.match(f.context.skillRouterSetupHtml({setup:{phase:"failed",failedPhase:"runtime",error:"torch missing",source:"huggingface"}}), /Review model setup and budget/);
  assert.match(f.context.skillRouterProblemHtml("Timed out", true), /Refresh observations/);
  assert.doesNotMatch(f.context.skillRouterModelReadiness({semanticStatus:"disabled",solution:{},skillServing:{}}), /pkm-problem-guidance/);
  assert.match(f.context.skillRouterModelReadiness({semanticStatus:"unavailable",solution:{requested_package_id:"model"},skillServing:{}}), /Recheck model status/);
  assert.equal(f.requests.length, 0, "rendering error guidance must not download or invoke a model");
});

test("resolved Python probe errors are retained in env status and cleared only by successful probes", async () => {
  const source = read("src/extension.ts");
  const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  const functions = ast.statements.filter(statement => ts.isFunctionDeclaration(statement)
    && ["refreshEnvironmentVersion","refreshEnvironmentSize","envListForUi"].includes(statement.name?.text));
  let result = {version:"",cached:false,error:"Cannot start Python"};
  const warnings = [];
  const context = vm.createContext({
    Map, path, fs:{existsSync:()=>true}, log:{warn:message=>warnings.push(message)},
    pyenvPyVersion:async()=>result, pyenvSize:async()=>({bytes:0,human:"",at:"",cached:false,error:"du failed"}), pyenvList:()=>[{id:"env",path:"/pkm",python:"/pkm/python"}],
    pyenvsRoot:()=>"/", managedMcpRuntimePath:()=>"/pkm",
  });
  vm.runInContext(ts.transpile("const environmentProbeErrors = new Map<string,string>(); const environmentSizeProbeErrors = new Map<string,string>();\n"
    + functions.map(statement=>statement.getText(ast)).join("\n"), {module:ts.ModuleKind.CommonJS}), context);
  await context.refreshEnvironmentVersion("env");
  assert.equal(context.envListForUi()[0].probeError, result.error);
  assert.equal(context.envListForUi()[0].isMcpRuntime, true);
  assert.equal(warnings.length, 1);
  result = {version:"3.11",cached:false};
  await context.refreshEnvironmentVersion("env");
  assert.equal(context.envListForUi()[0].probeError, undefined);
  await context.refreshEnvironmentSize("env");
  assert.equal(context.envListForUi()[0].probeError, "du failed");
  context.pyenvSize = async()=>({bytes:128,human:"128 B",at:"now",cached:false});
  await context.refreshEnvironmentSize("env");
  assert.equal(context.envListForUi()[0].probeError, undefined);
});

test("Chat help/log commands work before initialization and cold main panels retain Help section", () => {
  const host = read("src/chat/api-chat-view.ts");
  const handle = host.slice(host.indexOf("private async handle("));
  assert(handle.indexOf('message.type === "openHelp"') < handle.indexOf("this.initialize()"));
  assert(handle.indexOf('message.type === "showLogs"') < handle.indexOf("this.initialize()"));
  const extension = read("src/extension.ts");
  assert.match(extension, /pendingHelpSection = section/);
  assert.match(extension, /respond\(\{ command: "openTab", tab, helpSection \}\)/);
  const command = extension.slice(extension.indexOf('registerCommand("personalKnowledge.openHelp"'), extension.indexOf('registerCommand("_personalKnowledge.testNavigationPath"'));
  assert.doesNotMatch(command, /ensureSetup|ensureMcpRuntime|install/);
  const status = extension.slice(extension.indexOf('case "mcpStatus":'), extension.indexOf('case "checkMcp":'));
  assert.match(status, /respond\(\{ command: "mcpStatus"/);
  assert.doesNotMatch(status, /maintainPkmIntegration|ensureMcpRuntime/);
  const start = extension.indexOf('context.subscriptions.push(vscode.commands.registerCommand("personalKnowledge.openHelp"');
  const statement = extension.slice(start, extension.indexOf("}));", start) + 4);
  const session = {ready:false}, messages = [];
  let registered;
  const panel = {reveal(){},webview:{postMessage:message=>messages.push(message)}};
  const context = vm.createContext({context:{subscriptions:[]},getOrCreatePanel:()=>panel,panelSession:()=>session,
    vscode:{ViewColumn:{One:1},commands:{registerCommand:(_name,callback)=>{registered=callback;return {};}}}});
  vm.runInContext(ts.transpile(statement, {target:ts.ScriptTarget.ES2022}), context);
  registered("setup");
  assert.equal(session.pendingTab, "help");
  assert.equal(session.pendingHelpSection, "setup");
  assert.equal(messages.length, 0);
  session.ready = true;
  registered("agents");
  assert.equal(messages[0].command, "openTab");
  assert.equal(messages[0].helpSection, "agents");
});
