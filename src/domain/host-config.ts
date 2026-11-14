import { z } from "zod";

const publicId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
  .refine(value => !/(?:https?:\/\/|(?:api[_-]?key|secret|token|password)\s*[:=]|(?:sk|rk)-[A-Za-z0-9_-]{16,})/i.test(value));
const schema = z.strictObject({
  schema: z.literal("pkm.native-host-config/v1"),
  provider: z.enum(["openai-compatible", "azure-openai"]),
  endpoint: z.string().min(1).max(2048),
  secretRef: z.string().min(8).max(200).regex(/^secret:[A-Za-z0-9][A-Za-z0-9._/-]*$/)
    .refine(value => !/(?:^|[/:])(?:sk|rk)-[A-Za-z0-9_-]{16,}/i.test(value)),
  model: publicId,
  contextWindow: z.number().int().min(256).max(2_000_000),
  maxOutputTokens: z.number().int().min(1).max(2_000_000),
  outputTokenParameter: z.enum(["max_tokens", "max_completion_tokens"]),
  includeUsage: z.boolean(),
  apiVersion: z.string().regex(/^[A-Za-z0-9.-]{1,128}$/).optional(),
  tools: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/)).min(1).max(16),
});

export type HostConfig = z.infer<typeof schema>;
export const hostConfigByteLimit = 32_768;

/** JSON is the only input boundary: no getters, ambient configuration, or implicit file access. */
export function parseHostConfig(json: string): HostConfig {
  try {
    if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > hostConfigByteLimit) throw new Error();
    const config = schema.parse(JSON.parse(json));
    if (config.maxOutputTokens >= config.contextWindow || new Set(config.tools).size !== config.tools.length
      || config.provider !== "azure-openai" && config.apiVersion !== undefined) throw new Error();
    return config;
  } catch {
    throw new Error("Invalid native host configuration.");
  }
}
