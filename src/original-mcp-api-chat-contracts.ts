import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import type { ModelProviderMessage } from "./model-provider-contracts.js";
import { memoryText } from "./memory-contracts.js";
import type { OriginalManagedTaskAdoptionPort } from "./managed-chat-task-adoption-contracts.js";
import { originalSdkChatSelection } from "./original-mcp-sdk-model-contracts.js";
export type { OriginalSdkChatPort, OriginalSdkChatPlan, OriginalSdkExecutionCallbacks } from "./original-mcp-sdk-model-contracts.js";

export const originalNativeChatDigest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const text = z.string().min(1).max(512), digest = z.string().regex(/^[a-f0-9]{64}$/);
export const originalNativeChatModel = z.strictObject({
  id: text, nativeModelId: text, label: text, vendor: z.string().max(512), family: z.string().max(512),
  version: z.string().max(512), maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().nullable(),
  imageInput: z.boolean().nullable().optional(),
  toolCalling: z.union([z.boolean(), z.number().int().nonnegative()]).nullable().optional(),
});
export interface OriginalNativeChatMessage extends ModelProviderMessage {
  images?: readonly { label: string; mimeType: "image/png" | "image/jpeg"; dataBase64: string }[];
}
export const originalNativeChatCatalogue = z.strictObject({
  source: z.literal("vscode.lm"), epoch: text,
  registryRevision: text.optional(),
  models: z.array(originalNativeChatModel).max(4096),
});
const boundedSelection = z.strictObject({
  protocol: z.literal("pkm.native-bounded-chat/v1"),
  epoch: text, modelId: text, wireModelId: text, profileId: text, provider: z.enum(["vscode", "openai-compatible", "azure-openai"]),
  permissionMode: z.enum(["protective", "ask", "read-only"]),
  budget: z.strictObject({
    maxSteps: z.number().int().min(1).max(8),
    maxInputTokens: z.number().int().min(1).max(262144),
    maxOutputTokens: z.number().int().min(1).max(8192),
    maxTotalOutputTokens: z.number().int().min(1).max(32768),
    deadlineMs: z.number().int().min(1).max(300000),
  }),
});
export const originalNativeChatSelection = z.discriminatedUnion("protocol", [
  boundedSelection,
  originalSdkChatSelection,
  z.strictObject({
    protocol: z.literal("pkm.original-api-chat-execution/v1"),
    epoch: text, modelId: text, wireModelId: text, provider: z.literal("vscode"),
    permissionMode: z.enum(["protective", "ask", "read-only"]),
    outputTokenCap: z.number().int().positive(),
    budget: z.strictObject({ maxInputTokens: z.number().int().positive(),
      maxTotalOutputTokens: z.number().int().positive(), deadlineMs: z.number().int().positive() }),
  }),
]);
/**
 * Required native transport contract, not a proof producer or HTTP adapter.
 * The authenticated native process retains LanguageModelChat/tool-context objects.
 */
export interface OriginalVscodeChatModelPort {
  catalogue(signal: AbortSignal): Promise<z.infer<typeof originalNativeChatCatalogue>>;
  select(input: { modelId: string; catalogueSha256: string }, signal: AbortSignal): Promise<{
    selectionId: string; modelId: string; epoch: string; maxInputTokens: number;
  }>;
  count(input: {
    selectionId: string; requestId: string; requestSha256: string;
    messages: readonly OriginalNativeChatMessage[];
    tools: readonly import("./model-provider-contracts.js").ModelProviderTool[];
    outputTokenCap: number;
  }, signal: AbortSignal): Promise<{
    selectionId: string; requestSha256: string; inputTokens: number;
    countingMethod: "vscode-countTokens-plus-tool-overhead";
  }>;
  stream(input: {
    selectionId: string; requestId: string; requestSha256: string;
    messages: readonly OriginalNativeChatMessage[];
    tools: readonly import("./model-provider-contracts.js").ModelProviderTool[];
    outputTokenCap: number;
  }, signal: AbortSignal): AsyncIterable<import("./model-provider-contracts.js").ModelProviderEvent>;
}
export function originalVscodeModelRequestDigest(input: {
  selectionId: string; requestId: string;
  messages: readonly OriginalNativeChatMessage[];
  tools: readonly import("./model-provider-contracts.js").ModelProviderTool[];
  outputTokenCap: number;
}) {
  return originalNativeChatDigest({ protocol: "pkm.original-vscode-model-request/v1", ...input });
}
export interface OriginalNativeChatExecutionPlan {
  schema: "pkm.original-api-chat-execution/v1";
  requestId: string; chatUrl: string; selectionId: string; sourcePlanSha256: string;
  messages: readonly OriginalNativeChatMessage[];
  tools: readonly import("./model-provider-contracts.js").ModelProviderTool[];
  hardToolRoundLimit: number | null;
  outputTokenCap: number;
  budget: { maxInputTokens: number; maxTotalOutputTokens: number; deadlineMs: number };
}
/** A future fixed native RPC binding must implement this with the existing streamVscodeChat engine, not old ChatStore authority. */
export interface OriginalNativeChatExecutionPort {
  run(plan: Readonly<OriginalNativeChatExecutionPlan>, ports: {
    beforeInference(request: {
      inferenceId: string; round: number; requestSha256: string;
      planSha256: string; sourcePlanSha256: string; selectionId: string;
      nativeRequest: Readonly<{ messages: readonly unknown[]; options: Readonly<Record<string, unknown>> }>;
      inputTokens: number; countingMethod: "vscode-countTokens-plus-overhead";
    }): Promise<void>;
    tool(request: { inferenceId: string; round: number; callId: string; name: string;
      arguments: Readonly<Record<string, unknown>>; argumentsSha256: string }): Promise<{
      receiptSha256: string; content: string; effect: "not-committed" | "committed" | "unknown";
    }>;
    text(request: { inferenceId: string; text: string }): Promise<void>;
    usage(request: { inferenceId: string; usage: import("./model-provider-contracts.js").ModelProviderUsage;
      source: "native-counted" | "provider-reported" }): Promise<void>;
  }, signal: AbortSignal): Promise<{
    status: "complete" | "cancelled" | "failed" | "unknown";
    toolRoundLimit: { limit: number; rounds: number; reached: boolean } | null;
  }>;
}
export function originalNativeChatInferenceDigest(
  input: Omit<Parameters<Parameters<OriginalNativeChatExecutionPort["run"]>[1]["beforeInference"]>[0], "requestSha256">,
) {
  return originalNativeChatDigest({ protocol: "pkm.original-api-chat-inference/v1", ...input });
}
export const originalNativeChatRequest = z.strictObject({
  operation: z.enum(["create", "send", "cancel"]), requestId: digest, commandId: text,
  chatUrl: text.nullable(), sourcePlanSha256: digest, sourceUncertain: z.boolean(),
  argumentsSha256: digest, selection: originalNativeChatSelection.nullable(),
});
const chatUrl = z.string().regex(/^pkm:\/\/chats\/[a-f0-9]{16}\/[a-f0-9-]{36}$/)
  .refine(value => z.string().uuid().safeParse(value.split("/").at(-1)).success);
export const originalNativeChatResolve = z.strictObject({
  requestId: digest, requestedModelId: z.string().max(512), chatUrl: chatUrl.nullable(),
  sourcePlanSha256: digest, expectedSelection: originalNativeChatSelection.nullable(),
});
export const originalNativeChatPresentation = z.strictObject({
  requestId: digest, chatUrl, sourcePlanSha256: digest, selection: originalNativeChatSelection,
});
export const originalNativeChatMemoryRequest = z.strictObject({
  requestId: digest, chatUrl, sourcePlanSha256: digest, argumentsSha256: digest,
  selection: originalNativeChatSelection.refine(value => value.protocol === "pkm.original-api-chat-execution/v1"),
  draftSha256: digest.nullable(), scope: memoryText(1024).nullable(), proposedQuery: memoryText(512).nullable(),
});
const memoryChoiceBinding = { requestId: digest, epoch: text, bindingSha256: digest };
export const originalNativeChatMemoryChoice = z.discriminatedUnion("mode", [
  z.strictObject({ ...memoryChoiceBinding, mode: z.literal("off") }),
  z.strictObject({ ...memoryChoiceBinding, mode: z.literal("live"), scope: memoryText(1024),
    query: memoryText(512), limit: z.number().int().min(1).max(3) }),
  z.strictObject({ ...memoryChoiceBinding, mode: z.literal("refused"),
    reason: z.enum(["source-not-admitted", "denied", "invalid-query"]) }),
]);
export interface OriginalNativeChatMemoryPort {
  select(input: z.infer<typeof originalNativeChatMemoryRequest>, signal: AbortSignal):
    Promise<z.infer<typeof originalNativeChatMemoryChoice>>;
}
/** High-level operations travel on the same authenticated attachment as model execution. */
export interface OriginalNativeChatSessionPort {
  readonly memory?: OriginalNativeChatMemoryPort;
  readonly adopt?: OriginalManagedTaskAdoptionPort["adopt"];
  resolve(input: z.infer<typeof originalNativeChatResolve>, signal: AbortSignal):
    Promise<z.infer<typeof originalNativeChatSelection>>;
  authorize(input: z.infer<typeof originalNativeChatRequest>, signal: AbortSignal): Promise<boolean>;
  present(input: z.infer<typeof originalNativeChatPresentation>, signal: AbortSignal): Promise<void>;
}
export interface OriginalNativeChatPorts<Binding> {
  catalogue(binding: Binding, signal: AbortSignal): Promise<z.infer<typeof originalNativeChatCatalogue>>;
  resolve(binding: Binding & { requestedModelId: string; chatUrl: string | null }, signal: AbortSignal):
    Promise<z.infer<typeof originalNativeChatSelection>>;
  authorize(binding: Binding & { request: Readonly<z.infer<typeof originalNativeChatRequest>> }, signal: AbortSignal): Promise<boolean>;
  present(binding: Binding & { chatUrl: string }, signal: AbortSignal): Promise<void>;
}
