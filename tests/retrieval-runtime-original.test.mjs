import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { retrievalOriginalFunctions, retrievalOriginalMethods } from "../dist/domain/retrieval-runtime-original.js";
import { retrievalSections, retrievalRank } from "../dist/domain/retrieval-runtime.js";

test("captured original Python sectionizer and normalized dot scores equal migrated cosine/maxpool ranking", () => {
  const sources = [
    { id: "b", title: "title", description: "description", body: "preamble\n# one\nnorth\n## two\neast" },
    { id: "a", title: "", description: "", body: "north without heading" },
    { id: "z", title: "zero", description: "", body: "" },
  ];
  const vectors = [[2, 0, 0], [0, 3, 0], [5, 0, 0], [0, 0, 0]];
  const unicodeSources = ["#\u0085NEL\nvalue\n# next\r\nvalue", "\ufeff# not-a-heading\nvalue", "# one\u2028# not-a-heading\nx",
    "prefix\r# not-a-heading\nx", "# \nmultiline\n\n# two\nend", "# one\n\n## two\nx"]
    .map(body => ({ id: "unicode", title: "\u0085 title \ufeff", description: "", body }));
  const script = `from __future__ import annotations
import re,math,json,sys
from typing import Sequence
from types import SimpleNamespace
from collections import defaultdict
_HEADING=re.compile(r"(?m)^#{1,6}\\s+(.+?)\\s*$")
${Object.values(retrievalOriginalFunctions).join("\n\n")}
${["_ordered", "_dense", "search"].map(name => retrievalOriginalMethods["ArchitectureRetriever." + name]).join("\n\n")}
data=json.load(sys.stdin)
sections=[_sections(SimpleNamespace(**source)) for source in data["sources"]]
scores=_scores(_normalize([10,0,0]),[_normalize(vector) for vector in data["vectors"]])
documents=[SimpleNamespace(version=SimpleNamespace(skill_id=source["id"])) for source in data["sources"]]
class Harness:
 _ordered=_ordered
 _dense=_dense
 search=search
 def _get_encoder(self):
  return SimpleNamespace(encode_queries=lambda texts:[_normalize([10,0,0])])
SearchHit=lambda version,score,rank,key:SimpleNamespace(sourceId=version.skill_id,score=score,rank=rank)
harness=Harness()
harness._documents=documents
harness._pca=None
harness._bm25=None
harness.identity=SimpleNamespace(key="synthetic-explicit")
harness.architecture=SimpleNamespace(operators=["dense_encoder"],output_granularity="markdown_section")
harness._units=[(index,text) for index,texts in enumerate(sections) for text in texts]
harness._unit_vectors=[_normalize(vector) for vector in data["vectors"]]
ranked=[vars(hit) for hit in harness.search("synthetic-query",20)]
unicode_sections=[_sections(SimpleNamespace(**source)) for source in data["unicodeSources"]]
print(json.dumps({"sections":sections,"scores":scores,"ranked":ranked,"unicodeSections":unicode_sections}))
`;
  const original = spawnSync("python", ["-c", script], {
    input: JSON.stringify({ sources, vectors, unicodeSources }), encoding: "utf8",
  });
  assert.equal(original.status, 0, original.stderr);
  const result = JSON.parse(original.stdout);
  assert.deepEqual(sources.map(retrievalSections), result.sections);
  assert.deepEqual(unicodeSources.map(retrievalSections), result.unicodeSections);
  const chunks = sources.flatMap((source, sourceIndex) => retrievalSections(source).map((text, ordinal) => ({
    id: `${source.id}:${ordinal}`, sourceId: source.id, ordinal, text,
    vector: vectors[sourceIndex === 0 ? ordinal : sourceIndex + 1],
  })));
  const hits = retrievalRank(chunks, [10, 0, 0]);
  assert.deepEqual(hits.map(({ sourceId, score, rank }) => ({ sourceId, score, rank })), result.ranked);
  assert.deepEqual(hits.map(hit => hit.score), [1, .5, 1 / 3]);
  assert.match(retrievalOriginalMethods["ArchitectureRetriever._dense"], /max\(document_scores\[document_index\], score\)/);
  assert.match(retrievalOriginalMethods["ArchitectureRetriever.search"], /SearchHit\(versions\[skill_id\], 1\.0 \/ rank/);
  assert.match(retrievalOriginalMethods["SentenceTransformerArchitectureEncoder._encode_sentences"], /normalize_embeddings=True/);
});

test("provenance contains repeatable exact original archive/member and captured file hashes", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const provenance = JSON.parse(await readFile(resolve(root, "migration/retrieval-runtime-provenance.json"), "utf8"));
  const hash = value => createHash("sha256").update(value).digest("hex");
  for (const item of provenance.sourceEvidence) {
    assert.equal(item.sourceRoot, resolve(root, ".."));
    assert.equal(hash(await readFile(resolve(item.sourceRoot, item.source))), item.sourceSha256);
  }
  for (const item of provenance.files) {
    assert.equal(item.sourceRoot, resolve(root, ".."));
    assert.equal(item.capturedRoot, root);
    assert.equal(hash(await readFile(resolve(root, item.captured))), item.capturedSha256);
    assert.equal(hash(await readFile(resolve(root, "..", item.source.split("!/")[0]))), item.archiveSha256);
  }
  const item = provenance.files[0];
  const member = spawnSync("python", ["-c",
    "import zipfile,sys;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))",
    resolve(root, "..", item.source.split("!/")[0]), item.source.split("!/")[1]]);
  assert.equal(member.status, 0);
  assert.equal(hash(member.stdout), item.sourceSha256);
});
