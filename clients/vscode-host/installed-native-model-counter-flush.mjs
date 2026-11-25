import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, writeFileSync } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

const schema = "pkm.installed-native-model-counter-flush/v1";
const counterNames = ["nativeCalls", "tokenCalls", "loopCalls", "infoCalls", "registryEvents"];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const failure = code => Object.assign(new Error(code), { code });
const safeCodes = new Set(["FIXTURE_PROVIDER_BUDGET", "FIXTURE_OWNER_BUDGET", "FIXTURE_EXECUTION_BUDGET",
  "FIXTURE_TRANSCRIPT_BUDGET", "FIXTURE_COUNTER_BINDING", "FIXTURE_COUNTER_FLUSH_TIMEOUT",
  "FIXTURE_COUNTER_FLUSH_FAILED", "FIXTURE_COUNTER_HANDLER_REQUIRED", "FIXTURE_COUNTER_ACK_STALE",
  "FIXTURE_COUNTER_SIZE", "FIXTURE_COUNTER_REPLAY", "FIXTURE_COUNTER_INVALID", "NATIVE_CHAT_CANCELLED",
  "NATIVE_CHAT_SESSION_REVOKED", "NATIVE_CHAT_DISPATCH_UNCERTAIN", "ENOENT", "ENOSPC", "EACCES"]);
function safeError(error) {
  try {
    const code = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
    return { code: safeCodes.has(code) ? code : "UNCLASSIFIED" };
  } catch { return { code: "UNCLASSIFIED" }; }
}

export function validateNativeModelTokenPersistence(mode, modelMode, toolRoundLimit) {
  if (mode === undefined || mode === "") return undefined;
  if (!["sync", "buffered"].includes(mode) || !modelMode || toolRoundLimit !== 48)
    throw Object.assign(new Error("The test-only --native-model-token-persistence option requires --native-models --native-model-rounds 48."),
      { code: "FIXTURE_COUNTER_OPTION_REQUIRED_48" });
  return mode;
}
function profile(root) {
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || !basename(root).startsWith(".installed-host-"))
    throw failure("FIXTURE_COUNTER_ROOT");
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700)
    throw failure("FIXTURE_COUNTER_ROOT");
}
function counters(state) {
  const result = {};
  for (const name of counterNames) {
    if (!Number.isSafeInteger(state?.[name]) || state[name] < 0) throw failure("FIXTURE_COUNTER_INVALID");
    result[name] = state[name];
  }
  return result;
}
function binding(config) {
  if (!config || !["sync", "buffered"].includes(config.mode) || config.generation !== 1
    || !/^[a-f0-9-]{36}$/.test(config.runId)) throw failure("FIXTURE_COUNTER_BINDING");
  return { schema, runId: config.runId, generation: 1, mode: config.mode };
}
function matches(value, config) {
  const expected = binding(config);
  if (!value || Object.entries(expected).some(([name, item]) => value[name] !== item))
    throw failure("FIXTURE_COUNTER_BINDING");
}
export function createNativeModelCounterPersistence({ root, getCounters, mode = "sync" }) {
  profile(root);
  if (!["sync", "buffered"].includes(mode) || typeof getCounters !== "function") throw failure("FIXTURE_COUNTER_INVALID");
  const path = join(root, "native-fixture-provider.json");
  let pending, flushed = false;
  function serialize() {
    const state = getCounters(), bytes = JSON.stringify(state);
    if (!bytes || Buffer.byteLength(bytes) > 8192) throw failure("FIXTURE_COUNTER_SIZE");
    counters(state);
    return { state, bytes };
  }
  return Object.freeze({
    persistToken() {
      const { bytes } = serialize();
      if (mode === "sync") writeFileSync(path, bytes);
      else pending = bytes;
    },
    flush() {
      if (flushed) throw failure("FIXTURE_COUNTER_REPLAY");
      flushed = true;
      const { state, bytes } = serialize();
      writeFileSync(path, bytes);
      pending = undefined;
      return { pid: process.pid, counterSha256: digest(bytes), counters: counters(state) };
    },
    bufferedBytes() { return pending ? Buffer.byteLength(pending) : 0; },
  });
}
async function absent(path) {
  try { await lstat(path); throw failure("FIXTURE_COUNTER_ACK_STALE"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
export async function serveNativeModelCounterFlush({ root, config, request, flush }) {
  profile(root);
  const expected = binding(config), path = join(root, "native-model-counter-flush-completed.json");
  await absent(path);
  let receipt, error;
  try {
    matches(request, config);
    if (typeof flush !== "function") throw failure("FIXTURE_COUNTER_HANDLER_REQUIRED");
    receipt = flush();
    if (!Number.isSafeInteger(receipt?.pid) || receipt.pid < 1 || !/^[a-f0-9]{64}$/.test(receipt.counterSha256))
      throw failure("FIXTURE_COUNTER_INVALID");
    counters(receipt.counters);
  } catch (caught) { error = caught; }
  const ack = { ...expected, status: error ? "failed" : "complete",
    ...(error ? { error: safeError(error) } : { pid: receipt.pid, counterSha256: receipt.counterSha256,
      counters: counters(receipt.counters) }) };
  try { await writeFile(path, JSON.stringify(ack), { mode: 0o600, flag: "wx" }); }
  catch (writeError) {
    if (error) throw new AggregateError([error, writeError], "Counter flush and acknowledgement persistence both failed.");
    throw writeError;
  }
  if (error) throw error;
  return ack;
}
export async function requestNativeModelCounterFlush({ root, config, waitJson }) {
  profile(root);
  const request = binding(config), completed = join(root, "native-model-counter-flush-completed.json");
  await absent(completed);
  await writeFile(join(root, "native-model-counter-flush-request.json"), JSON.stringify(request), { mode: 0o600, flag: "wx" });
  let ack;
  try { ack = await waitJson(completed, 3000); }
  catch (error) {
    throw Object.assign(failure(error.code && error.code !== "FIXTURE_COUNTER_FLUSH_TIMEOUT"
      ? "FIXTURE_COUNTER_FLUSH_FAILED" : "FIXTURE_COUNTER_FLUSH_TIMEOUT"), { cause: error });
  }
  matches(ack, config);
  if (ack.status !== "complete") throw Object.assign(failure("FIXTURE_COUNTER_FLUSH_FAILED"),
    { acknowledgement: { ...binding(config), status: "failed", error: safeError(ack.error) } });
  if (!Number.isSafeInteger(ack.pid) || ack.pid < 1 || !/^[a-f0-9]{64}$/.test(ack.counterSha256))
    throw failure("FIXTURE_COUNTER_INVALID");
  const bytes = await readFile(join(root, "native-fixture-provider.json"));
  if (digest(bytes) !== ack.counterSha256) throw failure("FIXTURE_COUNTER_BINDING");
  assert.deepEqual(counters(JSON.parse(bytes)), counters(ack.counters));
  return { ...binding(config), status: "complete", pid: ack.pid, counterSha256: ack.counterSha256, counters: counters(ack.counters) };
}
export async function finalizeNativeModelExecution({ root, result, executionError, timing, observedCounts, config, waitJson }) {
  profile(root);
  const path = join(root, "native-model-execution-outcome.json");
  const outcome = { schema: "pkm.installed-model-execution-outcome/v1", status: result?.status ?? "threw",
    result: result ?? null, toolRoundLimit: result?.toolRoundLimit ?? null,
    ...(executionError ? { executionError: safeError(executionError) } : {}),
    ...observedCounts, ...timing };
  const errors = executionError ? [executionError] : [];
  try { await writeFile(path, JSON.stringify(outcome), { mode: 0o600 }); }
  catch (error) { errors.push(error); }
  if (errors.length > (executionError ? 1 : 0)) {
    if (errors.length === 1) throw errors[0];
    throw Object.assign(new AggregateError(errors, "Model execution and outcome persistence failed."), { executionOutcome: outcome });
  }
  let counterFlush;
  if (config) {
    try {
      counterFlush = await requestNativeModelCounterFlush({ root, config, waitJson });
      outcome.counterFlush = { status: "complete", acknowledgement: counterFlush };
    } catch (error) {
      errors.push(error);
      if (!executionError && result?.status !== "complete") errors.unshift(failure("FIXTURE_MODEL_EXECUTION_NOT_COMPLETE"));
      outcome.counterFlush = { status: "failed", error: safeError(error), ...(error.acknowledgement ? { acknowledgement: error.acknowledgement } : {}) };
    }
    try { await writeFile(path, JSON.stringify(outcome), { mode: 0o600 }); }
    catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw Object.assign(new AggregateError(errors, "Model execution and counter-flush failures are both retained."), { executionOutcome: outcome });
  return { outcome, counterFlush };
}
