#!/usr/bin/env node
const crypto = require("crypto");
const path = require("path");
const { ProjectStore } = require("../dist/workflows/project-store");

const storeRoot = process.argv[2];
if (!storeRoot) throw new Error("Usage: node scripts/seed-recipe-runtime-validation.js <knowledge-root>");

const store = new ProjectStore(path.join(path.resolve(storeRoot), ".pkm", "state"));
const category = "Examples/Runtime Validation";

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function command(operation, value) {
  const snapshot = store.list();
  const hash = fingerprint(value);
  return {
    commandId: `runtime-validation-${operation}-${hash.slice(0, 20)}`,
    fingerprint: hash,
    expectedStoreVersion: snapshot.storeVersion,
  };
}

function ensureRecipe(name) {
  const existing = store.list().recipes.find(recipe => recipe.name === name && recipe.category === category);
  if (existing) return existing;
  const result = store.createRecipe(command("create", { name, category }), { kind: "global" }, name);
  return result.snapshot.recipes.find(recipe => recipe.recipeId === result.entityId);
}

function updateRecipe(recipe, description, definition) {
  const update = { name: recipe.name, category, description, definition };
  const result = store.updateRecipe(command(`update-${recipe.recipeId}`, update), recipe.recipeId, update);
  return result.snapshot.recipes.find(candidate => candidate.recipeId === recipe.recipeId);
}

const branch = updateRecipe(
  ensureRecipe("Runtime Validation - Branch"),
  "Select exactly one approval path and join after the unselected path is skipped.",
  { schema: "pkm.workflow.definition/v1", spec: {
    inputs: {},
    nodes: [
      { nodeId: "classify", kind: "pkm.step.noop/v1", config: {}, dependsOn: [],
        control: { mode: "branch", kind: "if", cases: ["approved", "rejected"] } },
      { nodeId: "approve", kind: "pkm.step.noop/v1", config: {},
        dependsOn: [{ from: "classify", accept: ["approved"], required: true }] },
      { nodeId: "reject", kind: "pkm.step.noop/v1", config: {},
        dependsOn: [{ from: "classify", accept: ["rejected"], required: true }] },
      { nodeId: "deliver", kind: "pkm.step.noop/v1", config: {}, dependsOn: [
        { from: "approve", accept: ["skipped", "succeeded"], required: true },
        { from: "reject", accept: ["skipped", "succeeded"], required: true },
      ] },
    ],
    outputs: {}, completion: { requiredNodes: ["deliver"] },
  } },
);

const loop = updateRecipe(
  ensureRecipe("Runtime Validation - Bounded Loop"),
  "Repeat work once, then exit on the second quality check.",
  { schema: "pkm.workflow.definition/v1", spec: {
    inputs: {},
    nodes: [
      { nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [
        { from: "check", accept: ["repeat"], required: true,
          loop: { termination: { condition: "quality >= target", maxIterations: 2 } } },
      ] },
      { nodeId: "check", kind: "pkm.step.noop/v1", config: {},
        dependsOn: [{ from: "work", accept: ["succeeded"], required: true }],
        control: { mode: "branch", kind: "if", cases: ["done", "repeat"] } },
      { nodeId: "deliver", kind: "pkm.step.noop/v1", config: {},
        dependsOn: [{ from: "check", accept: ["done"], required: true }] },
    ],
    outputs: {}, completion: { requiredNodes: ["deliver"] },
  } },
);

const child = updateRecipe(
  ensureRecipe("Runtime Validation - Child"),
  "Validate the artifact inside a pinned child Recipe run.",
  { schema: "pkm.workflow.definition/v1", spec: {
    inputs: {},
    nodes: [{ nodeId: "child_validate", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
    outputs: {}, completion: { requiredNodes: ["child_validate"] },
  } },
);

const parent = updateRecipe(
  ensureRecipe("Runtime Validation - Parent"),
  "Prepare an artifact, run the pinned child Recipe, and deliver only after child success.",
  { schema: "pkm.workflow.definition/v1", spec: {
    inputs: {},
    nodes: [
      { nodeId: "prepare", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] },
      { nodeId: "validate_child", kind: "pkm.subflow/v1",
        config: { recipeId: child.recipeId, revision: child.revision, executableDigest: child.executableDigest },
        dependsOn: [{ from: "prepare", accept: ["succeeded"], required: true }] },
      { nodeId: "deliver", kind: "pkm.step.noop/v1", config: {},
        dependsOn: [{ from: "validate_child", accept: ["succeeded"], required: true }] },
    ],
    outputs: {}, completion: { requiredNodes: ["deliver"] },
  } },
);

console.log(JSON.stringify({ branch, loop, child, parent }, null, 2));