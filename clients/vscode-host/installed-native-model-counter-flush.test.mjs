import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createNativeModelCounterPersistence, finalizeNativeModelExecution, requestNativeModelCounterFlush,
  serveNativeModelCounterFlush, validateNativeModelTokenPersistence } from "./installed-native-model-counter-flush.mjs";

function fixture(t, mode = "sync") {
  const root = resolve("clients/vscode-host", `.installed-host-counter-b68245d4-${randomUUID()}`);
  mkdirSync(root, { mode: 0o700 });
  const pin = lstatSync(root, { bigint: true });
  t.after(async () => {
    const current = lstatSync(root, { bigint: true });
    assert.equal(current.dev, pin.dev); assert.equal(current.ino, pin.ino); assert.equal(current.uid, pin.uid);
    await rm(root, { recursive: true });
  });
  const state = { scope: "synthetic deterministic native provider; not a remote model or production keyring",
    nativeCalls: 0, tokenCalls: 0, loopCalls: 0, infoCalls: 0, registryEvents: 0 };
  const config = { mode, runId: randomUUID(), generation: 1 }, path = join(root, "native-fixture-provider.json");
  const persistence = createNativeModelCounterPersistence({ root, mode, getCounters: () => ({ ...state }) });
  return { root, config, path, state, persistence };
}
const timing = { executionStartedEpochMs: 1, executionEndedEpochMs: 2, executionDurationMs: 1 };
const observedCounts = { observedToolCalls: 26, observedInferenceCalls: 27 };
const result = { status: "unknown", toolRoundLimit: { limit: 48, rounds: 26, reached: false } };

test("default sync serializes current counters at each token while buffered tokens preserve non-token writes and flush true state", async t => {
  const a = fixture(t);
  const defaultPersistence = createNativeModelCounterPersistence({ root: a.root, getCounters: () => ({ ...a.state }) });
  a.state.tokenCalls++; defaultPersistence.persistToken();
  assert.equal(await readFile(a.path, "utf8"), JSON.stringify(a.state));
  a.state.tokenCalls++; defaultPersistence.persistToken();
  assert.equal(JSON.parse(await readFile(a.path)).tokenCalls, 2);
  const b = fixture(t, "buffered");
  writeFileSync(b.path, JSON.stringify(b.state));
  b.state.tokenCalls++; b.persistence.persistToken();
  assert.equal(JSON.parse(await readFile(b.path)).tokenCalls, 0);
  b.state.nativeCalls++;
  writeFileSync(b.path, JSON.stringify(b.state));
  b.state.tokenCalls++; b.persistence.persistToken();
  assert.equal(JSON.parse(await readFile(b.path)).tokenCalls, 1);
  assert(b.persistence.bufferedBytes() > 0 && b.persistence.bufferedBytes() <= 8192);
  b.state.infoCalls = 4; b.state.registryEvents = 2;
  const receipt = b.persistence.flush();
  assert.equal(await readFile(b.path, "utf8"), JSON.stringify(b.state));
  assert.deepEqual(receipt.counters, { nativeCalls: 1, tokenCalls: 2, loopCalls: 0, infoCalls: 4, registryEvents: 2 });
  assert.equal(b.persistence.bufferedBytes(), 0);
  assert.throws(() => b.persistence.flush(), { code: "FIXTURE_COUNTER_REPLAY" });
});

test("actual CLI rejects token persistence without the exact model48 experiment before starting a fixture", () => {
  for (const args of [
    ["--native-model-token-persistence", "sync"],
    ["--native-identity", "--native-models", "--native-model-token-persistence", "buffered"],
  ]) {
    const child = spawnSync(process.execPath, ["clients/vscode-host/installed-test.mjs", ...args], { encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, 1);
    assert(child.stderr.includes("FIXTURE_COUNTER_OPTION_REQUIRED_48"));
    assert(!child.stderr.includes("unshare failed"));
  }
});

test("counter persistence option is opt-in to model48 and does not change absent/default mode", () => {
  assert.equal(validateNativeModelTokenPersistence(undefined, false, 31), undefined);
  assert.equal(validateNativeModelTokenPersistence("", true, 48), undefined);
  assert.equal(validateNativeModelTokenPersistence("sync", true, 48), "sync");
  for (const args of [["buffered", true, 31], ["sync", false, 48], ["invalid", true, 48]])
    assert.throws(() => validateNativeModelTokenPersistence(...args), { code: "FIXTURE_COUNTER_OPTION_REQUIRED_48" });
});

test("structured unknown is durable before flush request and true receipt validation", async t => {
  const f = fixture(t, "buffered");
  Object.assign(f.state, { nativeCalls: 27, tokenCalls: 796, loopCalls: 26, infoCalls: 35, registryEvents: 2 });
  f.persistence.persistToken();
  const finalized = await finalizeNativeModelExecution({
    root: f.root, config: f.config, result, timing, observedCounts,
    waitJson: async (path, timeout) => {
      assert.equal(timeout, 3000);
      const stored = JSON.parse(await readFile(join(f.root, "native-model-execution-outcome.json")));
      assert.deepEqual(stored.result, result);
      assert.equal(stored.observedToolCalls, 26);
      const request = JSON.parse(await readFile(join(f.root, "native-model-counter-flush-request.json")));
      await serveNativeModelCounterFlush({ root: f.root, config: f.config, request, flush: () => f.persistence.flush() });
      return JSON.parse(await readFile(path));
    },
  });
  assert.equal(finalized.outcome.status, "unknown");
  assert.equal(finalized.counterFlush.mode, "buffered");
  assert.equal(finalized.counterFlush.counters.tokenCalls, 796);
  assert.equal(finalized.outcome.counterFlush.status, "complete");
});

test("stale generation/run/ack cannot invoke the provider flush or become a receipt fallback", async t => {
  const f = fixture(t);
  let called = false;
  const request = { schema: "pkm.installed-native-model-counter-flush/v1", ...f.config, generation: 2 };
  await assert.rejects(serveNativeModelCounterFlush({ root: f.root, config: f.config, request, flush() { called = true; } }),
    { code: "FIXTURE_COUNTER_BINDING" });
  assert.equal(called, false);
  const ack = JSON.parse(await readFile(join(f.root, "native-model-counter-flush-completed.json")));
  assert.equal(ack.status, "failed");
  await assert.rejects(requestNativeModelCounterFlush({ root: f.root, config: f.config, waitJson: () => ack }),
    { code: "FIXTURE_COUNTER_ACK_STALE" });
  assert(!(await readdir(f.root)).includes("native-model-counter-flush-request.json"));
});

test("missing flush retains both original execution exception and timeout without raw exception logging", async t => {
  const f = fixture(t, "buffered"), original = new Error("fixture-private-execution-error");
  await assert.rejects(finalizeNativeModelExecution({
    root: f.root, config: f.config, executionError: original, timing, observedCounts,
    waitJson: async () => { throw Object.assign(new Error("fixture-private-timeout"), { code: "FIXTURE_COUNTER_FLUSH_TIMEOUT" }); },
  }), error => {
    assert(error instanceof AggregateError);
    assert.equal(error.errors[0], original);
    assert.equal(error.errors[1].code, "FIXTURE_COUNTER_FLUSH_TIMEOUT");
    return true;
  });
  const stored = await readFile(join(f.root, "native-model-execution-outcome.json"), "utf8");
  assert.equal(JSON.parse(stored).status, "threw");
  assert.equal(JSON.parse(stored).counterFlush.status, "failed");
  assert(!stored.includes("fixture-private"));
});

test("provider headroom failure blocks flush, is acknowledged and remains paired with unknown execution", async t => {
  const f = fixture(t), budget = Object.assign(new Error("fixture-private-budget"), { code: "FIXTURE_PROVIDER_BUDGET" });
  await assert.rejects(finalizeNativeModelExecution({
    root: f.root, config: f.config, result, timing, observedCounts,
    waitJson: async path => {
      const request = JSON.parse(await readFile(join(f.root, "native-model-counter-flush-request.json")));
      await assert.rejects(serveNativeModelCounterFlush({ root: f.root, config: f.config, request, flush() { throw budget; } }),
        error => error === budget);
      return JSON.parse(await readFile(path));
    },
  }), error => {
    assert.equal(error.executionOutcome.status, "unknown");
    assert.equal(error.errors[0].code, "FIXTURE_MODEL_EXECUTION_NOT_COMPLETE");
    assert.equal(error.errors[1].code, "FIXTURE_COUNTER_FLUSH_FAILED");
    return true;
  });

  const outcome = JSON.parse(await readFile(join(f.root, "native-model-execution-outcome.json")));
  assert.equal(outcome.counterFlush.acknowledgement.error.code, "FIXTURE_PROVIDER_BUDGET");
  assert(!JSON.stringify(outcome).includes("fixture-private"));
});

test("default execution finalization preserves the outcome and does not start counter protocol", async t => {
  const f = fixture(t);
  const finalized = await finalizeNativeModelExecution({ root: f.root, result, timing, observedCounts,
    waitJson() { assert.fail("Default flow must not add a flush wait."); } });
  assert.equal(finalized.outcome.status, "unknown");
  assert.equal(finalized.counterFlush, undefined);
  assert.deepEqual(await readdir(f.root), ["native-model-execution-outcome.json"]);
});
