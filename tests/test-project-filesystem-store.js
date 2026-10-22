#!/usr/bin/env node
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ProjectStore, ProjectStoreError } = require("../dist/workflows/project-store.js");
const {
  PROJECT_FILESYSTEM_STORE_SCHEMA,
  PROJECT_RECEIPT_LIMIT,
  safeProjectDirectoryName,
} = require("../dist/workflows/project-filesystem-store.js");

const roots = [];
const scratchRoot = path.join(__dirname, ".project-filesystem-store-work");
const temporary = () => {
  fs.mkdirSync(scratchRoot, { recursive: true });
  const root = path.join(scratchRoot, crypto.randomUUID());
  fs.mkdirSync(root);
  roots.push(root);
  return root;
};
const ids = (...values) => {
  let index = 0;
  return () => values[index++] || `generated-${index}`;
};
const command = (commandId, expectedStoreVersion, fingerprint = `fp-${commandId}`) =>
  ({ commandId, fingerprint, expectedStoreVersion });
const expectCode = (action, code) =>
  assert.throws(action, error => error instanceof ProjectStoreError && error.code === code);

try {
  assert.strictEqual(PROJECT_FILESYSTEM_STORE_SCHEMA, 1);
  assert.strictEqual(PROJECT_RECEIPT_LIMIT, 256);
  assert.strictEqual(safeProjectDirectoryName(" CON<>:\"/\\|?* . ", "project_portable"),
    "CON-project.project_portable");
  assert(!safeProjectDirectoryName("Å roadmap", "project_unicode").includes("\\"));

  const root = temporary();
  const stateDirectory = path.join(root, ".pkm", "state");
  const store = new ProjectStore(stateDirectory, ids("root", "unsafe", "thread", "gantt"));
  const initial = store.list();
  const created = store.createProject(command("create-project", initial.storeVersion), "CON: Roadmap.");
  const thread = store.createThread(command("create-thread", created.snapshot.storeVersion), created.entityId, "Delivery");
  const linked = store.linkThreadChatroom(command("link-room", thread.snapshot.storeVersion), thread.entityId, {
    roomId: "room_authoritative",
    roomName: "Cached room name",
    linkedAt: "2026-09-28T00:00:00.000Z",
  });
  const gantt = store.createGanttTask(command("create-gantt", linked.snapshot.storeVersion), created.entityId, {
    threadId: thread.entityId,
    title: "Ship",
    startDate: "2026-09-28",
    endDate: "2026-09-30",
    progress: 10,
    status: "in-progress",
    owners: [{ name: "Owner", role: "Lead" }],
    dependencyIds: [],
  });
  const collaboration = store.createCollaborationTask(
    command("create-collaboration", gantt.snapshot.storeVersion),
    created.entityId,
    {
      collaborationId: "collaboration_delivery",
      title: "Delivery contract",
      threadId: thread.entityId,
      ganttTaskId: gantt.entityId,
      lead: "lead",
      owners: ["owner"],
      reviewers: ["reviewer"],
      agentSessionId: "agent_session_external",
      recipeRunId: "recipe_run_external",
      objective: "Deliver the Project store",
      context: "Filesystem migration",
      expectedOutput: "Validated implementation",
      artifactType: "code",
      acceptanceCriteria: ["Focused tests pass"],
      at: "2026-09-28T00:00:00.000Z",
    },
  );

  const projectDirectories = fs.readdirSync(path.join(root, "project"));
  assert(projectDirectories.some(name => name.endsWith(`.${created.entityId}`)));
  const projectDirectory = path.join(root, "project",
    projectDirectories.find(name => name.endsWith(`.${created.entityId}`)));
  assert(fs.existsSync(path.join(projectDirectory, "project.json")));
  assert(fs.existsSync(path.join(projectDirectory, "threads", `${thread.entityId}.json`)));
  assert(fs.existsSync(path.join(projectDirectory, "gantt", `${gantt.entityId}.json`)));
  assert(fs.existsSync(path.join(projectDirectory, "collaboration", "collaboration_delivery.json")));
  const projectFile = fs.readFileSync(path.join(projectDirectory, "project.json"), "utf8");
  assert(!projectFile.includes("definition"), "Project files must not copy Recipe bodies");
  assert(!projectFile.includes("migrations") && !projectFile.includes("\"audit\""));

  const restarted = new ProjectStore(stateDirectory).list();
  assert.deepStrictEqual(restarted.projects, collaboration.snapshot.projects);
  assert.strictEqual(restarted.threads.find(item => item.threadId === thread.entityId).chatroom.roomId,
    "room_authoritative");
  assert.strictEqual(restarted.ganttTasks[0].taskId, gantt.entityId);
  assert.strictEqual(restarted.collaborationTasks[0].agentSessionId, "agent_session_external");
  assert.strictEqual(restarted.recipes.length, initial.recipes.length,
    "aggregate compatibility keeps legacy Recipe bodies available");

  expectCode(() => store.createProject(command("stale", initial.storeVersion), "Stale"),
    "store-version-conflict");
  assert.strictEqual(store.createThread(command("create-thread", 0), "ignored", "ignored").replayed, true);
  expectCode(() => store.createThread(command("create-thread", 0, "different"), created.entityId, "No"),
    "command-conflict");

  let version = collaboration.snapshot.storeVersion;
  for (let index = 0; index < PROJECT_RECEIPT_LIMIT + 12; index++) {
    const result = store.createProject(command(`bounded-${index}`, version), `Bounded ${index}`);
    version = result.snapshot.storeVersion;
  }
  const control = JSON.parse(fs.readFileSync(path.join(stateDirectory, "project-store.json"), "utf8"));
  assert.strictEqual(control.receipts.length, PROJECT_RECEIPT_LIMIT);
  assert.strictEqual(control.receipts[0].commandId, "bounded-12");

  const corruptRoot = temporary();
  const corruptState = path.join(corruptRoot, ".pkm", "state");
  const corruptStore = new ProjectStore(corruptState, ids("root", "one", "thread"));
  const corruptProject = corruptStore.createProject(command("one", 1), "One");
  const corruptThread = corruptStore.createThread(command("thread", 2), corruptProject.entityId, "Thread");
  const corruptDirectory = fs.readdirSync(path.join(corruptRoot, "project"))
    .map(name => path.join(corruptRoot, "project", name))
    .find(directory => directory.endsWith(`.${corruptProject.entityId}`));
  fs.writeFileSync(path.join(corruptDirectory, "threads", `${corruptThread.entityId}.json`), "{");
  expectCode(() => new ProjectStore(corruptState).list(), "entity-corrupt");
  assert(fs.existsSync(path.join(corruptDirectory, "project.json")),
    "a corrupt entity must not delete or rewrite healthy entities");

  const migrationRoot = temporary();
  const migrationState = path.join(migrationRoot, ".pkm", "state");
  const legacy = new ProjectStore(migrationState, ids("legacy-root", "legacy-project"), { autoMigrate: false });
  const legacyInitial = legacy.list();
  const legacyCreated = legacy.createProject(command("legacy-project", legacyInitial.storeVersion), "Legacy");
  const preview = legacy.migrateLegacy("preview");
  assert.strictEqual(preview.phase, "previewed");
  assert.strictEqual(preview.projects, legacyCreated.snapshot.projects.length);
  const staged = legacy.migrateLegacy("stage", { sourceDigest: preview.sourceDigest });
  assert.strictEqual(staged.phase, "staged");
  assert.strictEqual(legacy.migrateLegacy("stage", { sourceDigest: preview.sourceDigest }).phase, "staged",
    "staging retry is idempotent");
  assert.strictEqual(legacy.migrateLegacy("verify", { sourceDigest: preview.sourceDigest }).phase, "verified");
  assert.strictEqual(legacy.migrateLegacy("cutover", { sourceDigest: preview.sourceDigest }).phase, "cutover");
  assert.deepStrictEqual(new ProjectStore(migrationState).list().projects, legacyCreated.snapshot.projects);
  assert.strictEqual(legacy.migrateLegacy("cutover", { sourceDigest: preview.sourceDigest }).phase, "cutover",
    "cutover retry is idempotent");
  assert.strictEqual(legacy.migrateLegacy("rollback", { sourceDigest: preview.sourceDigest }).phase, "rolled-back");
  assert(!fs.existsSync(path.join(migrationRoot, "project")));

  const changedSource = new ProjectStore(migrationState, ids("changed"), { autoMigrate: false });
  const changedPreview = changedSource.migrateLegacy("preview");
  changedSource.createProject(command("change-source", changedSource.list().storeVersion), "Changed");
  expectCode(() => changedSource.migrateLegacy("stage", { sourceDigest: changedPreview.sourceDigest }),
    "migration-source-changed");

  const conflictRoot = temporary();
  const conflictState = path.join(conflictRoot, ".pkm", "state");
  const conflictStore = new ProjectStore(conflictState, ids("root", "project"), { autoMigrate: false });
  conflictStore.createProject(command("project", 1), "Source");
  const conflictPreview = conflictStore.migrateLegacy("preview");
  conflictStore.migrateLegacy("stage", { sourceDigest: conflictPreview.sourceDigest });
  fs.mkdirSync(path.join(conflictRoot, "project", "foreign.project_foreign"), { recursive: true });
  fs.writeFileSync(path.join(conflictRoot, "project", "foreign.project_foreign", "project.json"),
    JSON.stringify({ schema: 1, projectId: "project_foreign", name: "Foreign", version: 1 }));
  expectCode(() => conflictStore.migrateLegacy("cutover", { sourceDigest: conflictPreview.sourceDigest }),
    "migration-target-conflict");

  const interruptedRoot = temporary();
  const interruptedState = path.join(interruptedRoot, ".pkm", "state");
  const interrupted = new ProjectStore(interruptedState, ids("root", "project"), { autoMigrate: false });
  interrupted.createProject(command("project", 1), "Interrupted");
  const interruptedPreview = interrupted.migrateLegacy("preview");
  interrupted.migrateLegacy("stage", { sourceDigest: interruptedPreview.sourceDigest });
  interrupted.migrateLegacy("verify", { sourceDigest: interruptedPreview.sourceDigest });
  fs.renameSync(
    path.join(interruptedState, "project-store-migration", "stage", "project"),
    path.join(interruptedRoot, "project"),
  );
  assert.strictEqual(interrupted.migrateLegacy("cutover", {
    sourceDigest: interruptedPreview.sourceDigest,
  }).phase, "cutover", "cutover retry finalizes an interrupted matching directory swap");
  assert.strictEqual(new ProjectStore(interruptedState).list().projects.length, 2);

  {
    // Windows: renaming a directory that a watcher/indexer holds open fails with EPERM.
    const { setProjectStoreFsRetryPolicyForTests } = require("../dist/workflows/project-filesystem-store.js");
    const windowsRoot = temporary();
    const windowsState = path.join(windowsRoot, ".pkm", "state");
    const windowsStore = new ProjectStore(windowsState, ids("root", "project-a", "thread-a", "project-b"));
    windowsStore.list();
    const realRename = fs.renameSync;
    let transientFailures = 0;
    const restorePolicy = setProjectStoreFsRetryPolicyForTests({ attempts: 5, initialDelayMs: 1, maxDelayMs: 2 });
    fs.renameSync = (from, to) => {
      if (path.resolve(from) === path.join(windowsRoot, "project")) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), { code: "EPERM" });
      }
      if (String(to).endsWith("project.json") && transientFailures < 2) {
        transientFailures += 1;
        throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      }
      return realRename(from, to);
    };
    try {
      const first = windowsStore.createProject(command("w-project", windowsStore.list().storeVersion), "Windows A");
      const second = windowsStore.createThread(command("w-thread", first.snapshot.storeVersion), first.entityId, "Work");
      const third = windowsStore.createProject(command("w-project-b", second.snapshot.storeVersion), "Windows B");
      assert.strictEqual(transientFailures, 2, "transient Windows file-replace errors are retried");
      assert(third.snapshot.threads.some(thread => thread.name === "Work"));
      assert(third.snapshot.projects.some(project => project.name === "Windows B"));
    } finally {
      fs.renameSync = realRename;
      restorePolicy();
    }
    const reopened = new ProjectStore(windowsState).list();
    assert(reopened.projects.some(project => project.name === "Windows A"));
    assert(reopened.projects.some(project => project.name === "Windows B"));
    assert(!fs.readdirSync(windowsState).some(entry => entry.startsWith(".project-store-write-")),
      "no staging directories remain after an in-place commit");
    assert(!fs.existsSync(path.join(windowsState, "project-store-intent.json")));

    // Crash after the tree is reconciled but before control is written rolls forward on next read.
    const beforeCrash = new ProjectStore(windowsState).list();
    fs.renameSync = (from, to) => {
      if (String(to).endsWith("project-store.json")) throw Object.assign(new Error("EIO"), { code: "EIO" });
      return realRename(from, to);
    };
    try {
      assert.throws(() => new ProjectStore(windowsState).createProject(
        command("w-crash", beforeCrash.storeVersion), "Crash Survivor"));
    } finally {
      fs.renameSync = realRename;
    }
    assert(fs.existsSync(path.join(windowsState, "project-store-intent.json")), "intent survives the failed commit");
    const recovered = new ProjectStore(windowsState).list();
    assert.strictEqual(recovered.storeVersion, beforeCrash.storeVersion + 1);
    assert(recovered.projects.some(project => project.name === "Crash Survivor"));
    assert(!fs.existsSync(path.join(windowsState, "project-store-intent.json")));

    // Stray files inside the canonical tree are reconciled away, matching the old full-replace semantics.
    fs.writeFileSync(path.join(windowsRoot, "project", "stray.txt"), "x");
    const afterStray = new ProjectStore(windowsState);
    afterStray.createProject(command("w-after-stray", recovered.storeVersion), "After Stray");
    assert(!fs.existsSync(path.join(windowsRoot, "project", "stray.txt")));
  }

  console.log("project filesystem store tests passed");
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}
