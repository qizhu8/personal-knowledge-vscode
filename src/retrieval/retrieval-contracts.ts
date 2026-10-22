import { compileKnowledgeLinksV1, type KnowledgeLinkV1 } from "../knowledge/knowledge-contracts";

export const RETRIEVAL_QUERY_SCHEMA_V1 = "pkm.retrieval.query/v1" as const;
export const RETRIEVAL_RESULT_SCHEMA_V1 = "pkm.retrieval.result/v1" as const;
export const RETRIEVAL_INDEX_EVENT_SCHEMA_V1 = "pkm.retrieval.index-event/v1" as const;
export const RETRIEVAL_CAPABILITIES_SCHEMA_V1 = "pkm.retrieval.capabilities/v1" as const;
export const RETRIEVAL_SELECTION_RECEIPT_SCHEMA_V1 = "pkm.retrieval.selection-receipt/v1" as const;

export type RetrievalContentType = "skill" | "note" | "research" | "script" | "recipe" | "action" | "subscription";
export type RetrievalRoute = "lexical" | "semantic" | "dual" | "graph" | "hybrid";
export type RetrievalDiagnosticsLevel = "none" | "summary" | "debug";
export type RetrievalScoreSemantics = "rank-only" | "similarity" | "distance" | "probability" | "rrf" | "engine-defined";
export type RetrievalLevel = "l1-source" | "l2-passage";
export type RetrievalGenerationPolicy =
  | { mode: "latest-ready" }
  | { mode: "exact"; generation: number }
  | { mode: "minimum"; generation: number };

export interface RetrievalCapabilityScope {
  capabilityId: string;
  sourceIds?: string[];
  includeReadOnly?: boolean;
}

export interface RetrievalGraphBudget {
  maxDepth: number;
  maxNodes: number;
  maxEdges: number;
  relations?: string[];
  direction?: "forward" | "backlink" | "both";
}

export interface RetrievalQueryV1 {
  schema: typeof RETRIEVAL_QUERY_SCHEMA_V1;
  requestId: string;
  text: string;
  level?: RetrievalLevel;
  contentTypeFilter?: RetrievalContentType[];
  scope: RetrievalCapabilityScope;
  topK: number;
  route: RetrievalRoute;
  generation: RetrievalGenerationPolicy;
  graph?: RetrievalGraphBudget;
  deadlineMs?: number;
  diagnostics: RetrievalDiagnosticsLevel;
}

export interface RetrievalServingIdentityV1 {
  providerId: string;
  providerVersion: string;
  route: string;
  scoreSemantics: RetrievalScoreSemantics;
  architectureId?: string;
  modelId?: string;
  modelVersion?: string;
  packageId?: string;
  releaseId?: string;
  fallback?: string;
}

export interface RetrievalProviderCapabilitiesV1 {
  schema: typeof RETRIEVAL_CAPABILITIES_SCHEMA_V1;
  provider: RetrievalServingIdentityV1;
  querySchemas: string[];
  resultSchemas: string[];
  levels: RetrievalLevel[];
  sourceKinds: string[];
  routes: string[];
  scoreSemantics: RetrievalScoreSemantics[];
  features: {
    filters: boolean;
    generations: boolean;
    graph: boolean;
    contentRanges: boolean;
    refinement: boolean;
    streaming: boolean;
  };
  limits: {
    maxTopK: number;
    maxQueryCharacters: number;
    maxDeadlineMs: number;
  };
}

export interface RetrievalCandidateV1 {
  id: string;
  level?: RetrievalLevel;
  kind: string;
  label: string;
  sourceUri: string;
  method: string;
  score: number;
  scoreSemantics?: RetrievalScoreSemantics;
  scoreComponents?: Record<string, number>;
  selected: boolean;
  reason: string;
  sourceId?: string;
  sourceRevision?: string;
  contentHash?: string;
  rank?: number;
  parentId?: string;
  parentRevision?: string;
  parentContentHash?: string;
  range?: { start: number; end: number; unit: "characters" | "bytes" | "lines" };
  offsetEncoding?: "utf16";
  contextIds?: string[];
  serving?: RetrievalServingIdentityV1;
  content?: string;
}

export interface RetrievalSelectionReceiptV1 {
  schema: typeof RETRIEVAL_SELECTION_RECEIPT_SCHEMA_V1;
  requestId: string;
  consumerId: string;
  targetId: string;
  selectedCount: number;
  candidates: Omit<RetrievalCandidateV1, "content">[];
  serving: RetrievalServingIdentityV1[];
  budget?: {
    unit: "tokens" | "bytes" | "characters";
    available: number;
    selected: number;
  };
  incomplete: boolean;
  warning?: string;
}

export interface RetrievalProviderV1<TQuery = RetrievalQueryV1, TResult = RetrievalResultV1> {
  capabilities(): Promise<RetrievalProviderCapabilitiesV1>;
  retrieve(query: TQuery, signal: AbortSignal): Promise<TResult>;
}

export interface RetrievalCandidateSanitization {
  candidates: RetrievalCandidateV1[];
  diagnostics: RetrievalContractDiagnostic[];
  incomplete: boolean;
}

export type RetrievalDiagnosticCode =
  | "invalid-query"
  | "unsupported-route"
  | "generation-not-ready"
  | "generation-unavailable"
  | "deadline-exceeded"
  | "cancelled"
  | "unresolved-target"
  | "private-target"
  | "trashed-target"
  | "unavailable-target"
  | "pinned-revision-mismatch"
  | "cycle"
  | "truncated";

export interface RetrievalDiagnostic {
  code: RetrievalDiagnosticCode;
  message: string;
  sourceId?: string;
  targetId?: string;
  relation?: string;
}

/** Raw scores are evidence only. Dual ranking uses reciprocal ranks (k=60). */
export interface RetrievalPathEvidence {
  path: "lexical" | "semantic";
  rank: number;
  score: number;
  matched_field: string;
  matched_path: string;
  match: "exact" | "keyword" | "fuzzy" | "semantic";
}

export type RetrievalSemanticStatus = "off" | "ready" | "unavailable" | "fallback";

export interface RetrievalResultHitV1 {
  sources?: Array<"lexical" | "semantic">;
  source_label?: "from keyword search" | "from embedding retrieval" | "both";
  path_evidence?: RetrievalPathEvidence[];
  score_semantics?: RetrievalScoreSemantics;
  rank: number;
  score: number;
  scoreComponents: {
    lexical: number;
    semantic: number;
    graph: number;
    priority: number;
  };
  sourceId: string;
  sourceRevision: string;
  contentHash: string;
  contentType: RetrievalContentType;
  sourceUri: string;
  title: string;
  description: string;
  readOnly: boolean;
  route: RetrievalRoute;
  serving?: RetrievalServingIdentityV1;
  metadata: Record<string, string>;
  provenance: Record<string, unknown>;
}

export interface RetrievalResultV1 {
  search_mode?: "lexical" | "semantic" | "dual";
  semantic_status?: RetrievalSemanticStatus;
  semantic_reason?: string;
  schema: typeof RETRIEVAL_RESULT_SCHEMA_V1;
  ok: true;
  requestId: string;
  readyGeneration: number;
  corpusRevision: string;
  route: RetrievalRoute;
  intent: string;
  hits: RetrievalResultHitV1[];
  diagnostics: RetrievalDiagnostic[];
  stale: boolean;
  incomplete: boolean;
  timingsMs: {
    wait: number;
    search: number;
    total: number;
  };
}

export interface RetrievalIndexSource {
  sourceId: string;
  sourceRevision: string;
  contentHash: string;
  contentType: RetrievalContentType;
  sourceUri: string;
  title: string;
  description: string;
  body: string;
  metadata: Record<string, string>;
  provenance: Record<string, unknown>;
  readOnly: boolean;
  visibility?: "available" | "private" | "trashed" | "unavailable";
  links?: KnowledgeLinkV1[];
}

interface RetrievalIndexEventBase {
  schema: typeof RETRIEVAL_INDEX_EVENT_SCHEMA_V1;
  eventId: string;
  sourceId: string;
  sourceRevision: string;
}

export type RetrievalIndexEventV1 =
  | (RetrievalIndexEventBase & { kind: "upsert"; source: RetrievalIndexSource })
  | (RetrievalIndexEventBase & { kind: "delete" })
  | (RetrievalIndexEventBase & { kind: "link-upsert"; link: KnowledgeLinkV1 })
  | (RetrievalIndexEventBase & { kind: "link-delete"; link: Pick<KnowledgeLinkV1, "relation" | "target"> })
  | (RetrievalIndexEventBase & { kind: "rebuild-barrier"; generation: number });

export interface RetrievalContractDiagnostic {
  code: "object" | "unknown-field" | "schema" | "field";
  pointer: string;
  message: string;
}

export type RetrievalCompileResult<T> =
  | { ok: true; value: T; diagnostics: [] }
  | { ok: false; diagnostics: RetrievalContractDiagnostic[] };

const CONTENT_TYPES = new Set<RetrievalContentType>(["skill", "note", "research", "script", "recipe", "action", "subscription"]);
const ROUTES = new Set<RetrievalRoute>(["lexical", "semantic", "dual", "graph", "hybrid"]);
const DIAGNOSTICS = new Set<RetrievalDiagnosticsLevel>(["none", "summary", "debug"]);
const SCORE_SEMANTICS = new Set<RetrievalScoreSemantics>(["rank-only", "similarity", "distance", "probability", "rrf", "engine-defined"]);
const RETRIEVAL_LEVELS = new Set<RetrievalLevel>(["l1-source", "l2-passage"]);

export function validRetrievalServingIdentity(value: unknown): value is RetrievalServingIdentityV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  const fields = ["providerId", "providerVersion", "route", "scoreSemantics", "architectureId", "modelId", "modelVersion", "packageId", "releaseId", "fallback"];
  const bounded = (item: unknown) => typeof item === "string" && item.length > 0 && item.length <= 512;
  return Object.keys(identity).every(key => fields.includes(key))
    && ["providerId", "providerVersion", "route"].every(key => bounded(identity[key]))
    && SCORE_SEMANTICS.has(identity.scoreSemantics as RetrievalScoreSemantics)
    && fields.slice(4).every(key => identity[key] === undefined || bounded(identity[key]));
}
const QUERY_FIELDS = new Set(["schema", "requestId", "text", "level", "contentTypeFilter", "scope", "topK", "route", "generation", "graph", "deadlineMs", "diagnostics"]);

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

export function compileRetrievalCapabilitiesV1(input: unknown): RetrievalCompileResult<RetrievalProviderCapabilitiesV1> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, diagnostics: [{ code: "object", pointer: "", message: "Expected a retrieval capabilities object." }] };
  }
  const value = input as Record<string, unknown>;
  const diagnostics: RetrievalContractDiagnostic[] = [];
  if (value.schema !== RETRIEVAL_CAPABILITIES_SCHEMA_V1) diagnostics.push({ code: "schema", pointer: "/schema", message: `Expected ${RETRIEVAL_CAPABILITIES_SCHEMA_V1}.` });
  if (!validRetrievalServingIdentity(value.provider)) {
    diagnostics.push({ code: "field", pointer: "/provider", message: "provider requires stable identity, version, route, and score semantics." });
  }
  for (const field of ["querySchemas", "resultSchemas", "levels", "sourceKinds", "routes", "scoreSemantics"] as const) {
    const entries = value[field];
    if (!Array.isArray(entries) || !entries.length || entries.some(entry => typeof entry !== "string" || !entry.trim())
      || new Set(entries).size !== entries.length
      || (field === "scoreSemantics" && entries.some(entry => !SCORE_SEMANTICS.has(entry as RetrievalScoreSemantics)))
      || (field === "levels" && entries.some(entry => !RETRIEVAL_LEVELS.has(entry as RetrievalLevel)))) {
      diagnostics.push({ code: "field", pointer: `/${field}`, message: `${field} must be a non-empty unique supported string list.` });
    }
  }
  const features = value.features as Record<string, unknown> | undefined;
  const featureNames = ["filters", "generations", "graph", "contentRanges", "refinement", "streaming"];
  if (!features || typeof features !== "object" || Array.isArray(features) || featureNames.some(name => typeof features[name] !== "boolean")) {
    diagnostics.push({ code: "field", pointer: "/features", message: "features must explicitly declare every standard feature." });
  }
  const limits = value.limits as Record<string, unknown> | undefined;
  if (!limits || typeof limits !== "object" || Array.isArray(limits)
    || !positiveInteger(limits.maxTopK) || !positiveInteger(limits.maxQueryCharacters) || !positiveInteger(limits.maxDeadlineMs)) {
    diagnostics.push({ code: "field", pointer: "/limits", message: "limits must contain positive maxTopK, maxQueryCharacters, and maxDeadlineMs values." });
  }
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value: input as RetrievalProviderCapabilitiesV1, diagnostics: [] };
}

export function sanitizeRetrievalCandidatesV1(
  input: unknown,
  options: { maxCandidates?: number; sourceIsCurrent?: (candidate: RetrievalCandidateV1) => boolean } = {},
): RetrievalCandidateSanitization {
  if (!Array.isArray(input)) {
    return { candidates: [], diagnostics: [{ code: "field", pointer: "", message: "Candidates must be an array." }], incomplete: true };
  }
  const limit = Math.max(1, Math.min(options.maxCandidates ?? 100, 100));
  const candidates: RetrievalCandidateV1[] = [];
  const diagnostics: RetrievalContractDiagnostic[] = [];
  const ids = new Set<string>();
  const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
  for (let index = 0; index < Math.min(input.length, 100) && candidates.length < limit; index++) {
    const value = input[index] as RetrievalCandidateV1;
    const pointer = `/${index}`;
    let message = "";
    if (!value || typeof value !== "object" || Array.isArray(value)) message = "Candidate must be an object.";
    else if (!bounded(value.id, 1024) || ids.has(value.id)) message = "Candidate ID must be bounded and unique.";
    else if (value.level !== undefined && !RETRIEVAL_LEVELS.has(value.level)) message = "Candidate retrieval level is unsupported.";
    else if (!bounded(value.kind, 64) || !bounded(value.label, 512) || !bounded(value.sourceUri, 2048)
      || !bounded(value.method, 128) || !bounded(value.reason, 1024)) message = "Candidate display and source fields must be bounded.";
    else if (!Number.isFinite(value.score) || value.rank !== undefined && !positiveInteger(value.rank)) message = "Candidate score must be finite and rank must be positive.";
    else if (value.scoreSemantics !== undefined && !SCORE_SEMANTICS.has(value.scoreSemantics)) message = "Candidate score semantics are unsupported.";
    else if (value.serving !== undefined && !validRetrievalServingIdentity(value.serving)) message = "Candidate serving identity is invalid.";
    else if (value.sourceId !== undefined && !bounded(value.sourceId, 1024)
      || value.sourceRevision !== undefined && !bounded(value.sourceRevision, 512)
      || value.contentHash !== undefined && !bounded(value.contentHash, 128)) message = "Candidate source provenance must be bounded.";
    else if (value.scoreComponents !== undefined && (!value.scoreComponents || typeof value.scoreComponents !== "object" || Array.isArray(value.scoreComponents)
      || Object.keys(value.scoreComponents).length > 16 || Object.values(value.scoreComponents).some(score => !Number.isFinite(score)))) {
      message = "Candidate score components must be bounded finite numbers.";
    } else if (value.content !== undefined && (typeof value.content !== "string" || value.content.length > 160_000)) message = "Candidate content exceeds the transport boundary.";
    else if (value.range !== undefined && (!value.range || !Number.isSafeInteger(value.range.start) || !Number.isSafeInteger(value.range.end)
      || value.range.start < 0 || value.range.end <= value.range.start || !["characters", "bytes", "lines"].includes(value.range.unit))) {
      message = "Candidate range must be a positive half-open range with an explicit unit.";
    } else if (value.offsetEncoding !== undefined && (value.offsetEncoding !== "utf16" || value.range?.unit !== "characters")) message = "UTF-16 offsets require a character range.";
    else if (value.contextIds !== undefined && (!Array.isArray(value.contextIds) || value.contextIds.length > 16
      || value.contextIds.some(id => !bounded(id, 1024) || id === value.id) || new Set(value.contextIds).size !== value.contextIds.length)) message = "Passage context IDs must be bounded and unique.";
    else if (value.level === "l2-passage" && (!bounded(value.parentId, 1024) || !bounded(value.parentRevision, 512)
      || !bounded(value.parentContentHash, 128) || !value.range)) message = "L2 candidates require immutable parent identity and a range.";
    else if (options.sourceIsCurrent && !options.sourceIsCurrent(value)) message = "Candidate source revision is stale or unavailable.";
    if (message) {
      diagnostics.push({ code: "field", pointer, message });
      continue;
    }
    ids.add(value.id);
    candidates.push(value);
  }
  if (input.length > limit) diagnostics.push({ code: "field", pointer: "", message: `Candidate list exceeded the ${limit}-item boundary.` });
  return { candidates, diagnostics, incomplete: diagnostics.length > 0 };
}

export function compileRetrievalQueryV1(input: unknown): RetrievalCompileResult<RetrievalQueryV1> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, diagnostics: [{ code: "object", pointer: "", message: "Expected a retrieval query object." }] };
  }
  const value = input as Record<string, unknown>;
  const diagnostics: RetrievalContractDiagnostic[] = [];
  for (const key of Object.keys(value).filter(key => !QUERY_FIELDS.has(key)).sort()) {
    diagnostics.push({ code: "unknown-field", pointer: `/${key}`, message: `Unknown field ${key}.` });
  }
  if (value.schema !== RETRIEVAL_QUERY_SCHEMA_V1) diagnostics.push({ code: "schema", pointer: "/schema", message: `Expected ${RETRIEVAL_QUERY_SCHEMA_V1}.` });
  if (!boundedText(value.requestId, 256)) diagnostics.push({ code: "field", pointer: "/requestId", message: "requestId must be nonempty text up to 256 characters." });
  if (!boundedText(value.text, 160_000)) diagnostics.push({ code: "field", pointer: "/text", message: "text must be nonempty text up to 160000 characters." });
  if (value.level !== undefined && !RETRIEVAL_LEVELS.has(value.level as RetrievalLevel)) diagnostics.push({ code: "field", pointer: "/level", message: "level must be l1-source or l2-passage." });
  if (!positiveInteger(value.topK) || Number(value.topK) > 100) diagnostics.push({ code: "field", pointer: "/topK", message: "topK must be between 1 and 100." });
  if (!ROUTES.has(value.route as RetrievalRoute)) diagnostics.push({ code: "field", pointer: "/route", message: "Unsupported retrieval route." });
  if (!DIAGNOSTICS.has(value.diagnostics as RetrievalDiagnosticsLevel)) diagnostics.push({ code: "field", pointer: "/diagnostics", message: "Unsupported diagnostics level." });
  if (value.contentTypeFilter !== undefined && (!Array.isArray(value.contentTypeFilter)
    || value.contentTypeFilter.some(type => !CONTENT_TYPES.has(type as RetrievalContentType))
    || new Set(value.contentTypeFilter).size !== value.contentTypeFilter.length)) {
    diagnostics.push({ code: "field", pointer: "/contentTypeFilter", message: "contentTypeFilter must contain supported content types." });
  }
  const scope = value.scope as Record<string, unknown> | undefined;
  if (!scope || typeof scope !== "object" || Array.isArray(scope) || !boundedText(scope.capabilityId, 256)
    || scope.includeReadOnly !== undefined && typeof scope.includeReadOnly !== "boolean"
    || (scope.sourceIds !== undefined && (!Array.isArray(scope.sourceIds) || scope.sourceIds.length > 10_000
      || scope.sourceIds.some(id => !boundedText(id, 1024)) || new Set(scope.sourceIds).size !== scope.sourceIds.length))) {
    diagnostics.push({ code: "field", pointer: "/scope", message: "scope requires capabilityId and optional sourceIds." });
  }
  const generation = value.generation as Record<string, unknown> | undefined;
  if (!generation || typeof generation !== "object" || Array.isArray(generation)
    || !["latest-ready", "exact", "minimum"].includes(String(generation.mode))
    || (generation.mode !== "latest-ready" && !positiveInteger(generation.generation))) {
    diagnostics.push({ code: "field", pointer: "/generation", message: "generation must select latest-ready, exact, or minimum." });
  }
  if (value.deadlineMs !== undefined && (!positiveInteger(value.deadlineMs) || Number(value.deadlineMs) > 300_000)) {
    diagnostics.push({ code: "field", pointer: "/deadlineMs", message: "deadlineMs must be between 1 and 300000." });
  }
  const graph = value.graph as Record<string, unknown> | undefined;
  if (value.graph !== undefined && (!graph || typeof graph !== "object" || Array.isArray(graph)
    || !positiveInteger(graph.maxDepth) || !positiveInteger(graph.maxNodes) || !positiveInteger(graph.maxEdges)
    || Number(graph.maxDepth) > 32 || Number(graph.maxNodes) > 10_000 || Number(graph.maxEdges) > 50_000
    || (graph.direction !== undefined && !["forward", "backlink", "both"].includes(String(graph.direction)))
    || (graph.relations !== undefined && (!Array.isArray(graph.relations) || graph.relations.some(relation => typeof relation !== "string"))))) {
    diagnostics.push({ code: "field", pointer: "/graph", message: "graph budgets or filters are invalid." });
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  return { ok: true, value: input as RetrievalQueryV1, diagnostics: [] };
}

export function compileRetrievalResultV1(input: unknown): RetrievalCompileResult<RetrievalResultV1> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, diagnostics: [{ code: "object", pointer: "", message: "Expected a retrieval result object." }] };
  }
  const value = input as Record<string, unknown>;
  const diagnostics: RetrievalContractDiagnostic[] = [];
  if (value.schema !== RETRIEVAL_RESULT_SCHEMA_V1) diagnostics.push({ code: "schema", pointer: "/schema", message: `Expected ${RETRIEVAL_RESULT_SCHEMA_V1}.` });
  if (value.ok !== true) diagnostics.push({ code: "field", pointer: "/ok", message: "A successful result must set ok to true." });
  if (!boundedText(value.requestId, 256)) diagnostics.push({ code: "field", pointer: "/requestId", message: "requestId must be bounded text." });
  if (!positiveInteger(value.readyGeneration)) diagnostics.push({ code: "field", pointer: "/readyGeneration", message: "readyGeneration must be positive." });
  if (!boundedText(value.corpusRevision, 512)) diagnostics.push({ code: "field", pointer: "/corpusRevision", message: "corpusRevision must be bounded text." });
  if (!ROUTES.has(value.route as RetrievalRoute)) diagnostics.push({ code: "field", pointer: "/route", message: "Unsupported retrieval route." });
  if (!Array.isArray(value.hits) || value.hits.length > 100) diagnostics.push({ code: "field", pointer: "/hits", message: "hits must be an array of at most 100 items." });
  if (value.semantic_status !== undefined && !["off", "ready", "unavailable", "fallback"].includes(String(value.semantic_status))) {
    diagnostics.push({ code: "field", pointer: "/semantic_status", message: "Unsupported semantic path status." });
  }
  if (value.search_mode !== undefined && (!["lexical", "semantic", "dual"].includes(String(value.search_mode))
    || (["lexical", "semantic", "dual"].includes(String(value.route)) && value.search_mode !== value.route))) {
    diagnostics.push({ code: "field", pointer: "/search_mode", message: "Search mode must match the requested path." });
  }
  const sourceIds = new Set<string>(), ranks = new Set<number>();
  if (Array.isArray(value.hits)) value.hits.forEach((hit, index) => {
    if (!hit || typeof hit !== "object" || Array.isArray(hit)) {
      diagnostics.push({ code: "field", pointer: `/hits/${index}`, message: "Hit must be an object." });
      return;
    }
    const record = hit as Record<string, unknown>;
    const scores = record.scoreComponents as Record<string, unknown> | undefined;
    if (record.serving !== undefined && !validRetrievalServingIdentity(record.serving)) {
      diagnostics.push({ code:"field", pointer:`/hits/${index}/serving`, message:"Hit serving identity is invalid." });
    }
    if (record.sources !== undefined || record.path_evidence !== undefined || record.source_label !== undefined) {
      const sources = record.sources, evidence = record.path_evidence;
      const expectedLabel = Array.isArray(sources) && sources.length === 2 ? "both"
        : Array.isArray(sources) && sources[0] === "lexical" ? "from keyword search" : "from embedding retrieval";
      if (!Array.isArray(sources) || !sources.length || sources.length > 2 || new Set(sources).size !== sources.length
        || sources.some(path => path !== "lexical" && path !== "semantic")
        || record.source_label !== expectedLabel || !Array.isArray(evidence) || evidence.length !== sources.length
        || new Set(evidence.map(entry => entry?.path)).size !== evidence.length
        || evidence.some(entry => !entry || !sources.includes(entry.path) || !positiveInteger(entry.rank)
          || !Number.isFinite(entry.score) || !boundedText(entry.matched_field, 256)
          || typeof entry.matched_path !== "string" || entry.matched_path.length > 2048
          || !["exact", "keyword", "fuzzy", "semantic"].includes(entry.match))
        || (record.score_semantics === "rrf" && Math.abs(Number(record.score)
          - evidence.reduce((total, entry) => total + 1 / (60 + entry.rank), 0)) > 1e-12)) {
        diagnostics.push({ code: "field", pointer: `/hits/${index}/path_evidence`, message: "Result labels and finite per-path evidence must agree; RRF scores must use ranks." });
      }
    }
    if (!positiveInteger(record.rank) || !Number.isFinite(record.score)
      || !boundedText(record.sourceId, 1024) || !boundedText(record.sourceRevision, 512)
      || typeof record.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(record.contentHash)
      || !boundedText(record.sourceUri, 2048)
      || !CONTENT_TYPES.has(record.contentType as RetrievalContentType)
      || typeof record.readOnly !== "boolean" || !ROUTES.has(record.route as RetrievalRoute)
      || typeof record.title !== "string" || typeof record.description !== "string"
      || !record.metadata || typeof record.metadata !== "object" || Array.isArray(record.metadata)
      || !record.provenance || typeof record.provenance !== "object" || Array.isArray(record.provenance)
      || sourceIds.has(record.sourceId as string) || ranks.has(record.rank as number)
      || !scores || ["lexical", "semantic", "graph", "priority"].some(key => !Number.isFinite(scores[key]))) {
      diagnostics.push({ code: "field", pointer: `/hits/${index}`, message: "Hit identity, type, rank, or score components are invalid." });
    }
    sourceIds.add(record.sourceId as string);
    ranks.add(record.rank as number);
  });
  if (!Array.isArray(value.diagnostics)) diagnostics.push({ code: "field", pointer: "/diagnostics", message: "diagnostics must be an array." });
  if (typeof value.stale !== "boolean" || typeof value.incomplete !== "boolean") {
    diagnostics.push({ code: "field", pointer: "/stale", message: "stale and incomplete must be booleans." });
  }
  const timings = value.timingsMs as Record<string, unknown> | undefined;
  if (!timings || ["wait", "search", "total"].some(key => typeof timings[key] !== "number" || !Number.isFinite(timings[key]) || Number(timings[key]) < 0)) {
    diagnostics.push({ code: "field", pointer: "/timingsMs", message: "timingsMs must contain non-negative wait, search, and total values." });
  }
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value: input as RetrievalResultV1, diagnostics: [] };
}

export function assertRetrievalResultForQuery(query: RetrievalQueryV1, input: unknown): RetrievalResultV1 {
  const compiledQuery = compileRetrievalQueryV1(query);
  if (!compiledQuery.ok) throw new Error(`Invalid retrieval query: ${compiledQuery.diagnostics.map(item => item.message).join("; ")}`);
  if (query.level === "l2-passage") throw new Error("This retrieval result contract contains L1 sources, not L2 passage ranges.");
  const compiled = compileRetrievalResultV1(input);
  if (!compiled.ok) throw new Error(`Invalid retrieval result: ${compiled.diagnostics.map(item => item.message).join("; ")}`);
  const result = compiled.value;
  if (result.requestId !== query.requestId) throw new Error("Retrieval result request identity does not match the original query.");
  if (result.route !== query.route || result.hits.some(hit => hit.route !== query.route)) throw new Error("Retrieval result requested route does not match the query.");
  if (result.stale || query.generation.mode === "exact" && result.readyGeneration !== query.generation.generation
    || query.generation.mode === "minimum" && result.readyGeneration < query.generation.generation) {
    throw new Error("Retrieval result generation is stale or does not satisfy the original generation policy.");
  }
  if (result.hits.length > query.topK) throw new Error("Retrieval result exceeds the requested topK boundary.");
  const sources = query.scope.sourceIds && new Set(query.scope.sourceIds);
  for (const hit of result.hits) {
    if (sources && !sources.has(hit.sourceId) || query.scope.includeReadOnly === false && hit.readOnly) {
      throw new Error("Retrieval result violates the original authorized source scope.");
    }
    // Subscription is a provenance filter; imported sources keep their concrete content type.
    const subscription = hit.provenance.provider === "broker" || hit.sourceUri.startsWith("pkm://subscriptions/");
    if (query.contentTypeFilter?.length && !query.contentTypeFilter.includes(hit.contentType)
      && !(query.contentTypeFilter.includes("subscription") && subscription)) {
      throw new Error("Retrieval result content type does not satisfy the original filter.");
    }
  }
  return result;
}

export function assertRetrievalIndexEventV1(input: unknown): RetrievalIndexEventV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Index event must be an object.");
  const value = input as Record<string, unknown>;
  if (value.schema !== RETRIEVAL_INDEX_EVENT_SCHEMA_V1) throw new Error(`Index event schema must be ${RETRIEVAL_INDEX_EVENT_SCHEMA_V1}.`);
  if (!String(value.eventId || "").trim() || !String(value.sourceId || "").trim() || !String(value.sourceRevision || "").trim()) {
    throw new Error("Index event requires eventId, sourceId, and sourceRevision.");
  }
  if (!["upsert", "delete", "link-upsert", "link-delete", "rebuild-barrier"].includes(String(value.kind))) {
    throw new Error(`Unsupported index event kind ${String(value.kind)}.`);
  }
  if (value.kind === "upsert" && (!value.source || typeof value.source !== "object")) throw new Error("Upsert event requires source.");
  if (value.kind === "upsert") {
    const source = value.source as Record<string, unknown>;
    if (source.sourceId !== value.sourceId || source.sourceRevision !== value.sourceRevision) {
      throw new Error("Upsert source identity and revision must match the event.");
    }
    if (!String(source.contentHash || "").trim() || !String(source.sourceUri || "").trim()
      || !CONTENT_TYPES.has(source.contentType as RetrievalContentType)) {
      throw new Error("Upsert source requires content hash, URI, and supported content type.");
    }
  }
  if ((value.kind === "link-upsert" || value.kind === "link-delete") && (!value.link || typeof value.link !== "object")) {
    throw new Error(`${String(value.kind)} event requires link.`);
  }
  if (value.kind === "link-upsert") {
    const compiled = compileKnowledgeLinksV1([value.link]);
    if (!compiled.ok) throw new Error(`Invalid link-upsert event: ${compiled.diagnostics.map(item => item.message).join("; ")}`);
  }
  if (value.kind === "link-delete") {
    const link = value.link as Record<string, unknown>;
    const compiled = compileKnowledgeLinksV1([{
      relation: link.relation,
      target: link.target,
      mode: "floating",
      required: false,
    }]);
    if (!compiled.ok) throw new Error(`Invalid link-delete event: ${compiled.diagnostics.map(item => item.message).join("; ")}`);
  }
  if (value.kind === "rebuild-barrier" && !positiveInteger(value.generation)) throw new Error("Rebuild barrier requires a positive generation.");
  return input as RetrievalIndexEventV1;
}
