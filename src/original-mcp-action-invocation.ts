import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { assertStorage, type Storage } from "./storage.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { originalMcpRequestDigest } from "./original-mcp-native-host.js";
import { originalActionCall } from "./original-mcp-action-call-contracts.js";
import { originalActionProgramRequest, originalActionProgramDecision } from "./original-mcp-action-program-contracts.js";
import { originalDigest } from "./domain/action-compiler-validation.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export { originalActionCall } from "./original-mcp-action-call-contracts.js";
const invocation = z.strictObject({
  schema: z.literal("pkm.original-mcp-action-invocation/v1"),
  workspaceId: z.string().uuid(), actorId: z.literal("mcp:external"),
  sourceReceiptSha256: digest, capsuleSha256: digest, implementationSha256: digest, sourceSnapshotSha256: digest,
  request: originalActionCall, requestSha256: digest,
  runId: z.string().regex(/^action_run_[a-f0-9]{32}$/), operationId: z.string().uuid(),
  deadline: z.number().safe().int().positive(), nativeActionEpoch: z.string().min(1),
  approvedAt: z.number().safe().int().positive(), receiptSha256: digest,
  localProgram: z.strictObject({ request: originalActionProgramRequest, decision: originalActionProgramDecision }).optional(),
});
export type OriginalActionInvocation = z.infer<typeof invocation>;
const ddl = `
CREATE TABLE original_mcp_action_invocations(
 receipt_sha256 TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,actor_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,run_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,
 UNIQUE(workspace_id,actor_id,idempotency_key));
CREATE TRIGGER original_mcp_action_invocations_no_update BEFORE UPDATE ON original_mcp_action_invocations
BEGIN SELECT RAISE(ABORT,'Action invocation receipt immutable'); END;
CREATE TRIGGER original_mcp_action_invocations_no_delete BEFORE DELETE ON original_mcp_action_invocations
BEGIN SELECT RAISE(ABORT,'Action invocation receipt immutable'); END;`;
export const originalActionInvocationDdl = ddl;
function schema(database: DatabaseSync) {
  const rows = (db: DatabaseSync) => db.prepare(
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'original_mcp_action_invocations%' ORDER BY name").all();
  const actual = rows(database);
  if (!actual.length) return false;
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(ddl);
    if (canonicalJson(actual) !== canonicalJson(rows(expected)))
      throw new CoreError("RECOVERY_CONFLICT", "The immutable Action invocation schema changed.");
  } finally { expected.close(); }
  return true;
}
function decode(row: Record<string, unknown>, workspaceId: string): OriginalActionInvocation {
  const value = invocation.parse(JSON.parse(String(row.payload))), { receiptSha256, ...body } = value;
  if (value.workspaceId !== workspaceId || value.actorId !== "mcp:external"
    || value.workspaceId !== row.workspace_id || value.actorId !== row.actor_id
    || value.request.idempotency_key !== row.idempotency_key || value.runId !== row.run_id
    || receiptSha256 !== row.receipt_sha256 || receiptSha256 !== originalMcpRequestDigest(body)
    || value.requestSha256 !== originalMcpRequestDigest(value.request) || canonicalJson(value) !== row.payload
    || value.localProgram && (value.localProgram.request.runId !== value.runId
      || value.localProgram.request.workspaceId !== value.workspaceId || value.localProgram.request.epoch !== value.nativeActionEpoch
      || value.localProgram.request.sourceReceiptSha256 !== value.sourceReceiptSha256
      || value.localProgram.request.capsuleSha256 !== value.capsuleSha256
      || value.localProgram.request.implementationSha256 !== value.implementationSha256
      || originalDigest(value.localProgram.request.request) !== originalDigest(value.request)
      || value.localProgram.decision.requestSha256 !== originalDigest(value.localProgram.request)
      || value.localProgram.decision.runId !== value.runId
      || value.localProgram.decision.root !== value.localProgram.request.root
      || value.localProgram.decision.workspaceId !== value.workspaceId
      || value.localProgram.decision.actorId !== value.actorId
      || value.localProgram.decision.profileSha256 !== value.localProgram.request.profileSha256
      || value.localProgram.decision.epoch !== value.nativeActionEpoch
      || value.localProgram.decision.capsuleSha256 !== value.capsuleSha256
      || value.localProgram.decision.executableSha256 !== value.localProgram.request.executable.sha256))
    throw new CoreError("RECOVERY_CONFLICT", "Action invocation lost its exact owner/request/source binding.");
  return value;
}
export function readOriginalActionInvocations(storage: Storage, workspaceId: string): OriginalActionInvocation[] {
  assertStorage(storage); storage.assertWorkspaceLease();
  const database = storage.connectNative();
  try { return readOriginalActionInvocationsMetadata(database, workspaceId); }
  finally { database.close(); }
}
export function readOriginalActionInvocationsMetadata(database: DatabaseSync, workspaceId: string): OriginalActionInvocation[] {
  if (!schema(database)) return [];
  return database.prepare("SELECT * FROM original_mcp_action_invocations ORDER BY run_id").all()
    .map(row => decode(row, workspaceId));
}
/** The receipt records consumed admission, never a restorable effect grant. */
export function appendOriginalActionInvocation(database: DatabaseSync,
  input: Omit<OriginalActionInvocation, "receiptSha256">): OriginalActionInvocation {
  if (!database.isTransaction) throw new CoreError("TRANSACTION_BOUNDARY", "Invocation intent requires its owner transaction.");
  if (!schema(database)) database.exec(ddl);
  const value = invocation.parse({ ...input, receiptSha256: originalMcpRequestDigest(input) });
  database.prepare("INSERT INTO original_mcp_action_invocations VALUES(?,?,?,?,?,?)")
    .run(value.receiptSha256, value.workspaceId, value.actorId, value.request.idempotency_key, value.runId, canonicalJson(value));
  return value;
}
