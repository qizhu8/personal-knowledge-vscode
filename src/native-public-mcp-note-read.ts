import { lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { assertRootReadScope, type RootOwner, type RootReadScope } from "./root-owner.js";
import { decodeMarkdownPath, readKnowledgePathSnapshot } from "./markdown-read.js";
import { formatLegacyPathNoteGet, parseLegacyNote, pythonJson, type LegacyPathNoteSource } from "./domain/legacy-note-query-original.js";
import { pythonStrip } from "./domain/legacy-note-query-unicode.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface NativeScopedNoteRead {
  accepts(request: unknown): boolean;
  read(scope: RootReadScope, request: unknown): Promise<CallToolResult | undefined> | CallToolResult | undefined;
}
interface PathSnapshot {
  readonly pin: {
    note: readonly string[]; file?: string; board?: readonly string[]; boardFile?: string;
    recipesAbsent?: boolean; changed?: true;
  };
  readonly bytes?: Buffer;
  readonly source?: LegacyPathNoteSource;
  readonly explicitBoard?: boolean;
}

const requestSchema = z.strictObject({
  tool: z.literal("get_note"),
  arguments: z.strictObject({ id: z.string().optional(), slug: z.string().nullable().optional() }),
});
function keyFor(request: unknown): string | undefined {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) return undefined;
  const { id, slug } = parsed.data.arguments;
  if (id && slug && id !== slug) return undefined;
  const original = id || slug || "", key = original.trim();
  if (!key || key !== pythonStrip(original)
    || /^(?:pkm:\/\/(?:knowledge|script|subscriptions)\/|knowledge_|script_)/.test(key)) return undefined;
  return key;
}

export function createNativeScopedNoteRead(owner: RootOwner): NativeScopedNoteRead {
  function snapshot(scope: RootReadScope, key: string, validated?: PathSnapshot): PathSnapshot {
    const path = `${key}.md`, note = readKnowledgePathSnapshot(scope.root, path, "notes", true);
    if (validated && (JSON.stringify(note.parents) !== JSON.stringify(validated.pin.note)
      || note.file?.pin !== validated.pin.file || !!note.file !== !!validated.bytes
      || note.file && !note.file.bytes.equals(validated.bytes!)))
      return { pin: { note: note.parents, file: note.file?.pin, changed: true } };
    if (!note.file) return { pin: { note: note.parents }, source: undefined };
    // B reuses A's decode only after fresh bytes and path pins match; dependencies are reread below.
    let raw = validated?.source?.raw;
    let explicitBoard = validated?.explicitBoard;
    if (raw === undefined) {
      try { raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(note.file.bytes); }
      catch { throw new CoreError("INVALID_DOCUMENT", "Markdown must be valid UTF-8."); }
      decodeMarkdownPath(raw, path);
      explicitBoard = parseLegacyNote(raw).metadata.documentKind === "todo-board";
    }
    const board = explicitBoard ? undefined
      : readKnowledgePathSnapshot(scope.root, `${key}.assets/pkm-todo-board.json`, "notes");
    const boardPresent = explicitBoard || !!board?.file;
    if (!boardPresent) {
      for (const dependency of ["recipes", "project", ".pkm"])
        if (lstatSync(join(scope.root, dependency), { throwIfNoEntry: false }))
          throw new CoreError("CONFLICT", "Required Recipe authority changed during the qualified path read.");
    }
    return {
      pin: { note: note.parents, file: note.file.pin, board: board?.parents, boardFile: board?.file?.pin,
        recipesAbsent: !boardPresent },
      bytes: note.file.bytes, explicitBoard,
      source: Object.freeze({ path, raw, mtimeNs: note.file.mtimeNs, boardPresent }),
    };
  }
  return {
    accepts: request => keyFor(request) !== undefined,
    read(scope, request) {
      assertRootReadScope(scope, owner);
      const key = keyFor(request);
      if (key === undefined) throw new CoreError("INVALID_ARGUMENT", "Expected an ordinary original Note path read.");
      const before = snapshot(scope, key);
      if (before.source?.boardPresent) return undefined;
      const text = formatLegacyPathNoteGet(before.source, key, []);
      scope.assertHeld();
      let after: ReturnType<typeof snapshot>;
      try { after = snapshot(scope, key, before); }
      catch { throw new CoreError("CONFLICT", "CONFLICT: Knowledge path or dependency changed during read."); }
      if (JSON.stringify(before.pin) !== JSON.stringify(after.pin))
        throw new CoreError("CONFLICT", "CONFLICT: Knowledge changed during path read.");
      scope.assertHeld();
      let value: unknown = text;
      if (before.source) {
        try { value = JSON.parse(text); pythonJson(value); }
        catch { throw new CoreError("INVALID_DOCUMENT", "Original Note projection must be portable JSON."); }
      }
      return { content: [{ type: "text", text: JSON.stringify({ value, text }) }], structuredContent: { value, text } };
    },
  };
}
