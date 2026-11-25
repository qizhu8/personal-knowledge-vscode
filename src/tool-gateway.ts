import { z } from "zod";
import { CoreError, definitions, type Actor } from "./contracts.js";
import {
  CHAT_TOOL_GATEWAY_OUTPUT_BYTES, TOOL_GATEWAY_LIMITS, toolGatewayContext, toolGatewayDiscovery, toolGatewayRequest,
  type ToolApprovalBinding, type ToolGatewayOptions, type ToolGatewayResult,
} from "./tool-gateway-contracts.js";
import {
  freezeToolJson, redactToolOutput, toolArgumentsDigest, toolCanonicalJson, toolCatalogDigest, validateToolCatalogPage,
} from "./domain/tool-gateway-projection.js";
import { managedChatTaskToolAllowed } from "./managed-chat-task-scope.js";
export { toolApprovalDigest, toolArgumentsDigest, toolCanonicalJson, toolResultContent } from "./domain/tool-gateway-projection.js";
export type {
  ToolGatewayOptions, ToolGatewayResult, ToolApprovalBinding, ToolApprovalVerifier, ToolGatewayBinding,
} from "./tool-gateway-contracts.js";
export { TOOL_GATEWAY_LIMITS } from "./tool-gateway-contracts.js";

const unavailable = new Set([
  "memory.record.confirm", "memory.record.revise", "memory.record.revoke",
  "knowledge.folder.lifecycle.preview", "knowledge.folder.move", "sync.apply.preview", "sync.apply",
  "knowledge.folder.lifecycle.promote-preview", "knowledge.folder.promote-delete",
  "retrieval.runtime.availability", "retrieval.runtime.search", "retrieval.runtime.stage",
  "retrieval.runtime.qualify", "retrieval.runtime.activate", "subscription.materialize.apply",
]);
const nativeControl = (operation: string) => operation.startsWith("chat.turn.")
  || operation.startsWith("workflow.executor.") || operation.startsWith("agent.runtime.");
const definitionFor = (operation: string) => definitions.find(item => item.id === operation);
type Definition = typeof definitions[number];
interface Installed {
  name: string; operation: string; approvalRequired: boolean; definition: Definition;
}
const messages: Record<string, string> = {
  ACCESS_DENIED: "Tool access denied.", APPROVAL_REQUIRED: "Exact current native approval is required.",
  CANCELLED: "Tool invocation cancelled.", DEADLINE_EXCEEDED: "Tool invocation deadline exceeded.",
  STEP_LIMIT: "Tool invocation limit exceeded.", CONFLICT: "Tool request is stale or conflicts with an earlier invocation.",
  NOT_AVAILABLE: "Tool is not enabled for this request.", INVALID_ARGUMENT: "Invalid tool arguments.",
  INVALID_RESULT: "Tool returned an invalid result.", OUTPUT_LIMIT: "Tool output exceeded the local limit.",
  EXECUTION_FAILED: "Tool execution failed.", OUTCOME_UNKNOWN: "Tool side-effect outcome is unknown; reconcile without automatic retry.",
};
function boundedLimit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new CoreError("INVALID_ARGUMENT", "Invalid tool limit.");
  return value;
}

/** Per-turn native gateway. Catalog discovery is descriptive; Core authorizes every dispatch. */
export class ToolGateway {
  readonly available = true;
  readonly revision: string;
  private readonly actor: Actor;
  private readonly context: ToolGatewayOptions["context"];
  private readonly installed: readonly Installed[];
  private readonly calls: number;
  private readonly callTimeoutMs: number;
  private readonly outputBytes: number;
  private readonly deadline: number;
  private count = 0;
  private readonly mutations = new Map<string, string>();
  private readonly usedOperations = new Set<string>();
  private readonly outstanding = new Set<Promise<unknown>>();
  private readonly dispatcher: ToolGatewayOptions["dispatcher"];
  private readonly authorize: ToolGatewayOptions["authorize"];
  private readonly verifyApproval: ToolGatewayOptions["verifyApproval"];

  constructor(options: ToolGatewayOptions) {
    if (!options.actor?.id || typeof options.actor.canWrite !== "boolean") throw new CoreError("ACCESS_DENIED", "Authenticated actor required.");
    this.actor = Object.freeze({ ...options.actor });
    this.context = Object.freeze(toolGatewayContext.parse(options.context));
    this.dispatcher = options.dispatcher;
    this.authorize = options.authorize;
    this.verifyApproval = options.verifyApproval;
    this.calls = boundedLimit(options.limits?.calls, TOOL_GATEWAY_LIMITS.calls);
    this.callTimeoutMs = boundedLimit(options.limits?.callTimeoutMs, TOOL_GATEWAY_LIMITS.callTimeoutMs);
    this.outputBytes = options.limits?.outputBytes === undefined ? TOOL_GATEWAY_LIMITS.outputBytes
      : boundedLimit(options.limits.outputBytes, options.legacyChatOutput === true
        ? CHAT_TOOL_GATEWAY_OUTPUT_BYTES : TOOL_GATEWAY_LIMITS.outputBytes);
    this.deadline = Date.now() + boundedLimit(options.limits?.turnTimeoutMs, TOOL_GATEWAY_LIMITS.turnTimeoutMs);
    const catalog = options.catalog ?? definitions.filter(item => !("nativeOnly" in item && item.nativeOnly)
      && !unavailable.has(item.id) && !nativeControl(item.id))
      .map(item => ({ name: item.id, operation: item.id, approvalRequired: !item.readOnly }));
    if (catalog.length > 1024 || new Set(catalog.map(item => item.name)).size !== catalog.length)
      throw new CoreError("INVALID_ARGUMENT", "Invalid trusted tool catalog.");
    this.installed = catalog.map(binding => {
      const definition = definitionFor(binding.operation);
      if (!definition || unavailable.has(binding.operation) || nativeControl(binding.operation)
        || ("nativeOnly" in definition && definition.nativeOnly
          && !managedChatTaskToolAllowed(binding.operation, this.actor.id, this.context))
        || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,199}$/.test(binding.name))
        throw new CoreError("NOT_AVAILABLE", "Only registered Core tools with their actual native scope can be bound.");
      // Mutations always require exact native approval, even when a binding says otherwise.
      return Object.freeze({ name: binding.name, operation: binding.operation,
        approvalRequired: !definition.readOnly || binding.approvalRequired === true, definition });
    });
    this.revision = toolCatalogDigest(this.installed.map(item => this.describe(item)));
  }

  private describe(item: Installed) {
    return {
      name: item.name, operation: item.operation, version: 1 as const,
      description: item.definition.description,
      parameters: z.toJSONSchema(item.definition.input, { io: "input" }),
      readOnly: item.definition.readOnly,
      execution: item.definition.readOnly ? "parallel-read" as const : "exclusive" as const,
      approvalRequired: item.approvalRequired,
    };
  }

  async discover(input: unknown = {}) {
    const parsed = toolGatewayDiscovery.safeParse(input);
    if (!parsed.success) throw new CoreError("INVALID_ARGUMENT", messages.INVALID_ARGUMENT);
    const args = parsed.data;
    if (args.revision && args.revision !== this.revision) throw new CoreError("CONFLICT", messages.CONFLICT);
    const words = args.query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = this.installed.filter(item => (this.actor.canWrite || item.definition.readOnly)
      && words.every(word => `${item.name} ${item.operation} ${item.definition.description}`.toLowerCase().includes(word)));
    const items = matches.slice(args.offset, args.offset + args.limit).map(item => this.describe(item));
    const next = args.offset + items.length;
    return validateToolCatalogPage({ schema: "pkm.tool-catalog/v1" as const, revision: this.revision, items,
      total: matches.length, nextOffset: next < matches.length ? next : null });
  }

  /** Normalize before exact-record review; this projection conveys no execution authority. */
  prepare(input: unknown): ToolApprovalBinding {
    return this.prepareRequest(input).binding;
  }

  private prepareRequest(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new CoreError("INVALID_ARGUMENT", messages.INVALID_ARGUMENT);
    const raw = input as Record<string, unknown>;
    const canonical = toolCanonicalJson(raw.arguments);
    if (Buffer.byteLength(canonical) > TOOL_GATEWAY_LIMITS.argumentBytes) throw new CoreError("INVALID_ARGUMENT", messages.INVALID_ARGUMENT);
    const parsed = toolGatewayRequest.safeParse({ ...raw, arguments: JSON.parse(canonical) });
    if (!parsed.success) throw new CoreError("INVALID_ARGUMENT", messages.INVALID_ARGUMENT);
    const request = parsed.data;
    const item = this.installed.find(entry => entry.name === request.name);
    if (!item) throw new CoreError("NOT_AVAILABLE", messages.NOT_AVAILABLE);
    const readOnly = item.definition.readOnly;
    if (!readOnly && !this.actor.canWrite) throw new CoreError("ACCESS_DENIED", messages.ACCESS_DENIED);
    const candidate = { ...request.arguments };
    if (readOnly && request.operationId !== undefined) throw new CoreError("INVALID_ARGUMENT", messages.INVALID_ARGUMENT);
    if (!readOnly) {
      if (!request.operationId) throw new CoreError("INVALID_ARGUMENT", messages.INVALID_ARGUMENT);
      const shape = z.toJSONSchema(item.definition.input, { io: "input" }).properties ?? {};
      const field = "operationId" in shape ? "operationId" : "operation_id" in shape ? "operation_id" : undefined;
      if (!field) throw new CoreError("NOT_AVAILABLE", messages.NOT_AVAILABLE);
      if (candidate[field] !== undefined && candidate[field] !== request.operationId) throw new CoreError("CONFLICT", messages.CONFLICT);
      candidate[field] = request.operationId;
    }
    const validated = item.definition.input.safeParse(candidate);
    if (!validated.success) throw new CoreError("INVALID_ARGUMENT", messages.INVALID_ARGUMENT);
    const args = freezeToolJson(JSON.parse(toolCanonicalJson(validated.data)) as Record<string, unknown>);
    const binding: ToolApprovalBinding = freezeToolJson({
      operation: item.operation, version: 1, arguments: args, argumentsDigest: toolArgumentsDigest(args),
      ...(request.operationId ? { operationId: request.operationId } : {}),
      actorId: this.actor.id, ...this.context, readOnly,
    });
    return { request, item, binding };
  }

  activity() { return this.outstanding.size; }
  async retired() { await Promise.allSettled([...this.outstanding]); }

  async execute(input: unknown, options: { signal: AbortSignal }): Promise<ToolGatewayResult> {
    let name = "unavailable", operation = "unavailable";
    let readOnly = false, started = false, committed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const cancel = () => controller.abort(new CoreError("CANCELLED", messages.CANCELLED));
    const stop = () => controller.abort(new CoreError("DEADLINE_EXCEEDED", messages.DEADLINE_EXCEEDED));
    const signal = controller.signal;
    const check = () => {
      if (signal.aborted) throw signal.reason;
      if (Date.now() >= this.deadline) throw new CoreError("DEADLINE_EXCEEDED", messages.DEADLINE_EXCEEDED);
    };
    const wait = async <T>(work: () => Promise<T>): Promise<T> => {
      check();
      return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        const pending = Promise.resolve().then(() => { check(); return work(); });
        this.outstanding.add(pending);
        void pending.then(() => this.outstanding.delete(pending), () => this.outstanding.delete(pending));
        pending.then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
      });
    };
    options.signal.addEventListener("abort", cancel, { once: true });
    if (options.signal.aborted) cancel();
    try {
      check();
      if (++this.count > this.calls) throw new CoreError("STEP_LIMIT", messages.STEP_LIMIT);
      const { request, item, binding } = this.prepareRequest(input);
      name = request.name;
      operation = item.operation;
      readOnly = item.definition.readOnly;
      const args = binding.arguments;
      if (request.operationId) {
        const digest = toolArgumentsDigest(binding);
        const prior = this.mutations.get(request.operationId);
        if (prior && prior !== digest) throw new CoreError("CONFLICT", messages.CONFLICT);
        this.mutations.set(request.operationId, digest);
        if (this.usedOperations.has(request.operationId)) throw new CoreError("CONFLICT", messages.CONFLICT);
      }
      timer = setTimeout(stop, Math.min(this.callTimeoutMs, Math.max(1, this.deadline - Date.now())));
      if (this.authorize && !await wait(() => this.authorize!(binding, signal))) throw new CoreError("ACCESS_DENIED", messages.ACCESS_DENIED);
      if (item.approvalRequired && (!this.verifyApproval
        || !await wait(() => this.verifyApproval!(binding, request.approval, signal))))
        throw new CoreError("APPROVAL_REQUIRED", messages.APPROVAL_REQUIRED);
      check();
      const envelope = await wait(() => {
        check();
        started = true;
        if (request.operationId) this.usedOperations.add(request.operationId);
        return this.dispatcher.dispatch(readOnly ? "capability_read" : "capability_call",
          { operation, version: 1, arguments: args }, this.actor);
      });
      const failure = z.strictObject({
        schema: z.literal("pkm.next-result/v1"), requestId: z.string(),
        error: z.strictObject({
          code: z.string(), message: z.string(), effect: z.enum(["not-committed", "unknown"]),
        }),
      }).safeParse(envelope);
      if (failure.success) throw new CoreError(failure.data.error.code, "", failure.data.error.effect);
      const response = z.strictObject({
        schema: z.literal("pkm.next-result/v1"), requestId: z.string(), result: z.unknown(),
        operation: z.literal(operation).optional(), version: z.literal(1).optional(),
        catalogRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      }).safeParse(envelope);
      if (!response.success) throw new CoreError("INVALID_RESULT", messages.INVALID_RESULT, readOnly ? "not-committed" : "unknown");
      committed = !readOnly;
      const output = item.definition.output.safeParse(response.data.result);
      if (!output.success) throw new CoreError("INVALID_RESULT", messages.INVALID_RESULT);
      const result = redactToolOutput(JSON.parse(toolCanonicalJson(output.data)));
      if (Buffer.byteLength(JSON.stringify(result)) > this.outputBytes) throw new CoreError("OUTPUT_LIMIT", messages.OUTPUT_LIMIT);
      return { schema: "pkm.tool-result/v1", name, operation, version: 1, status: "complete",
        effect: committed ? "committed" : "not-committed", retry: readOnly ? "read-only" : "never", result };
    } catch (error) {
      const code = error instanceof CoreError && messages[error.code] ? error.code : "EXECUTION_FAILED";
      const uncertain = error instanceof CoreError && error.effect === "unknown"
        || started && !readOnly && !committed && (signal.aborted || !(error instanceof CoreError));
      return { schema: "pkm.tool-result/v1", name, operation, version: 1,
        status: uncertain ? "unknown" : code === "CANCELLED" ? "cancelled" : "failed",
        effect: uncertain ? "unknown" : committed ? "committed" : "not-committed",
        retry: readOnly && !uncertain ? "read-only" : "never",
        error: { code: uncertain ? "OUTCOME_UNKNOWN" : code, message: messages[uncertain ? "OUTCOME_UNKNOWN" : code] } };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal.removeEventListener("abort", cancel);
    }
  }
}
