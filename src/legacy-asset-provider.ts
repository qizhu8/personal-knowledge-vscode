import { createHash } from "node:crypto";
import { z } from "zod";
import type { Actor } from "./contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const nativeAssetDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const scriptId = z.string().regex(/^script_[A-Za-z0-9._-]+$/);
const projectId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const sourcePath = z.string().min(1).max(2048).refine(isSafeRelativePath);
const legacyAlias = z.string().min(1).max(2048);
const legacyEntry = z.strictObject({
  area: z.enum(["scripts", "projects"]),
  relativePath: sourcePath,
  slug: z.string().min(1).max(256),
  title: z.string().max(512),
  sourceRevision: digest,
  knowledgeId: scriptId.optional(),
  aliases: z.array(legacyAlias).max(10_000).optional(),
});
const legacyPins = z.strictObject({ scripts: digest, projects: digest });
const legacyScope = z.strictObject({
  workspaceId: z.string().min(1).max(256),
  sourceRootId: digest,
});

export const legacyScriptProjectSnapshot = z.strictObject({
  schema: z.literal("pkm.legacy-script-project-links/v1"),
  scope: legacyScope,
  pins: legacyPins,
  entries: z.array(legacyEntry).max(4096),
});
export type LegacyScriptProjectSnapshot = z.infer<typeof legacyScriptProjectSnapshot>;
export type LegacyScriptProjectEntry = z.infer<typeof legacyEntry>;
export type LegacyScriptProjectPins = z.infer<typeof legacyPins>;

export const legacyScriptProjectSnapshotInput = z.strictObject({
  scope: legacyScope,
  scripts: z.array(legacyEntry.omit({ area: true })).max(4096),
  projects: z.array(legacyEntry.omit({ area: true, knowledgeId: true, aliases: true })).max(4096),
});
export type LegacyScriptProjectSnapshotInput = z.infer<typeof legacyScriptProjectSnapshotInput>;

export const legacyScriptProjectResolveInput = z.strictObject({
  locator: z.string().min(1).max(2048),
  snapshot: legacyScriptProjectSnapshot,
  expectedPins: legacyPins.optional(),
});
export type LegacyScriptProjectResolveInput = z.infer<typeof legacyScriptProjectResolveInput>;

export const legacyScriptProjectResolveOutput = z.strictObject({
  snapshotPins: legacyPins,
  resolved: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("panel"),
      locator: z.string(),
      type: z.literal("script"),
      key: sourcePath,
      tab: z.literal("scripts"),
      title: z.string(),
    }),
    z.strictObject({
      kind: z.literal("entity"),
      locator: z.string(),
      area: z.literal("projects"),
      id: projectId,
      title: z.string(),
    }),
  ]),
});
export type LegacyScriptProjectResolveOutput = z.infer<typeof legacyScriptProjectResolveOutput>;

export const nativeAssetOwnershipSnapshot = z.strictObject({
  id: z.string().min(1).max(512),
  workspaceId: z.string().min(1).max(256),
  sourceRootId: digest,
  area: z.enum(["notes", "skills", "papers"]),
  documentSha256: digest,
  revision: digest,
  items: z.array(z.strictObject({
    area: z.enum(["notes", "skills", "papers"]),
    path: sourcePath,
    digest: nativeAssetDigest,
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })).max(2048),
});
export type NativeAssetOwnershipSnapshot = z.infer<typeof nativeAssetOwnershipSnapshot>;

export const nativeAssetOwnershipInput = z.strictObject({
  snapshots: z.array(nativeAssetOwnershipSnapshot).max(4096),
  path: sourcePath,
  expectedDocumentSha256: digest,
  expectedAssetDigest: nativeAssetDigest,
  expectedRevision: digest,
});
export type NativeAssetOwnershipInput = z.infer<typeof nativeAssetOwnershipInput>;

export const nativeAssetOwnershipOutput = z.strictObject({
  ownerId: z.string(),
  area: z.enum(["notes", "skills", "papers"]),
  path: sourcePath,
  documentSha256: digest,
  assetDigest: nativeAssetDigest,
  revision: digest,
});
export type NativeAssetOwnershipOutput = z.infer<typeof nativeAssetOwnershipOutput>;

const classificationEvidence = z.strictObject({
  dimension: z.string(),
  rule: z.string(),
  confidence: z.number(),
});
const classificationProposal = z.strictObject({
  id: digest,
  type: z.enum(["classification", "duplicate", "near-duplicate", "correction"]),
  asset: sourcePath,
  locator: z.string().min(1).max(2048),
  hash: digest,
  target: sourcePath,
  targetHash: digest.nullable(),
  classification: z.record(z.string(), z.string()),
  evidence: z.array(classificationEvidence),
  relatedAsset: sourcePath.optional(),
  suggestion: z.string().optional(),
});
export const legacyClassificationPreview = z.strictObject({
  id: digest,
  root: z.string().min(1).max(4096),
  proposals: z.array(classificationProposal).max(5000),
  skipped: z.number().int().nonnegative(),
  truncated: z.boolean(),
  modelCalls: z.literal(0),
});
export type LegacyClassificationPreview = z.infer<typeof legacyClassificationPreview>;

const journalEntry = z.strictObject({
  id: digest,
  asset: sourcePath,
  target: sourcePath,
  before: z.string().nullable(),
  beforeHash: digest.nullable(),
  afterHash: digest,
  mode: z.number().int().min(0).max(0o777),
});
export const legacyClassificationJournal = z.strictObject({
  schema: z.literal(1),
  entries: z.array(journalEntry).max(5000),
});
export type LegacyClassificationJournal = z.infer<typeof legacyClassificationJournal>;

export const classificationTargetObservation = z.strictObject({
  path: sourcePath,
  kind: z.enum(["regular-file", "directory", "symlink", "missing", "other"]),
  digest: digest.nullable(),
});
export const legacyClassificationRollbackInput = z.strictObject({
  journalId: z.string().regex(/^[a-f0-9-]{36}$/),
  journal: legacyClassificationJournal,
  expectedJournalDigest: digest,
  observations: z.array(classificationTargetObservation).max(20_000),
});
export type LegacyClassificationRollbackInput = z.infer<typeof legacyClassificationRollbackInput>;

export const legacyClassificationRollbackOutput = z.strictObject({
  journalId: z.string(),
  safeToRollback: z.boolean(),
  entries: z.array(z.strictObject({
    id: digest,
    target: sourcePath,
    status: z.enum(["ready-to-restore", "already-restored-or-not-written", "changed-since-apply", "unsafe-or-unavailable"]),
  })).max(5000),
});
export type LegacyClassificationRollbackOutput = z.infer<typeof legacyClassificationRollbackOutput>;

export interface LegacyAssetProviderContext {
  actor: Actor;
  workspaceId: string;
  sourceRootId: string;
  sourceRootPath: string;
}

export interface LegacyAssetProviderCallbacks {
  readOriginalClassificationPreview?: (sourceRootPath: string) => LegacyClassificationPreview;
}

export class LegacyAssetProviderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LegacyAssetProviderError";
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\\") || /[\x00-\x1f:]/.test(value)) return false;
  const parts = value.split("/");
  return parts.every(part => !!part && part !== "." && part !== "..");
}

function compareEntries(left: LegacyScriptProjectEntry, right: LegacyScriptProjectEntry): number {
  return Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath))
    || Buffer.compare(Buffer.from(left.slug), Buffer.from(right.slug));
}

function assertContext(context: LegacyAssetProviderContext): void {
  if (!context?.actor?.id || context.actor.id.length > 256 || !context.workspaceId || context.workspaceId.length > 256
    || !digest.safeParse(context.sourceRootId).success || !context.sourceRootPath || context.sourceRootPath.length > 4096) {
    throw new LegacyAssetProviderError("INVALID_CONTEXT", "Trusted native actor, workspace, and source-root context are required.");
  }
}

function assertScope(scope: z.infer<typeof legacyScope>, context: LegacyAssetProviderContext): void {
  if (scope.workspaceId !== context.workspaceId || scope.sourceRootId !== context.sourceRootId) {
    throw new LegacyAssetProviderError("SOURCE_SCOPE_MISMATCH", "Legacy source inventory belongs to another workspace or Knowledge Root.");
  }
}

function sourcePins(entries: readonly LegacyScriptProjectEntry[], scope: z.infer<typeof legacyScope>): LegacyScriptProjectPins {
  const scopedPin = (area: "scripts" | "projects") => sha256(JSON.stringify([
    scope.workspaceId,
    scope.sourceRootId,
    [...entries].filter(entry => entry.area === area).sort(compareEntries).map(entry => ({
      area: entry.area,
      relativePath: entry.relativePath,
      slug: entry.slug,
      title: entry.title,
      sourceRevision: entry.sourceRevision,
      ...(entry.knowledgeId !== undefined ? { knowledgeId: entry.knowledgeId } : {}),
      ...(entry.aliases !== undefined ? { aliases: entry.aliases } : {}),
    })),
  ]));
  return { scripts: scopedPin("scripts"), projects: scopedPin("projects") };
}

function validateSnapshot(snapshot: LegacyScriptProjectSnapshot, context: LegacyAssetProviderContext): LegacyScriptProjectSnapshot {
  const parsed = legacyScriptProjectSnapshot.safeParse(snapshot);
  if (!parsed.success) throw new LegacyAssetProviderError("INVALID_SNAPSHOT", "Legacy Script/Project source snapshot is invalid.");
  assertScope(parsed.data.scope, context);
  const pins = sourcePins(parsed.data.entries, parsed.data.scope);
  if (pins.scripts !== parsed.data.pins.scripts || pins.projects !== parsed.data.pins.projects) {
    throw new LegacyAssetProviderError("SNAPSHOT_MISMATCH", "Legacy Script/Project source snapshot no longer matches its pins.");
  }
  if (parsed.data.entries.some(entry => entry.area === "scripts"
    ? !entry.slug || (entry.knowledgeId !== undefined && !/^script_[A-Za-z0-9._-]+$/.test(entry.knowledgeId))
    : !projectId.safeParse(entry.slug).success || entry.knowledgeId !== undefined || entry.aliases !== undefined)) {
    throw new LegacyAssetProviderError("INVALID_SNAPSHOT", "Legacy Script/Project source entry has an invalid identity.");
  }
  return parsed.data;
}

export function buildLegacyScriptProjectSnapshot(input: LegacyScriptProjectSnapshotInput): LegacyScriptProjectSnapshot {
  const parsed = legacyScriptProjectSnapshotInput.safeParse(input);
  if (!parsed.success) throw new LegacyAssetProviderError("INVALID_SNAPSHOT", "Legacy Script/Project source inventory is invalid.");
  const scripts = parsed.data.scripts.map(entry => ({ ...entry, area: "scripts" as const }));
  const projects = parsed.data.projects.map(entry => ({ ...entry, area: "projects" as const }));
  const entries = [...scripts, ...projects].sort(compareEntries);
  return legacyScriptProjectSnapshot.parse({
    schema: "pkm.legacy-script-project-links/v1",
    scope: parsed.data.scope,
    pins: sourcePins(entries, parsed.data.scope),
    entries,
  });
}

function locatorError(code: string, message: string): never {
  throw new LegacyAssetProviderError(code, message);
}

type ParsedLegacyLocator =
  | { kind: "script"; locator: string; scriptId: string }
  | { kind: "script-path"; locator: string; path: string }
  | { kind: "project"; locator: string; id: string };

function parseLegacyLocator(value: string): ParsedLegacyLocator {
  const trimmed = String(value || "").trim();
  const wrapped = /^`([^`\r\n]+)`$/.exec(trimmed);
  const locator = wrapped ? wrapped[1]!.trim() : trimmed;
  if (!locator) locatorError("invalid", "Enter a PKM path.");
  if (!locator.toLowerCase().startsWith("pkm://")) locatorError("invalid", "PKM paths must start with pkm://.");
  let url: URL;
  try { url = new URL(locator); } catch { return locatorError("invalid", "Enter a valid PKM path."); }
  if (url.protocol !== "pkm:" || url.username || url.password || url.port || url.search || url.hash) {
    locatorError("invalid", "PKM paths cannot include credentials, ports, queries, or fragments.");
  }
  const raw = locator.slice("pkm://".length);
  const slash = raw.indexOf("/");
  const rawPath = slash >= 0 ? raw.slice(slash + 1) : "";
  let parts: string[];
  try {
    if (rawPath.includes("//")) locatorError("invalid", "PKM paths cannot contain empty segments.");
    parts = rawPath.split("/").filter(Boolean).map(decodeURIComponent);
  } catch (error) {
    if (error instanceof LegacyAssetProviderError) throw error;
    return locatorError("invalid", "PKM path contains invalid URL encoding.");
  }
  if (parts.some(part => part === "." || part === ".." || part.includes("\0"))) {
    locatorError("invalid", "PKM paths cannot contain traversal segments.");
  }
  const authority = url.hostname.toLowerCase();
  if (authority === "script") {
    if (parts.length !== 1 || !/^script_[A-Za-z0-9._-]+$/.test(parts[0]!) || locator.endsWith("/")) {
      locatorError("invalid", "Script paths must use pkm://script/script_<identity>.");
    }
    return { kind: "script", locator, scriptId: parts[0]! };
  }
  if (authority === "scripts") {
    if (!parts.length || locator.endsWith("/") || parts.some(part => /[/\\:\u0000-\u001f]/.test(part))) {
      locatorError("invalid", "Legacy Script paths must identify a store-relative file.");
    }
    return { kind: "script-path", locator, path: parts.join("/") };
  }
  if (authority === "projects") {
    if (parts.length !== 1 || !projectId.safeParse(parts[0]).success || locator.endsWith("/")) {
      locatorError("invalid", "pkm://projects/ requires one entity identity.");
    }
    return { kind: "project", locator, id: parts[0]! };
  }
  return locatorError("unsupported", `Quick Open does not support the pkm://${authority || "(missing)"}/ namespace yet.`);
}

function requireSnapshotPins(snapshot: LegacyScriptProjectSnapshot, expected?: LegacyScriptProjectPins): void {
  if (!expected) return;
  if (expected.scripts !== snapshot.pins.scripts || expected.projects !== snapshot.pins.projects) {
    locatorError("SNAPSHOT_MISMATCH", "Legacy Script/Project sources changed; restart resolution.");
  }
}

export function resolveLegacyScriptProjectLocator(input: LegacyScriptProjectResolveInput, context: LegacyAssetProviderContext): LegacyScriptProjectResolveOutput {
  assertContext(context);
  const parsed = legacyScriptProjectResolveInput.safeParse(input);
  if (!parsed.success) locatorError("INVALID_ARGUMENT", "Legacy Script/Project resolution input is invalid.");
  const { locator, expectedPins } = parsed.data;
  const snapshot = validateSnapshot(parsed.data.snapshot, context);
  requireSnapshotPins(snapshot, expectedPins);
  const reference = parseLegacyLocator(locator);
  if (reference.kind === "project") {
    const matches = snapshot.entries.filter(entry => entry.area === "projects" && entry.slug === reference.id);
    if (!matches.length) locatorError("not-found", `PKM item was not found: ${reference.locator}`);
    if (matches.length > 1) locatorError("duplicate", `PKM item identity is duplicated: ${reference.locator}`);
    const entry = matches[0]!;
    return { snapshotPins: snapshot.pins, resolved: { kind: "entity", locator: reference.locator, area: "projects", id: entry.slug, title: entry.title } };
  }
  const matches = snapshot.entries.filter(entry => entry.area === "scripts"
    && (reference.kind === "script"
      ? entry.knowledgeId === reference.scriptId || entry.aliases?.includes(reference.locator)
      : entry.relativePath === reference.path || entry.aliases?.includes(reference.locator)));
  if (!matches.length) locatorError("not-found", `PKM item was not found: ${reference.locator}`);
  if (matches.length > 1) locatorError("duplicate", `PKM reference resolves to multiple items: ${reference.locator}`);
  const entry = matches[0]!;
  return {
    snapshotPins: snapshot.pins,
    resolved: { kind: "panel", locator: reference.locator, type: "script", key: entry.relativePath, tab: "scripts", title: entry.title },
  };
}

function validateNativeOwnershipSnapshot(snapshot: NativeAssetOwnershipSnapshot, context: LegacyAssetProviderContext): NativeAssetOwnershipSnapshot {
  const parsed = nativeAssetOwnershipSnapshot.safeParse(snapshot);
  if (!parsed.success) throw new LegacyAssetProviderError("INVALID_OWNERSHIP", "Native asset ownership snapshot is invalid.");
  if (parsed.data.workspaceId !== context.workspaceId || parsed.data.sourceRootId !== context.sourceRootId) {
    throw new LegacyAssetProviderError("SOURCE_SCOPE_MISMATCH", "Native asset owner belongs to another workspace or Knowledge Root.");
  }
  if (parsed.data.items.some(item => item.area !== parsed.data.area)
    || new Set(parsed.data.items.map(item => item.path)).size !== parsed.data.items.length) {
    throw new LegacyAssetProviderError("INVALID_OWNERSHIP", "Native asset ownership snapshot has mixed areas or duplicate paths.");
  }
  const expected = sha256(JSON.stringify([parsed.data.documentSha256, parsed.data.items]));
  if (expected !== parsed.data.revision) {
    throw new LegacyAssetProviderError("CONFLICT", "Native asset ownership snapshot revision is stale.");
  }
  return parsed.data;
}

export function validateNativeAssetOwnership(input: NativeAssetOwnershipInput, context: LegacyAssetProviderContext): NativeAssetOwnershipOutput {
  assertContext(context);
  const parsed = nativeAssetOwnershipInput.safeParse(input);
  if (!parsed.success) throw new LegacyAssetProviderError("INVALID_ARGUMENT", "Native asset ownership check is invalid.");
  const snapshots = parsed.data.snapshots.map(snapshot => validateNativeOwnershipSnapshot(snapshot, context));
  const matches = snapshots.flatMap(snapshot => snapshot.items
    .filter(item => item.path === parsed.data.path)
    .map(item => ({ snapshot, item })));
  if (!matches.length) throw new LegacyAssetProviderError("NOT_FOUND", "Asset is not owned by a supplied native document snapshot.");
  if (matches.length > 1) throw new LegacyAssetProviderError("DUPLICATE_OWNER", "Asset has multiple native document owners; review is required.");
  const { snapshot, item } = matches[0]!;
  if (snapshot.documentSha256 !== parsed.data.expectedDocumentSha256
    || snapshot.revision !== parsed.data.expectedRevision
    || item.digest !== parsed.data.expectedAssetDigest) {
    throw new LegacyAssetProviderError("CONFLICT", "Document or asset changed; rediscover ownership before proceeding.");
  }
  return {
    ownerId: snapshot.id,
    area: snapshot.area,
    path: item.path,
    documentSha256: snapshot.documentSha256,
    assetDigest: item.digest,
    revision: snapshot.revision,
  };
}

function classificationMetadataTarget(asset: string): string {
  return /\.md$/i.test(asset) ? asset : `${asset.slice(0, asset.lastIndexOf("/") + 1)}.${asset.slice(asset.lastIndexOf("/") + 1)}.pkm-classification`;
}

export function validateLegacyClassificationPreview(preview: LegacyClassificationPreview, context: LegacyAssetProviderContext): LegacyClassificationPreview {
  assertContext(context);
  const parsed = legacyClassificationPreview.safeParse(preview);
  if (!parsed.success || parsed.data.root !== context.sourceRootPath || parsed.data.id !== sha256(JSON.stringify(parsed.data.proposals))) {
    throw new LegacyAssetProviderError("INVALID_PREVIEW", "Original classification preview is invalid or belongs to a different source root.");
  }
  for (const proposal of parsed.data.proposals) {
    if (proposal.target !== classificationMetadataTarget(proposal.asset)
      || proposal.id.length !== 64
      || proposal.evidence.some(item => item.confidence < 0 || item.confidence > 1)) {
      throw new LegacyAssetProviderError("INVALID_PREVIEW", "Original classification proposal violates its source contract.");
    }
  }
  return parsed.data;
}

export function readOriginalClassificationPreview(
  context: LegacyAssetProviderContext,
  callbacks: LegacyAssetProviderCallbacks = {},
): LegacyClassificationPreview {
  assertContext(context);
  if (!callbacks.readOriginalClassificationPreview) {
    throw new LegacyAssetProviderError("PROVIDER_UNAVAILABLE", "The original classification source is unavailable; no native classifier is substituted.");
  }
  return validateLegacyClassificationPreview(callbacks.readOriginalClassificationPreview(context.sourceRootPath), context);
}

function hashBase64(value: string): string | undefined {
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64") !== value) return undefined;
    return sha256(decoded);
  } catch {
    return undefined;
  }
}

function assetArea(asset: string): string | undefined {
  const area = asset.split("/", 1)[0];
  return ["skills", "notes", "scripts", "components", "actions", "recipes", "papers"].includes(area) ? area : undefined;
}

export function validateLegacyClassificationRollback(input: LegacyClassificationRollbackInput, context: LegacyAssetProviderContext): LegacyClassificationRollbackOutput {
  assertContext(context);
  const parsed = legacyClassificationRollbackInput.safeParse(input);
  if (!parsed.success) throw new LegacyAssetProviderError("INVALID_JOURNAL", "Original classification rollback journal or observations are invalid.");
  if (sha256(JSON.stringify(parsed.data.journal)) !== parsed.data.expectedJournalDigest) {
    throw new LegacyAssetProviderError("CONFLICT", "Original classification journal changed; rediscover before rollback.");
  }
  const observations = new Map<string, z.infer<typeof classificationTargetObservation>>();
  for (const observation of parsed.data.observations) {
    if (observations.has(observation.path)) throw new LegacyAssetProviderError("INVALID_JOURNAL", "Rollback observations contain duplicate paths.");
    observations.set(observation.path, observation);
  }
  const seenTargets = new Set<string>();
  const entries = parsed.data.journal.entries.map(entry => {
    if (!assetArea(entry.asset) || entry.target !== classificationMetadataTarget(entry.asset)
      || seenTargets.has(entry.target)
      || (entry.before === null ? entry.beforeHash !== null : hashBase64(entry.before) !== entry.beforeHash)) {
      throw new LegacyAssetProviderError("INVALID_JOURNAL", "Rollback journal has an unsafe path, duplicate target, or invalid backup.");
    }
    seenTargets.add(entry.target);
    const parts = entry.target.split("/");
    const paths = parts.map((_part, index) => parts.slice(0, index + 1).join("/"));
    const chain = paths.map(path => observations.get(path));
    if (chain.some(observation => !observation || observation.kind === "symlink" || observation.kind === "other"
      || observation.kind === "directory" && observation.path === entry.target)) {
      return { id: entry.id, target: entry.target, status: "unsafe-or-unavailable" as const };
    }
    const observed = observations.get(entry.target)!;
    if (observed.kind === "missing" && observed.digest !== null || observed.kind !== "missing" && observed.kind !== "regular-file") {
      return { id: entry.id, target: entry.target, status: "unsafe-or-unavailable" as const };
    }
    if (observed.digest === entry.beforeHash) {
      return { id: entry.id, target: entry.target, status: "already-restored-or-not-written" as const };
    }
    if (observed.digest !== entry.afterHash) {
      return { id: entry.id, target: entry.target, status: "changed-since-apply" as const };
    }
    return { id: entry.id, target: entry.target, status: "ready-to-restore" as const };
  });
  return {
    journalId: parsed.data.journalId,
    safeToRollback: entries.every(entry => entry.status === "ready-to-restore" || entry.status === "already-restored-or-not-written"),
    entries,
  };
}

export const legacyAssetProviderDefinitions = [
  {
    id: "knowledge.legacy-links.resolve",
    readOnly: true,
    description: "Resolve original Script and Project PKM locators against a source-pinned inventory. No filesystem reads or writes are performed.",
    input: legacyScriptProjectResolveInput,
    output: legacyScriptProjectResolveOutput,
  },
  {
    id: "knowledge.asset.ownership.validate",
    readOnly: true,
    description: "Validate a native Markdown asset owner against the document and resource-list revision supplied by the native asset reader.",
    input: nativeAssetOwnershipInput,
    output: nativeAssetOwnershipOutput,
  },
  {
    id: "knowledge.asset.classification.preview.validate",
    readOnly: true,
    description: "Validate and preserve a review-only preview produced by the original classification source; this provider does not scan or classify files.",
    input: z.strictObject({ preview: legacyClassificationPreview }),
    output: legacyClassificationPreview,
  },
  {
    id: "knowledge.asset.classification.rollback.validate",
    readOnly: true,
    description: "Preflight every original classification journal target before any native rollback effect; never performs rollback writes.",
    input: legacyClassificationRollbackInput,
    output: legacyClassificationRollbackOutput,
  },
] as const;
