import type { ApprovalBridgeReviewer } from "./approval-bridge-contracts.js";
import { definitions } from "./contracts.js";
import { parseHostConfig } from "./domain/host-config.js";
import { modelApiKeySecretId, ModelConfigService, type NativeSecretResolver } from "./model-config.js";
import { createModelProviderHttpTransport, ModelProviderError, type ModelProviderTransport } from "./model-provider.js";
import type { NativeRuntimeOptions } from "./native-runtime.js";
import { ToolGateway } from "./tool-gateway.js";
import type { ToolApprovalBinding, ToolGatewayBinding } from "./tool-gateway-contracts.js";

export { hostConfigByteLimit } from "./domain/host-config.js";

/** This policy is native host authority, not part of the untrusted JSON document. */
export interface HostConfigPolicy {
  allowedProviders: readonly ("openai-compatible" | "azure-openai")[];
  allowedEndpoints: readonly string[];
  allowedModels: readonly string[];
  allowedTools: readonly string[];
  /** Only explicitly enabled synthetic loopback endpoints may use cleartext HTTP. */
  allowInsecureLoopback?: boolean;
}

export interface HostConfigDependencies {
  policy: HostConfigPolicy;
  resolveSecret(reference: string): Promise<string | undefined>;
  fetchFactory(): typeof fetch;
  reviewer: ApprovalBridgeReviewer;
  authorizeTool(binding: ToolApprovalBinding, signal: AbortSignal): Promise<boolean>;
}

export type ConfiguredNativeOptions = Pick<NativeRuntimeOptions,
  "modelConfig" | "providerTransport" | "toolCatalog" | "reviewer" | "authorizeTool">;

/**
 * Validate explicit JSON and construct native service options without accessing files,
 * environment, credentials, or the network. The host retains all authority.
 */
export function buildHostConfigOptions(json: string, dependencies: HostConfigDependencies): ConfiguredNativeOptions {
  const config = parseHostConfig(json);
  const fail = (): never => { throw new Error("Invalid native host configuration or host dependencies."); };
  const policy = dependencies?.policy;
  if (!policy || !Array.isArray(policy.allowedProviders) || !Array.isArray(policy.allowedEndpoints)
    || !Array.isArray(policy.allowedModels) || !Array.isArray(policy.allowedTools)
    || typeof dependencies.resolveSecret !== "function" || typeof dependencies.fetchFactory !== "function"
    || typeof dependencies.reviewer !== "function" || typeof dependencies.authorizeTool !== "function") return fail();
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || !/^\/[A-Za-z0-9._~/-]*$/.test(endpoint.pathname)
      || /(?:sk|rk)-[A-Za-z0-9_-]{16,}/i.test(endpoint.pathname)
      || endpoint.href !== config.endpoint
      || endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && local && policy.allowInsecureLoopback === true)
      || !policy.allowedEndpoints.includes(endpoint.href)
      || !policy.allowedProviders.includes(config.provider)
      || !policy.allowedModels.includes(config.model)) return fail();
  } catch { return fail(); }

  const catalog: ToolGatewayBinding[] = config.tools.map(operation => {
    const definition = definitions.find(item => item.id === operation);
    if (!policy.allowedTools.includes(operation) || !definition
      || operation.startsWith("manager.")
      || /(?:^|\.)(?:prompt|process|shell|command|execute)(?:\.|$)/i.test(operation)
      || "nativeOnly" in definition && definition.nativeOnly) return fail();
    return Object.freeze({ name: operation.replaceAll(".", "_"), operation, approvalRequired: !definition.readOnly });
  });
  try {
    // Validate against the same registry and denylist used at invocation time.
    new ToolGateway({
      actor: { id: "host-config-validation", canWrite: true },
      context: { workspaceId: "host-config-validation", turnId: "host-config-validation", contextDigest: "0".repeat(64) },
      dispatcher: { async dispatch() { throw new Error("Unavailable."); } }, catalog,
    });
  } catch { return fail(); }
  Object.freeze(catalog);

  const handles = new WeakMap<object, string>();
  const secretResolver: NativeSecretResolver = {
    async resolveSecret(id) {
      if (id !== modelApiKeySecretId) return undefined;
      try {
        const secret = await dependencies.resolveSecret(config.secretRef);
        if (typeof secret !== "string" || !secret || secret.length > 8000 || /[\r\n]/.test(secret)) return undefined;
        const handle = Object.freeze({});
        handles.set(handle, secret);
        return handle;
      } catch { return undefined; }
    },
  };
  const modelConfig = new ModelConfigService({
    configuration: {
      apiChatProvider: config.provider, aiEndpoint: endpoint.href, aiModel: config.model,
      apiChatModelProfiles: [{ id: config.model, model: config.model, status: "active",
        contextWindow: config.contextWindow, maxOutputTokens: config.maxOutputTokens,
        outputTokenParameter: config.outputTokenParameter, includeUsage: config.includeUsage }],
    },
    secretResolver, registryAvailability: { [config.provider]: true },
  });
  const transport = createModelProviderHttpTransport({
    endpoint: endpoint.href, allowedEndpoints: [endpoint.href], secretResolver,
    ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
    async authorization(handle, provider): Promise<Readonly<Record<string, string>>> {
      const secret = handles.get(handle);
      if (!secret) throw new Error("Credential unavailable.");
      return provider === "azure-openai" ? { "api-key": secret } : { authorization: `Bearer ${secret}` };
    },
    async fetch(input, init) {
      const send = dependencies.fetchFactory();
      if (typeof send !== "function") throw new Error("Fetch unavailable.");
      const response = await send(input, init);
      if (response.redirected || response.status >= 300 && response.status < 400
        || response.url && response.url !== String(input)) {
        void response.body?.cancel().catch(() => {});
        throw new Error("Redirect rejected.");
      }
      return response;
    },
  });
  const providerTransport: ModelProviderTransport = {
    supports: provider => provider === config.provider,
    async open(request) {
      if (request.provider !== config.provider || request.payload.model !== config.model)
        throw new ModelProviderError("configuration-unavailable");
      return transport.open(request);
    },
  };
  return { modelConfig, providerTransport, toolCatalog: catalog,
    reviewer: dependencies.reviewer, authorizeTool: dependencies.authorizeTool };
}
