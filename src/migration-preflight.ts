import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync } from "node:fs";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { z } from "zod";
import { documentId } from "./contracts.js";
import { documentPath, resourcePath } from "./document-path.js";
import { legacyKnowledgeAlias } from "./domain/knowledge-contracts.js";
import { readTodoBoard } from "./domain/todo-board.js";
import { decodeMarkdown, sha256 } from "./markdown.js";
import {
  isInertLegacyPath, isLegacyActionStatePath, isLegacyLibraryPath, isLegacyLibraryResourcePath,
  isLegacySkillsHistoryPath, legacyScriptIdentitySchema, legacyScriptSidecarTarget,
} from "./legacy-library.js";

const areas = ["notes", "skills", "papers"] as const;
type Area = typeof areas[number];

export const migrationPreflightLimitsSchema = z.strictObject({
  maxEntries: z.number().int().min(1).default(Number.MAX_SAFE_INTEGER),
  maxDepth: z.number().int().min(0).max(32).default(32),
  maxReadBytes: z.number().int().min(0).default(Number.MAX_SAFE_INTEGER),
});
const legacyTrashPreflightPaths = new Set([
  "notes/.trash", "skills/.trash", "papers/.trash", ".pkm/state/knowledge-deletions.json",
  "recipes/.trash", ".pkm/state/projects.json",
]);
export const migrationPreflightOptionsSchema = migrationPreflightLimitsSchema.extend({
  excludedPaths: z.array(z.string().min(1).max(255)).max(6).default([]),
}).superRefine((value, context) => {
  if (new Set(value.excludedPaths).size !== value.excludedPaths.length
    || value.excludedPaths.some(path => !legacyTrashPreflightPaths.has(path))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Only exact independently-qualified original trash or ProjectStore envelope paths may be excluded." });
  }
});
export const migrationPreflightEntrySchema = z.strictObject({
  path: z.string(), kind: z.enum(["directory", "document", "asset", "board-backing", "library-file", "unsupported", "symlink"]),
  size: z.number().int().nonnegative().optional(),
  mode: z.number().int().min(0).max(0o777).optional(),
  documentId: z.string().optional(), knowledgeId: z.string().optional(),
  board: z.enum(["descriptor", "backing", "descriptor-and-backing"]).optional(),
});
export const migrationPreflightDiagnosticSchema = z.strictObject({
  code: z.string(), path: z.string(), message: z.string(), relatedPath: z.string().optional(),
});
export const migrationPreflightReportSchema = z.strictObject({
  version: z.literal(1), complete: z.boolean(),
  ready: z.boolean().describe("No detected blockers in this bounded inspection; not import or rollback qualification."),
  limits: migrationPreflightLimitsSchema,
  excludedPaths: z.array(z.string()).optional(),
  entries: z.array(migrationPreflightEntrySchema), blockers: z.array(migrationPreflightDiagnosticSchema),
});
export type MigrationPreflightReport = z.infer<typeof migrationPreflightReportSchema>;
export type MigrationPreflightOptions = z.input<typeof migrationPreflightOptionsSchema>;
type Entry = z.infer<typeof migrationPreflightEntrySchema>;
type Diagnostic = z.infer<typeof migrationPreflightDiagnosticSchema>;

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
/**
 * Inspect a caller-supplied disposable copy only. This does not authorize or perform
 * import, cutover, or rollback. `ready` only means no blockers were detected. Exact
 * original trash paths and the independently verified ProjectStore envelope may be
 * excluded only because their bounded importers own those paths; the report records
 * every exclusion.
 * The copy must be quiescent and inaccessible to writers; traversal is not an
 * atomic snapshot and cannot defend against concurrent directory replacement.
 */
export function migrationPreflight(root: string, options: MigrationPreflightOptions = {}): MigrationPreflightReport {
  const parsedOptions = migrationPreflightOptionsSchema.parse(options);
  const limits = migrationPreflightLimitsSchema.parse({
    maxEntries: parsedOptions.maxEntries, maxDepth: parsedOptions.maxDepth, maxReadBytes: parsedOptions.maxReadBytes,
  });
  const excludedPaths = [...parsedOptions.excludedPaths].sort(compare);
  const excluded = new Set(excludedPaths);
  if (!isAbsolute(root)) throw new TypeError("Provide an absolute path to a disposable legacy copy.");
  const base = resolve(root);
  const entries: Entry[] = [], blockers: Diagnostic[] = [];
  let complete = true, readBytes = 0, count = 0, overflow = false;
  const add = (code: string, path: string, message: string, relatedPath?: string) => {
    if (blockers.length >= limits.maxEntries * 4) {
      if (blockers.length === limits.maxEntries * 4) {
        complete = false;
        blockers.push({ code: "diagnostic-limit", path: ".", message: "Too many diagnostics; inspect a smaller copy." });
      }
      return;
    }
    blockers.push({ code, path, message, ...(relatedPath === undefined ? {} : { relatedPath }) });
  };
  const stop = (code: string, path: string, message: string) => { complete = false; add(code, path, message); };
  const addresses = new Map<string, string>(), aliases = new Map<string, string>(), portablePaths = new Map<string, string>();
  const scriptReferences = new Map<string, string>();
  const identity = (map: Map<string, string>, value: string, path: string, code: string) => {
    const previous = map.get(value);
    if (previous !== undefined && previous !== path) add(code, path, "Resolve the conflicting identities or paths before any import.", previous);
    else map.set(value, path);
  };
  // Refuse links in every component of the supplied root, not just its final component.
  try {
    let current = parse(base).root;
    for (const part of base.slice(current.length).split(sep).filter(Boolean)) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe root");
    }
  } catch {
    stop("unsafe-root", ".", "Supply an existing real directory whose path contains no symlinks.");
    return { version: 1, complete, ready: false, limits, entries, blockers };
  }

  function readChecked(path: string, relative: string, size: number): string | undefined {
    if (readBytes + size > limits.maxReadBytes) {
      stop("read-budget", relative, "Increase the read budget within the supported maximum or inspect a smaller copy.");
      return;
    }
    let fd: number | undefined;
    try {
      const before = lstatSync(path);
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const actual = fstatSync(fd);
      if (!before.isFile() || !actual.isFile() || before.dev !== actual.dev || before.ino !== actual.ino || actual.size !== size) throw new Error("changed");
      const bytes = Buffer.alloc(size + 1);
      let n = 0;
      while (n < bytes.length) {
        const got = readSync(fd, bytes, n, bytes.length - n, null);
        if (!got) break;
        n += got;
      }
      readBytes += n;
      if (n !== size || fstatSync(fd).size !== size) throw new Error("changed");
      const text = bytes.subarray(0, n).toString("utf8");
      if (!Buffer.from(text, "utf8").equals(bytes.subarray(0, n))) {
        add("invalid-utf8", relative, "Preserve and repair the invalid UTF-8 before any import.");
        return;
      }
      return text;
    } catch {
      stop("read-failed", relative, "The file changed or could not be read safely; inspect a quiescent copy.");
      return;
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  function walk(directory: string, relative: string, depth: number, area?: Area,
    mode: "normal" | "assets" | "library" | "history" | "unsupported" = "normal") {
    let names: string[] = [];
    try {
      const handle = opendirSync(directory);
      try {
        for (;;) {
          const item = handle.readSync();
          if (!item) break;
          names.push(item.name);
          if (names.length + count > limits.maxEntries) { overflow = true; break; }
        }
      } finally { handle.closeSync(); }
    } catch {
      stop("directory-unreadable", relative || ".", "Inspect permissions and retry against a quiescent copy.");
      return;
    }
    if (overflow) return;
    names.sort(compare);
    for (const name of names) {
      const rel = relative ? `${relative}/${name}` : name;
      if (excluded.has(rel)) continue;
      if (++count > limits.maxEntries) { overflow = true; return; }
      const path = join(directory, name);
      if (Buffer.byteLength(rel) > 2048) {
        entries.push({ path: rel.slice(0, 2048), kind: "unsupported" });
        stop("path-limit", rel.slice(0, 2048), "Path exceeds the 2048-byte inventory limit; inspect it separately.");
        continue;
      }
      let stat;
      try { stat = lstatSync(path); }
      catch { stop("entry-unreadable", rel, "Entry changed or is unreadable; inspect a quiescent copy."); continue; }
      if (stat.isSymbolicLink()) {
        entries.push({ path: rel, kind: "symlink" });
        add("symlink", rel, "Replace or separately review the symlink in a disposable copy; targets are never followed.");
        continue;
      }
      const topArea = !relative && areas.includes(name as Area) ? name as Area : undefined;
      const currentArea = area ?? topArea;
      let nextMode = mode;
      if (!relative && !topArea) nextMode = isLegacyLibraryPath(rel) && stat.isDirectory() ? "library" : "unsupported";
      if (isLegacyActionStatePath(rel)) {
        if (isLegacyLibraryResourcePath(rel)) nextMode = "library";
        else add("unsafe-action-state-path", rel, "Action history must use portable, non-traversing paths.");
        if (rel !== ".pkm/state/actions" && /(?:^|[._-])(?:locks?|lck|intents?)(?:[._-]|$)|\.(?:tmp|partial)$/i.test(name))
          add("pending-action-state", rel, "Action lock, intent or temporary state requires reconciliation before archive.");
      }
      const skillsTrash = mode === "normal" && currentArea === "skills" && stat.isDirectory() && name === ".trash";
      const skillsMarker = mode === "normal" && currentArea === "skills" && stat.isFile() && name === ".gitkeep";
      const unmanagedSkillFile = mode === "normal" && currentArea === "skills" && stat.isFile()
        && !name.startsWith(".") && !/\.md$/i.test(name);
      if (skillsTrash || skillsMarker || unmanagedSkillFile) nextMode = "history";
      if (mode === "library" && !isLegacyLibraryResourcePath(rel)) nextMode = "unsupported";
      if (mode === "library" && !isInertLegacyPath(rel) && name.startsWith(".") && stat.isDirectory()) nextMode = "unsupported";
      if (mode === "normal" && currentArea && relative && !skillsTrash && !skillsMarker && !unmanagedSkillFile
        && (name === "_assets" || name === ".trash" || name.startsWith("."))) nextMode = "unsupported";
      if (mode === "normal" && currentArea && relative && /\.assets$/i.test(name) && stat.isDirectory()) {
        const stem = name.replace(/\.assets$/i, "");
        const owners = names.filter(candidate => /\.md$/i.test(candidate) && candidate.replace(/\.md$/i, "") === stem);
        const owned = owners.length === 1 && (() => { try { const s = lstatSync(join(directory, owners[0]!)); return s.isFile() && !s.isSymbolicLink(); } catch { return false; } })();
        if (!owned) add("unowned-assets", rel, "Associate this asset directory with exactly one matching Markdown document.");
        nextMode = "assets";
      }
      const kind: Entry["kind"] = stat.isDirectory() ? "directory" : nextMode === "assets" && stat.isFile()
        ? name === "pkm-todo-board.json" ? "board-backing" : "asset"
        : (nextMode === "library" || nextMode === "history") && stat.isFile() ? "library-file"
        : nextMode === "normal" && currentArea && stat.isFile() && /\.md$/i.test(name) ? "document" : "unsupported";
      const entry: Entry = { path: rel, kind, ...(stat.isFile() ? { size: stat.size } : {}),
        ...((kind === "library-file" || (nextMode === "library" || nextMode === "history")
          && isInertLegacyPath(rel, stat.isDirectory() ? "directory" : "file")) && process.platform !== "win32"
          ? { mode: stat.mode & 0o777 } : {}) };
      entries.push(entry);
      if (nextMode === "library" || nextMode === "history") {
        const history = nextMode === "history";
        if (isInertLegacyPath(rel, stat.isDirectory() ? "directory" : "file") && process.platform !== "linux")
          add(history ? "inert-history-platform-unsupported" : "inert-code-platform-unsupported", rel,
            "Protected inert archives require the qualified Linux permission boundary; no platform ACL policy is inferred.");
        identity(portablePaths, rel.normalize("NFC").toLowerCase(), rel, "portable-path-collision");
        if (process.platform !== "win32" && (stat.mode & 0o7000) !== 0) {
          add(history ? "history-special-permissions" : "library-special-permissions", rel,
            "Review special permission bits before import; privileged modes are never silently copied or stripped.");
        }
        if (stat.isFile() && stat.nlink !== 1) add(history ? "history-hardlink" : "library-hardlink", rel,
          "Hardlinked archive files must be independently reviewed; import never follows or duplicates linked authority.");
        if (history && stat.isFile() && (stat.size > 268_435_456 || !isLegacySkillsHistoryPath(rel)
          || !isLegacyLibraryResourcePath(rel))) {
          add("unsupported-skills-history-entry", rel, "Only portable regular historical files and directories can be preserved in the inert Skills archive.");
        }
        if (!history && kind === "library-file" && legacyScriptSidecarTarget(rel)) {
          if (stat.size > 65536) add("script-identity-limit", rel, "Script identity metadata exceeds the 64 KiB bounded read contract; preserve and review it.");
          const raw = readChecked(path, rel, stat.size);
          if (raw !== undefined) {
            try {
              const value = legacyScriptIdentitySchema.parse(JSON.parse(raw));
              const target = legacyScriptSidecarTarget(rel)!;
              for (const reference of [`pkm://script/${value.knowledgeId}`, ...value.aliases]) {
                identity(scriptReferences, reference, target, "script-identity-collision");
              }
            } catch {
              add("script-identity-invalid", rel, "Preserve and repair the original Script identity sidecar before import.");
            }
          }
        }
      }
      if (kind === "asset" && stat.size > 16_777_216) add("asset-too-large", rel, "The next-server resource API permits at most 16 MiB per file.");
      if (rel === ".pkm/state/knowledge-deletions.json") {
        add("deletion-journal", rel, "Preserve and reconcile deletion intent before any import; preflight does not interpret or replay it.");
      }
      if (nextMode === "unsupported" && mode !== "unsupported") {
        const code = name === ".trash" ? "trash" : name === "_assets" ? "legacy-assets" : name === ".gitkeep" ? "gitkeep" : name.startsWith(".") ? "metadata" : "unsupported-surface";
        add(code, rel, "Preserve and explicitly reconcile this unsupported legacy surface before import.");
      } else if (kind === "unsupported" && nextMode !== "unsupported") {
        add("unsupported-entry", rel, "Review this non-Markdown or special entry before import.");
      }
      if (currentArea && relative && nextMode !== "unsupported") {
        const areaRel = rel.slice(currentArea.length + 1);
        const normalized = `${currentArea}/${areaRel.normalize("NFC").toLowerCase()}`;
        identity(portablePaths, normalized, rel, "portable-path-collision");
        if (kind === "document" && !documentPath.safeParse(areaRel).success || nextMode === "assets" && !resourcePath.safeParse(areaRel).success ||
          kind === "directory" && nextMode === "normal" && !documentPath.safeParse(`${areaRel}/placeholder.md`).success) {
          add("unsafe-path", rel, "Rename this path in a reviewed copy to satisfy portable next-server paths.");
        }
      }
      if (kind === "document" && currentArea) {
        const areaRel = rel.slice(currentArea.length + 1);
        const raw = readChecked(path, rel, stat.size);
        if (raw !== undefined) {
          try {
            const parsed = decodeMarkdown("placeholder", raw, areaRel, currentArea);
            const metadata = parsed.metadata;
            const values = metadata.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
            const prototype = metadata.get("schema") === "pkm.knowledge/v1" && metadata.has("revision") && metadata.has("deleted") && Array.isArray(values.aliases)
              ? [...new Set(values.aliases.filter((a): a is string => typeof a === "string" && a.startsWith("note:") && documentId.safeParse(a.slice(5)).success).map(a => a.slice(5)))] : [];
            const explicit = metadata.has("documentId") ? metadata.get("documentId") : prototype.length === 1 ? prototype[0] : metadata.get("knowledgeId");
            const filename = name.replace(/\.md$/i, "");
            const id = explicit === undefined ? currentArea === "notes" && !areaRel.includes("/") && documentId.safeParse(filename).success
              ? filename : `legacy_${sha256(currentArea === "notes" ? areaRel : `${currentArea}/${areaRel}`).slice(0, 32)}` : explicit;
            if (!documentId.safeParse(id).success) add("invalid-identity", rel, "Repair the invalid stable document identity before import.");
            else {
              entry.documentId = id as string;
              identity(addresses, id as string, rel, "identity-collision");
            }
            const knowledgeId = metadata.get("knowledgeId");
            if (knowledgeId !== undefined) {
              if (typeof knowledgeId !== "string" || !/^knowledge_[a-f0-9]{24}$/.test(knowledgeId)) add("invalid-knowledge-id", rel, "Repair the invalid Knowledge ID before import.");
              else entry.knowledgeId = knowledgeId;
              if (typeof knowledgeId === "string" && knowledgeId.length <= 2048) identity(addresses, knowledgeId, rel, "identity-collision");
            }
            const kindName = currentArea === "notes" ? "note" : currentArea === "skills" ? "skill" : "research";
            identity(aliases, legacyKnowledgeAlias(kindName, areaRel), rel, "alias-collision");
            if (values.aliases !== undefined) {
              if (!Array.isArray(values.aliases) || values.aliases.length > 128 || values.aliases.some(a => typeof a !== "string" || a.length > 2048 || !/^(note|skill|research|recipe):[^\u0000-\u001f]+$/.test(a))) {
                add("invalid-aliases", rel, "Review and repair the legacy aliases before import.");
              } else for (const alias of values.aliases as string[]) identity(aliases, alias.normalize("NFC"), rel, "alias-collision");
            }
            if (currentArea === "notes" && metadata.get("documentKind") === "todo-board") entry.board = "descriptor";
          } catch {
            add("invalid-document", rel, "Review Markdown frontmatter and document contract before import.");
          }
        }
      }
      if (kind === "board-backing") {
        const raw = readChecked(path, rel, stat.size);
        if (raw !== undefined) {
          try { readTodoBoard(raw); }
          catch { add("invalid-board", rel, "Review and repair the Board backing using a verified snapshot."); }
        }
        add("board-migration", rel, "Board backing requires an explicit reviewed migration; it is not imported by preflight.");
      }
      if (stat.isDirectory()) {
        if (depth >= limits.maxDepth) stop("depth-limit", rel, "Increase the depth limit within the supported maximum or inspect this subtree separately.");
        else walk(path, rel, depth + 1, currentArea, nextMode);
        if (overflow) return;
      }
    }
  }
  walk(base, "", 0);
  if (overflow) return { version: 1, complete: false, ready: false, limits, excludedPaths, entries: [], blockers: [{
    code: "entry-limit", path: ".", message: "The copy exceeds the entry limit; no partial inventory is returned.",
  }] };
  const entryMap = new Map(entries.map(entry => [entry.path, entry]));
  for (const entry of entries.filter(item => item.kind === "library-file")) {
    const target = legacyScriptSidecarTarget(entry.path);
    if (target && entryMap.get(target)?.kind !== "library-file") {
      add("script-identity-orphan", entry.path, "Script identity must have its original regular Script file.");
    }
    if (entry.path.startsWith("scripts/") && !target && !entry.path.endsWith("/.gitkeep")) {
      const reference = `pkm://scripts/${entry.path.slice(8).split("/").map(encodeURIComponent).join("/")}`;
      identity(scriptReferences, reference, entry.path, "script-identity-collision");
    }
  }
  for (const area of areas) {
    const docs = entries.filter(entry => entry.kind === "document" && entry.path.startsWith(`${area}/`));
    if (area !== "notes" && (docs.length > 4096 || docs.reduce((sum, item) => sum + (item.size ?? 0), 0) > 33_554_432)) {
      add("snapshot-limit", area, "The next-server area snapshot permits at most 4096 documents and 32 MiB.");
    }
  }
  const assetTrees = new Map<string, { count: number; bytes: number }>();
  for (const entry of entries) {
    const segments = entry.path.split("/");
    const index = segments.findIndex((part, i) => i > 0 && /\.assets$/i.test(part));
    if (index < 0) continue;
    const tree = segments.slice(0, index + 1).join("/");
    const total = assetTrees.get(tree) ?? { count: 0, bytes: 0 };
    total.count++;
    total.bytes += entry.size ?? 0;
    assetTrees.set(tree, total);
  }
  for (const [path, total] of assetTrees) if (total.count > 2048 || total.bytes > 67_108_864) {
    add("asset-catalog-limit", path, "The next-server resource catalog permits at most 2048 entries and 64 MiB; shared references can add more.");
  }
  for (const entry of entries) {
    if (entry.kind !== "document" || !entry.path.startsWith("notes/")) continue;
    const backing = entryMap.get(`${entry.path.replace(/\.md$/i, ".assets")}/pkm-todo-board.json`);
    if (backing?.kind === "board-backing") entry.board = entry.board ? "descriptor-and-backing" : "backing";
    if (entry.board) {
      add("board-migration", entry.path, "Legacy Board descriptors and backing require explicit reviewed conversion; no Board is imported.");
      if (entry.board === "descriptor") add("board-backing-missing", entry.path, "Review the descriptor and locate or explicitly reconcile its missing backing.");
    }
  }
  if (!entryMap.has("notes")) add("missing-notes", "notes", "Supply the legacy notes directory, even if it is empty.");
  for (const area of areas) {
    const entry = entryMap.get(area);
    if (entry && entry.kind !== "directory") add("invalid-area", area, "The area root must be a real directory.");
  }
  entries.sort((a, b) => compare(a.path, b.path));
  blockers.sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code) || compare(a.relatedPath ?? "", b.relatedPath ?? ""));
  return { version: 1, complete, ready: complete && blockers.length === 0, limits, excludedPaths, entries, blockers };
}
