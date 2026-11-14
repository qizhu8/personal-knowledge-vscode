import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { legacyKnowledgeSnapshotFixtureBridge as bridge } from "../dist/legacy-knowledge-snapshot-fixture-bridge.js";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../legacy");
async function fixture(t) {
  const parent = join(project, ".migration-test-work", `pkm-snapshot-fixture-${randomUUID()}`);
  const root = join(parent, "knowledge"), nonce = randomUUID();
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, ".pkm/state"), { recursive: true, mode: 0o700 });
  await mkdir(join(parent, "t"), { mode: 0o700 });
  const privacy = Buffer.from('{"schema":1,"private":{"notes":["Private"]}}\n');
  await writeFile(join(root, ".pkm/content-privacy.json"), privacy, { mode: 0o600 });
  await writeFile(join(root, "notes/Fixture.md"), "# Initial synthetic knowledge\n", { mode: 0o600 });
  const oldMask = process.umask(0o077);
  try {
    execFileSync("python3", ["-c", [
      "import json,sys", "sys.path.insert(0,sys.argv[1])",
      "from knowledge_snapshots import KnowledgeSnapshots",
      "print(json.dumps(KnowledgeSnapshots(sys.argv[2]).create('legacy')))",
    ].join("\n"), join(project, "resources"), root], {
      cwd: project, env: { PATH: process.env.PATH || "", HOME: parent, TMPDIR: join(parent, "t"),
        PYTHONDONTWRITEBYTECODE: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" },
    });
  } finally { process.umask(oldMask); }
  const stat = await lstat(root);
  await writeFile(join(parent, "snapshot-fixture.json"), JSON.stringify({
    schema: "pkm.snapshot-fixture/v1", nonce, rootPin: `${stat.dev}:${stat.ino}`,
  }), { mode: 0o600 });
  process.env.PKM_PRIVATE_SNAPSHOT_FIXTURE = parent;
  t.after(async () => { delete process.env.PKM_PRIVATE_SNAPSHOT_FIXTURE; await rm(parent, { recursive: true, force: true }); });
  return { parent, root, nonce, privacy, state: join(root, ".pkm/state/knowledge-snapshots") };
}
async function tree(base) {
  const values = {};
  async function walk(path, prefix = "") {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name, target = join(path, entry.name);
      const stat = await lstat(target);
      values[name] = { mode: stat.mode & 0o777, ...(entry.isFile() ? { bytes: await readFile(target) } : {}) };
      if (entry.isDirectory()) await walk(target, name);
    }
  }
  await walk(base);
  return values;
}

test("original private Git snapshot history is read and extended at the same path", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const note = join(f.root, "notes/Fixture.md"), stateInode = (await lstat(f.state)).ino;
  const initial = await bridge(f.root, { nonce: f.nonce, operation: "status" });
  assert.equal(initial.tags.length, 1);
  assert.equal(initial.repository, join(f.state, "repository.git"));
  const original = await bridge(f.root, { nonce: f.nonce, operation: "read",
    tag: initial.tags[0], path: "notes/Fixture.md" });
  assert.equal(Buffer.from(original.contentBase64, "base64").toString("utf8"), "# Initial synthetic knowledge\n");
  await assert.rejects(bridge(f.root, { nonce: f.nonce, operation: "read",
    tag: initial.tags[0], path: "notes/../../.pkm/content-privacy.json" }), { code: "UNSAFE_PATH" });
  await writeFile(note, "# Changed synthetic knowledge\n");
  let checkedLock = false;
  const created = await bridge(f.root, { nonce: f.nonce, operation: "create", reason: "fixture-next", checkpoint(phase) {
    if (phase === "prepared") {
      const competing = spawnSync("flock", ["-xn", join(f.state, "snapshot.lock"), "true"]);
      assert.equal(competing.status, 1, "original Snapshot writer lock was not held");
      checkedLock = true;
    }
  } });
  assert(checkedLock);
  await assert.rejects(bridge(f.root, { nonce: f.nonce, operation: "status" }), { code: "RECOVERY_REQUIRED" });
  assert.deepEqual(await bridge(f.root, { nonce: f.nonce, operation: "acknowledge" }), { state: "acknowledged" });
  const reopened = await bridge(f.root, { nonce: f.nonce, operation: "status" });
  assert.equal(reopened.tags.length, 2);
  assert(reopened.tags.includes(created.tag));
  const current = await bridge(f.root, { nonce: f.nonce, operation: "read",
    tag: created.tag, path: "notes/Fixture.md" });
  assert.equal(Buffer.from(current.contentBase64, "base64").toString("utf8"), "# Changed synthetic knowledge\n");
  assert.equal((await lstat(f.state)).ino, stateInode);
  assert.deepEqual(await readFile(join(f.root, ".pkm/content-privacy.json")), f.privacy);
  assert.equal(await readFile(note, "utf8"), "# Changed synthetic knowledge\n");
});

test("interrupted publication can be rolled back or committed and rejects outside changes", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const before = await tree(f.state);
  await writeFile(join(f.root, "notes/Fixture.md"), "# Next synthetic revision\n");
  await assert.rejects(bridge(f.root, { nonce: f.nonce, operation: "create", checkpoint(phase) {
    if (phase === "published-file") throw new Error("synthetic crash");
  } }), /synthetic crash/);
  await assert.rejects(bridge(f.root, { nonce: f.nonce, operation: "acknowledge" }), { code: "RECOVERY_REQUIRED" });
  await assert.rejects(bridge(f.root, { nonce: f.nonce, operation: "status" }), { code: "RECOVERY_REQUIRED" });
  assert.deepEqual(await bridge(f.root, { nonce: f.nonce, operation: "recover-rollback" }), { state: "rolled-back" });
  assert.deepEqual(await tree(f.state), before);
  await assert.rejects(bridge(f.root, { nonce: f.nonce, operation: "create", checkpoint(phase) {
    if (phase === "published-file") throw new Error("synthetic crash");
  } }), /synthetic crash/);
  await writeFile(join(f.state, "unowned"), "do not remove");
  await assert.rejects(bridge(f.root, { nonce: f.nonce, operation: "recover-commit" }), { code: "RECOVERY_CONFLICT" });
  assert.equal(await readFile(join(f.state, "unowned"), "utf8"), "do not remove");
  await rm(join(f.state, "unowned"));
  assert.equal((await bridge(f.root, { nonce: f.nonce, operation: "recover-commit" })).state, "committed-awaiting-ack");
  assert.deepEqual(await bridge(f.root, { nonce: f.nonce, operation: "acknowledge" }), { state: "acknowledged" });
  assert.equal((await bridge(f.root, { nonce: f.nonce, operation: "status" })).tags.length, 2);
});

test("fixture binding fails closed before touching the original snapshot", async t => {
  const f = await fixture(t), before = await tree(f.state);
  await assert.rejects(bridge(f.root, { nonce: randomUUID(), operation: "create" }), { code: "FIXTURE_DENIED" });
  delete process.env.PKM_PRIVATE_SNAPSHOT_FIXTURE;
  await assert.rejects(bridge(f.root, { nonce: f.nonce, operation: "create" }), { code: "FIXTURE_DENIED" });
  assert.deepEqual(await tree(f.state), before);
});

test("foreign Git authority and inconsistent legacy metadata are not adopted", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const alternates = join(f.state, "repository.git/objects/info/alternates");
  await writeFile(alternates, "/outside/never-read\n", { mode: 0o600 });
  let before = await tree(f.state);
  await assert.rejects(bridge(f.root, { nonce: f.nonce, operation: "create" }), { code: "UNSUPPORTED_STATE" });
  assert.deepEqual(await tree(f.state), before);
  await rm(alternates);
  const latest = join(f.state, "latest.json"), value = JSON.parse(await readFile(latest, "utf8"));
  value.commit = "0".repeat(40);
  await writeFile(latest, JSON.stringify(value));
  before = await tree(f.state);
  await assert.rejects(bridge(f.root, { nonce: f.nonce, operation: "status" }), { code: "UNSUPPORTED_STATE" });
  assert.deepEqual(await tree(f.state), before);
});

test("process death at each publication phase can recover on restart", { timeout: 60000 }, async t => {
  const f = await fixture(t), before = await tree(f.state);
  const child = join(project, "../tests/legacy-knowledge-snapshot-fixture-child.mjs");
  const run = (operation, crash = "") => spawnSync(process.execPath, [child, f.root, f.nonce, operation, crash], {
    cwd: project, env: { ...process.env, TMPDIR: join(f.parent, "t") }, encoding: "utf8", timeout: 30000,
  });
  await writeFile(join(f.root, "notes/Fixture.md"), "# Process restart synthetic revision\n");
  for (const phase of ["journal-linked", "prepared", "temporary-ready", "new-linked", "published-file"]) {
    const crashed = run("create", phase);
    assert.equal(crashed.status, 77, `${phase}: ${crashed.stderr}`);
    const recovered = run("recover-rollback");
    assert.equal(recovered.status, 0, `${phase}: ${recovered.stderr}`);
    assert.equal(JSON.parse(recovered.stdout).state, "rolled-back");
    assert.deepEqual(await tree(f.state), before);
  }
  const crashed = run("create", "committed");
  assert.equal(crashed.status, 77, crashed.stderr);
  const recovered = run("recover-commit");
  assert.equal(recovered.status, 0, recovered.stderr);
  const recoveredResult = JSON.parse(recovered.stdout);
  assert.equal(recoveredResult.state, "committed-awaiting-ack");
  assert.match(recoveredResult.result.tag, /^pkm-snapshot-/);
  await assert.rejects(bridge(f.root, { nonce: f.nonce, operation: "create" }), { code: "RECOVERY_REQUIRED" });
  assert.equal((await bridge(f.root, { nonce: f.nonce, operation: "acknowledge" })).state, "acknowledged");
  assert.equal((await bridge(f.root, { nonce: f.nonce, operation: "status" })).tags.length, 2);
  const debris = (await readdir(f.parent)).filter(name => /^snapshot-stage-|^\.pkm-snapshot-/.test(name));
  assert.deepEqual(debris, []);
});

test("live legacy writable descriptor remains a blocking writer", { timeout: 30000 }, async t => {
  const f = await fixture(t), before = await tree(f.state);
  const ready = join(f.parent, "writer-ready");
  const script = [
    "const fs=require('node:fs')",
    "const fd=fs.openSync(process.argv[1],'r+')",
    "fs.writeFileSync(process.argv[2],'ready',{mode:0o600})",
    "process.stdin.on('end',()=>{fs.closeSync(fd);process.exit(0)})",
    "process.stdin.resume()",
  ].join(";");
  const writer = spawn(process.execPath, ["-e", script, join(f.root, "notes/Fixture.md"), ready], {
    stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, TMPDIR: join(f.parent, "t") },
  });
  try {
    let active = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await lstat(ready); active = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert(active, "synthetic legacy writer failed to start");
    await assert.rejects(bridge(f.root, { nonce: f.nonce, operation: "create" }), { code: "LEGACY_WRITERS_ACTIVE" });
    assert.deepEqual(await tree(f.state), before);
  } finally {
    const exited = new Promise(resolve => writer.once("exit", resolve));
    writer.stdin.end();
    await exited;
  }
});
