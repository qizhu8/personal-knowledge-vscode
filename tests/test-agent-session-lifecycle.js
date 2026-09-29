#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lifecycle = require(path.join(root, "dist", "agent-session-lifecycle.js"));
const projectsSource = fs.readFileSync(path.join(root, "src", "webview", "panel", "15-projects.js"), "utf8");
const extensionSource = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const setting = packageJson.contributes.configuration.properties["personalKnowledge.agentSessionArchiveKeepLatestK"];

assert.deepStrictEqual(
  { type: setting.type, default: setting.default, minimum: setting.minimum, maximum: setting.maximum },
  { type: "integer", default: 50, minimum: 1, maximum: 1000 },
  "archive retention setting has the required persisted default and safe range",
);
assert.strictEqual(lifecycle.agentSessionArchiveKeepLatestK(undefined), 50);
assert.strictEqual(lifecycle.agentSessionArchiveKeepLatestK(0), 1);
assert.strictEqual(lifecycle.agentSessionArchiveKeepLatestK(2000), 1000);
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
    assert.deepStrictEqual(result.retained, ["agent_session_newest", "agent_session_middle"], "newest completed Sessions are retained by updatedAt");
    assert.deepStrictEqual(result.moved, ["agent_session_oldest"], "only completed overflow moves to Trash");
    assert.ok(fs.existsSync(path.join(activeDirectory, "agent_session_running.json")), "active Sessions are never moved");
    assert.ok(fs.existsSync(path.join(trashDirectory, "agent_session_oldest.json")), "retention uses recoverable Trash");
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(trashDirectory, "agent_session_oldest.json"))).trashedAt, "2026-04-01T00:00:00Z");
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
    await lifecycle.moveAgentSessionToTrash(stateDirectory, "agent_session_middle", { now: () => "2026-04-02T00:00:00Z" });
    assert.ok(fs.existsSync(path.join(trashDirectory, "agent_session_middle.json")), "manual archived-row action moves to Trash");

    lifecycle.restoreAgentSessionFromTrash(stateDirectory, "agent_session_middle", () => "2026-04-03T00:00:00Z");
    const restored = JSON.parse(fs.readFileSync(path.join(activeDirectory, "agent_session_middle.json")));
    assert.strictEqual(restored.trashedAt, undefined, "restore clears Trash metadata");
    assert.strictEqual(restored.updatedAt, "2026-04-03T00:00:00Z", "restored Session becomes the newest archive entry");
    await lifecycle.moveAgentSessionToTrash(stateDirectory, "agent_session_middle");
    lifecycle.permanentlyDeleteTrashedAgentSession(stateDirectory, "agent_session_middle");
    assert.ok(!fs.existsSync(path.join(trashDirectory, "agent_session_middle.json")), "explicit permanent delete still removes a Trash record");
    assert.ok(fs.existsSync(path.join(activeDirectory, "agent_session_running.json")), "Trash operations do not affect active Sessions");
    assert.strictEqual(lifecycle.emptyAgentSessionTrash(stateDirectory), 1, "Empty Trash reports the number of permanently deleted Session records");
    assert.deepStrictEqual(fs.readdirSync(trashDirectory), [], "Empty Trash removes every validated trashed Session record");
    assert.strictEqual(lifecycle.emptyAgentSessionTrash(stateDirectory), 0, "Empty Trash is idempotent when no Session records remain");

    assert.match(projectsSource, /class="agent-session-quick-trash"[^>]*title="Move archived Agent Session to Trash"/, "archived rows expose an obvious one-click Trash action");
    assert.match(projectsSource, /agentSessionTree\(archivedSessions, true\)/, "quick Trash is rendered only for archived Sessions");
    assert.match(projectsSource, /Keep newest \$\{archiveKeepLatestK\}/, "Agent Sessions UI surfaces the configured retention count");
    assert.match(projectsSource, /action:'restore'/, "Trash restore remains available");
    assert.match(projectsSource, /Delete Permanently/, "explicit permanent delete remains available");
    assert.match(projectsSource, /Empty Agent Sessions Trash\?/, "Empty Trash requires an explicit confirmation");
    assert.match(projectsSource, /action:'empty'/, "confirmed Empty Trash reaches the host lifecycle action");
    assert.match(projectsSource, /class="agent-session-trash-actions"/, "Agent Sessions Trash exposes a visible Empty Trash action");
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
    assert.match(projectsSource, /Materialized Todo order/, "the left lane is labeled as a materialized traversal queue");
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
