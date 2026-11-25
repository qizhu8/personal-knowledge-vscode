import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { captureOriginalMcpCustody, openOriginalMcpRoot, rollbackOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { legacyKnowledgeWrite } from "../dist/legacy-knowledge-write.js";
import { scanMarkdown } from "../dist/markdown.js";
import { knowledgeMutationScanRevision } from "../dist/knowledge-mutations.js";
import { originalKnowledgeWriterFixture, seedOriginalKnowledge, moveOriginalKnowledge } from "./original-knowledge-writer-fixture.mjs";

const actor = { id: "mcp:external", canWrite: true };
const hash = value => createHash("sha256").update(value).digest("hex");
const areaFor = kind => kind === "note" ? "notes" : kind === "skill" ? "skills" : "papers";
const nameFor = kind => kind === "skill" ? "Before" : "After";
const move = kind => ({ tool: `update_${kind}`, arguments: {
  [kind === "skill" ? "name" : "slug"]: kind === "skill" ? "Before" : "Old/Before",
  ...(kind === "skill" ? {} : { title: "After" }), category: "New",
  content: "Changed body\n![paired](Before.assets/opaque.bin?q=1#view)\n",
} });
async function snapshot(root) {
  const files = [];
  async function walk(directory, prefix) {
    for (const name of (await readdir(directory)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name, path = join(directory, name);
      if ((await fs.promises.lstat(path)).isDirectory()) await walk(path, relative);
      else files.push([relative, hash(await readFile(path))]);
    }
  }
  for (const area of ["notes", "skills", "papers"]) await walk(join(root, area), area);
  return files;
}
async function fixture(t, options = {}) {
  assert(process.env.PKM_TEST_WORKSPACE, "Use the existing private Linux test framework.");
  const directory = resolve("tests", `.private-knowledge-move-${randomUUID()}`), root = join(directory, "root");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const original = originalKnowledgeWriterFixture(directory);
  const rows = original.run(root, seedOriginalKnowledge, options);
  const oracle = join(directory, "oracle");
  await cp(root, oracle, { recursive: true });
  let opened, runtime;
  const close = async () => { if (opened) { const current = opened; opened = undefined; runtime = undefined; await current.owner.close(); } };
  t.after(async () => { try { await close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"),
    operatorId: "original-knowledge-writer-fixture", profileSha256: hash("knowledge-private-move-fixture"),
    limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16 * 1024 * 1024, maxFileBytes: 1024 * 1024 } });
  const reopen = async () => {
    opened = await openOriginalMcpRoot(plan);
    runtime = (await opened.owner.ensureFull()).runtime;
  };
  await reopen();
  const preparation = { root, workspaceId: opened.workspaceId, planSha256: opened.planSha256, journalSha256: opened.journalSha256 };
  return { directory, root, oracle, original, rows, plan, preparation, close, reopen,
    get opened() { return opened; }, get runtime() { return runtime; },
    invoke(request, principal = actor) { return legacyKnowledgeWrite(runtime.core, opened.storage, principal, request); },
    async mutate(kind) {
      const documents = scanMarkdown(root), source = documents.find(item => item.record.area === areaFor(kind)
        && item.record.path === "Old/Before.md").record;
      const { slug: _slug, ...updates } = move(kind).arguments;
      const response = await runtime.core.dispatch("capability_call", {
        operation: `knowledge.${kind === "paper" ? "research" : kind}.update`, version: 1,
        arguments: { ...updates, operationId: randomUUID(), id: source.id, expectedRevision: source.revision,
          expectedSha256: source.sha256, expectedScanRevision: knowledgeMutationScanRevision(documents), preserveIdentity: true,
          moveTo: `New/${nameFor(kind)}.md` },
      }, actor);
      if (response.error) throw new Error(`${response.error.code}: ${response.error.message}`);
      return response.result;
    } };
}
function journal(root) {
  const db = new DatabaseSync(join(root, "core.sqlite"), { readOnly: true });
  try { return { intents: db.prepare("SELECT * FROM migration_runtime_intents").all(),
    receipts: db.prepare("SELECT * FROM receipts WHERE operation GLOB 'knowledge.*.update'").all() }; }
  finally { db.close(); }
}

for (const kind of ["note", "skill", "paper"])
test(`actual original writer and same-owner Core preserve ${kind} identity/assets while privately validating retained referrers`, { timeout: 120000 }, async t => {
  const f = await fixture(t), area = areaFor(kind), before = f.rows[kind];
  const privateBefore = (await snapshot(f.root)).filter(([path]) => path.includes("/Private/"));
  const expected = f.original.run(f.oracle, moveOriginalKnowledge, { kind });
  const result = await f.mutate(kind);
  assert.equal(result.path, `New/${nameFor(kind)}.md`);
  const after = scanMarkdown(f.root).find(item => item.record.area === area);
  assert.equal(after.record.id, before.knowledgeId);
  assert.equal(after.metadata.get("knowledgeId"), expected.knowledgeId);
  assert.equal(after.record.revision, expected.revision);
  assert.deepEqual([...after.metadata.toJS().aliases].sort(), [...expected.aliases].sort());
  assert.equal(after.record.content, expected.content);
  assert.equal(after.record.path, `New/${nameFor(kind)}.md`);
  assert.deepEqual(await readFile(join(f.root, area, `New/${nameFor(kind)}.assets/opaque.bin`)), Buffer.from([255, 0, 128, 9]));
  assert.deepEqual((await snapshot(f.root)).filter(([path]) => path.includes("/Private/")), privateBefore);
  assert(scanMarkdown(f.root).every(item => !item.raw.includes("Private marker")));
  const state = journal(f.root);
  assert.equal(state.intents.length, 0); assert.equal(state.receipts.length, 1);
  assert.doesNotMatch(state.receipts[0].result, /Private|Secret|Private marker/);
  await f.close(); await f.reopen();
  assert.equal(scanMarkdown(f.root).find(item => item.record.area === area).record.id, before.knowledgeId);
  await f.close();
  const readByOriginal = f.original.run(f.root, `return store[input.kind + "Get"](input.key);`,
    { kind, key: kind === "skill" ? "Before" : "New/After" });
  assert.equal(readByOriginal.knowledgeId, expected.knowledgeId);
  assert.equal(readByOriginal.content, expected.content);
});

for (const kind of ["note", "skill", "paper"])
test(`actual original writer and Core both refuse ${kind} assets shared from a retained private subtree without publishing its path`, { timeout: 120000 }, async t => {
  const f = await fixture(t, { shared: true }), before = await snapshot(f.root), oracleBefore = await snapshot(f.oracle);
  assert.throws(() => f.original.run(f.oracle, moveOriginalKnowledge, { kind }), /Resource is shared by Private/);
  assert.deepEqual(await snapshot(f.oracle), oracleBefore);
  await assert.rejects(f.mutate(kind), error => /shared/.test(error.message) && !/Private|Secret|Private marker/.test(error.message));
  assert.deepEqual(await snapshot(f.root), before);
  assert.deepEqual(journal(f.root), { intents: [], receipts: [] });
  await f.close();
  await rollbackOriginalMcpRoot(f.plan, f.preparation);
});

test("private-reference move CAS, destination privacy and read-only denial leave files and receipts unchanged", { timeout: 120000 }, async t => {
  const f = await fixture(t), before = await snapshot(f.root), documents = scanMarkdown(f.root);
  const source = documents.find(item => item.record.area === "notes").record;
  const args = { operationId: randomUUID(), id: source.id, expectedRevision: source.revision,
    expectedSha256: source.sha256, expectedScanRevision: knowledgeMutationScanRevision(documents), preserveIdentity: true,
    title: "After", category: "New", moveTo: "New/After.md" };
  const stale = await f.runtime.core.dispatch("capability_call", { operation: "knowledge.note.update", version: 1,
    arguments: { ...args, expectedSha256: "0".repeat(64) } }, actor);
  assert.equal(stale.error.code, "CONFLICT");
  const privateDestination = await f.runtime.core.dispatch("capability_call", { operation: "knowledge.note.update", version: 1,
    arguments: { ...args, category: "Private", moveTo: "Private/After.md" } }, actor);
  assert.equal(privateDestination.error.code, "ACCESS_DENIED");
  await assert.rejects(f.invoke(move("note")), /NATIVE_AUTHORITY_REQUIRED.*fresh native public approval/);
  await assert.rejects(f.invoke(move("note"), { ...actor, canWrite: false }), /ACCESS_DENIED/);
  await assert.rejects(f.invoke({ tool: "update_note", arguments: { slug: "Old/Before", category: "Private" } }), /ACCESS_DENIED/);
  assert.deepEqual(await snapshot(f.root), before);
  assert.deepEqual(journal(f.root), { intents: [], receipts: [] });
});

test("the pinned original writer rolls back paired assets when destination publication fails", { timeout: 120000 }, async t => {
  const f = await fixture(t), before = await snapshot(f.oracle);
  const result = f.original.run(f.oracle, `
    const write = fs.writeFileSync;
    fs.writeFileSync = (...args) => {
      if (String(args[0]) === path.join(root, "notes/New/After.md")) throw new Error("Oracle destination failure");
      return write(...args);
    };
    try { ${moveOriginalKnowledge} }
    catch (error) { return { error: error.message }; }
    finally { fs.writeFileSync = write; }
  `, { kind: "note" });
  assert.match(result.error, /Oracle destination failure/);
  assert.deepEqual(await snapshot(f.oracle), before);
});

for (const phase of ["destination-written", "source-removed"])
test(`private-reference move ${phase} failure keeps a single durable intent, then recovers identity/assets and one actor-bound receipt`, { timeout: 120000 }, async t => {
  const f = await fixture(t), privateBefore = (await snapshot(f.root)).filter(([path]) => path.includes("/Private/"));
  const unlink = fs.unlinkSync;
  let interrupted = false;
  fs.unlinkSync = (...args) => {
    if (String(args[0]) === join(f.root, "notes/Old/Before.md")) {
      if (phase === "source-removed") unlink(...args);
      interrupted = true; throw new Error(`Original fixture ${phase} interruption`);
    }
    return unlink(...args);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(f.mutate("note"), /interrupted/); }
  finally { fs.unlinkSync = unlink; syncBuiltinESMExports(); }
  assert.equal(interrupted, true);
  const pending = journal(f.root);
  assert.equal(pending.intents.length, 1); assert.equal(pending.receipts.length, 0);
  const intent = pending.intents[0], request = JSON.parse(intent.request_json), persisted = JSON.parse(intent.plan_json);
  const relocation = JSON.parse(persisted.relocation);
  assert(relocation.referencePins.some(pin => pin.path === "Private/Secret.md"));
  assert(persisted.sourcePins.every(pin => !pin.path.startsWith("Private/")));
  assert.doesNotMatch(intent.plan_json, /Private marker/);
  await f.close(); await f.reopen();
  const after = scanMarkdown(f.root).find(item => item.record.area === "notes");
  assert.equal(after.record.path, "New/After.md");
  assert.equal(after.record.id, f.rows.note.knowledgeId);
  assert.equal(after.record.revision, f.rows.note.revision + 1);
  assert.deepEqual((await snapshot(f.root)).filter(([path]) => path.includes("/Private/")), privateBefore);
  assert.deepEqual(await readFile(join(f.root, "notes/New/After.assets/opaque.bin")), Buffer.from([255, 0, 128, 9]));
  const replay = await f.runtime.core.dispatch("capability_call", { operation: request.operation, version: 1, arguments: request.args }, actor);
  assert.equal(replay.error, undefined, JSON.stringify(replay)); assert.equal(replay.result.operationId, intent.operation_id);
  const spoof = await f.runtime.core.dispatch("capability_call", { operation: request.operation, version: 1, arguments: request.args },
    { ...actor, id: "foreign:actor" });
  assert.equal(spoof.error.code, "CONFLICT");
  assert.equal(journal(f.root).receipts.length, 1); assert.equal(journal(f.root).intents.length, 0);
});

test("a private referrer changed by the actual original writer invalidates a durable move before replay can commit", { timeout: 120000 }, async t => {
  const f = await fixture(t), unlink = fs.unlinkSync;
  fs.unlinkSync = (...args) => {
    if (String(args[0]) === join(f.root, "notes/Old/Before.md")) throw new Error("Pinned private CAS interruption");
    return unlink(...args);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(f.mutate("note"), /interrupted/); }
  finally { fs.unlinkSync = unlink; syncBuiltinESMExports(); }
  const pending = journal(f.root).intents[0], request = JSON.parse(pending.request_json);
  f.original.run(f.root, `
    const row = store.noteGet("Private/Secret");
    store.noteUpsert({ ...row, tags: JSON.parse(row.tags), content: "Changed private marker\\n" });
    return true;
  `);
  const beforeReplay = await snapshot(f.root);
  const replay = await f.runtime.core.dispatch("capability_call", { operation: request.operation, version: 1, arguments: request.args }, actor);
  assert.equal(replay.error.code, "RECOVERY_CONFLICT");
  assert.doesNotMatch(replay.error.message, /Private|Secret|marker/);
  assert.deepEqual(await snapshot(f.root), beforeReplay);
  assert.equal(journal(f.root).intents.length, 1); assert.equal(journal(f.root).receipts.length, 0);
});
