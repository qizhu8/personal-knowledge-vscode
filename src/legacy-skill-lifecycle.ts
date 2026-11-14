import { createHash } from "node:crypto";
import { z } from "zod";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import type { Actor } from "./contracts.js";
import { resourcePath } from "./document-path.js";
import { PKM_SKILL_SOURCE_RELATIVE, renderProjection } from "./domain/skill-routing-projection.js";
import { skillRoutingDefinitions } from "./skill-routing-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bounded = z.string().min(1).max(500);
const targetKind = z.enum(["copilot", "agents", "claude", "custom"]);
const file = z.strictObject({ kind: z.literal("file"), path: resourcePath, sha256: digest, size: z.number().int().nonnegative().max(2_097_152) });
const directory = z.strictObject({ kind: z.literal("directory"), path: resourcePath });
export const legacySkillManifestSchema = z.array(z.discriminatedUnion("kind", [file, directory])).max(4096);
export const legacySkillBindingSchema = z.strictObject({
  workspaceId: bounded, actorId: bounded, sourceRootId: bounded, destinationRootId: bounded,
  targetId: bounded, targetKind, extensionVersion: bounded,
});
export const legacySkillLifecycleInputSchema = z.strictObject({
  operationId: z.string().uuid(), action: z.enum(["inject", "remove"]),
  sourceSha256: digest, destinationSha256: digest.nullable(), manifestSha256: digest,
});
export const legacySkillLifecycleOutputSchema = z.strictObject({
  operationId: z.string().uuid(), action: z.enum(["inject", "remove"]),
  destinationSha256: digest.nullable(), manifestSha256: digest,
});
export const legacySkillLifecycleDefinitions = [
  { id: "legacy.skill.router.inject", readOnly: false, description: "Proposed native-approved PKM Skill Router projection; not registered.", input: legacySkillLifecycleInputSchema.extend({ action: z.literal("inject") }), output: legacySkillLifecycleOutputSchema },
  { id: "legacy.skill.router.remove", readOnly: false, description: "Proposed native-approved PKM Skill Router removal; not registered.", input: legacySkillLifecycleInputSchema.extend({ action: z.literal("remove") }), output: legacySkillLifecycleOutputSchema },
] as const;
export type LegacySkillBinding = z.infer<typeof legacySkillBindingSchema>;
export type LegacySkillInput = z.infer<typeof legacySkillLifecycleInputSchema>;
export type LegacySkillManifest = z.infer<typeof legacySkillManifestSchema>;

const SOURCE = PKM_SKILL_SOURCE_RELATIVE;
const DESTINATION = "pkm-skills/SKILL.md";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fail = (code: "INVALID_ARGUMENT" | "ACCESS_DENIED" | "CONFLICT" | "NOT_AVAILABLE", message: string): never => { throw new CoreError(code, message); };
// Original ensureCanonicalSource would replace these source bytes before
// projection. This leaf cannot perform that separate source mutation.
const legacyBundledSourceHashes = new Set([
  "a7698a2b99e23f88aa9fd84d8d01cb9984e843e1b46fda426d349d95bdfeaa74",
  "90e969afbde64e489d6856a6df078d2e6da4a847c961496960d6e7d6d0e41588",
  "2da9ae268a9f6c828d466650fb2db1b812a00aeb30c6b25862ca24346bacbef9",
  "e200f9d3967f4e0f0779f59ae6ecdde4afac834b6c3b18fe7be557daf242265a",
  "6e4d01d6b905b96879225119a8c76597984abe3b8ef1d84858c8cea5e064da5d",
  "763311e1c6e8d7c3b9807914b81453b0da45c00ba7c47d2054719b3f179bb371",
  "614f9aec0acd2f90d4072d83649b7cfc1b0625723ede396505c82c11a86e49aa",
  "346a18db7462d92957e820f5c49b6e528de123071db49733ba1a1069cc990eb8",
  "ad2a744488a399d9bf93bce64364ec0cf62fe318352830b13689690df9cffb24",
  "0cae8cda7b1aad7f3f5ac8b18acd4ac903cad815e5a91cfd571faaaf1a0b3943",
  "bd3dc30cc22c6814ef518bfcabbe844440ed8de8ca6c439c2c6a56b8fd3d0b3e",
  "b3644f21b8cf5f6f6a533088b40b60c364ee0b10ec333cc294eb6e4be379a17f",
  "c0c2e516dfa19aaf8510dd847ed0318f997c1a7e5b90d50c869e15be54e7c3d2",
  "87d95455175f8c1ca694ed1fae924b3fd96f5dab3f43723a0a3f1db7abc6a7ac",
  "443d25a7a2c34350475d2008b612060e8aaf303a8fe06c5c10f6f92c2e231c5b",
  "c60be52f524bae0d853ac98785a3be39f038c0d2c9d9629da6c6901211695c8b",
  "b6dbcf44509a2c4c240d99a2e6573b83b21b3bc6e546c2d0a1ef707657be1325",
  "46d9c22107cfc09eaec54fdfbe98af4c2ad9ace5bb5c05fd8ec492de3f146d1a",
  "f8f28f95af02e8f15dbcd632452af46b020267dac89e7b036e383ef171e8cf49",
  "269e06b053f5d48b31bac2823068c3a55a8681801c68222352116c65209ae193",
  "a819465ccec50d589891fe12a86d1bfd003eeee0bcf1e725048c4338208b2d67",
  "0cd7549ee9b7ee3c5d8da25d38056dc1772354db64b2adc83a7b88a13356738a",
  "167f0a7f109cad290d352779e138ddafaeb15579fba57b2d465d45978e0e80d2",
]);

export function isLegacyBundledSkillSource(bytes: Buffer): boolean {
  return legacyBundledSourceHashes.has(hash(bytes));
}

/** Hashes the complete, path-sorted destination tree, including empty directories.
 * Links, hardlinks and non-regular objects must be rejected by the native scanner. */
export function legacySkillManifestHash(input: unknown): string {
  const parsed = legacySkillManifestSchema.safeParse(input);
  if (!parsed.success) return fail("INVALID_ARGUMENT", "Invalid Skill destination manifest.");
  const entries = parsed.data;
  for (let i = 1; i < entries.length; i++) {
    if (entries[i - 1]!.path >= entries[i]!.path) return fail("INVALID_ARGUMENT", "Skill manifest must be sorted and unique.");
  }
  const portable = new Set(entries.map(entry => entry.path.normalize("NFC").toLowerCase()));
  if (portable.size !== entries.length) return fail("INVALID_ARGUMENT", "Skill manifest has a portable path collision.");
  const paths = new Map(entries.map(entry => [entry.path, entry]));
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = paths.get(parts.slice(0, i).join("/"));
      if (!parent || parent.kind !== "directory") return fail("INVALID_ARGUMENT", "Skill manifest omits a directory or has a file ancestor.");
    }
  }
  return hash(JSON.stringify(entries));
}

const planSchema = z.strictObject({
  binding: legacySkillBindingSchema, input: legacySkillLifecycleInputSchema,
  sourcePath: z.literal(SOURCE), destinationPath: z.literal(DESTINATION),
  beforeManifest: legacySkillManifestSchema, afterManifest: legacySkillManifestSchema,
  afterContent: z.string().max(2_097_152).nullable(), result: legacySkillLifecycleOutputSchema,
});
export type LegacySkillPlan = z.infer<typeof planSchema>;

/** The trusted scanner supplies exact bytes plus the *whole* target manifest.
 * The only admitted overwrite/removal is the exact current projection. */
export function prepareLegacySkillLifecycle(
  bindingValue: unknown, inputValue: unknown, sourceBytes: Buffer, destinationBytes: Buffer | null, manifestValue: unknown,
): LegacySkillPlan {
  const binding = legacySkillBindingSchema.safeParse(bindingValue), input = legacySkillLifecycleInputSchema.safeParse(inputValue);
  const manifest = legacySkillManifestSchema.safeParse(manifestValue);
  if (!binding.success || !input.success || !manifest.success) return fail("INVALID_ARGUMENT", "Invalid Skill lifecycle admission.");
  if (binding.data.sourceRootId === binding.data.destinationRootId) return fail("ACCESS_DENIED", "Source and target roots must be distinct approved authorities.");
  if (!Buffer.isBuffer(sourceBytes) || sourceBytes.length > 2_097_152 || (destinationBytes !== null && (!Buffer.isBuffer(destinationBytes) || destinationBytes.length > 2_097_152))) return fail("INVALID_ARGUMENT", "Skill bytes exceed the boundary.");
  const source = sourceBytes.toString("utf8");
  if (!Buffer.from(source).equals(sourceBytes)) return fail("INVALID_ARGUMENT", "Skill source must be UTF-8.");
  if (isLegacyBundledSkillSource(sourceBytes))
    return fail("NOT_AVAILABLE", "Original source requires a bundled Router upgrade, which this leaf cannot perform.");
  if (hash(sourceBytes) !== input.data.sourceSha256 || legacySkillManifestHash(manifest.data) !== input.data.manifestSha256)
    return fail("CONFLICT", "Skill source or destination manifest changed.");
  const actual = destinationBytes === null ? null : hash(destinationBytes);
  const entry = manifest.data.find(item => item.path === DESTINATION);
  if (actual !== input.data.destinationSha256 || (actual === null ? !!entry : !entry || entry.kind !== "file" || entry.sha256 !== actual || entry.size !== destinationBytes!.length))
    return fail("CONFLICT", "Skill destination changed or is absent from the whole manifest.");
  const rendered = renderProjection(source, { kind: binding.data.targetKind }, binding.data.extensionVersion).content;
  if (Buffer.byteLength(rendered) > 2_097_152) return fail("NOT_AVAILABLE", "Rendered projection exceeds the boundary.");
  if (destinationBytes !== null && !destinationBytes.equals(Buffer.from(rendered)))
    return fail("CONFLICT", "Only the exact current managed projection can be replaced or removed.");
  const afterContent = input.data.action === "inject" ? rendered : null;
  const afterManifest = manifest.data.filter(item => item.path !== DESTINATION);
  if (afterContent !== null) {
    if (!afterManifest.some(item => item.path === "pkm-skills")) afterManifest.push({ kind: "directory", path: "pkm-skills" });
    afterManifest.push({ kind: "file", path: DESTINATION, sha256: hash(afterContent), size: Buffer.byteLength(afterContent) });
  } else if (actual !== null && !afterManifest.some(item => item.path.startsWith("pkm-skills/"))) {
    const index = afterManifest.findIndex(item => item.path === "pkm-skills");
    if (index >= 0) afterManifest.splice(index, 1);
  }
  afterManifest.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const afterHash = legacySkillManifestHash(afterManifest);
  return { binding: binding.data, input: input.data, sourcePath: SOURCE, destinationPath: DESTINATION,
    beforeManifest: manifest.data, afterManifest, afterContent,
    result: { operationId: input.data.operationId, action: input.data.action, destinationSha256: afterContent === null ? null : hash(afterContent), manifestSha256: afterHash } };
}

/** Revalidates persisted plans against original source bytes before recovery. */
export function validateLegacySkillLifecyclePlan(value: unknown, sourceBytes: Buffer, beforeBytes: Buffer | null): LegacySkillPlan {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) return fail("CONFLICT", "Invalid persisted Skill intent.");
  const expected = prepareLegacySkillLifecycle(parsed.data.binding, parsed.data.input, sourceBytes, beforeBytes, parsed.data.beforeManifest);
  if (JSON.stringify(parsed.data) !== JSON.stringify(expected)) return fail("CONFLICT", "Skill intent was modified.");
  return expected;
}

export function legacySkillLifecyclePlanHash(plan: LegacySkillPlan): string {
  return hash(JSON.stringify(plan));
}

/** Unknown or partially applied trees are never retried automatically. */
export function inspectLegacySkillLifecyclePending(
  value: unknown, expectedPlanHash: string, sourceBytes: Buffer, beforeBytes: Buffer | null, currentManifest: unknown,
): { plan: LegacySkillPlan; state: "before" | "after" } {
  if (!digest.safeParse(expectedPlanHash).success) return fail("CONFLICT", "Invalid Skill intent pin.");
  const plan = validateLegacySkillLifecyclePlan(value, sourceBytes, beforeBytes);
  if (legacySkillLifecyclePlanHash(plan) !== expectedPlanHash) return fail("CONFLICT", "Skill intent digest changed.");
  const current = legacySkillManifestHash(currentManifest);
  if (current === plan.result.manifestSha256) return { plan, state: "after" };
  if (current === plan.input.manifestSha256) return { plan, state: "before" };
  return fail("CONFLICT", "Unknown Skill destination state; intent remains fenced.");
}

export const LEGACY_SKILL_LIFECYCLE_JOURNAL_DDL = `
CREATE TABLE IF NOT EXISTS legacy_skill_lifecycle_intent (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), operation_id TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL, plan_json TEXT NOT NULL, plan_sha256 TEXT NOT NULL
);`;

/** Explicit, local, pinned selection only. This returns original Skill material
 * for a host to use in memory; it grants no tool or command authority. */
export const legacySkillMaterializeInputSchema = z.strictObject({
  workspaceId: bounded, source: z.literal("pkm-personal"), snapshotRevision: digest,
  selected: z.array(z.strictObject({ id: bounded, documentSha256: digest })).min(1).max(20),
});
export const legacySkillMaterializeDefinition = {
  id: "legacy.skill.routing.materialize", readOnly: true,
  description: "Proposed explicit policy-approved local Skill materialization; no activation authority or execution.",
  input: legacySkillMaterializeInputSchema, output: skillRoutingDefinitions[3].output,
} as const;
export interface LegacySkillMaterializeHost {
  authorize(actor: Readonly<Actor>, workspaceId: string): boolean;
  project(actor: Readonly<Actor>, args: z.infer<typeof skillRoutingDefinitions[3]["input"]>): Promise<unknown>;
}
export async function materializeLegacySkills(host: LegacySkillMaterializeHost, actor: Actor, value: unknown) {
  const parsed = legacySkillMaterializeInputSchema.safeParse(value);
  if (!parsed.success) return fail("INVALID_ARGUMENT", "Invalid local Skill materialization request.");
  if (!actor?.id) return fail("ACCESS_DENIED", "Authenticated Skill materialization actor is required.");
  let allowed = false;
  try { allowed = host.authorize(actor, parsed.data.workspaceId) === true; } catch { /* deny */ }
  if (!allowed) return fail("ACCESS_DENIED", "Skill materialization policy denied this actor.");
  const selected = parsed.data.selected;
  if (new Set(selected.map(item => item.id)).size !== selected.length) return fail("CONFLICT", "Duplicate selected Skill.");
  const result = await host.project(actor, { selected, snapshotRevision: parsed.data.snapshotRevision, target: "agents", extensionVersion: "unknown" });
  const output = skillRoutingDefinitions[3].output.safeParse(result);
  if (!output.success || output.data.snapshotRevision !== parsed.data.snapshotRevision || output.data.projection !== null ||
    output.data.items.length !== selected.length || output.data.items.some((item, index) =>
      item.address.documentId !== selected[index]!.id || item.address.documentSha256 !== selected[index]!.documentSha256))
    return fail("CONFLICT", "Canonical Skill materialization did not preserve the selected identities and pins.");
  return output.data;
}

/** Native implementation owns durable exclusivity, trusted authorization, global
 * receipt atomics, no-follow complete scanning, CAS and recovery. The scan must
 * bind both approved roots to held native authorities, enumerate every directory
 * and regular file, reject links/hardlinks, special objects and portable
 * collisions, and bound total bytes; do not follow a pathname after checking it.
 * Stage atomically fences all mutators and persists the plan and pin. Apply must
 * recheck the complete before tree and source under the same held authorities.
 * Commit atomically writes the global receipt and deletes the intent. No callback
 * may infer approval from serialized arguments; filesystem work is outside SQL. */
export interface LegacySkillLifecycleHost {
  withExclusive<T>(work: () => Promise<T>): Promise<T>;
  authorize(actor: Readonly<Actor>, binding: LegacySkillBinding, action: LegacySkillInput["action"]): boolean;
  replayOrFence(operationId: string, fingerprint: string): Promise<{ kind: "new" } | { kind: "replay"; result: unknown }>;
  scan(binding: LegacySkillBinding): Promise<{ source: Buffer; destination: Buffer | null; manifest: LegacySkillManifest }>;
  stage(plan: LegacySkillPlan, fingerprint: string): Promise<void>;
  applyAndVerify(plan: LegacySkillPlan): Promise<void>;
  commit(plan: LegacySkillPlan, fingerprint: string): Promise<void>;
}

export interface LegacySkillRecoveryHost extends LegacySkillLifecycleHost {
  readPending(): Promise<{ plan: unknown; planSha256: string; fingerprint: string } | null>;
  approveRetry(actor: Readonly<Actor>, plan: LegacySkillPlan, fingerprint: string): boolean;
}

/** Recovery is deliberate and same-ID only; unknown states remain fenced. */
export async function recoverLegacySkillLifecycle(host: LegacySkillRecoveryHost, actor: Actor, operationId: string, fingerprint: string) {
  if (!z.string().uuid().safeParse(operationId).success || !digest.safeParse(fingerprint).success) return fail("INVALID_ARGUMENT", "Invalid Skill recovery request.");
  if (!actor?.id || !actor.canWrite) return fail("ACCESS_DENIED", "Authenticated Skill recovery authority is required.");
  return host.withExclusive(async () => {
    const pending = await host.readPending();
    if (!pending) return fail("CONFLICT", "No Skill intent is pending.");
    const parsed = planSchema.safeParse(pending.plan);
    if (!parsed.success || parsed.data.input.operationId !== operationId || pending.fingerprint !== fingerprint || parsed.data.binding.actorId !== actor.id)
      return fail("CONFLICT", "Skill recovery must match the pending actor, ID and fingerprint.");
    let allowed = false;
    try { allowed = host.authorize(actor, parsed.data.binding, parsed.data.input.action) === true && host.approveRetry(actor, parsed.data, fingerprint) === true; } catch { /* deny */ }
    if (!allowed) return fail("ACCESS_DENIED", "Skill recovery retry is not approved.");
    const scan = await host.scan(parsed.data.binding);
    const before = parsed.data.input.destinationSha256 === null ? null
      : Buffer.from(renderProjection(scan.source.toString("utf8"), { kind: parsed.data.binding.targetKind }, parsed.data.binding.extensionVersion).content);
    const inspected = inspectLegacySkillLifecyclePending(parsed.data, pending.planSha256, scan.source, before, scan.manifest);
    const current = scan.destination === null ? null : hash(scan.destination);
    const expected = inspected.state === "before" ? inspected.plan.input.destinationSha256 : inspected.plan.result.destinationSha256;
    if (current !== expected) return fail("CONFLICT", "Skill destination bytes do not match the inspected state.");
    if (inspected.state === "before") await host.applyAndVerify(inspected.plan);
    await host.commit(inspected.plan, fingerprint);
    return inspected.plan.result;
  });
}

/** No implementation is installed by this module; the host must meet every
 * contract above and fence every other mutator until atomic commit or recovery. */
export async function executeLegacySkillLifecycle(host: LegacySkillLifecycleHost, actor: Actor, bindingValue: unknown, inputValue: unknown, fingerprint: string) {
  const binding = legacySkillBindingSchema.safeParse(bindingValue), input = legacySkillLifecycleInputSchema.safeParse(inputValue);
  if (!binding.success || !input.success || !digest.safeParse(fingerprint).success) return fail("INVALID_ARGUMENT", "Invalid Skill lifecycle request.");
  if (!actor?.id || !actor.canWrite || actor.id !== binding.data.actorId) return fail("ACCESS_DENIED", "Skill lifecycle actor is not approved.");
  let allowed = false;
  try { allowed = host.authorize(actor, binding.data, input.data.action) === true; } catch { /* deny */ }
  if (!allowed) return fail("ACCESS_DENIED", "Skill lifecycle policy denied this operation.");
  return host.withExclusive(async () => {
    const receipt = await host.replayOrFence(input.data.operationId, fingerprint);
    if (receipt.kind === "replay") {
      const result = legacySkillLifecycleOutputSchema.safeParse(receipt.result);
      if (!result.success || result.data.operationId !== input.data.operationId || result.data.action !== input.data.action) return fail("CONFLICT", "Invalid Skill lifecycle receipt.");
      return result.data;
    }
    const scan = await host.scan(binding.data);
    const plan = prepareLegacySkillLifecycle(binding.data, input.data, scan.source, scan.destination, scan.manifest);
    await host.stage(plan, fingerprint);
    await host.applyAndVerify(plan);
    await host.commit(plan, fingerprint);
    return plan.result;
  });
}
