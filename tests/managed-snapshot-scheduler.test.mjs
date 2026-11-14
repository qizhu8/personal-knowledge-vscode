import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initialize, Storage } from "../dist/storage.js";
import { stageIsolatedManagedGeneration } from "../experimental/managed-migration.mjs";

const testsRoot = dirname(fileURLToPath(import.meta.url));

test("managed scheduler is opt-in and rejects malformed, foreign, or read-only enrollment before creating generations", async t => {
  const parent = join(testsRoot, `.managed-scheduler-${randomUUID()}`);
  await mkdir(parent);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const data = await initialize(join(parent, "data")), managedRoot = join(parent, "managed");
  const marker = JSON.parse(await readFile(join(data, ".pkm-next-workspace"), "utf8"));
  const enrollment = { schema: "pkm.native-snapshot-scheduler/v1", workspaceId: marker.id,
    actorId: "mcp:external", admissionSha256: "a".repeat(64) };
  for (const [snapshotScheduler, allowWrites] of [
    [null, true], [true, true], [{ ...enrollment, root: data }, true],
    [{ ...enrollment, schema: "other" }, true], [{ ...enrollment, workspaceId: randomUUID() }, true],
    [{ ...enrollment, actorId: "local:owner" }, true], [{ ...enrollment, admissionSha256: "../grant" }, true],
    [{ ...enrollment, admissionSha256: ["a".repeat(64)] }, true],
    [{ ...enrollment, workspaceId: marker.id.toUpperCase() }, true],
    [enrollment, false],
  ]) {
    await assert.rejects(stageIsolatedManagedGeneration({ managedRoot, data, snapshotScheduler, allowWrites }),
      /exact existing workspace enrollment|explicit write authority/);
    await assert.rejects(readdir(managedRoot), { code: "ENOENT" });
  }
});

test("scheduler staging preflight consumes an exact existing native admission without acquiring its live workspace lease or changing bytes", async t => {
  const { admitLegacyKnowledgeSnapshots, inspectLegacyKnowledgeSnapshotSchedulerEnrollment } =
    await import("../dist/legacy-knowledge-snapshots.js");
  const { DatabaseSync } = await import("node:sqlite");
  const parent = join(testsRoot, `.managed-scheduler-${randomUUID()}`);
  await mkdir(parent);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const data = await initialize(join(parent, "data")), managedRoot = join(parent, "managed");
  const marker = JSON.parse(await readFile(join(data, ".pkm-next-workspace"), "utf8"));
  const absent = { schema: "pkm.native-snapshot-scheduler/v1", workspaceId: marker.id,
    actorId: "mcp:external", admissionSha256: "a".repeat(64) };
  const storage = await Storage.open(data);
  try {
    await assert.rejects(stageIsolatedManagedGeneration({ managedRoot, data, allowWrites: true, snapshotScheduler: absent }),
      /admission|enroll|scope|snapshot/i);
    await storage.provisionTrash();
    const root = await lstat(data), rootPin = `${root.dev}:${root.ino}`;
    const tools = ["knowledge_snapshot_status", "knowledge_snapshot_create", "knowledge_snapshot_restore_preview",
      "knowledge_snapshot_restore_apply", "knowledge_snapshot_configure"];
    await admitLegacyKnowledgeSnapshots(storage, { id: "mcp:external", canWrite: true }, {
      authorityId: "test-native-fixed-managed-scheduler", allowedTools: tools, authorize(binding) {
        assert.equal(binding.workspaceId, marker.id);
        assert.equal(binding.actorId, "mcp:external");
        assert.equal(binding.workspaceRoot, data);
        assert.equal(binding.privateGitRoot, join(data, "packages/knowledge-snapshots/repository.git"));
        assert.equal(binding.authorityId, "test-native-fixed-managed-scheduler");
        assert.equal(binding.operation, "admit");
        assert.deepEqual([...binding.allowedTools].sort(), [...tools].sort());
        assert(binding.rootPin === undefined || binding.rootPin === rootPin);
        return true;
      },
    });
    const db = new DatabaseSync(join(data, "core.sqlite"), { readOnly: true });
    let enrollment;
    try { enrollment = inspectLegacyKnowledgeSnapshotSchedulerEnrollment(db, data); } finally { db.close(); }
    const before = await readFile(join(data, "core.sqlite"));
    await assert.rejects(stageIsolatedManagedGeneration({ managedRoot, data, allowWrites: true,
      snapshotScheduler: { ...enrollment, admissionSha256: "0".repeat(64) } }), /admission|digest|snapshot/i);
    await assert.rejects(stageIsolatedManagedGeneration({ managedRoot, data, allowWrites: true,
      snapshotScheduler: enrollment, maxPythonDependencyBytes: 1 }), /exceeding explicit budget/);
    assert.deepEqual(await readFile(join(data, "core.sqlite")), before,
      "Successful read-only preflight while the real owner holds its lease must not mutate native bytes");
    await assert.rejects(readdir(managedRoot), { code: "ENOENT" });
  } finally { await storage.close(); }
});
