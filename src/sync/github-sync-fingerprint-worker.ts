import { isMainThread, parentPort, Worker, workerData } from "worker_threads";
import { GitHubSyncCatalog, GitHubSyncFolderFingerprints, GitHubSyncTarget, githubSyncTargetFingerprintState, GitHubSyncContentType } from "./github-sync";

type FingerprintState = {
  fingerprints: Record<GitHubSyncContentType, string>;
  folders: GitHubSyncFolderFingerprints;
  files: GitHubSyncFolderFingerprints;
};

export function githubSyncFingerprintInWorker(target: GitHubSyncTarget, catalog: GitHubSyncCatalog): Promise<FingerprintState> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { target, catalog } });
    worker.once("message", (result: FingerprintState) => resolve(result));
    worker.once("error", reject);
    worker.once("exit", code => {
      if (code !== 0) reject(new Error(`GitHub Sync fingerprint worker exited with code ${code}.`));
      else reject(new Error("GitHub Sync fingerprint worker exited without a result."));
    });
  });
}

if (!isMainThread) {
  const { target, catalog } = workerData as { target: GitHubSyncTarget; catalog: GitHubSyncCatalog };
  parentPort!.postMessage(githubSyncTargetFingerprintState(target, catalog));
}