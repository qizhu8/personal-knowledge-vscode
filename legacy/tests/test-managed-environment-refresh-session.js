"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const build = process.env.PKM_ENV_AUTHORITY_BUILD;
if (!build || !path.isAbsolute(build)) throw new Error("PKM_ENV_AUTHORITY_BUILD must select the isolated compiled build.");
const session = require(path.join(build, "runtime/managed-writer-session.js"));
const supervisor = require(path.join(build, "runtime/linux-environment-supervisor.js"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("Timed out waiting for fixture descendant.");
    await delay(10);
  }
}

test("registered Environment refresh remains pending through live descendants and requires its exact physical proof",
  { timeout: 30000, skip: process.platform !== "linux" }, async t => {
    const base = path.resolve(".migration-test-work", `managed-environment-session-${randomUUID()}`);
    const root = path.join(base, "root"), profile = path.join(base, "profile"), ready = path.join(base, "ready");
    const release = path.join(base, "release");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(profile, { mode: 0o700 });
    const original = process.env.PKM_MANAGED_WRITER_SESSION, id = randomUUID(), runs = [];
    t.after(async () => {
      fs.writeFileSync(release, "");
      await Promise.allSettled(runs.map(run => run.result));
      if (original === undefined) delete process.env.PKM_MANAGED_WRITER_SESSION;
      else process.env.PKM_MANAGED_WRITER_SESSION = original;
      fs.rmSync(base, { recursive: true, force: true });
    });

    session.provisionManagedWriterSession(root, id);
    const script = `import os,time\np=os.fork()\nif p==0:\n os.setsid()\n os.close(1);os.close(2)\n open(${JSON.stringify(ready)},"a").write("ready\\n")\n while not os.path.exists(${JSON.stringify(release)}): time.sleep(.01)\n os._exit(0)\nprint("manager exited",flush=True)\nos._exit(0)\n`;
    const trace = { intent: { requestId: randomUUID(), workspaceId: randomUUID(), actorId: "local:owner",
      knowledgeRoot: root, globalStorageDirectory: profile, operation: "packages", refresh: true,
      environments: [{ id: "retained", path: base, python: "/usr/bin/python3", manager: "venv" }] },
    environmentId: "retained", kind: "packages", program: "/usr/bin/python3", args: ["-I", "-B", "-c", script],
    environment: { PATH: "/usr/bin:/bin", HOME: base, TMPDIR: base, PYTHONDONTWRITEBYTECODE: "1" } };
    const prepare = () => supervisor.prepareLinuxEnvironmentQuery(trace, {
      python: "/usr/bin/python3", timeoutMs: 10000, maxBuffer: 4096,
    });
    const missing = prepare();
    delete process.env.PKM_MANAGED_WRITER_SESSION;
    assert.throws(() => session.beginManagedEnvironmentRefresh(root, missing), /explicitly enrolled/);
    process.env.PKM_MANAGED_WRITER_SESSION = id;
    const changedProfile = prepare();
    fs.renameSync(profile, `${profile}-previous`);
    fs.mkdirSync(profile, { mode: 0o700 });
    assert.throws(() => session.beginManagedEnvironmentRefresh(root, changedProfile), /identity changed/);
    fs.rmdirSync(profile);
    fs.renameSync(`${profile}-previous`, profile);
    assert.throws(() => session.beginManagedEnvironmentRefresh(root, changedProfile), /already registered/);
    const first = prepare(), second = prepare();
    const firstReservation = supervisor.reservePreparedLinuxEnvironmentQuery(first);
    const secondReservation = supervisor.reservePreparedLinuxEnvironmentQuery(second);
    const firstRegistration = session.beginManagedEnvironmentRefresh(root, first);
    const secondRegistration = session.beginManagedEnvironmentRefresh(root, second);
    assert.throws(() => session.beginManagedEnvironmentRefresh(root, first), /already registered/);
    const operations = path.join(root, ".pkm/state/managed-writer-session/operations");
    const files = fs.readdirSync(operations);
    assert.equal(files.length, 2);
    assert.throws(() => session.completeManagedWriterOperation(root, {
      sessionId: id, operationId: files[0].replace(/\.pending$/, ""), kind: "environment-refresh",
    }), /Invalid managed writer completion/);
    const firstRun = supervisor.startPreparedLinuxEnvironmentQuery(first, firstReservation);
    const secondRun = supervisor.startPreparedLinuxEnvironmentQuery(second, secondReservation);
    runs.push(firstRun, secondRun);
    await until(() => fs.existsSync(ready) && fs.readFileSync(ready, "utf8").split("\n").length >= 3);
    assert.throws(() => session.fenceManagedWriterSession(root, id), /operation is invalid|active or has an unknown outcome/);
    assert.throws(() => supervisor.environmentDrainProof(firstRun.child, firstRun.trace), /UNKNOWN/);
    fs.writeFileSync(release, "");
    assert.equal(await firstRun.result, "manager exited\n");
    assert.equal(await secondRun.result, "manager exited\n");
    const firstProof = supervisor.environmentDrainProof(firstRun.child, firstRun.trace);
    const secondProof = supervisor.environmentDrainProof(secondRun.child, secondRun.trace);
    assert.throws(() => session.completeManagedEnvironmentRefresh({ ...firstRegistration }, firstProof), /registration is invalid/);
    assert.throws(() => session.completeManagedEnvironmentRefresh(secondRegistration, firstProof), /exact prepared launch/);
    assert.throws(() => session.completeManagedEnvironmentRefresh(firstRegistration, { ...firstProof }), /invalid/);
    assert.throws(() => session.completeManagedEnvironmentRefresh(firstRegistration, firstProof), /transaction completion is not/);
    assert.throws(() => session.completeManagedEnvironmentRefresh(firstRegistration, firstProof,
      { kind: "pkm.environment-refresh-transaction/v1" }), /transaction completion is not/);
    assert.throws(() => session.completeManagedEnvironmentRefresh(secondRegistration, secondProof), /transaction completion is not/);
    assert.equal(fs.readdirSync(operations).filter(name => name.endsWith(".complete")).length, 0);
    assert.throws(() => session.fenceManagedWriterSession(root, id), /operation is invalid|active or has an unknown outcome/);
  });

test("supervisor crash with a live descendant leaves the registered refresh pending",
  { timeout: 30000, skip: process.platform !== "linux" }, async t => {
    const base = path.resolve(".migration-test-work", `managed-environment-crash-${randomUUID()}`);
    const root = path.join(base, "root"), profile = path.join(base, "profile");
    const ready = path.join(base, "ready"), release = path.join(base, "release");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(profile, { mode: 0o700 });
    const original = process.env.PKM_MANAGED_WRITER_SESSION, id = randomUUID();
    let execution;
    t.after(async () => {
      fs.writeFileSync(release, "");
      if (execution) await Promise.allSettled([execution.result]);
      if (original === undefined) delete process.env.PKM_MANAGED_WRITER_SESSION;
      else process.env.PKM_MANAGED_WRITER_SESSION = original;
      await delay(100);
      fs.rmSync(base, { recursive: true, force: true });
    });
    session.provisionManagedWriterSession(root, id);
    process.env.PKM_MANAGED_WRITER_SESSION = id;
    const script = `import os,time\np=os.fork()\nif p==0:\n os.setsid()\n os.close(1);os.close(2)\n open(${JSON.stringify(ready)},"w").write(str(os.getpid()))\n while not os.path.exists(${JSON.stringify(release)}): time.sleep(.01)\n os._exit(0)\nos._exit(0)\n`;
    const trace = { intent: { requestId: randomUUID(), workspaceId: randomUUID(), actorId: "local:owner",
      knowledgeRoot: root, globalStorageDirectory: profile, operation: "packages", refresh: true,
      environments: [{ id: "retained", path: base, python: "/usr/bin/python3", manager: "venv" }] },
    environmentId: "retained", kind: "packages", program: "/usr/bin/python3", args: ["-I", "-B", "-c", script],
    environment: { PATH: "/usr/bin:/bin", HOME: base, TMPDIR: base, PYTHONDONTWRITEBYTECODE: "1" } };
    const prepared = supervisor.prepareLinuxEnvironmentQuery(trace, {
      python: "/usr/bin/python3", timeoutMs: 10000, maxBuffer: 4096,
    });
    const reservation = supervisor.reservePreparedLinuxEnvironmentQuery(prepared);
    session.beginManagedEnvironmentRefresh(root, prepared);
    execution = supervisor.startPreparedLinuxEnvironmentQuery(prepared, reservation);
    const failed = assert.rejects(execution.result, /UNKNOWN/);
    await until(() => fs.existsSync(ready) && fs.readFileSync(ready, "utf8").length > 0);
    const descendant = Number(fs.readFileSync(ready, "utf8"));
    execution.child.kill("SIGKILL");
    await failed;
    process.kill(descendant, 0);
    assert.throws(() => supervisor.environmentDrainProof(execution.child, execution.trace), /UNKNOWN/);
    assert.throws(() => session.fenceManagedWriterSession(root, id), /operation is invalid|active or has an unknown outcome/);
    const operations = fs.readdirSync(path.join(root, ".pkm/state/managed-writer-session/operations"));
    assert.equal(operations.filter(name => name.endsWith(".pending")).length, 1);
    assert.equal(operations.filter(name => name.endsWith(".complete")).length, 0);
  });
