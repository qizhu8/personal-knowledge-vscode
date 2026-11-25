import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { recipeExecutionFixture, originalRecipeTraceProjection as project } from "./fixtures/original-mcp-recipe-execution-fixture.mjs";
import { planOriginalMcpRecipeLibrary, admitOriginalMcpRecipeLibrary, activateOriginalMcpRecipeLibrary } from "../dist/original-mcp-recipe-library.js";
import { createOriginalMcpRecipeExecution } from "../dist/original-mcp-recipe-execution.js";
import { planOriginalMcpRecipeUsage, admitOriginalMcpRecipeUsage } from "../dist/original-mcp-recipe-usage.js";
import { createNativePublicOwnerBackend } from "../dist/native-public-mcp-owner.js";
import { acquireOriginalMcpRootFence } from "../dist/original-mcp-root.js";
import { readOriginalMcpJournal } from "../dist/original-mcp-root-custody.js";
import { withOriginalMcpColdSqliteRead, originalMcpColdSqliteReadDatabase } from "../dist/original-mcp-cold-sqlite-read.js";
import { canonicalJson } from "../dist/domain/project-recipes-workflow-contracts.js";
const require = createRequire(import.meta.url);
const id = command => "recipe_run_" + createHash("sha256").update(command).digest("hex").slice(0, 24);
test("original canonical Library admission drives real native lazy start/claim/report/get with exact identities, receipts and original Python results", { timeout: 90000 }, async t => {
  const f = await recipeExecutionFixture(t);
  await assert.rejects(createOriginalMcpRecipeExecution(f.opened.owner, f.host), /Library source decision/);
  const usage = await planOriginalMcpRecipeUsage(f.opened.owner, f.host, { maxFiles: 10, maxFileBytes: 1048576, maxTotalBytes: 1048576 });
  await admitOriginalMcpRecipeUsage(f.opened.owner, f.host, usage, f.producer.policy);
  await assert.rejects(createOriginalMcpRecipeExecution(f.opened.owner, f.host), /Library source decision/);
  const source = await planOriginalMcpRecipeLibrary(f.opened.owner, f.host, f.selection);
  await assert.rejects(admitOriginalMcpRecipeLibrary(f.opened.owner, f.host, source, { ...f.producer.policy }), /POLICY_REQUIRED/);
  await admitOriginalMcpRecipeLibrary(f.opened.owner, f.host, source, f.producer.policy);
  const execution = await createOriginalMcpRecipeExecution(f.opened.owner, f.host);
  assert.equal(await createOriginalMcpRecipeExecution(f.opened.owner, f.host), execution, "One actual scheduler per current root/source, never independent copies.");
  const command = "original-native-library-flow", runId = id(command);
  const start = { recipe_id: f.recipe.recipeId, command_id: command, expected_revision: f.recipe.revision,
    expected_digest: f.recipe.executableDigest, inputs_json: '{"task":"caller performed work"}' };
  const report1 = { run_id: runId, node_id: "first", command_id: "report-first", outcome: "succeeded",
    result_json: JSON.stringify({ sha256: f.hash(readFileSync(f.callerInput)), authority: "external-caller-reported-not-native-verified" }),
    usage_json: '{"estimated_tokens":12}', detail: "full" };
  const report2 = { run_id: runId, node_id: "second", command_id: "report-second", outcome: "succeeded", result_json: "null", detail: "full" };
  const calls = [
    { tool: "recipe_run_start", args: start }, { tool: "recipe_run_get", args: { run_id: runId } },
    { tool: "recipe_run_next", args: { run_id: runId, command_id: "claim-first" } },
    { tool: "recipe_run_get", args: { run_id: runId, detail: "compact" } },
    { tool: "recipe_run_report", args: report1 }, { tool: "recipe_run_report", args: report2 },
    { tool: "recipe_run_get", args: { run_id: runId } },
    { tool: "recipe_run_report", args: report1 }, { tool: "recipe_run_start", args: start },
    { tool: "recipe_run_report", args: { ...report1, result_json: '{"changed":true}' } },
  ];
  const old = f.oracle(calls);
  assert.equal(old[0].ok, true, JSON.stringify(old[0])); assert.equal(old[6].status, "completed");
  const backend = createNativePublicOwnerBackend(f.opened.owner,
    { actor: { id: "mcp:external", canWrite: true }, originalMcpHost: f.host });
  try {
    for (const [index, call] of calls.entries()) {
      const response = await backend.invoke("original_mcp_public", { tool: call.tool, arguments: call.args });
      assert.deepEqual(project(response.structuredContent), project(old[index]),
        `Original public lifecycle case ${index}: ${call.tool}`);
    }
    const automaticId = id("original-public-autonomous-boundary");
    const automaticStart = { ...start, command_id: "original-public-autonomous-boundary", autonomous: true,
      max_auto_nodes: 1, max_auto_seconds: 5 };
    const automaticCalls = [
      { tool: "recipe_run_start", args: automaticStart },
      { tool: "recipe_run_get", args: { run_id: automaticId } },
      { tool: "recipe_run_next", args: { run_id: automaticId, command_id: "automatic-claim-first" } },
      { tool: "recipe_run_report", args: { ...report1, run_id: automaticId, command_id: "automatic-report-first" } },
      { tool: "recipe_run_next", args: { run_id: automaticId, command_id: "automatic-claim-second" } },
      { tool: "recipe_run_report", args: { ...report2, run_id: automaticId, command_id: "automatic-report-second" } },
      { tool: "recipe_run_start", args: automaticStart },
    ];
    const automaticOld = f.oracle(automaticCalls);
    for (const [index, call] of automaticCalls.entries()) {
      const response = (await backend.invoke("original_mcp_public", { tool: call.tool, arguments: call.args })).structuredContent;
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.equal(response.status, automaticOld[index].status);
      assert.equal(response.next_action.kind, automaticOld[index].next_action.kind);
      assert.equal(response.automation.status, automaticOld[index].automation.status);
      assert.equal(response.automation.startedNodes, 0, "Source/report approval never becomes a native host effect grant.");
      assert.equal(response.replayed, automaticOld[index].replayed);
    }
  } finally { await backend.close(); }
  assert.equal(execution.ownsRun(runId), true);
  await assert.rejects(execution.dispatch("recipe_run_start", start, { id: "mcp:external", canWrite: true }), /Exact fresh native public request/);
  await assert.rejects(f.dispatch(execution, "recipe_run_get", { run_id: runId }, { id: "mcp:external", canWrite: false }), /writable actor/);
  f.controls.public = false; await assert.rejects(f.dispatch(execution, "recipe_run_get", { run_id: runId }));
  f.controls.public = true;
  const invalidBound = await f.dispatch(execution, "recipe_run_start",
    { ...start, command_id: "bad-auto-bound", autonomous: true, max_auto_nodes: 0 });
  assert.equal(invalidBound.ok, false);
  assert.equal(invalidBound.error.code, "recipe-run-start-failed");
  const denied = await f.dispatch(execution, "recipe_run_start", { ...start, command_id: "bad-revision", expected_revision: 999 });
  assert.equal(denied.ok, false);
  const db = f.opened.storage.connectNative();
  try {
    const native = db.prepare("SELECT snapshot FROM workflow_executor_runs WHERE run_id=?").get(runId);
    assert.equal(JSON.parse(native.snapshot).state, "succeeded");
    assert.equal(db.prepare("SELECT count(*) AS count FROM workflow_executor_assignments WHERE run_id=?").get(runId).count, 2);
    assert.equal(db.prepare("SELECT count(*) AS count FROM legacy_recipe_lazy_receipts WHERE run_id=?").get(runId).count, 4);
    assert.throws(() => db.exec("UPDATE original_recipe_library_source SET record='{}'"), /immutable/);
  } finally { db.close(); }
  execution.close();
  await f.close(); await f.reopen();
  await assert.rejects(createOriginalMcpRecipeExecution(f.opened.owner, f.host), /Library source decision/);
  await activateOriginalMcpRecipeLibrary(f.opened.owner, f.host, f.producer.policy);
  const reopened = await createOriginalMcpRecipeExecution(f.opened.owner, f.host);
  assert.deepEqual(project(await f.dispatch(reopened, "recipe_run_get", { run_id: runId })), project(old[6]));
  assert.equal((await f.dispatch(reopened, "recipe_run_start", start)).replayed, true);
});
test("Library scope preserves definition-only commands, denial/cancellation and drift; source revocation fences a real claimed native node UNKNOWN without replay", { timeout: 90000 }, async t => {
  const f = await recipeExecutionFixture(t), source = await planOriginalMcpRecipeLibrary(f.opened.owner, f.host, f.selection);
  const { RecipeFilesystemStore } = require("../legacy/dist/workflows/recipe-filesystem-store.js");
  const unsafe = new RecipeFilesystemStore(join(f.root, ".pkm/state")).list().recipes.find(item => item.recipeId === "recipe_unadmitted_command");
  const definitionOnly = await planOriginalMcpRecipeLibrary(f.opened.owner, f.host, { ...f.selection, recipeId: unsafe.recipeId,
    expectedRevision: unsafe.revision, expectedExecutableDigest: unsafe.executableDigest });
  assert.equal(definitionOnly.noExecution, true);
  assert.deepEqual(definitionOnly.effects, ["caller-reported-result-only"]);
  f.controls.allow = false;
  await assert.rejects(admitOriginalMcpRecipeLibrary(f.opened.owner, f.host, source, f.producer.policy), /denied/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(admitOriginalMcpRecipeLibrary(f.opened.owner, f.host, source, f.producer.policy, cancelled.signal), /abort/i);
  f.controls.allow = true;
  await admitOriginalMcpRecipeLibrary(f.opened.owner, f.host, source, f.producer.policy);
  const execution = await createOriginalMcpRecipeExecution(f.opened.owner, f.host);
  const started = await f.dispatch(execution, "recipe_run_start", { recipe_id: f.recipe.recipeId, command_id: "claimed-before-revoke" });
  await f.dispatch(execution, "recipe_run_next", { run_id: started.run_id, command_id: "claim-before-revoke" });
  f.producer.revoke();
  await assert.rejects(f.dispatch(execution, "recipe_run_get", { run_id: started.run_id }), /closed|decision/);
  await activateOriginalMcpRecipeLibrary(f.opened.owner, f.host, f.producer.policy);
  const current = await createOriginalMcpRecipeExecution(f.opened.owner, f.host);
  const db = f.opened.storage.connectNative();
  try {
    const snapshot = JSON.parse(db.prepare("SELECT snapshot FROM workflow_executor_runs WHERE run_id=?").get(started.run_id).snapshot);
    assert.equal(snapshot.state, "unknown");
    assert.equal(db.prepare("SELECT count(*) AS count FROM workflow_executor_assignments WHERE run_id=?").get(started.run_id).count, 1);
  } finally { db.close(); }
  const inspected = await f.dispatch(current, "recipe_run_get", { run_id: started.run_id });
  assert.equal(inspected.status, "running");
  const report = await f.dispatch(current, "recipe_run_report", { run_id: started.run_id, node_id: "first",
    command_id: "do-not-replay", outcome: "succeeded", result_json: "null" });
  assert.equal(report.ok, false);
  const raw = readFileSync(f.sourceFile);
  try { writeFileSync(f.sourceFile, raw.toString().replace("External work", "Unapproved change"));
    await assert.rejects(f.dispatch(current, "recipe_run_get", { run_id: started.run_id }), /source membership or bytes changed/);
  } finally { writeFileSync(f.sourceFile, raw); }
});
test("historical Library cold reads preserve unknown receipts but reject altered, foreign, orphaned and incomplete metadata", { timeout: 90000 }, async t => {
  for (const condition of ["retained-unknown", "schema", "source", "root", "workspace", "actor", "orphan", "definition", "incomplete"])
    await t.test(condition, async t => {
      const f = await recipeExecutionFixture(t);
      const source = await planOriginalMcpRecipeLibrary(f.opened.owner, f.host, f.selection);
      await admitOriginalMcpRecipeLibrary(f.opened.owner, f.host, source, f.producer.policy);
      const execution = await createOriginalMcpRecipeExecution(f.opened.owner, f.host);
      const started = await f.dispatch(execution, "recipe_run_start",
        { recipe_id: f.recipe.recipeId, command_id: `cold-history-${condition}` });
      assert.equal(started.ok, true);
      const database = f.opened.storage.connectNative();
      try {
        if (condition === "schema") database.exec("DROP TRIGGER original_recipe_library_source_no_update");
        if (condition === "source") {
          const { sql } = database.prepare("SELECT sql FROM sqlite_master WHERE name='original_recipe_library_source_no_update'").get();
          database.exec("DROP TRIGGER original_recipe_library_source_no_update");
          database.exec("UPDATE original_recipe_library_source SET record='{}'");
          database.exec(sql);
        }
        if (condition === "root" || condition === "workspace") {
          const row = database.prepare("SELECT source,approval FROM original_recipe_library_source").get();
          const altered = JSON.parse(row.source), decision = JSON.parse(row.approval);
          if (condition === "root") altered.root = join(f.root, "foreign");
          else altered.workspaceId = "00000000-0000-4000-8000-000000000001";
          const body = { ...altered }; delete body.planSha256;
          altered.planSha256 = f.hash(canonicalJson(body));
          decision.requestSha256 = f.hash(canonicalJson({ ...altered, phase: "admit", actorId: "mcp:external",
            epoch: f.host.receipt.epoch, nativeHostReceiptSha256: f.host.receipt.receiptSha256, noExecution: true }));
          const { sql } = database.prepare("SELECT sql FROM sqlite_master WHERE name='original_recipe_library_source_no_update'").get();
          database.exec("DROP TRIGGER original_recipe_library_source_no_update");
          database.prepare("UPDATE original_recipe_library_source SET source=?,approval=?")
            .run(canonicalJson(altered), canonicalJson(decision));
          database.exec(sql);
        }
        if (condition === "actor") database.exec("UPDATE legacy_recipe_lazy_runs SET actor_id='foreign'");
        if (condition === "orphan") database.prepare("INSERT INTO legacy_recipe_lazy_receipts VALUES(?,?,?,?,NULL)")
          .run("mcp:external", id("nonexistent-cold-run"), "orphan", f.hash("orphan"));
        if (condition === "definition") {
          const row = database.prepare("SELECT record FROM legacy_recipe_lazy_runs WHERE run_id=?").get(started.run_id);
          const run = JSON.parse(row.record); run.definition = {};
          database.prepare("UPDATE legacy_recipe_lazy_runs SET record=? WHERE run_id=?").run(JSON.stringify(run), started.run_id);
        }
        if (condition === "incomplete") database.exec("DROP TABLE legacy_recipe_lazy_receipts");
        if (condition === "retained-unknown") database.exec("UPDATE legacy_recipe_lazy_receipts SET response=NULL");
      } finally { database.close(); }
      await f.close();
      const fence = await acquireOriginalMcpRootFence(f.root), before = f.hash(readFileSync(join(f.root, "core.sqlite")));
      try {
        let called = false;
        const plan = readOriginalMcpJournal(f.root).plan;
        const actualInspect = () => withOriginalMcpColdSqliteRead(plan, fence, async context => {
          called = true;
          const reader = originalMcpColdSqliteReadDatabase(context, plan);
          assert.equal(reader.prepare("SELECT response FROM legacy_recipe_lazy_receipts WHERE run_id=?").get(started.run_id).response, null);
          assert.equal(reader.prepare("SELECT count(*) AS n FROM workflow_executor_assignments WHERE run_id=?").get(started.run_id).n, 0);
        });
        if (condition === "retained-unknown") { await actualInspect(); assert.equal(called, true); }
        else { await assert.rejects(actualInspect, { code: "RECOVERY_REQUIRED" }); assert.equal(called, false); }
        assert.equal(f.hash(readFileSync(join(f.root, "core.sqlite"))), before);
      } finally { await fence.release(); }
      if (condition === "retained-unknown") {
        await f.reopen();
        await assert.rejects(createOriginalMcpRecipeExecution(f.opened.owner, f.host), /Library source decision/);
      }
    });
});
