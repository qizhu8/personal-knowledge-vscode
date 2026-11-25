import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { collectFirstOriginLogs, createProviderObservation, startOwnerObservation } from "./installed-native-model-diagnostics.mjs";

async function fixture(t) {
  const root = resolve("clients/vscode-host", `.installed-host-model-diag-b68245d4-${randomUUID()}`);
  mkdirSync(root, { mode: 0o700 });
  const pin = lstatSync(root, { bigint: true });
  t.after(async () => {
    const current = await lstat(root, { bigint: true });
    assert.equal(current.dev, pin.dev); assert.equal(current.ino, pin.ino); assert.equal(current.uid, pin.uid);
    await rm(root, { recursive: true });
  });
  return root;
}

test("owner freezes and starts flushing the first unexpected abort before later cleanup can relabel it", async t => {
  const root = await fixture(t), controller = new AbortController();
  const observer = startOwnerObservation({ session: { signal: controller.signal }, root });
  observer.setStage("native-model-execution");
  const reason = Object.assign(new Error("fixture-private-message"), {
    code: "NATIVE_ATTACHMENT_HEARTBEAT_TIMEOUT", timeoutMs: 2000, elapsedMs: 2251.25, ownerTimerOvershootMs: 251.25,
    cause: Object.assign(new Error("fixture-private-cause"), { code: "fixture-private-code" }),
  });
  controller.abort(reason);
  observer.markExpected("close"); observer.setStage("cleanup");
  const finishing = observer.finish();
  assert.equal(finishing, observer.stop());
  const result = await finishing;
  assert.equal(controller.signal.reason, reason);
  assert.equal(result.report.firstAbort.expected, false);
  assert.equal(result.report.firstAbort.stage, "native-model-execution");
  assert.equal(result.report.firstAbort.timeoutMs, 2000);
  assert.equal(result.report.firstAbort.ownerTimerOvershootMs, 251.25);
  assert.deepEqual(result.report.firstAbort.causeCodes, ["NATIVE_ATTACHMENT_HEARTBEAT_TIMEOUT", "UNCLASSIFIED"]);
  assert.equal(result.report.pairedPingPongAvailable, false);
  const contents = await readFile(result.path, "utf8");
  assert(!contents.includes("fixture-private"));
  assert.equal(JSON.parse(contents).firstAbort.expected, false);
  assert.equal((await lstat(result.path)).mode & 0o777, 0o600);
  assert(result.bytes <= 256 * 1024);
});

test("expected reload is explicit and samples stay in memory until the parent finishes", async t => {
  const root = await fixture(t), controller = new AbortController();
  const observer = startOwnerObservation({ session: { signal: controller.signal }, root });
  observer.markExpected("reload"); observer.setStage("native-reload");
  await new Promise(ready => setTimeout(ready, 60));
  assert.deepEqual(await readdir(root), []);
  controller.abort();
  assert.deepEqual(await readdir(root), []);
  const result = await observer.finish();
  assert.equal(result.report.firstAbort.expected, true);
  assert.equal(result.report.firstAbort.expectedShutdown, "reload");
  assert(result.report.ticks > 0 && result.report.maxima.rssBytes > 0);
});

test("provider preserves exact returns, Promise identity and thrown objects with a bounded sanitized ring", async t => {
  const root = await fixture(t), observer = createProviderObservation({ root, pid: process.pid });
  const object = {}, promise = Promise.resolve(object), failure = new Error("fixture-private-provider-error");
  assert.equal(observer.observe("response-progress", () => object), object);
  assert.equal(observer.observe("response-progress", () => promise), promise);
  assert.throws(() => observer.observe("token-persist", () => { throw failure; }), error => error === failure);
  for (let count = 0; count < 1000; count++)
    assert.equal(observer.observe("token-persist", () => count, { tokenCalls: count, privateKey: "never-log" }), count);
  assert.deepEqual(await readdir(root), []);
  const result = await observer.finish();
  assert.equal(result.report.recentEvents.length, 256);
  assert.equal(result.report.totalEvents, 1003);
  assert.equal(result.report.maximumCounters.tokenCalls, 999);
  assert(result.report.stageDurations["token-persist"] >= 0);
  assert(!JSON.stringify(result.report).includes("never-log"));
  assert(!JSON.stringify(result.report).includes("fixture-private"));
  assert.equal(observer.finish(), observer.finish());
  assert.equal((await readdir(root)).length, 1);
  assert(result.bytes <= 256 * 1024);
});

test("budget snapshots and retained peak/registry tuples survive the recent ring being overwritten", async t => {
  const root = await fixture(t), observer = createProviderObservation({ root, pid: process.pid });
  t.mock.method(process, "memoryUsage", () => ({ rss: 900000000, heapUsed: 200000000, heapTotal: 250000000 }));
  observer.observe("token-persist", () => 7, { tokenCalls: 7 });
  const budget = observer.snapshot();
  assert.equal(budget.currentMemory.rssBytes, 900000000);
  assert.equal(budget.peaks.rssBytes.stage, "token-persist");
  assert.equal(budget.peaks.rssBytes.pid, process.pid);
  t.mock.restoreAll();
  const start = performance.now();
  observer.observe("token-persist", () => { while (performance.now() - start < 70) {} return 8; }, { tokenCalls: 8 });
  observer.snapshot();
  await new Promise(ready => setTimeout(ready, 60));
  for (let count = 1; count <= 10; count++)
    observer.observe("registry-change", () => count, { registryEvents: count });
  for (let count = 0; count < 500; count++)
    observer.observe("token-count", () => count, { tokenCalls: count });
  const result = await observer.finish();
  assert.equal(result.report.peaks.rssBytes.value, 900000000);
  assert.equal(result.report.peaks.heapUsedBytes.value, 200000000);
  assert(result.report.peaks.loopLagMs.value >= 15);
  assert(result.report.peaks.loopLagMs.monotonicMs >= 0);
  assert(result.report.stageDurationPeaks["token-persist"].value >= 65);
  assert.equal(result.report.stageDurationPeaks["token-persist"].counters.tokenCalls, 8);
  assert.equal(result.report.firstRegistryEvents.length, 8);
  assert.equal(result.report.firstRegistryEvents[0].counters.registryEvents, 1);
  assert.equal(result.report.registryEventCount, 10);
  assert.equal(result.report.registryEventsTruncated, true);
  assert.equal(result.report.recentEvents.some(event => event.stage === "registry-change"), false);
  assert(result.bytes <= 256 * 1024);
});

test("provider diagnostic faults never replace the original exception and are surfaced by finish", async t => {
  const root = await fixture(t), observer = createProviderObservation({ root, pid: process.pid });
  const original = new Error("original-fixture-business-exception");
  assert.throws(() => observer.observe("private-prompt-is-not-a-stage", () => { throw original; }), error => error === original);
  let getterCalled = false;
  const counters = Object.defineProperty({}, "tokenCalls", { get() { getterCalled = true; throw new Error("secret getter"); } });
  const value = {};
  assert.equal(observer.observe("token-count", () => value, counters), value);
  assert.equal(getterCalled, false);
  await assert.rejects(observer.finish(), error => {
    assert.equal(error.code, "DIAGNOSTIC_OBSERVATION_FAILED");
    assert(error.report.diagnosticProblems.some(problem => problem.code === "DIAGNOSTIC_STAGE_INVALID"));
    assert(error.report.diagnosticProblems.some(problem => problem.code === "DIAGNOSTIC_COUNTER_INVALID"));
    assert(!JSON.stringify(error.report).includes("private-prompt"));
    assert(!JSON.stringify(error.report).includes("original-fixture-business"));
    return true;
  });
});

function chatOrigin(changes = {}) {
  return { origin: "invocation", stage: "execution-model-send", expectedShutdown: false,
    epochTimeMs: 1795377396000, monotonicMs: 33000, elapsedMs: 20, pid: process.pid,
    rssBytes: 100000000, heapUsedBytes: 30000000, heapTotalBytes: 50000000,
    stageElapsedMs: 10, deadlineMs: 120000, registryRevision: 2, causeCodes: ["NATIVE_CHAT_CANCELLED"], ...changes };
}
async function logWindow(root) {
  const window = join(root, "u/logs/20261122T195552/window1");
  await mkdir(join(window, "exthost/output_logging_20261122T195602"), { recursive: true, mode: 0o700 });
  return window;
}

test("first-origin collector retains only sanitized prefix rows from bounded owned log paths", async t => {
  const root = await fixture(t), window = await logWindow(root);
  const chat = chatOrigin({ privatePrompt: "fixture-private-prompt", causeCodes: ["NATIVE_CHAT_CANCELLED", "fixture-private-code"] });
  const chatLine = `2026-11-22 19:56:36.000 [info] [Extension Host] [pkm.native-chat.first-cancel] ${JSON.stringify(chat)}\n`;
  const attachment = { origin: "requested-close", phase: "attached", expectedShutdown: true,
    epochTimeMs: 1795377396001, monotonicMs: 33001, elapsedMs: 30000, pid: process.pid,
    rssBytes: 100000000, heapUsedBytes: 30000000, heapTotalBytes: 50000000, causeCodes: [] };
  await writeFile(join(window, "renderer.log"), `fixture-private-unrelated-message\n${chatLine}`);
  await writeFile(join(window, "exthost/exthost.log"), chatLine.replace("19:56:36.000", "19:56:36.001"));
  await writeFile(join(window, "exthost/output_logging_20261122T195602/1-pkm-v5 Experimental.log"),
    `[pkm.native-attachment.first-stop] ${JSON.stringify(attachment)} (fixture-private-trailing-text)\n`);
  await writeFile(join(window, "other-extension.log"), chatLine.replace("execution-model-send", "private-unread-stage"));
  const result = await collectFirstOriginLogs({ root });
  assert.equal(result.report.rows.length, 2);
  assert.equal(result.report.coverage.duplicates, 1);
  assert.equal(result.report.coverage.candidateFiles, 3);
  assert.equal(result.report.unexpectedRows, 1);
  assert.equal(result.report.zeroUnexpectedCancellationProven, false);
  assert(["2026-11-22 19:56:36.000", "2026-11-22 19:56:36.001"].includes(
    result.report.rows.find(row => row.kind === "chat").sourceLogTime));
  assert.deepEqual(result.report.rows.find(row => row.kind === "chat").causeCodes, ["NATIVE_CHAT_CANCELLED", "UNCLASSIFIED"]);
  assert(!JSON.stringify(result.report).includes("fixture-private"));
  assert(!JSON.stringify(result.report).includes("private-unread"));
  assert(result.bytes <= 64 * 1024);
  assert.equal((await lstat(result.path)).mode & 0o777, 0o600);
});

test("first-origin collector reports missing coverage and refuses unsafe or oversized input without retaining raw logs", async t => {
  await t.test("no rows is not zero cancellation proof", async t => {
    const root = await fixture(t), window = await logWindow(root);
    await writeFile(join(window, "renderer.log"), "fixture-private-unrelated-message\n");
    const result = await collectFirstOriginLogs({ root });
    assert.equal(result.report.rows.length, 0);
    assert.equal(result.report.zeroUnexpectedCancellationProven, false);
    assert(result.report.limitations.some(text => text.includes("coverage gap")));
    assert(!JSON.stringify(result.report).includes("fixture-private"));
  });
  await t.test("missing log tree is surfaced", async t => {
    const root = await fixture(t);
    await assert.rejects(collectFirstOriginLogs({ root }), error =>
      error.code === "DIAGNOSTIC_FIRST_ORIGIN_FAILED" && error.report.diagnosticProblems.some(
        problem => problem.code === "DIAGNOSTIC_LOG_TREE_MISSING"));
  });
  await t.test("matching symlink is not followed", async t => {
    const root = await fixture(t), window = await logWindow(root);
    const target = join(root, "owned-but-outside-log-scope.log");
    await writeFile(target, `[pkm.native-chat.first-cancel] ${JSON.stringify(chatOrigin())}\n`);
    await symlink(target, join(window, "renderer.log"));
    await assert.rejects(collectFirstOriginLogs({ root }), error => {
      assert.equal(error.code, "DIAGNOSTIC_FIRST_ORIGIN_FAILED");
      assert.equal(error.report.coverage.bytesRead, 0);
      assert.equal(error.report.rows.length, 0);
      return true;
    });
  });
  await t.test("input byte bound is explicit", async t => {
    const root = await fixture(t), window = await logWindow(root);
    await writeFile(join(window, "renderer.log"), "x".repeat(513 * 1024));
    await assert.rejects(collectFirstOriginLogs({ root }), error => {
      assert.equal(error.code, "DIAGNOSTIC_FIRST_ORIGIN_FAILED");
      assert.equal(error.report.coverage.truncated, true);
      assert(error.report.coverage.bytesRead <= 512 * 1024);
      assert(!JSON.stringify(error.report).includes("x".repeat(100)));
      return true;
    });
  });
  await t.test("output byte bound is explicit", async t => {
    const root = await fixture(t), window = await logWindow(root);
    let failure;
    await writeFile(join(window, "renderer.log"), Array.from({ length: 200 }, (_, index) =>
      `[pkm.native-chat.first-cancel] ${JSON.stringify(chatOrigin({ monotonicMs: index }))}\n`).join(""));
    await assert.rejects(collectFirstOriginLogs({ root }), error => {
      failure = error;
      assert.equal(error.code, "DIAGNOSTIC_FIRST_ORIGIN_FAILED");
      assert(error.report.diagnosticProblems.some(problem => problem.code === "DIAGNOSTIC_ORIGIN_OUTPUT_LIMIT"));
      return true;
    });
    assert((await lstat(failure.path)).size <= 64 * 1024);
  });
});

test("sampler failure is reported on finish without aborting the live signed-session signal", async t => {
  const root = await fixture(t), controller = new AbortController();
  const observer = startOwnerObservation({ session: { signal: controller.signal }, root });
  t.mock.method(process, "memoryUsage", () => { throw new Error("fixture-private-memory-error"); });
  await new Promise(ready => setTimeout(ready, 60));
  t.mock.restoreAll();
  assert.equal(controller.signal.aborted, false);
  await assert.rejects(observer.finish(), error => {
    assert.equal(error.code, "DIAGNOSTIC_OBSERVATION_FAILED");
    assert(error.report.diagnosticProblems.some(problem => problem.code === "DIAGNOSTIC_MEMORY_FAILED"));
    assert(!JSON.stringify(error.report).includes("fixture-private"));
    return true;
  });
  assert.equal(controller.signal.aborted, false);
});

test("unsafe or replaced private profiles and foreign PIDs cannot become diagnostic write targets", async t => {
  const root = await fixture(t);
  assert.throws(() => createProviderObservation({ root, pid: process.pid + 1 }), { code: "DIAGNOSTIC_OWN_PID_REQUIRED" });
  await chmod(root, 0o755);
  assert.throws(() => createProviderObservation({ root, pid: process.pid }), { code: "DIAGNOSTIC_ROOT_UNSAFE" });
  await chmod(root, 0o700);
  const linked = `${root}-link`;
  await symlink(root, linked); t.after(() => rm(linked));
  assert.throws(() => createProviderObservation({ root: linked, pid: process.pid }), { code: "DIAGNOSTIC_ROOT_UNSAFE" });
  const observer = createProviderObservation({ root, pid: process.pid });
  await chmod(root, 0o755);
  await assert.rejects(observer.finish(), { code: "DIAGNOSTIC_OBSERVATION_FAILED" });
  assert.deepEqual(await readdir(root), []);
  await chmod(root, 0o700);
  const replaced = createProviderObservation({ root, pid: process.pid }), retained = `${root}-owned-original`;
  await rename(root, retained); await mkdir(root, { mode: 0o700 });
  try {
    await assert.rejects(replaced.finish(), error => {
      assert(error.report.diagnosticProblems.some(problem => problem.causeCodes.includes("DIAGNOSTIC_ROOT_CHANGED")));
      return true;
    });
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true });
    await rename(retained, root);
  }
});
