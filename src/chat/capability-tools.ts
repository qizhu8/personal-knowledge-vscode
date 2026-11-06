import type { ApiChatTool, ApiChatToolEvent } from "./api-chat-client";
import { createHash } from "crypto";
import { CapabilityError, CapabilityRegistry, type Capability, validateCapabilityInput } from "../capabilities/registry";

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
