import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import ts from "typescript";
import { planLegacyStateImport, stageLegacyStateImport, verifyLegacyStateImport, readImportedEncryptedSnapshot } from "../dist/legacy-state-import.js";
import { initialize, Storage } from "../dist/storage.js";
import { Core } from "../dist/core.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { snapshotFixture, snapshotId, magicCode } from "./agent-snapshot-reads-fixtures.mjs";
import { subscriptionReadSourceFiles } from "./subscription-reads-fixtures.mjs";
import { originalProjection } from "./agent-snapshot-reads-original.mjs";

async function fixture(t) {
  const root = resolve(`.legacy-state-import-test-${randomUUID()}`);
  const source = join(root, "original"), subscription = join(root, "global-storage-subscriptions");
  const stage = join(root, "stage");
  await mkdir(source, { recursive: true });
  await mkdir(subscription);
  await initialize(stage);
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, value) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
  };
  const snapshot = join(source, ".pkm/state/agent-snapshots", `${snapshotId}.json`);
  return { root, source, subscription, stage, snapshot, put };
}
const actor = { id: "local:owner", canWrite: false };
async function originalWriter(testKey) {
  const require = createRequire(import.meta.url);
  let original = await readFile(new URL("../legacy/src/agent-sessions/agent-snapshots.ts", import.meta.url), "utf8");
  if (testKey) {
    const originalKey = 'createHash("sha256").update("uone", "utf8").digest()';
    assert.equal(original.split(originalKey).length, 2);
    original = original.replace(originalKey, `Buffer.from("${testKey.toString("hex")}", "hex")`);
  }
  const code = ts.transpileModule(original, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} };
  const originalRequire = name => name === "../chat/chat-history-storage" ? {} : require(name);
  runInThisContext(`(function(require,module,exports){${code}\n})`)(originalRequire, mod, mod.exports);
  return mod.exports;
}
async function read(core, operation, args = {}) {
  const result = await core.dispatch("capability_read", { operation, version: 1, arguments: args }, actor);
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  return result.result;
}

test("plaintext Snapshot and credential-free subscription read models survive native backup and restore", async t => {
  const f = await fixture(t);
  const raw = JSON.stringify(snapshotFixture(), null, 2) + "\n";
  await f.put(f.snapshot, raw);
  for (const [name, value] of Object.entries(subscriptionReadSourceFiles)) await f.put(join(f.subscription, name), value);
  const plan = await planLegacyStateImport(f.source, f.subscription);
  await stageLegacyStateImport(plan, f.stage);
  assert.equal(await readFile(f.snapshot, "utf8"), raw);
  assert.equal(await readFile(join(f.stage, "agent-snapshot-reads/.pkm/state/agent-snapshots", `${snapshotId}.json`), "utf8"), raw);
  const storage = await Storage.open(f.stage);
  const backup = join(f.root, "backup"), restoredPath = join(f.root, "restored");
  try {
    const core = new Core(storage);
    assert.equal((await read(core, "agent.snapshot.list")).total, 1);
    assert.equal((await read(core, "agent.snapshot.get", { snapshotId })).snapshot.snapshotId, snapshotId);
    assert.equal((await read(core, "agent.snapshot.read", { magic_code: magicCode })).todos[0].todoId, "todo_fixture");
    assert.equal((await read(core, "subscription.list")).total, 1);
    assert.equal((await read(core, "subscription.get", { id: "fixture-sub" })).subscription.id, "fixture-sub");
    const acl = await read(core, "subscription.acl.evaluate", { shareId: "fixture-share", action: "download", sourceIp: "192.0.2.10" });
    assert.equal(acl.evaluationOnly, true);
    let held = false;
    await createWorkspaceBackup(storage, backup, { acquireQuiescence: async () => {
      held = true;
      return { assertHeld: () => assert.equal(held, true), release: () => { held = false; } };
    } });
  } finally { await storage.close(); }
  await restoreWorkspaceBackup(backup, restoredPath, { nativeRestoreAuthority });
  const restored = await Storage.open(restoredPath);
  try {
    const core = new Core(restored);
    assert.equal((await read(core, "agent.snapshot.get", { snapshotId })).snapshot.snapshotId, snapshotId);
    assert.equal((await read(core, "subscription.get", { id: "fixture-sub" })).subscription.id, "fixture-sub");
  } finally { await restored.close(); }
});

test("actual original encrypted writer and subscription private keys are blocked before staging", async t => {
  const f = await fixture(t);
  const { createAgentSnapshot } = await originalWriter();
  await f.put(join(f.source, ".pkm/state/agent-sessions/agent_session_source.json"), {
    schema: "pkm.agent.session/v1", sessionId: "agent_session_source", task: "synthetic",
    hostKind: "pkm", todos: [], checkpoints: [],
  });
  createAgentSnapshot(f.source, "agent_session_source");
  await assert.rejects(planLegacyStateImport(f.source), error => error.code === "KEY_AUTHORITY_REQUIRED");
  await rm(join(f.source, ".pkm/state/agent-snapshots"), { recursive: true });
  await f.put(join(f.subscription, "subscriptions.json"), {
    ...subscriptionReadSourceFiles["subscriptions.json"], privateKey: "synthetic-private-key",
  });
  await assert.rejects(planLegacyStateImport(f.source, f.subscription), error => error.code === "SECRET");
  assert.deepEqual((await readdir(f.stage)).sort(), [".pkm-next-workspace", "notes"]);
});

test("original authenticated encrypted capture stays opaque and native authority reads survive backup restore", async t => {
    const f = await fixture(t);
    const syntheticKey = randomBytes(32);
    const original = await originalWriter(syntheticKey);
    const input = snapshotFixture().payload.session;
    input.sessionId = "agent_session_source";
    input.recipeRunIds = ["recipe_run_fixture"];
    const sessionFile = join(f.source, ".pkm/state/agent-sessions/agent_session_source.json");
    await f.put(sessionFile, input);
    await f.put(join(f.source, ".pkm/state/recipe-runs/recipe_run_fixture.json"), snapshotFixture().payload.recipeRuns[0]);
    const created = original.createAgentSnapshot(f.source, "agent_session_source");
    const id = created.snapshot.snapshotId;
    const code = created.snapshot.magicCode;
    const source = join(dirname(f.snapshot), `${id}.json`);
    const sourceBytes = await readFile(source);
    const payload = original.readAgentSnapshotContents(f.source, id);
    await rm(sessionFile);
    let epoch = "synthetic-epoch-1", grant = true;
    const authority = {
      epoch: async () => grant ? epoch : undefined,
      key: async (algorithm, requested) => algorithm === "A256GCM-PKM-LOCAL-OBFUSCATION/v1" && requested === epoch && grant
        ? Buffer.from(syntheticKey) : undefined,
    };
    await assert.rejects(planLegacyStateImport(f.source), error => error.code === "KEY_AUTHORITY_REQUIRED");
    const plan = await planLegacyStateImport(f.source, undefined, authority);
    await stageLegacyStateImport(plan, f.stage, authority);
    const target = join(f.stage, "agent-snapshot-reads/.pkm/state/agent-snapshots", `${id}.json`);
    assert.deepEqual(await readFile(source), sourceBytes);
    assert.deepEqual(await readFile(target), sourceBytes);
    const request = { actorId: "local:owner", args: { magic_code: code, recent_messages: 1 } };
    const result = await readImportedEncryptedSnapshot(plan, f.stage, request, authority);
    await assert.rejects(readImportedEncryptedSnapshot(plan, f.stage, { ...request, actorId: "" }, authority),
      error => error.code === "FORBIDDEN");
    await assert.rejects(readImportedEncryptedSnapshot(plan, f.stage, { ...request, args: {
      magic_code: code, snapshotRevision: "f".repeat(64),
    } }, authority), error => error.code === "STAGE_CHANGED");
    await assert.rejects(readImportedEncryptedSnapshot(plan, f.stage, request, {
      ...authority, key: async () => { throw new Error("DO-NOT-LEAK"); },
    }), error => error.code === "KEY_AUTHORITY_REQUIRED" && !error.message.includes("DO-NOT-LEAK"));
    const oracle = spawnSync("python3", ["-c", `${originalProjection}
import json, sys
item = json.load(sys.stdin)
print(json.dumps(_snapshot_read_projection(item["snapshot"], item["payload"], 1)))
`], { input: JSON.stringify({ snapshot: JSON.parse(sourceBytes), payload }), encoding: "utf8" });
    assert.equal(oracle.status, 0, oracle.stderr);
    const expected = JSON.parse(oracle.stdout);
    const { snapshotRevision, adapters, ...projection } = structuredClone(result);
    assert.match(snapshotRevision, /^[a-f0-9]{64}$/);
    assert.equal(adapters.restore, "unavailable");
    delete projection.snapshot.name;
    assert.deepEqual(projection, expected);
    const storage = await Storage.open(f.stage);
    const backup = join(f.root, "backup"), restoredPath = join(f.root, "restored");
    try {
      const core = new Core(storage);
      assert.equal((await read(core, "agent.snapshot.get", { snapshotId: id })).snapshot.snapshotId, id);
      const unsupported = await core.dispatch("capability_read", { operation: "agent.snapshot.read", version: 1,
        arguments: { magic_code: code } }, actor);
      assert.equal(unsupported.error.code, "ADAPTER_UNAVAILABLE");
      let held = false;
      await createWorkspaceBackup(storage, backup, { acquireQuiescence: async () => {
        held = true;
        return { assertHeld: () => assert.equal(held, true), release: () => { held = false; } };
      } });
    } finally { await storage.close(); }
    await restoreWorkspaceBackup(backup, restoredPath, { nativeRestoreAuthority });
    assert.deepEqual(await readFile(join(restoredPath, "agent-snapshot-reads/.pkm/state/agent-snapshots", `${id}.json`)), sourceBytes);
    assert.deepEqual(await readImportedEncryptedSnapshot(plan, restoredPath, request, authority), result);
    epoch = "synthetic-epoch-2";
    await assert.rejects(readImportedEncryptedSnapshot(plan, restoredPath, request, authority), error => error.code === "KEY_AUTHORITY_REQUIRED");
    epoch = "synthetic-epoch-1"; grant = false;
    await assert.rejects(verifyLegacyStateImport(plan, f.stage, authority), error => error.code === "KEY_AUTHORITY_REQUIRED");
    grant = true;
    const wrong = { ...authority, key: async () => randomBytes(32) };
    await assert.rejects(planLegacyStateImport(f.source, undefined, wrong), error => error.code === "INVALID_STATE");
    const unknown = JSON.parse(sourceBytes); unknown.payload.algorithm = "A256GCM-UNKNOWN/v1";
    await f.put(source, unknown);
    await assert.rejects(planLegacyStateImport(f.source, undefined, authority), error => error.code === "UNKNOWN_STATE");
    const damaged = JSON.parse(sourceBytes); damaged.payload.ciphertext = `${damaged.payload.ciphertext[0] === "A" ? "B" : "A"}${damaged.payload.ciphertext.slice(1)}`;
    await f.put(source, damaged);
    await assert.rejects(planLegacyStateImport(f.source, undefined, authority), error => error.code === "INVALID_STATE");
    await writeFile(source, sourceBytes);
    const revokedMidRead = { epoch: async () => epoch, key: async () => { epoch = "revoked"; return Buffer.from(syntheticKey); } };
    await assert.rejects(readImportedEncryptedSnapshot(plan, restoredPath, request, revokedMidRead), error => error.code === "KEY_AUTHORITY_REQUIRED");
    syntheticKey.fill(0);
});

test("source tampering, links, unknown files, and duplicate Magic Codes fail closed", async t => {
  const f = await fixture(t);
  await f.put(f.snapshot, snapshotFixture());
  const plan = await planLegacyStateImport(f.source);
  const modified = snapshotFixture(); modified.task = "changed";
  await f.put(f.snapshot, modified);
  await assert.rejects(stageLegacyStateImport(plan, f.stage), error => error.code === "SOURCE_CHANGED");
  await f.put(f.snapshot, snapshotFixture());
  const duplicate = snapshotFixture(); duplicate.snapshotId = "agent_snapshot_duplicate";
  await f.put(join(dirname(f.snapshot), `${duplicate.snapshotId}.json`), duplicate);
  await assert.rejects(planLegacyStateImport(f.source), error => error.code === "INVALID_STATE");
  assert.equal(await readFile(f.snapshot, "utf8").then(JSON.parse).then(x => x.task), snapshotFixture().task);
  await rm(join(dirname(f.snapshot), `${duplicate.snapshotId}.json`));
  await f.put(join(dirname(f.snapshot), "pending.tmp"), "{}");
  await assert.rejects(planLegacyStateImport(f.source), error => error.code === "UNKNOWN_STATE");
  await rm(join(dirname(f.snapshot), "pending.tmp"));
  await symlink(f.snapshot, join(dirname(f.snapshot), "agent_snapshot_link.json"));
  await assert.rejects(planLegacyStateImport(f.source), error => error.code === "UNSAFE_SOURCE");
});

test("recovery history, in-flight subscriptions, and existing stage files are not omitted or overwritten", async t => {
  const f = await fixture(t);
  await f.put(f.snapshot, snapshotFixture());
  const sessions = join(f.source, ".pkm/state/agent-sessions/agent_session_recovered.json");
  await f.put(sessions, { schema: "pkm.agent.session/v1", sessionId: "agent_session_recovered",
    provenance: { snapshotId } });
  await assert.rejects(planLegacyStateImport(f.source), error => error.code === "UNKNOWN_STATE");
  await rm(sessions);
  const state = structuredClone(subscriptionReadSourceFiles["subscriptions.json"]);
  state.subscriptions[0].status = "updating";
  await f.put(join(f.subscription, "subscriptions.json"), state);
  await assert.rejects(planLegacyStateImport(f.source, f.subscription), error => error.code === "UNKNOWN_STATE");
  const plan = await planLegacyStateImport(f.source);
  const target = join(f.stage, "agent-snapshot-reads/.pkm/state/agent-snapshots", `${snapshotId}.json`);
  await f.put(target, "untouched");
  await assert.rejects(stageLegacyStateImport(plan, f.stage));
  assert.equal(await readFile(target, "utf8"), "untouched");
});

test("final stage verification catches tampering and unrecognized state", async t => {
  const f = await fixture(t);
  await f.put(f.snapshot, snapshotFixture());
  const plan = await planLegacyStateImport(f.source);
  await stageLegacyStateImport(plan, f.stage);
  const target = join(f.stage, "agent-snapshot-reads/.pkm/state/agent-snapshots", `${snapshotId}.json`);
  const original = await readFile(target);
  await writeFile(target, `${original} `);
  await assert.rejects(verifyLegacyStateImport(plan, f.stage), error => error.code === "STAGE_CHANGED");
  await writeFile(target, original);
  await f.put(join(dirname(target), "pending.tmp"), "{}");
  await assert.rejects(verifyLegacyStateImport(plan, f.stage), error => error.code === "UNKNOWN_STATE");
});
