import { randomBytes, createHash } from "crypto";
import { existsSync, lstatSync, readdirSync, realpathSync } from "fs";
import { isAbsolute, join } from "path";
import {
  getStorePath, noteGet, noteList, noteSearch, createOriginalNoteNoOverwrite,
  readOriginalNoteBodyForEdit, compareAndSwapOriginalNoteBody,
} from "../knowledge/filestore";
import { isMarkdownAssetDirectory } from "../knowledge/markdown-assets";
import { todoBoardFilename } from "../knowledge/todo-board";

type NotesInput =
  | { command: "list"; q: string; caseSensitive: boolean }
  | { command: "detail"; path: string }
  | { command: "saveNote"; operationId: string; title: string; content: string; type: string; category: string; tags: string[] }
  | { command: "updateNote"; operationId: string; id: string; expectedRevision: number; expectedSha256: string; content: string };
type Options = {
  root: string;
  expiresAt: number;
  allowWrite: boolean;
  assertCurrent(): void;
  withWriter<T>(work: () => T): T | Promise<T>;
};
type NotesBridge = ((input: NotesInput, current: () => boolean) => Promise<unknown>) & Readonly<{ allowWrite: boolean }>;
const fail = (code: string): never => { throw Object.assign(new Error("Original Notes request refused."), { code }); };
const maxEntries = 512;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Private owner callback. Nothing here selects a root, starts MCP, or retries a mutation. */
export function bindOriginalBrowserNotes(options: Options): NotesBridge {
  const { root, expiresAt, allowWrite } = options;
  if (!isAbsolute(root) || realpathSync(root) !== root || !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now() || expiresAt > Date.now() + 24 * 60 * 60 * 1000)
    throw new Error("Invalid Original Notes consent.");
  const identity = lstatSync(root);
  if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error("Invalid Original Notes root.");
  const edits = new Map<string, { path: string; sha256: string; revision: string; browserRevision: number }>();
  const operations = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
  let sequence = 0, pending = 0;
  const check = (current: () => boolean, write = false) => {
    try {
      options.assertCurrent();
      const stat = lstatSync(root);
      const notes = join(root, "notes");
      const notesStat = existsSync(notes) ? lstatSync(notes) : undefined;
      if (!current() || Date.now() >= expiresAt || getStorePath() !== root || realpathSync(root) !== root ||
          !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino ||
          notesStat && (!notesStat.isDirectory() || notesStat.isSymbolicLink()) ||
          write && !allowWrite) fail("ORIGINAL_NOTES_DENIED");
    } catch { fail("ORIGINAL_NOTES_DENIED"); }
  };
  const path = (value: string) => {
    if (typeof value !== "string" || value.length > 2048 || !value.endsWith(".md") || /[\\:\u0000-\u001f]/.test(value) ||
        value.split("/").some(part => !part || part === "." || part === ".." ||
          Object.prototype.hasOwnProperty.call(Object.prototype, part.trim()) || part.startsWith(".") || part.toLowerCase() === "_assets" ||
          part.toLowerCase() === "system" || part.toLowerCase().endsWith(".assets")))
      fail("ORIGINAL_NOTES_INVALID");
    return value;
  };
  const item = (row: any) => ({
    slug: row.slug, path: path(`${row.slug}.md`), title: row.title,
    category: row.category || "", type: row.type || "general", updated_at: row.updated_at,
  });
  const body = (value: string) => {
    if (typeof value !== "string" || !value.length || value.length > 400_000 ||
        Buffer.byteLength(value) > 400_000 || Buffer.from(value).toString("utf8") !== value)
      fail("ORIGINAL_NOTES_INVALID");
  };
  // The legacy reader traverses ordinary directories. Fence that traversal and its
  // Todo Board sidecar reads before releasing any data to this detached caller.
  const readFence = () => {
    const records = new Map<string, string>();
    let entries = 0, bytes = 0;
    const fingerprint = (full: string) => {
      const stat = lstatSync(full, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n))
        fail("ORIGINAL_NOTES_INVALID");
      return { stat, key: [stat.dev, stat.ino, stat.ctimeNs, stat.mtimeNs, stat.size, stat.nlink].join(":") };
    };
    const walk = (directory: string, depth: number) => {
      if (depth > 32) fail("ORIGINAL_NOTES_LIMIT");
      const record = fingerprint(directory);
      if (!record.stat.isDirectory()) fail("ORIGINAL_NOTES_INVALID");
      records.set(directory, record.key);
      for (const name of readdirSync(directory)) {
        if (++entries > 10_000) fail("ORIGINAL_NOTES_LIMIT");
        if (name.startsWith(".")) continue;
        const full = join(directory, name);
        const child = fingerprint(full);
        records.set(full, child.key);
        if (isMarkdownAssetDirectory(name)) {
          const board = join(full, todoBoardFilename);
          if (existsSync(board)) {
            const sidecar = fingerprint(board);
            if (!sidecar.stat.isFile() || sidecar.stat.size > 512n * 1024n) fail("ORIGINAL_NOTES_LIMIT");
            records.set(board, sidecar.key);
          }
        } else if (child.stat.isDirectory()) walk(full, depth + 1);
        else if (/\.md$/i.test(name)) {
          bytes += Number(child.stat.size);
          if (child.stat.size > 512n * 1024n || bytes > 32 * 1024 * 1024) fail("ORIGINAL_NOTES_LIMIT");
        }
      }
    };
    const notes = join(root, "notes");
    const present = existsSync(notes);
    if (present) walk(notes, 0);
    return () => {
      if (present !== existsSync(notes)) fail("ORIGINAL_NOTES_INVALID");
      for (const [full, key] of records) if (fingerprint(full).key !== key) fail("ORIGINAL_NOTES_INVALID");
    };
  };
  const bridge: NotesBridge = Object.assign(async (input: NotesInput, current: () => boolean): Promise<unknown> => {
    check(current);
    if (pending >= 4) fail("ORIGINAL_NOTES_LIMIT");
    pending++;
    try {
      if (input.command === "list") {
        if (typeof input.q !== "string" || input.q.length > 500 || typeof input.caseSensitive !== "boolean")
          fail("ORIGINAL_NOTES_INVALID");
        const verify = readFence();
        const rows = input.q ? noteSearch(input.q, { caseSensitive: input.caseSensitive }) : noteList(undefined, 500);
        const items = rows.filter(row => {
          try { path(`${row.slug}.md`); return true; } catch { return false; }
        }).map(item);
        verify();
        check(current);
        return { items, total: items.length };
      }
      if (input.command === "detail") {
        const relative = path(input.path);
        const verify = readFence();
        const row = noteGet(relative.slice(0, -3));
        if (!row || `${row.slug}.md` !== relative) fail("ORIGINAL_NOTES_INVALID");
        let editPin = null;
        let content = row.content;
        if (allowWrite) {
          try {
            const snapshot = readOriginalNoteBodyForEdit(relative);
            content = snapshot.body;
            if (edits.size >= maxEntries) edits.delete(edits.keys().next().value!);
            const id = randomBytes(24).toString("hex");
            const browserRevision = ++sequence;
            edits.set(id, { path: relative, sha256: snapshot.sha256, revision: snapshot.revision, browserRevision });
            editPin = { id, expectedRevision: browserRevision, expectedSha256: snapshot.sha256 };
          } catch { /* Non-editable Notes remain readable, without an edit capability. */ }
        }
        verify();
        check(current);
        return { ...item(row), note_type: row.type, type: "note", documentKind: row.documentKind || "markdown",
          content, tags: row.tags || "[]", editPin };
      }
      if (input.command !== "saveNote" && input.command !== "updateNote") fail("ORIGINAL_NOTES_INVALID");
      check(current, true);
      if (!uuid.test(input.operationId)) fail("ORIGINAL_NOTES_INVALID");
      body(input.content);
      const fingerprint = createHash("sha256").update(JSON.stringify(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
      const previous = operations.get(input.operationId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail("ORIGINAL_NOTES_OPERATION");
        const value = await previous.result;
        check(current, true);
        return value;
      }
      if (operations.size >= maxEntries) fail("ORIGINAL_NOTES_LIMIT");
      const result = Promise.resolve().then(() => options.withWriter(() => {
        check(current, true);
        if (input.command === "saveNote") {
          if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 500 ||
              typeof input.category !== "string" || input.category.length > 2048 ||
              !["general", "todo", "done", "data-path", "observation"].includes(input.type) ||
              !Array.isArray(input.tags) || input.tags.length > 500 || input.tags.some(tag => typeof tag !== "string" || tag.length > 500))
            fail("ORIGINAL_NOTES_INVALID");
          path(`${input.category ? input.category + "/" : ""}${input.title}.md`);
          const relative = createOriginalNoteNoOverwrite(input, () => check(current, true));
          try { check(current, true); } catch { fail("ORIGINAL_NOTES_FAILED"); }
          return { path: relative, slug: relative.slice(0, -3) };
        }
        const edit = edits.get(input.id) ?? fail("ORIGINAL_NOTE_EDIT_CONFLICT");
        if (edit.browserRevision !== input.expectedRevision || edit.sha256 !== input.expectedSha256)
          fail("ORIGINAL_NOTE_EDIT_CONFLICT");
        compareAndSwapOriginalNoteBody(edit.path, edit, input.content, () => check(current, true));
        edits.delete(input.id);
        try { check(current, true); } catch { fail("ORIGINAL_NOTES_FAILED"); }
        return { path: edit.path, slug: edit.path.slice(0, -3) };
      }));
      operations.set(input.operationId, { fingerprint, result });
      const value = await result;
      try { check(current, true); } catch { fail("ORIGINAL_NOTES_FAILED"); }
      return value;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code && /^(ORIGINAL_NOTES_(DENIED|LIMIT|OPERATION|INVALID)|ORIGINAL_NOTE_(EDIT_CONFLICT|EXISTS))$/.test(code))
        fail(code);
      fail("ORIGINAL_NOTES_FAILED");
    } finally { pending--; }
  }, { allowWrite });
  return Object.freeze(bridge);
}
