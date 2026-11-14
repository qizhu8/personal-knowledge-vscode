import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize } from "../dist/storage.js";
import { legacyManagedFixture, closeLegacyManagedFixture } from "./legacy-managed-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "legacy");
const oracle = `
import asyncio, importlib.util, json, sys
from pathlib import Path
from fastmcp import FastMCP
request = json.load(sys.stdin)
spec = importlib.util.spec_from_file_location("original_agent", request["source"])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
store = Path(request["store"])
payload = {"session":{"task":"Continue original","origin":"pkm-native","hostKind":"pkm","status":"paused",
    "todos":[{"todoId":"todo_1","title":"Verify","status":"done"}],
    "checkpoints":[{"checkpointId":"checkpoint_1","sequence":1,"state":{"done":True}}],
    "nativeChat":{"messages":[{"role":"user","content":"Private context","status":"complete"}]}},
    "recipeRuns":[{"runId":"run_1","recipeId":"recipe_1","nodes":{"work":{"state":"done"}}}]}
directory = store / ".pkm/state/agent-snapshots"; directory.mkdir(parents=True,exist_ok=True)
snapshot = {"schema":module.SNAPSHOT_SCHEMA,"snapshotId":"agent_snapshot_fixture","magicCode":"PKM-SNAP-FIXTURE",
    "task":"Continue original","createdAt":"2026-01-01","capture":module._snapshot_capture(payload),
    "payload":module._snapshot_encrypt_payload(payload,"agent_snapshot_fixture","PKM-SNAP-FIXTURE")}
(directory/"agent_snapshot_fixture.json").write_text(json.dumps(snapshot),encoding="utf-8")
mcp=FastMCP("original-agent")
functions=module.register_agent_session_tools(mcp,store)
async def main():
    tools={tool.name:tool.to_mcp_tool().model_dump(mode="json") for tool in await mcp.list_tools()}
    values=[functions[call["tool"]](**call["arguments"]) for call in request["calls"]]
    print(json.dumps({"tools":tools,"values":values},ensure_ascii=False))
asyncio.run(main())
`;
for (const profile of ["compact", "legacy"]) test(`original encrypted Agent snapshot reads (${profile})`,
  { timeout: 60_000 }, async t => {
    const parent = await mkdtemp(join(tmpdir(), "pkm-agent-read-"));
    let client;
    t.after(async () => { try { await client?.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
    const data = await initialize(join(parent, "workspace"));
    const managed = await legacyManagedFixture(parent);
    const staged = join(data, "agent-snapshot-reads");
    const calls = [
      { tool: "agent_session_capabilities", arguments: {} },
      { tool: "agent_session_snapshot_list", arguments: {} },
      { tool: "agent_session_snapshot_read", arguments: { magic_code: " pkm-snap-fixture ", recent_messages: 0 } },
      { tool: "agent_session_snapshot_read", arguments: { magic_code: "PKM-SNAP-FIXTURE", recent_messages: 50 } },
    ];
    const expected = JSON.parse(execFileSync("python3", ["-c", oracle], { input: JSON.stringify({
      source: join(repository, "resources/agent_session_runtime.py"), store: staged, calls,
    }), encoding: "utf8" }));
    const snapshotFile = join(staged, ".pkm/state/agent-snapshots/agent_snapshot_fixture.json");
    const before = await readFile(snapshotFile);
    async function connect() {
      const transport = new StdioClientTransport({ command: "python3",
        args: [join(root, "compat/legacy-compact-mcp.py"), "--data", data, "--node", process.execPath, "--managed-generation", managed],
        env: { ...process.env, PKM_CAPABILITY_PROFILE: profile, PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe" });
      let diagnostics = "";
      transport.stderr?.on("data", chunk => { diagnostics += chunk; });
      try { await client.connect(transport); } catch (error) { throw new Error(diagnostics, { cause: error }); }
    }
    for (let restart = 0; restart < 2; restart++) {
      client = new Client({ name: "original-agent-read", version: "1.0.0" });
      await connect();
      for (const [index, call] of calls.entries()) {
        const description = await client.callTool({ name: "capabilities_describe",
          arguments: { operation: `mcp.tool.${call.tool}` } });
        assert.deepEqual(description.structuredContent.inputSchema, expected.tools[call.tool].inputSchema);
        assert.deepEqual(description.structuredContent.outputSchema, expected.tools[call.tool].outputSchema);
        const direct = await client.callTool({ name: call.tool, arguments: call.arguments });
        assert.notEqual(direct.isError, true, JSON.stringify(direct));
        assert.deepEqual(direct.structuredContent, expected.values[index]);
        const deferred = await client.callTool({ name: "capability_read", arguments: {
          operation: `mcp.tool.${call.tool}`, version: 1, arguments: call.arguments,
        } });
        assert.deepEqual(deferred, direct);
      }
      assert.equal((await client.callTool({ name: "agent_session_snapshot_read",
        arguments: { magic_code: "PKM-SNAP-FIXTURE", recent_messages: 51 } })).isError, true);
      assert.deepEqual(await readFile(snapshotFile), before);
      await closeLegacyManagedFixture(client);
    }
    const plain = JSON.parse(before);
    plain.payload = { session: {}, recipeRuns: [] };
    await writeFile(snapshotFile, JSON.stringify(plain));
    client = new Client({ name: "agent-read-migration-refusal", version: "1.0.0" });
    await connect();
    const unavailable = await client.callTool({ name: "agent_session_snapshot_read",
      arguments: { magic_code: "PKM-SNAP-FIXTURE" } });
    assert.equal(unavailable.isError, true);
    assert.match(JSON.stringify(unavailable), /original encryption migration/);
    assert.deepEqual(JSON.parse(await readFile(snapshotFile, "utf8")), plain);
  });
