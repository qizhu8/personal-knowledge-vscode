import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { WebSocket } from "ws";
import { Frame, Member } from "./chatroom-protocol";
import { MAX_PEER_BYTES, parsePeerPacket } from "./peer-protocol";

interface Channel {
  id: string;
  secret: string;
  members: Map<string, { user: string; ws: WebSocket }>;
}

/** Peer-only transport: no Room lifecycle, membership archive, transcript or Meeting. */
export class PortalRelay {
  private readonly channels = new Map<string, Channel>();
  private readonly sockets = new Set<WebSocket>();

  create(id: string = randomUUID(), secret = randomBytes(32).toString("base64url")): { channelId: string; secret: string } {
    if (!/^[a-f0-9-]{36}$/.test(id) || !/^[A-Za-z0-9_-]{16,256}$/.test(secret)) throw new Error("Invalid Portal transport credentials.");
    const existing = this.channels.get(id);
    if (existing && !this.matches(existing.secret, secret)) throw new Error("Portal transport credentials do not match.");
    if (!existing) this.channels.set(id, { id, secret, members:new Map() });
    return { channelId:id, secret };
  }

  close(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    this.channels.delete(channelId);
    for (const member of channel.members.values()) {
      this.send(member.ws, { t:"closed", room:"Portal", reason:"Portal transport closed" });
      member.ws.close();
    }
  }

  stop(): void {
    for (const id of this.channels.keys()) this.close(id);
    for (const ws of this.sockets) ws.close();
    this.sockets.clear();
  }

  accept(ws: WebSocket): void {
    this.sockets.add(ws);
    let channel: Channel | undefined;
    let participantId: string | undefined;
    let alive = true;
    const joinDeadline = setTimeout(() => ws.close(1008, "Portal join timed out"), 10_000);
    joinDeadline.unref();
    const heartbeat = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      ws.ping();
    }, 30_000);
    heartbeat.unref();
    ws.on("pong", () => { alive = true; });
    ws.on("message", raw => {
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
          if (!target || !this.matches(target.secret, frame.token)) throw new Error("Portal transport is unavailable or its credentials are invalid.");
          const identity = createHmac("sha256", target.secret).update(frame.cid).digest("hex").slice(0, 32);
          for (const [id, member] of target.members) if (member.ws.readyState !== WebSocket.OPEN) target.members.delete(id);
          if (target.members.has(identity) || target.members.size >= 2) throw new Error("This Portal already has its two endpoints, or this endpoint is connected elsewhere.");
          channel = target; participantId = identity;
          target.members.set(identity, { user:frame.user, ws });
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
        this.send(ws, { t:"error", code:channel ? "portal-transport-rejected" : "join-rejected", msg:error instanceof Error ? error.message : "Portal transport rejected the frame.",
          correctable:!!channel, connectionAlive:!!channel });
        if (!channel) ws.close(1008, "Portal join rejected");
      }
    });
    ws.on("close", () => {
      clearTimeout(joinDeadline); clearInterval(heartbeat); this.sockets.delete(ws);
      if (channel && participantId) {
        if (channel.members.get(participantId)?.ws === ws) channel.members.delete(participantId);
        if (this.channels.get(channel.id) === channel) this.presence(channel);
      }
    });
    ws.on("error", () => ws.close());
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
