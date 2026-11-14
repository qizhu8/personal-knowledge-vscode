import { createHash } from "node:crypto";
import type { LegacySnapshotRestorePayload } from "../legacy-snapshot-restore-contracts.js";

const sha = (value: string, length: number) => createHash("sha256").update(value).digest("hex").slice(0, length);
/**
 * Source-qualified subset of agentSnapshotRecovery in src/agent-sessions/agent-snapshots.ts.
 * Running work is reset as DATA only; no reset receipt licenses execution.
 */
export function legacySnapshotRecovery(payload: LegacySnapshotRestorePayload, snapshotId: string,
  sourceSessionId: string, sessionId: string, now: string, recoveryKey: string) {
  const source = payload.session;
  const runIds = new Map(payload.recipeRuns.map(run => [run.runId, `recipe_run_${sha(`${run.runId}:${recoveryKey}`, 24)}`]));
  const map = (id: string) => runIds.get(id)!;
  const recipeRuns = structuredClone(payload.recipeRuns).map(run => {
    run.runId = map(run.runId);
    run.agentSessionId = sessionId;
    run.receipts = {};
    if (run.parent) run.parent.runId = map(run.parent.runId);
    for (const [id, node] of Object.entries(run.nodes)) {
      if (node.state === "running") run.nodes[id] = {
        state: "pending", ...(node.childRunId ? { childRunId: map(node.childRunId) } : {}),
        ...(node.childRecipeId ? { childRecipeId: node.childRecipeId } : {}),
      };
      else if (node.childRunId) node.childRunId = map(node.childRunId);
    }
    return run;
  });
  const todos = structuredClone(source.todos).map(todo => {
    if (["running", "paused"].includes(todo.status)) {
      todo.status = "pending";
      for (const key of ["startedAt", "pausedAt", "pauseReason", "resumedAt"] as const) delete todo[key];
      todo.updatedAt = now;
    }
    if (todo.recipeRunId) todo.recipeRunId = map(todo.recipeRunId);
    if (todo.recipeRunIds) todo.recipeRunIds = todo.recipeRunIds.map(map);
    return todo;
  });
  let continuationTodoCreated = false;
  if (!todos.some(todo => ["pending", "running", "paused"].includes(todo.status))) {
    const state = source.checkpoints.at(-1)?.state;
    const latest = state && typeof state === "object" && !Array.isArray(state) ? state : {};
    const summary = String(latest.summary || source.summary || "Continue from the recovered Agent Snapshot.").trim();
    const next = Array.isArray(latest.next_actions) ? latest.next_actions : Array.isArray(latest.nextActions) ? latest.nextActions : [];
    const actions = next.map(value => String(value).trim()).filter(Boolean).slice(0, 12);
    todos.push({
      todoId: `todo_${sha(`${sessionId}:resume-snapshot`, 20)}`, title: "Continuing recovered Agent Snapshot",
      details: (actions.length ? `${summary}\n\nNext actions:\n${actions.map(action => `- ${action}`).join("\n")}` : summary).slice(0, 12000),
      actionType: "resume_snapshot", status: "pending", createdAt: now, updatedAt: now,
    });
    continuationTodoCreated = true;
  }
  return {
    session: {
      todos, checkpoints: structuredClone(source.checkpoints), recipeRunIds: (source.recipeRunIds || []).map(map),
      ...(source.recipeTreeEdges ? { recipeTreeEdges: source.recipeTreeEdges.map(edge => ({
        ...edge, fromRunId: map(edge.fromRunId), toRunId: map(edge.toRunId),
      })) } : {}),
      ...(source.projectId ? { projectId: source.projectId } : {}),
      provenance: { kind: "agent-snapshot", snapshotId, sourceSessionId }, recoveredAt: now,
    },
    recipeRuns, continuationTodoCreated,
  };
}
