import { RenameNoReplaceError, renameNoReplaceSync } from "./rename-no-replace.js";
import { randomBytes } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, readdirSync, rmdirSync, unlinkSync, writeSync,
} from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { knowledgeArea, resourcePath, type KnowledgeArea } from "./document-path.js";
import { opaqueTrashArea, opaqueTrashPath, opaqueTrashFile, opaqueTrashPair, trashCustodyArea, type TrashCustodyArea } from "./opaque-trash-contracts.js";
import { decodeMarkdown, type MarkdownRecord } from "./markdown.js";
import { sha256 } from "./file-write.js";
import { localAssetReference, markdownAssetDirectory, markdownReferences } from "./domain/markdown-assets.js";
import { readOriginalMcpJournal, originalMcpPrivateTopLevels } from "./original-mcp-root-custody.js";
import { originalTrashTransitionSchema, validateOriginalTrashTransition, applyOriginalTrashHistory } from "./original-native-trash-custody.js";
import { approvedOriginalTrashPlan, beginOriginalTrashAttemptForPlan, assertOriginalTrashAttempt } from "./original-native-trash-native.js";
import {
  trashLifecycleDefinitions, trashLifecycleLayout, trashLifecycleLimits as limits,
  trashLifecyclePin, trashEntryId, type TrashLifecycleResult,
} from "./trash-lifecycle-contracts.js";

export { trashLifecycleDefinitions, trashLifecycleLayout, limits as trashLifecycleLimits };
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const entrySchema = z.strictObject({
  path: z.string().max(2048), kind: z.enum(["file", "directory"]),
  dev: natural, ino: natural, size: natural.max(limits.fileBytes), sha256: digest.nullable(),
});
const moveSchema = z.strictObject({
  originalPath: resourcePath, slot: z.enum(["payload", "assets"]),
  entries: z.array(entrySchema).min(1).max(limits.entries),
});
const planSchema = z.strictObject({
  kind: z.literal("trash-lifecycle"), version: z.literal(1),
  operationId: z.string().uuid(), actorId: z.string().min(1).max(500),
  action: z.enum(["trash", "restore"]), entryId: trashEntryId,
  area: trashCustodyArea, path: resourcePath, targetKind: z.enum(["document", "folder", "opaque"]),
  deletedAt: z.string().datetime(), expectedTreeSha256: digest,
  expectedScanRevision: digest, referencePins: z.array(trashLifecyclePin).max(limits.documents),
  documentPins: z.array(trashLifecyclePin).max(limits.documents),
  moves: z.array(moveSchema).min(1).max(2),
  requiresCompoundJournal: z.literal(true),
  boardIdentity: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).optional(),
  originalTrash: originalTrashTransitionSchema.optional(),
  opaqueFile: opaqueTrashFile.optional(),
});
export type TrashLifecyclePlan = z.infer<typeof planSchema>;
type TreeEntry = z.infer<typeof entrySchema>;
type Pin = z.infer<typeof trashLifecyclePin>;
export interface TrashLifecycleHost {
  /** Must be the same exclusive writer lock used by indexing and all lifecycle writers. */
  withWriterLock<T>(action: () => T): T;
  persistIntent(operationId: string, serializedPlan: string): void;
  readIntent(operationId: string): string | undefined;
  faultInjector?(point: string): void;
  /** Single transaction: reindex stable identities/history, update trash index and sync deletion records,
   * write global receipt and clear this intent. Never overwrite unrelated deletion records. */
  commitAtomic(plan: TrashLifecyclePlan, result: TrashLifecycleResult, deletions: {
    removed: Array<{ path: string; deletedAt: string }>; restored: string[];
  }): void;
}
function fail(code: string, message: string): never { throw new CoreError(code, message); }
function absent(error: unknown) { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function checked(root: string, path = "") {
  let current = resolve(root);
  const ancestors: string[] = [];
  for (let p = current; ; p = dirname(p)) { ancestors.push(p); if (p === dirname(p)) break; }
  for (const p of ancestors.reverse()) {
    const stat = lstatSync(p);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_WORKSPACE", "Trash root ancestors must be real directories.");
  }
  const parts = path ? path.split("/") : [];
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    let stat;
    try { stat = lstatSync(current); } catch (error) { if (absent(error)) return undefined; throw error; }
    if (stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory())
      || i < parts.length - 1 && !stat.isDirectory()) fail("INVALID_DOCUMENT", "Trash entries must be regular, link-free paths.");
  }
  return { full: current, stat: lstatSync(current) };
}
function read(root: string, path: string, maximum: number) {
  const found = checked(root, path);
  if (!found?.stat.isFile() || found.stat.size > maximum) fail("CONFLICT", "Pinned file missing or exceeds bounds.");
  const fd = openSync(found.full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (before.dev !== found.stat.dev || before.ino !== found.stat.ino || !before.isFile()
      || before.size > maximum) fail("CONFLICT", "File identity changed before read.");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd), current = checked(root, path);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || !current || current.stat.ino !== before.ino || current.stat.dev !== before.dev) fail("CONFLICT", "File changed during read.");
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
function safePath(path: string, folder = false) {
  if (!resourcePath.safeParse(path).success || path.split("/").some(part =>
    part.toLowerCase() === "system" || part === "_assets" || folder && /\.assets$/i.test(part))) {
    fail("INVALID_ARGUMENT", "Unsafe or reserved trash lifecycle address.");
  }
}
function tree(root: string, base: string) {
  const entries: TreeEntry[] = [];
  let bytes = 0;
  function walk(path: string, relative: string, depth: number) {
    if (depth > limits.depth || entries.length >= limits.entries) fail("INVALID_WORKSPACE", "Trash tree exceeds depth/entry limits.");
    const found = checked(root, path);
    if (!found) fail("CONFLICT", "Trash tree is incomplete.");
    const directory = found.stat.isDirectory();
    const content = directory ? null : read(root, path, limits.fileBytes);
    bytes += content?.length ?? 0;
    if (bytes > limits.subtreeBytes) fail("INVALID_WORKSPACE", "Trash subtree exceeds byte limit.");
    entries.push({
      path: relative, kind: directory ? "directory" : "file",
      dev: found.stat.dev, ino: found.stat.ino, size: content?.length ?? 0,
      sha256: content ? sha256(content) : null,
    });
    if (directory) {
      const names = readdirSync(found.full).sort();
      if (names.length > limits.entries) fail("INVALID_WORKSPACE", "Trash directory exceeds entry limit.");
      const folded = new Set<string>();
      for (const name of names) {
        if (folded.has(name.toLowerCase())) fail("INVALID_DOCUMENT", "Case-colliding trash paths are not portable.");
        folded.add(name.toLowerCase());
        if (name !== ".gitkeep") safePath(name);
        else if (!checked(root, `${path}/${name}`)?.stat.isFile()) fail("INVALID_DOCUMENT", "Invalid .gitkeep.");
        walk(`${path}/${name}`, relative ? `${relative}/${name}` : name, depth + 1);
      }
    }
  }
  walk(base, "", 0);
  return entries;
}
function pin(document: MarkdownRecord): Pin {
  return { id: document.record.id, area: document.record.area, path: document.record.path,
    revision: document.record.revision, sha256: document.record.sha256 };
}
function snapshot(root: string, permittedUnownedAssets?: string) {
  // Read the same stable identities as the shared scanner, but tolerate an exclusively
  // journaled paired-assets-before-payload phase; the complete pair is pinned separately.
  const documents: MarkdownRecord[] = [];
  const identities = new Set<string>(), knowledgeIds = new Set<string>();
  let count = 0, bytes = 0;
  function walk(path: string, depth: number) {
    if (depth > limits.depth) fail("INVALID_WORKSPACE", "Reference scan exceeds depth limit.");
    const found = checked(root, path);
    if (!found) return;
    if (!found.stat.isDirectory()) fail("INVALID_DOCUMENT", "Knowledge areas require real directories.");
    const names = readdirSync(found.full).sort();
    if (names.length > limits.entries) fail("INVALID_WORKSPACE", "Reference directory exceeds entry limit.");
    for (const name of names) {
      if (++count > limits.entries) fail("INVALID_WORKSPACE", "Reference scan exceeds entry limit.");
      const child = checked(root, `${path}/${name}`)!;
      if (name === ".trash") { if (!child.stat.isDirectory()) fail("INVALID_DOCUMENT", "Trash root is not a directory."); continue; }
      if (name === "_assets") fail("UNSUPPORTED_OPERATION", "Legacy asset migration requires its authorized original lifecycle.");
      if (name !== ".gitkeep" && !resourcePath.safeParse(name).success) fail("INVALID_DOCUMENT", "Reference scan entries must be portable.");
      if (child.stat.isDirectory()) {
        if (/\.assets$/i.test(name) && !path.split("/").some(p => /\.assets$/i.test(p))) {
          const owners = names.filter(n => /\.md$/i.test(n) && n.replace(/\.md$/i, ".assets") === name);
          if ((owners.length !== 1 || !checked(root, `${path}/${owners[0]}`)?.stat.isFile())
            && `${path}/${name}` !== permittedUnownedAssets) fail("INVALID_DOCUMENT", "Unowned or ambiguous paired asset tree.");
        }
        walk(`${path}/${name}`, depth + 1); continue;
      }
      if (path.split("/").some(part => /\.assets$/i.test(part)) || name === ".gitkeep") continue;
      const [area, ...segments] = `${path}/${name}`.split("/");
      const relative = segments.join("/");
      if (!/\.md$/i.test(name) || !resourcePath.safeParse(relative).success) fail("INVALID_DOCUMENT", "Unsupported reference scan entry.");
      bytes += child.stat.size;
      if (child.stat.size > limits.markdownBytes || bytes > limits.scanBytes) fail("INVALID_WORKSPACE", "Reference Markdown exceeds byte limit.");
      const raw = read(root, `${path}/${name}`, limits.markdownBytes);
      if (!Buffer.from(raw.toString("utf8")).equals(raw)) fail("INVALID_DOCUMENT", "Reference Markdown must be valid UTF-8.");
      const initial = decodeMarkdown("scan", raw.toString("utf8"), relative, area as KnowledgeArea);
      const aliases = initial.metadata.toJS({ maxAliasCount: 0 }).aliases;
      const prototype = initial.metadata.get("schema") === "pkm.knowledge/v1"
        && initial.metadata.has("revision") && initial.metadata.has("deleted") && Array.isArray(aliases)
        ? [...new Set(aliases.filter((a: unknown): a is string => typeof a === "string" && /^note:[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(a)).map((a: string) => a.slice(5)))] : [];
      const identity = initial.metadata.has("documentId") ? initial.metadata.get("documentId")
        : prototype.length === 1 ? prototype[0] : initial.metadata.get("knowledgeId");
      const filename = basename(name).replace(/\.md$/i, "");
      const id = identity === undefined ? (area === "notes" && !relative.includes("/") && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(filename)
        ? filename : `legacy_${sha256(area === "notes" ? relative : `${area}/${relative}`).slice(0, 32)}`) : identity;
      if (typeof id !== "string" || !trashLifecyclePin.shape.id.safeParse(id).success || identities.has(id)) fail("CONFLICT", "Invalid or duplicate stable identity.");
      identities.add(id);
      const knowledgeId = initial.metadata.get("knowledgeId");
      if (typeof knowledgeId === "string") {
        if (knowledgeIds.has(knowledgeId)) fail("CONFLICT", "Duplicate knowledge identity.");
        knowledgeIds.add(knowledgeId);
      }
      documents.push(decodeMarkdown(id, raw.toString("utf8"), relative, area as KnowledgeArea));
      if (documents.length > limits.documents) fail("INVALID_WORKSPACE", "Reference scan exceeds document limit.");
    }
  }
  for (const area of knowledgeArea.options) walk(area, 0);
  const addresses = new Map<string, string>();
  for (const doc of documents) {
    const knowledgeId = doc.metadata.get("knowledgeId");
    for (const key of [doc.record.id, ...(typeof knowledgeId === "string" ? [knowledgeId] : [])]) {
      const address = `${doc.record.area}/${doc.record.path}`;
      if (addresses.has(key) && addresses.get(key) !== address) fail("CONFLICT", "Ambiguous document/knowledge identity.");
      addresses.set(key, address);
    }
  }
  return documents.sort((a, b) => a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0);
}
function scanRevision(pins: Pin[]) { return sha256(JSON.stringify(pins)); }
export function previewTrashRestoreRevision(root: string): string {
  return scanRevision(snapshot(root).map(pin));
}
function owned(plan: Pick<TrashLifecyclePlan, "area" | "path" | "targetKind">, p: Pin) {
  return p.area === plan.area && (p.path === plan.path || plan.targetKind === "folder" && p.path.startsWith(plan.path + "/"));
}
function editable(document: MarkdownRecord, boardIdentity?: string) {
  const metadata = document.metadata;
  const aliases = metadata.toJS({ maxAliasCount: 0 }).aliases;
  const stable = metadata.get("documentId") ?? (metadata.get("schema") === "pkm.knowledge/v1"
    && Array.isArray(aliases) && aliases.includes(`note:${document.record.id}`) ? document.record.id : metadata.get("knowledgeId"));
  if (stable !== undefined && stable !== document.record.id)
    fail("UNSUPPORTED_OPERATION", "Existing explicit identity must match the pinned document identity.");
  const board = boardIdentity === document.record.id && document.record.area === "notes"
    && metadata.get("documentKind") === "todo-board";
  if (boardIdentity !== undefined && !board) fail("ACCESS_DENIED", "Dedicated Board Trash requires its exact stable Note identity.");
  if (document.record.deleted || metadata.has("memory") || !board && (metadata.get("documentKind") === "todo-board"
    || basename(document.record.path).toLowerCase() === "todo board.md")
    || document.record.path.split("/").some(part => part.toLowerCase() === "system")) {
    fail("ACCESS_DENIED", "Board, memory and System descriptors require their authorized original lifecycle.");
  }
}
function references(documents: MarkdownRecord[], area: TrashCustodyArea, paths: string[], owners: Pin[]) {
  for (const doc of documents) {
    if (doc.record.area !== area || owners.some(p => p.area === area && p.path === doc.record.path)) continue;
    for (const reference of markdownReferences(doc.raw)) {
      const local = localAssetReference(reference.value);
      if (!local) continue;
      const path = posix.normalize(posix.join(posix.dirname(doc.record.path), local));
      if (paths.some(target => path === target || path.startsWith(target + "/"))) {
        fail("CONFLICT", "An outside document references resources in the trash subtree.");
      }
    }
  }
}
function bucket(plan: TrashLifecyclePlan) { return `${plan.area}/.trash/${plan.entryId}`; }
export function trashLifecycleMetadata(plan: TrashLifecyclePlan) {
  return Buffer.from(JSON.stringify({
    id: plan.entryId, kind: plan.targetKind === "folder" ? "folder" : plan.area === "skills" ? "skill" : "item",
    name: plan.area === "skills" && plan.targetKind === "document" ? basename(plan.path, ".md") : basename(plan.path),
    originalPath: plan.path, deletedAt: plan.deletedAt,
    ...(plan.moves.length === 2 ? { assetsPath: plan.moves[0]!.originalPath } : {}),
  }, null, 2) + "\n");
}
const metadata = trashLifecycleMetadata;
function validate(value: unknown): TrashLifecyclePlan {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) fail("INVALID_WORKSPACE", "Trash intent violates strict journal schema.");
  const plan = parsed.data;
  const opaque = opaqueTrashArea.safeParse(plan.area).success;
  if (opaque !== (plan.targetKind === "opaque") || opaque !== !!plan.opaqueFile
    || opaque && (!opaqueTrashPath.safeParse(plan.path).success || plan.documentPins.length !== 0 || plan.boardIdentity))
    fail("INVALID_WORKSPACE", "Opaque custody cannot be reinterpreted as Markdown.");
  if (plan.originalTrash) {
    const transition = validateOriginalTrashTransition(plan.originalTrash), { originalTrash: _transition, ...base } = plan;
    if (plan.area !== transition.selection.area || (!opaque && (plan.targetKind !== "document" || plan.documentPins.length !== 1)) || plan.boardIdentity
      || transition.operationId !== plan.operationId || transition.action !== (plan.action === "trash" ? "move" : "restore")
      || transition.selection.entryId !== plan.entryId || transition.planSha256 !== sha256(JSON.stringify(base)))
      fail("INVALID_WORKSPACE", "Original Trash journal requires its exact bounded public document transition.");
    if (transition.schema === "pkm.original-native-trash-transition/v2"
      && (transition.selection.path !== plan.path || transition.provenance.request.subject.actorId !== plan.actorId
        || transition.selection.document.id !== plan.documentPins[0]!.id
        || transition.selection.document.revision !== plan.documentPins[0]!.revision
        || transition.selection.document.sha256 !== plan.documentPins[0]!.sha256))
      fail("INVALID_WORKSPACE", "Skill/Paper v2 pins must match the exact canonical document identity and raw revision.");
    if (transition.schema === "pkm.original-native-trash-transition/v3"
      && (!opaque || transition.selection.path !== plan.path || JSON.stringify(transition.selection.file) !== JSON.stringify(plan.opaqueFile)))
      fail("INVALID_WORKSPACE", "Opaque v3 pins must match exact reviewed source bytes.");
  }
  if (plan.boardIdentity && (plan.area !== "notes" || plan.targetKind !== "document"
    || plan.documentPins.length !== 1 || plan.documentPins[0]!.id !== plan.boardIdentity))
    fail("INVALID_WORKSPACE", "Dedicated Board Trash must pin exactly one Note identity.");
  if (!z.string().uuid().safeParse(plan.entryId).success
    && plan.entryId.split("-")[0] !== String(Date.parse(plan.deletedAt))) {
    fail("INVALID_WORKSPACE", "Original Trash identity must bind its exact persisted deletion timestamp.");
  }
  safePath(plan.path, plan.targetKind === "folder");
  if (plan.targetKind === "document" && !/\.md$/i.test(plan.path)) fail("INVALID_ARGUMENT", "Document trash requires Markdown.");
  const expected = plan.moves.length === 2
    ? [{ originalPath: opaque ? opaqueTrashPair(plan.path) : markdownAssetDirectory(plan.path), slot: "assets" }, { originalPath: plan.path, slot: "payload" }]
    : [{ originalPath: plan.path, slot: "payload" }];
  if (plan.targetKind === "folder" && plan.moves.length !== 1
    || JSON.stringify(plan.moves.map(({ originalPath, slot }) => ({ originalPath, slot }))) !== JSON.stringify(expected)) {
    fail("INVALID_WORKSPACE", "Trash moves do not address the exact original paired subtree.");
  }
  let total = 0, count = 0;
  for (const move of plan.moves) {
    const paths = new Set<string>();
    for (const [i, entry] of move.entries.entries()) {
      if (i === 0 ? entry.path !== "" : !entry.path || paths.has(entry.path)) fail("INVALID_WORKSPACE", "Invalid tree root or duplicate journal entry.");
      if (entry.path) {
        if (entry.path.split("/").some(p => p !== ".gitkeep" && !resourcePath.safeParse(p).success || p === "_assets")
          || entry.path.split("/").length > limits.depth
          || !move.entries.some(p => p.path === (posix.dirname(entry.path) === "." ? "" : posix.dirname(entry.path)) && p.kind === "directory")) {
          fail("INVALID_WORKSPACE", "Journal entries are not a portable complete tree.");
        }
      }
      const payload = plan.moves.find(move => move.slot === "payload")!;
      const documentEntries = payload.entries.filter(entry => entry.kind === "file"
        && (plan.targetKind === "document" || /\.md$/i.test(entry.path) && !entry.path.split("/").some(part => /\.assets$/i.test(part))));
      if (!opaque && (documentEntries.length !== plan.documentPins.length || documentEntries.some(entry => {
        const path = plan.targetKind === "document" ? plan.path : `${plan.path}/${entry.path}`;
        return !plan.documentPins.some(pin => pin.area === plan.area && pin.path === path && pin.sha256 === entry.sha256);
      }) || payload.entries[0]!.kind !== (plan.targetKind === "folder" ? "directory" : "file")
        || plan.moves.some(move => move.slot === "assets" && move.entries[0]!.kind !== "directory"))) {
        fail("INVALID_WORKSPACE", "Document pins do not cover the exact payload Markdown subtree.");
      }
      if (opaque && (plan.moves.find(move => move.slot === "payload")?.entries.length !== 1
        || plan.moves.find(move => move.slot === "payload")?.entries[0]?.kind !== "file"
        || plan.moves.find(move => move.slot === "payload")?.entries[0]?.sha256 !== plan.opaqueFile!.sha256
        || plan.moves.find(move => move.slot === "payload")?.entries[0]?.size !== plan.opaqueFile!.size
        || plan.moves.some(move => move.slot === "assets" && move.entries[0]!.kind !== "directory")))
        fail("INVALID_WORKSPACE", "Opaque pins require one exact regular source and its optional owned pair.");
      if ((entry.kind === "directory") !== (entry.sha256 === null) || entry.kind === "directory" && entry.size !== 0) fail("INVALID_WORKSPACE", "Invalid tree content pin.");
      paths.add(entry.path); total += entry.size; count++;
    }
    if (JSON.stringify(move.entries.map(e => e.path)) !== JSON.stringify([...move.entries.map(e => e.path)].sort())) {
      fail("INVALID_WORKSPACE", "Tree journal paths must be sorted.");
    }
  }
  if (total > limits.subtreeBytes || count > limits.entries || sha256(JSON.stringify(plan.moves)) !== plan.expectedTreeSha256
    || scanRevision(plan.referencePins) !== plan.expectedScanRevision
    || JSON.stringify(plan.referencePins.filter(p => owned(plan, p))) !== JSON.stringify(plan.action === "trash" ? plan.documentPins : [])
    || new Set(plan.documentPins.map(p => p.id)).size !== plan.documentPins.length
    || plan.documentPins.some(p => !owned(plan, p))) fail("INVALID_WORKSPACE", "Invalid tree, snapshot or document identity pins.");
  return plan;
}
export function serializeTrashLifecyclePlan(plan: TrashLifecyclePlan) {
  const json = JSON.stringify(validate(plan));
  if (Buffer.byteLength(json) > limits.journalBytes) fail("INVALID_WORKSPACE", "Trash journal exceeds serialized byte limit.");
  return json;
}
export function deserializeTrashLifecyclePlan(json: string) {
  if (typeof json !== "string" || Buffer.byteLength(json) > limits.journalBytes) fail("INVALID_WORKSPACE", "Invalid journal size.");
  try { return validate(JSON.parse(json)); }
  catch (error) { if (error instanceof CoreError) throw error; fail("INVALID_WORKSPACE", "Invalid trash journal JSON."); }
}
/** Only for an authenticated copied backup, before its no-replace publication. */
export function repinTrashLifecycleBackup(root: string, value: TrashLifecyclePlan): TrashLifecyclePlan {
  const plan = validate(value);
  if (plan.action !== "trash") fail("RECOVERY_CONFLICT", "A backup may only re-pin authoritative committed Trash.");
  if (!read(root, `${bucket(plan)}/metadata.json`, 8192).equals(metadata(plan)))
    fail("RECOVERY_CONFLICT", "Copied Trash metadata differs from its authenticated plan.");
  const moves = plan.moves.map(move => {
    const entries = tree(root, `${bucket(plan)}/${move.slot}`).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const portable = (entries: TreeEntry[]) => entries.map(({ dev: _dev, ino: _ino, ...entry }) => entry);
    if (JSON.stringify(portable(entries)) !== JSON.stringify(portable(move.entries)))
      fail("RECOVERY_CONFLICT", "Copied Trash payload or paired resources differ from the authenticated plan.");
    return { ...move, entries };
  });
  const rebound = validate({ ...plan, moves, expectedTreeSha256: sha256(JSON.stringify(moves)) });
  inspectTrashLifecycleEntry(root, rebound);
  return rebound;
}
function inspectTrashLifecycle(root: string, args: unknown, boardIdentity?: string) {
  const parsed = trashLifecycleDefinitions[0].input.safeParse(args);
  if (!parsed.success) fail("INVALID_ARGUMENT", "Invalid trash preview arguments.");
  const { area, path, kind } = parsed.data;
  if (opaqueTrashArea.safeParse(area).success || kind === "opaque") {
    if (!readOriginalMcpJournal(root) || kind !== "opaque" || !opaqueTrashArea.safeParse(area).success || !opaqueTrashPath.safeParse(path).success)
      fail("NATIVE_AUTHORITY_REQUIRED", "Opaque custody requires its actual original root and typed source.");
    const source = checked(root, `${area}/${path}`);
    if (!source?.stat.isFile()) fail("CONFLICT", "Opaque Trash source must be an existing regular file.");
    const pins = snapshot(root).map(pin), moves: TrashLifecyclePlan["moves"] = [];
    const assets = opaqueTrashPair(path);
    if (assets && checked(root, `${area}/${assets}`)) {
      if (!checked(root, `${area}/${assets}`)!.stat.isDirectory()) fail("CONFLICT", "Opaque pair must be a directory.");
      moves.push({ originalPath: assets, slot: "assets", entries: tree(root, `${area}/${assets}`) });
    }
    moves.push({ originalPath: path, slot: "payload", entries: tree(root, `${area}/${path}`) });
    assertOriginalPublicPairReferences(root, area, path);
    return { treeSha256: sha256(JSON.stringify(moves)), scanRevision: scanRevision(pins), documents: [],
      moves, referencePins: pins };
  }
  safePath(path, kind === "folder");
  if (kind === "document" && !/\.md$/i.test(path)) fail("INVALID_ARGUMENT", "Document trash requires Markdown.");
  const source = checked(root, `${area}/${path}`);
  if (!source || (kind === "folder") !== source.stat.isDirectory()) fail("CONFLICT", "Trash source kind changed or missing.");
  const documents = snapshot(root), pins = documents.map(pin);
  const ownerPins = pins.filter(p => owned({ area, path, targetKind: kind }, p));
  if (boardIdentity && (area !== "notes" || kind !== "document" || ownerPins.length !== 1 || ownerPins[0]!.id !== boardIdentity))
    fail("ACCESS_DENIED", "Dedicated Board Trash must resolve its single exact Note.");
  for (const doc of documents.filter(doc => ownerPins.some(p => p.id === doc.record.id))) editable(doc, boardIdentity);
  const moves: TrashLifecyclePlan["moves"] = [];
  const assetsPath = kind === "document" ? markdownAssetDirectory(path) : undefined;
  if (assetsPath && checked(root, `${area}/${assetsPath}`)) {
    if (!checked(root, `${area}/${assetsPath}`)!.stat.isDirectory()) fail("INVALID_DOCUMENT", "Paired assets must be a directory.");
    moves.push({ originalPath: assetsPath, slot: "assets", entries: tree(root, `${area}/${assetsPath}`) });
  }
  moves.push({ originalPath: path, slot: "payload", entries: tree(root, `${area}/${path}`) });
  references(documents, area, kind === "folder" ? [path] : assetsPath ? [assetsPath] : [], ownerPins);
  // Canonical paths are used both for source and destination classification.
  for (const move of moves) move.entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { treeSha256: sha256(JSON.stringify(moves)), scanRevision: scanRevision(pins), documents: ownerPins, moves, referencePins: pins };
}
export function previewTrashLifecycle(root: string, args: unknown) {
  if (readOriginalMcpJournal(root)) {
    const value = trashLifecycleDefinitions[0].input.parse(args);
    if (!["document", "opaque"].includes(value.kind) || originalMcpPrivateTopLevels(root, value.area).has(value.path.split("/")[0]!))
      fail("ACCESS_DENIED", "Original Trash is bounded to one public document and its exclusively owned pair.");
  }
  const { treeSha256, scanRevision, documents } = inspectTrashLifecycle(root, args);
  if (readOriginalMcpJournal(root)) {
    const value = trashLifecycleDefinitions[0].input.parse(args);
    if (value.area !== "notes") assertOriginalPublicPairReferences(root, value.area, value.path);
  }
  return { treeSha256, scanRevision, documents };
}
export function planTrashLifecycle(root: string, actorId: string, args: unknown): TrashLifecyclePlan {
  if (readOriginalMcpJournal(root))
    return validate(approvedOriginalTrashPlan(root, { operation: "knowledge.trash.move", actorId, args: trashLifecycleDefinitions[1].input.parse(args) }));
  return planTrash(root, actorId, args);
}
/** Read-only planning; never an effect or native grant. */
export function prepareOriginalPublicNoteTrash(root: string, actorId: string, args: unknown): TrashLifecyclePlan {
  const value = trashLifecycleDefinitions[1].input.parse(args);
  if (value.area !== "notes") fail("ACCESS_DENIED", "Note v1 planning cannot reinterpret another area.");
  return prepareOriginalPublicDocumentTrash(root, actorId, value);
}
export function prepareOriginalPublicDocumentTrash(root: string, actorId: string, args: unknown): TrashLifecyclePlan {
  if (!readOriginalMcpJournal(root)) fail("NATIVE_AUTHORITY_REQUIRED", "Original planning requires the actual custody-bound root.");
  const value = trashLifecycleDefinitions[1].input.parse(args);
  previewTrashLifecycle(root, { area: value.area, path: value.path, kind: value.kind });
  return planTrash(root, actorId, args, undefined, true);
}
export function previewNativeBoardTrash(root: string, args: unknown, noteId: string) {
  const { treeSha256, scanRevision, documents } = inspectTrashLifecycle(root, args, noteId);
  return { treeSha256, scanRevision, documents };
}
/** Caller must authorize the synthetic user and journal under the workspace writer fence. */
export function planNativeBoardTrash(root: string, actorId: string, args: unknown, noteId: string): TrashLifecyclePlan {
  return planTrash(root, actorId, args, noteId);
}
function planTrash(root: string, actorId: string, args: unknown, boardIdentity?: string, originalPlanning = false): TrashLifecyclePlan {
  const parsed = trashLifecycleDefinitions[1].input.safeParse(args);
  if (!parsed.success) fail("INVALID_ARGUMENT", "Invalid trash operation arguments.");
  const value = parsed.data, preview = inspectTrashLifecycle(root, { area: value.area, path: value.path, kind: value.kind }, boardIdentity);
  if (value.expectedTreeSha256 !== preview.treeSha256 || value.expectedScanRevision !== preview.scanRevision) fail("CONFLICT", "Trash source or reference CAS changed.");
  if (!checked(root, `${value.area}/.trash`)?.stat.isDirectory() && !boardIdentity && !originalPlanning) fail("INVALID_WORKSPACE", "Host must qualify and provision the allowlisted trash root.");
  const deletedAt = new Date().toISOString();
  const entryId = value.entryIdFormat === "original"
    ? `${Date.parse(deletedAt)}-${randomBytes(5).toString("hex")}` : value.operationId;
  const plan = validate({
    kind: "trash-lifecycle", version: 1, operationId: value.operationId, entryId,
    actorId, action: "trash", area: value.area, path: value.path, targetKind: value.kind,
    deletedAt, expectedTreeSha256: preview.treeSha256,
    expectedScanRevision: preview.scanRevision, referencePins: preview.referencePins,
    documentPins: preview.documents, moves: preview.moves, requiresCompoundJournal: true,
    ...(value.kind === "opaque" ? { opaqueFile: {
      sha256: preview.moves.find(move => move.slot === "payload")!.entries[0]!.sha256!,
      size: preview.moves.find(move => move.slot === "payload")!.entries[0]!.size,
    } } : {}),
    ...(boardIdentity ? { boardIdentity } : {}),
  });
  if (checked(root, bucket(plan))) fail("CONFLICT", "Trash entry destination already exists.");
  return plan;
}
export function planTrashRestore(root: string, actorId: string, committedEntry: TrashLifecyclePlan, args: unknown): TrashLifecyclePlan {
  if (readOriginalMcpJournal(root))
    return validate(approvedOriginalTrashPlan(root, { operation: "knowledge.trash.restore", actorId, args: trashLifecycleDefinitions[2].input.parse(args) }));
  if (committedEntry.boardIdentity) fail("ACCESS_DENIED", "Board restore requires its dedicated authorized journal.");
  return planRestore(root, actorId, committedEntry, args);
}
export function prepareOriginalPublicNoteRestore(root: string, actorId: string, committedEntry: TrashLifecyclePlan, args: unknown): TrashLifecyclePlan {
  if (committedEntry.area !== "notes") fail("ACCESS_DENIED", "Note v1 restore cannot reinterpret another area.");
  return prepareOriginalPublicDocumentRestore(root, actorId, committedEntry, args);
}
function assertOriginalPublicPairReferences(root: string, area: TrashCustodyArea, path: string) {
  const pair = opaqueTrashArea.safeParse(area).success ? opaqueTrashPair(path) : markdownAssetDirectory(path);
  if (!pair) return;
  const target = `${area}/${pair}`;
  if (opaqueTrashArea.safeParse(area).success) {
    let entries = 0, bytes = 0;
    const markers = [target, pair, basename(pair)].flatMap(value => [value, encodeURI(value), encodeURIComponent(value)]);
    for (const opaqueArea of opaqueTrashArea.options) {
      const privateNames = originalMcpPrivateTopLevels(root, opaqueArea);
      function visit(relative: string, depth: number) {
        if (++entries > 4096 || depth > 32) fail("CONFLICT", "Opaque ownership proof exceeds its bounded namespace.");
        const fullPath = `${opaqueArea}${relative ? `/${relative}` : ""}`, found = checked(root, fullPath);
        if (!found) return;
        if (relative.split("/")[0] === ".trash" || /\.assets(?:\/|$)/i.test(relative)) return;
        if (privateNames.has(relative.split("/")[0]!))
          fail("ACCESS_DENIED", "A private opaque referrer cannot be inspected under public pair consent.");
        if (found.stat.isDirectory()) {
          for (const name of readdirSync(found.full).sort()) visit(relative ? `${relative}/${name}` : name, depth + 1);
          return;
        }
        if (opaqueArea === area && relative === path || basename(relative) === ".gitkeep") return;
        bytes += found.stat.size;
        if (bytes > 16 * 1024 * 1024) fail("CONFLICT", "Opaque ownership proof exceeds its byte bound.");
        const raw = read(root, fullPath, 16 * 1024 * 1024);
        if (markers.some(marker => raw.includes(Buffer.from(marker))))
          fail("CONFLICT", "Another opaque source may reference this owned pair.");
      }
      visit("", 0);
    }
  }
  for (const doc of snapshot(root)) {
    if (doc.record.area === area && doc.record.path === path) continue;
    const paperFile = doc.record.area === "papers" ? doc.metadata.get("file") : undefined;
    const references = [...markdownReferences(doc.raw).map(reference => reference.value),
      ...(typeof paperFile === "string" ? [paperFile] : [])];
    for (const reference of references) {
      const local = localAssetReference(reference);
      if (!local) continue;
      const resolved = posix.normalize(posix.join(doc.record.area, posix.dirname(doc.record.path), local));
      if (resolved === target || resolved.startsWith(`${target}/`))
        fail("CONFLICT", "An outside public or private document references this owned pair.");
    }
  }
}
export function prepareOriginalPublicDocumentRestore(root: string, actorId: string, committedEntry: TrashLifecyclePlan, args: unknown): TrashLifecyclePlan {
  if (!readOriginalMcpJournal(root)) fail("NATIVE_AUTHORITY_REQUIRED", "Original restore planning requires the actual custody-bound root.");
  const { originalTrash: _old, ...original } = committedEntry;
  if ((!(original.targetKind === "opaque" && original.opaqueFile && original.documentPins.length === 0)
    && (original.targetKind !== "document" || original.documentPins.length !== 1)) || original.boardIdentity
    || originalMcpPrivateTopLevels(root, original.area).has(original.path.split("/")[0]!))
    fail("ACCESS_DENIED", "Original restore is limited to its exact committed public document/pair.");
  if (original.area !== "notes") assertOriginalPublicPairReferences(root, original.area, original.path);
  return planRestore(root, actorId, original, args);
}
export function planNativeBoardRestore(root: string, actorId: string, committedEntry: TrashLifecyclePlan, args: unknown, noteId: string): TrashLifecyclePlan {
  if (committedEntry.boardIdentity !== noteId) fail("ACCESS_DENIED", "Board restore identity differs from its committed Trash entry.");
  return planRestore(root, actorId, committedEntry, args);
}
function planRestore(root: string, actorId: string, committedEntry: TrashLifecyclePlan, args: unknown): TrashLifecyclePlan {
  const original = validate(committedEntry), parsed = trashLifecycleDefinitions[2].input.safeParse(args);
  if (!parsed.success || parsed.data.entryId !== original.entryId || original.action !== "trash") fail("INVALID_ARGUMENT", "Restore requires an authoritative committed trash entry.");
  const pins = snapshot(root).map(pin);
  if (scanRevision(pins) !== parsed.data.expectedScanRevision) fail("CONFLICT", "Restore reference CAS changed.");
  if (pins.some(p => original.documentPins.some(owner => owner.id === p.id))) fail("CONFLICT", "A trashed identity is already active.");
  if (original.moves.some(move => checked(root, `${original.area}/${move.originalPath}`))) fail("CONFLICT", "Restore destination is occupied.");
  const plan = validate({ ...original, action: "restore", operationId: parsed.data.operationId,
    actorId, referencePins: pins, expectedScanRevision: scanRevision(pins) });
  if (!read(root, `${bucket(plan)}/metadata.json`, 8192).equals(metadata(plan))) fail("CONFLICT", "Trash entry metadata changed.");
  for (const move of plan.moves) {
    if (checked(root, `${plan.area}/${move.originalPath}`)) fail("CONFLICT", "Restore destination is occupied.");
    const parent = checked(root, posix.dirname(`${plan.area}/${move.originalPath}`));
    if (parent && !parent.stat.isDirectory()) fail("CONFLICT", "Restore parent is not a directory.");
    if (JSON.stringify(tree(root, `${bucket(plan)}/${move.slot}`).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) !== JSON.stringify(move.entries)) fail("CONFLICT", "Trash subtree identity or bytes changed.");
  }
  classify(root, plan);
  return plan;
}
function sync(directory: string) {
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function ensureRestoreParent(root: string, area: TrashCustodyArea, path: string) {
  if (!checked(root, area)?.stat.isDirectory()) fail("RECOVERY_CONFLICT", "Restore area root is missing.");
  let parent: string = area;
  for (const part of path.split("/").slice(0, -1)) {
    const next = `${parent}/${part}`;
    if (!checked(root, next)) {
      try { mkdirSync(join(root, next)); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
    }
    if (!checked(root, next)?.stat.isDirectory()) fail("RECOVERY_CONFLICT", "Restore parent is not a real directory.");
    // Also sync a directory left by an interrupted prior attempt before publishing into it.
    sync(join(root, next)); sync(join(root, parent));
    parent = next;
  }
}
function renameExclusive(source: string, destination: string) {
  try { renameNoReplaceSync(source, destination); }
  catch (error) {
    if (!(error instanceof RenameNoReplaceError)) throw error;
    fail(error.code === "UNAVAILABLE" ? "UNSUPPORTED_OPERATION" : "RECOVERY_CONFLICT", error.message);
  }
  sync(dirname(source)); sync(dirname(destination));
}
function classify(root: string, plan: TrashLifecyclePlan) {
  let prefix = 0, beforeSeen = false;
  for (const move of plan.moves) {
    const original = `${plan.area}/${move.originalPath}`, trash = `${bucket(plan)}/${move.slot}`;
    const source = plan.action === "trash" ? original : trash, destination = plan.action === "trash" ? trash : original;
    const before = checked(root, source), after = checked(root, destination);
    if (!!before === !!after) fail("RECOVERY_CONFLICT", "Trash move has unknown source/destination phase.");
    const observed = tree(root, before ? source : destination).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (JSON.stringify(observed) !== JSON.stringify(move.entries)) fail("RECOVERY_CONFLICT", "Trash subtree identity/content pins changed.");
    if (after) { if (beforeSeen) fail("RECOVERY_CONFLICT", "Non-prefix trash move interruption."); prefix++; }
    else beforeSeen = true;
  }
  if (plan.targetKind === "document" && plan.moves.length === 1
    && (checked(root, `${plan.area}/${markdownAssetDirectory(plan.path)}`) || checked(root, `${bucket(plan)}/assets`))) {
    fail("RECOVERY_CONFLICT", "An unpinned paired asset tree appeared.");
  }
  if (plan.targetKind === "opaque" && plan.moves.length === 1 && opaqueTrashPair(plan.path)
    && (checked(root, `${plan.area}/${opaqueTrashPair(plan.path)}`) || checked(root, `${bucket(plan)}/assets`)))
    fail("RECOVERY_CONFLICT", "An unpinned opaque pair appeared.");
  const docs = snapshot(root, plan.action === "restore" && plan.moves.length === 2
    ? `${plan.area}/${plan.moves[0]!.originalPath}` : undefined), pins = docs.map(pin);
  const expected = plan.referencePins.filter(p => !owned(plan, p));
  if (JSON.stringify(pins.filter(p => !owned(plan, p))) !== JSON.stringify(expected)) fail("RECOVERY_CONFLICT", "Outside reference snapshot changed.");
  const actualOwners = pins.filter(p => owned(plan, p));
  const payloadDone = prefix === plan.moves.length;
  const ownersPresent = plan.action === "trash" ? !payloadDone : payloadDone;
  if (JSON.stringify(actualOwners) !== JSON.stringify(ownersPresent ? plan.documentPins : [])) fail("RECOVERY_CONFLICT", "Document identity/revision pins changed.");
  // Validate descriptors in the serialized tree even when they are currently in Trash.
  for (const p of plan.documentPins) {
    const path = ownersPresent ? `${p.area}/${p.path}` : `${bucket(plan)}/payload${plan.targetKind === "folder" ? "/" + p.path.slice(plan.path.length + 1) : ""}`;
    const raw = read(root, path, limits.markdownBytes);
    if (sha256(raw) !== p.sha256 || !Buffer.from(raw.toString("utf8")).equals(raw)) fail("RECOVERY_CONFLICT", "Trashed Markdown pin changed.");
    const doc = decodeMarkdown(p.id, raw.toString("utf8"), p.path, p.area);
    editable(doc, plan.boardIdentity);
    if (doc.record.revision !== p.revision) fail("RECOVERY_CONFLICT", "Trashed revision changed.");
    const keys = [doc.record.id, doc.metadata.get("knowledgeId")].filter((key): key is string => typeof key === "string");
    if (docs.some(active => active.record.id !== p.id && [active.record.id, active.metadata.get("knowledgeId")]
      .some(key => typeof key === "string" && keys.includes(key)))) fail("RECOVERY_CONFLICT", "A trashed stable identity is already active under another address.");
  }
  references(docs, plan.area, plan.targetKind === "folder" ? [plan.path]
    : plan.targetKind === "opaque" ? (opaqueTrashPair(plan.path) ? [opaqueTrashPair(plan.path)!] : [])
      : [markdownAssetDirectory(plan.path)], plan.documentPins);
  return prefix;
}
function inspectBucket(root: string, plan: TrashLifecyclePlan, recovery: boolean, prefix: number) {
  const found = checked(root, bucket(plan));
  if (!found) {
    if (plan.action === "restore" && prefix !== plan.moves.length || plan.action === "trash" && prefix !== 0) fail("RECOVERY_CONFLICT", "Trash bucket is missing.");
    return;
  }
  if (!found.stat.isDirectory() || plan.action === "trash" && !recovery) fail("RECOVERY_CONFLICT", "Unowned trash bucket already exists.");
  const names = readdirSync(found.full);
  const allowed = ["metadata.json", ...plan.moves.map(m => m.slot)];
  if (names.some(name => !allowed.includes(name))) fail("RECOVERY_CONFLICT", "Trash bucket contains unknown data.");
  if (names.includes("metadata.json")) {
    if (!read(root, `${bucket(plan)}/metadata.json`, 8192).equals(metadata(plan))) fail("RECOVERY_CONFLICT", "Trash metadata changed.");
  } else if (prefix !== 0 && plan.action === "trash" || prefix !== plan.moves.length && plan.action === "restore") fail("RECOVERY_CONFLICT", "Trash metadata missing in an effects phase.");
}
function effects(root: string, plan: TrashLifecyclePlan, recovery: boolean, fault?: (point: string) => void, current = () => {}) {
  current();
  if (!checked(root, `${plan.area}/.trash`) && plan.originalTrash && plan.action === "trash") {
    mkdirSync(join(root, `${plan.area}/.trash`), { mode: 0o700 }); sync(join(root, plan.area));
  }
  if (!checked(root, `${plan.area}/.trash`)?.stat.isDirectory()
    && !(plan.originalTrash && plan.action === "restore" && !checked(root, bucket(plan))))
    fail("INVALID_WORKSPACE", "Allowlisted trash root is missing.");
  let prefix = classify(root, plan);
  inspectBucket(root, plan, recovery, prefix);
  if (plan.action === "trash") {
    current();
    if (!checked(root, bucket(plan))) { mkdirSync(join(root, bucket(plan)), { mode: 0o700 }); sync(join(root, plan.area, ".trash")); }
    fault?.("bucket");
    if (!checked(root, `${bucket(plan)}/metadata.json`)) {
      current();
      const fd = openSync(join(root, bucket(plan), "metadata.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { const bytes = metadata(plan); let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset); fsyncSync(fd); }
      finally { closeSync(fd); }
      sync(join(root, bucket(plan)));
    }
    fault?.("metadata");
  }
  for (; prefix < plan.moves.length; prefix++) {
    current();
    // Reclassify all known phases immediately before each effect, without accepting unknown bytes.
    classify(root, plan);
    const move = plan.moves[prefix]!, original = `${plan.area}/${move.originalPath}`, trash = `${bucket(plan)}/${move.slot}`;
    const source = plan.action === "trash" ? original : trash, destination = plan.action === "trash" ? trash : original;
    if (plan.action === "restore") ensureRestoreParent(root, plan.area, move.originalPath);
    const from = checked(root, source), parent = checked(root, posix.dirname(destination));
    if (!from || !parent?.stat.isDirectory()) fail("RECOVERY_CONFLICT", "Trash move parent or source changed.");
    current();
    renameExclusive(from.full, join(root, destination));
    fault?.(`move-${prefix}`);
  }
  classify(root, plan);
  if (plan.action === "restore" && checked(root, bucket(plan))) {
    current();
    inspectBucket(root, plan, true, prefix);
    const file = `${bucket(plan)}/metadata.json`;
    if (checked(root, file)) { unlinkSync(join(root, file)); sync(join(root, bucket(plan))); }
    rmdirSync(join(root, bucket(plan))); sync(join(root, plan.area, ".trash"));
    if (plan.originalTrash && readdirSync(join(root, plan.area, ".trash")).length === 0) {
      rmdirSync(join(root, plan.area, ".trash")); sync(join(root, plan.area));
    }
    fault?.("cleanup");
  }
}
export function executeTrashLifecycle(root: string, plan: TrashLifecyclePlan, host: TrashLifecycleHost, recovery = false): TrashLifecycleResult {
  const serialized = serializeTrashLifecyclePlan(plan);
  return host.withWriterLock(() => {
    const attempt = plan.originalTrash ? beginOriginalTrashAttemptForPlan(root, plan) : undefined;
    const current = () => {
      if (attempt) assertOriginalTrashAttempt(attempt, plan.originalTrash!);
    };
    current();
    if (recovery) {
      if (host.readIntent(plan.operationId) !== serialized) fail("RECOVERY_CONFLICT", "Host journal does not match this exact intent.");
    } else {
      if (host.readIntent(plan.operationId) !== undefined) fail("CONFLICT", "Operation intent already exists.");
      if (classify(root, plan) !== 0) fail("CONFLICT", "New operation is not in its before-effects phase.");
      inspectBucket(root, plan, false, 0);
      host.persistIntent(plan.operationId, serialized);
      if (host.readIntent(plan.operationId) !== serialized) fail("STORAGE_ERROR", "Host did not durably persist the exact intent.");
      host.faultInjector?.("intent");
    }

    effects(root, plan, recovery, host.faultInjector, current);
    if (plan.originalTrash) applyOriginalTrashHistory(root, plan.originalTrash, attempt!, host.faultInjector);
    const result: TrashLifecycleResult = {
      operationId: plan.operationId, entryId: plan.entryId, action: plan.action, area: plan.area, path: plan.path,
    };
    const paths = plan.moves.flatMap(move => move.entries.filter(e => e.kind === "file"
      && !e.path.split("/").some(part => part.startsWith(".")))
      .map(e => `${plan.area}/${move.originalPath}${e.path ? "/" + e.path : ""}`));
    host.faultInjector?.("before-commit");
    current();
    host.commitAtomic(plan, result, {
      removed: plan.action === "trash" ? paths.map(path => ({ path, deletedAt: plan.deletedAt })) : [],
      restored: plan.action === "restore" ? paths : [],
    });
    host.faultInjector?.("committed");
    if (host.readIntent(plan.operationId) !== undefined) fail("STORAGE_ERROR", "Host did not atomically clear the committed intent; reconcile its receipt before retry.");
    return result;
  });
}

export function inspectTrashLifecycleRecovery(root: string, plan: TrashLifecyclePlan): number {
  validate(plan);
  if (!checked(root, `${plan.area}/.trash`)?.stat.isDirectory() && !plan.originalTrash)
    fail("INVALID_WORKSPACE", "Allowlisted trash root is missing.");
  const prefix = classify(root, plan);
  inspectBucket(root, plan, true, prefix);
  return prefix;
}

export function inspectTrashLifecycleEntry(root: string, plan: TrashLifecyclePlan): void {
  validate(plan);
  if (plan.action !== "trash") fail("RECOVERY_CONFLICT", "Only committed trash plans can own stored entries.");
  const found = checked(root, bucket(plan));
  if (!found?.stat.isDirectory()) fail("RECOVERY_CONFLICT", "Committed trash bucket is missing.");
  const names = readdirSync(found.full).sort();
  const expected = ["metadata.json", ...plan.moves.map(move => move.slot)].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)
    || !read(root, `${bucket(plan)}/metadata.json`, 8192).equals(metadata(plan))) {
    fail("RECOVERY_CONFLICT", "Committed trash bucket contains missing or unknown data.");
  }
  for (const move of plan.moves) {
    const observed = tree(root, `${bucket(plan)}/${move.slot}`).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (JSON.stringify(observed) !== JSON.stringify(move.entries)) fail("RECOVERY_CONFLICT", "Committed trash subtree identity/content changed.");
  }
}
