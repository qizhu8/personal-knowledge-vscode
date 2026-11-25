import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { coreDatabasePath } from "./workspace-storage-paths.js";
import { DatabaseSync } from "node:sqlite";
import { CoreError, type Actor } from "./contracts.js";
import { scanBoards } from "./boards.js";
import { scanMarkdown } from "./markdown.js";
import { sha256 } from "./file-write.js";
import { checkedResourcePath } from "./document-path.js";
import { todoBoardFilename } from "./domain/todo-board.js";
import { preflightLegacyNoteWorkItemsAdmission } from "./legacy-note-workitems-admission.js";
import { legacyNoteWorkItemsDefinitions } from "./legacy-note-workitems-contracts.js";
import type { NativeLegacyNoteWorkItemsPolicy, LegacyNoteWorkItemsAdmissionPin } from "./host-composition-legacy-note-workitems.js";
import type { Storage } from "./storage.js";

function readOriginal(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new CoreError("INVALID_DOCUMENT", "Original Note Board must be a regular, unlinked file.");
    const bytes = readFileSync(fd), after = fstatSync(fd), raw = bytes.toString("utf8");
    if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size
      || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || !Buffer.from(raw).equals(bytes))
      throw new CoreError("CONFLICT", "Original Note Board changed during its admission snapshot.");
    return raw;
  } finally { closeSync(fd); }
}

/** Explicit experimental MCP authority only; never used by normal startup.
 * The existing native composition rechecks these pins and journals every worker effect. */
export async function legacyMcpNotePolicy(storage: Storage, principal: Readonly<Actor>): Promise<NativeLegacyNoteWorkItemsPolicy> {
  const selected = await storage.withWorkspaceExclusive(() => {
    storage.assertWorkspaceLease();
    const root = storage.workspaceRoot(), database = new DatabaseSync(coreDatabasePath(root), { readOnly: true });
    const pins: LegacyNoteWorkItemsAdmissionPin[] = [];
    const canonicalSources: { slug: string; sourceMarkdownDigest: string; nativeBoardDigest: string; actorId: string }[] = [];
    let pending = false;
    try {
      const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
        .map(row => row.name));
      if (tables.has("legacy_note_workitems_admission")) {
        const rows = database.prepare("SELECT * FROM legacy_note_workitems_admission ORDER BY slug").all() as
          { slug: string; source_markdown_sha256: string; source_board_sha256: string; native_board_sha256: string }[];
        for (const row of rows) pins.push({ slug: row.slug, sourceMarkdownDigest: row.source_markdown_sha256,
          sourceBoardDigest: row.source_board_sha256, nativeBoardDigest: row.native_board_sha256 });
      }
      pending = tables.has("migration_runtime_intents")
        && !!database.prepare("SELECT 1 FROM migration_runtime_intents LIMIT 1").get();
      pending ||= tables.has("original_todo_genesis_pending")
        && !!database.prepare("SELECT 1 FROM original_todo_genesis_pending LIMIT 1").get();
    } finally { database.close(); }
    if (pending) return { pins, canonicalSources };
    const native = scanBoards(root);
    for (const document of scanMarkdown(root)) {
      if (document.record.area !== "notes" || document.metadata.get("documentKind") !== "todo-board") continue;
      const slug = document.record.path.replace(/\.md$/i, "");
      if (pins.some(pin => pin.slug === slug)) continue;
      const board = native.get(slug);
      if (!board) continue;
      let sourceBoard;
      try { sourceBoard = readOriginal(checkedResourcePath(root, `${slug}.assets/${todoBoardFilename}`, false, "notes")); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        canonicalSources.push({ slug, sourceMarkdownDigest: sha256(document.raw), nativeBoardDigest: sha256(board.raw), actorId: principal.id });
        continue;
      }
      if (sourceBoard !== board.raw) continue;
      const pin = { slug, sourceMarkdownDigest: sha256(document.raw),
        sourceBoardDigest: sha256(sourceBoard), nativeBoardDigest: sha256(board.raw) };
      const admitted = preflightLegacyNoteWorkItemsAdmission({ ...pin, sourceMarkdown: document.raw, sourceBoard, nativeBoard: board.raw });
      if (admitted.status === "eligible-for-native-policy") pins.push(pin);
    }
    storage.assertWorkspaceLease();
    return { pins, canonicalSources };
  });
  const known = new Map<string, { readOnly: boolean }>(legacyNoteWorkItemsDefinitions.map(definition => [definition.id, definition]));
  const actor = Object.freeze({ ...principal });
  return {
    admissions: selected.pins, canonicalSources: selected.canonicalSources,
    authorize: (who, operation) => who.id === actor.id && !!known.get(operation)
      && (known.get(operation)!.readOnly || actor.canWrite && who.canWrite),
    recoveryActor: request => actor.canWrite && request.actorId === actor.id ? { ...actor } : undefined,
  };
}
