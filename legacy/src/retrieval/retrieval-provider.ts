import {
  sanitizeRetrievalCandidatesV1,
  type RetrievalCandidateV1,
  type RetrievalContractDiagnostic,
} from "./retrieval-contracts";

export interface GuardedRetrievalResult {
  status: "ok" | "degraded" | "unavailable";
  candidates: RetrievalCandidateV1[];
  diagnostics: RetrievalContractDiagnostic[];
  warning?: string;
}

export async function guardRetrievalCandidates(
  retrieve: (signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
  options: {
    deadlineMs?: number;
    maxCandidates?: number;
    sourceIsCurrent?: (candidate: RetrievalCandidateV1) => boolean;
  } = {},
): Promise<GuardedRetrievalResult> {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Retrieval cancelled.");
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  const deadlineMs = Math.max(1, Math.min(options.deadlineMs ?? 5_000, 300_000));
  let timer: NodeJS.Timeout | undefined;
  let rejectCancellation: (() => void) | undefined;
  try {
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Retrieval cancelled."));
      signal.addEventListener("abort", rejectCancellation, { once: true });
      if (signal.aborted) rejectCancellation();
    });
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Retrieval exceeded its ${deadlineMs} ms deadline.`);
        controller.abort(error);
        reject(error);
      }, deadlineMs);
    });
    const raw = await Promise.race([retrieve(controller.signal), timeout, cancellation]);
    const sanitized = sanitizeRetrievalCandidatesV1(raw, options);
    return {
      status: sanitized.incomplete ? "degraded" : "ok",
      candidates: sanitized.candidates,
      diagnostics: sanitized.diagnostics,
      ...(sanitized.incomplete ? { warning: "Some retrieval candidates were rejected by the PKM contract." } : {}),
    };
  } catch (error) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Retrieval cancelled.");
    return {
      status: "unavailable",
      candidates: [],
      diagnostics: [{ code: "field", pointer: "", message: "Retrieval provider failed or exceeded its deadline." }],
      warning: (error instanceof Error ? error.message : "Retrieval provider failed.").slice(0, 1024),
    };
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    if (rejectCancellation) signal.removeEventListener("abort", rejectCancellation);
  }
}
