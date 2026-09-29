#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHash } = require("crypto");
const { execFileSync } = require("child_process");
const { canonicalJson } = require("../dist/workflow-contracts.js");
const {
  GITHUB_SYNC_CONTENT_TYPES,
  GitHubSyncConflictError,
  completeGitHubSyncTransaction,
  normalizeGitHubSyncTarget,
  syncGitHubTarget
} = require("../dist/github-sync.js");

const run = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const skill = (name, body) => `---\nname: ${JSON.stringify(name)}\ndescription: "test"\n---\n# ${name}\n\n${body}\n`;
const builtInRecipe = description => {
  const definition = {
    schema: "pkm.workflow.definition/v1",
    spec: {
      inputs: {},
      nodes: [{ nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
      outputs: {},
      completion: { requiredNodes: ["work"] }
    }
  };
  return JSON.stringify({
    recipeId: "recipe_builtin",
    scope: "global",
    category: "System",
    systemKind: "built-in",
    name: "Built-in",
    description,
    revision: 2,
    executableDigest: createHash("sha256").update(canonicalJson(definition)).digest("hex"),
    definition,
  }, null, 2) + "\n";
};
const recipeWithLayout = (x, y) => {
  const definition = {
    schema: "pkm.workflow.definition/v1",
    spec: {
      inputs: {},
      nodes: [{ nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
      outputs: {},
      completion: { requiredNodes: ["work"] }
    }
  };
  return JSON.stringify({
    recipeId: "recipe_layout",
    scope: "global",
    category: "Shared",
    name: "Layout isolation",
    description: "Shared logic with machine-local graph coordinates",
    revision: 1,
    executableDigest: createHash("sha256").update(canonicalJson(definition)).digest("hex"),
    editorLayout: { nodePositions: { work: { x, y } } },
    definition,
  }, null, 2) + "\n";
};
const rememberSync = (target, result) => {
  target.lastSync = { at: new Date().toISOString(), commit: result.commit, fingerprints: result.fingerprints };
};
const waitForFile = async (file, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const emptyCatalog = () => Object.fromEntries(GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-github-sync-two-machine-"));
  try {
    const remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    const checkoutRoot = path.join(root, "checkouts");
    fs.mkdirSync(seed);
    run(root, ["init", "--bare", remote]);
    run(seed, ["init"]);
    run(seed, ["config", "user.name", "Test"]);
    run(seed, ["config", "user.email", "test@example.com"]);
    fs.writeFileSync(path.join(seed, "README.md"), "default branch only\n");
    run(seed, ["add", "README.md"]);
    run(seed, ["commit", "-m", "seed"]);
    run(seed, ["branch", "-M", "main"]);
    run(seed, ["remote", "add", "origin", remote]);
    run(seed, ["push", "-u", "origin", "main"]);
    run(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);

    run(seed, ["checkout", "-b", "legacy"]);
    fs.mkdirSync(path.join(seed, "skills", "Legacy"), { recursive: true });
    fs.mkdirSync(path.join(seed, "notes", "Imported"), { recursive: true });
    fs.mkdirSync(path.join(seed, "recipes", "Imported"), { recursive: true });
    fs.writeFileSync(path.join(seed, "skills", "Legacy", "Remote.md"), skill("Remote", "legacy remote skill"));
    fs.writeFileSync(path.join(seed, "notes", "Imported", "Remote.md"), "---\ntitle: Remote\ncategory: Imported\n---\nlegacy remote note\n");
    const legacyDefinition = {
      schema: "pkm.workflow.definition/v1",
      spec: {
        inputs: {},
        nodes: [{ nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
        outputs: {},
        completion: { requiredNodes: ["work"] }
      }
    };
    fs.writeFileSync(path.join(seed, "recipes", "Imported", "Remote.recipe_legacy_remote.json"), JSON.stringify({
      recipeId: "recipe_legacy_remote",
      scope: "global",
      category: "Imported",
      name: "Remote",
      description: "legacy remote recipe",
      revision: 1,
      executableDigest: createHash("sha256").update(canonicalJson(legacyDefinition)).digest("hex"),
      definition: legacyDefinition,
    }, null, 2) + "\n");
    fs.writeFileSync(path.join(seed, ".pkm-github-sync.json"), JSON.stringify({
      schema: 1,
      files: [
        "notes/Imported/Remote.md",
        "recipes/Imported/Remote.recipe_legacy_remote.json",
        "skills/Legacy/Remote.md"
      ]
    }, null, 2) + "\n");
    run(seed, ["add", "-A"]);
    run(seed, ["commit", "-m", "legacy manifest"]);
    run(seed, ["push", "-u", "origin", "legacy"]);
    run(seed, ["checkout", "main"]);

    const legacyStore = path.join(root, "legacy-store");
    fs.mkdirSync(legacyStore);
    const legacyTarget = normalizeGitHubSyncTarget({
      name: "Legacy restore",
      repository: remote,
      branch: "legacy"
    }, () => "target-legacy");
    const legacyResult = await syncGitHubTarget(legacyTarget, emptyCatalog(), checkoutRoot, undefined, legacyStore);
    assert.deepStrictEqual(legacyResult.pulled.sort(), [
      "notes/Imported/Remote.md",
      "recipes/Imported/Remote.recipe_legacy_remote.json",
      "skills/Legacy/Remote.md"
    ],
      "a new machine must materialize selected files from a schema-1 manifest even when its local catalog is empty");
    assert(fs.existsSync(path.join(legacyStore, "skills", "Legacy", "Remote.md")));
    assert(fs.existsSync(path.join(legacyStore, "notes", "Imported", "Remote.md")));
    assert(!fs.existsSync(path.join(legacyStore, "recipes", "Imported", "Remote.recipe_legacy_remote.json")),
      "Recipe pulls are virtual Project Store updates, not synthetic Knowledge Root files");
    assert.strictEqual(legacyResult.recipePulls[0].itemId, "recipe_legacy_remote");
    const migratedManifest = JSON.parse(run(root, ["--git-dir", remote, "show", "legacy:.pkm-github-sync.json"]));
    assert.strictEqual(migratedManifest.schema, 3, "the first successful reconciliation upgrades a legacy manifest to schema 3");
    assert.deepStrictEqual(migratedManifest.capabilities.required, ["explicit-deletions", "stable-entity-identity"]);

    const layoutCatalogA = emptyCatalog();
    layoutCatalogA.recipes = [{
      id: "recipe_layout",
      label: "Layout isolation",
      cat: "Shared",
      isPrivate: false,
      destination: "recipes/Shared/Layout isolation.recipe_layout.json",
      content: recipeWithLayout(40, 80)
    }];
    const layoutTargetA = normalizeGitHubSyncTarget({
      name: "Layout A",
      repository: remote,
      branch: "layout-isolation"
    }, () => "target-layout-a");
    const layoutInitial = await syncGitHubTarget(layoutTargetA, layoutCatalogA, checkoutRoot);
    rememberSync(layoutTargetA, layoutInitial);
    const publishedLayoutRecipe = JSON.parse(run(root, [
      "--git-dir", remote, "show", "layout-isolation:recipes/Shared/Layout isolation.recipe_layout.json"
    ]));
    assert.strictEqual(publishedLayoutRecipe.editorLayout, undefined,
      "GitHub publication must exclude machine-local Recipe graph coordinates");

    layoutCatalogA.recipes[0].content = recipeWithLayout(600, 320);
    const layoutOnlyUpdate = await syncGitHubTarget(layoutTargetA, layoutCatalogA, checkoutRoot);
    assert.strictEqual(layoutOnlyUpdate.changed, false,
      "moving Recipe graph nodes on one machine must not create a GitHub commit");
    assert.strictEqual(layoutOnlyUpdate.commit, layoutInitial.commit);

    const layoutCatalogB = emptyCatalog();
    layoutCatalogB.recipes = [{
      ...layoutCatalogA.recipes[0],
      content: recipeWithLayout(920, 510)
    }];
    const layoutTargetB = normalizeGitHubSyncTarget({
      name: "Layout B",
      repository: remote,
      branch: "layout-isolation"
    }, () => "target-layout-b");
    const layoutSecondMachine = await syncGitHubTarget(layoutTargetB, layoutCatalogB, checkoutRoot);
    assert.strictEqual(layoutSecondMachine.changed, false,
      "different graph coordinates on another machine must not conflict or create a commit");

    const createMachine = name => {
      const store = path.join(root, `${name}-store`);
      const skills = path.join(store, "skills", "Shared");
      const scripts = path.join(store, "scripts");
      fs.mkdirSync(skills, { recursive: true });
      fs.mkdirSync(scripts, { recursive: true });
      fs.writeFileSync(path.join(skills, "One.md"), skill("One", "one v1"));
      fs.writeFileSync(path.join(skills, "Two.md"), skill("Two", "two v1"));
      fs.writeFileSync(path.join(scripts, "run.sh"), "echo ready\n");
      const catalog = emptyCatalog();
      catalog.skills = [
        { id: "Shared/One", label: "One", cat: "Shared", isPrivate: false, source: path.join(skills, "One.md"), destination: "skills/Shared/One.md" },
        { id: "Shared/Two", label: "Two", cat: "Shared", isPrivate: false, source: path.join(skills, "Two.md"), destination: "skills/Shared/Two.md" }
      ];
      catalog.scripts = [
        { id: "run.sh", label: "run.sh", cat: "", isPrivate: false, source: path.join(scripts, "run.sh"), destination: "scripts/run.sh" }
      ];
      const target = normalizeGitHubSyncTarget({ name, repository: remote, branch: "main" }, () => `target-${name}`);
      return { store, skills, catalog, target };
    };

    const linux = createMachine("linux");
    const windows = createMachine("windows");
    const authority = createMachine("authority");
    authority.target.branch = "authority-cutover";
    const authorityInitial = await syncGitHubTarget(authority.target, authority.catalog, checkoutRoot, undefined, authority.store);
    const authorityReceiptPath = path.join(checkoutRoot, authority.target.id, "transactions", "latest.json");
    assert.strictEqual(JSON.parse(fs.readFileSync(authorityReceiptPath, "utf8")).state, "pushed",
      "a durable receipt must exist before extension-level post-processing");
    completeGitHubSyncTransaction(checkoutRoot, authority.target.id, authorityInitial.transactionId);
    assert.strictEqual(JSON.parse(fs.readFileSync(authorityReceiptPath, "utf8")).state, "recorded",
      "the receipt must record durable target-state persistence");
    rememberSync(authority.target, authorityInitial);
    const authorityMigrated = path.join(authority.store, "skills", "Migrated");
    fs.mkdirSync(authorityMigrated, { recursive: true });
    fs.renameSync(path.join(authority.skills, "One.md"), path.join(authorityMigrated, "One.md"));
    authority.catalog.skills = [{
      ...authority.catalog.skills[0],
      id: "knowledge-one",
      source: path.join(authorityMigrated, "One.md"),
      destination: "skills/Migrated/One.md",
    }];
    fs.rmSync(path.join(authority.skills, "Two.md"));
    authority.target.publication = {
      requiredCapability: "stable-entity-identity",
      sourceCommit: authorityInitial.commit,
      sourceDigest: "a".repeat(64),
      manualVerificationCompleted: false,
    };
    const authorityCutover = await syncGitHubTarget(authority.target, authority.catalog, checkoutRoot, undefined, authority.store);
    assert.strictEqual(authorityCutover.changed, true, "the first post-cutover sync publishes the local migration as one authoritative commit");
    assert(authorityCutover.resolutionReport.rules["authoritative-migration"] >= 3,
      "migration reports how many physical paths were resolved by local authority");
    const authorityFiles = run(root, ["--git-dir", remote, "ls-tree", "-r", "--name-only", "authority-cutover"]).split("\n");
    assert(authorityFiles.includes("skills/Migrated/One.md"));
    assert(!authorityFiles.includes("skills/Shared/One.md") && !authorityFiles.includes("skills/Shared/Two.md"),
      "authoritative migration removes obsolete selected paths without creating delete conflicts");
    rememberSync(authority.target, authorityCutover);
    const forceRemote = path.join(root, "force-remote");
    run(root, ["clone", "--branch", "authority-cutover", remote, forceRemote]);
    const forceRemoteContent = skill("One", "remote edit that will be explicitly overwritten");
    fs.writeFileSync(path.join(forceRemote, "skills", "Migrated", "One.md"), forceRemoteContent);
    const forceManifestPath = path.join(forceRemote, ".pkm-github-sync.json");
    const forceManifest = JSON.parse(fs.readFileSync(forceManifestPath, "utf8"));
    forceManifest.files = forceManifest.files.map(file => file.path === "skills/Migrated/One.md"
      ? { ...file, digest: createHash("sha256").update(forceRemoteContent).digest("hex") }
      : file);
    fs.writeFileSync(forceManifestPath, `${JSON.stringify(forceManifest, null, 2)}\n`);
    run(forceRemote, ["config", "user.name", "Remote User"]);
    run(forceRemote, ["config", "user.email", "remote@example.com"]);
    run(forceRemote, ["add", "-A"]);
    run(forceRemote, ["commit", "-m", "remote conflicting edit"]);
    run(forceRemote, ["push"]);
    fs.writeFileSync(path.join(authority.store, "skills", "Migrated", "One.md"), skill("One", "local recovery truth"));
    await assert.rejects(
      () => syncGitHubTarget(authority.target, authority.catalog, checkoutRoot, undefined, authority.store, undefined,
        { mode: "force-local-authority", actor: "oak", comment: "" }),
      /requires a non-empty user comment/,
      "Force Update cannot run without an audit reason",
    );
    const forced = await syncGitHubTarget(authority.target, authority.catalog, checkoutRoot, undefined, authority.store, undefined,
      { mode: "force-local-authority", actor: "oak", comment: "Recover the repository after a broken migration." });
    assert(forced.resolutionReport.rules["force-local-authority"] >= 1);
    const forceCommit = run(root, ["--git-dir", remote, "show", "-s", "--format=%B", "authority-cutover"]);
    assert.match(forceCommit, /PKM force update by oak/);
    assert.match(forceCommit, /PKM-Comment: Recover the repository after a broken migration\./);
    const forceReceipt = JSON.parse(fs.readFileSync(path.join(checkoutRoot, authority.target.id, "transactions", "latest.json"), "utf8"));
    assert.strictEqual(forceReceipt.actor, "oak");
    assert.strictEqual(forceReceipt.comment, "Recover the repository after a broken migration.");

    const mergeA = createMachine("merge-a");
    const mergeB = createMachine("merge-b");
    mergeA.target.branch = "deterministic-merge";
    mergeB.target.branch = "deterministic-merge";
    const mergeBase = skill("One", "alpha\nshared\nomega");
    fs.writeFileSync(path.join(mergeA.skills, "One.md"), mergeBase);
    fs.writeFileSync(path.join(mergeB.skills, "One.md"), mergeBase);
    rememberSync(mergeA.target, await syncGitHubTarget(mergeA.target, mergeA.catalog, checkoutRoot, undefined, mergeA.store));
    rememberSync(mergeB.target, await syncGitHubTarget(mergeB.target, mergeB.catalog, checkoutRoot, undefined, mergeB.store));
    fs.writeFileSync(path.join(mergeA.skills, "One.md"), skill("One", "alpha from A\nshared\nomega"));
    rememberSync(mergeA.target, await syncGitHubTarget(mergeA.target, mergeA.catalog, checkoutRoot, undefined, mergeA.store));
    fs.writeFileSync(path.join(mergeB.skills, "One.md"), skill("One", "alpha\nshared\nomega from B"));
    const deterministicMerge = await syncGitHubTarget(mergeB.target, mergeB.catalog, checkoutRoot, undefined, mergeB.store);
    rememberSync(mergeB.target, deterministicMerge);
    assert(deterministicMerge.resolutionReport.rules["deterministic-three-way"] >= 1,
      "the resolution report attributes the automatic same-file merge to its rule");
    assert.strictEqual(
      fs.readFileSync(path.join(mergeB.skills, "One.md"), "utf8"),
      skill("One", "alpha from A\nshared\nomega from B"),
      "non-overlapping edits to the same entity must merge automatically from Base, Local, and Remote",
    );

    const gitPhases = [];
    rememberSync(linux.target, await syncGitHubTarget(
      linux.target,
      linux.catalog,
      checkoutRoot,
      undefined,
      linux.store,
      (phase, detail) => gitPhases.push([phase, detail]),
    ));
    assert.deepStrictEqual(
      gitPhases.map(([phase]) => phase),
      ["fetch", "commit", "push"],
      "GitHub Sync reports the actual Git operation sequence"
    );
    rememberSync(windows.target, await syncGitHubTarget(windows.target, windows.catalog, checkoutRoot, undefined, windows.store));

    const branchTarget = normalizeGitHubSyncTarget({
      name: "Scripts only",
      repository: remote,
      branch: "scripts-only",
      selection: {
        public: { scripts: { items: ["run.sh"], folders: [] } },
        private: {}
      }
    }, () => "target-scripts-only");
    await syncGitHubTarget(branchTarget, linux.catalog, checkoutRoot, undefined, linux.store);
    const newBranchFiles = run(root, ["--git-dir", remote, "ls-tree", "-r", "--name-only", "refs/heads/scripts-only"]).split("\n");
    assert.deepStrictEqual(
      newBranchFiles,
      [".pkm-github-sync.json", "scripts/run.sh"],
      "a new synchronization branch must not inherit unselected files from the default branch"
    );

    const metadataTarget = normalizeGitHubSyncTarget({
      name: "Metadata convergence",
      repository: remote,
      branch: "metadata-convergence"
    }, () => "target-metadata-convergence");
    rememberSync(metadataTarget, await syncGitHubTarget(metadataTarget, linux.catalog, checkoutRoot, undefined, linux.store));
    const metadataVerify = path.join(root, "metadata-verify");
    run(root, ["clone", "--branch", "metadata-convergence", remote, metadataVerify]);
    run(metadataVerify, ["config", "user.name", "Test"]);
    run(metadataVerify, ["config", "user.email", "test@example.com"]);
    const metadataManifestPath = path.join(metadataVerify, ".pkm-github-sync.json");
    const metadataManifest = JSON.parse(fs.readFileSync(metadataManifestPath, "utf8"));
    metadataManifest.files = metadataManifest.files.map(file => file.path === "skills/Shared/One.md"
      ? { ...file, category: "Remote Metadata" }
      : file);
    fs.writeFileSync(metadataManifestPath, `${JSON.stringify(metadataManifest, null, 2)}\n`);
    run(metadataVerify, ["add", ".pkm-github-sync.json"]);
    run(metadataVerify, ["commit", "-m", "change remote metadata only"]);
    run(metadataVerify, ["push"]);
    const metadataCatalog = {
      ...linux.catalog,
      skills: linux.catalog.skills.map(file => file.destination === "skills/Shared/One.md"
        ? { ...file, cat: "Local Metadata" }
        : file)
    };
    await assert.doesNotReject(
      () => syncGitHubTarget(metadataTarget, metadataCatalog, checkoutRoot, undefined, linux.store),
      "matching content must not become a conflict only because both machines changed manifest metadata"
    );

    const builtInTarget = normalizeGitHubSyncTarget({
      name: "Built-in Recipe authority",
      repository: remote,
      branch: "built-in-authority"
    }, () => "target-built-in-authority");
    const builtInCatalog = emptyCatalog();
    builtInCatalog.recipes = [{
      id: "recipe_builtin",
      label: "Built-in",
      cat: "System",
      isPrivate: false,
      destination: "recipes/System/Built-in.recipe_builtin.json",
      content: builtInRecipe("local extension definition")
    }];
    rememberSync(builtInTarget, await syncGitHubTarget(builtInTarget, builtInCatalog, checkoutRoot, undefined, linux.store));
    const builtInVerify = path.join(root, "built-in-verify");
    run(root, ["clone", "--branch", "built-in-authority", remote, builtInVerify]);
    run(builtInVerify, ["config", "user.name", "Test"]);
    run(builtInVerify, ["config", "user.email", "test@example.com"]);
    const builtInPath = path.join(builtInVerify, "recipes", "System", "Built-in.recipe_builtin.json");
    fs.writeFileSync(builtInPath, builtInRecipe("remote stale definition"));
    const builtInManifestPath = path.join(builtInVerify, ".pkm-github-sync.json");
    const builtInManifest = JSON.parse(fs.readFileSync(builtInManifestPath, "utf8"));
    builtInManifest.files = builtInManifest.files.map(file => file.path === "recipes/System/Built-in.recipe_builtin.json"
      ? { ...file, digest: createHash("sha256").update(builtInRecipe("remote stale definition")).digest("hex") }
      : file);
    fs.writeFileSync(builtInManifestPath, `${JSON.stringify(builtInManifest, null, 2)}\n`);
    run(builtInVerify, ["add", "-A"]);
    run(builtInVerify, ["commit", "-m", "stale remote built-in"]);
    run(builtInVerify, ["push"]);
    const builtInResult = await syncGitHubTarget(builtInTarget, builtInCatalog, checkoutRoot, undefined, linux.store);
    assert.strictEqual(builtInResult.changed, true, "the extension-owned built-in definition updates GitHub without a conflict");
    assert.strictEqual(
      run(root, ["--git-dir", remote, "show", "built-in-authority:recipes/System/Built-in.recipe_builtin.json"]),
      builtInRecipe("local extension definition").trim(),
      "GitHub converges to the current extension-owned built-in Recipe"
    );

    const identityStore = path.join(root, "identity-store");
    const identitySource = path.join(identityStore, "scripts", "Analysis", "tool.script");
    fs.mkdirSync(path.dirname(identitySource), { recursive: true });
    fs.writeFileSync(identitySource, "SELECT 1;\n");
    const identityTarget = normalizeGitHubSyncTarget({
      name: "Migrated identity",
      repository: remote,
      branch: "identity-migration",
      selection: {
        public: { scripts: { items: [], folders: [""] } },
        private: {}
      }
    }, () => "target-identity-migration");
    const legacyIdentityCatalog = emptyCatalog();
    legacyIdentityCatalog.scripts = [{
      id: "Analysis/tool",
      label: "tool.script",
      cat: "Analysis",
      isPrivate: false,
      source: identitySource,
      destination: "scripts/Analysis/tool.script"
    }];
    rememberSync(identityTarget, await syncGitHubTarget(identityTarget, legacyIdentityCatalog, checkoutRoot, undefined, identityStore));
    const canonicalIdentityCatalog = emptyCatalog();
    canonicalIdentityCatalog.scripts = [{
      ...legacyIdentityCatalog.scripts[0],
      id: "Analysis/tool.script"
    }];
    const identityUpgrade = await syncGitHubTarget(identityTarget, canonicalIdentityCatalog, checkoutRoot, undefined, identityStore);
    rememberSync(identityTarget, identityUpgrade);
    assert.strictEqual(identityUpgrade.changed, true, "identity-only migration publishes corrected manifest metadata");
    const identityManifest = JSON.parse(run(root, ["--git-dir", remote, "show", "identity-migration:.pkm-github-sync.json"]));
    assert.strictEqual(identityManifest.files[0].itemId, "Analysis/tool.script");
    assert.strictEqual(
      run(root, ["--git-dir", remote, "log", "--format=%s", "--reverse", "identity-migration"]).split("\n").length,
      2,
      "identity reconciliation creates one initial publication and one metadata-only correction without a conflict"
    );

    fs.writeFileSync(path.join(linux.skills, "One.md"), skill("One", "linux concurrent edit"));
    fs.writeFileSync(path.join(windows.skills, "Two.md"), skill("Two", "windows concurrent edit"));
    const linuxCheckout = path.join(checkoutRoot, linux.target.id, "repository");
    const pushStarted = path.join(root, "linux-push-started");
    const releasePush = path.join(root, "release-linux-push");
    const prePushHook = path.join(linuxCheckout, ".git", "hooks", "pre-push");
    fs.writeFileSync(prePushHook, `#!/bin/sh\n: > "${pushStarted}"\nwhile [ ! -f "${releasePush}" ]; do sleep 0.02; done\n`, { mode: 0o755 });

    const linuxRace = syncGitHubTarget(linux.target, linux.catalog, checkoutRoot, undefined, linux.store);
    await waitForFile(pushStarted);
    const windowsRace = await syncGitHubTarget(windows.target, windows.catalog, checkoutRoot, undefined, windows.store);
    rememberSync(windows.target, windowsRace);
    fs.writeFileSync(releasePush, "continue\n");
    const linuxReconciled = await linuxRace;
    fs.rmSync(prePushHook);
    rememberSync(linux.target, linuxReconciled);
    assert(linuxReconciled.pulled.includes("skills/Shared/Two.md"), "the losing machine must automatically pull and reconcile the winning machine's independent edit");
    assert.strictEqual(fs.readFileSync(path.join(linux.skills, "Two.md"), "utf8"), skill("Two", "windows concurrent edit"));

    const verify = path.join(root, "verify");
    run(root, ["clone", "--branch", "main", remote, verify]);
    assert.strictEqual(fs.readFileSync(path.join(verify, "skills", "Shared", "One.md"), "utf8"), skill("One", "linux concurrent edit"));
    assert.strictEqual(fs.readFileSync(path.join(verify, "skills", "Shared", "Two.md"), "utf8"), skill("Two", "windows concurrent edit"));

    const windowsCatchUp = await syncGitHubTarget(windows.target, windows.catalog, checkoutRoot, undefined, windows.store);
    rememberSync(windows.target, windowsCatchUp);
    fs.writeFileSync(path.join(windows.skills, "Two.md"), skill("Two", "windows remote update"));
    rememberSync(windows.target, await syncGitHubTarget(windows.target, windows.catalog, checkoutRoot, undefined, windows.store));
    fs.writeFileSync(path.join(linux.skills, "One.md"), skill("One", "linux rejected update"));

    const rejectHook = path.join(remote, "hooks", "pre-receive");
    fs.writeFileSync(rejectHook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await assert.rejects(
      () => syncGitHubTarget(linux.target, linux.catalog, checkoutRoot, undefined, linux.store),
      /git push failed/
    );
    assert.strictEqual(
      fs.readFileSync(path.join(linux.skills, "Two.md"), "utf8"),
      skill("Two", "windows concurrent edit"),
      "a failed push must not partially apply remote pulls to the local store"
    );
    fs.rmSync(rejectHook);
    const recovered = await syncGitHubTarget(linux.target, linux.catalog, checkoutRoot, undefined, linux.store);
    rememberSync(linux.target, recovered);
    assert.strictEqual(fs.readFileSync(path.join(linux.skills, "Two.md"), "utf8"), skill("Two", "windows remote update"));

    assert.strictEqual(fs.readFileSync(path.join(windows.skills, "Two.md"), "utf8"), skill("Two", "windows remote update"));
    const finalWindowsCatchUp = await syncGitHubTarget(windows.target, windows.catalog, checkoutRoot, undefined, windows.store);
    rememberSync(windows.target, finalWindowsCatchUp);
    fs.rmSync(path.join(windows.skills, "Two.md"));
    windows.catalog.skills = windows.catalog.skills.filter(file => file.id !== "Shared/Two");
    fs.writeFileSync(path.join(windows.skills, "One.md"), skill("One", "windows modifies while linux deletes"));
    await assert.rejects(
      () => syncGitHubTarget(windows.target, windows.catalog, checkoutRoot, undefined, windows.store),
      error => error instanceof GitHubSyncConflictError
        && error.conflicts.some(conflict => conflict.path === "skills/Shared/Two.md" && !conflict.local && !!conflict.remote),
      "local absence must not be treated as approval to delete the remote file"
    );

    run(verify, ["pull", "--ff-only"]);
    const remoteOne = skill("One", "windows modifies while linux deletes");
    fs.writeFileSync(path.join(verify, "skills", "Shared", "One.md"), remoteOne);
    fs.rmSync(path.join(verify, "skills", "Shared", "Two.md"));
    const manifestPath = path.join(verify, ".pkm-github-sync.json");
    const remoteManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    remoteManifest.files = remoteManifest.files
      .filter(file => file.path !== "skills/Shared/Two.md")
      .map(file => file.path === "skills/Shared/One.md"
        ? { ...file, digest: createHash("sha256").update(remoteOne).digest("hex") }
        : file);
    fs.writeFileSync(manifestPath, `${JSON.stringify(remoteManifest, null, 2)}\n`);
    run(verify, ["add", "-A"]);
    run(verify, ["commit", "-m", "remote modify and approved delete"]);
    run(verify, ["push"]);

    fs.writeFileSync(path.join(linux.skills, "Two.md"), skill("Two", "linux modifies while windows deletes"));
    fs.rmSync(path.join(linux.skills, "One.md"));
    linux.catalog.skills = linux.catalog.skills.filter(file => file.id !== "Shared/One");
    await assert.rejects(
      () => syncGitHubTarget(linux.target, linux.catalog, checkoutRoot, undefined, linux.store),
      error => error instanceof GitHubSyncConflictError
        && error.conflicts.some(conflict => conflict.path === "skills/Shared/One.md" && !conflict.local && !!conflict.remote)
        && error.conflicts.some(conflict => conflict.path === "skills/Shared/Two.md" && !!conflict.local && !conflict.remote),
      "modify/delete and delete/modify races must both require explicit conflict approval"
    );

    run(verify, ["pull", "--ff-only"]);
    fs.writeFileSync(path.join(verify, "skills", "Shared", "One.md"), skill("One", "tampered without manifest update"));
    run(verify, ["add", "skills/Shared/One.md"]);
    run(verify, ["commit", "-m", "tamper managed content"]);
    run(verify, ["push"]);
    await assert.rejects(
      () => syncGitHubTarget(linux.target, linux.catalog, checkoutRoot, undefined, linux.store),
      /digest/i,
      "managed file content must match the digest recorded in the remote manifest"
    );

    console.log("github-sync two-machine tests passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
