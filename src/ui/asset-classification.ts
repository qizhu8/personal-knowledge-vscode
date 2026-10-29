import * as vscode from "vscode";
import { getStorePath } from "../knowledge/filestore";
import { previewAssetClassification, applyAssetClassification, rollbackAssetClassification } from "../knowledge/asset-classification";

/** Dedicated review keeps classification independent of panel and inline-editor state. */
export async function reviewAssetClassification(): Promise<void> {
  try {
    const root = getStorePath();
    const preview = previewAssetClassification(root);
    const suggestions = preview.proposals.filter(p => p.type !== "classification");
    if (suggestions.length) {
      const review = await vscode.window.showQuickPick([
        { label: "Review duplicate/correction suggestions", value: "suggestions" },
        { label: "Review metadata classifications", value: "classifications" },
      ], { title: `PKM: ${suggestions.length} review-only suggestions; nothing has changed` });
      if (!review) return;
      if (review.value === "suggestions") {
        await vscode.window.showQuickPick(suggestions.map(p => ({ label: `${p.type}: ${p.asset}`, description: p.relatedAsset,
          detail: `${p.suggestion} Evidence: ${p.evidence.map(e => `${e.rule} (${Math.round(e.confidence * 100)}%)`).join(", ")}` })),
        { title: "Review only — no merge, correction, or deletion will be executed", matchOnDetail: true });
      }
    }
    const picked = await vscode.window.showQuickPick(preview.proposals.filter(p => p.type === "classification").map(p => ({
      label: p.asset, description: Object.entries(p.classification).map(([key, value]) => `${key}=${value}`).join("; "),
      detail: p.evidence.map(e => `${e.dimension}: ${e.rule} (${Math.round(e.confidence * 100)}%)`).join("; "), proposal: p,
    })), { canPickMany: true, matchOnDescription: true, matchOnDetail: true,
      title: `PKM dry-run: select approved metadata changes (${preview.skipped} excluded${preview.truncated ? "; scan/suggestion budget reached" : ""}); select all is supported` });
    if (!picked?.length) return;
    if (await vscode.window.showWarningMessage(`Apply metadata to ${picked.length} approved assets? No files will move.`, { modal: true }, "Apply approved subset") !== "Apply approved subset") return;
    const result = applyAssetClassification(root, preview, picked.map(item => item.proposal.id));
    const response = await vscode.window.showInformationMessage(`Classification: ${result.applied.length} applied, ${result.skipped.length} skipped. Rollback journal: ${result.journalId}`, "Rollback now");
    if (response === "Rollback now") {
      const rolled = rollbackAssetClassification(root, result.journalId);
      await vscode.window.showInformationMessage(`Rollback: ${rolled.applied.length} restored, ${rolled.skipped.length} skipped.`);
    }
  } catch { await vscode.window.showErrorMessage("Asset classification failed. No asset content was logged; retained journals support recovery."); }
}
export async function reviewAssetClassificationRollback(): Promise<void> {
  const id = await vscode.window.showInputBox({ title: "PKM: Roll back asset classification", prompt: "Journal ID returned by apply (restores only unchanged metadata)" });
  if (!id) return;
  try {
    const result = rollbackAssetClassification(getStorePath(), id);
    await vscode.window.showInformationMessage(`Rollback: ${result.applied.length} restored, ${result.skipped.length} skipped.`);
  } catch { await vscode.window.showErrorMessage("Classification journal unavailable or invalid."); }
}
