import { createHash } from "crypto";
import { assertPeerEndpoint, PORTAL_TRANSPORT_PATH } from "./peer-protocol";

/** Peer transport credentials and a one-time pairing code. Room fields remain for v1 link compatibility. */
export interface PortalLink {
  url: string;
  room: string;
  roomId: string;
  secret: string;
  code: string;
  controller: string;
  /** Initiator's display name. */
  name?: string;
  role?: "controller" | "controlled";
}

const PREFIX = "pkmportal:v1:";

export function createPortalLink(link: PortalLink): string {
  const value = validate(link);
  const payload = Buffer.from(JSON.stringify({ v: 1, u: value.url, n: value.room, r: value.roomId, s: value.secret, c: value.code, p: value.controller, ...(value.name ? { a: value.name } : {}), ...(value.role ? { d: value.role } : {}) }), "utf8").toString("base64url");
  return `${PREFIX}${payload}.${checksum(payload)}`;
}

export function parsePortalLink(input: unknown): PortalLink {
  const raw = String(input || "").replace(/\s+/g, "");
  const match = /^pkmportal:v1:([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{16})$/.exec(raw);
  if (!match) throw new Error("This is not a complete PKM Portal link. Copy the whole pkmportal:v1:… text.");
  if (checksum(match[1]) !== match[2]) throw new Error("PKM Portal link checksum failed. It may have been copied incorrectly.");
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")); }
  catch { throw new Error("PKM Portal link payload is invalid."); }
  if (!decoded || typeof decoded !== "object" || !("v" in decoded) || decoded.v !== 1) throw new Error("Unsupported PKM Portal link version.");
  const record = decoded as Record<string, unknown>;
  for (const field of ["u", "n", "r", "s", "c", "p"]) if (typeof record[field] !== "string") throw new Error("PKM Portal link is missing Room credentials.");
  if (record.d !== undefined && record.d !== "controller" && record.d !== "controlled") throw new Error("Invalid Portal control direction.");
  return validate({ url: String(record.u), room: String(record.n), roomId: String(record.r), secret: String(record.s), code: String(record.c), controller: String(record.p),
    ...(typeof record.a === "string" ? { name: record.a } : {}), ...(record.d === "controlled" || record.d === "controller" ? { role: record.d } : {}) });
}

function validate(link: PortalLink): PortalLink {
  const url = String(link.url || "").trim().replace(/\/$/, "");
  const room = String(link.room || "").trim();
  const roomId = String(link.roomId || "").trim();
  const secret = String(link.secret || "").trim();
  const code = String(link.code || "").trim();
  const controller = String(link.controller || "").trim();
  const name = String(link.name || "").trim().slice(0, 80);
  assertPeerEndpoint(url);
  if (!["", PORTAL_TRANSPORT_PATH].includes(new URL(url).pathname.replace(/\/+$/, ""))) throw new Error(`PKM Portal link URL must use ${PORTAL_TRANSPORT_PATH}, or a legacy Hub address without a Room path.`);
  if (!room || !roomId || !secret || !controller) throw new Error("PKM Portal link is missing Room credentials.");
  if (!/^pkmpeer:v1:[a-f0-9-]{36}:[a-f0-9]{48}$/.test(code)) throw new Error("PKM Portal link is missing a valid pairing code.");
  if (link.role !== undefined && link.role !== "controller" && link.role !== "controlled") throw new Error("Invalid Portal control direction.");
  return { url, room, roomId, secret, code, controller, ...(name ? { name } : {}), ...(link.role ? { role: link.role } : {}) };
}

function checksum(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("base64url").slice(0, 16);
}
