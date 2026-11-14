import { z } from "zod";
import { SubscriptionBundleHost, type SubscriptionBundleRequest, type SubscriptionBundleAuthority, type VerifiedSubscriptionBundle } from "./subscription-bundle.js";
import {
  subscriptionBundleApplyPlanSchema, type SubscriptionBundleApplyPlan, type SubscriptionBundleApplyReceipt,
  type SubscriptionBundleApplyJournal, type SubscriptionBundleApplyNativePolicy, type SubscriptionBundleApplyBoundary,
} from "./subscription-bundle-apply-contracts.js";
import { bundleApplyScan, bundleApplyStage, observeBundleApply, publishBundleApply } from "./subscription-bundle-apply-files.js";
import { applyRoot, safeRead } from "./domain/subscription-apply-files.js";
import { bundleError, bundleHash, bundleJson, bundlePath, extractBundle } from "./domain/subscription-bundle-validation.js";
import { forkRootName } from "./domain/subscription-materialize-original-fork.js";
import { decodeMarkdown, scanMarkdown } from "./markdown.js";
import { applyAlias } from "./domain/subscription-apply-plan.js";
import { sha256 } from "./file-write.js";
import { documentId } from "./contracts.js";

export { subscriptionBundleApplyJournalContract } from "./subscription-bundle-apply-contracts.js";
export type { SubscriptionBundleApplyPlan, SubscriptionBundleApplyReceipt, SubscriptionBundleApplyJournal, SubscriptionBundleApplyNativePolicy } from "./subscription-bundle-apply-contracts.js";
function material(source: SubscriptionBundleApplyPlan["source"], snapshot: string, baseline: SubscriptionBundleApplyPlan["baseline"]) {
  const parsed = bundleJson(Buffer.from(snapshot));
  const kinds = ["notes", "skills", "papers", "packages", "prompts", "scripts", "servers", "recipes"];
  const counts = Object.fromEntries(kinds.map(kind => [kind, Array.isArray(parsed[kind]) ? parsed[kind].length : 0]));
  const files = extractBundle(Buffer.from(snapshot), counts, Object.values(counts).reduce((sum, n) => sum + n, 0));
  for (const asset of files.filter(file => file.encoding === "base64")) {
    const parts = asset.path.split("/");
    for (let n = 0; n < parts.length - 1; n++) {
      if (/\.assets$/i.test(parts[n]!)) {
        const owner = [...parts.slice(0, n), `${parts[n]!.slice(0, -7)}.md`].join("/");
        if (!files.some(file => file.area === asset.area && file.encoding !== "base64" && file.path === owner)) bundleError("RECOVERY_CONFLICT");
      }
    }
  }
  const folkRoot = forkRootName(source.brokerName, source.publisherUser, source.publisherHost);
  const changes: SubscriptionBundleApplyPlan["changes"] = [], identities: SubscriptionBundleApplyPlan["identities"] = [];
  const packageRoots = new Map<string, string>();
  const cleanName = (value: string, fallback: string) => value.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
  const packageList = parsed.packages ?? [];
  if (!Array.isArray(packageList)) bundleError("INVALID_FORMAT");
  for (const raw of packageList) {
    const pkg = raw as { name: string; files: unknown[] };
    const base = `${cleanName(pkg.name, "package")}_${cleanName(source.brokerName, "Broker")}`;
    let target = base, suffix = 0;
    const occupied = (name: string) => baseline.some(e => e.path.toLowerCase() === `packages/${name}`.toLowerCase()
      || e.path.toLowerCase().startsWith(`packages/${name}/`.toLowerCase())) || [...packageRoots.values()].some(v => v.toLowerCase() === name.toLowerCase());
    while (occupied(target)) target = `${base}${++suffix}`;
    packageRoots.set(pkg.name, target);
    const provenance = JSON.stringify({
      schema: 1, kind: "subscription-fork", originalName: pkg.name,
      brokerName: source.brokerName, publisherUser: source.publisherUser, publisherHost: source.publisherHost,
    }, null, 2) + "\n";
    const path = bundlePath(`packages/${target}/.pkm-package.json`);
    changes.push({ path, beforeSha256: null, afterSha256: bundleHash(provenance), afterBase64: Buffer.from(provenance).toString("base64") });
    identities.push({ area: "packages", path: target, documentId: null, knowledgeId: null, aliases: [`package:${target}`], sourcePath: pkg.name, packageName: pkg.name });
  }
  for (const file of files) {
    const pkgName = file.area === "packages" ? file.path.split("/")[0]! : null;
    const relative = file.area === "packages" ? `${packageRoots.get(pkgName!)}/${file.path.slice(pkgName!.length + 1)}` : `${folkRoot}/${file.path}`;
    const path = bundlePath(`${file.area}/${relative}`);
    if (file.area === "packages" && file.path.slice(pkgName!.length + 1).toLowerCase() === ".pkm-package.json") bundleError("RECOVERY_CONFLICT");
    const bytes = file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content);
    changes.push({ path, beforeSha256: null, afterSha256: bundleHash(bytes), afterBase64: bytes.toString("base64") });
    if (file.area !== "packages" && file.encoding !== "base64") {
      const implicit = `legacy_${sha256(file.area === "notes" ? relative : `${file.area}/${relative}`).slice(0, 32)}`;
      const doc = decodeMarkdown(implicit, file.content, relative, file.area);
      const data = doc.metadata.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
      const aliases = data.aliases ?? [];
      if (!Array.isArray(aliases) || aliases.some(v => typeof v !== "string" || !v || /[\u0000-\u001f]/.test(v))) bundleError("RECOVERY_CONFLICT");
      const prototype = data.schema === "pkm.knowledge/v1" && data.revision !== undefined && data.deleted !== undefined
        ? [...new Set((aliases as string[]).filter(a => a.startsWith("note:") && documentId.safeParse(a.slice(5)).success).map(a => a.slice(5)))] : [];
      const explicit = data.documentId ?? (prototype.length === 1 ? prototype[0] : data.knowledgeId);
      const id = explicit ?? implicit;
      if (!documentId.safeParse(id).success || typeof id !== "string") bundleError("RECOVERY_CONFLICT");
      identities.push({
        area: file.area, path: relative, documentId: id,
        knowledgeId: typeof data.knowledgeId === "string" ? data.knowledgeId : null,
        aliases: [...aliases as string[], applyAlias(file.area, relative)], sourcePath: file.path, packageName: null,
      });
    }
  }
  return { changes, identities };
}
export function validateSubscriptionBundleApplyPlan(value: unknown): SubscriptionBundleApplyPlan {
  const parsed = subscriptionBundleApplyPlanSchema.safeParse(value);
  if (!parsed.success) bundleError("RECOVERY_CONFLICT");
  const plan = parsed.data, { planSha256, ...body } = plan;
  if (bundleHash(JSON.stringify(body)) !== planSha256 || plan.ciphertextSha256 !== plan.source.collectionHash
    || bundleHash(plan.snapshot) !== plan.plaintextSha256 || Buffer.byteLength(plan.snapshot) > 16_777_216) bundleError("RECOVERY_CONFLICT");
  const expected = material(plan.source, plan.snapshot, plan.baseline);
  if (JSON.stringify(expected.changes) !== JSON.stringify(plan.changes) || JSON.stringify(expected.identities) !== JSON.stringify(plan.identities)) bundleError("RECOVERY_CONFLICT");
  const spellings = new Map<string, string>(), paths = new Set<string>(), files = new Set<string>();
  let total = 0;
  for (const entry of [...plan.baseline, ...plan.changes.map(c => ({ path: c.path, sha256: c.afterSha256 }))]) {
    const path = bundlePath(entry.path), folded = path.toLowerCase();
    if (paths.has(folded) || !["notes", "skills", "papers", "packages"].includes(path.split("/")[0]!)) bundleError("RECOVERY_CONFLICT");
    paths.add(folded); if (entry.sha256 !== null) files.add(folded);
    const parts = path.split("/");
    for (let n = 1; n <= parts.length; n++) {
      const prefix = parts.slice(0, n).join("/"), key = prefix.toLowerCase();
      if (spellings.has(key) && spellings.get(key) !== prefix) bundleError("RECOVERY_CONFLICT");
      spellings.set(key, prefix);
    }
  }
  for (const path of paths) {
    const parts = path.split("/");
    for (let n = 1; n < parts.length; n++) if (files.has(parts.slice(0, n).join("/"))) bundleError("RECOVERY_CONFLICT");
  }
  for (let index = 0; index < plan.changes.length; index++) {
    const stage = bundlePath(bundleApplyStage(plan, index)).toLowerCase();
    if ([...paths].some(path => path === stage || path.startsWith(`${stage}/`))) bundleError("RECOVERY_CONFLICT");
  }
  for (const change of plan.changes) {
    const bytes = Buffer.from(change.afterBase64, "base64");
    if (bytes.toString("base64") !== change.afterBase64 || bundleHash(bytes) !== change.afterSha256 || (total += bytes.length) > 33_554_432) bundleError("RECOVERY_CONFLICT");
  }
  const ids = new Set<string>(), aliases = new Set<string>();
  for (const id of plan.identities) {
    for (const value of new Set([id.documentId, id.knowledgeId].filter((v): v is string => v !== null))) {
      if (ids.has(value)) bundleError("RECOVERY_CONFLICT"); ids.add(value);
    }
    for (const alias of id.aliases) {
      const key = alias.normalize("NFC").toLowerCase();
      if (aliases.has(key)) bundleError("RECOVERY_CONFLICT"); aliases.add(key);
    }
  }
  return plan;
}
export function serializeSubscriptionBundleApplyPlan(value: SubscriptionBundleApplyPlan): string {
  return JSON.stringify(validateSubscriptionBundleApplyPlan(value));
}
export function deserializeSubscriptionBundleApplyPlan(serialized: string): SubscriptionBundleApplyPlan {
  if (typeof serialized !== "string" || Buffer.byteLength(serialized) > 65_000_000) bundleError("RECOVERY_CONFLICT");
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { bundleError("RECOVERY_CONFLICT"); }
  const plan = validateSubscriptionBundleApplyPlan(value);
  if (JSON.stringify(plan) !== serialized) bundleError("RECOVERY_CONFLICT");
  return plan;
}
function receipt(plan: SubscriptionBundleApplyPlan): SubscriptionBundleApplyReceipt {
  return {
    kind: "subscription-bundle-apply/v1", operationId: plan.operationId, planSha256: plan.planSha256,
    source: plan.source, ciphertextSha256: plan.ciphertextSha256, plaintextSha256: plan.plaintextSha256,
    identities: plan.identities, files: plan.changes.map(c => ({ path: c.path, sha256: c.afterSha256 })),
  };
}
/** Native integration only; no registered public operation, secret store or private journal. */
export class SubscriptionBundleApplyHost {
  private readonly root: string;
  constructor(root: string, private readonly journal: SubscriptionBundleApplyJournal,
    private readonly policy: SubscriptionBundleApplyNativePolicy, private readonly actorId: string) {
    this.root = applyRoot(root);
    if (!z.string().min(1).max(256).safeParse(actorId).success) bundleError("ACCESS_DENIED");
  }
  private async fence(plan: Pick<SubscriptionBundleApplyPlan, "source" | "ciphertextSha256" | "plaintextSha256" | "authority" | "actorId">, signal: AbortSignal) {
    if (signal.aborted) bundleError("CANCELLED");
    applyRoot(this.root);
    if (plan.actorId !== this.actorId) bundleError("ACCESS_DENIED");
    let pin: SubscriptionBundleAuthority;
    try {
      pin = await this.policy.authorize(Object.freeze({
        actorId: this.actorId, source: Object.freeze({ ...plan.source }),
        ciphertextSha256: plan.ciphertextSha256, plaintextSha256: plan.plaintextSha256,
      }), signal);
    } catch { bundleError("ACCESS_DENIED"); }
    if (signal.aborted) bundleError("CANCELLED");
    if (!pin || pin.publisherPublicKey !== plan.authority.publisherPublicKey || pin.policyRevision !== plan.authority.policyRevision) bundleError("ACCESS_DENIED");
    if (pin.keyEpoch !== plan.authority.keyEpoch) bundleError("STALE_KEY_EPOCH");
  }
  private assertIdentities(plan: SubscriptionBundleApplyPlan, observed: boolean[]) {
    const occupiedPaths = new Set(plan.changes.filter((_, n) => observed[n]).map(c => c.path));
    const ids = new Set(plan.identities.flatMap(i => [i.documentId, i.knowledgeId].filter((v): v is string => v !== null)));
    const aliases = new Set(plan.identities.flatMap(i => i.aliases).map(v => v.normalize("NFC").toLowerCase()));
    for (const doc of scanMarkdown(this.root)) {
      if (occupiedPaths.has(`${doc.record.area}/${doc.record.path}`)) continue;
      const metadata = doc.metadata.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
      if (ids.has(doc.record.id) || typeof metadata.knowledgeId === "string" && ids.has(metadata.knowledgeId)) bundleError("RECOVERY_CONFLICT");
      const declared = metadata.aliases ?? [];
      if (!Array.isArray(declared) || declared.some(v => typeof v !== "string")) bundleError("RECOVERY_CONFLICT");
      for (const alias of [...declared as string[], applyAlias(doc.record.area, doc.record.path)]) {
        if (aliases.has(alias.normalize("NFC").toLowerCase())) bundleError("RECOVERY_CONFLICT");
      }
    }
  }
  private async execute(plan: SubscriptionBundleApplyPlan, existingReceipt: SubscriptionBundleApplyReceipt | null,
    transaction: Parameters<Parameters<SubscriptionBundleApplyJournal["runExclusive"]>[0]>[0], signal: AbortSignal, boundary: SubscriptionBundleApplyBoundary) {
    await this.fence(plan, signal);
    const observed = observeBundleApply(this.root, plan);
    this.assertIdentities(plan, observed);
    const expected = receipt(plan);
    if (existingReceipt) {
      if (!observed.every(Boolean) || JSON.stringify(existingReceipt) !== JSON.stringify(expected)) bundleError("RECOVERY_CONFLICT");
      return existingReceipt;
    }
    for (let index = 0; index < plan.changes.length; index++) {
      await this.fence(plan, signal);
      observeBundleApply(this.root, plan);
      await publishBundleApply(this.root, plan, index, boundary, () => this.fence(plan, signal));
    }
    await this.fence(plan, signal);
    if (!observeBundleApply(this.root, plan).every(Boolean)) bundleError("RECOVERY_CONFLICT");
    this.assertIdentities(plan, plan.changes.map(() => true));
    boundary("before-commit");
    await this.fence(plan, signal);
    if (!observeBundleApply(this.root, plan).every(Boolean)) bundleError("RECOVERY_CONFLICT");
    this.assertIdentities(plan, plan.changes.map(() => true));
    await transaction.commit(plan.operationId, plan.planSha256, expected);
    boundary("commit");
    return expected;
  }
  async apply(codec: SubscriptionBundleHost, request: SubscriptionBundleRequest, stagingRoot: string, operationId: string,
    signal: AbortSignal = new AbortController().signal, boundary: SubscriptionBundleApplyBoundary = () => {}): Promise<SubscriptionBundleApplyReceipt> {
    if (!z.string().uuid().safeParse(operationId).success || request.mode !== "fork") bundleError("INVALID_ARGUMENT");
    return codec.consume(request, stagingRoot, {
      consume: async (bundle: VerifiedSubscriptionBundle, stage, innerSignal, authority) => this.journal.runExclusive(async transaction => {
        const binding = {
          actorId: this.actorId, source: { ...bundle.source }, ciphertextSha256: bundle.source.collectionHash,
          plaintextSha256: bundle.plaintextSha256, authority: { ...authority },
        };
        await this.fence(binding, innerSignal);
        // The native bridge consumes only codec-owned verified stage bytes, never a caller path.
        for (const file of bundle.files) {
          const actual = safeRead(stage, file.stagePath);
          if (!actual || actual.stat.nlink !== 1n || bundleHash(actual.bytes) !== file.sha256) bundleError("RECOVERY_CONFLICT");
        }
        const old = await transaction.load(operationId);
        if (old) {
          const plan = deserializeSubscriptionBundleApplyPlan(old.intent);
          if (plan.operationId !== operationId || JSON.stringify(plan.source) !== JSON.stringify(binding.source)
            || plan.plaintextSha256 !== binding.plaintextSha256 || JSON.stringify(plan.authority) !== JSON.stringify(binding.authority)) bundleError("RECOVERY_CONFLICT");
          return this.execute(plan, old.receipt, transaction, innerSignal, boundary);
        }
        const baseline = bundleApplyScan(this.root);
        const body = {
          kind: "subscription-bundle-apply/v1" as const, operationId, ...binding, snapshot: bundle.snapshot,
          ...material(binding.source, bundle.snapshot, baseline), baseline,
        };
        const plan = validateSubscriptionBundleApplyPlan({ ...body, planSha256: bundleHash(JSON.stringify(body)) });
        observeBundleApply(this.root, plan); this.assertIdentities(plan, plan.changes.map(() => false));
        await this.fence(plan, innerSignal);
        await transaction.persistIntent(operationId, serializeSubscriptionBundleApplyPlan(plan)); boundary("intent");
        return this.execute(plan, null, transaction, innerSignal, boundary);
      }),
    }, signal);
  }
  async recover(operationId: string, signal: AbortSignal = new AbortController().signal,
    boundary: SubscriptionBundleApplyBoundary = () => {}): Promise<SubscriptionBundleApplyReceipt> {
    if (!z.string().uuid().safeParse(operationId).success) bundleError("INVALID_ARGUMENT");
    return this.journal.runExclusive(async transaction => {
      const stored = await transaction.load(operationId);
      if (!stored) bundleError("RECOVERY_CONFLICT");
      const plan = deserializeSubscriptionBundleApplyPlan(stored.intent);
      if (plan.operationId !== operationId) bundleError("RECOVERY_CONFLICT");
      return this.execute(plan, stored.receipt, transaction, signal, boundary);
    });
  }
}
