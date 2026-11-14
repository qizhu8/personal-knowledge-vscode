import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { legacyKnowledgeWrite } from "../dist/legacy-knowledge-write.js";
import { scanMarkdown } from "../dist/markdown.js";

const root = resolve(import.meta.dirname, "..");
const actor = { id: "mcp:external", canWrite: true };
const opaque = Buffer.from([255, 0, 128, 9]);
async function fixture(t) {
  const parent = join(root, "tests", `.knowledge-move-${randomUUID()}`);
  await mkdir(parent);
  const data = await initialize(join(parent, "workspace"));
  const storage = await Storage.open(data);
  let native;
  try { native = await createNativeRuntime({ storage }); }
  catch (error) { await storage.close(); throw error; }
  let closed = false;
  const close = async () => {
    if (!closed) { closed = true; await native.close(); await storage.close(); }
  };
  t.after(async () => { try { await close(); } finally { await rm(parent, { recursive: true, force: true }); } });
  return { data, storage, native, close };
}
for (const format of ["plain", "original", "canonical-document-id"])
test(`approved atomic identity migration preserves the existing native document ID and original Knowledge identity (${format})`, async t => {
  const f = await fixture(t);
  const known = "knowledge_000000000000000000000001";
  const raw = format === "plain" ? "Original body\n![pair](Before.assets/opaque.bin)\n"
    : `---\ndocumentId: historical-native-id\ntitle: Before\nknowledgeId: ${known}\nrevision: 7\n`
      + (format === "canonical-document-id" ? "schema: pkm.knowledge/v1\naliases: [note:Older/Name]\n" : "")
      + "created: 2001-02-03T04:05:06.000Z\nhistory: [{event: original}]\nlinks: []\n---\nOriginal body\n![pair](Before.assets/opaque.bin)\n";
  await mkdir(join(f.data, "notes/Old/Before.assets"), { recursive: true });
  await writeFile(join(f.data, "notes/Old/Before.md"), raw);
  await writeFile(join(f.data, "notes/Old/Before.assets/opaque.bin"), opaque);
  const before = scanMarkdown(f.data)[0];
  const response = await legacyKnowledgeWrite(f.native.core, f.storage, actor, {
    tool: "update_note", arguments: { slug: "Old/Before", title: "After", category: "New" },
  });
  assert.deepEqual(JSON.parse(response.text), { ok: true, slug: "New/After" });
  const after = scanMarkdown(f.data)[0];
  assert.equal(after.record.id, before.record.id);
  assert.equal(after.metadata.get("documentId"), before.record.id);
  assert.equal(after.record.revision, before.record.revision + 1);
  assert.equal(after.record.content, "Original body\n![pair](After.assets/opaque.bin)\n");
  if (format !== "plain") {
    assert.equal(after.metadata.get("knowledgeId"), known);
    assert(after.raw.includes("created: 2001-02-03T04:05:06.000Z"));
    assert(after.raw.includes("history: [{event: original}]"));
  }
  if (format === "canonical-document-id") assert(after.metadata.toJS().aliases.includes("note:Older/Name"));
  assert(after.metadata.toJS().aliases.includes("note:Old/Before"));
  assert(after.metadata.toJS().aliases.includes("note:New/After"));
  await f.close();
  const storage = await Storage.open(f.data);
  const native = await createNativeRuntime({ storage });
  try { assert.equal(scanMarkdown(f.data)[0].record.id, before.record.id); }
  finally { await native.close(); await storage.close(); }
});
for (const kind of ["note", "skill", "paper"])
for (const field of ["knowledgeId", "aliases"])
for (const moving of [false, true])
test(`identity preservation refuses explicit null ${field} without changing ${kind} bytes or journal (${moving ? "move" : "update"})`, async t => {
  const f = await fixture(t);
  const area = kind === "note" ? "notes" : kind === "skill" ? "skills" : "papers";
  const raw = "---\ndocumentId: historical-native-id\nschema: pkm.knowledge/v1\nrevision: 7\n"
    + `knowledgeId: ${field === "knowledgeId" ? "null" : "knowledge_000000000000000000000001"}\n`
    + `aliases: ${field === "aliases" ? "null" : "[note:Older/Name]"}\n`
    + "title: Before\ncreated: 2001-02-03T04:05:06.000Z\nhistory: [{event: original}]\n---\nOriginal body\n";
  const path = join(f.data, area, "Old/Before.md");
  await mkdir(join(f.data, area, "Old/Before.assets"), { recursive: true });
  await writeFile(path, raw);
  await writeFile(join(f.data, area, "Old/Before.assets/opaque.bin"), opaque);
  assert.equal(scanMarkdown(f.data)[0].record.id, "historical-native-id");
  await assert.rejects(legacyKnowledgeWrite(f.native.core, f.storage, actor, {
    tool: `update_${kind}`, arguments: {
      [kind === "skill" ? "name" : "slug"]: kind === "skill" ? "Before" : "Old/Before",
      content: "Must not replace the original body",
      ...(moving ? { category: "New" } : {}),
    },
  }), /UNSUPPORTED_OPERATION/);
  assert.equal(await readFile(path, "utf8"), raw);
  assert.deepEqual(await readFile(join(f.data, area, "Old/Before.assets/opaque.bin")), opaque);
  await assert.rejects(readFile(join(f.data, area, "New/Before.md")), { code: "ENOENT" });
  const db = new DatabaseSync(join(f.data, "core.sqlite"), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM migration_runtime_intents").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM receipts WHERE operation=?")
      .get(`knowledge.${kind === "paper" ? "research" : kind}.update`).count, 0);
  } finally { db.close(); }
});
for (const kind of ["note", "skill", "paper"]) test(`approved preserve-identities ${kind} atomic content/title/category move retains links/history/created/unknown YAML and paired bytes`,
  async t => {
    const f = await fixture(t);
    const area = kind === "note" ? "notes" : kind === "skill" ? "skills" : "papers";
    await legacyKnowledgeWrite(f.native.core, f.storage, actor, { tool: `add_${kind}`, arguments: {
      [kind === "skill" ? "name" : "title"]: "Before", category: "Old", content: "Original",
    } });
    const beforePath = join(f.data, area, "Old/Before.md");
    const before = await readFile(beforePath, "utf8");
    const identity = /knowledgeId: ("knowledge_[a-f0-9]{24}")/.exec(before)[1];
    const raw = before.replace(/^created:.*\n/m, "").replace(/^links:.*\n/m, "").replace("---\n",
      `---\n# Preserve metadata comment\ncreated: "2001-02-03T04:05:06.000Z"\ncustom: {retain: [one, two]}\nhistory: [{event: original}]\nlinks: [{relation: uses, target: "pkm://knowledge/${JSON.parse(identity)}", mode: floating, required: false}]\n`);
    await writeFile(beforePath, raw);
    await mkdir(join(f.data, area, "Old/Before.assets"), { recursive: true });
    await writeFile(join(f.data, area, "Old/Before.assets/opaque.bin"), opaque);
    const response = await legacyKnowledgeWrite(f.native.core, f.storage, actor, { tool: `update_${kind}`, arguments: {
      [kind === "skill" ? "name" : "slug"]: kind === "skill" ? "Before" : "Old/Before",
      ...(kind === "skill" ? {} : { title: "After" }), category: "New",
      content: "Changed\n![paired](Before.assets/opaque.bin?q=1#view)\n",
    } });
    const name = kind === "skill" ? "Before" : "After";
    assert.deepEqual(JSON.parse(response.text), kind === "skill" ? { ok: true, name: "Before" } : { ok: true, slug: `New/${name}` });
    await assert.rejects(readFile(beforePath), { code: "ENOENT" });
    const moved = await readFile(join(f.data, area, "New", `${name}.md`), "utf8");
    assert(moved.includes(`knowledgeId: ${identity}`));
    for (const fragment of ['created: "2001-02-03T04:05:06.000Z"', "custom: {retain: [one, two]}",
      "history: [{event: original}]", "# Preserve metadata comment", `target: "pkm://knowledge/${JSON.parse(identity)}"`])
      assert(moved.includes(fragment), fragment);
    assert.match(moved, /revision: 2/);
    assert(moved.includes(`![paired](${name}.assets/opaque.bin?q=1#view)`));
    const doc = scanMarkdown(f.data).find(doc => doc.record.area === area);
    const aliases = doc.metadata.toJS().aliases;
    const aliasKind = kind === "paper" ? "research" : kind;
    assert(aliases.includes(`${aliasKind}:Old/Before`));
    assert(aliases.includes(`${aliasKind}:New/${name}`));
    assert.deepEqual(await readFile(join(f.data, area, "New", `${name}.assets/opaque.bin`)), opaque);
    const db = new DatabaseSync(join(f.data, "core.sqlite"), { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM migration_runtime_intents").get().count, 0);
      const receipts = db.prepare("SELECT result FROM receipts WHERE operation=?").all(`knowledge.${kind === "paper" ? "research" : kind}.update`);
      assert.equal(receipts.length, 1);
      assert.equal(JSON.parse(receipts[0].result).revision, 2);
    } finally { db.close(); }
  });

for (const interruption of ["assets-first", "destination-written", "source-removed"])
test(`atomic writer recovers ${interruption} interruption without publishing an independent update receipt or losing identity`,
  async t => {
    const f = await fixture(t);
    await legacyKnowledgeWrite(f.native.core, f.storage, actor, { tool: "add_note", arguments: {
      title: "Before", category: "Old", content: "Original",
    } });
    const before = await readFile(join(f.data, "notes/Old/Before.md"), "utf8");
    await mkdir(join(f.data, "notes/Old/Before.assets"));
    await writeFile(join(f.data, "notes/Old/Before.assets/opaque.bin"), opaque);
    const rename = fs.renameSync, unlink = fs.unlinkSync;
    let injected = false;
    fs.renameSync = (...args) => {
      const result = rename(...args);
      if (interruption === "assets-first" && String(args[0]).endsWith("Before.assets")) {
        injected = true; throw new Error("assets-first interruption");
      }
      return result;
    };
    fs.unlinkSync = (...args) => {
      if (String(args[0]).endsWith("Old/Before.md")) {
        if (interruption === "source-removed") unlink(...args);
        injected = true; throw new Error(`${interruption} interruption`);
      }
      return unlink(...args);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(legacyKnowledgeWrite(f.native.core, f.storage, actor, { tool: "update_note", arguments: {
        slug: "Old/Before", title: "After", category: "New", content: "Changed\n![pair](Before.assets/opaque.bin)\n",
      } }), /interrupted/);
    } finally { fs.renameSync = rename; fs.unlinkSync = unlink; syncBuiltinESMExports(); }
    assert.equal(injected, true);
    if (interruption === "source-removed") await assert.rejects(readFile(join(f.data, "notes/Old/Before.md")), { code: "ENOENT" });
    else assert.equal(await readFile(join(f.data, "notes/Old/Before.md"), "utf8"), before);
    const pendingDb = new DatabaseSync(join(f.data, "core.sqlite"), { readOnly: true });
    let operationId, request;
    try {
      const pending = pendingDb.prepare("SELECT * FROM migration_runtime_intents").get();
      operationId = pending.operation_id; request = JSON.parse(pending.request_json);
      assert.equal(pendingDb.prepare("SELECT COUNT(*) AS count FROM receipts WHERE operation_id=?").get(operationId).count, 0);
    } finally { pendingDb.close(); }
    await f.close();
    const storage = await Storage.open(f.data, { deferRecovery: true });
    const native = await createNativeRuntime({ storage });
    try {
      await assert.rejects(readFile(join(f.data, "notes/Old/Before.md")), { code: "ENOENT" });
      const after = await readFile(join(f.data, "notes/New/After.md"), "utf8");
      assert.equal(/knowledgeId: ("knowledge_[a-f0-9]{24}")/.exec(after)[1], /knowledgeId: ("knowledge_[a-f0-9]{24}")/.exec(before)[1]);
      assert.match(after, /revision: 2/);
      assert.match(after, /After.assets\/opaque.bin/);
      assert.deepEqual(await readFile(join(f.data, "notes/New/After.assets/opaque.bin")), opaque);
      const replay = await native.core.dispatch("capability_call", {
        operation: request.operation, version: 1, arguments: request.args,
      }, actor);
      assert.equal(replay.error, undefined, JSON.stringify(replay));
      assert.equal(replay.result.operationId, operationId);
      assert.equal(replay.result.revision, 2);
      const spoof = await native.core.dispatch("capability_call", { operation: request.operation, version: 1, arguments: request.args },
        { id: "other:actor", canWrite: true });
      assert.equal(spoof.error.code, "CONFLICT");
    } finally { await native.close(); await storage.close(); }
  });
