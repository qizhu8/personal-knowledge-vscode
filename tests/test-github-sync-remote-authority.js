#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const ts = require("typescript");
const sync = require("../dist/sync/github-sync");
const { sameKnowledgeRoot } = require("../dist/sync/github-sync-coordinator");
const { compileWorkflowDefinitionV1 } = require("../dist/workflows/workflow-contracts");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-force-remote-"));
const git = (cwd, args) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const empty = () => Object.fromEntries(sync.GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
const definition = { schema: "pkm.workflow.definition/v1", spec: {
  inputs: {}, nodes: [{ nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
  outputs: {}, completion: { requiredNodes: ["work"] },
} };
const compiled = compileWorkflowDefinitionV1(definition);
assert(compiled.ok);
const recipe = (id, name) => ({ recipeId: id, scope: "global", name, category: "", revision: 1,
  definition, executableDigest: compiled.executableDigest, editorLayout: { nodes: { work: { x: 12, y: 24 } } } });
let scenarios = 0;
async function fixture(name) {
  const directory = path.join(root, name), seed = path.join(directory, "seed"), remote = path.join(directory, "remote.git");
  fs.mkdirSync(seed, { recursive: true });
  git(seed, ["init", "-q"]); git(seed, ["config", "user.name", "Fixture"]); git(seed, ["config", "user.email", "fixture@example.invalid"]);
  put(path.join(seed, "README.md"), "fixture\n");
  git(seed, ["add", "."]); git(seed, ["commit", "-qm", "seed"]); git(seed, ["branch", "-M", "main"]);
  git(directory, ["clone", "--bare", "-q", seed, remote]);
  const store = path.join(directory, "store"), publisher = path.join(directory, "publisher"), checkouts = path.join(directory, "checkouts");
  fs.mkdirSync(store); fs.mkdirSync(publisher);
  const target = sync.normalizeGitHubSyncTarget({ name, repository: remote, branch: "main" }, () => "fixture");
  target.selection.public.scripts.folders = [""];
  target.selection.public.recipes.folders = [""];
  const remoteCatalog = empty(), localCatalog = empty();
  const add = (catalog, base, name, content, cat = "") => {
    const destination = "scripts/" + name, source = path.join(base, destination);
    put(source, content);
    catalog.scripts.push({ id: name, cat, isPrivate: false, source, destination });
    return source;
  };
  add(remoteCatalog, publisher, "shared.script", "remote\n");
  add(remoteCatalog, publisher, "remote-only.script", "created from remote\n");
  add(remoteCatalog, publisher, "ignored.script", "remote ignored\n");
  add(localCatalog, store, "shared.script", "\uFEFF<<<<<<< local\r\ninvalid local merge\r\n>>>>>>> branch\r\n");
  add(localCatalog, store, "local-only.script", "keep in recovery backup\r\n");
  add(localCatalog, store, "ignored.script", "local ignored\r\n");
  put(path.join(store, ".gitignore"), "scripts/ignored.script\n");
  put(path.join(store, "notes/unselected.md"), "unselected\n");
  put(path.join(store, "notes/System/PKM/protected.md"), "protected\n");
  target.selection.public.notes.items = ["System/PKM/protected"];
  localCatalog.notes.push({ id: "System/PKM/protected", cat: "System/PKM", isPrivate: false,
    destination: "notes/System/PKM/protected.md", source: path.join(store, "notes/System/PKM/protected.md") });
  const published = await sync.syncGitHubTarget(target, remoteCatalog, path.join(directory, "publishing"), undefined, publisher);
  const head = () => git(directory, ["--git-dir", remote, "rev-parse", "main"]);
  const preview = () => sync.previewGitHubRemoteAuthority(target, localCatalog, checkouts, store);
  const apply = (plan, recipeApply = () => {}, guard, refresh) => sync.applyGitHubRemoteAuthority(target, localCatalog, checkouts, store,
    plan, "fixture", "discard isolated local projection", recipeApply, undefined, guard, refresh);
  const editRemote = (relative, bytes) => {
    const editor = path.join(directory, "editor");
    if (!fs.existsSync(editor)) {
      git(directory, ["clone", "-q", remote, editor]);
      git(editor, ["config", "user.name", "Fixture"]); git(editor, ["config", "user.email", "fixture@example.invalid"]);
    }
    put(path.join(editor, relative), bytes);
    const manifest = JSON.parse(fs.readFileSync(path.join(editor, ".pkm-github-sync.json")));
    const file = manifest.files.find(file => file.path === relative);
    if (file) file.digest = hash(Buffer.from(bytes));
    put(path.join(editor, ".pkm-github-sync.json"), JSON.stringify(manifest));
    git(editor, ["-c", "core.autocrlf=false", "add", "."]); git(editor, ["commit", "-qm", "remote update"]); git(editor, ["push", "-q", "origin", "main"]);
  };
  return { directory, target, localCatalog, remoteCatalog, store, publisher, checkouts, head, preview, apply, editRemote, published, add };
}
async function scenario(name, run) {
  await run(await fixture(name));
  scenarios++;
}
const extension = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
const hostStart = extension.indexOf('    case "githubSyncForceRemote": {');
const hostEnd = extension.indexOf('    case "githubSyncConflictOpen": {', hostStart);
assert(hostStart >= 0 && hostEnd > hostStart);
const hostHandler = ts.transpileModule(`async function run() { switch(msg.command) {
  ${extension.slice(hostStart, hostEnd)}
} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
async function hostScenario(name, f) {
  const responses = [], clears = [], warnings = [];
  let baselineUpdates = 0, preconditions = 0;
  f.target.pendingDeletions = [{ type: "scripts", itemId: "shared.script", category: "", privacy: "public", deletedAt: new Date().toISOString() }];
  const catalog = () => {
    const current = { ...f.localCatalog, scripts: f.localCatalog.scripts.filter(item => fs.existsSync(item.source)) };
    const source = path.join(f.store, "scripts/remote-only.script");
    if (fs.existsSync(source)) current.scripts.push({ id: "remote-only.script", cat: "", isPrivate: false,
      destination: "scripts/remote-only.script", source });
    return current;
  };
  const dirty = name === "unsaved" ? [{ isDirty: true, uri: { scheme: "file", fsPath: path.join(f.store, "scripts/shared.script") } }] : [];
  const context = vm.createContext({
    ...sync, sameKnowledgeRoot, path, os, context: {}, msg: { command: "githubSyncForceRemote", targetId: f.target.id },
    respond: response => { responses.push(response); },
    githubSyncTargetById: () => f.target,
    requireGitHubSyncManualMode: target => { preconditions++; assert(!target.automation.enabled); },
    githubPublicationMigration: () => ({ status: () => undefined }),
    getStorePath: () => f.store,
    githubSyncStateDirectory: () => path.join(f.directory, "state"),
    readGitHubSyncCredentials: async () => undefined,
    withGitHubSyncTargetLock: async (_context, _id, action) => action(),
    withGitHubSyncApplyLock: async (_context, action) => action(),
    invalidateSharedContentCatalog: () => {},
    buildGitHubSyncCatalog: async () => catalog(),
    applyGitHubSyncRecipePulls: pulls => { assert.equal(pulls.length, 0); },
    applyGitHubSyncRecipeDeletes: deletes => { assert.equal(deletes.length, 0); },
    setTopLevelPrivacy: () => {},
    mutateGitHubSyncTargets: async (_context, _label, change) => {
      if (name === "baseline-failure") throw new Error("injected baseline failure");
      const result = change([f.target]); baselineUpdates++;
      return result.result;
    },
    clearGitHubSyncContentRepair: () => clears.push("repair"),
    clearGitHubSyncConflict: () => clears.push("conflict"),
    _treeProvider: { refresh: () => {} },
    refreshKnowledgeInventory: async () => { if (name === "refresh-failure") throw new Error("injected inventory failure"); },
    refreshRetrievalIndex: async () => {},
    scheduleRetrievalRefresh: () => warnings.push("refresh-retry"),
    configureGitHubSyncScheduler: () => {},
    githubSyncStateData: async () => ({ targets: [f.target] }),
    log: { warn: message => warnings.push(message) },
    vscode: {
      workspace: { textDocuments: dirty },
      window: {
        showQuickPick: async items => {
          assert(items.some(item => /Delete Local.*local-only/.test(item.label)));
          if (name === "preview-cancel") return undefined;
          if (name === "unchecked") return items.slice(1);
          return items;
        },
        showInputBox: async () => name === "reason-cancel" ? undefined : "Host recovery reason",
        showWarningMessage: async (_title, options) => {
          if (!options?.modal) { warnings.push(_title); return undefined; }
          assert.match(options.detail, /GitHub is never pushed/);
          if (name === "remote-changed") f.editRemote("scripts/shared.script", "advanced during confirmation\n");
          return name === "confirm-cancel" ? undefined : "Force use Remote";
        },
        showInformationMessage: message => { assert.match(message, /Recovery backup:/); },
      },
    },
  });
  const execute = () => vm.runInContext(hostHandler + "\nrun();", context);
  if (["unsaved", "remote-changed", "baseline-failure"].includes(name)) {
    await assert.rejects(execute, name === "unsaved" ? /unsaved editor/ : name === "remote-changed" ? /new.*preview/i : /baseline was not fully finalized.*Recovery backup/);
    assert.equal(baselineUpdates, 0);
    assert.equal(clears.length, 0, "failed or stale apply must not clear conflict or repair blockers");
  } else {
    await execute();
    const response = responses.find(response => response.command === "githubSyncForceRemoteResult");
    assert(response);
    if (name.includes("cancel") || name === "unchecked") {
      assert.equal(response.data.cancelled, true);
      assert.equal(baselineUpdates, 0);
      assert.equal(clears.length, 0);
    } else {
      assert.equal(baselineUpdates, 1);
      assert.equal(f.target.lastSync.commit, f.head());
      assert(f.target.lastSync.fingerprints.scripts);
      assert.equal(f.target.pendingDeletions.length, 0);
      assert.equal(f.target.automation.enabled, false);
      assert.deepEqual(clears, ["repair", "conflict"]);
      const audit = JSON.parse(fs.readFileSync(path.join(response.data.backupDirectory, "audit.json")));
      assert.equal(audit.state, "completed");
      if (name === "refresh-failure") assert(warnings.some(message => /refresh must retry/.test(message)));
    }
  }
  if (["preview-cancel", "unchecked", "reason-cancel", "confirm-cancel", "unsaved", "remote-changed"].includes(name)) {
    assert.match(fs.readFileSync(path.join(f.store, "scripts/shared.script"), "utf8"), /<<<<<<< local/);
    assert.equal(f.target.lastSync, undefined);
  }
  assert(preconditions >= 1);
}
(async () => {
  try {
    await scenario("overwrite-create-delete", async f => {
      const plan = await f.preview(), before = f.head();
      assert.equal(plan.writes.length, 2);
      assert.deepEqual(plan.deletes.map(item => item.file.path), ["scripts/local-only.script"]);
      const result = await f.apply(plan);
      assert.equal(f.head(), before, "Remote authority must never create or push a commit");
      assert.equal(fs.readFileSync(path.join(f.store, "scripts/shared.script"), "utf8"), "remote\n");
      assert(!fs.existsSync(path.join(f.store, "scripts/local-only.script")));
      assert.equal(fs.readFileSync(path.join(f.store, "scripts/remote-only.script"), "utf8"), "created from remote\n");
      for (const [relative, content] of [["scripts/ignored.script", "local ignored\r\n"],
        ["notes/System/PKM/protected.md", "protected\n"], ["notes/unselected.md", "unselected\n"]]) {
        assert.equal(fs.readFileSync(path.join(f.store, relative), "utf8"), content);
      }
      const audit = JSON.parse(fs.readFileSync(path.join(result.backupDirectory, "audit.json")));
      assert.equal(audit.state, "local-applied");
      sync.completeGitHubRemoteAuthorityBackup(result.backupDirectory);
      assert.equal(JSON.parse(fs.readFileSync(path.join(result.backupDirectory, "audit.json"))).state, "completed");
      assert.equal(audit.commit, before);
      assert.equal(audit.comment, "discard isolated local projection");
      assert.match(fs.readFileSync(path.join(result.backupDirectory, "originals/scripts/shared.script"), "utf8"), /<<<<<<< local\r\n/);
      assert.equal(fs.readFileSync(path.join(result.backupDirectory, "originals/scripts/local-only.script"), "utf8"), "keep in recovery backup\r\n");
      assert.equal(fs.statSync(result.backupDirectory).mode & 0o777, 0o700);
      f.localCatalog.scripts = f.localCatalog.scripts.filter(item => fs.existsSync(item.source));
      f.localCatalog.scripts.push({ id: "remote-only.script", cat: "", isPrivate: false,
        source: path.join(f.store, "scripts/remote-only.script"), destination: "scripts/remote-only.script" });
      f.target.lastSync = { at: new Date().toISOString(), commit: result.commit, fingerprints: {},
        repository: f.target.repository, branch: "main", storeRoot: f.store };
      const repeated = await f.preview();
      assert.equal(repeated.writes.length + repeated.deletes.length, 0);
      const normal = await sync.syncGitHubTarget(f.target, f.localCatalog, f.checkouts, undefined, f.store);
      assert(!normal.changed, "ordinary Sync after recovery must not resurrect discarded files");
      assert.equal(f.head(), before);
    });
    for (const change of ["local-edit", "local-add", "local-remove", "remote-edit", "selection", "ignore"]) {
      await scenario(change, async f => {
        const plan = await f.preview();
        if (change === "local-edit") put(path.join(f.store, "scripts/shared.script"), "changed while reviewing\n");
        if (change === "local-add") f.add(f.localCatalog, f.store, "added.script", "new during preview\n");
        if (change === "local-remove") {
          fs.unlinkSync(path.join(f.store, "scripts/local-only.script"));
          f.localCatalog.scripts = f.localCatalog.scripts.filter(item => item.id !== "local-only.script");
        }
        if (change === "remote-edit") f.editRemote("scripts/shared.script", "advanced remote\n");
        if (change === "selection") f.target.selection.public.scripts.folders = [];
        if (change === "ignore") put(path.join(f.store, ".gitignore"), "scripts/shared.script\nscripts/ignored.script\n");
        const original = fs.readFileSync(path.join(f.store, "scripts/shared.script"));
        await assert.rejects(() => f.apply(plan), /changed|new.*preview/i);
        assert(fs.readFileSync(path.join(f.store, "scripts/shared.script")).equals(original));
      });
    }
    await scenario("remote-markers", async f => {
      f.editRemote("scripts/shared.script", "<<<<<<< bad\nremote unresolved\n>>>>>>> branch\n");
      await assert.rejects(() => f.preview(), /merge conflict markers/);
      assert.match(fs.readFileSync(path.join(f.store, "scripts/shared.script"), "utf8"), /<<<<<<< local/);
    });
    await scenario("current-remote-digest", async f => {
      f.editRemote("scripts/shared.script", "bad manifest digest\r\n");
      const editor = path.join(f.directory, "editor"), manifestPath = path.join(editor, ".pkm-github-sync.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath));
      manifest.files.find(file => file.path === "scripts/shared.script").digest = hash(Buffer.from("bad manifest digest\n"));
      put(manifestPath, JSON.stringify(manifest));
      git(editor, ["add", "."]); git(editor, ["commit", "-qm", "digest mismatch"]); git(editor, ["push", "-q", "origin", "main"]);
      await assert.rejects(() => f.preview(), /digest does not match/);
    });
    await scenario("omitted-remote-member", async f => {
      f.editRemote("scripts/unmanifested.script", "present but absent from manifest\n");
      await assert.rejects(() => f.preview(), /missing from the manifest/);
    });
    await scenario("private-boundary", async f => {
      const privateFile = f.add(f.remoteCatalog, f.publisher, "private.script", "private remote\n");
      f.remoteCatalog.scripts.find(item => item.source === privateFile).isPrivate = true;
      const publishing = sync.normalizeGitHubSyncTarget(f.target, () => f.target.id);
      publishing.selection.private.scripts.folders = [""];
      await sync.syncGitHubTarget(publishing, f.remoteCatalog, path.join(f.directory, "publish-private"), undefined, f.publisher);
      const plan = await f.preview();
      assert(!plan.writes.some(item => item.file.path === "scripts/private.script"));
      await f.apply(plan);
      assert(!fs.existsSync(path.join(f.store, "scripts/private.script")));
    });
    for (const ignoredSidecar of [false, true]) {
      await scenario(ignoredSidecar ? "ignored-sidecar" : "script-identity-move", async f => {
        const stableId = "script_" + "a".repeat(24);
        const metadata = JSON.stringify({ schema: "pkm.script/v1", knowledgeId: stableId,
          aliases: ["pkm://scripts/old.script", "pkm://scripts/new.script"] }) + "\n";
        const attach = (catalog, directory, name, body) => {
          f.add(catalog, directory, name, body);
          const relative = `scripts/.${name}.pkm.json`, source = path.join(directory, relative);
          put(source, metadata);
          catalog.scripts.find(item => item.id === name).dependencies = [{ destination: relative, source }];
        };
        attach(f.localCatalog, f.store, "old.script", "old local\n");
        attach(f.remoteCatalog, f.publisher, "new.script", "new remote\n");
        await sync.syncGitHubTarget(f.target, f.remoteCatalog, path.join(f.directory, "publish-move"), undefined, f.publisher);
        f.target.selection.public.scripts = { items: ["old.script"], folders: [] };
        if (ignoredSidecar) put(path.join(f.store, ".gitignore"), "scripts/.old.script.pkm.json\n");
        const plan = await f.preview();
        if (ignoredSidecar) {
          assert.equal(plan.writes.length + plan.deletes.length, 0, "an ignored identity member protects its entire Script entity");
        } else {
          assert.deepEqual(plan.writes.map(item => item.file.path).sort(), ["scripts/.new.script.pkm.json", "scripts/new.script"]);
          assert.deepEqual(plan.deletes.map(item => item.file.path).sort(), ["scripts/.old.script.pkm.json", "scripts/old.script"]);
          await f.apply(plan);
          assert(!fs.existsSync(path.join(f.store, "scripts/old.script")));
          assert(!fs.existsSync(path.join(f.store, "scripts/.old.script.pkm.json")));
          assert.equal(JSON.parse(fs.readFileSync(path.join(f.store, "scripts/.new.script.pkm.json"))).knowledgeId, stableId);
          assert.match(fs.readFileSync(path.join(f.store, "scripts/shared.script"), "utf8"), /<<<<<<< local/, "unselected Script is preserved");
        }
      });
    }
    await scenario("automation", async f => {
      f.target.automation.enabled = true;
      await assert.rejects(() => f.preview(), /Pause Auto Sync/);
    });
    await scenario("root-changed", async f => {
      const plan = await f.preview();
      await assert.rejects(() => sync.applyGitHubRemoteAuthority(f.target, f.localCatalog, f.checkouts,
        f.publisher, plan, "fixture", "reason", () => {}), /new preview/);
    });
    await scenario("tampered-plan", async f => {
      const plan = await f.preview();
      plan.writes[0].content = Buffer.from("unreviewed replacement\n");
      await assert.rejects(() => f.apply(plan), /new preview/);
    });
    await scenario("uncatalogued-collision", async f => {
      put(path.join(f.store, "scripts/remote-only.script"), "uncatalogued file\n");
      await assert.rejects(() => f.preview(), /uncatalogued Local/);
    });
    await scenario("host-guard", async f => {
      const plan = await f.preview();
      await assert.rejects(() => f.apply(plan, () => {}, () => { throw new Error("unsaved editor"); }), /unsaved editor/);
      assert.match(fs.readFileSync(path.join(f.store, "scripts/shared.script"), "utf8"), /<<<<<<< local/);
      const backups = path.join(f.checkouts, "remote-authority-backups", f.target.id);
      const audit = JSON.parse(fs.readFileSync(path.join(backups, fs.readdirSync(backups)[0], "audit.json")));
      assert.equal(audit.state, "needs-review");
    });
    await scenario("late-catalog-add", async f => {
      const plan = await f.preview();
      await assert.rejects(() => f.apply(plan, () => {}, undefined, async () => {
        f.add(f.localCatalog, f.store, "late.script", "created during validation\n");
        return f.localCatalog;
      }), /Local projection changed during Remote validation/);
      assert.match(fs.readFileSync(path.join(f.store, "scripts/shared.script"), "utf8"), /<<<<<<< local/);
      assert(fs.existsSync(path.join(f.store, "scripts/local-only.script")));
    });
    await scenario("component-failure", async f => {
      const plan = await f.preview();
      await assert.rejects(() => f.apply(plan, () => { throw new Error("recipe store failure"); }), /backed up.*recipe store failure/);
      const backups = path.join(f.checkouts, "remote-authority-backups", f.target.id);
      const backup = path.join(backups, fs.readdirSync(backups)[0]);
      assert.equal(JSON.parse(fs.readFileSync(path.join(backup, "audit.json"))).state, "needs-review");
      assert(fs.existsSync(path.join(backup, "originals/scripts/local-only.script")));
      assert.equal(f.head(), f.published.commit);
    });
    await scenario("empty-remote", async f => {
      const emptyTarget = sync.normalizeGitHubSyncTarget(f.target, () => f.target.id);
      emptyTarget.selection.public.scripts.folders = [""];
      for (const item of f.remoteCatalog.scripts) fs.unlinkSync(item.source);
      await sync.syncGitHubTarget(emptyTarget, empty(), path.join(f.directory, "empty-publisher"), undefined, f.publisher,
        undefined, { mode: "force-local-authority", actor: "fixture", comment: "empty remote projection" });
      const plan = await f.preview();
      assert.equal(plan.writes.length, 0);
      assert.equal(plan.deletes.length, 2);
      const before = f.head();
      await f.apply(plan);
      assert.equal(f.head(), before);
      assert(!fs.existsSync(path.join(f.store, "scripts/shared.script")));
      assert(fs.existsSync(path.join(f.store, "scripts/ignored.script")));
    });
    await scenario("recipes", async f => {
      const old = recipe("recipe_existing", "Local"), remote = recipe("recipe_existing", "Remote"),
        localOnly = recipe("recipe_local", "Local only");
      const entry = value => ({ id: value.recipeId, cat: "", isPrivate: false,
        destination: `recipes/Fixture.${value.recipeId}.json`, content: JSON.stringify(value) });
      f.remoteCatalog.recipes.push(entry(remote));
      f.localCatalog.recipes.push(entry(old), entry(localOnly));
      await sync.syncGitHubTarget(f.target, f.remoteCatalog, path.join(f.directory, "publish-recipes"), undefined, f.publisher);
      const plan = await f.preview();
      assert(plan.deletes.some(item => item.file.itemId === "recipe_local"));
      let calls = 0;
      const result = await f.apply(plan, (pulls, deletes) => {
        calls++;
        assert.equal(pulls.length, 1);
        assert.equal(JSON.parse(pulls[0].content).name, "Remote");
        assert.equal(JSON.parse(pulls[0].expectedLocal).name, "Local");
        assert.deepEqual(deletes.map(item => item.itemId), ["recipe_local"]);
        assert.equal(JSON.parse(deletes[0].expectedLocal).name, "Local only");
      });
      assert.equal(calls, 1);
      const backed = JSON.parse(fs.readFileSync(path.join(result.backupDirectory, "originals/recipes/Fixture.recipe_local.json")));
      assert.deepEqual(backed.editorLayout, localOnly.editorLayout, "Recipe recovery backup must preserve non-synced UI layout");
      f.localCatalog.scripts = f.localCatalog.scripts.filter(item => fs.existsSync(item.source));
      f.localCatalog.scripts.push({ id: "remote-only.script", cat: "", isPrivate: false,
        source: path.join(f.store, "scripts/remote-only.script"), destination: "scripts/remote-only.script" });
      const stale = await f.preview();
      f.localCatalog.recipes[0].content = JSON.stringify({ ...old, name: "edited during review" });
      await assert.rejects(() => f.apply(stale), /changed/);
    });
    for (const name of ["success", "preview-cancel", "unchecked", "reason-cancel", "confirm-cancel",
      "unsaved", "remote-changed", "baseline-failure", "refresh-failure"]) {
      await scenario("host-" + name, f => hostScenario(name, f));
    }
    console.log(`Force use Remote core + production-host real-Git E2E passed: ${scenarios} scenarios.`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
