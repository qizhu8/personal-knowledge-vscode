export const PEER_PROTOCOL = "pkm.peer/v1";
export const MAX_PEER_BYTES = 48 * 1024;

export type PeerOperation = "pair" | "paired" | "revoke" | "task" | "receipt" | "cancel" | "swap" | "swapped" | "observe" | "files" | "resume" | "resumed";
export interface PeerPacket {
  protocol: typeof PEER_PROTOCOL;
  operation: PeerOperation;
  pairId: string;
  requestId: string;
  payload: Record<string, unknown>;
}

export interface PeerDelivery {
  from: string;
  fromName: string;
  packet: PeerPacket;
}

export function parsePeerPacket(value: unknown): PeerPacket {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid peer packet.");
  const item = value as Record<string, unknown>;
  if (item.protocol !== PEER_PROTOCOL || !["pair", "paired", "revoke", "task", "receipt", "cancel", "swap", "swapped", "observe", "files", "resume", "resumed"].includes(String(item.operation))) {
    throw new Error("Unsupported peer protocol or operation.");
  }
  for (const field of ["pairId", "requestId"]) {
    if (typeof item[field] !== "string" || !/^[a-f0-9-]{36}$/.test(item[field])) throw new Error(`Invalid peer ${field}.`);
  }
  if (!item.payload || typeof item.payload !== "object" || Array.isArray(item.payload)) throw new Error("Invalid peer payload.");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_PEER_BYTES) throw new Error("Peer packet is too large.");
  return { protocol: PEER_PROTOCOL, operation: item.operation as PeerOperation, pairId: item.pairId as string,
    requestId: item.requestId as string, payload: item.payload as Record<string, unknown> };
}

export function assertPeerEndpoint(url: string): void {
  const endpoint = new URL(url);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Peer transport URL cannot include credentials or query parameters.");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname.toLowerCase());
  if (endpoint.protocol !== "wss:" && !(endpoint.protocol === "ws:" && loopback)) {
    throw new Error("PKM Portal requires WSS/TLS for cross-machine connections. Plain WS is allowed only on loopback.");
  }
}
