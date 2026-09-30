#!/usr/bin/env node
const assert = require("assert");
const { createHash } = require("crypto");
const {
  ProjectModelError, builtInRecipeInventory, createGanttTask, createProject, createRecipe, createRecipeFolder, createThread, deleteGanttTask, deleteRecipe, deleteRecipeFolder, deleteRecipeFromTrash, deriveSystemId, ensureSystemEntities,
  initializeProjectModel, linkThreadChatroom, migrateLegacyRoom, moveRecipeToTrash, moveThread, renameThread, replaceRecipeFromSync, resolveThreadId, restoreRecipeFromTrash, updateGanttTask, updateRecipe
} = require("../dist/workflows/project-model.js");
const {
  compileRecipeMethodologyV1, resolveRecipeMethodology
} = require("../dist/workflows/methodology-model.js");

const errorCode = (action, code) => assert.throws(action, error => error instanceof ProjectModelError && error.code === code);
let state = initializeProjectModel(undefined, () => "root-seed");
assert.strictEqual(state.rootId, "root_root-seed");
assert.strictEqual(state.projects.length, 1);
assert.strictEqual(state.threads.length, 1);
assert.deepStrictEqual(state.recipes.map(recipe => recipe.name), [
  "Universal Unknown Task", "Conditional Closed-Loop Communication", "Configurable Validation and Testing",
  "Software Development", "Bug Fix", "UI Development", "Reflection", "Evolve Recipes from Evidence", "Use Recipe Library",
  "Create Agent Snapshot", "Publish Personal Knowledge VSIX", "Executable Module Examples", "Branch and Repeat Module Examples",
  "DLIS Offline Job Log Diagnosis Example", "PKM Tutorial"
]);
const universalUnknownTask = state.recipes.find(recipe => recipe.name === "Universal Unknown Task");
const closedLoopCommunication = state.recipes.find(recipe => recipe.name === "Conditional Closed-Loop Communication");
const configurableTesting = state.recipes.find(recipe => recipe.name === "Configurable Validation and Testing");
assert.strictEqual(universalUnknownTask.methodology.schema, "pkm.recipe.methodology/v1");
assert.strictEqual(universalUnknownTask.methodology.family, "universal-unknown-task");
assert.match(universalUnknownTask.methodologyDigest, /^[a-f0-9]{64}$/);
assert(universalUnknownTask.methodology.invariants.includes("no-false-understanding"));
assert.strictEqual(closedLoopCommunication.methodology.expansion.mode, "adaptive");
assert(closedLoopCommunication.methodology.communication.escalateOn.includes("cross-agent-handoff"));
assert.strictEqual(configurableTesting.methodology.family, "validation-and-testing");
assert(configurableTesting.methodology.invariants.includes("coverage-is-not-acceptance"));
assert.strictEqual(configurableTesting.definition.spec.inputs.riskProfile.required, true);
assert.strictEqual(configurableTesting.definition.spec.inputs.timeBudgetMinutes.default, "60");
assert(configurableTesting.definition.spec.nodes.some(node => node.nodeId === "select-security"));
assert(configurableTesting.definition.spec.nodes.some(node => node.nodeId === "test-simulation"));
assert(configurableTesting.definition.spec.nodes.some(node => node.nodeId === "test-ui"));
assert(configurableTesting.definition.spec.nodes.some(node => node.nodeId === "test-full-e2e"));
assert.strictEqual(configurableTesting.definition.spec.completion.requiredNodes[0], "independent-acceptance");
assert.deepStrictEqual(closedLoopCommunication.definition.spec.nodes.find(node => node.nodeId === "assess-assurance").control.cases, [
  "confirmed-read-back", "direct", "high-assurance-contract", "structured-acknowledgement"
]);
assert.strictEqual(compileRecipeMethodologyV1({
  ...universalUnknownTask.methodology,
  unexpected: true
}).ok, false, "Methodology compiler rejects unknown fields");
const childMethodology = compileRecipeMethodologyV1({
  ...closedLoopCommunication.methodology,
  family: "confirmed-handoff",
  extends: {
    recipeId: universalUnknownTask.recipeId,
    revision: universalUnknownTask.revision,
    executableDigest: universalUnknownTask.executableDigest
  },
  communication: {
    minimumAssurance: "confirmed-read-back",
    escalateOn: ["cross-agent-handoff"]
  }
});
assert(childMethodology.ok);
const resolvedMethodology = resolveRecipeMethodology({
  recipeId: "recipe_child",
  revision: 1,
  executableDigest: "f".repeat(64),
  methodology: childMethodology.model
}, recipeId => recipeId === universalUnknownTask.recipeId ? universalUnknownTask : undefined);
assert.strictEqual(resolvedMethodology.methodology.communication.minimumAssurance, "confirmed-read-back");
assert(resolvedMethodology.methodology.invariants.includes("evidence-before-acceptance"));
assert.deepStrictEqual(resolvedMethodology.lineage.map(reference => reference.recipeId), [
  universalUnknownTask.recipeId, "recipe_child"
]);
assert.match(resolvedMethodology.methodologyDigest, /^[a-f0-9]{64}$/);
for (const builtIn of state.recipes.filter(recipe => recipe.category === "Software Development")) {
  assert.strictEqual(builtIn.scope, "global");
  assert.strictEqual(builtIn.category, "Software Development");
  assert.strictEqual(builtIn.systemKind, "built-in");
  assert.strictEqual(builtIn.definition.spec.nodes.length, 5);
  assert(builtIn.definition.spec.nodes.every(node => node.generalInstruction?.length > 80), `${builtIn.name} modules must define specific Intent guidance`);
  assert.match(builtIn.executableDigest, /^[a-f0-9]{64}$/);
}
const staleBuiltIns = JSON.parse(JSON.stringify(state));
const staleSoftwareRecipe = staleBuiltIns.recipes.find(recipe => recipe.name === "Software Development");
staleSoftwareRecipe.executableDigest = "0".repeat(64);
staleSoftwareRecipe.editorLayout = { nodePositions: { understand: { x: 12, y: 24 }, removed: { x: 48, y: 96 } } };
staleSoftwareRecipe.nodeBindings = [
  { nodeId: "understand", bindings: [{ bindingId: "keep", kind: "skill", knowledgeId: "kept", contentHash: "1".repeat(64), usage: "reference" }] },
  { nodeId: "removed", bindings: [{ bindingId: "drop", kind: "note", knowledgeId: "orphaned", contentHash: "2".repeat(64), usage: "required" }] }
];
const upgradedBuiltIns = initializeProjectModel(staleBuiltIns);
const upgradedSoftwareRecipe = upgradedBuiltIns.recipes.find(recipe => recipe.name === "Software Development");
assert.strictEqual(upgradedSoftwareRecipe.revision, staleSoftwareRecipe.revision + 1);
assert.notStrictEqual(upgradedSoftwareRecipe.executableDigest, staleSoftwareRecipe.executableDigest);
assert.deepStrictEqual(upgradedSoftwareRecipe.editorLayout.nodePositions, { understand: { x: 12, y: 24 } });
assert.deepStrictEqual(upgradedSoftwareRecipe.nodeBindings.map(binding => binding.nodeId), ["understand"]);
const pkmTutorial = state.recipes.find(recipe => recipe.name === "PKM Tutorial");
assert.strictEqual(pkmTutorial.category, "Examples/PKM");
assert.deepStrictEqual(pkmTutorial.definition.spec.nodes.map(node => node.nodeId), ["find-relevant-guidance", "synthesize-answer", "understand-question", "validate-guidance"]);
assert(pkmTutorial.definition.spec.nodes.every(node => node.generalInstruction?.startsWith("Brief:")));
assert.deepStrictEqual(pkmTutorial.definition.spec.nodes.find(node => node.nodeId === "validate-guidance").control, {
  mode: "branch", kind: "switch", cases: ["known", "unknown", "validated"]
});
const executableExamples = state.recipes.find(recipe => recipe.name === "Executable Module Examples");
assert.strictEqual(executableExamples.category, "Examples/Modules");
assert.deepStrictEqual(new Set(executableExamples.definition.spec.nodes.map(node => node.kind)), new Set([
  "pkm.step.command/v1", "pkm.step.script/v1", "pkm.gate.human/v1"
]));
assert.deepStrictEqual(executableExamples.definition.spec.nodes.filter(node => node.kind === "pkm.step.script/v1").map(node => node.config.runtime).sort(), ["bash", "python"]);
assert.match(executableExamples.definition.spec.nodes.find(node => node.config?.runtime === "python").generalInstruction, /replace analysis-env/);
const createAgentSnapshot = state.recipes.find(recipe => recipe.name === "Create Agent Snapshot");
assert.strictEqual(createAgentSnapshot.category, "System/PKM/Agent Sessions");
assert.strictEqual(createAgentSnapshot.systemKind, "built-in");
assert.strictEqual(createAgentSnapshot.revision, 2);
assert.strictEqual(createAgentSnapshot.definition.spec.nodes[0].kind, "pkm.step.native/v1");
assert.strictEqual(createAgentSnapshot.definition.spec.nodes[0].config.operation, "agent_session_snapshot_create");
const builtInInventory = builtInRecipeInventory();
assert.strictEqual(builtInInventory.length, state.recipes.filter(recipe => recipe.systemKind === "built-in").length);
assert(builtInInventory.every(recipe => recipe.systemKind === "built-in"));
assert(builtInInventory.every(recipe => JSON.stringify(recipe.tags) === JSON.stringify(["System"])));
assert.deepStrictEqual(
  builtInInventory.find(recipe => recipe.key === "create-agent-snapshot"),
  {
    key: "create-agent-snapshot",
    recipeId: createAgentSnapshot.recipeId,
    name: createAgentSnapshot.name,
    category: createAgentSnapshot.category,
    revision: createAgentSnapshot.revision,
    executableDigest: createAgentSnapshot.executableDigest,
    systemKind: "built-in",
    tags: ["System"],
  },
);
assert.deepStrictEqual(createAgentSnapshot.metadata.requiredInputs.map(input => input.name), ["reason", "stateJson"]);
assert.deepStrictEqual(createAgentSnapshot.metadata.expectedOutputs.map(output => output.name), ["snapshot", "recoveryPrompt"]);
const controlExamples = state.recipes.find(recipe => recipe.name === "Branch and Repeat Module Examples");
assert.strictEqual(controlExamples.definition.spec.nodes.find(node => node.nodeId === "repeat-bounded-check").control.mode, "repeat");
assert.strictEqual(controlExamples.definition.spec.nodes.find(node => node.nodeId === "select-strategy").control.mode, "branch");
const dlisExample = state.recipes.find(recipe => recipe.name === "DLIS Offline Job Log Diagnosis Example");
assert.strictEqual(dlisExample.category, "Examples/Diagnostics");
assert.deepStrictEqual(new Set(dlisExample.definition.spec.nodes.map(node => node.kind)), new Set([
  "pkm.gate.human/v1", "pkm.step.command/v1", "pkm.step.script/v1", "pkm.step.noop/v1"
]));
assert.match(dlisExample.description, /sanitized offline job\.log/);
assert.match(dlisExample.definition.spec.nodes.find(node => node.nodeId === "report-diagnosis").generalInstruction, /Do not claim/);
assert.match(pkmTutorial.definition.spec.nodes.find(node => node.nodeId === "find-relevant-guidance").generalInstruction, /System\/PKM\/PKM Skills/);
assert.match(pkmTutorial.definition.spec.nodes.find(node => node.nodeId === "synthesize-answer").generalInstruction, /explicitly say that the answer is not known/);
const reflection = state.recipes.find(recipe => recipe.name === "Reflection");
assert.strictEqual(reflection.category, "Learning & Improvement");
assert.deepStrictEqual(reflection.definition.spec.nodes.map(node => node.nodeId), ["find-related-skills", "maintain-skills", "reflect-on-outcome"]);
assert.match(reflection.definition.spec.nodes.find(node => node.nodeId === "maintain-skills").generalInstruction, /skill_feedback/);
assert.match(reflection.definition.spec.nodes.find(node => node.nodeId === "maintain-skills").generalInstruction, /Propose a Skill update only/);
const evidenceRecipe = state.recipes.find(recipe => recipe.name === "Evolve Recipes from Evidence");
assert.strictEqual(evidenceRecipe.category, "Learning & Improvement");
assert.strictEqual(evidenceRecipe.systemKind, "built-in");
assert.deepStrictEqual(evidenceRecipe.definition.spec.nodes.map(node => node.nodeId), ["assess-reusable-pattern", "propose-reviewable-change", "search-recipe-library", "summarize-work-and-evidence"]);
assert.match(evidenceRecipe.definition.spec.nodes.find(node => node.nodeId === "search-recipe-library").generalInstruction, /recipe_search before proposing any Recipe/);
assert.match(evidenceRecipe.definition.spec.nodes.find(node => node.nodeId === "assess-reusable-pattern").generalInstruction, /one-off, unstable, speculative/);
assert.match(evidenceRecipe.definition.spec.nodes.find(node => node.nodeId === "assess-reusable-pattern").generalInstruction, /Prefer updating or extending/);
assert.match(evidenceRecipe.definition.spec.nodes.find(node => node.nodeId === "propose-reviewable-change").generalInstruction, /Only when no close Recipe qualifies and recurrence, stable inputs and outputs/);
assert.match(evidenceRecipe.definition.spec.nodes.find(node => node.nodeId === "propose-reviewable-change").generalInstruction, /return no Recipe change/);
const useRecipeLibrary = state.recipes.find(recipe => recipe.name === "Use Recipe Library");
assert.strictEqual(useRecipeLibrary.category, "System/PKM");
assert.deepStrictEqual(useRecipeLibrary.definition.spec.nodes.map(node => node.nodeId), ["establish-task-contract", "execute-and-report", "search-and-qualify", "start-pinned-run", "validate-and-reflect"]);
assert.match(useRecipeLibrary.definition.spec.nodes.find(node => node.nodeId === "search-and-qualify").generalInstruction, /never force a weak match/);
assert.match(useRecipeLibrary.definition.spec.nodes.find(node => node.nodeId === "start-pinned-run").generalInstruction, /expected_revision and expected_digest/);
assert.match(useRecipeLibrary.definition.spec.nodes.find(node => node.nodeId === "execute-and-report").generalInstruction, /Never report unverified work as succeeded/);
assert.match(useRecipeLibrary.definition.spec.nodes.find(node => node.nodeId === "validate-and-reflect").generalInstruction, /Reflection Recipe/);
const releaseRecipeId = `recipe_${createHash("sha256").update("pkm/built-in-recipe/v1\0publish-personal-knowledge-vsix", "utf8").digest("hex").slice(0, 32)}`;
const staleReleaseRecipe = {
  ...JSON.parse(JSON.stringify(state.recipes[0])),
  recipeId: releaseRecipeId,
  name: "Publish Personal Knowledge VSIX",
  category: "Release/VS Code",
  systemKind: "built-in",
  executableDigest: "0".repeat(64)
};
const userReleaseRecipe = {
  ...JSON.parse(JSON.stringify(state.recipes[0])),
  recipeId: "recipe_user_release",
  name: "Publish Personal Knowledge VSIX",
  category: "Release/VS Code"
};
delete userReleaseRecipe.systemKind;
const releaseUpgrade = initializeProjectModel({
  ...state,
  recipes: state.recipes.filter(recipe => recipe.recipeId !== releaseRecipeId).concat(staleReleaseRecipe, userReleaseRecipe)
});
const releaseRecipe = releaseUpgrade.recipes.find(recipe => recipe.recipeId === releaseRecipeId);
assert.notStrictEqual(releaseRecipe.executableDigest, staleReleaseRecipe.executableDigest,
  "upgrades must restore the current protected built-in release Recipe");
assert.strictEqual(releaseRecipe.definition.spec.nodes.find(node => node.nodeId === "ask-user-input").kind, "pkm.gate.human/v1");
assert.strictEqual(releaseRecipe.definition.spec.nodes.find(node => node.nodeId === "ask-user-input").config.inputKind, "approval");
assert.match(releaseRecipe.definition.spec.nodes.find(node => node.nodeId === "ask-user-input").generalInstruction, /submitted user input/);
assert.match(releaseRecipe.definition.spec.nodes.find(node => node.nodeId === "dispatch-publish-workflow").generalInstruction, /Only after/);
assert(releaseUpgrade.recipes.some(recipe => recipe.recipeId === userReleaseRecipe.recipeId),
  "upgrades must preserve user-created Recipes even when they use the release Recipe name");
const userEvidenceRecipe = { ...JSON.parse(JSON.stringify(evidenceRecipe)), recipeId: "recipe_user_evidence" };
delete userEvidenceRecipe.systemKind;
const evidenceUpgrade = initializeProjectModel({
  ...state,
  recipes: state.recipes.filter(recipe => recipe.recipeId !== evidenceRecipe.recipeId).concat(userEvidenceRecipe)
});
assert.strictEqual(evidenceUpgrade.recipes.filter(recipe => recipe.name === "Evolve Recipes from Evidence").length, 2,
  "seeding the protected built-in must preserve a user-created Recipe with the same name");
assert(evidenceUpgrade.recipes.some(recipe => recipe.recipeId === userEvidenceRecipe.recipeId && !recipe.systemKind));
const bugFix = state.recipes.find(recipe => recipe.name === "Bug Fix");
assert.deepStrictEqual(bugFix.definition.spec.completion.requiredNodes, ["report"]);
assert.deepStrictEqual(bugFix.definition.spec.nodes.find(node => node.nodeId === "fix").dependsOn.map(dependency => dependency.from), ["investigate"]);
assert.strictEqual(state.audit.length, 2);
const defaultProject = state.projects[0];
assert.strictEqual(defaultProject.projectId, deriveSystemId(state.rootId, "pkm/default-project/v1"));
assert.strictEqual(state.threads[0].threadId, deriveSystemId(defaultProject.projectId, "pkm/general-thread/v1"));
assert.deepStrictEqual(ensureSystemEntities(state), state);

const emptyRecovered = initializeProjectModel({ schema: 1, migrations: [], audit: [] }, () => "recovered");
assert.strictEqual(emptyRecovered.rootId, "root_recovered");
const bareRecovered = initializeProjectModel({ schema: 1 }, () => "bare");
assert.strictEqual(bareRecovered.rootId, "root_bare");
const metadataRecovered = initializeProjectModel({ schema: 1, migrations: [{ legacyIdentity: "kept", state: "pending" }], audit: [{ event: "kept", entityId: "kept" }] }, () => "metadata");
assert.strictEqual(metadataRecovered.migrations[0].legacyIdentity, "kept");
assert.strictEqual(metadataRecovered.audit[0].event, "kept");
const randomRoot = initializeProjectModel(undefined);
assert.match(randomRoot.rootId, /^root_[0-9a-f-]{36}$/);
const restoredDefaults = initializeProjectModel({ schema: 1, rootId: "root_existing" });
assert.strictEqual(restoredDefaults.projects.length, 1);
assert.strictEqual(restoredDefaults.recipes.length, 15);
const restoredComplete = initializeProjectModel(state);
assert.deepStrictEqual(restoredComplete, state);
errorCode(() => initializeProjectModel({ schema: 1, projects: [{ projectId: "p", name: "P", version: 1 }] }), "root-identity-missing");
errorCode(() => initializeProjectModel({ schema: 1, threads: [{ threadId: "t", projectId: "p", name: "T", description: "", archived: false, legacyAliases: [], version: 1 }] }), "root-identity-missing");
errorCode(() => ensureSystemEntities({ ...state, projects: [...state.projects, { ...defaultProject }] }), "system-project-conflict");
errorCode(() => ensureSystemEntities({ ...state, projects: [{ ...defaultProject, projectId: "wrong" }] }), "system-project-conflict");
errorCode(() => ensureSystemEntities({ ...state, threads: [...state.threads, { ...state.threads[0] }] }), "system-thread-conflict");
errorCode(() => ensureSystemEntities({ ...state, threads: [{ ...state.threads[0], threadId: "wrong" }] }), "system-thread-conflict");

errorCode(() => createProject(state, "  "), "project-name-required");
errorCode(() => createProject({ ...state, projects: [...state.projects, { projectId: "project_dup", name: "D", version: 1 }] }, "P", () => "dup"), "identity-conflict");
state = createProject(state, " Project A ", () => "a");
const randomProjectState = createProject(state, "Random Project");
assert.match(randomProjectState.projects.at(-1).projectId, /^project_[0-9a-f-]{36}$/);
const projectA = state.projects.find(project => project.name === "Project A");
assert(projectA);
assert(state.threads.some(thread => thread.projectId === projectA.projectId && thread.systemKind === "general-thread"));

errorCode(() => createThread(state, "missing", "Topic"), "project-not-found");
errorCode(() => createThread(state, projectA.projectId, " "), "thread-name-required");
errorCode(() => createThread({ ...state, threads: [...state.threads, { threadId: "thread_dup", projectId: projectA.projectId, name: "D", description: "", archived: false, legacyAliases: [], version: 1 }] }, projectA.projectId, "Topic", () => "dup"), "identity-conflict");
state = createThread(state, projectA.projectId, " Topic ", () => "topic");
const randomThreadState = createThread(state, projectA.projectId, "Random Thread");
assert.match(randomThreadState.threads.at(-1).threadId, /^thread_[0-9a-f-]{36}$/);
const topic = state.threads.find(thread => thread.name === "Topic");
assert(topic);

errorCode(() => createRecipe(state, { kind: "project", projectId: "missing" }, "Recipe"), "project-not-found");
errorCode(() => createRecipe(state, { kind: "project", projectId: projectA.projectId }, " "), "recipe-name-required");
state = createRecipe(state, { kind: "project", projectId: projectA.projectId }, " First Recipe ", () => "first");
const recipe = state.recipes.find(candidate => candidate.recipeId === "recipe_first");
assert(recipe);
assert.strictEqual(recipe.scope, "project");
assert.strictEqual(recipe.projectId, projectA.projectId);
assert.strictEqual(recipe.name, "First Recipe");
assert.strictEqual(recipe.revision, 1);
assert.strictEqual(recipe.definition.schema, "pkm.workflow.definition/v1");
assert.deepStrictEqual(recipe.definition.spec.completion.requiredNodes, ["start"]);
assert.match(recipe.executableDigest, /^[a-f0-9]{64}$/);
state = createRecipe(state, { kind: "global" }, " Universal Recipe ", () => "universal");
const globalRecipe = state.recipes.find(candidate => candidate.recipeId === "recipe_universal");
assert(globalRecipe);
assert.strictEqual(globalRecipe.scope, "global");
assert.strictEqual(globalRecipe.projectId, undefined);
errorCode(() => deleteRecipe(state, reflection.recipeId), "system-recipe-delete");
const originalDigest = globalRecipe.executableDigest;
state = updateRecipe(state, globalRecipe.recipeId, {
  name: " Universal Recipe v2 ", category: "Automation/Review", description: " Updated description ",
  metadata: {
    applicableFunctions: [" Review ", "Review", "Delivery"], solution: " Inspect and report. ",
    requiredInputs: [{ name: " change ", description: " Diff to inspect. ", required: true }, { name: "", description: "ignored" }],
    expectedOutputs: [{ name: " report ", description: " Findings. " }]
  },
  editorLayout: { nodePositions: { start: { x: 20.4, y: 30.6 }, finish: { x: 400, y: 50 }, missing: { x: 1, y: 2 } } },
  definition: {
    ...globalRecipe.definition,
    spec: {
      ...globalRecipe.definition.spec,
      nodes: [...globalRecipe.definition.spec.nodes, { nodeId: "finish", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
      completion: { requiredNodes: ["finish", "start"] }
    }
  }
});
const updatedGlobalRecipe = state.recipes.find(candidate => candidate.recipeId === globalRecipe.recipeId);
assert.strictEqual(updatedGlobalRecipe.name, "Universal Recipe v2");
assert.strictEqual(updatedGlobalRecipe.category, "Automation/Review");
assert.strictEqual(updatedGlobalRecipe.description, "Updated description");
assert.deepStrictEqual(updatedGlobalRecipe.metadata, {
  applicableFunctions: ["Review", "Delivery"], solution: "Inspect and report.",
  requiredInputs: [{ name: "change", description: "Diff to inspect.", required: true }],
  expectedOutputs: [{ name: "report", description: "Findings." }]
});
assert.deepStrictEqual(updatedGlobalRecipe.editorLayout, { nodePositions: { start: { x:20, y:31 }, finish: { x:400, y:50 } } });
assert.strictEqual(updatedGlobalRecipe.revision, 2);
assert.notStrictEqual(updatedGlobalRecipe.executableDigest, originalDigest);
const synchronizedRecipe = {
  ...updatedGlobalRecipe,
  name: " Synchronized Recipe ",
  description: " Remote definition ",
  revision: 7,
  executableDigest: "stale"
};
const synchronizedState = replaceRecipeFromSync(state, synchronizedRecipe);
const synchronizedRecord = synchronizedState.recipes.find(candidate => candidate.recipeId === synchronizedRecipe.recipeId);
assert.strictEqual(synchronizedRecord.name, "Synchronized Recipe");
assert.strictEqual(synchronizedRecord.description, "Remote definition");
assert.strictEqual(synchronizedRecord.revision, 7, "GitHub reconciliation preserves the synchronized revision");
assert.strictEqual(synchronizedRecord.executableDigest, updatedGlobalRecipe.executableDigest, "GitHub reconciliation repairs derived executable identity");
assert.strictEqual(synchronizedState.audit.at(-1).event, "recipe-synchronized");
errorCode(() => replaceRecipeFromSync(state, { ...synchronizedRecipe, scope: "project", projectId: "missing" }), "recipe-sync-project-missing");
const updatedDigest = updatedGlobalRecipe.executableDigest;
state = updateRecipe(state, updatedGlobalRecipe.recipeId, {
  name:updatedGlobalRecipe.name, category:updatedGlobalRecipe.category, description:updatedGlobalRecipe.description,
  metadata:updatedGlobalRecipe.metadata, editorLayout:{ nodePositions:{ start:{ x:80, y:90 }, finish:{ x:500, y:120 } } }, definition:updatedGlobalRecipe.definition
});
assert.strictEqual(state.recipes.find(candidate => candidate.recipeId === updatedGlobalRecipe.recipeId).executableDigest, updatedDigest, "layout-only edits do not change executable identity");
const layoutUpdatedRecipe = state.recipes.find(candidate => candidate.recipeId === updatedGlobalRecipe.recipeId);
state = updateRecipe(state, layoutUpdatedRecipe.recipeId, {
  name: layoutUpdatedRecipe.name, category: layoutUpdatedRecipe.category, description: layoutUpdatedRecipe.description,
  metadata: layoutUpdatedRecipe.metadata, editorLayout: layoutUpdatedRecipe.editorLayout,
  methodology: universalUnknownTask.methodology, definition: layoutUpdatedRecipe.definition
});
const methodologyUpdatedRecipe = state.recipes.find(candidate => candidate.recipeId === updatedGlobalRecipe.recipeId);
assert.strictEqual(methodologyUpdatedRecipe.executableDigest, updatedDigest, "methodology-only edits do not change executable identity");
assert.strictEqual(methodologyUpdatedRecipe.methodology.family, "universal-unknown-task");
assert.match(methodologyUpdatedRecipe.methodologyDigest, /^[a-f0-9]{64}$/);
errorCode(() => updateRecipe(state, globalRecipe.recipeId, {
  name: methodologyUpdatedRecipe.name, category: methodologyUpdatedRecipe.category,
  description: methodologyUpdatedRecipe.description, definition: methodologyUpdatedRecipe.definition,
  methodology: { ...universalUnknownTask.methodology, surprise: true }
}), "recipe-methodology-invalid");
errorCode(() => updateRecipe(state, "missing", { name: "Missing", category: "", description: "", definition: globalRecipe.definition }), "recipe-not-found");
errorCode(() => updateRecipe(state, globalRecipe.recipeId, { name: " ", category: "", description: "", definition: globalRecipe.definition }), "recipe-name-required");
errorCode(() => updateRecipe(state, globalRecipe.recipeId, { name: "Bad", category: "", description: "", definition: { schema: "bad", spec: {} } }), "recipe-definition-invalid");
errorCode(() => createRecipe(state, { kind: "global" }, "Duplicate identity", () => "first"), "identity-conflict");
state = createRecipeFolder(state, "Automation/Review", "Deep / Validation");
assert.deepStrictEqual(state.recipeFolders, ["Automation", "Automation/Review", "Automation/Review/Deep", "Automation/Review/Deep/Validation"]);
assert.strictEqual(state.audit.at(-1).event, "recipe-folder-created");
errorCode(() => createRecipeFolder(state, "Automation/Review", "Deep/Validation"), "recipe-folder-exists");
errorCode(() => createRecipeFolder(state, "", "../Invalid"), "recipe-folder-path-invalid");
state = deleteRecipeFolder(state, "Automation / Review");
assert.strictEqual(state.recipes.find(candidate => candidate.recipeId === globalRecipe.recipeId).category, "Automation");
assert.strictEqual(state.recipes.find(candidate => candidate.recipeId === globalRecipe.recipeId).revision, updatedGlobalRecipe.revision + 3);
assert.deepStrictEqual(state.recipeFolders, ["Automation", "Automation/Deep", "Automation/Deep/Validation"]);
assert.strictEqual(state.audit.at(-1).event, "recipe-folder-deleted");
errorCode(() => deleteRecipeFolder(state, "Automation/Review"), "recipe-folder-not-found");
state = deleteRecipe(state, recipe.recipeId);
assert(!state.recipes.some(candidate => candidate.recipeId === recipe.recipeId));
assert.strictEqual(state.audit.at(-1).event, "recipe-deleted");
state = moveRecipeToTrash(state, globalRecipe.recipeId, "2026-09-22T00:00:00.000Z");
assert(!state.recipes.some(candidate => candidate.recipeId === globalRecipe.recipeId));
assert.strictEqual(state.recipeTrash.find(candidate => candidate.recipeId === globalRecipe.recipeId).trashedAt, "2026-09-22T00:00:00.000Z");
assert.strictEqual(state.recipeTrash.find(candidate => candidate.recipeId === globalRecipe.recipeId).methodology.family, "universal-unknown-task");
state = restoreRecipeFromTrash(state, globalRecipe.recipeId);
assert.strictEqual(state.recipes.find(candidate => candidate.recipeId === globalRecipe.recipeId).methodology.family, "universal-unknown-task");
state = moveRecipeToTrash(state, globalRecipe.recipeId, "2026-09-22T00:00:01.000Z");
state = deleteRecipeFromTrash(state, globalRecipe.recipeId);
assert(!state.recipeTrash.some(candidate => candidate.recipeId === globalRecipe.recipeId));

const journalSeed = { ...state, migrations: [{ legacyIdentity: "kept", state: "pending" }] };
const deferred = migrateLegacyRoom(journalSeed, { identity: "legacy-active", roomId: "room-active", name: "Active", active: true });
assert.deepStrictEqual(deferred.migrations.at(-1), { legacyIdentity: "legacy-active", state: "pending", error: "active-room-deferred" });
const completedDeferred = migrateLegacyRoom(deferred, { identity: "legacy-active", roomId: "room-active", name: "Active" });
assert.strictEqual(completedDeferred.migrations.find(entry => entry.legacyIdentity === "legacy-active").state, "completed");
assert.strictEqual(completedDeferred.migrations.find(entry => entry.legacyIdentity === "kept").state, "pending");
const reused = migrateLegacyRoom(completedDeferred, { identity: "legacy-reused", roomId: "room_123", name: " Room " });
assert.strictEqual(resolveThreadId(reused, "room_123"), "room_123");
const allocated = migrateLegacyRoom(reused, { identity: "legacy-invalid", roomId: "bad id", name: "" }, () => "new");
assert.strictEqual(resolveThreadId(allocated, "legacy-invalid"), "thread_new");
assert.strictEqual(allocated.threads.find(thread => thread.threadId === "thread_new").name, "Legacy Thread");
assert.strictEqual(migrateLegacyRoom(allocated, { identity: "legacy-invalid", name: "ignored" }), allocated);
const identityConflict = migrateLegacyRoom(allocated, { identity: "conflict", roomId: topic.threadId, name: "Conflict" }, () => "topic");
assert.strictEqual(identityConflict.migrations.at(-1).error, "thread-identity-conflict");
const aliasConflictState = { ...allocated, migrations: [], threads: allocated.threads.map(thread => thread.threadId === topic.threadId ? { ...thread, legacyAliases: ["alias"] } : thread) };
const aliasConflict = migrateLegacyRoom(aliasConflictState, { identity: "alias", name: "Alias" }, () => "alias-new");
assert.strictEqual(aliasConflict.migrations[0].error, "legacy-alias-conflict");

errorCode(() => moveThread(state, { threadId: "missing", destinationProjectId: defaultProject.projectId, linkedActiveRunIds: [], includedRunIds: [], audienceChanges: false, audienceChangeConfirmed: false }), "thread-not-found");
errorCode(() => moveThread(state, { threadId: state.threads.find(thread => thread.projectId === projectA.projectId && thread.systemKind === "general-thread").threadId, destinationProjectId: defaultProject.projectId, linkedActiveRunIds: [], includedRunIds: [], audienceChanges: false, audienceChangeConfirmed: false }), "system-thread-move-forbidden");
errorCode(() => moveThread(state, { threadId: topic.threadId, destinationProjectId: "missing", linkedActiveRunIds: [], includedRunIds: [], audienceChanges: false, audienceChangeConfirmed: false }), "project-not-found");
errorCode(() => moveThread(state, { threadId: topic.threadId, destinationProjectId: defaultProject.projectId, linkedActiveRunIds: ["run-1"], includedRunIds: [], audienceChanges: false, audienceChangeConfirmed: false }), "active-run-move-blocked");
errorCode(() => moveThread(state, { threadId: topic.threadId, destinationProjectId: defaultProject.projectId, linkedActiveRunIds: [], includedRunIds: [], audienceChanges: true, audienceChangeConfirmed: false }), "audience-confirmation-required");
assert.strictEqual(moveThread(state, { threadId: topic.threadId, destinationProjectId: projectA.projectId, linkedActiveRunIds: [], includedRunIds: [], audienceChanges: false, audienceChangeConfirmed: false }), state);
const moved = moveThread(state, { threadId: topic.threadId, destinationProjectId: defaultProject.projectId, linkedActiveRunIds: ["run-1"], includedRunIds: ["run-1"], audienceChanges: true, audienceChangeConfirmed: true });
assert.strictEqual(moved.threads.find(thread => thread.threadId === topic.threadId).projectId, defaultProject.projectId);
assert.strictEqual(moved.threads.find(thread => thread.threadId === topic.threadId).version, 2);
assert.strictEqual(resolveThreadId(moved, "unknown"), undefined);

const renamed = renameThread(state, topic.threadId, "Delivery Plan");
assert.strictEqual(renamed.threads.find(thread => thread.threadId === topic.threadId).threadId, topic.threadId);
assert.strictEqual(renamed.threads.find(thread => thread.threadId === topic.threadId).version, 2);
errorCode(() => renameThread(state, state.threads.find(thread => thread.systemKind === "general-thread").threadId, "Renamed"), "system-thread-rename-forbidden");
const linked = linkThreadChatroom(renamed, topic.threadId, { roomId:"room_thread_1", roomName:"Alpha · Delivery Plan", linkedAt:"2026-09-27T00:00:00.000Z" });
assert.strictEqual(linked.threads.find(thread => thread.threadId === topic.threadId).chatroom.roomId, "room_thread_1");
errorCode(() => linkThreadChatroom(linked, linked.threads.find(thread => thread.threadId !== topic.threadId).threadId,
  { roomId:"room_thread_1", roomName:"Duplicate", linkedAt:"2026-09-27T00:00:00.000Z" }), "chatroom-already-linked");

let gantt = createGanttTask(linked, projectA.projectId, {
  threadId:topic.threadId, title:"Design", startDate:"2026-09-27", endDate:"2026-09-28", progress:25,
  status:"in-progress", owners:[{ name:"Alex", role:"Owner" }], dependencyIds:[]
}, () => "design");
gantt = createGanttTask(gantt, projectA.projectId, {
  title:"Ship", startDate:"2026-09-29", endDate:"2026-09-30", progress:0, status:"not-started",
  owners:[], dependencyIds:["task_design"]
}, () => "ship");
assert.deepStrictEqual(gantt.ganttTasks.map(task => task.taskId), ["task_design", "task_ship"]);
errorCode(() => createGanttTask(gantt, projectA.projectId, {
  title:"Bad date", startDate:"2026-02-30", endDate:"2026-03-01", progress:0, status:"not-started"
}), "gantt-date-invalid");
errorCode(() => updateGanttTask(gantt, "task_design", {
  title:"Design", startDate:"2026-09-27", endDate:"2026-09-28", progress:50, status:"in-progress",
  dependencyIds:["task_ship"]
}), "gantt-dependency-cycle");
errorCode(() => deleteGanttTask(gantt, "task_design"), "gantt-task-dependency-in-use");
gantt = updateGanttTask(gantt, "task_ship", {
  title:"Ship", startDate:"2026-09-29", endDate:"2026-10-01", progress:100, status:"completed", dependencyIds:[]
});
gantt = deleteGanttTask(gantt, "task_design");
assert.deepStrictEqual(gantt.ganttTasks.map(task => task.taskId), ["task_ship"]);

const repaired = ensureSystemEntities({ ...state, projects: state.projects.filter(project => !project.systemKind), threads: state.threads.filter(thread => !thread.systemKind) });
assert(repaired.projects.some(project => project.systemKind === "default-project"));
assert(repaired.threads.some(thread => thread.systemKind === "general-thread"));
console.log("workflow project model test: identity, recovery, migration, and movement contracts OK");