import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize, Storage } from "../dist/storage.js";
import {
  admitLegacyKnowledgeSnapshots, inspectLegacyKnowledgeSnapshotSchedulerEnrollment,
} from "../dist/legacy-knowledge-snapshots.js";
import { legacyManagedFixture, closeLegacyManagedFixture } from "./legacy-managed-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const actor = { id: "mcp:external", canWrite: true };
const allowedTools = ["knowledge_snapshot_status", "knowledge_snapshot_create", "knowledge_snapshot_configure",
  "knowledge_snapshot_restore_preview", "knowledge_snapshot_restore_apply"];

test("managed MCP status remains available while the real scheduler creates its daily Git snapshot",
  { timeout: 180_000 }, async t => {
    const parent = join(root, "tests", `.legacy-scheduler-live-mcp-${randomUUID()}`);
    await mkdir(parent);
    const data = await initialize(join(parent, "workspace"));
    await writeFile(join(data, "notes", "Scheduled.md"), "---\ntitle: Scheduled\n---\nReal timer snapshot.\n");
    const managed = await legacyManagedFixture(parent);
    let client;
    t.after(async () => {
      try { await client?.close(); } finally { await rm(parent, { recursive: true, force: true }); }
    });

    const storage = await Storage.open(data);
    let enrollment;
    try {
      await storage.provisionTrash();
      const workspaceId = await storage.workspaceId(), stat = await lstat(data);
      await admitLegacyKnowledgeSnapshots(storage, actor, {
        authorityId: "live-mcp-scheduler-test", allowedTools,
        authorize: binding => binding.actorId === actor.id && binding.workspaceId === workspaceId
          && binding.workspaceRoot === data && binding.privateGitRoot === join(data, "packages/knowledge-snapshots/repository.git")
          && binding.authorityId === "live-mcp-scheduler-test" && binding.operation === "admit"
          && JSON.stringify([...binding.allowedTools].sort()) === JSON.stringify([...allowedTools].sort())
          && (binding.rootPin === undefined || binding.rootPin === `${stat.dev}:${stat.ino}`),
      });
      enrollment = inspectLegacyKnowledgeSnapshotSchedulerEnrollment(data);
    } finally { await storage.close(); }
    await writeFile(join(managed, "launch.json"), JSON.stringify({ data, allowWrites: true, snapshotScheduler: enrollment }));
    client = new Client({ name: "live-snapshot-status-regression", version: "1" });
    await client.connect(new StdioClientTransport({
      command: "python3",
      args: [join(root, "compat/legacy-compact-mcp.py"), "--data", data, "--node", process.execPath,
        "--managed-generation", managed, "--allow-writes", "--experimental-managed-snapshot-scheduler", enrollment.admissionSha256],
      env: { ...process.env, PKM_CAPABILITY_PROFILE: "compact", PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe",
    }));
    const request = async (name, args, readOnly = false) => {
      const result = await client.callTool({ name: readOnly ? "capability_read" : "capability_call",
        arguments: { operation: `mcp.tool.${name}`, version: 1, arguments: args } });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return result.structuredContent;
    };
    const target = new Date(Date.now() + 90_000);
    const localTime = `${String(target.getUTCHours()).padStart(2, "0")}:${String(target.getUTCMinutes()).padStart(2, "0")}`;
    const enabled = await request("knowledge_snapshot_configure", { enabled: true, local_time: localTime, timezone: "UTC" });
    const due = Date.parse(enabled.next_run_utc);
    assert(Number.isFinite(due) && due > Date.now(), "Scheduler must report a future real deadline.");
    await sleep(Math.max(0, due - Date.now() - 4_000));
    let before = 0, after = 0, status;
    do {
      const started = Date.now();
      status = await request("knowledge_snapshot_status", {}, true);
      if (started < due) before++; else after++;
      if (status.latest?.reason === "scheduled-daily") break;
      await sleep(25);
    } while (Date.now() < due + 35_000);
    assert.equal(status.latest?.reason, "scheduled-daily", "The actual timer must finish its original Git snapshot.");
    assert.equal(status.tags.length, 1);
    if (!after) {
      status = await request("knowledge_snapshot_status", {}, true);
      after++;
      assert.equal(status.latest?.reason, "scheduled-daily");
    }
    assert(before > 0 && after > 0, "Status must be called on both sides of the actual deadline.");
    await request("knowledge_snapshot_configure", { enabled: false, local_time: localTime, timezone: "UTC" });
    await closeLegacyManagedFixture(client);
    client = undefined;
  });
