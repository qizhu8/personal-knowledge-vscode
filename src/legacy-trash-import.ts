import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, posix, relative, resolve, sep } from "node:path";
import { RenameNoReplaceError, renameNoReplace } from "./rename-no-replace.js";
import { z } from "zod";
import { decodeMarkdown, type MarkdownRecord } from "./markdown.js";
import { documentId } from "./contracts.js";
import { markdownAssetDirectory, markdownReferences, localAssetReference } from "./domain/markdown-assets.js";
import {
  legacyTrashDeletionSchema, legacyTrashImportAreas, legacyTrashImportPlanSchema,
  legacyTrashImportVersion, legacyTrashMetadataSchema,
  legacyTrashSnapshotScopeSchema,
  type LegacyTrashImportPlan, type LegacyTrashInventory, type LegacyTrashImportEntry, type LegacyTrashSnapshotScope,
} from "./domain/legacy-trash-import-contracts.js";
import { deserializeTrashLifecyclePlan, serializeTrashLifecyclePlan, type TrashLifecyclePlan } from "./trash-lifecycle.js";
import { assertLinuxRootOwnerMarker } from "./linux-root-writer-fence.js";

export { legacyTrashImportSharedSeams } from "./domain/legacy-trash-import-contracts.js";
export type { LegacyTrashImportPlan } from "./domain/legacy-trash-import-contracts.js";
export type { LegacyTrashSnapshotScope } from "./domain/legacy-trash-import-contracts.js";
export const legacyTrashImportSha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const hash = legacyTrashImportSha256;
const deletionPath = ".pkm/state/knowledge-deletions.json";
export const legacyTrashStageReceiptPath = ".legacy-trash-import.json";
const receiptLimit = 32 * 1024 * 1024;
export class LegacyTrashImportError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function trashImportFail(code: string, message: string): never { throw new LegacyTrashImportError(code, message); }
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
export async function trashImportAbsent(path: string): Promise<boolean> {
  try { await lstat(path); return false; } catch (error) { if (missing(error)) return true; throw error; }
}
export async function trashImportRealDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) trashImportFail("UNSAFE_PATH", "Only real, link-free directory ancestors are authorized.");
  }
}
function safeName(name: string): void {
  if (!name || name === "." || name === ".." || /[\\\u0000-\u001f]/.test(name)
    || /secret|credential|private.?key|token|^\.env(?:\.|$)|\.(?:pem|key)$/i.test(name)) {
    trashImportFail("UNSAFE_PATH", "Secret/reserved or nonportable names are not read or imported.");
  }
}
function relativePath(path: string): void {
  if (isAbsolute(path) || path.split("/").some(part => !part || part === "." || part === "..")) {
    trashImportFail("UNSAFE_PATH", "File IO is restricted to exact relative paths under the trusted root.");
  }
  for (const part of path.split("/")) safeName(part);
}
export async function trashImportRead(root: string, path: string, maximum = 16_777_216): Promise<Buffer> {
  relativePath(path);
  await trashImportRealDirectory(dirname(join(root, path)));
  const full = join(root, path), before = await lstat(full);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) trashImportFail("UNSAFE_PATH", "Bounded regular files are required.");
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const start = await handle.stat();
    if (start.dev !== before.dev || start.ino !== before.ino || start.size !== before.size || !start.isFile()) {
      trashImportFail("SOURCE_CHANGED", "File changed before reading.");
    }
    const bytes = Buffer.alloc(start.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const end = await handle.stat(), current = await lstat(full);
    if (length !== start.size || end.size !== start.size || end.mtimeMs !== start.mtimeMs
      || end.ctimeMs !== start.ctimeMs || current.isSymbolicLink() || current.dev !== start.dev || current.ino !== start.ino) {
      trashImportFail("SOURCE_CHANGED", "File identity or content changed during read.");
    }
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
export interface TrashImportSnapshot {
  inventory: LegacyTrashInventory;
  files: Map<string, Buffer>;
}
/** Database files are never read by this walker; only the explicitly owned backup seam may omit them. */
export function qualifyLegacyTrashSnapshotScope(value: LegacyTrashSnapshotScope, native = false): LegacyTrashSnapshotScope {
  const parsed = legacyTrashSnapshotScopeSchema.safeParse(value);
  if (!parsed.success) trashImportFail("AUTHORITY_REQUIRED", "Exact bounded snapshot exclusion authority required.");
  const scope = parsed.data;
  if (new Set(scope.excludedRootNames).size !== scope.excludedRootNames.length
    || new Set(scope.excludedStateNames).size !== scope.excludedStateNames.length
    || scope.excludedRootNames.some(name => (legacyTrashImportAreas as readonly string[]).includes(name)
      || name === ".pkm" && !native || name === legacyTrashStageReceiptPath
      || /trash|journal|intent|lock|migration|secret|credential|token|private|\.tmp$/i.test(name))
    || scope.excludedStateNames.some(name => name === "knowledge-deletions.json"
      || /trash|journal|intent|lock|migration|secret|credential|token|private|\.tmp$/i.test(name))) {
    trashImportFail("AUTHORITY_REQUIRED", "Owned trash/state or pending/security-sensitive names cannot be excluded.");
  }
  return scope;
}
/** Exact trusted exclusions are never statted/read/traversed. Everything else remains
 * subject to the standalone strict inventory and selected knowledge/state fences. */
export async function snapshotLegacyTrashTree(root: string, native = false, authority?: LegacyTrashSnapshotScope): Promise<TrashImportSnapshot> {
  await trashImportRealDirectory(root);
  const scope = authority ? qualifyLegacyTrashSnapshotScope(authority, native) : undefined;
  const inventory: LegacyTrashInventory = [], files = new Map<string, Buffer>();
  let total = 0;
  async function verifyEmptyControlEvidence(path: string): Promise<void> {
    const full = join(root, path), before = await lstat(full);
    if (!before.isDirectory() || before.isSymbolicLink())
      trashImportFail("UNKNOWN_LAYOUT", "Original control-shell evidence is not a real directory.");
    const names = (await readdir(full)).sort();
    if (path === "legacy-import-evidence" ? JSON.stringify(names) !== '[".pkm"]'
      : path === "legacy-import-evidence/.pkm" ? names.length > 1 || names.length === 1 && names[0] !== "state"
      : names.length !== 0)
      trashImportFail("UNKNOWN_LAYOUT", "Original control-shell evidence contains unrecognized data.");
    for (const name of names) await verifyEmptyControlEvidence(`${path}/${name}`);
    const after = await lstat(full);
    if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || JSON.stringify((await readdir(full)).sort()) !== JSON.stringify(names))
      trashImportFail("SOURCE_CHANGED", "Original control-shell evidence changed during inventory.");
  }
  async function walk(path: string, depth: number): Promise<void> {
    if (depth > 32 || inventory.length >= 8192) trashImportFail("LIMIT", "Trash import tree exceeds its bounded inventory.");
    const name = basename(path);
    if (native && process.platform === "linux" && depth === 1 && name === ".pkm-next-writer-fenced.json") {
      await assertLinuxRootOwnerMarker(root);
      return;
    }
    if (depth === 1 && scope?.excludedRootNames.includes(name)
      || path.startsWith(".pkm/state/") && path.split("/").length === 3 && scope?.excludedStateNames.includes(name)) return;
    if (native && path === "legacy-import-evidence") {
      await verifyEmptyControlEvidence(path);
      return;
    }
    safeName(name);
    if (native && depth === 1 && ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm", legacyTrashStageReceiptPath].includes(name)) return;
    if (path === ".pkm" || path === ".pkm/state") {
      if (native) trashImportFail("UNKNOWN_LAYOUT", "Original private state cannot appear in a native projection.");
    } else if (path.startsWith(".pkm/") && path !== deletionPath) {
      trashImportFail("PENDING_OR_UNKNOWN_JOURNAL", "Original pending lock, temporary or unrecognized state blocks quiescent import.");
    } else if (depth === 1 && !(legacyTrashImportAreas as readonly string[]).includes(path)) {
      trashImportFail("UNKNOWN_LAYOUT", `Only the explicitly qualified knowledge/trash areas are imported: ${path}.`);
    } else if (name.startsWith(".") && ![".trash", ".gitkeep", ".pkm"].includes(name)) {
      trashImportFail("UNKNOWN_LAYOUT", "Unrecognized hidden data must be preserved without effects.");
    }
    const full = join(root, path), before = await lstat(full);
    if (before.isSymbolicLink() || !(before.isFile() || before.isDirectory())) trashImportFail("UNSAFE_PATH", "Symlinks and special entries are never imported.");
    if ((path === ".pkm" || path === ".pkm/state" || name === ".trash") && !before.isDirectory()) {
      trashImportFail("UNKNOWN_LAYOUT", "Reserved state and trash roots must be directories.");
    }
    const bytes = before.isFile() ? await trashImportRead(root, path) : null;
    total += bytes?.length ?? 0;
    if (total > 67_108_864) trashImportFail("LIMIT", "Import exceeds byte limit.");
    inventory.push({ path, kind: bytes === null ? "directory" : "file", dev: before.dev, ino: before.ino,
      size: bytes?.length ?? 0, sha256: bytes === null ? null : hash(bytes) });
    if (bytes) files.set(path, bytes);
    if (before.isDirectory()) {
      const names = (await readdir(full)).sort();
      if (new Set(names.map(value => value.toLowerCase())).size !== names.length) trashImportFail("COLLISION", "Case-colliding paths are not portable.");
      for (const child of names) await walk(`${path}/${child}`, depth + 1);
      const after = await lstat(full);
      if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs || JSON.stringify((await readdir(full)).sort()) !== JSON.stringify(names)) {
        trashImportFail("SOURCE_CHANGED", "Directory changed during inventory.");
      }
    }
  }
  const roots = (await readdir(root)).sort();
  if (new Set(roots.map(value => value.toLowerCase())).size !== roots.length) trashImportFail("COLLISION", "Case-colliding root paths.");
  for (const path of roots) await walk(path, 1);
  if (JSON.stringify((await readdir(root)).sort()) !== JSON.stringify(roots)) trashImportFail("SOURCE_CHANGED", "Root changed during inventory.");
  return { inventory: inventory.sort((a, b) => compare(a.path, b.path)), files };
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function parseBytes<T>(bytes: Buffer | undefined, schema: z.ZodType<T>): T {
  if (!bytes || !Buffer.from(bytes.toString("utf8")).equals(bytes)) trashImportFail("INVALID_SOURCE", "Missing or invalid UTF-8 original record.");
  try { return schema.parse(JSON.parse(bytes.toString("utf8"))); }
  catch { trashImportFail("INVALID_SOURCE", "Original record does not match the recognized strict schema."); }
}
function runtimeId(source: string, area: string, id: string): string {
  const hex = hash(JSON.stringify([legacyTrashImportVersion, source, area, id])).slice(0, 32).split("");
  hex[12] = "5"; hex[16] = "8";
  const text = hex.join("");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}
function planBody(plan: LegacyTrashImportPlan) {
  const { planSha256: _digest, ...body } = plan;
  return body;
}
export function validateLegacyTrashImportPlan(value: unknown): LegacyTrashImportPlan {
  const plan = legacyTrashImportPlanSchema.parse(value);
  if (plan.source !== resolve(plan.source) || hash(JSON.stringify(planBody(plan))) !== plan.planSha256
    || hash(JSON.stringify(plan.inventory)) !== plan.sourceSha256) trashImportFail("TAMPER", "Plan or source inventory digest changed.");
  return plan;
}
function subtree(inventory: LegacyTrashInventory, base: string) {
  return inventory.filter(entry => entry.path === base || entry.path.startsWith(base + "/"));
}
function document(bytes: Buffer, path: string, area: typeof legacyTrashImportAreas[number]): MarkdownRecord {
  if (!Buffer.from(bytes.toString("utf8")).equals(bytes)) trashImportFail("INVALID_SOURCE", "Markdown must be lossless UTF-8.");
  const probe = decodeMarkdown("probe", bytes.toString("utf8"), path, area);
  const aliases = probe.metadata.toJS({ maxAliasCount: 0 }).aliases;
  const prototypes = probe.metadata.get("schema") === "pkm.knowledge/v1" && probe.metadata.has("revision")
    && probe.metadata.has("deleted") && Array.isArray(aliases) ? [...new Set(aliases.filter((value: unknown) =>
      typeof value === "string" && value.startsWith("note:") && documentId.safeParse(value.slice(5)).success)
      .map((value: string) => value.slice(5)))] : [];
  const identity = probe.metadata.has("documentId") ? probe.metadata.get("documentId")
    : prototypes.length === 1 ? prototypes[0] : probe.metadata.get("knowledgeId");
  const filename = basename(path).replace(/\.md$/i, "");
  const id = identity === undefined ? area === "notes" && !path.includes("/") && documentId.safeParse(filename).success
    ? filename : `legacy_${hash(area === "notes" ? path : `${area}/${path}`).slice(0, 32)}` : identity;
  if (!documentId.safeParse(id).success || typeof id !== "string") trashImportFail("UNQUALIFIED_IDENTITY", "Explicit document identity is malformed; import never rewrites source bytes.");
  const result = decodeMarkdown(id, bytes.toString("utf8"), path, area);
  if (result.record.deleted || result.metadata.has("memory") || result.metadata.get("documentKind") === "todo-board"
    || basename(path).toLowerCase() === "todo board.md" || path.split("/").some(part => part.toLowerCase() === "system")) {
    trashImportFail("UNQUALIFIED_LIFECYCLE", "Board/memory/System lifecycle is not authorized by this tranche.");
  }
  return result;
}
export function legacyTrashDocuments(snapshot: TrashImportSnapshot, entries: LegacyTrashImportEntry[],
  authenticatedNativeBuckets: ReadonlySet<string> = new Set()): MarkdownRecord[] {
  const documents: MarkdownRecord[] = [];
  const paired = new Set<string>();
  for (const item of snapshot.inventory) {
    if (item.kind !== "file" || !/\.md$/i.test(item.path) || item.path.split("/").some(part => /\.assets$/i.test(part))) continue;
    const [area, ...parts] = item.path.split("/");
    if (!(legacyTrashImportAreas as readonly string[]).includes(area!) || parts[0] === ".trash") continue;
    documents.push(document(snapshot.files.get(item.path)!, parts.join("/"), area as typeof legacyTrashImportAreas[number]));
    paired.add(item.path.replace(/\.md$/i, ".assets"));
  }
  for (const entry of entries) {
    const bucket = `${entry.area}/.trash/${entry.originalId}`;
    const payload = `${bucket}/payload`;
    for (const item of subtree(snapshot.inventory, payload)) {
      if (item.kind !== "file" || entry.metadata.kind === "folder"
        && (!/\.md$/i.test(item.path) || item.path.split("/").some(part => /\.assets$/i.test(part)))) continue;
      const path = entry.metadata.originalPath + (item.path === payload ? "" : item.path.slice(payload.length));
      documents.push(document(snapshot.files.get(item.path)!, path, entry.area));
      paired.add(item.path.replace(/\.md$/i, ".assets"));
    }
  }
  const identities = new Map<string, string>();
  for (const doc of documents) {
    for (const id of new Set([doc.record.id, doc.metadata.get("knowledgeId")].filter((id): id is string => typeof id === "string"))) {
      const address = `${doc.record.area}/${doc.record.path}`;
      if (identities.has(id)) trashImportFail("COLLISION", "Active/trash document and knowledge identities must be globally unambiguous.");
      identities.set(id, address);
    }
  }
  for (const item of snapshot.inventory) {
    if (item.kind === "file" && !item.path.startsWith(".pkm/") && !item.path.includes("/.trash/")
      && !/\.md$/i.test(item.path) && !item.path.split("/").some(part => /\.assets$/i.test(part))
      && basename(item.path) !== ".gitkeep") trashImportFail("UNKNOWN_LAYOUT", "Unowned active non-Markdown data is not qualified.");
    if (item.kind === "directory" && /\.assets$/i.test(item.path) && !paired.has(item.path)
      && ![...authenticatedNativeBuckets].some(base => item.path.startsWith(base + "/"))) {
      trashImportFail("UNOWNED_ASSETS", "An asset directory has no exact Markdown owner.");
    }
  }
  const active = documents.filter(doc => snapshot.files.has(`${doc.record.area}/${doc.record.path}`));
  for (const entry of entries) {
    const paths = entry.metadata.kind === "folder" ? [entry.metadata.originalPath]
      : [markdownAssetDirectory(entry.metadata.originalPath)];
    for (const doc of active.filter(doc => doc.record.area === entry.area)) {
      for (const reference of markdownReferences(doc.raw)) {
        const local = localAssetReference(reference.value);
        if (!local) continue;
        const target = posix.normalize(posix.join(posix.dirname(doc.record.path), local));
        if (paths.some(path => target === path || target.startsWith(path + "/"))) trashImportFail("REFERENCE_CONFLICT", "Outside references fence original trash resources.");
      }
    }
  }
  return documents;
}
function buildPlan(source: string, snapshot: TrashImportSnapshot, snapshotScope?: LegacyTrashSnapshotScope): LegacyTrashImportPlan {
  const entries: LegacyTrashImportEntry[] = [];
  const deletionBytes = snapshot.files.get(deletionPath);
  const history = deletionBytes ? parseBytes(deletionBytes, legacyTrashDeletionSchema) : { schema: 1 as const, records: [] };
  const sourceSha256 = hash(JSON.stringify(snapshot.inventory));
  for (const area of legacyTrashImportAreas) {
    const trash = `${area}/.trash`;
    for (const item of snapshot.inventory.filter(item => posix.dirname(item.path) === trash)) {
      const id = basename(item.path), bucket = item.path;
      if (item.kind !== "directory" || !/^[0-9]+-[a-f0-9]{10}$/.test(id)) trashImportFail("UNKNOWN_BUCKET", "Unknown original trash bucket; preserve without effects.");
      const metadataBytes = snapshot.files.get(`${bucket}/metadata.json`);
      const metadata = parseBytes(metadataBytes, legacyTrashMetadataSchema);
      const children = snapshot.inventory.filter(child => posix.dirname(child.path) === bucket).map(child => basename(child.path)).sort();
      const expected = ["metadata.json", "payload", ...(metadata.assetsPath ? ["assets"] : [])].sort();
      if (metadata.id !== id || JSON.stringify(children) !== JSON.stringify(expected)
        || area === "skills" && metadata.kind === "item" || area !== "skills" && metadata.kind === "skill"
        || metadata.kind !== "folder" && !/\.md$/i.test(metadata.originalPath)
        || metadata.assetsPath && (metadata.kind === "folder" || metadata.assetsPath !== markdownAssetDirectory(metadata.originalPath))) {
        trashImportFail("INCOMPLETE_OR_UNKNOWN_BUCKET", "Only complete original writer metadata/payload/paired-assets state is recognized.");
      }
      const payload = snapshot.inventory.find(item => item.path === `${bucket}/payload`);
      const assets = snapshot.inventory.find(item => item.path === `${bucket}/assets`);
      if (!payload || (payload.kind === "directory") !== (metadata.kind === "folder") || assets && assets.kind !== "directory") {
        trashImportFail("INCOMPLETE_OR_UNKNOWN_BUCKET", "Payload and paired-assets kinds changed.");
      }
      if (metadata.kind === "folder" && subtree(snapshot.inventory, `${bucket}/payload`).some(item =>
        item.kind === "file" && !/\.md$/i.test(item.path) && basename(item.path) !== ".gitkeep"
        && !item.path.split("/").some(part => /\.assets$/i.test(part)))) {
        trashImportFail("UNQUALIFIED_LIFECYCLE", "Folder restore cannot introduce unowned non-Markdown files into the native reference scan.");
      }
      const targets = [`${area}/${metadata.originalPath}`, ...(metadata.assetsPath ? [`${area}/${metadata.assetsPath}`] : [])];
      if (targets.some(path => snapshot.inventory.some(item => item.path === path))) trashImportFail("COLLISION", "Original restore destination is already occupied.");
      const removedPaths = [
        ...subtree(snapshot.inventory, `${bucket}/payload`).filter(item => item.kind === "file"
          && !item.path.slice(bucket.length + 1).split("/").some(part => part.startsWith(".")))
          .map(item => `${area}/${metadata.originalPath}${item.path.slice(`${bucket}/payload`.length)}`),
        ...(metadata.assetsPath ? subtree(snapshot.inventory, `${bucket}/assets`).filter(item => item.kind === "file"
          && !item.path.slice(bucket.length + 1).split("/").some(part => part.startsWith(".")))
          .map(item => `${area}/${metadata.assetsPath}${item.path.slice(`${bucket}/assets`.length)}`) : []),
      ];
      if (removedPaths.some(path => {
        const matching = history.records.filter(record => record.path === path);
        return matching.length !== 1 || matching[0]!.deletedAt !== metadata.deletedAt;
      })) trashImportFail("UNQUALIFIED_DELETION_HISTORY", "Original ordered deletion history must exactly qualify every trash file.");
      entries.push({ area, originalId: id, runtimeId: runtimeId(sourceSha256, area, id), metadata,
        metadataBytes: metadataBytes!.toString("base64"), removedPaths });
    }
  }
  legacyTrashDocuments(snapshot, entries);
  const body = { schema: legacyTrashImportVersion, source, sourceSha256, inventory: snapshot.inventory, entries,
    deletionBytes: deletionBytes?.toString("base64") ?? null, ...(snapshotScope ? { snapshotScope } : {}) };
  const plan = { ...body, planSha256: hash(JSON.stringify(body)) };
  const translated = {
    inventory: snapshot.inventory.map(item => ({ ...item, path: translatedLegacyTrashPath(item.path, entries) })),
    files: new Map([...snapshot.files].map(([path, bytes]) => [translatedLegacyTrashPath(path, entries), bytes])),
  };
  projectLegacyTrashPlans(plan, translated, "legacy-trash-import:preflight");
  return plan;
}
export async function planLegacyTrashImport(source: string, authority?: LegacyTrashSnapshotScope): Promise<LegacyTrashImportPlan> {
  source = resolve(source);
  const scope = authority ? qualifyLegacyTrashSnapshotScope(authority) : undefined;
  return buildPlan(source, await snapshotLegacyTrashTree(source, false, scope), scope);
}
export async function verifyLegacyTrashSource(value: LegacyTrashImportPlan): Promise<TrashImportSnapshot> {
  const plan = validateLegacyTrashImportPlan(value), snapshot = await snapshotLegacyTrashTree(plan.source, false, plan.snapshotScope);
  if (JSON.stringify(buildPlan(plan.source, snapshot, plan.snapshotScope)) !== JSON.stringify(plan)) trashImportFail("SOURCE_CHANGED", "Source no longer matches its complete original quiescent plan.");
  return snapshot;
}
export interface LegacyTrashLayoutAuthority {
  source: string; destination: string; stage: string; workspaceId: string; actorId: string;
  planSha256: string; layoutVersion: "pkm.trash-lifecycle/v1";
}
const authoritySchema = z.strictObject({
  source: z.string().min(1), destination: z.string().min(1), stage: z.string().min(1),
  workspaceId: z.string().min(1), actorId: z.string().min(1).max(500),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/), layoutVersion: z.literal("pkm.trash-lifecycle/v1"),
});
export function qualifyLegacyTrashAuthority(plan: LegacyTrashImportPlan, destination: string, authority?: LegacyTrashLayoutAuthority): LegacyTrashLayoutAuthority {
  const parsed = authoritySchema.safeParse(authority);
  if (!parsed.success) trashImportFail("AUTHORITY_REQUIRED", "Only the exact recognized trusted layout authority is accepted.");
  authority = parsed.data;
  const paths = [plan.source, resolve(destination), authority?.stage ?? ""];
  const nested = (a: string, b: string) => { const p = relative(a, b); return p === "" || !isAbsolute(p) && p !== ".." && !p.startsWith(`..${sep}`); };
  if (!authority || authority.source !== plan.source || authority.destination !== resolve(destination)
    || authority.stage !== resolve(authority.stage) || dirname(authority.stage) !== dirname(authority.destination)
    || authority.planSha256 !== plan.planSha256 || authority.layoutVersion !== "pkm.trash-lifecycle/v1"
    || !authority.workspaceId || !authority.actorId || authority.actorId.length > 500
    || paths.some((a, i) => paths.some((b, j) => i !== j && nested(a, b)))) {
    trashImportFail("AUTHORITY_REQUIRED", "Exact nonoverlapping trusted layout/source/plan/workspace/actor authority is required.");
  }
  return authority;
}
export async function trashImportWrite(root: string, path: string, bytes: Buffer): Promise<void> {
  relativePath(path);
  await trashImportRealDirectory(dirname(join(root, path)));
  const handle = await open(join(root, path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
export async function trashImportSync(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function publishLegacyTrashStage(stage: string, destination: string): Promise<void> {
  await trashImportRealDirectory(stage);
  await trashImportRealDirectory(dirname(destination));
  if (!await trashImportAbsent(destination)) trashImportFail("COLLISION", "Only absent no-replace destinations are qualified.");
  try { await renameNoReplace(stage, destination); }
  catch (error) {
    if (!(error instanceof RenameNoReplaceError)) throw error;
    trashImportFail(error.code === "UNAVAILABLE" ? "UNSUPPORTED_OPERATION" : "PUBLICATION_CONFLICT", error.message);
  }
  await trashImportSync(dirname(destination));
}
function nativeMetadata(entry: LegacyTrashImportEntry): Buffer {
  return Buffer.from(JSON.stringify({
    id: entry.runtimeId, kind: entry.metadata.kind,
    name: entry.metadata.kind === "folder" || entry.area !== "skills" ? basename(entry.metadata.originalPath) : basename(entry.metadata.originalPath, ".md"),
    originalPath: entry.metadata.originalPath, deletedAt: new Date(entry.metadata.deletedAt).toISOString(),
    ...(entry.metadata.assetsPath ? { assetsPath: entry.metadata.assetsPath } : {}),
  }, null, 2) + "\n");
}
export function translatedLegacyTrashPath(path: string, entries: LegacyTrashImportEntry[]): string {
  for (const entry of entries) {
    const base = `${entry.area}/.trash/${entry.originalId}`;
    if (path === base || path.startsWith(base + "/")) return `${entry.area}/.trash/${entry.runtimeId}${path.slice(base.length)}`;
  }
  return path;
}
function expectedNativeFiles(plan: LegacyTrashImportPlan) {
  const metadata = new Set(plan.entries.map(entry => `${entry.area}/.trash/${entry.originalId}/metadata.json`));
  return plan.inventory.filter(item => !item.path.startsWith(".pkm") && !metadata.has(item.path)).map(item =>
    ({ ...item, path: translatedLegacyTrashPath(item.path, plan.entries) }));
}
export interface LegacyTrashStageReceipt {
  schema: "pkm.legacy-trash-stage/v1"; authority: LegacyTrashLayoutAuthority; plan: LegacyTrashImportPlan;
}
export interface LegacyTrashParentStageAuthority {
  stage: string;
  dev: number;
  ino: number;
  inventorySha256: string;
  excludedRootNames: string[];
  /** Parent revalidates every independently owned path, kind, bytes and root-listing
   * membership under its writer. Return the authenticated original parent inventory
   * digest, not a newly accepted inventory. Trash additions belong to this helper. */
  verifyInventory(): Promise<string>;
}
async function verifyParentStageAuthority(
  stage: string, parent: LegacyTrashParentStageAuthority | undefined, scope?: LegacyTrashSnapshotScope,
): Promise<void> {
  if (!parent || parent.stage !== stage || !Number.isSafeInteger(parent.dev) || parent.dev < 0
    || !Number.isSafeInteger(parent.ino) || parent.ino < 0 || !/^[a-f0-9]{64}$/.test(parent.inventorySha256)
    || typeof parent.verifyInventory !== "function" || !Array.isArray(parent.excludedRootNames)
    || JSON.stringify([...parent.excludedRootNames].sort()) !== JSON.stringify([...(scope?.excludedRootNames ?? [])].sort())
    || (scope?.excludedStateNames.length ?? 0) !== 0) {
    trashImportFail("AUTHORITY_REQUIRED", "Existing shared stage requires exact root/inventory ownership and independently validated excluded roots.");
  }
  await trashImportRealDirectory(stage);
  const before = await lstat(stage);
  if (before.dev !== parent.dev || before.ino !== parent.ino) trashImportFail("SOURCE_CHANGED", "Parent-owned stage root identity changed.");
  if (await parent.verifyInventory() !== parent.inventorySha256) trashImportFail("TAMPER", "Parent stage inventory differs from its trusted immutable digest.");
  const after = await lstat(stage);
  if (after.dev !== parent.dev || after.ino !== parent.ino || !after.isDirectory() || after.isSymbolicLink()) {
    trashImportFail("SOURCE_CHANGED", "Parent-owned stage root changed during inventory verification.");
  }
}
export async function stageLegacyTrashImport(
  value: LegacyTrashImportPlan, destination: string, authority?: LegacyTrashLayoutAuthority,
): Promise<LegacyTrashStageReceipt> {
  const plan = validateLegacyTrashImportPlan(value), trusted = qualifyLegacyTrashAuthority(plan, destination, authority);
  await trashImportRealDirectory(dirname(trusted.stage));
  if (!await trashImportAbsent(trusted.destination) || !await trashImportAbsent(trusted.stage)) trashImportFail("COLLISION", "Stage and destination must both be absent.");
  const snapshot = await verifyLegacyTrashSource(plan);
  const receipt: LegacyTrashStageReceipt = { schema: "pkm.legacy-trash-stage/v1", authority: trusted, plan };
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  if (receiptBytes.length > receiptLimit) trashImportFail("LIMIT", "Immutable original import receipt exceeds its byte bound.");
  await mkdir(trusted.stage, { mode: 0o700 });
  await trashImportWrite(trusted.stage, legacyTrashStageReceiptPath, receiptBytes);
  for (const item of expectedNativeFiles(plan).filter(item => item.kind === "directory").sort((a, b) =>
    a.path.split("/").length - b.path.split("/").length || compare(a.path, b.path))) {
    await mkdir(join(trusted.stage, item.path), { mode: 0o700 });
  }
  for (const area of legacyTrashImportAreas) {
    if (await trashImportAbsent(join(trusted.stage, area))) await mkdir(join(trusted.stage, area), { mode: 0o700 });
    if (await trashImportAbsent(join(trusted.stage, area, ".trash"))) await mkdir(join(trusted.stage, area, ".trash"), { mode: 0o700 });
  }
  for (const item of plan.inventory.filter(item => item.kind === "file" && !item.path.startsWith(".pkm"))) {
    const entry = plan.entries.find(entry => item.path === `${entry.area}/.trash/${entry.originalId}/metadata.json`);
    await trashImportWrite(trusted.stage, translatedLegacyTrashPath(item.path, plan.entries), entry ? nativeMetadata(entry) : snapshot.files.get(item.path)!);
  }
  // No removal/rollback even on failure: only an exact completed stage is recognized.
  await verifyLegacyTrashSource(plan);
  await verifyLegacyTrashStage(plan, trusted.stage, trusted);
  const dirs = (await snapshotLegacyTrashTree(trusted.stage, true)).inventory.filter(item => item.kind === "directory")
    .sort((a, b) => b.path.split("/").length - a.path.split("/").length);
  for (const dir of dirs) await trashImportSync(join(trusted.stage, dir.path));
  await trashImportSync(trusted.stage); await trashImportSync(dirname(trusted.stage));
  return receipt;
}
/** The shared importer already owns this stage and its writer. This bounded seam
 * validates every existing selected path before adding only absent projection bytes.
 * It neither publishes nor removes anything, including after interruption. */
export async function populateLegacyTrashImportStage(
  value: LegacyTrashImportPlan, destination: string, authority: LegacyTrashLayoutAuthority,
  nativeScope?: LegacyTrashSnapshotScope,
  parentStageAuthority?: LegacyTrashParentStageAuthority,
): Promise<LegacyTrashStageReceipt> {
  const plan = validateLegacyTrashImportPlan(value), trusted = qualifyLegacyTrashAuthority(plan, destination, authority);
  if (nativeScope) qualifyLegacyTrashSnapshotScope(nativeScope, true);
  await trashImportRealDirectory(trusted.stage);
  if (!await trashImportAbsent(trusted.destination)) trashImportFail("COLLISION", "Shared import destination must remain absent.");
  await verifyParentStageAuthority(trusted.stage, parentStageAuthority, nativeScope);
  const source = await verifyLegacyTrashSource(plan);
  const receipt: LegacyTrashStageReceipt = { schema: "pkm.legacy-trash-stage/v1", authority: trusted, plan };
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  if (receiptBytes.length > receiptLimit) trashImportFail("LIMIT", "Immutable original import receipt exceeds its byte bound.");
  const expected = expectedNativeFiles(plan);
  const bytes = new Map<string, Buffer>();
  for (const item of plan.inventory.filter(item => item.kind === "file" && !item.path.startsWith(".pkm"))) {
    const entry = plan.entries.find(entry => item.path === `${entry.area}/.trash/${entry.originalId}/metadata.json`);
    bytes.set(translatedLegacyTrashPath(item.path, plan.entries), entry ? nativeMetadata(entry) : source.files.get(item.path)!);
  }
  for (const area of legacyTrashImportAreas) {
    for (const path of [area, `${area}/.trash`]) if (!expected.some(item => item.path === path)) {
      expected.push({ path, kind: "directory", dev: 0, ino: 0, size: 0, sha256: null });
    }
  }
  for (const entry of plan.entries) {
    const path = `${entry.area}/.trash/${entry.runtimeId}/metadata.json`, content = bytes.get(path)!;
    expected.push({ path, kind: "file", dev: 0, ino: 0, size: content.length, sha256: hash(content) });
  }
  if (!await trashImportAbsent(join(trusted.stage, legacyTrashStageReceiptPath))) {
    if (!(await trashImportRead(trusted.stage, legacyTrashStageReceiptPath, receiptLimit)).equals(receiptBytes)) {
      trashImportFail("TAMPER", "Existing stage marker is not the exact importer-owned receipt.");
    }
    await verifyLegacyTrashStage(plan, trusted.stage, trusted, nativeScope);
    await verifyParentStageAuthority(trusted.stage, parentStageAuthority, nativeScope);
    return receipt;
  }
  const existing = await snapshotLegacyTrashTree(trusted.stage, true, nativeScope);
  for (const item of existing.inventory) {
    const target = expected.find(target => target.path === item.path);
    if (!target || JSON.stringify(portable([item])) !== JSON.stringify(portable([target]))) {
      trashImportFail("COLLISION", "Shared stage contains unknown or conflicting selected knowledge/trash paths.");
    }
    await verifyParentStageAuthority(trusted.stage, parentStageAuthority, nativeScope);
  }
  // Fully preflight the entire selected stage before any mkdir/write. Pre-existing
  // active Markdown/assets must match source bytes exactly; never rewrite them.
  for (const item of expected.filter(item => item.kind === "directory").sort((a, b) =>
    a.path.split("/").length - b.path.split("/").length || compare(a.path, b.path))) {
    if (await trashImportAbsent(join(trusted.stage, item.path))) await mkdir(join(trusted.stage, item.path), { mode: 0o700 });
  }
  for (const [path, content] of bytes) {
    if (await trashImportAbsent(join(trusted.stage, path))) await trashImportWrite(trusted.stage, path, content);
  }
  await verifyLegacyTrashSource(plan);
  await verifyParentStageAuthority(trusted.stage, parentStageAuthority, nativeScope);
  await trashImportWrite(trusted.stage, legacyTrashStageReceiptPath, receiptBytes);
  await verifyLegacyTrashStage(plan, trusted.stage, trusted, nativeScope);
  for (const item of expected.filter(item => item.kind === "directory").sort((a, b) =>
    b.path.split("/").length - a.path.split("/").length)) await trashImportSync(join(trusted.stage, item.path));
  await trashImportSync(trusted.stage);
  await verifyParentStageAuthority(trusted.stage, parentStageAuthority, nativeScope);
  return receipt;
}
const portable = (inventory: LegacyTrashInventory) => inventory.map(({ dev: _dev, ino: _ino, ...entry }) => entry);
export async function verifyLegacyTrashStage(
  value: LegacyTrashImportPlan, root: string, authority?: LegacyTrashLayoutAuthority,
  nativeScope?: LegacyTrashSnapshotScope,
): Promise<TrashImportSnapshot> {
  const plan = validateLegacyTrashImportPlan(value), trusted = qualifyLegacyTrashAuthority(plan, authority?.destination ?? root, authority);
  if (resolve(root) !== trusted.stage && resolve(root) !== trusted.destination) trashImportFail("AUTHORITY_REQUIRED", "Unqualified stage address.");
  const receipt = parseBytes(await trashImportRead(root, legacyTrashStageReceiptPath, receiptLimit), z.unknown());
  if (JSON.stringify(receipt) !== JSON.stringify({ schema: "pkm.legacy-trash-stage/v1", authority: trusted, plan })) trashImportFail("TAMPER", "Stage ownership/immutable receipt is not recognized.");
  const snapshot = await snapshotLegacyTrashTree(root, true, nativeScope);
  const expected = expectedNativeFiles(plan);
  for (const area of legacyTrashImportAreas) {
    for (const path of [area, `${area}/.trash`]) if (!expected.some(item => item.path === path)) expected.push({ path, kind: "directory", dev: 0, ino: 0, size: 0, sha256: null });
  }
  for (const entry of plan.entries) {
    const bytes = nativeMetadata(entry);
    expected.push({ path: `${entry.area}/.trash/${entry.runtimeId}/metadata.json`, kind: "file", dev: 0, ino: 0, size: bytes.length, sha256: hash(bytes) });
  }
  if (JSON.stringify(portable(expected.sort((a, b) => compare(a.path, b.path)))) !== JSON.stringify(portable(snapshot.inventory))) {
    trashImportFail("TAMPER", "Stage contains missing, altered or unowned bytes/paths.");
  }
  return snapshot;
}
export async function inspectLegacyTrashImportRecovery(
  plan: LegacyTrashImportPlan, authority?: LegacyTrashLayoutAuthority,
): Promise<"staged" | "published" | "not-started"> {
  const trusted = qualifyLegacyTrashAuthority(validateLegacyTrashImportPlan(plan), authority?.destination ?? "", authority);
  await verifyLegacyTrashSource(plan);
  const stageAbsent = await trashImportAbsent(trusted.stage), destinationAbsent = await trashImportAbsent(trusted.destination);
  if (stageAbsent && destinationAbsent) return "not-started";
  if (!stageAbsent && !destinationAbsent) trashImportFail("RECOVERY_CONFLICT", "Both stage and destination exist; no inferred ownership or cleanup.");
  await verifyLegacyTrashStage(plan, stageAbsent ? trusted.destination : trusted.stage, trusted);
  return stageAbsent ? "published" : "staged";
}
export function projectLegacyTrashPlans(
  plan: LegacyTrashImportPlan, snapshot: TrashImportSnapshot, actorId: string,
): TrashLifecyclePlan[] {
  const sourceSnapshot = { inventory: plan.inventory, files: new Map<string, Buffer>() };
  for (const item of plan.inventory.filter(item => item.kind === "file" && !item.path.startsWith(".pkm"))) {
    sourceSnapshot.files.set(item.path, snapshot.files.get(translatedLegacyTrashPath(item.path, plan.entries))!);
  }
  const docs = legacyTrashDocuments(sourceSnapshot, plan.entries);
  const pin = (doc: MarkdownRecord) => ({ id: doc.record.id, area: doc.record.area, path: doc.record.path, revision: doc.record.revision, sha256: doc.record.sha256 });
  const active = docs.filter(doc => snapshot.files.has(`${doc.record.area}/${doc.record.path}`));
  return plan.entries.map(entry => {
    const owners = docs.filter(doc => doc.record.area === entry.area && (doc.record.path === entry.metadata.originalPath
      || entry.metadata.kind === "folder" && doc.record.path.startsWith(entry.metadata.originalPath + "/"))).map(pin).sort((a, b) => compare(a.id, b.id));
    const referencePins = [...active.map(pin), ...owners].sort((a, b) => compare(a.id, b.id));
    const moves: TrashLifecyclePlan["moves"] = [
      ...(entry.metadata.assetsPath ? [{ originalPath: entry.metadata.assetsPath, slot: "assets" as const }] : []),
      { originalPath: entry.metadata.originalPath, slot: "payload" as const },
    ].map(move => {
      const base = `${entry.area}/.trash/${entry.runtimeId}/${move.slot}`;
      return { ...move, entries: subtree(snapshot.inventory, base).map(item => ({
        path: item.path === base ? "" : item.path.slice(base.length + 1), kind: item.kind,
        dev: item.dev, ino: item.ino, size: item.size, sha256: item.sha256,
      })).sort((a, b) => compare(a.path, b.path)) };
    });
    const native: TrashLifecyclePlan = {
      kind: "trash-lifecycle", version: 1, operationId: entry.runtimeId, entryId: entry.runtimeId, actorId,
      action: "trash", area: entry.area, path: entry.metadata.originalPath,
      targetKind: entry.metadata.kind === "folder" ? "folder" : "document",
      deletedAt: new Date(entry.metadata.deletedAt).toISOString(),
      expectedTreeSha256: hash(JSON.stringify(moves)), expectedScanRevision: hash(JSON.stringify(referencePins)),
      documentPins: owners, referencePins, moves, requiresCompoundJournal: true,
    };
    return deserializeTrashLifecyclePlan(serializeTrashLifecyclePlan(native));
  });
}
