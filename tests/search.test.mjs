import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CoreError } from "../dist/contracts.js";
import { scanMarkdown } from "../dist/markdown.js";
import { readNotes } from "../dist/notes.js";
import { readResearch } from "../dist/research.js";
import { readSkills } from "../dist/skills.js";
import { readKnowledgeSearch } from "../dist/search.js";
import { searchDefinitions } from "../dist/search-contracts.js";

async function workspace(t) {
  const root = join(process.cwd(), `.search-test-workspace-${randomUUID()}`);
  await Promise.all(["notes", "skills", "papers"].map(area => mkdir(join(root, area), { recursive: true })));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeDocument(root, area, path, frontmatter, body) {
  const destination = join(root, area, path);
  const { dirname } = await import("node:path");
  await mkdir(dirname(destination), { recursive: true });
  const yaml = Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
  await writeFile(destination, `---\n${yaml}\n---\n${body}`);
  return destination;
}

function execute(root, operation, args, documents = scanMarkdown(root)) {
  return readKnowledgeSearch(root, documents, { operation, args, actorId: "search-test" });
}

test("literal search preserves legacy fields/order, pages and returns body-free addressed metadata", async t => {
  const root = await workspace(t);
  await writeDocument(root, "notes", "group/note.md", {
    title: "Literal a.* marker", type: "research", tags: ["search-tag"],
  }, "private-body-needle");
  await writeDocument(root, "notes", "group/other.md", {
    title: "A different title", type: "general",
  }, "private-body-needle but no literal token");
  await writeDocument(root, "skills", "category/skill.md", {
    name: "Skill Marker", description: "skill-description-marker", tags: ["skill-tag"],
  }, "private-skill-body");
  await writeDocument(root, "papers", "paper-a.md", {
    title: "Shared Research Marker", authors: ["Author Marker"], year: 2020,
    cites: ["Cited Research Marker"], conclusions: ["paper-conclusion-marker"],
  }, "private-paper-body");
  await writeDocument(root, "papers", "paper-b.md", {
    title: "Cited Research Marker", authors: ["Other Author"], year: 2022,
  }, "another private paper body");
  const documents = scanMarkdown(root);

  const note = execute(root, "knowledge.note.search", { query: "a.*", limit: 1 }, documents);
  assert.equal(note.total, 1);
  assert.equal(note.items[0].title, "Literal a.* marker");
  assert.equal(note.items[0].path, "group/note.md");
  assert.equal(note.items[0].documentSha256.length, 64);
  assert.equal("content" in note.items[0], false);
  assert.equal(JSON.stringify(note).includes("private-body-needle"), false);
  const caseSensitive = execute(root, "knowledge.note.search", { query: "LITERAL", caseSensitive: true }, documents);
  assert.equal(caseSensitive.total, 0);

  const notesByBody = execute(root, "knowledge.note.search", { query: "private-body-needle" }, documents);
  assert.equal(notesByBody.total, 2);
  const legacyNotes = readNotes(root, documents, {
    operation: "knowledge.note.list", args: { offset: 0, limit: 20 }, actorId: "search-test",
  });
  assert.equal(notesByBody.snapshotRevision, legacyNotes.snapshotRevision);
  const page = execute(root, "knowledge.note.search", {
    query: "private-body-needle", limit: 1, snapshotRevision: notesByBody.snapshotRevision,
  }, documents);
  assert.equal(page.items.length, 1);
  assert.equal(page.nextOffset, 1);

  const skill = execute(root, "knowledge.skill.search", { query: "skill-tag" }, documents);
  assert.equal(skill.total, 1);
  assert.equal(skill.items[0].name, "Skill Marker");
  assert.equal("content" in skill.items[0], false);
  assert.equal("_key" in skill.items[0], false);
  assert.equal(JSON.stringify(skill).includes("private-skill-body"), false);
  const skillsByBody = execute(root, "knowledge.skill.search", { query: "private-skill-body" }, documents);
  assert.equal(skillsByBody.total, 1);
  assert.equal("content" in skillsByBody.items[0], false);
  const legacySkills = readSkills(root, documents, {
    operation: "knowledge.skill.list", args: { offset: 0, limit: 20 }, actorId: "search-test",
  });
  assert.equal(skill.snapshotRevision, legacySkills.snapshotRevision);

  const papers = execute(root, "knowledge.research.search", { query: "research marker" }, documents);
  assert.equal(papers.total, 2);
  assert.equal(papers.items[0].slug, "paper-b");
  assert.equal(papers.items[0].citationCount, 1);
  assert.equal("content" in papers.items[0], false);
  assert.equal(JSON.stringify(papers).includes("private-paper-body"), false);
  const legacyResearch = readResearch(root, documents, {
    operation: "knowledge.research.list", args: { offset: 0, limit: 20 }, actorId: "search-test",
  });
  assert.equal(papers.revision, legacyResearch.revision);

  const absolutePathQuery = execute(root, "knowledge.note.search", { query: root }, documents);
  assert.equal(absolutePathQuery.total, 0);
});

test("regex requests and unbounded pages are explicitly rejected", async t => {
  const root = await workspace(t);
  assert.equal(searchDefinitions[0].input.safeParse({ query: "x", regex: true }).success, false);
  assert.equal(searchDefinitions[0].input.safeParse({ query: "x", limit: 101 }).success, false);
  assert.throws(
    () => execute(root, "knowledge.note.search", { query: "x", regex: true }),
    error => error instanceof CoreError && error.code === "INVALID_ARGUMENT" && /Regular-expression search is not supported/.test(error.message),
  );
});

test("Note search accepts snapshots above 32 MiB", async t => {
  const root = await workspace(t);
  await writeDocument(root, "notes", "large.md", { title: "Large" }, "body");
  const documents = scanMarkdown(root).map(document => ({ ...document, raw: "x".repeat(33_554_433) }));
  const result = execute(root, "knowledge.note.search", { query: "Large" }, documents);
  assert.equal(result.total, 1);
});

test("search pins detect changed collections and reject unknown input fields", async t => {
  const root = await workspace(t);
  const path = await writeDocument(root, "notes", "pinned.md", { title: "Pinned" }, "needle");
  const first = execute(root, "knowledge.note.search", { query: "needle" });
  await writeFile(path, (await readFile(path, "utf8")).replace("Pinned", "Changed"));
  const changed = scanMarkdown(root);
  assert.throws(
    () => execute(root, "knowledge.note.search", { query: "needle", snapshotRevision: first.snapshotRevision }, changed),
    error => error instanceof CoreError && error.code === "CONFLICT",
  );
  assert.throws(
    () => execute(root, "knowledge.skill.search", { query: "needle", unexpected: true }),
    error => error instanceof CoreError && error.code === "INVALID_ARGUMENT",
  );
});
