const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { provisionManagedWriterSession, rotateManagedWriterSession, managedWriterAdmissionState,
  resolveManagedWriterSession, withManagedWriterOperation } = require("../dist/runtime/managed-writer-session");
const { activateManagedProfileWriter, installedManagedProfileCompatible, unambiguousDefaultProfileStorage,
  observeManagedProfileInstallations } = require("../dist/runtime/managed-profile-activation");
const { withCrossProcessLockSync } = require("../dist/runtime/cross-process-lock");

const project = path.resolve(__dirname, "..");
const profileId = name => createHash("sha256").update(name).digest("hex");
const waitFor = async (condition, timeout = 5000) => {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= end) throw new Error("Timed out waiting for isolated profile.");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

test("shared global storage does not identify a named profile", () => {
  const root = path.join(project, ".migration-test-work", `profile-index-${randomUUID()}`);
  const user = path.join(root, "User"), storage = path.join(user, "globalStorage", "fixture.extension");
  fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
  try {
    assert.equal(unambiguousDefaultProfileStorage(storage), true);
    fs.mkdirSync(path.join(user, "profiles", "named"), { recursive: true });
    assert.equal(unambiguousDefaultProfileStorage(storage), false);
    assert.equal(unambiguousDefaultProfileStorage(path.join(root, "unrelated")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("automatic restart requires intact known-compatible installed coordinator bytes", () => {
  const root = path.join(project, ".migration-test-work", `profile-package-${randomUUID()}`);
  const runtime = path.join(root, "dist/runtime");
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  try {
    const files = {};
    for (const name of ["managed-profile-activation.js", "managed-writer-session.js"]) {
      const source = fs.readFileSync(path.join(project, "dist/runtime", name));
      fs.writeFileSync(path.join(runtime, name), source);
      files[`dist/runtime/${name}`] = createHash("sha256").update(source).digest("hex");
    }
    const extension = Buffer.from("resolveManagedWriterSession");
    fs.writeFileSync(path.join(root, "dist/extension.js"), extension);
    files["dist/extension.js"] = createHash("sha256").update(extension).digest("hex");
    const buildId = createHash("sha256").update(JSON.stringify(files)).digest("hex");
    fs.writeFileSync(path.join(root, "dist/build-info.json"), JSON.stringify({ schema: "pkm.extension-build/v1", files, buildId }));
    assert.equal(installedManagedProfileCompatible(root), true);
    fs.appendFileSync(path.join(runtime, "managed-writer-session.js"), "tampered");
    assert.equal(installedManagedProfileCompatible(root), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("named installation changes are observed without guessing the active profile", () => {
  const root = path.join(project, ".migration-test-work", `profile-indexes-${randomUUID()}`);
  const user = path.join(root, "User"), storage = path.join(user, "globalStorage", "fixture.extension");
  const extensions = path.join(root, "extensions"), named = path.join(user, "profiles", "named", "extensions.json");
  const defaultIndex = path.join(extensions, "extensions.json");
  fs.mkdirSync(path.dirname(named), { recursive: true, mode: 0o700 });
  fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
  function packageAt(version) {
    const dir = path.join(extensions, `uone.personal-knowledge-${version}`), runtime = path.join(dir, "dist/runtime");
    fs.mkdirSync(runtime, { recursive: true });
    const files = {};
    for (const name of ["managed-profile-activation.js", "managed-writer-session.js"]) {
      const source = fs.readFileSync(path.join(project, "dist/runtime", name));
      fs.writeFileSync(path.join(runtime, name), source);
      files[`dist/runtime/${name}`] = createHash("sha256").update(source).digest("hex");
    }
    const extension = Buffer.from(`resolveManagedWriterSession ${version}`);
    fs.writeFileSync(path.join(dir, "dist/extension.js"), extension);
    files["dist/extension.js"] = createHash("sha256").update(extension).digest("hex");
    fs.writeFileSync(path.join(dir, "dist/build-info.json"), JSON.stringify({
      schema: "pkm.extension-build/v1", version, builtAt: "fixture", files,
      buildId: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    }));
    return dir;
  }
  const entry = (dir, version) => ({ identifier: { id: "uone.personal-knowledge" }, version,
    location: { scheme: "file", fsPath: dir } });
  try {
    const old = packageAt("1.0.0"), next = packageAt("1.0.1");
    fs.writeFileSync(defaultIndex, JSON.stringify([entry(old, "1.0.0")]));
    fs.writeFileSync(named, JSON.stringify([entry(old, "1.0.0")]));
    const observer = observeManagedProfileInstallations(storage, old, "uone.personal-knowledge");
    assert.equal(observer.ready(), true);
    assert.equal(observer.changed(), false);
    fs.writeFileSync(named, JSON.stringify([entry(next, "1.0.1")]));
    assert.equal(observer.ready(), true);
    assert.equal(observer.changed(), true);
    const restarted = observeManagedProfileInstallations(storage, old, "uone.personal-knowledge");
    assert.equal(restarted.changed(), false);
    fs.writeFileSync(defaultIndex, JSON.stringify([entry(next, "1.0.1")]));
    assert.equal(observeManagedProfileInstallations(storage, old, "uone.personal-knowledge").changed(), true);
    fs.appendFileSync(path.join(next, "dist/runtime/managed-writer-session.js"), "tampered");
    assert.equal(observer.ready(), false);
    assert.equal(observer.changed(), false);
    fs.writeFileSync(named, "{");
    assert.equal(observer.ready(), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("active profiles independently observe a session fence and drain their own writer", {
  skip: process.platform !== "linux", timeout: 20000,
}, async () => {
  const scratch = path.join(project, ".migration-test-work", `active-profile-${randomUUID()}`);
  const root = path.join(scratch, "root"), id = randomUUID();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  provisionManagedWriterSession(root, id);
  const children = [];
  const worker = `
const fs = require("node:fs");
const [project, root, profile] = process.argv.slice(1);
const { withManagedWriterOperation } = require(project + "/dist/runtime/managed-writer-session");
const { activateManagedProfileWriter } = require(project + "/dist/runtime/managed-profile-activation");
const { createHash } = require("node:crypto");
let release;
const stopped = new Promise(resolve => { release = resolve; });
let finished;
const done = new Promise(resolve => { finished = resolve; });
const controller = activateManagedProfileWriter(root, process.env.PKM_MANAGED_WRITER_SESSION, async () => {
 fs.writeFileSync(root + "/" + profile + "-draining", "");
 release();
 await done;
}, 50, () => true, createHash("sha256").update(profile).digest("hex"));
withManagedWriterOperation(root, "github-sync", async () => {
 fs.writeFileSync(root + "/" + profile + "-ready", "");
 await stopped;
 await new Promise(resolve => setTimeout(resolve, profile === "b" ? 150 : 20));
 fs.writeFileSync(root + "/" + profile + "-finished", "");
}).then(() => { finished(); setTimeout(() => { controller.dispose(); }, 500); }, error => {
 console.error(error); process.exitCode = 1; finished();
});
`;
  try {
    for (const profile of ["a", "b"]) {
      const child = spawn(process.execPath, ["-e", worker, project, root, profile], {
        cwd: project, env: { ...process.env, HOME: project, TMPDIR: scratch, PKM_MANAGED_WRITER_SESSION: id },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += chunk; });
      const exit = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal, stderr })));
      children.push({ child, exit, stderr: () => stderr });
    }
    await waitFor(() => ["a", "b"].every(name => fs.existsSync(path.join(root, `${name}-ready`))));
    let localDrain = 0;
    const coordinator = activateManagedProfileWriter(root, id, async () => { localDrain++; }, 50, () => true, profileId("coordinator"));
    try {
      const discovered = coordinator.discover();
      assert.deepEqual(new Set(discovered.map(item => item.profileId)), new Set(["a", "b", "coordinator"].map(profileId)));
      assert(discovered.every(item => item.state === "registered-unverified"));
      let result;
      try { result = await coordinator.handoff(5000); }
      catch (error) {
        throw new Error(`${error.message}; profiles=${JSON.stringify(coordinator.discover())}; files=${JSON.stringify(fs.readdirSync(root))}; stderr=${JSON.stringify(children.map(item => item.stderr()))}`);
      }
      assert.equal(localDrain, 1);
      assert.deepEqual(result, { registeredWritersDrained: true, preexistingAndExternalWriters: "unknown", cutoverAuthorized: false });
      assert(["a", "b"].every(name => fs.existsSync(path.join(root, `${name}-finished`))));
      assert.equal(coordinator.status().state, "drained");
      assert(coordinator.discover().every(item => item.state === "drained"));
    } finally { coordinator.dispose(); }
    for (const { exit } of children) {
      const result = await exit;
      assert.equal(result.code, 0, result.stderr);
    }
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(({ exit }) => exit));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("a profile with changed binding does not fence another root", { skip: process.platform !== "linux" }, async () => {
  const scratch = path.join(project, ".migration-test-work", `profile-change-${randomUUID()}`);
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  provisionManagedWriterSession(scratch, id);
  let drains = 0;
  let current = true;
  const profile = activateManagedProfileWriter(scratch, id, async () => { drains++; }, 50, () => current);
  try {
    current = false;
    await assert.rejects(profile.handoff(100), /binding changed/);
    assert.equal(drains, 0);
    assert.equal(profile.status().state, "unknown");
    assert(!fs.existsSync(path.join(scratch, ".pkm/state/managed-writer-session/fenced")));
  } finally { profile.dispose(); fs.rmSync(scratch, { recursive: true, force: true }); }
});

test("a stopped profile does not block drain, while an unenrolled profile is not discovered", {
  skip: process.platform !== "linux", timeout: 20000,
}, async () => {
  const scratch = path.join(project, ".migration-test-work", `profile-crash-${randomUUID()}`);
  const root = path.join(scratch, "root"), id = randomUUID();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  provisionManagedWriterSession(root, id);
  const child = spawn(process.execPath, ["-e", `
    const [project, root, id, profile] = process.argv.slice(1);
    const { activateManagedProfileWriter } = require(project + "/dist/runtime/managed-profile-activation");
    activateManagedProfileWriter(root, id, async () => {}, 50, () => true, profile);
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1000);
  `, project, root, id, profileId("crashed")], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
  const exit = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  const coordinator = activateManagedProfileWriter(root, id, async () => {}, 50, () => true, profileId("survivor"));
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
      child.once("exit", () => reject(new Error("profile exited before registration")));
    });

    child.kill("SIGKILL");
    assert.equal((await exit).signal, "SIGKILL");
    assert.deepEqual(new Set(coordinator.discover().map(item => item.profileId)), new Set(["crashed", "survivor"].map(profileId)));
    await coordinator.handoff(1000);
    const found = coordinator.discover();
    assert.equal(found.find(item => item.profileId === profileId("crashed")).state, "stopped");
    assert.equal(found.find(item => item.profileId === profileId("survivor")).state, "drained");
    assert.equal(coordinator.status().cutoverAuthorized, false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit;
    coordinator.dispose();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("a stopped profile with an interrupted operation remains blocked", {
  skip: process.platform !== "linux", timeout: 15000,
}, async () => {
  const root = path.join(project, ".migration-test-work", `profile-stopped-pending-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  provisionManagedWriterSession(root, id);
  const child = spawn(process.execPath, ["-e", `
    const [project, root, id, profile] = process.argv.slice(1);
    const { activateManagedProfileWriter } = require(project + "/dist/runtime/managed-profile-activation");
    const { withManagedWriterOperation } = require(project + "/dist/runtime/managed-writer-session");
    activateManagedProfileWriter(root, id, async () => {}, 50, () => true, profile);
    withManagedWriterOperation(root, "github-sync", async () => {
      process.stdout.write("ready\\n");
      await new Promise(() => {});
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `, project, root, id, profileId("killed-work")], {
    cwd: project, env: { ...process.env, PKM_MANAGED_WRITER_SESSION: id }, stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  const coordinator = activateManagedProfileWriter(root, id, async () => {}, 50, () => true, profileId("survivor"));
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
      child.once("exit", () => reject(new Error("profile exited before operation")));
    });
    child.kill("SIGKILL");
    assert.equal((await exit).signal, "SIGKILL");
    await assert.rejects(coordinator.handoff(200), /active or has an unknown outcome/);
    assert.throws(() => rotateManagedWriterSession(root, id), /active or has an unknown outcome/);
    assert.equal(coordinator.discover().find(item => item.profileId === profileId("killed-work")).state, "stopped");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit;
    coordinator.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("profile disposal records completion only after its owned drain succeeds", {
  skip: process.platform !== "linux", timeout: 10000,
}, async () => {
  const root = path.join(project, ".migration-test-work", `profile-close-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  provisionManagedWriterSession(root, id);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const profile = activateManagedProfileWriter(root, id, () => gate, 50, () => true, profileId("closing"));
  try {
    profile.dispose();
    assert.equal(profile.discover()[0].state, "registered-unverified");
    release();
    await waitFor(() => profile.status().state === "drained");
    assert.equal(profile.discover()[0].state, "drained");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a drained session rotates without admitting stale hosts or claiming external writers", {
  skip: process.platform !== "linux", timeout: 10000,
}, async () => {
  const root = path.join(project, ".migration-test-work", `profile-rotate-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const old = randomUUID(), saved = process.env.PKM_MANAGED_WRITER_SESSION;
  process.env.PKM_MANAGED_WRITER_SESSION = old;
  provisionManagedWriterSession(root, old);
  const profile = activateManagedProfileWriter(root, old, async () => {}, 50, () => true, profileId("rotate"));
  try {
    assert.throws(() => profile.rotate(), /drained/);
    await profile.handoff(1000);
    const result = profile.rotate();
    assert.notEqual(result.sessionId, old);
    assert.equal(result.preexistingAndExternalWriters, "unknown");
    assert.equal(result.cutoverAuthorized, false);
    assert(fs.existsSync(path.join(root, `.pkm/state/managed-writer-session/operations.${old}`)));
    await assert.rejects(withManagedWriterOperation(root, "github-sync", async () => {}), /binding changed/);
    process.env.PKM_MANAGED_WRITER_SESSION = result.sessionId;
    assert.equal(managedWriterAdmissionState(root, result.sessionId), "accepting");
    assert.equal(await withManagedWriterOperation(root, "github-sync", async () => 42), 42);
    const restarted = spawnSync(process.execPath, ["-e", `
      const [project, root] = process.argv.slice(1);
      require(project + "/dist/runtime/managed-writer-session").withManagedWriterOperation(root, "github-sync", async () => 42)
        .then(value => { console.log(value); }, error => { console.error(error.message); process.exitCode = 1; });
    `, project, root], { cwd: project, env: { ...process.env, PKM_MANAGED_WRITER_SESSION: result.sessionId }, encoding: "utf8" });
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.equal(restarted.stdout.trim(), "42");
  } finally {
    profile.dispose();
    if (saved === undefined) delete process.env.PKM_MANAGED_WRITER_SESSION;
    else process.env.PKM_MANAGED_WRITER_SESSION = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an installed-update signal automatically drains, rotates and restarts only bound profiles", {
  skip: process.platform !== "linux", timeout: 20000,
}, async () => {
  const root = path.join(project, ".migration-test-work", `automatic-profile-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  provisionManagedWriterSession(root, id);
  const children = [];
  const worker = `
    const fs = require("node:fs");
    const [project, root, id, label, profileId] = process.argv.slice(1);
    const { activateManagedProfileWriter } = require(project + "/dist/runtime/managed-profile-activation");
    const controller = activateManagedProfileWriter(root, id, async () => {
      fs.writeFileSync(root + "/" + label + "-drained", "");
    }, 50, () => true, profileId, {
      updateAvailable: () => label === "a" && fs.existsSync(root + "/update"),
      restartReady: () => true, canRestart: () => true,
      restart: async () => { fs.writeFileSync(root + "/" + label + "-restart", ""); },
    });
    fs.writeFileSync(root + "/" + label + "-ready", "");
    const timer = setInterval(() => {
      if (fs.existsSync(root + "/exit")) { clearInterval(timer); controller.dispose(); }
    }, 25);
  `;
  try {
    for (const label of ["a", "b"]) {
      const child = spawn(process.execPath, ["-e", worker, project, root, id, label, profileId(label)], {
        cwd: project, env: { ...process.env, PKM_MANAGED_WRITER_SESSION: id }, stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += chunk; });
      const exit = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal, stderr })));
      children.push({ child, exit });
    }
    await waitFor(() => ["a", "b"].every(label => fs.existsSync(path.join(root, `${label}-ready`))));
    assert.equal(resolveManagedWriterSession(root, id), id);
    fs.writeFileSync(path.join(root, "update"), "");
    await waitFor(() => ["a", "b"].every(label => fs.existsSync(path.join(root, `${label}-restart`))), 10000);
    const next = resolveManagedWriterSession(root, id);
    assert.notEqual(next, id);
    assert(["a", "b"].every(label => fs.existsSync(path.join(root, `${label}-drained`))));
    assert.equal(managedWriterAdmissionState(root, next), "accepting");
    const restart = spawnSync(process.execPath, ["-e", `
      const [project, root] = process.argv.slice(1);
      const m = require(project + "/dist/runtime/managed-writer-session");
      process.env.PKM_MANAGED_WRITER_SESSION = m.resolveManagedWriterSession(root, process.env.PKM_MANAGED_WRITER_SESSION);
      m.withManagedWriterOperation(root, "github-sync", async () => 42)
        .then(value => console.log(value), error => { console.error(error); process.exitCode = 1; });
    `, project, root], { cwd: project, env: { ...process.env, PKM_MANAGED_WRITER_SESSION: id }, encoding: "utf8" });
    assert.equal(restart.status, 0, restart.stderr);
    assert.equal(restart.stdout.trim(), "42");
    fs.writeFileSync(path.join(root, "exit"), "");
    for (const { exit } of children) assert.equal((await exit).code, 0);
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(({ exit }) => exit));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an old live enrolled host without successor support prevents automatic fencing", {
  skip: process.platform !== "linux", timeout: 10000,
}, async () => {
  const root = path.join(project, ".migration-test-work", `profile-unsupported-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  provisionManagedWriterSession(root, id);
  const old = activateManagedProfileWriter(root, id, async () => {}, 50, () => true, profileId("old"));
  const current = activateManagedProfileWriter(root, id, async () => {}, 50, () => true, profileId("current"), {
    updateAvailable: () => true, restartReady: () => true, canRestart: () => true, restart: async () => {},
  });
  try {
    await waitFor(() => /cannot automatically restart/.test(current.status().detail || ""));
    assert.equal(managedWriterAdmissionState(root, id), "accepting");
  } finally {
    old.dispose(); current.dispose();
    await waitFor(() => old.status().state === "drained" && current.status().state === "drained");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a profile with ambiguous installed index can drain explicitly but cannot join automatic rotation", {
  skip: process.platform !== "linux", timeout: 10000,
}, async () => {
  const root = path.join(project, ".migration-test-work", `profile-ambiguous-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  provisionManagedWriterSession(root, id);
  const profile = activateManagedProfileWriter(root, id, async () => {}, 50, () => true, profileId("ambiguous"), {
    updateAvailable: () => true, restartReady: () => false, canRestart: () => true,
    restart: async () => { throw new Error("unexpected restart"); },
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(managedWriterAdmissionState(root, id), "accepting");
    const result = await profile.handoff(1000);
    assert.equal(result.cutoverAuthorized, false);
    assert.equal(profile.status().state, "drained");
  } finally { profile.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("an abandoned empty admission lock remains intact and blocks registration", {
  skip: process.platform !== "linux", timeout: 10000,
}, () => {
  const root = path.join(project, ".migration-test-work", `profile-empty-lock-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  provisionManagedWriterSession(root, id);
  const lock = path.join(root, ".pkm/state/managed-writer-session.lock");
  fs.mkdirSync(lock);
  try {
    assert.throws(() => activateManagedProfileWriter(root, id, async () => {}, 50, () => true, profileId("empty")), /empty lock ownership is unknown/);
    assert.deepEqual(fs.readdirSync(lock), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("legacy directory owners and new session file owners exclude one another", {
  skip: process.platform !== "linux", timeout: 15000,
}, async () => {
  const root = path.join(project, ".migration-test-work", `profile-lock-interop-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  provisionManagedWriterSession(root, id);
  const lock = path.join(root, ".pkm/state/managed-writer-session.lock");
  const start = script => {
    const child = spawn(process.execPath, ["-e", script, project, root, id, lock], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const exit = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal, stderr })));
    const ready = new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
      child.once("exit", () => reject(new Error("lock owner exited before ready")));
    });
    return { child, ready, exit };
  };
  const children = [];
  try {
    const legacy = start(`
      const [project, , , lock] = process.argv.slice(1);
      require(project + "/dist/runtime/cross-process-lock").withCrossProcessLockSync(lock, "old", () => {
        process.stdout.write("ready\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
      }, { timeoutMs: 2000, rejectAbandoned: true });
    `);
    children.push(legacy);
    await legacy.ready;
    const profile = activateManagedProfileWriter(root, id, async () => {}, 50, () => true, profileId("interop"));
    assert.equal((await legacy.exit).code, 0);
    profile.dispose();
    await waitFor(() => profile.status().state === "drained");
    const newer = start(`
      const fs = require("node:fs"), [project, root, id] = process.argv.slice(1);
      const original = fs.writeFileSync;
      fs.writeFileSync = function(fd, ...args) {
        const result = original.call(fs, fd, ...args);
        if (typeof fd === "number" && fs.readlinkSync("/proc/self/fd/" + fd).includes("/operations/")) {
          process.stdout.write("ready\\n");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
        }
        return result;
      };
      require(project + "/dist/runtime/managed-writer-session").registerManagedProfile(root, id, ${JSON.stringify(profileId("newer"))});
    `);
    children.push(newer);
    await newer.ready;
    assert.throws(() => withCrossProcessLockSync(lock, "old", () => {}, { timeoutMs: 100, rejectAbandoned: true }), /busy|incomplete/);
    const result = await newer.exit;
    assert.equal(result.code, 0, result.stderr);
    withCrossProcessLockSync(lock, "old", () => {}, { timeoutMs: 1000, rejectAbandoned: true });
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(({ exit }) => exit));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const stage of ["archive", "successor"]) test(`a rotation killed after ${stage} cannot reopen an incomplete session`, {
  skip: process.platform !== "linux", timeout: 15000,
}, async () => {
  const root = path.join(project, ".migration-test-work", `rotation-killed-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  provisionManagedWriterSession(root, id);
  const profile = activateManagedProfileWriter(root, id, async () => {}, 50, () => true, profileId("killed-rotation"));
  await profile.handoff(1000);
  profile.dispose();
  const child = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    const [project, root, id, stage] = process.argv.slice(1);
    const rename = fs.renameSync;
    fs.renameSync = function(from, to) {
      rename.call(fs, from, to);
      if (stage === "archive" && String(from).endsWith("/managed-writer-session/operations")
          || stage === "successor" && String(to).endsWith("/managed-writer-session/session.json")) {
        process.stdout.write("archive-renamed\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);
      }
    };
    require(project + "/dist/runtime/managed-writer-session").rotateManagedWriterSession(root, id);
  `, project, root, id, stage], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
  const exit = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
      child.once("exit", () => reject(new Error("rotation exited before interruption")));
    });
    child.kill("SIGKILL");
    assert.equal((await exit).signal, "SIGKILL");
    assert(fs.existsSync(path.join(root, `.pkm/state/managed-writer-session/operations.${id}`)));
    assert(fs.existsSync(path.join(root, `.pkm/state/managed-writer-session/rotation.${id}.json`)));
    assert.throws(() => managedWriterAdmissionState(root, id));
    const journal = JSON.parse(fs.readFileSync(path.join(root, `.pkm/state/managed-writer-session/rotation.${id}.json`)));
    assert.throws(() => managedWriterAdmissionState(root, journal.nextSessionId));
    const saved = process.env.PKM_MANAGED_WRITER_SESSION;
    delete process.env.PKM_MANAGED_WRITER_SESSION;
    try { await assert.rejects(withManagedWriterOperation(root, "github-sync", async () => {}), /not enrolled/); }
    finally { if (saved !== undefined) process.env.PKM_MANAGED_WRITER_SESSION = saved; }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
