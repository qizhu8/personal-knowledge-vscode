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
    await assert.rejects(linuxRace, /git push failed/, "the losing machine must surface the non-fast-forward push");
    fs.rmSync(prePushHook);

    const linuxRetry = await syncGitHubTarget(linux.target, linux.catalog, checkoutRoot, undefined, linux.store);
    rememberSync(linux.target, linuxRetry);
    assert(linuxRetry.pulled.includes("skills/Shared/Two.md"), "retry must pull the winning machine's independent edit");
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
