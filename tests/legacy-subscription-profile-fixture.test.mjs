import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, readFile, readdir, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import { legacySubscriptionProfileFixture as bridge } from "../dist/legacy-subscription-profile-fixture.js";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../legacy");
const testBase = process.env.PKM_SUBSCRIPTION_TEST_RAM_ROOT;
const fixtureSkip = testBase ? false : "requires a private project-local tmpfs fixture mount";
const require = createRequire(import.meta.url);
const digest = value => createHash("sha256").update(value).digest("hex");
async function originalManager() {
  const source = await readFile(join(project, "src/subscriptions/subscriptions.ts"), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const mocks = {
    "./subscription-mqtt-client": {},
    "../sync/sync-server": {
      emptySyncSelection: () => ({}),
      buildSyncBundle: () => ({ notes: [{ slug: "Fixture", content: "# Old protected share\n" }] }),
      attachMarkdownAssetsToSyncBundle: value => value,
    },
    "./subscription-ip-policy": { normalizeIpBlockRules: values => values },
    "../servers/servers": {},
    "../knowledge/content-privacy": { isContentItemPrivate: () => false },
    "../chatroom/chat-room-lock": {},
    "../runtime/cross-process-lock": { withCrossProcessLock: (_path, _label, _timeout, action) => action() },
    "../runtime/user-service-ports": { stableUserPort: () => 23000 },
    "../knowledge/markdown-assets": {},
  };
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, require: name => mocks[name] ?? require(name),
    Buffer, process, URL, setTimeout, clearTimeout, setInterval, clearInterval, console, __dirname: project };
  runInNewContext(output, sandbox);
  return module.exports.SharedMarketManager;
}
async function fixture(t) {
  const base = resolve(testBase);
  const rel = relative(project, base);
  assert(rel && !rel.startsWith("..") && await realpath(base) === base);
  assert.equal((await statfs(base)).type, 0x01021994, "synthetic legacy private keys must not be written to a disk-backed filesystem");
  const parent = join(base, `pkm-subscription-fixture-${randomUUID()}`);
  const root = join(parent, "knowledge"), profile = join(parent, "profile"), subscription = join(profile, "subscriptions");
  await mkdir(root, { recursive: true, mode: 0o700 });
  t.after(async () => { delete process.env.PKM_PRIVATE_SUBSCRIPTION_FIXTURE; await rm(parent, { recursive: true, force: true }); });
  await mkdir(join(root, "notes"), { mode: 0o700 });
  await writeFile(join(root, "notes", "Fixture.md"), "# Existing synthetic knowledge\n", { mode: 0o600 });
  await mkdir(subscription, { recursive: true, mode: 0o700 });
  await mkdir(join(parent, "t"), { mode: 0o700 });
  const secret = randomBytes(32).toString("base64url"), secrets = new Map();
  const Manager = await originalManager();
  const oldMask = process.umask(0o077);
  let share;
  try {
    const manager = new Manager(subscription, join(parent, "unused-gateway.js"), "Synthetic publisher", {}, {
      async get(key) { return secrets.get(key); },
      async store(key, value) { secrets.set(key, value); },
      async delete(key) { secrets.delete(key); },
    }, { user: "fixture", host: "fixture" });
    share = await manager.upsertShare({ name: "Synthetic share", protection: "secret-protected", secret,
      contentTypes: ["notes"], selected: { notes: ["Fixture"] }, controlPort: 23001 });
    // Generate an actual prior old revision with the same original manager.
    share = await manager.upsertShare({ shareId: share.shareId, name: "Synthetic share v2",
      protection: "secret-protected", contentTypes: ["notes"], selected: { notes: ["Fixture"] }, controlPort: 23001 });
  } finally { process.umask(oldMask); }
  assert.equal(share.revision, 2);
  assert.equal(secrets.get(`personalKnowledge.shareBroker.${share.shareId}.secret`), secret);
  const rootStat = await lstat(root), profileStat = await lstat(profile), nonce = randomUUID();
  await writeFile(join(parent, "subscription-fixture.json"), JSON.stringify({
    schema: "pkm.subscription-fixture/v1", nonce,
    rootPin: `${rootStat.dev}:${rootStat.ino}`, profilePin: `${profileStat.dev}:${profileStat.ino}`,
  }), { mode: 0o600 });
  process.env.PKM_PRIVATE_SUBSCRIPTION_FIXTURE = parent;
  const authority = {
    authorityId: "private-fixture-authority", epoch: "fixture-epoch-1",
    async authorize(binding) { return binding.root === root && binding.profile === profile && binding.shareId === share.shareId; },
    async secret() { return Buffer.from(secret); },
  };
  const options = { nonce, shareId: share.shareId, authority };
  return { parent, root, profile, subscription, share, secret, options };
}
async function tree(base) {
  const result = {};
  async function visit(path, prefix = "") {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name, target = join(path, entry.name);
      const stat = await lstat(target);
      result[name] = { ino: stat.ino, mode: stat.mode & 0o777, ...(entry.isFile() ? { sha256: digest(await readFile(target)) } : {}) };
      if (entry.isDirectory()) await visit(target, name);
    }
  }
  await visit(base);
  return result;
}
async function child(f, operation, crash = "") {
  const child = fork(join(project, "../tests/legacy-subscription-profile-fixture-child.mjs"), [], {
    cwd: project, env: { ...process.env, TMPDIR: join(f.parent, "t") }, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return await new Promise((resolveResult, reject) => {
    let response;
    child.on("message", message => {
      if (message.type === "secret-request") child.send({ secret: Buffer.from(f.secret).toString("base64") });
      else response = message;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveResult({ code, signal, response }));
    child.send({ root: f.root, nonce: f.options.nonce, shareId: f.share.shareId, operation, crash });
  });
}
test("original manager's protected current snapshot is associated and read across process restart", { timeout: 60000, skip: fixtureSkip }, async t => {
  const f = await fixture(t), before = await tree(f.profile), inode = (await lstat(f.root)).ino;
  const result = await bridge(f.root, { ...f.options, operation: "associate" });
  assert.equal(result.receipt.nodeId, JSON.parse(await readFile(join(f.subscription, "subscriptions.json"), "utf8")).nodeId);
  assert.equal(result.receipt.history.length, 1);
  assert.equal(result.receipt.history[0].status, "unverified");
  assert.deepEqual(await tree(f.profile), before);
  assert.equal((await lstat(f.root)).ino, inode);
  const reopened = await child(f, "read");
  assert.equal(reopened.code, 0);
  assert.equal(reopened.response.type, "result");
  assert.deepEqual(reopened.response.receipt, result.receipt);
  assert.equal(JSON.parse(reopened.response.payload).notes[0].content, "# Old protected share\n");
  assert.deepEqual(await tree(f.profile), before);
  assert.equal(await readFile(join(f.root, "notes", "Fixture.md"), "utf8"), "# Existing synthetic knowledge\n");
  const rootFiles = await readdir(f.root);
  const receipt = await readFile(join(f.root, rootFiles.find(name => name.startsWith(".pkm-next-subscription-"))), "utf8");
  const state = JSON.parse(await readFile(join(f.subscription, "subscriptions.json"), "utf8"));
  assert(!receipt.includes(f.secret));
  assert(!receipt.includes("PRIVATE KEY"));
  assert(!receipt.includes(state.shares[0].authVerifier));
});
test("wrong or missing secret and altered ciphertext do not create an association or mutate original state", { timeout: 60000, skip: fixtureSkip }, async t => {
  const f = await fixture(t), original = await tree(f.profile), initialRoot = await tree(f.root);
  for (const value of ["wrong-key", undefined]) {
    const authority = { ...f.options.authority, async secret() { return value ? Buffer.from(value) : undefined; } };
    await assert.rejects(bridge(f.root, { ...f.options, authority, operation: "associate" }), { code: "SNAPSHOT_DENIED" });
    assert.deepEqual(await tree(f.root), initialRoot);
    assert.deepEqual(await tree(f.profile), original);
  }
  const current = f.share.snapshotPath, originalBytes = await readFile(current), altered = Buffer.from(originalBytes);
  altered[25] ^= 1;
  await writeFile(current, altered);
  const damaged = await tree(f.profile);
  await assert.rejects(bridge(f.root, { ...f.options, operation: "associate" }), { code: "SNAPSHOT_DENIED" });
  assert.deepEqual(await tree(f.root), initialRoot);
  assert.deepEqual(await tree(f.profile), damaged);
});
test("changed publisher identity fails before writing", { timeout: 60000, skip: fixtureSkip }, async t => {
  const f = await fixture(t), originalRoot = await tree(f.root), path = join(f.subscription, "subscriptions.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  state.nodeId = "0".repeat(64);
  await writeFile(path, JSON.stringify(state));
  const damaged = await tree(f.profile);
  await assert.rejects(bridge(f.root, { ...f.options, operation: "associate" }), { code: "INVALID_STATE" });
  assert.deepEqual(await tree(f.root), originalRoot);
  assert.deepEqual(await tree(f.profile), damaged);
});
test("revoked authority rejects an otherwise valid share without writing", { timeout: 60000, skip: fixtureSkip }, async t => {
  const f = await fixture(t), rootBefore = await tree(f.root), profileBefore = await tree(f.profile);
  const authority = { ...f.options.authority, async authorize() { return false; } };
  await assert.rejects(bridge(f.root, { ...f.options, authority, operation: "associate" }), { code: "SNAPSHOT_DENIED" });
  assert.deepEqual(await tree(f.root), rootBefore);
  assert.deepEqual(await tree(f.profile), profileBefore);
});
test("changed original history cannot be silently associated with a committed receipt", { timeout: 60000, skip: fixtureSkip }, async t => {
  const f = await fixture(t);
  const associated = await bridge(f.root, { ...f.options, operation: "associate" });
  const old = join(f.subscription, "snapshots", associated.receipt.history[0].name);
  await writeFile(old, "unverified historical bytes changed");
  const rootBefore = await tree(f.root), profileBefore = await tree(f.profile);
  await assert.rejects(bridge(f.root, { ...f.options, operation: "read" }), { code: "RECOVERY_CONFLICT" });
  assert.deepEqual(await tree(f.root), rootBefore);
  assert.deepEqual(await tree(f.profile), profileBefore);
});
test("changed current ciphertext after association fails before writing", { timeout: 60000, skip: fixtureSkip }, async t => {
  const f = await fixture(t);
  await bridge(f.root, { ...f.options, operation: "associate" });
  const current = f.share.snapshotPath, damaged = Buffer.from(await readFile(current));
  damaged[25] ^= 1;
  await writeFile(current, damaged);
  const rootBefore = await tree(f.root), profileBefore = await tree(f.profile);
  await assert.rejects(bridge(f.root, { ...f.options, operation: "read" }), { code: "SNAPSHOT_DENIED" });
  assert.deepEqual(await tree(f.root), rootBefore);
  assert.deepEqual(await tree(f.profile), profileBefore);
});
test("crashed association is resumed after restart without changing original snapshot history", { timeout: 60000, skip: fixtureSkip }, async t => {
  for (const phase of ["pending-created", "pending-synced", "linked"]) {
    await t.test(phase, async t => {
      const f = await fixture(t), before = await tree(f.profile);
      assert.equal((await child(f, "associate", phase)).code, 77);
      const resumed = await child(f, "recover");
      assert.equal(resumed.code, 0);
      assert.equal(resumed.response.type, "result");
      const reopened = await child(f, "read");
      assert.equal(reopened.response.type, "result");
      assert.deepEqual(reopened.response.receipt, resumed.response.receipt);
      assert.deepEqual(await tree(f.profile), before);
      assert.equal((await readdir(f.root)).filter(name => name.startsWith(".pkm-next-subscription-")).length, 1);
    });
  }
});
test("recovery accepts only an exact partial receipt and preserves foreign pending bytes", { timeout: 60000, skip: fixtureSkip }, async t => {
  for (const corrupt of [false, true]) {
    await t.test(corrupt ? "foreign" : "partial", async t => {
      const f = await fixture(t), before = await tree(f.profile);
      assert.equal((await child(f, "associate", "pending-synced")).code, 77);
      const pending = join(f.root, (await readdir(f.root)).find(name => name.endsWith(".pending")));
      const original = await readFile(pending);
      await writeFile(pending, corrupt ? Buffer.from("foreign") : original.subarray(0, 17));
      const beforeRecovery = await tree(f.root), result = await child(f, "recover");
      if (corrupt) {
        assert.equal(result.response.code, "RECOVERY_CONFLICT");
        assert.deepEqual(await tree(f.root), beforeRecovery);
      } else {
        assert.equal(result.response.type, "result");
        assert.equal((await readdir(f.root)).filter(name => name.startsWith(".pkm-next-subscription-")).length, 1);
        assert.equal((await child(f, "read")).response.type, "result");
      }
      assert.deepEqual(await tree(f.profile), before);
    });
  }
});
test("a process matching extension-host arguments is never exempted", { timeout: 60000, skip: fixtureSkip }, async t => {
  const f = await fixture(t), before = await tree(f.profile), rootBefore = await tree(f.root);
  const active = spawn(process.execPath, ["-e", "process.stdin.resume()", "--", "--type=extensionHost"],
    { stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, TMPDIR: join(f.parent, "t") } });
  try {
    await new Promise((resolveReady, reject) => { active.once("spawn", resolveReady); active.once("error", reject); });
    await assert.rejects(bridge(f.root, { ...f.options, operation: "associate" }), { code: "LEGACY_WRITERS_ACTIVE" });
    assert.deepEqual(await tree(f.profile), before);
    assert.deepEqual(await tree(f.root), rootBefore);
  } finally {
    active.stdin.end();
    await new Promise(resolveExit => active.once("exit", resolveExit));
  }
});
test("a host starting during secret resolution blocks before association writes", { timeout: 60000, skip: fixtureSkip }, async t => {
  const f = await fixture(t), rootBefore = await tree(f.root), profileBefore = await tree(f.profile);
  let reads = 0, active;
  const authority = { ...f.options.authority, async secret() {
    if (++reads === 2) {
      active = spawn(process.execPath, ["-e", "process.stdin.resume()", "--", "--type=extensionHost"],
        { stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, TMPDIR: join(f.parent, "t") } });
      await new Promise((resolveReady, reject) => { active.once("spawn", resolveReady); active.once("error", reject); });
    }
    return Buffer.from(f.secret);
  } };
  try {
    await assert.rejects(bridge(f.root, { ...f.options, authority, operation: "associate" }), { code: "LEGACY_WRITERS_ACTIVE" });
    assert.equal(reads, 2);
    assert.deepEqual(await tree(f.root), rootBefore);
    assert.deepEqual(await tree(f.profile), profileBefore);
  } finally {
    if (active) {
      active.stdin.end();
      await new Promise(resolveExit => active.once("exit", resolveExit));
    }
  }
});
test("a detached legacy gateway bound to the profile blocks even without an open file", { timeout: 60000, skip: fixtureSkip }, async t => {
  const f = await fixture(t), rootBefore = await tree(f.root), profileBefore = await tree(f.profile);
  const active = spawn(process.execPath, ["-e", "process.stdin.resume()", "--",
    join(f.parent, "subscription-gateway.js"), join(f.subscription, "gateway-state.json")],
  { stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, TMPDIR: join(f.parent, "t") } });
  try {
    await new Promise((resolveReady, reject) => { active.once("spawn", resolveReady); active.once("error", reject); });
    await assert.rejects(bridge(f.root, { ...f.options, operation: "associate" }), { code: "LEGACY_WRITERS_ACTIVE" });
    assert.deepEqual(await tree(f.root), rootBefore);
    assert.deepEqual(await tree(f.profile), profileBefore);
  } finally {
    active.stdin.end();
    await new Promise(resolveExit => active.once("exit", resolveExit));
  }
});
