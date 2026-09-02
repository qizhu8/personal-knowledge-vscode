import { AgentRuntimeState, ChatMessage, FileMeta, Frame, MAX_FILE_BYTES, Member, MemberKind, ReplyPolicy } from "./chatroom-protocol";
import { WebSocketServer, WebSocket } from "ws";
import { createServer, Server, IncomingMessage, ServerResponse } from "http";
import { networkInterfaces } from "os";
import { randomBytes, randomUUID, timingSafeEqual, createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { findCommand, BOT_NAME, CommandContext } from "./chat-commands";
import { createChatMagicLink, chatInviteMessage } from "./chat-magic-link";
import { browserViewHtml } from "./chatroom-browser";
import { ChatPersistence, PersistedChatMessage } from "./chat-persistence";
import { ChatRoomLifecycle, ActiveChatRoom, StoredChatRoom } from "./chat-room-lifecycle";
import { SecretStorageLike } from "./chat-room-credentials";
import { ChatJoinApprovalManager, JoinApprovalResult, PendingJoinApproval } from "./chat-join-approval";

function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ba.length !== bb.length) return false;
  try { return timingSafeEqual(ba, bb); } catch { return false; }
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ── Hub (relay server: HTTP browser view + WebSocket relay) ────────────────────
interface HubConn {
  id:     string;
  user:   string;
  room:   string;
  kind:   MemberKind;
  cid:    string;      // stable per-client id (distinguishes a reconnect from a clash)
  ws:     WebSocket;
  alive:  boolean;
  joined: boolean;
  participantId: string;
  pendingJoinId: string;
  resumeAfter: string;
  runtimeState: AgentRuntimeState;
  stateChangedAt: number;
  processing: Promise<void>;
}

interface RoomState {
  roomId: string;
  history: ChatMessage[];   // CHAT ONLY — never files
  owner:   string;          // creator's cid (or conn id) — room deactivates when they leave
  ownerName: string;
  graceTimer: NodeJS.Timeout | null;  // pending owner-departure deactivation
  roster: Map<string, RosterEntry>;   // everyone who has ever joined (present + departed)
  muted: Set<string>;                 // identity keys the host has muted (persists across reconnects)
  receipts: Map<string, { targets: Set<string>; readers: Set<string> }>;
}

// One identity's lifetime in a room. Keyed by a stable identity (cid) when the
// client provides one, else by display name — so reconnects don't create ghosts.
interface RosterEntry {
  key:       string;
  id:        string;       // most recent connection id
  user:      string;
  kind:      MemberKind;
  sid:       string;       // short stable id (the client's cid), "" if none
  verified:  boolean;      // identity is server-trusted (extension/MCP) vs best-effort (browser)
  present:   boolean;
  firstSeen: number;
  lastSeen:  number;
  role:      string;
  participantId: string;
}

export interface AdminRoomInfo { roomId: string; room: string; owner: string; members: number; }

export class ChatHub {
  private http:  Server | null = null;
  private wss:   WebSocketServer | null = null;
  private conns: Map<WebSocket, HubConn> = new Map();
  private rooms: Map<string, RoomState> = new Map();
  private roomSecret: Map<string, string> = new Map();   // per-room secret (creator sets it)
  private _port  = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private log: (m: string) => void;
  private static readonly HISTORY_MAX = 5000;       // hard ceiling on messages kept per room

  // Persistent chat archive (so history survives rejoin / room close / hub restart).
  private archiveDir = "";
  private historyLimitBytes = 10 * 1024 * 1024;     // configurable; 0 disables archiving
  private flushTimers: Map<string, NodeJS.Timeout> = new Map();
  private persistence?: ChatPersistence;
  private persistenceRoot = "";
  private storedRooms: StoredChatRoom[] = [];
  private lifecycle?: ChatRoomLifecycle;
  private installationId = "";
  private secretStorage?: SecretStorageLike;
  private approvals?: ChatJoinApprovalManager;
  private hostTokens = new Map<string, string>();
  private approvalChanged?: () => void;
  private advertisedHost = "";

  constructor(logger?: (m: string) => void) { this.log = logger ?? (() => {}); }

  get publicHost(): string { return this.advertisedHost || ChatHub.localIp(); }

  setAdvertisedHost(host: string): void {
    const value = String(host || "").trim();
    if (!value || !/^[a-z0-9](?:[a-z0-9.:-]*[a-z0-9])?$/i.test(value)) throw new Error("Invalid Chatroom advertised host.");
    this.advertisedHost = value;
    if (this.lifecycle && this.isRunning) {
      for (const [room, state] of this.rooms) this.lifecycle.publishActiveDescriptor(state.roomId, room, `ws://${this.publicHost}:${this.port}`);
    }
  }

  /** Point the hub at an on-disk archive dir and cap total bytes kept per room. */
  configureArchive(dir: string, limitBytes: number): void {
    this.archiveDir = dir || "";
    this.historyLimitBytes = Math.max(0, limitBytes | 0);
    if (this.archiveDir) { try { fs.mkdirSync(this.archiveDir, { recursive: true }); } catch { /* ignore */ } }
  }

  configurePersistence(rootDir: string, limitBytes: number): void {
    this.persistenceRoot = rootDir || "";
    this.historyLimitBytes = Math.max(0, limitBytes | 0);
  }

  configureLifecycle(rootDir: string, limitBytes: number, installationId: string, secretStorage: SecretStorageLike): void {
    this.persistenceRoot = rootDir || "";
    this.historyLimitBytes = Math.max(0, limitBytes | 0);
    this.installationId = installationId;
    this.secretStorage = secretStorage;
  }

  onApprovalsChanged(callback: () => void): void { this.approvalChanged = callback; }

  pendingApprovals(): PendingJoinApproval[] { return this.approvals?.list() || []; }

  async approveJoinNew(requestId: string): Promise<void> { await this.requireApprovals().approveNew(requestId); }
  async approveJoinReuse(requestId: string, participantId: string): Promise<void> { await this.requireApprovals().approveReuse(requestId, participantId); }
  async rejectJoin(requestId: string, reason?: string): Promise<void> { await this.requireApprovals().reject(requestId, reason); }

  private requireApprovals(): ChatJoinApprovalManager {
    if (!this.approvals) throw new Error("Join approval service is unavailable.");
    return this.approvals;
  }

  async renameStoredRoom(roomId: string, roomName: string): Promise<void> {
    await this.ensurePersistence();
    if (!this.lifecycle) throw new Error("Room lifecycle is unavailable.");
    await this.lifecycle.renameStoredRoom(roomId, roomName);
    this.storedRooms = await this.lifecycle.listStoredRooms();
  }

  async repairStoredRoom(roomId: string): Promise<{ roomId: string; roomName: string; messageCount: number; closedOrphans: number }> {
    await this.ensurePersistence();
    if (!this.lifecycle) throw new Error("Room lifecycle is unavailable.");
    const target = (await this.lifecycle.listStoredRooms()).find(room => room.roomId === roomId);
    if (!target) throw new Error(`Stored Room ${roomId} was not found.`);
    const roomName = ChatHub.canonRoom(target.roomName);
    const localMatches = [...this.rooms.entries()].filter(([name, state]) => state.roomId === roomId || name === roomName);
    for (const [name] of localMatches) {
      if (this.membersOf(name).length) throw new Error(`Room "${name}" still has connected members. Close it before repairing.`);
    }
    for (const [name] of localMatches) await this.deactivateRoom(name, "stored-room-repair");
    const repaired = await this.lifecycle.repairStoredRoom(roomId);
    this.storedRooms = await this.lifecycle.listStoredRooms();
    return { ...repaired, closedOrphans: localMatches.length };
  }

  async deleteStoredRoom(roomId: string): Promise<void> {
    await this.ensurePersistence();
    if (!this.lifecycle) throw new Error("Room lifecycle is unavailable.");
    await this.lifecycle.deleteStoredRoom(roomId);
    this.storedRooms = await this.lifecycle.listStoredRooms();
  }

  get port(): number { return this._port; }
  get isRunning(): boolean { return !!this.wss; }
  get roomNames(): string[] { return [...this.rooms.keys()]; }

  // Canonical room identity: trim, collapse internal whitespace, and case-fold so
  // "General", " general ", and "general" all resolve to ONE room per host (no
  // confusing same-name duplicates).
  static canonRoom(name: string | undefined): string {
    return (name || "general").trim().replace(/\s+/g, " ").toLowerCase().slice(0, 80) || "general";
  }

  // ── Admin (available to the local hub owner) ──────────────────────────────
  adminRooms(): AdminRoomInfo[] {
    return [...this.rooms.keys()].map(room => ({
      roomId: this.rooms.get(room)?.roomId || "",
      room,
      owner: this.rooms.get(room)?.ownerName || "—",
      members: this.membersOf(room).length,
    }));
  }
  async adminCloseRoom(room: string): Promise<void> { await this.deactivateRoom(room, "closed by admin"); }
  async adminCloseAll(): Promise<void> { for (const room of [...this.rooms.keys()]) await this.deactivateRoom(room, "closed by admin"); }

  async renameActiveRoom(roomId: string, roomName: string): Promise<string> {
    await this.ensurePersistence();
    if (!this.lifecycle) throw new Error("Room lifecycle is unavailable.");
    const current = [...this.rooms.entries()].find(([, state]) => state.roomId === roomId);
    if (!current) throw new Error(`Active Room ${roomId} was not found.`);
    const [previousRoom, state] = current;
    const nextRoom = ChatHub.canonRoom(roomName);
    if (nextRoom !== previousRoom && this.rooms.has(nextRoom)) throw new Error(`An active Room named "${nextRoom}" already exists.`);
    await this.lifecycle.renameActiveRoom(roomId, nextRoom);
    this.lifecycle.publishActiveDescriptor(roomId, nextRoom, `ws://${this.publicHost}:${this.port}`);
    if (nextRoom === previousRoom) return nextRoom;
    this.rooms.delete(previousRoom);
    this.rooms.set(nextRoom, state);
    const secret = this.roomSecret.get(previousRoom);
    const hostToken = this.hostTokens.get(previousRoom);
    this.roomSecret.delete(previousRoom);
    this.hostTokens.delete(previousRoom);
    if (secret) this.roomSecret.set(nextRoom, secret);
    if (hostToken) this.hostTokens.set(nextRoom, hostToken);
    const members = [...this.conns.values()].filter(conn => conn.joined && conn.room === previousRoom);
    for (const conn of members) {
      conn.room = nextRoom;
      this.sendTo(conn.ws, { t: "room.renamed", room: nextRoom, previousRoom });
    }
    this.log(`room ${previousRoom} renamed to ${nextRoom}`);
    return nextRoom;
  }

  async listStoredRooms(): Promise<StoredChatRoom[]> {
    await this.ensurePersistence();
    if (!this.lifecycle) return this.storedRooms;
    this.storedRooms = await this.lifecycle.listStoredRooms();
    return this.storedRooms;
  }

  private async ensurePersistence(): Promise<void> {
    if (!this.persistenceRoot || this.persistence) return;
    if (this.installationId && this.secretStorage) {
      this.lifecycle = new ChatRoomLifecycle(this.persistenceRoot, this.installationId, this.secretStorage, 500, this.historyLimitBytes, message => this.log(message));
      this.persistence = this.lifecycle.persistence;
      this.approvals = new ChatJoinApprovalManager(
        this.persistence,
        (roomId, participantId) => [...this.conns.values()].some(conn => conn.joined && this.rooms.get(conn.room)?.roomId === roomId && conn.participantId === participantId),
        120_000,
        () => this.approvalChanged?.(),
      );
      this.storedRooms = await this.lifecycle.listStoredRooms();
    } else {
      this.persistence = new ChatPersistence(this.persistenceRoot, 500, this.historyLimitBytes, message => this.log(message));
      this.storedRooms = (await this.persistence.listStoredRooms()).map(room => ({
        roomId: room.roomId,
        roomName: room.roomName,
        updatedAt: room.updatedAt,
        messageCount: room.messageCount,
        canRehost: false,
        unavailableReason: "Room lifecycle credentials are not configured.",
      }));
    }
  }

  async start(port: number): Promise<void> {
    if (this.wss) return;
    await this.ensurePersistence();
    await new Promise<void>((resolve, reject) => {
      const httpServer = createServer((req, res) => this.onHttp(req, res));
      // Attach the error handler BEFORE listening so a bind failure (e.g. port in
      // use) rejects cleanly instead of surfacing as an unhandled 'error' event.
      const onListenError = (err: NodeJS.ErrnoException) => {
        try { httpServer.close(); } catch { /* ignore */ }
        const msg = err.code === "EADDRINUSE"
          ? `Port ${port} is already in use. Stop the other hub or change personalKnowledge.chatHubPort.`
          : err.code === "EACCES"
            ? `Port ${port} needs elevated privileges. Pick a port above 1024 in personalKnowledge.chatHubPort.`
            : (err.message || String(err));
        const wrapped = new Error(msg);
        (wrapped as NodeJS.ErrnoException).code = err.code;   // preserve for fallback logic
        reject(wrapped);
      };
      httpServer.once("error", onListenError);
      httpServer.listen(port, "0.0.0.0", () => {
        httpServer.removeListener("error", onListenError);
        // Only now that the bind succeeded do we create the WS server.
        const wss = new WebSocketServer({ server: httpServer });
        wss.on("connection", ws => this.onConnection(ws));
        wss.on("error", e => this.log(`chat hub wss error: ${(e as Error).message}`));
        httpServer.on("error", e => this.log(`chat hub http error: ${(e as Error).message}`));
        this._port = (httpServer.address() as any).port;
        this.http = httpServer;
        this.wss  = wss;
        resolve();
      });
    });
    this.heartbeat = setInterval(() => this.sweep(), 30_000);
    this.heartbeat.unref?.();
    this.log(`chat hub listening on ${this._port} (ws + browser view)`);
  }

  async createRoom(roomName: string, requestedJoinSecret?: string): Promise<{ roomId: string; room: string; secret: string; hostToken: string }> {
    if (!this.lifecycle) throw new Error("Chat Hub lifecycle is not configured or running.");
    const room = ChatHub.canonRoom(roomName);
    this.storedRooms = await this.lifecycle.listStoredRooms();
    if (this.rooms.has(room) || this.storedRooms.some(item => ChatHub.canonRoom(item.roomName) === room)) {
      throw new Error(`A Room named "${room}" already exists. Rehost the stored Room instead.`);
    }
    const active = await this.lifecycle.createRoom(room, requestedJoinSecret);
    this.lifecycle.publishActiveDescriptor(active.roomId, room, `ws://${this.publicHost}:${this.port}`);
    if (!active.messages.length) {
      const legacy = this.readLegacyArchive(room);
      if (legacy.length) {
        await this.lifecycle.persistence.appendMany(active.roomId, legacy.map(message => this.toPersisted(message)));
        active.messages.push(...legacy.map(message => this.toPersisted(message)));
      }
    }
    this.installActiveRoom(active);
    const hostToken = randomBytes(24).toString("base64url");
    this.hostTokens.set(room, hostToken);
    return { roomId: active.roomId, room, secret: active.joinSecret, hostToken };
  }

  async rehostRoom(roomId: string): Promise<{ roomId: string; room: string; secret: string; hostToken: string }> {
    if (!this.lifecycle) throw new Error("Chat Hub lifecycle is not configured or running.");
    const active = await this.lifecycle.rehostRoom(roomId);
    const room = ChatHub.canonRoom(active.roomName);
    this.lifecycle.publishActiveDescriptor(active.roomId, room, `ws://${this.publicHost}:${this.port}`);
    if (this.rooms.has(room)) {
      await this.lifecycle.deactivateRoom(roomId, "name-conflict");
      throw new Error(`An active Room named "${room}" already exists.`);
    }
    this.installActiveRoom(active);
    const hostToken = randomBytes(24).toString("base64url");
    this.hostTokens.set(room, hostToken);
    return { roomId, room, secret: active.joinSecret, hostToken };
  }

  private installActiveRoom(active: ActiveChatRoom): void {
    const room = ChatHub.canonRoom(active.roomName);
    const roster = new Map<string, RosterEntry>();
    for (const membership of active.identityState.memberships) {
      if (membership.forgottenAt != null) continue;
      const alias = [...active.identityState.aliases].reverse().find(item => item.participantId === membership.participantId);
      if (!alias) continue;
      const key = `participant:${membership.participantId}`;
      roster.set(key, {
        key,
        id: `stored:${membership.participantId}`,
        user: alias.alias,
        kind: membership.kind === "agent" ? "agent" : membership.kind === "browser" ? "browser" : "human",
        sid: membership.participantId.slice(0, 8),
        participantId: membership.participantId,
        verified: membership.kind !== "browser",
        present: false,
        firstSeen: membership.createdAt,
        lastSeen: membership.updatedAt,
        role: membership.role || "",
      });
    }
    const ownerName = active.hostParticipantId
      ? roster.get(`participant:${active.hostParticipantId}`)?.user || ""
      : "";
    const state: RoomState = {
      roomId: active.roomId, history: active.messages.map(message => this.fromPersisted(message)),
      owner: active.hostParticipantId || "", ownerName, graceTimer: null, roster, muted: new Set(),
      receipts: new Map(),
    };
    this.rooms.set(room, state);
    this.roomSecret.set(room, active.joinSecret);
    this.trimHistory(state);
  }

  async stop(): Promise<void> {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    for (const room of [...this.rooms.keys()]) await this.deactivateRoom(room, "hub-shutdown");
    for (const t of this.flushTimers.values()) clearTimeout(t);
    this.flushTimers.clear();
    for (const c of this.conns.values()) { try { c.ws.close(); } catch { /* ignore */ } }
    this.conns.clear();
    this.rooms.clear();
    try { this.wss?.close(); } catch { /* ignore */ }
    try { this.http?.close(); } catch { /* ignore */ }
    this.wss = null; this.http = null; this._port = 0;
    if (this.lifecycle) {
      await this.lifecycle.dispose();
      this.lifecycle = undefined;
      this.persistence = undefined;
      this.approvals = undefined;
      this.storedRooms = [];
    } else if (this.persistence) {
      await this.persistence.dispose();
      this.persistence = undefined;
      this.storedRooms = [];
    }
    this.log("chat hub stopped");
  }

  // Serve the browser view (a self-contained monitoring/participation page).
  private onHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url || "/";
    if (req.method === "GET" && (url === "/" || url.startsWith("/?") || url.startsWith("/room"))) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(browserViewHtml());
      return;
    }
    if (req.method === "GET" && url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        rooms: this.roomNames.length,
        members: this.conns.size,
        activeRooms: [...this.rooms.entries()].map(([room, state]) => ({ room, roomId: state.roomId })),
      }));
      return;
    }
    res.writeHead(404); res.end("Not found");
  }

  private roomState(room: string): RoomState {
    let s = this.rooms.get(room);
    if (!s) {
      s = {
        roomId: randomUUID(), history: [], owner: "", ownerName: "", graceTimer: null,
        roster: new Map(), muted: new Set(),
        receipts: new Map(),
      };
      this.rooms.set(room, s);
      this.loadArchive(room, s);   // restore prior chat so rejoiners see history
    }
    return s;
  }

  private async ensureRoomState(room: string): Promise<RoomState> {
    const existing = this.rooms.get(room);
    if (existing) return existing;
    const stored = this.storedRooms.find(candidate => ChatHub.canonRoom(candidate.roomName) === room);
    const roomId = stored?.roomId || randomUUID();
    let history: ChatMessage[] = [];
    if (this.persistence) {
      const opened = await this.persistence.openRoom(roomId, room);
      history = opened.messages.map(message => this.fromPersisted(message));
      if (!stored && !history.length) {
        const legacy = this.readLegacyArchive(room);
        if (legacy.length) {
          await this.persistence.appendMany(roomId, legacy.map(message => this.toPersisted(message)));
          history = legacy;
        }
      }
    } else {
      const temporary = this.roomState(room);
      temporary.roomId = roomId;
      return temporary;
    }
    const state: RoomState = {
      roomId, history, owner: "", ownerName: "", graceTimer: null,
      roster: new Map(), muted: new Set(),
      receipts: new Map(),
    };
    this.rooms.set(room, state);
    this.trimHistory(state);
    return state;
  }

  private readLegacyArchive(room: string): ChatMessage[] {
    if (!this.archiveDir || this.historyLimitBytes <= 0) return [];
    try { const value = JSON.parse(fs.readFileSync(this.archivePath(room), "utf-8")); return Array.isArray(value) ? value : []; }
    catch { return []; }
  }

  private toPersisted(message: ChatMessage): PersistedChatMessage {
    return {
      id: message.id, participantId: message.fromId || undefined,
      aliasAtSend: message.from || "system", senderKind: message.kind,
      messageType: message.system ? "system" : message.file ? "file" : "chat",
      content: message.text, metadata: { system: message.system, file: message.file, receipt: message.receipt,
        responseRequired: message.responseRequired, replyPolicy: message.replyPolicy, mode: message.mode,
        discussionAudience: message.discussionAudience, replyToMessageId: message.replyToMessageId,
        recipients: message.recipients },
      createdAt: message.ts,
    };
  }

  private fromPersisted(message: PersistedChatMessage): ChatMessage {
    const metadata = (message.metadata || {}) as any;
    return { id: message.id, from: message.aliasAtSend, fromId: message.participantId || "", text: message.content,
      ts: message.createdAt, kind: message.senderKind as MemberKind, system: !!metadata.system,
      file: metadata.file, receipt: metadata.receipt, responseRequired: metadata.responseRequired,
      replyPolicy: metadata.replyPolicy, mode: metadata.mode, discussionAudience: metadata.discussionAudience,
      replyToMessageId: metadata.replyToMessageId, recipients: metadata.recipients };
  }

  // ── Persistent chat archive ───────────────────────────────────────────────
  private archivePath(room: string): string {
    // Hash the room name so any characters (spaces, unicode, slashes) are FS-safe.
    const h = createHash("sha1").update(room).digest("hex").slice(0, 16);
    return path.join(this.archiveDir, `room-${h}.json`);
  }

  private loadArchive(room: string, s: RoomState): void {
    if (!this.archiveDir || this.historyLimitBytes <= 0) return;
    try {
      const raw = fs.readFileSync(this.archivePath(room), "utf-8");
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) { s.history = arr as ChatMessage[]; this.trimHistory(s); }
    } catch { /* no archive yet */ }
  }

  // Keep history under both the byte budget and the hard message ceiling (drop oldest).
  private trimHistory(s: RoomState): void {
    if (s.history.length > ChatHub.HISTORY_MAX) s.history.splice(0, s.history.length - ChatHub.HISTORY_MAX);
    if (this.historyLimitBytes > 0) {
      let bytes = Buffer.byteLength(JSON.stringify(s.history), "utf-8");
      while (s.history.length > 1 && bytes > this.historyLimitBytes) {
        const drop = s.history.shift();
        bytes -= Buffer.byteLength(JSON.stringify(drop), "utf-8") + 1;
      }
    }
  }

  // Debounced write so a burst of messages costs one flush.
  private scheduleFlush(room: string): void {
    if (!this.archiveDir || this.historyLimitBytes <= 0) return;
    if (this.flushTimers.has(room)) return;
    const t = setTimeout(() => { this.flushTimers.delete(room); this.flushArchive(room); }, 800);
    t.unref?.();
    this.flushTimers.set(room, t);
  }

  private flushArchive(room: string): void {
    if (!this.archiveDir || this.historyLimitBytes <= 0) return;
    const s = this.rooms.get(room);
    if (!s) return;
    try {
      const tmp = this.archivePath(room) + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(s.history), "utf-8");
      fs.renameSync(tmp, this.archivePath(room));   // atomic replace
    } catch (e) { this.log(`chat archive write failed for ${room}: ${(e as Error).message}`); }
  }

  // Kick everyone out of a room and drop all of its state (no zombie rooms).
  private async deactivateRoom(room: string, reason: string): Promise<void> {
    const st = this.rooms.get(room);
    if (st?.graceTimer) { clearTimeout(st.graceTimer); st.graceTimer = null; }
    const flush = this.flushTimers.get(room);
    if (flush) { clearTimeout(flush); this.flushTimers.delete(room); }
    this.rooms.delete(room);   // remove first so onClose treats these as already-gone
    this.roomSecret.delete(room);
    this.hostTokens.delete(room);
    if (st && this.approvals) await this.approvals.cancelRoom(st.roomId, reason);
    if (st && this.lifecycle) await this.lifecycle.deactivateRoom(st.roomId, reason);
    else this.flushArchive(room);
    const members = [...this.conns.values()].filter(c => c.joined && c.room === room);
    for (const c of members) {
      this.sendTo(c.ws, { t: "closed", room, reason });
      this.conns.delete(c.ws);
      try { c.ws.close(); } catch { /* ignore */ }
    }
    this.log(`room ${room} deactivated: ${reason}`);
  }

  private onConnection(ws: WebSocket): void {
    const conn: HubConn = { id: randomBytes(4).toString("hex"), user: "", room: "", kind: "human", cid: "", ws, alive: true, joined: false, participantId: "", pendingJoinId: "", resumeAfter: "", runtimeState: "idle", stateChangedAt: Date.now(), processing: Promise.resolve() };
    this.conns.set(ws, conn);
    ws.on("pong", () => { conn.alive = true; });
    ws.on("message", raw => {
      conn.processing = conn.processing.then(() => this.onMessage(conn, raw.toString()))
        .catch(error => this.log(`chat frame failed for ${conn.user || "pending"}: ${(error as Error).message}`));
    });
    ws.on("close", () => { void this.onClose(conn); });
    ws.on("error", () => { try { ws.close(); } catch { /* ignore */ } });
  }

  private async onMessage(conn: HubConn, raw: string): Promise<void> {
    let frame: Frame;
    try { frame = JSON.parse(raw); } catch { return; }

    if (frame.t === "ping") { this.sendTo(conn.ws, { t: "pong" }); return; }
    if (frame.t === "pong") { conn.alive = true; return; }

    if (conn.joined && frame.t === "leave") {
      await this.leaveConnection(conn);
      return;
    }

    if (conn.joined && frame.t === "admin") {
      await this.handleAdmin(conn, frame);
      return;
    }

    if (conn.joined && frame.t === "agent.state") {
      if (conn.kind !== "agent") return;
      conn.runtimeState = frame.state;
      conn.stateChangedAt = Date.now();
      this.broadcast(conn.room, {
        t: "agent.state", room: conn.room, user: conn.user,
        state: frame.state, ts: conn.stateChangedAt,
      });
      this.broadcastPresence(conn.room);
      return;
    }

    if (!conn.joined) {
      if (conn.pendingJoinId) {
        this.sendTo(conn.ws, { t: "error", code: "join-pending", msg: "This Join is assigning its Room identity automatically." });
        return;
      }
      if (frame.t !== "join") { this.sendTo(conn.ws, { t: "error", code: "not-joined", msg: "join first" }); return; }
      const desired = (frame.user || "anon").slice(0, 60);
      const room    = ChatHub.canonRoom(frame.room);
      const cid     = (frame.cid  || "").slice(0, 32);
      const token   = frame.token ?? "";
      const kind: MemberKind = frame.kind === "agent" ? "agent" : frame.kind === "browser" ? "browser" : "human";
      const nameKey = desired.trim().normalize("NFKC").toLocaleLowerCase();
      const existingState = this.rooms.get(room);
      if (frame.roomId && existingState?.roomId !== frame.roomId) {
        this.sendTo(conn.ws, { t: "error", code: "room-mismatch", msg: `Room identity does not match the active Room "${room}".` });
        try { conn.ws.close(); } catch { /* ignore */ }
        return;
      }
      const known = this.roomSecret.get(room);
      if (known !== undefined) {
        if (!constantTimeEquals(token, known)) {
          this.sendTo(conn.ws, { t: "error", code: "auth", msg: `Wrong secret for room "${room}".` });
          try { conn.ws.close(); } catch { /* ignore */ }
          return;
        }
      } else {
        this.sendTo(conn.ws, { t: "error", code: "no-room", msg: `Room "${room}" isn't active. Ask the Host to Create or Rehost it.` });
        try { conn.ws.close(); } catch { /* ignore */ }
        return;
      }
      conn.user = desired;
      conn.room = room;
      conn.cid  = cid;
      conn.kind = kind;
      conn.resumeAfter = String(frame.resumeAfter || "").slice(0, 120);
      const st = existingState || await this.ensureRoomState(room);
      if (!this.approvals || !this.persistence) throw new Error("Automatic Room identity assignment is unavailable.");
      const isHost = kind === "human" && !!frame.hostToken && constantTimeEquals(frame.hostToken, this.hostTokens.get(room) || "");
      const sameAlias = [...this.conns.values()].filter(other => other !== conn && other.room === room &&
        other.user.trim().normalize("NFKC").toLocaleLowerCase() === nameKey && (other.joined || !!other.pendingJoinId));
      const reconnect = sameAlias.find(other => !!cid && other.cid === cid);
      if (!reconnect && sameAlias.length) {
        this.sendTo(conn.ws, { t: "error", code: "name-taken", msg: `Alias "${desired}" is already active.` });
        try { conn.ws.close(); } catch { /* ignore */ }
        return;
      }
      let reconnectParticipantId = "";
      if (reconnect) {
        reconnectParticipantId = reconnect.participantId;
        if (reconnect.pendingJoinId) {
          await this.approvals.cancelConnection(reconnect.id, "Superseded by a newer connection.");
          reconnect.pendingJoinId = "";
        }
        if (reconnect.joined && reconnectParticipantId) {
          reconnect.joined = false;
          await this.persistence.releaseAlias(st.roomId, reconnectParticipantId, Date.now(), reconnect.user);
        }
        this.conns.delete(reconnect.ws);
        try { reconnect.ws.close(); } catch { /* ignore */ }
      }
      let pending;
      try {
        pending = await this.approvals.request(st.roomId, conn.id, desired, cid || `connection:${conn.id}`, kind);
      } catch (error) {
        this.sendTo(conn.ws, { t: "error", code: "join-failed", msg: (error as Error).message });
        try { conn.ws.close(); } catch { /* ignore */ }
        return;
      }
      conn.pendingJoinId = pending.approval.requestId;
      if (isHost && st.owner) {
        await this.approvals.approveReuse(pending.approval.requestId, st.owner);
      } else if (reconnectParticipantId) {
        await this.approvals.approveReuse(pending.approval.requestId, reconnectParticipantId);
      } else if (isHost) {
        if (st.owner) await this.approvals.approveReuse(pending.approval.requestId, st.owner);
        else await this.approvals.approveNew(pending.approval.requestId);
      } else {
        await this.approvals.approveAutomatic(pending.approval.requestId);
      }
      void pending.result.then(result => this.finishJoin(conn, result, isHost)).catch(error => {
        this.sendTo(conn.ws, { t: "error", code: "join-failed", msg: (error as Error).message });
        try { conn.ws.close(); } catch { /* ignore */ }
      });
      return;
    }

    if (frame.t === "msg") {
      const text = (frame.text ?? "").toString().slice(0, 8000);
      if (!text.trim()) return;
      const clientRequestId = String(frame.clientRequestId || "").slice(0, 120);
      const rejectMessage = (code: string, msg: string) => this.sendTo(conn.ws, {
        t: "error", code, msg, clientRequestId: clientRequestId || undefined,
        correctable: true, connectionAlive: true,
      });
      // Slash commands are intercepted and answered privately. /leave remains a
      // visible Room event; /stop is handled above as a structured lifecycle action.
      const head = text.trim().split(/\s+/)[0].toLowerCase();
      if (head === "/stop") { await this.stopAgentConnections(conn, text); return; }
      if (text.trim().startsWith("/") && head !== "/leave") { await this.handleCommand(conn, text.trim()); return; }
      const roomState = this.roomState(conn.room);
      const structuredRecipients = Array.isArray(frame.recipients)
        ? frame.recipients.map(name => String(name || "").trim()).filter(Boolean).slice(0, 64)
        : [];
      const requestedRecipients = structuredRecipients.length ? structuredRecipients : this.allMentionNames(text);
      const recipientNames = this.validRecipientNames(roomState, conn, requestedRecipients);
      if (!text.trim().startsWith("/") && !recipientNames.length) {
        rejectMessage("mention-required", "Every Chatroom message must address @all or a specific @participant.");
        return;
      }
      if (this.isMuted(conn)) { rejectMessage("muted", "You are muted by the host and can't post right now."); return; }
      const bodyBroadcastRequested = this.allMentionNames(text).some(name => name.toLowerCase() === "all" || name.toLowerCase() === "everyone");
      const broadcastRequested = bodyBroadcastRequested || recipientNames.some(name => name === "all" || name === "everyone");
      if (broadcastRequested && !this.isOwnerConn(roomState, conn)) {
        rejectMessage("host-only-broadcast", "Only the Room Host can use @all. Address specific participants instead.");
        return;
      }
      const m: ChatMessage = {
        id: randomBytes(6).toString("hex"), from: conn.user, fromId: conn.participantId,
        text, ts: Date.now(), kind: conn.kind,
        replyPolicy: (["none", "required", "optional"] as ReplyPolicy[]).includes(frame.replyPolicy as ReplyPolicy)
          ? frame.replyPolicy as ReplyPolicy
          : typeof frame.requireReply === "boolean"
            ? frame.requireReply ? "required" : "none"
            : typeof frame.responseRequired === "boolean"
              ? frame.responseRequired ? "required" : "none"
              : "required",
        mode: conn.kind === "human" && this.isOwnerConn(roomState, conn) && ["announce", "ask", "discuss"].includes(String(frame.mode))
          ? frame.mode as "announce" | "ask" | "discuss" : undefined,
        replyToMessageId: String(frame.replyToMessageId || "").slice(0, 120) || undefined,
        recipients: recipientNames,
      };
      const targets = this.mentionTargets(conn.room, conn, text, recipientNames);
      m.responseRequired = m.replyPolicy === "required";
      if (m.mode === "discuss") {
        m.discussionAudience = this.discussionAudience(roomState, conn, recipientNames);
      }
      if (targets.size) {
        roomState.receipts.set(m.id, { targets, readers: new Set() });
        m.receipt = { read: 0, total: targets.size };
      }
      await this.remember(conn.room, m);
      if (targets.size) this.broadcastReceiptMessage(conn.room, m, targets);
      else this.broadcast(conn.room, { t: "msg", room: conn.room, ...m });
      if (clientRequestId) this.sendTo(conn.ws, { t: "msg.accepted", room: conn.room, clientRequestId, messageId: m.id });
      if (head === "/leave") await this.leaveConnection(conn);
      return;
    }

    if (frame.t === "msg.read") {
      const receipt = this.roomState(conn.room).receipts.get(frame.messageId);
      if (!receipt) return;
      const reader = this.identityKey(conn);
      if (!receipt.targets.has(reader) || receipt.readers.has(reader)) return;
      receipt.readers.add(reader);
      const count = { read: receipt.readers.size, total: receipt.targets.size };
      const message = this.roomState(conn.room).history.find(item => item.id === frame.messageId);
      if (message) message.receipt = count;
      this.broadcast(conn.room, {
        t: "msg.read", room: conn.room, messageId: frame.messageId,
        ...count,
      });
      return;
    }

    if (frame.t === "file.offer") {
      const f = frame.file;
      if (!f || typeof f.size !== "number" || f.size > MAX_FILE_BYTES) return;
      if (this.isMuted(conn)) { this.sendTo(conn.ws, { t: "error", code: "muted", msg: "You are muted by the host and can't share files right now." }); return; }
      // Record a CHAT note (not the bytes) so late joiners see a file was shared.
      const note: ChatMessage = {
        id: randomBytes(6).toString("hex"), from: conn.user, fromId: conn.participantId,
        text: `📎 shared a file: ${f.name} (${humanSize(f.size)})`,
        ts: Date.now(), kind: conn.kind, file: f,
      };
      await this.remember(conn.room, note);
      // Relay the live offer to everyone EXCEPT the sender.
      this.broadcast(conn.room, { t: "file.offer", room: conn.room, from: conn.user, fromId: conn.participantId, ts: note.ts, kind: conn.kind, file: f }, conn.ws);
      // Echo the chat note back to the sender so their own UI shows it.
      this.sendTo(conn.ws, { t: "msg", room: conn.room, ...note });
      return;
    }

    if (frame.t === "file.chunk") {
      // Pure live relay — never stored on the hub.
      if (this.isMuted(conn)) return;
      this.broadcast(conn.room, frame, conn.ws);
      return;
    }
  }

  private async finishJoin(conn: HubConn, result: JoinApprovalResult, isHost: boolean): Promise<void> {
    if (!this.conns.has(conn.ws) || !conn.pendingJoinId) return;
    conn.pendingJoinId = "";
    if (result.outcome !== "new" && result.outcome !== "reuse") {
      const code = result.outcome === "timeout" ? "join-timeout" : result.outcome === "reject" ? "join-rejected" : "join-cancelled";
      this.sendTo(conn.ws, { t: "error", code, msg: result.reason || `Join ${result.outcome}.` });
      try { conn.ws.close(); } catch { /* ignore */ }
      return;
    }
    if (!result.participantId) throw new Error("Approved Join has no participant ID.");
    conn.participantId = result.participantId;
    conn.joined = true;
    const st = this.rooms.get(conn.room);
    if (!st) { try { conn.ws.close(); } catch { /* ignore */ } return; }
    const identityAlreadyPresent = this.hasOtherIdentityConnection(conn);
    if (isHost) {
      if (st.owner !== conn.participantId) {
        st.owner = conn.participantId;
        await this.persistence?.recordLifecycle(st.roomId, "room.host_assigned", undefined, { participantId: conn.participantId });
      }
      st.ownerName = conn.user;
    }
    if (this.isOwnerConn(st, conn) && st.graceTimer) {
      clearTimeout(st.graceTimer); st.graceTimer = null;
    }
    this.log(`join approved room=${conn.room} participant=${conn.participantId} user=${conn.user} outcome=${result.outcome}`);
    const prevName = this.rosterJoin(conn, st);
    this.sendTo(conn.ws, { t: "join.approved", room: conn.room, participantId: conn.participantId, outcome: result.outcome });
    if (st.history.length) {
      const resumeIndex = conn.resumeAfter ? st.history.findIndex(message => message.id === conn.resumeAfter) : -1;
      const mode = conn.resumeAfter && resumeIndex >= 0 ? "catchup" : "baseline";
      const messages = mode === "catchup" ? st.history.slice(resumeIndex + 1) : st.history;
      this.sendTo(conn.ws, { t: "history", room: conn.room, mode, messages });
    }
    if (!identityAlreadyPresent) {
      const joinText = (prevName && prevName !== conn.user)
        ? `${prevName} rejoined with new name ${conn.user}`
        : `${conn.user} joined the room`;
      this.broadcast(conn.room, { t: "system", room: conn.room, text: joinText, ts: Date.now() });
    }
    this.broadcastPresence(conn.room);
    this.sendTo(conn.ws, { t: "join.ready", room: conn.room });
    if (conn.kind === "agent") this.broadcast(conn.room, { t: "agent.state", room: conn.room, user: conn.user, state: "idle", ts: conn.stateChangedAt });
    if (isHost) this.sendHelp(conn, `👋 Welcome — you're now hosting "${conn.room}". Here are the magic messages you can type:`);
  }

  private async leaveConnection(conn: HubConn): Promise<void> {
    // Multiple VS Code windows can share one stable identity. Leaving one
    // window must not deactivate the Room while another owner window remains.
    const state = this.rooms.get(conn.room);
    if (state && this.isOwnerConn(state, conn) && !this.hasOtherIdentityConnection(conn)) {
      await this.deactivateRoom(conn.room, "host left");
    } else {
      try { conn.ws.close(); } catch { /* ignore */ }
    }
  }

  private async stopAgentConnections(requester: HubConn, text: string): Promise<void> {
    const state = this.rooms.get(requester.room);
    if (!state || !this.isOwnerConn(state, requester)) {
      this.botReply(requester, "Only the room host can stop agents.");
      return;
    }
    const requested = this.leadingMentionNames(text).map(name => name.toLowerCase());
    const stopAll = requested.some(name => name === "all" || name === "everyone");
    const targets = [...this.conns.values()].filter(conn =>
      conn.joined && conn.room === requester.room && conn.kind === "agent" &&
      (stopAll || requested.includes(conn.user.toLowerCase())));
    if (!requested.length) {
      this.botReply(requester, "Usage: /stop @agent or /stop @all");
      return;
    }
    if (!targets.length) {
      this.botReply(requester, "No matching online agents were found.");
      return;
    }
    const names = [...new Set(targets.map(target => target.user))];
    for (const target of targets) {
      this.sendTo(target.ws, { t: "stopped", room: requester.room, reason: "Stopped by the room host.", scope: "chatroom" });
      try { target.ws.close(); } catch { /* ignore */ }
    }
    this.botReply(requester, `Stopped: ${names.map(name => this.formatMention(name)).join(", ")}. Their Room identities remain in Earlier.`);
  }

  private async onClose(conn: HubConn): Promise<void> {
    this.conns.delete(conn.ws);
    if (conn.pendingJoinId) {
      await this.approvals?.cancelConnection(conn.id).catch(error => this.log(`pending Join cancel failed: ${(error as Error).message}`));
      conn.pendingJoinId = "";
    }
    if (!conn.joined) return;
    const st = this.rooms.get(conn.room);
    if (!st) return;   // room already deactivated
    this.markDeparted(conn, st);
    const identityStillHere = this.hasOtherIdentityConnection(conn);
    if (!identityStillHere && this.persistence && conn.participantId) {
      await this.persistence.releaseAlias(st.roomId, conn.participantId, Date.now(), conn.user)
        .catch(error => this.log(`alias release failed: ${(error as Error).message}`));
    }
    if (!identityStillHere) {
      this.broadcast(conn.room, { t: "system", room: conn.room, text: `${conn.user} left the room`, ts: Date.now() });
    }
    this.broadcastPresence(conn.room);
    // A hosted Room belongs to the Hub, not to the Host UI socket. Closing a
    // tab, reloading a window, or losing transport must not close the Room.
    // Explicit /leave, Close Room, Stop Hub, or extension disposal owns that lifecycle.
  }

  private async remember(room: string, m: ChatMessage): Promise<void> {
    const st = this.roomState(room);
    if (this.persistence) await this.persistence.append(st.roomId, this.toPersisted(m));
    st.history.push(m);
    this.trimHistory(st);
    if (!this.persistence) this.scheduleFlush(room);
  }

  private membersOf(room: string): Member[] {
    const st = this.rooms.get(room);
    return [...this.conns.values()]
      .filter(c => c.joined && c.room === room)
      .map(c => ({ id: c.id, user: c.user, kind: c.kind, host: !!st && this.isOwnerConn(st, c), muted: !!st?.muted.has(this.identityKey(c)), participantId: c.participantId,
        runtimeState: c.kind === "agent" ? c.runtimeState : undefined, stateChangedAt: c.kind === "agent" ? c.stateChangedAt : undefined }));
  }

  // A per-member identity within a room: cid + display name. Two windows on one
  // machine can share a cid (persisted in globalState), so the NAME disambiguates
  // them; names are unique per room, making (cid, name) unique. Falls back to
  // name-only when there is no cid (best-effort browser identities).
  private identityKey(conn: HubConn): string {
    if (conn.participantId) return `participant:${conn.participantId}`;
    const nk = conn.user.trim().toLowerCase();
    return conn.cid ? `cid:${conn.cid}:${nk}` : `name:${nk}`;
  }

  private hasOtherIdentityConnection(conn: HubConn): boolean {
    const key = this.identityKey(conn);
    return [...this.conns.values()].some(other =>
      other !== conn && other.joined && other.room === conn.room && this.identityKey(other) === key);
  }

  private isOwnerConn(st: RoomState, conn: HubConn): boolean {
    return !!st.owner && conn.participantId === st.owner;
  }

  private isMuted(conn: HubConn): boolean {
    const st = this.rooms.get(conn.room);
    return !!st && st.muted.has(this.identityKey(conn));
  }

  private leadingMentionNames(text: string): string[] {
    const value = text.trimStart();
    if (value.startsWith("/")) {
      return (value.match(/@(?:"[^"]{1,60}"|[\p{L}\p{N}_][\p{L}\p{N}_-]{0,59})/gu) || [])
        .map(token => token.slice(1).replace(/^"|"$/g, ""));
    }
    const recipients: string[] = [];
    let rest = value;
    const leading = /^@(?:"([^"]{1,60})"|([\p{L}\p{N}_][\p{L}\p{N}_-]{0,59}))(?:\s+|$)/u;
    while (true) {
      const match = leading.exec(rest);
      if (!match) break;
      recipients.push(match[1] || match[2]);
      rest = rest.slice(match[0].length);
    }
    return recipients;
  }

  private allMentionNames(text: string): string[] {
    const names = (String(text || "").match(/(?<![\p{L}\p{N}_@])@(?:"[^"\n]{1,60}"|[\p{L}\p{N}_][\p{L}\p{N}_-]{0,59})/gu) || [])
      .map(token => token.slice(1).replace(/^"|"$/g, ""));
    return names.filter((name, index) => names.findIndex(candidate => candidate.toLocaleLowerCase() === name.toLocaleLowerCase()) === index);
  }

  private mentionTargets(room: string, sender: HubConn, text: string, recipientNames?: string[]): Set<string> {
    const mentions = recipientNames?.length ? recipientNames : this.allMentionNames(text).map(name => name.toLowerCase());
    if (!mentions.length) return new Set();
    const all = mentions.some(name => name === "all" || name === "everyone");
    const senderKey = this.identityKey(sender);
    return new Set([...this.conns.values()]
      .filter(conn => conn.joined && conn.room === room && this.identityKey(conn) !== senderKey)
      .filter(conn => all || mentions.includes(conn.user.toLowerCase()))
      .map(conn => this.identityKey(conn)));
  }

  private validRecipientNames(st: RoomState, sender: HubConn, requested: string[]): string[] {
    const senderKey = this.identityKey(sender);
    const valid = new Map([...st.roster.entries()]
      .filter(([key]) => key !== senderKey)
      .map(([, entry]) => [entry.user.toLowerCase(), entry.user.toLowerCase()]));
    valid.set("all", "all");
    valid.set("everyone", "all");
    const names: string[] = [];
    for (const name of requested) {
      const resolved = valid.get(String(name || "").toLowerCase());
      if (resolved && !names.includes(resolved)) names.push(resolved);
    }
    return names;
  }

  private discussionAudience(st: RoomState, sender: HubConn, recipientNames: string[]): string[] {
    const requested = new Set(recipientNames.map(name => name.toLowerCase()));
    const all = requested.has("all") || requested.has("everyone");
    const senderKey = this.identityKey(sender);
    const names: string[] = [];
    for (const [key, entry] of st.roster) {
      if (key === senderKey || (!all && !requested.has(entry.user.toLowerCase()))) continue;
      if (!names.some(name => name.toLowerCase() === entry.user.toLowerCase())) names.push(entry.user);
    }
    return names;
  }

  private broadcastReceiptMessage(room: string, message: ChatMessage, targets: Set<string>): void {
    for (const conn of this.conns.values()) {
      if (!conn.joined || conn.room !== room) continue;
      const receipt = message.receipt
        ? { ...message.receipt, ack: targets.has(this.identityKey(conn)) }
        : undefined;
      this.sendTo(conn.ws, { t: "msg", room, ...message, receipt });
    }
  }

  private formatMention(name: string): string {
    return /^[A-Za-z0-9_][\w-]{0,59}$/.test(name) ? `@${name}` : `@"${name.replace(/"/g, "")}"`;
  }

  // Answer a slash command privately (only the requester sees the bot reply).
  private async handleCommand(conn: HubConn, text: string): Promise<void> {
    const st = this.rooms.get(conn.room);
    const isOwner = !!st && this.isOwnerConn(st, conn);
    const cmd = findCommand(text);
    if (!cmd) { this.botReply(conn, `Unknown command "${text.split(/\s+/)[0]}". Type /help for the list.`); return; }
    if (cmd.hostOnly && !isOwner) { this.botReply(conn, `"/${cmd.name}" is available to the room host only.`); return; }
    const arg = (text.match(/^\/\S+\s*([\s\S]*)$/)?.[1] ?? "").trim();
    try { this.botReply(conn, await cmd.run(this.buildCmdCtx(conn, isOwner, arg))); }
    catch (e) { this.botReply(conn, `Command failed: ${(e as Error).message}`); }
    this.log(`command /${cmd.name} by ${conn.user} in ${conn.room}`);
  }

  private buildCmdCtx(conn: HubConn, isOwner: boolean, arg: string): CommandContext {
    const wsUrl = `ws://${this.publicHost}:${this._port}`;
    return {
      room: conn.room, isOwner, wsUrl,
      joinUrl: `${wsUrl}/${encodeURIComponent(conn.room)}`,
      members: this.rosterOf(conn.room), arg,
      actions: {
        muteAll:   () => this.muteAllExceptHost(conn.room),
        unmuteAll: () => this.unmuteAllInRoom(conn.room),
        rotateSecret: async () => !!await this.rotateRoomSecret(conn.room),
        inviteMessage: () => {
          const secret = this.roomSecret.get(conn.room);
          if (!secret) throw new Error("Room secret is unavailable.");
          const roomId = this.rooms.get(conn.room)?.roomId;
          if (!roomId) throw new Error("Room identity is unavailable.");
          return chatInviteMessage(createChatMagicLink(`${wsUrl}/${encodeURIComponent(conn.room)}`, secret, roomId));
        },
      },
    };
  }

  // Post the /help contents to a member privately (used on room creation).
  private sendHelp(conn: HubConn, greeting: string): void {
    const help = findCommand("/help");
    if (!help) return;
    this.botReply(conn, `${greeting}\n` + help.run(this.buildCmdCtx(conn, true, "")));
  }

  private muteAllExceptHost(room: string): number {
    const st = this.rooms.get(room);
    if (!st) return 0;
    let n = 0;
    for (const c of this.conns.values()) {
      if (!c.joined || c.room !== room) continue;
      if (this.isOwnerConn(st, c)) continue;   // never mute the host
      const key = this.identityKey(c);
      if (!st.muted.has(key)) { st.muted.add(key); n++; }
      this.sendTo(c.ws, { t: "error", code: "muted", msg: "The host muted the room — you can read but not post." });
    }
    if (n > 0) {
      this.broadcast(room, { t: "system", room, text: `🔇 The host muted everyone in the room.`, ts: Date.now() });
      this.broadcastPresence(room);
    }
    return n;
  }

  private unmuteAllInRoom(room: string): number {
    const st = this.rooms.get(room);
    if (!st) return 0;
    const n = st.muted.size;
    if (n === 0) return 0;
    st.muted.clear();
    for (const c of this.conns.values()) {
      if (c.joined && c.room === room) this.sendTo(c.ws, { t: "error", code: "muted", msg: "The host lifted the room mute — you can post again." });
    }
    this.broadcast(room, { t: "system", room, text: `🔊 The host unmuted the room.`, ts: Date.now() });
    this.broadcastPresence(room);
    return n;
  }

  // Generate a new secret for a room, notify the owner (so the app can persist and
  // share it), and post a room note. Returns the new secret, or undefined if the
  // room has no secret set. Current members stay connected; only new joins need it.
  private async rotateSecretInternal(room: string, note: string): Promise<string | undefined> {
    const st = this.rooms.get(room);
    if (!st || !this.roomSecret.has(room)) return undefined;
    const fresh = this.lifecycle
      ? await this.lifecycle.rotateJoinSecret(st.roomId)
      : randomBytes(9).toString("base64url");
    this.roomSecret.set(room, fresh);
    for (const c of this.conns.values()) {
      if (c.joined && c.room === room && this.isOwnerConn(st, c)) {
        this.sendTo(c.ws, { t: "rekey", room, secret: fresh });
      }
    }
    if (note) this.broadcast(room, { t: "system", room, text: note, ts: Date.now() });
    return fresh;
  }

  /** Public: rotate a room's secret on demand (admin button or /rotate_secret). */
  async rotateRoomSecret(room: string): Promise<string | undefined> {
    const s = await this.rotateSecretInternal(ChatHub.canonRoom(room), `🔑 The host rotated the room secret. New members need the new secret.`);
    if (s) this.log(`secret rotated for ${room}`);
    return s;
  }

  private botReply(conn: HubConn, text: string): void {
    this.sendTo(conn.ws, {
      t: "msg", room: conn.room, id: randomBytes(6).toString("hex"),
      from: BOT_NAME, fromId: "roombot", text, ts: Date.now(), kind: "agent",
    });
  }

  // Host-only moderation: remove, mute/unmute, or edit another member. Rejected for
  // anyone who isn't the room owner.
  private async handleAdmin(conn: HubConn, frame: Extract<Frame, { t: "admin" }>): Promise<void> {
    const st = this.rooms.get(conn.room);
    if (!st) return;
    const selfKey = this.identityKey(conn);
    const isOwner = this.isOwnerConn(st, conn);
    // Renaming YOURSELF is allowed for any member; every other action is host-only.
    const isSelfRename = frame.action === "rename" && (frame.target || "").slice(0, 120) === selfKey;
    if (!isOwner && !isSelfRename) { this.sendTo(conn.ws, { t: "error", code: "moderation", msg: "Only the host can moderate this room." }); return; }
    const targetKey = (frame.target || "").slice(0, 120);
    if (!targetKey) return;
    if (targetKey === selfKey && frame.action !== "rename") { this.sendTo(conn.ws, { t: "error", code: "moderation", msg: "You can't moderate yourself." }); return; }
    const targets = [...this.conns.values()].filter(c => c.joined && c.room === conn.room && this.identityKey(c) === targetKey);
    const who = st.roster.get(targetKey)?.user || targets[0]?.user || "member";

    switch (frame.action) {
      case "kick": {
        const participantId = st.roster.get(targetKey)?.participantId || targets[0]?.participantId;
        if (participantId && this.persistence) await this.persistence.forgetParticipant(st.roomId, participantId, Date.now());
        for (const t of targets) {
          this.sendTo(t.ws, { t: "kicked", room: conn.room, reason: "Removed by the host." });
          t.joined = false;                 // stop onClose from re-broadcasting a "left" line
          this.conns.delete(t.ws);
          try { t.ws.close(); } catch { /* ignore */ }
        }
        st.muted.delete(targetKey);
        st.roster.delete(targetKey);
        this.broadcast(conn.room, { t: "system", room: conn.room, text: `${who} was permanently removed by the host`, ts: Date.now() });
        this.broadcastPresence(conn.room);
        this.log(`admin kick room=${conn.room} target=${who}`);
        break;
      }
      case "mute": {
        st.muted.add(targetKey);
        for (const t of targets) this.sendTo(t.ws, { t: "error", code: "muted", msg: "The host muted you — you can read but not post." });
        this.broadcast(conn.room, { t: "system", room: conn.room, text: `${who} was muted by the host`, ts: Date.now() });
        this.broadcastPresence(conn.room);
        this.log(`admin mute room=${conn.room} target=${who}`);
        break;
      }
      case "unmute": {
        st.muted.delete(targetKey);
        for (const t of targets) this.sendTo(t.ws, { t: "error", code: "muted", msg: "The host unmuted you — you can post again." });
        this.broadcast(conn.room, { t: "system", room: conn.room, text: `${who} was unmuted by the host`, ts: Date.now() });
        this.broadcastPresence(conn.room);
        this.log(`admin unmute room=${conn.room} target=${who}`);
        break;
      }
      case "rename": {
        const newName = (frame.name || "").trim().slice(0, 60);
        if (!newName) return;
        const nk = newName.toLowerCase();
        // A rename is allowed only if no OTHER present member already uses that name.
        const clash = [...this.conns.values()].some(
          c => c.joined && c.room === conn.room && this.identityKey(c) !== targetKey && c.user.trim().toLowerCase() === nk);
        if (clash) { this.sendTo(conn.ws, { t: "error", code: "moderation", msg: `"${newName}" is already taken in this room.` }); return; }
        const participantId = st.roster.get(targetKey)?.participantId || targets[0]?.participantId;
        if (participantId && this.persistence) await this.persistence.renameAlias(st.roomId, participantId, newName, Date.now());
        // Participant identity is stable; changing an alias never changes keys.
        for (const t of targets) { t.user = newName; this.sendTo(t.ws, { t: "renamed", room: conn.room, name: newName }); }
        const newKey = targetKey;
        const e = st.roster.get(targetKey);
        if (e) { st.roster.delete(targetKey); e.user = newName; e.key = newKey; st.roster.set(newKey, e); }
        if (st.muted.has(targetKey)) { st.muted.delete(targetKey); st.muted.add(newKey); }
        if (e?.participantId === st.owner) st.ownerName = newName;
        const byHost = targetKey !== selfKey;
        this.broadcast(conn.room, { t: "system", room: conn.room, text: byHost ? `${who} was renamed to ${newName} by the host` : `${who} is now known as ${newName}`, ts: Date.now() });
        this.broadcastPresence(conn.room);
        this.log(`rename room=${conn.room} ${who} -> ${newName}${byHost ? " (by host)" : " (self)"}`);
        break;
      }
      case "edit": {
        const entry = st.roster.get(targetKey);
        if (!entry) { this.sendTo(conn.ws, { t: "error", code: "moderation", msg: "That member is no longer in the room roster." }); return; }
        const oldName = entry.user;
        const newName = (frame.name || oldName).trim().slice(0, 60);
        const newRole = (frame.role || "").trim().slice(0, 120);
        if (!newName) return;
        const nameChanged = newName.toLowerCase() !== oldName.toLowerCase();
        if (nameChanged) {
          const clash = [...st.roster.values()].some(other => other.key !== targetKey && other.user.toLowerCase() === newName.toLowerCase());
          if (clash) { this.sendTo(conn.ws, { t: "error", code: "moderation", msg: `"${newName}" is already in the room roster.` }); return; }
          if (entry.participantId && this.persistence) await this.persistence.renameAlias(st.roomId, entry.participantId, newName, Date.now());
        }
        if (entry.participantId && this.persistence && newRole !== entry.role) {
          await this.persistence.setParticipantRole(st.roomId, entry.participantId, newRole, Date.now());
        }
        for (const target of targets) {
          target.user = newName;
          if (nameChanged) this.sendTo(target.ws, { t: "renamed", room: conn.room, name: newName });
        }
        const newKey = targetKey;
        const wasMuted = st.muted.delete(targetKey);
        if (newKey !== targetKey) st.roster.delete(targetKey);
        entry.key = newKey;
        entry.user = newName;
        entry.role = newRole;
        st.roster.set(newKey, entry);
        if (wasMuted) st.muted.add(newKey);
        if (entry.participantId === st.owner) st.ownerName = newName;
        this.broadcastPresence(conn.room);
        this.log(`admin edit room=${conn.room} ${oldName} -> ${newName} role=${newRole}`);
        break;
      }
    }
  }

  // Upsert the roster entry for a joining connection. Returns the display name
  // this identity used previously (if known), so the caller can announce a rename.
  private rosterJoin(conn: HubConn, st: RoomState): string | undefined {
    const key = this.identityKey(conn);
    const now = Date.now();
    const verified = conn.kind !== "browser";   // extension/MCP ids are trusted; browser is best-effort
    const e = st.roster.get(key);
    if (e) {
      const prevName = e.user;
      e.present = true; e.id = conn.id; e.user = conn.user; e.kind = conn.kind;
      e.sid = conn.cid || e.sid; e.participantId = conn.participantId; e.verified = verified; e.lastSeen = now;
      return prevName;
    }
    st.roster.set(key, {
      key, id: conn.id, user: conn.user, kind: conn.kind,
      sid: conn.cid || "", participantId: conn.participantId, verified, present: true, firstSeen: now, lastSeen: now, role: "",
    });
    return undefined;
  }

  // Mark an identity departed — but only once no other live connection shares it.
  private markDeparted(conn: HubConn, st: RoomState): void {
    const key = this.identityKey(conn);
    const e = st.roster.get(key);
    if (!e) return;
    const stillHere = [...this.conns.values()].some(
      c => c !== conn && c.joined && c.room === conn.room && this.identityKey(c) === key);
    if (!stillHere) { e.present = false; e.lastSeen = Date.now(); }
  }

  // Full roster (present first, then most-recently-departed) for the presence frame.
  private rosterOf(room: string): Member[] {
    const st = this.rooms.get(room);
    if (!st) return [];
    const owner = st.owner;
    return [...st.roster.values()]
      .sort((a, b) => (Number(b.present) - Number(a.present)) || (b.lastSeen - a.lastSeen))
      .map(e => ({
        id: e.id, user: e.user, kind: e.kind,
        host: !!owner && e.participantId === owner,
        sid: e.sid, verified: e.verified, present: e.present, lastSeen: e.lastSeen,
        muted: st.muted.has(e.key),
        role: e.role, participantId: e.participantId,
        runtimeState: e.kind === "agent" && e.present
          ? [...this.conns.values()].find(conn => conn.joined && conn.participantId === e.participantId)?.runtimeState
          : undefined,
        stateChangedAt: e.kind === "agent" && e.present
          ? [...this.conns.values()].find(conn => conn.joined && conn.participantId === e.participantId)?.stateChangedAt
          : undefined,
      }));
  }

  private broadcastPresence(room: string): void {
    this.broadcast(room, { t: "presence", room, members: this.rosterOf(room) });
  }

  private broadcast(room: string, frame: Frame, exceptWs?: WebSocket): void {
    const data = JSON.stringify(frame);
    for (const c of this.conns.values()) {
      if (c.joined && c.room === room && c.ws !== exceptWs && c.ws.readyState === WebSocket.OPEN) {
        try { c.ws.send(data); } catch { /* ignore */ }
      }
    }
  }

  private sendTo(ws: WebSocket, frame: Frame): void {
    if (ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify(frame)); } catch { /* ignore */ } }
  }

  private sweep(): void {
    for (const c of this.conns.values()) {
      if (!c.alive) { try { c.ws.terminate(); } catch { /* ignore */ } continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* ignore */ }
    }
  }

  static localIp(): string {
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const iface of ifaces ?? []) {
        if (!iface.internal && iface.family === "IPv4") return iface.address;
      }
    }
    return "127.0.0.1";
  }
}

