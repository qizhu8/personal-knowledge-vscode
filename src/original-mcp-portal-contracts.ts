import { z } from "zod";
import { createHash } from "node:crypto";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const originalPortalRequestDigest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

export const originalPortalOperations = ["open", "connections", "status", "send", "command", "route", "get",
  "attempts", "cancel", "disconnect", "switch", "permissions", "files"] as const;
const uuid = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/);
export const originalPortalCommand = z.strictObject({
  program: z.string().min(1).max(1024).refine(value => !!value.trim() && !value.includes("\0")),
  arguments: z.array(z.string().refine(value => !value.includes("\0"))).max(32),
  cwd: z.string().min(1).max(4096).refine(value => !value.includes("\0")).optional(),
  timeoutSeconds: z.number().int().min(1).max(86400).default(60),
}).refine(value => JSON.stringify(value.arguments).length <= 8000);
export const originalPortalRequirements = z.strictObject({
  platform: z.enum(["win32", "linux", "darwin"]).optional(),
  programs: z.array(z.string().regex(/^[a-z0-9._-]{1,48}$/)).max(8).optional(),
}).refine(value => !!value.platform || !!value.programs?.length);
export const originalPortalInput = z.strictObject({
  host_id: uuid, operation: z.enum(originalPortalOperations),
  command_id: z.string().min(1).max(128).refine(value => !!value.trim()),
  context_id: z.union([uuid, z.literal("")]).default(""),
  prompt: z.string().max(16000).default(""),
  request_id: z.union([uuid, z.literal("")]).default(""),
  file_paths: z.array(z.string().min(1).max(4096)).min(1).max(64).nullable().default(null),
  command: originalPortalCommand.nullable().default(null),
  requirements: originalPortalRequirements.nullable().default(null),
}).superRefine((value, context) => {
  const invalid = (message: string) => context.addIssue({ code: "custom", message });
  if (!value.context_id && !["open", "route", "connections"].includes(value.operation)) invalid("A current contextId is required.");
  if (["send", "command", "route", "get", "attempts", "cancel"].includes(value.operation) && !value.request_id)
    invalid("Use the original stable request UUID.");
  if (value.operation === "send" && !value.prompt.trim()) invalid("An explicit instruction is required.");
  if (["command", "route"].includes(value.operation) !== !!value.command) invalid("command is required only for command/route.");
  if ((value.operation === "route") !== !!value.requirements) invalid("requirements are required only for route.");
  if (value.file_paths && value.operation !== "files") invalid("file_paths are valid only for files.");
});
export type OriginalPortalInput = z.infer<typeof originalPortalInput>;
const permission = z.enum(["chat-read", "progress-read", "files-read", "files-write", "code-execute",
  "pkm-read", "pkm-write", "git-read", "git-write", "environment-manage"]);
export const originalPortalPermissionGrant = z.strictObject({
  mode: z.enum(["once", "scoped", "all"]),
  permissions: z.array(permission).min(1).max(10).optional(),
  durationMs: z.number().int().safe().positive().max(86400000).nullable(),
  scopes: z.partialRecord(permission, z.array(z.string().min(1).max(4096)).min(1).max(64)).optional(),
});
export const originalPortalNativeMethod = "portal.local.approve" as const;
export const originalPortalTaskReference = z.strictObject({
  requestId: uuid, contextId: uuid, pairId: uuid, chatId: uuid,
  taskId: z.string().regex(/^agent_session_[a-f0-9]{32}$/),
  replyId: uuid, originalReplyId: uuid, inputId: uuid, nativeRequestId: digest,
  revision: z.number().int().positive(), goalSha256: digest, sourcePlanSha256: digest, epoch: uuid,
  status: z.enum(["complete", "failed", "cancelled", "interrupted"]),
});
export const originalPortalManualIntent = originalPortalTaskReference.extend({
  commandId: uuid, expiresAtMs: z.number().int().safe().positive(),
});
export const originalPortalNativeBinding = z.strictObject({
  schema: z.literal("pkm.original-mcp-native-host-admission/v1"), root: z.string().min(1).max(4096),
  workspaceId: uuid, planSha256: digest, profileSha256: digest, sourceCatalogSha256: digest,
  authorityId: z.string().min(1).max(128), epoch: uuid, actorId: z.literal("mcp:external"),
  domains: z.array(z.enum(["model-provider", "tool-approval", "mcp-public", "api-chat-native"])).min(1).max(4),
  configurationSha256: digest,
});
export const originalPortalNativePayload = z.strictObject({
  binding: originalPortalNativeBinding,
  request: z.strictObject({
    phase: z.enum(["open", "pair-code", "external", "pair", "switch", "command", "task", "attempts", "files", "permissions",
      "endpoints", "endpoint", "save-pair", "endpoint-check", "task-transition", "task-reference",
      "manual-intents", "manual-attempt", "manual-result"]),
    contextId: z.union([uuid, z.literal("")]), pairId: z.union([uuid, z.literal("")]),
    revision: z.number().int().safe().nonnegative(), detail: z.record(z.string(), z.json()),
  }),
  requestSha256: digest,
});
export const originalPortalNativeDecision = z.strictObject({
  decision: z.enum(["approve", "deny"]), requestSha256: digest, epoch: uuid,
  expiresAtMs: z.number().int().safe().positive(),
  role: z.enum(["controller", "controlled"]).optional(),
  privateLink: z.string().min(1).max(8192).optional(),
  paths: z.array(z.string().min(1).max(4096)).min(1).max(64).optional(),
  chatId: uuid.optional(),
  grant: originalPortalPermissionGrant.optional(),
  endpoint: z.record(z.string(), z.json()).optional(),
  endpoints: z.array(z.record(z.string(), z.json())).max(32).optional(),
  credential: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/).optional(),
  manualIntents: z.array(originalPortalManualIntent).max(8).optional(),
}).nullable();
export function parseOriginalPortalNativePayload(value: unknown, session: {
  activationId: string; brokerId: string; binding: { root: string; workspaceId: string; planSha256: string;
    profileSha256: string; catalogSha256: string };
}) {
  const parsed = originalPortalNativePayload.parse(value), binding = parsed.binding, current = session.binding;
  if (binding.root !== current.root || binding.workspaceId !== current.workspaceId
    || binding.planSha256 !== current.planSha256 || binding.profileSha256 !== current.profileSha256
    || binding.sourceCatalogSha256 !== current.catalogSha256 || binding.epoch !== session.activationId
    || binding.authorityId !== `native-rpc:${session.brokerId}`
    || originalPortalRequestDigest(parsed.request) !== parsed.requestSha256)
    throw Object.assign(new Error("NATIVE_REQUEST_BINDING_MISMATCH"), { code: "NATIVE_REQUEST_BINDING_MISMATCH" });
  return parsed;
}
