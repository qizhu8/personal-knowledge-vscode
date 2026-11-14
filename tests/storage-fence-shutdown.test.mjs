import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { initialize, Storage } from "../dist/storage.js";
import { acquireLinuxRootWriterFence } from "../dist/linux-root-writer-fence.js";

async function fixture(t) {
  const directory = resolve(".migration-test-work", `storage-fence-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return initialize(join(directory, "root"));
}

test("failed shutdown retains the real fence until worker and resources actually finish", { skip: process.platform !== "linux" }, async t => {
  const root = await fixture(t);
  const store = await Storage.open(root);
  let resourceFinished = false;
  store.retainResource({ release: () => {
    if (!resourceFinished) throw new Error("resource still active");
  } });
  await assert.rejects(store.close(), /resource still active/);
  await assert.rejects(acquireLinuxRootWriterFence(root, 100), /fence/);
  resourceFinished = true;
  await store.close();
  const next = await acquireLinuxRootWriterFence(root, 1000);
  await next.release();
});

test("a shutdown dispatch failure retains the fence while the actual worker lives", { skip: process.platform !== "linux" }, async t => {
  const root = await fixture(t);
  const store = await Storage.open(root);
  const post = store.worker.postMessage;
  store.worker.postMessage = () => { throw new Error("injected worker dispatch failure"); };
  await assert.rejects(store.close(), /injected worker dispatch failure/);
  await assert.rejects(acquireLinuxRootWriterFence(root, 100), /fence/);
  store.worker.postMessage = post;
  await store.close();
  const next = await acquireLinuxRootWriterFence(root, 1000);
  await next.release();
});

test("scheduler shutdown failure does not release the database fence", { skip: process.platform !== "linux" }, async t => {
  const root = await fixture(t);
  const store = await Storage.open(root);
  let stopped = false;
  store.registerNativeSnapshotScheduler({
    close: async () => { if (!stopped) throw new Error("scheduler still active"); },
    pauseForBackup: async () => { throw new Error("not used"); },
  });
  await assert.rejects(store.close(), /scheduler still active/);
  await assert.rejects(acquireLinuxRootWriterFence(root, 100), /fence/);
  stopped = true;
  await store.close();
  const next = await acquireLinuxRootWriterFence(root, 1000);
  await next.release();
});

test("crashed owner rolls back its open SQLite transaction before a new process acquires the fence", { skip: process.platform !== "linux" }, async t => {
  const root = await fixture(t);
  const moduleUrl = new URL("../dist/storage.js", import.meta.url).href;
  const child = spawn(process.execPath, ["-e", `
    (async () => {
    const { Storage } = await import(process.argv[1]);
    const storage = await Storage.open(process.argv[2]);
    const db = storage.connectNative();
    db.exec("BEGIN IMMEDIATE; CREATE TABLE interrupted_private_probe(value TEXT)");
    process.stdout.write("ready\\n");
    await new Promise(() => {});
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, moduleUrl, root], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await new Promise((resolveReady, reject) => {
    child.stdout.once("data", resolveReady);
    child.once("error", reject);
    child.once("close", code => reject(new Error(`owner exited before ready: ${code}: ${stderr}`)));
  });
  await assert.rejects(acquireLinuxRootWriterFence(root, 100), /fence/);
  const exited = new Promise(resolveExit => child.once("close", resolveExit));
  child.kill("SIGKILL");
  await exited;
  const reopened = await Storage.open(root);
  try {
    const db = reopened.connectNative();
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='interrupted_private_probe'").get().n, 0);
    } finally { db.close(); }
  } finally { await reopened.close(); }
});
