import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Storage } from "../dist/storage.js";
import { admitLegacyActionArtifactPath } from "../dist/legacy-action-artifacts.js";
import { admitLegacyKnowledgeSnapshots, inspectLegacyKnowledgeSnapshotSchedulerEnrollment } from "../dist/legacy-knowledge-snapshots.js";

export async function enrollManagedSchedulerArtifacts(data, selectedRoot, { snapshotsAlreadyAdmitted = false } = {}) {
  await mkdir(selectedRoot, { recursive: true, mode: 0o700 });
  const source = join(selectedRoot, "reviewed-source.bin"), destination = join(selectedRoot, "user-export.bin");
  const bytes = Buffer.from([0, 1, 255, 13, 10, 7]);
  await writeFile(source, bytes, { mode: 0o600 });
  const digest = createHash("sha256").update(bytes).digest("hex");
  const actor = { id: "mcp:external", canWrite: true };
  const storage = await Storage.open(data);
  try {
    await storage.provisionTrash();
    const workspaceId = await storage.workspaceId(), stat = await lstat(data);
    if (!snapshotsAlreadyAdmitted) {
      const tools = ["knowledge_snapshot_status", "knowledge_snapshot_create", "knowledge_snapshot_restore_preview",
        "knowledge_snapshot_restore_apply", "knowledge_snapshot_configure"];
      await admitLegacyKnowledgeSnapshots(storage, actor, {
        authorityId: "test-native-fixed-managed-scheduler", allowedTools: tools,
        authorize(binding) {
          assert.equal(binding.actorId, actor.id); assert.equal(binding.workspaceId, workspaceId);
          assert.equal(binding.workspaceRoot, data);
          assert.equal(binding.privateGitRoot, join(data, "packages/knowledge-snapshots/repository.git"));
          assert.equal(binding.authorityId, "test-native-fixed-managed-scheduler");
          assert.equal(binding.operation, "admit");
          assert.deepEqual([...binding.allowedTools].sort(), [...tools].sort());
          assert(binding.rootPin === undefined || binding.rootPin === `${stat.dev}:${stat.ino}`);
          return true;
        },
      });
    }
    for (const [kind, path, expectedSha256] of [["source", source, digest], ["destination", destination, undefined]]) {
      await admitLegacyActionArtifactPath(storage, actor, {
        kind, selectedRoot, path, expectedSha256, authorityId: "test-native-fixed-managed-artifact",
        authorize(binding) {
          assert.deepEqual(binding, {
            actorId: actor.id, workspaceId, workspaceRoot: data, workspaceRootPin: `${stat.dev}:${stat.ino}`,
            kind, selectedRoot, path, expectedSha256: expectedSha256 ?? null,
            authorityId: "test-native-fixed-managed-artifact",
          });
          return true;
        },
      });
    }
    return { source, destination, digest, snapshotScheduler: inspectLegacyKnowledgeSnapshotSchedulerEnrollment(data) };
  } finally { await storage.close(); }
}

export function nextRealSnapshotMinute() {
  return { local_time: new Date(Date.now() + 90_000).toISOString().slice(11, 16), timezone: "UTC" };
}

export async function waitForRealSnapshot(tool, previousTags, deadline = Date.now() + 160_000) {
  while (Date.now() < deadline) {
    const status = await tool("knowledge_snapshot_status");
    if (status.tags.length > previousTags && status.latest?.reason === "scheduled-daily") {
      assert.equal(status.tags.length, previousTags + 1, "A due job must create exactly one original private Git snapshot");
      return status;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.fail("Actual managed CLI timer did not create its original scheduled-daily Git snapshot");
}
