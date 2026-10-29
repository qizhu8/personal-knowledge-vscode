const { test } = require("node:test");
const assert = require("node:assert/strict");
const { retrievalJudgmentInput, parseRetrievalJudgments, requireLearningAcknowledgment, knowledgeCandidatePriority } = require("../dist/chat/chat-retrieval-learning");
const { fitChatContext } = require("../dist/chat/chat-context");

const source = (id, content = "Original evidence") => ({
  id, sourceId:id, level:"l1-source", label:id, kind:"note", score:1, content, sourceUri:`pkm://${id}`, selected:false, method:"fixture",
});
const passage = (id, parentId, content, score) => ({...source(id, content), sourceId:parentId, parentId, level:"l2-passage", score});

test("self-evaluation is bounded, query-grounded, complete and explicitly model-attributed", () => {
  const candidates = Array.from({length:8}, (_, index) => source(`source-${index}`, "x".repeat(20000)));
  const input = retrievalJudgmentInput("question".repeat(1000), "answer".repeat(2000), candidates);
  assert.equal(input.sourceIds.length, 8);
  assert(Buffer.byteLength(JSON.stringify(input.messages)) < 20000);
  assert.match(input.messages[0].content, /later explicit user correction supersedes/);
  assert.match(input.messages[0].content, /not verified human truth/);
  const output = JSON.stringify({labels:input.sourceIds.map((_, index) => ({index, relevant:index === 4}))});
  assert.deepEqual(parseRetrievalJudgments(output, input.sourceIds), ["source-4"]);
  for (const invalid of ["not json", '{"labels":[]}', JSON.stringify({labels:input.sourceIds.map(() => ({index:0, relevant:true}))}),
    JSON.stringify({labels:input.sourceIds.map((_, index) => ({index, relevant:"true"}))}), "x".repeat(8001)]) {
    assert.throws(() => parseRetrievalJudgments(invalid, input.sourceIds));
  }
  assert.throws(() => retrievalJudgmentInput("q", "a", []), /one and eight/);
  assert.throws(() => retrievalJudgmentInput("q", "a", [...candidates, source("ninth")]), /one and eight/);
});

test("legacy success-shaped feedback cannot claim that the ranker and calibrator learned", () => {
  for (const value of [undefined, {ok:true}, {ok:true, revision:1, ranker_revision:0, calibrator_revision:1}]) {
    assert.throws(() => requireLearningAcknowledgment(value), /persistent online ranker and calibrator revision/);
  }
});

test("highest-ranked source passages beat later short full sources within the actual 8000-byte reference cap", () => {
  const parent = source("target"); delete parent.content;
  const unrelated = source("unrelated", "unrelated".repeat(800));
  const matching = passage("target-detail", "target", "Sampling 1000 versus 10000; shared labeling. ".repeat(50), 40);
  const more = passage("target-other", "target", "Additional evidence ".repeat(300), 20);
  const candidates = [parent, unrelated, matching, more];
  assert(knowledgeCandidatePriority(matching, candidates) > knowledgeCandidatePriority(unrelated, candidates));
  const required = {role:"user", content:"Compare the target sampling and shared labeling"};
  const automatic = new Map(), messages = [required];
  for (const item of candidates.filter(item => item.content)) {
    const message = {role:"system", content:item.content};
    automatic.set(message, {ids:[item.id], priority:knowledgeCandidatePriority(item, candidates), budget:"knowledge"});
    messages.push(message);
  }
  let receipt;
  const ids = fitChatContext(messages, automatic, 32000, [], {report:value => {receipt=value;}});
  assert(ids.has(matching.id), "target evidence cannot be displaced by a lower-ranked whole note");
  assert(receipt.automaticKnowledge.estimatedAfter <= 8000);
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
