import type { ModelConfigResolution, ModelProviderId } from "./model-config-contracts.js";

export interface ModelProviderToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface ModelProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ModelProviderToolCall[];
}
export interface ModelProviderTool {
  name: string;
  description: string;
  /** Bounded JSON Schema subset; unsupported validation keywords fail closed. */
  parameters: Record<string, unknown>;
}
export interface ModelProviderRequest {
  messages: ModelProviderMessage[];
  signal: AbortSignal;
  provider?: ModelProviderId;
  profileId?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  tools?: ModelProviderTool[];
}
export interface ModelProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  copilotNanoAiu?: number;
}
export type ModelProviderEvent =
  | { type: "text"; text: string }
  | { type: "reasoning-summary"; text: string }
  | ({ type: "usage" } & ModelProviderUsage)
  | { type: "tool"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "finish"; reason: "stop" | "tool_calls" | "length" };

export type ModelProviderErrorCode = "invalid-request" | "provider-unavailable" | "configuration-unavailable"
  | "context-budget" | "output-budget" | "invalid-stream" | "invalid-tool" | "cancelled" | "timeout"
  | "authentication" | "rate-limited" | "provider-error" | "transport-error";
export class ModelProviderError extends Error {
  constructor(
    readonly code: ModelProviderErrorCode,
    readonly dispatch: "not-sent" | "uncertain" = "not-sent",
    readonly retryable = false,
  ) {
    super(`Model provider: ${code}.`);
    this.name = "ModelProviderError";
  }
}
export interface ModelProviderPayload {
  model: string;
  messages: ModelProviderMessage[];
  stream: true;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream_options?: { include_usage: true };
  tools?: Array<{ type: "function"; function: ModelProviderTool }>;
}
export interface ModelProviderTransport {
  supports(provider: ModelProviderId): boolean;
  open(request: { provider: ModelProviderId; payload: ModelProviderPayload; signal: AbortSignal }): Promise<ReadableStream<Uint8Array>>;
}
export interface ModelProviderDependencies {
  modelConfig: { resolve(input: unknown): Promise<ModelConfigResolution> };
  transport?: ModelProviderTransport;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
}
