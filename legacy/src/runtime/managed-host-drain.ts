import { HostWriterAdmission } from "./host-writer-admission";
import { RetrievalWorkerManager } from "../retrieval/retrieval-worker";

/** Drain this host's enrolled work; this is not a census of other writers. */
export async function drainManagedHost(
  host: HostWriterAdmission | undefined,
  drainChat: () => Promise<void>,
  retrieval: RetrievalWorkerManager | undefined,
): Promise<void> {
  const results = await Promise.allSettled([
    host ? host.drain() : Promise.reject(new Error("Host writer observation is unavailable.")),
    Promise.resolve().then(drainChat),
    retrieval ? retrieval.quiesceLocal() : Promise.resolve(),
  ]);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
}
