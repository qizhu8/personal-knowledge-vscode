import { z } from "zod";
import { CoreError } from "./contracts.js";
import { sha256 } from "./file-write.js";
import { scanMarkdown } from "./markdown.js";
import { readSubscriptions } from "./subscription-reads.js";
import { subscriptionMaterializeInput, type SubscriptionMaterializeInput, type SubscriptionMaterializeResult } from "./subscription-materialize-contracts.js";
import { planSubscriptionMaterialize, previewSubscriptionMaterialize, recoverSubscriptionMaterialize } from "./subscription-materialize.js";
import {
  applyAlias, applyConflict, deserializeSubscriptionApplyPlan, portable, serializeSubscriptionApplyPlan,
  subscriptionApplyIdentities, validateSubscriptionApplyPlan,
  type SubscriptionApplyIdentity, type SubscriptionApplyPlan,
} from "./domain/subscription-apply-plan.js";
import {
  applyRoot, observeApplyWorkspace, publishApplyFile, scanApplyWorkspace,
  type SubscriptionApplyBoundary,
} from "./domain/subscription-apply-files.js";

export { deserializeSubscriptionApplyPlan, serializeSubscriptionApplyPlan, subscriptionApplyPlanSchema } from "./domain/subscription-apply-plan.js";
export type { SubscriptionApplyPlan, SubscriptionApplyIdentity } from "./domain/subscription-apply-plan.js";
export type { SubscriptionApplyBoundary } from "./domain/subscription-apply-files.js";

export interface SubscriptionApplyReceipt {
  kind: "subscription-apply/v1"; planSha256: string;
  result: SubscriptionMaterializeResult; identities: SubscriptionApplyIdentity[];
}
export interface SubscriptionApplyJournalTransaction {
  load(operationId: string): Promise<{ intent: string; receipt: SubscriptionApplyReceipt | null } | undefined>;
  /** Durable exclusive insert into the GLOBAL operation journal; never overwrite another operation. */
  persistIntent(operationId: string, intent: string): Promise<void>;
  /** One GLOBAL DB transaction: verify intent hash, reserve all identities/aliases and commit exact receipt. */
  commit(operationId: string, receipt: SubscriptionApplyReceipt): Promise<void>;
}
export interface SubscriptionApplyJournal {
  /** The same workspace writer lock used by every other domain, across processes and restarts. */
  runExclusive<T>(work: (transaction: SubscriptionApplyJournalTransaction) => Promise<T>): Promise<T>;
}
/** Host-only authenticated capability binding; never populate this from operation arguments. */
export interface SubscriptionApplyAuthority {
  actorId: string; sourceIp: string; subscriptionId: string; capabilityId: string;
}
export type SubscriptionApplyNativePolicy = (
  authority: Readonly<SubscriptionApplyAuthority>, source: Readonly<SubscriptionMaterializeInput["source"]>,
) => boolean | Promise<boolean>;

// No private database: the parent host maps this contract into its global migration.
export const subscriptionApplyJournalContract = Object.freeze({
  version: 1, operationKind: "subscription-apply/v1",
  operationKey: "GLOBAL UNIQUE operationId",
  intent: "canonical serialized SubscriptionApplyPlan, durable before any mkdir/write/link",
  commit: "same transaction: intent hash CAS + exact receipt + unique identity/alias reservations",
  recovery: "shared workspace lock; native ACL and source pins; exact baseline and ordered before/after hashes",
});

function parseInput(value: unknown): SubscriptionMaterializeInput {
  const parsed = subscriptionMaterializeInput.safeParse(value);
  if (!parsed.success) throw new CoreError("INVALID_ARGUMENT", "Invalid staged subscription snapshot.");
  return parsed.data;
}
function assertIdentitiesAvailable(root: string, plan: SubscriptionApplyPlan) {
  const planned = subscriptionApplyIdentities(plan.material);
  const addresses = new Set(plan.material.changes.map(change => `${change.area}/${change.path}`));
  const ids = new Set(planned.flatMap(item => [item.documentId, ...(item.knowledgeId ? [item.knowledgeId] : [])]));
  const aliases = new Set(planned.flatMap(item => item.aliases.map(portable)));
  for (const doc of scanMarkdown(root)) {
    if (addresses.has(`${doc.record.area}/${doc.record.path}`)) continue;
    const knowledgeId = doc.metadata.get("knowledgeId");
    if (ids.has(doc.record.id) || typeof knowledgeId === "string" && ids.has(knowledgeId)) applyConflict("Existing identity is already owned.");
    const declared = doc.metadata.get("aliases") === undefined ? [] : doc.metadata.toJS({ maxAliasCount: 0 }).aliases;
    if (!Array.isArray(declared) || declared.some(alias => typeof alias !== "string")) applyConflict("Invalid local aliases.");
    for (const alias of [...declared, applyAlias(doc.record.area, doc.record.path)]) {
      if (aliases.has(portable(alias))) applyConflict("Existing alias is already owned.");
    }
  }
}

/** Not a public operation handler: the host supplies its global journal and authenticated binding. */
export class SubscriptionApplyHost {
  private readonly root: string;
  private readonly authority: Readonly<SubscriptionApplyAuthority>;
  constructor(root: string, private readonly journal: SubscriptionApplyJournal, authority: SubscriptionApplyAuthority,
    private readonly nativePolicy?: SubscriptionApplyNativePolicy) {
    this.root = applyRoot(root);
    const parsed = z.strictObject({
      actorId: z.string().min(1).max(256), sourceIp: z.string().min(1).max(256),
      subscriptionId: z.string().min(1).max(256), capabilityId: z.string().min(1).max(256),
    }).safeParse(authority);
    if (!parsed.success) throw new CoreError("ACCESS_DENIED", "A trusted native authority is required.");
    this.authority = Object.freeze(parsed.data);
  }
  private async authorize(source: SubscriptionMaterializeInput["source"], expectedRevision?: string): Promise<string> {
    applyRoot(this.root);
    if (this.nativePolicy && await this.nativePolicy(this.authority, Object.freeze({ ...source })) !== true) {
      throw new CoreError("ACCESS_DENIED", "Injected native ACL/source policy denied subscription materialization.");
    }
    const { actorId, sourceIp, subscriptionId, capabilityId } = this.authority;
    if (source.subscriptionId !== subscriptionId || source.capabilityId !== capabilityId) throw new CoreError("ACCESS_DENIED", "Capability binding mismatch.");
    const record = await readSubscriptions(this.root, {
      operation: "subscription.get", actorId, args: { id: subscriptionId },
    }) as { revision: string; subscription: Record<string, unknown> };
    const native = record.subscription;
    for (const key of ["nodeId", "shareId", "brokerName", "publisherUser", "publisherHost", "revision", "collectionHash"] as const) {
      if (native[key] !== source[key]) throw new CoreError("REVISION_CONFLICT", "Native subscription source pin changed.");
    }
    if (native.status !== "current") throw new CoreError("ACCESS_DENIED", "Only a current native subscription may be forked.");
    const acl = await readSubscriptions(this.root, {
      operation: "subscription.acl.evaluate", actorId,
      args: { shareId: source.shareId, sourceIp, action: "download", expectedRevision: record.revision },
    }) as { allowed: boolean };
    if (!acl.allowed) throw new CoreError("ACCESS_DENIED", "Persisted native ACL denied local materialization.");
    if (expectedRevision !== undefined && expectedRevision !== record.revision) throw new CoreError("REVISION_CONFLICT", "Native authority snapshot changed.");
    return record.revision;
  }
  async preview(value: unknown) {
    const input = parseInput(value);
    return this.journal.runExclusive(async () => {
      const revision = await this.authorize(input.source);
      scanApplyWorkspace(this.root);
      const result = previewSubscriptionMaterialize(this.root, input, this.authority.actorId, () => true);
      await this.authorize(input.source, revision);
      return result;
    });
  }
  /** Host retry gate: a global receipt must not bypass current native ACL/source pins. */
  async assertAuthorized(value: unknown, expectedRevision?: string): Promise<void> {
    await this.authorize(parseInput(value).source, expectedRevision);
  }
  async apply(value: unknown, operationId: string, expectedWorkspaceRevision: string, boundary: SubscriptionApplyBoundary = () => {}) {
    const input = parseInput(value);
    if (!z.string().uuid().safeParse(operationId).success || !/^[a-f0-9]{64}$/.test(expectedWorkspaceRevision)) throw new CoreError("INVALID_ARGUMENT", "Invalid apply operation identity or revision.");
    return this.journal.runExclusive(async transaction => {
      const nativeRevision = await this.authorize(input.source);
      const existing = await transaction.load(operationId);
      let plan: SubscriptionApplyPlan;
      if (existing) {
        plan = deserializeSubscriptionApplyPlan(existing.intent);
        if (plan.material.operationId !== operationId || plan.material.actorId !== this.authority.actorId
          || plan.inputSha256 !== sha256(JSON.stringify(input)) || plan.material.workspaceRevision !== expectedWorkspaceRevision) applyConflict("Operation replay arguments differ.");
      } else {
        const material = planSubscriptionMaterialize(this.root, input, this.authority.actorId, () => true, operationId, expectedWorkspaceRevision);
        const baseline = scanApplyWorkspace(this.root);
        const body = { kind: "subscription-apply/v1" as const, material, inputSha256: sha256(JSON.stringify(input)), nativeRevision, baseline };
        plan = validateSubscriptionApplyPlan({ ...body, planSha256: sha256(JSON.stringify(body)) });
        assertIdentitiesAvailable(this.root, plan);
        await this.authorize(input.source, nativeRevision);
        await transaction.persistIntent(operationId, serializeSubscriptionApplyPlan(plan));
        boundary("intent");
      }
      return this.finish(transaction, plan, existing?.receipt ?? null, boundary);
    });
  }
  async recover(operationId: string, boundary: SubscriptionApplyBoundary = () => {}) {
    if (!z.string().uuid().safeParse(operationId).success) throw new CoreError("INVALID_ARGUMENT", "Invalid recovery operation.");
    return this.journal.runExclusive(async transaction => {
      const pending = await transaction.load(operationId);
      if (!pending) throw new CoreError("NOT_FOUND", "No shared journal intent.");
      const plan = deserializeSubscriptionApplyPlan(pending.intent);
      if (plan.material.operationId !== operationId || plan.material.actorId !== this.authority.actorId) applyConflict("Recovery actor/operation mismatch.");
      return this.finish(transaction, plan, pending.receipt, boundary);
    });
  }
  private async finish(transaction: SubscriptionApplyJournalTransaction, plan: SubscriptionApplyPlan, committed: SubscriptionApplyReceipt | null, boundary: SubscriptionApplyBoundary) {
    await this.authorize(plan.material.source, plan.nativeRevision);
    const observed = observeApplyWorkspace(this.root, plan);
    const decision = recoverSubscriptionMaterialize(plan.material, this.authority.actorId, plan.material.operationId, observed);
    const receipt: SubscriptionApplyReceipt = {
      kind: "subscription-apply/v1", planSha256: plan.planSha256,
      result: plan.material.result, identities: subscriptionApplyIdentities(plan.material),
    };
    if (committed) {
      if (decision.completed !== plan.material.changes.length || JSON.stringify(committed) !== JSON.stringify(receipt)) applyConflict("Committed receipt or files differ.");
      return receipt;
    }
    // Visit completed entries too: a crash may have left a known staging hard link to remove.
    for (let index = 0; index < plan.material.changes.length; index++) {
      await this.authorize(plan.material.source, plan.nativeRevision);
      recoverSubscriptionMaterialize(plan.material, this.authority.actorId, plan.material.operationId, observeApplyWorkspace(this.root, plan));
      await publishApplyFile(this.root, plan, index, boundary, async () => {
        await this.authorize(plan.material.source, plan.nativeRevision);
        recoverSubscriptionMaterialize(plan.material, this.authority.actorId, plan.material.operationId, observeApplyWorkspace(this.root, plan));
      });
    }
    await this.authorize(plan.material.source, plan.nativeRevision);
    const final = recoverSubscriptionMaterialize(plan.material, this.authority.actorId, plan.material.operationId, observeApplyWorkspace(this.root, plan));
    if (final.remaining.length) applyConflict("Incomplete filesystem application.");
    assertIdentitiesAvailable(this.root, plan);
    boundary("before-commit");
    await this.authorize(plan.material.source, plan.nativeRevision);
    recoverSubscriptionMaterialize(plan.material, this.authority.actorId, plan.material.operationId, observeApplyWorkspace(this.root, plan));
    await transaction.commit(plan.material.operationId, receipt);
    boundary("commit");
    return receipt;
  }
}
