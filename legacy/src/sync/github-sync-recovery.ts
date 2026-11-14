import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type { PkmServiceRecoveryReceipt } from "../runtime/pkm-service";
import { validateGitHubSyncTransaction, type GitHubSyncResult, type GitHubSyncTarget } from "./github-sync";

/** Preserve superseded results without rolling current content or conflict choices back. */
export function archiveSupersededGitHubSyncResult(
  stateDirectory: string, receipt: PkmServiceRecoveryReceipt, target: GitHubSyncTarget, result: GitHubSyncResult,
): string | undefined {
  const checkoutRoot = path.join(stateDirectory, "checkouts");
  const latest = JSON.parse(fs.readFileSync(path.join(checkoutRoot, target.id, "transactions", "latest.json"), "utf8"));
  if (latest.transactionId === result.transactionId) return undefined;
  const baseline = target.lastSync;
  if (latest.state !== "recorded" || !baseline || baseline.repository !== target.repository
    || baseline.branch !== target.branch || baseline.commit !== latest.pushedCommit) return undefined;
  validateGitHubSyncTransaction(checkoutRoot, target.id, latest.transactionId, {
    repository: target.repository, branch: target.branch, commit: baseline.commit,
  });
  if (!result.transactionId || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(result.commit)
    || receipt.targetId !== target.id || receipt.repository !== target.repository || receipt.branch !== target.branch
    || !/^[a-f0-9-]{36}$/i.test(receipt.operationId)) {
    throw new Error("Cannot archive a superseded GitHub Sync result with invalid identity. Preserve its recovery record for review.");
  }
  const directory = path.join(stateDirectory, "superseded-results");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, `${receipt.operationId}.json`);
  const originalReceipt = fs.readFileSync(receipt.receiptPath, "utf8");
  if (fs.existsSync(destination)) {
    const archived = JSON.parse(fs.readFileSync(destination, "utf8"));
    if (archived.operationId !== receipt.operationId || archived.targetId !== target.id
      || archived.originalReceipt !== originalReceipt || archived.transactionId !== result.transactionId) {
      throw new Error("Superseded GitHub Sync archive does not match the recovery record; nothing was acknowledged.");
    }
    return destination;
  }
  const temporary = `${destination}.${randomUUID()}.staging`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({
        schema: 1, archivedAt: new Date().toISOString(), operationId: receipt.operationId, targetId: target.id,
        transactionId: result.transactionId, supersededBy: latest.transactionId, commit: result.commit,
        originalReceipt,
      }) + "\n");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, destination);
  } finally { fs.rmSync(temporary, { force: true }); }
  return destination;
}
