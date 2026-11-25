import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { watch, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import Module, { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const built = await require("esbuild").build({
  entryPoints: [resolve("clients/vscode-host/original-mcp-native-sdk-egress.ts")],
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
});
const memory = new Module(resolve("tests/.sdk-egress-lifecycle-memory.cjs"));
memory.filename = memory.id; memory.paths = Module._nodeModulePaths(resolve("."));
memory._compile(built.outputFiles[0].text, memory.filename);
const { createOriginalSdkEgressOwner: create } = memory.exports;
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  const root = resolve(".pkm-test-evidence", `sdk-egress-lifecycle-${randomUUID()}`);
  await mkdir(root, { mode: 0o700, recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController(), registered = new Set(), notified = [], stopped = [];
  let releases = 0;
  const supervisor = resolve("clients/vscode-host/original-mcp-native-sdk-supervisor.py");
  const owner = await create({
    profileRoot: root, python: await realpath("/usr/bin/python3"), supervisor,
    supervisorSha256: createHash("sha256").update(await readFile(supervisor)).digest("hex"),
    // Reservation/control lifecycle metadata only. No runtime is constructed or spawned.
    selection: { runtimeFile: resolve("tests/no-runtime-spawned"), runtimeIdentity: {},
      moduleManifest: resolve("package.json"), runtimeManifest: resolve("package.json") },
    baseOptions: { mode: "empty", useLoggedInUser: false },
    assertCurrent() {}, signal: controller.signal,
    registerChild(close) { registered.add(close); return () => { releases++; registered.delete(close); }; },
    reportFailure(error) { notified.push(error); },
  });
  t.after(() => owner.close().catch(error => assert(notified.includes(error) || notified.length > 0)));
  return { root, owner, controller, registered, notified, stopped, releases: () => releases };
}

test("abort latches a failing owned client closer, notifies once and releases registration/resources exactly once", async t => {
  const f = await fixture(t), lease = await f.owner.reserve();
  const args = lease.clientOptions.connection.args, manifest = JSON.parse(await readFile(args[3], "utf8"));
  const original = new Error("synthetic-local-closer-failure");
  lease.bindClient(async () => { f.stopped.push(process.pid); throw original; });
  f.controller.abort("synthetic cancellation");
  await assert.rejects(f.owner.close(), error => {
    assert.equal(error.message, "NATIVE_SDK_CLEANUP_UNCONFIRMED");
    assert(error.errors.includes(original)); return true;
  });
  assert.throws(() => f.owner.assertCurrent(), /CLEANUP_UNCONFIRMED/);
  await assert.rejects(f.owner.close(), /CLEANUP_UNCONFIRMED/);
  assert.deepEqual(f.stopped, [process.pid]);
  assert.equal(f.releases(), 1); assert.equal(f.registered.size, 0); assert.equal(f.notified.length, 1);
  assert.deepEqual(await readdir(f.root), []);
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = connect(manifest.controlSocket);
    socket.once("connect", () => { socket.destroy(); resolve(); }); socket.once("error", reject);
  }), error => ["ECONNREFUSED", "ENOENT"].includes(error.code));
});

test("partial reservation setup preserves the collision cause and removes only its owned directory", async t => {
  const f = await fixture(t);
  let observed;
  const watcher = watch(f.root, (event, name) => {
    if (event === "rename" && name?.startsWith("sdk-child-")) {
      try { writeFileSync(join(f.root, name, "launch.json"), "synthetic setup collision", { flag: "wx" }); observed = name; }
      catch (error) { if (!["EEXIST", "ENOENT"].includes(error.code)) throw error; }
    }
  });
  t.after(() => watcher.close());
  await assert.rejects(f.owner.reserve(), error => error.code === "EEXIST");
  assert(observed); assert.deepEqual(await readdir(f.root), []);
  assert.equal(f.registered.size, 1);
  await f.owner.close(); await f.owner.close();
  assert.equal(f.releases(), 1); assert.equal(f.registered.size, 0); assert.equal(f.notified.length, 0);
});

test("malformed and duplicate control frames close the client instead of hanging in failed phase", async t => {
  const f = await fixture(t), lease = await f.owner.reserve();
  const args = lease.clientOptions.connection.args, manifest = JSON.parse(await readFile(args[3], "utf8"));
  lease.bindClient(async () => { f.stopped.push(process.pid); });
  const pending = assert.rejects(lease.ready());
  const socket = connect(manifest.controlSocket);
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.write(`{"phase":"invalid","nonce":"${manifest.nonce}"}\n{"phase":"invalid","nonce":"${manifest.nonce}"}\n`);
  await pending;
  for (let count = 0; count < 100 && !f.notified.length; count++) await tick();
  socket.destroy();
  await assert.rejects(f.owner.close(), /CLEANUP_UNCONFIRMED/);
  assert.deepEqual(f.stopped, [process.pid]); assert.deepEqual(await readdir(f.root), []);
  assert.equal(f.registered.size, 0); assert.equal(f.releases(), 1);
});
