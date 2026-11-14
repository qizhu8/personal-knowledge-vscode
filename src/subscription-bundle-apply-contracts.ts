import { z } from "zod";
import { subscriptionMaterializeSource } from "./subscription-materialize-contracts.js";
import type { SubscriptionBundleAuthority } from "./subscription-bundle.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const name = z.string().min(1).max(256);
const identity = z.strictObject({
  area: z.enum(["notes", "skills", "papers", "packages"]), path: z.string().min(1).max(1024),
  documentId: name.nullable(), knowledgeId: name.nullable(), aliases: z.array(name).max(512),
  sourcePath: z.string().min(1).max(1024), packageName: name.nullable(),
});
export const subscriptionBundleApplyPlanSchema = z.strictObject({
  kind: z.literal("subscription-bundle-apply/v1"), operationId: z.string().uuid(), actorId: name,
  source: subscriptionMaterializeSource,
  ciphertextSha256: digest, plaintextSha256: digest,
  authority: z.strictObject({ publisherPublicKey: z.string().min(1).max(8192), keyEpoch: name, policyRevision: name }),
  snapshot: z.string().max(16_777_216),
  changes: z.array(z.strictObject({
    path: z.string().min(1).max(1024), beforeSha256: z.null(), afterSha256: digest,
    afterBase64: z.string().max(1_500_000),
  })).min(1).max(4352),
  identities: z.array(identity).max(4096),
  baseline: z.array(z.strictObject({ path: z.string().min(1).max(1024), sha256: digest.nullable() })).max(8192),
  planSha256: digest,
});
export type SubscriptionBundleApplyPlan = z.infer<typeof subscriptionBundleApplyPlanSchema>;
export interface SubscriptionBundleApplyReceipt {
  kind: "subscription-bundle-apply/v1";
  operationId: string;
  planSha256: string;
  source: SubscriptionBundleApplyPlan["source"];
  ciphertextSha256: string;
  plaintextSha256: string;
  identities: SubscriptionBundleApplyPlan["identities"];
  files: { path: string; sha256: string }[];
}
export interface SubscriptionBundleApplyTransaction {
  load(operationId: string): Promise<{ intent: string; receipt: SubscriptionBundleApplyReceipt | null } | undefined>;
  /** Global unique operationId insert; fsync/transaction durable before any mkdir/write. */
  persistIntent(operationId: string, serialized: string): Promise<void>;
  /** Atomic GLOBAL intent CAS + unique document/knowledge/alias/package reservations + exact receipt. */
  commit(operationId: string, planSha256: string, receipt: SubscriptionBundleApplyReceipt): Promise<void>;
}
export interface SubscriptionBundleApplyJournal {
  /** Shared cross-process workspace writer lock used by all domains; not a private adapter DB. */
  runExclusive<T>(work: (transaction: SubscriptionBundleApplyTransaction) => Promise<T>): Promise<T>;
}
export interface SubscriptionBundleApplyNativePolicy {
  /** Native authenticated grant lookup, NOT a check that request fields match themselves.
   * The host binds ciphertext collectionHash to authenticated plaintextSha256 and source identity
   * after original decryption/signature verification. Recovery must reauthenticate that SAME grant
   * against current subscription/source ACL and secret key epoch. Caller cannot create grants.
   */
  authorize(binding: Readonly<{
    actorId: string;
    source: SubscriptionBundleApplyPlan["source"];
    ciphertextSha256: string;
    plaintextSha256: string;
  }>, signal: AbortSignal): Promise<SubscriptionBundleAuthority>;
}
export type SubscriptionBundleApplyBoundary = (event: string) => void;
export const subscriptionBundleApplyJournalContract = Object.freeze({
  kind: "subscription-bundle-apply/v1",
  pins: "original ciphertext collectionHash + independently authenticated plaintext digest + native source ACL/secret epoch grant",
  lock: "GLOBAL workspace cross-process writer lock, including recovery and all sibling domains",
  durability: "unique operation intent before files; ordered absent/exact-after writes; same-filesystem exclusive hard-link publish + file/directory fsync",
  commit: "GLOBAL transaction CAS intent digest + all identity/alias/package reservations + exact receipt; no standalone package DB",
  recovery: "native authenticated grant/ACL/epoch before journal replay; strict semantic canonical intent; unchanged baseline; exact ordered prefix only; unknown bytes/links/stages fail closed",
  authority: "native policy injected into host constructor only; public operationId/request/serialized plan never grants decryption or ACL authority",
});
