import { ModelConfigService } from "./model-config.js";
import { ModelProviderService } from "./model-provider.js";
import { createChatTurnModelPort } from "./chat-turn-adapters.js";
import type { ModelProviderTool } from "./model-provider-contracts.js";

/** Fresh private HTTP configuration only; the original Chat's endpoints, credentials and catalog are never consulted. */
export function createLegacyManagedChatLocalModel(options: {
  endpoint: string; apiKey: string; model: string;
  tools(actor: string, turnId: string): Promise<ModelProviderTool[]>;
}) {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/v1"
    || !options.apiKey || options.apiKey.length > 4096 || /[\r\n]/.test(options.apiKey)
    || !options.model || options.model.length > 200) throw new Error("Fresh private loopback managed provider required.");
  const modelConfig = new ModelConfigService({
    configuration: { aiEndpoint: options.endpoint, aiModel: options.model,
      apiChatModelProfiles: [{ id: "private-managed", status: "active", model: options.model,
        contextWindow: 262144, maxOutputTokens: 4096 }] },
    secretResolver: { resolveSecret: async () => ({ privateHostCredential: true }) },
    registryAvailability: { "openai-compatible": true },
  });
  const provider = new ModelProviderService({
    modelConfig,
    transport: {
      supports: provider => provider === "openai-compatible",
      async open(request) {
        const response = await fetch(`${endpoint.href}/chat/completions`, {
          method: "POST", redirect: "error", signal: request.signal,
          headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(request.payload),
        });
        if (!response.ok || !response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) {
          await response.body?.cancel();
          throw new Error("Managed Chat provider did not return a successful native SSE stream.");
        }
        return response.body;
      },
    },
  });
  return createChatTurnModelPort(provider, { profileId: "private-managed", contextWindow: 262144, tools: options.tools });
}
