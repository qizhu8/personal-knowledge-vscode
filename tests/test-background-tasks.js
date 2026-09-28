#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { BackgroundTaskRegistry } = require("../dist/background-task-registry.js");

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
vm.runInContext(`${uiSource};this.onSnapshot=backgroundTasksOnSnapshot;this.show=showBackgroundTasksTab;this.timeLabel=backgroundTaskScheduleLabel`, uiContext);
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
assert.deepStrictEqual(asks, [], "a cached snapshot must render without another host request");

assert.match(html, /data-tab="backgroundTasks">Background Tasks/);
assert.match(core, /settings:\[[^\]]*'backgroundTasks'/);
assert.match(core, /command === 'backgroundTasks'[\s\S]{0,100}backgroundTasksOnSnapshot/);
assert.match(knowledge, /state\.tab === 'backgroundTasks'[\s\S]{0,180}showBackgroundTasksTab/);
assert.match(extensionSource, /respond\(\{ command: "backgroundTasks", data: backgroundTaskRegistry\.snapshot\(\) \}\)/);
for (const producer of ["inventoryTask", "retrievalQueuedTask", "brokerRefreshQueuedTask", "contentCheckTask", "updateGitHubSyncBackgroundTask"]) {
  assert(extensionSource.includes(producer), `missing background task producer adapter: ${producer}`);
}

console.log("background task registry and Settings UI tests passed");
