import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeLinksResolveOutput } from "../dist/domain/links.js";
import {
  buildKnowledgeLinksSnapshot,
  LinksSnapshotError,
  resolveKnowledgeLinks,
} from "../dist/links.js";

const uri = (hex) => `pkm://knowledge/knowledge_${hex.repeat(24)}`;
const pins = { notes: "a".repeat(64), skills: "b".repeat(64), research: "c".repeat(64) };
const note = uri("1");
const skill = uri("2");
const paper = uri("3");
const absent = uri("4");
const source = (address, collection, sourceRevision, links = []) => ({
  uri: address, collection, sourceRevision, links,
});
const link = (target, relation, mode = "floating", required = false, targetRevision) => ({
  target, relation, mode, required, ...(targetRevision ? { targetRevision } : {}),
});
const markdownSource = (area, id, knowledgeId, revision, links = [], body = "source body", extra = {}) => {
  const rel = `${id}.md`;
  const metadata = { knowledgeId, revision, links, ...extra };
  const raw = `---\n${JSON.stringify(metadata)}\n---\n${body}`;
  return {
    document: {
      raw,
      record: {
        id, path: rel, area, title: id, content: body, revision: 1, deleted: false,
        sha256: `${id.charCodeAt(0).toString(16).padStart(2, "0")}`.repeat(32),
      },
    },
    rel,
    mtime: 0,
    fm: metadata,
    body,
  };
};

test("builds a bounded, canonical cross-area snapshot from knowledgeSnapshot records", () => {
  const noteSource = markdownSource("notes", "note-a", "knowledge_111111111111111111111111", 4,
    [link(skill, "supports", "pinned", true, "7")]);
  const skillSource = markdownSource("skills", "skill-b", "knowledge_222222222222222222222222", 7,
    [link(paper, "cites")]);
  const paperSource = markdownSource("papers", "paper-c", "knowledge_333333333333333333333333", 8,
    [link(note, "mentions")], "paper text", { conclusions: ["result"] });
  const snapshot = buildKnowledgeLinksSnapshot({
    notes: [noteSource], skills: [skillSource], research: [paperSource],
  });
  assert.deepEqual(snapshot.sources.map(item => [item.collection, item.sourceRevision]), [
    ["notes", "4"], ["skills", "7"], ["research", "8"],
  ]);
  const result = resolveKnowledgeLinks(snapshot, {
    starts: [note], direction: "both",
    maxDepth: 3, maxNodes: 10, maxEdges: 10,
  });
  assert.deepEqual(new Set(result.nodes.map(item => item.uri)), new Set([note, skill, paper]));
  assert(result.edges.every(item => item.resolved));
});

test("builder follows provider fallback body conventions and ignores noncanonical identities", () => {
  const noteSource = markdownSource("notes", "note-a", "knowledge_111111111111111111111111", undefined, [], "note body");
  const paperSource = markdownSource("papers", "paper-c", "knowledge_333333333333333333333333", undefined, [], "paper body",
    { conclusions: ["conclusion"], implementation: ["implementation"], assumptions: ["assumption"] });
  const noncanonical = markdownSource("skills", "old-skill", "legacy_skill", 2);
  const snapshot = buildKnowledgeLinksSnapshot({
    notes: [noteSource], skills: [noncanonical], research: [paperSource],
  });
  assert.equal(snapshot.sources.length, 2);
  assert.equal(snapshot.sources.find(item => item.uri === note)?.sourceRevision,
    "1c727d26215adccb96d725e8b63b3ee11cf73215a554e60295877244b0778847");
  assert.equal(snapshot.sources.find(item => item.uri === paper)?.sourceRevision,
    "e5573e19dc68a07f7a785cd5253afba12a23715299bdf8b72e5e555d897c6483");
});

test("builder rejects cross-area ambiguity and accepts snapshots beyond former count and byte limits", () => {
  const duplicate = markdownSource("skills", "skill-b", "knowledge_111111111111111111111111", 7);
  assert.throws(() => buildKnowledgeLinksSnapshot({
    notes: [markdownSource("notes", "note-a", "knowledge_111111111111111111111111", 4)],
    skills: [duplicate], research: [],
  }), error => error instanceof LinksSnapshotError && error.code === "INVALID_SNAPSHOT");
  const many = Array.from({ length: 4097 }, (_, index) =>
    markdownSource("notes", `note-${index}`, `knowledge_${index.toString(16).padStart(24, "0")}`, 4));
  assert.equal(buildKnowledgeLinksSnapshot({ notes: many, skills: [], research: [] }).sources.length, 4097);
  const large = markdownSource("notes", "large-note", "knowledge_111111111111111111111111", 4, [], "x".repeat(33_554_433));
  assert.equal(buildKnowledgeLinksSnapshot({ notes: [large], skills: [], research: [] }).sources.length, 1);
});

test("resolves current and exactly pinned Knowledge targets and reports unsupported or missing links", () => {
  const snapshot = {
    pins,
    sources: [
      source(note, "notes", "1", [
        link(skill, "supports", "pinned", true, "7"),
        link(paper, "cites"),
        link(absent, "mentions"),
        link("pkm://script/script_example", "runs"),
        link("https://example.invalid/reference", "references"),
      ]),
      source(skill, "skills", "7"),
      source(paper, "research", "8"),
    ],
  };
  const result = resolveKnowledgeLinks(snapshot, {
    starts: [note], snapshotPins: pins, direction: "forward", maxDepth: 1,
    maxNodes: 10, maxEdges: 10, pageSize: 50,
  });
  assert.equal(result.totalNodes, 3);
  assert.equal(result.totalEdges, 5);
  assert.equal(result.edges.find(edge => edge.target === skill)?.resolved, true);
  assert.equal(result.edges.find(edge => edge.target === paper)?.resolved, true);
  assert.equal(result.edges.find(edge => edge.target === absent)?.resolved, false);
  assert.equal(result.edges.find(edge => edge.target === "pkm://script/script_example")?.resolved, false);
  assert.equal(result.edges.find(edge => edge.target.startsWith("https:"))?.resolved, false);
  assert.deepEqual(new Set(result.diagnostics.map(item => item.code)), new Set(["missing-target", "unsupported-target"]));
  assert.deepEqual(knowledgeLinksResolveOutput.parse(result), result);
});

test("pinned revisions compare exactly; floating links follow the snapshot revision", () => {
  const snapshot = {
    pins,
    sources: [
      source(note, "notes", "1", [
        link(skill, "pinned", "pinned", false, "07"),
        link(skill, "floating"),
      ]),
      source(skill, "skills", "7"),
    ],
  };
  const result = resolveKnowledgeLinks(snapshot, {
    starts: [note], snapshotPins: pins, direction: "forward", maxDepth: 1, maxNodes: 5, maxEdges: 5,
  });
  assert.equal(result.edges[0]?.resolved, false);
  assert.equal(result.edges[1]?.resolved, true);
  assert(result.diagnostics.some(item => item.code === "pinned-revision-mismatch"));
});

test("traversal is bounded, pageable, and stable under matching snapshot pins", () => {
  const snapshot = {
    pins,
    sources: [
      source(note, "notes", "1", [link(skill, "supports"), link(paper, "cites")]),
      source(skill, "skills", "2", [link(note, "supports")]),
      source(paper, "research", "3"),
    ],
  };
  const request = {
    starts: [note], snapshotPins: pins, direction: "both", maxDepth: 3,
    maxNodes: 2, maxEdges: 10, pageSize: 1,
  };
  const first = resolveKnowledgeLinks(snapshot, request);
  assert.equal(first.truncated, true);
  assert.equal(first.nodes.length, 1);
  assert.equal(first.edges.length, 1);
  assert.equal(first.nextNodeOffset, 1);
  assert.equal(first.nextEdgeOffset, 1);
  assert(first.diagnostics.some(item => item.code === "truncated"));
  const second = resolveKnowledgeLinks(snapshot, { ...request, nodeOffset: 1, edgeOffset: 1 });
  assert.deepEqual(second.snapshotPins, pins);
  assert.equal(second.totalNodes, first.totalNodes);
  assert.equal(second.totalEdges, first.totalEdges);
});

test("missing and unsupported starts are explicit; stale pins fail closed", () => {
  const snapshot = { pins, sources: [source(note, "notes", "1")] };
  const missing = resolveKnowledgeLinks(snapshot, {
    starts: [absent, "pkm://project/project_demo"], snapshotPins: pins, maxDepth: 0, maxNodes: 2, maxEdges: 2,
  });
  assert.deepEqual(new Set(missing.diagnostics.map(item => item.code)), new Set(["missing-start", "unsupported-start"]));
  assert.throws(() => resolveKnowledgeLinks(snapshot, {
    starts: [note], snapshotPins: { ...pins, notes: "d".repeat(64) },
  }), error => error instanceof LinksSnapshotError && error.code === "SNAPSHOT_MISMATCH");
});

test("invalid link metadata is diagnosed only for reached sources", () => {
  const other = uri("5");
  const snapshot = {
    pins,
    sources: [
      source(note, "notes", "1"),
      source(other, "research", "2", [{ relation: "bad relation", target: uri("6"), mode: "floating", required: false }]),
    ],
  };
  const result = resolveKnowledgeLinks(snapshot, {
    starts: [note], snapshotPins: pins, maxDepth: 0, maxNodes: 2, maxEdges: 2,
  });
  assert.equal(result.diagnostics.length, 0);
});
