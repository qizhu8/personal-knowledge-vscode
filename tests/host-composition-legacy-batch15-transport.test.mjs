import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Core } from "../dist/core.js";
import { CoreError } from "../dist/contracts.js";
import { CoreError as SharedCoreError } from "../dist/host-composition-legacy-batch15-errors.js";
import { createWorkspaceBackup } from "../dist/workspace-backup.js";
import { fixture, transports, fixturePublisher, actor, hash, sourceBytes } from "./host-composition-legacy-batch15-captures.mjs";

test("original actual PKM Router writer -> Core HTTP/MCP filesystem install/remove, exact bytes, actor CAS and global immutable replay", async t => {
  const f = await fixture(t), io = await transports(t, f.runtime.core, actor), oracle = f.projectionOracle();
  const original = oracle.projection.injectPkmSkill(oracle.context, "fixture");
  const originalBytes = await readFile(original.skillPath);
  assert.equal(original.state, "current");
  const input = f.input(), result = await io.http("legacy.skill.router.inject", input);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.deepEqual(await f.bytes(), originalBytes);
  assert.equal(result.result.destinationSha256, hash(originalBytes));
  assert.deepEqual((await io.mcp("legacy.skill.router.inject", input)).result, result.result);
  assert.equal((await io.http("legacy.skill.router.inject", { ...input, sourceSha256: "0".repeat(64) })).error.code, "CONFLICT");
  const foreign = await transports(t, f.runtime.core, { ...actor, id: "foreign" });
  assert.equal((await foreign.mcp("legacy.skill.router.inject", input)).error.code, "NOT_AVAILABLE");
  for (const key of ["binding", "sourceRoot", "approved", "exclusiveOwnership", "fingerprint"])
    assert.equal((await io.http("legacy.skill.router.inject", { ...input, [key]: "forged" })).error.code, "INVALID_ARGUMENT");
  f.state.approved = false;
  assert.equal((await io.mcp("legacy.skill.router.inject", f.input())).error.code, "NOT_AVAILABLE");
  f.state.approved = true;
  const removal = f.input("remove");
  oracle.projection.removeInjectedPkmSkill(oracle.context, "fixture");
  const removed = await io.mcp("legacy.skill.router.remove", removal);
  assert.equal(removed.error, undefined, JSON.stringify(removed));
  assert.equal(removed.result.destinationSha256, null);
  await assert.rejects(f.bytes(), { code: "ENOENT" });
  assert.deepEqual(await readFile(join(f.root, "packages/target/unrelated.bin")), Buffer.from([0, 255, 17]));
  assert.deepEqual(await readFile(join(f.root, "packages/original/skills/System/PKM/PKM Skills.md")), sourceBytes);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM receipts WHERE operation LIKE 'legacy.skill.router.%'").get().n, 2);
  assert.throws(() => f.database.exec("UPDATE legacy_skill_native_receipt SET result_json='{}'"), /immutable/);
  await io.close(); await foreign.close(); await f.restart();
  const restarted = await transports(t, f.runtime.core, actor);
  assert.deepEqual((await restarted.http("legacy.skill.router.inject", input)).result, result.result);
  assert.deepEqual((await restarted.mcp("legacy.skill.router.remove", removal)).result, removed.result);
});

test("default denied actor catalog exports strict JSON schema and never advertises classification writers or serialized authority", async t => {
  const f = await fixture(t), plain = new Core(f.storage);
  assert.equal(CoreError, SharedCoreError);
  assert.equal((await plain.dispatch("capability_call", { operation: "legacy.skill.router.inject", version: 1, arguments: f.input() }, actor)).error.code, "NOT_AVAILABLE");
  for (const operation of ["legacy.skill.router.inject", "legacy.skill.router.remove", "knowledge.legacy-links.resolve", "knowledge.asset.ownership.validate"]) {
    const result = await f.runtime.core.dispatch("capabilities_describe", { operation }, actor);
    assert.equal(result.error, undefined);
    assert.equal(result.result.inputSchema.additionalProperties, false);
    assert.ok(result.result.outputSchema);
    assert.equal((await plain.dispatch("capabilities_describe", { operation }, actor)).error.code, "NOT_FOUND");
  }
  const catalog = await f.runtime.core.dispatch("capabilities_search", { query: "classification", offset: 0, limit: 20 }, actor);
  assert.equal(catalog.error, undefined, JSON.stringify(catalog));
  assert.equal(JSON.stringify(catalog.result).includes("classification.preview.validate"), false);
  const prior = (await f.runtime.core.dispatch("server_info", {}, actor)).result.catalogRevision;
  assert.equal((await f.runtime.core.dispatch("capabilities_search", { revision: "0".repeat(64), query: "", offset: 0, limit: 10 }, actor)).error.code, "CONFLICT");
  assert.equal((await f.runtime.core.dispatch("server_info", {}, actor)).result.catalogRevision, prior);
  f.state.owned = false;
  assert.equal((await f.runtime.core.dispatch("capabilities_describe", { operation: "legacy.skill.router.inject" }, actor)).error.code, "NOT_FOUND");
});

test("actual original Script/Project locators cross HTTP/MCP against native root-pinned actor inventory without source read writers", async t => {
  const f = await fixture(t), io = await transports(t, f.runtime.core, actor);
  const locatorOracle = f.original("src/knowledge/knowledge-locator.ts");
  for (const locator of [`pkm://script/${f.script.knowledgeId}`, `pkm://scripts/${f.script.path}`, `pkm://projects/${f.project.projectId}`]) {
    const result = await io.http("knowledge.legacy-links.resolve", { locator }, "capability_read");
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.deepEqual(result.result.resolved, locatorOracle.resolvePkmLocator(locator, f.inventory));
    assert.deepEqual((await io.mcp("knowledge.legacy-links.resolve", { locator, expectedPins: result.result.snapshotPins }, "capability_read")).result, result.result);
    assert.equal((await io.mcp("knowledge.legacy-links.resolve", { locator, snapshot: {} }, "capability_read")).error.code, "INVALID_ARGUMENT");
  }
  const locator = `pkm://scripts/${f.script.path}`;
  const before = (await io.http("knowledge.legacy-links.resolve", { locator }, "capability_read")).result;
  await writeFile(join(f.root, "packages/original/scripts", f.script.path), "changed source bytes\n");
  assert.equal((await io.mcp("knowledge.legacy-links.resolve", { locator, expectedPins: before.snapshotPins }, "capability_read")).error.code, "CONFLICT");
  f.assetPolicy.authorizeEntry = () => false;
  const hidden = await io.http("knowledge.legacy-links.resolve", { locator }, "capability_read");
  assert.ok(hidden.error, JSON.stringify(hidden));
  assert.equal((await io.http("knowledge.legacy-links.resolve", { locator: "https://not-resolved.invalid" }, "capability_read")).error.code, "CONFLICT");
});

test("real document asset revision, unique owner, hidden actor inventory and byte tamper are checked through Core HTTP/MCP", async t => {
  const f = await fixture(t), io = await transports(t, f.runtime.core, actor);
  const document = await io.http("knowledge.document.create", { operationId: randomUUID(), id: "owner", title: "Owner", content: "![owned](owner.assets/evidence.bin)" });
  assert.equal(document.error, undefined, JSON.stringify(document));
  await mkdir(join(f.root, "notes/owner.assets"));
  await writeFile(join(f.root, "notes/owner.assets/evidence.bin"), Buffer.from([255, 0, 17]));
  const page = (await io.mcp("knowledge.asset.list", { id: "owner", offset: 0, limit: 100 }, "capability_read")).result;
  const args = { path: page.items[0].path, expectedDocumentSha256: page.documentSha256, expectedAssetDigest: page.items[0].digest, expectedRevision: page.revision };
  const checked = await io.http("knowledge.asset.ownership.validate", args, "capability_read");
  assert.equal(checked.error, undefined, JSON.stringify(checked));
  assert.equal(checked.result.ownerId, "owner");
  assert.equal(checked.result.revision, page.revision);
  assert.equal((await io.mcp("knowledge.asset.ownership.validate", { ...args, expectedRevision: "0".repeat(64) }, "capability_read")).error.code, "CONFLICT");
  assert.equal((await io.http("knowledge.asset.ownership.validate", { ...args, snapshots: [] }, "capability_read")).error.code, "INVALID_ARGUMENT");
  await writeFile(join(f.root, "notes/owner.assets/evidence.bin"), "tampered");
  assert.equal((await io.mcp("knowledge.asset.ownership.validate", args, "capability_read")).error.code, "CONFLICT");
  await writeFile(join(f.root, "notes/owner.assets/evidence.bin"), Buffer.from([255, 0, 17]));
  const second = await io.http("knowledge.document.create", { operationId: randomUUID(), id: "other", title: "Other", content: "![same](owner.assets/evidence.bin)" });
  assert.equal(second.error, undefined);
  assert.equal((await io.mcp("knowledge.asset.ownership.validate", args, "capability_read")).error.code, "CONFLICT");
});

test("SQL commit failure after actual effect persists full intent, restart never writes, only identical native-approved request recovers", async t => {
  const f = await fixture(t), io = await transports(t, f.runtime.core, actor), input = f.input();
  f.database.exec("CREATE TRIGGER fixture_skill_commit_fault BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'fixture commit failed'); END;");
  const failed = await io.http("legacy.skill.router.inject", input);
  assert.equal(failed.error.effect, "unknown", JSON.stringify(failed));
  const bytes = await f.bytes();
  const intent = f.database.prepare("SELECT * FROM legacy_skill_native_intent").get();
  assert.equal(JSON.parse(intent.plan_json).afterContent, bytes.toString());
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM receipts").get().n, 0);
  await assert.rejects(createWorkspaceBackup(f.storage, join(f.parent, "after-effect-backup"), {
    async acquireQuiescence() { return { assertHeld() {}, release() {} }; },
  }, { nativePublishNoReplace: fixturePublisher(f.parent) }), { code: "PENDING_JOURNAL" });
  assert.equal((await f.runtime.core.dispatch("server_info", {}, actor)).error.code, "RECOVERY_REQUIRED");
  await assert.rejects(f.storage.request({ operation: "knowledge.document.list", args: { offset: 0, limit: 10 }, actorId: actor.id }), { code: "RECOVERY_REQUIRED" });
  await io.close(); await f.restart();
  assert.deepEqual(await f.bytes(), bytes);
  f.database.exec("DROP TRIGGER fixture_skill_commit_fault");
  const next = await transports(t, f.runtime.core, actor);
  assert.equal((await next.mcp("legacy.skill.router.inject", { ...input, operationId: randomUUID() })).error.code, "RECOVERY_REQUIRED");
  assert.equal((await next.http("legacy.skill.router.inject", { ...input, sourceSha256: "0".repeat(64) })).error.code, "CONFLICT");
  assert.equal((await next.mcp("legacy.skill.router.inject", input)).error.code, "ACCESS_DENIED");
  f.state.approved = false;
  const revoked = await next.http("legacy.skill.router.inject", input);
  assert.equal(revoked.error.code, "RECOVERY_AUTHORITY_REQUIRED");
  assert.equal(revoked.error.effect, "unknown");
  f.state.approved = true;
  f.state.retry = true;
  const recovered = await next.http("legacy.skill.router.inject", input);
  assert.equal(recovered.error, undefined, JSON.stringify(recovered));
  assert.deepEqual(await f.bytes(), bytes);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM legacy_skill_native_intent").get().n, 0);
  assert.deepEqual((await next.mcp("legacy.skill.router.inject", input)).result, recovered.result);
});

test("before-effect fault, unknown partial bytes and conflicting/unknown journals stay fenced without automatic apply", async t => {
  const f = await fixture(t), io = await transports(t, f.runtime.core, actor), input = f.input();
  f.state.stageFault = true;
  assert.equal((await io.http("legacy.skill.router.inject", input)).error.effect, "unknown");
  await assert.rejects(f.bytes(), { code: "ENOENT" });
  f.state.stageFault = false;
  await io.close(); await f.restart();
  await assert.rejects(f.bytes(), { code: "ENOENT" });
  await mkdir(join(f.root, "packages/target/pkm-skills"));
  await writeFile(join(f.root, "packages/target/pkm-skills/SKILL.md"), "partial external effect");
  f.state.retry = true;
  const next = await transports(t, f.runtime.core, actor);
  assert.equal((await next.http("legacy.skill.router.inject", input)).error.effect, "unknown");
  assert.equal((await f.bytes()).toString(), "partial external effect");
  await rm(join(f.root, "packages/target/pkm-skills"), { recursive: true });
  f.database.exec("CREATE TABLE legacy_fixture_unknown_intent (id TEXT); INSERT INTO legacy_fixture_unknown_intent VALUES('unknown');");
  assert.equal((await next.mcp("legacy.skill.router.inject", input)).error.code, "RECOVERY_CONFLICT");
  f.database.exec("DROP TABLE legacy_fixture_unknown_intent");
  const recovered = await next.mcp("legacy.skill.router.inject", input);
  assert.equal(recovered.error, undefined, JSON.stringify(recovered));
  assert.ok(await f.bytes());
});

test("actual original unmanaged/newer writer errors match native HTTP/MCP refusal before intent or effect", async t => {
  const f = await fixture(t), io = await transports(t, f.runtime.core, actor), oracle = f.projectionOracle();
  const original = oracle.projection.injectPkmSkill(oracle.context, "fixture");
  const projection = await readFile(original.skillPath, "utf8");
  await mkdir(join(f.root, "packages/target/pkm-skills"));
  for (const bytes of ["unmanaged user-owned content", projection.replace('"routerVersion":"2.0.0"', '"routerVersion":"9.0.0"')]) {
    await writeFile(original.skillPath, bytes);
    await writeFile(join(f.root, "packages/target/pkm-skills/SKILL.md"), bytes);
    assert.throws(() => oracle.projection.injectPkmSkill(oracle.context, "fixture"), /Refusing/);
    assert.equal((await io.http("legacy.skill.router.inject", f.input())).error.code, "CONFLICT");
    assert.equal((await f.bytes()).toString(), bytes);
    if (bytes.startsWith("unmanaged")) {
      assert.throws(() => oracle.projection.removeInjectedPkmSkill(oracle.context, "fixture"), /Refusing/);
      assert.equal((await io.mcp("legacy.skill.router.remove", f.input("remove"))).error.code, "CONFLICT");
    }
    assert.equal(f.database.prepare("SELECT COUNT(*) n FROM legacy_skill_native_intent").get().n, 0);
  }
});
