import { ModelProviderError, type ModelProviderService } from "./model-provider.js";
import type { ModelProviderTool } from "./model-provider-contracts.js";
import { randomUUID } from "node:crypto";
import { createApprovalBridge, type ApprovalBridgeOptions } from "./approval-bridge.js";
import { type ToolGateway, type ToolApprovalVerifier, type ToolGatewayResult, toolResultContent } from "./tool-gateway.js";
import { ChatTurnToolError, type ChatTurnModelPort, type ChatTurnToolPort } from "./chat-turn.js";
import { ChatTurnError } from "./chat-turn-store.js";
import { chatTurnMessageInput, type ChatTurnMessage } from "./chat-turn-contracts.js";
import type { MemoryContextResult } from "./memory-context-contracts.js";
import { estimateChatPromptTokens } from "./domain/chat-prompt-budget.js";

/** Assemble memory natively before start; this guard rechecks its exact initial prompt on every inference. */
export function createChatTurnMemoryAdmission(
  actor: string, turnId: string, context: MemoryContextResult,
) {
  if (context.status !== "ready") throw new ChatTurnError(`MEMORY_${context.status.toUpperCase().replaceAll("-", "_")}`);
  const messages = context.messages.map(message => chatTurnMessageInput.parse(message));
  const fingerprint = JSON.stringify(messages);
  return {
    messages: structuredClone(messages),
    admitPrompt(currentActor: string, currentTurnId: string, prompt: readonly ChatTurnMessage[]) {
      if (currentActor !== actor || currentTurnId !== turnId
        || JSON.stringify(prompt.slice(0, messages.length)) !== fingerprint)
        throw new ChatTurnError("MEMORY_PROMPT_MISMATCH");
      try { context.assertCurrent(); }
      catch { throw new ChatTurnError("MEMORY_CONTEXT_STALE"); }
    },
  };
}

/** The native host supplies an actor/turn-bound catalog; callers cannot install tools or providers. */
export function createChatTurnModelPort(
  provider: Pick<ModelProviderService, "available" | "stream"> & Partial<Pick<ModelProviderService, "preDispatchAdmission">>,
  options: {
    tools?: (actor: string, turnId: string) => Promise<ModelProviderTool[]>;
    profileId?: string; contextWindow?: number;
  } = {},
): ChatTurnModelPort {
  return {
    get available() { return provider.available; },
    get preDispatchAdmission() { return provider.preDispatchAdmission === true; },
    async *stream(request) {
      const tools = await options.tools?.(request.actor, request.turnId);
      if (request.signal.aborted) return;
      if (estimateChatPromptTokens(request.messages, tools) > request.maxInputTokens)
        throw new ChatTurnError("INPUT_TOKEN_LIMIT");
      try {
        for await (const event of provider.stream({
          messages: request.messages, maxOutputTokens: request.maxOutputTokens, signal: request.signal,
          ...(tools?.length ? { tools } : {}),
          ...(options.profileId ? { profileId: options.profileId } : {}),
          ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
        }, request.beforeDispatch)) {
          // Only public answer text is persisted; a provider's auxiliary reasoning is not an answer.
          if (event.type !== "reasoning-summary") yield event;
        }
      } catch (error) {
        if (error instanceof ModelProviderError)
          throw new ChatTurnError(`MODEL_${error.code.toUpperCase().replaceAll("-", "_")}`);
        throw new ChatTurnError("MODEL_DEPENDENCY_FAILED");
      }
    },
  };
}

export function modelToolSchema(value: Record<string, unknown>, root = true): Record<string, unknown> {
  const allowed = new Set(["type", "properties", "required", "additionalProperties", "items", "enum",
    "description", "title", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]);
  const descriptive = new Set(["$schema", "default", "format", "pattern"]);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (descriptive.has(key)) continue;
    // Zod emits multiple string patterns as allOf; the gateway retains every pattern.
    if (key === "allOf" && Array.isArray(entry) && entry.every(item => item && typeof item === "object"
      && Object.keys(item).every(name => ["pattern", "format"].includes(name)))) continue;
    if (!allowed.has(key)) throw new ChatTurnToolError("not-committed", "TOOL_SCHEMA_UNSUPPORTED");
    if (key === "properties") {
      result.properties = Object.fromEntries(Object.entries(entry as Record<string, Record<string, unknown>>)
        .filter(([name]) => !root || !["operationId", "operation_id"].includes(name))
        .map(([name, schema]) => [name, modelToolSchema(schema, false)]));
    } else if (key === "items") result.items = modelToolSchema(entry as Record<string, unknown>, false);
    else if (key === "required" && root) result.required = (entry as string[]).filter(name => !["operationId", "operation_id"].includes(name));
    else result[key] = entry;
  }
  if (typeof result.type !== "string") throw new ChatTurnToolError("not-committed", "TOOL_SCHEMA_UNSUPPORTED");
  return result;
}

/**
 * Native composition of real gateway and exact-record approval state. The host's
 * gateway factory fixes actor/workspace/turn/context and cannot be supplied by a caller.
 */
export function createChatTurnToolPort(options: {
  workspaceId: string;
  storage: ApprovalBridgeOptions["storage"];
  reviewer?: ApprovalBridgeOptions["reviewer"];
  gateway: (actor: string, turnId: string, verifier: ToolApprovalVerifier) => ToolGateway;
  timeoutMs?: number;
}) {
  const pending = new Map<string, { gateway: ToolGateway; name: string; readOnly: boolean }>();
  const bridge = createApprovalBridge({
    workspaceId: options.workspaceId, storage: options.storage,
    resultBytes: 131_072,
    ...(options.reviewer ? { reviewer: options.reviewer } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    async dispatch(request) {
      const invocation = pending.get(request.execution.id);
      if (!invocation) throw new ChatTurnToolError("not-committed", "NATIVE_INVOCATION_UNAVAILABLE");
      const result = await invocation.gateway.execute({
        name: invocation.name, arguments: request.execution.arguments,
        ...(!invocation.readOnly ? { operationId: request.operationId } : {}), approval: request.approval,
      }, { signal: request.signal });
      if (result.status !== "complete") {
        if (result.status === "failed" && result.error?.code === "OUTPUT_LIMIT"
          && (result.effect === "committed" || result.effect === "not-committed"))
          return { status: result.effect === "committed" ? "succeeded" : "failed", result };
        if (result.effect === "unknown" || result.effect === "committed")
          throw new ChatTurnToolError(result.effect, "TOOL_OUTCOME_UNKNOWN");
        return { status: "failed", result };
      }
      return { status: "succeeded", result };
    },
  });
  const gateway = (actor: string, turnId: string) => options.gateway(actor, turnId, bridge.native.verifyApproval);
  const catalog = async (value: ToolGateway) => {
    const items = [];
    let offset = 0;
    for (let count = 0; count < 103; count++) {
      const page = await value.discover({ offset, limit: 10 });
      items.push(...page.items);
      if (page.nextOffset === null) return items;
      offset = page.nextOffset;
    }
    throw new ChatTurnToolError("not-committed", "TOOL_CATALOG_LIMIT");
  };
  const tools: ChatTurnToolPort = {
    available: true,
    async execute(request) {
      let dispatched = false;
      try {
      if (request.signal.aborted) throw new ChatTurnToolError("not-committed", "CANCELLED");
      const value = gateway(request.actor, request.turnId);
      const descriptor = (await catalog(value)).find(item => item.name === request.call.name);
      // Original Chat reports a tool that is not enabled back to the model; nothing was authorized or dispatched.
      if (!descriptor) return { executionId: `unavailable-${request.operationId}`,
        content: JSON.stringify({ error: "This tool is not enabled for the request." }), resultStatus: "failed" as const };
      const binding = value.prepare({
        name: request.call.name, arguments: request.call.arguments,
        ...(!descriptor.readOnly ? { operationId: request.operationId } : {}),
      });
      let execution = bridge.native.create(request.actor, {
        tool: binding.operation, arguments: { ...binding.arguments }, approvalRequired: descriptor.approvalRequired,
        operationId: request.operationId,
        context: { turnId: binding.turnId, contextDigest: binding.contextDigest, readOnly: binding.readOnly },
      });
      if (descriptor.approvalRequired) {
        const approval = bridge.public.request(request.actor, {
          executionId: execution.id, expectedRevision: execution.revision, operationId: randomUUID(),
        });
        request.onApproval({ executionId: execution.id, status: "pending" });
        const cancelReview = () => {
          const current = bridge.public.get(request.actor, approval.id);
          if (current.status === "pending") bridge.public.cancel(request.actor, {
            id: current.id, expectedRevision: current.revision, operationId: randomUUID(),
          });
        };
        request.signal.addEventListener("abort", cancelReview, { once: true });
        let decision;
        try {
          if (request.signal.aborted) cancelReview();
          decision = await bridge.native.review(request.actor, approval.id);
        } catch {
          throw new ChatTurnToolError("not-committed", "APPROVAL_UNAVAILABLE");
        } finally { request.signal.removeEventListener("abort", cancelReview); }
        if (decision.status !== "approved" || decision.resolvedExecutionRevision === null) {
          request.onApproval({ executionId: execution.id, status: "denied" });
          throw new ChatTurnToolError("not-committed", "APPROVAL_DENIED");
        }
        request.onApproval({ executionId: execution.id, status: "approved" });
        execution = { ...execution, revision: decision.resolvedExecutionRevision };
      }
      if (request.signal.aborted) throw new ChatTurnToolError("not-committed", "CANCELLED");
      pending.set(execution.id, { gateway: value, name: descriptor.name, readOnly: descriptor.readOnly });
      try {
        dispatched = true;
        const observed = await bridge.native.execute(request.actor, {
          executionId: execution.id, expectedRevision: execution.revision, operationId: request.operationId,
        }, { signal: request.signal });
        const result = observed.result as ToolGatewayResult | undefined;
        if (result?.schema === "pkm.tool-result/v1" && result.status === "failed"
          && result.error?.code === "OUTPUT_LIMIT"
          && ((observed.execution.status === "succeeded" && result.effect === "committed")
            || (observed.execution.status === "failed" && result.effect === "not-committed")))
          return { executionId: execution.id, content: JSON.stringify({ error: "Tool result exceeded the local limit." }),
            resultStatus: "failed" as const };
        if (observed.execution.status === "failed" && result?.schema === "pkm.tool-result/v1"
          && result.status === "failed" && result.effect === "not-committed" && result.error)
          return { executionId: execution.id, content: toolResultContent(result), resultStatus: "failed" as const };
        if (observed.execution.status !== "succeeded")
          throw new ChatTurnToolError(observed.execution.status === "unknown" ? "unknown" : "not-committed", "TOOL_FAILED");
        if (!result || result.schema !== "pkm.tool-result/v1" || result.status !== "complete")
          throw new ChatTurnToolError("unknown", "INVALID_TOOL_RESULT");
        return { executionId: execution.id, content: toolResultContent(result) };
      } finally { pending.delete(execution.id); }
      } catch (error) {
        if (error instanceof ChatTurnToolError) throw error;
        throw new ChatTurnToolError(dispatched ? "unknown" : "not-committed",
          dispatched ? "TOOL_OUTCOME_UNKNOWN" : "TOOL_ADMISSION_FAILED");
      }
    },
  };
  return {
    tools,
    async modelTools(actor: string, turnId: string): Promise<ModelProviderTool[]> {
      const items = await catalog(gateway(actor, turnId));
      if (items.length > 16) throw new ChatTurnToolError("not-committed", "TOOL_CATALOG_LIMIT");
      return items.map(item => ({
        name: item.name, description: item.description, parameters: modelToolSchema(item.parameters),
      }));
    },
    approvals: bridge.public,
    /** Native startup only, before serving traffic. Does not dispatch. */
    recover: bridge.native.recover,
  };
}
