import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { HistoryProof } from "./next-room-history-sync.js";

export type RoomOwnerDescriptor = Readonly<{
  version: 1; roomId: string; workspaceId: string; sourceFingerprint: string; historyLineage: string;
  state: "active" | "released"; activeUrl: string;
}>;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
export const ownerDirectoryPath = /^\/api\/native-rooms\/([A-Za-z0-9_-]{6,80})\/owner$/;
export const ownerDirectoryPurpose = (roomId: string, body: string) => `owner-status:${roomId}:${sha(body)}`;
export const ownerDescriptorPurpose = (roomId: string, nonce: string, body: string) =>
  `owner-descriptor:${roomId}:${nonce}:${sha(body)}`;

function endpoint(value: string) {
  const url = new URL(value);
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname !== "/" || !url.hostname)
    throw new Error("A configured Room Hub WebSocket endpoint without credentials or a path is required.");
  return url;
}

/** Discover only an already selected endpoint; the original Room Host credential, not its URL, grants authority. */
export async function resolveRoomOwner(options: {
  roomId: string; url: string; workspaceId: string; historyLineage: string;
  assertAuthority(): void;
  createProof(purpose: string): Promise<HistoryProof>;
  verifyProof(purpose: string, proof: HistoryProof): Promise<boolean>;
  signal?: AbortSignal;
}): Promise<RoomOwnerDescriptor> {
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(options.roomId) || !uuid.test(options.workspaceId)
    || !digest.test(options.historyLineage)) throw new Error("Invalid local Room owner binding.");
  options.assertAuthority();
  const target = endpoint(options.url), activeUrl = target.href.replace(/\/$/, "");
  target.protocol = target.protocol === "wss:" ? "https:" : "http:";
  target.pathname = `/api/native-rooms/${options.roomId}/owner`;
  const body = JSON.stringify({ version: 1, workspaceId: options.workspaceId, historyLineage: options.historyLineage });
  const proof = await options.createProof(ownerDirectoryPurpose(options.roomId, body));
  options.assertAuthority();
  const response = await fetch(target, { method: "POST", redirect: "error", body,
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", "x-pkm-host-timestamp": String(proof.timestamp),
      "x-pkm-host-nonce": proof.nonce, "x-pkm-host-proof": proof.signature } });
  if (!response.ok) throw new Error(`Selected Room owner did not authenticate (${response.status}); release is unconfirmed.`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Selected Room owner returned no descriptor.");
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) throw new Error("Selected Room owner descriptor exceeds its bound.");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  const { descriptor, proof: signed } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!descriptor || descriptor.version !== 1 || descriptor.roomId !== options.roomId
    || !uuid.test(descriptor.workspaceId) || descriptor.workspaceId === options.workspaceId
    || !digest.test(descriptor.sourceFingerprint) || descriptor.historyLineage !== options.historyLineage
    || !["active", "released"].includes(descriptor.state)
    || descriptor.activeUrl !== activeUrl
    || !await options.verifyProof(ownerDescriptorPurpose(options.roomId, proof.nonce, JSON.stringify(descriptor)), signed))
    throw new Error("Selected Room owner descriptor does not match the original Host proof and Room lineage.");
  options.assertAuthority();
  return Object.freeze(descriptor) as RoomOwnerDescriptor;
}

export async function serveRoomOwner(request: IncomingMessage, response: ServerResponse, roomId: string, options: {
  db: DatabaseSync; workspaceId: string; assertAuthority(): void;
  authorize(purpose: string, proof: HistoryProof): Promise<boolean>;
  createProof(purpose: string): Promise<HistoryProof>;
  describe(): Promise<RoomOwnerDescriptor>;
}) {
  if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += Buffer.byteLength(chunk);
    if (length > 1024) { response.writeHead(413); response.end(); return; }
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8"), input = JSON.parse(body);
  if (input.version !== 1 || !uuid.test(input.workspaceId) || input.workspaceId === options.workspaceId
    || !digest.test(input.historyLineage)) throw new Error("Invalid Room owner request.");
  const proof = { timestamp: Number(request.headers["x-pkm-host-timestamp"]),
    nonce: String(request.headers["x-pkm-host-nonce"] ?? ""), signature: String(request.headers["x-pkm-host-proof"] ?? "") };
  if (!Number.isSafeInteger(proof.timestamp) || Math.abs(Date.now() - proof.timestamp) > 30_000
    || !/^[A-Za-z0-9_-]{16,128}$/.test(proof.nonce) || !/^[A-Za-z0-9_-]{43}$/.test(proof.signature)
    || !await options.authorize(ownerDirectoryPurpose(roomId, body), proof)) {
    response.writeHead(403); response.end("Original Room Host authority required."); return;
  }
  options.assertAuthority();
  options.db.exec(`CREATE TABLE IF NOT EXISTS next_room_owner_nonces(
    room_id TEXT NOT NULL,nonce TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(room_id,nonce));`);
  options.db.prepare("DELETE FROM next_room_owner_nonces WHERE expires_at<?").run(Date.now());
  options.db.prepare("INSERT INTO next_room_owner_nonces VALUES(?,?,?)").run(roomId, proof.nonce, Date.now() + 60_000);
  const descriptor = await options.describe();
  if (descriptor.historyLineage !== input.historyLineage) throw new Error("Original Room content lineage differs.");
  const signed = await options.createProof(ownerDescriptorPurpose(roomId, proof.nonce, JSON.stringify(descriptor)));
  options.assertAuthority();
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ descriptor, proof: signed }));
}
