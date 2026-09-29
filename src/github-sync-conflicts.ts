import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  GitHubSyncConflict,
  GitHubSyncConflictError,
  GitHubSyncContentType,
  GitHubSyncPrivacy,
  GitHubSyncResolutionReport,
  githubSyncSafeRelativePath,
  validateGitHubSyncCandidate,
} from "./github-sync";

export interface GitHubSyncStoredConflictFile {
  path: string;
  type: GitHubSyncContentType;
  itemId: string;
  category: string;
  privacy: GitHubSyncPrivacy;
  hasBase: boolean;
  hasLocal: boolean;
  hasRemote: boolean;
  candidateSource: "unresolved" | "base" | "local" | "remote" | "delete" | "delete-local" | "manual" | "agent";
  rationale?: string;
  agentReview?: GitHubSyncAgentReview;
}

export interface GitHubSyncAgentReview {
  decisions: Array<{
    subject: string;
    choice: "base" | "local" | "remote" | "combined" | "removed";
    reason: string;
  }>;
  evidence: string[];
  unresolvedConflicts: string[];
  introducedContent: string[];
  confidence: number;
  accuracyRisk: boolean;
  humanFinalReviewRequired: true;
}

export interface GitHubSyncStoredConflict {
  schema: 1;
  id: string;
  targetId: string;
  remoteCommit: string;
  createdAt: string;
  explicitResolution: boolean;
  purpose?: "conflict" | "initial-preview";
  remoteSchema?: 1 | 2 | 3;
  resolutionReport?: GitHubSyncResolutionReport;
  files: GitHubSyncStoredConflictFile[];
}

function conflictRoot(stateDirectory: string): string {
  return path.join(stateDirectory, "conflicts");
}

function recordDirectory(stateDirectory: string, targetId: string): string {
  return path.join(conflictRoot(stateDirectory), targetId);
}

function metadataPath(stateDirectory: string, targetId: string): string {
  return path.join(recordDirectory(stateDirectory, targetId), "conflict.json");
}

function variantPath(stateDirectory: string, targetId: string, variant: "base" | "local" | "remote" | "merged", relative: string): string {
  return path.join(recordDirectory(stateDirectory, targetId), variant, ...githubSyncSafeRelativePath(relative).split("/"));
}

function writeVariant(stateDirectory: string, targetId: string, variant: "base" | "local" | "remote" | "merged", relative: string, content: Buffer): void {
  const destination = variantPath(stateDirectory, targetId, variant, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

function writeMetadata(stateDirectory: string, record: GitHubSyncStoredConflict): void {
  const destination = metadataPath(stateDirectory, record.targetId);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, destination);
}

export function storeGitHubSyncConflict(
  stateDirectory: string,
  targetId: string,
  error: GitHubSyncConflictError,
  purpose: "conflict" | "initial-preview" = "conflict",
  remoteSchema?: 1 | 2 | 3,
): GitHubSyncStoredConflict {
  const directory = recordDirectory(stateDirectory, targetId);
  fs.rmSync(directory, { recursive: true, force: true });
  const files = error.conflicts.map((conflict: GitHubSyncConflict): GitHubSyncStoredConflictFile => {
    if (conflict.base) writeVariant(stateDirectory, targetId, "base", conflict.path, conflict.base);
    if (conflict.local) writeVariant(stateDirectory, targetId, "local", conflict.path, conflict.local);
    if (conflict.remote) writeVariant(stateDirectory, targetId, "remote", conflict.path, conflict.remote);
    const candidate = conflict.local || conflict.remote || conflict.base;
    if (!candidate) throw new Error(`Conflict has no recoverable candidate: ${conflict.path}`);
    writeVariant(stateDirectory, targetId, "merged", conflict.path, candidate);
    const candidateSource = purpose === "initial-preview"
      ? conflict.local && !conflict.remote
        ? "local"
        : conflict.remote && !conflict.local
          ? "remote"
          : "unresolved"
      : "unresolved";
    return {
      path: conflict.path,
      type: conflict.type,
      itemId: conflict.itemId,
      category: conflict.category,
      privacy: conflict.privacy,
      hasBase: !!conflict.base,
      hasLocal: !!conflict.local,
      hasRemote: !!conflict.remote,
      candidateSource,
      ...(candidateSource === "local" ? { rationale: "Only this machine has this file; keep it in the merged result." } : {}),
      ...(candidateSource === "remote" ? { rationale: "Only GitHub has this file; restore it in the merged result." } : {}),
    };
  });
  const record: GitHubSyncStoredConflict = {
    schema: 1,
    id: randomUUID(),
    targetId,
    remoteCommit: error.remoteCommit,
    createdAt: new Date().toISOString(),
    explicitResolution: true,
    purpose,
    ...(remoteSchema ? { remoteSchema } : {}),
    resolutionReport: error.resolutionReport,
    files,
  };
  writeMetadata(stateDirectory, record);
  return record;
}

export function readGitHubSyncConflict(stateDirectory: string, targetId: string): GitHubSyncStoredConflict | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(metadataPath(stateDirectory, targetId), "utf8")) as GitHubSyncStoredConflict;
    if (parsed?.schema !== 1 || parsed.targetId !== targetId || !Array.isArray(parsed.files)) throw new Error("unsupported conflict record");
    if (parsed.explicitResolution !== true) {
      parsed.explicitResolution = true;
      for (const file of parsed.files) {
        file.candidateSource = "unresolved";
        delete file.rationale;
      }
      writeMetadata(stateDirectory, parsed);
    }
    return parsed;
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`Cannot read GitHub Sync conflict: ${error?.message || String(error)}`);
  }
}

export function listGitHubSyncConflicts(stateDirectory: string): GitHubSyncStoredConflict[] {
  const root = conflictRoot(stateDirectory);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .map(targetId => readGitHubSyncConflict(stateDirectory, targetId))
    .filter((record): record is GitHubSyncStoredConflict => !!record)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function gitHubSyncConflictVariantPath(
  stateDirectory: string,
  targetId: string,
  variant: "base" | "local" | "remote" | "merged",
  relative: string
): string {
  const record = readGitHubSyncConflict(stateDirectory, targetId);
  const file = record?.files.find(candidate => candidate.path === relative);
  if (!file) throw new Error("GitHub Sync conflict file was not found.");
  const destination = variantPath(stateDirectory, targetId, variant, relative);
  if (!fs.existsSync(destination)) throw new Error(`${variant} conflict content is not available for ${relative}.`);
  return destination;
}

export function updateGitHubSyncAgentCandidate(
  stateDirectory: string,
  targetId: string,
  relative: string,
  content: string,
  rationale: string,
  agentReview?: GitHubSyncAgentReview,
): void {
  const record = readGitHubSyncConflict(stateDirectory, targetId);
  const file = record?.files.find(candidate => candidate.path === relative);
  if (!record || !file) throw new Error("GitHub Sync conflict file was not found.");
  const candidate = Buffer.from(content, "utf8");
  validateGitHubSyncCandidate(relative, candidate);
  writeVariant(stateDirectory, targetId, "merged", relative, candidate);
  file.candidateSource = "agent";
  file.rationale = rationale.trim();
  file.agentReview = agentReview;
  writeMetadata(stateDirectory, record);
}

export function selectGitHubSyncConflictCandidate(
  stateDirectory: string,
  targetId: string,
  relative: string,
  source: "base" | "local" | "remote"
): void {
  const record = readGitHubSyncConflict(stateDirectory, targetId);
  const file = record?.files.find(candidate => candidate.path === relative);
  if (!record || !file) throw new Error("GitHub Sync conflict file was not found.");
  const candidate = fs.readFileSync(gitHubSyncConflictVariantPath(stateDirectory, targetId, source, relative));
  validateGitHubSyncCandidate(relative, candidate);
  writeVariant(stateDirectory, targetId, "merged", relative, candidate);
  file.candidateSource = source;
  delete file.agentReview;
  file.rationale = source === "local"
    ? "Keep the version currently stored on this machine."
    : source === "remote"
      ? "Use the version currently stored on GitHub."
      : "Restore the common version from before either side changed.";
  writeMetadata(stateDirectory, record);
}

export function selectAllGitHubSyncConflictCandidates(
  stateDirectory: string,
  targetId: string,
  source: "local" | "remote"
): { selected: number; unavailable: string[] } {
  const record = readGitHubSyncConflict(stateDirectory, targetId);
  if (!record) throw new Error("GitHub Sync conflict was not found.");
  const unavailable: string[] = [];
  const candidates: Array<{ file: GitHubSyncStoredConflictFile; content: Buffer }> = [];
  for (const file of record.files) {
    if (source === "local" ? !file.hasLocal : !file.hasRemote) {
      unavailable.push(file.path);
      continue;
    }
    const content = fs.readFileSync(variantPath(stateDirectory, targetId, source, file.path));
    validateGitHubSyncCandidate(file.path, content);
    candidates.push({ file, content });
  }
  for (const { file, content } of candidates) {
    writeVariant(stateDirectory, targetId, "merged", file.path, content);
    file.candidateSource = source;
    delete file.agentReview;
    file.rationale = source === "local"
      ? "Keep the version currently stored on this machine."
      : "Use the version currently stored on GitHub.";
  }
  writeMetadata(stateDirectory, record);
  return { selected: candidates.length, unavailable };
}

export function selectGitHubSyncConflictDeletion(
  stateDirectory: string,
  targetId: string,
  relative: string,
): void {
  const record = readGitHubSyncConflict(stateDirectory, targetId);
  const file = record?.files.find(candidate => candidate.path === relative);
  if (!record || !file) throw new Error("GitHub Sync conflict file was not found.");
  if (!file.hasBase || file.hasLocal || !file.hasRemote) {
    throw new Error("Delete GitHub is available only when a previously synchronized file is missing on this machine but still exists on GitHub.");
  }
  file.candidateSource = "delete";
  delete file.agentReview;
  file.rationale = "Confirm the machine-local deletion and remove this file from GitHub.";
  writeMetadata(stateDirectory, record);
}

export function selectAllGitHubSyncConflictDeletions(
  stateDirectory: string,
  targetId: string,
): { selected: number } {
  const record = readGitHubSyncConflict(stateDirectory, targetId);
  if (!record) throw new Error("GitHub Sync conflict was not found.");
  let selected = 0;
  for (const file of record.files) {
    if (file.candidateSource !== "unresolved" || !file.hasBase || file.hasLocal || !file.hasRemote) continue;
    file.candidateSource = "delete";
    delete file.agentReview;
    file.rationale = "Confirm the machine-local deletion and remove this file from GitHub.";
    selected++;
  }
  if (!selected) throw new Error("No missing-local conflicts are available to delete from GitHub.");
  writeMetadata(stateDirectory, record);
  return { selected };
}

export function selectGitHubSyncConflictLocalDeletion(
  stateDirectory: string,
  targetId: string,
  relative: string,
): void {
  const record = readGitHubSyncConflict(stateDirectory, targetId);
  const file = record?.files.find(candidate => candidate.path === relative);
  if (!record || !file) throw new Error("GitHub Sync conflict file was not found.");
  if (!file.hasLocal || file.hasRemote) {
    throw new Error("Delete This Machine is available only when the file exists locally but is absent from GitHub.");
  }
  file.candidateSource = "delete-local";
  delete file.agentReview;
  file.rationale = "Accept the file's absence from GitHub and delete the machine-local copy.";
  writeMetadata(stateDirectory, record);
}

export function selectAllGitHubSyncConflictLocalDeletions(
  stateDirectory: string,
  targetId: string,
): { selected: number } {
  const record = readGitHubSyncConflict(stateDirectory, targetId);
  if (!record) throw new Error("GitHub Sync conflict was not found.");
  let selected = 0;
  for (const file of record.files) {
    if (!file.hasLocal || file.hasRemote) continue;
    file.candidateSource = "delete-local";
    delete file.agentReview;
    file.rationale = "Accept the file's absence from GitHub and delete the machine-local copy.";
    selected++;
  }
  if (!selected) throw new Error("No missing-GitHub conflicts are available to delete from this machine.");
  writeMetadata(stateDirectory, record);
  return { selected };
}

export function validateGitHubSyncManualCandidate(
  stateDirectory: string,
  targetId: string,
  relative: string
): void {
  const record = readGitHubSyncConflict(stateDirectory, targetId);
  const file = record?.files.find(candidate => candidate.path === relative);
  if (!record || !file) throw new Error("GitHub Sync conflict file was not found.");
  const candidate = fs.readFileSync(gitHubSyncConflictVariantPath(stateDirectory, targetId, "merged", relative));
  validateGitHubSyncCandidate(relative, candidate);
  file.candidateSource = "manual";
  delete file.agentReview;
  file.rationale = "Validated after manual editing.";
  writeMetadata(stateDirectory, record);
}

export function readGitHubSyncConflictCandidate(stateDirectory: string, targetId: string, relative: string): Buffer {
  const candidate = fs.readFileSync(gitHubSyncConflictVariantPath(stateDirectory, targetId, "merged", relative));
  validateGitHubSyncCandidate(relative, candidate);
  return candidate;
}

export function refreshGitHubSyncConflictLocalCandidate(
  stateDirectory: string,
  targetId: string,
  relative: string,
  currentLocal: Buffer | undefined,
): void {
  const record = readGitHubSyncConflict(stateDirectory, targetId);
  const file = record?.files.find(candidate => candidate.path === relative);
  if (!record || !file) throw new Error("GitHub Sync conflict file was not found.");
  const localPath = variantPath(stateDirectory, targetId, "local", relative);
  if (currentLocal) {
    validateGitHubSyncCandidate(relative, currentLocal);
    writeVariant(stateDirectory, targetId, "local", relative, currentLocal);
    writeVariant(stateDirectory, targetId, "merged", relative, currentLocal);
    file.hasLocal = true;
  } else {
    fs.rmSync(localPath, { force: true });
    file.hasLocal = false;
  }
  file.candidateSource = "unresolved";
  delete file.agentReview;
  file.rationale = "The machine-local file changed after this conflict was prepared. Review the refreshed candidates.";
  writeMetadata(stateDirectory, record);
}

export function validateGitHubSyncConflictLocalState(
  relative: string,
  originalLocal: Buffer | undefined,
  candidate: Buffer,
  currentLocal: Buffer | undefined
): void {
  if (currentLocal?.equals(candidate)) return;
  if (originalLocal ? currentLocal?.equals(originalLocal) : currentLocal === undefined) return;
  throw new Error(`Local content changed after the conflict was prepared: ${githubSyncSafeRelativePath(relative)}`);
}

export function clearGitHubSyncConflict(stateDirectory: string, targetId: string): void {
  fs.rmSync(recordDirectory(stateDirectory, targetId), { recursive: true, force: true });
}
