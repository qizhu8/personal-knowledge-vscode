import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  GitHubSyncConflict,
  GitHubSyncConflictError,
  GitHubSyncContentType,
  GitHubSyncPrivacy,
  GitHubSyncResolutionReport,
  githubSyncSafeRelativePath,
  githubSyncIsTextContent,
  validateGitHubSyncCandidate,
} from "./github-sync";

export interface GitHubSyncStoredConflictFile {
  path: string;
  type: GitHubSyncContentType;
  itemId: string;
  category: string;
  privacy: GitHubSyncPrivacy;
  member?: string;
  basePath?: string;
  localPath?: string;
  remotePath?: string;
  resultPath?: string;
  entityDeletion?: boolean;
  hasBase: boolean;
  hasLocal: boolean;
  hasRemote: boolean;
  candidateSource: "unresolved" | "base" | "local" | "remote" | "delete" | "delete-local" | "manual" | "agent";
  rationale?: string;
  agentReview?: GitHubSyncAgentReview;
  candidateDigest?: string;
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
  revision?: number;
  appliedAt?: string;
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
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writeMetadata(stateDirectory: string, record: GitHubSyncStoredConflict): void {
  record.revision = (record.revision || 0) + 1;
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
  const previous = readGitHubSyncConflict(stateDirectory, targetId);
  const kept = new Map<string, { file: GitHubSyncStoredConflictFile; content: Buffer }>();
  const sameBuffer = (left: Buffer | undefined, right: Buffer | undefined): boolean =>
    left === undefined ? right === undefined : right !== undefined && left.equals(right);
  for (const conflict of error.conflicts) {
    const old = previous?.files.find(file => file.path === conflict.path && file.type === conflict.type && file.itemId === conflict.itemId);
    if (!old || old.category !== conflict.category || old.privacy !== conflict.privacy
      || old.member !== conflict.member || old.entityDeletion !== conflict.entityDeletion
      || old.basePath !== conflict.basePath || old.localPath !== conflict.localPath || old.remotePath !== conflict.remotePath) continue;
    const unchanged = (["base", "local", "remote"] as const).every(variant => {
      const available = variant === "base" ? old.hasBase : variant === "local" ? old.hasLocal : old.hasRemote;
      return sameBuffer(conflict[variant], available
        ? fs.readFileSync(variantPath(stateDirectory, targetId, variant, conflict.path)) : undefined);
    });
    if (unchanged) kept.set(conflict.path, {
      file: old,
      content: fs.readFileSync(variantPath(stateDirectory, targetId, "merged", conflict.path)),
    });
  }
  fs.mkdirSync(stateDirectory, { recursive: true });
  const stagingRoot = fs.mkdtempSync(path.join(stateDirectory, "conflict-stage-"));
  try {
  const files = error.conflicts.map((conflict: GitHubSyncConflict): GitHubSyncStoredConflictFile => {
    if (conflict.base) writeVariant(stagingRoot, targetId, "base", conflict.path, conflict.base);
    if (conflict.local) writeVariant(stagingRoot, targetId, "local", conflict.path, conflict.local);
    if (conflict.remote) writeVariant(stagingRoot, targetId, "remote", conflict.path, conflict.remote);
    const preserved = kept.get(conflict.path);
    if (preserved) {
      writeVariant(stagingRoot, targetId, "merged", conflict.path, preserved.content);
      return { ...preserved.file };
    }
    const candidate = conflict.local || conflict.remote || conflict.base;
    if (!candidate) throw new Error(`Conflict has no recoverable candidate: ${conflict.path}`);
    const candidateSource = conflict.local && conflict.remote && conflict.local.equals(conflict.remote)
      && (conflict.localPath || conflict.path) === (conflict.remotePath || conflict.path)
      ? "local"
      : conflict.base && conflict.local && conflict.remote && conflict.local.equals(conflict.base)
        && (conflict.localPath || conflict.path) === (conflict.basePath || conflict.path)
        ? "remote"
        : conflict.base && conflict.local && conflict.remote && conflict.remote.equals(conflict.base)
          && (conflict.remotePath || conflict.path) === (conflict.basePath || conflict.path)
          ? "local"
          : purpose === "initial-preview" || !conflict.base
      ? conflict.local && !conflict.remote
        ? "local"
        : conflict.remote && !conflict.local
          ? "remote"
          : "unresolved"
      : "unresolved";
    const result = candidateSource === "remote" ? conflict.remote! : candidate;
    writeVariant(stagingRoot, targetId, "merged", conflict.path, result);
    return {
      path: conflict.path,
      type: conflict.type,
      itemId: conflict.itemId,
      category: conflict.category,
      privacy: conflict.privacy,
      member: conflict.member,
      basePath: conflict.basePath,
      localPath: conflict.localPath,
      remotePath: conflict.remotePath,
      resultPath: candidateSource === "remote" ? conflict.remotePath || conflict.path : conflict.localPath || conflict.path,
      entityDeletion: conflict.entityDeletion,
      hasBase: !!conflict.base,
      hasLocal: !!conflict.local,
      hasRemote: !!conflict.remote,
      candidateSource,
      ...(candidateSource !== "unresolved" ? { candidateDigest: createHash("sha256").update(result).digest("hex") } : {}),
      ...(candidateSource === "local" ? { rationale: conflict.remote
        ? conflict.local?.equals(conflict.remote)
          ? "Both versions agree; preserve this file."
          : "Only this machine changed from the common base; preserve its compatible change."
        : "Only this machine has this file; keep it in the merged result." } : {}),
      ...(candidateSource === "remote" ? { rationale: conflict.local
        ? "Only GitHub changed from the common base; preserve its compatible change."
        : "Only GitHub has this file; restore it in the merged result." } : {}),
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
    revision: previous?.revision || 0,
  };
  writeMetadata(stagingRoot, record);
  fs.mkdirSync(conflictRoot(stateDirectory), { recursive: true });
  const backup = path.join(stagingRoot, "previous");
  const hadPrevious = fs.existsSync(directory);
  if (hadPrevious) fs.renameSync(directory, backup);
  try { fs.renameSync(recordDirectory(stagingRoot, targetId), directory); }
  catch (error) {
    if (hadPrevious) fs.renameSync(backup, directory);
    throw error;
  }
  return record;
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

export function validateGitHubSyncConflictVersion(
  stateDirectory: string, targetId: string, expected: { conflictId: string; revision: number },
): GitHubSyncStoredConflict {
  const record = readGitHubSyncConflict(stateDirectory, targetId);
  if (!record || record.id !== expected.conflictId || (record.revision || 0) !== expected.revision) {
    throw new Error("The conflict workspace changed in another window or during recheck. Refresh it and review the latest choices.");
  }
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

export function markGitHubSyncConflictApplied(stateDirectory: string, targetId: string): void {
  const record = readGitHubSyncConflict(stateDirectory, targetId);
  if (!record) throw new Error("GitHub Sync conflict was not found.");
  record.appliedAt = new Date().toISOString();
  writeMetadata(stateDirectory, record);
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
  if (agentReview?.accuracyRisk || agentReview?.unresolvedConflicts.length || agentReview?.introducedContent.length) {
    throw new Error("Agent merge still has accuracy risks; resolve this conflict manually.");
  }
  const candidate = Buffer.from(content, "utf8");
  validateGitHubSyncCandidate(relative, candidate);
  writeVariant(stateDirectory, targetId, "merged", relative, candidate);
  file.candidateDigest = createHash("sha256").update(candidate).digest("hex");
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
  const resultPath = source === "base" ? file.basePath || relative : source === "local" ? file.localPath || relative : file.remotePath || relative;
  validateGitHubSyncCandidate(resultPath, candidate);
  writeVariant(stateDirectory, targetId, "merged", relative, candidate);
  file.candidateSource = source;
  file.resultPath = resultPath;
  file.candidateDigest = createHash("sha256").update(candidate).digest("hex");
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
    if (file.candidateSource !== "unresolved") continue;
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
    file.resultPath = source === "local" ? file.localPath || file.path : file.remotePath || file.path;
    file.candidateDigest = createHash("sha256").update(content).digest("hex");
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
  validateGitHubSyncCandidate(file.resultPath || relative, candidate);
  file.candidateSource = "manual";
  file.candidateDigest = createHash("sha256").update(candidate).digest("hex");
  delete file.agentReview;
  file.rationale = "Validated after manual editing.";
  writeMetadata(stateDirectory, record);
}

export function saveGitHubSyncManualCandidate(stateDirectory: string, targetId: string, relative: string, content: string): void {
  const record = readGitHubSyncConflict(stateDirectory, targetId);
  const file = record?.files.find(file => file.path === relative);
  if (!record || !file) throw new Error("GitHub Sync conflict file was not found.");
  const current = fs.readFileSync(gitHubSyncConflictVariantPath(stateDirectory, targetId, "merged", relative));
  if (!githubSyncIsTextContent(relative, current)) {
    throw new Error("Binary conflict candidates cannot be edited as text. Choose a source version.");
  }
  const candidate = Buffer.from(content, "utf8");
  validateGitHubSyncCandidate(file.resultPath || relative, candidate);
  writeVariant(stateDirectory, targetId, "merged", relative, candidate);
  file.candidateSource = "manual";
  file.candidateDigest = createHash("sha256").update(candidate).digest("hex");
  file.rationale = "Saved and validated in the conflict workbench.";
  delete file.agentReview;
  writeMetadata(stateDirectory, record);
}

export function readGitHubSyncConflictCandidate(stateDirectory: string, targetId: string, relative: string, requireApproved = false): Buffer {
  const file = readGitHubSyncConflict(stateDirectory, targetId)?.files.find(file => file.path === relative);
  const candidate = fs.readFileSync(gitHubSyncConflictVariantPath(stateDirectory, targetId, "merged", relative));
  validateGitHubSyncCandidate(file?.resultPath || relative, candidate);
  if (requireApproved && (!file?.candidateDigest || file.candidateDigest !== createHash("sha256").update(candidate).digest("hex"))) {
    throw new Error(`The merge candidate changed after validation. Save and validate it again: ${relative}`);
  }
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
  delete file.candidateDigest;
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
