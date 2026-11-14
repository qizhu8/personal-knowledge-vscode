import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { runtimeFixture, until } from "./runtime-process-fixtures.mjs";
import { RuntimeProcessStore } from "../dist/runtime-process.js";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const source = `
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [directory, level = "0"] = process.argv.slice(2);
const depth = Number(level);
writeFileSync(join(directory, "pid-" + depth), String(process.pid));
if (depth === 0) process.stdout.write("owned-tree-started");
if (depth < 2) spawn(process.execPath, [process.argv[1], directory, String(depth + 1)], { stdio: "ignore" });
setInterval(() => appendFileSync(join(directory, "ticks-" + depth), "x"), 20);
`;
const sizes = root => [0, 1, 2].map(n => readFileSync(resolve(root, `ticks-${n}`)).length);
const ready = root => [0, 1, 2].every(n => existsSync(resolve(root, `ticks-${n}`)));
const pids = root => [0, 1, 2].map(n => Number(readFileSync(resolve(root, `pid-${n}`), "utf8")));
const exited = pid => {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "")[0] === "Z"; }
  catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return true; throw error; }
};

test("group mode preserves output and distinguishes failed program launch", { skip: process.platform !== "linux", timeout: 5000 }, async t => {
  const f = runtimeFixture();
  t.after(() => f.cleanup());
  const runtime = f.service({
    adapters: [
      { id: "synthetic", executable: process.execPath, cwd: f.directory, processScope: "linux-process-group",
        arguments: () => ["-e", "process.stdout.write('ok')"] },
      { id: "missing", executable: resolve(f.directory, "missing"), cwd: f.directory, processScope: "linux-process-group",
        arguments: () => [] },
    ],
  });
  const success = await f.launch(runtime);
  const done = await runtime.wait("alice", success.jobId);
  assert.equal(done.state, "SUCCEEDED");
  assert.equal(Buffer.from(done.stdout, "base64").toString(), "ok");
  const missing = await f.launch(runtime, "io", undefined, { adapterId: "missing" });
  const failure = await runtime.wait("alice", missing.jobId);
  assert.equal(failure.state, "FAILED");
  assert.equal(failure.reason, "spawn-error");
  assert.equal(failure.effect, "not-started");
});

test("owned Linux workflow group pauses, resumes and cancels all in-group descendants", { skip: process.platform !== "linux", timeout: 8000 }, async t => {
  const f = runtimeFixture();
  t.after(() => f.cleanup());
  const script = resolve(f.directory, "tree.mjs");
  writeFileSync(script, source);
  const runtime = f.service({
    adapters: [{ id: "synthetic", executable: process.execPath, cwd: f.directory,
      processScope: "linux-process-group", arguments: () => [script, f.directory] }],
    limits: { concurrency: 1, queue: 2, events: 16, deadlineMs: 1200, graceMs: 100, closeDrainMs: 200 },
  });
  const job = await f.launch(runtime);
  await until(() => ready(f.directory), 3000);
  const owned = pids(f.directory);
  await assert.rejects(runtime.pause("bob", job.jobId), { code: "NOT_FOUND" });
  assert.equal((await runtime.pause("alice", job.jobId)).state, "PAUSED");
  await delay(80);
  const paused = sizes(f.directory);
  await delay(1300);
  assert.deepEqual(sizes(f.directory), paused);
  assert.equal(runtime.status("alice", job.jobId).state, "PAUSED");
  assert.equal((await runtime.resume("alice", job.jobId)).state, "RUNNING");
  await until(() => sizes(f.directory).every((n, i) => n > paused[i]), 1000);
  await runtime.pause("alice", job.jobId);
  await runtime.cancel("alice", job.jobId);
  const done = await runtime.wait("alice", job.jobId);
  assert.equal(done.state, "CANCELLED");
  assert.equal(done.effect, "unknown");
  await until(() => owned.every(exited), 2000);
  const stopped = sizes(f.directory);
  await delay(120);
  assert.deepEqual(sizes(f.directory), stopped);
});

test("unexpected guardian death is interrupted, and a running anchor cleans its own group", { skip: process.platform !== "linux", timeout: 8000 }, async t => {
  const f = runtimeFixture();
  t.after(() => f.cleanup());
  const script = resolve(f.directory, "tree.mjs");
  writeFileSync(script, source);
  const runtime = f.service({
    adapters: [{ id: "synthetic", executable: process.execPath, cwd: f.directory,
      processScope: "linux-process-group", arguments: () => [script, f.directory] }],
  });
  const job = await f.launch(runtime);
  await until(() => ready(f.directory), 3000);
  const owned = pids(f.directory);
  const guardian = runtime.tasks.get(job.jobId).group.child;
  assert.equal(guardian.kill("SIGKILL"), true);
  const result = await runtime.wait("alice", job.jobId);
  assert.equal(result.state, "INTERRUPTED");
  assert.equal(result.reason, "supervisor-error");
  assert.equal(result.effect, "unknown");
  await until(() => owned.every(exited), 2000);
});

test("unexpected guardian death while paused resumes and cleans the owned descendants", { skip: process.platform !== "linux", timeout: 8000 }, async t => {
  const f = runtimeFixture();
  t.after(() => f.cleanup());
  const script = resolve(f.directory, "tree.mjs");
  writeFileSync(script, source);
  const runtime = f.service({
    adapters: [{ id: "synthetic", executable: process.execPath, cwd: f.directory,
      processScope: "linux-process-group", arguments: () => [script, f.directory] }],
  });
  const job = await f.launch(runtime);
  await until(() => ready(f.directory), 3000);
  const owned = pids(f.directory);
  await runtime.pause("alice", job.jobId);
  await delay(80);
  const paused = sizes(f.directory);
  await delay(100);
  assert.deepEqual(sizes(f.directory), paused);
  assert.equal(runtime.tasks.get(job.jobId).group.child.kill("SIGKILL"), true);
  const result = await runtime.wait("alice", job.jobId);
  assert.equal(result.state, "INTERRUPTED");
  assert.equal(result.reason, "supervisor-error");
  assert.equal(result.effect, "unknown");
  await until(() => owned.every(exited), 2000);
});

test("guardian death during the pause transition cleans the stopped tree and retains UNKNOWN output", { skip: process.platform !== "linux", timeout: 8000 }, async t => {
  const f = runtimeFixture();
  t.after(() => f.cleanup());
  const script = resolve(f.directory, "tree.mjs");
  writeFileSync(script, source);
  const runtime = f.service({
    adapters: [{ id: "synthetic", executable: process.execPath, cwd: f.directory,
      processScope: "linux-process-group", arguments: () => [script, f.directory] }],
  });
  const job = await f.launch(runtime);
  await until(() => ready(f.directory), 3000);
  const owned = pids(f.directory), guardian = runtime.tasks.get(job.jobId).group.child;
  await assert.rejects(runtime.pause("bob", job.jobId), { code: "NOT_FOUND" });
  const pending = runtime.pause("alice", job.jobId);
  const deadline = Date.now() + 2000, wait = new Int32Array(new SharedArrayBuffer(4));
  while (readFileSync(`/proc/${owned[0]}/stat`, "utf8").replace(/^.*\) /, "")[0] !== "T") {
    if (Date.now() >= deadline) throw new Error("Owned group never reached the stopped transition.");
    Atomics.wait(wait, 0, 0, 5);
  }
  assert.equal(guardian.kill("SIGKILL"), true);
  await pending.catch(() => {});
  const result = await runtime.wait("alice", job.jobId);
  assert.equal(result.state, "INTERRUPTED"); assert.equal(result.effect, "unknown");
  assert.equal(result.reason, "supervisor-error");
  assert.match(Buffer.from(result.stdout, "base64").toString(), /owned-tree-started/);
  await until(() => owned.every(exited), 2000);
});

test("guardian death during cancellation cannot be reported as confirmed cancellation", { skip: process.platform !== "linux", timeout: 8000 }, async t => {
  const f = runtimeFixture();
  t.after(() => f.cleanup());
  const script = resolve(f.directory, "tree.mjs");
  writeFileSync(script, source);
  const runtime = f.service({
    adapters: [{ id: "synthetic", executable: process.execPath, cwd: f.directory,
      processScope: "linux-process-group", arguments: () => [script, f.directory] }],
  });
  const job = await f.launch(runtime);
  await until(() => ready(f.directory), 3000);
  const owned = pids(f.directory), guardian = runtime.tasks.get(job.jobId).group.child;
  const cancellation = runtime.cancel("alice", job.jobId);
  assert.equal(guardian.kill("SIGKILL"), true);
  await cancellation;
  const result = await runtime.wait("alice", job.jobId);
  assert.equal(result.state, "INTERRUPTED");
  assert.equal(result.reason, "supervisor-error");
  await until(() => owned.every(exited), 2000);
});

test("guardian stops an owned group when its hosting runtime is killed", { skip: process.platform !== "linux", timeout: 8000 }, async t => {
  const f = runtimeFixture();
  const script = resolve(f.directory, "tree.mjs");
  writeFileSync(script, source);
  const host = spawn(process.execPath, [resolve("tests/linux-process-group-crash-host.mjs"), f.directory, script],
    { stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => {
    if (host.exitCode === null && host.signalCode === null) {
      host.kill("SIGKILL");
      await once(host, "exit");
    }
    if ([0, 1, 2].every(n => existsSync(resolve(f.directory, `pid-${n}`)))) {
      const owned = pids(f.directory);
      await until(() => owned.every(exited), 2000);
    }
    await f.cleanup();
  });
  let stdout = "", stderr = "";
  host.stdout.on("data", chunk => { stdout += chunk; });
  host.stderr.on("data", chunk => { stderr += chunk; });
  await until(() => stdout.includes("ready") && ready(f.directory), 3000);
  const owned = pids(f.directory);
  host.stdin.write("pause\n");
  await until(() => stdout.includes("paused"), 1000);
  assert.equal(host.kill("SIGKILL"), true);
  await once(host, "exit");
  await until(() => owned.every(exited), 2000);
  const [, jobId, priorOwner] = /ready ([a-f0-9-]+) ([a-f0-9-]+)/.exec(stdout);
  const database = new DatabaseSync(resolve(f.directory, "crash.sqlite"));
  try {
    const recovered = new RuntimeProcessStore(database, randomUUID(), 16, priorOwner);
    const job = recovered.get("alice", jobId);
    assert.equal(job.state, "INTERRUPTED");
    assert.equal(job.effect, "unknown");
    recovered.release();
  } finally { database.close(); }
  await delay(500);
  const stopped = sizes(f.directory);
  await delay(250);
  assert.deepEqual(sizes(f.directory), stopped, stderr);
});
