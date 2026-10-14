const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..");
let handler, listener, disposal, trusted = true, healthy = true;
let domains = ["automation"], nextResult = { ok: true, requests: [] };
let storePath = "/isolated/test/store";
let workspaceRoots = { linux: root };
const commands = new Map(), executions = [], serviceCalls = [], replies = [];
const baselineEvents = [];
let profiling = false;
const disposable = { dispose() {} };
const authoringRequests = {
  group_create: { name: "Tools", parent: "" },
  action_rename: { action_id: "test.authoring", name: "Renamed" },
  action_move: { action_id: "test.authoring", category: "Tools" },
  action_delete: { action_id: "test.authoring", content_hash: "pinned" },
  definition_read: { action_id: "test.authoring" },
  definition_save: { action_id: "test.authoring", content_hash: "pinned", definition: { action_id: "test.authoring", version: 2 } },
  source_read: { action_id: "test.authoring", filename: "/host/source.py" },
  source_save: { action_id: "test.authoring", filename: "/host/source.py", content: "print(1)", source_hash: "pinned-source" },
};
const webview = { cspSource: "vscode-webview:", html: "", asWebviewUri: uri => String(uri),
  onDidReceiveMessage(callback) { listener = callback; return disposable; },
  async postMessage(message) { replies.push(message); } };
const vscode = {
  version: "1.100.0",
  env: { async asExternalUri(uri) { return uri; }, async openExternal(uri) { executions.push(["external", String(uri)]); return true; } },
  workspace: { get isTrusted() { return trusted; }, getConfiguration: () => ({ get: key => key === "loadProfilingEnabled" ? profiling : workspaceRoots,
    async update(key, value, target) { assert.strictEqual(key, "actions.workspaceRoots"); assert.strictEqual(target, 1); workspaceRoots = value; } }) },
  chat: { createChatParticipant(id, callback) { assert.strictEqual(id, "personalKnowledge.actions"); handler = callback; return disposable; } },
  commands: { registerCommand(id, callback) { commands.set(id, callback); return disposable; },
    async executeCommand(...args) { executions.push(args); } },
  window: { createWebviewPanel: () => ({ webview, onDidDispose(callback) { disposal = callback; }, ...disposable }),
    showQuickPick() { throw Error("User choices must be in chat"); },
    showInformationMessage() { throw Error("User choices must be in chat"); },
    showInputBox() { throw Error("User choices must be in chat"); } },
  ViewColumn: { One: 1 }, Uri: { joinPath: (...parts) => parts.join("/"), parse: value => value },
  ConfigurationTarget: { Global: 1 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  MarkdownString: class { constructor() { this.value = ""; } appendText(text) { this.value += text; return this; }
    appendMarkdown(text) { this.value += text; return this; } },
};
const moduleExports = {};
vm.runInNewContext(fs.readFileSync(path.join(root, "dist", "ui", "action-browser.js"), "utf8"), {
  exports: moduleExports, require(name) {
    if (name === "vscode") return vscode;
    if (name === "../knowledge/filestore") return { getStorePath: () => storePath };
    if (name === "../runtime/action-workbench-server") return require("../dist/runtime/action-workbench-server");
    if (name === "../runtime/pkm-baseline") return { recordBaselineEvent(directory, enabled, event) {
      if (enabled) baselineEvents.push(event);
    } };
    if (name === "../mcp/mcp") return { configuredMcpFeatureDomains: () => domains,
      mcpRuntimeStatus: () => ({ healthy, python: "/managed/python", error: "Runtime unavailable" }), writeActionWorkspaceConfig() {} };
    if (name === "child_process") return { execFile(program, args, options, callback) {
      assert.strictEqual(program, "/managed/python");
      assert.strictEqual(args[2], "/isolated/test/store");
      assert.strictEqual(options.windowsHide, true);
      return { stdin: { end(input) { serviceCalls.push(JSON.parse(input)); callback(null, JSON.stringify(nextResult)); } } };
    } };
    return require(name);
  }, process, console, URL,
});

(async () => {
  const context = { extensionUri: root, extensionPath: root, globalStorageUri: { fsPath: "/isolated/global" }, subscriptions: [] };
  moduleExports.initializeActionChat(context);
  const runId = "action_run_" + "a".repeat(32), requestId = "choice_" + "b".repeat(32);
  const stream = { messages: [], buttons: [], markdown(value) { this.messages.push(value); }, button(value) { this.buttons.push(value); } };
  nextResult = { ok: true, requests: [{ run_id: runId, request_id: requestId, prompt: "Choose", options: [{ label: "First" }, { label: "Second" }] }] };
  await handler({ prompt: runId }, {}, stream, { isCancellationRequested: false });
  assert.strictEqual(stream.buttons.length, 2);
  assert.deepStrictEqual(Array.from(stream.buttons[1].arguments), [runId, requestId, 1]);
  assert.strictEqual(serviceCalls.at(-1).method, "choices");
  nextResult = { ok: true };
  await commands.get("personalKnowledge.answerActionChoice")(...stream.buttons[1].arguments);
  assert.deepStrictEqual(serviceCalls.at(-1), { method: "answer_choice", params: { run_id: runId, request_id: requestId, index: 1 } });
  assert.strictEqual(executions.at(-1)[0], "workbench.action.chat.open");
  await assert.rejects(commands.get("personalKnowledge.answerActionChoice")(runId, requestId, -1), /Invalid/);
  trusted = false;
  await assert.rejects(commands.get("personalKnowledge.answerActionChoice")(runId, requestId, 1), /trusted/);
  trusted = true;
  moduleExports.openActionWorkbench(context);
  assert.match(webview.html, /script-src 'nonce-[a-f0-9]+'/);
  assert.match(webview.html, /<script nonce="[a-f0-9]+">/);
  assert.match(webview.html, /codicon\.css/);
  moduleExports.openActionWorkbench(context, runId);
  assert(webview.html.includes(`currentRun:"${runId}"`), "Project source link preselects the exact Action Run in the real Workbench");
  profiling = true;
  nextResult = { ok: true, execution_ok: true, run_id: runId, state: "running", userState: "Running", launch_reused: false };
  await listener({ requestId: "durable-call", method: "call", params: { key: "same-key" } });
  assert.deepStrictEqual(baselineEvents.map(event => event.kind), ["start-request", "start-success"]);
  nextResult = { ...nextResult, launch_reused: true };
  await listener({ requestId: "durable-duplicate", method: "call", params: { key: "same-key" } });
  assert.strictEqual(baselineEvents.length, 2);
  nextResult = { ok: true, execution_ok: false, run_id: runId, state: "outcome_unknown", userState: "Reconciling" };
  for (const method of ["run", "run", "runs", "recover_runs"]) {
    await listener({ requestId: "durable-" + method, method, params: { run_id: runId } });
    assert.strictEqual(replies.at(-1).result.ok, true);
  }
  assert.deepStrictEqual(baselineEvents.map(event => event.kind), ["start-request", "start-success", "unknown-effect"]);
  assert.ok(baselineEvents.every(event => !JSON.stringify(event).includes(runId)));
  profiling = false;
  nextResult = { ok: true };
  for (const [method, params] of Object.entries(authoringRequests)) {
    await listener({ requestId: "native-" + method, method, params });
    assert.strictEqual(replies.at(-1).result.ok, true);
    assert.deepStrictEqual(serviceCalls.at(-1), { method, params });
  }
  for (const method of ["checkpoints", "respond_checkpoint", "schedule_run", "wake_run", "reconcile_run", "safety_scan", "associate_project"]) {
    const params = method === "safety_scan" ? {} : { run_id: runId };
    await listener({ requestId: "p3-" + method, method, params });
    assert.strictEqual(replies.at(-1).result.ok, true);
    assert.deepStrictEqual(serviceCalls.at(-1), { method, params });
  }
  const beforeOpenProject = serviceCalls.length;
  await listener({ requestId: "p2-open", method: "open_project", params: { run_id: runId } });
  assert.strictEqual(replies.at(-1).result.ok, true);
  assert.deepStrictEqual(executions.at(-1), ["personalKnowledge.openActionRunProject", runId]);
  assert.strictEqual(serviceCalls.length, beforeOpenProject, "Project route does not call the Python executor");
  await listener({ requestId: "p2-invalid", method: "open_project", params: { run_id: "../wrong" } });
  assert.match(replies.at(-1).result.error, /Invalid Action Run/);
  trusted = false;
  const beforeAuthoring = serviceCalls.length;
  await listener({ requestId: "native-untrusted-source", method: "source_save", params: authoringRequests.source_save });
  assert.match(replies.at(-1).result.error, /trusted/);
  assert.strictEqual(serviceCalls.length, beforeAuthoring);
  await listener({ requestId: "p2-untrusted", method: "open_project", params: { run_id: runId } });
  assert.match(replies.at(-1).result.error, /trusted/);
  trusted = true;
  await listener({ requestId: "1", method: "show_choices", params: { run_id: runId } });
  assert.match(executions.at(-1)[1].query, /^@pkm-actions action_run_/);
  await listener({ requestId: "2", method: "unknown", params: {} });
  assert.strictEqual(replies.at(-1).result.ok, false);
  domains = [];
  await listener({ requestId: "3", method: "catalog" });
  assert.match(replies.at(-1).result.error, /automation/);
  domains = ["automation"]; healthy = false;
  await listener({ requestId: "4", method: "catalog" });
  assert.match(replies.at(-1).result.error, /Runtime unavailable/);
  healthy = true;
  vscode.version = "1.90.0";
  const previousHandler = handler;
  moduleExports.initializeActionChat(context);
  assert.strictEqual(handler, previousHandler);
  const beforeFallback = executions.length;
  await listener({ requestId: "5", method: "show_choices", params: { run_id: runId } });
  assert.strictEqual(replies.at(-1).result.inline_chat, true);
  await commands.get("personalKnowledge.answerActionChoice")(runId, requestId, 1);
  assert.strictEqual(executions.length, beforeFallback);
  disposal();
  const { createActionWorkbenchServer } = require("../dist/runtime/action-workbench-server");
  const browserServer = await createActionWorkbenchServer({ extensionPath: root,
    async request(method, params) { if (method === "access") return { ok: true }; return { ok: true, method, params }; } });
  try {
    const url = new URL(browserServer.url), token = new URLSearchParams(url.hash.slice(1)).get("token");
    browserServer.setDraft({ action_id: "draft.test" });
    const page = await fetch(url.origin);
    assert.strictEqual(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.ok(!(await page.text()).includes(token));
    const font = await fetch(url.origin + "/codicon.ttf?cache=font-version");
    assert.strictEqual(font.status, 200);
    assert.strictEqual(font.headers.get("content-type"), "font/ttf");
    const headers = { Origin: url.origin, "Content-Type": "application/json", Authorization: "Bearer " + token };
    const body = JSON.stringify({ method: "session", params: {} });
    assert.strictEqual((await fetch(url.origin + "/api", { method: "POST", headers: { ...headers, Authorization: "" }, body })).status, 403);
    assert.strictEqual((await fetch(url.origin + "/api", { method: "POST", headers: { ...headers, Origin: "https://evil.example" }, body })).status, 403);
    const forgedHostStatus = await new Promise((resolve, reject) => {
      const request = require("http").request(url.origin + "/api", { method: "POST", headers: { ...headers, Host: "evil.example" } }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject); request.end(body);
    });
    assert.strictEqual(forgedHostStatus, 403);
    browserServer.allowOrigin("https://forwarded.example");
    const forwardedStatus = await new Promise((resolve, reject) => {
      const request = require("http").request(url.origin + "/api", { method: "POST",
        headers: { ...headers, Host: "forwarded.example", Origin: "https://forwarded.example" } }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject); request.end(body);
    });
    assert.strictEqual(forwardedStatus, 200);
    assert.deepStrictEqual((await (await fetch(url.origin + "/api", { method: "POST", headers, body })).json()).draft, { action_id: "draft.test" });
    assert.strictEqual((await fetch(url.origin + "/api", { method: "POST", headers, body: "x".repeat(1024 * 1024 + 1) })).status, 413);
    assert.strictEqual((await fetch(url.origin + "/missing")).status, 404);
    const malformedStatus = await new Promise((resolve, reject) => {
      const request = require("http").request(url.origin, { path: "http://[", method: "GET" }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject); request.end();
    });
    assert.strictEqual(malformedStatus, 400);
    assert.strictEqual((await fetch(url.origin)).status, 200);
  } finally { browserServer.dispose(); }
  try {
    await listener({ requestId: "6", method: "open_browser", params: { draft: { graph: { action_id: "handoff.test", nodes: [], edges: [] } } } });
    assert.strictEqual(replies.at(-1).result.ok, true);
    const url = new URL(executions.at(-1)[1]);
    const headers = { Origin: url.origin, "Content-Type": "application/json", Authorization: "Bearer " + new URLSearchParams(url.hash.slice(1)).get("token") };
    const call = async (method, params = {}) => (await fetch(url.origin + "/api", { method: "POST", headers, body: JSON.stringify({ method, params }) })).json();
    assert.strictEqual((await call("session")).draft.graph.action_id, "handoff.test");
    nextResult = { ok: true, actions: [], module_sets: [], queue: { jobs: [] } };
    assert.strictEqual((await call("catalog")).workspace_root, root);
    assert.strictEqual(serviceCalls.at(-1).method, "catalog");
    assert.strictEqual((await call("workspace", { root })).workspace_root, root);
    assert.match((await call("workspace", { root: "relative/path" })).error, /absolute directory/);
    await call("import", { local_path: "/host/selected.pkm-actions" });
    assert.strictEqual(serviceCalls.at(-1).params.local_path, "/host/selected.pkm-actions");
    await call("export", { destination: "/host/export.pkm-actions" });
    assert.strictEqual(serviceCalls.at(-1).params.destination, "/host/export.pkm-actions");
    for (const [method, params] of Object.entries(authoringRequests)) {
      assert.strictEqual((await call(method, params)).ok, true);
      assert.deepStrictEqual(serviceCalls.at(-1), { method, params });
    }
    assert.match((await call("unknown")).error, /Unsupported/);
    trusted = false;
    assert.match((await call("catalog")).error, /trusted/);
    trusted = true; domains = [];
    assert.match((await call("catalog")).error, /automation/);
    domains = ["automation"]; healthy = false;
    assert.match((await call("session")).error, /Runtime unavailable/);
    healthy = true; storePath = "/changed/store";
    assert.match((await call("catalog")).error, /Knowledge Root changed/);
    storePath = "/isolated/test/store";
  } finally { context.subscriptions.forEach(item => item.dispose()); }
  console.log("native Action chat buttons, managed runtime, access gates, CSP and message dispatch passed");
})().catch(error => { console.error(error); process.exitCode = 1; });