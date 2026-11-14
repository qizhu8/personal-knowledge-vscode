import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize, Storage } from "../dist/storage.js";
import { legacyActionRead, legacyActionReadRequest } from "../dist/legacy-action-mcp.js";
import {
  LEGACY_ACTION_RUNTIME_UNAVAILABLE, admitLegacyActionPackage, legacyActionCatalog,
} from "../dist/legacy-action-catalog.js";
import { originalDigest } from "../dist/domain/action-compiler-validation.js";
import { originalActionCompilerFixtures as original } from "./action-compiler-original-fixtures.mjs";
import { portableActionManifest } from "./legacy-action-catalog-fixture.mjs";
import { legacyManagedFixture, closeLegacyManagedFixture } from "./legacy-managed-fixture.mjs";

const root = resolve(import.meta.dirname, ".."), repository = resolve(root, "..");
const actor = { id: "mcp:external", canWrite: false };

function originalContract() {
  return JSON.parse(execFileSync("python3", ["-c", `
import ast,asyncio,json,sys
from pathlib import Path
from fastmcp import FastMCP
tree=ast.parse((Path(sys.argv[1])/"action_runtime.py").read_text())
node,=[n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=="action_retrieve"]
scope={}
exec(compile(ast.Module(body=[node],type_ignores=[]),"<original-action-retrieve>","exec"),scope)
function=scope["action_retrieve"]
function.__annotations__["return"]=dict
mcp=FastMCP("original-action-retrieve-contract")
mcp.tool(annotations={"readOnlyHint":True})(function)
async def main():
 tool,=await mcp.list_tools()
 print(json.dumps(tool.to_mcp_tool().model_dump(mode="json")))
asyncio.run(main())
`, join(repository, "resources")], {
    encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  }));
}

function originalResults(cases, parent, sourcePackage = null) {
  return JSON.parse(execFileSync("python3", ["-c", `
import json,sys
sys.path.insert(0,sys.argv[1])
from action_runtime import ActionRuntime
request=json.load(sys.stdin)
runtime=ActionRuntime(sys.argv[2])
if request["sourcePackage"]:
 package=request["sourcePackage"]
 runtime.modules.configure_workspace(package["root"])
 runtime.modules.module_set_import(package["archive"])
 runtime.modules.module_set_load(package["id"],package["version"])
runtime.enabled_platform_actions=lambda: []
# Only availability is supplied by the isolated native host; no original
# execution host, policy, validation or provider authority is transferred.
runtime.modules.availability=lambda action_id: {"state":"blocked","reason":request["reason"]}
results=[]
for arguments in request["cases"]:
 try: results.append({"value":runtime.retrieve(**arguments)})
 except ValueError as error: results.append({"error":str(error)})
print(json.dumps(results))
`, join(repository, "resources"), join(parent, "original")], {
    encoding: "utf8", input: JSON.stringify({ cases, sourcePackage, reason: LEGACY_ACTION_RUNTIME_UNAVAILABLE }),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  }));
}

test("Action retrieval matches the original algorithm and candidate results without runtime authority", async t => {
  const parent = join(root, "tests", `.legacy-action-retrieve-parity-${randomUUID()}`);
  await mkdir(parent);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const data = await initialize(join(parent, "workspace")), storage = await Storage.open(data);
  t.after(() => storage.close());
  const cases = [
    { task: "core", limit: 1 }, { task: "core", limit: 10 },
    { task: "ARTIFACT artifact", limit: 1 }, { task: "bounded delay" },
    { task: "unmatchedzzzz", limit: 1 }, { task: "等待", limit: 1 },
    { task: "\ufeff", limit: 1 }, { task: "\u0085", limit: 1 },
    { task: "\u001c", limit: 1 }, { task: "", limit: 1 },
    { task: "delay", limit: 0 }, { task: "delay", limit: 11 },
  ];
  const expected = originalResults(cases, parent);
  for (const [index, args] of cases.entries()) {
    const request = legacyActionReadRequest.parse({ tool: "action_retrieve", arguments: args });
    if (expected[index].error) {
      await assert.rejects(legacyActionRead(storage, actor, request),
        error => error.code === "INVALID_ARGUMENT" && error.message === expected[index].error);
    } else {
      assert.deepEqual(await legacyActionRead(storage, actor, request), expected[index].value, JSON.stringify(args));
    }
  }
});

test("Action retrieval uses only selected admitted ModuleSets and original punctuation tie ordering", async t => {
  const parent = join(root, "tests", `.legacy-action-retrieve-package-${randomUUID()}`);
  await mkdir(parent);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const data = await initialize(join(parent, "workspace")), storage = await Storage.open(data);
  t.after(() => storage.close());
  const source = join(parent, "source"), archive = join(source, "actions.zip");
  await mkdir(source);
  const ids = ["parity.action_a", "parity.action.a", "parity.action-a"];
  const files = Object.fromEntries(ids.map(action_id => [`definitions/${action_id}.json`, JSON.stringify({
    dependencies: {}, casts: {}, examples: [], ...JSON.parse(original.moduleSetFile),
    action_id, description: "Parity retrieval",
  })]));
  const manifest = { ...structuredClone(portableActionManifest), actions: ids,
    files: Object.fromEntries(Object.entries(files).map(([name, value]) => [
      name, createHash("sha256").update(value).digest("hex"),
    ])) };
  delete manifest.package_hash;
  manifest.package_hash = originalDigest(manifest);
  const bytes = execFileSync("python3", ["-c", `
import io,json,sys,zipfile
request=json.load(sys.stdin)
result=io.BytesIO()
with zipfile.ZipFile(result,"w") as archive:
 archive.writestr("manifest.json",json.dumps(request["manifest"]))
 for name,value in request["files"].items(): archive.writestr(name,value)
sys.stdout.buffer.write(result.getvalue())
`], { input: JSON.stringify({ manifest, files }) });
  await writeFile(archive, bytes);
  const writable = { ...actor, canWrite: true }, workspaceId = await storage.workspaceId();
  const packageSha256 = createHash("sha256").update(bytes).digest("hex");
  await admitLegacyActionPackage(storage, writable, {
    sourceRoot: source, sourcePath: archive, expectedPackageSha256: packageSha256,
    authorityId: "test-action-retrieval",
    authorize: binding => binding.actorId === actor.id && binding.workspaceId === workspaceId
      && binding.sourcePath === archive && binding.packageSha256 === packageSha256,
  });
  await legacyActionCatalog(storage, writable, {
    tool: "action_module_set_import", arguments: { local_path: archive },
  });
  const request = { tool: "action_retrieve", arguments: { task: "parity", limit: 1 } };
  assert.equal((await legacyActionRead(storage, actor, request)).no_match, true);
  const selection = { module_set_id: manifest.module_set_id, version: manifest.version, enabled: true };
  await legacyActionCatalog(storage, writable, { tool: "action_module_set_load", arguments: selection });
  const cases = [{ task: "parity", limit: 1 }, { task: "parity", limit: 10 }];
  const expected = originalResults(cases, parent, {
    root: source, archive, id: manifest.module_set_id, version: manifest.version,
  });
  for (const [index, args] of cases.entries())
    assert.deepEqual(await legacyActionRead(storage, actor, { tool: "action_retrieve", arguments: args }),
      expected[index].value);
  await legacyActionCatalog(storage, writable, {
    tool: "action_module_set_load", arguments: { ...selection, enabled: false },
  });
  assert.equal((await legacyActionRead(storage, actor, request)).no_match, true);
});

test("Action retrieve exposes source-backed candidates but never grants native execution", async t => {
  const parent = join(root, "tests", `.legacy-action-retrieve-${randomUUID()}`);
  await mkdir(parent);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const data = await initialize(join(parent, "workspace")), storage = await Storage.open(data);
  t.after(() => storage.close());
  const result = await legacyActionRead(storage, actor, {
    tool: "action_retrieve", arguments: { task: "bounded delay", limit: 3 },
  });
  assert.equal(result.schema, "pkm.action.retrieval/v1");
  assert.equal(result.ok, true);
  assert.equal(result.no_match, false);
  assert.equal(result.selected_action_id, null);
  assert(result.candidates.some(candidate => candidate.action_id === "core.delay"));
  assert(result.candidates.every(candidate => candidate.availability.state === "blocked"));
  assert(result.candidates.every(candidate => !Object.hasOwn(candidate, "execution_contract")));
  assert.doesNotMatch(JSON.stringify(result), /credential|authorizationDigest|executableDigest/);
  const noMatch = await legacyActionRead(storage, actor, {
    tool: "action_retrieve", arguments: { task: "unmatchedzzzz", limit: 1 },
  });
  assert.deepEqual(noMatch, {
    schema: "pkm.action.retrieval/v1", ok: true, no_match: true, ambiguous: false,
    selected_action_id: null, candidates: [], truncated: false,
  });
  for (const invalid of [
    { task: "", limit: 1 }, { task: " ", limit: 1 }, { task: "delay", limit: 0 },
    { task: "delay", limit: 11 }, { task: "delay", limit: 1.5 }, { task: "delay", limit: 1, execute: true },
  ]) {
    const request = { tool: "action_retrieve", arguments: invalid };
    if (invalid.execute) {
      assert.equal(legacyActionReadRequest.safeParse(request).success, false);
    } else if (Number.isInteger(invalid.limit)) {
      await assert.rejects(legacyActionRead(storage, actor, request), /non-empty task and limit/);
    } else {
      assert.equal(legacyActionReadRequest.safeParse(request).success, false);
    }
  }
  await assert.rejects(legacyActionRead(storage, { ...actor, id: "user:local" }, {
    tool: "action_retrieve", arguments: { task: "delay" },
  }), /fixed external actor/);
});

for (const profile of ["compact", "legacy"]) test(`Action retrieve is read-only in the ${profile} profile`,
  { timeout: 90_000 }, async t => {
    const parent = join(root, "tests", `.legacy-action-retrieve-mcp-${randomUUID()}`);
    await mkdir(parent);
    let client;
    t.after(async () => {
      try { await client?.close(); } finally { await rm(parent, { recursive: true, force: true }); }
    });
    const data = await initialize(join(parent, "workspace")), managed = await legacyManagedFixture(parent);
    client = new Client({ name: "bounded-action-retrieve", version: "1" });
    await client.connect(new StdioClientTransport({ command: "python3",
      args: [join(root, "compat/legacy-compact-mcp.py"), "--data", data, "--node", process.execPath,
        "--managed-generation", managed],
      env: { ...process.env, PKM_CAPABILITY_PROFILE: profile, PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe" }));
    const original = originalContract();
    const described = await client.callTool({ name: "capabilities_describe", arguments: {
      operation: "mcp.tool.action_retrieve",
    } });
    assert.notEqual(described.isError, true, JSON.stringify(described));
    assert.equal(described.structuredContent.readOnly, true);
    for (const key of ["inputSchema", "outputSchema"])
      assert.deepEqual(described.structuredContent[key], original[key]);
    const response = await client.callTool(profile === "legacy"
      ? { name: "action_retrieve", arguments: { task: "delay", limit: 1 } }
      : { name: "capability_read", arguments: {
        operation: "mcp.tool.action_retrieve", version: 1, arguments: { task: "delay", limit: 1 },
      } });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    assert.equal(response.structuredContent.selected_action_id, null);
    assert(response.structuredContent.candidates.every(item => item.availability.state === "blocked"));
    assert.equal((await client.callTool({ name: "capability_call", arguments: {
      operation: "mcp.tool.action_retrieve", version: 1, arguments: { task: "delay" },
    } })).isError, true);
    await closeLegacyManagedFixture(client);
  });
