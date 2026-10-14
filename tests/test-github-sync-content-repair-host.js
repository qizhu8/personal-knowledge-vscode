#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const repair = require("../dist/sync/github-sync-content-repair");
const { createHash, randomUUID } = require("node:crypto");
const { canonicalJson } = require("../dist/workflows/workflow-contracts");
const { initializeProjectModel } = require("../dist/workflows/project-model");
const { ProjectStore } = require("../dist/workflows/project-store");
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
let projectStore;
const extension = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
const start = extension.indexOf('    case "githubSyncRepairOpen":');
const end = extension.indexOf('    case "githubSyncPickIdentity":', start);
assert(start > 0 && end > start);
const context = vm.createContext({
  ...repair, sameKnowledgeRoot, fs, path, Error, createHash, randomUUID, canonicalJson,
  currentProjectStore: () => projectStore,
  openRecipeEditorInBrowser: async recipeId => { calls.push(["recipe-editor", recipeId]); return true; },
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
      showWarningMessage: async (...args) => { if (editDuringApproval) dirty = true; return approve ? args.at(-1) : undefined; },
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
  const state = path.join(root, ".pkm/state");
  fs.mkdirSync(state, { recursive: true });
  const definition = { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, nodes: [
    { nodeId: "z", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] },
    { nodeId: "a", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "z" }] },
  ], outputs: {}, completion: { requiredNodes: ["a"] } } };
  const hash = value => createHash("sha256").update(canonicalJson(value)).digest("hex");
  const recipe = { recipeId: "recipe_legacy", scope: "global", category: "Examples", name: "Legacy", description: "",
    revision: 1, definition, executableDigest: hash(definition) };
  const payload = { state: { ...initializeProjectModel(undefined, () => "root"), recipes: [recipe] }, receipts: [] };
  fs.writeFileSync(path.join(state, "projects.json"), JSON.stringify({ schema: 1, storeVersion: 1, payload, digest: hash(payload) }));
  projectStore = new ProjectStore(state, () => "root", { autoMigrate: false });
  const recipeIssue = { path: "recipes/Examples/Legacy.recipe_legacy.json", type: "recipes", itemId: recipe.recipeId,
    recipeId: recipe.recipeId, source: "local", reason: "recipe-digest", lines: [],
    content: JSON.stringify(recipe), digest: repair.contentRepairDigest(JSON.stringify(recipe)),
    error: "Recipe executable digest is invalid" };
  const recipeRecord = repair.storeGitHubSyncContentRepair(directory, new repair.GitHubSyncContentRepairError("primary", [recipeIssue]));
  const recipeInvoke = command => context.handle({ command, targetId: "primary", repairId: recipeRecord.id,
    path: recipeIssue.path, reason: recipeIssue.reason });
  await recipeInvoke("githubSyncRepairOpen");
  assert(calls.some(call => call[0] === "recipe-editor" && call[1] === recipe.recipeId), "generated Recipes route to the real Recipe editor");
  await assert.rejects(() => recipeInvoke("githubSyncRecipeRecompileApply"), /Preview the Recipe/);
  await recipeInvoke("githubSyncRecipeRecompilePreview");
  assert.equal(projectStore.list().recipes.find(item => item.recipeId === recipe.recipeId).revision, 1);
  approve = false;
  await recipeInvoke("githubSyncRecipeRecompileApply");
  assert.equal(projectStore.list().recipes.find(item => item.recipeId === recipe.recipeId).revision, 1);
  const requestsBefore = calls.filter(call => call[0] === "request").length;
  approve = true;
  await recipeInvoke("githubSyncRecipeRecompileApply");
  assert.equal(projectStore.list().recipes.find(item => item.recipeId === recipe.recipeId).revision, 2);
  assert.equal(calls.filter(call => call[0] === "request").length, requestsBefore, "approved recompile does not sync or push");
  assert(repair.readGitHubSyncContentRepair(directory, "primary"), "recompile still requires revalidation");
  console.log("GitHub Sync content repair Host actions passed");
})().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch(error => {
  console.error(error); process.exitCode = 1;
});
