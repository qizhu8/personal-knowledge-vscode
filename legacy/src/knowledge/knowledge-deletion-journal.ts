import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { withCrossProcessLockSync } from "../runtime/cross-process-lock";

export interface KnowledgeSyncDeletionRecord { path: string; deletedAt: string; }

export function knowledgeDeletionFile(root: string): string {
  return path.join(root, ".pkm", "state", "knowledge-deletions.json");
}

function load(root: string): KnowledgeSyncDeletionRecord[] {
  const file = knowledgeDeletionFile(root);
  if (!fs.existsSync(file)) return [];
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.schema !== 1 || !Array.isArray(value.records) || value.records.some((record: KnowledgeSyncDeletionRecord) =>
    typeof record?.path !== "string" || !/^(skills|notes|papers|prompts|scripts)\//.test(record.path)
    || record.path.split("/").some(part => !part || part === "." || part === "..")
    || typeof record.deletedAt !== "string" || !Number.isFinite(Date.parse(record.deletedAt)))) {
    throw new Error("The local knowledge deletion journal is invalid. Sync cannot safely ignore deletion intent.");
  }
  return value.records;
}

function write(root: string, records: KnowledgeSyncDeletionRecord[]): void {
  const file = knowledgeDeletionFile(root);
  const temporary = `${file}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(temporary, JSON.stringify({ schema: 1, records }, null, 2) + "\n");
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function readKnowledgeSyncDeletions(root: string): KnowledgeSyncDeletionRecord[] {
  if (!fs.existsSync(knowledgeDeletionFile(root))) return [];
  return withCrossProcessLockSync(knowledgeDeletionFile(root) + ".lock", "read knowledge deletions", () => load(root));
}

export function withKnowledgeDeletionJournal<T>(
  root: string,
  change: (records: KnowledgeSyncDeletionRecord[]) => KnowledgeSyncDeletionRecord[],
  action: () => T, succeeded: (result: T) => boolean,
): T {
  return withCrossProcessLockSync(knowledgeDeletionFile(root) + ".lock", "change knowledge deletions", () => {
    const before = load(root);
    write(root, change(before));
    try {
      const result = action();
      if (!succeeded(result)) write(root, before);
      return result;
    } catch (error) {
      write(root, before);
      throw error;
    }
  });
}

export function recordKnowledgeResourceMutation<T>(root: string, removed: string[], restored: string[], action: () => T): T {
  return withKnowledgeDeletionJournal(root, records => [
    ...records.filter(record => !removed.includes(record.path) && !restored.includes(record.path)),
    ...removed.map(path => ({ path, deletedAt: new Date().toISOString() })),
  ], action, () => true);
}
