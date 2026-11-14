"use strict";
// Run with PKM_TEST_COMPILED and PKM_TEST_PYTHON pointing to isolated build outputs.
const assert = require("node:assert/strict");
const { spawn, spawnSync, fork } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const root = path.resolve(__dirname, "..");
const work = path.join(root, ".migration-test-work/root-upgrade-validation");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function host() {
  const { RetrievalWorkerManager } = require(process.env.PKM_TEST_COMPILED);
  const stat = fs.readFileSync("/proc/self/stat", "utf8");
  const startTimeTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const sessionRoot = process.argv[5];
  const session = sessionRoot && require(path.join(path.dirname(path.dirname(process.env.PKM_TEST_COMPILED)),
    "runtime/managed-writer-session.js"));
  const automatic = process.argv[4] === "automatic";
  let enrollment, profile, createdSession;
  if (automatic) {
    const bootstrapped = session.bootstrapManagedProfile(sessionRoot,
      require("node:crypto").createHash("sha256").update(String(process.pid)).digest("hex"));
    enrollment = bootstrapped.registration;
    createdSession = bootstrapped.created;
    process.env.PKM_MANAGED_WRITER_SESSION = enrollment.sessionId;
  }
  const manager = new RetrievalWorkerManager(process.argv[3], path.join(process.env.PKM_TEST_RESOURCES || path.join(root, "resources"), "retrieval_worker.py"),
    process.env.PKM_TEST_PYTHON, "0.3.0.dev2026100504", undefined, undefined,
    process.argv[4] === "default" || automatic ? undefined : { hostId: randomUUID(), pid: process.pid, startTimeTicks }, undefined,
    sessionRoot ? work => session.withManagedRetrievalOperation(sessionRoot, work) : undefined);
  if (automatic) {
    const activation = require(path.join(path.dirname(path.dirname(process.env.PKM_TEST_COMPILED)),
      "runtime/managed-profile-activation.js"));
    profile = activation.activateManagedProfileWriter(sessionRoot, enrollment.sessionId,
      () => manager.quiesceLocal(), 50, () => true, enrollment.profileId, undefined, enrollment);
  }
  const endpoint = await manager.ensure();
  process.send({ event: "ready", pid: endpoint.pid, createdSession });
  let releaseHeld;
  process.on("message", async ({ id, command }) => {
    try {
      let value;
      if (command === "handoff" || command === "handoff-short")
        value = await profile.handoff(command === "handoff" ? 30000 : 1000);
      else if (command === "profile-status") value = profile.status();
      else if (command === "status") value = await manager.status();
      else if (command === "lost-status") {
        const request = manager.request.bind(manager);
        manager.request = async (...args) => {
          const result = await request(...args);
          if (args[1] === "/status") {
            fs.writeFileSync(path.join(process.argv[3], "lost-response"), "real response received");
            throw new Error("Fixture dropped the real response");
          }
          return result;
        };
        try { value = await manager.status(); } finally { manager.request = request; }
      }
      else if (command === "held-status") {
        const request = manager.request.bind(manager);
        let held = false;
        manager.request = async (...args) => {
          const result = await request(...args);
          if (!held && args[1] === "/status") {
            held = true;
            await new Promise(resolve => {
              releaseHeld = resolve;
              fs.writeFileSync(path.join(process.argv[3], "held-status"), "ready");
            });
          }
          return result;
        };
        try { value = await manager.observeStatus(); } finally { manager.request = request; }
      } else if (command === "release-held") {
        if (!releaseHeld) throw new Error("No held retrieval request");
        releaseHeld(); value = "released";
      }
      else if (command === "index" || command === "lost-index" || command === "crash-before-index") {
        const documents = Array.from({ length: 12000 }, (_, i) => ({
          skill_id: `note:${i}`, source_id: `note:${i}`, title: `Fixture ${i}`,
          body: `document ${i} ` + "retrieval safety ".repeat(100), content_type: "note",
          source_uri: `pkm://notes/${i}`, metadata: {}, provenance: { provider: "pkm" },
        }));
        const originalFetch = global.fetch;
        if (command === "lost-index") global.fetch = async (...args) => {
          const response = await originalFetch(...args);
          if (String(args[0]).endsWith("/index")) {
            await response.text();
            fs.writeFileSync(path.join(process.argv[3], "lost-index-response"), "real response received");
            throw new Error("Fixture dropped the real index response");
          }
          return response;
        };
        if (command === "crash-before-index") global.fetch = async (...args) => {
          if (String(args[0]).endsWith("/index")) {
            fs.writeFileSync(path.join(process.argv[3], "before-index-dispatch"), "receipt persisted before fetch");
            process.kill(process.pid, "SIGKILL");
          }
          return originalFetch(...args);
        };
        try {
          await manager.index({ corpus_revision: "managed-host-test", documents });
          value = await manager.status();
        } finally { global.fetch = originalFetch; }
      } else if (command === "close" || command === "close-hold") value = await manager.closeOwned(120000);
      else throw new Error("Unknown fixture command");
      process.send({ id, value });
      if (command === "close") process.disconnect();
    } catch (error) {
      process.send({ id, error: String(error.message || error) });
      if (command === "close") process.disconnect();
    }
  });
}

function launch(state, mode = "managed", sessionRoot = "", sessionId) {
  const env = sessionId ? { ...process.env, PKM_MANAGED_WRITER_SESSION: sessionId } : process.env;
  const child = fork(__filename, ["--host", state, mode, sessionRoot], { cwd: root, env, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  let next = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    child.on("message", message => {
      if (message.event === "ready") resolve(message);
      else if (pending.has(message.id)) {
        const finish = pending.get(message.id);
        pending.delete(message.id);
        finish(message);
      }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(new Error(`Host exited before ready: ${code ?? signal}`));
      for (const finish of pending.values()) finish({ error: `Host exited: ${code ?? signal}` });
      pending.clear();
    });
  });
  return { child, ready, call: command => new Promise(resolve => {
    const id = ++next;
    pending.set(id, resolve);
    child.send({ id, command });
  }) };
}

function launchMcpOwner(state) {
  const child = spawn(process.env.PKM_TEST_PYTHON, [
    path.join(root, "tests/retrieval-mcp-owner-fixture.py"), state,
    process.env.PKM_TEST_RESOURCES || path.join(root, "resources"),
  ], { cwd: root, env: process.env, stdio: ["pipe", "pipe", "inherit"] });
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return { child, ready: lines.next().then(result => JSON.parse(result.value)),
    close: async () => { child.stdin.end("close\n"); return JSON.parse((await lines.next()).value); } };
}

async function main() {
  if (process.argv[2] === "--host") return host();
  if (process.argv[2] !== "--inside") {
    assert(process.env.PKM_TEST_COMPILED && process.env.PKM_TEST_PYTHON);
    const args = require(path.join(root, "scripts/run-next-trial-private-display")).privateNamespaceArgs(
      [process.execPath, __filename, "--inside"]);
    const result = spawnSync("unshare", args, { cwd: root, env: { ...process.env, TMPDIR: work },
      stdio: "inherit", timeout: 240000 });
    assert.equal(result.status, 0, String(result.error || result.signal));
    return;
  }
  assert.equal(spawnSync("ip", ["link", "set", "lo", "up"]).status, 0);
  const fixture = path.join(work, "retrieval-managed-hosts-" + randomUUID());
  const state = path.join(fixture, "state");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const ordinaryState = path.join(fixture, "ordinary-state");
  fs.mkdirSync(ordinaryState, { mode: 0o700 });
  const normalA = launch(ordinaryState, "default"), normalAr = await normalA.ready;
  const normalB = launch(ordinaryState, "default"), normalBr = await normalB.ready;
  assert.equal(normalAr.pid, normalBr.pid);
  const active = normalA.call("held-status");
  for (let i = 0; i < 200 && !fs.existsSync(path.join(ordinaryState, "held-status")); i++) await pause(25);
  assert(fs.existsSync(path.join(ordinaryState, "held-status")), "Real status call was not admitted");
  let closeFinished = false;
  const ordinaryClose = normalA.call("close-hold").then(result => { closeFinished = true; return result; });
  assert.match((await normalA.call("status")).error, /admission is closed/i);
  assert.equal((await normalB.call("status")).error, undefined);
  assert.equal((await normalB.call("index")).value.building_revision, "managed-host-test");
  assert.equal(closeFinished, false, "Local drain must wait for the already admitted request");
  assert.equal((await normalA.call("release-held")).value, "released");
  assert.equal((await active).error, undefined);
  assert.equal((await ordinaryClose).value, "unused");
  assert.equal((await normalB.call("close-hold")).value, "unused");
  assert(fs.existsSync(path.join("/proc", String(normalAr.pid), "stat")), "Default close must not kill the shared worker");
  normalA.child.disconnect(); normalB.child.disconnect();
  console.log("DEFAULT_SHARED_RETRIEVAL", JSON.stringify({ pid: normalAr.pid, twoHosts: true,
    closedHostRejectedLateWork: true, admittedStatusWaited: true, statusReturnHeldByFixture: true,
    otherHostRealIndexContinued: true, workerPreserved: true }));
  const sessionRoot = path.join(fixture, "session-root"), sessionState = path.join(fixture, "session-state");
  fs.mkdirSync(sessionRoot, { mode: 0o700 }); fs.mkdirSync(sessionState, { mode: 0o700 });
  const session = require(path.join(path.dirname(path.dirname(process.env.PKM_TEST_COMPILED)), "runtime/managed-writer-session.js"));
  const sessionA = launch(sessionState, "automatic", sessionRoot);
  const sessionB = launch(sessionState, "automatic", sessionRoot);
  const [sa, sb] = await Promise.all([sessionA.ready, sessionB.ready]);
  assert.equal(Number(sa.createdSession) + Number(sb.createdSession), 1);
  assert.equal(sa.pid, sb.pid);
  const submitted = await sessionB.call("index");
  assert.equal(submitted.error, undefined);
  assert.equal(submitted.value.building_revision, "managed-host-test");
  const admitted = sessionA.call("held-status");
  for (let i = 0; i < 200 && !fs.existsSync(path.join(sessionState, "held-status")); i++) await pause(25);
  assert(fs.existsSync(path.join(sessionState, "held-status")), "Bound real status call was not admitted");
  const handoff = sessionA.call("handoff");
  const marker = path.join(sessionRoot, ".pkm/state/managed-writer-session/fenced");
  for (let i = 0; i < 200 && !fs.existsSync(marker); i++) await pause(25);
  assert(fs.existsSync(marker), "Automatic profile did not fence the session");
  assert.match((await sessionB.call("status")).error, /fenced|admission is closed/i);
  assert.equal((await sessionA.call("release-held")).value, "released");
  assert.equal((await admitted).error, undefined);
  const handoffResult = await handoff;
  if (handoffResult.error) console.error("SESSION_HANDOFF_DIAGNOSTIC", JSON.stringify({
    error: handoffResult.error, a: await sessionA.call("profile-status"), b: await sessionB.call("profile-status"),
  }));
  assert.equal(handoffResult.error, undefined);
  assert.equal(handoffResult.value.registeredWritersDrained, true);
  assert.equal(handoffResult.value.preexistingAndExternalWriters, "unknown");
  assert.equal(handoffResult.value.cutoverAuthorized, false);
  const buildRecords = root => {
    const dir = path.join(root, ".pkm/state/managed-writer-session/operations");
    return fs.readdirSync(dir).map(name => ({ name, record: JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) }))
      .filter(item => item.record.kind === "retrieval-build");
  };
  const confirmedBuild = buildRecords(sessionRoot);
  assert.equal(confirmedBuild.filter(item => item.record.phase === "pending").length, 1);
  assert.equal(confirmedBuild.filter(item => item.record.phase === "complete").length, 1);
  assert.equal(confirmedBuild[0].record.revisionHash,
    require("node:crypto").createHash("sha256").update("managed-host-test").digest("hex"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(sessionState, "snapshot.json"), "utf8")).corpus_revision,
    "managed-host-test");
  assert.equal((await sessionA.call("close-hold")).value, "unused");
  assert.equal((await sessionB.call("close-hold")).value, "unused");
  assert(fs.existsSync(path.join("/proc", String(sa.pid), "stat")), "Session fence must not stop shared retrieval");
  sessionA.child.disconnect(); sessionB.child.disconnect();
  console.log("SESSION_SHARED_RETRIEVAL", JSON.stringify({ pid: sa.pid, twoHosts: true,
    admittedStatusFinished: true, submittedBuildFinished: true, otherHostDeniedAfterFence: true, workerPreserved: true,
    externalWriters: "unknown" }));
  const lostRoot = path.join(fixture, "session-lost-root"), lostState = path.join(fixture, "session-lost-state");
  fs.mkdirSync(lostRoot, { mode: 0o700 }); fs.mkdirSync(lostState, { mode: 0o700 });
  const lost = launch(lostState, "automatic", lostRoot), lostReady = await lost.ready;
  assert.match((await lost.call("lost-status")).error, /unknown|dropped the real response/i);
  assert(fs.existsSync(path.join(lostState, "lost-response")), "Fixture must actually drop a real response");
  assert.match((await lost.call("handoff-short")).error, /unknown|active/i);
  assert(fs.existsSync(path.join("/proc", String(lostReady.pid), "stat")), "Lost response must not kill shared worker");
  lost.child.disconnect();
  console.log("SESSION_LOST_RETRIEVAL", JSON.stringify({ pid: lostReady.pid, response: "fixture-dropped",
    handoff: "rejected", workerPreserved: true }));
  const lostBuildRoot = path.join(fixture, "session-lost-build-root"), lostBuildState = path.join(fixture, "session-lost-build-state");
  fs.mkdirSync(lostBuildRoot, { mode: 0o700 }); fs.mkdirSync(lostBuildState, { mode: 0o700 });
  const lostBuild = launch(lostBuildState, "automatic", lostBuildRoot), lostBuildReady = await lostBuild.ready;
  assert.match((await lostBuild.call("lost-index")).error, /dropped the real index response/);
  assert(fs.existsSync(path.join(lostBuildState, "lost-index-response")));
  assert.deepEqual(buildRecords(lostBuildRoot).map(item => item.record.phase), ["pending"]);
  assert.match((await lostBuild.call("handoff-short")).error, /unknown|active/i);
  assert(fs.existsSync(path.join("/proc", String(lostBuildReady.pid), "stat")));
  lostBuild.child.disconnect();
  console.log("SESSION_LOST_BUILD", JSON.stringify({ response: "fixture-dropped", receipt: "pending-unknown",
    handoff: "rejected", workerPreserved: true }));
  const beforeRoot = path.join(fixture, "session-before-build-root"), beforeState = path.join(fixture, "session-before-build-state");
  fs.mkdirSync(beforeRoot, { mode: 0o700 }); fs.mkdirSync(beforeState, { mode: 0o700 });
  const before = launch(beforeState, "automatic", beforeRoot), beforeReady = await before.ready;
  assert.match((await before.call("crash-before-index")).error, /Host exited/);
  assert(fs.existsSync(path.join(beforeState, "before-index-dispatch")));
  assert.deepEqual(buildRecords(beforeRoot).map(item => item.record.phase), ["pending"]);
  const beforeId = JSON.parse(fs.readFileSync(path.join(beforeRoot, ".pkm/state/managed-writer-session/session.json"), "utf8")).id;
  await assert.rejects(session.orchestrateManagedWriterHandoff(beforeRoot, beforeId, [], 100), /unknown|active/i);
  assert(fs.existsSync(path.join("/proc", String(beforeReady.pid), "stat")));
  console.log("SESSION_BEFORE_BUILD", JSON.stringify({ beforeFetch: true, receipt: "pending-unknown",
    handoff: "rejected", workerPreserved: true }));
  const buildRoot = path.join(fixture, "session-build-crash-root"), buildState = path.join(fixture, "session-build-crash-state");
  fs.mkdirSync(buildRoot, { mode: 0o700 }); fs.mkdirSync(buildState, { mode: 0o700 });
  const build = launch(buildState, "automatic", buildRoot), buildReady = await build.ready;
  const pendingBuild = await build.call("index");
  assert.equal(pendingBuild.error, undefined);
  assert.equal(pendingBuild.value.building_revision, "managed-host-test");
  assert.deepEqual(buildRecords(buildRoot).map(item => item.record.phase), ["pending"]);
  const buildArgv = fs.readFileSync(`/proc/${buildReady.pid}/cmdline`, "utf8").split("\0");
  assert(buildArgv.includes(buildState) && buildArgv.some(arg => arg.endsWith("/retrieval_worker.py")));
  process.kill(buildReady.pid, "SIGKILL");
  for (let i = 0; i < 200; i++) {
    try {
      const stat = fs.readFileSync(`/proc/${buildReady.pid}/stat`, "utf8");
      if (["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0])) break;
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
    await pause(25);
  }
  assert.match((await build.call("handoff-short")).error, /unknown|identity|ENOENT/i);
  assert.deepEqual(buildRecords(buildRoot).map(item => item.record.phase), ["pending"]);
  build.child.disconnect();
  console.log("SESSION_BUILD_CRASH", JSON.stringify({ submittedBuild: "unknown", handoff: "rejected" }));
  const hostBuildRoot = path.join(fixture, "session-host-build-crash-root");
  const hostBuildState = path.join(fixture, "session-host-build-crash-state");
  fs.mkdirSync(hostBuildRoot, { mode: 0o700 }); fs.mkdirSync(hostBuildState, { mode: 0o700 });
  const hostBuild = launch(hostBuildState, "automatic", hostBuildRoot), hostBuildReady = await hostBuild.ready;
  assert.equal((await hostBuild.call("index")).error, undefined);
  assert.deepEqual(buildRecords(hostBuildRoot).map(item => item.record.phase), ["pending"]);
  const hostBuildExit = new Promise(resolve => hostBuild.child.once("exit", resolve));
  hostBuild.child.kill("SIGKILL");
  await hostBuildExit;
  const restartedHost = launch(hostBuildState, "automatic", hostBuildRoot), restartedReady = await restartedHost.ready;
  assert.equal(restartedReady.pid, hostBuildReady.pid);
  assert.equal((await restartedHost.call("status")).error, undefined);
  assert.match((await restartedHost.call("handoff-short")).error, /unknown|active/i);
  assert.deepEqual(buildRecords(hostBuildRoot).map(item => item.record.phase), ["pending"]);
  assert(fs.existsSync(path.join("/proc", String(hostBuildReady.pid), "stat")));
  restartedHost.child.disconnect();
  console.log("SESSION_HOST_BUILD_RESTART", JSON.stringify({ priorBuild: "pending-unknown",
    newHostJoined: true, workerPreserved: true, handoff: "rejected" }));
  const killedRoot = path.join(fixture, "session-crash-root"), killedState = path.join(fixture, "session-crash-state");
  fs.mkdirSync(killedRoot, { mode: 0o700 }); fs.mkdirSync(killedState, { mode: 0o700 });
  const killed = launch(killedState, "automatic", killedRoot), killedReady = await killed.ready;
  const killedRequest = killed.call("held-status");
  for (let i = 0; i < 200 && !fs.existsSync(path.join(killedState, "held-status")); i++) await pause(25);
  assert(fs.existsSync(path.join(killedState, "held-status")), "Crash fixture did not admit request");
  const killedExit = new Promise(resolve => killed.child.once("exit", resolve));
  killed.child.kill("SIGKILL");
  await killedExit;
  assert.match((await killedRequest).error, /Host exited/);
  const killedId = JSON.parse(fs.readFileSync(path.join(killedRoot, ".pkm/state/managed-writer-session/session.json"), "utf8")).id;
  await assert.rejects(session.orchestrateManagedWriterHandoff(killedRoot, killedId, [], 100), /unknown|active/i);
  assert(fs.existsSync(path.join("/proc", String(killedReady.pid), "stat")), "Crashed host must not kill shared worker");
  console.log("SESSION_CRASH_RETRIEVAL", JSON.stringify({ pid: killedReady.pid, pendingRequest: "unknown",
    handoff: "rejected", workerPreserved: true }));
  const a = launch(state), ar = await a.ready;
  const b = launch(state), br = await b.ready;
  assert.equal(ar.pid, br.pid);
  let old;
  if (process.env.PKM_TEST_LEGACY_EXTENSION) {
    const legacy = process.env.PKM_TEST_LEGACY_EXTENSION;
    const { RetrievalWorkerManager } = require(path.join(legacy, "dist/retrieval/retrieval-worker.js"));
    old = new RetrievalWorkerManager(state, path.join(legacy, "resources/retrieval_worker.py"),
      process.env.PKM_TEST_PYTHON, "0.3.0.dev2026100504");
    await assert.rejects(old.ensure(), /newer PKM retrieval worker/i);
    assert.equal((await b.call("status")).error, undefined);
  }
  const endpoint = JSON.parse(fs.readFileSync(path.join(state, "worker.json"), "utf8"));
  const call = (route, body) => fetch(`http://127.0.0.1:${endpoint.port}${route}`, {
    method: "POST", headers: { "X-PKM-Retrieval-Token": endpoint.token, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  assert.equal((await call("/shutdown", {})).status, 409);
  const ownerId = fs.readdirSync(path.join(state, "owners")).find(name => name.endsWith(".open")).slice(0, -5);
  assert.equal((await call("/owners/close", { id: ownerId, proof: "b".repeat(64) })).status, 400);
  assert.equal((await call("/owners/open", { id: randomUUID(), host: randomUUID(), pid: process.pid,
    start: "1", proof: "c".repeat(64) })).status, 400);
  assert.equal((await a.call("close")).value, "shared");
  assert.equal((await b.call("status")).error, undefined);
  const indexed = await b.call("index");
  assert.equal(indexed.error, undefined);
  assert.equal(indexed.value.building_revision, "managed-host-test");
  const closing = b.call("close");
  if (old) {
    let draining = false;
    for (let i = 0; i < 200 && !draining; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${endpoint.port}/status`, {
          headers: { "X-PKM-Retrieval-Token": endpoint.token }, signal: AbortSignal.timeout(1000),
        });
        draining = (await response.json()).draining === true;
      } catch {}
      if (!draining) await pause(10);
    }
    assert(draining, "Expected to observe the in-flight worker draining");
    await assert.rejects(old.ensure(), /newer PKM retrieval worker/i);
  }
  assert.equal((await closing).value, "stopped");
  const snapshot = JSON.parse(fs.readFileSync(path.join(state, "snapshot.json"), "utf8"));
  assert.equal(snapshot.corpus_revision, "managed-host-test");
  assert.equal(snapshot.documents.length, 12000);

  if (process.env.PKM_TEST_LEGACY_EXTENSION) {
    const legacy = process.env.PKM_TEST_LEGACY_EXTENSION;
    const legacyState = path.join(fixture, "legacy-state");
    fs.mkdirSync(legacyState, { mode: 0o700 });
    const OldManager = require(path.join(legacy, "dist/retrieval/retrieval-worker.js")).RetrievalWorkerManager;
    const NewManager = require(process.env.PKM_TEST_COMPILED).RetrievalWorkerManager;
    const oldWorker = new OldManager(legacyState, path.join(legacy, "resources/retrieval_worker.py"),
      process.env.PKM_TEST_PYTHON, "0.3.0.dev2026100504");
    const legacyEndpoint = await oldWorker.ensure();
    const snapshot = { corpus_revision: "original-index", documents: [{
      skill_id: "note:legacy", source_id: "note:legacy", title: "Original fixture",
      body: "Distinct legacy retrieval content", content_type: "note", source_uri: "pkm://notes/legacy",
      metadata: {}, provenance: { provider: "pkm" },
    }] };
    await oldWorker.index(snapshot);
    for (let i = 0; i < 200; i++) {
      if ((await oldWorker.status()).corpus_revision === snapshot.corpus_revision) break;
      await pause(50);
    }
    assert.equal((await oldWorker.status()).corpus_revision, snapshot.corpus_revision);
    const selfStat = fs.readFileSync("/proc/self/stat", "utf8");
    const identity = { hostId: randomUUID(), pid: process.pid,
      startTimeTicks: selfStat.slice(selfStat.lastIndexOf(")") + 2).split(" ")[19] };
    for (const owner of [undefined, identity]) {
      let notices = 0;
      const current = new NewManager(legacyState,
        path.join(process.env.PKM_TEST_RESOURCES || path.join(root, "resources"), "retrieval_worker.py"),
        process.env.PKM_TEST_PYTHON, "0.3.0.dev2026100504", undefined, undefined, owner, () => { notices++; });
      assert.equal((await current.ensure()).pid, legacyEndpoint.pid);
      assert(current.isLegacyReadOnly());
      const read = await current.search("distinct legacy retrieval");
      assert.equal(read.ok, true);
      assert(read.hits.some(hit => hit.sourceId === "note:legacy"));
      await assert.rejects(current.index(snapshot), /read-only/i);
      await assert.rejects(current.sync(snapshot), /read-only/i);
      await assert.rejects(current.syncSkills(snapshot), /read-only/i);
      await assert.rejects(current.importSolution("fixture.zip"), /read-only/i);
      assert(notices >= 1);
      assert.equal((await oldWorker.ensure()).pid, legacyEndpoint.pid);
      assert.equal((await oldWorker.status()).ok, true);
      if (owner) assert.equal(await current.closeOwned(), "unused");
    }
    const observed = await oldWorker.status();
    const unknown = new NewManager(legacyState, "/unused", "/unused", "0.3.0.dev2026100504");
    unknown.modelRuntime = () => ({ configured: false });
    unknown.runtimeFiles = () => ({ version: "4.0.839", build: "candidate" });
    unknown.readEndpoint = () => legacyEndpoint;
    unknown.processAlive = () => true;
    unknown.request = async (_endpoint, route) => {
      assert.equal(route, "/status");
      return { ...observed, runtime: { ...observed.runtime, worker_build: "0".repeat(64) } };
    };
    await assert.rejects(unknown.ensureLocked(), /not stopped/i);
    assert.equal((await oldWorker.status()).ok, true);
  }

  const crashState = path.join(fixture, "crash-state");
  fs.mkdirSync(crashState, { mode: 0o700 });
  const c = launch(crashState), cr = await c.ready;
  const d = launch(crashState), dr = await d.ready;
  assert.equal(cr.pid, dr.pid);
  const exited = new Promise(resolve => c.child.once("exit", resolve));
  c.child.kill("SIGKILL");
  await exited;
  const close = await d.call("close");
  assert.match(close.error, /unknown/i);
  assert(fs.existsSync(path.join("/proc", String(cr.pid), "stat")));
  const e = launch(crashState), er = await e.ready;
  assert.equal(er.pid, cr.pid);
  assert.match((await e.call("close")).error, /unknown/i);

  const workerCrashState = path.join(fixture, "worker-crash-state");
  fs.mkdirSync(workerCrashState, { mode: 0o700 });
  const f = launch(workerCrashState), fr = await f.ready;
  const argv = fs.readFileSync(`/proc/${fr.pid}/cmdline`, "utf8").split("\0");
  assert(argv.includes(workerCrashState) && argv.some(arg => arg.endsWith("/retrieval_worker.py")));
  process.kill(fr.pid, "SIGKILL");
  for (let i = 0; i < 200; i++) {
    try {
      const stat = fs.readFileSync(`/proc/${fr.pid}/stat`, "utf8");
      if (["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0])) break;
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
    await pause(25);
  }
  assert.match((await f.call("close")).error, /unknown|identity|ENOENT/i);
  const g = launch(workerCrashState), gr = await g.ready;
  assert.notEqual(gr.pid, fr.pid);
  assert.match((await g.call("close")).error, /unknown/i);
  const mcpState = path.join(fixture, "mcp-state");
  fs.mkdirSync(mcpState, { mode: 0o700 });
  const h = launch(mcpState), hr = await h.ready;
  const i = launch(mcpState), ir = await i.ready;
  assert.equal(hr.pid, ir.pid);
  const mcp = launchMcpOwner(mcpState);
  assert.equal((await mcp.ready).event, "ready");
  assert.equal((await h.call("close")).value, "shared");
  assert.equal((await i.call("index")).value.building_revision, "managed-host-test");
  assert.equal((await i.call("close")).value, "shared");
  assert.equal((await mcp.close()).result, "stopped");
  const mcpSnapshot = JSON.parse(fs.readFileSync(path.join(mcpState, "snapshot.json"), "utf8"));
  assert.equal(mcpSnapshot.documents.length, 12000);
  console.log(JSON.stringify({ fixture, sharedWorker: true, firstClose: "shared", secondStillWorks: true,
    inFlightDocumentsCommitted: snapshot.documents.length, lastClose: "stopped", crashClose: "unknown",
    hostRestart: "unknown", workerRestart: "unknown", invalidProofRejected: true,
    mismatchedHostRejected: true, shutdownWithOwnersRejected: true,
    legacyManagerRejectedDuringWorkAndDrainWithoutStoppingWorker: !!old,
    originalReadOnlyFallbackForBothCandidateModes: !!old,
    separateMcpOwnerLastClose: "stopped", mcpOwnerInFlightDocuments: mcpSnapshot.documents.length,
    crashWorkerRetainedUntilPrivateNamespaceExit: true }));
  await pause(100);
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
