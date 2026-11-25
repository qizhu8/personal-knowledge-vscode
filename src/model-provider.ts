import { modelApiKeySecretId, type NativeSecretResolver } from "./model-config.js";
import {
  ModelProviderError, type ModelProviderDependencies, type ModelProviderEvent, type ModelProviderPayload,
  type ModelProviderRequest, type ModelProviderTransport, type ModelProviderToolCall, type ModelProviderUsage,
} from "./model-provider-contracts.js";
import {
  boundedModelCopy, decodeModelSse, modelProviderInputSchema, normalizeModelUsage,
  parseModelToolArguments, toolCallSchema, validateModelMessages,
} from "./domain/model-provider.js";
import type { ModelProviderId } from "./model-config-contracts.js";
import { estimateChatPromptTokens } from "./domain/chat-prompt-budget.js";
const providerBindings = new WeakMap<object, ModelProviderDependencies>();
export function assertModelProviderBinding(provider: unknown, modelConfig: ModelProviderDependencies["modelConfig"],
  transport: ModelProviderTransport): void {
  const actual = provider && typeof provider === "object" ? providerBindings.get(provider) : undefined;
  if (!actual || actual.modelConfig !== modelConfig || actual.transport !== transport)
    throw new ModelProviderError("configuration-unavailable");
}

export * from "./model-provider-contracts.js";

/** One inference only. Tools are proposals, never executed here. No automatic replay. */
export class ModelProviderService {
  private readonly outstanding = new Set<Promise<unknown>>();
  readonly preDispatchAdmission: boolean = true;
  readonly available: boolean;
  constructor(private readonly dependencies: ModelProviderDependencies) {
    providerBindings.set(this, dependencies);
    this.available = dependencies.transport?.supports("openai-compatible") === true
      || dependencies.transport?.supports("azure-openai") === true;
    for (const [value, maximum] of [[dependencies.idleTimeoutMs, 1_800_000], [dependencies.totalTimeoutMs, 1_800_000]]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum!)) throw new ModelProviderError("invalid-request");
    }
  }
  availability(provider: ModelProviderId): { available: boolean; reason: "injected-transport" | "provider-unavailable" } {
    const available = provider !== "vscode" && this.dependencies.transport?.supports(provider) === true;
    return { available, reason: available ? "injected-transport" : "provider-unavailable" };
  }
  activity() { return this.outstanding.size; }
  private track<T>(value: Promise<T>): Promise<T> {
    this.outstanding.add(value);
    void value.then(() => this.outstanding.delete(value), () => this.outstanding.delete(value));
    return value;
  }

  async *stream(request: ModelProviderRequest, beforeDispatch?: () => void): AsyncGenerator<ModelProviderEvent> {
    let dispatched = false;
    const controller = new AbortController();
    let callerSignal: AbortSignal | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => controller.abort("cancelled");
    const dispatch = () => dispatched ? "uncertain" as const : "not-sent" as const;
    const wait = async <T>(work: Promise<T>): Promise<T> => {
      const pending = this.track(work);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const interruption = new Promise<never>((_, reject) => {
        onAbort = () => reject(new ModelProviderError(controller.signal.reason === "timeout" ? "timeout" : "cancelled", dispatch()));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
        timer = setTimeout(() => controller.abort("timeout"), this.dependencies.idleTimeoutMs ?? 30_000);
      });
      try { return await Promise.race([pending, interruption]); }
      finally {
        clearTimeout(timer);
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      }
    };
    try {
      if (!request || ![Object.prototype, null].includes(Object.getPrototypeOf(request))) throw new ModelProviderError("invalid-request");
      const input: Record<string, unknown> = Object.create(null);
      const keys = Reflect.ownKeys(request);
      if (keys.length > 16) throw new ModelProviderError("invalid-request");
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(request, key);
        if (typeof key !== "string" || !descriptor || !("value" in descriptor)) throw new ModelProviderError("invalid-request");
        if (key === "signal") {
          if (!(descriptor.value instanceof AbortSignal)) throw new ModelProviderError("invalid-request");
          callerSignal = descriptor.value;
        } else input[key] = descriptor.value;
      }
      if (!callerSignal) throw new ModelProviderError("invalid-request");
      callerSignal.addEventListener("abort", cancel, { once: true });
      if (callerSignal.aborted) throw new ModelProviderError("cancelled");
      deadline = setTimeout(() => controller.abort("timeout"), this.dependencies.totalTimeoutMs ?? 600_000);
      const parsed = modelProviderInputSchema.safeParse(boundedModelCopy(input));
      if (!parsed.success) throw new ModelProviderError("invalid-request");
      const data = parsed.data;
      validateModelMessages(data.messages, data.tools ?? []);
      if (!this.dependencies.transport) throw new ModelProviderError("provider-unavailable");
      const resolution = await wait(this.dependencies.modelConfig.resolve({
        ...(data.provider ? { provider: data.provider } : {}),
        ...(data.profileId ? { profileId: data.profileId } : {}),
        ...(data.contextWindow ? { contextWindow: data.contextWindow } : {}),
        ...(data.maxOutputTokens ? { outputTokens: data.maxOutputTokens } : {}),
        // Model config's budget contract omits tool_call_id, while wire transport retains it.
        messages: data.messages.map(({ tool_call_id: _id, ...message }) => message),
      }));
      if (!this.availability(resolution.provider).available) throw new ModelProviderError("provider-unavailable");
      if (!["configured", "model-unverified"].includes(resolution.status) || !resolution.profile || !resolution.budget) {
        throw new ModelProviderError(resolution.status === "invalid-budget" ? "context-budget" : "configuration-unavailable");
      }
      const { profile, budget } = resolution;
      const payload: ModelProviderPayload = {
        model: profile.model, messages: data.messages, stream: true,
        [profile.outputTokenParameter]: budget.outputTokens,
        ...(profile.includeUsage ? { stream_options: { include_usage: true as const } } : {}),
        ...(data.tools?.length ? { tools: data.tools.map(tool => ({ type: "function" as const, function: tool })) } : {}),
      };
      const wireEstimate = estimateChatPromptTokens(data.messages, data.tools);
      if (budget.fits === false || Math.max(wireEstimate, budget.estimatedInputTokens ?? 0) > budget.inputBudget) throw new ModelProviderError("context-budget");
      if (controller.signal.aborted) throw new ModelProviderError("cancelled");
      beforeDispatch?.();
      if (controller.signal.aborted) throw new ModelProviderError("cancelled");
      dispatched = true;
      const opening = this.dependencies.transport.open({ provider: resolution.provider, payload, signal: controller.signal });
      // An injected host may ignore abort. Dispose even a response arriving after cancellation.
      void opening.then(body => { if (controller.signal.aborted) void this.track(body.cancel()).catch(() => {}); }, () => {});
      const body = await wait(opening);
      let finished: "stop" | "tool_calls" | "length" | undefined, done = false, outputBytes = 0, visible = false;
      let measured: ModelProviderUsage | undefined;
      const calls = new Map<number, ModelProviderToolCall>();
      const oldIds = new Set(data.messages.flatMap(message => message.tool_calls?.map(call => call.id) ?? []));
      for await (const event of decodeModelSse(body, wait)) {
        if (controller.signal.aborted) throw new ModelProviderError("cancelled", "uncertain");
        if (event === "[DONE]") { done = true; break; }
        let chunk: Record<string, unknown>;
        try {
          const value = boundedModelCopy(JSON.parse(event), 65_536);
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
          chunk = value as Record<string, unknown>;
        } catch { throw new ModelProviderError("invalid-stream", "uncertain"); }
        if (chunk.error) throw new ModelProviderError("provider-error", "uncertain");
        if (chunk.usage !== undefined && chunk.usage !== null) {
          const usage = normalizeModelUsage(chunk.usage);
          if (usage.outputTokens > budget.outputTokens) throw new ModelProviderError("output-budget", "uncertain");
          if (usage.inputTokens + budget.outputTokens > budget.contextWindow) throw new ModelProviderError("context-budget", "uncertain");
          if (measured && (usage.inputTokens < measured.inputTokens || usage.outputTokens < measured.outputTokens)) throw new ModelProviderError("invalid-stream", "uncertain");
          measured = usage;
          yield { type: "usage", ...usage };
        }
        if (!Array.isArray(chunk.choices) || chunk.choices.length > 1) throw new ModelProviderError("invalid-stream", "uncertain");
        if (!chunk.choices.length) continue;
        const choice = chunk.choices[0] as { index?: unknown; delta?: unknown; finish_reason?: unknown };
        if (!choice || typeof choice !== "object" || choice.index !== undefined && choice.index !== 0
          || !choice.delta || typeof choice.delta !== "object" || Array.isArray(choice.delta) || finished) throw new ModelProviderError("invalid-stream", "uncertain");
        const delta = choice.delta as Record<string, unknown>;
        for (const field of ["content", "refusal", "reasoning_summary"]) {
          if (delta[field] !== undefined && delta[field] !== null && typeof delta[field] !== "string") throw new ModelProviderError("invalid-stream", "uncertain");
        }
        const text = (delta.content || delta.refusal || "") as string;
        const summary = (delta.reasoning_summary || "") as string;
        outputBytes += Buffer.byteLength(text + summary, "utf8");
        if (delta.tool_calls !== undefined) {
          if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 16) throw new ModelProviderError("invalid-tool", "uncertain");
          for (const raw of delta.tool_calls) {
            if (!raw || typeof raw !== "object") throw new ModelProviderError("invalid-tool", "uncertain");
            const fragment = raw as { index?: unknown; id?: unknown; type?: unknown; function?: unknown };
            if (!Number.isSafeInteger(fragment.index) || (fragment.index as number) < 0 || (fragment.index as number) > 15
              || fragment.type !== undefined && fragment.type !== "function") throw new ModelProviderError("invalid-tool", "uncertain");
            let call = calls.get(fragment.index as number);
            if (!call) {
              call = { id: "", type: "function", function: { name: "", arguments: "" } };
              calls.set(fragment.index as number, call);
            }
            if (fragment.function !== undefined && (!fragment.function || typeof fragment.function !== "object" || Array.isArray(fragment.function))) throw new ModelProviderError("invalid-tool", "uncertain");
            const fn = (fragment.function ?? {}) as { name?: unknown; arguments?: unknown };
            for (const value of [fragment.id, fn.name, fn.arguments]) {
              if (value !== undefined && typeof value !== "string") throw new ModelProviderError("invalid-tool", "uncertain");
            }
            call.id += (fragment.id ?? "") as string;
            call.function.name += (fn.name ?? "") as string;
            call.function.arguments += (fn.arguments ?? "") as string;
            if (call.id.length > 200 || call.function.name.length > 128 || call.function.arguments.length > 32_000) throw new ModelProviderError("invalid-tool", "uncertain");
          }
        }
        const toolBytes = [...calls.values()].reduce((bytes, call) => bytes + Buffer.byteLength(JSON.stringify({
          id: call.id, name: call.function.name, arguments: call.function.arguments,
        }), "utf8"), 0);
        if (outputBytes + toolBytes > 100_000) throw new ModelProviderError("output-budget", "uncertain");
        if (text) { visible = true; yield { type: "text", text }; }
        if (summary) yield { type: "reasoning-summary", text: summary };
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (!["stop", "tool_calls", "length"].includes(String(choice.finish_reason))) throw new ModelProviderError("invalid-stream", "uncertain");
          finished = choice.finish_reason as "stop" | "tool_calls" | "length";
        }
      }
      if (!done || !finished) throw new ModelProviderError("invalid-stream", "uncertain");
      if (controller.signal.aborted) throw new ModelProviderError("cancelled", "uncertain");
      if (finished === "length") {
        // Partial tool arguments are never released, even when syntactically valid.
        yield { type: "finish", reason: "length" };
        return;
      }
      if (finished === "stop" && (calls.size || !visible) || finished === "tool_calls" && !calls.size) throw new ModelProviderError("invalid-tool", "uncertain");
      const proposals: Extract<ModelProviderEvent, { type: "tool" }>[] = [];
      for (const [, call] of [...calls].sort(([a], [b]) => a - b)) {
        if (!toolCallSchema.safeParse(call).success || oldIds.has(call.id)) throw new ModelProviderError("invalid-tool", "uncertain");
        const tool = data.tools?.find(tool => tool.name === call.function.name);
        if (!tool) throw new ModelProviderError("invalid-tool", "uncertain");
        oldIds.add(call.id);
        proposals.push({ type: "tool", id: call.id, name: call.function.name, arguments: parseModelToolArguments(call.function.arguments, tool.parameters) });
      }
      for (const proposal of proposals) {
        if (controller.signal.aborted) throw new ModelProviderError("cancelled", "uncertain");
        yield proposal;
      }
      yield { type: "finish", reason: finished };
    } catch (error) {
      if (controller.signal.aborted) throw new ModelProviderError(controller.signal.reason === "timeout" ? "timeout" : "cancelled", dispatch());
      if (error instanceof ModelProviderError) throw new ModelProviderError(error.code, dispatched ? "uncertain" : "not-sent", error.retryable);
      throw new ModelProviderError(dispatched ? "transport-error" : "configuration-unavailable", dispatch());
    } finally {
      controller.abort();
      clearTimeout(deadline);
      callerSignal?.removeEventListener("abort", cancel);
    }
  }
}

export interface ModelProviderHttpOptions {
  /** Exact base URL allowlist, not origins or prefixes. No ambient/global fetch fallback. */
  endpoint: string;
  allowedEndpoints: readonly string[];
  fetch: typeof fetch;
  secretResolver: NativeSecretResolver;
  /** Native host unwraps its own opaque handle; never accepted by stream/public arguments. */
  authorization(handle: object, provider: "openai-compatible" | "azure-openai"): Promise<Readonly<Record<string, string>>>;
  apiVersion?: string;
}

export function createModelProviderHttpTransport(options: ModelProviderHttpOptions): ModelProviderTransport {
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || options.endpoint.length > 2048
      || endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && local)
      || !options.allowedEndpoints.includes(endpoint.href) || typeof options.fetch !== "function"
      || options.apiVersion !== undefined && !/^[A-Za-z0-9.-]{1,128}$/.test(options.apiVersion)) throw new Error();
  } catch { throw new ModelProviderError("invalid-request"); }
  const base = endpoint.href.replace(/\/+$/, "");
  const send = options.fetch;
  return {
    supports: provider => provider === "openai-compatible" || provider === "azure-openai",
    async open({ provider, payload, signal }) {
      let sent = false;
      try {
      if (provider === "vscode") throw new ModelProviderError("provider-unavailable");
      if (signal.aborted) throw new ModelProviderError("cancelled");
      const handle = await options.secretResolver.resolveSecret(modelApiKeySecretId);
      if (!handle || typeof handle !== "object") throw new ModelProviderError("authentication");
      const auth = await options.authorization(handle, provider);
      const headers = new Headers({ "content-type": "application/json", accept: "text/event-stream" });
      const credentialName = provider === "azure-openai" ? "api-key" : "authorization";
      if (Object.keys(auth).length !== 1 || typeof auth[credentialName] !== "string" || !auth[credentialName]
        || /[\r\n]/.test(auth[credentialName]) || auth[credentialName].length > 8192) throw new ModelProviderError("authentication");
      headers.set(credentialName, auth[credentialName]);
      if (signal.aborted) throw new ModelProviderError("cancelled");
      const url = provider === "azure-openai"
        ? `${base}/openai/deployments/${encodeURIComponent(payload.model)}/chat/completions?api-version=${encodeURIComponent(options.apiVersion ?? "2024-06-01")}`
        : `${base}/chat/completions`;
      sent = true;
      const response = await send(url, { method: "POST", headers, body: JSON.stringify(payload), signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new ModelProviderError(response.status === 401 || response.status === 403 ? "authentication"
          : response.status === 429 ? "rate-limited" : "provider-error", "uncertain", response.status === 429 || response.status >= 500);
      }
      if (!response.body || !/^text\/event-stream(?:;|$)/i.test(response.headers.get("content-type") ?? "")) {
        void response.body?.cancel().catch(() => {});
        throw new ModelProviderError("invalid-stream", "uncertain");
      }
      return response.body;
      } catch (error) {
        if (error instanceof ModelProviderError) throw error;
        throw new ModelProviderError(signal.aborted ? "cancelled" : sent ? "transport-error" : "authentication",
          sent ? "uncertain" : "not-sent");
      }
    },
  };
}
