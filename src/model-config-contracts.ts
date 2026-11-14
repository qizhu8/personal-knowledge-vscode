import { z } from "zod";

export const modelProviderIds = ["vscode", "openai-compatible", "azure-openai"] as const;
export const modelProviderIdSchema = z.enum(modelProviderIds);
export const modelProfileLimit = 128;
export const modelConfigStringLimit = 256;
const publicModelText = z.string().min(1).max(modelConfigStringLimit)
  .refine(value => !/(?:https?:\/\/|(?:api[_-]?key|secret|token|password)\s*[:=]|(?:sk|rk)-[A-Za-z0-9_-]{16,})/i.test(value));

const publicModelProfile = z.strictObject({
  id: publicModelText,
  model: publicModelText,
  label: publicModelText,
  status: z.enum(["active", "deprecated", "unknown"]),
  metadataSource: z.enum(["configured-profile", "remembered-profile", "legacy-fallback"]),
  contextWindow: z.number().int().min(256).max(2_000_000),
  maxOutputTokens: z.number().int().min(1).max(2_000_000),
  deprecatedAt: z.string().max(64).optional(),
  inputPricePerMillion: z.number().finite().nonnegative().optional(),
  outputPricePerMillion: z.number().finite().nonnegative().optional(),
  currency: z.string().max(16)
    .refine(value => !/(?:https?:\/\/|(?:api[_-]?key|secret|token|password)\s*[:=]|(?:sk|rk)-[A-Za-z0-9_-]{16,})/i.test(value)),
  includeUsage: z.boolean(),
  outputTokenParameter: z.enum(["max_tokens", "max_completion_tokens"]),
});

const providerStatus = z.enum([
  "configured",
  "provider-unavailable",
  "endpoint-missing",
  "credentials-missing",
  "credential-status-unavailable",
  "provider-discovery-unsupported",
  "invalid-configuration",
]);

const catalogProvider = z.strictObject({
  provider: modelProviderIdSchema,
  registryAvailable: z.boolean(),
  discovery: z.enum(["configured-profiles", "unsupported"]),
  status: providerStatus,
  endpointConfigured: z.boolean(),
  credentialStatus: z.enum(["not-required", "available", "missing", "unavailable", "not-checked"]),
  profiles: z.array(publicModelProfile).max(modelProfileLimit),
});

const modelConfigCatalogOutput = z.strictObject({
  schema: z.literal("pkm.model-config.catalog/v1"),
  providers: z.array(catalogProvider).length(modelProviderIds.length),
});

const publicMessage = z.strictObject({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().max(100_000),
  tool_calls: z.array(z.strictObject({
    id: z.string().min(1).max(modelConfigStringLimit),
    type: z.literal("function"),
    function: z.strictObject({
      name: z.string().min(1).max(128),
      arguments: z.string().max(65_536),
    }),
  })).max(128).optional(),
});

export const modelConfigResolveInput = z.strictObject({
  provider: modelProviderIdSchema.optional(),
  profileId: publicModelText.optional(),
  contextWindow: z.number().int().min(256).max(2_000_000).optional(),
  outputTokens: z.number().int().min(1).max(2_000_000).optional(),
  messages: z.array(publicMessage).max(256).optional(),
}).superRefine((request, context) => {
  let bytes = 0;
  for (const [index, message] of (request.messages ?? []).entries()) {
    bytes += Buffer.byteLength(message.content, "utf8");
    if (message.tool_calls) bytes += Buffer.byteLength(JSON.stringify(message.tool_calls), "utf8");
    if (bytes > 2_000_000) {
      context.addIssue({ code: "custom", message: "Model budget input exceeds the bounded byte limit.", path: ["messages", index] });
      return;
    }
  }
});

const budgetResult = z.strictObject({
  contextWindow: z.number().int().min(256).max(2_000_000),
  outputTokens: z.number().int().min(1).max(2_000_000),
  inputBudget: z.number().int().min(0).max(2_000_000),
  estimatedInputTokens: z.number().int().nonnegative().max(2_000_000).nullable(),
  fits: z.boolean().nullable(),
});

const modelConfigResolutionOutput = z.strictObject({
  schema: z.literal("pkm.model-config.resolution/v1"),
  provider: modelProviderIdSchema,
  status: z.enum([
    "configured",
    "model-unverified",
    "model-deprecated",
    "provider-unavailable",
    "endpoint-missing",
    "credentials-missing",
    "credential-status-unavailable",
    "provider-discovery-unsupported",
    "invalid-configuration",
    "invalid-budget",
  ]),
  registryAvailable: z.boolean(),
  endpointConfigured: z.boolean(),
  credentialStatus: z.enum(["not-required", "available", "missing", "unavailable", "not-checked"]),
  profile: publicModelProfile.nullable(),
  budget: budgetResult.nullable(),
});

export const modelConfigDefinitions = [
  {
    id: "model.config.catalog",
    readOnly: true,
    description: "Read the injected model-provider configuration catalog. Status describes local configuration only; no remote model is probed or claimed available. Endpoints and credentials are never returned.",
    input: z.strictObject({}),
    output: modelConfigCatalogOutput,
  },
  {
    id: "model.config.resolve",
    readOnly: true,
    description: "Resolve a configured provider/profile and optionally validate a bounded token budget. Configuration readiness does not verify remote model existence; no request is sent. Provider configuration and native secret handles are injected by the host, never accepted in public arguments.",
    input: modelConfigResolveInput,
    output: modelConfigResolutionOutput,
  },
] as const;

export type ModelProviderId = typeof modelProviderIds[number];
export type ModelConfigResolveInput = z.infer<typeof modelConfigResolveInput>;
export type ModelConfigCatalog = z.infer<typeof modelConfigCatalogOutput>;
export type ModelConfigResolution = z.infer<typeof modelConfigResolutionOutput>;
