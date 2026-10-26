import { randomUUID } from "crypto";
import type { RetrievalWorkerManager } from "../retrieval/retrieval-worker";
import { sanitizeRetrievalCandidatesV1 } from "../retrieval/retrieval-contracts";
import { materializeRetrievalCandidates, materializeRetrievalSource, retrievalDocumentForSource,
  retrievalSourceValidation, type RetrievalSnapshot } from "../retrieval/retrieval-snapshot";
import { validChatRetrievalInvocation, type ChatKnowledgeRetriever, type ChatRetrievalCandidate } from "./chat-retrieval";

export function createChatKnowledgeRetriever(
  worker: () => Pick<RetrievalWorkerManager, "query" | "submitFeedback"> | undefined,
  readSnapshot: () => RetrievalSnapshot,
): ChatKnowledgeRetriever {
  const validation = retrievalSourceValidation(readSnapshot);
  return Object.assign(async (query: string, signal: AbortSignal) => {
    const current = worker();
    if (!current) throw new Error("The unified retrieval worker is not ready.");
    const result = await current.query({ schema: "pkm.retrieval.query/v1", requestId: `chat-${randomUUID()}`, text: query,
      level: "l1-source", scope: { capabilityId: "pkm-chat-context" }, topK: 20, route: "dual",
      generation: { mode: "latest-ready" }, diagnostics: "summary", deadlineMs: 5000 }, signal);
    if (signal.aborted) throw new Error("Retrieval cancelled.");
    if (!result.semantic_status || typeof result.model_invoked !== "boolean") throw new Error("The retrieval worker omitted its semantic/model invocation status.");
    const snapshot = readSnapshot();
    const candidates = result.hits.map<ChatRetrievalCandidate>(hit => {
      const document = retrievalDocumentForSource(snapshot, hit.sourceId, hit.sourceRevision, hit.contentHash);
      const candidate: ChatRetrievalCandidate = {
        id: hit.sourceId, level: "l1-source", kind: hit.contentType, label: hit.title, sourceUri: hit.sourceUri, score: hit.score,
        scoreSemantics: "engine-defined", scoreComponents: { ...hit.scoreComponents },
        method: `${hit.serving?.route || hit.route}:unified-retrieval`, serving: hit.serving, selected: false,
        sourceId: hit.sourceId, sourceRevision: hit.sourceRevision, contentHash: hit.contentHash, rank: hit.rank,
        ...materializeRetrievalSource(document),
      };
      if (document) validation.admit(candidate, document);
      return candidate;
    });
    const materialized = sanitizeRetrievalCandidatesV1(materializeRetrievalCandidates(candidates, snapshot, query), {
      maxCandidates: 100,
      sourceIsCurrent: candidate => !!retrievalDocumentForSource(snapshot, candidate.sourceId!,
        (candidate.parentRevision || candidate.sourceRevision)!, candidate.parentContentHash || candidate.contentHash),
    });
    if (materialized.incomplete) throw new Error(`Knowledge materialization rejected stale or invalid evidence: ${materialized.diagnostics.map(item => item.message).join(" ").slice(0, 768)}`);
    const invocation = {
      requestId: result.requestId, requestedRoute: "dual",
      servedRoute: [...new Set(result.hits.map(hit => hit.serving?.route).filter(Boolean))].join("+")
        || (result.semantic_status === "ready" ? "dual" : "lexical"),
      semanticStatus: result.semantic_status, modelInvoked: result.model_invoked,
      readyGeneration: result.readyGeneration, corpusRevision: result.corpusRevision,
      ...(result.retrieval_id ? { retrievalId: result.retrieval_id } : {}),
      ...(result.adaptive ? { adaptive: result.adaptive } : {}),
      ...(result.semantic_reason || result.learning_error ? { reason: [result.semantic_reason, result.learning_error].filter(Boolean).join("; ").slice(0, 1024) } : {}),
    };
    if (!validChatRetrievalInvocation(invocation)) throw new Error("The retrieval worker returned invalid Chat invocation metadata.");
    return { candidates: materialized.candidates, invocation };
  }, {
    ...validation, readSnapshot,
    feedback: async (retrievalId: string, relevantSourceIds: string[]) => {
      const current = worker();
      if (!current) throw new Error("The unified retrieval worker is not ready.");
      return current.submitFeedback(retrievalId, relevantSourceIds);
    },
  });
}
