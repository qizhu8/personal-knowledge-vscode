import { z } from "zod";

const slug = z.string().min(1).max(1021);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const snapshot = z.strictObject({ ok: z.literal(true), digest, items: z.array(z.record(z.string(), z.json())) });

export const legacyNoteWorkItemsDefinitions = [
  {
    id: "legacy.note.workitems.read", transportName: "note_work_items", readOnly: true,
    description: "Read original Markdown Note blocks or the original Note-attached Board. A checked Note read and exact backing digest are required.",
    input: z.strictObject({ slug }), output: snapshot,
  },
  {
    id: "legacy.note.workitems.notes", transportName: "note_work_item_notes", readOnly: true,
    description: "Discover original Notes with Work Items. Invalid native Note snapshots fail closed rather than returning a partial discovery.",
    input: z.strictObject({ query: z.string().max(16000).default(""), limit: z.number().int().min(1).max(1000).default(20) }),
    output: z.strictObject({
      ok: z.literal(true),
      notes: z.array(z.strictObject({ slug: z.string(), title: z.string(), count: z.number().int().nonnegative(),
        digest: digest.optional(), error: z.string().optional() })),
      truncated: z.boolean(),
      next_offset: z.number().int().nonnegative().nullable(),
    }),
  },
  {
    id: "legacy.note.workitems.command", transportName: "note_work_item_command", readOnly: false,
    description: "Original worker command only with explicitly admitted equivalent native Board, durable compatibility journal and a workspace-wide recovery fence.",
    input: z.strictObject({ slug, expected_digest: digest, command: z.record(z.string(), z.json()),
      worker_token: z.string().optional(), operationId: z.string().uuid() }),
    output: snapshot,
  },
  {
    id: "legacy.note.workitems.upsert", transportName: "note_work_item_upsert", readOnly: false,
    description: "Original mcp:external worker upsert with explicitly admitted equivalent native Board and durable compatibility journal; non-equivalent edits fail closed.",
    input: z.strictObject({ slug, expected_digest: digest, item: z.record(z.string(), z.json()), operationId: z.string().uuid() }),
    output: snapshot,
  },
] as const;

export const legacyNoteWorkItemsSupport = Object.freeze({
  read: "checked-original-note-or-attached-board",
  discovery: "checked-note-snapshot-or-explicit-error",
  command: "conditional-pinned-board-equivalent-worker-command-with-durable-journal-and-fence",
  upsert: "conditional-pinned-board-equivalent-mcp-external-upsert-with-durable-journal-and-fence",
  token: "unavailable-no-board-token-authentication-adapter",
} as const);
