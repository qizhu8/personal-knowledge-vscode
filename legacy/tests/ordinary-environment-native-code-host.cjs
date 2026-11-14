"use strict";
const vscode = require("vscode"), fs = require("node:fs"), path = require("node:path"), net = require("node:net");
const { createHmac, timingSafeEqual, randomUUID } = require("node:crypto");
exports.activate = async context => {
  const base = process.env.PKM_NATIVE_ENV_FIXTURE;
  if (!base || !base.startsWith(path.resolve(process.env.PKM_NATIVE_ENV_PROJECT || "", ".migration-test-work") + path.sep))
    throw Error("Private fixture only.");
  const f = JSON.parse(fs.readFileSync(path.join(base, "contract.json")));
  const key = process.env.PKM_NATIVE_ENV_CHANNEL_KEY;
  const sign = data => createHmac("sha256", key).update(JSON.stringify(data)).digest("hex");
  const verify = frame => {
    const expected = Buffer.from(sign(frame.data)), actual = Buffer.from(String(frame.mac));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw Error("Fixture parent frame authentication failed.");
    return frame.data;
  };
  const authorityModule = require(path.join(f.build, "runtime/ordinary-environment-vscode-authority.js"));
  const store = require(path.join(f.build, "knowledge/filestore.js"));
  const actualRoot = vscode.workspace.getConfiguration("personalKnowledge").get("storePath");
  if (actualRoot !== f.knowledgeRoot || context.globalStorageUri.fsPath !== f.storage) throw Error("Real VSCode Root/profile differs.");
  store.setStorePath(actualRoot);
  const controller = new AbortController(), pending = new Map();
  const socket = net.connect(JSON.parse(process.env.PKM_NATIVE_ENV_ENDPOINT));
  let buffer = "";
  const send = data => socket.write(JSON.stringify({ data, mac: sign(data) }) + "\n");
  const request = (command, payload) => new Promise((resolve, reject) => {
    const id = randomUUID(); pending.set(id, { resolve, reject }); send({ id, command, payload });
  });
  socket.on("data", bytes => {
    buffer += bytes;
    for (;;) {
      const end = buffer.indexOf("\n"); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const frame = verify(JSON.parse(line));
        if (frame.command === "revoke") { controller.abort(); continue; }
        const item = pending.get(frame.id);
        if (item) { pending.delete(frame.id); frame.error ? item.reject(Error(frame.error)) : item.resolve(frame.result); }
      } catch (error) { socket.destroy(error); }
    }
  });
  const disconnect = () => {
    controller.abort();
    for (const item of pending.values()) item.reject(Error("Fixture parent connection closed."));
    pending.clear();
  };
  socket.on("close", disconnect); socket.on("error", disconnect);
  try {
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const ready = await request("hello", {});
    const host = { knowledgeRoot: actualRoot, workspaceId: ready.workspaceId, sessionId: ready.sessionId,
      signal: controller.signal, assertCurrent(binding) {
        if (!vscode.workspace.isTrusted || controller.signal.aborted || socket.destroyed
          || store.getStorePath() !== actualRoot || context.globalStorageUri.fsPath !== f.storage
          || binding.workspaceId !== ready.workspaceId || binding.sessionId !== ready.sessionId)
          throw Error("Native Code embedding was revoked.");
        const state = verify(JSON.parse(fs.readFileSync(path.join(base, "owner-state.json"))));
        if (!state.current || state.sessionId !== ready.sessionId || state.workspaceId !== ready.workspaceId
          || state.knowledgeRoot !== actualRoot || state.profile !== f.storage || state.expiresAtMs <= Date.now())
          throw Error("Prestarted owner no longer grants this fixture connection.");
      } };
    const readStarted = Date.now();
    const read = await authorityModule.requestOrdinaryEnvironmentReadAuthority(context, host);
    if (!read) throw Error("Native read consent declined.");
    const binding = { workspaceId: read.workspaceId, actorId: read.actorId, knowledgeRoot: read.knowledgeRoot,
      globalStorageDirectory: read.globalStorageDirectory, scope: read.scope };
    read.assertCurrent(binding);
    await request("read-approved", { binding, expiresAtMs: readStarted + 300_000 });
    read.signal.addEventListener("abort", () => { if (!socket.destroyed) send({ id: randomUUID(), command: "revoke-read", payload: {} }); });
    const panel = vscode.window.createWebviewPanel("nativeEnv", "PKM Environments Owner", vscode.ViewColumn.One, { enableScripts: true });
    panel.webview.onDidReceiveMessage(async message => {
      try {
        read.assertCurrent(binding);
        let response = await request("message", message);
        if (response.needsApproval) {
          const approval = await authorityModule.requestOrdinaryEnvironmentRefreshIntent(context, { host, intent: response.intent });
          if (!approval) throw Error("Native Refresh consent declined; no effect was authorized.");
          try {
            approval.claim(approval.intent);
            approval.signal.addEventListener("abort", () => {
              if (!socket.destroyed) send({ id: randomUUID(), command: "revoke-request", payload: { requestId: approval.intent.requestId } });
            });
            panel.webview.html = fs.readFileSync(path.join(base, "ordinary.html"), "utf8");
            response = await request("apply-approved", { message, intent: approval.intent, expiresAtMs: approval.expiresAtMs });
          } finally { approval.dispose(); }
        }
        await panel.webview.postMessage(response);
      } catch (error) {
        await panel.webview.postMessage(message.command === "envPackages"
          ? { command: "envPackages", id: message.id, packages: [], capturedAt: "", cached: false, error: String(error) }
          : { command: "envList", data: [], refreshErrors: [String(error)] });
      }
    });
    fs.writeFileSync(path.join(base, `native-host-${f.phase}.json`), JSON.stringify({
      actualGlobalStorage: context.globalStorageUri.fsPath, actualRoot, workspaceId: ready.workspaceId,
      sessionId: ready.sessionId, nativeReadConsent: true, prestartedOwner: true,
      qualification: "PRIVATE_FIXTURE_CONTROL_CHANNEL_REAL_NATIVE_UI_NOT_EXCLUSIVE_CROSS_PROCESS_AUTHORITY",
    }, null, 2));
    const timer = setInterval(() => {
      if (fs.existsSync(path.join(base, `close-${f.phase}`))) {
        clearInterval(timer); socket.end(); void vscode.commands.executeCommand("workbench.action.closeWindow");
      }
    }, 100);
    context.subscriptions.push({ dispose() { clearInterval(timer); controller.abort(); socket.destroy(); } });
  } catch (error) {
    fs.writeFileSync(path.join(base, `native-error-${f.phase}.txt`), String(error.stack || error));
    socket.destroy();
  }
};
