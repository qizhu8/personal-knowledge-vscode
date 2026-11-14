import { createHash } from "node:crypto";
import type { ChannelTaskPin } from "../channel-runtime-contracts.js";

export interface ChannelActor { actorId: string; kind: "human" | "agent" }
export interface ChannelMember {
  participantId: string; actor: ChannelActor; generation: string;
  role: "manager" | "worker" | "observer"; state: "available" | "working" | "waiting";
  expiresAt: number; revoked: boolean; cursor: number; lastSeq: number; floor: number;
}
export interface ChannelInvitation {
  id: string; actor: ChannelActor; participantId: string; role: ChannelMember["role"];
  tokenSha256: string; expiresAt: number; memberExpiresAt: number; approved: boolean; consumed: boolean;
}
export interface ChannelMessage {
  id: string; seq: number; senderId: string; recipientId: string; recipientGeneration: string;
  kind: "message" | "assignment" | "update" | "reply"; text: string; at: number;
  assignmentId?: string; task?: ChannelTaskPin;
}
/** Delivery deduplication/acknowledgement ledger, not Manager/Board task lifecycle authority. */
export interface ChannelDelivery {
  assignmentId: string; seq: number; senderId: string; recipientId: string; recipientGeneration: string;
  task: ChannelTaskPin; replied: boolean;
}
export interface ChannelRecord {
  schema: "pkm.channel.runtime/v1"; channelId: string; revision: number; closed: boolean;
  members: ChannelMember[]; invitations: ChannelInvitation[]; messages: ChannelMessage[]; deliveries: ChannelDelivery[];
}
export class ChannelRuntimeError extends Error {
  constructor(readonly code: string, message = code) { super(message); }
}
export function channelFail(code: string): never { throw new ChannelRuntimeError(code); }
export function channelHash(value: unknown): string {
  function canonical(item: unknown): string {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item && typeof item === "object") return `{${Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(",")}}`;
    return JSON.stringify(item) ?? "null";
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function sameChannelActor(left: ChannelActor, right: ChannelActor): boolean {
  return left.actorId === right.actorId && left.kind === right.kind;
}
export function currentChannelMember(room: ChannelRecord, actor: ChannelActor, now: number, generation?: string): ChannelMember {
  const member = room.members.find(item => !item.revoked && sameChannelActor(item.actor, actor));
  if (!member || member.revoked || generation !== undefined && member.generation !== generation) channelFail("FORBIDDEN");
  if (member.expiresAt <= now) channelFail("MEMBERSHIP_EXPIRED");
  if (room.closed) channelFail("CHANNEL_UNAVAILABLE");
  return member;
}
