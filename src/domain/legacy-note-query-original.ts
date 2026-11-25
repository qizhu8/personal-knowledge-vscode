import { createHash } from "node:crypto";
import { CoreError } from "../host-composition-legacy-batch15-errors.js";
import type { FreshNoteSource, LegacyNoteListArguments } from "../fresh-note-query-contracts.js";
import { pythonLower, pythonStrip } from "./legacy-note-query-unicode.js";

class PythonNumber {
  constructor(readonly raw: string) {}
}
class PythonObject {
  constructor(readonly entries: Map<string, unknown>) {}
}
const invalid = (message: string): never => { throw new CoreError("INVALID_ARGUMENT", message); };
export const legacyNoteHash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function floatText(raw: string): string {
  const value = Number(raw);
  if (!Number.isFinite(value)) return Number.isNaN(value) ? "NaN" : value < 0 ? "-Infinity" : "Infinity";
  if (Object.is(value, -0)) return "-0.0";
  if (value === 0) return "0.0";
  const exponent = Number(value.toExponential().split("e")[1]);
  if (exponent < -4 || exponent >= 16) {
    const [digits, power] = value.toExponential().split("e");
    const n = Number(power);
    return `${digits}e${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
  }
  const text = value.toString();
  return text.includes(".") ? text : `${text}.0`;
}
function compareCodePoints(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
export function pythonJson(value: unknown, sorted = false, ascii = false, compact = false): string {
  if (value instanceof PythonNumber) return /[.eE]|Infinity|NaN/.test(value.raw)
    ? floatText(value.raw) : BigInt(value.raw).toString();
  if (value === null || typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (!ascii && !/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/.test(value)) throw new CoreError("INVALID_DOCUMENT", "Legacy Note JSON contains an unpaired Unicode surrogate.");
    const text = JSON.stringify(value);
    return ascii ? text.replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`) : text;
  }
  if (Array.isArray(value)) return `[${value.map(item => pythonJson(item, sorted, ascii, compact)).join(compact ? "," : ", ")}]`;
  if (value && typeof value === "object") {
    let pairs = value instanceof PythonObject ? [...value.entries] : Object.entries(value);
    if (sorted) pairs = pairs.sort(([a], [b]) => compareCodePoints(a, b));
    return `{${pairs.map(([key, item]) => `${pythonJson(key, sorted, ascii, compact)}${compact ? ":" : ": "}${pythonJson(item, sorted, ascii, compact)}`).join(compact ? "," : ", ")}}`;
  }
  throw new CoreError("INVALID_DOCUMENT", "Legacy Note projection is not JSON.");
}

// Keep Python int/float distinctions and insertion order when legacy frontmatter uses JSON values.
function parsePythonJson(text: string): unknown {
  let at = 0;
  const space = () => { while (/[ \r\n\t]/.test(text[at] ?? "\0")) at++; };
  const read = (): unknown => {
    space();
    const char = text[at];
    if (char === '"') {
      const start = at++;
      while (at < text.length) {
        if (text[at] === "\\") { at += 2; continue; }
        if (text[at++] === '"') return JSON.parse(text.slice(start, at));
      }
      throw new Error("Unclosed string");
    }
    if (char === "[" || char === "{") {
      at++; space();
      const array: unknown[] = [], object = new Map<string, unknown>(), close = char === "[" ? "]" : "}";
      if (text[at] === close) { at++; return char === "[" ? array : new PythonObject(object); }
      for (;;) {
        const key = read();
        if (char === "{") {
          if (typeof key !== "string") throw new Error("Object key");
          space(); if (text[at++] !== ":") throw new Error("Object separator");
          object.set(key, read());
        } else array.push(key);
        space();
        if (text[at] === close) { at++; return char === "[" ? array : new PythonObject(object); }
        if (text[at++] !== ",") throw new Error("Array/object separator");
      }
    }
    for (const [token, value] of [["null", null], ["true", true], ["false", false]] as const) {
      if (text.startsWith(token, at)) { at += token.length; return value; }
    }
    const number = /^(?:-?Infinity|NaN|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
    if (!number) throw new Error("JSON token");
    at += number[0].length;
    return new PythonNumber(number[0]);
  };
  const result = read(); space();
  if (at !== text.length) throw new Error("Trailing JSON");
  return result;
}
function truth(value: unknown): boolean {
  if (value instanceof PythonNumber) return Number(value.raw) !== 0;
  if (value instanceof PythonObject) return value.entries.size !== 0;
  if (Array.isArray(value)) return value.length !== 0;
  return !!value;
}
export function parseLegacyNote(raw: string): { metadata: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const metadata: Record<string, unknown> = Object.create(null);
  if (!match) return { metadata, body: raw };
  for (const line of match[1]!.split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/u)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = pythonStrip(line.slice(0, colon)), value = pythonStrip(line.slice(colon + 1));
    if (!key) continue;
    try { metadata[key] = parsePythonJson(value); }
    catch { metadata[key] = value.replace(/^["']+|["']+$/g, ""); }
  }
  return { metadata, body: raw.slice(match[0].length) };
}
export function pythonTimestamp(nanoseconds: string): string {
  const ns = BigInt(nanoseconds);
  const value = Number(ns / 1_000_000_000n) + Number(ns % 1_000_000_000n) / 1e9;
  let seconds = Math.floor(value);
  const fraction = (value - seconds) * 1e6, floor = Math.floor(fraction);
  let micros = fraction - floor === 0.5 ? floor + floor % 2 : Math.round(fraction);
  if (micros === 1e6) { seconds++; micros = 0; }
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999)
    throw new CoreError("INVALID_DOCUMENT", "Note modification time is outside the original datetime range.");
  return date.toISOString().slice(0, 19) + (micros ? `.${String(micros).padStart(6, "0")}` : "");
}
export interface LegacyInventoryRow {
  slug: string; title: unknown; type: unknown; documentKind: string; category: string; updated_at: string;
  knowledge_id: string | null; source_id: string; identity_status: string; read_only: boolean; file_hash: string;
}
export interface LegacyProjectedNote {
  readonly row: LegacyInventoryRow;
  readonly title: string;
  readonly content: string;
  readonly searchEligible: boolean;
  readonly walkKey: Buffer;
}
export interface LegacyPathNoteSource {
  readonly path: string;
  readonly raw: string;
  readonly mtimeNs: string;
  readonly boardPresent: boolean;
}
/** Ordinary resolved-path formatting only; the host retains path/recipe/Board read-set authority. */
export function formatLegacyPathNoteGet(source: LegacyPathNoteSource | undefined,
  key: string, relatedRecipes: readonly unknown[]): string {
  if (!source) return `Note '${key}' not found. Use list_notes or search_notes to find it.`;
  const { metadata: fm, body } = parseLegacyNote(source.raw);
  const slug = source.path.slice(0, -3), parts = slug.split("/");
  const title = truth(fm.title) ? fm.title : parts.at(-1)!;
  if (source.boardPresent || fm.documentKind === "todo-board")
    return pythonJson({ slug, title, documentKind: "todo-board",
      message: "Use note_work_items to read authoritative items and note_work_item_command to modify them. Markdown is not task authority." }, false, true);
  const type = truth(fm.type) ? fm.type : "general", tags = truth(fm.tags) ? fm.tags : [], category = parts.slice(0, -1).join("/");
  const contentHash = legacyNoteHash(pythonJson({ title, type, category, tags, content: body }, true, false, true));
  return pythonJson({ slug, content_hash: contentHash, title, content: body, type, tags, category,
    read_only: parts.length > 1 && pythonLower(parts[0]!).replaceAll("\u017f", "s") === "system",
    updated_at: pythonTimestamp(source.mtimeNs), linkage: { related_recipes: relatedRecipes } }, false, true);
}
export function projectLegacyNote(source: Pick<FreshNoteSource, "path" | "raw" | "mtimeNs" | "sha256" | "boardPresent">): LegacyProjectedNote {
  const { metadata: fm, body } = parseLegacyNote(source.raw);
  const slug = source.path.slice(0, -3), parts = slug.split("/");
  const identity = typeof fm.knowledgeId === "string" && /^knowledge_[a-f0-9]{24}$/.test(fm.knowledgeId) ? fm.knowledgeId : null;
  const title = truth(fm.title) ? fm.title : parts.at(-1)!;
  if (typeof title !== "string") throw new CoreError("INVALID_DOCUMENT", "Legacy Note title is not a string.");
  const row: LegacyInventoryRow = {
    slug, title, type: truth(fm.type) ? fm.type : "general",
    documentKind: source.boardPresent || fm.documentKind === "todo-board" ? "todo-board" : "markdown",
    category: parts.slice(0, -1).join("/"), updated_at: pythonTimestamp(source.mtimeNs),
    knowledge_id: identity,
    source_id: identity ? `pkm://knowledge/${identity}` : `pkm://notes/${encodeURIComponent(slug).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`).replaceAll("%2F", "/")}.md`,
    identity_status: identity ? "stable" : "missing",
    read_only: parts.length > 1 && pythonLower(parts[0]!).replaceAll("\u017f", "s") === "system",
    file_hash: source.sha256,
  };
  return { row, title, content: body, searchEligible: source.path.endsWith(".md"),
    walkKey: Buffer.from(source.path.split("/").join("\0"), "utf8") };
}
export function normalizeLegacyDirectory(input?: string | null): string {
  if (input == null) return "";
  if (typeof input !== "string") return invalid("directory must be a Notes-relative path.");
  let value = pythonStrip(input);
  if (value.startsWith("pkm://notes/")) {
    value = value.slice("pkm://notes/".length);
    if (/[?#]/.test(value)) return invalid("Use a Notes folder path without queries or fragments.");
    value = value.replace(/(?:%[0-9a-f]{2})+/gi, bytes => Buffer.from(bytes.replaceAll("%", ""), "hex").toString("utf8"));
  } else if (value.startsWith("notes/")) value = value.slice(6);
  if (value.startsWith("/")) return invalid("directory must be Notes-relative, not an absolute path.");
  value = value.replace(/\/+$/, "");
  if (value && (value.split("/").some(part => !part || part === "." || part === ".." || part.startsWith(".")
    || part === "_assets" || pythonLower(part).endsWith(".assets")) || /[\\:\u0000-\u001f]/u.test(value)))
    return invalid("directory must be a visible Notes-relative folder without traversal.");
  return value;
}
export function normalizeLegacyList(args: LegacyNoteListArguments) {
  const recursive = args.recursive === undefined ? true : args.recursive;
  const offset = args.offset === undefined ? 0 : args.offset, limit = args.limit === undefined ? 50 : args.limit;
  if (typeof recursive !== "boolean") return invalid("recursive must be a boolean.");
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0)
    return invalid("Choose a non-negative offset and limit; limit=0 returns all remaining matches.");
  const revision = args.inventory_revision ?? null;
  if (revision !== null && (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)))
    return invalid("Use the inventory_revision returned by the first page.");
  if (offset && revision === null) return invalid("Later pages require the inventory_revision returned by offset 0.");
  return { directory: normalizeLegacyDirectory(args.directory), recursive, offset, limit, type: args.type ?? null, revision };
}
export interface LegacyInventoryView { rows: LegacyInventoryRow[]; revision: string; bytes: number }
export function buildLegacyInventoryView(rows: readonly LegacyInventoryRow[], args: ReturnType<typeof normalizeLegacyList>): LegacyInventoryView {
  const prefix = args.directory ? `${args.directory}/` : "";
  const selected = rows.filter(row => row.slug.startsWith(prefix)
    && (args.recursive || !row.slug.slice(prefix.length).includes("/"))
    && (!args.type || args.type === "all" || row.type === args.type))
    .sort((a, b) => compareCodePoints(a.slug, b.slug)).map(row => ({ ...row }));
  const counts = new Map<string, number>();
  for (const row of selected) if (row.knowledge_id) counts.set(row.knowledge_id, (counts.get(row.knowledge_id) ?? 0) + 1);
  for (const row of selected) if (row.knowledge_id && counts.get(row.knowledge_id)! > 1) row.identity_status = "duplicate";
  const encoded = pythonJson({ directory: args.directory, recursive: args.recursive, type: args.type, notes: selected }, true);
  return { rows: selected, revision: legacyNoteHash(encoded), bytes: Buffer.byteLength(encoded) };
}
export function legacyInventoryPage(view: LegacyInventoryView, args: ReturnType<typeof normalizeLegacyList>): string {
  if (args.revision !== null && args.revision !== view.revision)
    throw new CoreError("CONFLICT", "Note inventory changed between pages; restart from offset 0.");
  const rows = view.rows, end = args.limit === 0 ? rows.length : args.offset + args.limit, page = rows.slice(args.offset, end);
  return pythonJson({ schema: "pkm.note-inventory/v1", ok: true, directory: args.directory, recursive: args.recursive,
    inventory_revision: view.revision, complete: true, identity_complete: rows.every(row => row.identity_status === "stable"),
    missing_identity_count: rows.filter(row => row.identity_status === "missing").length,
    duplicate_identity_count: rows.filter(row => row.identity_status === "duplicate").length,
    total: rows.length, offset: args.offset, limit: args.limit, returned: page.length, has_more: end < rows.length,
    next_offset: end < rows.length ? end : null, notes: page });
}
