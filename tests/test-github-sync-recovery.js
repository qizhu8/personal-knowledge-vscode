const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { archiveSupersededGitHubSyncResult } = require("../dist/sync/github-sync-recovery");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-sync-recovery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = { id: "primary", repository: "/remote.git", branch: "main",
    lastSync: { commit: "b".repeat(40), repository: "/remote.git", branch: "main" } };
  const latest = { schema: 1, targetId: target.id, transactionId: "new", state: "recorded",
    repository: target.repository, branch: target.branch, pushedCommit: target.lastSync.commit };
  const transactionFile = path.join(directory, "checkouts", target.id, "transactions", "latest.json");
  fs.mkdirSync(path.dirname(transactionFile), { recursive: true });
  const save = () => fs.writeFileSync(transactionFile, JSON.stringify(latest));
  save();
  const receipt = { operationId: randomUUID(), targetId: target.id, repository: target.repository, branch: target.branch,
    outcome: "error", reason: "interval", receiptPath: path.join(directory, "original.json") };
  const original = JSON.stringify({ $pkm: "object", entries: [
    ["outcome", "error"], ["error", { conflicts: ["preserve local/remote/base bytes and user intent"] }],
  ] });
  fs.writeFileSync(receipt.receiptPath, original);
  const result = { transactionId: "old", commit: "a".repeat(40) };
  return { directory, target, latest, save, receipt, original, result,
    archive: () => archiveSupersededGitHubSyncResult(directory, receipt, target, result) };
}

test("superseded recovery preserves the exact encoded record and never changes the current baseline", t => {
  const f = fixture(t), before = JSON.stringify(f.target);
  const destination = f.archive();
  assert.equal(destination, path.join(f.directory, "superseded-results", `${f.receipt.operationId}.json`));
  const archive = JSON.parse(fs.readFileSync(destination, "utf8"));
  assert.equal(archive.originalReceipt, f.original);
  assert.equal(archive.transactionId, "old");
  assert.equal(archive.supersededBy, "new");
  assert.equal(fs.readFileSync(f.receipt.receiptPath, "utf8"), f.original, "acknowledgment is a separate later step");
  assert.equal(JSON.stringify(f.target), before);
  assert.equal(f.archive(), destination, "retry after interrupted acknowledgment is idempotent");
  if (process.platform !== "win32") assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
});

for (const state of ["prepared", "pushed"]) test(`recovery cannot discard an unrecorded newer transaction: ${state}`, t => {
  const f = fixture(t);
  f.latest.state = state; f.save();
  assert.equal(f.archive(), undefined);
  assert(!fs.existsSync(path.join(f.directory, "superseded-results")));
});

for (const mismatch of ["commit", "repository", "branch"]) test(`a newer receipt alone is not proof of an applied baseline: ${mismatch}`, t => {
  const f = fixture(t);
  f.target.lastSync[mismatch] = "different";
  assert.equal(f.archive(), undefined);
  assert(!fs.existsSync(path.join(f.directory, "superseded-results")));
});

test("current results still use strict normal validation rather than archival", t => {
  const f = fixture(t);
  f.result.transactionId = "new";
  assert.equal(f.archive(), undefined);
});

test("mismatched transaction target or remote is never accepted as supersession proof", t => {
  const f = fixture(t);
  f.latest.targetId = "other"; f.save();
  assert.throws(f.archive, /receipt does not match/);
  f.latest.targetId = f.target.id; f.latest.repository = "/other.git"; f.save();
  assert.throws(f.archive, /repository, branch or commit/);
  assert(!fs.existsSync(path.join(f.directory, "superseded-results")));
});

test("archive failure preserves the original and differing archives are never overwritten", t => {
  const f = fixture(t);
  const archiveDirectory = path.join(f.directory, "superseded-results");
  fs.writeFileSync(archiveDirectory, "blocked");
  assert.throws(f.archive);
  assert.equal(fs.readFileSync(f.receipt.receiptPath, "utf8"), f.original);
  fs.unlinkSync(archiveDirectory);
  const destination = f.archive();
  const saved = fs.readFileSync(destination, "utf8");
  fs.writeFileSync(f.receipt.receiptPath, "changed recovery bytes");
  assert.throws(f.archive, /archive does not match/);
  assert.equal(fs.readFileSync(destination, "utf8"), saved);
});

test("missing baseline and malformed receipts remain blocked without deleting evidence", t => {
  const f = fixture(t);
  delete f.target.lastSync;
  assert.equal(f.archive(), undefined);
  f.target.lastSync = {commit:f.latest.pushedCommit, repository:f.target.repository, branch:f.target.branch};
  f.receipt.operationId = "../unsafe";
  assert.throws(f.archive, /invalid identity/);
  assert.equal(fs.readFileSync(f.receipt.receiptPath, "utf8"), f.original);
});

test("startup recovers multiple stale partial receipts without replay or blocking subsequent configuration", async t => {
  const vm = require("node:vm"), ts = require("typescript");
  const { GitHubSyncConflictError } = require("../dist/sync/github-sync");
  const f = fixture(t), pending = [], errors = new Map(), acknowledged = [], logs = [];
  for (let index=0; index<2; index++) {
    const receipt = {...f.receipt, operationId:randomUUID(), receiptPath:path.join(f.directory, `result-${index}.json`)};
    fs.writeFileSync(receipt.receiptPath, f.original);
    pending.push(receipt);
    const error = new GitHubSyncConflictError(f.result.commit, [], [], [], {}, [], []);
    error.partialResult = {...f.result, transactionId:`old-${index}`};
    errors.set(receipt.operationId, error);
  }
  const service = {
    listRecoverableResults:async()=>[...pending],
    recoverSyncResult:async id=>{ throw errors.get(id); },
    acknowledgeRecoveredResult:async id=>{
      assert(fs.existsSync(path.join(f.directory, "superseded-results", `${id}.json`)));
      acknowledged.push(id);
      pending.splice(pending.findIndex(receipt=>receipt.operationId===id), 1);
    },
  };
  const source = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node=>ts.isFunctionDeclaration(node) && node.name?.text==="recoverGitHubSyncServiceResults");
  const forbidden = ()=>assert.fail("superseded recovery must not apply content, baseline or conflict mutations");
  const scope = {
    path, fs, archiveSupersededGitHubSyncResult, GitHubSyncConflictError,
    GitHubSyncDeferredError:class extends Error {}, GitHubSyncContentRepairError:class extends Error {},
    withGitHubSyncTargetLock:async (_context,_id,fn)=>fn(),
    withGitHubSyncApplyLock:async (_context,fn)=>fn(),
    readGitHubSyncTargets:()=>[f.target], githubSyncTargetById:()=>f.target,
    githubSyncStateDirectory:()=>f.directory,
    finalizeGitHubSyncServiceResult:forbidden, applyGitHubSyncRecipePulls:forbidden,
    applyGitHubSyncRecipeDeletes:forbidden, storeGitHubSyncConflict:forbidden, mutateGitHubSyncTargets:forbidden,
    log:{warn:message=>logs.push(message),info:message=>logs.push(message)},
  };
  vm.runInNewContext(ts.transpileModule(`${declaration.getText(ast)}\nglobalThis.recover = recoverGitHubSyncServiceResults;`,
    {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText, scope);
  await scope.recover({}, service);
  assert.equal(acknowledged.length, 2);
  assert.equal(pending.length, 0);
  assert.equal(logs.filter(line=>line.includes("current content, baseline and conflict choices were not changed")).length, 2);
  await scope.recover({}, service);
  assert.equal(acknowledged.length, 2, "subsequent startup does not repeat archived recovery");
});
