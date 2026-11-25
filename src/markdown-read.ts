import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, type BigIntStats } from "node:fs";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { Document, parseDocument, isMap } from "yaml";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { documentId, documentSchema, type DocumentRecord } from "./document-read-contracts.js";
import { checkedDocumentPath, checkedResourcePath, documentPath, knowledgeArea, type KnowledgeArea } from "./document-path.js";
import {
  qualifyFreshRootScan, knowledgeReadPrivateTopLevels, type FreshNoteSource, type FreshRootScanner,
} from "./fresh-note-query-contracts.js";

export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export interface MarkdownRecord { record: DocumentRecord & { path: string; area: KnowledgeArea }; raw: string; metadata: Document }
export interface MarkdownSnapshotRecord {
  readonly record: Readonly<MarkdownRecord["record"]>;
  readonly raw: string;
}
type CachedMarkdownRecord = {
  fingerprint: string;
  id: string;
  contentStart: number;
  record: Omit<MarkdownRecord["record"], "content">;
  metadata: Document;
};
const markdownScanCaches = new Map<string, Map<string, CachedMarkdownRecord>>();
const slowScanWarningMs = 2_000;
const slowScanWarningIntervalMs = 60_000;
let lastSlowScanWarningAt = 0;
function readRawMarkdown(path: string) {
  const bytes = readFileSync(path), raw = bytes.toString("utf8");
  if (!Buffer.from(raw, "utf8").equals(bytes)) throw new CoreError("INVALID_DOCUMENT", "Markdown must be valid UTF-8; invalid bytes were not replaced.");
  return raw;
}
function parseMetadata(raw: string, label: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match && /^---(?:\r?\n|$)/.test(raw)) throw new CoreError("INVALID_DOCUMENT", `Document ${label} has unclosed YAML frontmatter.`);
  const metadata = match ? parseDocument(match[1], { uniqueKeys: true }) : new Document({});
  if (metadata.errors.length || !isMap(metadata.contents)) throw new CoreError("INVALID_DOCUMENT", `Document ${label} has invalid YAML frontmatter.`);
  let values: unknown;
  try { values = metadata.toJS({ maxAliasCount: 0 }); }
  catch { throw new CoreError("INVALID_DOCUMENT", `Document ${label} has unsupported YAML aliases.`); }
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new CoreError("INVALID_DOCUMENT", `Document ${label} metadata must be an object.`);
  return { metadata, content: raw.slice(match?.[0].length ?? 0), contentStart: match?.[0].length ?? 0 };
}
function markdownIdentity(metadata: Document, relative: string, area: KnowledgeArea): string {
  const values: unknown = metadata.toJS({ maxAliasCount: 0 });
  const aliases = values && typeof values === "object" && "aliases" in values ? values.aliases : undefined;
  const prototypeIds = metadata.get("schema") === "pkm.knowledge/v1" && metadata.has("revision") && metadata.has("deleted") && Array.isArray(aliases) ? [...new Set(aliases.filter((alias): alias is string =>
    typeof alias === "string" && alias.startsWith("note:") && documentId.safeParse(alias.slice(5)).success).map(alias => alias.slice(5)))] : [];
  const identity = metadata.has("documentId") ? metadata.get("documentId")
    : prototypeIds.length === 1 ? prototypeIds[0] : metadata.get("knowledgeId");
  const filename = basename(relative).replace(/\.md$/i, "");
  const id = identity === undefined ? (area === "notes" && documentId.safeParse(filename).success && !relative.includes("/") ? filename : `legacy_${sha256(area === "notes" ? relative : `${area}/${relative}`).slice(0, 32)}`) : identity;
  if (!documentId.safeParse(id).success) throw new CoreError("INVALID_DOCUMENT", `Invalid stable identity in ${relative}.`);
  if (typeof id !== "string") throw new CoreError("INVALID_DOCUMENT", `Document identity must be a string: ${relative}`);
  return id;
}
export function decodeMarkdownPath(raw: string, relative: string, area: KnowledgeArea = "notes"): MarkdownRecord {
  const parsed = parseMetadata(raw, relative);
  return decodeMarkdownParts(markdownIdentity(parsed.metadata, relative, area), raw, relative, area, parsed.metadata, parsed.content);
}
export function readKnowledgePathSnapshot(root: string, relative: string, area: KnowledgeArea, markdown = false) {
  if (knowledgeReadPrivateTopLevels(root, area).has(relative.split("/")[0]!))
    return { parents: ["original-mcp-private-denial"], file: undefined };
  try { (markdown ? checkedDocumentPath : checkedResourcePath)(root, relative, false, area); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw new CoreError("INVALID_DOCUMENT", error instanceof Error ? error.message : String(error));
  }
  const parents: string[] = [], descriptors: number[] = [];
  const pin = (stat: BigIntStats) =>
    `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}:${stat.nlink}:${stat.uid}:${stat.gid}`;
  let file: { bytes: Buffer; pin: string; mtimeNs: string; size: number } | undefined;
  try {
    let fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    descriptors.push(fd);
    const rootStat = fstatSync(fd, { bigint: true });
    parents.push(`${root}:${rootStat.dev}:${rootStat.ino}`);
    const parts = [area, ...relative.split("/")];
    for (let index = 0; index < parts.length; index++) {
      const final = index === parts.length - 1;
      let next: number;
      try {
        next = openSync(`/proc/self/fd/${fd}/${parts[index]}`, constants.O_RDONLY | constants.O_NOFOLLOW
          | constants.O_NONBLOCK | (final ? 0 : constants.O_DIRECTORY));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          parents.push(`${parts.slice(0, index + 1).join("/")}:missing`);
          break;
        }
        throw new CoreError("INVALID_DOCUMENT", "Knowledge paths require regular non-symlink parents and files.");
      }
      descriptors.push(next);
      const stat = fstatSync(next, { bigint: true });
      if (final) {
        if (!stat.isFile() || stat.nlink !== 1n)
          throw new CoreError("INVALID_DOCUMENT", "Knowledge paths require single-link regular files.");
        const bytes = readFileSync(next), after = fstatSync(next, { bigint: true });
        const named = lstatSync(`/proc/self/fd/${fd}/${parts[index]}`, { bigint: true, throwIfNoEntry: false });
        if (!named || !named.isFile() || named.isSymbolicLink() || pin(stat) !== pin(after) || pin(stat) !== pin(named)
          || BigInt(bytes.length) !== stat.size)
          throw new CoreError("CONFLICT", "CONFLICT: Knowledge changed during path read.");
        file = { bytes, pin: `${pin(stat)}:${sha256(bytes)}`, mtimeNs: String(stat.mtimeNs), size: bytes.length };
      } else {
        parents.push(`${join(root, ...parts.slice(0, index + 1))}:${stat.dev}:${stat.ino}`);
      }
      fd = next;
    }
    for (let index = 0; index < descriptors.length - (file ? 1 : 0); index++) {
      const path = index === 0 ? root : join(root, ...parts.slice(0, index));
      const named = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      const held = fstatSync(descriptors[index]!, { bigint: true });
      if (!named?.isDirectory() || named.isSymbolicLink() || named.dev !== held.dev || named.ino !== held.ino)
        throw new CoreError("CONFLICT", "CONFLICT: Knowledge path parents changed during read.");
    }
    return { parents, file };
  } finally { for (const fd of descriptors.reverse()) closeSync(fd); }
}
function decodeMarkdownParts(id: string, raw: string, path: string, area: KnowledgeArea, metadata: Document, content: string, digest = sha256(raw)): MarkdownRecord {
  const parsed = documentSchema.safeParse({
    id, path, area, title: metadata.has("title") ? metadata.get("title") : basename(path).replace(/\.md$/i, ""),
    revision: metadata.has("revision") ? metadata.get("revision") : 1,
    deleted: metadata.has("deleted") ? metadata.get("deleted") : false,
    content, sha256: digest,
  });
  if (!parsed.success) throw new CoreError("INVALID_DOCUMENT", `Document ${path} metadata/content violates the document contract.`);
  return { record: { ...parsed.data, path, area }, raw, metadata };
}
export function decodeMarkdown(id: string, raw: string, path = `${id}.md`, area: KnowledgeArea = "notes"): MarkdownRecord {
  const parsed = parseMetadata(raw, path);
  return decodeMarkdownParts(id, raw, path, area, parsed.metadata, parsed.content);
}
export function readMarkdown(root: string, id: string, relative = `${id}.md`, area: KnowledgeArea = "notes"): MarkdownRecord | undefined {
  let path: string;
  try { path = checkedDocumentPath(root, relative, false, area); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new CoreError("INVALID_DOCUMENT", error instanceof Error ? error.message : String(error));
  }
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new CoreError("INVALID_DOCUMENT", `Document ${relative} must be a regular Markdown file.`);
  return decodeMarkdown(id, readRawMarkdown(path), relative, area);
}
export function scanMarkdown(root: string): MarkdownRecord[];
export function scanMarkdown(root: string, options: { metadata: false }): readonly MarkdownSnapshotRecord[];
export function scanMarkdown(root: string, options?: { metadata: false }): MarkdownRecord[] | readonly MarkdownSnapshotRecord[] {
  const startedAt = performance.now();
  const result: MarkdownRecord[] = [];
  const ids = new Set<string>();
  const knowledgeIds = new Set<string>();
  const rootPath = resolve(root);
  let cache = markdownScanCaches.get(rootPath);
  if (!cache) {
    if (markdownScanCaches.size >= 16) {
      const oldest = markdownScanCaches.keys().next().value;
      if (oldest) markdownScanCaches.delete(oldest);
    }
    cache = new Map();
  }
  markdownScanCaches.delete(rootPath);
  markdownScanCaches.set(rootPath, cache);
  const seen = new Set<string>();
  const originalPrivate = new Map(knowledgeArea.options.map(area => [area, knowledgeReadPrivateTopLevels(rootPath, area)]));
  function walk(directory: string, prefix: string, depth: number, area: KnowledgeArea) {
    if (depth > 32) throw new CoreError("INVALID_WORKSPACE", "Markdown nesting exceeds 32 levels.");
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoreError("INVALID_WORKSPACE", "Notes directories must be real directories, not links.");
    const names = readdirSync(directory).sort();
    for (const name of names) {
      const path = join(directory, name), relative = prefix ? `${prefix}/${name}` : name;
      if (originalPrivate.get(area)?.has(relative.split("/")[0]!)) continue;
      const entry = lstatSync(path, { bigint: true });
      if (entry.isSymbolicLink()) throw new CoreError("INVALID_DOCUMENT", `Notes symlinks are not supported: ${relative}`);
      if (name === ".gitkeep" && entry.isFile()) continue;
      if (area === "notes" && !prefix && name === ".pk-meta.json") {
        if (!entry.isFile()) throw new CoreError("INVALID_DOCUMENT", "The reserved Note folder-pin sidecar must be a regular file.");
        continue;
      }
      if (/^\.pkm-write-[a-fA-F0-9-]+$/.test(name) && entry.isFile()) continue;
      if (entry.isDirectory()) {
        if (name === ".trash" || name === "_assets") continue;
        if (/\.assets$/i.test(name)) {
          const owners = names.filter(candidate => /\.md$/i.test(candidate) && candidate.replace(/\.md$/i, "") === name.replace(/\.assets$/i, ""));
          if (owners.length !== 1 || !lstatSync(join(directory, owners[0]!)).isFile()) throw new CoreError("INVALID_DOCUMENT", `Unowned or ambiguous Markdown resource directory: ${relative}`);
          continue;
        }
        if (!documentPath.safeParse(`${relative}/placeholder.md`).success) throw new CoreError("INVALID_DOCUMENT", `Unsafe Notes folder: ${relative}`);
        walk(path, relative, depth + 1, area);
        continue;
      }
      if (!entry.isFile() || !documentPath.safeParse(relative).success) throw new CoreError("INVALID_DOCUMENT", `Unsupported notes entry: ${relative}`);
      seen.add(path);
      const fingerprint = `${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeNs}:${entry.ctimeNs}`;
      const cached = cache!.get(path);
      const raw = readRawMarkdown(path), digest = sha256(raw);
      if (cached?.fingerprint === fingerprint && cached.record.sha256 === digest) {
        const knowledgeId = cached.metadata.get("knowledgeId");
        if (ids.has(cached.id)) throw new CoreError("CONFLICT", `Duplicate document identity: ${cached.id}`);
        ids.add(cached.id);
        if (typeof knowledgeId === "string") {
          if (knowledgeIds.has(knowledgeId)) throw new CoreError("CONFLICT", `Duplicate knowledgeId: ${knowledgeId}`);
          knowledgeIds.add(knowledgeId);
        }
        const document = {
          record: { ...cached.record, content: raw.slice(cached.contentStart) },
          raw,
          metadata: options?.metadata === false ? cached.metadata : cached.metadata.clone(),
        };
        result.push(document);
        continue;
      }
      const { metadata, content, contentStart } = parseMetadata(raw, relative);
      const id = markdownIdentity(metadata, relative, area);
      const knowledgeId = metadata.get("knowledgeId");
      if (typeof knowledgeId === "string") {
        if (knowledgeIds.has(knowledgeId)) throw new CoreError("CONFLICT", `Duplicate knowledgeId: ${knowledgeId}`);
        knowledgeIds.add(knowledgeId);
      }
      if (ids.has(id)) throw new CoreError("CONFLICT", `Duplicate document identity: ${id}`);
      ids.add(id);
      const document = decodeMarkdownParts(id, raw, relative, area, metadata, content, digest);
      const { content: _content, ...record } = document.record;
      cache!.set(path, { fingerprint, id, contentStart, record,
        metadata: options?.metadata === false ? metadata : metadata.clone() });
      result.push(document);
    }
  }
  for (const area of knowledgeArea.options) {
    const directory = join(root, area);
    try { lstatSync(directory); }
    catch (error) {
      if (area !== "notes" && error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    walk(directory, "", 0, area);
  }
  const addresses = new Map<string, string>();
  for (const { record, metadata } of result) {
    const identity = metadata.get("knowledgeId");
    for (const key of [record.id, ...(typeof identity === "string" ? [identity] : [])]) {
      const address = `${record.area}/${record.path}`;
      if (addresses.has(key) && addresses.get(key) !== address) throw new CoreError("CONFLICT", `Ambiguous document/knowledge identity: ${key}`);
      addresses.set(key, address);
    }
  }
  for (const path of cache!.keys()) if (!seen.has(path)) cache!.delete(path);
  const documents = result.sort((left, right) => left.record.id < right.record.id ? -1 : left.record.id > right.record.id ? 1 : 0);
  const durationMs = performance.now() - startedAt;
  if (durationMs >= slowScanWarningMs && Date.now() - lastSlowScanWarningAt >= slowScanWarningIntervalMs) {
    lastSlowScanWarningAt = Date.now();
    console.warn("PKM next slow Markdown scan:", JSON.stringify({ durationMs: Math.round(durationMs), documents: documents.length }));
  }
  return options?.metadata === false
    ? Object.freeze(documents.map(({ record, raw }) => Object.freeze({ record: Object.freeze(record), raw })))
    : documents;
}
/** Fresh bytes qualify only this scanner's private, previously parsed immutable entries. */
export function createFreshRootScanner(root: string): FreshRootScanner {
    const canonical = resolve(root);
    const directoryPin = (stat: BigIntStats) => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.gid}`;
    const filePin = (stat: BigIntStats) => `${directoryPin(stat)}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const initial = lstatSync(canonical, { bigint: true });
    if (!initial.isDirectory() || initial.isSymbolicLink() || realpathSync(canonical) !== canonical)
      throw new CoreError("INVALID_WORKSPACE", "Fresh queries require a real canonical Knowledge Root.");
    const rootPin = `${initial.dev}:${initial.ino}`, expectedRoot = `${canonical}:${directoryPin(initial)}`;
    let cached = new Map<string, FreshNoteSource>();
    const ids = new Map<string, string>(), knowledgeIds = new Map<string, string>(), addresses = new Map<string, string>();
    const statistics = { scans: 0, reads: 0, parses: 0, identityUpdates: 0 };
    function readSourceBytes(fd: number, size: bigint): Buffer {
      // Keep Node's own large-file allocation/error path rather than widen its read limit.
      if (size < 0n || size > 0x7fffffffn) return readFileSync(fd);
      const length = Number(size), bytes = Buffer.allocUnsafe(length);
      if (length === 0) {
        if (readSync(fd, Buffer.allocUnsafe(1), 0, 1, null) !== 0)
          throw new CoreError("CONFLICT", "Knowledge changed during fresh source read.");
      } else {
        let offset = 0;
        while (offset < length) {
          const count = readSync(fd, bytes, offset, length - offset, null);
          if (count === 0) throw new CoreError("CONFLICT", "Knowledge changed during fresh source read.");
          offset += count;
        }
      }
      return bytes;
    }
    function readFile(parent: number, name: string) {
      const path = `/proc/self/fd/${parent}/${name}`;
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = fstatSync(fd, { bigint: true });
        if (!before.isFile()) throw new CoreError("INVALID_DOCUMENT", "Fresh query sources must be regular files.");
        const bytes = readSourceBytes(fd, before.size), after = fstatSync(fd, { bigint: true });
        const named = lstatSync(path, { bigint: true });
        const beforePin = filePin(before), afterPin = filePin(after);
        if (beforePin !== afterPin || beforePin !== filePin(named) || BigInt(bytes.length) !== after.size)
          throw new CoreError("CONFLICT", "Knowledge changed during fresh source read.");
        statistics.reads++;
        return { bytes, stat: after, pin: afterPin, digest: sha256(bytes) };
      } finally { closeSync(fd); }
    }
    function scan() {
      if (process.platform !== "linux") throw new CoreError("NOT_AVAILABLE", "Descriptor-bound fresh Note queries currently require Linux.");
      statistics.scans++;
      const digest = createHash("sha256");
      const tuple = (...values: string[]) => {
        for (const value of values) {
          const bytes = Buffer.from(value), length = Buffer.allocUnsafe(4);
          length.writeUInt32BE(bytes.length); digest.update(length); digest.update(bytes);
        }
      };
      tuple("pkm.fresh-note-root/v1", expectedRoot);
      const next = new Map<string, FreshNoteSource>(), directories = new Set<string>();
      const originalPrivate = new Map(knowledgeArea.options.map(area => [area, knowledgeReadPrivateTopLevels(canonical, area)]));
      const visitedDirectories = new Map<string, string>();
      const mutationPin = (stat: BigIntStats) => `${directoryPin(stat)}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
      function walk(fd: number, namedPath: string, area: KnowledgeArea, prefix: string, depth: number) {
        if (depth > 32) throw new CoreError("INVALID_WORKSPACE", "Markdown nesting exceeds 32 levels.");
        const before = fstatSync(fd, { bigint: true });
        if (!before.isDirectory()) throw new CoreError("INVALID_WORKSPACE", "Notes directories must be real directories, not links.");
        directories.add(`${area}/${prefix}`);
        visitedDirectories.set(namedPath, mutationPin(before));
        tuple("directory", area, prefix, directoryPin(before));
        const names = readdirSync(`/proc/self/fd/${fd}`, { encoding: "buffer" }).sort(Buffer.compare).map(bytes => {
          if (!isUtf8(bytes)) throw new CoreError("INVALID_DOCUMENT", "Knowledge filenames must be valid UTF-8.");
          return bytes.toString("utf8");
        });
        const nameSet = new Set(names);
        for (const name of names) {
          const relative = prefix ? `${prefix}/${name}` : name, path = `/proc/self/fd/${fd}/${name}`;
          if (originalPrivate.get(area)?.has(relative.split("/")[0]!)) continue;
          const entry = lstatSync(path, { bigint: true, throwIfNoEntry: false });
          if (!entry) throw new CoreError("CONFLICT", "Knowledge membership changed during fresh scan.");
          if (entry.isSymbolicLink()) throw new CoreError("INVALID_DOCUMENT", `Notes symlinks are not supported: ${relative}`);
          if (name === ".gitkeep" && entry.isFile() || /^\.pkm-write-[a-fA-F0-9-]+$/.test(name) && entry.isFile()) continue;
          if (area === "notes" && !prefix && name === ".pk-meta.json") {
            if (!entry.isFile()) throw new CoreError("INVALID_DOCUMENT", "The reserved Note folder-pin sidecar must be a regular file.");
            continue;
          }
          if (entry.isDirectory()) {
            if (name === ".trash" || name === "_assets") continue;
            if (/\.assets$/i.test(name)) {
              const owners = names.filter(candidate => /\.md$/i.test(candidate)
                && candidate.replace(/\.md$/i, "") === name.replace(/\.assets$/i, ""));
              if (owners.length !== 1 || !lstatSync(`/proc/self/fd/${fd}/${owners[0]!}`).isFile())
                throw new CoreError("INVALID_DOCUMENT", `Unowned or ambiguous Markdown resource directory: ${relative}`);
              tuple("assets", area, relative, directoryPin(entry));
              continue;
            }
            if (!documentPath.safeParse(`${relative}/placeholder.md`).success)
              throw new CoreError("INVALID_DOCUMENT", `Unsafe Notes folder: ${relative}`);
            const child = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            try { walk(child, join(namedPath, name), area, relative, depth + 1); }
            finally { closeSync(child); }
            continue;
          }
          if (!entry.isFile()) throw new CoreError("INVALID_DOCUMENT", `Unsupported notes entry: ${relative}`);
          const key = `${area}/${relative}`, previous = cached.get(key);
          if (!previous && !documentPath.safeParse(relative).success)
            throw new CoreError("INVALID_DOCUMENT", `Unsupported notes entry: ${relative}`);
          const fresh = readFile(fd, name);
          let boardPresent = false, dependencyPin = "";
          if (area === "notes" && nameSet.has(name.replace(/\.md$/i, ".assets"))) {
            const assetsName = name.replace(/\.md$/i, ".assets");
            let assets: number | undefined;
            try {
              assets = openSync(`/proc/self/fd/${fd}/${assetsName}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
              const assetStat = fstatSync(assets, { bigint: true });
              dependencyPin = directoryPin(assetStat);
              visitedDirectories.set(join(namedPath, assetsName), mutationPin(assetStat));
              try {
                const backing = readFile(assets, "pkm-todo-board.json");
                boardPresent = true; dependencyPin += `:${backing.pin}:${backing.digest}`;
              } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
                dependencyPin += ":missing";
              }
            } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
              dependencyPin = "missing";
            } finally { if (assets !== undefined) closeSync(assets); }
          }
          if (area === "notes" && !dependencyPin) dependencyPin = "missing";
          let source = previous;
          if (!source || source.sha256 !== fresh.digest || source.statPin !== fresh.pin) {
            if (!isUtf8(fresh.bytes)) throw new CoreError("INVALID_DOCUMENT", "Markdown must be valid UTF-8; invalid bytes were not replaced.");
            const raw = fresh.bytes.toString("utf8"), parsed = decodeMarkdownPath(raw, relative, area);
            statistics.parses++;
            const identity = parsed.metadata.get("knowledgeId");
            source = Object.freeze({ area, path: relative, id: parsed.record.id, title: parsed.record.title,
              revision: parsed.record.revision, deleted: parsed.record.deleted,
              knowledgeId: typeof identity === "string" ? identity : null, raw, sha256: fresh.digest,
              statPin: fresh.pin, mtimeNs: String(fresh.stat.mtimeNs), boardPresent, dependencyPin });
          } else if (source.dependencyPin !== dependencyPin)
            source = Object.freeze({ ...source, boardPresent, dependencyPin });
          next.set(key, source);
          tuple("source", key, source.statPin, source.sha256, source.dependencyPin);
        }
        const named = lstatSync(namedPath, { bigint: true }), held = fstatSync(fd, { bigint: true });
        if (!named.isDirectory() || named.isSymbolicLink() || mutationPin(named) !== mutationPin(before)
          || mutationPin(held) !== mutationPin(before))
          throw new CoreError("CONFLICT", "Knowledge directory changed during fresh scan.");
      }
      const rootFd = openSync(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        if (`${canonical}:${directoryPin(fstatSync(rootFd, { bigint: true }))}` !== expectedRoot)
          throw new CoreError("INVALID_WORKSPACE", "The fresh query Knowledge Root identity or permissions changed.");
        for (const area of knowledgeArea.options) {
          let areaFd: number;
          try { areaFd = openSync(`/proc/self/fd/${rootFd}/${area}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
          catch (error) {
            if (area !== "notes" && error instanceof Error && "code" in error && error.code === "ENOENT") {
              tuple("missing-area", area); continue;
            }
            throw error;
          }
          try { walk(areaFd, join(canonical, area), area, "", 0); }
          finally { closeSync(areaFd); }
        }
        const named = lstatSync(canonical, { bigint: true });
        if (!named.isDirectory() || named.isSymbolicLink() || `${canonical}:${directoryPin(named)}` !== expectedRoot)
          throw new CoreError("CONFLICT", "Knowledge Root changed during fresh scan.");
        for (const [path, pin] of visitedDirectories) {
          const current = lstatSync(path, { bigint: true });
          if (!current.isDirectory() || current.isSymbolicLink() || mutationPin(current) !== pin)
            throw new CoreError("CONFLICT", "Knowledge membership changed during fresh scan.");
        }
        for (const area of knowledgeArea.options) {
          const current = lstatSync(`/proc/self/fd/${rootFd}/${area}`, { bigint: true, throwIfNoEntry: false });
          if (!!current !== directories.has(`${area}/`))
            throw new CoreError("CONFLICT", "Knowledge areas changed during fresh scan.");
        }
      } finally { closeSync(rootFd); }
      const sameIdentity = (left: FreshNoteSource | undefined, right: FreshNoteSource | undefined) =>
        left !== undefined && right !== undefined && left.id === right.id && left.knowledgeId === right.knowledgeId;
      const changed = [...next].filter(([key, source]) => !sameIdentity(cached.get(key), source));
      const removed = [...cached].filter(([key, source]) => !sameIdentity(next.get(key), source));
      const undo: Array<() => void> = [];
      function set(map: Map<string, string>, key: string, value?: string) {
        const before = map.get(key);
        undo.push(() => { if (before === undefined) map.delete(key); else map.set(key, before); });
        if (value === undefined) map.delete(key); else map.set(key, value);
      }
      try {
        for (const [, source] of removed) {
          set(ids, source.id);
          if (source.knowledgeId !== null) set(knowledgeIds, source.knowledgeId);
          for (const key of new Set([source.id, ...(source.knowledgeId !== null ? [source.knowledgeId] : [])])) set(addresses, key);
        }
        for (const [address, source] of changed) {
          statistics.identityUpdates++;
          if (ids.has(source.id)) throw new CoreError("CONFLICT", `Duplicate document identity: ${source.id}`);
          set(ids, source.id, address);
          if (source.knowledgeId !== null) {
            if (knowledgeIds.has(source.knowledgeId)) throw new CoreError("CONFLICT", `Duplicate knowledgeId: ${source.knowledgeId}`);
            set(knowledgeIds, source.knowledgeId, address);
          }
          for (const key of new Set([source.id, ...(source.knowledgeId !== null ? [source.knowledgeId] : [])])) {
            if (addresses.has(key)) throw new CoreError("CONFLICT", `Ambiguous document/knowledge identity: ${key}`);
            set(addresses, key, address);
          }
        }
      } catch (error) { for (const restore of undo.reverse()) restore(); throw error; }
      cached = next;
      return qualifyFreshRootScan(Object.freeze({ rootPin, guardDigest: digest.digest("hex"), sources: next, directories }));
    }
    return Object.freeze({ rootPin, scan, statistics: () => Object.freeze({ ...statistics }) });
  }
