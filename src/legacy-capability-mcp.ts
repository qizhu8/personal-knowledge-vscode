import { z } from "zod";
import { randomUUID } from "node:crypto";
import { CapabilityError, CapabilityRegistry, todoCapabilities, validateCapabilityInput } from "./domain/legacy-mcp-registry.js";
import { externalMemoryCapabilities } from "./domain/legacy-mcp-memory-contract.js";
import type { Core } from "./core.js";
import type { Actor } from "./contracts.js";
import type { Storage } from "./storage.js";
import { authenticateBoardWorker } from "./boards.js";

export const legacyCapabilityRequest = z.strictObject({
  action: z.enum(["list", "search", "describe", "read", "call"]),
  args: z.record(z.string(), z.unknown()),
  workerToken: z.string().optional(),
});

export function createLegacyCapabilityDispatcher(core: Core, actor: Actor, storage: Storage,
  readOriginalTodoAgents?: (principal: Actor, arguments_: unknown) => Promise<unknown>,
  assignOriginalTodoChat?: (principal: Actor, arguments_: unknown) => Promise<Record<string, unknown> | undefined>) {
  const registry = new CapabilityRegistry([...todoCapabilities, ...externalMemoryCapabilities]
    .filter(operation => actor.canWrite || operation.readOnly));
  return async (request: z.infer<typeof legacyCapabilityRequest>) => {
    const args = request.args;
    const workerToken = request.workerToken;
    if (workerToken !== undefined && request.action !== "read" && request.action !== "call")
      throw new CapabilityError("INVALID_ARGUMENT", "Worker tokens require an exact Todo Board.");
    if (JSON.stringify(args).length > 64000)
      throw new CapabilityError("INVALID_ARGUMENT", "Provide a bounded capability request object.");
    if (request.action === "list" || request.action === "search")
      return registry.discover(args, request.action === "search");
    if (request.action === "describe") {
      validateCapabilityInput(args, { type: "object", properties: { operation: { type: "string", maxLength: 100 } },
        required: ["operation"], additionalProperties: false });
      return { ...registry.describe(String(args.operation)), catalogRevision: registry.revision };
    }
    validateCapabilityInput(args, { type: "object", properties: {
      operation: { type: "string", maxLength: 100 }, version: { type: "integer", enum: [1] },
      arguments: { type: "object" },
    }, required: ["operation", "version", "arguments"], additionalProperties: false });
    const operation = registry.describe(String(args.operation));
    if (operation.readOnly !== (request.action === "read"))
      throw new CapabilityError("ACCESS_DENIED", "Use the matching read or mutation entry point.");
    validateCapabilityInput(args.arguments, operation.inputSchema);
    let principal = actor;
    if (workerToken !== undefined) {
      const leaf = z.record(z.string(), z.unknown()).parse(args.arguments);
      if (!operation.id.startsWith("todo.") || typeof leaf.board_slug !== "string" || !leaf.board_slug)
        throw new CapabilityError("INVALID_ARGUMENT", "Worker tokens require an exact Todo Board.");
      const authority = await storage.withWorkspaceExclusive(() =>
        authenticateBoardWorker(storage.workspaceRoot(), String(leaf.board_slug), workerToken));
      principal = { ...actor, ...authority };
    }
    const input = !operation.readOnly && operation.id.startsWith("todo.")
      ? { ...args, arguments: { ...z.record(z.string(), z.unknown()).parse(args.arguments), operationId: randomUUID() } } : args;
    let value: unknown;
    if (operation.id === "todo.agent.list" && readOriginalTodoAgents) {
      value = await readOriginalTodoAgents(principal, args.arguments);
    } else {
      const assigned = operation.id === "todo.workitem.assign" && assignOriginalTodoChat
        ? await assignOriginalTodoChat(principal, input.arguments) : undefined;
      if (assigned !== undefined) value = assigned;
      else {
        const result = await core.dispatch(operation.readOnly ? "capability_read" : "capability_call", input, principal);
        if (result.error) throw new CapabilityError(result.error.code, result.error.message);
        value = result.result;
      }
    }
    try { validateCapabilityInput(value, operation.outputSchema, "result"); }
    catch {
      throw new CapabilityError("INVALID_RESULT", "Leaf returned a result outside its advertised contract. Reconcile any committed effects before retrying.");
    }
    return { schema: "pkm.capability-result/v1", operation: operation.id, version: operation.version,
      catalogRevision: registry.revision, result: value };
  };
}
