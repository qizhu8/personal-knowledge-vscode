#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const ts = require("typescript");
const sync = require("../dist/sync/github-sync.js");
const conflicts = require("../dist/sync/github-sync-conflicts.js");
const { canonicalJson, compileWorkflowDefinitionV1 } = require("../dist/workflows/workflow-contracts.js");
const { createHash } = require("node:crypto");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-sync-resolution-"));
const git = (cwd, args) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();
const empty = () => Object.fromEntries(sync.GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
const remember = (target, result) => {
  target.lastSync = { at: new Date().toISOString(), commit: result.commit, fingerprints: result.fingerprints };
};
const extension = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
function loadFunction(name, next, context) {
  const start = extension.indexOf(`async function ${name}(`) >= 0
    ? extension.indexOf(`async function ${name}(`)
    : extension.indexOf(`function ${name}(`);
  assert(start >= 0);
  const end = extension.indexOf(`function ${next}`, start);
  assert(end > start);
  vm.runInContext(ts.transpileModule(extension.slice(start, end).replace(/async\s*$/, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
}

async function main() {
  const encode = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");
  const base = { description: "base", revision: 1, nested: { a: 1, b: 2 }, order: ["a", "b"] };
  const local = { ...base, description: "local", nested: { a: 3, b: 2 } };
  const remote = { ...base, revision: 2, nested: { a: 1, b: 4 } };
  assert.deepEqual(JSON.parse(sync.deterministicJsonMerge(encode(base), encode(local), encode(remote))), {
    description: "local", revision: 2, nested: { a: 3, b: 4 }, order: ["a", "b"],
  });
  assert.equal(sync.deterministicJsonMerge(encode(base), encode(local), encode({ ...base, description: "remote" })), undefined);
  assert.equal(sync.deterministicJsonMerge(encode(base), encode({ ...base, order: ["a"] }), encode({ ...base, order: ["b"] })), undefined,
    "ordered arrays must not be silently unioned");
  assert.equal(sync.deterministicJsonMerge(encode({ value: { a: 1 } }), encode({}), encode({ value: { a: 2 } })), undefined,
    "deletion versus modification remains a conflict");
  assert.deepEqual(JSON.parse(sync.deterministicJsonMerge(encode({ x: 1 }), encode({}), encode({ x: 1, y: 2 }))), { y: 2 });
  assert.equal(sync.deterministicJsonMerge(Buffer.from("invalid"), encode(local), encode(remote)), undefined);
  const definition = {
    schema: "pkm.workflow.definition/v1",
    spec: {
      inputs: {},
      nodes: [
        { nodeId: "a", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] },
        { nodeId: "b", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] },
      ],
      outputs: {}, completion: { requiredNodes: ["a", "b"] },
    },
  };
  const recipe = {
    recipeId: "recipe_merge", scope: "global", category: "Shared", name: "Merge",
    description: "base", revision: 1, definition,
    executableDigest: createHash("sha256").update(canonicalJson(definition)).digest("hex"),
  };
  const localRecipe = structuredClone(recipe), remoteRecipe = structuredClone(recipe);
  localRecipe.definition.spec.nodes[0].ports = { inputs: [], outputs: ["local"] };
  remoteRecipe.definition.spec.nodes[1].ports = { inputs: [], outputs: ["remote"] };
  assert.equal(compileWorkflowDefinitionV1(localRecipe.definition).ok, true);
  assert.equal(compileWorkflowDefinitionV1(remoteRecipe.definition).ok, true);
  const mergedRecipe = JSON.parse(sync.deterministicJsonMerge(encode(recipe), encode(localRecipe), encode(remoteRecipe), true));
  assert.deepEqual(mergedRecipe.definition.spec.nodes.map(node => node.ports.outputs), [["local"], ["remote"]]);
  assert.equal(mergedRecipe.revision, 2);
  assert.equal(mergedRecipe.executableDigest, compileWorkflowDefinitionV1(mergedRecipe.definition).executableDigest);
  sync.validateGitHubSyncCandidate("recipes/Shared/Merge.recipe_merge.json", encode(mergedRecipe));
  const localCycle = structuredClone(recipe), remoteCycle = structuredClone(recipe);
  localCycle.definition.spec.nodes[0].dependsOn = [{ from: "b", accept: ["succeeded"], required: true }];
  remoteCycle.definition.spec.nodes[1].dependsOn = [{ from: "a", accept: ["succeeded"], required: true }];
  assert.equal(compileWorkflowDefinitionV1(localCycle.definition).ok, true);
  assert.equal(compileWorkflowDefinitionV1(remoteCycle.definition).ok, true);
  assert.equal(sync.deterministicJsonMerge(encode(recipe), encode(localCycle), encode(remoteCycle), true), undefined,
    "individually compatible edits that combine into an invalid graph require human review");
  assert.throws(() => sync.validateGitHubSyncCandidate("notes/Conflict.md",
    Buffer.from("# Result\n<<<<<<< local\none\n=======\ntwo\n>>>>>>> remote\n")), /conflict markers/);
  assert.doesNotThrow(() => sync.validateGitHubSyncCandidate("notes/Heading.md", Buffer.from("Heading\n=======\n")));

  const bare = path.join(root, "remote.git"), seed = path.join(root, "seed");
  fs.mkdirSync(seed);
  git(root, ["init", "--bare", bare]);
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "Fixture"]);
  git(seed, ["config", "user.email", "fixture@example.invalid"]);
  fs.writeFileSync(path.join(seed, "README.md"), "synthetic fixture\n");
  git(seed, ["add", "."]); git(seed, ["commit", "-m", "seed"]);
  git(seed, ["remote", "add", "origin", bare]); git(seed, ["push", "-u", "origin", "main"]);
  git(root, ["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
  const stores = ["machine-a", "machine-b"].map(name => path.join(root, name));
  for (const store of stores) {
    fs.mkdirSync(path.join(store, "packages", "Pair"), { recursive: true });
    fs.writeFileSync(path.join(store, "packages", "Pair", "a.txt"), "base A\n");
    fs.writeFileSync(path.join(store, "packages", "Pair", "b.txt"), "base B\n");
  }
  const catalog = store => {
    const result = empty();
    result.packages = [{
      id: "pair", label: "Pair", cat: "", isPrivate: false,
      source: path.join(store, "packages", "Pair"), destination: "packages/Pair",
    }];
    return result;
  };
  const selection = { public: {}, private: {} };
  for (const scope of Object.values(selection)) for (const type of sync.GITHUB_SYNC_CONTENT_TYPES) scope[type] = { items: [], folders: [] };
  selection.public.packages.items = ["pair"];
  const targets = ["machine-a", "machine-b"].map(id =>
    sync.normalizeGitHubSyncTarget({ repository: bare, branch: "main", name: id, selection }, () => id));
  const checkouts = path.join(root, "checkouts"), state = path.join(root, "state");
  for (let index = 0; index < 2; index++) remember(targets[index],
    await sync.syncGitHubTarget(targets[index], catalog(stores[index]), checkouts, undefined, stores[index]));
  fs.writeFileSync(path.join(stores[0], "packages", "Pair", "a.txt"), "local independent A\n");
  fs.writeFileSync(path.join(stores[1], "packages", "Pair", "b.txt"), "remote independent B\n");
  remember(targets[1], await sync.syncGitHubTarget(targets[1], catalog(stores[1]), checkouts, undefined, stores[1]));
  remember(targets[0], await sync.syncGitHubTarget(targets[0], catalog(stores[0]), checkouts, undefined, stores[0]));
  assert.equal(git(root, ["--git-dir", bare, "show", "main:packages/Pair/a.txt"]), "local independent A");
  assert.equal(git(root, ["--git-dir", bare, "show", "main:packages/Pair/b.txt"]), "remote independent B");
  assert.equal(fs.readFileSync(path.join(stores[0], "packages", "Pair", "b.txt"), "utf8"), "remote independent B\n");
  remember(targets[1], await sync.syncGitHubTarget(targets[1], catalog(stores[1]), checkouts, undefined, stores[1]));
  fs.writeFileSync(path.join(stores[0], "packages", "Pair", "a.txt"), "local later A\n");
  fs.writeFileSync(path.join(stores[0], "packages", "Pair", "b.txt"), "local conflicting B\n");
  fs.writeFileSync(path.join(stores[1], "packages", "Pair", "b.txt"), "remote conflicting B\n");
  fs.writeFileSync(path.join(stores[1], "packages", "Pair", "c.txt"), "remote new C\n");
  remember(targets[1], await sync.syncGitHubTarget(targets[1], catalog(stores[1]), checkouts, undefined, stores[1]));
  let failure;
  try { await sync.syncGitHubTarget(targets[0], catalog(stores[0]), checkouts, undefined, stores[0]); } catch (error) { failure = error; }
  assert(failure instanceof sync.GitHubSyncConflictError);
  assert.deepEqual(failure.conflicts.map(file => file.path), ["packages/Pair/a.txt", "packages/Pair/b.txt", "packages/Pair/c.txt"]);
  let record = conflicts.storeGitHubSyncConflict(state, targets[0].id, failure);
  assert.deepEqual(record.files.map(file => file.candidateSource), ["local", "unresolved", "remote"],
    "safe sibling changes remain selected while the true conflict requires review");
  const bPath = "packages/Pair/b.txt";
  conflicts.saveGitHubSyncManualCandidate(state, targets[0].id, bPath, "manually combined B\n");
  record = conflicts.readGitHubSyncConflict(state, targets[0].id);
  const previousVersion = { conflictId: record.id, revision: record.revision };
  const restaged = conflicts.storeGitHubSyncConflict(state, targets[0].id, failure);
  assert.equal(restaged.files[1].candidateSource, "manual");
  assert.equal(conflicts.readGitHubSyncConflictCandidate(state, targets[0].id, bPath, true).toString(), "manually combined B\n");
  assert.throws(() => conflicts.validateGitHubSyncConflictVersion(state, targets[0].id, previousVersion), /workspace changed/);
  assert.equal(conflicts.selectAllGitHubSyncConflictCandidates(state, targets[0].id, "remote").selected, 0);
  fs.writeFileSync(conflicts.gitHubSyncConflictVariantPath(state, targets[0].id, "merged", bPath), "edited after validation\n");
  assert.throws(() => conflicts.readGitHubSyncConflictCandidate(state, targets[0].id, bPath, true), /changed after validation/);
  conflicts.validateGitHubSyncManualCandidate(state, targets[0].id, bPath);

  const queued = [];
  const context = vm.createContext({
    fs, path, Buffer, ...sync, ...conflicts,
    githubSyncStateDirectory: () => state,
    githubSyncTargetById: () => targets[0],
    getStorePath: () => stores[0],
    githubSyncCandidateDestination: (store, relative) => path.join(store, relative),
    requireSavedGitHubSyncConflictDocuments: () => {},
    readGitHubSyncCredentials: async () => undefined,
    fetchGitHubRemoteSnapshot: async () => ({ commit: failure.remoteCommit }),
    currentProjectStore: () => ({ list: () => ({ recipes: [] }), recipeSyncEntries: () => [] }),
    mutateGitHubSyncTargets: async (_context, _reason, action) => action(targets).result,
    setTopLevelPrivacy: () => {},
    applyGitHubSyncRecipeDeletes: ids => assert.equal(ids.length, 0),
    invalidateSharedContentCatalog: () => {},
    refreshKnowledgeInventory: async () => {},
    _treeProvider: undefined,
    githubSyncScheduler: { request: (id, reason) => { queued.push({ id, reason }); return true; } },
  });
  loadFunction("acceptGitHubSyncConflict", "githubSyncTargetById", context);
  assert.equal((await context.acceptGitHubSyncConflict({}, targets[0].id)).accepted, 3);
  assert.deepEqual(queued, [{ id: targets[0].id, reason: "manual" }]);
  assert.equal(fs.readFileSync(path.join(stores[0], "packages", "Pair", "c.txt"), "utf8"), "remote new C\n");
  assert(conflicts.readGitHubSyncConflict(state, targets[0].id).appliedAt,
    "actual extension acceptance retains the workspace until push completes");
  const recovered = [];
  const recoveryContext = vm.createContext({
    path,
    githubSyncCoordinatorStateDirectory: () => state,
    githubSyncCoordinatorStatePath: undefined,
    githubSyncScheduler: undefined,
    PkmServiceClient: class {
      async configure() {}
      async request(id, reason) { recovered.push({ id, reason }); return true; }
    },
    recoverGitHubSyncServiceResults: async () => {},
    getStorePath: () => stores[0],
    githubSyncTasks: new Map(),
    readGitHubSyncTargets: () => targets,
    githubSyncStateDirectory: () => state,
    listGitHubSyncConflicts: conflicts.listGitHubSyncConflicts,
    readGitHubSyncContentRepair: () => undefined,
    log: { info() {} },
  });
  loadFunction("configureGitHubSyncScheduler", "subscriptionStateData", recoveryContext);
  const hostContext = { globalStorageUri: { fsPath: state }, extensionPath: root, extension: { packageJSON: { version: "3.2.25" } } };
  recoveryContext.configureGitHubSyncScheduler(hostContext);
  recoveryContext.configureGitHubSyncScheduler(hostContext);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(recovered, [{ id: targets[0].id, reason: "manual" }],
    "new service client recovers a committed local application once, not on every configuration update");
  const hook = path.join(bare, "hooks", "pre-receive");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await assert.rejects(sync.syncGitHubTarget(targets[0], catalog(stores[0]), checkouts, undefined, stores[0]), /git push failed/);
  assert(conflicts.readGitHubSyncConflict(state, targets[0].id).appliedAt, "push failure retains review evidence");
  fs.unlinkSync(hook);
  remember(targets[0], await sync.syncGitHubTarget(targets[0], catalog(stores[0]), checkouts, undefined, stores[0]));
  assert.equal(git(root, ["--git-dir", bare, "show", "main:packages/Pair/a.txt"]), "local later A");
  assert.equal(git(root, ["--git-dir", bare, "show", "main:packages/Pair/b.txt"]), "edited after validation");
  assert.equal(git(root, ["--git-dir", bare, "show", "main:packages/Pair/c.txt"]), "remote new C",
    "acceptance and retry never overwrite an unrepresented sibling change");
  conflicts.clearGitHubSyncConflict(state, targets[0].id);
  remember(targets[1], await sync.syncGitHubTarget(targets[1], catalog(stores[1]), checkouts, undefined, stores[1]));
  fs.unlinkSync(path.join(stores[0], bPath));
  fs.writeFileSync(path.join(stores[1], bPath), "remote edit versus member deletion\n");
  remember(targets[1], await sync.syncGitHubTarget(targets[1], catalog(stores[1]), checkouts, undefined, stores[1]));
  failure = undefined;
  try { await sync.syncGitHubTarget(targets[0], catalog(stores[0]), checkouts, undefined, stores[0]); } catch (error) { failure = error; }
  assert(failure instanceof sync.GitHubSyncConflictError);
  assert(failure.conflicts.every(file => file.entityDeletion === false));
  conflicts.storeGitHubSyncConflict(state, targets[0].id, failure);
  conflicts.selectGitHubSyncConflictDeletion(state, targets[0].id, bPath);
  await context.acceptGitHubSyncConflict({}, targets[0].id);
  assert.equal(targets[0].pendingDeletions.length, 0, "deleting one member never creates a tombstone for the entire entity");
  remember(targets[0], await sync.syncGitHubTarget(targets[0], catalog(stores[0]), checkouts, undefined, stores[0]));
  assert.throws(() => git(root, ["--git-dir", bare, "show", `main:${bPath}`]));
  assert.equal(git(root, ["--git-dir", bare, "show", "main:packages/Pair/a.txt"]), "local later A");
  assert.equal(git(root, ["--git-dir", bare, "show", "main:packages/Pair/c.txt"]), "remote new C");
  conflicts.clearGitHubSyncConflict(state, targets[0].id);
  remember(targets[1], await sync.syncGitHubTarget(targets[1], catalog(stores[1]), checkouts, undefined, stores[1]));
  fs.writeFileSync(path.join(stores[1], "packages", "Pair", "a.txt"), "remote batch A\n");
  fs.writeFileSync(path.join(stores[1], "packages", "Pair", "c.txt"), "remote batch C\n");
  remember(targets[1], await sync.syncGitHubTarget(targets[1], catalog(stores[1]), checkouts, undefined, stores[1]));
  failure = undefined;
  try {
    await sync.syncGitHubTarget(targets[0], catalog(stores[0]), checkouts, undefined, stores[0], phase => {
      if (phase === "push") fs.writeFileSync(path.join(stores[0], "packages", "Pair", "a.txt"), "edited during push A\n");
    });
  } catch (error) { failure = error; }
  assert(failure instanceof sync.GitHubSyncConflictError);
  assert.deepEqual(failure.conflicts.map(file => file.path).sort(), ["packages/Pair/a.txt", "packages/Pair/c.txt"],
    "a guarded batch failure retains every unapplied member, not just the file edited during push");
  conflicts.storeGitHubSyncConflict(state, targets[0].id, failure);
  conflicts.selectGitHubSyncConflictCandidate(state, targets[0].id, "packages/Pair/a.txt", "local");
  await context.acceptGitHubSyncConflict({}, targets[0].id);
  assert.equal(fs.readFileSync(path.join(stores[0], "packages", "Pair", "c.txt"), "utf8"), "remote batch C\n");
  remember(targets[0], await sync.syncGitHubTarget(targets[0], catalog(stores[0]), checkouts, undefined, stores[0]));
  assert.equal(git(root, ["--git-dir", bare, "show", "main:packages/Pair/c.txt"]), "remote batch C");
  assert.equal(git(root, ["--git-dir", bare, "show", "main:packages/Pair/a.txt"]), "edited during push A");
  conflicts.clearGitHubSyncConflict(state, targets[0].id);

  const recipeCatalogs = [empty(), empty()];
  for (const result of recipeCatalogs) result.recipes = [{
    id: recipe.recipeId, label: recipe.name, cat: "Shared", isPrivate: false,
    destination: "recipes/Shared/Merge.recipe_merge.json", content: encode(recipe).toString(),
  }];
  const recipeTargets = [0, 1].map(index => sync.normalizeGitHubSyncTarget({
    name: `recipe-${index}`, repository: bare, branch: "recipe-merge",
  }, () => `recipe-${index}`));
  for (let index = 0; index < 2; index++) remember(recipeTargets[index],
    await sync.syncGitHubTarget(recipeTargets[index], recipeCatalogs[index], checkouts, undefined, stores[index]));
  for (const [index, changed] of [localRecipe, remoteRecipe].entries()) {
    changed.revision = 2;
    changed.executableDigest = compileWorkflowDefinitionV1(changed.definition).executableDigest;
    recipeCatalogs[index].recipes[0].content = encode(changed).toString();
  }
  remember(recipeTargets[1], await sync.syncGitHubTarget(recipeTargets[1], recipeCatalogs[1], checkouts, undefined, stores[1]));
  const recipeMerged = await sync.syncGitHubTarget(recipeTargets[0], recipeCatalogs[0], checkouts, undefined, stores[0]);
  const publishedRecipe = JSON.parse(git(root, ["--git-dir", bare, "show", "recipe-merge:recipes/Shared/Merge.recipe_merge.json"]));
  assert.deepEqual(publishedRecipe.definition.spec.nodes.map(node => node.ports.outputs), [["local"], ["remote"]]);
  assert.equal(publishedRecipe.revision, 3);
  assert.equal(publishedRecipe.executableDigest, compileWorkflowDefinitionV1(publishedRecipe.definition).executableDigest);
  assert.equal(recipeMerged.recipePulls.length, 1);

  const agentTouched = [];
  const agentContext = vm.createContext({
    path, Buffer,
    githubSyncStateDirectory: () => state,
    readGitHubSyncConflict: () => ({ files: [
      { path: "skills/Manual.md", type: "skills", candidateSource: "manual" },
      { path: "skills/Pending.md", type: "skills", candidateSource: "unresolved" },
    ] }),
    listAiBackends: async () => [{ kind: "copilot", id: "fixture" }],
    optionalConflictText: () => "synthetic",
    runAiPrompt: async () => "mock",
    parseAgentMergeResponse: () => ({ mergedContent: "synthetic", rationale: "fixture", safeToApply: true, review: {} }),
    updateGitHubSyncAgentCandidate: (_state, _target, relative) => agentTouched.push(relative),
  });
  loadFunction("prepareGitHubSyncAgentCandidates", "githubSyncCandidateDestination", agentContext);
  assert.equal((await agentContext.prepareGitHubSyncAgentCandidates({}, "fixture")).prepared, 1);
  assert.deepEqual(agentTouched, ["skills/Pending.md"], "Agent batches preserve approved/manual candidates");
  const documentContext = vm.createContext({
    path, getStorePath: () => stores[0],
    githubSyncStateDirectory: () => state,
    readGitHubSyncConflict: () => ({ files: [{ path: bPath }] }),
    gitHubSyncConflictVariantPath: () => path.join(state, "merged"),
    githubSyncCandidateDestination: (store, relative) => path.join(store, relative),
    vscode: { workspace: { textDocuments: [{ isDirty: true, uri: { scheme: "file", fsPath: path.join(state, "merged") } }] } },
  });
  loadFunction("requireSavedGitHubSyncConflictDocuments", "withGitHubSyncConflictEdit", documentContext);
  assert.throws(() => documentContext.requireSavedGitHubSyncConflictDocuments({}, "fixture"), /unsaved editor/);
  documentContext.vscode.workspace.textDocuments[0].uri.fsPath = path.join(stores[0], bPath);
  assert.throws(() => documentContext.requireSavedGitHubSyncConflictDocuments({}, "fixture"), /unsaved editor/);
  documentContext.vscode.workspace.textDocuments[0].isDirty = false;
  assert.doesNotThrow(() => documentContext.requireSavedGitHubSyncConflictDocuments({}, "fixture"));
  console.log("github-sync resolution regressions passed (structural merge, multi-member acceptance/retry, preserved choices, approval hashes, dirty editors, Agent scope)");
}
main().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
