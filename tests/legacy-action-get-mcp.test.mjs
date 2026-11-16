import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import {
  LEGACY_ACTION_RUNTIME_UNAVAILABLE, admitLegacyActionPackage,
} from "../dist/legacy-action-catalog.js";
import { legacyActionRead } from "../dist/legacy-action-mcp.js";
import { originalActionCompilerFixtures as original } from "./action-compiler-original-fixtures.mjs";
import { portableActionArchive, portableActionManifest } from "./legacy-action-catalog-fixture.mjs";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { legacyManagedFixture, closeLegacyManagedFixture } from "./legacy-managed-fixture.mjs";
import { originalActionFixture } from "./legacy-action-original-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const actor = { id: "mcp:external", canWrite: true };

function oracle(data, source, archive) {
  return originalActionFixture(dirname(data)).json(`
import ast,asyncio,json,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from fastmcp import FastMCP
from action_runtime import ActionRuntime, DEFINITIONS
from action_run_store import action_contract
runtime=ActionRuntime(sys.argv[2])
runtime.modules.proposal_mode=True
runtime.modules.configure_workspace(sys.argv[3])
runtime.modules.module_set_import(sys.argv[4])
runtime.modules.module_set_load(sys.argv[5],int(sys.argv[6]))
tree=ast.parse((Path(sys.argv[1])/"action_runtime.py").read_text())
node,=[n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=="action_get"]
exec(compile(ast.Module(body=[node],type_ignores=[]),"<original-action-get>","exec"))
action_get.__annotations__["return"]=dict
mcp=FastMCP("action-get-oracle")
mcp.tool(annotations={"readOnlyHint":True})(action_get)
async def main():
 tool,=await mcp.list_tools()
 print(json.dumps({"contract":tool.to_mcp_tool().model_dump(mode="json"),"value":action_get(sys.argv[7])}))
asyncio.run(main())
`, [data, source, archive, portableActionManifest.module_set_id,
    String(portableActionManifest.version), original.example.action_id]);
}

for (const profile of ["compact", "legacy"]) test(`original Action get returns only blocked selected native package (${profile})`,
  { timeout: 90_000 }, async t => {
    const parent = join(root, "tests", `.legacy-action-get-${randomUUID()}`);
    await mkdir(join(parent, "oracle"), { recursive: true });
    let client;
    t.after(async () => { try { await client?.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
    const data = await initialize(join(parent, "workspace")), source = join(parent, "source");
    await mkdir(source);
    const archive = join(source, "action.zip"), bytes = portableActionArchive();
    await writeFile(archive, bytes);
    const expected = oracle(join(parent, "oracle"), source, archive);
    assert.equal(expected.value.availability.state, "blocked");
    expected.value.availability.reason = LEGACY_ACTION_RUNTIME_UNAVAILABLE;
    const storage = await Storage.open(data);
    try {
      const workspaceId = await storage.workspaceId(), digest = createHash("sha256").update(bytes).digest("hex");
      await assert.rejects(legacyActionRead(storage, actor, { tool: "action_get",
        arguments: { action_id: original.example.action_id } }), /Only selected/);
      await assert.rejects(legacyActionRead(storage, { ...actor, id: "user:local" }, { tool: "action_get",
        arguments: { action_id: original.example.action_id } }), /fixed external actor/);
      await assert.rejects(legacyActionRead(storage, { ...actor, boardWorker: { boardSlug: "Board", digest: "a".repeat(64) } },
        { tool: "action_get", arguments: { action_id: original.example.action_id } }), /fixed external actor/);
      await admitLegacyActionPackage(storage, actor, {
        sourceRoot: source, sourcePath: archive, expectedPackageSha256: digest, authorityId: "test-action-get",
        authorize: binding => binding.workspaceId === workspaceId && binding.sourcePath === archive
          && binding.packageSha256 === digest && binding.actorId === actor.id,
      });
    } finally { await storage.close(); }
    const managed = await legacyManagedFixture(parent);
    async function connect(target, writable = true) {
      client = new Client({ name: "original-action-get", version: "1" });
      await client.connect(new StdioClientTransport({ command: "python3",
        args: [join(root, "compat/legacy-compact-mcp.py"), "--data", target, "--node", process.execPath,
          "--managed-generation", managed, ...(writable ? ["--allow-writes"] : [])],
        env: { ...process.env, PKM_CAPABILITY_PROFILE: profile, PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe" }));
    }
    async function invoke(name, args, write = false) {
      const response = await client.callTool(profile === "legacy" ? { name, arguments: args } : {
        name: write ? "capability_call" : "capability_read",
        arguments: { operation: `mcp.tool.${name}`, version: 1, arguments: args },
      });
      assert.notEqual(response.isError, true, JSON.stringify(response));
      return response.structuredContent;
    }
    await connect(data);
    const described = await client.callTool({ name: "capabilities_describe", arguments: { operation: "mcp.tool.action_get" } });
    for (const key of ["description", "inputSchema", "outputSchema"])
      assert.deepEqual(described.structuredContent[key], expected.contract[key] ?? null, key);
    assert.equal(described.structuredContent.readOnly, true);
    await invoke("action_module_set_import", { local_path: archive }, true);
    const selection = { module_set_id: portableActionManifest.module_set_id, version: portableActionManifest.version };
    const get = { operation: "mcp.tool.action_get", version: 1, arguments: { action_id: original.example.action_id } };
    assert.equal((await client.callTool({ name: "capability_read", arguments: get })).isError, true);
    await invoke("action_module_set_load", selection, true);
    assert.deepEqual(await invoke("action_get", { action_id: original.example.action_id }), expected.value);
    for (const args of [{ action_id: "core.delay" }, { action_id: "other.action" },
      { action_id: original.example.action_id, actorId: "user:local" }]) {
      const denied = await client.callTool({ name: "capability_read", arguments: {
        operation: "mcp.tool.action_get", version: 1, arguments: args,
      } });
      assert.equal(denied.isError, true);
    }
    await invoke("action_module_set_load", { ...selection, enabled: false }, true);
    assert.equal((await client.callTool({ name: "capability_read", arguments: get })).isError, true);
    await invoke("action_module_set_load", selection, true);
    await closeLegacyManagedFixture(client);
    await rm(source, { recursive: true });
    const reopened = await Storage.open(data), native = await createNativeRuntime({ storage: reopened });
    const backup = join(parent, "backup"), relocated = join(parent, "relocated");
    try { await createWorkspaceBackup(reopened, backup, { acquireQuiescence: native.acquireWorkspaceQuiescence }); }
    finally { await native.close(); await reopened.close(); }
    await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority });
    await connect(relocated, false);
    assert.deepEqual(await invoke("action_get", { action_id: original.example.action_id }), expected.value);
    await closeLegacyManagedFixture(client);
  });
