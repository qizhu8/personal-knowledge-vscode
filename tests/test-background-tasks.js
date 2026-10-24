#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const os = require("os");
const { BackgroundTaskRegistry } = require("../dist/runtime/background-task-registry.js");
const { ActionBackgroundTasks } = require("../dist/runtime/action-background-tasks.js");

let now = new Date("2026-09-25T06:00:00.000Z");
const registry = new BackgroundTaskRegistry(() => now);
const snapshots = [];
registry.subscribe(snapshot => snapshots.push(snapshot));
const scheduled = registry.producer({ id: "github-sync:docs", kind: "github-sync", label: "GitHub sync · Docs" });
const running = registry.producer({ id: "inventory:refresh", kind: "inventory", label: "Refresh knowledge inventory" });

scheduled.queued({ nextRunAt: "2026-09-25T06:05:00.000Z", detail: "Automatic sync scheduled" });
now = new Date("2026-09-25T06:01:00.000Z");
running.running({ detail: "Scanning files", progress: { current: 12, unit: "files" } });
let snapshot = registry.snapshot();
assert.strictEqual(snapshot.revision, 2);
assert.deepStrictEqual(snapshot.tasks.map(task => [task.id, task.status]), [
  ["inventory:refresh", "running"],
  ["github-sync:docs", "queued"],
]);
assert.strictEqual(snapshot.tasks[0].startedAt, "2026-09-25T06:01:00.000Z");
assert.strictEqual(snapshot.tasks[1].queuedAt, "2026-09-25T06:00:00.000Z");

snapshot.tasks[0].progress.current = 999;
assert.strictEqual(registry.snapshot().tasks[0].progress.current, 12, "snapshots must not expose mutable registry state");
const revision = registry.snapshot().revision;
running.running({ detail: "Scanning files", progress: { current: 12, unit: "files" } });
assert.strictEqual(registry.snapshot().revision, revision, "identical producer updates must not publish duplicate snapshots");
running.idle();
scheduled.idle();
assert.deepStrictEqual(registry.snapshot().tasks, []);
assert.strictEqual(snapshots.length, 4);

const actionStore = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-action-background-"));
const queueFile = path.join(actionStore, ".pkm", "state", "actions", "validation-queue.json");
let selectedStore = actionStore;
const actions = new ActionBackgroundTasks(registry, () => selectedStore);
const jobId = "validation_" + "a".repeat(32);
const actionQueue = { schema: "pkm.action.validation-queue/v1", worker_pid: null, jobs: {
  [jobId]: { job_id: jobId, action_id: "core.date.parse", state: "queued", stage: "queued", priority: 0,
    queued_at: Date.parse("2026-10-07T06:00:00Z") / 1000 },
} };
try {
  fs.mkdirSync(path.dirname(queueFile), { recursive: true });
  const writeQueue = () => fs.writeFileSync(queueFile, JSON.stringify(actionQueue));
  running.running({ detail: "Unrelated inventory work" });
  writeQueue();
  actions.refresh();
  let task = registry.snapshot().tasks.find(task => task.kind === "action-validation");
  assert.strictEqual(task.status, "queued");
  assert.strictEqual(task.queuedAt, "2026-10-07T06:00:00.000Z");
  assert.match(task.detail, /queued \/ Demand/);
  const unchangedRevision = registry.snapshot().revision;
  actions.refresh();
  assert.strictEqual(registry.snapshot().revision, unchangedRevision);
  Object.assign(actionQueue.jobs[jobId], { state: "running", stage: "build", started_at: Date.parse("2026-10-07T06:01:00Z") / 1000 });
  writeQueue();
  actions.refresh();
  task = registry.snapshot().tasks.find(task => task.kind === "action-validation");
  assert.strictEqual(task.status, "running");
  assert.match(task.detail, /build \/ Demand/);
  assert.strictEqual(task.startedAt, "2026-10-07T06:01:00.000Z");
  Object.assign(actionQueue.jobs[jobId], { stage: "test", cancel_requested: true });
  writeQueue();
  actions.refresh();
  assert.match(registry.snapshot().tasks.find(task => task.kind === "action-validation").detail, /cancellation requested/);
  for (const state of ["succeeded", "cancelled", "outcome_unknown", "failed"]) {
    actionQueue.jobs[jobId].state = state;
    writeQueue();
    actions.refresh();
    assert.deepStrictEqual(registry.snapshot().tasks.map(task => task.id), ["inventory:refresh"]);
  }
  actionQueue.jobs[jobId].state = "queued";
  writeQueue();
  actions.refresh();
  selectedStore = "";
  actions.refresh();
  assert.deepStrictEqual(registry.snapshot().tasks.map(task => task.id), ["inventory:refresh"]);
  selectedStore = actionStore;
  actions.refresh();
  fs.writeFileSync(queueFile, "corrupt queue");
  actions.refresh();
  assert.deepStrictEqual(registry.snapshot().tasks.map(task => task.id), ["inventory:refresh"]);
} finally {
  actions.dispose();
  running.idle();
  fs.rmSync(actionStore, { recursive: true, force: true });
}

const root = path.join(__dirname, "..");
const uiSource = fs.readFileSync(path.join(root, "src", "webview", "panel", "52-background-tasks.js"), "utf8");
const extensionSource = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const html = fs.readFileSync(path.join(root, "src", "webview", "panel.html"), "utf8");
const core = fs.readFileSync(path.join(root, "src", "webview", "panel", "00-core.js"), "utf8");
const knowledge = fs.readFileSync(path.join(root, "src", "webview", "panel", "20-knowledge.js"), "utf8");

const detail = { style: {}, innerHTML: "" };
const asks = [];
const uiContext = {
  document: { getElementById: id => id === "detail" ? detail : null },
  state: { tab: "backgroundTasks" },
  esc: value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;"),
  ask: (...args) => asks.push(args),
  console,
};
vm.createContext(uiContext);
vm.runInContext(`${uiSource};this.onSnapshot=backgroundTasksOnSnapshot;this.onProcesses=backgroundProcessesOnSnapshot;this.show=showBackgroundTasksTab;this.timeLabel=backgroundTaskScheduleLabel`, uiContext);
uiContext.onSnapshot({
  revision: 1,
  tasks: [
    { id: "real", kind: "retrieval", label: "Refresh search index", status: "running", detail: "Updating corpus" },
    { id: "done", kind: "other", label: "Completed task", status: "completed" },
  ],
});
assert.match(detail.innerHTML, /Refresh search index/);
assert.doesNotMatch(detail.innerHTML, /Completed task/);
assert.match(detail.innerHTML, /1 active/);
uiContext.onSnapshot({ revision: 2, tasks: [] });
assert.match(detail.innerHTML, /No background tasks/);
assert.strictEqual(uiContext.timeLabel("2026-09-25T06:05:00.000Z", Date.parse("2026-09-25T06:00:00.000Z")), "in 5m");
uiContext.show();
assert.strictEqual(asks.length, 1, "opening the tab refreshes processes without re-requesting cached tasks");
assert.strictEqual(asks[0][0], "backgroundProcesses");
assert.strictEqual(Object.keys(asks[0][1]).length, 0);
uiContext.onProcesses({
  host: "local-test", platform: "linux", sampledAt: "2026-10-22T05:00:00Z",
  processes: [{ pid: 123, parentPid: 1, kind: "retrieval", entryExists: false,
    fixture: true, pathVersion: "3.2.42", elapsedSeconds: 90061, rssBytes: 104857600,
    assessment: { state: "test-leftover", basis: "entry-path" },
    entryPath: "/tmp/pkm-startup-x/<script>.py" }],
});
assert.match(detail.innerHTML, /Background Processes/);
assert.match(detail.innerHTML, /Test leftover · entry deleted/);
assert.match(detail.innerHTML, /PID 123/);
assert.match(detail.innerHTML, /Parent 1/);
assert.match(detail.innerHTML, /25h 1m · 100.0 MiB/);
assert.match(detail.innerHTML, /Entry-path version: 3.2.42/);
assert.match(detail.innerHTML, /Test fixture path/);
assert.match(detail.innerHTML, /&lt;script>/);
assert.doesNotMatch(detail.innerHTML, /<script>/);
assert.match(detail.innerHTML, /No background tasks/, "a live process must not imply active work");
uiContext.onSnapshot({ revision: 3, tasks: [] });
assert.match(detail.innerHTML, /PID 123/, "task updates must not erase the process inventory");
uiContext.onProcesses({ processes: [], error: "Cannot inspect processes" });
assert.match(detail.innerHTML, /role="alert">Cannot inspect processes/);
assert.doesNotMatch(detail.innerHTML, /No recognized PKM background processes found/, "failure must not look like an empty inventory");

assert.match(html, /data-tab="backgroundTasks">Background Tasks/);
assert.match(core, /settings:\[[^\]]*'backgroundTasks'/);
assert.match(core, /command === 'backgroundTasks'[\s\S]{0,100}backgroundTasksOnSnapshot/);
assert.match(core, /command === 'backgroundProcesses'[\s\S]{0,100}backgroundProcessesOnSnapshot/);
assert.match(extensionSource, /case "backgroundProcesses"[\s\S]{0,350}readInstalledExtensionBuild\(context.extensionPath, context.extension.id\)[\s\S]{0,200}backgroundProcessInventory.snapshot\(installed\)/);
assert.match(knowledge, /state\.tab === 'backgroundTasks'[\s\S]{0,180}showBackgroundTasksTab/);
assert.match(extensionSource, /respond\(\{ command: "backgroundTasks", data: backgroundTaskRegistry\.snapshot\(\) \}\)/);
for (const producer of ["inventoryTask", "retrievalQueuedTask", "brokerRefreshQueuedTask", "contentCheckTask", "updateGitHubSyncBackgroundTask"]) {
  assert(extensionSource.includes(producer), `missing background task producer adapter: ${producer}`);
}
assert.match(extensionSource, /new ActionBackgroundTasks\(backgroundTaskRegistry, getStorePath(?:,|\))/,
  "Action background producer must retain the shared registry and knowledge-store binding");

console.log("background task registry and Settings UI tests passed");
