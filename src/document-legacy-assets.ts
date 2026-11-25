import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { checkedResourcePath, resourcePath, type KnowledgeArea } from "./document-path.js";
import { sha256 } from "./file-write.js";
import { knowledgeReadPrivateTopLevels } from "./fresh-note-query-contracts.js";
import { documentLifecycleLimits as limits } from "./document-lifecycle-contracts.js";
import { localAssetReference, markdownReferences, rewriteMarkdownAssetReferences } from "./domain/markdown-assets.js";
import type { MarkdownRecord } from "./markdown.js";
import {
  privateResourcePublicationProvenanceSchema, validatePrivateResourcePublicationProvenance,
} from "./private-resource-publication-contracts.js";
import {
  privatePublicationProvenanceForPlan, privatePublicationOperationActive,
  assertPrivateResourcePublicationAttempt, type PrivateResourcePublicationAttempt,
} from "./private-resource-publication-native.js";

export const legacyAssetCopySchema = z.strictObject({
  source: resourcePath, target: resourcePath, sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive().max(limits.fileBytes), sourceIdentity: z.string().min(1).max(512),
  disposition: z.enum(["remove", "retain"]).optional(),
  visibility: z.literal("private").optional(), publication: privateResourcePublicationProvenanceSchema.optional(),
});
export type LegacyAssetCopy = z.infer<typeof legacyAssetCopySchema>;
export const legacyAssetDispositionProtocol = "pkm.document-legacy-assets.dispositions/v2" as const;
export const legacyAssetDisposition = (copy: LegacyAssetCopy): "remove" | "retain" => copy.disposition ?? "remove";
function fail(code: string, message: string): never { throw new CoreError(code, message); }
const identity = (stat: Stats) =>
  [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
function sourcePath(areaRoot: string, owner: string, local: string) {
  const path = relative(areaRoot, resolve(areaRoot, dirname(owner), local)).replaceAll("\\", "/");
  if (path === ".." || path.startsWith("../") || !resourcePath.safeParse(path).success)
    fail("INVALID_DOCUMENT", "Legacy asset references must remain within their checked content area.");
  return path;
}
export function documentHasLegacyAssetReferences(raw: string): boolean {
  return markdownReferences(raw).some(reference => localAssetReference(reference.value)?.split(/[\\/]/).includes("_assets"));
}
export function legacyAssetReferenceSources(root: string, area: KnowledgeArea, owner: string, raw: string): string[] {
  return [...new Set(markdownReferences(raw).flatMap(reference => {
    const local = localAssetReference(reference.value);
    return local?.split(/[\\/]/).includes("_assets") ? [sourcePath(resolve(root, area), owner, local)] : [];
  }))];
}
/** Denial-only path comparison. Never opens private bytes or turns an existing reference into publication authority. */
export function assertNoNewPrivateResourceReferences(root: string, area: KnowledgeArea, owner: string,
  before: string | undefined, submitted: string): void {
  const privateTargets = (raw: string) => new Set(markdownReferences(raw).flatMap(reference => {
    const local = localAssetReference(reference.value);
    if (!local) return [];
    const target = resolve(root, area, dirname(owner), local), address = relative(root, target).replaceAll("\\", "/");
    const [targetArea, top] = address.split("/");
    if (!["notes", "skills", "papers"].includes(targetArea!) || !top
      || !knowledgeReadPrivateTopLevels(root, targetArea!).has(top)) return [];
    return [target];
  }));
  const existing = privateTargets(before ?? "");
  if ([...privateTargets(submitted)].some(target => !existing.has(target)))
    fail("ACCESS_DENIED", "New private resource references require separate source review; no private reference or publication was adopted.");
}
function assertSourcePublic(root: string, area: KnowledgeArea, source: string) {
  if (knowledgeReadPrivateTopLevels(root, area).has(source.split("/")[0]!))
    fail("ACCESS_DENIED", "A public move cannot publish retained private legacy asset bytes.");
}
function readAsset(root: string, area: KnowledgeArea, source: string, privateProof = false) {
  if (process.platform !== "linux" || !process.getuid) fail("UNSUPPORTED_OPERATION", "Owned legacy asset migration is qualified only on Linux.");
  if (resolve(root) !== root) fail("INVALID_DOCUMENT", "Legacy asset root must be an exact canonical workspace path.");
  if (!privateProof) assertSourcePublic(root, area, source);
  const path = checkedResourcePath(root, source, false, area), before = lstatSync(path);
  for (let parent = dirname(path); parent !== root; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || stat.mode & 0o7002)
      fail("INVALID_DOCUMENT", "Legacy asset parents must remain real owned directories with safe modes.");
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid!()
    || before.mode & 0o7002 || before.size <= 0 || before.size > limits.fileBytes)
    fail("INVALID_DOCUMENT", "Legacy assets must be bounded, owned, nonempty single-link regular files.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (identity(before) !== identity(fstatSync(fd))) fail("CONFLICT", "Legacy asset identity changed while opening.");
    const buffer = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const size = readSync(fd, buffer, used, buffer.length - used, used);
      if (!size) break;
      used += size;
    }
    const after = fstatSync(fd), bytes = buffer.subarray(0, used);
    if (identity(before) !== identity(after) || identity(before) !== identity(lstatSync(path)) || used !== before.size)
      fail("CONFLICT", "Legacy asset changed during its bounded read.");
    return { bytes, sha256: sha256(bytes), size: bytes.length, sourceIdentity: identity(before) };
  } finally { closeSync(fd); }
}
export function readPinnedLegacyAsset(root: string, area: KnowledgeArea, copy: LegacyAssetCopy): Buffer {
  if (copy.visibility === "private") fail("ACCESS_DENIED", "Private resource bytes require their current publication attempt.");
  const asset = readAsset(root, area, copy.source);
  if (asset.sha256 !== copy.sha256 || asset.size !== copy.size || asset.sourceIdentity !== copy.sourceIdentity)
    fail("RECOVERY_CONFLICT", "Legacy source asset no longer matches its exact approved move intent.");
  return asset.bytes;
}
export function privateLegacyAssetProof(root: string, area: KnowledgeArea, source: string) {
  if (!knowledgeReadPrivateTopLevels(root, area).has(source.split("/")[0]!))
    fail("INVALID_DOCUMENT", "A private resource proof must match the unchanged private policy.");
  const { bytes: _bytes, ...proof } = readPrivateAsset(root, area, source);
  return proof;
}
function readPrivateAsset(root: string, area: KnowledgeArea, source: string) {
  try { return readAsset(root, area, source, true); }
  catch (error) {
    fail(error instanceof CoreError ? error.code : "INVALID_DOCUMENT",
      "The checked private resource is unavailable or changed; no private source details were published.");
  }
}
export function assertPinnedLegacyAsset(root: string, area: KnowledgeArea, copy: LegacyAssetCopy) {
  const asset = copy.visibility === "private" ? privateLegacyAssetProof(root, area, copy.source) : readAsset(root, area, copy.source);
  if (asset.sha256 !== copy.sha256 || asset.size !== copy.size || asset.sourceIdentity !== copy.sourceIdentity)
    fail("RECOVERY_CONFLICT", copy.visibility === "private" ? "Private source no longer matches its exact publication intent."
      : "Legacy source asset no longer matches its exact approved move intent.");
}
export function readPrivateLegacyAssetForPublication(root: string, area: KnowledgeArea, copy: LegacyAssetCopy,
  attempt: PrivateResourcePublicationAttempt): Buffer {
  if (copy.visibility !== "private" || !copy.publication) fail("ACCESS_DENIED", "Private publication cannot use an unqualified asset plan.");
  const provenance = validatePrivateResourcePublicationProvenance(copy.publication);
  if (provenance.subject.root !== root || provenance.subject.owner.area !== area || provenance.subject.resource.sourcePath !== copy.source
    || provenance.subject.resource.sha256 !== copy.sha256 || provenance.subject.resource.sourceIdentity !== copy.sourceIdentity)
    fail("ACCESS_DENIED", "Private source bytes do not match their exact publication subject.");
  assertPrivateResourcePublicationAttempt(attempt, provenance.subject);
  const asset = readPrivateAsset(root, area, copy.source);
  if (asset.sha256 !== copy.sha256 || asset.size !== copy.size || asset.sourceIdentity !== copy.sourceIdentity)
    fail("RECOVERY_CONFLICT", "Private source changed before its exact publication.");
  assertPrivateResourcePublicationAttempt(attempt, provenance.subject); return asset.bytes;
}
function sharedLegacySources(root: string, area: KnowledgeArea, owner: string,
  copies: readonly LegacyAssetCopy[], documents: readonly MarkdownRecord[]): Set<string> {
  const sources = copies.map(copy => ({ source: copy.source, full: resolve(root, area, copy.source) })), shared = new Set<string>();
  for (const document of documents) {
    if (document.record.area === area && document.record.path === owner) continue;
    for (const reference of markdownReferences(document.raw)) {
      const local = localAssetReference(reference.value);
      if (!local) continue;
      const target = resolve(root, document.record.area, dirname(document.record.path), local);
      for (const source of sources) {
        if (target === source.full) shared.add(source.source);
        else if (target.startsWith(source.full + sep))
          fail("CONFLICT", "A legacy file has an unsupported descendant reference; no referrers were changed.");
      }
    }
  }
  return shared;
}
export function assertLegacyAssetDispositions(root: string, area: KnowledgeArea, owner: string,
  copies: readonly LegacyAssetCopy[], documents: readonly MarkdownRecord[]) {
  const shared = sharedLegacySources(root, area, owner, copies, documents);
  for (const copy of copies)
    if (legacyAssetDisposition(copy) !== (copy.visibility === "private" || shared.has(copy.source) ? "retain" : "remove"))
      fail("RECOVERY_CONFLICT", "Legacy source disposition no longer derives from its complete reference proof.");
}
export function planLegacyAssetCopies(root: string, area: KnowledgeArea, owner: string, raw: string,
  documents: readonly MarkdownRecord[], publicationOwner?: { operationId: string; actorId: string;
    id: string; revision: number; sha256: string; afterPath: string }): LegacyAssetCopy[] {
  const areaRoot = resolve(root, area), copies = new Map<string, LegacyAssetCopy>();
  let bytes = 0;
  for (const reference of markdownReferences(raw)) {
    const local = localAssetReference(reference.value);
    if (!local || !local.split(/[\\/]/).includes("_assets")) continue;
    const source = sourcePath(areaRoot, owner, local);
    if (source.split("/").some(part => /\.assets$/i.test(part)))
      fail("UNSUPPORTED_OPERATION", "Legacy sources within a paired resource tree require a separate ownership migration.");
    if (copies.has(source)) continue;
    if (copies.size >= limits.assetEntries) fail("INVALID_WORKSPACE", "Legacy asset migration exceeds its bounded file count.");
    const privateSource = knowledgeReadPrivateTopLevels(root, area).has(source.split("/")[0]!);
    if (privateSource && (!publicationOwner || !privatePublicationOperationActive(root, publicationOwner.operationId, publicationOwner.actorId)))
      fail("ACCESS_DENIED", "Private resource publication remains default-denied.");
    const asset = privateSource ? privateLegacyAssetProof(root, area, source) : readAsset(root, area, source);
    bytes += asset.size;
    if (bytes > limits.assetBytes) fail("INVALID_WORKSPACE", "Legacy asset migration exceeds its bounded byte limit.");
    const extension = extname(source).toLowerCase();
    if (extension && !/^\.[a-z0-9]{1,16}$/.test(extension))
      fail("UNSUPPORTED_OPERATION", "The legacy resource extension is outside the portable migration profile.");
    const target = `${asset.sha256.slice(0, 16)}${extension}`;
    const publication = privateSource ? privatePublicationProvenanceForPlan(root, publicationOwner!.operationId,
      publicationOwner!.actorId, { area, id: publicationOwner!.id, beforePath: owner, afterPath: publicationOwner!.afterPath,
        revision: publicationOwner!.revision, sha256: publicationOwner!.sha256 },
      { sourcePath: source, targetPath: `${publicationOwner!.afterPath.replace(/\.md$/i, ".assets")}/${target}`,
        sha256: asset.sha256, size: asset.size, sourceIdentity: asset.sourceIdentity }) : undefined;
    copies.set(source, { source, target, sha256: asset.sha256, size: asset.size, sourceIdentity: asset.sourceIdentity,
      ...(publication ? { visibility: "private" as const, publication, disposition: "retain" as const } : {}) });
  }
  const result = [...copies.values()];
  const shared = sharedLegacySources(root, area, owner, result, documents);
  return result.map(copy => shared.has(copy.source) ? { ...copy, disposition: "retain" as const } : copy);
}
export function rewriteLegacyAssetReferences(root: string, area: KnowledgeArea, owner: string,
  raw: string, copies: readonly LegacyAssetCopy[]): string {
  const areaRoot = resolve(root, area), bySource = new Map(copies.map(copy => [copy.source, copy]));
  return rewriteMarkdownAssetReferences(raw, local => {
    if (!local.split(/[\\/]/).includes("_assets")) return local;
    const source = sourcePath(areaRoot, owner, local), copy = bySource.get(source);
    if (!copy) fail("UNSUPPORTED_OPERATION", "New or unreconciled legacy resource references require separate source review.");
    return relative(dirname(join(areaRoot, owner)), join(areaRoot, owner.replace(/\.md$/i, ".assets"), copy.target)).replaceAll("\\", "/");
  });
}
