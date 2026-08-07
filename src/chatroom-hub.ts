import { WebSocketServer, WebSocket } from "ws";
import { createServer, Server, IncomingMessage, ServerResponse } from "http";
import { networkInterfaces } from "os";
import { randomBytes, timingSafeEqual, createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { findCommand, BOT_NAME, CommandContext } from "./chat-commands";
import { createChatMagicLink, chatInviteMessage } from "./chat-magic-link";
import { AgentRuntimeState, ChatMessage, FileMeta, Frame, MAX_FILE_BYTES, Member, MemberKind } from "./chatroom-protocol";
import { browserViewHtml } from "./chatroom-browser";

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
}

interface RoomState {
  history: ChatMessage[];   // CHAT ONLY — never files
  owner:   string;          // creator's cid (or conn id) — room deactivates when they leave
  ownerName: string;
  graceTimer: NodeJS.Timeout | null;  // pending owner-departure deactivation
  roster: Map<string, RosterEntry>;   // everyone who has ever joined (present + departed)
  muted: Set<string>;                 // identity keys the host has muted (persists across reconnects)
  conversation: ConversationState;
  receipts: Map<string, { targets: Set<string>; readers: Set<string> }>;
}

interface ConversationState {
  active: boolean;
  pending: boolean;
  initiatorKey: string;
  initiatorName: string;
  participants: string[];
  currentSpeaker: string;
  nextIndex: number;
  turns: number;
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
}

export interface AdminRoomInfo { room: string; owner: string; members: number; }

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
  private static readonly OWNER_GRACE_MS = 15_000;  // tolerate a host's brief reconnect

  // Persistent chat archive (so history survives rejoin / room close / hub restart).
  private archiveDir = "";
  private historyLimitBytes = 10 * 1024 * 1024;     // configurable; 0 disables archiving
  private flushTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(logger?: (m: string) => void) { this.log = logger ?? (() => {}); }

  /** Point the hub at an on-disk archive dir and cap total bytes kept per room. */
  configureArchive(dir: string, limitBytes: number): void {
    this.archiveDir = dir || "";
    this.historyLimitBytes = Math.max(0, limitBytes | 0);
    if (this.archiveDir) { try { fs.mkdirSync(this.archiveDir, { recursive: true }); } catch { /* ignore */ } }
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
      room,
      owner: this.rooms.get(room)?.ownerName || "—",
      members: this.membersOf(room).length,
    }));
  }
  adminCloseRoom(room: string): void { this.deactivateRoom(room, "closed by admin"); }
  adminCloseAll(): void { for (const room of [...this.rooms.keys()]) this.deactivateRoom(room, "closed by admin"); }

  async start(port: number): Promise<void> {
    if (this.wss) return;
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

  stop(): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    for (const room of this.rooms.keys()) this.flushArchive(room);   // persist before shutdown
    for (const t of this.flushTimers.values()) clearTimeout(t);
    this.flushTimers.clear();
    for (const c of this.conns.values()) { try { c.ws.close(); } catch { /* ignore */ } }
    this.conns.clear();
    this.rooms.clear();
    try { this.wss?.close(); } catch { /* ignore */ }
    try { this.http?.close(); } catch { /* ignore */ }
    this.wss = null; this.http = null; this._port = 0;
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
      res.end(JSON.stringify({ ok: true, rooms: this.roomNames.length, members: this.conns.size }));
      return;
    }
    res.writeHead(404); res.end("Not found");
  }

  private roomState(room: string): RoomState {
    let s = this.rooms.get(room);
    if (!s) {
      s = {
        history: [], owner: "", ownerName: "", graceTimer: null,
        roster: new Map(), muted: new Set(),
        conversation: { active: false, pending: false, initiatorKey: "", initiatorName: "", participants: [], currentSpeaker: "", nextIndex: 0, turns: 0 },
        receipts: new Map(),
      };
      this.rooms.set(room, s);
      this.loadArchive(room, s);   // restore prior chat so rejoiners see history
    }
    return s;
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
  private deactivateRoom(room: string, reason: string): void {
    const st = this.rooms.get(room);
    if (st?.graceTimer) { clearTimeout(st.graceTimer); st.graceTimer = null; }
    const flush = this.flushTimers.get(room);
    if (flush) { clearTimeout(flush); this.flushTimers.delete(room); }
    this.flushArchive(room);      // persist final state before dropping in-memory
    this.rooms.delete(room);   // remove first so onClose treats these as already-gone
    this.roomSecret.delete(room);
    const members = [...this.conns.values()].filter(c => c.joined && c.room === room);
    for (const c of members) {
      this.sendTo(c.ws, { t: "closed", room, reason });
      this.conns.delete(c.ws);
      try { c.ws.close(); } catch { /* ignore */ }
    }
    this.log(`room ${room} deactivated: ${reason}`);
  }

  private onConnection(ws: WebSocket): void {
    const conn: HubConn = { id: randomBytes(4).toString("hex"), user: "", room: "", kind: "human", cid: "", ws, alive: true, joined: false };
    this.conns.set(ws, conn);
    ws.on("pong", () => { conn.alive = true; });
    ws.on("message", raw => this.onMessage(conn, raw.toString()));
    ws.on("close", () => this.onClose(conn));
    ws.on("error", () => { try { ws.close(); } catch { /* ignore */ } });
  }

  private onMessage(conn: HubConn, raw: string): void {
    let frame: Frame;
    try { frame = JSON.parse(raw); } catch { return; }

    if (frame.t === "ping") { this.sendTo(conn.ws, { t: "pong" }); return; }
    if (frame.t === "pong") { conn.alive = true; return; }

    if (conn.joined && frame.t === "leave") {
      // Multiple VS Code windows can share one stable identity. Leaving one
      // window must not deactivate the room while another owner window remains.
      const st = this.rooms.get(conn.room);
      if (st && this.isOwnerConn(st, conn) && !this.hasOtherIdentityConnection(conn)) {
        this.deactivateRoom(conn.room, "host left");
      } else {
        try { conn.ws.close(); } catch { /* ignore */ }
      }
      return;
    }

    if (conn.joined && frame.t === "admin") {
      this.handleAdmin(conn, frame);
      return;
    }

    if (conn.joined && frame.t === "agent.state") {
      if (conn.kind !== "agent") return;
      this.broadcast(conn.room, {
        t: "agent.state", room: conn.room, user: conn.user,
        state: frame.state, ts: Date.now(),
      });
      return;
    }

    if (!conn.joined) {
      if (frame.t !== "join") { this.sendTo(conn.ws, { t: "error", code: "not-joined", msg: "join first" }); return; }
      const desired = (frame.user || "anon").slice(0, 60);
      const room    = ChatHub.canonRoom(frame.room);
      const cid     = (frame.cid  || "").slice(0, 32);
      const token   = frame.token ?? "";
      const kind: MemberKind = frame.kind === "agent" ? "agent" : frame.kind === "browser" ? "browser" : "human";
      const nameKey = desired.trim().toLowerCase();
      const joiningIdentity = cid ? `cid:${cid}:${nameKey}` : "";
      const existingState = this.rooms.get(room);
      const ownerReconnect = kind === "human" && !!joiningIdentity && existingState?.owner === joiningIdentity;
      // The stable owner identity can always reconnect. The per-room secret is
      // guest authentication and must match for everyone else.
      const known = this.roomSecret.get(room);
      if (known !== undefined) {
        if (!ownerReconnect && !constantTimeEquals(token, known)) {
          this.sendTo(conn.ws, { t: "error", code: "auth", msg: `Wrong secret for room "${room}".` });
          try { conn.ws.close(); } catch { /* ignore */ }
          return;
        }
      } else {
        // Room doesn't exist yet: only a host/extension user can create it.
        if (kind === "browser") {
          this.sendTo(conn.ws, { t: "error", code: "no-room", msg: `Room "${room}" doesn't exist yet. Ask the host to start it.` });
          try { conn.ws.close(); } catch { /* ignore */ }
          return;
        }
        if (!token) {
          this.sendTo(conn.ws, { t: "error", code: "auth", msg: "A secret is required to create a room." });
          try { conn.ws.close(); } catch { /* ignore */ }
          return;
        }
        this.roomSecret.set(room, token);   // creator defines the room's secret
      }
      // Names must be unique within a room so every identity is unambiguous.
      for (const other of this.conns.values()) {
        if (other === conn || !other.joined || other.room !== room) continue;
        if (other.user.trim().toLowerCase() !== nameKey) continue;
        if (cid && other.cid && other.cid === cid) {
          // Same stable identity in another VS Code window. Keep both live;
          // roster/presence aggregates them as one person.
          continue;
        } else {
          this.sendTo(conn.ws, { t: "error", code: "name-taken", msg: `The name "${desired}" is already taken in room "${room}". Please choose a different name.` });
          try { conn.ws.close(); } catch { /* ignore */ }
          return;
        }
      }
      conn.joined = true;
      conn.user = desired;
      conn.room = room;
      conn.cid  = cid;
      conn.kind = kind;
      const identityAlreadyPresent = this.hasOtherIdentityConnection(conn);
      this.log(`join room=${conn.room} user=${conn.user} kind=${conn.kind}`);
      const st = this.roomState(conn.room);
      // First real participant owns the room; the room deactivates when they leave.
      const becameOwner = !st.owner && conn.kind !== "browser";
      if (becameOwner) { st.owner = this.identityKey(conn); st.ownerName = conn.user; }
      // Owner reconnected within the grace window — cancel the pending deactivation.
      if (this.isOwnerConn(st, conn) && st.graceTimer) {
        clearTimeout(st.graceTimer); st.graceTimer = null;
      }
      const prevName = this.rosterJoin(conn, st);
      // Backfill recent chat history to the joining member (files are never stored).
      if (st.history.length) this.sendTo(conn.ws, { t: "history", room: conn.room, messages: st.history });
      if (!identityAlreadyPresent) {
        const joinText = (prevName && prevName !== conn.user)
          ? `${prevName} rejoined with new name ${conn.user}`
          : `${conn.user} joined the room`;
        this.broadcast(conn.room, { t: "system", room: conn.room, text: joinText, ts: Date.now() });
      }
      this.broadcastPresence(conn.room);
      // Greet the host who just created a room with the /help cheat-sheet.
      if (becameOwner) this.sendHelp(conn, `👋 Welcome — you're now hosting "${conn.room}". Here are the magic messages you can type:`);
      return;
    }

    if (frame.t === "msg") {
      const text = (frame.text ?? "").toString().slice(0, 8000);
      if (!text.trim()) return;
      // Slash commands are intercepted (never broadcast) and answered privately by
      // the background sender — EXCEPT conversation-control commands, which must
      // reach every participant, so they fall through and broadcast like a post.
      const head = text.trim().split(/\s+/)[0].toLowerCase();
      const isConvCmd = head === "/start_conversation" || head === "/start" || head === "/stop_conversation" || head === "/release" || head === "/request_join";
      if (text.trim().startsWith("/") && !isConvCmd) { this.handleCommand(conn, text.trim()); return; }
      if (this.isMuted(conn)) { this.sendTo(conn.ws, { t: "error", code: "muted", msg: "You are muted by the host and can't post right now." }); return; }
      const roomState = this.roomState(conn.room);
      if (head === "/start") {
        const conversation = roomState.conversation;
        if (!conversation.pending) { this.botReply(conn, "No conversation is pending. Use /start_conversation first."); return; }
        if (conversation.initiatorKey !== this.identityKey(conn)) {
          this.botReply(conn, `Only ${conversation.initiatorName}, who initiated this conversation, can start it.`);
          return;
        }
      }
      if (head === "/stop_conversation" && !this.isOwnerConn(roomState, conn)) {
        this.botReply(conn, "Only the room host can stop the active conversation.");
        return;
      }
      const m: ChatMessage = {
        id: randomBytes(6).toString("hex"), from: conn.user, fromId: conn.id,
        text, ts: Date.now(), kind: conn.kind,
      };
      const targets = this.mentionTargets(conn.room, conn, text);
      if (targets.size) {
        roomState.receipts.set(m.id, { targets, readers: new Set() });
        m.receipt = { read: 0, total: targets.size };
      }
      this.remember(conn.room, m);
      if (targets.size) this.broadcastReceiptMessage(conn.room, m, targets);
      else this.broadcast(conn.room, { t: "msg", room: conn.room, ...m });
      if (head === "/start_conversation") this.prepareConversation(conn, text);
      else if (head === "/start") this.activateConversation(conn);
      else if (head === "/stop_conversation") this.stopConversation(conn.room);
      else if (head === "/release") this.releaseConversationMembers(conn.room, text);
      else if (head === "/request_join") this.requestConversationJoin(conn.room, text);
      else if (roomState.conversation.pending) this.remindConversationStart(conn.room);
      else this.coordinateConversationTurn(conn.room, conn);
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
        id: randomBytes(6).toString("hex"), from: conn.user, fromId: conn.id,
        text: `📎 shared a file: ${f.name} (${humanSize(f.size)})`,
        ts: Date.now(), kind: conn.kind, file: f,
      };
      this.remember(conn.room, note);
      // Relay the live offer to everyone EXCEPT the sender.
      this.broadcast(conn.room, { t: "file.offer", room: conn.room, from: conn.user, fromId: conn.id, ts: note.ts, kind: conn.kind, file: f }, conn.ws);
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

  private onClose(conn: HubConn): void {
    this.conns.delete(conn.ws);
    if (!conn.joined) return;
    const st = this.rooms.get(conn.room);
    if (!st) return;   // room already deactivated
    this.markDeparted(conn, st);
    const identityStillHere = this.hasOtherIdentityConnection(conn);
    if (!identityStillHere) {
      this.broadcast(conn.room, { t: "system", room: conn.room, text: `${conn.user} left the room`, ts: Date.now() });
    }
    this.broadcastPresence(conn.room);
    const isOwner = this.isOwnerConn(st, conn);
    if (isOwner && !identityStillHere) {
      // Host disconnected: give a short grace for reconnect, then deactivate.
      if (st.graceTimer) clearTimeout(st.graceTimer);
      st.graceTimer = setTimeout(() => {
        const back = [...this.conns.values()].some(c => c.joined && c.room === conn.room && this.isOwnerConn(st, c));
        if (!back) this.deactivateRoom(conn.room, "host left");
      }, ChatHub.OWNER_GRACE_MS);
      st.graceTimer.unref?.();
    } else if (!this.membersOf(conn.room).length) {
      this.rooms.delete(conn.room);
      this.roomSecret.delete(conn.room);
    }
  }

  private remember(room: string, m: ChatMessage): void {
    const st = this.roomState(room);
    st.history.push(m);
    this.trimHistory(st);
    this.scheduleFlush(room);
  }

  private membersOf(room: string): Member[] {
    const st = this.rooms.get(room);
    return [...this.conns.values()]
      .filter(c => c.joined && c.room === room)
      .map(c => ({ id: c.id, user: c.user, kind: c.kind, host: !!st && this.isOwnerConn(st, c), muted: !!st?.muted.has(this.identityKey(c)) }));
  }

  // A per-member identity within a room: cid + display name. Two windows on one
  // machine can share a cid (persisted in globalState), so the NAME disambiguates
  // them; names are unique per room, making (cid, name) unique. Falls back to
  // name-only when there is no cid (best-effort browser identities).
  private identityKey(conn: HubConn): string {
    const nk = conn.user.trim().toLowerCase();
    return conn.cid ? `cid:${conn.cid}:${nk}` : `name:${nk}`;
  }

  private hasOtherIdentityConnection(conn: HubConn): boolean {
    const key = this.identityKey(conn);
    return [...this.conns.values()].some(other =>
      other !== conn && other.joined && other.room === conn.room && this.identityKey(other) === key);
  }

  private isOwnerConn(st: RoomState, conn: HubConn): boolean {
    return !!st.owner && this.identityKey(conn) === st.owner;
  }

  private isMuted(conn: HubConn): boolean {
    const st = this.rooms.get(conn.room);
    return !!st && st.muted.has(this.identityKey(conn));
  }

  private conversationMentions(text: string): string[] {
    return (text.match(/@(?:"[^"]{1,60}"|[\p{L}\p{N}_][\p{L}\p{N}_-]{0,59})/gu) || [])
      .map(value => value.slice(1).replace(/^"|"$/g, ""));
  }

  private mentionTargets(room: string, sender: HubConn, text: string): Set<string> {
    const mentions = this.conversationMentions(text).map(name => name.toLowerCase());
    if (!mentions.length) return new Set();
    const all = mentions.some(name => name === "all" || name === "everyone");
    const senderKey = this.identityKey(sender);
    return new Set([...this.conns.values()]
      .filter(conn => conn.joined && conn.room === room && this.identityKey(conn) !== senderKey)
      .filter(conn => all || mentions.includes(conn.user.toLowerCase()))
      .map(conn => this.identityKey(conn)));
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

  private onlineAgentNames(room: string): string[] {
    return [...this.conns.values()]
      .filter(conn => conn.joined && conn.room === room && conn.kind === "agent")
      .map(conn => conn.user)
      .filter((name, index, all) => all.findIndex(other => other.toLowerCase() === name.toLowerCase()) === index);
  }

  private postCoordinatorMessage(room: string, text: string): void {
    const message: ChatMessage = {
      id: randomBytes(6).toString("hex"), from: BOT_NAME, fromId: "roombot",
      text, ts: Date.now(), kind: "agent",
    };
    this.remember(room, message);
    this.broadcast(room, { t: "msg", room, ...message });
  }

  private informConversationGuideline(room: string, agentNames: string[]): void {
    const wanted = new Set(agentNames.map(name => name.toLowerCase()));
    const sent = new Set<string>();
    for (const conn of this.conns.values()) {
      if (!conn.joined || conn.room !== room || conn.kind !== "agent" || !wanted.has(conn.user.toLowerCase())) continue;
      const identity = this.identityKey(conn);
      if (sent.has(identity)) continue;
      sent.add(identity);
      const message: ChatMessage = {
        id: randomBytes(6).toString("hex"), from: BOT_NAME, fromId: "roombot",
        text: [
          `PRIVATE AGENT GUIDELINE for ${this.formatMention(conn.user)}: you are participating in a coordinated conversation.`,
          `Call chat_standby(timeout=300) now. Do not use chat_read for conversation monitoring.`,
          `When chat_standby returns event="message", reply with chat_post, then immediately call chat_standby again.`,
          `When it returns event="timeout", immediately call chat_standby again without ending your agent turn.`,
          `Continue until event="stopped" after /stop_conversation or event="released" after /release.`,
        ].join("\n"),
        ts: Date.now(), kind: "agent",
      };
      this.sendTo(conn.ws, { t: "msg", room, ...message });
    }
    this.postCoordinatorMessage(room, "ℹ️ Conversation guideline sent to participating agents.");
  }

  private prepareConversation(initiator: HubConn, startText: string): void {
    const room = initiator.room;
    const state = this.roomState(room).conversation;
    const online = this.onlineAgentNames(room);
    const requested = this.conversationMentions(startText);
    const allRequested = requested.some(name => ["all", "everyone"].includes(name.toLowerCase()));
    const selected = (allRequested || requested.length === 0)
      ? online
      : online.filter(agent => requested.some(name => name.toLowerCase() === agent.toLowerCase()));
    const participants = initiator.kind === "agent" && !selected.some(name => name.toLowerCase() === initiator.user.toLowerCase())
      ? [initiator.user, ...selected]
      : selected;
    state.active = false;
    state.pending = participants.length > 0;
    state.initiatorKey = this.identityKey(initiator);
    state.initiatorName = initiator.user;
    state.participants = participants;
    state.currentSpeaker = "";
    const initiatorIndex = participants.findIndex(name => name.toLowerCase() === initiator.user.toLowerCase());
    state.nextIndex = initiatorIndex >= 0 ? (initiatorIndex + 1) % participants.length : 0;
    state.turns = 0;
    if (!participants.length) {
      this.postCoordinatorMessage(room, "No online agents matched this conversation. Join agents first, then use /start_conversation @all or @name.");
      return;
    }
    const who = participants.map(name => this.formatMention(name)).join(", ");
    this.postCoordinatorMessage(room, [
      `🛎️ Conversation prepared — pending agents: ${who}.`,
      `${this.formatMention(initiator.user)}, please state your topic, then use /start to begin turn rotation.`,
    ].join("\n"));
    this.informConversationGuideline(room, participants);
  }

  private activateConversation(initiator: HubConn): void {
    const state = this.roomState(initiator.room).conversation;
    if (!state.pending) {
      this.botReply(initiator, "No conversation is pending. Use /start_conversation @agents or @all first.");
      return;
    }
    if (state.initiatorKey !== this.identityKey(initiator)) {
      this.botReply(initiator, `Only ${state.initiatorName}, who initiated this conversation, can start it.`);
      return;
    }
    state.pending = false;
    state.active = true;
    const who = state.participants.map(name => this.formatMention(name)).join(", ");
    this.postCoordinatorMessage(initiator.room, [
      `🛎️ Conversation started — active agents: ${who}.`,
      `Directed @mentions respond immediately; undirected free talk rotates one participant at a time.`,
      `The host ends the discussion with /stop_conversation.`,
    ].join("\n"));
    if (initiator.kind === "agent") this.postTurnGrant(initiator.room, initiator.user);
    else this.grantNextConversationTurn(initiator.room, initiator.user);
  }

  private remindConversationStart(room: string): void {
    this.postCoordinatorMessage(room, "Please say /start when you want to start the discussion.");
  }

  private stopConversation(room: string): void {
    const state = this.roomState(room).conversation;
    if (!state.active && !state.participants.length) return;
    state.active = false;
    state.pending = false;
    state.initiatorKey = "";
    state.initiatorName = "";
    state.participants = [];
    state.currentSpeaker = "";
    state.nextIndex = 0;
    this.postCoordinatorMessage(room, "⏹ Conversation stopped. All agents may leave standby.");
  }

  private releaseConversationMembers(room: string, text: string): void {
    const state = this.roomState(room).conversation;
    if (!state.active && !state.pending) return;
    const released = new Set(this.conversationMentions(text).map(name => name.toLowerCase()));
    state.participants = state.participants.filter(name => !released.has(name.toLowerCase()));
    const releasedCurrent = released.has(state.currentSpeaker.toLowerCase());
    if (releasedCurrent) state.currentSpeaker = "";
    state.nextIndex = state.participants.length ? state.nextIndex % state.participants.length : 0;
    if (!state.participants.length) {
      this.stopConversation(room);
      return;
    }
    this.postCoordinatorMessage(room, `Released: ${[...released].map(name => this.formatMention(name)).join(", ")}. Remaining: ${state.participants.map(name => this.formatMention(name)).join(", ")}.`);
    if (releasedCurrent && state.active) this.grantNextConversationTurn(room, "");
  }

  private requestConversationJoin(room: string, text: string): void {
    const state = this.roomState(room).conversation;
    if (!state.active && !state.pending) {
      this.postCoordinatorMessage(room, "No conversation is pending or active. Use /start_conversation first.");
      return;
    }
    const requested = this.conversationMentions(text);
    if (!requested.length) {
      this.postCoordinatorMessage(room, "Usage: /request_join @alias");
      return;
    }
    const present = this.rosterOf(room).filter(member => member.present !== false);
    const added: string[] = [], missing: string[] = [], already: string[] = [];
    for (const alias of requested) {
      const member = present.find(candidate => candidate.user.toLowerCase() === alias.toLowerCase());
      if (!member) { missing.push(alias); continue; }
      if (state.participants.some(name => name.toLowerCase() === member.user.toLowerCase())) { already.push(member.user); continue; }
      state.participants.push(member.user);
      added.push(member.user);
    }
    const lines: string[] = [];
    if (added.length) lines.push(`Joined the conversation: ${added.map(name => this.formatMention(name)).join(", ")}.`);
    if (already.length) lines.push(`Already participating: ${already.map(name => this.formatMention(name)).join(", ")}.`);
    if (missing.length) lines.push(`Not online: ${missing.map(name => this.formatMention(name)).join(", ")}.`);
    this.postCoordinatorMessage(room, lines.join(" "));
    if (added.length) this.informConversationGuideline(room, added);
  }

  private coordinateConversationTurn(room: string, sender: HubConn): void {
    const state = this.roomState(room).conversation;
    if (!state.active || sender.kind !== "agent" || !state.currentSpeaker) return;
    if (sender.user.toLowerCase() !== state.currentSpeaker.toLowerCase()) return;
    state.currentSpeaker = "";
    this.grantNextConversationTurn(room, sender.user);
  }

  private grantNextConversationTurn(room: string, sender: string): void {
    const state = this.roomState(room).conversation;
    if (!state.active) return;
    const online = new Set(this.onlineAgentNames(room).map(name => name.toLowerCase()));
    let selectedIndex = -1;
    for (let offset = 0; offset < state.participants.length; offset++) {
      const index = (state.nextIndex + offset) % state.participants.length;
      const candidate = state.participants[index];
      if (online.has(candidate.toLowerCase()) && candidate.toLowerCase() !== sender.toLowerCase()) {
        selectedIndex = index;
        break;
      }
    }
    if (selectedIndex < 0) return;
    const next = state.participants[selectedIndex];
    state.currentSpeaker = next;
    state.nextIndex = (selectedIndex + 1) % state.participants.length;
    state.turns++;
    this.postTurnGrant(room, next);
  }

  private postTurnGrant(room: string, name: string): void {
    const wanted = name.toLowerCase();
    for (const conn of this.conns.values()) {
      if (!conn.joined || conn.room !== room || conn.kind !== "agent" || conn.user.toLowerCase() !== wanted) continue;
      this.sendTo(conn.ws, {
        t: "msg", room, id: randomBytes(6).toString("hex"),
        from: BOT_NAME, fromId: "roombot",
        text: `🎙️ ${this.formatMention(name)}, your turn. Respond to the latest free-talk message, then return to standby.`,
        ts: Date.now(), kind: "agent",
      });
    }
  }

  // Answer a slash command privately (only the requester sees the bot reply).
  private handleCommand(conn: HubConn, text: string): void {
    const st = this.rooms.get(conn.room);
    const isOwner = !!st && this.isOwnerConn(st, conn);
    const cmd = findCommand(text);
    if (!cmd) { this.botReply(conn, `Unknown command "${text.split(/\s+/)[0]}". Type /help for the list.`); return; }
    if (cmd.hostOnly && !isOwner) { this.botReply(conn, `"/${cmd.name}" is available to the room host only.`); return; }
    const arg = (text.match(/^\/\S+\s*([\s\S]*)$/)?.[1] ?? "").trim();
    try { this.botReply(conn, cmd.run(this.buildCmdCtx(conn, isOwner, arg))); }
    catch (e) { this.botReply(conn, `Command failed: ${(e as Error).message}`); }
    this.log(`command /${cmd.name} by ${conn.user} in ${conn.room}`);
  }

  private buildCmdCtx(conn: HubConn, isOwner: boolean, arg: string): CommandContext {
    const wsUrl = `ws://${ChatHub.localIp()}:${this._port}`;
    return {
      room: conn.room, isOwner, wsUrl,
      joinUrl: `${wsUrl}/${encodeURIComponent(conn.room)}`,
      members: this.rosterOf(conn.room), arg,
      actions: {
        muteAll:   () => this.muteAllExceptHost(conn.room),
        unmuteAll: () => this.unmuteAllInRoom(conn.room),
        rotateSecret: () => !!this.rotateRoomSecret(conn.room),
        inviteMessage: () => {
          const secret = this.roomSecret.get(conn.room);
          if (!secret) throw new Error("Room secret is unavailable.");
          return chatInviteMessage(createChatMagicLink(`${wsUrl}/${encodeURIComponent(conn.room)}`, secret));
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
  private rotateSecretInternal(room: string, note: string): string | undefined {
    const st = this.rooms.get(room);
    if (!st || !this.roomSecret.has(room)) return undefined;
    const fresh = randomBytes(9).toString("base64url");
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
  rotateRoomSecret(room: string): string | undefined {
    const s = this.rotateSecretInternal(ChatHub.canonRoom(room), `🔑 The host rotated the room secret. New members need the new secret.`);
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
  private handleAdmin(conn: HubConn, frame: Extract<Frame, { t: "admin" }>): void {
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
        for (const t of targets) {
          this.sendTo(t.ws, { t: "kicked", room: conn.room, reason: "Removed by the host." });
          t.joined = false;                 // stop onClose from re-broadcasting a "left" line
          this.conns.delete(t.ws);
          try { t.ws.close(); } catch { /* ignore */ }
        }
        st.muted.delete(targetKey);
        st.roster.delete(targetKey);
        st.conversation.participants = st.conversation.participants.filter(name => name.toLowerCase() !== who.toLowerCase());
        const removedCurrent = st.conversation.currentSpeaker.toLowerCase() === who.toLowerCase();
        if (removedCurrent) st.conversation.currentSpeaker = "";
        this.broadcast(conn.room, { t: "system", room: conn.room, text: `${who} was permanently removed by the host`, ts: Date.now() });
        // Rotate the room secret so the removed member can't immediately rejoin
        // with the secret they already had. Existing members stay connected (the
        // secret is only checked at join); only NEW joins need the fresh secret.
        this.rotateSecretInternal(conn.room, `🔑 Room secret was rotated after removing ${who}. New members need the new secret.`);
        this.broadcastPresence(conn.room);
        if (removedCurrent && st.conversation.active) this.grantNextConversationTurn(conn.room, "");
        this.log(`admin kick room=${conn.room} target=${who} (secret rotated)`);
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
        // Apply the new name, then re-key everything keyed by the OLD identity
        // (roster, mutes, ownership) to the NEW identity.
        for (const t of targets) { t.user = newName; this.sendTo(t.ws, { t: "renamed", room: conn.room, name: newName }); }
        const newKey = targets.length ? this.identityKey(targets[0]) : targetKey;
        const e = st.roster.get(targetKey);
        if (e) { st.roster.delete(targetKey); e.user = newName; e.key = newKey; st.roster.set(newKey, e); }
        if (st.muted.has(targetKey)) { st.muted.delete(targetKey); st.muted.add(newKey); }
        if (st.owner === targetKey) { st.owner = newKey; st.ownerName = newName; }
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
        }
        for (const target of targets) {
          target.user = newName;
          if (nameChanged) this.sendTo(target.ws, { t: "renamed", room: conn.room, name: newName });
        }
        const newKey = nameChanged
          ? (targets.length ? this.identityKey(targets[0]) : (entry.sid ? `cid:${entry.sid}:${newName.toLowerCase()}` : `name:${newName.toLowerCase()}`))
          : targetKey;
        const wasMuted = st.muted.delete(targetKey);
        if (newKey !== targetKey) st.roster.delete(targetKey);
        entry.key = newKey;
        entry.user = newName;
        entry.role = newRole;
        st.roster.set(newKey, entry);
        if (wasMuted) st.muted.add(newKey);
        if (st.owner === targetKey) { st.owner = newKey; st.ownerName = newName; }
        st.conversation.participants = st.conversation.participants.map(name => name.toLowerCase() === oldName.toLowerCase() ? newName : name);
        if (st.conversation.currentSpeaker.toLowerCase() === oldName.toLowerCase()) st.conversation.currentSpeaker = newName;
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
      e.sid = conn.cid || e.sid; e.verified = verified; e.lastSeen = now;
      return prevName;
    }
    st.roster.set(key, {
      key, id: conn.id, user: conn.user, kind: conn.kind,
      sid: conn.cid || "", verified, present: true, firstSeen: now, lastSeen: now, role: "",
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
        host: !!owner && e.key === owner,
        sid: e.sid, verified: e.verified, present: e.present, lastSeen: e.lastSeen,
        muted: st.muted.has(e.key),
        role: e.role,
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

