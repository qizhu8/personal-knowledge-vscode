const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fixture, sessionId, actionId, runId, childId } = require("./native-harness-fixture");
const { build, layout, terminal } = require("../src/webview/agent-harness");
const { apiChatHarnessSnapshot, apiChatSessionHarnessSnapshot } = require("../dist/chat/api-chat-store");
const { ChatHistoryStorage } = require("../dist/chat/chat-history-storage");
const { recordedActionReferences, readHarnessActions } = require("../dist/runtime/native-harness-actions");
const { HarnessChangeFeed, createNativeHarnessServer } = require("../dist/runtime/native-harness-server");
const k = (...parts) => JSON.stringify(parts);
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-native-harness-"));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  return directory;
}

test("native graphs retain real hierarchy, Recipe versions, terminal ports and direct execution", () => {
  const data = fixture(), model = build(data);
  assert.throws(() => build({ ...data, origin:"external" }), /PKM-native/);
  assert.equal(model.graphs.get(k("recipe", childId)).parent, k("recipe", runId));
  assert.equal(model.runs.get(runId).definition.spec.name, "Pinned development v7");
  const root = model.graphs.get(model.root);
  const ignored = root.nodes.find(node => node.title === "Unneeded deployment");
  assert.equal(terminal(ignored.status), "ignored");
  assert.equal(ignored.child, undefined, "ignored before dispatch does not fabricate an execution");
  assert.equal(terminal("running"), "");
  assert.equal(terminal("pending"), "");
  assert.equal(terminal("rejected"), "", "an unchosen possibility is not ignored execution");
  assert.equal(terminal("cancelled"), "", "cancellation is not silently reclassified as ignored");
  const a1 = model.graphs.get(k("chat-attempt", "m1"));
  assert.equal(a1.nodes.find(node => node.id === "planning").title, "Direct execution / not refined");
  assert(model.warnings.some(warning => warning.includes("2 transitions")));
  assert.equal(model.graphs.get(k("possibility", "m2", "p")).nodes[0].title, "Check fixtures");
  const calls = model.graphs.get(k("calls", "m2"));
  assert.equal(calls.nodes[0].kind, "Function / MCP call");
  const action = model.graphs.get(k("action", actionId));
  assert.equal(action.parent, k("call", "m2", "call2"));
  const component = model.graphs.get(k("component", actionId, "branch"));
  assert.equal(component.nodes[0].status, "ignored");
  for (const graph of model.graphs.values()) {
    const geometry = layout(graph);
    for (const edge of geometry.forward) assert(geometry.positions.get(edge.to).y > geometry.positions.get(edge.from).y + 180);
  }
  data.actionRuns[0].state = "ignored";
  const ignoredAction = build(data).graphs.get(k("call", "m2", "call2")).nodes.find(node => node.kind === "Action / program-controlled");
  assert.equal(terminal(ignoredAction.status), "ignored");
  assert.equal(ignoredAction.info.source.kind, "durable-action-run");
});

test("retries append to one Step without overwriting failed attempts or inventing causality", () => {
  const data = fixture();
  const before = JSON.stringify(data.harness.attempts[0]);
  data.harness.attempts.push({ ...data.harness.attempts[1], messageId:"m3", attemptId:"a3", retryOf:"a2", inputId:"new-user-input", status:"complete", attempt:3 });
  const model = build(data), group = model.graphs.get(k("chat-step", "a1"));
  assert.equal(group.nodes.length, 3);
  assert.deepEqual(group.edges.map(edge => [edge.from, edge.to]), [["a1","a2"],["a2","a3"]]);
  assert.equal(group.nodes[0].status, "failed");
  assert.equal(JSON.stringify(data.harness.attempts[0]), before);
});

test("Agent output subgraphs reuse exact public text without invented reasoning or completion authority", () => {
  const data = fixture();
  data.harness.attempts[0].response = "Legacy partial response";
  data.harness.attempts[1].status = "complete";
  data.harness.attempts[1].publicOutputs = [
    { round:0, start:0, end:15, hasToolCalls:true, text:"Inspect first.\n\n" },
    { round:1, start:15, end:31, text:"<b>Result</b>: OK" },
  ];
  const model = build(data), attempt = model.graphs.get(k("chat-attempt", "m2"));
  assert.equal(attempt.nodes.find(node => node.id === "response").child, k("public-output", "m2"));
  const outputs = model.graphs.get(k("public-output", "m2"));
  assert.equal(outputs.parent, attempt.id);
  assert.equal(outputs.nodes[0].title, "Progress explanation / round 1");
  assert.equal(outputs.nodes[1].title, "Final response / conclusion");
  assert.equal(outputs.nodes[1].publicText, "<b>Result</b>: OK");
  assert(outputs.nodes.every(node => node.executable === false));
  assert.equal(model.graphs.get(k("public-output", "m1")).nodes[0].publicText, "Legacy partial response");
  data.harness.attempts[1].status = "failed";
  assert.equal(build(data).graphs.get(outputs.id).nodes[1].title, "Partial response");
  delete data.harness.attempts[1].publicOutputs;
  data.harness.attempts[1].response = "";
  assert.equal(build(data).graphs.get(outputs.id).nodes[0].title, "No public explanation or response recorded");
});

test("multiple nested Recipes, loop history and cyclic evidence remain bounded", () => {
  const data = fixture();
  const third = `${childId}_another`;
  data.runs.push({ ...data.runs[1], runId:third });
  data.recipeTreeEdges = [{ fromRunId:runId, fromNodeId:"debug", toRunId:third, toNodeId:"inspect" }];
  data.runs[0].nodes[1].attempt = 2;
  data.runs[0].loops = [{ history:[{ iteration:1, nodes:{ debug:{ attempt:1, state:"failed", error:"Original failure" } } }] }];
  const model = build(data), attempts = model.graphs.get(k("recipe-attempts", runId, "debug"));
  assert.equal(attempts.nodes.filter(node => node.kind === "Execution attempt").length, 2);
  assert.equal(attempts.nodes.filter(node => node.kind === "Recipe").length, 2);
  assert.equal(model.graphs.get(k("recipe", childId)).parent, attempts.id);
  assert.equal(model.graphs.get(k("recipe", third)).parent, attempts.id);
  const cyclic = layout({ nodes:[{ id:"a" },{ id:"b" }], edges:[{ from:"a",to:"b" },{ from:"b",to:"a" }] });
  assert.equal(cyclic.positions.size, 2);
  assert(cyclic.deferred.length);
});

test("an explicit Recipe stage binding nests Harness attempts alongside that Step's nested Recipe", () => {
  const data = fixture();
  data.harness.attempts[0].planning = { recipeRunId:runId, recipeStageId:"debug", possibilities:[] };
  const model = build(data), stage = model.graphs.get(k("step-evidence", runId, "debug"));
  assert.equal(model.graphs.get(k("chat-step", "a1")).parent, stage.id);
  assert.equal(model.graphs.get(k("recipe", childId)).parent, stage.id);
  assert(stage.nodes.some(node => node.kind === "Nested execution"));
  assert.equal(model.graphs.get(k("recipe", runId)).nodes.find(node => node.id === "debug").child, stage.id);
  data.harness.attempts.push({ ...data.harness.attempts[1], messageId:"independent", attemptId:"independent", retryOf:undefined,
    planning:{ recipeRunId:childId, recipeStageId:"inspect", possibilities:[] } });
  const updated = build(data);
  assert.equal(updated.graphs.get(k("chat-step", "a1")).parent, stage.id, "later work must not move the original retry chain");
  assert.equal(updated.graphs.get(k("chat-step", "independent")).parent, k("step-evidence", childId, "inspect"));
});

test("snapshot exposes every recorded attempt/call and exact parameters; previews are explicit", t => {
  const chat = { version:1, id:"11111111-1111-4111-8111-111111111111", sessionId, title:"fixture", createdAt:"now", updatedAt:"now", context:[], includeHistory:true, messages:[
    { id:"u", role:"user", status:"complete", content:"q".repeat(4001) },
    ...Array.from({ length:45 }, (_, i) => ({
      id:`m${i}`, role:"assistant", status:"complete", content:"done", taskId:"todo",
      progress:{ attemptId:`a${i}`, attempt:i + 1, retryOf:i ? `a${i - 1}` : undefined, status:"complete", model:"fixture", startedAt:1,
        steps:Array.from({ length:45 }, (_, j) => ({ label:`event ${j}`, at:j })) },
      toolCalls:Array.from({ length:130 }, (_, j) => ({ id:`call${j}`, name:"tool", arguments:"a".repeat(j ? 2 : 12001), status:"complete", result:"x".repeat(j ? 2 : 2001) }))
    }))
  ] };
  const snapshot = apiChatHarnessSnapshot(chat);
  assert.equal(snapshot.attempts.length, 45);
  assert.equal(snapshot.currentProblem.length, 4001);
  assert.equal(snapshot.attempts[0].toolCalls.length, 130);
  assert.equal(snapshot.attempts[0].toolCalls[0].arguments.length, 12001);
  assert.equal(snapshot.attempts[0].toolCalls[0].resultPreview.length, 2000);
  assert.equal(snapshot.attempts[0].toolCalls[0].resultTruncated, true);
  assert.equal(snapshot.attempts[0].progress.transitions.length, 45);
  assert.equal(apiChatHarnessSnapshot(chat, true).attempts[0].toolCalls[0].resultPreview.length, 2001);
  const directory = temporary(t), storage = new ChatHistoryStorage(directory);
  const packed = storage.pack(chat, { status:"completed", workerManager:false });
  const record = { schema:"pkm.agent.session/v1", sessionId, origin:"pkm-native", runtimeOwner:"pkm", hostKind:"pkm", nativeChat:packed };
  assert.deepEqual(apiChatSessionHarnessSnapshot(record, sessionId, directory), snapshot);
  assert.throws(() => apiChatSessionHarnessSnapshot(record, `agent_session_${"f".repeat(32)}`, directory), /matching/);
});

test("Action projection follows actual Run references and ownership without capability material", t => {
  const directory = temporary(t);
  const child = `action_run_${"e".repeat(32)}`, unrelated = `action_run_${"f".repeat(32)}`;
  const save = (id, extra) => {
    const folder = path.join(directory, "actions", "runs", id);
    fs.mkdirSync(folder, { recursive:true });
    fs.writeFileSync(path.join(folder, "run.json"), JSON.stringify({ schema:"pkm.action.run/v1", run_id:id, action_id:"fixture.script", state:"succeeded", capability_hash:"do-not-expose", checkpoint:{ resume_token:"also-private" }, ...extra }));
    return folder;
  };
  const folder = save(actionId);
  save(child, { parent_run_id:actionId }); save(unrelated);
  fs.mkdirSync(path.join(folder, "steps"));
  fs.writeFileSync(path.join(folder, "steps", `${"1".repeat(64)}.json`), JSON.stringify({ schema:"pkm.action.step-receipt/v1", key:"inspect", state:"completed", at:1 }));
  assert.deepEqual(recordedActionReferences(JSON.stringify({ content:[{ type:"text", text:JSON.stringify({ run_id:actionId }) }] })), [actionId]);
  assert.deepEqual(recordedActionReferences(`arbitrary text ${actionId}`), []);
  assert.deepEqual(recordedActionReferences('{"run_id":"../../private"}'), []);
  const projection = readHarnessActions(directory, [actionId]);
  assert.deepEqual(projection.actionRuns.map(run => run.runId).sort(), [actionId, child].sort());
  assert.equal(projection.actionRuns[0].steps[0].key, "inspect");
  assert(!JSON.stringify(projection).includes("do-not-expose"));
  assert(!JSON.stringify(projection).includes("also-private"));
  assert(readHarnessActions(directory, [`action_run_${"0".repeat(32)}`]).actionWarnings.length);
});

test("event feed reconciles revisions, timeout, pending listeners and disposal", async () => {
  const feed = new HarnessChangeFeed();
  assert.equal(await feed.wait(0), 1);
  const next = feed.wait(1);
  feed.changed();
  assert.equal(await next, 2);
  const alive = setTimeout(() => {}, 50);
  assert.equal(await feed.wait(2, 5), 2);
  clearTimeout(alive);
  const pending = feed.wait(2);
  feed.dispose(); assert.equal(await pending, 3);
  await assert.rejects(feed.wait(3), /closed/);
});

test("concurrent browser opens reuse one host and forwarding preserves the token fragment", async () => {
  const ts = require("typescript"), vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === "openNativeHarnessBrowser");
  let created = 0, disposed = 0, resolve;
  const opened = [], origins = [], servers = new Map(), context = { extensionPath:"fixture", subscriptions:[] };
  const server = { url:"http://127.0.0.1:9999/#token=fixture", allowOrigin:origin => origins.push(origin), dispose:() => disposed++ };
  const scope = vm.createContext({
    URL, nativeHarnessServers:servers, nativeHarnessAccess() {}, nativeHarnessRequest() {}, getStorePath:() => "/fixture",
    createNativeHarnessServer() { created++; return new Promise(done => { resolve = done; }); },
    log:{ warn:message => { throw new Error(message); } },
    vscode:{ Uri:{ parse:value => value }, env:{
      asExternalUri:async () => ({ toString:() => "https://forwarded.invalid/" }),
      openExternal:async url => { opened.push(url); return true; }
    } }
  });
  vm.runInContext(ts.transpileModule(fn.getText(ast), { compilerOptions:{ target:ts.ScriptTarget.ES2020 } }).outputText, scope);
  const first = scope.openNativeHarnessBrowser(context, sessionId), second = scope.openNativeHarnessBrowser(context, sessionId);
  assert.equal(created, 1);
  resolve(server);
  await Promise.all([first, second]);
  assert.deepEqual(opened, ["https://forwarded.invalid/#token=fixture", "https://forwarded.invalid/#token=fixture"]);
  assert.deepEqual(origins, ["https://forwarded.invalid", "https://forwarded.invalid"]);
  context.subscriptions[0].dispose();
  await Promise.resolve();
  assert.equal(disposed, 1); assert.equal(servers.size, 0);
});

test("the production watcher debounces browser events before checking panel visibility", () => {
  const ts = require("typescript"), vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  let initializer;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "queueProjectRefresh") initializer = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert(initializer);
  let changes = 0;
  const timers = new Set(), notifications = [];
  const panel = { visible:false, webview:{ postMessage:value => notifications.push(value) } };
  const scope = vm.createContext({
    path, getStorePath:() => "/fixture", panel, _panelReady:true, _projectStateRefreshTimer:undefined,
    projectScopes:new Set(), projectPaths:new Set(),
    nativeHarnessServers:new Map([["active", { server:{ changed() { changes++; } } }], ["starting", {}]]),
    setTimeout(callback) { const timer = { callback, unref() {} }; timers.add(timer); return timer; },
    clearTimeout:timer => timers.delete(timer),
  });
  vm.runInContext(ts.transpileModule(`globalThis.notify = ${initializer.getText(ast)};`, { compilerOptions:{ target:ts.ScriptTarget.ES2020 } }).outputText, scope);
  scope.notify("agentSessions", { fsPath:"/fixture/.pkm/state/agent-sessions/a.json" });
  scope.notify("recipeRuns", { fsPath:"/fixture/.pkm/state/recipe-runs/b.json" });
  assert.equal(timers.size, 1);
  const flush = () => { const queued = [...timers]; timers.clear(); queued.forEach(timer => timer.callback()); };
  flush();
  assert.equal(changes, 1); assert.equal(notifications.length, 0);
  panel.visible = true;
  scope.notify("agentSessions", { fsPath:"/fixture/.pkm/state/actions/runs/a/steps/b.json" });
  flush();
  assert.equal(changes, 2); assert.equal(notifications.length, 1);
  assert.equal(notifications[0].command, "projectStateChanged");
  assert.equal(notifications[0].data.changedPaths[0], ".pkm/state/actions/runs/a/steps/b.json");
});

test("browser transport is authenticated, Session-scoped, read-only and rechecks access after events", async t => {
  let allowed = true;
  const server = await createNativeHarnessServer({ extensionPath:path.join(__dirname, ".."), sessionId,
    access() { if (!allowed) throw new Error("Knowledge Root changed"); },
    async request(method) { return method === "snapshot" ? fixture() : "Full result"; } });
  t.after(() => server.dispose());
  const url = new URL(server.url), token = new URLSearchParams(url.hash.slice(1)).get("token");
  const api = (method, params = {}, headers = {}) => fetch(`${url.origin}/api`, { method:"POST",
    headers:{ Origin:url.origin, "Content-Type":"application/json", Authorization:`Bearer ${token}`, ...headers },
    body:JSON.stringify({ method, params }) });
  const html = await fetch(url.origin);
  assert.equal(html.status, 200);
  const content = await html.text();
  assert.equal((content.match(/<script nonce="[a-f0-9]+"/g) || []).length, 2);
  assert.match(html.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal((await fetch(`${url.origin}/agent-harness.js`)).status, 200);
  assert.equal((await fetch(`${url.origin}/extension.js`)).status, 404);
  assert.equal((await api("snapshot", {}, { Authorization:"Bearer wrong" })).status, 403);
  assert.equal((await api("snapshot", {}, { Origin:"https://untrusted.invalid" })).status, 403);
  assert.equal((await (await api("snapshot")).json()).data.sessionId, sessionId);
  assert.equal((await (await api("snapshot", { sessionId:"another" })).json()).ok, false);
  assert.equal((await (await api("execute")).json()).ok, false);
  const first = (await (await api("watch", { revision:0 })).json()).data.revision;
  const watching = api("watch", { revision:first });
  server.changed();
  const revision = (await (await watching).json()).data.revision;
  assert(revision > first);
  const waitingForRevocation = api("watch", { revision });
  await new Promise(resolve => setTimeout(resolve, 20));
  allowed = false;
  server.changed();
  assert.match((await (await waitingForRevocation).json()).error, /Root changed/);
  assert.match((await (await api("snapshot")).json()).error, /Root changed/);
});

test("live overview follows the deepest recorded active node and only explicit bindings", () => {
  const data = fixture(), model = build(data), overview = model.overview;
  assert.equal(overview.attempt.id, "a2");
  assert.equal(overview.attempt.retryOf, "a1");
  assert.deepEqual(overview.path.map(item => item.title), ["Implement and validate", "Development", "Debug", "Inspect evidence"]);
  for (const item of overview.path) assert(model.graphs.get(item.graphId).nodes.some(node => node.id === item.nodeId));
  assert.deepEqual(overview.recipes.map(item => [item.runId, item.source, item.available]), [[runId, "managed-task", true]]);
  assert.deepEqual(overview.actions.map(item => [item.runId, item.available, item.state]), [[actionId, true, "succeeded"]]);

  const plain = fixture();
  plain.todos = []; plain.runs = []; plain.actionRuns = [];
  plain.harness.state = "awaiting-input";
  plain.harness.currentPhase = { kind:"waiting", label:"Waiting for approval", status:"waiting" };
  plain.harness.waiting = { kind:"user", detail:"Waiting for approval" };
  plain.harness.attempts = [{ ...plain.harness.attempts[1], planning:undefined, status:"streaming",
    budgetReceipts:[{ round:0 }, { round:1 }], publicOutputs:[{ round:0, text:"a" }, { round:1, text:"b" }, { round:1, text:"c" }],
    toolCalls:[{ id:"wait", name:"ask_user", status:"running", arguments:"{}", resultPreview:"", resultCharacters:0, actionRunIds:["action_run_missing"] }] }];
  const live = build(plain).overview;
  assert.equal(live.waiting.kind, "user");
  assert.equal(live.attempt.preparedRounds, 2);
  assert.equal(live.attempt.publicRounds, 2);
  assert.equal(live.attempt.runningToolCalls, 1);
  assert.deepEqual(live.recipes, [], "no Recipe link is invented for a plain Chat");
  assert.deepEqual(live.actions.map(item => [item.available, item.graphId]), [[false, undefined]]);
  assert.deepEqual(live.path.slice(-2).map(item => item.title), ["ask_user", "Result pending"], "a streaming attempt resolves to its running tool call");
});

test("lifecycle ring highlights only the stage supported by recorded evidence", () => {
  const variant = (attempt, harness = {}, extra = {}) => {
    const data = fixture();
    Object.assign(data, { todos:[], runs:[], actionRuns:[], status:"running" }, extra);
    data.harness = { state:"running", currentProblem:"Goal", attempts:[{ messageId:"m", attemptId:"a", status:"streaming", toolCalls:[], ...attempt }], ...harness };
    return build(data).lifecycle;
  };
  const stage = (lifecycle, id) => lifecycle.stages.find(item => item.id === id).status;
  let l = variant({ toolCalls:[{ id:"c", name:"read", status:"running", actionRunIds:[] }] }, { currentPhase:{ kind:"tool", label:"Calling read" } });
  assert.deepEqual([l.current, l.outcome, stage(l, "configure")], ["run", "running", "visited"]);
  l = variant({}, { currentPhase:{ kind:"planning", label:"Preparing request" } });
  assert.equal(l.current, "configure");
  l = variant({}, { state:"awaiting-result", waiting:{ kind:"dependency", detail:"Polling AML job" } });
  assert.deepEqual([l.current, l.outcome, l.reason], ["monitor", "waiting", "Polling AML job"]);
  l = variant({ harnessReports:[{ id:"v", kind:"validation", status:"start", summary:"Running tests", binding:{} }] });
  assert.equal(l.current, "evaluate");
  l = variant({ status:"running" }, { state:"awaiting-input", waiting:{ kind:"user", detail:"Approve write" } });
  assert.deepEqual([l.current, l.outcome, l.waitingUser], ["run", "waiting", true]);
  assert.match(l.reason, /Waiting for you: Approve write/);
  l = variant({ status:"complete" }, { state:"completed" });
  assert.deepEqual([l.current, l.check, stage(l, "end"), stage(l, "evaluate"), stage(l, "monitor")], ["check", "unverified", "pending", "skipped", "skipped"]);
  l = variant({ status:"complete", harnessReports:[{ id:"v", kind:"validation", status:"complete", summary:"Tests pass", evidenceCallIds:["c"], binding:{} }] }, { state:"completed" });
  assert.deepEqual([l.current, l.check, stage(l, "evaluate")], ["end", "passed", "visited"]);
  l = variant({ status:"complete", harnessReports:[{ id:"v", kind:"validation", status:"failed", summary:"2 tests fail", evidenceCallIds:["c"], binding:{} }] }, { state:"completed" });
  assert.deepEqual([l.current, l.outcome, l.check], ["check", "failed", "failed"]);
  l = variant({ status:"failed", validation:{ error:"Model timed out" } }, { state:"failed" });
  assert.deepEqual([l.current, l.outcome, l.reason], ["run", "failed", "Model timed out"]);
  assert.equal(variant({}, {}, {}).stages.length, 6);
});
