import { createHash } from "node:crypto";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { readNoteWorkItems } from "./domain/note-work-items.js";
import { readTodoBoard } from "./domain/todo-board.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const legacyNoteWorkItemsAdmissionSchema = z.strictObject({
  slug: z.string().min(1).max(1021), sourceMarkdown: z.string(),
  sourceMarkdownDigest: digest, sourceBoard: z.string().optional(),
  sourceBoardDigest: digest.optional(), nativeBoard: z.string(), nativeBoardDigest: digest,
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Pure, opt-in preflight. It neither grants authority nor changes either source. */
export function preflightLegacyNoteWorkItemsAdmission(input: unknown) {
  const parsed = legacyNoteWorkItemsAdmissionSchema.safeParse(input);
  if (!parsed.success) throw new CoreError("INVALID_ARGUMENT", "Invalid pinned Note admission.");
  const value = parsed.data;
  if (hash(value.sourceMarkdown) !== value.sourceMarkdownDigest || hash(value.nativeBoard) !== value.nativeBoardDigest)
    throw new CoreError("CONFLICT", "Pinned Note or native Board bytes changed.");
  const native = readTodoBoard(value.nativeBoard);
  if (value.sourceBoard === undefined) {
    if (value.sourceBoardDigest !== undefined) throw new CoreError("INVALID_ARGUMENT", "Source Board bytes are absent.");
    const inline = readNoteWorkItems(value.sourceMarkdown);
    return {
      status: "inline-unavailable" as const, slug: value.slug, sourceMarkdownDigest: value.sourceMarkdownDigest,
      nativeBoardDigest: native.digest, itemParity: JSON.stringify(inline.items) === JSON.stringify(native.items),
      reason: "Inline Markdown digest and mutation authority differ from native Board authority; preserve original bytes and require a separately designed atomic migration.",
    };
  }
  if (!value.sourceBoardDigest || hash(value.sourceBoard) !== value.sourceBoardDigest)
    throw new CoreError("CONFLICT", "Pinned original Board bytes changed.");
  readTodoBoard(value.sourceBoard);
  if (value.sourceBoard !== value.nativeBoard)
    throw new CoreError("NOT_AVAILABLE", "Original and native Board authority bytes are not identical; no implicit conversion is allowed.");
  return {
    status: "eligible-for-native-policy" as const, slug: value.slug, sourceMarkdownDigest: value.sourceMarkdownDigest,
    sourceBoardDigest: value.sourceBoardDigest, nativeBoardDigest: native.digest,
  };
}
