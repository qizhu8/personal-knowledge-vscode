"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { fork } = require("node:child_process");

const dist = process.env.PKM_TEST_DIST || path.resolve("dist");
const session = require(path.join(dist, "runtime/managed-writer-session"));
const { activateManagedProfileWriter } = require(path.join(dist, "runtime/managed-profile-activation"));
const { HostWriterAdmission } = require(path.join(dist, "runtime/host-writer-admission"));

if (process.argv[2] === "--host") {
  const [root, profile, id, label] = process.argv.slice(3);
  const owner = new HostWriterAdmission(root, () => root);
  const store = require(path.join(dist, "knowledge/filestore"));
  store.setStorePath(root);
  let release;
  const inflight = owner.observe("ui", async () => {
    await new Promise(resolve => { release = resolve; });
    store.noteUpsert({ slug: `managed-${label}`, title: `Managed ${label}`, type: "note",
      tags: [], content: `Completed in-flight ${label} write.\n` });
  });
  const writer = activateManagedProfileWriter(root, id, () => owner.drain(), 30000, () => true,
    createHash("sha256").update(profile).digest("hex"), undefined, undefined, owner);
  process.send({ event: "ready", pid: process.pid, label, owner: owner.status().ownerId });
  process.on("message", async message => {
    try {
      if (message === "cancel") process.send({ event: "cancelled", result: await writer.confirmLocalDrain(profile, async () => false) });
      if (message === "confirm") {
        process.send({ event: "confirm-started" });
        const result = await writer.confirmLocalDrain(profile, async () => true);
        process.send({ event: "drained", result });
      }
      if (message === "release") { release(); await inflight; process.send({ event: "released" }); }
      if (message === "exit") { writer.dispose(); process.disconnect(); }
    } catch (error) { process.send({ event: "error", error: error.stack || String(error) }); }
  });
} else {
  function receiver(child) {
    const messages = [], waiters = [];
    child.on("message", value => {
      messages.push(value);
      for (const waiter of waiters.splice(0)) waiter();
    });
    return async event => {
      const deadline = Date.now() + 10000;
      for (;;) {
        const error = messages.find(value => value.event === "error");
        if (error) throw new Error(error.error);
        const index = messages.findIndex(value => value.event === event);
        if (index >= 0) return messages.splice(index, 1)[0];
        if (child.exitCode !== null || child.signalCode) throw new Error(`Host exited before ${event}.`);
        if (Date.now() >= deadline) throw new Error(`Host timed out waiting for ${event}.`);
        await Promise.race([new Promise(resolve => waiters.push(resolve)), new Promise(resolve => setTimeout(resolve, 50))]);
      }
    };
  }
  function start(root, profile, id, label) {
    const child = fork(__filename, ["--host", root, profile, id, label], {
      env: { ...process.env, PKM_MANAGED_WRITER_SESSION: id, PKM_TEST_DIST: dist },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    return { child, next: receiver(child) };
  }
  test("two real registered host processes independently consent and drain before session fencing",
    { timeout: 30000, skip: process.platform !== "linux" }, async t => {
      const base = path.resolve(".migration-test-work", `managed-host-processes-${randomUUID()}`);
      const root = path.join(base, "root"), a = path.join(base, "profile-a"), b = path.join(base, "profile-b");
      for (const dir of [root, a, b]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      session.provisionManagedWriterSession(root, id);
      const first = start(root, a, id, "a"), second = start(root, b, id, "b");
      t.after(() => { for (const host of [first, second]) if (host.child.exitCode === null) host.child.kill("SIGTERM"); });
      const readyA = await first.next("ready"), readyB = await second.next("ready");
      assert.notEqual(readyA.pid, readyB.pid);
      assert.notEqual(readyA.owner, readyB.owner);
      const registrations = session.discoverManagedProfiles(root, id).map(row => row.hostId);
      assert.equal(registrations.length, 2);
      second.child.send("cancel");
      assert.equal((await second.next("cancelled")).result, "cancelled");
      first.child.send("confirm");
      await first.next("confirm-started");
      assert.throws(() => session.sealConfirmedManagedProfiles(root, id, registrations));
      first.child.send("release"); await first.next("released");
      assert.match(fs.readFileSync(path.join(root, "notes", "Managed a.md"), "utf8"), /Completed in-flight a write/);
      assert.equal((await first.next("drained")).result, "drained");
      assert.throws(() => session.sealConfirmedManagedProfiles(root, id, registrations));
      second.child.send("confirm"); await second.next("confirm-started");
      second.child.send("release"); await second.next("released");
      assert.equal((await second.next("drained")).result, "drained");
      const sealed = session.sealConfirmedManagedProfiles(root, id, registrations);
      assert.equal(sealed.registeredWritersDrained, true);
      assert.equal(sealed.preexistingAndExternalWriters, "unknown");
      assert.equal(sealed.cutoverAuthorized, false);
      const exits = [first, second].map(host => new Promise(resolve => host.child.once("exit", resolve)));
      for (const host of [first, second]) host.child.send("exit");
      await Promise.all(exits);
      if (process.env.PKM_TEST_NEXT_INSPECTOR) {
        const { inspectLegacyManagedWriterSession } = await import(process.env.PKM_TEST_NEXT_INSPECTOR);
        const next = session.rotateManagedWriterSession(root, id);
        session.fenceManagedWriterSession(root, next.sessionId);
        const receipt = inspectLegacyManagedWriterSession(root);
        assert.equal(receipt.sessionId, next.sessionId);
        const confirmationPaths = receipt.files.filter(file => /\/confirmed\.[^.]+\.json$/.test(file.path));
        assert.equal(confirmationPaths.length, 2);
        const confirmation = path.join(root, confirmationPaths[0].path);
        const original = fs.readFileSync(confirmation);
        const mutate = change => {
          const value = JSON.parse(original);
          change(value);
          fs.writeFileSync(confirmation, JSON.stringify(value));
          assert.throws(() => inspectLegacyManagedWriterSession(root), { code: "PKM_STATE_UNSUPPORTED" });
          fs.writeFileSync(confirmation, original);
        };
        mutate(value => { value.profileId = "0".repeat(64); });
        mutate(value => { value.root.inode = "0"; });
        mutate(value => { value.profile.inode = "0"; });
        mutate(value => { value.operationId = randomUUID(); });
        mutate(value => { value.extra = true; });
        const operationId = JSON.parse(original).operationId;
        const completed = path.join(root, ".pkm/state/managed-writer-session", `operations.${id}`, `${operationId}.complete`);
        const savedCompletion = path.join(base, "saved-completion");
        fs.renameSync(completed, savedCompletion);
        try {
          assert.throws(() => inspectLegacyManagedWriterSession(root), { code: "PKM_STATE_UNSUPPORTED" });
        } finally {
          fs.renameSync(savedCompletion, completed);
        }
        for (const name of ["fenced", `rotation.${id}.json`]) {
          const entry = path.join(root, ".pkm/state/managed-writer-session", name);
          const saved = path.join(base, `saved-${name}`);
          fs.renameSync(entry, saved);
          try {
            assert.throws(() => inspectLegacyManagedWriterSession(root), { code: "PKM_STATE_UNSUPPORTED" });
          } finally {
            fs.renameSync(saved, entry);
          }
        }
        assert.equal(inspectLegacyManagedWriterSession(root).sessionId, next.sessionId);
        if (process.env.PKM_TEST_NEXT_DIST) {
          fs.writeFileSync(path.join(root, ".pkm/content-privacy.json"), JSON.stringify({ schema: 1, private: {} }), { mode: 0o600 });
          const { pathToFileURL } = require("node:url");
          const { inspectLegacyRootPkmPrivacyState } = await import(
            pathToFileURL(path.join(process.env.PKM_TEST_NEXT_DIST, "legacy-root-pkm-state.js")).href);
          const inventory = inspectLegacyRootPkmPrivacyState(root);
          assert.equal(inventory.managedWriterSession.sessionId, next.sessionId);
          assert.equal(inventory.managedWriterSession.files.filter(file => /\/confirmed\.[^.]+\.json$/.test(file.path)).length, 2);
        }
      }
    });

  for (const crash of [false, true]) {
    test(`confirmed fence ${crash ? "retains unknown after Sync crash" : "waits for the real Sync service to drain"}`,
      { timeout: 30000, skip: process.platform !== "linux" }, async t => {
        const base = path.resolve(".migration-test-work", `managed-host-sync-${randomUUID()}`);
        const root = path.join(base, "root"), profile = path.join(base, "profile"), home = path.join(base, "home");
        for (const dir of [root, profile, home]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const id = randomUUID();
        session.provisionManagedWriterSession(root, id);
        const host = start(root, profile, id, "host");
        const daemon = fork(path.resolve("tests/test-managed-sync-service.js"), ["--service-child", JSON.stringify({
          knowledgeRoot: root, globalStoragePath: profile, extensionVersion: require("../package.json").version,
        })], {
          cwd: base, env: { ...process.env, HOME: "/proc/self/cwd/home", TMPDIR: base, PKM_MANAGED_WRITER_SESSION: id,
            PKM_SERVICE_TEST_LIFECYCLE_MS: "50", PKM_SERVICE_BUILD_DIR: dist },
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        });
        const exited = new Promise(resolve => daemon.once("exit", (code, signal) => resolve({ code, signal })));
        const started = new Promise((resolve, reject) => {
          daemon.on("message", value => { if (value.started) resolve(); });
          daemon.once("exit", () => reject(new Error("Sync service exited before starting.")));
        });
        t.after(async () => {
          if (host.child.exitCode === null && !host.child.signalCode) host.child.kill("SIGTERM");
          if (daemon.exitCode === null && !daemon.signalCode) daemon.kill("SIGTERM");
          await exited;
        });
        await Promise.all([host.next("ready"), started]);
        const registrations = session.discoverManagedProfiles(root, id).map(row => row.hostId);
        assert.throws(() => session.beginConfirmedManagedProfileFence(root, id, registrations), /independently drained/);
        assert.equal(session.managedWriterAdmissionState(root, id), "accepting");
        host.child.send("confirm"); await host.next("confirm-started");
        host.child.send("release"); await host.next("released"); await host.next("drained");
        assert.throws(() => session.sealConfirmedManagedProfiles(root, id, registrations), /active or has an unknown outcome/);
        if (crash) {
          daemon.kill("SIGKILL");
          assert.equal((await exited).signal, "SIGKILL");
        }
        assert.equal(session.beginConfirmedManagedProfileFence(root, id, registrations).status, "fenced-pending");
        assert.throws(() => session.beginConfirmedManagedProfileFence(root, id, registrations), /already fenced/);
        if (crash) {
          await assert.rejects(session.waitForManagedWriterDrain(root, id, 100), /active or has an unknown outcome/);
        } else {
          const result = await session.waitForManagedWriterDrain(root, id, 10000);
          assert.equal(result.registeredWritersDrained, true);
          assert.equal(result.cutoverAuthorized, false);
          assert.deepEqual(await exited, { code: 0, signal: null });
        }
        host.child.send("exit");
      });
  }
}
