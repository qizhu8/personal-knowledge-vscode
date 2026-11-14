"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), { randomUUID, createHash } = require("node:crypto");
const build = process.env.PKM_ENV_AUTHORITY_BUILD;
const nextDist = process.env.PKM_TEST_NEXT_SERVER_DIST;
assert(build && path.isAbsolute(build) && nextDist && path.isAbsolute(nextDist), "Explicit isolated Root and Next source builds are required.");
const { attachOrdinaryEnvironmentsToOwner, assertOrdinaryEnvironmentRefreshCompletion } = require(path.join(build, "runtime/ordinary-environment-owner.js"));
const { ManagedOrdinaryEnvironmentProfileWriter } = require(path.join(build, "runtime/ordinary-environment-managed-effects.js"));
const { HostWriterAdmission } = require(path.join(build, "runtime/host-writer-admission.js"));
const managed = require(path.join(build, "runtime/managed-writer-session.js"));
const { environmentDrainProof } = require(path.join(build, "runtime/linux-environment-supervisor.js"));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() >= deadline) throw Error("Real managed query readiness timed out."); await pause(10); }
}
function fixture(t) {
  const base = path.resolve(".migration-test-work", `env-managed-${randomUUID()}`), root = path.join(base, "knowledge");
  fs.mkdirSync(path.join(root, ".pkm", "state"), { recursive: true });
  const oldSession = process.env.PKM_MANAGED_WRITER_SESSION;
  const profile = managed.bootstrapCompatibleManagedProfile(root, createHash("sha256").update(base).digest("hex"), true).registration;
  process.env.PKM_MANAGED_WRITER_SESSION = profile.sessionId;
  const host = new HostWriterAdmission(root, () => root), workspaceId = randomUUID();
  t.after(() => {
    if (oldSession === undefined) delete process.env.PKM_MANAGED_WRITER_SESSION; else process.env.PKM_MANAGED_WRITER_SESSION = oldSession;
    fs.rmSync(base, { recursive: true, force: true });
  });
  function records(phase) {
    const operations = path.join(root, ".pkm", "state", "managed-writer-session-compatible", "operations");
    return fs.readdirSync(operations).filter(name => name.endsWith(`.${phase}`))
      .map(name => JSON.parse(fs.readFileSync(path.join(operations, name), "utf8")))
      .filter(value => value.kind === "environment-refresh");
  }
  function open(name, overrides = {}) {
    const storage = path.join(base, name), registry = path.join(storage, "environments"), prefix = path.join(storage, "prefix");
    fs.mkdirSync(registry, { recursive: true }); fs.mkdirSync(prefix);
    const python = path.join(prefix, "python"), release = path.join(prefix, "release"), ready = path.join(prefix, "ready");
    const program = `#!/usr/bin/python3\nimport json,os,time\npid=os.fork()\nif pid==0:\n os.setsid();os.close(1);os.close(2)\n open(${JSON.stringify(ready)},"w").write(str(os.getpid()))\n while not os.path.exists(${JSON.stringify(release)}): time.sleep(.01)\n os._exit(0)\nprint(json.dumps([{"name":"fixture-manager-output","version":"9"}]),flush=True)\nos._exit(0)\n`;
    fs.writeFileSync(python, program, { mode: 0o555 });
    const row = { id: "retained", name, path: prefix, python, manager: "venv" };
    fs.writeFileSync(path.join(registry, "registry.json"), JSON.stringify([row]));
    const cache = path.join(registry, "retained.packages.json"), original = JSON.stringify({ capturedAt: "old", packages: [{ name: "original", version: "1" }] });
    fs.writeFileSync(cache, original);
    const ownerSignal = new AbortController(), intentSignal = new AbortController(), children = new Set();
    const owner = { workspaceId, storage: { workspaceRoot: () => root },
      assertCurrent() { if (ownerSignal.signal.aborted) throw Error("fixture owner revoked"); },
      registerChildClose(fn) { const registered = () => fn(); children.add(registered); return () => children.delete(registered); } };
    const hostSession = { workspaceId, signal: ownerSignal.signal, assertCurrent() { owner.assertCurrent(); },
      registerChildClose(_scope, fn) { const registered = () => fn(); children.add(registered); return () => children.delete(registered); } };
    const authority = { workspaceId, actorId: "local:owner", knowledgeRoot: root, globalStorageDirectory: storage,
      scope: "ordinary-environments:read-cache", signal: ownerSignal.signal, assertCurrent() { owner.assertCurrent(); } };
    const adapter = attachOrdinaryEnvironmentsToOwner({ owner, hostSession, authority, onCloseError() {} });
    const binding = { workspaceId, knowledgeRoot: root, globalStorageDirectory: storage };
    let savedCompletion, savedPrepared, savedChild, savedTrace;
    const gate = new ManagedOrdinaryEnvironmentProfileWriter({ binding, hostAdmission: host,
      supervisorPython: "/usr/bin/python3", environment: { PATH: "/usr/bin:/bin", HOME: storage, TMPDIR: storage },
      assertHostCurrent: owner.assertCurrent,
      signal: ownerSignal.signal, onCloseError() {},
      registerRootChildClose: owner.registerChildClose,
      registerEnvironmentChildClose: fn => hostSession.registerChildClose("environment", fn),
      // Controlled same-process fixture coverage, NOT an unknown external writer proof or production issuer.
      assertExclusiveProfileWriter() {},
      assertExecutionAuthority(trace) { assert.equal(trace.program, python); assert(trace.launch); },
      begin(prepared) { savedPrepared = prepared; return managed.beginManagedEnvironmentRefresh(root, prepared); },
      complete(registration, proof, transaction) {
        savedCompletion = transaction;
        assertOrdinaryEnvironmentRefreshCompletion(transaction, savedPrepared);
        if (proof.probe === "packages")
          assert.equal(JSON.parse(fs.readFileSync(cache, "utf8")).packages[0].version, "9", "Completion preceded physical profile commit.");
        managed.completeManagedEnvironmentRefresh(registration, proof, transaction);
      }, ...overrides });
    function request(mode = "legacy", transform = value => value, operation = "packages", deadlineMs = 10_000) {
      const entries = JSON.parse(fs.readFileSync(path.join(registry, "registry.json"), "utf8"));
      const intent = { ...binding, requestId: randomUUID(), actorId: "local:owner", operation, refresh: true,
        environments: (operation === "metadata" ? entries : [row]).map(({ id, path, python, manager }) => ({ id, path, python, manager })) };
      const lifetime = { signal: intentSignal.signal, expiresAtMs: Date.now() + deadlineMs };
      const effects = mode === "legacy" ? gate.acquireLegacyEffects(intent, lifetime) : gate.acquireOwnerEffects(intent, lifetime);
      const record = effects.recordExecution;
      effects.recordExecution = (child, trace) => { savedChild = child; savedTrace = trace; record(child, trace); };
      return adapter.handleMessage({ command: operation === "metadata" ? "envList" : "envPackages", id: row.id, refresh: true },
        { ...transform(effects), intent, expiresAtMs: lifetime.expiresAtMs });
    }
    return { gate, adapter, request, release, ready, cache, original, intentSignal, children, row, registry, storage, python,
      get prepared() { return savedPrepared; }, get completion() { return savedCompletion; },
      get child() { return savedChild; }, get trace() { return savedTrace; } };
  }
  return { root, host, open, records };
}
test("actual ordinary Refresh physically drains before profile handoff and specialized durable completion", async t => {
  const f = fixture(t), p = f.open("retained-profile");
  let prematureWrites = 0;
  const request = p.request("legacy", effects => {
    assert.doesNotThrow(() => effects.assertProfileWriter(), "Native consent preflights profile authority before claiming execution.");
    assert.throws(() => effects.withProfileWrite(p.row.id, "packages", () => { prematureWrites++; }), /intent.*revoked/);
    assert.equal(prematureWrites, 0);
    return effects;
  });
  await wait(() => fs.existsSync(p.ready));
  assert.equal(f.host.status().inFlight, 1);
  const handoff = p.gate.handoff();
  assert.equal(p.gate.status().phase, "handoff");
  assert.throws(() => p.request("legacy"), /intent|handoff/);
  assert.throws(() => p.request("owner"), /intent/);
  await pause(50);
  assert.equal(fs.readFileSync(p.cache, "utf8"), p.original);
  assert.equal(f.records("pending").length, 1); assert.equal(f.records("complete").length, 0);
  fs.writeFileSync(p.release, "");
  assert.equal((await request).packages[0].version, "9");
  await handoff;
  assert.equal(p.gate.status().phase, "owner"); assert.equal(f.records("complete").length, 1);
  assert.throws(() => assertOrdinaryEnvironmentRefreshCompletion(p.completion, p.prepared), /completion/);
  const { pathToFileURL } = require("node:url");
  const { inspectLegacyManagedWriterSession } = await import(pathToFileURL(path.join(nextDist, "legacy-managed-writer-session.js")).href);
  assert.throws(() => inspectLegacyManagedWriterSession(f.root),
    error => error.code === "PKM_STATE_UNSUPPORTED" && /Compatible managed writer session/.test(error.message));
  await assert.rejects(managed.waitForManagedWriterDrain(f.root, process.env.PKM_MANAGED_WRITER_SESSION, 0), /kind|Environment|environment|invalid|unknown|unsupported/i);
  await p.adapter.close(); await p.gate.close();
  assert.equal(p.children.size, 0);
});
test("one actual metadata handler completes four exact prepared registrations only after its commit queue", async t => {
  const f = fixture(t), completed = [];
  const p = f.open("metadata", {
    assertExecutionAuthority(trace) {
      assert(["version", "size"].includes(trace.kind)); assert(trace.launch);
      assert.equal(trace.program, trace.kind === "version" ? p.python : "du");
    },
    complete(registration, physical, transaction) {
      const rows = JSON.parse(fs.readFileSync(path.join(p.registry, "registry.json"), "utf8"));
      assert(rows.every(row => row.pyVersion === "Python 3.11.0" && row.sizeBytes > 0));
      managed.completeManagedEnvironmentRefresh(registration, physical, transaction);
      completed.push(physical);
    },
  });
  fs.chmodSync(p.python, 0o755);
  fs.writeFileSync(p.python, "#!/usr/bin/python3\nprint('Python 3.11.0')\n");
  fs.chmodSync(p.python, 0o555);
  fs.writeFileSync(path.join(p.registry, "registry.json"), JSON.stringify([p.row, { ...p.row, id: "second" }]));
  let enter, allow, first = true;
  const entered = new Promise(resolve => { enter = resolve; }), proceed = new Promise(resolve => { allow = resolve; });
  const request = p.request("legacy", effects => ({ ...effects, async withProfileWrite(id, kind, write) {
    if (first) { first = false; enter(); await proceed; }
    return effects.withProfileWrite(id, kind, write);
  } }), "metadata");
  await entered;
  assert.equal(f.records("pending").length, 1); assert.equal(f.records("complete").length, 0);
  allow();
  assert.equal((await request).refreshErrors.length, 0);
  assert.equal(completed.length, 4); assert.equal(f.records("complete").length, 4);
  await p.gate.handoff();
  await p.adapter.close(); await p.gate.close();
});
test("two profiles run concurrently; revoking one retains its pending record without cancelling the other", async t => {
  const f = fixture(t), a = f.open("A"), b = f.open("B");
  const first = a.request(), firstFailure = assert.rejects(first, /UNKNOWN|succeed/), second = b.request();
  await wait(() => fs.existsSync(a.ready) && fs.existsSync(b.ready));
  a.intentSignal.abort();
  fs.writeFileSync(b.release, "");
  assert.equal((await second).packages[0].version, "9");
  assert.equal(f.records("complete").length, 1);
  fs.writeFileSync(a.release, ""); await firstFailure;
  assert.equal(fs.readFileSync(a.cache, "utf8"), a.original);
  assert.equal(f.records("pending").length, 2); assert.equal(f.records("complete").length, 1);
  await assert.rejects(a.gate.handoff(), /UNKNOWN/);
  await a.adapter.close(); await assert.rejects(a.gate.close(), /UNKNOWN/);
  await b.adapter.close(); await b.gate.close();
});
test("cancel during queued profile commit prevents bytes and durable complete", async t => {
  const f = fixture(t), p = f.open("commit-cancel");
  let entered, allow;
  const committing = new Promise(resolve => { entered = resolve; }), proceed = new Promise(resolve => { allow = resolve; });
  const request = p.request("legacy", effects => ({ ...effects, async withProfileWrite(id, kind, write) {
    entered(); await proceed; return effects.withProfileWrite(id, kind, write);
  } }));
  const failure = assert.rejects(request, /UNKNOWN|succeed/);
  await wait(() => fs.existsSync(p.ready)); fs.writeFileSync(p.release, ""); await committing;
  p.intentSignal.abort(); allow(); await failure;
  assert.equal(fs.readFileSync(p.cache, "utf8"), p.original); assert.equal(f.records("complete").length, 0);
  await p.adapter.close(); await assert.rejects(p.gate.close(), /UNKNOWN/);
});
test("finish callback cancellation invalidates live transaction cap and cannot create complete", async t => {
  const f = fixture(t), p = f.open("finish-cancel");
  let captured, enter, allow;
  const entered = new Promise(resolve => { enter = resolve; }), proceed = new Promise(resolve => { allow = resolve; });
  const request = p.request("legacy", effects => ({ ...effects, async finishRefresh(completion) {
    if (!completion) return effects.finishRefresh(undefined);
    captured = completion; enter(); await proceed;
    assertOrdinaryEnvironmentRefreshCompletion(completion, p.prepared);
    return effects.finishRefresh(completion);
  } }));
  const failure = assert.rejects(request, /revoked|expired/);
  await wait(() => fs.existsSync(p.ready)); fs.writeFileSync(p.release, ""); await entered;
  assertOrdinaryEnvironmentRefreshCompletion(captured, p.prepared);
  p.intentSignal.abort();
  assert.throws(() => assertOrdinaryEnvironmentRefreshCompletion(captured, p.prepared), /revoked|expired/);
  allow(); await failure;
  assert.throws(() => assertOrdinaryEnvironmentRefreshCompletion(captured, p.prepared), /completion/);
  assert.equal(f.records("complete").length, 0);
  await p.adapter.close(); await assert.rejects(p.gate.close(), /UNKNOWN/);
});
test("missing explicit registration and unknown outside writer coverage reject before actual spawn", async t => {
  const f = fixture(t), missing = f.open("no-registration", { begin() { return undefined; } });
  await assert.rejects(missing.request(), /UNKNOWN|succeed/);
  assert.equal(fs.existsSync(missing.ready), false); assert.equal(f.records("pending").length, 0);
  await missing.adapter.close(); await assert.rejects(missing.gate.close(), /UNKNOWN/);
  const unknown = f.open("unknown-coverage", { assertExclusiveProfileWriter() { throw Error("unknown external profile writer"); } });
  assert.throws(() => unknown.request(), /unknown external/);
  await assert.rejects(unknown.gate.handoff(), /unknown external/);
  assert.equal(fs.existsSync(unknown.ready), false); assert.equal(f.records("complete").length, 0);
  await unknown.adapter.close(); await assert.rejects(unknown.gate.close(), /UNKNOWN/);
});
test("supervisor SIGKILL leaves real orphan alive, unchanged cache and durable transaction pending", async t => {
  const f = fixture(t), p = f.open("supervisor-crash");
  const request = p.request(), failure = assert.rejects(request, /UNKNOWN|succeed/);
  await wait(() => fs.existsSync(p.ready));
  p.child.kill("SIGKILL"); await failure;
  process.kill(Number(fs.readFileSync(p.ready, "utf8")), 0);
  assert.throws(() => environmentDrainProof(p.child, p.trace), /UNKNOWN/);
  assert.equal(fs.readFileSync(p.cache, "utf8"), p.original);
  assert.equal(f.records("pending").length, 1); assert.equal(f.records("complete").length, 0);
  fs.writeFileSync(p.release, "");
  await assert.rejects(p.adapter.close(), /UNKNOWN|unknown/);
  await assert.rejects(p.gate.close(), /UNKNOWN/);
  assert.equal(p.children.size, 4, "Both owner/session barriers must remain registered after physical proof is lost.");
});
test("permit timeout keeps durable pending even when late physical drain can be independently verified", async t => {
  const f = fixture(t), p = f.open("deadline");
  const request = p.request("legacy", value => value, "packages", 350), failure = assert.rejects(request, /UNKNOWN/);
  await wait(() => fs.existsSync(p.ready)); await failure;
  assert.throws(() => environmentDrainProof(p.child, p.trace), /UNKNOWN/);
  process.kill(Number(fs.readFileSync(p.ready, "utf8")), 0);
  assert.equal(f.records("pending").length, 1); assert.equal(f.records("complete").length, 0);
  fs.writeFileSync(p.release, "");
  await wait(() => { try { environmentDrainProof(p.child, p.trace); return true; } catch { return false; } });
  assert.equal(fs.readFileSync(p.cache, "utf8"), p.original);
  await p.adapter.close(); await assert.rejects(p.gate.close(), /UNKNOWN/);
  assert.equal(p.children.size, 2);
  assert.equal(f.records("pending").length, 1); assert.equal(f.records("complete").length, 0);
});
test("caller process crash loses completion authority and cannot replay its durable pending query", async t => {
  const f = fixture(t), p = f.open("caller-crash"), supervisorPid = path.join(p.storage, "supervisor-pid");
  const { spawn } = require("node:child_process");
  const trace = { intent: { workspaceId: randomUUID(), knowledgeRoot: f.root, globalStorageDirectory: p.storage,
    requestId: randomUUID(), actorId: "local:owner", operation: "packages", refresh: true,
    environments: [{ id: p.row.id, path: p.row.path, python: p.python, manager: p.row.manager }] },
    environmentId: p.row.id, kind: "packages", program: p.python, args: ["-m", "pip", "list", "--format=json"],
    environment: { PATH: "/usr/bin:/bin", HOME: p.storage, TMPDIR: p.storage, PYTHONDONTWRITEBYTECODE: "1" } };
  const caller = spawn(process.execPath, ["-e", `
const fs=require("node:fs"),s=require(${JSON.stringify(path.join(build, "runtime/linux-environment-supervisor.js"))}),
m=require(${JSON.stringify(path.join(build, "runtime/managed-writer-session.js"))});
const trace=${JSON.stringify(trace)};
const prepared=s.prepareLinuxEnvironmentQuery(trace,{python:"/usr/bin/python3",timeoutMs:5000,maxBuffer:4096});
const reservation=s.reservePreparedLinuxEnvironmentQuery(prepared);
m.beginManagedEnvironmentRefresh(trace.intent.knowledgeRoot,prepared);
const execution=s.startPreparedLinuxEnvironmentQuery(prepared,reservation);
fs.writeFileSync(${JSON.stringify(supervisorPid)},String(execution.child.pid));
execution.result.catch(()=>{});
setInterval(()=>{},1000);
`], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; caller.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise(resolve => caller.once("close", resolve));
  t.after(() => { if (caller.exitCode === null && caller.signalCode === null) caller.kill("SIGKILL"); });
  await wait(() => fs.existsSync(p.ready));
  assert.equal(stderr, ""); assert.equal(f.records("pending").length, 1);
  caller.kill("SIGKILL"); await exited;
  const pid = Number(fs.readFileSync(supervisorPid, "utf8")); process.kill(pid, 0);
  fs.writeFileSync(p.release, "");
  await pause(150);
  assert.equal(fs.readFileSync(p.cache, "utf8"), p.original);
  assert.equal(f.records("pending").length, 1); assert.equal(f.records("complete").length, 0);
  await assert.rejects(managed.waitForManagedWriterDrain(f.root, process.env.PKM_MANAGED_WRITER_SESSION, 0), /kind|Environment|environment|invalid|unknown|unsupported/i);
  await p.adapter.close(); await p.gate.close();
});
