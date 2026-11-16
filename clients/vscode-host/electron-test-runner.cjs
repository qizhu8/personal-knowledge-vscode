"use strict";

const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const vscode = require("vscode");

const extensionId = "pkm-nonproduction.pkm-v5";
const bearer = "electron-acceptance-token-".padEnd(40, "x");

function replaceMethod(target, name, replacement) {
  const original = target[name];
  target[name] = replacement;
  assert.equal(target[name], replacement, `Unable to instrument VS Code API ${name}`);
  return () => { target[name] = original; };
}

async function createFixture() {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({
      path: request.url,
      authorization: request.headers.authorization,
      remoteAddress: request.socket.remoteAddress,
      body: body ? JSON.parse(body) : undefined,
    });

    let result, error;
    if (request.url === "/v1/server_info") {
      result = {
        name: "pkm-v5",
        serverId: "pkm-v5",
        workspaceId: "electron-workspace",
        actorId: "electron-actor",
        workspaceVersion: "pkm.next-workspace/v2",
        protocolVersion: "v1",
        catalogRevision: "electron-revision",
        storage: { workspaceSchema: "pkm.next-workspace/v2", authority: "Markdown" },
      };
    } else if (request.url === "/v1/capabilities_describe" && requests.at(-1).body?.operation === "knowledge.document.list") {
      result = {
        operation: "knowledge.document.list",
        version: 1,
        readOnly: true,
        catalogRevision: "electron-revision",
      };
    } else {
      error = { code: "NOT_FOUND", effect: "not-committed" };
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      schema: "pkm.next-result/v1",
      requestId: "electron-acceptance",
      ...(result ? { result } : { error }),
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function setConfiguration(config, values) {
  for (const [key, value] of Object.entries(values))
    await config.update(key, value, vscode.ConfigurationTarget.Global);
}

exports.run = async function run() {
  const extension = vscode.extensions.getExtension(extensionId);
  assert.ok(extension, `Extension Development Host did not load ${extensionId}`);
  await extension.activate();
  assert.equal(extension.isActive, true);

  const commands = new Set(await vscode.commands.getCommands(true));
  for (const id of [
    "pkm.next.connect",
    "pkm.next.disconnect",
    "pkm.nextHost.open",
    "pkm.nextHost.setToken",
  ]) assert.ok(commands.has(id), `Missing registered command ${id}`);
  assert.equal(commands.has("pkm.next.openHumanReview"), false);

  const fixture = await createFixture();
  const config = vscode.workspace.getConfiguration("pkm.nextHost");
  const previous = Object.fromEntries(["origin", "workspaceId", "actorId"].map(key => [
    key,
    config.inspect(key)?.globalValue,
  ]));
  const restoreInput = replaceMethod(vscode.window, "showInputBox", async options => {
    assert.equal(options.password, true, "token prompt must use password mode");
    return bearer;
  });
  const openedPanels = [];
  const originalCreatePanel = vscode.window.createWebviewPanel;
  const restoreCreatePanel = replaceMethod(vscode.window, "createWebviewPanel", (...args) => {
    const panel = originalCreatePanel(...args);
    openedPanels.push(panel);
    return panel;
  });

  try {
    await setConfiguration(config, {
      origin: fixture.origin,
      workspaceId: "electron-workspace",
      actorId: "electron-actor",
    });

    await vscode.commands.executeCommand("pkm.nextHost.setToken");
    const storedConfig = ["origin", "workspaceId", "actorId"]
      .map(key => config.inspect(key))
      .filter(Boolean);
    assert.equal(JSON.stringify(storedConfig).includes(bearer), false, "token leaked to settings");

    await vscode.commands.executeCommand("pkm.next.connect");
    assert.ok(fixture.requests.some(request => request.path === "/v1/server_info"));
    assert.ok(fixture.requests.every(request => request.authorization === `Bearer ${bearer}`));
    assert.ok(fixture.requests.every(request =>
      request.remoteAddress === "127.0.0.1" || request.remoteAddress === "::ffff:127.0.0.1"));

    await vscode.commands.executeCommand("pkm.nextHost.open");
    assert.equal(openedPanels.length, 1, "Open did not create an Electron webview panel");
    const first = openedPanels[0];
    assert.equal(first.viewType, "pkmNextHost");
    assert.equal(first.title, "pkm-v5 (Experimental)");
    assert.match(first.webview.html, /default-src 'none'/);
    assert.match(first.webview.html, /textContent/);
    assert.equal(first.webview.html.includes(bearer), false);
    const firstHtml = first.webview.html;

    let firstDisposed = false;
    first.onDidDispose(() => { firstDisposed = true; });
    first.dispose();
    assert.equal(firstDisposed, true, "panel disposal event did not reach extension host");

    await vscode.commands.executeCommand("pkm.next.connect");
    await vscode.commands.executeCommand("pkm.nextHost.open");
    assert.equal(openedPanels.length, 2);
    const secondHtml = openedPanels[1].webview.html;
    let secondDisposed = false;
    openedPanels[1].onDidDispose(() => { secondDisposed = true; });
    await vscode.commands.executeCommand("pkm.next.disconnect");
    assert.equal(secondDisposed, true, "disconnect did not dispose its webview panel");
    assert.equal(JSON.stringify([firstHtml, secondHtml]).includes(bearer), false);

    console.log(`Electron acceptance passed: activated ${extensionId}; exercised connect, store-token, open and disconnect commands; authenticated ${fixture.requests.length} requests to 127.0.0.1; disposed 2 webview panels.`);
  } finally {
    await vscode.commands.executeCommand("pkm.next.disconnect");
    restoreCreatePanel();
    restoreInput();
    await fixture.close();
    await setConfiguration(config, previous);
  }
};
