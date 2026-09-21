#!/usr/bin/env node
const assert = require("assert");
const {
  ProjectModelError, createProject, createRecipe, createThread, deriveSystemId, ensureSystemEntities,
  initializeProjectModel, migrateLegacyRoom, moveThread, resolveThreadId, updateRecipe
} = require("../dist/workflows/project-model.js");

const errorCode = (action, code) => assert.throws(action, error => error instanceof ProjectModelError && error.code === code);
let state = initializeProjectModel(undefined, () => "root-seed");
assert.strictEqual(state.rootId, "root_root-seed");
assert.strictEqual(state.projects.length, 1);
assert.strictEqual(state.threads.length, 1);
assert.deepStrictEqual(state.recipes.map(recipe => recipe.name), ["Software Development", "Bug Fix", "UI Development"]);
for (const builtIn of state.recipes) {
  assert.strictEqual(builtIn.scope, "global");
  assert.strictEqual(builtIn.category, "Software Development");
  assert.strictEqual(builtIn.systemKind, "built-in");
  assert.strictEqual(builtIn.definition.spec.nodes.length, 5);
  assert.match(builtIn.executableDigest, /^[a-f0-9]{64}$/);
}
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
assert.strictEqual(restoredDefaults.recipes.length, 3);
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
const updatedDigest = updatedGlobalRecipe.executableDigest;
state = updateRecipe(state, updatedGlobalRecipe.recipeId, {
  name:updatedGlobalRecipe.name, category:updatedGlobalRecipe.category, description:updatedGlobalRecipe.description,
  metadata:updatedGlobalRecipe.metadata, editorLayout:{ nodePositions:{ start:{ x:80, y:90 }, finish:{ x:500, y:120 } } }, definition:updatedGlobalRecipe.definition
});
assert.strictEqual(state.recipes.find(candidate => candidate.recipeId === updatedGlobalRecipe.recipeId).executableDigest, updatedDigest, "layout-only edits do not change executable identity");
errorCode(() => updateRecipe(state, "missing", { name: "Missing", category: "", description: "", definition: globalRecipe.definition }), "recipe-not-found");
errorCode(() => updateRecipe(state, globalRecipe.recipeId, { name: " ", category: "", description: "", definition: globalRecipe.definition }), "recipe-name-required");
errorCode(() => updateRecipe(state, globalRecipe.recipeId, { name: "Bad", category: "", description: "", definition: { schema: "bad", spec: {} } }), "recipe-definition-invalid");
errorCode(() => createRecipe(state, { kind: "global" }, "Duplicate identity", () => "first"), "identity-conflict");

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

const repaired = ensureSystemEntities({ ...state, projects: state.projects.filter(project => !project.systemKind), threads: state.threads.filter(thread => !thread.systemKind) });
assert(repaired.projects.some(project => project.systemKind === "default-project"));
assert(repaired.threads.some(thread => thread.systemKind === "general-thread"));
console.log("workflow project model test: identity, recovery, migration, and movement contracts OK");