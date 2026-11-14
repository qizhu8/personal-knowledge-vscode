import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, type Stats } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { z } from "zod";
import { CoreError, type StorageRequest } from "./contracts.js";
import { isArchivedCodePath, isLegacyLibraryResourcePath, legacyCodeArchive, legacyCodeAreas, legacyLibraryAreas, legacyLibraryDestination, legacyScriptIdentitySchema, legacyScriptSidecarTarget } from "./legacy-library.js";
import { libraryEntry } from "./library-contracts.js";

type Entry = z.infer<typeof libraryEntry>;
type File = { entry: Entry; preview: Buffer; pin: string };
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const pin = (stat: Stats) =>
  `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const invalid = (message: string): never => { throw new CoreError("INVALID_DOCUMENT", message); };
const metadataPattern = /^\s*\{#\s*PROMPT_METADATA\n(?<body>[\s\S]*?)\n\s*#\}\s*\n?/;

function languages(name: string, text: string): string[] {
  const ext = extname(name).toLowerCase();
  const known: Record<string, string> = { ".cs": "C#", ".py": "Python", ".ps1": "PowerShell", ".usql": "U-SQL", ".sql": "SQL", ".sh": "Shell" };
  if (known[ext]) return [known[ext]];
  if (ext !== ".script") return [ext ? ext.slice(1).toUpperCase() : "text"];
  const result = ["Scope"], sample = text.slice(0, 20000);
  if (/#CS\b|#ENDCS\b|\bpublic\s+(class|static|struct)\b|\busing\s+System\b/.test(sample)) result.push("C#");
  if (/\bPython(Reducer|Processor|Combiner|Mapper)?\b|#PY\b|\.py"|\bimport\s+\w+/.test(sample)) result.push("Python");
  return result;
}

function scan(root: string) {
  if (resolve(root) !== root || realpathSync(root) !== root || !lstatSync(root).isDirectory())
    invalid("Library root must be a canonical real directory.");
  const files = new Map<string, File>(), pins: Array<[string, string, string | null]> = [];
  const portable = new Set<string>();
  let total = 0;
  function walk(path: string, depth: number) {
    if (depth > 64 || files.size >= 20000) invalid("Library inventory limit exceeded; no partial inventory is returned.");
    if (!isLegacyLibraryResourcePath(path)) invalid(`Unsupported library path: ${path}`);
    const full = join(root, legacyLibraryDestination(path)), before = lstatSync(full);
    if (before.isSymbolicLink() || !before.isDirectory() && (!before.isFile() || before.nlink !== 1))
      invalid(`Library refuses links or special files: ${path}`);
    if (!isArchivedCodePath(legacyLibraryDestination(path)) && before.isDirectory() && basename(path).startsWith(".")) invalid("Hidden library directories are not readable.");
    if ((before.mode & 0o7000) !== 0) invalid(`Library refuses privileged modes: ${path}`);
    const portablePath = path.normalize("NFC").toLowerCase();
    if (portable.has(portablePath)) invalid(`Library portable path collision: ${path}`);
    portable.add(portablePath);
    const area = path.split("/")[0] as Entry["area"];
    const parts = path.split("/");
    const entry: Entry = {
      area, path, kind: before.isDirectory() ? "directory" : "file",
      role: before.isDirectory() ? "directory" : legacyScriptSidecarTarget(path) ? "script-identity"
        : isArchivedCodePath(legacyLibraryDestination(path)) ? "resource"
          : basename(path) === ".gitkeep" ? "placeholder" : area === "scripts" ? "script" : "resource",
      size: before.isFile() ? before.size : 0, sha256: null, mode: before.mode & 0o777,
      prompt: area === "prompts" && before.isFile() && parts.length >= 5
        ? { project: parts[1]!, task: parts[2]!, version: parts[3]!, file: parts.slice(4).join("/") } : null,
      scriptIdentity: null, identityStatus: area === "scripts" && before.isFile()
        && !legacyScriptSidecarTarget(path) && basename(path) !== ".gitkeep" ? "unassigned" : "not-applicable",
    };
    let preview = Buffer.alloc(0);
    if (before.isDirectory()) {
      files.set(path, { entry, preview, pin: pin(before) });
      for (const name of readdirSync(full).sort()) walk(`${path}/${name}`, depth + 1);
    } else {
      if (before.size > 268435456 || total + before.size > 1073741824) invalid("Library byte limit exceeded.");
      const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(fd);
        if (pin(opened) !== pin(before)) invalid("Library file changed during open.");
        const digest = createHash("sha256"), buffer = Buffer.alloc(65536), chunks: Buffer[] = [];
        let size = 0;
        for (;;) {
          const n = readSync(fd, buffer, 0, buffer.length, null);
          if (!n) break;
          size += n;
          if (size > before.size) invalid("Library file grew during read.");
          digest.update(buffer.subarray(0, n));
          if (before.size <= 65536) chunks.push(Buffer.from(buffer.subarray(0, n)));
        }
        if (size !== before.size || pin(fstatSync(fd)) !== pin(before)) invalid("Library file changed during read.");
        preview = Buffer.concat(chunks);
        entry.sha256 = digest.digest("hex");
        total += size;
      } finally { closeSync(fd); }
      files.set(path, { entry, preview, pin: pin(before) });
    }
    if (pin(lstatSync(full)) !== pin(before)) invalid("Library changed during inventory.");
    pins.push([path, pin(before), entry.sha256]);
  }
  try {
    const archive = lstatSync(join(root, legacyCodeArchive));
    if (!archive.isDirectory() || archive.isSymbolicLink() || (archive.mode & 0o7777) !== 0o700)
      invalid("Inert code archive must be a protected real directory.");
    if (readdirSync(join(root, legacyCodeArchive)).some(name => name !== "action-state" && name !== "skills-history"
      && !(legacyCodeAreas as readonly string[]).includes(name)))
      invalid("Inert code archive contains an unknown area.");
    pins.push([legacyCodeArchive, pin(archive), null]);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const area of legacyLibraryAreas) {
    const areaRoot = join(root, legacyLibraryDestination(area));
    try { lstatSync(areaRoot); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const stat = lstatSync(areaRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7000) !== 0) invalid("Library area must be a real directory with ordinary modes.");
    const before = pin(stat);
    for (const name of readdirSync(areaRoot).sort()) walk(`${area}/${name}`, 1);
    if (pin(lstatSync(areaRoot)) !== before) invalid("Library area changed during inventory.");
    pins.push([area, before, null]);
  }
  const claims = new Map<string, string>();
  const claim = (reference: string, path: string) => {
    if (claims.has(reference) && claims.get(reference) !== path) invalid(`Ambiguous Script identity or path alias: ${path}`);
    claims.set(reference, path);
  };
  for (const { entry } of files.values()) {
    if (entry.role === "script") claim(`pkm://scripts/${entry.path.slice(8).split("/").map(encodeURIComponent).join("/")}`, entry.path);
  }
  for (const [path, file] of files) {
    const target = legacyScriptSidecarTarget(path);
    if (!target || file.entry.kind !== "file") continue;
    const body = files.get(target);
    if (!body || body.entry.role !== "script") invalid(`Orphan Script identity: ${path}`);
    if (file.entry.size > 65536) invalid("Script identity exceeds the readable 64 KiB metadata limit.");
    let original: NonNullable<Entry["scriptIdentity"]>;
    try {
      const text = file.preview.toString("utf8");
      if (!Buffer.from(text).equals(file.preview)) invalid("Script identity must be UTF-8.");
      original = z.record(z.string(), z.json()).parse(JSON.parse(text));
      legacyScriptIdentitySchema.parse(original);
    } catch { invalid(`Invalid original Script identity: ${path}`); }
    const identity = legacyScriptIdentitySchema.parse(original!);
    claim(`pkm://script/${identity.knowledgeId}`, target);
    for (const alias of identity.aliases) claim(alias, target);
    body!.entry.scriptIdentity = original!;
    body!.entry.identityStatus = "preserved";
    file.entry.scriptIdentity = original!;
    file.entry.identityStatus = "preserved";
  }
  const revision = hash(JSON.stringify(pins.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
  return { files, revision };
}

export function readLibrary(root: string, request: Pick<StorageRequest, "operation" | "args">): unknown {
  const { operation, args } = request, snapshot = scan(root);
  if (args.snapshotRevision !== undefined && args.snapshotRevision !== snapshot.revision)
    throw new CoreError("CONFLICT", "Library changed; restart listing.");
  const selected = [...snapshot.files.values()].filter(file => file.entry.area === args.area)
    .sort((a, b) => a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0);
  if (operation === "knowledge.library.list") {
    const offset = Number(args.offset), end = offset + Number(args.limit);
    const result = { items: selected.slice(offset, end).map(file => file.entry), total: selected.length,
      nextOffset: end < selected.length ? end : null, snapshotRevision: snapshot.revision };
    if (scan(root).revision !== snapshot.revision) throw new CoreError("CONFLICT", "Library changed during listing.");
    return result;
  }
  if (operation !== "knowledge.library.get") throw new CoreError("ACCESS_DENIED", "Only library reads are admitted.");
  const file = snapshot.files.get(String(args.path));
  if (!file || file.entry.area !== args.area || file.entry.kind !== "file") throw new CoreError("NOT_FOUND", "Choose a returned library file.");
  if (args.expectedDigest !== file.entry.sha256) throw new CoreError("CONFLICT", "Library file digest changed.");
  const offset = Number(args.offset), length = Math.min(Number(args.length), file.entry.size - offset);
  if (offset > file.entry.size) throw new CoreError("INVALID_ARGUMENT", "Offset exceeds library file size.");
  const data = Buffer.alloc(length), fd = openSync(join(root, legacyLibraryDestination(file.entry.path)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (pin(fstatSync(fd)) !== file.pin) throw new CoreError("CONFLICT", "Library file changed before chunk read.");
    let n = 0;
    while (n < length) {
      const count = readSync(fd, data, n, length - n, offset + n);
      if (!count) throw new CoreError("CONFLICT", "Library file truncated during read.");
      n += count;
    }
    if (pin(fstatSync(fd)) !== file.pin) throw new CoreError("CONFLICT", "Library file changed during chunk read.");
  } finally { closeSync(fd); }
  let legacy: Record<string, unknown> | null = null;
  const text = file.preview.toString("utf8"), utf8 = file.entry.size <= 65536 && Buffer.from(text).equals(file.preview);
  if (utf8 && file.entry.prompt) {
    const match = metadataPattern.exec(text), body = match?.groups?.body ?? "";
    const note = /^note:\s*$/m.exec(body);
    legacy = { ...file.entry.prompt, raw: text, content: match ? text.replace(metadataPattern, "").replace(/^\n/, "") : text,
      meta: { title: /^title:\s*(.*)$/m.exec(body)?.[1]?.trim() ?? "", note: note ? body.slice(note.index + note[0].length).trim() : "",
        hasMetadata: !!match } };
  } else if (utf8 && file.entry.role === "script") {
    const langs = languages(basename(file.entry.path), text);
    legacy = { content: text, file: basename(file.entry.path), path: file.entry.path.slice(8), lang: langs.join(" + "), langs,
      knowledgeId: file.entry.scriptIdentity?.knowledgeId ?? null, aliases: file.entry.scriptIdentity?.aliases ?? [] };
  }
  if (scan(root).revision !== snapshot.revision) throw new CoreError("CONFLICT", "Library changed during read.");
  return { item: file.entry, snapshotRevision: snapshot.revision, encoding: "base64", data: data.toString("base64"),
    offset, nextOffset: offset + length < file.entry.size ? offset + length : null, legacy,
    textStatus: file.entry.size > 65536 ? "chunked" : utf8 ? "complete-utf8" : "binary" };
}
