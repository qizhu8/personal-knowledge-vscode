import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  channelAccept, channelAck, channelAssign, channelKey, channelRead, channelReconnect,
  channelReply, channelSend, channelTaskPin, channelUpdate, channelWait, type ChannelTaskPin,
} from "./channel-runtime-contracts.js";
import {
  channelFail, channelHash, currentChannelMember, sameChannelActor,
  type ChannelActor, type ChannelInvitation, type ChannelMember, type ChannelMessage, type ChannelRecord,
} from "./domain/channel-runtime-model.js";
import { parsePeerPacket } from "./domain/channel-runtime-original-peer.js";

export { channelRuntimeDefinitions } from "./channel-runtime-contracts.js";
export { ChannelRuntimeError } from "./domain/channel-runtime-model.js";
export type { ChannelActor, ChannelRecord, ChannelMessage } from "./domain/channel-runtime-model.js";

export function initializeChannelRuntimeSchema(db: DatabaseSync): void {
  if (!db.isTransaction) channelFail("TRANSACTION_REQUIRED");
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_runtime_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);
    INSERT OR IGNORE INTO channel_runtime_schema VALUES(1,1);
    CREATE TABLE IF NOT EXISTS channel_runtime_rooms(
      channel_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)));
    CREATE TABLE IF NOT EXISTS channel_runtime_receipts(
      operation_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,channel_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)));
  `);
  if (db.prepare("SELECT version FROM channel_runtime_schema WHERE singleton=1").get()?.version !== 1) channelFail("UNSUPPORTED_SCHEMA");
}

export interface ChannelTaskAuthority {
  /** Synchronous SQL-only parent projection. Must check owner, recipient, live attempt and exact definition/version pin. */
  authorize(input: { actor: ChannelActor; recipient: ChannelActor; task: ChannelTaskPin; kind: "assign" | "update" | "reply" }): boolean;
  /** SQL-only authority mutation inside the SAME parent transaction. No network or nested Manager runtime API calls. */
  apply(input: { operationId: string; actor: ChannelActor; task: ChannelTaskPin; kind: "assign" | "update" | "reply"; text: string }): ChannelTaskPin;
}
export interface ChannelRuntimeHost {
  resolveActor(token: object): ChannelActor | undefined;
  authorizeHuman(actor: Readonly<ChannelActor>, action: string, channelId: string): boolean;
  assertLease(): void;
  /** Parent owns BEGIN/COMMIT/ROLLBACK and must reject thenable callbacks. */
  transaction<T>(work: () => T): T;
  /** Reserve in the host GLOBAL cross-slice operation namespace, transactionally; reject conflicting existing IDs. */
  claimReceipt(operationId: string, fingerprint: string, actorId?: string, operation?: string): void;
  /** Parent authorization for directed edges, not a room-wide broadcast grant. Default deny. */
  authorizeDirected(actor: ChannelActor, recipient: ChannelActor, channelId: string): boolean;
  taskAuthority?: ChannelTaskAuthority;
  /** Post-commit wake hint only. No payload/credentials; receiver always re-reads with ACL. Failure cannot undo committed receipts. */
  notify?: (input: { channelId: string; participantId: string }) => void;
}
const actorSchema = z.strictObject({ actorId: channelKey, kind: z.enum(["human", "agent"]) });
const revision = z.number().int().safe().nonnegative();
const nativeMutation = z.strictObject({ operationId: z.string().uuid(), channelId: channelKey, expectedRevision: revision });
const expiration = z.number().int().safe().positive();
const inviteSchema = nativeMutation.extend({
  actor: actorSchema, participantId: channelKey, role: z.enum(["manager", "worker", "observer"]),
  expiresAt: expiration, memberExpiresAt: expiration,
});
const approveSchema = nativeMutation.extend({ invitationId: z.string().uuid() });
const revokeSchema = nativeMutation.extend({ participantId: channelKey });
const createSchema = nativeMutation.extend({ participantId: channelKey, expiresAt: expiration });
type ReadResult = { channelId: string; revision: number; cursor: number; lastSeq: number; state: ChannelMember["state"]; messages: ChannelMessage[] };
type MutationResult = { channelId: string; revision: number; message?: ChannelMessage; cursor?: number; state?: ChannelMember["state"]; invitationId?: string };
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) channelFail("INVALID_ARGUMENT");
  return parsed.data;
}

/**
 * Composition leaf only: injected shared database, parent transactions/receipts/lease and native identity.
 * No rooms, agents, Portal pairings or network are restored or spawned. Invitation APIs are native-only.
 * Persisted "waiting" means reply committed; only active wait handles represent a blocking native wait.
 */
export function createChannelRuntime(db: DatabaseSync, host: ChannelRuntimeHost, options: { now?: () => number; pollMs?: number } = {}) {
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? 100;
  if (!Number.isSafeInteger(pollMs) || pollMs < 5 || pollMs > 1000) channelFail("INVALID_CONFIGURATION");
  const waiters = new Map<string, Set<() => void>>();
  const cancellations = new Set<(code: string) => void>();
  const sessions = new Map<string, { generation: string; connectionId: string; expiresAt: number }>();
  const sessionCancels = new Map<string, Set<(code: string) => void>>();
  let closed = false;
  function synchronous(value: unknown): void {
    if (value && typeof (value as { then?: unknown }).then === "function") channelFail("ASYNC_HOST_HOOK");
  }
  function outside(): void {
    if (closed) channelFail("CHANNEL_UNAVAILABLE");
    if (db.isTransaction) channelFail("TRANSACTION_BOUNDARY");
    synchronous(host.assertLease());
  }
  function actor(token: object): ChannelActor {
    outside();
    if (!token || typeof token !== "object") channelFail("UNAUTHORIZED");
    const resolved = host.resolveActor(token);
    if (!resolved) channelFail("UNAUTHORIZED");
    return Object.freeze(parse(actorSchema, resolved));
  }
  function load(channelId: string): ChannelRecord {
    const row = db.prepare("SELECT record FROM channel_runtime_rooms WHERE channel_id=?").get(channelId);
    if (!row) channelFail("NOT_FOUND");
    return JSON.parse(row.record as string) as ChannelRecord;
  }
  function human(context: ChannelActor, action: string, channelId: string): void {
    if (context.kind !== "human" || host.authorizeHuman(context, action, channelId) !== true) channelFail("HUMAN_AUTHORITY_REQUIRED");
  }
  function key(channelId: string, participantId: string): string { return JSON.stringify([channelId, participantId]); }
  function wake(channelId: string, participantId: string): void {
    for (const fn of [...(waiters.get(key(channelId, participantId)) ?? [])]) fn();
    try { host.notify?.({ channelId, participantId }); } catch { /* Durable mailbox is authoritative; bounded polling recovers dropped hints. */ }
  }
  function atomic<T>(work: () => T): T {
    outside();
    const result = host.transaction(() => {
      if (!db.isTransaction) channelFail("TRANSACTION_REQUIRED");
      synchronous(host.assertLease());
      const result = work();
      if (result && typeof (result as { then?: unknown }).then === "function") channelFail("ASYNC_TRANSACTION");
      synchronous(host.assertLease());
      return result;
    });
    synchronous(result);
    if (db.isTransaction) channelFail("TRANSACTION_BOUNDARY");
    return result;
  }
  function mutate(context: ChannelActor, action: string, input: { operationId: string; channelId: string; expectedRevision: number },
    work: (room: ChannelRecord) => Omit<MutationResult, "channelId" | "revision">,
    authorize: (room: ChannelRecord) => void): MutationResult {
    const fingerprint = channelHash({ context, action, input });
    const result = atomic(() => {
      const room = load(input.channelId);
      authorize(room);
      const receipt = db.prepare("SELECT * FROM channel_runtime_receipts WHERE operation_id=?").get(input.operationId);
      if (receipt) {
        if (receipt.actor_id !== context.actorId || receipt.channel_id !== input.channelId || receipt.fingerprint !== fingerprint) channelFail("OPERATION_CONFLICT");
        return JSON.parse(receipt.record as string) as MutationResult;
      }
      synchronous(host.claimReceipt(input.operationId, fingerprint, context.actorId, `channel.runtime.${action}`));
      if (room.revision !== input.expectedRevision) channelFail("REVISION_CONFLICT");
      if (Number(db.prepare("SELECT COUNT(*) AS count FROM channel_runtime_receipts").get()!.count) >= 100_000) channelFail("RECEIPT_LIMIT");
      const partial = work(room);
      const expected = room.revision++;
      const serialized = JSON.stringify(room);
      if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) channelFail("CHANNEL_LIMIT");
      if (db.prepare("UPDATE channel_runtime_rooms SET revision=?,record=? WHERE channel_id=? AND revision=?")
        .run(room.revision, serialized, room.channelId, expected).changes !== 1) channelFail("REVISION_CONFLICT");
      const result: MutationResult = { channelId: room.channelId, revision: room.revision, ...partial };
      db.prepare("INSERT INTO channel_runtime_receipts VALUES(?,?,?,?,?)")
        .run(input.operationId, context.actorId, room.channelId, fingerprint, JSON.stringify(result));
      return result;
    });
    if (result.message) wake(result.channelId, result.message.recipientId);
    return result;
  }
  function memberAuthorization(context: ChannelActor, generation?: string) {
    return (room: ChannelRecord) => { currentChannelMember(room, context, now(), generation); };
  }
  function target(room: ChannelRecord, context: ChannelActor, participantId: string): ChannelMember {
    const recipient = room.members.find(item => item.participantId === participantId);
    if (!recipient || recipient.revoked) channelFail("RECIPIENT_UNAVAILABLE");
    currentChannelMember(room, recipient.actor, now(), recipient.generation);
    if (host.authorizeDirected(context, recipient.actor, room.channelId) !== true) channelFail("DIRECTED_FORBIDDEN");
    const connection = sessions.get(key(room.channelId, participantId));
    if (!connection || connection.generation !== recipient.generation || connection.expiresAt <= now()) channelFail("RECIPIENT_UNAVAILABLE");
    return recipient;
  }
  function append(room: ChannelRecord, sender: ChannelMember, recipient: ChannelMember, kind: ChannelMessage["kind"], text: string,
    extra: Pick<ChannelMessage, "assignmentId" | "task"> = {}): ChannelMessage {
    if (room.messages.length >= 5000) channelFail("MESSAGE_LIMIT");
    const message: ChannelMessage = {
      id: randomUUID(), seq: ++recipient.lastSeq, senderId: sender.participantId,
      recipientId: recipient.participantId, recipientGeneration: recipient.generation, kind, text, at: now(), ...extra,
    };
    room.messages.push(message);
    return message;
  }
  function read(context: ChannelActor, generation: string, args: unknown): ReadResult {
    outside();
    const input = parse(channelRead, args);
    const room = load(input.channelId), member = currentChannelMember(room, context, now(), generation);
    const after = input.afterSeq ?? member.cursor;
    if (after < member.floor) channelFail("CURSOR_GAP");
    if (after > member.lastSeq) channelFail("INVALID_CURSOR");
    return { channelId: room.channelId, revision: room.revision, cursor: member.cursor, lastSeq: member.lastSeq, state: member.state,
      messages: room.messages.filter(message => message.recipientId === member.participantId &&
        message.recipientGeneration === generation && message.seq > after).slice(0, input.limit) };
  }
  function taskApply(context: ChannelActor, recipient: ChannelActor, input: { operationId: string; task: ChannelTaskPin; text: string },
    kind: "assign" | "update" | "reply"): ChannelTaskPin {
    const authority = host.taskAuthority;
    if (!authority) channelFail("TASK_AUTHORITY_UNAVAILABLE");
    if (authority.authorize({ actor: context, recipient, task: input.task, kind }) !== true) channelFail("TASK_PIN_FORBIDDEN");
    const updated = parse(channelTaskPin, authority.apply({ actor: context, ...input, kind }));
    if (["authority", "runId", "taskId", "attemptId", "definitionSha256"].some(field =>
      updated[field as keyof ChannelTaskPin] !== input.task[field as keyof ChannelTaskPin])) channelFail("TASK_AUTHORITY_CONFLICT");
    if (updated.expectedVersion <= input.task.expectedVersion) channelFail("TASK_AUTHORITY_CONFLICT");
    return updated;
  }
  function wait(context: ChannelActor, generation: string, participantId: string, connectionId: string, args: unknown, signal?: AbortSignal): Promise<ReadResult> {
    const input = parse(channelWait, args);
    const deadline = performance.now() + input.timeoutMs;
    const mailboxKey = key(input.channelId, participantId);
    return new Promise((resolve, reject) => {
      let finished = false, timer: ReturnType<typeof setTimeout> | undefined;
      const done = (error?: unknown, result?: ReadResult) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        waiters.get(mailboxKey)?.delete(check);
        if (!waiters.get(mailboxKey)?.size) waiters.delete(mailboxKey);
        cancellations.delete(cancel);
        sessionCancels.get(connectionId)?.delete(cancel);
        if (!sessionCancels.get(connectionId)?.size) sessionCancels.delete(connectionId);
        if (error) reject(error); else resolve(result!);
      };
      const cancel = (code: string) => { try { channelFail(code); } catch (error) { done(error); } };
      const abort = () => cancel("WAIT_CANCELLED");
      const check = () => {
        if (finished) return;
        if (timer) clearTimeout(timer);
        try {
          if (signal?.aborted) return abort();
          const result = read(context, generation, { channelId: input.channelId, afterSeq: input.afterSeq, limit: input.limit });
          if (result.messages.length || performance.now() >= deadline) return done(undefined, result);
          timer = setTimeout(check, Math.max(1, Math.min(pollMs, deadline - performance.now())));
        } catch (error) { done(error); }
      };
      const set = waiters.get(mailboxKey) ?? new Set<() => void>();
      set.add(check); waiters.set(mailboxKey, set);
      cancellations.add(cancel);
      const cancelSet = sessionCancels.get(connectionId) ?? new Set<(code: string) => void>();
      cancelSet.add(cancel); sessionCancels.set(connectionId, cancelSet);
      signal?.addEventListener("abort", abort, { once: true });
      check();
    });
  }
  function connect(token: object, args: unknown) {
    const context = actor(token), input = parse(channelReconnect, args);
    const member = currentChannelMember(load(input.channelId), context, now());
    const generation = member.generation, participantId = member.participantId, connectionId = randomUUID();
    const sessionKey = key(input.channelId, participantId), previous = sessions.get(sessionKey);
    if (previous) for (const cancel of [...(sessionCancels.get(previous.connectionId) ?? [])]) cancel("CONNECTION_REPLACED");
    sessions.set(sessionKey, { generation, connectionId, expiresAt: member.expiresAt });
    let disconnected = false;
    function connected(args: { channelId: string }): void {
      outside();
      if (disconnected || sessions.get(sessionKey)?.connectionId !== connectionId) channelFail("CONNECTION_UNAVAILABLE");
      if (args.channelId !== input.channelId) channelFail("FORBIDDEN");
    }
    function send(args: unknown, assignment = false): MutationResult {
      const request = assignment ? parse(channelAssign, args) : parse(channelSend, args);
      connected(request);
      return mutate(context, assignment ? "assign" : "send", request, room => {
        const sender = currentChannelMember(room, context, now(), generation);
        const recipient = target(room, context, request.recipientId);
        if (assignment && (sender.role !== "manager" || recipient.role !== "worker")) channelFail("TASK_ROLE_FORBIDDEN");
        const task = assignment ? taskApply(context, recipient.actor, request as z.infer<typeof channelAssign>, "assign") : undefined;
        if (assignment) {
          if (room.deliveries.some(delivery => delivery.task.authority === task!.authority &&
            delivery.task.runId === task!.runId && delivery.task.taskId === task!.taskId && delivery.task.attemptId === task!.attemptId)) channelFail("TASK_ALREADY_DELIVERED");
          if (recipient.state === "working") channelFail("WORKER_BUSY");
          if (room.deliveries.length >= 5000) channelFail("DELIVERY_LIMIT");
          recipient.state = "working";
        }
        const message = append(room, sender, recipient, assignment ? "assignment" : "message", request.text, task ? { task } : {});
        if (task) room.deliveries.push({ assignmentId: message.id, seq: message.seq, senderId: message.senderId,
          recipientId: message.recipientId, recipientGeneration: message.recipientGeneration, task, replied: false });
        return { message };
      }, memberAuthorization(context, generation));
    }
    function update(args: unknown, reply = false): MutationResult {
      const request = reply ? parse(channelReply, args) : parse(channelUpdate, args);
      connected(request);
      return mutate(context, reply ? "reply" : "update", request, room => {
        const sender = currentChannelMember(room, context, now(), generation);
        const assignment = room.deliveries.find(delivery => delivery.assignmentId === request.assignmentId &&
          delivery.recipientId === participantId && delivery.recipientGeneration === generation);
        if (!assignment || sender.role !== "worker") channelFail("TASK_ASSIGNMENT_FORBIDDEN");
        if (assignment.replied) channelFail("TASK_ALREADY_REPLIED");
        if (["authority", "runId", "taskId", "attemptId", "definitionSha256"].some(field =>
          assignment.task![field as keyof ChannelTaskPin] !== request.task[field as keyof ChannelTaskPin])) channelFail("TASK_PIN_FORBIDDEN");
        const recipient = target(room, context, assignment.senderId);
        const task = taskApply(context, recipient.actor, request, reply ? "reply" : "update");
        if (reply) {
          const after = (request as z.infer<typeof channelReply>).afterSeq;
          if (after < assignment.seq || after < sender.cursor || after > sender.lastSeq) channelFail("INVALID_CURSOR");
          sender.cursor = after; sender.state = "waiting";
          assignment.replied = true;
        }
        return { message: append(room, sender, recipient, reply ? "reply" : "update", request.text, { assignmentId: assignment.assignmentId, task }),
          cursor: sender.cursor, state: sender.state };
      }, memberAuthorization(context, generation));
    }
    const client = {
      participantId, generation,
      receivePeerHint(packet: unknown) {
        connected(input);
        currentChannelMember(load(input.channelId), context, now(), generation);
        const envelope = parsePeerPacket(packet);
        const payload = parse(z.strictObject({ channelId: channelKey, participantId: channelKey }), envelope.payload);
        if (envelope.operation !== "receipt" || envelope.pairId !== generation ||
          payload.channelId !== input.channelId || payload.participantId !== participantId) channelFail("PEER_HINT_FORBIDDEN");
        for (const fn of [...(waiters.get(sessionKey) ?? [])]) fn();
      },
      read(args: unknown) { const request = parse(channelRead, args); connected(request); return read(context, generation, request); },
      wait(args: unknown, signal?: AbortSignal) { const request = parse(channelWait, args); connected(request); return wait(context, generation, participantId, connectionId, request, signal); },
      send: (args: unknown) => send(args), assign: (args: unknown) => send(args, true),
      update: (args: unknown) => update(args), reply: (args: unknown) => update(args, true),
      replyAndWait(args: unknown, waitArgs: unknown, signal?: AbortSignal) {
        const request = parse(channelReply, args), next = parse(channelWait, waitArgs);
        connected(request); connected(next);
        if (next.afterSeq !== undefined && next.afterSeq !== request.afterSeq) channelFail("INVALID_CURSOR");
        const receipt = update(request, true);
        return { receipt, waiting: wait(context, generation, participantId, connectionId, { ...next, afterSeq: request.afterSeq }, signal) };
      },
      ack(args: unknown) {
        const request = parse(channelAck, args); connected(request);
        return mutate(context, "ack", request, room => {
          const member = currentChannelMember(room, context, now(), generation);
          if (request.throughSeq < member.cursor || request.throughSeq > member.lastSeq) channelFail("INVALID_CURSOR");
          member.cursor = request.throughSeq;
          return { cursor: member.cursor, state: member.state };
        }, memberAuthorization(context, generation));
      },
      disconnect() {
        disconnected = true;
        if (sessions.get(sessionKey)?.connectionId === connectionId) sessions.delete(sessionKey);
        for (const cancel of [...(sessionCancels.get(connectionId) ?? [])]) cancel("CONNECTION_UNAVAILABLE");
      },
    };
    return client;
  }
  return {
    connect,
    nativeCreate(token: object, args: unknown) {
      const context = actor(token), input = parse(createSchema, args);
      human(context, "create", input.channelId);
      const fingerprint = channelHash({ context, action: "create", input });
      return atomic(() => {
        if (input.expectedRevision !== 0 || input.expiresAt <= now()) channelFail("INVALID_ARGUMENT");
        const existing = db.prepare("SELECT * FROM channel_runtime_receipts WHERE operation_id=?").get(input.operationId);
        if (existing) {
          currentChannelMember(load(input.channelId), context, now());
          if (existing.fingerprint !== fingerprint) channelFail("OPERATION_CONFLICT");
          return JSON.parse(existing.record as string) as MutationResult;
        }
        synchronous(host.claimReceipt(input.operationId, fingerprint, context.actorId, "channel.runtime.create"));
        if (Number(db.prepare("SELECT COUNT(*) AS count FROM channel_runtime_receipts").get()!.count) >= 100_000) channelFail("RECEIPT_LIMIT");
        if (db.prepare("SELECT channel_id FROM channel_runtime_rooms WHERE channel_id=?").get(input.channelId)) channelFail("CHANNEL_EXISTS");
        if (Number(db.prepare("SELECT COUNT(*) AS count FROM channel_runtime_rooms").get()!.count) >= 1000) channelFail("CHANNEL_LIMIT");
        const room: ChannelRecord = { schema: "pkm.channel.runtime/v1", channelId: input.channelId, revision: 1, closed: false,
          invitations: [], messages: [], deliveries: [], members: [{ participantId: input.participantId, actor: context, generation: randomUUID(),
            role: "manager", expiresAt: input.expiresAt, revoked: false, state: "available", cursor: 0, lastSeq: 0, floor: 0 }] };
        const result = { channelId: room.channelId, revision: 1 };
        db.prepare("INSERT INTO channel_runtime_rooms VALUES(?,?,?)").run(room.channelId, 1, JSON.stringify(room));
        db.prepare("INSERT INTO channel_runtime_receipts VALUES(?,?,?,?,?)").run(input.operationId, context.actorId, room.channelId, fingerprint, JSON.stringify(result));
        return result;
      });
    },
    nativeInviteCreate(token: object, args: unknown) {
      const context = actor(token), input = parse(inviteSchema, args);
      human(context, "invite", input.channelId);
      const tokenValue = randomBytes(32).toString("base64url");
      let issued = false;
      const result = mutate(context, "invite", input, room => {
        if (room.invitations.length >= 256 || room.members.length >= 64) channelFail("MEMBERSHIP_LIMIT");
        if (input.expiresAt <= now() || input.memberExpiresAt <= input.expiresAt) channelFail("INVALID_ARGUMENT");
        if (room.members.some(member => member.participantId === input.participantId || !member.revoked && sameChannelActor(member.actor, input.actor))) channelFail("MEMBERSHIP_EXISTS");
        const invitation: ChannelInvitation = { id: randomUUID(), ...input, tokenSha256: channelHash(tokenValue), approved: false, consumed: false };
        // Only invitation schema fields are persisted; operation metadata and plaintext token never enter the aggregate.
        const { id, actor, participantId, role, tokenSha256, expiresAt, memberExpiresAt, approved, consumed } = invitation;
        room.invitations.push({ id, actor, participantId, role, tokenSha256, expiresAt, memberExpiresAt, approved, consumed });
        issued = true;
        return { invitationId: id };
      }, memberAuthorization(context));
      if (!issued) channelFail("INVITATION_ALREADY_ISSUED");
      return { ...result, token: tokenValue };
    },
    nativeHumanApprove(token: object, args: unknown) {
      const context = actor(token), input = parse(approveSchema, args);
      human(context, "approve", input.channelId);
      return mutate(context, "approve", input, room => {
        const invitation = room.invitations.find(item => item.id === input.invitationId);
        if (!invitation || invitation.consumed) channelFail("INVITATION_UNAVAILABLE");
        if (invitation.expiresAt <= now()) channelFail("INVITATION_EXPIRED");
        invitation.approved = true;
        return { invitationId: invitation.id };
      }, memberAuthorization(context));
    },
    accept(token: object, args: unknown) {
      const context = actor(token), input = parse(channelAccept, args);
      return mutate(context, "accept", input, room => {
        const invitation = room.invitations.find(item => item.id === input.invitationId)!;
        if (invitation.consumed) channelFail("INVITATION_CONSUMED");
        if (room.members.some(member => member.participantId === invitation.participantId || !member.revoked && sameChannelActor(member.actor, context))) channelFail("MEMBERSHIP_EXISTS");
        room.members.push({ participantId: invitation.participantId, actor: context, generation: randomUUID(), role: invitation.role,
          expiresAt: invitation.memberExpiresAt, revoked: false, state: "available", cursor: 0, lastSeq: 0, floor: 0 });
        invitation.consumed = true;
        return {};
      }, room => {
        if (room.closed) channelFail("CHANNEL_UNAVAILABLE");
        const invitation = room.invitations.find(item => item.id === input.invitationId);
        if (!invitation || !sameChannelActor(invitation.actor, context)) channelFail("INVITATION_FORBIDDEN");
        const supplied = Buffer.from(channelHash(input.token), "hex"), expected = Buffer.from(invitation.tokenSha256, "hex");
        if (!timingSafeEqual(supplied, expected)) channelFail("INVITATION_FORBIDDEN");
        if (invitation.expiresAt <= now() || invitation.memberExpiresAt <= now()) channelFail("INVITATION_EXPIRED");
        if (!invitation.approved) channelFail("HUMAN_APPROVAL_REQUIRED");
        const member = room.members.find(item => !item.revoked && sameChannelActor(item.actor, context));
        if (invitation.consumed && (!member || member.participantId !== invitation.participantId)) channelFail("FORBIDDEN");
        if (member) currentChannelMember(room, context, now());
      });
    },
    nativeRevoke(token: object, args: unknown) {
      const context = actor(token), input = parse(revokeSchema, args);
      human(context, "revoke", input.channelId);
      const result = mutate(context, "revoke", input, room => {
        const member = room.members.find(item => item.participantId === input.participantId);
        if (!member) channelFail("NOT_FOUND");
        member.revoked = true;
        return {};
      }, memberAuthorization(context));
      sessions.delete(key(input.channelId, input.participantId));
      wake(input.channelId, input.participantId);
      return result;
    },
    nativeClose(token: object, args: unknown) {
      const context = actor(token), input = parse(nativeMutation, args);
      human(context, "close", input.channelId);
      const result = mutate(context, "close", input, room => { room.closed = true; return {}; }, memberAuthorization(context));
      for (const member of load(input.channelId).members) { sessions.delete(key(input.channelId, member.participantId)); wake(input.channelId, member.participantId); }
      return result;
    },
    /** Parent-controlled retention only; an old cursor fails explicitly instead of silently skipping history. */
    nativeCompact(token: object, args: unknown) {
      const context = actor(token), input = parse(revokeSchema.extend({ throughSeq: revision }), args);
      human(context, "compact", input.channelId);
      return mutate(context, "compact", input, room => {
        const member = room.members.find(item => item.participantId === input.participantId);
        if (!member || input.throughSeq > member.cursor || input.throughSeq < member.floor) channelFail("INVALID_CURSOR");
        // Task assignments remain available for ownership validation until their reply is committed.
        if (room.deliveries.some(delivery => delivery.recipientId === member.participantId && delivery.seq <= input.throughSeq &&
          !delivery.replied)) channelFail("TASK_DELIVERY_PENDING");
        room.messages = room.messages.filter(message => message.recipientId !== member.participantId || message.seq > input.throughSeq);
        member.floor = input.throughSeq;
        return { cursor: member.cursor };
      }, memberAuthorization(context));
    },
    /** Optional injected transport may deliver only a hint, not claimed sender identity or mailbox contents. */
    notify(input: { channelId: string; participantId: string }) {
      for (const fn of [...(waiters.get(key(input.channelId, input.participantId)) ?? [])]) fn();
    },
    diagnostics() { return { activeWaits: cancellations.size, connections: sessions.size, closed }; },
    dispose() {
      closed = true;
      for (const cancel of [...cancellations]) cancel("CHANNEL_UNAVAILABLE");
      sessions.clear();
    },
    async drain() { if (cancellations.size) channelFail("ACTIVE_WAITS"); },
  };
}
