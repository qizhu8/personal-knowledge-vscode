const assert = require("node:assert/strict");
const { test } = require("node:test");
const Module = require("node:module");
const load = Module._load;
Module._load = function (name, ...args) { return name === "vscode" ? {} : load.call(this, name, ...args); };
const { ApiChatView } = require("../dist/chat/api-chat-view");
Module._load = load;

test("Chat visibility restores current state once without replaying ready or restarting discovery", async () => {
  const backend = new ApiChatView({});
  let published = 0, ready = 0, visibilityDisposed = 0, messagesDisposed = 0;
  backend.publish = () => { published++; };
  backend.handle = async message => { if (message.type === "ready") ready++; };
  function view() {
    let changed, disposed;
    return {
      visible: true,
      webview: { onDidReceiveMessage() { return { dispose() { messagesDisposed++; } }; } },
      onDidChangeVisibility(callback) { changed = callback; return { dispose() { visibilityDisposed++; } }; },
      onDidDispose(callback) { disposed = callback; return { dispose() {} }; },
      change(visible) { this.visible = visible; changed(); },
      close() { disposed(); },
    };
  }
  const first = view();
  backend.attachWebviewView(first, true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(ready, 1);
  for (let index = 0; index < 30; index++) {
    first.change(false);
    assert.equal(published, index);
    first.change(true);
    assert.equal(published, index + 1);
  }
  assert.equal(ready, 1, "Restoring visibility must not repeat initialization/MCP startup");
  const second = view();
  backend.attachWebviewView(second, true);
  await new Promise(resolve => setTimeout(resolve, 10));
  first.change(true);
  assert.equal(published, 30, "A replaced Webview cannot publish into the new view");
  first.close();
  assert.equal(backend.view, second);
  second.change(false); second.change(true);
  assert.equal(published, 31);
  second.close();
  assert.equal(visibilityDisposed, 2);
  assert.equal(messagesDisposed, 2);
  assert.equal(backend.view, undefined);
});
