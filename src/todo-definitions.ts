import { z } from "zod";
import { todoApiDefinitions } from "./domain/todo-api-contract.js";
import { todoIdentities } from "./domain/todo-identities.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const paging = { items: z.array(z.record(z.string(), z.unknown())).max(100), total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100), next_offset: z.number().int().nonnegative().nullable() };
function output(name: string) {
  const base = z.object({ actorId: z.string().min(1) });
  const board = base.extend({ board_slug: z.string().min(1), digest });
  if (name === "list_boards") return base.extend(paging);
  if (name === "list_agents") return board.extend({ ...paging, chatDirectory: z.strictObject({ available: z.boolean(), reason: z.string().min(1) }) });
  if (name.startsWith("list_")) return board.extend(paging);
  if (name === "get_board") return board.extend({ title: z.string(), counts: z.record(z.string(), z.unknown()) });
  if (name === "get_userstory") return board.extend({ story: z.record(z.string(), z.unknown()), children: z.object(paging) });
  return board.extend({ item: z.record(z.string(), z.unknown()) });
}
export const todoDefinitions = [
  {
    id: "todo.board.create", readOnly: false, transportName: "create_board",
    description: "Create a dedicated Todo Board in the isolated workspace; no tasks are started. Nested board_slug is supported. Requires a durable operationId.",
    input: z.strictObject({ board_slug: z.string().min(1).max(1024), operationId: z.string().uuid() }),
    output: z.object({ actorId: z.string().min(1), board_slug: z.string().min(1), digest, title: z.string(), counts: z.record(z.string(), z.unknown()) }),
  },
  ...todoApiDefinitions.map(api => {
    const id = todoIdentities[api.name];
    if (!id) throw new Error(`Missing canonical Todo identity: ${api.name}`);
    const properties: Record<string, unknown> = api.parameters.properties;
    const required: string[] = api.parameters.required;
    return {
      id, readOnly: api.readOnly, transportName: api.name,
      description: `${api.description}${api.readOnly ? "" : " This server also requires a UUID operationId for durable retries."}${api.name === "list_agents" || api.name === "assign_workitem" ? " Chat discovery and assignment are scoped to active native Chat sessions owned by the authenticated actor." : ""}`,
      input: z.fromJSONSchema({
        ...api.parameters,
        properties: { ...properties, ...(!api.readOnly ? { operationId: { type: "string", format: "uuid" } } : {}) },
        required: [...required, ...(!api.readOnly ? ["operationId"] : [])],
      } as z.core.JSONSchema.JSONSchema),
      output: output(api.name),
    };
  }),
];
