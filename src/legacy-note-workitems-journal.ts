import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError, type Actor } from "./contracts.js";
import { commandTodoBoard, readTodoBoard } from "./domain/todo-board.js";
import { createTodoApi } from "./domain/todo-api.js";
import { todoDefinitions } from "./todo-definitions.js";
import type { TodoStore } from "./todo-store-contract.js";
import { legacyNoteWorkItemsDefinitions } from "./legacy-note-workitems-contracts.js";

export const LEGACY_NOTE_WORKITEMS_JOURNAL_DDL = `
CREATE TABLE IF NOT EXISTS legacy_note_workitems_intent (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), operation_id TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL, actor_id TEXT NOT NULL, operation TEXT NOT NULL,
  request_json TEXT NOT NULL, native_operation TEXT NOT NULL, native_args TEXT NOT NULL,
  expected_json TEXT NOT NULL, before_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS legacy_note_workitems_receipt (
  operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, actor_id TEXT NOT NULL,
  operation TEXT NOT NULL, actor_json TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS legacy_note_workitems_receipt_no_update BEFORE UPDATE ON legacy_note_workitems_receipt
BEGIN SELECT RAISE(ABORT, 'original Note receipt is immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_note_workitems_receipt_no_delete BEFORE DELETE ON legacy_note_workitems_receipt
BEGIN SELECT RAISE(ABORT, 'original Note receipt is immutable'); END;`;

const receiptSchema = z.strictObject({
  ok: z.literal(true), digest: z.string().regex(/^[a-f0-9]{64}$/),
  items: z.array(z.record(z.string(), z.json())),
});
export { receiptSchema as legacyNoteWorkItemsReceiptSchema };

/**
 * The integrator must fence ALL workspace admissions while an intent exists,
 * including restart recovery. A process-local mutex alone is insufficient.
 * The admission must bind slug to reviewed original Note bytes and the exact
 * native Board bytes, and never implicitly convert or overwrite a Note.
 * invokeNative must preserve the native Core error effect: only a proven
 * not-committed error permits intent removal. Unknown outcomes remain fenced.
 */
export interface LegacyNoteWorkItemsNativeJournal {
  withDurableFence<T>(operationId: string, work: () => Promise<T>): Promise<T>;
  authorize(actor: Readonly<Actor>, operation: string, slug: string): boolean;
  readAdmittedBoard(slug: string): Promise<string>;
  invokeNative(operation: string, args: Record<string, unknown>, actor: Actor): Promise<Record<string, unknown>>;
}

function normalized(raw: string, before: string): string {
  const parsed = JSON.parse(raw), old = JSON.parse(before);
  for (const item of parsed.items) {
    const previous = old.items.find((entry: { id: string }) => entry.id === item.id);
    if (item.history?.length === (previous?.history?.length ?? 0) + 1) item.history[item.history.length - 1].at = "<new-event-time>";
    if (item.comments?.length === (previous?.comments?.length ?? 0) + 1) item.comments[item.comments.length - 1].at = "<new-comment-time>";
  }
  return JSON.stringify(parsed);
}

function translate(raw: string, operation: string, input: Record<string, any>, actor: Actor) {
  const before = readTodoBoard(raw);
  if (input.worker_token !== undefined) throw new CoreError("NOT_AVAILABLE", "Original worker tokens require trusted Board authentication.");
  if (operation.endsWith(".upsert") && actor.id !== "mcp:external") throw new CoreError("ACCESS_DENIED", "Original upsert is bound to mcp:external.");
  const command = operation.endsWith(".upsert")
    ? { action: before.items.some(item => item.id === input.item.id) ? "edit" : "create", item: input.item }
    : input.command;
  if (["accept", "reopen", "assign", "delete", "restore"].includes(command.action))
    throw new CoreError("NOT_AVAILABLE", "This original command cannot use native Board-agent authority.");
  let original: string;
  try { original = commandTodoBoard(raw, input.expected_digest, command, { id: actor.id, role: "worker" }); }
  catch (error) { throw new CoreError("INVALID_ARGUMENT", error instanceof Error ? error.message : String(error)); }
  const base = { board_slug: input.slug, expected_digest: input.expected_digest };
  let name: string, args: Record<string, unknown>;
  if (command.action === "create") {
    const { state: _state, evidence: _evidence, kind: _kind, ...item } = command.item;
    name = "add_workitem"; args = { ...base, item };
  } else if (command.action === "edit") {
    const prior = before.items.find(item => item.id === command.item.id);
    const patch: Record<string, unknown> = {};
    const clear: string[] = [];
    if (JSON.stringify(prior?.links) !== JSON.stringify(command.item.links)) {
      if (command.item.links === undefined) clear.push("links"); else patch.links = command.item.links;
    }
    if (!command.reason) throw new CoreError("NOT_AVAILABLE", "Original edits without a reason cannot preserve native audit.");
    name = "update_workitem"; args = { ...base, id: command.item.id, patch, ...(clear.length ? { clear_fields: clear } : {}), reason: command.reason };
  } else if (command.action === "claim" || command.action === "release") {
    name = `${command.action}_workitem`; args = { ...base, id: command.id, ...(command.reason !== undefined ? { reason: command.reason } : {}) };
  } else if (command.action === "comment") {
    name = "add_workitem_comment"; args = { ...base, id: command.id, text: command.text };
  } else if (command.action === "transition") {
    const states: Record<string, string> = { Planning: "todo", WIP: "active", Blocked: "blocked", OnHold: "on-hold", Done: "completed" };
    name = "change_workitem_state";
    args = { ...base, id: command.id, state: states[command.state],
      ...(command.reason !== undefined ? { reason: command.reason } : {}),
      ...(command.blockedReason !== undefined ? { blocked_reason: command.blockedReason } : {}),
      ...(command.outcome !== undefined ? { outcome: command.outcome } : {}),
      ...(command.evidence !== undefined ? { evidence: command.evidence } : {}),
      ...(command.verification !== undefined ? { verification: command.verification } : {}) };
  } else throw new CoreError("NOT_AVAILABLE", "Original command has no exact native translation.");
  const definition = todoDefinitions.find(item => item.transportName === name)!;
  const nativeArgs = { ...args, operationId: input.operationId };
  if (!definition.input.safeParse(nativeArgs).success) throw new CoreError("NOT_AVAILABLE", "Original arguments do not satisfy the exact native contract.");
  let simulated = raw;
  const store: TodoStore = {
    noteGet: () => ({ title: input.slug.split("/").at(-1), documentKind: "todo-board" }),
    noteWorkItemsRead: () => readTodoBoard(simulated),
    noteWorkItemNotes: () => ({ notes: [], truncated: false }),
    noteWorkItemCommand: (_slug, digest, cmd, who) => { simulated = commandTodoBoard(simulated, digest, cmd, who); return readTodoBoard(simulated); },
    listChats: () => [],
  };
  try { createTodoApi(store).callTodoApi(name, args, actor.id); }
  catch (error) { throw new CoreError("NOT_AVAILABLE", `Native preflight rejected the original command: ${error instanceof Error ? error.message : String(error)}`); }
  if (normalized(original, raw) !== normalized(simulated, raw))
    throw new CoreError("NOT_AVAILABLE", "Original and native command effects or audit bytes differ; no mutation was attempted.");
  return { nativeOperation: definition.id, nativeArgs, expected: normalized(original, raw), before: raw };
}

export function createLegacyNoteWorkItemsJournal(database: DatabaseSync, host: LegacyNoteWorkItemsNativeJournal) {
  return {
    async read(slug: string, actor: Actor) {
      if (typeof slug !== "string" || !slug || slug.length > 1021 || !actor?.id)
        throw new CoreError("INVALID_ARGUMENT", "An authenticated actor and exact admitted Board slug are required.");
      let allowed = false;
      try { allowed = host.authorize(actor, "legacy.note.workitems.read", slug) === true; } catch { /* deny */ }
      if (!allowed) throw new CoreError("ACCESS_DENIED", "Native Note bridge policy denied this actor.");
      return host.withDurableFence("read", async () => {
        if (database.prepare("SELECT 1 FROM legacy_note_workitems_intent WHERE singleton=1").get())
          throw new CoreError("BUSY", "An original Note write requires recovery before reading.", "unknown");
        return { ok: true as const, ...readTodoBoard(await host.readAdmittedBoard(slug)) };
      });
    },
    async dispatch(operation: string, input: unknown, actor: Actor) {
      const entry = legacyNoteWorkItemsDefinitions.find(definition => definition.id === operation && !definition.readOnly);
      if (!entry) throw new CoreError("NOT_FOUND", "Unknown original Note write.");
      const parsed = entry.input.safeParse(input);
      if (!parsed.success) throw new CoreError("INVALID_ARGUMENT", "Invalid original Note write arguments.");
      const args = parsed.data as Record<string, any>;
      if (!actor?.id || !actor.canWrite) throw new CoreError("ACCESS_DENIED", "Authenticated workspace write authority is required.");
      let allowed = false;
      try { allowed = host.authorize(actor, operation, args.slug) === true; } catch { /* deny */ }
      if (!allowed) throw new CoreError("ACCESS_DENIED", "Native Note bridge policy denied this actor.");
      const fingerprint = createHash("sha256").update(JSON.stringify({ operation, actor, args })).digest("hex");
      return host.withDurableFence(args.operationId, async () => {
        const receipt = database.prepare("SELECT * FROM legacy_note_workitems_receipt WHERE operation_id=?").get(args.operationId);
        if (receipt) {
          if (receipt.fingerprint !== fingerprint || receipt.actor_id !== actor.id || receipt.operation !== operation
            || receipt.actor_json !== JSON.stringify(actor) || receipt.request_json !== JSON.stringify(args))
            throw new CoreError("CONFLICT", "Original operation ID belongs to another request or actor.");
          return receiptSchema.parse(JSON.parse(String(receipt.result_json)));
        }
        let intent = database.prepare("SELECT * FROM legacy_note_workitems_intent WHERE singleton=1").get();
        if (intent && (intent.operation_id !== args.operationId || intent.fingerprint !== fingerprint
          || intent.actor_id !== actor.id || intent.operation !== operation || intent.request_json !== JSON.stringify(args)))
          throw new CoreError("BUSY", "A different original Note intent requires recovery.", "unknown");
        if (!intent) {
          const before = await host.readAdmittedBoard(args.slug);
          const plan = translate(before, operation, args, actor);
          database.prepare(`INSERT INTO legacy_note_workitems_intent VALUES(1,?,?,?,?,?,?,?,?,?)`).run(
            args.operationId, fingerprint, actor.id, operation, JSON.stringify(args), plan.nativeOperation,
            JSON.stringify(plan.nativeArgs), plan.expected, plan.before);
          intent = database.prepare("SELECT * FROM legacy_note_workitems_intent WHERE singleton=1").get()!;
        }
        let nativeResult: Record<string, unknown>;
        try { nativeResult = await host.invokeNative(String(intent.native_operation), JSON.parse(String(intent.native_args)), actor); }
        catch (error) {
          if (error instanceof CoreError && error.effect === "not-committed") {
            database.prepare("DELETE FROM legacy_note_workitems_intent WHERE singleton=1 AND fingerprint=?").run(fingerprint);
          }
          throw error;
        }
        const after = await host.readAdmittedBoard(args.slug);
        const snapshot = readTodoBoard(after);
        if (nativeResult.digest !== snapshot.digest || normalized(after, String(intent.before_json)) !== intent.expected_json)
          throw new CoreError("RECOVERY_CONFLICT", "Native result or Board differs from the original preflight; retain the intent for reconciliation.", "unknown");
        const result = receiptSchema.parse({ ok: true, ...snapshot });
        database.exec("BEGIN IMMEDIATE");
        try {
          database.prepare("INSERT INTO legacy_note_workitems_receipt VALUES(?,?,?,?,?,?,?)").run(
            args.operationId, fingerprint, actor.id, operation, JSON.stringify(actor), JSON.stringify(args), JSON.stringify(result));
          database.prepare("DELETE FROM legacy_note_workitems_intent WHERE singleton=1 AND fingerprint=?").run(fingerprint);
          database.exec("COMMIT");
        } catch (error) { database.exec("ROLLBACK"); throw error; }
        return result;
      });
    },
  };
}
