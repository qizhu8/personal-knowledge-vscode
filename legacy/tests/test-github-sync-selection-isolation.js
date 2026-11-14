const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { test } = require("node:test");
const build = path.resolve(process.env.PKM_SYNC_TEST_BUILD || "dist");
const { retrievalTestPython } = require("./retrieval-test-runtime");
const sync = require(path.join(build, "sync/github-sync"));
const { githubSyncCatalogInWorker } = require(path.join(build, "sync/github-sync-catalog-worker"));
const { scriptIdentityFile, setStorePath } = require(path.join(build, "knowledge/storage"));

const git = (cwd, args, binary = false) => execFileSync("git",
  ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
  { cwd, encoding: binary ? undefined : "utf8", stdio: ["ignore", "pipe", "pipe"] });
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const hash = content => createHash("sha256").update(content).digest("hex");
const skill = body => Buffer.from(`---\nname: Fixture\n---\n${body}\n`);

function fixture(t, manifest = true, beforeCleanup = async () => {}) {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".sync-selection-fixture-"));
  t.after(async () => { await beforeCleanup(); fs.rmSync(root, { recursive: true, force: true }); });
  const seed = path.join(root, "seed"), remote = path.join(root, "remote.git"), store = path.join(root, "store");
  fs.mkdirSync(seed); fs.mkdirSync(store);
  git(seed, ["init", "-q"]); git(seed, ["config", "user.name", "Fixture"]); git(seed, ["config", "user.email", "fixture@example.invalid"]);
  const files = [
    ["skills/Fixture.md", "skills", "Fixture", skill("initial")],
    ["notes/Shared.md", "notes", "Shared", Buffer.from("remote\r\nnote\r\n")],
    ["notes/image.png", "notes", "image", Buffer.from([0, 255, 13, 10, 128])],
    ["prompts/demo/task", "prompts", "demo/task", Buffer.from("remote\r\nprompt\r\n")],
  ];
  for (const [file, , , content] of files) put(path.join(seed, file), content);
  if (manifest) put(path.join(seed, ".pkm-github-sync.json"), sync.manifestJson(files.map(([file, type, itemId, content]) => ({
    path: file, type, itemId, member: "", category: type === "prompts" ? "demo" : "", privacy: "public", digest: hash(content),
  }))));
  git(seed, ["add", "."]); git(seed, ["commit", "-qm", "seed"]); git(seed, ["branch", "-M", "main"]);
  git(root, ["clone", "--bare", "-q", seed, remote]);
  put(path.join(store, "skills/Fixture.md"), skill("initial"));
  put(path.join(store, "notes/Shared.md"), "local note must not be read\n");
  put(path.join(store, "scripts/demo.py"), "print('fixture')\n");
  put(path.join(store, "actions/invalid.json"), "not JSON");
  setStorePath(store);
  const sidecar = scriptIdentityFile("demo.py");
  const target = sync.normalizeGitHubSyncTarget({ repository: remote, branch: "main", name: "fixture",
    selection: { public: { skills: { folders: [""] } }, private: {} } }, () => "fixture");
  const checkout = path.join(root, "checkouts");
  const catalog = () => githubSyncCatalogInWorker({ root: store, servers: [], recipes: [], types: ["skills"] });
  const acknowledge = result => {
    target.lastSync = { at: new Date().toISOString(), commit: result.commit, fingerprints: result.fingerprints,
      entityBases: result.entityBases, repository: remote, branch: "main", storeRoot: store };
    sync.completeGitHubSyncTransaction(checkout, target.id, result.transactionId);
  };
  const blob = file => git(root, ["--git-dir", remote, "show", `main:${file}`], true);
  return { root, remote, seed, store, sidecar, target, checkout, catalog, acknowledge, blob, files };
}

test("skills-only sync does not read other local areas and preserves other Git blobs exactly", async t => {
  const f = fixture(t);
  assert(!fs.existsSync(f.sidecar));
  const catalog = await f.catalog();
  assert.deepEqual(catalog.scripts, []);
  assert(!fs.existsSync(f.sidecar), "catalog must not materialize Script identities");
  catalog.scripts.push({ id: "demo.py", cat: "", isPrivate: false, destination: "scripts/demo.py",
    dependencies: [{ source: path.join(f.store, "notes/Shared.md"), destination: "scripts/.demo.py.pkm.json" }] });
  const originalRead = fs.readFileSync;
  const forbidden = ["notes", "scripts", "prompts", "actions"].map(area => path.join(f.store, area) + path.sep);
  const reads = [];
  fs.readFileSync = function(file, ...args) {
    if (typeof file === "string" && forbidden.some(prefix => file.startsWith(prefix))) reads.push(file);
    return originalRead.call(this, file, ...args);
  };
  try {
    const preview = await sync.previewGitHubSyncTarget(f.target, catalog, f.checkout, undefined, f.store);
    assert.equal(preview.differences.length, 0);
    f.acknowledge(await sync.syncGitHubTarget(f.target, catalog, f.checkout, undefined, f.store));
    git(path.join(f.checkout, f.target.id, "repository"), ["config", "core.autocrlf", "true"]);
    put(path.join(f.store, "skills/Fixture.md"), skill("local edit"));
    const result = await sync.syncGitHubTarget(f.target, await f.catalog(), f.checkout, undefined, f.store);
    assert(result.changed);
    f.acknowledge(result);
    assert(f.blob("skills/Fixture.md").equals(skill("local edit")));
    for (const [file, type, , bytes] of f.files) if (type !== "skills") {
      assert(f.blob(file).equals(bytes), `${file} must retain exact blob bytes`);
    }
    assert.deepEqual(reads, []);
    assert(!fs.existsSync(f.sidecar));
  } finally { fs.readFileSync = originalRead; }
});

test("selected catalog areas retain identity creation and propagate errors", async t => {
  const f = fixture(t);
  const input = { root: f.store, servers: [], recipes: [] };
  const catalog = await githubSyncCatalogInWorker({ ...input, types: ["scripts"] });
  assert.equal(catalog.scripts.length, 1);
  assert(fs.existsSync(f.sidecar));
  await assert.rejects(() => githubSyncCatalogInWorker({ ...input, types: ["actions"] }), /JSON|Unexpected token/i);
});

test("host builds the target catalog without querying unselected Recipe or Server stores", async t => {
  const f = fixture(t), ts = require("typescript"), vm = require("node:vm");
  const source = fs.readFileSync(path.join(process.cwd(), "src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "buildGitHubSyncCatalog");
  assert(declaration);
  const scope = {
    path, getStorePath: () => f.store, GITHUB_SYNC_CONTENT_TYPES: sync.GITHUB_SYNC_CONTENT_TYPES,
    selectionIncludesType: sync.selectionIncludesType, githubSyncCatalogInWorker,
    currentProjectStore: () => { throw new Error("unselected Recipe store read"); },
    serverList: () => { throw new Error("unselected Server store read"); },
  };
  vm.runInNewContext(ts.transpileModule(`${declaration.getText(ast)}\nglobalThis.build = buildGitHubSyncCatalog;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, scope);
  const catalog = await scope.build(f.target);
  assert.equal(catalog.skills.length, 1);
  assert.equal(catalog.scripts.length, 0);
  assert(!fs.existsSync(f.sidecar));
});

test("host finalization updates Skills only after an actual pull without reading other areas", async t => {
  let stopWorker = async () => {};
  const f = fixture(t, true, () => stopWorker()), ts = require("typescript"), vm = require("node:vm");
  const originalCatalog = await f.catalog();
  f.acknowledge(await sync.syncGitHubTarget(f.target, originalCatalog, f.checkout, undefined, f.store));
  const remoteEdit = skill("remote pull");
  put(path.join(f.seed, "skills/Fixture.md"), remoteEdit);
  git(f.seed, ["fetch", "-q", f.remote, "main"]); git(f.seed, ["reset", "-q", "--soft", "FETCH_HEAD"]);
  const manifestPath = path.join(f.seed, ".pkm-github-sync.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.files.find(file => file.path === "skills/Fixture.md").digest = hash(remoteEdit);
  put(manifestPath, JSON.stringify(manifest));
  git(f.seed, ["add", "."]); git(f.seed, ["commit", "-qm", "remote skill pull"]);
  git(f.seed, ["push", "-q", f.remote, "main"]);
  const result = await sync.syncGitHubTarget(f.target, await f.catalog(), f.checkout, undefined, f.store);
  assert.deepEqual(result.pulled, ["skills/Fixture.md"]);

  const source = fs.readFileSync(path.join(process.cwd(), "src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  const names = ["isSkillsOnlyGitHubSync", "scopedSyncRefreshState", "scopedSyncRefreshMarker", "persistScopedSyncRefresh", "deferScopedSyncRefresh", "restoreScopedSyncRefresh",
    "beginScopedSyncRefresh", "refreshKnowledgeInventory", "retrievalSkillRows", "currentRetrievalSnapshot", "currentSkillsRetrievalSnapshot",
    "refreshRetrievalIndex", "refreshRetrievalSkillsIndex", "finalizeGitHubSyncServiceResult"];
  const declarations = names.map(name => {
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert(node, name);
    return node.getText(ast);
  });
  const storage = require(path.join(build, "knowledge/storage"));
  const filestore = require(path.join(build, "knowledge/filestore"));
  filestore.setStorePath(f.store); storage.setStorePath(f.store);
  const { RetrievalWorkerManager } = require(path.join(build, "retrieval/retrieval-worker"));
  const { createRetrievalSnapshot } = require(path.join(build, "retrieval/retrieval-snapshot"));
  const state = path.join(f.root, "retrieval-state");
  const worker = new RetrievalWorkerManager(state, path.join(process.cwd(), "resources/retrieval_worker.py"),
    retrievalTestPython(t), "0.3.0.dev2026100504");
  stopWorker = async () => {
    const endpointPath = path.join(state, "worker.json");
    if (!fs.existsSync(endpointPath)) return;
    const endpoint = JSON.parse(fs.readFileSync(endpointPath, "utf8"));
    try { await fetch(`http://127.0.0.1:${endpoint.port}/shutdown`, { method: "POST", headers: { "X-PKM-Retrieval-Token": endpoint.token } }); } catch {}
  };
  const initial = createRetrievalSnapshot({
    skills: filestore.skillList().map(row => ({ ...row, ...filestore.skillGet(row.name), content: "previous indexed content" })),
    notes: [{ slug: "Shared", title: "Shared", content: "unchanged note", knowledgeId: "knowledge_" + "3".repeat(24) }],
    scripts: [{ path: "demo.py", file: "demo.py", content: "unchanged script", knowledgeId: "script_" + "4".repeat(24) }],
    papers: [], recipes: [], subscriptionGroups: [], readSubscription() { throw new Error("unexpected subscription access"); },
  });
  await worker.sync(initial);
  const until = Date.now() + 30000;
  while (true) {
    const status = await worker.status();
    if (status.ready && status.corpus_revision === initial.corpus_revision) break;
    if (Date.now() > until) throw new Error("Retrieval worker timed out");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const before = JSON.parse(fs.readFileSync(path.join(state, "snapshot.json")));
  const untouched = before.documents.filter(doc => doc.content_type !== "skill");
  const beforeEvents = JSON.parse(fs.readFileSync(path.join(state, "index-events.json")));
  const beforeManifest = JSON.parse(fs.readFileSync(path.join(state, "client-index.json")));
  const index = path.join(f.root, "existing-index.json");
  const originalIndex = Buffer.from('{"scripts":["existing-script"]}');
  put(index, originalIndex);
  const warnings = [], reads = [];
  let inventoryRefreshes = 0, indexSubmissions = 0, scopedSubmissions = 0, refreshReports = 0, notifications = 0, treeRefreshes = 0, failOnce = true;
  const scope = {
    path, fs, process, createHash, GITHUB_SYNC_CONTENT_TYPES: sync.GITHUB_SYNC_CONTENT_TYPES, selectionIncludesType: sync.selectionIncludesType,
    retrievalStateDirectory: () => state, retrievalWorkerRoot: f.store,
    scopedSyncRefresh: new Map(), scopedSyncRefreshGeneration: 0, getStorePath: () => f.store,
    vscode: { window: { showWarningMessage: message => { warnings.push(message); return Promise.resolve(undefined); } } },
    log: { warn() {}, info() {} },
    githubSyncTargetById: () => f.target, githubSyncStateDirectory: () => f.root,
    validateGitHubSyncTransaction: sync.validateGitHubSyncTransaction, completeGitHubSyncTransaction: sync.completeGitHubSyncTransaction,
    applyGitHubSyncRecipePulls() {}, applyGitHubSyncRecipeDeletes() {}, setTopLevelPrivacy() {},
    invalidateSharedContentCatalog() {}, _treeProvider: { refresh: () => { treeRefreshes++; } },
    mutateGitHubSyncTargets: async (_context, _action, update) => update([f.target]).result,
    githubPublicationMigration: () => ({ status: () => undefined }),
    clearGitHubSyncContentRepair() {}, clearGitHubSyncConflict() {},
    githubSyncResultIsNoChange: sync.githubSyncResultIsNoChange, githubSyncScheduler: { notifyContentChanged: () => { notifications++; } },
    knowledgeInventory: { refresh: async () => { inventoryRefreshes++; fs.readFileSync(path.join(f.store, "notes/Shared.md")); } },
    inventoryTask: { running() {}, idle() {} }, performanceStateDir: undefined,
    mcpRuntimeStatusAsync: async () => ({ healthy: true }),
    retrievalWorker: {
      sync: async () => { indexSubmissions++; put(index, "{}"); return { mode: "full", upserts: 1, deletes: 1 }; },
      syncSkills: async value => {
        scopedSubmissions++;
        assert.equal(value.documents.length, 1);
        if (failOnce) { failOnce = false; throw new Error("fixture index failure"); }
        return worker.syncSkills(value);
      },
    },
    scheduleRetrievalSolutionStatus() {}, scheduleRetrievalRefresh() {}, schedulePublishedShareRefresh() {},
    skillList: filestore.skillList, skillGet: filestore.skillGet,
    knowledgeFilePath: filestore.knowledgeFilePath,
    referencedMarkdownAssets: require(path.join(build, "knowledge/markdown-assets")).referencedMarkdownAssets,
    noteList: filestore.noteList, paperList: filestore.paperList, paperGet: filestore.paperGet,
    scriptList: storage.scriptList, scriptGet: storage.scriptGet,
    sharedMarket: undefined, currentProjectStore: () => ({ list: () => ({ recipes: [] }) }),
    createRetrievalSnapshot,
  };
  vm.runInNewContext(ts.transpileModule(`${declarations.join("\n")}\nglobalThis.host = {
    finalizeGitHubSyncServiceResult, beginScopedSyncRefresh, refreshRetrievalIndex, restoreScopedSyncRefresh
  };`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, scope);
  const methods = ["readFileSync", "readdirSync", "statSync", "lstatSync", "realpathSync"];
  const originals = Object.fromEntries(methods.map(method => [method, fs[method]]));
  for (const method of methods) fs[method] = function(file, ...args) {
    if (typeof file === "string" && ["notes", "scripts"].some(area => {
      const directory = path.join(f.store, area);
      return file === directory || file.startsWith(directory + path.sep);
    })) reads.push(`${method}:${file}`);
    return originals[method].call(this, file, ...args);
  };
  try {
    const end = scope.host.beginScopedSyncRefresh(f.target, {});
    await assert.rejects(() => scope.host.finalizeGitHubSyncServiceResult({}, f.target.id, "manual", result, () => { refreshReports++; }),
      /committed .* Skills search indexing failed: (?:Error: )?fixture index failure/);
    assert.equal(scope.scopedSyncRefresh.get(f.store).skillsIndexed, false);
    await scope.host.finalizeGitHubSyncServiceResult({}, f.target.id, "manual", result, () => { refreshReports++; });
    end();
    assert.equal(inventoryRefreshes, 0);
    assert.equal(indexSubmissions, 0);
    assert.equal(scopedSubmissions, 2);
    assert.equal(refreshReports, 2);
    assert.equal(notifications, 0);
    assert.equal(treeRefreshes, 0);
    assert.deepEqual(reads, []);
    assert(!fs.existsSync(f.sidecar));
    assert(fs.readFileSync(index).equals(originalIndex));
    const after = JSON.parse(fs.readFileSync(path.join(state, "snapshot.json")));
    assert.deepEqual(after.documents.filter(doc => doc.content_type !== "skill"), untouched);
    assert(after.documents.find(doc => doc.content_type === "skill").body.includes("remote pull"));
    const events = JSON.parse(fs.readFileSync(path.join(state, "index-events.json")));
    const indexManifest = JSON.parse(fs.readFileSync(path.join(state, "client-index.json")));
    for (const doc of untouched) {
      assert.deepEqual(events.sources[doc.source_id], beforeEvents.sources[doc.source_id]);
      assert.equal(indexManifest.hashes[doc.skill_id], beforeManifest.hashes[doc.skill_id]);
      assert.equal(indexManifest.source_ids[doc.skill_id], beforeManifest.source_ids[doc.skill_id]);
    }
    assert(warnings.some(message => /Skills search was updated.*full refresh reads all Knowledge areas/i.test(message)));
    const marker = JSON.parse(fs.readFileSync(path.join(f.root, "retrieval-state", "skills-only-refresh.json")));
    assert.equal(marker.skillsIndexed, true);
    scope.scopedSyncRefresh.clear();
    scope.host.restoreScopedSyncRefresh({});
    assert.equal(scope.scopedSyncRefresh.get(f.store).pending, true);
    assert.equal(scope.scopedSyncRefresh.get(f.store).skillsIndexed, true);
  } finally { for (const method of methods) fs[method] = originals[method]; }
  await scope.host.refreshRetrievalIndex({});
  assert.equal(indexSubmissions, 1, "an explicit full refresh retains its original behavior");
  assert(fs.existsSync(f.sidecar), "the healthy full-refresh branch must exercise the real Script identity creation");
});

test("a previously scheduled automatic retrieval refresh cannot bypass the Skills Sync barrier", async t => {
  const f = fixture(t), ts = require("typescript"), vm = require("node:vm");
  const source = fs.readFileSync(path.join(process.cwd(), "src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = ["isSkillsOnlyGitHubSync", "scopedSyncRefreshState", "scopedSyncRefreshMarker", "persistScopedSyncRefresh", "deferScopedSyncRefresh",
    "beginScopedSyncRefresh", "runAutomaticRetrievalRefresh", "scheduleRetrievalRefresh"].map(name => {
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert(node);
    return node.getText(ast);
  });
  let submissions = 0, acceptRefresh;
  const warnings = [];
  const scope = {
    path, fs, process, setTimeout, clearTimeout, GITHUB_SYNC_CONTENT_TYPES: sync.GITHUB_SYNC_CONTENT_TYPES,
    retrievalStateDirectory: () => path.join(f.root, "retrieval-state"),
    selectionIncludesType: sync.selectionIncludesType, scopedSyncRefresh: new Map(), scopedSyncRefreshGeneration: 0, getStorePath: () => f.store,
    log: { warn() {} },
    vscode: { window: { showWarningMessage: message => { warnings.push(message); return new Promise(resolve => { acceptRefresh = resolve; }); },
      withProgress: (_options, run) => run() }, ProgressLocation: { Window: 1 } },
    retrievalRefreshTimer: undefined, retrievalRefreshRunning: undefined,
    retrievalQueuedTask: { queued() {}, idle() {} }, retrievalRunningTask: { running() {}, idle() {} },
    mcpRuntimeStatusAsync: async () => ({ healthy: true }),
    refreshKnowledgeInventory: async () => {}, _treeProvider: undefined,
    schedulePublishedShareRefresh() {}, githubSyncScheduler: { notifyContentChanged() {} },
    refreshRetrievalIndex: async () => { submissions++; require(path.join(build, "knowledge/storage")).scriptGet("demo.py"); },
  };
  vm.runInNewContext(ts.transpileModule(`${declarations.join("\n")}\nglobalThis.host = {
    beginScopedSyncRefresh, scheduleRetrievalRefresh
  };`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, scope);
  scope.host.scheduleRetrievalRefresh({}, 10);
  const end = scope.host.beginScopedSyncRefresh(f.target, {});
  await new Promise(resolve => setTimeout(resolve, 50));
  end();
  assert.equal(submissions, 0);
  assert(!fs.existsSync(f.sidecar));
  assert(warnings.some(message => /may be stale/.test(message)));
  acceptRefresh("Refresh all now");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(submissions, 1);
  assert(fs.existsSync(f.sidecar), "the user-approved full refresh remains available");
  assert.equal(scope.scopedSyncRefresh.get(f.store).pending, false);
});

test("an automatic full refresh paused in the health probe cannot scan after Skills Sync starts", async t => {
  const f = fixture(t), ts = require("typescript"), vm = require("node:vm");
  const source = fs.readFileSync(path.join(process.cwd(), "src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = ["isSkillsOnlyGitHubSync", "scopedSyncRefreshState", "scopedSyncRefreshMarker", "persistScopedSyncRefresh",
    "deferScopedSyncRefresh", "beginScopedSyncRefresh", "refreshRetrievalIndex", "runAutomaticRetrievalRefresh", "scheduleRetrievalRefresh"].map(name => {
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert(node, name);
    return node.getText(ast);
  });
  let releaseHealth, probeStarted, submissions = 0;
  const started = new Promise(resolve => { probeStarted = resolve; });
  const scope = {
    path, fs, process, setTimeout, clearTimeout, GITHUB_SYNC_CONTENT_TYPES: sync.GITHUB_SYNC_CONTENT_TYPES,
    selectionIncludesType: sync.selectionIncludesType, scopedSyncRefresh: new Map(), scopedSyncRefreshGeneration: 0, getStorePath: () => f.store,
    retrievalStateDirectory: () => path.join(f.root, "retrieval-state"), retrievalWorkerRoot: f.store,
    log: { warn() {}, info() {} },
    vscode: { window: { showWarningMessage: async () => undefined, withProgress: (_options, run) => run() },
      ProgressLocation: { Window: 1 } },
    retrievalRefreshTimer: undefined, retrievalRefreshRunning: undefined,
    retrievalQueuedTask: { queued() {}, idle() {} }, retrievalRunningTask: { running() {}, idle() {} },
    mcpRuntimeStatusAsync: () => { probeStarted(); return new Promise(resolve => { releaseHealth = resolve; }); },
    retrievalWorker: { sync: async () => { submissions++; return { mode: "full", upserts: 1, deletes: 0 }; } },
    currentRetrievalSnapshot: () => {
      require(path.join(build, "knowledge/storage")).scriptGet("demo.py");
      return { corpus_revision: "full", documents: [] };
    },
    scheduleRetrievalSolutionStatus() {}, performanceStateDir: undefined,
  };
  vm.runInNewContext(ts.transpileModule(`${declarations.join("\n")}\nglobalThis.host = {
    beginScopedSyncRefresh, scheduleRetrievalRefresh, refreshRetrievalIndex
  };`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, scope);
  scope.host.scheduleRetrievalRefresh({}, 0);
  await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error("health probe did not start")), 2000))]);
  const end = scope.host.beginScopedSyncRefresh(f.target, {});
  releaseHealth({ healthy: true });
  await scope.retrievalRefreshRunning;
  end();
  assert.equal(submissions, 0, "an automatic refresh must recheck the barrier after async runtime health");
  assert(!fs.existsSync(f.sidecar), "the interrupted automatic refresh must not read Scripts");
});

test("an automatic refresh cannot scan after a whole Skills barrier passes during health", async t => {
  const f = fixture(t), ts = require("typescript"), vm = require("node:vm");
  const source = fs.readFileSync(path.join(process.cwd(), "src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = ["isSkillsOnlyGitHubSync", "scopedSyncRefreshState", "scopedSyncRefreshMarker", "persistScopedSyncRefresh",
    "deferScopedSyncRefresh", "beginScopedSyncRefresh", "refreshRetrievalIndex"].map(name => {
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert(node, name);
    return node.getText(ast);
  });
  let releaseHealth, scans = 0;
  const scope = {
    path, fs, process, GITHUB_SYNC_CONTENT_TYPES: sync.GITHUB_SYNC_CONTENT_TYPES,
    selectionIncludesType: sync.selectionIncludesType, scopedSyncRefresh: new Map(), scopedSyncRefreshGeneration: 0,
    getStorePath: () => f.store, retrievalStateDirectory: () => path.join(f.root, "retrieval-state"),
    mcpRuntimeStatusAsync: () => new Promise(resolve => { releaseHealth = resolve; }),
    vscode: { window: { showWarningMessage: async () => undefined } }, log: { warn() {}, info() {} },
    retrievalWorker: { sync: async () => { scans++; } },
    currentRetrievalSnapshot: () => { require(path.join(build, "knowledge/storage")).scriptGet("demo.py"); return {}; },
  };
  vm.runInNewContext(ts.transpileModule(`${declarations.join("\n")}\nglobalThis.host = {
    beginScopedSyncRefresh, refreshRetrievalIndex
  };`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, scope);
  const refresh = scope.host.refreshRetrievalIndex({}, true);
  scope.host.beginScopedSyncRefresh(f.target, {})();
  releaseHealth({ healthy: true });
  await refresh;
  assert.equal(scans, 0);
  assert(!fs.existsSync(f.sidecar));
});

test("implicit worker startup during a Skills barrier uses the scoped index", async t => {
  const f = fixture(t), ts = require("typescript"), vm = require("node:vm");
  const source = fs.readFileSync(path.join(process.cwd(), "src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === "requireRetrievalWorker");
  assert(node);
  let scoped = 0, full = 0;
  const scope = {
    retrievalWorker: undefined, retrievalRefreshRunning: undefined, scopedSyncRefreshState: () => ({ active: 1, pending: false }),
    refreshRetrievalIndex: async () => { full++; require(path.join(build, "knowledge/storage")).scriptGet("demo.py"); },
    refreshRetrievalSkillsIndex: async () => { scoped++; scope.retrievalWorker = { ready: true }; },
  };
  vm.runInNewContext(ts.transpileModule(`${node.getText(ast)}\nglobalThis.requireWorker = requireRetrievalWorker;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, scope);
  assert.equal((await scope.requireWorker({})).ready, true);
  assert.equal(scoped, 1);
  assert.equal(full, 0);
  assert(!fs.existsSync(f.sidecar));
});

test("the Skills Sync run response does not trigger an unselected full catalog", async t => {
  const f = fixture(t), ts = require("typescript"), vm = require("node:vm");
  const source = fs.readFileSync(path.join(process.cwd(), "src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  let branch;
  const find = node => {
    if (ts.isCaseClause(node) && node.expression.getText(ast) === '"githubSyncRun"') branch = node;
    ts.forEachChild(node, find);
  };
  find(ast);
  assert(branch);
  const calls = [];
  const scope = {
    msg: { targetId: f.target.id }, context: {}, respond() {},
    githubSyncTargetById: () => f.target, githubPublicationMigration: () => ({ status: () => undefined }),
    requireGitHubSyncManualMode() {}, githubSyncScheduler: { request: async () => true },
    isSkillsOnlyGitHubSync: target => sync.selectionIncludesType(target, "skills")
      && sync.GITHUB_SYNC_CONTENT_TYPES.every(type => type === "skills" || !sync.selectionIncludesType(target, type)),
    githubSyncStateData: async (_context, expensive = true, refreshConflicts = true) => {
      calls.push({ expensive, refreshConflicts });
      if (expensive) await githubSyncCatalogInWorker({ root: f.store, servers: [], recipes: [], types: ["scripts"] });
      return {};
    },
  };
  vm.runInNewContext(ts.transpileModule(`globalThis.run = async () => {
    switch ("githubSyncRun") { ${branch.getText(ast)} }
  };`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, scope);
  await scope.run();
  assert.deepEqual(calls, [{ expensive: false, refreshConflicts: false }]);
  assert(!fs.existsSync(f.sidecar), "the response must not create an unselected Script identity");
});

test("the Skills conflict acceptance response does not trigger an unselected full catalog", async t => {
  const f = fixture(t), ts = require("typescript"), vm = require("node:vm");
  const source = fs.readFileSync(path.join(process.cwd(), "src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  let branch;
  const find = node => {
    if (ts.isCaseClause(node) && node.expression.getText(ast) === '"githubSyncConflictAccept"') branch = node;
    ts.forEachChild(node, find);
  };
  find(ast);
  assert(branch);
  const calls = [];
  const scope = {
    msg: { targetId: f.target.id }, context: {}, respond() {},
    githubSyncTargetById: () => f.target,
    isSkillsOnlyGitHubSync: target => sync.selectionIncludesType(target, "skills")
      && sync.GITHUB_SYNC_CONTENT_TYPES.every(type => type === "skills" || !sync.selectionIncludesType(target, type)),
    withGitHubSyncConflictEdit: async (_context, _msg, action) => action(),
    withGitHubSyncApplyLock: async (_context, action) => action(),
    acceptGitHubSyncConflict: async () => ({ accepted: 1, refreshed: [] }),
    vscode: { window: { showWarningMessage() {}, showInformationMessage() {} } },
    githubSyncStateData: async (_context, expensive = true, refreshConflicts = true) => {
      calls.push({ expensive, refreshConflicts });
      if (expensive) await githubSyncCatalogInWorker({ root: f.store, servers: [], recipes: [], types: ["scripts"] });
      return {};
    },
  };
  vm.runInNewContext(ts.transpileModule(`globalThis.run = async () => {
    switch ("githubSyncConflictAccept") { ${branch.getText(ast)} }
  };`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, scope);
  await scope.run();
  assert.deepEqual(calls, [{ expensive: false, refreshConflicts: false }]);
  assert(!fs.existsSync(f.sidecar));
});

test("the host filesystem watcher defers a Sync-generated Skill event", async t => {
  const f = fixture(t), ts = require("typescript"), vm = require("node:vm");
  const source = fs.readFileSync(path.join(process.cwd(), "src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = ["isSkillsOnlyGitHubSync", "scopedSyncRefreshState", "scopedSyncRefreshMarker", "persistScopedSyncRefresh",
    "deferScopedSyncRefresh", "restoreScopedSyncRefresh", "beginScopedSyncRefresh", "startFileWatcher"].map(name => {
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert(node);
    return node.getText(ast);
  });
  const watchers = [], calls = [], warnings = [];
  const scope = {
    path, fs, process, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    retrievalStateDirectory: () => path.join(f.root, "retrieval-state"),
    GITHUB_SYNC_CONTENT_TYPES: sync.GITHUB_SYNC_CONTENT_TYPES, selectionIncludesType: sync.selectionIncludesType,
    scopedSyncRefresh: new Map(), scopedSyncRefreshGeneration: 0, getStorePath: () => f.store,
    _watcher: undefined, _privacyWatcher: undefined, _projectStateWatcher: undefined, _projectContentWatcher: undefined,
    _recipeContentWatcher: undefined, _watcherRefreshTimer: undefined, _projectStateRefreshTimer: undefined,
    _watcherFallbackTimer: undefined, _watcherSignatureController: undefined,
    _watcherSkillProjectionChanged: false, _knowledgeTreeSignature: "",
    contentCheckTask: { idle() {}, queued() {}, running() {} },
    createKnowledgeFileWatcher: () => {
      const callbacks = {};
      const watcher = { onDidCreate: cb => { callbacks.create = cb; }, onDidChange: cb => { callbacks.change = cb; },
        onDidDelete: cb => { callbacks.delete = cb; }, dispose() {}, callbacks };
      watchers.push(watcher); return watcher;
    },
    githubSyncIgnoredPath: sync.githubSyncIgnoredPath, githubSyncExcludedPaths: async () => new Set(),
    invalidateSharedContentCatalog() {}, _treeProvider: { refresh: () => calls.push("tree") },
    knowledgeTreeSignature: async () => { calls.push("full signature"); return ""; },
    scheduleRetrievalRefresh: () => calls.push("retrieval"), schedulePublishedShareRefresh: () => calls.push("broker"),
    refreshKnowledgeInventory: () => calls.push("inventory"), postToPanel: () => calls.push("panel"),
    log: { warn() {}, info() {} },
    vscode: { window: { showWarningMessage: message => { warnings.push(message); return Promise.resolve(undefined); } } },
  };
  vm.runInNewContext(ts.transpileModule(`${declarations.join("\n")}\nglobalThis.host = {
    beginScopedSyncRefresh, startFileWatcher
  };`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, scope);
  const end = scope.host.beginScopedSyncRefresh(f.target, {});
  scope.host.startFileWatcher({ subscriptions: [] });
  try {
    watchers[0].callbacks.change({ fsPath: path.join(f.store, "skills/Fixture.md") });
    await new Promise(resolve => setTimeout(resolve, 350));
    end();
    assert.deepEqual(calls, []);
    assert(warnings.some(message => /may be stale/.test(message)));
    assert(!fs.existsSync(f.sidecar));
  } finally {
    scope._watcherSignatureController.abort();
    clearInterval(scope._watcherFallbackTimer);
    clearTimeout(scope._watcherRefreshTimer);
  }
});

test("default multi-area Sync still refreshes the full inventory and retrieval", async t => {
  const f = fixture(t), ts = require("typescript"), vm = require("node:vm");
  f.acknowledge(await sync.syncGitHubTarget(f.target, await f.catalog(), f.checkout, undefined, f.store));
  put(path.join(f.store, "skills/Fixture.md"), skill("local edit"));
  const result = await sync.syncGitHubTarget(f.target, await f.catalog(), f.checkout, undefined, f.store);
  assert(result.changed);
  f.target.selection = sync.defaultGitHubSyncSelection();
  const source = fs.readFileSync(path.join(process.cwd(), "src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = ["isSkillsOnlyGitHubSync", "finalizeGitHubSyncServiceResult"].map(name => {
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert(node);
    return node.getText(ast);
  });
  let inventory = 0, retrieval = 0, reported = 0;
  const scope = {
    path, createHash, GITHUB_SYNC_CONTENT_TYPES: sync.GITHUB_SYNC_CONTENT_TYPES, selectionIncludesType: sync.selectionIncludesType,
    getStorePath: () => f.store, githubSyncTargetById: () => f.target, githubSyncStateDirectory: () => f.root,
    validateGitHubSyncTransaction: sync.validateGitHubSyncTransaction, completeGitHubSyncTransaction: sync.completeGitHubSyncTransaction,
    applyGitHubSyncRecipePulls() {}, applyGitHubSyncRecipeDeletes() {}, setTopLevelPrivacy() {},
    invalidateSharedContentCatalog() {}, _treeProvider: undefined,
    mutateGitHubSyncTargets: async (_context, _action, update) => update([f.target]).result,
    githubPublicationMigration: () => ({ status: () => undefined }),
    clearGitHubSyncContentRepair() {}, clearGitHubSyncConflict() {},
    githubSyncResultIsNoChange: sync.githubSyncResultIsNoChange, githubSyncScheduler: { notifyContentChanged() {} },
    refreshKnowledgeInventory: async () => { inventory++; }, refreshRetrievalIndex: async () => { retrieval++; },
  };
  vm.runInNewContext(ts.transpileModule(`${declarations.join("\n")}\nglobalThis.finalize = finalizeGitHubSyncServiceResult;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, scope);
  await scope.finalize({}, f.target.id, "manual", result, () => { reported++; });
  assert.deepEqual([inventory, retrieval, reported], [1, 1, 1]);
});

test("selected conflicts and invalid remote manifest digests remain explicit", async t => {
  const f = fixture(t), catalog = await f.catalog();
  f.acknowledge(await sync.syncGitHubTarget(f.target, catalog, f.checkout, undefined, f.store));
  put(path.join(f.store, "skills/Fixture.md"), skill("local edit"));
  const remoteEdit = skill("remote edit");
  put(path.join(f.seed, "skills/Fixture.md"), remoteEdit);
  const manifestPath = path.join(f.seed, ".pkm-github-sync.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.files.find(file => file.path === "skills/Fixture.md").digest = hash(remoteEdit);
  put(manifestPath, JSON.stringify(manifest));
  git(f.seed, ["add", "."]); git(f.seed, ["commit", "-qm", "remote edit"]);
  git(f.seed, ["push", "-q", f.remote, "main"]);
  await assert.rejects(() => sync.syncGitHubTarget(f.target, catalog, f.checkout, undefined, f.store),
    error => error instanceof sync.GitHubSyncConflictError && error.conflicts.some(file => file.path === "skills/Fixture.md"));
  git(f.seed, ["fetch", "-q", f.remote, "main"]); git(f.seed, ["reset", "-q", "--hard", "FETCH_HEAD"]);
  const invalid = JSON.parse(fs.readFileSync(manifestPath));
  invalid.files.find(file => file.path === "notes/Shared.md").digest = "0".repeat(64);
  put(manifestPath, JSON.stringify(invalid)); git(f.seed, ["add", "."]); git(f.seed, ["commit", "-qm", "invalid digest"]);
  git(f.seed, ["push", "-q", f.remote, "main"]);
  const before = git(f.root, ["--git-dir", f.remote, "rev-parse", "main"]);
  await assert.rejects(() => sync.syncGitHubTarget(f.target, catalog, f.checkout, undefined, f.store), /digest|hash/i);
  assert.equal(git(f.root, ["--git-dir", f.remote, "rev-parse", "main"]), before);
});

test("Skills conflict acceptance and retry index only Skills without reading other areas", async t => {
  let stopWorker = async () => {};
  const f = fixture(t, true, () => stopWorker()), ts = require("typescript"), vm = require("node:vm");
  const conflicts = require(path.join(build, "sync/github-sync-conflicts"));
  const filestore = require(path.join(build, "knowledge/filestore"));
  const storage = require(path.join(build, "knowledge/storage"));
  const { RetrievalWorkerManager } = require(path.join(build, "retrieval/retrieval-worker"));
  const { createRetrievalSnapshot } = require(path.join(build, "retrieval/retrieval-snapshot"));
  filestore.setStorePath(f.store); storage.setStorePath(f.store);
  f.acknowledge(await sync.syncGitHubTarget(f.target, await f.catalog(), f.checkout, undefined, f.store));
  put(path.join(f.store, "skills/Fixture.md"), skill("local edit"));
  const remoteEdit = skill("remote edit");
  put(path.join(f.seed, "skills/Fixture.md"), remoteEdit);
  const manifestPath = path.join(f.seed, ".pkm-github-sync.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.files.find(file => file.path === "skills/Fixture.md").digest = hash(remoteEdit);
  put(manifestPath, JSON.stringify(manifest));
  git(f.seed, ["add", "."]); git(f.seed, ["commit", "-qm", "conflict remote"]);
  git(f.seed, ["push", "-q", f.remote, "main"]);
  let conflict;
  try { await sync.syncGitHubTarget(f.target, await f.catalog(), f.checkout, undefined, f.store); }
  catch (error) { conflict = error; }
  assert(conflict instanceof sync.GitHubSyncConflictError);
  const state = path.join(f.root, "review"), retrievalState = path.join(f.root, "retrieval-state");
  conflicts.storeGitHubSyncConflict(state, f.target.id, conflict);
  conflicts.selectGitHubSyncConflictCandidate(state, f.target.id, "skills/Fixture.md", "remote");
  const worker = new RetrievalWorkerManager(retrievalState, path.join(process.cwd(), "resources/retrieval_worker.py"),
    retrievalTestPython(t), "0.3.0.dev2026100504");
  stopWorker = async () => {
    const file = path.join(retrievalState, "worker.json");
    if (!fs.existsSync(file)) return;
    const endpoint = JSON.parse(fs.readFileSync(file, "utf8"));
    try { await fetch(`http://127.0.0.1:${endpoint.port}/shutdown`, { method: "POST", headers: { "X-PKM-Retrieval-Token": endpoint.token } }); } catch {}
  };
  const initial = createRetrievalSnapshot({
    skills: filestore.skillList().map(row => ({ ...row, ...filestore.skillGet(row.name) })),
    notes: [{ slug: "Shared", title: "Shared", content: "unchanged note", knowledgeId: "knowledge_" + "3".repeat(24) }],
    scripts: [{ path: "demo.py", file: "demo.py", content: "unchanged script", knowledgeId: "script_" + "4".repeat(24) }],
    papers: [], recipes: [], subscriptionGroups: [], readSubscription() { throw new Error("unexpected subscription access"); },
  });
  await worker.sync(initial);
  const until = Date.now() + 30000;
  while (true) {
    const status = await worker.status();
    if (status.ready && status.corpus_revision === initial.corpus_revision && !status.building_revision) break;
    if (Date.now() > until) throw new Error("Retrieval worker timed out");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const before = JSON.parse(fs.readFileSync(path.join(retrievalState, "snapshot.json")));
  const untouched = before.documents.filter(doc => doc.content_type !== "skill");
  const source = fs.readFileSync(path.join(process.cwd(), "src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  const names = ["isSkillsOnlyGitHubSync", "scopedSyncRefreshState", "scopedSyncRefreshMarker", "persistScopedSyncRefresh",
    "deferScopedSyncRefresh", "beginScopedSyncRefresh", "retrievalSkillRows", "currentSkillsRetrievalSnapshot",
    "refreshRetrievalSkillsIndex", "acceptGitHubSyncConflict"];
  const declarations = names.map(name => {
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert(node, name);
    return node.getText(ast);
  });
  let failOnce = true, queued = 0, inventory = 0, tree = 0;
  const warnings = [], reads = [];
  const scope = {
    path, fs, process, Buffer, createHash, ...sync, ...conflicts,
    GITHUB_SYNC_CONTENT_TYPES: sync.GITHUB_SYNC_CONTENT_TYPES, selectionIncludesType: sync.selectionIncludesType,
    githubSyncStateDirectory: () => state, retrievalStateDirectory: () => retrievalState, retrievalWorkerRoot: f.store,
    retrievalRefreshRunning: undefined,
    scopedSyncRefresh: new Map(), scopedSyncRefreshGeneration: 0, getStorePath: () => f.store,
    vscode: { window: { showWarningMessage: message => { warnings.push(message); return Promise.resolve(undefined); } } },
    log: { warn() {}, info() {} },
    githubSyncTargetById: () => f.target, requireSavedGitHubSyncConflictDocuments() {},
    readGitHubSyncCredentials: async () => undefined,
    currentProjectStore: () => { throw new Error("unselected Recipe store read"); },
    githubSyncCandidateDestination: (root, relative) => path.join(root, relative),
    applyGitHubSyncRecipeDeletes: ids => assert.equal(ids.length, 0), setTopLevelPrivacy() {},
    mutateGitHubSyncTargets: async (_context, _action, update) => update([f.target]).result,
    githubSyncScheduler: { request: async () => { queued++; } },
    invalidateSharedContentCatalog() {}, _treeProvider: { refresh: () => { tree++; } },
    refreshKnowledgeInventory: async () => { inventory++; }, mcpRuntimeStatusAsync: async () => ({ healthy: true }),
    retrievalWorker: { syncSkills: async value => {
      if (failOnce) { failOnce = false; throw new Error("fixture indexing failed"); }
      return worker.syncSkills(value);
    } },
    skillList: filestore.skillList, skillGet: filestore.skillGet, knowledgeFilePath: filestore.knowledgeFilePath,
    referencedMarkdownAssets: require(path.join(build, "knowledge/markdown-assets")).referencedMarkdownAssets,
    createRetrievalSnapshot,
  };
  vm.runInNewContext(ts.transpileModule(`${declarations.join("\n")}\nglobalThis.accept = acceptGitHubSyncConflict;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, scope);
  const methods = ["readFileSync", "readdirSync", "statSync", "lstatSync", "realpathSync"];
  const originals = Object.fromEntries(methods.map(method => [method, fs[method]]));
  for (const method of methods) fs[method] = function(file, ...args) {
    if (typeof file === "string" && ["notes", "scripts"].some(area => {
      const directory = path.join(f.store, area);
      return file === directory || file.startsWith(directory + path.sep);
    })) reads.push(`${method}:${file}`);
    return originals[method].call(this, file, ...args);
  };
  try {
    let releaseFullRefresh;
    scope.retrievalRefreshRunning = new Promise(resolve => { releaseFullRefresh = resolve; });
    const acceptance = scope.accept({}, f.target.id);
    const finishedBeforeFull = await Promise.race([
      acceptance.then(() => true, () => true),
      new Promise(resolve => setTimeout(() => resolve(false), 1000)),
    ]);
    const appliedBeforeFull = !!conflicts.readGitHubSyncConflict(state, f.target.id).appliedAt;
    releaseFullRefresh();
    scope.retrievalRefreshRunning = undefined;
    await assert.rejects(() => acceptance, /applied locally.*Skills search indexing failed/);
    assert.equal(finishedBeforeFull, false, "conflict acceptance must wait for an earlier full index publication");
    assert.equal(appliedBeforeFull, false, "local changes must wait for an earlier full index publication");
    assert(conflicts.readGitHubSyncConflict(state, f.target.id).appliedAt);
    assert.equal(queued, 0);
    assert(fs.readFileSync(path.join(f.store, "skills/Fixture.md")).equals(remoteEdit));
    const result = await scope.accept({}, f.target.id);
    assert.equal(result.accepted, 1);
    assert.equal(queued, 1);
    const after = JSON.parse(fs.readFileSync(path.join(retrievalState, "snapshot.json")));
    assert.deepEqual(after.documents.filter(doc => doc.content_type !== "skill"), untouched);
    assert(after.documents.find(doc => doc.content_type === "skill").body.includes("remote edit"));
    assert.deepEqual(reads, []);
    assert(!fs.existsSync(f.sidecar));
    assert.equal(inventory, 0);
    assert.equal(tree, 0);
    assert(warnings.some(message => /Skills indexing failed or is pending/.test(message)));
  } finally { for (const method of methods) fs[method] = originals[method]; }
});

test("Skills-only conflict acceptance rejects unselected members before accessing them", async t => {
  const f = fixture(t), ts = require("typescript"), vm = require("node:vm");
  const source = fs.readFileSync(path.join(process.cwd(), "src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = ["isSkillsOnlyGitHubSync", "acceptGitHubSyncConflict"].map(name => {
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert(node, name);
    return node.getText(ast);
  });
  const scope = {
    GITHUB_SYNC_CONTENT_TYPES: sync.GITHUB_SYNC_CONTENT_TYPES, selectionIncludesType: sync.selectionIncludesType,
    githubSyncSafeRelativePath: sync.githubSyncSafeRelativePath,
    githubSyncStateDirectory: () => f.root, githubSyncTargetById: () => f.target,
    readGitHubSyncConflict: () => ({ files: [{ type: "scripts", path: "scripts/demo.py" }] }),
    githubSyncScheduler: { request: () => { throw new Error("must not queue"); } },
    beginScopedSyncRefresh: () => { throw new Error("must reject before starting"); },
  };
  vm.runInNewContext(ts.transpileModule(`${declarations.join("\n")}\nglobalThis.accept = acceptGitHubSyncConflict;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, scope);
  await assert.rejects(() => scope.accept({}, f.target.id), /cannot accept a conflict containing unselected/);
  scope.readGitHubSyncConflict = () => ({ files: [{ type: "skills", path: "skills/Fixture.md", resultPath: "scripts/demo.py" }] });
  await assert.rejects(() => scope.accept({}, f.target.id), /cannot accept a conflict containing unselected/);
  assert(!fs.existsSync(f.sidecar));
});

test("manifestless repository with managed paths is blocked before overwrite", async t => {
  const f = fixture(t, false);
  const before = git(f.root, ["--git-dir", f.remote, "rev-parse", "main"]);
  const catalog = await f.catalog();
  await assert.rejects(() => sync.syncGitHubTarget(f.target, catalog, f.checkout, undefined, f.store),
    /no PKM sync manifest.*potentially overlapping content/);
  assert.equal(git(f.root, ["--git-dir", f.remote, "rev-parse", "main"]), before);
  assert(f.blob("skills/Fixture.md").equals(skill("initial")));
});
