import { test } from "node:test";
import assert from "node:assert/strict";
import { retrievalJudgmentInput, parseRetrievalSelection, knowledgeCandidatePriority } from "../dist/domain/skill-routing-prompt.js";

const source = (id, content = "Original evidence") => ({
  id, sourceId:id, level:"l1-source", label:id, kind:"note", score:1, content, sourceUri:`pkm://${id}`, selected:false, method:"fixture",
});

const passage = (id, parentId, content, score) => ({...source(id, content), sourceId:parentId, parentId, level:"l2-passage", score});

test("pre-answer selection is bounded, query-grounded, permits unknown and is explicitly model-attributed", () => {
  const candidates = Array.from({length:8}, (_, index) => source(`source-${index}`, "x".repeat(20000)));
  const input = retrievalJudgmentInput("question".repeat(1000), candidates);
  assert.equal(input.sourceIds.length, 8);
  assert(Buffer.byteLength(JSON.stringify(input.messages)) < 20000);
  assert.match(input.messages[0].content, /later explicit user correction supersedes/i);
  assert.match(input.messages[0].content, /not verified human truth/);
  const output = JSON.stringify({labels:input.sourceIds.map((_, index) => ({index, relevant:index === 4}))});
  assert.deepEqual(parseRetrievalSelection(output, input.sourceIds), { relevant:["source-4"], judged:input.sourceIds });
  assert.equal(JSON.parse(input.messages[1].content).answer, undefined, "selection runs without the answer");
  assert.deepEqual(parseRetrievalSelection('{"labels":[{"index":0,"relevant":null}]}', ["unknown"]),
    { relevant:[], judged:[] });
  for (const invalid of ["not json", '{"labels":[]}', JSON.stringify({labels:input.sourceIds.map(() => ({index:0, relevant:true}))}),
    JSON.stringify({labels:input.sourceIds.map((_, index) => ({index, relevant:"true"}))}), "x".repeat(8001)]) {
    assert.throws(() => parseRetrievalSelection(invalid, input.sourceIds));
  }
  assert.throws(() => retrievalJudgmentInput("q", []), /one and eight/);
  assert.throws(() => retrievalJudgmentInput("q", [...candidates, source("ninth")]), /one and eight/);
});

test("an explicitly named title wins a source-score tie without exceeding Memory priority", () => {
  const unrelated = source("semantic-top", "Distracting evidence");
  unrelated.label = "Cache Reference Performance Report";
  const target = source("named-target"); target.label = "Weekly-Labeling-Overview";
  const candidates = [unrelated, target, passage("named-detail", target.id, "Sampling limits", 40)];
  const query = "根据 Weekly-Labeling-Overview 比较 source-sliced 与 campaign-linked";
  assert(knowledgeCandidatePriority(candidates[2], candidates, query) > knowledgeCandidatePriority(unrelated, candidates, query));
  assert(knowledgeCandidatePriority(candidates[2], candidates, query) < 90);
});
