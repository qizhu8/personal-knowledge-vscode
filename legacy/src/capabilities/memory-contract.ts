import { createHash } from "crypto";
import * as fs from "fs";
import type { Capability } from "./registry";
import type { ExplicitMemoryScope } from "../memory/explicit-memory-service";

const text = { type: "string", minLength: 1, maxLength: 4096 };
const id = { type: "string", minLength: 1, maxLength: 256 };
const identity = { id, expected_revision: { type: "integer", minimum: 1 }, operation_id: id };
const source = { type: "object", properties: {
  id, chat: { type: "string", minLength: 1, maxLength: 1024 }, revision: id,
  locator: { type: "string", minLength: 1, maxLength: 2048 },
}, required: ["id", "chat", "revision", "locator"], additionalProperties: false };
const content = { content: text, sources: { type: "array", minItems: 1, maxItems: 32, items: source } };
const definitions = [
  ["propose", false, { ...content, operation_id: id }, ["content", "sources", "operation_id"], "Propose a bounded long-term fact or convention with exact sources. Pending proposals are not active recall or user confirmation."],
  ["get", true, { id, revision: { type: "integer", minimum: 1 } }, ["id"], "Read a scoped record/version, including explicit pending/revoked status; never implies applicability."],
  ["search", true, { query: { type: "string", minLength: 1, maxLength: 512 }, limit: { type: "integer", minimum: 1, maximum: 3 } }, ["query"], "Search current confirmed records in the Host-bound repository scope. Pending, superseded and revoked records are excluded. At most 3 explicitly marked previews; use memory.record.get with id/revision for full text and sources."],
  ["confirm", false, identity, ["id", "expected_revision", "operation_id"], "Native local Host confirmation only. Always shows exact stored content/sources in a human decision, even under Allow All. Not available through external MCP."],
  ["revise", false, { ...identity, ...content }, ["id", "expected_revision", "operation_id", "content", "sources"], "Native local Host revision with exact-version approval. Old revision becomes superseded. No caller-supplied confirmation or authority fields."],
  ["revoke", false, identity, ["id", "expected_revision", "operation_id"], "Native local Host revocation with exact-version approval. Removes the record from subsequent active search without claiming erasure of backups or already-sent prompts."],
  ["audit", true, { id, after: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 10 } }, ["id"], "Read up to 10 scoped lifecycle events with a next cursor, without touching recall or calling a model."],
] as const;

export const memoryCapabilities: Capability[] = definitions.map(([action, readOnly, properties, required, description]) => ({
  id: `memory.record.${action}`, version: 1, transportName: `memory_record_${action}`, description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  outputSchema: action === "search" ? { type: "object", properties: { records: { type: "array", maxItems: 3, items: { type: "object" } } }, required: ["records"] }
    : action === "audit" ? { type: "object", properties: { events: { type: "array", maxItems: 10, items: { type: "object" } } }, required: ["events", "next"] }
      : { type: "object", properties: { id, revision: { type: "integer", minimum: 1 },
        status: { type: "string", enum: ["pending", "confirmed", "superseded", "revoked"] } }, required: ["id", "revision", "status"] },
  readOnly, authorization: "Host-bound account/project/repository scope. External clients propose/read only; confirm/revise/revoke require an actual native local user decision.",
  concurrency: "exclusive", idempotency: readOnly ? "read" : "operation-id",
  cancellation: "Check before dispatch. A committed mutation may survive cancellation; reconcile its operation ID and never blindly replay.",
  errors: ["INVALID_ARGUMENT", "NOT_AVAILABLE", "ACCESS_DENIED", "CONFLICT", "CANCELLED", "EXECUTION_FAILED"],
  lifecycle: { status: "stable", legacyAlias: `memory_record_${action}` },
}));

export const externalMemoryCapabilities = memoryCapabilities.filter(operation => !["memory.record.confirm", "memory.record.revise", "memory.record.revoke"].includes(operation.id));

export function repositoryMemoryScope(root: string): ExplicitMemoryScope {
  const identity = createHash("sha256").update(fs.realpathSync(root)).digest("hex");
  return { account: "local-owner", project: identity, repository: identity };
}
