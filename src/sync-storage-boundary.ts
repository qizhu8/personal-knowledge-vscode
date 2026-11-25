import { githubSyncIgnoredPath as originalIgnoredPath } from "./domain/sync-plan-original.js";
export { githubSyncSafeRelativePath } from "./domain/sync-plan-original.js";

/** Root-only storage ownership; nested user files named runtime/server-data remain user content. */
export function githubSyncIgnoredPath(relative: string): boolean {
  const first = relative.replaceAll("\\", "/").normalize("NFC").toLowerCase().split("/")[0] ?? "";
  return first === "server-data" || first === "runtime" || first === "runtime-control" || first.startsWith(".pkm-") && first !== ".pkm-github-sync.json"
    || /^(?:core|coding-process)\.sqlite(?:-|$)/.test(first) || originalIgnoredPath(relative);
}
