import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { WebSocket } from "ws";
import { Frame, Member } from "./chatroom-protocol";
import { MAX_PEER_BYTES, parsePeerPacket } from "./peer-protocol";

interface Channel {
  id: string;
  secret: string;
  createdAt: number;
  members: Map<string, { user: string; ws: WebSocket; joinedAt: number }>;
}

export interface PortalRelayChannelSnapshot {
  channel: string;
  ageSeconds: number;
  members: { participant: string; user: string; connectedSeconds: number; open: boolean }[];
}

const short = (value: string | undefined) => (value || "-").slice(0, 8);

/** Peer-only transport: no Room lifecycle, membership archive, transcript or Meeting. */
export class PortalRelay {
  private readonly channels = new Map<string, Channel>();
  private readonly sockets = new Set<WebSocket>();

  constructor(private readonly log: (message: string) => void = () => {}) {}

  create(id: string = randomUUID(), secret = randomBytes(32).toString("base64url")): { channelId: string; secret: string } {
    if (!/^[a-f0-9-]{36}$/.test(id) || !/^[A-Za-z0-9_-]{16,256}$/.test(secret)) throw new Error("Invalid Portal transport credentials.");
    const existing = this.channels.get(id);
    if (existing && !this.matches(existing.secret, secret)) throw new Error("Portal transport credentials do not match.");
    if (!existing) this.channels.set(id, { id, secret, createdAt:Date.now(), members:new Map() });
    this.log(`portal relay: channel ${short(id)} ${existing ? "reused" : "created"}`);
    return { channelId:id, secret };
  }

  close(channelId: string, reason = "unspecified"): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    this.channels.delete(channelId);
    this.log(`portal relay: channel ${short(channelId)} closed reason=${reason} members=${channel.members.size}`);
    for (const member of channel.members.values()) {
      this.send(member.ws, { t:"closed", room:"Portal", reason:"Portal transport closed" });
      member.ws.close();
    }
  }

  stop(): void {
    for (const id of this.channels.keys()) this.close(id, "relay-stopped");
    for (const ws of this.sockets) ws.close();
    this.sockets.clear();
  }

  snapshot(): PortalRelayChannelSnapshot[] {
    const now = Date.now();
    return [...this.channels.values()].map(channel => ({
      channel:short(channel.id), ageSeconds:Math.round((now - channel.createdAt) / 1000),
      members:[...channel.members].map(([id, member]) => ({ participant:short(id), user:member.user,
        connectedSeconds:Math.round((now - member.joinedAt) / 1000), open:member.ws.readyState === WebSocket.OPEN })),
    }));
  }

  accept(ws: WebSocket, remote = "unknown"): void {
    this.sockets.add(ws);
    let channel: Channel | undefined;
    let participantId: string | undefined;
    let alive = true;
    const openedAt = Date.now();
    const joinDeadline = setTimeout(() => {
      this.log(`portal relay: socket from ${remote} closed reason=join-timeout`);
      ws.close(1008, "Portal join timed out");
    }, 10_000);
    joinDeadline.unref();
    const heartbeat = setInterval(() => {
      if (!alive) {
        this.log(`portal relay: channel ${short(channel?.id)} participant ${short(participantId)} terminated reason=heartbeat-timeout`);
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, 30_000);
    heartbeat.unref();
    ws.on("pong", () => { alive = true; });
    ws.on("message", raw => {
      alive = true;
      try {
        const bytes = Array.isArray(raw) ? raw.reduce((total, chunk) => total + chunk.byteLength, 0) : raw.byteLength;
        if (bytes > MAX_PEER_BYTES + 4096) throw new Error("Portal frame is too large.");
        let frame: unknown;
        try { frame = JSON.parse(raw.toString()); }
        catch { throw new Error("Invalid Portal frame."); }
        if (!frame || typeof frame !== "object" || !("t" in frame)) throw new Error("Invalid Portal frame.");
        if (frame.t === "ping") { this.send(ws, { t:"pong" }); return; }
        if (!channel) {
          if (frame.t !== "join" || !("roomId" in frame) || typeof frame.roomId !== "string" || !("token" in frame) || typeof frame.token !== "string"
            || !("cid" in frame) || typeof frame.cid !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(frame.cid)
            || !("user" in frame) || typeof frame.user !== "string" || !frame.user.trim() || frame.user.length > 60) throw new Error("Invalid Portal join.");
          const target = this.channels.get(frame.roomId);
          if (!target || !this.matches(target.secret, frame.token)) {
            this.log(`portal relay: join from ${remote} user=${frame.user} rejected reason=${target ? "bad-credentials" : "unknown-channel"} channel=${short(frame.roomId)}`);
            throw new Error("Portal transport is unavailable or its credentials are invalid.");
          }
          const identity = createHmac("sha256", target.secret).update(frame.cid).digest("hex").slice(0, 32);
          for (const [id, member] of target.members) if (member.ws.readyState !== WebSocket.OPEN) target.members.delete(id);
          const stale = target.members.get(identity);
          if (stale) {
            // Same endpoint (same channel secret and cid) reconnecting before its old socket timed out: the new socket wins.
            this.log(`portal relay: channel ${short(target.id)} participant ${short(identity)} reconnected from ${remote}; replacing stale socket`);
            target.members.delete(identity);
            stale.ws.terminate();
          }
          if (target.members.size >= 2) {
            this.log(`portal relay: join from ${remote} user=${frame.user} rejected reason=channel-full channel=${short(target.id)}`);
            throw new Error("This Portal already has its two endpoints.");
          }
          channel = target; participantId = identity;
          target.members.set(identity, { user:frame.user, ws, joinedAt:Date.now() });
          this.log(`portal relay: channel ${short(target.id)} joined participant=${short(identity)} user=${frame.user} from=${remote} members=${target.members.size}`);
          clearTimeout(joinDeadline);
          this.send(ws, { t:"join.approved", room:"Portal", participantId:identity, outcome:"reuse" });
          this.send(ws, { t:"join.ready", room:"Portal" });
          this.presence(target);
          return;
        }
        if (frame.t === "leave") { ws.close(); return; }
        if (frame.t !== "peer" || !("target" in frame) || typeof frame.target !== "string" || !("packet" in frame)) throw new Error("Portal transport accepts peer packets only.");
        const packet = parsePeerPacket(frame.packet);
        const recipient = channel.members.get(frame.target);
        const sender = participantId && channel.members.get(participantId);
        if (!recipient || !sender || frame.target === participantId) throw new Error("The Portal peer is not connected.");
        this.send(recipient.ws, { t:"peer", target:frame.target, from:participantId, fromName:sender.user, packet });
      } catch (error) {
        if (channel) this.log(`portal relay: channel ${short(channel.id)} participant ${short(participantId)} frame rejected: ${error instanceof Error ? error.message : String(error)}`);
        this.send(ws, { t:"error", code:channel ? "portal-transport-rejected" : "join-rejected", msg:error instanceof Error ? error.message : "Portal transport rejected the frame.",
          correctable:!!channel, connectionAlive:!!channel });
        if (!channel) ws.close(1008, "Portal join rejected");
      }
    });
    ws.on("close", (code, reason) => {
      clearTimeout(joinDeadline); clearInterval(heartbeat); this.sockets.delete(ws);
      if (channel && participantId) {
        this.log(`portal relay: channel ${short(channel.id)} participant ${short(participantId)} left code=${code} reason=${reason.toString() || "-"} after=${Math.round((Date.now() - openedAt) / 1000)}s`);
        if (channel.members.get(participantId)?.ws === ws) channel.members.delete(participantId);
        if (this.channels.get(channel.id) === channel) this.presence(channel);
      }
    });
    ws.on("error", error => {
      this.log(`portal relay: socket from ${remote} channel ${short(channel?.id)} error: ${error.message}`);
      ws.close();
    });
  }

  private presence(channel: Channel): void {
    const members: Member[] = [...channel.members].map(([participantId, member]) => ({
      id:participantId, participantId, user:member.user, kind:"human", present:true,
    }));
    for (const member of channel.members.values()) this.send(member.ws, { t:"presence", room:"Portal", members });
  }

  private send(ws: WebSocket, frame: Frame): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  private matches(expected: string, actual: string): boolean {
    const a = Buffer.from(expected), b = Buffer.from(actual);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
