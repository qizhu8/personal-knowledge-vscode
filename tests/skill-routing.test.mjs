import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm, utimes } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { decodeMarkdown } from "../dist/markdown.js";
import { readSkillRouting, skillRoutingDefinitions } from "../dist/skill-routing.js";
import { rankSkillContext, skillContextHash, skillContextTerms } from "../dist/domain/skill-routing-context.js";
import { originalSkillRoutingSource } from "../dist/domain/skill-routing-original.js";
import { checkCaptureRecords, hash } from "../scripts/migration.mjs";

async function fixture(t) {
  const root = fileURLToPath(new URL(`skill-routing-fixture-${randomUUID()}/`, import.meta.url));
  await mkdir(join(root, "skills"), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const documents = [];
  async function add(id, path, fm = {}, body = "Complete procedure") {
    const raw = `---\n${Object.entries(fm).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n${body}`;
    await mkdir(join(root, "skills", path, ".."), { recursive: true });
    await writeFile(join(root, "skills", path), raw);
    const document = decodeMarkdown(id, raw, path, "skills");
    documents.push(document);
    return document;
  }
  return { root, documents, add, read: (name, args = {}) => readSkillRouting(root, documents,
    { operation: `knowledge.skill.routing.${name}`, args, actorId: "isolated:reader" }) };
}
const error = code => value => value?.code === code;

test("public canonical Zod registry accepts defaults and rejects unsupported/oversized arguments", async t => {
  const f = await fixture(t);
  assert.equal(skillRoutingDefinitions.length, 5);
  for (const definition of skillRoutingDefinitions) {
    assert.equal(definition.readOnly, true);
    assert.ok(definition.description && definition.input && definition.output);
  }
  const defaults = f.read("sources");
  assert.deepEqual(defaults.sources.map(source => source.id), ["pkm-personal", "agent-native"]);
  assert.deepEqual(defaults.sourcePriority, ["pkm-personal", "agent-native"]);
  assert.ok(defaults.adapters.every(adapter => !adapter.available && adapter.reason));
  assert.deepEqual(f.read("sources", { sourcePriority: ["agent-native", "missing", "agent-native"] }).sourcePriority,
    ["agent-native", "pkm-personal"]);
  assert.throws(() => f.read("select", { query: "x", unknown: true }), error("INVALID_ARGUMENT"));
  assert.throws(() => f.read("select", { query: "x", limit: 101 }), error("INVALID_ARGUMENT"));
  assert.throws(() => f.read("select", { query: "界".repeat(3000) }), error("INVALID_ARGUMENT"));
  assert.throws(() => f.read("select", { query: "\ud800" }), error("INVALID_ARGUMENT"));
  assert.throws(() => f.read("context", { task: " " }), error("INVALID_ARGUMENT"));
  assert.throws(() => f.read("context", { task: "x", detail: "summary" }), error("INVALID_ARGUMENT"));
  assert.throws(() => f.read("context", { task: "x", limit: 6 }), error("INVALID_ARGUMENT"));
  assert.throws(() => f.read("unknown"), error("NOT_FOUND"));
});

test("original Chat metadata selection preserves filters, score ties, top-20, bodies and paging", async t => {
  const f = await fixture(t);
  await f.add("z", "Z/Proc.md", { name: "Zulu", tags: ["pytest"], priority: "highest" }, "Body-only needle");
  await f.add("a", "A/Proc.md", { name: "Alpha", tags: ["pytest"], pinned: true, recipe_required: true, recipe_hint: "Recipe", related_skills: ["Zulu"] });
  await f.add("b", "A/Empty.md", { name: "Empty", tags: ["pytest"] }, "");
  await f.add("c", "A/Other.md", { name: "Other" }, "pytest body is not metadata");
  const first = f.read("select", { query: "pytest", limit: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.items[0].id, "Alpha", "priority and pinned do not alter original Chat score ties");
  assert.equal(first.nextOffset, 1);
  const second = f.read("select", { query: "pytest", offset: 1, snapshotRevision: first.snapshotRevision });
  assert.equal(second.items[0].id, "Zulu");
  assert.equal(second.nextOffset, null);
  assert.equal(f.read("select", { query: "needle" }).total, 0);
  assert.equal(f.read("select", { query: "pytest", category: "A", tag: "pytest" }).total, 1);
  assert.equal(f.read("select", { query: "pytest", category: "a" }).total, 0);
  assert.equal(f.read("select", { query: "pytest", tag: "PYTEST" }).total, 0);
  assert.equal(first.items[0].content, "Complete procedure");
  for (let index = 0; index < 22; index++) await f.add(`extra-${index}`, `Extras/${index}.md`, { name: `Extra ${index}`, tags: ["pytest"] });
  assert.equal(f.read("select", { query: "pytest" }).total, 19, "Original cap of 20 applies BEFORE empty-body elimination, without refill.");
});

test("explicit selected projection preserves order, full recipes, raw router parsing and marker", async t => {
  const f = await fixture(t);
  const one = await f.add("first", "One.md", { name: "First", pinned: true, priority: "highest",
    recipe_required: true, recipe_hint: "", description: "Reusable diagnosis", related_skills: ["Second"] }, "Do not execute this.");
  await f.add("second", "Two.md", { name: "Second" });
  const router = await f.add("router", "System/PKM/PKM Skills.md", { name: "Router", description: "Amy's router" }, "  Router body  \n");
  const result = f.read("project", { selected: [{ id: "second" }, { id: "first", documentSha256: one.record.sha256 }],
    routerId: "router", target: "copilot", extensionVersion: "test" });
  assert.deepEqual(result.items.map(item => item.name), ["Second", "First"]);
  assert.equal(result.items[1].content, "Do not execute this.");
  assert.equal(result.items[1].pinned, true);
  assert.equal(result.items[1].linkage.recipe_hint, "Reusable diagnosis");
  assert.deepEqual(result.items[1].linkage.related_skills, ["Second"]);
  assert.equal(result.items[1].linkage.next_action.kind, "search_or_create_recipe");
  assert.match(result.projection.content, /description: 'Amy''s router'/);
  assert.match(result.projection.content, /"routerVersion":"2.0.0"/);
  assert.match(result.projection.content, /"minimumMcpSchema":"2.8.0"/);
  assert.match(result.projection.content, /"target":"copilot"/);
  assert.match(result.projection.content, /"source":"System\/PKM\/PKM Skills.md"/);
  assert.equal(result.projection.sourceHash, hash(router.raw));
  assert.ok(result.projection.content.endsWith("Router body\n"));
  assert.equal(await readFile(join(f.root, "skills/One.md"), "utf8"), one.raw);
  assert.throws(() => f.read("project", { selected: [{ id: "first" }, { id: "First" }] }), error("CONFLICT"));
  assert.throws(() => f.read("project", { selected: [{ id: "missing" }] }), error("NOT_FOUND"));
  assert.throws(() => f.read("project", { selected: [{ id: "first", documentSha256: "0".repeat(64) }] }), error("CONFLICT"));
});

test("original prompt priorities and selected judgments remain projections, never model/learning calls", async t => {
  const f = await fixture(t);
  await f.add("one", "One.md", { name: "Distracting reference" });
  await f.add("two", "Two.md", { name: "Weekly-Labeling-Overview" });
  const selected = [{ id: "one" }, { id: "two" }];
  const result = f.read("prompt", { query: "根据 Weekly-Labeling-Overview 比较 sampling", selected,
    judgments: '{"labels":[{"index":0,"relevant":false},{"index":1,"relevant":null}]}' });
  assert.ok(result.priorities[1].priority > result.priorities[0].priority);
  assert.match(result.messages[0].content, /not verified human truth/);
  assert.match(result.messages[0].content, /Do not execute tools/);
  assert.deepEqual(result.selection, { relevant: [], judged: [result.sourceIds[0]] });
  assert.throws(() => f.read("prompt", { query: "x", selected, judgments: '{"labels":[]}' }), error("INVALID_ARGUMENT"));
  assert.throws(() => f.read("prompt", { query: "x", selected: [{ id: "one" }, { id: "Distracting reference" }] }), error("CONFLICT"));
});

test("raw bytes, metadata/priority/pinned, decoded records, identity and mtime pin all related reads", async t => {
  const f = await fixture(t);
  const item = await f.add("one", "One.md", { name: "Alpha", priority: "high" });
  const pin = f.read("sources").snapshotRevision;
  item.metadata.set("pinned", true);
  assert.throws(() => f.read("sources", { snapshotRevision: pin }), error("CONFLICT"));
  item.metadata.delete("pinned");
  assert.equal(f.read("sources").snapshotRevision, pin);
  item.metadata.set("priority", "highest");
  assert.throws(() => f.read("context", { task: "Alpha", snapshotRevision: pin }), error("CONFLICT"));
  item.metadata.set("priority", "high");
  item.record.revision = 2;
  assert.throws(() => f.read("select", { query: "Alpha", snapshotRevision: pin }), error("CONFLICT"));
  item.record.revision = 1;
  item.record.content += " changed";
  assert.throws(() => f.read("project", { selected: [{ id: "one" }], snapshotRevision: pin }), error("CONFLICT"));
  item.record.content = "Complete procedure";
  item.raw += "\n";
  item.record.sha256 = hash(item.raw);
  assert.throws(() => f.read("sources", { snapshotRevision: pin }), error("CONFLICT"));
  item.raw = item.raw.slice(0, -1);
  item.record.sha256 = hash(item.raw);
  item.record.id = "new-id";
  assert.throws(() => f.read("sources", { snapshotRevision: pin }), error("CONFLICT"));
  item.record.id = "one";
  await utimes(join(f.root, "skills/One.md"), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  assert.throws(() => f.read("sources", { snapshotRevision: pin }), error("CONFLICT"));
});

test("ambiguous names, stable IDs, invalid metadata, record bounds and UTF-8 bytes fail without partial results", async t => {
  const f = await fixture(t);
  await f.add("one", "One.md", { name: "Duplicate", tags: ["match"] });
  const two = await f.add("two", "Two.md", { name: "Duplicate", tags: ["match"] });
  assert.throws(() => f.read("select", { query: "match" }), error("CONFLICT"));
  assert.throws(() => f.read("project", { selected: [{ id: "Duplicate" }] }), error("CONFLICT"));
  assert.equal(f.read("project", { selected: [{ id: "one" }] }).items[0].address.documentId, "one");
  assert.throws(() => f.read("prompt", { query: "match", selected: [{ id: "one" }, { id: "two" }] }), error("CONFLICT"));
  two.record.id = "one";
  assert.throws(() => f.read("sources"), error("CONFLICT"));
  two.record.id = "two";
  two.metadata.set("tags", [7]);
  assert.throws(() => f.read("sources"), error("INVALID_DOCUMENT"));
  two.metadata.set("tags", ["match"]);
  two.raw = "\ud800";
  two.record.sha256 = hash(two.raw);
  assert.throws(() => f.read("sources"), error("INVALID_DOCUMENT"));
  two.raw = "界".repeat(349526);
  two.record.sha256 = hash(two.raw);
  assert.throws(() => f.read("sources"), error("INVALID_DOCUMENT"));
  two.raw = "x".repeat(17_000_000);
  f.documents[0].raw = "x".repeat(17_000_000);
  assert.throws(() => f.read("sources"), error("BUSY"));
  f.documents.splice(0, f.documents.length, ...Array.from({ length: 4097 }, () => two));
  assert.throws(() => f.read("sources"), error("BUSY"));
});

test("full output bound is UTF-8, not characters; no prefixes or automatic truncation", async t => {
  const f = await fixture(t);
  await f.add("large", "Large.md", { name: "Large" }, "界".repeat(90_000));
  assert.throws(() => f.read("project", { selected: [{ id: "large" }] }), error("BUSY"));
  assert.throws(() => f.read("select", { query: "Large" }), error("BUSY"));
});

test("metadata context preserves compact/full activation detail, high/highest, anchors, body-only rejection and native source policy", async t => {
  const f = await fixture(t);
  await f.add("highest", "Highest.md", { name: "Protected fixture", description: "Python pytest diagnosis", priority: "highest" });
  await f.add("high", "High.md", { name: "Boosted fixture", description: "Python pytest diagnosis", priority: " HIGH " });
  await f.add("normal", "Normal.md", { name: "Normal fixture", description: "Python pytest diagnosis" });
  await f.add("body", "Body.md", { name: "Unrelated fixture" }, "Python pytest diagnosis");
  const result = f.read("context", { task: "python pytest diagnosis", sourcePriority: ["agent-native"] });
  assert.deepEqual(result.items.map(item => item.address.documentId), ["highest", "high", "normal"]);
  assert.equal(result.items[0].priority, "required");
  assert.equal(result.items[1].skill_priority, "high");
  assert.equal(result.items[0].source_rank, 2);
  assert.match(result.sourcePolicy, /^Evaluate applicable Agent Native/);
  assert.ok(result.items.every(item => item.source_key === "pkm-personal"));
  assert.ok(result.items.every(item => /^[a-f0-9]{64}$/.test(item.content_hash)));
  assert.ok(result.items.every(item => !Object.hasOwn(item, "score") && !Object.hasOwn(item, "category")
    && !Object.hasOwn(item, "tags") && !Object.hasOwn(item, "source_project")), "compact detail matches the original MCP default");
  const full = f.read("context", { task: "python pytest diagnosis", detail: "full" });
  assert.equal(full.items[0].category, "");
  assert.deepEqual(full.items[0].tags, []);
  assert.equal(full.items[0].source_project, null);
  assert.equal(typeof full.items[0].score, "number");
  assert.equal(f.read("context", { task: "astronomy radiation" }).noMatch, true);
  assert.equal(f.read("context", { task: "Unrelated fixture" }).items[0].address.documentId, "body", "exact identifier admission");
});

test("metadata fallback rank/coverage/reasons are differential-tested against captured original Python", async t => {
  const f = await fixture(t);
  await f.add("a", "Coding/Python.md", { name: "Python Testing", description: "Use when debugging Python tests with pytest and import errors.", tags: ["python", "pytest"], priority: "high" });
  await f.add("b", "Project/Task.md", { name: "TODO Notes", description: "Use for project task checklists progress notes coding work and issue tracking.", tags: ["task", "coding", "notes"] });
  await f.add("c", "Coding/Scope.md", { name: "Scope Python Packaging", description: "Package and import local Python dependencies for Scope UDO execution.", tags: ["python", "package", "scope"], priority: "highest" });
  const entries = f.read("project", { selected: [{ id: "a" }, { id: "b" }, { id: "c" }] }).items;
  const original = originalSkillRoutingSource.replaceAll("\\\\", "\\");
  const terms = original.slice(original.indexOf("_SKILL_STOP_WORDS ="), original.indexOf('\n@_feature_tool("skillRouter", read_only=True)\ndef skill_capabilities'));
  let body = original.slice(original.indexOf("  task_terms = _skill_terms(task)"), original.indexOf("  no_match = not skills"));
  body = body.replace(/  boundary = _retrieval_request\([\s\S]*?\n  boundary_rank =/, "  boundary = {}\n  boundary_rank =");
  const program = `import json, re, sys, hashlib\npayload=json.loads(sys.stdin.read())\nrows=payload["rows"]\n${terms}\n` +
    `def _skill_id(row): return ((row.get("category") or "") + "/" + row["name"]).strip("/")\n` +
    `def _router_source_priority(): return ["pkm-personal", "agent-native"]\n` +
    `def _skill_source_key(row): return "pkm-personal"\n` +
    `def _skill_source_rank(row, priority): return 0\n` +
    `def _all_skills(): return rows\n` +
    `def _skill_hash(row): return ""\n` +
    `def _skill_linkage(row): return {}\n` +
    `def run(task, workspace="", files=[], diagnostics="", limit=3):\n${body}\n  return [{"name":r[5]["name"],"score":r[2],"coverage":r[3],"count":r[4],"reasons":r[6]} for r in ranked]\n` +
    `print(json.dumps([run(task) for task in payload["tasks"]]))`;
  const tasks = ["debug Python tests pytest import", "Scope Python Packaging", "project checklists notes", "astronomy radiation", "python import packaging task", "Straße STRASSE ²² ½½ 𐐀𐐁"];
  const pythonRows = entries.map(row => ({ ...row, tags: JSON.parse(row.tags) }));
  const child = spawnSync("python3", ["-B", "-c", program], {
    input: JSON.stringify({ rows: pythonRows, tasks }), encoding: "utf8", cwd: f.root,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(child.status, 0, child.stderr);
  const expected = JSON.parse(child.stdout);
  const actual = tasks.map(task => rankSkillContext(entries, task, "", [], "", ["pkm-personal", "agent-native"])
    .map(candidate => ({ name: candidate.row.name, score: candidate.score, coverage: candidate.coverage,
      count: candidate.metadataCount, reasons: candidate.reasons })));
  assert.deepEqual(actual, expected);
  const hashProbe = spawnSync("python3", ["-B", "-c",
    'import json,hashlib,sys; row=json.loads(sys.stdin.read()); fields={key:row[key] for key in ["name","description","category","tags","recipe_required","recipe_hint","related_skills","content"]}; print(hashlib.sha256(json.dumps(fields,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode("utf-8")).hexdigest())'],
  { input: JSON.stringify(pythonRows[0]), encoding: "utf8", cwd: f.root, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(hashProbe.status, 0, hashProbe.stderr);
  assert.equal(skillContextHash(entries[0]), hashProbe.stdout.trim());
  assert.deepEqual([...skillContextTerms("Straße STRASSE ²² ½½")].sort(), ["strasse", "½½"]);
});

test("repeatable source captures have exact provenance hashes and no vscode runtime import", async () => {
  const provenance = JSON.parse(await readFile(new URL("../migration/skill-routing-provenance.json", import.meta.url), "utf8"));
  assert.deepEqual(await checkCaptureRecords(provenance.files), []);
  for (const record of provenance.files.filter(record => record.captured.endsWith(".ts"))) {
    const content = await readFile(new URL(`../${record.captured}`, import.meta.url), "utf8");
    assert.doesNotMatch(content, /(?:from\s+|require\(\s*)["']vscode/);
  }
});
