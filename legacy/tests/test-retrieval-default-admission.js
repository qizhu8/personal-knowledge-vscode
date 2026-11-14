"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { RetrievalWorkerManager } = require(path.join(process.env.PKM_TEST_DIST || path.resolve("dist"), "retrieval/retrieval-worker"));
const { ManagedWriterAdmissionDenied } = require(path.join(process.env.PKM_TEST_DIST || path.resolve("dist"), "runtime/managed-writer-session"));

const endpoint = { pid: 123, port: 4321, token: "fixture" };
const manager = owner => new RetrievalWorkerManager("/unused/state", "/unused/worker.py", "/unused/python", "fixture", undefined, undefined, owner);
const tick = () => new Promise(resolve => setImmediate(resolve));

test("ordinary Linux manager closes local admission and waits for admitted work without stopping its shared worker",
  { skip: process.platform !== "linux" }, async () => {
    const current = manager();
    let release, requests = 0;
    current.ensureInner = () => new Promise(resolve => { release = () => resolve(endpoint); });
    current.request = async () => { requests++; throw new Error("No worker shutdown is allowed"); };
    const active = current.ensure();
    await tick();
    const closing = current.closeOwned(5000);
    const late = current.ensure().then(() => "admitted", error => error.message);
    const lateBeforeRelease = await Promise.race([late, new Promise(resolve => setTimeout(() => resolve("pending"), 30))]);
    let settled = false;
    void closing.then(() => { settled = true; });
    await tick();
    assert.equal(settled, false);
    release();
    assert.equal((await active).pid, endpoint.pid);
    assert.equal(await closing, "unused");
    assert.match(lateBeforeRelease, /admission is closed/i);
    assert.equal(requests, 0);
    await assert.rejects(current.status(), /admission is closed/i);
  });

test("concurrent closes share one owner request and a failed outcome is not retried",
  { skip: process.platform !== "linux" }, async () => {
    for (const fail of [false, true]) {
      const current = manager({ hostId: "fixture", pid: process.pid, startTimeTicks: "1" });
      current.registration = { endpoint, start: "5" };
      current.workerStart = () => ({ start: "5", stopped: false });
      let release, calls = 0;
      current.request = () => {
        calls++;
        return new Promise((resolve, reject) => {
          release = () => fail ? reject(new Error("unknown close outcome")) :
            resolve({ ok: true, remaining: 1, shutdown: false, unknown: false });
        });
      };
      const first = current.closeOwned(5000), second = current.closeOwned(5000);
      assert.equal(first, second);
      await tick();
      assert.equal(calls, 1);
      release();
      if (fail) {
        await assert.rejects(first, /unknown close outcome/);
        await assert.rejects(current.closeOwned(), /unknown close outcome/);
      } else {
        assert.equal(await first, "shared");
        assert.equal(await second, "shared");
      }
      assert.equal(calls, 1);
    }
  });

test("local drain does not claim a submitted build after worker identity changes",
  { skip: process.platform !== "linux" }, async () => {
    const current = manager();
    current.submittedBuilds.set("fixture", { endpoint, revision: "revision", start: "5" });
    current.workerStart = () => ({ start: "6", stopped: false });
    current.readEndpoint = () => endpoint;
    current.request = async () => { throw new Error("must not reach replacement worker"); };
    await assert.rejects(current.quiesceLocal(100), /identity changed.*unknown/i);
    await assert.rejects(current.closeOwned(), /identity changed.*unknown/i);
  });

test("a submitted build that never reaches its revision stays unknown on timeout",
  { skip: process.platform !== "linux" }, async () => {
    const current = manager();
    current.submittedBuilds.set("fixture", { endpoint, revision: "revision", start: "5" });
    current.workerStart = () => ({ start: "5", stopped: false });
    current.readEndpoint = () => endpoint;
    current.request = async () => ({ pid: endpoint.pid, ready: true, corpus_revision: "other", building_revision: "" });
    await assert.rejects(current.quiesceLocal(30), /timed out.*unknown/i);
  });

test("fence refusal before dispatch is not an unknown in-flight worker request",
  { skip: process.platform !== "linux" }, async () => {
    let release, dispatched = false;
    const current = new RetrievalWorkerManager("/unused/state", "/unused/worker.py", "/unused/python", "fixture",
      undefined, undefined, undefined, undefined, async () => {
        await new Promise(resolve => { release = resolve; });
        throw new ManagedWriterAdmissionDenied("session fenced before dispatch");
      });
    current.ensureInner = async () => { dispatched = true; return endpoint; };
    const active = current.ensure();
    const rejected = assert.rejects(active, /fenced before dispatch/);
    await tick();
    const draining = current.quiesceLocal(1000);
    release();
    await rejected;
    await draining;
    assert.equal(dispatched, false);
  });

test("a refusal after dispatch remains an unknown in-flight worker outcome",
  { skip: process.platform !== "linux" }, async () => {
    let release;
    const current = new RetrievalWorkerManager("/unused/state", "/unused/worker.py", "/unused/python", "fixture",
      undefined, undefined, undefined, undefined, work => work());
    current.ensureInner = () => new Promise((_resolve, reject) => {
      release = () => reject(new ManagedWriterAdmissionDenied("nested fence after dispatch"));
    });
    const active = current.ensure();
    const rejected = assert.rejects(active, /nested fence/);
    await tick();
    const draining = current.quiesceLocal(1000);
    release();
    await rejected;
    await assert.rejects(draining, /unknown/);
  });
