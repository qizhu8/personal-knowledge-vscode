#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const ts = require("typescript");
const { randomUUID, createHash } = require("node:crypto");
const { GitHubSyncConflictError, GitHubSyncExtensionCompatibilityError } = require("../dist/sync/github-sync.js");
const { PkmServiceRecoveryPersistenceError } = require("../dist/runtime/pkm-service.js");

const extension = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
const start = extension.indexOf("async function finalizeGitHubSyncServiceResult(");
const end = extension.indexOf("async function subscriptionStateData(", start);
assert(start >= 0 && end > start);
const calls = [];
const clients = [];
let root = "/synthetic/knowledge";
let localFingerprint = "local-content";
const target = {
  id: "primary", name: "Primary", branch: "main", repository: "/synthetic/remote.git",
  automation: { enabled: false, initialSyncCompleted: true, intervalMinutes: 60, syncOnChange: false },
};
const result = {
  transactionId: "transaction", commit: "a".repeat(40), changed: false, fingerprints: {},
  pulled: [], deletedLocal: [], privateTopLevels: {}, recipePulls: [], recipeDeletes: [],
  acknowledgedDeletions: [], resolutionReport: { totalFiles: 0, rules: {}, generatedAt: new Date().toISOString() },
};
class FakeClient {
  constructor(options) { this.options = options; this.receipts = []; clients.push(this); }
  async configure(targets) { calls.push(["configure", targets]); }
  async request(id, reason) { calls.push(["request", id, reason]); return true; }
  async sync(...args) { calls.push(["service-sync", ...args]); return result; }
  report(...args) { calls.push(["report", ...args]); }
  notifyContentChanged() {}
  snapshot() { return {}; }
  dispose() { calls.push(["dispose"]); }
  async listRecoverableResults() { return this.receipts; }
  async recoverSyncResult(id) { calls.push(["recover", id]); if (this.recoveryError) throw this.recoveryError; return result; }
  async acknowledgeRecoveredResult(id) { calls.push(["acknowledge", id]); this.receipts = this.receipts.filter(receipt => receipt.operationId !== id); }
  async acknowledgeExecutionErrors(id) { calls.push(["acknowledge-error", id]); }
}
const context = vm.createContext({
  PkmServiceClient: FakeClient,
  githubSyncScheduler: undefined, githubSyncCoordinatorStatePath: undefined,
  githubSyncTasks: new Map(), githubSyncForceUpdateAudit: new Map(),
  path, os, randomUUID, createHash, GitHubSyncConflictError, GitHubSyncExtensionCompatibilityError, PkmServiceRecoveryPersistenceError,
  Promise, Set, Map, Error,
  fs: { readFileSync: () => JSON.stringify({
    transactionId: result.transactionId, repository: target.repository, branch: target.branch,
  }) },
  log: { info() {}, warn() {}, error() {} },
  vscode: { window: { showErrorMessage() {}, showWarningMessage: () => Promise.resolve() } },
  panel: undefined, _treeProvider: undefined,
  githubSyncDiagnostics: { record: (...args) => calls.push(["diagnostic", ...args]) },
  githubSyncCoordinatorStateDirectory: () => `${root}/coordinator`,
  githubSyncStateDirectory: () => "/synthetic/global/github-sync",
  getStorePath: () => root,
  readGitHubSyncTargets: () => [target],
  githubSyncTargetById: () => target,
  githubPublicationMigration: () => ({ status: () => undefined }),
  withGitHubSyncTargetLock: async (_context, id, action) => { calls.push(["target-lock", id]); return action(); },
  withGitHubSyncApplyLock: async (_context, action) => { calls.push(["apply-lock"]); return action(); },
  mutateGitHubSyncTargets: async (_context, _operation, action) => action([target]).result,
  readGitHubSyncConflict: () => undefined,
  clearEquivalentGitHubSyncConflict: () => false,
  listGitHubSyncConflicts: () => [],
  readGitHubSyncCredentials: async () => ({ accessToken: "synthetic-secret" }),
  invalidateSharedContentCatalog: () => calls.push(["invalidate-catalog"]),
  githubSyncCatalog: async () => ({ notes: [] }),
  githubSyncFingerprintInWorker: async () => ({ localChangeFingerprint: localFingerprint }),
  GITHUB_SYNC_CONTENT_TYPES: ["notes"],
  syncGitHubTarget: () => { throw new Error("Extension Host must not execute raw Git synchronization"); },
  applyGitHubSyncRecipePulls: () => calls.push(["recipe-pulls"]),
  applyGitHubSyncRecipeDeletes: () => calls.push(["recipe-deletes"]),
  setTopLevelPrivacy() {},
  completeGitHubSyncTransaction: () => calls.push(["complete-receipt"]),
  clearGitHubSyncConflict: () => calls.push(["clear-conflict"]),
  storeGitHubSyncConflict: () => calls.push(["store-conflict"]),
  refreshKnowledgeInventory: async () => calls.push(["refresh-inventory"]),
  refreshRetrievalIndex: async () => calls.push(["refresh-retrieval"]),
  scheduleRetrievalRefresh() {},
  updateGitHubSyncBackgroundTask() {},
});
vm.runInContext(ts.transpileModule(extension.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, context);
context.extensionContext = {
  globalStorageUri: { fsPath: "/synthetic/global" }, extensionPath: "/synthetic/extension",
  extension: { packageJSON: { version: "3.2.25" } },
};

(async () => {
  vm.runInContext("configureGitHubSyncScheduler(extensionContext)", context);
  await Promise.resolve();
  assert.equal(clients.length, 1);
  const client = clients[0];
  assert.equal(client.options.knowledgeRoot, root);
  assert.equal(client.options.serviceEntryPath, path.join("/synthetic/extension", "dist", "runtime", "pkm-service-entry.js"));
  assert.equal(client.options.globalStoragePath, "/synthetic/global");
  assert.equal(await client.options.shouldExecute("primary", "manual"), true);
  await client.options.execute("primary", "manual", 1);
  const syncCall = calls.find(call => call[0] === "service-sync");
  assert(syncCall, "the real execution callback delegates Git work to the service");
  assert.equal(syncCall[1], target);
  assert.equal(syncCall[3], path.join("/synthetic/global/github-sync", "checkouts"));
  assert.deepEqual(syncCall[4], { accessToken: "synthetic-secret" });
  assert.equal(syncCall[5], root);
  assert.equal(syncCall[7].mode, "normal");
  assert(calls.some(call => call[0] === "target-lock"));
  assert(calls.some(call => call[0] === "apply-lock"));
  assert(calls.some(call => call[0] === "complete-receipt"));
  assert(calls.some(call => call[0] === "clear-conflict"));
  assert(calls.some(call => call[0] === "refresh-inventory"));
  assert(calls.some(call => call[0] === "refresh-retrieval"));
  assert.equal(target.lastSync.commit, result.commit);
  assert(target.lastSync.localChangeFingerprint, "successful sync persists the local input snapshot, not the remote manifest fingerprint");
  assert.equal(await client.options.shouldExecute("primary", "change"), false,
    "unrelated session/project events and repeated writes with unchanged selected bytes do not start Git");
  assert.equal(await client.options.shouldExecute("primary", "interval"), true,
    "periodic fetch still checks remote changes even with unchanged local content");
  localFingerprint = "changed-selected-content";
  assert.equal(await client.options.shouldExecute("primary", "change"), true,
    "a real selected content edit schedules synchronization");
  localFingerprint = "local-content";
  target.pendingDeletions = [{ type: "notes", itemId: "Explicitly deleted" }];
  assert.equal(await client.options.shouldExecute("primary", "change"), true,
    "new explicit deletion evidence is not suppressed by an unchanged byte snapshot");
  target.pendingDeletions = [];
  client.receipts = [{ operationId: "disconnected-success", targetId: "primary", outcome: "success",
    reason: "manual", repository: target.repository, branch: target.branch }];
  const syncCallsBeforeRecovery = calls.filter(call => call[0] === "service-sync").length;
  await context.recoverGitHubSyncServiceResults(context.extensionContext, client);
  assert(calls.some(call => call[0] === "acknowledge" && call[1] === "disconnected-success"));
  assert.equal(calls.filter(call => call[0] === "service-sync").length, syncCallsBeforeRecovery,
    "recovery applies the existing result without repeating Git execution");
  client.receipts = [{ operationId: "disconnected-conflict", targetId: "primary", outcome: "error",
    reason: "manual", repository: target.repository, branch: target.branch }];
  client.recoveryError = new GitHubSyncConflictError("a".repeat(40), [{
    path: "notes/Conflict.md", type: "notes", itemId: "Conflict", category: "", privacy: "public",
    local: Buffer.from("local"), remote: Buffer.from("remote"),
  }], [], [], {}, [], []);
  await context.recoverGitHubSyncServiceResults(context.extensionContext, client);
  const storedIndex = calls.findIndex(call => call[0] === "store-conflict");
  const ackIndex = calls.findIndex(call => call[0] === "acknowledge" && call[1] === "disconnected-conflict");
  assert(storedIndex >= 0 && ackIndex > storedIndex, "recovered conflicts are durably staged before their service receipt is acknowledged");
  delete client.recoveryError;
  client.receipts = [{ operationId: "preflight-error", targetId: "primary", outcome: "error",
    reason: "manual", repository: target.repository, branch: target.branch }];
  client.recoveryError = new Error("GitHub Sync content still contains merge conflict markers: scripts/Fixture.script");
  await context.recoverGitHubSyncServiceResults(context.extensionContext, client);
  assert.equal(target.lastFailure.error, client.recoveryError.message);
  assert.equal(client.receipts.length, 0, "legacy preflight failure receipts are cleared only after the underlying error is durably recorded");
  delete client.recoveryError;
  client.receipts = [{ operationId: "obsolete-endpoint", targetId: "primary", outcome: "success",
    reason: "manual", repository: "/different/remote.git", branch: target.branch }];
  const recoveryCalls = calls.filter(call => call[0] === "recover").length;
  await assert.rejects(() => context.recoverGitHubSyncServiceResults(context.extensionContext, client), /mismatched target metadata/);
  assert.equal(calls.filter(call => call[0] === "recover").length, recoveryCalls,
    "endpoint changes block automatic application before any recovered side effects");
  assert.equal(client.receipts.length, 1, "blocked recovery retains its receipt for review");
  client.receipts = [];
  root = "/synthetic/other-root";
  vm.runInContext("configureGitHubSyncScheduler(extensionContext)", context);
  await Promise.resolve();
  assert.equal(clients.length, 2);
  assert(calls.some(call => call[0] === "dispose"), "changing Knowledge Root disconnects the old client");
  assert.equal(clients[1].options.knowledgeRoot, root);
  assert.doesNotMatch(extension.slice(start, end), /new GitHubSyncCoordinator/);
  console.log("PKM service integration: extension delegates Git execution and retains guarded authorization/postprocessing");
})().catch(error => { console.error(error); process.exitCode = 1; });
