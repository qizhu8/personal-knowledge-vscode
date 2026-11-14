import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, rm, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  documentLifecycleDefinitions, documentLifecycleLimits, readDocumentLifecycle, planDocumentLifecycle,
  serializeDocumentLifecyclePlan, deserializeDocumentLifecyclePlan, applyDocumentLifecycle, recoverDocumentLifecycle,
} from "../dist/document-lifecycle.js";
import { scanMarkdown, sha256 } from "../dist/markdown.js";
import { rebaseMarkdownAssets, documentLifecycleAssetRules } from "../dist/domain/document-lifecycle-original.js";
import { documentLifecycleFilestoreRules } from "../dist/domain/document-lifecycle-filestore.js";
import { checkCaptureRecords, packageRoot } from "../scripts/migration.mjs";
import { documentLifecycleTransportFixture } from "./document-lifecycle-transport-fixture.mjs";

const tests = dirname(fileURLToPath(import.meta.url));
const code = expected => error => { assert.equal(error.code, expected, error.message); return true; };
async function fixture(t, { area = "notes", path = "Old/Nested/Doc.md", destinationPath = "New/Deep/Renamed.md", body = "![resource](Doc.assets/nested/image%20one.bin?download=1#view)\n", header = "documentId: owner\nrevision: 7\n", assets = true } = {}) {
  const root = join(tests, `.document-lifecycle-${randomUUID()}`);
  await mkdir(join(root, "notes"), { recursive: true });
  await mkdir(join(root, area), { recursive: true });
  t.after(() => rm(root, { force: true, recursive: true }));
  async function put(area, path, bytes) {
    await mkdir(dirname(join(root, area, path)), { recursive: true });
    await writeFile(join(root, area, path), bytes);
  }
  const raw = `---\r\n${header.replaceAll("\n", "\r\n")}title: "Unchanged title"\r\ncustom: [a, b]\r\n---\r\n${body}`;
  await put(area, path, raw);
  const content = Buffer.from([0, 255, 13, 10, 0, 128]);
  const assetPath = `${path.replace(/\.md$/i, ".assets")}/nested/image one.bin`;
  if (assets) {
    await put(area, assetPath, content);
    await mkdir(join(root, area, path.replace(/\.md$/i, ".assets"), "empty"), { recursive: true });
  }
  function documents() { return scanMarkdown(root); }
  function args() {
    const owner = documents().find(document => document.record.path === path && document.record.area === area);
    return { id: owner.record.id, area, path, destinationPath, expectedRevision: 7, expectedSha256: sha256(raw) };
  }
  function preview(extras = {}, snapshot = documents()) {
    return readDocumentLifecycle(root, snapshot, { operation: "knowledge.document.lifecycle.preview", actorId: "test:owner", args: { ...args(), ...extras } });
  }
  function plan(extras = {}, pins = preview()) {
    return planDocumentLifecycle(root, documents(), { operation: "knowledge.document.move", actorId: "test:owner", args: {
      ...args(), operationId: randomUUID(), expectedScanRevision: pins.scanRevision, expectedPairedTreeDigest: pins.pairedAssets.digest,
      expectedDestinationSha256: null, expectedDestinationTreeDigest: null, ...extras,
    } });
  }
  return { root, area, path, destinationPath, raw, content, assetPath, put, documents, args, preview, plan };
}
async function crash(f, plan, phase) {
  const paired = plan.pairedTree;
  if (phase >= 1 && paired.digest !== null) {
    await mkdir(dirname(join(f.root, f.area, paired.afterPath)), { recursive: true });
    await rename(join(f.root, f.area, paired.beforePath), join(f.root, f.area, paired.afterPath));
  }
  if (phase >= 2) await f.put(f.area, plan.changes[0].path, plan.changes[0].after);
  if (phase >= 3) await unlink(join(f.root, f.area, f.path));
}
async function assertAfter(f, plan) {
  await assert.rejects(readFile(join(f.root, f.area, f.path)), { code: "ENOENT" });
  assert.deepEqual(await readFile(join(f.root, f.area, f.destinationPath)), plan.changes[0].after);
  const moved = scanMarkdown(f.root).find(document => document.record.id === "owner");
  assert.equal(moved.record.path, f.destinationPath);
  assert.equal(moved.record.revision, 7);
  assert.equal(moved.metadata.get("title"), "Unchanged title");
  if (plan.pairedTree.digest !== null) {
    assert.deepEqual(await readFile(join(f.root, f.area, plan.pairedTree.afterPath, "nested/image one.bin")), f.content);
    assert.deepEqual(await readdir(join(f.root, f.area, plan.pairedTree.afterPath, "empty")), []);
    await assert.rejects(readdir(join(f.root, f.area, plan.pairedTree.beforePath)), { code: "ENOENT" });
  }
}

test("schema-only exports are safe in both ESM import orders", () => {
  for (const first of ["document-lifecycle-contracts", "document-lifecycle", "contracts"]) {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      await import("./dist/${first}.js");
      const definitions = await import("./dist/document-lifecycle-contracts.js");
      const executor = await import("./dist/document-lifecycle.js");
      if (definitions.documentLifecycleDefinitions !== executor.documentLifecycleDefinitions) process.exit(1);
    `], { cwd: packageRoot, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
  }
});

for (const area of ["notes", "skills", "papers"]) {
  test(`${area}: substantial nested paired move, exact bytes and stable identity, pure serializable plan`, async t => {
    const f = await fixture(t, { area });
    const preview = f.preview(), plan = f.plan();
    assert.equal(preview.destinationAbsent, true);
    assert.equal(preview.pairedAssets.files, 1);
    assert.equal(preview.pairedAssets.bytes, f.content.length);
    assert.equal(preview.referenceRewriteRequired, true);
    assert.equal(plan.requiresCompoundJournal, true);
    assert.deepEqual(await readFile(join(f.root, area, f.path)), Buffer.from(f.raw));
    assert.deepEqual(await readFile(join(f.root, area, f.assetPath)), f.content);
    await assert.rejects(readFile(join(f.root, area, f.destinationPath)), { code: "ENOENT" });
    const roundtrip = deserializeDocumentLifecyclePlan(serializeDocumentLifecyclePlan(plan));
    assert.deepEqual(roundtrip, plan);
    const exact = f.raw.replace("Doc.assets/nested/image%20one.bin?download=1#view", "Renamed.assets/nested/image%20one.bin?download=1#view");
    assert.equal(plan.changes[0].after.toString(), exact);
    assert.equal(plan.result.document.afterSha256, sha256(exact));
    assert.deepEqual(applyDocumentLifecycle(f.root, roundtrip, plan.operationId), plan.result);
    await assertAfter(f, plan);
    assert.deepEqual(recoverDocumentLifecycle(f.root, plan, plan.operationId), plan.result);
    assert(documentLifecycleDefinitions[1].output.safeParse(plan.result).success);
  });
}

test("unchanged original rebase preserves fences, ordinary links, query/fragment and frontmatter while rebasing owned and other paired resources", async t => {
  const body = [
    "![nested [label]](Doc.assets/nested/image%20one.bin?q=1#x)",
    '<img src="Doc.assets/nested/image%20one.bin">',
    "[resource]: <Doc.assets/nested/image%20one.bin>",
    'file: "Doc.assets/nested/image%20one.bin"',
    "[other](../Other.assets/x.bin?other=1)",
    "[ordinary](../Other.md)",
    "`![code](Doc.assets/nested/image%20one.bin)`",
    "```\n![fenced](Doc.assets/nested/image%20one.bin)\n```",
    "~~~\n![fenced](Doc.assets/nested/image%20one.bin)\n~~~",
    "[web](https://example.invalid/a.assets/x)",
  ].join("\r\n");
  const f = await fixture(t, { body });
  await f.put("notes", "Old/Other.md", "---\ndocumentId: other\n---\nOther");
  await f.put("notes", "Old/Other.assets/x.bin", "other resource");
  const plan = f.plan(), after = plan.changes[0].after.toString();
  assert.equal(after, rebaseMarkdownAssets(join(f.root, "notes"), f.path, f.destinationPath, f.raw));
  assert(after.includes("[other](../../Old/Other.assets/x.bin?other=1)"));
  assert(after.includes("[ordinary](../Other.md)"));
  assert(after.includes("`![code](Doc.assets/nested/image%20one.bin)`"));
  assert(after.startsWith(f.raw.slice(0, f.raw.indexOf("---\r\n", 5) + 5)));
  applyDocumentLifecycle(f.root, plan, plan.operationId);
  assert.equal(await readFile(join(f.root, "notes", "Old/Other.assets/x.bin"), "utf8"), "other resource");
});

for (const phase of [0, 1, 2, 3]) {
  test(`durable recovery accepts only exact ordered crash phase ${phase}`, async t => {
    const f = await fixture(t), plan = f.plan();
    const persisted = serializeDocumentLifecyclePlan(plan);
    await crash(f, plan, phase);
    const loaded = deserializeDocumentLifecyclePlan(persisted);
    assert.deepEqual(recoverDocumentLifecycle(f.root, loaded, loaded.operationId), loaded.result);
    await assertAfter(f, loaded);
  });
}
for (const assets of [false, true]) {
  test(`empty/no-tree move has exact recoverable digest (${assets})`, async t => {
    const f = await fixture(t, { assets, body: "No resources\n" });
    if (assets) {
      await unlink(join(f.root, f.area, f.assetPath));
      await rm(dirname(join(f.root, f.area, f.assetPath)), { recursive: true });
    }
    const plan = f.plan();
    assert.equal(plan.result.pairedAssets.files, 0);
    assert.equal(plan.result.pairedAssets.digest === null, !assets);
    await crash(f, plan, 2);
    recoverDocumentLifecycle(f.root, plan, plan.operationId);
    assert.equal((await readFile(join(f.root, f.area, f.destinationPath), "utf8")), f.raw);
  });
}

test("exact fully written staging can recover; partial/foreign staging refuses without touching source", async t => {
  for (const full of [true, false]) {
    const f = await fixture(t), plan = f.plan();
    await crash(f, plan, 1);
    const staged = join(dirname(f.destinationPath), `.pkm-write-${plan.operationId}`);
    await f.put(f.area, staged, full ? plan.changes[0].after : Buffer.from("incomplete"));
    if (full) {
      recoverDocumentLifecycle(f.root, plan, plan.operationId);
      await assertAfter(f, plan);
    } else {
      assert.throws(() => recoverDocumentLifecycle(f.root, plan, plan.operationId), code("RECOVERY_CONFLICT"));
      assert.equal(await readFile(join(f.root, f.area, f.path), "utf8"), f.raw);
      assert.equal(await readFile(join(f.root, f.area, staged), "utf8"), "incomplete");
    }
  }
});

test("pin conflicts: SHA, revision, scan, paired digest, both destination absences", async t => {
  const f = await fixture(t);
  assert.throws(() => f.preview({ expectedSha256: "0".repeat(64) }), code("CONFLICT"));
  assert.throws(() => f.preview({ expectedRevision: 8 }), code("CONFLICT"));
  assert.throws(() => f.plan({ expectedScanRevision: "0".repeat(64) }), code("CONFLICT"));
  assert.throws(() => f.plan({ expectedPairedTreeDigest: "0".repeat(64) }), code("CONFLICT"));
  assert.throws(() => f.plan({ expectedDestinationSha256: "0".repeat(64) }), code("INVALID_ARGUMENT"));
  const before = f.preview();
  await f.put("papers", "New.md", "---\ndocumentId: paper\n---\nNew");
  assert.throws(() => f.plan({}, before), code("CONFLICT"));
  await f.put(f.area, f.assetPath, Buffer.from("changed resource"));
  assert.throws(() => f.plan({}, before), code("CONFLICT"));
  await f.put(f.area, f.destinationPath, "---\ndocumentId: collision\n---\nCollision");
  assert.throws(() => f.preview(), code("CONFLICT"));
});

test("destination tree must be absent even without source assets", async t => {
  const f = await fixture(t, { assets: false });
  const documents = f.documents(), args = f.args();
  await mkdir(join(f.root, f.area, f.destinationPath.replace(/\.md$/i, ".assets")), { recursive: true });
  assert.throws(() => readDocumentLifecycle(f.root, documents, { operation: "knowledge.document.lifecycle.preview", actorId: "test", args }), code("CONFLICT"));
});

test("paired move never replaces a document or asset-tree destination created after planning", async t => {
  for (const target of ["document", "assets"]) {
    const f = await fixture(t);
    const plan = f.plan();
    const documentTarget = join(f.root, f.area, f.destinationPath);
    const assetsTarget = join(f.root, f.area, f.destinationPath.replace(/\.md$/i, ".assets"));
    if (target === "document") await f.put(f.area, f.destinationPath, "external document");
    else await mkdir(assetsTarget, { recursive: true });
    assert.throws(() => applyDocumentLifecycle(f.root, plan, plan.operationId), code("RECOVERY_CONFLICT"));
    assert.equal(await readFile(join(f.root, f.area, f.path), "utf8"), f.raw);
    assert.deepEqual(await readFile(join(f.root, f.area, f.assetPath)), f.content);
    if (target === "document") assert.equal(await readFile(documentTarget, "utf8"), "external document");
    else assert.deepEqual(await readdir(assetsTarget), []);
  }
});

test("shared-source trees and destination reference activation are refused across all three areas", async t => {
  for (const area of ["notes", "skills", "papers"]) for (const destination of [false, true]) {
    const f = await fixture(t);
    const reference = destination ? "../notes/New/Deep/Renamed.assets/not-yet-present.bin" : "../notes/Old/Nested/Doc.assets/nested/image%20one.bin";
    await f.put(area, "Other.md", `---\ndocumentId: other-${area}\n---\n[shared](${reference})`);
    assert.throws(() => f.preview(), code("CONFLICT"));
  }
});

test("legacy path-only identities, legacy _assets, Todo and memory are explicit refusals", async t => {
  const legacy = await fixture(t, { header: "revision: 7\n" });
  assert.throws(() => legacy.preview(), code("UNSUPPORTED_OPERATION"));
  const resources = await fixture(t, { body: "[legacy](../_assets/a.bin)" });
  await resources.put("notes", "Old/_assets/a.bin", "legacy");
  assert.throws(() => resources.preview(), code("UNSUPPORTED_OPERATION"));
  for (const header of ["documentId: owner\nrevision: 7\ndocumentKind: todo-board\n", "documentId: owner\nrevision: 7\nmemory:\n  schema: pkm.explicit-memory/v1\n"]) {
    const f = await fixture(t, { header });
    assert.throws(() => f.preview(), code("ACCESS_DENIED"));
  }
  const backing = await fixture(t);
  await backing.put("notes", "Old/Nested/Doc.assets/pkm-todo-board.json", "{}");
  assert.throws(() => backing.preview(), code("ACCESS_DENIED"));
});

test("explicit knowledge identity and stable prototype alias survive exact-byte moves", async t => {
  for (const header of [
    "knowledgeId: owner\nrevision: 7\n",
    'schema: pkm.knowledge/v1\nknowledgeId: knowledge-owner\naliases: ["note:owner"]\nrevision: 7\ndeleted: false\n',
  ]) {
    const f = await fixture(t, { header });
    const plan = f.plan();
    applyDocumentLifecycle(f.root, plan, plan.operationId);
    await assertAfter(f, plan);
  }
});

test("symlinks and unknown files fail closed in source, paired tree, references and destination parents", async t => {
  for (const target of ["paired", "unknown", "destination", "reference"]) {
    const f = await fixture(t);
    const documents = f.documents(), args = f.args();
    if (target === "paired") await symlink(join(f.root, f.area, f.path), join(f.root, f.area, "Old/Nested/Doc.assets/link.bin"));
    if (target === "unknown") await f.put("papers", "unknown.txt", "unknown");
    if (target === "destination") await symlink(join(f.root, f.area, "Old"), join(f.root, f.area, "New"));
    if (target === "reference") await symlink(join(f.root, f.area, f.path), join(f.root, f.area, "link.md"));
    assert.throws(() => readDocumentLifecycle(f.root, documents, { operation: "knowledge.document.lifecycle.preview", actorId: "test", args }), code("INVALID_DOCUMENT"));
  }
});

test("tampered persisted bytes, writes, identity, tree entries, pins and operationId are never replayed", async t => {
  const f = await fixture(t), plan = f.plan(), original = serializeDocumentLifecyclePlan(plan);
  for (const mutate of [
    value => { value.changes[0].after = Buffer.from("invented").toString("base64"); },
    value => { value.changes[0].path = "Another.md"; },
    value => { value.changes[1].expectedSha256 = "0".repeat(64); },
    value => { value.documentCas.id = "other"; },
    value => { value.result.document.afterSha256 = "0".repeat(64); },
    value => { value.referencePins = []; },
    value => { value.pairedTree.entries.push(value.pairedTree.entries[0]); },
    value => { value.actorId = ""; },
    value => { value.changes[0].after += "="; },
  ]) {
    const changed = JSON.parse(original); mutate(changed);
    assert.throws(() => deserializeDocumentLifecyclePlan(JSON.stringify(changed)));
  }
  assert.throws(() => recoverDocumentLifecycle(f.root, plan, randomUUID()), code("INVALID_WORKSPACE"));
  assert.equal(await readFile(join(f.root, f.area, f.path), "utf8"), f.raw);
});

test("recovery preflights every tree/document/reference before any next write", async t => {
  for (const external of ["asset", "unknown-tree-file", "source", "destination", "reference", "source-tree-copy", "impossible-order"]) {
    const f = await fixture(t), plan = f.plan();
    await crash(f, plan, 1);
    if (external === "asset") await f.put(f.area, "New/Deep/Renamed.assets/nested/image one.bin", "external");
    if (external === "unknown-tree-file") await f.put(f.area, "New/Deep/Renamed.assets/new.bin", "external");
    if (external === "source") await f.put(f.area, f.path, f.raw + "\nExternal");
    if (external === "destination") await f.put(f.area, f.destinationPath, "---\ndocumentId: intruder\n---\nExternal");
    if (external === "reference") await f.put("skills", "External.md", "---\ndocumentId: ext\n---\nExternal");
    if (external === "source-tree-copy") await mkdir(join(f.root, f.area, "Old/Nested/Doc.assets"), { recursive: true });
    if (external === "impossible-order") await unlink(join(f.root, f.area, f.path));
    assert.throws(() => recoverDocumentLifecycle(f.root, plan, plan.operationId));
    if (external !== "destination") await assert.rejects(readFile(join(f.root, f.area, f.destinationPath)), { code: "ENOENT" });
  }
});

test("out-of-order destination document with unmoved paired tree is not a valid partial phase", async t => {
  const f = await fixture(t), plan = f.plan();
  await f.put(f.area, f.destinationPath, plan.changes[0].after);
  assert.throws(() => recoverDocumentLifecycle(f.root, plan, plan.operationId), code("RECOVERY_CONFLICT"));
  assert.deepEqual(await readFile(join(f.root, f.area, f.assetPath)), f.content);
});

test("document lifecycle scans beyond former count and Markdown byte ceilings", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 2048; i++) {
    await f.put("skills", `extra-${i}.md`, `---\ndocumentId: extra-${i}\n---\nExtra`);
  }
  for (let i = 0; i < 17; i++) {
    await f.put("papers", `large-${i}.md`, `---\ndocumentId: large-${i}\n---\n${"x".repeat(1_000_000)}`);
  }
  const snapshot = f.documents(), args = f.args();
  const preview = readDocumentLifecycle(f.root, snapshot, {
    operation: "knowledge.document.lifecycle.preview", actorId: "test", args,
  });
  assert.equal(preview.scannedDocuments, 2066);
  assert(preview.scannedBytes > 16 * 1024 * 1024);
  const oversized = await fixture(t), owner = oversized.documents(), pins = oversized.args();
  await oversized.put("notes", oversized.assetPath, Buffer.alloc(documentLifecycleLimits.fileBytes + 1));
  assert.throws(() => readDocumentLifecycle(oversized.root, owner, { operation: "knowledge.document.lifecycle.preview", actorId: "test", args: pins }), code("CONFLICT"));
  const deep = await fixture(t);
  assert.throws(() => deep.preview({ destinationPath: `${"nested/".repeat(33)}Doc.md` }), code("INVALID_ARGUMENT"));
});

test("paired entry count and aggregate byte limits fail before applying any move", async t => {
  const many = await fixture(t), snapshot = many.documents(), args = many.args();
  for (let i = 0; i < documentLifecycleLimits.assetEntries; i++) await many.put("notes", `Old/Nested/Doc.assets/entry-${i}.bin`, "");
  assert.throws(() => readDocumentLifecycle(many.root, snapshot, { operation: "knowledge.document.lifecycle.preview", actorId: "test", args }), code("INVALID_WORKSPACE"));
  const large = await fixture(t), largeSnapshot = large.documents(), largeArgs = large.args();
  for (let i = 0; i < 4; i++) {
    const path = `Old/Nested/Doc.assets/large-${i}.bin`;
    await large.put("notes", path, "");
    await truncate(join(large.root, "notes", path), documentLifecycleLimits.fileBytes);
  }
  assert.throws(() => readDocumentLifecycle(large.root, largeSnapshot, { operation: "knowledge.document.lifecycle.preview", actorId: "test", args: largeArgs }), code("INVALID_WORKSPACE"));
  assert.equal(await readFile(join(large.root, "notes", large.path), "utf8"), large.raw);
  await assert.rejects(readFile(join(large.root, "notes", large.destinationPath)), { code: "ENOENT" });
});

test("over-deep owned trees remain rejected", async t => {
  const deep = await fixture(t);
  await mkdir(join(deep.root, "notes", "Old/Nested/Doc.assets", ...Array(33).fill("nested")), { recursive: true });
  assert.throws(() => deep.preview(), code("INVALID_WORKSPACE"));
});

test("source paired-tree pin detects empty-directory additions and actual before/after plan bytes are immutable", async t => {
  const f = await fixture(t), preview = f.preview();
  await mkdir(join(f.root, "notes", "Old/Nested/Doc.assets/new-empty"));
  assert.throws(() => f.plan({}, preview), code("CONFLICT"));
  const plan = f.plan();
  plan.changes[0].after[0] ^= 1;
  assert.throws(() => applyDocumentLifecycle(f.root, plan, plan.operationId), code("INVALID_WORKSPACE"));
  assert.equal(await readFile(join(f.root, "notes", f.path), "utf8"), f.raw);
});

test("provenance is repeatable and verified by shared migration checker; evidence preserves original rules", async () => {
  const path = resolve(packageRoot, "migration/document-lifecycle-provenance.json");
  const before = await readFile(path, "utf8");
  const child = spawnSync(process.execPath, ["scripts/capture-document-lifecycle.mjs", "--check"], { cwd: packageRoot, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(await readFile(path, "utf8"), before);
  const metadata = JSON.parse(before);
  assert.deepEqual(await checkCaptureRecords(metadata.files), []);
  assert.match(documentLifecycleAssetRules.rebaseMarkdownAssets, /rewriteMarkdownAssetReferences/);
  assert.match(documentLifecycleAssetRules.markdownResourceReferrer, /Resource|reference|target/);
  assert.match(documentLifecycleFilestoreRules.writeKnowledgeMarkdownUnlocked, /assertMarkdownAssetsUnshared/);
  assert.match(documentLifecycleFilestoreRules.writeKnowledgeMarkdownUnlocked, /migrateMarkdownAssetsForLifecycleUnlocked/);
});

test("complete transport fixture persists exact args, actor, result and recoverable intent", async t => {
  const f = await fixture(t);
  let durable;
  const transport = await documentLifecycleTransportFixture(f.root, f.documents(), "test:transport", f.args(), async value => { durable = value; });
  assert.equal(durable.operation, "knowledge.document.move");
  assert.deepEqual(durable.args, transport.args);
  assert.equal(durable.actorId, "test:transport");
  assert.deepEqual(durable.result, transport.plan.result);
  const pending = deserializeDocumentLifecyclePlan(durable.intent);
  assert.deepEqual(recoverDocumentLifecycle(f.root, pending, durable.operationId), transport.result);
  await assertAfter(f, pending);
});
