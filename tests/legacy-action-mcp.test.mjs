import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Storage, initialize } from "../dist/storage.js";
import { legacyActionRead, legacyActionReadRequest, legacyActionWrite } from "../dist/legacy-action-mcp.js";
import {
  LEGACY_ACTION_RUNTIME_UNAVAILABLE, admitLegacyActionPackage,
} from "../dist/legacy-action-catalog.js";
import { portableActionArchive, portableActionManifest } from "./legacy-action-catalog-fixture.mjs";
import { createHash } from "node:crypto";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { legacyManagedFixture, closeLegacyManagedFixture } from "./legacy-managed-fixture.mjs";
import { componentDigest } from "../dist/domain/action-compiler-validation.js";
import { ORIGINAL_ACTION_COMPILER_CAPTURE } from "../dist/domain/action-compiler-original.js";
import { ACTION_SOURCE_IDENTITY } from "../dist/domain/action-source-identity.js";
import { originalActionCompilerFixtures as original } from "./action-compiler-original-fixtures.mjs";
import { originalActionFixture } from "./legacy-action-original-fixture.mjs";

const root = resolve(import.meta.dirname, "..");
const actor = { id: "mcp:external", canWrite: true };
const graph = {
  action_id: "example.original.graph", version: 1, name: "Original graph",
  nodes: [{ id: "value", action_id: "core.constant", value_type: "string",
    content_hash: componentDigest(ORIGINAL_ACTION_COMPILER_CAPTURE.componentDefinitions["core.constant"]),
    parameters: { value: "No effects" } }],
};
const tools = ["action_definition_check", "action_graph_check", "action_templates", "action_template_create",
  "action_register", "action_proposals", "action_graph_save",
  "action_module_sets", "action_module_set_import", "action_module_set_load", "action_module_set_remove"];
// Only explicit frozen-v2 fixtures advertise automatic admission; this projection remains pending-only.
const pendingOnlyDescriptions = {
  action_template_create: "Submit a template-based Action proposal for operator admission. Never registers or grants execution; wait for human approval before qualification.",
  action_register: "Submit a versioned Action proposal, not a formal library registration. Return pending_operator_approval; ask the operator to approve it in Action Library and wait. The previous approved version is unchanged. No validation, invocation or automatic retry before approval.",
  action_graph_save: "Submit a graphical composition proposal. It is not callable until operator admission and qualification.",
};
const oracle = (directory, operation, args = {}) => originalActionFixture(dirname(directory)).json(`
import ast,json,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from action_modules import ModuleRuntime
request=json.load(sys.stdin)
if request["operation"] not in {"contracts","definition_check","templates","graph_definition","definition","template_create","proposal_list","register","graph_save","configure_workspace","module_set_import","module_set_load"}:
 raise ValueError("Operation outside original Action fixture scope")
runtime=ModuleRuntime(sys.argv[2],proposal_mode=True)
if request["operation"]=="contracts":
 from fastmcp import FastMCP
 import asyncio
 mcp=FastMCP("independent-original-action")
 tree=ast.parse((Path(sys.argv[1])/"action_runtime.py").read_text())
 names=set(request["arguments"]["tools"])
 for node in ast.walk(tree):
  if isinstance(node,ast.FunctionDef) and node.name in names:
   exec(compile(ast.Module(body=[node],type_ignores=[]),"<actual-original-action>","exec"))
   f=locals()[node.name]
   f.__annotations__["return"]=dict
   mcp.tool()(f)
 async def contracts():
  print(json.dumps({t.name:t.to_mcp_tool().model_dump(mode="json") for t in await mcp.list_tools()}))
 asyncio.run(contracts())
else:
 result=getattr(runtime,request["operation"])(**request["arguments"])
 print(json.dumps(result))
`, [directory], JSON.stringify({ operation, arguments: args }));

async function fixture(t) {
  const parent = join(root, "tests", `.legacy-action-${randomUUID()}`);
  await mkdir(join(parent, "oracle"), { recursive: true });
  const data = await initialize(join(parent, "workspace"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, data, oracle: join(parent, "oracle") };
}
const normalizedProposal = record => ({ ...record, proposal_id: "<generated>", submitted_at: "<generated>" });
function assertPendingResponseCompatibility(actual, expected) {
  const originalGuidance = "The trusted PKM Extension Host prepares this revision automatically in the background. Wait for Action readiness; no manual Validate or model selection is required. If blocked, inspect preparation details. Do not self-grant or retry registration.";
  const nativeGuidance = "The trusted VS Code Extension Host may automatically admit this exact revision. GPT review is optional; inputs, host authorization, and effect consent remain required. Without active workspace trust the proposal remains pending and is not callable.";
  assert.equal(expected.next_action, originalGuidance);
  assert.equal(actual.next_action, nativeGuidance);
  for (const response of [actual, expected]) {
    assert.equal(response.state, "pending_operator_approval");
    assert.equal(response.next_owner, "background");
    assert.equal(response.registered, false);
    assert.equal(response.callable, false);
  }
  // Only the documented host-policy guidance differs; preserve every other field.
  assert.deepEqual({ ...actual, proposal_id: "<generated>", next_action: originalGuidance },
    { ...expected, proposal_id: "<generated>" });
}

test("original action_run_get reads only a redacted native owner-scoped status projection", async () => {
  const calls = [];
  const result = await legacyActionRead(undefined, actor, {
    tool: "action_run_get", arguments: { run_id: "action_run_0123456789abcdef0123456789abcdef" },
  }, async (operation, args) => {
    calls.push({ operation, args });
    return {
      schema: "pkm.action.runtime.run/v1", runId: args.runId, version: 3, state: "running",
      actionId: "example.status", actionVersion: 2, definitionDigest: "a".repeat(64),
      source: { definition: { inputs: { credential: "secret" }, command_args: ["secret"] } },
      deadline: 1234, nodes: [{ nodeId: "status", state: "running" }],
      execution: "native-action-plan",
    };
  });
  assert.deepEqual(calls, [{
    operation: "action.runtime.get", args: { runId: "action_run_0123456789abcdef0123456789abcdef" },
  }]);
  assert.deepEqual(result, {
    run_id: "action_run_0123456789abcdef0123456789abcdef", state: "running",
    action_id: "example.status", action_version: 2, version: 3, definition_digest: "a".repeat(64),
    deadline: 1234, nodes: [{ node_id: "status", state: "running" }],
  });
  assert.doesNotMatch(JSON.stringify(result), /secret|source|execution/i);
  assert.equal(legacyActionReadRequest.safeParse({
    tool: "action_run_get", arguments: { run_id: "action_run_0123456789abcdef0123456789abcdef", unexpected: true },
  }).success, false);
  assert.equal(legacyActionReadRequest.safeParse({ tool: "action_run_events", arguments: { run_id: "run" } }).success, false);
  assert.equal(legacyActionReadRequest.safeParse({ tool: "action_run_checkpoints", arguments: { run_id: "run" } }).success, false);
  await assert.rejects(legacyActionRead(undefined, actor, {
    tool: "action_run_get", arguments: { run_id: "action_run_0123456789abcdef0123456789abcdef" },
  }), /Native Action runtime reads are unavailable/);
  let called = false;
  await assert.rejects(legacyActionRead(undefined, { ...actor, id: "user:local" }, {
    tool: "action_run_get", arguments: { run_id: "action_run_0123456789abcdef0123456789abcdef" },
  }, async () => { called = true; return {}; }), /fixed external actor/);
  assert.equal(called, false);
});

test("original Action tool signatures and native metadata captures remain source exact", () => {
  const scripts = ACTION_SOURCE_IDENTITY.identity === "frozen-original-v2"
    ? ["check-action-source-v2.mjs"] : ["capture-legacy-action-mcp.mjs", "capture-legacy-knowledge-mcp.mjs"];
  for (const script of scripts)
    execFileSync(process.execPath, [join(root, "scripts", script), "--check"], { stdio: ["ignore", "pipe", "pipe"] });
});

test("original Action diagnostic and graph raw results match the actual original ModuleRuntime without host effects", async t => {
  const f = await fixture(t), storage = await Storage.open(f.data);
  try {
    for (const definition of [original.example, ...original.diagnostics.map(item => item.definition)]) {
      assert.deepEqual(await legacyActionRead(storage, actor, {
        tool: "action_definition_check", arguments: { definition },
      }), oracle(f.oracle, "definition_check", { definition }));
    }
    assert.deepEqual(await legacyActionRead(storage, actor, { tool: "action_templates", arguments: {} }),
      oracle(f.oracle, "templates"));
    assert.deepEqual(await legacyActionRead(storage, actor, { tool: "action_graph_check", arguments: { graph } }),
      oracle(f.oracle, "graph_definition", { graph }));
    for (const invalid of [{ ...graph, nodes: [] },
      { ...graph, nodes: [{ ...graph.nodes[0], content_hash: "0".repeat(64) }] }])
      await assert.rejects(legacyActionRead(storage, actor, { tool: "action_graph_check", arguments: { graph: invalid } }));
    await assert.rejects(legacyActionRead(storage, { ...actor, id: "user:local" },
      { tool: "action_templates", arguments: {} }), /fixed external actor/);
  } finally { await storage.close(); }
});

test("original poll template creates the exact pinned pending proposal without execution authority", async t => {
  const f = await fixture(t), storage = await Storage.open(f.data);
  try {
    const query = oracle(f.oracle, "definition", { action_id: "core.delay" });
    const parameters = { query_action_id: query.action_id, query_revision: query.content_hash, query_inputs: { seconds: 1 },
      field: "seconds", expected: 1, interval_seconds: 1, timeout_seconds: 60, max_iterations: 10 };
    const args = { action_id: "example.poll", parameters };
    const expected = oracle(f.oracle, "template_create", args);
    const actual = await legacyActionWrite(storage, actor, { tool: "action_template_create", arguments: args });
    assertPendingResponseCompatibility(actual, expected);
    const actualRows = await legacyActionRead(storage, actor, { tool: "action_proposals", arguments: {} });
    const expectedRows = oracle(f.oracle, "proposal_list");
    assert.deepEqual(actualRows.proposals.map(normalizedProposal), expectedRows.proposals.map(normalizedProposal));
    assert.deepEqual(await legacyActionWrite(storage, actor, { tool: "action_template_create", arguments: args }), actual);
    for (const changed of [{ query_revision: "0".repeat(64) }, { field: "missing" },
      { query_inputs: { seconds: 301 } }, { interval_seconds: 0 }, { unexpected: true }]) {
      await assert.rejects(legacyActionWrite(storage, actor, {
        tool: "action_template_create", arguments: { ...args, parameters: { ...parameters, ...changed } },
      }));
    }
    await assert.rejects(legacyActionWrite(storage, actor, { tool: "action_template_create",
      arguments: { action_id: "example.azure", parameters: { template_id: "azuredevops-pipeline-status" } } }), /host-specific/);
    await assert.rejects(legacyActionWrite(storage, { ...actor, canWrite: false },
      { tool: "action_template_create", arguments: args }), /write permission/);
  } finally { await storage.close(); }
});

test("original Action proposal receipts deduplicate without registration, approval, runtime grants or filesystem effects", async t => {
  const f = await fixture(t), storage = await Storage.open(f.data);
  try {
    const request = { tool: "action_register", arguments: { definition: original.example } };
    const expected = oracle(f.oracle, "register", request.arguments);
    const actual = await legacyActionWrite(storage, actor, request);
    assertPendingResponseCompatibility(actual, expected);
    assert.equal(actual.registered, false);
    assert.equal(actual.callable, false);
    assert.deepEqual(await legacyActionWrite(storage, actor, request), actual);
    const nativeRecords = await legacyActionRead(storage, actor, { tool: "action_proposals", arguments: {} });
    const originalRecords = oracle(f.oracle, "proposal_list");
    assert.deepEqual(nativeRecords.proposals.map(normalizedProposal), originalRecords.proposals.map(normalizedProposal));
    const saved = await legacyActionWrite(storage, actor, { tool: "action_graph_save", arguments: { graph } });
    const graphExpected = oracle(f.oracle, "graph_save", { graph });
    assertPendingResponseCompatibility(saved, graphExpected);
    await assert.rejects(legacyActionWrite(storage, { ...actor, canWrite: false }, request), /write permission/);
    await assert.rejects(legacyActionWrite(storage, { ...actor, boardWorker: { boardId: "spoof" } }, request), /fixed external actor/);
    for (const extra of [{ actorId: "user:local" }, { approved: true }, { operationId: randomUUID() }])
      await assert.rejects(legacyActionWrite(storage, actor, { ...request, arguments: { ...request.arguments, ...extra } }));
    await assert.rejects(legacyActionWrite(storage, actor, {
      ...request, arguments: { definition: { ...original.example, knowledgeId: "forged" } },
    }));
    const db = storage.connectNative();
    try {
      assert.throws(() => db.prepare("DELETE FROM legacy_action_mcp_proposals").run(), /immutable/);
      assert.equal(db.prepare("SELECT count(*) AS count FROM legacy_action_mcp_proposals").get().count, 2);
    } finally { db.close(); }
    await assert.rejects(readFile(join(f.data, "actions", `${original.example.action_id}.json`)), { code: "ENOENT" });
    await assert.rejects(readFile(join(f.data, ".pkm/state/actions/settings.json")), { code: "ENOENT" });
  } finally { await storage.close(); }
});

for (const profile of ["compact", "legacy"])
test(`original Action MCP contracts and pending-only proposal state survive restart/relocated backup (${profile})`,
  { timeout: 90_000 }, async t => {
    const f = await fixture(t), contracts = oracle(f.oracle, "contracts", { tools });
    const managed = await legacyManagedFixture(f.parent);
    let client;
    t.after(async () => { await client?.close(); });
    const connect = async (target, writable = true) => {
      client = new Client({ name: "original-action-client", version: "1" });
      await client.connect(new StdioClientTransport({ command: "python3",
        args: [join(root, "compat/legacy-compact-mcp.py"), "--data", target, "--node", process.execPath,
          "--managed-generation", managed, ...(writable ? ["--allow-writes"] : [])],
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
    await connect(f.data);
    const listed = await client.listTools();
    const runGet = listed.tools.find(tool => tool.name === "action_run_get");
    const describedRunGet = await client.callTool({ name: "capabilities_describe", arguments: {
      operation: "mcp.tool.action_run_get",
    } });
    assert.notEqual(describedRunGet.isError, true, JSON.stringify(describedRunGet));
    const runContract = describedRunGet.structuredContent;
    assert.equal(runContract.readOnly, true);
    assert.deepEqual(runContract.inputSchema.required, ["run_id"]);
    assert.equal(runContract.inputSchema.properties.run_id.type, "string");
    if (profile === "legacy") {
      assert.ok(runGet, "legacy profile must expose action_run_get directly");
      assert.equal(runGet.annotations?.readOnlyHint, true);
    } else {
      assert.equal(runGet, undefined, "compact profile exposes leaves through discovery and capability_read");
    }
    const missingRun = profile === "legacy"
      ? await client.callTool({ name: "action_run_get", arguments: {
        run_id: "action_run_0123456789abcdef0123456789abcdef",
      } })
      : await client.callTool({ name: "capability_read", arguments: {
        operation: "mcp.tool.action_run_get", version: 1,
        arguments: { run_id: "action_run_0123456789abcdef0123456789abcdef" },
      } });
    assert.equal(missingRun.isError, true, JSON.stringify(missingRun));
    const missingText = missingRun.content.map(item => item.text ?? "").join("\n");
    assert.match(missingText, /NOT_FOUND|NOT_AVAILABLE|Owned Action run not found|Native Action runtime reads are unavailable|unavailable through this transport/);
    assert.doesNotMatch(missingText, /outputs|credentials|command arguments|step output/i);
    for (const [name, contract] of Object.entries(contracts)) {
      const described = await client.callTool({ name: "capabilities_describe", arguments: { operation: `mcp.tool.${name}` } });
      assert.notEqual(described.isError, true, JSON.stringify(described));
      assert.deepEqual(described.structuredContent.inputSchema, contract.inputSchema, name);
      assert.deepEqual(described.structuredContent.outputSchema, contract.outputSchema ?? null, name);
      assert.equal(described.structuredContent.description, ACTION_SOURCE_IDENTITY.identity === "frozen-original-v2"
        ? pendingOnlyDescriptions[name] ?? contract.description : contract.description, name);
    }
    assert.deepEqual(await invoke("action_templates", {}), oracle(f.oracle, "templates"));
    assert.deepEqual(await invoke("action_graph_check", { graph }), oracle(f.oracle, "graph_definition", { graph }));
    const query = oracle(f.oracle, "definition", { action_id: "core.delay" });
    const templateArgs = { action_id: "example.poll", parameters: {
      query_action_id: query.action_id, query_revision: query.content_hash, query_inputs: { seconds: 1 },
      field: "seconds", expected: 1, interval_seconds: 1, timeout_seconds: 60, max_iterations: 10,
    } };
    const template = await invoke("action_template_create", templateArgs, true);
    assert.equal(template.registered, false);
    const registered = await invoke("action_register", { definition: original.example }, true);
    assert.equal(registered.registered, false);
    assert((await invoke("action_proposals", {})).proposals.some(row => row.proposal_id === registered.proposal_id));
    await closeLegacyManagedFixture(client);
    await connect(f.data, false);
    assert((await invoke("action_proposals", {})).proposals.some(row => row.content_hash === registered.content_hash));
    const denied = await client.callTool({ name: "capabilities_describe", arguments: { operation: "mcp.tool.action_register" } });
    assert.equal(denied.isError, true);
    await closeLegacyManagedFixture(client);
    const storage = await Storage.open(f.data), native = await createNativeRuntime({ storage });
    const backup = join(f.parent, "backup"), relocated = join(f.parent, "relocated");
    try { await createWorkspaceBackup(storage, backup, { acquireQuiescence: native.acquireWorkspaceQuiescence }); }
    finally { await native.close(); await storage.close(); }
    await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority });
    await connect(relocated);
    assert((await invoke("action_proposals", {})).proposals.some(row => row.proposal_id === registered.proposal_id));
    assert.deepEqual(await invoke("action_template_create", templateArgs, true), template);
    assert.deepEqual(await invoke("action_register", { definition: original.example }, true), registered);
    await closeLegacyManagedFixture(client);
  });

for (const profile of ["compact", "legacy"])
test(`original ModuleSet MCP consumers require exact native host admission, use loaded graphs and survive source-free relocation (${profile})`,
      { timeout: 90_000 }, async t => {
        const f = await fixture(t), sourceRoot = join(f.parent, "approved-source"), sourcePath = join(sourceRoot, "reviewed.zip");
        await mkdir(sourceRoot);
        const bytes = portableActionArchive(), packageSha256 = createHash("sha256").update(bytes).digest("hex");
        await writeFile(sourcePath, bytes);
        const storage = await Storage.open(f.data), workspaceId = await storage.workspaceId(), stat = await lstat(f.data);
        try { await admitLegacyActionPackage(storage, actor, {
          sourceRoot, sourcePath, expectedPackageSha256: packageSha256, authorityId: "test-native-fixed-source",
          authorize: binding => binding.actorId === actor.id && binding.workspaceId === workspaceId
            && binding.workspaceRoot === f.data && binding.workspaceRootPin === `${stat.dev}:${stat.ino}`
            && binding.sourceRoot === sourceRoot && binding.sourcePath === sourcePath
            && binding.packageSha256 === packageSha256 && binding.authorityId === "test-native-fixed-source",
        }); } finally { await storage.close(); }
        oracle(f.oracle, "configure_workspace", { directory: sourceRoot });
        const managed = await legacyManagedFixture(f.parent);
        let client;
        t.after(async () => { await client?.close(); });
        const connect = async target => {
          client = new Client({ name: "original-admitted-package-client", version: "1" });
          await client.connect(new StdioClientTransport({ command: "python3",
            args: [join(root, "compat/legacy-compact-mcp.py"), "--data", target, "--node", process.execPath,
              "--managed-generation", managed, "--allow-writes"],
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
        await connect(f.data);
        const denied = await client.callTool({ name: "capability_call", arguments: {
          operation: "mcp.tool.action_module_set_import", version: 1, arguments: { local_path: join(sourceRoot, "unadmitted.zip") },
        } });
        assert.equal(denied.isError, true);
        assert.deepEqual(await invoke("action_module_set_import", { local_path: sourcePath }, true),
          oracle(f.oracle, "module_set_import", { local_path: sourcePath }));
        const args = { module_set_id: portableActionManifest.module_set_id, version: portableActionManifest.version };
        const loaded = await invoke("action_module_set_load", args, true);
        const expectedLoad = oracle(f.oracle, "module_set_load", args);
        for (const actionId of Object.keys(expectedLoad.readiness)) {
          expectedLoad.readiness[actionId].reason = LEGACY_ACTION_RUNTIME_UNAVAILABLE;
        }
        assert.deepEqual(loaded, expectedLoad);
        const installed = oracle(f.oracle, "definition", { action_id: original.example.action_id });
        const loadedGraph = {
          action_id: "example.loaded.graph", name: "Loaded graph",
          nodes: [{ id: "packaged", action_id: installed.action_id, content_hash: installed.content_hash,
            parameters: { value: "Only host-admitted package data" } }],
        };
        const checkNested = async () => {
          const checkedGraph = await client.callTool({ name: "capability_read", arguments: {
            operation: "mcp.tool.action_graph_check", version: 1, arguments: { graph: loadedGraph },
          } });
          assert.notEqual(checkedGraph.isError, true);
          assert.equal(checkedGraph.structuredContent.dependencies[installed.action_id], installed.content_hash);
        };
        await checkNested();
        assert.throws(() => oracle(f.oracle, "graph_definition", { graph: loadedGraph }), /Nested Action must have completed validation/,
          "the next-server authoring projection intentionally permits statically pinned dependencies before qualification");
        const definition = { ...original.example, action_id: "example.loaded.pending",
          dependencies: { [installed.action_id]: installed.content_hash } };
        assert.deepEqual(await invoke("action_definition_check", { definition }), oracle(f.oracle, "definition_check", { definition }));
        const saved = await invoke("action_register", { definition }, true);
        const originalSaved = oracle(f.oracle, "register", { definition });
        assertPendingResponseCompatibility(saved, originalSaved);
        assert.equal(saved.callable, false);
        const before = await invoke("action_module_sets", {});
        await closeLegacyManagedFixture(client);
        await rm(sourceRoot, { recursive: true });
        const reopened = await Storage.open(f.data), native = await createNativeRuntime({ storage: reopened });
        const backup = join(f.parent, "backup"), relocated = join(f.parent, "relocated");
        try { await createWorkspaceBackup(reopened, backup, { acquireQuiescence: native.acquireWorkspaceQuiescence }); }
        finally { await native.close(); await reopened.close(); }
        await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority });
        await connect(relocated);
        assert.deepEqual(await invoke("action_module_sets", {}), before);
        await checkNested();
        assert.deepEqual(await invoke("action_definition_check", { definition }), oracle(f.oracle, "definition_check", { definition }));
        assert.equal((await invoke("action_proposals", {})).proposals[0].proposal_id, saved.proposal_id);
        await invoke("action_module_set_load", { ...args, enabled: false }, true);
        assert.equal((await invoke("action_module_sets", {})).module_sets[0].enabled, false);
        await invoke("action_module_set_remove", args, true);
        assert.deepEqual(await invoke("action_module_sets", {}), { ok: true, module_sets: [] });
        await closeLegacyManagedFixture(client);
      });
