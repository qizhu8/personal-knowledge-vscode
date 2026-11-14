"use strict";

const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { execFileSync, fork } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const digest = value => createHash("sha256").update(value).digest("hex");
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, value, { mode: 0o600 }); };
function git(cwd, args) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd, encoding: "utf8", timeout: 30000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}
const item = (type, name, data) => ({ path: `${type}/${name}.md`, type, itemId: name,
  member: "", category: "", privacy: "public", digest: digest(data) });

exports.prepare = ({ fixture, root, globalStorage }) => {
  const directory = path.join(fixture, "sync-installed"), seed = path.join(directory, "seed"), bare = path.join(directory, "remote.git");
  fs.mkdirSync(seed, { recursive: true, mode: 0o700 });
  const names = fs.readdirSync(path.join(root, "skills")).sort();
  assert(names.includes("InstallAlpha.md") && names.includes("InstallBeta.md"));
  const files = names.map(name => {
    assert.match(name, /^[A-Za-z0-9_-]+\.md$/);
    const bytes = fs.readFileSync(path.join(root, "skills", name));
    put(path.join(seed, "skills", name), bytes);
    return item("skills", name.slice(0, -3), bytes);
  });
  const note = "---\ntitle: Remote Note\n---\nremote note unchanged\n";
  const prompt = "---\ntitle: Remote Prompt\n---\nremote prompt unchanged\n";
  put(path.join(seed, "notes/Remote.md"), note); put(path.join(seed, "prompts/Remote.md"), prompt);
  files.push(item("notes", "Remote", note), item("prompts", "Remote", prompt));
  put(path.join(seed, ".pkm-github-sync.json"), JSON.stringify({
    schema: 3, minimumExtensionVersion: "4.0.22",
    capabilities: { storage: "pkm.github.publication/v1", required: ["explicit-deletions", "stable-entity-identity", "entity-partial-progress"] },
    files, deletions: [],
  }) + "\n");
  git(seed, ["init", "-q"]); git(seed, ["config", "user.name", "Fixture"]); git(seed, ["config", "user.email", "fixture@example.invalid"]);
  git(seed, ["add", "."]); git(seed, ["commit", "-qm", "base"]); git(seed, ["branch", "-M", "main"]);
  git(directory, ["clone", "--bare", "-q", seed, bare]);
  const commit = git(directory, ["--git-dir", bare, "rev-parse", "refs/heads/main"]);
  const target = { schema: 1, id: "fixture-target", name: "Synthetic installed Sync",
    repository: "https://github.com/fixture/fixture.git", branch: "main",
    authentication: { method: "vscode", expectedLogin: "fixture" },
    automation: { enabled: false, intervalMinutes: 5, syncOnChange: false, initialSyncCompleted: true },
    conflictResolution: "manual", selection: { public: { skills: { items: [], folders: [""] } }, private: {} },
    lastSync: { at: "2026-01-01T00:00:00Z", commit, fingerprints: {},
      repository: "https://github.com/fixture/fixture.git", branch: "main", storeRoot: root } };
  const config = JSON.stringify({ schema: 1, targets: [target] }, null, 2) + "\n";
  const receipt = JSON.stringify({ schema: 1, transactionId: randomUUID(), targetId: target.id, repository: target.repository,
    branch: target.branch, baseCommit: commit, pushedCommit: commit, pushedAt: target.lastSync.at,
    operation: "sync", state: "recorded", recordedAt: target.lastSync.at,
    outbox: [{ entity: "skills\u0000InstallAlpha", snapshot: JSON.stringify([{ path: "skills/InstallAlpha.md",
      digest: digest(fs.readFileSync(path.join(root, "skills/InstallAlpha.md"))) }]) }] }, null, 2) + "\n";
  put(path.join(globalStorage, "github-sync/targets.json"), config);
  put(path.join(globalStorage, "github-sync/checkouts/fixture-target/transactions/latest.json"), receipt);
  const policy = { policyId: randomUUID(), owner: "fixture", repository: "fixture", branch: "main",
    secretRef: randomUUID(), expectedLogin: "fixture", visibility: "public", allowPrivate: false,
    extensionVersion: "4.0.22", approvalId: randomUUID() };
  put(path.join(directory, "fixture.json"), JSON.stringify({ directory, seed, bare, root, globalStorage, policy, config, receipt }));
};

function snapshot(root, areas) {
  const result = {};
  function visit(base, relative) {
    const full = path.join(base, relative);
    if (!fs.existsSync(full)) return;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const rel = path.join(relative, entry.name), file = path.join(base, rel);
      assert(!entry.isSymbolicLink());
      if (entry.isDirectory()) visit(base, rel);
      else { assert(entry.isFile()); result[rel] = digest(fs.readFileSync(file)); }
    }
  }
  for (const area of areas) visit(root, area);
  return result;
}

exports.runWithCredential = async ({ extensionPath, globalStorage, readSecret }) => {
  const fixture = process.env.PKM_TRIAL_ELECTRON_ROOT;
    const data = JSON.parse(fs.readFileSync(path.join(fixture, "sync-installed/fixture.json"), "utf8"));
    assert.equal(fs.realpathSync(globalStorage), fs.realpathSync(data.globalStorage));
    assert.equal(fs.realpathSync(process.env.PKM_TRIAL_ELECTRON_LEGACY), fs.realpathSync(data.root));
    const tokenKey = "personalKnowledge.githubSync.vscode.fixture-target";
    assert.equal(JSON.parse(await readSecret(tokenKey)).accountLabel, "fixture");
    const runtime = path.join(extensionPath, "next-runtime/server");
    const childScript = path.join(extensionPath, "sync-installed-child.cjs");
    const providerScript = path.join(fixture, "sync-provider/tests/local-git-sync-provider.mjs");
    let secretReads = 0;
    const runChild = action => new Promise((resolve, reject) => {
      const child = fork(childScript, [], { cwd: fixture, execPath: process.env.PKM_TRIAL_ELECTRON_NODE,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" } });
      let output, errors = "";
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Sync child timed out")); }, 60000);
      child.stderr.on("data", bytes => { errors += bytes.toString(); });
      child.on("message", async message => {
        if (message.kind === "secret") {
          assert.equal(message.key, tokenKey); secretReads++;
          child.send({ kind: "secret-result", id: message.id, value: await readSecret(message.key) });
        } else if (message.kind === "result") output = message;
        else if (message.kind === "error") errors += message.message;
      });
      child.once("error", reject);
      child.once("exit", code => {
        clearTimeout(timer);
        if (action === "crash" && code === 77) return resolve({ crashed: true });
        if (code !== 0 || !output) return reject(new Error(`Sync child failed (${code}): ${errors}`));
        resolve(output);
      });
      child.send({ kind: "start", action, runtime, providerScript, ...data });
    });
    const before = snapshot(data.root, ["notes", "prompts", "scripts"]);
    const alpha = path.join(data.root, "skills/InstallAlpha.md");
    fs.appendFileSync(alpha, "installed local sync fixture\n");
    assert.equal((await runChild("sync")).result.state, "published");
    assert.match(git(data.directory, ["--git-dir", data.bare, "show", "main:skills/InstallAlpha.md"]), /installed local sync fixture/);
    assert.equal(git(data.directory, ["--git-dir", data.bare, "show", "main:notes/Remote.md"]), "---\ntitle: Remote Note\n---\nremote note unchanged");
    assert.equal(git(data.directory, ["--git-dir", data.bare, "show", "main:prompts/Remote.md"]), "---\ntitle: Remote Prompt\n---\nremote prompt unchanged");
    fs.appendFileSync(alpha, "installed crash fixture\n");
    await runChild("crash");
    const commit = git(data.directory, ["--git-dir", data.bare, "rev-parse", "refs/heads/main"]);
    const recovered = await runChild("resume");
    assert.deepEqual(recovered.result, { state: "published", commit }); assert.equal(recovered.pushes, 0);
    assert.equal(git(data.directory, ["--git-dir", data.bare, "rev-parse", "refs/heads/main"]), commit);

    git(data.seed, ["remote", "add", "origin", data.bare]);
    git(data.seed, ["fetch", "-q", "origin", "main"]); git(data.seed, ["reset", "-q", "--hard", "FETCH_HEAD"]);
    const manifestFile = path.join(data.seed, ".pkm-github-sync.json");
    const remoteFile = path.join(data.seed, "skills/InstallAlpha.md");
    fs.appendFileSync(remoteFile, "installed remote sync fixture\n");
    const wire = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    wire.files.find(file => file.path === "skills/InstallAlpha.md").digest = digest(fs.readFileSync(remoteFile));
    fs.writeFileSync(manifestFile, JSON.stringify(wire) + "\n");
    git(data.seed, ["add", "."]); git(data.seed, ["commit", "-qm", "remote"]); git(data.seed, ["push", "-q", "origin", "main"]);
    assert.equal((await runChild("sync")).result.state, "published");
    assert.match(fs.readFileSync(alpha, "utf8"), /installed remote sync fixture/);
    fs.appendFileSync(alpha, "installed local conflict\n");
    git(data.seed, ["fetch", "-q", "origin", "main"]); git(data.seed, ["reset", "-q", "--hard", "FETCH_HEAD"]);
    fs.appendFileSync(remoteFile, "installed remote conflict\n");
    const conflictWire = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    conflictWire.files.find(file => file.path === "skills/InstallAlpha.md").digest = digest(fs.readFileSync(remoteFile));
    fs.writeFileSync(manifestFile, JSON.stringify(conflictWire) + "\n");
    git(data.seed, ["add", "."]); git(data.seed, ["commit", "-qm", "conflict"]); git(data.seed, ["push", "-q", "origin", "main"]);
    const conflict = await runChild("sync");
    assert.equal(conflict.result.state, "conflict"); assert.equal(conflict.result.conflicts[0].reason, "concurrent-change");
    assert.deepEqual((await runChild("resume")).result, conflict.result);
    assert.deepEqual(snapshot(data.root, ["notes", "prompts", "scripts"]), before);
    assert.equal(fs.readFileSync(path.join(data.globalStorage, "github-sync/targets.json"), "utf8"), data.config);
    assert.equal(fs.readFileSync(path.join(data.globalStorage, "github-sync/checkouts/fixture-target/transactions/latest.json"), "utf8"), data.receipt);
    assert(secretReads > 0);
    fs.writeFileSync(path.join(fixture, "sync-installed-passed.json"), JSON.stringify({ passed: true, push: true, pull: true,
      recovery: true, conflict: true, secretStorage: true, nonSkillsUnchanged: true }));
    console.log("PASS: installed same-root experimental Sync used synthetic legacy configuration and real VS Code SecretStorage with private bare Git, restart and conflict.");
};
