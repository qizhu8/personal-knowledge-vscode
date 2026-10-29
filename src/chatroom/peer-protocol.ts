export const PEER_PROTOCOL = "pkm.peer/v1";
export const PORTAL_TRANSPORT_PATH = "/pkm/portal";
export const MAX_PEER_BYTES = 48 * 1024;

export interface PortalEndpointIdentity {
  endpointId: string;
  name: string;
  chatId?: string;
  chatName?: string;
  deleted: boolean;
  revision: number;
  acceptsIncoming: boolean;
}

export function parsePortalEndpointIdentity(value: unknown): PortalEndpointIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Portal endpoint state.");
  const item = value as Record<string, unknown>;
  for (const [field, limit] of [["endpointId", 200], ["name", 200], ["chatId", 200], ["chatName", 200]] as const) {
    if (item[field] === undefined && (field === "chatId" || field === "chatName")) continue;
    if (typeof item[field] !== "string" || !item[field] || (item[field] as string).length > limit || /[\x00-\x1f]/.test(item[field] as string)) throw new Error("Invalid Portal endpoint identity.");
  }
  if (typeof item.deleted !== "boolean" || typeof item.acceptsIncoming !== "boolean" || !Number.isSafeInteger(item.revision) || (item.revision as number) < 0) throw new Error("Invalid Portal endpoint revision or enabled state.");
  if (Object.keys(item).some(key => !["endpointId", "name", "chatId", "chatName", "deleted", "revision", "acceptsIncoming"].includes(key))) throw new Error("Unsupported Portal endpoint field.");
  return { endpointId: item.endpointId as string, name: item.name as string, deleted: item.deleted, revision: item.revision as number,
    acceptsIncoming: item.acceptsIncoming, ...(item.chatId === undefined ? {} : { chatId: item.chatId as string }), ...(item.chatName === undefined ? {} : { chatName: item.chatName as string }) };
}

export type PeerOperation = "pair" | "paired" | "pair-rejected" | "revoke" | "task" | "command" | "attempts" | "attempts-result" | "receipt" | "cancel" | "swap" | "swapped" | "observe" | "files" | "resume" | "resumed" | "endpoint-state";
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
  if (item.protocol !== PEER_PROTOCOL || !["pair", "paired", "pair-rejected", "revoke", "task", "command", "attempts", "attempts-result", "receipt", "cancel", "swap", "swapped", "observe", "files", "resume", "resumed", "endpoint-state"].includes(String(item.operation))) {
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
