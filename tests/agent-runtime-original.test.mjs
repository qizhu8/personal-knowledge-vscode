import test from "node:test";
import assert from "node:assert/strict";
import { compileFunction } from "node:vm";
import * as original from "../dist/domain/agent-runtime-original.js";
import { agentRuntimeGroup } from "../dist/domain/agent-runtime-policy.js";
import { originalAgentRuntimeRegressions } from "./agent-runtime-original-capture.mjs";

function runOriginal(source, context) {
  compileFunction(source, Object.keys(context))(...Object.values(context));
}

test("exact original session group assertions and native group identity parity", () => {
  runOriginal(originalAgentRuntimeRegressions.groups, { assert, lifecycle: original });
  assert.equal(agentRuntimeGroup("synthetic-owner"),
    original.agentSessionGroup({ hostKind: "pkm", hostSessionId: "synthetic-owner" }).groupId);
  assert.equal(original.pkmOwnedAgentSession({ origin: "pkm-native", runtimeOwner: "pkm", hostKind: "pkm" }), true);
  assert.equal(original.pkmOwnedAgentSession({ origin: "external", runtimeOwner: "pkm", hostKind: "pkm" }), false);
  assert.equal(original.projectedAgentSessionStatus({ status: "running", todos: [{ status: "succeeded" }] }), "completed");
  assert.equal(original.terminalAgentSessionStatus({ status: "stopped" }), true);
  const liveness = original.agentSessionLiveness({ status: "running", updatedAt: "2026-01-01T00:00:00Z" }, false, Date.parse("2026-01-01T00:16:00Z"));
  assert.equal(liveness.state, "suspected-interrupted");
});

test("exact original descendant and limit assertions on a synthetic recursive tree", () => {
  const root = "synthetic-root";
  const workers = [{ chatId: "synthetic-a", parentChatId: root }, { chatId: "synthetic-b", parentChatId: root }];
  const grandchild = { chatId: "synthetic-c", parentChatId: workers[0].chatId };
  const slots = [...workers, grandchild];
  runOriginal(originalAgentRuntimeRegressions.hierarchy, {
    assert, root, workers, grandchild, id: "synthetic-tree",
    store: { members: () => slots }, workerIsDescendant: original.workerIsDescendant, workerLimits: original.workerLimits,
  });
  assert.throws(() => original.workerIsDescendant([
    { chatId: "a", parentChatId: "b" }, { chatId: "b", parentChatId: "a" },
  ], "outside", "a"), /cycle/);
  assert.equal(original.workerIsDescendant([{ chatId: "b", parentChatId: "a", released: true }], "a", "b"), false);
});

test("exact original Portal endpoint validation assertions without pairing or remote execution", () => {
  const local = { endpointId: "synthetic-endpoint", name: "Synthetic", deleted: false, revision: 1 };
  runOriginal(originalAgentRuntimeRegressions.portal, { assert, f: { a: { local } }, parsePortalEndpointIdentity: original.parsePortalEndpointIdentity });
  assert.deepEqual(original.parsePortalEndpointIdentity({ ...local, acceptsIncoming: false }), { ...local, acceptsIncoming: false });
});

test("exact original snapshot recovery assertions: remap hierarchy, clear receipts, disarm work without mutating source", () => {
  const parentRunId = "recipe_run_parent0001", childRunId = "recipe_run_child00001";
  const sessionId = "agent_session_synthetic_source";
  const pkmContents = {
    snapshotId: "agent_snapshot_synthetic_original",
    session: {
      recipeRunIds: [parentRunId],
      todos: [
        { todoId: "todo_done", title: "Inspect", status: "succeeded" },
        { todoId: "todo_work", title: "Implement", status: "running", startedAt: "t", recipeRunId: parentRunId, recipeRunIds: [parentRunId] },
      ],
      checkpoints: [{ checkpointId: "checkpoint_1", sequence: 1, reason: "handoff", createdAt: "t", state: { summary: "Half way" } }],
    },
    recipeRuns: [
      { runId: parentRunId, recipeName: "Parent", receipts: { synthetic: true },
        nodes: { done: { state: "succeeded" }, nested: { state: "running", childRunId, startedAt: "t" } } },
      { runId: childRunId, recipeName: "Child", receipts: { synthetic: true }, parent: { runId: parentRunId, nodeId: "nested" }, nodes: { step: { state: "running" } } },
    ],
  };
  const pkmCreated = { snapshot: { snapshotId: pkmContents.snapshotId, magicCode: "PKM-SNAP-SYNTHETIC", sourceSessionId: sessionId } };
  const before = JSON.stringify(pkmContents);
  runOriginal(originalAgentRuntimeRegressions.recovery, {
    assert, snapshots: original, pkmContents, pkmCreated, parentRunId, childRunId, sessionId,
  });
  assert.equal(JSON.stringify(pkmContents), before);
  const continuation = original.agentSnapshotRecovery({ ...pkmContents, session: { todos: [{ status: "succeeded" }] } },
    pkmCreated.snapshot, "agent_session_new", "2026-10-20T00:00:00Z", "synthetic-key");
  assert.equal(continuation.continuationTodoCreated, true);
  assert.equal(continuation.session.todos[1].actionType, "resume_snapshot");
});
