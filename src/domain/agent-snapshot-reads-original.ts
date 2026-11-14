// Pure original Snapshot contracts and summary rules; regenerate with capture-agent-snapshot-reads.mjs.
export interface AgentSnapshotSummary {
  snapshotId: string;
  name?: string;
  magicCode: string;
  sourceSessionId: string;
  sourceHostSessionId: string;
  /** "pkm" for PKM Chat Snapshots (conversation + Recipes); other values are retired external agents. */
  sourceHostKind: string;
  task: string;
  projectId: string;
  agent: { name: string; product: string };
  reason: string;
  createdAt: string;
  recipeRunCount: number;
  todoCount: number;
  checkpoint?: {
    checkpointId: string;
    sequence: number;
    createdAt: string;
    reason: string;
  };
  recoveryCount: number;
}

export interface AgentSnapshotContents {
  snapshotId: string;
  session: Record<string, unknown>;
  recipeRuns: unknown[];
}

export function snapshotCapture(payload: any): {
  recipeRunCount: number;
  todoCount: number;
  checkpoint?: AgentSnapshotSummary["checkpoint"];
} {
  const session = payload?.session || {};
  const checkpoints = Array.isArray(session.checkpoints) ? session.checkpoints : [];
  const latest = checkpoints.at(-1);
  return {
    recipeRunCount: Array.isArray(payload?.recipeRuns) ? payload.recipeRuns.length : 0,
    todoCount: Array.isArray(session.todos) ? session.todos.length : 0,
    checkpoint: latest ? {
      checkpointId: String(latest.checkpointId || ""),
      sequence: Number(latest.sequence || checkpoints.length),
      createdAt: String(latest.createdAt || ""),
      reason: String(latest.reason || ""),
    } : undefined,
  };
}

export function snapshotSummary(snapshot: any, recoveryCount = 0): AgentSnapshotSummary {
  const capture = snapshot.capture || snapshotCapture(snapshot.payload);
  return {
    snapshotId: String(snapshot.snapshotId || ""),
    name: String(snapshot.name || snapshot.task || "Agent Session snapshot"),
    magicCode: String(snapshot.magicCode || ""),
    sourceSessionId: String(snapshot.sourceSessionId || ""),
    sourceHostSessionId: String(snapshot.sourceHostSessionId || ""),
    sourceHostKind: String(snapshot.sourceHostKind || snapshot.agent?.product === "PKM" && "pkm" || ""),
    task: String(snapshot.task || "Agent Session snapshot"),
    projectId: String(snapshot.projectId || ""),
    agent: {
      name: String(snapshot.agent?.name || "Agent"),
      product: String(snapshot.agent?.product || ""),
    },
    reason: String(snapshot.reason || ""),
    createdAt: String(snapshot.createdAt || ""),
    recipeRunCount: Number(capture.recipeRunCount || 0),
    todoCount: Number(capture.todoCount || 0),
    checkpoint: capture.checkpoint,
    recoveryCount,
  };
}
