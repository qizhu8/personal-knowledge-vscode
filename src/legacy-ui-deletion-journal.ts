import { z } from "zod";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { resourcePath } from "./document-path.js";
import { CoreError } from "./contracts.js";

export const legacyUiDeletionJournalPath = ".pkm/state/knowledge-deletions.json";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const journal = z.strictObject({ schema: z.literal(1), records: z.array(z.strictObject({
  path: resourcePath.refine(path => /^(notes|skills|papers|prompts|scripts)\//.test(path)),
  deletedAt: z.iso.datetime(),
})).max(10_000) });
function parse(bytes: Buffer) {
  if (bytes.length > 2_097_152 || !Buffer.from(bytes.toString("utf8")).equals(bytes))
    throw new Error("Original knowledge deletion journal exceeds its exact UTF-8 bounds.");
  const parsed = journal.parse(JSON.parse(bytes.toString("utf8")));
  if (new Set(parsed.records.map(record => record.path.toLowerCase())).size !== parsed.records.length)
    throw new Error("Original knowledge deletion journal has ambiguous duplicate paths.");
  return parsed;
}
export function inspectLegacyUiDeletionJournal(root: string, bytes: Buffer) {
  const parsed = parse(bytes);
  for (const record of parsed.records) {
    const parts = record.path.split("/");
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      let stat;
      try { stat = lstatSync(current); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
      if (stat.isSymbolicLink() || !stat.isDirectory() || index === parts.length - 1)
        throw new Error("Original deletion still has a live or unsafe path; original-writer reconciliation is required.");
    }
  }
  return { schema: 1 as const, sha256: hash(bytes), records: parsed.records.length,
    authority: "preserved-original-sync-only" as const };
}
export type LegacyUiDeletionJournalSummary = ReturnType<typeof inspectLegacyUiDeletionJournal>;

/** Do not silently resurrect retained Sync deletions before a qualified native Sync reconciliation exists. */
export function assertLegacyUiDeletionWriteTarget(db: DatabaseSync, root: string, relative: string, includePairedAssets = true): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_ui_bootstrap_compatibility'").get()) return;
  for (const row of db.prepare("SELECT payload,payload_sha256 FROM legacy_ui_bootstrap_compatibility").all()) {
    if (hash(String(row.payload)) !== row.payload_sha256) throw new CoreError("RECOVERY_CONFLICT", "Original compatibility receipt changed.");
    const proof = JSON.parse(String(row.payload));
    if (!proof.knowledgeDeletions) continue;
    if (proof.root !== root) throw new CoreError("RECOVERY_CONFLICT", "Original deletion journal belongs to another root.");
    const file = join(root, legacyUiDeletionJournalPath), before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 2_097_152
      || before.uid !== process.getuid?.() || (before.mode & 0o7077) !== 0)
      throw new CoreError("RECOVERY_CONFLICT", "Original deletion journal is no longer private owned data.");
    const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const opened = fstatSync(descriptor);
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("Original deletion identity changed.");
      bytes = readFileSync(descriptor);
      const after = fstatSync(descriptor), current = lstatSync(file);
      if (after.size !== before.size || after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs
        || current.dev !== before.dev || current.ino !== before.ino || current.ctimeMs !== before.ctimeMs
        || current.mtimeMs !== before.mtimeMs || hash(bytes) !== proof.knowledgeDeletions.sha256)
        throw new CoreError("RECOVERY_CONFLICT", "Original deletion journal differs from its immutable source.");
    } finally { closeSync(descriptor); }
    const target = relative.toLowerCase(), assets = includePairedAssets && target.endsWith(".md") ? `${target.slice(0, -3)}.assets` : undefined;
    if (parse(bytes).records.some(record => {
      const deleted = record.path.toLowerCase();
      return deleted === target || target.startsWith(`${deleted}/`)
        || (assets !== undefined && (deleted === assets || deleted.startsWith(`${assets}/`) || assets.startsWith(`${deleted}/`)));
    }))
      throw new CoreError("CONFLICT", "Destination retains an original Sync deletion; explicit original-Sync reconciliation is not qualified.");
  }
}
