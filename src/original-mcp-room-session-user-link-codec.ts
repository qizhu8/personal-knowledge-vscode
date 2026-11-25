import { createHash } from "node:crypto";
import {
  originalRoomPublicJoinArguments, originalRoomUserLinkIntentSchema, originalRoomSessionDigest,
  type OriginalRoomSessionEffect,
} from "./original-mcp-room-session-contracts.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
export function assertNoDurableOriginalRoomInvite(value: unknown): void {
  if (typeof value === "string") {
    if (/pkchat:v1:[A-Za-z0-9_=-]+/.test(value)) fail("ROOM_USER_JOIN_RAW_LINK_NOT_DURABLE");
  } else if (Array.isArray(value)) value.forEach(assertNoDurableOriginalRoomInvite);
  else if (value && typeof value === "object") Object.values(value).forEach(assertNoDurableOriginalRoomInvite);
}
export function parseOriginalRoomUserJoinArguments(input: unknown): { magic_link: string; name: string } {
  const parsed = originalRoomPublicJoinArguments.safeParse(input);
  if (!parsed.success) fail("ROOM_USER_JOIN_ARGUMENTS_INVALID");
  if (Buffer.byteLength(JSON.stringify(parsed.data)) > 60000) fail("ROOM_USER_JOIN_PACKET_TOO_LARGE");
  return parsed.data;
}

/** Diagnostic metadata only; the pinned original parser remains authoritative inside the native process. */
function endpointMetadata(raw: string): { requestedEndpoint: string | null; requestedRoomId: string | null; parseStatus: "recognized" | "unresolved" } {
  const unknown = { requestedEndpoint: null, requestedRoomId: null, parseStatus: "unresolved" as const };
  try {
    const text = raw.trim();
    if (!text.startsWith("pkchat:v1:")) return unknown;
    const separator = text.indexOf(".", 10);
    if (separator < 0) return unknown;
    const payload = text.slice(10, separator), checksum = text.slice(separator + 1);
    if (createHash("sha256").update(payload).digest("base64url").slice(0, 16) !== checksum) return unknown;
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(payload, "base64url")));
    if (!value || value.v !== 1 || typeof value.u !== "string" || !value.s) return unknown;
    const target = new URL(value.u.trim());
    if (!["ws:", "wss:"].includes(target.protocol) || !target.hostname || !target.pathname.replaceAll("/", "")) return unknown;
    const origin = `${target.protocol}//${target.host}`;
    if (origin.length > 128) return unknown;
    return { requestedEndpoint: origin,
      requestedRoomId: typeof value.r === "string" && /^[A-Za-z0-9_-]{6,80}$/.test(value.r.trim()) ? value.r.trim() : null,
      parseStatus: "recognized" };
  } catch { return unknown; }
}

/** Safe to persist: no encoded link, decoded secret, URI credentials/path/query, or original caller name. */
export function describeOriginalRoomUserJoin(effect: Readonly<OriginalRoomSessionEffect>, input: unknown) {
  const args = parseOriginalRoomUserJoinArguments(input), metadata = endpointMetadata(args.magic_link);
  if (metadata.requestedEndpoint !== null && metadata.requestedEndpoint !== effect.endpoint)
    fail("ROOM_USER_JOIN_ENDPOINT_APPROVAL_REQUIRED");
  if (metadata.requestedRoomId !== null && metadata.requestedRoomId !== effect.roomId)
    fail("ROOM_USER_JOIN_SOURCE_APPROVAL_REQUIRED");
  if (args.name.trim() && args.name.trim() !== effect.selection.alias) fail("ROOM_USER_JOIN_PARTICIPANT_APPROVAL_REQUIRED");
  const intent = Object.freeze(originalRoomUserLinkIntentSchema.parse({
    schema: "pkm.original-room-user-link/v1", argumentsSha256: originalRoomSessionDigest(args),
    magicLinkSha256: sha(args.magic_link), suppliedNameSha256: sha(args.name), endpoint: effect.endpoint, ...metadata,
  }));
  return Object.freeze({ tool: "chat_join" as const, arguments: Object.freeze({ name: effect.selection.alias }), userLink: intent });
}
