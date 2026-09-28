import { compileKnowledgeLinksV1, type KnowledgeLinkV1 } from "./knowledge-contracts";

export const RETRIEVAL_QUERY_SCHEMA_V1 = "pkm.retrieval.query/v1" as const;
export const RETRIEVAL_RESULT_SCHEMA_V1 = "pkm.retrieval.result/v1" as const;
export const RETRIEVAL_INDEX_EVENT_SCHEMA_V1 = "pkm.retrieval.index-event/v1" as const;

export type RetrievalContentType = "skill" | "note" | "research" | "script" | "recipe" | "subscription";
export type RetrievalRoute = "lexical" | "semantic" | "graph" | "hybrid";
export type RetrievalDiagnosticsLevel = "none" | "summary" | "debug";
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
  contentTypeFilter?: RetrievalContentType[];
  scope: RetrievalCapabilityScope;
  topK: number;
  route: RetrievalRoute;
  generation: RetrievalGenerationPolicy;
  graph?: RetrievalGraphBudget;
  deadlineMs?: number;
  diagnostics: RetrievalDiagnosticsLevel;
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

const CONTENT_TYPES = new Set<RetrievalContentType>(["skill", "note", "research", "script", "recipe", "subscription"]);
const ROUTES = new Set<RetrievalRoute>(["lexical", "semantic", "graph", "hybrid"]);
const DIAGNOSTICS = new Set<RetrievalDiagnosticsLevel>(["none", "summary", "debug"]);
const QUERY_FIELDS = new Set(["schema", "requestId", "text", "contentTypeFilter", "scope", "topK", "route", "generation", "graph", "deadlineMs", "diagnostics"]);

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
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
  if (!Array.isArray(value.hits)) diagnostics.push({ code: "field", pointer: "/hits", message: "hits must be an array." });
  else value.hits.forEach((hit, index) => {
    if (!hit || typeof hit !== "object" || Array.isArray(hit)) {
      diagnostics.push({ code: "field", pointer: `/hits/${index}`, message: "Hit must be an object." });
      return;
    }
    const record = hit as Record<string, unknown>;
    const scores = record.scoreComponents as Record<string, unknown> | undefined;
    if (!positiveInteger(record.rank) || typeof record.score !== "number"
      || !String(record.sourceId || "") || !String(record.sourceRevision || "")
      || !CONTENT_TYPES.has(record.contentType as RetrievalContentType)
      || !scores || ["lexical", "semantic", "graph", "priority"].some(key => typeof scores[key] !== "number")) {
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
