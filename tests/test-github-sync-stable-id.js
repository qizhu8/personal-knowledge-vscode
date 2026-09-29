#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { canonicalJson } = require("../dist/workflow-contracts.js");
const {
  GITHUB_SYNC_CONTENT_TYPES,
  GitHubSyncConflictError,
  normalizeGitHubSyncTarget,
  syncGitHubTarget,
} = require("../dist/github-sync.js");

const run = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const skill = (name, body) => `---\nname: ${JSON.stringify(name)}\ndescription: "test"\n---\n# ${name}\n\n${body}\n`;
const emptyCatalog = () => Object.fromEntries(GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
const remember = (target, result, store) => {
  target.lastSync = {
    at: new Date().toISOString(),
    commit: result.commit,
    fingerprints: result.fingerprints,
    repository: target.repository,
    branch: target.branch,
    storeRoot: path.resolve(store),
  };
};
const recipe = category => {
  const definition = {
    schema: "pkm.workflow.definition/v1",
    spec: {
      inputs: {},
      nodes: [{ nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
      outputs: {},
      completion: { requiredNodes: ["work"] },
    },
  };
  return JSON.stringify({
    recipeId: "recipe_shared",
    scope: "global",
    category,
    name: "Shared Recipe",
    description: "test",
    revision: 1,
    executableDigest: require("crypto").createHash("sha256").update(canonicalJson(definition)).digest("hex"),
    definition,
  }, null, 2) + "\n";
};

function fixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pkm-github-stable-${name}-`));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const checkouts = path.join(root, "checkouts");
  fs.mkdirSync(seed);
  run(root, ["init", "--bare", remote]);
  run(seed, ["init"]);
  run(seed, ["config", "user.name", "Test"]);
  run(seed, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(seed, "README.md"), "seed\n");
  run(seed, ["add", "README.md"]);
  run(seed, ["commit", "-m", "seed"]);
  run(seed, ["branch", "-M", "main"]);
  run(seed, ["remote", "add", "origin", remote]);
  run(seed, ["push", "-u", "origin", "main"]);
  run(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);

  const machine = machineName => {
    const store = path.join(root, `${machineName}-store`);
    const source = path.join(store, "skills", "Original", "Shared.md");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, skill("Shared", "v1"));
    const catalog = emptyCatalog();
    catalog.skills = [{
      id: "knowledge_shared",
      label: "Shared",
      cat: "Original",
      isPrivate: false,
      source,
      destination: "skills/Original/Shared.md",
    }];
    const target = normalizeGitHubSyncTarget({ name: machineName, repository: remote, branch: "main" }, () => `target-${machineName}`);
    return { store, catalog, target };
  };
  return { root, remote, checkouts, machine };
}

function move(machine, category, body = "v1") {
  const current = machine.catalog.skills[0];
  if (fs.existsSync(current.source)) fs.rmSync(current.source);
  const source = path.join(machine.store, "skills", category, "Shared.md");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, skill("Shared", body));
  machine.catalog.skills[0] = {
    ...current,
    cat: category,
    source,
    destination: `skills/${category}/Shared.md`,
  };
}

async function sync(machine, checkouts) {
  const result = await syncGitHubTarget(machine.target, machine.catalog, checkouts, undefined, machine.store);
  remember(machine.target, result, machine.store);
  return result;
}

(async () => {
  {
    const test = fixture("move");
    try {
      const linux = test.machine("linux");
      const windows = test.machine("windows");
      for (const machine of [linux, windows]) {
        const bundle = path.join(machine.store, "packages", "bundle");
        fs.mkdirSync(bundle, { recursive: true });
        fs.writeFileSync(path.join(bundle, "a.txt"), "a\n");
        fs.writeFileSync(path.join(bundle, "b.txt"), "b\n");
        machine.catalog.packages = [{
          id: "package_shared",
          label: "Bundle",
          cat: "",
          isPrivate: false,
          source: bundle,
          destination: "packages/bundle",
        }];
        machine.target.selection.public.packages.folders = [""];
        machine.catalog.recipes = [{
          id: "recipe_shared",
          label: "Shared Recipe",
          cat: "Original",
          isPrivate: false,
          destination: "recipes/Original/Shared Recipe.recipe_shared.json",
          content: recipe("Original"),
        }];
      }
      await sync(linux, test.checkouts);
      await sync(windows, test.checkouts);
      move(linux, "Renamed");
      const oldBundle = linux.catalog.packages[0].source;
      const movedBundle = path.join(linux.store, "packages", "renamed-bundle");
      fs.renameSync(oldBundle, movedBundle);
      linux.catalog.packages[0] = {
        ...linux.catalog.packages[0],
        source: movedBundle,
        destination: "packages/renamed-bundle",
      };
      linux.catalog.recipes[0] = {
        ...linux.catalog.recipes[0],
        cat: "Renamed",
        destination: "recipes/Renamed/Shared Recipe.recipe_shared.json",
        content: recipe("Renamed"),
      };
      await sync(linux, test.checkouts);
      const pulled = await sync(windows, test.checkouts);
      assert(pulled.pulled.includes("skills/Renamed/Shared.md"));
      assert(pulled.deletedLocal.includes("skills/Original/Shared.md"));
      assert(!fs.existsSync(path.join(windows.store, "skills", "Original", "Shared.md")));
      assert.strictEqual(fs.readFileSync(path.join(windows.store, "skills", "Renamed", "Shared.md"), "utf8"), skill("Shared", "v1"));
      assert(!fs.existsSync(path.join(windows.store, "packages", "bundle", "a.txt")));
      assert(!fs.existsSync(path.join(windows.store, "packages", "bundle", "b.txt")));
      assert.strictEqual(fs.readFileSync(path.join(windows.store, "packages", "renamed-bundle", "a.txt"), "utf8"), "a\n");
      assert.strictEqual(fs.readFileSync(path.join(windows.store, "packages", "renamed-bundle", "b.txt"), "utf8"), "b\n");
      assert.strictEqual(pulled.recipePulls[0].itemId, "recipe_shared");
      assert.deepStrictEqual(pulled.recipeDeletes, [], "a Recipe move is one stable-identity update, not pull then delete");
      const manifest = JSON.parse(run(test.root, ["--git-dir", test.remote, "show", "main:.pkm-github-sync.json"]));
      assert.strictEqual(manifest.schema, 3);
      assert.deepStrictEqual(manifest.capabilities.required, ["explicit-deletions", "stable-entity-identity"]);
      assert(manifest.files.some(file => file.itemId === "knowledge_shared" && file.member === ""));
      assert.deepStrictEqual(manifest.files.filter(file => file.itemId === "package_shared").map(file => file.member), ["a.txt", "b.txt"]);
    } finally {
      fs.rmSync(test.root, { recursive: true, force: true });
    }
  }

  {
    const test = fixture("divergent");
    try {
      const left = test.machine("left");
      const right = test.machine("right");
      await sync(left, test.checkouts);
      await sync(right, test.checkouts);
      move(left, "Left");
      await sync(left, test.checkouts);
      move(right, "Right");
      await assert.rejects(
        () => syncGitHubTarget(right.target, right.catalog, test.checkouts, undefined, right.store),
        error => error instanceof GitHubSyncConflictError
          && error.conflicts.some(conflict => conflict.itemId === "knowledge_shared"),
        "the same stable ID moved to two destinations must conflict",
      );
    } finally {
      fs.rmSync(test.root, { recursive: true, force: true });
    }
  }

  {
    const test = fixture("delete");
    try {
      const publisher = test.machine("publisher");
      const reader = test.machine("reader");
      await sync(publisher, test.checkouts);
      await sync(reader, test.checkouts);
      publisher.catalog.skills = [];
      publisher.target.pendingDeletions = [{
        type: "skills",
        itemId: "knowledge_shared",
        deletedAt: "2026-09-28T00:00:00.000Z",
      }];
      fs.rmSync(path.join(publisher.store, "skills", "Original", "Shared.md"));
      await sync(publisher, test.checkouts);
      const deletion = await sync(reader, test.checkouts);
      assert(deletion.deletedLocal.includes("skills/Original/Shared.md"));
      const manifest = JSON.parse(run(test.root, ["--git-dir", test.remote, "show", "main:.pkm-github-sync.json"]));
      assert.strictEqual(manifest.deletions[0].itemId, "knowledge_shared");
    } finally {
      fs.rmSync(test.root, { recursive: true, force: true });
    }
  }

  {
    const test = fixture("edit-delete");
    try {
      const publisher = test.machine("publisher");
      const reader = test.machine("reader");
      await sync(publisher, test.checkouts);
      await sync(reader, test.checkouts);
      publisher.catalog.skills = [];
      publisher.target.pendingDeletions = [{
        type: "skills",
        itemId: "knowledge_shared",
        deletedAt: "2026-09-28T00:00:00.000Z",
      }];
      fs.rmSync(path.join(publisher.store, "skills", "Original", "Shared.md"));
      await sync(publisher, test.checkouts);
      fs.writeFileSync(reader.catalog.skills[0].source, skill("Shared", "local edit"));
      fs.utimesSync(reader.catalog.skills[0].source, new Date("2026-09-29T00:00:00.000Z"), new Date("2026-09-29T00:00:00.000Z"));
      const recreated = await sync(reader, test.checkouts);
      assert.strictEqual(recreated.resolutionReport.rules["newer-local-operation"], 1,
        "a local edit newer than an explicit remote deletion recreates the stable entity");
      assert.strictEqual(
        run(test.root, ["--git-dir", test.remote, "show", "main:skills/Original/Shared.md"]),
        skill("Shared", "local edit").trim(),
      );
    } finally {
      fs.rmSync(test.root, { recursive: true, force: true });
    }
  }

  {
    const test = fixture("capability");
    try {
      const machine = test.machine("machine");
      await sync(machine, test.checkouts);
      const edit = path.join(test.root, "edit");
      run(test.root, ["clone", "--branch", "main", test.remote, edit]);
      run(edit, ["config", "user.name", "Test"]);
      run(edit, ["config", "user.email", "test@example.com"]);
      const manifestPath = path.join(edit, ".pkm-github-sync.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.capabilities.required.push("future-required-capability");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      run(edit, ["add", ".pkm-github-sync.json"]);
      run(edit, ["commit", "-m", "future capability"]);
      run(edit, ["push"]);
      await assert.rejects(
        () => syncGitHubTarget(machine.target, machine.catalog, test.checkouts, undefined, machine.store),
        /unsupported required capability.*future-required-capability/i,
      );
      assert.strictEqual(run(test.root, ["--git-dir", test.remote, "rev-list", "--count", "main"]), "3",
        "capability rejection must happen before a client commit or Push");
    } finally {
      fs.rmSync(test.root, { recursive: true, force: true });
    }
  }

  console.log("github-sync stable identity tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
