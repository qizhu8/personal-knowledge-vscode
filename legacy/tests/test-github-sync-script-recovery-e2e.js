#!/usr/bin/env node
// All writes and Git ref updates are confined to disposable repositories under this project.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const sync = require("../dist/sync/github-sync");
const identity = require("../dist/sync/github-sync-script-identity");
const conflicts = require("../dist/sync/github-sync-conflicts");
const { githubSyncCatalogInWorker } = require("../dist/sync/github-sync-catalog-worker");
const root = fs.mkdtempSync(path.join(process.cwd(), ".sync-script-recovery-e2e-"));
const git = (cwd, args) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const id = number => `script_${number.toString(16).padStart(24, "0")}`;
const metadata = (number, relatives) => ({ schema: "pkm.script/v1", knowledgeId: id(number),
  aliases: relatives.map(relative => `pkm://scripts/${relative.split("/").map(encodeURIComponent).join("/")}`) });
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
let scenarios = 0, refreshes = 0, assertions = 0;
const check = (value, message) => { assertions++; assert(value, message); };
function fixture(name) {
  const dir = path.join(root, name), remote = path.join(dir, "remote.git"), seed = path.join(dir, "seed");
  fs.mkdirSync(seed, { recursive: true });
  git(dir, ["init", "--bare", "--quiet", remote]); git(seed, ["init", "--quiet"]);
  git(seed, ["config", "user.name", "Synthetic"]); git(seed, ["config", "user.email", "synthetic@example.invalid"]);
  put(path.join(seed, "README.md"), "synthetic fixture\n");
  git(seed, ["add", "."]); git(seed, ["commit", "--quiet", "-m", "seed"]); git(seed, ["branch", "-M", "main"]);
  git(seed, ["remote", "add", "origin", remote]); git(seed, ["push", "--quiet", "-u", "origin", "main"]);
  git(dir, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  const machine = label => {
    const store = path.join(dir, label), catalog = Object.fromEntries(sync.GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
    fs.mkdirSync(store);
    git(store, ["init", "--quiet"]);
    const target = sync.normalizeGitHubSyncTarget({ name: label, repository: remote, branch: "main" }, () => `${name}-${label}`);
    target.selection.public.scripts.folders = [""];
    return { store, catalog, target };
  };
  const manifest = () => JSON.parse(git(dir, ["--git-dir", remote, "show", "main:.pkm-github-sync.json"]));
  const editRemote = mutate => {
    git(seed, ["fetch", "--quiet", "origin"]); git(seed, ["reset", "--hard", "--quiet", "origin/main"]);
    const manifestPath = path.join(seed, ".pkm-github-sync.json"), value = JSON.parse(fs.readFileSync(manifestPath));
    mutate(value, seed);
    put(manifestPath, JSON.stringify(value, null, 2) + "\n");
    git(seed, ["add", "-A"]); git(seed, ["commit", "--quiet", "-m", "synthetic remote update"]);
    git(seed, ["push", "--quiet", "origin", "main"]);
  };
  return { dir, remote, seed, machine, manifest, editRemote, checkouts: path.join(dir, "checkouts") };
}
function script(machine, relative, number, body = "one\n", withSidecar = true, aliases = [relative]) {
  const destination = `scripts/${relative}`, source = path.join(machine.store, destination);
  put(source, body);
  const item = { id: relative, label: path.basename(relative), cat: path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative),
    isPrivate: false, source, destination };
  if (withSidecar) {
    const sidecar = identity.syncScriptSidecarPath(destination), full = path.join(machine.store, sidecar);
    put(full, JSON.stringify(metadata(number, aliases), null, 2) + "\n");
    item.dependencies = [{ source: full, destination: sidecar }];
    item.identityAliases = metadata(number, aliases).aliases;
  }
  machine.catalog.scripts.push(item);
  return item;
}
function move(machine, item, relative, number, body) {
  fs.rmSync(item.source);
  for (const dependency of item.dependencies || []) fs.rmSync(dependency.source);
  machine.catalog.scripts = machine.catalog.scripts.filter(candidate => candidate !== item);
  return script(machine, relative, number, body, true, [item.destination.slice(8), relative]);
}
async function execute(f, machine, progress, remember = true) {
  const result = await sync.syncGitHubTarget(machine.target, machine.catalog, f.checkouts, undefined, machine.store, progress);
  // Simulate the host's refresh boundary with a fresh production worker catalog, not the old cached catalog.
  const fresh = await githubSyncCatalogInWorker({ root: machine.store, servers: [], recipes: [] });
  machine.catalog.scripts = fresh.scripts;
  refreshes++;
  if (remember) machine.target.lastSync = { at: new Date().toISOString(), commit: result.commit, fingerprints: result.fingerprints,
    repository: machine.target.repository, branch: machine.target.branch, storeRoot: path.resolve(machine.store) };
  return result;
}
function addRemoteSidecar(value, seed, relative, number) {
  const body = value.files.find(file => file.path === `scripts/${relative}`);
  const sidecar = identity.syncScriptSidecarPath(body.path), bytes = Buffer.from(JSON.stringify(metadata(number, [relative]), null, 2) + "\n");
  put(path.join(seed, sidecar), bytes);
  value.files.push({ ...body, path: sidecar, member: sidecar, digest: digest(bytes) });
}
async function rejection(action, pattern) {
  assertions++;
  await assert.rejects(action, error => pattern instanceof RegExp ? pattern.test(error.message) : pattern(error));
}
async function scenario(name, action) {
  await action(fixture(name)); scenarios++; console.log(`  PASS ${name}`);
}
(async () => {
  await scenario("114-moves-8-trash-7-tombstones", async f => {
    const machine = f.machine("local");
    for (let n = 1; n <= 122; n++) script(machine, `Old/item-${n}.script`, n, `line-${n}\r\n`, false);
    machine.target.selection.public.notes.folders = [""];
    for (let n = 1; n <= 7; n++) {
      const destination = `notes/Old/note-${n}.md`, source = path.join(machine.store, destination);
      put(source, `note-${n}\n`);
      machine.catalog.notes.push({ id: `note-${n}`, cat: "Old", isPrivate: false, source, destination });
    }
    // Keep old path IDs as the real pre-migration Base.
    const base = await sync.syncGitHubTarget(machine.target, machine.catalog, f.checkouts, undefined, machine.store);
    machine.target.lastSync = { at: "2026-09-30T18:21:50.978Z", commit: base.commit, fingerprints: base.fingerprints,
      repository: machine.target.repository, branch: "main", storeRoot: machine.store };
    f.editRemote((value, seed) => {
      for (let n = 1; n <= 122; n++) addRemoteSidecar(value, seed, `Old/item-${n}.script`, n);
      for (const file of value.files.filter(file => file.type === "notes")) {
        fs.rmSync(path.join(seed, file.path));
        value.deletions.push({ type: "notes", itemId: file.itemId, deletedAt: "2026-10-01T00:00:00Z", category: "Old", privacy: "public" });
      }
      value.files = value.files.filter(file => file.type !== "notes");
    });
    for (const item of [...machine.catalog.scripts]) {
      const n = Number(/item-(\d+)/.exec(item.destination)[1]);
      if (n <= 114) move(machine, item, `New/空 格 [${n}]/item-${n}.script`, n, n <= 7 ? `edited-${n}\r\n` : `line-${n}\r\n`);
      else {
        const directory = path.join(machine.store, "scripts/.trash/1790808635668-8376f8e664");
        put(path.join(directory, "metadata.json"), JSON.stringify({ id: "1790808635668-8376f8e664", kind: "folder", name: "Old",
          originalPath: "Old", deletedAt: "2026-09-30T22:50:35.669Z" }));
        put(path.join(directory, `payload/item-${n}.script`), `line-${n}\r\n`);
        put(path.join(directory, `payload/.item-${n}.script.pkm.json`), JSON.stringify(metadata(n, [`Old/item-${n}.script`])));
        fs.rmSync(item.source);
        machine.catalog.scripts = machine.catalog.scripts.filter(candidate => candidate !== item);
      }
    }
    for (const item of machine.catalog.notes) fs.rmSync(item.source);
    machine.catalog.notes = [];
    let review;
    await rejection(() => execute(f, machine), error => {
      review = error; return error instanceof sync.GitHubSyncConflictError && error.conflicts.length === 16;
    });
    check(review.conflicts.every(file => file.absenceEvidence.historicalTrash.length === 1), "all eight Trash identities carry verified evidence");
    check(review.conflicts.every(file => file.reason === "unrecorded-local-absence"), "historical evidence is not deletion approval");
    check(review.conflicts.every(file => file.baseCommit === base.commit), "true Base provenance survives identity alignment");
    const stored = conflicts.storeGitHubSyncConflict(path.join(f.dir, "state"), machine.target.id, review);
    for (const body of stored.files.filter(file => !file.member)) {
      conflicts.selectGitHubSyncConflictDeletion(path.join(f.dir, "state"), machine.target.id, body.path);
    }
    machine.target.pendingDeletions = Array.from({ length: 8 }, (_, n) => ({ type: "scripts", itemId: id(n + 115),
      deletedAt: "2026-10-14T00:00:00Z", category: "Old", privacy: "public" }));
    const result = await execute(f, machine);
    const value = f.manifest();
    check(value.files.filter(file => file.type === "scripts").length === 228, "114 bodies and exactly 114 sidecars published");
    check(value.files.every(file => !file.path.startsWith("scripts/Old/")), "all 122 old body/sidecar paths removed");
    check(value.deletions.filter(file => file.type === "scripts").length === 8, "eight approved Trash tombstones");
    check(value.deletions.filter(file => file.type === "notes").length === 7, "seven valid remote tombstones converge");
    check(new Set(value.files.filter(file => file.type === "scripts" && !file.member).map(file => file.itemId)).size === 114, "no duplicate primary identities");
    check(review.partialResult.resolutionReport.rules["move-edit"] > 0,
      "identity-aware moves published during partial progress, before deletion approval");
    for (let n = 1; n <= 7; n++) check(fs.readFileSync(path.join(machine.store, `scripts/New/空 格 [${n}]/item-${n}.script`), "utf8").startsWith(`edited-${n}`), "moved edits retained");
    machine.target.pendingDeletions = [];
    const repeated = await execute(f, machine);
    check(!repeated.changed && repeated.commit === result.commit, "repeated sync is no-change, no resurrection");
    check(git(f.dir, ["--git-dir", f.remote, "rev-parse", "main"]) === result.commit, "real fixture bare ref updated");
  });
  await scenario("move-and-remote-edit-alias-merge", async f => {
    const left = f.machine("left"), right = f.machine("right");
    script(left, "Old/a.script", 1); script(right, "Old/a.script", 1);
    await execute(f, left); await execute(f, right);
    move(left, left.catalog.scripts[0], "Moved/a.script", 1, "one\r\n");
    put(right.catalog.scripts[0].source, "remote edit\n"); await execute(f, right);
    await execute(f, left);
    check(fs.readFileSync(path.join(left.store, "scripts/Moved/a.script"), "utf8") === "remote edit\n", "remote edit merges at local destination");
    const sidecar = JSON.parse(fs.readFileSync(path.join(left.store, "scripts/Moved/.a.script.pkm.json")));
    check(sidecar.aliases.includes("pkm://scripts/Old/a.script") && sidecar.aliases.includes("pkm://scripts/Moved/a.script"), "validated alias union");
    const again = await execute(f, left); check(!again.changed, "merge refresh is idempotent");
  });
  await scenario("divergent-move", async f => {
    const left = f.machine("left"), right = f.machine("right");
    script(left, "Old/a.script", 1); script(right, "Old/a.script", 1);
    await execute(f, left); await execute(f, right);
    move(left, left.catalog.scripts[0], "Left/a.script", 1); await execute(f, left);
    move(right, right.catalog.scripts[0], "Right/a.script", 1);
    await rejection(() => execute(f, right), error => error instanceof sync.GitHubSyncConflictError
      && error.conflicts.some(file => file.localPath === "scripts/Right/a.script" && file.remotePath === "scripts/Left/a.script"));
  });
  await scenario("ambiguous-identity-copy", async f => {
    const machine = f.machine("local");
    script(machine, "A/a.script", 1); script(machine, "B/a.script", 1);
    const head = git(f.dir, ["--git-dir", f.remote, "rev-parse", "main"]);
    await rejection(() => execute(f, machine), /Ambiguous active Script identity/);
    check(git(f.dir, ["--git-dir", f.remote, "rev-parse", "main"]) === head, "ambiguity never publishes");
  });
  await scenario("same-name-hash-distinct-identities-and-path-reuse", async f => {
    const machine = f.machine("local");
    script(machine, "Old/a.script", 1); script(machine, "Other/a.script", 2);
    await execute(f, machine);
    move(machine, machine.catalog.scripts.find(item => item.destination === "scripts/Old/a.script"), "Moved/a.script", 1);
    script(machine, "Old/a.script", 3, "new owner\n");
    await execute(f, machine);
    const bodies = f.manifest().files.filter(file => !file.member);
    check(bodies.length === 3 && new Set(bodies.map(file => file.itemId)).size === 3, "same hash/name never supplies identity, reused old path survives");
    check(fs.readFileSync(path.join(machine.store, "scripts/Old/a.script"), "utf8") === "new owner\n", "old path new owner not deleted");
  });
  await scenario("old-item-selection-compatible", async f => {
    const machine = f.machine("local");
    script(machine, "Old/a.script", 1);
    machine.target.selection.public.scripts = { folders: [], items: ["Old/a.script"] };
    await execute(f, machine);
    move(machine, machine.catalog.scripts[0], "Moved/a.script", 1);
    await execute(f, machine);
    check(f.manifest().files.every(file => file.path.startsWith("scripts/Moved/")), "historical item selection preserves validated move");
  });
  await scenario("cross-privacy-selection-protected", async f => {
    const machine = f.machine("local");
    script(machine, "Old/a.script", 1); await execute(f, machine);
    const moved = move(machine, machine.catalog.scripts[0], "Private/a.script", 1, "secret\n");
    moved.isPrivate = true;
    machine.target.selection.private.scripts = { folders: [], items: [] };
    const head = git(f.dir, ["--git-dir", f.remote, "rev-parse", "main"]);
    await execute(f, machine);
    check(git(f.dir, ["--git-dir", f.remote, "rev-parse", "main"]) === head, "unselected private move neither publishes nor restores old public duplicate");
    check(!fs.existsSync(path.join(machine.store, "scripts/Old/a.script")), "private scope not bypassed by fallback ingest");
  });
  await scenario("ignored-moved-member-protects-entity", async f => {
    const machine = f.machine("local");
    script(machine, "Old/a.script", 1); await execute(f, machine);
    move(machine, machine.catalog.scripts[0], "Ignored/a.script", 1, "excluded edit\n");
    put(path.join(machine.store, ".gitignore"), "scripts/Ignored/\n");
    const head = git(f.dir, ["--git-dir", f.remote, "rev-parse", "main"]);
    await execute(f, machine);
    check(git(f.dir, ["--git-dir", f.remote, "rev-parse", "main"]) === head, "ignored destination preserves existing remote entity");
  });
  await scenario("approved-delete-metadata-only-versus-body-edit", async f => {
    const machine = f.machine("local");
    script(machine, "Old/a.script", 1, "one\n", false);
    const base = await sync.syncGitHubTarget(machine.target, machine.catalog, f.checkouts, undefined, machine.store);
    machine.target.lastSync = { at: new Date().toISOString(), commit: base.commit, fingerprints: base.fingerprints };
    f.editRemote((value, seed) => {
      addRemoteSidecar(value, seed, "Old/a.script", 1);
      const body = value.files.find(file => !file.member);
      put(path.join(seed, body.path), "remote changed\n"); body.digest = digest("remote changed\n");
    });
    fs.rmSync(machine.catalog.scripts[0].source); machine.catalog.scripts = [];
    machine.target.pendingDeletions = [{ type: "scripts", itemId: "Old/a.script", deletedAt: new Date().toISOString() }];
    await rejection(() => execute(f, machine), error => error instanceof sync.GitHubSyncConflictError
      && error.conflicts.some(file => file.remote.toString() === "remote changed\n"));
  });
  await scenario("stale-deletion-live-identity", async f => {
    const machine = f.machine("local"); script(machine, "Old/a.script", 1); await execute(f, machine);
    machine.target.pendingDeletions = [{ type: "scripts", itemId: id(1), deletedAt: new Date().toISOString() }];
    await rejection(() => execute(f, machine), error => error instanceof sync.GitHubSyncConflictError && error.conflicts.some(file => !!file.local));
    check(f.manifest().deletions.length === 0, "active identity invalidates stale local deletion");
  });
  await scenario("unknown-absence-never-infers-delete", async f => {
    const machine = f.machine("local"); script(machine, "Old/a.script", 1); await execute(f, machine);
    const source = machine.catalog.scripts[0].source;
    fs.rmSync(source); fs.rmSync(machine.catalog.scripts[0].dependencies[0].source); machine.catalog.scripts = [];
    await rejection(() => execute(f, machine), error => error instanceof sync.GitHubSyncConflictError && error.conflicts.every(file => file.reason === "unrecorded-local-absence"));
    check(!fs.existsSync(source), "absence review does not revive old body");
  });
  await scenario("old-workspace-restore-duplicate-guard", async f => {
    const machine = f.machine("local"); script(machine, "Moved/a.script", 1, "one\n", true, ["Old/a.script", "Moved/a.script"]);
    const file = { path: "scripts/Old/.a.script.pkm.json", remotePath: "scripts/Old/.a.script.pkm.json", type: "scripts", itemId: "Old/a.script", member: "scripts/Old/.a.script.pkm.json" };
    const body = { path: "scripts/Old/a.script", remotePath: "scripts/Old/a.script", type: "scripts", itemId: "Old/a.script", member: "" };
    assertions++;
    assert.throws(() => conflicts.validateGitHubSyncConflictScriptIdentity(machine.store, { files: [body, file] },
      [{ file: body, content: Buffer.from("one\n") }, { file, content: Buffer.from(JSON.stringify(metadata(1, ["Old/a.script"]))) }]), /active at scripts\/Moved/);
    assertions++;
    assert.throws(() => conflicts.validateGitHubSyncConflictScriptIdentity(machine.store, { files: [body] },
      [{ file: body, content: Buffer.from("one\n") }]), /active at scripts\/Moved/, "body-only legacy review still checks active aliases");
    const reviewed = { ...body, path: "scripts/Moved/a.script", localPath: "scripts/Moved/a.script", itemId: id(1), hasLocal: true };
    assertions++;
    assert.doesNotThrow(() => conflicts.validateGitHubSyncConflictScriptIdentity(machine.store, { files: [reviewed] },
      [{ file: reviewed }]), "explicitly reviewed live deletion still proceeds to its raw CAS guard");
  });
  await scenario("trash-invalid-and-restored-evidence", async f => {
    const machine = f.machine("local");
    const directory = path.join(machine.store, "scripts/.trash/1790808635668-8376f8e664");
    put(path.join(directory, "metadata.json"), JSON.stringify({ id: path.basename(directory), kind: "folder", originalPath: "../escape", deletedAt: new Date().toISOString() }));
    fs.mkdirSync(path.join(directory, "payload"));
    await rejection(() => execute(f, machine), /Invalid historical Script Trash metadata/);
    put(path.join(directory, "metadata.json"), JSON.stringify({ id: path.basename(directory), kind: "folder", originalPath: "Old", deletedAt: new Date().toISOString() }));
    put(path.join(directory, "payload/a.script"), "one\n");
    put(path.join(directory, "payload/.a.script.pkm.json"), JSON.stringify(metadata(1, ["Old/a.script"])));
    script(machine, "Restored/a.script", 1, "one\n", true, ["Old/a.script", "Restored/a.script"]);
    await execute(f, machine);
    check(f.manifest().deletions.length === 0 && f.manifest().files.length === 2, "active counterpart wins over historical Trash evidence");
  });
  await scenario("remote-tombstone-with-local-edit", async f => {
    const left = f.machine("left"), right = f.machine("right");
    script(left, "Old/a.script", 1); script(right, "Old/a.script", 1);
    await execute(f, left); await execute(f, right);
    fs.rmSync(left.catalog.scripts[0].source); fs.rmSync(left.catalog.scripts[0].dependencies[0].source);
    left.catalog.scripts = []; left.target.pendingDeletions = [{ type: "scripts", itemId: id(1), deletedAt: new Date().toISOString() }];
    await execute(f, left);
    put(right.catalog.scripts[0].source, "local edit\n");
    await rejection(() => execute(f, right), error => error instanceof sync.GitHubSyncConflictError && error.conflicts.some(file => file.hasRemote === undefined && file.local));
    check(fs.readFileSync(path.join(right.store, "scripts/Old/a.script"), "utf8") === "local edit\n", "live edited body is not deleted");
  });
  await scenario("guarded-apply-concurrent-edit-and-retry", async f => {
    const left = f.machine("left"), right = f.machine("right");
    script(left, "Old/a.script", 1); script(right, "Old/a.script", 1);
    await execute(f, left); await execute(f, right);
    put(left.catalog.scripts[0].source, "upstream\n"); await execute(f, left);
    const source = right.catalog.scripts[0].source, oldBase = right.target.lastSync.commit;
    let injected = false, failure;
    await rejection(() => execute(f, right, (_phase, detail) => {
      if (!injected && detail.startsWith("Verified")) { injected = true; put(source, "concurrent\r\n"); }
    }), error => { failure = error; return error instanceof sync.GitHubSyncConflictError && error.conflicts.some(file => file.reason === "concurrent-local-change"); });
    check(right.target.lastSync.commit === oldBase, "failed guarded apply never advances baseline");
    check(failure.conflicts.some(file => file.base?.toString() === "one\n" && file.expectedLocal?.toString() === "one\n"), "true Base and raw expectedLocal survive failed plan");
    check(fs.readFileSync(source, "utf8") === "concurrent\r\n", "CAS preserves actual concurrent edit");
    put(source, "one\n"); await execute(f, right); check(fs.readFileSync(source, "utf8") === "upstream\n", "retry converges to upstream");
    const again = await execute(f, right); check(!again.changed, "retry refresh no-change");
  });
  await scenario("live-and-tombstone-invalid-remote", async f => {
    const machine = f.machine("local"); script(machine, "Old/a.script", 1); await execute(f, machine);
    f.editRemote(value => value.deletions.push({ type: "scripts", itemId: id(1), deletedAt: new Date().toISOString() }));
    await rejection(() => execute(f, machine), /live entity with a tombstone/);
  });
  await scenario("partial-delete-apply-failed-baseline-retry", async f => {
    const left = f.machine("left"), right = f.machine("right");
    script(left, "Old/a.script", 1); script(right, "Old/a.script", 1);
    for (const machine of [left, right]) {
      const source = path.join(machine.store, "notes/Old/n.md");
      put(source, "note\n");
      machine.target.selection.public.notes.folders = [""];
      machine.catalog.notes.push({ id: "note", cat: "Old", isPrivate: false, source, destination: "notes/Old/n.md" });
    }
    await execute(f, left); await execute(f, right);
    const oldBase = right.target.lastSync.commit;
    fs.rmSync(left.catalog.notes[0].source); left.catalog.notes = [];
    left.target.pendingDeletions = [{ type: "notes", itemId: "note", deletedAt: new Date().toISOString() }];
    put(left.catalog.scripts[0].source, "upstream\n"); await execute(f, left);
    put(right.catalog.scripts[0].source, "local divergent\n");
    await rejection(() => execute(f, right), error => error instanceof sync.GitHubSyncConflictError && error.deletedLocal.includes("notes/Old/n.md"));
    check(!fs.existsSync(path.join(right.store, "notes/Old/n.md")) && right.target.lastSync.commit === oldBase, "partial deletion applied but Base remains unchanged");
    right.catalog.notes = []; put(right.catalog.scripts[0].source, "upstream\n");
    await execute(f, right);
    check(!fs.existsSync(path.join(right.store, "notes/Old/n.md")), "retry absent Local plus validated Remote tombstone converges without resurrection");
    const again = await execute(f, right); check(!again.changed, "partial-delete retry is idempotent");
  });
  await scenario("staged-blob-corruption-recovery", async f => {
    const machine = f.machine("local"); script(machine, "Old/a.script", 1); await execute(f, machine);
    put(machine.catalog.scripts[0].source, "planned update\n");
    const head = git(f.dir, ["--git-dir", f.remote, "rev-parse", "main"]);
    const checkout = path.join(f.checkouts, machine.target.id, "repository");
    let injected = false;
    await rejection(() => execute(f, machine, (_phase, detail) => {
      if (!injected && detail.startsWith("Index preparation completed")) {
        injected = true; put(path.join(checkout, "scripts/Old/a.script"), "tampered staged bytes\n");
        git(checkout, ["add", "--", "scripts/Old/a.script"]);
      }
    }), /staged|Staged/);
    check(git(f.dir, ["--git-dir", f.remote, "rev-parse", "main"]) === head, "staged digest failure never updates fixture remote");
    check(git(checkout, ["status", "--porcelain"]) === "", "checkout recovered after staging fault");
    await execute(f, machine); check(f.manifest().files.find(file => !file.member).digest === digest("planned update\n"), "fault-free retry publishes only validated blob");
  });
  await scenario("rejected-push-recovery", async f => {
    const machine = f.machine("local"); script(machine, "Old/a.script", 1); await execute(f, machine);
    put(machine.catalog.scripts[0].source, "planned update\n");
    const hook = path.join(f.remote, "hooks/pre-receive"), head = git(f.dir, ["--git-dir", f.remote, "rev-parse", "main"]);
    put(hook, "#!/bin/sh\nprintf 'synthetic push rejection\\n' >&2\nexit 1\n"); fs.chmodSync(hook, 0o755);
    await rejection(() => execute(f, machine), /synthetic push rejection/);
    check(git(f.dir, ["--git-dir", f.remote, "rev-parse", "main"]) === head, "rejected push leaves remote unchanged");
    const checkout = path.join(f.checkouts, machine.target.id, "repository");
    check(git(checkout, ["status", "--porcelain"]) === "" && git(checkout, ["rev-parse", "HEAD"]) === head, "failed push resets fixture checkout");
    fs.rmSync(hook); await execute(f, machine);
    check(git(f.dir, ["--git-dir", f.remote, "rev-parse", "main"]) !== head, "retry commits and pushes after rejection is removed");
  });
  await scenario("invalid-alias-and-metadata-provenance", async f => {
    const machine = f.machine("local"), item = script(machine, "Old/a.script", 1);
    put(item.dependencies[0].source, JSON.stringify({ ...metadata(1, ["Old/a.script"]), aliases: ["pkm://scripts/Old/%2e%2e/escape.script"] }));
    await rejection(() => execute(f, machine), /Invalid Script identity/);
    put(item.dependencies[0].source, JSON.stringify({ ...metadata(1, ["Old/a.script"]), unexpected: "not publication metadata" }));
    await rejection(() => execute(f, machine), /Invalid Script identity/);
    put(item.dependencies[0].source, JSON.stringify(metadata(1, ["Old/a.script"])));
    await execute(f, machine);
    f.editRemote((value, seed) => {
      const sidecar = value.files.find(file => file.member);
      const bytes = Buffer.from(JSON.stringify(metadata(2, ["Old/a.script"])) + "\n");
      put(path.join(seed, sidecar.path), bytes); sidecar.digest = digest(bytes);
    });
    await rejection(() => execute(f, machine), /manifest identity does not match its sidecar/);
  });
  for (const distinct of [false, true]) await scenario(`schema2-base-${distinct ? "same-hash-distinct-id" : "validated-move"}`, async f => {
    const machine = f.machine("local"), original = script(machine, "Old/a.script", 1, "one\n", false);
    const first = await sync.syncGitHubTarget(machine.target, machine.catalog, f.checkouts, undefined, machine.store);
    f.editRemote(value => { value.schema = 2; delete value.capabilities; });
    const legacyBase = git(f.dir, ["--git-dir", f.remote, "rev-parse", "main"]);
    machine.target.lastSync = { at: new Date().toISOString(), commit: legacyBase, fingerprints: first.fingerprints };
    f.editRemote((value, seed) => {
      value.schema = 3; value.capabilities = { storage: "pkm.github.publication/v1", required: ["explicit-deletions", "stable-entity-identity"] };
      if (distinct) {
        const body = value.files[0]; fs.rmSync(path.join(seed, body.path));
        body.path = "scripts/Unrelated/a.script"; body.itemId = id(2); body.category = "Unrelated";
        put(path.join(seed, body.path), "one\n");
        addRemoteSidecar(value, seed, "Unrelated/a.script", 2);
      } else addRemoteSidecar(value, seed, "Old/a.script", 1);
    });
    move(machine, original, "Moved/a.script", 1, "one\n");
    if (distinct) {
      await rejection(() => execute(f, machine), error => error instanceof sync.GitHubSyncConflictError
        && error.conflicts.some(file => file.itemId === id(1) && file.reason === "remote-deletion"));
      check(f.manifest().files.every(file => file.itemId === id(2)), "legacy migration never assigns ancestry based on identical body hashes");
    } else {
      await execute(f, machine);
      check(f.manifest().files.every(file => file.itemId === id(1) && file.path.startsWith("scripts/Moved/")), "schema2 Base aligns through validated path aliases without inventing a Base sidecar");
    }
  });
  console.log(`Script identity recovery E2E: ${scenarios} scenarios, ${assertions} assertions, ${refreshes} fresh-worker refresh callbacks passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
