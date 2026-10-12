import { compileKnowledgeLinksV1, type KnowledgeLinkV1 } from "../knowledge/knowledge-contracts";

export const RETRIEVAL_QUERY_SCHEMA_V1 = "pkm.retrieval.query/v1" as const;
export const RETRIEVAL_RESULT_SCHEMA_V1 = "pkm.retrieval.result/v1" as const;
export const RETRIEVAL_INDEX_EVENT_SCHEMA_V1 = "pkm.retrieval.index-event/v1" as const;
export const RETRIEVAL_CAPABILITIES_SCHEMA_V1 = "pkm.retrieval.capabilities/v1" as const;
export const RETRIEVAL_SELECTION_RECEIPT_SCHEMA_V1 = "pkm.retrieval.selection-receipt/v1" as const;

export type RetrievalContentType = "skill" | "note" | "research" | "script" | "recipe" | "action" | "subscription";
export type RetrievalRoute = "lexical" | "semantic" | "graph" | "hybrid";
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

export interface RetrievalResultHitV1 {
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
  metadata: Record<string, string>;
  provenance: Record<string, unknown>;
}

export interface RetrievalResultV1 {
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
const ROUTES = new Set<RetrievalRoute>(["lexical", "semantic", "graph", "hybrid"]);
const DIAGNOSTICS = new Set<RetrievalDiagnosticsLevel>(["none", "summary", "debug"]);
const SCORE_SEMANTICS = new Set<RetrievalScoreSemantics>(["rank-only", "similarity", "distance", "probability", "rrf", "engine-defined"]);
const RETRIEVAL_LEVELS = new Set<RetrievalLevel>(["l1-source", "l2-passage"]);
const QUERY_FIELDS = new Set(["schema", "requestId", "text", "level", "contentTypeFilter", "scope", "topK", "route", "generation", "graph", "deadlineMs", "diagnostics"]);

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function compileRetrievalCapabilitiesV1(input: unknown): RetrievalCompileResult<RetrievalProviderCapabilitiesV1> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, diagnostics: [{ code: "object", pointer: "", message: "Expected a retrieval capabilities object." }] };
  }
  const value = input as Record<string, unknown>;
  const diagnostics: RetrievalContractDiagnostic[] = [];
  if (value.schema !== RETRIEVAL_CAPABILITIES_SCHEMA_V1) diagnostics.push({ code: "schema", pointer: "/schema", message: `Expected ${RETRIEVAL_CAPABILITIES_SCHEMA_V1}.` });
  const provider = value.provider as Record<string, unknown> | undefined;
  if (!provider || typeof provider !== "object" || Array.isArray(provider)
    || !String(provider.providerId || "").trim() || !String(provider.providerVersion || "").trim()
    || !String(provider.route || "").trim() || !SCORE_SEMANTICS.has(provider.scoreSemantics as RetrievalScoreSemantics)) {
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
    else if (value.scoreComponents !== undefined && (!value.scoreComponents || typeof value.scoreComponents !== "object" || Array.isArray(value.scoreComponents)
      || Object.keys(value.scoreComponents).length > 16 || Object.values(value.scoreComponents).some(score => !Number.isFinite(score)))) {
      message = "Candidate score components must be bounded finite numbers.";
    } else if (value.content !== undefined && (typeof value.content !== "string" || value.content.length > 160_000)) message = "Candidate content exceeds the transport boundary.";
    else if (value.range !== undefined && (!value.range || !Number.isSafeInteger(value.range.start) || !Number.isSafeInteger(value.range.end)
      || value.range.start < 0 || value.range.end <= value.range.start || !["characters", "bytes", "lines"].includes(value.range.unit))) {
      message = "Candidate range must be a positive half-open range with an explicit unit.";
    } else if (value.level === "l2-passage" && (!bounded(value.parentId, 1024) || !bounded(value.parentRevision, 512)
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
  if (!String(value.requestId || "").trim()) diagnostics.push({ code: "field", pointer: "/requestId", message: "requestId is required." });
  if (!String(value.text || "").trim()) diagnostics.push({ code: "field", pointer: "/text", message: "text is required." });
  if (value.level !== undefined && !RETRIEVAL_LEVELS.has(value.level as RetrievalLevel)) diagnostics.push({ code: "field", pointer: "/level", message: "level must be l1-source or l2-passage." });
  if (!positiveInteger(value.topK) || Number(value.topK) > 100) diagnostics.push({ code: "field", pointer: "/topK", message: "topK must be between 1 and 100." });
  if (!ROUTES.has(value.route as RetrievalRoute)) diagnostics.push({ code: "field", pointer: "/route", message: "Unsupported retrieval route." });
  if (!DIAGNOSTICS.has(value.diagnostics as RetrievalDiagnosticsLevel)) diagnostics.push({ code: "field", pointer: "/diagnostics", message: "Unsupported diagnostics level." });
  if (value.contentTypeFilter !== undefined && (!Array.isArray(value.contentTypeFilter)
    || value.contentTypeFilter.some(type => !CONTENT_TYPES.has(type as RetrievalContentType)))) {
    diagnostics.push({ code: "field", pointer: "/contentTypeFilter", message: "contentTypeFilter must contain supported content types." });
  }
  const scope = value.scope as Record<string, unknown> | undefined;
  if (!scope || typeof scope !== "object" || Array.isArray(scope) || !String(scope.capabilityId || "").trim()
    || (scope.sourceIds !== undefined && (!Array.isArray(scope.sourceIds) || scope.sourceIds.some(id => typeof id !== "string")))) {
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
  if (graph && (!positiveInteger(graph.maxDepth) || !positiveInteger(graph.maxNodes) || !positiveInteger(graph.maxEdges)
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
  if (!String(value.requestId || "").trim()) diagnostics.push({ code: "field", pointer: "/requestId", message: "requestId is required." });
  if (!positiveInteger(value.readyGeneration)) diagnostics.push({ code: "field", pointer: "/readyGeneration", message: "readyGeneration must be positive." });
  if (!String(value.corpusRevision || "").trim()) diagnostics.push({ code: "field", pointer: "/corpusRevision", message: "corpusRevision is required." });
  if (!ROUTES.has(value.route as RetrievalRoute)) diagnostics.push({ code: "field", pointer: "/route", message: "Unsupported retrieval route." });
  if (!Array.isArray(value.hits) || value.hits.length > 100) diagnostics.push({ code: "field", pointer: "/hits", message: "hits must be an array of at most 100 items." });
  else value.hits.forEach((hit, index) => {
    if (!hit || typeof hit !== "object" || Array.isArray(hit)) {
      diagnostics.push({ code: "field", pointer: `/hits/${index}`, message: "Hit must be an object." });
      return;
    }
    const record = hit as Record<string, unknown>;
    const scores = record.scoreComponents as Record<string, unknown> | undefined;
    if (!positiveInteger(record.rank) || !Number.isFinite(record.score)
      || !String(record.sourceId || "") || !String(record.sourceRevision || "")
      || !String(record.contentHash || "") || !String(record.sourceUri || "")
      || !CONTENT_TYPES.has(record.contentType as RetrievalContentType)
      || !scores || ["lexical", "semantic", "graph", "priority"].some(key => !Number.isFinite(scores[key]))) {
      diagnostics.push({ code: "field", pointer: `/hits/${index}`, message: "Hit identity, type, rank, or score components are invalid." });
    }
  });
  if (!Array.isArray(value.diagnostics)) diagnostics.push({ code: "field", pointer: "/diagnostics", message: "diagnostics must be an array." });
  if (typeof value.stale !== "boolean" || typeof value.incomplete !== "boolean") {
    diagnostics.push({ code: "field", pointer: "/stale", message: "stale and incomplete must be booleans." });
  }
  const timings = value.timingsMs as Record<string, unknown> | undefined;
  if (!timings || ["wait", "search", "total"].some(key => typeof timings[key] !== "number" || Number(timings[key]) < 0)) {
    diagnostics.push({ code: "field", pointer: "/timingsMs", message: "timingsMs must contain non-negative wait, search, and total values." });
  }
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value: input as RetrievalResultV1, diagnostics: [] };
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
