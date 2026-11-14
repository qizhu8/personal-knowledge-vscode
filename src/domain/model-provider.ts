import { z } from "zod";
import { ModelProviderError, type ModelProviderMessage, type ModelProviderTool, type ModelProviderUsage } from "../model-provider-contracts.js";

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const name = z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/);
export const toolCallSchema = z.strictObject({
  id, type: z.literal("function"),
  function: z.strictObject({ name, arguments: z.string().max(32_000) }),
});
export const modelProviderInputSchema = z.strictObject({
  provider: z.enum(["vscode", "openai-compatible", "azure-openai"]).optional(),
  profileId: z.string().min(1).max(256).optional(),
  contextWindow: z.number().int().min(256).max(2_000_000).optional(),
  maxOutputTokens: z.number().int().min(1).max(2_000_000).optional(),
  messages: z.array(z.strictObject({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string().max(100_000),
    tool_call_id: id.optional(),
    tool_calls: z.array(toolCallSchema).max(16).optional(),
  })).min(1).max(256),
  tools: z.array(z.strictObject({
    name, description: z.string().max(8192), parameters: z.record(z.string(), z.unknown()),
  })).max(16).optional(),
});

/** Snapshot native/public input without invoking accessors or serializing unbounded trees. */
export function boundedModelCopy(value: unknown, maxBytes = 2_000_000): unknown {
  let bytes = 0, nodes = 0;
  const ancestors = new Set<object>();
  const copy = (current: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 16) throw new ModelProviderError("invalid-request");
    if (typeof current === "string") {
      bytes += Buffer.byteLength(current, "utf8");
    } else if (current === null || typeof current === "boolean" || typeof current === "number" && Number.isFinite(current)) {
      bytes += 16;
    } else if (typeof current === "object" && current !== null) {
      if (ancestors.has(current)) throw new ModelProviderError("invalid-request");
      ancestors.add(current);
      try {
        if (Array.isArray(current)) {
          if (Object.getPrototypeOf(current) !== Array.prototype || current.length > 4096
            || Reflect.ownKeys(current).length !== current.length + 1) throw new ModelProviderError("invalid-request");
          const result = [];
          for (let index = 0; index < current.length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
            if (!descriptor || !("value" in descriptor)) throw new ModelProviderError("invalid-request");
            result.push(copy(descriptor.value, depth + 1));
          }
          return result;
        }
        if (![Object.prototype, null].includes(Object.getPrototypeOf(current))) throw new ModelProviderError("invalid-request");
        const keys = Reflect.ownKeys(current);
        if (keys.length > 256) throw new ModelProviderError("invalid-request");
        const result: Record<string, unknown> = Object.create(null);
        for (const key of keys) {
          if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) throw new ModelProviderError("invalid-request");
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (!descriptor || !("value" in descriptor)) throw new ModelProviderError("invalid-request");
          bytes += Buffer.byteLength(key, "utf8");
          if (bytes > maxBytes) throw new ModelProviderError("invalid-request");
          result[key] = copy(descriptor.value, depth + 1);
        }
        return result;
      } finally { ancestors.delete(current); }
    } else throw new ModelProviderError("invalid-request");
    if (bytes > maxBytes) throw new ModelProviderError("invalid-request");
    return current;
  };
  return copy(value, 0);
}

const schemaKeys = new Set(["type", "properties", "required", "additionalProperties", "items", "enum",
  "description", "title", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]);
export function validateModelToolSchema(schema: Record<string, unknown>, depth = 0): void {
  if (depth > 8 || Object.keys(schema).some(key => !schemaKeys.has(key))) throw new ModelProviderError("invalid-tool");
  if (!["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(schema.type))) throw new ModelProviderError("invalid-tool");
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) {
    const value = schema[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value)
      || !["minimum", "maximum"].includes(key) && (!Number.isSafeInteger(value) || value < 0))) throw new ModelProviderError("invalid-tool");
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length
    || schema.enum.some(value => value !== null && !["string", "number", "boolean"].includes(typeof value)))) throw new ModelProviderError("invalid-tool");
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== "string"))) throw new ModelProviderError("invalid-tool");
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") throw new ModelProviderError("invalid-tool");
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) throw new ModelProviderError("invalid-tool");
    for (const child of Object.values(schema.properties)) {
      if (!child || typeof child !== "object" || Array.isArray(child)) throw new ModelProviderError("invalid-tool");
      validateModelToolSchema(child as Record<string, unknown>, depth + 1);
    }
  }
  if (schema.type === "array") {
    if (!schema.items || typeof schema.items !== "object" || Array.isArray(schema.items)) throw new ModelProviderError("invalid-tool");
    validateModelToolSchema(schema.items as Record<string, unknown>, depth + 1);
  } else if (schema.items !== undefined) throw new ModelProviderError("invalid-tool");
}

function matchesSchema(value: unknown, schema: Record<string, unknown>): boolean {
  const type = schema.type;
  if (type === "null" ? value !== null : type === "array" ? !Array.isArray(value)
    : type === "object" ? !value || typeof value !== "object" || Array.isArray(value)
    : type === "integer" ? !Number.isSafeInteger(value) : typeof value !== type) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (typeof value === "number" && (typeof schema.minimum === "number" && value < schema.minimum
    || typeof schema.maximum === "number" && value > schema.maximum)) return false;
  if (typeof value === "string" && (typeof schema.minLength === "number" && [...value].length < schema.minLength
    || typeof schema.maxLength === "number" && [...value].length > schema.maxLength)) return false;
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems
      || typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    return value.every(item => matchesSchema(item, schema.items as Record<string, unknown>));
  }
  if (type === "object") {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    if ((schema.required as string[] | undefined)?.some(key => !Object.hasOwn(record, key))) return false;
    return Object.entries(record).every(([key, item]) => Object.hasOwn(properties, key)
      ? matchesSchema(item, properties[key]!) : schema.additionalProperties !== false);
  }
  return true;
}

export function parseModelToolArguments(text: string, schema?: Record<string, unknown>): Record<string, unknown> {
  try {
    const value = boundedModelCopy(JSON.parse(text), 64_000);
    if (!value || typeof value !== "object" || Array.isArray(value) || schema && !matchesSchema(value, schema)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new ModelProviderError("invalid-tool", "uncertain"); }
}

export function validateModelMessages(messages: ModelProviderMessage[], tools: ModelProviderTool[]): void {
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new ModelProviderError("invalid-tool");
  for (const tool of tools) {
    validateModelToolSchema(tool.parameters);
    if (tool.parameters.type !== "object") throw new ModelProviderError("invalid-tool");
  }
  const ids = new Set<string>(), pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.tool_call_id || !pending.delete(message.tool_call_id) || message.tool_calls) throw new ModelProviderError("invalid-request");
    } else {
      if (pending.size || message.tool_call_id || message.tool_calls && message.role !== "assistant") throw new ModelProviderError("invalid-request");
      for (const call of message.tool_calls ?? []) {
        if (ids.has(call.id)) throw new ModelProviderError("invalid-tool");
        parseModelToolArguments(call.function.arguments);
        ids.add(call.id); pending.add(call.id);
      }
    }
  }
  if (pending.size) throw new ModelProviderError("invalid-request");
}

export function normalizeModelUsage(raw: unknown): ModelProviderUsage {
  if (!raw || typeof raw !== "object") throw new ModelProviderError("invalid-stream", "uncertain");
  const value = raw as Record<string, unknown>;
  const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!integer(value.prompt_tokens) || !integer(value.completion_tokens)) throw new ModelProviderError("invalid-stream", "uncertain");
  const usage: ModelProviderUsage = { inputTokens: value.prompt_tokens, outputTokens: value.completion_tokens };
  const cached = (value.prompt_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens;
  const reasoning = (value.completion_tokens_details as { reasoning_tokens?: unknown } | undefined)?.reasoning_tokens;
  if (cached !== undefined) {
    if (!integer(cached) || cached > usage.inputTokens) throw new ModelProviderError("invalid-stream", "uncertain");
    usage.cachedInputTokens = cached;
  }
  if (integer(reasoning) && reasoning <= usage.outputTokens) usage.reasoningTokens = reasoning;
  if (value.copilot_usage !== undefined) {
    const credit = (value.copilot_usage as { total_nano_aiu?: unknown } | null)?.total_nano_aiu;
    if (!integer(credit)) throw new ModelProviderError("invalid-stream", "uncertain");
    usage.copilotNanoAiu = credit;
  }
  return usage;
}

/** SSE wire framing, bounded before UTF-8/JSON decoding. Supports CR, LF and CRLF. */
export async function* decodeModelSse(body: ReadableStream<Uint8Array>, wait: <T>(pending: Promise<T>) => Promise<T>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let line: number[] = [], event: string[] = [], eventBytes = 0, total = 0, count = 0, cr = false;
  const endLine = (): string | undefined => {
    const text = decoder.decode(Uint8Array.from(line)); line = [];
    if (!text) {
      const data = event.length ? event.join("\n") : undefined;
      event = []; eventBytes = 0;
      if (++count > 4096) throw new ModelProviderError("invalid-stream", "uncertain");
      return data;
    }
    if (text.startsWith("data:")) event.push(text.slice(text[5] === " " ? 6 : 5));
    return undefined;
  };
  try {
    for (;;) {
      const chunk = await wait(reader.read());
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength > 262_144
        || (total += chunk.value.byteLength) > 2_000_000) throw new ModelProviderError("invalid-stream", "uncertain");
      for (const byte of chunk.value) {
        if (cr && byte === 10) { cr = false; continue; }
        cr = false;
        if (++eventBytes > 65_536) throw new ModelProviderError("invalid-stream", "uncertain");
        if (byte === 13 || byte === 10) {
          cr = byte === 13;
          const data = endLine();
          if (data !== undefined) yield data;
        } else line.push(byte);
      }
    }
    if (line.length || event.length) throw new ModelProviderError("invalid-stream", "uncertain");
  } catch (error) {
    if (error instanceof ModelProviderError) throw error;
    throw new ModelProviderError("invalid-stream", "uncertain");
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
