// Exact AST-selected original declarations; only external Host types are structurally narrowed below.
import { createHash } from "node:crypto";

interface ApiChatRequest {
  tools?: ApiChatTool[];
  onTool?: (event: ApiChatToolEvent) => void;
  onToolResultContext?: (event: ApiChatToolEvent) => string | undefined;
  onToolResultsContext?: (events: readonly ApiChatToolEvent[]) => string | undefined;
  afterTools?: () => boolean;
}
interface ChatToolLoopGuard {
  summarizing: boolean;
  beforeRound(round: number, signal: AbortSignal): Promise<void>;
  reuse(name: string, args: string, messages: ApiChatMessage[], version?: string): {result: string; original: string} | undefined;
  record(tool: ApiChatTool | undefined, name: string, args: string, result: string, success?: boolean): void;
  remember(name: string, args: string, id: string, result: string, success: boolean, version?: string): void;
}

export interface ChatImage { label: string; mimeType: "image/png" | "image/jpeg"; dataBase64: string; }

export interface ApiChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: ChatImage[];
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

export interface ApiChatTool {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (arguments_: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
  execution?: "parallel-read";
  readVersion?: (arguments_: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
}

export interface ApiChatToolEvent {
  id: string; name: string; arguments: string; status: "running" | "complete" | "failed"; result?: string;
  round?: number; queuedMs?: number; reused?: boolean;
  dispatch?: { name:"capability_read" | "capability_call"; operation:string; version:1 };
}

export interface Capability {
  id: string;
  version: 1;
  transportName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  readOnly: boolean;
  authorization: string;
  concurrency: "exclusive" | "independent-read";
  idempotency: "read" | "digest-cas" | "operation-id" | "none";
  cancellation: string;
  errors: string[];
  lifecycle: { status: "stable"; legacyAlias: string };
}

export class CapabilityError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "CapabilityError"; }
}

export function validateCapabilityInput(value: unknown, schema: Record<string, unknown>, at = "arguments"): void {
  const fail = () => { throw new CapabilityError("INVALID_ARGUMENT", `Invalid ${at}.`); };
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    const object = value as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (schema.additionalProperties === false && Object.keys(object).some(key => !properties || !Object.prototype.hasOwnProperty.call(properties, key))) fail();
    if ((schema.required as string[] | undefined)?.some(key => object[key] === undefined)) fail();
    for (const [key, entry] of Object.entries(object)) if (properties?.[key]) validateCapabilityInput(entry, properties[key], `${at}.${key}`);
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < Number(schema.minItems ?? 0) || value.length > Number(schema.maxItems ?? 100)) fail();
    for (const entry of value as unknown[]) validateCapabilityInput(entry, schema.items as Record<string, unknown>, `${at}[]`);
  } else if (schema.type === "string") {
    if (typeof value !== "string" || value.length < Number(schema.minLength ?? 0) || value.length > Number(schema.maxLength ?? 16000)
      || schema.pattern && !new RegExp(String(schema.pattern)).test(value)) fail();
  } else if (schema.type === "integer") {
    if (!Number.isSafeInteger(value) || Number(value) < Number(schema.minimum ?? 0) || Number(value) > Number(schema.maximum ?? Number.MAX_SAFE_INTEGER)) fail();
  } else if (schema.type === "boolean" && typeof value !== "boolean") fail();
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) fail();
}

export class CapabilityRegistry {
  readonly revision: string;
  constructor(readonly operations: readonly Capability[]) {
    if (new Set(operations.map(operation => operation.id)).size !== operations.length
      || operations.some(operation => !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2}$/.test(operation.id))) {
      throw new Error("Capabilities require unique domain.object.operation identities.");
    }
    this.revision = createHash("sha256").update(JSON.stringify(operations)).digest("hex");
  }
  describe(id: string): Capability {
    const operation = this.operations.find(item => item.id === id);
    if (!operation) throw new CapabilityError("NOT_AVAILABLE", "Operation is not available in this authorized catalog.");
    return operation;
  }
  discover(input: Record<string, unknown>, search = false) {
    validateCapabilityInput(input, {
      type: "object", additionalProperties: false, properties: {
        path: { type: "string", maxLength: 100 }, query: { type: "string", maxLength: 200 },
        offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 10 },
        revision: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
    });
    if (input.revision !== undefined && input.revision !== this.revision) throw new CapabilityError("CONFLICT", "Capability catalog changed; restart discovery.");
    const path = String(input.path || ""), query = String(input.query || "").toLowerCase().trim();
    if (path && !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,2}$/.test(path)) throw new CapabilityError("INVALID_ARGUMENT", "Use a bounded capability path.");
    const tokens = query.split(/\s+/).filter(Boolean);
    const matches = this.operations.filter(item => (!path || item.id === path || item.id.startsWith(`${path}.`))
      && (!tokens.length || tokens.every(token => `${item.id} ${item.transportName} ${item.description}`.toLowerCase().includes(token))));
    const offset = Number(input.offset ?? 0), limit = Number(input.limit ?? (search ? 3 : 10));
    const entries = matches.slice(offset, offset + limit);
    return { schema: "pkm.capabilities/v1", revision: this.revision, total: matches.length, offset,
      nextOffset: offset + limit < matches.length ? offset + limit : null,
      children: [...new Set(matches.map(item => item.id.split(".").slice(0, path ? path.split(".").length + 1 : 1).join(".")))],
      operations: search ? entries : entries.map(({ id, version, readOnly, transportName, description }) => ({ id, version, readOnly, transportName, description })),
    };
  }
}

const coreTools = new Set(["ask_user", "read_file", "find_files", "search_text", "list_directory", "replace_text", "save_file",
  "run_process", "process_get", "process_output", "process_cancel", "session_info", "report_work", "record_harness",
  "get_plan", "submit_plan", "finish_debug"]);

const nativeReads = new Set(["diagnostic_logs", "find_actions", "note_todo_read", "pkm_search", "pkm_read", "list_chats",
  "read_chat_result", "find_vscode_tools", "memory_read"]);

export function nativeToolCapabilities(leaves: ApiChatTool[], definitions: readonly Capability[]): Capability[] {
  return leaves.filter(tool => !coreTools.has(tool.name) && !definitions.some(item => item.transportName === tool.name)).map(tool => {
    const readOnly = nativeReads.has(tool.name) || tool.execution === "parallel-read";
    const identity = /^[a-z][a-z0-9_]*$/.test(tool.name) ? tool.name : `external${createHash("sha256").update(tool.name).digest("hex")}`;
    return { id:`native.tool.${identity}`, version:1, transportName:tool.name, description:tool.description,
      inputSchema:tool.parameters, outputSchema:{ type:"string" }, readOnly,
      authorization:"Original enabled Host executor and all existing permission, target and lifecycle checks. Discovery grants no access.",
      concurrency:"exclusive", idempotency:readOnly ? "read" : "none",
      cancellation:"Original cancellation signal; committed effects are not rolled back or automatically replayed.",
      errors:["INVALID_ARGUMENT", "NOT_AVAILABLE", "ACCESS_DENIED", "CANCELLED", "EXECUTION_FAILED"],
      lifecycle:{ status:"stable", legacyAlias:tool.name } };
  });
}

export function projectNativeCapabilityEvent(event: ApiChatToolEvent, definitions: readonly Capability[]): ApiChatToolEvent {
  if (!["capability_read", "capability_call"].includes(event.name)) return event;
  let input: Record<string, unknown>;
  try { input = JSON.parse(event.arguments); } catch { return event; }
  const definition = definitions.find(item => item.id === input?.operation && item.id.startsWith("native.tool."));
  if (!definition || input.version !== 1 || !input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments)) return event;
  return { ...event, name:definition.transportName, arguments:JSON.stringify(input.arguments),
    dispatch:{ name:event.name === "capability_read" ? "capability_read" : "capability_call", operation:definition.id, version:1 } };
}

export function capabilityTools(leaves: ApiChatTool[], definitions: readonly Capability[], compact: boolean): ApiChatTool[] {
  const availableLeaves = [...leaves];
  const enabled = definitions.filter(item => availableLeaves.some(tool => tool.name === item.transportName));
  if (!enabled.length) return leaves;
  const registry = new CapabilityRegistry(enabled);
  const discovery = { type: "object", properties: {
    path: { type: "string", maxLength: 100 }, query: { type: "string", maxLength: 200 },
    offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 10 },
    revision: { type: "string", pattern: "^[a-f0-9]{64}$" },
  }, additionalProperties: false };
  const invocation = { type: "object", properties: {
    operation: { type: "string", maxLength: 100 }, version: { type: "integer", enum: [1] },
    arguments: { type: "object" },
  }, required: ["operation", "version", "arguments"], additionalProperties: false };
  const tools: ApiChatTool[] = [
    { name: "capabilities_list", description: "List authorized domain.object.operation capability paths. Discovery is not authorization. Paginate with revision/nextOffset; legacy aliases remain valid.",
      parameters: discovery, execute: async args => JSON.stringify(registry.discover(args)) },
    { name: "capabilities_search", description: "Find enabled capability operations by keywords. Returns up to 3 complete input schemas by default, maximum 10; do not rediscover unchanged versions.",
      parameters: discovery, execute: async args => JSON.stringify(registry.discover(args, true)) },
    { name: "capabilities_describe", description: "Read the exact enabled operation contract, permissions, version and legacy alias. No operation is executed.",
      parameters: { type: "object", properties: { operation: { type: "string", maxLength: 100 } }, required: ["operation"], additionalProperties: false },
      execute: async args => {
        validateCapabilityInput(args, { type: "object", properties: { operation: { type: "string", maxLength: 100 } }, required: ["operation"], additionalProperties: false });
        return JSON.stringify({ revision: registry.revision, ...registry.describe(String(args.operation)) });
      } },
    ...[true, false].filter(readOnly => enabled.some(item => item.readOnly === readOnly)).map(readOnly => ({
      name: readOnly ? "capability_read" : "capability_call",
      description: `${readOnly ? "Read-only" : "Mutating"} capability dispatch. First obtain its schema with capabilities_search/describe. Uses original permissions, approval, validation and audit; no authority overrides. Pin version:1. native.tool operations return original unmodified tool text; other operations return a versioned result envelope. Never blindly retry effects.`,
      parameters: invocation,
      execute: async (args: Record<string, unknown>, signal: AbortSignal) => {
        validateCapabilityInput(args, invocation);
        const definition = registry.describe(String(args.operation));
        if (definition.readOnly !== readOnly) throw new CapabilityError("ACCESS_DENIED", "Choose the matching read or mutation entry point.");
        if (signal.aborted) throw new CapabilityError("CANCELLED", "Request cancelled.");
        validateCapabilityInput(args.arguments, definition.inputSchema);
        const leaf = availableLeaves.find(tool => tool.name === definition.transportName)!;
        const text = await leaf.execute(args.arguments as Record<string, unknown>, signal);
        if (definition.id.startsWith("native.tool.")) return text;
        const result = JSON.parse(text);
        try { validateCapabilityInput(result, definition.outputSchema, "result"); }
        catch { throw new CapabilityError("INVALID_RESULT", "Leaf returned an invalid result; reconcile any committed effects before retrying."); }
        return JSON.stringify({ schema: "pkm.capability-result/v1", operation: definition.id, version: definition.version,
          catalogRevision: registry.revision, result });
      },
    })),
  ];
  return [...(compact ? leaves.filter(tool => !enabled.some(item => item.transportName === tool.name)) : leaves), ...tools];
}

function boundedToolContext(content: string | undefined): ApiChatMessage | undefined {
  if (content === undefined) return undefined;
  if (typeof content !== "string" || !content.trim() || content.length > 2000) throw new Error("Host tool-result context must contain 1-2000 characters.");
  return { role:"system", content };
}

export function chatToolResultContext(request: Pick<ApiChatRequest, "onToolResultContext">,
  event: ApiChatToolEvent): ApiChatMessage | undefined {
  return boundedToolContext(request.onToolResultContext?.(event));
}

export function chatToolBatchContext(request: Pick<ApiChatRequest, "onToolResultsContext">,
  events: readonly ApiChatToolEvent[]): ApiChatMessage | undefined {
  const callback = request.onToolResultsContext;
  if (!events.length || callback === undefined) return undefined;
  return boundedToolContext(callback(events));
}

export class ChatToolScheduler {
  private barrier: Promise<unknown> = Promise.resolve();
  private readers: Promise<unknown>[] = [];
  private all: Promise<unknown> = Promise.resolve();
  constructor(private readonly concurrency = 4) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("Choose tool concurrency from 1 to 16.");
  }
  schedule<T>(tool: ApiChatTool | undefined, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    const readOnly = tool?.execution === "parallel-read";
    const previous = readOnly ? this.barrier : Promise.all([this.barrier, ...this.readers]);
    const next = previous.then(() => {
      if (signal.aborted) throw new Error("Request cancelled.");
      return run();
    });
    const settled = next.then(() => undefined, () => undefined);
    this.all = Promise.all([this.all, settled]);
    if (readOnly) {
      this.readers.push(settled);
      if (this.readers.length >= this.concurrency) {
        this.barrier = Promise.all(this.readers); this.readers = [];
      }
    } else { this.barrier = settled; this.readers = []; }
    return next;
  }
  async drain(): Promise<void> { await this.all; }
}

export async function executeChatToolBatch(
  calls: NonNullable<ApiChatMessage["tool_calls"]>, request: Pick<ApiChatRequest, "tools" | "onTool" | "onToolResultContext" | "onToolResultsContext" | "afterTools">,
  messages: ApiChatMessage[], loop: ChatToolLoopGuard, signal: AbortSignal, round: number,
): Promise<void> {
  await loop.beforeRound(round, signal);
  const scheduler = new ChatToolScheduler();
  const completed: ApiChatMessage[] = [];
  const events: Parameters<NonNullable<ApiChatRequest["onToolResultContext"]>>[0][] = [];
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) controller.abort();
  const batchSignal = controller.signal;
  try {
  const outputs = await Promise.allSettled(calls.map(call => {
    const tool = request.tools?.find(item => item.name === call.function.name);
    const queuedAt = Date.now();
    return scheduler.schedule(tool, batchSignal, async () => {
      if (tool?.execution !== "parallel-read") await loop.beforeRound(round, batchSignal);
      const event = { id: call.id, name: tool?.label || call.function.name, arguments: call.function.arguments,
        queuedMs: Math.max(0, Date.now() - queuedAt), round };
      if (loop.summarizing || request.afterTools?.()) {
        const result = JSON.stringify({ error: "Not executed: the request has stopped; use completed results." });
        request.onTool?.({ ...event, status: "failed", result });
        return { role: "tool" as const, content: result, tool_call_id: call.id };
      }
      request.onTool?.({ ...event, status: "running" });
      let result: string, succeeded = false, reused = false;
      try {
        if (!tool) throw new Error("This tool is not enabled for the request.");
        const args: unknown = JSON.parse(call.function.arguments);
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be an object.");
        const version = await cancellable(Promise.resolve().then(() => tool.readVersion?.(args as Record<string, unknown>, batchSignal)), batchSignal);
        if (batchSignal.aborted) throw new Error("Request cancelled.");
        const prior = loop.reuse(tool.name, call.function.arguments, [...messages, ...completed], version);
        if (prior) {
          result = prior.result; reused = true;
          loop.record(tool, tool.name, call.function.arguments, prior.original);
        } else {
          result = await cancellable(tool.execute(args as Record<string, unknown>, batchSignal), batchSignal);
          if (typeof result !== "string" || result.length > 16_000) throw new Error("Tool result exceeded the local limit.");
          loop.remember(tool.name, call.function.arguments, call.id, result, true, version);
          loop.record(tool, tool.name, call.function.arguments, result, true);
        }
        succeeded = true;
      } catch (error) {
        if (batchSignal.aborted) throw new Error("Request cancelled.");
        result = JSON.stringify({ error: error instanceof Error ? error.message : "Tool failed." });
        loop.remember(call.function.name, call.function.arguments, call.id, result, false);
        loop.record(tool, call.function.name, call.function.arguments, result, false);
      }
      request.onTool?.({ ...event, status: succeeded ? "complete" : "failed", result, reused });
      events.push({ ...event, status:succeeded ? "complete" : "failed", result, reused });
      const output = { role: "tool" as const, content: result, tool_call_id: call.id };
      completed.push(output);
      return output;
    }).catch(error => { controller.abort(); throw error; });
  }));
  for (const output of outputs) if (output.status === "fulfilled") messages.push(output.value);
  const failed = outputs.find(output => output.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  if (request.onToolResultsContext !== undefined) {
    const successful = calls.map(call => events.find(event => event.id === call.id))
      .filter((event): event is ApiChatToolEvent => event?.status === "complete");
    const context = chatToolBatchContext(request, successful);
    if (context) messages.push(context);
  } else {
    for (const call of calls) {
      const event = events.find(event => event.id === call.id);
      if (event?.status === "complete") {
        const context = chatToolResultContext(request, event);
        if (context) messages.push(context);
      }
    }
  }
  } finally { signal.removeEventListener("abort", cancel); }
}

function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new Error("Request cancelled."));
    signal.addEventListener("abort", cancel, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    if (signal.aborted) cancel();
  });
}
