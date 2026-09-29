import * as fs from "fs";
import * as path from "path";

export const AGENT_SESSION_ARCHIVE_KEEP_LATEST_DEFAULT = 50;
export const AGENT_SESSION_ARCHIVE_KEEP_LATEST_MIN = 1;
export const AGENT_SESSION_ARCHIVE_KEEP_LATEST_MAX = 1000;

export function agentSessionArchiveKeepLatestK(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return AGENT_SESSION_ARCHIVE_KEEP_LATEST_DEFAULT;
  return Math.min(AGENT_SESSION_ARCHIVE_KEEP_LATEST_MAX, Math.max(AGENT_SESSION_ARCHIVE_KEEP_LATEST_MIN, Math.trunc(value)));
}

interface SessionRecord {
  schema?: unknown;
  sessionId?: unknown;
  status?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
  trashedAt?: unknown;
  todos?: unknown;
  [key: string]: unknown;
}

export interface AgentSessionRetentionResult {
  retained: string[];
  moved: string[];
  errors: string[];
}

export interface AgentSessionActiveMappingReconciliation {
  retained: number;
  removed: number;
  errors: string[];
}

export interface RecipeNodeObservability {
  state: "active" | "quiet" | "waiting" | "stale" | "intervention-required" | "cancelling";
  recommendedAction: "continue" | "observe" | "await-dependency" | "soft-nudge" | "checkpoint-cancel-or-reassign" | "await-terminal-report";
  heartbeatAgeSeconds: number | null;
  progressAgeSeconds: number | null;
  staleAfterSeconds: number;
}

export interface AgentSessionLiveness {
  state: "healthy" | "waiting" | "suspected-stalled" | "suspected-interrupted" | "inactive";
  heartbeatAgeSeconds: number | null;
  leaseSeconds: number;
  ownerTransportId: string;
  hostSessionId: string;
}

export function agentSessionLiveness(
  record: SessionRecord,
  waiting = false,
  now = Date.now(),
): AgentSessionLiveness {
  const liveness = record.liveness && typeof record.liveness === "object"
    ? record.liveness as Record<string, unknown>
    : {};
  const owner = liveness.owner && typeof liveness.owner === "object"
    ? liveness.owner as Record<string, unknown>
    : {};
  const configuredLease = typeof liveness.leaseSeconds === "number" && Number.isFinite(liveness.leaseSeconds)
    ? liveness.leaseSeconds
    : 300;
  const leaseSeconds = Math.max(30, configuredLease);
  const heartbeat = Date.parse(String(liveness.heartbeatAt
    || (record.lastActivity && typeof record.lastActivity === "object"
      ? (record.lastActivity as Record<string, unknown>).at
      : "")
    || record.updatedAt
    || ""));
  const heartbeatAgeSeconds = Number.isFinite(heartbeat) ? Math.max(0, (now - heartbeat) / 1000) : null;
  let state: AgentSessionLiveness["state"] = "inactive";
  if (projectedAgentSessionStatus(record) === "running") {
    if (waiting) state = "waiting";
    else if (heartbeatAgeSeconds === null || heartbeatAgeSeconds >= leaseSeconds * 3) state = "suspected-interrupted";
    else if (heartbeatAgeSeconds >= leaseSeconds) state = "suspected-stalled";
    else state = "healthy";
  }
  return {
    state,
    heartbeatAgeSeconds,
    leaseSeconds,
    ownerTransportId: String(owner.transportId || ""),
    hostSessionId: String(owner.hostSessionId || record.hostSessionId || ""),
  };
}

export function recipeNodeObservability(
  record: { lastHeartbeatAt?: unknown; lastProgressAt?: unknown; progress?: unknown },
  now = Date.now(),
): RecipeNodeObservability {
  const progress = record.progress && typeof record.progress === "object"
    ? record.progress as Record<string, unknown>
    : {};
  const configuredStale = typeof progress.staleAfterSeconds === "number" && Number.isFinite(progress.staleAfterSeconds)
    ? progress.staleAfterSeconds
    : 300;
  const staleAfterSeconds = Math.max(configuredStale, 1);
  const age = (value: unknown): number | null => {
    const timestamp = Date.parse(String(value || ""));
    return Number.isFinite(timestamp) ? Math.max(0, (now - timestamp) / 1000) : null;
  };
  const heartbeatAgeSeconds = age(record.lastHeartbeatAt);
  const progressAgeSeconds = age(record.lastProgressAt);
  let state: RecipeNodeObservability["state"];
  let recommendedAction: RecipeNodeObservability["recommendedAction"];
  if (progress.cancellationRequested === true) {
    state = "cancelling";
    recommendedAction = "await-terminal-report";
  } else if (String(progress.waitingOn || "").trim()) {
    state = "waiting";
    recommendedAction = "await-dependency";
  } else if ((progressAgeSeconds !== null && progressAgeSeconds >= staleAfterSeconds * 2)
    || (heartbeatAgeSeconds !== null && heartbeatAgeSeconds >= staleAfterSeconds * 2)) {
    state = "intervention-required";
    recommendedAction = "checkpoint-cancel-or-reassign";
  } else if ((progressAgeSeconds !== null && progressAgeSeconds >= staleAfterSeconds)
    || (heartbeatAgeSeconds !== null && heartbeatAgeSeconds >= staleAfterSeconds)) {
    state = "stale";
    recommendedAction = "soft-nudge";
  } else if (progressAgeSeconds !== null
    && progressAgeSeconds >= Math.min(Math.max(staleAfterSeconds / 2, 30), 120)) {
    state = "quiet";
    recommendedAction = "observe";
  } else {
    state = "active";
    recommendedAction = "continue";
  }
  return { state, recommendedAction, heartbeatAgeSeconds, progressAgeSeconds, staleAfterSeconds };
}

function validSession(record: SessionRecord, sessionId: string): boolean {
  return record.schema === "pkm.agent.session/v1" && record.sessionId === sessionId;
}

function archiveTimestamp(record: SessionRecord): string {
  return String(record.updatedAt || record.createdAt || "");
}

export function projectedAgentSessionStatus(record: SessionRecord): string {
  const status = String(record.status || "unknown");
  if (status !== "running" || !Array.isArray(record.todos) || !record.todos.length) return status;
  const terminal = new Set(["succeeded", "failed", "skipped"]);
  return record.todos.every(todo =>
    todo && typeof todo === "object" && terminal.has(String((todo as { status?: unknown }).status || ""))
  ) ? "completed" : status;
}

export function terminalAgentSessionStatus(record: SessionRecord): boolean {
  return ["completed", "stopped"].includes(projectedAgentSessionStatus(record));
}

function activeMappingsDirectory(stateDirectory: string): string {
  return path.join(stateDirectory, "agent-sessions", "active");
}

function clearAgentSessionActiveMappings(stateDirectory: string, sessionId: string): number {
  const directory = activeMappingsDirectory(stateDirectory);
  if (!fs.existsSync(directory)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(directory).filter(candidate => candidate.endsWith(".json"))) {
    const mappingPath = path.join(directory, name);
    try {
      const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8"));
      if (mapping?.sessionId !== sessionId) continue;
      fs.unlinkSync(mappingPath);
      removed += 1;
    } catch { /* Reconciliation handles malformed mappings separately. */ }
  }
  return removed;
}

export function reconcileAgentSessionActiveMappings(stateDirectory: string): AgentSessionActiveMappingReconciliation {
  const directory = activeMappingsDirectory(stateDirectory);
  const result: AgentSessionActiveMappingReconciliation = { retained: 0, removed: 0, errors: [] };
  if (!fs.existsSync(directory)) return result;
  for (const name of fs.readdirSync(directory).filter(candidate => candidate.endsWith(".json"))) {
    const mappingPath = path.join(directory, name);
    try {
      const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8"));
      const sessionId = String(mapping?.sessionId || "");
      const sessionPath = path.join(stateDirectory, "agent-sessions", `${sessionId}.json`);
      if (!/^agent_session_[a-zA-Z0-9_-]+$/.test(sessionId) || !fs.existsSync(sessionPath)) {
        fs.unlinkSync(mappingPath);
        result.removed += 1;
        continue;
      }
      const session = JSON.parse(fs.readFileSync(sessionPath, "utf8")) as SessionRecord;
      if (!validSession(session, sessionId) || session.status !== "running") {
        fs.unlinkSync(mappingPath);
        result.removed += 1;
        continue;
      }
      result.retained += 1;
    } catch (error: any) {
      try {
        fs.unlinkSync(mappingPath);
        result.removed += 1;
      } catch (unlinkError: any) {
        result.errors.push(`${name}: ${unlinkError?.message || unlinkError || error?.message || error}`);
      }
    }
  }
  return result;
}

export async function stopAgentSession(
  stateDirectory: string,
  sessionId: string,
  options: { reason?: string; summary?: string; now?: () => string } = {},
): Promise<number> {
  if (!/^agent_session_[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("Agent Session identity is invalid.");
  const activeDirectory = path.join(stateDirectory, "agent-sessions");
  const sessionPath = path.join(activeDirectory, `${sessionId}.json`);
  await withSessionFileLock(path.join(activeDirectory, `${sessionId}.lock`), () => {
    if (!fs.existsSync(sessionPath)) throw new Error("Agent Session was not found.");
    const session = JSON.parse(fs.readFileSync(sessionPath, "utf8")) as SessionRecord;
    if (!validSession(session, sessionId)) throw new Error("Agent Session record is invalid.");
    if (session.status !== "running") {
      throw new Error("Only a running Agent Session can be stopped.");
    }
    const now = (options.now || (() => new Date().toISOString()))();
    session.status = "stopped";
    session.stopReason = String(options.reason || "user-requested");
    session.summary = String(options.summary || "");
    session.stoppedAt = now;
    session.updatedAt = now;
    fs.writeFileSync(sessionPath, JSON.stringify(session), { encoding: "utf8", mode: 0o600 });
  });
  return clearAgentSessionActiveMappings(stateDirectory, sessionId);
}

async function withSessionFileLock<T>(lockPath: string, action: () => T | Promise<T>): Promise<T> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      const handle = fs.openSync(lockPath, "wx", 0o600);
      fs.closeSync(handle);
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 30_000) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (statError: any) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for Agent Session lock: ${path.basename(lockPath)}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try { return await action(); }
  finally {
    try { fs.unlinkSync(lockPath); }
    catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  }
}

export async function moveAgentSessionToTrash(
  stateDirectory: string,
  sessionId: string,
  options: { requireCompleted?: boolean; now?: () => string } = {},
): Promise<void> {
  if (!/^agent_session_[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("Agent Session identity is invalid.");
  const activeDirectory = path.join(stateDirectory, "agent-sessions");
  const trashDirectory = path.join(stateDirectory, "agent-sessions-trash");
  const activePath = path.join(activeDirectory, `${sessionId}.json`);
  const trashPath = path.join(trashDirectory, `${sessionId}.json`);
  await withSessionFileLock(path.join(activeDirectory, `${sessionId}.lock`), () => {
    if (!fs.existsSync(activePath)) throw new Error("Agent Session cannot be moved to Trash because its record no longer exists.");
    if (fs.existsSync(trashPath)) throw new Error("An Agent Session with the same identity already exists in Trash.");
    let session: SessionRecord;
    try { session = JSON.parse(fs.readFileSync(activePath, "utf8")); }
    catch (error: any) { throw new Error(`Agent Session could not be read before moving to Trash: ${error?.message || error}`); }
    if (!validSession(session, sessionId)) throw new Error("Agent Session record is invalid and was not moved to Trash.");
    if (options.requireCompleted !== false && !terminalAgentSessionStatus(session)) {
      throw new Error("Only completed or stopped Agent Sessions can be moved to Trash.");
    }
    session.trashedAt = (options.now || (() => new Date().toISOString()))();
    fs.mkdirSync(trashDirectory, { recursive: true });
    fs.writeFileSync(activePath, JSON.stringify(session), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(activePath, trashPath);
  });
}

export function restoreAgentSessionFromTrash(
  stateDirectory: string,
  sessionId: string,
  now: () => string = () => new Date().toISOString(),
): void {
  if (!/^agent_session_[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("Agent Session identity is invalid.");
  const activePath = path.join(stateDirectory, "agent-sessions", `${sessionId}.json`);
  const trashPath = path.join(stateDirectory, "agent-sessions-trash", `${sessionId}.json`);
  if (!fs.existsSync(trashPath)) throw new Error("Agent Session cannot be restored because it is not in Trash.");
  if (fs.existsSync(activePath)) throw new Error("An Agent Session with the same identity already exists outside Trash.");
  let session: SessionRecord;
  try { session = JSON.parse(fs.readFileSync(trashPath, "utf8")); }
  catch (error: any) { throw new Error(`Agent Session could not be read before restoring: ${error?.message || error}`); }
  if (!validSession(session, sessionId)) throw new Error("Agent Session Trash record is invalid and was not restored.");
  delete session.trashedAt;
  session.updatedAt = now();
  fs.mkdirSync(path.dirname(activePath), { recursive: true });
  fs.writeFileSync(trashPath, JSON.stringify(session), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(trashPath, activePath);
}

export function permanentlyDeleteTrashedAgentSession(stateDirectory: string, sessionId: string): void {
  if (!/^agent_session_[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("Agent Session identity is invalid.");
  const trashPath = path.join(stateDirectory, "agent-sessions-trash", `${sessionId}.json`);
  if (!fs.existsSync(trashPath)) throw new Error("Agent Session is not in Trash.");
  fs.unlinkSync(trashPath);
}

export function emptyAgentSessionTrash(stateDirectory: string): number {
  const trashDirectory = path.join(stateDirectory, "agent-sessions-trash");
  if (!fs.existsSync(trashDirectory)) return 0;
  const records = fs.readdirSync(trashDirectory)
    .filter(name => name.endsWith(".json"))
    .map(name => {
      const sessionId = name.slice(0, -5);
      if (!/^agent_session_[a-zA-Z0-9_-]+$/.test(sessionId)) {
        throw new Error(`Agent Session Trash contains an invalid record name: ${name}`);
      }
      let session: SessionRecord;
      try { session = JSON.parse(fs.readFileSync(path.join(trashDirectory, name), "utf8")); }
      catch (error: any) { throw new Error(`Agent Session Trash record ${name} could not be read: ${error?.message || error}`); }
      if (!validSession(session, sessionId) || typeof session.trashedAt !== "string" || !session.trashedAt) {
        throw new Error(`Agent Session Trash record ${name} is invalid.`);
      }
      return path.join(trashDirectory, name);
    });
  for (const recordPath of records) fs.unlinkSync(recordPath);
  return records.length;
}

export async function enforceAgentSessionArchiveRetention(
  stateDirectory: string,
  keepLatest: number,
  now: () => string = () => new Date().toISOString(),
): Promise<AgentSessionRetentionResult> {
  const limit = agentSessionArchiveKeepLatestK(keepLatest);
  const activeDirectory = path.join(stateDirectory, "agent-sessions");
  const result: AgentSessionRetentionResult = { retained: [], moved: [], errors: [] };
  if (!fs.existsSync(activeDirectory)) return result;
  const completed: Array<{ sessionId: string; timestamp: string }> = [];
  let names: string[];
  try { names = fs.readdirSync(activeDirectory).filter(name => name.endsWith(".json")); }
  catch (error: any) {
    result.errors.push(`Agent Session archive could not be listed: ${error?.message || error}`);
    return result;
  }
  for (const name of names) {
    const sessionId = name.slice(0, -5);
    try {
      const record = JSON.parse(fs.readFileSync(path.join(activeDirectory, name), "utf8")) as SessionRecord;
      if (validSession(record, sessionId) && terminalAgentSessionStatus(record)) {
        completed.push({ sessionId, timestamp: archiveTimestamp(record) });
      }
    } catch (error: any) {
      result.errors.push(`${name}: ${error?.message || error}`);
    }
  }
  completed.sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.sessionId.localeCompare(left.sessionId));
  result.retained = completed.slice(0, limit).map(item => item.sessionId);
  for (const item of completed.slice(limit)) {
    try {
      await moveAgentSessionToTrash(stateDirectory, item.sessionId, { requireCompleted: true, now });
      result.moved.push(item.sessionId);
    } catch (error: any) {
      result.errors.push(`${item.sessionId}: ${error?.message || error}`);
    }
  }
  return result;
}
