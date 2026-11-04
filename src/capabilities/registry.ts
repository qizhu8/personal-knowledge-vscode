import { createHash } from "crypto";
import { todoApiDefinitions } from "../knowledge/todo-api-contract";

export interface Capability {
  id: string;
  version: 1;
  transportName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  readOnly: boolean;
  authorization: string;
  concurrency: "exclusive" | "independent-read";
  idempotency: "read" | "digest-cas" | "operation-id";
  cancellation: string;
  errors: string[];
  lifecycle: { status: "stable"; legacyAlias: string };
}

const todoIds: Record<string, string> = {
  list_boards: "todo.board.list", get_board: "todo.board.get",
  list_workitems: "todo.workitem.list", get_workitem: "todo.workitem.get",
  list_userstories: "todo.story.list", get_userstory: "todo.story.get", list_agents: "todo.agent.list",
  add_workitem: "todo.workitem.create", update_workitem: "todo.workitem.update",
  delete_workitem: "todo.workitem.delete", restore_workitem: "todo.workitem.restore",
  move_workitem: "todo.workitem.move", add_userstory: "todo.story.create",
  update_userstory: "todo.story.update", delete_userstory: "todo.story.delete",
  restore_userstory: "todo.story.restore", claim_workitem: "todo.workitem.claim",
  assign_workitem: "todo.workitem.assign", release_workitem: "todo.workitem.release",
  change_workitem_state: "todo.workitem.transition", submit_workitem_result: "todo.workitem.submit",
  accept_workitem: "todo.workitem.accept", reopen_workitem: "todo.workitem.reopen",
  reopen_userstory: "todo.story.reopen", change_userstory_state: "todo.story.transition",
  accept_userstory: "todo.story.accept", list_board_changes: "todo.board.changes",
  add_workitem_comment: "todo.workitem.comment", list_workitem_history: "todo.workitem.history",
};

function todoOutputSchema(name: string, readOnly: boolean): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    actorId: { type: "string", minLength: 1 }, board_slug: { type: "string", minLength: 1 },
    digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
  };
  const required = name === "list_boards" ? ["actorId"] : ["actorId", "board_slug", "digest"];
  if (name.startsWith("list_")) {
    Object.assign(properties, { items: { type: "array", maxItems: 100, items: { type: "object" } },
      total: { type: "integer", minimum: 0 }, offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 100 }, next_offset: {} });
    required.push("items", "total", "offset", "limit", "next_offset");
  } else if (name === "get_board") {
    Object.assign(properties, { title: { type: "string" }, counts: { type: "object" } });
    required.push("title", "counts");
  } else if (name === "get_userstory") {
    Object.assign(properties, { story: { type: "object" }, children: { type: "object" } });
    required.push("story", "children");
  } else if (name === "get_workitem" || !readOnly) {
    properties.item = { type: "object" };
    required.push("item");
  }
  return { type: "object", properties, required };
}

export const todoCapabilities: Capability[] = todoApiDefinitions.map(api => {
  const id = todoIds[api.name];
  if (!id) throw new Error(`Missing canonical capability identity: ${api.name}`);
  return {
    id, version: 1, transportName: api.name, description: api.description, inputSchema: api.parameters,
    outputSchema: todoOutputSchema(api.name, api.readOnly),
    readOnly: api.readOnly, authorization: "Authenticated Board actor; existing contract, owner, reviewer and CAS guards. Discovery grants no access.",
    concurrency: "exclusive", idempotency: api.readOnly ? "read" : "digest-cas",
    cancellation: "Checked before dispatch; committed effects are not rolled back or automatically replayed.",
    errors: ["INVALID_ARGUMENT", "NOT_AVAILABLE", "ACCESS_DENIED", "CONFLICT", "CANCELLED", "EXECUTION_FAILED"],
    lifecycle: { status: "stable", legacyAlias: api.name },
  };
});

export class CapabilityError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "CapabilityError"; }
}

export function validateCapabilityInput(value: unknown, schema: Record<string, unknown>, at = "arguments"): void {
  const fail = () => { throw new CapabilityError("INVALID_ARGUMENT", `Invalid ${at}.`); };
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    const object = value as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (schema.additionalProperties === false && Object.keys(object).some(key => !properties || !Object.prototype.hasOwnProperty.call(properties, key))) fail();
    if ((schema.required as string[] | undefined)?.some(key => object[key] === undefined)) fail();
    for (const [key, entry] of Object.entries(object)) if (properties?.[key]) validateCapabilityInput(entry, properties[key], `${at}.${key}`);
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < Number(schema.minItems ?? 0) || value.length > Number(schema.maxItems ?? 100)) fail();
    for (const entry of value as unknown[]) validateCapabilityInput(entry, schema.items as Record<string, unknown>, `${at}[]`);
  } else if (schema.type === "string") {
    if (typeof value !== "string" || value.length < Number(schema.minLength ?? 0) || value.length > Number(schema.maxLength ?? 16000)
      || schema.pattern && !new RegExp(String(schema.pattern)).test(value)) fail();
  } else if (schema.type === "integer") {
    if (!Number.isSafeInteger(value) || Number(value) < Number(schema.minimum ?? 0) || Number(value) > Number(schema.maximum ?? Number.MAX_SAFE_INTEGER)) fail();
  } else if (schema.type === "boolean" && typeof value !== "boolean") fail();
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) fail();
}

export class CapabilityRegistry {
  readonly revision: string;
  constructor(readonly operations: readonly Capability[]) {
    if (new Set(operations.map(operation => operation.id)).size !== operations.length
      || operations.some(operation => !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){2}$/.test(operation.id))) {
      throw new Error("Capabilities require unique domain.object.operation identities.");
    }
    this.revision = createHash("sha256").update(JSON.stringify(operations)).digest("hex");
  }
  describe(id: string): Capability {
    const operation = this.operations.find(item => item.id === id);
    if (!operation) throw new CapabilityError("NOT_AVAILABLE", "Operation is not available in this authorized catalog.");
    return operation;
  }
  discover(input: Record<string, unknown>, search = false) {
    validateCapabilityInput(input, {
      type: "object", additionalProperties: false, properties: {
        path: { type: "string", maxLength: 100 }, query: { type: "string", maxLength: 200 },
        offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 10 },
        revision: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
    });
    if (input.revision !== undefined && input.revision !== this.revision) throw new CapabilityError("CONFLICT", "Capability catalog changed; restart discovery.");
    const path = String(input.path || ""), query = String(input.query || "").toLowerCase().trim();
    if (path && !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){0,2}$/.test(path)) throw new CapabilityError("INVALID_ARGUMENT", "Use a bounded capability path.");
    const tokens = query.split(/\s+/).filter(Boolean);
    const matches = this.operations.filter(item => (!path || item.id === path || item.id.startsWith(`${path}.`))
      && (!tokens.length || tokens.every(token => `${item.id} ${item.transportName} ${item.description}`.toLowerCase().includes(token))));
    const offset = Number(input.offset ?? 0), limit = Number(input.limit ?? (search ? 3 : 10));
    const entries = matches.slice(offset, offset + limit);
    return { schema: "pkm.capabilities/v1", revision: this.revision, total: matches.length, offset,
      nextOffset: offset + limit < matches.length ? offset + limit : null,
      children: [...new Set(matches.map(item => item.id.split(".").slice(0, path ? path.split(".").length + 1 : 1).join(".")))],
      operations: search ? entries : entries.map(({ id, version, readOnly, transportName, description }) => ({ id, version, readOnly, transportName, description })),
    };
  }
}
