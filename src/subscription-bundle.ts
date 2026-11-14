import { createDecipheriv, createHash, verify } from "node:crypto";
import type { SubscriptionApplyHost } from "./subscription-apply.js";
import { subscriptionMaterializeSource, type SubscriptionMaterializeInput } from "./subscription-materialize-contracts.js";
import { verifyShareSummary } from "./domain/subscription-bundle-original.js";
import {
  bundleBase64, bundleError, bundleHash, bundleJson, bundleLimits, bundleObject, extractBundle,
  type BundleArea, type BundleFile,
} from "./domain/subscription-bundle-validation.js";
import { withBundleStage } from "./domain/subscription-bundle-staging.js";

export { bundleLimits as subscriptionBundleLimits };
export type { BundleFile, BundleArea };
type Source = SubscriptionMaterializeInput["source"];
export interface SubscriptionBundleAuthority {
  readonly publisherPublicKey: string;
  /** Native-only fences: original encryption envelope has no key epoch or ACL revision field. */
  readonly keyEpoch: string;
  readonly policyRevision: string;
}
export interface SubscriptionBundleKeyLease {
  readonly epoch: string;
  /** Host transfers ownership of independent 32-byte buffers; zeroized even on failed/cancelled work. */
  readonly transferKey: Buffer;
  readonly contentKey: Buffer;
  release(): void | Promise<void>;
}
export interface SubscriptionBundleNativeHost {
  authorize(source: Readonly<Source>, mode: "readonly-mirror" | "fork", signal: AbortSignal): Promise<SubscriptionBundleAuthority>;
  resolveKeys(source: Readonly<Source>, authority: Readonly<SubscriptionBundleAuthority>, signal: AbortSignal): Promise<SubscriptionBundleKeyLease>;
}
export interface SubscriptionBundleProof {
  readonly schema: 1;
  readonly nodeId: string;
  readonly name: string;
  readonly publicKey: string;
  readonly shareId: string;
  readonly timestamp: number;
  readonly nonce: string;
  readonly signature: string;
}
export interface SubscriptionBundleRequest {
  source: Source;
  mode: "readonly-mirror" | "fork";
  summary: unknown;
  wire: Uint8Array;
}
export interface VerifiedSubscriptionBundle {
  readonly source: Readonly<Source>;
  readonly mode: "readonly-mirror" | "fork";
  readonly encrypted: boolean;
  readonly snapshot: string;
  readonly plaintextSha256: string;
  readonly files: readonly BundleFile[];
}
export interface SubscriptionBundleNativeAdapter<T> {
  /** Host-only verified conversion hook. Preserve ORIGINAL source collectionHash and identities.
   * Encrypted ciphertext digest must not be substituted with plaintext in native ACL records.
   * Adapter owns shared atomic journal/identity reservations; stage is ephemeral, never a receipt.
   */
  consume(bundle: VerifiedSubscriptionBundle, stage: string, signal: AbortSignal, authority: Readonly<SubscriptionBundleAuthority>): Promise<T>;
}
export interface SubscriptionBundleSigner {
  readonly publicKey: string;
  sign(unsigned: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
}
/** Exact original SubscriberProof JSON/signature order; no native key handle escapes. */
export async function signSubscriptionBundleProof(
  signer: SubscriptionBundleSigner,
  value: { name: string; shareId: string; timestamp: number; nonce: string },
  signal: AbortSignal,
): Promise<SubscriptionBundleProof> {
  if (signal.aborted) bundleError("CANCELLED");
  if (![value.name, value.shareId, value.nonce].every(v => typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f]/.test(v))
    || !Number.isSafeInteger(value.timestamp) || value.timestamp < 0) bundleError("INVALID_ARGUMENT");
  const unsigned = {
    schema: 1 as const,
    nodeId: createHash("sha256").update(Buffer.from(signer.publicKey)).digest("hex"),
    name: value.name, publicKey: signer.publicKey, shareId: value.shareId, timestamp: value.timestamp, nonce: value.nonce,
  };
  const bytes = Buffer.from(JSON.stringify(unsigned));
  let signature: Uint8Array;
  try { signature = await signer.sign(bytes, signal); } catch { bundleError("AUTHENTICATION_FAILED"); }
  if (signal.aborted) bundleError("CANCELLED");
  try { if (!verify(null, bytes, signer.publicKey, signature)) bundleError("AUTHENTICATION_FAILED"); }
  catch { bundleError("AUTHENTICATION_FAILED"); }
  return Object.freeze({ ...unsigned, signature: Buffer.from(signature).toString("base64url") });
}
/** Exact original X-PKM-Subscriber-Proof serialization, not a logged/persisted receipt. */
export function encodeSubscriptionBundleProof(proof: SubscriptionBundleProof): string {
  return Buffer.from(JSON.stringify(proof)).toString("base64url");
}
export class SubscriptionBundleHost {
  constructor(private readonly native: SubscriptionBundleNativeHost) {}
  private check(signal: AbortSignal) { if (signal.aborted) bundleError("CANCELLED"); }
  private async authorize(source: Readonly<Source>, mode: SubscriptionBundleRequest["mode"], signal: AbortSignal) {
    this.check(signal);
    let authority: SubscriptionBundleAuthority;
    try { authority = await this.native.authorize(source, mode, signal); } catch { bundleError("ACCESS_DENIED"); }
    this.check(signal);
    if (!authority || typeof authority.publisherPublicKey !== "string" || !authority.keyEpoch || !authority.policyRevision) bundleError("ACCESS_DENIED");
    return Object.freeze({ publisherPublicKey: authority.publisherPublicKey, keyEpoch: authority.keyEpoch, policyRevision: authority.policyRevision });
  }
  private async fence(source: Readonly<Source>, mode: SubscriptionBundleRequest["mode"], signal: AbortSignal, pin: SubscriptionBundleAuthority) {
    const current = await this.authorize(source, mode, signal);
    if (current.publisherPublicKey !== pin.publisherPublicKey || current.policyRevision !== pin.policyRevision) bundleError("ACCESS_DENIED");
    if (current.keyEpoch !== pin.keyEpoch) bundleError("STALE_KEY_EPOCH");
  }
  private async verify(request: SubscriptionBundleRequest, signal: AbortSignal): Promise<{ bundle: VerifiedSubscriptionBundle; pin: SubscriptionBundleAuthority }> {
    this.check(signal);
    const parsed = subscriptionMaterializeSource.safeParse(request.source);
    if (!parsed.success || !["readonly-mirror", "fork"].includes(request.mode)) bundleError("INVALID_ARGUMENT");
    const source = Object.freeze(parsed.data), mode = request.mode;
    if (!(request.wire instanceof Uint8Array) || request.wire.byteLength > bundleLimits.wireBytes) bundleError("QUOTA_EXCEEDED");
    // Snapshot caller-owned input before any native suspension.
    const wire = Buffer.from(request.wire);
    let summaryBytes: Buffer;
    try {
      const text = JSON.stringify(request.summary);
      if (typeof text !== "string" || Buffer.byteLength(text) > 65_536) bundleError("QUOTA_EXCEEDED");
      summaryBytes = Buffer.from(text);
    } catch { wire.fill(0); bundleError("INVALID_FORMAT"); }
    let pin: SubscriptionBundleAuthority;
    try { pin = await this.authorize(source, mode, signal); } catch (error) { wire.fill(0); throw error; }
    let summary: Record<string, unknown>;
    try {
      summary = bundleJson(summaryBytes);
      verifyShareSummary(summary, pin.publisherPublicKey, source.nodeId, source.shareId);
    } catch { wire.fill(0); bundleError("AUTHENTICATION_FAILED"); }
    if (summary.revision !== source.revision || summary.collectionHash !== source.collectionHash || summary.name !== source.brokerName) {
      wire.fill(0); bundleError("SOURCE_MISMATCH");
    }
    let lease: SubscriptionBundleKeyLease | undefined;
    let snapshot: Buffer<ArrayBufferLike> = wire;
    let plain: Buffer<ArrayBufferLike> | undefined;
    try {
      const encrypted = summary.secretProtected === true;
      if (summary.secretProtected !== undefined && typeof summary.secretProtected !== "boolean") bundleError("INVALID_FORMAT");
      if (encrypted) {
        bundleBase64(summary.secretSalt, 16);
        try { lease = await this.native.resolveKeys(source, pin, signal); } catch { bundleError("AUTHENTICATION_FAILED"); }
        this.check(signal);
        if (!lease || lease.epoch !== pin.keyEpoch) bundleError("STALE_KEY_EPOCH");
        if (!Buffer.isBuffer(lease.transferKey) || !Buffer.isBuffer(lease.contentKey)
          || lease.transferKey.length !== 32 || lease.contentKey.length !== 32) bundleError("AUTHENTICATION_FAILED");
        await this.fence(source, mode, signal, pin);
        if (wire.length < 36 || !wire.subarray(0, 8).equals(Buffer.from("PKMENC1\n"))) bundleError("INVALID_FORMAT");
        try {
          const decipher = createDecipheriv("aes-256-gcm", lease.transferKey, wire.subarray(8, 20));
          decipher.setAuthTag(wire.subarray(wire.length - 16));
          const pending = decipher.update(wire.subarray(20, wire.length - 16));
          try { snapshot = Buffer.concat([pending, decipher.final()]); } finally { pending.fill(0); }
        } catch { bundleError("AUTHENTICATION_FAILED"); }
      }
      if (summary.snapshotBytes !== undefined && summary.snapshotBytes !== snapshot.length) bundleError("SOURCE_MISMATCH");
      if (bundleHash(snapshot) !== source.collectionHash) bundleError("HASH_MISMATCH");
      if (encrypted) {
        const envelope = bundleJson(snapshot);
        if (envelope.v !== 1 || envelope.alg !== "A256GCM") bundleError("UNSUPPORTED_FORMAT");
        if (Object.keys(envelope).some(k => !["v", "alg", "iv", "ciphertext", "tag"].includes(k))) bundleError("INVALID_FORMAT");
        const iv = bundleBase64(envelope.iv, 12), tag = bundleBase64(envelope.tag, 16), ciphertext = bundleBase64(envelope.ciphertext);
        try {
          const decipher = createDecipheriv("aes-256-gcm", lease!.contentKey, iv);
          decipher.setAuthTag(tag);
          const pending = decipher.update(ciphertext);
          try { plain = Buffer.concat([pending, decipher.final()]); } finally { pending.fill(0); }
        } catch { bundleError("AUTHENTICATION_FAILED"); }
      } else plain = snapshot;
      if (plain.length > bundleLimits.snapshotBytes) {
        console.warn("PKM subscription bundle: snapshot exceeds 32 MiB; continuing with area-specific limits.");
      }
      const counts = bundleObject(summary.counts);
      if (!Number.isSafeInteger(summary.itemCount) || (summary.itemCount as number) < 0
        || Object.values(counts).some(v => !Number.isSafeInteger(v) || (v as number) < 0)) bundleError("MEMBERSHIP_MISMATCH");
      const files = extractBundle(plain, counts as Record<string, number>, summary.itemCount as number);
      await this.fence(source, mode, signal, pin);
      const bundle = Object.freeze({
        source, mode, encrypted, snapshot: plain.toString("utf8"), plaintextSha256: bundleHash(plain), files,
      });
      return { bundle, pin };
    } finally {
      wire.fill(0); snapshot.fill(0); plain?.fill(0);
      if (lease) {
        if (Buffer.isBuffer(lease.transferKey)) lease.transferKey.fill(0);
        if (Buffer.isBuffer(lease.contentKey)) lease.contentKey.fill(0);
        try { await lease.release(); } catch { bundleError("AUTHENTICATION_FAILED"); }
      }
    }
  }
  /** No arbitrary verified-token constructor: every conversion reauthenticates exact native pins. */
  async inspect(request: SubscriptionBundleRequest, signal: AbortSignal = new AbortController().signal): Promise<VerifiedSubscriptionBundle> {
    const { bundle, pin } = await this.verify(request, signal);
    await this.fence(bundle.source, bundle.mode, signal, pin);
    return bundle;
  }
  async consume<T>(request: SubscriptionBundleRequest, stagingRoot: string, adapter: SubscriptionBundleNativeAdapter<T>,
    signal: AbortSignal = new AbortController().signal): Promise<T> {
    const { bundle, pin } = await this.verify(request, signal);
    await this.fence(bundle.source, bundle.mode, signal, pin);
    return withBundleStage(stagingRoot, bundle.files, signal, async stage => {
      await this.fence(bundle.source, bundle.mode, signal, pin);
      try { return await adapter.consume(bundle, stage, signal, pin); }
      catch { this.check(signal); bundleError("NATIVE_ADAPTER_FAILED"); }
    });
  }
  /** Existing apply adapter is provably compatible only with original OPEN Markdown snapshots. */
  async applyOpenMarkdown(request: SubscriptionBundleRequest, apply: SubscriptionApplyHost,
    selection: { area: SubscriptionMaterializeInput["area"]; paths: string[]; operationId: string; expectedWorkspaceRevision: string },
    signal: AbortSignal = new AbortController().signal) {
    const { bundle, pin } = await this.verify(request, signal);
    if (bundle.mode !== "fork" || bundle.encrypted || bundle.files.some(file => file.area === "packages")) bundleError("NATIVE_ADAPTER_REQUIRED");
    const input: SubscriptionMaterializeInput = { source: { ...bundle.source }, snapshot: bundle.snapshot, area: selection.area, paths: [...selection.paths] };
    await this.fence(bundle.source, bundle.mode, signal, pin);
    return apply.apply(input, selection.operationId, selection.expectedWorkspaceRevision, () => {
      this.check(signal);
    });
  }
}
