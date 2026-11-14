import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { initialize, Storage } from "../dist/storage.js";
import { Core } from "../dist/core.js";
import { decodeMarkdown } from "../dist/markdown.js";
import { readResearch } from "../dist/research.js";

async function fixture(t) {
  const parent = join(dirname(fileURLToPath(import.meta.url)), `.research-${randomUUID()}`);
  const directory = join(parent, "workspace");
  await mkdir(parent, { recursive: true });
  await initialize(directory);
  const storage = await Storage.open(directory), core = new Core(storage);
  t.after(async () => { try { await storage.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
  const query = (operation, args = {}) => core.dispatch("capability_read",
    { operation: `knowledge.research.${operation}`, version: 1, arguments: args }, { id: "local:reader", canWrite: false });
  async function paper(path, fields = {}, body = "Paper body") {
    const metadata = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
    const raw = metadata ? `---\n${metadata}\n---\n${body}` : body;
    await mkdir(join(directory, "papers", path, ".."), { recursive: true });
    await writeFile(join(directory, "papers", path), raw);
    return raw;
  }
  return { directory, storage, core, query, paper };
}

test("original research citation resolution/counts, ordering and body-free read models are preserved", async t => {
  const { directory, query, paper } = await fixture(t);
  const raw = await paper("Foundations/Base.MD", {
    title: "Foundational Work", year: "2020", authors: "Ada", tags: ["core", "core"], topic: "Retrieval",
    conclusions: ["Base result"], implementation: "Reference code", assumptions: ["Finite input"],
  }, "Private long-form body");
  await paper("Later.md", {
    title: "Later", year: 2025, cites: ["FOUNDATIONAL WORK", { target: "foundations/BASE.md", comment: "Second reference" }, "missing"],
    kind: "idea", group: "Roadmap", tags: ["core", "new"], pinned: true,
  });
  const list = await query("list", { limit: 1 });
  assert(!list.error, JSON.stringify(list.error));
  assert.equal(list.result.total, 2);
  assert.equal(list.result.nextOffset, 1);
  assert.equal(list.result.items[0].slug, "Foundations/Base");
  assert.equal(list.result.items[0].citationCount, 2, "Original counting counts references, not distinct citing documents.");
  assert.deepEqual(list.result.items[0].authors, ["Ada"]);
  assert.deepEqual(list.result.items[0].implementation, ["Reference code"]);
  assert(!Object.hasOwn(list.result.items[0], "content"));
  const next = await query("list", { offset: 1, revision: list.result.revision });
  assert.equal(next.result.items[0].kind, "idea");
  assert.equal(next.result.items[0].group, "Roadmap");
  assert.equal(next.result.nextOffset, null);
  const graph = await query("graph", { revision: list.result.revision });
  assert.equal(graph.result.shown, 2);
  assert.deepEqual(graph.result.edges, [
    { from: "Foundations/Base", to: "Later", note: "" },
    { from: "Foundations/Base", to: "Later", note: "Second reference" },
  ]);
  assert.equal(await readFile(join(directory, "papers/Foundations/Base.MD"), "utf8"), raw, "Reads must not establish identity/rewrite legacy Markdown.");
});

test("original research facets/groups retain duplicate tag counting and Papers fallback ordering", async t => {
  const { query, paper } = await fixture(t);
  await paper("A.md", { topic: "B", tags: ["x", "x"], year: 2022, group: "Zulu" });
  await paper("B.md", { topic: "A", tags: ["y"], year: "2023suffix", group: "Alpha" });
  await paper("C.md", { topic: "B", tags: "y", year: null });
  const facets = await query("facets");
  assert.deepEqual(facets.result.topics, [{ name: "B", count: 2 }, { name: "A", count: 1 }]);
  assert.deepEqual(facets.result.tags, [{ name: "x", count: 2 }, { name: "y", count: 2 }]);
  assert.deepEqual(facets.result.years, [2023, 2022]);
  assert.deepEqual((await query("groups", { revision: facets.result.revision })).result.items, [
    { name: "Alpha", count: 1 }, { name: "Zulu", count: 1 }, { name: "Papers", count: 1 },
  ]);
});

test("legacy title-resolution ties follow depth-first paths rather than unrelated stable document IDs", async t => {
  const { query, paper } = await fixture(t);
  await paper("A/Nested.md", { documentId: "z-last-id", title: "Same title" });
  await paper("A.md", { documentId: "a-first-id", title: "Same title" });
  await paper("Citing.md", { cites: ["same title"] });
  const graph = await query("graph");
  assert.deepEqual(graph.result.edges, [{ from: "A", to: "Citing", note: "" }]);
  assert.equal((await query("list")).result.items[0].slug, "A");
});

test("original graph filters and one-hop neighbor expansion do not become transitive", async t => {
  const { query, paper } = await fixture(t);
  await paper("Root.md", { title: "Root", year: 2000, topic: "Old" });
  await paper("Middle.md", { title: "Middle", authors: ["Ada Lovelace"], year: 2020, tags: ["target"], topic: "New", cites: ["Root"] });
  await paper("Child.md", { year: 2025, cites: ["Middle"] });
  await paper("Grandchild.md", { year: 2026, cites: ["Child"] });
  await paper("UnknownYear.md", { topic: "New" });
  const seed = await query("graph", { q: "ada", tag: "target", topic: "New", minYear: 2010, maxYear: 2024, limit: 1 });
  assert.equal(seed.result.total, 1);
  assert.deepEqual(seed.result.nodes.map(node => node.key), ["Middle"]);
  const expanded = await query("graph", { q: "ada", neighbors: true, limit: 1 });
  assert.equal(expanded.result.total, 1);
  assert.equal(expanded.result.shown, 3);
  assert.deepEqual(expanded.result.nodes.map(node => node.key), ["Middle", "Root", "Child"]);
  assert(!expanded.result.nodes.some(node => node.key === "Grandchild"));
  assert.equal((await query("graph", { topic: "New", minYear: 2010 })).result.total, 1);
  assert.equal((await query("graph", { minYear: 2025, maxYear: 2020 })).error.code, "INVALID_ARGUMENT");
});

test("research pins reject external metadata/body/mtime changes and ignore other knowledge areas", async t => {
  const { directory, query, paper } = await fixture(t);
  await paper("A.md", { title: "Before" });
  const first = (await query("list")).result;
  await writeFile(join(directory, "notes/Other.md"), "Other area");
  assert.equal((await query("facets", { revision: first.revision })).result.revision, first.revision);
  await paper("A.md", { title: "After" });
  assert.equal((await query("groups", { revision: first.revision })).error.code, "CONFLICT");
  const second = (await query("list")).result;
  await utimes(join(directory, "papers/A.md"), new Date(0), new Date(0));
  assert.equal((await query("list", { revision: second.revision })).error.code, "CONFLICT");
  const third = (await query("list")).result;
  await paper("A.md", { title: "After" }, "Changed body");
  assert.equal((await query("graph", { revision: third.revision })).error.code, "CONFLICT");
});

test("trashed research disappears consistently and an empty library retains the Papers group", async t => {
  const { core, query } = await fixture(t);
  assert.deepEqual((await query("groups")).result.items, [{ name: "Papers", count: 0 }]);
  assert.deepEqual((await query("graph")).result.nodes, []);
  const created = await core.dispatch("capability_call", {
    operation: "knowledge.document.create", version: 1,
    arguments: { operationId: randomUUID(), id: "paper", area: "papers", title: "Paper", content: "body" },
  }, { id: "local:owner", canWrite: true });
  const before = (await query("list")).result;
  assert.equal(before.total, 1);
  const removed = await core.dispatch("capability_call", {
    operation: "knowledge.document.trash", version: 1,
    arguments: { operationId: randomUUID(), id: "paper", expectedRevision: created.result.revision, expectedSha256: created.result.sha256 },
  }, { id: "local:owner", canWrite: true });
  assert(!removed.error, JSON.stringify(removed.error));
  assert.equal((await query("list")).result.total, 0);
  assert.deepEqual((await query("facets")).result.topics, []);
  assert.deepEqual((await query("graph")).result.edges, []);
  assert.equal((await query("groups", { revision: before.revision })).error.code, "CONFLICT");
});

test("malformed research metadata fails explicitly before executing original dynamically typed queries", async t => {
  const { query, paper } = await fixture(t);
  for (const fields of [{ title: 42 }, { tags: [{ bad: true }] }, { authors: [null] }, { topic: ["bad"] }, { created: 123 }]) {
    await paper("Bad.md", fields);
    for (const operation of ["list", "facets", "groups", "graph"]) {
      assert.equal((await query(operation)).error.code, "INVALID_DOCUMENT", JSON.stringify(fields));
    }
  }
});

test("research snapshot byte/count budgets reject overflow before projection or filesystem reads", async t => {
  const { directory, paper } = await fixture(t);
  const raw = await paper("A.md");
  const record = decodeMarkdown("paper", "Body", "A.md", "papers");
  const request = { operation: "knowledge.research.graph", args: {}, actorId: "local:reader" };
  assert.throws(() => readResearch("/nonexistent-test-only", Array(4097).fill(record), request), error => error.code === "BUSY");
  const large = { ...record, raw: "x".repeat(1_048_576) };
  assert.throws(() => readResearch("/nonexistent-test-only", Array(33).fill(large), request), error => error.code === "BUSY");
  assert.equal(readResearch(directory, Array(4096).fill({ ...record, raw }), request).total, 4096);
  assert.equal(readResearch(directory, Array(32).fill(large), request).total, 32);
});

test("research graph refuses oversized neighbor expansion rather than silently dropping nodes", async t => {
  const { query, paper } = await fixture(t);
  await paper("Root.md", { title: "Unique root" });
  await Promise.all(Array.from({ length: 1023 }, (_, index) => paper(`Child${index}.md`, { cites: ["Root"] })));
  assert.equal((await query("graph", { q: "Unique root", neighbors: true, limit: 1 })).result.shown, 1024);
  await paper("LastChild.md", { cites: ["Root"] });
  const expanded = await query("graph", { q: "Unique root", neighbors: true, limit: 1 });
  assert.equal(expanded.error.code, "BUSY");
  const bounded = await query("graph", { q: "Unique root", neighbors: false, limit: 1 });
  assert.equal(bounded.result.shown, 1);
});

test("research graph enforces the exact edge bound without changing original duplicate-reference semantics", async t => {
  const { query, paper } = await fixture(t);
  await paper("Root.md");
  await paper("Child.md", { cites: Array(16_384).fill("Root") });
  const exact = await query("graph");
  assert(!exact.error, JSON.stringify(exact.error));
  assert.equal(exact.result.edges.length, 16_384);
  await paper("Child.md", { cites: Array(16_385).fill("Root") });
  assert.equal((await query("graph")).error.code, "BUSY");
});
