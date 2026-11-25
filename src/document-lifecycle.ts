import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { CoreError, type StorageRequest } from "./contracts.js";
import { checkedDocumentPath, checkedResourcePath, documentPath, knowledgeArea, resourcePath, type KnowledgeArea } from "./document-path.js";
import { documentLifecycleDefinitions, documentLifecycleLimits as limits, type DocumentLifecycleOperation, type DocumentLifecyclePreview, type DocumentLifecycleResult } from "./document-lifecycle-contracts.js";
import { isMarkdownAssetDirectory, localAssetReference, markdownAssetDirectory, markdownReferences } from "./domain/markdown-assets.js";
import { rebaseMarkdownAssets } from "./domain/document-lifecycle-original.js";
import { atomicFileCreateNoReplace, sha256 } from "./file-write.js";
import { decodeMarkdown, type MarkdownRecord } from "./markdown.js";
import { RenameNoReplaceError, renameNoReplaceSync } from "./rename-no-replace.js";
import { knowledgeReadPrivateTopLevels } from "./fresh-note-query-contracts.js";
import {
  assertLegacyAssetDispositions, assertPinnedLegacyAsset, documentHasLegacyAssetReferences, legacyAssetCopySchema, legacyAssetReferenceSources,
  legacyAssetDisposition, legacyAssetDispositionProtocol,
  planLegacyAssetCopies, readPinnedLegacyAsset, readPrivateLegacyAssetForPublication, rewriteLegacyAssetReferences, type LegacyAssetCopy,
} from "./document-legacy-assets.js";
import {
  privateResourcePublicationProtocol, validatePrivateResourcePublicationProvenance, type PrivateResourcePublicationProvenance,
} from "./private-resource-publication-contracts.js";
import {
  assertPrivateOperationPublicationScope, beginPrivateResourcePublication, assertPrivateResourcePublicationAttempt,
} from "./private-resource-publication-native.js";

export { documentLifecycleDefinitions, documentLifecycleLimits } from "./document-lifecycle-contracts.js";
export type { DocumentLifecycleOperation, DocumentLifecyclePreview, DocumentLifecycleResult } from "./document-lifecycle-contracts.js";
export type DocumentLifecycleRequest = Omit<StorageRequest, "operation"> & { operation: StorageRequest["operation"] | DocumentLifecycleOperation };
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pinSchema = z.strictObject({ area: knowledgeArea, path: documentPath, sha256: digest });
const treeEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({ path: resourcePath, kind: z.literal("directory") }),
  z.strictObject({ path: resourcePath, kind: z.literal("file"), sha256: digest, size: count.max(limits.fileBytes) }),
]);
type ReferencePin = z.infer<typeof pinSchema>;
type TreeEntry = z.infer<typeof treeEntrySchema>;
export interface DocumentLifecycleFileChange {
  area: KnowledgeArea; path: string; expectedSha256: string | null; afterSha256: string | null;
  before: Buffer | null; after: Buffer | null;
}
export interface DocumentLifecyclePlan {
  kind: "document-lifecycle"; operationId: string; actorId: string; expectedScanRevision: string;
  documentCas: { id: string; area: KnowledgeArea; path: string; revision: number; sha256: string };
  referencePins: ReferencePin[];
  pairedTree: { beforePath: string; afterPath: string; digest: string | null; entries: TreeEntry[] };
  changes: DocumentLifecycleFileChange[];
  requiresCompoundJournal: true;
  result: DocumentLifecycleResult;
  promoteIdentity?: true;
  boardIdentity?: string;
  legacyAssets?: { copies: LegacyAssetCopy[]; finalDigest: string; finalEntries: TreeEntry[];
    protocol?: typeof legacyAssetDispositionProtocol | typeof privateResourcePublicationProtocol };
}
function fail(code: string, message: string): never { throw new CoreError(code, message); }
function missing(error: unknown) { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function guarded<T>(action: () => T): T {
  try { return action(); }
  catch (error) {
    if (error instanceof CoreError) throw error;
    fail("INVALID_DOCUMENT", "Document lifecycle could not inspect a stable checked workspace; preserve pending intents for reconciliation.");
  }
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail("INVALID_ARGUMENT", "Document lifecycle arguments violate the public contract.");
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
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_DOCUMENT", "Lifecycle root and ancestors must be real directories, not links.");
  }
  return full;
}
function entry(root: string, area: KnowledgeArea, path: string) {
  if (!resourcePath.safeParse(path).success) fail("INVALID_DOCUMENT", "Unsafe lifecycle path.");
  let full = root;
  for (const part of [area, ...path.split("/")]) {
    const parent = lstatSync(full);
    if (!parent.isDirectory() || parent.isSymbolicLink()) fail("INVALID_DOCUMENT", "Lifecycle parents must be real directories.");
    full = join(full, part);
    let stat;
    try { stat = lstatSync(full); } catch (error) { if (missing(error)) return undefined; throw error; }
    if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) fail("INVALID_DOCUMENT", "Lifecycle entries must be regular files/directories, not links.");
  }
  return { full, stat: lstatSync(full) };
}
function read(root: string, area: KnowledgeArea, path: string, limit: number) {
  const found = entry(root, area, path);
  if (!found || !found.stat.isFile() || found.stat.size > limit) fail("CONFLICT", "Pinned lifecycle file is missing, non-regular or exceeds its byte limit.");
  const fd = openSync(found.full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit || stat.dev !== found.stat.dev || stat.ino !== found.stat.ino) fail("CONFLICT", "Lifecycle file changed during open.");
    const bytes = Buffer.alloc(Math.min(limit + 1, stat.size + 1));
    let used = 0;
    while (used < bytes.length) {
      const size = readSync(fd, bytes, used, bytes.length - used, used);
      if (!size) break;
      used += size;
    }
    const after = fstatSync(fd), current = entry(root, area, path);
    if (used !== stat.size || used > limit || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
      || !current || current.stat.dev !== stat.dev || current.stat.ino !== stat.ino) fail("CONFLICT", "Lifecycle file changed during bounded read.");
    return bytes.subarray(0, used);
  } finally { closeSync(fd); }
}
function text(bytes: Buffer) {
  const raw = bytes.toString("utf8");
  if (!Buffer.from(raw).equals(bytes)) fail("INVALID_DOCUMENT", "Lifecycle Markdown must be valid UTF-8.");
  return raw;
}
function stableIdentity(document: MarkdownRecord) {
  const metadata = document.metadata;
  if (metadata.has("documentId")) return metadata.get("documentId");
  const aliases: unknown = metadata.toJS({ maxAliasCount: 0 }).aliases;
  const prototype = metadata.get("schema") === "pkm.knowledge/v1" && metadata.has("revision") && metadata.has("deleted")
    && Array.isArray(aliases) ? [...new Set(aliases.filter((alias): alias is string =>
      typeof alias === "string" && /^note:[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(alias)).map(alias => alias.slice(5)))] : [];
  return prototype.length === 1 ? prototype[0] : metadata.get("knowledgeId");
}
function editable(document: MarkdownRecord, promoteIdentity = false, boardIdentity?: string) {
  const board = boardIdentity === document.record.id && document.record.area === "notes"
    && document.metadata.get("documentKind") === "todo-board";
  if (boardIdentity !== undefined && !board) fail("ACCESS_DENIED", "Dedicated Board move requires its exact stable Note identity.");
  if (document.record.deleted || document.metadata.has("memory")
    || !board && (document.metadata.get("documentKind") === "todo-board"
      || basename(document.record.path).toLowerCase() === "todo board.md")
    || document.record.path.split("/").some(part => part.toLowerCase() === "system")) {
    fail("ACCESS_DENIED", "Todo, memory, system or deleted descriptors require dedicated lifecycle support.");
  }
  if (stableIdentity(document) !== document.record.id && !((promoteIdentity || board) && stableIdentity(document) === undefined))
    fail("UNSUPPORTED_OPERATION", "Legacy path-only identity cannot be preserved by a move; first perform an explicit stable-identity migration.");
}
function publicAddress(root: string, area: KnowledgeArea, path: string) {
  return !knowledgeReadPrivateTopLevels(root, area).has(path.split("/")[0]!);
}
function assertPublicMove(root: string, area: KnowledgeArea, source: string, destination: string) {
  if (!publicAddress(root, area, source) || !publicAddress(root, area, destination))
    fail("ACCESS_DENIED", "Private content remains immutable; document moves require public source and destination paths.");
}
function scan(root: string, staging?: string) {
  const documents: MarkdownRecord[] = [];
  const privateTopLevels = new Map(knowledgeArea.options.map(area => [area, knowledgeReadPrivateTopLevels(root, area)]));
  const visible = (area: KnowledgeArea, path: string) => !privateTopLevels.get(area)!.has(path.split("/")[0]!);
  let entries = 0, bytes = 0;
  function walk(area: KnowledgeArea, path: string, depth: number) {
    if (depth > limits.depth) fail("INVALID_WORKSPACE", "Lifecycle reference scan exceeds 32 directory levels.");
    const directory = path ? entry(root, area, path) : { full: join(root, area), stat: lstatSync(join(root, area)) };
    if (!directory || !directory.stat.isDirectory() || directory.stat.isSymbolicLink()) fail("INVALID_DOCUMENT", "Reference scan requires real directories.");
    for (const name of readdirSync(directory.full).sort()) {
      if (++entries > limits.entries) fail("INVALID_WORKSPACE", "Lifecycle reference scan exceeds 8192 entries.");
      const address = path ? `${path}/${name}` : name;
      if (name === ".trash") {
        const stat = lstatSync(join(directory.full, name));
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_DOCUMENT", "Trash exclusion must be a real directory.");
        continue;
      }
      if (staging && `${area}/${address}` === staging) continue;
      const found = entry(root, area, address);
      if (!found) fail("CONFLICT", "Reference scan entry disappeared.");
      if (found.stat.isDirectory()) {
        if (!isMarkdownAssetDirectory(name)) walk(area, address, depth + 1);
      } else {
        if (!documentPath.safeParse(address).success) fail("INVALID_DOCUMENT", "Unknown files outside resource trees cannot use document lifecycle.");
        if (documents.length >= limits.documents || bytes + found.stat.size > limits.scanBytes) fail("INVALID_WORKSPACE", "Lifecycle scan exceeds 2048 documents or 16 MiB.");
        const content = read(root, area, address, limits.markdownBytes);
        bytes += content.length;
        if (bytes > limits.scanBytes) fail("INVALID_WORKSPACE", "Lifecycle reference scan exceeds 16 MiB.");
        try { documents.push(decodeMarkdown("lifecycle-scan", text(content), address, area)); }
        catch (error) {
          if (!visible(area, address))
            fail("INVALID_DOCUMENT", "The retained private reference closure cannot be validated; no private content was published.");
          throw error;
        }
      }
    }
  }
  for (const area of knowledgeArea.options) {
    try { lstatSync(join(root, area)); } catch (error) { if (missing(error)) continue; throw error; }
    walk(area, "", 0);
  }
  const pins: ReferencePin[] = documents.map(({ record }) => ({ area: record.area, path: record.path, sha256: record.sha256 }));
  // Private sources participate only in immutable validation pins, never public projections.
  const publicDocuments = documents.filter(({ record }) => visible(record.area, record.path));
  const publicPins = pins.filter(pin => visible(pin.area, pin.path));
  return { documents, pins, publicDocuments, publicPins, revision: sha256(JSON.stringify(pins)), bytes };
}
function treeDigest(entries: TreeEntry[]) {
  return sha256(JSON.stringify(entries.map(item => item.kind === "file"
    ? [item.path, item.kind, item.size, item.sha256] : [item.path, item.kind])));
}
function tree(root: string, area: KnowledgeArea, path: string, boardIdentity?: string, ignoredStage?: string) {
  const start = entry(root, area, path);
  if (!start) return { digest: null, entries: [] as TreeEntry[], bytes: 0, files: 0 };
  if (!start.stat.isDirectory()) fail("INVALID_DOCUMENT", "Paired assets must be a real directory.");
  const entries: TreeEntry[] = [];
  let bytes = 0, files = 0;
  function walk(directory: string, prefix: string, depth: number) {
    if (depth > limits.depth) fail("INVALID_WORKSPACE", "Paired asset tree exceeds 32 directory levels.");
    for (const name of readdirSync(directory).sort()) {
      if (entries.length >= limits.assetEntries) fail("INVALID_WORKSPACE", "Paired tree exceeds 2048 entries.");
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (relativePath === ignoredStage) continue;
      if (name.toLowerCase() === "pkm-todo-board.json" && !(boardIdentity && relativePath === "pkm-todo-board.json"))
        fail("ACCESS_DENIED", "Todo backing data requires dedicated lifecycle support.");
      const found = entry(root, area, `${path}/${relativePath}`);
      if (!found) fail("CONFLICT", "Paired asset entry disappeared.");
      if (found.stat.isDirectory()) {
        entries.push({ path: relativePath, kind: "directory" });
        walk(found.full, relativePath, depth + 1);
      } else {
        if (bytes + found.stat.size > limits.assetBytes) fail("INVALID_WORKSPACE", "Paired assets exceed 64 MiB.");
        const content = read(root, area, `${path}/${relativePath}`, limits.fileBytes);
        bytes += content.length; files++;
        if (bytes > limits.assetBytes) fail("INVALID_WORKSPACE", "Paired assets exceed 64 MiB.");
        entries.push({ path: relativePath, kind: "file", size: content.length, sha256: sha256(content) });
      }
    }
  }
  walk(start.full, "", 0);
  return { digest: treeDigest(entries), entries, bytes, files };
}
function sharedGuard(root: string, documents: MarkdownRecord[], area: KnowledgeArea, source: string, destination: string) {
  const targets = [markdownAssetDirectory(source), markdownAssetDirectory(destination)].map(path => resolve(root, area, path));
  for (const document of documents) {
    if (document.record.area === area && document.record.path === source) continue;
    for (const { value } of markdownReferences(document.raw)) {
      const local = localAssetReference(value);
      if (!local) continue;
      const target = resolve(root, document.record.area, dirname(document.record.path), local);
      if (targets.some(tree => target === tree || target.startsWith(tree + sep))) fail("CONFLICT", "Paired resource tree is shared or the move would activate another document's resource reference.");
    }
  }
}
function ownerReferences(root: string, document: MarkdownRecord, legacyCopies?: readonly LegacyAssetCopy[]) {
  const areaRoot = resolve(root, document.record.area);
  for (const { value } of markdownReferences(document.raw)) {
    const local = localAssetReference(value);
    if (!local) continue;
    const path = relative(areaRoot, resolve(areaRoot, dirname(document.record.path), local)).replaceAll("\\", "/");
    if (path === ".." || path.startsWith("../")) fail("INVALID_DOCUMENT", "Owner reference escapes its content root.");
    if (path.split("/").includes("_assets")) {
      if (legacyCopies?.some(copy => copy.source === path)) continue;
      fail("UNSUPPORTED_OPERATION", "Legacy _assets references require the original explicit asset migration before moving.");
    }
    if (path.split("/").some(isMarkdownAssetDirectory)) entry(root, document.record.area, path);
  }
}
function finalLegacyTree(entries: readonly TreeEntry[], copies: readonly LegacyAssetCopy[]) {
  const paths = new Map(entries.map(item => [item.path, item]));
  for (const copy of copies) {
    const extension = extname(copy.source).toLowerCase();
    if (!copy.source.split("/").includes("_assets") || copy.source.split("/").some(part => /\.assets$/i.test(part))
      || extension && !/^\.[a-z0-9]{1,16}$/.test(extension)
      || copy.target.includes("/") || copy.target !== `${copy.sha256.slice(0, 16)}${extension}`)
      fail("INVALID_WORKSPACE", "Legacy asset intent does not derive its exact original digest-named destination.");
    const existing = paths.get(copy.target);
    if (existing && (existing.kind !== "file" || existing.sha256 !== copy.sha256 || existing.size !== copy.size))
      fail("CONFLICT", "Legacy resource migration would collide with existing paired bytes.");
    paths.set(copy.target, { path: copy.target, kind: "file", sha256: copy.sha256, size: copy.size });
  }
  if (paths.size > limits.assetEntries || [...paths.values()].reduce((sum, item) => sum + (item.kind === "file" ? item.size : 0), 0) > limits.assetBytes)
    fail("INVALID_WORKSPACE", "Combined paired and legacy assets exceed the existing bounded tree limits.");
  const ordered: TreeEntry[] = [];
  function visit(parent: string) {
    for (const item of [...paths.values()].filter(item => dirname(item.path) === parent)
      .sort((a, b) => basename(a.path) < basename(b.path) ? -1 : basename(a.path) > basename(b.path) ? 1 : 0)) {
      ordered.push(item);
      if (item.kind === "directory") visit(item.path);
    }
  }
  visit(".");
  if (ordered.length !== paths.size) fail("INVALID_WORKSPACE", "Legacy migration tree has an unpinned parent.");
  return ordered;
}
export function documentLifecycleUpdatedBytes(root: string, plan: DocumentLifecyclePlan, source: Buffer): Buffer {
  if (!plan.legacyAssets && documentHasLegacyAssetReferences(text(source)))
    fail("UNSUPPORTED_OPERATION", "New or unreconciled legacy resource references require separate source review.");
  const raw = plan.legacyAssets ? rewriteLegacyAssetReferences(root, plan.documentCas.area, plan.documentCas.path,
    text(source), plan.legacyAssets.copies) : text(source);
  return Buffer.from(rebaseMarkdownAssets(join(root, plan.documentCas.area), plan.documentCas.path, plan.result.document.afterPath, raw));
}
function prepare(root: string, documents: MarkdownRecord[], args: z.infer<typeof documentLifecycleDefinitions[0]["input"]>, promoteIdentity = false,
  boardIdentity?: string, publicationOperationId?: string, actorId?: string) {
  root = checkedRoot(root);
  assertPublicMove(root, args.area, args.path, args.destinationPath);
  if (args.path === args.destinationPath || args.path.toLowerCase() === args.destinationPath.toLowerCase()) fail("INVALID_ARGUMENT", "Move requires a distinct portable destination; case-only moves are unsupported.");
  if (args.destinationPath.split("/").length > limits.depth + 1) fail("INVALID_ARGUMENT", "Move destination exceeds 32 directory levels.");
  const matches = documents.filter(document => document.record.id === args.id || document.metadata.get("knowledgeId") === args.id);
  if (matches.length !== 1) fail(matches.length ? "CONFLICT" : "NOT_FOUND", "Move source must resolve uniquely.");
  const supplied = matches[0]!.record;
  if (supplied.area !== args.area || supplied.path !== args.path || supplied.revision !== args.expectedRevision || supplied.sha256 !== args.expectedSha256) fail("CONFLICT", "Move document pins changed.");
  const before = read(root, args.area, args.path, limits.markdownBytes);
  const document = decodeMarkdown(supplied.id, text(before), args.path, args.area);
  if (document.record.sha256 !== args.expectedSha256 || document.record.revision !== args.expectedRevision) fail("CONFLICT", "Move source changed on disk.");
  editable(document, promoteIdentity, boardIdentity);
  const scanned = scan(root);
  const suppliedPins = documents.map(({ record }) => ({ area: record.area, path: record.path, sha256: record.sha256 }));
  const key = (pin: ReferencePin) => `${pin.area}/${pin.path}`;
  if (JSON.stringify([...suppliedPins].sort((a, b) => key(a).localeCompare(key(b)))) !== JSON.stringify([...scanned.publicPins].sort((a, b) => key(a).localeCompare(key(b))))) fail("CONFLICT", "Move requires a complete current public three-area Markdown snapshot and its retained reference closure.");
  if (!((promoteIdentity || boardIdentity) && stableIdentity(document) === undefined)
    && scanned.documents.filter(other => stableIdentity(other) === supplied.id || other.metadata.get("knowledgeId") === supplied.id).length !== 1)
    fail("CONFLICT", "Move stable identity is ambiguous.");
  const beforePath = markdownAssetDirectory(args.path), afterPath = markdownAssetDirectory(args.destinationPath);
  if (entry(root, args.area, args.destinationPath) || entry(root, args.area, afterPath)) fail("CONFLICT", "Move document and paired-tree destinations must both be absent.");
  const paired = tree(root, args.area, beforePath, boardIdentity);
  sharedGuard(root, scanned.documents, args.area, args.path, args.destinationPath);
  if (documentHasLegacyAssetReferences(document.raw) && (!promoteIdentity || boardIdentity))
    fail("UNSUPPORTED_OPERATION", "Legacy asset relocation requires a canonical journaled Knowledge update.");
  const copies = documentHasLegacyAssetReferences(document.raw)
    ? planLegacyAssetCopies(root, args.area, args.path, document.raw, scanned.documents,
      publicationOperationId && actorId ? { operationId: publicationOperationId, actorId, id: document.record.id,
        revision: document.record.revision, sha256: document.record.sha256, afterPath: args.destinationPath } : undefined) : undefined;
  const finalEntries = copies ? finalLegacyTree(paired.entries, copies) : undefined;
  const legacyAssets = copies ? { copies, finalDigest: treeDigest(finalEntries!), finalEntries: finalEntries!,
    ...(copies.some(copy => copy.visibility === "private") ? { protocol: privateResourcePublicationProtocol }
      : copies.some(copy => legacyAssetDisposition(copy) === "retain") ? { protocol: legacyAssetDispositionProtocol } : {}) } : undefined;
  ownerReferences(root, document, copies);
  const migrated = copies ? rewriteLegacyAssetReferences(root, args.area, args.path, document.raw, copies) : document.raw;
  const after = Buffer.from(rebaseMarkdownAssets(join(root, args.area), args.path, args.destinationPath, migrated));
  if (after.length > limits.markdownBytes) fail("INVALID_DOCUMENT", "Rebased Markdown exceeds the supported byte range.");
  const moved = decodeMarkdown(supplied.id, text(after), args.destinationPath, args.area);
  editable(moved, promoteIdentity, boardIdentity);
  const preview = documentLifecycleDefinitions[0].output.parse({
    document: { id: supplied.id, area: args.area, beforePath: args.path, afterPath: args.destinationPath, revision: args.expectedRevision, beforeSha256: args.expectedSha256, afterSha256: sha256(after) },
    pairedAssets: { beforePath, afterPath, digest: paired.digest, files: paired.files, bytes: paired.bytes },
    scanRevision: scanned.revision, scannedDocuments: scanned.pins.length, scannedBytes: scanned.bytes,
    destinationAbsent: true, referenceRewriteRequired: !after.equals(before),
  });
  return { before, after, preview, paired, pins: scanned.pins, legacyAssets };
}
export function readDocumentLifecycle(root: string, documents: MarkdownRecord[], request: DocumentLifecycleRequest, promoteIdentity = false,
  publicationOperationId?: string): DocumentLifecyclePreview {
  return guarded(() => {
    if (request.operation !== "knowledge.document.lifecycle.preview") fail("NOT_FOUND", "Unknown document lifecycle read operation.");
    return prepare(root, documents, parse(documentLifecycleDefinitions[0].input, request.args), promoteIdentity, undefined,
      publicationOperationId, request.actorId).preview;
  });
}
export function planDocumentLifecycle(root: string, documents: MarkdownRecord[], request: DocumentLifecycleRequest, promoteIdentity = false): DocumentLifecyclePlan {
  return planMove(root, documents, request, promoteIdentity);
}
export function readNativeBoardDocumentMove(root: string, documents: MarkdownRecord[], request: DocumentLifecycleRequest, noteId: string): DocumentLifecyclePreview {
  return guarded(() => prepare(root, documents, parse(documentLifecycleDefinitions[0].input, request.args), false, noteId).preview);
}
/** Only the dedicated, writer-fenced Board journal may persist this plan. */
export function planNativeBoardDocumentMove(root: string, documents: MarkdownRecord[], request: DocumentLifecycleRequest, noteId: string): DocumentLifecyclePlan {
  return planMove(root, documents, request, false, noteId);
}
function planMove(root: string, documents: MarkdownRecord[], request: DocumentLifecycleRequest, promoteIdentity = false, boardIdentity?: string): DocumentLifecyclePlan {
  return guarded(() => {
    if (request.operation !== "knowledge.document.move") fail("NOT_FOUND", "Unknown document lifecycle mutation operation.");
    const args = parse(documentLifecycleDefinitions[1].input, request.args);
    const { operationId: _operationId, expectedScanRevision: _scan, expectedPairedTreeDigest: _tree,
      expectedDestinationSha256: _destination, expectedDestinationTreeDigest: _destinationTree, ...previewArgs } = args;
    const prepared = prepare(root, documents, previewArgs, promoteIdentity, boardIdentity, args.operationId, request.actorId);
    const { document, pairedAssets, scanRevision, referenceRewriteRequired } = prepared.preview;
    if (scanRevision !== args.expectedScanRevision || pairedAssets.digest !== args.expectedPairedTreeDigest) fail("CONFLICT", "Move reference scan or paired-tree CAS changed; preview again.");
    const result = documentLifecycleDefinitions[1].output.parse({ operationId: args.operationId, action: "move", document, pairedAssets, scanRevision, referenceRewriteRequired });
    const plan: DocumentLifecyclePlan = {
      kind: "document-lifecycle", operationId: args.operationId, actorId: request.actorId, expectedScanRevision: scanRevision,
      documentCas: { id: document.id, area: args.area, path: args.path, revision: args.expectedRevision, sha256: args.expectedSha256 },
      referencePins: prepared.pins,
      pairedTree: { beforePath: pairedAssets.beforePath, afterPath: pairedAssets.afterPath, digest: pairedAssets.digest, entries: prepared.paired.entries },
      changes: [
        { area: args.area, path: args.destinationPath, expectedSha256: null, afterSha256: document.afterSha256, before: null, after: prepared.after },
        { area: args.area, path: args.path, expectedSha256: args.expectedSha256, afterSha256: null, before: prepared.before, after: null },
      ],
      requiresCompoundJournal: true, result, ...(promoteIdentity ? { promoteIdentity: true as const } : {}),
      ...(boardIdentity ? { boardIdentity } : {}),
      ...(prepared.legacyAssets ? { legacyAssets: prepared.legacyAssets } : {}),
    };
    validatePlan(plan);
    return plan;
  });
}

const serializedSchema = z.strictObject({
  kind: z.literal("document-lifecycle"), operationId: z.string().uuid(), actorId: z.string().min(1).max(500),
  expectedScanRevision: digest,
  documentCas: z.strictObject({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/), area: knowledgeArea, path: documentPath, revision: count.min(1), sha256: digest }),
  referencePins: z.array(pinSchema).min(1).max(limits.documents),
  pairedTree: z.strictObject({ beforePath: resourcePath, afterPath: resourcePath, digest: digest.nullable(), entries: z.array(treeEntrySchema).max(limits.assetEntries) }),
  changes: z.array(z.strictObject({
    area: knowledgeArea, path: documentPath, expectedSha256: digest.nullable(), afterSha256: digest.nullable(),
    before: z.string().max(1_398_104).nullable(), after: z.string().max(1_398_104).nullable(),
  })).length(2),
  requiresCompoundJournal: z.literal(true), result: documentLifecycleDefinitions[1].output,
  promoteIdentity: z.literal(true).optional(),
  boardIdentity: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).optional(),
  legacyAssets: z.strictObject({ copies: z.array(legacyAssetCopySchema).min(1).max(limits.assetEntries),
    finalDigest: digest, finalEntries: z.array(treeEntrySchema).max(limits.assetEntries),
    protocol: z.enum([legacyAssetDispositionProtocol, privateResourcePublicationProtocol]).optional() }).optional(),
});
function wire(plan: DocumentLifecyclePlan) {
  return serializedSchema.parse({ ...plan, changes: plan.changes.map(change => ({ ...change, before: change.before?.toString("base64") ?? null, after: change.after?.toString("base64") ?? null })) });
}
function validatePlan(plan: DocumentLifecyclePlan, updatedSource?: Buffer) {
  wire(plan);
  const cas = plan.documentCas, result = plan.result, doc = result.document, paired = plan.pairedTree;
  const addition = plan.changes[0]!, removal = plan.changes[1]!;
  if (plan.operationId !== result.operationId || plan.expectedScanRevision !== result.scanRevision
    || sha256(JSON.stringify(plan.referencePins)) !== plan.expectedScanRevision
    || cas.id !== doc.id || cas.area !== doc.area || cas.path !== doc.beforePath || cas.sha256 !== doc.beforeSha256 || cas.revision !== doc.revision
    || doc.beforePath.toLowerCase() === doc.afterPath.toLowerCase()
    || doc.afterPath.split("/").length > limits.depth + 1
    || paired.beforePath !== markdownAssetDirectory(doc.beforePath) || paired.afterPath !== markdownAssetDirectory(doc.afterPath)
    || JSON.stringify(result.pairedAssets) !== JSON.stringify({ beforePath: paired.beforePath, afterPath: paired.afterPath, digest: paired.digest,
      files: paired.entries.filter(item => item.kind === "file").length, bytes: paired.entries.reduce((sum, item) => sum + (item.kind === "file" ? item.size : 0), 0) })
    || (paired.digest === null ? paired.entries.length !== 0 : paired.digest !== treeDigest(paired.entries))) fail("INVALID_WORKSPACE", "Move intent identity, receipt, scan or paired digest is inconsistent.");
  const addresses = new Set<string>();
  for (const pin of plan.referencePins) {
    const address = `${pin.area}/${pin.path}`;
    if (addresses.has(address) || (pin.area === cas.area && pin.path === doc.afterPath)) fail("INVALID_WORKSPACE", "Move reference pins contain duplicate or destination documents.");
    addresses.add(address);
  }
  if (plan.referencePins.filter(pin => pin.area === cas.area && pin.path === cas.path && pin.sha256 === cas.sha256).length !== 1) fail("INVALID_WORKSPACE", "Move scan does not pin the exact owning document.");
  const treePaths = new Set<string>();
  for (const item of paired.entries) {
    if (treePaths.has(item.path) || item.path.split("/").length > limits.depth + 1
      || basename(item.path).toLowerCase() === "pkm-todo-board.json"
        && !(plan.boardIdentity && item.path === "pkm-todo-board.json")) fail("INVALID_WORKSPACE", "Move tree entries contain duplicate, over-deep or Todo paths.");
    if (dirname(item.path) !== "." && !paired.entries.some(parent => parent.path === dirname(item.path) && parent.kind === "directory")) fail("INVALID_WORKSPACE", "Move tree entry has no pinned parent.");
    treePaths.add(item.path);
  }
  if (addition.area !== cas.area || addition.path !== doc.afterPath || addition.before !== null || addition.expectedSha256 !== null
    || addition.afterSha256 !== doc.afterSha256 || !addition.after
    || removal.area !== cas.area || removal.path !== cas.path || removal.after !== null || removal.afterSha256 !== null
    || removal.expectedSha256 !== cas.sha256 || !removal.before) fail("INVALID_WORKSPACE", "Move intent writes do not match its receipt.");
  for (const change of plan.changes) for (const [bytes, expected] of [[change.before, change.expectedSha256], [change.after, change.afterSha256]] as const) {
    if ((bytes === null) !== (expected === null) || (bytes && (bytes.length > limits.markdownBytes || sha256(bytes) !== expected))) fail("INVALID_WORKSPACE", "Move intent byte digest/limit mismatch.");
  }
  const before = decodeMarkdown(cas.id, text(removal.before), cas.path, cas.area);
  const after = decodeMarkdown(cas.id, text(addition.after), doc.afterPath, cas.area);
  editable(before, plan.promoteIdentity, plan.boardIdentity); editable(after, plan.promoteIdentity, plan.boardIdentity);
  if (before.record.revision !== cas.revision || after.record.revision !== cas.revision + (updatedSource ? 1 : 0)) fail("INVALID_WORKSPACE", "Move intent has an invalid document revision.");
  const virtualRoot = resolve("next-server/tests/document-lifecycle-virtual", cas.area);
  if (plan.legacyAssets) {
    const legacy = plan.legacyAssets, sources = legacyAssetReferenceSources(dirname(virtualRoot), cas.area, cas.path, before.raw);
    const privateCopies = legacy.copies.filter(copy => copy.visibility === "private");
    if (privateCopies.length ? legacy.protocol !== privateResourcePublicationProtocol
      : legacy.copies.some(copy => legacyAssetDisposition(copy) === "retain") !== (legacy.protocol === legacyAssetDispositionProtocol))
      fail("INVALID_WORKSPACE", "Retained legacy sources require their exact versioned disposition protocol.");
    for (const copy of legacy.copies) {
      if (copy.visibility !== "private") {
        if (copy.publication) fail("INVALID_WORKSPACE", "Public resources cannot carry private publication decisions.");
        continue;
      }
      const publication = validatePrivateResourcePublicationProvenance(copy.publication), subject = publication.subject;
      if (legacyAssetDisposition(copy) !== "retain" || subject.operationId !== plan.operationId || subject.actorId !== plan.actorId
        || subject.owner.area !== cas.area || subject.owner.id !== cas.id || subject.owner.beforePath !== cas.path
        || subject.owner.afterPath !== doc.afterPath || subject.owner.sha256 !== cas.sha256 || subject.owner.revision !== cas.revision
        || subject.resource.sourcePath !== copy.source || subject.resource.sha256 !== copy.sha256 || subject.resource.size !== copy.size
        || subject.resource.sourceIdentity !== copy.sourceIdentity || subject.resource.targetPath !== `${paired.afterPath}/${copy.target}`)
        fail("INVALID_WORKSPACE", "Private publication decisions do not bind the exact owner/source/target/operation.");
    }
    if (!plan.promoteIdentity || plan.boardIdentity || JSON.stringify(sources) !== JSON.stringify(legacy.copies.map(copy => copy.source))
      || JSON.stringify(finalLegacyTree(paired.entries, legacy.copies)) !== JSON.stringify(legacy.finalEntries)
      || treeDigest(legacy.finalEntries) !== legacy.finalDigest)
      fail("INVALID_WORKSPACE", "Legacy migration lost its exact owner sources or combined paired-tree proof.");
  }
  const rebased = documentLifecycleUpdatedBytes(dirname(virtualRoot), plan, updatedSource ?? removal.before);
  if (!rebased.equals(addition.after) || result.referenceRewriteRequired !== !removal.before.equals(addition.after)) fail("INVALID_WORKSPACE", "Move intent is not the exact original owner-reference rebase.");
  return plan;
}
export function serializeDocumentLifecyclePlan(plan: DocumentLifecyclePlan): string {
  return guarded(() => { validatePlan(plan); return JSON.stringify(wire(plan)); });
}
export function deserializeDocumentLifecyclePlan(json: string): DocumentLifecyclePlan {
  return guarded(() => {
    if (typeof json !== "string" || Buffer.byteLength(json) > 16_000_000) fail("INVALID_WORKSPACE", "Move intent JSON exceeds its bounded contract.");
    const parsed = serializedSchema.parse(JSON.parse(json));
    function bytes(value: string | null) {
      if (value === null) return null;
      const content = Buffer.from(value, "base64");
      if (content.toString("base64") !== value) fail("INVALID_WORKSPACE", "Move intent bytes must be canonical base64.");
      return content;
    }
    return validatePlan({ ...parsed, changes: parsed.changes.map(change => ({ ...change, before: bytes(change.before), after: bytes(change.after) })) });
  });
}
function observed(root: string, area: KnowledgeArea, path: string) {
  return entry(root, area, path) ? sha256(read(root, area, path, limits.markdownBytes)) : null;
}
function syncDirectory(directory: string) {
  if (process.platform === "win32") return;
  const fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function stagingGuard(root: string, plan: DocumentLifecyclePlan) {
  const addition = plan.changes[0]!, path = join(dirname(addition.path), `.pkm-write-${plan.operationId}`).replaceAll("\\", "/");
  const full = join(root, addition.area, path);
  let stat;
  try { stat = lstatSync(full); } catch (error) { if (missing(error)) return undefined; throw error; }
  // The shared writer lock excludes other legitimate staged writes. Unknown staging is never discarded.
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== addition.after!.length) fail("RECOVERY_CONFLICT", "Move staging contains unknown bytes; reconcile the durable intent.");
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const size = readSync(fd, bytes, used, bytes.length - used, used);
      if (!size) break;
      used += size;
    }
    if (!bytes.subarray(0, used).equals(addition.after!)) fail("RECOVERY_CONFLICT", "Move staging differs from the exact intent.");
  } finally { closeSync(fd); }
  return `${addition.area}/${path}`;
}
function legacyAssetStage(root: string, plan: DocumentLifecyclePlan): { name: string; sha256: string; size: number } | undefined {
  const name = `.pkm-write-${plan.operationId}`, full = join(root, plan.documentCas.area, plan.pairedTree.afterPath, name);
  const stat = lstatSync(full, { throwIfNoEntry: false });
  if (!stat) return;
  const parent = entry(root, plan.documentCas.area, plan.pairedTree.afterPath);
  if (!parent?.stat.isDirectory() || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.uid !== process.getuid!() || stat.mode & 0o7002 || stat.size > limits.fileBytes)
    fail("RECOVERY_CONFLICT", "Legacy resource staging is not an exact owned intent file.");
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let digest: string;
  try {
    const opened = fstatSync(fd), buffer = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const size = readSync(fd, buffer, used, buffer.length - used, used);
      if (!size) break;
      used += size;
    }
    const bytes = buffer.subarray(0, used), after = fstatSync(fd), named = lstatSync(full);
    digest = sha256(bytes);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
      || after.ctimeMs !== stat.ctimeMs || after.nlink !== stat.nlink || named.nlink !== stat.nlink
      || named.dev !== stat.dev || named.ino !== stat.ino || used !== stat.size
      || !plan.legacyAssets!.copies.some(copy => copy.size === bytes.length && copy.sha256 === digest))
      fail("RECOVERY_CONFLICT", "Legacy resource staging differs from its exact pinned bytes.");
  } finally { closeSync(fd); }
  return { name, sha256: digest, size: stat.size };
}
function sameTreeEntry(left: TreeEntry, right: TreeEntry | undefined) {
  return !!right && left.path === right.path && left.kind === right.kind
    && (left.kind === "directory" || right.kind === "file" && left.size === right.size && left.sha256 === right.sha256);
}
function legacyPhase(root: string, plan: DocumentLifecyclePlan, recovering: boolean) {
  const cas = plan.documentCas, doc = plan.result.document, paired = plan.pairedTree, legacy = plan.legacyAssets!;
  assertPublicMove(root, cas.area, cas.path, doc.afterPath);
  const assetStage = legacyAssetStage(root, plan), docStage = stagingGuard(root, plan);
  const beforeTree = tree(root, cas.area, paired.beforePath), afterTree = tree(root, cas.area, paired.afterPath, undefined, assetStage?.name);
  for (const [path, inspected] of [[paired.beforePath, beforeTree], [paired.afterPath, afterTree]] as const) {
    const directory = entry(root, cas.area, path);
    if (directory && (directory.stat.uid !== process.getuid!() || directory.stat.mode & 0o7002))
      fail("RECOVERY_CONFLICT", "Legacy paired directories changed their safe owner or mode.");
    for (const item of inspected.entries) {
      const stat = entry(root, cas.area, `${path}/${item.path}`)?.stat;
      if (!stat || item.kind === "file" && (!stat.isFile() || stat.nlink !== 1)
        || item.kind === "directory" && !stat.isDirectory() || stat.uid !== process.getuid!() || stat.mode & 0o7002)
        fail("RECOVERY_CONFLICT", "Legacy migration cannot adopt linked, foreign or unsafe paired resources.");
    }
  }
  const source = observed(root, cas.area, cas.path), destination = observed(root, cas.area, doc.afterPath);
  const entries = new Map(afterTree.entries.map(item => [item.path, item]));
  const expected = new Map(legacy.finalEntries.map(item => [item.path, item]));
  let assetsMoved = false;
  if (paired.digest === null) {
    if (beforeTree.digest !== null) fail("RECOVERY_CONFLICT", "Unplanned source paired assets appeared during legacy migration.");
    assetsMoved = afterTree.digest !== null;
  } else if (beforeTree.digest === paired.digest && afterTree.digest === null) {
    assetsMoved = false;
  } else if (beforeTree.digest === null && afterTree.digest !== null) {
    assetsMoved = true;
  } else fail("RECOVERY_CONFLICT", "Legacy migration lost its exact initial paired-tree state.");
  if (assetsMoved) {
    for (const item of afterTree.entries)
      if (!sameTreeEntry(item, expected.get(item.path)))
        fail("RECOVERY_CONFLICT", "Legacy destination tree contains unknown or changed bytes.");
    for (const item of paired.entries)
      if (!sameTreeEntry(item, entries.get(item.path)))
        fail("RECOVERY_CONFLICT", "Legacy migration lost a previously owned paired resource.");
  }
  const complete = afterTree.digest === legacy.finalDigest, sourceRemoved = source === null;
  if (source !== cas.sha256 && source !== null || destination !== doc.afterSha256 && destination !== null
    || destination !== null && !complete || sourceRemoved && destination !== doc.afterSha256)
    fail("RECOVERY_CONFLICT", "Legacy documents do not match an exact ordered migration phase.");
  if (assetStage && (destination !== null || !legacy.copies.some(copy => !entries.has(copy.target)
    && copy.sha256 === assetStage.sha256 && copy.size === assetStage.size)))
    fail("RECOVERY_CONFLICT", "Legacy resource staging cannot belong to this publication phase.");
  if (docStage && (!complete || destination !== null)) fail("RECOVERY_CONFLICT", "Legacy owner staging has an unknown phase.");
  let sourcesToRemoveRemaining = 0;
  for (const copy of legacy.copies) {
    if (knowledgeReadPrivateTopLevels(root, cas.area).has(copy.source.split("/")[0]!) && copy.visibility !== "private")
      fail("ACCESS_DENIED", "Legacy migration cannot publish private resource sources.");
    const found = entry(root, cas.area, copy.source);
    if (found) {
      assertPinnedLegacyAsset(root, cas.area, copy);
      if (legacyAssetDisposition(copy) === "remove") sourcesToRemoveRemaining++;
    } else if (legacyAssetDisposition(copy) === "retain")
      fail("RECOVERY_CONFLICT", "A retained legacy source must remain present with its exact pinned identity and bytes.");
    else if (!sourceRemoved || destination !== doc.afterSha256 || !complete)
      fail("RECOVERY_CONFLICT", "A legacy source disappeared before its exact after image was durable.");
  }
  const scanned = scan(root, docStage);
  const normalized = scanned.pins.filter(pin => !(pin.area === cas.area && (pin.path === cas.path || pin.path === doc.afterPath)));
  normalized.push({ area: cas.area, path: cas.path, sha256: cas.sha256 });
  const byAddress = (a: ReferencePin, b: ReferencePin) => `${a.area}/${a.path}`.localeCompare(`${b.area}/${b.path}`);
  if (JSON.stringify(normalized.sort(byAddress)) !== JSON.stringify([...plan.referencePins].sort(byAddress)))
    fail("RECOVERY_CONFLICT", "Complete legacy reference closure changed outside its durable move intent.");
  const others = scanned.documents.filter(document => document.record.area !== cas.area
    || document.record.path !== cas.path && document.record.path !== doc.afterPath);
  if (others.some(document => stableIdentity(document) === cas.id || document.metadata.get("knowledgeId") === cas.id))
    fail("RECOVERY_CONFLICT", "Legacy owner identity was claimed outside its exact move intent.");
  sharedGuard(root, others, cas.area, cas.path, doc.afterPath);
  assertLegacyAssetDispositions(root, cas.area, cas.path, legacy.copies, others);
  const initial = source === cas.sha256 && destination === null && !assetsMoved && !assetStage && !docStage;
  const current = sourceRemoved && sourcesToRemoveRemaining === 0 ? 3 : initial ? 0 : destination === null ? 1 : 2;
  if (!recovering && current !== 0) fail("RECOVERY_CONFLICT", "Legacy migration is already partial; use its durable intent recovery.");
  return { current, assetsMoved, sourceRemoved, entries, destination };
}
function phase(root: string, plan: DocumentLifecyclePlan, recovering: boolean) {
  if (plan.legacyAssets) return legacyPhase(root, plan, recovering).current;
  const cas = plan.documentCas, doc = plan.result.document, paired = plan.pairedTree;
  assertPublicMove(root, cas.area, cas.path, doc.afterPath);
  const source = observed(root, cas.area, cas.path), destination = observed(root, cas.area, doc.afterPath);
  const sourceTree = tree(root, cas.area, paired.beforePath, plan.boardIdentity), destinationTree = tree(root, cas.area, paired.afterPath, plan.boardIdentity);
  let assetsMoved = false;
  if (paired.digest === null) {
    if (sourceTree.digest !== null || destinationTree.digest !== null) fail("RECOVERY_CONFLICT", "Unplanned paired assets appeared.");
  } else if (sourceTree.digest === paired.digest && destinationTree.digest === null) {
    assetsMoved = false;
  } else if (sourceTree.digest === null && destinationTree.digest === paired.digest) {
    assetsMoved = true;
  } else fail("RECOVERY_CONFLICT", "Move paired trees do not match an exact before/after state.");
  let current: number;
  if (source === cas.sha256 && destination === null) current = assetsMoved ? 1 : 0;
  else if (destination === doc.afterSha256 && (paired.digest === null || assetsMoved) && (source === cas.sha256 || source === null)) current = source === null ? 3 : 2;
  else fail("RECOVERY_CONFLICT", "Move documents do not match an exact ordered crash phase.");
  if (!recovering && current !== 0) fail("RECOVERY_CONFLICT", "Move is already partially applied; use durable intent recovery.");
  const staging = stagingGuard(root, plan);
  if (staging && (!recovering || current >= 2)) fail("RECOVERY_CONFLICT", "Unexpected move staging phase.");
  const scanned = scan(root, staging);
  const normalized = scanned.pins.filter(pin => !(pin.area === cas.area && (pin.path === cas.path || pin.path === doc.afterPath)));
  normalized.push({ area: cas.area, path: cas.path, sha256: cas.sha256 });
  const byAddress = (a: ReferencePin, b: ReferencePin) => `${a.area}/${a.path}`.localeCompare(`${b.area}/${b.path}`);
  if (JSON.stringify(normalized.sort(byAddress)) !== JSON.stringify([...plan.referencePins].sort(byAddress))) fail("RECOVERY_CONFLICT", "Move reference scan changed outside the intent; no replay is safe.");
  const identities = scanned.documents.filter(document => document.record.area !== cas.area || (document.record.path !== cas.path && document.record.path !== doc.afterPath));
  if (identities.some(document => stableIdentity(document) === cas.id || document.metadata.get("knowledgeId") === cas.id)) fail("RECOVERY_CONFLICT", "Move identity was claimed outside its intent.");
  sharedGuard(root, identities, cas.area, cas.path, doc.afterPath);
  ownerReferences(root, decodeMarkdown(cas.id, text(plan.changes[1]!.before!), cas.path, cas.area));
  return current;
}
function finishLegacy(root: string, plan: DocumentLifecyclePlan, operationId: string, recovering: boolean) {
  let effects = false;
  try {
    const cas = plan.documentCas, legacy = plan.legacyAssets!, paired = plan.pairedTree, addition = plan.changes[0]!;
    let state = legacyPhase(root, plan, recovering);
    const privateScope = () => {
      if (legacy.copies.some(copy => copy.visibility === "private"))
        assertPrivateOperationPublicationScope(root, operationId, plan.actorId, legacy.copies
          .filter(copy => copy.visibility === "private" && !state.entries.has(copy.target)).map(copy => copy.publication!));
    };
    privateScope();
    if (!state.assetsMoved && paired.digest !== null) {
      const source = checkedResourcePath(root, paired.beforePath, false, cas.area);
      effects = true;
      const destination = checkedResourcePath(root, paired.afterPath, true, cas.area);
      legacyPhase(root, plan, true);
      renameNoReplaceSync(source, destination);
      syncDirectory(dirname(source)); syncDirectory(dirname(destination));
      state = legacyPhase(root, plan, true);
    }
    for (const copy of legacy.copies) {
      if (state.entries.has(copy.target)) continue;
      privateScope();
      const attempt = copy.visibility === "private" ? beginPrivateResourcePublication(root, operationId, plan.actorId, copy.publication!) : undefined;
      const bytes = attempt ? readPrivateLegacyAssetForPublication(root, cas.area, copy, attempt) : readPinnedLegacyAsset(root, cas.area, copy);
      effects = true;
      const destination = checkedResourcePath(root, `${paired.afterPath}/${copy.target}`, true, cas.area);
      legacyPhase(root, plan, true);
      atomicFileCreateNoReplace(destination, bytes, operationId, attempt ? () => {
        assertPrivateResourcePublicationAttempt(attempt);
        legacyPhase(root, plan, true);
        assertPrivateResourcePublicationAttempt(attempt);
      } : undefined);
      state = legacyPhase(root, plan, true);
    }
    if (state.destination === null) {
      privateScope();
      effects = true;
      const destination = checkedDocumentPath(root, addition.path, true, cas.area);
      legacyPhase(root, plan, true);
      atomicFileCreateNoReplace(destination, addition.after!, operationId);
      state = legacyPhase(root, plan, true);
    }
    if (!state.sourceRemoved) {
      privateScope();
      const source = checkedDocumentPath(root, cas.path, false, cas.area);
      legacyPhase(root, plan, true);
      effects = true; unlinkSync(source); syncDirectory(dirname(source));
    }
    for (const copy of legacy.copies) {
      privateScope();
      if (legacyAssetDisposition(copy) === "retain") continue;
      if (!entry(root, cas.area, copy.source)) continue;
      readPinnedLegacyAsset(root, cas.area, copy); legacyPhase(root, plan, true);
      const source = checkedResourcePath(root, copy.source, false, cas.area);
      effects = true; unlinkSync(source); syncDirectory(dirname(source));
    }
    if (legacyPhase(root, plan, true).current !== 3) fail("RECOVERY_CONFLICT", "Legacy migration did not reach its exact final state.");
    return plan.result;
  } catch (error) {
    if (error instanceof CoreError) throw new CoreError(error.code, error.message, effects || recovering ? "unknown" : error.effect);
    if (error instanceof RenameNoReplaceError)
      throw new CoreError(error.code === "UNAVAILABLE" ? "UNSUPPORTED_OPERATION" : "RECOVERY_CONFLICT", error.message, effects || recovering ? "unknown" : "not-committed");
    throw new CoreError("RECOVERY_CONFLICT", "Legacy move application interrupted; preserve its durable intent for reconciliation.", "unknown");
  }
}
function finish(root: string, plan: DocumentLifecyclePlan, operationId: string, recovering: boolean, updatedSource?: Buffer): DocumentLifecycleResult {
  let effects = false;
  try {
    validatePlan(plan, updatedSource);
    if (operationId !== plan.operationId) fail("INVALID_WORKSPACE", "Move recovery operationId does not match the durable intent.");
    root = checkedRoot(root);
    if (plan.legacyAssets) return finishLegacy(root, plan, operationId, recovering);
    let current = phase(root, plan, recovering);
    const cas = plan.documentCas, addition = plan.changes[0]!, paired = plan.pairedTree;
    if (current === 0 && paired.digest !== null) {
      const source = checkedResourcePath(root, paired.beforePath, false, cas.area);
      effects = true;
      const destination = checkedResourcePath(root, paired.afterPath, true, cas.area);
      if (phase(root, plan, true) !== 0) fail("RECOVERY_CONFLICT", "Move changed while preparing paired-tree destination.");
      effects = true;
      renameNoReplaceSync(source, destination);
      syncDirectory(dirname(source)); syncDirectory(dirname(destination));
      current = phase(root, plan, true);
    }
    if (current < 2) {
      effects = true;
      const destination = checkedDocumentPath(root, addition.path, true, cas.area);
      phase(root, plan, true);
      effects = true;
      atomicFileCreateNoReplace(destination, addition.after!, operationId);
      current = phase(root, plan, true);
    }
    if (current === 2) {
      const source = checkedDocumentPath(root, cas.path, false, cas.area);
      if (phase(root, plan, true) !== 2) fail("RECOVERY_CONFLICT", "Move source changed before removal.");
      effects = true;
      unlinkSync(source); syncDirectory(dirname(source));
    }
    if (phase(root, plan, true) !== 3) fail("RECOVERY_CONFLICT", "Move failed to reach its exact after state.");
    return plan.result;
  } catch (error) {
    if (error instanceof CoreError) throw new CoreError(error.code, error.message, effects || recovering ? "unknown" : error.effect);
    if (error instanceof RenameNoReplaceError) {
      throw new CoreError(error.code === "UNAVAILABLE" ? "UNSUPPORTED_OPERATION" : "RECOVERY_CONFLICT",
        error.message, effects || recovering ? "unknown" : "not-committed");
    }
    throw new CoreError("RECOVERY_CONFLICT", "Move application interrupted; preserve the durable intent for reconciliation.", "unknown");
  }
}
/** Persist this exact intent in shared SQLite and acquire its writer lock BEFORE calling.
 * Commit result receipt, stable-identity/path reindex and intent completion together AFTER success.
 * No-replace publication protects move targets; uncooperative external writers can still
 * race source-byte checks and final source unlink. */
export function applyDocumentLifecycle(root: string, plan: DocumentLifecyclePlan, operationId: string): DocumentLifecycleResult {
  if (plan.boardIdentity) fail("ACCESS_DENIED", "Board move requires its dedicated authorized journal.");
  if (plan.promoteIdentity) fail("INVALID_ARGUMENT", "Identity promotion requires a journaled canonical Knowledge update.");
  return finish(root, plan, operationId, false);
}
/** Recover pending intents before normal indexing. Only exact ordered before/after phases are accepted. */
export function recoverDocumentLifecycle(root: string, plan: DocumentLifecyclePlan, operationId: string): DocumentLifecycleResult {
  if (plan.boardIdentity) fail("ACCESS_DENIED", "Board move requires its dedicated authorized journal.");
  if (plan.promoteIdentity) fail("INVALID_ARGUMENT", "Identity promotion requires a journaled canonical Knowledge update.");
  return finish(root, plan, operationId, true);
}
/** Caller validates and journals the exact canonical content update together with this
 * unchanged baseline move. Never composes two independently committed operations. */
export function applyDocumentLifecycleUpdate(root: string, baseline: DocumentLifecyclePlan, updatedSource: Buffer,
  operationId: string, recovering = false): DocumentLifecycleResult {
  validatePlan(baseline);
  const after = documentLifecycleUpdatedBytes(root, baseline, updatedSource);
  const plan: DocumentLifecyclePlan = {
    ...baseline,
    changes: baseline.changes.map((change, index) => index ? change : { ...change, after, afterSha256: sha256(after) }),
    result: { ...baseline.result, document: { ...baseline.result.document, afterSha256: sha256(after) },
      referenceRewriteRequired: !baseline.changes[1]!.before!.equals(after) },
  };
  const before = decodeMarkdown(baseline.documentCas.id, text(baseline.changes[1]!.before!),
    baseline.documentCas.path, baseline.documentCas.area);
  const updated = decodeMarkdown(baseline.documentCas.id, text(updatedSource),
    baseline.documentCas.path, baseline.documentCas.area);
  if (before.record.id !== updated.record.id
    || before.metadata.has("knowledgeId") && before.metadata.get("knowledgeId") !== updated.metadata.get("knowledgeId")
    || stableIdentity(updated) !== baseline.documentCas.id
    || updated.record.revision !== before.record.revision + 1)
    fail("INVALID_WORKSPACE", "Combined Knowledge move must preserve identity and increment revision once.");
  return finish(root, plan, operationId, recovering, updatedSource);
}
export function inspectDocumentLifecycleUpdate(root: string, baseline: DocumentLifecyclePlan, updatedSource: Buffer): number {
  validatePlan(baseline);
  const after = documentLifecycleUpdatedBytes(root, baseline, updatedSource);
  const plan = { ...baseline,
    changes: baseline.changes.map((change, index) => index ? change : { ...change, after, afterSha256: sha256(after) }),
    result: { ...baseline.result, document: { ...baseline.result.document, afterSha256: sha256(after) },
      referenceRewriteRequired: !baseline.changes[1]!.before!.equals(after) } };
  validatePlan(plan, updatedSource);
  return phase(root, plan, true);
}
export function readDocumentLifecycleUpdateSources(root: string, baseline: DocumentLifecyclePlan, updatedSource: Buffer): MarkdownRecord[] {
  inspectDocumentLifecycleUpdate(root, baseline, updatedSource);
  const after = documentLifecycleUpdatedBytes(root, baseline, updatedSource);
  const plan = { ...baseline,
    changes: baseline.changes.map((change, index) => index ? change : { ...change, after, afterSha256: sha256(after) }),
    result: { ...baseline.result, document: { ...baseline.result.document, afterSha256: sha256(after) },
      referenceRewriteRequired: !baseline.changes[1]!.before!.equals(after) } };
  return scan(root, stagingGuard(root, plan)).publicDocuments;
}
export function documentLifecyclePrivatePublicationRequirements(root: string, baseline: DocumentLifecyclePlan,
  updatedSource: Buffer): PrivateResourcePublicationProvenance[] {
  inspectDocumentLifecycleUpdate(root, baseline, updatedSource);
  const after = documentLifecycleUpdatedBytes(root, baseline, updatedSource);
  const plan = { ...baseline, changes: baseline.changes.map((change, index) => index ? change : { ...change, after, afterSha256: sha256(after) }),
    result: { ...baseline.result, document: { ...baseline.result.document, afterSha256: sha256(after) },
      referenceRewriteRequired: !baseline.changes[1]!.before!.equals(after) } };
  const state = legacyPhase(root, plan, true);
  return baseline.legacyAssets!.copies.filter(copy => copy.visibility === "private" && !state.entries.has(copy.target)).map(copy => copy.publication!);
}
