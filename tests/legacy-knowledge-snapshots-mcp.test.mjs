import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Storage, initialize } from "../dist/storage.js";
import { admitLegacyKnowledgeSnapshots } from "../dist/legacy-knowledge-snapshots.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { legacyManagedFixture, closeLegacyManagedFixture } from "./legacy-managed-fixture.mjs";

const root = resolve(import.meta.dirname, ".."), repository = resolve(root, "..");
const tools = ["knowledge_snapshot_status", "knowledge_snapshot_create",
  "knowledge_snapshot_restore_preview", "knowledge_snapshot_restore_apply"];
const source = await readFile(join(repository, "resources/knowledge_snapshots.py"), "utf8");
const contracts = JSON.parse(execFileSync("python3", ["-c", `
import ast,asyncio,json,sys
from fastmcp import FastMCP
request=json.load(sys.stdin)
mcp=FastMCP("independent-original-private-git-contracts")
for node in ast.walk(ast.parse(request["source"])):
 if isinstance(node,ast.FunctionDef) and node.name in request["tools"]:
  exec(compile(ast.Module(body=[node],type_ignores=[]),"<actual-original-private-git>","exec"))
async def main():
 print(json.dumps({t.name:t.to_mcp_tool().model_dump(mode="json") for t in await mcp.list_tools()}))
asyncio.run(main())
`], { input: JSON.stringify({ source, tools }), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }));

for (const profile of ["compact", "legacy"])
test(`original private-Git snapshot tools consume exact host scope, restore through Trash and retain schema25 state on relocation (${profile})`,
  { timeout: 120_000 }, async t => {
    const parent = join(root, "tests", `.legacy-snapshots-mcp-${randomUUID()}`);
    await mkdir(parent);
    const data = await initialize(join(parent, "workspace"));
    const original = Buffer.from("---\r\ntitle: Snapshot proof\r\nunknown: preserve\r\n---\r\nOriginal raw bytes.\r\n");
    const changed = Buffer.from("---\ntitle: Snapshot proof\nunknown: changed\n---\nChanged bytes.\n");
    await writeFile(join(data, "notes/Proof.md"), original);
    const managed = await legacyManagedFixture(parent);
    let client;
    t.after(async () => { try { await client?.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
    const connect = async (target, writable = true) => {
      client = new Client({ name: "original-private-git-client", version: "1" });
      await client.connect(new StdioClientTransport({ command: "python3",
        args: [join(root, "compat/legacy-compact-mcp.py"), "--data", target, "--node", process.execPath,
          "--managed-generation", managed, ...(writable ? ["--allow-writes"] : [])],
        env: { ...process.env, PKM_CAPABILITY_PROFILE: profile, PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe" }));
    };
    const request = (name, args, write = false) => client.callTool(profile === "legacy" ? { name, arguments: args } : {
      name: write ? "capability_call" : "capability_read",
      arguments: { operation: `mcp.tool.${name}`, version: 1, arguments: args },
    });
    const invoke = async (name, args, write = false) => {
      const response = await request(name, args, write);
      assert.notEqual(response.isError, true, JSON.stringify(response));
      return response.structuredContent;
    };
    await connect(data);
    assert.equal((await request("knowledge_snapshot_status", {})).isError, true);
    await closeLegacyManagedFixture(client);
    await assert.rejects(readFile(join(data, "packages/knowledge-snapshots/repository.git/HEAD")), { code: "ENOENT" });
    const storage = await Storage.open(data);
    try {
      await storage.provisionTrash();
      const workspaceId = await storage.workspaceId(), stat = await lstat(data), rootPin = `${stat.dev}:${stat.ino}`;
      await admitLegacyKnowledgeSnapshots(storage, { id: "mcp:external", canWrite: true }, {
        authorityId: "test-native-fixed-private-repository", allowedTools: tools,
        authorize: binding => binding.actorId === "mcp:external" && binding.workspaceId === workspaceId
          && binding.workspaceRoot === data && binding.privateGitRoot === join(data, "packages/knowledge-snapshots/repository.git")
          && binding.authorityId === "test-native-fixed-private-repository" && binding.operation === "admit"
          && JSON.stringify([...binding.allowedTools].sort()) === JSON.stringify([...tools].sort())
          && (binding.rootPin === undefined || binding.rootPin === rootPin),
      });
    } finally { await storage.close(); }
    await connect(data);
    for (const [name, contract] of Object.entries(contracts)) {
      const description = await client.callTool({ name: "capabilities_describe", arguments: { operation: `mcp.tool.${name}` } });
      assert.notEqual(description.isError, true, JSON.stringify(description));
      assert.deepEqual(description.structuredContent.inputSchema, contract.inputSchema, name);
      assert.deepEqual(description.structuredContent.outputSchema, contract.outputSchema ?? null, name);
      assert.equal(description.structuredContent.description, contract.description, name);
      assert.equal(description.structuredContent.readOnly, contract.annotations.readOnlyHint, name);
    }
    assert.equal((await client.callTool({ name: "capabilities_describe", arguments: {
      operation: "mcp.tool.knowledge_snapshot_configure",
    } })).isError, true);
    const snapshot = await invoke("knowledge_snapshot_create", { reason: "native-approved MCP proof" }, true);
    assert.equal(snapshot.schema, "pkm.knowledge-snapshot/v1");
    assert.equal(snapshot.private, true);
    assert.deepEqual(snapshot.areas, ["skills", "notes", "papers", "prompts", "scripts"]);
    assert((await invoke("knowledge_snapshot_status", {})).tags.includes(snapshot.tag));
    for (const args of [{ actorId: "user:local" }, { root: data }, { allowedTools: tools }])
      assert.equal((await request("knowledge_snapshot_status", args)).isError, true);
    await writeFile(join(data, "notes/Proof.md"), changed);
    const preview = await invoke("knowledge_snapshot_restore_preview", { tag: snapshot.tag }, true);
    assert.deepEqual(preview.changes.map(change => [change.path, change.action]), [["notes/Proof.md", "restore"]]);
    assert.equal((await request("knowledge_snapshot_restore_apply", {
      preview_id: preview.preview_id, approved_sha256: "0".repeat(64),
    }, true)).isError, true);
    assert.deepEqual(await readFile(join(data, "notes/Proof.md")), changed);
    const restored = await invoke("knowledge_snapshot_restore_apply", {
      preview_id: preview.preview_id, approved_sha256: preview.approved_sha256,
    }, true);
    assert.equal(restored.schema, "pkm.snapshot-restore-result/v1");
    assert.equal(restored.status, "completed");
    assert.equal(restored.privacy_preserved, true);
    assert.deepEqual(restored.applied, ["notes/Proof.md"]);
    assert.deepEqual(await readFile(join(data, "notes/Proof.md")), original);
    await closeLegacyManagedFixture(client);
    await connect(data, false);
    assert((await invoke("knowledge_snapshot_status", {})).tags.includes(snapshot.tag));
    assert.equal((await client.callTool({ name: "capabilities_describe", arguments: {
      operation: "mcp.tool.knowledge_snapshot_create",
    } })).isError, true);
    await closeLegacyManagedFixture(client);
    const reopened = await Storage.open(data), native = await createNativeRuntime({ storage: reopened });
    const backup = join(parent, "backup"), relocated = join(parent, "relocated");
    try { await createWorkspaceBackup(reopened, backup, { acquireQuiescence: native.acquireWorkspaceQuiescence }); }
    finally { await native.close(); await reopened.close(); }
    await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority });
    await connect(relocated);
    assert.deepEqual(await readFile(join(relocated, "notes/Proof.md")), original);
    const result = await request("knowledge_snapshot_status", {});
    assert.equal(result.isError, true, "Relocation must not silently remap the old host repository authority.");
    await closeLegacyManagedFixture(client);
  });
