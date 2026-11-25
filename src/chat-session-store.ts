import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CoreError } from "./contracts.js";
import { CHAT_TURN_LIMITS, type ChatTurnRecord, type ChatTurnStart } from "./chat-turn-contracts.js";
import {
  CHAT_SESSION_LIMITS, chatSessionDefinitions, boundedChatJson, chatSessionMessage, chatSessionRecord,
  type ChatSessionMessage, type ChatSessionRecord, type ChatSessionRequest,
} from "./chat-session-contracts.js";

export const CHAT_SESSION_SCHEMA_VERSION = 1;
export const CHAT_SESSION_TABLES = ["chat_session_schema", "chat_sessions", "chat_session_messages", "chat_session_turn_reservations"] as const;

/** Call once on the parent's DatabaseSync, inside its schema migration transaction. Owns no PRAGMA user_version. */
export function initializeChatSessionSchema(db: DatabaseSync): void {
  if (!db.isTransaction) throw new CoreError("TRANSACTION_REQUIRED", "Initialize Chat schema in the shared migration transaction.");
  db.exec("CREATE TABLE IF NOT EXISTS chat_session_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL)");
  const version = db.prepare("SELECT version FROM chat_session_schema WHERE singleton=1").get();
  if (version && Number(version.version) !== CHAT_SESSION_SCHEMA_VERSION) {
    throw new CoreError("UNSUPPORTED_SCHEMA", "Unsupported Chat session state schema; no automatic migration or downgrade.");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions(
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL, id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision>0), message_count INTEGER NOT NULL DEFAULT 0 CHECK(message_count>=0),
      message_bytes INTEGER NOT NULL DEFAULT 0 CHECK(message_bytes>=0), record TEXT NOT NULL,
      UNIQUE(actor_id,id)
    );
    CREATE TABLE IF NOT EXISTS chat_session_messages(
      actor_id TEXT NOT NULL, chat_id TEXT NOT NULL, id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(sequence>0), record TEXT NOT NULL,
      PRIMARY KEY(actor_id,chat_id,sequence), UNIQUE(actor_id,chat_id,id),
      FOREIGN KEY(actor_id,chat_id) REFERENCES chat_sessions(actor_id,id)
    );
    CREATE TABLE IF NOT EXISTS chat_session_turn_reservations(
      actor_id TEXT NOT NULL, chat_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      PRIMARY KEY(actor_id,chat_id), UNIQUE(actor_id,turn_id),
      FOREIGN KEY(actor_id,chat_id) REFERENCES chat_sessions(actor_id,id)
    );
    INSERT OR IGNORE INTO chat_session_schema(singleton,version) VALUES(1,1);
  `);
}

function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
function encode(value: object) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
type Cursor = { v: 1; scope: string; after: number; pin?: string };
function decode(text: string, scope: string): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error();
    const value = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Cursor;
    if (value.v !== 1 || value.scope !== scope || !Number.isSafeInteger(value.after) || value.after < 0
      || (value.pin !== undefined && !/^[a-f0-9]{64}$/.test(value.pin))
      || Object.keys(value).some(key => !["v", "scope", "after", "pin"].includes(key))
      || encode(value) !== text) throw new Error();
    return value;
  } catch { throw new CoreError("CURSOR_INVALID", "Invalid Chat cursor for this actor, query or schema."); }
}
function parseRecord(value: unknown): ChatSessionRecord {
  try { return chatSessionRecord.parse(JSON.parse(String(value))); }
  catch { throw new CoreError("STATE_CORRUPT", "Unsupported or corrupt Chat session record; no history was discarded."); }
}
function parseMessage(value: unknown): ChatSessionMessage {
  try { return chatSessionMessage.parse(JSON.parse(String(value))); }
  catch { throw new CoreError("STATE_CORRUPT", "Unsupported or corrupt Chat message record; no history was discarded."); }
}

/**
 * No database/file is opened and no mutation transaction is committed or operation receipt written here.
 * The parent MUST check/replay receipts, call execute, and insert its receipt in ONE BEGIN IMMEDIATE transaction.
 * Roll back that transaction on any error. actorId is authenticated transport context, never a request argument.
 */
export function createChatSessionStore(db: DatabaseSync, options: { now?: () => string } = {}) {
  function schema() {
    const row = db.prepare("SELECT version FROM chat_session_schema WHERE singleton=1").get();
    if (!row || Number(row.version) !== CHAT_SESSION_SCHEMA_VERSION) throw new CoreError("UNSUPPORTED_SCHEMA", "Unsupported Chat session state schema.");
  }
  function get(actorId: string, id: string) {
    const row = db.prepare("SELECT * FROM chat_sessions WHERE actor_id=? AND id=?").get(actorId, id);
    if (!row) throw new CoreError("NOT_FOUND", "Chat session was not found.");
    const record = parseRecord(row.record);
    if (record.id !== id || record.revision !== Number(row.revision)
      || record.messageCount !== Number(row.message_count) || record.lastSequence !== record.messageCount) {
      throw new CoreError("STATE_CORRUPT", "Chat session index does not match its stored record.");
    }
    return { row, record };
  }
  function timestamp() {
    const value = options.now?.() ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(value))) throw new CoreError("INVALID_TIME", "Chat clock did not return an ISO timestamp.");
    return new Date(value).toISOString();
  }
  function dispatch(request: ChatSessionRequest, actorId: string): unknown {
    if (typeof actorId !== "string" || !actorId.length || actorId.length > 256 || /[\u0000-\u001f]/.test(actorId)) {
      throw new CoreError("UNAUTHORIZED", "Trusted Chat actor context is required.");
    }
    const definition = chatSessionDefinitions.find(value => value.id === request.operation);
    if (!definition) throw new CoreError("UNKNOWN_OPERATION", "Unknown Chat session operation.");
    if (!boundedChatJson(request.args)) throw new CoreError("INVALID_INPUT", "Chat request exceeds portable JSON bounds.");
    if (Buffer.byteLength(JSON.stringify(request.args)) > CHAT_SESSION_LIMITS.requestBytes) throw new CoreError("LIMIT_EXCEEDED", "Chat request exceeds its byte limit.");
    const parsed = definition.input.safeParse(request.args);
    if (!parsed.success) throw new CoreError("INVALID_INPUT", "Chat session arguments do not match the operation schema.");
    schema();
    if (!definition.readOnly && !db.isTransaction) throw new CoreError("TRANSACTION_REQUIRED", "Chat mutations and parent receipts require one shared transaction.");
    const args = parsed.data;
    const operation = request.operation;
    if (operation === "chat.session.capabilities") return {
      schema: "pkm.chat.session.capabilities/v1", generation: "unavailable", replay: "never",
      storage: "shared-sqlite-runtime-state", limits: CHAT_SESSION_LIMITS,
      unavailable: ["model-provider", "generation", "tool-execution", "automatic-replay", "legacy-root-import", "ui", "attachments"],
    };
    if (operation === "chat.session.list" && "includeArchived" in args) {
      const scope = digest(JSON.stringify(["list", actorId, args.includeArchived]));
      const pin = digest(JSON.stringify(db.prepare("SELECT ordinal,revision FROM chat_sessions WHERE actor_id=? ORDER BY ordinal").all(actorId)));
      const position = args.cursor ? decode(args.cursor, scope) : { after: 0, pin };
      if (position.pin !== pin) throw new CoreError("CURSOR_STALE", "Chat list changed. Restart listing without a cursor.");
      const rows = db.prepare("SELECT ordinal,record FROM chat_sessions WHERE actor_id=? AND ordinal>? ORDER BY ordinal LIMIT ?")
        .all(actorId, position.after, CHAT_SESSION_LIMITS.sessionsPerActor + 1);
      const eligible = rows.map(row => ({ ordinal: Number(row.ordinal), record: parseRecord(row.record) }))
        .filter(row => args.includeArchived || row.record.archivedAt === null);
      const page = eligible.slice(0, args.limit);
      return {
        items: page.map(row => row.record),
        nextCursor: eligible.length > page.length ? encode({ v: 1, scope, after: page.at(-1)!.ordinal, pin }) : null,
      };
    }
    if (operation === "chat.session.create" && "title" in args) {
      if (db.prepare("SELECT 1 FROM chat_sessions WHERE actor_id=? AND id=?").get(actorId, args.id)) throw new CoreError("CONFLICT", "Chat identity already exists.");
      const count = Number(db.prepare("SELECT count(*) AS count FROM chat_sessions WHERE actor_id=?").get(actorId)!.count);
      if (count >= CHAT_SESSION_LIMITS.sessionsPerActor) throw new CoreError("LIMIT_EXCEEDED", "Actor Chat session limit reached.");
      const now = timestamp();
      const record = chatSessionRecord.parse({
        schema: "pkm.chat.session/v1", id: args.id, title: args.title, revision: 1,
        createdAt: now, updatedAt: now, archivedAt: null, messageCount: 0, lastSequence: 0,
        ...(args.metadata ? { metadata: args.metadata } : {}), generation: "unavailable", replay: "never",
      });
      db.prepare("INSERT INTO chat_sessions(actor_id,id,revision,record) VALUES(?,?,?,?)").run(actorId, args.id, 1, JSON.stringify(record));
      return record;
    }
    if (!("id" in args)) throw new CoreError("INVALID_INPUT", "Chat identity is required.");
    const { row, record } = get(actorId, args.id);
    if (operation === "chat.session.get") return record;
    if (operation === "chat.session.messages" && "limit" in args) {
      const scope = digest(JSON.stringify(["messages", actorId, args.id]));
      const cursor = args.cursor ? decode(args.cursor, scope) : undefined;
      if (cursor?.pin !== undefined) throw new CoreError("CURSOR_INVALID", "A transcript cursor cannot contain a list pin.");
      const after = cursor?.after ?? args.afterSequence ?? 0;
      if (after > record.lastSequence) throw new CoreError("CURSOR_LOST", "Cursor is ahead of durable Chat history. Reconcile from sequence zero.");
      const rows = db.prepare("SELECT sequence,id,record FROM chat_session_messages WHERE actor_id=? AND chat_id=? AND sequence>? ORDER BY sequence LIMIT ?")
        .all(actorId, args.id, after, args.limit);
      const items: ChatSessionMessage[] = [];
      let bytes = 0;
      for (const messageRow of rows) {
        const size = Buffer.byteLength(String(messageRow.record));
        if (size > CHAT_SESSION_LIMITS.messageBytes) throw new CoreError("STATE_CORRUPT", "Stored Chat message exceeds its limit.");
        if (bytes + size > CHAT_SESSION_LIMITS.pageBytes) break;
        const message = parseMessage(messageRow.record);
        if (message.sequence !== after + items.length + 1 || message.sequence > record.lastSequence
          || message.id !== messageRow.id || message.sequence !== Number(messageRow.sequence)) {
          throw new CoreError("CURSOR_LOST", "Chat history contains a sequence gap; no shortened history was returned.");
        }
        items.push(message); bytes += size;
      }
      const last = items.at(-1)?.sequence ?? after;
      if (last < record.lastSequence && !items.length) throw new CoreError("CURSOR_LOST", "Durable Chat history is missing; reconcile before continuing.");
      return {
        id: record.id, revision: record.revision, items, nextCursor: encode({ v: 1, scope, after: last }),
        hasMore: last < record.lastSequence, lastSequence: record.lastSequence, replay: "never",
      };
    }
    if (!("expectedRevision" in args) || args.expectedRevision !== record.revision) throw new CoreError("CONFLICT", "Chat revision changed; refresh before retrying.");
    if (db.prepare("SELECT 1 FROM chat_session_turn_reservations WHERE actor_id=? AND chat_id=?").get(actorId, args.id)) {
      throw new CoreError("CONFLICT", "An accepted Chat turn owns this transcript until its terminal observation is durable.");
    }
    if (record.revision >= Number.MAX_SAFE_INTEGER) throw new CoreError("LIMIT_EXCEEDED", "Chat revision is exhausted.");
    const now = timestamp();
    if (operation === "chat.session.archive") {
      if (record.archivedAt !== null) throw new CoreError("CONFLICT", "Chat is already archived.");
      const next = { ...record, revision: record.revision + 1, updatedAt: now, archivedAt: now };
      db.prepare("UPDATE chat_sessions SET revision=?,record=? WHERE actor_id=? AND id=? AND revision=?")
        .run(next.revision, JSON.stringify(next), actorId, args.id, args.expectedRevision);
      return next;
    }
    if (operation === "chat.session.append") {
      const input = chatSessionDefinitions[5].input.parse(request.args);
      if (record.archivedAt !== null) throw new CoreError("CONFLICT", "Archived Chats cannot accept messages.");
      if (record.messageCount >= CHAT_SESSION_LIMITS.messagesPerSession) throw new CoreError("LIMIT_EXCEEDED", "Chat message limit reached; history was not pruned.");
      if (db.prepare("SELECT 1 FROM chat_session_messages WHERE actor_id=? AND chat_id=? AND id=?").get(actorId, input.id, input.message.id)) {
        throw new CoreError("CONFLICT", "Message identity already exists. Replay the parent operation receipt, not the append.");
      }
      const message = chatSessionMessage.parse({
        ...input.message, schema: "pkm.chat.message/v1",
        status: input.message.status === "streaming" ? "interrupted" : input.message.status,
        ...(input.message.toolCalls ? {
          toolCalls: input.message.toolCalls.map(call => call.status === "running" ? {
            ...call, status: "failed", result: call.result || "Recorded execution was interrupted. Effects may already have occurred; automatic replay is disabled.",
          } : call),
        } : {}),
        sequence: record.lastSequence + 1, receivedAt: now, replay: "never",
      });
      const encoded = JSON.stringify(message);
      const bytes = Buffer.byteLength(encoded);
      const actorBytes = Number(db.prepare("SELECT coalesce(sum(message_bytes),0) AS bytes FROM chat_sessions WHERE actor_id=?").get(actorId)!.bytes);
      const reservedBytes = Number(db.prepare("SELECT count(*) AS n FROM chat_session_turn_reservations WHERE actor_id=?").get(actorId)!.n)
        * CHAT_SESSION_LIMITS.messageBytes;
      if (bytes > CHAT_SESSION_LIMITS.messageBytes || Number(row.message_bytes) + bytes > CHAT_SESSION_LIMITS.sessionBytes
        || actorBytes + bytes + reservedBytes > CHAT_SESSION_LIMITS.actorBytes) throw new CoreError("LIMIT_EXCEEDED", "Chat transcript byte limit reached; nothing was pruned.");
      const next = { ...record, revision: record.revision + 1, updatedAt: now, messageCount: record.messageCount + 1, lastSequence: message.sequence };
      db.prepare("INSERT INTO chat_session_messages(actor_id,chat_id,id,sequence,record) VALUES(?,?,?,?,?)").run(actorId, args.id, message.id, message.sequence, encoded);
      db.prepare("UPDATE chat_sessions SET revision=?,message_count=?,message_bytes=message_bytes+?,record=? WHERE actor_id=? AND id=? AND revision=?")
        .run(next.revision, next.messageCount, bytes, JSON.stringify(next), actorId, args.id, args.expectedRevision);
      return { session: next, message };
    }
    throw new CoreError("UNKNOWN_OPERATION", "Unknown Chat session operation.");
  }
  function execute(request: ChatSessionRequest, actorId: string): unknown {
    const readOnly = chatSessionDefinitions.find(value => value.id === request.operation)?.readOnly;
    if (!readOnly || db.isTransaction) return dispatch(request, actorId);
    // Pin summary/sequence reads to one SQLite snapshot across concurrent connections.
    db.exec("BEGIN");
    try {
      const result = dispatch(request, actorId);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const sessionTurns = {
    validate(actor: string, sessionId: string) { get(actor, sessionId); },
    evidence(actor: string, input: ChatTurnStart) {
      const session = get(actor, input.sessionId).record;
      const sources = db.prepare("SELECT record FROM chat_session_messages WHERE actor_id=? AND chat_id=? ORDER BY sequence")
        .all(actor, input.sessionId).map(row => parseMessage(row.record)).filter(message => message.status === "complete");
      return { sessionContext: {
        schema: "pkm.chat.session-context/v1", sessionId: session.id, sessionRevision: session.revision,
        sources: sources.map(message => ({ id: message.id, sequence: message.sequence,
          sha256: digest(message.content) })),
        retrieval: { status: "not-injected", reason: "This session turn uses its actor-owned transcript; runtime index availability is not proof of retrieved prompt context." },
        authority: "native-host-only",
      } };
    },
    accept(actor: string, input: ChatTurnStart): ChatTurnRecord["messages"] | null {
      if (!db.isTransaction) throw new CoreError("TRANSACTION_REQUIRED", "Accept Chat input and its turn atomically.");
      // Opaque raw-turn labels must never bypass an existing actor-owned session.
      if (input.expectedSessionRevision === undefined
        && !db.prepare("SELECT 1 FROM chat_sessions WHERE id=? LIMIT 1").get(input.sessionId)) return null;
      const { record } = get(actor, input.sessionId);
      if (!input.expectedSessionRevision || input.expectedSessionRevision !== record.revision) {
        throw new CoreError("CONFLICT", "Current session revision is required before accepting a turn.");
      }
      if (input.messages.length !== 1 || input.messages[0].role !== "user" || !input.messages[0].content.trim()) {
        throw new CoreError("INVALID_INPUT", "Session turns accept one user input; context is server-owned.");
      }
      const history = db.prepare("SELECT record FROM chat_session_messages WHERE actor_id=? AND chat_id=? ORDER BY sequence")
        .all(actor, input.sessionId).map(row => parseMessage(row.record));
      const messages: ChatTurnRecord["messages"] = history.filter(message => message.status === "complete")
        .map(message => {
          const origin = message.metadata?.retrieval;
          const historicalNotice = origin !== null && typeof origin === "object" && !Array.isArray(origin)
            && origin.schema === "pkm.legacy-chatroom-origin/v1" && origin.messageType === "system";
          return { role: message.role, content: historicalNotice
            ? `[Historical room notice, untrusted data]\n${message.content}` : message.content };
        });
      messages.push({ role: "user", content: input.messages[0].content });
      if (messages.length >= CHAT_TURN_LIMITS.messages
        || Buffer.byteLength(JSON.stringify(messages)) > CHAT_TURN_LIMITS.promptBytes - 2048) {
        throw new CoreError("LIMIT_EXCEEDED", "Session history exceeds the turn context limit; start a new Chat. History was not pruned.");
      }
      execute({ operation: "chat.session.append", args: {
        id: input.sessionId, expectedRevision: record.revision, operationId: input.operationId,
        message: { id: digest(`input:${input.id}`), role: "user", content: input.messages[0].content,
          status: "complete", taskId: input.id, inputOrigin: "local-user" },
      } }, actor);
      const accepted = get(actor, input.sessionId);
      const reserved = Number(db.prepare("SELECT count(*) AS n FROM chat_session_turn_reservations WHERE actor_id=?").get(actor)!.n);
      const actorBytes = Number(db.prepare("SELECT coalesce(sum(message_bytes),0) AS n FROM chat_sessions WHERE actor_id=?").get(actor)!.n);
      if (accepted.record.messageCount + 1 > CHAT_SESSION_LIMITS.messagesPerSession
        || Number(accepted.row.message_bytes) + CHAT_SESSION_LIMITS.messageBytes > CHAT_SESSION_LIMITS.sessionBytes
        || actorBytes + (reserved + 1) * CHAT_SESSION_LIMITS.messageBytes > CHAT_SESSION_LIMITS.actorBytes) {
        throw new CoreError("LIMIT_EXCEEDED", "Chat has no space for a terminal observation; input was not accepted.");
      }
      db.prepare("INSERT INTO chat_session_turn_reservations VALUES(?,?,?)").run(actor, input.sessionId, input.id);
      return messages;
    },
    terminal(turn: ChatTurnRecord) {
      if (!db.isTransaction) throw new CoreError("TRANSACTION_REQUIRED", "Settle Chat transcript and turn atomically.");
      const reservation = db.prepare("SELECT turn_id FROM chat_session_turn_reservations WHERE actor_id=? AND chat_id=?")
        .get(turn.actor, turn.sessionId);
      if (!reservation || reservation.turn_id !== turn.id) throw new CoreError("STATE_CORRUPT", "Terminal Chat observation lost its reservation.");
      const session = get(turn.actor, turn.sessionId).record;
      db.prepare("DELETE FROM chat_session_turn_reservations WHERE actor_id=? AND chat_id=?").run(turn.actor, turn.sessionId);
      const status = turn.status === "completed" ? "complete" : turn.status === "cancelled" ? "cancelled"
        : turn.status === "unknown" ? "interrupted" : "failed";
      // The full bounded output stays in the turn. Reserve a bounded transcript observation even for escaped output.
      let end = turn.output.length;
      if (Buffer.byteLength(JSON.stringify(turn.output)) > CHAT_SESSION_LIMITS.messageBytes - 4096) {
        let low = 0, high = end;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (Buffer.byteLength(JSON.stringify(turn.output.slice(0, middle))) <= CHAT_SESSION_LIMITS.messageBytes - 4096) low = middle;
          else high = middle - 1;
        }
        end = low;
      }
      const content = turn.output.slice(0, end);
      execute({ operation: "chat.session.append", args: {
        id: turn.sessionId, expectedRevision: session.revision, operationId: randomUUID(),
        message: { id: digest(`terminal:${turn.id}`), role: "assistant", content, status, taskId: turn.id,
          ...(turn.failure ? { error: turn.failure } : {}),
          ...(turn.output.length > content.length ? { contextLabels: ["Transcript excerpt; full output is retained in the turn."] } : {}) },
      } }, turn.actor);
    },
  };
  return { execute, sessionTurns };
}
