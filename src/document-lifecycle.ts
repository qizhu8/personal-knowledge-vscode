import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { CoreError, type StorageRequest } from "./contracts.js";
import { checkedDocumentPath, checkedResourcePath, documentPath, knowledgeArea, resourcePath, type KnowledgeArea } from "./document-path.js";
import { documentLifecycleDefinitions, documentLifecycleLimits as limits, type DocumentLifecycleOperation, type DocumentLifecyclePreview, type DocumentLifecycleResult } from "./document-lifecycle-contracts.js";
import { isMarkdownAssetDirectory, localAssetReference, markdownAssetDirectory, markdownReferences } from "./domain/markdown-assets.js";
import { rebaseMarkdownAssets } from "./domain/document-lifecycle-original.js";
import { atomicFileCreateNoReplace, sha256 } from "./file-write.js";
import { decodeMarkdown, type MarkdownRecord } from "./markdown.js";
import { RenameNoReplaceError, renameNoReplaceSync } from "./rename-no-replace.js";

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
function scan(root: string, staging?: string) {
  const documents: MarkdownRecord[] = [];
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
        documents.push(decodeMarkdown("lifecycle-scan", text(content), address, area));
      }
    }
  }
  for (const area of knowledgeArea.options) {
    try { lstatSync(join(root, area)); } catch (error) { if (missing(error)) continue; throw error; }
    walk(area, "", 0);
  }
  const pins: ReferencePin[] = documents.map(({ record }) => ({ area: record.area, path: record.path, sha256: record.sha256 }));
  return { documents, pins, revision: sha256(JSON.stringify(pins)), bytes };
}
function treeDigest(entries: TreeEntry[]) {
  return sha256(JSON.stringify(entries.map(item => item.kind === "file"
    ? [item.path, item.kind, item.size, item.sha256] : [item.path, item.kind])));
}
function tree(root: string, area: KnowledgeArea, path: string, boardIdentity?: string) {
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
function ownerReferences(root: string, document: MarkdownRecord) {
  const areaRoot = resolve(root, document.record.area);
  for (const { value } of markdownReferences(document.raw)) {
    const local = localAssetReference(value);
    if (!local) continue;
    const path = relative(areaRoot, resolve(areaRoot, dirname(document.record.path), local)).replaceAll("\\", "/");
    if (path === ".." || path.startsWith("../")) fail("INVALID_DOCUMENT", "Owner reference escapes its content root.");
    if (path.split("/").includes("_assets")) fail("UNSUPPORTED_OPERATION", "Legacy _assets references require the original explicit asset migration before moving.");
    if (path.split("/").some(isMarkdownAssetDirectory)) entry(root, document.record.area, path);
  }
}
function prepare(root: string, documents: MarkdownRecord[], args: z.infer<typeof documentLifecycleDefinitions[0]["input"]>, promoteIdentity = false, boardIdentity?: string) {
  root = checkedRoot(root);
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
  if (JSON.stringify([...suppliedPins].sort((a, b) => key(a).localeCompare(key(b)))) !== JSON.stringify([...scanned.pins].sort((a, b) => key(a).localeCompare(key(b))))) fail("CONFLICT", "Move requires a complete current three-area Markdown snapshot.");
  if (!((promoteIdentity || boardIdentity) && stableIdentity(document) === undefined)
    && scanned.documents.filter(other => stableIdentity(other) === supplied.id || other.metadata.get("knowledgeId") === supplied.id).length !== 1)
    fail("CONFLICT", "Move stable identity is ambiguous.");
  const beforePath = markdownAssetDirectory(args.path), afterPath = markdownAssetDirectory(args.destinationPath);
  if (entry(root, args.area, args.destinationPath) || entry(root, args.area, afterPath)) fail("CONFLICT", "Move document and paired-tree destinations must both be absent.");
  const paired = tree(root, args.area, beforePath, boardIdentity);
  sharedGuard(root, scanned.documents, args.area, args.path, args.destinationPath);
  ownerReferences(root, document);
  const after = Buffer.from(rebaseMarkdownAssets(join(root, args.area), args.path, args.destinationPath, document.raw));
  if (after.length > limits.markdownBytes) fail("INVALID_DOCUMENT", "Rebased Markdown exceeds the supported byte range.");
  const moved = decodeMarkdown(supplied.id, text(after), args.destinationPath, args.area);
  editable(moved, promoteIdentity, boardIdentity);
  const preview = documentLifecycleDefinitions[0].output.parse({
    document: { id: supplied.id, area: args.area, beforePath: args.path, afterPath: args.destinationPath, revision: args.expectedRevision, beforeSha256: args.expectedSha256, afterSha256: sha256(after) },
    pairedAssets: { beforePath, afterPath, digest: paired.digest, files: paired.files, bytes: paired.bytes },
    scanRevision: scanned.revision, scannedDocuments: scanned.pins.length, scannedBytes: scanned.bytes,
    destinationAbsent: true, referenceRewriteRequired: !after.equals(before),
  });
  return { before, after, preview, paired, pins: scanned.pins };
}
export function readDocumentLifecycle(root: string, documents: MarkdownRecord[], request: DocumentLifecycleRequest, promoteIdentity = false): DocumentLifecyclePreview {
  return guarded(() => {
    if (request.operation !== "knowledge.document.lifecycle.preview") fail("NOT_FOUND", "Unknown document lifecycle read operation.");
    return prepare(root, documents, parse(documentLifecycleDefinitions[0].input, request.args), promoteIdentity).preview;
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
    const prepared = prepare(root, documents, previewArgs, promoteIdentity, boardIdentity);
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
  const rebased = rebaseMarkdownAssets(virtualRoot, cas.path, doc.afterPath, updatedSource ? text(updatedSource) : before.raw);
  if (!Buffer.from(rebased).equals(addition.after) || result.referenceRewriteRequired !== !removal.before.equals(addition.after)) fail("INVALID_WORKSPACE", "Move intent is not the exact original owner-reference rebase.");
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
function phase(root: string, plan: DocumentLifecyclePlan, recovering: boolean) {
  const cas = plan.documentCas, doc = plan.result.document, paired = plan.pairedTree;
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
function finish(root: string, plan: DocumentLifecyclePlan, operationId: string, recovering: boolean, updatedSource?: Buffer): DocumentLifecycleResult {
  let effects = false;
  try {
    validatePlan(plan, updatedSource);
    if (operationId !== plan.operationId) fail("INVALID_WORKSPACE", "Move recovery operationId does not match the durable intent.");
    root = checkedRoot(root);
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
  const after = Buffer.from(rebaseMarkdownAssets(join(root, baseline.documentCas.area),
    baseline.documentCas.path, baseline.result.document.afterPath, text(updatedSource)));
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
  const after = Buffer.from(rebaseMarkdownAssets(join(root, baseline.documentCas.area),
    baseline.documentCas.path, baseline.result.document.afterPath, text(updatedSource)));
  const plan = { ...baseline,
    changes: baseline.changes.map((change, index) => index ? change : { ...change, after, afterSha256: sha256(after) }),
    result: { ...baseline.result, document: { ...baseline.result.document, afterSha256: sha256(after) },
      referenceRewriteRequired: !baseline.changes[1]!.before!.equals(after) } };
  validatePlan(plan, updatedSource);
  return phase(root, plan, true);
}
export function readDocumentLifecycleUpdateSources(root: string, baseline: DocumentLifecyclePlan, updatedSource: Buffer): MarkdownRecord[] {
  inspectDocumentLifecycleUpdate(root, baseline, updatedSource);
  const after = Buffer.from(rebaseMarkdownAssets(join(root, baseline.documentCas.area),
    baseline.documentCas.path, baseline.result.document.afterPath, text(updatedSource)));
  const plan = { ...baseline,
    changes: baseline.changes.map((change, index) => index ? change : { ...change, after, afterSha256: sha256(after) }),
    result: { ...baseline.result, document: { ...baseline.result.document, afterSha256: sha256(after) },
      referenceRewriteRequired: !baseline.changes[1]!.before!.equals(after) } };
  return scan(root, stagingGuard(root, plan)).documents;
}
