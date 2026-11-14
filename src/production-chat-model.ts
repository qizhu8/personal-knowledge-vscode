import { createChatTurnModelPort } from "./chat-turn-adapters.js";
import type { ChatTurnModelPort } from "./chat-turn.js";
import { ModelConfigService } from "./model-config.js";
import { createModelProviderHttpTransport, ModelProviderService } from "./model-provider.js";
import type { ModelProviderTool } from "./model-provider-contracts.js";

/**
 * Host-only adapter for an explicitly selected PKM HTTP model. The caller owns
 * selection, SecretStorage access and revocation; no endpoint or credential is
 * selected from a model request or persisted by this adapter.
 */
export function createProductionChatModel(options: {
  provider: "openai-compatible" | "azure-openai" | "vscode";
  endpoint: string;
  model: string;
  apiVersion?: string;
  apiKey: string;
  contextWindow: number;
  maxOutputTokens: number;
  outputTokenParameter: "max_tokens" | "max_completion_tokens";
  includeUsage: boolean;
  status: "active" | "unknown" | "deprecated";
  deprecatedAt?: string;
  timeoutMs?: number;
  assertCurrent(): void;
  tools(actor: string, turnId: string): Promise<ModelProviderTool[]>;
}): ChatTurnModelPort {
  if (options) options = Object.freeze({ ...options });
  if (!options || options.provider === "vscode")
    throw new Error("The selected VS Code model requires the VS Code language-model provider; no HTTP fallback was used.");
  if (!["openai-compatible", "azure-openai"].includes(options.provider)
    || typeof options.endpoint !== "string" || typeof options.model !== "string" || !options.model.trim()
    || typeof options.apiKey !== "string" || /[\r\n]/.test(options.apiKey) || options.apiKey.length > 4096
    || !Number.isSafeInteger(options.contextWindow) || options.contextWindow < 256 || options.contextWindow > 2_000_000
    || !Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1 || options.maxOutputTokens >= options.contextWindow
    || !["max_tokens", "max_completion_tokens"].includes(options.outputTokenParameter)
    || typeof options.includeUsage !== "boolean" || !["active", "unknown", "deprecated"].includes(options.status)
    || (options.deprecatedAt !== undefined && !Number.isFinite(Date.parse(options.deprecatedAt)))
    || (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 1_800_000))
    || typeof options.assertCurrent !== "function" || typeof options.tools !== "function")
    throw new Error("The selected Chat model configuration is invalid or unsupported.");
  if (options.status === "deprecated" || (options.deprecatedAt && Date.parse(options.deprecatedAt) <= Date.now()))
    throw new Error("This model is deprecated. Select an available model.");
  let endpoint: URL;
  try { endpoint = new URL(options.endpoint); }
  catch { throw new Error("The selected Chat model endpoint is invalid."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || options.endpoint.length > 2048
    || (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && local)))
    throw new Error("The selected Chat endpoint must use HTTPS, except for a local HTTP model server.");
  if (!options.apiKey && !local) throw new Error("Set an API key before sending.");
  const assertCurrent = () => {
    const result = options.assertCurrent() as unknown;
    if (result !== undefined) {
      if (result && (typeof result === "object" || typeof result === "function")
        && typeof (result as { then?: unknown }).then === "function") void Promise.resolve(result).catch(() => {});
      throw new Error("Selected Chat model authority must be synchronous.");
    }
  };
  assertCurrent();
  const credential = options.apiKey || "local";
  const secretHandle = Object.freeze({});
  const secretResolver = { async resolveSecret() { assertCurrent(); return secretHandle; } };
  const config = new ModelConfigService({
    configuration: { apiChatProvider: options.provider, aiEndpoint: options.endpoint, aiModel: options.model,
      ...(options.apiVersion ? { aiAzureApiVersion: options.apiVersion } : {}),
      apiChatModelProfiles: [{ id: "selected-chat", status: "active", model: options.model,
        contextWindow: options.contextWindow, maxOutputTokens: options.maxOutputTokens,
        outputTokenParameter: options.outputTokenParameter, includeUsage: options.includeUsage }] },
    secretResolver, registryAvailability: { [options.provider]: true },
  });
  const transport = createModelProviderHttpTransport({
    endpoint: options.endpoint, allowedEndpoints: [endpoint.href], secretResolver,
    fetch: (input, init) => { assertCurrent(); return fetch(input, init); },
    authorization: async (handle, provider): Promise<Record<string, string>> => {
      assertCurrent();
      if (handle !== secretHandle || provider !== options.provider) throw new Error("Selected Chat credential unavailable.");
      return provider === "azure-openai" ? { "api-key": credential } : { authorization: `Bearer ${credential}` };
    },
    ...(options.apiVersion === undefined ? {} : { apiVersion: options.apiVersion }),
  });
  const provider = new ModelProviderService({ modelConfig: config, transport,
    idleTimeoutMs: options.timeoutMs ?? 1_800_000, totalTimeoutMs: 1_800_000 });
  const port = createChatTurnModelPort(provider, { profileId: "selected-chat", contextWindow: options.contextWindow,
    tools: async (actor, turnId) => {
      assertCurrent();
      const tools = await options.tools(actor, turnId);
      assertCurrent();
      return tools;
    } });
  return {
    get available() { return port.available; },
    get preDispatchAdmission() { return port.preDispatchAdmission === true; },
    async *stream(request) {
      assertCurrent();
      for await (const event of port.stream({ ...request, maxOutputTokens: Math.min(request.maxOutputTokens, options.maxOutputTokens) })) {
        assertCurrent();
        yield event;
      }
      assertCurrent();
    },
  };
}
