#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  fetchGitHubRemoteSnapshot,
  GITHUB_SYNC_CONTENT_TYPES,
  normalizeGitHubSyncTarget,
  readGitHubRemoteFile,
  restoreGitHubRemoteFiles,
  syncGitHubTarget
} = require("../dist/github-sync.js");

const run = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-github-sync-"));
  try {
    const remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    const sources = path.join(root, "sources");
    fs.mkdirSync(seed);
    run(root, ["init", "--bare", remote]);
    run(seed, ["init"]);
    run(seed, ["config", "user.name", "Test"]);
    run(seed, ["config", "user.email", "test@example.com"]);
    fs.writeFileSync(path.join(seed, "README.md"), "keep me\n");
    run(seed, ["add", "README.md"]);
    run(seed, ["commit", "-m", "seed"]);
    run(seed, ["branch", "-M", "main"]);
    run(seed, ["remote", "add", "origin", remote]);
    run(seed, ["push", "-u", "origin", "main"]);
    run(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);

    fs.mkdirSync(path.join(sources, "skills"), { recursive: true });
    fs.mkdirSync(path.join(sources, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(sources, "skills", "public.md"), "public\n");
    fs.writeFileSync(path.join(sources, "skills", "private.md"), "private\n");
    fs.writeFileSync(path.join(sources, "scripts", "run.sh"), "echo ready\n");
    const catalog = Object.fromEntries(GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
    catalog.skills = [
      { id: "Public/One", label: "One", cat: "Public", isPrivate: false, source: path.join(sources, "skills", "public.md"), destination: "skills/Public/One.md" },
      { id: "Private/Two", label: "Two", cat: "Private", isPrivate: true, source: path.join(sources, "skills", "private.md"), destination: "skills/Private/Two.md" }
    ];
    catalog.scripts = [
      { id: "run.sh", label: "run.sh", cat: "", isPrivate: false, source: path.join(sources, "scripts", "run.sh"), destination: "scripts/run.sh" }
    ];
    const target = normalizeGitHubSyncTarget({ name: "Test", repository: remote, branch: "main" }, () => "target-1");
    target.selection.private.skills = { items: [], folders: [""] };
    const checkoutRoot = path.join(root, "checkouts");
    const first = await syncGitHubTarget(target, catalog, checkoutRoot);
    assert.strictEqual(first.changed, true);
    const verify = path.join(root, "verify");
    run(root, ["clone", "--branch", "main", remote, verify]);
    run(verify, ["config", "user.name", "Remote Test"]);
    run(verify, ["config", "user.email", "remote@example.com"]);
    assert.strictEqual(fs.readFileSync(path.join(verify, "README.md"), "utf8"), "keep me\n");
    assert.strictEqual(fs.readFileSync(path.join(verify, "skills", "Public", "One.md"), "utf8"), "public\n");
    assert.strictEqual(fs.readFileSync(path.join(verify, "skills", "Private", "Two.md"), "utf8"), "private\n");
    assert.strictEqual(fs.readFileSync(path.join(verify, "scripts", "run.sh"), "utf8"), "echo ready\n");

    const second = await syncGitHubTarget(target, catalog, checkoutRoot);
    assert.strictEqual(second.changed, false);
    assert.strictEqual(second.commit, first.commit);

    const restoreRoot = path.join(root, "restored-store");
    const snapshot = await fetchGitHubRemoteSnapshot(target, checkoutRoot);
    assert.strictEqual(snapshot.commit, first.commit);
    assert(snapshot.files.some(file => file.path === "skills/Public/One.md" && file.type === "skills"));
    assert.strictEqual(fs.existsSync(restoreRoot), false, "browsing remote content must not create or modify the local store");
    assert.strictEqual((await readGitHubRemoteFile(target, checkoutRoot, snapshot.commit, "skills/Public/One.md")).toString("utf8"), "public\n");
    await assert.rejects(() => readGitHubRemoteFile(target, checkoutRoot, snapshot.commit, "../outside.md"), /invalid/);

    fs.mkdirSync(path.join(restoreRoot, "skills", "Public"), { recursive: true });
    fs.writeFileSync(path.join(restoreRoot, "skills", "Public", "One.md"), "local\n");
    const conflict = await restoreGitHubRemoteFiles(target, checkoutRoot, restoreRoot, snapshot.commit, ["skills/Public/One.md"], false);
    assert.deepStrictEqual(conflict, { restored: [], conflicts: ["skills/Public/One.md"] });
    assert.strictEqual(fs.readFileSync(path.join(restoreRoot, "skills", "Public", "One.md"), "utf8"), "local\n");
    const restored = await restoreGitHubRemoteFiles(target, checkoutRoot, restoreRoot, snapshot.commit, ["skills/Public/One.md", "scripts/run.sh"], true);
    assert.deepStrictEqual(restored.restored, ["scripts/run.sh", "skills/Public/One.md"]);
    assert.strictEqual(fs.readFileSync(path.join(restoreRoot, "skills", "Public", "One.md"), "utf8"), "public\n");
    assert.strictEqual(fs.readFileSync(path.join(restoreRoot, "scripts", "run.sh"), "utf8"), "echo ready\n");
    await assert.rejects(() => restoreGitHubRemoteFiles(target, checkoutRoot, restoreRoot, snapshot.commit, ["README.md"], true), /not in the PKM manifest/);

    run(verify, ["checkout", "-b", "public-tree"]);
    fs.rmSync(path.join(verify, ".pkm-github-sync.json"));
    fs.mkdirSync(path.join(verify, "notes", "Public"), { recursive: true });
    fs.writeFileSync(path.join(verify, "notes", "Public", "Welcome.md"), "public note\n");
    fs.writeFileSync(path.join(verify, "unrelated.txt"), "ignore\n");
    run(verify, ["add", "-A"]);
    run(verify, ["commit", "-m", "public repository tree"]);
    run(verify, ["push", "-u", "origin", "public-tree"]);
    const publicTarget = normalizeGitHubSyncTarget({ name: "Public", repository: remote, branch: "public-tree" }, () => "target-public");
    await assert.rejects(() => fetchGitHubRemoteSnapshot(publicTarget, checkoutRoot), /manifest/i, "GitHub Sync remains manifest-only");
    const publicSnapshot = await fetchGitHubRemoteSnapshot(publicTarget, checkoutRoot, true);
    assert(publicSnapshot.files.some(file => file.path === "notes/Public/Welcome.md" && file.type === "notes"));
    assert(!publicSnapshot.files.some(file => file.path === "README.md" || file.path === "unrelated.txt"), "subscription discovery only exposes supported PKM roots");
    run(verify, ["checkout", "main"]);

    const fakeBin = path.join(root, "fake-bin");
    const fakeSsh = path.join(fakeBin, "ssh");
    const fakeSshLog = path.join(root, "fake-ssh.log");
    const identityFile = path.join(root, "id_github_emu");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(identityFile, "test identity\n");
    fs.writeFileSync(fakeSsh, "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$PKM_FAKE_SSH_LOG\"\nfor argument do command=\"$argument\"; done\nexec sh -c \"$command\"\n", { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;
    process.env.PKM_FAKE_SSH_LOG = fakeSshLog;
    try {
      const authenticatedTarget = normalizeGitHubSyncTarget({
        name: "EMU",
        repository: `git@github-emu:${remote}`,
        branch: "authenticated",
        authentication: { identityFile, expectedLogin: "yuwang8_microsoft" }
      }, () => "target-authenticated");
      await syncGitHubTarget(authenticatedTarget, catalog, path.join(root, "checkouts"));
      await syncGitHubTarget(authenticatedTarget, catalog, path.join(root, "checkouts"));
      const sshCalls = fs.readFileSync(fakeSshLog, "utf8");
      assert(sshCalls.includes(identityFile), "selected identity must be passed to SSH");
      assert((sshCalls.match(/git-upload-pack/g) || []).length >= 2, "clone and fetch must use target SSH authentication");
      assert.match(sshCalls, /git-receive-pack/, "push must use target SSH authentication");
    } finally {
      process.env.PATH = previousPath;
      delete process.env.PKM_FAKE_SSH_LOG;
    }

    fs.writeFileSync(path.join(verify, "REMOTE.md"), "remote addition\n");
    run(verify, ["add", "REMOTE.md"]);
    run(verify, ["commit", "-m", "remote fast-forward"]);
    run(verify, ["push"]);
    const fastForward = await syncGitHubTarget(target, catalog, path.join(root, "checkouts"));
    assert.strictEqual(fastForward.changed, false);
    assert.strictEqual(fs.readFileSync(path.join(root, "checkouts", target.id, "repository", "REMOTE.md"), "utf8"), "remote addition\n");

    target.selection.private.skills = { items: [], folders: [] };
    const deletion = await syncGitHubTarget(target, catalog, path.join(root, "checkouts"));
    assert.strictEqual(deletion.changed, true);
    run(verify, ["pull", "--ff-only"]);
    assert.strictEqual(fs.existsSync(path.join(verify, "skills", "Private", "Two.md")), false, "deselected managed files must be removed");
    assert.strictEqual(fs.readFileSync(path.join(verify, "README.md"), "utf8"), "keep me\n", "unmanaged files must survive deletion");

    const branchTarget = normalizeGitHubSyncTarget({
      name: "Scripts branch",
      repository: remote,
      branch: "scripts-only",
      selection: {
        public: { scripts: { items: ["run.sh"], folders: [] } },
        private: {}
      }
    }, () => "target-2");
    await syncGitHubTarget(branchTarget, catalog, path.join(root, "checkouts"));
    assert(run(root, ["--git-dir", remote, "show-ref", "--verify", "refs/heads/scripts-only"]));
    assert(fs.existsSync(path.join(root, "checkouts", branchTarget.id, "repository", "scripts", "run.sh")));
    assert.notStrictEqual(
      path.join(root, "checkouts", target.id, "repository"),
      path.join(root, "checkouts", branchTarget.id, "repository"),
      "targets must have isolated checkouts"
    );

    const checkout = path.join(root, "checkouts", target.id, "repository");
    run(checkout, ["config", "user.name", "Local Test"]);
    run(checkout, ["config", "user.email", "local@example.com"]);
    fs.writeFileSync(path.join(checkout, "DIRTY.md"), "dirty\n");
    await assert.rejects(() => syncGitHubTarget(target, catalog, path.join(root, "checkouts")), /uncommitted changes/);
    fs.rmSync(path.join(checkout, "DIRTY.md"));

    fs.writeFileSync(path.join(checkout, "LOCAL.md"), "local\n");
    run(checkout, ["add", "LOCAL.md"]);
    run(checkout, ["commit", "-m", "local divergence"]);
    fs.writeFileSync(path.join(verify, "REMOTE-2.md"), "remote divergence\n");
    run(verify, ["add", "REMOTE-2.md"]);
    run(verify, ["commit", "-m", "remote divergence"]);
    run(verify, ["push"]);
    await assert.rejects(() => syncGitHubTarget(target, catalog, path.join(root, "checkouts")), /has diverged/);

    const hook = path.join(remote, "hooks", "pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const rejectedTarget = normalizeGitHubSyncTarget({ name: "Rejected", repository: remote, branch: "rejected" }, () => "target-3");
    await assert.rejects(() => syncGitHubTarget(rejectedTarget, catalog, path.join(root, "checkouts")), /git push failed/);
    assert.throws(() => run(root, ["--git-dir", remote, "show-ref", "--verify", "refs/heads/rejected"]));
    console.log("github-sync git tests passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });