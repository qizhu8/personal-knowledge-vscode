import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CHAT_TURN_LIMITS, chatTurnStartInput, chatTurnTerminal, chatTurnRecordSchema,
  type ChatTurnEvent, type ChatTurnRecord, type ChatTurnStart,
} from "./chat-turn-contracts.js";

export class ChatTurnError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ChatTurnError"; }
}
export const chatTurnDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function chatTurnBytes(value: unknown) { return Buffer.byteLength(JSON.stringify(value)); }
export function chatTurnActor(actor: string) {
  if (typeof actor !== "string" || !actor.trim() || Buffer.byteLength(actor) > 256 || /[\u0000-\u001f]/u.test(actor))
    throw new ChatTurnError("UNAUTHORIZED");
}
const operation = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new ChatTurnError("INVALID_OPERATION_ID");
};
export interface ChatTurnReceipt {
  actor: string; operationId: string; operation: string; fingerprint: string; result: ChatTurnRecord;
}
export interface ChatTurnPersistentStore {
  get(actor: string, id: string): ChatTurnRecord;
  create(actor: string, input: ChatTurnStart): { record: ChatTurnRecord; replayed: boolean };
  change(actor: string, id: string, revision: number, operationId: string, type: string,
    data: Record<string, unknown>, mutate: (record: ChatTurnRecord) => void): ChatTurnRecord;
  events(actor: string, id: string, after?: number, limit?: number): { events: ChatTurnEvent[]; next: number | null };
  list?(actor: string, sessionId: string, after?: string, limit?: number): { items: ChatTurnRecord[]; next: string | null };
  uncertain?(): number;
  interrupted(): { actor: string; id: string; revision: number }[];
}

/**
 * Uses only the supplied shared connection. Mutations require the parent's synchronous
 * transaction; receipt sink is called in that same transaction and must not await.
 */
export class ChatTurnStore implements ChatTurnPersistentStore {
  constructor(private readonly db: DatabaseSync, private readonly options: {
    receipt: (receipt: ChatTurnReceipt) => void; now?: () => number;
    session?: {
      accept(actor: string, input: ChatTurnStart): ChatTurnRecord["messages"] | null;
      evidence?(actor: string, input: ChatTurnStart): Record<string, unknown>;
      terminal(record: ChatTurnRecord): void;
      validate(actor: string, sessionId: string): void;
    };
  }) {}
  initialize() {
    this.transaction();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_turn_schema(version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_turn_records(
        actor TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,record TEXT NOT NULL,
        PRIMARY KEY(actor,id));
      CREATE TABLE IF NOT EXISTS chat_turn_events(
        actor TEXT NOT NULL,turn_id TEXT NOT NULL,sequence INTEGER NOT NULL,record TEXT NOT NULL,
        PRIMARY KEY(actor,turn_id,sequence));
      CREATE TABLE IF NOT EXISTS chat_turn_receipts(
        actor TEXT NOT NULL,operation_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,
        PRIMARY KEY(actor,operation_id));
    `);
    const versions = this.db.prepare("SELECT version FROM chat_turn_schema").all();
    if (!versions.length) this.db.prepare("INSERT INTO chat_turn_schema VALUES(1)").run();
    else if (versions.length !== 1 || versions[0].version !== 1) throw new ChatTurnError("UNSUPPORTED_SCHEMA");
  }
  private transaction() {
    if (!this.db.isTransaction) throw new ChatTurnError("TRANSACTION_REQUIRED");
  }
  private now() {
    const now = this.options.now?.() ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new ChatTurnError("INVALID_TIME");
    return now;
  }
  get(actor: string, id: string): ChatTurnRecord {
    chatTurnActor(actor);
    const row = this.db.prepare("SELECT record,revision,status FROM chat_turn_records WHERE actor=? AND id=?").get(actor, id);
    if (!row) throw new ChatTurnError("NOT_FOUND");
    let record: ChatTurnRecord;
    try { record = chatTurnRecordSchema.parse(JSON.parse(String(row.record))); }
    catch { throw new ChatTurnError("STATE_CORRUPT"); }
    if (record.schema !== "pkm.chat.turn/v1" || record.actor !== actor || record.id !== id
      || record.revision !== row.revision || record.status !== row.status || record.lastSequence !== record.revision)
      throw new ChatTurnError("STATE_CORRUPT");
    return record;
  }
  private replay(actor: string, operationId: string, fingerprint: string) {
    const row = this.db.prepare("SELECT * FROM chat_turn_receipts WHERE actor=? AND operation_id=?").get(actor, operationId);
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new ChatTurnError("OPERATION_CONFLICT");
    return JSON.parse(String(row.result)) as ChatTurnRecord;
  }
  private save(record: ChatTurnRecord, operationId: string, type: string, data: Record<string, unknown>, fingerprint: string) {
    if (!chatTurnRecordSchema.safeParse(record).success || chatTurnBytes(record) > CHAT_TURN_LIMITS.recordBytes
      || record.revision > CHAT_TURN_LIMITS.events)
      throw new ChatTurnError("STATE_LIMIT");
    const event: ChatTurnEvent = {
      sequence: record.revision, turnId: record.id, revision: record.revision, type,
      operationId, at: record.updatedAt, data,
    };
    if (chatTurnBytes(event) > CHAT_TURN_LIMITS.eventBytes) throw new ChatTurnError("EVENT_LIMIT");
    this.db.prepare(`INSERT INTO chat_turn_records VALUES(?,?,?,?,?)
      ON CONFLICT(actor,id) DO UPDATE SET revision=excluded.revision,status=excluded.status,record=excluded.record`)
      .run(record.actor, record.id, record.revision, record.status, JSON.stringify(record));
    this.db.prepare("INSERT INTO chat_turn_events VALUES(?,?,?,?)").run(record.actor, record.id, event.sequence, JSON.stringify(event));
    this.db.prepare("INSERT INTO chat_turn_receipts VALUES(?,?,?,?)")
      .run(record.actor, operationId, fingerprint, JSON.stringify(record));
    if (record.sessionBacked && chatTurnTerminal(record.status)) this.options.session?.terminal(record);
    const receipt = this.options.receipt({
      actor: record.actor, operationId, operation: `chat.turn.${type}`, fingerprint,
      result: structuredClone(record),
    }) as unknown;
    if (receipt && typeof (receipt as { then?: unknown }).then === "function") throw new ChatTurnError("ASYNC_RECEIPT_FORBIDDEN");
    return structuredClone(record);
  }
  create(actor: string, input: ChatTurnStart) {
    this.transaction(); chatTurnActor(actor); operation(input.operationId);
    const parsed = chatTurnStartInput.safeParse(input);
    if (!parsed.success || chatTurnBytes(input) > CHAT_TURN_LIMITS.requestBytes) throw new ChatTurnError("INVALID_INPUT");
    input = parsed.data;
    const fingerprint = chatTurnDigest(["start", input]);
    const replay = this.replay(actor, input.operationId, fingerprint);
    if (replay) return { record: replay, replayed: true };
    if (this.db.prepare("SELECT 1 FROM chat_turn_records WHERE actor=? AND id=?").get(actor, input.id)) throw new ChatTurnError("CONFLICT");
    const count = this.db.prepare("SELECT count(*) AS n FROM chat_turn_records WHERE actor=?").get(actor)!.n;
    if (Number(count) >= CHAT_TURN_LIMITS.turnsPerActor) throw new ChatTurnError("TURN_LIMIT");
    const now = this.now();
    const accepted = this.options.session?.accept(actor, input);
    const sessionBacked = accepted !== undefined && accepted !== null;
    const messages = accepted ?? input.messages;
    const { maxSteps, maxOutputTokens, maxInputTokens, maxTotalOutputTokens } = input;
    const record: ChatTurnRecord = {
      schema: "pkm.chat.turn/v1", actor, id: input.id, sessionId: input.sessionId, revision: 1,
      ...(sessionBacked ? { sessionBacked: true as const } : {}),
      contextDigest: chatTurnDigest([actor, input.sessionId, input.id, messages, input.maxSteps,
        input.maxOutputTokens, input.maxInputTokens, input.maxTotalOutputTokens]),
      status: "queued", replay: "never", createdAt: now, updatedAt: now, deadline: now + input.deadlineMs,
      messages, output: "", step: 0, toolCount: 0, outputBytes: 0,
      inputTokens: 0, outputTokens: 0, bounds: { maxSteps, maxOutputTokens, maxInputTokens, maxTotalOutputTokens },
      pendingTool: null, failure: null, uncertain: false, lastSequence: 1,
    };
    return { record: this.save(record, input.operationId, "start",
      sessionBacked ? this.options.session?.evidence?.(actor, input) ?? {} : {}, fingerprint), replayed: false };
  }
  change(actor: string, id: string, revision: number, operationId: string, type: string,
    data: Record<string, unknown>, mutate: (record: ChatTurnRecord) => void) {
    this.transaction(); chatTurnActor(actor); operation(operationId);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new ChatTurnError("INVALID_REVISION");
    const fingerprint = chatTurnDigest([id, revision, type, data]);
    const replay = this.replay(actor, operationId, fingerprint);
    if (replay) return replay;
    const record = this.get(actor, id);
    if (record.revision !== revision) throw new ChatTurnError("REVISION_CONFLICT");
    if (chatTurnTerminal(record.status)) throw new ChatTurnError("TURN_TERMINAL");
    if (!["failed", "cancel", "interrupted", "complete"].includes(type) && record.revision >= CHAT_TURN_LIMITS.events - 2)
      throw new ChatTurnError("EVENT_LIMIT");
    const mutation = mutate(record) as unknown;
    if (mutation && typeof (mutation as { then?: unknown }).then === "function") throw new ChatTurnError("ASYNC_MUTATION_FORBIDDEN");
    if (record.actor !== actor || record.id !== id || record.revision !== revision) throw new ChatTurnError("IMMUTABLE_IDENTITY");
    record.revision++; record.lastSequence = record.revision; record.updatedAt = this.now();
    return this.save(record, operationId, type, data, fingerprint);
  }
  events(actor: string, id: string, after = 0, limit = 20) {
    const record = this.get(actor, id);
    if (!Number.isSafeInteger(after) || after < 0 || after > record.lastSequence
      || !Number.isSafeInteger(limit) || limit < 1 || limit > CHAT_TURN_LIMITS.pageItems) throw new ChatTurnError("INVALID_CURSOR");
    const rows = this.db.prepare("SELECT record FROM chat_turn_events WHERE actor=? AND turn_id=? AND sequence>? ORDER BY sequence LIMIT ?")
      .all(actor, id, after, limit + 1);
    const events: ChatTurnEvent[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const event = JSON.parse(String(row.record)) as ChatTurnEvent;
      const size = chatTurnBytes(event);
      if (bytes + size > CHAT_TURN_LIMITS.pageBytes) break;
      events.push(event); bytes += size;
    }
    return { events, next: rows.length > events.length ? events.at(-1)!.sequence : null };
  }
  interrupted() {
    return this.db.prepare("SELECT actor,id,revision FROM chat_turn_records WHERE status IN ('queued','model','tool','approval')")
      .all() as unknown as { actor: string; id: string; revision: number }[];
  }
  list(actor: string, sessionId: string, after?: string, limit = 20) {
    chatTurnActor(actor);
    this.options.session?.validate(actor, sessionId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CHAT_TURN_LIMITS.pageItems) throw new ChatTurnError("INVALID_CURSOR");
    let position = 0;
    if (after !== undefined) {
      const previous = this.get(actor, after);
      if (previous.sessionId !== sessionId || (this.options.session && !previous.sessionBacked))
        throw new ChatTurnError("INVALID_CURSOR");
      position = Number(this.db.prepare("SELECT rowid AS position FROM chat_turn_records WHERE actor=? AND id=?").get(actor, after)!.position);
    }
    const rows = this.db.prepare(`SELECT id FROM chat_turn_records WHERE actor=? AND rowid>? AND json_extract(record,'$.sessionId')=?
      ${this.options.session ? "AND json_extract(record,'$.sessionBacked')=1" : ""} ORDER BY rowid LIMIT ?`)
      .all(actor, position, sessionId, CHAT_TURN_LIMITS.turnsPerActor);
    const items: ChatTurnRecord[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const item = this.get(actor, String(row.id));
      const size = chatTurnBytes(item);
      if (items.length && bytes + size > CHAT_TURN_LIMITS.recordBytes) break;
      items.push(item); bytes += size;
    }
    return { items, next: rows.length > items.length ? items.at(-1)!.id : null };
  }
  uncertain() {
    return Number(this.db.prepare("SELECT count(*) AS n FROM chat_turn_records WHERE status='unknown' OR json_extract(record,'$.pendingTool') IS NOT NULL").get()!.n);
  }
}
