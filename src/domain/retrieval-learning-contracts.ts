import { RETRIEVAL_RUNTIME_LIMITS, retrievalText } from "./retrieval-runtime.js";

export interface RetrievalLearningScope {
  namespace: string;
  workspace: string;
  actor: string;
}

export interface RetrievalLearningModelPin {
  id: string;
  revision: string;
  dimensions: number;
  architecture: "dense-section";
}

export interface RetrievalLearningHit {
  sourceId: string;
  sourceRevision: string;
  sourceSha256: string;
  indexId: string;
  model: RetrievalLearningModelPin;
  chunkId: string;
  text: string;
  rank: number;
  score: number;
  similarity: number;
}

export interface RetrievalLearningSourcePin {
  sourceId: string;
  sourceRevision: string;
  sourceSha256: string;
}

export class RetrievalLearningError extends Error {
  constructor(public readonly code: "INVALID_ARGUMENT" | "LIMIT" | "CONFLICT" | "FORBIDDEN" | "INTEGRITY" | "NOT_FOUND", message: string) {
    super(message);
    this.name = "RetrievalLearningError";
  }
}

export function retrievalLearningAssert(value: unknown,
  code: RetrievalLearningError["code"], message: string): asserts value {
  if (!value) throw new RetrievalLearningError(code, message);
}

export function retrievalLearningScope(value: RetrievalLearningScope): RetrievalLearningScope {
  retrievalLearningAssert(value && typeof value === "object", "INVALID_ARGUMENT", "Explicit retrieval learning scope required.");
  for (const key of ["namespace", "workspace", "actor"] as const) {
    try { retrievalText(value[key], 256); }
    catch { throw new RetrievalLearningError("INVALID_ARGUMENT", "Invalid retrieval learning scope."); }
  }
  return { namespace: value.namespace, workspace: value.workspace, actor: value.actor };
}

export function retrievalLearningModel(value: RetrievalLearningModelPin): RetrievalLearningModelPin {
  retrievalLearningAssert(value && typeof value === "object", "INVALID_ARGUMENT", "Embedding model pin required.");
  try { retrievalText(value.id, 256); retrievalText(value.revision, 256); }
  catch { throw new RetrievalLearningError("INVALID_ARGUMENT", "Invalid embedding model pin."); }
  retrievalLearningAssert(value.architecture === "dense-section"
    && Number.isSafeInteger(value.dimensions) && value.dimensions >= 1
    && value.dimensions <= RETRIEVAL_RUNTIME_LIMITS.dimensions,
  "INVALID_ARGUMENT", "Unsupported embedding model pin.");
  return { id: value.id, revision: value.revision, dimensions: value.dimensions, architecture: value.architecture };
}

export function retrievalLearningPins(value: readonly RetrievalLearningSourcePin[]): RetrievalLearningSourcePin[] {
  retrievalLearningAssert(Array.isArray(value) && value.length <= RETRIEVAL_RUNTIME_LIMITS.results,
    "LIMIT", "Retrieval source pin bound exceeded.");
  const seen = new Set<string>();
  return value.map(pin => {
    retrievalLearningAssert(pin && typeof pin === "object", "INVALID_ARGUMENT", "Invalid retrieval source pin.");
    try { retrievalText(pin.sourceId, 256); retrievalText(pin.sourceRevision, 256); }
    catch { throw new RetrievalLearningError("INVALID_ARGUMENT", "Invalid retrieval source pin."); }
    retrievalLearningAssert(typeof pin.sourceSha256 === "string" && /^[a-f0-9]{64}$/.test(pin.sourceSha256),
      "INVALID_ARGUMENT", "Invalid retrieval source SHA-256 pin.");
    retrievalLearningAssert(!seen.has(pin.sourceId), "INVALID_ARGUMENT", "Duplicate retrieval source pin.");
    seen.add(pin.sourceId);
    return { sourceId: pin.sourceId, sourceRevision: pin.sourceRevision, sourceSha256: pin.sourceSha256 };
  });
}
