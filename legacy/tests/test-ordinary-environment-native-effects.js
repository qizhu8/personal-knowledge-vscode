"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { execFile, spawnSync } = require("node:child_process");
const { acquireNativeFixtureEffects, launcher } = require("./helpers/ordinary-environment-native-effects.cjs");

test("kernel fixture contract: immutable private launchers and PID1 completion physically drain descendants", {
  skip: process.env.PKM_TEST_PRIVATE_NATIVE_EFFECTS !== "1",
}, async t => {
  const root = path.resolve(".migration-test-work", `native-kernel-${crypto.randomUUID()}`);
  const profileVolume = path.join(root, "profile-volume"), programVolume = path.join(root, "program-volume");
  const programsMountpoint = path.join(programVolume, "bin");
  let bound = false;
  const knowledgeRoot = path.join(root, "knowledge"), profile = path.join(profileVolume, "profile");
  fs.mkdirSync(root, { recursive: true });
  for (const directory of [profileVolume, programVolume, knowledgeRoot]) fs.mkdirSync(directory);
  const checked = args => {
    const result = spawnSync("/usr/bin/mount", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  checked(["-t", "tmpfs", "-o", "mode=0700", "tmpfs", profileVolume]);
  checked(["-t", "tmpfs", "-o", "mode=0700", "tmpfs", programVolume]);
  t.after(() => {
    if (bound) assert.equal(spawnSync("/usr/bin/umount", [programsMountpoint]).status, 0);
    for (const volume of [programVolume, profileVolume]) assert.equal(spawnSync("/usr/bin/umount", [volume]).status, 0);
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(profile);
  fs.mkdirSync(programsMountpoint);
  const program = path.join(programsMountpoint, "du"), inner = path.join(programsMountpoint, "inner.py");
  fs.writeFileSync(inner, `#!/usr/bin/python3\nimport os,time\np=os.fork()\nif p==0:\n time.sleep(60)\n os._exit(0)\nprint("4\\\\tfixture",flush=True)\nos._exit(0)\n`, { mode: 0o700 });
  fs.writeFileSync(program, launcher(inner), { mode: 0o700 });
  checked(["--bind", programsMountpoint, programsMountpoint]);
  bound = true;
  checked(["-o", "remount,bind,ro", programsMountpoint]);
  const intent = { requestId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), actorId: "local:owner",
    knowledgeRoot, globalStorageDirectory: profile, operation: "metadata", refresh: true,
    environments: [{ id: "retained", path: programVolume, python: program, manager: "venv" }] };
  const controller = new AbortController();
  let fences = 0;
  // Unit contract callbacks are not a Root host grant. Mount/process assertions below are real.
  const options = { fixture: root, profileMountpoint: profileVolume, programsMountpoint,
    expectedMountNamespace: fs.readlinkSync("/proc/self/ns/mnt"), expectedPidNamespace: fs.readlinkSync("/proc/self/ns/pid"),
    programs: [{ filename: program, executable: inner }], environment: { PATH: programsMountpoint, HOME: profile, TMPDIR: profile },
    originalOwnedProcessesDrained() {}, assertOwnerCurrent(actual) { assert.deepEqual(actual, intent); fences++; } };
  const permit = acquireNativeFixtureEffects(options, intent, { signal: controller.signal, expiresAtMs: Date.now() + 30_000 });
  permit.claim(intent);
  const trace = { intent, environmentId: "retained", kind: "size", program: "du", args: ["-sk", programVolume],
    environment: permit.environment };
  permit.assertExecution(trace);
  let child;
  const done = new Promise((resolve, reject) => {
    child = execFile("du", trace.args, { env: permit.environment }, error => error ? reject(error) : resolve());
  });
  permit.recordExecution(child, trace);
  await done;
  await permit.verifyDrained(child, trace);
  const live = fs.readdirSync("/proc").filter(name => /^\d+$/.test(name)).filter(pid => {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(inner); } catch { return false; }
  });
  assert.deepEqual(live, [], "Namespace descendant survived normal supervisor completion.");
  assert(fences > 0);
  assert.throws(() => permit.assertExecution(trace), /replay/);
  const unknown = { exitCode: null, signalCode: "SIGKILL" };
  permit.recordExecution(unknown, trace);
  await assert.rejects(permit.verifyDrained(unknown, trace), /UNKNOWN/);
  controller.abort();
  assert.throws(() => permit.assertProfileWriter(), /revoked/);
  assert.throws(() => acquireNativeFixtureEffects({ ...options, expectedMountNamespace: "wrong" }, intent,
    { signal: new AbortController().signal, expiresAtMs: Date.now() + 30_000 }), /namespace identity/);
});
