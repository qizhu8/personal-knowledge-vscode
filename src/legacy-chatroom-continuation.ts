import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Core } from "./core.js";
import type { Actor } from "./contracts.js";
import type { ChatSessionMessage, ChatSessionRecord } from "./chat-session-contracts.js";
import { chatSessionMessageInput } from "./chat-session-contracts.js";
import { documentPath } from "./document-path.js";
import type { ChatTurnRecord } from "./chat-turn-contracts.js";

const roomIdSchema = z.string().regex(/^[A-Za-z0-9_-]{6,80}$/);
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function fail(message: string): never { throw new Error(`LEGACY_CHATROOM_BLOCKED: ${message}`); }
function stableId(value: string) {
  const hash = digest(value);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
const messageSchema = z.object({
  sequence: z.number().int().positive(), message_id: z.string().min(1).max(128),
  participant_id: z.string().nullable(), alias_at_send: z.string().max(200),
  sender_kind: z.string().max(80), message_type: z.string().max(80),
  content: z.string().max(100_000), metadata_json: z.string().max(131_072).nullable(),
  created_at: z.number().int().nonnegative().max(8_640_000_000_000_000),
});
export interface LegacyChatroomFile {
  path: string; sha256: string; size: number; mode: number; dev: number; ino: number; mtimeMs: number;
}
export interface LegacyChatroomArchive {
  schema: "pkm.legacy-chatroom-archive/v1"; root: string; roomId: string; name: string;
  sourceFingerprint: string; files: LegacyChatroomFile[];
  messages: z.infer<typeof messageSchema>[];
}
function directory(file: string) {
  const stat = lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(file) !== file) fail("Linked/non-directory archive path.");
}
function pin(file: string, relative: string): LegacyChatroomFile {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 33_554_432)
    fail("Archive files must be bounded ordinary unlinked files.");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let sha256: string;
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) fail("Archive inode changed before read.");
    sha256 = digest(readFileSync(fd));
  } finally { closeSync(fd); }
  const after = lstatSync(file);
  if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || before.size !== after.size)
    fail("Archive changed during inspection.");
  return { path: relative, sha256, size: before.size, mode: before.mode & 0o777, dev: before.dev, ino: before.ino, mtimeMs: before.mtimeMs };
}

/** Read-only legacy sql.js archive inspection. Never opens a legacy network room or inherits its host credentials. */
export function inspectLegacyChatroomArchive(root: string, roomId: string): LegacyChatroomArchive {
  roomIdSchema.parse(roomId);
  if (resolve(root) !== root || realpathSync(root) !== root) fail("Canonical absolute root required.");
  directory(root);
  directory(join(root, "chatrooms"));
  const room = join(root, "chatrooms", roomId);
  directory(room);
  const names = readdirSync(room).sort();
  if (!names.includes("chatroom.db") || names.some(name => !["chatroom.db", "chatroom.journal", "meetings"].includes(name)))
    fail("Unknown file, live lock, recovery file or SQLite sidecar.");
  const paths = names.flatMap(name => {
    if (name !== "meetings") return [`chatrooms/${roomId}/${name}`];
    const meetings = join(room, name);
    directory(meetings);
    if (JSON.stringify(readdirSync(meetings).sort()) !== '["canonical.json"]')
      fail("Meeting archive contains a live lock, recovery file or unknown entry.");
    return [`chatrooms/${roomId}/meetings/canonical.json`];
  });
  const files = paths.map(path => pin(join(root, path), path));
  if (names.includes("meetings")) {
    const bytes = readFileSync(join(room, "meetings", "canonical.json"));
    if (!Buffer.from(bytes.toString("utf8")).equals(bytes)) fail("Meeting canonical state is not valid UTF-8.");
    let canonical;
    try { canonical = JSON.parse(bytes.toString("utf8")); } catch { fail("Invalid Meeting canonical JSON."); }
    if (canonical?.schema !== 1 || !Array.isArray(canonical.meetings)
      || canonical.meetings.some((meeting: Record<string, unknown>) => meeting?.roomId !== roomId
        || typeof meeting.markdownPath !== "string"
        || !meeting.markdownPath.replace(/\\/g, "/").startsWith("Chatroom Meetings/")
        || !documentPath.safeParse(meeting.markdownPath.replace(/\\/g, "/")).success))
      fail("Invalid or cross-Room Meeting canonical state.");
  }
  const journal = files.find(file => file.path.endsWith(".journal"));
  if (journal?.size) fail("Nonempty legacy journal requires legacy recovery.");
  const bytes = readFileSync(join(room, "chatroom.db"));
  if (bytes.subarray(0, 16).toString() !== "SQLite format 3\0" || bytes[18] !== 1 || bytes[19] !== 1)
    fail("Expected closed rollback-mode sql.js database, not WAL.");
  const database = new DatabaseSync(join(room, "chatroom.db"), { readOnly: true });
  let name: string;
  let messages: LegacyChatroomArchive["messages"];
  try {
    database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY");
    const schema = database.prepare("SELECT name,type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
    const tables = new Set(["room_metadata", "room_events", "messages", "memberships", "alias_history", "pending_joins"]);
    for (const entry of schema) {
      if (entry.type === "table" ? !tables.has(String(entry.name)) : entry.type !== "index") fail("Unexpected database schema.");
    }
    if (schema.filter(entry => entry.type === "table").length !== tables.size) fail("Incomplete legacy schema.");
    if (database.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") fail("Database integrity check failed.");
    const metadata = database.prepare("SELECT room_id,schema_version,current_name,state FROM room_metadata LIMIT 2").all();
    if (metadata.length !== 1 || metadata[0].room_id !== roomId || metadata[0].schema_version !== 2 || metadata[0].state !== "stored")
      fail("Only closed schema-2 rooms are supported.");
    name = z.string().trim().min(1).max(120).parse(metadata[0].current_name);
    if (database.prepare("SELECT 1 FROM pending_joins WHERE status='pending' LIMIT 1").get()) fail("Pending joins require legacy recovery.");
    const count = Number(database.prepare("SELECT count(*) AS n FROM messages").get()?.n);
    if (count > 9_998) fail("Archive exceeds native transcript bound.");
    messages = database.prepare("SELECT sequence,message_id,participant_id,alias_at_send,sender_kind,message_type,content,metadata_json,created_at FROM messages ORDER BY sequence")
      .all().map(row => messageSchema.parse(row));
    if (messages.some((message, index) => (index > 0 && message.sequence <= messages[index - 1].sequence)
      || (message.metadata_json !== null && !validMetadata(message.metadata_json)))) fail("Invalid message sequence/metadata.");
  } finally { database.close(); }
  const after = paths.map(path => pin(join(root, path), path));
  if (JSON.stringify(files) !== JSON.stringify(after) || JSON.stringify(names) !== JSON.stringify(readdirSync(room).sort()))
    fail("Archive changed during SQLite inspection.");
  if (names.includes("meetings") && JSON.stringify(readdirSync(join(room, "meetings")).sort()) !== '["canonical.json"]')
    fail("Meeting archive inventory changed during inspection.");
  const sourceFingerprint = digest(JSON.stringify({ root, roomId, files }));
  return { schema: "pkm.legacy-chatroom-archive/v1", root, roomId, name, sourceFingerprint, files, messages };
}
function validMetadata(raw: string) {
  try { JSON.parse(raw); return true; } catch { return false; }
}
export function inspectLegacyChatroomTree(root: string): LegacyChatroomArchive[] {
  directory(join(root, "chatrooms"));
  const entries = readdirSync(join(root, "chatrooms"));
  if (entries.length > 32) fail("More than 32 legacy rooms require a separately bounded migration.");
  if (entries.reduce((bytes, roomId) => {
    roomIdSchema.parse(roomId);
    directory(join(root, "chatrooms", roomId));
    return bytes + lstatSync(join(root, "chatrooms", roomId, "chatroom.db")).size;
  }, 0) > 134_217_728) fail("Legacy Chatroom tree exceeds 128 MiB.");
  return entries.sort().map(roomId => inspectLegacyChatroomArchive(root, roomId));
}
export function inspectLegacyChatroomParticipants(root: string, roomId: string) {
  const before = inspectLegacyChatroomArchive(root, roomId);
  const database = new DatabaseSync(join(root, "chatrooms", roomId, "chatroom.db"), { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
    const columns = database.prepare("PRAGMA table_info(memberships)").all().map(row => row.name);
    const members = database.prepare(`SELECT participant_id,kind,role,${columns.includes("temporary") ? "temporary" : "0 AS temporary"},created_at,updated_at,forgotten_at FROM memberships LIMIT 65`).all();
    const aliases = database.prepare("SELECT alias_key,alias_display,participant_id,assigned_at,released_at FROM alias_history ORDER BY sequence LIMIT 5001").all();
    const joinColumns = database.prepare("PRAGMA table_info(pending_joins)").all().map(row => row.name);
    if (!["request_id", "alias_key", "alias_display", "kind", "status", "requested_at", "expires_at",
      "resolved_at", "participant_id", "reason"].every(column => joinColumns.includes(column)))
      fail("Participant identity history schema is incomplete.");
    const joins = database.prepare(`SELECT request_id,alias_key,alias_display,
      ${joinColumns.includes("client_key") ? "client_key" : "'' AS client_key"},kind,
      ${joinColumns.includes("temporary") ? "temporary" : "0 AS temporary"},
      status,requested_at,expires_at,resolved_at,participant_id,reason
      FROM pending_joins ORDER BY requested_at,request_id LIMIT 5001`).all();
    if (members.length > 64 || aliases.length > 5000 || joins.length > 5000)
      fail("Participant/alias/join history exceeds native Room bounds.");
    const joinSchema = z.object({
      request_id: z.string().min(1).max(128), alias_key: z.string().max(200), alias_display: z.string().max(200),
      client_key: z.string().max(200), kind: z.string().max(80), temporary: z.number().int().min(0).max(1),
      status: z.enum(["approved_new", "approved_reuse", "rejected", "timed_out", "cancelled"]),
      requested_at: z.number().int().nonnegative(), expires_at: z.number().int().nonnegative(),
      resolved_at: z.number().int().nonnegative().nullable(), participant_id: z.string().max(128).nullable(),
      reason: z.string().max(4096).nullable(),
    });
    const identity = {
      memberships: members.map(row => ({
        participantId: String(row.participant_id), kind: String(row.kind), role: String(row.role), temporary: !!row.temporary,
        createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
        ...(row.forgotten_at === null ? {} : { forgottenAt: Number(row.forgotten_at) }),
      })),
      aliases: aliases.map(row => ({
        aliasKey: String(row.alias_key), alias: String(row.alias_display), participantId: String(row.participant_id),
        assignedAt: Number(row.assigned_at), ...(row.released_at === null ? {} : { releasedAt: Number(row.released_at) }),
      })),
      pendingJoins: joins.map(value => {
        const row = joinSchema.parse(value);
        return { requestId: row.request_id, aliasKey: row.alias_key, alias: row.alias_display, clientKey: row.client_key,
          kind: row.kind, temporary: !!row.temporary, status: row.status, requestedAt: row.requested_at,
          expiresAt: row.expires_at, ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
          ...(row.participant_id === null ? {} : { participantId: row.participant_id }),
          ...(row.reason === null ? {} : { reason: row.reason }) };
      }),
    };
    if (inspectLegacyChatroomArchive(root, roomId).sourceFingerprint !== before.sourceFingerprint) fail("Participant source changed.");
    return identity;
  } finally { database.close(); }
}

export interface LegacyChatroomBinding {
  workspaceRoot: string; workspaceId: string; actorId: string; roomId: string; sourceFingerprint: string;
  operation: "history" | "migrate" | "continue";
}
export interface LegacyChatroomHost {
  root: string; workspaceId: string; core: Core; actor: Actor;
  authorize(binding: Readonly<LegacyChatroomBinding>): Promise<boolean>;
}
type Appended = { session: ChatSessionRecord; message: ChatSessionMessage };

/** Optional host-gated archive compatibility, not legacy Host/rehost, credentials or automatic provider replay. */
export class LegacyChatroomContinuation {
  constructor(private readonly host: LegacyChatroomHost) {}
  private async call<T>(operation: string, args: unknown): Promise<T> {
    const readOnly = ["chat.session.get", "chat.session.messages", "chat.turn.get"].includes(operation);
    const envelope = await this.host.core.dispatch(readOnly ? "capability_read" : "capability_call",
      { operation, version: 1, arguments: args }, this.host.actor) as { result?: T; error?: { code: string; message: string } };
    if (envelope.error) throw Object.assign(new Error(envelope.error.message), { code: envelope.error.code });
    return envelope.result!;
  }
  private async admitted(roomId: string, operation: LegacyChatroomBinding["operation"]) {
    const archive = inspectLegacyChatroomArchive(this.host.root, roomId);
    if (!await this.host.authorize(Object.freeze({
      workspaceRoot: this.host.root, workspaceId: this.host.workspaceId, actorId: this.host.actor.id,
      roomId, sourceFingerprint: archive.sourceFingerprint, operation,
    }))) throw new Error("LEGACY_CHATROOM_AUTHORITY_REQUIRED");
    const checked = inspectLegacyChatroomArchive(this.host.root, roomId);
    if (checked.sourceFingerprint !== archive.sourceFingerprint) fail("Authorization raced with an archive change.");
    return archive;
  }
  async list() {
    const items: { roomId: string; name: string; messageCount: number; sourceFingerprint: string }[] = [];
    for (const candidate of inspectLegacyChatroomTree(this.host.root)) {
      try {
        const archive = await this.admitted(candidate.roomId, "history");
        items.push({ roomId: archive.roomId, name: archive.name, messageCount: archive.messages.length,
          sourceFingerprint: archive.sourceFingerprint });
      } catch (error) {
        if (!(error instanceof Error && error.message === "LEGACY_CHATROOM_AUTHORITY_REQUIRED")) throw error;
      }
    }
    return { items, qualification: "experimental-unqualified", authority: "archive-only-no-legacy-host" };
  }
  async history(roomId: string, offset = 0, limit = 20) {
    z.number().int().nonnegative().parse(offset);
    z.number().int().min(1).max(100).parse(limit);
    const archive = await this.admitted(roomId, "history");
    const items: LegacyChatroomArchive["messages"] = [];
    for (const message of archive.messages.slice(offset, offset + limit)) {
      if (Buffer.byteLength(JSON.stringify([...items, message])) > 524_288) break;
      items.push(message);
    }
    return {
      roomId, name: archive.name, sourceFingerprint: archive.sourceFingerprint, total: archive.messages.length,
      items, nextOffset: offset + items.length < archive.messages.length ? offset + items.length : null,
      qualification: "experimental-unqualified", authority: "archive-only-no-legacy-host",
    };
  }
  private projection(archive: LegacyChatroomArchive) {
    if (archive.messages.some(message => !["chat", "system"].includes(message.message_type) || !["human", "browser", "agent"].includes(message.sender_kind)))
      fail("Continuation currently requires text chat/notice history; non-text history remains readable without lossy conversion.");
    const seed = `${this.host.workspaceId}:${this.host.actor.id}:${archive.roomId}:${archive.sourceFingerprint}`;
    return { seed, id: stableId(`${seed}:session`) };
  }
  async migrate(roomId: string) {
    if (!this.host.actor.canWrite) throw new Error("READ_ONLY");
    const archive = await this.admitted(roomId, "migrate");
    const { seed, id } = this.projection(archive);
    const projected = archive.messages.map(message => chatSessionMessageInput.parse({
      id: stableId(`${seed}:message:${message.sequence}`), content: message.content,
      role: message.message_type === "chat" && message.sender_kind === "agent" ? "assistant" : "user", status: "complete",
      recordedAt: new Date(message.created_at).toISOString(),
      metadata: { schema: "pkm.chat.transcript-metadata/v1", retrieval: {
        schema: "pkm.legacy-chatroom-origin/v1", roomId, sourceFingerprint: archive.sourceFingerprint,
        sequence: message.sequence, messageId: message.message_id,
        ...(message.participant_id === null ? {} : { participantId: message.participant_id }),
        aliasAtSend: message.alias_at_send, senderKind: message.sender_kind, messageType: message.message_type,
        ...(message.metadata_json === null ? {} : { originalMetadata: JSON.parse(message.metadata_json) }),
      } },
    }));
    const sizes = projected.map(message => Buffer.byteLength(JSON.stringify(message)) + 1024);
    if (sizes.some(size => size > 131_072) || sizes.reduce((sum, size) => sum + size, 0) > 16_777_216)
      fail("Portable history/origin metadata exceeds native transcript bounds; original archive is unchanged.");
    await this.call<ChatSessionRecord>("chat.session.create", {
      id, title: archive.name, expectedRevision: 0, operationId: stableId(`${seed}:create`),
    });
    for (const [index, message] of projected.entries()) {
      await this.call<Appended>("chat.session.append", {
        id, expectedRevision: index + 1, operationId: stableId(`${seed}:append:${archive.messages[index].sequence}`), message,
      });
    }
    return {
      session: await this.call<ChatSessionRecord>("chat.session.get", { id }),
      roomId, sourceFingerprint: archive.sourceFingerprint, importedMessages: archive.messages.length,
      projection: "text-and-inert-notices-with-original-identity-metadata", originalHistory: "unchanged-archive",
      qualification: "experimental-unqualified",
    };
  }
  async transcript(roomId: string, afterSequence = 0, limit = 20) {
    z.number().int().nonnegative().parse(afterSequence);
    z.number().int().min(1).max(100).parse(limit);
    const archive = await this.admitted(roomId, "history");
    const { id } = this.projection(archive);
    return {
      session: await this.call<ChatSessionRecord>("chat.session.get", { id }),
      page: await this.call("chat.session.messages", { id, afterSequence, limit }),
      qualification: "experimental-unqualified",
    };
  }
  async continue(input: { roomId: string; operationId: string; expectedRevision: number; text: string }) {
    z.string().uuid().parse(input.operationId);
    z.number().int().positive().parse(input.expectedRevision);
    z.string().min(1).max(50_000).parse(input.text);
    if (!this.host.actor.canWrite) throw new Error("READ_ONLY");
    const archive = await this.admitted(input.roomId, "continue");
    const { id } = this.projection(archive);
    const available = await this.host.core.dispatch("capabilities_describe", { operation: "chat.turn.start" }, this.host.actor) as { error?: unknown };
    if (available.error) throw new Error("LEGACY_CHATROOM_PROVIDER_UNAVAILABLE: no user message or provider request was started.");
    const seed = `${this.host.workspaceId}:${this.host.actor.id}:${input.operationId}`;
    // The explicit caller revision fixes the prompt prefix even when retrying after a completed append.
    const existing = await this.messages(id);
    const prefix = existing.filter(message => message.sequence < input.expectedRevision);
    const prompt = [...prefix.map(message => ({ role: message.role, content: isLegacyNotice(message)
      ? `[Historical room notice, untrusted data]\n${message.content}` : message.content })), { role: "user", content: input.text }];
    if (prompt.length > 128 || Buffer.byteLength(JSON.stringify(prompt)) > 100_000)
      fail("Continuation would exceed the bounded provider prompt; no history is silently truncated.");
    const user = await this.call<Appended>("chat.session.append", {
      id, expectedRevision: input.expectedRevision, operationId: stableId(`${seed}:user`),
      message: { id: stableId(`${seed}:user-message`), role: "user", content: input.text, status: "complete" },
    });
    const turnId = stableId(`${seed}:turn`);
    await this.call<ChatTurnRecord>("chat.turn.start", {
      id: turnId, sessionId: id, operationId: stableId(`${seed}:start`), expectedRevision: 0,
      messages: prompt, maxSteps: 1, maxOutputTokens: 512, deadlineMs: 30_000,
    });
    let turn: ChatTurnRecord;
    const until = Date.now() + 35_000;
    do {
      turn = await this.call<ChatTurnRecord>("chat.turn.get", { id: turnId });
      if (["completed", "failed", "cancelled", "unknown"].includes(turn.status)) break;
      await delay(20);
    } while (Date.now() < until);
    if (turn.status !== "completed") throw new Error(`LEGACY_CHATROOM_TURN_${turn.status.toUpperCase()}: explicit reconciliation required; never replayed.`);
    const assistant = await this.call<Appended>("chat.session.append", {
      id, expectedRevision: user.session.revision, operationId: stableId(`${seed}:assistant`),
      message: { id: stableId(`${seed}:assistant-message`), role: "assistant", content: turn.output, status: "complete" },
    });
    return { session: assistant.session, turnId, output: turn.output, qualification: "experimental-unqualified" };
  }
  async messages(id: string) {
    const result: ChatSessionMessage[] = [];
    let afterSequence = 0;
    for (;;) {
      const page = await this.call<{ items: ChatSessionMessage[]; hasMore: boolean }>("chat.session.messages", { id, afterSequence, limit: 100 });
      result.push(...page.items);
      if (!page.hasMore) return result;
      afterSequence = page.items.at(-1)!.sequence;
    }
  }
}
function isLegacyNotice(message: ChatSessionMessage) {
  const origin = message.metadata?.retrieval;
  return origin !== null && typeof origin === "object" && !Array.isArray(origin)
    && origin.schema === "pkm.legacy-chatroom-origin/v1" && origin.messageType === "system";
}

export function registerLegacyChatroomContinuation(server: McpServer, host: LegacyChatroomContinuation) {
  const roomId = roomIdSchema;
  const result = async (fn: () => Promise<unknown>) => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await fn()) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Legacy Chatroom failed." }] }; }
  };
  server.registerTool("legacy_chatroom_list", {
    inputSchema: z.strictObject({}), description: "Discover only explicitly host-authorized closed Rooms on the configured root; no path picker or inherited legacy Host identity.",
    annotations: { readOnlyHint: true },
  }, () => result(() => host.list()));
  server.registerTool("legacy_chatroom_history", {
    inputSchema: z.strictObject({ roomId, offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20) }),
    description: "Host-authorized closed legacy Room history, preserving original IDs, aliases and metadata. No legacy host authority.",
    annotations: { readOnlyHint: true },
  }, args => result(() => host.history(args.roomId, args.offset, args.limit)));
  server.registerTool("legacy_chatroom_migrate", {
    inputSchema: z.strictObject({ roomId }), description: "Explicit resumable text transcript projection to a new actor-private native Chat. Original SQLite is unchanged.",
  }, args => result(() => host.migrate(args.roomId)));
  server.registerTool("legacy_chatroom_session", {
    inputSchema: z.strictObject({ roomId, afterSequence: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20) }),
    description: "Read the actor-private continued native transcript linked to this unchanged legacy archive.",
    annotations: { readOnlyHint: true },
  }, args => result(() => host.transcript(args.roomId, args.afterSequence, args.limit)));
  server.registerTool("legacy_chatroom_continue", {
    inputSchema: z.strictObject({ roomId, operationId: z.string().uuid(), expectedRevision: z.number().int().positive(), text: z.string().min(1).max(50_000) }),
    description: "Explicit native-provider continuation with durable operation IDs. Never rehosts the legacy Room or imports old provider/tool credentials.",
  }, args => result(() => host.continue(args)));
}
