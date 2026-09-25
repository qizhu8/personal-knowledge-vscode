#!/usr/bin/env node
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { canonicalJson } = require("../dist/workflow-contracts.js");
const { PROJECT_STORE_SCHEMA, ProjectStore, ProjectStoreError } = require("../dist/workflows/project-store.js");
const { ProjectModelError } = require("../dist/workflows/project-model.js");

const roots = [];
const temporary = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "project-store-"));
  roots.push(directory);
  return directory;
};
const ids = (...values) => {
  let index = 0;
  return () => values[index++] || `id-${index}`;
};
const command = (commandId, expectedStoreVersion, fingerprint = `fp-${commandId}`) => ({ commandId, fingerprint, expectedStoreVersion });
const error = (action, code) => assert.throws(action, value => value instanceof ProjectStoreError && value.code === code);
const file = directory => path.join(directory, "projects.json");
const read = directory => JSON.parse(fs.readFileSync(file(directory), "utf8"));
const write = (directory, value) => fs.writeFileSync(file(directory), JSON.stringify(value));
const resign = envelope => {
  envelope.digest = crypto.createHash("sha256").update(canonicalJson(envelope.payload), "utf8").digest("hex");
  return envelope;
};

try {
  assert.strictEqual(PROJECT_STORE_SCHEMA, 1);
  const directory = temporary();
  const store = new ProjectStore(directory, ids("root", "alpha", "topic", "daily", "universal"));
  const initial = store.list();
  assert.strictEqual(initial.storeVersion, 1);
  assert.strictEqual(initial.rootId, "root_root");
  assert.deepStrictEqual(initial.projects.map(project => [project.name, project.systemKind]), [["Default Project", "default-project"]]);
  assert.deepStrictEqual(initial.threads.map(thread => [thread.name, thread.systemKind]), [["General", "general-thread"]]);
  assert.deepStrictEqual(initial.recipes.map(recipe => recipe.name), ["Software Development", "Bug Fix", "UI Development", "Reflection", "Use Recipe Library", "PKM Tutorial"]);
  assert(initial.recipes.every(recipe => recipe.scope === "global" && recipe.systemKind === "built-in"));
  assert.strictEqual(initial.recipes.find(recipe => recipe.name === "PKM Tutorial").category, "Examples/PKM");
  assert.strictEqual(fs.statSync(file(directory)).mode & 0o777, 0o600);
  initial.projects[0].name = "caller mutation";
  assert.strictEqual(store.list().projects[0].name, "Default Project");

  error(() => store.createProject(null, "No"), "command-invalid");
  error(() => store.createProject(command("", 1), "No"), "command-invalid");
  error(() => store.createProject({ commandId: "x", fingerprint: "", expectedStoreVersion: 1 }, "No"), "command-invalid");
  error(() => store.createProject(command("x", 1.5), "No"), "command-invalid");
  error(() => store.createProject(command("x", -1), "No"), "command-invalid");

  const created = store.createProject(command("create-alpha", 1), " Alpha ");
  assert.strictEqual(created.replayed, false);
  assert.strictEqual(created.snapshot.storeVersion, 2);
  assert.strictEqual(created.entityId, "project_alpha");
  assert.strictEqual(created.snapshot.projects[1].name, "Alpha");
  assert.strictEqual(created.snapshot.threads.filter(thread => thread.projectId === created.entityId)[0].name, "General");
  assert.deepStrictEqual(new ProjectStore(directory).list(), created.snapshot);

  const replay = store.createProject(command("create-alpha", 999), "ignored");
  assert.strictEqual(replay.replayed, true);
  assert.strictEqual(replay.entityId, "project_alpha");
  assert.strictEqual(replay.snapshot.projects.length, 2);
  error(() => store.createProject(command("create-alpha", 2, "different"), "No"), "command-conflict");
  error(() => store.createProject(command("stale", 1), "No"), "store-version-conflict");
  assert.throws(() => store.createProject(command("empty-name", 2), " "), value => value instanceof ProjectModelError && value.code === "project-name-required");

  const thread = store.createThread(command("create-topic", 2), "project_alpha", " Topic ");
  assert.strictEqual(thread.entityId, "thread_topic");
  assert.strictEqual(thread.snapshot.storeVersion, 3);
  assert.throws(() => store.createThread(command("missing-project", 3), "missing", "Thread"), value => value instanceof ProjectModelError && value.code === "project-not-found");
  assert.throws(() => store.createThread(command("empty-thread", 3), "project_alpha", ""), value => value instanceof ProjectModelError && value.code === "thread-name-required");

  const moved = store.moveThread(command("move-topic", 3), {
    threadId: "thread_topic", destinationProjectId: initial.projects[0].projectId,
    linkedActiveRunIds: [], includedRunIds: [], audienceChanges: false, audienceChangeConfirmed: false
  });
  assert.strictEqual(moved.snapshot.storeVersion, 4);
  assert.strictEqual(moved.snapshot.threads.find(candidate => candidate.threadId === "thread_topic").projectId, initial.projects[0].projectId);
  assert.strictEqual(store.moveThread(command("move-topic", 0), {}).replayed, true);

  const recipe = store.createRecipe(command("create-recipe", 4), { kind: "project", projectId: "project_alpha" }, " Daily Review ");
  assert.strictEqual(recipe.snapshot.storeVersion, 5);
  assert.strictEqual(recipe.entityId, "recipe_daily");
  const createdRecipe = recipe.snapshot.recipes.find(candidate => candidate.recipeId === recipe.entityId);
  assert.strictEqual(createdRecipe.name, "Daily Review");
  assert.strictEqual(createdRecipe.scope, "project");
  assert.strictEqual(createdRecipe.definition.spec.nodes[0].kind, "pkm.step.noop/v1");
  assert.strictEqual(store.createRecipe(command("create-recipe", 0), { kind: "global" }, "ignored").replayed, true);

  const globalRecipe = store.createRecipe(command("create-global-recipe", 5), { kind: "global" }, " Universal Review ");
  assert.strictEqual(globalRecipe.snapshot.storeVersion, 6);
  assert.strictEqual(globalRecipe.entityId, "recipe_universal");
  const createdGlobalRecipe = globalRecipe.snapshot.recipes.find(candidate => candidate.recipeId === globalRecipe.entityId);
  assert.strictEqual(createdGlobalRecipe.scope, "global");
  assert.strictEqual(createdGlobalRecipe.projectId, undefined);
  const updatedRecipe = store.updateRecipe(command("update-global-recipe", 6), createdGlobalRecipe.recipeId, {
    name: "Universal Review v2", category: "Automation/Review", description: "Review changes.",
    definition: createdGlobalRecipe.definition
  });
  assert.strictEqual(updatedRecipe.snapshot.storeVersion, 7);
  assert.strictEqual(updatedRecipe.snapshot.recipes.find(candidate => candidate.recipeId === createdGlobalRecipe.recipeId).revision, 2);
  assert.strictEqual(store.updateRecipe(command("update-global-recipe", 0), createdGlobalRecipe.recipeId, {}).replayed, true);
  const trashedRecipe = store.moveRecipeToTrash(command("trash-daily-recipe", 7), createdRecipe.recipeId);
  assert.strictEqual(trashedRecipe.snapshot.storeVersion, 8);
  assert(!trashedRecipe.snapshot.recipes.some(candidate => candidate.recipeId === createdRecipe.recipeId));
  assert.strictEqual(trashedRecipe.snapshot.recipeTrash[0].recipeId, createdRecipe.recipeId);
  assert.strictEqual(store.moveRecipeToTrash(command("trash-daily-recipe", 0), createdRecipe.recipeId).replayed, true);
  const restoredRecipe = store.restoreRecipeFromTrash(command("restore-daily-recipe", 8), createdRecipe.recipeId);
  assert.strictEqual(restoredRecipe.snapshot.storeVersion, 9);
  assert(restoredRecipe.snapshot.recipes.some(candidate => candidate.recipeId === createdRecipe.recipeId));
  assert.strictEqual(restoredRecipe.snapshot.recipeTrash.length, 0);
  store.moveRecipeToTrash(command("retrash-daily-recipe", 9), createdRecipe.recipeId);
  const deletedRecipe = store.deleteRecipeFromTrash(command("delete-daily-recipe", 10), createdRecipe.recipeId);
  assert.strictEqual(deletedRecipe.snapshot.storeVersion, 11);
  assert(!deletedRecipe.snapshot.recipes.some(candidate => candidate.recipeId === createdRecipe.recipeId));
  assert.strictEqual(deletedRecipe.snapshot.recipeTrash.length, 0);
  assert.strictEqual(store.deleteRecipeFromTrash(command("delete-daily-recipe", 0), createdRecipe.recipeId).replayed, true);

  const importDirectory = temporary();
  const importStore = new ProjectStore(importDirectory, ids("import-root", "forked-copy"));
  const remoteRecipe = {
    ...createdGlobalRecipe, recipeId: "recipe_remote", scope: "project", projectId: "remote-project",
    name: "Remote Release", revision: 7,
  };
  const directImport = importStore.importRecipe(command("direct-import", 1), remoteRecipe, {
    kind: "direct-sync", sourceKey: "remote-machine/overwrite", preserveIdentity: true,
  });
  const directRecipe = directImport.snapshot.recipes.find(candidate => candidate.recipeId === "recipe_remote");
  assert(directRecipe, "Direct Sync must persist a transferred Recipe");
  assert.strictEqual(directRecipe.scope, "global", "portable imports must not retain a dangling remote Project ID");
  assert.deepStrictEqual(directRecipe.origin, {
    kind: "direct-sync", sourceRecipeId: "recipe_remote", sourceKey: "remote-machine/overwrite",
    sourceRevision: 7, sourceScope: "project",
  });
  const directUpdate = importStore.importRecipe(command("direct-update", 2), { ...remoteRecipe, name: "Remote Release v2", revision: 8 }, {
    kind: "direct-sync", sourceKey: "remote-machine/overwrite", preserveIdentity: true,
  });
  assert.strictEqual(directUpdate.entityId, "recipe_remote");
  assert.strictEqual(directUpdate.snapshot.recipes.find(candidate => candidate.recipeId === "recipe_remote").revision, 2);
  assert.strictEqual(directUpdate.snapshot.recipes.find(candidate => candidate.recipeId === "recipe_remote").name, "Remote Release v2");
  assert.throws(() => importStore.importRecipe(command("bad-digest", 3), { ...remoteRecipe, executableDigest: "bad" }, {
    kind: "direct-sync", sourceKey: "other/overwrite", preserveIdentity: true,
  }), value => value instanceof ProjectModelError && value.code === "recipe-import-digest-invalid");
  assert.strictEqual(importStore.list().storeVersion, 3, "rejected imports must not mutate the Project store");
  const forked = importStore.importRecipe(command("subscription-fork", 3), remoteRecipe, {
    kind: "subscription-fork", sourceKey: "alice@host-a/Release Broker/recipe_remote.json",
    preserveIdentity: false, rejectExisting: true, brokerName: "Release Broker", publisherUser: "alice", publisherHost: "host-a",
  });
  assert.strictEqual(forked.entityId, "recipe_forked-copy");
  assert.strictEqual(forked.snapshot.recipes.find(candidate => candidate.recipeId === forked.entityId).origin.brokerName, "Release Broker");
  assert.throws(() => importStore.importRecipe(command("duplicate-fork", 4), remoteRecipe, {
    kind: "subscription-fork", sourceKey: "alice@host-a/Release Broker/recipe_remote.json",
    preserveIdentity: false, rejectExisting: true,
  }), value => value instanceof ProjectModelError && value.code === "recipe-import-conflict");

  const legacyDirectory = temporary();
  new ProjectStore(legacyDirectory, ids("legacy-root")).list();
  const legacy = read(legacyDirectory); delete legacy.payload.state.recipes; write(legacyDirectory, resign(legacy));
  assert.deepStrictEqual(new ProjectStore(legacyDirectory).list().recipes.map(recipe => recipe.name), ["Software Development", "Bug Fix", "UI Development", "Reflection", "Use Recipe Library", "PKM Tutorial"]);

  const malformedDirectory = temporary();
  fs.mkdirSync(malformedDirectory, { recursive: true });
  fs.writeFileSync(file(malformedDirectory), "{");
  error(() => new ProjectStore(malformedDirectory).list(), "store-corrupt");

  for (const change of [
    envelope => { envelope.schema = 2; },
    envelope => { envelope.storeVersion = 0; },
    envelope => { envelope.payload = null; },
    envelope => { envelope.digest = 7; }
  ]) {
    const corruptDirectory = temporary();
    new ProjectStore(corruptDirectory, ids("root")).list();
    const envelope = read(corruptDirectory);
    change(envelope);
    write(corruptDirectory, envelope);
    error(() => new ProjectStore(corruptDirectory).list(), "store-corrupt");
  }

  const digestDirectory = temporary();
  new ProjectStore(digestDirectory, ids("root")).list();
  const badDigest = read(digestDirectory); badDigest.payload.state.rootId = "changed"; write(digestDirectory, badDigest);
  error(() => new ProjectStore(digestDirectory).list(), "store-corrupt");

  const repairDirectory = temporary();
  new ProjectStore(repairDirectory, ids("root")).list();
  const repair = read(repairDirectory); repair.payload.state.projects = []; repair.payload.state.threads = []; write(repairDirectory, resign(repair));
  error(() => new ProjectStore(repairDirectory).list(), "store-repair-required");

  const identityDirectory = temporary();
  new ProjectStore(identityDirectory, ids("root")).list();
  const identity = read(identityDirectory); delete identity.payload.state.rootId; write(identityDirectory, resign(identity));
  assert.throws(() => new ProjectStore(identityDirectory).list(), value => value instanceof ProjectModelError && value.code === "root-identity-missing");

  for (const receipt of [null, { commandId: 1, fingerprint: "f", operation: "op", storeVersion: 1, entityId: "x" }]) {
    const receiptDirectory = temporary();
    new ProjectStore(receiptDirectory, ids("root", "project")).createProject(command("create", 1), "P");
    const envelope = read(receiptDirectory); envelope.payload.receipts[0] = receipt; write(receiptDirectory, resign(envelope));
    error(() => new ProjectStore(receiptDirectory).list(), "store-corrupt");
  }

  const fsyncDirectory = temporary();
  const originalOpen = fs.openSync;
  fs.openSync = (target, flags, mode) => {
    if (target === fsyncDirectory && flags === "r") { const failure = new Error("unsupported"); failure.code = "EINVAL"; throw failure; }
    return originalOpen(target, flags, mode);
  };
  try { assert.strictEqual(new ProjectStore(fsyncDirectory, ids("root")).list().storeVersion, 1); }
  finally { fs.openSync = originalOpen; }

  for (const failure of [null, Object.assign(new Error("denied"), { code: "EACCES" })]) {
    const failureDirectory = temporary();
    fs.openSync = (target, flags, mode) => {
      if (target === failureDirectory && flags === "r") throw failure;
      return originalOpen(target, flags, mode);
    };
    try { assert.throws(() => new ProjectStore(failureDirectory, ids("root")).list(), value => value === failure); }
    finally { fs.openSync = originalOpen; }
  }

  console.log("workflow project store tests passed");
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}