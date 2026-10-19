#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const net = require("net");
const { fork, execFileSync } = require("child_process");

const packageRoot = path.resolve(__dirname, "..");
const extensionRoot = process.env.PKM_SERVICE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.PKM_SERVICE_TEST_EXTENSION_ROOT) : packageRoot;
process.env.PKM_SERVICE_TEST_EXTENSION_ROOT = extensionRoot;
const buildRoot = process.env.PKM_SERVICE_BUILD_DIR
  ? path.resolve(process.env.PKM_SERVICE_BUILD_DIR) : path.join(extensionRoot, "dist");
process.env.PKM_SERVICE_BUILD_DIR = buildRoot;
const api = require(path.join(buildRoot, "runtime", "pkm-service.js"));
const syncApi = require(path.join(buildRoot, "sync", "github-sync.js"));
const repairApi = require(path.join(buildRoot, "sync", "github-sync-content-repair.js"));
const version = require(path.join(extensionRoot, "package.json")).version;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fixtureBytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
const errors = [];

async function until(predicate, label, milliseconds = 15000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await wait(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function live(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}
function readMetadata(options) {
  return JSON.parse(fs.readFileSync(path.join(api.pkmServiceIdentity(options).serviceDirectory, "endpoint.json"), "utf8"));
}
function emptyCatalog() {
  return Object.fromEntries(syncApi.GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
}
function syntheticResult() {
  return {
    transactionId: "transaction", commit: `daemon-${process.pid}`, changed: true,
    fingerprints: {}, pulled: [], deletedLocal: [], privateTopLevels: {},
    recipePulls: [{ path: "recipes/example.json", itemId: "example", content: fixtureBytes, expectedLocal: Buffer.alloc(0) }],
    recipeDeletes: [{ path: "recipes/deleted.json", itemId: "deleted", expectedLocal: fixtureBytes }], acknowledgedDeletions: [],
    resolutionReport: { totalFiles: 1, rules: {}, generatedAt: new Date().toISOString() },
  };
}

// This same test file is the fixture daemon entry. The IPC runtime/coordinator
// remains real; only raw Sync is substituted for exact binary/error assertions.
async function fixtureDaemon(options) {
  const originalSync = syncApi.syncGitHubTarget;
  const originalFs = {
    openSync: fs.openSync, closeSync: fs.closeSync, writeFileSync: fs.writeFileSync,
    fsyncSync: fs.fsyncSync, renameSync: fs.renameSync,
  };
  const recoveryDescriptors = new Map();
  let persistenceFault, faultToken;
  const persistenceError = stage => Object.assign(new Error(`TEST_PERSISTENCE_FAILURE ${stage} ${faultToken || ""}`),
    { code: stage === "fsync" ? "EPERM" : "EIO" });
  fs.openSync = (file, flags, mode) => {
    const fd = originalFs.openSync(file, flags, mode);
    if (String(file).endsWith(".staging")) recoveryDescriptors.set(fd, flags);
    return fd;
  };
  fs.closeSync = fd => {
    const result = originalFs.closeSync(fd);
    recoveryDescriptors.delete(fd);
    return result;
  };
  fs.writeFileSync = (file, ...args) => {
    if (typeof file === "number" && recoveryDescriptors.has(file) && persistenceFault === "write") throw persistenceError("write");
    return originalFs.writeFileSync(file, ...args);
  };
  fs.fsyncSync = fd => {
    if (recoveryDescriptors.has(fd)) {
      if (recoveryDescriptors.get(fd) === "r") throw Object.assign(new Error("Windows read-only fsync"), { code: "EPERM" });
      if (persistenceFault === "fsync") throw persistenceError("fsync");
    }
    return originalFs.fsyncSync(fd);
  };
  fs.renameSync = (source, destination) => {
    if (String(source).endsWith(".staging") && persistenceFault === "rename") throw persistenceError("rename");
    return originalFs.renameSync(source, destination);
  };
  syncApi.syncGitHubTarget = async (target, catalog, checkoutRoot, credentials, storeRoot, progress, executionOptions) => {
    const fault = /^persist-(error|success)-(write|fsync|rename)$/.exec(target.name);
    persistenceFault = fault?.[2];
    faultToken = credentials?.accessToken;
    progress?.("fetch", "daemon progress");
    if (fault?.[1] === "error") throw Object.assign(new Error(`TEST_PRIMARY_SYNC_FAILURE ${faultToken || ""}`), { code: "TEST_PRIMARY_SYNC_FAILURE" });
    if (target.name === "real-sync") {
      const result = await originalSync(target, catalog, checkoutRoot, credentials, storeRoot, progress, executionOptions);
      result.daemonPid = process.pid;
      return result;
    }
    if (target.name === "conflict" || target.name === "partial-conflict") {
      const error = new syncApi.GitHubSyncConflictError("remote", [{
        path: "skills/Test/Example.md", type: "skills", itemId: "example", category: "Test", privacy: "public",
        base: fixtureBytes, local: Buffer.from([0, 255, 1]), remote: Buffer.alloc(0),
      }], [], [], {}, syntheticResult().recipePulls, syntheticResult().recipeDeletes);
      if (target.name === "partial-conflict") error.partialResult = {
        ...syntheticResult(), entityBases: { ["skills\0example"]: "a".repeat(40) },
        deferredEntities: ["scripts\0unstable"],
      };
      throw error;
    }
    if (target.name === "compatibility") throw new syncApi.GitHubSyncExtensionCompatibilityError("99.0.0", options.extensionVersion);
    if (target.name === "content-repair") throw new repairApi.GitHubSyncContentRepairError(target.id, [{
      path: "scripts/Test.script", type: "scripts", itemId: "Test", source: "local", reason: "merge-conflict-markers",
      lines: [1, 2, 3], digest: "digest", content: "<<<<<<< local\n=======\n>>>>>>> remote\n", candidate: "",
    }, {
      path: "recipes/Examples/Legacy.recipe_legacy.json", type: "recipes", itemId: "recipe_legacy",
      source: "local", reason: "recipe-digest", lines: [], digest: "recipe-content", content: "{}",
      recipeId: "recipe_legacy", error: "Recipe executable digest is invalid",
      diagnostics: [{ storedDigest: "raw", compiledDigest: "compiled" }],
      sourceLocator: { kind: "recipe-store", path: "projects.json", jsonPointer: "/payload/state/recipes", recipeId: "recipe_legacy" },
    }], "repair-attempt");
    if (target.name === "secret-error") throw new Error(`Failure ${credentials.accessToken}`);
    if (target.name === "hold-raw") {
      fs.writeFileSync(path.join(options.globalStoragePath, "raw-started"), String(process.pid));
      await until(() => fs.existsSync(path.join(options.globalStoragePath, "release-raw")), "raw release");
    }
    const result = syntheticResult();
    result.echo = catalog.skills[0]?.extra;
    result.inputWasBuffer = Buffer.isBuffer(catalog.skills[0]?.extra?.nested?.[0]);
    return result;
  };
  const runtime = await api.startPkmService(options);
  await runtime.stopped;
}

async function hostChild(options) {
  const client = await api.PkmServiceClient.connect({
    ...options, execute: async () => { throw new Error("Unexpected automatic execution in host fixture."); },
    onError: () => {},
  });
  process.send({ type: "ready", daemonPid: readMetadata(options).pid });
  process.on("message", message => {
    if (message.type === "dispose") { client.dispose(); process.exit(0); }
  });
}

async function main() {
  const runtimeRoot = path.join(__dirname, `.runtime-pkm-service-${process.pid}`);
  const clients = new Set();
  const children = new Set();
  const descriptors = [];
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  function optionsFor(name, extensionVersion = version, fixture = false) {
    const knowledgeRoot = path.join(runtimeRoot, name, "knowledge");
    const globalStoragePath = path.join(runtimeRoot, name, "storage");
    fs.mkdirSync(knowledgeRoot, { recursive: true });
    fs.mkdirSync(globalStoragePath, { recursive: true });
    const options = {
      knowledgeRoot, globalStoragePath, extensionVersion,
      serviceEntryPath: fixture ? __filename : path.join(buildRoot, "runtime", "pkm-service-entry.js"),
      onError: error => errors.push(error),
    };
    descriptors.push(options);
    return options;
  }
  async function connect(options) {
    const client = await api.PkmServiceClient.connect(options);
    clients.add(client);
    return client;
  }
  async function launchHost(options) {
    const child = fork(__filename, ["--host", JSON.stringify(options)], {
      stdio: ["ignore", "ignore", "inherit", "ipc"], env: { ...process.env, PKM_SERVICE_BUILD_DIR: buildRoot },
    });
    children.add(child);
    const ready = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Host fixture did not start.")), 20000);
      child.on("message", message => { if (message.type === "ready") { clearTimeout(timeout); resolve(message); } });
      child.once("exit", code => { if (code) { clearTimeout(timeout); reject(new Error(`Host fixture failed: ${code}`)); } });
    });
    return { child, ...ready };
  }
  async function disposeHost(host) {
    const exited = new Promise(resolve => host.child.once("exit", resolve));
    host.child.send({ type: "dispose" });
    await exited;
    children.delete(host.child);
  }
  try {
    const probe = path.join(runtimeRoot, "native-fsync-probe");
    fs.writeFileSync(probe, "probe");
    const readonly = fs.openSync(probe, "r");
    let readonlyResult = "succeeded";
    try { fs.fsyncSync(readonly); }
    catch (error) { readonlyResult = `${error.code}: ${error.stack}`; }
    finally { fs.closeSync(readonly); }
    fs.rmSync(probe);
    const writable = fs.openSync(probe, "wx", 0o600);
    try { fs.writeFileSync(writable, "durable"); fs.fsyncSync(writable); }
    finally { fs.closeSync(writable); }
    assert.strictEqual(fs.readFileSync(probe, "utf8"), "durable");
    fs.rmSync(probe);
    console.log(`Native fsync probe: platform=${process.platform} runtime=${process.execPath} version=${process.version} readonly=${readonlyResult} writable=succeeded`);
    const persistenceOptions = optionsFor("persistence");
    const hosts = await Promise.all([launchHost(persistenceOptions), launchHost(persistenceOptions)]);
    assert.strictEqual(hosts[0].daemonPid, hosts[1].daemonPid, "concurrent independent host processes must create one daemon");
    assert.notStrictEqual(hosts[0].daemonPid, process.pid);
    assert.notStrictEqual(hosts[0].daemonPid, hosts[0].child.pid);
    const descriptor = readMetadata(persistenceOptions);
    assert.strictEqual(descriptor.protocol, api.PKM_SERVICE_PROTOCOL);
    const identity = api.pkmServiceIdentity(persistenceOptions);
    assert.strictEqual(fs.statSync(identity.serviceDirectory).mode & 0o077, 0);
    if (process.platform !== "win32") {
      assert(fs.statSync(identity.endpoint).isSocket());
      assert.strictEqual(fs.statSync(path.dirname(identity.endpoint)).mode & 0o077, 0);
      assert(Buffer.byteLength(identity.endpoint) < 100);
      const bad = net.createConnection(identity.endpoint);
      await new Promise(resolve => bad.once("connect", resolve));
      const closed = new Promise(resolve => bad.once("close", resolve));
      const oversized = Buffer.alloc(4); oversized.writeUInt32BE(api.PKM_SERVICE_MAX_MESSAGE_BYTES + 1);
      bad.write(oversized);
      await closed;
      assert(live(descriptor.pid), "oversized frames must close only the offending peer");
    }
    await Promise.all(hosts.map(disposeHost));
    assert(live(descriptor.pid), "independent service survives all original hosts exiting");
    const firstErrors = [];
    let firstExecutions = 0, secondExecutions = 0, releaseExecute;
    const first = await connect({
      ...persistenceOptions, execute: async () => { firstExecutions++; },
      onError: error => firstErrors.push(error),
    });
    const second = await connect({
      ...persistenceOptions,
      execute: async (targetId, reason, fence) => {
        secondExecutions++;
        assert.strictEqual(reason, "force-local-authority");
        assert(fence > 0);
        second.report(targetId, "authenticating", "host orchestration");
        await new Promise(resolve => { releaseExecute = resolve; });
      },
    });
    assert.strictEqual(readMetadata(persistenceOptions).pid, descriptor.pid);
    await assert.rejects(
      () => api.PkmServiceClient.connect({ ...persistenceOptions, extensionVersion: "0.0.1", execute: async () => {} }),
      error => error instanceof api.PkmServiceVersionError,
    );
    await second.configure([{ id: "manual", enabled: false, intervalMinutes: 1440, syncOnChange: false }]);
    assert.strictEqual(await second.request("manual", "force-local-authority"), true);
    await until(() => releaseExecute, "requesting host execute callback");
    assert.strictEqual(firstExecutions, 0, "force audit must remain in the requesting host");
    assert.strictEqual(secondExecutions, 1);
    await until(() => first.snapshot().manual?.phase === "authenticating", "state broadcast to both hosts");
    assert.deepStrictEqual(first.snapshot().manual.service, { pid: descriptor.pid, version, protocol: api.PKM_SERVICE_PROTOCOL });
    const newerVersion = `${Number(version.split(".")[0]) + 1}.0.0`;
    let upgradeFinished = false;
    const replacementPromise = connect({
      ...persistenceOptions, extensionVersion: newerVersion, execute: async () => {},
    }).then(client => { upgradeFinished = true; return client; });
    await wait(200);
    assert.strictEqual(upgradeFinished, false, "upgrade must wait for complete host postprocessing");
    assert(live(descriptor.pid), "idle upgrade must never kill active execution");
    await assert.rejects(() => first.request("manual", "manual"), /draining/);
    releaseExecute();
    const replacement = await replacementPromise;
    assert.notStrictEqual(readMetadata(persistenceOptions).pid, descriptor.pid);
    assert.strictEqual(live(descriptor.pid), false);
    await assert.rejects(
      () => api.PkmServiceClient.connect({ ...persistenceOptions, execute: async () => {} }),
      error => error instanceof api.PkmServiceVersionError,
      "an older window must never downgrade a newer daemon",
    );
    await replacement.drain();
    await until(() => !live(readMetadataPidSafe(persistenceOptions)), "replacement drain");
    await assert.rejects(
      () => api.PkmServiceClient.connect({ ...persistenceOptions, execute: async () => {} }),
      error => error instanceof api.PkmServiceVersionError,
      "even an idle/dead service must retain its monotonic version pin",
    );

    const fixtureOptions = optionsFor("binary-and-recovery", version, true);
    let job, completed, failed, releasePostprocess;
    const fixtureClient = await connect({
      ...fixtureOptions,
      execute: async (targetId) => {
        try {
          const result = await fixtureClient.sync(
            { ...syncApi.normalizeGitHubSyncTarget({ id: targetId, name: job.name, repository: "unused", branch: "main" }), ...job.target },
            job.catalog || emptyCatalog(), job.checkoutRoot || path.join(runtimeRoot, "checkout"),
            job.credentials, fixtureOptions.knowledgeRoot,
            (phase, detail) => {
              job.progress?.push({ phase, detail });
              if (job.reportProgress) fixtureClient.report(targetId, phase, detail);
            }, job.options,
          );
          if (job.holdPostprocess) await new Promise(resolve => { releasePostprocess = resolve; });
          completed = result;
        } catch (error) {
          if (error.partialResult && job.holdPostprocess) await new Promise(resolve => { releasePostprocess = resolve; });
          if (error.partialResult && job.failPostprocess) {
            failed = new Error("TEST_PARTIAL_FINALIZER_FAILURE"); throw failed;
          }
          if (job.acknowledgeError) await fixtureClient.acknowledgeExecutionErrors(targetId);
          failed = error; throw error;
        }
      },
    });
    await fixtureClient.configure([{ id: "fixture", enabled: false, intervalMinutes: 1440, syncOnChange: false }]);
    await assert.rejects(
      () => fixtureClient.sync({ id: "fixture" }, emptyCatalog(), runtimeRoot),
      /only inside.*assigned active execute/,
    );
    async function submit(specification) {
      job = specification; completed = undefined; failed = undefined; releasePostprocess = undefined;
      await until(() => fixtureClient.snapshot().fixture?.status !== "syncing", "previous fixture settlement");
      assert.strictEqual(await fixtureClient.request("fixture", "manual"), true);
      await until(() => completed || failed || releasePostprocess, `${job.name} completion`);
      return completed;
    }
    const catalog = emptyCatalog();
    catalog.skills.push({ extra: { nested: [fixtureBytes, Buffer.alloc(0)], literalTag: { $pkm: "buffer", data: "not an encoding" } } });
    const progress = [];
    const binary = await submit({ name: "binary", catalog, progress });
    assert(binary.inputWasBuffer);
    assert.deepStrictEqual(binary.echo, catalog.skills[0].extra, "nested Buffers and literal codec-looking objects must round trip exactly");
    assert(Buffer.isBuffer(binary.recipePulls[0].content));
    assert.deepStrictEqual(binary.recipePulls[0].content, fixtureBytes);
    assert.deepStrictEqual(binary.recipePulls[0].expectedLocal, Buffer.alloc(0));
    assert.deepStrictEqual(binary.recipeDeletes[0].expectedLocal, fixtureBytes);
    assert.strictEqual(binary.commit, `daemon-${readMetadata(fixtureOptions).pid}`, "raw Sync executes in the daemon process");
    assert(progress.some(item => item.detail === "daemon progress"));
    const errorsBefore = errors.length;
    await submit({ name: "binary", reportProgress: true });
    await until(() => fixtureClient.snapshot().fixture?.status !== "syncing", "progress report settlement");
    assert(!errors.slice(errorsBefore).some(error => /not authorized/.test(error.message)),
      "daemon progress callbacks preserve their assigned execution context");
    await submit({ name: "binary", holdPostprocess: true });
    const resultDirectory = path.join(api.pkmServiceIdentity(fixtureOptions).serviceDirectory, "results");
    const saved = fs.readdirSync(resultDirectory).filter(file => file.endsWith(".json"));
    assert.strictEqual(saved.length, 1, "the success record exists before host finalization");
    const savedText = fs.readFileSync(path.join(resultDirectory, saved[0]), "utf8");
    assert.doesNotThrow(() => JSON.parse(savedText));
    assert(savedText.includes("success") && savedText.includes("operationId") && savedText.includes("fixture"));
    assert(!fs.readdirSync(resultDirectory).some(file => file.endsWith(".staging")));
    releasePostprocess();
    await until(() => fixtureClient.snapshot().fixture?.status !== "syncing", "saved result settlement");
    assert.deepStrictEqual(fs.readdirSync(resultDirectory), [], "only confirmed host completion removes success recovery records");
    await submit({ name: "secret-error", acknowledgeError: true });
    await until(() => fixtureClient.snapshot().fixture?.status !== "syncing", "handled error settlement");
    assert.deepStrictEqual(await fixtureClient.listRecoverableResults(), [],
      "a durably handled raw Sync failure is not misreported as unfinished postprocessing");
    await submit({ name: "content-repair", acknowledgeError: true });
    assert(failed instanceof repairApi.GitHubSyncContentRepairError, "typed content issues survive daemon-to-Host RPC");
    assert.equal(failed.attemptId, "repair-attempt");
    assert.equal(failed.issues[0].candidate, "");
    assert.equal(failed.issues.length, 2);
    assert.equal(failed.issues[1].reason, "recipe-digest");
    assert.equal(failed.issues[1].error, "Recipe executable digest is invalid");
    assert.deepEqual(failed.issues[1].diagnostics, [{ storedDigest: "raw", compiledDigest: "compiled" }]);
    assert.equal(failed.issues[1].sourceLocator.jsonPointer, "/payload/state/recipes");
    assert.equal(failed.serviceShouldRetry, false);
    await until(() => fixtureClient.snapshot().fixture?.status === "needs-attention", "content repair attention state");
    assert.equal(await fixtureClient.request("fixture", "change"), false);
    assert.deepEqual(await fixtureClient.listRecoverableResults(), []);
    await submit({ name: "binary" });
    await until(() => fixtureClient.snapshot().fixture?.status !== "syncing", "explicit repair retry settles");
    assert.notEqual(fixtureClient.snapshot().fixture.status, "needs-attention", "an explicit successful retry resumes the scheduler");
    const faultSecret = "pkm-persistence-fault-secret-never-log";
    for (const outcome of ["error", "success"]) {
      for (const stage of ["write", "fsync", "rename"]) {
        const warningStart = errors.length;
        await submit({ name: `persist-${outcome}-${stage}`, credentials: { accessToken: faultSecret }, acknowledgeError: true });
        await until(() => fixtureClient.snapshot().fixture?.status !== "syncing", "persistence failure settlement");
        assert(failed instanceof api.PkmServiceRecoveryPersistenceError);
        assert.strictEqual(failed.outcome, outcome);
        assert.strictEqual(failed.recoveryAvailable, false);
        assert.strictEqual(failed.serviceShouldRetry, false);
        assert.strictEqual(failed.persistenceStage, stage);
        assert.strictEqual(failed.targetId, "fixture");
        assert.match(failed.operationId, /^[a-f0-9-]{36}$/);
        assert(failed.persistenceError instanceof Error);
        assert.match(failed.persistenceError.stack, /TEST_PERSISTENCE_FAILURE/);
        assert.strictEqual(failed.persistenceError.code, stage === "fsync" ? "EPERM" : "EIO");
        if (outcome === "error") {
          assert(failed.primaryError instanceof Error);
          assert.strictEqual(failed.primaryError.code, "TEST_PRIMARY_SYNC_FAILURE");
          assert.match(failed.primaryError.stack, /TEST_PRIMARY_SYNC_FAILURE/);
          assert.match(failed.message, /older receipt is not evidence/);
        } else {
          assert.strictEqual(failed.primaryError, undefined);
          assert.strictEqual(failed.transactionId, "transaction");
          assert.match(failed.commit, /^daemon-/);
        }
        assert(!JSON.stringify(failed).includes(faultSecret));
        assert(!failed.message.includes(faultSecret));
        assert.match(failed.message, /NOT saved/);
        assert.deepStrictEqual(await fixtureClient.listRecoverableResults(), []);
        assert.deepStrictEqual(fs.readdirSync(resultDirectory), [], "write/fsync/rename failures leave no fake result or staging");
        assert(!errors.slice(warningStart).some(error => /recovery record .*\.json|postprocessing did not complete/.test(error.message)),
          "a missing record cannot produce a recover-from-results notification");
      }
    }
    const serviceLog = fs.readFileSync(path.join(api.pkmServiceIdentity(fixtureOptions).serviceDirectory, "service.log"), "utf8");
    assert(serviceLog.includes("PKM_SERVICE_RECOVERY_PERSISTENCE_FAILED"));
    assert(!serviceLog.includes(faultSecret), "primary, secondary and diagnostics must redact credentials");
    await fixtureClient.configure([{ id: "fixture", enabled: true, intervalMinutes: 1440, syncOnChange: true, lastSuccessAt: new Date().toISOString() }]);
    await submit({ name: "persist-error-fsync", acknowledgeError: true });
    await until(() => fixtureClient.snapshot().fixture?.status !== "syncing", "non-retryable failure settlement");
    assert.strictEqual(fixtureClient.snapshot().fixture.nextSyncAt, undefined);
    assert.strictEqual(await fixtureClient.request("fixture", "interval"), false,
      "recovery persistence failures exhaust retries rather than scheduling a blind retry");
    await fixtureClient.configure([{ id: "fixture", enabled: false, intervalMinutes: 1440, syncOnChange: false }]);
    await submit({ name: "conflict" });
    assert(failed instanceof syncApi.GitHubSyncConflictError, "client reconstructs the actual conflict constructor");
    assert.deepStrictEqual(failed.conflicts[0].base, fixtureBytes);
    assert(Buffer.isBuffer(failed.recipePulls[0].expectedLocal));
    await submit({ name: "partial-conflict", holdPostprocess: true });
    assert(fs.readdirSync(resultDirectory).some(name => fs.readFileSync(path.join(resultDirectory, name), "utf8").includes("partialResult")),
      "partial progress remains recoverable until host finalization completes");
    releasePostprocess();
    await until(() => fixtureClient.snapshot().fixture?.status !== "syncing", "partial finalization");
    assert(failed instanceof syncApi.GitHubSyncConflictError);
    assert.deepStrictEqual(failed.partialResult.entityBases, { ["skills\0example"]: "a".repeat(40) });
    assert(Buffer.isBuffer(failed.partialResult.recipePulls[0].content));
    assert.strictEqual(fixtureClient.snapshot().fixture.status, "partial");
    assert(!fs.readdirSync(resultDirectory).some(name => fs.readFileSync(path.join(resultDirectory, name), "utf8").includes("partialResult")),
      "acknowledged partial progress does not replay after host restart");
    await submit({ name: "partial-conflict", failPostprocess: true });
    await until(() => fixtureClient.snapshot().fixture?.status !== "syncing", "failed partial finalization");
    const partialReceipt = (await fixtureClient.listRecoverableResults()).find(item =>
      fs.readFileSync(item.receiptPath, "utf8").includes("partialResult"));
    assert(partialReceipt, "a failed host finalizer must retain the raw partial result");
    await assert.rejects(() => fixtureClient.recoverSyncResult(partialReceipt.operationId), error =>
      error instanceof syncApi.GitHubSyncConflictError
      && error.partialResult.entityBases["skills\0example"] === "a".repeat(40)
      && Buffer.isBuffer(error.partialResult.recipePulls[0].content));
    await submit({ name: "compatibility" });
    assert(failed instanceof syncApi.GitHubSyncExtensionCompatibilityError);
    assert.strictEqual(failed.requiredVersion, "99.0.0");

    const secret = "pkm-fixture-secret-token-should-never-persist";
    await submit({ name: "secret-error", credentials: { accessToken: secret } });
    const recoveredErrors = await fixtureClient.listRecoverableResults();
    const secretReceipt = recoveredErrors.find(item => {
      const text = fs.readFileSync(item.receiptPath, "utf8");
      assert(!text.includes(secret));
      return text.includes("[REDACTED]");
    });
    assert(secretReceipt, "error recovery records redact the credential token");
    assert(!fs.readFileSync(path.join(api.pkmServiceIdentity(fixtureOptions).serviceDirectory, "service.log"), "utf8").includes(secret));
    assert(!fs.readFileSync(path.join(api.pkmServiceIdentity(fixtureOptions).stateDirectory, "coordinator.json"), "utf8").includes(secret));
    const conflictReceipt = recoveredErrors.find(item => fs.readFileSync(item.receiptPath, "utf8").includes("GitHubSyncConflictError"));
    assert.deepStrictEqual(
      { reason: conflictReceipt.reason, repository: conflictReceipt.repository, branch: conflictReceipt.branch },
      { reason: "manual", repository: "unused", branch: "main" },
      "conflict recovery receipts preserve the assigned job reason and original endpoint",
    );
    await assert.rejects(
      () => fixtureClient.recoverSyncResult(conflictReceipt.operationId),
      error => error instanceof syncApi.GitHubSyncConflictError && Buffer.isBuffer(error.conflicts[0].base)
        && error.recipeDeletes[0].expectedLocal.equals(fixtureBytes),
    );
    const legacyReceipt = JSON.parse(fs.readFileSync(secretReceipt.receiptPath, "utf8"));
    legacyReceipt.entries = legacyReceipt.entries.filter(([key]) => !["reason", "repository", "branch"].includes(key));
    fs.writeFileSync(secretReceipt.receiptPath, JSON.stringify(legacyReceipt), { mode: 0o600 });
    const legacyListed = (await fixtureClient.listRecoverableResults()).find(item => item.operationId === secretReceipt.operationId);
    assert.strictEqual(legacyListed.reason, undefined);
    assert.strictEqual(legacyListed.repository, undefined);
    assert.strictEqual(legacyListed.branch, undefined, "legacy receipts expose missing endpoint metadata rather than guessing the current target");

    // A real local Git remote proves no host-side raw Git sync is required.
    const realRoot = path.join(runtimeRoot, "real-git");
    const remote = path.join(realRoot, "remote.git");
    fs.mkdirSync(realRoot);
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
    const realCatalog = emptyCatalog();
    realCatalog.skills.push({
      id: "real-skill", label: "Real Skill", cat: "Test", isPrivate: false,
      destination: "skills/Test/Real.md",
      content: "---\nname: Real Skill\ndescription: daemon acceptance\n---\n# Real Skill\n\nDaemon local Git acceptance.\n",
    });
    const real = await submit({ name: "real-sync", target: { repository: remote }, catalog: realCatalog, checkoutRoot: path.join(realRoot, "checkout") });
    assert(real, failed?.message);
    assert.strictEqual(real.daemonPid, readMetadata(fixtureOptions).pid);
    assert.strictEqual(execFileSync("git", ["--git-dir", remote, "rev-parse", "main"], { encoding: "utf8" }).trim(), real.commit);

    job = { name: "hold-raw", holdPostprocess: false }; completed = undefined; failed = undefined;
    await until(() => fixtureClient.snapshot().fixture?.status !== "syncing", "real Git settlement");
    assert.strictEqual(await fixtureClient.request("fixture", "force-local-authority"), true);
    await until(() => fs.existsSync(path.join(fixtureOptions.globalStoragePath, "raw-started")), "held daemon raw Sync");
    const fixturePid = readMetadata(fixtureOptions).pid;
    fixtureClient.dispose();
    fs.writeFileSync(path.join(fixtureOptions.globalStoragePath, "release-raw"), "");
    const recoveryClient = await connect({ ...fixtureOptions, execute: async () => {} });
    assert.strictEqual(readMetadata(fixtureOptions).pid, fixturePid);
    let receipt;
    await until(() => {
      const resultDirectory = path.join(api.pkmServiceIdentity(fixtureOptions).serviceDirectory, "results");
      receipt = fs.readdirSync(resultDirectory).filter(file => file.endsWith(".json")).map(file => ({ file, text: fs.readFileSync(path.join(resultDirectory, file), "utf8") })).find(item => item.text.includes('"success"'));
      return receipt;
    }, "disconnected host durable successful result");
    const recovered = await recoveryClient.listRecoverableResults();
    const success = recovered.find(item => item.outcome === "success");
    assert.deepStrictEqual(
      { reason: success.reason, repository: success.repository, branch: success.branch },
      { reason: "force-local-authority", repository: "unused", branch: "main" },
      "disconnected-host success receipts preserve original execution metadata",
    );
    const recoveredResult = await recoveryClient.recoverSyncResult(success.operationId);
    assert(Buffer.isBuffer(recoveredResult.recipePulls[0].content));
    assert.deepStrictEqual(recoveredResult.recipeDeletes[0].expectedLocal, fixtureBytes);
    assert.strictEqual(recoveredResult.commit, `daemon-${fixturePid}`);
    await until(() => recoveryClient.snapshot().fixture?.status !== "syncing", "disconnect settlement");
    await recoveryClient.acknowledgeRecoveredResult(success.operationId);
    assert(!(await recoveryClient.listRecoverableResults()).some(item => item.operationId === success.operationId));
    await recoveryClient.drain();
    await until(() => !live(fixturePid), "fixture daemon's completed safe drain");

    const isolationOptions = optionsFor("isolated-root");
    assert.notStrictEqual(api.pkmServiceIdentity(isolationOptions).identity, identity.identity);
    console.log("PKM service tests passed: cross-process singleton, persistence, version fencing, safe upgrade, callbacks, binary/errors, daemon Git, disconnect recovery, private IPC.");
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
    for (const options of descriptors) {
      const pid = readMetadataPidSafe(options);
      if (!pid || !live(pid)) continue;
      const metadata = readMetadata(options);
      try {
        const cleanupClient = await api.PkmServiceClient.connect({ ...options, extensionVersion: metadata.extensionVersion, execute: async () => {}, onError: () => {} });
        await Promise.race([cleanupClient.drain(), wait(5000).then(() => { throw new Error("Cleanup drain timed out."); })]);
        cleanupClient.dispose();
        await until(() => !live(pid), "cleanup daemon exit", 5000);
      } catch {
        // Failed assertions may leave a deliberately held fixture operation.
        fs.writeFileSync(path.join(options.globalStoragePath, "release-raw"), "");
        try { await until(() => !live(pid), "already-draining fixture exit", 1000); }
        catch { if (live(pid)) process.kill(pid, "SIGTERM"); }
      }
    }
    for (const client of clients) client.dispose();
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
}
function readMetadataPidSafe(options) {
  try { return readMetadata(options).pid; } catch { return undefined; }
}

if (process.argv[2] === "--host") {
  void hostChild(JSON.parse(process.argv[3])).catch(error => { console.error(error.message); process.exit(1); });
} else if (process.argv[2]?.startsWith("{")) {
  void fixtureDaemon(JSON.parse(process.argv[2])).then(() => process.exit(0), () => { console.error("PKM fixture service failed."); process.exit(1); });
} else {
  void main().catch(error => { console.error(error); process.exitCode = 1; });
}
