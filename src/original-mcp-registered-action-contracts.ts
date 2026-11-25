import { z } from "zod";
import { originalMcpNativeSignedHostBinding } from "./original-mcp-native-signed-host-contracts.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const registeredActionReview = z.strictObject({
  binding: originalMcpNativeSignedHostBinding,
  purpose: z.enum(["source", "effect", "reconcile"]),
  reconciliation: z.strictObject({
    expectedVersion: z.number().safe().int().positive(),
    processJobId: z.string().uuid(), processOperationId: z.string().uuid(),
    processReceiptSha256: digest, outputSha256: digest,
    output: z.record(z.string(), z.json()),
    reason: z.string().min(1).max(4096),
  }).optional(),
  definition: z.record(z.string(), z.json()),
  contentHash: digest,
  runId: z.string().regex(/^action_run_[a-f0-9]{32}$/).nullable(),
  inputs: z.record(z.string(), z.json()),
  executable: z.strictObject({ path: z.string().min(1).max(4096), sha256: digest }).nullable(),
  arguments: z.array(z.string().max(32768)).max(128),
  sourceFiles: z.array(z.strictObject({ path: z.string().min(1).max(4096), sha256: digest })).max(128),
  configurationSha256: digest.nullable(),
  localPath: z.strictObject({ kind: z.enum(["source", "destination"]), path: z.string().min(1).max(4096),
    parentPin: z.string().min(1).max(1024), entryKind: z.enum(["file", "directory"]).nullable(),
    sha256: digest.nullable() }).nullable(),
  deadline: z.number().safe().int().positive(),
  automaticReplay: z.literal(false),
});
export const registeredActionDecision = z.strictObject({
  requestSha256: digest, decisionId: z.string().uuid(), expiresAtMs: z.number().safe().int().positive(),
  decision: z.enum(["approve", "deny"]),
});
