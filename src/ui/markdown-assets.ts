import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
  applyMarkdownAssetMigration, checkedMarkdownPath, editMarkdownAsset, MarkdownAssetArea,
  markdownAssetDirectory, previewMarkdownAssetMigration, listedMarkdownAssets, saveMarkdownAsset, missingLegacyMarkdownAssets,
} from "../knowledge/markdown-assets";
import { getStorePath, knowledgeMarkdownCopy, parseStoreFrontmatter, writeKnowledgeMarkdown } from "../knowledge/filestore";
import { buildSyncBundle, emptySyncSelection } from "../sync/sync-server";

export async function manageMarkdownAssets(area: MarkdownAssetArea, documentPath: string): Promise<boolean> {
  const root = getStorePath();
  const full = checkedMarkdownPath(path.join(root, area), documentPath);
  const content = fs.readFileSync(full, "utf8");
  const assets = listedMarkdownAssets(root, area, documentPath, content);
  const selection = await vscode.window.showQuickPick([
    { label: "$(add) Add resource", operation: "add" },
    { label: "$(files) Copy document with resources", operation: "copy" },
    { label: "$(export) Export document with resources", operation: "export" },
    { label: "$(preview) Preview legacy resource migration", operation: "migrate" },
    ...(missingLegacyMarkdownAssets(root, area, documentPath, content).length
      ? [{ label: "$(warning) Repair missing legacy resource", operation: "repair" }] : []),
    ...assets.map(asset => ({ label: asset.path, operation: "asset", asset })),
  ], { title: `${documentPath} resources`, placeHolder: "Previewing resources never migrates or deletes original files." });
  if (!selection) return false;
  if (selection.operation === "export") {
    const target = await vscode.window.showSaveDialog({ title: "Export Markdown document and resources", filters: { "PKM Knowledge bundle": ["json"] } });
    if (!target) return false;
    const selected = emptySyncSelection();
    selected[area] = [area === "skills" ? String(parseStoreFrontmatter(content).fm.name || path.basename(documentPath, ".md")) : documentPath.replace(/\.md$/i, "")];
    const bundle = buildSyncBundle(selected, [area]);
    await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(bundle, null, 2)));
    return false;
  }
  if (selection.operation === "asset" && "asset" in selection) {
    const asset = selection.asset;
    const owned = asset.path.startsWith(markdownAssetDirectory(documentPath) + "/");
    const operation = await vscode.window.showQuickPick(owned ? ["Preview", "Rename", "Delete unused resource"] : ["Preview"], { title: asset.path });
    if (!operation) return false;
    if (operation === "Preview") {
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(asset.fullPath));
      return false;
    }
    assertWritable(full);
    if (operation === "Rename") {
      const name = await vscode.window.showInputBox({ title: "Rename resource and its Markdown references", value: path.basename(asset.path) });
      if (!name || name === path.basename(asset.path)) return false;
      editMarkdownAsset(root, area, documentPath, asset.path, name);
    } else {
      const approve = await vscode.window.showWarningMessage(`Delete ${asset.path}? Referenced or shared resources will be refused.`, { modal: true }, "Delete");
      if (approve !== "Delete") return false;
      editMarkdownAsset(root, area, documentPath, asset.path);
    }
    return true;
  }
  if (selection.operation === "migrate" || selection.operation === "repair") {
    let sourceOverrides: Record<string, string> | undefined;
    if (selection.operation === "repair") {
      const missing = await vscode.window.showQuickPick(missingLegacyMarkdownAssets(root, area, documentPath, content),
        { title: "Choose the missing resource reference" });
      if (!missing) return false;
      const files = await vscode.window.showOpenDialog({ title: "Select the original resource within this content root",
        canSelectMany: false, canSelectFolders: false, canSelectFiles: true });
      if (!files?.length) return false;
      if (files[0].scheme !== "file") throw new Error("The original resource must be local to this Extension Host.");
      sourceOverrides = { [missing]: path.relative(path.resolve(root, area), files[0].fsPath).replace(/\\/g, "/") };
    }
    const preview = previewMarkdownAssetMigration(root, area, documentPath, sourceOverrides);
    const document = await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify(preview, null, 2) });
    await vscode.window.showTextDocument(document, { preview: true });
    if (!preview.copies.length) { vscode.window.showInformationMessage("No legacy resources need migration."); return false; }
    const approve = await vscode.window.showWarningMessage(
      `Migrate ${preview.copies.length} legacy resource(s) into ${markdownAssetDirectory(documentPath)} and update this document? ${preview.removals.length} unshared original(s) will be removed; shared originals remain until their final reference migrates.`,
      { modal: true }, "Apply reviewed migration");
    if (approve !== "Apply reviewed migration") return false;
    assertWritable(full);
    applyMarkdownAssetMigration(root, preview);
    return true;
  }
  assertWritable(full);
  if (selection.operation === "copy") {
    const name = await vscode.window.showInputBox({ title: "New Markdown filename", value: path.basename(documentPath, ".md") + " copy" });
    if (!name) return false;
    if (path.basename(name) !== name || /[\\/:*?"<>|\u0000-\u001f]/.test(name) || name.startsWith(".")) throw new Error("Choose a document name without path separators or reserved characters.");
    const destination = path.posix.join(path.posix.dirname(documentPath), name.replace(/\.md$/i, "") + ".md");
    knowledgeMarkdownCopy(area, documentPath, destination);
    return true;
  }
  const files = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFolders: false, title: "Add resources to this Markdown document" });
  if (!files?.length) return false;
  let markdown = fs.readFileSync(full, "utf8");
  const original = markdown;
  for (const file of files) {
    if (file.scheme !== "file") throw new Error("Resources must be local files on this Extension Host.");
    const relative = saveMarkdownAsset(root, area, documentPath, path.basename(file.fsPath), fs.readFileSync(file.fsPath));
    const image = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(file.fsPath);
    markdown += `\n${image ? "!" : ""}[${path.basename(file.fsPath).replace(/[\[\]\\]/g, "\\$&")}](${relative})\n`;
  }
  if (fs.readFileSync(full, "utf8") !== original) throw new Error("The document changed while adding resources. Resources are retained, but references were not overwritten.");
  writeKnowledgeMarkdown(area, documentPath, undefined, markdown);
  return true;
}

function assertWritable(full: string): void {
  if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before changing Markdown resources.");
  if (vscode.workspace.textDocuments.some(document => document.uri.fsPath === full && document.isDirty)) {
    throw new Error("Save the open Markdown document before changing its resources.");
  }
}
