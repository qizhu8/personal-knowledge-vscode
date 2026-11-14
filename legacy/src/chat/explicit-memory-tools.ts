import type { ApiChatTool } from "./api-chat-client";
import type { ExplicitMemoryHostDecisionRequest, ExplicitMemoryHostAuthorizer, ExplicitMemoryRecord } from "../memory/explicit-memory-service";
import type { ExplicitMemoryScope } from "../memory/explicit-memory-service";
import type { MemoryEngineClientOptions } from "../memory/memory-engine-client";
import { memoryCapabilities } from "../capabilities/memory-contract";
import { executeMemoryOperation } from "../capabilities/memory-operations";
import { CapabilityError, validateCapabilityInput } from "../capabilities/registry";

export function createExplicitMemoryTools(options: {
  enabled: string[];
  context: () => { options: MemoryEngineClientOptions; root: string };
  assertActive: () => void;
  approve: (write: boolean, operation: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<boolean>;
  authorize: (request: Parameters<ExplicitMemoryHostAuthorizer>[0], signal: AbortSignal) => ReturnType<ExplicitMemoryHostAuthorizer>;
}): ApiChatTool[] {
  return memoryCapabilities.filter(operation => options.enabled.includes(operation.transportName)).map(operation => ({
    name: operation.transportName, description: operation.description, parameters: operation.inputSchema,
    execute: async (args, signal) => {
      options.assertActive();
      if (signal.aborted) throw new Error("Request cancelled.");
      validateCapabilityInput(args, operation.inputSchema);
      if (!await options.approve(!operation.readOnly, operation.transportName, args, signal)) throw new Error("Memory access declined.");
      options.assertActive();
      if (signal.aborted) throw new Error("Request cancelled.");
      const context = options.context();
      const result = await executeMemoryOperation(context.options, context.root, operation.transportName, args, async request => {
        const decision = await options.authorize(request, signal);
        options.assertActive();
        if (signal.aborted) throw new Error("Memory decision cancelled; no mutation was authorized.");
        return decision;
      });
      return JSON.stringify(result);
    },
  }));
}

function scopeLines(scope: ExplicitMemoryScope): string[] {
  return [
    `Account: ${scope.account}`,
    `Project scope: ${scope.project}`,
    `Repository scope: ${scope.repository}`,
  ];
}

function sourceLines(sources: unknown): string[] {
  if (sources === undefined) return ["Sources: none recorded."];
  if (!Array.isArray(sources)) throw new CapabilityError("INVALID_ARGUMENT", "Provide exact source references.");
  if (!sources.length) return ["Sources: none recorded."];
  return ["Sources:", ...sources.flatMap((source: unknown, index) => {
    if (!source || typeof source !== "object" || !("id" in source) || typeof source.id !== "string"
      || !("chat" in source) || typeof source.chat !== "string" || !("revision" in source) || typeof source.revision !== "string"
      || !("locator" in source) || typeof source.locator !== "string") {
      throw new CapabilityError("INVALID_ARGUMENT", "Provide exact source references.");
    }
    return [`  ${index + 1}. Source ID: ${source.id}`,
      `     Chat: ${source.chat}`,
      `     Source revision: ${source.revision}`,
      `     Locator: ${source.locator}`,
    ];
  })];
}

function operationIdLine(args: Record<string, unknown>): string[] {
  return typeof args.operation_id === "string" ? [`Operation ID (idempotency): ${args.operation_id}`] : [];
}

/** Human-readable first permission prompt. Only describes fields actually supplied by the caller. */
export function formatExplicitMemoryPermission(operation: string, args: Record<string, unknown>, scope: ExplicitMemoryScope): string {
  const lines = [
    operation === "memory_record_propose" ? "Action: Propose a new long-term Memory record." :
      `Action: Request to ${operation.replace(/^memory_record_/, "")} an existing Memory record.`,
    ...scopeLines(scope),
    ...operationIdLine(args),
  ];
  if (operation === "memory_record_propose") {
    lines.push("Record ID: not assigned yet.", "After a successful proposal, the record starts pending and is not active recall.");
    if (typeof args.content === "string") lines.push("Content to store:", args.content);
    lines.push(...sourceLines(args.sources));
  } else {
    if (typeof args.id === "string") lines.push(`Record ID: ${args.id}`);
    if (typeof args.expected_revision === "number") lines.push(`Expected revision: ${args.expected_revision}`);
    lines.push("A separate exact-record review will show the current state and the requested change before any mutation.");
  }
  return lines.join("\n");
}

/** Exact local review shown immediately before a Host-authorized Memory mutation. */
export function formatExplicitMemoryDecision(request: ExplicitMemoryHostDecisionRequest, current: ExplicitMemoryRecord): string {
  const actionText = {
    confirm: "Confirm this Memory record revision",
    revise: "Replace this Memory record with a new revision",
    revoke: "Revoke this Memory record",
  }[request.action];
  const lines = [
    `Action: ${actionText}.`,
    `Record ID: ${request.recordId}`,
    `Expected revision: ${request.expectedRevision}`,
    `Current record revision: ${current.current_revision}`,
    `Current revision status: ${current.status}`,
    `Current record status: ${current.current_status}`,
    ...scopeLines(request.scope),
    `Decision actor on approval: local user (user:local)`,
    `Operation ID (idempotency): ${request.operationId}`,
  ];
  if (request.action === "confirm") {
    lines.push("Current content:", current.content, ...sourceLines(current.sources));
    lines.push("Effect: mark this revision confirmed and eligible for future active Memory search.");
  } else if (request.action === "revise") {
    lines.push("Current content (before):", current.content, "Proposed content (after):", request.content ?? "Not provided.");
    lines.push("Current sources (before):", ...sourceLines(current.sources));
    lines.push("Proposed sources (after):", ...sourceLines(request.sources));
    lines.push("Effect: create a new pending revision; prior confirmation does not carry forward.");
  } else {
    lines.push("Content being revoked:", current.content, ...sourceLines(current.sources));
    lines.push("Effect: exclude this record from future active Memory search. The record is not deleted.");
  }
  return lines.join("\n");
}
