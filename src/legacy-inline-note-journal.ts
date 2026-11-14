import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError, type Actor } from "./contracts.js";
import type { WorkItemActor } from "./domain/note-work-items.js";
import { inspectLegacyInlineNote, reduceLegacyInlineNote } from "./domain/legacy-inline-note-reducer.js";
import { legacyInlineNoteDefinitions, legacyInlineNoteReceiptSchema, type LegacyInlineNoteReceipt } from "./legacy-inline-note-contracts.js";

export const LEGACY_INLINE_NOTE_JOURNAL_DDL = `
CREATE TABLE IF NOT EXISTS legacy_inline_note_intent (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 operation_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS legacy_inline_note_receipt (
 operation_id TEXT PRIMARY KEY, payload TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS legacy_inline_note_receipt_no_update BEFORE UPDATE ON legacy_inline_note_receipt
BEGIN SELECT RAISE(ABORT, 'inline Note receipt is immutable'); END;
CREATE TRIGGER IF NOT EXISTS legacy_inline_note_receipt_no_delete BEFORE DELETE ON legacy_inline_note_receipt
BEGIN SELECT RAISE(ABORT, 'inline Note receipt is immutable'); END;`;

export interface LegacyInlineNoteJournalHost {
  /** Sole owner must serialize and durably fence ALL workspace reads/writes,
   * import, backup and recovery, not just this adapter. FS must not run in SQL transactions. */
  withDurableFence<T>(operationId: string, work: () => Promise<T>): Promise<T>;
  authorize(actor: Readonly<Actor>, operation: string, slug: string): WorkItemActor | undefined;
  readAdmittedNote(slug: string): Promise<string>;
  writeExactNote(slug: string, before: string, after: string): Promise<void>;
  /** Full workspace authoritative focus check; no implicit takeover. */
  assertFocus(actor: Readonly<Actor>, slug: string, before: string, after: string): Promise<void>;
  now(): string;
}
const actorSchema = z.strictObject({ id: z.string().min(1), role: z.enum(["user", "worker"]) });
const entrySchema = z.strictObject({
  operationId: z.string().uuid(), operation: z.enum(["legacy.note.workitems.command", "legacy.note.workitems.upsert"]),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), request: z.record(z.string(), z.json()),
  actor: actorSchema, at: z.string(), before: z.string(), after: z.string(),
  result: legacyInlineNoteReceiptSchema,
});
type Entry = z.infer<typeof entrySchema>;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function parseRequest(operation: string, input: unknown): Record<string, any> {
  const definition = legacyInlineNoteDefinitions.find(item => item.id === operation);
  if (!definition) throw new CoreError("NOT_FOUND", "Unknown original inline Note write.");
  const parsed = definition.input.safeParse(input);
  if (!parsed.success || JSON.stringify(input).length > 64000)
    throw new CoreError("INVALID_ARGUMENT", "Invalid bounded strict original inline Note request.");
  if ("worker_token" in parsed.data)
    throw new CoreError("NOT_AVAILABLE", "Tokens authenticate dedicated Boards only; filestore.ts:597-612. No inline token authority.");
  return parsed.data;
}
function command(entry: Pick<Entry, "operation" | "request" | "before">) {
  return entry.operation.endsWith(".upsert") ? {
    action: inspectLegacyInlineNote(entry.before).items.some(item => item.id === (entry.request.item as { id: string }).id) ? "edit" : "create",
    item: entry.request.item,
  } : entry.request.command;
}
function checkedEntry(payload: unknown, operationId: unknown): Entry {
  try {
    if (typeof payload !== "string") throw new Error("Invalid payload.");
    const entry = entrySchema.parse(JSON.parse(payload));
    const request = parseRequest(entry.operation, entry.request);
    if (entry.operationId !== operationId || entry.request.operationId !== operationId
      || entry.fingerprint !== hash({ operation: entry.operation, request, actor: entry.actor })
      || (entry.operation.endsWith(".upsert") && (entry.actor.id !== "mcp:external" || entry.actor.role !== "worker"))
      || canonical(request) !== canonical(entry.request)
      || reduceLegacyInlineNote(entry.before, String(entry.request.expected_digest), command(entry), entry.actor, entry.at) !== entry.after
      || canonical(entry.result) !== canonical({ ok: true, ...inspectLegacyInlineNote(entry.after) }))
      throw new Error("Stored inline Note effect does not replay exactly.");
    return entry;
  } catch (error) { throw new CoreError("STORAGE_ERROR", `Corrupt original inline Note journal: ${String(error)}`, "unknown"); }
}
export function inspectLegacyInlineNoteFence(database: DatabaseSync) {
  const rows = database.prepare("SELECT operation_id,payload FROM legacy_inline_note_intent").all();
  if (rows.length > 1) throw new CoreError("STORAGE_ERROR", "Ambiguous inline Note intents.", "unknown");
  return rows[0] ? checkedEntry(rows[0].payload, rows[0].operation_id) : undefined;
}
export function assertLegacyInlineNoteWorkspaceUnfenced(database: DatabaseSync) {
  if (inspectLegacyInlineNoteFence(database))
    throw new CoreError("RECOVERY_REQUIRED", "Workspace is fenced by unresolved original inline Note write.", "unknown");
}
export function inspectLegacyInlineNoteHistory(database: DatabaseSync, slug: string, genesisDigest: string) {
  const entries = database.prepare("SELECT operation_id,payload FROM legacy_inline_note_receipt").all()
    .map(row => checkedEntry(row.payload, row.operation_id)).filter(entry => entry.request.slug === slug);
  const remaining = new Set(entries);
  let head = genesisDigest;
  while (remaining.size) {
    const next = [...remaining].filter(entry => inspectLegacyInlineNote(entry.before).digest === head);
    if (next.length !== 1) throw new CoreError("STORAGE_ERROR", "Inline Note history is disconnected or forked.", "unknown");
    head = next[0].result.digest;
    remaining.delete(next[0]);
  }
  const pending = inspectLegacyInlineNoteFence(database);
  if (pending?.request.slug === slug && inspectLegacyInlineNote(pending.before).digest !== head)
    throw new CoreError("STORAGE_ERROR", "Pending inline intent does not continue exact source lineage.", "unknown");
  return { head, pending };
}
function transaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try { const result = work(); database.exec("COMMIT"); return result; }
  catch (error) { database.exec("ROLLBACK"); throw error; }
}
export function createLegacyInlineNoteJournal(database: DatabaseSync, host: LegacyInlineNoteJournalHost) {
  function authorize(actor: Actor, operation: string, slug: string) {
    if (!actor?.id || actor.canWrite !== true) throw new CoreError("ACCESS_DENIED", "Current authenticated writable actor required.");
    let authority: WorkItemActor | undefined;
    try { authority = host.authorize(actor, operation, slug); } catch { /* default deny */ }
    const parsed = actorSchema.safeParse(authority);
    if (!parsed.success || parsed.data.id !== actor.id
      || (parsed.data.role === "user" && actor.collaborationKind !== "human")
      || (operation.endsWith(".upsert") && (actor.id !== "mcp:external" || parsed.data.role !== "worker")))
      throw new CoreError("ACCESS_DENIED", "Trusted current host authority denied original inline Note write.");
    return parsed.data;
  }
  function receipt(operationId: string) {
    const row = database.prepare("SELECT payload FROM legacy_inline_note_receipt WHERE operation_id=?").get(operationId);
    return row ? checkedEntry(row.payload, operationId) : undefined;
  }
  function finish(entry: Entry): LegacyInlineNoteReceipt {
    return transaction(database, () => {
      const pending = inspectLegacyInlineNoteFence(database);
      if (!pending || canonical(pending) !== canonical(entry)) throw new CoreError("STORAGE_ERROR", "Inline intent changed.", "unknown");
      const previous = receipt(entry.operationId);
      if (previous && canonical(previous) !== canonical(entry)) throw new CoreError("CONFLICT", "Inline receipt differs.", "unknown");
      if (!previous) database.prepare("INSERT INTO legacy_inline_note_receipt VALUES (?,?)").run(entry.operationId, JSON.stringify(entry));
      database.prepare("DELETE FROM legacy_inline_note_intent WHERE operation_id=?").run(entry.operationId);
      return entry.result;
    });
  }
  async function apply(entry: Entry, actor: Actor) {
    const authority = authorize(actor, entry.operation, String(entry.request.slug));
    if (canonical(authority) !== canonical(entry.actor))
      throw new CoreError("ACCESS_DENIED", "Current host authority no longer matches the original inline intent.");
    let current: string;
    try { current = await host.readAdmittedNote(String(entry.request.slug)); }
    catch (error) { throw new CoreError("RECOVERY_REQUIRED", `Cannot verify pending original Note: ${String(error)}`, "unknown"); }
    if (current !== entry.before && current !== entry.after)
      throw new CoreError("RECOVERY_REQUIRED", "Inline Note is neither exact before nor after (external/partial write); no effects attempted.", "unknown");
    if (current === entry.before) {
      await host.assertFocus(actor, String(entry.request.slug), entry.before, entry.after);
      try { await host.writeExactNote(String(entry.request.slug), entry.before, entry.after); }
      catch (error) { throw new CoreError("RECOVERY_REQUIRED", `Inline write outcome requires exact recovery: ${String(error)}`, "unknown"); }
    }
    try {
      if (await host.readAdmittedNote(String(entry.request.slug)) !== entry.after) throw new Error("Exact after bytes absent.");
    } catch (error) { throw new CoreError("RECOVERY_REQUIRED", `Inline write verification failed: ${String(error)}`, "unknown"); }
    return finish(entry);
  }
  return {
    inspect: () => inspectLegacyInlineNoteFence(database),
    async dispatch(operation: string, input: unknown, actor: Actor): Promise<LegacyInlineNoteReceipt> {
      const request = parseRequest(operation, input);
      const authority = authorize(actor, operation, request.slug);
      return host.withDurableFence(request.operationId, async () => {
        if (canonical(authorize(actor, operation, request.slug)) !== canonical(authority))
          throw new CoreError("ACCESS_DENIED", "Original inline actor authority changed before workspace admission.");
        const pending = inspectLegacyInlineNoteFence(database);
        if (pending) throw new CoreError("RECOVERY_REQUIRED", "Resolve existing inline intent before workspace admission.", "unknown");
        const fingerprint = hash({ operation, request, actor: authority });
        const prior = receipt(request.operationId);
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new CoreError("CONFLICT", "Operation ID already binds a different actor or request.");
          return prior.result;
        }
        const before = await host.readAdmittedNote(request.slug);
        const at = host.now();
        const partial = { operation: operation as Entry["operation"], request, before };
        const after = reduceLegacyInlineNote(before, request.expected_digest, command(partial), authority, at);
        await host.assertFocus(actor, request.slug, before, after);
        const entry: Entry = { operationId: request.operationId, ...partial, fingerprint, actor: authority,
          at, after, result: { ok: true, ...inspectLegacyInlineNote(after) } };
        transaction(database, () => {
          assertLegacyInlineNoteWorkspaceUnfenced(database);
          if (receipt(request.operationId)) throw new CoreError("CONFLICT", "Concurrent original inline receipt.");
          database.prepare("INSERT INTO legacy_inline_note_intent VALUES (1,?,?)").run(entry.operationId, JSON.stringify(entry));
        });
        return apply(entry, actor);
      });
    },
    async resume(operationId: string, actor: Actor): Promise<LegacyInlineNoteReceipt> {
      if (!z.string().uuid().safeParse(operationId).success)
        throw new CoreError("INVALID_ARGUMENT", "Exact original inline recovery operation ID required.");
      return host.withDurableFence(operationId, async () => {
        const pending = inspectLegacyInlineNoteFence(database);
        if (!pending || pending.operationId !== operationId) throw new CoreError("NOT_FOUND", "No matching inline Note recovery intent.");
        const authority = authorize(actor, pending.operation, String(pending.request.slug));
        if (canonical(authority) !== canonical(pending.actor)) throw new CoreError("ACCESS_DENIED", "Recovery must retain exact original actor authority.");
        return apply(pending, actor);
      });
    },
  };
}
