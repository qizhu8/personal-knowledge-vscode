import { z } from "zod";
import { createHash } from "node:crypto";
import { resourcePath } from "./document-path.js";

export const legacyCodeAreas = ["packages", "actions", "components", "action-module-sets"] as const;
export const legacyLibraryAreas = ["prompts", "scripts", ...legacyCodeAreas, "action-state"] as const;
export const legacyCodeArchive = "legacy-code-archive";
export const legacySkillsHistoryArchive = `${legacyCodeArchive}/skills-history`;
export const legacyActionStateRoot = ".pkm/state/actions";
export const legacySkillsHistoryArchiveSchema = z.strictObject({
  schema: z.literal("pkm.legacy-skills-history-archive/v1"),
  disposition: z.literal("opaque-inert-history"),
  fileCount: z.number().int().nonnegative(),
  directoryCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  inventorySha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type LegacySkillsHistoryArchive = z.infer<typeof legacySkillsHistoryArchiveSchema>;

export interface LegacySkillsHistoryEntry {
  source: string;
  destination?: string;
  kind: "directory" | "document" | "asset" | "board-backing";
  size?: number;
  sha256?: string;
  mode?: number;
}

export function isLegacySkillsHistoryPath(path: string, kind: "file" | "directory" = "file"): boolean {
  const parts = path.startsWith("skills/") ? path.slice("skills/".length).split("/") : [];
  if (parts.includes(".trash")) return true;
  if (kind !== "file" || !path.startsWith("skills/")) return false;
  if (parts.some(part => part === "_assets" || /\.assets$/i.test(part))
    || parts.slice(0, -1).some(part => part.startsWith("."))) return false;
  const name = parts.at(-1)!;
  return name === ".gitkeep" || !name.startsWith(".") && !/\.md$/i.test(name);
}

export function isLegacySkillsHistoryArchivePath(path: string): boolean {
  return path === legacySkillsHistoryArchive
    || path === `${legacySkillsHistoryArchive}/skills`
    || path.startsWith(`${legacySkillsHistoryArchive}/skills/`);
}

export function describeLegacySkillsHistoryArchive(entries: readonly LegacySkillsHistoryEntry[]): LegacySkillsHistoryArchive | undefined {
  const archiveEntries = entries.filter(entry => entry.destination !== undefined
    && isLegacySkillsHistoryArchivePath(entry.destination) && entry.destination !== legacySkillsHistoryArchive);
  if (!archiveEntries.length) return undefined;
  const destinations = new Set<string>();
  const inventory = archiveEntries.map(entry => {
    if (!(entry.source === "skills" || entry.source.startsWith("skills/"))
      || entry.destination !== `${legacySkillsHistoryArchive}/${entry.source}`
      || (entry.kind !== "directory" && entry.kind !== "asset") || destinations.has(entry.destination)) {
      throw new Error("Invalid Skills history archive mapping.");
    }
    destinations.add(entry.destination);
    if (entry.kind === "directory") {
      if (!Number.isInteger(entry.mode) || entry.mode! < 0 || entry.mode! > 0o777) throw new Error("Skills history directory mode is missing.");
      return [entry.source, entry.destination, entry.kind, entry.mode, null, null];
    }
    if (!Number.isSafeInteger(entry.size) || entry.size! < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")
      || !Number.isInteger(entry.mode) || entry.mode! < 0 || entry.mode! > 0o777) {
      throw new Error("Skills history file inventory is incomplete.");
    }
    return [entry.source, entry.destination, entry.kind, entry.mode, entry.size, entry.sha256];
  }).sort((left, right) => String(left[1]) < String(right[1]) ? -1 : String(left[1]) > String(right[1]) ? 1 : 0);
  const fileCount = inventory.filter(entry => entry[2] === "asset").length;
  const directoryCount = inventory.filter(entry => entry[2] === "directory").length + 1;
  const totalBytes = inventory.reduce((sum, entry) => sum + (entry[2] === "asset" ? Number(entry[4]) : 0), 0);
  const inventorySha256 = createHash("sha256").update(JSON.stringify([
    ["", legacySkillsHistoryArchive, "directory", 0o700, null, null], ...inventory,
  ])).digest("hex");
  return legacySkillsHistoryArchiveSchema.parse({
    schema: "pkm.legacy-skills-history-archive/v1",
    disposition: "opaque-inert-history",
    fileCount,
    directoryCount,
    totalBytes,
    inventorySha256,
  });
}

export function isLegacyActionStatePath(path: string): boolean {
  return path === legacyActionStateRoot || path.startsWith(`${legacyActionStateRoot}/`);
}
export function isInertLegacyPath(path: string, kind: "file" | "directory" = "file"): boolean {
  return isLegacyCodePath(path) || isLegacyActionStatePath(path) || isLegacySkillsHistoryPath(path, kind);
}
export function isLegacyCodePath(path: string): boolean {
  return legacyCodeAreas.some(area => path === area || path.startsWith(`${area}/`));
}
export function legacyLibraryDestination(path: string, kind: "file" | "directory" = "file"): string {
  if (isLegacyActionStatePath(path)) return `${legacyCodeArchive}/action-state${path.slice(legacyActionStateRoot.length)}`;
  if (path === "action-state" || path.startsWith("action-state/")) return `${legacyCodeArchive}/${path}`;
  if (isLegacySkillsHistoryPath(path, kind)) return `${legacySkillsHistoryArchive}/${path}`;
  return isLegacyCodePath(path) ? `${legacyCodeArchive}/${path}` : path;
}
export function isArchivedCodePath(path: string): boolean {
  if (!path.startsWith(`${legacyCodeArchive}/`)) return false;
  const suffix = path.slice(legacyCodeArchive.length + 1);
  return isLegacyCodePath(suffix) || suffix === "action-state" || suffix.startsWith("action-state/")
    || suffix === "skills-history" || suffix === "skills-history/skills"
    || suffix.startsWith("skills-history/skills/");
}
export function isLegacyLibraryPath(path: string): boolean {
  return ["prompts", "scripts", ...legacyCodeAreas].some(area => path === area || path.startsWith(`${area}/`));
}

export function legacyScriptSidecarTarget(path: string): string | undefined {
  if (!path.startsWith("scripts/")) return;
  const parts = path.split("/");
  const name = parts.pop()!;
  if (!name.startsWith(".") || !name.endsWith(".pkm.json")) return;
  const target = name.slice(1, -".pkm.json".length);
  if (!resourcePath.safeParse(target).success || target.includes("/")) return;
  return [...parts, target].join("/");
}

export function isLegacyLibraryResourcePath(path: string): boolean {
  const inert = isInertLegacyPath(path) || path === "action-state" || path.startsWith("action-state/");
  if (!isLegacyLibraryPath(path) && !inert) return false;
  if (inert) {
    // Validate hidden names as portable segments, never as traversal or native paths.
    return path.split("/").every(part => part !== "." && part !== ".." && part.length > 0
      && resourcePath.safeParse(part.startsWith(".") ? `hidden${part}` : part).success)
      && Buffer.byteLength(path) <= 2048
      && path.split("/").every(part => Buffer.byteLength(part) <= 255);
  }
  const parts = path.split("/");
  const name = parts.at(-1)!;
  const target = legacyScriptSidecarTarget(path);
  const visible = target ?? (name === ".gitkeep" ? [...parts.slice(0, -1), "gitkeep"].join("/") : path);
  return resourcePath.safeParse(visible).success;
}

export const legacyScriptIdentitySchema = z.object({
  schema: z.literal("pkm.script/v1"),
  knowledgeId: z.string().regex(/^script_[a-f0-9]{24}$/),
  aliases: z.array(z.string()),
});
