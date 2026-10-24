const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const vscode = require("vscode");
const { createHash } = require("node:crypto");

const evidenceHash = chat => createHash("sha256").update(JSON.stringify(chat.messages)).digest("hex");

async function checkLiveVisualizationRecord(extension, store, root) {
  const saved = JSON.parse(fs.readFileSync(path.join(root, "live-visualization.json"), "utf8"));
  const chat = store.load(saved.chatId, false);
  assert.equal(evidenceHash(chat), saved.evidenceHash);
  await require("./visualization").checkVisualizationWindow(extension, chat, store, "vis-recover");
  assert.equal(evidenceHash(store.load(chat.id, false)), saved.evidenceHash, "viewing cannot rewrite execution evidence");
  assert(!fs.existsSync(path.join(root, "workspace", "must-not-exist")));
  assert.equal(fs.readFileSync(path.join(root, "workspace", "vis-recovered"), "utf8"), "VIS_RECOVERED\n");
  return { ...saved, reopen:true };
}

async function checkLiveVisualization(extension, store, root) {
  const moduleAt = name => require(path.join(extension.extensionPath, "dist", name));
  const { ApiChatView } = moduleAt("chat/api-chat-view");
  const { VisualizationWindow } = moduleAt("chat/visualization-window");
  const workspace = path.join(root, "workspace");
  const fixture = path.join(workspace, "vis-process.cjs");
  fs.writeFileSync(fixture, `const fs = require("node:fs"); setTimeout(() => {
    const mode = process.argv[2];
    if (mode === "denied") fs.writeFileSync(${JSON.stringify(path.join(workspace, "must-not-exist"))}, "unsafe");
    if (mode === "recover") fs.appendFileSync(${JSON.stringify(path.join(workspace, "vis-recovered"))}, "VIS_RECOVERED\\n");
    console.log(mode === "fail" ? "VIS_EXPECTED_FAILURE" : "VIS_RECOVERED");
    process.exitCode = mode === "fail" ? 1 : 0;
  }, 1200);`);
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(payload);
    const round = requests.length;
    const mode = ["denied", "fail", "recover"][round - 1];
    const delta = mode ? { tool_calls:[{ index:0, id:`vis-${mode}`, type:"function", function:{
      name:"run_process", arguments:JSON.stringify({ program:process.env.PKM_CTX_NODE, arguments:[fixture, mode], timeoutSeconds:10 }),
    } }] } : { content:"VIS_RECOVERED: the rejected command did not execute; the expected failure was recovered." };
    await new Promise(resolve => setTimeout(resolve, 1100));
    response.writeHead(200, { "Content-Type":"text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices:[{ delta, finish_reason:mode ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider = new ApiChatView({
    secrets:{ get:async () => "isolated-vis-fixture" },
    globalStorageUri:vscode.Uri.file(path.join(root, "ctx-private-host")),
  }, async () => {
    await new Promise(resolve => setTimeout(resolve, 1100));
    return [];
  });
  const profile = { id:"vis-live", model:"vis-live", label:"Local VIS fixture", status:"active",
    contextWindow:32768, maxOutputTokens:1024, currency:"USD", includeUsage:false, outputTokenParameter:"max_tokens" };
  const chat = store.create();
  chat.title = "Live VIS acceptance"; chat.permissionMode = "ask"; chat.includeHistory = false;
  chat.builtinTools = ["run_process"]; chat.vscodeTools = [];
  store.startTask(chat, "Live VIS acceptance");
  provider.store = store; provider.chat = chat; provider.chats.set(chat.id, chat);
  provider.publish = () => provider.notifyRecordChanges();
  provider.toolGroups = () => [{ id:"builtin", tools:[{ name:"run_process", enabled:true }] }];
  provider.settings = () => ({ provider:"openai-compatible", selectedProfile:profile, profiles:[profile],
    endpoint:`http://127.0.0.1:${server.address().port}/v1`, model:profile.model,
    contextWindow:32768, maxOutputTokens:1024, timeoutMs:30000, maxToolRounds:5, loopReviewAfterMs:60000 });
  const window = new VisualizationWindow({ extensionUri:extension.extensionUri }, async () => provider);
  const observed = [], answers = [], answered = new Set();
  let listener, timer, sending;
  try {
    await window.open(chat.id);
    const panel = window.panel;
    const nonce = /script-src 'nonce-([^']+)'/.exec(panel.webview.html)[1];
    const finished = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Live installed Visualization timed out: ${JSON.stringify(observed)}`)), 45000);
      listener = panel.webview.onDidReceiveMessage(async message => {
        try {
          if (message.type === "liveVisReady") {
            sending = provider.send("Exercise the isolated VIS process: refuse the first command, run the expected failure, then recover. Never deploy.");
            sending.catch(reject);
          } else if (message.type === "liveVisPhase") {
            observed.push({ phase:message.phase, text:message.text });
            if (message.phase === "waiting") {
              const pending = [...provider.approvals.entries()].find(([id]) => !answered.has(id));
              if (pending) {
                const [id] = pending;
                answered.add(id);
                const answer = answers.length ? "approve-once" : "deny";
                await require("./visualization-chain").screenshot(`approval-${answers.length + 1}-${answer}`);
                answers.push(answer);
                await provider.handle({ type:"approval", id, value:answer });
              }
            }
            if (message.phase === "complete") {
              assert.equal(message.failedReceipt, true);
              await require("./visualization-chain").screenshot("process-failure-recovered");
              resolve();
            }
          } else if (message.type === "liveVisError") reject(new Error(message.error));
        } catch (error) { reject(error); }
      });
    });
    const script = `
      (async () => {
        const api = installedApi;
        let snapshot;
        window.addEventListener('message', event => {
          if (event.data.type === 'result' && event.data.data?.harness) snapshot = event.data.data;
        });
        try {
          for (let i=0; !document.querySelector('.pkm-harness'); i++) {
            if (i>200) throw new Error('Live Visualization did not mount');
            await new Promise(resolve => setTimeout(resolve,50));
          }
          document.querySelector('[data-panel="execution"]').click();
          const seen = new Set();
          setInterval(() => {
            const mark = document.querySelector('.pkm-harness-phase');
            if (!mark) return;
            const phase = mark.dataset.phase;
            const text = document.querySelector('.pkm-harness-overview').textContent;
            const key = phase + ':' + text;
            if (seen.has(key)) return;
            seen.add(key);
            try {
              let failedReceipt = false;
              if (phase === 'complete') {
                const model = PkmAgentHarness.build(snapshot);
                const failed = [...model.graphs.values()].find(graph => graph.nodes.some(node => node.kind === 'Result' && node.status === 'failed'));
                if (!failed) throw new Error('Missing failed tool graph');
                const route = [];
                for (let graph = failed; graph.parent; graph = model.graphs.get(graph.parent))
                  route.unshift(model.graphs.get(graph.parent).nodes.find(node => node.child === graph.id).title);
                const button = label => {
                  const found = [...document.querySelectorAll('.pkm-harness button')].find(node => node.textContent === label);
                  if (!found) throw new Error('Missing live graph button: ' + label);
                  return found;
                };
                document.querySelector('[data-panel="lifecycle"]').click();
                button('Full execution graph').click();
                for (const title of route) {
                  const expand = [...document.querySelectorAll('.pkm-harness-expand')].find(node => node.getAttribute('aria-label') === 'Open subgraph: ' + title);
                  if (!expand) throw new Error('Missing live tool navigation: ' + title);
                  expand.click();
                }
                button('Recorded result').click();
                const receipt = JSON.parse(document.querySelector('.pkm-harness-inspector pre').textContent);
                if (receipt.error !== 'Program launch declined by the user.') throw new Error('Expected original denied-command receipt: ' + JSON.stringify(receipt));
                document.querySelector('.pkm-harness-inspector').scrollIntoView({ block:'end' });
                failedReceipt = true;
              }
              api.postMessage({ type:'liveVisPhase', phase, text, failedReceipt });
            } catch (error) { api.postMessage({ type:'liveVisError', error:String(error) }); }
          }, 80);
          api.postMessage({ type:'liveVisReady' });
        } catch (error) { api.postMessage({ type:'liveVisError', error:String(error) }); }
      })();`;
    const html = panel.webview.html.replace(
      /<script nonce="([^"]+)" src="([^"]*visualization-window\.js[^"]*)"><\/script>/,
      `<script nonce="$1">const installedApi = acquireVsCodeApi(); window.acquireVsCodeApi = () => installedApi;</script><script nonce="$1" src="$2"></script>`,
    );
    assert.notEqual(html, panel.webview.html);
    panel.webview.html = html.replace("</body>", `<script nonce="${nonce}">${script}</script></body>`);
    await finished;
    await sending;
    const phases = new Set(observed.map(item => item.phase));
    for (const phase of ["retrieval", "model", "tool", "waiting", "complete"]) assert(phases.has(phase), `real DOM must show ${phase}: ${JSON.stringify(observed)}`);
    assert.deepEqual(answers, ["deny", "approve-once", "approve-once"]);
    assert(!fs.existsSync(path.join(workspace, "must-not-exist")), "denied commands must not run");
    assert.equal(fs.readFileSync(path.join(workspace, "vis-recovered"), "utf8"), "VIS_RECOVERED\n");
    const reply = store.load(chat.id, false).messages.at(-1);
    assert.equal(reply.status, "complete", reply.error);
    const calls = reply.toolCalls;
    assert.equal(calls.length, 3);
    assert.equal(calls[0].status, "failed");
    assert.equal(JSON.parse(calls[1].result).exitCode, 1);
    assert.equal(JSON.parse(calls[2].result).exitCode, 0);
    assert.equal(requests.length, 4, "opening and refreshing Visualization adds no model requests");
    fs.writeFileSync(path.join(root, "live-visualization.json"), JSON.stringify({
      chatId:chat.id, evidenceHash:evidenceHash(store.load(chat.id, false)),
      phases:[...phases], approvals:answers, requests:requests.length, recovered:true,
    }));
  } finally {
    clearTimeout(timer); listener?.dispose();
    provider.running.get(chat.id)?.abort();
    try { if (sending) await sending; }
    finally {
      window.dispose(); provider.dispose();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  }
  return checkLiveVisualizationRecord(extension, store, root);
}

module.exports = { checkLiveVisualization, checkLiveVisualizationRecord };
