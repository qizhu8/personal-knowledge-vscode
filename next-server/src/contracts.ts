import { z } from "zod";

export class CoreError extends Error {
  constructor(readonly code: string, message: string, readonly effect: "not-committed" | "unknown" = "not-committed") {
    super(message);
  }
}

export const documentId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const mutation = {
  operationId: z.string().uuid(),
  id: documentId,
};
export const documentSchema = z.strictObject({
  id: documentId,
  title: z.string().min(1).max(500),
  content: z.string().max(100_000),
  revision,
  deleted: z.boolean(),
});
export type DocumentRecord = z.infer<typeof documentSchema>;
export const definitions = [
  {
    id: "knowledge.document.list", readOnly: true,
    description: "List this isolated workspace's documents. Pin workspaceRevision on later pages. Does not read the legacy Knowledge Root.",
    input: z.strictObject({
      offset: z.number().int().min(0).max(1_000_000).default(0),
      limit: z.number().int().min(1).max(100).default(20),
      workspaceRevision: revision.optional(),
      includeDeleted: z.boolean().default(false),
    }),
    output: z.strictObject({ items: z.array(documentSchema.omit({ content: true })), total: revision, nextOffset: revision.nullable(), workspaceRevision: revision }),
  },
  {
    id: "knowledge.document.get", readOnly: true, description: "Read a document, including its recorded deletion state.",
    input: z.strictObject({ id: documentId }), output: documentSchema,
  },
  {
    id: "knowledge.document.create", readOnly: false, description: "Create a new document with a durable operation receipt. An existing ID is a conflict.",
    input: z.strictObject({ ...mutation, title: z.string().trim().min(1).max(500), content: z.string().max(100_000) }),
    output: documentSchema,
  },
  {
    id: "knowledge.document.update", readOnly: false, description: "Replace title/content using the exact current revision. Never writes legacy Notes.",
    input: z.strictObject({ ...mutation, expectedRevision: revision.min(1), title: z.string().trim().min(1).max(500), content: z.string().max(100_000) }),
    output: documentSchema,
  },
  {
    id: "knowledge.document.trash", readOnly: false, description: "Soft-delete by revision. Content and audit remain; no permanent deletion.",
    input: z.strictObject({ ...mutation, expectedRevision: revision.min(1) }), output: documentSchema,
  },
  {
    id: "knowledge.document.restore", readOnly: false, description: "Restore a soft-deleted document using its exact revision.",
    input: z.strictObject({ ...mutation, expectedRevision: revision.min(1) }), output: documentSchema,
  },
] as const;
export const invocation = z.strictObject({
  operation: z.string().max(100),
  version: z.literal(1),
  arguments: z.record(z.string(), z.unknown()),
});
export const discovery = z.strictObject({
  query: z.string().max(200).default(""),
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(20).default(10),
  revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export const description = z.strictObject({ operation: z.string().max(100) });
export const resultEnvelope = z.strictObject({
  schema: z.literal("pkm.next-result/v1"),
  requestId: z.string().uuid(),
  operation: z.string().optional(),
  version: z.literal(1).optional(),
  catalogRevision: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.strictObject({ code: z.string(), message: z.string(), effect: z.enum(["not-committed", "unknown"]) }).optional(),
}).refine(value => (value.result === undefined) !== (value.error === undefined), "Exactly one result or error is required.");
export interface Actor { id: string; canWrite: boolean }
export interface StorageRequest { operation: typeof definitions[number]["id"]; args: Record<string, unknown>; actorId: string }
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new CoreError("INVALID_ARGUMENT", z.prettifyError(parsed.error));
  return parsed.data;
}
