import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize } from "../dist/storage.js";
import {
  legacyActionCapabilitiesRead, legacyActionCapabilitiesRequest,
} from "../dist/legacy-action-mcp.js";
import { readActionCompiler } from "../dist/action-compiler.js";
import { legacyManagedFixture, closeLegacyManagedFixture } from "./legacy-managed-fixture.mjs";

const root = resolve(import.meta.dirname, ".."), repository = resolve(root, "legacy");
const actor = { id: "mcp:external", canWrite: false };
const request = { tool: "action_capabilities", arguments: {} };

function originalContract() {
  return JSON.parse(execFileSync("python3", ["-c", `
import ast,asyncio,json,sys
from pathlib import Path
from fastmcp import FastMCP
tree=ast.parse((Path(sys.argv[1])/"action_runtime.py").read_text())
node,=[n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=="action_capabilities"]
scope={}
exec(compile(ast.Module(body=[node],type_ignores=[]),"<original-action-capabilities>","exec"),scope)
function=scope["action_capabilities"]
function.__annotations__["return"]=dict
mcp=FastMCP("original-action-capabilities-contract")
mcp.tool(annotations={"readOnlyHint":True})(function)
fields=[key.value for statement in node.body if isinstance(statement,ast.Return) for key in statement.value.keys]
async def main():
 tool,=await mcp.list_tools()
 print(json.dumps({"contract":tool.to_mcp_tool().model_dump(mode="json"),"fields":fields}))
asyncio.run(main())
`, join(repository, "resources")], {
    encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  }));
}

function assertProjection(value, original) {
  assert.deepEqual(Object.keys(value).sort(), [
    "schema", "originalSchema", "compatibility", "runtimeStatus", "limitation",
    "unavailableOriginalFields", "compiler",
  ].sort());
  assert.equal(value.schema, "pkm.action.capabilities.limited/v1");
  assert.equal(value.originalSchema, "pkm.action.capabilities/v1");
  assert.equal(value.compatibility, "limited-projection");
  assert.equal(value.runtimeStatus, "not-runnable-here");
  assert.match(value.limitation, /not the original runtime capability contract/);
  assert.deepEqual(value.unavailableOriginalFields, original.fields.filter(field => field !== "schema"));
  for (const field of value.unavailableOriginalFields) assert.equal(Object.hasOwn(value, field), false, field);
  assert.deepEqual(value.compiler, readActionCompiler({ operation: "action.compiler.capabilities", args: {} }));
  assert.equal(value.compiler.runtimeStatus, "not-runnable-here");
  for (const name of ["execution", "qualification", "provider", "network", "credentials", "host-path-reads"])
    assert(value.compiler.unavailable.includes(name), name);
}

async function snapshot(directory) {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    result[entry.name] = entry.isDirectory() ? await snapshot(path)
      : createHash("sha256").update(await readFile(path)).digest("hex");
  }
  return result;
}

test("Action capabilities is an explicitly incomplete, deterministic, storage-free read with strict actor/request boundaries", async t => {
  const parent = join(root, "tests", `.legacy-action-capabilities-${randomUUID()}`);
  await mkdir(parent);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const data = await initialize(join(parent, "workspace")), before = await snapshot(data);
  const original = originalContract(), expected = legacyActionCapabilitiesRead(actor, request);
  assertProjection(expected, original);
  assert.deepEqual(legacyActionCapabilitiesRead({ ...actor, canWrite: true }, request), expected);
  for (let i = 0; i < 3; i++) assert.deepEqual(legacyActionCapabilitiesRead(actor, request), expected);
  for (const invalid of [
    { ...request, actorId: "user:local" },
    { ...request, arguments: { execute: true } },
    { ...request, arguments: { workspace: "/unavailable", provider: "remote" } },
    { tool: "action_call", arguments: {} },
  ]) {
    assert.equal(legacyActionCapabilitiesRequest.safeParse(invalid).success, false);
    assert.throws(() => legacyActionCapabilitiesRead(actor, invalid));
  }
  for (const denied of [
    { ...actor, id: "user:local" },
    { ...actor, boardWorker: { boardSlug: "Board", digest: "a".repeat(64) } },
  ]) assert.throws(() => legacyActionCapabilitiesRead(denied, request), /fixed external actor/);
  assert.deepEqual(await snapshot(data), before, "no files, catalog, proposals, grants, queue or execution records changed");
});

for (const profile of ["compact", "legacy"]) test(`Action capabilities is discoverable and callable by a read-only actor (${profile})`,
  { timeout: 90_000 }, async t => {
    const parent = join(root, "tests", `.legacy-action-capabilities-mcp-${randomUUID()}`);
    await mkdir(parent);
    let client;
    t.after(async () => { try { await client?.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
    const data = await initialize(join(parent, "workspace")), managed = await legacyManagedFixture(parent);
    client = new Client({ name: "bounded-action-capabilities", version: "1" });
    await client.connect(new StdioClientTransport({ command: "python3",
      args: [join(root, "compat/legacy-compact-mcp.py"), "--data", data, "--node", process.execPath,
        "--managed-generation", managed],
      env: { ...process.env, PKM_CAPABILITY_PROFILE: profile, PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe" }));
    const before = await snapshot(data);
    const original = originalContract();
    const operation = { operation: "mcp.tool.action_capabilities", version: 1, arguments: {} };
    const described = await client.callTool({ name: "capabilities_describe", arguments: { operation: operation.operation } });
    assert.notEqual(described.isError, true, JSON.stringify(described));
    const contract = described.structuredContent;
    assert.equal(contract.readOnly, true);
    assert.deepEqual(contract.inputSchema, original.contract.inputSchema);
    assert.deepEqual(contract.outputSchema, original.contract.outputSchema);
    assert.match(contract.description, /limited.*not live runtime\/provider/);
    assert.match(JSON.stringify(contract), /not-runnable-here/);
    const response = await client.callTool(profile === "legacy"
      ? { name: "action_capabilities", arguments: {} } : { name: "capability_read", arguments: operation });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    assertProjection(response.structuredContent, original);
    assert.equal((await client.callTool({ name: "capability_call", arguments: operation })).isError, true);
    for (const name of ["action_call", "action_validate", "action_validation_enqueue"]) {
      assert.equal((await client.callTool({ name: "capabilities_describe", arguments: {
        operation: `mcp.tool.${name}`,
      } })).isError, true, name);
    }
    assert.deepEqual(await snapshot(data), before, "capability discovery/read did not mutate the workspace");
    await closeLegacyManagedFixture(client);
  });
