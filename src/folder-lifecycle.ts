import { RenameNoReplaceError, renameNoReplaceSync } from "./rename-no-replace.js";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, rmdirSync, unlinkSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { CoreError, type StorageRequest } from "./contracts.js";
import {
  folderLifecycleDefinitions, folderLifecycleDocumentPin, folderLifecycleEntryPath, folderLifecycleLimits as limits,
  type FolderLifecycleOperation, type FolderLifecyclePreview, type FolderLifecycleResult,
} from "./folder-lifecycle-contracts.js";
import { checkedDocumentPath, documentPath, knowledgeArea, type KnowledgeArea } from "./document-path.js";
import { isMarkdownAssetDirectory, localAssetReference, markdownReferences } from "./domain/markdown-assets.js";
import { rebaseMarkdownAssets } from "./domain/document-lifecycle-original.js";
import { decodeMarkdown, type MarkdownRecord } from "./markdown.js";
import { atomicFileWrite, sha256 } from "./file-write.js";

export { folderLifecycleDefinitions, folderLifecycleLimits } from "./folder-lifecycle-contracts.js";
export type { FolderLifecycleOperation, FolderLifecyclePreview, FolderLifecycleResult } from "./folder-lifecycle-contracts.js";
export type FolderLifecycleRequest = Omit<StorageRequest, "operation"> & {
  operation: StorageRequest["operation"] | FolderLifecycleOperation;
};

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pinSchema = folderLifecycleDocumentPin;
const entrySchema = z.discriminatedUnion("kind", [
  z.strictObject({ path: folderLifecycleEntryPath, kind: z.literal("directory") }),
  z.strictObject({
    path: folderLifecycleEntryPath, kind: z.literal("file"),
    size: count.max(limits.fileBytes), sha256: digest,
  }),
]);
const markdownChangeSchema = z.strictObject({
  relativePath: documentPath,
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
  revision: count.min(1),
  beforeSha256: digest,
  afterSha256: digest,
  beforeSize: count.max(limits.markdownBytes),
  afterSize: count.max(limits.markdownBytes),
  before: z.string(),
  after: z.string(),
});
const noteFolderPinsSchema = z.strictObject({
  beforeSha256: digest.nullable(),
  afterSha256: digest.nullable(),
  before: z.string().nullable(),
  after: z.string().nullable(),
});
const serializedSchema = z.strictObject({
  kind: z.literal("folder-lifecycle"),
  operationId: z.string().uuid(),
  actorId: z.string().min(1).max(500),
  area: knowledgeArea,
  promote: z.literal(true).optional(),
  sourcePath: z.string().min(1).max(2048),
  destinationPath: z.string().max(2048),
  expectedScanRevision: digest,
  referencePins: z.array(pinSchema).max(limits.documents),
  expectedSourceSha256: digest,
  expectedDestinationSha256: z.null(),
  destinationAbsent: z.literal(true),
  entries: z.array(entrySchema).max(limits.entries),
  destinationParents: z.array(z.string().min(1).max(2048)).max(limits.depth),
  markdownChanges: z.array(markdownChangeSchema).max(limits.documents),
  noteFolderPins: noteFolderPinsSchema.optional(),
  requiresCompoundJournal: z.literal(true),
  result: z.union([folderLifecycleDefinitions[1].output, folderLifecycleDefinitions[3].output]),
});
type FolderEntry = z.infer<typeof entrySchema>;
type ReferencePin = z.infer<typeof pinSchema>;
type MarkdownChange = z.infer<typeof markdownChangeSchema>;
type NoteFolderPins = {
  beforeSha256: string | null;
  afterSha256: string | null;
  before: Buffer | null;
  after: Buffer | null;
};
export interface FolderLifecyclePlan {
  kind: "folder-lifecycle";
  operationId: string;
  actorId: string;
  area: KnowledgeArea;
  promote?: true;
  sourcePath: string;
  destinationPath: string;
  expectedScanRevision: string;
  referencePins: ReferencePin[];
  expectedSourceSha256: string;
  expectedDestinationSha256: null;
  destinationAbsent: true;
  entries: FolderEntry[];
  destinationParents: string[];
  markdownChanges: Array<Omit<MarkdownChange, "before" | "after"> & { before: Buffer; after: Buffer }>;
  noteFolderPins?: NoteFolderPins;
  requiresCompoundJournal: true;
  result: FolderLifecycleResult;
}


function fail(code: string, message: string): never { throw new CoreError(code, message); }
function missing(error: unknown) { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function guarded<T>(action: () => T): T {
  try { return action(); }
  catch (error) {
    if (error instanceof CoreError) throw error;
    fail("INVALID_DOCUMENT", "Folder lifecycle could not inspect a stable checked workspace; preserve pending intents for reconciliation.");
  }
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail("INVALID_ARGUMENT", "Folder lifecycle arguments violate the public contract.");
  return parsed.data;
}
function checkedRoot(root: string) {
  const full = resolve(root), ancestors: string[] = [];
  for (let current = full; ; current = dirname(current)) {
    ancestors.push(current);
    if (dirname(current) === current) break;
  }
  for (const path of ancestors.reverse()) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_WORKSPACE", "Lifecycle root and ancestors must be real directories, not links.");
  }
  return full;
}
function safeFolderPath(path: string) {
  if (!folderLifecycleDefinitions[0].input.shape.path.safeParse(path).success
    || path.split("/").some(part => part.toLowerCase() === "system" || part.toLowerCase() === ".trash"
      || part.toLowerCase() === "_assets" || isMarkdownAssetDirectory(part))) {
    fail("INVALID_ARGUMENT", "Folder paths must be portable and cannot address System, Trash or resource directories.");
  }
  return path;
}
function checkedEntry(root: string, area: KnowledgeArea, path: string) {
  let full = root;
  for (const part of [area, ...path.split("/")]) {
    const parent = lstatSync(full);
    if (!parent.isDirectory() || parent.isSymbolicLink()) fail("INVALID_DOCUMENT", "Folder lifecycle parents must be real directories.");
    full = join(full, part);
    let stat;
    try { stat = lstatSync(full); } catch (error) { if (missing(error)) return undefined; throw error; }
    if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) {
      fail("INVALID_DOCUMENT", "Folder lifecycle entries must be regular files/directories, not links or special files.");
    }
  }
  return { full, stat: lstatSync(full) };
}
function readBytes(root: string, area: KnowledgeArea, path: string, limit: number) {
  const found = checkedEntry(root, area, path);
  if (!found || !found.stat.isFile() || found.stat.size > limit) fail("CONFLICT", "Pinned folder file is missing, non-regular or exceeds its byte limit.");
  const fd = openSync(found.full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit || stat.dev !== found.stat.dev || stat.ino !== found.stat.ino) {
      fail("CONFLICT", "Folder file changed during open.");
    }
    const bytes = Buffer.alloc(stat.size);
    let used = 0;
    while (used < bytes.length) {
      const read = readSync(fd, bytes, used, bytes.length - used, used);
      if (!read) break;
      used += read;
    }
    const observed = fstatSync(fd), current = checkedEntry(root, area, path);
    if (used !== stat.size || observed.size !== stat.size || observed.mtimeMs !== stat.mtimeMs
      || !current || current.stat.dev !== stat.dev || current.stat.ino !== stat.ino) fail("CONFLICT", "Folder file changed during bounded read.");
    return bytes;
  } finally { closeSync(fd); }
}
function sidecarBytes(root: string): Buffer | null {
  const found = checkedEntry(root, "notes", ".pk-meta.json");
  if (!found) return null;
  if (!found.stat.isFile()) fail("INVALID_DOCUMENT", "The reserved Note folder-pin sidecar must be a regular file.");
  return readBytes(root, "notes", ".pk-meta.json", limits.fileBytes);
}
function repathNoteFolderPins(before: Buffer | null, sourcePath: string, destinationPath: string): Buffer | null {
  if (!before) return null;
  const raw = before.toString("utf8");
  if (!Buffer.from(raw).equals(before)) fail("INVALID_DOCUMENT", "Note folder-pin sidecar must contain valid UTF-8.");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return before; }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Array.isArray((value as Record<string, unknown>).pinnedFolders)) return before;
  const pins = (value as { pinnedFolders: unknown[] }).pinnedFolders;
  if (pins.some(pin => typeof pin !== "string")) {
    fail("INVALID_DOCUMENT", "Note folder-pin sidecar contains a non-string path; preserve it for repair.");
  }
  let changed = false;
  const pinnedFolders = (pins as string[]).map(pin => {
    if (pin === sourcePath) { changed = true; return destinationPath; }
    if (pin.startsWith(`${sourcePath}/`)) {
      changed = true;
      return destinationPath + pin.slice(sourcePath.length);
    }
    return pin;
  }).filter(Boolean);
  return changed ? Buffer.from(`${JSON.stringify({ pinnedFolders }, null, 2)}\n`, "utf8") : before;
}
function noteFolderPinsPlan(root: string, area: KnowledgeArea, sourcePath: string, destinationPath: string): NoteFolderPins | undefined {
  if (area !== "notes") return undefined;
  const before = sidecarBytes(root);
  const after = repathNoteFolderPins(before, sourcePath, destinationPath);
  return {
    before, after,
    beforeSha256: before ? sha256(before) : null,
    afterSha256: after ? sha256(after) : null,
  };
}
function validateNoteFolderPins(root: string, plan: FolderLifecyclePlan, moved: boolean) {
  const pins = plan.noteFolderPins;
  if (plan.area !== "notes") {
    if (pins) fail("RECOVERY_CONFLICT", "Non-Notes folder intent unexpectedly owns the Note folder-pin sidecar.");
    return;
  }
  if (!pins) fail("RECOVERY_CONFLICT", "Notes folder intent is missing its exact folder-pin sidecar pin.");
  const current = sidecarBytes(root);
  const currentHash = current ? sha256(current) : null;
  const beforeMatches = currentHash === pins.beforeSha256 && (current === null) === (pins.before === null)
    && (!current || pins.before !== null && current.equals(pins.before));
  const afterMatches = currentHash === pins.afterSha256 && (current === null) === (pins.after === null)
    && (!current || pins.after !== null && current.equals(pins.after));
  if (moved ? !beforeMatches && !afterMatches : !beforeMatches) {
    fail("RECOVERY_CONFLICT", "Note folder-pin sidecar changed outside the persisted folder intent.");
  }
  // Root promotion shares its write slot with root Markdown until the source is removed.
  if (plan.promote && !plan.destinationPath && !moved) return;
  const temporary = join(root, "notes", `.pkm-write-${plan.operationId}`);
  let stat;
  try { stat = lstatSync(temporary); } catch (error) { if (missing(error)) return; throw error; }
  if (!pins.after || !stat.isFile() || stat.isSymbolicLink() || stat.size > pins.after.length) {
    fail("RECOVERY_CONFLICT", "Note folder-pin write staging is not a recognized regular file.");
  }
  const bytes = readBytes(root, "notes", `.pkm-write-${plan.operationId}`, limits.fileBytes);
  if (!pins.after.subarray(0, bytes.length).equals(bytes)) {
    fail("RECOVERY_CONFLICT", "Note folder-pin staging bytes are unknown; preserve the pending intent.");
  }
}
function portableComponent(name: string, isDirectory: boolean) {
  const path = name;
  if (!folderLifecycleEntryPath.safeParse(path).success
    || path.includes("/") || (name.startsWith(".") && !(name === ".gitkeep" && !isDirectory))
    || name.toLowerCase() === "pkm-todo-board.json"
    || name.toLowerCase() === "_assets" || name.toLowerCase() === ".trash"
    || name.toLowerCase() === "system"
    || name.toLowerCase() === "todo board.md") {
    fail("ACCESS_DENIED", "Subtree contains a hidden, non-portable, Trash, System or Todo authority entry.");
  }
  if (isDirectory && name.startsWith(".") && !isMarkdownAssetDirectory(name)) {
    fail("ACCESS_DENIED", "Hidden subtree directories are not supported.");
  }
}
interface ScannedTree {
  entries: FolderEntry[];
  contents: Map<string, Buffer>;
  bytes: number;
  files: number;
  markdownBytes: number;
  stagingPath: string | null;
}
type PlanChange = FolderLifecyclePlan["markdownChanges"][number];
function scanTree(root: string, area: KnowledgeArea, path: string, operation?: {
  operationId: string;
  changes: ReadonlyMap<string, PlanChange>;
}): ScannedTree {
  const start = checkedEntry(root, area, path);
  if (!start || !start.stat.isDirectory()) fail("NOT_FOUND", "Folder source must be an existing real directory.");
  const entries: FolderEntry[] = [], contents = new Map<string, Buffer>();
  let stagingPath: string | null = null;
  let bytes = 0, files = 0, markdownBytes = 0;
  function walk(directory: string, prefix: string, depth: number) {
    if (depth > limits.depth) fail("INVALID_WORKSPACE", "Folder subtree exceeds 32 directory levels.");
    const names = readdirSync(directory).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const folded = new Set<string>();
    for (const name of names) {
      if (folded.has(name.toLocaleLowerCase("en-US"))) fail("INVALID_DOCUMENT", "Subtree contains names that collide on portable filesystems.");
      folded.add(name.toLocaleLowerCase("en-US"));
      const full = join(directory, name), stat = lstatSync(full);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (operation && name === `.pkm-write-${operation.operationId}` && stat.isFile() && !stat.isSymbolicLink()) {
        const candidates = [...operation.changes.values()].filter(item =>
          item.beforeSha256 !== item.afterSha256 && dirname(item.relativePath) === (prefix || "."));
        if (!candidates.length) fail("RECOVERY_CONFLICT", "Unexpected folder write staging file.");
        const temporaryBytes = readBytes(root, area, `${path}/${relativePath}`, limits.markdownBytes);
        if (!candidates.some(change => temporaryBytes.length <= change.after.length
          && change.after.subarray(0, temporaryBytes.length).equals(temporaryBytes))) {
          fail("RECOVERY_CONFLICT", "Folder write staging bytes are not a prefix of the persisted after bytes.");
        }
        if (stagingPath !== null) fail("RECOVERY_CONFLICT", "Multiple folder write staging files require manual reconciliation.");
        stagingPath = relativePath;
        continue;
      }
      portableComponent(name, stat.isDirectory());
      if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) {
        fail("INVALID_DOCUMENT", "Folder subtree contains a symlink or special file.");
      }
      if (entries.length >= limits.entries) fail("INVALID_WORKSPACE", "Folder subtree exceeds 2048 entries.");
      if (stat.isDirectory()) {
        entries.push({ path: relativePath, kind: "directory" });
        walk(full, relativePath, depth + 1);
        continue;
      }
      if (stat.size > limits.fileBytes || bytes + stat.size > limits.subtreeBytes) {
        fail("INVALID_WORKSPACE", "Folder subtree exceeds 16 MiB per file or 64 MiB total.");
      }
      files++;
      bytes += stat.size;
      const isMarkdown = /\.md$/i.test(name);
      if (isMarkdown) {
        if (!documentPath.safeParse(relativePath).success || stat.size > limits.markdownBytes
          || markdownBytes + stat.size > limits.scanBytes) fail("INVALID_WORKSPACE", "Folder Markdown byte count exceeds the supported numeric range.");
        markdownBytes += stat.size;
      }
      const content = readBytes(root, area, `${path}/${relativePath}`, isMarkdown ? limits.markdownBytes : limits.fileBytes);
      entries.push({ path: relativePath, kind: "file", size: content.length, sha256: sha256(content) });
      if (isMarkdown) contents.set(relativePath, content);
    }
  }
  walk(start.full, "", 1);
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return { entries, contents, bytes, files, markdownBytes, stagingPath };
}
function treeDigest(entries: readonly FolderEntry[]) {
  return sha256(JSON.stringify(entries.map(item => item.kind === "file"
    ? [item.path, item.kind, item.size, item.sha256] : [item.path, item.kind])));
}
function sortedPins(documents: readonly MarkdownRecord[]): ReferencePin[] {
  return documents.map(({ record }) => ({
    id: record.id, area: record.area, path: record.path, revision: record.revision, sha256: record.sha256,
  })).sort((left, right) => Buffer.compare(Buffer.from(`${left.area}/${left.path}`), Buffer.from(`${right.area}/${right.path}`)));
}
function pinRevision(pins: readonly ReferencePin[], noteFolderPinsSha256?: string | null) {
  return noteFolderPinsSha256 === undefined
    ? sha256(JSON.stringify(pins))
    : sha256(JSON.stringify({ pins, noteFolderPinsSha256 }));
}
function identity(document: MarkdownRecord) {
  const metadata = document.metadata;
  if (metadata.has("documentId")) return metadata.get("documentId");
  const aliases: unknown = metadata.toJS({ maxAliasCount: 0 }).aliases;
  const prototype = metadata.get("schema") === "pkm.knowledge/v1" && metadata.has("revision")
    && metadata.has("deleted") && Array.isArray(aliases)
    ? [...new Set(aliases.filter((alias): alias is string => typeof alias === "string"
      && /^note:[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(alias)).map(alias => alias.slice(5)))] : [];
  return prototype.length === 1 ? prototype[0] : metadata.get("knowledgeId");
}
function editable(document: MarkdownRecord) {
  if (document.record.deleted || document.metadata.has("memory")
    || document.metadata.get("documentKind") === "todo-board"
    || basename(document.record.path).toLowerCase() === "todo board.md"
    || document.record.path.split("/").some(part => part.toLowerCase() === "system")) {
    fail("ACCESS_DENIED", "Todo, memory, System or deleted descriptors require dedicated lifecycle support.");
  }
  if (identity(document) !== document.record.id) {
    fail("UNSUPPORTED_OPERATION", "Path-derived or ambiguous identities cannot be preserved by a folder move; migrate stable identities first.");
  }
}
function referenceSnapshot(root: string, allowedAssets: ReadonlySet<string> = new Set()) {
  const documents: MarkdownRecord[] = [];
  const ids = new Set<string>(), knowledgeIds = new Set<string>();
  let entries = 0, bytes = 0;
  function walk(area: KnowledgeArea, directory: string, prefix: string, depth: number) {
    if (depth > limits.depth) fail("INVALID_WORKSPACE", "Reference scan exceeds 32 directory levels.");
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_DOCUMENT", "Reference scan directories must be real directories.");
    const names = readdirSync(directory).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const name of names) {
      if (++entries > 8192) fail("INVALID_WORKSPACE", "Reference scan exceeds 8192 filesystem entries.");
      if (name === ".trash" || name === "_assets" || name === ".gitkeep") continue;
      const full = join(directory, name), relativePath = prefix ? `${prefix}/${name}` : name;
      const item = lstatSync(full);
      if (item.isSymbolicLink()) fail("INVALID_DOCUMENT", `Reference scan found a symlink: ${area}/${relativePath}`);
      if (area === "notes" && !prefix && name === ".pk-meta.json") {
        if (!item.isFile()) fail("INVALID_DOCUMENT", "The reserved Note folder-pin sidecar must be a regular file.");
        continue;
      }
      if (/^\.pkm-write-[a-fA-F0-9-]{36}$/.test(name) && item.isFile()) continue;
      if (item.isDirectory()) {
        if (isMarkdownAssetDirectory(name)) {
          const owners = names.filter(candidate => /\.md$/i.test(candidate)
            && candidate.replace(/\.md$/i, "").toLowerCase() === name.replace(/\.assets$/i, "").toLowerCase());
          if (!allowedAssets.has(`${area}/${relativePath}`)
            && (owners.length !== 1 || !lstatSync(join(directory, owners[0]!)).isFile())) {
            fail("INVALID_DOCUMENT", `Reference scan found an unowned or ambiguous resource tree: ${area}/${relativePath}`);
          }
          continue;
        }
        if (!documentPath.safeParse(`${relativePath}/placeholder.md`).success) fail("INVALID_DOCUMENT", `Unsafe reference folder: ${area}/${relativePath}`);
        walk(area, full, relativePath, depth + 1);
        continue;
      }
      if (!item.isFile() || !documentPath.safeParse(relativePath).success) fail("INVALID_DOCUMENT", `Unsupported reference entry: ${area}/${relativePath}`);
      if (item.size > limits.markdownBytes || bytes + item.size > limits.scanBytes) {
        fail("INVALID_WORKSPACE", "Reference scan byte count exceeds the supported numeric range.");
      }
      bytes += item.size;
      if (documents.length >= limits.documents) fail("INVALID_WORKSPACE", "Reference scan exceeds 2048 documents.");
      const rawBytes = readBytes(root, area, relativePath, limits.markdownBytes);
      const raw = rawBytes.toString("utf8");
      if (!Buffer.from(raw).equals(rawBytes)) fail("INVALID_DOCUMENT", "Reference Markdown must be valid UTF-8.");
      const temporary = decodeMarkdown("placeholder", raw, relativePath, area);
      const metadata = temporary.metadata;
      const aliases: unknown = metadata.toJS({ maxAliasCount: 0 }).aliases;
      const prototypeIds = metadata.get("schema") === "pkm.knowledge/v1" && metadata.has("revision")
        && metadata.has("deleted") && Array.isArray(aliases)
        ? [...new Set(aliases.filter((alias): alias is string => typeof alias === "string"
          && alias.startsWith("note:") && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(alias.slice(5))).map(alias => alias.slice(5)))] : [];
      const stable = metadata.has("documentId") ? metadata.get("documentId")
        : prototypeIds.length === 1 ? prototypeIds[0] : metadata.get("knowledgeId");
      const filename = basename(name).replace(/\.md$/i, "");
      const id = stable === undefined ? (area === "notes" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(filename) && !prefix
        ? filename : `legacy_${sha256(area === "notes" ? relativePath : `${area}/${relativePath}`).slice(0, 32)}`) : stable;
      if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) fail("INVALID_DOCUMENT", `Invalid stable identity in ${area}/${relativePath}.`);
      if (ids.has(id)) fail("CONFLICT", `Duplicate document identity: ${id}`);
      ids.add(id);
      const knowledgeId = metadata.get("knowledgeId");
      if (typeof knowledgeId === "string") {
        if (knowledgeIds.has(knowledgeId)) fail("CONFLICT", `Duplicate knowledgeId: ${knowledgeId}`);
        knowledgeIds.add(knowledgeId);
      }
      documents.push(decodeMarkdown(id, raw, relativePath, area));
    }
  }
  for (const area of knowledgeArea.options) {
    const directory = join(root, area);
    let stat;
    try { stat = lstatSync(directory); } catch (error) { if (area !== "notes" && missing(error)) continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_WORKSPACE", `Reference root ${area} must be a real directory.`);
    walk(area, directory, "", 0);
  }
  if (documents.length > limits.documents || bytes > limits.scanBytes) fail("INVALID_WORKSPACE", "Reference snapshot exceeds its document/byte bound.");
  const pins = sortedPins(documents);
  return { documents, pins, revision: pinRevision(pins), bytes };
}
function comparePins(actual: readonly ReferencePin[], expected: readonly ReferencePin[]) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}
function pathExists(root: string, area: KnowledgeArea, path: string) {
  try { return checkedEntry(root, area, path); } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
function destinationState(root: string, area: KnowledgeArea, destination: string) {
  const rootPath = join(root, area);
  const parts = destination.split("/");
  let parent = rootPath;
  const missingParents: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const target = parts[index]!;
    let names: string[];
    try { names = readdirSync(parent); } catch (error) {
      if (!missing(error)) throw error;
      for (let remaining = index; remaining < parts.length - 1; remaining++) {
        missingParents.push(parts.slice(0, remaining + 1).join("/"));
      }
      return { destinationExists: false, missingParents };
    }
    const match = names.find(name => name.toLocaleLowerCase("en-US") === target.toLocaleLowerCase("en-US"));
    if (!match) {
      for (let remaining = index; remaining < parts.length - 1; remaining++) {
        missingParents.push(parts.slice(0, remaining + 1).join("/"));
      }
      return { destinationExists: false, missingParents };
    }
    if (match !== target) fail("CONFLICT", "Folder destination collides on a case-insensitive portable filesystem.");
    const full = join(parent, match), stat = lstatSync(full);
    if (stat.isSymbolicLink()) fail("INVALID_DOCUMENT", "Folder destination parents must not be links.");
    if (index === parts.length - 1) return { destinationExists: true, missingParents };
    if (!stat.isDirectory()) fail("CONFLICT", "A non-directory blocks the folder destination path.");
    parent = full;
  }
  return { destinationExists: false, missingParents };
}
function checkReferenceSafety(root: string, area: KnowledgeArea, sourcePath: string, documents: readonly MarkdownRecord[]) {
  const areaRoot = resolve(root, area), source = resolve(areaRoot, sourcePath);
  const inSource = (path: string) => path === source || path.startsWith(source + sep);
  for (const document of documents) {
    const inside = document.record.area === area && document.record.path.startsWith(sourcePath + "/");
    for (const { value } of markdownReferences(document.raw)) {
      const local = localAssetReference(value);
      if (!local) continue;
      const target = resolve(areaRoot, dirname(document.record.path), local);
      const relativeTarget = relative(areaRoot, target).replaceAll("\\", "/");
      if (relativeTarget === ".." || relativeTarget.startsWith("../") || resolve(areaRoot, relativeTarget) !== target) {
        if (inside) fail("INVALID_DOCUMENT", "A moved document references a resource outside its content root.");
        continue;
      }
      if (relativeTarget.split("/").some(part => part === "_assets")) {
        if (inside) fail("UNSUPPORTED_OPERATION", "Legacy _assets references require explicit migration before moving a folder.");
        continue;
      }
      if (!inside && inSource(target) && pathExists(root, area, relativeTarget)) {
        fail("CONFLICT", `Folder contains a resource referenced by an outside document: ${document.record.path}`);
      }
      if (inside && relativeTarget.split("/").some(isMarkdownAssetDirectory)) pathExists(root, area, relativeTarget);
    }
  }
}
function frontmatter(raw: string) { return /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(raw)?.[0] ?? ""; }
function makePreview(
  area: KnowledgeArea, sourcePath: string, destinationPath: string,
  tree: ScannedTree, snapshot: ReturnType<typeof referenceSnapshot>, rewrittenDocuments: number,
  noteFolderPinsSha256?: string | null,
): FolderLifecyclePreview {
  return (destinationPath ? folderLifecycleDefinitions[0].output : folderLifecycleDefinitions[2].output).parse({
    area, sourcePath, destinationPath,
    sourceSha256: treeDigest(tree.entries),
    scanRevision: pinRevision(snapshot.pins, noteFolderPinsSha256),
    entries: tree.entries.length,
    files: tree.files,
    bytes: tree.bytes,
    documents: tree.contents.size,
    rewrittenDocuments,
    destinationAbsent: true,
    scannedDocuments: snapshot.documents.length,
    scannedBytes: snapshot.bytes,
  });
}
function mappedPath(parent: string, path: string) { return parent ? `${parent}/${path}` : path; }
function parentPath(path: string) { return dirname(path) === "." ? "" : dirname(path); }
function promotionNames(entries: readonly FolderEntry[]) {
  return entries.filter(entry => !entry.path.includes("/") && entry.path !== ".gitkeep").map(entry => entry.path);
}
function promotedCount(entries: readonly FolderEntry[]) {
  const names = promotionNames(entries);
  return names.filter(name => !(isMarkdownAssetDirectory(name) && names.includes(name.slice(0, -7) + ".md"))).length;
}
function prepare(root: string, supplied: MarkdownRecord[], args: { area: KnowledgeArea; path: string; destinationPath: string }, promote = false) {
  root = checkedRoot(root);
  const sourcePath = safeFolderPath(args.path), destinationPath = promote ? parentPath(sourcePath) : safeFolderPath(args.destinationPath);
  if (sourcePath.toLowerCase() === destinationPath.toLowerCase()) fail("INVALID_ARGUMENT", "Folder move requires a distinct portable destination.");
  if (destinationPath.toLowerCase().startsWith(sourcePath.toLowerCase() + "/")) fail("INVALID_ARGUMENT", "A folder cannot be moved into itself.");
  const source = checkedEntry(root, args.area, sourcePath);
  if (!source || !source.stat.isDirectory()) fail("NOT_FOUND", `Folder not found: ${sourcePath}`);
  const destination = promote ? { missingParents: [] } : destinationState(root, args.area, destinationPath);
  if ("destinationExists" in destination && destination.destinationExists) fail("CONFLICT", "Folder destination already exists.");
  const tree = scanTree(root, args.area, sourcePath);
  if (promote) {
    const destinations = new Set(promotionNames(tree.entries));
    for (const name of [...destinations]) if (/\.md$/i.test(name)) destinations.add(name.replace(/\.md$/i, ".assets"));
    for (const name of destinations) {
      if (destinationState(root, args.area, mappedPath(destinationPath, name)).destinationExists) {
        fail("CONFLICT", `Cannot promote folder: child or asset destination already exists: ${name}`);
      }
    }
  }
  const snapshot = referenceSnapshot(root);
  if (!comparePins(sortedPins(supplied), snapshot.pins)) fail("CONFLICT", "Folder lifecycle requires a complete current three-area Markdown snapshot.");
  const sourceDocuments = snapshot.documents.filter(document =>
    document.record.area === args.area && document.record.path.startsWith(sourcePath + "/"));
  const markdownPaths = [...tree.contents.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  if (sourceDocuments.length !== markdownPaths.length
    || sourceDocuments.some(document => !tree.contents.has(document.record.path.slice(sourcePath.length + 1)))) {
    fail("CONFLICT", "Folder subtree and indexed Markdown documents do not match exactly.");
  }
  for (const document of sourceDocuments) editable(document);
  checkReferenceSafety(root, args.area, sourcePath, snapshot.documents);
  const provisionalChanges = sourceDocuments.map(document => {
    const relativePath = document.record.path.slice(sourcePath.length + 1);
    const before = tree.contents.get(relativePath)!;
    const destinationDocumentPath = mappedPath(destinationPath, relativePath);
    if (!documentPath.safeParse(destinationDocumentPath).success) fail("INVALID_ARGUMENT", "Moved Markdown path is not portable.");
    const rebased = Buffer.from(rebaseMarkdownAssets(
      join(root, args.area), document.record.path, destinationDocumentPath, document.raw,
      { from: sourcePath, to: destinationPath },
    ));
    if (rebased.length > limits.markdownBytes) fail("INVALID_DOCUMENT", "Rebased Markdown exceeds the supported numeric byte range.");
    const afterText = rebased.toString("utf8");
    if (!Buffer.from(afterText).equals(rebased)) fail("INVALID_DOCUMENT", "Rebased Markdown is not valid UTF-8.");
    const after = decodeMarkdown(document.record.id, afterText, destinationDocumentPath, args.area);
    editable(after);
    if (after.record.revision !== document.record.revision || frontmatter(after.raw) !== frontmatter(document.raw)
      || identity(after) !== document.record.id) {
      fail("INVALID_DOCUMENT", "Folder rebase must preserve identity, revision and exact frontmatter bytes.");
    }
    return {
      relativePath, id: document.record.id, revision: document.record.revision,
      beforeSha256: sha256(before), afterSha256: sha256(rebased),
      beforeSize: before.length, afterSize: rebased.length, before, after: rebased,
    };
  }).sort((left, right) => Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)));
  const rewritten = provisionalChanges.filter(change => change.beforeSha256 !== change.afterSha256).length;
  const noteFolderPins = noteFolderPinsPlan(root, args.area, sourcePath, destinationPath);
  return {
    root, sourcePath, destinationPath, destinationParents: destination.missingParents, tree, snapshot,
    changes: provisionalChanges, noteFolderPins,
    preview: makePreview(args.area, sourcePath, destinationPath, tree, snapshot, rewritten, noteFolderPins?.beforeSha256),
  };
}

export function readFolderLifecycle(root: string, documents: MarkdownRecord[], request: FolderLifecycleRequest): FolderLifecyclePreview {
  return guarded(() => {
    if (request.operation === "knowledge.folder.lifecycle.promote-preview") {
      const args = parse(folderLifecycleDefinitions[2].input, request.args);
      return prepare(root, documents, { ...args, destinationPath: parentPath(args.path) }, true).preview;
    }
    if (request.operation !== "knowledge.folder.lifecycle.preview") fail("NOT_FOUND", "Unknown folder lifecycle read operation.");
    const args = parse(folderLifecycleDefinitions[0].input, request.args);
    return prepare(root, documents, args).preview;
  });
}

export function planFolderLifecycle(root: string, documents: MarkdownRecord[], request: FolderLifecycleRequest): FolderLifecyclePlan {
  return guarded(() => {
    const promote = request.operation === "knowledge.folder.promote-delete";
    if (!promote && request.operation !== "knowledge.folder.move") fail("NOT_FOUND", "Unknown folder lifecycle mutation operation.");
    const args = promote
      ? { ...parse(folderLifecycleDefinitions[3].input, request.args), destinationPath: parentPath(String(request.args.path)) }
      : parse(folderLifecycleDefinitions[1].input, request.args);
    const prepared = prepare(root, documents, args, promote);
    if (prepared.preview.sourceSha256 !== args.expectedSourceSha256 || prepared.preview.scanRevision !== args.expectedScanRevision) {
      fail("CONFLICT", "Folder source subtree or reference snapshot changed; preview again.");
    }
    if (args.path !== prepared.sourcePath || args.destinationPath !== prepared.destinationPath) {
      fail("INVALID_ARGUMENT", "Folder move paths changed while planning.");
    }
    const result = (promote ? folderLifecycleDefinitions[3].output : folderLifecycleDefinitions[1].output).parse({
      operationId: args.operationId,
      action: promote ? "promote-delete" : "move",
      ...(promote ? { moved: promotedCount(prepared.tree.entries) } : {}),
      folder: {
        area: args.area, sourcePath: prepared.sourcePath, destinationPath: prepared.destinationPath,
        sourceSha256: prepared.preview.sourceSha256, scanRevision: prepared.preview.scanRevision,
        entries: prepared.preview.entries, files: prepared.preview.files, bytes: prepared.preview.bytes,
        documents: prepared.preview.documents, rewrittenDocuments: prepared.preview.rewrittenDocuments,
      },
    });
    const plan: FolderLifecyclePlan = {
      kind: "folder-lifecycle", operationId: args.operationId, actorId: request.actorId,
      ...(promote ? { promote: true as const } : {}),
      area: args.area, sourcePath: prepared.sourcePath, destinationPath: prepared.destinationPath,
      expectedScanRevision: prepared.preview.scanRevision, referencePins: prepared.snapshot.pins,
      expectedSourceSha256: prepared.preview.sourceSha256, expectedDestinationSha256: null, destinationAbsent: true,
      entries: prepared.tree.entries, destinationParents: prepared.destinationParents,
      markdownChanges: prepared.changes, noteFolderPins: prepared.noteFolderPins,
      requiresCompoundJournal: true, result,
    };
    validatePlan(plan);
    return plan;
  });
}

function wire(plan: FolderLifecyclePlan) {
  return serializedSchema.parse({
    ...plan,
    markdownChanges: plan.markdownChanges.map(change => ({
      ...change, before: change.before.toString("base64"), after: change.after.toString("base64"),
    })),
    noteFolderPins: plan.noteFolderPins && {
      ...plan.noteFolderPins,
      before: plan.noteFolderPins.before?.toString("base64") ?? null,
      after: plan.noteFolderPins.after?.toString("base64") ?? null,
    },
  });
}
function validatePlan(plan: FolderLifecyclePlan) {
  wire(plan);
  const receipt = plan.result.folder;
  const source = safeFolderPath(plan.sourcePath), destination = plan.promote ? parentPath(source) : safeFolderPath(plan.destinationPath);
  if (plan.promote && (plan.destinationPath !== destination || plan.destinationParents.length
    || plan.result.action !== "promote-delete" || plan.result.moved !== promotedCount(plan.entries))) {
    fail("INVALID_WORKSPACE", "Parent-promotion intent has a noncanonical destination, mode or child count.");
  }
  const expectedParents: string[] = [];
  for (let index = 1; index < destination.split("/").length; index++) {
    expectedParents.push(destination.split("/").slice(0, index).join("/"));
  }
  const missingParentStart = expectedParents.length - plan.destinationParents.length;
  if (missingParentStart < 0
    || plan.destinationParents.some(path => !folderLifecycleDefinitions[0].input.shape.destinationPath.safeParse(path).success)
    || plan.destinationParents.some((path, index) => path !== expectedParents[missingParentStart + index])) {
    fail("INVALID_WORKSPACE", "Folder intent destination-parent pins are not canonical.");
  }
  if (plan.operationId !== plan.result.operationId || plan.result.action !== (plan.promote ? "promote-delete" : "move")
    || receipt.area !== plan.area || receipt.sourcePath !== source || receipt.destinationPath !== destination
    || source.toLowerCase() === destination.toLowerCase()
    || destination.toLowerCase().startsWith(source.toLowerCase() + "/")
    || plan.destinationAbsent !== true || plan.expectedDestinationSha256 !== null
    || receipt.sourceSha256 !== plan.expectedSourceSha256
    || receipt.sourceSha256 !== treeDigest(plan.entries)
    || plan.expectedScanRevision !== receipt.scanRevision
    || pinRevision(plan.referencePins, plan.area === "notes" ? plan.noteFolderPins?.beforeSha256 : undefined) !== plan.expectedScanRevision
    || receipt.entries !== plan.entries.length
    || receipt.files !== plan.entries.filter(item => item.kind === "file").length
    || receipt.bytes !== plan.entries.reduce((sum, item) => sum + (item.kind === "file" ? item.size : 0), 0)
    || receipt.documents !== plan.markdownChanges.length
    || receipt.rewrittenDocuments !== plan.markdownChanges.filter(change => change.beforeSha256 !== change.afterSha256).length) {
    fail("INVALID_WORKSPACE", "Folder intent identity, receipt, subtree digest or reference pin is inconsistent.");
  }
  if ((plan.area === "notes") !== !!plan.noteFolderPins) {
    fail("INVALID_WORKSPACE", "Folder intent must own the Note folder-pin sidecar exactly for Notes moves.");
  }
  if (plan.noteFolderPins) {
    const pins = plan.noteFolderPins;
    if ((pins.before ? sha256(pins.before) : null) !== pins.beforeSha256
      || (pins.after ? sha256(pins.after) : null) !== pins.afterSha256
      || (pins.before === null) !== (pins.beforeSha256 === null)
      || (pins.after === null) !== (pins.afterSha256 === null)) {
      fail("INVALID_WORKSPACE", "Note folder-pin sidecar bytes do not match their exact plan hashes.");
    }
    const expected = repathNoteFolderPins(pins.before, source, destination);
    if ((expected ? sha256(expected) : null) !== pins.afterSha256 || (expected === null) !== (pins.after === null)
      || (expected && (pins.after === null || !expected.equals(pins.after)))) {
      fail("INVALID_WORKSPACE", "Folder intent does not contain the exact original Note folder-pin repath.");
    }
  }
  const entries = new Map<string, FolderEntry>();
  const foldedEntries = new Set<string>();
  for (const item of plan.entries) {
    const folded = `${dirname(item.path).toLocaleLowerCase("en-US")}/${basename(item.path).toLocaleLowerCase("en-US")}`;
    if (entries.has(item.path) || item.path.split("/").length > limits.depth
      || basename(item.path).toLowerCase() === "pkm-todo-board.json"
      || foldedEntries.has(folded)
      || dirname(item.path) !== "." && entries.get(dirname(item.path))?.kind !== "directory") {
      fail("INVALID_WORKSPACE", "Folder intent contains duplicate, over-deep or parentless entries.");
    }
    foldedEntries.add(folded);
    entries.set(item.path, item);
  }
  const sortedEntries = [...plan.entries].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  if (JSON.stringify(sortedEntries.map(item => item.path)) !== JSON.stringify(plan.entries.map(item => item.path))) {
    fail("INVALID_WORKSPACE", "Folder subtree entries must use deterministic path order.");
  }
  const changes = new Map<string, PlanChange>();
  let beforeBytes = 0, afterBytes = 0;
  for (const item of plan.markdownChanges) {
    if (changes.has(item.relativePath)) fail("INVALID_WORKSPACE", "Folder intent contains duplicate Markdown changes.");
    const entry = entries.get(item.relativePath);
    if (!entry || entry.kind !== "file" || !/\.md$/i.test(item.relativePath)
      || entry.sha256 !== item.beforeSha256 || entry.size !== item.beforeSize
      || sha256(item.before) !== item.beforeSha256 || sha256(item.after) !== item.afterSha256
      || item.before.length !== item.beforeSize || item.after.length !== item.afterSize) {
      fail("INVALID_WORKSPACE", "Folder Markdown pins do not match the serialized source subtree.");
    }
    const beforeText = item.before.toString("utf8"), afterText = item.after.toString("utf8");
    if (!Buffer.from(beforeText).equals(item.before) || !Buffer.from(afterText).equals(item.after)) {
      fail("INVALID_WORKSPACE", "Folder intent Markdown bytes are not valid UTF-8.");
    }
    const before = decodeMarkdown(item.id, beforeText, `${source}/${item.relativePath}`, plan.area);
    const afterPath = mappedPath(destination, item.relativePath);
    const after = decodeMarkdown(item.id, afterText, afterPath, plan.area);
    editable(before); editable(after);
    if (before.record.revision !== item.revision || after.record.revision !== item.revision
      || identity(before) !== item.id || identity(after) !== item.id
      || frontmatter(before.raw) !== frontmatter(after.raw)) fail("INVALID_WORKSPACE", "Folder intent changes a stable identity, revision or frontmatter.");
    const rebased = rebaseMarkdownAssets(resolve("folder-lifecycle-virtual", plan.area), before.record.path, afterPath, before.raw, { from: source, to: destination });
    if (!Buffer.from(rebased).equals(item.after)) fail("INVALID_WORKSPACE", "Folder intent is not the exact original Markdown owner-reference rebase.");
    beforeBytes += item.before.length;
    afterBytes += item.after.length;
    changes.set(item.relativePath, item);
  }
  const sortedChanges = [...plan.markdownChanges].sort((left, right) =>
    Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)));
  if (JSON.stringify(sortedChanges.map(item => item.relativePath))
    !== JSON.stringify(plan.markdownChanges.map(item => item.relativePath))) {
    fail("INVALID_WORKSPACE", "Folder Markdown changes must use deterministic path order.");
  }
  const sortedPinsValue = [...plan.referencePins].sort((left, right) =>
    Buffer.compare(Buffer.from(`${left.area}/${left.path}`), Buffer.from(`${right.area}/${right.path}`)));
  if (beforeBytes > limits.scanBytes || afterBytes > limits.scanBytes
    || entries.size !== plan.entries.length
    || plan.referencePins.length > limits.documents
    || new Set(plan.referencePins.map(item => `${item.area}/${item.path}`)).size !== plan.referencePins.length
    || new Set(plan.referencePins.map(item => item.id)).size !== plan.referencePins.length
    || JSON.stringify(sortedPinsValue) !== JSON.stringify(plan.referencePins)
    || plan.referencePins.some(pin => !pinSchema.safeParse(pin).success || !documentPath.safeParse(pin.path).success)) {
    fail("INVALID_WORKSPACE", "Folder intent exceeds bounds or has ambiguous reference pins.");
  }
  const sourcePins = plan.referencePins.filter(pin => pin.area === plan.area && pin.path.startsWith(source + "/"));
  if (sourcePins.length !== changes.size || sourcePins.some(pin => {
    const relativePath = pin.path.slice(source.length + 1), change = changes.get(relativePath);
    return !change || pin.id !== change.id || pin.revision !== change.revision || pin.sha256 !== change.beforeSha256;
  })) fail("INVALID_WORKSPACE", "Folder intent reference pins do not cover the exact source Markdown.");
  return plan;
}

export function serializeFolderLifecyclePlan(plan: FolderLifecyclePlan): string {
  return guarded(() => {
    validatePlan(plan);
    const json = JSON.stringify(wire(plan));
    if (Buffer.byteLength(json) > 64_000_000) fail("INVALID_WORKSPACE", "Folder intent exceeds its 64 MB serialized bound.");
    return json;
  });
}
export function deserializeFolderLifecyclePlan(json: string): FolderLifecyclePlan {
  return guarded(() => {
    if (typeof json !== "string" || Buffer.byteLength(json) > 64_000_000) fail("INVALID_WORKSPACE", "Folder intent JSON exceeds its bounded contract.");
    const value = JSON.parse(json) as unknown;
    const parsed = serializedSchema.safeParse(value);
    if (!parsed.success) fail("INVALID_WORKSPACE", "Persisted folder intent does not match its strict serialization contract.");
    const plan = {
      ...parsed.data,
      markdownChanges: parsed.data.markdownChanges.map(change => ({
        ...change, before: Buffer.from(change.before, "base64"), after: Buffer.from(change.after, "base64"),
      })),
      ...(parsed.data.noteFolderPins ? { noteFolderPins: {
        ...parsed.data.noteFolderPins,
        before: parsed.data.noteFolderPins.before === null ? null : Buffer.from(parsed.data.noteFolderPins.before, "base64"),
        after: parsed.data.noteFolderPins.after === null ? null : Buffer.from(parsed.data.noteFolderPins.after, "base64"),
      } } : {}),
    } as FolderLifecyclePlan;
    validatePlan(plan);
    return plan;
  });
}

function syncDirectory(directory: string) {
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function renameNoReplace(source: string, destination: string) {
  try {
    renameNoReplaceSync(source, destination);
  } catch (error) {
    if (!(error instanceof RenameNoReplaceError)) throw error;
    if (error.code === "DESTINATION_EXISTS") fail("CONFLICT", error.message);
    if (error.code === "UNAVAILABLE") fail("UNSUPPORTED_OPERATION", error.message);
    const cause = error.cause;
    if (cause instanceof Error && "status" in cause && cause.status === 2) fail("CONFLICT", "Folder source or destination parent changed before the exclusive move.");
    fail("STORAGE_ERROR", error.message);
  }
}
function missingParents(root: string, plan: FolderLifecyclePlan, allowCreated: boolean) {
  const areaRoot = join(root, plan.area);
  let missingSeen = false;
  for (const path of plan.destinationParents) {
    const full = join(areaRoot, ...path.split("/"));
    let stat;
    try { stat = lstatSync(full); } catch (error) {
      if (!missing(error)) throw error;
      missingSeen = true;
      continue;
    }
    if (!allowCreated || !stat.isDirectory() || stat.isSymbolicLink() || missingSeen) {
      fail("RECOVERY_CONFLICT", "A destination parent changed from its pinned absent state.");
    }
    const next = plan.destinationParents.find(candidate => dirname(candidate) === path);
    const allowed = next ? basename(next) : basename(plan.destinationPath);
    const entries = readdirSync(full);
    if (entries.some(name => name !== allowed)) fail("RECOVERY_CONFLICT", "A newly created destination parent contains unknown data.");
  }
}
function createParents(root: string, plan: FolderLifecyclePlan) {
  const areaRoot = join(root, plan.area);
  for (const path of plan.destinationParents) {
    const full = join(areaRoot, ...path.split("/"));
    try { mkdirSync(full, { mode: 0o700 }); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    const stat = lstatSync(full);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("RECOVERY_CONFLICT", "Destination parent is not a real directory.");
    syncDirectory(dirname(full));
  }
}
function prefixMap(plan: FolderLifecyclePlan): Map<string, PlanChange> {
  return new Map(plan.markdownChanges.map(change => [change.relativePath, change]));
}
function scanDestinationTree(root: string, plan: FolderLifecyclePlan) {
  const changes = prefixMap(plan);
  return scanTree(root, plan.area, plan.destinationPath, { operationId: plan.operationId, changes });
}
function classifyDestinationTree(plan: FolderLifecyclePlan, scanned: ScannedTree) {
  const expected = new Map(plan.entries.map(item => [item.path, item]));
  const actual = new Map(scanned.entries.map(item => [item.path, item]));
  if (actual.size !== expected.size || [...expected.keys()].some(path => !actual.has(path))) {
    fail("RECOVERY_CONFLICT", "Moved folder subtree has unknown or missing entries.");
  }
  let prefix = 0, encounteredBefore = false;
  const changes = plan.markdownChanges.filter(change => change.beforeSha256 !== change.afterSha256);
  const changeMap = prefixMap(plan);
  for (const item of plan.entries) {
    const current = actual.get(item.path)!;
    const change = changeMap.get(item.path);
    if (item.kind !== current.kind) fail("RECOVERY_CONFLICT", "Moved folder entry type changed.");
    if (item.kind === "directory") continue;
    if (change) {
      if (current.kind !== "file" || current.size !== change.beforeSize && current.size !== change.afterSize
        || current.sha256 !== change.beforeSha256 && current.sha256 !== change.afterSha256) {
        fail("RECOVERY_CONFLICT", "Moved Markdown bytes are neither their exact before nor after value.");
      }
      if (change.beforeSha256 !== change.afterSha256) {
        if (current.sha256 === change.beforeSha256) encounteredBefore = true;
        else {
          if (encounteredBefore) fail("RECOVERY_CONFLICT", "Folder rewrite states are not a recognized ordered phase.");
          prefix++;
        }
      }
    } else if (current.kind !== "file" || item.size !== current.size || item.sha256 !== current.sha256) {
      fail("RECOVERY_CONFLICT", "Moved non-Markdown bytes changed outside the intent.");
    }
  }
  if (scanned.bytes < 0 || changes.some(change => !changeMap.has(change.relativePath))) {
    fail("RECOVERY_CONFLICT", "Moved folder state is inconsistent with its intent.");
  }
  const next = changes[prefix];
  const expectedStagingPath = next
    ? `${dirname(next.relativePath) === "." ? "" : `${dirname(next.relativePath)}/`}.pkm-write-${plan.operationId}`
    : null;
  if (scanned.stagingPath !== null && scanned.stagingPath !== expectedStagingPath) {
    fail("RECOVERY_CONFLICT", "Folder staging file is not at the next recognized write phase.");
  }
  return prefix;
}
function normalizedPins(plan: FolderLifecyclePlan, moved: boolean, afterCount: number) {
  const rewrites = plan.markdownChanges.filter(change => change.beforeSha256 !== change.afterSha256);
  const after = new Set(rewrites.slice(0, afterCount).map(change => change.relativePath));
  return plan.referencePins.map(pin => {
    if (pin.area !== plan.area || !pin.path.startsWith(plan.sourcePath + "/")) return pin;
    const relativePath = pin.path.slice(plan.sourcePath.length + 1), change = prefixMap(plan).get(relativePath);
    return {
      ...pin,
      path: `${moved ? plan.destinationPath : plan.sourcePath}/${relativePath}`,
      ...(moved && change && after.has(relativePath) ? { sha256: change.afterSha256 } : {}),
    };
  }).sort((left, right) => Buffer.compare(Buffer.from(`${left.area}/${left.path}`), Buffer.from(`${right.area}/${right.path}`)));
}
function validateReferenceState(root: string, plan: FolderLifecyclePlan, moved: boolean, afterCount: number) {
  const snapshot = referenceSnapshot(root);
  const expected = normalizedPins(plan, moved, afterCount);
  if (!comparePins(snapshot.pins, expected)) fail("RECOVERY_CONFLICT", "Folder reference scan changed outside the persisted intent.");
  checkReferenceSafety(root, plan.area, moved ? plan.destinationPath : plan.sourcePath, snapshot.documents);
}
function phase(root: string, plan: FolderLifecyclePlan, recovering: boolean) {
  const source = pathExists(root, plan.area, plan.sourcePath);
  const destination = pathExists(root, plan.area, plan.destinationPath);
  if (!!source === !!destination) fail("RECOVERY_CONFLICT", "Folder intent requires exactly one of its pinned source or destination directories.");
  const moved = !!destination;
  missingParents(root, plan, recovering || moved);
  if (!moved) {
    if (!source!.stat.isDirectory()) fail("RECOVERY_CONFLICT", "Folder source is no longer a directory.");
    const tree = scanTree(root, plan.area, plan.sourcePath);
    if (treeDigest(tree.entries) !== plan.result.folder.sourceSha256
      || JSON.stringify(tree.entries) !== JSON.stringify(plan.entries)) {
      fail("RECOVERY_CONFLICT", "Folder source bytes or structure changed outside the intent.");
    }
    if (!recovering && plan.destinationParents.some(path => {
      try { lstatSync(join(root, plan.area, ...path.split("/"))); return true; } catch (error) { if (!missing(error)) throw error; return false; }
    })) fail("CONFLICT", "A pinned-absent destination parent appeared before application.");
    validateReferenceState(root, plan, false, 0);
    validateNoteFolderPins(root, plan, false);
    return { moved: false, rewritten: 0 };
  }
  if (!destination!.stat.isDirectory()) fail("RECOVERY_CONFLICT", "Folder destination is not a real directory.");
  const tree = scanDestinationTree(root, plan);
  const rewritten = classifyDestinationTree(plan, tree);
  validateReferenceState(root, plan, true, rewritten);
  validateNoteFolderPins(root, plan, true);
  return { moved: true, rewritten };
}
function promotionPhase(root: string, plan: FolderLifecyclePlan) {
  const source = pathExists(root, plan.area, plan.sourcePath);
  if (source && !source.stat.isDirectory()) fail("RECOVERY_CONFLICT", "Promotion source is not a real directory.");
  const sourceTree = source ? scanTree(root, plan.area, plan.sourcePath) : undefined;
  const names = promotionNames(plan.entries), moved = new Set<string>();
  const entries = [...(sourceTree?.entries ?? [])];
  const allowedAssets = new Set<string>();
  let stagingPath: string | null = null, beforeSeen = false;
  for (const name of names) {
    const atSource = sourceTree?.entries.some(entry => entry.path === name) ?? false;
    const destinationPath = mappedPath(plan.destinationPath, name);
    const destination = pathExists(root, plan.area, destinationPath);
    // Also rejects portable case aliases and symlink/non-directory parents.
    const portable = destinationState(root, plan.area, destinationPath);
    if (atSource === !!destination || portable.destinationExists !== !!destination) {
      fail("RECOVERY_CONFLICT", "Every promoted child must exist on exactly one pinned side.");
    }
    if (atSource) { beforeSeen = true; continue; }
    if (beforeSeen) fail("RECOVERY_CONFLICT", "Promoted children are not an ordered no-replace prefix.");
    moved.add(name);
    if (destination!.stat.isDirectory()) {
      entries.push({ path: name, kind: "directory" });
      const changes = new Map(plan.markdownChanges.filter(change => change.relativePath.startsWith(name + "/"))
        .map(change => {
          const relativePath = change.relativePath.slice(name.length + 1);
          return [relativePath, { ...change, relativePath }];
        }));
      const tree = scanTree(root, plan.area, destinationPath, { operationId: plan.operationId, changes });
      entries.push(...tree.entries.map(entry => ({ ...entry, path: `${name}/${entry.path}` })));
      if (tree.stagingPath !== null) {
        if (stagingPath !== null) fail("RECOVERY_CONFLICT", "Multiple promotion staging files require reconciliation.");
        stagingPath = `${name}/${tree.stagingPath}`;
      }
    } else {
      const bytes = readBytes(root, plan.area, destinationPath, limits.fileBytes);
      entries.push({ path: name, kind: "file", size: bytes.length, sha256: sha256(bytes) });
    }
  }
  const marker = plan.entries.find(entry => entry.path === ".gitkeep");
  const markerMissing = !!marker && !entries.some(entry => entry.path === ".gitkeep");
  if (markerMissing) entries.push(marker!);
  const topStaging = mappedPath(plan.destinationPath, `.pkm-write-${plan.operationId}`);
  if (pathExists(root, plan.area, topStaging) && !(plan.area === "notes" && !plan.destinationPath && !source)) {
    const candidates = plan.markdownChanges.filter(change => !change.relativePath.includes("/")
      && change.beforeSha256 !== change.afterSha256);
    const bytes = readBytes(root, plan.area, topStaging, limits.markdownBytes);
    if (stagingPath !== null || !candidates.some(change => bytes.length <= change.after.length
      && change.after.subarray(0, bytes.length).equals(bytes))) fail("RECOVERY_CONFLICT", "Unknown parent-level promotion staging.");
    stagingPath = `.pkm-write-${plan.operationId}`;
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const rewritten = classifyDestinationTree(plan, {
    entries, contents: new Map(), files: 0, bytes: 0, markdownBytes: 0, stagingPath,
  });
  const changes = plan.markdownChanges.filter(change => change.beforeSha256 !== change.afterSha256);
  if ((rewritten || stagingPath !== null || markerMissing || !source) && moved.size !== names.length
    || (markerMissing || !source) && rewritten !== changes.length) {
    fail("RECOVERY_CONFLICT", "Container removal or Markdown writes preceded completion of child promotions.");
  }
  for (const entry of plan.entries) {
    if (entry.kind === "directory" && isMarkdownAssetDirectory(basename(entry.path))) {
      const base = moved.has(entry.path.split("/")[0]!) ? plan.destinationPath : plan.sourcePath;
      allowedAssets.add(`${plan.area}/${mappedPath(base, entry.path)}`);
    }
  }
  const after = new Set(changes.slice(0, rewritten).map(change => change.relativePath));
  const expected = plan.referencePins.map(pin => {
    if (pin.area !== plan.area || !pin.path.startsWith(plan.sourcePath + "/")) return pin;
    const relativePath = pin.path.slice(plan.sourcePath.length + 1);
    const base = moved.has(relativePath.split("/")[0]!) ? plan.destinationPath : plan.sourcePath;
    const change = prefixMap(plan).get(relativePath)!;
    return { ...pin, path: mappedPath(base, relativePath), sha256: after.has(relativePath) ? change.afterSha256 : pin.sha256 };
  }).sort((a, b) => Buffer.compare(Buffer.from(`${a.area}/${a.path}`), Buffer.from(`${b.area}/${b.path}`)));
  if (!comparePins(referenceSnapshot(root, allowedAssets).pins, expected)) {
    fail("RECOVERY_CONFLICT", "Promotion reference snapshot changed outside its durable intent.");
  }
  validateNoteFolderPins(root, plan, !source);
  return { moved, rewritten, removed: !source, markerMissing };
}
function finishPromotion(root: string, plan: FolderLifecyclePlan, recovering: boolean): FolderLifecycleResult {
  let current = promotionPhase(root, plan);
  if (!recovering && (current.moved.size || current.removed || current.markerMissing)) {
    fail("RECOVERY_CONFLICT", "Promotion is partially applied; use its durable intent recovery.");
  }
  try {
    for (const name of promotionNames(plan.entries).slice(current.moved.size)) {
      promotionPhase(root, plan);
      const sourcePath = `${plan.sourcePath}/${name}`, destinationPath = mappedPath(plan.destinationPath, name);
      renameNoReplace(join(root, plan.area, sourcePath), join(root, plan.area, destinationPath));
      syncDirectory(join(root, plan.area, plan.sourcePath));
      syncDirectory(join(root, plan.area, plan.destinationPath));
      current = promotionPhase(root, plan);
    }
  } catch (error) {
    // Roll back only a fully recognized, unrewritten prefix; unknown external edits stay fenced.
    const observed = promotionPhase(root, plan);
    if (observed.rewritten || observed.removed) throw error;
    for (const name of [...observed.moved].reverse()) {
      promotionPhase(root, plan);
      renameNoReplace(join(root, plan.area, mappedPath(plan.destinationPath, name)), join(root, plan.area, plan.sourcePath, name));
      syncDirectory(join(root, plan.area, plan.sourcePath));
      syncDirectory(join(root, plan.area, plan.destinationPath));
    }
    promotionPhase(root, plan);
    throw error;
  }
  const changes = plan.markdownChanges.filter(change => change.beforeSha256 !== change.afterSha256);
  for (let index = current.rewritten; index < changes.length; index++) {
    const change = changes[index]!;
    ensureKnownStaging(root, plan, change);
    if (promotionPhase(root, plan).rewritten !== index) fail("RECOVERY_CONFLICT", "Promotion rewrite phase changed.");
    atomicFileWrite(checkedDocumentPath(root, mappedPath(plan.destinationPath, change.relativePath), false, plan.area),
      change.after, change.beforeSha256, plan.operationId);
    current = promotionPhase(root, plan);
  }
  if (!current.removed) {
    current = promotionPhase(root, plan);
    if (current.rewritten !== changes.length) fail("RECOVERY_CONFLICT", "Promotion writes did not complete.");
    if (plan.entries.some(entry => entry.path === ".gitkeep") && !current.markerMissing) {
      unlinkSync(join(root, plan.area, plan.sourcePath, ".gitkeep"));
      syncDirectory(join(root, plan.area, plan.sourcePath));
      promotionPhase(root, plan);
    }
    // Never recursively delete: an external writer's unexpected child makes rmdir fail closed.
    rmdirSync(join(root, plan.area, plan.sourcePath));
    syncDirectory(join(root, plan.area, plan.destinationPath));
  }
  promotionPhase(root, plan);
  applyNoteFolderPins(root, plan);
  promotionPhase(root, plan);
  return plan.result;
}
function ensureKnownStaging(root: string, plan: FolderLifecyclePlan, change: PlanChange) {
  const path = mappedPath(plan.destinationPath, change.relativePath);
  const temporary = join(root, plan.area, ...path.split("/").slice(0, -1), `.pkm-write-${plan.operationId}`);
  let stat;
  try { stat = lstatSync(temporary); } catch (error) { if (missing(error)) return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > change.after.length) fail("RECOVERY_CONFLICT", "Folder write staging is not a regular bounded file.");
  const bytes = readBytes(root, plan.area, [...path.split("/").slice(0, -1), `.pkm-write-${plan.operationId}`].join("/"), limits.markdownBytes);
  if (!change.after.subarray(0, bytes.length).equals(bytes)) fail("RECOVERY_CONFLICT", "Folder write staging bytes are unknown; preserve the pending intent.");
}
function applyNoteFolderPins(root: string, plan: FolderLifecyclePlan) {
  const pins = plan.noteFolderPins;
  if (!pins || pins.beforeSha256 === pins.afterSha256) return;
  const current = sidecarBytes(root), currentHash = current ? sha256(current) : null;
  if (pins.after !== null && currentHash === pins.afterSha256 && current?.equals(pins.after)) return;
  if (pins.before === null || currentHash !== pins.beforeSha256 || !current?.equals(pins.before)) {
    fail("RECOVERY_CONFLICT", "Note folder-pin sidecar is neither the exact before nor after value.");
  }
  if (pins.after === null) fail("INVALID_WORKSPACE", "A Note folder-pin repath cannot remove its reserved sidecar.");
  atomicFileWrite(join(root, "notes", ".pk-meta.json"), pins.after, pins.beforeSha256, plan.operationId);
}
function finish(root: string, plan: FolderLifecyclePlan, operationId: string, recovering: boolean): FolderLifecycleResult {
  let effects = false;
  try {
    validatePlan(plan);
    if (operationId !== plan.operationId) fail("INVALID_WORKSPACE", "Folder recovery operationId does not match the durable intent.");
    root = checkedRoot(root);
    if (plan.promote) {
      effects = true;
      return finishPromotion(root, plan, recovering);
    }
    let current = phase(root, plan, recovering);
    if (!recovering && current.moved) fail("RECOVERY_CONFLICT", "Folder move is already partially applied; use durable intent recovery.");
    if (!current.moved) {
      if (plan.destinationParents.length) {
        effects = true;
        createParents(root, plan);
        missingParents(root, plan, true);
      }
      if (phase(root, plan, true).moved) fail("RECOVERY_CONFLICT", "Folder source changed while preparing destination parents.");
      effects = true;
      const source = join(root, plan.area, ...plan.sourcePath.split("/"));
      const destination = join(root, plan.area, ...plan.destinationPath.split("/"));
      renameNoReplace(source, destination);
      syncDirectory(dirname(source));
      syncDirectory(dirname(destination));
      current = phase(root, plan, true);
      if (!current.moved) fail("RECOVERY_CONFLICT", "Exclusive folder move did not reach its after state.");
    }
    const changes = plan.markdownChanges.filter(change => change.beforeSha256 !== change.afterSha256);
    for (let index = current.rewritten; index < changes.length; index++) {
      const change = changes[index]!;
      ensureKnownStaging(root, plan, change);
      const mappedPath = `${plan.destinationPath}/${change.relativePath}`;
      const full = checkedDocumentPath(root, mappedPath, false, plan.area);
      const beforePhase = phase(root, plan, true);
      if (!beforePhase.moved || beforePhase.rewritten !== index) fail("RECOVERY_CONFLICT", "Folder rewrite phase changed before an owner-reference update.");
      effects = true;
      atomicFileWrite(full, change.after, change.beforeSha256, plan.operationId);
      current = phase(root, plan, true);
      if (!current.moved || current.rewritten !== index + 1) fail("RECOVERY_CONFLICT", "Folder owner-reference rebase did not reach its exact next phase.");
    }
    const final = phase(root, plan, true);
    if (!final.moved || final.rewritten !== changes.length) fail("RECOVERY_CONFLICT", "Folder move failed to reach its exact after state.");
    effects = true;
    applyNoteFolderPins(root, plan);
    if (plan.noteFolderPins) {
      const sidecar = sidecarBytes(root);
      if ((sidecar ? sha256(sidecar) : null) !== plan.noteFolderPins.afterSha256
        || (sidecar === null) !== (plan.noteFolderPins.after === null)
        || sidecar && (plan.noteFolderPins.after === null || !sidecar.equals(plan.noteFolderPins.after))) {
        fail("RECOVERY_CONFLICT", "Folder move did not reach the exact Note folder-pin after state.");
      }
    }
    return plan.result;
  } catch (error) {
    if (error instanceof CoreError) throw new CoreError(error.code, error.message, effects || recovering ? "unknown" : error.effect);
    throw new CoreError("RECOVERY_CONFLICT", "Folder application interrupted; preserve the durable intent for reconciliation.", "unknown");
  }
}

/** Caller must persist this exact intent and hold the shared SQLite writer lock before calling.
 * Commit folder path/identity reindex, the immutable receipt and intent removal together after success.
 * No lock can exclude an uncooperative external writer racing final filesystem/reference checks. */
export function applyFolderLifecycle(root: string, plan: FolderLifecyclePlan, operationId: string): FolderLifecycleResult {
  return finish(root, plan, operationId, false);
}
/** Recover only exact source/destination trees and ordered Markdown before/after prefixes. */
export function recoverFolderLifecycle(root: string, plan: FolderLifecyclePlan, operationId: string): FolderLifecycleResult {
  return finish(root, plan, operationId, true);
}
/** Read-only startup fence: validate every pending intent before any recovery effects. */
export function inspectFolderLifecycleRecovery(root: string, plan: FolderLifecyclePlan, operationId: string): void {
  validatePlan(plan);
  if (operationId !== plan.operationId) fail("INVALID_WORKSPACE", "Folder recovery operationId does not match the durable intent.");
  if (plan.promote) promotionPhase(checkedRoot(root), plan);
  else phase(checkedRoot(root), plan, true);
}
