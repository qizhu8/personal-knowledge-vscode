import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ChatHistoryStorage } from "../chat/chat-history-storage";

const SNAPSHOT_SCHEMA = "pkm.agent.snapshot/v1";
const SNAPSHOT_PAYLOAD_ALGORITHM = "A256GCM-PKM-LOCAL-OBFUSCATION/v1";
const LEGACY_SNAPSHOT_PAYLOAD_ALGORITHM = "A256GCM-PKM-INTERNAL/v1";
const SNAPSHOT_PAYLOAD_KEY = createHash("sha256").update("uone", "utf8").digest();
const LEGACY_SNAPSHOT_PAYLOAD_KEY = createHash("sha256").update("uone:agent-snapshot:payload:v1", "utf8").digest();

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

export interface CreatedAgentSnapshot {
  snapshot: AgentSnapshotSummary;
  recoveryPrompt: string;
}

export interface AgentSnapshotContents {
  snapshotId: string;
  session: Record<string, unknown>;
  recipeRuns: unknown[];
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

function payloadKey(payload: any): Buffer | undefined {
  return payload?.algorithm === SNAPSHOT_PAYLOAD_ALGORITHM
    ? SNAPSHOT_PAYLOAD_KEY
    : payload?.algorithm === LEGACY_SNAPSHOT_PAYLOAD_ALGORITHM
      ? LEGACY_SNAPSHOT_PAYLOAD_KEY
      : undefined;
}

function decryptEnvelope(payload: any, snapshot: any): any {
  const key = payloadKey(payload);
  if (!key) return payload;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64url"));
  decipher.setAAD(snapshotAad(String(snapshot.snapshotId || ""), String(snapshot.magicCode || "")));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8"));
}

function decryptPayload(snapshot: any): any {
  let payload = snapshot?.payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!payloadKey(payload)) return payload;
    payload = decryptEnvelope(payload, snapshot);
  }
  if (payloadKey(payload)) throw new Error("Agent Snapshot payload contains too many nested encryption envelopes.");
  return payload;
}

function isCanonicalPayload(payload: any): boolean {
  return payload !== null
    && typeof payload === "object"
    && !Array.isArray(payload)
    && payload.session !== null
    && typeof payload.session === "object"
    && !Array.isArray(payload.session)
    && Array.isArray(payload.recipeRuns);
}

function snapshotNeedsMigration(snapshot: any): boolean {
  const payload = snapshot?.payload;
  if (payload?.algorithm !== SNAPSHOT_PAYLOAD_ALGORITHM) return true;
  const decrypted = decryptEnvelope(payload, snapshot);
  if (payloadKey(decrypted)) return true;
  if (!isCanonicalPayload(decrypted)) throw new Error("Agent Snapshot payload is not a canonical Session capture.");
  return false;
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

export function snapshotRecoveryPrompt(magicCode: string): string {
  return `Read the PKM Agent Snapshot state first: call the PKM MCP function agent_session_snapshot_read with {"magic_code":"${magicCode}"}. It is read-only and does not create an Agent Session; continue from its task, todos, checkpoints and Recipe run states.`;
}

function snapshotSummary(snapshot: any, recoveryCount = 0): AgentSnapshotSummary {
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

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeSnapshotAtomic(snapshotPath: string, snapshot: any): void {
  const temporary = `${snapshotPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(snapshot), { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, snapshotPath);
}

function encryptLegacySnapshot(snapshotPath: string, snapshot: any): any {
  if (!snapshotNeedsMigration(snapshot)) return snapshot;
  const payload = decryptPayload(snapshot);
  if (!isCanonicalPayload(payload)) throw new Error("Agent Snapshot payload is not a canonical Session capture.");
  snapshot.capture = snapshotCapture(payload);
  snapshot.payload = encryptPayload(payload, snapshot.snapshotId, snapshot.magicCode);
  delete snapshot.recovery;
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
  const activeSessionPath = path.join(sessionDirectory(store), `${sessionId}.json`);
  const sessionPath = fs.existsSync(activeSessionPath)
    ? activeSessionPath
    : path.join(store, ".pkm", "state", "agent-sessions-trash", `${sessionId}.json`);
  if (!fs.existsSync(sessionPath)) throw new Error("Agent Session was not found.");
  const session = readJson(sessionPath);
  if (session?.schema !== "pkm.agent.session/v1" || session?.sessionId !== sessionId) {
    throw new Error("Agent Session schema is unsupported.");
  }
  const recipeRuns: any[] = [];
  const visited = new Set<string>();
  const capture = (runId: unknown) => {
    const id = String(runId || "");
    if (!/^recipe_run_[A-Za-z0-9_-]+$/.test(id) || visited.has(id)) return;
    visited.add(id);
    const runPath = path.join(store, ".pkm", "state", "recipe-runs", `${id}.json`);
    if (!fs.existsSync(runPath)) return;
    const run = readJson(runPath);
    delete run.receipts;
    recipeRuns.push(run);
  };
  (Array.isArray(session.recipeRunIds) ? session.recipeRunIds : []).forEach(capture);
  // PKM Chat Sessions own nested Recipe trees; capture child runs so recovery keeps the whole tree.
  for (const edge of Array.isArray(session.recipeTreeEdges) ? session.recipeTreeEdges : []) capture(edge?.toRunId);
  for (let index = 0; index < recipeRuns.length; index++) for (const node of Object.values<any>(recipeRuns[index].nodes || {})) capture(node?.childRunId);
  const sessionCopy = JSON.parse(JSON.stringify(session));
  if (sessionCopy.origin === "pkm-native" && sessionCopy.nativeChat?.messageHistory) {
    sessionCopy.nativeChat = new ChatHistoryStorage(path.join(store, ".pkm", "state")).unpack(sessionCopy.nativeChat);
  }
  delete sessionCopy.todoCommandReceipts;
  const magicCode = `PKM-SNAP-${groupedHex(8)}`;
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
    sourceHostKind: String(session.hostKind || ""),
    task: String(session.task || "Managed task"),
    projectId: String(session.projectId || ""),
    agent: session.agent || { name: "Agent", product: "" },
    reason: String(reason || "manual"),
    createdAt,
    capture: snapshotCapture(payload),
    payload: encryptPayload(payload, snapshotId, magicCode),
  };
  const directory = snapshotDirectory(store);
  fs.mkdirSync(directory, { recursive: true });
  const snapshotPath = path.join(directory, `${snapshotId}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot), { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { snapshot: snapshotSummary(snapshot), recoveryPrompt: snapshotRecoveryPrompt(magicCode) };
}

export function readAgentSnapshotContents(store: string, snapshotId: string): AgentSnapshotContents {
  if (!/^agent_snapshot_[A-Za-z0-9_-]+$/.test(snapshotId)) throw new Error("Agent Snapshot identity is invalid.");
  const snapshotPath = path.join(snapshotDirectory(store), `${snapshotId}.json`);
  if (!fs.existsSync(snapshotPath)) throw new Error("Agent Snapshot was not found.");
  const snapshot = readJson(snapshotPath);
  if (snapshot?.schema !== SNAPSHOT_SCHEMA || snapshot?.snapshotId !== snapshotId) {
    throw new Error("Agent Snapshot schema is unsupported.");
  }
  const payload = decryptPayload(snapshot);
  if (!isCanonicalPayload(payload)) throw new Error("Agent Snapshot payload is not a canonical Session capture.");
  return { snapshotId, session: payload.session, recipeRuns: payload.recipeRuns };
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

export function renameAgentSnapshot(store: string, snapshotId: string, name: string): void {
  if (!/^agent_snapshot_[A-Za-z0-9_-]+$/.test(snapshotId)) throw new Error("Agent Snapshot identity is invalid.");
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 200 || /[\r\n]/.test(trimmed)) {
    throw new Error("Agent Snapshot name must be a single line between 1 and 200 characters.");
  }
  const snapshotPath = path.join(snapshotDirectory(store), `${snapshotId}.json`);
  if (!fs.existsSync(snapshotPath)) throw new Error("Agent Snapshot was not found.");
  const snapshot = readJson(snapshotPath);
  if (snapshot?.schema !== SNAPSHOT_SCHEMA || snapshot?.snapshotId !== snapshotId) {
    throw new Error("Agent Snapshot schema is unsupported.");
  }
  snapshot.name = trimmed;
  writeSnapshotAtomic(snapshotPath, snapshot);
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

export interface AgentSnapshotRecovery {
  /** Fields merged into the new PKM Chat Session record. */
  session: Record<string, unknown>;
  /** Cloned Recipe runs with fresh ids; empty for Snapshots without Recipes. */
  recipeRuns: Array<Record<string, any>>;
  continuationTodoCreated: boolean;
}

function continuationTodo(session: any, sessionId: string, now: string): Record<string, unknown> | undefined {
  const todos = Array.isArray(session.todos) ? session.todos : [];
  if (todos.some((todo: any) => todo && ["pending", "running", "paused"].includes(String(todo.status || "")))) return undefined;
  const checkpoints = Array.isArray(session.checkpoints) ? session.checkpoints : [];
  const latest = checkpoints.at(-1) && typeof checkpoints.at(-1) === "object" ? checkpoints.at(-1) : {};
  const state = latest.state && typeof latest.state === "object" ? latest.state : {};
  const summary = String(state.summary || session.summary || "Continue from the recovered Agent Snapshot.").trim();
  const next = Array.isArray(state.next_actions) ? state.next_actions : Array.isArray(state.nextActions) ? state.nextActions : [];
  const actions = next.map((value: unknown) => String(value).trim()).filter(Boolean).slice(0, 12);
  const details = actions.length ? `${summary}\n\nNext actions:\n${actions.map((action: string) => `- ${action}`).join("\n")}` : summary;
  return {
    todoId: `todo_${createHash("sha256").update(`${sessionId}:resume-snapshot`, "utf8").digest("hex").slice(0, 20)}`,
    title: "Continuing recovered Agent Snapshot", details: details.slice(0, 12000),
    actionType: "resume_snapshot", status: "pending", createdAt: now, updatedAt: now,
  };
}

/**
 * Computes the durable state a new PKM Chat Session inherits from a Snapshot: Recipe runs are cloned with
 * fresh ids (running nodes restart as pending, receipts cleared), unfinished todos become pending, and a
 * continuation todo is added when nothing is left to do. The Snapshot itself is never modified.
 */
export function agentSnapshotRecovery(contents: AgentSnapshotContents, snapshot: Pick<AgentSnapshotSummary, "snapshotId" | "magicCode" | "sourceSessionId">,
  sessionId: string, now = new Date().toISOString(), recoveryKey = randomBytes(16).toString("hex")): AgentSnapshotRecovery {
  const source = contents.session as any;
  const runIdMap = new Map<string, string>();
  for (const run of contents.recipeRuns as any[]) {
    const runId = String(run?.runId || "");
    if (runId) runIdMap.set(runId, `recipe_run_${createHash("sha256").update(`${runId}:${recoveryKey}`, "utf8").digest("hex").slice(0, 24)}`);
  }
  const mapRun = (id: unknown) => runIdMap.get(String(id || "")) || "";
  const recipeRuns = (contents.recipeRuns as any[]).filter(run => runIdMap.has(String(run?.runId || ""))).map(original => {
    const run = JSON.parse(JSON.stringify(original));
    run.runId = mapRun(original.runId);
    run.agentSessionId = sessionId;
    run.receipts = {};
    if (run.parent && typeof run.parent === "object") run.parent.runId = mapRun(run.parent.runId);
    for (const [nodeId, record] of Object.entries<any>(run.nodes || {})) {
      if (record?.state === "running") {
        run.nodes[nodeId] = { state: "pending", ...(record.childRunId ? { childRunId: mapRun(record.childRunId) } : {}), ...(record.childRecipeId ? { childRecipeId: record.childRecipeId } : {}) };
      } else if (record?.childRunId) record.childRunId = mapRun(record.childRunId);
    }
    return run;
  });
  const todos = (Array.isArray(source.todos) ? source.todos : []).filter((todo: any) => todo && typeof todo === "object").map((original: any) => {
    const todo = JSON.parse(JSON.stringify(original));
    if (["running", "paused"].includes(todo.status)) {
      todo.status = "pending";
      for (const field of ["startedAt", "pausedAt", "pauseReason", "resumedAt"]) delete todo[field];
      todo.updatedAt = now;
    }
    if (todo.recipeRunId) todo.recipeRunId = mapRun(todo.recipeRunId);
    if (Array.isArray(todo.recipeRunIds)) todo.recipeRunIds = todo.recipeRunIds.map(String).filter((id: string) => runIdMap.has(id)).map(mapRun);
    return todo;
  });
  const continuation = continuationTodo({ ...source, todos }, sessionId, now);
  if (continuation) todos.push(continuation);
  return {
    session: {
      todos, checkpoints: Array.isArray(source.checkpoints) ? JSON.parse(JSON.stringify(source.checkpoints)) : [],
      recipeRunIds: (Array.isArray(source.recipeRunIds) ? source.recipeRunIds : []).map(String).filter((id: string) => runIdMap.has(id)).map(mapRun),
      ...(Array.isArray(source.recipeTreeEdges) ? { recipeTreeEdges: source.recipeTreeEdges.filter((edge: any) => runIdMap.has(String(edge?.fromRunId || "")) && runIdMap.has(String(edge?.toRunId || "")))
        .map((edge: any) => ({ ...edge, fromRunId: mapRun(edge.fromRunId), toRunId: mapRun(edge.toRunId) })) } : {}),
      ...(source.projectId ? { projectId: String(source.projectId) } : {}),
      provenance: { kind: "agent-snapshot", snapshotId: snapshot.snapshotId, magicCode: snapshot.magicCode, sourceSessionId: snapshot.sourceSessionId },
      recoveredAt: now,
    },
    recipeRuns, continuationTodoCreated: !!continuation,
  };
}
