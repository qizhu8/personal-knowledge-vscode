import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import type { OriginalNativeChatMessage } from "./original-mcp-api-chat-contracts.js";
import type { ModelProviderTool, ModelProviderUsage } from "./model-provider-contracts.js";

const text = z.string().min(1).max(512), digest = z.string().regex(/^[a-f0-9]{64}$/);
export const originalSdkUnavailableReason = z.strictObject({
  code: z.enum(["NATIVE_SDK_RUNTIME_INCOMPATIBLE", "NATIVE_SDK_NO_UNINTERCEPTED_SENDING_PROOF",
    "NATIVE_SDK_LOGICAL_SEND_IDENTITY_UNVERIFIED", "NATIVE_SDK_CATALOGUE_CONTROL_EGRESS_UNSUPPORTED"]),
  message: text,
});
export const originalSdkUnavailableStatus = z.strictObject({
  provider: z.literal("copilot-sdk"), status: z.literal("unsupported"), reason: originalSdkUnavailableReason,
});
export type OriginalSdkUnavailableStatus = z.infer<typeof originalSdkUnavailableStatus>;
export const originalSdkDigest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

export const originalSdkModel = z.strictObject({
  provider: z.literal("copilot-sdk"), id: text, sdkModelId: text, label: text,
  routing: z.enum(["fixed", "service-routed"]),
  contextWindowTokens: z.number().int().positive().safe().nullable(),
  maxOutputTokens: z.number().int().positive().safe().nullable(),
  toolCalling: z.boolean().nullable(),
  imageInput: z.boolean().nullable().optional(),
}).refine(value => value.id === `vscode:copilot-sdk:${encodeURIComponent(value.sdkModelId)}`);
export const originalSdkCatalogue = z.strictObject({
  source: z.literal("copilot-sdk"), epoch: text, registryRevision: text,
  models: z.array(originalSdkModel).max(4096),
}).refine(value => new Set(value.models.map(model => model.id)).size === value.models.length);

export const originalSdkSelection = z.strictObject({
  provider: z.literal("copilot-sdk"), selectionId: text, epoch: text, catalogueSha256: digest,
  model: originalSdkModel,
});
export const originalSdkExecutionBinding = z.strictObject({
  provider: z.literal("copilot-sdk"), admissionMode: z.literal("awaited-sdk-sending-boundary"),
  requestId: text, selectionId: text, modelId: text.startsWith("vscode:copilot-sdk:"), sdkSessionId: text,
  epoch: text, hostReceiptSha256: digest, sourcePlanSha256: digest, planSha256: digest,
  deadlineAtMs: z.number().int().positive().safe(),
  budget: z.strictObject({
    maxSendingBoundaries: z.number().int().min(1).max(4096),
    maxRequestBytes: z.number().int().min(1).max(16 * 1024 * 1024),
  }),
});
export type OriginalSdkExecutionBinding = z.infer<typeof originalSdkExecutionBinding>;

export const originalSdkByteMeasurement = z.strictObject({
  provider: z.literal("copilot-sdk"), countingMethod: z.literal("sdk-serialized-utf8-bytes"),
  serializedBytes: z.number().int().nonnegative().safe(), payloadSha256: digest,
  providerTokenCount: z.null(),
});
export function measureOriginalSdkSerializedPayload(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  if (typeof value === "string" && Buffer.from(bytes).toString("utf8") !== value)
    throw new Error("NATIVE_SDK_INVALID_UTF8");
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("NATIVE_SDK_INVALID_UTF8"); }
  return originalSdkByteMeasurement.parse({
    provider: "copilot-sdk", countingMethod: "sdk-serialized-utf8-bytes",
    serializedBytes: bytes.byteLength, payloadSha256: createHash("sha256").update(bytes).digest("hex"),
    providerTokenCount: null,
  });
}

export const originalSdkSendingBoundary = z.strictObject({
  schema: z.literal("pkm.original-sdk-sending-boundary/v1"),
  binding: originalSdkExecutionBinding,
  boundaryId: digest, sdkRequestId: text, sdkInvocationId: text,
  kind: z.enum(["http-request", "websocket-connect", "websocket-message"]),
  measurement: originalSdkByteMeasurement,
  authority: z.literal("model-sending-boundary-only"),
});
export type OriginalSdkSendingBoundary = z.infer<typeof originalSdkSendingBoundary>;

export const originalSdkCanonicalToolCall = z.strictObject({
  callId: text, name: text, arguments: z.record(z.string(), z.json()), argumentsSha256: digest,
});
export type OriginalSdkCanonicalToolCall = z.infer<typeof originalSdkCanonicalToolCall>;

export const originalSdkChatSelection = z.strictObject({
  protocol: z.literal("pkm.original-sdk-api-chat-execution/v1"),
  provider: z.literal("copilot-sdk"), epoch: text, modelId: text, wireModelId: text,
  permissionMode: z.enum(["protective", "ask", "read-only"]), outputTokenCap: z.number().int().min(1).max(8192),
  budget: z.strictObject({
    maxRequestBytes: z.number().int().min(1).max(16 * 1024 * 1024),
    maxSendingBoundaries: z.number().int().min(1).max(4096),
    maxTotalOutputTokens: z.number().int().min(1).max(32768),
    deadlineMs: z.number().int().min(1).max(300000),
  }),
}).refine(value => value.modelId === `vscode:copilot-sdk:${encodeURIComponent(value.wireModelId)}`);
export interface OriginalSdkChatPlan {
  schema: "pkm.original-sdk-api-chat-execution/v1";
  requestId: string; chatUrl: string; selectionId: string; sourcePlanSha256: string;
  epoch: string; hostReceiptSha256: string;
  deadlineAtMs: number;
  messages: readonly OriginalNativeChatMessage[]; tools: readonly ModelProviderTool[];
  hardToolRoundLimit: number | null; outputTokenCap: number;
  budget: z.infer<typeof originalSdkChatSelection>["budget"];
}
export const originalSdkSessionRequest = z.strictObject({
  binding: originalSdkExecutionBinding, ordinal: z.number().int().min(0).max(1),
  previousSessionId: text.nullable(),
});
export const originalSdkToolRequest = originalSdkCanonicalToolCall.extend({
  sdkSessionId: text, sendingBoundaryId: digest, provenance: z.literal("sdk-session-tool-invocation"),
});
export const originalSdkTextRequest = z.strictObject({ sdkSessionId: text, text: z.string() });
export const originalSdkUsageRequest = z.strictObject({
  sdkSessionId: text, usageId: text, source: z.literal("provider-reported"),
  usage: z.strictObject({
    inputTokens: z.number().int().nonnegative().safe(), outputTokens: z.number().int().nonnegative().safe(),
    cachedInputTokens: z.number().int().nonnegative().safe().optional(),
    reasoningTokens: z.number().int().nonnegative().safe().optional(),
    copilotNanoAiu: z.number().int().nonnegative().safe().optional(),
  }),
});
export interface OriginalSdkExecutionCallbacks {
  beforeSession(request: z.infer<typeof originalSdkSessionRequest>): Promise<void>;
  beforeSendingBoundary(request: OriginalSdkSendingBoundary): Promise<void>;
  tool(request: z.infer<typeof originalSdkToolRequest>): Promise<{
    receiptSha256: string; content: string; effect: "not-committed" | "committed" | "unknown";
  }>;
  text(request: z.infer<typeof originalSdkTextRequest>): Promise<void>;
  usage(request: z.infer<typeof originalSdkUsageRequest>): Promise<void>;
}
export interface OriginalSdkChatPort {
  catalogue(signal: AbortSignal): Promise<z.infer<typeof originalSdkCatalogue>>;
  select(input: { modelId: string; catalogueSha256: string }, signal: AbortSignal): Promise<z.infer<typeof originalSdkSelection>>;
  measure(input: { selectionId: string; messages: readonly OriginalNativeChatMessage[];
    tools: readonly ModelProviderTool[] }, signal: AbortSignal): Promise<{
    provider: "copilot-sdk"; countingMethod: "sdk-prompt-utf8-bytes";
    serializedBytes: number; payloadSha256: string; providerTokenCount: null;
  }>;
  authorizeBoundary(request: OriginalSdkSendingBoundary, signal: AbortSignal): Promise<void>;
  run(plan: Readonly<OriginalSdkChatPlan>, callbacks: OriginalSdkExecutionCallbacks, signal: AbortSignal):
    Promise<{ status: "complete" | "cancelled" | "failed" | "unknown";
      toolRoundLimit: { limit: number; rounds: number; reached: boolean } | null }>;
}
export type OriginalSdkReportedUsage = ModelProviderUsage;
