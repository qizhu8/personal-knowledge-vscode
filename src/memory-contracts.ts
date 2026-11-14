import { z } from "zod";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const memoryText = (bytes: number) => z.string().min(1).max(bytes)
  .refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
    && /^(?:[\u0000-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/.test(value)
    && Buffer.byteLength(value, "utf8") <= bytes, `Expected well-formed text within ${bytes} UTF-8 bytes.`);
export const memorySources = z.array(z.strictObject({
  id: memoryText(256), chat: memoryText(1024), revision: memoryText(256), locator: memoryText(2048),
})).min(1).max(32).refine(value => Buffer.byteLength(JSON.stringify(value), "utf8") <= 4096,
  "Source references exceed 4096 UTF-8 bytes in total.");
export const memoryContent = z.strictObject({ content: memoryText(4096), sources: memorySources });
const status = z.enum(["pending", "confirmed", "revoked"]);
export const memoryEvent = z.strictObject({
  sequence: integer.min(1), revision: integer.min(1), action: z.enum(["proposed", "confirmed", "revised", "revoked"]),
  status, actor: memoryText(256), decision_id: memoryText(256).nullable(),
  operation_id: memoryText(256), created_at: z.number().nonnegative(),
});
export const memoryRecord = memoryContent.extend({
  id: memoryText(256), scope: memoryText(1024), revision: integer.min(1), current_revision: integer.min(1),
  status: z.enum(["pending", "confirmed", "superseded", "revoked"]), current_status: status,
  created_at: z.number().nonnegative(), updated_at: z.number().nonnegative(), revision_created_at: z.number().nonnegative(),
  documentSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type MemoryRecord = z.infer<typeof memoryRecord>;
export const memoryDecision = z.strictObject({ decisionId: memoryText(256), actorId: memoryText(256) });
export interface MemoryDecisionRequest {
  operation: "memory.record.confirm" | "memory.record.revise" | "memory.record.revoke";
  operationId: string;
  record: Omit<Readonly<MemoryRecord>, "sources"> & { readonly sources: readonly Readonly<z.infer<typeof memorySources>[number]>[] };
  replacement?: { readonly content: string; readonly sources: readonly Readonly<z.infer<typeof memorySources>[number]>[] };
}
export type MemoryAuthorizer = (request: Readonly<MemoryDecisionRequest>) =>
  z.infer<typeof memoryDecision> | null | Promise<z.infer<typeof memoryDecision> | null>;
const identity = { id: memoryText(256), expected_revision: integer.min(1), operation_id: memoryText(256) };
export const memoryDefinitions = [
  {
    id: "memory.record.propose", readOnly: false, nativeOnly: false,
    description: "Propose a repository-scoped sourced fact. Stored authoritatively in isolated System/Memory Markdown as pending, never active recall or implicit user confirmation. Durable operation_id is required.",
    input: memoryContent.extend({ operation_id: memoryText(256) }), output: memoryRecord,
  },
  {
    id: "memory.record.get", readOnly: true, nativeOnly: false,
    description: "Read a scoped current/historical explicit-memory version, its exact sources and current lifecycle. documentSha256 pins the authoritative state; retrieval does not imply application.",
    input: z.strictObject({ id: memoryText(256), revision: integer.min(1).optional() }), output: memoryRecord,
  },
  {
    id: "memory.record.search", readOnly: true, nativeOnly: false,
    description: "Return at most three explicitly marked previews of current confirmed scoped records, using original SQLite ASCII-case-insensitive literal matching and update-time/ID ordering. Pending/superseded/revoked records are excluded.",
    input: z.strictObject({ query: memoryText(512), limit: integer.min(1).max(3).default(3) }),
    output: z.strictObject({ records: z.array(z.strictObject({
      id: memoryText(256), revision: integer.min(1), status: z.literal("confirmed"), updated_at: z.number().nonnegative(),
      preview: z.string().max(800), contentCharacters: integer, truncated: z.boolean(), sourceCount: integer,
      readOperation: z.literal("memory.record.get"),
    })).max(3) }),
  },
  {
    id: "memory.record.audit", readOnly: true, nativeOnly: false,
    description: "Page up to ten original scoped lifecycle events without touching recall, invoking a model or silently erasing history.",
    input: z.strictObject({ id: memoryText(256), after: integer.default(0), limit: integer.min(1).max(10).default(10) }),
    output: z.strictObject({ events: z.array(memoryEvent).max(10), next: integer.nullable() }),
  },
  {
    id: "memory.record.confirm", readOnly: false, nativeOnly: true,
    description: "Native human exact-record approval only, including under Allow All. Confirms into a new revision; unavailable to HTTP/MCP and to a Core without an injected human authorizer.",
    input: z.strictObject(identity), output: memoryRecord,
  },
  {
    id: "memory.record.revise", readOnly: false, nativeOnly: true,
    description: "Native human exact-version revision only. Creates a new pending revision; prior confirmation never carries forward. Not available through HTTP/MCP.",
    input: memoryContent.extend(identity), output: memoryRecord,
  },
  {
    id: "memory.record.revoke", readOnly: false, nativeOnly: true,
    description: "Native human exact-version revocation only. Excludes future active search, retains audit/history and never claims erasure of backups or already-sent prompts. Not available through HTTP/MCP.",
    input: z.strictObject(identity), output: memoryRecord,
  },
] as const;
