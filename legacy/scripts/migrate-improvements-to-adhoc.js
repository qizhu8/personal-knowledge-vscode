#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ProjectStore } = require("../dist/workflows/project-store");

const knowledgeRoot = process.argv[2];
if (!knowledgeRoot) throw new Error("Usage: node scripts/migrate-improvements-to-adhoc.js <knowledge-root>");

const stateRoot = path.join(path.resolve(knowledgeRoot), ".pkm", "state");
const runsDirectory = path.join(stateRoot, "recipe-runs");
const sessionsDirectory = path.join(stateRoot, "agent-sessions");
const legacyName = "Improvements Backlog - Sequential";
const legacyNodeIds = new Set([
  "localize_copy", "unify_dark_controls", "refactor_meeting_summary",
  "track_recipe_progress", "complete_navigation", "segment_navigation",
]);

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function atomicWrite(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value), "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function jsonFiles(directory) {
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).filter(name => name.endsWith(".json")).map(name => path.join(directory, name))
    : [];
}

const store = new ProjectStore(stateRoot);
const snapshot = store.list();
const legacyRecipe = snapshot.recipes.find(recipe => recipe.scope === "global" && recipe.name === legacyName);
const legacyRecipeIds = new Set(legacyRecipe ? [legacyRecipe.recipeId] : []);
const matchingRuns = [];

for (const filePath of jsonFiles(runsDirectory)) {
  const run = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (run.recipeName === "Implement the six numbered improvements" && run.origin?.kind === "agent-session-adhoc") continue;
  const nodeIds = new Set((run.definition?.spec?.nodes || []).map(node => node.nodeId));
  const matchesLegacyGraph = nodeIds.size === legacyNodeIds.size && [...legacyNodeIds].every(nodeId => nodeIds.has(nodeId));
  if (run.recipeId === legacyRecipe?.recipeId || matchesLegacyGraph && run.agentSessionId) {
    if (run.status !== "completed") throw new Error(`Refusing to migrate unfinished run ${run.runId}.`);
    legacyRecipeIds.add(run.recipeId);
    matchingRuns.push({ filePath, run });
  }
}

for (const { filePath, run } of matchingRuns) {
  const adhocRecipeId = `adhoc_recipe_${run.executableDigest.slice(0, 24)}`;
  run.recipeId = adhocRecipeId;
  run.recipeName = "Implement the six numbered improvements";
  run.origin = { kind: "agent-session-adhoc" };
  run.ancestry = (run.ancestry || []).map(identity => legacyRecipeIds.has(identity) ? adhocRecipeId : identity);
  atomicWrite(filePath, run);
}

for (const filePath of jsonFiles(sessionsDirectory)) {
  const session = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!(session.recipeRunIds || []).some(runId => matchingRuns.some(candidate => candidate.run.runId === runId))) continue;
  session.summary = String(session.summary || "").replace("Completed Improvements Backlog - Sequential", "Completed ad hoc improvements task");
  for (const checkpoint of session.checkpoints || []) {
    const state = checkpoint.state || {};
    state.summary = String(state.summary || "")
      .replace("Six-item improvements Recipe created", "Six-item ad hoc improvements task plan created")
      .replace("strict Recipe order", "strict task-plan order");
    if (Array.isArray(state.completed)) {
      state.completed = state.completed.map(item => String(item).replace("Six-node sequential Improvements Recipe seeded idempotently", "Six-node ad hoc improvements task plan started"));
    }
  }
  atomicWrite(filePath, session);
}

if (legacyRecipe) {
  const value = { recipeId: legacyRecipe.recipeId, migration: "agent-session-adhoc" };
  const hash = fingerprint(value);
  store.deleteRecipe({
    commandId: `migrate-improvements-adhoc-${legacyRecipe.recipeId}`,
    fingerprint: hash,
    expectedStoreVersion: store.list().storeVersion,
  }, legacyRecipe.recipeId);
}

console.log(JSON.stringify({
  migratedRuns: matchingRuns.map(candidate => candidate.run.runId),
  removedRecipeId: legacyRecipe?.recipeId || null,
  reflectionAvailable: store.list().recipes.some(recipe => recipe.name === "Reflection" && recipe.systemKind === "built-in"),
}, null, 2));