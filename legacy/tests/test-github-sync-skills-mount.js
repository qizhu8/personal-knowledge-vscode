const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { test } = require("node:test");
const build = path.resolve(process.env.PKM_SYNC_TEST_BUILD || ".skills-mount-build");
const sync = require(path.join(build, "sync/github-sync"));
const { githubSyncCatalogInWorker } = require(path.join(build, "sync/github-sync-catalog-worker"));
const conflicts = require(path.join(build, "sync/github-sync-conflicts"));
const git = (cwd, args, binary = false) => execFileSync("git",
  ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
  { cwd, encoding: binary ? undefined : "utf8", stdio: ["ignore", "pipe", "pipe"] });
const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const skill = (name, body, identity = "") => Buffer.from(`---\nname: ${name}\n${identity ? `knowledgeId: ${identity}\n` : ""}---\n${body}\n`);

function fixture(t, files = { "Skills/Example.md": skill("Example", "remote body\n![asset](Example.assets/image.png)"),
  "Skills/Example.assets/image.png": Buffer.from([0, 255, 13, 10, 128]) }) {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".skills-mount-fixture-"));
  const seed = path.join(root, "seed"), remote = path.join(root, "remote.git"), store = path.join(root, "store");
  fs.mkdirSync(seed); fs.mkdirSync(store);
  git(seed, ["init", "-q"]); git(seed, ["config", "user.name", "Fixture"]); git(seed, ["config", "user.email", "fixture@example.invalid"]);
  const outside = { "notes/outside.md": Buffer.from("notes\r\nstay\r\n"), "Prompts/binary": Buffer.from([255, 0, 13, 10]),
    "skills/lowercase.md": Buffer.from("separate\r\nlowercase\r\n"), ".pkm-github-sync.json": Buffer.from("unrelated root metadata\r\n") };
  for (const [file, bytes] of Object.entries({ ...outside, ...files })) put(path.join(seed, file), bytes);
  git(seed, ["add", "."]); git(seed, ["commit", "-qm", "seed"]); git(seed, ["branch", "-M", "main"]);
  git(seed, ["branch", "feature/skills"]); git(root, ["clone", "--bare", "-q", seed, remote]);
  const repository = "https://github.com/pkm-fixture/skills.git";
  const config = path.join(root, "gitconfig");
  put(config, `[url "${remote}"]\n\tinsteadOf = ${repository}\n`);
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  t.after(() => { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous;
    fs.rmSync(root, { recursive: true, force: true }); });
  const target = sync.createGitHubSkillsMountTarget(repository, "feature/skills", "fixture");
  const checkouts = path.join(root, "checkouts");
  const catalog = () => githubSyncCatalogInWorker({ root: store, servers: [], recipes: [], types: ["skills"], skillsMount: true });
  const acknowledge = result => {
    target.lastSync = { at: new Date().toISOString(), commit: result.commit, fingerprints: result.fingerprints,
      repository, branch: target.branch, storeRoot: store, entityBases: result.entityBases };
    sync.completeGitHubSyncTransaction(checkouts, target.id, result.transactionId);
  };
  const run = async () => sync.syncGitHubTarget(target, await catalog(), checkouts, undefined, store);
  const blob = (file, branch = target.branch) => git(root, ["--git-dir", remote, "show", `${branch}:${file}`], true);
  const head = () => git(root, ["--git-dir", remote, "rev-parse", target.branch]);
  const editRemote = changes => {
    git(seed, ["fetch", "-q", remote, target.branch]); git(seed, ["checkout", "-q", "-B", target.branch, "FETCH_HEAD"]);
    for (const [file, bytes] of Object.entries(changes)) {
      if (bytes === null) fs.rmSync(path.join(seed, file));
      else put(path.join(seed, file), bytes);
    }
    const manifestPath = path.join(seed, "Skills/.pkm-github-sync.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath));
      for (const file of manifest.files) {
        const bytes = changes["Skills/" + file.path.slice("skills/".length)];
        if (bytes) file.digest = hash(bytes);
      }
      put(manifestPath, JSON.stringify(manifest));
    }
    git(seed, ["add", "."]); git(seed, ["commit", "-qm", "remote fixture change"]); git(seed, ["push", "-q", remote, target.branch]);
  };
  return { root, remote, seed, store, target, checkouts, catalog, acknowledge, run, blob, outside, head, editRemote };
}

test("explicit repo/branch Skills adoption pulls and pushes assets without touching other Git blobs or local areas", async t => {
  const f = fixture(t);
  put(path.join(f.store, "notes/invalid.md"), "must not read");
  put(path.join(f.store, "scripts/private.py"), "must not create identity");
  const beforeMain = git(f.root, ["--git-dir", f.remote, "rev-parse", "main"]);
  const reads = [], methods = ["readFileSync", "readdirSync", "statSync", "lstatSync"];
  const originals = Object.fromEntries(methods.map(method => [method, fs[method]]));
  for (const method of methods) fs[method] = function(file, ...args) {
    if (typeof file === "string" && ["notes", "scripts", "prompts"].some(area =>
      file === path.join(f.store, area) || file.startsWith(path.join(f.store, area) + path.sep))) reads.push(file);
    return originals[method].call(this, file, ...args);
  };
  try {
    const catalog = await f.catalog();
    const before = f.head();
    const preview = await sync.previewGitHubSyncTarget(f.target, catalog, f.checkouts, undefined, f.store);
    assert.equal(preview.remoteOnly, 2);
    assert.equal(f.head(), before, "preview never writes to the remote");
    f.acknowledge(await f.run());
    assert(fs.readFileSync(path.join(f.store, "skills/Example.md")).includes("remote body"));
    const newAsset = Buffer.from([0, 42, 255, 128]);
    put(path.join(f.store, "skills/Example.assets/image.png"), newAsset);
    put(path.join(f.store, "skills/Example.md"), skill("Example", "local edit\n![asset](Example.assets/image.png)"));
    git(path.join(f.checkouts, f.target.id, "repository"), ["config", "core.autocrlf", "true"]);
    f.acknowledge(await f.run());
    assert(f.blob("Skills/Example.assets/image.png").equals(newAsset));
    assert(f.blob("Skills/Example.md").includes("local edit"));
    f.editRemote({ "Skills/Example.md": skill("Example", "remote again\n![asset](Example.assets/image.png)"),
      "Skills/Example.assets/image.png": Buffer.from([0, 1, 200]) });
    f.acknowledge(await f.run());
    assert(fs.readFileSync(path.join(f.store, "skills/Example.assets/image.png")).equals(Buffer.from([0, 1, 200])));
    assert(fs.readFileSync(path.join(f.store, "skills/Example.md")).includes("remote again"));
    for (const [file, bytes] of Object.entries(f.outside)) assert(f.blob(file).equals(bytes), file);
    assert.equal(git(f.root, ["--git-dir", f.remote, "rev-parse", "main"]), beforeMain);
    const manifest = JSON.parse(f.blob("Skills/.pkm-github-sync.json"));
    assert(manifest.files.every(file => file.type === "skills" && file.path.startsWith("skills/")));
    assert.deepEqual(reads, []);
    assert(!fs.existsSync(path.join(f.store, "scripts/.private.py.pkm.json")));
  } finally { for (const method of methods) fs[method] = originals[method]; }
});

test("first adoption content/identity collisions stop before any push and use existing review candidates", async t => {
  const f = fixture(t, { "Skills/Example.md": skill("Example", "remote body", "knowledge_" + "1".repeat(24)) });
  const local = skill("Example", "user changes", "knowledge_" + "2".repeat(24));
  put(path.join(f.store, "skills/Example.md"), local);
  const before = f.head();
  let conflict;
  await assert.rejects(f.run, error => { conflict = error; return error instanceof sync.GitHubSyncConflictError; });
  assert.equal(f.head(), before);
  assert(fs.readFileSync(path.join(f.store, "skills/Example.md")).equals(local));
  const state = path.join(f.root, "state");
  const record = conflicts.storeGitHubSyncConflict(state, f.target.id, conflict, "initial-preview", 3);
  conflicts.selectGitHubSyncConflictCandidate(state, f.target.id, "skills/Example.md", "local");
  const candidate = conflicts.readGitHubSyncConflictCandidate(state, f.target.id, "skills/Example.md", true);
  assert(candidate.equals(local), "existing review retains the selected user version");
  // The host records this exact reviewed Remote commit as Base before queuing normal Sync.
  f.target.lastSync = { at: new Date().toISOString(), commit: record.remoteCommit, fingerprints: {},
    repository: f.target.repository, branch: f.target.branch, storeRoot: f.store };
  f.acknowledge(await f.run());
  assert(f.blob("Skills/Example.md").equals(local));
  put(path.join(f.store, "skills/Example.md"), skill("Example", "local concurrent edit", "knowledge_" + "2".repeat(24)));
  f.editRemote({ "Skills/Example.md": skill("Example", "remote concurrent edit", "knowledge_" + "2".repeat(24)) });
  await assert.rejects(f.run, error => error instanceof sync.GitHubSyncConflictError);
});

test("ambiguous names, unmanaged files and missing branches fail without adoption; ordinary Sync stays guarded", async t => {
  const f = fixture(t);
  const before = f.head();
  put(path.join(f.store, "skills/elsewhere.md"), skill("Example", "local body"));
  await assert.rejects(f.run, /name\/path\/identity collision/);
  assert.equal(f.head(), before);
  fs.rmSync(path.join(f.store, "skills/elsewhere.md"));
  f.target.branch = "absent";
  await assert.rejects(f.run, /existing remote branch/);
  f.target.branch = "feature/skills";
  f.editRemote({ ".pkm-github-sync.json": null });
  const manifestlessHead = f.head();
  delete f.target.skillsMount;
  await assert.rejects(f.run, /no PKM sync manifest.*overlapping content/);
  assert.equal(f.head(), manifestlessHead);
  assert.throws(() => sync.normalizeGitHubSyncTarget({ ...f.target, skillsMount: { path: "Skills", adoption: "explicit" },
    selection: sync.defaultGitHubSyncSelection() }), /selects only/);
});

test("unsupported Skill package files fail explicitly instead of dropping or executing them", async t => {
  const f = fixture(t, { "Skills/package/SKILL.md": skill("Package", "body"), "Skills/package/run.py": Buffer.from("never execute") });
  const before = f.head();
  await assert.rejects(f.run, /cannot safely assign this file/);
  assert.equal(f.head(), before);
  assert.deepEqual(fs.readdirSync(f.store), []);
});

test("production mount command persists the Skills-only contract and previews through the real engine before explicit Sync", async t => {
  const f = fixture(t), ts = require("typescript"), vm = require("node:vm");
  const source = fs.readFileSync(path.join(process.cwd(), "src/extension.ts"), "utf8");
  const ast = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = ["mountGitHubSkills", "buildGitHubSyncCatalog", "handleMessage"].map(name => {
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert(node, name); return node.getText(ast);
  });
  let targets = [], authenticated = 0, queued = 0;
  const inputs = [f.target.repository, f.target.branch, "fixture"];
  const messages = [], errors = [], warnings = [];
  const context = { globalStorageUri: { fsPath: path.join(f.root, "state") }, secrets: { delete: async () => {} } };
  const state = path.join(f.root, "state");
  const scope = {
    path, fs, createHash, _storeReady: true,
    ...sync, ...conflicts, githubSyncCatalogInWorker,
    getStorePath: () => f.store,
    activePanel: () => undefined, panelSession: () => ({}), checkPanelEdit() {},
    log: { debug() {}, action() {}, error: error => errors.push(error) },
    vscode: { window: {
      showInputBox: async () => inputs.shift(),
      showWarningMessage: async (message, options, choice) => { warnings.push({ message, detail: options.detail }); return choice; },
      showInformationMessage() {},
    } },
    authorizeGitHubSyncProfiles: require(path.join(build, "sync/github-sync-profiles")).authorizeGitHubSyncProfiles,
    PersonaProfileStore: class { constructor() { throw new Error("unselected Profiles accessed"); } },
    currentProjectStore() { throw new Error("unselected Recipes accessed"); },
    serverList() { throw new Error("unselected Servers accessed"); },
    readGitHubSyncTargets: () => targets,
    authorizeGitHubSyncTarget: async (_context, target) => { assert.equal(target.authentication.method, "vscode"); authenticated++; },
    withGitHubSyncTargetLock: (_context, _id, run) => run(),
    mutateGitHubSyncTargets: async (_context, _reason, update) => { const result = update(targets); targets = result.targets; return result.result; },
    githubSyncStateDirectory: () => state,
    configureGitHubSyncScheduler() {},
    githubSyncScheduler: { request: async () => { queued++; } },
    githubSyncTargetById: (_context, id) => targets.find(target => target.id === id),
    readGitHubSyncCredentials: async () => undefined,
    githubSyncStateData: async () => ({ targets }),
    postToPanel: message => messages.push(message),
    openPanelTab: (_context, tab) => assert.equal(tab, "githubSync"),
  };
  vm.runInNewContext(ts.transpileModule(`${declarations.join("\n")}\nglobalThis.mount = mountGitHubSkills; globalThis.save = handleMessage;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, scope);
  const before = f.head();
  await scope.mount(context);
  assert.deepEqual(errors, []);
  assert.equal(targets.length, 1);
  const saved = targets[0];
  assert.equal(saved.skillsMount.path, "Skills");
  assert.equal(saved.skillsMount.adoption, "explicit");
  assert.equal(saved.automation.enabled, false);
  assert.equal(saved.automation.initialSyncCompleted, false);
  assert.equal(authenticated, 1);
  assert.equal(queued, 0, "mount/save only previews; no automatic Sync");
  assert.equal(f.head(), before);
  assert(warnings.some(warning => /ALL public and private local Skills/.test(warning.detail)));
  assert(messages.some(message => message.command === "githubSyncState"));
  const editorInput = JSON.parse(JSON.stringify(saved));
  delete editorInput.skillsMount;
  await scope.save({ command: "githubSyncSave", target: editorInput }, message => messages.push(message), context);
  assert.equal(targets[0].skillsMount.path, "Skills", "ordinary editor cannot drop mount intent");
  editorInput.selection.public.notes.folders = [""];
  await scope.save({ command: "githubSyncSave", target: editorInput }, message => messages.push(message), context);
  assert(messages.some(message => message.command === "githubSyncError" && /selects only/.test(message.data.error)));
  assert.equal(targets[0].selection.public.notes.folders.length, 0);
  for (const command of ["githubSyncForceUpdate", "githubSyncForceRemote", "githubSyncMigration"]) {
    await scope.save({ command, targetId: saved.id }, message => messages.push(message), context);
    assert(messages.some(message => message.command === "githubSyncError" && /normal Sync and explicit conflicts/.test(message.data.error)));
  }
  const review = conflicts.readGitHubSyncConflict(state, saved.id);
  assert.equal(review.purpose, "initial-preview");
  assert(review.files.every(file => file.type === "skills"));
  const result = await sync.syncGitHubTarget(saved, await f.catalog(), path.join(state, "checkouts"), undefined, f.store);
  assert(result.pulled.includes("skills/Example.md"));
  sync.completeGitHubSyncTransaction(path.join(state, "checkouts"), saved.id, result.transactionId);
});
