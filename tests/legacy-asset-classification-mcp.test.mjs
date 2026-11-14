import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize } from "../dist/storage.js";
import { legacyManagedFixture, closeLegacyManagedFixture } from "./legacy-managed-fixture.mjs";
import { originalLoader } from "./host-composition-legacy-batch15-captures.mjs";

const root = resolve(import.meta.dirname, ".."), repository = resolve(root, "..");
const allowedTools = ["asset_classify_preview", "asset_classify_apply", "asset_classify_rollback"];
function contracts() {
  return JSON.parse(execFileSync("python3", ["-c", `
import ast,asyncio,json,sys
from pathlib import Path
from fastmcp import FastMCP
source=(Path(sys.argv[1])/"asset_classification.py").read_text()
mcp=FastMCP("original-asset-classification")
for node in ast.walk(ast.parse(source)):
 if isinstance(node,ast.FunctionDef) and node.name in ${JSON.stringify(allowedTools)}:
  annotations=ast.literal_eval(next(k.value for k in node.decorator_list[0].keywords if k.arg=="annotations"))
  node.decorator_list=[]
  scope={}
  exec(compile(ast.Module(body=[node],type_ignores=[]),"<source>","exec"),scope)
  mcp.tool(annotations=annotations)(scope[node.name])
async def main():
 print(json.dumps({t.name:t.to_mcp_tool().model_dump(mode="json") for t in await mcp.list_tools()}))
asyncio.run(main())
`, join(repository, "resources")], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }));
}

for (const profile of ["compact", "legacy"]) test(`original asset classification MCP uses native authority and session previews (${profile})`,
  { timeout: 90_000 }, async t => {
    const parent = join(root, "tests", `.legacy-classification-mcp-${randomUUID()}`);
    await mkdir(parent);
    const data = await initialize(join(parent, "workspace"));
    await mkdir(join(data, "notes", "Engineering"), { recursive: true });
    const note = join(data, "notes", "Engineering", "a.md"), original = Buffer.from("# Original\n\nClassification fixture.\n");
    await writeFile(note, original);
    const managed = await legacyManagedFixture(parent);
    let client;
    t.after(async () => { try { await client?.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
    async function connect(writable = true, classification = false) {
      client = new Client({ name: "original-classification-mcp", version: "1" });
      await client.connect(new StdioClientTransport({ command: "python3",
        args: [join(root, "compat/legacy-compact-mcp.py"), "--data", data, "--node", process.execPath,
          "--managed-generation", managed, ...(writable ? ["--allow-writes"] : []),
          ...(classification ? ["--allow-asset-classification"] : [])],
        env: { ...process.env, PKM_CAPABILITY_PROFILE: profile, PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe" }));
    }
    const call = (name, args, readOnly = false) => client.callTool(profile === "legacy" ? { name, arguments: args } : {
      name: readOnly ? "capability_read" : "capability_call",
      arguments: { operation: `mcp.tool.${name}`, version: 1, arguments: args },
    });
    const good = async (name, args, readOnly = false) => {
      const result = await call(name, args, readOnly);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return result.structuredContent;
    };
    await connect();
    assert.equal((await client.callTool({ name: "capabilities_describe", arguments: {
      operation: "mcp.tool.asset_classify_preview",
    } })).isError, true);
    await closeLegacyManagedFixture(client);
    await connect(true, true);
    for (const [name, contract] of Object.entries(contracts())) {
      const result = await client.callTool({ name: "capabilities_describe", arguments: { operation: `mcp.tool.${name}` } });
      assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result)}`);
      for (const key of ["description", "inputSchema", "outputSchema"])
        assert.deepEqual(result.structuredContent[key], contract[key] ?? null, `${name}:${key}`);
    }
    const preview = await good("asset_classify_preview", {}, true);
    assert.deepEqual(preview, originalLoader()("src/knowledge/asset-classification.ts").previewAssetClassification(data));
    const proposal = preview.proposals.find(row => row.type === "classification" && row.asset === "notes/Engineering/a.md");
    assert(proposal);
    const applied = await good("asset_classify_apply", { preview_id: preview.id, proposal_ids: [proposal.id] });
    assert(applied.applied.includes(proposal.id));
    assert.notDeepEqual(await readFile(note), original);
    await closeLegacyManagedFixture(client);
    await connect(true, true);
    assert.equal((await call("asset_classify_apply", { preview_id: preview.id, proposal_ids: [proposal.id] })).isError, true);
    const rolledBack = await good("asset_classify_rollback", { journal_id: applied.journalId });
    assert(rolledBack.applied.includes(proposal.id));
    assert.deepEqual(await readFile(note), original);
    await closeLegacyManagedFixture(client);
    await connect(false);
    assert.equal((await client.callTool({ name: "capabilities_describe", arguments: {
      operation: "mcp.tool.asset_classify_apply",
    } })).isError, true);
    await closeLegacyManagedFixture(client);
    client = undefined;
  });
