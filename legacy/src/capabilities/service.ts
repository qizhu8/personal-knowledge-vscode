import { callTodoApi } from "../knowledge/todo-api";
import { CapabilityError, CapabilityRegistry, todoCapabilities, validateCapabilityInput } from "./registry";
import { externalMemoryCapabilities } from "./memory-contract";
import { executeMemoryOperation } from "./memory-operations";
import type { MemoryEngineClientOptions } from "../memory/memory-engine-client";

export async function callCapabilityService(
  action: unknown, input: unknown, actorId: string, memory?: { options: MemoryEngineClientOptions; root: string },
): Promise<Record<string, unknown>> {
  const registry = new CapabilityRegistry([...todoCapabilities, ...(memory ? externalMemoryCapabilities : [])]);
  if (!input || typeof input !== "object" || Array.isArray(input) || JSON.stringify(input).length > 64000) {
    throw new CapabilityError("INVALID_ARGUMENT", "Provide a bounded capability request object.");
  }
  const args = input as Record<string, unknown>;
  if (action === "list" || action === "search") return registry.discover(args, action === "search");
  if (action === "describe") {
    validateCapabilityInput(args, { type: "object", properties: { operation: { type: "string", maxLength: 100 } }, required: ["operation"], additionalProperties: false });
    return { ...registry.describe(String(args.operation)), catalogRevision: registry.revision };
  }
  if (action !== "read" && action !== "call") throw new CapabilityError("NOT_AVAILABLE", "Unknown capability entry point.");
  validateCapabilityInput(args, { type: "object", properties: {
    operation: { type: "string", maxLength: 100 }, version: { type: "integer", enum: [1] }, arguments: { type: "object" },
  }, required: ["operation", "version", "arguments"], additionalProperties: false });
  const operation = registry.describe(String(args.operation));
  if (operation.readOnly !== (action === "read")) throw new CapabilityError("ACCESS_DENIED", "Use the matching read or mutation entry point.");
  validateCapabilityInput(args.arguments, operation.inputSchema);
  const result = operation.id.startsWith("memory.")
    ? await executeMemoryOperation(memory!.options, memory!.root, operation.transportName, args.arguments as Record<string, unknown>)
    : callTodoApi(operation.transportName, args.arguments, actorId);
  try { validateCapabilityInput(result, operation.outputSchema, "result"); }
  catch { throw new CapabilityError("INVALID_RESULT", "Leaf returned a result outside its advertised contract. Reconcile any committed effects before retrying."); }
  return { schema: "pkm.capability-result/v1", operation: operation.id, version: operation.version,
    catalogRevision: registry.revision, result };
}
