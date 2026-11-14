import { copilotSdkPrompt, type CopilotSdkDeps, type CopilotSdkModel } from "../chat/api-chat-copilot-sdk";
import { decodeChatImage, type ApiChatMessage } from "../chat/api-chat-client";

type Event = { type: "text"; text: string } | { type: "tool"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "finish"; reason: "stop" | "tool_calls" };
type Stream = { controller: AbortController; events: Event[]; dispatch?: (requestId: string) => void };
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const allowed = new Set(["run_process", "process_get", "process_output", "process_cancel"]);
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener("abort", cancel); reject(new Error("SDK request cancelled.")); };
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener("abort", cancel, { once: true });
    work.then(value => { signal.removeEventListener("abort", cancel); resolve(value); },
      error => { signal.removeEventListener("abort", cancel); reject(error); });
  });
}

/** A fresh SDK session produces one model round; only the child can execute a tool. */
export function createNextCopilotSdkBridge(options: {
  model: CopilotSdkModel; deps: CopilotSdkDeps; session: string; signal: AbortSignal;
  contextWindow: number; maxOutputTokens: number;
  assertCurrent(): void; send(message: object): void;
}) {
  const streams = new Map<string, Stream>();
  const jobs = new Set<Promise<void>>();
  const cleanups = new Set<() => Promise<void>>();
  let closed = false;
  const reply = (requestId: string, value: object) => options.send({ type: "selected-lm-result", id: requestId, ...value });
  const check = () => {
    if (closed || options.signal.aborted) throw new Error("SDK owner revoked.");
    options.assertCurrent();
  };
  const dispose = () => {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener("abort", dispose);
    for (const stream of streams.values()) stream.controller.abort();
  };
  options.signal.addEventListener("abort", dispose, { once: true });
  if (options.signal.aborted) dispose();

  const run = async (message: Record<string, any>, stream: Stream, awaitAdmission?: () => Promise<void>) => {
    check();
    if (!Array.isArray(message.messages) || message.messages.length < 1 || message.messages.length > 128
      || !Array.isArray(message.tools) || message.tools.length > 4
      || !Number.isSafeInteger(message.maxInputTokens) || message.maxInputTokens < 1
      || !Number.isSafeInteger(message.maxOutputTokens) || message.maxOutputTokens < 1
      || Buffer.byteLength(JSON.stringify(message)) > (message.images ? 2 * 1024 * 1024 : 262144)
      || message.images && Buffer.byteLength(JSON.stringify({ ...message, images: undefined })) > 262144)
      throw new Error("Invalid SDK request.");
    const names = new Set<string>();
    const tools = message.tools.map((tool: any) => {
      if (!tool || !allowed.has(tool.name) || names.has(tool.name) || typeof tool.description !== "string"
        || !tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters))
        throw new Error("Invalid SDK tools.");
      names.add(tool.name);
      return { name: tool.name as string, description: tool.description as string, parameters: tool.parameters };
    });
    if (tools.length && !options.model.capabilities.toolCalling) throw new Error("SDK tools unavailable.");
    const messages: ApiChatMessage[] = message.messages.map((entry: any) => {
      if (!entry || !["system", "user", "assistant", "tool"].includes(entry.role) || typeof entry.content !== "string")
        throw new Error("Invalid SDK message.");
      if (entry.role === "tool" && !id(entry.tool_call_id)) throw new Error("Invalid tool result.");
      if (entry.tool_calls !== undefined && (entry.role !== "assistant" || !Array.isArray(entry.tool_calls)
        || entry.tool_calls.length > 16 || entry.tool_calls.some((call: any) =>
          !id(call.id) || call.type !== "function" || !id(call.function?.name) || typeof call.function?.arguments !== "string"
          || Buffer.byteLength(call.function.arguments) > 32768))) throw new Error("Invalid tool history.");
      return { role: entry.role, content: entry.content,
        ...(entry.role === "tool" ? { tool_call_id: entry.tool_call_id } : {}),
        ...(entry.tool_calls ? { tool_calls: entry.tool_calls.map((call: any) => ({ id: call.id, type: "function",
          function: { name: call.function.name, arguments: call.function.arguments } })) } : {}) };
    });
    const images = message.images;
    if (images !== undefined) {
      if (!images || Object.keys(images).some(key => !["messageIndex", "items"].includes(key))
        || !Number.isSafeInteger(images.messageIndex) || images.messageIndex < 0 || images.messageIndex >= messages.length
        || messages[images.messageIndex].role !== "user" || !Array.isArray(images.items) || !images.items.length
        || images.items.length > 2 || !options.model.capabilities.imageInput
        || messages.slice(images.messageIndex + 1).some(entry => entry.role === "user"))
        throw new Error("Invalid SDK images.");
      for (const image of images.items) {
        if (!image || Object.keys(image).some(key => !["label", "mimeType", "dataBase64"].includes(key))) throw new Error("Invalid SDK image.");
        decodeChatImage(image);
      }
      messages[images.messageIndex] = { ...messages[images.messageIndex], images: images.items };
    }
    const prepared = copilotSdkPrompt(messages);
    prepared.prompt = messages.filter(entry => entry.role !== "system").map(entry => JSON.stringify({
      role: entry.role, content: entry.content, ...(entry.tool_call_id ? { tool_call_id: entry.tool_call_id } : {}),
      ...(entry.tool_calls ? { tool_calls: entry.tool_calls } : {}),
    })).join("\n");
    const inputBound = 96 + Buffer.byteLength(prepared.system) + Buffer.byteLength(prepared.prompt)
      + Buffer.byteLength(JSON.stringify(tools)) + 32 + prepared.images.length * 2000;
    const outputLimit = Math.min(message.maxOutputTokens, options.maxOutputTokens);
    if (inputBound > message.maxInputTokens || inputBound + outputLimit > Math.min(options.model.maxInputTokens, options.contextWindow))
      throw new Error("SDK input budget exceeded.");
    if (awaitAdmission) await abortable(awaitAdmission(), stream.controller.signal);
    if (stream.controller.signal.aborted) throw new Error("SDK request cancelled.");
    const token = await abortable(options.deps.token(true), stream.controller.signal);
    check();
    if (!token || stream.controller.signal.aborted) throw Object.assign(new Error("SDK authentication unavailable."), { code: "NoPermissions" });
    const runtime = await options.deps.client();
    check();
    if (stream.controller.signal.aborted) throw new Error("SDK request cancelled.");

    let releaseCallbacks: (() => void) | undefined;
    const blockedCallbacks = new Promise<void>(resolve => { releaseCallbacks = resolve; });
    const sdkTools = tools.map(tool => runtime.sdk.defineTool(tool.name, {
      description: tool.description, parameters: tool.parameters, skipPermission: true, defer: "never", overridesBuiltInTool: true,
      handler: async () => { await blockedCallbacks; return JSON.stringify({ error: "Not executed in the SDK session." }); },
    }));
    const sdkSession = await runtime.client.createSession({
      model: options.model.id, gitHubToken: token, streaming: true,
      systemMessage: { mode: "replace", content: prepared.system || "You are a helpful assistant." },
      tools: sdkTools, availableTools: [...names], enableConfigDiscovery: false, skipCustomInstructions: true,
      enableSkills: false, infiniteSessions: { enabled: false }, enableSessionStore: false,
      enableFileChangeTracking: false, enableHostGitOperations: false,
      onPermissionRequest: (permission: { kind?: string; toolName?: string }) =>
        permission.kind === "custom-tool" && names.has(permission.toolName || "")
          ? { kind: "approve-once" } : { kind: "reject", feedback: "PKM exposes only its own tools." },
    });
    let aborting: Promise<void> | undefined, aborted = false, disconnected = false, deleted = false;
    const abort = () => aborted ? Promise.resolve() : aborting ??= Promise.resolve().then(() => sdkSession.abort()).then(() => { aborted = true; })
      .catch(error => { aborting = undefined; throw error; });
    const cleanup = async () => {
      await abort();
      releaseCallbacks?.();
      if (!disconnected) { await sdkSession.disconnect(); disconnected = true; }
      if (!deleted) { await runtime.client.deleteSession?.(sdkSession.sessionId); deleted = true; }
      cleanups.delete(cleanup);
    };
    cleanups.add(cleanup);
    let done!: (error?: Error) => void;
    const finished = new Promise<void>((resolve, reject) => {
      let settled = false;
      done = error => { if (!settled) { settled = true; error ? reject(error) : resolve(); } };
    });
    void finished.catch(() => undefined);
    const cancel = () => { done(new Error("SDK request cancelled.")); void abort().catch(() => undefined); };
    stream.controller.signal.addEventListener("abort", cancel, { once: true });
    if (stream.controller.signal.aborted || closed) cancel();
    const seen = new Set<string>();
    const streamed = new Set<string>();
    const completed = new Set<string>();
    let textBytes = 0, calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
    let terminated = false, messageCount = 0, turns = 0;
    let unsubscribe = () => {};
    try {
    unsubscribe = sdkSession.on(event => {
      if (terminated && event.type !== "assistant.usage" || event.agentId || event.data?.parentToolCallId) return;
      try {
        if (++messageCount > 4096) throw new Error("Too many SDK events.");
        if (event.id && seen.has(event.id)) return;
        if (event.id) seen.add(event.id);
        const data = event.data || {};
        const append = (value: unknown) => {
          if (typeof value !== "string" || !value) return;
          textBytes += Buffer.byteLength(value);
          if (textBytes > 100000 || textBytes > outputLimit) throw new Error("SDK output limit.");
          for (let offset = 0; offset < value.length;) {
            let end = Math.min(value.length, offset + 4096);
            if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
            stream.events.push({ type: "text", text: value.slice(offset, end) });
            offset = end;
          }
        };
        if (event.type === "assistant.turn_start") {
          if (++turns > 1) throw new Error("SDK continuation is not admitted.");
        } else if (event.type === "assistant.message_delta") {
          const messageId = typeof data.messageId === "string" ? data.messageId : "default";
          if (completed.has(messageId)) return;
          completed.add(messageId);
          streamed.add(messageId); append(data.deltaContent);
        } else if (event.type === "assistant.message") {
          const messageId = typeof data.messageId === "string" ? data.messageId : "default";
          if (!streamed.has(messageId)) append(data.content);
          const requests = data.toolRequests === undefined ? [] : data.toolRequests;
          if (!Array.isArray(requests) || requests.length > 16) throw new Error("Invalid SDK tool requests.");
          const ids = new Set<string>();
          calls = requests.map((call: any) => {
            if (!id(call?.toolCallId) || ids.has(call.toolCallId) || !id(call.name) || !names.has(call.name)
              || !call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)
              || Buffer.byteLength(JSON.stringify(call.arguments)) > 32768) throw new Error("Invalid SDK tool call.");
            ids.add(call.toolCallId);
            return { id: call.toolCallId, name: call.name, arguments: call.arguments };
          });
          if (calls.length && textBytes + Buffer.byteLength(JSON.stringify(calls)) > outputLimit) throw new Error("SDK output limit.");
          if (calls.length) { terminated = true; void abort().then(() => done(), () => done(new Error("SDK abort unconfirmed."))); }
        } else if (event.type === "assistant.usage") {
          if (typeof data.outputTokens === "number" && (!Number.isSafeInteger(data.outputTokens)
            || data.outputTokens < 0 || data.outputTokens > outputLimit)) throw new Error("SDK output budget exceeded.");
        } else if (event.type === "session.error") throw new Error("SDK provider error.");
        else if (event.type === "session.idle") { terminated = true; aborted = true; done(); }
      } catch { terminated = true; done(new Error("SDK provider error.")); }
    });
      if (stream.controller.signal.aborted || closed) throw new Error("SDK request cancelled.");
      const sending = sdkSession.send({ prompt: prepared.prompt, ...(prepared.images.length ? {
        attachments: prepared.images.map(image => ({ type: "blob", data: image.dataBase64, mimeType: image.mimeType, displayName: image.label })),
      } : {}) });
      await Promise.all([abortable(sending, stream.controller.signal), finished]);
      check();
      if (stream.controller.signal.aborted) throw new Error("SDK request cancelled.");
      await abort();
      check();
      for (const call of calls) stream.events.push({ type: "tool", ...call });
      stream.events.push({ type: "finish", reason: calls.length ? "tool_calls" : "stop" });
    } finally {
      stream.controller.signal.removeEventListener("abort", cancel);
      try { unsubscribe(); } finally { await cleanup(); }
    }
  };
  return {
    dispose,
    async drain() { await Promise.all([...jobs]); for (const cleanup of [...cleanups]) await cleanup(); },
    handle(message: Record<string, any>): boolean {
      if (!["selected-lm-open", "selected-lm-dispatch", "selected-lm-next", "selected-lm-cancel"].includes(message.type)) return false;
      if (!uuid(message.id) || !uuid(message.streamId) || message.session !== options.session) return true;
      const requestId = message.id, streamId = message.streamId;
      if (message.type === "selected-lm-cancel") {
        const stream = streams.get(streamId);
        streams.delete(streamId); stream?.controller.abort();
        reply(requestId, { result: { cancelled: true } }); return true;
      }
      if (message.type === "selected-lm-dispatch") {
        const stream = streams.get(streamId), dispatch = stream?.dispatch;
        if (!dispatch) { reply(requestId, { error: "MODEL_PROVIDER_ERROR" }); return true; }
        delete stream!.dispatch;
        dispatch(requestId);
        return true;
      }
      if (message.type === "selected-lm-next") {
        try {
          check();
          const stream = streams.get(streamId), event = stream?.events.shift();
          if (!event) throw new Error("SDK stream unavailable.");
          if (event.type === "finish") streams.delete(streamId);
          reply(requestId, { result: { event } });
        } catch { reply(requestId, { error: "MODEL_PROVIDER_ERROR" }); }
        return true;
      }
      if (closed || streams.size >= 8 || streams.has(streamId)) {
        reply(requestId, { error: "MODEL_PROVIDER_ERROR" }); return true;
      }
      const stream: Stream = { controller: new AbortController(), events: [] };
      streams.set(streamId, stream);
      let resultId = requestId;
      const prepared = message.prepareOnly === true ? () => new Promise<void>(resolve => {
        stream.dispatch = id => { resultId = id; resolve(); };
        reply(requestId, { result: { prepared: true } });
      }) : undefined;
      const job = run(message, stream, prepared).then(() => {
        if (streams.get(streamId) === stream) reply(resultId, { result: { opened: true } });
      }, error => {
        streams.delete(streamId);
        reply(resultId, { error: error?.code === "NoPermissions" ? "MODEL_AUTHENTICATION" : "MODEL_PROVIDER_ERROR" });
      });
      jobs.add(job);
      void job.finally(() => jobs.delete(job));
      return true;
    },
  };
}
