#!/usr/bin/env node
// PKM-only Agent Sessions: external Sessions retire to Trash, Snapshots capture whole PKM Recipe trees,
// any agent can read a Snapshot through MCP, and recovery creates a new PKM Chat with remapped state.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Module = require("node:module");

const root = path.join(__dirname, "..");
const lifecycle = require(path.join(root, "dist", "agent-sessions", "agent-session-lifecycle.js"));
const snapshots = require(path.join(root, "dist", "agent-sessions", "agent-snapshots.js"));
const originalLoad = Module._load;
let ApiChatStore;
try {
  Module._load = function(name, ...args) {
    return name === "vscode" ? { workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) } } : originalLoad.call(this, name, ...args);
  };
  ({ ApiChatStore } = require(path.join(root, "dist", "chat", "api-chat-store.js")));
} finally { Module._load = originalLoad; }

const python = process.env.PKM_TEST_PYTHON || (fs.existsSync("/home/yuwang8/miniconda3/bin/python") ? "/home/yuwang8/miniconda3/bin/python" : "python3");
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));

function readSnapshotWithPython(store, magicCode) {
  const script = `
import json, pathlib, sys
sys.path.insert(0, ${JSON.stringify(path.join(root, "resources"))})
import agent_session_runtime as runtime
class FakeMcp:
    def tool(self, annotations=None):
        return lambda function: function
tools = runtime.register_agent_session_tools(FakeMcp(), pathlib.Path(sys.argv[1]))
assert set(tools) == {"agent_session_capabilities", "agent_session_snapshot_list", "agent_session_snapshot_read"}, sorted(tools)
print(json.dumps(tools["agent_session_snapshot_read"](sys.argv[2].lower(), 2)))
`;
  return JSON.parse(execFileSync(python, ["-c", script, store, magicCode], { encoding: "utf8" }));
}

(async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-agent-session-pkm-only-"));
  const state = path.join(store, ".pkm", "state");
  try {
    const chats = new ApiChatStore(state, "0123456789abcdef");

    // A PKM Chat Task with a conversation and a nested Recipe tree.
    const chat = chats.create();
    chat.title = "Source PKM Chat";
    chat.messages = [{ id: "m-user", role: "user", status: "complete", content: "Migrate the dashboard" }];
    chats.save(chat);
    chats.startTask(chat, "Migrate dashboard");
    const sessionId = chat.sessionId;
    // The Snapshot is taken while a reply is still streaming with a running tool call.
    chat.messages.push({ id: "m-assistant", role: "assistant", status: "streaming", content: "Working on it", taskId: sessionId,
      delegations: [{ id: "d" }], toolCalls: [{ id: "call-1", name: "run_process", arguments: "{}", status: "running" }] });
    chats.save(chat);
    assert.match(sessionId, /^agent_session_/);
    const sessionPath = path.join(state, "agent-sessions", `${sessionId}.json`);
    const pkmSession = readJson(sessionPath);
    assert.equal(lifecycle.pkmOwnedAgentSession(pkmSession), true, "PKM Chat Tasks are PKM-owned Agent Sessions");

    const parentRunId = "recipe_run_parent0001", childRunId = "recipe_run_child00001";
    writeJson(path.join(state, "recipe-runs", `${parentRunId}.json`), {
      schema: "pkm.recipe.run/v1", runId: parentRunId, recipeId: "recipe_parent", recipeName: "Parent", status: "running",
      receipts: { secret: "receipt" },
      nodes: { done: { state: "succeeded" }, nested: { state: "running", childRunId, startedAt: "t" } },
    });
    writeJson(path.join(state, "recipe-runs", `${childRunId}.json`), {
      schema: "pkm.recipe.run/v1", runId: childRunId, recipeId: "recipe_child", recipeName: "Child", status: "running",
      parent: { runId: parentRunId, nodeId: "nested" }, receipts: { secret: "receipt" },
      nodes: { step: { state: "running" } },
    });
    writeJson(sessionPath, { ...pkmSession,
      recipeRunIds: [parentRunId],
      todos: [
        { todoId: "todo_done", title: "Inspect", status: "succeeded" },
        { todoId: "todo_work", title: "Implement", status: "running", startedAt: "t", recipeRunId: parentRunId, recipeRunIds: [parentRunId] },
      ],
      checkpoints: [{ checkpointId: "checkpoint_1", sequence: 1, reason: "handoff", createdAt: "t", state: { summary: "Half way" } }],
    });

    // An external host Session with an MCP transport mapping, as written by the retired MCP runtime.
    const externalId = "agent_session_external0001";
    writeJson(path.join(state, "agent-sessions", `${externalId}.json`), {
      schema: "pkm.agent.session/v1", sessionId: externalId, status: "running", task: "Copilot task",
      hostKind: "copilot", hostSessionId: "copilot-chat", agent: { name: "Copilot", product: "GitHub Copilot" },
      todos: [{ todoId: "todo_external", title: "External work", status: "paused" }],
      checkpoints: [{ checkpointId: "checkpoint_ext", sequence: 1, createdAt: "t", state: { summary: "External progress", next_actions: ["Finish"] } }],
      createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
    });
    writeJson(path.join(state, "agent-sessions", "active", "transport.json"), { sessionId: externalId });

    // Snapshots: PKM capture includes the whole Recipe tree and the conversation; external has neither.
    const pkmCreated = snapshots.createAgentSnapshot(store, sessionId, "handoff");
    const externalCreated = snapshots.createAgentSnapshot(store, externalId, "handoff");
    assert.match(pkmCreated.recoveryPrompt, /agent_session_snapshot_read/);
    assert.doesNotMatch(pkmCreated.recoveryPrompt, /snapshot_recover/);
    assert.equal(pkmCreated.snapshot.sourceHostKind, "pkm");
    assert.equal(externalCreated.snapshot.sourceHostKind, "copilot");
    const pkmContents = snapshots.readAgentSnapshotContents(store, pkmCreated.snapshot.snapshotId);
    assert.deepEqual(pkmContents.recipeRuns.map(run => run.runId).sort(), [childRunId, parentRunId], "child runs reached only through nodes are captured");
    assert(pkmContents.recipeRuns.every(run => run.receipts === undefined), "receipts are never captured");
    assert.equal(snapshots.readAgentSnapshotContents(store, externalCreated.snapshot.snapshotId).recipeRuns.length, 0);

    // Any agent can read a Snapshot through the read-only MCP runtime (cross-language payload format).
    const pkmRead = readSnapshotWithPython(store, pkmCreated.snapshot.magicCode);
    assert.equal(pkmRead.read_only, true);
    assert.equal(pkmRead.source, "pkm-chat");
    assert.equal(pkmRead.conversation.message_count, 2);
    assert.equal(pkmRead.conversation.recent_messages.length, 2);
    assert.deepEqual(pkmRead.recipe_runs.map(run => run.runId).sort(), [childRunId, parentRunId]);
    assert.equal(pkmRead.latest_checkpoint_state.summary, "Half way");
    const externalRead = readSnapshotWithPython(store, externalCreated.snapshot.magicCode);
    assert.equal(externalRead.source, "external-agent");
    assert.equal(externalRead.recipe_runs, undefined, "external Snapshots carry no Recipes");
    assert.equal(externalRead.conversation, undefined, "external Snapshots carry no conversation");
    assert.equal(readJson(sessionPath).status, pkmSession.status, "reading a Snapshot never changes Session state");

    // Retire external Sessions: mappings are removed, records move to Trash, PKM Sessions stay, idempotent.
    const retired = await lifecycle.retireNonPkmAgentSessions(state, () => "2026-10-20T00:00:00Z");
    assert.deepEqual(retired, { moved: [externalId], errors: [] });
    assert.deepEqual(fs.readdirSync(path.join(state, "agent-sessions", "active")), []);
    assert(!fs.existsSync(path.join(state, "agent-sessions", `${externalId}.json`)));
    assert(fs.existsSync(path.join(state, "agent-sessions-trash", `${externalId}.json`)));
    assert(fs.existsSync(sessionPath), "PKM Chat Sessions are never retired");
    assert.deepEqual(await lifecycle.retireNonPkmAgentSessions(state), { moved: [], errors: [] });
    assert.throws(() => lifecycle.restoreAgentSessionFromTrash(state, externalId), /Only PKM Chat Sessions can be restored/);
    lifecycle.permanentlyDeleteTrashedAgentSession(state, externalId);
    assert(!fs.existsSync(path.join(state, "agent-sessions-trash", `${externalId}.json`)));

    // Pure recovery remapping.
    const recovery = snapshots.agentSnapshotRecovery(pkmContents, pkmCreated.snapshot, "agent_session_target", "2026-10-20T00:00:00Z", "key");
    const remapped = Object.fromEntries(recovery.recipeRuns.map(run => [run.recipeName, run]));
    assert.notEqual(remapped.Parent.runId, parentRunId);
    assert.deepEqual(recovery.session.recipeRunIds, [remapped.Parent.runId]);
    assert.deepEqual(remapped.Parent.nodes.nested, { state: "pending", childRunId: remapped.Child.runId }, "running nodes restart and keep the remapped child");
    assert.equal(remapped.Parent.nodes.done.state, "succeeded");
    assert.equal(remapped.Child.parent.runId, remapped.Parent.runId);
    assert.equal(remapped.Child.nodes.step.state, "pending");
    assert(recovery.recipeRuns.every(run => run.agentSessionId === "agent_session_target" && Object.keys(run.receipts).length === 0));
    const work = recovery.session.todos.find(todo => todo.todoId === "todo_work");
    assert.equal(work.status, "pending");
    assert.equal(work.startedAt, undefined);
    assert.equal(work.recipeRunId, remapped.Parent.runId);
    assert.equal(recovery.continuationTodoCreated, false);
    assert.deepEqual(recovery.session.provenance, { kind: "agent-snapshot", snapshotId: pkmCreated.snapshot.snapshotId,
      magicCode: pkmCreated.snapshot.magicCode, sourceSessionId: sessionId });
    assert.equal(snapshots.agentSnapshotRecovery(pkmContents, pkmCreated.snapshot, "agent_session_target", "now", "key").recipeRuns[0].runId,
      recovery.recipeRuns[0].runId, "run ids are deterministic for a recovery key");

    // Recover the PKM Snapshot into a new PKM Chat.
    const recovered = chats.recoverAgentSnapshot(pkmCreated.snapshot, pkmContents);
    assert.notEqual(recovered.id, chat.id);
    assert.notEqual(recovered.sessionId, sessionId);
    assert.match(recovered.title, /\(recovered\)$/);
    assert.deepEqual(recovered.messages.slice(0, 2).map(message => message.id), ["m-user", "m-assistant"]);
    assert.equal(recovered.messages[1].status, "interrupted");
    assert.equal(recovered.messages[1].delegations, undefined);
    assert.equal(recovered.messages[1].toolCalls[0].status, "failed");
    assert.match(recovered.messages.at(-1).content, new RegExp(pkmCreated.snapshot.magicCode));
    assert.match(recovered.messages.at(-1).content, /Restored 2 earlier message\(s\) and 2 Recipe run\(s\)/);
    const recoveredSession = readJson(path.join(state, "agent-sessions", `${recovered.sessionId}.json`));
    assert.equal(lifecycle.pkmOwnedAgentSession(recoveredSession), true);
    assert.equal(recoveredSession.provenance.snapshotId, pkmCreated.snapshot.snapshotId);
    assert.equal(recoveredSession.todos.find(todo => todo.todoId === "todo_work").status, "pending");
    for (const runId of recoveredSession.recipeRunIds) {
      const run = readJson(path.join(state, "recipe-runs", `${runId}.json`));
      assert.equal(run.agentSessionId, recovered.sessionId);
    }
    assert.equal(readJson(path.join(state, "recipe-runs", `${parentRunId}.json`)).receipts.secret, "receipt", "the source runs are untouched");
    const reloaded = new ApiChatStore(state, "0123456789abcdef").load(recovered.id);
    assert.equal(reloaded.messages.length, recovered.messages.length, "the recovered Chat persists");

    // External Snapshots recover their task/todos/checkpoints only, with a continuation of the unfinished work.
    const externalContents = snapshots.readAgentSnapshotContents(store, externalCreated.snapshot.snapshotId);
    const externalChat = chats.recoverAgentSnapshot(externalCreated.snapshot, externalContents);
    assert.equal(externalChat.messages.length, 1);
    assert.match(externalChat.messages[0].content, /external agent/);
    assert.match(externalChat.messages[0].content, /External progress/);
    const externalRecovered = readJson(path.join(state, "agent-sessions", `${externalChat.sessionId}.json`));
    assert.equal(lifecycle.pkmOwnedAgentSession(externalRecovered), true, "recovered external work becomes a PKM Chat Session");
    assert.deepEqual(externalRecovered.recipeRunIds, []);
    assert.equal(externalRecovered.todos.find(todo => todo.todoId === "todo_external").status, "pending");
    // A failed recovery leaves no Chat, Task, or cloned run behind.
    const chatCount = chats.list(true).length;
    const sessionFiles = () => fs.readdirSync(path.join(state, "agent-sessions")).filter(name => name.endsWith(".json")).sort();
    const runFiles = () => fs.readdirSync(path.join(state, "recipe-runs")).sort();
    const sessionsBefore = sessionFiles(), runsBefore = runFiles();
    const originalWrite = fs.writeFileSync;
    let clonedRuns = 0;
    fs.writeFileSync = function(file, ...args) {
      if (String(file).includes(`${path.sep}recipe-runs${path.sep}`) && ++clonedRuns === 2) throw new Error("disk full");
      return originalWrite.call(this, file, ...args);
    };
    try { assert.throws(() => chats.recoverAgentSnapshot(pkmCreated.snapshot, pkmContents), /disk full/); }
    finally { fs.writeFileSync = originalWrite; }
    assert.equal(clonedRuns, 2, "the failure happened after one run had been cloned");
    assert.equal(chats.list(true).length, chatCount, "the partial Chat is removed");
    assert.deepEqual(sessionFiles(), sessionsBefore, "the partial Task Session is removed");
    assert.deepEqual(runFiles(), runsBefore, "cloned runs are removed");

    // Retention never evicts restorable PKM Chat Sessions to keep retired external records.
    const retentionState = path.join(store, "retention-state");
    for (let index = 0; index < 2; index++) writeJson(path.join(retentionState, "agent-sessions-trash", `agent_session_pkmtrash${index}.json`), {
      schema: "pkm.agent.session/v1", sessionId: `agent_session_pkmtrash${index}`, status: "completed", origin: "pkm-native", runtimeOwner: "pkm", hostKind: "pkm",
      updatedAt: `2026-01-0${index + 1}T00:00:00Z`, trashedAt: `2026-01-0${index + 1}T00:00:00Z` });
    for (let index = 0; index < 3; index++) writeJson(path.join(retentionState, "agent-sessions", `agent_session_ext${index}.json`), {
      schema: "pkm.agent.session/v1", sessionId: `agent_session_ext${index}`, status: "running", hostKind: "copilot", updatedAt: "2026-02-01T00:00:00Z" });
    assert.equal((await lifecycle.retireNonPkmAgentSessions(retentionState, () => "2026-10-20T00:00:00Z")).moved.length, 3);
    const retention = await lifecycle.enforceAgentSessionArchiveRetention(retentionState, 3);
    assert.deepEqual(retention.retained.slice(0, 2).sort(), ["agent_session_pkmtrash0", "agent_session_pkmtrash1"]);
    assert.equal(retention.deleted.length, 2);
    assert(retention.deleted.every(id => id.startsWith("agent_session_ext")), "only non-restorable external records are evicted");

    console.log("PKM-only Agent Sessions: retirement, Snapshot tree capture, cross-language read, and PKM Chat recovery OK");
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
