#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const store = require("../dist/knowledge/filestore");
const assets = require("../dist/knowledge/markdown-assets");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-assets-native-ui-"));
let trusted = true, selections = [], approval, input, files, exportPath;
const opened = [], previews = [];
const vscode = {
  Uri: { file: fsPath => ({ scheme: "file", fsPath }) },
  commands: { async executeCommand(command, uri) { opened.push([command, uri.fsPath]); } },
  workspace: {
    get isTrusted() { return trusted; }, textDocuments: [],
    async openTextDocument(options) { previews.push(options); return options; },
    fs: { async writeFile(uri, content) { fs.writeFileSync(uri.fsPath, content); } },
  },
  window: {
    async showQuickPick(items) {
      const selected = selections.shift();
      return typeof selected === "function" ? items.find(selected) : selected;
    },
    async showTextDocument() {}, async showWarningMessage() { return approval; },
    showInformationMessage() {}, async showInputBox() { return input; },
    async showOpenDialog() { return files; }, async showSaveDialog() { return { fsPath: exportPath }; },
  },
};
const originalLoad = Module._load;
let manageMarkdownAssets;
try {
  Module._load = function(name, ...args) { return name === "vscode" ? vscode : originalLoad.call(this, name, ...args); };
  ({ manageMarkdownAssets } = require("../dist/ui/markdown-assets"));
} finally { Module._load = originalLoad; }

async function main() {
  store.setStorePath(root);
  for (const area of ["skills", "notes", "papers"]) {
    const full = path.join(root, area, "Team", "Design.md");
    store.writeKnowledgeMarkdown(area, "Team/Design.md", undefined, `---\n${area === "skills" ? "name" : "title"}: Design\n---\n\nBody\n`);
    assets.saveMarkdownAsset(root, area, "Team/Design.md", "plot.png", Buffer.from("plot"));
    const own = path.join(root, area, "Team", "Design.assets");
    selections = [item => item.operation === "asset", "Preview"];
    trusted = false;
    assert.equal(await manageMarkdownAssets(area, "Team/Design.md"), false);
    assert.equal(opened.at(-1)[1], path.join(own, "plot.png"), "Read-only native preview works without authorizing mutations");
    selections = [item => item.operation === "add"];
    await assert.rejects(manageMarkdownAssets(area, "Team/Design.md"), /Trust/);
    trusted = true;
    vscode.workspace.textDocuments = [{ uri: { fsPath: full }, isDirty: true }];
    selections = [item => item.operation === "add"];
    await assert.rejects(manageMarkdownAssets(area, "Team/Design.md"), /Save the open/);
    vscode.workspace.textDocuments = [];
    const upload = path.join(root, "upload.png"); fs.writeFileSync(upload, "uploaded");
    files = [{ scheme: "file", fsPath: upload }];
    selections = [item => item.operation === "add"];
    assert.equal(await manageMarkdownAssets(area, "Team/Design.md"), true);
    assert(fs.readFileSync(full, "utf8").includes("![upload.png](Design.assets/upload.png)"));

    const legacy = path.join(root, area, "Team", "_assets");
    fs.mkdirSync(legacy, { recursive: true }); fs.writeFileSync(path.join(legacy, "old.png"), "legacy");
    fs.appendFileSync(full, "\n![old](_assets/old.png)\n");
    const before = fs.readFileSync(full);
    selections = [item => item.operation === "migrate"]; approval = undefined;
    assert.equal(await manageMarkdownAssets(area, "Team/Design.md"), false);
    assert.deepEqual(fs.readFileSync(full), before, "Cancelling a migration preview never changes the document");
    assert.equal(JSON.parse(previews.at(-1).content).copies.length, 1);
    selections = [item => item.operation === "migrate"]; approval = "Apply reviewed migration";
    assert.equal(await manageMarkdownAssets(area, "Team/Design.md"), true);
    assert(!fs.existsSync(path.join(legacy, "old.png")), "Approved migration removes an unshared original after owning its bytes");
    assert(!fs.readFileSync(full, "utf8").includes("_assets/old.png"));

    const recovery = path.join(root, area, "Team", "Recovery.md");
    fs.writeFileSync(recovery, "![missing](_assets/missing.png)\n");
    const originalResource = path.join(legacy, "source.png");
    fs.writeFileSync(originalResource, "recovered bytes");
    files = [{ scheme: "file", fsPath: originalResource }];
    selections = [item => item.operation === "repair", "Team/_assets/missing.png"];
    approval = "Apply reviewed migration";
    assert.equal(await manageMarkdownAssets(area, "Team/Recovery.md"), true);
    assert(fs.readFileSync(recovery, "utf8").includes("Recovery.assets/"));
    assert(!fs.existsSync(originalResource));
    assert.equal(assets.referencedMarkdownAssets(root, area, "Team/Recovery.md", fs.readFileSync(recovery, "utf8"))[0].content.toString(), "recovered bytes");

    selections = [item => item.operation === "copy"]; input = "Copy";
    assert.equal(await manageMarkdownAssets(area, "Team/Design.md"), true);
    assert(fs.existsSync(path.join(root, area, "Team", "Copy.assets", "upload.png")));
    selections = [item => item.operation === "asset" && item.asset.path.endsWith("/upload.png"), "Rename"]; input = "renamed.png";
    assert.equal(await manageMarkdownAssets(area, "Team/Design.md"), true);
    assert(fs.readFileSync(full, "utf8").includes("Design.assets/renamed.png"));
    selections = [item => item.operation === "asset" && item.asset.path.endsWith("/plot.png"), "Delete unused resource"]; approval = "Delete";
    assert.equal(await manageMarkdownAssets(area, "Team/Design.md"), true);
    assert(!fs.existsSync(path.join(own, "plot.png")));

    exportPath = path.join(root, `${area}.json`);
    selections = [item => item.operation === "export"];
    assert.equal(await manageMarkdownAssets(area, "Team/Design.md"), false);
    const bundle = JSON.parse(fs.readFileSync(exportPath, "utf8"));
    assert.equal(bundle[area].length, 1);
    assert(bundle.assets.some(asset => asset.path === "Team/Design.assets/renamed.png"), "Native export includes the original owned resources");
    const destination = path.join(root, `import-${area}`);
    assets.importMarkdownAssetBundle(destination, bundle.assets, assets.markdownBundleDocuments(bundle));
    assert.equal(fs.readFileSync(path.join(destination, area, "Team", "Design.assets", "renamed.png"), "utf8"), "uploaded");
  }
}
main().then(() => console.log("Native Markdown resource UI: all three types, read-only preview, trust/dirty guards, explicit migration, copy/rename/delete, export and import passed"))
  .finally(() => fs.rmSync(root, { recursive: true, force: true }))
  .catch(error => { console.error(error); process.exitCode = 1; });
