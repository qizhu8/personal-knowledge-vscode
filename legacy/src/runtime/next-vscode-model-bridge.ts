import * as vscode from "vscode";
import type { VscodeChatModel } from "../chat/api-chat-vscode";
import { decodeChatImage } from "../chat/api-chat-client";

type Part = { value?: string; callId?: string; name?: string; input?: unknown };
type Stream = { cancellation: vscode.CancellationTokenSource; iterator?: AsyncIterator<Part | string>; busy: boolean;
  calls: number; metadata: number; queued: string; tools: Set<string>; dispatch?: () => Promise<void> };
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const permittedTools = new Set(["run_process", "process_get", "process_output", "process_cancel"]);
const failure = (error: unknown) => {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return code === "NoPermissions" ? "MODEL_AUTHENTICATION"
    : code === "NotFound" ? "MODEL_PROVIDER_UNAVAILABLE" : "MODEL_PROVIDER_ERROR";
};

/** Runs only in the extension host, with one explicitly selected native VS Code model. */
export function createNextVscodeModelBridge(options: {
  model: VscodeChatModel; session: string; signal: AbortSignal; assertCurrent(): void;
  send(message: object): void;
}) {
  const streams = new Map<string, Stream>();
  const native = vscode as typeof vscode & {
    LanguageModelTextPart?: new (value: string) => Part;
    LanguageModelToolCallPart?: new (id: string, name: string, input: unknown) => Part;
    LanguageModelToolResultPart?: new (id: string, content: Part[]) => Part;
    LanguageModelDataPart?: new (...args: any[]) => Part & { data?: Uint8Array; mimeType?: string };
    LanguageModelThinkingPart?: new (...args: any[]) => Part;
  };
  let closed = false;
  const stop = (streamId: string) => {
    const stream = streams.get(streamId);
    if (!stream) return;
    streams.delete(streamId);
    stream.cancellation.cancel();
    stream.cancellation.dispose();
    try { if (stream.iterator?.return) void Promise.resolve(stream.iterator.return()).catch(() => {}); } catch { /* Already closed. */ }
  };
  const dispose = () => {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener("abort", dispose);
    for (const streamId of streams.keys()) stop(streamId);
  };
  options.signal.addEventListener("abort", dispose, { once: true });
  if (options.signal.aborted) dispose();
  const reply = (requestId: string, value: object) => options.send({ type: "selected-lm-result", id: requestId, ...value });
  const check = () => {
    if (closed || options.signal.aborted) throw new Error("Model selection revoked.");
    options.assertCurrent();
  };
  return {
    dispose,
    handle(message: Record<string, any>): boolean {
      if (!["selected-lm-open", "selected-lm-dispatch", "selected-lm-next", "selected-lm-cancel"].includes(message.type)) return false;
      if (!uuid(message.id) || !uuid(message.streamId) || message.session !== options.session) return true;
      const requestId = message.id, streamId = message.streamId;
      if (message.type === "selected-lm-cancel") { stop(streamId); reply(requestId, { result: { cancelled: true } }); return true; }
      if (message.type === "selected-lm-dispatch") {
        void (async () => {
          check();
          const stream = streams.get(streamId), dispatch = stream?.dispatch;
          if (!stream || !dispatch) throw new Error("Prepared model stream unavailable.");
          delete stream.dispatch;
          await dispatch();
          if (streams.get(streamId) === stream) reply(requestId, { result: { opened: true } });
        })().catch(error => { stop(streamId); reply(requestId, { error: failure(error) }); });
        return true;
      }
      if (message.type === "selected-lm-open") {
        void (async () => {
          check();
          if (streams.size >= 8 || streams.has(streamId) || !Array.isArray(message.messages)
            || message.messages.length < 1 || message.messages.length > 128 || !Array.isArray(message.tools)
            || message.tools.length > 4 || !Number.isSafeInteger(message.maxOutputTokens) || message.maxOutputTokens < 1
            || !Number.isSafeInteger(message.maxInputTokens) || message.maxInputTokens < 1
            || Buffer.byteLength(JSON.stringify(message)) > (message.images ? 2 * 1024 * 1024 : 262144))
            throw new Error("Invalid model request.");
          const images = message.images;
          if (images !== undefined && Buffer.byteLength(JSON.stringify({ ...message, images: undefined })) > 262144)
            throw new Error("Invalid model request.");
          if (images !== undefined && (!images || Object.keys(images).some(key => !["messageIndex", "items"].includes(key))
            || !Number.isSafeInteger(images.messageIndex) || images.messageIndex < 0 || images.messageIndex >= message.messages.length
            || message.messages[images.messageIndex]?.role !== "user" || !Array.isArray(images.items)
            || images.items.length < 1 || images.items.length > 2 || options.model.capabilities?.imageInput !== true
            || !native.LanguageModelDataPart || !native.LanguageModelTextPart || typeof options.model.countTokens !== "function"))
            throw new Error("Invalid or unsupported image input.");
          const decoded = images?.items.map((image: any) => {
            if (!image || Object.keys(image).some(key => !["label", "mimeType", "dataBase64"].includes(key))
              || typeof image.label !== "string" || !image.label || image.label.length > 120 || /[\u0000-\u001f\u007f]/.test(image.label)
              || !["image/png", "image/jpeg"].includes(image.mimeType) || typeof image.dataBase64 !== "string"
              || image.dataBase64.length > 700000 || Buffer.from(image.dataBase64, "base64").toString("base64") !== image.dataBase64)
              throw new Error("Invalid image.");
            return { bytes: decodeChatImage(image), mimeType: image.mimeType };
          });
          const names = new Set<string>();
          const tools = message.tools.map((tool: any) => {
            if (!tool || !permittedTools.has(tool.name) || names.has(tool.name) || typeof tool.description !== "string"
              || !tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters))
              throw new Error("Invalid model tools.");
            names.add(tool.name);
            return { name: tool.name, description: tool.description, inputSchema: tool.parameters };
          });
          if (tools.length && (!native.LanguageModelTextPart || !native.LanguageModelToolCallPart || !native.LanguageModelToolResultPart
            || options.model.capabilities?.toolCalling === false
            || typeof options.model.capabilities?.toolCalling === "number" && options.model.capabilities.toolCalling < tools.length))
            throw new Error("Selected model does not support tools.");
          const prompt = message.messages.map((entry: any, index: number) => {
            if (!entry || !["system", "user", "assistant", "tool"].includes(entry.role) || typeof entry.content !== "string")
              throw new Error("Invalid model message.");
            const text = entry.role === "system" ? `[PKM instructions and reference context]\n${entry.content}` : entry.content;
            const result = entry.role === "assistant" ? vscode.LanguageModelChatMessage.Assistant(text) : vscode.LanguageModelChatMessage.User(text);
            if (native.LanguageModelTextPart) {
              const parts: Part[] = [new native.LanguageModelTextPart(text)];
              if (images?.messageIndex === index)
                for (const image of decoded) parts.push(new native.LanguageModelDataPart!(image.bytes, image.mimeType));
              if (entry.role === "tool") {
                if (!id(entry.tool_call_id) || !native.LanguageModelToolResultPart) throw new Error("Invalid tool result.");
                parts.splice(0, 1, new native.LanguageModelToolResultPart(entry.tool_call_id, [...parts]));
              } else if (entry.tool_calls) {
                if (entry.role !== "assistant" || !Array.isArray(entry.tool_calls) || entry.tool_calls.length > 16 || !native.LanguageModelToolCallPart)
                  throw new Error("Invalid tool calls.");
                for (const call of entry.tool_calls) {
                  if (!id(call.id) || !id(call.function?.name) || typeof call.function?.arguments !== "string") throw new Error("Invalid tool call.");
                  parts.push(new native.LanguageModelToolCallPart(call.id, call.function.name, JSON.parse(call.function.arguments)));
                }
              }
              Object.assign(result, { content: parts });
            } else if (entry.role === "tool" || entry.tool_calls?.length) throw new Error("Tool messages unavailable.");
            return result;
          });
          const stream: Stream = { cancellation: new vscode.CancellationTokenSource(), busy: false, calls: 0, metadata: 0,
            queued: "", tools: names };
          streams.set(streamId, stream);
          let bound: number;
          if (images) {
            const counts = await Promise.all([...prompt.map((entry: vscode.LanguageModelChatMessage) =>
              options.model.countTokens(entry, stream.cancellation.token)),
              ...(tools.length ? [options.model.countTokens(JSON.stringify(tools), stream.cancellation.token)] : [])]);
            if (streams.get(streamId) !== stream) return;
            check();
            if (counts.some(count => !Number.isSafeInteger(count) || count < 0)) throw new Error("Model token count unavailable.");
            bound = counts.reduce((total, count) => total + count + 32, 32);
          } else bound = Buffer.byteLength(JSON.stringify([prompt, tools])) + prompt.length * 32 + 32;
          if (bound > message.maxInputTokens || bound + message.maxOutputTokens > options.model.maxInputTokens)
            throw new Error("Model context budget exceeded.");
          const requestOptions = { justification: "Allow PKM native Chat to use the selected model with your selected context.",
            ...(tools.length ? { tools } : {}) };
          const dispatch = async () => {
            check();
            const response = await options.model.sendRequest(prompt, requestOptions, stream.cancellation.token);
            if (streams.get(streamId) !== stream) return;
            check();
            const structured = (response as typeof response & { stream?: AsyncIterable<Part> }).stream;
            stream.iterator = (structured || response.text)[Symbol.asyncIterator]();
          };
          if (message.prepareOnly === true) {
            stream.dispatch = dispatch;
            reply(requestId, { result: { prepared: true } });
          } else {
            await dispatch();
            if (streams.get(streamId) === stream) reply(requestId, { result: { opened: true } });
          }
        })().catch(error => { stop(streamId); reply(requestId, { error: failure(error) }); });
        return true;
      }
      void (async () => {
        check();
        const stream = streams.get(streamId);
        if (!stream?.iterator || stream.busy) throw new Error("Model stream unavailable.");
        stream.busy = true;
        try {
          if (stream.queued) {
            let end = Math.min(4096, stream.queued.length);
            if (end < stream.queued.length && /[\uD800-\uDBFF]/.test(stream.queued[end - 1])) end--;
            const text = stream.queued.slice(0, end);
            stream.queued = stream.queued.slice(end);
            reply(requestId, { result: { event: { type: "text", text } } });
            return;
          }
          let next;
          do {
            next = await stream.iterator.next();
            if (streams.get(streamId) !== stream) return;
            check();
            const part = next.value;
            if (next.done) break;
            if (typeof part === "string" && !part || native.LanguageModelTextPart
              && part instanceof native.LanguageModelTextPart && !part.value) {
              if (++stream.metadata > 128) throw new Error("Too many empty model parts.");
              continue;
            }
            if (native.LanguageModelThinkingPart && part instanceof native.LanguageModelThinkingPart) {
              if (++stream.metadata > 128) throw new Error("Too much model metadata.");
              continue;
            }
            if (native.LanguageModelDataPart && part instanceof native.LanguageModelDataPart
              && ["usage", "stateful_marker", "thinking", "context_management", "phase_data", "cache_control"].includes(part.mimeType || "")
              && part.data instanceof Uint8Array && part.data.byteLength <= 65536 && ++stream.metadata <= 128) continue;
            break;
          } while (true);
          if (streams.get(streamId) !== stream) return;
          check();
          if (next.done) {
            const calls = stream.calls;
            stop(streamId);
            reply(requestId, { result: { event: { type: "finish", reason: calls ? "tool_calls" : "stop" } } });
          } else if (typeof next.value === "string" || native.LanguageModelTextPart && next.value instanceof native.LanguageModelTextPart) {
            const text = typeof next.value === "string" ? next.value : next.value.value;
            if (typeof text !== "string" || Buffer.byteLength(text) > 100000) throw new Error("Invalid model text.");
            let end = Math.min(4096, text.length);
            if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
            stream.queued = text.slice(end);
            reply(requestId, { result: { event: { type: "text", text: text.slice(0, end) } } });
          } else if (native.LanguageModelToolCallPart && next.value instanceof native.LanguageModelToolCallPart) {
            const part = next.value;
            if (!id(part.callId) || !id(part.name) || !stream.tools.has(part.name) || !part.input
              || typeof part.input !== "object" || Array.isArray(part.input) || Buffer.byteLength(JSON.stringify(part.input)) > 32768
              || ++stream.calls > 16) throw new Error("Invalid model tool call.");
            reply(requestId, { result: { event: { type: "tool", id: part.callId, name: part.name, arguments: part.input } } });
          } else throw new Error("Unsupported model response.");
        } finally { stream.busy = false; }
      })().catch(error => { stop(streamId); reply(requestId, { error: failure(error) }); });
      return true;
    },
  };
}
