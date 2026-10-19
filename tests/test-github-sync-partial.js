const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const sync = require("../dist/sync/github-sync");
const { planGitHubSyncPublication } = require("../dist/sync/github-sync-publication-plan");
const { GitHubSyncScheduler } = require("../dist/sync/github-sync-scheduler");
const conflicts = require("../dist/sync/github-sync-conflicts");
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-sync-partial-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  fs.mkdirSync(seed);
  git(root, ["init", "--bare", remote]);
  git(seed, ["init"]);
  git(seed, ["config", "user.name", "Fixture"]);
  git(seed, ["config", "user.email", "fixture@example.invalid"]);
  fs.writeFileSync(path.join(seed, "README.md"), "fixture\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "seed"]);
  git(seed, ["branch", "-M", "main"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "origin", "main"]);
  git(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  function replica(name) {
    const store = path.join(root, name);
    fs.mkdirSync(path.join(store, "notes", "Shared"), { recursive: true });
    const target = sync.normalizeGitHubSyncTarget({ repository: remote, branch: "main", name }, () => name);
    const checkout = path.join(root, name + "-checkout");
    const write = (name, text) => fs.writeFileSync(path.join(store, "notes", "Shared", name + ".md"), text);
    const catalog = () => {
      const value = Object.fromEntries(sync.GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
      value.notes = fs.readdirSync(path.join(store, "notes", "Shared")).map(name => ({
        id: "Shared/" + name.slice(0, -3), label: name, cat: "Shared", isPrivate: false,
        source: path.join(store, "notes", "Shared", name), destination: "notes/Shared/" + name,
      }));
      return value;
    };
    const acknowledge = result => {
      target.lastSync = { at: new Date().toISOString(), commit: result.commit, fingerprints: result.fingerprints,
        entityBases: result.entityBases };
      sync.completeGitHubSyncTransaction(checkout, target.id, result.transactionId);
    };
    const run = async () => {
      try {
        const result = await sync.syncGitHubTarget(target, catalog(), checkout, undefined, store);
        acknowledge(result);
        return { result };
      } catch (error) {
        if (!(error instanceof sync.GitHubSyncConflictError) || !error.partialResult) throw error;
        acknowledge(error.partialResult);
        return { result: error.partialResult, error };
      }
    };
    return { store, target, checkout, catalog, write, run };
  }
  return { root, remote, replica, read: name => git(root, ["--git-dir", remote, "show", "main:notes/Shared/" + name + ".md"]) };
}

test("pure planner isolates required groups and portable destination collisions without mutating inputs", () => {
  const remote = new Map([["a", [{ path: "notes/old.md" }]], ["b", [{ path: "notes/other.md" }]]]);
  const candidates = new Map([["a", [{ path: "notes/new.md" }]], ["b", [{ path: "NOTES/NEW.md" }]],
    ["recipe", [{ path: "recipes/recipe.json" }]], ["safe", [{ path: "notes/safe.md" }]]]);
  const before = JSON.stringify([...candidates]);
  const result = planGitHubSyncPublication(candidates, remote, new Set(), new Map([["recipe", new Set(["a"])]]));
  assert.deepEqual([...result.blocked].sort(), ["a", "b", "recipe"]);
  assert.deepEqual(result.files.map(file => file.path).sort(), ["notes/old.md", "notes/other.md", "notes/safe.md"]);
  assert.equal(JSON.stringify([...candidates]), before);
});

test("paused items override selected folders, preserve both copies and their Base, and resume normal conflict review", async t => {
  const f = fixture(t), a = f.replica("pause-a"), b = f.replica("pause-b");
  for (const client of [a, b]) {
    client.write("paused", "original\n");
    client.write("safe", "safe original\n");
  }
  const initial = await a.run();
  await b.run();
  b.write("paused", "remote while paused\n");
  await b.run();
  a.write("paused", "local while paused\n");
  a.write("safe", "unrelated local edit\n");
  a.target.pausedItems = [{ type: "notes", itemId: "Shared/paused" }];
  a.target.pausedItems = sync.normalizeGitHubSyncTarget(JSON.parse(JSON.stringify(a.target))).pausedItems;
  const paused = await a.run();
  assert(!paused.error, "a deliberate pause is not a merge conflict");
  assert.equal(f.read("paused"), "remote while paused");
  assert.equal(f.read("safe"), "unrelated local edit");
  assert.equal(fs.readFileSync(path.join(a.store, "notes/Shared/paused.md"), "utf8"), "local while paused\n");
  assert.equal(paused.result.entityBases["notes\0Shared/paused"], initial.result.commit);
  a.target.pausedItems = [];
  const resumed = await a.run();
  assert(resumed.error, "resuming compares against the original common Base, not a newer unrelated Sync");
  assert.equal(resumed.error.conflicts[0].base.toString(), "original\n");
  assert.equal(f.read("paused"), "remote while paused");
});

test("conflicting entity retains its own Base while safe uploads/downloads and approvals survive restart", async t => {
  const f = fixture(t), a = f.replica("a"), b = f.replica("b");
  for (const client of [a, b]) for (const name of ["conflict", "upload", "download"]) client.write(name, name + " base\n");
  const initial = await a.run(); await b.run();
  b.write("conflict", "remote edit\n"); b.write("download", "remote downloaded\n");
  await b.run();
  a.write("conflict", "local edit\n"); a.write("upload", "safe upload\n");
  const partial = await a.run();
  assert(partial.error);
  assert.equal(f.read("conflict"), "remote edit");
  assert.equal(f.read("upload"), "safe upload");
  assert.equal(fs.readFileSync(path.join(a.store, "notes/Shared/download.md"), "utf8"), "remote downloaded\n");
  assert.equal(partial.result.entityBases["notes\0Shared/conflict"], initial.result.commit);
  const state = path.join(f.root, "conflicts");
  const workspace = conflicts.storeGitHubSyncConflict(state, a.target.id, partial.error);
  conflicts.selectGitHubSyncConflictCandidate(state, a.target.id, "notes/Shared/conflict.md", "local");
  // Serialize/normalize as a new host would; no transient in-memory Base is needed.
  a.target.lastSync = sync.normalizeGitHubSyncTarget(JSON.parse(JSON.stringify(a.target))).lastSync;
  a.write("upload", "safe second upload\n");
  const next = await a.run();
  assert.equal(next.error.conflicts[0].base.toString(), "conflict base\n");
  assert.equal(next.error.conflicts[0].baseCommit, initial.result.commit);
  const preserved = conflicts.storeGitHubSyncConflict(state, a.target.id, next.error);
  assert.equal(preserved.id, workspace.id);
  assert.equal(preserved.files[0].candidateSource, "local");
  assert.equal(f.read("upload"), "safe second upload");
  const receipt = JSON.parse(fs.readFileSync(path.join(a.checkout, a.target.id, "transactions/latest.json")));
  assert.equal(receipt.state, "recorded");
  assert.equal(receipt.entityBases["notes\0Shared/conflict"], initial.result.commit);
  assert(receipt.outbox.some(item => item.entity === "notes\0Shared/upload" && item.snapshot));
  // A manual decision is not inferred: only after making the actual source equal
  // to the reviewed remote version does the entity leave isolation.
  a.write("conflict", "remote edit\n");
  const settled = await a.run();
  assert(!settled.error);
  assert.deepEqual(settled.result.entityBases, {});
});

test("15 isolated replicas converge under concurrent CAS contention and an offline edit", async t => {
  const f = fixture(t);
  const clients = Array.from({ length: 15 }, (_, index) => f.replica("replica-" + index));
  clients[0].write("base", "common\n");
  await clients[0].run();
  for (const client of clients.slice(1)) await client.run();
  for (let index = 0; index < clients.length; index++) clients[index].write("new-" + index, "author " + index + "\n");
  const results = await Promise.all(clients.map(client => client.run()));
  assert(results.every(result => !result.error));
  for (const client of clients) {
    const result = await client.run();
    assert(!result.error);
    assert.equal(client.catalog().notes.length, 16);
  }
  clients[14].write("offline", "reconnected contribution\n");
  const unavailable = f.remote + ".offline";
  fs.renameSync(f.remote, unavailable);
  try { await assert.rejects(() => clients[14].run(), /git .*failed|does not appear to be a git repository/i); }
  finally { fs.renameSync(unavailable, f.remote); }
  clients[0].write("online", "other author continued\n");
  await clients[0].run();
  await clients[14].run(); await clients[0].run();
  assert.equal(f.read("offline"), "reconnected contribution");
  assert.equal(fs.readFileSync(path.join(clients[0].store, "notes/Shared/offline.md"), "utf8"), "reconnected contribution\n");
  assert.equal(fs.readFileSync(path.join(clients[14].store, "notes/Shared/online.md"), "utf8"), "other author continued\n");
});

test("a partial target cannot pin or acknowledge another target sharing the same Knowledge Root", async t => {
  const f = fixture(t), a = f.replica("primary"), b = f.replica("peer");
  for (const client of [a, b]) client.write("conflict", "base\n");
  const base = await a.run(); await b.run();
  b.write("conflict", "peer edit\n"); await b.run();
  a.write("conflict", "local edit\n"); a.write("independent", "safe\n");
  const partial = await a.run();
  assert(partial.error);
  const backup = sync.normalizeGitHubSyncTarget({ repository: f.remote, branch: "backup", name: "Backup" }, () => "backup");
  const checkout = path.join(f.root, "backup-checkout");
  const result = await sync.syncGitHubTarget(backup, a.catalog(), checkout, undefined, a.store);
  assert.deepEqual(result.entityBases, {});
  assert.equal(a.target.lastSync.entityBases["notes\0Shared/conflict"], base.result.commit);
  assert.equal(git(f.root, ["--git-dir", f.remote, "show", "backup:notes/Shared/conflict.md"]), "local edit");
  assert.equal(f.read("conflict"), "peer edit", "the conflicted primary publication stays unchanged");
  assert.equal(f.read("independent"), "safe");
  sync.completeGitHubSyncTransaction(checkout, backup.id, result.transactionId);
});

test("an unpublished outbox keeps immutable Git bytes but retries revalidate instead of replaying stale content", async t => {
  const f = fixture(t), a = f.replica("prepared");
  a.write("content", "base\n");
  const base = await a.run();
  a.write("content", "prepared revision\n");
  const destination = path.join(a.checkout, a.target.id, "transactions/latest.json");
  const originalRename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === destination && JSON.parse(fs.readFileSync(source, "utf8")).state === "prepared")
      throw new Error("Prepared receipt persistence failed");
    return originalRename(source, target);
  };
  try { await assert.rejects(() => a.run(), /Prepared receipt persistence failed/); }
  finally { fs.renameSync = originalRename; }
  assert.equal(f.read("content"), "base", "no push precedes the durable prepared receipt");
  const repository = path.join(a.checkout, a.target.id, "repository");
  const prepared = git(repository, ["rev-parse", "refs/pkm/outbox"]);
  assert.notEqual(prepared, base.result.commit);
  a.write("content", "latest revision\n");
  assert.equal(git(repository, ["show", `${prepared}:notes/Shared/content.md`]), "prepared revision");
  await a.run();
  assert.equal(f.read("content"), "latest revision", "recovery re-fetches and reconciles current intent");
  const receipt = JSON.parse(fs.readFileSync(destination, "utf8"));
  assert.equal(receipt.preparedCommit, receipt.pushedCommit);
  fs.writeFileSync(destination, JSON.stringify({ ...receipt, state: "prepared", pushedCommit: "" }));
  assert.throws(() => sync.completeGitHubSyncTransaction(a.checkout, a.target.id, receipt.transactionId), /has not been pushed/);
  fs.writeFileSync(destination, JSON.stringify(receipt));
});

test("generated staging and Python caches are excluded but legitimate tmp/source files remain", () => {
  for (const file of ["scripts/.hypothesis/state/a", "scripts/.ipynb_checkpoints/notebook.ipynb",
    "scripts/__pycache__/module.pyc", "notes/file.md.123.012345abcd.tmp",
    "scripts/.source.py.0123456789abcdef0123456789abcdef.tmp", "scripts/.source.py.swp"]) {
    assert(sync.githubSyncIgnoredPath(file), file);
    assert(sync.githubSyncIgnoredPath(file.replaceAll("/", "\\")), file);
  }
  for (const file of ["scripts/data.tmp", "scripts/pyproject.toml", "scripts/uv.lock", "scripts/lib.so", "scripts/real.py"]) {
    assert(!sync.githubSyncIgnoredPath(file), file);
  }
});

test("an unstable entity is deferred rather than materialized as a deletion, while other entities publish", async t => {
  const f = fixture(t), a = f.replica("unstable");
  a.write("moving", "keep remote\n"); a.write("safe", "base\n");
  const initial = await a.run();
  const catalog = a.catalog();
  const source = path.join(a.store, "notes/Shared/moving.md");
  fs.unlinkSync(source);
  a.write("safe", "safe new\n");
  const result = await sync.syncGitHubTarget(a.target, catalog, a.checkout, undefined, a.store);
  assert.deepEqual(result.deferredEntities, ["notes\0Shared/moving"]);
  assert.equal(result.entityBases["notes\0Shared/moving"], initial.result.commit);
  assert.equal(f.read("moving"), "keep remote");
  assert.equal(f.read("safe"), "safe new");
  assert(!fs.existsSync(source));
});

test("partial progress never consumes failure budget or pauses the target", async () => {
  let now = Date.now(), executed = 0, paused = 0;
  const scheduler = new GitHubSyncScheduler({
    now: () => now, setTimeout: () => ({ unref() {} }), clearTimeout: () => {},
    execute: async () => {
      executed++;
      const error = new sync.GitHubSyncConflictError("remote", []);
      error.partialResult = {};
      throw error;
    }, shouldRetryFailure: () => false, onAutoPaused: () => paused++,
  });
  try {
    scheduler.configure([{ id: "partial", enabled: true, intervalMinutes: 1, syncOnChange: true }]);
    for (let index = 0; index < 5; index++) {
      now += 60_000;
      scheduler.request("partial", "manual");
      for (let flush = 0; flush < 5; flush++) await new Promise(resolve => setImmediate(resolve));
    }
    assert(executed >= 5);
    assert.equal(paused, 0);
    assert.equal(scheduler.snapshot().partial.status, "partial");
    assert(scheduler.snapshot().partial.nextSyncAt);
  } finally { scheduler.dispose(); }
});
