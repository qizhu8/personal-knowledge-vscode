import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { z } from "zod";
import { originalMcpExtensionId } from "./original-mcp-profile-binding.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const identityBody = z.strictObject({
  schema: z.literal("pkm.original-mcp-native-identity/v1"),
  extensionId: z.literal(originalMcpExtensionId),
  profileSha256: digest,
  publicKey: z.string().max(128),
  keyId: digest,
});
const identitySchema = identityBody.extend({ sha256: digest });
export type OriginalMcpNativeIdentity = Readonly<z.infer<typeof identitySchema>>;
const challengeSchema = z.strictObject({
  schema: z.literal("pkm.original-mcp-native-challenge/v1"),
  purpose: z.literal("attach-native-producer"),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  brokerId: z.string().uuid(),
  root: z.string().max(4096).regex(/^\/[^\u0000-\u001f]*$/),
  workspaceId: z.string().uuid(),
  planSha256: digest,
  catalogSha256: digest,
  profileSha256: digest,
  payloadBuildId: digest,
  hostEntrySha256: digest,
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});
export type OriginalMcpNativeChallenge = Readonly<z.infer<typeof challengeSchema>>;
export type OriginalMcpNativeBinding = Omit<OriginalMcpNativeChallenge,
  "schema" | "purpose" | "nonce" | "brokerId" | "issuedAt" | "expiresAt">;
const attestationBody = z.strictObject({
  schema: z.literal("pkm.original-mcp-native-attestation/v1"),
  identitySha256: digest,
  activationId: z.string().uuid(),
  challengeSha256: digest,
});
const attestationSchema = attestationBody.extend({ signature: z.string().max(128) });
export type OriginalMcpNativeAttestation = Readonly<z.infer<typeof attestationSchema>>;

function bytes(value: string, length: number): Buffer {
  const result = Buffer.from(value, "base64");
  if (result.length !== length || result.toString("base64") !== value)
    throw new Error("NATIVE_IDENTITY_INVALID: Noncanonical key or signature encoding.");
  return result;
}

export function originalMcpNativeIdentity(publicKey: string, profileSha256: string): OriginalMcpNativeIdentity {
  const der = bytes(publicKey, 44);
  if (createPublicKey({ key: der, format: "der", type: "spki" }).asymmetricKeyType !== "ed25519")
    throw new Error("NATIVE_IDENTITY_INVALID: An Ed25519 public key is required.");
  const body = identityBody.parse({
    schema: "pkm.original-mcp-native-identity/v1", extensionId: originalMcpExtensionId,
    profileSha256, publicKey, keyId: hash(der),
  });
  return Object.freeze({ ...body, sha256: hash(JSON.stringify(body)) });
}

export function verifyOriginalMcpNativeIdentity(value: unknown, independentSha256: string,
  profileSha256: string): OriginalMcpNativeIdentity {
  digest.parse(independentSha256); digest.parse(profileSha256);
  const parsed = identitySchema.parse(value);
  const expected = originalMcpNativeIdentity(parsed.publicKey, profileSha256);
  if (JSON.stringify(parsed) !== JSON.stringify(expected) || expected.sha256 !== independentSha256)
    throw new Error("NATIVE_IDENTITY_CHANGED: The independently enrolled native profile identity does not match.");
  return expected;
}

export function originalMcpNativeChallenge(value: unknown): OriginalMcpNativeChallenge {
  const parsed = challengeSchema.parse(value), now = Date.now();
  if (parsed.root === "/" || parsed.root.split("/").some(part => part === "." || part === "..")
    || parsed.root.endsWith("/") || parsed.root.includes("//")
    || parsed.issuedAt > now || parsed.expiresAt <= now
    || parsed.expiresAt - parsed.issuedAt > 60_000 || parsed.expiresAt <= parsed.issuedAt)
    throw new Error("NATIVE_CHALLENGE_EXPIRED: A fresh bounded canonical-root attachment challenge is required.");
  return Object.freeze(parsed);
}

export function originalMcpNativeAttestationMessage(challenge: OriginalMcpNativeChallenge,
  identitySha256: string, activationId: string): { body: Omit<OriginalMcpNativeAttestation, "signature">; message: Buffer } {
  const parsed = originalMcpNativeChallenge(challenge);
  const body = attestationBody.parse({
    schema: "pkm.original-mcp-native-attestation/v1", identitySha256, activationId,
    challengeSha256: hash(JSON.stringify(parsed)),
  });
  return { body, message: Buffer.from(`pkm.native-producer-attachment/v1\n${JSON.stringify({ ...body, challenge: parsed })}`) };
}

/** Signature authentication only: this never grants model, tool, effect or old-state permissions. */
export class OriginalMcpNativeChallenges {
  readonly brokerId = randomUUID();
  #pending = new Map<string, OriginalMcpNativeChallenge>();
  #closed = false;
  #identity: OriginalMcpNativeIdentity;
  #binding: OriginalMcpNativeBinding;

  constructor(identity: OriginalMcpNativeIdentity, independentSha256: string,
    binding: OriginalMcpNativeBinding) {
    this.#identity = verifyOriginalMcpNativeIdentity(identity, independentSha256, binding.profileSha256);
    this.#binding = Object.freeze({ ...binding });
  }

  issue(): OriginalMcpNativeChallenge {
    if (this.#closed) throw new Error("NATIVE_CHALLENGE_REVOKED: Native attachment is closed.");
    const now = Date.now();
    for (const [id, challenge] of this.#pending)
      if (challenge.expiresAt <= now) this.#pending.delete(id);
    if (this.#pending.size >= 8) throw new Error("NATIVE_CHALLENGE_BUSY: Outstanding attachment challenges are bounded.");
    const challenge = originalMcpNativeChallenge({
      ...this.#binding, schema: "pkm.original-mcp-native-challenge/v1", purpose: "attach-native-producer",
      nonce: randomBytes(32).toString("base64url"), brokerId: this.brokerId, issuedAt: now, expiresAt: now + 60_000,
    });
    this.#pending.set(hash(JSON.stringify(challenge)), challenge);
    return challenge;
  }

  consume(value: unknown): Readonly<{ activationId: string; identitySha256: string }> {
    if (this.#closed) throw new Error("NATIVE_CHALLENGE_REVOKED: Native attachment is closed.");
    const response = attestationSchema.parse(value), challenge = this.#pending.get(response.challengeSha256);
    this.#pending.delete(response.challengeSha256);
    if (!challenge || response.identitySha256 !== this.#identity.sha256)
      throw new Error("NATIVE_ATTESTATION_REFUSED: Unknown, replayed or mismatched native attachment.");
    const { message } = originalMcpNativeAttestationMessage(challenge, response.identitySha256, response.activationId);
    const key = createPublicKey({ key: bytes(this.#identity.publicKey, 44), format: "der", type: "spki" });
    if (!verify(null, message, key, bytes(response.signature, 64)))
      throw new Error("NATIVE_ATTESTATION_REFUSED: Native attachment signature does not match.");
    return Object.freeze({ activationId: response.activationId, identitySha256: response.identitySha256 });
  }

  close(): void { this.#closed = true; this.#pending.clear(); }
}
