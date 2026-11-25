import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const originalMcpNativeSignedHostBinding = z.strictObject({
  schema: z.literal("pkm.original-mcp-native-host-admission/v1"), root: z.string().min(1).max(4096),
  workspaceId: z.string().uuid(), planSha256: digest, profileSha256: digest, sourceCatalogSha256: digest,
  authorityId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/), epoch: z.string().uuid(), actorId: z.literal("mcp:external"),
  domains: z.array(z.enum(["model-provider", "tool-approval", "mcp-public", "api-chat-native"])).min(1).max(4),
  configurationSha256: digest,
});
