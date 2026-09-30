#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const githubSyncSource = fs.readFileSync(path.join(__dirname, "..", "src", "github-sync.ts"), "utf8");
const { execFileSync } = require("child_process");
const { storeGitHubSyncConflict } = require("../dist/github-sync-conflicts.js");
const {
  deterministicTextMerge,
  fetchGitHubRemoteSnapshot,
  formatGitMergeFileFailure,
  GITHUB_SYNC_CONTENT_TYPES,
  GitHubSyncConflictError,
  normalizeGitHubSyncTarget,
  readGitHubRemoteFile,
  readGitHubRemoteFileForSubscription,
  readGitHubRemoteFilesForSubscription,
  restoreGitHubRemoteFiles,
  syncGitHubTarget
} = require("../dist/github-sync.js");

const run = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const skill = (name, body) => `---\nname: ${JSON.stringify(name)}\ndescription: \"test\"\n---\n# ${name}\n\n${body}\n`;
const separatedChanges = changes => changes.map((change, index) => [
  `## Section ${index + 1}`,
  change,
  ...Array.from({ length: 8 }, (_, contextIndex) => `unchanged ${index + 1}.${contextIndex + 1}`),
].join("\n")).join("\n\n") + "\n";
const twoConflictSkill = (first, second) => skill("Three", separatedChanges([first, second]));
const rememberSync = (target, result) => {
  target.lastSync = { at: new Date().toISOString(), commit: result.commit, fingerprints: result.fingerprints };
};

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-github-sync-"));
  try {
    const cleanMerge = await deterministicTextMerge(
      Buffer.from("first\nmiddle\nthird\n"),
      Buffer.from("local first\nmiddle\nthird\n"),
      Buffer.from("first\nmiddle\nremote third\n"),
      "skills/Test/Clean.md",
    );
    assert.strictEqual(cleanMerge.toString("utf8"), "local first\nmiddle\nremote third\n");

    for (const conflictCount of [1, 2, 3]) {
      const base = separatedChanges(Array.from({ length: conflictCount }, (_, index) => `base ${index}`));
      const local = separatedChanges(Array.from({ length: conflictCount }, (_, index) => `local ${index}`));
      const remote = separatedChanges(Array.from({ length: conflictCount }, (_, index) => `remote ${index}`));
      assert.strictEqual(
        await deterministicTextMerge(
          Buffer.from(base),
          Buffer.from(local),
          Buffer.from(remote),
          `skills/Test/${conflictCount}-conflicts.md`,
        ),
        undefined,
        `${conflictCount} merge conflict(s) must be classified as a normal unresolved merge`,
      );
    }

    const privateStdout = Buffer.from("private merged file content");
    const stdoutDiagnostic = formatGitMergeFileFailure({
      code: 129,
      stderr: Buffer.alloc(0),
      stdout: privateStdout,
      message: "fallback message",
    }, "skills/System/PKM/PKM Skills.md");
    assert.match(stdoutDiagnostic, /exit code 129/);
    assert.match(stdoutDiagnostic, new RegExp(`git produced ${privateStdout.length} bytes of stdout`));
    assert.match(stdoutDiagnostic, /skills\/System\/PKM\/PKM Skills\.md/);
    assert.doesNotMatch(stdoutDiagnostic, /private merged file content/,
      "diagnostics must identify non-empty stdout without exposing managed file content");
    assert.match(formatGitMergeFileFailure({
      code: "ENOENT",
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
      message: "spawn git ENOENT",
    }, "skills/Test/Spawn.md"), /exit code ENOENT.*spawn git ENOENT/);
    assert.match(formatGitMergeFileFailure({
      code: 255,
      stderr: Buffer.from("fatal: invalid merge-file invocation"),
      stdout: Buffer.alloc(0),
    }, "skills/Test/Fatal.md"), /exit code 255.*fatal: invalid merge-file invocation/);
    await assert.rejects(
      () => deterministicTextMerge(
        Buffer.from("base\0"),
        Buffer.from("local\0"),
        Buffer.from("remote\0"),
        "skills/Test/Binary.md",
      ),
      /git merge-file failed for skills\/Test\/Binary\.md \(exit code 255\)/,
      "fatal merge-file errors must remain execution failures",
    );
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      await assert.rejects(
        () => deterministicTextMerge(
          Buffer.from("base\n"),
          Buffer.from("local\n"),
          Buffer.from("remote\n"),
          "skills/Test/Spawn.md",
        ),
        /git merge-file failed for skills\/Test\/Spawn\.md \(exit code ENOENT\)/,
        "missing Git executables must remain execution failures",
      );
    } finally {
      process.env.PATH = originalPath;
    }

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
    fs.mkdirSync(path.join(sources, "notes"), { recursive: true });
    fs.writeFileSync(path.join(sources, "skills", "public.md"), skill("One", "public"));
    fs.writeFileSync(path.join(sources, "skills", "public-three.md"), twoConflictSkill("base first", "base second"));
    fs.writeFileSync(path.join(sources, "skills", "private.md"), skill("Two", "private"));
    fs.writeFileSync(path.join(sources, "scripts", "run.sh"), "echo ready\n");
    const unicodeNoteName = "AutoLabeling Prompt Tuning — Summary & Results (unified_c3_r1 v1→v2.5, + w_fix).md";
    fs.mkdirSync(path.join(sources, "notes", "_assets"), { recursive: true });
    fs.writeFileSync(path.join(sources, "notes", unicodeNoteName), "# Unicode path\n\n![Chart](_assets/chart one.png)\n");
    fs.writeFileSync(path.join(sources, "notes", "_assets", "chart one.png"), Buffer.from("chart-image"));
    fs.writeFileSync(path.join(sources, "snapshot.json"), JSON.stringify({ schema: "pkm.agent.snapshot/v1", payload: { algorithm: "A256GCM-PKM-LOCAL-OBFUSCATION/v1", ciphertext: "obfuscated" } }));
    const catalog = Object.fromEntries(GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
    catalog.skills = [
      { id: "Public/One", label: "One", cat: "Public", isPrivate: false, source: path.join(sources, "skills", "public.md"), destination: "skills/Public/One.md" },
      { id: "Design/Three", label: "Three", cat: "Design", isPrivate: false, source: path.join(sources, "skills", "public-three.md"), destination: "skills/Design/Three.md" },
      { id: "Private/Two", label: "Two", cat: "Private", isPrivate: true, source: path.join(sources, "skills", "private.md"), destination: "skills/Private/Two.md" }
    ];
    catalog.scripts = [
      { id: "run.sh", label: "run.sh", cat: "", isPrivate: false, source: path.join(sources, "scripts", "run.sh"), destination: "scripts/run.sh" }
    ];
    catalog.notes = [
      {
        id: "AutoLabeling/unicode-path", label: unicodeNoteName, cat: "AutoLabeling", isPrivate: false,
        source: path.join(sources, "notes", unicodeNoteName), destination: `notes/${unicodeNoteName}`,
        dependencies: [{ source: path.join(sources, "notes", "_assets", "chart one.png"), destination: "notes/_assets/chart one.png" }],
      }
    ];
    catalog.agentSnapshots = [
      { id: "agent_snapshot_test", label: "Snapshot", cat: "Agent", isPrivate: true, source: path.join(sources, "snapshot.json"), destination: "agentSnapshots/agent_snapshot_test.json" }
    ];
    const target = normalizeGitHubSyncTarget({ name: "Test", repository: remote, branch: "main" }, () => "target-1");
    target.selection.private.skills = { items: [], folders: [""] };
    target.selection.private.agentSnapshots = { items: ["agent_snapshot_test"], folders: [] };
    const checkoutRoot = path.join(root, "checkouts");
    const first = await syncGitHubTarget(target, catalog, checkoutRoot);
    rememberSync(target, first);
    assert.strictEqual(first.changed, true);
    const verify = path.join(root, "verify");
    run(root, ["clone", "--branch", "main", remote, verify]);
    run(verify, ["config", "user.name", "Remote Test"]);
    run(verify, ["config", "user.email", "remote@example.com"]);
    assert.strictEqual(fs.readFileSync(path.join(verify, "README.md"), "utf8"), "keep me\n");
    assert.strictEqual(fs.readFileSync(path.join(verify, "skills", "Public", "One.md"), "utf8"), skill("One", "public"));
    assert.strictEqual(fs.readFileSync(path.join(verify, "skills", "Design", "Three.md"), "utf8"), twoConflictSkill("base first", "base second"));
    assert.strictEqual(fs.readFileSync(path.join(verify, "skills", "Private", "Two.md"), "utf8"), skill("Two", "private"));
    assert.strictEqual(fs.readFileSync(path.join(verify, "scripts", "run.sh"), "utf8"), "echo ready\n");
    assert.match(fs.readFileSync(path.join(verify, "notes", unicodeNoteName), "utf8"), /_assets\/chart one\.png/);
    assert.deepStrictEqual(fs.readFileSync(path.join(verify, "notes", "_assets", "chart one.png")), Buffer.from("chart-image"));
    assert.match(fs.readFileSync(path.join(verify, "agentSnapshots", "agent_snapshot_test.json"), "utf8"), /A256GCM-PKM-LOCAL-OBFUSCATION/);
    const manifest = JSON.parse(fs.readFileSync(path.join(verify, ".pkm-github-sync.json"), "utf8"));
    assert.strictEqual(manifest.schema, 3, "new syncs publish stable identity, capability, privacy, and digest metadata");
    assert.deepStrictEqual(manifest.capabilities.required, ["explicit-deletions", "stable-entity-identity"]);
    assert(manifest.files.some(file => file.path === "skills/Private/Two.md" && file.privacy === "private" && file.itemId === "Private/Two"));

    const second = await syncGitHubTarget(target, catalog, checkoutRoot);
    assert.strictEqual(second.changed, false);
    assert.strictEqual(second.commit, first.commit);
    assert(fs.existsSync(path.join(checkoutRoot, target.id, "repository", "notes", unicodeNoteName)), "NUL-delimited ls-files preserves the exact Unicode managed path");

    const restoreRoot = path.join(root, "restored-store");
    const snapshot = await fetchGitHubRemoteSnapshot(target, checkoutRoot);
    assert.strictEqual(snapshot.commit, first.commit);
    assert(snapshot.files.some(file => file.path === "skills/Public/One.md" && file.type === "skills"));
    assert(snapshot.files.some(file => file.path === "notes/_assets/chart one.png" && file.type === "notes"));
    assert.strictEqual(fs.existsSync(restoreRoot), false, "browsing remote content must not create or modify the local store");
    assert.strictEqual((await readGitHubRemoteFile(target, checkoutRoot, snapshot.commit, "skills/Public/One.md")).toString("utf8"), skill("One", "public"));
    await assert.rejects(() => readGitHubRemoteFile(target, checkoutRoot, snapshot.commit, "../outside.md"), /invalid/);

    fs.mkdirSync(path.join(restoreRoot, "skills", "Public"), { recursive: true });
    fs.writeFileSync(path.join(restoreRoot, "skills", "Public", "One.md"), "local\n");
    const conflict = await restoreGitHubRemoteFiles(target, checkoutRoot, restoreRoot, snapshot.commit, ["skills/Public/One.md"], false);
    assert.deepStrictEqual(conflict, { restored: [], conflicts: ["skills/Public/One.md"] });
    assert.strictEqual(fs.readFileSync(path.join(restoreRoot, "skills", "Public", "One.md"), "utf8"), "local\n");
    const restored = await restoreGitHubRemoteFiles(target, checkoutRoot, restoreRoot, snapshot.commit, ["agentSnapshots/agent_snapshot_test.json", "notes/_assets/chart one.png", "skills/Public/One.md", "scripts/run.sh"], true);
    assert.deepStrictEqual(restored.restored, ["agentSnapshots/agent_snapshot_test.json", "notes/_assets/chart one.png", "scripts/run.sh", "skills/Public/One.md"]);
    assert.strictEqual(fs.readFileSync(path.join(restoreRoot, "skills", "Public", "One.md"), "utf8"), skill("One", "public"));
    assert.strictEqual(fs.readFileSync(path.join(restoreRoot, "scripts", "run.sh"), "utf8"), "echo ready\n");
    assert.deepStrictEqual(fs.readFileSync(path.join(restoreRoot, "notes", "_assets", "chart one.png")), Buffer.from("chart-image"));
    assert.match(fs.readFileSync(path.join(restoreRoot, ".pkm", "state", "agent-snapshots", "agent_snapshot_test.json"), "utf8"), /A256GCM-PKM-LOCAL-OBFUSCATION/);
    await assert.rejects(() => restoreGitHubRemoteFiles(target, checkoutRoot, restoreRoot, snapshot.commit, ["README.md"], true), /not in the PKM manifest/);

    run(verify, ["checkout", "-b", "public-tree"]);
    fs.rmSync(path.join(verify, ".pkm-github-sync.json"));
    fs.mkdirSync(path.join(verify, "notes", "Public"), { recursive: true });
    fs.mkdirSync(path.join(verify, "notes", "Agent Sessions", "Snapshots"), { recursive: true });
    fs.mkdirSync(path.join(verify, "servers", "scenario|invalid"), { recursive: true });
    fs.writeFileSync(path.join(verify, "notes", "Public", "Welcome.md"), "public note\n");
    const longRevisionPath = "notes/Agent Sessions/Snapshots/GitHub Branch Subscription - 2026-09-23.md";
    fs.writeFileSync(path.join(verify, ...longRevisionPath.split("/")), "long path note\n");
    fs.writeFileSync(path.join(verify, "scripts", "large.bin"), Buffer.alloc(1024 * 1024 + 1, 7));
    fs.writeFileSync(path.join(verify, "servers", "scenario|invalid", "config.yaml"), "ignored: true\n");
    fs.writeFileSync(path.join(verify, "unrelated.txt"), "ignore\n");
    run(verify, ["add", "-A"]);
    run(verify, ["commit", "-m", "public repository tree"]);
    run(verify, ["push", "-u", "origin", "public-tree"]);
    const publicTarget = normalizeGitHubSyncTarget({ name: "Public", repository: remote, branch: "public-tree" }, () => "target-public");
    await assert.rejects(() => fetchGitHubRemoteSnapshot(publicTarget, checkoutRoot), /manifest/i, "GitHub Sync remains manifest-only");
    const publicSnapshot = await fetchGitHubRemoteSnapshot(publicTarget, checkoutRoot, true);
    assert(publicSnapshot.files.some(file => file.path === "notes/Public/Welcome.md" && file.type === "notes"));
    assert(!publicSnapshot.files.some(file => file.path === "README.md" || file.path === "unrelated.txt"), "subscription discovery only exposes supported PKM roots");
    assert.strictEqual(publicSnapshot.validation.filesOverPreviewLimit, 1, "repository validation must identify valid files that are too large to preview");
    assert.strictEqual(publicSnapshot.validation.ignoredFiles, 2, "repository validation must count files outside supported subscription roots");
    assert.strictEqual(publicSnapshot.validation.invalidFiles, 1, "repository validation must report non-portable paths inside supported roots");
    assert.deepStrictEqual(publicSnapshot.validation.invalidExamples, ["servers/scenario|invalid/config.yaml"]);
    assert(!publicSnapshot.files.some(file => file.path.includes("scenario|invalid")), "non-portable paths must be skipped instead of aborting the whole repository");
    assert.strictEqual((await readGitHubRemoteFileForSubscription(publicTarget, checkoutRoot, publicSnapshot.commit, longRevisionPath, 1024 * 1024)).toString("utf8"), "long path note\n",
      "subscription reads must handle the exact Windows path that previously failed");
    assert.doesNotMatch(githubSyncSource, /gitBuffer\(checkout, \["show", `\$\{commit\}:\$\{safe\}`\]/,
      "exact-commit content reads must not use porcelain git show");
    assert.match(githubSyncSource, /gitBuffer\(checkout, \["cat-file", "blob", `\$\{commit\}:\$\{safe\}`\]/,
      "exact-commit content reads must use the object database");
    await assert.rejects(() => readGitHubRemoteFile(publicTarget, checkoutRoot, publicSnapshot.commit, "scripts/large.bin"), /preview limit/);
    assert.strictEqual((await readGitHubRemoteFileForSubscription(publicTarget, checkoutRoot, publicSnapshot.commit, "scripts/large.bin", 2 * 1024 * 1024)).length, 1024 * 1024 + 1,
      "subscription materialization must not inherit the interactive preview limit");
    const batch = await readGitHubRemoteFilesForSubscription(publicTarget, checkoutRoot, publicSnapshot.commit, [
      { path: longRevisionPath, size: Buffer.byteLength("long path note\n") },
      { path: "scripts/large.bin", size: 1024 * 1024 + 1 },
    ], 2 * 1024 * 1024);
    assert.strictEqual(batch.get(longRevisionPath).toString("utf8"), "long path note\n", "batch subscription reads must preserve long Windows-safe paths");
    assert.strictEqual(batch.get("scripts/large.bin").length, 1024 * 1024 + 1, "batch subscription reads must return large blobs without the preview limit");
    await assert.rejects(() => readGitHubRemoteFilesForSubscription(publicTarget, checkoutRoot, publicSnapshot.commit, [
      { path: longRevisionPath, size: 1 },
    ], 1024), /size changed/, "batch subscription reads must reject stale inventory sizes");
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
    rememberSync(target, fastForward);
    assert.strictEqual(fastForward.changed, false);
    assert.strictEqual(fs.readFileSync(path.join(root, "checkouts", target.id, "repository", "REMOTE.md"), "utf8"), "remote addition\n");

    target.selection.private.skills = { items: [], folders: [] };
    const deletion = await syncGitHubTarget(target, catalog, path.join(root, "checkouts"));
    rememberSync(target, deletion);
    assert.strictEqual(deletion.changed, false);
    run(verify, ["pull", "--ff-only"]);
    assert.strictEqual(fs.existsSync(path.join(verify, "skills", "Private", "Two.md")), true, "content outside this machine's selection must be preserved");
    assert.strictEqual(fs.readFileSync(path.join(verify, "README.md"), "utf8"), "keep me\n", "unmanaged files must survive deletion");

    const windowsStore = path.join(root, "windows-store");
    fs.mkdirSync(path.join(windowsStore, "skills", "Public"), { recursive: true });
    fs.mkdirSync(path.join(windowsStore, "skills", "Ads"), { recursive: true });
    fs.writeFileSync(path.join(windowsStore, "skills", "Public", "One.md"), skill("One", "public"));
    fs.writeFileSync(path.join(windowsStore, "skills", "Ads", "Local.md"), skill("Local", "windows-only addition"));
    const windowsCatalog = Object.fromEntries(GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
    windowsCatalog.skills = [
      { id: "Public/One", label: "One", cat: "Public", isPrivate: false, source: path.join(windowsStore, "skills", "Public", "One.md"), destination: "skills/Public/One.md" },
      { id: "Ads/Local", label: "Local", cat: "Ads", isPrivate: false, source: path.join(windowsStore, "skills", "Ads", "Local.md"), destination: "skills/Ads/Local.md" }
    ];
    const windowsTarget = normalizeGitHubSyncTarget({ name: "Windows", repository: remote, branch: "main" }, () => "target-windows");
    const windowsFirst = await syncGitHubTarget(windowsTarget, windowsCatalog, checkoutRoot, undefined, windowsStore);
    rememberSync(windowsTarget, windowsFirst);
    assert(windowsFirst.pulled.includes("skills/Design/Three.md"), "a sparse machine must pull remote-only public Skills");
    assert.strictEqual(fs.readFileSync(path.join(windowsStore, "skills", "Design", "Three.md"), "utf8"), twoConflictSkill("base first", "base second"));
    assert.strictEqual(fs.existsSync(path.join(windowsStore, "skills", "Private", "Two.md")), false, "private Skills remain excluded until selected");
    run(verify, ["pull", "--ff-only"]);
    assert.strictEqual(fs.readFileSync(path.join(verify, "skills", "Ads", "Local.md"), "utf8"), skill("Local", "windows-only addition"), "a sparse machine's non-conflicting local Skill must be pushed");
    assert.strictEqual(fs.existsSync(path.join(verify, "skills", "Private", "Two.md")), true, "a sparse public machine must not delete remote private content");
    fs.writeFileSync(path.join(sources, "skills", "ads-local.md"), skill("Local", "windows-only addition"));
    catalog.skills.push({ id: "Ads/Local", label: "Local", cat: "Ads", isPrivate: false, source: path.join(sources, "skills", "ads-local.md"), destination: "skills/Ads/Local.md" });

    fs.writeFileSync(path.join(sources, "skills", "public-three.md"), twoConflictSkill("remote first", "remote second"));
    const sourceChanged = await syncGitHubTarget(target, catalog, checkoutRoot);
    rememberSync(target, sourceChanged);
    fs.writeFileSync(path.join(windowsStore, "skills", "Design", "Three.md"), twoConflictSkill("local first", "local second"));
    windowsCatalog.skills.push({
      id: "Design/Three", label: "Three", cat: "Design", isPrivate: false,
      source: path.join(windowsStore, "skills", "Design", "Three.md"), destination: "skills/Design/Three.md"
    });
    windowsCatalog.scripts = [
      { id: "run.sh", label: "run.sh", cat: "", isPrivate: false, source: path.join(windowsStore, "scripts", "run.sh"), destination: "scripts/run.sh" }
    ];
    let twoConflictError;
    await assert.rejects(
      () => syncGitHubTarget(windowsTarget, windowsCatalog, checkoutRoot, undefined, windowsStore),
      error => {
        twoConflictError = error;
        return error instanceof GitHubSyncConflictError
          && error.conflicts.some(conflict => conflict.path === "skills/Design/Three.md")
          && /Resolve and approve/.test(error.message);
      },
      "two same-file conflict hunks must reach the human-required workflow instead of aborting merge-file"
    );
    const stagedTwoConflict = storeGitHubSyncConflict(windowsStore, windowsTarget.id, twoConflictError);
    assert.strictEqual(stagedTwoConflict.resolutionReport.rules["human-required"], 1,
      "a two-hunk merge conflict must be staged for human resolution");
    run(verify, ["pull", "--ff-only"]);
    assert.strictEqual(fs.readFileSync(path.join(verify, "skills", "Design", "Three.md"), "utf8"), twoConflictSkill("remote first", "remote second"), "conflicts must never push the local candidate automatically");

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
    const recoveredDivergence = await syncGitHubTarget(target, catalog, path.join(root, "checkouts"));
    rememberSync(target, recoveredDivergence);
    assert.strictEqual(fs.existsSync(path.join(checkout, "LOCAL.md")), false, "unpublished internal checkout commits must be discarded");
    assert.strictEqual(fs.readFileSync(path.join(checkout, "REMOTE-2.md"), "utf8"), "remote divergence\n");

    const hook = path.join(remote, "hooks", "pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const rejectedTarget = normalizeGitHubSyncTarget({ name: "Rejected", repository: remote, branch: "rejected" }, () => "target-3");
    await assert.rejects(() => syncGitHubTarget(rejectedTarget, catalog, path.join(root, "checkouts")), /git push failed/);
    assert.throws(() => run(root, ["--git-dir", remote, "show-ref", "--verify", "refs/heads/rejected"]));
    assert.strictEqual(fs.existsSync(path.join(root, "checkouts", rejectedTarget.id)), false, "a rejected initial push must remove its unpublished checkout");
    fs.rmSync(hook);
    await syncGitHubTarget(rejectedTarget, catalog, path.join(root, "checkouts"));
    assert(run(root, ["--git-dir", remote, "show-ref", "--verify", "refs/heads/rejected"]));
    console.log("github-sync git tests passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });