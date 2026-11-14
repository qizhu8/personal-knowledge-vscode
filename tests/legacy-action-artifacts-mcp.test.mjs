import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize, Storage } from "../dist/storage.js";
import { admitLegacyActionArtifactPath } from "../dist/legacy-action-artifacts.js";
import { legacyManagedFixture, closeLegacyManagedFixture } from "./legacy-managed-fixture.mjs";

const root = resolve(import.meta.dirname, ".."), repository = resolve(root, "..");
const actor = { id: "mcp:external", canWrite: true };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function contracts() {
  return JSON.parse(execFileSync("python3", ["-c", `
import ast,asyncio,json,sys
from pathlib import Path
from fastmcp import FastMCP
source=(Path(sys.argv[1])/"action_runtime.py").read_text()
tree=ast.parse(source)
mcp=FastMCP("original-action-artifacts")
for name in ["action_artifact_import","action_artifact_export"]:
 node,=[n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name==name]
 scope={}
 exec(compile(ast.Module(body=[node],type_ignores=[]),"<source>","exec"),scope)
 function=scope[name]
 function.__annotations__["return"]=dict
 mcp.tool(annotations={"readOnlyHint":False})(function)
async def main():
 print(json.dumps({t.name:t.to_mcp_tool().model_dump(mode="json") for t in await mcp.list_tools()}))
asyncio.run(main())
`, join(repository, "resources")], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }));
}
for (const profile of ["compact", "legacy"]) test(`original Action artifact MCP contracts and explicit host grants (${profile})`,
  { timeout: 90_000 }, async t => {
    const parent = join(root, "tests", `.legacy-action-artifacts-mcp-${randomUUID()}`);
    const selectedRoot = join(parent, "selected");
    await mkdir(selectedRoot, { recursive: true });
    const data = await initialize(join(parent, "workspace")), source = join(selectedRoot, "source.bin");
    const destination = join(selectedRoot, "result.bin"), bytes = Buffer.from([0, 1, 255, 13, 10, 7]);
    await writeFile(source, bytes);
    const managed = await legacyManagedFixture(parent);
    let client;
    t.after(async () => { try { await client?.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
    async function connect(writable = true) {
      client = new Client({ name: "original-action-artifact-mcp", version: "1" });
      await client.connect(new StdioClientTransport({ command: "python3",
        args: [join(root, "compat/legacy-compact-mcp.py"), "--data", data, "--node", process.execPath,
          "--managed-generation", managed, ...(writable ? ["--allow-writes"] : [])],
        env: { ...process.env, PKM_CAPABILITY_PROFILE: profile, PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe" }));
    }
    const request = (name, args) => client.callTool(profile === "legacy" ? { name, arguments: args } : {
      name: "capability_call", arguments: { operation: `mcp.tool.${name}`, version: 1, arguments: args },
    });
    await connect();
    assert.equal((await request("action_artifact_import", { local_path: source })).isError, true);
    for (const [name, contract] of Object.entries(contracts())) {
      const described = await client.callTool({ name: "capabilities_describe", arguments: { operation: `mcp.tool.${name}` } });
      assert.notEqual(described.isError, true);
      for (const key of ["description", "inputSchema", "outputSchema"])
        assert.deepEqual(described.structuredContent[key], contract[key] ?? null, key);
      assert.equal(described.structuredContent.readOnly, false);
    }
    await closeLegacyManagedFixture(client);
    const storage = await Storage.open(data);
    try {
      const workspaceId = await storage.workspaceId(), stat = await lstat(data);
      for (const [kind, path, expectedSha256] of [["source", source, sha(bytes)], ["destination", destination, undefined]]) {
        await admitLegacyActionArtifactPath(storage, actor, {
          kind, selectedRoot, path, expectedSha256, authorityId: "native-approved-artifact",
          authorize: binding => binding.actorId === actor.id && binding.workspaceId === workspaceId
            && binding.workspaceRoot === data && binding.workspaceRootPin === `${stat.dev}:${stat.ino}`
            && binding.kind === kind && binding.selectedRoot === selectedRoot && binding.path === path
            && binding.expectedSha256 === (expectedSha256 ?? null) && binding.authorityId === "native-approved-artifact",
        });
      }
    } finally { await storage.close(); }
    await connect();
    const imported = await request("action_artifact_import", { local_path: source });
    assert.notEqual(imported.isError, true, JSON.stringify(imported));
    const artifact_id = imported.structuredContent.artifact_id;
    assert.match(artifact_id, /^artifact_[a-f0-9]{32}$/);
    const spoof = await request("action_artifact_export", { artifact_id, destination, actorId: "user:local" });
    assert.equal(spoof.isError, true);
    const exported = await request("action_artifact_export", { artifact_id, destination });
    assert.notEqual(exported.isError, true, JSON.stringify(exported));
    assert.deepEqual(exported.structuredContent, { ok: true, path: destination, digest: sha(bytes), ownership: "user-exported" });
    assert.deepEqual(await readFile(destination), bytes);
    assert.equal((await request("action_artifact_export", { artifact_id, destination })).isError, true);
    await closeLegacyManagedFixture(client);
    await connect(false);
    assert.equal((await client.callTool({ name: "capabilities_describe", arguments: {
      operation: "mcp.tool.action_artifact_import",
    } })).isError, true);
    await closeLegacyManagedFixture(client);
  });
