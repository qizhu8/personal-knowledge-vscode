import { parentPort, workerData } from "worker_threads";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

const initSqlJs = require(path.join(__dirname, "sql-wasm.js")) as (options: { locateFile: (file: string) => string }) => Promise<any>;

interface PersistedMessage {
  id: string;
  participantId?: string;
  aliasAtSend: string;
  senderKind: string;
  messageType: string;
  content: string;
  metadata?: unknown;
  createdAt: number;
}

interface LifecycleEvent {
  id: string;
  type: string;
  payload?: unknown;
  createdAt: number;
  state?: "active" | "stored";
}

interface RoomCredentialsMetadata {
  ownerInstallationId: string;
  hostCredentialHash: string;
  joinSecretHash: string;
}

interface PendingJoinRequest {
  requestId: string;
  alias: string;
  aliasKey: string;
  kind: string;
  requestedAt: number;
  expiresAt: number;
}

interface JoinResolution {
  requestId: string;
  outcome: "new" | "reuse" | "reject" | "timeout" | "cancel";
  participantId?: string;
  resolvedAt: number;
  reason?: string;
}

interface AliasRelease {
  participantId: string;
  aliasKey?: string;
  releasedAt: number;
}

interface ParticipantForget {
  participantId: string;
  forgottenAt: number;
}

interface AliasRename {
  participantId: string;
  alias: string;
  aliasKey: string;
  renamedAt: number;
}

interface ParticipantRoleUpdate {
  participantId: string;
  role: string;
  updatedAt: number;
}

interface RoomHandle {
  roomId: string;
  roomName: string;
  dir: string;
  dbPath: string;
  journalPath: string;
  db: any;
  dirty: boolean;
  flushTimer?: NodeJS.Timeout;
}

interface WorkerRequest {
  id: number;
  op: "list" | "open" | "create" | "lifecycle" | "setState" | "append" | "appendMany" |
    "requestJoin" | "resolveJoin" | "releaseAlias" | "renameAlias" | "setParticipantRole" | "forgetParticipant" | "identityState" |
    "flush" | "close" | "shutdown";
  roomId?: string;
  roomName?: string;
  state?: "active" | "stored";
  credentials?: RoomCredentialsMetadata;
  event?: LifecycleEvent;
  reason?: string;
  message?: PersistedMessage;
  messages?: PersistedMessage[];
  joinRequest?: PendingJoinRequest;
  resolution?: JoinResolution;
  aliasRelease?: AliasRelease;
  participantForget?: ParticipantForget;
  aliasRename?: AliasRename;
  roleUpdate?: ParticipantRoleUpdate;
}

const rooms = new Map<string, RoomHandle>();
const rootDir = String(workerData.rootDir || "");
const flushDelayMs = Math.max(50, Number(workerData.flushDelayMs) || 500);
const historyLimitBytes = Math.max(0, Number(workerData.historyLimitBytes) || 0);
let SQL: any;

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS room_metadata (
  room_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  current_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'stored',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS room_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  participant_id TEXT,
  alias_at_send TEXT NOT NULL,
  sender_kind TEXT NOT NULL,
  message_type TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_created_at ON messages(created_at);
CREATE TABLE IF NOT EXISTS memberships (
  participant_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  forgotten_at INTEGER
);
CREATE TABLE IF NOT EXISTS alias_history (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  alias_key TEXT NOT NULL,
  alias_display TEXT NOT NULL,
  participant_id TEXT NOT NULL REFERENCES memberships(participant_id),
  assigned_at INTEGER NOT NULL,
  released_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS alias_history_active_alias ON alias_history(alias_key) WHERE released_at IS NULL;
CREATE TABLE IF NOT EXISTS pending_joins (
  request_id TEXT PRIMARY KEY,
  alias_key TEXT NOT NULL,
  alias_display TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER,
  participant_id TEXT,
  reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS pending_joins_reserved_alias ON pending_joins(alias_key) WHERE status = 'pending';
`;

function ensureMetadataColumns(db: any): void {
  const columns = new Set<string>((db.exec("PRAGMA table_info(room_metadata)")[0]?.values || []).map((row: unknown[]) => String(row[1])));
  if (!columns.has("state")) db.run("ALTER TABLE room_metadata ADD COLUMN state TEXT NOT NULL DEFAULT 'stored'");
  if (!columns.has("owner_installation_id")) db.run("ALTER TABLE room_metadata ADD COLUMN owner_installation_id TEXT");
  if (!columns.has("host_credential_hash")) db.run("ALTER TABLE room_metadata ADD COLUMN host_credential_hash TEXT");
  if (!columns.has("join_secret_hash")) db.run("ALTER TABLE room_metadata ADD COLUMN join_secret_hash TEXT");
  if (!columns.has("deactivated_at")) db.run("ALTER TABLE room_metadata ADD COLUMN deactivated_at INTEGER");
  if (!columns.has("host_participant_id")) db.run("ALTER TABLE room_metadata ADD COLUMN host_participant_id TEXT");
}

function ensureMembershipColumns(db: any): void {
  const columns = new Set<string>((db.exec("PRAGMA table_info(memberships)")[0]?.values || []).map((row: unknown[]) => String(row[1])));
  if (!columns.has("role")) db.run("ALTER TABLE memberships ADD COLUMN role TEXT NOT NULL DEFAULT ''");
}

function assertRoomId(roomId: string): void {
  if (!/^[a-zA-Z0-9_-]{6,80}$/.test(roomId)) throw new Error("Invalid room ID.");
}

function durableAppend(file: string, line: string): void {
  const fd = fs.openSync(file, "a", 0o600);
  try {
    fs.writeSync(fd, line, undefined, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function durableTruncate(file: string): void {
  const fd = fs.openSync(file, "w", 0o600);
  try { fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function insertMessage(room: RoomHandle, message: PersistedMessage): void {
  room.db.run(
    `INSERT OR IGNORE INTO messages
      (message_id, participant_id, alias_at_send, sender_kind, message_type, content, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [message.id, message.participantId || null, message.aliasAtSend, message.senderKind,
      message.messageType, message.content, JSON.stringify(message.metadata ?? null), message.createdAt],
  );
}

function insertLifecycleEvent(room: RoomHandle, event: LifecycleEvent): void {
  room.db.run(`INSERT OR IGNORE INTO room_events(event_id, event_type, payload_json, created_at) VALUES(?, ?, ?, ?)`,
    [event.id, event.type, JSON.stringify(event.payload ?? null), event.createdAt]);
  if (event.state) {
    room.db.run(`UPDATE room_metadata SET state=?, updated_at=?, deactivated_at=? WHERE room_id=?`,
      [event.state, event.createdAt, event.state === "stored" ? event.createdAt : null, room.roomId]);
  }
  if (event.type === "room.secret_rotated") {
    const hash = (event.payload as { joinSecretHash?: string } | undefined)?.joinSecretHash;
    if (!hash) throw new Error("Secret rotation event is missing joinSecretHash.");
    room.db.run("UPDATE room_metadata SET join_secret_hash=?, updated_at=? WHERE room_id=?", [hash, event.createdAt, room.roomId]);
  }
  if (event.type === "room.host_assigned") {
    const participantId = (event.payload as { participantId?: string } | undefined)?.participantId;
    if (!participantId) throw new Error("Host assignment event is missing participantId.");
    room.db.run("UPDATE room_metadata SET host_participant_id=?, updated_at=? WHERE room_id=?", [participantId, event.createdAt, room.roomId]);
  }
  if (event.type === "room.renamed") {
    const roomName = String((event.payload as { roomName?: string } | undefined)?.roomName || "").trim();
    if (!roomName) throw new Error("Room rename event is missing roomName.");
    room.roomName = roomName;
    room.db.run("UPDATE room_metadata SET current_name=?, updated_at=? WHERE room_id=?", [roomName, event.createdAt, room.roomId]);
  }
  if (event.type === "room.deactivated") {
    const reason = String((event.payload as { reason?: string } | undefined)?.reason || "Room deactivated.");
    room.db.run(`UPDATE pending_joins SET status='cancelled', resolved_at=?, reason=? WHERE status='pending'`, [event.createdAt, reason]);
    room.db.run(`UPDATE memberships SET updated_at=? WHERE participant_id IN
      (SELECT participant_id FROM alias_history WHERE released_at IS NULL)`, [event.createdAt]);
    room.db.run("UPDATE alias_history SET released_at=? WHERE released_at IS NULL", [event.createdAt]);
  }
}

function scalar(db: any, sql: string, params: unknown[] = []): unknown {
  return db.exec(sql, params)[0]?.values?.[0]?.[0];
}

function applyJoinRequest(room: RoomHandle, request: PendingJoinRequest): void {
  room.db.run(`INSERT OR IGNORE INTO pending_joins
    (request_id, alias_key, alias_display, kind, status, requested_at, expires_at)
    VALUES(?, ?, ?, ?, 'pending', ?, ?)`,
  [request.requestId, request.aliasKey, request.alias, request.kind, request.requestedAt, request.expiresAt]);
}

function resolutionStatus(outcome: JoinResolution["outcome"]): string {
  if (outcome === "new") return "approved_new";
  if (outcome === "reuse") return "approved_reuse";
  if (outcome === "reject") return "rejected";
  if (outcome === "timeout") return "timed_out";
  return "cancelled";
}

function applyJoinResolution(room: RoomHandle, resolution: JoinResolution): void {
  const pending = room.db.exec(`SELECT alias_key, alias_display, kind FROM pending_joins WHERE request_id=?`, [resolution.requestId])[0]?.values?.[0];
  if (!pending) return;
  if (resolution.outcome === "new" && resolution.participantId) {
    room.db.run(`INSERT OR IGNORE INTO memberships(participant_id, kind, created_at, updated_at)
      VALUES(?, ?, ?, ?)`, [resolution.participantId, String(pending[2]), resolution.resolvedAt, resolution.resolvedAt]);
  }
  if ((resolution.outcome === "new" || resolution.outcome === "reuse") && resolution.participantId) {
    room.db.run(`INSERT OR IGNORE INTO alias_history(alias_key, alias_display, participant_id, assigned_at)
      VALUES(?, ?, ?, ?)`, [String(pending[0]), String(pending[1]), resolution.participantId, resolution.resolvedAt]);
    room.db.run("UPDATE memberships SET updated_at=? WHERE participant_id=?", [resolution.resolvedAt, resolution.participantId]);
  }
  room.db.run(`UPDATE pending_joins SET status=?, resolved_at=?, participant_id=?, reason=? WHERE request_id=?`,
    [resolutionStatus(resolution.outcome), resolution.resolvedAt, resolution.participantId || null, resolution.reason || null, resolution.requestId]);
}

function applyAliasRelease(room: RoomHandle, release: AliasRelease): void {
  const suffix = release.aliasKey ? " AND alias_key=?" : "";
  const params = release.aliasKey
    ? [release.releasedAt, release.participantId, release.aliasKey]
    : [release.releasedAt, release.participantId];
  room.db.run(`UPDATE alias_history SET released_at=? WHERE participant_id=? AND released_at IS NULL${suffix}`, params);
  room.db.run("UPDATE memberships SET updated_at=? WHERE participant_id=?", [release.releasedAt, release.participantId]);
}

function applyParticipantForget(room: RoomHandle, forget: ParticipantForget): void {
  applyAliasRelease(room, { participantId: forget.participantId, releasedAt: forget.forgottenAt });
  room.db.run("UPDATE memberships SET forgotten_at=?, updated_at=? WHERE participant_id=?",
    [forget.forgottenAt, forget.forgottenAt, forget.participantId]);
}

function applyAliasRename(room: RoomHandle, rename: AliasRename): void {
  applyAliasRelease(room, { participantId: rename.participantId, releasedAt: rename.renamedAt });
  room.db.run(`INSERT OR IGNORE INTO alias_history(alias_key, alias_display, participant_id, assigned_at)
    VALUES(?, ?, ?, ?)`, [rename.aliasKey, rename.alias, rename.participantId, rename.renamedAt]);
  room.db.run("UPDATE memberships SET updated_at=? WHERE participant_id=?", [rename.renamedAt, rename.participantId]);
}

function applyParticipantRole(room: RoomHandle, update: ParticipantRoleUpdate): void {
  room.db.run("UPDATE memberships SET role=?, updated_at=? WHERE participant_id=?",
    [update.role, update.updatedAt, update.participantId]);
}

function applyIdentityEntry(room: RoomHandle, entry: any): boolean {
  if (entry.op === "join.request" && entry.joinRequest) { applyJoinRequest(room, entry.joinRequest); return true; }
  if (entry.op === "join.resolve" && entry.resolution) { applyJoinResolution(room, entry.resolution); return true; }
  if (entry.op === "alias.release" && entry.aliasRelease) { applyAliasRelease(room, entry.aliasRelease); return true; }
  if (entry.op === "participant.forget" && entry.participantForget) { applyParticipantForget(room, entry.participantForget); return true; }
  if (entry.op === "alias.rename" && entry.aliasRename) { applyAliasRename(room, entry.aliasRename); return true; }
  if (entry.op === "participant.role" && entry.roleUpdate) { applyParticipantRole(room, entry.roleUpdate); return true; }
  return false;
}

function replayJournal(room: RoomHandle): number {
  let replayed = 0;
  let raw = "";
  try { raw = fs.readFileSync(room.journalPath, "utf-8"); }
  catch { return 0; }
  room.db.run("BEGIN");
  try {
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as any;
      if (entry.op === "append" && entry.message) { insertMessage(room, entry.message); replayed++; }
      if (entry.op === "lifecycle" && entry.event) { insertLifecycleEvent(room, entry.event); replayed++; }
      if (applyIdentityEntry(room, entry)) replayed++;
    }
    room.db.run("COMMIT");
  } catch (error) {
    room.db.run("ROLLBACK");
    throw error;
  }
  if (replayed) room.dirty = true;
  return replayed;
}

function readMessages(room: RoomHandle): PersistedMessage[] {
  const result = room.db.exec(`SELECT message_id, participant_id, alias_at_send, sender_kind,
    message_type, content, metadata_json, created_at FROM messages ORDER BY sequence`);
  if (!result.length) return [];
  return result[0].values.map((row: unknown[]) => ({
    id: String(row[0]), participantId: row[1] == null ? undefined : String(row[1]),
    aliasAtSend: String(row[2]), senderKind: String(row[3]), messageType: String(row[4]),
    content: String(row[5]), metadata: row[6] == null ? null : JSON.parse(String(row[6])),
    createdAt: Number(row[7]),
  }));
}

function atomicFlush(room: RoomHandle): { bytes: number } {
  if (room.flushTimer) { clearTimeout(room.flushTimer); room.flushTimer = undefined; }
  if (!room.dirty && fs.existsSync(room.dbPath)) return { bytes: fs.statSync(room.dbPath).size };
  let bytes = room.db.export();
  while (historyLimitBytes > 0 && bytes.length > historyLimitBytes) {
    const count = Number(room.db.exec("SELECT COUNT(*) FROM messages")[0]?.values?.[0]?.[0] || 0);
    if (count <= 1) break;
    room.db.run(`DELETE FROM messages WHERE sequence IN
      (SELECT sequence FROM messages ORDER BY sequence LIMIT ?)`, [Math.min(100, count - 1)]);
    bytes = room.db.export();
  }
  const tmp = room.dbPath + ".tmp";
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, room.dbPath);
  durableTruncate(room.journalPath);
  room.dirty = false;
  return { bytes: bytes.length };
}

function scheduleFlush(room: RoomHandle): void {
  if (room.flushTimer) return;
  room.flushTimer = setTimeout(() => {
    room.flushTimer = undefined;
    try { atomicFlush(room); }
    catch (error) { parentPort?.postMessage({ event: "flushError", roomId: room.roomId, error: (error as Error).message }); }
  }, flushDelayMs);
  room.flushTimer.unref?.();
}

function openRoom(roomId: string, roomName: string): { messages: PersistedMessage[]; replayed: number } {
  assertRoomId(roomId);
  const existing = rooms.get(roomId);
  if (existing) return { messages: readMessages(existing), replayed: 0 };
  const dir = path.join(rootDir, roomId);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "chatroom.db");
  const journalPath = path.join(dir, "chatroom.journal");
  const db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();
  db.run(SCHEMA);
  ensureMetadataColumns(db);
  ensureMembershipColumns(db);
  const now = Date.now();
  db.run(`INSERT INTO room_metadata(room_id, schema_version, current_name, state, created_at, updated_at)
    VALUES(?, 2, ?, 'active', ?, ?)
    ON CONFLICT(room_id) DO UPDATE SET current_name=excluded.current_name, state='active', updated_at=excluded.updated_at`,
  [roomId, roomName, now, now]);
  const room: RoomHandle = { roomId, roomName, dir, dbPath, journalPath, db, dirty: !fs.existsSync(dbPath) };
  rooms.set(roomId, room);
  const replayed = replayJournal(room);
  if (room.dirty) scheduleFlush(room);
  return { messages: readMessages(room), replayed };
}

function createRoom(roomId: string, roomName: string, credentials: RoomCredentialsMetadata): { messages: PersistedMessage[]; replayed: number } {
  assertRoomId(roomId);
  if (rooms.has(roomId) || fs.existsSync(path.join(rootDir, roomId, "chatroom.db"))) {
    throw new Error(`Room ${roomId} already exists.`);
  }
  const result = openRoom(roomId, roomName);
  const room = rooms.get(roomId)!;
  room.db.run(`UPDATE room_metadata SET schema_version=2, owner_installation_id=?, host_credential_hash=?, join_secret_hash=? WHERE room_id=?`,
    [credentials.ownerInstallationId, credentials.hostCredentialHash, credentials.joinSecretHash, roomId]);
  appendLifecycle(roomId, { id: randomUUID(), type: "room.created", payload: { roomName }, createdAt: Date.now(), state: "active" });
  atomicFlush(room);
  return result;
}

function listStoredRooms(): { roomId: string; roomName: string; state: "stored"; updatedAt: number; messageCount: number; ownerInstallationId?: string; hostCredentialHash?: string; joinSecretHash?: string; hostParticipantId?: string }[] {
  const result: { roomId: string; roomName: string; state: "stored"; updatedAt: number; messageCount: number; ownerInstallationId?: string; hostCredentialHash?: string; joinSecretHash?: string; hostParticipantId?: string }[] = [];
  if (!fs.existsSync(rootDir)) return result;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (fs.existsSync(path.join(rootDir, entry.name, "chatroom.lock"))) continue;
    const dbPath = path.join(rootDir, entry.name, "chatroom.db");
    if (!fs.existsSync(dbPath)) continue;
    let db: any;
    try {
      db = new SQL.Database(fs.readFileSync(dbPath));
      db.run(SCHEMA); ensureMetadataColumns(db); ensureMembershipColumns(db);
      const discovered: RoomHandle = {
        roomId: entry.name, roomName: "", dir: path.join(rootDir, entry.name), dbPath,
        journalPath: path.join(rootDir, entry.name, "chatroom.journal"), db, dirty: false,
      };
      replayJournal(discovered);
      const metadata = db.exec(`SELECT room_id, current_name, state, updated_at,
        owner_installation_id, host_credential_hash, join_secret_hash, host_participant_id FROM room_metadata LIMIT 1`)[0]?.values?.[0];
      if (!metadata) continue;
      if (String(metadata[2]) !== "stored") {
        insertLifecycleEvent(discovered, {
          id: randomUUID(), type: "room.deactivated", payload: { reason: "hub-restart" },
          createdAt: Date.now(), state: "stored",
        });
        discovered.dirty = true;
      }
      if (discovered.dirty) atomicFlush(discovered);
      const messageCount = Number(db.exec("SELECT COUNT(*) FROM messages")[0]?.values?.[0]?.[0] || 0);
      result.push({
        roomId: String(metadata[0]), roomName: String(metadata[1]), state: "stored", updatedAt: Number(metadata[3]), messageCount,
        ownerInstallationId: metadata[4] == null ? undefined : String(metadata[4]),
        hostCredentialHash: metadata[5] == null ? undefined : String(metadata[5]),
        joinSecretHash: metadata[6] == null ? undefined : String(metadata[6]),
        hostParticipantId: metadata[7] == null ? undefined : String(metadata[7]),
      });
    } catch { /* ignore corrupt/unrecognized room DB; caller can surface diagnostics later */ }
    finally { try { db?.close(); } catch { /* ignore */ } }
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}

function setRoomState(roomId: string, state: "active" | "stored"): void {
  const room = rooms.get(roomId);
  if (!room) throw new Error(`Room ${roomId} is not open in persistence worker.`);
  room.db.run("UPDATE room_metadata SET state=?, updated_at=? WHERE room_id=?", [state, Date.now(), roomId]);
  room.dirty = true;
  scheduleFlush(room);
}

function appendLifecycle(roomId: string, event: LifecycleEvent): void {
  const room = rooms.get(roomId);
  if (!room) throw new Error(`Room ${roomId} is not open in persistence worker.`);
  durableAppend(room.journalPath, JSON.stringify({ op: "lifecycle", event }) + "\n");
  room.db.run("BEGIN");
  try { insertLifecycleEvent(room, event); room.db.run("COMMIT"); }
  catch (error) { room.db.run("ROLLBACK"); throw error; }
  room.dirty = true;
  scheduleFlush(room);
}

function append(roomId: string, message: PersistedMessage): void {
  const room = rooms.get(roomId);
  if (!room) throw new Error(`Room ${roomId} is not open in persistence worker.`);
  durableAppend(room.journalPath, JSON.stringify({ op: "append", message }) + "\n");
  insertMessage(room, message);
  room.dirty = true;
  scheduleFlush(room);
}

function appendMany(roomId: string, messages: PersistedMessage[]): void {
  if (!messages.length) return;
  const room = rooms.get(roomId);
  if (!room) throw new Error(`Room ${roomId} is not open in persistence worker.`);
  durableAppend(room.journalPath, messages.map(message => JSON.stringify({ op: "append", message })).join("\n") + "\n");
  room.db.run("BEGIN");
  try { for (const message of messages) insertMessage(room, message); room.db.run("COMMIT"); }
  catch (error) { room.db.run("ROLLBACK"); throw error; }
  room.dirty = true;
  scheduleFlush(room);
}

function mutateIdentity(room: RoomHandle, entry: object): void {
  durableAppend(room.journalPath, JSON.stringify(entry) + "\n");
  room.db.run("BEGIN");
  try { applyIdentityEntry(room, entry); room.db.run("COMMIT"); }
  catch (error) { room.db.run("ROLLBACK"); throw error; }
  room.dirty = true;
  scheduleFlush(room);
}

function requestJoin(roomId: string, request: PendingJoinRequest): void {
  const room = rooms.get(roomId);
  if (!room) throw new Error(`Room ${roomId} is not open in persistence worker.`);
  const expectedKey = request.alias.trim().normalize("NFKC").toLocaleLowerCase();
  if (!request.requestId || !request.alias.trim() || request.alias.length > 60 || request.aliasKey !== expectedKey) throw new Error("Invalid Join request alias.");
  if (request.expiresAt <= request.requestedAt) throw new Error("Join request expiry must be after its request time.");
  if (scalar(room.db, "SELECT 1 FROM pending_joins WHERE request_id=?", [request.requestId])) throw new Error(`Join request ${request.requestId} already exists.`);
  if (scalar(room.db, "SELECT 1 FROM pending_joins WHERE alias_key=? AND status='pending'", [request.aliasKey])) throw new Error(`Alias "${request.alias}" is already reserved by a pending Join.`);
  if (scalar(room.db, "SELECT 1 FROM alias_history WHERE alias_key=? AND released_at IS NULL", [request.aliasKey])) throw new Error(`Alias "${request.alias}" is currently active.`);
  mutateIdentity(room, { op: "join.request", joinRequest: request });
}

function resolveJoin(roomId: string, resolution: JoinResolution): void {
  const room = rooms.get(roomId);
  if (!room) throw new Error(`Room ${roomId} is not open in persistence worker.`);
  const pending = room.db.exec(`SELECT alias_key, alias_display, status FROM pending_joins WHERE request_id=?`, [resolution.requestId])[0]?.values?.[0];
  if (!pending) throw new Error(`Pending Join ${resolution.requestId} was not found.`);
  if (String(pending[2]) !== "pending") throw new Error(`Pending Join ${resolution.requestId} is already resolved.`);
  if (resolution.outcome === "new" || resolution.outcome === "reuse") {
    if (!resolution.participantId) throw new Error("Approved Join requires a participant ID.");
    if (scalar(room.db, "SELECT 1 FROM alias_history WHERE alias_key=? AND released_at IS NULL", [String(pending[0])])) {
      throw new Error(`Alias "${String(pending[1])}" is currently active.`);
    }
    const membership = room.db.exec("SELECT forgotten_at FROM memberships WHERE participant_id=?", [resolution.participantId])[0]?.values?.[0];
    if (resolution.outcome === "new" && membership) throw new Error(`Participant ${resolution.participantId} already exists.`);
    if (resolution.outcome === "reuse" && !membership) throw new Error(`Participant ${resolution.participantId} was not found.`);
    if (resolution.outcome === "reuse" && membership?.[0] != null) throw new Error(`Participant ${resolution.participantId} was forgotten.`);
  }
  mutateIdentity(room, { op: "join.resolve", resolution });
}

function releaseAlias(roomId: string, release: AliasRelease): void {
  const room = rooms.get(roomId);
  if (!room) throw new Error(`Room ${roomId} is not open in persistence worker.`);
  const suffix = release.aliasKey ? " AND alias_key=?" : "";
  const params = release.aliasKey ? [release.participantId, release.aliasKey] : [release.participantId];
  if (!scalar(room.db, `SELECT 1 FROM alias_history WHERE participant_id=? AND released_at IS NULL${suffix}`, params)) return;
  mutateIdentity(room, { op: "alias.release", aliasRelease: release });
}

function forgetParticipant(roomId: string, forget: ParticipantForget): void {
  const room = rooms.get(roomId);
  if (!room) throw new Error(`Room ${roomId} is not open in persistence worker.`);
  const membership = room.db.exec("SELECT forgotten_at FROM memberships WHERE participant_id=?", [forget.participantId])[0]?.values?.[0];
  if (!membership) throw new Error(`Participant ${forget.participantId} was not found.`);
  if (membership[0] != null) return;
  mutateIdentity(room, { op: "participant.forget", participantForget: forget });
}

function renameAlias(roomId: string, rename: AliasRename): void {
  const room = rooms.get(roomId);
  if (!room) throw new Error(`Room ${roomId} is not open in persistence worker.`);
  const expectedKey = rename.alias.trim().normalize("NFKC").toLocaleLowerCase();
  if (!rename.alias.trim() || rename.alias.length > 60 || rename.aliasKey !== expectedKey) throw new Error("Invalid alias.");
  const membership = room.db.exec("SELECT forgotten_at FROM memberships WHERE participant_id=?", [rename.participantId])[0]?.values?.[0];
  if (!membership) throw new Error(`Participant ${rename.participantId} was not found.`);
  if (membership[0] != null) throw new Error(`Participant ${rename.participantId} was forgotten.`);
  if (scalar(room.db, "SELECT 1 FROM pending_joins WHERE alias_key=? AND status='pending'", [rename.aliasKey])) throw new Error(`Alias "${rename.alias}" is reserved by a pending Join.`);
  const owner = scalar(room.db, "SELECT participant_id FROM alias_history WHERE alias_key=? AND released_at IS NULL", [rename.aliasKey]);
  if (owner && String(owner) !== rename.participantId) throw new Error(`Alias "${rename.alias}" is currently active.`);
  mutateIdentity(room, { op: "alias.rename", aliasRename: rename });
}

function setParticipantRole(roomId: string, update: ParticipantRoleUpdate): void {
  const room = rooms.get(roomId);
  if (!room) throw new Error(`Room ${roomId} is not open in persistence worker.`);
  const membership = room.db.exec("SELECT forgotten_at FROM memberships WHERE participant_id=?", [update.participantId])[0]?.values?.[0];
  if (!membership) throw new Error(`Participant ${update.participantId} was not found.`);
  if (membership[0] != null) throw new Error(`Participant ${update.participantId} was forgotten.`);
  mutateIdentity(room, { op: "participant.role", roleUpdate: { ...update, role: update.role.slice(0, 120) } });
}

function identityState(roomId: string): object {
  const room = rooms.get(roomId);
  if (!room) throw new Error(`Room ${roomId} is not open in persistence worker.`);
  const rows = (sql: string) => room.db.exec(sql)[0]?.values || [];
  return {
    memberships: rows("SELECT participant_id, kind, role, created_at, updated_at, forgotten_at FROM memberships ORDER BY created_at, participant_id")
      .map((row: unknown[]) => ({ participantId: String(row[0]), kind: String(row[1]), role: String(row[2]), createdAt: Number(row[3]), updatedAt: Number(row[4]), forgottenAt: row[5] == null ? undefined : Number(row[5]) })),
    aliases: rows("SELECT alias_key, alias_display, participant_id, assigned_at, released_at FROM alias_history ORDER BY sequence")
      .map((row: unknown[]) => ({ aliasKey: String(row[0]), alias: String(row[1]), participantId: String(row[2]), assignedAt: Number(row[3]), releasedAt: row[4] == null ? undefined : Number(row[4]) })),
    pendingJoins: rows("SELECT request_id, alias_key, alias_display, kind, status, requested_at, expires_at, resolved_at, participant_id, reason FROM pending_joins ORDER BY requested_at, request_id")
      .map((row: unknown[]) => ({ requestId: String(row[0]), aliasKey: String(row[1]), alias: String(row[2]), kind: String(row[3]), status: String(row[4]), requestedAt: Number(row[5]), expiresAt: Number(row[6]), resolvedAt: row[7] == null ? undefined : Number(row[7]), participantId: row[8] == null ? undefined : String(row[8]), reason: row[9] == null ? undefined : String(row[9]) })),
  };
}

async function handle(request: WorkerRequest): Promise<unknown> {
  switch (request.op) {
    case "list": return listStoredRooms();
    case "open": return openRoom(String(request.roomId), String(request.roomName || ""));
    case "create": return createRoom(String(request.roomId), String(request.roomName || ""), request.credentials!);
    case "lifecycle": appendLifecycle(String(request.roomId), request.event!); return { ok: true };
    case "setState": setRoomState(String(request.roomId), request.state!); return { ok: true };
    case "append": append(String(request.roomId), request.message!); return { ok: true };
    case "appendMany": appendMany(String(request.roomId), request.messages || []); return { ok: true };
    case "requestJoin": requestJoin(String(request.roomId), request.joinRequest!); return { ok: true };
    case "resolveJoin": resolveJoin(String(request.roomId), request.resolution!); return { ok: true };
    case "releaseAlias": releaseAlias(String(request.roomId), request.aliasRelease!); return { ok: true };
    case "renameAlias": renameAlias(String(request.roomId), request.aliasRename!); return { ok: true };
    case "setParticipantRole": setParticipantRole(String(request.roomId), request.roleUpdate!); return { ok: true };
    case "forgetParticipant": forgetParticipant(String(request.roomId), request.participantForget!); return { ok: true };
    case "identityState": return identityState(String(request.roomId));
    case "flush": return atomicFlush(rooms.get(String(request.roomId))!);
    case "close": {
      const room = rooms.get(String(request.roomId));
      if (!room) return { ok: true };
      appendLifecycle(room.roomId, { id: randomUUID(), type: "room.deactivated", payload: { reason: request.reason || "closed" }, createdAt: Date.now(), state: "stored" });
      const result = atomicFlush(room); room.db.close(); rooms.delete(room.roomId); return result;
    }
    case "shutdown": {
      for (const room of rooms.values()) {
        appendLifecycle(room.roomId, { id: randomUUID(), type: "room.deactivated", payload: { reason: "hub-shutdown" }, createdAt: Date.now(), state: "stored" });
        atomicFlush(room); room.db.close();
      }
      rooms.clear(); return { ok: true };
    }
  }
}

(async () => {
  SQL = await initSqlJs({ locateFile: file => path.join(__dirname, file) });
  fs.mkdirSync(rootDir, { recursive: true });
  parentPort?.postMessage({ event: "ready" });
  parentPort?.on("message", async (request: WorkerRequest) => {
    try { parentPort?.postMessage({ id: request.id, ok: true, data: await handle(request) }); }
    catch (error) { parentPort?.postMessage({ id: request.id, ok: false, error: (error as Error).message }); }
  });
})().catch(error => parentPort?.postMessage({ event: "fatal", error: (error as Error).message }));
