import { AgentRuntimeState, ChatMessage, ChatMode, CHUNK_BYTES, FileMeta, Frame, MAX_FILE_BYTES, Member, MemberKind, ReplyPolicy } from "./chatroom-protocol";
import { WebSocket } from "ws";
import { randomBytes } from "crypto";

// ── Client (one connection == one room) ───────────────────────────────────────
export type ChatStatus = "disconnected" | "connecting" | "connected" | "error";

export interface JoinOpts {
  url:   string;
  room:  string;
  roomId?: string;
  user:  string;
  token: string;
  kind?: MemberKind;
  cid?:  string;   // stable identity id (persisted by the extension/MCP); defaults to a random per-instance id
  hostToken?: string; // ephemeral proof returned by the local Hub Create/Rehost API
}

export interface ClientEvents {
  onStatus:       (status: ChatStatus, detail?: string) => void;
  onMessage:      (m: ChatMessage) => void;
  onHistory:      (messages: ChatMessage[]) => void;
  onPresence:     (members: Member[]) => void;
  onAgentState?:  (user: string, state: AgentRuntimeState) => void;
  onReadReceipt?: (messageId: string, read: number, total: number) => void;
  onFileComplete: (meta: FileMeta, from: string, data: Buffer) => void;
  onRejected?:    (code: string, msg: string) => void;
  onRenamed?:     (name: string) => void;
  onRekey?:       (secret: string) => void;
  onJoinPending?: (requestId: string, expiresAt: number) => void;
  onJoinApproved?: (participantId: string, outcome: "new" | "reuse") => void;
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
  private lastMessageId = "";

  status:   ChatStatus = "disconnected";
  members:  Member[]   = [];
  selfUser = "";
  selfRoom = "";
  participantId = "";

  constructor(events: ClientEvents, logger?: (m: string) => void) {
    this.events = events;
    this.log = logger ?? (() => {});
  }

  get isConnected(): boolean { return this.status === "connected"; }

  /** This client's stable identity id (its cid) — matches the `sid` in presence. */
  get identity(): string { return this.cid; }

  connect(opts: JoinOpts): void {
    const sameRoom = !!this.opts && this.opts.room === opts.room && (this.opts.roomId || "") === (opts.roomId || "");
    this.disconnect();
    if (!sameRoom) this.lastMessageId = "";
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
      this.send({ t: "join", room: this.opts!.room, roomId: this.opts!.roomId, user: this.opts!.user, token: this.opts!.token, kind: this.opts!.kind ?? "human", cid: this.cid, hostToken: this.opts!.hostToken, resumeAfter: this.lastMessageId || undefined });
      this.setStatus("connecting", "waiting for Host approval…");
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
      case "join.pending":
        this.setStatus("connecting", "waiting for Host approval…");
        this.events.onJoinPending?.(frame.requestId, frame.expiresAt);
        break;
      case "join.approved":
        this.participantId = frame.participantId;
        this.events.onJoinApproved?.(frame.participantId, frame.outcome);
        break;
      case "join.ready":
        this.setStatus("connected");
        break;
      case "presence":
        this.members = frame.members;
        this.events.onPresence(frame.members);
        break;
      case "history":
        if (frame.messages.length) this.lastMessageId = frame.messages[frame.messages.length - 1].id || this.lastMessageId;
        if (frame.mode === "catchup") {
          for (const message of frame.messages) this.events.onMessage(message);
        } else {
          this.events.onHistory(frame.messages);
        }
        break;
      case "msg":
        if (frame.id) this.lastMessageId = frame.id;
        if (frame.id && frame.receipt?.ack) {
          this.send({ t: "msg.read", room: frame.room, messageId: frame.id });
        }
        this.events.onMessage({
          id: frame.id ?? randomBytes(6).toString("hex"), from: frame.from, fromId: frame.fromId ?? "",
          text: frame.text, ts: frame.ts ?? Date.now(), kind: frame.kind ?? "human", file: (frame as any).file,
          receipt: frame.receipt ? { read: frame.receipt.read, total: frame.receipt.total } : undefined,
          responseRequired: frame.responseRequired,
            replyPolicy: frame.replyPolicy, mode: frame.mode, discussionAudience: frame.discussionAudience,
            replyToMessageId: frame.replyToMessageId,
            recipients: frame.recipients,
        });
        break;
      case "msg.read":
        this.events.onReadReceipt?.(frame.messageId, frame.read ?? 0, frame.total ?? 0);
        break;
      case "system":
        this.events.onMessage({ id: randomBytes(6).toString("hex"), from: "", fromId: "", text: frame.text, ts: frame.ts, kind: "human", system: true });
        break;
      case "agent.state":
        this.events.onAgentState?.(frame.user || "", frame.state);
        break;
      case "closed":
        this.intentionalClose = true;   // the room is gone; don't reconnect
        this.events.onMessage({ id: randomBytes(6).toString("hex"), from: "", fromId: "", text: `Room closed (${frame.reason}).`, ts: Date.now(), kind: "human", system: true });
        this.setStatus("disconnected", `closed: ${frame.reason}`);
        break;
      case "stopped":
        this.intentionalClose = true;
        this.events.onMessage({ id: randomBytes(6).toString("hex"), from: "", fromId: "", text: frame.reason || "Stopped by the room host.", ts: Date.now(), kind: "human", system: true });
        this.setStatus("disconnected", "stopped by host");
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
      case "room.renamed":
        if (this.opts) this.opts.room = frame.room;
        this.selfRoom = frame.room;
        this.events.onMessage({ id: randomBytes(6).toString("hex"), from: "", fromId: "", text: `Room renamed to "${frame.room}".`, ts: Date.now(), kind: "human", system: true });
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
        // A rejected action is scoped to that action; it must not poison the live connection.
        if (["muted", "moderation", "mention-required", "host-only-broadcast", "phase-closed", "duplicate-slot"].includes(frame.code)) {
          this.events.onMessage({ id: randomBytes(6).toString("hex"), from: "", fromId: "", text: frame.msg, ts: Date.now(), kind: "human", system: true });
          break;
        }
        this.setStatus("error", frame.msg);
        if (frame.code === "auth" || frame.code === "name-taken" || frame.code === "no-room" || frame.code === "room-mismatch" || frame.code === "join-rejected" || frame.code === "join-timeout" || frame.code === "join-cancelled") {
          this.intentionalClose = true; // don't retry: creds/name/room won't fix themselves
          this.events.onRejected?.(frame.code, frame.msg);
        }
        break;
      case "pong": break;
    }
  }

  sendText(text: string, responseRequired?: boolean, replyPolicy?: ReplyPolicy, mode?: ChatMode, recipients?: string[], replyToMessageId?: string): boolean {
    if (!this.isConnected || !this.opts) return false;
    const t = text.trim();
    if (!t) return false;
    this.send({ t: "msg", room: this.opts.room, from: this.opts.user, text: t, kind: this.opts.kind ?? "human", responseRequired, replyPolicy, mode,
      clientRequestId: randomBytes(8).toString("hex"), recipients, replyToMessageId });
    return true;
  }

  sendAgentState(state: AgentRuntimeState): boolean {
    if (!this.isConnected || !this.opts || this.opts.kind !== "agent") return false;
    this.send({ t: "agent.state", room: this.opts.room, user: this.opts.user, state });
    return true;
  }

  /** Host-only: moderate another member (kick / mute / unmute / rename). */
  sendAdmin(action: "kick" | "mute" | "unmute" | "rename" | "edit", target: string, name?: string, role?: string): boolean {
    if (!this.isConnected || !this.opts) return false;
    this.send({ t: "admin", room: this.opts.room, action, target, name, role });
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

