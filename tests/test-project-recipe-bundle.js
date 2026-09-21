#!/usr/bin/env node
const assert = require("assert");
const crypto = require("crypto");
const { canonicalJson } = require("../dist/workflow-contracts.js");
const { initializeProjectModel } = require("../dist/workflows/project-model.js");
const {
  PROJECT_RECIPE_BUNDLE_SCHEMA, ProjectRecipeBundleError, exportProjectRecipeBundle, parseProjectRecipeBundle
} = require("../dist/workflows/project-recipe-bundle.js");

const hash = content => crypto.createHash("sha256").update(content, "utf8").digest("hex");
const error = (action, code) => assert.throws(action, value => value instanceof ProjectRecipeBundleError && value.code === code);
const state = initializeProjectModel(undefined, () => "bundle");
const project = state.projects[0];
const skillDocument = { name: "Verify", description: "", category: "Coding", tags: [], content: "Run focused tests.\n" };
const noteDocument = { title: "Release Constraints", type: "general", category: "Projects", tags: [], content: "Do not publish automatically.\n" };
const skillHash = hash(canonicalJson(skillDocument));
const noteHash = hash(canonicalJson(noteDocument));
const recipe = JSON.parse(JSON.stringify(state.recipes[0]));
recipe.editorLayout = { nodePositions: { validate: { x: 480, y: 120 } } };
recipe.nodeBindings = [{ nodeId: "validate", bindings: [
  { bindingId: "validation-skill", kind: "skill", knowledgeId: "Coding/Verify", contentHash: skillHash, usage: "required" },
  { bindingId: "release-note", kind: "note", knowledgeId: "Projects/Release Constraints", contentHash: noteHash, usage: "reference" }
]}];

const bundle = exportProjectRecipeBundle({
  project, recipes: [recipe], exportedAt: "2026-09-21T00:00:00.000Z",
  knowledge: [
    { knowledgeId: "Projects/Release Constraints", kind: "note", contentHash: noteHash, document: noteDocument },
    { knowledgeId: "Coding/Verify", kind: "skill", contentHash: skillHash, document: skillDocument }
  ]
});
assert.strictEqual(bundle.schema, PROJECT_RECIPE_BUNDLE_SCHEMA);
assert.match(bundle.digest, /^[a-f0-9]{64}$/);
assert.deepStrictEqual(bundle.recipes[0].metadata, recipe.metadata);
assert.deepStrictEqual(bundle.recipes[0].editorLayout, recipe.editorLayout);
assert.deepStrictEqual(bundle.knowledge.map(item => item.knowledgeId), ["Coding/Verify", "Projects/Release Constraints"]);
assert.deepStrictEqual(parseProjectRecipeBundle(JSON.parse(JSON.stringify(bundle))), bundle);

const tampered = JSON.parse(JSON.stringify(bundle)); tampered.knowledge[0].document.content += "tampered";
error(() => parseProjectRecipeBundle(tampered), "knowledge-hash-mismatch");
const unresolved = JSON.parse(JSON.stringify(bundle)); unresolved.knowledge = unresolved.knowledge.slice(1);
const { digest: _digest, ...unresolvedPayload } = unresolved;
error(() => exportProjectRecipeBundle({ project: unresolvedPayload.project, recipes: unresolvedPayload.recipes, knowledge: unresolvedPayload.knowledge, exportedAt: unresolvedPayload.exportedAt }), "binding-unresolved");
const wrongDigest = { ...bundle, digest: "0".repeat(64) };
error(() => parseProjectRecipeBundle(wrongDigest), "bundle-digest-mismatch");
console.log("Project Recipe bundle: canonical JSON, pinned knowledge, integrity, and reproducibility OK");