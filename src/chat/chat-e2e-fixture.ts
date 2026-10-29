import { createHash } from "crypto";
import type { ChatKnowledgeRetriever } from "./chat-retrieval";
import { indexedRetrievalDocument, materializeRetrievalCandidates, retrievalDocumentContentHash,
  retrievalDocumentForSource, retrievalSourceValidation, type RetrievalDocument } from "../retrieval/retrieval-snapshot";

export function createChatE2eFixture(): { retrieve:ChatKnowledgeRetriever; expected:string[] } {
  const body = "# Synthetic benchmark\n\nCPU-only. No deployment is approved.\n\n## Conditions\n\nConcurrency=32; latency unit is milliseconds.\n\n## Background\n\n"
    + "Unrelated synthetic background.\n\n".repeat(6000)
    + "## Results\n\nFor fixture-beta, the maximum p99 latency is 125 ms, NOT 250 ms.\n";
  const document:RetrievalDocument = {
    skill_id:"note:e2e-synthetic", source_id:"pkm://notes/e2e-synthetic",
    source_revision:createHash("sha256").update(body).digest("hex"), title:"Synthetic benchmark",
    description:"Non-sensitive E2E fixture", body, content_type:"note",
    source_uri:"pkm://notes/e2e-synthetic", metadata:{}, provenance:{ provider:"pkm-e2e-fixture" },
    read_only:true, visibility:"available", links:[],
  };
  const snapshot = { corpus_revision:document.source_revision, documents:[document] };
  const validation = retrievalSourceValidation(() => snapshot);
  const retrieve:ChatKnowledgeRetriever = Object.assign(async (_query:string, signal:AbortSignal) => {
    if (signal.aborted) throw new Error("E2E retrieval cancelled.");
    const indexed = indexedRetrievalDocument(document);
    const parent = { id:indexed.source_id, sourceId:indexed.source_id, sourceRevision:indexed.source_revision,
      contentHash:retrievalDocumentContentHash(indexed), kind:indexed.content_type, label:indexed.title,
      sourceUri:indexed.source_uri, level:"l1-source" as const, score:1, method:"rule:e2e-fixture",
      reason:"Explicit synthetic fixture only", selected:false };
    validation.admit(parent, retrievalDocumentForSource(snapshot, parent.sourceId, parent.sourceRevision, parent.contentHash)!);
    return materializeRetrievalCandidates([parent], snapshot, "fixture-beta latency");
  }, { ...validation, readSnapshot:() => snapshot });
  return { retrieve, expected:["125", "32", "CPU", "NOT_APPROVED"] };
}
