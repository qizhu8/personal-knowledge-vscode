"use strict";

const assert = require("node:assert/strict");
const vscode = require("vscode");

function replace(target, key, value) {
  const original = target[key];
  target[key] = value;
  assert.equal(target[key], value, `Unable to instrument ${key}`);
  return () => { target[key] = original; };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for live backend panel response");
}

exports.run = async () => {
  const fixture = JSON.parse(process.env.PKM_LIVE_ACCEPTANCE);
  delete process.env.PKM_LIVE_ACCEPTANCE;
  assert.match(fixture.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const extension = vscode.extensions.getExtension("pkm-nonproduction.pkm-next-nonproduction-host");
  assert.ok(extension, "Nonproduction extension not loaded");
  const requests = [], panels = [], errors = [], restore = [];
  const originalFetch = globalThis.fetch;
  restore.push(replace(globalThis, "fetch", async (input, options) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    assert.equal(url.origin, fixture.origin, "Extension attempted a non-fixture destination");
    assert.equal(options?.redirect, "error", "Redirects must not escape the fixture");
    const authorization = new Headers(options?.headers).get("authorization");
    const entry = {
      path: url.pathname,
      authenticated: authorization === `Bearer ${fixture.token}`,
    };
    requests.push(entry);
    const response = await originalFetch(input, options);
    entry.status = response.status;
    return response;
  }));
  let promptedToken = fixture.token;
  restore.push(replace(vscode.window, "showInputBox", async options => {
    assert.equal(options.password, true);
    return promptedToken;
  }));
  restore.push(replace(vscode.window, "showErrorMessage", async message => { errors.push(message); }));
  const createPanel = vscode.window.createWebviewPanel;
  restore.push(replace(vscode.window, "createWebviewPanel", (...args) => {
    const panel = createPanel(...args);
    const record = { panel, replies: [], disposed: false, listenerDisposed: false };
    // Observe the real Electron panel while driving the host message boundary;
    // this test does not claim DOM/button-click coverage.
    const receive = panel.webview.onDidReceiveMessage.bind(panel.webview);
    const post = panel.webview.postMessage.bind(panel.webview);
    restore.push(replace(panel.webview, "onDidReceiveMessage", listener => {
      record.deliver = listener;
      const subscription = receive(listener);
      return { dispose() { record.listenerDisposed = true; subscription.dispose(); } };
    }));
    restore.push(replace(panel.webview, "postMessage", async message => {
      record.replies.push(message);
      return post(message);
    }));
    panel.onDidDispose(() => { record.disposed = true; });
    panels.push(record);
    return panel;
  }));
  const config = vscode.workspace.getConfiguration("pkm.nextHost");
  const keys = ["origin", "workspaceId", "actorId"];
  const previous = Object.fromEntries(keys.map(key => [key, config.inspect(key)?.globalValue]));
  const configure = async values => {
    for (const [key, value] of Object.entries(values))
      await config.update(key, value, vscode.ConfigurationTarget.Global);
  };
  const command = id => vscode.commands.executeCommand(id);
  const send = async (record, requestId, action) => {
    record.deliver({ requestId, action, input: {} });
    await waitFor(() => record.replies.some(reply => reply.requestId === requestId));
    return record.replies.find(reply => reply.requestId === requestId);
  };
  try {
    await extension.activate();
    assert.equal(extension.isActive, true);
    const commands = new Set(await vscode.commands.getCommands(true));
    for (const id of ["pkm.next.connect", "pkm.next.disconnect", "pkm.nextHost.open", "pkm.nextHost.setToken"])
      assert.ok(commands.has(id), `Command missing: ${id}`);
    assert.equal(commands.has("pkm.next.openHumanReview"), false);
    await configure({ origin: fixture.origin, workspaceId: fixture.workspaceId, actorId: fixture.actorId });
    await command("pkm.nextHost.setToken");
    // No password prompt is available during connect: auth must be loaded from
    // the actual ExtensionContext SecretStorage, not a test credential adapter.
    promptedToken = undefined;
    await command("pkm.next.connect");
    assert.equal(errors.length, 0);
    assert.ok(requests.some(request => request.path === "/v1/server_info"));
    assert.ok(requests.some(request => request.path === "/v1/capabilities_describe"));
    assert.ok(requests.every(request => request.authenticated));
    await command("pkm.nextHost.open");
    assert.equal(panels.length, 1);
    const first = panels[0];
    first.html = first.panel.webview.html;
    assert.match(first.html, /default-src 'none'/);
    const state = await send(first, "state", "state");
    assert.equal(state.result.status, "connected");
    assert.equal(state.result.workspaceId, fixture.workspaceId);
    assert.ok(state.result.capabilities.includes("knowledgeList"));
    const page = await send(first, "read", "knowledgeList");
    assert.equal(page.error, undefined);
    assert.deepEqual(page.result.items, []);
    assert.equal(page.result.total, 0);
    assert.ok(requests.some(request => request.path === "/v1/capability_read" && request.status === 200));
    first.panel.dispose();
    assert.equal(first.disposed, true);
    assert.equal(first.listenerDisposed, true);
    const replyCount = first.replies.length, requestCount = requests.length;
    first.deliver({ requestId: "disposed", action: "knowledgeList", input: {} });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(first.replies.length, replyCount);
    assert.equal(requests.length, requestCount);

    await command("pkm.nextHost.open");
    assert.equal(panels.length, 2);
    panels[1].html = panels[1].panel.webview.html;
    await command("pkm.next.disconnect");
    assert.equal(panels[1].disposed, true);
    assert.equal(panels[1].listenerDisposed, true);

    await configure({ actorId: "synthetic:wrong-actor" });
    const beforeMismatch = requests.length;
    await command("pkm.next.connect");
    assert.equal(errors.length, 1);
    assert.deepEqual(requests.slice(beforeMismatch).map(request => request.path), ["/v1/server_info"]);
    await command("pkm.nextHost.open");
    assert.equal(panels.length, 2, "Identity mismatch opened a panel");
    assert.equal(errors.length, 2);

    await configure({ actorId: fixture.actorId });
    promptedToken = "synthetic-invalid-token-".padEnd(64, "x");
    await command("pkm.nextHost.setToken");
    promptedToken = undefined;
    const beforeDenial = requests.length;
    await command("pkm.next.connect");
    assert.equal(errors.length, 3);
    assert.equal(requests.length, beforeDenial + 1);
    assert.equal(requests.at(-1).status, 401, "Actual backend did not deny invalid SecretStorage credential");
    await command("pkm.nextHost.open");
    assert.equal(panels.length, 2);
    promptedToken = fixture.token;
    await command("pkm.nextHost.setToken");
    promptedToken = undefined;
    const beforeRecovery = errors.length;
    await command("pkm.next.connect");
    assert.equal(errors.length, beforeRecovery, "Valid SecretStorage replacement did not recover");
    await command("pkm.nextHost.open");
    assert.equal(panels.length, 3);
    panels[2].html = panels[2].panel.webview.html;
    await command("pkm.next.disconnect");
    assert.equal(panels[2].disposed, true);
    const surfaces = JSON.stringify({
      settings: keys.map(key => config.inspect(key)),
      html: panels.map(record => record.html),
      replies: panels.flatMap(record => record.replies), errors, requests,
    });
    assert.equal(surfaces.includes(fixture.token), false, "Secret leaked to user-visible surfaces");
    console.log("Live next-server Electron acceptance passed: real CLI, server_info, discovered capability/read, identity mismatch, HTTP denial, real SecretStorage replacement, 3 disposed Electron panels.");
  } finally {
    await command("pkm.next.disconnect");
    await configure(previous);
    for (const undo of restore.reverse()) undo();
  }
};
