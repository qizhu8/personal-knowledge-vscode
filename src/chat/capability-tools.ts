import type { ApiChatTool } from "./api-chat-client";
import { CapabilityError, CapabilityRegistry, type Capability, validateCapabilityInput } from "../capabilities/registry";

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
      description: `${readOnly ? "Read-only" : "Mutating"} capability dispatch. First obtain its schema with capabilities_search/describe. Uses the exact leaf's existing permissions, target-specific approval, validation, CAS and audit; no authority overrides. Pin version:1. Cancellation cannot undo committed effects.`,
      parameters: invocation,
      execute: async (args: Record<string, unknown>, signal: AbortSignal) => {
        validateCapabilityInput(args, invocation);
        const definition = registry.describe(String(args.operation));
        if (definition.readOnly !== readOnly) throw new CapabilityError("ACCESS_DENIED", "Choose the matching read or mutation entry point.");
        if (signal.aborted) throw new CapabilityError("CANCELLED", "Request cancelled.");
        validateCapabilityInput(args.arguments, definition.inputSchema);
        const leaf = availableLeaves.find(tool => tool.name === definition.transportName)!;
        const result = JSON.parse(await leaf.execute(args.arguments as Record<string, unknown>, signal));
        try { validateCapabilityInput(result, definition.outputSchema, "result"); }
        catch { throw new CapabilityError("INVALID_RESULT", "Leaf returned an invalid result; reconcile any committed effects before retrying."); }
        return JSON.stringify({ schema: "pkm.capability-result/v1", operation: definition.id, version: definition.version,
          catalogRevision: registry.revision, result });
      },
    })),
  ];
  return [...(compact ? leaves.filter(tool => !enabled.some(item => item.transportName === tool.name)) : leaves), ...tools];
}
