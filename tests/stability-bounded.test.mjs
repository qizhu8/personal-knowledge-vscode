import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { encodeMarkdown, sha256 } from "../dist/markdown.js";
import { Storage, initialize } from "../dist/storage.js";
import { httpCall, invocation, managerActor, nativeWorkspace, syntheticManager } from "./batch06-manager-fixtures.mjs";

const request = (operation, args) => ({ operation, actorId: "test:crash-owner", args });

test("bounded actual-socket queue, reconnect and durable reads stay within test-local latency and memory bounds", { timeout: 60_000 }, async t => {
  const profile = {
    requests: 40,
    maxRunMs: 60_000,
    maxRequestMs: 10_000,
    maxRssGrowthBytes: 128 * 1024 * 1024,
  };
  const rssBefore = process.memoryUsage().rss;
  const startedAt = performance.now();
  const fixture = await nativeWorkspace(t);
  let url = await fixture.listen();
  const latencies = [];
  const calls = Array.from({ length: profile.requests }, async (_, index) => {
    const id = `bounded-${index}`;
    const begin = performance.now();
    const response = await httpCall(url, fixture.bearer, "capability_call", invocation("knowledge.document.create", {
      id, operationId: randomUUID(), title: `Fixture ${index}`, content: "small synthetic stability record",
    }));
    latencies.push(performance.now() - begin);
    return { id, ...response };
  });
  const responses = await Promise.all(calls);
  const accepted = responses.filter(response => response.status === 200 && response.body.result);
  const busy = responses.filter(response => response.status === 503 && response.body.error?.code === "BUSY");
  assert.equal(accepted.length + busy.length, profile.requests, "only successful writes or explicit bounded-queue rejections");
  assert(accepted.length > 0);
  const maximumRequestMs = Math.max(...latencies);
  assert(maximumRequestMs < profile.maxRequestMs, `max socket request ${maximumRequestMs.toFixed(1)} ms`);

  const firstId = accepted[0].id;
  await fixture.close();
  await fixture.reopen();
  url = await fixture.listen();
  const reconnectedAt = performance.now();
  const afterReconnect = await httpCall(url, fixture.bearer, "capability_read", invocation("knowledge.document.get", { id: firstId }));
  const reconnectMs = performance.now() - reconnectedAt;
  assert.equal(afterReconnect.status, 200, JSON.stringify(afterReconnect.body));
  assert.equal(afterReconnect.body.result.id, firstId);
  assert(reconnectMs < profile.maxRequestMs);
  const totalMs = performance.now() - startedAt;
  const rssGrowthBytes = Math.max(0, process.memoryUsage().rss - rssBefore);
  assert(totalMs < profile.maxRunMs);
  assert(rssGrowthBytes < profile.maxRssGrowthBytes);
  console.log(`STABILITY_BOUNDED_RESULTS ${JSON.stringify({
    scope: "synthetic temporary workspace; actual loopback HTTP; concurrent create queue; runtime close/reopen; durable get",
    requests: profile.requests, accepted: accepted.length, explicitBusy: busy.length,
    maxRequestMs: Number(maximumRequestMs.toFixed(2)), reconnectReadMs: Number(reconnectMs.toFixed(2)),
    totalMs: Number(totalMs.toFixed(2)), rssGrowthBytes,
    testBounds: profile, powerLossClaim: false,
  })}`);
});

test("Manager live durable events and cancellation retry burst fence held work over real HTTP", { timeout: 40_000 }, async t => {
  const manager = syntheticManager("feature", 4, { hold: true, publish: true });
  let signalWorkerStarted;
  const workerStarted = new Promise(resolve => { signalWorkerStarted = resolve; });
  const worker = manager.host.worker;
  manager.host.worker = async (input, signal) => {
    signalWorkerStarted();
    return worker(input, signal);
  };
  const fixture = await nativeWorkspace(t, { manager: manager.config });
  const url = await fixture.listen();
  const runId = `cancel-burst-${randomUUID()}`;
  const started = await httpCall(url, fixture.bearer, "capability_call",
    invocation("manager.runtime.start", manager.start(runId)));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  await workerStarted;

  const initialEvents = await httpCall(url, fixture.bearer, "capability_read",
    invocation("manager.runtime.events", { runId, afterSeq: 0, limit: 100 }));
  assert.equal(initialEvents.status, 200);
  assert(initialEvents.body.result.items.some(event => event.type === "worker.intent"));
  const current = await httpCall(url, fixture.bearer, "capability_read",
    invocation("manager.runtime.get", { runId }));
  const cancel = {
    operationId: randomUUID(), runId, expectedVersion: current.body.result.version,
  };
  const burstSize = 8;
  const began = performance.now();
  const [cancellations, liveReads] = await Promise.all([
    Promise.all(Array.from({ length: burstSize }, () =>
      httpCall(url, fixture.bearer, "capability_call", invocation("manager.runtime.cancel", cancel)))),
    Promise.all(Array.from({ length: burstSize }, (_, index) =>
      httpCall(url, fixture.bearer, "capability_read", invocation("manager.runtime.events", {
        runId, afterSeq: index, limit: 100,
      })))),
  ]);
  const cancelBurstMs = performance.now() - began;
  assert(cancellations.every(response => response.status === 200 && response.body.result?.state === "cancelled"));
  assert(liveReads.every(response => response.status === 200));
  const finalEvents = await httpCall(url, fixture.bearer, "capability_read",
    invocation("manager.runtime.events", { runId, afterSeq: 0, limit: 100 }));
  assert(finalEvents.body.result.items.some(event => event.type === "run.cancelled"));
  assert(cancelBurstMs < 10_000, `test-local burst bound: ${cancelBurstMs.toFixed(1)} ms`);
  manager.release();
  const final = await httpCall(url, fixture.bearer, "capability_read",
    invocation("manager.runtime.get", { runId }));
  assert.equal(final.body.result.state, "cancelled");
  console.log(`STABILITY_MANAGER_RESULTS ${JSON.stringify({
    scope: "synthetic held Manager worker; actual loopback HTTP; durable live-event reads; identical cancellation retry burst",
    burstRequests: burstSize, eventReads: liveReads.length, elapsedMs: Number(cancelBurstMs.toFixed(2)),
    finalState: final.body.result.state, testBoundMs: 10_000,
  })}`);
});

async function crashProcess(root, phase, payload = {}) {
  const script = `
(async () => {
const { DatabaseSync } = await import("node:sqlite");
const { writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { encodeMarkdown, sha256 } = await import("./dist/markdown.js");
const { Storage } = await import("./dist/storage.js");
const root=process.argv[1], phase=process.argv[2], id="crash-"+phase;
const operationId=process.argv[3], actorId="test:crash-owner", title="Crash fixture", content="synthetic recovery body";
const args={id,operationId,title,content}, operation="knowledge.document.create";
const request={operation,actorId,args}, raw=encodeMarkdown(id,title,content,1,false);
if (phase==="after-receipt") {
  const storage=await Storage.open(root);
  await storage.request(request);
  process.kill(process.pid,"SIGKILL");
}
if (phase==="before-journal") process.kill(process.pid,"SIGKILL");
const db=new DatabaseSync(join(root,"core.sqlite"));
db.prepare("INSERT INTO pending_write(singleton,operation_id,fingerprint,actor_id,operation,document_id,before_sha256,after_markdown) VALUES(1,?,?,?,?,?,?,?)")
  .run(operationId,sha256(JSON.stringify(request)),actorId,operation,id,null,raw);
db.close();
if (phase==="before-receipt") writeFileSync(join(root,"notes",id+".md"),raw);
process.kill(process.pid,"SIGKILL");
})().catch(error => { console.error(error); process.exitCode=1; });
`;
  const child = spawn(process.execPath, ["-e", script, root, phase, payload.operationId], {
    cwd: resolve("."), env: { PATH: process.env.PATH ?? "" }, stdio: ["ignore", "ignore", "pipe"],
  });
  let diagnostics = "";
  child.stderr.on("data", bytes => { diagnostics += bytes; });
  const [code, signal] = await once(child, "exit");
  assert.equal(code, null, diagnostics);
  assert.equal(signal, "SIGKILL", diagnostics);
}

test("subprocess crashes before/after journal and receipt recover deterministically without power-loss claims", { timeout: 40_000 }, async t => {
  const rootParent = resolve("tests", `.stability-crash-${randomUUID()}`);
  await mkdir(rootParent, { recursive: true });
  t.after(() => rm(rootParent, { recursive: true, force: true }));
  const outcomes = [];
  for (const phase of ["before-journal", "after-journal", "before-receipt", "after-receipt"]) {
    const root = join(rootParent, phase);
    await initialize(root);
    const initializer = await Storage.open(root);
    await initializer.close();
    const operationId = randomUUID();
    await crashProcess(root, phase, { operationId });
    const lease = new DatabaseSync(join(root, "core.sqlite"));
    try { lease.prepare("UPDATE native_runtime_owner SET lease_until=0 WHERE singleton=1").run(); }
    finally { lease.close(); }
    const recovered = await Storage.open(root);
    try {
      if (phase === "before-journal") {
        await assert.rejects(recovered.request({ operation: "knowledge.document.get", args: { id: "crash-before-journal" }, actorId: "test:reader" }),
          /not found/i);
        outcomes.push({ phase, recovered: "no intent" });
        continue;
      }
      const read = await recovered.request({
        operation: "knowledge.document.get", args: { id: `crash-${phase}` }, actorId: "test:reader",
      });
      assert.equal(read.id, `crash-${phase}`);
      const replay = await recovered.request(request("knowledge.document.create", {
        id: `crash-${phase}`, operationId, title: "Crash fixture", content: "synthetic recovery body",
      }));
      assert.equal(replay.id, `crash-${phase}`);
      outcomes.push({ phase, recovered: "one durable receipt" });
    } finally { await recovered.close(); }
  }
  console.log(`STABILITY_CRASH_RESULTS ${JSON.stringify({
    scope: "synthetic disposable workspaces; child-process SIGKILL at named process-exit phases; ordinary reopen and journal recovery",
    phases: outcomes, powerLossClaim: false,
  })}`);
  assert.equal(outcomes.length, 4);
});
