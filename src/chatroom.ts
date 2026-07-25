// Agent Chatroom: a real-time collaboration hub where humans and their AI agents
// share named rooms. Three moving parts:
//
//   • ChatHub    — a self-hosted HTTP + WebSocket relay one teammate hosts. It
//                  routes chat/presence/file frames, keeps a short *chat* history
//                  per room (so late joiners and the browser view see context),
//                  and serves a **browser view** so non-VS-Code folks can watch or
//                  participate. It NEVER stores shared files — those relay live
//                  between online peers only.
//   • ChatClient — one WebSocket connection = one room. Sends/receives chat,
//                  presence, and files (chunked, in-memory). Reconnect w/ backoff.
//   • (manager)  — the extension composes many ChatClients so one person can hold
//                  multiple rooms at once (see extension.ts).
//
// Auth (MVP): a team shared secret validated at the hub on `join`; default-deny.
// Transport is ws:// for the corpnet/VPN MVP (wss/TLS is a later phase).
import { WebSocketServer, WebSocket } from "ws";
import { createServer, Server, IncomingMessage, ServerResponse } from "http";
import { networkInterfaces } from "os";
import { randomBytes, timingSafeEqual, createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { findCommand, BOT_NAME, CommandContext } from "./chat-commands";

// ── Protocol ────────────────────────────────────────────────────────────────
export type MemberKind = "human" | "agent" | "browser";

export interface FileMeta {
  fileId: string;
  name:   string;
  size:   number;
  mime:   string;
}

export type Frame =
  | { t: "join";       room: string; user: string; token: string; kind?: MemberKind; cid?: string }
  | { t: "leave";      room: string }
  | { t: "presence";   room: string; members: Member[] }
  | { t: "msg";        id?: string; room: string; from: string; fromId?: string; text: string; ts?: number; kind?: MemberKind }
  | { t: "system";     room: string; text: string; ts: number }
  | { t: "history";    room: string; messages: ChatMessage[] }
  | { t: "closed";     room: string; reason: string }
  | { t: "admin";      room: string; action: "kick" | "mute" | "unmute" | "rename"; target: string; name?: string }
  | { t: "kicked";     room: string; reason: string }
  | { t: "renamed";    room: string; name: string }
  | { t: "rekey";      room: string; secret: string }
  | { t: "file.offer"; id?: string; room: string; from: string; fromId?: string; ts?: number; kind?: MemberKind; file: FileMeta }
  | { t: "file.chunk"; room: string; fileId: string; seq: number; data: string; last: boolean }
  | { t: "error";      code: string; msg: string }
  | { t: "ping" }
  | { t: "pong" };

export interface Member {
  id:    string;
  user:  string;
  kind:  MemberKind;
  host?: boolean;   // true for the room owner/host
  sid?:  string;    // short stable identity id (from the client's cid) — disambiguates same display names
  verified?: boolean; // true when the identity is server-trusted (extension/MCP persisted id) vs best-effort (browser)
  present?: boolean;  // false = in the roster history but not currently connected
  lastSeen?: number;  // ms epoch of the last time this identity was seen (for "left …")
  muted?: boolean;    // true when the host has muted this identity (can read but not post)
}

export interface ChatMessage {
  id:      string;
  from:    string;
  fromId:  string;
  text:    string;
  ts:      number;
  kind:    MemberKind;
  system?: boolean;
  file?:   FileMeta;   // present when this line announces a shared file
}

// File-transfer limits (in-memory relay; keeps the DoS surface small).
export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
export const CHUNK_BYTES     = 64 * 1024;        // 64 KB raw per chunk

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
      s = { history: [], owner: "", ownerName: "", graceTimer: null, roster: new Map(), muted: new Set() };
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
      // Explicit leave: if the host leaves, deactivate the whole room immediately.
      const st = this.rooms.get(conn.room);
      if (st && st.owner && (conn.cid === st.owner || conn.id === st.owner)) {
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

    if (!conn.joined) {
      if (frame.t !== "join") { this.sendTo(conn.ws, { t: "error", code: "not-joined", msg: "join first" }); return; }
      const desired = (frame.user || "anon").slice(0, 60);
      const room    = ChatHub.canonRoom(frame.room);
      const cid     = (frame.cid  || "").slice(0, 32);
      const token   = frame.token ?? "";
      const kind: MemberKind = frame.kind === "agent" ? "agent" : frame.kind === "browser" ? "browser" : "human";
      // Per-room secret: the room's creator sets it; everyone else must match it.
      const known = this.roomSecret.get(room);
      if (known !== undefined) {
        if (!constantTimeEquals(token, known)) {
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
      const nameKey = desired.trim().toLowerCase();
      for (const other of this.conns.values()) {
        if (other === conn || !other.joined || other.room !== room) continue;
        if (other.user.trim().toLowerCase() !== nameKey) continue;
        if (cid && other.cid && other.cid === cid) {
          // Same identity reconnecting — drop the stale connection and let this one in.
          try { other.ws.close(); } catch { /* ignore */ }
          this.conns.delete(other.ws);
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
      this.log(`join room=${conn.room} user=${conn.user} kind=${conn.kind}`);
      const st = this.roomState(conn.room);
      // First real participant owns the room; the room deactivates when they leave.
      const becameOwner = !st.owner && conn.kind !== "browser";
      if (becameOwner) { st.owner = conn.cid || conn.id; st.ownerName = conn.user; }
      // Owner reconnected within the grace window — cancel the pending deactivation.
      if (st.owner && (conn.cid === st.owner || conn.id === st.owner) && st.graceTimer) {
        clearTimeout(st.graceTimer); st.graceTimer = null;
      }
      const prevName = this.rosterJoin(conn, st);
      // Backfill recent chat history to the joining member (files are never stored).
      if (st.history.length) this.sendTo(conn.ws, { t: "history", room: conn.room, messages: st.history });
      const joinText = (prevName && prevName !== conn.user)
        ? `${prevName} rejoined with new name ${conn.user}`
        : `${conn.user} joined the room`;
      this.broadcast(conn.room, { t: "system", room: conn.room, text: joinText, ts: Date.now() });
      this.broadcastPresence(conn.room);
      // Greet the host who just created a room with the /help cheat-sheet.
      if (becameOwner) this.sendHelp(conn, `👋 Welcome — you're now hosting "${conn.room}". Here are the magic messages you can type:`);
      return;
    }

    if (frame.t === "msg") {
      const text = (frame.text ?? "").toString().slice(0, 8000);
      if (!text.trim()) return;
      // Slash commands are intercepted (never broadcast) and answered privately by
      // the background sender — allowed even when muted (they aren't room posts).
      if (text.trim().startsWith("/")) { this.handleCommand(conn, text.trim()); return; }
      if (this.isMuted(conn)) { this.sendTo(conn.ws, { t: "error", code: "muted", msg: "You are muted by the host and can't post right now." }); return; }
      const m: ChatMessage = {
        id: randomBytes(6).toString("hex"), from: conn.user, fromId: conn.id,
        text, ts: Date.now(), kind: conn.kind,
      };
      this.remember(conn.room, m);
      this.broadcast(conn.room, { t: "msg", room: conn.room, ...m });
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
    this.broadcast(conn.room, { t: "system", room: conn.room, text: `${conn.user} left the room`, ts: Date.now() });
    this.broadcastPresence(conn.room);
    const isOwner = st.owner && (conn.cid === st.owner || conn.id === st.owner);
    if (isOwner) {
      // Host disconnected: give a short grace for reconnect, then deactivate.
      if (st.graceTimer) clearTimeout(st.graceTimer);
      st.graceTimer = setTimeout(() => {
        const back = [...this.conns.values()].some(c => c.joined && c.room === conn.room && (c.cid === st.owner || c.id === st.owner));
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
    const owner = st?.owner;
    return [...this.conns.values()]
      .filter(c => c.joined && c.room === room)
      .map(c => ({ id: c.id, user: c.user, kind: c.kind, host: !!owner && (c.cid === owner || c.id === owner), muted: !!st?.muted.has(this.identityKey(c)) }));
  }

  // A stable per-identity key: prefer the client's cid (extension/MCP/browser
  // persisted), else fall back to the display name so same-name reconnects merge.
  private identityKey(conn: HubConn): string {
    return conn.cid ? `cid:${conn.cid}` : `name:${conn.user.trim().toLowerCase()}`;
  }

  private isMuted(conn: HubConn): boolean {
    const st = this.rooms.get(conn.room);
    return !!st && st.muted.has(this.identityKey(conn));
  }

  // Answer a slash command privately (only the requester sees the bot reply).
  private handleCommand(conn: HubConn, text: string): void {
    const st = this.rooms.get(conn.room);
    const isOwner = !!st?.owner && (conn.cid === st.owner || conn.id === st.owner);
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
      if (st.owner && (c.cid === st.owner || c.id === st.owner)) continue;   // never mute the host
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
      if (c.joined && c.room === room && st.owner && (c.cid === st.owner || c.id === st.owner)) {
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

  // Host-only moderation: kick, mute/unmute, rename another member. Rejected for
  // anyone who isn't the room owner.
  private handleAdmin(conn: HubConn, frame: Extract<Frame, { t: "admin" }>): void {
    const st = this.rooms.get(conn.room);
    if (!st) return;
    const isOwner = !!st.owner && (conn.cid === st.owner || conn.id === st.owner);
    if (!isOwner) { this.sendTo(conn.ws, { t: "error", code: "moderation", msg: "Only the host can moderate this room." }); return; }
    const targetKey = (frame.target || "").slice(0, 120);
    if (!targetKey) return;
    if (targetKey === this.identityKey(conn)) { this.sendTo(conn.ws, { t: "error", code: "moderation", msg: "You can't moderate yourself." }); return; }
    const targets = [...this.conns.values()].filter(c => c.joined && c.room === conn.room && this.identityKey(c) === targetKey);
    const who = st.roster.get(targetKey)?.user || targets[0]?.user || "member";

    switch (frame.action) {
      case "kick": {
        for (const t of targets) {
          this.sendTo(t.ws, { t: "kicked", room: conn.room, reason: "Removed by the host." });
          t.joined = false;                 // stop onClose from re-broadcasting a "left" line
          this.markDeparted(t, st);
          this.conns.delete(t.ws);
          try { t.ws.close(); } catch { /* ignore */ }
        }
        st.muted.delete(targetKey);
        this.broadcast(conn.room, { t: "system", room: conn.room, text: `${who} was removed by the host`, ts: Date.now() });
        // Rotate the room secret so the removed member can't immediately rejoin
        // with the secret they already had. Existing members stay connected (the
        // secret is only checked at join); only NEW joins need the fresh secret.
        this.rotateSecretInternal(conn.room, `🔑 Room secret was rotated after removing ${who}. New members need the new secret.`);
        this.broadcastPresence(conn.room);
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
        const clash = [...this.conns.values()].some(
          c => c.joined && c.room === conn.room && this.identityKey(c) !== targetKey && c.user.trim().toLowerCase() === nk);
        if (clash) { this.sendTo(conn.ws, { t: "error", code: "moderation", msg: `"${newName}" is already taken in this room.` }); return; }
        for (const t of targets) { t.user = newName; this.sendTo(t.ws, { t: "renamed", room: conn.room, name: newName }); }
        const e = st.roster.get(targetKey); if (e) e.user = newName;
        this.broadcast(conn.room, { t: "system", room: conn.room, text: `${who} was renamed to ${newName} by the host`, ts: Date.now() });
        this.broadcastPresence(conn.room);
        this.log(`admin rename room=${conn.room} ${who} -> ${newName}`);
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
      sid: conn.cid || "", verified, present: true, firstSeen: now, lastSeen: now,
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
        host: !!owner && (e.sid === owner || e.id === owner),
        sid: e.sid, verified: e.verified, present: e.present, lastSeen: e.lastSeen,
        muted: st.muted.has(e.key),
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

// ── Client (one connection == one room) ───────────────────────────────────────
export type ChatStatus = "disconnected" | "connecting" | "connected" | "error";

export interface JoinOpts {
  url:   string;
  room:  string;
  user:  string;
  token: string;
  kind?: MemberKind;
  cid?:  string;   // stable identity id (persisted by the extension/MCP); defaults to a random per-instance id
}

export interface ClientEvents {
  onStatus:       (status: ChatStatus, detail?: string) => void;
  onMessage:      (m: ChatMessage) => void;
  onHistory:      (messages: ChatMessage[]) => void;
  onPresence:     (members: Member[]) => void;
  onFileComplete: (meta: FileMeta, from: string, data: Buffer) => void;
  onRejected?:    (code: string, msg: string) => void;
  onRenamed?:     (name: string) => void;
  onRekey?:       (secret: string) => void;
}

interface Incoming { meta: FileMeta; chunks: Buffer[]; from: string; received: number; }

export class ChatClient {
  private ws:      WebSocket | null = null;
  private opts:    JoinOpts | null  = null;
  private events:  ClientEvents;
  private intentionalClose = false;
  private reconnectDelay   = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer:      NodeJS.Timeout | null = null;
  private incoming: Map<string, Incoming> = new Map();
  private cid = randomBytes(4).toString("hex");   // stable identity across reconnects
  private log: (m: string) => void;

  status:   ChatStatus = "disconnected";
  members:  Member[]   = [];
  selfUser = "";
  selfRoom = "";

  constructor(events: ClientEvents, logger?: (m: string) => void) {
    this.events = events;
    this.log = logger ?? (() => {});
  }

  get isConnected(): boolean { return this.status === "connected"; }

  /** This client's stable identity id (its cid) — matches the `sid` in presence. */
  get identity(): string { return this.cid; }

  connect(opts: JoinOpts): void {
    this.disconnect();
    this.opts = opts;
    this.selfUser = opts.user;
    this.selfRoom = opts.room;
    if (opts.cid) this.cid = opts.cid;   // use the caller's stable identity when provided
    this.intentionalClose = false;
    this.reconnectDelay = 1000;
    this.open();
  }

  private open(): void {
    if (!this.opts) return;
    this.setStatus("connecting");
    let ws: WebSocket;
    try { ws = new WebSocket(this.opts.url, { handshakeTimeout: 8000 }); }
    catch (e: any) { this.setStatus("error", e?.message ?? "bad url"); this.scheduleReconnect(); return; }
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectDelay = 1000;
      this.send({ t: "join", room: this.opts!.room, user: this.opts!.user, token: this.opts!.token, kind: this.opts!.kind ?? "human", cid: this.cid });
      this.setStatus("connected");
      this.startPing();
    });
    ws.on("message", raw => this.onFrame(raw.toString()));
    ws.on("close", () => {
      this.stopPing();
      if (this.intentionalClose) { this.setStatus("disconnected"); return; }
      this.setStatus("connecting", "reconnecting…");
      this.scheduleReconnect();
    });
    ws.on("error", (e: any) => { this.log(`chat client error: ${e?.message ?? e}`); });
  }

  private onFrame(raw: string): void {
    let frame: Frame;
    try { frame = JSON.parse(raw); } catch { return; }
    switch (frame.t) {
      case "presence":
        this.members = frame.members;
        this.events.onPresence(frame.members);
        break;
      case "history":
        this.events.onHistory(frame.messages);
        break;
      case "msg":
        this.events.onMessage({
          id: frame.id ?? randomBytes(6).toString("hex"), from: frame.from, fromId: frame.fromId ?? "",
          text: frame.text, ts: frame.ts ?? Date.now(), kind: frame.kind ?? "human", file: (frame as any).file,
        });
        break;
      case "system":
        this.events.onMessage({ id: randomBytes(6).toString("hex"), from: "", fromId: "", text: frame.text, ts: frame.ts, kind: "human", system: true });
        break;
      case "closed":
        this.intentionalClose = true;   // the room is gone; don't reconnect
        this.events.onMessage({ id: randomBytes(6).toString("hex"), from: "", fromId: "", text: `Room closed (${frame.reason}).`, ts: Date.now(), kind: "human", system: true });
        this.setStatus("disconnected", `closed: ${frame.reason}`);
        break;
      case "kicked":
        this.intentionalClose = true;   // removed by host; don't reconnect
        this.events.onMessage({ id: randomBytes(6).toString("hex"), from: "", fromId: "", text: frame.reason || "You were removed by the host.", ts: Date.now(), kind: "human", system: true });
        this.setStatus("disconnected", "removed by host");
        this.events.onRejected?.("kicked", frame.reason || "Removed by the host.");
        break;
      case "renamed":
        if (this.opts) this.opts.user = frame.name;
        this.selfUser = frame.name;
        this.events.onMessage({ id: randomBytes(6).toString("hex"), from: "", fromId: "", text: `The host renamed you to "${frame.name}".`, ts: Date.now(), kind: "human", system: true });
        this.events.onRenamed?.(frame.name);
        break;
      case "rekey":
        // The host rotated this room's secret (e.g. after a kick). Keep using it
        // for future reconnects, and let the app persist/share the new value.
        if (this.opts) this.opts.token = frame.secret;
        this.events.onRekey?.(frame.secret);
        break;
      case "file.offer":
        this.incoming.set(frame.file.fileId, { meta: frame.file, chunks: [], from: frame.from, received: 0 });
        this.events.onMessage({
          id: randomBytes(6).toString("hex"), from: frame.from, fromId: frame.fromId ?? "",
          text: `📎 shared a file: ${frame.file.name}`, ts: frame.ts ?? Date.now(), kind: frame.kind ?? "human", file: frame.file,
        });
        break;
      case "file.chunk": {
        const inc = this.incoming.get(frame.fileId);
        if (!inc) break;
        const buf = Buffer.from(frame.data, "base64");
        inc.chunks.push(buf);
        inc.received += buf.length;
        if (frame.last) {
          this.incoming.delete(frame.fileId);
          this.events.onFileComplete(inc.meta, inc.from, Buffer.concat(inc.chunks));
        }
        break;
      }
      case "error":
        // Moderation notices (mute/unmute, forbidden, rename clash) are informational —
        // surface them in the log without flipping the connection into an error state.
        if (frame.code === "muted" || frame.code === "moderation") {
          this.events.onMessage({ id: randomBytes(6).toString("hex"), from: "", fromId: "", text: frame.msg, ts: Date.now(), kind: "human", system: true });
          break;
        }
        this.setStatus("error", frame.msg);
        if (frame.code === "auth" || frame.code === "name-taken" || frame.code === "no-room") {
          this.intentionalClose = true; // don't retry: creds/name/room won't fix themselves
          this.events.onRejected?.(frame.code, frame.msg);
        }
        break;
      case "pong": break;
    }
  }

  sendText(text: string): boolean {
    if (!this.isConnected || !this.opts) return false;
    const t = text.trim();
    if (!t) return false;
    this.send({ t: "msg", room: this.opts.room, from: this.opts.user, text: t, kind: this.opts.kind ?? "human" });
    return true;
  }

  /** Host-only: moderate another member (kick / mute / unmute / rename). */
  sendAdmin(action: "kick" | "mute" | "unmute" | "rename", target: string, name?: string): boolean {
    if (!this.isConnected || !this.opts) return false;
    this.send({ t: "admin", room: this.opts.room, action, target, name });
    return true;
  }

  /** Stream a file to the room (chunked, in-memory, no hub storage). */
  async sendFile(name: string, mime: string, data: Buffer): Promise<{ ok: boolean; error?: string }> {
    if (!this.isConnected || !this.opts) return { ok: false, error: "not connected" };
    if (data.length > MAX_FILE_BYTES) return { ok: false, error: `file exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB limit` };
    const fileId = randomBytes(6).toString("hex");
    const meta: FileMeta = { fileId, name, size: data.length, mime };
    this.send({ t: "file.offer", room: this.opts.room, from: this.opts.user, kind: this.opts.kind ?? "human", file: meta });
    let seq = 0;
    for (let off = 0; off < data.length; off += CHUNK_BYTES) {
      const slice = data.subarray(off, Math.min(off + CHUNK_BYTES, data.length));
      const last  = off + CHUNK_BYTES >= data.length;
      this.send({ t: "file.chunk", room: this.opts.room, fileId, seq: seq++, data: slice.toString("base64"), last });
      await this.drain();
    }
    return { ok: true };
  }

  // Simple backpressure: yield while the socket send buffer is large.
  private async drain(): Promise<void> {
    const ws = this.ws;
    if (!ws) return;
    while (ws.bufferedAmount > 4 * 1024 * 1024) {
      await new Promise(r => setTimeout(r, 20));
    }
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopPing();
    if (this.ws) {
      // Tell the hub we're leaving on purpose (so a host's room deactivates now).
      if (this.ws.readyState === WebSocket.OPEN && this.opts) this.send({ t: "leave", room: this.opts.room });
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.members = [];
    this.incoming.clear();
    this.setStatus("disconnected");
  }

  private send(frame: Frame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(frame)); } catch { /* ignore */ }
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15000);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.open(); }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send({ t: "ping" }), 25_000);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private setStatus(status: ChatStatus, detail?: string): void {
    this.status = status;
    this.events.onStatus(status, detail);
  }
}

// ── Browser view (served by the hub over HTTP) ────────────────────────────────
// A single self-contained page: enter room + name + shared secret, then watch and
// participate in the room over WebSocket. File downloads are not offered here —
// files relay peer-to-peer between online VS Code clients only.
export function browserViewHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PKM Agent Room</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#1e1e1e;color:#ddd;height:100vh;display:flex;flex-direction:column}
  header{padding:10px 14px;background:#252526;border-bottom:1px solid #333;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  header input{background:#3c3c3c;border:1px solid #444;border-radius:4px;color:#eee;padding:5px 8px;font-size:13px}
  header button{background:#0e639c;border:none;border-radius:4px;color:#fff;padding:5px 12px;cursor:pointer;font-size:13px}
  header button:hover{background:#1177bb}
  #dot{width:9px;height:9px;border-radius:50%;background:#888}
  #dot.on{background:#4ade80}#dot.err{background:#f87171}
  #wrap{flex:1;display:flex;min-height:0}
  #log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px}
  #side{width:180px;border-left:1px solid #333;background:#252526;padding:12px;overflow-y:auto}
  .sys{align-self:center;color:#888;font-style:italic;font-size:12px}
  .msg{max-width:80%;background:#2d2d30;border:1px solid #3a3a3a;border-radius:10px;padding:6px 10px;font-size:14px}
  .msg.agent{border-left:3px solid #a78bfa}
  .who{font-size:11px;font-weight:600;color:#4ea1ff;margin-bottom:2px}
  .who .t{color:#888;font-weight:400;margin-left:6px}
  .body{white-space:pre-wrap;word-break:break-word;line-height:1.4}
  .mem{display:flex;align-items:center;gap:6px;font-size:13px;padding:3px 0}
  .mem.gone{opacity:.5}
  .mem.muted{color:#888;font-style:italic}
  .mem .sid{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;color:#888;background:#333;border-radius:4px;padding:0 4px;margin-left:2px}
  .mem .ago{color:#888;font-size:11px;margin-left:auto}
  .mdot{width:7px;height:7px;border-radius:50%;background:#4ade80}.mdot.agent{background:#a78bfa}.mdot.gone{background:#666}
  #composer{display:flex;gap:8px;padding:10px;border-top:1px solid #333;background:#252526}
  #composer textarea{flex:1;resize:none;background:#3c3c3c;border:1px solid #444;border-radius:6px;color:#eee;padding:6px 8px;font-size:14px;font-family:inherit}
  #composer button{background:#0e639c;border:none;border-radius:6px;color:#fff;padding:0 16px;cursor:pointer}
  #attach{padding:0 12px}
  .filerow{align-self:flex-start}
  .dl{display:inline-block;color:#4ea1ff;text-decoration:none;background:#2d2d30;border:1px solid #3a3a3a;border-radius:8px;padding:5px 10px;font-size:13px}
  .dl:hover{border-color:#4ea1ff}
  .hint{color:#888;font-size:12px;padding:6px 14px}
  h4{margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#888}
</style></head><body>
<header>
  <span id="dot"></span>
  <span id="roomlabel" style="display:none;font-weight:600;color:#4ea1ff"></span>
  <input id="name" placeholder="your name" style="width:130px">
  <input id="secret" type="password" placeholder="room secret" style="width:150px">
  <button id="go" onclick="toggleConn()">Join</button>
  <span id="status" style="color:#888;font-size:12px"></span>
</header>
<div class="hint" id="hint">Enter a display name and this room's secret to watch or participate. Files shared in the room are peer-to-peer and not shown here.</div>
<div id="wrap">
  <div id="log"></div>
  <div id="side"><h4>In the room</h4><div id="members"></div></div>
</div>
<div id="composer" style="display:none">
  <input type="file" id="file" style="display:none" onchange="if(this.files[0])sendFile(this.files[0])">
  <button id="attach" onclick="document.getElementById('file').click()" title="Share a file (max 25 MB)">📎</button>
  <textarea id="input" rows="1" placeholder="Message the room… (Enter to send)"></textarea>
  <button onclick="sendMsg()">Send</button>
</div>
<script>
  var ws=null, me="", joined=false, ROOM="", incoming={};
  var shownIds={}, everJoined=false;   // de-dup by message id + track rejoins
  var cid=(function(){ try{ var k="pkm-chat-cid"; var v=localStorage.getItem(k); if(!v){ v=Math.random().toString(36).slice(2,10); localStorage.setItem(k,v); } return v; }catch(e){ return Math.random().toString(36).slice(2,10); } })();
  function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
  var q=new URLSearchParams(location.search);
  ROOM=q.get("room")||"";
  if(!ROOM){ var p=location.pathname; if(p.indexOf("/room/")===0){ try{ROOM=decodeURIComponent(p.slice(6));}catch(e){ROOM=p.slice(6);} } }
  if(ROOM){
    var rl=document.getElementById("roomlabel"); rl.textContent="Room: "+ROOM; rl.style.display="inline";
    document.getElementById("hint").textContent='You are joining room "'+ROOM+'". Enter a display name and this room secret, then click Join.';
  } else {
    document.getElementById("go").disabled=true;
    document.getElementById("hint").innerHTML='<span style="color:#f87171">No room specified. Open the room link the host shared with you.</span>';
  }
  function toggleConn(){ if(joined){ leave(); } else { join(); } }
  function leave(){ if(ws){try{ws.close();}catch(e){}} }
  function setJoined(on){
    joined=on;
    document.getElementById("go").textContent=on?"Leave":"Join";
    ["name","secret"].forEach(function(id){ document.getElementById(id).disabled=on; });
    document.getElementById("composer").style.display=on?"flex":"none";
  }
  function join(){
    if(!ROOM) return;
    var h=document.getElementById("hint"); if(h){ h.textContent=""; }   // clear any prior error
    me=document.getElementById("name").value.trim()||"viewer";
    var secret=document.getElementById("secret").value;
    if(ws){try{ws.close();}catch(e){}}
    var proto=location.protocol==="https:"?"wss":"ws";
    ws=new WebSocket(proto+"://"+location.host);
    setStatus("connecting…","");
    ws.onopen=function(){ ws.send(JSON.stringify({t:"join",room:ROOM,user:me,token:secret,kind:"browser",cid:cid})); setStatus("connected","on"); setJoined(true); };
    ws.onclose=function(){ setStatus("disconnected",""); setJoined(false); };
    ws.onmessage=function(ev){ var f; try{f=JSON.parse(ev.data);}catch(e){return;} onFrame(f); };
  }
  function setStatus(t,cls){ document.getElementById("status").textContent=t; document.getElementById("dot").className=cls; }
  function onFrame(f){
    if(f.t==="error"){
      if(f.code==="muted"||f.code==="moderation"){ append({system:true,text:f.msg}); return; }   // informational, stay joined
      setStatus("error: "+f.msg,"err"); document.getElementById("hint").innerHTML='<span style="color:#f87171">'+esc(f.msg)+'</span>'; setJoined(false); return;
    }
    if(f.t==="closed"){ append({system:true,text:"Room closed ("+f.reason+")."}); setStatus("room closed","err"); if(ws){try{ws.close();}catch(e){}} return; }
    if(f.t==="kicked"){ append({system:true,text:f.reason||"You were removed by the host."}); setStatus("removed by host","err"); if(ws){try{ws.close();}catch(e){}} return; }
    if(f.t==="renamed"){ me=f.name; append({system:true,text:'The host renamed you to "'+f.name+'".'}); return; }
    if(f.t==="presence"){ paintMembers(f.members); return; }
    if(f.t==="history"){
      var msgs=f.messages||[];
      // Only show messages you haven't seen yet (dedup by id). On a rejoin, mark
      // where you left off so you just read what happened while you were away.
      var unseen=msgs.filter(function(m){ return !m.id || !shownIds[m.id]; });
      if(everJoined){ append({system:true,text: unseen.length ? "— new messages since you left —" : "— you're back; nothing new while you were away —"}); }
      unseen.forEach(append);
      everJoined=true;
      return;
    }
    if(f.t==="system"){ append({system:true,text:f.text}); return; }
    if(f.t==="msg"){ append(f); return; }
    if(f.t==="file.offer"){ incoming[f.file.fileId]={meta:f.file,from:f.from,chunks:[]}; append({from:f.from,kind:f.kind,text:"📎 sharing a file: "+f.file.name,ts:f.ts}); return; }
    if(f.t==="file.chunk"){ var inc=incoming[f.fileId]; if(inc){ inc.chunks.push(Uint8Array.from(atob(f.data),function(c){return c.charCodeAt(0);})); if(f.last){ var blob=new Blob(inc.chunks,{type:(inc.meta.mime||"application/octet-stream")}); addFileLink(inc.meta.name, URL.createObjectURL(blob)); delete incoming[f.fileId]; } } return; }
  }
  function append(m){
    if(m && m.id){ if(shownIds[m.id]) return; shownIds[m.id]=1; }   // never render the same message twice
    var log=document.getElementById("log");
    var atBottom=log.scrollHeight-log.scrollTop-log.clientHeight<40;
    var el=document.createElement("div");
    if(m.system){ el.className="sys"; el.textContent=m.text; }
    else{
      el.className="msg"+(m.kind==="agent"?" agent":"");
      var t=m.ts?new Date(m.ts):new Date();
      var hh=("0"+t.getHours()).slice(-2)+":"+("0"+t.getMinutes()).slice(-2);
      el.innerHTML='<div class="who">'+(m.kind==="agent"?"🤖 ":"")+esc(m.from)+'<span class="t">'+hh+'</span></div><div class="body">'+esc(m.text)+'</div>';
    }
    log.appendChild(el); if(atBottom) log.scrollTop=log.scrollHeight;
  }
  function paintMembers(mm){
    function ago(ts){ if(!ts) return "left"; var s=Math.max(0,Math.round((Date.now()-ts)/1000)); if(s<60) return "left "+s+"s ago"; var m=Math.round(s/60); if(m<60) return "left "+m+"m ago"; var h=Math.round(m/60); return "left "+h+"h ago"; }
    document.getElementById("members").innerHTML=(mm||[]).map(function(m){
      var here=m.present!==false;
      var icon=m.host?"👑":m.kind==="agent"?"🤖":m.kind==="browser"?"🌐":"👤";
      var title=(m.host?"room host":m.kind==="agent"?"via MCP agent":m.kind==="browser"?"via browser":"via extension")+(m.verified===false?" · unverified identity":"");
      var sid=m.sid?'<span class="sid" title="'+(m.verified===false?"best-effort id (browser)":"stable id")+'">'+esc(m.sid)+'</span>':"";
      var mut=m.muted?' 🔇':"";
      var dotCls=here?(m.kind==="agent"?"agent":""):"gone";
      var tail=here?"":'<span class="ago">'+esc(ago(m.lastSeen))+'</span>';
      return '<div class="mem'+(here?"":" gone")+(m.muted?" muted":"")+'" title="'+title+'"><span class="mdot '+dotCls+'"></span>'+icon+' '+esc(m.user)+sid+mut+tail+'</div>';
    }).join("");
    // If the host muted me, disable my composer and show why.
    var mine=(mm||[]).filter(function(m){return m.sid&&m.sid===cid;})[0];
    var iAmMuted=!!(mine&&mine.muted);
    var input=document.getElementById("input"); var comp=document.getElementById("composer");
    if(input){ input.disabled=iAmMuted; input.placeholder=iAmMuted?"You are muted by the host — you can read but not post.":"Message the room… (Enter to send)"; }
    if(comp){ comp.style.opacity=iAmMuted?"0.6":"1"; }
  }
  function sendMsg(){
    var inp=document.getElementById("input"); var v=inp.value.trim(); if(!v||!ws) return;
    ws.send(JSON.stringify({t:"msg",room:ROOM,from:me,text:v,kind:"browser"}));
    inp.value="";
  }
  function b64(bytes){ var s=""; for(var i=0;i<bytes.length;i++) s+=String.fromCharCode(bytes[i]); return btoa(s); }
  async function sendFile(file){
    if(!ws||!joined||!file) return;
    if(file.size > 25*1024*1024){ alert("File too large (max 25 MB)."); return; }
    var buf=await file.arrayBuffer(); var bytes=new Uint8Array(buf);
    var fid=Math.random().toString(36).slice(2,10);
    ws.send(JSON.stringify({t:"file.offer",room:ROOM,from:me,kind:"browser",file:{fileId:fid,name:file.name,size:file.size,mime:(file.type||"application/octet-stream")}}));
    var CH=65536, seq=0;
    for(var off=0; off<bytes.length; off+=CH){
      var slice=bytes.subarray(off, Math.min(off+CH,bytes.length));
      ws.send(JSON.stringify({t:"file.chunk",room:ROOM,fileId:fid,seq:seq++,data:b64(slice),last:(off+CH>=bytes.length)}));
      while(ws.bufferedAmount > 4194304){ await new Promise(function(r){setTimeout(r,20);}); }
    }
    document.getElementById("file").value="";
  }
  function addFileLink(name,url){
    var log=document.getElementById("log");
    var el=document.createElement("div"); el.className="filerow";
    var a=document.createElement("a"); a.href=url; a.download=name; a.textContent="⬇ Save "+name; a.className="dl";
    el.appendChild(a); log.appendChild(el); log.scrollTop=log.scrollHeight;
  }
  document.getElementById("input").addEventListener("keydown",function(e){ if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMsg();} });
</script>
</body></html>`;
}
