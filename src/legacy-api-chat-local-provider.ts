import { validateLegacyApiChatImages } from "./legacy-api-chat-archive.js";
import type { LegacyApiChatRuntimeOptions } from "./legacy-api-chat-runtime.js";

/** Private native experiment only. Unlike the retained legacy HTTP client, this port transports inline images. */
export function createLegacyApiChatLocalProvider(options: { endpoint: string; apiKey: string; model: string }): LegacyApiChatRuntimeOptions["provider"] {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/v1"
    || !options.apiKey || options.apiKey.length > 4096 || /[\r\n]/.test(options.apiKey)
    || !options.model || options.model.length > 200) throw new Error("An explicit bounded private loopback provider configuration is required.");
  return async (messages, signal) => {
    const body = messages.map(message => {
      validateLegacyApiChatImages(message.images);
      return { role: message.role, content: message.images?.length
        ? [{ type: "text", text: message.content }, ...message.images.map(image => ({
          type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` },
        }))] : message.content };
    });
    const response = await fetch(`${endpoint.href}/chat/completions`, {
      method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: options.model, messages: body, stream: true }),
    });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) {
      await response.body?.cancel();
      throw new Error("Private API Chat provider did not return a successful SSE stream.");
    }
    let pending = "", text = "", received = 0, output = 0, done = false, stopped = false;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const reader = response.body.getReader();
    function event(raw: string) {
      if (Buffer.byteLength(raw) > 1_048_576) throw new Error("Private API Chat SSE frame exceeds 1 MiB.");
      const data = raw.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (!data) return;
      if (done) throw new Error("Private API Chat provider sent data after its completion marker.");
      if (data === "[DONE]") { done = true; return; }
      const frame = JSON.parse(data);
      if (frame.error || !Array.isArray(frame.choices) || frame.choices.length !== 1)
        throw new Error("Invalid private API Chat provider frame.");
      const choice = frame.choices[0];
      if (!choice || !choice.delta || typeof choice.delta !== "object" || Array.isArray(choice.delta)
        || choice.delta.tool_calls || choice.delta.function_call
        || choice.delta.refusal || choice.finish_reason && choice.finish_reason !== "stop")
        throw new Error("Private API Chat provider did not finish a plain text response.");
      if (choice.delta.content !== undefined && choice.delta.content !== null) {
        if (typeof choice.delta.content !== "string" || stopped) throw new Error("Invalid provider text delta.");
        output += Buffer.byteLength(choice.delta.content);
        if (output > 16_777_216) throw new Error("Private API Chat provider output exceeds 16 MiB.");
        text += choice.delta.content;
      }
      if (choice.finish_reason === "stop") stopped = true;
    }
    function consume(chunk: string) {
      pending += chunk;
      let end;
      while ((end = pending.search(/\r?\n\r?\n/)) >= 0) {
        const separator = /^\r?\n\r?\n/.exec(pending.slice(end))![0];
        event(pending.slice(0, end).replace(/\r\n/g, "\n"));
        pending = pending.slice(end + separator.length);
      }
      if (Buffer.byteLength(pending) > 1_048_576) throw new Error("Private API Chat SSE frame exceeds 1 MiB.");
    }
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        received += part.value.byteLength;
        if (received > 33_554_432) throw new Error("Private API Chat provider stream exceeds 32 MiB.");
        consume(decoder.decode(part.value, { stream: true }));
      }
      consume(decoder.decode());
      if (pending.trim() || !done || !stopped) throw new Error("Private API Chat provider stream ended without a complete result.");
      return text;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  };
}
