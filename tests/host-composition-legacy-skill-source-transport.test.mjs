import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, rmSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { Core } from "../dist/core.js";
import { CoreError } from "../dist/contracts.js";
import { scanNativeLegacySkillSourceAndTarget } from "../dist/legacy-skill-lifecycle-native.js";
import { legacySkillManifestHash } from "../dist/legacy-skill-lifecycle.js";
import { transports } from "./host-composition-legacy-shared-captures.mjs";
import { originalLoader } from "./host-composition-legacy-batch15-captures.mjs";

const repository = fileURLToPath(new URL("../legacy/", import.meta.url));
const tests = fileURLToPath(new URL("./", import.meta.url));
const digest = value => createHash("sha256").update(value).digest("hex");
const bundle = readFileSync(join(repository, "resources/pkm-skills-router.md"));
const legacy = readFileSync(join(repository, "tests/fixtures/pkm-skills-router-1.7.2.md"));
const actor = { id: "source-fixture-human", canWrite: true, collaborationKind: "human" };
const operation = "legacy.skill.source.install";
const removeOperation = "legacy.skill.source.remove";
const sourcePath = "System/PKM/PKM Skills.md";
const destinationPath = "pkm-skills/SKILL.md";
const snapshot = db => digest(JSON.stringify({
  intents: db.prepare("SELECT * FROM legacy_skill_source_native_intent ORDER BY singleton").all(),
  receipts: db.prepare("SELECT * FROM legacy_skill_source_native_receipt ORDER BY operation_id").all(),
  history: db.prepare("SELECT * FROM legacy_skill_source_native_history ORDER BY sequence").all(),
  adoptions: db.prepare("SELECT * FROM legacy_skill_source_native_adoption ORDER BY sequence").all(),
}));
function durable(path, value) {
  const temporary = `${path}.new`;
  const fd = openSync(temporary, "w", 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const parent = openSync(dirname(path), "r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

async function fixture(t, before = null, modified = null) {
  let storage, runtime, db;
  const parent = await mkdtemp(join(tests, ".source-transport-"));
  t.after(async () => { await close(); await rm(parent, { recursive: true, force: true }); });
  const root = await initialize(join(parent, "workspace"));
  const roots = { source: join(root, "packages/source"), destination: join(root, "packages/target") };
  for (const path of Object.values(roots)) mkdirSync(path, { recursive: true });
  if (before !== null) {
    mkdirSync(dirname(join(roots.source, sourcePath)), { recursive: true });
    writeFileSync(join(roots.source, sourcePath), before);
  }
  if (modified !== null) {
    mkdirSync(dirname(join(roots.destination, destinationPath)), { recursive: true });
    writeFileSync(join(roots.destination, destinationPath), modified);
  }
  writeFileSync(join(roots.destination, "unrelated.bin"), Buffer.from([255, 0, 17]));
  const workspaceId = JSON.parse(await readFile(join(root, ".pkm-next-workspace"), "utf8")).id;
  const binding = { workspaceId, actorId: actor.id, sourceRootId: "source", destinationRootId: "target",
    targetId: "fixture", targetKind: "custom", extensionVersion: "test" };
  const anchorPath = join(parent, "native-anchor"), approvalPath = join(parent, "native-approval");
  const state = { approved: true, retry: false, owned: true, fault: false, commitAnchorFault: false, commitAnchorThreshold: 0, advances: 0 };
  const policy = {
    scope: "exclusive-native-disposable-fixture",
    authorityForActor(who) {
      if (who.id !== actor.id || who.collaborationKind !== "human") return undefined;
      return {
        binding, roots, bundle, bundleSha256: digest(bundle), epoch: "fixture-epoch-1",
        assertOwner() {
          assert.equal(db?.isTransaction, false);
          if (!state.owned) throw new CoreError("ACCESS_DENIED", "Fixture ownership revoked.");
          if (state.fault && db?.prepare("SELECT 1 FROM legacy_skill_source_native_intent").get())
            throw new CoreError("RECOVERY_REQUIRED", "Injected poststage ownership failure.", "unknown");
        },
        authorize: selected => state.approved && selected.id === actor.id,
        approvePlan(selected, plan, pins, recovery) {
          assert.equal(db.isTransaction, false);
          if (!state.approved || selected.id !== actor.id || recovery && !state.retry) return false;
          if (!recovery) durable(approvalPath, JSON.stringify({ plan, pins }));
          else assert.deepEqual(JSON.parse(readFileSync(approvalPath, "utf8")), { plan, pins });
          return true;
        },
        approveRemovePlan(selected, plan, pins, recovery) {
          assert.equal(db.isTransaction, false);
          if (!state.approved || selected.id !== actor.id || recovery && !state.retry) return false;
          if (!recovery) durable(approvalPath, JSON.stringify({ plan, pins }));
          else assert.deepEqual(JSON.parse(readFileSync(approvalPath, "utf8")), { plan, pins });
          return true;
        },
        assertNoOtherPendingNative() { assert.equal(db.isTransaction, false); },
        assertNoOtherPendingSql(database) { assert.equal(database.isTransaction, true); },
        assertSqlOwner(database) { assert.equal(database.isTransaction, true); },
        checkAnchor(value) {
          assert.equal(db.isTransaction, false);
          if (readFileSync(anchorPath, "utf8") !== value)
            throw new CoreError("RECOVERY_REQUIRED", "Independent anchor differs.", "unknown");
        },
        advanceAnchor(beforeDigest, afterDigest) {
          assert.equal(db.isTransaction, false);
          assert.equal(readFileSync(anchorPath, "utf8"), beforeDigest);
          if (state.commitAnchorFault && db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_receipt").get().n > state.commitAnchorThreshold)
            throw new CoreError("RECOVERY_REQUIRED", "Injected postcommit anchor interruption.", "unknown");
          durable(anchorPath, afterDigest); state.advances++;
        },
        reconcileAnchor(value, selected, recovery) {
          assert.equal(db.isTransaction, false);
          if (!state.retry || selected.id !== actor.id)
            throw new CoreError("ACCESS_DENIED", "No exact native reconciliation approval.");
          assert.deepEqual(JSON.parse(readFileSync(approvalPath, "utf8")), { plan: recovery.plan, pins: recovery.pins });
          durable(anchorPath, value);
        },
        reconcileRemoveAnchor(value, selected, recovery) {
          assert.equal(db.isTransaction, false);
          if (!state.retry || selected.id !== actor.id)
            throw new CoreError("ACCESS_DENIED", "No exact native removal reconciliation approval.");
          assert.deepEqual(JSON.parse(readFileSync(approvalPath, "utf8")), { plan: recovery.plan, pins: recovery.pins });
          durable(anchorPath, value);
        },
        bundleForDigest: hash => hash === digest(bundle) ? bundle : undefined,
        globalReceipt() { throw new Error("Parent must compose the SQL receipt hook."); },
        writeGlobalReceipt() { throw new Error("Parent must compose the SQL receipt hook."); },
      };
    },
  };
  async function close() {
    db?.close(); db = undefined;
    await runtime?.close(); runtime = undefined;
    await storage?.close(); storage = undefined;
  }
  async function open() {
    storage = await Storage.open(root, { deferRecovery: true });
    db = storage.connectNative();
    try {
      runtime = await createNativeRuntime({ storage, skillSource: policy,
        batch15Skills: {
          scope: "exclusive-native-disposable-fixture",
          admissionForActor: who => who.id === actor.id ? { binding, sourceRelative: "packages/source", destinationRelative: "packages/target" } : undefined,
          assertFixtureOwnership() { if (!state.owned) throw new CoreError("ACCESS_DENIED", "Fixture ownership revoked."); },
          authorize: who => state.approved && who.id === actor.id,
          approveRetry: () => state.retry,
        },
      });
    }
    catch (error) { db.close(); db = undefined; await storage.close(); storage = undefined; throw error; }
  }
  storage = await Storage.open(root, { deferRecovery: true });
  db = storage.connectNative();
  durable(anchorPath, snapshot(db));
  db.close(); db = undefined; await storage.close(); storage = undefined;
  await open();
  return {
    root, parent, roots, state, policy,
    get runtime() { return runtime; }, get db() { return db; }, get storage() { return storage; },
    async restart() { await close(); await open(); },
    input() {
      const scan = scanNativeLegacySkillSourceAndTarget(db, () => {}, roots);
      return { operationId: randomUUID(), sourceSha256: scan.source === null ? null : digest(scan.source),
        bundleSha256: digest(bundle), sourceManifestSha256: legacySkillManifestHash(scan.sourceManifest),
        destinationSha256: scan.destination === null ? null : digest(scan.destination),
        destinationManifestSha256: legacySkillManifestHash(scan.destinationManifest) };
    },
    removeInput() {
      const { bundleSha256, ...input } = this.input();
      assert.ok(bundleSha256);
      return input;
    },
    oracle() {
      const store = join(parent, "oracle-store"), target = join(parent, "oracle-target");
      mkdirSync(target);
      if (before !== null) {
        mkdirSync(dirname(join(store, "skills", sourcePath)), { recursive: true });
        writeFileSync(join(store, "skills", sourcePath), before);
      }
      if (modified !== null) {
        mkdirSync(dirname(join(target, destinationPath)), { recursive: true });
        writeFileSync(join(target, destinationPath), modified);
      }
      const projection = originalLoader({ "../knowledge/filestore": { getStorePath: () => store }, vscode: {} })("src/skills/pkm-skill-projection.ts");
      const context = { extensionPath: repository, extension: { packageJSON: { version: "test" } },
        globalState: { get: (key, fallback) => key === "pkm.skillProjection.customTargets.v1"
          ? [{ id: "fixture", kind: "custom", label: "Fixture", root: target }] : fallback, update: async () => {} } };
      const result = projection.injectPkmSkill(context, "fixture");
      assert.equal(result.state, "current");
      return { source: readFileSync(join(store, "skills", sourcePath)), destination: readFileSync(join(target, destinationPath)) };
    },
  };
}

for (const [label, before] of [
  ["create", null], ["upgrade", legacy], ["preserve", Buffer.from("---\nname: Custom\n---\nNative custom source.\n")],
]) {
  test(`original actual writer -> Core HTTP/MCP canonical ${label}, exact projection and restart replay`, async t => {
    const modified = label === "upgrade"
      ? Buffer.from('---\nname: pkm-skills\n---\n<!-- pkm-managed {"schema":1,"routerVersion":"1.0.0"} -->\nModified managed target.\n') : null;
    const f = await fixture(t, before, modified), expected = f.oracle();
    const io = await transports(t, f.runtime.core, actor), input = f.input();
    const response = await io.http(operation, input);
    assert.equal(response.error, undefined, JSON.stringify(response));
    assert.deepEqual(readFileSync(join(f.roots.source, sourcePath)), expected.source);
    assert.deepEqual(readFileSync(join(f.roots.destination, destinationPath)), expected.destination);
    assert.deepEqual(readFileSync(join(f.roots.destination, "unrelated.bin")), Buffer.from([255, 0, 17]));
    assert.deepEqual((await io.mcp(operation, input)).result, response.result);
    assert.equal((await f.runtime.core.dispatch("server_info", {}, actor)).error, undefined);
    await assert.rejects(f.storage.request({ operation: "knowledge.document.create", actorId: actor.id,
      args: { operationId: randomUUID(), id: "unrelated", title: "Unrelated", content: "No unfenced effect" } }),
    { code: "RECOVERY_AUTHORITY_REQUIRED" });
    assert.throws(() => readFileSync(join(f.root, "notes/unrelated.md")), { code: "ENOENT" });
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM receipts WHERE operation=?").get(operation).n, 1);
    assert.throws(() => f.db.exec("UPDATE legacy_skill_source_native_history SET entry_sha256='forged'"), /immutable/);
    await io.close(); await f.restart();
    const restarted = await transports(t, f.runtime.core, actor);
    assert.deepEqual((await restarted.mcp(operation, input)).result, response.result);
    assert.equal((await restarted.http(operation, { ...input, operationId: randomUUID() })).error.code, "CONFLICT");
    f.state.approved = false;
    assert.ok((await restarted.http(operation, input)).error);
  });
}

test("source-pinned remove matches actual original writer for modified/newer managed projection, unmanaged rejection and missing no-op", async t => {
  const f = await fixture(t), io = await transports(t, f.runtime.core, actor);
  const installed = await io.http(operation, f.input());
  assert.equal(installed.error, undefined, JSON.stringify(installed));
  const originalTarget = await mkdtemp(join(f.parent, "remove-oracle-"));
  const projection = originalLoader({ "../knowledge/filestore": { getStorePath: () => join(f.parent, "oracle-store") }, vscode: {} })("src/skills/pkm-skill-projection.ts");
  const context = { extensionPath: repository, extension: { packageJSON: { version: "test" } },
    globalState: { get: (key, fallback) => key === "pkm.skillProjection.customTargets.v1"
      ? [{ id: "fixture", kind: "custom", label: "Fixture", root: originalTarget }] : fallback, update: async () => {} } };
  const actual = join(f.roots.destination, destinationPath), reference = join(originalTarget, destinationPath);
  mkdirSync(dirname(reference), { recursive: true });
  writeFileSync(join(dirname(reference), "asset"), "preserve");
  writeFileSync(join(dirname(actual), "asset"), "preserve");
  const unmanaged = Buffer.from("unmanaged content\n");
  writeFileSync(reference, unmanaged); writeFileSync(actual, unmanaged);
  assert.throws(() => projection.removeInjectedPkmSkill(context, "fixture"), /non-PKM/);
  assert.equal((await io.http(removeOperation, f.removeInput())).error.code, "CONFLICT");
  const newer = Buffer.from('---\nname: pkm-skills\n---\n<!-- pkm-managed {"schema":1,"routerVersion":"999.0.0"} -->\nmodified\n');
  writeFileSync(reference, newer); writeFileSync(actual, newer);
  assert.ok((await io.http(operation, f.input())).error);
  projection.removeInjectedPkmSkill(context, "fixture");
  const removed = await io.http(removeOperation, f.removeInput());
  assert.equal(removed.error, undefined, JSON.stringify(removed));
  assert.throws(() => readFileSync(actual), { code: "ENOENT" });
  assert.throws(() => readFileSync(reference), { code: "ENOENT" });
  assert.deepEqual(readFileSync(join(dirname(actual), "asset")), readFileSync(join(dirname(reference), "asset")));
  projection.removeInjectedPkmSkill(context, "fixture");
  const noop = await io.mcp(removeOperation, f.removeInput());
  assert.equal(noop.error, undefined, JSON.stringify(noop));
  assert.equal(readFileSync(join(dirname(actual), "asset"), "utf8"), "preserve");
  rmSync(join(dirname(reference), "asset")); rmSync(join(dirname(actual), "asset"));
  projection.removeInjectedPkmSkill(context, "fixture");
  assert.equal((await io.mcp(removeOperation, f.removeInput())).error, undefined);
  assert.equal(statSync(dirname(actual)).isDirectory(), statSync(dirname(reference)).isDirectory());
  assert.deepEqual(readFileSync(join(f.roots.source, sourcePath)), bundle);
});

test("source remove pending and postcommit failures require exact approved same-epoch retries across restart", async t => {
  const f = await fixture(t), io = await transports(t, f.runtime.core, actor);
  const installed = await io.http(operation, f.input());
  assert.equal(installed.error, undefined, JSON.stringify(installed));
  const request = f.removeInput();
  f.state.fault = true;
  assert.ok((await io.http(removeOperation, request)).error);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_intent").get().n, 1);
  f.state.fault = false;
  assert.equal((await io.http(operation, f.input())).error.code, "RECOVERY_REQUIRED");
  await io.close(); await f.restart();
  const resumed = await transports(t, f.runtime.core, actor);
  assert.ok((await resumed.http(removeOperation, request)).error);
  f.state.retry = true;
  const removed = await resumed.mcp(removeOperation, request);
  assert.equal(removed.error, undefined, JSON.stringify(removed));
  const next = await resumed.http(operation, f.input());
  assert.equal(next.error, undefined, JSON.stringify(next));
  const secondRequest = f.removeInput();
  f.state.commitAnchorThreshold = 3;
  f.state.commitAnchorFault = true;
  assert.ok((await resumed.http(removeOperation, secondRequest)).error);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_intent").get().n, 0);
  f.state.commitAnchorFault = false; f.state.retry = false;
  await resumed.close(); await f.restart();
  const last = await transports(t, f.runtime.core, actor);
  assert.ok((await last.http(removeOperation, secondRequest)).error);
  f.state.retry = true;
  const recovered = await last.mcp(removeOperation, secondRequest);
  assert.equal(recovered.error, undefined, JSON.stringify(recovered));
  assert.equal(recovered.result.destinationSha256, null);
});

test("remove global receipt identity and fingerprint tampering deny read and retry", async t => {
  const f = await fixture(t), io = await transports(t, f.runtime.core, actor);
  assert.equal((await io.http(operation, f.input())).error, undefined);
  const input = f.removeInput(), removed = await io.http(removeOperation, input);
  assert.equal(removed.error, undefined, JSON.stringify(removed));
  const row = f.db.prepare("SELECT actor_id,operation,fingerprint FROM receipts WHERE operation_id=?").get(input.operationId);
  for (const [field, value] of [["actor_id", "forged"], ["operation", operation], ["fingerprint", "0".repeat(64)]]) {
    f.db.prepare(`UPDATE receipts SET ${field}=? WHERE operation_id=?`).run(value, input.operationId);
    assert.ok((await io.http(removeOperation, input)).error);
    assert.ok((await f.runtime.core.dispatch("server_info", {}, actor)).error);
    f.db.prepare(`UPDATE receipts SET ${field}=? WHERE operation_id=?`).run(row[field], input.operationId);
  }
  assert.deepEqual((await io.mcp(removeOperation, input)).result, removed.result);
});

test("source catalog default-deny and rejects serialized authority and unmanaged target before source effects", async t => {
  const f = await fixture(t, null, Buffer.from("Unmanaged target\n")), io = await transports(t, f.runtime.core, actor);
  const input = f.input();
  const description = await f.runtime.core.dispatch("capabilities_describe", { operation }, actor);
  assert.equal(description.error, undefined);
  assert.equal(description.result.inputSchema.additionalProperties, false);
  const plain = new Core(f.storage);
  assert.equal((await plain.dispatch("capability_call", { operation, version: 1, arguments: input }, actor)).error.code, "NOT_AVAILABLE");
  const removeDescription = await f.runtime.core.dispatch("capabilities_describe", { operation: removeOperation }, actor);
  assert.equal(removeDescription.error, undefined);
  assert.equal(removeDescription.result.inputSchema.additionalProperties, false);
  const removeInput = { ...input, sourceSha256: "0".repeat(64) };
  delete removeInput.bundleSha256;
  assert.equal((await plain.dispatch("capability_call", { operation: removeOperation, version: 1, arguments: removeInput }, actor)).error.code, "NOT_AVAILABLE");
  assert.equal((await io.http(removeOperation, { ...removeInput, approval: true })).error.code, "INVALID_ARGUMENT");
  for (const key of ["approved", "roots", "binding", "epoch", "anchor"])
    assert.equal((await io.http(operation, { ...input, [key]: "forged" })).error.code, "INVALID_ARGUMENT");
  const denied = await io.mcp(operation, input);
  assert.equal(denied.error.code, "CONFLICT");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_intent").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM receipts WHERE operation=?").get(operation).n, 0);
  assert.throws(() => readFileSync(join(f.roots.source, sourcePath)), { code: "ENOENT" });
});

test("pending canonical source blocks unrelated requests and requires identical explicit native-approved retry across restart", async t => {
  const f = await fixture(t), io = await transports(t, f.runtime.core, actor), input = f.input();
  f.state.fault = true;
  const interrupted = await io.http(operation, input);
  assert.ok(interrupted.error);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_intent").get().n, 1);
  assert.equal((await f.runtime.core.dispatch("capabilities_list", { offset: 0, limit: 10 }, actor)).error.code, "RECOVERY_REQUIRED");
  assert.equal((await io.mcp(operation, { ...input, operationId: randomUUID() })).error.code, "RECOVERY_REQUIRED");
  f.state.fault = false;
  await io.close(); await f.restart();
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_intent").get().n, 1);
  const resumed = await transports(t, f.runtime.core, actor);
  assert.ok((await resumed.http(operation, input)).error);
  f.state.retry = true;
  const result = await resumed.mcp(operation, input);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.deepEqual(readFileSync(join(f.roots.source, sourcePath)), bundle);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_intent").get().n, 0);
});

test("committed source with interrupted independent anchor stays fenced until exact native reconciliation", async t => {
  const f = await fixture(t), io = await transports(t, f.runtime.core, actor), input = f.input();
  f.state.commitAnchorFault = true;
  assert.ok((await io.http(operation, input)).error);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_intent").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_receipt").get().n, 1);
  assert.equal((await f.runtime.core.dispatch("server_info", {}, actor)).error.code, "RECOVERY_REQUIRED");
  f.state.commitAnchorFault = false;
  assert.ok((await io.mcp(operation, input)).error);
  f.state.retry = true;
  const recovered = await io.http(operation, input);
  assert.equal(recovered.error, undefined, JSON.stringify(recovered));
  assert.equal((await f.runtime.core.dispatch("server_info", {}, actor)).error, undefined);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM receipts WHERE operation=?").get(operation).n, 1);
});

test("current destination and every global source receipt are verified without blocking approved modified-managed replacement", async t => {
  const f = await fixture(t), io = await transports(t, f.runtime.core, actor), input = f.input();
  const installed = await io.http(operation, input);
  assert.equal(installed.error, undefined);
  const target = join(f.roots.destination, destinationPath), original = readFileSync(target);
  writeFileSync(target, Buffer.concat([original, Buffer.from("\nNative-approved modification.\n")]));
  assert.equal((await f.runtime.core.dispatch("server_info", {}, actor)).error.code, "CONFLICT");
  assert.ok((await io.mcp(operation, input)).error);
  const updated = await io.http(operation, f.input());
  assert.equal(updated.error, undefined, JSON.stringify(updated));
  assert.deepEqual(readFileSync(target), original);
  f.db.prepare("UPDATE receipts SET operation='knowledge.document.create' WHERE operation_id=?").run(input.operationId);
  assert.equal((await f.runtime.core.dispatch("server_info", {}, actor)).error.code, "RECOVERY_CONFLICT");
  const current = f.input();
  assert.equal((await io.mcp(operation, current)).error.code, "RECOVERY_CONFLICT");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_intent").get().n, 0);
});

test("source and old projection effects cannot interleave without an independently authorized shared version lineage", async t => {
  const before = Buffer.from("---\nname: Custom\n---\nLegacy source.\n");
  const f = await fixture(t, before), io = await transports(t, f.runtime.core, actor);
  const input = f.input();
  const old = { operationId: randomUUID(), action: "inject", sourceSha256: input.sourceSha256,
    destinationSha256: input.destinationSha256, manifestSha256: input.destinationManifestSha256 };
  assert.equal((await io.http("legacy.skill.router.inject", old)).error, undefined);
  assert.equal((await io.mcp(operation, f.input())).error.code, "NOT_AVAILABLE");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_intent").get().n, 0);
  const g = await fixture(t);
  const other = await transports(t, g.runtime.core, actor);
  assert.equal((await other.http(operation, g.input())).error, undefined);
  const current = g.input();
  assert.equal((await other.mcp("legacy.skill.router.remove", { operationId: randomUUID(), action: "remove",
    sourceSha256: current.sourceSha256, destinationSha256: current.destinationSha256,
    manifestSha256: current.destinationManifestSha256 })).error.code, "NOT_AVAILABLE");
});

test("schema23 startup rejects missing source immutability DDL rather than reinstalling it", async t => {
  const f = await fixture(t);
  const trigger = f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='legacy_skill_source_native_history' ORDER BY name").get();
  assert.ok(trigger);
  const name = String(trigger.name);
  f.db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  await assert.rejects(f.restart(), /schema|journal|DDL/i);
  const current = new DatabaseSync(join(f.root, "core.sqlite"), { readOnly: true });
  try {
    assert.equal(current.prepare("PRAGMA user_version").get().user_version, 23);
    assert.equal(current.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name), undefined);
  } finally { current.close(); }
});
