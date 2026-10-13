import { isMainThread, parentPort, Worker, workerData } from "worker_threads";
import { GitHubSyncCatalog, GitHubSyncTarget, githubSyncTargetFingerprintState, githubSyncExcludedPaths } from "./github-sync";

type FingerprintState = ReturnType<typeof githubSyncTargetFingerprintState>;

export function githubSyncFingerprintInWorker(target: GitHubSyncTarget, catalog: GitHubSyncCatalog, storeRoot?: string): Promise<FingerprintState> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { target, catalog, storeRoot } });
    worker.once("message", (result: FingerprintState | { error: string }) => {
      if ("error" in result) reject(new Error(result.error));
      else resolve(result);
    });
    worker.once("error", reject);
    worker.once("exit", code => {
      if (code !== 0) reject(new Error(`GitHub Sync fingerprint worker exited with code ${code}.`));
      else reject(new Error("GitHub Sync fingerprint worker exited without a result."));
    });
  });
}

if (!isMainThread) {
  const { target, catalog, storeRoot } = workerData as { target: GitHubSyncTarget; catalog: GitHubSyncCatalog; storeRoot?: string };
  const initial = githubSyncTargetFingerprintState(target, catalog);
  const paths = Object.values(initial.files).flatMap(files => Object.keys(files));
  githubSyncExcludedPaths(storeRoot || target.lastSync?.storeRoot, paths).then(excluded => {
    parentPort!.postMessage(excluded.size ? githubSyncTargetFingerprintState(target, catalog, excluded) : initial);
  }, error => {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
  });
}