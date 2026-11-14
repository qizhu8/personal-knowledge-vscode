import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Storage } from "./storage.js";
import { inspectLegacyChatroomArchive, inspectLegacyChatroomParticipants } from "./legacy-chatroom-continuation.js";
import { consumeLegacyChatroomHostGrant } from "./legacy-chatroom-host-authority.js";
import { inspectNativeRoom } from "./native-chatroom-identity.js";
import { NextRoomHistorySync, historyPath, roomHistoryLineage, type HistoryProof, type HistoryBinding } from "./next-room-history-sync.js";
import { ownerDirectoryPath, serveRoomOwner } from "./next-room-owner-directory.js";
import { NextRoomHistoryAssets } from "./next-room-history-assets.js";

type JsonRecord = Record<string, any>;
export interface LegacyParticipantRebind {
  roomId: string; participantId: string; previousAlias: string; requestedAlias: string; clientId: string; kind: string;
  expiresAt: number;
}
interface RoomState {
  roomId: string; roomName: string; state: "stored" | "active"; updatedAt: number;
  hostParticipantId?: string;
  messages: JsonRecord[]; identity: { memberships: JsonRecord[]; aliases: JsonRecord[]; pendingJoins: JsonRecord[] };
}
export interface LegacyRoomRuntimeOptions {
  storage: Storage; actorId: string;
  authorize(binding: { root: string; workspaceId: string; actorId: string; roomId: string;
    sourceFingerprint: string; operation: "reopen" }): Promise<boolean | object>;
  retained: { ChatHub: new () => any; ChatJoinApprovalManager: new (...args: any[]) => any;
    WebSocketServer: new (...args: any[]) => any };
  network?: { bindAddress: string; advertisedHost: string; port: number };
  legacyReconnect?: "proof-required" | "new-identity" | "host-approval" | "legacy-client-id";
  portalAuthority?: () => void;
  roomOwnership?(roomId: string): { projectId: string; threadId: string } | undefined;
  authorizeHostCloseProof?(roomId: string, proof: { timestamp: number; nonce: string; signature: string }): Promise<boolean>;
  authorizeHostHistoryProof?(roomId: string, purpose: string, proof: HistoryProof): Promise<boolean>;
  createHostHistoryProof?(roomId: string, purpose: string): Promise<HistoryProof>;
  ownerDirectory?: true;
  prepareFullHistory?(roomId: string): Promise<void>;
  authorizeHostOwnerProof?(roomId: string, purpose: string, proof: HistoryProof): Promise<boolean>;
  approveLegacyParticipant?(request: LegacyParticipantRebind): Promise<boolean>;
  assertAuthority?(): void;
  rotateJoinSecret?(roomId: string, current: string): Promise<string>;
}
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const aliasKey = (alias: string) => alias.trim().normalize("NFKC").toLocaleLowerCase();
const maxFile = 25 * 1024 * 1024;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Retain the real protocol client while avoiding a second UI note when durable file bytes are replayed. */
export function createLegacyChatroomClient(Client: new (...args: any[]) => any, events: JsonRecord, logger?: (message: string) => void) {
  let files = new Set<string>();
  const delivered = new Map<string, string>();
  const credentials = new Map<string, { clientId: string; participantId: string; secret: string }>();
  const client = new Client({ ...events,
    onHistory(messages: JsonRecord[]) {
      files = new Set(messages.filter(message => message.file).map(message => message.file.fileId));
      events.onHistory(messages);
    },
    onMessage(message: JsonRecord) {
      if (message.file) {
        if (files.has(message.file.fileId)) return;
        files.add(message.file.fileId);
      }
      events.onMessage(message);
    },
    onFileComplete(metadata: JsonRecord, from: string, bytes: Buffer) {
      const fingerprint = hash(bytes), prior = delivered.get(metadata.fileId);
      if (prior === fingerprint) return;
      if (prior) { events.onRejected?.("native-file-conflict", "Replayed attachment payload conflicts with the completed file."); return; }
      delivered.set(metadata.fileId, fingerprint);
      events.onFileComplete(metadata, from, bytes);
    },
  }, logger);
  let room: string | undefined;
  let endpoint: string | undefined;
  const scope = () => JSON.stringify([room, endpoint]);
  const onFrame = client.onFrame.bind(client);
  client.onFrame = (raw: string) => {
    let frame: JsonRecord;
    try { frame = JSON.parse(raw); } catch { return onFrame(raw); }
    if (frame.t === "native.resume.credential") {
      if (room && frame.roomId === room && typeof frame.participantId === "string"
        && frame.participantId === client.participantId
        && frame.clientId === client.identity.slice(0, 32) && typeof frame.secret === "string"
        && /^[A-Za-z0-9_-]{43}$/.test(frame.secret)) {
        const credential = { clientId: frame.clientId, participantId: frame.participantId, secret: frame.secret };
        credentials.set(scope(), credential);
        events.onResumeCredential?.({ roomId: room, url: endpoint, ...credential });
      }
      return;
    }
    return onFrame(raw);
  };
  const send = client.send.bind(client);
  client.send = (frame: JsonRecord) => {
    const credential = room && credentials.get(scope());
    if (frame.t === "join" && credential && credential.clientId === String(frame.cid ?? "").slice(0, 32))
      frame.resumeCredential = credential.secret;
    return send(frame);
  };
  const connect = client.connect.bind(client);
  client.connect = (options: JsonRecord) => {
    const next = options.roomId ?? options.room;
    if (room !== next || endpoint !== options.url) {
      files.clear(); delivered.clear(); room = next; endpoint = options.url;
    }
    if (options.resumeCredential && options.resumeCredential.roomId === room
      && options.resumeCredential.url === endpoint
      && options.resumeCredential.clientId === String(options.cid ?? "").slice(0, 32)
      && typeof options.resumeCredential.participantId === "string"
      && typeof options.resumeCredential.secret === "string"
      && /^[A-Za-z0-9_-]{43}$/.test(options.resumeCredential.secret))
      credentials.set(scope(), { clientId: options.resumeCredential.clientId, participantId: options.resumeCredential.participantId,
        secret: options.resumeCredential.secret });
    return connect(options);
  };
  return client;
}

/** Explicit native-host experiment. Mutable state stays in core.sqlite; the legacy archive is never changed. */
export class LegacyChatroomRuntime {
  private readonly database: DatabaseSync;
  private readonly hub: any;
  private readonly history: NextRoomHistorySync;
  private admitting = true;
  private closed = false;
  private stopping?: Promise<void>;
  private readonly active = new Map<string, { secret: string; hostToken: string }>();
  private readonly authorizedSecrets = new Map<string, string>();
  private readonly credentialRooms = new Set<string>();
  private readonly admitted = new Set<string>();
  private readonly requestingHostIdentities = new Set<string>();
  private readonly pendingRebinds = new Map<string, { connection: any; participantId: string }>();
  private readonly network?: Readonly<NonNullable<LegacyRoomRuntimeOptions["network"]>>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private port = 0;
  private messages: Promise<unknown> = Promise.resolve();
  private server?: ReturnType<typeof createServer>;
  private sockets?: any;
  private serverClosed = false;
  private socketsClosed = false;
  constructor(private readonly options: LegacyRoomRuntimeOptions) {
    if (options.network && (isIP(options.network.bindAddress) !== 4
      || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(options.network.advertisedHost)
      || options.network.advertisedHost.length > 253
      || !Number.isInteger(options.network.port) || options.network.port < 0 || options.network.port > 65535))
      throw new Error("Invalid explicit native Room network binding.");
    this.network = options.network && Object.freeze({ ...options.network });
    options.storage.assertWorkspaceLease();
    this.database = options.storage.connectNative();
    this.database.exec("PRAGMA busy_timeout=3000");
    try { this.transaction(() => {
      this.database.exec(`CREATE TABLE IF NOT EXISTS legacy_room_runtime_schema(version INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS legacy_room_runtime_rooms(room_id TEXT PRIMARY KEY,source_fingerprint TEXT NOT NULL,state_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS legacy_room_runtime_files(room_id TEXT NOT NULL,file_id TEXT NOT NULL,owner_id TEXT NOT NULL,
          metadata_json TEXT NOT NULL,complete INTEGER NOT NULL,sha256 TEXT,data BLOB,PRIMARY KEY(room_id,file_id));
        CREATE TABLE IF NOT EXISTS legacy_room_runtime_chunks(room_id TEXT NOT NULL,file_id TEXT NOT NULL,sequence INTEGER NOT NULL,
          sha256 TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(room_id,file_id,sequence));
        CREATE TABLE IF NOT EXISTS legacy_room_runtime_resume(room_id TEXT NOT NULL,participant_id TEXT NOT NULL,
          client_key TEXT NOT NULL,secret_hash TEXT NOT NULL,PRIMARY KEY(room_id,participant_id));`);
      const versions = this.database.prepare("SELECT version FROM legacy_room_runtime_schema").all();
      if (!versions.length) this.database.prepare("INSERT INTO legacy_room_runtime_schema VALUES(1)").run();
      else if (versions.length !== 1 || versions[0].version !== 1) throw new Error("Unsupported native legacy Room runtime schema.");
    }); } catch (error) { this.database.close(); this.closed = true; throw error; }
    try {
    this.history = new NextRoomHistorySync(this.database, () => this.assertAdmission(),
      options.prepareFullHistory ? new NextRoomHistoryAssets(this.database, () => this.assertAdmission()) : undefined);
    const hub = this.hub = new options.retained.ChatHub();
    if (options.portalAuthority) {
      if (typeof hub.setPortalAuthorityGuard !== "function" || typeof hub.acceptPortalTransport !== "function"
        || typeof hub.constructor.portalTransportPath !== "string")
        throw new Error("Retained Portal transport has no live authority guard or dedicated connection ABI.");
      hub.setPortalAuthorityGuard(options.portalAuthority);
    }
    // A version-specific port around the retained implementation, not a patch to its captured source.
    for (const method of ["onConnection", "onHttp", "onMessage", "finishJoin", "isMuted", "sweep", "rehostRoom", "stop", "findRoomIdByName"])
      if (typeof hub[method] !== "function") throw new Error("Unsupported retained ChatHub ABI.");
    for (const field of ["rooms", "conns", "_port", "hostTokens", "roomSecret"])
      if (!Object.hasOwn(hub, field)) throw new Error("Unsupported retained ChatHub state ABI.");
    if (typeof hub.constructor.displayRoomName !== "function" || !(hub.hostTokens instanceof Map) || !(hub.roomSecret instanceof Map))
      throw new Error("Unsupported retained ChatHub identity ABI.");
    const persistence = this.persistence();
    hub.persistence = persistence;
    hub.lifecycle = this.lifecycle(persistence);
    hub.approvals = new options.retained.ChatJoinApprovalManager(persistence,
      (roomId: string, participantId: string) => [...hub.conns.values()].some((connection: any) =>
        connection.joined && connection.room === roomId && connection.participantId === participantId));
    const automatic = hub.approvals.approveAutomatic.bind(hub.approvals);
    hub.approvals.approveAutomatic = async (requestId: string) => {
      const connection = [...hub.conns.values()].find((item: any) => item.pendingJoinId === requestId) as any;
      if (connection?.pkmApprovedParticipant) return hub.approvals.approveReuse(requestId, connection.pkmApprovedParticipant);
      return automatic(requestId);
    };
    hub.setAdvertisedHost(this.network?.advertisedHost ?? "127.0.0.1");
    const finishJoin = hub.finishJoin.bind(hub);
    hub.finishJoin = async (connection: any, ...args: any[]) => {
      this.assertAdmission();
      await finishJoin(connection, ...args);
      if (connection.joined) {
        const approved = connection.pkmApprovedParticipant;
        if (approved && approved !== connection.participantId) throw new Error("Approved Room identity changed.");
        await this.issueResumeCredential(connection, !!approved);
        delete connection.pkmApprovedParticipant;
        await this.replayFiles(connection);
      }
      for (const [key, pending] of this.pendingRebinds)
        if (pending.connection === connection) this.pendingRebinds.delete(key);
    };
    const originalMessage = hub.onMessage.bind(hub);
    const handle = async (connection: any, raw: string, approvedParticipant?: string) => {
      this.assertAdmission();
      if (approvedParticipant && (connection.ws.readyState !== 1 || !hub.conns.has(connection.ws))) return;
      const frame = JSON.parse(raw);
      // The retained hub treats cid as a reconnect key, not an identity credential.
      if (!connection.joined && frame.t === "join" && typeof frame.cid === "string" && frame.cid) {
        const name = typeof frame.room === "string" ? frame.room : "";
        const roomId = typeof frame.roomId === "string" && hub.rooms.has(frame.roomId)
          ? frame.roomId : hub.findRoomIdByName(hub.constructor.displayRoomName(name));
        if (frame.roomId && frame.roomId !== roomId) return originalMessage(connection, raw);
        const room = roomId && hub.rooms.get(roomId);
        const roomSecret = hub.roomSecret.get(roomId);
        const suppliedSecret = typeof frame.token === "string" ? Buffer.from(frame.token) : Buffer.alloc(0);
        const hasRoomSecret = typeof roomSecret === "string" && suppliedSecret.length === Buffer.byteLength(roomSecret)
          && timingSafeEqual(suppliedSecret, Buffer.from(roomSecret));
        if (hasRoomSecret && room && this.admitted.has(roomId)) {
          const cid = frame.cid.slice(0, 32);
          const previous = [...this.state(roomId).identity.pendingJoins].reverse().find(request =>
            request.clientKey === cid && request.participantId
            && (request.status === "approved_new" || request.status === "approved_reuse"));
          const previousMember = previous && this.state(roomId).identity.memberships.find(
            item => item.participantId === previous.participantId);
          const protectedIdentity = previous && (previous.participantId === room.owner
            || previousMember && !previousMember.forgottenAt);
          if (approvedParticipant && (!protectedIdentity || previous.participantId !== approvedParticipant)) {
            connection.ws.close(); return;
          }
          const expected = hub.hostTokens.get(roomId);
          const provided = typeof frame.hostToken === "string" ? Buffer.from(frame.hostToken) : Buffer.alloc(0);
          const authorized = typeof expected === "string" && provided.length === Buffer.byteLength(expected)
            && timingSafeEqual(provided, Buffer.from(expected));
          const requestingIdentity = this.requestingHostIdentities.has(roomId);
          // Retained owner privileges are PID-based; participant approval cannot replace Host-role proof.
          if (requestingIdentity && previous?.participantId === room.owner && !authorized) {
            connection.ws.send(JSON.stringify({ t: "error", code: "host-proof-required",
              msg: "The Room host identity requires its host proof." }));
            connection.ws.close();
            return;
          }
          let resumeAuthorized = false;
          if (previous && (previous.participantId !== room.owner || requestingIdentity) && typeof frame.resumeCredential === "string"
            && /^[A-Za-z0-9_-]{43}$/.test(frame.resumeCredential)) {
            const member = this.state(roomId).identity.memberships.find(item => item.participantId === previous.participantId);
            const receipt = this.database.prepare(`SELECT secret_hash FROM legacy_room_runtime_resume
              WHERE room_id=? AND participant_id=? AND client_key=?`).get(roomId, previous.participantId, cid);
            const actual = Buffer.from(hash(frame.resumeCredential), "hex");
            const expectedHash = typeof receipt?.secret_hash === "string" ? Buffer.from(receipt.secret_hash, "hex") : Buffer.alloc(0);
            const kind = frame.kind === "agent" ? "agent" : frame.kind === "browser" ? "browser" : "human";
            resumeAuthorized = !!member && !member.forgottenAt && member.kind === kind
              && actual.length === expectedHash.length && timingSafeEqual(actual, expectedHash);
          }
          if (protectedIdentity && (!authorized || requestingIdentity) && !resumeAuthorized) {
            const host = previous.participantId === room.owner && !requestingIdentity;
            const kind = frame.kind === "agent" ? "agent" : frame.kind === "browser" ? "browser" : "human";
            const busy = [...hub.conns.values()].some((other: any) => other !== connection && other.room === roomId
              && (other.joined || other.pendingJoinId) && (other.cid === cid || other.participantId === previous.participantId));
            if (!host && this.options.legacyReconnect === "legacy-client-id" && previousMember?.kind === kind) {
              // Explicit Host opt-in preserves the original shared-secret/client-ID protocol, not private proof.
              connection.pkmApprovedParticipant = previous.participantId;
            } else if (!host && approvedParticipant === previous.participantId && previousMember?.kind === kind && !busy) {
              connection.pkmApprovedParticipant = approvedParticipant;
            } else if (!host && this.options.legacyReconnect === "host-approval" && this.options.approveLegacyParticipant
              && !busy && previousMember?.kind === kind && typeof frame.user === "string" && frame.user.length <= 60) {
              const key = `${roomId}:${previous.participantId}`;
              if (this.pendingRebinds.has(key)) {
                connection.ws.send(JSON.stringify({ t: "error", code: "join-rejected", msg: "An identity approval is already pending." }));
                connection.ws.close(); return;
              }
              const pending = { connection, participantId: previous.participantId };
              this.pendingRebinds.set(key, pending);
              const aliases = this.state(roomId).identity.aliases;
              const previousAlias = [...aliases].reverse().find(item => item.participantId === previous.participantId)?.alias ?? "";
              const request: LegacyParticipantRebind = { roomId, participantId: previous.participantId,
                previousAlias: String(previousAlias).slice(0, 200), requestedAlias: frame.user, clientId: cid, kind,
                expiresAt: Date.now() + 120_000 };
              connection.ws.send(JSON.stringify({ t: "join.pending", room: roomId, requestId: randomBytes(16).toString("hex"),
                expiresAt: request.expiresAt }));
              const timeout = setTimeout(() => {
                if (this.pendingRebinds.get(key) === pending) {
                  this.pendingRebinds.delete(key);
                  if (connection.ws.readyState === 1) connection.ws.close();
                }
              }, 120_000);
              timeout.unref();
              connection.ws.once("close", () => {
                clearTimeout(timeout);
                if (this.pendingRebinds.get(key) === pending) this.pendingRebinds.delete(key);
              });
              void Promise.resolve().then(() => this.options.approveLegacyParticipant!(request)).then(approved => {
                clearTimeout(timeout);
                if (this.pendingRebinds.get(key) !== pending || !this.admitting || this.closed) return;
                if (!approved || Date.now() >= request.expiresAt || connection.ws.readyState !== 1) {
                  this.pendingRebinds.delete(key);
                  if (connection.ws.readyState === 1) {
                    connection.ws.send(JSON.stringify({ t: "error", code: "join-rejected", msg: "Host did not approve identity recovery." }));
                    connection.ws.close();
                  }
                  return;
                }
                const task = this.messages.then(() => handle(connection, raw, pending.participantId));
                this.messages = task.catch(() => {});
                void task.catch(() => {
                  if (this.pendingRebinds.get(key) === pending) this.pendingRebinds.delete(key);
                  connection.ws.close();
                });
              }, () => {
                clearTimeout(timeout);
                if (this.pendingRebinds.get(key) === pending) this.pendingRebinds.delete(key);
                if (connection.ws.readyState === 1) connection.ws.close();
              });
              return;
            } else if (!host && this.options.legacyReconnect === "new-identity") {
              frame.cid = `legacy-${randomBytes(12).toString("hex")}`;
              raw = JSON.stringify(frame);
            } else {
              connection.ws.send(JSON.stringify({ t: "error", code: host ? "host-proof-required" : "participant-proof-required",
                msg: host ? "The Room host identity requires its host proof."
                  : "This Room participant requires an authorized identity rebind." }));
              connection.ws.close();
              return;
            }
          }
        }
      }
      if (connection.joined && !hub.isMuted(connection)) {
        if (frame.t === "file.offer") {
          if (this.offer(connection.room, connection.participantId, frame.file)) await originalMessage(connection, raw);
          for (const recipient of hub.conns.values())
            if (recipient.joined && recipient.room === connection.room) await this.replayFiles(recipient, frame.file.fileId);
          return;
        }
        if (frame.t === "file.chunk" && !this.chunk(connection.room, connection.participantId, frame)) return;
      }
      await originalMessage(connection, raw);
      if (approvedParticipant && !connection.pendingJoinId && !connection.joined)
        for (const [key, pending] of this.pendingRebinds)
          if (pending.connection === connection) this.pendingRebinds.delete(key);
    };
    hub.onMessage = (connection: any, raw: string) => {
      const task = this.messages.then(() => handle(connection, raw));
      this.messages = task.catch(() => {});
      return task;
    };
    } catch (error) { this.database.close(); this.closed = true; throw error; }
  }
  private assertOwner() {
    try {
      this.options.assertAuthority?.();
      this.options.storage.assertWorkspaceLease();
      const lease = this.options.storage.workspaceLease();
      const actual = this.database.prepare("SELECT owner_id,fence,lease_until FROM native_runtime_owner WHERE singleton=1").get();
      if (!actual || actual.owner_id !== lease.ownerId || actual.fence !== lease.fence || Number(actual.lease_until) <= Date.now())
        throw new Error("Native Room workspace epoch is fenced.");
    } catch (error) {
      this.admitting = false;
      if (this.hub && !this.closed) void this.drain().catch(() => {});
      throw error;
    }
  }
  private assertAdmission() {
    if (!this.admitting || this.closed) throw new Error("Native Room admission is closed.");
    this.assertOwner();
  }
  private transaction<T>(fn: () => T): T {
    if (this.closed) throw new Error("Native Room runtime is closed.");
    this.assertOwner();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.assertOwner();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }
  private state(roomId: string): RoomState {
    if (!this.admitted.has(roomId)) throw new Error("Room has not been explicitly admitted by this host.");
    this.assertOwner();
    const row = this.database.prepare("SELECT state_json FROM legacy_room_runtime_rooms WHERE room_id=?").get(roomId);
    if (!row) throw new Error("Native Room is unavailable.");
    return JSON.parse(String(row.state_json));
  }
  private change<T>(roomId: string, fn: (room: RoomState) => T): T {
    return this.transaction(() => {
      const room = this.state(roomId), result = fn(room);
      room.updatedAt = Date.now();
      const json = JSON.stringify(room);
      if (Buffer.byteLength(json) > 16_777_216) throw new Error("Native Room state exceeds 16 MiB.");
      this.database.prepare("UPDATE legacy_room_runtime_rooms SET state_json=? WHERE room_id=?").run(json, roomId);
      return result;
    });
  }
  private async admitStoredRoom(roomId: string, reuseActive = false, fullTakeover = false) {
    this.assertAdmission();
    if (this.active.has(roomId) && !reuseActive) throw new Error("Room is already active.");
    const root = this.options.storage.workspaceRoot(), workspaceId = await this.options.storage.workspaceId();
    const native = inspectNativeRoom(this.options.storage, roomId);
    const archive = native ? undefined : inspectLegacyChatroomArchive(root, roomId);
    const sourceFingerprint = native?.sourceFingerprint ?? archive!.sourceFingerprint;
    const binding = Object.freeze({ root, workspaceId, actorId: this.options.actorId, roomId,
      sourceFingerprint, operation: "reopen" as const });
    const authority = await this.options.authorize(binding);
    const legacyGrant = await consumeLegacyChatroomHostGrant(authority, binding);
    if (authority !== true && !legacyGrant) throw new Error("Native Room host authority required.");
    if (this.network && !legacyGrant) throw new Error("Network Room hosting requires verified legacy Host credentials.");
    const currentSource = () => native
      ? JSON.stringify(inspectNativeRoom(this.options.storage, roomId)) === JSON.stringify(native)
      : inspectLegacyChatroomArchive(root, roomId).sourceFingerprint === sourceFingerprint;
    if (!currentSource()) throw new Error("Room changed during host authorization.");
    const identity = native ? { memberships: [], aliases: [], pendingJoins: [] } : inspectLegacyChatroomParticipants(root, roomId);
    if (legacyGrant?.hostParticipantId && !identity.memberships.some(member =>
      member.participantId === legacyGrant.hostParticipantId && member.kind === "human" && !member.temporary && !member.forgottenAt))
      throw new Error("Legacy Room host membership is unavailable.");
    if (!currentSource())
      throw new Error("Room changed while reading historical participants.");
    this.transaction(() => {
      const prior = this.database.prepare("SELECT source_fingerprint FROM legacy_room_runtime_rooms WHERE room_id=?").get(roomId);
      if (prior && prior.source_fingerprint !== sourceFingerprint) throw new Error("Native Room source receipt conflicts.");
      if (!prior) {
        if (archive && archive.messages.length > 4900) throw new Error("Legacy Room exceeds the retained transport's bounded history window.");
        const room: RoomState = {
          roomId, roomName: native?.name ?? archive!.name, state: "stored", updatedAt: Date.now(), identity,
          ...(legacyGrant?.hostParticipantId ? { hostParticipantId: legacyGrant.hostParticipantId } : {}),
          messages: (archive?.messages ?? []).map(message => ({
            id: message.message_id, participantId: message.participant_id, aliasAtSend: message.alias_at_send,
            senderKind: message.sender_kind, messageType: message.message_type, content: message.content,
            metadata: message.metadata_json === null ? null : JSON.parse(message.metadata_json), createdAt: message.created_at,
          })),
        };
        const encoded = JSON.stringify(room);
        if (Buffer.byteLength(encoded) > 16_777_216) throw new Error("Native Room state exceeds 16 MiB.");
        this.database.prepare("INSERT INTO legacy_room_runtime_rooms VALUES(?,?,?)").run(roomId, sourceFingerprint, encoded);
      }
      if (fullTakeover) {
        if (!this.options.prepareFullHistory) throw new Error("Explicit full Host succession is not enabled.");
        const state = String(this.database.prepare(
          "SELECT state_json FROM legacy_room_runtime_rooms WHERE room_id=?").get(roomId)!.state_json);
        const receipt = this.database.prepare(
          "SELECT binding,destination,source_state FROM next_room_full_history_receipts WHERE room_id=?").get(roomId);
        const destination = hash(JSON.stringify([state, new NextRoomHistoryAssets(this.database, () => this.assertAdmission()).snapshot(roomId)]));
        if (!receipt || receipt.source_state !== "stored" || receipt.destination !== destination
          || JSON.parse(String(receipt.binding)).roomId !== roomId)
          throw new Error("Host succession requires the unchanged verified full closed checkpoint.");
        this.database.exec(`CREATE TABLE IF NOT EXISTS next_room_host_successions(
          room_id TEXT PRIMARY KEY,source_fingerprint TEXT NOT NULL,original_host TEXT,assigned_host TEXT)`);
        const current = JSON.parse(state) as RoomState;
        const originalHost = legacyGrant?.hostParticipantId ?? current.hostParticipantId ?? null;
        const priorSuccession = this.database.prepare("SELECT * FROM next_room_host_successions WHERE room_id=?").get(roomId);
        if (priorSuccession && (priorSuccession.source_fingerprint !== sourceFingerprint
          || legacyGrant?.hostParticipantId && priorSuccession.original_host !== originalHost))
          throw new Error("Host succession source provenance conflicts.");
        this.database.prepare(`INSERT INTO next_room_host_successions VALUES(?,?,?,?)
          ON CONFLICT(room_id) DO UPDATE SET assigned_host=excluded.assigned_host`)
          .run(roomId, sourceFingerprint, originalHost, current.hostParticipantId ?? null);
      }
      if (prior && legacyGrant?.hostParticipantId) {
        const existing = JSON.parse(String(this.database.prepare(
          "SELECT state_json FROM legacy_room_runtime_rooms WHERE room_id=?").get(roomId)!.state_json)) as RoomState;
        const successor = this.database.prepare("SELECT 1 FROM sqlite_schema WHERE name='next_room_host_successions'").get()
          && this.database.prepare("SELECT * FROM next_room_host_successions WHERE room_id=?").get(roomId);
        if (existing.hostParticipantId !== legacyGrant.hostParticipantId && !(successor
          && successor.source_fingerprint === sourceFingerprint && successor.original_host === legacyGrant.hostParticipantId
          && successor.assigned_host === existing.hostParticipantId))
          throw new Error("Native Room host binding conflicts with the legacy credential.");
      }
    });
    this.admitted.add(roomId);
    return legacyGrant;
  }
  async reopen(roomId: string, reuseActive = false, fullTakeover = false) {
    if (fullTakeover && typeof this.hub.setRequestingHostIdentity !== "function")
      throw new Error("This retained transport cannot preserve the receiver's explicit Host identity.");
    const legacyGrant = await this.admitStoredRoom(roomId, reuseActive, fullTakeover);
    const successor = this.database.prepare("SELECT 1 FROM sqlite_schema WHERE name='next_room_host_successions'").get()
      && this.database.prepare("SELECT * FROM next_room_host_successions WHERE room_id=?").get(roomId);
    if (successor) {
      const row = this.database.prepare("SELECT source_fingerprint,state_json FROM legacy_room_runtime_rooms WHERE room_id=?").get(roomId)!;
      if (successor.source_fingerprint !== row.source_fingerprint
        || successor.assigned_host !== (JSON.parse(String(row.state_json)).hostParticipantId ?? null))
        throw new Error("Recorded Host succession no longer matches the owned Room.");
    }
    if (successor && typeof this.hub.setRequestingHostIdentity !== "function")
      throw new Error("The recorded Host successor cannot fall back to historical Host identity.");
    this.hub.setRequestingHostIdentity?.(roomId, !!successor);
    if (successor) this.requestingHostIdentities.add(roomId);
    else this.requestingHostIdentities.delete(roomId);
    const existing = this.active.get(roomId);
    if (existing) {
      const room = this.hub.rooms.get(roomId);
      if (!room) throw new Error("Active Room transport is unavailable.");
      return { roomId, room: room.displayName, secret: existing.secret, hostToken: this.hub.hostTokens.get(roomId),
        url: `ws://${this.network?.advertisedHost ?? "127.0.0.1"}:${this.port}` };
    }
    this.change(roomId, room => {
      room.state = "stored";
      for (const member of room.identity.memberships)
        if (member.temporary && !member.forgottenAt) {
          member.forgottenAt = Date.now();
          this.database.prepare("DELETE FROM legacy_room_runtime_resume WHERE room_id=? AND participant_id=?").run(roomId, member.participantId);
        }
      for (const request of room.identity.pendingJoins) if (request.status === "pending") request.status = "cancelled";
      for (const alias of room.identity.aliases) if (!alias.releasedAt) alias.releasedAt = Date.now();
    });
    if (legacyGrant) this.authorizedSecrets.set(roomId, legacyGrant.joinSecret);
    await this.listen();
    let result: any;
    try { result = await this.hub.rehostRoom(roomId); }
    finally { this.authorizedSecrets.delete(roomId); }
    if (legacyGrant) this.credentialRooms.add(roomId);
    const host = this.network?.advertisedHost ?? "127.0.0.1";
    return { ...result, url: `ws://${host}:${this.port}`, downloadBase: `http://${host}:${this.port}/native-room-files/${roomId}/`,
      qualification: "experimental-unqualified", authority: legacyGrant ? "verified-legacy-host-credential"
        : "new-explicit-native-host-no-inherited-legacy-rights" };
  }
  async closeRoom(roomId: string) {
    this.assertAdmission();
    await this.hub.adminCloseRoom(roomId);
    this.active.delete(roomId);
    this.admitted.delete(roomId);
    this.credentialRooms.delete(roomId);
  }
  supportsRequestingHostIdentity() { return typeof this.hub.setRequestingHostIdentity === "function"; }
  async start(): Promise<void> {
    this.assertAdmission();
    await this.listen();
  }
  listeningPort(): number { this.assertAdmission(); return this.port; }
  activeRoomIds(): string[] { this.assertAdmission(); return [...this.active.keys()]; }
  async missingFilePayloads(roomId: string) {
    if (!this.options.prepareFullHistory) throw new Error("Saved attachment recovery is not enabled.");
    await this.admitStoredRoom(roomId, true);
    const files = this.state(roomId).messages.filter(message => message.metadata?.file)
      .map(message => ({ ...message.metadata.file }));
    return files.filter(file => !this.database.prepare(
      "SELECT 1 FROM legacy_room_runtime_files WHERE room_id=? AND file_id=? AND complete=1").get(roomId, file.fileId));
  }
  async recoverFileBytes(roomId: string, fileId: string, encoded: string) {
    await this.missingFilePayloads(roomId);
    const messages = this.state(roomId).messages.filter(message => message.metadata?.file?.fileId === fileId);
    const message = messages[0], metadata = message?.metadata.file;
    if (!metadata || !messages.every(item => item.participantId === message.participantId
      && JSON.stringify(item.metadata.file) === JSON.stringify(metadata))
      || !/^[A-Za-z0-9_-]{1,128}$/.test(fileId) || metadata.fileId !== fileId
      || Object.keys(metadata).sort().join(",") !== "fileId,mime,name,size"
      || typeof metadata.name !== "string" || metadata.name.length > 200 || /[\u0000-\u001f]/.test(metadata.name)
      || typeof metadata.mime !== "string" || metadata.mime.length > 200
      || !this.state(roomId).identity.memberships.some(member => member.participantId === message.participantId))
      throw new Error("A unique retained attachment from this Room is required.");
    if (typeof encoded !== "string" || encoded.length > 35_000_000 || !Number.isSafeInteger(metadata.size)
      || metadata.size < 0 || metadata.size > 25 * 1024 * 1024) throw new Error("Saved attachment exceeds its bounded metadata.");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded || bytes.length !== metadata.size)
      throw new Error("Selected saved bytes do not match the retained attachment size.");
    const digest = createHash("sha256").update(bytes).digest("hex");
    return this.transaction(() => {
      const prior = this.database.prepare("SELECT * FROM legacy_room_runtime_files WHERE room_id=? AND file_id=?").get(roomId, fileId);
      if (prior) {
        if (prior.complete === 1 && prior.sha256 === digest && prior.owner_id === message.participantId
          && prior.metadata_json === JSON.stringify(metadata) && prior.data
          && createHash("sha256").update(Buffer.from(prior.data as Uint8Array)).digest("hex") === digest)
          return { sha256: digest };
        throw new Error("Existing attachment bytes or an incomplete upload must not be overwritten.");
      }
      this.database.prepare("INSERT INTO legacy_room_runtime_files VALUES(?,?,?,?,1,?,?)")
        .run(roomId, fileId, message.participantId, JSON.stringify(metadata), digest, bytes);
      for (let offset = 0; offset < bytes.length; offset += 32768) {
        const chunk = bytes.subarray(offset, offset + 32768);
        this.database.prepare("INSERT INTO legacy_room_runtime_chunks(room_id,file_id,sequence,sha256,data) VALUES(?,?,?,?,?)")
          .run(roomId, fileId, offset / 32768, createHash("sha256").update(chunk).digest("hex"), chunk);
      }
      this.database.exec("CREATE TABLE IF NOT EXISTS next_room_file_recoveries(room_id TEXT NOT NULL,file_id TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(room_id,file_id))");
      this.database.prepare("INSERT INTO next_room_file_recoveries VALUES(?,?,?)").run(roomId, fileId, digest);
      return { sha256: digest };
    });
  }
  async syncRemoteHistory(options: {
    binding: HistoryBinding; destinationWorkspaceId: string; signal?: AbortSignal; fullAssets?: boolean;
    authorize(): Promise<void>; createProof(purpose: string): Promise<HistoryProof>;
    verifyProof(purpose: string, proof: HistoryProof): Promise<boolean>;
  }) {
    this.assertHistoryRoom(options.binding.roomId);
    if (options.fullAssets && !this.options.prepareFullHistory) throw new Error("Full Room asset transfer is not enabled.");
    if (options.fullAssets) await this.options.prepareFullHistory?.(options.binding.roomId);
    const history = options.fullAssets ? this.history
      : new NextRoomHistorySync(this.database, () => this.assertAdmission());
    history.assertDestination(options.binding.roomId);
    const prefix = options.fullAssets ? "next_room_full_history" : "next_room_history";
    const destinationSourceFingerprint = (inspectNativeRoom(this.options.storage, options.binding.roomId)
      ?? inspectLegacyChatroomArchive(this.options.storage.workspaceRoot(), options.binding.roomId)).sourceFingerprint;
    if (this.active.has(options.binding.roomId)) throw new Error("Cannot synchronize an active destination Room.");
    const roomId = options.binding.roomId;
    const local = this.database.prepare("SELECT state_json FROM legacy_room_runtime_rooms WHERE room_id=?").get(roomId);
    const transcriptFailure = options.fullAssets && local
      && this.database.prepare("SELECT 1 FROM sqlite_schema WHERE name='next_room_history_incoming'").get()
      && this.database.prepare(
      "SELECT binding,base,digest,total,length(data) AS bytes FROM next_room_history_incoming WHERE room_id=?").get(roomId);
    // A refused v1 file export may have admitted an unchanged base, but published no checkpoint.
    const unchangedTranscriptFailure = transcriptFailure && transcriptFailure.binding === JSON.stringify(options.binding)
      && transcriptFailure.base === createHash("sha256").update(String(local.state_json)).digest("hex")
      && transcriptFailure.digest === null && transcriptFailure.total === 0 && transcriptFailure.bytes === 0
      && !this.database.prepare("SELECT 1 FROM next_room_history_receipts WHERE room_id=?").get(roomId);
    if (local
      && !this.database.prepare(`SELECT 1 FROM ${prefix}_receipts WHERE room_id=?`).get(roomId)
      && !this.database.prepare(`SELECT 1 FROM ${prefix}_incoming WHERE room_id=?`).get(roomId)
      && !unchangedTranscriptFailure)
      throw new Error("Existing unsynchronized local Room state requires explicit reconciliation.");
    await this.admitStoredRoom(options.binding.roomId);
    return history.pull({ ...options, destinationSourceFingerprint, authorize: async () => {
      this.assertAdmission();
      if (this.active.has(options.binding.roomId)) throw new Error("Destination Room became active during synchronization.");
      await options.authorize();
    } });
  }
  private assertHistoryRoom(roomId: string) {
    this.assertAdmission();
    if (!this.options.prepareFullHistory
      && existsSync(join(this.options.storage.workspaceRoot(), "chatrooms", roomId, "meetings", "canonical.json")))
      throw new Error("Retained Meeting archives require a separate transfer; transcript-only synchronization refused.");
  }
  legacyUiAction(method: string, args: unknown[] = []): any {
    this.assertAdmission();
    const allowed = new Set(["adminRooms", "pendingApprovals", "onApprovalsChanged", "onRoomDeactivating",
      "renameActiveRoom", "rotateRoomSecret", "portalChannelsSnapshot",
      "createPortalChannel", "closePortalChannel"]);
    if (!allowed.has(method)) throw new Error(`Next Room action ${method} is not admitted.`);
    if (["createPortalChannel", "closePortalChannel"].includes(method)) {
      if (!this.options.portalAuthority) throw new Error(`Next Portal action ${method} is not admitted.`);
      this.options.portalAuthority();
    }
    return this.hub[method](...args);
  }
  async renameStoredRoom(roomId: string, name: string): Promise<void> {
    await this.admitStoredRoom(roomId);
    this.renameRoom(roomId, name);
  }
  async repairStoredRoom(roomId: string) {
    await this.admitStoredRoom(roomId);
    this.change(roomId, room => {
      for (const request of room.identity.pendingJoins) if (request.status === "pending") request.status = "cancelled";
      for (const alias of room.identity.aliases) if (!alias.releasedAt) alias.releasedAt = Date.now();
    });
    const room = this.state(roomId);
    return { roomId, roomName: room.roomName, messageCount: room.messages.length, closedOrphans: 0 };
  }
  private renameRoom(roomId: string, name: string): void {
    const normalized = name.normalize("NFKC").trim().replace(/\s+/g, " ");
    if (!normalized || Array.from(normalized).length > 80) throw new Error("A Room name of at most 80 characters is required.");
    const collision = this.database.prepare("SELECT room_id,state_json FROM legacy_room_runtime_rooms").all()
      .some(row => row.room_id !== roomId && aliasKey(JSON.parse(String(row.state_json)).roomName) === aliasKey(normalized));
    if (collision) throw new Error("A Room with this name already exists.");
    this.change(roomId, room => { room.roomName = normalized; });
  }
  private async listen() {
    if (this.port) return;
    const server = this.server = createServer((request, response) => {
      void (async () => {
        this.assertAdmission();
        const owner = ownerDirectoryPath.exec(request.url ?? "");
        if (owner) {
          if (!this.options.ownerDirectory || !this.options.authorizeHostOwnerProof || !this.options.createHostHistoryProof) {
            response.writeHead(403); response.end(); return;
          }
          const roomId = owner[1], workspaceId = await this.options.storage.workspaceId();
          return serveRoomOwner(request, response, roomId, {
            db: this.database, workspaceId, assertAuthority: () => this.assertAdmission(),
            authorize: (purpose, proof) => this.options.authorizeHostOwnerProof!(roomId, purpose, proof),
            createProof: purpose => this.options.createHostHistoryProof!(roomId, purpose),
            describe: async () => {
              await this.messages;
              if (!this.admitted.has(roomId)) await this.admitStoredRoom(roomId);
              this.assertAdmission();
              const row = this.database.prepare("SELECT source_fingerprint FROM legacy_room_runtime_rooms WHERE room_id=?").get(roomId)!;
              return { version: 1, roomId, workspaceId, sourceFingerprint: String(row.source_fingerprint),
                historyLineage: roomHistoryLineage(this.options.storage, roomId),
                state: this.active.has(roomId) ? "active" : "released",
                activeUrl: `ws://${this.network?.advertisedHost ?? "127.0.0.1"}:${this.port}` };
            },
          });
        }
        const history = historyPath.exec(request.url ?? "");
        if (history) {
          if (!this.options.authorizeHostHistoryProof || !this.options.createHostHistoryProof) { response.writeHead(403); response.end(); return; }
          return this.history.serve(request, response, history[1], {
            workspaceId: await this.options.storage.workspaceId(),
            authorize: (purpose, proof) => this.options.authorizeHostHistoryProof!(history[1], purpose, proof),
            createProof: purpose => this.options.createHostHistoryProof!(history[1], purpose),
            snapshot: async () => {
              await this.messages;
              this.assertHistoryRoom(history[1]);
              await this.options.prepareFullHistory?.(history[1]);
              if (!this.admitted.has(history[1])) await this.admitStoredRoom(history[1]);
              this.assertAdmission();
              const row = this.database.prepare("SELECT source_fingerprint FROM legacy_room_runtime_rooms WHERE room_id=?").get(history[1])!;
              return { sourceFingerprint: String(row.source_fingerprint), lineage: roomHistoryLineage(this.options.storage, history[1]),
                state: copy(this.state(history[1])) };
            },
          });
        }
        const match = /^\/native-room-files\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(request.url ?? "");
        if (!match) return this.hub.onHttp(request, response);
        const secret = this.active.get(match[1])?.secret, provided = Buffer.from(String(request.headers["x-pkm-room-secret"] ?? ""));
        if (!secret || provided.length !== Buffer.byteLength(secret) || !timingSafeEqual(provided, Buffer.from(secret))) {
          response.writeHead(403); response.end("Room download authority required."); return;
        }
        const file = this.database.prepare("SELECT data,sha256 FROM legacy_room_runtime_files WHERE room_id=? AND file_id=? AND complete=1").get(match[1], match[2]);
        if (!file) { response.writeHead(404); response.end("Legacy bytes were never persisted, or the new transfer is incomplete."); return; }
        if (hash(Buffer.from(file.data as Uint8Array)) !== file.sha256) throw new Error("Native attachment integrity failure.");
        this.assertOwner();
        response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment",
          "cache-control": "no-store", "x-content-sha256": String(file.sha256) });
        response.end(Buffer.from(file.data as Uint8Array));
      })().catch(() => { if (!response.headersSent) response.writeHead(503); response.end("Native Room unavailable."); });
    });
    server.once("close", () => { this.serverClosed = true; });
    await new Promise<void>((ready, reject) => {
      server.once("error", reject);
      server.listen(this.network?.port ?? 0, this.network?.bindAddress ?? "127.0.0.1", ready);
    });
    this.port = (server.address() as { port: number }).port;
    const wss = this.sockets = new this.options.retained.WebSocketServer({ server, maxPayload: 262_144 });
    wss.once("close", () => { this.socketsClosed = true; });
    wss.on("connection", (socket: any, request: any) => {
      try {
        this.assertAdmission();
        if (request?.url === this.hub.constructor.portalTransportPath) {
          if (!this.options.portalAuthority) { socket.terminate(); return; }
          this.options.portalAuthority();
          this.hub.acceptPortalTransport(socket, `${request.socket.remoteAddress || "unknown"}:${request.socket.remotePort || 0}`);
        } else this.hub.onConnection(socket);
      } catch { socket.terminate(); }
    });
    this.hub.http = server; this.hub.wss = wss; this.hub._port = this.port;
    this.heartbeat = setInterval(() => {
      try { this.assertAdmission(); this.hub.sweep(); } catch { void this.drain().catch(() => {}); }
    }, 10_000);
    this.heartbeat.unref();
  }
  private persistence(): any {
    const self = this;
    return {
      async openRoom(id: string) { return { messages: copy(self.state(id).messages), replayed: 0 }; },
      async identityState(id: string) { return copy(self.state(id).identity); },
      async append(id: string, message: JsonRecord) {
        self.change(id, room => {
          const prior = room.messages.find(item => item.id === message.id);
          if (prior) { if (JSON.stringify(prior) !== JSON.stringify(message)) throw new Error("Message receipt conflict."); return; }
          if (room.messages.length >= 5000) throw new Error("Room history limit reached; no records were pruned.");
          room.messages.push(copy(message));
        });
      },
      async appendMany(id: string, messages: JsonRecord[]) { for (const message of messages) await this.append(id, message); },
      async recordLifecycle(id: string, type: string, state?: "stored" | "active", payload?: JsonRecord) {
        self.change(id, room => {
          if (state) room.state = state;
          if (type === "room.renamed") room.roomName = String(payload?.roomName);
          if (type === "room.host_assigned") {
            if (!room.identity.memberships.some(member => member.participantId === payload?.participantId && !member.forgottenAt))
              throw new Error("Native host assignment requires an admitted membership.");
            room.hostParticipantId = String(payload?.participantId);
            if (self.database.prepare("SELECT 1 FROM sqlite_schema WHERE name='next_room_host_successions'").get())
              self.database.prepare("UPDATE next_room_host_successions SET assigned_host=? WHERE room_id=?")
                .run(room.hostParticipantId, id);
          }
        });
      },
      async requestJoin(id: string, request: JsonRecord) {
        self.change(id, room => { if (!room.identity.pendingJoins.some(item => item.requestId === request.requestId))
          room.identity.pendingJoins.push({ ...copy(request), status: "pending" }); });
      },
      async resolveJoin(id: string, resolution: JsonRecord) {
        self.change(id, room => {
          const request = room.identity.pendingJoins.find(item => item.requestId === resolution.requestId);
          if (!request || request.status !== "pending") return;
          if (["new", "reuse"].includes(resolution.outcome)) {
            let member = room.identity.memberships.find(item => item.participantId === resolution.participantId);
            if (!member) {
              if (resolution.outcome !== "new" || room.identity.memberships.length >= 64) throw new Error("Invalid or excessive membership.");
              member = { participantId: resolution.participantId, kind: request.kind, role: "", temporary: !!request.temporary,
                createdAt: resolution.resolvedAt, updatedAt: resolution.resolvedAt };
              room.identity.memberships.push(member);
            }
            if (member.forgottenAt || member.kind !== request.kind) throw new Error("Participant identity mismatch.");
            const key = request.aliasKey ?? aliasKey(request.alias);
            if (room.identity.aliases.some(alias => alias.aliasKey === key && !alias.releasedAt && alias.participantId !== member!.participantId))
              throw new Error("Alias already reserved.");
            room.identity.aliases.push({ aliasKey: key, alias: request.alias, participantId: member.participantId, assignedAt: resolution.resolvedAt });
          }
          Object.assign(request, resolution, { status: resolution.outcome === "new" ? "approved_new"
            : resolution.outcome === "reuse" ? "approved_reuse" : resolution.outcome === "timeout" ? "timed_out" : resolution.outcome === "reject" ? "rejected" : "cancelled" });
        });
      },
      async releaseAlias(id: string, participantId: string, at: number, alias?: string) {
        self.change(id, room => { for (const item of room.identity.aliases)
          if (item.participantId === participantId && !item.releasedAt && (!alias || item.aliasKey === aliasKey(alias))) item.releasedAt = at; });
      },
      async forgetParticipant(id: string, participantId: string, at: number) {
        self.change(id, room => { const member = room.identity.memberships.find(item => item.participantId === participantId);
          if (member) member.forgottenAt = at;
          self.database.prepare("DELETE FROM legacy_room_runtime_resume WHERE room_id=? AND participant_id=?").run(id, participantId);
          for (const alias of room.identity.aliases) if (alias.participantId === participantId && !alias.releasedAt) alias.releasedAt = at; });
      },
      async renameAlias(id: string, participantId: string, alias: string, at: number) {
        await this.releaseAlias(id, participantId, at);
        self.change(id, room => { room.identity.aliases.push({ participantId, alias, aliasKey: aliasKey(alias), assignedAt: at }); });
      },
      async setParticipantRole(id: string, participantId: string, role: string) {
        self.change(id, room => { const member = room.identity.memberships.find(item => item.participantId === participantId); if (member) member.role = role; });
      },
      async closeRoom(id: string) { self.change(id, room => { room.state = "stored"; }); },
      async dispose() {},
    };
  }
  private lifecycle(persistence: any): any {
    return {
      persistence,
      listStoredRooms: async () => [...this.admitted].map(id => {
        const room = this.state(id);
        return { roomId: id, roomName: room.roomName, updatedAt: room.updatedAt, messageCount: room.messages.length, canRehost: room.state === "stored" };
      }),
      rehostRoom: async (id: string) => {
        const secret = this.authorizedSecrets.get(id) ?? randomBytes(24).toString("base64url");
        this.active.set(id, { secret, hostToken: "" });
        return this.change(id, room => { room.state = "active";
          return { roomId: id, roomName: room.roomName, joinSecret: secret, messages: copy(room.messages),
            hostParticipantId: room.hostParticipantId, replayed: 0, identityState: copy(room.identity),
            ...this.options.roomOwnership?.(id) }; });
      },
      deactivateRoom: async (id: string) => {
        await persistence.closeRoom(id); this.active.delete(id); this.credentialRooms.delete(id);
      },
      publishActiveDescriptor() {},
      renameActiveRoom: async (id: string, name: string) => { this.renameRoom(id, name); },
      rotateJoinSecret: async (id: string) => {
        if (this.credentialRooms.has(id) && !this.options.rotateJoinSecret)
          throw new Error("Legacy Room secret rotation requires the credential host.");
        const active = this.active.get(id); if (!active) throw new Error("Room is not active.");
        try {
          const secret = this.options.rotateJoinSecret
            ? await this.options.rotateJoinSecret(id, active.secret) : randomBytes(24).toString("base64url");
          this.assertAdmission();
          return active.secret = secret;
        } catch (error) {
          void this.drain().catch(() => {});
          throw error;
        }
      },
      authorizeHostCloseProof: async (id: string, proof: { timestamp: number; nonce: string; signature: string }) => {
        this.assertAdmission();
        if (!this.active.has(id) || !this.admitted.has(id) || !this.options.authorizeHostCloseProof
          || !Number.isFinite(proof.timestamp) || Math.abs(Date.now() - proof.timestamp) > 30_000
          || !/^[A-Za-z0-9_-]{16,256}$/.test(proof.nonce) || !/^[A-Za-z0-9_-]{32,128}$/.test(proof.signature)
          || !await this.options.authorizeHostCloseProof(id, Object.freeze({ ...proof }))) return false;
        this.assertAdmission();
        return this.transaction(() => {
          this.database.exec(`CREATE TABLE IF NOT EXISTS legacy_room_runtime_host_close_proofs(
            room_id TEXT NOT NULL,nonce TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(room_id,nonce))`);
          this.database.prepare("DELETE FROM legacy_room_runtime_host_close_proofs WHERE expires_at<=?").run(Date.now());
          if (this.database.prepare("SELECT 1 FROM legacy_room_runtime_host_close_proofs WHERE room_id=? AND nonce=?").get(id, proof.nonce))
            return false;
          this.database.prepare("INSERT INTO legacy_room_runtime_host_close_proofs VALUES(?,?,?)").run(id, proof.nonce, Date.now() + 60_000);
          return true;
        });
      },
      createRoom: async () => { throw new Error("This host can only reopen explicitly admitted legacy Rooms."); },
      dispose: async () => { for (const id of this.active.keys()) await persistence.closeRoom(id); this.active.clear(); },
    };
  }
  private async issueResumeCredential(connection: any, replace = false): Promise<void> {
    if (!connection.cid || !connection.participantId || this.hub.rooms.get(connection.room)?.owner === connection.participantId)
      return;
    const secret = this.transaction(() => {
      const prior = this.database.prepare("SELECT 1 FROM legacy_room_runtime_resume WHERE room_id=? AND participant_id=?")
        .get(connection.room, connection.participantId);
      if (prior && !replace) return undefined;
      const value = randomBytes(32).toString("base64url");
      this.database.prepare(`INSERT INTO legacy_room_runtime_resume VALUES(?,?,?,?)
        ON CONFLICT(room_id,participant_id) DO UPDATE SET client_key=excluded.client_key,secret_hash=excluded.secret_hash`)
        .run(connection.room, connection.participantId, connection.cid, hash(value));
      return value;
    });
    if (!secret) return;
    this.assertAdmission();
    if (!connection.joined || connection.ws.readyState !== 1) return;
    await new Promise<void>((ready, reject) => connection.ws.send(JSON.stringify({
      t: "native.resume.credential", roomId: connection.room, clientId: connection.cid,
      participantId: connection.participantId, secret,
    }), (error?: Error) => error ? reject(error) : ready()));
  }
  private offer(roomId: string, owner: string, metadata: JsonRecord): boolean {
    if (!metadata || !/^[A-Za-z0-9_-]{1,128}$/.test(metadata.fileId) || typeof metadata.name !== "string"
      || metadata.name.length > 200 || /[\u0000-\u001f]/.test(metadata.name) || !Number.isSafeInteger(metadata.size)
      || metadata.size < 0 || metadata.size > maxFile || typeof metadata.mime !== "string" || metadata.mime.length > 200
      || Object.keys(metadata).sort().join(",") !== "fileId,mime,name,size")
      throw new Error("Invalid bounded native attachment offer.");
    return this.transaction(() => {
      this.state(roomId);
      const encoded = JSON.stringify({ fileId: metadata.fileId, name: metadata.name, size: metadata.size, mime: metadata.mime });
      const prior = this.database.prepare("SELECT owner_id,metadata_json FROM legacy_room_runtime_files WHERE room_id=? AND file_id=?").get(roomId, metadata.fileId);
      if (prior) {
        if (prior.owner_id !== owner || prior.metadata_json !== encoded) throw new Error("Attachment receipt conflict.");
        return !this.state(roomId).messages.some(message => message.metadata?.file?.fileId === metadata.fileId);
      }
      if (this.state(roomId).messages.some(message => message.metadata?.file?.fileId === metadata.fileId))
        throw new Error("A historical file ID cannot acquire an unrelated payload.");
      const totals = this.database.prepare("SELECT metadata_json FROM legacy_room_runtime_files WHERE room_id=?").all(roomId);
      if (totals.length >= 128 || totals.reduce((sum, row) => sum + JSON.parse(String(row.metadata_json)).size, 0) + metadata.size > 64 * 1024 * 1024)
        throw new Error("Room attachment quota exceeded.");
      this.database.prepare("INSERT INTO legacy_room_runtime_files VALUES(?,?,?,?,?,?,?)")
        .run(roomId, metadata.fileId, owner, encoded, metadata.size === 0 ? 1 : 0, metadata.size === 0 ? hash("") : null, metadata.size === 0 ? Buffer.alloc(0) : null);
      return true;
    });
  }
  private chunk(roomId: string, owner: string, frame: JsonRecord): boolean {
    if (!Number.isSafeInteger(frame.seq) || frame.seq < 0 || frame.seq > 1024 || typeof frame.data !== "string" || typeof frame.last !== "boolean"
      || frame.data.length > 131_072 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data))
      throw new Error("Invalid native attachment chunk.");
    const bytes = Buffer.from(frame.data, "base64");
    if (!bytes.length) throw new Error("Empty native attachment chunks are not accepted.");
    return this.transaction(() => {
      const file = this.database.prepare("SELECT owner_id,metadata_json,complete FROM legacy_room_runtime_files WHERE room_id=? AND file_id=?").get(roomId, frame.fileId);
      if (!file || file.owner_id !== owner) throw new Error("Attachment owner/offer unavailable.");
      const prior = this.database.prepare("SELECT sha256 FROM legacy_room_runtime_chunks WHERE room_id=? AND file_id=? AND sequence=?").get(roomId, frame.fileId, frame.seq);
      if (prior) { if (prior.sha256 !== hash(bytes)) throw new Error("Attachment chunk receipt conflict."); return false; }
      const chunks = this.database.prepare("SELECT data FROM legacy_room_runtime_chunks WHERE room_id=? AND file_id=? ORDER BY sequence").all(roomId, frame.fileId);
      if (file.complete || frame.seq !== chunks.length) throw new Error("Attachment chunks must arrive in sequence.");
      const size = chunks.reduce((sum, row) => sum + (row.data as Uint8Array).length, 0) + bytes.length;
      const expected = JSON.parse(String(file.metadata_json)).size;
      if (size > expected || !!frame.last !== (size === expected)) throw new Error("Attachment size/final marker mismatch.");
      this.database.prepare("INSERT INTO legacy_room_runtime_chunks VALUES(?,?,?,?,?)").run(roomId, frame.fileId, frame.seq, hash(bytes), bytes);
      if (frame.last) {
        const complete = Buffer.concat([...chunks.map(row => Buffer.from(row.data as Uint8Array)), bytes]);
        this.database.prepare("UPDATE legacy_room_runtime_files SET complete=1,sha256=?,data=? WHERE room_id=? AND file_id=?")
          .run(hash(complete), complete, roomId, frame.fileId);
      }
      return true;
    });
  }
  private async replayFiles(connection: any, fileId?: string) {
    this.assertAdmission();
    const files = this.database.prepare("SELECT file_id,owner_id,metadata_json,sha256,complete FROM legacy_room_runtime_files WHERE room_id=? AND (? IS NULL OR file_id=?) ORDER BY file_id").all(connection.room, fileId ?? null, fileId ?? null);
    for (const file of files) {
      const metadata = JSON.parse(String(file.metadata_json));
      const chunks = this.database.prepare("SELECT data,sha256 FROM legacy_room_runtime_chunks WHERE room_id=? AND file_id=? ORDER BY sequence").all(connection.room, file.file_id);
      if (file.complete && metadata.size === 0) chunks.push({ data: Buffer.alloc(0), sha256: hash("") });
      for (const chunk of chunks) if (hash(Buffer.from(chunk.data as Uint8Array)) !== chunk.sha256)
        throw new Error("Native attachment chunk integrity failure.");
      if (file.complete) {
        const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk.data as Uint8Array)));
        if (bytes.length !== metadata.size || hash(bytes) !== file.sha256) throw new Error("Native attachment replay integrity failure.");
      }
      const owner = this.state(connection.room).identity.aliases.find(alias => alias.participantId === file.owner_id)?.alias ?? "Historical participant";
      const send = async (frame: JsonRecord) => {
        this.assertAdmission();
        if (!connection.joined || connection.ws.readyState !== 1) throw new Error("Room replay client disconnected.");
        await new Promise<void>((ready, reject) => connection.ws.send(JSON.stringify(frame),
          (error?: Error) => error ? reject(error) : ready()));
      };
      await send({ t: "file.offer", room: connection.room, from: owner, fromId: file.owner_id, file: metadata });
      for (const [sequence, chunk] of chunks.entries()) {
        await send({ t: "file.chunk", room: connection.room, fileId: metadata.fileId, seq: sequence,
          data: Buffer.from(chunk.data as Uint8Array).toString("base64"), last: !!file.complete && sequence === chunks.length - 1 });
      }
    }
  }
  drain(): Promise<void> {
    return this.stopping ??= (async () => {
      this.admitting = false;
      this.pendingRebinds.clear();
      if (this.heartbeat) clearInterval(this.heartbeat);
      const httpClosed = this.server && !this.serverClosed
        ? new Promise<void>(resolve => this.server!.once("close", resolve)) : Promise.resolve();
      const wsClosed = this.sockets && !this.socketsClosed
        ? new Promise<void>(resolve => this.sockets.once("close", resolve)) : Promise.resolve();
      try { await this.messages; await this.hub.stop(); }
      finally {
        for (const connection of this.hub.conns.values()) connection.ws?.terminate();
        for (const socket of this.sockets?.clients ?? []) socket.terminate();
        this.sockets?.close(); this.server?.close(); this.server?.closeAllConnections();
        await Promise.all([httpClosed, wsClosed]);
        this.closed = true; this.database.close();
      }
    })();
  }
}
