import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { Storage } from "./storage.js";
import { inspectNativeRoom } from "./native-chatroom-identity.js";
import { inspectLegacyChatroomArchive } from "./legacy-chatroom-continuation.js";
import type { NextRoomHistoryAssets } from "./next-room-history-assets.js";

type RecordValue = Record<string, any>;
export type HistoryProof = { timestamp: number; nonce: string; signature: string };
export interface HistoryBinding {
  roomId: string; sourceFingerprint: string; lineage: string; workspaceId: string; activeUrl: string;
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const pageSize = 32_768;
const limit = 16_777_216;
const uuid = /^[a-f0-9-]{36}$/;
const digest = /^[a-f0-9]{64}$/;
export const historyPath = /^\/api\/native-rooms\/([A-Za-z0-9_-]{6,80})\/history$/;
export const historyPurpose = (roomId: string, body: string) => `history-sync:${roomId}:${hash(body)}`;
export const historyPagePurpose = (roomId: string, nonce: string, body: string) => `history-page:${roomId}:${nonce}:${hash(body)}`;
export function roomHistoryLineage(storage: Storage, roomId: string): string {
  const native = inspectNativeRoom(storage, roomId);
  if (native) return native.sourceFingerprint;
  const archive = inspectLegacyChatroomArchive(storage.workspaceRoot(), roomId);
  return hash(JSON.stringify({ roomId, files: archive.files.map(file => ({ path: file.path, sha256: file.sha256, size: file.size })) }));
}

function validate(state: RecordValue, roomId: string, full = false) {
  if (!state || state.roomId !== roomId || typeof state.roomName !== "string" || !state.roomName
    || state.roomName.length > 160 || !["active", "stored"].includes(state.state)
    || !Number.isSafeInteger(state.updatedAt) || !Array.isArray(state.messages) || state.messages.length > 4900
    || !state.identity || ["memberships", "aliases", "pendingJoins"].some(key => !Array.isArray(state.identity[key])))
    throw new Error("Remote Room history schema is invalid or exceeds the no-trimming handoff bound.");
  const ids = new Set<string>();
  for (const message of state.messages) {
    if (!message || typeof message.id !== "string" || !message.id || message.id.length > 128 || ids.has(message.id)
      || typeof message.content !== "string" || message.content.length > 8000 || !Number.isSafeInteger(message.createdAt)
      || typeof message.aliasAtSend !== "string" || !["human", "agent", "browser"].includes(message.senderKind)
      || !(full ? ["chat", "system", "file"] : ["chat"]).includes(message.messageType)
      || full && message.messageType === "file" && !message.metadata?.file || !full && message.metadata?.file)
      throw new Error("Remote history contains conflicting messages or unsupported file/Meeting history.");
    ids.add(message.id);
  }
  const memberships = state.identity.memberships;
  if (memberships.length > 64 || state.identity.aliases.length > 4096 || state.identity.pendingJoins.length > 4096
    || memberships.some((member: RecordValue) => !member || typeof member.participantId !== "string"
      || !member.participantId || member.participantId.length > 128
      || !["human", "agent", "browser"].includes(member.kind) || typeof member.role !== "string"
      || typeof member.temporary !== "boolean" || !Number.isSafeInteger(member.createdAt)
      || !Number.isSafeInteger(member.updatedAt))
    || new Set(memberships.map((member: RecordValue) => member.participantId)).size !== memberships.length)
    throw new Error("Remote Room membership schema is invalid.");
  const participants = new Set(memberships.map((member: RecordValue) => member.participantId));
  if (state.hostParticipantId && !participants.has(state.hostParticipantId)
    || state.messages.some((message: RecordValue) => message.participantId && !participants.has(message.participantId))
    || state.identity.aliases.some((alias: RecordValue) => !alias || typeof alias.alias !== "string"
      || typeof alias.aliasKey !== "string" || !participants.has(alias.participantId) || !Number.isSafeInteger(alias.assignedAt))
    || state.identity.pendingJoins.some((join: RecordValue) => !join || typeof join.requestId !== "string"
      || typeof join.clientKey !== "string" || typeof join.alias !== "string" || typeof join.aliasKey !== "string"
      || typeof join.status !== "string" || !Number.isSafeInteger(join.requestedAt)
      || !Number.isSafeInteger(join.expiresAt) || join.participantId && !participants.has(join.participantId)))
    throw new Error("Remote Room history has invalid identity references.");
}

/** Explicit Host-authorized transcript replication, not a legacy protocol or a distributed owner lock. */
export class NextRoomHistorySync {
  constructor(private readonly db: DatabaseSync, private readonly assert: () => void,
    private readonly assets?: NextRoomHistoryAssets) {
    assert();
    db.exec(`CREATE TABLE IF NOT EXISTS ${this.table("exports")}(
      room_id TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(room_id,digest));
      CREATE TABLE IF NOT EXISTS ${this.table("nonces")}(
      room_id TEXT NOT NULL,nonce TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(room_id,nonce));
      CREATE TABLE IF NOT EXISTS ${this.table("incoming")}(
      room_id TEXT PRIMARY KEY,binding TEXT NOT NULL,base TEXT NOT NULL,digest TEXT,
      total INTEGER NOT NULL DEFAULT 0,data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS ${this.table("receipts")}(
      room_id TEXT PRIMARY KEY,binding TEXT NOT NULL,digest TEXT NOT NULL,destination TEXT NOT NULL,source_state TEXT NOT NULL);`);
  }
  private table(name: "exports" | "nonces" | "incoming" | "receipts") {
    return `next_room_${this.assets ? "full_" : ""}history_${name}`;
  }
  private transaction<T>(operation: () => T): T {
    this.assert(); this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.assert(); this.db.exec("COMMIT"); return result; }
    catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }
  private transcriptOnly(roomId: string) {
    if (!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='next_room_meetings'").get()) return;
    const row = this.db.prepare("SELECT state_json FROM next_room_meetings WHERE room_id=?").get(roomId);
    if (!row) return;
    const canonical = JSON.parse(String(row.state_json));
    if (canonical?.schema !== 1 || !Array.isArray(canonical.meetings) || canonical.meetings.length)
      throw new Error("Meeting/Note transfer is not admitted by transcript-only synchronization.");
  }
  assertDestination(roomId: string) {
    this.assert();
    if (!this.assets) this.transcriptOnly(roomId);
  }
  private destinationDigest(roomId: string, state: string) {
    return hash(this.assets ? JSON.stringify([state, this.assets.snapshot(roomId)]) : state);
  }
  async serve(request: IncomingMessage, response: ServerResponse, roomId: string, options: {
    workspaceId: string;
    authorize(purpose: string, proof: HistoryProof): Promise<boolean>;
    createProof(purpose: string): Promise<HistoryProof>;
    snapshot(): Promise<{ sourceFingerprint: string; lineage: string; state: RecordValue }>;
  }) {
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += Buffer.byteLength(chunk);
      if (size > 2048) { response.writeHead(413); response.end(); return; }
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString("utf8"), input = JSON.parse(body);
    const full = input.version === 2;
    if (![1, 2].includes(input.version) || full && !this.assets
      || !uuid.test(input.destinationWorkspaceId) || input.destinationWorkspaceId === options.workspaceId
      || !digest.test(input.sourceFingerprint) || !digest.test(input.lineage) || !Number.isSafeInteger(input.offset) || input.offset < 0
      || input.offset % pageSize || input.snapshot !== undefined && !digest.test(input.snapshot))
      throw new Error("Invalid history request.");
    const proof = { timestamp: Number(request.headers["x-pkm-host-timestamp"]),
      nonce: String(request.headers["x-pkm-host-nonce"] ?? ""), signature: String(request.headers["x-pkm-host-proof"] ?? "") };
    if (!Number.isSafeInteger(proof.timestamp) || Math.abs(Date.now() - proof.timestamp) > 30_000
      || !/^[A-Za-z0-9_-]{16,128}$/.test(proof.nonce) || !/^[A-Za-z0-9_-]{43}$/.test(proof.signature)
      || !await options.authorize(historyPurpose(roomId, body), proof)) {
      response.writeHead(403); response.end("Original Host history authority required."); return;
    }
    this.transaction(() => {
      this.db.prepare(`DELETE FROM ${this.table("nonces")} WHERE expires_at<?`).run(Date.now());
      const otherNonces = `next_room_${this.assets ? "" : "full_"}history_nonces`;
      if (this.db.prepare(`SELECT 1 FROM ${this.table("nonces")} WHERE room_id=? AND nonce=?`).get(roomId, proof.nonce)
        || this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(otherNonces)
          && this.db.prepare(`SELECT 1 FROM ${otherNonces} WHERE room_id=? AND nonce=? AND expires_at>=?`)
            .get(roomId, proof.nonce, Date.now()))
        throw new Error("History proof was already consumed.");
      this.db.prepare(`INSERT INTO ${this.table("nonces")} VALUES(?,?,?)`).run(roomId, proof.nonce, Date.now() + 60_000);
    });
    const current = await options.snapshot();
    if (!full) this.transcriptOnly(roomId);
    if (current.sourceFingerprint !== input.sourceFingerprint || current.lineage !== input.lineage)
      throw new Error("History source binding or content lineage changed.");
    let snapshot = input.snapshot;
    if (!snapshot) {
      validate(current.state, roomId, full);
      const assets = full ? this.assets!.snapshot(roomId) : undefined;
      if (assets) this.assets!.validate(roomId, assets, current.state);
      const encoded = JSON.stringify({ version: input.version, workspaceId: options.workspaceId,
        sourceFingerprint: current.sourceFingerprint, lineage: current.lineage, state: current.state, ...(assets ? { assets } : {}) });
      if (Buffer.byteLength(encoded) > (full ? 192 * 1024 * 1024 : limit))
        throw new Error("History snapshot exceeds its no-trimming transfer budget.");
      snapshot = hash(encoded);
      this.transaction(() => {
        if (!this.db.prepare(`SELECT 1 FROM ${this.table("exports")} WHERE room_id=? AND digest=?`).get(roomId, snapshot)) {
          const used = this.db.prepare(`SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) AS size FROM ${this.table("exports")}`).get()!;
          if (Number(used.size) + Buffer.byteLength(encoded) > (full ? 512 * 1024 * 1024 : 134_217_728))
            throw new Error("Private history checkpoint budget exhausted; explicit reconciliation required.");
          this.db.prepare(`INSERT INTO ${this.table("exports")} VALUES(?,?,?)`).run(roomId, snapshot, encoded);
        }
      });
    }
    const row = this.db.prepare(`SELECT body FROM ${this.table("exports")} WHERE room_id=? AND digest=?`).get(roomId, snapshot);
    if (!row) { response.writeHead(409); response.end("Unknown immutable history checkpoint."); return; }
    const bytes = Buffer.from(String(row.body));
    if (hash(bytes) !== snapshot || input.offset >= bytes.length && input.offset !== 0) throw new Error("Invalid history checkpoint cursor.");
    const page = { version: 1, snapshot, offset: input.offset, total: bytes.length,
      data: bytes.subarray(input.offset, input.offset + pageSize).toString("base64") };
    const signed = await options.createProof(historyPagePurpose(roomId, proof.nonce, JSON.stringify(page)));
    this.assert();
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ ...page, proof: signed }));
  }
  async pull(options: {
    binding: HistoryBinding; destinationWorkspaceId: string; destinationSourceFingerprint: string; signal?: AbortSignal;
    authorize(): Promise<void>;
    createProof(purpose: string): Promise<HistoryProof>;
    verifyProof(purpose: string, proof: HistoryProof): Promise<boolean>;
  }): Promise<{ digest: string; sourceState: string; messageCount: number }> {
    const { binding } = options, key = JSON.stringify(binding);
    if (!this.assets) this.transcriptOnly(binding.roomId);
    const roomRow = () => {
      const row = this.db.prepare("SELECT state_json,source_fingerprint FROM legacy_room_runtime_rooms WHERE room_id=?").get(binding.roomId);
      if (!row) throw new Error("Destination Room was not explicitly admitted.");
      if (row.source_fingerprint !== options.destinationSourceFingerprint)
        throw new Error("Destination Room source receipt changed; synchronization refused.");
      return String(row.state_json);
    };
    const pending = this.db.prepare(`SELECT 1 FROM ${this.table("incoming")} WHERE room_id=?`).get(binding.roomId);
    // A resumed immutable checkpoint is not necessarily the latest head. Always fetch a fresh head afterwards.
    let result: { digest: string; sourceState: string; messageCount: number } | undefined;
    for (let checkpoint = 0; checkpoint < (pending ? 2 : 1); checkpoint++) {
      await options.authorize(); this.assert();
      this.transaction(() => {
        const existing = this.db.prepare(`SELECT binding FROM ${this.table("incoming")} WHERE room_id=?`).get(binding.roomId);
        if (existing && existing.binding !== key) throw new Error("Pending history belongs to another selected owner; explicit reconciliation required.");
        if (!existing) {
          const base = this.destinationDigest(binding.roomId, roomRow());
          const receipt = this.db.prepare(`SELECT binding,destination FROM ${this.table("receipts")} WHERE room_id=?`).get(binding.roomId);
          if (receipt && (receipt.binding !== key || receipt.destination !== base))
            throw new Error("Local Room branch changed since the last synchronized receipt.");
          this.db.prepare(`INSERT INTO ${this.table("incoming")}(room_id,binding,base,data) VALUES(?,?,?,?)`)
            .run(binding.roomId, key, base, Buffer.alloc(0));
        }
      });
      for (;;) {
        options.signal?.throwIfAborted();
        await options.authorize(); this.assert();
        const stage = this.db.prepare(`SELECT * FROM ${this.table("incoming")} WHERE room_id=?`).get(binding.roomId)!;
        if (this.destinationDigest(binding.roomId, roomRow()) !== stage.base)
          throw new Error("Destination history or assets changed during synchronization; no history was overwritten.");
        const offset = (stage.data as Uint8Array).byteLength;
        const body = JSON.stringify({ version: this.assets ? 2 : 1, destinationWorkspaceId: options.destinationWorkspaceId,
          sourceFingerprint: binding.sourceFingerprint, lineage: binding.lineage, offset, ...(stage.digest ? { snapshot: stage.digest } : {}) });
        const proof = await options.createProof(historyPurpose(binding.roomId, body));
        await options.authorize();
        const endpoint = new URL(binding.activeUrl);
        endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
        endpoint.pathname = `/api/native-rooms/${binding.roomId}/history`;
        const response = await fetch(endpoint, { method: "POST", redirect: "error", body,
          headers: { "content-type": "application/json", "X-PKM-Host-Timestamp": String(proof.timestamp),
            "X-PKM-Host-Nonce": proof.nonce, "X-PKM-Host-Proof": proof.signature },
          signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
        if (response.status !== 200) { await response.body?.cancel(); throw new Error(`Remote history refused (${response.status}); checkpoint retained.`); }
        const reader = response.body!.getReader(), parts: Uint8Array[] = [];
        let received = 0;
        try {
          for (;;) {
            const chunk = await reader.read(); if (chunk.done) break;
            received += chunk.value.byteLength;
            if (received > 50_000) throw new Error("Remote history page exceeds its bound.");
            parts.push(chunk.value);
          }
        } finally { await reader.cancel(); }
        const page = JSON.parse(Buffer.concat(parts).toString("utf8"));
        const signedBody = JSON.stringify({ version: page.version, snapshot: page.snapshot,
          offset: page.offset, total: page.total, data: page.data });
        if (!page.proof || !Number.isSafeInteger(page.proof.timestamp) || Math.abs(Date.now() - page.proof.timestamp) > 30_000
          || !/^[A-Za-z0-9_-]{16,128}$/.test(page.proof.nonce) || !/^[A-Za-z0-9_-]{43}$/.test(page.proof.signature)
          || !await options.verifyProof(historyPagePurpose(binding.roomId, proof.nonce, signedBody), page.proof))
          throw new Error("Remote history response authority is invalid.");
        if (page.version !== 1 || !digest.test(page.snapshot) || page.offset !== offset
          || !Number.isSafeInteger(page.total) || page.total < 1 || page.total > (this.assets ? 192 * 1024 * 1024 : limit)
          || stage.digest && (page.snapshot !== stage.digest || page.total !== stage.total)
          || typeof page.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(page.data))
          throw new Error("Remote immutable history page conflicts with its cursor.");
        const bytes = Buffer.from(page.data, "base64");
        if (bytes.length !== Math.min(pageSize, page.total - offset) || bytes.toString("base64") !== page.data)
          throw new Error("Remote history page is incomplete.");
        await options.authorize(); this.assert();
        this.transaction(() => {
          const latest = this.db.prepare(`SELECT * FROM ${this.table("incoming")} WHERE room_id=?`).get(binding.roomId)!;
          if (latest.base !== stage.base || latest.binding !== key || (latest.data as Uint8Array).byteLength !== offset
            || latest.digest !== stage.digest || this.destinationDigest(binding.roomId, roomRow()) !== stage.base)
            throw new Error("Concurrent history synchronization or destination conflict.");
          const all = Buffer.concat([Buffer.from(stage.data as Uint8Array), bytes]);
          if (all.length !== page.total) {
            this.db.prepare(`UPDATE ${this.table("incoming")} SET digest=?,total=?,data=? WHERE room_id=?`)
              .run(page.snapshot, page.total, all, binding.roomId);
            return;
          }
          if (hash(all) !== page.snapshot) throw new Error("Remote history digest mismatch.");
          const snapshot = JSON.parse(all.toString("utf8"));
          if (snapshot.version !== (this.assets ? 2 : 1) || snapshot.workspaceId !== binding.workspaceId
            || snapshot.sourceFingerprint !== binding.sourceFingerprint || snapshot.lineage !== binding.lineage)
            throw new Error("Remote history owner or content-lineage binding mismatch.");
          validate(snapshot.state, binding.roomId, !!this.assets);
          const local = JSON.parse(roomRow()), incoming = snapshot.state;
          if (this.assets) this.assets.validate(binding.roomId, snapshot.assets, incoming);
          else this.transcriptOnly(binding.roomId);
          if (local.state !== "stored") throw new Error("Cannot replace an active destination Room.");
          const receipt = this.db.prepare(`SELECT * FROM ${this.table("receipts")} WHERE room_id=?`).get(binding.roomId);
          if (receipt && (receipt.binding !== key || receipt.destination !== stage.base))
            throw new Error("Local Room branch changed since the last synchronized receipt.");
          if (this.assets && !receipt) this.assets.assertInitialBase(binding.roomId, snapshot.assets);
          if (local.messages.some((message: RecordValue, index: number) => JSON.stringify(message) !== JSON.stringify(incoming.messages[index]))
            || ["memberships", "aliases", "pendingJoins"].some(kind => local.identity[kind].some((item: RecordValue) =>
              !incoming.identity[kind].some((other: RecordValue) =>
                other[kind === "memberships" ? "participantId" : kind === "aliases" ? "assignedAt" : "requestId"]
                === item[kind === "memberships" ? "participantId" : kind === "aliases" ? "assignedAt" : "requestId"]))))
            throw new Error("Remote history diverges from retained local history or identity; no merge/overwrite was attempted.");
          const destination = JSON.stringify({ ...incoming, state: "stored" });
          if (this.assets) this.assets.install(binding.roomId, snapshot.assets);
          this.db.prepare("UPDATE legacy_room_runtime_rooms SET state_json=? WHERE room_id=?").run(destination, binding.roomId);
          this.db.prepare(`INSERT INTO ${this.table("receipts")} VALUES(?,?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET binding=excluded.binding,digest=excluded.digest,destination=excluded.destination,source_state=excluded.source_state`)
            .run(binding.roomId, key, page.snapshot, this.destinationDigest(binding.roomId, destination), incoming.state);
          this.db.prepare(`DELETE FROM ${this.table("incoming")} WHERE room_id=?`).run(binding.roomId);
          result = { digest: page.snapshot, sourceState: incoming.state, messageCount: incoming.messages.length };
        });
        if (!this.db.prepare(`SELECT 1 FROM ${this.table("incoming")} WHERE room_id=?`).get(binding.roomId)) break;
      }
    }
    return result!;
  }
}
