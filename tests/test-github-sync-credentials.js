const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { readStoredGitHubSyncCredentials, GitHubSyncCredentialError } = require("../dist/sync/github-sync-credentials");
const { GitHubSyncScheduler, githubSyncFailureDetails, isGitHubSyncAuthenticationFailure } = require("../dist/sync/github-sync-scheduler");
const { normalizeGitHubSyncTarget } = require("../dist/sync/github-sync");

const target = normalizeGitHubSyncTarget({ id:"share", name:"CreativeGen Share",
  repository:"https://github.com/example/fixture.git", authentication:{ method:"vscode", expectedLogin:"Fixture" } });
const valid = JSON.stringify({ accountLabel:"fixture", accessToken:"fixture-secret" });
const extension = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
const settle = () => new Promise(resolve => setImmediate(resolve));

test("credential reads accept matching accounts and bypass secret storage for non-VS Code authentication", async () => {
  assert.deepEqual(await readStoredGitHubSyncCredentials(async () => valid, target), { accessToken:"fixture-secret" });
  assert.equal(await readStoredGitHubSyncCredentials(() => assert.fail("must not read storage"), {
    ...target, authentication:undefined,
  }), undefined);
});

test("default credential deadline is exactly 10 seconds and releases the waiting operation", async t => {
  t.mock.timers.enable({ apis:["setTimeout"] });
  let finished = false;
  const read = readStoredGitHubSyncCredentials(() => new Promise(() => {}), target);
  const rejection = assert.rejects(read, error => {
    finished = true;
    assert.equal(error.code, "CREDENTIAL_READ_TIMEOUT");
    assert.equal(error.phase, "authenticating");
    assert.match(error.message, /10 seconds.*Reload.*GitHub was not contacted/);
    return true;
  });
  t.mock.timers.tick(9_999);
  await Promise.resolve();
  assert.equal(finished, false);
  t.mock.timers.tick(1);
  await rejection;
});

test("a late secret result cannot resume Sync and late failures are handled", async () => {
  for (const rejected of [false, true]) {
    let resolveRead, rejectRead, syncs = 0;
    const read = readStoredGitHubSyncCredentials(() => new Promise((resolve, reject) => {
      resolveRead = resolve; rejectRead = reject;
    }), target, 5).then(() => { syncs++; });
    await assert.rejects(read, { code:"CREDENTIAL_READ_TIMEOUT" });
    if (rejected) rejectRead(new Error("late storage failure"));
    else resolveRead(valid);
    await settle();
    assert.equal(syncs, 0);
  }
});

test("cancellation and storage failure have distinct stable codes and never echo secret/error payloads", async () => {
  for (const error of [Object.assign(new Error("Canceled"), { name:"Canceled" }), new Error("Canceled"),
    Object.assign(new Error("stop"), { name:"CancellationError" })]) {
    await assert.rejects(readStoredGitHubSyncCredentials(async () => { throw error; }, target), {
      code:"CREDENTIAL_READ_CANCELED", phase:"authenticating",
    });
  }
  await assert.rejects(readStoredGitHubSyncCredentials(() => { throw new Error("fixture-secret"); }, target), error => {
    assert.equal(error.code, "CREDENTIAL_READ_FAILED");
    assert(!error.message.includes("fixture-secret"));
    return true;
  });
});

test("missing, malformed and wrong-account credentials stop before any Git work", async () => {
  for (const [raw, code] of [[undefined,"CREDENTIAL_MISSING"], ["{fixture-secret","CREDENTIAL_INVALID"],
    ["null","CREDENTIAL_INVALID"], ["{}","CREDENTIAL_INVALID"],
    [JSON.stringify({ accessToken:"fixture-secret", accountLabel:3 }),"CREDENTIAL_INVALID"],
    [JSON.stringify({ accessToken:"fixture-secret", accountLabel:"another" }),"CREDENTIAL_ACCOUNT_MISMATCH"]]) {
    await assert.rejects(readStoredGitHubSyncCredentials(async () => raw, target), error => {
      assert.equal(error.code, code);
      assert(!error.message.includes("fixture-secret"));
      return true;
    });
  }
});

test("scheduler and persisted target normalization preserve failure code, phase and retry count across reload", async () => {
  let calls = 0;
  const scheduler = new GitHubSyncScheduler({ execute:async () => {
    calls++;
    throw new GitHubSyncCredentialError("CREDENTIAL_READ_CANCELED", "Reload this window, then retry Sync.");
  } });
  const automatic = { id:"share", enabled:false, intervalMinutes:5, syncOnChange:false };
  try {
    scheduler.configure([automatic]);
    assert(scheduler.request("share", "manual"));
    for (let i=0; i<10 && scheduler.snapshot().share.status !== "error"; i++) await settle();
    const state = scheduler.snapshot().share;
    assert.equal(state.status, "error");
    assert.equal(state.lastErrorCode, "CREDENTIAL_READ_CANCELED");
    assert.equal(state.lastErrorPhase, "authenticating");
    assert.equal(calls, 1);
    assert.equal(automatic.enabled, false, "manual failure must not enable Auto or automatically retry");
    const persisted = normalizeGitHubSyncTarget({ ...target, lastFailure:{ ...automatic.lastFailure, attempts:3 } });
    assert.equal(persisted.lastFailure.errorCode, state.lastErrorCode);
    assert.equal(persisted.lastFailure.phase, state.lastErrorPhase);
    assert.equal(persisted.lastFailure.attempts, 3);
    const unsafe = normalizeGitHubSyncTarget({ ...target, lastFailure:{ ...automatic.lastFailure, retryable:false } });
    assert.equal(unsafe.lastFailure.retryable, false, "an unsafe-to-retry decision survives target normalization");
    assert.equal(isGitHubSyncAuthenticationFailure(unsafe.lastFailure), false);
    scheduler.configure([{ ...automatic, lastFailure:persisted.lastFailure }]);
    assert.equal(scheduler.snapshot().share.lastErrorCode, state.lastErrorCode);
    assert.equal(scheduler.snapshot().share.lastErrorPhase, state.lastErrorPhase);
  } finally { scheduler.dispose(); }
});

test("account-state rendering isolates credential failures and returns other targets instead of hanging or exposing tokens", async () => {
  const start = extension.indexOf("  const connected: Record<string, boolean> = {};");
  const end = extension.indexOf("  targets = readGitHubSyncTargets(context);", start);
  assert(start > 0 && end > start);
  const warnings = [];
  const sandbox = { targets:[target, { ...target, id:"healthy" }], context:{},
    readGitHubSyncCredentials:(_context, t) => readStoredGitHubSyncCredentials(
      () => t.id === "healthy" ? Promise.resolve(valid) : new Promise(() => {}), t, 5),
    githubSyncFailureDetails, log:{ warn:message => warnings.push(message) } };
  vm.createContext(sandbox);
  vm.runInContext(ts.transpileModule(`async function run() {
    ${extension.slice(start, end)}
    return { connected, credentialErrors };
  }`, { compilerOptions:{ target:ts.ScriptTarget.ES2020 } }).outputText, sandbox);
  const state = await sandbox.run();
  assert.equal(state.connected.healthy, true);
  assert.equal(state.connected.share, undefined, "failed access is not reported as proven disconnected");
  assert.equal(state.credentialErrors.share.errorCode, "CREDENTIAL_READ_TIMEOUT");
  assert.equal(warnings.length, 1);
  assert(!JSON.stringify(state).includes("fixture-secret"));
});

test("saving a target does not launch reauthentication when VS Code credential storage is unresponsive", async () => {
  const start = extension.indexOf("async function authorizeGitHubSyncTarget(");
  const end = extension.indexOf("\nfunction updateGitHubSyncBackgroundTask", start);
  let reconnects = 0;
  const error = new GitHubSyncCredentialError("CREDENTIAL_READ_TIMEOUT", "Reload then retry");
  const sandbox = { GitHubSyncCredentialError, readGitHubSyncCredentials:async () => { throw error; },
    probeGitHubSyncVscodeAuthentication:() => assert.fail("no GitHub probe"),
    connectGitHubSyncVscodeAccount:async () => { reconnects++; } };
  vm.createContext(sandbox);
  vm.runInContext(ts.transpileModule(extension.slice(start, end), {
    compilerOptions:{ target:ts.ScriptTarget.ES2020 },
  }).outputText, sandbox);
  await assert.rejects(sandbox.authorizeGitHubSyncTarget({}, target), { code:"CREDENTIAL_READ_TIMEOUT" });
  assert.equal(reconnects, 0);
});

test("actual Host execution persists and logs an authentication timeout without entering Fetch or Push", async () => {
  const start = extension.indexOf("      execute: (targetId, reason) => {");
  const end = extension.indexOf("\n      onState:", start);
  assert(start > 0 && end > start);
  const phases = [], events = [], errors = [], saved = { ...target };
  class UnrelatedError extends Error {}
  const sandbox = {
    Error, context:{}, randomUUID:() => "fixture-trace",
    withGitHubSyncTargetLock:async (_context, _id, run) => run(),
    withGitHubSyncApplyLock:async (_context, run) => run(),
    githubSyncTargetById:() => saved,
    githubSyncForceUpdateAudit:new Map(), panels:{ instances:new Map() },
    githubSyncScheduler:{ report:(_id, phase) => phases.push(phase), snapshot:() => ({}),
      acknowledgeExecutionErrors:async () => {} },
    githubSyncDiagnostics:{ record:(event, fields) => events.push({ event, ...fields }) },
    readGitHubSyncCredentials:() => readStoredGitHubSyncCredentials(() => new Promise(() => {}), target, 5),
    githubSyncFailureDetails, isGitHubSyncAuthenticationFailure,
    mutateGitHubSyncTargets:async (_context, _owner, mutation) => mutation([saved]),
    GitHubSyncContentRepairError:UnrelatedError, GitHubSyncExtensionCompatibilityError:UnrelatedError,
    GitHubSyncConflictError:UnrelatedError, PkmServiceRecoveryPersistenceError:UnrelatedError,
    GitHubSyncDeferredError:UnrelatedError,
    log:{ error:message => errors.push(message) },
  };
  vm.createContext(sandbox);
  vm.runInContext(ts.transpileModule(`const options = { ${extension.slice(start, end)} };
    globalThis.execute = options.execute;`, {
    compilerOptions:{ target:ts.ScriptTarget.ES2020 },
  }).outputText, sandbox);
  await assert.rejects(sandbox.execute("share", "manual"), { code:"CREDENTIAL_READ_TIMEOUT" });
  assert.deepEqual(phases, ["waiting-for-lock", "authenticating"]);
  assert.equal(saved.lastFailure.errorCode, "CREDENTIAL_READ_TIMEOUT");
  assert.equal(saved.lastFailure.phase, "authenticating");
  const failure = events.find(event => event.event === "github_sync.failed");
  assert.equal(failure.errorCode, "CREDENTIAL_READ_TIMEOUT");
  assert.equal(failure.phase, "authenticating");
  assert.match(failure.error, /Reload.*GitHub was not contacted/);
  assert.equal(errors.length, 1);
});
