#!/usr/bin/env node
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  GITHUB_SYNC_CONTENT_TYPES,
  GitHubSyncConflictError,
  normalizeGitHubSyncTarget,
  previewGitHubSyncTarget,
  restoreGitHubRemoteFiles,
  syncGitHubTarget,
} = require("../dist/sync/github-sync.js");
const { githubSyncFingerprintInWorker } = require("../dist/sync/github-sync-fingerprint-worker.js");

const run = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const skill = (name, body) => `---\nname: ${JSON.stringify(name)}\ndescription: "test"\n---\n# ${name}\n\n${body}\n`;
const digest = content => crypto.createHash("sha256").update(content).digest("hex");
const emptyCatalog = () => Object.fromEntries(GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
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

function createFixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pkm-github-sync-safety-${name}-`));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const store = path.join(root, "store");
  const skills = path.join(store, "skills", "Shared");
  const checkoutRoot = path.join(root, "checkouts");
  fs.mkdirSync(seed);
  fs.mkdirSync(skills, { recursive: true });
  run(root, ["init", "--bare", remote]);
  run(seed, ["init"]);
  run(seed, ["config", "user.name", "Test"]);
  run(seed, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(seed, "README.md"), "unmanaged\n");
  run(seed, ["add", "README.md"]);
  run(seed, ["commit", "-m", "seed"]);
  run(seed, ["branch", "-M", "main"]);
  run(seed, ["remote", "add", "origin", remote]);
  run(seed, ["push", "-u", "origin", "main"]);
  run(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);

  fs.writeFileSync(path.join(skills, "One.md"), skill("One", "one v1"));
  fs.writeFileSync(path.join(skills, "Two.md"), skill("Two", "two v1"));
  const catalog = emptyCatalog();
  catalog.skills = [
    { id: "Shared/One", label: "One", cat: "Shared", isPrivate: false, source: path.join(skills, "One.md"), destination: "skills/Shared/One.md" },
    { id: "Shared/Two", label: "Two", cat: "Shared", isPrivate: false, source: path.join(skills, "Two.md"), destination: "skills/Shared/Two.md" },
  ];
  const target = normalizeGitHubSyncTarget({ name, repository: remote, branch: "main" }, () => `target-${name}`);
  return { root, remote, store, skills, checkoutRoot, catalog, target };
}

async function initialize(fixture) {
  rememberSync(fixture.target, await syncGitHubTarget(
    fixture.target,
    fixture.catalog,
    fixture.checkoutRoot,
    undefined,
    fixture.store,
  ));
  fixture.target.lastSync.repository = fixture.target.repository;
  fixture.target.lastSync.branch = fixture.target.branch;
  fixture.target.lastSync.storeRoot = path.resolve(fixture.store);
}

function cloneRemote(fixture, name = "verify") {
  const checkout = path.join(fixture.root, name);
  run(fixture.root, ["clone", "--branch", "main", fixture.remote, checkout]);
  run(checkout, ["config", "user.name", "Remote Test"]);
  run(checkout, ["config", "user.email", "remote@example.com"]);
  return checkout;
}

function trackLocalFiles(fixture, root = fixture.store) {
  run(root, ["init"]);
  run(root, ["config", "user.name", "Local Test"]);
  run(root, ["config", "user.email", "local@example.com"]);
  run(root, ["add", "-A"]);
  run(root, ["commit", "-m", "track local knowledge"]);
}

function removeLocalOne(fixture) {
  fs.rmSync(path.join(fixture.skills, "One.md"));
  fixture.catalog.skills = fixture.catalog.skills.filter(item => item.id !== "Shared/One");
}

function commitRemoteFile(checkout, relative, content, updateManifest = true) {
  const destination = path.join(checkout, ...relative.split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
  if (updateManifest) {
    const manifestPath = path.join(checkout, ".pkm-github-sync.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const file = manifest.files.find(candidate => candidate.path === relative);
    if (!file) throw new Error(`Manifest file not found: ${relative}`);
    file.digest = digest(Buffer.from(content));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  run(checkout, ["add", "-A"]);
  run(checkout, ["commit", "-m", `update ${relative}`]);
  run(checkout, ["push"]);
}

async function requireAbsenceReview(fixture, paths) {
  await assert.rejects(
    () => syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store),
    error => {
      assert(error instanceof GitHubSyncConflictError);
      assert.deepStrictEqual(error.conflicts.map(conflict => conflict.path).sort(), paths.slice().sort());
      return true;
    },
  );
}

const failures = [];
async function scenario(name, action) {
  try {
    await action();
    console.log(`file-safety scenario passed: ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`file-safety scenario failed: ${name}: ${error?.message || error}`);
  }
}

(async () => {
  await scenario("managed checkout long paths survive first clone, upgrades, edits and repeated Sync", async () => {
    const fixture = createFixture("longpaths");
    try {
      const checkout = path.join(fixture.checkoutRoot, fixture.target.id, "repository");
      const paths = [274, 294, 300].map((length, index) => {
        const suffix = `notes/Windows/Deep/Nested/Long/File${index}.md`;
        const padding = length - path.join(checkout, suffix).length - 1;
        assert(padding > 0 && padding < 255, "the fixture must have a valid long-path component");
        const relative = suffix.replace("/Long/", `/${"x".repeat(padding)}/Long/`);
        assert.strictEqual(path.join(checkout, relative).length, length);
        const source = path.join(fixture.store, relative);
        fs.mkdirSync(path.dirname(source), { recursive: true });
        fs.writeFileSync(source, `long path ${length}\n`);
        fixture.catalog.notes.push({ id: relative.slice(6, -3), label: `Long ${index}`, cat: path.posix.dirname(relative).slice(6),
          source, destination: relative, isPrivate: false });
        return relative;
      });
      await initialize(fixture);
      fs.rmSync(checkout, { recursive: true, force: true });
      const cloned = await syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
      assert.strictEqual(cloned.changed, false, "first clone containing long files does not manufacture deletions");
      assert.strictEqual(run(checkout, ["config", "--local", "core.longpaths"]), "true");
      for (const relative of paths) assert(fs.readFileSync(path.join(checkout, relative), "utf8").startsWith("long path "));
      assert.strictEqual(run(checkout, ["status", "--porcelain"]), "", "long files are not reported as deleted");
      run(checkout, ["config", "--local", "--unset", "core.longpaths"]);
      fs.writeFileSync(path.join(fixture.store, paths[0]), "real modification\n");
      const modified = await syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
      assert(modified.changed);
      assert.strictEqual(run(checkout, ["config", "--local", "core.longpaths"]), "true", "existing checkouts are configured before status");
      rememberSync(fixture.target, modified);
      const repeated = await syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
      assert.strictEqual(repeated.changed, false);
      assert.strictEqual(repeated.commit, modified.commit);
      assert.strictEqual(run(checkout, ["status", "--porcelain"]), "");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
  for (const remoteChanged of [false, true]) {
    await scenario(`existing remote merge markers ${remoteChanged ? "require conflict review when remote changed" : "can be repaired by a clean local-only edit"}`, async () => {
      const fixture = createFixture(`remote-markers-${remoteChanged}`);
      try {
        const note = path.join(fixture.store, "notes", "Repair.md");
        fs.mkdirSync(path.dirname(note));
        fs.writeFileSync(note, "clean original\n");
        fixture.catalog.notes = [{ id: "Repair", label: "Repair", cat: "", isPrivate: false,
          source: note, destination: "notes/Repair.md" }];
        await initialize(fixture);
        const verify = cloneRemote(fixture);
        commitRemoteFile(verify, "notes/Repair.md", "clean original\n<<<<<<< Updated upstream\n\n=======\n>>>>>>> Stashed changes\n");
        if (!remoteChanged) fixture.target.lastSync.commit = run(verify, ["rev-parse", "HEAD"]);
        fs.writeFileSync(note, "clean repaired\n");
        if (remoteChanged) {
          await requireAbsenceReview(fixture, ["notes/Repair.md"]);
          assert.strictEqual(fs.readFileSync(note, "utf8"), "clean repaired\n");
        } else {
          const result = await syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
          assert(result.changed);
          run(verify, ["pull", "--ff-only"]);
          assert.strictEqual(fs.readFileSync(path.join(verify, "notes/Repair.md"), "utf8"), "clean repaired\n");
          rememberSync(fixture.target, result);
          assert.strictEqual((await syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store)).changed, false);
        }
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
  for (const stage of ["working-tree", "staged", "committed", "parent-repository"]) {
    await scenario(`Git-backed ${stage} deletion propagates and stays deleted`, async () => {
      const fixture = createFixture(`git-delete-${stage}`);
      try {
        await initialize(fixture);
        const repository = stage === "parent-repository" ? fixture.root : fixture.store;
        trackLocalFiles(fixture, repository);
        removeLocalOne(fixture);
        if (stage === "staged" || stage === "committed") run(repository, ["add", "-u"]);
        if (stage === "committed") run(repository, ["commit", "-m", "delete local One"]);
        const result = await syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
        assert.strictEqual(result.resolutionReport.rules["local-only"], 1);
        assert(result.acknowledgedDeletions.some(item => item.itemId === "Shared/One"));
        rememberSync(fixture.target, result);
        const verify = cloneRemote(fixture);
        assert.strictEqual(fs.existsSync(path.join(verify, "skills", "Shared", "One.md")), false);
        assert(JSON.parse(fs.readFileSync(path.join(verify, ".pkm-github-sync.json"))).deletions.some(item => item.itemId === "Shared/One"));
        const second = await syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
        assert.strictEqual(second.changed, false, run(fixture.root, ["--git-dir", fixture.remote, "diff", result.commit, second.commit]));
        assert.strictEqual(fs.existsSync(path.join(fixture.skills, "One.md")), false, "deleted file must not resurrect on the next sync");
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }

  for (const source of ["HEAD", "index"]) {
    await scenario(`different ${source} content is not deletion evidence for the sync baseline`, async () => {
      const fixture = createFixture(`different-${source}`);
      try {
        await initialize(fixture);
        trackLocalFiles(fixture);
        fs.writeFileSync(path.join(fixture.skills, "One.md"), skill("One", "unsynchronized local change"));
        run(fixture.store, ["add", "-A"]);
        if (source === "HEAD") run(fixture.store, ["commit", "-m", "unsynchronized edit"]);
        removeLocalOne(fixture);
        await requireAbsenceReview(fixture, ["skills/Shared/One.md"]);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }

  await scenario("Git deletion versus remote modification still requires review", async () => {
    const fixture = createFixture("git-delete-remote-edit");
    try {
      await initialize(fixture);
      trackLocalFiles(fixture);
      removeLocalOne(fixture);
      const verify = cloneRemote(fixture);
      commitRemoteFile(verify, "skills/Shared/One.md", skill("One", "remote edit"));
      await requireAbsenceReview(fixture, ["skills/Shared/One.md"]);
      assert.strictEqual(fs.existsSync(path.join(fixture.skills, "One.md")), false);
      run(verify, ["pull", "--ff-only"]);
      assert.strictEqual(fs.readFileSync(path.join(verify, "skills", "Shared", "One.md"), "utf8"), skill("One", "remote edit"));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("skip-worktree absence is not mistaken for a local deletion", async () => {
    const fixture = createFixture("git-sparse-absence");
    try {
      await initialize(fixture);
      trackLocalFiles(fixture);
      run(fixture.store, ["update-index", "--skip-worktree", "skills/Shared/One.md"]);
      removeLocalOne(fixture);
      await requireAbsenceReview(fixture, ["skills/Shared/One.md"]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("Git-backed rename keeps the moved content without restoring the old path", async () => {
    const fixture = createFixture("git-rename");
    try {
      await initialize(fixture);
      trackLocalFiles(fixture);
      run(fixture.store, ["mv", "skills/Shared/One.md", "skills/Shared/Moved.md"]);
      fixture.catalog.skills = fixture.catalog.skills.filter(item => item.id !== "Shared/One");
      fixture.catalog.skills.push({
        id: "Shared/Moved", label: "Moved", cat: "Shared", isPrivate: false,
        source: path.join(fixture.skills, "Moved.md"), destination: "skills/Shared/Moved.md",
      });
      const result = await syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
      rememberSync(fixture.target, result);
      const verify = cloneRemote(fixture);
      assert.strictEqual(fs.existsSync(path.join(verify, "skills/Shared/One.md")), false);
      assert.strictEqual(fs.readFileSync(path.join(verify, "skills/Shared/Moved.md"), "utf8"), skill("One", "one v1"));
      const second = await syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
      assert.strictEqual(second.changed, false);
      assert.strictEqual(fs.existsSync(path.join(fixture.skills, "One.md")), false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("a file restored during sync cancels Git-backed deletion before push", async () => {
    const fixture = createFixture("git-delete-race");
    try {
      await initialize(fixture);
      trackLocalFiles(fixture);
      removeLocalOne(fixture);
      const oldCommit = fixture.target.lastSync.commit;
      await assert.rejects(() => syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store,
        phase => {
          if (phase === "commit") fs.writeFileSync(path.join(fixture.skills, "One.md"), skill("One", "restored while syncing"));
        }), /Git deletion evidence changed/);
      assert.strictEqual(run(fixture.root, ["--git-dir", fixture.remote, "rev-parse", "main"]), oldCommit);
      assert.strictEqual(fs.readFileSync(path.join(fixture.skills, "One.md"), "utf8"), skill("One", "restored while syncing"));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  for (const tracked of [false, true]) {
    await scenario(`ignore rules prevent resurrection of ${tracked ? "tracked" : "untracked"} remote files`, async () => {
      const fixture = createFixture(`ignore-remote-${tracked}`);
      try {
        await initialize(fixture);
        if (tracked) trackLocalFiles(fixture);
        fs.writeFileSync(path.join(fixture.store, ".gitignore"), "/skills/Shared/One.md\n");
        removeLocalOne(fixture);
        const result = await syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
        assert.strictEqual(result.changed, false, "ignore is not permission to delete the remote copy");
        assert.strictEqual(fs.existsSync(path.join(fixture.skills, "One.md")), false);
        const verify = cloneRemote(fixture);
        assert.strictEqual(fs.readFileSync(path.join(verify, "skills", "Shared", "One.md"), "utf8"), skill("One", "one v1"));
        const preview = await previewGitHubSyncTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
        assert.strictEqual(preview.remoteOnly, 0);
        await assert.rejects(() => restoreGitHubRemoteFiles(fixture.target, fixture.checkoutRoot, fixture.store,
          result.commit, ["skills/Shared/One.md"], true), /ignore rules exclude/);
        assert.strictEqual(fs.existsSync(path.join(fixture.skills, "One.md")), false);
        const second = await syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
        assert.strictEqual(second.changed, false);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }

  await scenario("nested ignore and negation filter bundle uploads and fingerprint workers", async () => {
    const fixture = createFixture("ignore-bundle");
    try {
      const bundle = path.join(fixture.skills, "Bundle");
      fs.mkdirSync(bundle);
      fs.writeFileSync(path.join(bundle, "SKILL.md"), skill("Bundle", "bundle"));
      fs.writeFileSync(path.join(bundle, "scratch.tmp"), skill("Scratch", "temporary output"));
      fs.writeFileSync(path.join(bundle, "keep.tmp"), skill("Keep", "explicitly included"));
      fs.writeFileSync(path.join(fixture.skills, ".gitignore"), "Bundle/*.tmp\n!Bundle/keep.tmp\n");
      fixture.catalog.skills.push({
        id: "Shared/Bundle", label: "Bundle", cat: "Shared", isPrivate: false,
        source: bundle, destination: "skills/Shared/Bundle",
      });
      trackLocalFiles(fixture);
      await initialize(fixture);
      const verify = cloneRemote(fixture);
      assert.strictEqual(fs.existsSync(path.join(verify, "skills/Shared/Bundle/scratch.tmp")), false);
      assert.strictEqual(fs.readFileSync(path.join(verify, "skills/Shared/Bundle/keep.tmp"), "utf8"), skill("Keep", "explicitly included"));
      const state = await githubSyncFingerprintInWorker(fixture.target, fixture.catalog, fixture.store);
      assert.strictEqual(state.files.skills["skills/Shared/Bundle/scratch.tmp"], undefined);
      assert(state.files.skills["skills/Shared/Bundle/keep.tmp"]);
      assert.deepStrictEqual(state.fingerprints, fixture.target.lastSync.fingerprints);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("ignoring an existing bundle member preserves its remote bytes while syncing other members", async () => {
    const fixture = createFixture("ignore-existing-member");
    try {
      const bundle = path.join(fixture.skills, "Bundle");
      fs.mkdirSync(bundle);
      fs.writeFileSync(path.join(bundle, "SKILL.md"), skill("Bundle", "bundle"));
      fs.writeFileSync(path.join(bundle, "scratch.tmp"), skill("Scratch", "old temporary output"));
      fixture.catalog.skills.push({
        id: "Shared/Bundle", label: "Bundle", cat: "Shared", isPrivate: false,
        source: bundle, destination: "skills/Shared/Bundle",
      });
      await initialize(fixture);
      fs.writeFileSync(path.join(fixture.store, ".gitignore"), "**/scratch.tmp\n");
      fs.rmSync(path.join(bundle, "scratch.tmp"));
      fs.writeFileSync(path.join(bundle, "SKILL.md"), skill("Bundle", "updated bundle"));
      const result = await syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
      rememberSync(fixture.target, result);
      const verify = cloneRemote(fixture);
      assert.strictEqual(fs.readFileSync(path.join(verify, "skills/Shared/Bundle/scratch.tmp"), "utf8"), skill("Scratch", "old temporary output"));
      assert.strictEqual(fs.readFileSync(path.join(verify, "skills/Shared/Bundle/SKILL.md"), "utf8"), skill("Bundle", "updated bundle"));
      assert.strictEqual(fs.existsSync(path.join(bundle, "scratch.tmp")), false);
      const second = await syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
      assert.strictEqual(second.changed, false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("local absence without a tombstone requires review before explicit restore", async () => {
    const fixture = createFixture("local-delete");
    try {
      await initialize(fixture);
      fs.rmSync(path.join(fixture.skills, "One.md"));
      fixture.catalog.skills = fixture.catalog.skills.filter(item => item.id !== "Shared/One");
      await requireAbsenceReview(fixture, ["skills/Shared/One.md"]);
      assert.strictEqual(fs.existsSync(path.join(fixture.skills, "One.md")), false);
      await restoreGitHubRemoteFiles(fixture.target, fixture.checkoutRoot, fixture.store, fixture.target.lastSync.commit, ["skills/Shared/One.md"], true);
      assert.strictEqual(fs.readFileSync(path.join(fixture.skills, "One.md"), "utf8"), skill("One", "one v1"));
      const verify = cloneRemote(fixture);
      assert.strictEqual(fs.readFileSync(path.join(verify, "skills", "Shared", "One.md"), "utf8"), skill("One", "one v1"));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("remote-only content change wins without a conflict", async () => {
    const fixture = createFixture("remote-only-edit");
    try {
      await initialize(fixture);
      const original = fs.readFileSync(path.join(fixture.skills, "One.md"));
      const remoteContent = skill("One", "one changed on GitHub");
      const verify = cloneRemote(fixture);
      commitRemoteFile(verify, "skills/Shared/One.md", remoteContent);
      assert.notStrictEqual(digest(original), digest(remoteContent));
      const remoteCommit = run(fixture.root, ["--git-dir", fixture.remote, "rev-parse", "main"]);
      const progress = [];
      const result = await syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store,
        (phase, detail) => progress.push({ phase, detail }));
      assert.strictEqual(result.commit, remoteCommit, "a remote-only edit should not create another commit");
      assert.strictEqual(result.resolutionReport.rules["remote-only"], 1);
      assert.strictEqual(result.resolutionReport.localFiles, 2);
      assert.strictEqual(result.resolutionReport.remoteFiles, 2);
      assert(progress.some(item => item.phase === "fetch" && /Fetched origin\/main; validating Remote files \(\d+s elapsed\)/.test(item.detail)));
      assert(progress.some(item => item.phase === "fetch" && /Validated 2\/2 Remote files \(\d+s elapsed\)/.test(item.detail)));
      assert.strictEqual(fs.readFileSync(path.join(fixture.skills, "One.md"), "utf8"), remoteContent);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("shared file changing catalog owner does not turn a remote edit into a conflict", async () => {
    const fixture = createFixture("shared-owner");
    try {
      await initialize(fixture);
      const verify = cloneRemote(fixture);
      const manifestPath = path.join(verify, ".pkm-github-sync.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const shared = manifest.files.find(file => file.path === "skills/Shared/One.md");
      shared.itemId = "Shared/Two";
      shared.member = "skills/Shared/One.md";
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      run(verify, ["add", ".pkm-github-sync.json"]);
      run(verify, ["commit", "-m", "historical shared owner"]);
      run(verify, ["push"]);
      fixture.target.lastSync.commit = run(fixture.root, ["--git-dir", fixture.remote, "rev-parse", "main"]);
      const remoteContent = skill("One", "updated on GitHub");
      commitRemoteFile(verify, "skills/Shared/One.md", remoteContent);
      const result = await syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
      assert.strictEqual(fs.readFileSync(path.join(fixture.skills, "One.md"), "utf8"), remoteContent);
      assert.strictEqual(result.resolutionReport.rules["human-required"] || 0, 0);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("same-byte shared file reassigned between Base and Remote is not deleted locally", async () => {
    const fixture = createFixture("shared-owner-reassigned");
    try {
      const notes = path.join(fixture.store, "notes");
      const imageRelative = "notes/Images/comparison_ceiling.png";
      const imagePath = path.join(notes, "Images", "comparison_ceiling.png");
      fs.mkdirSync(path.dirname(imagePath), { recursive: true });
      fs.writeFileSync(path.join(notes, "One.md"), "# One\n");
      fs.writeFileSync(path.join(notes, "Two.md"), "# Two\n");
      fs.writeFileSync(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
      fixture.catalog.notes = [
        { id: "One", label: "One", cat: "", isPrivate: false, source: path.join(notes, "One.md"), destination: "notes/One.md",
          dependencies: [{ source: imagePath, destination: imageRelative }] },
        { id: "Two", label: "Two", cat: "", isPrivate: false, source: path.join(notes, "Two.md"), destination: "notes/Two.md" },
      ];
      await initialize(fixture);
      const original = fs.readFileSync(imagePath);
      const verify = cloneRemote(fixture);
      const manifestPath = path.join(verify, ".pkm-github-sync.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const shared = manifest.files.find(file => file.path === imageRelative);
      shared.itemId = "Two";
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      run(verify, ["add", ".pkm-github-sync.json"]);
      run(verify, ["commit", "-m", "reassign shared file without changing bytes"]);
      run(verify, ["push"]);
      const result = await syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
      assert(fs.readFileSync(imagePath).equals(original));
      assert.strictEqual(result.resolutionReport.rules["human-required"] || 0, 0);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("matching content with different local metadata keeps the remote version", async () => {
    const fixture = createFixture("matching-content-remote");
    try {
      await initialize(fixture);
      const sharedContent = skill("One", "same new content on both machines");
      const verify = cloneRemote(fixture);
      commitRemoteFile(verify, "skills/Shared/One.md", sharedContent);
      const remoteCommit = run(fixture.root, ["--git-dir", fixture.remote, "rev-parse", "main"]);
      fs.writeFileSync(path.join(fixture.skills, "One.md"), sharedContent);
      fixture.catalog.skills[0].cat = "LocalMetadataOnly";
      const result = await syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
      assert.strictEqual(result.commit, remoteCommit, "matching content must keep the remote commit and its metadata");
      assert.strictEqual(result.resolutionReport.rules["identical-convergence"], 1);
      assert.strictEqual(fs.readFileSync(path.join(fixture.skills, "One.md"), "utf8"), sharedContent);
      const remoteManifest = JSON.parse(run(fixture.root, ["--git-dir", fixture.remote, "show", "main:.pkm-github-sync.json"]));
      assert.strictEqual(remoteManifest.files.find(file => file.path === "skills/Shared/One.md").category, "Shared");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("different edits on both sides retain local and remote choices", async () => {
    const fixture = createFixture("two-sided-edit");
    try {
      await initialize(fixture);
      const remoteContent = skill("One", "remote rewrote this line");
      const localContent = skill("One", "local rewrote this line");
      const verify = cloneRemote(fixture);
      commitRemoteFile(verify, "skills/Shared/One.md", remoteContent);
      const localPath = path.join(fixture.skills, "One.md");
      fs.writeFileSync(localPath, localContent);
      for (const year of [2000, 2040]) {
        fs.utimesSync(localPath, new Date(`${year}-01-01`), new Date(`${year}-01-01`));
        await assert.rejects(
          () => syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store),
          error => {
            assert(error instanceof GitHubSyncConflictError);
            assert.strictEqual(error.resolutionReport.rules["human-required"], 1);
            const conflict = error.conflicts.find(file => file.path === "skills/Shared/One.md");
            assert(conflict?.local.equals(Buffer.from(localContent)));
            assert(conflict?.remote.equals(Buffer.from(remoteContent)));
            return true;
          },
          "overlapping edits must preserve both candidates regardless of local file time",
        );
      }
      assert.strictEqual(fs.readFileSync(path.join(fixture.skills, "One.md"), "utf8"), localContent);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("sparse local state requires review before selected remote files are restored", async () => {
    const fixture = createFixture("sparse-restore");
    try {
      await initialize(fixture);
      fs.rmSync(path.join(fixture.skills, "One.md"));
      fs.rmSync(path.join(fixture.skills, "Two.md"));
      fixture.catalog.skills = [];
      await requireAbsenceReview(fixture, ["skills/Shared/One.md", "skills/Shared/Two.md"]);
      assert.strictEqual(fs.existsSync(path.join(fixture.skills, "One.md")), false);
      assert.strictEqual(fs.existsSync(path.join(fixture.skills, "Two.md")), false);
      await restoreGitHubRemoteFiles(fixture.target, fixture.checkoutRoot, fixture.store, fixture.target.lastSync.commit, ["skills/Shared/One.md", "skills/Shared/Two.md"], true);
      assert.strictEqual(fs.readFileSync(path.join(fixture.skills, "One.md"), "utf8"), skill("One", "one v1"));
      assert.strictEqual(fs.readFileSync(path.join(fixture.skills, "Two.md"), "utf8"), skill("Two", "two v1"));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("canonical remote schema migrates a legacy local sync base before reconciliation", async () => {
    const fixture = createFixture("local-schema-migration");
    try {
      await initialize(fixture);
      const verify = cloneRemote(fixture);
      const manifestPath = path.join(verify, ".pkm-github-sync.json");
      const canonicalManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const legacyManifest = {
        schema: 2,
        files: canonicalManifest.files.map(({ member, ...file }) => file),
      };
      fs.writeFileSync(manifestPath, JSON.stringify(legacyManifest, null, 2) + "\n");
      run(verify, ["add", ".pkm-github-sync.json"]);
      run(verify, ["commit", "-m", "legacy local sync base"]);
      run(verify, ["push"]);
      fixture.target.lastSync.commit = run(verify, ["rev-parse", "HEAD"]);

      fs.writeFileSync(manifestPath, JSON.stringify(canonicalManifest, null, 2) + "\n");
      run(verify, ["add", ".pkm-github-sync.json"]);
      run(verify, ["commit", "-m", "remote publication schema migration"]);
      run(verify, ["push"]);

      fs.rmSync(path.join(fixture.skills, "One.md"));
      fs.rmSync(path.join(fixture.skills, "Two.md"));
      fixture.catalog.skills = [];
      fixture.target.pendingDeletions = [
        { type: "skills", itemId: "Shared/One", deletedAt: new Date().toISOString() },
        { type: "skills", itemId: "Shared/Two", deletedAt: new Date().toISOString() },
      ];
      await requireAbsenceReview(fixture, ["skills/Shared/One.md", "skills/Shared/Two.md"]);
      assert.strictEqual(fs.existsSync(path.join(fixture.skills, "One.md")), false);
      assert.strictEqual(fs.existsSync(path.join(fixture.skills, "Two.md")), false);
      assert.deepStrictEqual(
        fixture.target.pendingDeletions.map(item => item.itemId).sort(),
        ["Shared/One", "Shared/Two"],
        "a blocked migration must not acknowledge deletion evidence or silently restore content",
      );
      await restoreGitHubRemoteFiles(fixture.target, fixture.checkoutRoot, fixture.store, run(verify, ["rev-parse", "HEAD"]), ["skills/Shared/One.md", "skills/Shared/Two.md"], true);
      assert.strictEqual(fs.readFileSync(path.join(fixture.skills, "One.md"), "utf8"), skill("One", "one v1"));
      assert.strictEqual(fs.readFileSync(path.join(fixture.skills, "Two.md"), "utf8"), skill("Two", "two v1"));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("managed files on disk survive temporary catalog omission", async () => {
    const fixture = createFixture("catalog-omission");
    try {
      await initialize(fixture);
      fixture.catalog.skills = fixture.catalog.skills.filter(item => item.id !== "Shared/One");
      const result = await syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
      assert.strictEqual(result.changed, false);
      assert.strictEqual(
        fs.readFileSync(path.join(fixture.skills, "One.md"), "utf8"),
        skill("One", "one v1"),
        "an indexed GitHub path that still exists on disk must not be mistaken for a local deletion"
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("remote absence without a tombstone requires review and preserves local content", async () => {
    const fixture = createFixture("remote-delete");
    try {
      await initialize(fixture);
      const verify = cloneRemote(fixture);
      const manifestPath = path.join(verify, ".pkm-github-sync.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.files = manifest.files.filter(file => file.path !== "skills/Shared/One.md");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      fs.rmSync(path.join(verify, "skills", "Shared", "One.md"));
      run(verify, ["add", "-A"]);
      run(verify, ["commit", "-m", "remote deletion"]);
      run(verify, ["push"]);
      const remoteCommit = run(verify, ["rev-parse", "HEAD"]);
      await requireAbsenceReview(fixture, ["skills/Shared/One.md"]);
      assert.strictEqual(fs.readFileSync(path.join(fixture.skills, "One.md"), "utf8"), skill("One", "one v1"));
      run(verify, ["pull", "--ff-only"]);
      assert.strictEqual(run(verify, ["rev-parse", "HEAD"]), remoteCommit);
      assert.strictEqual(fs.existsSync(path.join(verify, "skills", "Shared", "One.md")), false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("both-sided absence without tombstones converges without inventing a deletion conflict", async () => {
    const fixture = createFixture("both-delete");
    try {
      await initialize(fixture);
      const verify = cloneRemote(fixture);
      const manifestPath = path.join(verify, ".pkm-github-sync.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.files = manifest.files.filter(file => file.path !== "skills/Shared/One.md");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      fs.rmSync(path.join(verify, "skills", "Shared", "One.md"));
      run(verify, ["add", "-A"]);
      run(verify, ["commit", "-m", "remote deletion"]);
      run(verify, ["push"]);
      fs.rmSync(path.join(fixture.skills, "One.md"));
      fixture.catalog.skills = fixture.catalog.skills.filter(item => item.id !== "Shared/One");
      const result = await syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
      assert.strictEqual(result.changed, false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("manifest omission cannot masquerade as remote deletion", async () => {
    const fixture = createFixture("manifest-omission");
    try {
      await initialize(fixture);
      const verify = cloneRemote(fixture);
      const manifestPath = path.join(verify, ".pkm-github-sync.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.files = manifest.files.filter(file => file.path !== "skills/Shared/One.md");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      run(verify, ["add", ".pkm-github-sync.json"]);
      run(verify, ["commit", "-m", "omit tracked managed file"]);
      run(verify, ["push"]);
      await assert.rejects(
        () => syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store),
        /missing from the manifest/i,
      );
      assert.strictEqual(fs.readFileSync(path.join(fixture.skills, "One.md"), "utf8"), skill("One", "one v1"));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("an edit made during sync is never overwritten by a pull", async () => {
    const fixture = createFixture("mid-sync-edit");
    try {
      await initialize(fixture);
      const verify = cloneRemote(fixture);
      commitRemoteFile(verify, "skills/Shared/Two.md", skill("Two", "remote v2"));
      fs.writeFileSync(path.join(fixture.skills, "One.md"), skill("One", "local outgoing v2"));

      const checkout = path.join(fixture.checkoutRoot, fixture.target.id, "repository");
      const pushStarted = path.join(fixture.root, "push-started");
      const releasePush = path.join(fixture.root, "release-push");
      const hook = path.join(checkout, ".git", "hooks", "pre-push");
      fs.writeFileSync(hook, `#!/bin/sh\n: > "${pushStarted}"\nwhile [ ! -f "${releasePush}" ]; do sleep 0.02; done\n`, { mode: 0o755 });
      const pending = syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
      await waitForFile(pushStarted);
      fs.writeFileSync(path.join(fixture.skills, "Two.md"), skill("Two", "local edit during sync"));
      fs.writeFileSync(releasePush, "continue\n");
      await assert.rejects(pending, error =>
        error instanceof GitHubSyncConflictError
        && error.conflicts.length === 1
        && error.conflicts[0].path === "skills/Shared/Two.md"
        && error.conflicts[0].local.equals(Buffer.from(skill("Two", "local edit during sync")))
        && error.conflicts[0].remote.equals(Buffer.from(skill("Two", "remote v2")))
        && error.remoteCommit === run(checkout, ["rev-parse", "HEAD"]),
      );
      assert.strictEqual(fs.readFileSync(path.join(fixture.skills, "Two.md"), "utf8"), skill("Two", "local edit during sync"));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("a PNG edited during sync provides both choices instead of a bare failure", async () => {
    const fixture = createFixture("mid-sync-image");
    try {
      const imagePath = path.join(fixture.store, "notes", "Images", "diagram.png");
      const imageRelative = "notes/Images/diagram.png";
      const original = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
      const remote = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
      const local = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 2]);
      fs.mkdirSync(path.dirname(imagePath), { recursive: true });
      fs.writeFileSync(imagePath, original);
      fixture.catalog.notes = [{
        id: "Images/diagram", label: "diagram", cat: "Images", isPrivate: false,
        source: imagePath, destination: imageRelative,
      }];
      await initialize(fixture);
      const verify = cloneRemote(fixture);
      commitRemoteFile(verify, imageRelative, remote);
      fs.writeFileSync(path.join(fixture.skills, "One.md"), skill("One", "outgoing update"));
      const checkout = path.join(fixture.checkoutRoot, fixture.target.id, "repository");
      const pushStarted = path.join(fixture.root, "push-started");
      const releasePush = path.join(fixture.root, "release-push");
      fs.writeFileSync(path.join(checkout, ".git", "hooks", "pre-push"),
        `#!/bin/sh\n: > "${pushStarted}"\nwhile [ ! -f "${releasePush}" ]; do sleep 0.02; done\n`, { mode: 0o755 });
      const pending = syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
      await waitForFile(pushStarted);
      fs.writeFileSync(imagePath, local);
      fs.writeFileSync(releasePush, "continue\n");
      await assert.rejects(pending, error => {
        assert(error instanceof GitHubSyncConflictError);
        const conflict = error.conflicts.find(file => file.path === imageRelative);
        assert(conflict?.local.equals(local));
        assert(conflict?.remote.equals(remote));
        return true;
      });
      assert(fs.readFileSync(imagePath).equals(local), "the local PNG cannot be overwritten by the failed sync");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("an identical edit made during sync is already resolved", async () => {
    const fixture = createFixture("mid-sync-converged");
    try {
      await initialize(fixture);
      const verify = cloneRemote(fixture);
      commitRemoteFile(verify, "skills/Shared/Two.md", skill("Two", "remote v2"));
      const checkout = path.join(fixture.checkoutRoot, fixture.target.id, "repository");
      const pushStarted = path.join(fixture.root, "push-started");
      const releasePush = path.join(fixture.root, "release-push");
      fs.writeFileSync(path.join(checkout, ".git", "hooks", "pre-push"),
        `#!/bin/sh\n: > "${pushStarted}"\nwhile [ ! -f "${releasePush}" ]; do sleep 0.02; done\n`, { mode: 0o755 });
      const pending = syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
      await waitForFile(pushStarted);
      fs.writeFileSync(path.join(fixture.skills, "Two.md"), skill("Two", "remote v2"));
      fs.writeFileSync(releasePush, "continue\n");
      await pending;
      assert.strictEqual(fs.readFileSync(path.join(fixture.skills, "Two.md"), "utf8"), skill("Two", "remote v2"));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("multi-file restore rolls back earlier overwrites", async () => {
    const fixture = createFixture("restore-rollback");
    try {
      await initialize(fixture);
      const restoreRoot = path.join(fixture.root, "restore");
      fs.mkdirSync(path.join(restoreRoot, "skills", "Shared"), { recursive: true });
      fs.writeFileSync(path.join(restoreRoot, "skills", "Shared", "One.md"), skill("One", "local restore one"));
      fs.writeFileSync(path.join(restoreRoot, "skills", "Shared", "Two.md"), skill("Two", "local restore two"));
      const originalRename = fs.renameSync;
      fs.renameSync = (source, destination) => {
        if (destination.endsWith(path.join("skills", "Shared", "Two.md"))) throw new Error("injected restore failure");
        return originalRename(source, destination);
      };
      try {
        await assert.rejects(
          () => restoreGitHubRemoteFiles(
            fixture.target,
            fixture.checkoutRoot,
            restoreRoot,
            fixture.target.lastSync.commit,
            ["skills/Shared/One.md", "skills/Shared/Two.md"],
            true,
          ),
          /injected restore failure/,
        );
      } finally {
        fs.renameSync = originalRename;
      }
      assert.strictEqual(fs.readFileSync(path.join(restoreRoot, "skills", "Shared", "One.md"), "utf8"), skill("One", "local restore one"));
      assert.strictEqual(fs.readFileSync(path.join(restoreRoot, "skills", "Shared", "Two.md"), "utf8"), skill("Two", "local restore two"));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("metadata-only privacy changes are synchronized", async () => {
    const fixture = createFixture("metadata-change");
    try {
      fixture.target.selection.private.skills = { items: [], folders: [""] };
      await initialize(fixture);
      fixture.catalog.skills.find(item => item.id === "Shared/One").isPrivate = true;
      rememberSync(fixture.target, await syncGitHubTarget(
        fixture.target,
        fixture.catalog,
        fixture.checkoutRoot,
        undefined,
        fixture.store,
      ));
      const verify = cloneRemote(fixture);
      const manifest = JSON.parse(fs.readFileSync(path.join(verify, ".pkm-github-sync.json"), "utf8"));
      assert.strictEqual(manifest.files.find(file => file.path === "skills/Shared/One.md").privacy, "private");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("equivalent Knowledge Root aliases retain their binding", async () => {
    const fixture = createFixture("root-alias");
    try {
      await initialize(fixture);
      const alias = path.join(fixture.root, "store-alias");
      fs.symlinkSync(fixture.store, alias, process.platform === "win32" ? "junction" : "dir");
      fixture.target.lastSync.storeRoot = alias;
      const result = await syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
      assert.strictEqual(result.changed, false, "a physical alias must not require reinitializing the target");
      if (process.platform === "win32") {
        fixture.target.lastSync.storeRoot = fixture.store.toUpperCase().replace(/\\/g, "/") + "/";
        const windowsResult = await syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store);
        assert.strictEqual(windowsResult.changed, false, "native Windows case/slash variants preserve the existing baseline");
      }
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("a Knowledge Root binding mismatch fails closed", async () => {
    const fixture = createFixture("root-binding");
    try {
      await initialize(fixture);
      fixture.target.lastSync.storeRoot = path.join(fixture.root, "different-store");
      await assert.rejects(
        () => syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store),
        /Knowledge Root changed/i,
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  if (failures.length) {
    throw new AggregateError(
      failures.map(failure => failure.error),
      `${failures.length} file-safety scenario${failures.length === 1 ? "" : "s"} failed: ${failures.map(failure => failure.name).join("; ")}`,
    );
  }
  console.log("github-sync file-safety tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
