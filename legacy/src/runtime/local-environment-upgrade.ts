import * as fs from "fs";
import * as path from "path";
import { LocalEnvironmentCatalog, inspectLocalEnvironment } from "./local-environment-catalog";

export interface EnvironmentUpgradeReport {
  state: "disabled" | "no-legacy-profile" | "migrated" | "already-migrated" | "repair-required";
  revision: number;
  sourceDigest?: string;
  environments: { id: string; available: boolean; issues: string[] }[];
}

/** Automatic metadata discovery only; execution still requires the existing host approval. */
export function upgradeLocalEnvironmentProfile(storage: string, enabled: boolean, trusted: boolean): EnvironmentUpgradeReport {
  const empty = { revision: 0, environments: [] };
  if (!enabled) return { state: "disabled", ...empty };
  if (!trusted) throw new Error("Automatic environment upgrade requires a trusted profile workspace; nothing was imported.");
  if (!path.isAbsolute(storage) || path.resolve(storage) !== storage)
    throw new Error("Environment profile storage must be a canonical absolute path.");
  if (!fs.existsSync(storage)) return { state: "no-legacy-profile", ...empty };
  if (fs.realpathSync(storage) !== storage || !fs.lstatSync(storage).isDirectory())
    throw new Error("Environment profile storage must not be a symlink.");
  const registry = path.join(storage, "environments", "registry.json");
  const store = new LocalEnvironmentCatalog(path.join(storage, "next-local-environments"));
  const current = store.read();
  try { fs.lstatSync(registry); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (current.catalog.legacyImports.length) throw new Error("Previously migrated legacy registry is missing; existing catalog kept, no automatic repair.");
    return { state: "no-legacy-profile", revision: current.catalog.revision, environments: [] };
  }
  const preview = store.previewLegacy(registry);
  const previous = current.catalog.legacyImports.includes(preview.sourceDigest);
  if (!previous && current.catalog.legacyImports.length)
    throw new Error("Legacy profile registry changed after migration; existing catalog kept, no automatic overwrite or re-import.");
  const migrated = store.importLegacy(registry, preview.sourceDigest, current.digest);
  const environments = migrated.catalog.entries.filter(entry => preview.entries.some(item => item.id === entry.id))
    .map(entry => ({ id: entry.id, ...inspectLocalEnvironment(entry) }));
  return {
    state: environments.some(entry => !entry.available) ? "repair-required" : previous ? "already-migrated" : "migrated",
    revision: migrated.catalog.revision, sourceDigest: preview.sourceDigest, environments,
  };
}
