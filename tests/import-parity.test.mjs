import { test } from "node:test";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { Core } from "../dist/core.js";
import { compareImportParity } from "../dist/import-parity.js";
import { importLegacyWorkspace, planLegacyImport } from "../dist/legacy-import.js";
import { serializeTodoBoard } from "../dist/domain/todo-board.js";
import { Storage } from "../dist/storage.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";

const root = dirname(fileURLToPath(import.meta.url));
const pythonExecutable = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const hash = data => createHash("sha256").update(data).digest("hex");
const row = (scope, key, value) => ({ scope, key, value });

async function fixture(t) {
  const parent = resolve(root, `.import-parity-${randomUUID()}`);
  const source = join(parent, "source");
  await mkdir(source, { recursive: true, mode: 0o700 });
  t.after(() => rm(parent, { recursive: true, force: true }));
  async function file(path, data) {
    const full = join(source, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  }
  return { parent, source, target: join(parent, "target"), file };
}
async function inventory(root) {
  const result = {};
  async function walk(dir, prefix = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), path);
      else if (entry.isFile()) result[path] = hash(await readFile(join(dir, entry.name)));
      else throw new Error("Non-file in synthetic fixture");
    }
  }
  await walk(root);
  return result;
}
const host = () => {
  let held = false;
  return {
    acquireQuiescence: async () => {
      assert.equal(held, false);
      held = true;
      return { assertHeld: () => assert.equal(held, true), release: () => { held = false; } };
    },
  };
};
const request = (core, operation, args, write = false) => core.dispatch(
  write ? "capability_call" : "capability_read",
  { operation, version: 1, arguments: args }, { id: "fixture:owner", canWrite: write },
).then(result => { assert.equal(result.error, undefined, JSON.stringify(result.error)); return result.result; });

test("parity comparator reports exact cases, omissions and mismatches, not approval", () => {
  const expected = [row("bytes", "a", { b: 2, a: [1] }), row("identity", "b", "id")];
  assert.deepEqual(compareImportParity(expected, [row("bytes", "a", { a: [1], b: 2 }), row("reads", "c", 1)]),
    [row("bytes", "a", "match"), row("identity", "b", "missing"), row("reads", "c", "unexpected")]
      .map(({ scope, key, value }) => ({ scope, key, result: value })));
  assert.equal(compareImportParity(expected, [row("bytes", "a", { a: [2], b: 2 })])[0].result, "mismatch");
  assert.throws(() => compareImportParity([], []));
  assert.throws(() => compareImportParity([expected[0], expected[0]], []));
  assert.throws(() => compareImportParity([row("bytes", "a", NaN)], []));
  assert.throws(() => compareImportParity([row("bytes", "a", Array(1))], []));
});

test("original shared upload paths survive import, reads, mutation, backup restore and source rollback oracle", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const knowledgeId = "knowledge_0123456789abcdef01234567";
  const noteMeta = { title: "Design", documentId: "design-note", knowledgeId, revision: 3, aliases: ["note:Old/Design"], tags: ["legacy"], custom: { kept: true } };
  const skillMeta = { name: "Skill", documentId: "skill-a", revision: 2, priority: "highest", tags: ["useful"] };
  const paperMeta = { title: "Paper", documentId: "paper-a", revision: 4, authors: "Ada", conclusions: ["Result"] };
  const format = (meta, body) => `---\r\n${JSON.stringify(meta)}\r\n---\r\n${body}`;
  const sharedName = "0123456789abcdef.png";
  const shared = Buffer.from([0, 255, 1, 128, 42]);
  const note = format(noteMeta, `![shared](_assets/${sharedName})\r\n![owned](Design.assets/local.bin)\r\n`);
  const skill = format(skillMeta, "Skill body");
  const paper = format(paperMeta, `Paper body\n![paper](_assets/${sharedName})`);
  const history = [{ at: "2025-02-03T04:05:06.000Z", actorId: "user:legacy", action: "created" }];
  const board = serializeTodoBoard([{ id: "work-1", title: "Work", goal: "Keep it", scope: "Migration", acceptance: ["Done"], state: "Planning", evidence: [], history }]);
  const files = {
    "notes/Team/Design.md": note, [`notes/Team/_assets/${sharedName}`]: shared,
    "notes/Team/Design.assets/local.bin": Buffer.from([9, 8, 7]),
    "notes/Team/Board.md": format({ title: "Board", documentId: "board-a", revision: 2, documentKind: "todo-board" }, "Board"),
    "notes/Team/Board.assets/pkm-todo-board.json": board,
    "skills/Team/Skill.md": skill, "papers/Topic/Paper.md": paper,
    [`papers/Topic/_assets/${sharedName}`]: shared,
  };
  for (const [path, bytes] of Object.entries(files)) await f.file(path, bytes);
  const original = await inventory(f.source);
  const plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert(plan.preflight.blockers.some(item => item.code === "legacy-assets"), "Preflight remains conservative.");
  assert(plan.entries.some(item => item.source.endsWith(sharedName) && item.kind === "asset"));
  const receipt = await importLegacyWorkspace(plan, f.target, { pythonExecutable });
  assert.equal(receipt.fingerprint, plan.fingerprint);
  const expected = [], actual = [];
  for (const [path, bytes] of Object.entries(files)) {
    const destination = path.endsWith("pkm-todo-board.json") ? "boards/Team/Board/pkm-todo-board.json" : path;
    expected.push(row("bytes", path, hash(bytes)));
    actual.push(row("bytes", path, hash(await readFile(join(f.target, destination)))));
  }
  const importedNote = await readFile(join(f.target, "notes/Team/Design.md"), "utf8");
  expected.push(row("frontmatter", "design", noteMeta));
  actual.push(row("frontmatter", "design", parseYaml(importedNote.split("---")[1])));

  const storage = await Storage.open(f.target);
  try {
    const core = new Core(storage);
    const detail = await request(core, "knowledge.note.get", { id: knowledgeId });
    expected.push(row("identity", "design", ["design-note", knowledgeId]));
    actual.push(row("identity", "design", [detail.item.documentId, detail.item.knowledgeId]));
    expected.push(row("aliases", "design", ["note:Old/Design", "note:Team/Design"].sort()));
    actual.push(row("aliases", "design", [...detail.item.aliases].sort()));
    expected.push(row("source-version", "design", 3));
    actual.push(row("source-version", "design", (await request(core, "knowledge.document.get", { id: "design-note" })).revision));
    const skillRead = await request(core, "knowledge.skill.get", { id: "skill-a" });
    const research = await request(core, "knowledge.research.list", {});
    expected.push(row("reads", "specialized", ["Skill", "highest", '["useful"]', "Paper", ["Ada"], ["Result"]]));
    actual.push(row("reads", "specialized", [skillRead.item.name, skillRead.item.priority, skillRead.item.tags,
      research.items[0].title, research.items[0].authors, research.items[0].conclusions]));
    const assets = await request(core, "knowledge.asset.list", { id: "design-note" });
    const found = assets.items.find(item => item.path === `Team/_assets/${sharedName}`);
    assert(found, JSON.stringify(assets));
    const chunk = await request(core, "knowledge.asset.get", { id: "design-note", path: found.path,
      expectedDocumentSha256: hash(note), expectedDigest: found.digest });
    expected.push(row("linked-assets", "shared", hash(shared)));
    actual.push(row("linked-assets", "shared", hash(Buffer.from(chunk.data, "base64"))));
    const paperAssets = await request(core, "knowledge.asset.list", { id: "paper-a" });
    const paperAsset = paperAssets.items.find(item => item.path === `Topic/_assets/${sharedName}`);
    assert(paperAsset, JSON.stringify(paperAssets));
    const paperChunk = await request(core, "knowledge.asset.get", { id: "paper-a", path: paperAsset.path,
      expectedDocumentSha256: hash(paper), expectedDigest: paperAsset.digest });
    expected.push(row("linked-assets", "paper", hash(shared)));
    actual.push(row("linked-assets", "paper", hash(Buffer.from(paperChunk.data, "base64"))));
    const work = await request(core, "todo.workitem.history", { board_slug: "Team/Board", id: "work-1" });
    expected.push(row("board-history", "work-1", history));
    actual.push(row("board-history", "work-1", work.items));

    let released = false;
    await assert.rejects(createWorkspaceBackup(storage, join(f.parent, "lost-lease"), {
      acquireQuiescence: async () => ({ assertHeld() { throw new Error("lease lost"); }, release() { released = true; } }),
    }, { pythonExecutable }), /lease lost/);
    assert.equal(released, true);
    await assert.rejects(readdir(join(f.parent, "lost-lease")), { code: "ENOENT" });
    await createWorkspaceBackup(storage, join(f.parent, "backup"), host(), { pythonExecutable });
    const updated = await request(core, "knowledge.document.update", { id: "design-note", operationId: randomUUID(),
      expectedRevision: 3, expectedSha256: hash(note), title: "Edited", content: "Changed after backup" }, true);
    expected.push(row("mutations", "design", [4, "Changed after backup"]));
    actual.push(row("mutations", "design", [updated.revision, updated.content]));
    const stale = await core.dispatch("capability_call", { operation: "knowledge.document.update", version: 1,
      arguments: { id: "design-note", operationId: randomUUID(), expectedRevision: 3, expectedSha256: hash(note),
        title: "Stale", content: "Must not overwrite" } }, { id: "fixture:owner", canWrite: true });
    assert.equal(stale.error?.code, "CONFLICT");
    assert.equal((await request(core, "knowledge.document.get", { id: "design-note" })).content, "Changed after backup");
  } finally { await storage.close(); }
  const restored = join(f.parent, "restored");
  await restoreWorkspaceBackup(join(f.parent, "backup"), restored, { pythonExecutable, nativeRestoreAuthority });
  const reopened = await Storage.open(restored);
  try {
    const detail = await request(new Core(reopened), "knowledge.document.get", { id: "design-note" });
    expected.push(row("backup-restore", "design", [hash(note), 3]));
    actual.push(row("backup-restore", "design", [hash(await readFile(join(restored, "notes/Team/Design.md"))), detail.revision]));
  } finally { await reopened.close(); }
  expected.push(row("rollback", "unchanged-source", original));
  actual.push(row("rollback", "unchanged-source", await inventory(f.source)));
  const rows = compareImportParity(expected, actual);
  assert.deepEqual(rows.filter(item => item.result !== "match"), [], JSON.stringify(rows));
});

test("original shared uploads reject unknown files, nested directories and source drift", async t => {
  const f = await fixture(t);
  await f.file("notes/Note.md", "---\ndocumentId: note-a\n---\n![x](_assets/0123456789abcdef.png)");
  await f.file("notes/_assets/0123456789abcdef.png", "original");
  const plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  await f.file("notes/_assets/0123456789abcdef.png", "modified");
  await assert.rejects(importLegacyWorkspace(plan, f.target, { pythonExecutable }), { code: "SOURCE_CHANGED" });
  await f.file("notes/_assets/not-original.png", "unknown");
  await f.file("notes/_assets/nested/0123456789abcdef.png", "unknown");
  const blocked = await planLegacyImport(f.source);
  assert.equal(blocked.ready, false);
  assert(blocked.blockers.some(item => item.code === "unsupported-shared-asset"));
  await assert.rejects(importLegacyWorkspace(blocked, f.target, { pythonExecutable }), { code: "IMPORT_BLOCKED" });
  await assert.rejects(readdir(f.target), { code: "ENOENT" });
});

test("publication interruption and existing destination never overwrite shared assets or source", async t => {
  const f = await fixture(t);
  await f.file("notes/Note.md", "---\ndocumentId: note-a\n---\n![x](_assets/0123456789abcdef.png)");
  await f.file("notes/_assets/0123456789abcdef.png", "original");
  const original = await inventory(f.source);
  const plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const shim = join(f.parent, "unavailable-python");
  await writeFile(shim, `#!/usr/bin/env python3
import os, sys
if len(sys.argv) == 3:
    python = ${JSON.stringify(pythonExecutable)}
    os.execv(python, [python, *sys.argv[1:]])
print('renameat2-unavailable', file=sys.stderr)
sys.exit(78)
`);
  await chmod(shim, 0o700);
  await assert.rejects(importLegacyWorkspace(plan, f.target, { pythonExecutable: shim }), { code: "NO_REPLACE_UNAVAILABLE" });
  await assert.rejects(readdir(f.target), { code: "ENOENT" });
  assert.deepEqual(await inventory(f.source), original);
  await mkdir(f.target);
  await writeFile(join(f.target, "keep"), "unchanged");
  await assert.rejects(importLegacyWorkspace(plan, f.target, { pythonExecutable }), { code: "DESTINATION_EXISTS" });
  assert.equal(await readFile(join(f.target, "keep"), "utf8"), "unchanged");
  assert.deepEqual(await inventory(f.source), original);
});

test("unhandled original state and unknown journals remain explicit blockers", async t => {
  const f = await fixture(t);
  for (const [path, bytes] of Object.entries({
    "notes/Note.md": "fixture",
    "notes/.trash/deletion/entry.json": '{"kind":"item","originalPath":"Note.md"}',
    "project/example.json": "{}",
    "recipes/example.recipe.json": "{}",
    ".pkm/state/agent-snapshots/agent_snapshot_fixture.json": "{}",
    ".pkm/state/knowledge-deletions.json": '{"records":[]}',
    ".pkm/state/future-journal.json": "{}",
    "subscriptions/state.json": "{}",
  })) await f.file(path, bytes);
  const before = await inventory(f.source);
  const plan = await planLegacyImport(f.source);
  assert.equal(plan.ready, false);
  for (const path of ["notes/.trash", "project", "recipes", ".pkm", "subscriptions"]) {
    assert(plan.blockers.some(item => item.path === path), `${path}: ${JSON.stringify(plan.blockers)}`);
  }
  assert(plan.blockers.some(item => item.code === "deletion-journal"));
  assert(plan.blockers.some(item => item.path === ".pkm/state/agent-snapshots"
    && item.code === "INVALID_STATE"));
  await assert.rejects(importLegacyWorkspace(plan, f.target, { pythonExecutable }), { code: "IMPORT_BLOCKED" });
  assert.deepEqual(await inventory(f.source), before);
  await assert.rejects(readdir(f.target), { code: "ENOENT" });
});
