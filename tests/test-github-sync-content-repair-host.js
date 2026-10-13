#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const repair = require("../dist/sync/github-sync-content-repair");
const { sameKnowledgeRoot } = require("../dist/sync/github-sync-coordinator");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-repair-host-"));
const directory = path.join(root, "state");
const source = path.join(root, "Example.script");
const original = "before\r\n<<<<<<< local\r\n\r\n=======\r\n>>>>>>> remote\r\nafter\r\n";
fs.writeFileSync(source, original);
const issue = {
  path: "scripts/Example.script", type: "scripts", itemId: "Example", source: "local", reason: "merge-conflict-markers",
  ...repair.inspectConflictMarkers(original), digest: repair.contentRepairDigest(original), content: original, sourcePath: source,
};
const record = repair.storeGitHubSyncContentRepair(directory, new repair.GitHubSyncContentRepairError("primary", [issue]));
const calls = [];
let approve = false;
let dirty = false;
let editDuringApproval = false;
const extension = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
const start = extension.indexOf('    case "githubSyncRepairOpen":');
const end = extension.indexOf('    case "githubSyncPickIdentity":', start);
assert(start > 0 && end > start);
const context = vm.createContext({
  ...repair, sameKnowledgeRoot, fs, path, Error,
  githubSyncTargetById: () => ({ id: "primary" }),
  githubSyncStateDirectory: () => directory,
  getStorePath: () => root,
  withGitHubSyncTargetLock: async (_context, _targetId, action) => action(),
  withGitHubSyncApplyLock: async (_context, action) => action(),
  invalidateSharedContentCatalog: () => calls.push(["invalidate"]),
  githubSyncStateData: async () => ({}),
  githubSyncScheduler: { request: async (...args) => { calls.push(["request", ...args]); return true; } },
  githubSyncDiagnostics: { record: (...args) => calls.push(["diagnostic", ...args]) },
  respond: response => calls.push(["response", response]),
  vscode: {
    Uri: { file: file => file },
    Range: class { constructor(line) { this.line = line; } },
    workspace: {
      openTextDocument: async file => file,
      get textDocuments() { return dirty ? [{ isDirty: true, uri: { scheme: "file", fsPath: source } }] : []; },
    },
    window: {
      showTextDocument: async (...args) => calls.push(["open", ...args]),
      showWarningMessage: async () => { if (editDuringApproval) dirty = true; return approve ? "Apply empty-block cleanup" : undefined; },
    },
    commands: { executeCommand: async (...args) => calls.push(["command", ...args]) },
  },
});
vm.runInContext(ts.transpileModule(`async function handle(msg) { const context = {}; switch(msg.command) {
${extension.slice(start, end)}
} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
const invoke = command => context.handle({ command, targetId: "primary", repairId: record.id, path: issue.path });
(async () => {
  await invoke("githubSyncRepairOpen");
  assert.equal(calls.find(call => call[0] === "open")[2].selection.line, 1);
  await invoke("githubSyncRepairPreview");
  const preview = calls.find(call => call[0] === "command");
  assert.equal(preview[1], "vscode.diff");
  assert.equal(fs.readFileSync(preview[2], "utf8"), original);
  assert.equal(fs.readFileSync(preview[3], "utf8"), "before\r\nafter\r\n");
  assert.equal(fs.readFileSync(source, "utf8"), original, "preview is read-only");
  await invoke("githubSyncRepairApply");
  assert.equal(fs.readFileSync(source, "utf8"), original, "cancelling approval never changes the source");
  approve = true;
  dirty = true;
  await assert.rejects(() => invoke("githubSyncRepairApply"), /unsaved/);
  dirty = false;
  editDuringApproval = true;
  await assert.rejects(() => invoke("githubSyncRepairApply"), /unsaved/);
  assert.equal(fs.readFileSync(source, "utf8"), original, "edits made while approval is open must also block replacement");
  dirty = false;
  editDuringApproval = false;
  await invoke("githubSyncRepairApply");
  assert.equal(fs.readFileSync(source, "utf8"), "before\r\nafter\r\n");
  assert.equal(calls.filter(call => call[0] === "request").length, 0, "cleanup does not silently trigger a push");
  assert(repair.readGitHubSyncContentRepair(directory, "primary"), "repair remains pending until actual revalidation succeeds");
  await invoke("githubSyncRepairRevalidate");
  const invalidate = calls.findLastIndex(call => call[0] === "invalidate");
  const request = calls.findLastIndex(call => call[0] === "request");
  assert(request > invalidate, "revalidation invalidates caches before submitting a fresh normal Sync");
  assert.deepEqual(calls[request], ["request", "primary", "manual"]);
  await assert.rejects(() => context.handle({ command: "githubSyncRepairOpen", targetId: "primary", repairId: "old" }), /repair list changed/);
  console.log("GitHub Sync content repair Host actions passed");
})().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch(error => {
  console.error(error); process.exitCode = 1;
});
