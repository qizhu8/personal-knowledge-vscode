import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { admitLegacyActionArtifactPath, legacyActionArtifact } from "../dist/legacy-action-artifacts.js";
import { admitLegacyKnowledgeSnapshots, inspectLegacyKnowledgeSnapshotSchedulerEnrollment, legacyKnowledgeSnapshot } from "../dist/legacy-knowledge-snapshots.js";
import { createAdmittedLegacyKnowledgeSnapshotScheduler } from "../dist/legacy-knowledge-snapshot-scheduler.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";

const root = resolve(import.meta.dirname, ".."), actor = { id: "mcp:external", canWrite: true };
const allowedTools = ["knowledge_snapshot_status", "knowledge_snapshot_create", "knowledge_snapshot_configure",
  "knowledge_snapshot_restore_preview", "knowledge_snapshot_restore_apply"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
for (const order of ["artifact-first", "scheduler-first"]) test(`native snapshot scheduler and borrowed Action artifacts retain schema27 ownership (${order})`,
  { timeout: 60_000 }, async t => {
    const parent = join(root, "tests", `.legacy-artifact-snapshot-coexist-${randomUUID()}`);
    const selectedRoot = join(parent, "selected");
    await mkdir(selectedRoot, { recursive: true });
    const data = await initialize(join(parent, "workspace")), source = join(selectedRoot, "source.bin");
    const bytes = Buffer.from("independent approved source");
    await writeFile(source, bytes);
    t.after(() => rm(parent, { recursive: true, force: true }));
    const storage = await Storage.open(data);
    let scheduler, native;
    try {
      await storage.provisionTrash();
      const workspaceId = await storage.workspaceId(), stat = await lstat(data), rootPin = `${stat.dev}:${stat.ino}`;
      const admitArtifact = () => admitLegacyActionArtifactPath(storage, actor, {
        kind: "source", selectedRoot, path: source, expectedSha256: sha(bytes), authorityId: "artifact-exact",
        authorize: binding => binding.actorId === actor.id && binding.workspaceId === workspaceId
          && binding.workspaceRoot === data && binding.workspaceRootPin === rootPin
          && binding.kind === "source" && binding.selectedRoot === selectedRoot && binding.path === source
          && binding.expectedSha256 === sha(bytes) && binding.authorityId === "artifact-exact",
      });
      if (order === "artifact-first") await admitArtifact();
      await admitLegacyKnowledgeSnapshots(storage, actor, {
        authorityId: "snapshot-exact", allowedTools,
        authorize: binding => binding.actorId === actor.id && binding.workspaceId === workspaceId
          && binding.workspaceRoot === data && binding.privateGitRoot === join(data, "packages/knowledge-snapshots/repository.git")
          && binding.authorityId === "snapshot-exact" && binding.operation === "admit"
          && JSON.stringify([...binding.allowedTools].sort()) === JSON.stringify([...allowedTools].sort())
          && (binding.rootPin === undefined || binding.rootPin === rootPin),
      });
      const enrollment = inspectLegacyKnowledgeSnapshotSchedulerEnrollment(data);
      scheduler = createAdmittedLegacyKnowledgeSnapshotScheduler(storage, actor, enrollment.admissionSha256);
      await scheduler.start();
      const result = await legacyKnowledgeSnapshot(storage, actor,
        { tool: "knowledge_snapshot_configure", args: { enabled: false }, operationId: randomUUID() }, scheduler.host);
      assert.equal(result.enabled, false);
      if (order === "scheduler-first") {
        const db = storage.connectNative();
        try { assert.equal(Number(db.prepare("PRAGMA user_version").get().user_version), 26); } finally { db.close(); }
        await admitArtifact();
      }
      const imported = await legacyActionArtifact(storage, actor, { tool: "action_artifact_import", local_path: source });
      assert.match(imported.artifact_id, /^artifact_[a-f0-9]{32}$/);
      const db = storage.connectNative();
      try { assert.equal(Number(db.prepare("PRAGMA user_version").get().user_version), 27); } finally { db.close(); }
      native = await createNativeRuntime({ storage });
      const backup = join(parent, "backup"), relocated = join(parent, "relocated");
      await createWorkspaceBackup(storage, backup, { acquireQuiescence: native.acquireWorkspaceQuiescence });
      await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority });
      const moved = await Storage.open(relocated);
      try {
        const restoredDb = moved.connectNative();
        try { assert.equal(Number(restoredDb.prepare("PRAGMA user_version").get().user_version), 27); } finally { restoredDb.close(); }
        await assert.rejects(legacyActionArtifact(moved, actor, { tool: "action_artifact_import", local_path: source }), /native host admission/);
        assert.throws(() => inspectLegacyKnowledgeSnapshotSchedulerEnrollment(relocated), /enrollment/);
      } finally { await moved.close(); }
    } finally { await scheduler?.close(); await native?.close(); await storage.close(); }
  });
