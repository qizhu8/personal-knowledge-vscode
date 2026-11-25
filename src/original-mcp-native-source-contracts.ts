import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { originalNativeActionSession, originalNativeActionPayloadSchemas } from "./original-mcp-native-action-contracts.js";
import {
  originalMcpDomainApprovalRequestSchema, originalApiChatSourceApprovalRequestSchema, originalMcpSourceApprovalSchema,
} from "./original-mcp-source-policy-contracts.js";

// Reuse the existing pure signed-session/host DTOs; never import the Node host/Storage authority into the UI.
export const originalNativeSourceSessionSchema = originalNativeActionSession;
const binding = originalNativeActionPayloadSchemas["action.status"].shape.binding;
export type OriginalNativeSourceSession = z.infer<typeof originalNativeSourceSessionSchema>;
export const originalNativeSourceMethods = Object.freeze([
  "todo.source.approve", "memory.source.approve", "chat.source.approve",
] as const);
export type OriginalNativeSourceMethod = typeof originalNativeSourceMethods[number];
export type OriginalNativeSourceDomain = "todo" | "memory" | "chat";
export function isOriginalNativeSourceMethod(value: unknown): value is OriginalNativeSourceMethod {
  return typeof value === "string" && originalNativeSourceMethods.some(method => method === value);
}
export const originalNativeSourcePayloadSchemas = Object.freeze({
  "todo.source.approve": z.strictObject({ binding, noExecution: z.literal(true),
    request: originalMcpDomainApprovalRequestSchema.extend({ domain: z.literal("todo"),
      sourceDetails: originalMcpDomainApprovalRequestSchema.shape.sourceDetails.options[0] }) }),
  "memory.source.approve": z.strictObject({ binding, noExecution: z.literal(true),
    request: originalMcpDomainApprovalRequestSchema.extend({ domain: z.literal("memory"),
      sourceDetails: originalMcpDomainApprovalRequestSchema.shape.sourceDetails.options[1] }) }),
  "chat.source.approve": z.strictObject({ binding, noExecution: z.literal(true), request: originalApiChatSourceApprovalRequestSchema }),
});
export const originalNativeSourceResultSchemas = Object.freeze({
  "todo.source.approve": originalMcpSourceApprovalSchema.nullable(),
  "memory.source.approve": originalMcpSourceApprovalSchema.nullable(),
  "chat.source.approve": originalMcpSourceApprovalSchema.nullable(),
});
export type OriginalNativeSourcePayload<M extends OriginalNativeSourceMethod> = z.infer<typeof originalNativeSourcePayloadSchemas[M]>;
export const originalNativeSourceRequestDigest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }

export function parseOriginalNativeSourcePayload<M extends OriginalNativeSourceMethod>(method: M, value: unknown,
  context: OriginalNativeSourceSession): OriginalNativeSourcePayload<M> {
  const session = originalNativeSourceSessionSchema.parse(context), payload = originalNativeSourcePayloadSchemas[method].parse(value);
  const host = payload.binding, expected = session.binding, request = payload.request;
  if (session.epoch !== session.activationId || host.epoch !== session.epoch || host.root !== expected.root
    || host.workspaceId !== expected.workspaceId || host.planSha256 !== expected.planSha256
    || host.profileSha256 !== expected.profileSha256 || host.sourceCatalogSha256 !== expected.catalogSha256
    || host.authorityId !== `native-rpc:${session.brokerId}` || !host.domains.includes("mcp-public")
    || request.root !== expected.root || request.workspaceId !== expected.workspaceId
    || request.custodyPlanSha256 !== expected.planSha256 || request.profileSha256 !== expected.profileSha256
    || request.nativeHostReceiptSha256 !== originalNativeSourceRequestDigest(host))
    fail("NATIVE_SOURCE_BINDING_MISMATCH");
  if (request.schema === "pkm.original-mcp-domain-approval-request/v1") {
    if (new Set(request.files.map(file => file.key)).size !== request.files.length)
      fail("NATIVE_SOURCE_SELECTION_INVALID");
    if (request.domain === "todo" && (request.sourceDetails.domain !== "todo"
      || request.sourceDetails.boards !== request.files.length
      || request.files.some(file => file.sourcePath !== `notes/${file.key}.assets/pkm-todo-board.json`
        || file.notePath !== `notes/${file.key}.md` || !file.noteSha256 || !file.title || file.stagedPath !== undefined)
      || request.sourceSha256 !== originalNativeSourceRequestDigest(request.files)))
      fail("NATIVE_SOURCE_SELECTION_INVALID");
    if (request.domain === "memory" && request.files.some(file => !file.stagedPath
      || file.sourcePath !== undefined || file.notePath !== undefined || file.noteSha256 !== undefined || file.title !== undefined))
      fail("NATIVE_SOURCE_SELECTION_INVALID");
  } else {
    const { phase: _phase, nativeHostReceiptSha256: _host, planSha256, ...plan } = request;
    if (originalNativeSourceRequestDigest(plan) !== planSha256) fail("NATIVE_SOURCE_PLAN_CHANGED");
  }
  return payload as OriginalNativeSourcePayload<M>;
}

/** Measure the whole existing signed request frame, never a shortened approval preview. */
export function assertOriginalNativeSourcePacketBudget(method: OriginalNativeSourceMethod, payload: unknown,
  session: OriginalNativeSourceSession, requestId = "00000000-0000-4000-8000-000000000000") {
  const frame = { type: "native-request", protocol: "pkm.original-mcp-native-request/v1", requestId,
    session, method, payload, requestDigest: "0".repeat(64) };
  const bytes = Buffer.byteLength(JSON.stringify(frame) + "\n");
  if (bytes > 65536) throw Object.assign(new Error(
    `NATIVE_REQUEST_TOO_LARGE: exact source approval requires ${bytes} bytes; the signed request budget is 65536 bytes. Select a smaller independently reviewed source set; chunked source-consent transport is not implemented.`),
  { code: "NATIVE_REQUEST_TOO_LARGE", requiredBytes: bytes, maximumBytes: 65536 });
}
