#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lifecycle = require(path.join(root, "dist", "agent-session-lifecycle.js"));
const projectsSource = fs.readFileSync(path.join(root, "src", "webview", "panel", "15-projects.js"), "utf8");
const extensionSource = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const setting = packageJson.contributes.configuration.properties["personalKnowledge.agentSessionArchiveKeepLatestK"];

const escapeHtml = value => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const graphContext = {
  esc: escapeHtml, recipeAttribute: escapeHtml,
  agentSessionNodeState: state => state,
  agentSessionNodePositions: {}, selectedAgentSessionTodoId: '',
  agentSessionProgressDetails: () => '',
};
vm.createContext(graphContext);
const sourceStart = projectsSource.indexOf('function agentSessionRecipeSource(');
const sourceEnd = projectsSource.indexOf('\nfunction agentSessionUsageNumber(', sourceStart);
assert(sourceStart >= 0 && sourceEnd > sourceStart);
vm.runInContext(projectsSource.slice(sourceStart, sourceEnd), graphContext);
const libraryRun = { runId:'run_library', recipeId:'recipe_review', recipeName:'Review <patch>', recipeRevision:3, origin:{kind:'library'} };
const libraryLabel = graphContext.agentSessionRecipeSource(libraryRun);
assert.match(libraryLabel, /Recipe Library · Review &lt;patch> · r3/);
assert.match(libraryLabel, /Recipe ID: recipe_review/);
assert.match(libraryLabel, /Run ID: run_library/);
assert.match(graphContext.agentSessionRecipeSource({...libraryRun, origin:{kind:'agent-session-adhoc'}}), /Ad hoc Recipe/);
assert.match(graphContext.agentSessionRecipeSource({...libraryRun, origin:{kind:'future-source'}}), /Recipe source unknown/);
assert.match(graphContext.agentSessionRecipeSource({...libraryRun, origin:undefined}), /Recipe Library/);
const graphNode = graphContext.agentSessionUnifiedNode(libraryRun, {nodeId:'review', state:'pending'}, {todoId:'todo_review', title:'Review'}, {x:28,y:32});
assert.match(graphNode, /agent-session-recipe-source/);
assert.match(graphNode, /Recipe Library · Review &lt;patch> · r3/);

vm.runInContext(fs.readFileSync(path.join(root, 'src/webview/recipe-graph-shared.js'), 'utf8'), graphContext);
for (const [startName, endName] of [
  ['agentSessionTodoRunIds', 'agentSessionRecipeSource'],
  ['agentSessionUnifiedTodoNode', 'agentSessionLayoutUnifiedLinks'],
]) {
  const start = projectsSource.indexOf(`function ${startName}(`);
  const end = projectsSource.indexOf(`\nfunction ${endName}(`, start);
  assert(start >= 0 && end > start);
  vm.runInContext(projectsSource.slice(start, end), graphContext);
}
graphContext.agentSessionTodoUsage = () => '';
const branchingSession = {
  sessionId:'session_qps', task:'Optimize QPS', status:'running', traversalStrategy:'breadth-first',
  todos:['A', 'B1', 'B2'].map(todoId => ({todoId, title:todoId, status:'pending', recipeRunIds:[`run_${todoId}`]})),
  runs:['A', 'B1', 'B2'].map(todoId => ({...libraryRun, runId:`run_${todoId}`, nodes:[{nodeId:'experiment', state:'pending', dependsOn:[]}]})),
  recipeTreeEdges:['B1', 'B2'].map(todoId => ({fromRunId:'run_A', fromNodeId:'experiment', toRunId:`run_${todoId}`, toNodeId:'experiment'})),
};
const branchingGraph = graphContext.agentSessionUnifiedGraph(branchingSession);
assert.match(branchingGraph, /BFS execution queue/);
assert.match(branchingGraph, /Logical dependency tree/);
assert.match(branchingGraph, /data-queue-boundary="start"/);
assert.match(branchingGraph, /data-queue-boundary="stop"/);
assert.match(branchingGraph, /data-module-boundary="start"/);
assert.match(branchingGraph, /data-module-boundary="stop"/);
assert.match(projectsSource, /addStructuralEdge\(previousCard, todoCard, previousKey, todoId\)/, 'left-side Todos connect as an ordered queue');
assert.doesNotMatch(projectsSource, /data-edge-relation="task-branch"/, 'the Session root no longer branches to every Todo');
assert(branchingGraph.indexOf('data-todo-node="A"') < branchingGraph.indexOf('data-todo-node="B1"'));
assert(branchingGraph.indexOf('data-todo-node="B1"') < branchingGraph.indexOf('data-todo-node="B2"'));
function moduleAttributes(html, runId) {
  const tag = html.match(new RegExp(`<article[^>]*data-node-key="${runId}:experiment"[^>]*>`))[0];
  return {
    dependencies:JSON.parse(decodeURIComponent(tag.match(/data-tree-dependencies="([^"]*)"/)[1])),
    y:Number(tag.match(/top:(\d+)px/)[1]),
  };
}
const branchOne = moduleAttributes(branchingGraph, 'run_B1');
const branchTwo = moduleAttributes(branchingGraph, 'run_B2');
assert.deepStrictEqual(branchOne.dependencies, ['run_A:experiment']);
assert.deepStrictEqual(branchTwo.dependencies, ['run_A:experiment']);
assert.strictEqual(branchOne.y, branchTwo.y, 'serial experiments remain logical siblings on the same level');
assert(branchOne.y > moduleAttributes(branchingGraph, 'run_A').y);
const reversedQueue = graphContext.agentSessionUnifiedGraph({...branchingSession, todos:[branchingSession.todos[0], branchingSession.todos[2], branchingSession.todos[1]]});
assert.deepStrictEqual(moduleAttributes(reversedQueue, 'run_B2'), branchTwo, 'changing execution order cannot create Recipe dependencies');
const unlinkedGraph = graphContext.agentSessionUnifiedGraph({...branchingSession, recipeTreeEdges:[]});
assert.deepStrictEqual(moduleAttributes(unlinkedGraph, 'run_B2').dependencies, [], 'execution order alone is not a prerequisite');
const joinedGraph = graphContext.agentSessionUnifiedGraph({...branchingSession,
  todos:[...branchingSession.todos, {todoId:'Check',title:'Both Completed',status:'pending',recipeRunIds:['run_Check']}],
  runs:[...branchingSession.runs, {...libraryRun,runId:'run_Check',nodes:[{nodeId:'experiment',state:'pending',dependsOn:[]}]}],
  recipeTreeEdges:[...branchingSession.recipeTreeEdges,...['B1','B2'].map(todoId=>({fromRunId:`run_${todoId}`,fromNodeId:'experiment',toRunId:'run_Check',toNodeId:'experiment'}))],
});
assert.deepStrictEqual(moduleAttributes(joinedGraph,'run_Check').dependencies, ['run_B1:experiment','run_B2:experiment'], 'the right graph preserves real branch joins');
assert(moduleAttributes(joinedGraph,'run_Check').y > branchOne.y, 'the join is below both prerequisites');
const noRecipeSession = {...branchingSession, runs:[], recipeTreeEdges:[], todos:branchingSession.todos.map(todo => ({...todo,recipeRunIds:[]}))};
const noRecipeSnapshot = JSON.stringify(noRecipeSession);
const noRecipeGraph = graphContext.agentSessionUnifiedGraph(noRecipeSession);
assert.strictEqual((noRecipeGraph.match(/data-session-node=/g) || []).length, 1, 'there is one overall Session root');
assert.strictEqual((noRecipeGraph.match(/data-module-kind="todo"/g) || []).length, 3, 'every Todo without a Recipe still has one module');
assert.doesNotMatch(noRecipeGraph, /data-run-id=|Recipe Library/, 'visual Todo modules never invent Recipe Runs');
assert.match(noRecipeGraph, /data-node-key="todo:A"/);
assert.strictEqual(JSON.stringify(noRecipeSession), noRecipeSnapshot, 'fallback graph rendering does not mutate durable Session data');
assert.strictEqual((graphContext.agentSessionUnifiedGraph({...noRecipeSession,todos:[]}).match(/data-module-kind="todo"/g) || []).length, 1,
  'an unplanned Session task also remains visible as one module');
const panelCss = fs.readFileSync(path.join(root, 'src/webview/panel.css'), 'utf8');
assert.match(panelCss, /\.agent-session-unified-graph\{--recipe-graph-line:var\(--workflow-node-accent,#[a-f\d]+\)/, 'logical edges have a color even outside the Recipe editor');
assert.match(panelCss, /\.agent-session-unified-graph>\.agent-graph-arrow\{background:var\(--workflow-node-accent,#[a-f\d]+\)/, 'logical arrowheads have a matching fallback color');

assert.deepStrictEqual(
  { type: setting.type, default: setting.default, minimum: setting.minimum, maximum: setting.maximum },
  { type: "integer", default: 50, minimum: 1, maximum: 50 },
  "Trash retention setting keeps the compatible key and caps its range at 50",
);
assert.strictEqual(lifecycle.agentSessionArchiveKeepLatestK(undefined), 50);
assert.strictEqual(lifecycle.agentSessionArchiveKeepLatestK(0), 1);
assert.strictEqual(lifecycle.agentSessionArchiveKeepLatestK(2000), 50);
assert.strictEqual(lifecycle.agentSessionArchiveKeepLatestK(12.9), 12);
const observabilityNow = Date.parse("2026-04-01T00:10:00Z");
assert.deepStrictEqual(lifecycle.recipeNodeObservability({
  lastHeartbeatAt: "2026-04-01T00:09:50Z",
  lastProgressAt: "2026-04-01T00:05:00Z",
  progress: { staleAfterSeconds: 120 },
}, observabilityNow), {
  state: "intervention-required",
  recommendedAction: "checkpoint-cancel-or-reassign",
  heartbeatAgeSeconds: 10,
  progressAgeSeconds: 300,
  staleAfterSeconds: 120,
}, "fresh liveness does not hide stale meaningful progress");
assert.strictEqual(lifecycle.recipeNodeObservability({
  lastHeartbeatAt: "2026-04-01T00:09:50Z",
  lastProgressAt: "2026-04-01T00:05:00Z",
  progress: { staleAfterSeconds: 120, waitingOn: "human-gate" },
}, observabilityNow).state, "waiting", "explicit waits are not classified as stale");
const liveSession = {
  schema: "pkm.agent.session/v1",
  sessionId: "agent_session_liveness",
  status: "running",
  hostSessionId: "host-session",
  liveness: {
    owner: { transportId: "transport-hash", hostSessionId: "host-session" },
    heartbeatAt: "2026-04-01T00:08:00Z",
    leaseSeconds: 120,
  },
};
assert.deepStrictEqual(lifecycle.agentSessionLiveness(liveSession, false, observabilityNow), {
  state: "suspected-stalled",
  heartbeatAgeSeconds: 120,
  leaseSeconds: 120,
  ownerTransportId: "transport-hash",
  hostSessionId: "host-session",
});
assert.strictEqual(lifecycle.agentSessionLiveness(liveSession, true, observabilityNow).state, "waiting",
  "explicit Session waits must override a stale heartbeat");
liveSession.liveness.heartbeatAt = "2026-04-01T00:03:00Z";
assert.strictEqual(lifecycle.agentSessionLiveness(liveSession, false, observabilityNow).state, "suspected-interrupted");
liveSession.status = "completed";
assert.strictEqual(lifecycle.agentSessionLiveness(liveSession, false, observabilityNow).state, "inactive",
  "terminal Sessions never retain a live or suspected label");

const scratch = path.join(__dirname, `.agent-session-lifecycle-${process.pid}`);
const stateDirectory = path.join(scratch, ".pkm", "state");
const activeDirectory = path.join(stateDirectory, "agent-sessions");
const trashDirectory = path.join(stateDirectory, "agent-sessions-trash");
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(activeDirectory, { recursive: true });

function writeSession(id, status, updatedAt) {
  fs.writeFileSync(path.join(activeDirectory, `${id}.json`), JSON.stringify({
    schema: "pkm.agent.session/v1", sessionId: id, status, task: id, createdAt: updatedAt, updatedAt,
  }));
}

(async () => {
  try {
    writeSession("agent_session_oldest", "completed", "2026-01-01T00:00:00Z");
    writeSession("agent_session_middle", "completed", "2026-02-01T00:00:00Z");
    writeSession("agent_session_newest", "completed", "2026-03-01T00:00:00Z");
    writeSession("agent_session_running", "running", "2025-01-01T00:00:00Z");

    const result = await lifecycle.enforceAgentSessionArchiveRetention(stateDirectory, 2, () => "2026-04-01T00:00:00Z");
    assert.deepStrictEqual(result.retained, ["agent_session_newest", "agent_session_middle"], "the newest trashed Sessions remain recoverable");
    assert.deepStrictEqual(result.moved, ["agent_session_newest", "agent_session_middle", "agent_session_oldest"], "all completed Sessions move directly to Trash");
    assert.deepStrictEqual(result.deleted, ["agent_session_oldest"], "the oldest Trash overflow is removed");
    assert.ok(fs.existsSync(path.join(activeDirectory, "agent_session_running.json")), "active Sessions are never moved");
    assert.ok(!fs.existsSync(path.join(activeDirectory, "agent_session_newest.json")), "completed Sessions no longer remain in History");
    assert.ok(fs.existsSync(path.join(trashDirectory, "agent_session_newest.json")), "retention uses recoverable Trash");
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(trashDirectory, "agent_session_newest.json"))).trashedAt, "2026-04-01T00:00:00Z");
    assert.strictEqual(lifecycle.projectedAgentSessionStatus({
      status: "running",
      todos: [
        { status: "succeeded" },
        { status: "skipped" },
        { status: "failed" },
      ],
    }), "completed", "a legacy running Session with only terminal Todos projects as completed");
    assert.strictEqual(lifecycle.projectedAgentSessionStatus({
      status: "running",
      todos: [{ status: "succeeded" }, { status: "pending" }],
    }), "running", "unfinished Todo work keeps a Session running");
    assert.strictEqual(lifecycle.projectedAgentSessionStatus({ status: "running", todos: [] }), "running",
      "a running Session without a Todo plan is not inferred complete");
    const completedDlisSessionShape = {
      sessionId: "agent_session_c12b26b5288d0260f0a99d45",
      status: "running",
      todos: [
        { status: "succeeded" },
        { status: "succeeded" },
        { status: "succeeded" },
        { status: "skipped" },
        { status: "succeeded" },
        { status: "succeeded" },
        { status: "succeeded" },
      ],
    };
    assert.strictEqual(lifecycle.projectedAgentSessionStatus(completedDlisSessionShape), "completed",
      "the reported DLIS Session state shape projects as completed");
    writeSession("agent_session_stoppable", "running", "2026-03-15T00:00:00Z");
    const activeMappings = path.join(activeDirectory, "active");
    fs.mkdirSync(activeMappings, { recursive: true });
    fs.writeFileSync(path.join(activeMappings, "stoppable.json"), JSON.stringify({ sessionId: "agent_session_stoppable" }));
    fs.writeFileSync(path.join(activeMappings, "completed.json"), JSON.stringify({ sessionId: "agent_session_newest" }));
    fs.writeFileSync(path.join(activeMappings, "orphan.json"), JSON.stringify({ sessionId: "agent_session_missing" }));
    assert.strictEqual(await lifecycle.stopAgentSession(stateDirectory, "agent_session_stoppable", {
      reason: "user-requested", summary: "No work remains active.", now: () => "2026-04-01T12:00:00Z",
    }), 1, "stopping clears every active mapping to the Session");
    const stopped = JSON.parse(fs.readFileSync(path.join(activeDirectory, "agent_session_stoppable.json")));
    assert.strictEqual(stopped.status, "stopped");
    assert.strictEqual(stopped.stopReason, "user-requested");
    assert.strictEqual(stopped.stoppedAt, "2026-04-01T12:00:00Z");
    assert.strictEqual(lifecycle.terminalAgentSessionStatus(stopped), true, "stopped Sessions are terminal without being completed");
    const reconciliation = lifecycle.reconcileAgentSessionActiveMappings(stateDirectory);
    assert.deepStrictEqual(reconciliation, { retained: 0, removed: 2, errors: [] },
      "reconciliation removes completed and orphan mappings without touching a running mapping");

    await assert.rejects(
      lifecycle.moveAgentSessionToTrash(stateDirectory, "agent_session_running"),
      /Only completed or stopped Agent Sessions/,
      "quick/manual Trash refuses active Sessions",
    );
    assert.ok(fs.existsSync(path.join(trashDirectory, "agent_session_middle.json")), "completed Sessions enter Trash without a manual action");

    lifecycle.restoreAgentSessionFromTrash(stateDirectory, "agent_session_middle", () => "2026-04-03T00:00:00Z");
    const restored = JSON.parse(fs.readFileSync(path.join(activeDirectory, "agent_session_middle.json")));
    assert.strictEqual(restored.trashedAt, undefined, "restore clears Trash metadata");
    assert.strictEqual(restored.updatedAt, "2026-04-03T00:00:00Z", "restore updates the Session timestamp");
    assert.strictEqual(restored.restoredAt, restored.updatedAt, "explicit restore exempts the unchanged record from immediate automatic re-trashing");
    await lifecycle.enforceAgentSessionArchiveRetention(stateDirectory, 2);
    assert.ok(fs.existsSync(path.join(activeDirectory, "agent_session_middle.json")), "an explicitly restored Session stays available");
    await lifecycle.moveAgentSessionToTrash(stateDirectory, "agent_session_middle");
    lifecycle.permanentlyDeleteTrashedAgentSession(stateDirectory, "agent_session_middle");
    assert.ok(!fs.existsSync(path.join(trashDirectory, "agent_session_middle.json")), "explicit permanent delete still removes a Trash record");
    assert.ok(fs.existsSync(path.join(activeDirectory, "agent_session_running.json")), "Trash operations do not affect active Sessions");
    assert.strictEqual(lifecycle.emptyAgentSessionTrash(stateDirectory), 2, "Empty Trash reports the number of permanently deleted Session records");
    assert.deepStrictEqual(fs.readdirSync(trashDirectory), [], "Empty Trash removes every validated trashed Session record");
    assert.strictEqual(lifecycle.emptyAgentSessionTrash(stateDirectory), 0, "Empty Trash is idempotent when no Session records remain");

    const trashOnlyState = path.join(scratch, "trash-only");
    const cappedTrash = path.join(trashOnlyState, "agent-sessions-trash");
    fs.mkdirSync(cappedTrash, {recursive:true});
    for (let index = 0; index < 55; index++) {
      const sessionId = `agent_session_capped_${String(index).padStart(2, '0')}`;
      const timestamp = `2026-10-04T00:${String(index).padStart(2, '0')}:00Z`;
      fs.writeFileSync(path.join(cappedTrash, `${sessionId}.json`), JSON.stringify({
        schema:"pkm.agent.session/v1",sessionId,status:"completed",updatedAt:timestamp,trashedAt:timestamp,
      }));
    }
    const capped = await lifecycle.enforceAgentSessionArchiveRetention(trashOnlyState, 1000);
    assert.strictEqual(capped.retained.length, 50, 'Trash is capped at 50 even for a legacy setting greater than 50');
    assert.strictEqual(capped.deleted.length, 5, 'existing Trash is capped even when the active directory is absent');
    assert.ok(fs.existsSync(path.join(cappedTrash, 'agent_session_capped_54.json')), 'newest Trash entry survives');
    assert.ok(!fs.existsSync(path.join(cappedTrash, 'agent_session_capped_00.json')), 'oldest Trash entry is evicted');
    fs.writeFileSync(path.join(cappedTrash, 'agent_session_corrupt.json'), '{broken');
    const corrupt = await lifecycle.enforceAgentSessionArchiveRetention(trashOnlyState, 50);
    assert.strictEqual(corrupt.retained.length, 50, 'a malformed record does not hide healthy Trash');
    assert.strictEqual(corrupt.errors.length, 1, 'malformed Trash is reported rather than silently deleted');
    assert.ok(fs.existsSync(path.join(cappedTrash, 'agent_session_corrupt.json')), 'corrupt evidence is left untouched');

    const legacyState = path.join(scratch, 'legacy-created-at');
    fs.mkdirSync(path.join(legacyState, 'agent-sessions'), {recursive:true});
    fs.writeFileSync(path.join(legacyState, 'agent-sessions', 'agent_session_legacy.json'), JSON.stringify({
      schema:'pkm.agent.session/v1', sessionId:'agent_session_legacy', status:'completed', createdAt:'2026-01-01T00:00:00Z',
    }));
    const legacy = await lifecycle.enforceAgentSessionArchiveRetention(legacyState, 50);
    assert.deepStrictEqual(legacy.moved, ['agent_session_legacy'], 'a missing updatedAt is not mistaken for an explicit restore');

    const knowledgeSource = fs.readFileSync(path.join(root, 'src/webview/panel/20-knowledge.js'), 'utf8');
    assert.match(knowledgeSource, /dock.innerHTML = catTreeTrashDock\(/, 'Knowledge tabs use the same Trash renderer as Automation');
    const hostCaseStart = extensionSource.indexOf('    case "recipeTrash": {');
    const hostCaseEnd = extensionSource.indexOf('    case "recipeValidateDefinition": {', hostCaseStart);
    const deletedRecipes = [];
    const recipeTrash = [{recipeId:'global-trash',scope:'global'}, {recipeId:'project-trash',scope:'project'}];
    const responses = [];
    const hostContext = {
      currentProjectStore: () => ({list:()=>({recipeTrash}), deleteRecipeFromTrash:(_command, id)=>deletedRecipes.push(id)}),
      projectCommand:()=>({}), agentSessionProjectStateData:async()=>({recipeTrash}), respond:response=>responses.push(response),
    };
    vm.createContext(hostContext);
    const hostScript = ts.transpileModule(`async function handle(msg) { switch(msg.command) { ${extensionSource.slice(hostCaseStart, hostCaseEnd)} } }`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
    vm.runInContext(hostScript, hostContext);
    await hostContext.handle({command:'recipeTrash',action:'empty'});
    assert.deepStrictEqual(deletedRecipes, ['global-trash'], 'Recipe Delete All never deletes project-scoped Trash');
    assert.strictEqual(responses[0].command, 'projectState', 'Delete All refreshes the complete durable UI snapshot');

    assert.match(projectsSource, /class="agent-session-quick-trash"[^>]*title="Move archived Agent Session to Trash"/, "archived rows expose an obvious one-click Trash action");
    assert.match(projectsSource, /const list = agentSessionTree\(sessions\)/, "restored Sessions share the normal tree rather than an automatic History tier");
    assert.doesNotMatch(projectsSource, /Keep newest \$\{archiveKeepLatestK\}/, "the obsolete archive tier is no longer rendered");
    assert.match(projectsSource, /catTreeTrashDock\('Trash', trash.length, trashList, 'emptyAgentSessionTrash\(\)'\)/, "Agent Sessions has a fixed Delete All action");
    assert.match(projectsSource, /class="knowledge-trash-empty"[^>]*>Delete All<\/button>/, "Trash uses the Skills control styling");
    assert.match(projectsSource, /action:'restore'/, "Trash restore remains available");
    assert.match(projectsSource, /Delete Permanently/, "explicit permanent delete remains available");
    assert.match(projectsSource, /Empty Agent Sessions Trash\?/, "Empty Trash requires an explicit confirmation");
    assert.match(projectsSource, /action:'empty'/, "confirmed Empty Trash reaches the host lifecycle action");
    assert.doesNotMatch(projectsSource, /class="agent-session-trash-actions"/, "Delete All is in the shared fixed dock, not hidden in the popover");
    assert.match(projectsSource, /projectSnapshot\?\.agentSessionTrash\?\.length/, "Empty Trash confirmation reports the cached record count");
    assert.match(projectsSource, /Stop Session…/, "running Sessions expose an explicit non-success Stop action");
    assert.match(projectsSource, /status === 'completed' \|\| status === 'stopped'/, "completed and stopped Sessions can move to Trash");
    assert.match(projectsSource, /session\.status === 'running'/, "only running Sessions remain in the active CatTree section");
    assert.match(projectsSource, /function agentSessionNodeHealth/, "running modules derive a visible health classification");
    assert.match(projectsSource, /Do not skip active work/, "unsafe active modules explain why Skip is not safe");
    assert.match(projectsSource, /data-todo-id="\$\{esc\(ownerTodo\?\.todoId/, "Recipe modules carry durable Todo ownership");
    assert.match(projectsSource, /function agentSessionFullscreenGraph/, "large Session Recipes provide a full-screen graph");
    assert.match(projectsSource, /function agentSessionUnifiedGraph/, "full-screen mode renders one graph for the entire Agent Session");
    assert.match(projectsSource, /function agentSessionOwnedRuns/, "full-screen Todo lanes include nested child Recipe runs");
    assert.match(projectsSource, /class="agent-session-unified-session"/, "full-screen mode exposes one Session root in the Todo plane");
    assert.match(projectsSource, /class="agent-session-recipe-tree"/, "all modules render in one global Recipe tree");
    assert.match(projectsSource, /class="agent-session-recipe-subtree/, "Todo ownership is projected as an overlay without splitting the global tree");
    assert.match(projectsSource, /Todo execution order/, "the left lane is labeled as an execution queue rather than a dependency tree");
    assert.match(projectsSource, /breadth-first[\s\S]{0,160}BFS[\s\S]{0,160}depth-first[\s\S]{0,160}DFS/,
      "the Todo traversal label reflects persisted BFS or DFS strategy instead of guessing");
    assert.match(projectsSource, /data-structure-source=/, "Session/Todo ownership links carry stable identities");
    assert.match(projectsSource, /class="agent-session-structure-edge"/, "Todo-level links render without module arrow heads");
    assert.match(projectsSource, /class="agent-session-ownership-edge"/, "Todo-to-Recipe ownership is visible as a structural link");
    assert.match(projectsSource, /data-todo-status="\$\{esc\(status\)\}"/, "Todo cards expose only their durable lifecycle status");
    assert.match(projectsSource, /data-recipe-statuses="\$\{esc\(statuses\)\}"/, "Recipe subtree overlays expose runtime status separately from Todo status");
    assert.match(projectsSource, /state\.tab !== 'agentSessions'[\s\S]{0,220}ask\('projectState', \{\}, null, true\)/,
      "visible Agent Sessions poll durable state silently so terminal Todo transitions do not remain stale");
    assert.match(projectsSource, /agentSessionSnapshotSignature\(snapshot\) !== agentSessionSnapshotSignature\(projectSnapshot\)/,
      "silent polling compares durable Agent Session state before replacing interactive DOM");
    assert.match(projectsSource, /if \(!agentSessionStateChanged\) return;/,
      "unchanged silent poll responses preserve live focus and pointer targets");
    assert.match(projectsSource, /function agentSessionLayoutUnifiedLinks/, "the unified graph owns one validated edge layer");
    assert.match(projectsSource, /data-edge-source=/, "each full-screen arrow records its rendered source module");
    assert.match(projectsSource, /data-edge-target=/, "each full-screen arrow records its rendered target module");
    assert.match(projectsSource, /function agentSessionGraphPanStart/, "full-screen graphs support pan gestures");
    assert.match(projectsSource, /function agentSessionNodeDragStart/, "full-screen graph modules support persisted dragging");
    assert.match(projectsSource, /function agentSessionGraphReorganize/, "full-screen graph can restore organized positions");
    assert.match(projectsSource, /function agentSessionSelectTodo/, "selecting a Todo highlights its owned modules");
    assert.match(projectsSource, /focusedIdentity/, "Session refresh restores the focused module by stable identity");
    assert.match(projectsSource, /agentSessionOpenRunIds/, "expanded Recipe runs persist across refresh");
    assert.match(extensionSource, /lastHeartbeatAt/, "Agent Session projection includes durable heartbeat data");
    assert.match(extensionSource, /liveness: agentSessionLiveness\(session, waiting\)/,
      "Agent Session projection includes Session-level lease health");
    assert.match(projectsSource, /Suspected stalled[\s\S]*Suspected interrupted/,
      "Agent Session UI distinguishes stalled and interrupted suspicion without changing lifecycle status");
    assert.match(extensionSource, /progress: record\.progress/, "Agent Session projection includes structured module progress");
    assert.match(extensionSource, /await applyAgentSessionArchiveRetention\(\)/, "state projection waits for retention before reading");
    assert.match(extensionSource, /"agentSessionTrash", "agentSessionStop"\]\.includes/, "file failures are returned to the Agent Sessions UI");
    console.log("agent-session lifecycle tests passed");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
