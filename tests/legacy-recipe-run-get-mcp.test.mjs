import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initialize, Storage } from "../dist/storage.js";
import { startLegacyNoteMcp } from "../dist/legacy-note-mcp.js";
import { planLegacyImport, importLegacyWorkspace } from "../dist/legacy-import.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { legacyManagedFixture, closeLegacyManagedFixture } from "./legacy-managed-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "legacy");
const tool = "recipe_run_get";
const pythonExecutable = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const oracle = `
import asyncio, json, sys
from pathlib import Path
from fastmcp import FastMCP
request = json.load(sys.stdin)
sys.path.insert(0, request["resources"])
import recipe_runtime
mcp = FastMCP("original-recipe-run-get")
recipe_runtime.register_recipe_tools(mcp, request["data"], str(Path(request["data"]) / "subscriptions/cache"))
async def main():
    tools = {tool.name: tool for tool in await mcp.list_tools()}
    tool = tools["recipe_run_get"]
    print(json.dumps({"tool": tool.to_mcp_tool().model_dump(mode="json"),
        "values": [tool.fn(**arguments) for arguments in request["calls"]]}, ensure_ascii=False))
asyncio.run(main())
`;

function runFixture(runId, status = "completed") {
  return {
    schema: "pkm.recipe.run/v1", runId, status, version: 7,
    recipeId: "recipe_original", recipeRevision: 3, executableDigest: "retained-digest",
    definition: { schema: "pkm.workflow.definition/v1", spec: {
      inputs: {}, nodes: [
        { nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] },
        { nodeId: "optional", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] },
      ], outputs: {}, completion: { requiredNodes: ["work"] },
    } },
    nodes: { work: { state: status === "failed" ? "failed" : "succeeded", result: { text: "工作" },
      error: status === "failed" ? "original failure" : "", completedAt: "2026-01-01T00:00:00Z" },
    optional: { state: "skipped", outcome: "not-selected", completedAt: "2026-01-01T00:00:00Z" } },
    loops: { retained: { iteration: 2 } }, healthReceipt: { recorded: true },
    automation: { status }, terminalAt: "2026-01-01T00:00:00Z",
    usage: { measuredTokens: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      estimatedTokens: 10, unknownModelCalls: 1, derivedCosts: { USD: 17 },
      providers: ["provider"], models: ["model"], protocolPayloadEstimate: { estimatedTokens: 9 },
      reportedAttempts: 2, records: [{ attempt: 1 }], recordsTruncated: 3 },
  };
}

async function pin(directory, names) {
  return Promise.all(names.map(async name => {
    const path = join(directory, name), info = await stat(path, { bigint: true });
    return { name, raw: await readFile(path, "utf8"), ino: info.ino,
      mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs };
  }));
}

for (const profile of ["compact", "legacy"]) test(
  `source-backed recipe_run_get through ${profile}, import, restart and relocated backup`,
  { timeout: 120_000 }, async t => {
    const parent = join(root, `.recipe-run-get-${randomUUID()}`);
    await mkdir(parent);
    let client, storage;
    t.after(async () => {
      try { await client?.close(); await storage?.close(); }
      finally { await rm(parent, { recursive: true, force: true }); }
    });
    const source = join(parent, "source"), runs = join(source, ".pkm/state/recipe-runs");
    await mkdir(join(source, "notes"), { recursive: true });
    await writeFile(join(source, "notes/Entry.md"), "---\ntitle: Entry\ndocumentId: recipe-run-note\n---\nBody\n");
    await mkdir(runs, { recursive: true });
    const completed = runFixture("recipe_run_done"), failed = runFixture("recipe_run_failed", "failed");
    const active = { ...completed, runId: "recipe_run_active", status: "running" };
    active.nodes = { ...completed.nodes, work: { state: "running", background: {
      state: "running", resultPath: join(parent, "unadmitted-command-result.json"),
    }, childRunId: "recipe_run_unadmitted" } };
    active.definition = { spec: { ...completed.definition.spec,
      nodes: [{ ...completed.definition.spec.nodes[0], kind: "pkm.step.command/v1" },
        completed.definition.spec.nodes[1]] } };
    const unfinalized = { ...completed, runId: "recipe_run_unfinalized", healthReceipt: null };
    const mismatched = { ...completed, runId: "recipe_run_other" };
    const inconsistent = runFixture("recipe_run_inconsistent");
    inconsistent.nodes.work.state = "failed";
    const fixtures = {
      recipe_run_done: completed, recipe_run_failed: failed, recipe_run_active: active,
      recipe_run_unfinalized: unfinalized, recipe_run_mismatch: mismatched,
      recipe_run_inconsistent: inconsistent, recipe_run_bad_schema: { schema: "unknown" },
    };
    for (const [id, value] of Object.entries(fixtures))
      await writeFile(join(runs, `${id}.json`), JSON.stringify(value));
    await writeFile(join(runs, "recipe_run_corrupt.json"), "{bad");
    await writeFile(join(parent, "unadmitted-command-result.json"), '{"ok":true,"secret":"not admitted"}');
    const calls = [
      { run_id: completed.runId }, { run_id: completed.runId, detail: "compact" },
      { run_id: completed.runId, detail: " FULL " }, { run_id: completed.runId, detail: "" },
      { run_id: failed.runId }, { run_id: failed.runId, detail: "compact" },
      { run_id: "recipe_run_unknown" }, { run_id: "../recipe_run_done" },
      { run_id: "recipe_run_done/../../secret" }, { run_id: "not-a-run" },
      { run_id: completed.runId, detail: "verbose" },
      { run_id: "recipe_run_bad_schema" }, { run_id: "recipe_run_corrupt" },
    ];
    const filenames = (Object.keys(fixtures).concat("recipe_run_corrupt")).map(id => `${id}.json`);
    const before = await pin(runs, filenames);
    const original = JSON.parse(execFileSync(pythonExecutable, ["-c", oracle], {
      input: JSON.stringify({ resources: join(repository, "resources"), data: source, calls }),
      encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    }));
    assert.equal(original.values[0].ok, true);
    assert.equal(original.values[0].status, "completed");
    assert.equal(original.values[4].status, "failed");
    assert.equal(original.values[1].usage, undefined);
    assert.equal(original.values[1].recipe, undefined);
    assert.deepEqual(await pin(runs, filenames), before, "source oracle must not change retained runs");
    const plan = await planLegacyImport(source);
    assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
    const imported = join(parent, "native"), relocated = join(parent, "relocated");
    await importLegacyWorkspace(plan, imported, { pythonExecutable });
    // The adapter must work without the original source or command result paths.
    await rm(source, { recursive: true });
    await rm(join(parent, "unadmitted-command-result.json"));
    for (const phase of ["imported", "restarted", "relocated"]) {
      const current = phase === "relocated" ? relocated : imported;
      const admitted = join(current, "recipe-usage-reads/.pkm/state/recipe-runs");
      const admittedBefore = await pin(admitted, filenames);
      client = new Client({ name: `recipe-run-${profile}-${phase}`, version: "0.1.0" });
      await client.connect(new StdioClientTransport({ command: pythonExecutable, args: [
        join(root, "compat/legacy-compact-mcp.py"), "--data", current, "--node", process.execPath,
        "--managed-generation", await legacyManagedFixture(parent),
      ], env: { ...process.env, PKM_CAPABILITY_PROFILE: profile, PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe" }));
      const schema = profile === "legacy" ? (await client.listTools()).tools.find(value => value.name === tool)
        : (await client.callTool({ name: "capabilities_describe",
          arguments: { operation: `mcp.tool.${tool}` } })).structuredContent;
      assert.deepEqual(schema.inputSchema, original.tool.inputSchema);
      assert.deepEqual(schema.outputSchema ?? null, original.tool.outputSchema ?? null);
      assert.equal(profile === "legacy" ? schema.annotations.readOnlyHint : schema.readOnly, true);
      async function invoke(arguments_) {
        const result = await client.callTool(profile === "legacy" ? { name: tool, arguments: arguments_ }
          : { name: "capability_read", arguments: { operation: `mcp.tool.${tool}`, version: 1, arguments: arguments_ } });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        return result.structuredContent ?? JSON.parse(result.content[0].text);
      }
      for (const [index, arguments_] of calls.entries())
        assert.deepEqual(await invoke(arguments_), original.values[index]);
      for (const id of ["active", "unfinalized", "mismatch", "inconsistent"]) {
        for (const detail of ["compact", "full"]) {
          const value = await invoke({ run_id: `recipe_run_${id}`, detail });
          assert.equal(value.ok, false);
          assert.equal(value.error.code, "recipe-run-get-failed");
          assert.match(value.error.message, /BLOCKED:/);
          assert.equal(value.current_result, undefined);
          assert.equal(value.next_action, undefined);
        }
      }
      await closeLegacyManagedFixture(client);
      client = undefined;
      assert.deepEqual(await pin(admitted, filenames), admittedBefore, "inspection must not mutate native runs");
      if (phase === "restarted") {
        storage = await Storage.open(imported);
        await createWorkspaceBackup(storage, join(parent, "backup"), {
          acquireQuiescence: async () => ({ assertHeld() {}, release() {} }),
        });
        await storage.close();
        storage = undefined;
        await restoreWorkspaceBackup(join(parent, "backup"), relocated, { nativeRestoreAuthority, pythonExecutable });
        await rm(imported, { recursive: true });
      }
    }
  });

for (const change of ["content", "membership", "lease"]) test(`recipe_run_get refuses stale ${change}`, async t => {
  const parent = join(root, `.recipe-run-get-race-${randomUUID()}`);
  await mkdir(parent);
  let client, server;
  t.after(async () => {
    try { await client?.close(); await server?.close(); }
    finally { await rm(parent, { recursive: true, force: true }); }
  });
  const data = await initialize(join(parent, "native"));
  const runs = join(data, "recipe-usage-reads/.pkm/state/recipe-runs");
  await mkdir(runs, { recursive: true });
  const run = runFixture("recipe_run_done");
  await writeFile(join(runs, "recipe_run_done.json"), JSON.stringify(run));
  let checks = 0;
  const storage = {
    workspaceRoot: () => data, withWorkspaceExclusive: work => work(),
    assertWorkspaceLease() {
      if (++checks !== 2) return;
      if (change === "lease") throw new Error("STORAGE_UNAVAILABLE: Test lease fenced.");
      writeFileSync(join(runs, change === "content" ? "recipe_run_done.json" : "recipe_run_other.json"),
        JSON.stringify({ ...run, version: 8 }));
    },
  };
  const [a, b] = InMemoryTransport.createLinkedPair();
  server = await startLegacyNoteMcp(storage, b, {
    core: {}, actor: { id: "mcp:external", canRead: true, canWrite: false },
  });
  client = new Client({ name: "recipe-run-race", version: "0.1.0" });
  await client.connect(a);
  const result = await client.callTool({ name: "legacy_knowledge_read",
    arguments: { tool, arguments: { run_id: run.runId } } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.match(result.content[0].text, change === "lease" ? /lease fenced/ : /CONFLICT: Knowledge changed/);
});
