import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  portalLifecycleConnections, portalLifecycleRead, portalLifecycleRoute, portalLifecycleStatus,
} from "./portal-lifecycle-contracts.js";
import type { ChannelActor } from "./domain/channel-runtime-model.js";

export { portalLifecycleDefinitions } from "./portal-lifecycle-contracts.js";

export const PORTAL_LIFECYCLE_DDL = `
CREATE TABLE IF NOT EXISTS portal_lifecycle_schema(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL);
INSERT OR IGNORE INTO portal_lifecycle_schema VALUES(1,1);
CREATE TABLE IF NOT EXISTS portal_lifecycle_pairs(
  session_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, room_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL, owner_kind TEXT NOT NULL CHECK(owner_kind IN ('human','agent')),
  owner_participant_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','left','revoked')),
  revision INTEGER NOT NULL CHECK(revision > 0), created_at INTEGER NOT NULL,
  UNIQUE(channel_id, session_id));
CREATE TABLE IF NOT EXISTS portal_lifecycle_admissions(
  invitation_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES portal_lifecycle_pairs(session_id),
  actor_id TEXT NOT NULL, actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','agent')),
  participant_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN
    ('awaiting-approval','admitting','approved','accepting','admitted','cancelled','revoked','unknown')),
  meeting_id TEXT, expires_at INTEGER NOT NULL, channel_invitation_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS portal_lifecycle_meetings(
  meeting_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES portal_lifecycle_pairs(session_id),
  room_id TEXT NOT NULL, channel_id TEXT NOT NULL, host_actor_id TEXT NOT NULL,
  title TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','adjourned')),
  revision INTEGER NOT NULL CHECK(revision > 0), started_at INTEGER NOT NULL, ended_at INTEGER);
CREATE TABLE IF NOT EXISTS portal_lifecycle_receipts(
  operation_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, scope_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','complete','unknown')),
  fence INTEGER NOT NULL CHECK(fence > 0), result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)));
`;

export interface PortalLifecycleChannel {
  connect(token: object, input: { channelId: string }): {
    send(input: unknown): unknown;
    read(input: unknown): unknown;
    disconnect(): void;
  };
  nativeInviteCreate(token: object, input: unknown): { invitationId: string; token: string };
  nativeHumanApprove(token: object, input: unknown): unknown;
  accept(token: object, input: unknown): unknown;
  nativeRevoke(token: object, input: unknown): unknown;
}

export interface PortalLifecycleHost {
  resolveActor(token: object): ChannelActor | undefined;
  authorizeHuman(actor: Readonly<ChannelActor>, action: string, scope: string): boolean;
  authorizeRoom(actor: Readonly<ChannelActor>, roomId: string, action: string): boolean;
  assertLease(): void;
  transaction<T>(work: () => T): T;
  claimReceipt(operationId: string, fingerprint: string, actorId: string, operation: string): void;
  channel?: PortalLifecycleChannel;
  resolveChannelOwnerToken?(sessionId: string): object | undefined;
  now?: () => number;
}

export interface PortalLifecycleHostOptions extends Partial<PortalLifecycleHost> {}

export function createPortalLifecycleHost(options: PortalLifecycleHostOptions = {}): PortalLifecycleHost {
  return {
    resolveActor: options.resolveActor ?? (() => undefined),
    authorizeHuman: options.authorizeHuman ?? (() => false),
    authorizeRoom: options.authorizeRoom ?? (() => false),
    assertLease: options.assertLease ?? (() => portalFail("HOST_UNAVAILABLE")),
    transaction: options.transaction ?? (() => portalFail("HOST_UNAVAILABLE")),
    claimReceipt: options.claimReceipt ?? (() => portalFail("HOST_UNAVAILABLE")),
    ...(options.channel ? { channel: options.channel } : {}),
    ...(options.resolveChannelOwnerToken ? { resolveChannelOwnerToken: options.resolveChannelOwnerToken } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
}

export class PortalLifecycleError extends Error {
  constructor(readonly code: string, message = code) { super(message); }
}

function portalFail(code: string): never { throw new PortalLifecycleError(code); }
const actorSchema = z.strictObject({ actorId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/), kind: z.enum(["human", "agent"]) });
const uuid = z.string().uuid();
const admissionRequest = z.strictObject({
  operationId: uuid, sessionId: uuid, expectedRevision: z.number().int().safe().positive(),
  expiresAt: z.number().int().safe().positive(), meetingId: uuid.optional(),
});
const admissionMutation = z.strictObject({
  operationId: uuid, sessionId: uuid, invitationId: uuid, expectedRevision: z.number().int().safe().positive(),
});
const approveInput = admissionMutation.extend({
  expiresAt: z.number().int().safe().positive(), memberExpiresAt: z.number().int().safe().positive(),
});
const acceptInput = admissionMutation.extend({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const meetingStartInput = z.strictObject({
  operationId: uuid, sessionId: uuid, expectedRevision: z.number().int().safe().positive(),
  meetingId: uuid, title: z.string().trim().min(1).max(200),
});
const meetingMutation = z.strictObject({
  operationId: uuid, sessionId: uuid, meetingId: uuid, expectedRevision: z.number().int().safe().positive(),
});
const supportMatrix = Object.freeze({
  originalPortalControlOperations: Object.freeze([
    { operation: "open", native: "openExisting", status: "qualified", limit: "Binds an already-existing native Channel and collaboration room; no endpoint discovery or spawn." },
    { operation: "connections", native: "connections", status: "qualified", limit: "Only native persisted pairing projections; no external endpoint inventory." },
    { operation: "status", native: "status", status: "qualified", limit: "Durable local status; restart never reconnects automatically." },
    { operation: "send", native: "route", status: "qualified", limit: "One directed Channel message with the existing Channel ACL/receipt." },
    { operation: "command", native: null, status: "unsupported", limit: "External process execution is unavailable." },
    { operation: "route", native: "route", status: "qualified", limit: "Exact participant only; caller cannot attest identity or bypass directed ACL." },
    { operation: "get", native: null, status: "unsupported", limit: "Original remote task receipts are not imported or restored." },
    { operation: "attempts", native: null, status: "unsupported", limit: "Original remote execution history is unavailable." },
    { operation: "cancel", native: "cancelAdmission", status: "qualified", limit: "Only an admission still awaiting human approval; issued Channel invitations cannot be cancelled by this slice." },
    { operation: "disconnect", native: "leave", status: "qualified", limit: "Explicit trusted-host revocation of one admitted participant; no reconnect grace." },
    { operation: "switch", native: "transfer", status: "qualified", limit: "Revokes the old participant and creates a fresh pending admission; no seamless peer swap." },
    { operation: "permissions", native: "hostPolicy", status: "unsupported", limit: "Injected policy guards operations; this slice cannot manage durable Portal grants." },
    { operation: "files", native: null, status: "unsupported", limit: "External file transfer is unavailable." },
  ]),
  meetingLifecycle: Object.freeze({
    qualified: ["start", "adjourn"],
    unsupported: ["topics", "markdown", "schedule", "trash", "restore", "permanent-delete", "session-spawn"],
    limit: "Native lifecycle projection is linked to an existing collaboration room; it does not write the legacy room projection.",
  }),
});

export { supportMatrix as PORTAL_LIFECYCLE_SUPPORT };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function childOperationId(operationId: string, phase: string): string {
  const bytes = createHash("sha256").update(`pkm.portal.lifecycle/v1\0${operationId}\0${phase}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) portalFail("INVALID_ARGUMENT");
  return parsed.data;
}

export function initializePortalLifecycleSchema(db: DatabaseSync): void {
  if (!db.isTransaction) portalFail("TRANSACTION_REQUIRED");
  db.exec(PORTAL_LIFECYCLE_DDL);
  if (db.prepare("SELECT version FROM portal_lifecycle_schema WHERE singleton=1").get()?.version !== 1) {
    portalFail("UNSUPPORTED_SCHEMA");
  }
}

export function inspectPortalLifecycleRecovery(db: DatabaseSync): Array<{
  operationId: string; actorId: string; scopeId: string; status: "pending" | "unknown"; fence: number;
}> {
  return db.prepare(`SELECT operation_id,actor_id,scope_id,status,fence FROM portal_lifecycle_receipts
    WHERE status IN ('pending','unknown') ORDER BY operation_id`).all()
    .map(row => ({
      operationId: row.operation_id as string, actorId: row.actor_id as string, scopeId: row.scope_id as string,
      status: row.status as "pending" | "unknown", fence: row.fence as number,
    }));
}

export function createPortalLifecycleRuntime(db: DatabaseSync, host: PortalLifecycleHost) {
  const now = host.now ?? Date.now;
  const admittedSessions = new Map<string, { read(input: unknown): unknown; disconnect(): void }>();
  let closed = false;
  const parseActor = (token: object): ChannelActor => {
    if (closed) portalFail("PORTAL_UNAVAILABLE");
    if (!token || typeof token !== "object") portalFail("UNAUTHORIZED");
    sync(host.assertLease());
    const resolved = host.resolveActor(token);
    if (!resolved) portalFail("UNAUTHORIZED");
    return Object.freeze(parse(actorSchema, resolved));
  };
  const sync = (value: unknown) => {
    if (value && typeof (value as { then?: unknown }).then === "function") portalFail("ASYNC_HOST_HOOK");
  };
  const atomic = <T>(work: () => T): T => {
    if (closed || db.isTransaction) portalFail(closed ? "PORTAL_UNAVAILABLE" : "TRANSACTION_BOUNDARY");
    sync(host.assertLease());
    const result = host.transaction(() => {
      if (!db.isTransaction) portalFail("TRANSACTION_REQUIRED");
      sync(host.assertLease());
      const value = work();
      if (value && typeof (value as { then?: unknown }).then === "function") portalFail("ASYNC_TRANSACTION");
      sync(host.assertLease());
      return value;
    });
    sync(result);
    if (db.isTransaction) portalFail("TRANSACTION_BOUNDARY");
    return result;
  };
  const human = (actor: ChannelActor, action: string, scope: string) => {
    if (actor.kind !== "human" || host.authorizeHuman(actor, action, scope) !== true) portalFail("HUMAN_AUTHORITY_REQUIRED");
  };
  const assertRoom = (actor: ChannelActor, roomId: string, action: string) => {
    if (host.authorizeRoom(actor, roomId, action) !== true) portalFail("ROOM_AUTHORITY_REQUIRED");
    const room = db.prepare("SELECT state_json FROM collaboration_rooms WHERE room_id=?").get(roomId);
    if (!room) portalFail("ROOM_NOT_FOUND");
    const record = JSON.parse(room.state_json as string) as {
      status?: string; ownerParticipantId?: string; members?: Array<{ actorId: string; kind: string; participantId: string; present: boolean }>;
    };
    const member = record.members?.find(item => item.actorId === actor.actorId && item.kind === actor.kind && item.present);
    if (record.status !== "active" || !member) portalFail("ROOM_AUTHORITY_REQUIRED");
    return { ownerParticipantId: record.ownerParticipantId, participantId: member.participantId };
  };
  const channel = () => {
    if (!host.channel) portalFail("CHANNEL_UNAVAILABLE");
    return host.channel;
  };
  const pair = (sessionId: string) => {
    const row = db.prepare("SELECT * FROM portal_lifecycle_pairs WHERE session_id=?").get(sessionId);
    if (!row) portalFail("NOT_FOUND");
    return row;
  };
  const receipt = (operationId: string, actor: ChannelActor, scopeId: string, fingerprint: string) => {
    const prior = db.prepare("SELECT * FROM portal_lifecycle_receipts WHERE operation_id=?").get(operationId);
    if (prior) {
      if (prior.actor_id !== actor.actorId || prior.scope_id !== scopeId || prior.fingerprint !== fingerprint) portalFail("OPERATION_CONFLICT");
      if (prior.status !== "complete") portalFail("OUTCOME_UNKNOWN");
      return JSON.parse(prior.result_json as string) as unknown;
    }
    sync(host.claimReceipt(operationId, fingerprint, actor.actorId, "portal.lifecycle"));
    return undefined;
  };
  const beginEffect = (actor: ChannelActor, scopeId: string, operationId: string, fingerprint: string, expectedRevision: number,
    admissionId: string, nextAdmissionState: "admitting" | "accepting" | "unknown",
    allowedStates: readonly string[] = ["awaiting-approval", "approved"]): { session: ReturnType<typeof pair>; replay?: unknown } => atomic(() => {
    const prior = receipt(operationId, actor, scopeId, fingerprint);
    if (prior !== undefined) return { session: pair(scopeId), replay: prior };
    const current = pair(scopeId);
    if (current.revision !== expectedRevision || current.state !== "active") portalFail("REVISION_CONFLICT");
    const admission = db.prepare("SELECT state FROM portal_lifecycle_admissions WHERE invitation_id=? AND session_id=?")
      .get(admissionId, scopeId);
    if (!admission) portalFail("INVITATION_NOT_FOUND");
    if (!allowedStates.includes(admission.state as string)) portalFail("INVITATION_UNAVAILABLE");
    const fence = (current.revision as number) + 1;
    db.prepare("UPDATE portal_lifecycle_pairs SET revision=? WHERE session_id=? AND revision=?")
      .run(fence, scopeId, current.revision);
    db.prepare("UPDATE portal_lifecycle_admissions SET state=?,updated_at=? WHERE invitation_id=?")
      .run(nextAdmissionState, now(), admissionId);
    db.prepare("INSERT INTO portal_lifecycle_receipts VALUES(?,?,?,?,?,?,NULL)")
      .run(operationId, actor.actorId, scopeId, fingerprint, "pending", fence);
    return { session: pair(scopeId) };
  });
  const finishEffect = (operationId: string, sessionId: string, result: unknown, admissionId: string, state: string,
    channelInvitationId?: string) => atomic(() => {
    const current = pair(sessionId);
    const pending = db.prepare(`SELECT fence FROM portal_lifecycle_receipts
      WHERE operation_id=? AND scope_id=? AND status='pending'`).get(operationId, sessionId);
    if (!pending) portalFail("OUTCOME_UNKNOWN");
    const admissionUpdated = db.prepare(`UPDATE portal_lifecycle_admissions
      SET state=?,channel_invitation_id=COALESCE(?,channel_invitation_id),updated_at=?
      WHERE invitation_id=? AND session_id=? AND state IN ('admitting','accepting')`)
      .run(state, channelInvitationId ?? null, now(), admissionId, sessionId);
    if (admissionUpdated.changes !== 1) portalFail("OUTCOME_UNKNOWN");
    const fence = (current.revision as number) + 1;
    if (db.prepare("UPDATE portal_lifecycle_pairs SET revision=? WHERE session_id=? AND revision=?")
      .run(fence, sessionId, current.revision).changes !== 1) portalFail("REVISION_CONFLICT");
    if (db.prepare("UPDATE portal_lifecycle_receipts SET status='complete',fence=?,result_json=? WHERE operation_id=? AND status='pending' AND fence=?")
      .run(fence, JSON.stringify(result), operationId, pending.fence).changes !== 1) portalFail("OUTCOME_UNKNOWN");
    return result;
  });
  const markUnknown = (operationId: string, sessionId: string, admissionId: string) => atomic(() => {
    const current = pair(sessionId), fence = (current.revision as number) + 1;
    db.prepare("UPDATE portal_lifecycle_admissions SET state='unknown',updated_at=? WHERE invitation_id=?")
      .run(now(), admissionId);
    db.prepare("UPDATE portal_lifecycle_pairs SET revision=? WHERE session_id=? AND revision=?")
      .run(fence, sessionId, current.revision);
    db.prepare("UPDATE portal_lifecycle_receipts SET status='unknown',fence=? WHERE operation_id=? AND status='pending'")
      .run(fence, operationId);
  });
  const sessionActorRole = (sessionId: string, actor: ChannelActor): { row: ReturnType<typeof pair>; participantId: string; owner: boolean } => {
    const row = pair(sessionId);
    if (row.state !== "active") portalFail("PAIRING_UNAVAILABLE");
    if (row.owner_actor_id === actor.actorId && row.owner_kind === actor.kind) {
      return { row, participantId: row.owner_participant_id as string, owner: true };
    }
    const admission = db.prepare(`SELECT participant_id,state FROM portal_lifecycle_admissions
      WHERE session_id=? AND actor_id=? AND actor_kind=? ORDER BY created_at DESC,rowid DESC LIMIT 1`)
      .get(sessionId, actor.actorId, actor.kind);
    if (!admission || admission.state !== "admitted") portalFail("FORBIDDEN");
    return { row, participantId: admission.participant_id as string, owner: false };
  };
  const admittedSessionKey = (sessionId: string, actor: ChannelActor) => `${sessionId}\0${actor.actorId}\0${actor.kind}`;

  function openExisting(ownerToken: object, args: unknown) {
    const actor = parseActor(ownerToken);
    const input = parse(z.strictObject({ operationId: uuid, channelId: z.string().min(1).max(128), roomId: z.string().min(1).max(120) }), args);
    human(actor, "portal.open", input.roomId);
    const roomActor = assertRoom(actor, input.roomId, "portal.open");
    const channelRow = db.prepare("SELECT record FROM channel_runtime_rooms WHERE channel_id=?").get(input.channelId);
    if (!channelRow) portalFail("CHANNEL_NOT_FOUND");
    const record = JSON.parse(channelRow.record as string) as {
      closed?: boolean; members?: Array<{ actor: ChannelActor; participantId: string; role: string; revoked: boolean; expiresAt: number }>;
    };
    const ownerMember = record.members?.find(item => item.actor.actorId === actor.actorId && item.actor.kind === actor.kind
      && item.role === "manager");
    if (roomActor.ownerParticipantId !== roomActor.participantId) portalFail("ROOM_OWNER_REQUIRED");
    if (record.closed || !ownerMember || ownerMember.revoked || ownerMember.expiresAt <= now()) portalFail("CHANNEL_AUTHORITY_REQUIRED");
    const fingerprint = hash({ actor, action: "open", input });
    return atomic(() => {
      const replay = receipt(input.operationId, actor, input.channelId, fingerprint);
      if (replay !== undefined) return replay;
      const sessionId = childOperationId(input.operationId, "session");
      const createdAt = now();
      db.prepare(`INSERT INTO portal_lifecycle_pairs VALUES(?,?,?,?,?,?,?,1,?)`)
        .run(sessionId, input.channelId, input.roomId, actor.actorId, actor.kind, ownerMember.participantId, "active", createdAt);
      const result = { sessionId, channelId: input.channelId, roomId: input.roomId, revision: 1, state: "active" };
      db.prepare("INSERT INTO portal_lifecycle_receipts VALUES(?,?,?,?,?,?,?)")
        .run(input.operationId, actor.actorId, input.channelId, fingerprint, "complete", 1, JSON.stringify(result));
      return result;
    });
  }

  function requestAdmission(ownerToken: object, invitedToken: object, args: unknown) {
    const actor = parseActor(ownerToken), invited = parseActor(invitedToken), input = parse(admissionRequest, args);
    human(actor, "portal.invite", input.sessionId);
    const current = pair(input.sessionId);
    if (current.owner_actor_id !== actor.actorId || current.owner_kind !== actor.kind) portalFail("FORBIDDEN");
    assertRoom(actor, current.room_id as string, "portal.invite");
    if (invited.actorId === actor.actorId && invited.kind === actor.kind) portalFail("SELF_INVITATION");
    if (input.expiresAt <= now() || input.expiresAt > now() + 10 * 60_000) portalFail("INVALID_EXPIRATION");
    if (input.meetingId) {
      const meeting = db.prepare("SELECT status FROM portal_lifecycle_meetings WHERE meeting_id=? AND session_id=?")
        .get(input.meetingId, input.sessionId);
      if (!meeting || meeting.status !== "active") portalFail("MEETING_UNAVAILABLE");
    }
    const invitationId = childOperationId(input.operationId, "admission");
    const participantId = `peer-${invitationId}`;
    const fingerprint = hash({ actor, invited, action: "request-admission", input });
    return atomic(() => {
      const replay = receipt(input.operationId, actor, input.sessionId, fingerprint);
      if (replay !== undefined) return replay;
      const session = pair(input.sessionId);
      if (session.revision !== input.expectedRevision || session.state !== "active") portalFail("REVISION_CONFLICT");
      const existing = db.prepare(`SELECT invitation_id FROM portal_lifecycle_admissions
        WHERE session_id=? AND actor_id=? AND actor_kind=? AND state IN ('awaiting-approval','admitting','approved','accepting','admitted')`)
        .get(input.sessionId, invited.actorId, invited.kind);
      if (existing) portalFail("ADMISSION_ALREADY_EXISTS");
      const fence = (session.revision as number) + 1;
      db.prepare("UPDATE portal_lifecycle_pairs SET revision=? WHERE session_id=? AND revision=?")
        .run(fence, input.sessionId, session.revision);
      db.prepare(`INSERT INTO portal_lifecycle_admissions VALUES(?,?,?,?,?,'awaiting-approval',?,?,NULL,?,?)`)
        .run(invitationId, input.sessionId, invited.actorId, invited.kind, participantId, input.meetingId ?? null, input.expiresAt, now(), now());
      const result = { invitationId, sessionId: input.sessionId, revision: fence, state: "awaiting-approval" };
      db.prepare("INSERT INTO portal_lifecycle_receipts VALUES(?,?,?,?,?,?,?)")
        .run(input.operationId, actor.actorId, input.sessionId, fingerprint, "complete", fence, JSON.stringify(result));
      return result;
    });
  }

  function cancelAdmission(ownerToken: object, args: unknown) {
    const actor = parseActor(ownerToken), input = parse(admissionMutation, args);
    human(actor, "portal.cancel-admission", input.sessionId);
    assertRoom(actor, pair(input.sessionId).room_id as string, "portal.cancel-admission");
    const fingerprint = hash({ actor, action: "cancel-admission", input });
    return atomic(() => {
      const replay = receipt(input.operationId, actor, input.sessionId, fingerprint);
      if (replay !== undefined) return replay;
      const session = pair(input.sessionId);
      if (session.owner_actor_id !== actor.actorId || session.revision !== input.expectedRevision) portalFail("REVISION_CONFLICT");
      const admission = db.prepare("SELECT state FROM portal_lifecycle_admissions WHERE invitation_id=? AND session_id=?")
        .get(input.invitationId, input.sessionId);
      if (!admission) portalFail("INVITATION_NOT_FOUND");
      if (admission.state !== "awaiting-approval") portalFail("CANNOT_CANCEL_ISSUED_INVITATION");
      const fence = (session.revision as number) + 1;
      db.prepare("UPDATE portal_lifecycle_admissions SET state='cancelled',updated_at=? WHERE invitation_id=?")
        .run(now(), input.invitationId);
      db.prepare("UPDATE portal_lifecycle_pairs SET revision=? WHERE session_id=? AND revision=?")
        .run(fence, input.sessionId, session.revision);
      const result = { invitationId: input.invitationId, sessionId: input.sessionId, revision: fence, state: "cancelled" };
      db.prepare("INSERT INTO portal_lifecycle_receipts VALUES(?,?,?,?,?,?,?)")
        .run(input.operationId, actor.actorId, input.sessionId, fingerprint, "complete", fence, JSON.stringify(result));
      return result;
    });
  }

  function approveAdmission(ownerToken: object, invitedToken: object, args: unknown) {
    const actor = parseActor(ownerToken), invited = parseActor(invitedToken), input = parse(approveInput, args);
    human(actor, "portal.admit", input.sessionId);
    const current = pair(input.sessionId);
    if (current.owner_actor_id !== actor.actorId || current.owner_kind !== actor.kind) portalFail("FORBIDDEN");
    assertRoom(actor, current.room_id as string, "portal.admit");
    const admission = db.prepare("SELECT * FROM portal_lifecycle_admissions WHERE invitation_id=? AND session_id=?")
      .get(input.invitationId, input.sessionId);
    if (admission && ["admitting", "accepting", "unknown"].includes(admission.state as string)) portalFail("OUTCOME_UNKNOWN");
    if (admission?.state === "approved") portalFail("INVITATION_SECRET_NOT_REPLAYED");
    if (!admission || admission.actor_id !== invited.actorId || admission.actor_kind !== invited.kind ||
      admission.state !== "awaiting-approval" || Number(admission.expires_at) <= now()) portalFail("INVITATION_UNAVAILABLE");
    const admissionExpiresAt = Number(admission.expires_at);
    if (input.expiresAt <= now() || input.expiresAt > admissionExpiresAt ||
      input.memberExpiresAt <= input.expiresAt || input.memberExpiresAt > now() + 24 * 60 * 60_000) portalFail("INVALID_EXPIRATION");
    const fingerprint = hash({ actor, invited, action: "approve-admission", input: { ...input, token: undefined } });
    const begun = beginEffect(actor, input.sessionId, input.operationId, fingerprint, input.expectedRevision, input.invitationId, "admitting");
    if (begun.replay !== undefined) portalFail("INVITATION_SECRET_NOT_REPLAYED");
    const native = channel(), child = childOperationId(input.operationId, "channel-invite");
    try {
      const issued = native.nativeInviteCreate(ownerToken, {
        operationId: child, channelId: current.channel_id, expectedRevision: channelRevision(current.channel_id as string),
        actor: invited, participantId: admission.participant_id, role: "worker",
        expiresAt: input.expiresAt, memberExpiresAt: input.memberExpiresAt,
      });
      native.nativeHumanApprove(ownerToken, {
        operationId: childOperationId(input.operationId, "channel-approve"), channelId: current.channel_id,
        expectedRevision: channelRevision(current.channel_id as string), invitationId: issued.invitationId,
      });
      const result = { invitationId: input.invitationId, sessionId: input.sessionId, state: "approved" };
      finishEffect(input.operationId, input.sessionId, result, input.invitationId, "approved", issued.invitationId);
      return { ...result, token: issued.token };
    } catch (error) {
      markUnknown(input.operationId, input.sessionId, input.invitationId);
      portalFail("OUTCOME_UNKNOWN");
    }
  }

  function admit(invitedToken: object, args: unknown) {
    const actor = parseActor(invitedToken), input = parse(acceptInput, args);
    const current = pair(input.sessionId);
    const admission = db.prepare("SELECT * FROM portal_lifecycle_admissions WHERE invitation_id=? AND session_id=?")
      .get(input.invitationId, input.sessionId);
    if (admission?.state === "admitted") {
      const fingerprint = hash({ actor, action: "admit", input: { ...input, token: hash(input.token) } });
      if (db.prepare("SELECT operation_id FROM portal_lifecycle_receipts WHERE operation_id=?").get(input.operationId)) {
        return receipt(input.operationId, actor, input.sessionId, fingerprint);
      }
      portalFail("INVITATION_UNAVAILABLE");
    }
    if (admission && ["admitting", "accepting", "unknown"].includes(admission.state as string)) portalFail("OUTCOME_UNKNOWN");
    if (!admission || admission.actor_id !== actor.actorId || admission.actor_kind !== actor.kind ||
      admission.state !== "approved" || Number(admission.expires_at) <= now()) portalFail("INVITATION_UNAVAILABLE");
    const fingerprint = hash({ actor, action: "admit", input: { ...input, token: hash(input.token) } });
    const begun = beginEffect(actor, input.sessionId, input.operationId, fingerprint, input.expectedRevision, input.invitationId, "accepting");
    if (begun.replay !== undefined) return begun.replay;
    try {
      channel().accept(invitedToken, {
        operationId: childOperationId(input.operationId, "channel-accept"),
        channelId: current.channel_id, expectedRevision: channelRevision(current.channel_id as string),
        invitationId: admission.channel_invitation_id, token: input.token,
      });
      const peerSession = channel().connect(invitedToken, { channelId: current.channel_id as string });
      const result = finishEffect(input.operationId, input.sessionId,
        { invitationId: input.invitationId, sessionId: input.sessionId, state: "admitted" }, input.invitationId, "admitted");
      admittedSessions.set(admittedSessionKey(input.sessionId, actor), peerSession);
      return result;
    } catch {
      markUnknown(input.operationId, input.sessionId, input.invitationId);
      portalFail("OUTCOME_UNKNOWN");
    }
  }

  function revokeAdmission(ownerToken: object, args: unknown, action: "leave" | "revoke" = "revoke") {
    const actor = parseActor(ownerToken), input = parse(admissionMutation, args);
    human(actor, `portal.${action}`, input.sessionId);
    const current = pair(input.sessionId);
    if (current.owner_actor_id !== actor.actorId || current.owner_kind !== actor.kind) portalFail("FORBIDDEN");
    assertRoom(actor, current.room_id as string, `portal.${action}`);
    const fingerprint = hash({ actor, action, input });
    const prior = db.prepare("SELECT operation_id FROM portal_lifecycle_receipts WHERE operation_id=?").get(input.operationId);
    if (prior) return receipt(input.operationId, actor, input.sessionId, fingerprint);
    const admission = db.prepare("SELECT * FROM portal_lifecycle_admissions WHERE invitation_id=? AND session_id=?")
      .get(input.invitationId, input.sessionId);
    if (!admission || admission.state !== "admitted") portalFail("INVITATION_UNAVAILABLE");
    const begun = beginEffect(actor, input.sessionId, input.operationId, fingerprint, input.expectedRevision, input.invitationId,
      "admitting", ["admitted"]);
    if (begun.replay !== undefined) return begun.replay;
    try {
      channel().nativeRevoke(ownerToken, {
        operationId: childOperationId(input.operationId, `channel-${action}`),
        channelId: current.channel_id, expectedRevision: channelRevision(current.channel_id as string),
        participantId: admission.participant_id,
      });
      admittedSessions.get(admittedSessionKey(input.sessionId, {
        actorId: admission.actor_id as string, kind: admission.actor_kind as "human" | "agent",
      }))?.disconnect();
      admittedSessions.delete(admittedSessionKey(input.sessionId, {
        actorId: admission.actor_id as string, kind: admission.actor_kind as "human" | "agent",
      }));
      return finishEffect(input.operationId, input.sessionId,
        { invitationId: input.invitationId, sessionId: input.sessionId, state: "revoked" }, input.invitationId, "revoked");
    } catch {
      markUnknown(input.operationId, input.sessionId, input.invitationId);
      portalFail("OUTCOME_UNKNOWN");
    }
  }

  function transfer(ownerToken: object, invitedToken: object, input: {
    revoke: unknown; invitation: unknown;
  }) {
    const revokeArgs = parse(admissionMutation, input.revoke);
    const old = revokeAdmission(ownerToken, revokeArgs, "revoke");
    const fresh = requestAdmission(ownerToken, invitedToken, input.invitation);
    return { revoked: old, admission: fresh, next: "Human admission approval is required; no peer credentials or task were replayed." };
  }

  function route(token: object, args: unknown) {
    const actor = parseActor(token), input = parse(portalLifecycleRoute, args);
    const fingerprint = hash({ actor, action: "route", input });
    const begun = atomic(() => {
      const context = sessionActorRole(input.sessionId, actor);
      const replay = receipt(input.operationId, actor, input.sessionId, fingerprint);
      if (replay !== undefined) return { replay, channelId: context.row.channel_id as string, fence: 0 };
      if (context.row.revision !== input.expectedRevision) portalFail("REVISION_CONFLICT");
      if (input.meetingId) {
        const meeting = db.prepare("SELECT status FROM portal_lifecycle_meetings WHERE meeting_id=? AND session_id=?")
          .get(input.meetingId, input.sessionId);
        if (!meeting || meeting.status !== "active") portalFail("MEETING_UNAVAILABLE");
      }
      const fence = (context.row.revision as number) + 1;
      if (db.prepare("UPDATE portal_lifecycle_pairs SET revision=? WHERE session_id=? AND revision=?")
        .run(fence, input.sessionId, context.row.revision).changes !== 1) portalFail("REVISION_CONFLICT");
      db.prepare("INSERT INTO portal_lifecycle_receipts VALUES(?,?,?,?,?,?,NULL)")
        .run(input.operationId, actor.actorId, input.sessionId, fingerprint, "pending", fence);
      return { channelId: context.row.channel_id as string, fence };
    });
    if (begun.replay !== undefined) return begun.replay;
    let client: ReturnType<PortalLifecycleChannel["connect"]> | undefined;
    try {
      client = channel().connect(token, { channelId: begun.channelId });
      const result = client.send({
        operationId: childOperationId(input.operationId, "channel-route"),
        channelId: begun.channelId, expectedRevision: channelRevision(begun.channelId),
        recipientId: input.recipientId, text: input.text,
      });
      sync(result);
      return atomic(() => {
        if (db.prepare(`UPDATE portal_lifecycle_receipts SET status='complete',result_json=?
          WHERE operation_id=? AND actor_id=? AND scope_id=? AND fingerprint=? AND status='pending' AND fence=?`)
          .run(JSON.stringify(result), input.operationId, actor.actorId, input.sessionId, fingerprint, begun.fence)
          .changes !== 1) portalFail("OUTCOME_UNKNOWN");
        return result;
      });
    } catch {
      atomic(() => {
        db.prepare(`UPDATE portal_lifecycle_receipts SET status='unknown'
          WHERE operation_id=? AND status='pending' AND fence=?`).run(input.operationId, begun.fence);
      });
      portalFail("OUTCOME_UNKNOWN");
    } finally { client?.disconnect(); }
  }

  function read(token: object, args: unknown) {
    const actor = parseActor(token), input = parse(portalLifecycleRead, args), context = sessionActorRole(input.sessionId, actor);
    const request = { channelId: context.row.channel_id, afterSeq: input.afterSeq, limit: input.limit };
    const existing = admittedSessions.get(admittedSessionKey(input.sessionId, actor));
    if (existing) return existing.read(request);
    const client = channel().connect(token, { channelId: context.row.channel_id as string });
    try { return client.read(request); }
    finally { client.disconnect(); }
  }

  function startMeeting(ownerToken: object, args: unknown) {
    const actor = parseActor(ownerToken), input = parse(meetingStartInput, args), current = pair(input.sessionId);
    human(actor, "meeting.start", input.sessionId);
    if (current.owner_actor_id !== actor.actorId || current.owner_kind !== actor.kind || current.revision !== input.expectedRevision ||
      current.state !== "active") portalFail("REVISION_CONFLICT");
    assertRoom(actor, current.room_id as string, "meeting.start");
    const fingerprint = hash({ actor, action: "meeting.start", input });
    return atomic(() => {
      const replay = receipt(input.operationId, actor, input.sessionId, fingerprint);
      if (replay !== undefined) return replay;
      if (db.prepare("SELECT meeting_id FROM portal_lifecycle_meetings WHERE session_id=? AND status='active'").get(input.sessionId)) {
        portalFail("MEETING_ALREADY_ACTIVE");
      }
      const fence = (current.revision as number) + 1;
      db.prepare(`INSERT INTO portal_lifecycle_meetings VALUES(?,?,?,?,?,?,'active',1,?,NULL)`)
        .run(input.meetingId, input.sessionId, current.room_id, current.channel_id, actor.actorId, input.title, now());
      db.prepare("UPDATE portal_lifecycle_pairs SET revision=? WHERE session_id=? AND revision=?")
        .run(fence, input.sessionId, current.revision);
      const result = { meetingId: input.meetingId, sessionId: input.sessionId, title: input.title, status: "active", revision: fence };
      db.prepare("INSERT INTO portal_lifecycle_receipts VALUES(?,?,?,?,?,?,?)")
        .run(input.operationId, actor.actorId, input.sessionId, fingerprint, "complete", fence, JSON.stringify(result));
      return result;
    });
  }

  function adjournMeeting(ownerToken: object, args: unknown) {
    const actor = parseActor(ownerToken), input = parse(meetingMutation, args), current = pair(input.sessionId);
    human(actor, "meeting.adjourn", input.sessionId);
    assertRoom(actor, current.room_id as string, "meeting.adjourn");
    const fingerprint = hash({ actor, action: "meeting.adjourn", input });
    return atomic(() => {
      const replay = receipt(input.operationId, actor, input.sessionId, fingerprint);
      if (replay !== undefined) return replay;
      if (current.owner_actor_id !== actor.actorId || current.owner_kind !== actor.kind ||
        current.revision !== input.expectedRevision || current.state !== "active") portalFail("REVISION_CONFLICT");
      const meeting = db.prepare("SELECT status,revision FROM portal_lifecycle_meetings WHERE meeting_id=? AND session_id=?")
        .get(input.meetingId, input.sessionId);
      if (!meeting || meeting.status !== "active") portalFail("MEETING_UNAVAILABLE");
      const fence = (current.revision as number) + 1;
      const meetingRevision = (meeting.revision as number) + 1;
      db.prepare(`UPDATE portal_lifecycle_meetings SET status='adjourned',revision=?,ended_at=?
        WHERE meeting_id=? AND revision=?`).run(meetingRevision, now(), input.meetingId, meeting.revision);
      db.prepare("UPDATE portal_lifecycle_pairs SET revision=? WHERE session_id=? AND revision=?")
        .run(fence, input.sessionId, current.revision);
      const result = { meetingId: input.meetingId, sessionId: input.sessionId, status: "adjourned", revision: fence };
      db.prepare("INSERT INTO portal_lifecycle_receipts VALUES(?,?,?,?,?,?,?)")
        .run(input.operationId, actor.actorId, input.sessionId, fingerprint, "complete", fence, JSON.stringify(result));
      return result;
    });
  }

  function status(token: object, args: unknown) {
    const actor = parseActor(token), input = parse(portalLifecycleStatus, args);
    const context = sessionActorRole(input.sessionId, actor);
    const meetings = db.prepare("SELECT meeting_id,title,status,revision,started_at,ended_at FROM portal_lifecycle_meetings WHERE session_id=? ORDER BY started_at")
      .all(input.sessionId);
    const admissions = db.prepare(`SELECT invitation_id,actor_id,actor_kind,participant_id,state,meeting_id,expires_at
      FROM portal_lifecycle_admissions WHERE session_id=? ORDER BY created_at,rowid`).all(input.sessionId)
      .filter(row => context.owner || row.actor_id === actor.actorId && row.actor_kind === actor.kind);
    return {
      sessionId: input.sessionId, channelId: context.row.channel_id, roomId: context.row.room_id,
      revision: context.row.revision, state: context.row.state,
      connected: admittedSessions.has(admittedSessionKey(input.sessionId, actor)),
      meetings: meetings.map(row => ({ meetingId: row.meeting_id, title: row.title, status: row.status,
        revision: row.revision, startedAt: row.started_at, ...(row.ended_at === null ? {} : { endedAt: row.ended_at }) })),
      admissions: admissions.map(row => ({ invitationId: row.invitation_id, actorId: row.actor_id, kind: row.actor_kind,
        participantId: row.participant_id, state: row.state,
        ...(row.meeting_id === null ? {} : { meetingId: row.meeting_id }), expiresAt: row.expires_at })),
      recovery: inspectPortalLifecycleRecovery(db).filter(row => row.scopeId === input.sessionId),
    };
  }

  function connections(token: object, args: unknown = {}) {
    const actor = parseActor(token), input = parse(portalLifecycleConnections, args);
    const rows = db.prepare(`SELECT DISTINCT p.session_id,p.channel_id,p.room_id,p.state,p.revision,p.created_at
      FROM portal_lifecycle_pairs p LEFT JOIN portal_lifecycle_admissions a ON a.session_id=p.session_id
      WHERE (p.owner_actor_id=? AND p.owner_kind=?) OR (a.actor_id=? AND a.actor_kind=? AND a.state='admitted')
      ORDER BY p.created_at DESC`).all(actor.actorId, actor.kind, actor.actorId, actor.kind);
    return { items: rows.slice(input.offset, input.offset + input.limit).map(row => ({
      sessionId: row.session_id, channelId: row.channel_id, roomId: row.room_id,
      state: row.state, revision: row.revision, createdAt: row.created_at,
      connected: admittedSessions.has(admittedSessionKey(row.session_id as string, actor)),
    })), total: rows.length };
  }

  function leave(token: object, args: unknown) {
    const actor = parseActor(token), input = parse(admissionMutation, args);
    const admission = readAdmission(input.sessionId, input.invitationId);
    if (admission.actor_id !== actor.actorId || admission.actor_kind !== actor.kind || admission.state !== "admitted") {
      portalFail("FORBIDDEN");
    }
    const ownerToken = host.resolveChannelOwnerToken?.(input.sessionId);
    if (!ownerToken) portalFail("HOST_AUTHORITY_UNAVAILABLE");
    const owner = parseActor(ownerToken), current = pair(input.sessionId);
    if (current.owner_actor_id !== owner.actorId || current.owner_kind !== owner.kind) portalFail("HOST_AUTHORITY_UNAVAILABLE");
    human(owner, "portal.leave", input.invitationId);
    return revokeAdmission(ownerToken, input, "leave");
  }

  function dispose() {
    closed = true;
    for (const session of admittedSessions.values()) session.disconnect();
    admittedSessions.clear();
  }
  function unsupported(operation: string): never {
    if (!supportMatrix.originalPortalControlOperations.some(item => item.operation === operation)) portalFail("INVALID_OPERATION");
    portalFail("UNSUPPORTED_OPERATION");
  }
  function channelRevision(channelId: string): number {
    const row = db.prepare("SELECT revision FROM channel_runtime_rooms WHERE channel_id=?").get(channelId);
    if (!row) portalFail("CHANNEL_NOT_FOUND");
    return row.revision as number;
  }
  function readAdmission(sessionId: string, invitationId: string) {
    const row = db.prepare("SELECT * FROM portal_lifecycle_admissions WHERE invitation_id=? AND session_id=?")
      .get(invitationId, sessionId);
    if (!row) portalFail("INVITATION_NOT_FOUND");
    return row;
  }

  return {
    openExisting,
    requestAdmission,
    cancelAdmission,
    approveAdmission,
    admit,
    route,
    read,
    leave,
    revoke: (token: object, args: unknown) => revokeAdmission(token, args, "revoke"),
    transfer,
    startMeeting,
    adjournMeeting,
    connections,
    status,
    unsupported,
    inspectRecovery: () => inspectPortalLifecycleRecovery(db),
    dispose,
    diagnostics: () => ({ closed }),
    readAdmission,
  };
}
