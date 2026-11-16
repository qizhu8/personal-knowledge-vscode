import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { CoreError, type Actor } from "./contracts.js";
import { Core } from "./core.js";
import type { Storage } from "./storage.js";
import { checkedDocumentPath, checkedResourcePath } from "./document-path.js";
import { readNoteWorkItems } from "./domain/note-work-items.js";
import { readTodoBoard, todoBoardFilename } from "./domain/todo-board.js";
import { legacyNoteWorkItemsDefinitions } from "./legacy-note-workitems-contracts.js";

export { legacyNoteWorkItemsDefinitions, legacyNoteWorkItemsSupport } from "./legacy-note-workitems-contracts.js";

export interface LegacyNoteWorkItemsPolicy {
  authorize(actor: Readonly<Actor>, operation: string): boolean;
}

function readVerified(path: string, digest: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new CoreError("INVALID_DOCUMENT", "Original Note authority must be a regular file.");
    const bytes = readFileSync(fd);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new CoreError("INVALID_DOCUMENT", "Original Note authority is not valid UTF-8.");
    if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new CoreError("CONFLICT", "Original Note authority changed after the canonical read; retry the read.");
    return text;
  } finally { closeSync(fd); }
}

export function createNativeLegacyNoteWorkItemsHost(storage: Storage, policy: LegacyNoteWorkItemsPolicy) {
  const core = new Core(storage);
  const root = storage.workspaceRoot();
  async function canonical(operation: string, args: Record<string, unknown>, actor: Actor): Promise<Record<string, any>> {
    const result = await core.dispatch("capability_read", { operation, version: 1, arguments: args }, actor);
    if ("error" in result && result.error) throw new CoreError(result.error.code, result.error.message, result.error.effect);
    if (!("result" in result) || !result.result || typeof result.result !== "object") throw new CoreError("STORAGE_ERROR", "Canonical Note read returned no result.");
    return result.result as Record<string, any>;
  }
  async function read(slug: string, actor: Actor, snapshotRevision?: string) {
    const response = await canonical("knowledge.note.get", { path: `${slug}.md`, ...(snapshotRevision ? { snapshotRevision } : {}) }, actor);
    const item = response.item;
    if (item.slug !== slug) throw new CoreError("CONFLICT", "Canonical Note identity differs from the requested slug.");
    const markdown = readVerified(checkedDocumentPath(root, item.path, false, "notes"), item.documentSha256);
    if (item.documentKind === "todo-board") {
      if (!item.boardDigest) throw new CoreError("INVALID_DOCUMENT", "Original Note declares a Board but its authoritative backing is unavailable.");
      const path = checkedResourcePath(root, `${item.path.replace(/\.md$/i, ".assets")}/${todoBoardFilename}`, false, "notes");
      return readTodoBoard(readVerified(path, item.boardDigest));
    }
    return readNoteWorkItems(markdown);
  }
  return {
    available(operation: string, actor?: Readonly<Actor>): boolean {
      const entry = legacyNoteWorkItemsDefinitions.find(definition => definition.id === operation);
      if (!entry || !entry.readOnly || !actor?.id) return false;
      try { return policy.authorize(actor, operation) === true; } catch { return false; }
    },
    async dispatch(operation: string, input: unknown, actor: Actor): Promise<unknown> {
      const entry = legacyNoteWorkItemsDefinitions.find(definition => definition.id === operation);
      if (!entry) throw new CoreError("NOT_FOUND", "Unknown original Note Work Item operation.");
      if (!actor?.id || (!entry.readOnly && !actor.canWrite)) throw new CoreError("ACCESS_DENIED", "Authenticated authority is required.");
      let permitted = false;
      try { permitted = policy.authorize(actor, operation) === true; } catch { /* deny */ }
      if (!permitted) throw new CoreError("ACCESS_DENIED", "Original Note Work Item policy denied this actor.");
      const parsed = entry.input.safeParse(input);
      if (!parsed.success) throw new CoreError("INVALID_ARGUMENT", "Invalid original Note Work Item arguments.");
      if (!entry.readOnly) throw new CoreError("NOT_AVAILABLE", "Original Note writes require a native authority and atomic full-snapshot receipt seam; no Board mutation was attempted.");
      if (operation === "legacy.note.workitems.read") {
        const { slug } = parsed.data as { slug: string };
        return { ok: true, ...await read(slug, actor) };
      }
      const { query, limit } = parsed.data as { query: string; limit: number };
      const needle = query.trim().toLowerCase();
      const notes: { slug: string; title: string; count: number; digest?: string; error?: string }[] = [];
      let offset = 0, snapshotRevision: string | undefined;
      while (true) {
        const page = await canonical("knowledge.note.list", { offset, limit: 100, ...(snapshotRevision ? { snapshotRevision } : {}) }, actor);
        snapshotRevision ??= page.snapshotRevision;
        for (const note of page.items) {
          if (needle && ![note.slug, note.title, note.description].some(value => String(value).toLowerCase().includes(needle))) continue;
          try {
            const result = await read(note.slug, actor, snapshotRevision);
            if (result.items.length || note.documentKind === "todo-board") notes.push({
              slug: note.slug, title: note.title, count: result.items.filter(item => !item.deletedAt).length, digest: result.digest,
            });
          } catch (error) {
            if (error instanceof CoreError && ["CONFLICT", "ACCESS_DENIED", "STORAGE_ERROR", "STORAGE_UNAVAILABLE"].includes(error.code)) throw error;
            notes.push({ slug: note.slug, title: note.title, count: 0, error: error instanceof Error ? error.message : String(error) });
          }
          if (notes.length > limit) return { ok: true, notes: notes.slice(0, limit), truncated: true, next_offset: limit };
        }
        if (page.nextOffset === null) return { ok: true, notes, truncated: false, next_offset: null };
        offset = page.nextOffset;
      }
    },
  };
}
