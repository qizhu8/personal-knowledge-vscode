import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, cp, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const tests = dirname(fileURLToPath(import.meta.url));
const project = resolve(tests, "../legacy");
const require = createRequire(import.meta.url);
const dist = resolve(process.env.PKM_TEST_DIST || join(project, "dist"));
const nextDist = resolve(process.env.PKM_TEST_NEXT_DIST || join(tests, "../dist"));
const { acquireLinuxRootWriterFence, markLinuxRootNextOwned } =
  await import(pathToFileURL(join(nextDist, "linux-root-writer-fence.js")).href);
const { withManagedWriterOperation, provisionManagedWriterSession, closeManagedWriterAdmission, waitForManagedWriterDrain } = require(join(dist, "runtime/managed-writer-session.js"));
const { withLegacyLinuxRootWriter, withLegacyLinuxRootWriterAsync, legacyLinuxRootWriterChild } = require(join(dist, "runtime/linux-root-writer-fence.js"));
const { syncGitHubTarget, applyGitHubRemoteAuthority } = require(join(dist, "sync/github-sync.js"));
const { managedMcpLauncher } = require(join(dist, "mcp/mcp-lifecycle.js"));

async function waitForFile(file, timeout = 10000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { return await readFile(file, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

test("two profile launchers enroll before serving, fence new starts, and report only verified drains", {
  skip: process.platform !== "linux", timeout: 30000,
}, async () => {
  const scratch = join(tests, `.managed-profile-fleet-${randomUUID()}`);
  let root = join(scratch, "knowledge"), id = randomUUID();
  await mkdir(root, { recursive: true, mode: 0o700 });
  provisionManagedWriterSession(root, id);
  let env = { ...process.env, HOME: project, TMPDIR: scratch, PYTHONDONTWRITEBYTECODE: "1",
    PKM_MANAGED_WRITER_SESSION: id };
  const children = [];
  async function launcher(profile) {
    const managed = join(scratch, profile), generation = randomUUID();
    const directory = join(managed, "generations", generation), runtime = join(directory, "runtime", "dist", "runtime");
    await mkdir(runtime, { recursive: true });
    await cp(join(dist, "runtime"), runtime, { recursive: true });
    await mkdir(join(runtime, "../servers"));
    await copyFile(join(dist, "servers/pyenvs.js"), join(runtime, "../servers/pyenvs.js"));
    await copyFile(join(project, "package.json"), join(directory, "runtime", "package.json"));
    await copyFile(join(project, "resources", "root_writer_fence.py"), join(directory, "root_writer_fence.py"));
    await writeFile(join(directory, "server.py"), `
import os, pathlib, sys
root = pathlib.Path(${JSON.stringify(root)})
profile = ${JSON.stringify(profile)}
class Lifecycle:
 def status(self):
  return {"phase": "accepting" if os.environ.get("TEST_UNDRAINED") else "drained",
          "acceptingNewCalls": bool(os.environ.get("TEST_UNDRAINED")), "inFlight": 0, "uncertainCalls": 0}
_MCP_LIFECYCLE = Lifecycle()
(root / (profile + "-ready")).write_text("ready")
sys.stdin.read()
(root / (profile + "-finished")).write_text("finished")
`);
    const files = {};
    for (const name of ["server.py", "root_writer_fence.py", "runtime/package.json", "runtime/dist/servers/pyenvs.js"]) {
      files[name] = createHash("sha256").update(await readFile(join(directory, name))).digest("hex");
    }
    for (const name of await readdir(runtime)) {
      files[`runtime/dist/runtime/${name}`] = createHash("sha256").update(await readFile(join(runtime, name))).digest("hex");
    }
    const manifest = { schema: "pkm.mcp.lifecycle/v1", generation, managedRoot: managed, version: "1.0.0",
      components: { knowledge: "1.0.0", chat: "1.0.0", recipes: "1.0.0", agent_sessions: "1.0.0" }, files };
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(managed, "active-generation.json"), JSON.stringify({ schema: manifest.schema, generation }));
    const file = join(managed, "server.py");
    await writeFile(file, managedMcpLauncher(manifest, root));
    return file;
  }
  function start(file, childEnv = env) {
    const child = spawn("python3", [file], { env: childEnv, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", data => { stderr += data; });
    const exited = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal, stderr })));
    children.push({ child, exited });
    return { child, exited };
  }
  try {
    const aFile = await launcher("profile-a"), bFile = await launcher("profile-b");
    const unboundEnv = { ...env }; delete unboundEnv.PKM_MANAGED_WRITER_SESSION;
    const a = start(aFile, unboundEnv), b = start(bFile, unboundEnv);
    await Promise.all([[a, "profile-a"], [b, "profile-b"]].map(([handle, profile]) =>
      Promise.race([waitForFile(join(root, `${profile}-ready`)), handle.exited.then(result => {
        throw new Error(`${profile} exited before readiness: ${JSON.stringify(result)}`);
      })])));
    closeManagedWriterAdmission(root, id);
    const restart = start(aFile);
    assert.notEqual((await restart.exited).code, 0);
    const unbound = start(bFile, unboundEnv);
    assert.notEqual((await unbound.exited).code, 0);
    a.child.stdin.end();
    assert.equal((await a.exited).code, 0);
    await assert.rejects(waitForManagedWriterDrain(root, id, 100), /active or has an unknown outcome/);
    b.child.stdin.end();
    const bResult = await b.exited;
    assert.equal(bResult.code, 0, bResult.stderr);
    assert.equal(await readFile(join(root, "profile-b-finished"), "utf8"), "finished");
    assert.deepEqual(await waitForManagedWriterDrain(root, id, 1000), {
      registeredWritersDrained: true, preexistingAndExternalWriters: "unknown", cutoverAuthorized: false,
    });

    root = join(scratch, "failure-knowledge"); id = randomUUID();
    await mkdir(root, { mode: 0o700 });
    provisionManagedWriterSession(root, id);
    env = { ...env, PKM_MANAGED_WRITER_SESSION: id };
    const crashed = start(await launcher("profile-c"), unboundEnv);
    const undrained = start(await launcher("profile-d"), { ...unboundEnv, TEST_UNDRAINED: "1" });
    await Promise.all([waitForFile(join(root, "profile-c-ready")), waitForFile(join(root, "profile-d-ready"))]);
    closeManagedWriterAdmission(root, id);
    undrained.child.stdin.end();
    const failure = await undrained.exited;
    assert.notEqual(failure.code, 0);
    assert.match(failure.stderr, /not a verified drain/);
    crashed.child.kill("SIGKILL");
    assert.equal((await crashed.exited).signal, "SIGKILL");
    await assert.rejects(waitForManagedWriterDrain(root, id, 100), /active or has an unknown outcome/);
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(({ exited }) => exited));
    await rm(scratch, { recursive: true, force: true });
  }
});

test("new managed launcher holds the root fence until EOF and refuses restart after Next ownership", {
  skip: process.platform !== "linux", timeout: 15000,
}, async () => {
  const scratch = join(tests, `.managed-launcher-fence-${randomUUID()}`);
  const root = join(scratch, "knowledge"), managed = join(root, "mcp-server"), generation = randomUUID();
  const directory = join(managed, "generations", generation), ready = join(root, "server-ready");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const env = { ...process.env, HOME: project, TMPDIR: scratch, PYTHONDONTWRITEBYTECODE: "1" };
  await copyFile(join(project, "resources", "root_writer_fence.py"), join(directory, "root_writer_fence.py"));
  await writeFile(join(directory, "server.py"),
    `import pathlib, sys\npathlib.Path(${JSON.stringify(ready)}).write_text("ready")\nsys.stdin.read()\n`);
  const digest = async file => createHash("sha256").update(await readFile(file)).digest("hex");
  const manifest = {
    schema: "pkm.mcp.lifecycle/v1", generation, managedRoot: managed, version: "1.0.0",
    components: { knowledge: "1.0.0", chat: "1.0.0", recipes: "1.0.0", agent_sessions: "1.0.0" },
    files: {
      "server.py": await digest(join(directory, "server.py")),
      "root_writer_fence.py": await digest(join(directory, "root_writer_fence.py")),
    },
  };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(managed, "active-generation.json"), JSON.stringify({ schema: manifest.schema, generation }));
  const launcher = join(managed, "server.py");
  await writeFile(launcher, managedMcpLauncher(manifest, root));
  const child = spawn("python3", [launcher], { env, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  const exited = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  try {
    assert.equal(await waitForFile(ready), "ready");
    await assert.rejects(acquireLinuxRootWriterFence(root, 150), /Timed out|acquire.*fence/i);
    child.stdin.end();
    assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
    await rename(ready, `${ready}.first`);
    const next = await acquireLinuxRootWriterFence(root);
    try { await markLinuxRootNextOwned(root, next); }
    finally { await next.release(); }
    const restart = spawnSync("python3", [launcher], { env, encoding: "utf8", timeout: 5000 });
    assert.notEqual(restart.status, 0);
    assert.match(restart.stderr, /handed to next-server/);
    await assert.rejects(readFile(ready), { code: "ENOENT" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
    await rm(scratch, { recursive: true, force: true });
  }
});

test("session provisioning and admission cannot mutate a Next-owned root", {
  skip: process.platform !== "linux", timeout: 10000,
}, async () => {
  const scratch = join(tests, `.managed-session-next-${randomUUID()}`);
  const root = join(scratch, "knowledge"), id = randomUUID();
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    provisionManagedWriterSession(root, id);
    const next = await acquireLinuxRootWriterFence(root);
    try { await markLinuxRootNextOwned(root, next); }
    finally { await next.release(); }
    assert.throws(() => closeManagedWriterAdmission(root, id), /handed to next-server/);
    await assert.rejects(readFile(join(root, ".pkm/state/managed-writer-session/fenced")), { code: "ENOENT" });
    const second = join(scratch, "second");
    await mkdir(second, { mode: 0o700 });
    const secondFence = await acquireLinuxRootWriterFence(second);
    try { await markLinuxRootNextOwned(second, secondFence); }
    finally { await secondFence.release(); }
    assert.throws(() => provisionManagedWriterSession(second, randomUUID()), /handed to next-server/);
    await assert.rejects(readFile(join(second, ".pkm/state/managed-writer-session/session.json")), { code: "ENOENT" });
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("a real Git child retains its fence if the Sync owner is killed", {
  skip: process.platform !== "linux", timeout: 20000,
}, async () => {
  const scratch = join(tests, `.managed-git-fence-${randomUUID()}`);
  const root = join(scratch, "knowledge"), repo = join(root, "repo");
  await mkdir(repo, { recursive: true, mode: 0o700 });
  const env = { ...process.env, HOME: project, TMPDIR: scratch, GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args) => {
    const result = spawnSync("git", ["-C", repo, ...args], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "--quiet");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(repo, "file"), "synthetic");
  git("add", "file");
  const ready = join(root, "hook-ready"), release = join(root, "hook-release"), pidFile = join(root, "git-pid");
  const hook = join(repo, ".git", "hooks", "pre-commit");
  await writeFile(hook, `#!/bin/sh\nprintf ready > '${ready}'\nwhile [ ! -f '${release}' ]; do sleep 0.05; done\n`);
  await chmod(hook, 0o700);
  const owner = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const [module, root, repo, pidFile] = process.argv.slice(1);
    const { withLegacyLinuxRootWriterAsync, legacyLinuxRootWriterChild } = require(module);
    withLegacyLinuxRootWriterAsync(root, async () => {
      const spec = legacyLinuxRootWriterChild("git", ["-C", repo, "commit", "-m", "fixture"]);
      const child = spawn(spec.command, spec.args, { stdio: "ignore" });
      fs.writeFileSync(pidFile, String(child.pid));
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `, resolve(project, "dist/runtime/linux-root-writer-fence.js"), root, repo, pidFile],
  { cwd: project, env, stdio: "ignore" });
  const ownerExit = new Promise(resolve => owner.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    await waitForFile(ready);
    const childPid = Number(await waitForFile(pidFile));
    assert(Number.isInteger(childPid) && childPid > 1);
    owner.kill("SIGKILL");
    assert.deepEqual(await ownerExit, { code: null, signal: "SIGKILL" });
    await assert.rejects(acquireLinuxRootWriterFence(root, 150), /Timed out|acquire.*fence/i);
    await writeFile(release, "continue");
    const next = await acquireLinuxRootWriterFence(root, 5000);
    try { assert.equal(spawnSync("git", ["-C", repo, "rev-parse", "--verify", "HEAD"], { env }).status, 0); }
    finally { await next.release(); }
  } finally {
    await writeFile(release, "continue").catch(() => {});
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    await ownerExit;
    await rm(scratch, { recursive: true, force: true });
  }
});

for (const crashSupervisor of [false, true]) test(`detached Git hook after owner death: supervisor ${crashSupervisor ? "crashes" : "drains"}`, {
  skip: process.platform !== "linux", timeout: 20000,
}, async () => {
  const scratch = join(tests, `.managed-git-detached-${randomUUID()}`);
  const root = join(scratch, "knowledge"), repo = join(root, "repo");
  await mkdir(repo, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  provisionManagedWriterSession(root, id);
  const env = { ...process.env, HOME: project, TMPDIR: scratch, GIT_CONFIG_GLOBAL: "/dev/null", PKM_MANAGED_WRITER_SESSION: id };
  const git = (...args) => {
    const result = spawnSync("git", ["-C", repo, ...args], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "--quiet");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(repo, "file"), "synthetic");
  git("add", "file");
  const ready = join(root, "hook-ready"), release = join(root, "hook-release"), finished = join(root, "hook-finished");
  const hook = join(repo, ".git", "hooks", "pre-commit");
  const hookSource = `import os,time,pathlib
os.setsid()
for fd in range(3,256):
 try: os.close(fd)
 except OSError: pass
pathlib.Path(${JSON.stringify(join(root, "hook-pid"))}).write_text(str(os.getpid()))
pathlib.Path(${JSON.stringify(ready)}).write_text("ready")
while not pathlib.Path(${JSON.stringify(release)}).exists(): time.sleep(0.02)
pathlib.Path(${JSON.stringify(finished)}).write_text("finished")
`;
  await writeFile(join(root, "hook.py"), hookSource);
  await writeFile(hook, `#!/bin/sh\npython3 '${join(root, "hook.py")}' </dev/null >/dev/null 2>&1 &\nexit 0\n`);
  await chmod(hook, 0o700);
  const owner = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    const [sessionModule, supervisorModule, root, repo] = process.argv.slice(1);
    const { withManagedWriterOperation } = require(sessionModule);
    const { supervisedLegacyGit } = require(supervisorModule);
    withManagedWriterOperation(root, "github-sync", async () => {
      const task = supervisedLegacyGit(["-C", repo, "commit", "-m", "fixture"],
        { cwd: root, env: process.env, timeout: 10000, maxBuffer: 1024 * 1024 });
      if (!task) throw Error("Linux subreaper was unavailable in the test");
      await task;
    }).then(() => {
      fs.writeFileSync(root + "/git-returned", "returned");
      setInterval(() => {}, 1000);
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `, resolve(project, "dist/runtime/managed-writer-session.js"),
  resolve(project, "dist/runtime/linux-git-supervisor.js"), root, repo],
  { cwd: project, env, stdio: "ignore" });
  const ownerExit = new Promise(resolve => owner.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    assert.equal(await waitForFile(ready), "ready");
    assert.equal(await waitForFile(join(root, "git-returned")), "returned",
      "the ordinary Git result must not wait for a detached hook");
    owner.kill("SIGKILL");
    assert.deepEqual(await ownerExit, { code: null, signal: "SIGKILL" });
    closeManagedWriterAdmission(root, id);
    await assert.rejects(waitForManagedWriterDrain(root, id, 100), /active or has an unknown outcome/);
    if (crashSupervisor) {
      const hookPid = Number(await readFile(join(root, "hook-pid"), "utf8"));
      const stat = await readFile(`/proc/${hookPid}/stat`, "utf8");
      const supervisorPid = Number(/\) [A-Z] (\d+)/.exec(stat)?.[1]);
      assert(supervisorPid > 1);
      const command = await readFile(`/proc/${supervisorPid}/cmdline`, "utf8");
      assert.match(command, /waitpid\(-1, 0\)/);
      process.kill(supervisorPid, "SIGKILL");
      const next = await acquireLinuxRootWriterFence(root, 5000);
      await next.release();
      await assert.rejects(readFile(finished), { code: "ENOENT" });
    } else {
      await assert.rejects(acquireLinuxRootWriterFence(root, 150), /Timed out|acquire.*fence/i);
    }
    await writeFile(release, "continue");
    assert.equal(await waitForFile(finished), "finished");
    const next = await acquireLinuxRootWriterFence(root, 5000);
    await next.release();
    if (crashSupervisor) {
      await assert.rejects(waitForManagedWriterDrain(root, id, 100), /active or has an unknown outcome/);
    } else {
      assert.equal((await waitForManagedWriterDrain(root, id, 1000)).cutoverAuthorized, false);
    }
  } finally {
    await writeFile(release, "continue").catch(() => {});
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    await ownerExit;
    try {
      const cleanupFence = await acquireLinuxRootWriterFence(root, 5000);
      await cleanupFence.release();
    } catch {
      try { process.kill(Number(await readFile(join(root, "hook-pid"), "utf8")), "SIGTERM"); } catch {}
    }
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a delayed Git child refuses to start after ownership changes", {
  skip: process.platform !== "linux", timeout: 10000,
}, async () => {
  const scratch = join(tests, `.managed-git-late-${randomUUID()}`);
  const root = join(scratch, "knowledge");
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    const spec = await withLegacyLinuxRootWriterAsync(root, async () =>
      legacyLinuxRootWriterChild("git", ["init", join(root, "late-repo")]));
    const next = await acquireLinuxRootWriterFence(root);
    try { await markLinuxRootNextOwned(root, next); }
    finally { await next.release(); }
    const result = spawnSync(spec.command, spec.args, { encoding: "utf8" });
    assert.equal(result.status, 75);
    assert.match(result.stderr, /handed to next-server/);
    await assert.rejects(readFile(join(root, "late-repo", ".git", "HEAD")), { code: "ENOENT" });
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("a Sync child can acquire a shared fence while Next is waiting", {
  skip: process.platform !== "linux", timeout: 10000,
}, async () => {
  const scratch = join(tests, `.managed-git-waiter-${randomUUID()}`);
  const root = join(scratch, "knowledge");
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await withLegacyLinuxRootWriterAsync(root, async () => {
      const exclusive = acquireLinuxRootWriterFence(root, 1200);
      const blocked = assert.rejects(exclusive, /Timed out|acquire.*fence/i);
      await new Promise(resolve => setTimeout(resolve, 100));
      const spec = legacyLinuxRootWriterChild("git", ["--version"]);
      const result = await new Promise((resolve, reject) => {
        const child = spawn(spec.command, spec.args, { stdio: "ignore" });
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Sync child blocked behind the exclusive waiter.")); }, 700);
        child.once("error", reject);
        child.once("exit", code => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(result, 0);
      await blocked;
    });
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("managed async Sync holds one shared fence through nested and detached work", {
  skip: process.platform !== "linux", timeout: 15000,
}, async () => {
  const scratch = join(tests, `.managed-sync-fence-${randomUUID()}`);
  const root = join(scratch, "knowledge");
  await mkdir(root, { recursive: true, mode: 0o700 });
  let release;
  let child;
  try {
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    await withManagedWriterOperation(root, "github-sync", async () => {
      assert.equal(withLegacyLinuxRootWriter(root, () => 42), 42);
      child = withManagedWriterOperation(root, "github-sync", async () => {
        started();
        await pending;
      });
      await entered;
    });
    await assert.rejects(acquireLinuxRootWriterFence(root, 150), /Timed out|acquire.*fence/i);
    release();
    await child;
    const next = await acquireLinuxRootWriterFence(root, 1500);
    try { await markLinuxRootNextOwned(root, next); }
    finally { await next.release(); }
    await assert.rejects(withManagedWriterOperation(root, "github-sync", async () => {}), /handed to next-server/);
    await assert.rejects(syncGitHubTarget({}, {}, root, undefined, root), /handed to next-server/);
    await assert.rejects(applyGitHubRemoteAuthority({}, {}, scratch, root, {}, "actor", "reason", () => {}), /handed to next-server/);
  } finally {
    release?.();
    await child?.catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
});

test("unregistered PKM Sync service holds its fence until a real drain completes", {
  skip: process.platform !== "linux", timeout: 30000,
}, async () => {
  const scratch = join(tests, `.managed-service-fence-${randomUUID()}`);
  const root = join(scratch, "knowledge"), storage = join(scratch, "storage");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(storage, { mode: 0o700 });
  await mkdir(join(scratch, "home"), { mode: 0o700 });
  const home = await open(join(scratch, "home"), "r");
  const env = { ...process.env, HOME: `/proc/${process.pid}/fd/${home.fd}`, TMPDIR: scratch };
  delete env.PKM_MANAGED_WRITER_SESSION;
  const child = spawn(process.execPath, ["-e", `
    const [modulePath, root, storage] = process.argv.slice(1);
    const { startPkmService, PkmServiceClient } = require(modulePath);
    const options = { knowledgeRoot: root, globalStoragePath: storage, extensionVersion: "4.0.22", execute: async () => {} };
    (async () => {
      const service = await startPkmService(options);
      const client = await PkmServiceClient.connect(options);
      process.stdout.write("ready\\n");
      await new Promise(resolve => process.stdin.once("data", resolve));
      await client.drain();
      await service.stopped;
      client.dispose();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, resolve(project, "dist/runtime/pkm-service.js"), root, storage], { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  const exited = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error(`Service did not become ready: ${stderr}`)), 10_000);
      child.stdout.once("data", () => { clearTimeout(timer); resolveReady(); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`Service exited before readiness: ${stderr}`)); });
    });
    await assert.rejects(acquireLinuxRootWriterFence(root, 150), /Timed out|acquire.*fence/i);
    child.stdin.end("drain");
    assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
    const next = await acquireLinuxRootWriterFence(root, 1500);
    await next.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
    await home.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("original 4.0.22 Sync service does not hold the current Next writer fence", {
  skip: process.platform !== "linux" || !process.env.PKM_ORIGINAL_VSIX, timeout: 30000,
}, async () => {
  const scratch = join(tests, `.original-service-fence-${randomUUID()}`);
  const root = join(scratch, "knowledge"), storage = join(scratch, "storage");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(storage, { mode: 0o700 });
  const archive = resolve(process.env.PKM_ORIGINAL_VSIX);
  assert.equal(createHash("sha256").update(await readFile(archive)).digest("hex"),
    "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
  const unpack = spawnSync("unzip", ["-q", archive, "extension/dist/*", "-d", scratch], { encoding: "utf8" });
  assert.equal(unpack.status, 0, unpack.stderr);
  await writeFile(join(scratch, "extension/package.json"), '{"type":"commonjs"}');
  await mkdir(join(scratch, "home"), { mode: 0o700 });
  const home = await open(join(scratch, "home"), "r");
  const env = { ...process.env, HOME: `/proc/${process.pid}/fd/${home.fd}`, TMPDIR: scratch };
  delete env.PKM_MANAGED_WRITER_SESSION;
  const child = spawn(process.execPath, ["-e", `
    const [modulePath, root, storage] = process.argv.slice(1);
    const { startPkmService, PkmServiceClient } = require(modulePath);
    const options = { knowledgeRoot: root, globalStoragePath: storage, extensionVersion: "4.0.22", execute: async () => {} };
    (async () => {
      const service = await startPkmService(options);
      const client = await PkmServiceClient.connect(options);
      process.stdout.write("ready\\n");
      await new Promise(resolve => process.stdin.once("data", resolve));
      await client.drain();
      await service.stopped;
      client.dispose();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, join(scratch, "extension/dist/runtime/pkm-service.js"), root, storage], { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  const exited = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error(`Original service did not become ready: ${stderr}`)), 10_000);
      child.stdout.once("data", () => { clearTimeout(timer); resolveReady(); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`Original service exited before readiness: ${stderr}`)); });
    });
    const next = await acquireLinuxRootWriterFence(root, 1500);
    await next.release();
    child.stdin.end("drain");
    assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
    await home.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("the shared root-directory lock excludes the Next writer fence", {
  skip: process.platform !== "linux", timeout: 10000,
}, async () => {
  const scratch = join(tests, `.root-lock-split-${randomUUID()}`);
  const root = join(scratch, "knowledge");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const child = spawn("flock", ["-s", root, process.execPath, "-e",
    "process.stdout.write('ready\\n'); process.stdin.resume()"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  const exited = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolveReady, reject) => {
      child.stdout.once("data", resolveReady);
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`Root lock exited before readiness: ${stderr}`)));
    });
    await assert.rejects(acquireLinuxRootWriterFence(root, 150), /Timed out|acquire.*fence/i);
    child.stdin.end();
    assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
    const next = await acquireLinuxRootWriterFence(root, 1500);
    await next.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
    await rm(scratch, { recursive: true, force: true });
  }
});
