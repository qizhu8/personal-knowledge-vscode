import { createHash } from "crypto";

export interface ChatMagicLinkCredentials {
  url: string;
  secret: string;
}

const PREFIX = "pkchat:v1:";

export function createChatMagicLink(url: string, secret: string): string {
  const normalizedUrl = normalizeChatUrl(url);
  const normalizedSecret = String(secret || "").trim();
  if (!normalizedSecret) throw new Error("Chatroom secret is required.");
  const payload = Buffer.from(JSON.stringify({ v: 1, u: normalizedUrl, s: normalizedSecret }), "utf8").toString("base64url");
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
  if (decoded?.v !== 1 || !secret) throw new Error("Chat Magic Link is missing valid room credentials.");
  return { url, secret };
}

export function chatInviteMessage(magicLink: string): string {
  return `Please first discover the MCP server pkm and its chat_join and chat_standby tools. Join with Magic Link \`${magicLink}\`; I'll tell you your alias. After joining, call chat_standby and keep calling it again after every reply or timeout. When /start_conversation names you, remain continuously focused on the Chatroom until roombot announces /stop_conversation or you are /release'd.`;
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
