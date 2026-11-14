import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readFileSync, writeSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { CoreError, type Actor } from "./contracts.js";
import { checkedDocumentPath } from "./document-path.js";
import type { WorkItemActor } from "./domain/note-work-items.js";
import { inspectLegacyInlineNote } from "./domain/legacy-inline-note-reducer.js";
import { createLegacyInlineNoteJournal, inspectLegacyInlineNoteHistory, type LegacyInlineNoteJournalHost } from "./legacy-inline-note-journal.js";
import { legacyInlineNoteDigestSchema } from "./legacy-inline-note-contracts.js";

export interface LegacyInlineNoteNativePolicy {
  admissions: readonly { slug: string; sourceMarkdownDigest: string }[];
  authorize?(actor: Readonly<Actor>, operation: string, slug: string): WorkItemActor | undefined;
  /** Must check the entire native workspace's active Board authority, never
   * invent inline focus equivalence or silently suspend another task. */
  assertFocus?(actor: Readonly<Actor>, slug: string, before: string, after: string): Promise<void>;
  /** Original same-path writer can clear sync deletion records. Admission must
   * explicitly prove those original side effects are absent, or reject. */
  assertNoLegacySyncEffects?(slug: string): Promise<void>;
}

export function createNativeLegacyInlineNoteHost(options: {
  database: DatabaseSync;
  root: string;
  policy?: LegacyInlineNoteNativePolicy;
  withDurableFence: LegacyInlineNoteJournalHost["withDurableFence"];
  now?: () => string;
}) {
  const { database, policy } = options;
  const root = resolve(options.root);
  const admissions = new Map<string, string>();
  for (const admission of policy?.admissions ?? []) {
    if (admissions.has(admission.slug) || !legacyInlineNoteDigestSchema.safeParse(admission.sourceMarkdownDigest).success)
      throw new CoreError("INVALID_ARGUMENT", "Duplicate or invalid original inline source admissions.");
    checkedDocumentPath(root, `${admission.slug}.md`, false);
    admissions.set(admission.slug, admission.sourceMarkdownDigest);
  }
  function path(slug: string) {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoreError("INVALID_DOCUMENT", "Native workspace must be a real directory.");
    if (slug.split("/")[0].toLowerCase() === "system") throw new CoreError("ACCESS_DENIED", "Original System Notes are read-only.");
    if (!admissions.has(slug)) throw new CoreError("NOT_AVAILABLE", "No reviewed original inline Note source pin.");
    const full = checkedDocumentPath(root, `${slug}.md`, false);
    // Any attached authority wins in the original writer, even without YAML kind.
    const assets = join(root, "notes", `${slug}.assets`);
    try {
      const stat = lstatSync(assets);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoreError("INVALID_DOCUMENT", "Original Note assets must be a real directory.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      return full;
    }
    const board = join(root, "notes", `${slug}.assets`, "pkm-todo-board.json");
    try {
      lstatSync(board);
      throw new CoreError("NOT_AVAILABLE", "Original attached Board requires the separate admitted Board bridge; filestore.ts:682.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    return full;
  }
  function bytes(fd: number) {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new CoreError("INVALID_DOCUMENT", "Inline Note must be an unshared regular file.");
    const raw = readFileSync(fd);
    const text = raw.toString("utf8");
    if (!Buffer.from(text).equals(raw))
      throw new CoreError("INVALID_DOCUMENT", "Inline Note bytes are not valid UTF-8.");
    inspectLegacyInlineNote(text);
    return text;
  }
  const host: LegacyInlineNoteJournalHost = {
    withDurableFence: options.withDurableFence,
    authorize(actor, operation, slug) {
      if (!admissions.has(slug)) return undefined;
      return policy?.authorize?.(actor, operation, slug);
    },
    async readAdmittedNote(slug) {
      const full = path(slug);
      const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      let markdown: string;
      try { markdown = bytes(fd); } finally { closeSync(fd); }
      const { head, pending } = inspectLegacyInlineNoteHistory(database, slug, admissions.get(slug)!);
      const digest = inspectLegacyInlineNote(markdown).digest;
      if (digest !== head && !(pending && markdown === pending.after))
        throw new CoreError("CONFLICT", "Original Note differs from exact reviewed source/journal lineage; no stale source admission.");
      return markdown;
    },
    async writeExactNote(slug, before, after) {
      if (!policy?.assertNoLegacySyncEffects)
        throw new CoreError("NOT_AVAILABLE", "Native host has not ruled out original sync-deletion side effects.");
      await policy.assertNoLegacySyncEffects(slug);
      const full = path(slug);
      const fd = openSync(full, constants.O_RDWR | constants.O_NOFOLLOW);
      let touched = false;
      try {
        const opened = fstatSync(fd);
        const current = lstatSync(full);
        if (opened.dev !== current.dev || opened.ino !== current.ino || bytes(fd) !== before)
          throw new CoreError("CONFLICT", "Original Note changed before exact native write.");
        inspectLegacyInlineNote(after);
        const raw = Buffer.from(after);
        touched = true;
        let offset = 0;
        while (offset < raw.length) {
          const count = writeSync(fd, raw, offset, raw.length - offset, offset);
          if (!count) throw new Error("Native inline write made no progress.");
          offset += count;
        }
        ftruncateSync(fd, raw.length);
        fsyncSync(fd);
        const saved = lstatSync(full);
        if (saved.dev !== opened.dev || saved.ino !== opened.ino) throw new Error("Note identity changed during native write.");
      } catch (error) {
        throw new CoreError(touched ? "RECOVERY_REQUIRED" : "CONFLICT", String(error), touched ? "unknown" : "not-committed");
      } finally { closeSync(fd); }
    },
    async assertFocus(actor, slug, before, after) {
      if (!policy?.assertFocus || !policy.assertNoLegacySyncEffects)
        throw new CoreError("NOT_AVAILABLE", "Explicit native workspace focus and original side-effect policies are required.");
      await policy.assertNoLegacySyncEffects(slug);
      await policy.assertFocus(actor, slug, before, after);
    },
    now: options.now ?? (() => new Date().toISOString()),
  };
  return { host, journal: createLegacyInlineNoteJournal(database, host) };
}
