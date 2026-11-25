import { randomUUID } from "node:crypto";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { z } from "zod";
import { CoreError, type Actor } from "./contracts.js";
import { RootOwner, assertRootOwner } from "./root-owner.js";
import { assertOriginalMcpNativeHost, originalMcpPublicRequestActive, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { originalPublicMcpContracts } from "./native-public-original-mcp-contracts.js";
import { getOriginalMcpNativeTodoSourceScope, readOriginalMcpNativeTodoSourceScope } from "./original-mcp-native-source-policy.js";
import { assertOriginalMcpDomainSession } from "./original-mcp-domains.js";
import { originalMcpTodoSession, readOriginalMcpDomain, originalMcpDomainHash } from "./original-mcp-domain-state.js";
import { originalMcpPrivateTopLevels } from "./original-mcp-root-custody.js";
import { todoDefinitions } from "./todo-definitions.js";
import { readOriginalMcpTodoGenesisSource } from "./original-mcp-todo-genesis-native.js";
import { readOriginalMcpTodoGenesisSources } from "./original-mcp-todo-genesis.js";

const operations = Object.freeze({
  get_board: "todo.board.get", get_workitem: "todo.workitem.get",
  list_boards: "todo.board.list", list_workitems: "todo.workitem.list",
  list_workitem_history: "todo.workitem.history", list_board_changes: "todo.board.changes",
  add_workitem: "todo.workitem.create", update_workitem: "todo.workitem.update",
  claim_workitem: "todo.workitem.claim", change_workitem_state: "todo.workitem.transition",
});
export const originalMcpTodoBasicOperationIds = Object.freeze([
  ...Object.keys(operations).map(name => `mcp.tool.${name}`), "mcp.tool.note_work_items",
]);
const owns = (tool: string): tool is keyof typeof operations => Object.hasOwn(operations, tool);
const catalogSchema = z.object({ contracts: z.array(z.object({
  id: z.string(), readOnly: z.boolean(), inputSchema: z.record(z.string(), z.unknown()),
})) });
export function originalMcpTodoBasicTool(tool: string): boolean { return owns(tool) || tool === "note_work_items"; }
export function originalMcpTodoPublicArguments(tool: string, input: Readonly<Record<string, unknown>>) {
  if (!originalMcpTodoBasicTool(tool) && tool !== "todo_board_create") return input;
  if (!Object.hasOwn(input, "worker_token")) return input;
  if (input.worker_token !== undefined && input.worker_token !== null)
    throw new CoreError("ACCESS_DENIED", "This native Original Todo slice accepts no supplied Board worker token.");
  const { worker_token: _noAuthorityDefault, ...arguments_ } = input;
  return arguments_;
}
export async function dispatchOriginalMcpTodoBasic(owner: RootOwner, host: OriginalMcpNativeHost,
  actor: Readonly<Actor>, tool: string, raw: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
  assertRootOwner(owner);
  const { storage, runtime } = await owner.ensureFull();
  assertOriginalMcpNativeHost(host, storage);
  if (!originalMcpTodoBasicTool(tool) || actor.id !== "mcp:external" || actor.boardWorker
    || !originalMcpPublicRequestActive(storage, tool, raw))
    throw new CoreError("ACCESS_DENIED", "Original Todo requires its exact native PUBLIC request and source owner.");
  const contract = catalogSchema.parse(originalPublicMcpContracts()).contracts.find(item => item.id === `mcp.tool.${tool}`);
  if (!contract || !new AjvJsonSchemaValidator().getValidator(contract.inputSchema)(raw).valid)
    throw new CoreError("INVALID_ARGUMENT", "Original Todo arguments violate the pinned contract.");
  if (raw.worker_token !== undefined && raw.worker_token !== null)
    throw new CoreError("ACCESS_DENIED", "This original Todo slice accepts no worker token or inherited role.");
  const args = Object.fromEntries(Object.entries(raw).filter(([key, entry]) => key !== "worker_token" && entry !== null));
  const slug = tool === "note_work_items" ? args.slug : args.board_slug;
  const genesisTarget = typeof slug === "string" ? readOriginalMcpTodoGenesisSource(storage, host, slug) : undefined;
  const scope = genesisTarget ? undefined : getOriginalMcpNativeTodoSourceScope(storage, host);
  const imported = () => {
    if (!scope) return [];
    assertOriginalMcpDomainSession(storage, host, "todo");
    const source = readOriginalMcpNativeTodoSourceScope(scope, storage, host);
    const state = readOriginalMcpDomain(storage.workspaceRoot(), "todo"), session = originalMcpTodoSession(storage.workspaceRoot());
    if (!state?.committed || source.approval.decisionId !== session.decisionId
      || source.request.sourceSha256 !== state.intent.sourceSha256
      || originalMcpDomainHash(source.request.files) !== originalMcpDomainHash(state.intent.files))
      throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "Original Todo source selection or epoch changed.");
    return source.request.files;
  };
  const current = () => {
    signal?.throwIfAborted();
    assertRootOwner(owner); assertOriginalMcpNativeHost(host, storage);
    const db = storage.connectNative();
    try {
      const genesis = [];
      for (const file of readOriginalMcpTodoGenesisSources(storage.workspaceRoot(), db)) {
        try {
          const selected = readOriginalMcpTodoGenesisSource(storage, host, file.key);
          if (selected) genesis.push(selected);
        } catch (error) {
          if (!(error instanceof CoreError) || error.code !== "NATIVE_AUTHORITY_REQUIRED") throw error;
        }
      }
      const files = [...imported(), ...genesis];
      if (!files.length) throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "Exact current Todo source selection is unavailable.");
      return files;
    } finally { db.close(); }
  };
  const files = current();
  if (tool !== "list_boards" && (typeof slug !== "string" || !files.some(file => file.key === slug)
    || originalMcpPrivateTopLevels(storage.workspaceRoot(), "notes").has(slug.split("/")[0]!)))
    throw new CoreError("ACCESS_DENIED", "Todo target is not an exact admitted public Board.");
  if (!contract.readOnly && !actor.canWrite) throw new CoreError("ACCESS_DENIED", "The source owner is read-only.");
  if (scope) await runtime.enrollOriginalMcpTodoNoteSources(host, scope);
  if (typeof slug === "string" && readOriginalMcpTodoGenesisSource(storage, host, slug))
    await runtime.enrollOriginalMcpTodoNoteGenesis(host, slug);
  current();
  const operation = owns(tool) ? operations[tool] : "legacy.note.workitems.read";
  const definition = owns(tool) ? todoDefinitions.find(item => item.id === operation)! : undefined;
  const arguments_ = definition ? definition.input.parse({
    ...args, ...(!contract.readOnly ? { operationId: randomUUID() } : {}),
  }) : args;
  if (tool === "list_boards") {
    const paging = z.object({ query: z.string().optional(), offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(100).optional() }).parse(arguments_);
    const rows = [];
    for (const file of files) {
      if (paging.query && !`${file.key} ${file.title}`.toLowerCase().includes(paging.query.toLowerCase())) continue;
      current();
      const response = await runtime.core.dispatch("capability_read", { operation: "todo.board.get", version: 1,
        arguments: { board_slug: file.key } }, actor);
      if (response.error) throw new CoreError(response.error.code, response.error.message, response.error.effect);
      const board = z.object({ digest: z.string(), title: z.string(), counts: z.object({
        workitems: z.number(), userstories: z.number(), deleted: z.number(),
      }) }).parse(response.result);
      rows.push({ slug: file.key, title: board.title, count: board.counts.workitems + board.counts.userstories + board.counts.deleted, digest: board.digest });
    }
    current();
    const offset = paging.offset ?? 0, limit = paging.limit ?? 50;
    return { actorId: actor.id, items: rows.slice(offset, offset + limit), total: rows.length, offset, limit,
      next_offset: offset + limit < rows.length ? offset + limit : null };
  }
  const reply = await runtime.core.dispatch(contract.readOnly ? "capability_read" : "capability_call",
    { operation, version: 1, arguments: arguments_ }, actor);
  if (reply.error) throw new CoreError(reply.error.code, reply.error.message, reply.error.effect);
  try { current(); }
  catch (error) {
    if (!contract.readOnly) throw new CoreError("NATIVE_AUTHORITY_REQUIRED",
      "Todo authority changed after dispatch; reconcile the durable receipt before retrying.", "unknown");
    throw error;
  }
  return reply.result;
}
