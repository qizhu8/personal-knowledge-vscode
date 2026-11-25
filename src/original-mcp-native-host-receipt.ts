import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import type { OriginalMcpJournal } from "./original-mcp-root-custody.js";
import { verifyOriginalMcpOptionalSchemaGroup } from "./original-mcp-sqlite-schema.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const originalMcpNativeHostReceiptSchema = z.strictObject({
  schema: z.literal("pkm.original-mcp-native-host-admission/v1"),
  root: z.string(), workspaceId: z.string().uuid(), planSha256: digest, profileSha256: digest,
  sourceCatalogSha256: digest, authorityId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  epoch: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/), actorId: z.literal("mcp:external"),
  domains: z.array(z.enum(["model-provider", "tool-approval", "mcp-public", "api-chat-native"])).min(1).max(4),
  configurationSha256: digest, receiptSha256: digest,
});
export type OriginalMcpNativeHostReceipt = z.infer<typeof originalMcpNativeHostReceiptSchema>;
export const originalMcpNativeHostReceiptTable = "original_mcp_native_host_admissions";
export const originalMcpNativeHostReceiptDdl = `CREATE TABLE original_mcp_native_host_admissions(
 receipt_sha256 TEXT PRIMARY KEY,payload TEXT NOT NULL);
 CREATE TRIGGER original_mcp_native_host_admissions_no_update BEFORE UPDATE ON original_mcp_native_host_admissions
 BEGIN SELECT RAISE(ABORT,'native original MCP host admission immutable'); END;
 CREATE TRIGGER original_mcp_native_host_admissions_no_delete BEFORE DELETE ON original_mcp_native_host_admissions
 BEGIN SELECT RAISE(ABORT,'native original MCP host admission immutable'); END;`;
export const originalMcpNativeHostReceiptDigest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

export function verifyOriginalMcpNativeHostReceiptSchema(database: DatabaseSync) {
  const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name=? ORDER BY name")
    .all(originalMcpNativeHostReceiptTable);
  verifyOriginalMcpOptionalSchemaGroup(schema, originalMcpNativeHostReceiptDdl, [originalMcpNativeHostReceiptTable]);
}
/** Historical metadata only; this never constructs a live Host or restores native grants. */
export function verifyOriginalMcpNativeHostReceiptDatabase(database: DatabaseSync, journal: OriginalMcpJournal,
  expectedSha256: string): OriginalMcpNativeHostReceipt {
  if (!digest.safeParse(expectedSha256).success) fail();
  verifyOriginalMcpNativeHostReceiptSchema(database);
  const row = database.prepare(`SELECT payload FROM ${originalMcpNativeHostReceiptTable} WHERE receipt_sha256=?`).get(expectedSha256);
  let parsed: unknown;
  try { parsed = typeof row?.payload === "string" ? JSON.parse(row.payload) : null; }
  catch { fail(); }
  const receipt = originalMcpNativeHostReceiptSchema.safeParse(parsed);
  if (!receipt.success) fail();
  const value = receipt.data, { receiptSha256, ...body } = value;
  if (row!.payload !== canonicalJson(value) || originalMcpNativeHostReceiptDigest(body) !== receiptSha256
    || receiptSha256 !== expectedSha256 || value.root !== journal.plan.root || value.workspaceId !== journal.workspaceId
    || value.planSha256 !== journal.plan.planSha256 || value.profileSha256 !== journal.plan.profileSha256) fail();
  return value;
}
function fail(): never {
  throw new CoreError("ACCESS_DENIED", "The exact original-root/native-profile/model or approval authority is unavailable or changed.");
}
