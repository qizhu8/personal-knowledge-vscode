import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  RETRIEVAL_LEARNING_POLICY as P, learningCalibrationReady, learningGap, learningIdentity,
  learningProbability, learningQueryFeatures, learningQueryKey,
  learningRank, replayLearning,
  type LearningCandidate, type LearningFeedbackCall, type LearningReplay,
} from "./domain/retrieval-learning-algorithm.js";
import {
  RetrievalLearningError, retrievalLearningAssert, retrievalLearningModel, retrievalLearningPins,
  retrievalLearningScope,
  type RetrievalLearningHit, type RetrievalLearningModelPin, type RetrievalLearningScope,
  type RetrievalLearningSourcePin,
} from "./domain/retrieval-learning-contracts.js";

export {
  RETRIEVAL_LEARNING_POLICY,
  type LearningCandidate,
  type LearningFeedbackCall,
  type LearningReplay,
} from "./domain/retrieval-learning-algorithm.js";
export {
  RetrievalLearningError,
  type RetrievalLearningHit,
  type RetrievalLearningModelPin,
  type RetrievalLearningScope,
  type RetrievalLearningSourcePin,
} from "./domain/retrieval-learning-contracts.js";

export interface RetrievalLearningAuthorizationPin extends RetrievalLearningSourcePin {}
export type RetrievalLearningAuthorization = (
  scope: Readonly<RetrievalLearningScope>,
  action: "configure" | "train",
  pins: readonly Readonly<RetrievalLearningAuthorizationPin>[],
) => boolean;

export interface RetrievalLearningOptions {
  /** Must be backed by the host's native authorization boundary; absent means learning is denied. */
  nativeAuthorize?: RetrievalLearningAuthorization;
}

export interface RetrievalLearningModel {
  revision: number;
  enabled: boolean;
  baseline: { slope: number; bias: number };
  current: { slope: number; bias: number };
  threshold: number;
  weights: number[];
  samples: number;
  safeStreak: number;
  modelLabels: number;
  userLabels: number;
  calibrationReady: boolean;
  prequential: { evaluatedCalls: number; brier: number | null; logLoss: number | null };
  rankerRevision: number;
  calibratorRevision: number;
  embeddingUpdated: false;
}

export interface RetrievalLearningRerankRequest {
  scope: RetrievalLearningScope;
  query: string;
  indexId: string;
  model: RetrievalLearningModelPin;
  hits: readonly RetrievalLearningHit[];
}

export interface RetrievalLearningRerankedHit extends RetrievalLearningHit {
  baseScore?: number;
  learnedScore?: number;
  baseScoreSemantics?: "reciprocal-rank";
  scoreSemantics?: "engine-defined";
  learningRevision?: number;
}

export interface RetrievalLearningRecordRequest extends RetrievalLearningRerankRequest {
  operationId: string;
  expectedRevision: number;
}

export interface RetrievalLearningReceipt {
  retrievalId: string;
  revision: number;
  enabled: boolean;
}

export interface RetrievalLearningFeedbackRequest {
  scope: RetrievalLearningScope;
  indexId: string;
  model: RetrievalLearningModelPin;
  retrievalId: string;
  operationId: string;
  expectedRevision: number;
  sourcePins: readonly RetrievalLearningSourcePin[];
  relevantSourceIds: readonly string[];
  complete: boolean;
  provenance?: "user" | "model" | "self";
  judgedSourceIds?: readonly string[];
}

export interface RetrievalLearningAcknowledgment {
  ok: true;
  trained: boolean;
  duplicate: boolean;
  ignored: boolean;
  superseded: boolean;
  reason?: "duplicate" | "user-precedence";
  recall: number | null;
  version: number;
  provenance: "user" | "model";
  revision: number;
  rankerRevision: number;
  calibratorRevision: number;
  modelLabels: number;
  userLabels: number;
  state: "disabled" | "collecting-feedback" | "ready";
  calibrationReady: boolean;
  judgedCalls: number;
  safeStreak: number;
}

interface StoredCandidate extends LearningCandidate {
  sourceRevision: string;
  sourceSha256: string;
}

interface StoredModel {
  slope: number;
  bias: number;
  threshold: number;
  weights: number[];
  samples: number;
  safeStreak: number;
  modelLabels: number;
  userLabels: number;
  prequential: RetrievalLearningModel["prequential"];
}

interface StoredHead {
  revision: number;
  enabled: number;
  payload_json: string;
  digest: string;
}

interface StoredCall {
  call_id: number;
  receipt_id: string;
  query_key: string;
  query_features_json: string;
  candidates_json: string;
  pin_digest: string;
  candidate_digest: string;
  labels_json: string | null;
  judged_json: string | null;
  provenance: "user" | "model" | null;
  label_digest: string | null;
  recall: number | null;
  version: number;
}

interface StoredAuthority {
  call_id: number;
  query_key: string;
  query_features_json: string;
  candidates_json: string;
  labels_json: string;
  pin_digest: string;
}

interface StoredOperation {
  context_key: string;
  payload_digest: string;
  result_json: string;
}

const BASE_MODEL: StoredModel = {
  slope: P.baseSlope,
  bias: P.baseBias,
  threshold: P.minimumGap,
  weights: Array<number>(P.features).fill(0),
  samples: 0,
  safeStreak: 0,
  modelLabels: 0,
  userLabels: 0,
  prequential: { evaluatedCalls: 0, brier: null, logLoss: null },
};

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function safeNumber(value: unknown, min: number, max: number, label: string): number {
  retrievalLearningAssert(typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max,
    "INVALID_ARGUMENT", `Invalid ${label}.`);
  return value;
}

function safeText(value: unknown, maxBytes: number, label: string): string {
  retrievalLearningAssert(typeof value === "string" && value.trim().length > 0
    && !value.includes("\0") && Buffer.byteLength(value) <= maxBytes
    && /^(?:[\u0000-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/.test(value),
  "INVALID_ARGUMENT", `Invalid ${label}.`);
  return value;
}

function validateOperationId(value: unknown): string {
  retrievalLearningAssert(typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  "INVALID_ARGUMENT", "Stable UUID operationId required.");
  return value.toLowerCase();
}

function validateRevision(value: unknown): number {
  return safeNumber(value, 0, Number.MAX_SAFE_INTEGER, "expectedRevision");
}

function baselineSnapshot(): StoredModel {
  return { ...BASE_MODEL, weights: [...BASE_MODEL.weights], prequential: { ...BASE_MODEL.prequential } };
}

function serializeModel(value: StoredModel): string {
  return stableJson({
    slope: value.slope, bias: value.bias, threshold: value.threshold,
    weights: value.weights, samples: value.samples, safeStreak: value.safeStreak,
    modelLabels: value.modelLabels, userLabels: value.userLabels, prequential: value.prequential,
  });
}

function parseModel(value: string): StoredModel {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new RetrievalLearningError("INTEGRITY", "Corrupt retrieval-learning model."); }
  retrievalLearningAssert(!!parsed && typeof parsed === "object", "INTEGRITY", "Corrupt retrieval-learning model.");
  const model = parsed as StoredModel;
  retrievalLearningAssert(Number.isFinite(model.slope) && model.slope >= 0.1 && model.slope <= 16
    && Number.isFinite(model.bias) && model.bias >= -12 && model.bias <= 12
    && Number.isFinite(model.threshold) && model.threshold >= P.minimumGap && model.threshold <= 0.95
    && Array.isArray(model.weights) && model.weights.length === P.features
    && model.weights.every(weight => Number.isFinite(weight) && Math.abs(weight) <= P.modelWeightBound)
    && [model.samples, model.safeStreak, model.modelLabels, model.userLabels].every(number =>
      Number.isSafeInteger(number) && number >= 0)
    && model.prequential && Number.isSafeInteger(model.prequential.evaluatedCalls)
    && model.prequential.evaluatedCalls >= 0
    && (model.prequential.brier === null || Number.isFinite(model.prequential.brier) && model.prequential.brier >= 0)
    && (model.prequential.logLoss === null || Number.isFinite(model.prequential.logLoss) && model.prequential.logLoss >= 0),
  "INTEGRITY", "Retrieval-learning model violates its pinned bounds.");
  return model;
}

function safeParseArray<T>(serialized: string, label: string): T[] {
  try {
    const value: unknown = JSON.parse(serialized);
    retrievalLearningAssert(Array.isArray(value), "INTEGRITY", `Corrupt retrieval-learning ${label}.`);
    return value as T[];
  } catch (error) {
    if (error instanceof RetrievalLearningError) throw error;
    throw new RetrievalLearningError("INTEGRITY", `Corrupt retrieval-learning ${label}.`);
  }
}

function pinProjection(pins: readonly RetrievalLearningSourcePin[]): RetrievalLearningSourcePin[] {
  return pins.map(pin => ({ ...pin })).sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
}

/** Durable feedback/re-ranking state. Reads score only; training occurs only in feedback(). */
export class RetrievalLearning {
  private readonly salt: string;

  constructor(private readonly db: DatabaseSync, private readonly options: RetrievalLearningOptions = {}) {
    retrievalLearningAssert(db && typeof db.exec === "function" && typeof db.prepare === "function",
      "INVALID_ARGUMENT", "Caller-owned DatabaseSync required.");
    db.exec(`
      CREATE TABLE IF NOT EXISTS retrieval_learning_meta (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS retrieval_learning_heads (
        context_key TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision >= 0),
        enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), payload_json TEXT NOT NULL, digest TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS retrieval_learning_versions (
        context_key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0),
        enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), payload_json TEXT NOT NULL, digest TEXT NOT NULL,
        PRIMARY KEY(context_key, revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS retrieval_learning_calls (
        call_id INTEGER PRIMARY KEY AUTOINCREMENT, context_key TEXT NOT NULL,
        receipt_id TEXT NOT NULL UNIQUE, query_key TEXT NOT NULL, query_features_json TEXT NOT NULL,
        candidates_json TEXT NOT NULL, pin_digest TEXT NOT NULL, candidate_digest TEXT NOT NULL,
        labels_json TEXT, judged_json TEXT, provenance TEXT, label_digest TEXT, recall REAL,
        version INTEGER NOT NULL DEFAULT 0,
        brier REAL, log_loss REAL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS retrieval_learning_calls_context ON retrieval_learning_calls(context_key, call_id);
      CREATE TABLE IF NOT EXISTS retrieval_learning_authorities (
        context_key TEXT NOT NULL, query_key TEXT NOT NULL, call_id INTEGER NOT NULL,
        query_features_json TEXT NOT NULL, candidates_json TEXT NOT NULL, labels_json TEXT NOT NULL,
        pin_digest TEXT NOT NULL, label_digest TEXT NOT NULL, version INTEGER NOT NULL,
        PRIMARY KEY(context_key, query_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS retrieval_learning_authorities_order ON retrieval_learning_authorities(context_key, call_id);
      CREATE TABLE IF NOT EXISTS retrieval_learning_operations (
        operation_id TEXT PRIMARY KEY, context_key TEXT NOT NULL, payload_digest TEXT NOT NULL,
        result_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS retrieval_learning_operations_context ON retrieval_learning_operations(context_key, operation_id);
    `);
    const persisted = db.prepare("SELECT value FROM retrieval_learning_meta WHERE key='salt'").get() as { value: string } | undefined;
    if (persisted) this.salt = persisted.value;
    else {
      this.salt = randomBytes(32).toString("hex");
      db.prepare("INSERT INTO retrieval_learning_meta(key,value) VALUES('salt',?)").run(this.salt);
    }
  }

  private transaction<T>(work: () => T): T {
    const nested = this.db.isTransaction;
    this.db.exec(nested ? "SAVEPOINT retrieval_learning" : "BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec(nested ? "RELEASE retrieval_learning" : "COMMIT");
      return result;
    } catch (error) {
      this.db.exec(nested ? "ROLLBACK TO retrieval_learning; RELEASE retrieval_learning" : "ROLLBACK");
      throw error;
    }
  }

  private readTransaction<T>(work: () => T): T {
    const nested = this.db.isTransaction;
    this.db.exec(nested ? "SAVEPOINT retrieval_learning_read" : "BEGIN");
    try {
      const result = work();
      this.db.exec(nested ? "RELEASE retrieval_learning_read" : "COMMIT");
      return result;
    } catch (error) {
      this.db.exec(nested ? "ROLLBACK TO retrieval_learning_read; RELEASE retrieval_learning_read" : "ROLLBACK");
      throw error;
    }
  }

  private scope(value: RetrievalLearningScope): { value: RetrievalLearningScope; key: string } {
    const scope = Object.freeze(retrievalLearningScope(value));
    return { value: scope, key: learningIdentity(this.salt, stableJson(scope)) };
  }

  private context(scope: RetrievalLearningScope, indexId: string, model: RetrievalLearningModelPin): {
    scope: RetrievalLearningScope; scopeKey: string; indexId: string; indexKey: string;
    model: RetrievalLearningModelPin; modelKey: string; contextKey: string;
  } {
    const normalized = this.scope(scope);
    const safeIndex = safeText(indexId, 256, "indexId");
    const safeModel = retrievalLearningModel(model);
    const indexKey = learningIdentity(this.salt, safeIndex);
    const modelKey = learningIdentity(this.salt, stableJson(safeModel));
    const contextKey = learningIdentity(this.salt, stableJson([normalized.key, indexKey, modelKey]));
    return {
      scope: normalized.value, scopeKey: normalized.key, indexId: safeIndex, indexKey,
      model: safeModel, modelKey, contextKey,
    };
  }

  private ensureHead(contextKey: string): StoredHead {
    let head = this.db.prepare("SELECT revision,enabled,payload_json,digest FROM retrieval_learning_heads WHERE context_key=?")
      .get(contextKey) as StoredHead | undefined;
    if (!head) {
      const payload = serializeModel(baselineSnapshot());
      const digest = learningIdentity(this.salt, payload);
      this.db.prepare("INSERT INTO retrieval_learning_versions VALUES(?,?,?,?,?)")
        .run(contextKey, 0, 0, payload, digest);
      this.db.prepare("INSERT INTO retrieval_learning_heads VALUES(?,?,?,?,?)")
        .run(contextKey, 0, 0, payload, digest);
      head = { revision: 0, enabled: 0, payload_json: payload, digest };
    }
    this.verifyHead(contextKey, head);
    return head;
  }

  private verifyHead(contextKey: string, head: StoredHead): StoredModel {
    const model = parseModel(head.payload_json);
    retrievalLearningAssert(learningIdentity(this.salt, head.payload_json) === head.digest,
      "INTEGRITY", "Retrieval-learning active model digest mismatch.");
    const version = this.db.prepare(`SELECT enabled,payload_json,digest FROM retrieval_learning_versions
      WHERE context_key=? AND revision=?`).get(contextKey, head.revision) as
      { enabled: number; payload_json: string; digest: string } | undefined;
    retrievalLearningAssert(version && version.enabled === head.enabled
      && version.payload_json === head.payload_json && version.digest === head.digest,
    "INTEGRITY", "Retrieval-learning active model version mismatch.");
    return model;
  }

  private publicModel(revision: number, enabled: boolean, model: StoredModel): RetrievalLearningModel {
    return {
      revision, enabled,
      baseline: { slope: P.baseSlope, bias: P.baseBias },
      current: { slope: model.slope, bias: model.bias },
      threshold: model.threshold, weights: [...model.weights], samples: model.samples,
      safeStreak: model.safeStreak, modelLabels: model.modelLabels, userLabels: model.userLabels,
      calibrationReady: learningCalibrationReady(enabled, model.samples, model.safeStreak),
      prequential: { ...model.prequential },
      rankerRevision: revision, calibratorRevision: revision, embeddingUpdated: false,
    };
  }

  private current(contextKey: string): { revision: number; enabled: boolean; model: StoredModel } {
    const head = this.db.prepare("SELECT revision,enabled,payload_json,digest FROM retrieval_learning_heads WHERE context_key=?")
      .get(contextKey) as StoredHead | undefined;
    if (!head) return { revision: 0, enabled: false, model: baselineSnapshot() };
    return { revision: head.revision, enabled: head.enabled === 1, model: this.verifyHead(contextKey, head) };
  }

  getModel(request: Pick<RetrievalLearningRerankRequest, "scope" | "indexId" | "model">): RetrievalLearningModel {
    const context = this.context(request.scope, request.indexId, request.model);
    return this.readTransaction(() => {
      const current = this.current(context.contextKey);
      return this.publicModel(current.revision, current.enabled, current.model);
    });
  }

  configure(request: {
    scope: RetrievalLearningScope;
    indexId: string;
    model: RetrievalLearningModelPin;
    operationId: string;
    expectedRevision: number;
    enabled: boolean;
  }): RetrievalLearningModel {
    const context = this.context(request.scope, request.indexId, request.model);
    const operationId = validateOperationId(request.operationId);
    const expectedRevision = validateRevision(request.expectedRevision);
    retrievalLearningAssert(typeof request.enabled === "boolean", "INVALID_ARGUMENT", "enabled must be boolean.");
    const payloadDigest = learningIdentity(this.salt, stableJson({
      kind: "configure", context: context.contextKey, expectedRevision, enabled: request.enabled,
    }));
    return this.transaction(() => {
      const duplicate = this.operation<RetrievalLearningModel>(operationId, context.contextKey, payloadDigest);
      if (duplicate) return duplicate;
      const head = this.ensureHead(context.contextKey);
      retrievalLearningAssert(head.revision === expectedRevision, "CONFLICT", "Retrieval-learning model compare-and-swap failed.");
      this.authorize(context.scope, "configure", []);
      const model = this.verifyHead(context.contextKey, head);
      if ((head.enabled === 1) !== request.enabled) {
        this.publish(context.contextKey, head, request.enabled, model);
      }
      const result = this.publicModel(this.current(context.contextKey).revision, request.enabled, model);
      this.saveOperation(operationId, context.contextKey, payloadDigest, result);
      this.pruneOperations(context.contextKey);
      return result;
    });
  }

  rerank(request: RetrievalLearningRerankRequest): {
    revision: number; enabled: boolean; applied: boolean; cut: number; reason: string;
    hits: RetrievalLearningRerankedHit[];
  } {
    const context = this.context(request.scope, request.indexId, request.model);
    safeText(request.query, P.maxQueryBytes, "query");
    const hits = this.validateHits(request.hits, context.indexId, context.model);
    const current = this.readTransaction(() => this.current(context.contextKey));
    const applied = current.enabled && current.model.samples > 0 && current.model.weights.some(weight => weight !== 0);
    const scale = Math.max(...hits.map(hit => Math.abs(hit.score)), 0) || 1;
    const candidates = hits.map((hit, basePosition) => ({
      id: learningIdentity(this.salt, hit.sourceId),
      x: Math.max(0, Math.min(1, hit.score / scale)),
      baseX: Math.max(0, Math.min(1, hit.score / scale)),
      basePosition,
    }));
    const ranked = applied
      ? learningRank(candidates, learningQueryFeatures(this.salt, request.query), current.model.weights, this.salt)
      : candidates.map((candidate, position) => ({ ...candidate, position, features: new Map<number, number>() }));
    let cut = hits.length;
    let reason = !current.enabled ? "disabled" : "insufficient-feedback";
    if (current.enabled && learningCalibrationReady(true, current.model.samples, current.model.safeStreak)) {
      reason = "no-reliable-gap";
      const { index: k, gap } = learningGap(ranked);
      if (k > 0 && k < hits.length && gap >= current.model.threshold
        && learningProbability(ranked[k - 1].x, current.model.slope, current.model.bias) >= P.retainProbability
        && learningProbability(ranked[k].x, current.model.slope, current.model.bias) <= P.discardProbability) {
        cut = k;
        reason = "calibrated-score-gap";
      }
    }
    const ordered = applied
      ? ranked.map((item, index): RetrievalLearningRerankedHit => {
        const hit = hits[item.position];
        return {
          ...hit, baseScore: hit.score, learnedScore: item.x, score: item.x, rank: index + 1,
          baseScoreSemantics: "reciprocal-rank", scoreSemantics: "engine-defined",
          learningRevision: current.revision,
        };
      })
      : hits.map(hit => ({ ...hit }));
    return {
      revision: current.revision, enabled: current.enabled, applied, cut, reason,
      hits: ordered.slice(0, cut),
    };
  }

  recordSearch(request: RetrievalLearningRecordRequest): RetrievalLearningReceipt {
    const context = this.context(request.scope, request.indexId, request.model);
    const operationId = validateOperationId(request.operationId);
    const expectedRevision = validateRevision(request.expectedRevision);
    safeText(request.query, P.maxQueryBytes, "query");
    const hits = this.validateHits(request.hits, context.indexId, context.model);
    const pinList = pinProjection(hits.map(hit => ({
      sourceId: hit.sourceId, sourceRevision: hit.sourceRevision, sourceSha256: hit.sourceSha256,
    }))).map(pin => ({ ...pin, sourceId: learningIdentity(this.salt, pin.sourceId) }))
      .sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
    const payloadDigest = learningIdentity(this.salt, stableJson({
      kind: "record", context: context.contextKey, expectedRevision,
      query: request.query, pins: pinList, scores: hits.map(hit => [hit.score, hit.rank, hit.similarity]),
    }));
    return this.transaction(() => {
      const duplicate = this.operation<RetrievalLearningReceipt>(operationId, context.contextKey, payloadDigest);
      if (duplicate) return duplicate;
      const head = this.ensureHead(context.contextKey);
      retrievalLearningAssert(head.revision === expectedRevision, "CONFLICT", "Retrieval-learning model changed before impression capture.");
      const candidates = hits.map((hit, basePosition): StoredCandidate => ({
        id: learningIdentity(this.salt, hit.sourceId),
        x: Math.max(0, Math.min(1, hit.score)),
        baseX: Math.max(0, Math.min(1, hit.score)),
        basePosition,
        sourceRevision: hit.sourceRevision,
        sourceSha256: hit.sourceSha256,
      }));
      const queryFeatures = learningQueryFeatures(this.salt, request.query);
      const queryKey = learningQueryKey(this.salt, request.query);
      const pinDigest = this.pinDigest(context.contextKey, context.indexKey, context.modelKey, pinList);
      const candidateDigest = this.candidateDigest(candidates, queryFeatures, queryKey, pinDigest);
      const retrievalId = randomUUID();
      this.db.prepare(`INSERT INTO retrieval_learning_calls
        (context_key,receipt_id,query_key,query_features_json,candidates_json,pin_digest,candidate_digest)
        VALUES(?,?,?,?,?,?,?)`)
        .run(context.contextKey, retrievalId, queryKey, stableJson(queryFeatures), stableJson(candidates), pinDigest, candidateDigest);
      this.db.prepare(`DELETE FROM retrieval_learning_calls WHERE context_key=? AND call_id NOT IN
        (SELECT call_id FROM retrieval_learning_calls WHERE context_key=? ORDER BY call_id DESC LIMIT ?)`)
        .run(context.contextKey, context.contextKey, P.retentionCalls);
      const result: RetrievalLearningReceipt = { retrievalId, revision: head.revision, enabled: head.enabled === 1 };
      this.saveOperation(operationId, context.contextKey, payloadDigest, result);
      this.pruneOperations(context.contextKey);
      return result;
    });
  }

  feedback(request: RetrievalLearningFeedbackRequest): RetrievalLearningAcknowledgment {
    const context = this.context(request.scope, request.indexId, request.model);
    const operationId = validateOperationId(request.operationId);
    const expectedRevision = validateRevision(request.expectedRevision);
    retrievalLearningAssert(typeof request.retrievalId === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.retrievalId),
    "INVALID_ARGUMENT", "Invalid retrievalId.");
    const sourcePins = retrievalLearningPins(request.sourcePins);
    const relevantSourceIds = this.validateLabelIds(request.relevantSourceIds, "relevantSourceIds");
    const provenance = request.provenance === "self" ? "model" : request.provenance ?? "user";
    retrievalLearningAssert(provenance === "user" || provenance === "model", "INVALID_ARGUMENT", "Unsupported label provenance.");
    const partial = request.judgedSourceIds !== undefined;
    retrievalLearningAssert(typeof request.complete === "boolean"
      && (partial ? request.complete === false && provenance === "model" : request.complete === true),
    "INVALID_ARGUMENT", "Use complete=true, or complete=false with partial model judgments.");
    const judgedSourceIds = partial ? this.validateLabelIds(request.judgedSourceIds!, "judgedSourceIds") : null;
    if (judgedSourceIds) {
      retrievalLearningAssert(judgedSourceIds.length > 0 && judgedSourceIds.length <= P.maxCandidates
        && new Set(judgedSourceIds).size === judgedSourceIds.length
        && relevantSourceIds.every(id => judgedSourceIds.includes(id)),
      "INVALID_ARGUMENT", "Partial model judgments require unique bounded judged sources containing every relevant source.");
    }
    const relevant = [...new Set(relevantSourceIds.map(id => learningIdentity(this.salt, id)))].sort();
    const judged = judgedSourceIds ? judgedSourceIds.map(id => learningIdentity(this.salt, id)).sort() : null;
    const labelDigest = learningIdentity(this.salt, stableJson([relevant, judged]));
    const payloadDigest = learningIdentity(this.salt, stableJson({
      kind: "feedback", context: context.contextKey, expectedRevision, retrievalId: request.retrievalId,
      pins: pinProjection(sourcePins), relevantSourceIds, judgedSourceIds, complete: request.complete, provenance,
    }));

    return this.transaction(() => {
      const duplicateOperation = this.operation<RetrievalLearningAcknowledgment>(operationId, context.contextKey, payloadDigest);
      if (duplicateOperation) return duplicateOperation;
      const head = this.ensureHead(context.contextKey);
      retrievalLearningAssert(head.revision === expectedRevision, "CONFLICT", "Retrieval-learning feedback compare-and-swap failed.");
      const row = this.db.prepare(`SELECT call_id,receipt_id,query_key,query_features_json,candidates_json,
        pin_digest,candidate_digest,labels_json,judged_json,provenance,label_digest,recall,version
        FROM retrieval_learning_calls WHERE context_key=? AND receipt_id=?`)
        .get(context.contextKey, request.retrievalId) as StoredCall | undefined;
      retrievalLearningAssert(row, "NOT_FOUND", "Unknown or expired retrievalId.");
      const candidates = safeParseArray<StoredCandidate>(row.candidates_json, "candidate pins");
      const queryFeatures = safeParseArray<string>(row.query_features_json, "query features");
      this.verifyCandidateRecord(context, row, candidates, queryFeatures);
      this.verifyExpectedPins(context, candidates, sourcePins);
      const candidateIds = new Set(candidates.map(candidate => candidate.id));
      if (judged) {
        const judgedHashes = new Set(judged);
        retrievalLearningAssert([...judgedHashes].every(id => candidateIds.has(id)),
          "INVALID_ARGUMENT", "Partial judgments may reference delivered candidates only.");
      }
      const previousLabels = row.labels_json ? safeParseArray<string>(row.labels_json, "labels") : null;
      const authority = this.db.prepare(`SELECT call_id,query_features_json,candidates_json,labels_json,pin_digest
        FROM retrieval_learning_authorities WHERE context_key=? AND query_key=?`)
        .get(context.contextKey, row.query_key) as Omit<StoredAuthority, "query_key"> | undefined;
      const queryHasLabels = !!this.db.prepare(`SELECT 1 AS found FROM retrieval_learning_calls
        WHERE context_key=? AND query_key=? AND labels_json IS NOT NULL LIMIT 1`)
        .get(context.contextKey, row.query_key);
      const ignored = provenance === "model" && (row.provenance === "user" || !!authority);
      const duplicate = row.label_digest === labelDigest && row.provenance === provenance;
      if (duplicate || ignored) {
        const current = this.current(context.contextKey);
        const result = this.acknowledgment({
          trained: false, duplicate, ignored, superseded: false,
          reason: ignored ? "user-precedence" : duplicate ? "duplicate" : undefined,
          recall: row.recall, version: row.version, provenance: ignored ? "user" : provenance,
          revision: current.revision, enabled: current.enabled, model: current.model,
        });
        this.saveOperation(operationId, context.contextKey, payloadDigest, result);
        this.pruneOperations(context.contextKey);
        return result;
      }
      retrievalLearningAssert(head.enabled === 1, "CONFLICT", "Online retrieval learning is disabled.");
      this.authorize(context.scope, "train", sourcePins);
      if (sourcePins.some(pin => pin.sourceRevision.length > 256)) {
        throw new RetrievalLearningError("INVALID_ARGUMENT", "Invalid pinned source revision.");
      }
      const retained = new Set(candidates.map(candidate => candidate.id));
      const recall = relevant.length && !partial
        ? relevant.filter(id => retained.has(id)).length / relevant.length
        : null;
      const nextReceiptVersion = row.version + 1;
      this.db.prepare(`UPDATE retrieval_learning_calls SET labels_json=?,judged_json=?,provenance=?,
        label_digest=?,recall=?,version=?,brier=NULL,log_loss=NULL WHERE call_id=? AND context_key=?`)
        .run(stableJson(relevant), judged ? stableJson(judged) : null, provenance, labelDigest,
          recall, nextReceiptVersion, row.call_id, context.contextKey);

      if (provenance === "user") {
        const authorityCount = this.db.prepare(`SELECT count(*) AS count FROM retrieval_learning_authorities
          WHERE context_key=?`).get(context.contextKey) as { count: number };
        const existingAuthority = !!authority;
        retrievalLearningAssert(existingAuthority || authorityCount.count < P.retentionCalls,
          "LIMIT", "Bounded user-query authority capacity reached.");
        this.db.prepare(`INSERT INTO retrieval_learning_authorities
          (context_key,query_key,call_id,query_features_json,candidates_json,labels_json,pin_digest,label_digest,version)
          VALUES(?,?,?,?,?,?,?,?,?)
          ON CONFLICT(context_key,query_key) DO UPDATE SET call_id=excluded.call_id,
          query_features_json=excluded.query_features_json,candidates_json=excluded.candidates_json,
          labels_json=excluded.labels_json,pin_digest=excluded.pin_digest,
          label_digest=excluded.label_digest,version=excluded.version`)
          .run(context.contextKey, row.query_key, row.call_id, row.query_features_json, row.candidates_json,
            stableJson(relevant), row.pin_digest, labelDigest, nextReceiptVersion);
      }
      const replay = this.replayContext(context.contextKey);
      this.writeCallMetrics(context.contextKey, replay.callMetrics);
      const currentHead = this.db.prepare(`SELECT revision,enabled,payload_json,digest FROM retrieval_learning_heads
        WHERE context_key=?`).get(context.contextKey) as unknown as StoredHead;
      const previousAuthorityDifferent = !!authority && (
        this.authorityDigest(authority) !== this.authorityDigest({
          call_id: row.call_id,
          query_features_json: row.query_features_json, candidates_json: row.candidates_json,
          labels_json: stableJson(relevant), pin_digest: row.pin_digest,
        })
      );
      const superseded = !!previousLabels || previousAuthorityDifferent || provenance === "user" && queryHasLabels;
      this.publish(context.contextKey, currentHead, true, replay);
      const current = this.current(context.contextKey);
      const result = this.acknowledgment({
        trained: true, duplicate: false, ignored: false, superseded,
        recall, version: nextReceiptVersion, provenance,
        revision: current.revision, enabled: current.enabled, model: current.model,
      });
      this.saveOperation(operationId, context.contextKey, payloadDigest, result);
      this.pruneOperations(context.contextKey);
      return result;
    });
  }

  private validateHits(hits: readonly RetrievalLearningHit[], indexId: string,
    model: RetrievalLearningModelPin): RetrievalLearningHit[] {
    retrievalLearningAssert(Array.isArray(hits) && hits.length <= P.maxCandidates,
      "LIMIT", "Retrieval-learning candidate bound exceeded.");
    const seen = new Set<string>();
    let previousScore = Number.POSITIVE_INFINITY;
    return hits.map((hit, index) => {
      retrievalLearningAssert(hit && typeof hit === "object", "INVALID_ARGUMENT", "Invalid retrieval hit.");
      safeText(hit.sourceId, 256, "sourceId");
      safeText(hit.sourceRevision, 256, "sourceRevision");
      retrievalLearningAssert(typeof hit.sourceSha256 === "string" && /^[a-f0-9]{64}$/.test(hit.sourceSha256),
        "INVALID_ARGUMENT", "Invalid source content pin.");
      retrievalLearningAssert(hit.indexId === indexId && stableJson(retrievalLearningModel(hit.model)) === stableJson(model),
        "CONFLICT", "Retrieval hit index or embedding-model pin mismatch.");
      safeText(hit.chunkId, 256, "chunkId");
      safeText(hit.text, 1024 * 1024, "chunk text");
      retrievalLearningAssert(hit.rank === index + 1 && hit.score === 1 / hit.rank
        && Number.isFinite(hit.similarity) && hit.similarity >= -1 && hit.similarity <= 1
        && hit.score <= previousScore,
      "INVALID_ARGUMENT", "Retrieval hits must preserve the pinned reciprocal-rank score order.");
      retrievalLearningAssert(!seen.has(hit.sourceId), "INVALID_ARGUMENT", "Duplicate retrieval source in result pool.");
      seen.add(hit.sourceId);
      previousScore = hit.score;
      return {
        sourceId: hit.sourceId, sourceRevision: hit.sourceRevision, sourceSha256: hit.sourceSha256,
        indexId: hit.indexId, model: { ...model }, chunkId: hit.chunkId, text: hit.text,
        rank: hit.rank, score: hit.score, similarity: hit.similarity,
      };
    });
  }

  private validateLabelIds(value: readonly string[], label: string): string[] {
    retrievalLearningAssert(Array.isArray(value) && value.length <= P.maxLabels, "LIMIT", `${label} bound exceeded.`);
    let bytes = 0;
    const result = value.map(id => {
      const safe = safeText(id, 4096, label);
      bytes += Buffer.byteLength(safe);
      retrievalLearningAssert(bytes <= P.maxLabelBytes, "LIMIT", `${label} byte bound exceeded.`);
      return safe;
    });
    return result;
  }

  private pinDigest(contextKey: string, indexKey: string, modelKey: string,
    pins: readonly RetrievalLearningSourcePin[]): string {
    return learningIdentity(this.salt, stableJson({ contextKey, indexKey, modelKey, pins: pinProjection(pins) }));
  }

  private candidateDigest(candidates: readonly StoredCandidate[], queryFeatures: readonly string[],
    queryKey: string, pinDigest: string): string {
    return learningIdentity(this.salt, stableJson({ candidates, queryFeatures, queryKey, pinDigest }));
  }

  private verifyCandidateRecord(context: ReturnType<RetrievalLearning["context"]>, row: StoredCall,
    candidates: readonly StoredCandidate[], queryFeatures: readonly string[]): void {
    retrievalLearningAssert(candidates.length <= P.maxCandidates
      && candidates.every((item, index) => typeof item.id === "string" && /^[a-f0-9]{64}$/.test(item.id)
        && Number.isSafeInteger(item.basePosition) && item.basePosition === index
        && Number.isFinite(item.baseX) && item.baseX >= 0 && item.baseX <= 1
        && item.x === item.baseX && typeof item.sourceRevision === "string"
        && /^[a-f0-9]{64}$/.test(item.sourceSha256)),
    "INTEGRITY", "Stored retrieval candidate pins are invalid.");
    const pins = candidates.map(candidate => ({
      sourceId: candidate.id, sourceRevision: candidate.sourceRevision, sourceSha256: candidate.sourceSha256,
    })).sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
    retrievalLearningAssert(row.pin_digest === this.pinDigest(context.contextKey, context.indexKey, context.modelKey, pins)
      && row.candidate_digest === this.candidateDigest(candidates, queryFeatures, row.query_key, row.pin_digest),
    "INTEGRITY", "Retrieval feedback source or query pin was tampered with.");
  }

  private verifyExpectedPins(context: ReturnType<RetrievalLearning["context"]>,
    candidates: readonly StoredCandidate[], value: readonly RetrievalLearningSourcePin[]): void {
    const submitted = pinProjection(value).map(pin => ({
      sourceId: learningIdentity(this.salt, pin.sourceId),
      sourceRevision: pin.sourceRevision, sourceSha256: pin.sourceSha256,
    })).sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
    const stored = candidates.map(candidate => ({
      sourceId: candidate.id, sourceRevision: candidate.sourceRevision, sourceSha256: candidate.sourceSha256,
    })).sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
    retrievalLearningAssert(stableJson(submitted) === stableJson(stored),
      "CONFLICT", "Feedback source pins do not match the captured retrieval result.");
    retrievalLearningAssert(context.scopeKey.length === 64, "INTEGRITY", "Invalid retrieval-learning namespace pin.");
  }

  private replayContext(contextKey: string): LearningReplay {
    const calls = this.db.prepare(`SELECT call_id,query_key,query_features_json,candidates_json,
      labels_json,judged_json,provenance FROM retrieval_learning_calls
      WHERE context_key=? AND labels_json IS NOT NULL ORDER BY call_id`).all(contextKey) as Array<{
      call_id: number; query_key: string; query_features_json: string; candidates_json: string;
      labels_json: string; judged_json: string | null; provenance: "user" | "model";
    }>;
    const authorities = this.db.prepare(`SELECT call_id,query_key,query_features_json,candidates_json,labels_json
      FROM retrieval_learning_authorities WHERE context_key=? ORDER BY call_id`).all(contextKey) as Array<{
      call_id: number; query_key: string; query_features_json: string; candidates_json: string; labels_json: string;
    }>;
    const userAuthorities = new Map<string, LearningFeedbackCall>();
    for (const authority of authorities) {
      const candidates = safeParseArray<StoredCandidate>(authority.candidates_json, "user-authority candidates");
      userAuthorities.set(authority.query_key, {
        callId: authority.call_id,
        queryKey: authority.query_key,
        candidates,
        queryFeatures: safeParseArray<string>(authority.query_features_json, "user-authority query features"),
        relevant: safeParseArray<string>(authority.labels_json, "user-authority labels"),
        judged: null, provenance: "user",
      });
    }
    const inputs: LearningFeedbackCall[] = calls.map(call => ({
      callId: call.call_id,
      queryKey: call.query_key,
      candidates: safeParseArray<StoredCandidate>(call.candidates_json, "training candidates"),
      queryFeatures: safeParseArray<string>(call.query_features_json, "training query features"),
      relevant: safeParseArray<string>(call.labels_json, "training labels"),
      judged: call.judged_json === null ? null : safeParseArray<string>(call.judged_json, "judged candidate ids"),
      provenance: call.provenance,
    }));
    return replayLearning(inputs, this.salt, userAuthorities);
  }

  private writeCallMetrics(contextKey: string, metrics: ReadonlyMap<number, { brier: number | null; logLoss: number | null }>): void {
    this.db.prepare("UPDATE retrieval_learning_calls SET brier=NULL,log_loss=NULL WHERE context_key=?").run(contextKey);
    const update = this.db.prepare("UPDATE retrieval_learning_calls SET brier=?,log_loss=? WHERE context_key=? AND call_id=?");
    for (const [callId, metric] of metrics) update.run(metric.brier, metric.logLoss, contextKey, callId);
  }

  private publish(contextKey: string, previous: StoredHead, enabled: boolean, model: StoredModel | LearningReplay): void {
    const payload = serializeModel(model);
    const digest = learningIdentity(this.salt, payload);
    const revision = previous.revision + 1;
    this.db.prepare("INSERT INTO retrieval_learning_versions VALUES(?,?,?,?,?)")
      .run(contextKey, revision, enabled ? 1 : 0, payload, digest);
    const update = this.db.prepare(`UPDATE retrieval_learning_heads SET revision=?,enabled=?,payload_json=?,digest=?
      WHERE context_key=? AND revision=? AND digest=?`);
    const result = update.run(revision, enabled ? 1 : 0, payload, digest, contextKey, previous.revision, previous.digest);
    retrievalLearningAssert(result.changes === 1, "CONFLICT", "Retrieval-learning model compare-and-swap failed.");
    this.db.prepare(`DELETE FROM retrieval_learning_versions WHERE context_key=? AND revision NOT IN
      (SELECT revision FROM retrieval_learning_versions WHERE context_key=? ORDER BY revision DESC LIMIT ?)`)
      .run(contextKey, contextKey, P.retentionCalls);
  }

  private operation<T>(operationId: string, contextKey: string, payloadDigest: string): T | undefined {
    const previous = this.db.prepare(`SELECT context_key,payload_digest,result_json
      FROM retrieval_learning_operations WHERE operation_id=?`).get(operationId) as StoredOperation | undefined;
    if (!previous) return undefined;
    retrievalLearningAssert(previous.context_key === contextKey && previous.payload_digest === payloadDigest,
      "CONFLICT", "operationId was reused with a different request.");
    try { return JSON.parse(previous.result_json) as T; }
    catch { throw new RetrievalLearningError("INTEGRITY", "Corrupt retrieval-learning operation receipt."); }
  }

  private saveOperation<T>(operationId: string, contextKey: string, payloadDigest: string, result: T): void {
    this.db.prepare(`INSERT INTO retrieval_learning_operations(operation_id,context_key,payload_digest,result_json)
      VALUES(?,?,?,?)`).run(operationId, contextKey, payloadDigest, stableJson(result));
  }

  private pruneOperations(contextKey: string): void {
    this.db.prepare(`DELETE FROM retrieval_learning_operations WHERE context_key=? AND operation_id NOT IN
      (SELECT operation_id FROM retrieval_learning_operations WHERE context_key=? ORDER BY rowid DESC LIMIT ?)`)
      .run(contextKey, contextKey, P.retentionCalls);
  }

  private authorize(scope: RetrievalLearningScope, action: "configure" | "train",
    pins: readonly RetrievalLearningSourcePin[]): void {
    retrievalLearningAssert(typeof this.options.nativeAuthorize === "function"
      && this.options.nativeAuthorize(scope, action, pins) === true,
    "FORBIDDEN", "Native authorization is required for retrieval-learning state changes.");
  }

  private authorityDigest(value: Pick<StoredAuthority, "call_id" | "query_features_json" | "candidates_json" | "labels_json" | "pin_digest">): string {
    return stableJson([value.call_id, value.query_features_json, value.candidates_json, value.labels_json, value.pin_digest]);
  }

  private acknowledgment(value: {
    trained: boolean; duplicate: boolean; ignored: boolean; superseded: boolean;
    reason?: "duplicate" | "user-precedence"; recall: number | null; version: number;
    provenance: "user" | "model"; revision: number; enabled: boolean; model: StoredModel;
  }): RetrievalLearningAcknowledgment {
    const ready = learningCalibrationReady(value.enabled, value.model.samples, value.model.safeStreak);
    return {
      ok: true,
      trained: value.trained,
      duplicate: value.duplicate,
      ignored: value.ignored,
      superseded: value.superseded,
      ...(value.reason ? { reason: value.reason } : {}),
      recall: value.recall,
      version: value.version,
      provenance: value.provenance,
      revision: value.revision,
      rankerRevision: value.revision,
      calibratorRevision: value.revision,
      modelLabels: value.model.modelLabels,
      userLabels: value.model.userLabels,
      state: !value.enabled ? "disabled" : ready ? "ready" : "collecting-feedback",
      calibrationReady: ready,
      judgedCalls: value.model.samples,
      safeStreak: value.model.safeStreak,
    };
  }
}

export function retrievalLearningFeedbackSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      schema: { const: "pkm.retrieval.learning.feedback/v1" },
      operationId: { type: "string", format: "uuid" },
      expectedRevision: { type: "integer", minimum: 0 },
      retrievalId: { type: "string", format: "uuid" },
      scope: {
        type: "object", additionalProperties: false,
        properties: {
          namespace: { type: "string", minLength: 1, maxLength: 256 },
          workspace: { type: "string", minLength: 1, maxLength: 256 },
          actor: { type: "string", minLength: 1, maxLength: 256 },
        },
        required: ["namespace", "workspace", "actor"],
      },
      indexId: { type: "string", minLength: 1, maxLength: 256 },
      model: {
        type: "object", additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: 256 },
          revision: { type: "string", minLength: 1, maxLength: 256 },
          dimensions: { type: "integer", minimum: 1, maximum: 4096 },
          architecture: { const: "dense-section" },
        },
        required: ["id", "revision", "dimensions", "architecture"],
      },
      sourcePins: {
        type: "array", maxItems: 100,
        items: {
          type: "object", additionalProperties: false,
          properties: {
            sourceId: { type: "string", minLength: 1, maxLength: 256 },
            sourceRevision: { type: "string", minLength: 1, maxLength: 256 },
            sourceSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
          required: ["sourceId", "sourceRevision", "sourceSha256"],
        },
      },
      relevantSourceIds: { type: "array", maxItems: P.maxLabels, items: { type: "string", minLength: 1, maxLength: 4096 } },
      complete: { type: "boolean" },
      provenance: { enum: ["user", "model", "self"] },
      judgedSourceIds: { type: "array", maxItems: P.maxCandidates, items: { type: "string", minLength: 1, maxLength: 4096 } },
    },
    required: ["schema", "operationId", "expectedRevision", "retrievalId", "scope", "indexId", "model",
      "sourcePins", "relevantSourceIds", "complete"],
    anyOf: [
      { properties: { complete: { const: true } }, not: { required: ["judgedSourceIds"] } },
      { properties: { complete: { const: false }, provenance: { const: "model" } }, required: ["judgedSourceIds"] },
    ],
    description: "Schema only. The host must authorize the actor and every pinned source through its native authorization boundary before training; label text and source content are never accepted.",
    "x-maximum-label-bytes": P.maxLabelBytes,
    "x-maximum-query-bytes": P.maxQueryBytes,
  };
}
