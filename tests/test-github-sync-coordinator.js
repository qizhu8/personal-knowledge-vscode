#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");
const {
  GitHubSyncCoordinator,
  canonicalKnowledgeRoot,
  githubSyncCoordinatorDirectory,
} = require("../dist/github-sync-coordinator.js");

const runtimeRoot = path.join(__dirname, ".runtime-github-sync-coordinator");
const wait = delay => new Promise(resolve => setTimeout(resolve, delay));
const children = [];

function waitFor(messages, predicate, label, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const value = messages.find(predicate);
      if (value) return resolve(value);
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${label}; messages=${JSON.stringify(messages)}`));
      setTimeout(poll, 20);
    };
    poll();
  });
}

(async () => {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const knowledgeRoot = path.join(runtimeRoot, "knowledge");
  const stateDirectory = path.join(runtimeRoot, "state");
  fs.mkdirSync(knowledgeRoot);
  const childPath = path.join(__dirname, "fixtures", "github-sync-coordinator-child.js");
  children.push(...[0, 1].map(() => fork(childPath, [stateDirectory, knowledgeRoot, "3.2.2"], { stdio: ["ignore", "ignore", "inherit", "ipc"] })));
  const messages = [];
  for (const child of children) child.on("message", message => messages.push(message));
  await Promise.all(children.map(child => waitFor(messages, message => message.type === "ready" && message.pid === child.pid, `child ${child.pid} ready`)));

  for (const child of children) child.send({ type: "hold" });
  children[0].send({ type: "requests", reasons: ["interval", "manual"] });
  const first = await waitFor(messages, message => message.type === "execute", "initial execution");
  assert.strictEqual(first.reason, "manual", "durable intents coalesce using the documented reason priority");

  const leader = children.find(child => child.pid === first.pid);
  const follower = children.find(child => child.pid !== first.pid);
  follower.send({ type: "configure" });
  await waitFor(messages, message => message.type === "configured" && message.pid === follower.pid, "follower reconfiguration");
  leader.kill();
  await new Promise(resolve => leader.once("exit", resolve));
  const recovered = await waitFor(messages, message =>
    message.type === "execute" && message.pid === follower.pid && message.reason === "manual",
  "stale in-flight claim recovery");
  assert(recovered.fencingToken > first.fencingToken, "stale recovery advances the monotonically increasing fencing token");
  follower.send({ type: "release" });
  await wait(200);
  assert.strictEqual(messages.filter(message => message.type === "execute" && message.reason === "manual").length, 2,
    "a killed in-flight intent is replayed exactly once by the new fenced leader");
  await wait(150);

  follower.send({ type: "hold" });
  follower.send({ type: "request", reason: "change" });
  const active = await waitFor(messages, message => message.type === "execute" && message.reason === "change", "held active run");
  const activeIndex = messages.indexOf(active);
  follower.send({ type: "requests", reasons: ["interval", "manual", "change"] });
  follower.send({ type: "release" });
  const followUp = await waitFor(messages, message =>
    message.type === "execute" && message.reason === "manual" && message.pid === follower.pid && messages.indexOf(message) > activeIndex,
  "coalesced follow-up");
  await wait(150);
  assert.strictEqual(messages.filter(message => message.type === "execute" && message.fencingToken === followUp.fencingToken).length >= 2, true);
  assert.strictEqual(messages.filter(message => message.type === "execute" && message.reason === "manual").length, 3,
    "requests during a run produce one priority-coalesced follow-up");
  follower.send({ type: "dispose" });
  await new Promise(resolve => follower.once("exit", resolve));

  const blockedState = path.join(runtimeRoot, "blocked-state");
  let attempts = 0;
  const incompatible = new GitHubSyncCoordinator({
    stateDirectory: blockedState,
    knowledgeRoot,
    extensionVersion: "3.2.2",
    pollMs: 20,
    leaseMs: 200,
    compatibilityBlock: error => error.block,
    execute: async () => {
      attempts += 1;
      const error = new Error("upgrade");
      error.block = { requiredVersion: "4.0.0", installedVersion: "3.2.2" };
      throw error;
    },
  });
  incompatible.configure([{ id: "primary", enabled: true, intervalMinutes: 60, syncOnChange: false, lastSuccessAt: new Date().toISOString() }]);
  incompatible.request("primary", "configuration");
  while (incompatible.snapshot().primary?.status !== "blocked") await wait(20);
  assert.strictEqual(attempts, 1);
  incompatible.configure([{ id: "primary", enabled: true, intervalMinutes: 60, syncOnChange: false, lastSuccessAt: new Date().toISOString() }]);
  assert.strictEqual(incompatible.snapshot().primary.status, "blocked",
    "reconfiguration from another window preserves blocked state for active targets");
  incompatible.dispose();

  let prereleaseAttempts = 0;
  const prerelease = new GitHubSyncCoordinator({
    stateDirectory: blockedState,
    knowledgeRoot,
    extensionVersion: "4.0.0-pre.1",
    pollMs: 20,
    leaseMs: 200,
    execute: async () => { prereleaseAttempts += 1; },
  });
  prerelease.configure([{ id: "primary", enabled: true, intervalMinutes: 60, syncOnChange: false, lastSuccessAt: new Date().toISOString() }]);
  await wait(150);
  assert.strictEqual(prereleaseAttempts, 0, "a prerelease does not satisfy a stable compatibility requirement");
  assert.strictEqual(prerelease.snapshot().primary.status, "blocked");
  prerelease.dispose();

  let replayedReason;
  const compatible = new GitHubSyncCoordinator({
    stateDirectory: blockedState,
    knowledgeRoot,
    extensionVersion: "4.0.0",
    pollMs: 20,
    leaseMs: 200,
    execute: async (_targetId, reason) => { replayedReason = reason; },
  });
  compatible.configure([{ id: "primary", enabled: true, intervalMinutes: 60, syncOnChange: false, lastSuccessAt: new Date().toISOString() }]);
  const replayDeadline = Date.now() + 3000;
  while (!replayedReason && Date.now() < replayDeadline) await wait(20);
  assert.strictEqual(replayedReason, "configuration", "a compatible activation immediately replays the original blocked reason");
  compatible.dispose();

  const failureState = path.join(runtimeRoot, "failure-state");
  const failing = new GitHubSyncCoordinator({
    stateDirectory: failureState,
    knowledgeRoot,
    extensionVersion: "4.0.0",
    pollMs: 20,
    leaseMs: 200,
    execute: async () => { throw new Error("transient failure"); },
  });
  failing.configure([{ id: "primary", enabled: true, intervalMinutes: 60, syncOnChange: false, lastSuccessAt: new Date().toISOString() }]);
  failing.request("primary", "configuration");
  const failureDeadline = Date.now() + 3000;
  while (failing.snapshot().primary?.status !== "error" && Date.now() < failureDeadline) await wait(20);
  const failedState = JSON.parse(fs.readFileSync(path.join(failureState, "coordinator.json"), "utf8"));
  assert.strictEqual(failedState.claims.primary.reason, "configuration",
    "ordinary failures retain their durable claim while the scheduler owns the persisted retry");
  failing.dispose();
  let failedReplayReason;
  const failureRecovery = new GitHubSyncCoordinator({
    stateDirectory: failureState,
    knowledgeRoot,
    extensionVersion: "4.0.0",
    pollMs: 20,
    leaseMs: 200,
    execute: async (_targetId, reason) => { failedReplayReason = reason; },
  });
  failureRecovery.configure([{ id: "primary", enabled: true, intervalMinutes: 60, syncOnChange: false, lastSuccessAt: new Date().toISOString() }]);
  const failureReplayDeadline = Date.now() + 3000;
  while (!failedReplayReason && Date.now() < failureReplayDeadline) await wait(20);
  assert.strictEqual(failedReplayReason, "configuration",
    "a successor requeues an ordinary-failure claim instead of losing its original reason");
  failureRecovery.dispose();

  const rootA = path.join(runtimeRoot, "root-a");
  const rootB = path.join(runtimeRoot, "root-b");
  fs.mkdirSync(rootA);
  fs.mkdirSync(rootB);
  const directoryA = githubSyncCoordinatorDirectory(path.join(runtimeRoot, "global"), rootA);
  const directoryB = githubSyncCoordinatorDirectory(path.join(runtimeRoot, "global"), rootB);
  assert.notStrictEqual(directoryA, directoryB, "different canonical Knowledge Roots use separate coordinator state");
  const independentRuns = [];
  const coordinators = [directoryA, directoryB].map((stateDirectory, index) => {
    const coordinator = new GitHubSyncCoordinator({
      stateDirectory,
      knowledgeRoot: index ? rootB : rootA,
      extensionVersion: "4.0.0",
      pollMs: 20,
      leaseMs: 200,
      execute: async (_targetId, reason, fencingToken) => independentRuns.push([index, reason, fencingToken]),
    });
    coordinator.configure([{ id: "same-target", enabled: true, intervalMinutes: 60, syncOnChange: false, lastSuccessAt: new Date().toISOString() }]);
    coordinator.request("same-target", "manual");
    return coordinator;
  });
  const independentDeadline = Date.now() + 3000;
  while (independentRuns.length < 2 && Date.now() < independentDeadline) await wait(20);
  assert.deepStrictEqual(independentRuns.sort((left, right) => left[0] - right[0]), [
    [0, "manual", 1],
    [1, "manual", 1],
  ], "separate roots elect independent leaders and cannot consume each other's intents");
  for (const coordinator of coordinators) coordinator.dispose();

  assert.strictEqual(
    canonicalKnowledgeRoot("/ignored", "win32", () => "C:\\Users\\ME\\Knowledge\\"),
    "c:/users/me/knowledge",
  );
  assert.strictEqual(
    canonicalKnowledgeRoot("/ignored", "darwin", () => "/Users/ME/Knowle\u0301dge/"),
    "/Users/ME/Knowl\u00e9dge",
  );
  assert.strictEqual(
    githubSyncCoordinatorDirectory("storage", "/a", "linux", () => "/real/root"),
    githubSyncCoordinatorDirectory("storage", "/b", "linux", () => "/real/root"),
    "symlink aliases resolve to the same coordinator identity",
  );

  const extension = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  const sync = fs.readFileSync(path.join(__dirname, "..", "src", "github-sync.ts"), "utf8");
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "github-sync-coordinator.yml"), "utf8");
  assert.match(extension, /withGitHubSyncTargetLock\(context, targetId, \(\) => withGitHubSyncApplyLock\(context,/);
  assert.match(extension, /githubSyncCoordinatorStatePath !== coordinatorStatePath[\s\S]*githubSyncScheduler\.dispose\(\)[\s\S]*new GitHubSyncCoordinator/,
    "extension configuration recreates the coordinator when the canonical Knowledge Root changes");
  assert.match(sync, /const applied = applyLocalChanges\(storeRoot, localWrites, localDeletes\)/,
    "the serialized target operation retains the conflict-safe local apply phase");
  for (const os of ["ubuntu-latest", "windows-latest", "macos-latest"]) assert(workflow.includes(os));
  assert.doesNotMatch(workflow, /\b(?:vsce\s+publish|mode:\s*publish|marketplace)\b/i,
    "the coordinator matrix validates native platforms without mutating Marketplace state");

  console.log("GitHub Sync coordinator tests passed");
})().finally(() => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
