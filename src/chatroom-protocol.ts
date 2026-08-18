// ── Protocol ────────────────────────────────────────────────────────────────
export type MemberKind = "human" | "agent" | "browser";
export type ReplyPolicy = "none" | "required" | "optional";
export type ChatMode = "announce" | "ask" | "discuss";

export interface FileMeta {
  fileId: string;
  name:   string;
  size:   number;
  mime:   string;
}

export type Frame =
  | { t: "join";       room: string; roomId?: string; user: string; token: string; kind?: MemberKind; cid?: string; hostToken?: string; resumeAfter?: string }
  | { t: "join.pending"; room: string; requestId: string; expiresAt: number }
  | { t: "join.approved"; room: string; participantId: string; outcome: "new" | "reuse" }
  | { t: "join.ready"; room: string }
  | { t: "leave";      room: string }
  | { t: "presence";   room: string; members: Member[] }
  | { t: "msg";        id?: string; room: string; from: string; fromId?: string; text: string; ts?: number; kind?: MemberKind; receipt?: ReadReceipt; requireReply?: boolean; responseRequired?: boolean; replyPolicy?: ReplyPolicy; mode?: ChatMode; discussionAudience?: string[]; clientRequestId?: string; recipients?: string[]; replyToMessageId?: string }
  | { t: "msg.accepted"; room: string; clientRequestId: string; messageId: string }
  | { t: "msg.read";   room: string; messageId: string; read?: number; total?: number }
  | { t: "system";     room: string; text: string; ts: number }
  | { t: "agent.state"; room: string; user?: string; state: AgentRuntimeState; ts?: number }
  | { t: "history";    room: string; mode: "baseline" | "catchup"; messages: ChatMessage[] }
  | { t: "closed";     room: string; reason: string }
  | { t: "stopped";    room: string; reason: string; scope: "chatroom" }
  | { t: "admin";      room: string; action: "kick" | "mute" | "unmute" | "rename" | "edit"; target: string; name?: string; role?: string }
  | { t: "kicked";     room: string; reason: string }
  | { t: "renamed";    room: string; name: string }
  | { t: "room.renamed"; room: string; previousRoom: string }
  | { t: "rekey";      room: string; secret: string }
  | { t: "file.offer"; id?: string; room: string; from: string; fromId?: string; ts?: number; kind?: MemberKind; file: FileMeta }
  | { t: "file.chunk"; room: string; fileId: string; seq: number; data: string; last: boolean }
  | { t: "error";      code: string; msg: string; clientRequestId?: string; correctable?: boolean; connectionAlive?: boolean }
  | { t: "ping" }
  | { t: "pong" };

export type AgentRuntimeState = "idle" | "standby" | "thinking" | "sending" | "reconnecting";

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
  role?: string;      // host-assigned room role/label
  participantId?: string; // durable identity scoped to this Room
  runtimeState?: AgentRuntimeState; // standby means an active blocking wait, not merely a connected socket
  stateChangedAt?: number;
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
  receipt?: ReadReceipt;
  responseRequired?: boolean;
  replyPolicy?: ReplyPolicy;
  mode?: ChatMode;
  discussionAudience?: string[];
  replyToMessageId?: string;
  recipients?: string[];
}

export interface ReadReceipt {
  read: number;
  total: number;
  ack?: boolean;
}

// File-transfer limits (in-memory relay; keeps the DoS surface small).
export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
export const CHUNK_BYTES     = 64 * 1024;        // 64 KB raw per chunk

