import { z } from "zod";
import { subscriptionMaterializeSource } from "./subscription-materialize-contracts.js";
import { subscriptionBundleApplyPlanSchema } from "./subscription-bundle-apply-contracts.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const nativeBundleRequestSchema = z.strictObject({
  operationId: z.string().uuid(), source: subscriptionMaterializeSource,
  expiresAt: z.string().datetime(),
});
export const nativeBundleReceiptSchema = z.strictObject({
  kind: z.literal("subscription-bundle-apply/v1"),
  operationId: z.string().uuid(), planSha256: digest, source: subscriptionMaterializeSource,
  ciphertextSha256: digest, plaintextSha256: digest,
  identities: subscriptionBundleApplyPlanSchema.shape.identities,
  files: z.array(z.strictObject({ path: z.string(), sha256: digest })),
});
export const remoteBundleReceiptSchema = z.strictObject({
  kind: z.literal("remote-subscription-bundle/v1"), operationId: z.string().uuid(),
  wireSha256: digest, wireBytes: z.number().int().positive(),
  apply: nativeBundleReceiptSchema,
});
export const remoteSubscriptionBundleDefinitions = [
  { id: "remote.runtime.subscription.bundle.run", readOnly: false,
    description: "Apply an original encrypted bundle using explicitly injected native source, key and plaintext authority.",
    input: nativeBundleRequestSchema, output: remoteBundleReceiptSchema },
  { id: "remote.runtime.subscription.bundle.recover", readOnly: false,
    description: "Recover an actor-owned native bundle intent after current source ACL and key epoch revalidation.",
    input: z.strictObject({ operationId: z.string().uuid() }), output: remoteBundleReceiptSchema },
] as const;
