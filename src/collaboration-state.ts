import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { collaborationId, collaborationMutation } from "./collaboration-state-contracts.js";
import { allMentionNames } from "./domain/collaboration-state-mentions.js";
import {
  createCollaborationTask, transitionCollaborationTask,
  type CollaborationTaskRecord, type CollaborationTransition,
} from "./domain/collaboration-state-model.js";

export { collaborationStateDefinitions } from "./collaboration-state-contracts.js";

export const COLLABORATION_STATE_DDL = `
CREATE TABLE IF NOT EXISTS collaboration_rooms (
  room_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json))
) STRICT;
CREATE TABLE IF NOT EXISTS collaboration_receipts (
  operation_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  room_id TEXT NOT NULL REFERENCES collaboration_rooms(room_id),
  request_sha256 TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json))
) STRICT;
`;
export const COLLABORATION_STATE_LIMITS = Object.freeze({
  rooms: 1000, members: 64, messages: 5000, tasks: 64,
  aggregateBytes: 2 * 1024 * 1024, receiptsPerRoom: 10_000,
});
export class CollaborationStateError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export interface CollaborationActor { actorId: string; kind: "human" | "agent" | "browser" }
export interface CollaborationMember extends CollaborationActor {
  participantId: string; alias: string; present: boolean; muted: boolean;
}
export interface CollaborationMessage {
  id: string; fromId: string; from: string; kind: CollaborationActor["kind"];
  text: string; ts: number; recipients: string[]; replyPolicy: "none" | "required" | "optional";
  mode?: "announce" | "ask" | "discuss";
}
export interface CollaborationMeeting {
  id: string; host: string; lead: string; triggerMessageId: string;
  status: "active" | "adjourned"; phase: "discussion" | "adjourned";
  revision: number; startedAt: string; endedAt?: string;
}
export interface CollaborationRoom {
  roomId: string; name: string; revision: number; ownerParticipantId: string;
  status: "active" | "closed"; members: CollaborationMember[];
  messages: CollaborationMessage[]; tasks: CollaborationTaskRecord[]; meeting: CollaborationMeeting | null;
}
export interface CollaborationMutation { operationId: string; roomId: string; expectedRevision: number }
export interface CollaborationStoreOptions {
  now?: () => number;
  initializeSchema?: boolean;
  /** Out-of-band human consent adapter, not an input flag or an invitation API. Default deny. */
  authorizeHuman?: (actor: Readonly<CollaborationActor>, action: string, roomId: string) => boolean;
}
function fail(code: string, message: string): never { throw new CollaborationStateError(code, message); }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail("INVALID_ARGUMENT", parsed.error.message);
  return parsed.data;
}
function member(room: CollaborationRoom, actor: CollaborationActor, present = true): CollaborationMember {
  const found = room.members.find(item => item.actorId === actor.actorId && item.kind === actor.kind);
  if (!found || (present && !found.present)) fail("FORBIDDEN", "The trusted actor is not a current Room participant.");
  return found;
}
function summary(room: CollaborationRoom) {
  const { roomId, name, revision, ownerParticipantId, status } = room;
  return { roomId, name, revision, ownerParticipantId, status };
}
const alias = z.string().trim().min(1).max(60).refine(value => !/[\x00-\x1f]/.test(value), "Invalid alias");
const createInput = z.strictObject({
  operationId: z.string().uuid(), roomId: collaborationId, name: z.string().trim().min(1).max(200), alias,
});
const joinInput = collaborationMutation.extend({ alias });
const postInput = collaborationMutation.extend({
  text: z.string().min(1).max(8000), recipients: z.array(alias).min(1).max(64),
  replyPolicy: z.enum(["none", "required", "optional"]).default("required"),
  mode: z.enum(["announce", "ask", "discuss"]).optional(),
});
const text = z.string().max(8000);
const identities = z.array(collaborationId).max(64);
const shortText = z.string().max(200);
const taskCreateSchema = z.strictObject({
  collaborationId, title: shortText, projectId: collaborationId, threadId: collaborationId,
  ganttTaskId: collaborationId.optional(), lead: collaborationId, owners: identities, reviewers: identities,
  expectedResponders: identities.optional(), deadlineAt: z.string().max(64).optional(),
  agentSessionId: collaborationId.optional(), recipeRunId: collaborationId.optional(),
  at: z.string().max(64), objective: text.optional(), context: text.optional(),
  expectedOutput: text.optional(), artifactType: shortText.optional(),
  acceptanceCriteria: z.array(text).max(64).optional(), decisionRequired: z.boolean().optional(),
  primaryOwner: collaborationId.optional(),
  ownerPartitions: z.array(z.strictObject({ owner: collaborationId, scope: text })).max(64).optional(),
});
const taskTransitionSchema = z.strictObject({
  collaborationId, expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  action: z.enum(["assign", "start", "handoff", "approve", "reject", "synthesize", "complete", "block", "timeout", "resume"]),
  note: text.optional(), expectedResponders: identities.optional(), deadlineAt: z.string().max(64).optional(),
  expectedGanttTaskVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  evidenceLinks: z.array(text).max(64).optional(), evidenceSummary: text.optional(),
  decisionResult: text.optional(), resultArtifact: text.optional(), blockedWaitingOn: identities.optional(),
  completionClaim: z.boolean().optional(), resolvedResponders: identities.optional(), evidenceMatchesContract: z.boolean().optional(),
});

/**
 * Inject the workspace DatabaseSync; this module never opens a database or owns its lifecycle.
 * UUID receipts and parent room CAS commit in ONE transaction. No disk/live Portal lease restore.
 * Write methods require an idle connection (BEGIN IMMEDIATE); do not wrap them in another transaction.
 */
export class CollaborationStateStore {
  private readonly now: () => number;
  constructor(private readonly db: DatabaseSync, private readonly options: CollaborationStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    if (options.initializeSchema !== false) db.exec(COLLABORATION_STATE_DDL);
  }
  private actor(value: CollaborationActor): CollaborationActor {
    // Copy trusted context so a caller cannot mutate it inside the human adapter.
    return Object.freeze(parse(z.strictObject({ actorId: collaborationId, kind: z.enum(["human", "agent", "browser"]) }), value));
  }
  private human(actor: CollaborationActor, action: string, roomId: string): void {
    if (actor.kind !== "human" || this.options.authorizeHuman?.(actor, action, roomId) !== true) {
      fail("HUMAN_AUTHORITY_REQUIRED", "This privileged local adapter is withheld from public capabilities.");
    }
  }
  private load(roomId: string): CollaborationRoom {
    const row = this.db.prepare("SELECT state_json FROM collaboration_rooms WHERE room_id = ?").get(roomId);
    if (!row) fail("NOT_FOUND", "Room was not found.");
    return JSON.parse(row.state_json as string) as CollaborationRoom;
  }
  list(context: CollaborationActor, args: { offset?: number; limit?: number } = {}) {
    const actor = this.actor(context);
    const input = parse(z.strictObject({ offset: z.number().int().min(0).max(1000).default(0), limit: z.number().int().min(1).max(100).default(20) }), args);
    const rooms = this.db.prepare("SELECT state_json FROM collaboration_rooms ORDER BY room_id").all()
      .map(row => JSON.parse(row.state_json as string) as CollaborationRoom)
      .filter(room => room.members.some(item => item.actorId === actor.actorId && item.kind === actor.kind));
    return { items: rooms.slice(input.offset, input.offset + input.limit).map(summary), total: rooms.length };
  }
  read(context: CollaborationActor, roomId: string): CollaborationRoom {
    const actor = this.actor(context), room = this.load(parse(collaborationId, roomId));
    member(room, actor, false);
    return room;
  }
  private write<T>(actor: CollaborationActor, action: string, input: { operationId: string; roomId: string; expectedRevision?: number },
    apply: (room: CollaborationRoom | null) => { room: CollaborationRoom; result: T }): T {
    const requestHash = hash(canonical({ actor, action, input }));
    const nested = this.db.isTransaction;
    this.db.exec(nested ? "SAVEPOINT collaboration_write" : "BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT * FROM collaboration_receipts WHERE operation_id = ?").get(input.operationId);
      if (prior) {
        if (prior.actor_id !== actor.actorId || prior.request_sha256 !== requestHash) fail("OPERATION_CONFLICT", "Operation UUID belongs to a different request.");
        const result = JSON.parse(prior.result_json as string) as T;
        this.db.exec(nested ? "RELEASE collaboration_write" : "COMMIT");
        return result;
      }
      const row = this.db.prepare("SELECT revision, state_json FROM collaboration_rooms WHERE room_id = ?").get(input.roomId);
      if (input.expectedRevision === undefined ? !!row : !row || row.revision !== input.expectedRevision) {
        fail("REVISION_CONFLICT", "Parent Room revision changed or creation ID already exists.");
      }
      const count = this.db.prepare("SELECT count(*) AS n FROM collaboration_receipts WHERE room_id = ?").get(input.roomId)!.n as number;
      if (count >= COLLABORATION_STATE_LIMITS.receiptsPerRoom) fail("LIMIT", "Room operation receipt limit reached; receipts are never silently evicted.");
      if (!row && (this.db.prepare("SELECT count(*) AS n FROM collaboration_rooms").get()!.n as number) >= COLLABORATION_STATE_LIMITS.rooms) fail("LIMIT", "Room limit reached.");
      const { room, result } = apply(row ? JSON.parse(row.state_json as string) as CollaborationRoom : null);
      room.revision = row ? (row.revision as number) + 1 : 1;
      const serialized = JSON.stringify(room);
      if (room.revision > Number.MAX_SAFE_INTEGER || Buffer.byteLength(serialized) > COLLABORATION_STATE_LIMITS.aggregateBytes) fail("LIMIT", "Room aggregate limit reached.");
      if (row) this.db.prepare("UPDATE collaboration_rooms SET revision = ?, state_json = ? WHERE room_id = ? AND revision = ?")
        .run(room.revision, serialized, room.roomId, input.expectedRevision!);
      else this.db.prepare("INSERT INTO collaboration_rooms VALUES (?, ?, ?)").run(room.roomId, room.revision, serialized);
      // Results that are room summaries must reflect the committed parent revision.
      const response = result && typeof result === "object" && "roomId" in result && "revision" in result
        ? { ...result, revision: room.revision } : result;
      this.db.prepare("INSERT INTO collaboration_receipts VALUES (?, ?, ?, ?, ?)")
        .run(input.operationId, actor.actorId, input.roomId, requestHash, JSON.stringify(response));
      this.db.exec(nested ? "RELEASE collaboration_write" : "COMMIT");
      return response as T;
    } catch (error) {
      this.db.exec(nested ? "ROLLBACK TO collaboration_write; RELEASE collaboration_write" : "ROLLBACK");
      throw error;
    }
  }
  create(context: CollaborationActor, args: z.input<typeof createInput>) {
    const actor = this.actor(context), input = parse(createInput, args);
    this.human(actor, "create", input.roomId);
    return this.write(actor, "create", input, () => {
      const owner: CollaborationMember = { ...actor, participantId: randomUUID(), alias: input.alias, present: true, muted: false };
      const room: CollaborationRoom = { roomId: input.roomId, name: input.name, revision: 1, ownerParticipantId: owner.participantId,
        status: "active", members: [owner], messages: [], tasks: [], meeting: null };
      return { room, result: summary(room) };
    });
  }
  /** Only pre-authorized local admission; no invitation, host proof or auto-peer networking. */
  join(context: CollaborationActor, args: z.input<typeof joinInput>) {
    const actor = this.actor(context), input = parse(joinInput, args);
    this.human(actor, "join", input.roomId);
    return this.write(actor, "join", input, current => {
      const room = current!;
      this.active(room);
      if (room.members.some(item => item.actorId !== actor.actorId && item.alias.toLocaleLowerCase() === input.alias.toLocaleLowerCase())) fail("ALIAS_CONFLICT", "Participant alias is already assigned.");
      const existing = room.members.find(item => item.actorId === actor.actorId);
      if (existing) {
        if (existing.kind !== actor.kind || existing.present) fail("IDENTITY_CONFLICT", "Only the same offline participant may rejoin.");
        existing.present = true;
        existing.alias = input.alias;
      } else {
        if (room.members.length >= COLLABORATION_STATE_LIMITS.members) fail("LIMIT", "Room roster limit reached.");
        room.members.push({ ...actor, participantId: randomUUID(), alias: input.alias, present: true, muted: false });
      }
      return { room, result: summary(room) };
    });
  }
  leave(context: CollaborationActor, args: CollaborationMutation) {
    const actor = this.actor(context), input = parse(collaborationMutation, args);
    return this.write(actor, "leave", input, current => {
      const room = current!, who = member(room, actor);
      who.present = false;
      if (who.participantId === room.ownerParticipantId) this.deactivate(room);
      return { room, result: summary(room) };
    });
  }
  close(context: CollaborationActor, args: CollaborationMutation) {
    const actor = this.actor(context), input = parse(collaborationMutation, args);
    this.human(actor, "close", input.roomId);
    return this.write(actor, "close", input, current => {
      const room = current!;
      this.owner(room, actor);
      this.active(room);
      this.deactivate(room);
      return { room, result: summary(room) };
    });
  }
  setMuted(context: CollaborationActor, args: CollaborationMutation & { participantId: string; muted: boolean }) {
    const actor = this.actor(context), input = parse(collaborationMutation.extend({ participantId: collaborationId, muted: z.boolean() }), args);
    this.human(actor, "mute", input.roomId);
    return this.write(actor, "mute", input, current => {
      const room = current!;
      this.active(room); this.owner(room, actor);
      const target = room.members.find(item => item.participantId === input.participantId);
      if (!target || target.participantId === room.ownerParticipantId) fail("INVALID_TARGET", "Unknown target or owner cannot be muted.");
      target.muted = input.muted;
      return { room, result: summary(room) };
    });
  }
  /** Local history acceptance only. Deliberately NOT a public capability or a delivery API. */
  recordMessage(context: CollaborationActor, args: z.input<typeof postInput>): CollaborationMessage {
    const actor = this.actor(context), input = parse(postInput, args);
    return this.write(actor, "record-message", input, current => {
      const room = current!, who = member(room, actor);
      this.active(room);
      if (who.muted) fail("muted", "Muted participants cannot post.");
      if (!input.text.trim() || input.text.trim().startsWith("/")) fail("INVALID_ARGUMENT", "Empty text and executable slash commands are outside this subset.");
      const mentions = allMentionNames(input.text).map(name => name.toLocaleLowerCase());
      const requestedRecipients = input.recipients.map(name => name.toLocaleLowerCase());
      const recipients = [...new Set(requestedRecipients)].map(name => {
        if (name === "all" || name === "everyone") return "all";
        const target = room.members.find(item => item.alias.toLocaleLowerCase() === name);
        if (!target || target.participantId === who.participantId) fail("structured-recipient-invalid", "Every recipient must be another current Room participant.");
        return target.alias.toLocaleLowerCase();
      });
      if (new Set(requestedRecipients).size !== new Set(recipients).size)
        fail("structured-recipient-invalid", "Structured recipient aliases resolve to the same target.");
      if ([...mentions, ...recipients.map(name => name.toLocaleLowerCase())].some(name => name === "all" || name === "everyone")
        && who.participantId !== room.ownerParticipantId) fail("host-only-broadcast", "Only the Room Host can use @all.");
      const message: CollaborationMessage = { id: randomUUID(), fromId: who.participantId, from: who.alias,
        kind: who.kind, text: input.text, ts: this.now(), recipients, replyPolicy: input.replyPolicy,
        ...(actor.kind === "human" && who.participantId === room.ownerParticipantId && input.mode ? { mode: input.mode } : {}) };
      room.messages.push(message);
      if (room.messages.length > COLLABORATION_STATE_LIMITS.messages) room.messages.shift();
      return { room, result: message };
    });
  }
  createTask(context: CollaborationActor, args: CollaborationMutation & { task: Parameters<typeof createCollaborationTask>[0] }) {
    const actor = this.actor(context);
    const input = parse(collaborationMutation.extend({ task: taskCreateSchema }), args);
    this.boundPayload(input.task);
    return this.write(actor, "create-task", input, current => {
      const room = current!, who = member(room, actor);
      this.active(room);
      if (input.task.lead !== who.participantId) fail("FORBIDDEN", "Only the trusted assigned Lead can create a task.");
      if (room.tasks.length >= COLLABORATION_STATE_LIMITS.tasks) fail("LIMIT", "Task limit reached.");
      if (room.tasks.some(task => task.collaborationId === input.task.collaborationId)) fail("IDENTITY_CONFLICT", "Task already exists.");
      const task = createCollaborationTask({ ...input.task, at: new Date(this.now()).toISOString() });
      if ([...task.owners, ...task.reviewers, task.lead, ...task.expectedResponders].some(id => !room.members.some(item => item.present && item.participantId === id))) fail("UNKNOWN_OWNER", "Task identities must be current Room participants.");
      room.tasks.push(task);
      return { room, result: task };
    });
  }
  transitionTask(context: CollaborationActor, args: CollaborationMutation & { transition: Omit<CollaborationTransition, "actor" | "actorRole" | "at"> }) {
    const actor = this.actor(context);
    const input = parse(collaborationMutation.extend({ transition: taskTransitionSchema }), args);
    this.boundPayload(input.transition);
    return this.write(actor, "transition-task", input, current => {
      const room = current!, who = member(room, actor);
      this.active(room);
      const index = room.tasks.findIndex(task => task.collaborationId === input.transition.collaborationId);
      if (index < 0) fail("NOT_FOUND", "Collaboration task was not found.");
      const task = room.tasks[index], id = who.participantId;
      if ([...(input.transition.expectedResponders ?? []), ...(input.transition.resolvedResponders ?? [])]
        .some(identity => !room.members.some(item => item.participantId === identity))) fail("UNKNOWN_OWNER", "Responder identities must belong to this Room.");
      // Derive role from the original action policy + immutable assignments, not a supplied role.
      const action = input.transition.action;
      const actorRole = ["assign", "synthesize", "complete", "timeout"].includes(action) ? "Lead"
        : ["approve", "reject"].includes(action) ? "Reviewer"
        : ["start", "handoff"].includes(action) ? "Worker"
        : id === task.lead ? "Lead" : task.owners.includes(id) ? "Worker" : "Reviewer";
      const updated = transitionCollaborationTask(task, { ...input.transition, actor: id, actorRole, at: new Date(this.now()).toISOString() });
      room.tasks[index] = updated;
      return { room, result: updated };
    });
  }
  startMeeting(context: CollaborationActor, args: CollaborationMutation & { triggerMessageId: string; leadParticipantId: string }) {
    const actor = this.actor(context), input = parse(collaborationMutation.extend({ triggerMessageId: collaborationId, leadParticipantId: collaborationId }), args);
    this.human(actor, "start-meeting", input.roomId);
    return this.write(actor, "start-meeting", input, current => {
      const room = current!;
      this.active(room); const host = this.owner(room, actor);
      if (room.meeting?.status === "active") fail("MEETING_ACTIVE", "This Room already has an active Meeting.");
      if (!room.messages.some(message => message.id === input.triggerMessageId && message.mode === "discuss")) fail("TRIGGER_REQUIRED", "A Discuss trigger message is required.");
      if (!room.members.some(item => item.present && item.participantId === input.leadParticipantId)) fail("UNKNOWN_OWNER", "Meeting Lead is not present.");
      const meeting: CollaborationMeeting = { id: randomUUID(), host: host.participantId, lead: input.leadParticipantId,
        triggerMessageId: input.triggerMessageId, revision: 1, status: "active", phase: "discussion", startedAt: new Date(this.now()).toISOString() };
      room.meeting = meeting;
      return { room, result: meeting };
    });
  }
  adjournMeeting(context: CollaborationActor, args: CollaborationMutation & { expectedMeetingRevision: number }) {
    const actor = this.actor(context), input = parse(collaborationMutation.extend({ expectedMeetingRevision: z.number().int().positive() }), args);
    this.human(actor, "adjourn-meeting", input.roomId);
    return this.write(actor, "adjourn-meeting", input, current => {
      const room = current!;
      this.owner(room, actor); this.active(room);
      if (!room.meeting || room.meeting.status !== "active") fail("MEETING_INACTIVE", "No active Meeting.");
      if (room.meeting.revision !== input.expectedMeetingRevision) fail("REVISION_CONFLICT", "Meeting revision conflict.");
      this.adjourn(room.meeting);
      return { room, result: room.meeting };
    });
  }
  private boundPayload(value: unknown): void {
    if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) fail("LIMIT", "Task payload limit reached.");
  }
  private active(room: CollaborationRoom): void { if (room.status !== "active") fail("ROOM_CLOSED", "Room is closed; local state cannot reconnect it."); }
  private owner(room: CollaborationRoom, actor: CollaborationActor): CollaborationMember {
    const who = member(room, actor);
    if (!room.ownerParticipantId || who.participantId !== room.ownerParticipantId) fail("FORBIDDEN", "Only the assigned Room Host may perform this operation.");
    return who;
  }
  private adjourn(meeting: CollaborationMeeting): void {
    meeting.status = "adjourned"; meeting.phase = "adjourned"; meeting.endedAt = new Date(this.now()).toISOString(); meeting.revision++;
  }
  private deactivate(room: CollaborationRoom): void {
    room.status = "closed";
    for (const item of room.members) item.present = false;
    if (room.meeting?.status === "active") this.adjourn(room.meeting);
  }
}
