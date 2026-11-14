import { planSync, syncPlanHash } from "./sync-plan.js";
import { syncPlanInputSchema, type SyncManifest, type SyncPlanInput } from "./sync-plan-contracts.js";

/**
 * Project an already-authorized Skills selection onto the native planner.
 * Unselected Skills and other types follow the exact remote state on all
 * three sides, preventing local apply actions or publication deletions.
 *
 * This does not interpret legacy selections, grant privacy authority, execute
 * a transport, or prove that the original snapshots are still current.
 */
export function projectSkillsOnlySyncInput(raw: unknown, selected: (member: SyncManifest["files"][number] | SyncManifest["deletions"][number]) => boolean = () => true): {
  input: SyncPlanInput;
  sourcePins: { base: string; local: string; remote: string };
} {
  const original = syncPlanInputSchema.parse(raw);
  planSync(original);
  const remote = original.remote.manifest;
  const selections = new Map<string, boolean>();
  for (const snapshot of [original.base, original.local, original.remote]) {
    for (const member of [...snapshot.manifest.files, ...snapshot.manifest.deletions]) {
      if (member.type !== "skills") continue;
      const choice = selected(member), prior = selections.get(member.itemId);
      if (prior !== undefined && prior !== choice)
        throw new Error("Skills selection changed across versions of an entity; review is required.");
      selections.set(member.itemId, choice);
    }
  }
  const included = (member: { itemId: string }) => selections.get(member.itemId) === true;
  function project(manifest: SyncManifest): SyncManifest {
    const required = [...new Set([...manifest.capabilities.required, ...remote.capabilities.required])];
    return {
      ...manifest,
      capabilities: { ...manifest.capabilities, required },
      files: [...manifest.files.filter(file => file.type === "skills" && included(file)),
        ...remote.files.filter(file => file.type !== "skills" || !included(file))],
      deletions: [...manifest.deletions.filter(file => file.type === "skills" && included(file)),
        ...remote.deletions.filter(file => file.type !== "skills" || !included(file))],
    };
  }
  const base = project(original.base.manifest);
  const local = project(original.local.manifest);
  const input = {
    base: { manifest: base, sha256: syncPlanHash(base) },
    local: { manifest: local, sha256: syncPlanHash(local) },
    remote: original.remote,
  };
  planSync(input);
  return {
    input,
    sourcePins: { base: original.base.sha256, local: original.local.sha256, remote: original.remote.sha256 },
  };
}
