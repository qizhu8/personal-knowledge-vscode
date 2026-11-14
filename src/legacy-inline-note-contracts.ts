import { z } from "zod";
import { documentPath } from "./document-path.js";
import { validateNoteWorkItem, type NoteWorkItem } from "./domain/note-work-items.js";

const text = z.string().refine(value => !!value.trim(), "Nonempty text required.");
const id = text.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const legacyInlineNoteDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const legacyInlineNoteItemSchema = z.record(z.string(), z.json()).superRefine((value, context) => {
  try { validateNoteWorkItem(value); }
  catch (error) {
    context.addIssue({ code: "custom", message: String(error) });
  }
}) as unknown as z.ZodType<NoteWorkItem>;
const reason = text.optional();
export const legacyInlineNoteCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("create"), item: legacyInlineNoteItemSchema, reason }),
  // Original human edit strips stale generated audit before item validation.
  z.strictObject({ action: z.literal("edit"), item: z.record(z.string(), z.json()), reason }),
  ...(["claim", "release", "accept", "reopen", "delete", "restore"] as const).map(action =>
    z.strictObject({ action: z.literal(action), id, reason })),
  z.strictObject({ action: z.literal("assign"), id, ownerId: text, reason }),
  z.strictObject({ action: z.literal("comment"), id, text: text.max(8000) }),
  z.strictObject({ action: z.literal("transition"), id,
    state: z.enum(["Planning", "WIP", "Blocked", "OnHold", "Done"]), reason,
    blockedReason: text.optional(), outcome: z.enum(["Success", "Failed", "Unsure"]).optional(),
    evidence: z.array(text).optional(), verification: z.json().optional() }),
]);
const slug = z.string().min(1).max(1021).refine(value => documentPath.safeParse(`${value}.md`).success);
const base = { slug, expected_digest: legacyInlineNoteDigestSchema, operationId: z.string().uuid() };
export const legacyInlineNoteReceiptSchema = z.strictObject({
  ok: z.literal(true), digest: legacyInlineNoteDigestSchema, items: z.array(legacyInlineNoteItemSchema),
});
export const legacyInlineNoteDefinitions = [
  { id: "legacy.note.workitems.command", transportName: "note_work_item_command", readOnly: false,
    input: z.strictObject({ ...base, command: legacyInlineNoteCommandSchema, worker_token: z.string().optional() }),
    output: legacyInlineNoteReceiptSchema },
  { id: "legacy.note.workitems.upsert", transportName: "note_work_item_upsert", readOnly: false,
    input: z.strictObject({ ...base, item: legacyInlineNoteItemSchema }), output: legacyInlineNoteReceiptSchema },
] as const;
export type LegacyInlineNoteReceipt = z.infer<typeof legacyInlineNoteReceiptSchema>;

export const legacyInlineNoteSourcePins = Object.freeze({
  "src/knowledge/note-work-items.ts": "64f39b26b1d115e92ed5fc1f31c81ef746baf325ea07689c2407449a66aab76e",
  "next-server/src/domain/note-work-items.ts": "64f39b26b1d115e92ed5fc1f31c81ef746baf325ea07689c2407449a66aab76e",
  "src/knowledge/filestore.ts": "c5c3a9761562818529a00aedb96aef254bef34dc80a4ed31f31efd39bc7a97a5",
  "resources/knowledge_mutations.js": "3d087d458de580e30cc31b670ab657b00e938c2aead653766ded7c07a9124ba5",
  "resources/knowledge_mutations.py": "a17e86d059b23132eaddcd3ab6222e7b909a4f4a1215c3e3ee6a8fbc0d2880f2",
  "tests/test-note-work-items.js": "25ad07cdf20931f54bceb65c9b6047466362ad71a8ba8ca591ea1867a015d780",
  "tests/test-note-work-item-lifecycle.js": "ad3c9e359d7b958af35a4550b01c6a6019413a7052af380fedfa96f75fe32c08",
});
export const legacyInlineNoteSupport = Object.freeze({
  command: ["create", "edit", "claim", "release", "transition", "comment", "accept", "reopen", "delete", "restore", "assign"],
  upsert: "original-MCP-worker-create-or-edit-fixed-mcp:external",
  acceptance: "trusted-human-only; delegated-worker-reviewer-original-variant-not-admitted",
  unsupported: ["worker_token", "board-agent", "attached-Board", "manual-low-level-upsert", "sync-deletion-side-effects"],
  core: "explicit-host-dispatch-seam-only; not-registered-or-switched",
  storage: "exported-DDL; sole-native-storage-owner-must-install-and-fence-all-workspace-operations",
  import: "admit-reviewed-existing-inline-Note-by-source-digest; no-conversion",
  backup: "sole-owner-must-back-up-note-and-journal-under-workspace-fence",
  schemaVersion: "no-shared-schema-change",
  counts: { writeOperations: 2, originalCommandActions: 11, sharedSchemaChanges: 0, sharedRuntimeRegistrations: 0 },
  ddd: "original-inline-Markdown-Note-is-authority; stable-Work-Item-IDs; no-Board-aggregate-conversion",
  exports: ["legacyInlineNoteDefinitions", "legacyInlineNoteReceiptSchema", "legacyInlineNoteSourcePins",
    "LEGACY_INLINE_NOTE_JOURNAL_DDL", "createLegacyInlineNoteJournal", "createNativeLegacyInlineNoteHost",
    "inspectLegacyInlineNoteFence", "assertLegacyInlineNoteWorkspaceUnfenced", "inspectLegacyInlineNoteHistory",
    "inspectLegacyInlineNote", "reduceLegacyInlineNote"],
});
