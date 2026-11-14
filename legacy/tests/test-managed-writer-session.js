const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");

const project = path.resolve(__dirname, "..");
const scratch = path.join(project, ".migration-test-work", `managed-writer-${randomUUID()}`);
const compiled = path.join(scratch, "dist");
const listen = child => new Promise((resolve, reject) => {
  child.stdout.once("data", resolve);
  child.once("error", reject);
  child.once("exit", code => reject(new Error(`child exited before ready: ${code}`)));
});
const exited = child => new Promise((resolve, reject) => {
  let stderr = "";
  child.stderr.on("data", value => { stderr += value; });
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
});
const script = `
const fs = require('fs');
const [compiled, root, release] = process.argv.slice(1);
const { withManagedWriterOperation } = require(compiled + '/runtime/managed-writer-session');
withManagedWriterOperation(root, 'github-sync', async () => {
  fs.writeFileSync(root + '/started', 'started');
  process.stdout.write('admitted\\n');
  while (!fs.existsSync(release)) await new Promise(resolve => setTimeout(resolve, 10));
  fs.writeFileSync(root + '/finished', 'finished');
}).catch(error => { console.error(error.message); process.exitCode = 1; });
`;
function worker(root, id, release) {
  return spawn(process.execPath, ["-e", script, compiled, root, release], {
    cwd: project, env: { ...process.env, PKM_MANAGED_WRITER_SESSION: id }, stdio: ["ignore", "pipe", "pipe"],
  });
}

test("registered async writer is fenced before drain, survives restarts and retains unknown crashes",
  { timeout: 120000, skip: process.platform !== "linux" }, async t => {
  fs.mkdirSync(compiled, { recursive: true });
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", project, "--outDir", compiled, "--sourceMap", "false"], { cwd: project });
  fs.copyFileSync(path.join(project, "package.json"), path.join(scratch, "package.json"));
  const { provisionManagedWriterSession, fenceManagedWriterSession, withManagedWriterOperation,
    orchestrateManagedWriterHandoff } = require(path.join(compiled, "runtime/managed-writer-session"));
  const { acquireLinuxRootWriterFence } = require(path.join(compiled, "runtime/linux-root-writer-fence"));
  const fixture = name => { const root = path.join(scratch, name); fs.mkdirSync(root); return root; };
  const defaultRoot = fixture("default");
  assert.equal(await withManagedWriterOperation(defaultRoot, "github-sync", async () => 42), 42);
  assert.equal(fs.existsSync(path.join(defaultRoot, ".pkm")), false);
  const root = fixture("active"), id = randomUUID();
  provisionManagedWriterSession(root, id);
  assert.throws(() => provisionManagedWriterSession(root, randomUUID()), /EEXIST/);
  const one = worker(root, id, path.join(root, "release"));
  const oneExit = exited(one);
  await listen(one);
  assert.throws(() => fenceManagedWriterSession(root, id), /active or has an unknown outcome/);
  const blocked = worker(root, id, path.join(root, "release"));
  assert.match((await exited(blocked)).stderr, /fenced/);
  await assert.rejects(withManagedWriterOperation(root, "github-sync", async () => {}), /not enrolled/);
  fs.writeFileSync(path.join(root, "release"), "go");
  assert.equal((await oneExit).code, 0);
  fenceManagedWriterSession(root, id);
  fenceManagedWriterSession(root, id);
  assert.throws(() => fenceManagedWriterSession(root, randomUUID()), /binding changed/);
  assert.equal(fs.readFileSync(path.join(root, "finished"), "utf8"), "finished");
  const coordinatedRoot = fixture("coordinated"), coordinatedId = randomUUID();
  provisionManagedWriterSession(coordinatedRoot, coordinatedId);
  const coordinated = worker(coordinatedRoot, coordinatedId, path.join(coordinatedRoot, "release"));
  const coordinatedExit = exited(coordinated);
  await listen(coordinated);
  await assert.rejects(orchestrateManagedWriterHandoff(coordinatedRoot, coordinatedId,
    [{ drain: async () => {} }], 100), /active or has an unknown outcome/);
  await assert.rejects(orchestrateManagedWriterHandoff(coordinatedRoot, coordinatedId,
    [{ drain: async () => { throw Error("offline"); } }], 100), /drain failed/);
  await assert.rejects(orchestrateManagedWriterHandoff(coordinatedRoot, coordinatedId,
    [{ drain: () => new Promise(() => {}) }], 100), /drain timed out/);
  fs.writeFileSync(path.join(coordinatedRoot, "release"), "go");
  assert.equal((await coordinatedExit).code, 0);
  assert.equal((await orchestrateManagedWriterHandoff(coordinatedRoot, coordinatedId, [], 1000)).cutoverAuthorized, false);
  const restart = worker(root, id, path.join(root, "release"));
  assert.match((await exited(restart)).stderr, /fenced/);
  const actualSync = spawn(process.execPath, ["-e", `
    const [compiled, root] = process.argv.slice(1);
    require(compiled + '/sync/github-sync').syncGitHubTarget({}, {}, root, undefined, root)
      .then(() => process.exitCode = 2, error => { console.error(error.message); process.exitCode = 1; });
  `, compiled, root], { env: { ...process.env, PKM_MANAGED_WRITER_SESSION: id }, stdio: ["ignore", "pipe", "pipe"] });
  assert.match((await exited(actualSync)).stderr, /fenced/);
  const serviceStorage = path.join(scratch, "service-storage");
  fs.mkdirSync(serviceStorage);
  const actualService = spawn(process.execPath, ["-e", `
    const [compiled, root, storage] = process.argv.slice(1);
    require(compiled + '/runtime/pkm-service').startPkmService({ knowledgeRoot: root, globalStoragePath: storage, extensionVersion: '1.0.0' })
      .then(() => process.exitCode = 2, error => { console.error(error.message); process.exitCode = 1; });
  `, compiled, root, serviceStorage], { env: { ...process.env, PKM_MANAGED_WRITER_SESSION: id }, stdio: ["ignore", "pipe", "pipe"] });
  assert.match((await exited(actualService)).stderr, /fenced/);

  const serviceRoot = fixture("service-running"), serviceId = randomUUID();
  const liveStorage = path.join(scratch, "live-service-storage");
  fs.mkdirSync(liveStorage);
  provisionManagedWriterSession(serviceRoot, serviceId);
  const ipcParent = path.join(project, ".pkm-ipc");
  const ipcParentExisted = fs.existsSync(ipcParent);
  t.after(() => { if (!ipcParentExisted) { try { fs.rmdirSync(ipcParent); } catch {} } });
  const liveService = spawn(process.execPath, ["-e", `
    const [compiled, root, storage] = process.argv.slice(1);
    const { startPkmService, PkmServiceClient } = require(compiled + '/runtime/pkm-service');
    const options = { knowledgeRoot: root, globalStoragePath: storage, extensionVersion: '1.0.0', execute: async () => {} };
    (async () => {
      const service = await startPkmService(options);
      const client = await PkmServiceClient.connect(options);
      process.stdout.write('service ready\\n');
      await new Promise(resolve => process.stdin.once('data', resolve));
      await client.drain();
      await service.stopped;
      client.dispose();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, compiled, serviceRoot, liveStorage], {
    env: { ...process.env, HOME: `/proc/${process.pid}/cwd`, PKM_MANAGED_WRITER_SESSION: serviceId }, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (liveService.exitCode === null && liveService.signalCode === null) liveService.kill("SIGTERM"); });
  const liveServiceExit = exited(liveService);
  await listen(liveService);
  assert.throws(() => acquireLinuxRootWriterFence(serviceRoot, "exclusive", 100), /fence|flock/i);
  assert.throws(() => fenceManagedWriterSession(serviceRoot, serviceId), /active or has an unknown outcome/);
  liveService.stdin.end("drain");
  const liveResult = await liveServiceExit;
  assert.equal(liveResult.code, 0, liveResult.stderr);
  const successor = acquireLinuxRootWriterFence(serviceRoot, "exclusive", 1000);
  successor.release();
  assert.equal(fenceManagedWriterSession(serviceRoot, serviceId).cutoverAuthorized, false);

  const crashedRoot = fixture("crashed"), crashedId = randomUUID();
  provisionManagedWriterSession(crashedRoot, crashedId);
  const crashed = worker(crashedRoot, crashedId, path.join(crashedRoot, "release"));
  const crashExit = exited(crashed);
  await listen(crashed);
  crashed.kill("SIGKILL");
  assert.equal((await crashExit).signal, "SIGKILL");
  assert.throws(() => fenceManagedWriterSession(crashedRoot, crashedId), /active or has an unknown outcome/);
  assert.throws(() => fenceManagedWriterSession(crashedRoot, crashedId), /active or has an unknown outcome/);

  const oldRoot = fixture("unregistered");
  const legacy = worker(oldRoot, randomUUID(), path.join(oldRoot, "release"));
  const legacyExit = exited(legacy);
  assert.match((await legacyExit).stderr, /ENOENT/);
  const uncontrolled = spawn(process.execPath, ["-e", `
    const fs = require('fs');
    fs.writeFileSync(process.argv[1] + '/started', 'legacy');
    process.stdout.write('running\\n');
    setTimeout(() => fs.writeFileSync(process.argv[1] + '/finished', 'legacy'), 300);
  `, oldRoot], { stdio: ["ignore", "pipe", "pipe"] });
  const oldExit = exited(uncontrolled);
  await listen(uncontrolled);
  const oldId = randomUUID();
  provisionManagedWriterSession(oldRoot, oldId);
  assert.deepEqual(fenceManagedWriterSession(oldRoot, oldId), {
    registeredWritersDrained: true, preexistingAndExternalWriters: "unknown", cutoverAuthorized: false,
  });
  assert.equal((await oldExit).code, 0);
  assert.equal(fs.readFileSync(path.join(oldRoot, "finished"), "utf8"), "legacy",
    "barrier must not be interpreted as proof about pre-existing unregistered processes");

  const nestedRoot = fixture("nested"), nestedId = randomUUID();
  provisionManagedWriterSession(nestedRoot, nestedId);
  const nested = spawn(process.execPath, ["-e", `
    const [compiled, root] = process.argv.slice(1);
    const { withManagedWriterOperation } = require(compiled + '/runtime/managed-writer-session');
    withManagedWriterOperation(root, 'sync-service', async () => {
      await withManagedWriterOperation(root, 'github-sync', async () => { process.stdout.write('nested\\n'); });
      await new Promise(resolve => process.stdin.once('data', resolve));
      try {
        await withManagedWriterOperation(root, 'github-sync', async () => { throw Error('unexpected admission'); });
        process.exitCode = 2;
      } catch (error) {
        if (!/fenced/.test(error.message)) throw error;
        process.stdout.write('nested fenced\\n');
      }
    }).then(() => process.stdout.write('closed\\n'), e => { console.error(e); process.exitCode = 1; });
  `, compiled, nestedRoot], { env: { ...process.env, PKM_MANAGED_WRITER_SESSION: nestedId }, stdio: ["pipe", "pipe", "pipe"] });
  const nestedExit = exited(nested);
  await listen(nested);
  assert.throws(() => fenceManagedWriterSession(nestedRoot, nestedId), /active or has an unknown outcome/);
  nested.stdin.end("stop");
  assert.equal((await nestedExit).code, 0);
  assert.equal(fenceManagedWriterSession(nestedRoot, nestedId).preexistingAndExternalWriters, "unknown");

  const detachedRoot = fixture("detached"), detachedId = randomUUID();
  provisionManagedWriterSession(detachedRoot, detachedId);
  const detached = spawn(process.execPath, ["-e", `
    const fs = require('fs');
    const [compiled, root] = process.argv.slice(1);
    const { withManagedWriterOperation } = require(compiled + '/runtime/managed-writer-session');
    withManagedWriterOperation(root, 'sync-service', async () => {
      void withManagedWriterOperation(root, 'github-sync', async () => {
        process.stdout.write('child started\\n');
        while (!fs.existsSync(root + '/release')) await new Promise(resolve => setTimeout(resolve, 10));
      });
    }).then(() => process.stdout.write('parent done\\n'));
  `, compiled, detachedRoot], { env: { ...process.env, PKM_MANAGED_WRITER_SESSION: detachedId }, stdio: ["ignore", "pipe", "pipe"] });
  const detachedExit = exited(detached);
  await new Promise((resolve, reject) => {
    let output = "";
    detached.stdout.on("data", data => { output += data; if (output.includes("parent done")) resolve(); });
    detached.once("error", reject);
    detached.once("exit", code => reject(new Error("detached child exited early: " + code)));
  });
  assert.throws(() => fenceManagedWriterSession(detachedRoot, detachedId), /active or has an unknown outcome/);
  fs.writeFileSync(path.join(detachedRoot, "release"), "go");
  assert.equal((await detachedExit).code, 0);
  assert.equal(fenceManagedWriterSession(detachedRoot, detachedId).cutoverAuthorized, false);

  const failedRoot = fixture("failed"), failedId = randomUUID();
  provisionManagedWriterSession(failedRoot, failedId);
  const failed = spawn(process.execPath, ["-e", `
    const [compiled, root] = process.argv.slice(1);
    require(compiled + '/runtime/managed-writer-session').withManagedWriterOperation(root, 'github-sync', async () => { throw Error('operation failed'); })
      .then(() => process.exitCode = 2, error => { console.error(error.message); process.exitCode = 1; });
  `, compiled, failedRoot], { env: { ...process.env, PKM_MANAGED_WRITER_SESSION: failedId }, stdio: ["ignore", "pipe", "pipe"] });
  assert.match((await exited(failed)).stderr, /operation failed/);
  assert.throws(() => fenceManagedWriterSession(failedRoot, failedId), /active or has an unknown outcome/);
});
