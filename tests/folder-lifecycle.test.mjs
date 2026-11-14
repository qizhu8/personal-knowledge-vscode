import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  applyFolderLifecycle, deserializeFolderLifecyclePlan, folderLifecycleDefinitions, folderLifecycleLimits,
  planFolderLifecycle, readFolderLifecycle, recoverFolderLifecycle, serializeFolderLifecyclePlan,
} from "../dist/folder-lifecycle.js";
import { scanMarkdown, sha256 } from "../dist/markdown.js";
import { folderLifecycleOriginalRules } from "../dist/domain/folder-lifecycle-original.js";
import { checkCaptureRecords, packageRoot } from "../scripts/migration.mjs";
import { folderLifecycleTransportFixture } from "./folder-lifecycle-fixture.mjs";

const tests = dirname(fileURLToPath(import.meta.url));
const errorCode = expected => error => { assert.equal(error.code, expected, error.message); return true; };

async function fixture(t) {
  const root = join(tests, `.folder-lifecycle-${randomUUID()}`);
  await mkdir(join(root, "notes"), { recursive: true });
  t.after(() => rm(root, { force: true, recursive: true }));
  async function put(area, path, value) {
    const full = join(root, area, ...path.split("/"));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, value);
  }
  const one = [
    "---",
    "# original frontmatter comment",
    "documentId: folder-one",
    "revision: 4",
    'title: "Nested owner"',
    "links:",
    "  - target: pkm://knowledge/knowledge_000000000000000000000001",
    "    relation: references",
    "custom: [keep, exact]",
    "---",
    "![outside](../../../Outside.assets/shared.bin?q=1#view)",
    "![own](One.assets/embedded.bin)",
    "[nearby](../Two.md)",
    "",
  ].join("\r\n");
  const two = [
    "---",
    "documentId: folder-two",
    "revision: 9",
    "title: Other owner",
    "custom: untouched",
    "---",
    "![outside](../../Outside.assets/shared.bin)",
    "![nested](Nested/One.assets/embedded.bin)",
    "",
  ].join("\n");
  const outside = [
    "---",
    "documentId: outside-owner",
    "revision: 2",
    "title: Outside",
    "---",
    "External owner.",
    "",
  ].join("\n");
  await put("notes", "Archive/Team/Nested/One.md", one);
  await put("notes", "Archive/Team/Two.md", two);
  await put("notes", "Outside.md", outside);
  const ownBytes = Buffer.from([0, 255, 13, 10, 128, 1, 0]);
  const otherBytes = Buffer.from([10, 20, 0, 128, 255]);
  const outsideBytes = Buffer.from([7, 0, 9, 255]);
  await put("notes", "Archive/Team/Nested/One.assets/embedded.bin", ownBytes);
  await mkdir(join(root, "notes/Archive/Team/Nested/One.assets/empty"), { recursive: true });
  await put("notes", "Archive/Team/Two.assets/embedded.bin", otherBytes);
  await put("notes", "Outside.assets/shared.bin", outsideBytes);

  function documents() { return scanMarkdown(root); }
  function argumentsFor() {
    return { area: "notes", path: "Archive/Team", destinationPath: "New/Deep/Team" };
  }
  function preview(snapshot = documents(), overrides = {}) {
    return readFolderLifecycle(root, snapshot, {
      operation: "knowledge.folder.lifecycle.preview", actorId: "test:owner",
      args: { ...argumentsFor(), ...overrides },
    });
  }
  function plan(pins = preview(), overrides = {}) {
    return planFolderLifecycle(root, documents(), {
      operation: "knowledge.folder.move", actorId: "test:owner",
      args: {
        operationId: randomUUID(), ...argumentsFor(),
        expectedSourceSha256: pins.sourceSha256,
        expectedScanRevision: pins.scanRevision,
        expectedDestinationSha256: null,
        ...overrides,
      },
    });
  }
  return { root, one, two, outside, ownBytes, otherBytes, outsideBytes, put, documents, argumentsFor, preview, plan };
}

async function assertMoved(f, plan) {
  await assert.rejects(readFile(join(f.root, "notes/Archive/Team/Nested/One.md")), { code: "ENOENT" });
  const movedOne = await readFile(join(f.root, "notes/New/Deep/Team/Nested/One.md"), "utf8");
  const movedTwo = await readFile(join(f.root, "notes/New/Deep/Team/Two.md"), "utf8");
  assert(movedOne.includes("../../../../Outside.assets/shared.bin?q=1#view"));
  assert(movedTwo.includes("../../../Outside.assets/shared.bin"));
  assert(movedOne.includes("One.assets/embedded.bin"));
  assert(movedTwo.includes("Nested/One.assets/embedded.bin"));
  assert(movedOne.startsWith(f.one.slice(0, f.one.indexOf("---\r\n", 4) + 5)));
  assert.deepEqual(await readFile(join(f.root, "notes/New/Deep/Team/Nested/One.assets/embedded.bin")), f.ownBytes);
  assert.deepEqual(await readFile(join(f.root, "notes/New/Deep/Team/Two.assets/embedded.bin")), f.otherBytes);
  assert.deepEqual(await readFile(join(f.root, "notes/Outside.assets/shared.bin")), f.outsideBytes);
  assert.deepEqual(await readdir(join(f.root, "notes/New/Deep/Team/Nested/One.assets/empty")), []);
  const records = scanMarkdown(f.root);
  assert.equal(records.find(record => record.record.id === "folder-one").record.path, "New/Deep/Team/Nested/One.md");
  assert.equal(records.find(record => record.record.id === "folder-two").record.path, "New/Deep/Team/Two.md");
  assert.equal(records.find(record => record.record.id === "folder-one").record.revision, 4);
  assert.equal(records.find(record => record.record.id === "folder-two").record.revision, 9);
  assert.equal(records.find(record => record.record.id === "folder-one").metadata.get("title"), "Nested owner");
  assert.equal(records.find(record => record.record.id === "folder-two").metadata.get("custom"), "untouched");
  for (const change of plan.markdownChanges) {
    const actual = await readFile(join(f.root, "notes/New/Deep/Team", ...change.relativePath.split("/")));
    assert.deepEqual(actual, change.after);
  }
}

test("public folder schemas are schema-only and match the exact transport fixture", () => {
  assert.deepEqual(folderLifecycleDefinitions.map(definition => [definition.id, definition.readOnly]), [
    ["knowledge.folder.lifecycle.preview", true],
    ["knowledge.folder.move", false],
    ["knowledge.folder.lifecycle.promote-preview", true],
    ["knowledge.folder.promote-delete", false],
  ]);
  assert.deepEqual(folderLifecycleDefinitions[0].input.parse(folderLifecycleTransportFixture.preview.args), folderLifecycleTransportFixture.preview.args);
  assert.deepEqual(folderLifecycleDefinitions[0].output.parse(folderLifecycleTransportFixture.preview.result), folderLifecycleTransportFixture.preview.result);
  assert.deepEqual(folderLifecycleDefinitions[1].input.parse(folderLifecycleTransportFixture.move.args), folderLifecycleTransportFixture.move.args);
  assert.deepEqual(folderLifecycleDefinitions[1].output.parse(folderLifecycleTransportFixture.move.result), folderLifecycleTransportFixture.move.result);
  assert.equal(folderLifecycleDefinitions.some(definition => /trash/i.test(definition.id)), false);
  assert.equal(folderLifecycleDefinitions[3].input.safeParse({ ...folderLifecycleTransportFixture.move.args, mode: "fallback" }).success, false);
  for (const first of ["folder-lifecycle-contracts", "folder-lifecycle", "contracts"]) {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      await import("./dist/${first}.js");
      const contracts = await import("./dist/folder-lifecycle-contracts.js");
      const executor = await import("./dist/folder-lifecycle.js");
      if (contracts.folderLifecycleDefinitions !== executor.folderLifecycleDefinitions) process.exit(1);
    `], { cwd: packageRoot, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
  }
});

test("original folder and resource lifecycle source captures remain current", async () => {
  const provenance = JSON.parse(await readFile(join(packageRoot, "migration/folder-lifecycle-provenance.json"), "utf8"));
  assert.equal(provenance.schema, "pkm.domain-capture/v1");
  assert.deepEqual(await checkCaptureRecords(provenance.files), []);
  const rules = folderLifecycleOriginalRules["src/knowledge/filestore.ts"];
  assert.match(rules.folderRename, /moveKnowledgePath/);
  assert.match(rules.folderDeletePromote, /moveKnowledgePath/);
  assert.match(rules.skillFolderMoveToTrash, /moveSkillPathToTrash/);
  assert.match(rules.skillTrashRestoreUnlocked, /moveMarkdownPair/);
});

test("nested multi-document move pins subtree and references; preserves identity, metadata, assets and bytes", async t => {
  const f = await fixture(t);
  const preview = f.preview();
  assert.equal(preview.destinationAbsent, true);
  assert.equal(preview.documents, 2);
  assert.equal(preview.scannedDocuments, 3);
  assert.equal(preview.rewrittenDocuments, 2);
  assert.equal(preview.bytes, Buffer.byteLength(f.one) + Buffer.byteLength(f.two) + f.ownBytes.length + f.otherBytes.length);
  const plan = f.plan();
  assert.equal(plan.requiresCompoundJournal, true);
  assert.deepEqual(deserializeFolderLifecyclePlan(serializeFolderLifecyclePlan(plan)), plan);
  assert.deepEqual(await readFile(join(f.root, "notes/Archive/Team/Nested/One.md")), Buffer.from(f.one));
  assert.deepEqual(await readFile(join(f.root, "notes/Archive/Team/Nested/One.assets/embedded.bin")), f.ownBytes);
  assert.deepEqual(applyFolderLifecycle(f.root, plan, plan.operationId), plan.result);
  await assertMoved(f, plan);
  assert.deepEqual(recoverFolderLifecycle(f.root, plan, plan.operationId), plan.result);
});

for (const rewrittenCount of [0, 1, 2]) {
  test(`recovers exact interrupted folder phase after ${rewrittenCount} Markdown rewrites`, async t => {
    const f = await fixture(t), plan = f.plan();
    const changed = plan.markdownChanges.filter(change => change.beforeSha256 !== change.afterSha256);
    assert.equal(changed.length, 2);
    await mkdir(dirname(join(f.root, "notes/New/Deep/Team")), { recursive: true });
    await rename(join(f.root, "notes/Archive/Team"), join(f.root, "notes/New/Deep/Team"));
    for (const change of changed.slice(0, rewrittenCount)) {
      await writeFile(join(f.root, "notes/New/Deep/Team", ...change.relativePath.split("/")), change.after);
    }
    assert.deepEqual(recoverFolderLifecycle(f.root, plan, plan.operationId), plan.result);
    await assertMoved(f, plan);
  });
}

test("recovery starts from the exact untouched source phase", async t => {
  const f = await fixture(t), plan = f.plan();
  assert.deepEqual(recoverFolderLifecycle(f.root, plan, plan.operationId), plan.result);
  await assertMoved(f, plan);
});

test("empty folders remain movable with an explicit empty workspace reference pin", async t => {
  const root = join(tests, `.folder-lifecycle-empty-${randomUUID()}`);
  await mkdir(join(root, "notes/Empty"), { recursive: true });
  t.after(() => rm(root, { force: true, recursive: true }));
  const request = {
    operation: "knowledge.folder.lifecycle.preview", actorId: "test:owner",
    args: { area: "notes", path: "Empty", destinationPath: "Moved/Empty" },
  };
  const preview = readFolderLifecycle(root, [], request);
  assert.equal(preview.entries, 0);
  assert.equal(preview.documents, 0);
  const plan = planFolderLifecycle(root, [], {
    ...request, operation: "knowledge.folder.move",
    args: {
      operationId: randomUUID(), ...request.args,
      expectedSourceSha256: preview.sourceSha256,
      expectedScanRevision: preview.scanRevision,
      expectedDestinationSha256: null,
    },
  });
  assert.deepEqual(recoverFolderLifecycle(root, plan, plan.operationId), plan.result);
  assert.deepEqual(await readdir(join(root, "notes/Moved/Empty")), []);
});

test("Note inventory recognizes the reserved folder-pin sidecar without indexing it as Markdown", async t => {
  const root = join(tests, `.folder-lifecycle-pins-${randomUUID()}`);
  await mkdir(join(root, "notes", "Old"), { recursive: true });
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(join(root, "notes", "Old", "Note.md"),
    "---\ndocumentId: pinned-note\nrevision: 1\ntitle: Note\n---\nBody\n");
  await writeFile(join(root, "notes", ".pk-meta.json"),
    `${JSON.stringify({ pinnedFolders: ["Old", "Old/Nested"] }, null, 2)}\n`);
  const documents = scanMarkdown(root);
  assert.equal(documents.length, 1);
  assert.equal(documents[0].record.path, "Old/Note.md");
});

test("serialized Notes folder move recovers exact folder-pin sidecar repath after a partial move", async t => {
  const root = join(tests, `.folder-lifecycle-pin-recovery-${randomUUID()}`);
  await mkdir(join(root, "notes", "Old", "Nested"), { recursive: true });
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(join(root, "notes", "Old", "Nested", "Note.md"),
    "---\ndocumentId: pinned-note\nrevision: 1\ntitle: Note\n---\nBody\n");
  const sidecar = join(root, "notes", ".pk-meta.json");
  const before = Buffer.from(`${JSON.stringify({
    pinnedFolders: ["Old", "Old/Nested", "Other", "Oldness"], ignoredExtension: "original writer drops this on repath",
  }, null, 2)}\n`);
  const after = Buffer.from(`${JSON.stringify({ pinnedFolders: ["Moved", "Moved/Nested", "Other", "Oldness"] }, null, 2)}\n`);
  await writeFile(sidecar, before);
  const args = { area: "notes", path: "Old", destinationPath: "Moved" };
  const preview = readFolderLifecycle(root, scanMarkdown(root), {
    operation: "knowledge.folder.lifecycle.preview", actorId: "test:folder-pins", args,
  });
  const plan = planFolderLifecycle(root, scanMarkdown(root), {
    operation: "knowledge.folder.move", actorId: "test:folder-pins", args: {
      operationId: randomUUID(), ...args,
      expectedSourceSha256: preview.sourceSha256,
      expectedScanRevision: preview.scanRevision,
      expectedDestinationSha256: null,
    },
  });
  const serialized = serializeFolderLifecyclePlan(plan);
  assert.deepEqual(deserializeFolderLifecyclePlan(serialized).noteFolderPins, {
    beforeSha256: sha256(before), afterSha256: sha256(after), before, after,
  });

  await rename(join(root, "notes", "Old"), join(root, "notes", "Moved"));
  assert.deepEqual(await readFile(sidecar), before);
  await writeFile(join(root, "notes", `.pkm-write-${plan.operationId}`), after.subarray(0, 9));
  assert.deepEqual(recoverFolderLifecycle(root, deserializeFolderLifecyclePlan(serialized), plan.operationId), plan.result);
  assert.deepEqual(await readFile(sidecar), after);
  await assert.rejects(readFile(join(root, "notes", `.pkm-write-${plan.operationId}`)), { code: "ENOENT" });
  assert.deepEqual(recoverFolderLifecycle(root, deserializeFolderLifecyclePlan(serialized), plan.operationId), plan.result);
  assert.deepEqual(await readFile(sidecar), after);
});

test("stale Note folder-pin sidecar CAS prevents folder rename and preserves both versions", async t => {
  const root = join(tests, `.folder-lifecycle-pin-cas-${randomUUID()}`);
  await mkdir(join(root, "notes", "Old"), { recursive: true });
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(join(root, "notes", "Old", "Note.md"),
    "---\ndocumentId: pinned-note-cas\nrevision: 1\ntitle: Note\n---\nBody\n");
  const sidecar = join(root, "notes", ".pk-meta.json");
  await writeFile(sidecar, '{"pinnedFolders":["Old"]}\n');
  const args = { area: "notes", path: "Old", destinationPath: "Moved" };
  const preview = readFolderLifecycle(root, scanMarkdown(root), {
    operation: "knowledge.folder.lifecycle.preview", actorId: "test:folder-pins", args,
  });
  const plan = planFolderLifecycle(root, scanMarkdown(root), {
    operation: "knowledge.folder.move", actorId: "test:folder-pins", args: {
      operationId: randomUUID(), ...args,
      expectedSourceSha256: preview.sourceSha256,
      expectedScanRevision: preview.scanRevision,
      expectedDestinationSha256: null,
    },
  });
  const competing = Buffer.from('{"pinnedFolders":["Concurrent"]}\n');
  await writeFile(sidecar, competing);
  assert.throws(() => applyFolderLifecycle(root, plan, plan.operationId), errorCode("RECOVERY_CONFLICT"));
  assert.deepEqual(await readFile(sidecar), competing);
  assert.equal(await readFile(join(root, "notes", "Old", "Note.md"), "utf8").then(() => true), true);
  await assert.rejects(readFile(join(root, "notes", "Moved")));
});

test("folder move preview CAS includes exact Note folder-pin sidecar bytes", async t => {
  const root = join(tests, `.folder-lifecycle-pin-preview-cas-${randomUUID()}`);
  await mkdir(join(root, "notes", "Old"), { recursive: true });
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(join(root, "notes", "Old", "Note.md"),
    "---\ndocumentId: pinned-note-preview\nrevision: 1\ntitle: Note\n---\nBody\n");
  const sidecar = join(root, "notes", ".pk-meta.json");
  await writeFile(sidecar, '{"pinnedFolders":["Old"]}\n');
  const args = { area: "notes", path: "Old", destinationPath: "Moved" };
  const preview = readFolderLifecycle(root, scanMarkdown(root), {
    operation: "knowledge.folder.lifecycle.preview", actorId: "test:folder-pins", args,
  });
  await writeFile(sidecar, '{"pinnedFolders":["Concurrent"]}\n');
  assert.throws(() => planFolderLifecycle(root, scanMarkdown(root), {
    operation: "knowledge.folder.move", actorId: "test:folder-pins", args: {
      operationId: randomUUID(), ...args,
      expectedSourceSha256: preview.sourceSha256,
      expectedScanRevision: preview.scanRevision,
      expectedDestinationSha256: null,
    },
  }), errorCode("CONFLICT"));
  assert.equal(await readFile(join(root, "notes", "Old", "Note.md"), "utf8").then(() => true), true);
  await assert.rejects(readFile(join(root, "notes", "Moved")));
});

test("rejects destination replacement, unknown subtree bytes, stale references and unknown staging", async t => {
  {
    const f = await fixture(t), plan = f.plan();
    await mkdir(join(f.root, "notes/New/Deep/Team"), { recursive: true });
    await writeFile(join(f.root, "notes/New/Deep/Team/sentinel.bin"), "keep");
    assert.throws(() => applyFolderLifecycle(f.root, plan, plan.operationId), errorCode("RECOVERY_CONFLICT"));
    assert.equal(await readFile(join(f.root, "notes/New/Deep/Team/sentinel.bin"), "utf8"), "keep");
    assert.equal((await readFile(join(f.root, "notes/Archive/Team/Two.md"), "utf8")), f.two);
  }
  {
    const f = await fixture(t), plan = f.plan();
    await mkdir(dirname(join(f.root, "notes/New/Deep/Team")), { recursive: true });
    await rename(join(f.root, "notes/Archive/Team"), join(f.root, "notes/New/Deep/Team"));
    await writeFile(join(f.root, "notes/New/Deep/Team/Nested/One.assets/embedded.bin"), "external edit");
    assert.throws(() => recoverFolderLifecycle(f.root, plan, plan.operationId), errorCode("RECOVERY_CONFLICT"));
    assert.equal(await readFile(join(f.root, "notes/New/Deep/Team/Nested/One.assets/embedded.bin"), "utf8"), "external edit");
  }
  {
    const f = await fixture(t), plan = f.plan();
    await f.put("notes", "Outside.md", `${f.outside}\nExternal edit`);
    assert.throws(() => applyFolderLifecycle(f.root, plan, plan.operationId), errorCode("RECOVERY_CONFLICT"));
    await assert.rejects(readFile(join(f.root, "notes/New/Deep/Team")));
    assert.equal(await readFile(join(f.root, "notes/Archive/Team/Two.md"), "utf8"), f.two);
  }
  {
    const f = await fixture(t), plan = f.plan();
    await mkdir(dirname(join(f.root, "notes/New/Deep/Team")), { recursive: true });
    await rename(join(f.root, "notes/Archive/Team"), join(f.root, "notes/New/Deep/Team"));
    await writeFile(join(f.root, "notes/New/Deep/Team/Nested", `.pkm-write-${plan.operationId}`), "unknown");
    assert.throws(() => recoverFolderLifecycle(f.root, plan, plan.operationId), errorCode("RECOVERY_CONFLICT"));
  }
});

test("rejects shared outside references, legacy resources, symlinks and protected descriptors", async t => {
  {
    const f = await fixture(t);
    await f.put("notes", "Outside.md", `${f.outside}\n![shared](Archive/Team/Nested/One.assets/embedded.bin)\n`);
    assert.throws(() => f.preview(), errorCode("CONFLICT"));
  }
  {
    const f = await fixture(t);
    await f.put("notes", "Archive/Team/Nested/One.md", f.one.replace("One.assets/embedded.bin", "_assets/legacy.bin"));
    assert.throws(() => f.preview(), errorCode("UNSUPPORTED_OPERATION"));
  }
  {
    const f = await fixture(t);
    await symlink(join(f.root, "notes/Outside.md"), join(f.root, "notes/Archive/Team/link.md"));
    assert.throws(() => f.preview(), errorCode("INVALID_DOCUMENT"));
  }
  {
    const f = await fixture(t);
    await f.put("notes", "Archive/Team/Nested/Todo Board.md", "---\ndocumentId: todo\nrevision: 1\ndocumentKind: todo-board\n---\n");
    assert.throws(() => f.preview(), errorCode("ACCESS_DENIED"));
  }
  {
    const f = await fixture(t);
    await f.put("notes", "Archive/Team/Nested/Memory.md", "---\ndocumentId: memory\nrevision: 1\nmemory: true\n---\n");
    assert.throws(() => f.preview(), errorCode("ACCESS_DENIED"));
  }
});

test("portable paths reject traversal, Windows separators, hidden and reserved names", () => {
  for (const path of ["../outside", "Old\\Folder", "CON/Folder", "trailing./Folder", ".hidden/Folder"]) {
    assert.equal(folderLifecycleDefinitions[0].input.safeParse({ area: "notes", path, destinationPath: "New/Folder" }).success, false, path);
  }
  assert.equal(folderLifecycleDefinitions[0].input.safeParse({
    area: "notes", path: "Old/Folder", destinationPath: "Old/Folder/Inside",
  }).success, true);
});

test("folder moves cannot target a descendant of their source", async t => {
  const f = await fixture(t);
  assert.throws(() => readFolderLifecycle(f.root, f.documents(), {
    operation: "knowledge.folder.lifecycle.preview", actorId: "test", args: { area: "notes", path: "Old/Folder", destinationPath: "Old/Folder/Inside" },
  }), errorCode("INVALID_ARGUMENT"));
});

test("CAS pins reject changed sources and a pinned-absent destination is never overwritten", async t => {
  {
    const f = await fixture(t), preview = f.preview();
    await f.put("notes", "Archive/Team/Two.md", `${f.two}\nnew`);
    assert.throws(() => f.plan(preview), errorCode("CONFLICT"));
  }
  {
    const f = await fixture(t), preview = f.preview();
    await mkdir(join(f.root, "notes/New/Deep/Team"), { recursive: true });
    await writeFile(join(f.root, "notes/New/Deep/Team/Sentinel.md"), "---\ndocumentId: destination-sentinel\nrevision: 1\n---\nkeep");
    assert.throws(() => f.plan(preview), errorCode("CONFLICT"));
    assert.equal(await readFile(join(f.root, "notes/New/Deep/Team/Sentinel.md"), "utf8"), "---\ndocumentId: destination-sentinel\nrevision: 1\n---\nkeep");
  }
});

test("folder lifecycle accepts large Markdown and scans beyond former entry limits", async t => {
  const root = join(tests, `.folder-lifecycle-limits-${randomUUID()}`);
  await mkdir(join(root, "notes/Count"), { recursive: true });
  const countDocument = `---\ndocumentId: count-owner\nrevision: 1\n---\n${"x".repeat(1_100_000)}`;
  await writeFile(join(root, "notes/Count/Doc.md"), countDocument);
  await mkdir(join(root, "notes/Count/Doc.assets"), { recursive: true });
  t.after(() => rm(root, { force: true, recursive: true }));
  for (let index = 0; index < 2049; index++) {
    await writeFile(join(root, "notes/Count/Doc.assets", `f${String(index).padStart(4, "0")}.bin`), "");
  }
  const files = scanMarkdown(root);
  const request = (path, destinationPath) => ({
    operation: "knowledge.folder.lifecycle.preview", actorId: "test:owner", args: { area: "notes", path, destinationPath },
  });
  const preview = readFolderLifecycle(root, files, request("Count", "CountMoved"));
  assert.equal(preview.entries, 2051);
  assert.equal(preview.documents, 1);
});
