// Opt-in: cd next-server && STORAGE_QUALIFICATION_SECONDS=60 node tests/storage-fault-qualification-soak.mjs
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { channelFixture } from "./channel-runtime-fixtures.mjs";
import { httpCall, invocation, nativeWorkspace, sleep, syntheticManager, until } from "./batch06-manager-fixtures.mjs";

const seconds = Number(process.env.STORAGE_QUALIFICATION_SECONDS);
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) {
  throw new Error("Set STORAGE_QUALIFICATION_SECONDS to an integer from 1 through 300; this is a test-only profile.");
}
const bounds = { maxRequestMs: 10000, maxReconnectMs: 10000, maxCancelMs: 10000,
  maxRssGrowthBytes: 256 * 1024 * 1024, maxDatabaseGrowthBytes: 128 * 1024 * 1024,
  maxLogBytes: 1024 * 1024, maxChannelMs: 10000, concurrency: 8, intervalMs: 1000 };
const paths = ["src/storage.ts", "src/storage-worker.ts", "src/native-runtime.ts", "src/http.ts",
  "src/manager-runtime.ts", "src/channel-runtime.ts", "tests/batch06-manager-fixtures.mjs",
  "tests/channel-runtime-fixtures.mjs", "tests/storage-fault-qualification-soak.mjs",
  "dist/storage.js", "dist/storage-worker.js", "dist/native-runtime.js", "dist/http.js",
  "dist/manager-runtime.js", "dist/channel-runtime.js"];
const sourceHashes = async () => Object.fromEntries(await Promise.all(paths.map(async path =>
  [path, createHash("sha256").update(await readFile(path)).digest("hex")])));
const beforeHashes = await sourceHashes();
const cleanup = [];
const t = { after(fn) { cleanup.push(fn); } };
const manager = syntheticManager("feature", 2, { hold: true, publish: true });
let fixture, channel;
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
const latencies = [], statuses = { success: 0, busy: 0 }, channelLatencies = [];
const started = performance.now(), rssBefore = process.memoryUsage().rss;
let rssPeak = rssBefore, databasePeak = 0, reconnectMs = null, cancelMs = null;
let logBytes = 0;
const stdoutWrite = process.stdout.write, stderrWrite = process.stderr.write;
const temp = resolve("tests", `.storage-fault-qualification-temp-${randomUUID()}`);
const previousTemp = Object.fromEntries(["TMPDIR", "TMP", "TEMP"].map(key => [key, process.env[key]]));
function countedWrite(original) {
  return function (chunk, ...args) {
    logBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    return original.call(this, chunk, ...args);
  };
}
const databaseSize = async root => {
  let size = 0;
  for (const name of ["core.sqlite", "core.sqlite-wal", "core.sqlite-shm"]) {
    try { size += (await stat(join(root, name))).size; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return size;
};
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)].toFixed(2));
};
try {
  await mkdir(temp);
  for (const key of ["TMPDIR", "TMP", "TEMP"]) process.env[key] = temp;
  fixture = await nativeWorkspace(t, { manager: manager.config });
  let url = await fixture.listen();
  const initialDatabase = await databaseSize(fixture.root);
  const document = { id: "soak-fixture", operationId: randomUUID(), title: "Synthetic sustained fixture", content: "bounded local traffic" };
  const created = await httpCall(url, fixture.bearer, "capability_call", invocation("knowledge.document.create", document));
  assert.equal(created.status, 200);
  const runId = `soak-${randomUUID()}`;
  assert.equal((await httpCall(url, fixture.bearer, "capability_call", invocation("manager.runtime.start", manager.start(runId)))).status, 200);
  await until(() => manager.calls.published > 0, "held manager worker");
  const run = await httpCall(url, fixture.bearer, "capability_read", invocation("manager.runtime.get", { runId }));
  const cancelStart = performance.now();
  const cancelled = await httpCall(url, fixture.bearer, "capability_call", invocation("manager.runtime.cancel",
    { operationId: randomUUID(), runId, expectedVersion: run.body.result.version }));
  cancelMs = performance.now() - cancelStart;
  assert.equal(cancelled.body.result?.state, "cancelled");
  assert(cancelMs < bounds.maxCancelMs);
  manager.release();
  channel = channelFixture();
  channel.create();
  const worker = channel.admit();
  const managerPeer = channel.runtime.connect(channel.tokens.manager, { channelId: "channel-one" });
  const cancel = new AbortController();
  const waiting = worker.wait({ channelId: "channel-one", timeoutMs: 1000 }, cancel.signal);
  const waitCancelStart = performance.now();
  cancel.abort();
  await assert.rejects(waiting, error => error.code === "WAIT_CANCELLED");
  const waitCancelMs = performance.now() - waitCancelStart;
  assert(waitCancelMs < bounds.maxCancelMs);
  assert.equal(channel.runtime.diagnostics().activeWaits, 0);
  const burstStart = performance.now();
  const burst = await Promise.all(Array.from({ length: 80 }, (_, i) =>
    httpCall(url, fixture.bearer, "capability_call", invocation("knowledge.document.create", {
      id: `backpressure-${i}`, operationId: randomUUID(), title: "Backpressure fixture", content: "small synthetic record",
    }), {}, { signal: AbortSignal.timeout(bounds.maxRequestMs) })));
  const burstBusy = burst.filter(response => response.status === 503 && response.body.error?.code === "BUSY").length;
  const burstAccepted = burst.filter(response => response.status === 200 && response.body.result).length;
  assert.equal(burstBusy + burstAccepted, burst.length);
  const burstMs = performance.now() - burstStart;
  assert(burstMs < bounds.maxRequestMs);
  process.stdout.write = countedWrite(stdoutWrite);
  process.stderr.write = countedWrite(stderrWrite);
  loopDelay.enable();
  const deadline = performance.now() + seconds * 1000;
  let round = 0, afterSeq = 0;
  while (performance.now() < deadline) {
    const roundStart = performance.now();
    const results = await Promise.all(Array.from({ length: bounds.concurrency }, async () => {
      const start = performance.now();
      const response = await httpCall(url, fixture.bearer, "capability_read",
        invocation("knowledge.document.get", { id: document.id }), {}, { signal: AbortSignal.timeout(bounds.maxRequestMs) });
      latencies.push(performance.now() - start);
      if (response.status === 200) { assert.equal(response.body.result.id, document.id); statuses.success++; }
      else if (response.status === 503 && response.body.error?.code === "BUSY") statuses.busy++;
      else throw new Error(`Unexpected HTTP response: ${response.status} ${JSON.stringify(response.body)}`);
    }));
    assert.equal(results.length, bounds.concurrency);
    const channelStart = performance.now();
    const receive = worker.wait({ channelId: "channel-one", afterSeq, timeoutMs: 1000 });
    const sent = managerPeer.send({ ...channel.args(), recipientId: "worker", text: `synthetic-${round}` });
    const delivered = await receive;
    assert(delivered.messages.some(message => message.id === sent.message.id));
    afterSeq = sent.message.seq;
    channelLatencies.push(performance.now() - channelStart);
    assert.equal(channel.runtime.diagnostics().activeWaits, 0);
    if (reconnectMs === null && performance.now() >= deadline - seconds * 500) {
      const reconnectStart = performance.now();
      await fixture.reopen();
      url = await fixture.listen();
      const read = await httpCall(url, fixture.bearer, "capability_read", invocation("knowledge.document.get", { id: document.id }));
      assert.equal(read.body.result?.id, document.id);
      reconnectMs = performance.now() - reconnectStart;
      assert(reconnectMs < bounds.maxReconnectMs);
    }
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    databasePeak = Math.max(databasePeak, await databaseSize(fixture.root));
    round++;
    await sleep(Math.max(0, Math.min(deadline - performance.now(), bounds.intervalMs - (performance.now() - roundStart))));
  }
  loopDelay.disable();
  assert(latencies.length > 0 && statuses.success > 0);
  assert(Math.max(...latencies) < bounds.maxRequestMs);
  assert(Math.max(...channelLatencies) < bounds.maxChannelMs);
  assert(rssPeak - rssBefore < bounds.maxRssGrowthBytes);
  assert(databasePeak - initialDatabase < bounds.maxDatabaseGrowthBytes);
  assert(logBytes < bounds.maxLogBytes);
  assert.deepEqual(await sourceHashes(), beforeHashes, "sources changed during qualification");
  const report = {
    schema: "pkm.storage-sustained-qualification/v1", node: process.version, sources: beforeHashes,
    fixture: "disposable synthetic next-server workspace, loopback HTTP, held Manager and in-memory Channel",
    elapsedMs: Number((performance.now() - started).toFixed(2)), requestedSeconds: seconds,
    http: { requests: latencies.length, ...statuses, p50Ms: percentile(latencies, .5),
      p95Ms: percentile(latencies, .95), p99Ms: percentile(latencies, .99), maxMs: percentile(latencies, 1) },
    channel: { messages: channelLatencies.length, p95Ms: percentile(channelLatencies, .95), cancelledWaits: 1,
      waitCancelMs: Number(waitCancelMs.toFixed(2)) },
    reconnectMs: Number(reconnectMs.toFixed(2)), cancelMs: Number(cancelMs.toFixed(2)),
    rssPeakGrowthBytes: rssPeak - rssBefore, databasePeakGrowthBytes: Math.max(0, databasePeak - initialDatabase),
    eventLoopP95Ms: Number((loopDelay.percentile(95) / 1e6).toFixed(2)),
    backpressure: { attempted: burst.length, accepted: burstAccepted, busy: burstBusy, elapsedMs: Number(burstMs.toFixed(2)) },
    logGrowth: { processStdoutStderrBytes: logBytes, scope: "measured workload interval only; not external log files" },
    bounds, powerLossClaim: false, readinessApproval: false,
  };
  process.stdout.write = stdoutWrite;
  process.stderr.write = stderrWrite;
  console.log("STORAGE_SUSTAINED_QUALIFICATION " + JSON.stringify(report));
  if (process.env.STORAGE_QUALIFICATION_SAVE === "1") {
    await writeFile("tests/storage-fault-qualification-report.json", JSON.stringify(report, null, 2) + "\n");
  }
} finally {
  loopDelay.disable();
  process.stdout.write = stdoutWrite;
  process.stderr.write = stderrWrite;
  manager.release();
  try {
    try { if (channel) { channel.runtime.dispose(); await channel.runtime.drain(); channel.db.close(); } }
    finally { for (const fn of cleanup.reverse()) await fn(); }
  } finally {
    for (const [key, value] of Object.entries(previousTemp)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(temp, { recursive: true, force: true });
  }
}
