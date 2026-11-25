import { z } from "zod";
import { buildHostConfigOptions } from "./host-config.js";

const profileSchema = z.strictObject({
  schema: z.literal("pkm.shared-core-host/v1"),
  config: z.record(z.string(), z.json()),
  policy: z.strictObject({
    allowedProviders: z.array(z.enum(["openai-compatible", "azure-openai"])).min(1).max(2),
    allowedEndpoints: z.array(z.string().max(2048)).min(1).max(16),
    allowedModels: z.array(z.string().max(200)).min(1).max(64),
    allowedTools: z.array(z.string().max(200)).max(64),
    allowInsecureLoopback: z.boolean().optional(),
  }),
  secretEnvironment: z.record(z.string().regex(/^secret:[A-Za-z0-9][A-Za-z0-9._/-]*$/),
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  humanReview: z.literal("browser"),
});
export type SharedCoreProfile = z.infer<typeof profileSchema>;
export function parseSharedCoreProfile(value: unknown): SharedCoreProfile {
  const profile = profileSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(profile)) > 32_768) throw new Error("Core profile exceeds its immutable byte budget.");
  buildHostConfigOptions(JSON.stringify(profile.config), {
    policy: profile.policy, resolveSecret: async () => undefined, fetchFactory: () => globalThis.fetch,
    reviewer: async () => null, authorizeTool: async () => false,
  });
  if (typeof profile.config.secretRef !== "string"
    || !Object.hasOwn(profile.secretEnvironment, profile.config.secretRef))
    throw new Error("Core model secret requires an explicit environment reference; never place credentials in the profile.");
  return profile;
}
