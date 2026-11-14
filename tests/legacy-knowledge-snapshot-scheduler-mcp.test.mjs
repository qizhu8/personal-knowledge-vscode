import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize, Storage } from "../dist/storage.js";
import { admitLegacyKnowledgeSnapshots, inspectLegacyKnowledgeSnapshotSchedulerEnrollment } from "../dist/legacy-knowledge-snapshots.js";
import { legacyManagedFixture, closeLegacyManagedFixture } from "./legacy-managed-fixture.mjs";

const root = resolve(import.meta.dirname, ".."), repository = resolve(root, "..");
const actor = { id: "mcp:external", canWrite: true };
const allowedTools = ["knowledge_snapshot_status", "knowledge_snapshot_create", "knowledge_snapshot_configure",
  "knowledge_snapshot_restore_preview", "knowledge_snapshot_restore_apply"];
function contract() {
  return JSON.parse(execFileSync("python3", ["-c", `
import ast,asyncio,json,sys
from pathlib import Path
from fastmcp import FastMCP
source=(Path(sys.argv[1])/"knowledge_snapshots.py").read_text()
node,=[n for n in ast.walk(ast.parse(source)) if isinstance(n,ast.FunctionDef) and n.name=="knowledge_snapshot_configure"]
annotations=ast.literal_eval(next(k.value for k in node.decorator_list[0].keywords if k.arg=="annotations"))
node.decorator_list=[]
scope={}
exec(compile(ast.Module(body=[node],type_ignores=[]),"<source>","exec"),scope)
mcp=FastMCP("original-snapshot-configure")
mcp.tool(annotations=annotations)(scope[node.name])
async def main():
 tool,=await mcp.list_tools()
 print(json.dumps(tool.to_mcp_tool().model_dump(mode="json")))
asyncio.run(main())
`, join(repository, "resources")], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }));
}
for (const profile of ["compact", "legacy"]) test(`managed native snapshot scheduler uses exact existing host admission (${profile})`,
  { timeout: 90_000 }, async t => {
    const parent = join(root, "tests", `.legacy-snapshot-scheduler-mcp-${randomUUID()}`);
    await mkdir(parent);
    const data = await initialize(join(parent, "workspace"));
    const managed = await legacyManagedFixture(parent);
    let client;
    t.after(async () => { try { await client?.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
    const storage = await Storage.open(data);
    let enrollment;
    try {
      await storage.provisionTrash();
      const workspaceId = await storage.workspaceId(), stat = await lstat(data);
      await admitLegacyKnowledgeSnapshots(storage, actor, {
        authorityId: "explicit-snapshot-scheduler-test", allowedTools,
        authorize: binding => binding.actorId === actor.id && binding.workspaceId === workspaceId
          && binding.workspaceRoot === data && binding.privateGitRoot === join(data, "packages/knowledge-snapshots/repository.git")
          && binding.authorityId === "explicit-snapshot-scheduler-test" && binding.operation === "admit"
          && JSON.stringify([...binding.allowedTools].sort()) === JSON.stringify([...allowedTools].sort())
          && (binding.rootPin === undefined || binding.rootPin === `${stat.dev}:${stat.ino}`),
      });
      enrollment = inspectLegacyKnowledgeSnapshotSchedulerEnrollment(data);
    } finally { await storage.close(); }
    await writeFile(join(managed, "launch.json"), JSON.stringify({ data, allowWrites: true, snapshotScheduler: enrollment }));
    async function connect() {
      client = new Client({ name: "original-native-snapshot-scheduler", version: "1" });
      await client.connect(new StdioClientTransport({ command: "python3",
        args: [join(root, "compat/legacy-compact-mcp.py"), "--data", data, "--node", process.execPath,
          "--managed-generation", managed, "--allow-writes", "--experimental-managed-snapshot-scheduler", enrollment.admissionSha256],
        env: { ...process.env, PKM_CAPABILITY_PROFILE: profile, PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe" }));
    }
    const request = (name, args, write = true) => client.callTool(profile === "legacy" ? { name, arguments: args } : {
      name: write ? "capability_call" : "capability_read", arguments: { operation: `mcp.tool.${name}`, version: 1, arguments: args },
    });
    await connect();
    const described = await client.callTool({ name: "capabilities_describe", arguments: { operation: "mcp.tool.knowledge_snapshot_configure" } });
    assert.notEqual(described.isError, true, JSON.stringify(described));
    for (const key of ["description", "inputSchema", "outputSchema"])
      assert.deepEqual(described.structuredContent[key], contract()[key] ?? null, key);
    const enabled = await request("knowledge_snapshot_configure", { enabled: true, local_time: "17:00", timezone: "America/Los_Angeles" });
    assert.notEqual(enabled.isError, true, JSON.stringify(enabled));
    assert.equal(enabled.structuredContent.enabled, true);
    assert.equal(enabled.structuredContent.timezone, "America/Los_Angeles");
    assert(Number.isFinite(Date.parse(enabled.structuredContent.next_run_utc)));
    await closeLegacyManagedFixture(client);
    await connect();
    const status = await request("knowledge_snapshot_status", {}, false);
    assert.notEqual(status.isError, true, JSON.stringify(status));
    const disabled = await request("knowledge_snapshot_configure", { enabled: false, local_time: "17:00", timezone: "America/Los_Angeles" });
    assert.notEqual(disabled.isError, true, JSON.stringify(disabled));
    assert.equal(disabled.structuredContent.enabled, false);
    await closeLegacyManagedFixture(client);
    const reopened = await Storage.open(data);
    try {
      const db = reopened.connectNative();
      try {
        assert.equal(Number(db.prepare("PRAGMA user_version").get().user_version), 26);
        const rows = db.prepare("SELECT payload FROM native_knowledge_snapshot_schedule_events ORDER BY sequence").all();
        const configs = rows.map(row => JSON.parse(row.payload).event).filter(event => event.kind === "configure");
        assert.deepEqual(configs.map(event => event.enabled), [true, false]);
      } finally { db.close(); }
    } finally { await reopened.close(); }
    assert.equal(JSON.parse(await readFile(join(managed, "launch.json"), "utf8")).snapshotScheduler.admissionSha256, enrollment.admissionSha256);
  });
