import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ChatTurnStore } from "../dist/chat-turn-store.js";
import { ChatTurnService } from "../dist/chat-turn.js";
import { createChatSessionStore, initializeChatSessionSchema } from "../dist/chat-session.js";

export function chatTurnInput(extra = {}) {
  return {
    id: randomUUID(), sessionId: "synthetic-session", operationId: randomUUID(), expectedRevision: 0,
    messages: [{ role: "user", content: "Use the synthetic tool, then summarize." }],
    maxSteps: 4, maxOutputTokens: 4096, maxInputTokens: 65536, maxTotalOutputTokens: 16384, deadlineMs: 5000,
    ...extra,
  };
}
/** Native storage fixture: the same connection holds turn state and the parent's operation receipts. */
export function chatTurnFixture(options = {}) {
  const db = options.db ?? new DatabaseSync(options.path ?? ":memory:");
  const transaction = fn => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  transaction(() => db.exec(`CREATE TABLE IF NOT EXISTS synthetic_parent_receipts(
    actor TEXT NOT NULL,operation_id TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(actor,operation_id))`));
  let sessions;
  if (options.sessionBacked) {
    transaction(() => initializeChatSessionSchema(db));
    sessions = createChatSessionStore(db);
  }
  const store = new ChatTurnStore(db, {
    receipt(receipt) {
      if (!db.isTransaction) throw new Error("Parent receipt must be atomic.");
      db.prepare("INSERT INTO synthetic_parent_receipts VALUES(?,?,?)").run(receipt.actor, receipt.operationId, receipt.fingerprint);
      options.receipt?.(receipt);
    },
    ...(options.now ? { now: options.now } : {}),
    ...(sessions ? { session: sessions.sessionTurns } : {}),
  });
  transaction(() => store.initialize());
  const service = new ChatTurnService({ store, transaction, model: options.model, tools: options.tools,
    ...(options.now ? { now: options.now } : {}), ...(options.admitPrompt ? { admitPrompt: options.admitPrompt } : {}) });
  return { db, store, service, transaction, sessions };
}
export function chatTurnEvents(service, actor, id) {
  let after = 0;
  const all = [];
  for (;;) {
    const page = service.events(actor, id, after, 3);
    all.push(...page.events);
    if (page.next === null) return all;
    after = page.next;
  }
}
