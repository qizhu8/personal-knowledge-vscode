import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  applyKnowledgeMutation, deserializeKnowledgeMutationPlan, knowledgeMutationScanRevision,
  planKnowledgeMutation, recoverKnowledgeMutation, serializeKnowledgeMutationPlan,
} from "../dist/knowledge-mutations.js";
import { knowledgeMutationDefinitions, knowledgeMutationTransport } from "../dist/knowledge-mutations-contracts.js";
import { scanMarkdown } from "../dist/markdown.js";

const serverRoot = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(serverRoot, "legacy");
const fixtureRoot = join(serverRoot, "tests", `knowledge-mutations-fixture-${process.pid}-${randomUUID()}`);
mkdirSync(join(fixtureRoot, "notes"), { recursive: true });

function operationId() { return randomUUID(); }
function workspaceRevision(root = fixtureRoot) { return knowledgeMutationScanRevision(scanMarkdown(root)); }
function createRequest(operation, fields, root = fixtureRoot) {
  return { operation, actorId: "test:knowledge-mutations", args: { operationId: operationId(), expectedScanRevision: workspaceRevision(root), ...fields } };
}
function writeMarkdown(area, path, text, root = fixtureRoot) {
  const full = join(root, area, ...path.split("/"));
  mkdirSync(resolve(full, ".."), { recursive: true });
  writeFileSync(full, text);
  return full;
}
function identity(alias, id = `knowledge_${randomUUID().replaceAll("-", "").slice(0, 24)}`) {
  return { id, metadata: `schema: pkm.knowledge/v1\nknowledgeId: ${id}\nrevision: 1\naliases:\n  - ${alias}` };
}
function document(area, path, metadata, body = "") {
  const key = path.replace(/\.md$/i, "");
  const kind = area === "papers" ? "research" : area === "skills" ? "skill" : "note";
  const id = identity(`${kind}:${key}`);
  return { id: id.id, raw: `---\n${id.metadata}\n${metadata}---\n${body}` };
}
function plan(request, root = fixtureRoot) { return planKnowledgeMutation(root, request); }
function apply(planValue, root = fixtureRoot) { return applyKnowledgeMutation(root, planValue, planValue.operationId); }

test("contracts expose strict Note, Skill and Research mutation transport without generic CRUD aliases", () => {
  assert.deepEqual(knowledgeMutationDefinitions.map(item => item.id), [
    "knowledge.note.create", "knowledge.note.update",
    "knowledge.skill.create", "knowledge.skill.update",
    "knowledge.research.create", "knowledge.research.update",
  ]);
  const fixture = createRequest("knowledge.note.create", { title: "Schema contract", content: "", tags: ["contract"] });
  assert.equal(knowledgeMutationDefinitions[0].input.parse(fixture.args).title, "Schema contract");
  assert.deepEqual(knowledgeMutationTransport.parse(fixture), fixture);
  assert.throws(() => knowledgeMutationTransport.parse({ ...fixture, actorId: "test", extra: true }));
  assert.throws(() => knowledgeMutationDefinitions[0].input.parse({ ...fixture.args, extra: true }));
  assert.throws(() => knowledgeMutationDefinitions[1].input.parse({
    operationId: operationId(), expectedScanRevision: "0".repeat(64), expectedRevision: 1,
    expectedSha256: "0".repeat(64), id: "doc-1", content: "", unexpected: "reject",
  }));
});

test("specialized Note mutations persist Markdown above the former size ceiling", () => {
  const content = "large-note ".repeat(110_000);
  const request = createRequest("knowledge.note.create", { title: "Large Note", content });
  const planned = plan(request);
  const restored = deserializeKnowledgeMutationPlan(serializeKnowledgeMutationPlan(planned));
  assert(restored.change.after.length > 1_048_576);
  apply(restored);
  const persisted = scanMarkdown(fixtureRoot).find(document => document.record.title === "Large Note");
  assert.equal(persisted?.record.content.length, content.length);
});

test("Note create/update keeps stable identity, category, unknown YAML, comments, body and opaque assets", () => {
  const createdPlan = plan(createRequest("knowledge.note.create", {
    title: "Capture", category: "Research/Field Notes", type: "journal", tags: ["field", "review"],
    content: "Opening prose.\r\n![evidence](Capture.assets/raw.bin)\r\n",
  }));
  const created = apply(deserializeKnowledgeMutationPlan(serializeKnowledgeMutationPlan(createdPlan)));
  assert.equal(created.path, "Research/Field Notes/Capture.md");
  assert.equal(created.revision, 1);
  assert.throws(() => plan(createRequest("knowledge.note.create", {
    title: "capture", category: "research/field notes", content: "Case collision.",
  })), error => error.code === "CONFLICT");
  assert.throws(() => plan(createRequest("knowledge.note.create", {
    title: "Unsafe", category: "_assets", content: "Not indexable.",
  })), error => error.code === "ACCESS_DENIED");
  const assets = join(fixtureRoot, "notes", "Research", "Field Notes", "Capture.assets");
  mkdirSync(assets, { recursive: true });
  const opaque = Buffer.from([0, 1, 0xff, 0x7f, 0x0a]);
  writeFileSync(join(assets, "raw.bin"), opaque);

  const path = join(fixtureRoot, "notes", "Research", "Field Notes", "Capture.md");
  let raw = readFileSync(path, "utf8");
  raw = raw.replace(/tags: (\[[^\n]*\])/, "tags: $1 # preserve this inline note")
    .replace("---\n", "---\n# preserve the heading comment\n", 1)
    .replace('type: "journal"', 'type: "journal"\nunknownBlock:\n  nested: keep-me # untouched');
  writeFileSync(path, raw);
  const before = scanMarkdown(fixtureRoot).find(item => item.record.path === "Research/Field Notes/Capture.md");
  const update = plan(createRequest("knowledge.note.update", {
    id: created.id, expectedRevision: before.record.revision, expectedSha256: before.record.sha256,
    title: "Capture", type: "field-note", tags: ["field", "published"],
  }));
  const serialized = serializeKnowledgeMutationPlan(update);
  const after = recoverKnowledgeMutation(fixtureRoot, deserializeKnowledgeMutationPlan(serialized), update.operationId);
  assert.equal(after.id, created.id);
  assert.equal(after.revision, 2);
  const changed = readFileSync(path, "utf8");
  assert.match(changed, /# preserve the heading comment/);
  assert.match(changed, /unknownBlock:\n  nested: keep-me # untouched/);
  assert.match(changed, /# preserve this inline note/);
  assert.match(changed, /Opening prose\.\r\n!\[evidence\]\(Capture\.assets\/raw\.bin\)\r\n$/);
  assert.deepEqual(readFileSync(join(assets, "raw.bin")), opaque);

  const commented = document("notes", "Commented.md", "title: Commented\ntags:\n  - old # keep this nested comment\n");
  const commentedPath = writeMarkdown("notes", "Commented.md", commented.raw);
  const current = scanMarkdown(fixtureRoot).find(item => item.record.path === "Commented.md");
  assert.throws(() => plan(createRequest("knowledge.note.update", {
    id: current.record.id, expectedRevision: current.record.revision, expectedSha256: current.record.sha256,
    title: "Commented", tags: ["new"],
  })), error => error.code === "UNSUPPORTED_OPERATION");
  assert.equal(readFileSync(commentedPath, "utf8"), commented.raw);
});

test("Note pin state is created and updated through the same identity-preserving CAS mutation", () => {
  const created = apply(plan(createRequest("knowledge.note.create", {
    title: "Pinned Note", content: "Keep this note.", pinned: true,
  })));
  assert.equal(created.revision, 1);
  let record = scanMarkdown(fixtureRoot).find(item => item.record.id === created.id);
  assert.equal(record.metadata.get("pinned"), true);
  const identity = record.metadata.get("knowledgeId");

  const updated = apply(plan(createRequest("knowledge.note.update", {
    id: created.id, expectedRevision: record.record.revision, expectedSha256: record.record.sha256,
    title: "Pinned Note", pinned: false,
  })));
  record = scanMarkdown(fixtureRoot).find(item => item.record.id === created.id);
  assert.equal(updated.revision, 2);
  assert.equal(record.metadata.get("pinned"), false);
  assert.equal(record.metadata.get("knowledgeId"), identity);
  assert.equal(record.record.content, "Keep this note.");
});

test("Skill create enforces unique names and Skill update CAS preserves identity", () => {
  const first = apply(plan(createRequest("knowledge.skill.create", {
    name: "Runbook", category: "Operations", content: "Original procedure.", tags: ["ops"],
  })));
  const second = apply(plan(createRequest("knowledge.skill.create", { name: "Deploy", content: "Deployment." })));
  const createDuplicate = createRequest("knowledge.skill.create", { name: "Runbook", category: "Other", content: "Duplicate." });
  assert.throws(() => plan(createDuplicate), error => error.code === "CONFLICT");
  const before = scanMarkdown(fixtureRoot).find(item => item.record.id === first.id);
  const stale = createRequest("knowledge.skill.update", {
    id: first.id, expectedRevision: before.record.revision, expectedSha256: before.record.sha256,
    name: "Runbook", content: "Revised procedure.", tags: ["ops", "verified"], priority: "high",
  });
  const result = apply(plan(stale));
  assert.equal(result.id, first.id);
  assert.equal(result.revision, 2);
  const changed = scanMarkdown(fixtureRoot).find(item => item.record.id === first.id);
  assert.equal(changed.record.content, "Revised procedure.");
  assert.deepEqual(changed.metadata.toJS({ maxAliasCount: 0 }).tags, ["ops", "verified"]);
  const duplicateRename = scanMarkdown(fixtureRoot).find(item => item.record.id === second.id);
  assert.throws(() => plan(createRequest("knowledge.skill.update", {
    id: second.id, expectedRevision: duplicateRename.record.revision, expectedSha256: duplicateRename.record.sha256,
    name: "Runbook",
  })), error => error.code === "CONFLICT");
  const staleAgain = { ...stale, args: { ...stale.args, operationId: operationId() } };
  assert.throws(() => plan(staleAgain), error => error.code === "CONFLICT");
});

test("Research citations canonicalize like the original projection and stale sources fail closed", () => {
  const first = apply(plan(createRequest("knowledge.research.create", {
    title: "Parent Study", category: "Papers", authors: ["A. Author"], year: 2024, content: "Source body.",
  })));
  const second = apply(plan(createRequest("knowledge.research.create", {
    title: "Child Study", category: "Papers", cites: [
      { paper: "parent study", note: "supports result" }, { paper: "missing", note: "discarded by original" },
      { paper: "Papers/Child Study", note: "self citation" },
    ],
  })));
  const records = scanMarkdown(fixtureRoot);
  const child = records.find(item => item.record.id === second.id);
  assert.deepEqual(child.metadata.toJS({ maxAliasCount: 0 }).cites, [{ paper: "Papers/Parent Study", note: "supports result" }]);
  const pending = plan(createRequest("knowledge.research.update", {
    id: first.id, expectedRevision: records.find(item => item.record.id === first.id).record.revision,
    expectedSha256: records.find(item => item.record.id === first.id).record.sha256,
    title: "Parent Study", cites: [{ paper: "Papers/Child Study", note: "child" }],
  }));
  const source = records.find(item => item.record.id === child.record.id);
  writeFileSync(join(fixtureRoot, "papers", ...source.record.path.split("/")), source.raw + "\nExternal edit.");
  assert.throws(() => apply(pending), error => error.code === "RECOVERY_CONFLICT" || error.code === "CONFLICT");
});

test("guarded Board and explicit-memory descriptors cannot be edited as specialized Notes", () => {
  const board = document("notes", "Board.md", "title: Board\ndocumentKind: todo-board\n");
  const boardPath = writeMarkdown("notes", "Board.md", board.raw);
  const boardRecord = scanMarkdown(fixtureRoot).find(item => item.record.path === "Board.md");
  assert.throws(() => plan(createRequest("knowledge.note.update", {
    id: boardRecord.record.id, expectedRevision: boardRecord.record.revision, expectedSha256: boardRecord.record.sha256,
    title: "Board", content: "not allowed",
  })), error => error.code === "ACCESS_DENIED");
  writeFileSync(boardPath, board.raw);

  const memory = document("notes", "Memory.md", 'title: Memory\nmemory:\n  schema: pkm.explicit-memory/v1\n');
  writeMarkdown("notes", "Memory.md", memory.raw);
  const memoryRecord = scanMarkdown(fixtureRoot).find(item => item.record.path === "Memory.md");
  assert.throws(() => plan(createRequest("knowledge.note.update", {
    id: memoryRecord.record.id, expectedRevision: memoryRecord.record.revision, expectedSha256: memoryRecord.record.sha256,
    title: "Memory", content: "not allowed",
  })), error => error.code === "ACCESS_DENIED");
});

test("serialized recovery accepts exact before/after restart states and refuses unknown target bytes", () => {
  const fixture = document("notes", "Restart.md", "title: Restart\n", "Exact source.\n");
  const full = writeMarkdown("notes", "Restart.md", fixture.raw);
  const before = scanMarkdown(fixtureRoot).find(item => item.record.path === "Restart.md");
  const request = createRequest("knowledge.note.update", {
    id: before.record.id, expectedRevision: before.record.revision, expectedSha256: before.record.sha256,
    title: "Restart", content: "After restart.\n",
  });
  const pending = deserializeKnowledgeMutationPlan(serializeKnowledgeMutationPlan(plan(request)));
  const applied = apply(pending);
  assert.deepEqual(recoverKnowledgeMutation(fixtureRoot, deserializeKnowledgeMutationPlan(serializeKnowledgeMutationPlan(pending)), pending.operationId), applied);
  assert.equal(scanMarkdown(fixtureRoot).find(item => item.record.id === before.record.id).record.content, "After restart.\n");
  writeFileSync(full, "unknown external bytes\n");
  assert.throws(() => recoverKnowledgeMutation(fixtureRoot, pending, pending.operationId), error => error.code === "RECOVERY_CONFLICT");
});

test("captured original source and focused tests remain repeatable and byte-parity checked", () => {
  execFileSync(process.execPath, ["scripts/capture-knowledge-mutations.mjs", "--check"], { cwd: serverRoot, stdio: "pipe" });
  assert.ok(readFileSync(resolve(sourceRoot, "src/knowledge/filestore.ts"), "utf8").includes("export function paperUpsert"));
});

test.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
