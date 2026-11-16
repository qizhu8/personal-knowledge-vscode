import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { admitLegacyKnowledgeRecovery } from "../dist/legacy-knowledge-recovery.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { legacyManagedFixture, closeLegacyManagedFixture } from "./legacy-managed-fixture.mjs";

const root = resolve(import.meta.dirname, ".."), repository = resolve(root, "legacy");
const sha = value => createHash("sha256").update(value).digest("hex");
const originalSource = await readFile(join(repository, "resources/knowledge_recovery.py"), "utf8");
const contracts = JSON.parse(execFileSync("python3", ["-c", `
import ast,asyncio,json,sys
from fastmcp import FastMCP
mcp=FastMCP("independent-original-recovery-contract")
tree=ast.parse(sys.stdin.read())
selected={"knowledge_recovery_preview","knowledge_recovery_apply"}
nodes=[node for node in ast.walk(tree) if isinstance(node,ast.FunctionDef) and node.name in selected]
exec(compile(ast.Module(body=nodes,type_ignores=[]),"<actual-original-recovery>","exec"))
async def main():
 print(json.dumps({tool.name:tool.to_mcp_tool().model_dump(mode="json") for tool in await mcp.list_tools()}))
asyncio.run(main())
`], { input: originalSource, encoding: "utf8" }));

for (const profile of ["compact", "legacy"])
test(`original recovery source contract uses admitted actor/root, immutable missing-only plan and native receipts (${profile})`,
  { timeout: 90_000 }, async t => {
    const parent = join(root, "tests", `.legacy-recovery-mcp-${randomUUID()}`);
    await mkdir(parent);
    const data = await initialize(join(parent, "workspace")), evidence = join(parent, "evidence");
    await mkdir(join(evidence, "blobs"), { recursive: true });
    const content = Buffer.from("---\r\ntitle: Recovery proof\r\nunknown: keep-exact\r\n---\r\nOriginal raw bytes.\r\n");
    const plan = Buffer.from(JSON.stringify({ schema: "pkm.knowledge-recovery/v1", knowledgeRoot: data,
      files: [{ path: "notes/Recovered.md", sha256: sha(content), mode: "100644" }] }));
    await writeFile(join(evidence, "plan.json"), plan);
    await writeFile(join(evidence, "blobs", sha(content)), content);
    const storage = await Storage.open(data);
    try { await admitLegacyKnowledgeRecovery(storage, { id: "mcp:external", canWrite: true }, {
      evidenceRoot: evidence, auditRoot: evidence, expectedPlanSha256: sha(plan),
      authorityId: "test-native-evidence-and-audit-owner", authorize: () => true,
    }); } finally { await storage.close(); }
    const managed = await legacyManagedFixture(parent);
    let client;
    t.after(async () => { try { await client?.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
    const connect = async (target, allowWrites = true) => {
      client = new Client({ name: "original-recovery-client", version: "1" });
      await client.connect(new StdioClientTransport({ command: "python3",
        args: [join(root, "compat/legacy-compact-mcp.py"), "--data", target, "--node", process.execPath,
          "--managed-generation", managed, ...(allowWrites ? ["--allow-writes"] : [])],
        env: { ...process.env, PKM_CAPABILITY_PROFILE: profile, PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe" }));
    };
    const invoke = async (name, args, write = false) => {
      const response = await client.callTool(profile === "legacy" ? { name, arguments: args } : {
        name: write ? "capability_call" : "capability_read",
        arguments: { operation: `mcp.tool.${name}`, version: 1, arguments: args },
      });
      assert.notEqual(response.isError, true, JSON.stringify(response));
      return response.structuredContent;
    };
    await connect(data);
    for (const [name, contract] of Object.entries(contracts)) {
      const description = await client.callTool({ name: "capabilities_describe", arguments: { operation: `mcp.tool.${name}` } });
      assert.notEqual(description.isError, true, JSON.stringify(description));
      assert.deepEqual(description.structuredContent.inputSchema, contract.inputSchema, name);
      assert.deepEqual(description.structuredContent.outputSchema, contract.outputSchema ?? null, name);
      assert.equal(description.structuredContent.description, contract.description, name);
      assert.equal(description.structuredContent.readOnly, contract.annotations.readOnlyHint, name);
    }
    const args = { evidence_directory: evidence };
    const preview = await invoke("knowledge_recovery_preview", args);
    assert.deepEqual(preview, {
      schema: "pkm.knowledge-recovery-preview/v1", knowledge_root: data, plan_sha256: sha(plan),
      counts: { restore: 1, identical: 0, "preserve-existing": 0 },
      files: [{ path: "notes/Recovered.md", status: "restore" }],
    });
    for (const bad of [{ evidence_directory: join(parent, "unadmitted") },
      { ...args, actorId: "user:local" }, { ...args, evidenceRoot: evidence }]) {
      assert.equal((await client.callTool({ name: "capability_read", arguments: {
        operation: "mcp.tool.knowledge_recovery_preview", version: 1, arguments: bad,
      } })).isError, true);
    }
    const result = await invoke("knowledge_recovery_apply", { ...args, approved_plan_sha256: preview.plan_sha256 }, true);
    assert.equal(result.ok, true);
    assert.equal(result.restored, 1);
    assert.deepEqual(await readFile(join(data, "notes/Recovered.md")), content);
    assert.equal(JSON.parse(await readFile(result.report, "utf8")).plan_sha256, preview.plan_sha256);
    await closeLegacyManagedFixture(client);
    await connect(data, false);
    assert.equal((await invoke("knowledge_recovery_preview", args)).counts.identical, 1);
    assert.equal((await client.callTool({ name: "capabilities_describe", arguments: {
      operation: "mcp.tool.knowledge_recovery_apply",
    } })).isError, true);
    await closeLegacyManagedFixture(client);
    const reopened = await Storage.open(data), native = await createNativeRuntime({ storage: reopened });
    const backup = join(parent, "backup"), relocated = join(parent, "relocated");
    await rm(evidence, { recursive: true });
    try { await createWorkspaceBackup(reopened, backup, { acquireQuiescence: native.acquireWorkspaceQuiescence }); }
    finally { await native.close(); await reopened.close(); }
    await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority });
    await connect(relocated);
    assert.deepEqual(await readFile(join(relocated, "notes/Recovered.md")), content);
    const noRemap = await client.callTool({ name: "capability_read", arguments: {
      operation: "mcp.tool.knowledge_recovery_preview", version: 1, arguments: args,
    } });
    assert.equal(noRemap.isError, true);
    await closeLegacyManagedFixture(client);
  });
