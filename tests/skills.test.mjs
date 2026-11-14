import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm, utimes, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { initialize, Storage } from "../dist/storage.js";
import { Core } from "../dist/core.js";
import { decodeMarkdown, scanMarkdown } from "../dist/markdown.js";
import { readSkills } from "../dist/skills.js";
import { createSkillQueries } from "../dist/domain/skills.js";

async function fixture(t) {
  const parent = join(dirname(fileURLToPath(import.meta.url)), `.skills-${randomUUID()}`);
  const directory = join(parent, "workspace");
  await mkdir(parent, { recursive: true });
  await initialize(directory);
  let storage = await Storage.open(directory), core = new Core(storage);
  t.after(async () => { try { await storage.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
  const query = (operation, args = {}) => core.dispatch("capability_read",
    { operation: `knowledge.skill.${operation}`, version: 1, arguments: args }, { id: "local:reader", canWrite: false });
  async function skill(path, fields = {}, body = "Skill body") {
    const metadata = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
    const raw = metadata ? `---\n${metadata}\n---\n${body}` : body;
    await mkdir(join(directory, "skills", path, ".."), { recursive: true });
    await writeFile(join(directory, "skills", path), raw);
    return raw;
  }
  return {
    directory, query, skill, get core() { return core; },
    async restart() { await storage.close(); storage = await Storage.open(directory); core = new Core(storage); },
  };
}

test("Skill projection preserves original names, JSON tags, priority, recipe metadata and body-free pages", async t => {
  const f = await fixture(t);
  const raw = await f.skill("Team/Actual.MD", {
    name: "Display Name", title: "Not the Skill name", description: "Description",
    tags: ["one", "one", "two"], source_project: "project", priority: "highest", pinned: true,
    recipe_required: true, recipe_hint: "Run recipe", related_skills: ["Dependency"], custom: { untouched: true },
  }, "Private Skill body");
  const first = await f.query("list");
  assert(!first.error, JSON.stringify(first.error));
  const item = first.result.items[0];
  assert.equal(item.name, "Display Name");
  assert.equal(item.path, "Team/Actual.MD");
  assert.equal(item.category, "Team");
  assert.equal(item.tags, '["one","one","two"]');
  assert.equal(item.priority, "highest");
  assert.equal(item.recipe_required, true);
  assert.equal(item.recipe_hint, "Run recipe");
  assert.deepEqual(item.related_skills, ["Dependency"]);
  assert(!Object.hasOwn(item, "content"));
  assert(!Object.hasOwn(item, "_key"));
  assert(item.documentId.startsWith("legacy_"));
  const detail = await f.query("get", { name: "Display Name", snapshotRevision: first.result.snapshotRevision });
  assert.equal(detail.result.item._key, "Team/Actual");
  assert.equal(detail.result.item.content, "Private Skill body");
  assert.equal(detail.result.item.documentSha256, item.documentSha256);
  assert.deepEqual((await f.query("get", { id: item.documentId })).result.item, detail.result.item);
  assert.equal(await readFile(join(f.directory, "skills/Team/Actual.MD"), "utf8"), raw);
  await f.restart();
  assert.deepEqual((await f.query("get", { name: "Display Name" })).result, detail.result);
});

test("captured original Skill category/tag filters and ordering carry stable addresses through duplicate names", async t => {
  const f = await fixture(t);
  await f.skill("Z/Z.md", { name: "Same", tags: ["target"], priority: "HIGH", documentId: "a-id" });
  await f.skill("A/A.md", { name: "Same", tags: "target", priority: "high", documentId: "z-id" });
  await f.skill("A/B.md", { name: "Before", tags: ["other"] });
  const list = (await f.query("list")).result;
  assert.deepEqual(list.items.map(item => item.name), ["Before", "Same", "Same"]);
  assert.deepEqual(list.items.map(item => item.path), ["A/B.md", "A/A.md", "Z/Z.md"]);
  const page = (await f.query("list", { tag: "target", limit: 1 })).result;
  assert.equal(page.total, 2);
  assert.equal(page.items[0].priority, "high");
  const next = (await f.query("list", { tag: "target", offset: page.nextOffset, snapshotRevision: page.snapshotRevision })).result;
  assert.equal(next.items[0].documentId, "a-id");
  assert.equal(next.items[0].priority, "normal", "Unknown priority retains original fallback.");
  assert.equal(next.nextOffset, null);
  assert.equal((await f.query("list", { category: "A", tag: "target" })).result.total, 1);
  assert.equal((await f.query("list", { category: "a" })).result.total, 0);
  assert.equal((await f.query("list", { tag: "TARGET" })).result.total, 0);
  assert.equal((await f.query("get", { name: "Same" })).error.code, "CONFLICT");
  assert.equal((await f.query("get", { id: "z-id" })).result.item.path, "A/A.md");
  const full = await Promise.all(list.items.map(item => f.query("get", { id: item.documentId })));
  const rows = full.map(response => response.result.item);
  assert.deepEqual(createSkillQueries(rows).skillList("A", "target"),
    (await f.query("list", { category: "A", tag: "target" })).result.items);
});

test("plain Skill defaults and selector validation retain original filename-name behavior", async t => {
  const f = await fixture(t);
  await f.skill("Fallback.md");
  const item = (await f.query("get", { name: "Fallback" })).result.item;
  assert.equal(item.description, "");
  assert.equal(item.source_project, null);
  assert.equal(item.priority, "normal");
  assert.equal(item.recipe_required, false);
  assert.equal(item.recipe_hint, "");
  assert.equal(item.tags, "[]");
  assert.deepEqual(item.links, []);
  assert.equal((await f.query("get", { name: "fallback" })).error.code, "NOT_FOUND");
  for (const args of [{}, { name: "Fallback", id: item.documentId }, { name: "" }, { id: "../unsafe" }]) {
    assert.equal((await f.query("get", args)).error.code, "INVALID_ARGUMENT");
  }
  assert.equal((await f.query("list", { limit: 101 })).error.code, "INVALID_ARGUMENT");
});

test("Skill snapshot pins include authoritative metadata/comments, body, mtime and moves but not other areas", async t => {
  const f = await fixture(t);
  await f.skill("One.md", { documentId: "stable-skill", name: "One" });
  let pin = (await f.query("list")).result.snapshotRevision;
  await writeFile(join(f.directory, "notes/Other.md"), "Other notes");
  assert.equal((await f.query("get", { id: "stable-skill", snapshotRevision: pin })).result.snapshotRevision, pin);
  await f.skill("One.md", { documentId: "stable-skill", name: "One", custom: "New unknown metadata" });
  assert.equal((await f.query("list", { snapshotRevision: pin })).error.code, "CONFLICT");
  pin = (await f.query("list")).result.snapshotRevision;
  const path = join(f.directory, "skills/One.md");
  await writeFile(path, (await readFile(path, "utf8")).replace("---\n", "---\n# Preserved YAML comment\n"));
  assert.equal((await f.query("list", { snapshotRevision: pin })).error.code, "CONFLICT");
  pin = (await f.query("list")).result.snapshotRevision;
  await writeFile(path, (await readFile(path, "utf8")) + "\nExternal body change");
  assert.equal((await f.query("get", { id: "stable-skill", snapshotRevision: pin })).error.code, "CONFLICT");
  pin = (await f.query("list")).result.snapshotRevision;
  await utimes(join(f.directory, "skills/One.md"), new Date(0), new Date(0));
  assert.equal((await f.query("list", { snapshotRevision: pin })).error.code, "CONFLICT");
  pin = (await f.query("list")).result.snapshotRevision;
  await rename(join(f.directory, "skills/One.md"), join(f.directory, "skills/Two.md"));
  assert.equal((await f.query("get", { id: "stable-skill", snapshotRevision: pin })).error.code, "CONFLICT");
  assert.equal((await f.query("get", { id: "stable-skill" })).result.item.path, "Two.md");
});

test("Skill canonical identity lookup and trash/restore use the existing document lifecycle", async t => {
  const f = await fixture(t), actor = { id: "local:owner", canWrite: true };
  const mutate = (operation, args) => f.core.dispatch("capability_call", { operation, version: 1, arguments: args }, actor);
  const created = (await mutate("knowledge.document.create", {
    id: "skill", operationId: randomUUID(), area: "skills", path: "Skill.md", title: "Title", content: "Body",
  })).result;
  const record = (await f.query("get", { id: "skill" })).result.item;
  assert.equal((await f.query("get", { id: record.knowledgeId })).result.item.documentId, "skill");
  const removed = (await mutate("knowledge.document.trash", {
    id: "skill", operationId: randomUUID(), expectedRevision: 1, expectedSha256: created.sha256,
  })).result;
  assert.equal((await f.query("list")).result.total, 0);
  assert.equal((await f.query("get", { id: "skill" })).error.code, "NOT_FOUND");
  await mutate("knowledge.document.restore", { id: "skill", operationId: randomUUID(), expectedRevision: 2, expectedSha256: removed.sha256 });
  assert.equal((await f.query("list")).result.total, 1);
});

test("invalid Skill-specific metadata fails before legacy dynamically typed filtering or sorting", async t => {
  const f = await fixture(t);
  for (const fields of [{ name: 42 }, { description: false }, { tags: [42] }, { source_project: {} },
    { related_skills: [null] }, { created: 123 }]) {
    await f.skill("Bad.md", fields);
    for (const operation of ["list", "get"]) {
      const result = await f.query(operation, operation === "get" ? { name: "Bad" } : {});
      assert.equal(result.error.code, "INVALID_DOCUMENT", JSON.stringify(fields));
    }
  }
});

test("shared Skill snapshot admission enforces exact 4096-document/32-MiB bounds before projection", async t => {
  const f = await fixture(t);
  await f.skill("A.md");
  const record = scanMarkdown(f.directory).find(item => item.record.area === "skills");
  const request = { operation: "knowledge.skill.list", args: { offset: 0, limit: 1 }, actorId: "local:reader" };
  assert.equal(readSkills(f.directory, Array(4096).fill(record), request).total, 4096);
  assert.throws(() => readSkills(f.directory, Array(4097).fill(record), request), error => error.code === "BUSY");
  const large = { ...decodeMarkdown("skill", "Body", "A.md", "skills"), raw: "x".repeat(1_048_576) };
  assert.equal(readSkills(f.directory, Array(32).fill(large), request).total, 32);
  assert.throws(() => readSkills(f.directory, Array(33).fill(large), request), error => error.code === "BUSY");
});
