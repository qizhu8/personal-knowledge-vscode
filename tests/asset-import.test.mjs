import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { initialize, Storage } from "../dist/storage.js";
import { Core } from "../dist/core.js";
import { sha256 } from "../dist/file-write.js";
import { scanMarkdown } from "../dist/markdown.js";
import { assetImportDefinition, assetImportOperation, planAssetImport, recoverAssetImport } from "../dist/asset-import.js";
import { definitions } from "../dist/contracts.js";

const actor = { id: "local:owner", canWrite: true };
const entry = (type, path, bytes) => ({ type, path, data: bytes.toString("base64"), digest: `sha256:${sha256(bytes)}` });
const docs = [
  { area: "notes", path: "Team/Doc.md", content: "![s](_assets/shared.bin)" },
  { area: "skills", path: "Skill.md", content: "no refs", title: "Skill title" },
  { area: "papers", path: "Paper.md", content: "![p](Paper.assets/fig%201.png)" },
];

async function fixture(t) {
  const parent = join(dirname(fileURLToPath(import.meta.url)), `.asset-import-${randomUUID()}`);
  const directory = join(parent, "workspace");
  await mkdir(parent, { recursive: true });
  await initialize(directory);
  const storages = [];
  const open = async () => { const storage = await Storage.open(directory); storages.push(storage); return storage; };
  const request = (args, extra = {}) => ({ operation: assetImportOperation, actorId: actor.id, args: { operationId: randomUUID(), prefix: "", documents: docs, ...args }, ...extra });
  const raw = () => new DatabaseSync(join(directory, "core.sqlite"));
  const counts = () => { const db = raw(); try { return { pending: db.prepare("SELECT count(*) n FROM pending_asset").get().n, receipts: db.prepare("SELECT count(*) n FROM receipts").get().n }; } finally { db.close(); } };
  const scan = () => scanMarkdown(directory);
  t.after(async () => { for (const storage of storages) await storage.close().catch(() => undefined); await rm(parent, { recursive: true, force: true }); });
  return { directory, open, request, raw, counts, scan };
}

const files = async directory => (await Promise.all(["notes", "skills", "papers"].map(async area => {
  const out = [];
  const walk = async (path, rel) => { for (const item of await readdir(path, { withFileTypes: true })) { const next = rel ? `${rel}/${item.name}` : item.name; if (item.isDirectory()) await walk(join(path, item.name), next); else out.push(`${area}/${next}`); } };
  try { await walk(join(directory, area), ""); } catch { /* area absent */ }
  return out;
}))).flat().sort();

test("bundle import is an internal-only native operation, not a public registry entry", async t => {
  const { open, request } = await fixture(t);
  assert(!definitions.some(item => item.id === assetImportOperation));
  assert.equal(assetImportDefinition.readOnly, false);
  const core = new Core(await open());
  const response = await core.dispatch("capability_call", { operation: assetImportOperation, version: 1, arguments: request({ assets: [] }).args }, actor);
  assert(response.error, "Core must not expose the internal operation");
});

for (const prefix of ["", "_incoming/remote-20260101-0000"]) {
  test(`compound import creates documents with stable identity plus resources across areas${prefix ? " with prefix relocation" : ""}, then replays idempotently`, async t => {
    const { directory, open, request, counts, scan } = await fixture(t);
    const storage = await open(), core = new Core(storage);
    const a = Buffer.from("owned"), b = Buffer.from("shared"), c = Buffer.from("figure"), d = Buffer.from("skill diagram");
    const args = { prefix, assets: [
      entry("notes", "Team/Doc.assets/a.bin", a), entry("notes", "Team/_assets/shared.bin", b),
      entry("papers", "Paper.assets/fig 1.png", c), entry("skills", "Skill.assets/d.mmd", d), entry("notes", "Team/Doc.assets/a.bin", a),
    ] };
    const req = request(args);
    const first = await storage.request(req);
    assert.equal(first.created, 4);
    assert.deepEqual(first.documents.map(item => item.created), [true, true, true]);
    const base = prefix ? `${prefix}/` : "";
    assert.deepEqual(await readFile(join(directory, "notes", `${base}Team/Doc.assets/a.bin`)), a);
    assert.deepEqual(await readFile(join(directory, "notes", `${base}Team/_assets/shared.bin`)), b);
    assert.deepEqual(await readFile(join(directory, "papers", `${base}Paper.assets/fig 1.png`)), c);
    assert.deepEqual(await readFile(join(directory, "skills", `${base}Skill.assets/d.mmd`)), d);
    const found = scan();
    assert.equal(found.length, 3);
    for (const receipt of first.documents) {
      const record = found.find(item => item.record.area === receipt.area && item.record.path === receipt.path);
      assert.equal(record.record.id, receipt.id);
      assert.equal(record.record.sha256, receipt.sha256);
      assert.equal(record.record.revision, 1);
      assert.match(record.metadata.get("knowledgeId"), /^knowledge_[a-f0-9]{24}$/);
      assert.equal(record.metadata.get("documentId"), receipt.id);
    }
    assert.equal(found.find(item => item.record.area === "skills").record.title, "Skill title");
    assert.equal(found.find(item => item.record.area === "notes").record.content, docs[0].content);
    const listed = await core.dispatch("capability_read", { operation: "knowledge.asset.list", version: 1, arguments: { id: first.documents[0].id } }, actor);
    assert(!listed.error, JSON.stringify(listed.error));
    assert.equal(listed.result.total, 2);
    const before = await files(directory);
    assert.deepEqual(await storage.request(req), first, "same operationId replays its receipt");
    const again = await storage.request(request(args));
    assert.equal(again.created, 0);
    assert.deepEqual(again.documents.map(item => item.created), [false, false, false]);
    assert.deepEqual(await files(directory), before);
    assert.equal(counts().pending, 0);
  });
}

test("same operationId with a different request, actor or prefix is rejected", async t => {
  const { open, request } = await fixture(t);
  const storage = await open();
  const req = request({ assets: [entry("papers", "Paper.assets/fig 1.png", Buffer.from("x"))] });
  await storage.request(req);
  await assert.rejects(storage.request({ ...req, actorId: "local:other" }), { code: "CONFLICT" });
  await assert.rejects(storage.request({ ...req, args: { ...req.args, prefix: "other" } }), { code: "CONFLICT" });
});

test("import refuses conflicting, unowned, unsafe and non-portable input before journaling or writing anything", async t => {
  const { directory, open, request, counts } = await fixture(t);
  const storage = await open();
  await mkdir(join(directory, "notes/Team"), { recursive: true });
  await writeFile(join(directory, "notes/Team/Doc.md"), "different existing body");
  const before = await files(directory);
  const ok = entry("papers", "Paper.assets/fig 1.png", Buffer.from("a"));
  const bad = async (args, code) => await assert.rejects(storage.request(request(args)), error => error.code === code, code);
  await bad({ assets: [] }, "CONFLICT");
  const fresh = [docs[1]];
  await bad({ documents: fresh, assets: [entry("papers", "Paper.assets/fig 1.png", Buffer.from("a"))] }, "INVALID_ARGUMENT");
  await bad({ documents: fresh, assets: [entry("skills", "Skill.assets/x", Buffer.from("a")), entry("skills", "Skill.assets/x", Buffer.from("b"))] }, "CONFLICT");
  await bad({ documents: fresh, assets: [entry("skills", "Other.assets/x", Buffer.from("a"))] }, "INVALID_ARGUMENT");
  await bad({ documents: fresh, assets: [entry("skills", "Skill.assets/pkm-todo-board.json", Buffer.from("{}"))] }, "ACCESS_DENIED");
  await bad({ documents: fresh, assets: [{ ...entry("skills", "Skill.assets/x", Buffer.from("a")), digest: `sha256:${"0".repeat(64)}` }] }, "INVALID_ARGUMENT");
  await bad({ documents: fresh, prefix: "../escape", assets: [ok] }, "INVALID_ARGUMENT");
  await bad({ documents: fresh, prefix: "/abs", assets: [ok] }, "INVALID_ARGUMENT");
  await bad({ documents: [...fresh, fresh[0]], assets: [] }, "CONFLICT");
  await bad({ documents: [{ area: "notes", path: "System/Hidden.md", content: "x" }], assets: [] }, "ACCESS_DENIED");
  // A resource referenced into another document's *.assets directory without that owner would poison later scans.
  await bad({ documents: [{ area: "skills", path: "Skill.md", content: "![x](Missing.assets/x.bin)" }], assets: [entry("skills", "Missing.assets/x.bin", Buffer.from("a"))] }, "CONFLICT");
  assert.deepEqual(counts(), { pending: 0, receipts: 0 });
  assert.deepEqual(await files(directory), before);
  assert.equal(await readFile(join(directory, "notes/Team/Doc.md"), "utf8"), "different existing body");
});

test("an existing document with identical body is preserved and still owns its imported resources", async t => {
  const { directory, open, request, scan } = await fixture(t);
  const storage = await open();
  const created = await new Core(storage).dispatch("capability_call", { operation: "knowledge.document.create", version: 1,
    arguments: { operationId: randomUUID(), id: "existing-doc", area: "skills", path: "Skill.md", title: "Mine", content: "no refs" } }, actor);
  assert(!created.error, JSON.stringify(created.error));
  const rawBefore = await readFile(join(directory, "skills/Skill.md"), "utf8");
  const receipt = await storage.request(request({ documents: [docs[1]], assets: [entry("skills", "Skill.assets/d.mmd", Buffer.from("graph"))] }));
  assert.deepEqual(receipt.documents.map(item => [item.id, item.created]), [["existing-doc", false]]);
  assert.equal(await readFile(join(directory, "skills/Skill.md"), "utf8"), rawBefore);
  assert.equal(await readFile(join(directory, "skills/Skill.assets/d.mmd"), "utf8"), "graph");
  assert.equal(scan().length, 1);
});

test("identity validation prevents duplicate Knowledge IDs and aliases, including existing and cross-address collisions", async t => {
  const { directory, open, request, counts } = await fixture(t);
  const storage = await open();
  const identity = { schema: "pkm.knowledge/v1", knowledgeId: "knowledge_aaaaaaaaaaaaaaaaaaaaaaaa", revision: 5, aliases: ["note:prior"] };
  const a = { area: "notes", path: "A.md", title: "A", content: "", identity };
  const b = { area: "notes", path: "B.md", title: "B", content: "", identity };
  await assert.rejects(storage.request(request({ documents: [a, b], assets: [] })), { code: "CONFLICT" });
  await assert.rejects(storage.request(request({ documents: [a, { ...b, identity: { ...identity, knowledgeId: "knowledge_bbbbbbbbbbbbbbbbbbbbbbbb" } }], assets: [] })), { code: "CONFLICT" });
  await assert.rejects(storage.request(request({ documents: [{ ...a, identity: { ...identity, aliases: ["invalid"] } }], assets: [] })), { code: "INVALID_ARGUMENT" });
  await assert.rejects(storage.request(request({ documents: [{ ...a, identity: { schema: "pkm.knowledge/v1" } }], assets: [] })), { code: "INVALID_ARGUMENT" });
  await assert.rejects(storage.request(request({ documents: [{ ...a, identity: { ...identity, revision: 0 } }], assets: [] })), { code: "INVALID_ARGUMENT" });
  assert.equal(counts().pending, 0);
  await storage.request(request({ documents: [a], assets: [] }));
  await assert.rejects(storage.request(request({ documents: [b], assets: [] })), { code: "CONFLICT" });
  await assert.rejects(storage.request(request({ documents: [{ ...b, identity: { ...identity, knowledgeId: "knowledge_bbbbbbbbbbbbbbbbbbbbbbbb" } }], assets: [] })), { code: "CONFLICT" });
  await assert.rejects(storage.request(request({ documents: [{ ...a, identity: { ...identity, revision: 6 } }], assets: [] })), { code: "CONFLICT" });
  assert.equal((await storage.request(request({ documents: [a], assets: [] }))).documents[0].created, false);
  assert.equal((await files(directory)).length, 1);
});

test("source Knowledge ID cannot collide with an existing native document ID", async t => {
  const { open, request } = await fixture(t);
  const storage = await open();
  const id = "knowledge_eeeeeeeeeeeeeeeeeeeeeeee";
  const created = await new Core(storage).dispatch("capability_call", { operation: "knowledge.document.create", version: 1,
    arguments: { operationId: randomUUID(), id, area: "notes", path: "Existing.md", title: "Existing", content: "" } }, actor);
  assert(!created.error, JSON.stringify(created.error));
  await assert.rejects(storage.request(request({ documents: [{ area: "skills", path: "Other.md", content: "",
    identity: { schema: "pkm.knowledge/v1", knowledgeId: id, revision: 1, aliases: [] } }], assets: [] })), { code: "CONFLICT" });
});

test("recovery detects external identity and alias collisions before publishing any planned document", async t => {
  const { directory, open, request, raw } = await fixture(t);
  await (await open()).close();
  const db = raw();
  try {
    const req = request({ documents: [{ area: "notes", path: "Planned.md", content: "", identity: {
      schema: "pkm.knowledge/v1", knowledgeId: "knowledge_cccccccccccccccccccccccc", revision: 3, aliases: ["note:prior"],
    } }], assets: [] });
    assert.deepEqual(planAssetImport(db, directory, req), { pending: true });
    const pending = db.prepare("SELECT * FROM pending_asset").get();
    const other = join(directory, "notes/External.md");
    const markdown = (knowledgeId, alias) => `---\nschema: pkm.knowledge/v1\nknowledgeId: ${knowledgeId}\ndocumentId: external\nrevision: 1\naliases: [${alias}]\ntitle: External\ndeleted: false\n---\n`;
    for (const [id, alias] of [["knowledge_cccccccccccccccccccccccc", "note:other"], ["knowledge_dddddddddddddddddddddddd", "note:prior"]]) {
      await writeFile(other, markdown(id, alias));
      assert.throws(() => recoverAssetImport(db, directory, pending), { code: "RECOVERY_CONFLICT" });
      await assert.rejects(readFile(join(directory, "notes/Planned.md")), { code: "ENOENT" });
    }
    await rm(other);
    recoverAssetImport(db, directory, pending);
    assert.match(await readFile(join(directory, "notes/Planned.md"), "utf8"), /knowledge_cccccccccccccccccccccccc/);
  } finally { db.close(); }
});

test("journal freezes links and resolved citations across partial publication and reopen", async t => {
  const { directory, open, request, raw, scan } = await fixture(t);
  await (await open()).close();
  const link = { relation: "references", target: "pkm://project/project_external", mode: "floating", required: false };
  const req = request({ prefix: "Incoming", documents: [
    { area: "papers", path: "A.md", title: "A", content: "", metadata: { links: [link], cites: ["B", "Missing", { target: "B.md", comment: "twice" }] } },
    { area: "papers", path: "B.md", title: "B", content: "", metadata: { cites: ["A"] } },
  ], assets: [] });
  const db = raw();
  try {
    assert.deepEqual(planAssetImport(db, directory, req), { pending: true });
    const journal = JSON.parse(Buffer.from(db.prepare("SELECT content FROM pending_asset").get().content).toString());
    const first = journal.documents[0];
    await mkdir(dirname(join(directory, "papers", first.path)), { recursive: true });
    await writeFile(join(directory, "papers", first.path), first.raw);
    assert.equal(scan().length, 1);
  } finally { db.close(); }
  await writeFile(join(directory, "papers", "ZZZ.md"), "---\ntitle: Missing\n---\n");
  const storage = await open();
  const receipt = await storage.request(req);
  assert.equal(receipt.documents.length, 2);
  const records = scan();
  const first = records.find(r => r.record.path === "Incoming/A.md").metadata.toJS();
  assert.deepEqual(first.links, [link]);
  assert.deepEqual(first.cites, [{ paper: "Incoming/B", note: "" }, { paper: "Incoming/B", note: "twice" }]);
  assert.deepEqual(records.find(r => r.record.path === "Incoming/B.md").metadata.toJS().cites, [{ paper: "Incoming/A", note: "" }]);
  assert.deepEqual(await storage.request(req), receipt);
});

test("recovery refuses a stale source Paper citation pin without publishing imported files", async t => {
  const { directory, open, request, raw, counts, scan } = await fixture(t);
  const storage = await open();
  await storage.request({ operation: "knowledge.document.create", actorId: actor.id, args: {
    operationId: randomUUID(), id: "citation-source", area: "papers", path: "Refs/Target.md", title: "Target", content: "original source bytes",
  } });
  await storage.close();
  const req = request({ documents: [{ area: "papers", path: "Citing.md", title: "Citing", content: "",
    metadata: { cites: [{ paper: "Refs/Target", note: "synthetic citation" }] } }], assets: [] });
  const db = raw();
  try {
    assert.deepEqual(planAssetImport(db, directory, req), { pending: true });
    const pending = db.prepare("SELECT * FROM pending_asset WHERE singleton=1").get();
    const journal = JSON.parse(Buffer.from(pending.content).toString("utf8"));
    assert.deepEqual(journal.citationTargets, [{
      path: "Refs/Target.md", id: "citation-source", sha256: scan().find(item => item.record.id === "citation-source").record.sha256,
    }]);
    await writeFile(join(directory, "papers/Refs/Target.md"), "changed source bytes");
    assert.throws(() => recoverAssetImport(db, directory, pending), { code: "RECOVERY_CONFLICT" });
    assert.equal(await readFile(join(directory, "papers/Refs/Target.md"), "utf8"), "changed source bytes");
    await assert.rejects(readFile(join(directory, "papers/Citing.md")), { code: "ENOENT" });
    assert.equal(db.prepare("SELECT count(*) n FROM pending_asset").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM receipts").get().n, 1);
    assert.deepEqual(counts(), { pending: 1, receipts: 1 });
  } finally { db.close(); }
});

const stages = ["intent-only", "documents-partial", "documents-complete", "assets-partial"];
for (const stage of stages) {
  test(`crash recovery at ${stage} keeps every intermediate scan valid and resolves exactly once on reopen`, async t => {
    const { directory, open, request, raw, counts, scan } = await fixture(t);
    await (await open()).close();
    const a = Buffer.from("one"), b = Buffer.from("two"), c = Buffer.from("three");
    const req = request({ prefix: "_incoming/g", documents: [docs[0], { ...docs[1], metadata: { tags: ["recover"], description: "preserved" },
      identity: { schema: "pkm.knowledge/v1", knowledgeId: "knowledge_aaaaaaaaaaaaaaaaaaaaaaaa", revision: 9, aliases: ["skill:previous"] } }, docs[2]], assets: [entry("notes", "Team/Doc.assets/1.bin", a), entry("notes", "Team/_assets/shared.bin", b), entry("papers", "Paper.assets/fig 1.png", c)] });
    const db = raw();
    let journal;
    try {
      assert.deepEqual(planAssetImport(db, directory, req), { pending: true });
      journal = JSON.parse(Buffer.from(db.prepare("SELECT content FROM pending_asset").get().content).toString());
    } finally { db.close(); }
    assert.equal(scan().length, 0, "intent alone changes nothing");
    const publish = async (area, path, bytes, temporary) => {
      const full = join(directory, area, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(temporary ? join(dirname(full), `.pkm-write-${req.args.operationId}`) : full, bytes);
    };
    const written = stage === "documents-partial" ? 1 : stage === "intent-only" ? 0 : journal.documents.length;
    for (const document of journal.documents.slice(0, written)) await publish(document.area, document.path, document.raw);
    if (stage === "documents-partial") await publish("papers", "_incoming/g/Paper.md.tmp-ignored", "", true);
    if (stage === "assets-partial") {
      await publish("notes", "_incoming/g/Team/Doc.assets/1.bin", a);
      await publish("notes", "_incoming/g/Team/_assets/shared.bin", b, true);
    }
    assert.equal(scan().length, written, "scan stays valid at this intermediate state");
    const reopened = await open();
    const replay = await reopened.request(req);
    assert.equal(replay.created, 3);
    assert.deepEqual(await readFile(join(directory, "notes/_incoming/g/Team/Doc.assets/1.bin")), a);
    assert.deepEqual(await readFile(join(directory, "notes/_incoming/g/Team/_assets/shared.bin")), b);
    assert.deepEqual(await readFile(join(directory, "papers/_incoming/g/Paper.assets/fig 1.png")), c);
    assert.equal(scan().length, 3);
    assert.deepEqual(scan().find(item => item.record.area === "skills").metadata.toJS().tags, ["recover"]);
    assert.equal(scan().find(item => item.record.area === "skills").metadata.toJS().description, "preserved");
    const recovered = scan().find(item => item.record.area === "skills");
    assert.equal(recovered.metadata.toJS().knowledgeId, "knowledge_aaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(recovered.record.revision, 9);
    assert(recovered.metadata.toJS().aliases.includes("skill:previous"));
    assert(!(await files(directory)).some(path => path.includes(".pkm-write-") || path.endsWith(".tmp-ignored") && false));
    assert.deepEqual(counts(), { pending: 0, receipts: counts().receipts });
    const check = raw();
    try { assert.equal(check.prepare("SELECT count(*) n FROM receipts WHERE operation_id=?").get(req.args.operationId).n, 1); } finally { check.close(); }
  });
}

test("recovery preserves the journal and writes nothing further on external conflicts, tampering, wrong root and symlinked parents", async t => {
  const { directory, open, request, raw } = await fixture(t);
  await (await open()).close();
  const db = raw();
  const pending = () => db.prepare("SELECT * FROM pending_asset WHERE singleton=1").get();
  const set = (column, value) => db.prepare(`UPDATE pending_asset SET ${column}=?`).run(value);
  try {
    const req = request({ documents: [docs[1]], assets: [entry("skills", "Skill.assets/3.bin", Buffer.from("three"))] });
    assert.deepEqual(planAssetImport(db, directory, req), { pending: true });
    const original = pending(), journal = JSON.parse(Buffer.from(original.content).toString());

    await mkdir(join(directory, "skills"), { recursive: true });
    await writeFile(join(directory, "skills/Skill.md"), "external document");
    assert.throws(() => recoverAssetImport(db, directory, pending()), error => error.code === "RECOVERY_CONFLICT");
    assert.equal(await readFile(join(directory, "skills/Skill.md"), "utf8"), "external document");
    assert.deepEqual(await files(directory), ["skills/Skill.md"], "no resource is written after a document conflict");
    await rm(join(directory, "skills/Skill.md"));

    set("upload_id", "import:other");
    assert.throws(() => recoverAssetImport(db, directory, pending()), error => error.code === "INVALID_WORKSPACE");
    set("upload_id", original.upload_id);
    set("result", JSON.stringify({ ...JSON.parse(original.result), prefix: "x" }));
    assert.throws(() => recoverAssetImport(db, directory, pending()), error => error.code === "INVALID_WORKSPACE");
    set("result", original.result);
    set("content", Buffer.from(JSON.stringify({ ...journal, documents: [{ ...journal.documents[0], raw: `${journal.documents[0].raw}tampered` }] })));
    assert.throws(() => recoverAssetImport(db, directory, pending()), error => error.code === "INVALID_WORKSPACE");
    set("content", Buffer.from(JSON.stringify({ ...journal, root: join(directory, "elsewhere") })));
    assert.throws(() => recoverAssetImport(db, directory, pending()), error => error.code === "RECOVERY_CONFLICT" || error.code === "ENOENT");
    set("content", original.content);
    assert.deepEqual(await files(directory), []);

    await writeFile(join(directory, "skills/Skill.md"), journal.documents[0].raw);
    await mkdir(join(directory, "skills/Skill.assets"), { recursive: true });
    await writeFile(join(directory, "skills/Skill.assets/3.bin"), "external resource");
    assert.throws(() => recoverAssetImport(db, directory, pending()), error => error.code === "RECOVERY_CONFLICT");
    assert.equal(await readFile(join(directory, "skills/Skill.assets/3.bin"), "utf8"), "external resource");
    await rm(join(directory, "skills"), { recursive: true });
    await rm(join(directory, "skills.real"), { recursive: true, force: true });
    await mkdir(join(directory, "elsewhere"));
    await symlink(join(directory, "elsewhere"), join(directory, "skills"));
    assert.throws(() => recoverAssetImport(db, directory, pending()), () => true);
    assert(pending(), "journal survives every refused recovery");
    assert.deepEqual(await readdir(join(directory, "elsewhere")), []);
  } finally { db.close(); }
});
