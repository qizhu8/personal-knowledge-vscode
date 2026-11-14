import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { RetrievalLearning } from "../dist/retrieval-learning.js";
import {
  RETRIEVAL_LEARNING_POLICY, learningCalibrationReady, learningIdentity,
  learningQueryFeatures, learningQueryKey, learningRank, replayLearning,
} from "../dist/domain/retrieval-learning-algorithm.js";
import { retrievalLearningOriginalSources } from "../dist/domain/retrieval-learning-original.js";

const salt = "deterministic-local-learning-fixture";
const scope = { namespace: "private-namespace", workspace: "private-workspace", actor: "private-actor" };
const indexId = "active-index-one";
const model = { id: "local-encoder", revision: "weights-v1", dimensions: 2, architecture: "dense-section" };
let operation = 0;
const operationId = () => `00000000-0000-4000-8000-${String(++operation).padStart(12, "0")}`;

function hits(prefix = "source", count = 10) {
  return Array.from({ length: count }, (_, index) => {
    const sourceId = `${prefix}-${index}`;
    return {
      sourceId,
      sourceRevision: `revision-${index}`,
      sourceSha256: createHash("sha256").update(`body-${index}`).digest("hex"),
      indexId,
      model,
      chunkId: createHash("sha256").update(`chunk-${index}`).digest("hex"),
      text: `private source content ${index}`,
      rank: index + 1,
      score: 1 / (index + 1),
      similarity: 1 - index * 0.01,
    };
  });
}

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(import.meta.dirname, "retrieval-learning-"));
  const filename = join(directory, "state.sqlite");
  let db = new DatabaseSync(filename);
  db.exec("CREATE TABLE retrieval_learning_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
  db.prepare("INSERT INTO retrieval_learning_meta(key,value) VALUES('salt',?)").run(salt);
  const authorization = { allow: true, calls: [] };
  const nativeAuthorize = options.nativeAuthorize ?? ((_scope, action, pins) => {
    authorization.calls.push({ action, pins });
    return authorization.allow;
  });
  let store = new RetrievalLearning(db, { nativeAuthorize });
  const close = () => { if (db) { db.close(); db = undefined; } };
  const reopen = () => {
    close();
    db = new DatabaseSync(filename);
    store = new RetrievalLearning(db, { nativeAuthorize });
    return store;
  };
  t.after(() => {
    close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, filename, authorization, get db() { return db; }, get store() { return store; }, close, reopen };
}

function configure(store) {
  return store.configure({
    scope, indexId, model, operationId: operationId(), expectedRevision: 0, enabled: true,
  });
}

function record(store, options = {}) {
  const query = options.query ?? "synthetic query";
  const candidates = options.hits ?? hits();
  const current = store.getModel({ scope, indexId, model });
  const receipt = store.recordSearch({
    scope, query, indexId, model, hits: candidates,
    expectedRevision: current.revision, operationId: options.operationId ?? operationId(),
  });
  return { receipt, query, hits: candidates };
}

function feedback(store, item, relevantSourceIds, options = {}) {
  const current = store.getModel({ scope, indexId, model });
  return store.feedback({
    scope, indexId, model, retrievalId: item.receipt.retrievalId,
    operationId: options.operationId ?? operationId(), expectedRevision: options.expectedRevision ?? current.revision,
    sourcePins: item.hits.map(({ sourceId, sourceRevision, sourceSha256 }) => ({ sourceId, sourceRevision, sourceSha256 })),
    relevantSourceIds, complete: options.complete ?? true,
    ...(options.provenance ? { provenance: options.provenance } : {}),
    ...(options.judgedSourceIds ? { judgedSourceIds: options.judgedSourceIds } : {}),
  });
}

test("captured Python ranker constants and replay formulas retain exact source behavior", () => {
  assert.match(retrievalLearningOriginalSources.algorithm, /MIN_JUDGED_CALLS = 8/);
  assert.match(retrievalLearningOriginalSources.algorithm, /THRESHOLD_EWMA = 0\.1/);
  assert.match(retrievalLearningOriginalSources.algorithm, /def rebuild\(self, connection, context\):/);
  assert.match(retrievalLearningOriginalSources.tests, /def test_self_labels_train_ranker_calibrator_next_query_and_restart/);
  assert.deepEqual({
    minimumJudgedCalls: RETRIEVAL_LEARNING_POLICY.minimumJudgedCalls,
    baseSlope: RETRIEVAL_LEARNING_POLICY.baseSlope,
    baseBias: RETRIEVAL_LEARNING_POLICY.baseBias,
    minimumGap: RETRIEVAL_LEARNING_POLICY.minimumGap,
    retainProbability: RETRIEVAL_LEARNING_POLICY.retainProbability,
    discardProbability: RETRIEVAL_LEARNING_POLICY.discardProbability,
    thresholdEwma: RETRIEVAL_LEARNING_POLICY.thresholdEwma,
    features: RETRIEVAL_LEARNING_POLICY.features,
    weightBound: RETRIEVAL_LEARNING_POLICY.modelWeightBound,
  }, {
    minimumJudgedCalls: 8, baseSlope: 4, baseBias: -2, minimumGap: 0.15,
    retainProbability: 0.65, discardProbability: 0.35, thresholdEwma: 0.1,
    features: 512, weightBound: 4,
  });

  const originalScores = [1, 0.95, ...Array.from({ length: 8 }, (_, index) => 0.05 - index * 0.001)];
  const candidates = originalScores.map((score, index) => ({
    id: learningIdentity(salt, `source-${index}`), x: score, baseX: score, basePosition: index,
  }));
  const calls = Array.from({ length: 8 }, (_, index) => ({
    callId: index + 1, queryKey: `unqueried-${index}`, candidates, queryFeatures: [],
    relevant: candidates.slice(0, 2).map(candidate => candidate.id), judged: null, provenance: "user",
  }));
  const trained = replayLearning(calls, salt);
  assert.equal(trained.samples, 8);
  assert.equal(trained.safeStreak, 8);
  assert.ok(Math.abs(trained.threshold - 0.48753535013662547) < 1e-14);
  assert.ok(Math.abs(trained.slope - 4.048531264070451) < 1e-14);
  assert.ok(Math.abs(trained.bias - -2.134941141812153) < 1e-14);
  assert.equal(learningCalibrationReady(true, 7, 8), false);
  assert.equal(learningCalibrationReady(true, 8, 7), false);
  assert.equal(learningCalibrationReady(true, 8, 8), true);
  assert.equal(learningRank(candidates, [], trained.weights, salt)[0].id, candidates[0].id);
});

test("query identity uses the captured Python whitespace split semantics", () => {
  const queries = ["  Alpha\u001cBeta  ", "Alpha\ufeffBeta", "\u0085Alpha\u3000 Beta\u001f"];
  const script = `
import importlib.util,json,sys
from pathlib import Path
from types import SimpleNamespace
path=Path(sys.argv[1])
spec=importlib.util.spec_from_file_location("captured_original_learning",path)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
learner=SimpleNamespace(salt=sys.argv[2])
queries=json.load(sys.stdin)
print(json.dumps([module.RetrievalLearning.identity(learner,"query:"+" ".join(query.casefold().split()))
                  for query in queries]))
`;
  const original = spawnSync("python3", ["-c", script,
    join(import.meta.dirname, "../compat/legacy-retrieval-learning-captured.py"), salt], {
    input: JSON.stringify(queries), encoding: "utf8",
  });
  assert.equal(original.status, 0, original.stderr);
  assert.match(retrievalLearningOriginalSources.algorithm,
    /"query:" \+ " "\.join\(query\.casefold\(\)\.split\(\)\)/);
  assert.deepEqual(queries.map(query => learningQueryKey(salt, query)), JSON.parse(original.stdout));
});

test("re-ranking improves the original source-2 fixture and does not regress an unseen top-1 fixture", t => {
  const f = fixture(t);
  configure(f.store);
  let baseline;
  for (let index = 0; index < 12; index++) {
    const item = record(f.store, { query: "same learning query" });
    if (!baseline) baseline = f.store.rerank({
      scope, query: item.query, indexId, model, hits: item.hits,
    });
    const ack = feedback(f.store, item, ["source-2"], { provenance: "model" });
    assert.equal(ack.trained, true);
    assert.equal(ack.provenance, "model");
  }
  const query = "same learning query";
  const beforeRead = f.store.getModel({ scope, indexId, model });
  const improved = f.store.rerank({ scope, query, indexId, model, hits: hits() });
  assert.equal(improved.applied, true);
  assert.equal(improved.hits[0].sourceId, "source-2");
  assert.equal(improved.hits[0].embeddingUpdated, undefined);
  assert.equal(improved.hits[0].score, improved.hits[0].learnedScore);
  const reciprocalRank = (result, relevant) => {
    const found = result.hits.findIndex(hit => relevant.includes(hit.sourceId));
    return found < 0 ? 0 : 1 / (found + 1);
  };
  assert.equal(reciprocalRank(improved, ["source-2"]), 1);
  assert.equal(reciprocalRank(baseline, ["source-2"]), 1 / 3);

  const heldOut = f.store.rerank({ scope, query, indexId, model, hits: hits("held-out", 3) });
  assert.equal(heldOut.hits[0].sourceId, "held-out-0");
  assert.equal(reciprocalRank(heldOut, ["held-out-0"]), 1);
  assert.equal(improved.hits[0].similarity, hits()[2].similarity);
  assert.equal(improved.hits[0].model.architecture, "dense-section");
  assert.equal(beforeRead.revision, f.store.getModel({ scope, indexId, model }).revision);
  assert.equal(beforeRead.samples, f.store.getModel({ scope, indexId, model }).samples);
  assert.equal(beforeRead.embeddingUpdated, false);
});

test("adaptive cutoff retains the original eight-safe-call and probability gates", t => {
  const f = fixture(t);
  configure(f.store);
  const sourceIds = hits( "cut" ).slice(0, 2).map(hit => hit.sourceId);
  for (let index = 0; index < 8; index++) {
    const item = record(f.store, { query: "cutoff query", hits: hits("cut") });
    feedback(f.store, item, sourceIds, { provenance: "model" });
  }
  const afterEight = f.store.getModel({ scope, indexId, model });
  assert.equal(afterEight.samples, 8);
  assert.equal(afterEight.safeStreak, 7, "the baseline largest reciprocal-rank gap is above source-1");
  const item = record(f.store, { query: "cutoff query", hits: hits("cut") });
  feedback(f.store, item, sourceIds, { provenance: "model" });
  const afterNine = f.store.getModel({ scope, indexId, model });
  assert.equal(afterNine.samples, 9);
  assert.equal(afterNine.safeStreak, 8);
  const result = f.store.rerank({ scope, query: "cutoff query", indexId, model, hits: hits("cut") });
  assert.equal(result.reason, "calibrated-score-gap");
  assert.equal(result.cut, 2);
  assert.equal(result.hits.length, 2);
});

test("impressions and reads do not train; default-off setup requires native authorization", t => {
  const f = fixture(t, { nativeAuthorize: undefined });
  const untouched = new RetrievalLearning(f.db);
  assert.throws(() => configure(untouched), error => error.code === "FORBIDDEN");
  const initial = f.store.getModel({ scope, indexId, model });
  const item = record(f.store, { query: "private read query" });
  assert.equal(item.receipt.enabled, false);
  for (let index = 0; index < 3; index++) {
    const result = f.store.rerank({ scope, query: item.query, indexId, model, hits: item.hits });
    assert.equal(result.applied, false);
    assert.deepEqual(result.hits.map(hit => [hit.sourceId, hit.score]), item.hits.map(hit => [hit.sourceId, hit.score]));
  }
  assert.deepEqual(f.store.getModel({ scope, indexId, model }), initial);
  assert.equal(f.db.prepare("SELECT count(*) AS count FROM retrieval_learning_calls").get().count, 1);
  assert.equal(f.db.prepare("SELECT count(*) AS count FROM retrieval_learning_heads").get().count, 1);
  assert.equal(f.db.prepare("SELECT count(*) AS count FROM retrieval_learning_calls WHERE labels_json IS NOT NULL").get().count, 0);
});

test("sensitive feedback training is denied without the injected native authorizer", t => {
  const f = fixture(t);
  configure(f.store);
  const item = record(f.store);
  const noAuthorizer = new RetrievalLearning(f.db);
  const before = f.store.getModel({ scope, indexId, model });
  assert.throws(() => noAuthorizer.feedback({
    scope, indexId, model, retrievalId: item.receipt.retrievalId, operationId: operationId(),
    expectedRevision: before.revision,
    sourcePins: item.hits.map(({ sourceId, sourceRevision, sourceSha256 }) => ({ sourceId, sourceRevision, sourceSha256 })),
    relevantSourceIds: ["source-2"], complete: true,
  }), error => error.code === "FORBIDDEN");
  assert.equal(f.store.getModel({ scope, indexId, model }).revision, before.revision);
});

test("partial labels, bad pins, stale CAS and operation reuse are rejected without publishing", t => {
  const f = fixture(t);
  configure(f.store);
  const item = record(f.store);
  const baseline = f.store.getModel({ scope, indexId, model });
  assert.throws(() => feedback(f.store, item, ["source-1"], {
    complete: false, provenance: "model", judgedSourceIds: ["not-in-result"],
  }), error => error.code === "INVALID_ARGUMENT");
  assert.throws(() => feedback(f.store, item, ["source-1"], {
    provenance: "model", expectedRevision: baseline.revision - 1,
  }), error => error.code === "CONFLICT");
  const wrongPin = item.hits.map(({ sourceId, sourceRevision, sourceSha256 }) => ({ sourceId, sourceRevision, sourceSha256 }));
  wrongPin[0].sourceRevision = "tampered-revision";
  assert.throws(() => f.store.feedback({
    scope, indexId, model, retrievalId: item.receipt.retrievalId,
    operationId: operationId(), expectedRevision: baseline.revision, sourcePins: wrongPin,
    relevantSourceIds: ["source-1"], complete: true,
  }), error => error.code === "CONFLICT");

  const opId = operationId();
  const ack = feedback(f.store, item, ["source-1"], { operationId: opId });
  assert.equal(ack.trained, true);
  assert.deepEqual(feedback(f.store, item, ["source-1"], {
    operationId: opId, expectedRevision: baseline.revision,
  }), ack, "a stable operationId returns its original result after the model advances");
  assert.throws(() => feedback(f.store, item, ["source-2"], { operationId: opId }),
    error => error.code === "CONFLICT");
  assert.throws(() => feedback(f.store, item, ["source-2"], { expectedRevision: baseline.revision }),
    error => error.code === "CONFLICT");
  assert.equal(f.store.getModel({ scope, indexId, model }).revision, baseline.revision + 1);
});

test("tampered persisted source pins fail integrity validation and roll back training", t => {
  const f = fixture(t);
  configure(f.store);
  const item = record(f.store);
  const row = f.db.prepare("SELECT call_id,candidates_json FROM retrieval_learning_calls WHERE receipt_id=?")
    .get(item.receipt.retrievalId);
  const candidates = JSON.parse(row.candidates_json);
  candidates[0].sourceSha256 = "f".repeat(64);
  f.db.prepare("UPDATE retrieval_learning_calls SET candidates_json=? WHERE call_id=?")
    .run(JSON.stringify(candidates), row.call_id);
  const before = f.store.getModel({ scope, indexId, model });
  assert.throws(() => feedback(f.store, item, ["source-0"]), error => error.code === "INTEGRITY");
  assert.equal(f.store.getModel({ scope, indexId, model }).revision, before.revision);
  assert.equal(f.db.prepare("SELECT labels_json FROM retrieval_learning_calls WHERE call_id=?").get(row.call_id).labels_json, null);
});

test("native authorization failure rolls back labels and model publication atomically", t => {
  const f = fixture(t);
  configure(f.store);
  const item = record(f.store);
  const before = f.store.getModel({ scope, indexId, model });
  f.authorization.allow = false;
  const opId = operationId();
  assert.throws(() => feedback(f.store, item, ["source-2"], { operationId: opId }),
    error => error.code === "FORBIDDEN");
  assert.equal(f.store.getModel({ scope, indexId, model }).revision, before.revision);
  assert.equal(f.db.prepare("SELECT labels_json FROM retrieval_learning_calls WHERE receipt_id=?")
    .get(item.receipt.retrievalId).labels_json, null);
  f.authorization.allow = true;
  const retried = feedback(f.store, item, ["source-2"], { operationId: opId });
  assert.equal(retried.trained, true);
  assert.equal(f.store.getModel({ scope, indexId, model }).revision, before.revision + 1);
});

test("user corrections supersede model labels across same-query receipts", t => {
  const f = fixture(t);
  configure(f.store);
  const first = record(f.store, { query: "authority query" });
  feedback(f.store, first, ["source-2"], { provenance: "model" });
  const second = record(f.store, { query: "authority query" });
  const user = feedback(f.store, second, ["source-0"]);
  assert.equal(user.userLabels, 1);
  assert.equal(user.modelLabels, 0);
  assert.equal(user.superseded, true);
  const old = feedback(f.store, first, ["source-2"], { provenance: "model" });
  assert.equal(old.ignored, true);
  assert.equal(old.reason, "user-precedence");
  assert.equal(f.store.getModel({ scope, indexId, model }).userLabels, 1);
  assert.equal(f.store.getModel({ scope, indexId, model }).modelLabels, 0);
});

test("namespace, actor, query, source and text remain private across durable reopen", t => {
  const f = fixture(t);
  configure(f.store);
  const privateQuery = "private query sentinel";
  const privateId = "private-source-sentinel";
  const input = hits("private-source");
  input[0].sourceId = privateId;
  const item = record(f.store, { query: privateQuery, hits: input });
  feedback(f.store, item, [privateId], { provenance: "model" });
  const before = f.store.getModel({ scope, indexId, model });
  f.reopen();
  assert.deepEqual(f.store.getModel({ scope, indexId, model }), before);
  const bytes = readFileSync(f.filename);
  for (const secret of [
    privateQuery, privateId, "private source content", scope.namespace, scope.workspace, scope.actor,
  ]) assert.equal(bytes.includes(Buffer.from(secret)), false, `SQLite persisted ${secret}`);
  assert.equal(f.store.getModel({ scope: { ...scope, actor: "other-actor" }, indexId, model }).samples, 0);
  assert.equal(f.store.getModel({ scope, indexId, model }).embeddingUpdated, false);
});
