import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initialize, Storage, validateWorkspace } from "../dist/storage.js";
import { RootOwner } from "../dist/root-owner.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { inspectWorkspaceStorage, migrateWorkspaceStorage, resetFreshNoteIndex } from "../dist/workspace-storage-migration.js";
import { coreDatabasePath, codingProcessDatabasePath, workspaceStoragePaths,
  storageLayoutMarker, storageMigrationJournal } from "../dist/workspace-storage-paths.js";
import { acquireSharedManagerControlGuard } from "../dist/shared-manager-control.js";
import { githubSyncIgnoredPath } from "../dist/sync-storage-boundary.js";
import { scanMarkdown } from "../dist/markdown.js";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture(t, layout = "flat") {
  const parent = resolve(".migration-test-work", `storage-separation-${randomUUID()}`);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await initialize(join(parent, "root"), { storageLayout: layout });
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { root, parent };
}
function rows(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => ({
      name, rows: db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort(),
    }));
  } finally { db.close(); }
}
const note = "---\ndocumentId: entry\ntitle: Exact durable title\nrevision: 1\ndeleted: false\n---\nneedle body\n";

test("offline migration preserves all durable rows, source bytes, receipt replay and the coding journal across restart", async t => {
  const { root } = await fixture(t);
  const storage = await Storage.open(root);
  const request = { operation: "knowledge.document.create", actorId: "test:owner", args: {
    id: "preserved", operationId: randomUUID(), title: "Preserved", content: "exact source bytes",
  } };
  let receipt;
  try {
    receipt = await storage.request(request);
    const process = storage.connectCodingProcess();
    try { process.prepare("INSERT INTO runtime_process_owner VALUES(1,?,1)").run(randomUUID()); }
    finally { process.close(); }
  } finally { await storage.close(); }
  const before = rows(coreDatabasePath(root)), processes = rows(codingProcessDatabasePath(root));
  const markdown = await readFile(join(root, "notes/preserved.md"));
  const result = await migrateWorkspaceStorage(root);
  assert.equal(result.layout, "separated");
  assert.deepEqual(rows(coreDatabasePath(root)), before);
  assert.deepEqual(rows(codingProcessDatabasePath(root)), processes);
  assert.deepEqual(await readFile(join(root, "notes/preserved.md")), markdown);
  await assert.rejects(lstat(join(root, "core.sqlite")), { code: "ENOENT" });
  const reopened = await Storage.open(root);
  try { assert.deepEqual(await reopened.request(request), receipt); }
  finally { await reopened.close(); }
  assert.equal((await migrateWorkspaceStorage(root)).layout, "separated", "repeat migration is a no-op");
});

test("interrupted relocation is refused by startup and resumes from either verified file location", async t => {
  for (const moved of [false, true]) {
    const { root } = await fixture(t);
    const db = new DatabaseSync(coreDatabasePath(root));
    db.exec("CREATE TABLE forensic_history(value TEXT); INSERT INTO forensic_history VALUES('never discard');");
    db.close();
    const bytes = await readFile(coreDatabasePath(root)), inspection = inspectWorkspaceStorage(root);
    await writeFile(join(root, storageMigrationJournal), JSON.stringify({
      schema: "pkm.workspace-storage-migration/v1", workspaceId: inspection.workspaceId, rootPin: inspection.rootPin,
      files: [{ name: "core.sqlite", sha256: digest(bytes), size: bytes.length }],
    }), { mode: 0o600 });
    if (moved) {
      await mkdir(join(root, "server-data"), { mode: 0o700 });
      await rename(join(root, "core.sqlite"), join(root, "server-data/core.sqlite"));
    }
    await assert.rejects(Storage.open(root), { code: "RECOVERY_REQUIRED" });
    assert.equal(inspectWorkspaceStorage(root).layout, "migration-pending");
    await migrateWorkspaceStorage(root);
    assert.deepEqual(await readFile(coreDatabasePath(root)), bytes);
    const verify = new DatabaseSync(coreDatabasePath(root));
    try { assert.equal(verify.prepare("SELECT value FROM forensic_history").get().value, "never discard"); }
    finally { verify.close(); }
  }
});

test("offline model relocation preserves complete opaque managed trees without merging runtime destinations", async t => {
  const { root } = await fixture(t);
  const source = join(root, "packages", "retrieval-models");
  await mkdir(join(root, "packages"), { mode: 0o700 });
  await mkdir(source, { mode: 0o700 });
  await mkdir(join(source, ".stage-preserved"), { mode: 0o700 });
  const weights = Buffer.from([0, 1, 255, 17]);
  await writeFile(join(source, ".stage-preserved/model.bin"), weights, { mode: 0o600 });
  await mkdir(join(root, "runtime"), { mode: 0o700 });
  await mkdir(join(root, "runtime/retrieval-models"), { mode: 0o700 });
  await assert.rejects(migrateWorkspaceStorage(root), /Both model locations exist/);
  assert.deepEqual(await readFile(join(source, ".stage-preserved/model.bin")), weights);
  await rm(join(root, "runtime/retrieval-models"), { recursive: true });
  await migrateWorkspaceStorage(root);
  assert.deepEqual(await readFile(join(workspaceStoragePaths(root).retrievalModels, ".stage-preserved/model.bin")), weights);
  await assert.rejects(lstat(source), { code: "ENOENT" });
});

test("migration never overwrites conflicting data, follows links or relocates legacy custody", async t => {
  const { root, parent } = await fixture(t, "separated");
  await cp(coreDatabasePath(root), join(root, "core.sqlite"));
  const flat = await readFile(join(root, "core.sqlite"));
  await assert.rejects(Storage.open(root), { code: "RECOVERY_REQUIRED" });
  await assert.rejects(migrateWorkspaceStorage(root), { code: "RECOVERY_REQUIRED" });
  assert.deepEqual(await readFile(join(root, "core.sqlite")), flat);
  await rm(join(root, "core.sqlite"));
  await mkdir(join(root, "runtime-control"), { mode: 0o700 });
  await assert.rejects(Storage.open(root), /Flat runtime controls coexist/);
  await rm(join(root, "runtime-control"), { recursive: true });
  await writeFile(join(root, ".pkm-next-root-adoption.json"), "{}");
  await assert.rejects(migrateWorkspaceStorage(root), /fixed legacy path contracts/);
  await rm(join(root, ".pkm-next-root-adoption.json"));
  await mkdir(join(parent, "foreign"), { mode: 0o700 });
  await rm(join(root, "server-data"), { recursive: true });
  await symlink(join(parent, "foreign"), join(root, "server-data"));
  await assert.rejects(validateWorkspace(root), { code: "INVALID_WORKSPACE" });
});

test("online migration and derived reset refuse the real owner's writer fence without changing durable bytes", async t => {
  const { root } = await fixture(t, "separated");
  const owner = await RootOwner.open(root);
  const before = rows(coreDatabasePath(root));
  try {
    await assert.rejects(migrateWorkspaceStorage(root), { code: "BUSY" });
    await assert.rejects(resetFreshNoteIndex(root), { code: "BUSY" });
    assert.deepEqual(rows(coreDatabasePath(root)), before);
    await assert.rejects(lstat(join(root, storageMigrationJournal)), { code: "ENOENT" });
  } finally { await owner.close(); }
});

test("separated basic and worker Note indexes rebuild after explicit offline reset without touching source or durable state", async t => {
  const { root } = await fixture(t, "separated");
  await writeFile(join(root, "notes/entry.md"), note, { mode: 0o600 });
  let owner = await RootOwner.open(root);
  const list = () => owner.withReadScope(scope => owner.readBasicLegacyNotes(scope, { kind: "list", arguments: {} }));
  try {
    const first = await list();
    assert.match(first.text, /Exact durable title/);
    const core = owner.connectNative();
    try { assert.equal(core.prepare("SELECT 1 FROM sqlite_master WHERE name='fresh_note_query_fts'").get(), undefined); }
    finally { core.close(); }
  } finally { await owner.close(); }
  const durable = rows(coreDatabasePath(root));
  assert.ok((await resetFreshNoteIndex(root)).removed.includes("fresh-note.sqlite"));
  assert.deepEqual(rows(coreDatabasePath(root)), durable);
  assert.equal(await readFile(join(root, "notes/entry.md"), "utf8"), note);
  owner = await RootOwner.open(root);
  try {
    assert.match((await list()).text, /Exact durable title/);
    const full = await owner.ensureFull();
    const first = await owner.withReadScope(scope => full.storage.readLegacyNotes(scope, { kind: "list", arguments: {} }));
    assert.equal(first.kind, "fresh");
    const core = full.storage.connectNative();
    try {
      assert.equal(core.prepare("SELECT title FROM documents WHERE id='entry'").get().title, "Exact durable title");
      assert.equal(core.prepare("SELECT 1 FROM sqlite_master WHERE name='fresh_note_query_fts'").get(), undefined);
      core.exec("UPDATE documents SET title='forged-core-projection'");
      const repaired = await owner.withReadScope(scope => full.storage.readLegacyNotes(scope, { kind: "list", arguments: {} }));
      assert.equal(repaired.kind, "fresh");
      assert.ok(repaired.generation > first.generation);
      assert.equal(core.prepare("SELECT title FROM documents WHERE id='entry'").get().title, "Exact durable title");
    } finally { core.close(); }
  } finally { await owner.close(); }
});

test("portable backup excludes managed bytes/host credentials and restores both durable journals", async t => {
  const { root, parent } = await fixture(t, "separated");
  const storage = await Storage.open(root), processOwner = randomUUID();
  try {
    await storage.request({ operation: "knowledge.document.create", actorId: "test:owner", args: {
      id: "portable", operationId: randomUUID(), title: "Portable", content: "user content",
    } });
    const coding = storage.connectCodingProcess();
    try { coding.prepare("INSERT INTO runtime_process_owner VALUES(1,?,1)").run(processOwner); }
    finally { coding.close(); }
    await mkdir(workspaceStoragePaths(root).runtime, { mode: 0o700 });
    await writeFile(join(workspaceStoragePaths(root).runtime, "not-user-data"), "rebuild me");
    await mkdir(join(root, ".pkm-action-authority"), { mode: 0o700 });
    await writeFile(join(root, ".pkm-action-authority/host-authority.json"), '{"secret":"never-export"}', { mode: 0o600 });
    const destination = join(parent, "backup");
    await createWorkspaceBackup(storage, destination, {
      async acquireQuiescence() { return { assertHeld() {}, release() {} }; },
    });
    const entries = await readdir(destination);
    assert.ok(entries.includes("core.sqlite") && entries.includes("coding-process.sqlite"));
    for (const excluded of ["runtime", "server-data", storageLayoutMarker, ".pkm-action-authority"])
      assert.ok(!entries.includes(excluded));
    const restored = join(parent, "restored");
    await restoreWorkspaceBackup(destination, restored, { nativeRestoreAuthority: {
      actorId: "test:owner", async authorize(request) {
        return { authorityId: "fixture", actorId: request.actorId, requestSha256: digest(Buffer.from(JSON.stringify(request))),
          expiresAt: Date.now() + 60_000, lineage: "unrelated", trustedEpoch: null };
      },
    } });
    await migrateWorkspaceStorage(restored);
    const process = new DatabaseSync(codingProcessDatabasePath(restored), { readOnly: true });
    try { assert.equal(process.prepare("SELECT owner_id FROM runtime_process_owner").get().owner_id, processOwner); }
    finally { process.close(); }
    assert.deepEqual(await readFile(join(restored, "notes/portable.md")), await readFile(join(root, "notes/portable.md")));
  } finally { await storage.close(); }
});

    function git(root, ...args) {
      const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    }

    test("existing user Git requires additive opt-in and never stages private server/runtime data", async t => {
      const { root, parent } = await fixture(t);
      git(root, "init", "--quiet");
      git(root, "remote", "add", "origin", "https://example.invalid/user/knowledge.git");
      const prefix = "# user's exact bytes\n*.scratch";
      await writeFile(join(root, ".gitignore"), prefix, { mode: 0o600 });
      const config = await readFile(join(root, ".git/config"));
      await assert.rejects(migrateWorkspaceStorage(root), /explicit|protect-user-git|consent/i);
      assert.equal(await readFile(join(root, ".gitignore"), "utf8"), prefix);
      await migrateWorkspaceStorage(root, { protectUserGit: true });
      assert.ok((await readFile(join(root, ".gitignore"), "utf8")).startsWith(prefix + "\n"));
      assert.deepEqual(await readFile(join(root, ".git/config")), config);
      await mkdir(join(root, "runtime"), { mode: 0o700 });
      await writeFile(join(root, "runtime/model.bin"), "not user Knowledge", { mode: 0o600 });
      await writeFile(join(root, "server-data/private.txt"), "not user Knowledge", { mode: 0o600 });
      await writeFile(join(root, "notes/entry.md"), note, { mode: 0o600 });
      git(root, "add", "-A");
      const paths = git(root, "ls-files", "-z").split("\0").filter(Boolean);
      assert.ok(paths.includes("notes/entry.md") && paths.includes(".gitignore"));
      assert.ok(paths.every(path => !/^(?:runtime\/|server-data\/|\.pkm-|core\.sqlite|coding-process\.sqlite)/.test(path)));
      await rm(join(root, "server-data/private.txt"));
      await validateWorkspace(root);

      const tracked = await initialize(join(parent, "tracked"));
      const trackedStorage = await Storage.open(tracked);
      await trackedStorage.close();
      git(tracked, "init", "--quiet");
      git(tracked, "add", "--", "core.sqlite");
      const bytes = await readFile(coreDatabasePath(tracked));
      await assert.rejects(migrateWorkspaceStorage(tracked, { protectUserGit: true }), /already tracked/);
      assert.deepEqual(await readFile(coreDatabasePath(tracked)), bytes);
      await assert.rejects(lstat(join(tracked, storageMigrationJournal)), { code: "ENOENT" });
    });

    test("native Sync and Knowledge scanning exclude root private layers but retain nested user names", async t => {
      const { root } = await fixture(t, "separated");
      await mkdir(join(root, "runtime"), { mode: 0o700 });
      for (const directory of ["runtime", "server-data", "notes/runtime", "notes/server-data"]) {
        await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
        await writeFile(join(root, directory, "entry.md"), note.replaceAll("entry", directory.replaceAll("/", "-")), { mode: 0o600 });
      }
      const scanned = scanMarkdown(root).map(item => item.record.path).sort();
      assert.deepEqual(scanned, ["runtime/entry.md", "server-data/entry.md"]);
      for (const path of ["server-data/core.sqlite", "server-data/runtime-control/shared-manager/shared-manager.json", "runtime-control/shared-manager/shared-manager.json",
        "runtime/retrieval-models/model.bin", "Runtime\\model.bin", ".pkm-action-authority/host-authority.json"])
        assert.ok(githubSyncIgnoredPath(path), path);
      for (const path of ["notes/runtime/entry.md", "notes/server-data/entry.md", ".pkm-github-sync.json"])
        assert.equal(githubSyncIgnoredPath(path), false, path);
    });

    test("durable control backup holds real guards, refuses unresolved state and preserves closed history on restore", async t => {
      const { root, parent } = await fixture(t, "separated");
      const storage = await Storage.open(root), control = workspaceStoragePaths(root).runtimeControl;
      await mkdir(join(control, "shared-manager"), { recursive: true, mode: 0o700 });
      const generation = randomUUID(), id = randomUUID(), workspaceId = JSON.parse(await readFile(join(root, ".pkm-next-workspace"))).id;
      const history = { schema: "pkm.managed-runtime-history/v1",
        transitions: [{ sequence: 1, from: null, to: generation, phase: "switched", dataRollback: false }], retired: [] };
      const manager = { schema: "pkm.shared-manager/v1", serviceId: randomUUID(), managedRoot: join(root, "runtime/managed-server"),
        phase: "closed", generation, workspaceId, dataPath: root, receipts: [], backendKind: "standalone-core",
        revokedCredentials: [digest(Buffer.from("revoked-high-entropy-business-token-fingerprint-fixture"))],
        history: [{ id, action: "recover", from: null, to: generation, phase: "interrupted", at: Date.now(),
          bodySha256: digest(Buffer.from("exact-management-recovery-body")) },
          { id: randomUUID(), action: "reconcile", from: generation, to: generation, phase: "completed", at: Date.now(),
            receiptId: randomUUID(), clientId: randomUUID(), tool: "note_write" },
          { id: randomUUID(), action: "revoke-access", from: generation, to: generation, phase: "completed", at: Date.now() }] };
      const managerPath = join(control, "shared-manager/shared-manager.json"), historyPath = join(control, "managed-runtime-history.json");
      const saveManager = value => writeFile(managerPath, JSON.stringify(value) + "\n", { mode: 0o600 });
      const saveHistory = value => writeFile(historyPath, JSON.stringify(value) + "\n", { mode: 0o600 });
      const host = { async acquireQuiescence() { return { assertHeld() {}, release() {} }; } };
      const backup = suffix => createWorkspaceBackup(storage, join(parent, suffix), host);
      try {
        await saveManager(manager); await saveHistory(history);
        for (const guard of [join(control, ".managed-runtime-history.guard"), join(control, "shared-manager/shared-manager.guard")]) {
          const live = await acquireSharedManagerControlGuard(guard);
          try { await assert.rejects(backup(`live-${randomUUID()}`), /not quiescent|already held/); }
          finally { await live.release(); }
        }
        for (const outcome of ["pending", "unknown"]) {
          await saveManager({ ...manager, receipts: [{ id: randomUUID(), clientId: randomUUID(), tool: "note_write", generation, outcome }] });
          const bytes = await readFile(managerPath);
          await assert.rejects(backup(outcome), /pending\/unknown/);
          assert.deepEqual(await readFile(managerPath), bytes);
        }
        await saveManager({ ...manager, phase: "accepting" });
        await assert.rejects(backup("accepting"), /Close the shared manager/);
        await saveManager({ ...manager, history: [{ ...manager.history[0], phase: "prepared" }] });
        await assert.rejects(backup("manager-prepared"), /reconcile/);
        await saveManager(manager);
        await saveHistory({ ...history, transitions: [{ ...history.transitions[0], phase: "prepared" }] });
        await assert.rejects(backup("runtime-prepared"), /unresolved managed-runtime transition/);
        await saveHistory(history);
        for (const path of [managerPath, historyPath]) {
          const pending = `${path}.${randomUUID()}.pending`;
          await writeFile(pending, "interrupted", { mode: 0o600 });
          await assert.rejects(backup(`atomic-pending-${randomUUID()}`), /interrupted atomic/);
          await rm(pending);
        }
        await saveManager({ ...manager, token: "must-not-export" });
        await assert.rejects(backup("unknown-secret-field"));
        for (const revokedCredentials of [[...manager.revokedCredentials, ...manager.revokedCredentials], ["raw-token-must-not-export"]]) {
          await saveManager({ ...manager, revokedCredentials });
          await assert.rejects(backup(`invalid-revocations-${randomUUID()}`));
        }
        await saveManager(manager);
        await mkdir(join(root, "runtime/managed-server"), { recursive: true, mode: 0o700 });
        await writeFile(join(root, "runtime/managed-server/runtime-lifecycle.json"), JSON.stringify(history), { mode: 0o600 });
        const savedHistory = join(parent, "preserved-history.json");
        await rename(historyPath, savedHistory);
        await assert.rejects(backup("legacy-history-outside-durable"), /cleanup to migrate history/);
        await rename(savedHistory, historyPath);

        await backup("closed");
        const archive = join(parent, "closed");
        assert.deepEqual(await readFile(join(archive, "runtime-control/shared-manager/shared-manager.json")), await readFile(managerPath));
        assert.deepEqual(await readFile(join(archive, "runtime-control/managed-runtime-history.json")), await readFile(historyPath));
        assert.deepEqual((await readdir(join(archive, "runtime-control"))).sort(), ["managed-runtime-history.json", "shared-manager"]);
        assert.deepEqual(await readdir(join(archive, "runtime-control/shared-manager")), ["shared-manager.json"]);
        assert.ok(!(await readdir(archive)).includes(".gitignore"), "portable user backup repository must not inherit private-source ignores");
        const restored = join(parent, "restored-controls");
        await restoreWorkspaceBackup(archive, restored, { nativeRestoreAuthority: {
          actorId: "test:owner", async authorize(request) {
            return { authorityId: "fixture", actorId: request.actorId, requestSha256: digest(Buffer.from(JSON.stringify(request))),
              expiresAt: Date.now() + 60_000, lineage: "unrelated", trustedEpoch: null };
          },
        } });
        assert.equal(workspaceStoragePaths(restored).layout, "separated");
        await assert.rejects(lstat(join(restored, "runtime-control")), { code: "ENOENT" });
        for (const file of ["managed-runtime-history.json", "shared-manager/shared-manager.json"])
          assert.deepEqual(await readFile(join(workspaceStoragePaths(restored).runtimeControl, file)), await readFile(join(control, file)));
        await validateWorkspace(restored);
        const reopened = await Storage.open(restored);
        await reopened.close();
      } finally { await storage.close(); }
    });

    test("offline migration relocates durable runtime-control history without replacing existing control locations", async t => {
      const { root } = await fixture(t), control = workspaceStoragePaths(root).runtimeControl;
      await mkdir(control, { mode: 0o700 });
      const bytes = JSON.stringify({ schema: "pkm.managed-runtime-history/v1", transitions: [], retired: [] });
      await writeFile(join(control, "managed-runtime-history.json"), bytes, { mode: 0o600 });
      await migrateWorkspaceStorage(root);
      assert.equal(await readFile(join(workspaceStoragePaths(root).runtimeControl, "managed-runtime-history.json"), "utf8"), bytes);
      await assert.rejects(lstat(control), { code: "ENOENT" });
      await validateWorkspace(root);
    });

test("durable-control relocation resumes after actual process exit before or after directory publication", async t => {
  for (const phase of ["before", "after"]) {
    const { root } = await fixture(t), control = workspaceStoragePaths(root).runtimeControl;
    await mkdir(control, { mode: 0o700 });
    const history = JSON.stringify({ schema: "pkm.managed-runtime-history/v1",
      transitions: [{ sequence: 1, from: null, to: randomUUID(), phase: "switched", dataRollback: false }], retired: [] });
    await writeFile(join(control, "managed-runtime-history.json"), history, { mode: 0o600 });
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      const execute = childProcess.execFileSync;
      childProcess.execFileSync = (command, args, options) => {
        const relocation = args.includes(process.argv[1] + "/runtime-control")
          && args.includes(process.argv[1] + "/server-data/runtime-control");
        if (relocation && process.argv[2] === "before") process.exit(77);
        const result = execute(command, args, options);
        if (relocation) process.exit(77);
        return result;
      };
      syncBuiltinESMExports();
      const { migrateWorkspaceStorage } = await import("./dist/workspace-storage-migration.js");
      await migrateWorkspaceStorage(process.argv[1]);
    `, root, phase], { encoding: "utf8" });
    assert.equal(child.status, 77, child.stderr);
    await assert.rejects(Storage.open(root), { code: "RECOVERY_REQUIRED" });
    assert.equal(inspectWorkspaceStorage(root).layout, "migration-pending");
    await migrateWorkspaceStorage(root);
    assert.equal(await readFile(join(workspaceStoragePaths(root).runtimeControl, "managed-runtime-history.json"), "utf8"), history);
    await validateWorkspace(root);
  }
});
