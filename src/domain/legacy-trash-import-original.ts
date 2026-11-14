// Unmodified original declarations. Evidence, not executable destination writers.
export const legacyTrashImportOriginal = {
  "src/knowledge/filestore.ts": {
    sha256: "c5c3a9761562818529a00aedb96aef254bef34dc80a4ed31f31efd39bc7a97a5",
    KnowledgeTrashEntry: `export interface KnowledgeTrashEntry {
  id: string;
  kind: "item" | "folder";
  name: string;
  originalPath: string;
  deletedAt: string;
  assetsPath?: string;
}`,
    SkillTrashEntry: `export interface SkillTrashEntry {
  id: string;
  kind: "skill" | "folder";
  name: string;
  originalPath: string;
  deletedAt: string;
  assetsPath?: string;
}`,
    recordKnowledgeTrashDeletion: `function recordKnowledgeTrashDeletion<T>(
  area: KnowledgeTrashArea | "skills", entry: KnowledgeTrashEntry | SkillTrashEntry, source: string, action: () => T,
): T {
  const paths = knowledgeDeletionPaths(area, source, entry.originalPath);
  return changeKnowledgeSyncDeletions(records => [
    ...records.filter(record => !paths.includes(record.path)),
    ...paths.map(path => ({ path, deletedAt: entry.deletedAt })),
  ], action, result => !!result);
}`,
  },
  "src/knowledge/knowledge-deletion-journal.ts": {
    sha256: "3944f565fba8bb3875f8a9fb9ea39b9e779fb2a013705405f68cc60845c99e49",
    load: `function load(root: string): KnowledgeSyncDeletionRecord[] {
  const file = knowledgeDeletionFile(root);
  if (!fs.existsSync(file)) return [];
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.schema !== 1 || !Array.isArray(value.records) || value.records.some((record: KnowledgeSyncDeletionRecord) =>
    typeof record?.path !== "string" || !/^(skills|notes|papers|prompts|scripts)\\//.test(record.path)
    || record.path.split("/").some(part => !part || part === "." || part === "..")
    || typeof record.deletedAt !== "string" || !Number.isFinite(Date.parse(record.deletedAt)))) {
    throw new Error("The local knowledge deletion journal is invalid. Sync cannot safely ignore deletion intent.");
  }
  return value.records;
}`,
  },
} as const;
