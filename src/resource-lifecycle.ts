import {
  resourceLifecycleDefinitions, resourceLifecycleLimits,
  type ResourceLifecycleOperation, type ResourceLifecycleResult, type ResourceLifecyclePreview,
} from "./resource-lifecycle-contracts.js";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { CoreError, type StorageRequest } from "./contracts.js";
import { checkedResourcePath, documentPath, knowledgeArea, resourcePath, type KnowledgeArea } from "./document-path.js";
import { isMarkdownAssetDirectory, localAssetReference, markdownAssetDirectory, markdownReferences } from "./domain/markdown-assets.js";
import { resourceLifecycleIsReferenced, resourceLifecycleRenameMarkdown } from "./domain/resource-lifecycle-original.js";
import { atomicFileCreateNoReplace, atomicFileWrite, sha256 } from "./file-write.js";
import { decodeMarkdown, type MarkdownRecord } from "./markdown.js";

export { resourceLifecycleDefinitions, resourceLifecycleLimits } from "./resource-lifecycle-contracts.js";
export type { ResourceLifecycleOperation, ResourceLifecycleResult, ResourceLifecyclePreview } from "./resource-lifecycle-contracts.js";
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const documentId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const name = resourcePath.max(200).regex(/^[^/]+$/);
const previewInput = resourceLifecycleDefinitions[0].input;
const previewSchema = resourceLifecycleDefinitions[0].output;
const resultSchema = resourceLifecycleDefinitions[1].output;
export type ResourceLifecycleRequest = Omit<StorageRequest, "operation"> & {
  operation: StorageRequest["operation"] | ResourceLifecycleOperation;
};
export interface ResourceLifecycleFileChange {
  area: KnowledgeArea;
  path: string;
  expectedSha256: string | null;
  afterSha256: string | null;
  before: Buffer | null;
  after: Buffer | null;
}
export interface ResourceLifecyclePlan {
  kind: "resource-lifecycle";
  operationId: string;
  actorId: string;
  expectedScanRevision: string;
  documentCas: { id: string; area: KnowledgeArea; path: string; revision: number; sha256: string };
  changes: ResourceLifecycleFileChange[];
  requiresCompoundJournal: boolean;
  result: ResourceLifecycleResult;
}
function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function fail(code: string, message: string): never { throw new CoreError(code, message); }

function rootDirectory(root: string) {
  const full = resolve(root);
  const ancestors: string[] = [];
  let current = full;
  while (true) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const directory of ancestors.reverse()) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_DOCUMENT", "Resource root ancestors must be real directories.");
  }
  return full;
}
function checkedEntry(root: string, area: KnowledgeArea, path: string) {
  if (!resourcePath.safeParse(path).success) fail("INVALID_DOCUMENT", "Unsafe relative resource/reference path.");
  let full = root;
  for (const part of [area, ...path.split("/")]) {
    const parent = lstatSync(full);
    if (!parent.isDirectory() || parent.isSymbolicLink()) fail("INVALID_DOCUMENT", "Resource parents must be real directories.");
    full = join(full, part);
    let stat;
    try { stat = lstatSync(full); } catch (error) { if (missing(error)) return undefined; throw error; }
    if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) fail("INVALID_DOCUMENT", "Resource/reference entries must be regular files or directories, not links.");
  }
  return { full, stat: lstatSync(full) };
}
function boundedBytes(root: string, area: KnowledgeArea, path: string, limit: number) {
  const entry = checkedEntry(root, area, path);
  if (!entry) fail("NOT_FOUND", "Pinned file is missing.");
  if (!entry.stat.isFile() || entry.stat.size > limit) fail("INVALID_DOCUMENT", "Pinned file is not regular or exceeds its byte limit.");
  const fd = openSync(entry.full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit || stat.dev !== entry.stat.dev || stat.ino !== entry.stat.ino) fail("CONFLICT", "Pinned file changed during open.");
    // Read at most limit+1 bytes even when an external writer grows the file.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let used = 0;
    // readFileSync(fd) would allocate unbounded memory for concurrently growing files.
    while (used < bytes.length) {
      const read = readSync(fd, bytes, used, bytes.length - used, used);
      if (!read) break;
      used += read;
    }
    const after = checkedEntry(root, area, path);
    const observed = fstatSync(fd);
    if (used > limit || used !== stat.size || observed.size !== stat.size || observed.mtimeMs !== stat.mtimeMs
      || !after || after.stat.dev !== stat.dev || after.stat.ino !== stat.ino) fail("CONFLICT", "Pinned file changed during bounded read.");
    return bytes.subarray(0, used);
  } finally { closeSync(fd); }
}

interface ScannedDocument { area: KnowledgeArea; path: string; raw: string; sha256: string }
function referenceScan(root: string, documents?: MarkdownRecord[]) {
  let entries = 0, bytes = 0;
  const scanned: ScannedDocument[] = [];
  function walk(area: KnowledgeArea, directory: string, prefix: string, depth: number) {
    if (depth > resourceLifecycleLimits.depth) fail("INVALID_WORKSPACE", "Resource reference scan exceeds 32 directory levels.");
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_DOCUMENT", "Reference scan directories must not be links.");
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (++entries > resourceLifecycleLimits.entries) fail("INVALID_WORKSPACE", "Resource reference scan exceeds 8192 entries.");
      if (item.name.startsWith(".")) continue;
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      const entry = checkedEntry(root, area, path);
      if (!entry) fail("CONFLICT", "Reference scan entry disappeared.");
      if (entry.stat.isDirectory()) {
        if (!isMarkdownAssetDirectory(item.name)) walk(area, entry.full, path, depth + 1);
      } else if (/\.md$/i.test(item.name)) {
        if (!documentPath.safeParse(path).success) fail("INVALID_DOCUMENT", "Reference scan found an unsupported Markdown address.");
        if (scanned.length >= resourceLifecycleLimits.documents) fail("INVALID_WORKSPACE", "Resource reference scan exceeds 2048 documents.");
        if (entry.stat.size > resourceLifecycleLimits.markdownBytes || bytes + entry.stat.size > resourceLifecycleLimits.scanBytes) fail("INVALID_WORKSPACE", "Reference scan byte count exceeds the supported numeric range.");
        const content = boundedBytes(root, area, path, resourceLifecycleLimits.markdownBytes);
        bytes += content.length;
        if (bytes > resourceLifecycleLimits.scanBytes) fail("INVALID_WORKSPACE", "Reference scan exceeds 16 MiB total.");
        const raw = content.toString("utf8");
        if (!Buffer.from(raw).equals(content)) fail("INVALID_DOCUMENT", "Reference scan Markdown must be valid UTF-8.");
        scanned.push({ area, path, raw, sha256: sha256(content) });
      }
    }
  }
  for (const area of knowledgeArea.options) {
    const directory = join(root, area);
    try { lstatSync(directory); } catch (error) { if (missing(error)) continue; throw error; }
    walk(area, directory, "", 0);
  }
  if (documents && documents.length !== scanned.length) fail("CONFLICT", "Document snapshot is incomplete; refresh all three areas.");
  const addresses = new Set<string>();
  for (const document of documents ?? []) {
    const address = `${document.record.area}/${document.record.path}`;
    if (addresses.has(address)) fail("CONFLICT", "Document snapshot has duplicate addresses.");
    addresses.add(address);
    const observed = scanned.find(item => item.area === document.record.area && item.path === document.record.path);
    if (!observed || observed.sha256 !== document.record.sha256 || sha256(document.raw) !== observed.sha256) fail("CONFLICT", "Document snapshot changed; refresh all three areas.");
  }

  return { scanned, bytes, revision: sha256(JSON.stringify(scanned.map(item => [item.area, item.path, item.sha256]))) };
}

const encodedBytes = z.string().max(22_369_624).nullable();
  const serializedPlanSchema = z.strictObject({
    kind: z.literal("resource-lifecycle"), operationId: z.string().uuid(), actorId: z.string().min(1).max(500),
    expectedScanRevision: digest,
    documentCas: z.strictObject({ id: documentId, area: knowledgeArea, path: documentPath, revision: count.min(1), sha256: digest }),
    changes: z.array(z.strictObject({
      area: knowledgeArea, path: resourcePath, expectedSha256: digest.nullable(), afterSha256: digest.nullable(),
      before: encodedBytes, after: encodedBytes,
    })).min(1).max(3),
    requiresCompoundJournal: z.boolean(), result: resultSchema,
  });
  function validatePlan(plan: ResourceLifecyclePlan) {
    const cas = plan.documentCas, result = plan.result, source = result.before;
    const destination = result.after;
    if (plan.operationId !== result.operationId || plan.expectedScanRevision !== result.scanRevision
      || cas.id !== result.document.id || cas.area !== result.document.area || cas.path !== result.document.path
      || cas.revision !== result.document.revision || cas.sha256 !== result.document.beforeSha256
      || source.area !== cas.area || !source.path.startsWith(markdownAssetDirectory(cas.path) + "/")
      || basename(source.path).toLowerCase() === "pkm-todo-board.json"
      || cas.path.split("/").some(part => part.toLowerCase() === "system" || isMarkdownAssetDirectory(part))
      || plan.requiresCompoundJournal !== result.markdownRewritten
      || (result.action === "rename") !== (destination !== null)) fail("INVALID_WORKSPACE", "Resource intent identity/ownership is inconsistent.");
    if (destination && (destination.area !== source.area || dirname(destination.path) !== dirname(source.path)
      || !name.safeParse(basename(destination.path)).success || destination.path === source.path
      || basename(destination.path).toLowerCase() === "pkm-todo-board.json"
      || destination.digest !== source.digest || destination.size !== source.size)) fail("INVALID_WORKSPACE", "Resource rename intent is inconsistent.");
    const expectedCount = 1 + (destination ? 1 : 0) + (result.markdownRewritten ? 1 : 0);
    if (plan.changes.length !== expectedCount || (result.markdownRewritten && !destination)) fail("INVALID_WORKSPACE", "Resource intent has unexpected writes.");
    for (const change of plan.changes) {
      const limit = change.path === cas.path ? resourceLifecycleLimits.markdownBytes : resourceLifecycleLimits.resourceBytes;
      for (const [bytes, expected] of [[change.before, change.expectedSha256], [change.after, change.afterSha256]] as const) {
        if ((bytes === null) !== (expected === null) || (bytes && (bytes.length > limit || sha256(bytes) !== expected))) fail("INVALID_WORKSPACE", "Resource intent byte digest/limit mismatch.");
      }
      if (change.area !== cas.area) fail("INVALID_WORKSPACE", "Resource intent cannot cross areas.");
    }
    const removal = plan.changes[0]!;
    if (removal.path !== source.path || removal.expectedSha256 !== source.digest.slice(7)
      || removal.before?.length !== source.size || removal.after !== null) fail("INVALID_WORKSPACE", "Resource intent removal does not match its receipt.");
    if (destination) {
      const addition = plan.changes[1]!;
      if (addition.path !== destination.path || addition.before !== null || addition.afterSha256 !== removal.expectedSha256
        || !addition.after?.equals(removal.before!)) fail("INVALID_WORKSPACE", "Resource intent destination bytes do not match its source.");
    }
    if (result.markdownRewritten) {
      const change = plan.changes[2]!;
      if (change.path !== cas.path || change.expectedSha256 !== cas.sha256 || change.afterSha256 !== result.document.afterSha256
        || !change.before || !change.after) fail("INVALID_WORKSPACE", "Compound resource/Markdown intent is inconsistent.");
      const decoded = decodeMarkdown(cas.id, change.before.toString("utf8"), cas.path, cas.area);
      if (!Buffer.from(decoded.raw).equals(change.before) || decoded.record.revision !== cas.revision || decoded.record.deleted
        || decoded.metadata.get("documentKind") === "todo-board") fail("INVALID_WORKSPACE", "Compound intent has invalid owning Markdown.");
      const root = resolve("resource-lifecycle-intent");
      const rewritten = resourceLifecycleRenameMarkdown(decoded.raw, join(root, cas.path), join(root, source.path), join(root, destination!.path));
      if (!Buffer.from(rewritten).equals(change.after)) fail("INVALID_WORKSPACE", "Compound intent is not the original explicit reference rewrite.");
    } else if (result.document.afterSha256 !== cas.sha256) fail("INVALID_WORKSPACE", "Resource-only intent unexpectedly changes Markdown.");
    return plan;
  }
  export function serializeResourceLifecyclePlan(plan: ResourceLifecyclePlan): string {
    const serialized = serializedPlanSchema.parse({
      ...plan, changes: plan.changes.map(change => ({
        ...change, before: change.before?.toString("base64") ?? null, after: change.after?.toString("base64") ?? null,
      })),
    });
    validatePlan(plan);
    return JSON.stringify(serialized);
  }
  export function deserializeResourceLifecyclePlan(json: string): ResourceLifecyclePlan {
    return guarded(() => {
      if (typeof json !== "string" || Buffer.byteLength(json) > 48_000_000) fail("INVALID_WORKSPACE", "Resource intent JSON exceeds its bounded contract.");
      const serialized = serializedPlanSchema.parse(JSON.parse(json));
      function bytes(value: string | null) {
        if (value === null) return null;
        const content = Buffer.from(value, "base64");
        if (content.toString("base64") !== value) fail("INVALID_WORKSPACE", "Resource intent bytes must be canonical base64.");
        return content;
      }
      return validatePlan({
        ...serialized, changes: serialized.changes.map(change => ({ ...change, before: bytes(change.before), after: bytes(change.after) })),
      });
    });
  }
  function observedDigest(root: string, change: Pick<ResourceLifecycleFileChange, "area" | "path">) {
    const entry = checkedEntry(root, change.area, change.path);
    return entry ? sha256(boundedBytes(root, change.area, change.path, resourceLifecycleLimits.resourceBytes)) : null;
  }
  function documentIntentGuard(root: string, plan: ResourceLifecyclePlan, recovering: boolean) {
    const cas = plan.documentCas;
    const content = boundedBytes(root, cas.area, cas.path, resourceLifecycleLimits.markdownBytes);
    const raw = content.toString("utf8");
    if (!Buffer.from(raw).equals(content)) fail("RECOVERY_CONFLICT", "Owning document has invalid UTF-8 outside the resource intent.");
    const document = decodeMarkdown(cas.id, raw, cas.path, cas.area);
    if (document.record.deleted || document.record.revision !== cas.revision || document.metadata.get("documentKind") === "todo-board"
      || basename(cas.path).toLowerCase() === "todo board.md") fail("RECOVERY_CONFLICT", "Owning document authority/revision is inconsistent with the resource intent.");
    const observed = sha256(content);
    if (observed !== cas.sha256 && !(recovering && plan.requiresCompoundJournal && observed === plan.result.document.afterSha256)) {
      fail("RECOVERY_CONFLICT", "Owning document was altered outside the resource intent; no recovery changes were made.");
    }
  }
  function checkedIntentStates(root: string, plan: ResourceLifecyclePlan, recovering: boolean) {
    documentIntentGuard(root, plan, recovering);
    for (const change of plan.changes) {
      const observed = observedDigest(root, change);
      if (observed !== change.expectedSha256 && !(recovering && observed === change.afterSha256)) {
        fail("RECOVERY_CONFLICT", "Resource intent target contains unknown bytes; preserve all versions for reconciliation.");
      }
    }
  }
  function fsyncParent(full: string) {
    if (process.platform === "win32") return;
    const fd = openSync(dirname(full), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  function finishResourceIntent(root: string, plan: ResourceLifecyclePlan, operationId: string, recovering: boolean) {
    plan = deserializeResourceLifecyclePlan(serializeResourceLifecyclePlan(plan));
    if (operationId !== plan.operationId) fail("INVALID_WORKSPACE", "Resource intent operationId mismatch.");
    root = rootDirectory(root);
    checkedIntentStates(root, plan, recovering);
    if (!recovering) {
      const scan = referenceScan(root);
      if (scan.revision !== plan.expectedScanRevision) fail("CONFLICT", "Body-reference scan changed before applying the persisted intent.");
      const cas = plan.documentCas;
      const entry = scan.scanned.find(item => item.area === cas.area && item.path === cas.path);
      if (!entry) fail("CONFLICT", "Owning document disappeared before resource application.");
      checkShared(root, scan.scanned, decodeMarkdown(cas.id, entry.raw, cas.path, cas.area));
      if (!plan.requiresCompoundJournal && resourceLifecycleIsReferenced(entry.raw, join(root, cas.area, cas.path), join(root, cas.area, plan.result.before.path))) {
        fail("CONFLICT", "Resource-only intent cannot remove a resource referenced by its owning Markdown.");
      }
    }
    // Materialize destination, then explicit Markdown, and only then remove source.
    const ordered = [...plan.changes.filter(change => change.after !== null), ...plan.changes.filter(change => change.after === null)];
    let effectsStarted = false;
    try {
      for (const change of ordered) {
        const observed = observedDigest(root, change);
        if (observed === change.afterSha256) continue;
        if (observed !== change.expectedSha256) fail("RECOVERY_CONFLICT", "Resource intent target changed during application; preserve the pending intent.");
        const full = checkedResourcePath(root, change.path, false, change.area);
        effectsStarted = true;
        if (change.after) {
          const temporary = join(dirname(full), `.pkm-write-${operationId}`);
          let stale;
          try { stale = lstatSync(temporary); } catch (error) { if (!missing(error)) throw error; }
          if (stale) {
            if (!stale.isFile() || stale.isSymbolicLink() || stale.size !== change.after.length) fail("RECOVERY_CONFLICT", "Resource write staging contains unknown data; manual reconciliation is required.");
            const fd = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              const content = Buffer.alloc(stale.size);
              if (readSync(fd, content, 0, content.length, 0) !== content.length || !content.equals(change.after)) fail("RECOVERY_CONFLICT", "Resource staging bytes differ from the persisted intent.");
            } finally { closeSync(fd); }
          }
          if (change.expectedSha256 === null) atomicFileCreateNoReplace(full, change.after, operationId);
          else atomicFileWrite(full, change.after, change.expectedSha256, operationId);
        } else {
          // Recheck immediately before unlink; never remove an altered or linked file.
          if (observedDigest(root, change) !== change.expectedSha256) fail("RECOVERY_CONFLICT", "Resource source changed before removal.");
          unlinkSync(full);
          fsyncParent(full);
        }
      }
      checkedIntentStates(root, plan, true);
      for (const change of plan.changes) if (observedDigest(root, change) !== change.afterSha256) fail("RECOVERY_CONFLICT", "Resource intent did not reach its exact after state.");
      return plan.result;
    } catch (error) {
      if (error instanceof CoreError) throw new CoreError(error.code, error.message, effectsStarted || recovering ? "unknown" : error.effect);
      throw new CoreError("RECOVERY_CONFLICT", "Resource application interrupted; preserve the durable intent and retry recovery.", "unknown");
    }
  }
  /** Caller must durably persist this intent and hold the shared storage writer lock first. */
  export function applyResourceLifecycle(root: string, plan: ResourceLifecyclePlan, operationId: string): ResourceLifecycleResult {
    return guarded(() => finishResourceIntent(root, plan, operationId, false));
  }
  /** Pending-intent recovery checks before/after states, never original before-only scan guards. */
  export function recoverResourceLifecycle(root: string, plan: ResourceLifecyclePlan, operationId: string): ResourceLifecycleResult {
    try { return guarded(() => finishResourceIntent(root, plan, operationId, true)); }
    catch (error) {
      if (error instanceof CoreError) throw new CoreError(error.code, error.message, "unknown");
      throw error;
    }
  }
function checkShared(root: string, scan: ScannedDocument[], document: MarkdownRecord) {
  const area = document.record.area, owned = markdownAssetDirectory(document.record.path);
  const segments = owned.split("/"), index = segments.findIndex(segment => segment.toLowerCase().endsWith(".assets"));
  const originalOwner = [...segments.slice(0, index), segments[index]!.slice(0, -7) + ".md"].join("/");
  if (originalOwner !== document.record.path && checkedEntry(root, area, originalOwner)) fail("CONFLICT", "Resource tree has a different original owner.");
  const tree = resolve(root, area, owned);
  for (const other of scan) {
    if (other.area === area && other.path === document.record.path) continue;
    for (const reference of markdownReferences(other.raw)) {
      const local = localAssetReference(reference.value);
      if (!local) continue;
      const target = resolve(root, other.area, dirname(other.path), local);
      if (target !== tree && !target.startsWith(tree + sep)) continue;
      const path = relative(join(root, area), target).replaceAll("\\", "/");
      if (checkedEntry(root, area, path)) fail("CONFLICT", `Owned resource tree is shared by ${other.area}/${other.path}; update its references before moving or deleting resources.`);
    }
  }
}
function prepare(root: string, documents: MarkdownRecord[], args: z.infer<typeof previewInput>) {
  root = rootDirectory(root);
  const matches = documents.filter(item => item.record.id === args.id || item.metadata.get("knowledgeId") === args.id);
  if (matches.length !== 1) fail(matches.length ? "CONFLICT" : "NOT_FOUND", "Resource owning document must resolve uniquely.");
  const document = matches[0]!;
  const record = document.record;
  if (record.deleted || record.area !== args.area || record.path !== args.documentPath
    || record.revision !== args.expectedRevision || record.sha256 !== args.expectedSha256) fail("CONFLICT", "Owning document CAS changed.");
  if (record.path.split("/").some(part => part.toLowerCase() === "system" || isMarkdownAssetDirectory(part))
    || document.metadata.get("documentKind") === "todo-board" || basename(record.path).toLowerCase() === "todo board.md") fail("ACCESS_DENIED", "System, resource-contained and Todo documents cannot use resource lifecycle mutations.");
  const owned = markdownAssetDirectory(record.path);
  if (!args.path.startsWith(owned + "/")) fail("ACCESS_DENIED", "Legacy/shared or unknown resources require explicit migration; only the owning .assets tree may be mutated.");
  if (basename(args.path).toLowerCase() === "pkm-todo-board.json" || args.newName?.toLowerCase() === "pkm-todo-board.json") fail("ACCESS_DENIED", "Todo backing authority requires Board commands.");
  const documentBytes = boundedBytes(root, record.area, record.path, resourceLifecycleLimits.markdownBytes);
  const documentRaw = documentBytes.toString("utf8");
  if (!Buffer.from(documentRaw).equals(documentBytes)) fail("INVALID_DOCUMENT", "Owning Markdown must be valid UTF-8.");
  const current = decodeMarkdown(record.id, documentRaw, record.path, record.area);
  if (current.record.sha256 !== args.expectedSha256 || current.record.revision !== args.expectedRevision || current.record.deleted) fail("CONFLICT", "Owning document changed on disk.");
  if (current.metadata.get("documentKind") === "todo-board") fail("ACCESS_DENIED", "Todo documents require Board commands.");
  const content = boundedBytes(root, args.area, args.path, resourceLifecycleLimits.resourceBytes);
  if (content.length !== args.expectedSize || `sha256:${sha256(content)}` !== args.expectedDigest) fail("CONFLICT", "Resource digest/size CAS changed.");
  const scan = referenceScan(root, documents);
  checkShared(root, scan.scanned, document);
  const source = checkedResourcePath(root, args.path, false, args.area);
  const fullDocument = join(root, args.area, args.documentPath);
  const referenced = resourceLifecycleIsReferenced(document.raw, fullDocument, source);
  if (args.action === "delete" && referenced) fail("CONFLICT", "Resource is referenced by its owning document; remove the Markdown reference explicitly before deleting.");
  const destinationPath = args.action === "rename" ? `${dirname(args.path).replaceAll("\\", "/")}/${args.newName}` : null;
  if (destinationPath && !resourcePath.safeParse(destinationPath).success) fail("INVALID_ARGUMENT", "Combined rename destination exceeds the portable resource path contract.");
  if (destinationPath && checkedEntry(root, args.area, destinationPath)) fail("CONFLICT", "Rename destination must be absent; existing files are never overwritten.");
  const afterRaw = destinationPath ? resourceLifecycleRenameMarkdown(document.raw, fullDocument, source, checkedResourcePath(root, destinationPath, false, args.area)) : document.raw;
  if (Buffer.byteLength(afterRaw) > resourceLifecycleLimits.markdownBytes) fail("INVALID_DOCUMENT", "Explicit reference rewrite exceeds the supported numeric byte range.");
  if (afterRaw !== document.raw) decodeMarkdown(record.id, afterRaw, record.path, record.area);
  const documentResult = { id: record.id, area: record.area, path: record.path, revision: record.revision, beforeSha256: record.sha256, afterSha256: sha256(afterRaw) };
  const resource = { area: args.area, path: args.path, digest: args.expectedDigest, size: content.length };
  const preview = previewSchema.parse({
    document: documentResult, resource, scanRevision: scan.revision, destinationPath,
    markdownRewriteRequired: afterRaw !== document.raw, scannedDocuments: scan.scanned.length, scannedBytes: scan.bytes,
  });
  return { document, content, afterRaw, preview };
}
function guarded<T>(action: () => T): T {
  try { return action(); }
  catch (error) {
    if (error instanceof CoreError) throw error;
    fail("INVALID_DOCUMENT", "Resource lifecycle could not inspect a stable checked workspace; no changes were made.");
  }
}
function argumentsFor<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args);
  if (!parsed.success) fail("INVALID_ARGUMENT", "Resource lifecycle arguments violate the public contract.");
  return parsed.data;
}
export function readResourceLifecycle(root: string, documents: MarkdownRecord[], request: ResourceLifecycleRequest): ResourceLifecyclePreview {
  if (request.operation !== "knowledge.asset.lifecycle.preview") fail("NOT_FOUND", "Unknown resource lifecycle read operation.");
  return guarded(() => prepare(root, documents, argumentsFor(previewInput, request.args)).preview);
}
export function planResourceLifecycle(root: string, documents: MarkdownRecord[], request: ResourceLifecycleRequest): ResourceLifecyclePlan {
  return guarded(() => {
    if (request.operation !== "knowledge.asset.rename" && request.operation !== "knowledge.asset.delete") fail("NOT_FOUND", "Unknown resource lifecycle mutation operation.");
    const args = request.operation === "knowledge.asset.rename"
      ? argumentsFor(resourceLifecycleDefinitions[1].input, request.args)
      : argumentsFor(resourceLifecycleDefinitions[2].input, request.args);
    const action = request.operation === "knowledge.asset.rename" ? "rename" : "delete";
    const newName = "newName" in args && typeof args.newName === "string" ? args.newName : undefined;
    const prepared = prepare(root, documents, { ...args, action, ...(newName === undefined ? {} : { newName }) });
    const { document, content, afterRaw, preview } = prepared;
    if (preview.scanRevision !== args.expectedScanRevision) fail("CONFLICT", "Body-reference scan CAS changed; obtain a new lifecycle preview.");
    if (preview.markdownRewriteRequired && !("rewriteMarkdown" in args && args.rewriteMarkdown)) fail("UNSUPPORTED_OPERATION", "Original referenced rename requires a compound resource/Markdown journal; explicitly opt into a rewrite plan with rewriteMarkdown=true. No files were changed.");
    const beforeSha = sha256(content);
    const changes: ResourceLifecycleFileChange[] = [
      { area: args.area, path: args.path, expectedSha256: beforeSha, afterSha256: null, before: content, after: null },
    ];
    if (preview.destinationPath) changes.push({
      area: args.area, path: preview.destinationPath, expectedSha256: null, afterSha256: beforeSha, before: null, after: Buffer.from(content),
    });
    if (preview.markdownRewriteRequired) changes.push({
      area: args.area, path: args.documentPath, expectedSha256: args.expectedSha256, afterSha256: sha256(afterRaw),
      before: Buffer.from(document.raw), after: Buffer.from(afterRaw),
    });
    const result = resultSchema.parse({
      operationId: args.operationId, action, document: preview.document, before: preview.resource,
      after: preview.destinationPath ? { ...preview.resource, path: preview.destinationPath } : null,
      scanRevision: preview.scanRevision, markdownRewritten: preview.markdownRewriteRequired,
    });
    return {
      kind: "resource-lifecycle", operationId: args.operationId, actorId: request.actorId,
      expectedScanRevision: args.expectedScanRevision,
      documentCas: { id: document.record.id, area: args.area, path: args.documentPath, revision: args.expectedRevision, sha256: args.expectedSha256 },
      changes, requiresCompoundJournal: preview.markdownRewriteRequired, result,
    };
  });
}
