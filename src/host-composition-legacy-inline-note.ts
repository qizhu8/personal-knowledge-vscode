import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { CoreError, type Actor } from "./contracts.js";
import { checkedDocumentPath } from "./document-path.js";
import type { Storage } from "./storage.js";
import { createNativeLegacyInlineNoteHost, type LegacyInlineNoteNativePolicy } from "./legacy-inline-note-native.js";
import { inspectLegacyInlineNoteFence, inspectLegacyInlineNoteHistory } from "./legacy-inline-note-journal.js";
import { inspectLegacyInlineNote } from "./domain/legacy-inline-note-reducer.js";
import { assertSharedSourceRecoveryScope, inspectPausedSnapshotJournal } from "./host-composition-legacy-snapshot-restore.js";

const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value);
export interface NativeLegacyInlineNotePolicy extends LegacyInlineNoteNativePolicy {
  now?(): string;
}
export async function verifyInlineNoteWorkspace(database: DatabaseSync, root: string): Promise<void> {
  if (database.isTransaction) throw new CoreError("TRANSACTION_BOUNDARY", "Inline source verification requires no SQL transaction.");
  const pending = inspectLegacyInlineNoteFence(database);
  if (pending) throw new CoreError("RECOVERY_REQUIRED", "Unresolved inline Note blocks backup/recovery effects.", "unknown");
  const slugs = new Map<string, Array<{ before: string; result: { digest: string }; operationId: string; actor: { id: string }; fingerprint: string }>>();
  for (const row of database.prepare("SELECT operation_id,payload FROM legacy_inline_note_receipt").all()) {
    const entry = JSON.parse(String(row.payload));
    const entries = slugs.get(entry.request.slug) ?? [];
    entries.push(entry); slugs.set(entry.request.slug, entries);
    const global = database.prepare("SELECT actor_id,fingerprint FROM receipts WHERE operation_id=?").get(row.operation_id!);
    if (!global || global.actor_id !== entry.actor.id || global.fingerprint !== entry.fingerprint)
      throw new CoreError("RECOVERY_CONFLICT", "Inline Note global receipt changed.", "unknown");
  }
  for (const [slug, entries] of slugs) {
    const genesis = entries.filter(entry => !entries.some(prior => prior.result.digest === inspectLegacyInlineNote(entry.before).digest));
    if (genesis.length !== 1) throw new CoreError("RECOVERY_CONFLICT", "Inline Note source lineage is ambiguous.", "unknown");
    const { head } = inspectLegacyInlineNoteHistory(database, slug, inspectLegacyInlineNote(genesis[0]!.before).digest);
    const text = await readFile(checkedDocumentPath(root, `${slug}.md`, false), "utf8");
    if (inspectLegacyInlineNote(text).digest !== head) throw new CoreError("RECOVERY_CONFLICT", "Inline Note bytes differ from durable history.", "unknown");
  }
}

export function createNativeInlineNoteComposition(
  storage: Storage, database: DatabaseSync, policy: NativeLegacyInlineNotePolicy,
  assertOwner: () => void, assertAvailable: (operationId: string) => void,
) {
  const composition = createNativeLegacyInlineNoteHost({
    database, root: storage.workspaceRoot(), policy, now: policy.now,
    withDurableFence: (operationId, work) => storage.withWorkspaceExclusive(async () => {
      assertOwner();
      const pending = inspectLegacyInlineNoteFence(database);
      if (!pending) assertAvailable(operationId);
      else {
        if (pending.operationId !== operationId) throw new CoreError("RECOVERY_REQUIRED", "Another inline Note intent is unresolved.", "unknown");
        assertSharedSourceRecoveryScope(database, true);
        if (inspectPausedSnapshotJournal(database)) throw new CoreError("RECOVERY_REQUIRED", "Snapshot confirmation must finish before inline recovery.", "unknown");
      }
      return work();
    }),
  });
  return {
    admitted(slug: unknown) { return policy.admissions.some(item => item.slug === slug); },
    async read(slug: string, actor: Actor) {
      return storage.withWorkspaceExclusive(async () => {
        assertOwner(); assertAvailable("inline-note-read");
        const authority = policy.authorize?.(Object.freeze({ ...actor }), "legacy.note.workitems.read", slug);
        if (!authority || authority.id !== actor.id
          || !["user", "worker"].includes(authority.role)
          || (authority.role === "user" && actor.collaborationKind !== "human"))
          throw new CoreError("ACCESS_DENIED", "Trusted native authority denied original inline Note read.");
        const text = await composition.host.readAdmittedNote(slug);
        const current = policy.authorize?.(Object.freeze({ ...actor }), "legacy.note.workitems.read", slug);
        if (canonical(current) !== canonical(authority)) throw new CoreError("ACCESS_DENIED", "Inline read authority changed.");
        assertOwner();
        return { ok: true as const, ...inspectLegacyInlineNote(text) };
      });
    },
    async dispatch(operation: string, args: Record<string, unknown>, actor: Actor) {
      try {
        const pending = inspectLegacyInlineNoteFence(database);
        if (pending) {
          if (pending.operation !== operation || canonical(pending.request) !== canonical(args))
            throw new CoreError("CONFLICT", "Recovery requires the identical original inline Note request.", "unknown");
          return await composition.journal.resume(String(args.operationId), actor);
        }
        return await composition.journal.dispatch(operation, args, actor);
      } catch (error) {
        if (error instanceof Error && error.message.includes("Global operationId conflict")) throw new CoreError("CONFLICT", "Global operationId belongs to another request or actor.");
        if (!(error instanceof CoreError) && inspectLegacyInlineNoteFence(database))
          throw new CoreError("RECOVERY_REQUIRED", "Inline Note outcome remains durably fenced for exact authorized recovery.", "unknown");
        throw error;
      }
    },
  };
}

export const LEGACY_SHARED_SOURCE_RECEIPT_DDL = `
CREATE TRIGGER IF NOT EXISTS legacy_inline_global_intent BEFORE INSERT ON legacy_inline_note_intent BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM receipts WHERE operation_id=NEW.operation_id)
 THEN RAISE(ABORT,'Global operationId conflict') END;
END;
CREATE TRIGGER IF NOT EXISTS legacy_inline_global_receipt BEFORE INSERT ON legacy_inline_note_receipt BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM receipts WHERE operation_id=NEW.operation_id)
 THEN RAISE(ABORT,'Global operationId conflict') END;
 INSERT INTO receipts VALUES(NEW.operation_id,json_extract(NEW.payload,'$.fingerprint'),
 json_extract(NEW.payload,'$.result'),json_extract(NEW.payload,'$.actor.id'),
 json_extract(NEW.payload,'$.operation'),json_extract(NEW.payload,'$.at'));
END;
DROP TRIGGER IF EXISTS legacy_snapshot_global_receipt;
CREATE TRIGGER legacy_snapshot_global_receipt BEFORE INSERT ON legacy_snapshot_restore_receipts BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM receipts WHERE operation_id=NEW.op_id)
 THEN RAISE(ABORT,'Global operationId conflict') END;
 INSERT INTO receipts VALUES(NEW.op_id,NEW.fingerprint,NEW.record,NEW.actor_id,
 legacy_snapshot_operation(),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;`;
