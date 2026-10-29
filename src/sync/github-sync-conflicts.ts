import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { normalizeTextNewlines } from "../knowledge/text-format";
import { readSyncScriptIdentity, syncScriptAliasPath, syncScriptSidecarPath } from "./github-sync-script-identity";
import {
  GitHubSyncConflict,
  GitHubSyncConflictError,
  GitHubSyncContentType,
  GitHubSyncPrivacy,
  GitHubSyncResolutionReport,
  githubSyncSafeRelativePath,
  githubSyncIsTextContent,
  githubSyncLocalSnapshotMatches,
  githubSyncComparisonContent,
  cleanupGitHubSyncTemporary,
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
  reason?: GitHubSyncConflict["reason"];
  baseCommit?: string;
  plannedOperation?: "write" | "delete";
  hasPlanned?: boolean;
  hasExpectedLocal?: boolean;
  deletionEvidence?: GitHubSyncConflict["deletionEvidence"];
  absenceEvidence?: GitHubSyncConflict["absenceEvidence"];
  hasBase: boolean;
  hasLocal: boolean;
  hasRemote: boolean;
  candidateSource: "unresolved" | "base" | "local" | "remote" | "plan" | "delete" | "delete-local" | "manual" | "agent";
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
  applyState?: "applying" | "applied" | "sync-pending";
}

/** Acceptance must recheck the current store, not trust a path-keyed old workspace. */
export function validateGitHubSyncConflictScriptIdentity(
  storeRoot: string, record: GitHubSyncStoredConflict, candidates: Array<{ file: GitHubSyncStoredConflictFile; content?: Buffer }>,
): void {
  const active = new Map<string, string[]>();
  const locators = new Map<string, Set<string>>();
  const claim = (locator: string, id: string): void => {
    const ids = locators.get(locator) || new Set<string>();
    ids.add(id); locators.set(locator, ids);
  };
  const scriptsRoot = path.resolve(storeRoot, "scripts");
  const walk = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Script identity directory is a symbolic link.");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const relative = `scripts/${path.relative(scriptsRoot, full).replace(/\\/g, "/")}`;
        const sidecar = path.resolve(storeRoot, ...syncScriptSidecarPath(relative).split("/"));
        if (!fs.existsSync(sidecar)) continue;
        if (fs.lstatSync(sidecar).isSymbolicLink()) throw new Error("Script identity sidecar is a symbolic link.");
        const identity = readSyncScriptIdentity(fs.readFileSync(sidecar));
        active.set(identity.knowledgeId, [...(active.get(identity.knowledgeId) || []), relative]);
        claim(relative, identity.knowledgeId);
        for (const alias of identity.aliases) {
          const locator = syncScriptAliasPath(alias);
          if (locator) claim(locator, identity.knowledgeId);
        }
      }
    }
  };
  walk(scriptsRoot);
  for (const { file, content } of candidates) {
    if (file.type !== "scripts") continue;
    let id = /^script_[a-f0-9]{24}$/.test(file.itemId) ? file.itemId : undefined;
    if (content && (file.member === "identity-sidecar" || /\.pkm\.json$/.test(file.path))) {
      const identity = readSyncScriptIdentity(content);
      if (id && id !== identity.knowledgeId) throw new Error("Conflict candidate changes Script identity.");
      id = identity.knowledgeId;
    }
    if (!id) {
      const sidecar = record.files.find(member => member.type === file.type && member.itemId === file.itemId && /\.pkm\.json$/.test(member.path));
      const candidate = candidates.find(candidate => candidate.file.path === sidecar?.path);
      if (candidate?.content) id = readSyncScriptIdentity(candidate.content).knowledgeId;
    }
    if (!id) {
      const matches = locators.get(file.remotePath || file.resultPath || file.path);
      if (matches && matches.size > 1) throw new Error("Conflict locator has ambiguous active Script identities; rebuild review.");
      if (matches?.size === 1) id = [...matches][0];
    }
    if (!id) continue;
    const current = active.get(id) || [];
    const body = record.files.find(member => member.type === "scripts" && member.itemId === file.itemId && !member.member);
    const allowed = new Set([body?.localPath, body?.resultPath || body?.remotePath || body?.path].filter(Boolean));
    if (current.length > 1 || current.some(relative => !allowed.has(relative)) || (!content && current.length && !body?.hasLocal)) {
      throw new Error(`Script ${id} is active at ${current.join(", ")}; rebuild identity-aware review before restoring or deleting it.`);
    }
  }
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

function variantPath(stateDirectory: string, targetId: string, variant: "base" | "local" | "remote" | "merged" | "planned" | "expected", relative: string): string {
  return path.join(recordDirectory(stateDirectory, targetId), variant, ...githubSyncSafeRelativePath(relative).split("/"));
}

function writeVariant(stateDirectory: string, targetId: string, variant: "base" | "local" | "remote" | "merged" | "planned" | "expected", relative: string, content: Buffer): void {
  const destination = variantPath(stateDirectory, targetId, variant, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let primary: unknown;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600 });
    const descriptor = fs.openSync(temporary, "r+");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, destination);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    cleanupGitHubSyncTemporary(temporary, primary);
  }
}

function writeMetadata(stateDirectory: string, record: GitHubSyncStoredConflict): void {
  record.revision = (record.revision || 0) + 1;
  const destination = metadataPath(stateDirectory, record.targetId);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  let primary: unknown;
  try {
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    const descriptor = fs.openSync(temporary, "r+");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, destination);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    cleanupGitHubSyncTemporary(temporary, primary);
  }
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
      || old.reason !== conflict.reason || old.plannedOperation !== conflict.plannedOperation
      || JSON.stringify(old.deletionEvidence) !== JSON.stringify(conflict.deletionEvidence)
      || JSON.stringify(old.absenceEvidence) !== JSON.stringify(conflict.absenceEvidence)
      || old.baseCommit !== conflict.baseCommit
      || old.member !== conflict.member || old.entityDeletion !== conflict.entityDeletion
      || old.basePath !== conflict.basePath || old.localPath !== conflict.localPath || old.remotePath !== conflict.remotePath) continue;
    const unchanged = (["base", "local", "remote"] as const).every(variant => {
      const available = variant === "base" ? old.hasBase : variant === "local" ? old.hasLocal : old.hasRemote;
      return sameBuffer(conflict[variant], available
        ? fs.readFileSync(variantPath(stateDirectory, targetId, variant, conflict.path)) : undefined);
    });
    const planUnchanged = sameBuffer(conflict.plannedContent, old.hasPlanned
      ? fs.readFileSync(variantPath(stateDirectory, targetId, "planned", conflict.path)) : undefined)
      && sameBuffer(conflict.expectedLocal, old.hasExpectedLocal
        ? fs.readFileSync(variantPath(stateDirectory, targetId, "expected", conflict.path)) : undefined);
    if (unchanged && planUnchanged) kept.set(conflict.path, {
      file: old,
      content: fs.readFileSync(variantPath(stateDirectory, targetId, "merged", conflict.path)),
    });
  }
  fs.mkdirSync(stateDirectory, { recursive: true });
  const stagingRoot = fs.mkdtempSync(path.join(stateDirectory, "conflict-stage-"));
  try {
  const files = error.conflicts.map((conflict: GitHubSyncConflict): GitHubSyncStoredConflictFile => {
    const logicalEqual = (left: Buffer, right: Buffer): boolean => {
      try { return githubSyncComparisonContent(conflict.type, left, conflict.path).equals(githubSyncComparisonContent(conflict.type, right, conflict.path)); }
      catch { return left.equals(right); }
    };
    if (conflict.base) writeVariant(stagingRoot, targetId, "base", conflict.path, conflict.base);
    if (conflict.local) writeVariant(stagingRoot, targetId, "local", conflict.path, conflict.local);
    if (conflict.remote) writeVariant(stagingRoot, targetId, "remote", conflict.path, conflict.remote);
    if (conflict.plannedContent) writeVariant(stagingRoot, targetId, "planned", conflict.path, conflict.plannedContent);
    if (conflict.expectedLocal) writeVariant(stagingRoot, targetId, "expected", conflict.path, conflict.expectedLocal);
    const preserved = kept.get(conflict.path);
    if (preserved) {
      writeVariant(stagingRoot, targetId, "merged", conflict.path, preserved.content);
      if (previous?.remoteCommit !== error.remoteCommit && !error.partialResult) {
        return { ...preserved.file, candidateSource: "unresolved", candidateDigest: undefined,
          rationale: "The Remote commit changed. The previous draft is retained for review, but its approval is invalid; revalidate against the new snapshot." };
      }
      return { ...preserved.file };
    }
    const candidate = conflict.plannedContent || conflict.local || conflict.remote || conflict.base;
    if (!candidate) throw new Error(`Conflict has no recoverable candidate: ${conflict.path}`);
    const candidateSource = conflict.reason === "concurrent-local-change" ? "unresolved"
      : conflict.reason === "pending-apply" ? conflict.plannedOperation === "delete" ? "delete-local" : "plan"
      : conflict.local && conflict.remote && logicalEqual(conflict.local, conflict.remote)
      && (conflict.localPath || conflict.path) === (conflict.remotePath || conflict.path)
      ? "local"
      : conflict.base && conflict.local && conflict.remote && logicalEqual(conflict.local, conflict.base)
        && (conflict.localPath || conflict.path) === (conflict.basePath || conflict.path)
        ? "remote"
        : conflict.base && conflict.local && conflict.remote && logicalEqual(conflict.remote, conflict.base)
          && (conflict.remotePath || conflict.path) === (conflict.basePath || conflict.path)
          ? "local"
          : purpose === "initial-preview" || !conflict.base
      ? conflict.local && !conflict.remote
        ? "local"
        : conflict.remote && !conflict.local
          ? "remote"
          : "unresolved"
      : "unresolved";
    const result = candidateSource === "plan" ? conflict.plannedContent! : candidateSource === "remote" ? conflict.remote! : candidate;
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
      reason: conflict.reason,
      baseCommit: conflict.baseCommit,
      plannedOperation: conflict.plannedOperation,
      hasPlanned: conflict.plannedContent !== undefined,
      hasExpectedLocal: conflict.expectedLocal !== undefined,
      deletionEvidence: conflict.deletionEvidence,
      absenceEvidence: conflict.absenceEvidence,
      hasBase: !!conflict.base,
      hasLocal: !!conflict.local,
      hasRemote: !!conflict.remote,
      candidateSource,
      ...(conflict.reason === "pending-apply" ? { rationale: "The prepared operation was not applied because another member changed. Review the retained plan; Base and GitHub remain the actual source versions." } : {}),
      ...(candidateSource !== "unresolved" ? { candidateDigest: createHash("sha256").update(result).digest("hex") } : {}),
      ...(candidateSource === "local" ? { rationale: conflict.remote
        ? conflict.local && logicalEqual(conflict.local, conflict.remote)
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
    id: error.partialResult && previous && kept.size === error.conflicts.length && previous.files.length === files.length
      ? previous.id : randomUUID(),
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
  record.applyState = "sync-pending";
  writeMetadata(stateDirectory, record);
}

/** Durable intent before mutation; retries revalidate candidates and source snapshots. */
export function markGitHubSyncConflictApplying(stateDirectory: string, targetId: string): void {
  const record = readGitHubSyncConflict(stateDirectory, targetId);
  if (!record) throw new Error("GitHub Sync conflict was not found.");
  record.applyState = "applying";
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
  variant: "base" | "local" | "remote" | "merged" | "planned" | "expected",
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
  validateGitHubSyncCandidate(relative, candidate, file.member);
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
  // Missing entities are reviewed as a unit; never restore the body without its members.
  if (source === "remote" && file.reason === "unrecorded-local-absence") {
    const members = record.files.filter(member => member.type === file.type && member.itemId === file.itemId);
    const prepared = members.map(member => {
      if (!member.hasRemote) throw new Error(`GitHub member is unavailable; review the move or deletion: ${member.path}`);
      const content = fs.readFileSync(variantPath(stateDirectory, targetId, "remote", member.path));
      validateGitHubSyncCandidate(member.remotePath || member.path, content, member.member);
      return { member, content };
    });
    for (const { member, content } of prepared) {
      writeVariant(stateDirectory, targetId, "merged", member.path, content);
      member.candidateSource = "remote";
      member.resultPath = member.remotePath || member.path;
      member.candidateDigest = createHash("sha256").update(content).digest("hex");
      member.rationale = "Explicitly restore the GitHub entity, including its sidecars and dependencies.";
      delete member.agentReview;
    }
    writeMetadata(stateDirectory, record);
    return;
  }
  const candidate = fs.readFileSync(gitHubSyncConflictVariantPath(stateDirectory, targetId, source, relative));
  const resultPath = source === "base" ? file.basePath || relative : source === "local" ? file.localPath || relative : file.remotePath || relative;
  validateGitHubSyncCandidate(resultPath, candidate, file.member);
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
  const restoreEntities = new Set(source === "remote" ? record.files.filter(file =>
    file.candidateSource === "unresolved" && file.reason === "unrecorded-local-absence")
    .map(file => `${file.type}\0${file.itemId}`) : []);
  for (const file of record.files) {
    if (file.candidateSource !== "unresolved" && !restoreEntities.has(`${file.type}\0${file.itemId}`)) continue;
    if (source === "local" ? !file.hasLocal : !file.hasRemote) {
      if (restoreEntities.has(`${file.type}\0${file.itemId}`)) {
        throw new Error(`GitHub entity member is unavailable; review the move or deletion: ${file.path}`);
      }
      unavailable.push(file.path);
      continue;
    }
    const content = fs.readFileSync(variantPath(stateDirectory, targetId, source, file.path));
    validateGitHubSyncCandidate(source === "remote" ? file.remotePath || file.path : file.localPath || file.path, content, file.member);
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
  if (file.reason === "unrecorded-local-absence") {
    const members = record.files.filter(member => member.type === file.type && member.itemId === file.itemId);
    if (members.some(member => member.hasLocal)) throw new Error("The entity has local members. Review its move or partial absence before confirming deletion.");
    for (const member of members) {
      member.candidateSource = "delete";
      delete member.candidateDigest;
      delete member.agentReview;
      member.rationale = "Explicitly confirm deletion of this missing entity and all its members; absence alone was not deletion evidence.";
    }
    writeMetadata(stateDirectory, record);
    return;
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
  const deletedEntities = new Set(record.files.filter(file => file.candidateSource === "delete"
    && file.reason === "unrecorded-local-absence").map(file => `${file.type}\0${file.itemId}`));
  for (const file of record.files) {
    if (!deletedEntities.has(`${file.type}\0${file.itemId}`)) continue;
    if (file.hasLocal) throw new Error("A missing entity still has local members; review its move or partial absence.");
    file.candidateSource = "delete";
    delete file.candidateDigest;
    delete file.agentReview;
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
  validateGitHubSyncCandidate(file.resultPath || relative, candidate, file.member);
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
  validateGitHubSyncCandidate(file.resultPath || relative, candidate, file.member);
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
  validateGitHubSyncCandidate(file?.resultPath || relative, candidate, file?.member);
  if (requireApproved && (!file?.candidateDigest || file.candidateDigest !== createHash("sha256").update(candidate).digest("hex"))) {
    throw new Error(`The merge candidate changed after validation. Save and validate it again: ${relative}`);
  }
  return requireApproved ? normalizeTextNewlines(file?.resultPath || relative, candidate) : candidate;
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
    validateGitHubSyncCandidate(relative, currentLocal, file.member);
    writeVariant(stateDirectory, targetId, "local", relative, currentLocal);
    writeVariant(stateDirectory, targetId, "merged", relative, currentLocal);
    file.hasLocal = true;
  } else {
    fs.rmSync(localPath, { force: true });
    file.hasLocal = false;
  }
  file.candidateSource = "unresolved";
  file.reason = "concurrent-local-change";
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
  if (githubSyncLocalSnapshotMatches(originalLocal, candidate, currentLocal)) return;
  throw new Error(`Local content changed after the conflict was prepared: ${githubSyncSafeRelativePath(relative)}`);
}

export function clearGitHubSyncConflict(stateDirectory: string, targetId: string): void {
  fs.rmSync(recordDirectory(stateDirectory, targetId), { recursive: true, force: true });
}
