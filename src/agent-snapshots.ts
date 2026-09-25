import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "crypto";
import * as fs from "fs";
import * as path from "path";

const SNAPSHOT_SCHEMA = "pkm.agent.snapshot/v1";
const SNAPSHOT_PAYLOAD_ALGORITHM = "A256GCM-PKM-INTERNAL/v1";
const SNAPSHOT_PAYLOAD_KEY = createHash("sha256").update("uone:agent-snapshot:payload:v1", "utf8").digest();

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

function snapshotAad(snapshotId: string, magicCode: string): Buffer {
  return Buffer.from(`${SNAPSHOT_SCHEMA}:${snapshotId}:${magicCode}`, "utf8");
}

function encryptPayload(payload: unknown, snapshotId: string, magicCode: string): object {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", SNAPSHOT_PAYLOAD_KEY, iv);
  cipher.setAAD(snapshotAad(snapshotId, magicCode));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return {
    algorithm: SNAPSHOT_PAYLOAD_ALGORITHM,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

function decryptPayload(snapshot: any): any {
  const payload = snapshot?.payload;
  if (payload?.algorithm !== SNAPSHOT_PAYLOAD_ALGORITHM) return payload;
  const decipher = createDecipheriv("aes-256-gcm", SNAPSHOT_PAYLOAD_KEY, Buffer.from(payload.iv, "base64url"));
  decipher.setAAD(snapshotAad(String(snapshot.snapshotId || ""), String(snapshot.magicCode || "")));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8"));
}

function snapshotCapture(payload: any): {
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
  const capture = snapshot.capture || snapshotCapture(snapshot.payload);
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
    recipeRunCount: Number(capture.recipeRunCount || 0),
    todoCount: Number(capture.todoCount || 0),
    checkpoint: capture.checkpoint,
    recoveryCount,
  };
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeSnapshotAtomic(snapshotPath: string, snapshot: any): void {
  const temporary = `${snapshotPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(snapshot), { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, snapshotPath);
}

function encryptLegacySnapshot(snapshotPath: string, snapshot: any): any {
  if (snapshot?.payload?.algorithm === SNAPSHOT_PAYLOAD_ALGORITHM) return snapshot;
  const payload = decryptPayload(snapshot);
  snapshot.capture = snapshotCapture(payload);
  snapshot.payload = encryptPayload(payload, snapshot.snapshotId, snapshot.magicCode);
  writeSnapshotAtomic(snapshotPath, snapshot);
  return snapshot;
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
      const snapshotPath = path.join(directory, name);
      const snapshot = encryptLegacySnapshot(snapshotPath, readJson(snapshotPath));
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
  const payload = { session: sessionCopy, recipeRuns };
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
    capture: snapshotCapture(payload),
    payload: encryptPayload(payload, snapshotId, magicCode),
  };
  const directory = snapshotDirectory(store);
  fs.mkdirSync(directory, { recursive: true });
  const snapshotPath = path.join(directory, `${snapshotId}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot), { encoding: "utf8", flag: "wx", mode: 0o600 });
  const recoveryPrompt = `Recover PKM Agent Snapshot ${magicCode} with recovery passphrase ${recoveryPassphrase}.`;
  return { snapshot: snapshotSummary(snapshot), recoveryPassphrase, recoveryPrompt };
}

export function rotateAgentSnapshotPassphrase(store: string, snapshotId: string): CreatedAgentSnapshot {
  if (!/^agent_snapshot_[A-Za-z0-9_-]+$/.test(snapshotId)) throw new Error("Agent Snapshot identity is invalid.");
  const snapshotPath = path.join(snapshotDirectory(store), `${snapshotId}.json`);
  if (!fs.existsSync(snapshotPath)) throw new Error("Agent Snapshot was not found.");
  const snapshot = readJson(snapshotPath);
  if (snapshot?.schema !== SNAPSHOT_SCHEMA || snapshot?.snapshotId !== snapshotId) {
    throw new Error("Agent Snapshot schema is unsupported.");
  }
  if (snapshot.payload?.algorithm !== SNAPSHOT_PAYLOAD_ALGORITHM) {
    encryptLegacySnapshot(snapshotPath, snapshot);
  }
  const recoveryPassphrase = groupedHex(16);
  const salt = randomBytes(16).toString("hex");
  snapshot.recovery = {
    algorithm: "scrypt-sha256/v1",
    salt,
    verifier: scryptSync(recoveryPassphrase, Buffer.from(salt, "hex"), 32, {
      N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024,
    }).toString("hex"),
    rotatedAt: new Date().toISOString(),
  };
  writeSnapshotAtomic(snapshotPath, snapshot);
  const recoveryPrompt = `Recover PKM Agent Snapshot ${snapshot.magicCode} with recovery passphrase ${recoveryPassphrase}.`;
  return { snapshot: snapshotSummary(snapshot), recoveryPassphrase, recoveryPrompt };
}

export function agentSnapshotIsEncrypted(store: string, snapshotId: string): boolean {
  if (!/^agent_snapshot_[A-Za-z0-9_-]+$/.test(snapshotId)) return false;
  try {
    const snapshot = readJson(path.join(snapshotDirectory(store), `${snapshotId}.json`));
    return snapshot?.schema === SNAPSHOT_SCHEMA
      && snapshot?.snapshotId === snapshotId
      && snapshot?.payload?.algorithm === SNAPSHOT_PAYLOAD_ALGORITHM;
  } catch {
    return false;
  }
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
