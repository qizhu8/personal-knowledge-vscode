import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CoreError } from "./contracts.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import type { OriginalMcpJournal } from "./original-mcp-root-custody.js";
import { verifyOriginalMcpNativeHostReceiptDatabase } from "./original-mcp-native-host-receipt.js";
import { originalRecipeSourceApproval, originalRecipeSourceApprovalRequest,
  type OriginalRecipeUsageSource, type OriginalRecipeTerminalSource,
  type OriginalRecipeLibrarySource, type OriginalNativeRecipeLibrarySource } from "./original-mcp-recipe-source-contracts.js";

/** Match retained admission evidence only; never restores a source session, policy or grant. */
export function readOriginalMcpRecipeHistoricalHost(database: DatabaseSync, journal: OriginalMcpJournal,
  source: OriginalRecipeUsageSource | OriginalRecipeTerminalSource | OriginalRecipeLibrarySource | OriginalNativeRecipeLibrarySource,
  decision: string, expectedHostSha256?: string) {
  const approval = originalRecipeSourceApproval.parse(JSON.parse(decision));
  if (decision !== canonicalJson(approval)) fail();
  const names = database.prepare("SELECT receipt_sha256 FROM original_mcp_native_host_admissions LIMIT 4097").all();
  if (names.length > 4096) fail();
  const matches = names.filter(row => !expectedHostSha256 || row.receipt_sha256 === expectedHostSha256).flatMap(row => {
    const host = verifyOriginalMcpNativeHostReceiptDatabase(database, journal, String(row.receipt_sha256));
    const request = originalRecipeSourceApprovalRequest.parse({ ...source, phase: "admit", actorId: "mcp:external",
      epoch: host.epoch, nativeHostReceiptSha256: host.receiptSha256, noExecution: true });
    const digest = createHash("sha256").update(canonicalJson(request)).digest("hex");
    return host.domains.includes("mcp-public") && digest === approval.requestSha256 ? [host] : [];
  });
  if (matches.length !== 1) fail();
  return matches[0]!;
}
function fail(): never {
  throw new CoreError("RECOVERY_REQUIRED", "Historical Recipe source has no exact original custody/native admission binding.");
}
