import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { GitHubSyncContentType } from "./github-sync";

export interface GitHubSyncContentIssue {
  path: string;
  type: GitHubSyncContentType;
  itemId: string;
  source: "local";
  reason: "merge-conflict-markers";
  lines: number[];
  digest: string;
  content: string;
  candidate?: string;
  sourcePath?: string;
}

export interface GitHubSyncContentRepair {
  schema: 1;
  id: string;
  targetId: string;
  createdAt: string;
  base: "unavailable";
  remote: "unavailable";
  issues: GitHubSyncContentIssue[];
}

export class GitHubSyncContentRepairError extends Error {
  readonly serviceShouldRetry = false;
  constructor(readonly targetId: string, readonly issues: GitHubSyncContentIssue[], readonly attemptId = randomUUID()) {
    super(`Local content needs repair: ${issues.length} file(s) contain merge conflict markers. Remote has not been fetched. Open GitHub Sync to repair and revalidate.`);
    this.name = "GitHubSyncContentRepairError";
  }
}

export function contentRepairDigest(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
}

export function inspectConflictMarkers(content: string): { lines: number[]; candidate?: string } {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) || [];
  const positions: number[] = [];
  const output: string[] = [];
  let block: string[] | undefined;
  let separator = false;
  let safe = true;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r?\n$/, "");
    const start = /^<<<<<<<(?: .*)?$/.test(line);
    const end = /^>>>>>>>(?: .*)?$/.test(line);
    const split = /^=======$/.test(line);
    const base = /^\|\|\|\|\|\|\|(?: .*)?$/.test(line);
    if (start || end || (block && (split || base))) positions.push(index + 1);
    if (start) {
      if (block) safe = false;
      block = [];
      separator = false;
    } else if (block && split) {
      if (separator) safe = false;
      separator = true;
    } else if (end) {
      if (!block || !separator || block.some(value => value.trim().length > 0)) safe = false;
      block = undefined;
    } else if (block) {
      if (base) safe = false;
      block.push(lines[index]);
    } else {
      output.push(lines[index]);
    }
  }
  if (block) safe = false;
  return { lines: positions, ...(positions.length && safe ? { candidate: output.join("") } : {}) };
}

function recordPath(directory: string, targetId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(targetId)) throw new Error("Invalid content repair target ID.");
  return path.join(directory, "content-repairs", `${targetId}.json`);
}

export function readGitHubSyncContentRepair(directory: string, targetId: string): GitHubSyncContentRepair | undefined {
  const file = recordPath(directory, targetId);
  try {
    const record: GitHubSyncContentRepair = JSON.parse(fs.readFileSync(file, "utf8"));
    if (record?.schema !== 1 || record.targetId !== targetId || !/^[a-zA-Z0-9_-]+$/.test(record.id)
      || record.base !== "unavailable" || record.remote !== "unavailable" || !Array.isArray(record.issues)) {
      throw new Error(`Invalid content repair record: ${file}`);
    }
    for (const issue of record.issues) {
      if (!issue || typeof issue.path !== "string" || typeof issue.digest !== "string" || typeof issue.content !== "string"
        || issue.source !== "local" || issue.reason !== "merge-conflict-markers"
        || !Array.isArray(issue.lines) || !issue.lines.every(line => Number.isInteger(line) && line > 0)) {
        throw new Error(`Invalid content repair issue: ${file}`);
      }
    }
    return record;
  }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function storeGitHubSyncContentRepair(directory: string, error: GitHubSyncContentRepairError): GitHubSyncContentRepair {
  const record: GitHubSyncContentRepair = {
    schema: 1, id: error.attemptId, targetId: error.targetId, createdAt: new Date().toISOString(),
    base: "unavailable", remote: "unavailable", issues: error.issues,
  };
  const file = recordPath(directory, error.targetId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return record;
}

export function clearGitHubSyncContentRepair(directory: string, targetId: string): void {
  const record = readGitHubSyncContentRepair(directory, targetId);
  if (record) {
    const preview = path.join(directory, "content-repairs", targetId);
    fs.rmSync(path.join(preview, "original.txt"), { force: true });
    fs.rmSync(path.join(preview, "candidate.txt"), { force: true });
    if (fs.existsSync(preview)) fs.rmdirSync(preview);
  }
  fs.rmSync(recordPath(directory, targetId), { force: true });
}

export function contentRepairSource(root: string, issue: GitHubSyncContentIssue): string {
  if (!issue.sourcePath) throw new Error("This content is generated. Edit its source in the library, then revalidate Sync.");
  const source = path.resolve(issue.sourcePath);
  const relative = path.relative(fs.realpathSync.native(root), fs.realpathSync.native(source));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Content repair source is outside the Knowledge Root.");
  }
  if (!fs.lstatSync(source).isFile()) throw new Error("Content repair requires a regular source file, not a symbolic link.");
  return source;
}

export function applyGitHubSyncEmptyMarkerCandidate(root: string, issue: GitHubSyncContentIssue): void {
  const source = contentRepairSource(root, issue);
  const original = fs.readFileSync(source);
  const text = original.toString("utf8");
  if (!Buffer.from(text).equals(original) || contentRepairDigest(text) !== issue.digest) {
    throw new Error("The source changed since review. Revalidate to refresh the repair candidate; nothing was overwritten.");
  }
  const inspection = inspectConflictMarkers(text);
  if (inspection.candidate === undefined) throw new Error("No safe empty-block candidate is available. Edit the file manually.");
  const temporary = `${source}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, inspection.candidate, { mode: fs.statSync(source).mode, flag: "wx" });
    if (!fs.readFileSync(source).equals(original)) throw new Error("The source changed during repair. Revalidate; nothing was overwritten.");
    fs.renameSync(temporary, source);
  } finally { fs.rmSync(temporary, { force: true }); }
}
