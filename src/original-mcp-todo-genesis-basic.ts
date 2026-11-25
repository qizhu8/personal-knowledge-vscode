import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CoreError, type Actor } from "./contracts.js";
import { RootOwner, assertRootOwner } from "./root-owner.js";
import { originalMcpPublicRequestActive, assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { originalMcpTodoGenesisArgumentsSchema } from "./original-mcp-todo-genesis-contracts.js";
import { getOriginalMcpTodoGenesisPort, withOriginalMcpTodoGenesisContext,
  withApprovedOriginalMcpTodoGenesis, activateOriginalMcpTodoGenesisSource } from "./original-mcp-todo-genesis-native.js";
import { prepareOriginalMcpTodoGenesis } from "./original-mcp-todo-genesis.js";
import { experimentalTodoGenesisFaultError } from "./original-mcp-todo-genesis-fault.js";
import { todoDefinitions } from "./todo-definitions.js";

export async function dispatchOriginalMcpTodoGenesis(owner: RootOwner, host: OriginalMcpNativeHost,
  actor: Readonly<Actor>, arguments_: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
  assertRootOwner(owner);
  const { storage, runtime } = await owner.ensureFull();
  assertOriginalMcpNativeHost(host, storage);
  if (actor.id !== "mcp:external" || !actor.canWrite || actor.boardWorker
    || !originalMcpPublicRequestActive(storage, "todo_board_create", arguments_))
    throw new CoreError("ACCESS_DENIED", "Todo genesis requires its exact authenticated PUBLIC creation request.");
  const port = getOriginalMcpTodoGenesisPort(storage, host);
  if (!port) throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "The current signed Todo genesis producer is required.");
  const args = originalMcpTodoGenesisArgumentsSchema.parse(arguments_);
  const plan = await prepareOriginalMcpTodoGenesis(storage, host, args, randomUUID());
  return withOriginalMcpTodoGenesisContext(port, arguments_, () => withApprovedOriginalMcpTodoGenesis(storage, plan, async () => {
    const reply = await runtime.core.dispatch("capability_call", { operation: "todo.board.create", version: 1,
      arguments: { board_slug: plan.request.selection.boardSlug, operationId: plan.request.operationId } }, actor);
    if (reply.error) throw experimentalTodoGenesisFaultError(storage, plan, reply.error)
      ?? new CoreError(reply.error.code, reply.error.message, reply.error.effect);
    todoDefinitions.find(item => item.id === "todo.board.create")!.output.parse(reply.result);
    const result = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/) }).parse(reply.result);
    if (result.digest !== plan.request.selection.backingSha256)
      throw new CoreError("RECOVERY_CONFLICT", "Todo genesis result differs from its exact publication.", "unknown");
    let enrollmentStage = "exact-source-owner-control";
    try {
      await activateOriginalMcpTodoGenesisSource(storage, plan);
      enrollmentStage = "same-core-note-workitems-bridge";
      await runtime.enrollOriginalMcpTodoNoteGenesis(host, plan.request.selection.boardSlug);
    } catch (cause) {
      const code = cause instanceof Error && "code" in cause && typeof cause.code === "string" ? cause.code : "UNKNOWN";
      console.error("PKM Todo genesis source enrollment failed:", { stage: enrollmentStage, code });
      const error = new CoreError("RECOVERY_AUTHORITY_REQUIRED", "Todo genesis is durable but current source enrollment requires reconciliation.", "unknown");
      error.cause = cause;
      throw error;
    }
    return { ok: true, slug: plan.request.selection.boardSlug, items: [], digest: result.digest };
  }), signal);
}
