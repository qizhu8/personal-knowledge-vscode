import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, rm, symlink, lstat, truncate } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { migrationPreflight, migrationPreflightReportSchema } from "../dist/migration-preflight.js";
import { serializeTodoBoard } from "../dist/domain/todo-board.js";

async function fixture(t) {
  const root = resolve(`migration-preflight-fixture-${randomUUID()}`);
  await mkdir(join(root, "notes"), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  async function file(path, data) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
  return { root, file };
}
const codes = report => report.blockers.map(item => item.code);
const entry = (report, path) => report.entries.find(item => item.path === path);

test("inventories legacy documents and paired assets deterministically without writes", async t => {
  const { root, file } = await fixture(t);
  await file("notes/Team/Plan.md", "---\ntitle: Plan\n---\nBody");
  await file("notes/Team/Plan.assets/image.png", Buffer.from([1, 2, 3]));
  await file("skills/Use.md", "Skill");
  await file("papers/Topic/Research.md", "Paper");
  const before = await readFile(join(root, "notes/Team/Plan.md"));
  const report = migrationPreflight(root);
  assert.equal(report.complete, true);
  assert.equal(report.ready, true);
  assert(migrationPreflightReportSchema.safeParse(report).success);
  assert.deepEqual(migrationPreflight(root), report);
  assert.equal(entry(report, "notes/Team/Plan.md").kind, "document");
  assert.equal(entry(report, "notes/Team/Plan.assets/image.png").kind, "asset");
  assert.equal(entry(report, "skills/Use.md").kind, "document");
  assert.equal(entry(report, "papers/Topic/Research.md").kind, "document");
  assert.deepEqual(await readFile(join(root, "notes/Team/Plan.md")), before);
  assert.deepEqual((await readdir(root)).sort(), ["notes", "papers", "skills"]);
});

test("records exact independently-owned trash exclusions before stat or traversal", async t => {
  const { root } = await fixture(t);
  await mkdir(join(root, "notes", ".trash"), { recursive: true });
  await symlink("missing-target", join(root, "notes", ".trash", "unfollowed"));
  const report = migrationPreflight(root, { excludedPaths: ["notes/.trash"] });
  assert.equal(report.complete, true);
  assert.deepEqual(report.excludedPaths, ["notes/.trash"]);
  assert.equal(report.entries.some(item => item.path.startsWith("notes/.trash")), false);
  assert.equal(report.blockers.some(item => item.path.startsWith("notes/.trash")), false);
  assert.throws(() => migrationPreflight(root, { excludedPaths: ["notes"] }));
});

test("reports legacy surfaces, unowned assets, descriptors and backing without exposing Board data", async t => {
  const { root, file } = await fixture(t);
  await file("notes/Board.md", "---\ndocumentKind: todo-board\n---\n");
  await file("notes/Board.assets/pkm-todo-board.json", serializeTodoBoard([], { "external:copilot:agent": "a".repeat(64) }));
  await file("notes/Missing.md", "---\ndocumentKind: todo-board\n---\n");
  await file("notes/Orphan.assets/a", "asset");
  await file("papers/_assets/original.pdf", "PDF");
  await file("notes/.trash/deleted.md", "old");
  await file("notes/.gitkeep", "");
  await file(".pkm/state/knowledge-deletions.json", '{"schema":1,"records":[]}');
  await file("notes/Unknown.txt", "unknown");
  const report = migrationPreflight(root);
  for (const code of ["board-migration", "board-backing-missing", "unowned-assets", "legacy-assets", "trash", "gitkeep", "metadata", "deletion-journal", "unsupported-entry"]) {
    assert(codes(report).includes(code), code);
  }
  assert.equal(entry(report, "notes/Board.md").board, "descriptor-and-backing");
  assert.equal(entry(report, "notes/Board.assets/pkm-todo-board.json").kind, "board-backing");
  assert(!JSON.stringify(report).includes("a".repeat(64)));
  assert.equal(report.ready, false);
  assert.equal(report.complete, true);
});

test("detects cross-area stable, knowledge, alias and portable path collisions", async t => {
  const { root, file } = await fixture(t);
  await file("notes/a.md", "---\ndocumentId: shared\nknowledgeId: knowledge_0123456789abcdef01234567\naliases: [skill:shared]\n---\n");
  await file("skills/b.md", "---\ndocumentId: other\nknowledgeId: shared\naliases: [skill:shared]\n---\n");
  await file("papers/c.md", "---\ndocumentId: knowledge_0123456789abcdef01234567\n---\n");
  await file("notes/A.md", "case");
  const report = migrationPreflight(root);
  assert(codes(report).includes("identity-collision"));
  assert(codes(report).includes("invalid-knowledge-id"));
  assert(codes(report).includes("alias-collision"));
  assert(codes(report).includes("portable-path-collision"));
  assert(report.blockers.some(d => d.code === "identity-collision" && d.path === "papers/c.md" && d.relatedPath === "notes/a.md"));
  assert(report.blockers.some(d => d.code === "identity-collision" && d.path === "skills/b.md" && d.relatedPath === "notes/a.md"));
});

test("never follows symlinks, including area roots, resource files, and root ancestors", async t => {
  const { root, file } = await fixture(t);
  await file("notes/Doc.md", "text");
  await mkdir(join(root, "notes/Doc.assets"));
  await symlink("../Doc.md", join(root, "notes/Doc.assets/pkm-todo-board.json"));
  await symlink("notes", join(root, "skills"));
  await symlink("../outside-does-not-exist", join(root, "notes/link"));
  const report = migrationPreflight(root);
  assert.equal(report.entries.filter(e => e.kind === "symlink").length, 3);
  assert(codes(report).includes("invalid-area"));
  assert.equal((await lstat(join(root, "notes/link"))).isSymbolicLink(), true);
  const alias = `${root}-link`;
  await symlink(root, alias);
  t.after(() => rm(alias, { force: true }));
  assert.deepEqual(codes(migrationPreflight(alias)), ["unsafe-root"]);
});

test("supports caller-selected entry/read budgets and keeps structural depth validation", async t => {
  const { root, file } = await fixture(t);
  await file("notes/A.md", "abcd");
  assert.equal(migrationPreflight(root, { maxEntries: 2, maxReadBytes: 4 }).ready, true);
  const entries = migrationPreflight(root, { maxEntries: 1 });
  assert.equal(entries.complete, false);
  assert.deepEqual(entries.entries, []);
  assert.deepEqual(codes(entries), ["entry-limit"]);
  const bytes = migrationPreflight(root, { maxReadBytes: 3 });
  assert.equal(bytes.complete, false);
  assert(codes(bytes).includes("read-budget"));
  assert.equal(migrationPreflight(root, { maxDepth: 0 }).complete, false);
  await file("notes/A.md", Buffer.alloc(1_048_576, 0x61));
  assert(!codes(migrationPreflight(root)).includes("file-too-large"));
  await file("notes/A.md", Buffer.alloc(1_048_577, 0x61));
  assert(!codes(migrationPreflight(root)).includes("file-too-large"));
  assert.equal(migrationPreflight(root).complete, true);
  assert.equal(migrationPreflight(root, { maxEntries: 20_001 }).complete, true);
  assert.throws(() => migrationPreflight("relative"));
});

test("Board backing has no size limit while other resource limits remain", async t => {
  const { root, file } = await fixture(t);
  await file("notes/Board.md", "board");
  const board = '{"schema":"pkm.todo-board/v1","items":[]}';
  await file("notes/Board.assets/pkm-todo-board.json", board.padEnd(8_388_608));
  await file("notes/Board.assets/large.bin", "");
  const asset = join(root, "notes/Board.assets/large.bin");
  await truncate(asset, 16_777_216);
  let report = migrationPreflight(root);
  assert(!codes(report).includes("file-too-large"));
  assert(!codes(report).includes("asset-too-large"));
  await truncate(asset, 16_777_217);
  await file("notes/Board.assets/pkm-todo-board.json", board.padEnd(8_388_609));
  report = migrationPreflight(root);
  assert(!codes(report).includes("file-too-large"));
  assert(codes(report).includes("asset-too-large"));
  assert.equal(report.complete, true);
});

test("Notes exceed the old snapshot bound while Skill and owned-resource catalog limits remain inclusive", async t => {
  const { root, file } = await fixture(t);
  for (let index = 0; index < 4096; index++) await file(`notes/n${index}.md`, "");
  for (let index = 0; index < 2047; index++) await file(`notes/n0.assets/r${index}`, "");
  let report = migrationPreflight(root);
  assert(!codes(report).includes("snapshot-limit"));
  assert(!codes(report).includes("asset-catalog-limit"));
  await file("notes/extra.md", "");
  await file("notes/n0.assets/extra", "");
  for (let index = 0; index < 4097; index++) await file(`skills/s${index}.md`, "");
  report = migrationPreflight(root);
  assert(codes(report).includes("snapshot-limit"));
  assert(report.blockers.some(blocker => blocker.code === "snapshot-limit" && blocker.path === "skills"));
  assert(codes(report).includes("asset-catalog-limit"));
});

test("invalid UTF-8, malformed markdown and invalid Board are explicit blockers", async t => {
  const { root, file } = await fixture(t);
  await file("notes/Bad.md", Buffer.from([0xff]));
  await file("notes/Yaml.md", "---\nfoo: [\n---\n");
  await file("notes/Board.md", "board");
  await file("notes/Board.assets/pkm-todo-board.json", "{");
  const report = migrationPreflight(root);
  assert(codes(report).includes("invalid-utf8"));
  assert(codes(report).includes("invalid-document"));
  assert(codes(report).includes("invalid-board"));
  assert.equal(entry(report, "notes/Board.md").board, "backing");
});
