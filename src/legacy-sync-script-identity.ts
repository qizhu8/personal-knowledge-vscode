import { createRequire } from "node:module";
type Identity = { schema: "pkm.script/v1"; knowledgeId: string; aliases: string[] };
type OriginalIdentity = {
  readSyncScriptIdentity(bytes: Buffer): Identity;
  syncScriptSidecarPath(body: string): string;
};
let original: OriginalIdentity | undefined;
/** Pure original identity parsing only; no catalog worker, Script execution or sidecar creation. */
export function legacySyncScriptIdentity(): OriginalIdentity {
  original ??= createRequire(import.meta.url)("../legacy/dist/sync/github-sync-script-identity.js") as OriginalIdentity;
  if (typeof original.readSyncScriptIdentity !== "function" || typeof original.syncScriptSidecarPath !== "function")
    throw new Error("Original Script identity parser is unavailable.");
  return original;
}
