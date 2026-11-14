import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, cp, symlink, utimes, readFile, stat } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initialize, validateWorkspace, Storage } from "../dist/storage.js";
import { startLegacyNoteMcp } from "../dist/legacy-note-mcp.js";
import { planLegacyImport, importLegacyWorkspace } from "../dist/legacy-import.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { compileWorkflowDefinitionV1 } from "../dist/domain/project-recipes-workflow-contracts.js";
import { safeRecipeFileName } from "../dist/domain/project-recipes-storage-rules.js";
import { legacyManagedFixture, closeLegacyManagedFixture } from "./legacy-managed-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "legacy");
const names = ["recipe_search", "recipe_usage_summary"];
const oracle = `
import asyncio, json, sys, subprocess
from pathlib import Path
from fastmcp import FastMCP
request = json.load(sys.stdin)
sys.path.insert(0, request["resources"])
import recipe_runtime
def compile_original(definition):
    result = subprocess.run(["node", str(Path(request["resources"]) / "recipe_compiler_bridge.js"), request["contracts"]],
      input=json.dumps(definition), text=True, capture_output=True, check=True)
    return json.loads(result.stdout)
recipe_runtime._compile_definition = compile_original
mcp = FastMCP("original-recipe-reads")
recipe_runtime.register_recipe_tools(mcp, request["data"], str(Path(request["data"]) / "subscriptions" / "cache"))
async def main():
    tools = {tool.name: tool for tool in await mcp.list_tools()}
    print(json.dumps({"tools": {name: tools[name].to_mcp_tool().model_dump(mode="json") for name in request["names"]},
      "values": [tools[call["tool"]].fn(**call["arguments"]) for call in request["calls"]]}, ensure_ascii=False))
asyncio.run(main())
`;

test("isolated usage staging does not admit a legacy .pkm root or linked stage", async t => {
  const parent = await mkdtemp(join(tmpdir(), "pkm-recipe-stage-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const data = await initialize(join(parent, "workspace"));
  await mkdir(join(data, "recipe-usage-reads"));
  assert.equal(await validateWorkspace(data), data);
  await mkdir(join(data, ".pkm"));
  await assert.rejects(validateWorkspace(data), /Legacy data directories must not be used/);
  await rm(join(data, ".pkm"), { recursive: true });
  await rm(join(data, "recipe-usage-reads"), { recursive: true });
  await symlink(parent, join(data, "recipe-usage-reads"));
  await assert.rejects(validateWorkspace(data), /regular files or knowledge\/boards directories/);
});

for (const databaseState of ["absent", "native", "forged-schema25"]) test(`original privacy files do not admit an unowned .pkm root (${databaseState})`, async t => {
  const parent = await mkdtemp(join(tmpdir(), "pkm-recipe-privacy-root-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const data = await initialize(join(parent, "workspace"));
  if (databaseState !== "absent") {
    const storage = await Storage.open(data);
    await storage.close();
    if (databaseState === "forged-schema25") {
      const database = new DatabaseSync(join(data, "core.sqlite"));
      try { database.exec("PRAGMA user_version=25"); } finally { database.close(); }
    }
  }
  await mkdir(join(data, ".pkm"));
  await writeFile(join(data, ".pkm", "content-privacy.json"), "{}");
  await assert.rejects(validateWorkspace(data), /Legacy data directories must not be used/);
  await assert.rejects(Storage.open(data), /Legacy data directories must not be used/);
});

for (const change of ["content", "membership", "lease"]) test(`Recipe usage refuses stale ${change}`, async t => {
  const parent = await mkdtemp(join(tmpdir(), "pkm-recipe-usage-race-"));
  let client, server;
  t.after(async () => { try { await client?.close(); await server?.close(); }
    finally { await rm(parent, { recursive: true, force: true }); } });
  const data = await initialize(join(parent, "workspace"));
  const runs = join(data, "recipe-usage-reads", ".pkm", "state", "recipe-runs");
  await mkdir(runs, { recursive: true });
  const run = { schema: "pkm.recipe.run/v1", recipeId: "recipe_original", recipeRevision: 1, nodes: {}, status: "running" };
  await writeFile(join(runs, "recipe_run_one.json"), JSON.stringify(run));
  let checks = 0;
  const storage = {
    workspaceRoot: () => data, withWorkspaceExclusive: work => work(),
    assertWorkspaceLease() {
      if (++checks !== 2) return;
      if (change === "lease") throw new Error("STORAGE_UNAVAILABLE: Test lease fenced.");
      writeFileSync(join(runs, change === "content" ? "recipe_run_one.json" : "recipe_run_two.json"),
        JSON.stringify({ ...run, status: "failed" }));
    },
  };
  const [a, b] = InMemoryTransport.createLinkedPair();
  server = await startLegacyNoteMcp(storage, b, {
    core: {}, actor: { id: "mcp:external", canRead: true, canWrite: false },
  });
  client = new Client({ name: "recipe-usage-race", version: "0.1.0" });
  await client.connect(a);
  const result = await client.callTool({ name: "legacy_knowledge_read",
    arguments: { tool: "recipe_usage_summary", arguments: {} } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.match(result.content[0].text, change === "lease" ? /lease fenced/ : /CONFLICT: Knowledge changed/);
});

for (const profile of ["compact", "legacy"]) test(`original Recipe search and usage parity through ${profile}, drain and restart`, { timeout: 60_000 }, async t => {
  const parent = await mkdtemp(join(tmpdir(), "pkm-recipe-reads-"));
  let client;
  t.after(async () => { try { await client?.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
  const data = await initialize(join(parent, "workspace"));
  const managed = await legacyManagedFixture(parent);
  const definition = { schema: "pkm.workflow.definition/v1", spec: {
    inputs: {}, nodes: [{ nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
    outputs: {}, completion: { requiredNodes: ["work"] },
  } };
  const compiled = compileWorkflowDefinitionV1(definition);
  assert.equal(compiled.ok, true);
  const recipe = { schema: "pkm.knowledge/v1", recipeId: "recipe_global",
    knowledgeId: "knowledge_" + createHash("sha256").update("global").digest("hex").slice(0, 24),
    aliases: ["recipe:recipe_global"], scope: "global", name: "Global reusable 工作", description: "automation",
    category: "", definition, executableDigest: compiled.executableDigest, revision: 1 };
  await mkdir(join(data, "recipes", "Uncategorized"), { recursive: true });
  await writeFile(join(data, "recipes", "Uncategorized", safeRecipeFileName(recipe.name, recipe.recipeId)), JSON.stringify(recipe));
  const project = { ...recipe, category: "Automation", recipeId: "recipe_project",
    name: "Project automation", knowledgeId: "knowledge_" + "b".repeat(24), aliases: ["recipe:recipe_project"] };
  await mkdir(join(data, "recipes", "Automation"));
  await writeFile(join(data, "recipes", "Automation", safeRecipeFileName(project.name, project.recipeId)), JSON.stringify(project));
  const cache = join(data, "subscriptions", "cache", "node", "share");
  await mkdir(join(cache, "content", "recipes"), { recursive: true });
  await writeFile(join(cache, "_subscription.json"), JSON.stringify({ subscriptionId: "sub", alias: "Alias",
    nodeId: "node", shareId: "share", revision: 2 }));
  const subscription = { ...recipe, recipeId: "recipe_subscribed", name: "Remote reusable 工作" };
  await writeFile(join(cache, "content", "recipes", "Remote.json"), JSON.stringify(subscription));
  await writeFile(join(cache, "content", "recipes", "Bad.json"), JSON.stringify({ ...subscription, executableDigest: "f".repeat(64) }));
  await writeFile(join(cache, "content", "recipes", "Ignored.json.pkm-source.json"), JSON.stringify(subscription));
  const runs = join(data, "recipe-usage-reads", ".pkm", "state", "recipe-runs");
  await mkdir(runs, { recursive: true });
  await writeFile(join(runs, "recipe_run_one.json"), JSON.stringify({
    schema: "pkm.recipe.run/v1", runId: "recipe_run_one", recipeId: recipe.recipeId, recipeName: recipe.name,
    recipeRevision: 1, status: "failed", nodeAttemptCounts: { work: 3 },
    nodes: { work: { state: "failed", attempt: 3 } }, loops: {},
    usage: { measuredTokens: { total_tokens: 120 }, estimatedTokens: 200, measuredReports: 1, unknownModelCalls: 1 },
  }));
  await writeFile(join(runs, "recipe_run_two.json"), JSON.stringify({
    schema: "pkm.recipe.run/v1", runId: "recipe_run_two", recipeId: recipe.recipeId, recipeName: recipe.name,
    recipeRevision: 1, status: "succeeded", nodes: {}, nodeAttemptCounts: {}, loops: {},
  }));
  await writeFile(join(runs, "recipe_run_corrupt.json"), "{bad");
  const calls = [
    { tool: "recipe_search", arguments: {} },
    { tool: "recipe_search", arguments: { query: "reusable 工作", task_contract_json: '{"purpose":"工作"}' } },
    { tool: "recipe_search", arguments: { project_id: "project_a", query: "automation", limit: 50 } },
    { tool: "recipe_search", arguments: { category: "Automation", query: "automation", limit: 50 } },
    { tool: "recipe_search", arguments: { query: "does-not-exist", task_contract_json: "{}" } },
    { tool: "recipe_search", arguments: { task_contract_json: "invalid" } },
    { tool: "recipe_usage_summary", arguments: {} },
    { tool: "recipe_usage_summary", arguments: { recipe_id: recipe.recipeId, limit: 1 } },
    { tool: "recipe_usage_summary", arguments: { recipe_id: "unknown", limit: 100 } },
    { tool: "recipe_usage_summary", arguments: { limit: 0 } },
  ];
  const originalData = join(parent, "original-source-oracle");
  await cp(data, originalData, { recursive: true });
  await mkdir(join(originalData, ".pkm", "state"), { recursive: true });
  await writeFile(join(originalData, ".pkm", "state", "recipe-store.json"), "{}");
  await cp(runs, join(originalData, ".pkm", "state", "recipe-runs"), { recursive: true });
  const original = JSON.parse(execFileSync("python3", ["-c", oracle], { input: JSON.stringify({
    resources: join(repository, "resources"), contracts: join(root, "dist/domain/project-recipes-workflow-contracts.js"),
    data: originalData, names, calls,
  }), encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }));
  assert.equal(original.values[0].candidates.filter(value => value.source === "subscription").length, 1);
  assert.equal(original.values[0].candidates.length, 3);
  assert.equal(original.values[6].summaries[0].run_count, 2);
  assert.equal(original.values[6].summaries[0].retries, 2);
  for (let restart = 0; restart < 2; restart++) {
    client = new Client({ name: "recipe-source-oracle", version: "0.1.0" });
    const transport = new StdioClientTransport({ command: "python3", args: [
      join(root, "compat/legacy-compact-mcp.py"), "--data", data, "--node", process.execPath,
      "--managed-generation", managed,
    ], env: { ...process.env, PKM_CAPABILITY_PROFILE: profile, PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe" });
    let errors = "";
    transport.stderr?.on("data", chunk => { errors += chunk; });
    try { await client.connect(transport); }
    catch (error) { throw new Error(`${error.message}\n${errors}`); }
    const listed = (await client.listTools()).tools;
    for (const name of names) {
      const actual = profile === "legacy" ? listed.find(tool => tool.name === name)
        : (await client.callTool({ name: "capabilities_describe",
          arguments: { operation: `mcp.tool.${name}` } })).structuredContent;
      assert.deepEqual(actual.inputSchema, original.tools[name].inputSchema);
      assert.deepEqual(actual.outputSchema ?? null, original.tools[name].outputSchema ?? null);
      assert.equal(profile === "legacy" ? actual.annotations.readOnlyHint : actual.readOnly, true);
    }
    for (const [index, call] of calls.entries()) {
      const result = await client.callTool(profile === "legacy" ? { name: call.tool, arguments: call.arguments }
        : { name: "capability_read", arguments: { operation: `mcp.tool.${call.tool}`, version: 1, arguments: call.arguments } });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const value = result.structuredContent ?? JSON.parse(result.content[0].text);
      assert.deepEqual(value, original.values[index]);
    }
    await closeLegacyManagedFixture(client);
    client = undefined;
  }
});

test("original Recipe usage remains callable after real import, managed restart and relocated native restore", { timeout: 90_000 }, async t => {
  const parent = await mkdtemp(join(tmpdir(), "pkm-recipe-import-mcp-"));
  let client, storage;
  t.after(async () => { try { await client?.close(); await storage?.close(); }
    finally { await rm(parent, { recursive: true, force: true }); } });
  const source = join(parent, "original-source");
  await mkdir(join(source, "notes"), { recursive: true, mode: 0o700 });
  await writeFile(join(source, "notes", "Entry.md"), "---\ntitle: Entry\ndocumentId: usage-note\n---\nBody\n");
  const directory = join(source, ".pkm", "state", "recipe-runs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const run = { schema: "pkm.recipe.run/v1", recipeId: "recipe_original", recipeRevision: 3,
    recipeName: "Original retained 工作", nodes: {}, status: "succeeded", nodeAttemptCounts: {},
    usage: { measuredTokens: { total_tokens: 60 }, estimatedTokens: 90, measuredReports: 1 } };
  const files = [["recipe_run_Original name.json", JSON.stringify(run)],
    ["recipe_run_second.json", JSON.stringify({ ...run, status: "failed" })], ["recipe_run_corrupt.json", "{bad"]];
  for (const [index, [name, raw]] of files.entries()) {
    const path = join(directory, name);
    await writeFile(path, raw, { mode: 0o600 });
    await utimes(path, 1_700_000_000 + index, 1_700_000_000 + index);
  }
  const pin = async () => Promise.all(files.map(async ([name]) => {
    const path = join(directory, name), info = await stat(path, { bigint: true });
    return { name, raw: await readFile(path, "utf8"), dev: info.dev, ino: info.ino,
      mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs };
  }));
  const before = await pin();
  const calls = [{ tool: "recipe_usage_summary", arguments: {} },
    { tool: "recipe_usage_summary", arguments: { recipe_id: run.recipeId, limit: 1 } }];
  const original = JSON.parse(execFileSync("python3", ["-c", oracle], { input: JSON.stringify({
    resources: join(repository, "resources"), contracts: join(root, "dist/domain/project-recipes-workflow-contracts.js"),
    data: source, names: ["recipe_usage_summary"], calls,
  }), encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }));
  const plan = await planLegacyImport(source);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const data = join(parent, "imported"), restored = join(parent, "relocated");
  const pythonExecutable = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  await importLegacyWorkspace(plan, data, { pythonExecutable });
  for (const phase of ["imported", "restarted", "relocated"]) {
    const current = phase === "relocated" ? restored : data;
    const managed = await legacyManagedFixture(parent);
    client = new Client({ name: `recipe-import-${phase}`, version: "0.1.0" });
    await client.connect(new StdioClientTransport({ command: "python3", args: [
      join(root, "compat/legacy-compact-mcp.py"), "--data", current, "--node", process.execPath,
      "--managed-generation", managed,
    ], env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe" }));
    for (const [index, call] of calls.entries()) {
      const result = await client.callTool({ name: "capability_read",
        arguments: { operation: `mcp.tool.${call.tool}`, version: 1, arguments: call.arguments } });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.deepEqual(result.structuredContent ?? JSON.parse(result.content[0].text), original.values[index]);
    }
    await closeLegacyManagedFixture(client);
    client = undefined;
    if (phase === "restarted") {
      storage = await Storage.open(data);
      await createWorkspaceBackup(storage, join(parent, "backup"), {
        acquireQuiescence: async () => ({ assertHeld() {}, release() {} }),
      });
      await storage.close();
      storage = undefined;
      await restoreWorkspaceBackup(join(parent, "backup"), restored, { nativeRestoreAuthority, pythonExecutable });
    }
  }
  assert.deepEqual(await pin(), before);
});
