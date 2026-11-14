// Host-neutral port of resources/agent_session_runtime.py::_snapshot_read_projection.
import { snapshotSummary } from "./agent-snapshot-reads-original.js";

type RecordValue = Record<string, any>;
const text = (value: unknown, limit: number) => {
  const characters = Array.from(String(value || ""));
  return characters.length <= limit ? characters.join("") : `${characters.slice(0, limit).join("")}\n[truncated]`;
};
const string = (value: unknown) => String(value || "");
export function snapshotReadProjection(snapshot: RecordValue, payload: RecordValue, messageLimit: number) {
  const session = payload.session;
  const checkpoints: RecordValue[] = session.checkpoints || [];
  const pkm = session.origin === "pkm-native" && session.hostKind === "pkm";
  const latest = checkpoints.at(-1);
  const result: RecordValue = {
    ok: true, read_only: true, snapshot: snapshotSummary(snapshot),
    source: pkm ? "pkm-chat" : "external-agent",
    task: string(session.task || snapshot.task), status: string(session.status),
    summary: text(session.summary, 1000), project_id: string(session.projectId),
    todos: (session.todos || []).map((todo: RecordValue) => {
      const item: RecordValue = {};
      for (const key of ["todoId", "title", "status", "actionType", "updatedAt"]) {
        if (todo[key] != null) item[key] = todo[key];
      }
      if (todo.details) item.details = text(todo.details, 2000);
      if (todo.summary) item.summary = text(todo.summary, 1000);
      const ids = todo.recipeRunIds || (todo.recipeRunId ? [todo.recipeRunId] : []);
      if (ids.length) item.recipeRunIds = ids.map(String);
      return item;
    }),
    checkpoints: checkpoints.map(item => Object.fromEntries(
      ["checkpointId", "sequence", "createdAt", "reason"].map(key => [key, item[key] ?? null]),
    )),
    latest_checkpoint_state: latest?.state ?? null,
    note: "Read-only view; no Agent Session was created. Agent Sessions belong to PKM Chat: to continue "
      + "inside PKM, recover this Snapshot into a new PKM Chat from the Agent Snapshots panel. Any agent "
      + "may continue the work in its own context from this state.",
  };
  if (payload.recipeRuns.length) {
    result.recipe_runs = payload.recipeRuns.map((run: RecordValue) => ({
      runId: string(run.runId), recipeId: string(run.recipeId), recipeName: string(run.recipeName),
      status: string(run.status), nodes: Object.fromEntries(Object.entries(run.nodes || {})
        .map(([id, record]) => [id, string((record as RecordValue).state)])),
    }));
  }
  if (pkm && session.nativeChat) {
    const messages = session.nativeChat.messages || [];
    result.conversation = {
      message_count: messages.length,
      recent_messages: messageLimit ? messages.slice(-messageLimit).map((message: RecordValue) => ({
        role: string(message.role), status: string(message.status), content: text(message.content, 4000),
      })) : [],
    };
  }
  return result;
}
