import { z } from "zod";
import { CoreError, documentId } from "../contracts.js";
import { documentPath, knowledgeArea, resourcePath } from "../document-path.js";
import { sha256 } from "../file-write.js";
import { decodeMarkdown } from "../markdown.js";
import { legacyKnowledgeAlias } from "./knowledge-contracts.js";
import { forkRootName } from "./subscription-materialize-original-fork.js";
import { subscriptionMaterializeResultSchema, subscriptionMaterializeSource } from "../subscription-materialize-contracts.js";
import { recoverSubscriptionMaterialize, type SubscriptionMaterializePlan } from "../subscription-materialize.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().min(1).max(256).refine(value => !/[\u0000-\u001f]/.test(value));
const change = z.strictObject({
  area: knowledgeArea, path: resourcePath, beforeSha256: z.null(), afterSha256: digest,
  afterBase64: z.string().max(22_369_624),
});
const material = z.strictObject({
  kind: z.literal("subscription-materialize/v1"), operationId: z.string().uuid(), actorId: name,
  source: subscriptionMaterializeSource, snapshotSha256: digest, workspaceRevision: digest,
  changes: z.array(change).min(1).max(2560), result: subscriptionMaterializeResultSchema,
  requiresCompoundJournal: z.literal(true), planSha256: digest,
});
const entry = z.strictObject({
  area: knowledgeArea, path: resourcePath, sha256: digest.nullable(),
});
export const subscriptionApplyPlanSchema = z.strictObject({
  kind: z.literal("subscription-apply/v1"), material, inputSha256: digest,
  nativeRevision: digest, baseline: z.array(entry).max(8192), planSha256: digest,
});
export type SubscriptionApplyPlan = z.infer<typeof subscriptionApplyPlanSchema>;
export type SubscriptionApplyEntry = z.infer<typeof entry>;
export interface SubscriptionApplyIdentity {
  area: z.infer<typeof knowledgeArea>; path: string; documentId: string;
  knowledgeId: string | null; aliases: string[]; sourceAlias: string;
}

export function applyConflict(message: string): never { throw new CoreError("RECOVERY_CONFLICT", message); }
export const portable = (value: string) => value.normalize("NFC").toLocaleLowerCase("en-US");
export function applyAlias(area: string, path: string): string {
  return legacyKnowledgeAlias(area === "skills" ? "skill" : area === "papers" ? "research" : "note", path);
}

/** Original file forks copy bytes and retain explicit IDs/aliases. Path-derived IDs move with the path. */
export function subscriptionApplyIdentities(plan: SubscriptionMaterializePlan): SubscriptionApplyIdentity[] {
  const identities = new Set<string>(), aliases = new Set<string>();
  const root = forkRootName(plan.source.brokerName, plan.source.publisherUser, plan.source.publisherHost);
  if (root !== plan.result.forkRoot) applyConflict("Unexpected original fork root.");
  return plan.result.mappings.map(mapping => {
    const path = `${root}/${mapping.sourcePath}`;
    if (!documentPath.safeParse(mapping.sourcePath).success || path !== mapping.destinationPath
      || mapping.sourceAlias !== applyAlias(plan.result.area, mapping.sourcePath)
      || mapping.destinationAlias !== applyAlias(plan.result.area, path)) applyConflict("Forged identity mapping.");
    const bytes = plan.changes.find(item => item.path === path);
    if (!bytes) applyConflict("Missing mapped Markdown.");
    const raw = Buffer.from(bytes.afterBase64, "base64").toString("utf8");
    if (Buffer.from(raw).toString("base64") !== bytes.afterBase64) applyConflict("Invalid Markdown encoding.");
    const implicit = `legacy_${sha256(plan.result.area === "notes" ? path : `${plan.result.area}/${path}`).slice(0, 32)}`;
    const doc = decodeMarkdown(implicit, raw, path, plan.result.area);
    const data = doc.metadata.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
    const declared = data.aliases ?? [];
    if (!Array.isArray(declared) || declared.some(alias => typeof alias !== "string" || !alias || /[\u0000-\u001f]/.test(alias))) applyConflict("Invalid declared aliases.");
    if (JSON.stringify(declared) !== JSON.stringify(mapping.aliases)) applyConflict("Aliases differ from original bytes.");
    const prototype = data.schema === "pkm.knowledge/v1" && data.revision !== undefined && data.deleted !== undefined
      ? [...new Set((declared as string[]).filter(alias => alias.startsWith("note:") && documentId.safeParse(alias.slice(5)).success).map(alias => alias.slice(5)))] : [];
    const explicit = data.documentId ?? (prototype.length === 1 ? prototype[0] : data.knowledgeId);
    if ((explicit ?? null) !== mapping.identity) applyConflict("Identity differs from original bytes.");
    const id = typeof explicit === "string" ? explicit : implicit;
    const knowledgeId = typeof data.knowledgeId === "string" ? data.knowledgeId : null;
    for (const value of new Set([id, ...(knowledgeId ? [knowledgeId] : [])])) {
      if (identities.has(value)) applyConflict("Duplicate identity.");
      identities.add(value);
    }
    const outputAliases: string[] = [];
    for (const alias of [...declared as string[], mapping.destinationAlias]) {
      const folded = portable(alias);
      if (aliases.has(folded)) applyConflict("Duplicate or ambiguous alias.");
      aliases.add(folded);
      outputAliases.push(alias);
    }
    return { area: plan.result.area, path, documentId: id, knowledgeId, aliases: outputAliases, sourceAlias: mapping.sourceAlias };
  });
}

export function validateSubscriptionApplyPlan(value: unknown): SubscriptionApplyPlan {
  const parsed = subscriptionApplyPlanSchema.safeParse(value);
  if (!parsed.success) applyConflict("Invalid strict subscription apply intent.");
  const plan = parsed.data;
  const { planSha256, ...body } = plan;
  if (sha256(JSON.stringify(body)) !== planSha256) applyConflict("Apply intent digest mismatch.");
  recoverSubscriptionMaterialize(plan.material, plan.material.actorId, plan.material.operationId, plan.material.changes.map(() => null));
  subscriptionApplyIdentities(plan.material);
  for (const change of plan.material.changes) {
    if (Buffer.from(change.afterBase64, "base64").toString("base64") !== change.afterBase64) applyConflict("Noncanonical persisted bytes.");
  }
  for (const asset of plan.material.result.assets) {
    if (asset.destinationPath !== `${plan.material.result.forkRoot}/${asset.sourcePath}`) applyConflict("Forged asset mapping.");
  }
  const paths = new Set<string>();
  const spellings = new Map<string, string>();
  const files = new Set<string>();
  for (const item of [...plan.baseline, ...plan.material.changes.map(item => ({ ...item, sha256: item.afterSha256 }))]) {
    if (item.path.split("/").some(part => part.toLowerCase() === "system")) applyConflict("Reserved path.");
    const key = portable(`${item.area}/${item.path}`);
    if (paths.has(key)) applyConflict("Duplicate portable intent path.");
    paths.add(key);
    if (item.sha256 !== null) files.add(key);
    const parts = `${item.area}/${item.path}`.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join("/"), folded = portable(prefix);
      if (spellings.has(folded) && spellings.get(folded) !== prefix) applyConflict("Ambiguous portable parent spelling.");
      spellings.set(folded, prefix);
    }
  }
  for (const item of [...plan.baseline, ...plan.material.changes]) {
    const parts = `${item.area}/${item.path}`.split("/");
    for (let i = 2; i < parts.length; i++) {
      const parent = portable(parts.slice(0, i).join("/"));
      if (files.has(parent)) applyConflict("File/directory intent collision.");
    }
  }
  return plan;
}

export function serializeSubscriptionApplyPlan(plan: SubscriptionApplyPlan): string {
  return JSON.stringify(validateSubscriptionApplyPlan(plan));
}
export function deserializeSubscriptionApplyPlan(serialized: string): SubscriptionApplyPlan {
  if (typeof serialized !== "string" || Buffer.byteLength(serialized) > 60_000_000) applyConflict("Oversized serialized intent.");
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { applyConflict("Malformed serialized intent."); }
  const plan = validateSubscriptionApplyPlan(value);
  // Canonical encoding also rejects duplicate JSON keys, which JSON.parse otherwise silently loses.
  if (JSON.stringify(plan) !== serialized) applyConflict("Noncanonical serialized intent.");
  return plan;
}
