import type { SubscriptionApplyHost, SubscriptionApplyReceipt } from "./subscription-apply.js";
import type { SubscriptionMaterializeInput } from "./subscription-materialize-contracts.js";

export interface SubscriptionTransportEndpoint {
  /** Host-issued configuration, never populated from a remote summary or public operation arguments. */
  bindingId: string;
  controlUrl: string;
  connectAddress: string;
  transferPorts: readonly number[];
  secretRef: string;
  publisherPublicKey: string;
}
export interface SubscriptionTransportRequest {
  operationId: string;
  source: SubscriptionMaterializeInput["source"];
  area: SubscriptionMaterializeInput["area"];
  paths: string[];
  mode: "fork" | "readonly-mirror";
  expiresAt: string;
}
export interface SubscriptionTransportReceipt {
  kind: "subscription-transport/v1";
  operationId: string;
  mode: SubscriptionTransportRequest["mode"];
  source: SubscriptionMaterializeInput["source"];
  snapshotSha256: string;
  bytes: number;
  readOnly: boolean;
  /** No endpoint, broker URL, ticket, proof, secret reference or remote grant metadata. */
  apply: SubscriptionApplyReceipt | null;
}
export type SubscriptionTransferPhase = "intent" | "downloading" | "verified" | "applying" | "complete" | "cancelled" | "expired";
export interface SubscriptionTransferState {
  revision: number;
  intent: string;
  phase: SubscriptionTransferPhase;
  receipt: SubscriptionTransportReceipt | null;
  runnerId: string | null;
  leaseUntil: number;
  verifiedBytes: number | null;
}
export interface SubscriptionTransferTransaction {
  load(): Promise<SubscriptionTransferState | undefined>;
  /** Exclusive GLOBAL operation subrecord insert, durable before any staging file or network request. */
  create(state: SubscriptionTransferState): Promise<void>;
  /** Global DB compare-and-swap; false means another writer changed this operation. */
  compareAndSwap(expectedRevision: number, next: SubscriptionTransferState): Promise<boolean>;
}
export interface SubscriptionTransferStore {
  /** Same cross-process lock/global database as apply journal; transfer is a subrecord, not a second opId owner. */
  runExclusive<T>(operationId: string, work: (transaction: SubscriptionTransferTransaction) => Promise<T>): Promise<T>;
}
export interface SubscriptionTransportSecrets {
  /** Fresh host-issued signed subscriber proof, scoped to shareId; never returned in receipts or persisted. */
  resolve(secretRef: string, shareId: string): Promise<{ subscriberProof: string }>;
}
export interface SubscriptionTransportResponse {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: AsyncIterable<Uint8Array>;
}
export type SubscriptionTransportFetch = (
  url: URL, method: "GET" | "POST", headers: Readonly<Record<string, string>>,
  signal: AbortSignal, connectAddress: string,
) => Promise<SubscriptionTransportResponse>;
export interface SubscriptionTransportHostOptions {
  endpoint?: SubscriptionTransportEndpoint;
  stagingRoot: string;
  store: SubscriptionTransferStore;
  applyHost: SubscriptionApplyHost;
  secrets: SubscriptionTransportSecrets;
  /** Required native source ACL/identity fence; returns a revision pin, and runs before and after async work. */
  authorize(source: Readonly<SubscriptionMaterializeInput["source"]>, mode: SubscriptionTransportRequest["mode"]): Promise<string>;
  fetch?: SubscriptionTransportFetch;
  now?: () => number;
}
export const subscriptionTransportStoreContract = Object.freeze({
  kind: "subscription-transport/v1", ownership: "GLOBAL operationId with transport subrecord + subscription-apply journal",
  CAS: "revision increments by one; immutable canonical intent contains host bindingId, request and native ACL revision",
  lease: "15-second renewable runner lease bounded by capability expiry; owner/revision fence after each asynchronous authorization; superseded runner never unlinks another runner's partial",
  durability: "intent before sockets/files; verified digest fsync before verified; applying before SubscriptionApplyHost",
  recovery: "downloading bytes discarded; verified bytes reused after hash/native ACL/fresh signed source fetch revalidation; applying uses applyHost.recover only; unknown apply intent fails closed",
  mirror: "immutable host-only verified source snapshot; readonly source identity; never registers writable knowledge identity",
  unsupported: "encrypted snapshots, archives and package file arrays; no Range/partial byte resume in original protocol",
});
