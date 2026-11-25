import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, rm, symlink, readdir } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { stageCompatibilityMcp } from "../scripts/stage-compatibility-mcp.mjs";

const original = resolve(process.env.PKM_COMPATIBILITY_EXTENSION || "../personal-knowledge-vscode");
const require = createRequire(join(original, "package.json"));
const python = process.env.PKM_TEST_PYTHON || require("./tests/dev-paths.js").testPython;
const { WebSocketServer } = require("ws");
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const body = async request => {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
    if (chunks.reduce((sum, item) => sum + item.length, 0) > 4_000_000) throw Error("Oversized fixture request");
  }
  return JSON.parse(Buffer.concat(chunks).toString());
};

test("real Chromium PKM Chat creates, approves, updates and validates original Notes through the selected v5 gateway", { timeout: 180_000 }, async t => {
  const base = resolve(`.pkm-chat-gateway-${randomUUID()}`);
  const root = join(base, "library"), managed = join(root, "mcp-server"), home = join(base, "home"), runtime = join(base, "python");
  await mkdir(base, { mode: 0o700 });
  await writeFile(join(base, "package.json"), '{"type":"commonjs"}\n');
  let connection, provider, harness;
  const servers = [], sockets = [];
  t.after(async () => {
    await provider?.drainManagedWriter();
    provider?.dispose();
    await connection?.close();
    harness?.dispose();
    for (const socket of sockets) socket.terminate();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(base, { recursive: true, force: true });
  });
  for (const directory of [join(root, "notes"), join(root, "skills"), join(root, "papers"), home, join(runtime, "bin")])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  await symlink(python, join(runtime, "bin/python"));
  await symlink(join(original, "node_modules"), join(base, "node_modules"));
  const generator = join(base, "generate.cjs");
  await writeFile(generator, `
const Module=require("module");
const config={mcpServerPath:${JSON.stringify(managed)},mcpRuntimePath:${JSON.stringify(runtime)},mcpEnabledFeatureDomains:["knowledge","automation","skillRouter"]};
const api={workspace:{isTrusted:true,workspaceFolders:[],getConfiguration:()=>({get:(k,d)=>k in config?config[k]:d})},
env:{appRoot:${JSON.stringify(home)},machineId:"fixture",sessionId:"fixture"},Uri:{file:p=>({fsPath:p,toString:()=>p})}};
const load=Module._load;Module._load=function(id,...a){return id==="vscode"?api:load.call(this,id,...a)};
require(${JSON.stringify(join(original, "dist/knowledge/filestore.js"))}).setStorePath(${JSON.stringify(root)});
require(${JSON.stringify(join(original, "dist/mcp/mcp.js"))}).generateMcpServer({
extensionPath:${JSON.stringify(original)},globalStorageUri:{fsPath:${JSON.stringify(home)}}}).catch(e=>{console.error(e);process.exitCode=1;});
`);
  execFileSync(process.execPath, [generator], { cwd: base, env: { ...process.env, HOME: home }, timeout: 60_000, stdio: "pipe" });
  const stage = await stageCompatibilityMcp({ extension: original, knowledgeRoot: root, managedRoot: managed, python, destination: join(base, "gateway") });
  const target = JSON.parse(await readFile(stage.targetPath));
  const selected = {
    launch: { command: target.command.path, args: [target.entry.path, ...target.args], cwd: target.cwd,
      env: { ...process.env, HOME: home, PYTHONDONTWRITEBYTECODE: "1" } },
    gateway: { managedRoot: target.cwd, runtimeBuild: target.runtimeBuild, version: target.expectedVersion,
      assertCurrent() { assert.equal(selectionCurrent, true, "Reviewed fixture target was revoked"); } },
  };
  let selectionCurrent = true;
  const compiled = join(base, "chat.cjs");
  await build({ stdin: { contents: `
export {ApiChatView} from ${JSON.stringify(join(original, "src/chat/api-chat-view.ts"))};
export {connectManagedChatMcp,createVscodeTools} from ${JSON.stringify(join(original, "src/chat/api-chat-mcp.ts"))};
export {setStorePath} from ${JSON.stringify(join(original, "src/knowledge/filestore.ts"))};
export {createNativeHarnessServer} from ${JSON.stringify(join(original, "src/runtime/native-harness-server.ts"))};
export {apiChatSessionHarnessSnapshot,verifyHarnessArtifacts} from ${JSON.stringify(join(original, "src/chat/api-chat-store.ts"))};
`, resolveDir: original, loader: "ts" }, outfile: compiled, bundle: true, packages: "external",
    platform: "node", format: "cjs", logLevel: "silent" });
  const requests = [], hostErrors = [], approvals = [];
  const inference = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, "Bearer isolated-gateway-provider");
      const input = await body(request);
      requests.push(input);
      const results = input.messages.filter(message => message.role === "tool");
      const tools = input.tools.map(tool => tool.function.name);
      let step;
      const last = input.messages.filter(message => message.role === "user").at(-1)?.content;
      if (typeof last === "string" && last.includes("CANCEL_GATEWAY")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": held until the real browser Stop aborts HTTP\n\n");
        send({ type: "fixtureProviderWaiting" });
        return;
      }
      const sequence = [
        ["find_vscode_tools", { query: "mcp_pkm_add_note" }],
        ["invoke_vscode_tool", { name: "mcp_pkm_add_note", input: { title: "GatewayBrowserNote", content: "Created by the real original executor." } }],
        ["find_vscode_tools", { query: "mcp_pkm_update_note" }],
        ["invoke_vscode_tool", { name: "mcp_pkm_update_note", input: { slug: "GatewayBrowserNote", content: "Updated by browser Chat via the v5 gateway." } }],
        ["record_harness", { kind: "validation", stepId: "gateway-readback", status: "start", summary: "Read original Note after the two gateway mutations" }],
        ["find_vscode_tools", { query: "mcp_pkm_get_note" }],
        ["invoke_vscode_tool", { name: "mcp_pkm_get_note", input: { slug: "GatewayBrowserNote" } }],
        ["record_harness", { kind: "validation", stepId: "gateway-readback", status: "complete",
          summary: "Original Note readback contains the browser-requested content", evidenceCallIds: ["gateway-call-6"] }],
      ];
      const count = results.length;
      if (count < sequence.length) {
        step = sequence[count];
        assert(tools.includes(step[0]), `Actual Chat must expose ${step[0]}`);
        if (count === 7) assert.match(results.at(-1).content, /Updated by browser Chat via the v5 gateway/);
      } else {
        assert.match(results.at(-1).content, /"ok":true/);
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: step ? { tool_calls: [{ index: 0,
        id: `gateway-call-${count}`, type: "function", function: { name: step[0], arguments: JSON.stringify(step[1]) } }] }
        : { content: "GATEWAY_BROWSER_ACCEPTED: original Note created, updated and read back; validation cites the terminal gateway read receipt." },
        finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: step ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      hostErrors.push(String(error));
      response.writeHead(500); response.end(String(error));
    }
  });
  await listen(inference); servers.push(inference);
  const configuration = { apiChatCapabilityProfile: "legacy", apiChatProvider: "openai-compatible",
    aiEndpoint: `http://127.0.0.1:${inference.address().port}/v1`, aiModel: "gateway-fixture",
    apiChatModels: [], apiChatModelProfiles: [{ id: "gateway-fixture", status: "active", contextWindow: 128000, maxOutputTokens: 4096 }],
    mcpServerPath: managed, mcpRuntimePath: runtime, apiChatActivityCreditLimit: -1 };
  const uri = file => ({ scheme: "file", fsPath: file, path: file, toString: () => `file://${file}` });
  const state = new Map(), subscriptions = [];
  const host = { env: { appRoot: home, machineId: "gateway-fixture", sessionId: "gateway-fixture",
      clipboard: { writeText: async () => {} } },
    Uri: { file: uri, joinPath: (base, ...parts) => uri(join(base.fsPath, ...parts)), parse: value => uri(value) },
    LanguageModelTextPart: class {}, CancellationTokenSource: class { token = {}; cancel() {} dispose() {} },
    lm: { tools: [], invokeTool: async () => { throw Error("Native tool fallback is forbidden in this fixture"); } },
    commands: { executeCommand: async (command, method, params) => {
      if (command === "personalKnowledge.readNativeHarness") {
        const directory = join(root, ".pkm/state");
        const record = JSON.parse(await readFile(join(directory, "agent-sessions", `${params.sessionId}.json`)));
        const snapshot = api.apiChatSessionHarnessSnapshot(record, params.sessionId, directory, method === "result");
        if (method === "result") return snapshot.attempts.find(attempt => attempt.messageId === params.messageId)
          ?.toolCalls.find(call => call.id === params.callId)?.resultPreview;
        assert.equal(method, "snapshot");
        return { origin: "pkm-native", sessionId: params.sessionId, task: record.title,
          status: record.status, updatedAt: record.updatedAt,
          harness: await api.verifyHarnessArtifacts(snapshot, [], undefined, directory), todos: [], runs: [], actionRuns: [] };
      }
      if (command === "personalKnowledge.openVisualizationWindow") {
        harness ??= await api.createNativeHarnessServer({ extensionPath: original, sessionId: provider.chat.id,
          access() { assert(!provider.disposed); },
          request: (method, params) => provider.visualizationRequest(provider.chat, method, params) });
        send({ type: "fixtureHarness", url: harness.url });
      }
    } },
    window: { showInformationMessage: async () => {}, showWarningMessage: async () => undefined,
      showErrorMessage: async error => { hostErrors.push(String(error)); },
      showInputBox: async options => {
        assert.equal(options.title, "Start Task", "No credential dialog is authorized");
        return "Gateway validation Task";
      } },
    workspace: { isTrusted: true, workspaceFolders: [], textDocuments: [], fs: { stat: async value => {
      const { stat } = await import("node:fs/promises"); return stat(value.fsPath);
    } }, getConfiguration: () => ({ get: (key, fallback) => configuration[key] ?? fallback,
      update: async (key, value) => { configuration[key] = value; } }) } };
  const Module = require("node:module"), load = Module._load;
  let api;
  try {
    Module._load = function (id, ...args) { return id === "vscode" ? host : load.call(this, id, ...args); };
    api = require(compiled);
  } finally { Module._load = load; }
  api.setStorePath(root);
  const context = { extensionPath: original, globalStorageUri: uri(home), subscriptions,
    secrets: { get: async () => "isolated-gateway-provider" },
    globalState: { get: (key, fallback) => state.get(key) ?? fallback, update: async (key, value) => { state.set(key, value); } },
    workspaceState: { get: (key, fallback) => state.get(key) ?? fallback, update: async (key, value) => { state.set(key, value); } } };
  provider = new api.ApiChatView(context, undefined, async () => {}, () => selected);
  const posts = [];
  let socket;
  function send(message) {
    posts.push(message);
    if (socket?.readyState === 1) socket.send(JSON.stringify(message));
  }
  provider.view = { visible: true, webview: { postMessage: value => {
    if (value.approvals) approvals.push(...value.approvals);
    send(value); harness?.changed(); return Promise.resolve(true);
  } } };
  const assets = join(original, "dist/webview");
  const bridge = `
const socket=new WebSocket(location.origin.replace("http","ws"));
const pending=[];let saved={};
globalThis.acquireVsCodeApi=()=>({getState:()=>saved,setState:value=>{saved=value},
postMessage:value=>socket.readyState===1?socket.send(JSON.stringify(value)):pending.push(value)});
socket.onopen=()=>{for(const value of pending.splice(0))socket.send(JSON.stringify(value))};
socket.onmessage=event=>{const message=JSON.parse(event.data);
if(message.type==="fixtureProviderWaiting"){document.body.dataset.gatewayProviderWaiting="true";return}
if(message.type==="fixtureHarness"){const link=document.getElementById("gateway-harness");link.href=message.url;link.hidden=false;return}
window.dispatchEvent(new MessageEvent("message",{data:message}))};`;
  const ui = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, "http://localhost").pathname;
      if (path === "/bridge.js") { response.setHeader("content-type", "text/javascript"); response.end(bridge); return; }
      if (path === "/") {
        const values = { nonce: "gateway-browser", cspSource: "'self'", styles: "/api-chat.css", script: "/api-chat.js",
          icons: "/codicon.css", marked: "/marked.umd.js", purify: "/purify.min.js", katex: "/katex.js",
          katexStyles: "/katex.css", mermaid: "/mermaid.js", libraryScript: "/api-chat-library.js",
          retrievalScript: "/chat-retrieval-flow.js", hostHealthScript: "/host-health.js", hostHealthStyles: "/host-health.css",
          harnessScript: "/agent-harness.js", harnessStyles: "/agent-harness.css", visualizationScript: "/chat-visualization.js" };
        let html = (await readFile(join(assets, "api-chat.html"), "utf8"))
          .replace(/\{\{(\w+)\}\}/g, (_, key) => values[key])
          .replace("default-src 'none';", "default-src 'none'; connect-src 'self' ws://127.0.0.1:*;")
          .replace('<script id="pkm-host-health-script"', '<script nonce="gateway-browser" src="/bridge.js"></script><script id="pkm-host-health-script"')
          .replace("</body>", '<a id="gateway-harness" target="_blank" hidden>Open actual execution Harness</a></body>');
        response.setHeader("content-type", "text/html"); response.end(html); return;
      }
      if (path === "/favicon.ico") { response.writeHead(204); response.end(); return; }
      if (!/^\/(?:[\w.-]+|fonts\/[\w.-]+)$/.test(path)) { response.writeHead(404); response.end(); return; }
      response.setHeader("content-type", ({ ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".ttf": "font/ttf" })[extname(path)] || "application/octet-stream");
      response.end(await readFile(join(assets, path.slice(1))));
    } catch (error) { response.writeHead(404); response.end(String(error)); }
  });
  const ws = new WebSocketServer({ server: ui });
  ws.on("connection", client => {
    socket = client; sockets.push(client);
    client.on("message", data => {
      const message = JSON.parse(String(data));
      void provider.handle(message).catch(error => {
        hostErrors.push(String(error)); send({ type: "error", message: String(error) });
      });
    });
  });
  await listen(ui); servers.push(ui);
  const browser = spawn("python3", ["-B", resolve("tests/compatibility-chat-browser.py"),
    `http://127.0.0.1:${ui.address().port}`, base], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  browser.stdout.on("data", bytes => { output += bytes; });
  browser.stderr.on("data", bytes => { output += bytes; });
  const code = await new Promise(resolve => browser.once("close", resolve));
  const latest = posts.filter(post => post.type === "state").at(-1)?.chat?.messages?.at(-1);
  assert.equal(code, 0, output + "\nHost errors: " + JSON.stringify(hostErrors)
    + "\nLatest reply: " + JSON.stringify(latest && { status: latest.status, error: latest.error, content: latest.content,
      tools: latest.toolCalls?.map(call => ({ name: call.name, status: call.status, result: call.result?.slice(0, 250) })) }));
  assert.match(output, /REAL_BROWSER_GATEWAY_ACCEPTED/);
  assert.deepEqual(hostErrors, []);
  assert(approvals.some(approval => approval.title === "Run PKM add_note?"), "Browser approved original create identity");
  assert(approvals.some(approval => approval.title === "Run PKM update_note?"), "Browser approved original update identity");
  const chat = provider.store.load(provider.chat.id, false);
  const accepted = chat.messages.find(message => message.content.includes("GATEWAY_BROWSER_ACCEPTED"));
  assert(accepted);
  assert.equal(accepted.harnessReports.at(-1).status, "complete");
  assert.deepEqual(accepted.harnessReports.at(-1).evidenceCallIds, ["gateway-call-6"]);
  assert.equal(accepted.toolCalls.filter(call => call.name === "invoke_vscode_tool").length, 3);
  assert.equal(chat.messages.at(-1).status, "cancelled");
  assert.equal(requests.filter(request => request.messages.some(message => typeof message.content === "string" && message.content.includes("CANCEL_GATEWAY"))).length, 1);
  const note = await readFile(join(root, "notes/GatewayBrowserNote.md"), "utf8");
  assert.match(note, /Updated by browser Chat via the v5 gateway/);
  assert(!(await readdir(root)).includes("core.sqlite"));
  await provider.drainManagedWriter();
  connection = await api.connectManagedChatMcp(selected.launch, new AbortController().signal, managed,
    { knowledgeRoot: root, gateway: selected.gateway });
  const localTools = api.createVscodeTools(["mcp_pkm_get_note"], host, async () => {}, undefined, connection);
  const signal = new AbortController().signal;
  await assert.rejects(localTools[1].execute({ name: "mcp_pkm_update_note", input: {} }, signal), /Find an enabled tool/);
  await assert.rejects(connection.invoke("mcp_pkm_unknown_tool", {}, signal), /not in the configured original/);
  await localTools[0].execute({ query: "mcp_pkm_get_note" }, signal);
  await localTools[1].execute({ name: "mcp_pkm_get_note", input: { slug: "GatewayBrowserNote" } }, signal);
  await assert.rejects(localTools[1].execute({ name: "mcp_pkm_get_note", input: { slug: "GatewayBrowserNote" } }, signal), /Duplicate.*blocked/);
  selectionCurrent = false;
  await assert.rejects(connection.invoke("mcp_pkm_get_note", {}, signal), /revoked/);
  selectionCurrent = true;
  await connection.close(); connection = undefined;
  connection = await api.connectManagedChatMcp({ command: python, args: [join(managed, "server.py")],
    cwd: root, env: { ...process.env, HOME: home, PYTHONDONTWRITEBYTECODE: "1" } },
  new AbortController().signal, managed, { knowledgeRoot: root });
  assert.match(await connection.invoke("mcp_pkm_get_note", { slug: "GatewayBrowserNote" }, signal),
    /Updated by browser Chat via the v5 gateway/);
  await connection.close(); connection = undefined;
  console.log(output.trim());
});
