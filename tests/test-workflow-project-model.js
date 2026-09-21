#!/usr/bin/env node
const assert = require("assert");
const {
  ProjectModelError, createProject, createThread, deriveSystemId, ensureSystemEntities,
  initializeProjectModel, migrateLegacyRoom, moveThread, resolveThreadId
} = require("../dist/workflows/project-model.js");

const errorCode = (action, code) => assert.throws(action, error => error instanceof ProjectModelError && error.code === code);
let state = initializeProjectModel(undefined, () => "root-seed");
assert.strictEqual(state.rootId, "root_root-seed");
assert.strictEqual(state.projects.length, 1);
assert.strictEqual(state.threads.length, 1);
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