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
  restoreGitHubRemoteFiles,
  syncGitHubTarget,
} = require("../dist/github-sync.js");

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
  await scenario("local absence is not an approved remote deletion", async () => {
    const fixture = createFixture("local-delete");
    try {
      await initialize(fixture);
      fs.rmSync(path.join(fixture.skills, "One.md"));
      fixture.catalog.skills = fixture.catalog.skills.filter(item => item.id !== "Shared/One");
      await assert.rejects(
        () => syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store),
        error => error instanceof GitHubSyncConflictError
          && error.conflicts.some(conflict => conflict.path === "skills/Shared/One.md" && !conflict.local && !!conflict.remote),
      );
      const verify = cloneRemote(fixture);
      assert.strictEqual(fs.readFileSync(path.join(verify, "skills", "Shared", "One.md"), "utf8"), skill("One", "one v1"));
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

  await scenario("remote absence is not an approved local deletion", async () => {
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
      await assert.rejects(
        () => syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store),
        error => error instanceof GitHubSyncConflictError
          && error.conflicts.some(conflict => conflict.path === "skills/Shared/One.md" && !!conflict.local && !conflict.remote),
      );
      assert.strictEqual(fs.readFileSync(path.join(fixture.skills, "One.md"), "utf8"), skill("One", "one v1"));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await scenario("both-sided absence retains the recoverable base candidate", async () => {
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
      await assert.rejects(
        () => syncGitHubTarget(fixture.target, fixture.catalog, fixture.checkoutRoot, undefined, fixture.store),
        error => error instanceof GitHubSyncConflictError
          && error.conflicts.some(conflict => conflict.path === "skills/Shared/One.md" && !!conflict.base && !conflict.local && !conflict.remote),
      );
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
      await assert.rejects(pending, /changed during synchronization/i);
      assert.strictEqual(fs.readFileSync(path.join(fixture.skills, "Two.md"), "utf8"), skill("Two", "local edit during sync"));
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
