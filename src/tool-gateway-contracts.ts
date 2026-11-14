import { z } from "zod";
import type { Actor } from "./contracts.js";

export const TOOL_GATEWAY_LIMITS = Object.freeze({
  calls: 64, argumentBytes: 32_768, outputBytes: 16_000,
  callTimeoutMs: 30_000, turnTimeoutMs: 120_000, discoveryItems: 10,
});
// JSON can escape each of 16,000 UTF-16 code units to six ASCII bytes, plus quotes.
export const CHAT_TOOL_GATEWAY_OUTPUT_BYTES = 96_002;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(200);
export const toolGatewayContext = z.strictObject({
  workspaceId: identity, turnId: identity, contextDigest: digest,
});
export const toolGatewayRequest = z.strictObject({
  name: identity, arguments: z.record(z.string(), z.json()),
  operationId: z.string().uuid().optional(), approval: z.unknown().optional(),
});
export const toolGatewayDiscovery = z.strictObject({
  query: z.string().max(200).default(""), offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(10).default(10), revision: digest.optional(),
});
export interface ToolGatewayDispatcher {
  dispatch(method: string, input: unknown, actor: Actor): Promise<unknown>;
}
/** These bindings are installed by the native composition root, never by model discovery. */
export interface ToolGatewayBinding {
  name: string;
  operation: string;
  approvalRequired?: boolean;
}
export interface ToolApprovalBinding {
  operation: string;
  version: 1;
  arguments: Readonly<Record<string, unknown>>;
  argumentsDigest: string;
  operationId?: string;
  actorId: string;
  workspaceId: string;
  turnId: string;
  contextDigest: string;
  readOnly: boolean;
}
export type ToolApprovalVerifier = (
  binding: ToolApprovalBinding, approval: unknown, signal: AbortSignal,
) => Promise<boolean>;
export interface ToolGatewayOptions {
  dispatcher: ToolGatewayDispatcher;
  actor: Actor;
  context: z.infer<typeof toolGatewayContext>;
  catalog?: readonly ToolGatewayBinding[];
  verifyApproval?: ToolApprovalVerifier;
  authorize?: (binding: ToolApprovalBinding, signal: AbortSignal) => Promise<boolean>;
  /** Trusted native Chat composition only; never supplied by a tool caller. */
  legacyChatOutput?: boolean;
  limits?: { calls?: number; callTimeoutMs?: number; turnTimeoutMs?: number; outputBytes?: number };
}
export interface ToolGatewayResult {
  schema: "pkm.tool-result/v1";
  name: string;
  operation: string;
  version: 1;
  status: "complete" | "failed" | "cancelled" | "unknown";
  effect: "not-committed" | "committed" | "unknown";
  retry: "never" | "read-only";
  result?: unknown;
  error?: { code: string; message: string };
}
