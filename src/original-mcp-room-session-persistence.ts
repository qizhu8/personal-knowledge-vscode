import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { RootOwner } from "./root-owner.js";
import type { OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { inspectLegacyChatroomArchive, inspectLegacyChatroomParticipants } from "./legacy-chatroom-continuation.js";
import { initializeLegacyRoomPersistence, createLegacyRoomPersistence, prepareLegacyRoomRehost,
  type LegacyRoomState } from "./legacy-chatroom-persistence.js";
import { claimOriginalRoomSessionGrant, type OriginalRoomSessionGrant } from "./original-mcp-room-session-authority.js";
import { assertNoDurableOriginalRoomInvite } from "./original-mcp-room-session-user-link-codec.js";
import { originalRoomSessionDigest as digest, roomSessionOperationSchema, roomSessionProofSchema, roomSessionRequestSchema,
  type RoomSessionOperation } from "./original-mcp-room-session-contracts.js";

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const maxBytes = 1048576;

/** Credential-free adapter for a native-owned retained Hub; all business state stays in the existing Core database. */
export async function createOriginalRoomSessionPersistence(owner: RootOwner, host: OriginalMcpNativeHost,
  grant: OriginalRoomSessionGrant) {
  const { storage } = await owner.ensureFull();
  claimOriginalRoomSessionGrant(grant, owner, storage, host);
  const effect = grant.effect, roomId = effect.roomId;
  let originalParticipants: ReturnType<typeof inspectLegacyChatroomParticipants>;
  try { originalParticipants = inspectLegacyChatroomParticipants(effect.root, roomId); }
  catch (error) { grant.revoke(); throw error; }
  const database = storage.connectNative();
  let closed = false, closing: Promise<void> | undefined, queue: Promise<unknown> = Promise.resolve();
  const originalIds = new Set(originalParticipants.memberships.map(member => member.participantId));
  const oldClientKeys = new Set(originalParticipants.pendingJoins.map(request => request.clientKey));
  const current = () => {
    if (closed) fail("ROOM_SESSION_PERSISTENCE_CLOSED");
    owner.assertWorkspaceLease(); grant.assertCurrent();
    const lease = owner.workspaceLease();
    const actual = database.prepare("SELECT owner_id,fence FROM native_runtime_owner WHERE singleton=1").get();
    if (!actual || actual.owner_id !== lease.ownerId || actual.fence !== lease.fence) fail("ROOM_SESSION_OWNER_FENCED");
  };
  const rawState = (): LegacyRoomState => {
    const row = database.prepare("SELECT source_fingerprint,state_json FROM legacy_room_runtime_rooms WHERE room_id=?").get(roomId);
    if (!row || row.source_fingerprint !== effect.sourceFingerprint) fail("ROOM_SESSION_SOURCE_CONFLICT");
    return JSON.parse(String(row.state_json)) as LegacyRoomState;
  };
  const change = <T>(selected: string, operation: (state: LegacyRoomState) => T): T => {
    if (selected !== roomId || !database.isTransaction) fail("ROOM_SESSION_TRANSACTION_REQUIRED");
    const state = rawState(), result = operation(state); state.updatedAt = Date.now();
    const json = JSON.stringify(state);
    if (Buffer.byteLength(json) > 524288) fail("ROOM_SESSION_BOUNDED_HISTORY_EXCEEDED");
    database.prepare("UPDATE legacy_room_runtime_rooms SET state_json=? WHERE room_id=?").run(json, roomId);
    return result;
  };
  const persistence = createLegacyRoomPersistence({ database, state(selected) {
    if (selected !== roomId) fail("ROOM_SESSION_ROOM_MISMATCH");
    return rawState();
  }, change });
  try {
    current(); database.exec("BEGIN IMMEDIATE");
    initializeLegacyRoomPersistence(database);
    database.exec(`CREATE TABLE IF NOT EXISTS legacy_room_runtime_native_sessions(
      room_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,effect_sha256 TEXT NOT NULL,effect TEXT NOT NULL,
      state TEXT NOT NULL,participant_id TEXT,client_key TEXT);
      CREATE TABLE IF NOT EXISTS legacy_room_runtime_native_receipts(
      session_id TEXT NOT NULL,operation_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,result TEXT NOT NULL,
      PRIMARY KEY(session_id,operation_id));
      CREATE TABLE IF NOT EXISTS legacy_room_runtime_native_calls(
      session_id TEXT NOT NULL,call_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,request TEXT NOT NULL,
      result TEXT,cursor_before INTEGER,cursor_after INTEGER,PRIMARY KEY(session_id,call_id));`);
    const prior = database.prepare("SELECT state FROM legacy_room_runtime_native_sessions WHERE room_id=?").get(roomId);
    const room = database.prepare("SELECT state_json FROM legacy_room_runtime_rooms WHERE room_id=?").get(roomId);
    if (prior && prior.state !== "closed") fail("ROOM_SESSION_RECOVERY_OR_CLOSE_REQUIRED");
    if (room && JSON.parse(String(room.state_json)).state !== "stored") fail("ROOM_SESSION_ALREADY_ACTIVE");
    database.prepare(`INSERT INTO legacy_room_runtime_native_sessions VALUES(?,?,?,?,'reserved',NULL,NULL)
      ON CONFLICT(room_id) DO UPDATE SET session_id=excluded.session_id,effect_sha256=excluded.effect_sha256,
      effect=excluded.effect,state='reserved',participant_id=NULL,client_key=NULL`)
      .run(roomId, effect.sessionId, digest(effect), JSON.stringify(effect));
    current(); database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    database.close(); grant.revoke(); throw error;
  }
  const sessionRow = () => {
    const row = database.prepare("SELECT * FROM legacy_room_runtime_native_sessions WHERE room_id=?").get(roomId);
    if (!row || row.session_id !== effect.sessionId || row.effect_sha256 !== digest(effect) || row.state === "closed")
      fail("ROOM_SESSION_BINDING_CHANGED");
    return row;
  };
  async function execute(body: RoomSessionOperation): Promise<unknown> {
    const session = sessionRow();
    if (body.operation === "room.activate") {
      if (session.state !== "reserved") fail("ROOM_SESSION_ALREADY_ACTIVE");
      const archive = inspectLegacyChatroomArchive(effect.root, roomId);
      assertNoDurableOriginalRoomInvite(archive.messages);
      if (archive.sourceFingerprint !== effect.sourceFingerprint || archive.messages.length > 4900)
        fail("ROOM_SESSION_SOURCE_CONFLICT");
      if (!database.prepare("SELECT 1 FROM legacy_room_runtime_rooms WHERE room_id=?").get(roomId)) {
        const state: LegacyRoomState = { roomId, roomName: archive.name, state: "stored", updatedAt: Date.now(),
          ...(effect.hostParticipantId ? { hostParticipantId: effect.hostParticipantId } : {}),
          identity: originalParticipants, messages: archive.messages.map(message => ({
            id: message.message_id, participantId: message.participant_id, aliasAtSend: message.alias_at_send,
            senderKind: message.sender_kind, messageType: message.message_type, content: message.content,
            metadata: message.metadata_json === null ? null : JSON.parse(message.metadata_json), createdAt: message.created_at,
          })) };
        if (Buffer.byteLength(JSON.stringify(state)) > 524288) fail("ROOM_SESSION_BOUNDED_HISTORY_EXCEEDED");
        database.prepare("INSERT INTO legacy_room_runtime_rooms VALUES(?,?,?)").run(roomId, effect.sourceFingerprint, JSON.stringify(state));
      }
      change(roomId, room => {
        if ((room.hostParticipantId ?? null) !== effect.hostParticipantId) fail("ROOM_SESSION_HOST_IDENTITY_CONFLICT");
        prepareLegacyRoomRehost(room, database); room.state = "active";
      });
      database.prepare("UPDATE legacy_room_runtime_native_sessions SET state='active' WHERE room_id=?").run(roomId);
      const state = rawState();
      return { roomId, roomName: state.roomName, messages: state.messages, replayed: 0,
        identityState: state.identity, hostParticipantId: state.hostParticipantId };
    }
    if (session.state !== "active" && !(session.state === "reserved" && body.operation === "room.close") && !(session.state === "closing"
      && ["alias.release", "participant.forget", "client.complete", "room.snapshot", "room.close"].includes(body.operation)))
      fail("ROOM_SESSION_NOT_ACTIVE");
    switch (body.operation) {
      case "room.snapshot": return clone(rawState());
      case "session.watch": fail("ROOM_SESSION_WATCH_TRANSPORT_ONLY");
      case "identity.read": return persistence.identityState(roomId);
      case "join.request": {
        if (body.request.alias !== effect.selection.alias || body.request.kind !== "agent"
          || oldClientKeys.has(body.request.clientKey) || session.participant_id || session.client_key
          || rawState().identity.pendingJoins.some(item => item.clientKey === body.request.clientKey))
          fail("ROOM_SESSION_FRESH_SINGLE_AGENT_REQUIRED");
        await persistence.requestJoin(roomId, { ...body.request, temporary: true });
        database.prepare("UPDATE legacy_room_runtime_native_sessions SET client_key=? WHERE room_id=?").run(body.request.clientKey, roomId);
        return null;
      }
      case "join.resolve": {
        const request = rawState().identity.pendingJoins.find(item => item.requestId === body.resolution.requestId);
        if (!request || request.clientKey !== session.client_key) fail("ROOM_SESSION_JOIN_MISMATCH");
        if (body.resolution.outcome === "reuse" || body.resolution.outcome === "new" && (!body.resolution.participantId
          || originalIds.has(body.resolution.participantId) || session.participant_id
          || rawState().identity.memberships.some(member => member.participantId === body.resolution.participantId)))
          fail("ROOM_SESSION_PARTICIPANT_REBIND_FORBIDDEN");
        await persistence.resolveJoin(roomId, body.resolution);
        if (body.resolution.outcome === "new")
          database.prepare("UPDATE legacy_room_runtime_native_sessions SET participant_id=? WHERE room_id=?")
            .run(body.resolution.participantId!, roomId);
        return null;
      }
      case "alias.release":
        if (body.participantId !== session.participant_id || body.alias && body.alias !== effect.selection.alias)
          fail("ROOM_SESSION_PARTICIPANT_REBIND_FORBIDDEN");
        await persistence.releaseAlias(roomId, body.participantId, body.at, body.alias); return null;
      case "participant.forget":
        if (body.participantId !== session.participant_id) fail("ROOM_SESSION_PARTICIPANT_REBIND_FORBIDDEN");
        await persistence.forgetParticipant(roomId, body.participantId, body.at); return null;
      case "message.append": {
        const message = body.message, metadata = message.metadata;
        if (!session.participant_id || message.participantId !== session.participant_id || message.senderKind !== "agent"
          || message.aliasAtSend !== effect.selection.alias || message.messageType !== "chat"
          || message.content !== effect.selection.postText || !metadata?.clientRequestId || !metadata.requestFingerprint
          || metadata.file || metadata.replyPolicy !== "none" || metadata.responseRequired !== false)
          fail("ROOM_SESSION_EXACT_PROGRESS_POST_REQUIRED");
        const state = rawState();
        const prior = state.messages.find(item => item.participantId === session.participant_id
          && item.metadata?.clientRequestId === metadata.clientRequestId);
        if (prior) {
          if (JSON.stringify(prior) !== JSON.stringify(message)) fail("ROOM_SESSION_POST_CONFLICT");
          return null;
        }
        if (state.messages.some(item => item.participantId === session.participant_id)) fail("ROOM_SESSION_SINGLE_POST_LIMIT");
        await persistence.append(roomId, message); return null;
      }
      case "room.close":
        if (database.prepare("SELECT 1 FROM legacy_room_runtime_rooms WHERE room_id=?").get(roomId))
          await persistence.closeRoom(roomId);
        database.prepare("UPDATE legacy_room_runtime_native_sessions SET state='closing' WHERE room_id=?").run(roomId);
        return null;
      case "client.begin": {
        const { call } = body;
        if (call.tool === "chat_join" && call.arguments.name !== effect.selection.alias) fail("ROOM_SESSION_CLIENT_ALIAS_MISMATCH");
        if (call.tool === "chat_join" && call.userLink && (call.userLink.endpoint !== effect.endpoint
          || call.userLink.requestedEndpoint !== null && call.userLink.requestedEndpoint !== effect.endpoint
          || call.userLink.requestedRoomId !== null && call.userLink.requestedRoomId !== effect.roomId))
          fail("ROOM_USER_JOIN_ENDPOINT_APPROVAL_REQUIRED");
        if (call.tool === "chat_post" && call.arguments.text.trim() !== effect.selection.postText) fail("ROOM_SESSION_EXACT_PROGRESS_POST_REQUIRED");
        const prior = database.prepare("SELECT * FROM legacy_room_runtime_native_calls WHERE session_id=? AND call_id=?")
          .get(effect.sessionId, body.callId);
        if (prior) {
          if (prior.request_sha256 !== digest(call)) fail("ROOM_SESSION_CLIENT_CALL_CONFLICT");
          if (prior.result === null) fail("ROOM_SESSION_CLIENT_OUTCOME_UNKNOWN");
          return { replayed: true, result: String(prior.result), cursorBefore: prior.cursor_before, cursorAfter: prior.cursor_after };
        }
        if (call.tool === "chat_post" || call.tool === "chat_join") {
          const used = database.prepare("SELECT request,result FROM legacy_room_runtime_native_calls WHERE session_id=?")
            .all(effect.sessionId).some(row => JSON.parse(String(row.request)).tool === call.tool
              && (call.tool === "chat_post" || row.result === null || JSON.parse(String(row.result)).ok === true));
          if (used) fail(call.tool === "chat_post" ? "ROOM_SESSION_SINGLE_POST_LIMIT" : "ROOM_SESSION_FRESH_SINGLE_AGENT_REQUIRED");
        }
        const count = database.prepare("SELECT count(*) AS n FROM legacy_room_runtime_native_calls WHERE session_id=?").get(effect.sessionId)!.n;
        if (Number(count) >= 16) fail("ROOM_SESSION_CLIENT_CALL_LIMIT");
        database.prepare("INSERT INTO legacy_room_runtime_native_calls VALUES(?,?,?,?,NULL,NULL,NULL)")
          .run(effect.sessionId, body.callId, digest(call), JSON.stringify(call));
        return { replayed: false };
      }
      case "client.complete": {
        const prior = database.prepare("SELECT * FROM legacy_room_runtime_native_calls WHERE session_id=? AND call_id=?")
          .get(effect.sessionId, body.callId);
        if (!prior) fail("ROOM_SESSION_CLIENT_CALL_REQUIRED");
        if (prior.result !== null) {
          if (prior.result !== body.result || prior.cursor_before !== body.cursorBefore || prior.cursor_after !== body.cursorAfter)
            fail("ROOM_SESSION_CLIENT_CALL_CONFLICT");
          return null;
        }
        const call = JSON.parse(String(prior.request)) as { tool: string }, value = JSON.parse(body.result);
        assertNoDurableOriginalRoomInvite(value);
        if (!value || typeof value !== "object" || typeof value.ok !== "boolean") fail("ROOM_SESSION_ORIGINAL_RESULT_REQUIRED");
        if (value.ok && call.tool === "chat_join" && (value.participant_id !== session.participant_id || !session.participant_id))
          fail("ROOM_SESSION_UNPERSISTED_JOIN");
        if (value.ok && call.tool === "chat_post") {
          const message = rawState().messages.find(item => item.id === value.message_id);
          if (!message || message.participantId !== session.participant_id
            || message.metadata?.clientRequestId !== value.client_request_id) fail("ROOM_SESSION_UNPERSISTED_POST");
        }
        if (body.cursorAfter < body.cursorBefore && call.tool === "chat_read") fail("ROOM_SESSION_CURSOR_CONFLICT");
        database.prepare("UPDATE legacy_room_runtime_native_calls SET result=?,cursor_before=?,cursor_after=? WHERE session_id=? AND call_id=?")
          .run(body.result, body.cursorBefore, body.cursorAfter, effect.sessionId, body.callId);
        return null;
      }
    }
  }
  async function dispatch(operationId: string, input: unknown): Promise<unknown> {
    roomSessionRequestSchema.shape.operationId.parse(operationId);
    const body = roomSessionOperationSchema.parse(input);
    assertNoDurableOriginalRoomInvite(body);
    const run = queue.then(async () => {
      current();
      const readOnly = body.operation === "room.snapshot" || body.operation === "identity.read";
      database.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
      try {
        sessionRow();
        if (readOnly) {
          const value = await execute(body);
          if (Buffer.byteLength(JSON.stringify(value)) > maxBytes - 1024) fail("ROOM_SESSION_RESPONSE_TOO_LARGE");
          current(); database.exec("COMMIT"); return value;
        }
        const prior = database.prepare("SELECT * FROM legacy_room_runtime_native_receipts WHERE session_id=? AND operation_id=?")
          .get(effect.sessionId, operationId);
        if (prior) {
          if (prior.request_sha256 !== digest(body)) fail("ROOM_SESSION_OPERATION_CONFLICT");
          const value = JSON.parse(String(prior.result)); current(); database.exec("COMMIT"); return value;
        }
        const value = await execute(body);
        const json = JSON.stringify(value ?? null);
        if (Buffer.byteLength(json) > maxBytes - 1024) fail("ROOM_SESSION_RESPONSE_TOO_LARGE");
        current();
        database.prepare("INSERT INTO legacy_room_runtime_native_receipts VALUES(?,?,?,?)")
          .run(effect.sessionId, operationId, digest(body), json);
        database.exec("COMMIT"); return value ?? null;
      } catch (error) { if (database.isTransaction) database.exec("ROLLBACK"); throw error; }
    });
    queue = run.catch(() => {}); return run;
  }
  function closeAdmission() { closed = true; }
  async function close() {
    if (closing) return closing;
    closeAdmission();
    closing = (async () => {
      await queue;
      try {
        owner.assertWorkspaceLease(); database.exec("BEGIN IMMEDIATE");
        const selected = database.prepare("SELECT session_id,participant_id FROM legacy_room_runtime_native_sessions WHERE room_id=?").get(roomId);
        if (selected?.session_id === effect.sessionId) {
          const row = database.prepare("SELECT 1 FROM legacy_room_runtime_rooms WHERE room_id=?").get(roomId);
          if (row) change(roomId, state => {
            state.state = "stored";
            const member = state.identity.memberships.find(item => item.participantId === selected.participant_id);
            if (member?.temporary && !member.forgottenAt) member.forgottenAt = Date.now();
            for (const request of state.identity.pendingJoins)
              if (request.clientKey === database.prepare("SELECT client_key FROM legacy_room_runtime_native_sessions WHERE room_id=?").get(roomId)?.client_key
                && request.status === "pending") request.status = "cancelled";
            for (const alias of state.identity.aliases)
              if (alias.participantId === selected.participant_id && !alias.releasedAt) alias.releasedAt = Date.now();
          });
          database.prepare("UPDATE legacy_room_runtime_native_sessions SET state='closed' WHERE room_id=?").run(roomId);
        }
        database.exec("COMMIT");
      } catch (error) { if (database.isTransaction) database.exec("ROLLBACK"); throw error; }
      finally { database.close(); grant.signal.removeEventListener("abort", revoked); }
    })();
    return closing;
  }
  const revoked = () => { void close().catch(() => {}); };
  grant.signal.addEventListener("abort", revoked, { once: true });
  owner.retainResource({ closeAdmission, release: close });
  return Object.freeze({ kind: "pkm.original-native-room-core-persistence/v1" as const, effect, signal: grant.signal,
    dispatch, assertCurrent: current, closeAdmission, close });
}
export type OriginalRoomSessionPersistence = Awaited<ReturnType<typeof createOriginalRoomSessionPersistence>>;

/** Private transport capability only. The RootOwner/effect grant, not this token, grants Room effects. */
export async function startOriginalRoomSessionPersistenceServer(port: OriginalRoomSessionPersistence, directory: string) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory
    || stat.uid !== process.getuid!() || stat.mode & 0o077) fail("ROOM_SESSION_PRIVATE_ENDPOINT_REQUIRED");
  port.assertCurrent();
  const socketPath = join(directory, "p");
  if (Buffer.byteLength(socketPath) > 103) fail("ROOM_SESSION_SOCKET_PATH_LIMIT");
  const token = randomBytes(32).toString("hex"), sockets = new Set<Socket>();
  const server = createServer(socket => {
    if (sockets.size >= 8) { socket.destroy(); return; }
    sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => socket.destroy());
    socket.setTimeout(10000, () => socket.destroy());
    let bytes = Buffer.alloc(0), received = false;
    socket.on("data", chunk => {
      if (received || bytes.length + chunk.length > maxBytes) { socket.destroy(); return; }
      bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
      const boundary = bytes.indexOf(10); if (boundary < 0) return;
      received = true;
      if (boundary !== bytes.length - 1) { socket.destroy(); return; }
      void Promise.resolve().then(async () => {
        const request = roomSessionRequestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, boundary))));
        if (request.sessionId !== port.effect.sessionId || request.transportToken.length !== token.length
          || !timingSafeEqual(Buffer.from(request.transportToken), Buffer.from(token))
          || request.requestSha256 !== digest(request.body)) fail("ROOM_SESSION_TRANSPORT_REFUSED");
        if (request.body.operation === "session.watch") {
          port.assertCurrent(); socket.setTimeout(0);
          socket.write(JSON.stringify({ operationId: request.operationId, watching: true }) + "\n");
          return;
        }
        const result = await port.dispatch(request.operationId, request.body);
        port.assertCurrent(); socket.end(JSON.stringify({ operationId: request.operationId, result }) + "\n");
      }).catch(error => {
        if (!socket.destroyed) socket.end(JSON.stringify({ error: {
          code: typeof error?.code === "string" && /^(ROOM_SESSION_|ROOM_USER_JOIN_)/.test(error.code) ? error.code : "ROOM_SESSION_REQUEST_INVALID",
        } }) + "\n");
      });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  const { chmod, unlink, lstat } = await import("node:fs/promises");
  let socketIdentity: { dev: number; ino: number };
  try {
    await chmod(socketPath, 0o600); port.assertCurrent();
    const node = await lstat(socketPath); socketIdentity = { dev: node.dev, ino: node.ino };
  } catch (error) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await port.close(); throw error;
  }
  let closing: Promise<void> | undefined;
  async function close() {
    return closing ??= (async () => {
      port.closeAdmission();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await port.close();
      const current = await lstat(socketPath).catch(error => { if (error.code !== "ENOENT") throw error; });
      if (current) {
        if (current.dev !== socketIdentity.dev || current.ino !== socketIdentity.ino) fail("ROOM_SESSION_ENDPOINT_CHANGED");
        await unlink(socketPath);
      }
      port.signal.removeEventListener("abort", revoked);
    })();
  }
  const revoked = () => { void close().catch(() => {}); };
  port.signal.addEventListener("abort", revoked, { once: true });
  return Object.freeze({ descriptor: Object.freeze(roomSessionProofSchema.parse({
    schema: "pkm.original-native-room-persistence/v1", sessionId: port.effect.sessionId, socketPath,
    transportToken: token, effectSha256: digest(port.effect),
  })), close });
}
