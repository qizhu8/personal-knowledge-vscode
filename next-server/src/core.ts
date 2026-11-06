import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { CoreError, definitions, description, discovery, invocation, parse, type Actor } from "./contracts.js";
import { Storage } from "./storage.js";

const catalog = definitions.map(definition => ({
  operation: definition.id, version: 1, description: definition.description, readOnly: definition.readOnly,
  inputSchema: z.toJSONSchema(definition.input), outputSchema: z.toJSONSchema(definition.output),
  authorization: definition.readOnly ? "Authenticated workspace read" : "Authenticated workspace write",
  idempotency: definition.readOnly ? "read" : "durable-operation-id",
}));
const catalogRevision = createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
export const methods = {
  server_info: { description: "Read this experimental server's protocol, limits and isolation boundary.", schema: z.strictObject({}), readOnly: true },
  capabilities_search: { description: "Browse/search the authorized catalog; returns summaries. Pin revision when paging.", schema: discovery, readOnly: true },
  capabilities_describe: { description: "Read the exact versioned operation contract before invocation.", schema: description, readOnly: true },
  capability_read: { description: "Invoke a read-only operation through the shared Core.", schema: invocation, readOnly: true },
  capability_call: { description: "Invoke a mutation. Requires write authority and a durable operationId. On uncertain transport outcome retry only the identical request with the SAME operationId.", schema: invocation, readOnly: false },
} as const;
export type Method = keyof typeof methods;
export class Core {
  constructor(private readonly storage: Storage) {}
  async dispatch(method: string, input: unknown, actor: Actor) {
    const requestId = randomUUID();
    try {
      if (!Object.hasOwn(methods, method)) throw new CoreError("NOT_FOUND", "Unknown API method.");
      if (method === "server_info") {
        parse(methods.server_info.schema, input);
        return { schema: "pkm.next-result/v1", requestId, result: {
          name: "pkm-next", version: "0.1.0", experimental: true, catalogRevision,
          isolation: "New workspace only; no legacy migration or VS Code dependency.",
          limits: { requestBytes: 131072, storageQueue: 32, documentCharacters: 100000 },
          features: ["knowledge-documents", "revision-cas", "durable-receipts", "trash-restore"],
          unavailable: ["chat", "browser-ui", "retrieval", "plugins", "remote-access"],
        } };
      }
      if (method === "capabilities_search") {
        const args = parse(discovery, input);
        if (args.revision && args.revision !== catalogRevision) throw new CoreError("CONFLICT", "Catalog changed; restart discovery.");
        const words = args.query.toLowerCase().split(/\s+/).filter(Boolean);
        const matches = catalog.filter(item => (actor.canWrite || item.readOnly) && words.every(word => `${item.operation} ${item.description}`.toLowerCase().includes(word)));
        const items = matches.slice(args.offset, args.offset + args.limit).map(({ operation, version, description, readOnly }) => ({ operation, version, description, readOnly }));
        const next = args.offset + items.length;
        return { schema: "pkm.next-result/v1", requestId, result: { revision: catalogRevision, items, total: matches.length, nextOffset: next < matches.length ? next : null } };
      }
      if (method === "capabilities_describe") {
        const args = parse(description, input);
        const item = catalog.find(item => item.operation === args.operation && (actor.canWrite || item.readOnly));
        if (!item) throw new CoreError("NOT_FOUND", "Operation is not available in this actor's catalog.");
        return { schema: "pkm.next-result/v1", requestId, result: { ...item, catalogRevision } };
      }
      const args = parse(invocation, input);
      const definition = definitions.find(item => item.id === args.operation);
      if (!definition) throw new CoreError("NOT_FOUND", "Unknown operation.");
      if (definition.readOnly !== (method === "capability_read")) throw new CoreError("ACCESS_DENIED", "Use the matching read or mutation entry point.");
      if (!definition.readOnly && !actor.canWrite) throw new CoreError("ACCESS_DENIED", "This principal has no write authority.");
      const inputSchema: z.ZodType<Record<string, unknown>> = definition.input;
      const validated = parse(inputSchema, args.arguments);
      const result = await this.storage.request({ operation: definition.id, args: validated, actorId: actor.id });
      if (!definition.output.safeParse(result).success) throw new CoreError("INVALID_RESULT", "Storage returned an invalid result; reconcile the operation receipt before retrying.", definition.readOnly ? "not-committed" : "unknown");
      return { schema: "pkm.next-result/v1", requestId, operation: definition.id, version: 1, catalogRevision, result };
    } catch (error) {
      if (!(error instanceof CoreError)) console.error("PKM next dispatch:", error);
      const failure = error instanceof CoreError ? error : new CoreError("INTERNAL", "Internal error; inspect server diagnostics.", "unknown");
      return { schema: "pkm.next-result/v1", requestId, error: { code: failure.code, message: failure.message, effect: failure.effect } };
    }
  }
}
