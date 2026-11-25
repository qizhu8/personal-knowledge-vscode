import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import childProcess from "node:child_process";
import fs from "node:fs";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { legacyKnowledgeWrite } from "../dist/legacy-knowledge-write.js";
import { scanMarkdown } from "../dist/markdown.js";
import {
  knowledgeMutationScanRevision, planKnowledgeMutation, serializeKnowledgeMutationPlan, deserializeKnowledgeMutationPlan,
  assertKnowledgeMutationRequestPlan,
} from "../dist/knowledge-mutations.js";
import { originalKnowledgeWriterFixture, seedOriginalLegacyKnowledge, moveOriginalKnowledge } from "./original-knowledge-writer-fixture.mjs";

const actor = { id: "mcp:external", canWrite: true }, hash = bytes => createHash("sha256").update(bytes).digest("hex");
const areas = { note: "notes", skill: "skills", paper: "papers" };
const sources = [["a.PNG", Buffer.from([255, 0, 128, 9])], ["b.BIN", Buffer.from([1, 2, 3, 4, 5])]];
async function snapshot(root) {
  const result = [];
  async function walk(directory, prefix) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), member = `${prefix}/${name}`, stat = await fs.promises.lstat(path);
      if (stat.isDirectory()) await walk(path, member);
      else result.push([member, hash(await readFile(path))]);
    }
  }
  for (const area of Object.values(areas)) await walk(join(root, area), area);
  return result;
}
function journal(root) {
  const database = new DatabaseSync(join(root, "core.sqlite"), { readOnly: true });
  try { return { intents: database.prepare("SELECT * FROM migration_runtime_intents").all(),
    receipts: database.prepare("SELECT * FROM receipts WHERE operation GLOB 'knowledge.*.update'").all() }; }
  finally { database.close(); }
}
function commitment(root, operationId) {
  const database = new DatabaseSync(join(root, "core.sqlite"), { readOnly: true });
  try { return { ...database.prepare("SELECT * FROM migration_runtime_knowledge_commits WHERE operation_id=?").get(operationId) }; }
  finally { database.close(); }
}
async function sourceIdentity(path) {
  const stat = await fs.promises.lstat(path, { bigint: true });
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs];
}
async function fixture(t, options = {}) {
  assert(process.env.PKM_TEST_WORKSPACE, "Use the real private Linux test framework.");
  const directory = resolve("tests", `.legacy-assets-move-${randomUUID()}`), root = join(directory, "root");
  await mkdir(root, { recursive: true, mode: 0o700 });
  let opened, full;
  const close = async () => { if (opened) { const value = opened; opened = undefined; full = undefined; await value.owner.close(); } };
  t.after(async () => { try { await close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  const original = originalKnowledgeWriterFixture(directory), rows = original.run(root, seedOriginalLegacyKnowledge, options);
  const oracle = join(directory, "oracle"); await cp(root, oracle, { recursive: true });
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"),
    operatorId: "original-legacy-assets-fixture", profileSha256: hash("legacy-assets-source-only"),
    limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16_777_216, maxFileBytes: 1_048_576 } });
  const reopen = async () => { opened = await openOriginalMcpRoot(plan); full = await opened.owner.ensureFull(); };
  await reopen();
  const content = kind => rows[kind].content.replace("Original legacy body", "Changed legacy body");
  const request = kind => ({ tool: `update_${kind}`, arguments: {
    [kind === "skill" ? "name" : "slug"]: kind === "skill" ? "Before" : "Old/Before",
    ...(kind === "skill" ? {} : { title: "After" }), category: "New", content: content(kind),
  } });
  const pin = (kind, extra = {}) => {
    const documents = scanMarkdown(root), source = documents.find(item => item.record.area === areas[kind]
      && item.record.path === "Old/Before.md").record;
    const { slug: _slug, ...updates } = request(kind).arguments;
    return { operation: `knowledge.${kind === "paper" ? "research" : kind}.update`, actorId: actor.id,
      args: { ...updates, operationId: randomUUID(), id: source.id, expectedRevision: source.revision,
        expectedSha256: source.sha256, expectedScanRevision: knowledgeMutationScanRevision(documents),
        preserveIdentity: true, moveTo: `New/${kind === "skill" ? "Before" : "After"}.md`, ...extra } };
  };
  return { root, oracle, rows, original, close, reopen, content, request,
    pin,
    get full() { return full; }, get opened() { return opened; },
    invoke(kind) { return legacyKnowledgeWrite(full.runtime.core, opened.storage, actor, request(kind)); },
    async mutate(kind, extra = {}) {
      const pinned = pin(kind, extra);
      const response = await full.runtime.core.dispatch("capability_call", {
        operation: pinned.operation, version: 1, arguments: pinned.args,
      }, actor);
      if (response.error) throw Object.assign(new Error(response.error.message), response.error);
      return response.result;
    } };
}
for (const kind of Object.keys(areas))
test(`actual original-owned _assets ${kind} migration preserves identity/revision and matches digest names, bytes and suffixes`, { timeout: 120000 }, async t => {
  const f = await fixture(t, { paired: true }), area = areas[kind], name = kind === "skill" ? "Before" : "After";
  const privateBefore = (await snapshot(f.root)).filter(([path]) => path.includes("/Private/"));
  const expected = f.original.run(f.oracle, moveOriginalKnowledge, { kind, content: f.content(kind) });
  await assert.rejects(f.invoke(kind), /NATIVE_AUTHORITY_REQUIRED.*fresh native public approval/);
  const result = await f.mutate(kind);
  assert.equal(result.id, f.rows[kind].knowledgeId);
  const after = scanMarkdown(f.root).find(item => item.record.area === area);
  assert.equal(after.record.revision, expected.revision); assert.equal(after.record.id, expected.knowledgeId);
  assert.equal(after.record.content, expected.content);
  assert.deepEqual([...after.metadata.toJS().aliases].sort(), [...expected.aliases].sort());
  for (const [source, bytes] of sources) {
    const target = `${hash(bytes).slice(0, 16)}${source.endsWith("PNG") ? ".png" : ".bin"}`;
    assert.deepEqual(await readFile(join(f.root, area, `New/${name}.assets/${target}`)), bytes);
    await assert.rejects(readFile(join(f.root, area, `_assets/${source}`)), { code: "ENOENT" });
  }
  assert(after.record.content.includes(`${name}.assets/${hash(sources[0][1]).slice(0, 16)}.png?q=1#view`));
  if (kind === "note") assert.deepEqual(await readFile(join(f.root, area, "New/After.assets/existing.bin")), Buffer.from([9, 8, 7]));
  assert.deepEqual((await snapshot(f.root)).filter(([path]) => path.includes("/Private/")), privateBefore);
  assert.equal(journal(f.root).intents.length, 0); assert.equal(journal(f.root).receipts.length, 1);
  await f.close(); await f.reopen();
  assert.equal(scanMarkdown(f.root).find(item => item.record.area === area).record.id, expected.knowledgeId);
});
test("original and Core retain shared PUBLIC legacy bytes/private referrers while private source publication still refuses", { timeout: 120000 }, async t => {
  const shared = await fixture(t, { shared: true }), before = await snapshot(shared.root);
  const expected = shared.original.run(shared.oracle, moveOriginalKnowledge, { kind: "note", content: shared.content("note") });
  assert.deepEqual(await readFile(join(shared.oracle, "notes/_assets/a.PNG")), sources[0][1]);
  const stat = await fs.promises.lstat(join(shared.root, "notes/_assets/a.PNG"), { bigint: true });
  const result = await shared.mutate("note");
  assert.equal(result.id, expected.knowledgeId); assert.equal(result.revision, expected.revision);
  assert.equal(scanMarkdown(shared.root).find(row => row.record.area === "notes").record.content, expected.content);
  assert.deepEqual(await readFile(join(shared.root, "notes/_assets/a.PNG")), sources[0][1]);
  assert.deepEqual(await fs.promises.lstat(join(shared.root, "notes/_assets/a.PNG"), { bigint: true }).then(value =>
    [value.ino, value.mode, value.size, value.mtimeNs, value.ctimeNs]), [stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs]);
  assert.deepEqual((await snapshot(shared.root)).filter(([path]) => path.includes("/Private/")), before.filter(([path]) => path.includes("/Private/")));
  assert.equal(journal(shared.root).intents.length, 0); assert.equal(journal(shared.root).receipts.length, 1);
  await shared.close();
  const privateSource = await fixture(t, { privateSource: true }), privateBefore = await snapshot(privateSource.root);
  await assert.rejects(privateSource.mutate("note"), { code: "ACCESS_DENIED" });
  assert.deepEqual(await snapshot(privateSource.root), privateBefore);
  assert.deepEqual(journal(privateSource.root), { intents: [], receipts: [] });
});
test("submitted legacy resources absent from the original owner proof stay closed before any mutation intent", { timeout: 120000 }, async t => {
  const f = await fixture(t), before = await snapshot(f.root);
  await assert.rejects(f.mutate("note", { content: "![unreviewed](../_assets/new.png)\n" }), { code: "UNSUPPORTED_OPERATION" });
  assert.deepEqual(await snapshot(f.root), before); assert.deepEqual(journal(f.root), { intents: [], receipts: [] });
  await f.close();
  const ordinary = await fixture(t, { withoutLegacy: true }), ordinaryBefore = await snapshot(ordinary.root);
  await assert.rejects(ordinary.mutate("note", { content: "![unreviewed](../_assets/new.png)\n" }), { code: "UNSUPPORTED_OPERATION" });
  assert.deepEqual(await snapshot(ordinary.root), ordinaryBefore); assert.deepEqual(journal(ordinary.root), { intents: [], receipts: [] });
});
for (const point of ["first-copy", "first-source-removed"])
test(`legacy ${point} interruption preserves a single intent and recovers all bytes, private closure and one actor-bound receipt`, { timeout: 120000 }, async t => {
  const f = await fixture(t), beforePrivate = (await snapshot(f.root)).filter(([path]) => path.includes("/Private/"));
  const execute = childProcess.execFileSync, unlink = fs.unlinkSync;
  let injected = false;
  childProcess.execFileSync = function(file, args, options) {
    const value = execute.call(this, file, args, options);
    if (point === "first-copy" && !injected && Array.isArray(args) && args[0] === "-c"
      && String(args[1]).includes("renameat2") && String(args[3]).endsWith(`${hash(sources[0][1]).slice(0, 16)}.png`)) {
      injected = true; throw new Error("First legacy copy interruption");
    }
    return value;
  };
  fs.unlinkSync = (...args) => {
    const value = unlink(...args);
    if (point === "first-source-removed" && String(args[0]) === join(f.root, "notes/_assets/a.PNG")) {
      injected = true; throw new Error("First legacy source removal interruption");
    }
    return value;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(f.mutate("note"), { code: "RECOVERY_CONFLICT" }); }
  finally { childProcess.execFileSync = execute; fs.unlinkSync = unlink; syncBuiltinESMExports(); }
  assert.equal(injected, true);
  const pending = journal(f.root); assert.equal(pending.intents.length, 1); assert.equal(pending.receipts.length, 0);
  const row = pending.intents[0], request = JSON.parse(row.request_json), plan = JSON.parse(row.plan_json);
  assert.equal(JSON.parse(plan.relocation).legacyAssets.copies.length, 2);
  assert(!row.plan_json.includes("Retained private legacy marker"));
  await f.close(); await f.reopen();
  const after = scanMarkdown(f.root).find(item => item.record.area === "notes");
  assert.equal(after.record.id, f.rows.note.knowledgeId); assert.equal(after.record.revision, f.rows.note.revision + 1);
  for (const [source, bytes] of sources) {
    const target = `${hash(bytes).slice(0, 16)}${source.endsWith("PNG") ? ".png" : ".bin"}`;
    assert.deepEqual(await readFile(join(f.root, "notes/New/After.assets", target)), bytes);
    await assert.rejects(readFile(join(f.root, "notes/_assets", source)), { code: "ENOENT" });
  }
  assert.deepEqual((await snapshot(f.root)).filter(([path]) => path.includes("/Private/")), beforePrivate);
  const replay = await f.full.runtime.core.dispatch("capability_call", { operation: request.operation, version: 1, arguments: request.args }, actor);
  assert.equal(replay.error, undefined, JSON.stringify(replay)); assert.equal(replay.result.operationId, row.operation_id);
  const foreign = await f.full.runtime.core.dispatch("capability_call", { operation: request.operation, version: 1, arguments: request.args },
    { id: "foreign:actor", canWrite: true });
  assert.equal(foreign.error.code, "CONFLICT");
  assert.equal(journal(f.root).receipts.length, 1); assert.equal(journal(f.root).intents.length, 0);
});
test("a competing legacy source change after first publication preserves its new bytes and blocks receipt/recovery instead of retrying", { timeout: 120000 }, async t => {
  const f = await fixture(t), execute = childProcess.execFileSync, changed = Buffer.from([6, 7, 8, 9, 0]);
  let drifted = false;
  childProcess.execFileSync = function(file, args, options) {
    const result = execute.call(this, file, args, options);
    if (!drifted && Array.isArray(args) && args[0] === "-c" && String(args[1]).includes("renameat2")
      && String(args[3]).endsWith(`${hash(sources[0][1]).slice(0, 16)}.png`)) {
      drifted = true;
      fs.writeFileSync(join(f.root, "notes/_assets/b.BIN"), changed);
    }
    return result;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(f.mutate("note"), { code: "RECOVERY_CONFLICT" }); }
  finally { childProcess.execFileSync = execute; syncBuiltinESMExports(); }
  assert.equal(drifted, true); assert.equal(journal(f.root).intents.length, 1); assert.equal(journal(f.root).receipts.length, 0);
  const beforeRecovery = await snapshot(f.root);
  await f.close();
  await assert.rejects(f.reopen(), /exact approved move intent/);
  assert.deepEqual(await snapshot(f.root), beforeRecovery);
  assert.deepEqual(await readFile(join(f.root, "notes/_assets/b.BIN")), changed);
  assert.equal(journal(f.root).intents.length, 1); assert.equal(journal(f.root).receipts.length, 0);
});
test("PUBLIC referrers in all three areas derive retained sources and match the pinned original without repeated effects", { timeout: 120000 }, async t => {
  const f = await fixture(t, { publicReferrer: true, parserForms: true, paired: true });
  const referrers = (await snapshot(f.root)).filter(([path]) => /\/Old\/Referrer\.md$|\/Private\//.test(path));
  for (const kind of Object.keys(areas)) {
    const area = areas[kind], source = join(f.root, area, "_assets/a.PNG"), identityBefore = await sourceIdentity(source);
    const expected = f.original.run(f.oracle, moveOriginalKnowledge, { kind, content: f.content(kind) });
    const result = await f.mutate(kind);
    assert.equal(result.id, expected.knowledgeId); assert.equal(result.revision, expected.revision);
    assert.equal(scanMarkdown(f.root).find(row => row.record.area === area && row.record.path.startsWith("New/")).record.content, expected.content);
    assert.deepEqual(await readFile(source), sources[0][1]); assert.deepEqual(await sourceIdentity(source), identityBefore);
    await assert.rejects(readFile(join(f.root, area, "_assets/b.BIN")), { code: "ENOENT" });
    const committed = commitment(f.root, result.operationId), plan = JSON.parse(committed.plan_json);
    const legacy = JSON.parse(plan.relocation).legacyAssets;
    assert.equal(legacy.protocol, "pkm.document-legacy-assets.dispositions/v2");
    assert.equal(legacy.copies.find(copy => copy.source.endsWith("a.PNG")).disposition, "retain");
    assert.equal(legacy.copies.find(copy => copy.source.endsWith("b.BIN")).disposition, undefined);
    const recorded = JSON.parse(committed.request_json), beforeReplay = await snapshot(f.root), receiptCount = journal(f.root).receipts.length;
    const replay = await f.full.runtime.core.dispatch("capability_call", { operation: recorded.operation, version: 1, arguments: recorded.args }, actor);
    assert.equal(replay.error, undefined, JSON.stringify(replay)); assert.equal(replay.result.operationId, result.operationId);
    const foreign = await f.full.runtime.core.dispatch("capability_call", { operation: recorded.operation, version: 1, arguments: recorded.args },
      { id: "foreign:actor", canWrite: true });
    assert.equal(foreign.error.code, "CONFLICT");
    assert.equal(journal(f.root).receipts.length, receiptCount);
    assert.deepEqual(await snapshot(f.root), beforeReplay); assert.deepEqual(await sourceIdentity(source), identityBefore);
  }
  assert.deepEqual((await snapshot(f.root)).filter(([path]) => /\/Old\/Referrer\.md$|\/Private\//.test(path)), referrers);
});
test("retain protocol stripping and caller-selected remove dispositions cannot downgrade a complete private-referrer proof", { timeout: 120000 }, async t => {
  const f = await fixture(t, { shared: true }), pinned = f.pin("note"), before = await snapshot(f.root);
  const planned = await f.opened.storage.withWorkspaceExclusive(() => planKnowledgeMutation(f.root, pinned));
  const wire = JSON.parse(serializeKnowledgeMutationPlan(planned)), relocation = JSON.parse(wire.relocation);
  assert.equal(relocation.legacyAssets.protocol, "pkm.document-legacy-assets.dispositions/v2");
  const servingPlanner = await readFile(resolve("dist/document-legacy-assets.js"), "utf8");
  if (!servingPlanner.includes("pkm.document-legacy-assets.dispositions/v2")) {
    childProcess.execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";
      import { deserializeDocumentLifecyclePlan } from "./dist/document-lifecycle.js";
      const wire = readFileSync(0,"utf8");
      assert.throws(() => deserializeDocumentLifecyclePlan(wire),
        error => ["INVALID_DOCUMENT","INVALID_WORKSPACE"].includes(error.code));
    `], { input: JSON.stringify(relocation), env: { ...process.env, NODE_OPTIONS: "--experimental-transform-types" },
      timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
    t.diagnostic("The actual held pre-retention emitted parser refused this v2 retain intent before effects.");
  }
  delete relocation.legacyAssets.protocol;
  wire.relocation = JSON.stringify(relocation);
  assert.throws(() => deserializeKnowledgeMutationPlan(JSON.stringify(wire)), { code: "INVALID_WORKSPACE" });
  for (const copy of relocation.legacyAssets.copies) delete copy.disposition;
  wire.relocation = JSON.stringify(relocation);
  const downgraded = deserializeKnowledgeMutationPlan(JSON.stringify(wire));
  await f.opened.storage.withWorkspaceExclusive(() =>
    assert.throws(() => assertKnowledgeMutationRequestPlan(f.root, downgraded, pinned), { code: "RECOVERY_CONFLICT" }));
  assert.deepEqual(await snapshot(f.root), before); assert.deepEqual(journal(f.root), { intents: [], receipts: [] });
});
test("retained source survives exact partial removal recovery and the prior actor is checked before replay", { timeout: 120000 }, async t => {
  const f = await fixture(t, { shared: true }), unlink = fs.unlinkSync, source = join(f.root, "notes/_assets/a.PNG");
  const identityBefore = await sourceIdentity(source), referrers = (await snapshot(f.root)).filter(([path]) => path.includes("/Private/"));
  let injected = false;
  fs.unlinkSync = (...args) => {
    const result = unlink(...args);
    if (String(args[0]) === join(f.root, "notes/_assets/b.BIN")) { injected = true; throw new Error("Shared retain partial removal"); }
    return result;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(f.mutate("note"), { code: "RECOVERY_CONFLICT" }); }
  finally { fs.unlinkSync = unlink; syncBuiltinESMExports(); }
  assert.equal(injected, true);
  const pending = journal(f.root); assert.equal(pending.intents.length, 1); assert.equal(pending.receipts.length, 0);
  const recorded = JSON.parse(pending.intents[0].request_json), beforeForeign = await snapshot(f.root);
  const foreign = await f.full.runtime.core.dispatch("capability_call", { operation: recorded.operation, version: 1, arguments: recorded.args },
    { id: "foreign:actor", canWrite: true });
  assert.equal(foreign.error.code, "CONFLICT"); assert.equal(journal(f.root).intents.length, 1);
  assert.deepEqual(await snapshot(f.root), beforeForeign);
  await f.close(); await f.reopen();
  assert.equal(journal(f.root).receipts.length, 1); assert.equal(journal(f.root).intents.length, 0);
  assert.deepEqual(await readFile(source), sources[0][1]); assert.deepEqual(await sourceIdentity(source), identityBefore);
  assert.deepEqual((await snapshot(f.root)).filter(([path]) => path.includes("/Private/")), referrers);
  const replay = await f.full.runtime.core.dispatch("capability_call", { operation: recorded.operation, version: 1, arguments: recorded.args }, actor);
  assert.equal(replay.error, undefined, JSON.stringify(replay)); assert.equal(replay.result.operationId, pending.intents[0].operation_id);
});
test("retained source drift after first publication preserves competing bytes and refuses pending recovery/foreign replay", { timeout: 120000 }, async t => {
  const f = await fixture(t, { shared: true }), execute = childProcess.execFileSync, source = join(f.root, "notes/_assets/a.PNG");
  const changed = Buffer.from([10, 11, 12, 13]);
  let drifted = false;
  childProcess.execFileSync = function(file, args, options) {
    const result = execute.call(this, file, args, options);
    if (!drifted && Array.isArray(args) && args[0] === "-c" && String(args[1]).includes("renameat2")
      && String(args[3]).endsWith(`${hash(sources[0][1]).slice(0, 16)}.png`)) {
      drifted = true; fs.writeFileSync(source, changed);
    }
    return result;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(f.mutate("note"), { code: "RECOVERY_CONFLICT" }); }
  finally { childProcess.execFileSync = execute; syncBuiltinESMExports(); }
  assert.equal(drifted, true);
  const recorded = JSON.parse(journal(f.root).intents[0].request_json), before = await snapshot(f.root);
  const foreign = await f.full.runtime.core.dispatch("capability_call", { operation: recorded.operation, version: 1, arguments: recorded.args },
    { id: "foreign:actor", canWrite: true });
  assert.equal(foreign.error.code, "CONFLICT"); assert.deepEqual(await snapshot(f.root), before);
  await f.close(); await assert.rejects(f.reopen(), /exact approved move intent/);
  assert.deepEqual(await readFile(source), changed); assert.deepEqual(await snapshot(f.root), before);
  assert.equal(journal(f.root).receipts.length, 0); assert.equal(journal(f.root).intents.length, 1);
});
