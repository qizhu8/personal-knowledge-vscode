import { createDecipheriv, createHash, createHmac, scryptSync, timingSafeEqual } from "node:crypto";
import { verifyShareSummary } from "./domain/subscription-bundle-original.js";

export interface LegacyProtectedSnapshotBinding {
  readonly root: string;
  readonly profile: string;
  readonly nodeId: string;
  readonly shareId: string;
  readonly revision: number;
  readonly publicKey: string;
  readonly secretSalt: string;
  readonly authVerifier: string;
  readonly plaintextHash: string;
  readonly summary: Readonly<Record<string, unknown>>;
}

export interface LegacyProtectedSnapshotAuthority {
  /** Rechecks the original profile, owner, share, ACL and ciphertext binding. */
  authorize(binding: Readonly<LegacyProtectedSnapshotBinding>, signal: AbortSignal): Promise<boolean>;
  /** A disposable copy of the exact old SecretStorage secret; never returned or persisted. */
  secret(binding: Readonly<LegacyProtectedSnapshotBinding>, signal: AbortSignal): Promise<Buffer | undefined>;
}

const hash = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function deny(): never { throw Object.assign(new Error("Original protected snapshot validation failed."), { code: "SNAPSHOT_DENIED" }); }
function b64(value: unknown, length?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return deny();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value || length !== undefined && bytes.length !== length) return deny();
  return bytes;
}
function freezeTree(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeTree(child);
  Object.freeze(value);
}

/** In-memory original publisher Snapshot verification; no persistence or transport is implied. */
export async function inspectLegacyProtectedSnapshotFixture(
  input: LegacyProtectedSnapshotBinding, ciphertext: Uint8Array, authority: LegacyProtectedSnapshotAuthority,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ plaintextSha256: string; itemCount: number }> {
  const result = await readLegacyProtectedSnapshotFixture(input, ciphertext, authority, signal);
  result.plaintext.fill(0);
  return { plaintextSha256: result.plaintextSha256, itemCount: result.itemCount };
}

/** Caller owns and must dispose the returned plaintext buffer. */
export async function readLegacyProtectedSnapshotFixture(
  input: LegacyProtectedSnapshotBinding, ciphertext: Uint8Array, authority: LegacyProtectedSnapshotAuthority,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ plaintextSha256: string; itemCount: number; plaintext: Buffer }> {
  let summary: Record<string, unknown>;
  try {
    const text = JSON.stringify(input.summary);
    if (Buffer.byteLength(text) > 65_536) return deny();
    summary = JSON.parse(text);
    freezeTree(summary);
  } catch { return deny(); }
  const binding: LegacyProtectedSnapshotBinding = Object.freeze({ ...input, summary });
  if (signal.aborted || typeof binding.root !== "string" || typeof binding.profile !== "string"
    || !/^[a-f0-9]{64}$/.test(binding.nodeId) || !/^[A-Za-z0-9_-]{1,128}$/.test(binding.shareId)
    || !Number.isSafeInteger(binding.revision) || binding.revision < 1
    || !/^sha256:[a-f0-9]{64}$/.test(binding.plaintextHash)
    || !(ciphertext instanceof Uint8Array) || ciphertext.byteLength > 16 * 1024 * 1024) return deny();
  const wire = Buffer.from(ciphertext), salt = b64(binding.secretSalt, 16), expected = b64(binding.authVerifier, 32);
  let secret: Buffer | undefined, base: Buffer | undefined, verifier: Buffer | undefined, key: Buffer | undefined;
  let plaintext: Buffer | undefined;
  const authorize = async () => {
    let allowed = false;
    try { allowed = await authority.authorize(binding, signal); } catch { /* No host diagnostics or credentials escape. */ }
    if (!allowed || signal.aborted) deny();
  };
  try {
    if (binding.summary.secretProtected !== true || binding.summary.secretSalt !== binding.secretSalt
      || binding.summary.revision !== binding.revision || binding.summary.collectionHash !== hash(wire)
      || binding.summary.snapshotBytes !== wire.length || binding.summary.shareId !== binding.shareId) deny();
    try { verifyShareSummary(binding.summary, binding.publicKey, binding.nodeId, binding.shareId); }
    catch { deny(); }
    await authorize();
    try { secret = await authority.secret(binding, signal); } catch { deny(); }
    if (!Buffer.isBuffer(secret) || !secret.length || secret.length > 4096 || signal.aborted) deny();
    base = scryptSync(secret, salt, 32);
    verifier = createHmac("sha256", base).update("pkm-share-auth:v1").digest();
    key = createHmac("sha256", base).update("pkm-share-content:v1").digest();
    if (!timingSafeEqual(verifier, expected)) deny();
    let envelope: unknown;
    try { envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(wire)); } catch { deny(); }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) deny();
    const row = envelope as Record<string, unknown>;
    if (row.v !== 1 || row.alg !== "A256GCM" || Object.keys(row).some(name => !["v", "alg", "iv", "ciphertext", "tag"].includes(name))) deny();
    const iv = b64(row.iv, 12), tag = b64(row.tag, 16), encrypted = b64(row.ciphertext);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const part = decipher.update(encrypted);
      try { plaintext = Buffer.concat([part, decipher.final()]); } finally { part.fill(0); }
    } catch { deny(); }
    if (!plaintext || hash(plaintext) !== binding.plaintextHash) deny();
    let bundle: unknown;
    try { bundle = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)); } catch { deny(); }
    if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) deny();
    const counts = binding.summary.counts;
    if (!counts || typeof counts !== "object" || Array.isArray(counts)) deny();
    const kinds = ["skills", "notes", "papers", "prompts", "scripts", "packages", "servers", "recipes"];
    const actual = Object.fromEntries(kinds.filter(kind => {
      const value = (bundle as Record<string, unknown>)[kind];
      return Array.isArray(value) && value.length > 0;
    }).map(kind => [kind, ((bundle as Record<string, unknown>)[kind] as unknown[]).length]));
    if (JSON.stringify(actual) !== JSON.stringify(counts)
      || Object.values(actual).reduce((sum, count) => sum + count, 0) !== binding.summary.itemCount) deny();
    await authorize();
    return { plaintextSha256: binding.plaintextHash, itemCount: binding.summary.itemCount as number, plaintext: Buffer.from(plaintext) };
  } finally {
    wire.fill(0); salt.fill(0); expected.fill(0); secret?.fill(0); base?.fill(0);
    verifier?.fill(0); key?.fill(0); plaintext?.fill(0);
  }
}
