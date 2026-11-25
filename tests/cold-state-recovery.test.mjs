import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmod, link, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  captureColdStateRecovery, planColdStateRecovery, restoreColdStateRecovery, verifyColdStateRecovery,
} from "../experimental/cold-state-recovery.mjs";
import { acquireLinuxRootWriterFence } from "../dist/linux-root-writer-fence.js";

assert(process.env.PKM_TEST_WORKSPACE, "Run this suite through tests/framework/workspace.cjs.");
const work = process.env.PKM_TEST_WORKSPACE;
process.env.HOME = join(work, "recovery-home");
process.umask(0o077);
await mkdir(process.env.HOME, { mode: 0o700 });
const privateRoot = join(process.env.HOME, ".local/state/pkm-v5-recovery");
const controller = resolve("experimental/cold-state-recovery.mjs");

async function fixture(t) {
  const root = join(work, `fixture-${randomUUID()}`);
  const originalRoot = join(root, "original"), external = join(root, "profile"), config = join(root, "configuration");
  for (const path of [join(originalRoot, ".pkm/state/api-chat-history/chat"), external, config])
    await mkdir(path, { recursive: true, mode: 0o700 });
  const configuration = '{\r\n // Synthetic opaque configuration\r\n "provider": "fixture"\r\n}\r\n';
  await writeFile(join(config, "settings.json"), configuration, { mode: 0o600 });
  await writeFile(join(originalRoot, ".pkm/state/api-chat-history/chat/segment.jsonl"),
    '{"role":"user","content":"Synthetic segmented history"}\n', { mode: 0o600 });
  const request = { schema: "pkm.cold-state-request/v1", originalRoot,
    externalDirectories: [{ id: "profile", path: external }],
    configurationFiles: [{ id: "settings", path: join(config, "settings.json") }], opaqueLinks: "refuse" };
  const destination = join(privateRoot, `capture-${randomUUID()}`);
  t.after(() => rm(root, { recursive: true }));
  return { root, request, originalRoot, external, config, configuration, destination };
}

async function close(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.stdin.end();
  await closed;
}

async function hold(path) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {openSync,closeSync} from "node:fs";
    const fd=openSync(process.argv[1],"a"); process.stdout.write("ready\\n");
    process.stdin.resume(); process.stdin.on("end",()=>{closeSync(fd);process.exit(0)});
  `, path], { stdio: ["pipe", "pipe", "pipe"] });
  await once(child.stdout, "data");
  return child;
}

async function walFixture(path) {
  const child = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", `
    import {DatabaseSync} from "node:sqlite";
    const db=new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('committed'); BEGIN IMMEDIATE; INSERT INTO preserved VALUES('uncommitted');");
    process.kill(process.pid,"SIGKILL");
  `, path], { encoding: "utf8" });
  assert.equal(child.signal, "SIGKILL", child.stderr);
}

async function waitForStage(prefix, marker, child) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const names = await readdir(privateRoot).catch(() => []);
    const stage = names.find(name => name.startsWith(`.${prefix}.partial-`));
    if (stage) {
      try { await lstat(join(privateRoot, stage, marker)); return join(privateRoot, stage); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    assert.equal(child.exitCode, null, "Capture exited before the observable phase.");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Owned fixture capture phase timeout.");
}

test("original and explicitly bound external writers block capture without killing or copying them", async t => {
  const fixture_ = await fixture(t);
  for (const path of [join(fixture_.originalRoot, "knowledge.db"), join(fixture_.external, "profile-state")]) {
    const child = await hold(path);
    try {
      await assert.rejects(captureColdStateRecovery(fixture_.request, fixture_.destination),
        error => error.code === "NOT_QUIESCENT" && error.gateCode === "LEGACY_WRITERS_ACTIVE");
      assert.equal(child.exitCode, null);
      await assert.rejects(lstat(fixture_.destination), { code: "ENOENT" });
    } finally { await close(child); }
  }
});

test("quiescent multi-scope WAL/config/history bytes restore, but never manufacture global cold authority", async t => {
  const f = await fixture(t);
  await walFixture(join(f.external, "memory.sqlite3"));
  const captured = await captureColdStateRecovery(f.request, f.destination);
  assert.equal(captured.readiness, "not-ready");
  assert.deepEqual(captured.missingConditions, ["global-shutdown-not-proven"]);
  assert.equal(captured.sqlite.integrityChecksPassed, 1);
  assert(captured.summary.absent >= 7, "Missing original domains and sidecars are explicit records.");
  assert.equal((await verifyColdStateRecovery(f.destination, captured.manifestSha256)).valid, true);
  const verified = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", controller,
    "verify", f.destination, captured.manifestSha256], { encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).readiness, "not-ready");
  await assert.rejects(captureColdStateRecovery(f.request, f.destination), { code: "DESTINATION_EXISTS" });
  const target = join(privateRoot, `restored-${randomUUID()}`);
  const restored = await restoreColdStateRecovery(f.destination, captured.manifestSha256, target);
  assert.equal(restored.sqlite.integrityChecksPassed, 1);
  assert.equal(restored.inodePreservation, false);
  assert.equal(await readFile(join(target, "payload/settings-0"), "utf8"), f.configuration);
  assert.equal(await readFile(join(target, "payload/legacy-pkm/state/api-chat-history/chat/segment.jsonl"), "utf8"),
    '{"role":"user","content":"Synthetic segmented history"}\n');
  const validationDb = new DatabaseSync(join(target, "sqlite-validation/db-1/database.sqlite"), { readOnly: true });
  try { assert.deepEqual(validationDb.prepare("SELECT value FROM preserved").all().map(row => row.value), ["committed"]); }
  finally { validationDb.close(); }
  const before = await lstat(join(f.external, "memory.sqlite3"), { bigint: true });
  const after = await lstat(join(target, "payload/profile/memory.sqlite3"), { bigint: true });
  assert.notEqual(before.ino, after.ino);
  assert.equal(Number(after.mode & 0o777n), 0o600);
  await assert.rejects(restoreColdStateRecovery(f.destination, captured.manifestSha256, target), { code: "DESTINATION_EXISTS" });
  await assert.rejects(restoreColdStateRecovery(f.destination, captured.manifestSha256, f.originalRoot), { code: "DESTINATION_POLICY" });
  await assert.rejects(verifyColdStateRecovery(f.destination, "0".repeat(64)), { code: "WRONG_PIN" });
  const payload = join(f.destination, "payload/settings-0");
  await writeFile(payload, "corruption", { mode: 0o600 });
  await assert.rejects(verifyColdStateRecovery(f.destination, captured.manifestSha256), { code: "CORRUPT_BYTES" });
  await assert.rejects(restoreColdStateRecovery(f.destination, captured.manifestSha256,
    join(privateRoot, `corrupt-restore-${randomUUID()}`)), { code: "CORRUPT_BYTES" });
});

test("scope overlap, unknown shape, links and unsafe destinations fail closed", async t => {
  const f = await fixture(t);
  await assert.rejects(planColdStateRecovery({ ...f.request, cold: true }), { code: "UNKNOWN_SHAPE" });
  await assert.rejects(planColdStateRecovery({ ...f.request,
    externalDirectories: [...f.request.externalDirectories, { id: "duplicate", path: f.external }] }), { code: "SOURCE_OVERLAP" });
  const unsafeParent = join(f.root, "unsafe-parent"), unsafeOriginal = join(unsafeParent, "original");
  await mkdir(unsafeOriginal, { recursive: true, mode: 0o700 });
  await chmod(unsafeParent, 0o777);
  try {
    await assert.rejects(planColdStateRecovery({ ...f.request, originalRoot: unsafeOriginal }), { code: "UNSAFE_PARENT" });
  } finally { await chmod(unsafeParent, 0o700); }
  await assert.rejects(captureColdStateRecovery(f.request, join(f.originalRoot, "backup")), { code: "DESTINATION_POLICY" });
  const outside = join(f.root, "opaque-target");
  await writeFile(outside, "Synthetic target must never be copied.", { mode: 0o600 });
  await symlink(outside, join(f.external, "serving-release.json"));
  await assert.rejects(captureColdStateRecovery(f.request, f.destination), { code: "SYMLINK_UNSUPPORTED" });
  const captured = await captureColdStateRecovery({ ...f.request, opaqueLinks: "metadata-only" }, f.destination);
  assert.equal(captured.summary.opaqueLinks, 1);
  assert.equal(captured.summary.targetClosureComplete, false);
  assert(captured.missingConditions.includes("opaque-link-target-closure-incomplete"));
  await assert.rejects(lstat(join(f.destination, "payload/profile/serving-release.json")), { code: "ENOENT" });
  assert.equal(await readFile(outside, "utf8"), "Synthetic target must never be copied.");
  await link(outside, join(f.external, "hardlink"));
  await assert.rejects(captureColdStateRecovery({ ...f.request, opaqueLinks: "metadata-only" },
    join(privateRoot, `hardlink-${randomUUID()}`)), { code: "HARDLINK_UNSUPPORTED" });
});

test("explicit regular-file link closure permits SQLite and retains separate target bytes and original-link metadata", async t => {
  for (const reused of [false, true]) {
    const f = await fixture(t);
    await walFixture(join(f.external, "memory.sqlite3"));
    const target = reused ? join(f.config, "settings.json") : join(f.root, "release.json");
    if (!reused) await writeFile(target, '{"release":"synthetic"}\n', { mode: 0o600 });
    const linkPath = join(f.external, "serving-release.json");
    await symlink(target, linkPath);
    const originalLink = await lstat(linkPath, { bigint: true });
    const request = { ...f.request, fileLinks: [{ path: linkPath, target }] };
    const captured = await captureColdStateRecovery(request, f.destination);
    assert.equal(captured.readiness, "not-ready");
    assert.equal(captured.summary.approvedFileLinks, 1);
    assert.equal(captured.summary.opaqueLinks, 0);
    assert.equal(captured.summary.targetClosureComplete, true);
    assert.equal(captured.sqlite.integrityChecksPassed, 1);
    const records = (await readFile(join(f.destination, "inventory.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    const metadata = records.find(row => row.kind === "file-link");
    assert.equal(metadata.linkText, target);
    assert.equal(metadata.sourceIdentity.ino, String(originalLink.ino));
    const expected = await readFile(target);
    assert.deepEqual(await readFile(join(f.destination, "payload", metadata.targetPayload)), expected);
    assert.equal(metadata.targetPayload, reused ? "settings-0" : "link-target-0");
    await assert.rejects(lstat(join(f.destination, "payload/profile/serving-release.json")), { code: "ENOENT" });
    await rm(linkPath);
    await rm(target);
    assert.equal((await verifyColdStateRecovery(f.destination, captured.manifestSha256)).valid, true);
    const restoredPath = join(privateRoot, `restored-links-${randomUUID()}`);
    const restored = await restoreColdStateRecovery(f.destination, captured.manifestSha256, restoredPath);
    assert.equal(restored.summary.approvedFileLinks, 1);
    assert.equal(restored.sqlite.integrityChecksPassed, 1);
    assert.deepEqual(await readFile(join(restoredPath, "payload", metadata.targetPayload)), expected);
    assert.equal(await readFile(join(restoredPath, "inventory.jsonl"), "utf8"),
      await readFile(join(f.destination, "inventory.jsonl"), "utf8"));
    await writeFile(join(f.destination, "payload", metadata.targetPayload), "corrupted approved target", { mode: 0o600 });
    await assert.rejects(verifyColdStateRecovery(f.destination, captured.manifestSha256), { code: "CORRUPT_BYTES" });
  }
});

test("unapproved links, wrong bindings, directory targets, chains and ambiguous link scopes refuse", async t => {
  const f = await fixture(t);
  await walFixture(join(f.external, "memory.sqlite3"));
  const target = join(f.root, "release.json"), other = join(f.root, "other.json");
  await writeFile(target, "synthetic release", { mode: 0o600 });
  await writeFile(other, "synthetic other", { mode: 0o600 });
  const path = join(f.external, "serving-release.json");
  await symlink(target, path);
  await assert.rejects(captureColdStateRecovery(f.request, f.destination), { code: "SYMLINK_UNSUPPORTED" });
  await assert.rejects(captureColdStateRecovery({ ...f.request, opaqueLinks: "metadata-only" }, f.destination),
    { code: "SQLITE_SIDECAR_SCOPE_UNPROVEN" });
  await assert.rejects(planColdStateRecovery({ ...f.request, fileLinks: [{ path, target: other }] }),
    { code: "LINK_BINDING_MISMATCH" });
  await assert.rejects(planColdStateRecovery({ ...f.request, fileLinks: [{ path, target }, { path, target }] }),
    { code: "LINK_BINDING_AMBIGUOUS" });
  await assert.rejects(planColdStateRecovery({ ...f.request,
    fileLinks: [{ path, target: other }, { path: other, target: path }] }), { code: "LINK_BINDING_AMBIGUOUS" });
  await rm(path);
  await symlink(f.external, path);
  await assert.rejects(planColdStateRecovery({ ...f.request, fileLinks: [{ path, target: f.external }] }),
    { code: "LINK_TARGET_UNSUPPORTED" });
  const chain = join(f.root, "chain");
  await symlink(target, chain);
  await rm(path);
  await symlink(chain, path);
  await assert.rejects(planColdStateRecovery({ ...f.request, fileLinks: [{ path, target: chain }] }),
    { code: "LINK_TARGET_UNSUPPORTED" });
});

test("fenced B1 backs up optional native directories and restores their bytes separately", async t => {
  const f = await fixture(t);
  const names = [".pkm-next-todo", ".pkm-next-memory", ".pkm-next-retrieval-models"];
  for (const name of names.slice(0, 2)) {
    await mkdir(join(f.originalRoot, name), { mode: 0o700 });
    await writeFile(join(f.originalRoot, name, "state"), name, { mode: 0o600 });
  }
  const request = { ...f.request, includeNativeRuntimeDirectories: true };
  await assert.rejects(planColdStateRecovery(request), { code: "WRITER_FENCE_INVALID" });
  const writerFence = await acquireLinuxRootWriterFence(f.originalRoot);
  try {
    const captured = await captureColdStateRecovery(request, f.destination, { writerFence });
    const target = join(privateRoot, `restored-${randomUUID()}`);
    await restoreColdStateRecovery(f.destination, captured.manifestSha256, target);
    for (const name of names.slice(0, 2))
      assert.equal(await readFile(join(target, "payload", name.slice(1), "state"), "utf8"), name);
    await assert.rejects(lstat(join(target, "payload", names[2].slice(1))), { code: "ENOENT" });
    writerFence.assertHeld();
  } finally { await writerFence.release(); }
});

test("a caller's same branded root fence is retained, not replaced, released or used to skip writer inventory", async t => {
  const f = await fixture(t);
  await assert.rejects(planColdStateRecovery(f.request,
    { writerFence: { root: f.originalRoot, mode: "exclusive", assertHeld() {} } }), { code: "WRITER_FENCE_INVALID" });
  const writerFence = await acquireLinuxRootWriterFence(f.originalRoot);
  try {
    const captured = await captureColdStateRecovery(f.request, f.destination, { writerFence });
    assert.equal(captured.readiness, "not-ready");
    writerFence.assertHeld();
    const child = await hold(join(f.external, "active-writer"));
    try {
      await assert.rejects(captureColdStateRecovery(f.request, join(privateRoot, `fenced-${randomUUID()}`), { writerFence }),
        { code: "NOT_QUIESCENT" });
      writerFence.assertHeld();
    } finally { await close(child); }
  } finally { await writerFence.release(); }
});

test("source changes and interrupted stages cannot be promoted or verified as completed captures", async t => {
  const f = await fixture(t);
  const large = Buffer.alloc(1024 * 1024, 37);
  for (let index = 0; index < 64; index++)
    await writeFile(join(f.external, `data-${String(index).padStart(3, "0")}`), large, { mode: 0o600 });
  const requestPath = join(f.root, "request.json");
  await writeFile(requestPath, JSON.stringify(f.request), { mode: 0o600 });
  const target = join(f.root, "release.json"), linkPath = join(f.external, "serving-release.json");
  await writeFile(target, "initial synthetic release", { mode: 0o600 });
  await symlink(target, linkPath);
  f.request.fileLinks = [{ path: linkPath, target }];
  await writeFile(requestPath, JSON.stringify(f.request), { mode: 0o600 });
  for (const mode of ["change", "link-target", "link-text", "interrupt"]) {
    const name = `${mode}-${randomUUID()}`, destination = join(privateRoot, name);
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", controller, "capture", requestPath, destination],
      { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const closed = once(child, "close");
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } });
    const stage = await waitForStage(name, "inventory.before.complete.json", child);
    if (mode !== "interrupt") {
      if (mode === "change") await writeFile(join(f.external, "data-000"), "changed source", { mode: 0o600 });
      if (mode === "link-target") await writeFile(target, "changed target", { mode: 0o600 });
      if (mode === "link-text") {
        await rm(linkPath);
        await symlink(join(f.root, "not-approved"), linkPath);
      }
      await closed;
      assert.equal(child.exitCode, 1, stderr);
      assert(["SOURCE_CHANGED", "NOT_QUIESCENT", "LINK_BINDING_MISMATCH"].includes(JSON.parse(stderr.trim()).code), stderr);
      assert.equal((await lstat(stage)).isDirectory(), true);
      if (mode === "link-text") { await rm(linkPath); await symlink(target, linkPath); }
    } else {
      child.kill("SIGKILL");
      await closed;
      assert.equal(child.signalCode, "SIGKILL");
    }
    await assert.rejects(lstat(destination), { code: "ENOENT" });
    await assert.rejects(verifyColdStateRecovery(stage, "0".repeat(64)), { code: "INCOMPLETE_CAPTURE" });
    await assert.rejects(lstat(join(stage, "capture.complete.json")), { code: "ENOENT" });
  }
});
