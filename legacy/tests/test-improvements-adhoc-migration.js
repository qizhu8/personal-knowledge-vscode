#!/usr/bin/env node
const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ProjectStore } = require("../dist/workflows/project-store.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "improvements-adhoc-"));
try {
  const stateRoot = path.join(root, ".pkm", "state");
  const store = new ProjectStore(stateRoot, (() => { const ids = ["root", "legacy"]; return () => ids.shift(); })());
  const created = store.createRecipe({ commandId: "create", fingerprint: "create", expectedStoreVersion: 1 }, { kind: "global" }, "Improvements Backlog - Sequential");
  const recipeId = created.entityId;
  const runId = "recipe_run_completed";
  fs.mkdirSync(path.join(stateRoot, "recipe-runs"), { recursive: true });
  fs.mkdirSync(path.join(stateRoot, "agent-sessions"), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, "recipe-runs", `${runId}.json`), JSON.stringify({
    runId, recipeId, executableDigest: "a".repeat(64), status: "completed", agentSessionId: "agent_session_test",
    ancestry: [recipeId], definition: { spec: { nodes: [
      "localize_copy", "unify_dark_controls", "refactor_meeting_summary",
      "track_recipe_progress", "complete_navigation", "segment_navigation",
    ].map(nodeId => ({ nodeId })) } }, receipts: []
  }));
  fs.writeFileSync(path.join(stateRoot, "agent-sessions", "agent_session_test.json"), JSON.stringify({
    recipeRunIds: [runId], summary: "Completed Improvements Backlog - Sequential: 6/6 nodes succeeded.",
    checkpoints: [{ state: { summary: "All six improvements completed in strict Recipe order.", completed: ["Six-node sequential Improvements Recipe seeded idempotently"] } }]
  }));

  const script = path.join(__dirname, "..", "scripts", "migrate-improvements-to-adhoc.js");
  childProcess.execFileSync(process.execPath, [script, root]);
  childProcess.execFileSync(process.execPath, [script, root]);

  const run = JSON.parse(fs.readFileSync(path.join(stateRoot, "recipe-runs", `${runId}.json`), "utf8"));
  const session = JSON.parse(fs.readFileSync(path.join(stateRoot, "agent-sessions", "agent_session_test.json"), "utf8"));
  const final = new ProjectStore(stateRoot).list();
  assert.strictEqual(run.recipeId, `adhoc_recipe_${"a".repeat(24)}`);
  assert.strictEqual(run.recipeName, "Implement the six numbered improvements");
  assert.deepStrictEqual(run.origin, { kind: "agent-session-adhoc" });
  assert.deepStrictEqual(run.ancestry, [run.recipeId]);
  assert.match(session.summary, /ad hoc improvements task/);
  assert.match(session.checkpoints[0].state.summary, /task-plan order/);
  assert(!final.recipes.some(recipe => recipe.name === "Improvements Backlog - Sequential"));
  assert(final.recipes.some(recipe => recipe.name === "Reflection" && recipe.systemKind === "built-in"));
  console.log("improvements adhoc migration tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}