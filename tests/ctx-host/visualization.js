const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

async function checkVisualizationWindow(extension, chat, store, expectedCall = "installed-call") {
  const { ApiChatView } = require(path.join(extension.extensionPath, "dist/chat/api-chat-view"));
  const { VisualizationWindow } = require(path.join(extension.extensionPath, "dist/chat/visualization-window"));
  const provider = new ApiChatView({});
  provider.store = store;
  const context = { extensionUri:extension.extensionUri };
  const window = new VisualizationWindow(context, async () => provider);
  const snapshots = [];
  const read = provider.readVisualization.bind(provider);
  provider.readVisualization = async (...args) => {
    const data = await read(...args);
    if (args[1] === "snapshot") snapshots.push(data);
    return data;
  };
  const probe = async cycle => {
    await window.open(chat.id);
    const panel = window.panel;
    assert(panel, "the installed VisualizationWindow created a real VS Code Webview");
    const nonce = /script-src 'nonce-([^']+)'/.exec(panel.webview.html)[1];
    let timer, listener, fail;
    const result = new Promise((resolve, reject) => {
      fail = reject;
      timer = setTimeout(() => reject(new Error(`Installed standalone Visualization timed out (${cycle})`)), 30000);
      listener = panel.webview.onDidReceiveMessage(message => {
        if (message.type !== "installedVisualizationProbe") return;
        if (message.error) reject(new Error(message.error));
        else resolve(message);
      });
    });
    const script = `
      (async () => {
        const api = acquireVsCodeApi();
        const until = async (get, label) => {
          for (let i = 0; i < 300; i++) {
            const value = get();
            if (value) return value;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          throw new Error('Missing installed Visualization evidence: ' + label);
        };
        try {
          const chatId = ${JSON.stringify(chat.id)};
          const tree = await until(() => document.querySelector('[data-chat-id="' + chatId + '"]'), 'persisted Chat tree');
          if (tree.getAttribute('aria-selected') !== 'true') tree.querySelector('.pkm-vis-treerow').click();
          await until(() => document.querySelector('.pkm-harness'), 'mounted recorded execution');
          const tile = id => document.querySelector('[data-panel="' + id + '"]');
          const detail = () => document.querySelector('.pkm-vis-main-detail');
          if (document.querySelectorAll('.pkm-vis-tile').length !== 6) throw new Error('Expected six dashboard views');
          tile('lifecycle').click();
          await until(() => document.querySelector('.pkm-harness-ring'), 'lifecycle ring');
          tile('execution').click();
          await until(() => document.querySelector('.pkm-harness-node'), 'execution graph');
          const refreshed = document.querySelector('.pkm-harness > header span').textContent;
          api.postMessage({ type:'installedVisualizationRefresh' });
          await until(() => document.querySelector('.pkm-harness > header span').textContent !== refreshed, 'record-change push');
          tile('retrieval').click();
          await until(() => detail().textContent.includes('Search-type tool calls'), 'retrieval panel');
          if (!detail().textContent.includes('Sent')) throw new Error('Sent receipt stage missing');
          tile('memory').click();
          await until(() => !detail().hidden && detail().textContent.includes('Memory'), 'Memory receipt or explicit absence');
          tile('timeline').click();
          await until(() => detail().querySelector('.pkm-vis-gantt'), 'recorded timeline');
          tile('recipeAction').click();
          await until(() => detail().textContent.includes('No explicit Recipe Run or Action Run'), 'explicit absence of binding');
          tile('execution').click();
          const warnings = [...document.querySelectorAll('[role="alert"]')].filter(node => !node.hidden && node.textContent);
          if (warnings.length) throw new Error(warnings.map(node => node.textContent).join('; '));
          api.postMessage({ type:'installedVisualizationProbe', cycle:${JSON.stringify(cycle)}, panels:6, refresh:true, readOnly:true });
        } catch (error) { api.postMessage({ type:'installedVisualizationProbe', error:String(error) }); }
      })();`;
    const refresh = panel.webview.onDidReceiveMessage(message => {
      if (message.type !== "installedVisualizationRefresh") return;
      try {
        // A persisted update must reach the window through the production source event path.
        const current = store.load(chat.id, false);
        current.title = `${chat.title} [${cycle}]`;
        current.updatedAt = new Date().toISOString();
        store.save(current);
        provider.notifyRecordChanges();
      } catch (error) { fail(error); }
    });
    // Acquire the VS Code API once, shared by the production page and the test-only DOM probe.
    const html = panel.webview.html.replace(
      /<script nonce="([^"]+)" src="([^"]*visualization-window\.js[^"]*)"><\/script>/,
      `<script nonce="$1">const installedApi = acquireVsCodeApi(); window.acquireVsCodeApi = () => installedApi;</script><script nonce="$1" src="$2"></script>`,
    );
    assert.notEqual(html, panel.webview.html, "the production page script must be present");
    panel.webview.html = html.replace("</body>", `<script nonce="${nonce}">${script}</script></body>`);
    try {
      const value = await result;
      assert.deepEqual(value, { type:"installedVisualizationProbe", cycle, panels:6, refresh:true, readOnly:true });
    } finally {
      clearTimeout(timer); listener?.dispose(); refresh.dispose();
      window.dispose();
    }
  };
  try {
    await probe("open");
    await probe("reopen");
    assert(snapshots.length >= 4, "opening and each persisted change must read authoritative snapshots");
    for (const snapshot of snapshots) {
      assert.equal(snapshot.sessionId, chat.sessionId);
      const call = snapshot.harness.attempts.flatMap(attempt => attempt.toolCalls).find(item => item.id === expectedCall);
      assert(call, "the real controller's tool receipt reaches the standalone window");
      assert.equal(call.status, "complete");
    }
    return { panels:6, reopen:true, recordChange:true, snapshots:snapshots.length };
  } finally { window.dispose(); provider.dispose(); }
}

module.exports = { checkVisualizationWindow };
