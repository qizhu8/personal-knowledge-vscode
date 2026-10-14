#!/usr/bin/env node
// Executes the actual Sync acceptance handler with isolated stores and injected
// boundary failures. No extension activation, credentials, network or live Sync.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const sync = require("../dist/sync/github-sync");
const conflicts = require("../dist/sync/github-sync-conflicts");
const { compileWorkflowDefinitionV1 } = require("../dist/workflows/workflow-contracts");
const extension = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
const start = extension.indexOf("async function acceptGitHubSyncConflict(");
const end = extension.indexOf("\nfunction githubSyncTargetById(", start);
assert(start >= 0 && end > start);
const handler = ts.transpileModule(extension.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const definition = { schema: "pkm.workflow.definition/v1", spec: {
  inputs: {}, nodes: [{ nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
  outputs: {}, completion: { requiredNodes: ["work"] },
} };
const compiled = compileWorkflowDefinitionV1(definition);
assert(compiled.ok);
const recipe = label => ({ recipeId: "recipe_review", scope: "global", category: "Review",
  name: label, description: "synthetic recovery fixture", revision: 1, definition,
  executableDigest: compiled.executableDigest });
const encode = value => sync.githubSyncManagedContent("recipes", Buffer.from(JSON.stringify(value)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-sync-acceptance-recovery-"));
let scenarios = 0;
async function scenario(boundary) {
  const store = path.join(root, boundary, "store"), state = path.join(root, boundary, "state");
  const relative = "notes/Review/One.md", destination = path.join(store, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, "original\r\n");
  fs.mkdirSync(path.join(store, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(store, "scripts/Unrelated.script"), "unrelated\n");
  fs.writeFileSync(path.join(store, "scripts/.Unrelated.script.pkm.json"), '{"schema":"invalid"}\n');
  const oldRecipe = recipe("original"), newRecipe = recipe("remote");
  const remoteCommit = "a".repeat(40);
  const target = { id: "target", repository: "synthetic", branch: "main",
    automation: { enabled: false }, lastSync: { commit: "b".repeat(40), fingerprints: {} } };
  const record = conflicts.storeGitHubSyncConflict(state, "target", new sync.GitHubSyncConflictError(remoteCommit, [
    { path: relative, type: "notes", itemId: "One", category: "Review", privacy: "public",
      base: Buffer.from("original\n"), local: Buffer.from("original\r\n"), remote: Buffer.from("remote\n") },
    { path: "recipes/Review/Recipe.recipe_review.json", type: "recipes", itemId: "recipe_review",
      category: "Review", privacy: "public", base: encode(oldRecipe), local: encode(oldRecipe), remote: encode(newRecipe) },
  ]));
  assert(record.files.every(file => file.candidateSource === "remote"));
  let currentRecipe = oldRecipe, fail = boundary, requests = 0, recipeWrites = 0;
  let upstream = remoteCommit;
  const once = point => { if (fail === point) { fail = ""; throw new Error(`injected ${point}`); } };
  const project = {
    list: () => ({ recipes: [currentRecipe] }),
    recipeSyncEntries: () => [{ recipe: currentRecipe, content: encode(currentRecipe).toString() }],
    replaceRecipesFromSync: (_command, recipes) => { once("recipe"); recipeWrites++; currentRecipe = recipes[0]; },
  };
  const context = vm.createContext({
    fs, path, Buffer, ...sync, ...conflicts,
    githubSyncStateDirectory: () => state,
    requireSavedGitHubSyncConflictDocuments: () => {},
    githubSyncTargetById: () => target,
    readGitHubSyncCredentials: async () => undefined,
    fetchGitHubRemoteSnapshot: async () => ({ commit: upstream }),
    currentProjectStore: () => project, getStorePath: () => store,
    githubSyncRecipeContent: encode, githubSyncCandidateDestination: (base, rel) => path.join(base, rel),
    projectCommand: () => ({}), applyGitHubSyncRecipeDeletes: () => {}, setTopLevelPrivacy: () => {},
    mutateGitHubSyncTargets: async (_ctx, _reason, action) => { once("baseline"); return action([target]); },
    markGitHubSyncConflictApplying: (...args) => { once("intent"); return conflicts.markGitHubSyncConflictApplying(...args); },
    markGitHubSyncConflictApplied: (...args) => { once("marker"); return conflicts.markGitHubSyncConflictApplied(...args); },
    githubSyncScheduler: { request: async () => { requests++; once("push"); } },
    invalidateSharedContentCatalog: () => {}, refreshKnowledgeInventory: async () => {}, _treeProvider: undefined,
  });
  vm.runInContext(handler, context);
  if (boundary === "remote-change") {
    upstream = "c".repeat(40);
    await assert.rejects(() => context.acceptGitHubSyncConflict({}, "target"), /remote branch changed/);
    assert.equal(fs.readFileSync(destination, "utf8"), "original\r\n");
    assert.equal(conflicts.readGitHubSyncConflict(state, "target").files[0].candidateSource, "remote");
    upstream = remoteCommit; fail = "";
  } else {
    await assert.rejects(() => context.acceptGitHubSyncConflict({}, "target"), new RegExp(`injected ${boundary}`));
    const interrupted = conflicts.readGitHubSyncConflict(state, "target");
    if (boundary === "intent") {
      assert.equal(interrupted.applyState, undefined);
      assert.equal(fs.readFileSync(destination, "utf8"), "original\r\n", "durable intent must precede mutation");
    } else {
      assert.equal(fs.readFileSync(destination, "utf8"), "remote\n");
      assert.equal(interrupted.applyState, boundary === "push" ? "sync-pending" : "applying");
      assert.equal(!!interrupted.appliedAt, boundary === "push");
      if (boundary === "recipe") assert.equal(target.lastSync.commit, "b".repeat(40), "no baseline advancement over unapplied Recipe");
      if (boundary === "marker") assert.equal(target.lastSync.commit, remoteCommit, "retry after baseline persistence must remain idempotent");
    }
  }
  const result = await context.acceptGitHubSyncConflict({}, "target");
  assert.equal(result.accepted, 2);
  assert.equal(fs.readFileSync(destination, "utf8"), "remote\n");
  assert.equal(currentRecipe.name, "remote");
  assert.equal(target.lastSync.commit, remoteCommit);
  assert.equal(conflicts.readGitHubSyncConflict(state, "target").applyState, "sync-pending");
  assert(conflicts.readGitHubSyncConflict(state, "target").appliedAt);
  if (boundary === "push") {
    assert.equal(recipeWrites, 1, "retry after local apply queues Sync without repeating store mutation");
    assert.equal(requests, 2);
  } else assert.equal(requests, 1);
  scenarios++;
  console.log(`acceptance recovery scenario passed: ${boundary}`);
}
async function scriptIdentityScenario(mode) {
  const store = path.join(root, mode, "store"), state = path.join(root, mode, "state");
  const id = `script_${"1".repeat(24)}`, wrongId = `script_${"2".repeat(24)}`;
  const resultPath = "scripts/Review/After.script", resultSidecar = "scripts/Review/.After.script.pkm.json";
  const localPath = mode === "selected-plan" ? resultPath : "scripts/Review/Before.script";
  const localSidecar = mode === "selected-plan" ? resultSidecar : "scripts/Review/.Before.script.pkm.json";
  const identity = knowledgeId => Buffer.from(JSON.stringify({
    schema: "pkm.script/v1", knowledgeId, aliases: ["pkm://scripts/Review/Before.script"],
  }));
  const original = Buffer.from("original\r\n"), planned = Buffer.from("selected plan\n");
  const originalIdentity = identity(id), plannedIdentity = identity(mode === "invalid-primary" ? wrongId : id);
  fs.mkdirSync(path.dirname(path.join(store, localPath)), { recursive: true });
  fs.writeFileSync(path.join(store, localPath), original);
  fs.writeFileSync(path.join(store, localSidecar), originalIdentity);
  if (mode === "duplicate-active") {
    fs.writeFileSync(path.join(store, "scripts/Review/Copied.script"), original);
    fs.writeFileSync(path.join(store, "scripts/Review/.Copied.script.pkm.json"), originalIdentity);
  }
  const remoteCommit = "a".repeat(40);
  const target = { id: "target", repository: "synthetic", branch: "main",
    automation: { enabled: false }, lastSync: { commit: "b".repeat(40), fingerprints: {} } };
  const metadata = { type: "scripts", itemId: id, category: "Review", privacy: "public",
    reason: "pending-apply", plannedOperation: "write", baseCommit: "b".repeat(40) };
  conflicts.storeGitHubSyncConflict(state, "target", new sync.GitHubSyncConflictError(remoteCommit, [
    { ...metadata, path: resultPath, localPath, resultPath, member: "",
      base: original, local: original, remote: planned, expectedLocal: original, plannedContent: planned },
    { ...metadata, path: resultSidecar, localPath: localSidecar, resultPath: resultSidecar, member: "identity-sidecar",
      base: originalIdentity, local: originalIdentity, remote: plannedIdentity,
      expectedLocal: originalIdentity, plannedContent: plannedIdentity },
  ]));
  if (mode === "selected-remote-move") {
    conflicts.selectGitHubSyncConflictCandidate(state, "target", resultPath, "remote");
    conflicts.selectGitHubSyncConflictCandidate(state, "target", resultSidecar, "remote");
  }
  assert(conflicts.readGitHubSyncConflict(state, "target").files.every(file =>
    file.candidateSource === (mode === "selected-remote-move" ? "remote" : "plan")));
  let intents = 0, writes = 0, requests = 0, refreshes = 0;
  const context = vm.createContext({
    fs, path, Buffer, ...sync, ...conflicts,
    githubSyncStateDirectory: () => state, requireSavedGitHubSyncConflictDocuments: () => {},
    githubSyncTargetById: () => target, readGitHubSyncCredentials: async () => undefined,
    fetchGitHubRemoteSnapshot: async () => ({ commit: remoteCommit }),
    currentProjectStore: () => ({ list: () => ({ recipes: [] }), recipeSyncEntries: () => [] }),
    getStorePath: () => store, githubSyncCandidateDestination: (base, rel) => path.join(base, rel),
    applyGitHubSyncRecipeDeletes: () => {}, setTopLevelPrivacy: () => {},
    markGitHubSyncConflictApplying: (...args) => { intents++; return conflicts.markGitHubSyncConflictApplying(...args); },
    replaceGitHubSyncFilesAtomically: (...args) => { writes++; return sync.replaceGitHubSyncFilesAtomically(...args); },
    mutateGitHubSyncTargets: async (_ctx, _reason, action) => action([target]),
    githubSyncScheduler: { request: async () => { requests++; } },
    invalidateSharedContentCatalog: () => {}, refreshKnowledgeInventory: async () => { refreshes++; },
    _treeProvider: undefined,
  });
  vm.runInContext(handler, context);
  if (mode === "invalid-primary" || mode === "duplicate-active") {
    await assert.rejects(() => context.acceptGitHubSyncConflict({}, "target"),
      mode === "invalid-primary" ? /changes Script identity/ : /rebuild identity-aware review/);
    assert.equal(intents, 0, "identity rejection precedes durable apply intent");
    assert.equal(writes, 0, "identity rejection precedes the atomic mutation boundary");
    assert.equal(requests, 0);
    assert.equal(refreshes, 0);
    assert(fs.readFileSync(path.join(store, localPath)).equals(original));
    assert(fs.readFileSync(path.join(store, localSidecar)).equals(originalIdentity));
    assert(!fs.existsSync(path.join(store, resultPath)));
    assert(!fs.existsSync(path.join(store, resultSidecar)));
    assert.equal(target.lastSync.commit, "b".repeat(40));
    assert.equal(conflicts.readGitHubSyncConflict(state, "target").applyState, undefined);
  } else {
    const result = await context.acceptGitHubSyncConflict({}, "target");
    assert.equal(result.accepted, 2);
    assert.deepEqual(Array.from(result.refreshed), []);
    assert(fs.readFileSync(path.join(store, resultPath)).equals(planned));
    assert(fs.readFileSync(path.join(store, resultSidecar)).equals(plannedIdentity));
    if (mode === "selected-remote-move") {
      assert(!fs.existsSync(path.join(store, localPath)));
      assert(!fs.existsSync(path.join(store, localSidecar)));
    }
    assert.equal(intents, 1);
    assert.equal(writes, 1);
    assert.equal(requests, 1);
    assert.equal(refreshes, 1);
    assert.equal(target.lastSync.commit, remoteCommit);
    assert.equal(conflicts.readGitHubSyncConflict(state, "target").applyState, "sync-pending");
  }
  scenarios++;
  console.log(`acceptance recovery scenario passed: Script identity ${mode}`);
}
(async () => {
  try {
    for (const boundary of ["intent", "recipe", "baseline", "marker", "push", "remote-change"]) await scenario(boundary);
    for (const mode of ["invalid-primary", "duplicate-active", "selected-plan", "selected-remote-move"]) await scriptIdentityScenario(mode);
    const state = path.join(root, "mixed-entity");
    const body = "scripts/Review/Missing.script", sidecar = "scripts/Review/Missing.metadata.json";
    conflicts.storeGitHubSyncConflict(state, "target", new sync.GitHubSyncConflictError("a".repeat(40), [
      { path: body, type: "scripts", itemId: "Missing", category: "Review", privacy: "public",
        reason: "unrecorded-local-absence", base: Buffer.from("before\n"), remote: Buffer.from("remote\n") },
      { path: sidecar, type: "scripts", itemId: "Missing", category: "Review", privacy: "public",
        reason: "unrecorded-local-absence", member: "metadata", remote: Buffer.from('{"id":"Missing"}\n') },
    ]));
    conflicts.selectGitHubSyncConflictDeletion(state, "target", body);
    conflicts.saveGitHubSyncManualCandidate(state, "target", sidecar, '{"id":"edited"}\n');
    const context = vm.createContext({ ...conflicts,
      githubSyncStateDirectory: () => state, requireSavedGitHubSyncConflictDocuments: () => {},
      githubSyncScheduler: { request: () => { throw new Error("must not queue mixed intent"); } },
    });
    vm.runInContext(handler, context);
    await assert.rejects(() => context.acceptGitHubSyncConflict({}, "target"), /cannot mix deletion and restoration/);
    conflicts.selectGitHubSyncConflictCandidate(state, "target", sidecar, "remote");
    assert(conflicts.readGitHubSyncConflict(state, "target").files.every(file => file.candidateSource === "remote"));
    scenarios++;
    console.log("acceptance recovery scenario passed: missing-entity mixed-intent safety");
    console.log(`github-sync acceptance recovery: ${scenarios} scenarios passed`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
