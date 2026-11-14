import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { z } from "zod";
import { lstat } from "node:fs/promises";
import type { Actor } from "./contracts.js";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const name = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);
export const subscriptionIdentityBindingSchema = z.strictObject({
  schema: z.literal("pkm.native-subscription-identity/v1"),
  sourceRoot: z.string().min(1), subscriptionRoot: z.string().min(1),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  stateSha256: z.string().regex(/^[a-f0-9]{64}$/),
  statisticsSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  destination: z.string().min(1), actorId: name, ownerEpoch: name,
  authorityId: name, secretRef: name,
  nodeId: z.string().regex(/^[a-f0-9]{64}$/),
  publicKey: z.string().min(1).max(16384),
});
export type SubscriptionIdentityBinding = z.infer<typeof subscriptionIdentityBindingSchema>;
export type SubscriptionSecretEffect = "committed" | "absent" | "unknown";

/** All callbacks are injected by the native host, never by HTTP/MCP arguments.
 * store must durably retain the key outside both imported and backup trees.
 * inspect is authoritative across process restart; unknown never means absent.
 */
export interface NativeSubscriptionSecretAuthority {
  approve(binding: Readonly<SubscriptionIdentityBinding>): Promise<boolean>;
  inspect(binding: Readonly<SubscriptionIdentityBinding>): Promise<SubscriptionSecretEffect>;
  store(binding: Readonly<SubscriptionIdentityBinding>, privateKey: string): Promise<SubscriptionSecretEffect>;
}
export interface LegacySubscriptionIdentityImport {
  destination: string;
  actorId: string;
  ownerEpoch: string;
  authorityId: string;
  secretRef: string;
  authority: NativeSubscriptionSecretAuthority;
}
export interface NativeSubscriptionIdentityRequest {
  binding: Readonly<SubscriptionIdentityBinding>;
  root: string;
  rootPin: Readonly<{ device: string; inode: string }>;
  workspaceId: string;
  actorId: string;
  ownerEpoch: string;
  purpose: "read" | "backup" | "restore";
  destination: string | null;
}
export interface NativeSubscriptionIdentityPolicy {
  actorId: string;
  ownerEpoch: string;
  authority: NativeSubscriptionSecretAuthority;
  authorize(request: Readonly<NativeSubscriptionIdentityRequest>): Promise<boolean>;
}
function fail(code: string, message: string): never {
  throw new CoreError(code, message, code === "UNKNOWN_EFFECT" ? "unknown" : "not-committed");
}
export async function approveSubscriptionIdentity(binding: SubscriptionIdentityBinding,
  authority?: NativeSubscriptionSecretAuthority): Promise<void> {
  let approved = false;
  try { approved = !!authority && await authority.approve(Object.freeze({ ...binding })); }
  catch { /* Callback diagnostics may contain key material; never propagate them. */ }
  if (!approved) fail("ACCESS_DENIED", "Native subscription identity approval is absent, revoked or stale.");
}
export async function inspectSubscriptionIdentity(binding: SubscriptionIdentityBinding,
  authority?: NativeSubscriptionSecretAuthority): Promise<SubscriptionSecretEffect> {
  await approveSubscriptionIdentity(binding, authority);
  let effect: SubscriptionSecretEffect = "unknown";
  try { effect = await authority!.inspect(Object.freeze({ ...binding })); } catch { /* Unknown, not absent. */ }
  await approveSubscriptionIdentity(binding, authority);
  return ["committed", "absent", "unknown"].includes(effect) ? effect : "unknown";
}
/** Explicit host reconciliation; no side effects and no automatic retry of a store. */
export async function reconcileSubscriptionIdentity(binding: SubscriptionIdentityBinding,
  authority: NativeSubscriptionSecretAuthority): Promise<SubscriptionSecretEffect> {
  return inspectSubscriptionIdentity(subscriptionIdentityBindingSchema.parse(binding), authority);
}
export async function storeSubscriptionIdentity(binding: SubscriptionIdentityBinding, privateKey: string,
  authority?: NativeSubscriptionSecretAuthority): Promise<void> {
  const before = await inspectSubscriptionIdentity(binding, authority);
  if (before === "unknown") fail("UNKNOWN_EFFECT", "Inspect and reconcile the native secret reference before retrying.");
  if (before === "absent") {
    let effect: SubscriptionSecretEffect = "unknown";
    try { effect = await authority!.store(Object.freeze({ ...binding }), privateKey); } catch { /* Unknown effect. */ }
    if (effect !== "committed") fail("UNKNOWN_EFFECT", "Native secret store outcome requires explicit reconciliation.");
  }
  if (await inspectSubscriptionIdentity(binding, authority) !== "committed") {
    fail("UNKNOWN_EFFECT", "Native secret reference has not been authoritatively confirmed durable.");
  }
}
export function projectOriginalSubscriptionIdentity(value: Record<string, unknown>, sourceRoot: string,
  subscriptionRoot: string, sourceSha256: string, policy: LegacySubscriptionIdentityImport,
  statisticsSha256: string | null) {
  if (value.enabled !== false || value.gatewayPid !== undefined) {
    fail("UNKNOWN_STATE", "Running subscription gateway state cannot be imported.");
  }
  if (typeof value.privateKey !== "string" || typeof value.publicKey !== "string") {
    fail("INVALID_STATE", "Original subscription public and private identity are required.");
  }
  try {
    const privateKey = createPrivateKey(value.privateKey);
    const publicKey = createPublicKey(value.publicKey);
    if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519"
      || createPublicKey(value.privateKey).export({ type: "spki", format: "pem" }).toString() !== value.publicKey
      || value.nodeId !== digest(value.publicKey)) throw new Error();
  } catch { fail("INVALID_STATE", "Original subscription identity does not match its public identity."); }
  const projection = {
    schema: value.schema, nodeId: value.nodeId, publicKey: value.publicKey,
    shares: value.shares, subscriptions: value.subscriptions,
  };
  const binding = subscriptionIdentityBindingSchema.safeParse({
    schema: "pkm.native-subscription-identity/v1", sourceRoot, subscriptionRoot, sourceSha256,
    stateSha256: digest(JSON.stringify(projection)), statisticsSha256,
    destination: policy.destination, actorId: policy.actorId, ownerEpoch: policy.ownerEpoch,
    authorityId: policy.authorityId, secretRef: policy.secretRef, nodeId: value.nodeId, publicKey: value.publicKey,
  });
  if (!binding.success) fail("INVALID_STATE", "Native subscription identity binding is invalid.");
  // Do not retain unknown original fields or pretend a signing provider exists.
  return { binding: binding.data, privateKey: value.privateKey, projection };
}
export async function authorizeSubscriptionIdentity(binding: SubscriptionIdentityBinding,
  root: string, workspaceId: string, policy: NativeSubscriptionIdentityPolicy | undefined,
  purpose: NativeSubscriptionIdentityRequest["purpose"], destination: string | null = null,
  actor?: Readonly<Actor>): Promise<void> {
  if (!policy || (actor && actor.id !== policy.actorId)) fail("ACCESS_DENIED", "Native subscription identity authority is required.");
  const stat = await lstat(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("ACCESS_DENIED", "Native subscription identity root is unsafe.");
  const request = Object.freeze({ binding: Object.freeze({ ...binding }), root, workspaceId,
    rootPin: Object.freeze({ device: String(stat.dev), inode: String(stat.ino) }),
    actorId: actor?.id ?? policy.actorId, ownerEpoch: policy.ownerEpoch, purpose, destination });
  const check = async () => {
    let allowed = false;
    try { allowed = await policy.authorize(request); } catch { /* Fail closed without exposing callback diagnostics. */ }
    if (!allowed) fail("ACCESS_DENIED", "Native subscription identity root, actor or owner epoch is not approved.");
  };
  await check();
  if (await inspectSubscriptionIdentity(binding, policy.authority) !== "committed") {
    fail("UNKNOWN_EFFECT", "Native subscription identity reference requires explicit reconciliation.");
  }
  await check();
  const after = await lstat(root, { bigint: true });
  if (after.dev !== stat.dev || after.ino !== stat.ino || after.isSymbolicLink()) {
    fail("ACCESS_DENIED", "Native subscription identity root changed during authorization.");
  }
}
