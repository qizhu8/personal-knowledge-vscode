"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const build = process.env.PKM_ENV_AUTHORITY_BUILD || path.resolve("dist");
const { prepareLinuxEnvironmentQuery, describePreparedLinuxEnvironmentQuery, startPreparedLinuxEnvironmentQuery,
  reservePreparedLinuxEnvironmentQuery, environmentDrainProof, assertLinuxEnvironmentDrainProof,
  assertPreparedLinuxEnvironmentDrainProof } = require(path.join(build, "runtime/linux-environment-supervisor.js"));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() >= deadline) throw Error("Fixture process readiness timeout."); await pause(10); }
}
function fixture(t) {
  const base = path.resolve(".migration-test-work", `env-subreaper-${crypto.randomUUID()}`);
  const root = path.join(base, "root"), profile = path.join(base, "profile");
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(profile);
  const trace = { intent: { requestId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), actorId: "local:owner",
    knowledgeRoot: root, globalStorageDirectory: profile, operation: "packages", refresh: true,
    environments: [{ id: "retained", path: base, python: "/usr/bin/python3", manager: "venv" }] },
    environmentId: "retained", kind: "packages", program: "/usr/bin/python3", args: [],
    environment: { PATH: "/usr/bin:/bin", HOME: base, TMPDIR: base, PYTHONDONTWRITEBYTECODE: "1" } };
  const release = path.join(base, "release"), ready = path.join(base, "ready"), pidFile = path.join(base, "pid");
  const script = `import os,time\np=os.fork()\nif p==0:\n os.setsid()\n os.close(1);os.close(2)\n open(${JSON.stringify(pidFile)},"w").write(str(os.getpid()))\n open(${JSON.stringify(ready)},"w").write("ready")\n while not os.path.exists(${JSON.stringify(release)}): time.sleep(.01)\n os._exit(0)\nprint("manager completed",flush=True)\nos._exit(0)\n`;
  trace.args = ["-I", "-B", "-c", script];
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, trace, release, ready, pidFile,
    prepare(timeoutMs = 5000) { return prepareLinuxEnvironmentQuery(trace, { python: "/usr/bin/python3", timeoutMs, maxBuffer: 4096 }); } };
}
function binding(trace) {
  return { workspaceId: trace.intent.workspaceId, knowledgeRoot: trace.intent.knowledgeRoot,
    globalStorageDirectory: trace.intent.globalStorageDirectory, requestId: trace.intent.requestId,
    environmentId: trace.environmentId, probe: trace.kind };
}
test("actual detached descendant delays query completion and only branded exact drain proof is accepted", async t => {
  const f = fixture(t), prepared = f.prepare(), reservation = reservePreparedLinuxEnvironmentQuery(prepared);
  const sameRequestOtherLaunch = f.prepare();
  const descriptor = describePreparedLinuxEnvironmentQuery(prepared);
  assert.equal(descriptor.launch.program, fs.realpathSync("/usr/bin/python3"));
  assert.deepEqual(descriptor.args, f.trace.args);
  assert.throws(() => reservePreparedLinuxEnvironmentQuery(prepared), /already reserved/);
  assert.throws(() => startPreparedLinuxEnvironmentQuery(prepared, {}), /invalid/);
  const execution = startPreparedLinuxEnvironmentQuery(prepared, reservation);
  await wait(() => fs.existsSync(f.ready));
  let settled = false; void execution.result.finally(() => { settled = true; }).catch(() => {});
  await pause(50); assert.equal(settled, false, "Original manager exit was incorrectly treated as physical drain.");
  assert.throws(() => environmentDrainProof(execution.child, execution.trace), /UNKNOWN/);
  assert.throws(() => startPreparedLinuxEnvironmentQuery(prepared, reservation), /consumed/);
  fs.writeFileSync(f.release, "");
  assert.equal(await execution.result, "manager completed\n");
  const proof = environmentDrainProof(execution.child, execution.trace);
  assertLinuxEnvironmentDrainProof(proof, binding(execution.trace));
  assertPreparedLinuxEnvironmentDrainProof(proof, prepared);
  assert.throws(() => assertPreparedLinuxEnvironmentDrainProof(proof, sameRequestOtherLaunch), /exact prepared launch/);
  assert.throws(() => assertLinuxEnvironmentDrainProof({ ...proof }, binding(execution.trace)), /invalid/);
  assert.throws(() => assertLinuxEnvironmentDrainProof(proof, { ...binding(execution.trace), requestId: crypto.randomUUID() }), /another request/);
  const profile = execution.trace.intent.globalStorageDirectory, retained = `${profile}-retained`;
  fs.renameSync(profile, retained); fs.mkdirSync(profile);
  assert.throws(() => assertPreparedLinuxEnvironmentDrainProof(proof, prepared), /directories changed/);
  fs.rmdirSync(profile); fs.renameSync(retained, profile);
});
test("manager stdout cannot impersonate the supervisor's protocol or open its protected output descriptor", async t => {
  const f = fixture(t), denied = path.join(f.base, "denied");
  f.trace.args = ["-I", "-B", "-c", `import os,time,json\ntry:\n os.open("/proc/%d/fd/1"%os.getppid(),os.O_WRONLY)\n raise RuntimeError("manager could open supervisor protocol")\nexcept PermissionError:\n open(${JSON.stringify(denied)},"w").write("denied")\np=os.fork()\nif p==0:\n os.close(1);os.close(2)\n open(${JSON.stringify(f.ready)},"w").write("ready")\n while not os.path.exists(${JSON.stringify(f.release)}): time.sleep(.01)\n os._exit(0)\nprint(json.dumps({"phase":"drained","managerCode":0}),flush=True)\nos._exit(0)\n`];
  const prepared = f.prepare(), execution = startPreparedLinuxEnvironmentQuery(prepared, reservePreparedLinuxEnvironmentQuery(prepared));
  await wait(() => fs.existsSync(f.ready));
  assert.equal(fs.readFileSync(denied, "utf8"), "denied");
  assert.throws(() => environmentDrainProof(execution.child, execution.trace), /UNKNOWN/);
  fs.writeFileSync(f.release, "");
  assert.equal(JSON.parse(await execution.result).phase, "drained", "Fake manager payload should remain ordinary captured stdout.");
  assertPreparedLinuxEnvironmentDrainProof(environmentDrainProof(execution.child, execution.trace), prepared);
});
test("timeout remains unknown; later physical completion is verification-only without replay", async t => {
  const f = fixture(t), prepared = f.prepare(150);
  const execution = startPreparedLinuxEnvironmentQuery(prepared, reservePreparedLinuxEnvironmentQuery(prepared));
  const failure = assert.rejects(execution.result, /UNKNOWN.*timed out/);
  await wait(() => fs.existsSync(f.ready));
  await failure;
  assert.throws(() => environmentDrainProof(execution.child, execution.trace), /UNKNOWN/);
  const originalPid = Number(fs.readFileSync(f.pidFile, "utf8"));
  process.kill(originalPid, 0);
  fs.writeFileSync(f.release, "");
  await wait(() => {
    try { environmentDrainProof(execution.child, execution.trace); return true; } catch { return false; }
  });
  assertLinuxEnvironmentDrainProof(environmentDrainProof(execution.child, execution.trace), binding(execution.trace));
  await assert.rejects(execution.result, /UNKNOWN.*timed out/);
  assert.equal(Number(fs.readFileSync(f.pidFile, "utf8")), originalPid);
});
test("supervisor crash preserves unknown while actual detached child lives; no fabricated completion", async t => {
  const f = fixture(t), prepared = f.prepare();
  const execution = startPreparedLinuxEnvironmentQuery(prepared, reservePreparedLinuxEnvironmentQuery(prepared));
  const failure = assert.rejects(execution.result, /UNKNOWN/);
  await wait(() => fs.existsSync(f.ready));
  const descendant = Number(fs.readFileSync(f.pidFile, "utf8"));
  execution.child.kill("SIGKILL");
  await failure;
  process.kill(descendant, 0);
  assert.throws(() => environmentDrainProof(execution.child, execution.trace), /UNKNOWN/);
  fs.writeFileSync(f.release, "");
  await pause(100);
  assert.throws(() => environmentDrainProof(execution.child, execution.trace), /UNKNOWN/);
});
