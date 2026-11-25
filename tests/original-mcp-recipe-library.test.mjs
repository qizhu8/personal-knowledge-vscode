import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { recipeExecutionFixture, originalRecipeTraceProjection as project } from "./fixtures/original-mcp-recipe-execution-fixture.mjs";
import { planOriginalMcpRecipeLibrary, admitOriginalMcpRecipeLibrary,
  readOriginalMcpRecipeLibrarySearch } from "../dist/original-mcp-recipe-library.js";
import { createNativePublicOwnerBackend } from "../dist/native-public-mcp-owner.js";

const definition = nodes => ({ schema: "pkm.workflow.definition/v1",
  spec: { inputs: {}, outputs: {}, nodes, completion: { requiredNodes: [nodes.at(-1).nodeId] } } });
const runId = command => "recipe_run_" + createHash("sha256").update(command).digest("hex").slice(0, 24);
const backend = f => createNativePublicOwnerBackend(f.opened.owner,
  { actor: { id: "mcp:external", canWrite: true }, originalMcpHost: f.host });

test("expanded definition admission still denies repeated graphs and unapproved Knowledge bindings before sealing", { timeout: 90000 }, async t => {
  for (const options of [
    { definition: definition([{ nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [],
      control: { mode: "repeat", count: { kind: "fixed", value: 2 } } }]) },
    { definition: definition([{ nodeId: "work", kind: "pkm.step.script/v1", dependsOn: [],
      config: { runtime: "bash", script: "printf never-execute-bound-script" } }]),
      nodeBindings: [{ nodeId: "work", bindings: [{ bindingId: "source-skill", kind: "skill",
        knowledgeId: `knowledge_${"a".repeat(24)}`, contentHash: "b".repeat(64), usage: "required" }] }] },
  ]) await t.test(options.nodeBindings ? "Knowledge" : "repeat", async t => {
    const f = await recipeExecutionFixture(t, options);
    await assert.rejects(planOriginalMcpRecipeLibrary(f.opened.owner, f.host, f.selection),
      /NoOp\/command\/Script\/Pipeline definitions only/);
    const db = f.opened.storage.connectNative();
    try { assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='original_recipe_library_source'").get(), undefined); }
    finally { db.close(); }
  });
});

for (const [kind, config] of [
  ["pkm.step.command/v1", { program: "/never-run-original-command", args: [] }],
  ["pkm.step.script/v1", { runtime: "bash", script: "printf never-execute-source-admission" }],
  ["pkm.step.pipeline/v1", { executor: "script", runtime: "bash", script: "printf never-execute-pipeline-admission" }],
]) test(`signed Library definition admission/search preserves ${kind} without granting effects`, { timeout: 90000 }, async t => {
  const f = await recipeExecutionFixture(t, { definition: definition([{ nodeId: "work", kind, config, dependsOn: [] }]) });
  const old = f.oracle([{ tool: "recipe_run_start", args: { recipe_id: f.recipe.recipeId, command_id: `original-${kind}` } }]);
  assert.equal(old[0].ok, true, JSON.stringify(old));
  t.diagnostic(JSON.stringify({ behavior: kind, originalStart: old[0] }));
  const source = await planOriginalMcpRecipeLibrary(f.opened.owner, f.host, f.selection);
  assert.equal(source.noExecution, true);
  assert.deepEqual(source.effects, ["caller-reported-result-only"]);
  await admitOriginalMcpRecipeLibrary(f.opened.owner, f.host, source, f.producer.policy);
  const api = backend(f);
  try {
    const args = { query: "Original external", category: "", project_id: "", limit: 10, task_contract_json: "{}" };
    for (const value of [args, { ...args, query: "" }, { ...args, query: "absent-recipe" },
      { ...args, task_contract_json: "[]" }]) {
      const search = await api.invoke("original_mcp_public", { tool: "recipe_search", arguments: value });
      assert.deepEqual(search.structuredContent, f.oracle([{ tool: "recipe_search", args: value }])[0]);
    }
    await assert.rejects(readOriginalMcpRecipeLibrarySearch(f.opened.owner, f.host,
      { id: "mcp:external", canWrite: true }, args), /Exact fresh native public/);
    const reader = createNativePublicOwnerBackend(f.opened.owner,
      { actor: { id: "mcp:external", canWrite: false }, originalMcpHost: f.host });
    try {
      const read = await reader.invoke("original_mcp_public", { tool: "recipe_search", arguments: args });
      assert.equal(read.structuredContent.candidates[0].recipe_id, f.recipe.recipeId);
    } finally { await reader.close(); }
    assert.equal(f.frames.some(frame => frame.method === "recipe.effect.approve"), false,
      "Authoring/search must not ask for or inherit a host-effect decision.");
    const db = f.opened.storage.connectNative();
    try {
      for (const table of ["workflow_executor_assignments", "legacy_recipe_lazy_runs"])
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
          assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
    } finally { db.close(); }
    f.producer.revoke();
    await assert.rejects(api.invoke("original_mcp_public", { tool: "recipe_search", arguments: args }), /decision|required|closed/i);
  } finally { await api.close(); }
});

test("actual original public Recipe facade admits and executes an explicitly reported static ported branch", { timeout: 90000 }, async t => {
  const graph = definition([
    { nodeId: "choose", kind: "pkm.step.noop/v1", config: {}, dependsOn: [],
      ports: { inputs: [], outputs: ["evidence", "valid", "invalid"] },
      control: { mode: "branch", kind: "switch", cases: ["valid", "invalid"] } },
    { nodeId: "finish", kind: "pkm.step.noop/v1", config: {},
      ports: { inputs: ["evidence"], outputs: ["result"] },
      dependsOn: [{ from: "choose", accept: ["valid"], fromOutput: "evidence", toInput: "evidence", required: true }] },
  ]);
  const f = await recipeExecutionFixture(t, { definition: graph });
  const command = "static-ported-public", id = runId(command);
  const calls = [
    { tool: "recipe_run_start", args: { recipe_id: f.recipe.recipeId, command_id: command } },
    { tool: "recipe_run_next", args: { run_id: id, command_id: "choose" } },
    { tool: "recipe_run_report", args: { run_id: id, node_id: "choose", command_id: "branch-report", outcome: "valid",
      result_json: '{"evidence":"caller-owned-result","valid":true,"invalid":false}', detail: "full" } },
    { tool: "recipe_run_report", args: { run_id: id, node_id: "finish", command_id: "finish-report", outcome: "succeeded",
      result_json: '{"result":"caller-owned-result"}', detail: "full" } },
    { tool: "recipe_run_get", args: { run_id: id, detail: "full" } },
  ];
  const old = f.oracle(calls);
  assert(old.every(item => item.ok), JSON.stringify(old));
  t.diagnostic(JSON.stringify({ behavior: "ported-static-branch", calls, originalResponses: old }));
  const source = await planOriginalMcpRecipeLibrary(f.opened.owner, f.host, f.selection);
  await admitOriginalMcpRecipeLibrary(f.opened.owner, f.host, source, f.producer.policy);
  const api = backend(f);
  try {
    for (const [index, call] of calls.entries()) {
      const result = await api.invoke("original_mcp_public", { tool: call.tool, arguments: call.args });
      const actual = project(result.structuredContent);
      if (actual.status === "failed") {
        const db = f.opened.storage.connectNative();
        try { t.diagnostic(JSON.stringify({ failedNodes: JSON.parse(db.prepare(
          "SELECT snapshot FROM workflow_executor_runs WHERE run_id=?").get(id).snapshot).nodes })); }
        finally { db.close(); }
      }
      if (actual.runtime) {
        assert.equal(actual.runtime.executionSemantics, "original-recipe-metadata/v1");
        delete actual.runtime;
      }
      assert.deepEqual(actual, project(old[index]), call.tool);
    }
    assert.equal(old.at(-1).status, "completed");
    const db = f.opened.storage.connectNative();
    try { assert.equal(db.prepare("SELECT count(*) AS n FROM workflow_executor_assignments WHERE run_id=?").get(id).n, 2); }
    finally { db.close(); }
  } finally { await api.close(); }
});
