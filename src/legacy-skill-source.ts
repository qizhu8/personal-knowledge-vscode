import { createHash } from "node:crypto";
import { z } from "zod";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import {
  isLegacyBundledSkillSource, legacySkillBindingSchema, legacySkillManifestHash, legacySkillManifestSchema,
  type LegacySkillBinding, type LegacySkillManifest,
} from "./legacy-skill-lifecycle.js";
import { compareVersionOrder } from "./domain/runtime-process-original.js";
import { parseMarker, PKM_SKILL_ROUTER_VERSION, renderProjection } from "./domain/skill-routing-projection.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z.strictObject({
  beforeSha256: digest.nullable(),
  bundleSha256: digest,
});
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const limit = 2_097_152;

export type LegacySkillSourceRequest = z.infer<typeof requestSchema>;
export interface LegacySkillSourcePlan {
  request: LegacySkillSourceRequest;
  transition: "create" | "upgrade" | "preserve";
  beforeBase64: string | null;
  afterBase64: string;
  afterSha256: string;
}

/** Reproduce ensureCanonicalSource, with explicit content pins and bounded UTF-8 bytes.
 * The native owner is responsible for binding the bundle and source to approved roots. */
export function prepareLegacySkillSource(
  value: unknown, before: Buffer | null, bundle: Buffer,
): LegacySkillSourcePlan {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success || !Buffer.isBuffer(bundle) || bundle.length > limit
    || (before !== null && (!Buffer.isBuffer(before) || before.length > limit))) {
    throw new CoreError("INVALID_ARGUMENT", "Invalid canonical Skill source admission.");
  }
  if (before !== null && !Buffer.from(before.toString("utf8"), "utf8").equals(before))
    throw new CoreError("INVALID_ARGUMENT", "Canonical Skill source must be UTF-8.");
  if (!Buffer.from(bundle.toString("utf8"), "utf8").equals(bundle))
    throw new CoreError("INVALID_ARGUMENT", "Bundled Skill source must be UTF-8.");
  if ((before === null ? null : hash(before)) !== parsed.data.beforeSha256 || hash(bundle) !== parsed.data.bundleSha256)
    throw new CoreError("CONFLICT", "Canonical Skill source or pinned bundle changed.");
  const transition = before === null ? "create" : isLegacyBundledSkillSource(before) ? "upgrade" : "preserve";
  const after = transition === "preserve" ? before! : bundle;
  return {
    request: parsed.data, transition, beforeBase64: before?.toString("base64") ?? null,
    afterBase64: after.toString("base64"), afterSha256: hash(after),
  };
}

/** The expected digest must come from independent native authority, not the plan. */
export function validateLegacySkillSourcePlan(value: unknown, bundle: Buffer, trustedBundleSha256: string): LegacySkillSourcePlan {
  if (!digest.safeParse(trustedBundleSha256).success || hash(bundle) !== trustedBundleSha256)
    throw new CoreError("CONFLICT", "Canonical Skill bundle does not match the independent native pin.");
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new CoreError("CONFLICT", "Invalid canonical Skill source plan.");
  const plan = value as Record<string, unknown>;
  if (plan.beforeBase64 !== null && typeof plan.beforeBase64 !== "string")
    throw new CoreError("CONFLICT", "Invalid canonical Skill source before image.");
  const before = plan.beforeBase64 === null ? null : Buffer.from(plan.beforeBase64 as string, "base64");
  if (before && before.toString("base64") !== plan.beforeBase64)
    throw new CoreError("CONFLICT", "Noncanonical canonical Skill source before image.");
  let expected: LegacySkillSourcePlan;
  try { expected = prepareLegacySkillSource(plan.request, before, bundle); }
  catch { throw new CoreError("CONFLICT", "Canonical Skill source plan cannot be reconstructed."); }
  if (JSON.stringify(value) !== JSON.stringify(expected))
    throw new CoreError("CONFLICT", "Canonical Skill source plan differs from the original writer.");
  return expected;
}

const sourcePath = "System/PKM/PKM Skills.md";
const projectionPath = "pkm-skills/SKILL.md";
export const legacySkillSourceInstallInputSchema = z.strictObject({
  operationId: z.string().uuid(),
  sourceSha256: digest.nullable(),
  bundleSha256: digest,
  sourceManifestSha256: digest,
  destinationSha256: digest.nullable(),
  destinationManifestSha256: digest,
});
export type LegacySkillSourceInstallInput = z.infer<typeof legacySkillSourceInstallInputSchema>;
export const legacySkillSourceBridgeInputSchema = legacySkillSourceInstallInputSchema.extend({
  legacyHistorySha256: digest,
});
export type LegacySkillSourceBridgeInput = z.infer<typeof legacySkillSourceBridgeInputSchema>;
export interface LegacySkillSourceBridgePlan {
  kind: "bridge";
  actor: { id: string; canWrite: true; collaborationKind: "human" };
  roots: { source: string; destination: string };
  epoch: string;
  input: LegacySkillSourceBridgeInput;
  legacy: { rows: unknown[]; locals: unknown[]; globals: unknown[] };
  genesis: LegacySkillSourceInstallPlan;
}
export const legacySkillSourceRemoveInputSchema = z.strictObject({
  operationId: z.string().uuid(),
  sourceSha256: digest,
  sourceManifestSha256: digest,
  destinationSha256: digest.nullable(),
  destinationManifestSha256: digest,
});
export type LegacySkillSourceRemoveInput = z.infer<typeof legacySkillSourceRemoveInputSchema>;
export interface LegacySkillSourceRemovePlan {
  kind: "remove";
  binding: LegacySkillBinding;
  input: LegacySkillSourceRemoveInput;
  sourceBase64: string;
  destinationBeforeBase64: string | null;
  sourceBeforeManifest: LegacySkillManifest;
  sourceAfterManifest: LegacySkillManifest;
  destinationBeforeManifest: LegacySkillManifest;
  destinationAfterManifest: LegacySkillManifest;
}
export interface LegacySkillSourceInstallPlan {
  binding: LegacySkillBinding;
  input: LegacySkillSourceInstallInput;
  source: LegacySkillSourcePlan;
  destinationBeforeBase64: string | null;
  destinationAfterBase64: string;
  sourceBeforeManifest: LegacySkillManifest;
  sourceAfterManifest: LegacySkillManifest;
  destinationBeforeManifest: LegacySkillManifest;
  destinationAfterManifest: LegacySkillManifest;
}

function assertEntry(manifest: LegacySkillManifest, path: string, bytes: Buffer | null) {
  const entry = manifest.find(item => item.path === path);
  if (bytes === null ? !!entry : !entry || entry.kind !== "file" || entry.sha256 !== hash(bytes) || entry.size !== bytes.length)
    throw new CoreError("CONFLICT", "Skill tree does not match its pinned file bytes.");
}
function replaceFile(manifest: LegacySkillManifest, path: string, bytes: Buffer): LegacySkillManifest {
  const result = manifest.filter(item => item.path !== path);
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(0, i).join("/");
    const existing = result.find(item => item.path === parent);
    if (existing && existing.kind !== "directory") throw new CoreError("CONFLICT", "Skill path has a non-directory parent.");
    if (!existing) result.push({ kind: "directory", path: parent });
  }
  result.push({ kind: "file", path, sha256: hash(bytes), size: bytes.length });
  result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  legacySkillManifestHash(result);
  return result;
}

export function prepareLegacySkillSourceRemove(
  bindingValue: unknown, inputValue: unknown, source: Buffer | null, sourceManifestValue: unknown,
  destination: Buffer | null, destinationManifestValue: unknown,
): LegacySkillSourceRemovePlan {
  const binding = legacySkillBindingSchema.safeParse(bindingValue), input = legacySkillSourceRemoveInputSchema.safeParse(inputValue);
  const sourceManifest = legacySkillManifestSchema.safeParse(sourceManifestValue);
  const destinationManifest = legacySkillManifestSchema.safeParse(destinationManifestValue);
  if (!binding.success || !input.success || !sourceManifest.success || !destinationManifest.success)
    throw new CoreError("INVALID_ARGUMENT", "Invalid canonical Skill removal admission.");
  if (binding.data.sourceRootId === binding.data.destinationRootId)
    throw new CoreError("ACCESS_DENIED", "Skill source and target authorities must be distinct.");
  if (!Buffer.isBuffer(source) || source.length > limit || !Buffer.from(source.toString("utf8"), "utf8").equals(source)
    || (destination !== null && (!Buffer.isBuffer(destination) || destination.length > limit
      || !Buffer.from(destination.toString("utf8"), "utf8").equals(destination))))
    throw new CoreError("INVALID_ARGUMENT", "Skill source and projection must be bounded UTF-8.");
  if (hash(source) !== input.data.sourceSha256
    || legacySkillManifestHash(sourceManifest.data) !== input.data.sourceManifestSha256
    || legacySkillManifestHash(destinationManifest.data) !== input.data.destinationManifestSha256
    || (destination === null ? null : hash(destination)) !== input.data.destinationSha256)
    throw new CoreError("CONFLICT", "Skill source or destination inventory changed.");
  assertEntry(sourceManifest.data, sourcePath, source);
  assertEntry(destinationManifest.data, projectionPath, destination);
  if (destination !== null && !parseMarker(destination.toString("utf8")))
    throw new CoreError("CONFLICT", "Refusing to remove a non-PKM Skill.");
  let after = destinationManifest.data;
  if (destination !== null) {
    after = after.filter(item => item.path !== projectionPath);
    if (!after.some(item => item.path.startsWith("pkm-skills/")))
      after = after.filter(item => item.path !== "pkm-skills");
  }
  return { kind: "remove", binding: binding.data, input: input.data, sourceBase64: source.toString("base64"),
    destinationBeforeBase64: destination?.toString("base64") ?? null, sourceBeforeManifest: sourceManifest.data,
    sourceAfterManifest: sourceManifest.data, destinationBeforeManifest: destinationManifest.data, destinationAfterManifest: after };
}

export function validateLegacySkillSourceRemovePlan(value: unknown): LegacySkillSourceRemovePlan {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new CoreError("CONFLICT", "Invalid canonical Skill removal plan.");
  const record = value as Record<string, unknown>;
  if (typeof record.sourceBase64 !== "string"
    || (record.destinationBeforeBase64 !== null && typeof record.destinationBeforeBase64 !== "string"))
    throw new CoreError("CONFLICT", "Invalid canonical Skill removal images.");
  const source = Buffer.from(record.sourceBase64, "base64");
  const destination = record.destinationBeforeBase64 === null ? null : Buffer.from(record.destinationBeforeBase64 as string, "base64");
  if (source.toString("base64") !== record.sourceBase64
    || (destination && destination.toString("base64") !== record.destinationBeforeBase64))
    throw new CoreError("CONFLICT", "Invalid canonical Skill removal image encoding.");
  let expected: LegacySkillSourceRemovePlan;
  try { expected = prepareLegacySkillSourceRemove(record.binding, record.input, source, record.sourceBeforeManifest, destination, record.destinationBeforeManifest); }
  catch { throw new CoreError("CONFLICT", "Canonical Skill removal plan cannot be reconstructed."); }
  if (JSON.stringify(value) !== JSON.stringify(expected)) throw new CoreError("CONFLICT", "Canonical Skill removal plan changed.");
  return expected;
}

/** Reconstructs both original writer effects, before any native authority is granted.
 * The native host must separately approve destructive effects and pin root identities. */
export function prepareLegacySkillSourceInstall(
  bindingValue: unknown, inputValue: unknown, sourceBefore: Buffer | null, bundle: Buffer,
  sourceManifestValue: unknown, destinationBefore: Buffer | null, destinationManifestValue: unknown,
): LegacySkillSourceInstallPlan {
  const binding = legacySkillBindingSchema.safeParse(bindingValue), input = legacySkillSourceInstallInputSchema.safeParse(inputValue);
  const sourceManifest = legacySkillManifestSchema.safeParse(sourceManifestValue);
  const destinationManifest = legacySkillManifestSchema.safeParse(destinationManifestValue);
  if (!binding.success || !input.success || !sourceManifest.success || !destinationManifest.success)
    throw new CoreError("INVALID_ARGUMENT", "Invalid canonical Skill installation admission.");
  if (binding.data.sourceRootId === binding.data.destinationRootId)
    throw new CoreError("ACCESS_DENIED", "Skill source and target authorities must be distinct.");
  if (destinationBefore !== null && (!Buffer.isBuffer(destinationBefore) || destinationBefore.length > limit
    || !Buffer.from(destinationBefore.toString("utf8"), "utf8").equals(destinationBefore)))
    throw new CoreError("INVALID_ARGUMENT", "Projection before image must be bounded UTF-8.");
  if (legacySkillManifestHash(sourceManifest.data) !== input.data.sourceManifestSha256
    || legacySkillManifestHash(destinationManifest.data) !== input.data.destinationManifestSha256
    || (destinationBefore === null ? null : hash(destinationBefore)) !== input.data.destinationSha256)
    throw new CoreError("CONFLICT", "Skill source or destination inventory changed.");
  assertEntry(sourceManifest.data, sourcePath, sourceBefore);
  assertEntry(destinationManifest.data, projectionPath, destinationBefore);
  // The original checks the target before creating or upgrading canonical bytes.
  if (destinationBefore !== null) {
    const marker = parseMarker(destinationBefore.toString("utf8"));
    if (!marker) throw new CoreError("CONFLICT", "Refusing to overwrite a non-PKM Skill.");
    if ((compareVersionOrder(marker.routerVersion, PKM_SKILL_ROUTER_VERSION) || 0) > 0)
      throw new CoreError("CONFLICT", "Refusing to replace a newer PKM Skill Router.");
  }
  const source = prepareLegacySkillSource({ beforeSha256: input.data.sourceSha256, bundleSha256: input.data.bundleSha256 }, sourceBefore, bundle);
  const afterSource = Buffer.from(source.afterBase64, "base64");
  const afterDestination = Buffer.from(renderProjection(afterSource.toString("utf8"), { kind: binding.data.targetKind }, binding.data.extensionVersion).content);
  if (afterDestination.length > limit) throw new CoreError("NOT_AVAILABLE", "Rendered projection exceeds the boundary.");
  return { binding: binding.data, input: input.data, source,
    destinationBeforeBase64: destinationBefore?.toString("base64") ?? null, destinationAfterBase64: afterDestination.toString("base64"),
    sourceBeforeManifest: sourceManifest.data, sourceAfterManifest: replaceFile(sourceManifest.data, sourcePath, afterSource),
    destinationBeforeManifest: destinationManifest.data, destinationAfterManifest: replaceFile(destinationManifest.data, projectionPath, afterDestination) };
}

export function validateLegacySkillSourceInstallPlan(value: unknown, bundle: Buffer, trustedBundleSha256: string): LegacySkillSourceInstallPlan {
  if (!digest.safeParse(trustedBundleSha256).success || hash(bundle) !== trustedBundleSha256)
    throw new CoreError("CONFLICT", "Canonical Skill bundle does not match the independent native pin.");
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new CoreError("CONFLICT", "Invalid canonical Skill installation plan.");
  const record = value as Record<string, unknown>, source = record.source as Record<string, unknown> | null;
  if (!source || (source.beforeBase64 !== null && typeof source.beforeBase64 !== "string")
    || (record.destinationBeforeBase64 !== null && typeof record.destinationBeforeBase64 !== "string"))
    throw new CoreError("CONFLICT", "Invalid canonical Skill installation before images.");
  const before = source.beforeBase64 === null ? null : Buffer.from(source.beforeBase64 as string, "base64");
  const destination = record.destinationBeforeBase64 === null ? null : Buffer.from(record.destinationBeforeBase64 as string, "base64");
  if ((before && before.toString("base64") !== source.beforeBase64)
    || (destination && destination.toString("base64") !== record.destinationBeforeBase64))
    throw new CoreError("CONFLICT", "Invalid canonical Skill installation image encoding.");
  let expected: LegacySkillSourceInstallPlan;
  try { expected = prepareLegacySkillSourceInstall(record.binding, record.input, before, bundle, record.sourceBeforeManifest, destination, record.destinationBeforeManifest); }
  catch { throw new CoreError("CONFLICT", "Canonical Skill installation plan cannot be reconstructed."); }
  if (JSON.stringify(value) !== JSON.stringify(expected)) throw new CoreError("CONFLICT", "Canonical Skill installation plan changed.");
  return expected;
}

/** Classify the complete observed trees only after reconstructing the plan
 * against independent bundle authority. Mixed states require explicit recovery;
 * an unmatched tree must remain fenced. */
export function inspectLegacySkillSourceInstall(
  value: unknown, bundle: Buffer, trustedBundleSha256: string,
  sourceManifest: unknown, destinationManifest: unknown,
): { plan: LegacySkillSourceInstallPlan; state: "before" | "source-after" | "destination-after" | "after" } {
  const plan = validateLegacySkillSourceInstallPlan(value, bundle, trustedBundleSha256);
  const source = legacySkillManifestHash(sourceManifest), destination = legacySkillManifestHash(destinationManifest);
  const sourceBefore = source === legacySkillManifestHash(plan.sourceBeforeManifest);
  const sourceAfter = source === legacySkillManifestHash(plan.sourceAfterManifest);
  const destinationBefore = destination === legacySkillManifestHash(plan.destinationBeforeManifest);
  const destinationAfter = destination === legacySkillManifestHash(plan.destinationAfterManifest);
  if (sourceAfter && destinationAfter) return { plan, state: "after" };
  if (sourceBefore && destinationBefore) return { plan, state: "before" };
  if (sourceAfter && destinationBefore) return { plan, state: "source-after" };
  if (sourceBefore && destinationAfter) return { plan, state: "destination-after" };
  throw new CoreError("CONFLICT", "Unknown canonical Skill source or projection inventory; intent remains fenced.", "unknown");
}
