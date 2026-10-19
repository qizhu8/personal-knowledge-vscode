const { test } = require("node:test");
const assert = require("node:assert/strict");
const { RetrievalWorkerManager } = require("../dist/retrieval/retrieval-worker");
const { validRetrievalServingIdentity, compileRetrievalResultV1 } = require("../dist/retrieval/retrieval-contracts");
const { chatRetrievalReceipt, validChatRetrievalReceipt } = require("../dist/chat/chat-retrieval");
const { refineRuleCandidates } = require("../dist/retrieval/retrieval-passages");
const { randomUUID } = require("node:crypto");

async function queryWorker(serving, solution, routes = ["bm25"]) {
  const manager = new RetrievalWorkerManager("/unused-fixture", "/unused-worker", "/unused-python", "requested-version");
  manager.status = async () => ({ ready_generation:1, engine_version:"actual-engine-version" });
  manager.ensure = async () => ({});
  manager.request = async () => ({
    ok:true, request_id:"serving-fixture", ready_generation:1, corpus_revision:"revision", route:"lexical",
    solution, skill_serving:serving,
    hits:[{ rank:1, score:3, source_id:"pkm://fixture/source", source_revision:"r1",
      content_hash:"a".repeat(64), content_type:"note", source_uri:"pkm://fixture/source",
      title:"Original evidence", description:"", metadata:{}, provenance:{}, contributing_routes:routes }],
  });
  return manager.query({ schema:"pkm.retrieval.query/v1", requestId:"serving-fixture", text:"Evidence",
    route:"lexical", topK:5, scope:{ capabilityId:"test" }, generation:{ mode:"latest-ready" }, diagnostics:"summary" });
}

test("CTX-M15: worker normalization records actual contributing routes, served package/release and engine version", async () => {
  const result = await queryWorker({ used:true, release_id:"served-release", fallback_reason:null },
    { package_id:"served-package", reason:"served" }, ["imported-dense", "bm25", "imported-dense"]);
  const identity = result.hits[0].serving;
  assert.deepEqual(identity, { providerId:"pkm.unified-retrieval", providerVersion:"actual-engine-version",
    route:"imported-dense+bm25", scoreSemantics:"engine-defined", packageId:"served-package", releaseId:"served-release" });
  assert.equal(result.route, "lexical", "Requested route remains distinct from actual serving");
  assert(validRetrievalServingIdentity(identity));
  assert(compileRetrievalResultV1(result).ok);
});

test("fallback does not label the requested model/package as served, and invalid serving metadata is explicit", async () => {
  const result = await queryWorker({ used:false, release_id:"not-served", fallback_reason:"Model unavailable; exact fallback" },
    { package_id:"not-served", reason:"unavailable" }, ["exact", "bm25"]);
  assert.equal(result.hits[0].serving.route, "exact+bm25");
  assert.equal(result.hits[0].serving.fallback, "Model unavailable; exact fallback");
  assert.equal(result.hits[0].serving.packageId, undefined);
  assert.equal(result.hits[0].serving.releaseId, undefined);
  const scoped = await queryWorker({ used:false }, { package_id:null, reason:"scope" });
  assert.equal(scoped.hits[0].serving.fallback, "scope");
  await assert.rejects(queryWorker({}, {}), /did not report/);
  await assert.rejects(queryWorker({ used:true }, {}, [42]), /contributing routes/);
  assert.equal(compileRetrievalResultV1({ ...result, hits:[{ ...result.hits[0], serving:{ ...result.hits[0].serving, releaseId:42 } }] }).ok, false);
});

test("actual L1 serving remains in persisted Chat receipts while rule L2 reports its own provider", async () => {
  const result = await queryWorker({ used:true, release_id:"served-release" }, { package_id:"served-package", reason:"served" }, ["imported-dense"]);
  const hit = result.hits[0];
  const source = { id:hit.sourceId, sourceId:hit.sourceId, sourceUri:hit.sourceUri, sourceRevision:hit.sourceRevision,
    contentHash:hit.contentHash, kind:hit.contentType, label:hit.title, score:hit.score, selected:true,
    reason:"fixture", level:"l1-source", serving:hit.serving, method:`${hit.serving.route}:unified-retrieval`,
    content:"# Measurements\n\n" + "Background.\n\n".repeat(500) + "latency must not exceed 125 ms.\n" };
  const refined = refineRuleCandidates([source], "latency");
  const child = refined.candidates.find(candidate => candidate.level === "l2-passage");
  assert(child);
  assert.notEqual(child.serving.providerId, source.serving.providerId);
  const chat = { id:randomUUID(), includeHistory:false, messages:[] };
  const receipt = JSON.parse(JSON.stringify(chatRetrievalReceipt(chat, "latency", "model", refined.candidates)));
  assert(validChatRetrievalReceipt(receipt, chat.id));
  assert.deepEqual(receipt.candidates.find(candidate => candidate.id === source.id).serving, source.serving);
  assert.deepEqual(receipt.candidates.find(candidate => candidate.id === child.id).serving, child.serving);
});
