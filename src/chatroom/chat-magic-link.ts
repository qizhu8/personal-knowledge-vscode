import { createHash } from "crypto";

export interface ChatMagicLinkCredentials {
  url: string;
  secret: string;
  roomId?: string;
}

const PREFIX = "pkchat:v1:";

export function createChatMagicLink(url: string, secret: string, roomId?: string): string {
  const normalizedUrl = normalizeChatUrl(url);
  const normalizedSecret = String(secret || "").trim();
  if (!normalizedSecret) throw new Error("Chatroom secret is required.");
  const normalizedRoomId = String(roomId || "").trim();
  const payload = Buffer.from(JSON.stringify({ v: 1, u: normalizedUrl, s: normalizedSecret, ...(normalizedRoomId ? { r: normalizedRoomId } : {}) }), "utf8").toString("base64url");
  const checksum = createHash("sha256").update(payload, "utf8").digest("base64url").slice(0, 16);
  return `${PREFIX}${payload}.${checksum}`;
}

export function parseChatMagicLink(value: unknown): ChatMagicLinkCredentials {
  const raw = String(value || "").trim();
  const match = /^pkchat:v1:([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{16})$/.exec(raw);
  if (!match) throw new Error("Chat Magic Link format is invalid or incomplete.");
  const [, payload, suppliedChecksum] = match;
  const expectedChecksum = createHash("sha256").update(payload, "utf8").digest("base64url").slice(0, 16);
  if (suppliedChecksum !== expectedChecksum) throw new Error("Chat Magic Link checksum failed. It may have been copied incorrectly.");
  let decoded: any;
  try { decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { throw new Error("Chat Magic Link payload is invalid."); }
  const url = normalizeChatUrl(decoded?.u);
  const secret = String(decoded?.s || "").trim();
  const roomId = String(decoded?.r || "").trim() || undefined;
  if (decoded?.v !== 1 || !secret) throw new Error("Chat Magic Link is missing valid room credentials.");
  return { url, secret, roomId };
}

export function chatInviteMessage(magicLink: string): string {
  return `Discover the unified MCP server pkm and call chat_capabilities to find the complete PKM Chatroom tool workflow. Join with chat_join using Magic Link \`${magicLink}\` and the alias I'll give you. Identity assignment is automatic; never ask the Host for approval. Call chat_standby to block until an @message addresses you. Use chat_post(..., continue_working=true) for progress updates while work continues; final chat_post returns to standby, then call chat_standby again. Stay in standby until the Host uses /stop, you leave, or the Room closes.`;
}

function normalizeChatUrl(value: unknown): string {
  const raw = String(value || "").trim().replace(/\/$/, "");
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error("Chat Magic Link contains an invalid room URL."); }
  if (!(["ws:", "wss:"] as string[]).includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.replace(/^\/+/, "")) {
    throw new Error("Chat Magic Link must contain a ws/wss URL with a room path.");
  }
  return parsed.toString().replace(/\/$/, "");
}
