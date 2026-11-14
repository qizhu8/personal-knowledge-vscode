const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn, execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const vscode = require("vscode");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function until(read, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}

async function screenshot(label) {
  if (!process.env.PKM_VIS_ACCEPTANCE_OUTPUT) return;
  await vscode.commands.executeCommand("notifications.clearAll");
  await sleep(100);
  const { chromium } = require(process.env.PKM_PLAYWRIGHT_PATH || "playwright");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.PKM_CTX_DEBUG_PORT}`);
  try {
    const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes("workbench"));
    assert(page, "the screenshot must capture the installed VS Code window");
    const output = process.env.PKM_VIS_ACCEPTANCE_OUTPUT;
    fs.mkdirSync(output, { recursive:true });
    await page.screenshot({ path:path.join(output, `${process.env.PKM_CTX_PHASE}-${label}.png`) });
  } finally { await browser.close(); }
}

async function checkVisualizationChain(extension, store, root, restart = false) {
  const moduleAt = name => require(path.join(extension.extensionPath, "dist", name));
  const { ApiChatView } = moduleAt("chat/api-chat-view");
  const { VisualizationWindow } = moduleAt("chat/visualization-window");
  const state = path.join(root, "knowledge", ".pkm", "state");
  const savedPath = path.join(root, "vis-chain.json");
  const saved = restart ? JSON.parse(fs.readFileSync(savedPath, "utf8")) : undefined;
  const chat = restart ? store.load(saved.chatId, false) : store.create();
  const provider = new ApiChatView({
    extensionPath:extension.extensionPath, secrets:{ get:async () => undefined },
    globalStorageUri:vscode.Uri.file(path.join(root, "ctx-private-host")),
  }, async () => []);
  provider.store = store; provider.chat = chat; provider.chats.set(chat.id, chat);
  provider.publish = () => provider.notifyRecordChanges();
  const window = new VisualizationWindow({ extensionUri:extension.extensionUri }, async () => provider);
  let runtime, server, sending, listener, timer, failRun, runtimeError = "", modelError;
  const observed = new Set(), snapshots = [], requests = [];
  const recipePath = id => path.join(state, "recipe-runs", `${id}.json`);
  const actionPath = id => path.join(state, "actions", "runs", id, "run.json");
  const read = filename => JSON.parse(fs.readFileSync(filename, "utf8"));
  const evidence = () => hash({
    messages:store.load(chat.id, false).messages,
    recipes:fs.readdirSync(path.join(state, "recipe-runs")).filter(name => name.endsWith(".json")).sort()
      .map(name => read(path.join(state, "recipe-runs", name))),
    actions:fs.readdirSync(path.join(state, "actions", "runs")).filter(name => /^action_run_/.test(name)).sort()
      .map(name => read(actionPath(name))),
  });
  let parentId = saved?.parentId, childId = saved?.childId, actionId = saved?.actionId;
  let waking = false;
  try {
    if (!restart) {
      const { RecipeFilesystemStore } = moduleAt("workflows/recipe-filesystem-store");
      const { compileWorkflowDefinitionV1 } = moduleAt("workflows/workflow-contracts");
      const definition = { schema:"pkm.workflow.definition/v1", spec:{ inputs:{}, nodes:[
        { nodeId:"execute", kind:"pkm.step.noop/v1", config:{}, dependsOn:[] },
      ], outputs:{}, completion:{ requiredNodes:["execute"] } } };
      const compiled = compileWorkflowDefinitionV1(definition);
      assert(compiled.ok);
      const recipes = new RecipeFilesystemStore(state);
      recipes.put({ recipeId:"recipe_vis_child", name:"VIS nested procedure", scope:"global", revision:1,
        definition:compiled.model, executableDigest:compiled.executableDigest, description:"Isolated actual runtime acceptance" });
      const parentDefinition = { schema:"pkm.workflow.definition/v1", spec:{ inputs:{}, nodes:[
        { nodeId:"nested", kind:"pkm.subflow/v1", config:{ recipeId:"recipe_vis_child", revision:1,
          executableDigest:compiled.executableDigest }, dependsOn:[] },
      ], outputs:{}, completion:{ requiredNodes:["nested"] } } };
      const reservation = net.createServer();
      await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
      const port = reservation.address().port;
      await new Promise(resolve => reservation.close(resolve));
      runtime = spawn(process.env.PKM_TEST_PYTHON, [path.join(__dirname, "visualization-runtime.py"), extension.extensionPath, root, String(port)],
        { stdio:["ignore", "ignore", "pipe"] });
      runtime.stderr.on("data", chunk => { runtimeError = (runtimeError + chunk).slice(-12000); });
      runtime.on("error", error => { modelError = error; });
      await until(async () => {
        if (modelError) throw modelError;
        if (runtime.exitCode !== null) throw new Error(runtimeError);
        if (!fs.existsSync(path.join(root, "vis-runtime-ready.json"))) return false;
        try { return (await fetch(`http://127.0.0.1:${port}/mcp`)).status === 406; }
        catch (error) { if (error.cause?.code === "ECONNREFUSED") return false; throw error; }
      }, "real installed-resource MCP fixture");
      const fixture = read(path.join(root, "vis-runtime-ready.json"));
      const remote = ["recipe_run_start_adhoc", "recipe_run_next", "recipe_run_report", "recipe_run_get",
        "action_call", "action_run_get", "action_run_wait"];
      chat.title = "VIS complete runtime chain"; chat.permissionMode = "allow-all"; chat.includeHistory = false;
      chat.builtinTools = ["search_text", "record_harness"]; chat.vscodeTools = [];
      chat.mcpServers = [{ id:"vis-runtime", label:"VIS runtime", url:`http://127.0.0.1:${port}/mcp`, enabled:true, tools:remote }];
      store.startTask(chat, chat.title);
      fs.writeFileSync(path.join(root, "workspace", "vis-search.txt"), "VIS_SEARCH_EVIDENCE: never deploy; inspect the original run.\n");
      provider.toolGroups = () => [
        { id:"builtin", tools:chat.builtinTools.map(name => ({ name, enabled:true })) },
        { id:"mcp:vis-runtime", tools:remote.map(name => ({ name, enabled:true })) },
      ];
      server = http.createServer(async (request, response) => {
        try {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const payload = JSON.parse(Buffer.concat(chunks).toString());
          requests.push(payload);
          const round = requests.length - 1;
          const tool = name => name === "search_text" || name === "record_harness" ? name
            : payload.tools.find(item => item.function.description.startsWith(`VIS runtime: ${name}.`)).function.name;
          const call = (name, args) => ({ tool_calls:[{ index:0, id:`chain-${round}`, type:"function",
            function:{ name:tool(name), arguments:JSON.stringify(args) } }] });
          const result = index => {
            const message = payload.messages.find(item => item.role === "tool" && item.tool_call_id === `chain-${index}`);
            assert(message, `original tool result ${index}`);
            const envelope = JSON.parse(message.content);
            const text = envelope.content?.find(part => part.type === "text")?.text;
            const value = envelope.structuredContent || (text ? JSON.parse(text) : envelope);
            assert.notEqual(value.ok, false, JSON.stringify(value));
            assert(!value.error, `Tool ${index}: ${JSON.stringify(value)}`);
            return value;
          };
          let delta;
          if (round === 0) delta = call("search_text", { query:"VIS_SEARCH_EVIDENCE", glob:"vis-search.txt" });
          else if (round === 1) {
            await until(() => observed.has("search"), "real search result in Retrieval panel");
            delta = call("recipe_run_start_adhoc", { name:"VIS parent procedure", definition_json:JSON.stringify(parentDefinition), command_id:"vis-parent-original" });
          } else if (round === 2) {
            parentId = result(1).run_id;
            delta = call("recipe_run_next", { run_id:parentId, command_id:"vis-parent-claim" });
          } else if (round === 3) {
            childId = result(2).next_action.child_run_id;
            assert(childId);
            delta = call("recipe_run_next", { run_id:childId, command_id:"vis-child-claim" });
          } else if (round === 4) delta = call("record_harness", {
            kind:"step", stepId:"nested-action", status:"start", summary:"Execute original nested Action",
            recipeRunId:childId, recipeStageId:"execute",
          });
          else if (round === 5) {
            result(4);
            await until(() => observed.has("recipe"), "real nested Recipe binding in DOM");
            delta = call("action_call", { action_id:fixture.actionId, inputs:{}, content_hash:fixture.contentHash, idempotency_key:"vis-action-once" });
          } else if (round === 6) {
            actionId = result(5).run_id;
            await until(() => read(actionPath(actionId)).state === "waiting", "actual nested Action event wait");
            delta = call("action_run_get", { run_id:actionId });
          } else if (round === 7) {
            await until(() => observed.has("action-wait"), "persisted nested Action wait in DOM");
            delta = call("action_run_wait", { run_id:actionId, wait_seconds:15 });
          } else if (round === 8) {
            const finished = result(7);
            assert.equal(finished.state, "succeeded");
            assert.deepEqual(finished.output, { value:"VIS_COMPONENT_COMPLETE" });
            delta = call("record_harness", { kind:"step", stepId:"nested-action", status:"complete",
              summary:"Original Action completed", recipeRunId:childId, recipeStageId:"execute", evidenceCallIds:["chain-7"] });
          } else if (round === 9) delta = call("recipe_run_report", { run_id:childId, node_id:"execute", outcome:"succeeded",
            command_id:"vis-child-complete", result_json:JSON.stringify({ run_id:actionId }) });
          else if (round === 10) {
            result(9);
            delta = call("recipe_run_get", { run_id:parentId });
          } else {
            assert.equal(result(10).status, "completed");
            delta = { content:"VIS_CHAIN_COMPLETE: original nested Recipe and Action completed; no deployment." };
          }
          await sleep(600);
          response.writeHead(200, { "Content-Type":"text/event-stream" });
          response.end(`data: ${JSON.stringify({ choices:[{ delta, finish_reason:delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
        } catch (error) {
          modelError = error;
          failRun?.(error);
          response.writeHead(500); response.end(String(error));
        }
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const profile = { id:"vis-chain", model:"vis-chain", label:"Local runtime chain", status:"active",
        contextWindow:131072, maxOutputTokens:1024, currency:"USD", includeUsage:false, outputTokenParameter:"max_tokens" };
      provider.settings = () => ({ provider:"openai-compatible", selectedProfile:profile, profiles:[profile],
        endpoint:`http://127.0.0.1:${server.address().port}/v1`, model:profile.model, contextWindow:131072,
        maxOutputTokens:1024, timeoutMs:60000, maxToolRounds:20, loopReviewAfterMs:120000 });
    }
    await window.open(chat.id);
    const panel = window.panel;
    const nonce = /script-src 'nonce-([^']+)'/.exec(panel.webview.html)[1];
    const finished = new Promise((resolve, reject) => {
      failRun = reject;
      timer = setTimeout(() => reject(modelError || new Error(`Chain DOM timeout: ${[...observed]} / ${runtimeError}`)), 100000);
      listener = panel.webview.onDidReceiveMessage(async message => {
        try {
          if (message.type === "chainReady" && !restart) {
            sending = provider.send("Search VIS_SEARCH_EVIDENCE, run the pinned nested procedure and its original Action, wait for the event, and inspect completion. Never deploy.");
            sending.catch(reject);
          } else if (message.type === "chainSnapshot") {
            snapshots.push(message.data);
            const call = message.data.harness.attempts.at(-1)?.toolCalls.find(item => item.id === "chain-7" && item.status === "running");
            if (!restart && call && observed.has("action-wait") && !waking) {
              waking = true;
              await sleep(700);
              const waitingChild = message.data.actionRuns.find(item => item.parentRunId === actionId && item.state === "waiting");
              assert(waitingChild, "the event belongs to the original nested child Run");
              const result = await new Promise((resolve, reject) => {
                const child = execFile(process.env.PKM_TEST_PYTHON,
                  [path.join(extension.extensionPath, "resources/action_modules.py"), "--api", path.join(root, "knowledge")],
                  { timeout:30000 }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout)));
                child.stdin.end(JSON.stringify({ method:"wake_run", params:{
                  run_id:waitingChild.runId, event_name:"vis-release", event_key:"vis-original-event",
                } }));
              });
              assert.notEqual(result.ok, false, JSON.stringify(result));
            }
          } else if (message.type === "chainObserved") {
            if (observed.has(message.label)) return;
            await screenshot(`${restart ? "recorded" : "live"}-${message.label}`);
            observed.add(message.label);
            await panel.webview.postMessage({ type:"chainCaptured", label:message.label });
            if (message.label === "terminal") resolve();
          } else if (message.type === "chainError") reject(new Error(message.error));
        } catch (error) { reject(error); }
      });
    });
    const script = `
      (async () => {
        const api = installedApi, observed = new Set(), captures = new Map();
        let snapshot, busy = false;
        window.addEventListener('message', event => {
          if (event.data.type === 'result' && event.data.data?.harness) {
            snapshot = event.data.data;
            api.postMessage({ type:'chainSnapshot', data:snapshot });
          }
          if (event.data.type === 'chainCaptured') captures.get(event.data.label)?.();
        });
        const panel = id => document.querySelector('[data-panel="' + id + '"]').click();
        const click = label => {
          const found = [...document.querySelectorAll('.pkm-harness button')].find(node => node.textContent === label);
          if (!found) throw new Error('Missing recorded navigation: ' + label);
          found.click();
        };
        const locateGraph = (model, graph) => {
          const route = [];
          for (let cursor=graph; cursor.parent; cursor=model.graphs.get(cursor.parent)) {
            const parent = model.graphs.get(cursor.parent), node = parent.nodes.find(item => item.child === cursor.id);
            if (!node) throw new Error('Unreachable recorded graph');
            route.unshift(node.title);
          }
          panel('lifecycle');
          const lifecycle = [...document.querySelectorAll('.pkm-harness button')].find(node => node.textContent === 'Lifecycle');
          if (lifecycle) lifecycle.click();
          click('Full execution graph');
          for (const title of route) {
            const expand = [...document.querySelectorAll('.pkm-harness-expand')].find(node => node.getAttribute('aria-label') === 'Open subgraph: ' + title);
            if (!expand) throw new Error('Missing subgraph: ' + title);
            expand.click();
          }
        };
        const record = async label => {
          observed.add(label);
          const capture = async name => {
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            await new Promise(resolve => {
              captures.set(name, resolve);
              api.postMessage({ type:'chainObserved', label:name });
            });
          };
          if (label !== 'search' && label !== 'lifecycle') {
            const selected = document.querySelector('.pkm-harness-node.selected');
            if (!selected) throw new Error('No selected evidence node for ' + label);
            selected.scrollIntoView({ block:'center', inline:'center' });
            await capture(label + '-graph');
          }
          const target = label === 'search' ? document.querySelector('.pkm-vis-main-detail')
            : document.querySelector(label === 'lifecycle' ? '.pkm-harness-ring' : '.pkm-harness-inspector');
          target.scrollIntoView({ block:label === 'lifecycle' ? 'center' : 'end' });
          await capture(label);
        };
        try {
          for (let i=0; !document.querySelector('.pkm-harness'); i++) {
            if(i>300) throw new Error('Chain did not mount');
            await new Promise(resolve => setTimeout(resolve,50));
          }
          api.postMessage({ type:'chainReady' });
          setInterval(async () => {
            if (!snapshot || busy) return;
            busy = true;
            try {
              const attempt = snapshot.harness.attempts.at(-1), model = PkmAgentHarness.build(snapshot);
              if (!observed.has('search') && attempt?.toolCalls.some(call => call.id === 'chain-0' && call.status === 'complete')) {
                panel('retrieval');
                if (!document.querySelector('.pkm-vis-main-detail').textContent.includes('VIS_SEARCH_EVIDENCE')) throw new Error('Original search query missing');
                await record('search');
              }
              if (!observed.has('recipe') && model.overview.recipes.some(binding => binding.available && binding.nodeId === 'execute')) {
                panel('recipeAction');
                const binding = [...document.querySelectorAll('[data-binding-id]')].find(node => node.dataset.bindingId.endsWith(':execute'));
                if (!binding || binding.disabled) throw new Error('Live nested Recipe binding unavailable');
                binding.click();
                if (![...document.querySelectorAll('.pkm-harness-node')].some(node => node.dataset.nodeId === 'execute')) throw new Error('Wrong Recipe stage');
                await record('recipe');
              }
              const waiting = snapshot.actionRuns?.find(run => run.parentRunId && run.state === 'waiting');
              if (!observed.has('action-wait') && waiting) {
                const graph = model.graphs.get(JSON.stringify(['action', waiting.runId]));
                locateGraph(model, graph);
                click('Durable Action receipts');
                if (!document.querySelector('.pkm-harness-viewport').textContent.includes('waiting')) throw new Error('Nested Action wait not rendered');
                await record('action-wait');
              }
              if (!observed.has('terminal') && attempt?.status === 'complete') {
                const child = snapshot.actionRuns?.find(run => run.parentRunId);
                if (!child || child.state !== 'succeeded') throw new Error('No completed original child Action');
                if (snapshot.runs.length !== 2 || snapshot.runs.some(run => run.status !== 'completed')) throw new Error('Nested Recipes did not complete');
                const graph = model.graphs.get(JSON.stringify(['action', child.runId]));
                const receipt = graph.nodes.find(node => node.kind === 'Component' && JSON.stringify(node.info).includes('VIS_COMPONENT_COMPLETE'));
                if (!receipt) throw new Error('Original Component receipt unavailable');
                panel('lifecycle'); click('Lifecycle');
                await record('lifecycle');
                locateGraph(model, graph); click(receipt.title);
                if (!document.querySelector('.pkm-harness-inspector').textContent.includes('VIS_COMPONENT_COMPLETE')) throw new Error('Component result not visible');
                if (document.querySelector('.pkm-harness-error')?.textContent) throw new Error('Harness error');
                await record('terminal');
              }
            } catch (error) { api.postMessage({ type:'chainError', error:String(error) }); }
            finally { busy = false; }
          },100);
        } catch (error) { api.postMessage({ type:'chainError', error:String(error) }); }
      })();`;
    const html = panel.webview.html.replace(
      /<script nonce="([^"]+)" src="([^"]*visualization-window\.js[^"]*)"><\/script>/,
      `<script nonce="$1">const installedApi = acquireVsCodeApi(); window.acquireVsCodeApi = () => installedApi;</script><script nonce="$1" src="$2"></script>`,
    );
    assert.notEqual(html, panel.webview.html);
    panel.webview.html = html.replace("</body>", `<script nonce="${nonce}">${script}</script></body>`);
    await finished;
    if (sending) await sending;
    if (modelError) throw modelError;
    const reply = store.load(chat.id, false).messages.at(-1);
    assert.equal(reply.status, "complete", reply.error);
    assert.equal(read(recipePath(parentId)).nodes.nested.childRunId, childId);
    assert.equal(snapshots.at(-1).actionRuns.length, 2, "one parent and one original child Action, no replay");
    if (restart) assert.equal(evidence(), saved.evidenceHash, "restart/read-only inspection cannot replay runtime execution");
    else {
      assert.equal(requests.length, 12);
      fs.writeFileSync(savedPath, JSON.stringify({ chatId:chat.id, parentId, childId, actionId, evidenceHash:evidence() }));
      window.dispose();
      await checkVisualizationChain(extension, store, root, true);
      assert.equal(requests.length, 12, "reopening cannot replay the local model or its tools");
    }
    return { tags:[...observed], evidenceHash:restart ? saved.evidenceHash : read(savedPath).evidenceHash, requests:restart ? 0 : requests.length };
  } finally {
    clearTimeout(timer); listener?.dispose();
    provider.running.get(chat.id)?.abort();
    try { if (sending) await sending; }
    finally {
      window.dispose(); provider.dispose();
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      if (runtime && runtime.exitCode === null) {
        const stopped = new Promise(resolve => runtime.once("exit", resolve));
        runtime.kill("SIGTERM"); await stopped;
      }
    }
  }
}

module.exports = { checkVisualizationChain, screenshot };
