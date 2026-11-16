import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { legacyKnowledgeWrite } from "../dist/legacy-knowledge-write.js";
import { acquireLinuxRootWriterFence } from "../dist/linux-root-writer-fence.js";
import { planLegacyImport, importLegacyWorkspace } from "../dist/legacy-import.js";
import { bindLinuxActiveVscodeMigrationHost } from "../dist/linux-legacy-writer-quiescence.js";
import { activateActiveVscodeMigrationHost, assertActiveVscodeMigrationGrant } from "../dist/active-vscode-migration-host.js";
import {
  legacyRootAdoptionLockDirectory,
  adoptLegacyRootInPlaceExperimental,
  prepareLegacyRootAdoptionExperimental,
  resumeLegacyRootAdoptionExperimental,
  rollbackPreparedLegacyRootAdoptionExperimental,
  rollbackCommittedLegacyRootAdoptionExperimental,
  inspectLegacyRootAdoptionRecoveryExperimental,
} from "../dist/legacy-root-adoption.js";

const testsRoot = fileURLToPath(new URL(".", import.meta.url));
const digest = value => createHash("sha256").update(value).digest("hex");
const quiescence = { assertHeld() {}, release() {} };
const require = createRequire(import.meta.url);

async function snapshot(root) {
  const entries = [];
  async function visit(directory, prefix = "") {
    for (const name of (await readdir(directory)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      const full = join(directory, name);
      const stat = await lstat(full, { bigint: true });
      entries.push({
        path,
        kind: stat.isDirectory() ? "directory" : "file",
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        mode: Number(stat.mode & 0o777n),
        size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString(),
        ...(stat.isFile() ? { sha256: digest(await readFile(full)) } : {}),
      });
      if (stat.isDirectory()) await visit(full, path);
    }
  }
  await visit(root);
  return entries;
}

function createChatroom(root, roomId = "legacy-room-01") {
  const directory = join(root, "chatrooms", roomId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(join(directory, "chatroom.db"));
  try {
    database.exec(`
      PRAGMA journal_mode=DELETE;
      CREATE TABLE room_metadata(room_id TEXT, schema_version INTEGER, current_name TEXT, state TEXT);
      CREATE TABLE room_events(id INTEGER PRIMARY KEY, event_json TEXT);
      CREATE TABLE messages(sequence INTEGER PRIMARY KEY, message_id TEXT, participant_id TEXT, alias_at_send TEXT,
        sender_kind TEXT, message_type TEXT, content TEXT, metadata_json TEXT, created_at INTEGER);
      CREATE TABLE memberships(participant_id TEXT, joined_at INTEGER);
      CREATE TABLE alias_history(participant_id TEXT, alias TEXT, changed_at INTEGER);
      CREATE TABLE pending_joins(id TEXT, status TEXT);
      INSERT INTO room_metadata VALUES('${roomId}', 2, 'Archived synthetic room', 'stored');
      INSERT INTO messages VALUES(1, 'legacy-message-1', 'legacy-participant', 'Old alias',
        'human', 'chat', 'Original synthetic archive content', NULL, 1700000000000);
    `);
  } finally { database.close(); }
}
async function fixture(t, { pkm = false, legacySurfaces = false, chatroom = false } = {}) {
  const root = resolve(testsRoot, `.legacy-root-adoption-${randomUUID()}`);
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "notes", "Existing.md"),
    "---\ntitle: Existing\ndocumentId: synthetic-note\nrevision: 1\n---\nOriginal synthetic content.\n",
    { mode: 0o600 });
  if (pkm) {
    await mkdir(join(root, ".pkm", "state", "actions"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, ".pkm", "content-privacy.json"),
      "{\"schema\":1,\"private\":{\"notes\":[\"Chatroom Meetings\"]}}", { mode: 0o600 });
    await writeFile(join(root, ".pkm", "state", "actions", "mutation-lease"), "", { mode: 0o600 });
  }
  if (legacySurfaces) {
    await mkdir(join(root, ".git", "hooks"), { recursive: true, mode: 0o775 });
    await mkdir(join(root, ".git", "info"), { recursive: true, mode: 0o775 });
    await mkdir(join(root, ".git", "objects", "info"), { recursive: true, mode: 0o775 });
    await mkdir(join(root, ".git", "objects", "pack"), { recursive: true, mode: 0o775 });
    await mkdir(join(root, ".git", "refs", "heads"), { recursive: true, mode: 0o775 });
    await mkdir(join(root, ".git", "refs", "tags"), { recursive: true, mode: 0o775 });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/master\n", { mode: 0o664 });
    await writeFile(join(root, ".git", "config"),
      "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n",
      { mode: 0o664 });
    await writeFile(join(root, ".git", "description"), "Synthetic local repository.\n", { mode: 0o664 });
    await writeFile(join(root, ".git", "index"), "Synthetic inert index bytes.\n", { mode: 0o664 });
    await writeFile(join(root, ".git", "info", "exclude"), "# synthetic local excludes\n", { mode: 0o664 });
    await writeFile(join(root, ".git", "hooks", "pre-commit.sample"), "# inert synthetic hook sample\n", { mode: 0o775 });
    await writeFile(join(root, ".gitignore"), ".pkm/\n", { mode: 0o664 });
    for (const name of ["chatrooms", "mcp-server", "servers"])
      await mkdir(join(root, name), { mode: 0o775 });
    await writeFile(join(root, "fixture-sentinel.txt"), "synthetic activation metadata\n", { mode: 0o664 });
  }
  if (chatroom && !legacySurfaces) {
    await mkdir(join(root, "chatrooms"), { mode: 0o775 });
    createChatroom(root);
  }
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    const lockDirectory = legacyRootAdoptionLockDirectory(root);
    const rootHash = digest(root).slice(0, 40);
    await rm(join(lockDirectory, `${rootHash}.sqlite`), { force: true });
    await rm(join(lockDirectory, `${rootHash}.writer.lock`), { force: true });
    await rm(join(lockDirectory, `${rootHash}.writer-fenced.json`), { force: true });
    try { await rmdir(lockDirectory); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && ["ENOENT", "ENOTEMPTY"].includes(error.code))) throw error;
    }
  });
  return root;
}

test("adoption resume without durable intent fails closed without preparing a new workspace", async t => {
  const root = await fixture(t);
  const before = await snapshot(root);
  await assert.rejects(resumeLegacyRootAdoptionExperimental(root, {}), { code: "RECOVERY_REQUIRED" });
  assert.deepEqual(await snapshot(root), before);
});

test("boot-closed recovery inspection is read-only and binds an independently retained plan and prepared identity", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  assert.equal(await inspectLegacyRootAdoptionRecoveryExperimental(root, { planSha256: "0".repeat(64) }), undefined);
  const prepared = await prepareLegacyRootAdoptionExperimental(root, {});
  const before = await snapshot(root);
  const inspected = await inspectLegacyRootAdoptionRecoveryExperimental(root, { planSha256: prepared.planSha256 });
  assert.equal(inspected.prepared.workspaceId, prepared.workspaceId);
  assert.equal(inspected.prepared.sourceFingerprint, prepared.sourceFingerprint);
  await assert.rejects(inspectLegacyRootAdoptionRecoveryExperimental(root, { planSha256: "0".repeat(64) }), { code: "RECOVERY_REQUIRED" });
  await assert.rejects(inspectLegacyRootAdoptionRecoveryExperimental(root, {
    planSha256: prepared.planSha256, prepared: { ...prepared, workspaceId: randomUUID() },
  }), { code: "RECOVERY_REQUIRED" });
  assert.deepEqual(await snapshot(root), before);
});

test("synthetic active hosts and cloned permits cannot authorize adoption or cancellation", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const host = { root, signal: new AbortController().signal, assertCurrent() {}, drain: async () => {} };
  const grant = { kind: "pkm.active-vscode-migration-grant/v1" };
  assert.throws(() => assertActiveVscodeMigrationGrant(host, grant, root), { code: "ACTIVE_MIGRATION_AUTHORITY_REQUIRED" });
  assert.throws(() => bindLinuxActiveVscodeMigrationHost({ host, grant }), { code: "ACTIVE_MIGRATION_AUTHORITY_REQUIRED" });
  const forged = {
    activeVscodeMigration: { host, grant },
    experimentalManagedSnapshotHost: { kind: "pkm.linux-managed-snapshot-host/v1" },
  };
  const original = await snapshot(root);
  await assert.rejects(prepareLegacyRootAdoptionExperimental(root, forged), { code: "LEGACY_WRITER_INVENTORY_UNAVAILABLE" });
  assert.deepEqual(await snapshot(root), original);
  const prepared = await prepareLegacyRootAdoptionExperimental(root, {});
  const pending = await snapshot(root);
  await assert.rejects(resumeLegacyRootAdoptionExperimental(root, { ...forged, expectedPrepared: prepared }),
    { code: "LEGACY_WRITER_INVENTORY_UNAVAILABLE" });
  await assert.rejects(rollbackPreparedLegacyRootAdoptionExperimental(root, { ...forged, expectedPrepared: prepared }),
    { code: "LEGACY_WRITER_INVENTORY_UNAVAILABLE" });
  assert.deepEqual(await snapshot(root), pending);
});

test("a caller-supplied fake VS Code module and self-asserted exports cannot manufacture a live host", async t => {
  const root = await fixture(t);
  const before = await snapshot(root);
  let called = false;
  const context = {
    extensionPath: root, extension: { id: "forged" }, globalStorageUri: { fsPath: root }, subscriptions: [],
    vscode: { extensions: { getExtension: () => { called = true; return {
      isActive: true, extensionPath: root, exports: { assertActiveMigrationContext() {} },
    }; } } },
  };
  assert.throws(() => activateActiveVscodeMigrationHost(context), { code: "ACTIVE_MIGRATION_AUTHORITY_REQUIRED" });
  assert.equal(called, false, "The factory must resolve the native module itself, not consume an injected object.");
  assert.deepEqual(await snapshot(root), before);
});

test("adoption resume binds the prepared root, workspace and source plan before publishing state", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const prepared = await prepareLegacyRootAdoptionExperimental(root, {});
  await rm(join(root, ".pkm-next-workspace"));
  const before = await snapshot(root);
  for (const [key, value] of [
    ["sourceRoot", `${root}-other-profile`],
    ["workspaceId", randomUUID()],
    ["sourceFingerprint", "0".repeat(64)],
    ["planSha256", "0".repeat(64)],
  ]) {
    await assert.rejects(resumeLegacyRootAdoptionExperimental(root, {
      expectedPrepared: { ...prepared, [key]: value },
    }), { code: "RECOVERY_REQUIRED" });
    assert.deepEqual(await snapshot(root), before, `Mismatched ${key} must not recreate even the workspace marker.`);
  }
  const adopted = await resumeLegacyRootAdoptionExperimental(root, { expectedPrepared: prepared });
  try {
    assert.equal(adopted.workspaceId, prepared.workspaceId);
    assert.equal(adopted.sourceFingerprint, prepared.sourceFingerprint);
    assert.equal(adopted.recoveredPendingPlan, true);
    assert.equal(await adopted.storage.workspaceId(), prepared.workspaceId);
  } finally { await adopted.storage.close(); }
});

test("prepared rollback binds the host-pinned identity before deleting any adoption state", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const prepared = await prepareLegacyRootAdoptionExperimental(root, {});
  const before = await snapshot(root);
  for (const [key, value] of [
    ["sourceRoot", `${root}-other-profile`],
    ["workspaceId", randomUUID()],
    ["sourceFingerprint", "0".repeat(64)],
    ["planSha256", "0".repeat(64)],
  ]) {
    await assert.rejects(rollbackPreparedLegacyRootAdoptionExperimental(root, {
      expectedPrepared: { ...prepared, [key]: value },
    }), { code: "RECOVERY_REQUIRED" });
    assert.deepEqual(await snapshot(root), before, `Mismatched ${key} must not cancel another host's intent.`);
  }
  const result = await rollbackPreparedLegacyRootAdoptionExperimental(root, { expectedPrepared: prepared });
  assert.equal(result.workspaceId, prepared.workspaceId);
  assert.deepEqual((await readdir(root)).sort(), ["notes"]);
});

test("host-pinned rollback refuses an older unbound intent without downgrading authority", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const prepared = await prepareLegacyRootAdoptionExperimental(root, {});
  await rename(join(root, ".pkm-next-workspace"), join(root, ".pkm-next-root-adoption-rollback.json"));
  const before = await snapshot(root);
  await assert.rejects(rollbackPreparedLegacyRootAdoptionExperimental(root, {
    expectedPrepared: prepared,
  }), { code: "RECOVERY_REQUIRED" });
  assert.deepEqual(await snapshot(root), before);
  const result = await rollbackPreparedLegacyRootAdoptionExperimental(root);
  assert.equal(result.workspaceId, prepared.workspaceId);
  assert.deepEqual((await readdir(root)).sort(), ["notes"]);
});

for (const point of ["intent-durable", "journal-removed"]) {
  test(`prepared rollback retains its full authority binding after interruption at ${point}`, { timeout: 60000 }, async t => {
    const root = await fixture(t);
    const prepared = await prepareLegacyRootAdoptionExperimental(root, {});
    assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", `
      const { rollbackPreparedLegacyRootAdoptionExperimental } = await import(process.argv[1]);
      await rollbackPreparedLegacyRootAdoptionExperimental(process.argv[2], {
        expectedPrepared: JSON.parse(process.argv[3]),
        experimentalRollbackCheckpoint: actual => { if (actual === process.argv[4]) process.kill(process.pid, "SIGKILL"); },
      });
    `, new URL("../dist/legacy-root-adoption.js", import.meta.url).href, root, JSON.stringify(prepared), point],
    { encoding: "utf8", timeout: 30000 }), error => error.signal === "SIGKILL");
    const intent = JSON.parse(await readFile(join(root, ".pkm-next-root-adoption-rollback.json"), "utf8"));
    assert.equal(intent.journal.sourceFingerprint, prepared.sourceFingerprint);
    assert.equal(intent.journal.planSha256, prepared.planSha256);
    const before = await snapshot(root);
    await assert.rejects(rollbackPreparedLegacyRootAdoptionExperimental(root, {
      expectedPrepared: { ...prepared, planSha256: "0".repeat(64) },
    }), { code: "RECOVERY_REQUIRED" });
    assert.deepEqual(await snapshot(root), before);
    const result = await rollbackPreparedLegacyRootAdoptionExperimental(root, { expectedPrepared: prepared });
    assert.equal(result.workspaceId, prepared.workspaceId);
    assert.deepEqual((await readdir(root)).sort(), ["notes"]);
  });
}

test("prepared rollback preserves original changes made after its journal was removed", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const prepared = await prepareLegacyRootAdoptionExperimental(root, {});
  await assert.rejects(rollbackPreparedLegacyRootAdoptionExperimental(root, {
    expectedPrepared: prepared,
    experimentalRollbackCheckpoint: point => { if (point === "journal-removed") throw new Error("interrupted"); },
  }), /interrupted/);
  const note = join(root, "notes", "Existing.md");
  await writeFile(note, "Independent legacy change; preserve it.\n");
  const before = await snapshot(root);
  await assert.rejects(rollbackPreparedLegacyRootAdoptionExperimental(root, {
    expectedPrepared: prepared,
  }), { code: "SOURCE_CHANGED" });
  assert.deepEqual(await snapshot(root), before);
});

test("prepared rollback preserves a changed workspace marker after publishing durable intent", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const prepared = await prepareLegacyRootAdoptionExperimental(root, {});
  const marker = join(root, ".pkm-next-workspace");
  const changed = JSON.stringify({ schema: "pkm.next-workspace/v2", id: randomUUID() });
  await assert.rejects(rollbackPreparedLegacyRootAdoptionExperimental(root, {
    expectedPrepared: prepared,
    experimentalRollbackCheckpoint: point => {
      if (point === "intent-durable") writeFileSync(marker, changed, { mode: 0o600 });
    },
  }), { code: "SOURCE_CHANGED" });
  assert.equal(await readFile(marker, "utf8"), changed);
  await lstat(join(root, ".pkm-next-root-adoption.json"));
  await lstat(join(root, ".pkm-next-root-adoption-rollback.json"));
});

test("prepared rollback rejects a duplicate workspace marker after completed marker removal", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const prepared = await prepareLegacyRootAdoptionExperimental(root, {});
  await assert.rejects(rollbackPreparedLegacyRootAdoptionExperimental(root, {
    expectedPrepared: prepared,
    experimentalRollbackCheckpoint: point => { if (point === "intent-published") throw new Error("interrupted"); },
  }), /interrupted/);
  const marker = join(root, ".pkm-next-workspace");
  await writeFile(marker, JSON.stringify({ schema: "pkm.next-workspace/v2", id: prepared.workspaceId }), { mode: 0o600 });
  const before = await snapshot(root);
  await assert.rejects(rollbackPreparedLegacyRootAdoptionExperimental(root, {
    expectedPrepared: prepared,
  }), { code: "RECOVERY_REQUIRED" });
  assert.deepEqual(await snapshot(root), before);
});

test("committed rollback checks the complete prepared pin before archiving Next state", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const adopted = await adoptLegacyRootInPlaceExperimental(root, { experimentalPostCommitRollbackBaseline: true });
  await adopted.storage.close();
  const before = await snapshot(root);
  for (const [key, value] of [
    ["sourceRoot", `${root}-other-profile`],
    ["workspaceId", randomUUID()],
    ["sourceFingerprint", "0".repeat(64)],
    ["planSha256", "0".repeat(64)],
  ]) {
    await assert.rejects(rollbackCommittedLegacyRootAdoptionExperimental(root, {
      workspaceId: adopted.workspaceId, expectedPrepared: { ...adopted, [key]: value },
    }), { code: "RECOVERY_REQUIRED" });
    assert.deepEqual(await snapshot(root), before);
  }
  const result = await rollbackCommittedLegacyRootAdoptionExperimental(root, {
    workspaceId: adopted.workspaceId, expectedPrepared: adopted,
  });
  assert.equal(result.workspaceId, adopted.workspaceId);
  assert.equal(await readFile(join(root, "notes", "Existing.md"), "utf8"),
    "---\ntitle: Existing\ndocumentId: synthetic-note\nrevision: 1\n---\nOriginal synthetic content.\n");
  await lstat(join(result.archive, "core.sqlite"));
  const archived = await snapshot(root);
  const recovery = await inspectLegacyRootAdoptionRecoveryExperimental(root, {
    planSha256: adopted.planSha256, prepared: adopted,
  });
  assert.equal(recovery.prepared.workspaceId, adopted.workspaceId);
  assert.deepEqual(await snapshot(root), archived);
});

test("experimental adoption resumes in a child process, writes the original Note, and reopens normally", { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const original = join(root, "notes", "Existing.md");
  const originalStat = await lstat(original, { bigint: true });
  const prepared = await prepareLegacyRootAdoptionExperimental(root, {
  });
  assert.equal(prepared.recoveredPendingPlan, false);
  assert.match(prepared.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(original, "utf8"),
    "---\ntitle: Existing\ndocumentId: synthetic-note\nrevision: 1\n---\nOriginal synthetic content.\n");
  assert.equal((await lstat(original, { bigint: true })).ino, originalStat.ino);
  await assert.rejects(Storage.open(root), { code: "RECOVERY_REQUIRED" });
  await assert.rejects(lstat(join(root, "core.sqlite")), { code: "ENOENT" });

  const child = resolve(testsRoot, "legacy-root-adoption-child.mjs");
  const output = execFileSync(process.execPath, [child, root], { encoding: "utf8" });
  const childResult = JSON.parse(output.trim());
  assert.equal(childResult.qualification, "experimental-unqualified");
  assert.equal(childResult.readBefore, "Original synthetic content.\n");
  assert.equal(childResult.updated.revision, 2);
  assert.match(await readFile(original, "utf8"), /Updated by the restarted synthetic server\./);

  const storage = await Storage.open(root);
  const native = await createNativeRuntime({ storage });
  try {
    const reopened = await native.core.dispatch("capability_read", {
      operation: "knowledge.note.get", version: 1, arguments: { id: "synthetic-note" },
    }, { id: "synthetic-root-owner", canWrite: true });
    assert.equal(reopened.error, undefined, JSON.stringify(reopened));
    assert.equal(reopened.result.item.content, "Updated by the restarted synthetic server.\n");
    assert.equal(reopened.result.item.documentId, "synthetic-note");
  } finally {
    await native.close();
    await storage.close();
  }
});

test("privacy-only .pkm and bounded inert activation surfaces remain in place through adoption", { timeout: 60000 }, async t => {
  const root = await fixture(t, { pkm: true, legacySurfaces: true });
  const privacyPath = join(root, ".pkm", "content-privacy.json");
  const privacyBefore = await lstat(privacyPath, { bigint: true });
  const privacyBytes = await readFile(privacyPath);
  const authorityId = "synthetic-root-snapshot-authority";
  const allowedTools = ["knowledge_snapshot_status"];
  const leases = [];
  const options = {
    acquireWriterQuiescence: async () => {
      const lease = { released: false, assertHeld() { assert.equal(this.released, false); },
        release() { this.released = true; } };
      leases.push(lease);
      return lease;
    },
    snapshotAdmission: {
      authorityId, allowedTools,
      authorize(binding) {
        assert.equal(binding.workspaceRoot, root);
        assert.match(binding.workspaceId, /^[0-9a-f-]{36}$/i);
        assert.equal(binding.actorId, "mcp:external");
        assert.equal(binding.authorityId, authorityId);
        assert.equal(binding.privateGitRoot, join(root, "packages", "knowledge-snapshots", "repository.git"));
        assert.deepEqual(binding.allowedTools, allowedTools);
        assert.equal(binding.operation, "admit");
        if (binding.rootPin !== undefined) assert.match(binding.rootPin, /^\d+:\d+$/);
        return true;
      },
    },
  };
  const plan = await planLegacyImport(root, {}, { inPlaceAdoption: true });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal(plan.inPlaceOnly, true);
  assert.match(plan.inPlacePkmPrivacySha256, /^[a-f0-9]{64}$/);
  await assert.rejects(importLegacyWorkspace(plan, join(root, "copy-target"), {}), { code: "IN_PLACE_PLAN_NOT_IMPORTABLE" });

  const prepared = await prepareLegacyRootAdoptionExperimental(root, options);
  assert.equal(prepared.recoveredPendingPlan, false);
  assert.equal(leases[0].released, true);
  await assert.rejects(Storage.open(root), { code: "RECOVERY_REQUIRED" });
  const adopted = await resumeLegacyRootAdoptionExperimental(root, options);
  assert.equal(adopted.recoveredPendingPlan, true);
  assert.equal(leases[1].released, false);
  const actor = { id: "synthetic-root-owner", canWrite: true };
  const native = await createNativeRuntime({ storage: adopted.storage });
  try {
    const updated = await legacyKnowledgeWrite(native.core, adopted.storage, actor, {
      tool: "update_note", arguments: { slug: "Existing", content: "Updated with admitted privacy state.\n" },
    });
    assert.deepEqual(JSON.parse(updated.text), { ok: true, slug: "Existing" });
  } finally {
    await native.close();
    await adopted.storage.close();
  }
  assert.equal(leases[1].released, true);
  assert.deepEqual(await readFile(privacyPath), privacyBytes);
  const privacyAfter = await lstat(privacyPath, { bigint: true });
  assert.equal(privacyAfter.ino, privacyBefore.ino);
  assert.equal(privacyAfter.mode, privacyBefore.mode);
  const storage = await Storage.open(root);
  try {
    const reopened = await storage.request({
      operation: "knowledge.note.get", args: { id: "synthetic-note" }, actorId: actor.id,
    });
    assert.equal(reopened.item.content, "Updated with admitted privacy state.\n");
  } finally { await storage.close(); }
});

test("legacy umask-created .pkm containers at 0775 are accepted without relaxing private payload checks", async t => {
  const root = await fixture(t);
  const pkm = join(root, ".pkm"), state = join(pkm, "state");
  const previousMask = process.umask(0o002);
  try { mkdirSync(state, { recursive: true }); }
  finally { process.umask(previousMask); }
  await writeFile(join(pkm, "content-privacy.json"),
    "{\"schema\":1,\"private\":{\"notes\":[\"Chatroom Meetings\"]}}", { mode: 0o600 });
  await mkdir(join(state, "actions"), { mode: 0o700 });
  await writeFile(join(state, "actions", "mutation-lease"), "", { mode: 0o600 });
  assert.equal((await lstat(pkm)).mode & 0o777, 0o775);
  assert.equal((await lstat(state)).mode & 0o777, 0o775);
  const plan = await planLegacyImport(root, {}, { inPlaceAdoption: true });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.match(plan.inPlacePkmPrivacySha256, /^[a-f0-9]{64}$/);

  await chmod(join(pkm, "content-privacy.json"), 0o664);
  await assert.rejects(planLegacyImport(root, {}, { inPlaceAdoption: true }), { code: "PKM_STATE_UNSUPPORTED" });
  await chmod(join(pkm, "content-privacy.json"), 0o600);
  await chmod(join(state, "actions"), 0o775);
  await assert.rejects(planLegacyImport(root, {}, { inPlaceAdoption: true }), error => {
    assert.equal(error.code, "PKM_STATE_UNSUPPORTED");
    assert.match(error.path, /\.pkm\/state\/actions$/);
    return true;
  });
  await chmod(join(state, "actions"), 0o700);
  await chmod(pkm, 0o777);
  await assert.rejects(planLegacyImport(root, {}, { inPlaceAdoption: true }), error => {
    assert.equal(error.code, "PKM_STATE_UNSUPPORTED");
    assert.match(error.path, /\.pkm$/);
    return true;
  });
});

test("unsupported .pkm runtime state remains untouched and reports the exact blocker", async t => {
  const root = await fixture(t, { pkm: true });
  const control = join(root, ".pkm", "state", "projects.json");
  await writeFile(control, "{\"schema\":\"synthetic\"}", { mode: 0o600 });
  const before = await snapshot(root);
  await assert.rejects(
    prepareLegacyRootAdoptionExperimental(root, {
      snapshotAdmission: {
        authorityId: "synthetic-root-snapshot-authority",
        allowedTools: ["knowledge_snapshot_status"],
        authorize: () => true,
      },
    }),
    { code: "PKM_STATE_UNSUPPORTED" },
  );
  assert.deepEqual(await snapshot(root), before);
  await assert.rejects(lstat(join(root, ".pkm-next-workspace")), { code: "ENOENT" });
  await assert.rejects(lstat(join(root, ".pkm-next-root-adoption.json")), { code: "ENOENT" });
  await assert.rejects(lstat(join(root, "core.sqlite")), { code: "ENOENT" });
});

async function apiFixture(t) {
  const directory = resolve(".migration-test-work", `api-adoption-${randomUUID()}`);
  const root = join(directory, "knowledge");
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "notes/Existing.md"), "---\ntitle: Existing\nrevision: 1\n---\nSynthetic.\n", { mode: 0o600 });
  const mask = process.umask(0o077);
  let descriptor;
  try { descriptor = require("../legacy/tests/next-trial-electron/api-chat-fixture.cjs").create({ extension: resolve(testsRoot, "../legacy"), root }); }
  finally { process.umask(mask); }
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    const locks = legacyRootAdoptionLockDirectory(root), prefix = digest(root).slice(0, 40);
    for (const suffix of [".sqlite", ".writer.lock", ".writer-fenced.json"]) await rm(join(locks, prefix + suffix), { force: true });
    await rmdir(locks).catch(error => { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; });
  });
  return { root, descriptor };
}

test("dedicated API Chat archive is byte-bound and preserved by same-root adoption", { timeout: 60000 }, async t => {
  const { root, descriptor } = await apiFixture(t);
  const before = await snapshot(join(root, ".pkm", "state"));
  const plan = await planLegacyImport(root, {}, { inPlaceAdoption: true });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.match(plan.inPlaceApiChatArchive.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert(plan.inPlaceApiChatArchive.files.some(file => file.path.endsWith(`${descriptor.segmented}.json`)));
  const options = { snapshotAdmission: {
    authorityId: "synthetic-root-snapshot-authority", allowedTools: ["knowledge_snapshot_status"], authorize: () => true,
  } };
  await prepareLegacyRootAdoptionExperimental(root, options);
  const result = await resumeLegacyRootAdoptionExperimental(root, options);
  await result.storage.close();
  assert.deepEqual(await snapshot(join(root, ".pkm", "state")), before);
});

test("changed API Chat archive blocks an interrupted same-root adoption", { timeout: 60000 }, async t => {
  const { root, descriptor } = await apiFixture(t);
  const options = { snapshotAdmission: {
    authorityId: "synthetic-root-snapshot-authority", allowedTools: ["knowledge_snapshot_status"], authorize: () => true,
  } };
  await prepareLegacyRootAdoptionExperimental(root, options);
  const chat = join(descriptor.state, "api-chats", descriptor.namespace, `${descriptor.inline}.json`);
  const bytes = await readFile(chat);
  await writeFile(chat, Buffer.concat([bytes, Buffer.from(" ")]));
  await assert.rejects(resumeLegacyRootAdoptionExperimental(root, options), { code: "SOURCE_CHANGED" });
  assert.deepEqual(await readFile(chat), Buffer.concat([bytes, Buffer.from(" ")]));
  await assert.rejects(lstat(join(root, "core.sqlite")), { code: "ENOENT" });
});

test("inert root retention rejects live Git authority and non-empty legacy workflow state", async t => {
  const gitRoot = await fixture(t, { legacySurfaces: true });
  const configPath = join(gitRoot, ".git", "config");
  const originalConfig = await readFile(configPath);
  await writeFile(configPath, `${originalConfig.toString("utf8")}[remote "origin"]\n\turl = https://example.invalid/repo.git\n`);
  const gitBefore = await snapshot(gitRoot);
  await assert.rejects(planLegacyImport(gitRoot, {}, { inPlaceAdoption: true }), { code: "LEGACY_ROOT_INERT_STATE_UNSUPPORTED" });
  assert.deepEqual(await snapshot(gitRoot), gitBefore);

  const serverRoot = await fixture(t, { legacySurfaces: true });
  await writeFile(join(serverRoot, "servers", "server.json"), "{\"enabled\":true}");
  const serverBefore = await snapshot(serverRoot);
  await assert.rejects(planLegacyImport(serverRoot, {}, { inPlaceAdoption: true }), { code: "LEGACY_ROOT_INERT_STATE_UNSUPPORTED" });
  assert.deepEqual(await snapshot(serverRoot), serverBefore);

  const mcpRoot = await fixture(t, { legacySurfaces: true });
  await writeFile(join(mcpRoot, "mcp-server", "chat-room-lock.js"), "// installed program, not a lock\n");
  await assert.rejects(planLegacyImport(mcpRoot, {}, { inPlaceAdoption: true }), {
    code: "LEGACY_ROOT_INERT_STATE_UNSUPPORTED", path: "mcp-server",
  });
});

test("closed managed MCP generation is preserved as byte-bound evidence, not writer authority", { timeout: 60000 }, async t => {
  const root = await fixture(t, { legacySurfaces: true });
  const mcp = join(root, "mcp-server"), id = randomUUID(), generation = join(mcp, "generations", id);
  await mkdir(join(generation, "runtime/dist"), { recursive: true, mode: 0o700 });
  const files = {
    "runtime/dist/chat-room-lock.js": "// original runtime code, not a live lock\n",
    "runtime/package.json": '{"version":"4.0.22"}',
    "server.py": "# synthetic generated server; never execute\n",
  };
  for (const [name, content] of Object.entries(files))
    await writeFile(join(generation, name), content, { mode: 0o600 });
  const hashes = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, digest(content)]));
  const build = createHash("sha256");
  Object.keys(hashes).filter(name => name.startsWith("runtime/")).map(name => name.slice(8)).sort()
    .forEach(name => build.update(name).update("\0").update(hashes[`runtime/${name}`]).update("\0"));
  const manifest = { schema: "pkm.mcp.lifecycle/v1", generation: id, managedRoot: mcp, version: "2.0.0",
    extensionVersion: "4.0.22", runtimeBuild: build.digest("hex"), node: "current-vscode-extension-host",
    components: { knowledge: "1.0.0", chat: "1.0.0", recipes: "1.0.0", agent_sessions: "1.0.0" },
    enabledFeatureDomains: ["knowledge"], files: hashes };
  await writeFile(join(generation, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  for (const name of ["active-generation.json", "latest-generation.json"])
    await writeFile(join(mcp, name), JSON.stringify({ schema: "pkm.mcp.lifecycle/v1", generation: id }), { mode: 0o600 });
  await writeFile(join(mcp, "server.py"), "# inert synthetic launcher\n", { mode: 0o600 });
  await writeFile(join(mcp, "requirements.txt"), "# synthetic requirements\n", { mode: 0o600 });
  const instanceId = randomUUID().replaceAll("-", ""), instanceDir = join(mcp, "instances");
  await mkdir(instanceDir, { mode: 0o700 });
  const recordPath = join(instanceDir, `${instanceId}.json`);
  const record = { schema: "pkm.mcp.lifecycle/v1", generation: id, instanceId, runtimeBuild: manifest.runtimeBuild,
    version: manifest.version, extensionVersion: manifest.extensionVersion, components: manifest.components,
    attribution: { schema: "pkm.mcp.attribution/v1" }, pid: 123, phase: "drained", acceptingNewCalls: false,
    inFlight: 0, uncertainCalls: 0, controlError: "", drainDeadlineExceeded: false, drainTimeoutSeconds: 30,
    action: "reconnect", automaticReplay: false, automaticTermination: false, gracefulRetirement: true,
    heartbeatAt: 1, updateAvailable: false, compatibility: "current" };
  await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
  await chmod(instanceDir, 0o775);
  await chmod(recordPath, 0o664);
  await chmod(root, 0o777);
  await assert.rejects(planLegacyImport(root, {}, { inPlaceAdoption: true }), { code: "LEGACY_ROOT_INERT_STATE_UNSUPPORTED" });
  await chmod(root, 0o700);
  await chmod(join(mcp, "active-generation.json"), 0o664);
  await assert.rejects(planLegacyImport(root, {}, { inPlaceAdoption: true }), { code: "LEGACY_ROOT_INERT_STATE_UNSUPPORTED" });
  await chmod(join(mcp, "active-generation.json"), 0o600);
  const before = await snapshot(mcp);
  const plan = await planLegacyImport(root, {}, { inPlaceAdoption: true });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert(plan.entries.some(entry => entry.source.endsWith("/runtime/dist/chat-room-lock.js")));
  await prepareLegacyRootAdoptionExperimental(root, {});
  await rollbackPreparedLegacyRootAdoptionExperimental(root);
  assert.deepEqual(await snapshot(mcp), before);

  for (const altered of [
    { ...record, phase: "accepting", acceptingNewCalls: true },
    { ...record, inFlight: 1 },
    { ...record, uncertainCalls: 1 },
    { ...record, runtimeBuild: "0".repeat(64) },
    { ...record, extraAuthority: true },
  ]) {
    await writeFile(recordPath, JSON.stringify(altered));
    await assert.rejects(planLegacyImport(root, {}, { inPlaceAdoption: true }), { code: "LEGACY_ROOT_INERT_STATE_UNSUPPORTED" });
  }
  await writeFile(recordPath, JSON.stringify(record));
  await writeFile(join(instanceDir, `${instanceId}.pending`), "", { mode: 0o600 });
  await assert.rejects(planLegacyImport(root, {}, { inPlaceAdoption: true }), { code: "LEGACY_ROOT_INERT_STATE_UNSUPPORTED" });
  await rm(join(instanceDir, `${instanceId}.pending`));
  const code = join(generation, "runtime/dist/chat-room-lock.js");
  await writeFile(code, "changed executable bytes\n");
  await assert.rejects(planLegacyImport(root, {}, { inPlaceAdoption: true }), { code: "LEGACY_ROOT_INERT_STATE_UNSUPPORTED" });
  assert.equal(await readFile(code, "utf8"), "changed executable bytes\n");
  await writeFile(code, files["runtime/dist/chat-room-lock.js"]);
  await writeFile(join(mcp, ".generation-lock"), "", { mode: 0o600 });
  await assert.rejects(planLegacyImport(root, {}, { inPlaceAdoption: true }), { code: "LEGACY_ROOT_INERT_STATE_UNSUPPORTED" });
});

test("non-empty closed Chatroom archives are adoption-only and remain bound to their original bytes", { timeout: 60000 }, async t => {
  const root = await fixture(t, { chatroom: true });
  const databasePath = join(root, "chatrooms", "legacy-room-01", "chatroom.db");
  const before = await snapshot(root);
  const copyPlan = await planLegacyImport(root);
  assert.equal(copyPlan.ready, false);
  assert.ok(copyPlan.blockers.some(blocker => blocker.path === "chatrooms"));
  await assert.rejects(Storage.open(root), { code: "INVALID_WORKSPACE" });
  const plan = await planLegacyImport(root, {}, { inPlaceAdoption: true });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal(plan.inPlaceOnly, true);
  assert.equal(plan.inPlaceChatroomArchives.length, 1);
  assert.equal(plan.inPlaceChatroomArchives[0].roomId, "legacy-room-01");
  assert.deepEqual(plan.inPlaceChatroomArchives[0].files.map(file => file.path), [
    "chatrooms/legacy-room-01/chatroom.db",
  ]);
  assert.equal(plan.entries.find(entry => entry.source === "chatrooms/legacy-room-01/chatroom.db")?.sha256,
    plan.inPlaceChatroomArchives[0].files[0].sha256);
  await assert.rejects(importLegacyWorkspace(plan, join(root, "copy-target"), {}), { code: "IN_PLACE_PLAN_NOT_IMPORTABLE" });

  const prepared = await prepareLegacyRootAdoptionExperimental(root, {});
  const journal = JSON.parse(await readFile(join(root, ".pkm-next-root-adoption.json"), "utf8"));
  assert.equal(journal.inventoryPlan.inPlaceChatroomArchives[0].sourceFingerprint, plan.inPlaceChatroomArchives[0].sourceFingerprint);
  assert.ok(journal.sourceEntries.some(entry => entry.path === "chatrooms/legacy-room-01/chatroom.db"
    && entry.sha256 === plan.inPlaceChatroomArchives[0].files[0].sha256));
  await assert.rejects(Storage.open(root), { code: "RECOVERY_REQUIRED" });
  const adopted = await resumeLegacyRootAdoptionExperimental(root, {});
  assert.equal(prepared.recoveredPendingPlan, false);
  assert.equal(adopted.recoveredPendingPlan, true);
  await adopted.storage.close();
  const reopened = await Storage.open(root);
  await reopened.close();
  assert.deepEqual(await snapshot(root).then(entries => entries.filter(entry => entry.path.startsWith("chatrooms/"))),
    before.filter(entry => entry.path.startsWith("chatrooms/")));

  const altered = Buffer.from(await readFile(databasePath));
  altered[altered.length - 1] ^= 0x01;
  await writeFile(databasePath, altered);
  await assert.rejects(Storage.open(root), { code: "RECOVERY_REQUIRED" });
});

test("quiescence loss during source recheck fails closed before publishing adoption metadata", async t => {
  const root = await fixture(t);
  const note = join(root, "notes", "Existing.md");
  let checks = 0;
  const externalWrite = "---\ntitle: Existing\ndocumentId: synthetic-note\nrevision: 1\n---\nConcurrent synthetic write.\n";
  await assert.rejects(prepareLegacyRootAdoptionExperimental(root, {
    acquireWriterQuiescence: async () => ({
      assertHeld() {
        checks++;
        if (checks === 2) {
          writeFileSync(note, externalWrite);
          const error = new Error("synthetic writer fence lost");
          error.code = "BUSY";
          throw error;
        }
      },
      release() {},
    }),
  }), { code: "BUSY" });
  assert.equal(await readFile(note, "utf8"), externalWrite);
  await assert.rejects(lstat(join(root, ".pkm-next-workspace")), { code: "ENOENT" });
  await assert.rejects(lstat(join(root, ".pkm-next-root-adoption.json")), { code: "ENOENT" });
  await assert.rejects(lstat(join(root, "core.sqlite")), { code: "ENOENT" });
});

test("concurrent adoption waits for the held root fence and recovers the same durable intent", { timeout: 30000 }, async t => {
  const root = await fixture(t);
  let notifyAcquired;
  let resumeFirst;
  const acquired = new Promise(resolve => { notifyAcquired = resolve; });
  const blocked = new Promise(resolve => { resumeFirst = resolve; });
  const first = prepareLegacyRootAdoptionExperimental(root, {
    acquireWriterQuiescence: async () => {
      notifyAcquired();
      await blocked;
      return quiescence;
    },
  });
  let second;
  let secondEntered = false;
  try {
    await Promise.race([acquired, first.then(() => { throw new Error("The holder completed before its fixture was released."); })]);
    const before = await snapshot(root);
    second = prepareLegacyRootAdoptionExperimental(root, { acquireWriterQuiescence: async () => {
      secondEntered = true;
      return quiescence;
    } });
    // Adoption waits up to 30 seconds; exercise contention without making the fixture wait for its own deadline.
    await assert.rejects(async () => {
      const unexpectedFence = await acquireLinuxRootWriterFence(root, 150);
      await unexpectedFence.release();
    }, { code: "BUSY" });
    assert.equal(secondEntered, false, "The contender must not enter host quiescence while the root fence is held.");
    assert.deepEqual(await snapshot(root), before);
  } finally {
    resumeFirst();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
  const prepared = await first;
  assert.equal(prepared.recoveredPendingPlan, false);
  const recovered = await second;
  assert.equal(secondEntered, true);
  assert.equal(recovered.recoveredPendingPlan, true);
  assert.equal(recovered.workspaceId, prepared.workspaceId);
  assert.equal(recovered.sourceFingerprint, prepared.sourceFingerprint);
  assert.equal(recovered.planSha256, prepared.planSha256);
  await assert.rejects(Storage.open(root), { code: "RECOVERY_REQUIRED" });
  const adopted = await resumeLegacyRootAdoptionExperimental(root, { expectedPrepared: prepared });
  try { assert.equal(await adopted.storage.workspaceId(), prepared.workspaceId); }
  finally { await adopted.storage.close(); }
});
