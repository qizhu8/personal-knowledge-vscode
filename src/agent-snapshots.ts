import { createHash, randomBytes, scryptSync } from "crypto";
import * as fs from "fs";
import * as path from "path";

const SNAPSHOT_SCHEMA = "pkm.agent.snapshot/v1";

export interface AgentSnapshotSummary {
  snapshotId: string;
  magicCode: string;
  sourceSessionId: string;
  sourceHostSessionId: string;
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

export interface CreatedAgentSnapshot {
  snapshot: AgentSnapshotSummary;
  recoveryPassphrase: string;
  recoveryPrompt: string;
}

function snapshotDirectory(store: string): string {
  return path.join(store, ".pkm", "state", "agent-snapshots");
}

function sessionDirectory(store: string): string {
  return path.join(store, ".pkm", "state", "agent-sessions");
}

function groupedHex(bytes: number): string {
  return randomBytes(bytes).toString("hex").toUpperCase().match(/.{1,4}/g)!.join("-");
}

function snapshotSummary(snapshot: any, recoveryCount = 0): AgentSnapshotSummary {
  const session = snapshot?.payload?.session || {};
  const checkpoints = Array.isArray(session.checkpoints) ? session.checkpoints : [];
  const latest = checkpoints.at(-1);
  return {
    snapshotId: String(snapshot.snapshotId || ""),
    magicCode: String(snapshot.magicCode || ""),
    sourceSessionId: String(snapshot.sourceSessionId || ""),
    sourceHostSessionId: String(snapshot.sourceHostSessionId || ""),
    task: String(snapshot.task || "Agent Session snapshot"),
    projectId: String(snapshot.projectId || ""),
    agent: {
      name: String(snapshot.agent?.name || "Agent"),
      product: String(snapshot.agent?.product || ""),
    },
    reason: String(snapshot.reason || ""),
    createdAt: String(snapshot.createdAt || ""),
    recipeRunCount: Array.isArray(snapshot?.payload?.recipeRuns) ? snapshot.payload.recipeRuns.length : 0,
    todoCount: Array.isArray(session.todos) ? session.todos.length : 0,
    checkpoint: latest ? {
      checkpointId: String(latest.checkpointId || ""),
      sequence: Number(latest.sequence || checkpoints.length),
      createdAt: String(latest.createdAt || ""),
      reason: String(latest.reason || ""),
    } : undefined,
    recoveryCount,
  };
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function recoveryCounts(store: string): Map<string, number> {
  const counts = new Map<string, number>();
  const directory = sessionDirectory(store);
  if (!fs.existsSync(directory)) return counts;
  for (const name of fs.readdirSync(directory)) {
    if (!/^agent_session_.+\.json$/.test(name)) continue;
    try {
      const session = readJson(path.join(directory, name));
      const snapshotId = String(session?.provenance?.snapshotId || "");
      if (snapshotId) counts.set(snapshotId, (counts.get(snapshotId) || 0) + 1);
    } catch {
      // A corrupt session must not hide healthy Snapshot records.
    }
  }
  return counts;
}

export function listAgentSnapshots(store: string): AgentSnapshotSummary[] {
  const directory = snapshotDirectory(store);
  if (!fs.existsSync(directory)) return [];
  const counts = recoveryCounts(store);
  const snapshots: AgentSnapshotSummary[] = [];
  for (const name of fs.readdirSync(directory)) {
    if (!/^agent_snapshot_.+\.json$/.test(name)) continue;
    try {
      const snapshot = readJson(path.join(directory, name));
      if (snapshot?.schema !== SNAPSHOT_SCHEMA) continue;
      snapshots.push(snapshotSummary(snapshot, counts.get(String(snapshot.snapshotId || "")) || 0));
    } catch {
      // A corrupt Snapshot must not hide healthy records.
    }
  }
  return snapshots.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function createAgentSnapshot(store: string, sessionId: string, reason = "manual"): CreatedAgentSnapshot {
  if (!/^agent_session_[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("Agent Session identity is invalid.");
  const sessionPath = path.join(sessionDirectory(store), `${sessionId}.json`);
  if (!fs.existsSync(sessionPath)) throw new Error("Agent Session was not found.");
  const session = readJson(sessionPath);
  if (session?.schema !== "pkm.agent.session/v1" || session?.sessionId !== sessionId) {
    throw new Error("Agent Session schema is unsupported.");
  }
  const recipeRuns = (Array.isArray(session.recipeRunIds) ? session.recipeRunIds : []).flatMap((runId: string) => {
    const runPath = path.join(store, ".pkm", "state", "recipe-runs", `${runId}.json`);
    if (!fs.existsSync(runPath)) return [];
    const run = readJson(runPath);
    delete run.receipts;
    return [run];
  });
  const sessionCopy = JSON.parse(JSON.stringify(session));
  delete sessionCopy.todoCommandReceipts;
  const magicCode = `PKM-SNAP-${groupedHex(8)}`;
  const recoveryPassphrase = groupedHex(16);
  const salt = randomBytes(16).toString("hex");
  const createdAt = new Date().toISOString();
  const snapshotId = `agent_snapshot_${createHash("sha256")
    .update(`${magicCode}:${sessionId}:${createdAt}`, "utf8").digest("hex").slice(0, 24)}`;
  const snapshot = {
    schema: SNAPSHOT_SCHEMA,
    snapshotId,
    magicCode,
    sourceSessionId: sessionId,
    sourceHostSessionId: String(session.hostSessionId || ""),
    task: String(session.task || "Managed task"),
    projectId: String(session.projectId || ""),
    agent: session.agent || { name: "Agent", product: "" },
    reason: String(reason || "manual"),
    createdAt,
    recovery: {
      algorithm: "scrypt-sha256/v1",
      salt,
      verifier: scryptSync(recoveryPassphrase, Buffer.from(salt, "hex"), 32, {
        N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024,
      }).toString("hex"),
    },
    payload: { session: sessionCopy, recipeRuns },
  };
  const directory = snapshotDirectory(store);
  fs.mkdirSync(directory, { recursive: true });
  const snapshotPath = path.join(directory, `${snapshotId}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot), { encoding: "utf8", flag: "wx", mode: 0o600 });
  const recoveryPrompt = `Recover PKM Agent Snapshot ${magicCode} with recovery passphrase ${recoveryPassphrase}.`;
  return { snapshot: snapshotSummary(snapshot), recoveryPassphrase, recoveryPrompt };
}

export function deleteAgentSnapshot(store: string, snapshotId: string): void {
  if (!/^agent_snapshot_[A-Za-z0-9_-]+$/.test(snapshotId)) throw new Error("Agent Snapshot identity is invalid.");
  const snapshotPath = path.join(snapshotDirectory(store), `${snapshotId}.json`);
  if (!fs.existsSync(snapshotPath)) throw new Error("Agent Snapshot was not found.");
  const snapshot = readJson(snapshotPath);
  if (snapshot?.schema !== SNAPSHOT_SCHEMA || snapshot?.snapshotId !== snapshotId) {
    throw new Error("Agent Snapshot schema is unsupported.");
  }
  fs.unlinkSync(snapshotPath);
}
