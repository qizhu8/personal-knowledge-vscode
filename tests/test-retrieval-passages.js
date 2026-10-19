const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { ruleSourcePassages, refineRuleCandidates, passageReferenceGroup } = require("../dist/retrieval/retrieval-passages");
const { sanitizeRetrievalCandidatesV1 } = require("../dist/retrieval/retrieval-contracts");
const { chatRetrievalReceipt, validChatRetrievalReceipt } = require("../dist/chat/chat-retrieval");
const sha = text => createHash("sha256").update(text).digest("hex");
const parent = {
  id:"source", sourceId:"pkm://notes/source", sourceRevision:"r1", contentHash:"a".repeat(64),
  kind:"note", label:"Source", sourceUri:"pkm://notes/source", method:"lexical:l1",
  score:1, selected:false, reason:"L1 candidate", level:"l1-source"
};

test("rule L2 locates tail evidence past 4,000 characters with exact stable UTF-16/CRLF/BOM ranges", () => {
  const body = "\uFEFF# Experiment \ud83d\udc26\r\n\r\nConditions: CPU-only; NOT approved.\r\n\r\n## Background\r\n\r\n" + "Unrelated material.\r\n\r\n".repeat(300) +
    "## Acceptance\r\n\r\nDo not deploy: maximum latency is 125 ms, not 250 ms.\r\n";
  const first = ruleSourcePassages(parent, body, "latency deploy");
  assert.deepEqual(first, ruleSourcePassages(parent, body, "latency deploy"));
  const evidence = first.candidates.find(item => item.content.includes("125 ms"));
  assert(evidence.range.start > 4000);
  assert.equal(evidence.content, body.slice(evidence.range.start, evidence.range.end));
  assert.equal(evidence.parentId, parent.id);
  assert.equal(evidence.parentRevision, "r1");
  assert.equal(evidence.parentContentHash, parent.contentHash);
  assert.equal(evidence.offsetEncoding, "utf16");
  assert.equal(evidence.contentHash, sha(evidence.content));
  assert(passageReferenceGroup(evidence, first.candidates).some(item => item.content.includes("Conditions: CPU-only; NOT approved.")));
  assert.deepEqual(Object.keys(evidence.range).sort(), ["end", "start", "unit"]);
  for (const candidate of first.candidates) {
    assert.equal(candidate.content, body.slice(candidate.range.start, candidate.range.end));
    assert.match(candidate.method, /^rule:/);
  }
  assert.equal(sanitizeRetrievalCandidatesV1(first.candidates).incomplete, false);
  const changed = ruleSourcePassages({ ...parent, sourceRevision:"r2" }, body, "latency deploy");
  assert.notEqual(changed.candidates[0].id, first.candidates[0].id);
});

test("large Markdown sections retain heading dependencies, whole fenced examples and table conditions", () => {
  const body = "# Safety\n\n" + "Background paragraph.\n\n".repeat(250) +
    "```text\n# Not a heading\n\nlatency must not exceed 125 ms\n```\n\n" +
    "| Configuration | Limit |\n| --- | --- |\n| latency target | 125 ms |\n";
  const result = ruleSourcePassages(parent, body, "latency");
  const code = result.candidates.find(item => item.content.includes("```text"));
  assert(code.content.includes("```\n") && code.content.includes("# Not a heading"));
  const group = passageReferenceGroup(code, result.candidates);
  assert.equal(group[0].content, "# Safety\n");
  assert.equal(group.at(-1), code);
  const table = result.candidates.find(item => item.content.includes("| latency target"));
  assert.match(table.content, /\| Configuration \| Limit \|/);
  assert.match(table.content, /\| --- \| --- \|/);
  const stale = result.candidates.map(item => item.id === code.contextIds[0] ? { ...item, parentRevision:"other" } : item);
  assert.throws(() => passageReferenceGroup(code, stale), /different source revision/);
  assert.throws(() => passageReferenceGroup(code, [code]), /missing/);
});

test("oversized atomic structures and unavailable provenance are explicit, never silently truncated", () => {
  const body = '{"code":"latency", "data":"' + "x".repeat(5000) + '"}';
  const result = refineRuleCandidates([{ ...parent, content:body }], "latency");
  assert(result.warnings.length);
  assert(result.candidates.every(item => !item.content));
  const unversioned = refineRuleCandidates([{ ...parent, sourceRevision:undefined, content:body }], "latency");
  assert.match(unversioned.candidates[0].reason, /immutable provenance/);
  const privateSource = refineRuleCandidates([{ ...parent, content:undefined, reason:"Source unavailable" }], "latency");
  assert.equal(privateSource.candidates.length, 1);
  assert.equal(privateSource.candidates[0].content, undefined);
});

test("receipts retain selected passage identities, heading dependencies and actual serving provenance", () => {
  const body = "# Experiment\n\n" + "Background.\n\n".repeat(500) + "latency must not exceed 125 ms.\n";
  const result = refineRuleCandidates([{ ...parent, content:body }], "latency");
  const passage = result.candidates.find(item => item.content?.includes("125 ms"));
  const group = passageReferenceGroup(passage, result.candidates);
  const selected = new Set(group.map(item => item.id));
  const candidates = result.candidates.map(item => ({ ...item, selected:selected.has(item.id) }));
  const receipt = chatRetrievalReceipt({ id:"chat", messages:[], includeHistory:false }, "latency", "fixture", candidates, selected);
  assert.equal(receipt.selectedCount, group.length);
  assert(validChatRetrievalReceipt(receipt, "chat"));
  const evidence = receipt.candidates.find(item => item.id === passage.id);
  assert.equal(evidence.parentContentHash, parent.contentHash);
  assert.equal(evidence.serving.providerId, "pkm-rule-passages");
  assert.deepEqual(evidence.contextIds, passage.contextIds);
  assert(!JSON.stringify(receipt).includes("latency must not exceed 125 ms"));
});

test("CTX-M06: JSON refinement preserves whole entities plus shared conditions before and after the array", () => {
  const records = Array.from({ length:80 }, (_, index) => ({
    entity:index === 72 ? "docker-beta" : `unrelated-${index}`,
    metric:"latency", value:index === 72 ? 125 : 250, unit:"ms",
    note:'Literal commas, colon: escaped "quotes" and braces { }',
  }));
  const body = JSON.stringify({ hardware:"CPU-only", records, conditions:{ concurrency:32, version:"v2", approved:false } }, null, 2);
  const result = refineRuleCandidates([{ ...parent, content:body }], "docker-beta");
  const evidence = result.candidates.find(item => item.content?.includes('"docker-beta"'));
  assert(evidence);
  const entity = JSON.parse(evidence.content);
  assert.equal(entity.metric, "latency");
  assert.equal(entity.value, 125);
  assert.equal(entity.unit, "ms");
  assert.equal(entity.note, records[72].note);
  const group = passageReferenceGroup(evidence, result.candidates);
  assert(group.some(item => item.content.includes('"CPU-only"')));
  assert(group.some(item => item.content.includes('"concurrency": 32') && item.content.includes('"approved": false')));
  assert(group.some(item => item.content.includes('"records"')));
  for (const item of group) assert.equal(item.content, body.slice(item.range.start, item.range.end));
  assert.equal(sanitizeRetrievalCandidatesV1(result.candidates).incomplete, false);
});

test("CTX-M08/M10: invalid structured text is explicitly unavailable; fresh JSON spans are stable original ranges", () => {
  const invalid = ruleSourcePassages(parent, '{"records":[invalid latency}', "latency", "json");
  assert.equal(invalid.candidates.length, 0);
  assert.match(invalid.warning, /invalid JSON.*No text was rewritten.*no LLM fallback/);
  const body = '\uFEFF\r\n[{"entity":"beta","value":125,"unit":"ms"}, {"entity":"other"}]\r\n';
  // A BOM is outside JSON syntax, but must remain part of original range offsets.
  const first = ruleSourcePassages(parent, body, "beta", "json");
  assert.deepEqual(first, ruleSourcePassages(parent, body, "beta", "json"));
  assert.equal(first.candidates[0].content, '{"entity":"beta","value":125,"unit":"ms"}');
  assert.equal(first.candidates[0].content, body.slice(first.candidates[0].range.start, first.candidates[0].range.end));
});

test("CTX-M06/M10: large tables retain exact entity rows, header units, ancestor prose and sibling shared conditions", () => {
  const body = "\uFEFF# Benchmark\r\n\r\nOnly negative approval; CPU-only.\r\n\r\n" +
    "## Conditions\r\n\r\nConcurrency=32, version=v2; never deploy.\r\n\r\n## Results\r\n\r\n" +
    "| Entity | Latency (ms) | QPS (requests/s) |\r\n| --- | --- | --- |\r\n" +
    Array.from({ length:180 }, (_, index) => `| ${index === 172 ? "docker-beta" : `other-${index}`} | 125 | 1250 |\r\n`).join("");
  const first = ruleSourcePassages(parent, body, "docker-beta latency");
  const evidence = first.candidates.find(item => item.content.includes("| docker-beta"));
  assert(evidence);
  assert.equal(evidence.content, "| docker-beta | 125 | 1250 |\r\n");
  const group = passageReferenceGroup(evidence, first.candidates);
  assert(group.some(item => item.content.includes("Latency (ms)") && item.content.includes("requests/s")));
  assert(group.some(item => item.content.includes("Concurrency=32, version=v2; never deploy.")));
  assert(group.some(item => item.content.includes("Only negative approval; CPU-only.")));
  for (const item of group) {
    assert.equal(item.content, body.slice(item.range.start, item.range.end));
    assert.equal(item.contentHash, sha(item.content));
    assert.equal(item.parentId, parent.id);
  }
  assert.deepEqual(first, ruleSourcePassages(parent, body, "docker-beta latency"));
  const changed = ruleSourcePassages({ ...parent, sourceRevision:"new-revision" }, body, "docker-beta latency");
  assert.notEqual(changed.candidates.find(item => item.content === evidence.content).id, evidence.id);
});

test("CTX-M06: oversized shared conditions refuse dependent evidence rather than inject an unqualified metric", () => {
  const body = "# Benchmark\n\n" + "Required configuration conditions. ".repeat(160) +
    "\n\n## Results\n\n| Entity | Latency |\n| --- | --- |\n| docker-beta | 125 ms |\n";
  const result = ruleSourcePassages(parent, body, "docker-beta");
  assert.equal(result.candidates.length, 0);
  assert.match(result.warning, /not truncated/);
});

test("RST tail passages preserve overline hierarchy, sibling conditions and exact original CRLF ranges", () => {
  const body = "\uFEFF==========\r\nExperiment\r\n==========\r\n\r\nCPU-only; never production.\r\n\r\n" +
    "Conditions\r\n----------\r\n\r\nConcurrency=32; latency in ms; NOT approved.\r\n\r\n" +
    "Background\r\n----------\r\n\r\n" + "Unrelated explanation.\r\n".repeat(240) +
    "\r\nResults\r\n-------\r\n\r\ndocker-beta latency must not exceed 125 ms.\r\n";
  const rstParent = { ...parent, sourceUri:"pkm://notes/experiment.rst", label:"experiment.rst" };
  const result = refineRuleCandidates([{ ...rstParent, content:body }], "docker-beta");
  const evidence = result.candidates.find(item => item.content?.includes("docker-beta"));
  assert(evidence && evidence.range.start > 4000);
  const group = passageReferenceGroup(evidence, result.candidates);
  assert(group.some(item => item.content.includes("CPU-only; never production.")));
  assert(group.some(item => item.content.includes("Concurrency=32; latency in ms; NOT approved.")));
  assert(group.some(item => item.content.includes("==========\r\nExperiment\r\n==========")));
  for (const item of group) {
    assert.equal(item.content, body.slice(item.range.start, item.range.end));
    assert.equal(item.contentHash, sha(item.content));
    assert.equal(item.offsetEncoding, "utf16");
  }
  assert.equal(sanitizeRetrievalCandidatesV1(result.candidates).incomplete, false);
  assert.deepEqual(result, refineRuleCandidates([{ ...rstParent, content:body }], "docker-beta"));
});

test("RST literal/directive bodies and grid tables stay whole; indented adornments are not headings", () => {
  const body = "Examples\n========\n\n" +
    "Background\n----------\n\n" + "Unrelated.\n".repeat(450) +
    "\nEvidence\n--------\n\n.. code-block:: text\n\n" +
    "   fake heading\n   ------------\n\n   latency limit is NOT 250 ms.\n\n" +
    "+----------+----------+\n| Entity   | Limit ms |\n+==========+==========+\n| beta     | 125      |\n+----------+----------+\n";
  const result = ruleSourcePassages(parent, body, "latency beta", "rst");
  const evidence = result.candidates.find(item => item.content.includes("latency limit"));
  assert(evidence);
  assert(evidence.content.includes(".. code-block:: text\n\n   fake heading"));
  assert(evidence.content.includes("| beta     | 125"));
  assert.equal(evidence.content, body.slice(evidence.range.start, evidence.range.end));
});

test("RST oversized sections or required shared conditions are refused, not paragraph-sliced", () => {
  const literal = "Example\n=======\n\n.. code-block:: text\n\n   latency\n\n" + "   still same literal\n".repeat(250);
  const result = ruleSourcePassages(parent, literal, "latency", "rst");
  assert.equal(result.candidates.length, 0);
  assert.match(result.warning, /not truncated/);
  const conditions = "Benchmark\n=========\n\nConditions\n----------\n\n" + "Required conditions. ".repeat(250)
    + "\n\nResults\n-------\n\nbeta latency 125 ms.\n";
  const dependent = ruleSourcePassages(parent, conditions, "beta", "rst");
  assert.equal(dependent.candidates.length, 0);
  assert.match(dependent.warning, /not truncated/);
});

test("RST overlined shared conditions and document preambles remain required context", () => {
  const body = ":scope: CPU-only; no production approval.\n\n" +
    "==========\nConditions\n==========\n\nAll timings are milliseconds, concurrency=32.\n\n" +
    "==========\nBackground\n==========\n\n" + "Unrelated.\n".repeat(500) +
    "\n=======\nResults\n=======\n\nbeta latency 125.\n";
  const result = ruleSourcePassages(parent, body, "beta", "rst");
  const evidence = result.candidates.find(item => item.content.includes("beta latency"));
  const group = passageReferenceGroup(evidence, result.candidates);
  assert(group.some(item => item.content.includes(":scope: CPU-only")));
  assert(group.some(item => item.content.includes("All timings are milliseconds, concurrency=32.")));
});

test("RST unresolved includes, substitutions and cross-document references explicitly refuse refinement", () => {
  for (const dependency of [".. include:: private.rst", ".. raw:: html", ".. |limit| replace:: 125 ms", "See :doc:`conditions`."]) {
    const result = ruleSourcePassages(parent, `Results\n=======\n\nbeta latency\n\n${dependency}\n`, "beta", "rst");
    assert.deepEqual(result.candidates, []);
    assert.match(result.warning, /unresolved context.*No directive was executed/);
  }
});
