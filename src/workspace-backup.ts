import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { RenameNoReplaceError, renameNoReplaceSync } from "./rename-no-replace.js";
import { chmod, open, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { coreDatabaseFile, coreDatabaseSidecarFiles, coreDatabasePath, codingProcessDatabaseFile,
  codingProcessDatabasePath, codingProcessDatabaseFiles, workspaceStoragePaths,
  serverDataDirectory, managedRuntimeDirectory, storageLayoutMarker, workspaceRootForDatabase,
  separatedStorageSchema } from "./workspace-storage-paths.js";
import { DatabaseSync } from "node:sqlite";
import { inspectNativeSubscriptionBundles } from "./host-composition-subscription-bundle.js";
import { inspectLegacyControlRecovery } from "./legacy-control-import.js";
import { validateLegacyRecipeTrashJournalSchema } from "./legacy-recipe-trash.js";
import { rebindMigrationTrashBackup } from "./migration-runtime.js";
import { readLegacyStateReceipt, verifyBoundLegacyStateBytes, verifyNativeSubscriptionIdentity } from "./host-composition-legacy-state.js";
import { verifyLegacyRetrievalModels, captureLegacyRetrievalModelReconstruction, parseModelReconstructionManifest,
  verifyLegacyRetrievalModelReconstruction, reconstructLegacyRetrievalModels,
  type ModelReconstructionManifest } from "./legacy-retrieval-model.js";
import { verifyLegacyKnowledgeRecovery } from "./legacy-knowledge-recovery.js";
import { verifyLegacyKnowledgeSnapshots } from "./legacy-knowledge-snapshots.js";
import { verifyLegacyActionArtifacts } from "./legacy-action-artifacts.js";
import type { NativeSubscriptionIdentityPolicy } from "./legacy-subscription-identity.js";
import { assertPortalRecoveryClear } from "./host-composition-portal.js";
import { verifyLegacyNoteWorkItemsWorkspace } from "./host-composition-legacy-note-workitems.js";
import { verifyInlineNoteWorkspace } from "./host-composition-legacy-inline-note.js";
import { verifyBatch15SkillWorkspace } from "./host-composition-legacy-batch15-skill.js";
import { assertSkillSourceIntegrated } from "./host-composition-legacy-skill-source.js";
import {
  captureSkillSourceBackup, parseSkillSourceBackupPin, verifySkillSourceBackup,
  approveSkillSourceRestore, prepareSkillSourceAdoption, adoptSkillSourceBackup,
  verifyAdoptedSkillSourceBackup, verifyPublishedSkillSourceBackup,
  type NativeSkillSourceBackupAuthority, type SkillSourceBackupPin, type NativeSkillSourceRestoreRequest,
} from "./legacy-skill-source-backup.js";
export type {
  NativeSkillSourceBackupAuthority, NativeSkillSourceBackupRequest, NativeSkillSourceRestoreRequest,
} from "./legacy-skill-source-backup.js";
import { assertBatch16UnintegratedClear } from "./host-composition-legacy-batch16-fence.js";
import { LEGACY_CLASSIFICATION_COMMAND_DDL, inspectLegacyClassificationCommand, verifyLegacyClassificationCommandSchema } from "./legacy-classification-command.js";
import { originalClassificationBackupHost, verifyOriginalClassificationBackup, verifyOriginalClassificationBackupHistory,
  type OriginalClassificationBackupPolicy } from "./legacy-classification-command-backup.js";
import {
  verifyBatch16ClassificationHistory, verifyBatch16ClassificationBackup,
  type NativeBatch16ClassificationPolicy,
} from "./host-composition-legacy-batch16-classification.js";
import {
  LEGACY_CLASSIFICATION_ADOPTION_DDL, inspectNativeClassificationAdoptions, inspectNativeClassificationHistory,
  scanNativeClassification, validateNativeClassificationAdoptionLineage, verifyNativeClassificationAdoptionSchema,
  type LegacyClassificationAdoption, type LegacyClassificationNativeHost,
} from "./legacy-classification-native.js";
import { validateLegacyMemoryErasureLedger } from "./legacy-memory-erasure.js";
import { inspectPausedSnapshotJournal } from "./host-composition-legacy-snapshot-restore.js";
import { readLegacyProjectEnvelopeAdoption } from "./legacy-project-envelope.js";
import { Storage, validateWorkspace } from "./storage.js";
import { acquireLinuxRootWriterFence, assertLinuxRootOwnerMarker } from "./linux-root-writer-fence.js";
import { CoreError } from "./contracts.js";
import {
  authorizeLegacyTrashNative, inspectLegacyTrashNative, rebindLegacyTrashBackup, type LegacyTrashAdoptionReceipt,
  type LegacyTrashNativeHost,
} from "./legacy-trash-import-native.js";
import { qualifyLegacyTrashSnapshotScope, type LegacyTrashSnapshotScope } from "./legacy-trash-import.js";
import { isArchivedCodePath, isLegacyCodePath, isLegacyLibraryPath } from "./legacy-library.js";
import { mtimeNanosecondsPattern, restoreFileMtimes } from "./file-mtime.js";
import { protectWorkspaceGit } from "./workspace-git-protection.js";
import { inspectWorkspaceRuntimeControls, acquireWorkspaceRuntimeControlSnapshot } from "./workspace-runtime-control.js";

const manifestName = ".pkm-workspace-backup.json";
const workspaceMarker = ".pkm-next-workspace";
const legacyTrashMarker = ".legacy-trash-import.json";
const workspaceSchema = "pkm.next-workspace/v2";
const backupSchema = "pkm.workspace-backup/v1";
const currentDatabaseVersion = 23;
const supportedDatabaseVersions = new Set([12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28]);
const allowedDirectories = new Set(["notes", "skills", "papers", "prompts", "scripts", "actions", "components",
  "packages", "boards", "project", "recipes", "subscriptions", "agent-snapshot-reads", "recipe-usage-reads",
  "knowledge-read-config", "legacy-import-evidence", "legacy-code-archive", ".pkm", ".pkm-action-sources", "runtime-control"]);
for (const root of ["_feedback", "_proposals"]) allowedDirectories.add(root);
const preservesSourceMtime = (path: string) => /^(notes|skills|papers)\/.+\.md$/i.test(path)
  || /^recipe-usage-reads\/\.pkm\/state\/recipe-runs\/recipe_run_[^/]*\.json$/.test(path);
const workspaceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface WorkspaceBackupLimits {
  maxFiles: number;
  maxDepth?: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const defaultWorkspaceBackupLimits: Readonly<WorkspaceBackupLimits> = Object.freeze({
  maxFiles: 10_000,
  maxFileBytes: 256 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
});

export interface WorkspaceQuiescenceLease {
  assertHeld(): void;
  release(): Promise<void> | void;
}

export interface WorkspaceBackupHostAdapter {
  acquireQuiescence(): Promise<WorkspaceQuiescenceLease>;
}

export interface NativeRestoreAuthorityRequest {
  schema: "pkm.native-restore-authority-request/v1";
  intent: "workspace-restore";
  actorId: string;
  workspaceId: string;
  sourceRoot: string;
  sourceDevice: string;
  sourceInode: string;
  manifestSha256: string;
  destination: string;
  backupErasureEpoch: number | null;
}

export interface NativeClassificationAdoptionRequest {
  originalCompatible?: true;
  schema: "pkm.native-classification-root-adoption/v1";
  phase: "prepare" | "publish";
  operationId: string;
  actorId: string;
  workspaceId: string;
  sourceRootId: string;
  sourceRelative: string;
  sourceBackupRoot: string;
  sourceBackupRootPin: { dev: string; ino: string };
  sourceManifestSha256: string;
  sourceRoot: string;
  sourceRootPin: { dev: string; ino: string };
  sourceEpoch: number;
  genesisSha256: string;
  historySha256: string;
  receiptCount: number;
  layoutSha256: string;
  destination: string;
  destinationParent: { dev: string; ino: string };
  stageWorkspaceRoot: string | null;
  stageWorkspacePin: { dev: string; ino: string } | null;
  stageRoot: string | null;
  stageRootPin: { dev: string; ino: string } | null;
  stageParent: { dev: string; ino: string } | null;
}

export interface NativeClassificationAdoptionApproval {
  authorityId: string;
  actorId: string;
  requestSha256: string;
  policyIdentity: string;
  trustedEpoch: number;
  expiresAt: number;
}

export interface NativeRestoreAuthority {
  actorId: string;
  /** Independent, rollback-resistant native policy; never derive it from the selected backup. */
  authorize(request: Readonly<NativeRestoreAuthorityRequest>): Promise<{
    authorityId: string;
    requestSha256: string;
    actorId: string;
    expiresAt: number;
    lineage: "unrelated" | "erasure-protected";
    trustedEpoch: number | null;
  } | null>;
  authorizeClassificationAdoption?(request: Readonly<NativeClassificationAdoptionRequest>):
    NativeClassificationAdoptionApproval | null;
}

export interface WorkspaceBackupOptions {
  limits?: Partial<WorkspaceBackupLimits>;
  pythonExecutable?: string;
  /** Trusted host atomic NO-REPLACE publication; must not overwrite an existing destination. */
  nativePublishNoReplace?(stage: string, destination: string): Promise<void>;
  database?: DatabaseSync;
  nativeRestoreAuthority?: NativeRestoreAuthority;
  classificationBackup?: NativeClassificationBackupAuthority;
  skillSourceBackup?: NativeSkillSourceBackupAuthority;
  subscriptionIdentity?: NativeSubscriptionIdentityPolicy;
  /** Restore-only, explicit local exact-content model sources. Never persisted in the archive. */
  modelReconstructionSources?: readonly { packageId: string; sourceRoot: string }[];
  legacyTrash?: {
    actorId: string;
    trustedImportPlanSha256: string;
    expectedManifestSha256?: string;
    snapshotScope: LegacyTrashSnapshotScope;
    /** A supplied database is borrowed; close() must leave it open. */
    hostFactory(root: string, workspaceId: string, database: DatabaseSync | undefined,
      authority: Pick<NonNullable<WorkspaceBackupOptions["legacyTrash"]>, "actorId" | "trustedImportPlanSha256" | "snapshotScope">):
      Promise<LegacyTrashNativeHost & { close(): Promise<void> }>;
  };
}

export interface NativeStrictClassificationBackupAuthority extends Pick<NativeBatch16ClassificationPolicy,
  "scope" | "sourceRelative" | "sourceRootId" | "assertFixtureOwnership" | "assertHistoryAnchor" | "assertAdoptionAnchor"> {
  originalCompatible?: never;
  actorId: string;
  authorize(request: Readonly<NativeClassificationBackupRequest>): {
    actorId: string; requestSha256: string; expiresAt: number; epoch: number;
  } | null;
}
export type NativeClassificationBackupAuthority = NativeStrictClassificationBackupAuthority | (
  OriginalClassificationBackupPolicy & Pick<NativeStrictClassificationBackupAuthority, "scope" | "sourceRelative" | "actorId" | "authorize">);
function verifyClassificationHistory(db: DatabaseSync, workspaceId: string, root: string, policy: NativeClassificationBackupAuthority) {
  return policy.originalCompatible ? verifyOriginalClassificationBackupHistory(db, workspaceId, root, policy)
    : verifyBatch16ClassificationHistory(db, workspaceId, root, policy);
}
function verifyClassificationBackup(db: DatabaseSync, request: NativeClassificationBackupRequest, root: string, policy: NativeClassificationBackupAuthority) {
  if (!!request.originalCompatible !== !!policy.originalCompatible)
    throw new WorkspaceBackupError("RECOVERY_AUTHORITY_REQUIRED", "Classification source contract and native authority differ.");
  return policy.originalCompatible ? verifyOriginalClassificationBackup(db, request, root, policy)
    : verifyBatch16ClassificationBackup(db, request, root, policy);
}

export interface NativeClassificationBackupRequest {
  originalCompatible?: true;
  schema: "pkm.native-classification-backup/v1";
  actorId: string; workspaceId: string; workspaceRoot: string; workspaceDevice: string; workspaceInode: string;
  sourceRelative: string; sourceRootId: string; rootDevice: string; rootInode: string;
  genesisSha256: string; historySha256: string; layoutSha256: string; destination: string;
}

interface ClassificationBackupPin {
  request: NativeClassificationBackupRequest;
  epoch: number;
}

export interface WorkspaceBackupManifest {
  schema: typeof backupSchema;
  workspaceSchema: typeof workspaceSchema;
  workspaceId: string;
  databaseUserVersion: number;
  files: Array<{ path: string; size: number; sha256: string; mode?: number; mtimeNs?: string }>;
  directories: string[];
  archivedDirectoryModes?: Array<{ path: string; mode: number }>;
  totalBytes: number;
  classification?: ClassificationBackupPin;
  skillSource?: SkillSourceBackupPin;
  modelReconstruction?: ModelReconstructionManifest;
}

export interface WorkspaceBackupResult {
  backupPath: string;
  workspaceId: string;
  fileCount: number;
  totalBytes: number;
  manifestSha256: string;
}

export interface WorkspaceRestoreResult {
  destination: string;
  workspaceId: string;
  fileCount: number;
  totalBytes: number;
  manifestSha256: string;
}

export class WorkspaceBackupError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

async function validateSourceWorkspace(path: string): Promise<string> {
  try { return await validateWorkspace(path); }
  catch { throw new WorkspaceBackupError("INVALID_WORKSPACE", "Source is not a valid isolated next-server workspace."); }
}

function legacyTrashReceiptRow(database: DatabaseSync, workspaceId: string): unknown {
  const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_trash_import_receipt'").get();
  return table ? database.prepare("SELECT 1 FROM legacy_trash_import_receipt WHERE workspace_id=?").get(workspaceId) : undefined;
}

async function assertLegacyTrashHost(host: LegacyTrashNativeHost, root: string, workspaceId: string,
  database: DatabaseSync | undefined, options: NonNullable<WorkspaceBackupOptions["legacyTrash"]>): Promise<void> {
  if (!host.snapshotScope) throw new WorkspaceBackupError("AUTHORITY_REQUIRED", "Trash backup host omitted its native exclusion scope.");
  const expectedScope = qualifyLegacyTrashSnapshotScope(options.snapshotScope, true);
  const actualScope = qualifyLegacyTrashSnapshotScope(host.snapshotScope, true);
  if (host.root !== root || host.workspaceId !== workspaceId || database && host.database !== database
    || host.trustedImportPlanSha256 !== options.trustedImportPlanSha256
    || JSON.stringify({ root: [...actualScope.excludedRootNames].sort(), state: [...actualScope.excludedStateNames].sort() })
      !== JSON.stringify({ root: [...expectedScope.excludedRootNames].sort(), state: [...expectedScope.excludedStateNames].sort() })) {
    throw new WorkspaceBackupError("AUTHORITY_REQUIRED", "Trash backup host is not bound to the exact root, DB, workspace, source plan, and snapshot scope.");
  }
  const main = host.database.prepare("PRAGMA database_list").all().find(row => row.name === "main");
  if (!main?.file || await realpath(String(main.file)) !== coreDatabasePath(root)) {
    throw new WorkspaceBackupError("AUTHORITY_REQUIRED", "Trash backup host database is not the selected workspace database.");
  }
}

async function inspectWorkspaceLegacyTrash(
  root: string,
  workspaceId: string,
  databaseForRows: DatabaseSync | undefined,
  hostDatabase: DatabaseSync | undefined,
  options: NonNullable<WorkspaceBackupOptions["legacyTrash"]> | undefined,
): Promise<{ receipt: LegacyTrashAdoptionReceipt; inventory: string } | undefined> {
  const marker = await lstat(join(root, legacyTrashMarker)).then(() => true, error =>
    (error as NodeJS.ErrnoException).code === "ENOENT" ? false : Promise.reject(error));
  const receiptRow = databaseForRows ? legacyTrashReceiptRow(databaseForRows, workspaceId) : undefined;
  if (marker && !receiptRow) throw new WorkspaceBackupError("INVALID_BACKUP", "Legacy trash marker has no native adoption receipt.");
  if (!receiptRow) return undefined;
  if (!options || !/^[a-f0-9]{64}$/.test(options.trustedImportPlanSha256)
    || !options.actorId || typeof options.hostFactory !== "function") {
    throw new WorkspaceBackupError("AUTHORITY_REQUIRED", "Legacy trash backup requires an externally trusted plan, actor, scope, and host.");
  }
  const native = await options.hostFactory(root, workspaceId, hostDatabase ?? databaseForRows, options);
  try {
    await assertLegacyTrashHost(native, root, workspaceId, hostDatabase ?? databaseForRows, options);
    authorizeLegacyTrashNative(native, options.actorId, "knowledge.trash.backup");
    const inspected = await inspectLegacyTrashNative(native);
    return { receipt: inspected.receipt, inventory: JSON.stringify(inspected.snapshot.inventory.map(({ dev: _dev, ino: _ino, ...item }) => item)) };
  } finally { await native.close(); }
}

async function rebindWorkspaceLegacyTrash(
  root: string,
  workspaceId: string,
  hasReceipt: boolean,
  manifestSha256: string,
  options: NonNullable<WorkspaceBackupOptions["legacyTrash"]> | undefined,
): Promise<boolean> {
  if (!hasReceipt) return false;
  if (!options || options.expectedManifestSha256 !== manifestSha256) {
    throw new WorkspaceBackupError("AUTHORITY_REQUIRED", "Restoring imported trash requires an externally trusted exact backup manifest digest.");
  }
  const native = await options.hostFactory(root, workspaceId, undefined, options);
  try {
    await assertLegacyTrashHost(native, root, workspaceId, undefined, options);
    authorizeLegacyTrashNative(native, options.actorId, "knowledge.trash.backup");
    const row = native.database.prepare("SELECT receipt_json FROM legacy_trash_import_receipt WHERE workspace_id=?").get(workspaceId);
    if (!row || typeof row.receipt_json !== "string") {
      throw new WorkspaceBackupError("INVALID_BACKUP", "Restored trash marker has no native adoption receipt.");
    }
    const receipt = JSON.parse(String(row.receipt_json)) as LegacyTrashAdoptionReceipt;
    await native.withWriterLock(() => rebindLegacyTrashBackup(native, receipt, manifestSha256));
    await inspectLegacyTrashNative(native);
    return true;
  } finally { await native.close(); }
}

interface FilePin {
  path: string;
  size: number;
  sha256: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  mtimeNs: string;
  mode?: number;
}

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function verifyProjectEnvelopeAdoption(database: DatabaseSync, workspaceId: string): void {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_project_envelope'").get();
  if (!exists) return;
  try {
    if (!readLegacyProjectEnvelopeAdoption(database, workspaceId)) throw new Error("Missing adoption receipt.");
  } catch {
    throw new WorkspaceBackupError("INVALID_WORKSPACE", "Opaque ProjectStore bytes or their native adoption receipt failed backup verification.");
  }
}
const within = (parent: string, candidate: string) => {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

function limitsFor(input?: Partial<WorkspaceBackupLimits>): WorkspaceBackupLimits {
  const allowed = new Set(["maxFiles", "maxDepth", "maxFileBytes", "maxTotalBytes"]);
  if (input && Object.keys(input).some(key => !allowed.has(key))) {
    throw new WorkspaceBackupError("INVALID_LIMIT", "Unknown workspace backup limit.");
  }
  const limits = { ...defaultWorkspaceBackupLimits, ...input };
  for (const [name, value] of Object.entries(limits)) {
    const ceiling = defaultWorkspaceBackupLimits[name as keyof WorkspaceBackupLimits];
    if (!Number.isSafeInteger(value) || value <= 0 || ceiling !== undefined && value > ceiling) {
      throw new WorkspaceBackupError("INVALID_LIMIT", `Invalid ${name} backup limit.`);
    }
  }
  return limits;
}

function safeRelativePath(path: unknown, maxDepth?: number): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096 || path.includes("\\") || path.includes("\0")) return false;
  if (path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === ".." || part.includes(":"))) return false;
  return maxDepth === undefined || path.split("/").length <= maxDepth;
}

async function assertRealDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  let current: string = sep;
  for (const part of absolute.slice(sep.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorkspaceBackupError("INVALID_PATH", "The requested directory or one of its parents does not exist.");
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new WorkspaceBackupError("UNSAFE_PATH", "Workspace backup paths must not contain symlink or file components.");
  }
  const canonical = await realpath(absolute);
  if (canonical !== absolute) throw new WorkspaceBackupError("UNSAFE_PATH", "Workspace backup paths must not resolve through aliases.");
  return canonical;
}

async function assertNoSymlinkParents(root: string, path: string): Promise<void> {
  let current = root;
  for (const part of path.split("/").slice(0, -1)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new WorkspaceBackupError("UNSAFE_PATH", "Workspace paths cannot contain symlink or file parents.");
  }
}

function snapshotModePath(path: string) {
  return path.startsWith("packages/knowledge-snapshots/") || /^(notes|skills|papers|prompts|scripts)\//.test(path)
    || path === ".pkm/content-privacy.json";
}
async function readPinnedFile(root: string, path: string, limit: number, snapshotModes = false): Promise<{ bytes: Buffer; pin: FilePin }> {
  const preserveMode = isLegacyLibraryPath(path) && !isLegacyCodePath(path) || isArchivedCodePath(path)
    || snapshotModes && snapshotModePath(path);
  const physicalPath = path.startsWith("runtime-control/") && workspaceStoragePaths(root).layout === "separated"
    ? `${serverDataDirectory}/${path}` : path;
  const fullPath = join(root, ...physicalPath.split("/"));
  await assertNoSymlinkParents(root, physicalPath);
  let before;
  try { before = await lstat(fullPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorkspaceBackupError("SOURCE_CHANGED", `Workspace entry disappeared: ${path}`);
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new WorkspaceBackupError("UNSAFE_ENTRY", `Workspace entry is not a bounded regular file: ${path}`);
  }
  if (isArchivedCodePath(path) && (before.nlink !== 1 || (before.mode & 0o7000) !== 0))
    throw new WorkspaceBackupError("UNSAFE_ENTRY", "Inert archive files must be single-link regular files with ordinary modes.");
  if (before.size > limit) throw new WorkspaceBackupError("QUOTA_EXCEEDED", `Workspace entry exceeds the per-file backup limit: ${path}`);
  const handle = await open(fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    const openedExact = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
      || preserveMode && opened.mode !== before.mode) {
      throw new WorkspaceBackupError("SOURCE_CHANGED", `Workspace entry changed while being pinned: ${path}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const afterExact = await handle.stat({ bigint: true });
    await assertNoSymlinkParents(root, physicalPath);
    const pathAfter = await lstat(fullPath);
    if (bytes.length !== before.size || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || openedExact.mtimeNs !== afterExact.mtimeNs || openedExact.ctimeNs !== afterExact.ctimeNs
      || pathAfter.isSymbolicLink() || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino
      || preserveMode && (after.mode !== opened.mode || pathAfter.mode !== opened.mode)) {
      throw new WorkspaceBackupError("SOURCE_CHANGED", `Workspace entry changed while being pinned: ${path}`);
    }
    return {
      bytes,
      pin: { path, size: bytes.length, sha256: digest(bytes), dev: opened.dev, ino: opened.ino, mtimeMs: opened.mtimeMs, mtimeNs: openedExact.mtimeNs.toString(),
        ...(preserveMode && process.platform !== "win32" ? { mode: opened.mode & 0o777 } : {}) },
    };
  } finally { await handle.close(); }
}

async function listFiles(root: string, limits: WorkspaceBackupLimits): Promise<{ files: string[]; directories: string[] }> {
  const paths: string[] = [];
  const directories: string[] = [];
  const storagePaths = workspaceStoragePaths(root);
  async function visit(directory: string, prefix: string, depth: number): Promise<void> {
    const pending = [{ directory, prefix, depth }];
    while (pending.length) {
      const current = pending.pop()!;
      if (limits.maxDepth !== undefined && current.depth > limits.maxDepth) throw new WorkspaceBackupError("QUOTA_EXCEEDED", "Workspace directory depth exceeds the backup limit.");
      const entries = await readdir(current.directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const path = current.prefix ? `${current.prefix}/${entry.name}` : entry.name;
        if (!safeRelativePath(path, limits.maxDepth)) throw new WorkspaceBackupError("UNSAFE_PATH", "Workspace contains an unsafe relative path.");
        const full = join(current.directory, entry.name);
        const stat = await lstat(full);
        if (stat.isSymbolicLink()) throw new WorkspaceBackupError("UNSAFE_ENTRY", `Workspace symlinks are not supported: ${path}`);
        if (stat.isDirectory()) { directories.push(path); pending.push({ directory: full, prefix: path, depth: current.depth + 1 }); continue; }
        if (!stat.isFile()) throw new WorkspaceBackupError("UNSAFE_ENTRY", `Workspace contains a non-regular entry: ${path}`);
        if (coreDatabaseSidecarFiles.includes(path)) continue;
        paths.push(path);
        if (paths.length > limits.maxFiles) throw new WorkspaceBackupError("QUOTA_EXCEEDED", "Workspace file count exceeds the backup limit.");
      }
    }
  }
  for (const file of inspectWorkspaceRuntimeControls(root, true)) {
    const path = `runtime-control/${file}`;
    paths.push(path);
    for (let parts = path.split("/").slice(0, -1); parts.length; parts = parts.slice(0, -1)) {
      const directory = parts.join("/");
      if (!directories.includes(directory)) directories.push(directory);
    }
  }
  for (const name of await readdir(root)) {
    if (coreDatabaseSidecarFiles.includes(name) || codingProcessDatabaseFiles.slice(1).includes(name)) continue;
    if (name === managedRuntimeDirectory || name === storageLayoutMarker || name === ".gitignore" || name === ".git") continue;
    if (name === "runtime-control") continue;
    if (name === serverDataDirectory && storagePaths.layout === "separated") {
      paths.push(coreDatabaseFile);
      if ((await readdir(storagePaths.serverData)).includes(codingProcessDatabaseFile)) paths.push(codingProcessDatabaseFile);
      continue;
    }
    if (process.platform === "linux" && name === ".pkm-next-writer-fenced.json") {
      await assertLinuxRootOwnerMarker(root);
      continue;
    }
    if (name === ".pkm-action-builds") {
      const stat = await lstat(join(root, name));
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()))
        throw new WorkspaceBackupError("UNSAFE_ENTRY", "Action build directory is unsafe.");
      continue;
    }
    if (name === ".pkm-action-authority" || name === ".pkm-plugin-authority") {
      const directory = join(root, name), stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()))
        throw new WorkspaceBackupError("UNSAFE_ENTRY", "Action authority directory is unsafe.");
      const files = await readdir(directory);
      if (files.some(file => file !== "host-authority.json"))
        throw new WorkspaceBackupError("UNSAFE_ENTRY", "Action authority directory contains unexpected entries.");
      if (files.length) {
        const file = await lstat(join(directory, files[0]));
        if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 8192
          || process.platform !== "win32" && ((file.mode & 0o077) !== 0 || process.getuid && file.uid !== process.getuid()))
          throw new WorkspaceBackupError("UNSAFE_ENTRY", "Action authority record is unsafe.");
      }
      continue;
    }
    if (name === workspaceMarker || name === legacyTrashMarker || name === coreDatabaseFile || name === codingProcessDatabaseFile || allowedDirectories.has(name)) {
      const stat = await lstat(join(root, name));
      if (stat.isSymbolicLink()) throw new WorkspaceBackupError("UNSAFE_ENTRY", `Workspace symlinks are not supported: ${name}`);
      if (allowedDirectories.has(name) && stat.isDirectory()) {
        directories.push(name);
        await visit(join(root, name), name, 1);
      }
      else if ((name === workspaceMarker || name === legacyTrashMarker || name === coreDatabaseFile || name === codingProcessDatabaseFile) && stat.isFile()) paths.push(name);
      else if (allowedDirectories.has(name) && !stat.isDirectory()) throw new WorkspaceBackupError("UNSAFE_ENTRY", `Workspace directory is invalid: ${name}`);
      else if ((name === workspaceMarker || name === legacyTrashMarker || name === coreDatabaseFile || name === codingProcessDatabaseFile) && !stat.isFile()) throw new WorkspaceBackupError("UNSAFE_ENTRY", `Workspace file is invalid: ${name}`);
    } else {
      throw new WorkspaceBackupError("UNSAFE_ENTRY", `Workspace contains an unrecognized entry: ${name}`);
    }
  }
  if (!paths.includes(workspaceMarker) || !paths.includes(coreDatabaseFile)) {
    throw new WorkspaceBackupError("INVALID_WORKSPACE", "Workspace marker or SQLite database is missing.");
  }
  return { files: paths.sort(), directories: directories.sort() };
}

const classifiedBackupValidation = Symbol("classifiedBackupValidation");
const pairedMemoryValidation = Symbol("pairedMemoryValidation");
const skillSourceBackupValidation = Symbol("skillSourceBackupValidation");
export function assertWorkspaceBackupQuiescent(database: DatabaseSync, validatedClassification?: typeof classifiedBackupValidation,
  memoryValidation?: typeof pairedMemoryValidation, validatedSkillSource?: typeof skillSourceBackupValidation): void {
  if (database.isTransaction) throw new WorkspaceBackupError("TRANSACTION_BOUNDARY", "Backup requires an idle shared database.");
  if (Number(database.prepare("PRAGMA user_version").get()?.user_version) >= 22) verifyLegacyClassificationCommandSchema(database);
  const sourceActivity = assertSkillSourceIntegrated(database, validatedSkillSource === skillSourceBackupValidation);
  if (sourceActivity.pending) throw new WorkspaceBackupError("PENDING_JOURNAL", "Canonical Skill source intent must be recovered before backup.");
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  if (tables.some(table => table.name === "legacy_snapshot_restore_schema") && inspectPausedSnapshotJournal(database))
    throw new WorkspaceBackupError("PENDING_JOURNAL", "Unknown native Snapshot effects require explicit confirmation before backup.");
  if (tables.some(table => table.name === "legacy_memory_erasure_operations")) {
    if (database.prepare("SELECT 1 FROM legacy_memory_erasure_operations WHERE status IS NULL OR status<>'committed' LIMIT 1").get())
      throw new WorkspaceBackupError("PENDING_JOURNAL", "Unknown native memory erasure requires explicit reconciliation before backup.");
  }
  if (tables.some(table => /^legacy_memory_erasure_(?:schema|state|operations)$/.test(table.name))) {
    const main = database.prepare("PRAGMA database_list").all().find(row => row.name === "main");
    if (!main?.file) throw new WorkspaceBackupError("AUTHORITY_REQUIRED", "Memory ledger requires a pinned workspace identity.");
    const workspaceId = JSON.parse(readFileSync(join(workspaceRootForDatabase(String(main.file)), workspaceMarker), "utf8")).id;
    if (validateLegacyMemoryErasureLedger(database, workspaceId).state !== "uninitialized" && memoryValidation !== pairedMemoryValidation)
      throw new WorkspaceBackupError("AUTHORITY_REQUIRED", "Memory-erasure backups require an external trusted epoch restore gate.");
  }

  assertBatch16UnintegratedClear(database, false, undefined, validatedClassification === classifiedBackupValidation,
    memoryValidation === pairedMemoryValidation, validatedClassification === classifiedBackupValidation);
  for (const { name } of tables) {
    if (name !== "legacy_command_extension_intent" && name !== "legacy_recipe_trash_intent" && name !== "legacy_inline_note_intent" && name !== "legacy_skill_native_intent" && name !== "legacy_classification_native_intent" && name !== "legacy_classification_command_intent" && !/(^pending_|_pending$|journal|_intents$)/i.test(name)) continue;
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const where = name === "remote_runtime_intents"
      ? " WHERE NOT (kind='remote.subscription.bundle' AND state='complete')" : "";
    if (database.prepare(`SELECT 1 FROM ${quoted}${where} LIMIT 1`).get()) {
      throw new WorkspaceBackupError("PENDING_JOURNAL", "Workspace has a pending or unknown durable journal; recover it before backup.");
    }
    const activeChecks = [
      ["chat_turn_records", "status IN ('queued','model','tool','approval')"],
      ["runtime_process_jobs", "state IN ('QUEUED','RUNNING')"],
      ["action_runtime_runs", "json_extract(snapshot,'$.state') IN ('ready','running','cancelling')"],
      ["workflow_executor_runs", "json_extract(snapshot,'$.state') IN ('ready','running')"],
      ["manager_runtime_runs", "json_extract(record,'$.state') IN ('active','paused') OR json_extract(record,'$.effect') IS NOT NULL"],
      ["agent_runtime_sessions", "state IN ('intent','spawn-unknown','running','cancel-requested')"],
    ] as const;
    for (const [name, predicate] of activeChecks) {
      if (tables.some(table => table.name === name) && database.prepare(`SELECT 1 FROM "${name}" WHERE ${predicate} LIMIT 1`).get()) {
        throw new WorkspaceBackupError("ACTIVE_RUNTIME", "Workspace still contains queued, active, or unresolved native work.");
      }
    }
  }
}

export { createPairedMemoryWorkspaceBackup, restorePairedMemoryWorkspaceBackup, openPairedMemoryWorkspaceWorker }
  from "./legacy-memory-engine-backup-paired.js";

export function assertPairedMemoryWorkspaceIdle(database: DatabaseSync, workspaceId: string): void {
  const ledger = validateLegacyMemoryErasureLedger(database, workspaceId);
  if (ledger.operations.some(item => item.status !== "committed"))
    throw new WorkspaceBackupError("PENDING_JOURNAL", "Paired snapshot requires committed erasure history.");
  assertWorkspaceBackupQuiescent(database, undefined, pairedMemoryValidation);
}

function validateMarker(bytes: Uint8Array, expectedWorkspaceId?: string): string {
  let marker: unknown;
  try { marker = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw new WorkspaceBackupError("INVALID_WORKSPACE", "Workspace identity marker is invalid."); }
  if (!marker || typeof marker !== "object" || (marker as { schema?: unknown }).schema !== workspaceSchema
    || typeof (marker as { id?: unknown }).id !== "string"
    || !workspaceIdPattern.test((marker as { id: string }).id)
    || expectedWorkspaceId !== undefined && (marker as { id: string }).id !== expectedWorkspaceId) {
    throw new WorkspaceBackupError("INVALID_WORKSPACE", "Workspace identity marker disagrees with the backup manifest.");
  }
  return (marker as { id: string }).id;
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectoryTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new WorkspaceBackupError("UNSAFE_PATH", "Cannot synchronize an unsafe directory entry.");
    await syncDirectoryTree(path);
    await syncDirectory(path);
  }
  await syncDirectory(root);
}

function publishNoReplace(stage: string, destination: string, pythonExecutable: string, keepAlive?: number): void {
  try {
    renameNoReplaceSync(stage, destination, pythonExecutable, keepAlive);
  } catch (error) {
    if (!(error instanceof RenameNoReplaceError)) throw error;
    if (error.code === "DESTINATION_EXISTS") throw new WorkspaceBackupError("DESTINATION_EXISTS", error.message);
    if (error.code === "UNAVAILABLE") throw new WorkspaceBackupError("UNSUPPORTED_PLATFORM", error.message);
    throw new WorkspaceBackupError("PUBLISH_FAILED", error.message);
  }
}

async function prepareAbsentDestination(destination: string): Promise<{ target: string; parent: string }> {
  if (!isAbsolute(destination)) throw new WorkspaceBackupError("INVALID_PATH", "Provide an absolute destination path.");
  const target = resolve(destination);
  const parent = await assertRealDirectory(dirname(target));
  if (parent !== dirname(target)) throw new WorkspaceBackupError("UNSAFE_PATH", "Destination parent must be canonical.");
  try {
    await lstat(target);
    throw new WorkspaceBackupError("DESTINATION_EXISTS", "Destination must be absent; existing paths are never overwritten.");
  } catch (error) {
    if (error instanceof WorkspaceBackupError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { target, parent };
}

async function directoryPin(path: string): Promise<{ dev: string; ino: string }> {
  const stat = await lstat(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(path) !== path)
    throw new WorkspaceBackupError("UNSAFE_PATH", "Classification adoption paths must be canonical real directories.");
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function directoryPinSync(path: string): { dev: string; ino: string } {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(path) !== path)
    throw new WorkspaceBackupError("UNSAFE_PATH", "Classification adoption paths must be canonical real directories.");
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function assertRestoreDatabaseOwner(database: DatabaseSync, stage: string): void {
  const main = database.prepare("PRAGMA database_list").all().find(item => item.name === "main");
  if (database.isTransaction || !main?.file || resolve(String(main.file)) !== coreDatabasePath(stage))
    throw new WorkspaceBackupError("TRANSACTION_BOUNDARY", "Restore SQLite writes require the idle database owned by this staging directory.");
}

async function restoreClassificationModes(root: string, entries: NonNullable<Awaited<ReturnType<typeof verifyBackup>>["classificationLayout"]>) {
  for (const entry of entries.filter(item => item.kind === "file")) {
    await chmod(join(root, ...entry.path.split("/")), entry.mode);
  }
  for (const entry of entries.filter(item => item.kind === "directory").sort((a, b) => b.path.length - a.path.length)) {
    await chmod(join(root, ...entry.path.split("/")), entry.mode);
  }
}

function validateManifest(value: unknown, limits: WorkspaceBackupLimits): WorkspaceBackupManifest {
  const invalid = (): never => { throw new WorkspaceBackupError("INVALID_MANIFEST", "Backup manifest is malformed or unsupported."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).filter(key => key !== "archivedDirectoryModes" && key !== "modelReconstruction").sort().join(",");
  if (!["databaseUserVersion,directories,files,schema,totalBytes,workspaceId,workspaceSchema",
    "classification,databaseUserVersion,directories,files,schema,totalBytes,workspaceId,workspaceSchema",
    "databaseUserVersion,directories,files,schema,skillSource,totalBytes,workspaceId,workspaceSchema",
    "classification,databaseUserVersion,directories,files,schema,skillSource,totalBytes,workspaceId,workspaceSchema"].includes(keys)
    || item.schema !== backupSchema || item.workspaceSchema !== workspaceSchema
    || typeof item.workspaceId !== "string" || !workspaceIdPattern.test(item.workspaceId)
    || !supportedDatabaseVersions.has(Number(item.databaseUserVersion)) || !Array.isArray(item.files) || !Array.isArray(item.directories)
    || !Number.isSafeInteger(item.totalBytes) || Number(item.totalBytes) > limits.maxTotalBytes
    || item.files.length > limits.maxFiles || item.directories.length > limits.maxFiles) invalid();
  const files: WorkspaceBackupManifest["files"] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const raw of item.files as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
    const file = raw as Record<string, unknown>;
    if (!["path,sha256,size", "mode,path,sha256,size", "mtimeNs,path,sha256,size", "mode,mtimeNs,path,sha256,size"].includes(Object.keys(file).sort().join(","))
      || !safeRelativePath(file.path, limits.maxDepth)
      || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.size) || Number(file.size) < 0 || Number(file.size) > limits.maxFileBytes) invalid();
    const path = file.path as string;
    if (isArchivedCodePath(path) && process.platform !== "win32" && !("mode" in file)) invalid();
    if ("mode" in file && (!(isLegacyLibraryPath(path) && !isLegacyCodePath(path) || isArchivedCodePath(path) || [25, 26, 27, 28].includes(Number(item.databaseUserVersion)) && snapshotModePath(path)) || typeof file.mode !== "number"
      || !Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777)) invalid();
    if ("mtimeNs" in file && (!preservesSourceMtime(path)
      || typeof file.mtimeNs !== "string" || !mtimeNanosecondsPattern.test(file.mtimeNs))) invalid();
    if (seen.has(path) || path === manifestName || coreDatabaseSidecarFiles.includes(path)
      || !(path === workspaceMarker || path === coreDatabaseFile || path === codingProcessDatabaseFile || [...allowedDirectories].some(area => path.startsWith(`${area}/`)))) invalid();
    seen.add(path);
    total += Number(file.size);
    if (total > limits.maxTotalBytes) throw new WorkspaceBackupError("QUOTA_EXCEEDED", "Backup bytes exceed the configured total limit.");
    files.push({ path, size: Number(file.size), sha256: file.sha256 as string,
      ...(typeof file.mode === "number" ? { mode: file.mode } : {}),
      ...(typeof file.mtimeNs === "string" ? { mtimeNs: file.mtimeNs } : {}) });
  }
  const directories: string[] = [];
  const seenDirectories = new Set<string>();
  for (const raw of item.directories as unknown[]) {
    if (!safeRelativePath(raw, limits.maxDepth)) invalid();
    const directory = raw as string;
    if (!(allowedDirectories.has(directory) || [...allowedDirectories].some(area => directory.startsWith(`${area}/`)))
      || seenDirectories.has(directory) || seen.has(directory)) invalid();
    seenDirectories.add(directory);
    directories.push(directory);
  }
  if (directories.some((path, index) => index > 0 && directories[index - 1] >= path)) invalid();
  const archivedDirectoryModes: NonNullable<WorkspaceBackupManifest["archivedDirectoryModes"]> = [];
  if ("archivedDirectoryModes" in item) {
    if (!Array.isArray(item.archivedDirectoryModes) || item.archivedDirectoryModes.length > limits.maxFiles) invalid();
    for (const raw of item.archivedDirectoryModes as unknown[]) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
      const entry = raw as Record<string, unknown>;
      if (Object.keys(entry).sort().join(",") !== "mode,path" || typeof entry.path !== "string"
        || !isArchivedCodePath(entry.path) || !seenDirectories.has(entry.path)
        || !Number.isSafeInteger(entry.mode) || Number(entry.mode) < 0 || Number(entry.mode) > 0o777
        || archivedDirectoryModes.length > 0 && archivedDirectoryModes.at(-1)!.path >= (entry.path as string)) invalid();
      archivedDirectoryModes.push({ path: entry.path as string, mode: Number(entry.mode) });
    }
    if (directories.filter(isArchivedCodePath).length !== archivedDirectoryModes.length) invalid();
  } else if (directories.some(isArchivedCodePath)) invalid();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index++) {
      if (!seenDirectories.has(parts.slice(0, index).join("/"))) invalid();
    }
  }
  for (const directory of directories) {
    const parts = directory.split("/");
    for (let index = 1; index < parts.length; index++) {
      if (!seenDirectories.has(parts.slice(0, index).join("/"))) invalid();
    }
  }
  if (total !== item.totalBytes || !seen.has(workspaceMarker) || !seen.has(coreDatabaseFile)
    || files.some((file, index) => index > 0 && files[index - 1].path >= file.path)) invalid();
  let classification: ClassificationBackupPin | undefined;
  if (item.classification !== undefined) {
    const pin = item.classification as ClassificationBackupPin;
    if (!pin || typeof pin !== "object" || Object.keys(pin).sort().join(",") !== "epoch,request"
      || !Number.isSafeInteger(pin.epoch) || pin.epoch < 0 || !pin.request || typeof pin.request !== "object"
      || Object.keys(pin.request).sort().join(",") !== (pin.request.originalCompatible === true
        ? "actorId,destination,genesisSha256,historySha256,layoutSha256,originalCompatible,rootDevice,rootInode,schema,sourceRelative,sourceRootId,workspaceDevice,workspaceId,workspaceInode,workspaceRoot"
        : "actorId,destination,genesisSha256,historySha256,layoutSha256,rootDevice,rootInode,schema,sourceRelative,sourceRootId,workspaceDevice,workspaceId,workspaceInode,workspaceRoot")
      || pin.request.schema !== "pkm.native-classification-backup/v1" || pin.request.workspaceId !== item.workspaceId
      || typeof pin.request.actorId !== "string" || !pin.request.actorId || pin.request.actorId.length > 256
      || /[\u0000-\u001f\u007f]/u.test(pin.request.actorId)
      || !safeRelativePath(pin.request.sourceRelative, limits.maxDepth) || !pin.request.sourceRelative.startsWith("packages/")
      || ![pin.request.workspaceRoot, pin.request.destination].every(path => typeof path === "string" && isAbsolute(path) && resolve(path) === path)
      || ![pin.request.sourceRootId, pin.request.genesisSha256, pin.request.historySha256, pin.request.layoutSha256]
        .every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
      || ![pin.request.workspaceDevice, pin.request.workspaceInode, pin.request.rootDevice, pin.request.rootInode]
        .every(value => typeof value === "string" && /^\d+$/.test(value))) invalid();
    classification = pin;
  }
  return {
    schema: backupSchema, workspaceSchema, workspaceId: item.workspaceId as string,
    databaseUserVersion: Number(item.databaseUserVersion), files, directories, totalBytes: total,
    ...(archivedDirectoryModes.length ? { archivedDirectoryModes } : {}),
    ...(classification ? { classification } : {}),
    ...(item.skillSource !== undefined ? {
      skillSource: parseSkillSourceBackupPin(item.skillSource, item.workspaceId as string),
    } : {}),
    ...(item.modelReconstruction !== undefined ? {
      modelReconstruction: parseModelReconstructionManifest(item.modelReconstruction),
    } : {}),
  };
}

async function verifyBackup(path: string, limits: WorkspaceBackupLimits, classified?: {
  pin: ClassificationBackupPin; policy: NativeClassificationBackupAuthority;
}, skillSource?: { pin: SkillSourceBackupPin; policy: NativeSkillSourceBackupAuthority },
  subscriptionIdentity?: { policy?: NativeSubscriptionIdentityPolicy; purpose: "backup" | "restore"; destination: string }): Promise<{
  manifest: WorkspaceBackupManifest; manifestSha256: string; hasLegacyTrashReceipt: boolean;
  classificationLayout?: ReturnType<typeof scanNativeClassification>["entries"];
}> {
  const root = await assertRealDirectory(path);
  let manifestBytes: Buffer;
  try {
    const entry = await lstat(join(root, manifestName));
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size > 4 * 1024 * 1024) throw new WorkspaceBackupError("INVALID_MANIFEST", "Backup manifest must be a bounded regular file.");
    manifestBytes = (await readPinnedFile(root, manifestName, 4 * 1024 * 1024)).bytes;
  } catch (error) {
    if (error instanceof WorkspaceBackupError) throw error;
    throw new WorkspaceBackupError("INVALID_MANIFEST", "Backup manifest is missing or unreadable.");
  }
  let manifest: WorkspaceBackupManifest;
  try { manifest = validateManifest(JSON.parse(manifestBytes.toString("utf8")), limits); }
  catch (error) {
    if (error instanceof WorkspaceBackupError) throw error;
    throw new WorkspaceBackupError("INVALID_MANIFEST", "Backup manifest is malformed or unsupported.");
  }
  const inventory = await listBackupFiles(root, limits);
  const expectedPaths = manifest.files.map(file => file.path);
  if (inventory.files.join("\n") !== expectedPaths.join("\n")) throw new WorkspaceBackupError("INVALID_MANIFEST", "Backup contains missing or unlisted files.");
  const expectedDirectories = new Set<string>();
  for (const file of expectedPaths) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index++) expectedDirectories.add(parts.slice(0, index).join("/"));
  }
  if (inventory.directories.join("\n") !== manifest.directories.join("\n")
    || [...expectedDirectories].some(path => !manifest.directories.includes(path))) {
    throw new WorkspaceBackupError("INVALID_MANIFEST", "Backup contains unlisted or missing directories.");
  }
  for (const file of manifest.files) {
    const { bytes } = await readPinnedFile(root, file.path, limits.maxFileBytes);
    if (bytes.length !== file.size || digest(bytes) !== file.sha256) {
      throw new WorkspaceBackupError("HASH_MISMATCH", `Backup file verification failed: ${file.path}`);
    }
  }
  if (manifest.files.some(file => file.path === codingProcessDatabaseFile)) {
    const processDb = new DatabaseSync(codingProcessDatabasePath(root), { readOnly: true });
    try {
      if (Number(processDb.prepare("PRAGMA user_version").get()?.user_version) !== 1
        || processDb.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
        throw new WorkspaceBackupError("INVALID_BACKUP", "Coding process snapshot is not a valid durable journal.");
    } finally { processDb.close(); }
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try { await lstat(`${codingProcessDatabasePath(root)}${suffix}`); throw new WorkspaceBackupError("INVALID_BACKUP", "Coding process snapshot must be standalone."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  const marker = await readPinnedFile(root, workspaceMarker, limits.maxFileBytes);
  validateMarker(marker.bytes, manifest.workspaceId);
  inspectWorkspaceRuntimeControls(root, true);
  const db = new DatabaseSync(coreDatabasePath(root), { readOnly: true });
  let hasLegacyTrashReceipt = false;
  let classificationLayout: ReturnType<typeof scanNativeClassification>["entries"] | undefined;
  try {
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    if (version !== manifest.databaseUserVersion || !supportedDatabaseVersions.has(version)) {
      throw new WorkspaceBackupError("SCHEMA_MISMATCH", "Backup database schema version is unsupported.");
    }
    if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
      throw new WorkspaceBackupError("DATABASE_CORRUPT", "Backup database integrity check failed.");
    }
    if (version >= 16) {
      validateLegacyRecipeTrashJournalSchema(db);
      if (version >= 21) verifyNativeClassificationAdoptionSchema(db);
      if (version >= 22) verifyLegacyClassificationCommandSchema(db);
      if (manifest.classification && !classified)
        throw new WorkspaceBackupError("RECOVERY_AUTHORITY_REQUIRED",
          "Classified restore is unavailable: immutable receipt root device/inode requires an authorized adoption lineage before staging.");
      if (manifest.skillSource) {
        if (version < 23 || !skillSource || JSON.stringify(skillSource.pin) !== JSON.stringify(manifest.skillSource))
          throw new WorkspaceBackupError("RECOVERY_AUTHORITY_REQUIRED", "Canonical Skill source backup requires its independently approved exact native pin.");
        verifySkillSourceBackup(db, root, skillSource.pin, skillSource.policy);
      } else if (skillSource) {
        throw new WorkspaceBackupError("INVALID_MANIFEST", "Canonical Skill source backup omitted its native pin.");
      }
      assertWorkspaceBackupQuiescent(db, classified ? classifiedBackupValidation : undefined, undefined,
        skillSource ? skillSourceBackupValidation : undefined);
      if (manifest.classification) {
        if (!classified || JSON.stringify(manifest.classification) !== JSON.stringify(classified.pin))
          throw new WorkspaceBackupError("RECOVERY_AUTHORITY_REQUIRED", "Classified backup requires its exact source native authority; restore rebind is unavailable.");
        const request = classified.pin.request;
        let checked;
        try {
          checked = verifyClassificationBackup(db, request, root, classified.policy);
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error
            && (error as { code?: unknown }).code === "ACCESS_DENIED" ? "RECOVERY_AUTHORITY_REQUIRED" : "SOURCE_CHANGED";
          throw new WorkspaceBackupError(code, error instanceof Error ? error.message : "Classified history verification failed.");
        }
        if (checked.status.status !== "committed" || checked.genesisSha256 !== request.genesisSha256
          || checked.historySha256 !== request.historySha256 || checked.scan.layoutSha256 !== request.layoutSha256)
          throw new WorkspaceBackupError("SOURCE_CHANGED", "Classified backup bytes or modes differ from the pinned source layout.");
        classificationLayout = checked.scan.entries;
      } else if (classified) {
        throw new WorkspaceBackupError("INVALID_MANIFEST", "Classified backup omitted its native source pin.");
      }
    }
    if (version >= 17) verifyLegacyNoteWorkItemsWorkspace(db, root);
    if (version >= 18) await verifyInlineNoteWorkspace(db, root);
    if (version >= 19) verifyBatch15SkillWorkspace(db, root, !!skillSource);
    verifyProjectEnvelopeAdoption(db, manifest.workspaceId);
    if (manifest.modelReconstruction)
      verifyLegacyRetrievalModelReconstruction(db, root, manifest.modelReconstruction);
    else verifyLegacyRetrievalModels(db, root);
    verifyLegacyKnowledgeRecovery(db, root);
    verifyLegacyKnowledgeSnapshots(db, root, false,
      new Map(manifest.files.flatMap(file => file.mode === undefined ? [] : [[file.path, file.mode] as const])));
    verifyLegacyActionArtifacts(db, manifest.workspaceId);
    hasLegacyTrashReceipt = !!legacyTrashReceiptRow(db, manifest.workspaceId);
    if (manifest.files.some(file => file.path === legacyTrashMarker)) {
      throw new WorkspaceBackupError("INVALID_MANIFEST", "Authenticated trash backups omit the original adoption marker and rebind its lineage.");
    }
    if (version >= 14) {
      readLegacyStateReceipt(db, manifest.workspaceId);
      await verifyBoundLegacyStateBytes(db, root, manifest.workspaceId);
      await verifyNativeSubscriptionIdentity(db, root, manifest.workspaceId, subscriptionIdentity?.policy,
        subscriptionIdentity?.purpose ?? "restore", subscriptionIdentity?.destination ?? null);
      assertPortalRecoveryClear(db);
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_runtime_owner'").get()) {
      const owner = db.prepare("SELECT lease_until FROM native_runtime_owner WHERE singleton=1").get();
      if (owner && Number(owner.lease_until) !== 0) throw new WorkspaceBackupError("INVALID_BACKUP", "Backup contains a live workspace owner lease.");
    }
  } finally { db.close(); }
  for (const suffix of ["-wal", "-shm"]) {
    try { await lstat(`${coreDatabasePath(root)}${suffix}`); throw new WorkspaceBackupError("INVALID_BACKUP", "Backup SQLite snapshot must not depend on WAL sidecars."); }
    catch (error) {
      if (error instanceof WorkspaceBackupError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { manifest, manifestSha256: digest(manifestBytes), hasLegacyTrashReceipt, classificationLayout };
}

async function listBackupFiles(root: string, limits: WorkspaceBackupLimits): Promise<{ files: string[]; directories: string[] }> {
  const paths: string[] = [];
  const directories: string[] = [];
  async function visit(directory: string, prefix: string, depth: number): Promise<void> {
    const pending = [{ directory, prefix, depth }];
    while (pending.length) {
      const current = pending.pop()!;
      if (limits.maxDepth !== undefined && current.depth > limits.maxDepth) throw new WorkspaceBackupError("QUOTA_EXCEEDED", "Backup directory depth exceeds the limit.");
      for (const entry of (await readdir(current.directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
        const path = current.prefix ? `${current.prefix}/${entry.name}` : entry.name;
        if (!safeRelativePath(path, limits.maxDepth)) throw new WorkspaceBackupError("UNSAFE_PATH", "Backup contains an unsafe path.");
        const full = join(current.directory, entry.name), stat = await lstat(full);
        if (stat.isSymbolicLink()) throw new WorkspaceBackupError("UNSAFE_ENTRY", "Backup symlinks are not supported.");
        if (stat.isDirectory()) {
          if (!allowedDirectories.has(path) && ![...allowedDirectories].some(area => path.startsWith(`${area}/`))) {
            throw new WorkspaceBackupError("UNSAFE_PATH", "Backup contains a directory outside an allowed workspace area.");
          }
          directories.push(path);
          pending.push({ directory: full, prefix: path, depth: current.depth + 1 });
          continue;
        }
        if (!stat.isFile()) throw new WorkspaceBackupError("UNSAFE_ENTRY", "Backup contains a non-regular entry.");
        if (path === manifestName) continue;
        paths.push(path);
        if (paths.length > limits.maxFiles) throw new WorkspaceBackupError("QUOTA_EXCEEDED", "Backup file count exceeds the limit.");
      }
    }
  }
  await visit(root, "", 0);
  return { files: paths.sort(), directories: directories.sort() };
}

async function ensureBackupDirectoryTree(root: string, filePath: string): Promise<void> {
  await ensureDirectoryPath(root, filePath.split("/").slice(0, -1));
}

async function ensureDirectoryPath(root: string, parts: string[] | string): Promise<void> {
  let directory = root;
  for (const part of typeof parts === "string" ? parts.split("/") : parts) {
    directory = join(directory, part);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new WorkspaceBackupError("UNSAFE_PATH", "Could not safely create a restore directory.");
  }
}

async function withStagingDirectory<T>(parent: string, prefix: string, work: (stage: string) => Promise<T>,
  retainOnFailure?: () => boolean): Promise<T> {
  const stage = join(parent, `.${prefix}.${randomUUID()}.stage`);
  await mkdir(stage, { mode: 0o700 });
  try { return await work(stage); }
  finally {
    try {
      const stat = await lstat(stage);
      if (!stat.isSymbolicLink() && stat.isDirectory() && !retainOnFailure?.()) await rm(stage, { recursive: true, force: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export async function createWorkspaceBackup(
  storage: Storage,
  destination: string,
  host: WorkspaceBackupHostAdapter,
  options: WorkspaceBackupOptions = {},
): Promise<WorkspaceBackupResult> {
  const limits = limitsFor(options.limits);
  if (!host || typeof host.acquireQuiescence !== "function") {
    throw new WorkspaceBackupError("QUIESCENCE_REQUIRED", "Host must stop admission and drain live runtime work before backup.");
  }
  const sourceRoot = await validateSourceWorkspace(storage.workspaceRoot());
  try {
    const archive = await lstat(join(sourceRoot, "legacy-code-archive"));
    if (!archive.isDirectory() || archive.isSymbolicLink() || (archive.mode & 0o7777) !== 0o700)
      throw new WorkspaceBackupError("UNSAFE_PATH", "Inert code archive must remain a protected 0700 directory.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!isAbsolute(destination)) throw new WorkspaceBackupError("INVALID_PATH", "Provide an absolute backup destination.");
  const { target, parent } = await prepareAbsentDestination(destination);
  const subscriptionIdentity = { policy: options.subscriptionIdentity, purpose: "backup" as const, destination: target };
  if (within(sourceRoot, target)) throw new WorkspaceBackupError("INVALID_PATH", "Backup destination cannot be inside its source workspace.");
  const executable = options.pythonExecutable ?? process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const schedulerQuiescence = await storage.acquireNativeSnapshotSchedulerQuiescence();
  let quiescence: WorkspaceQuiescenceLease;
  try { quiescence = await host.acquireQuiescence(); }
  catch (error) { await schedulerQuiescence?.release(); throw error; }
  if (!quiescence || typeof quiescence.assertHeld !== "function" || typeof quiescence.release !== "function") {
    await schedulerQuiescence?.release();
    throw new WorkspaceBackupError("QUIESCENCE_REQUIRED", "Host returned an invalid quiescence lease.");
  }
  let runtimeControls: Awaited<ReturnType<typeof acquireWorkspaceRuntimeControlSnapshot>> | undefined;
  try {
    runtimeControls = await acquireWorkspaceRuntimeControlSnapshot(sourceRoot);
    return await storage.withWorkspaceExclusive(async () => {
      quiescence.assertHeld();
      runtimeControls!.assertHeld();
      schedulerQuiescence?.assertHeld();
      storage.assertWorkspaceLease();
      const workspaceId = await storage.workspaceId();
      const sourceInventory = await listFiles(sourceRoot, limits);
      const sourceDb = options.database ?? storage.connectNative();
      const trashBefore = await inspectWorkspaceLegacyTrash(sourceRoot, workspaceId, sourceDb, undefined, options.legacyTrash);
      const trashMarkerPin = sourceInventory.files.includes(legacyTrashMarker)
        ? (await readPinnedFile(sourceRoot, legacyTrashMarker, limits.maxFileBytes)).pin : undefined;
      const paths = sourceInventory.files.filter(path => path !== legacyTrashMarker);
      let dataVersion: number;
      try {
        const main = sourceDb.prepare("PRAGMA database_list").all().find(row => row.name === "main");
        if (!main || !main.file || await realpath(String(main.file)) !== coreDatabasePath(sourceRoot)) {
          throw new WorkspaceBackupError("INVALID_WORKSPACE", "Backup must use the source workspace's initialized database.");
        }
        const skillSourcePin = captureSkillSourceBackup(sourceDb, sourceRoot, workspaceId, target, options.skillSourceBackup);
        const skillSource = skillSourcePin && options.skillSourceBackup
          ? { pin: skillSourcePin, policy: options.skillSourceBackup } : undefined;
        assertWorkspaceBackupQuiescent(sourceDb, classifiedBackupValidation, undefined,
          skillSource ? skillSourceBackupValidation : undefined);
        const hasStrictClassification = !!sourceDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_classification_native_receipt'").get()
          && !!sourceDb.prepare("SELECT 1 FROM legacy_classification_native_receipt LIMIT 1").get();
        const hasOriginalClassification = inspectLegacyClassificationCommand(sourceDb).receipts.length > 0;
        if (hasStrictClassification && hasOriginalClassification)
          throw new WorkspaceBackupError("RECOVERY_AUTHORITY_REQUIRED", "Mixed strict and original-compatible classification backup requires independent multi-root authority; single-root manifest cannot represent both.");
        const hasClassification = hasStrictClassification || hasOriginalClassification;
        const policy = options.classificationBackup;
        let classified: { pin: ClassificationBackupPin; policy: NativeClassificationBackupAuthority } | undefined;
        if (hasClassification) {
          if (!policy || !!policy.originalCompatible !== hasOriginalClassification || policy.scope !== "exclusive-native-disposable-fixture" || !safeRelativePath(policy.sourceRelative, limits.maxDepth)
            || !policy.sourceRelative.startsWith("packages/") || !/^[a-f0-9]{64}$/.test(policy.sourceRootId)
            || typeof policy.actorId !== "string" || !policy.actorId || policy.actorId.length > 256
            || /[\u0000-\u001f\u007f]/u.test(policy.actorId) || typeof policy.assertFixtureOwnership !== "function"
            || typeof policy.assertHistoryAnchor !== "function" || typeof policy.authorize !== "function")
            throw new WorkspaceBackupError("RECOVERY_AUTHORITY_REQUIRED", "Classified backup requires explicit native disposable fixture authority.");
          const checked = verifyClassificationHistory(sourceDb, workspaceId, join(sourceRoot, policy.sourceRelative), policy);
          if (checked.status.status !== "committed")
            throw new WorkspaceBackupError("PENDING_JOURNAL", "Classified backup requires a committed validated history.");
          const workspaceStat = await lstat(sourceRoot, { bigint: true });
          const request: NativeClassificationBackupRequest = Object.freeze({
            ...(policy.originalCompatible ? { originalCompatible: true as const } : {}),
            schema: "pkm.native-classification-backup/v1", actorId: policy.actorId, workspaceId,
            workspaceRoot: sourceRoot, workspaceDevice: String(workspaceStat.dev), workspaceInode: String(workspaceStat.ino),
            sourceRelative: policy.sourceRelative, sourceRootId: policy.sourceRootId,
            rootDevice: checked.scan.pin.dev, rootInode: checked.scan.pin.ino, genesisSha256: checked.genesisSha256,
            historySha256: checked.historySha256, layoutSha256: checked.scan.layoutSha256, destination: target,
          });
          const decision = policy.authorize(request);
          if (!decision || decision.actorId !== request.actorId
            || decision.requestSha256 !== digest(Buffer.from(JSON.stringify(request)))
            || !Number.isSafeInteger(decision.expiresAt) || decision.expiresAt <= Date.now()
            || !Number.isSafeInteger(decision.epoch) || decision.epoch < 0)
            throw new WorkspaceBackupError("AUTHORITY_REQUIRED", "Classified backup authority is absent, expired, or not bound to the exact source.");
          classified = { pin: { request, epoch: decision.epoch }, policy };
        }
        const assertClassificationAuthority = async () => {
          if (!classified) return;
          const { request, epoch } = classified.pin;
          const decision = classified.policy.authorize(request);
          if (!decision || decision.actorId !== request.actorId || decision.requestSha256 !== digest(Buffer.from(JSON.stringify(request)))
            || !Number.isSafeInteger(decision.expiresAt) || decision.expiresAt <= Date.now() || decision.epoch !== epoch)
            throw new WorkspaceBackupError("AUTHORITY_REQUIRED", "Classified backup authority was revoked, expired, or changed epoch.");
          const stat = await lstat(sourceRoot, { bigint: true });
          const checked = verifyClassificationHistory(sourceDb, workspaceId, join(sourceRoot, request.sourceRelative), classified.policy);
          if (String(stat.dev) !== request.workspaceDevice || String(stat.ino) !== request.workspaceInode
            || checked.status.status !== "committed" || checked.genesisSha256 !== request.genesisSha256
            || checked.historySha256 !== request.historySha256 || checked.scan.layoutSha256 !== request.layoutSha256
            || checked.scan.pin.dev !== request.rootDevice || checked.scan.pin.ino !== request.rootInode)
            throw new WorkspaceBackupError("SOURCE_CHANGED", "Classified source or history changed during backup.");
        };
        assertWorkspaceBackupQuiescent(sourceDb, classified ? classifiedBackupValidation : undefined, undefined,
          skillSource ? skillSourceBackupValidation : undefined);
        inspectNativeSubscriptionBundles(sourceDb, workspaceId);
        inspectLegacyControlRecovery(sourceDb, workspaceId);
        readLegacyStateReceipt(sourceDb, workspaceId);
        verifyLegacyNoteWorkItemsWorkspace(sourceDb, sourceRoot);
        await verifyInlineNoteWorkspace(sourceDb, sourceRoot);
        verifyBatch15SkillWorkspace(sourceDb, sourceRoot, !!skillSource);
        verifyProjectEnvelopeAdoption(sourceDb, workspaceId);
        const modelPin = workspaceStoragePaths(sourceRoot).layout === "separated"
          ? captureLegacyRetrievalModelReconstruction(sourceDb, sourceRoot) : undefined;
        if (!modelPin) verifyLegacyRetrievalModels(sourceDb, sourceRoot);
        const modelReconstruction = modelPin?.packages.length ? modelPin : undefined;
        verifyLegacyKnowledgeRecovery(sourceDb, sourceRoot);
        verifyLegacyKnowledgeSnapshots(sourceDb, sourceRoot);
        verifyLegacyActionArtifacts(sourceDb, workspaceId);
        await verifyBoundLegacyStateBytes(sourceDb, sourceRoot, workspaceId);
        await verifyNativeSubscriptionIdentity(sourceDb, sourceRoot, workspaceId, options.subscriptionIdentity, "backup", target);
        assertPortalRecoveryClear(sourceDb);
        dataVersion = Number(sourceDb.prepare("PRAGMA data_version").get()?.data_version);
        const pins: FilePin[] = [];
        for (const path of paths.filter(path => path !== coreDatabaseFile && path !== codingProcessDatabaseFile)) {
          const pinned = await readPinnedFile(sourceRoot, path, limits.maxFileBytes,
            [25, 26, 27, 28].includes(Number(sourceDb.prepare("PRAGMA user_version").get()?.user_version)));
          pins.push(pinned.pin);
        }
        if (pins.reduce((sum, pin) => sum + pin.size, 0) > limits.maxTotalBytes) {
          throw new WorkspaceBackupError("QUOTA_EXCEEDED", "Workspace bytes exceed the backup limit.");
        }
        const markerPin = pins.find(pin => pin.path === workspaceMarker)!;
        const marker = await readPinnedFile(sourceRoot, workspaceMarker, limits.maxFileBytes);
        validateMarker(marker.bytes, workspaceId);
        const { result } = await withStagingDirectory(parent, "pkm-backup", async stage => {
        if (Number(sourceDb.prepare("PRAGMA data_version").get()?.data_version) !== dataVersion) {
          throw new WorkspaceBackupError("SOURCE_CHANGED", "Workspace database changed after its source pin was acquired.");
        }
        const snapshotPath = coreDatabasePath(stage);
        const sqlPath = snapshotPath.replaceAll("'", "''");
        sourceDb.exec(`VACUUM INTO '${sqlPath}'`);
        if (paths.includes(codingProcessDatabaseFile)) {
          const processPath = codingProcessDatabasePath(sourceRoot);
          const processStat = await lstat(processPath);
          if (!processStat.isFile() || processStat.isSymbolicLink() || processStat.nlink !== 1)
            throw new WorkspaceBackupError("UNSAFE_ENTRY", "Coding process journal must be an unlinked regular file.");
          const processDb = new DatabaseSync(processPath, { readOnly: true });
          try {
            const version = Number(processDb.prepare("PRAGMA data_version").get()?.data_version);
            if (Number(processDb.prepare("PRAGMA user_version").get()?.user_version) !== 1)
              throw new WorkspaceBackupError("INVALID_WORKSPACE", "Unsupported coding process journal version.");
            processDb.exec(`VACUUM INTO '${codingProcessDatabasePath(stage).replaceAll("'", "''")}'`);
            if (Number(processDb.prepare("PRAGMA data_version").get()?.data_version) !== version)
              throw new WorkspaceBackupError("SOURCE_CHANGED", "Coding process journal changed during its quiescent snapshot.");
          } finally { processDb.close(); }
          await chmod(codingProcessDatabasePath(stage), 0o600);
          await syncFile(codingProcessDatabasePath(stage));
        }
        const snapshotBefore = await lstat(snapshotPath);
        if (!snapshotBefore.isFile() || snapshotBefore.isSymbolicLink() || snapshotBefore.nlink !== 1)
          throw new WorkspaceBackupError("UNSAFE_ENTRY", "SQLite archive must be an unlinked regular file.");
        const snapshotHandle = await open(snapshotPath, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = await snapshotHandle.stat();
          if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== snapshotBefore.dev || opened.ino !== snapshotBefore.ino)
            throw new WorkspaceBackupError("SOURCE_CHANGED", "SQLite archive changed before its private mode was established.");
          await snapshotHandle.chmod(0o600);
          await snapshotHandle.sync();
          const after = await snapshotHandle.stat(), current = await lstat(snapshotPath);
          if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
            || current.dev !== after.dev || current.ino !== after.ino || after.dev !== opened.dev || after.ino !== opened.ino
            || process.platform !== "win32" && ((after.mode & 0o777) !== 0o600 || (current.mode & 0o777) !== 0o600))
            throw new WorkspaceBackupError("SOURCE_CHANGED", "SQLite archive lost its private file identity or mode.");
        } finally { await snapshotHandle.close(); }
        const snapshot = new DatabaseSync(coreDatabasePath(stage));
        const databaseUserVersion = Number(snapshot.prepare("PRAGMA user_version").get()?.user_version);
        try {
          if (![currentDatabaseVersion, 24, 25, 26, 27, 28].includes(databaseUserVersion)) throw new WorkspaceBackupError("SCHEMA_MISMATCH", "Workspace database schema version is unsupported.");
          if (snapshot.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new WorkspaceBackupError("DATABASE_CORRUPT", "Workspace database snapshot failed integrity_check.");
          verifyLegacyNoteWorkItemsWorkspace(snapshot, sourceRoot);
          await verifyInlineNoteWorkspace(snapshot, sourceRoot);
          verifyBatch15SkillWorkspace(snapshot, sourceRoot, !!skillSource);
          verifyProjectEnvelopeAdoption(snapshot, workspaceId);
          snapshot.prepare("UPDATE native_runtime_owner SET lease_until=0 WHERE singleton=1").run();
          const checkpoint = snapshot.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
          if (checkpoint && Number(checkpoint.busy) !== 0) throw new WorkspaceBackupError("DATABASE_BUSY", "Snapshot database could not be fully checkpointed.");
          if (snapshot.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new WorkspaceBackupError("DATABASE_CORRUPT", "Checkpointed workspace snapshot failed integrity_check.");
        } finally { snapshot.close(); }
        const closedSnapshot = await lstat(snapshotPath);
        if (!closedSnapshot.isFile() || closedSnapshot.isSymbolicLink() || closedSnapshot.nlink !== 1
          || closedSnapshot.dev !== snapshotBefore.dev || closedSnapshot.ino !== snapshotBefore.ino
          || process.platform !== "win32" && (closedSnapshot.mode & 0o777) !== 0o600)
          throw new WorkspaceBackupError("SOURCE_CHANGED", "Closed SQLite archive lost its private file identity or mode.");
        const sidecars = await Promise.all(["-wal", "-shm"].map(async suffix => {
          try { await lstat(`${coreDatabasePath(stage)}${suffix}`); return true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
        }));
        if (sidecars.some(Boolean)) throw new WorkspaceBackupError("DATABASE_BUSY", "SQLite snapshot still depends on WAL sidecars.");
        for (const directory of sourceInventory.directories) await ensureDirectoryPath(stage, directory);
        const archivedDirectoryPins = await Promise.all(sourceInventory.directories.filter(isArchivedCodePath).map(async path => {
          const stat = await lstat(join(sourceRoot, path));
          if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7000) !== 0)
            throw new WorkspaceBackupError("UNSAFE_PATH", "Inert archive directories must have ordinary modes.");
          return { path, mode: stat.mode & 0o777, dev: stat.dev, ino: stat.ino, ctimeMs: stat.ctimeMs };
        }));
        const files: WorkspaceBackupManifest["files"] = [];
        let totalBytes = 0;
        for (const pin of pins) {
          quiescence.assertHeld(); runtimeControls!.assertHeld(); schedulerQuiescence?.assertHeld(); storage.assertWorkspaceLease();
          const { bytes, pin: afterPin } = await readPinnedFile(sourceRoot, pin.path, limits.maxFileBytes,
            [25, 26, 27, 28].includes(Number(sourceDb.prepare("PRAGMA user_version").get()?.user_version)));
          if (afterPin.sha256 !== pin.sha256 || afterPin.ino !== pin.ino || afterPin.dev !== pin.dev || afterPin.mtimeNs !== pin.mtimeNs
            || afterPin.mode !== pin.mode) {
            throw new WorkspaceBackupError("SOURCE_CHANGED", `Workspace entry changed after pinning: ${pin.path}`);
          }
          if (pin.path === workspaceMarker) validateMarker(bytes, workspaceId);
          await ensureBackupDirectoryTree(stage, pin.path);
          const targetPath = join(stage, ...pin.path.split("/"));
          const handle = await open(targetPath, "wx", 0o600);
          try {
            await handle.writeFile(bytes);
            await handle.sync();
          } finally { await handle.close(); }
          files.push({ path: pin.path, size: bytes.length, sha256: pin.sha256, ...(pin.mode === undefined ? {} : { mode: pin.mode }),
            ...(preservesSourceMtime(pin.path) ? { mtimeNs: pin.mtimeNs } : {}) });
          totalBytes += bytes.length;
          if (totalBytes > limits.maxTotalBytes) throw new WorkspaceBackupError("QUOTA_EXCEEDED", "Workspace bytes exceed the backup limit.");
        }
        if (classified) {
          const checked = verifyClassificationHistory(sourceDb, workspaceId,
            join(sourceRoot, classified.pin.request.sourceRelative), classified.policy);
          if (checked.scan.layoutSha256 !== classified.pin.request.layoutSha256)
            throw new WorkspaceBackupError("SOURCE_CHANGED", "Classified source layout changed while staging.");
          for (const entry of [...checked.scan.entries].reverse())
            await chmod(join(stage, classified.pin.request.sourceRelative, entry.path), entry.mode);
        }
        const markerAfter = pins.find(pin => pin.path === workspaceMarker)!;
        if (markerAfter.sha256 !== markerPin.sha256) throw new WorkspaceBackupError("SOURCE_CHANGED", "Workspace identity changed during backup.");
        const snapshotFile = await readPinnedFile(stage, coreDatabaseFile, limits.maxFileBytes);
        const snapshotBytes = snapshotFile.bytes;
        files.push({ path: coreDatabaseFile, size: snapshotBytes.length, sha256: digest(snapshotBytes) });
        totalBytes += snapshotBytes.length;
        if (paths.includes(codingProcessDatabaseFile)) {
          const processSnapshot = await readPinnedFile(stage, codingProcessDatabaseFile, limits.maxFileBytes);
          files.push({ path: codingProcessDatabaseFile, size: processSnapshot.bytes.length, sha256: digest(processSnapshot.bytes) });
          totalBytes += processSnapshot.bytes.length;
        }
        if (totalBytes > limits.maxTotalBytes) throw new WorkspaceBackupError("QUOTA_EXCEEDED", "Workspace bytes exceed the backup limit.");
        files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
        const manifest: WorkspaceBackupManifest = {
          schema: backupSchema, workspaceSchema, workspaceId, databaseUserVersion,
          files, directories: sourceInventory.directories, totalBytes,
          ...(archivedDirectoryPins.length ? {
            archivedDirectoryModes: archivedDirectoryPins.map(({ path, mode }) => ({ path, mode })),
          } : {}),
          ...(classified ? { classification: classified.pin } : {}),
          ...(skillSource ? { skillSource: skillSource.pin } : {}),
          ...(modelReconstruction ? { modelReconstruction } : {}),
        };
        const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
        const manifestPath = join(stage, manifestName);
        const manifestHandle = await open(manifestPath, "wx", 0o600);
        try { await manifestHandle.writeFile(bytes); await manifestHandle.sync(); } finally { await manifestHandle.close(); }
        await syncDirectoryTree(stage);
        const verifiedStage = await verifyBackup(stage, limits, classified, skillSource, subscriptionIdentity);
        if (verifiedStage.manifestSha256 !== digest(bytes) || verifiedStage.manifest.workspaceId !== workspaceId) {
          throw new WorkspaceBackupError("INVALID_BACKUP", "Completed backup snapshot failed self-verification.");
        }
        const currentInventory = await listFiles(sourceRoot, limits);
        if (currentInventory.files.filter(path => path !== legacyTrashMarker).join("\n") !== paths.join("\n")
          || currentInventory.directories.join("\n") !== sourceInventory.directories.join("\n")) {
          throw new WorkspaceBackupError("SOURCE_CHANGED", "Workspace entry set changed during backup.");
        }
        for (const pin of archivedDirectoryPins) {
          const stat = await lstat(join(sourceRoot, pin.path));
          if (stat.dev !== pin.dev || stat.ino !== pin.ino || stat.ctimeMs !== pin.ctimeMs || (stat.mode & 0o777) !== pin.mode)
            throw new WorkspaceBackupError("SOURCE_CHANGED", "Inert archive directory changed during backup.");
        }
        if (trashMarkerPin) {
          const currentMarker = await readPinnedFile(sourceRoot, legacyTrashMarker, limits.maxFileBytes);
          if (currentMarker.pin.sha256 !== trashMarkerPin.sha256 || currentMarker.pin.dev !== trashMarkerPin.dev
            || currentMarker.pin.ino !== trashMarkerPin.ino || currentMarker.pin.mtimeMs !== trashMarkerPin.mtimeMs) {
            throw new WorkspaceBackupError("SOURCE_CHANGED", "Original trash adoption marker changed during backup.");
          }
        }
        const trashAfter = await inspectWorkspaceLegacyTrash(sourceRoot, workspaceId, sourceDb, undefined, options.legacyTrash);
        if (JSON.stringify(trashBefore) !== JSON.stringify(trashAfter)) {
          throw new WorkspaceBackupError("SOURCE_CHANGED", "Native trash identity or selected tree changed during backup.");
        }
          await assertClassificationAuthority();
          if (skillSource) {
            const currentPin = captureSkillSourceBackup(sourceDb, sourceRoot, workspaceId, target, skillSource.policy);
            if (JSON.stringify(currentPin) !== JSON.stringify(skillSource.pin))
              throw new WorkspaceBackupError("SOURCE_CHANGED", "Canonical Skill source native admission changed during backup.");
          }
          assertWorkspaceBackupQuiescent(sourceDb, classified ? classifiedBackupValidation : undefined, undefined,
            skillSource ? skillSourceBackupValidation : undefined);
          verifyLegacyNoteWorkItemsWorkspace(sourceDb, sourceRoot);
          verifyProjectEnvelopeAdoption(sourceDb, workspaceId);
          if (Number(sourceDb.prepare("PRAGMA data_version").get()?.data_version) !== dataVersion) {
            throw new WorkspaceBackupError("SOURCE_CHANGED", "Workspace database changed during backup.");
          }
        const finalStage = await verifyBackup(stage, limits, classified, skillSource, subscriptionIdentity);
        if (finalStage.manifestSha256 !== digest(bytes))
          throw new WorkspaceBackupError("SOURCE_CHANGED", "Backup stage changed before publication.");
        quiescence.assertHeld(); runtimeControls!.assertHeld(); schedulerQuiescence?.assertHeld(); storage.assertWorkspaceLease();
        const stageRoot = await realpath(stage);
        if (options.nativePublishNoReplace) await options.nativePublishNoReplace(stageRoot, target);
        else publishNoReplace(stageRoot, target, executable);
        await syncDirectory(parent);
        const manifestSha256 = digest(bytes);
        return {
          result: { backupPath: target, workspaceId, fileCount: files.length, totalBytes, manifestSha256 },
        };
      });
      return result;
      } finally { if (!options.database) sourceDb.close(); }
    });
  } finally {
    try { await runtimeControls?.release(); }
    finally {
      try { await quiescence.release(); }
      finally { await schedulerQuiescence?.release(); }
    }
  }
}

export async function restoreWorkspaceBackup(
  backupPath: string,
  destination: string,
  options: Pick<WorkspaceBackupOptions, "limits" | "pythonExecutable" | "legacyTrash" | "nativePublishNoReplace"
    | "nativeRestoreAuthority" | "classificationBackup" | "skillSourceBackup" | "subscriptionIdentity"
    | "modelReconstructionSources"> = {},
): Promise<WorkspaceRestoreResult> {
  const limits = limitsFor(options.limits);
  if (!isAbsolute(backupPath)) throw new WorkspaceBackupError("INVALID_PATH", "Provide an absolute backup path.");
  const backupRootPath = await assertRealDirectory(backupPath);
  let initialManifestBytes: Buffer;
  let initialManifest: WorkspaceBackupManifest;
  try {
    initialManifestBytes = (await readPinnedFile(backupRootPath, manifestName, 4 * 1024 * 1024)).bytes;
    initialManifest = validateManifest(JSON.parse(initialManifestBytes.toString("utf8")), limits);
  } catch (error) {
    if (error instanceof WorkspaceBackupError) throw error;
    throw new WorkspaceBackupError("INVALID_MANIFEST", "Backup manifest is malformed or unreadable.");
  }
  const classified = initialManifest.classification
    ? options.classificationBackup ? { pin: initialManifest.classification, policy: options.classificationBackup } : undefined
    : undefined;
  if (initialManifest.classification && !classified)
    throw new WorkspaceBackupError("RECOVERY_AUTHORITY_REQUIRED", "Classified restore requires its exact source native authority and adoption lineage.");
  const skillSource = initialManifest.skillSource && options.skillSourceBackup
    ? { pin: initialManifest.skillSource, policy: options.skillSourceBackup } : undefined;
  if (initialManifest.skillSource && !skillSource)
    throw new WorkspaceBackupError("RECOVERY_AUTHORITY_REQUIRED", "Canonical Skill source restore requires independently pinned snapshot and root-adoption authority.");
  const subscriptionIdentity = { policy: options.subscriptionIdentity, purpose: "restore" as const, destination: resolve(destination) };
  const backup = await verifyBackup(backupRootPath, limits, classified, skillSource, subscriptionIdentity);
  if (backup.manifest.workspaceId !== initialManifest.workspaceId
    || backup.manifestSha256 !== digest(initialManifestBytes))
    throw new WorkspaceBackupError("SOURCE_CHANGED", "Backup manifest identity changed during validation.");
  if (backup.manifest.modelReconstruction) {
    const packages = backup.manifest.modelReconstruction.packages;
    if (!Array.isArray(options.modelReconstructionSources)
      || options.modelReconstructionSources.length !== packages.length
      || new Set(options.modelReconstructionSources.map(source => source.packageId)).size !== packages.length
      || packages.some(model => !options.modelReconstructionSources!.some(source => source.packageId === model.packageId)))
      throw new WorkspaceBackupError("RECOVERY_AUTHORITY_REQUIRED",
        `Restore requires explicit exact-hash local modelReconstructionSources for packages: ${packages.map(model => model.packageId).join(", ")}. No models are downloaded or selections cleared.`);
    if (packages.reduce((sum, model) => sum + model.totalBytes, backup.manifest.totalBytes) > limits.maxTotalBytes)
      throw new WorkspaceBackupError("QUOTA_EXCEEDED", "Archive and reconstructed model bytes exceed maxTotalBytes; explicitly raise the restore limit.");
  } else if (options.modelReconstructionSources?.length) {
    throw new WorkspaceBackupError("INVALID_MANIFEST", "Model reconstruction sources were supplied for a backup with no reconstruction manifest.");
  }
  const hasLegacyTrashReceipt = backup.hasLegacyTrashReceipt;
  if (hasLegacyTrashReceipt && (!options.legacyTrash
    || options.legacyTrash.expectedManifestSha256 !== backup.manifestSha256)) {
    throw new WorkspaceBackupError("AUTHORITY_REQUIRED", "Restoring imported trash requires an externally trusted exact backup manifest digest.");
  }
  const { target, parent } = await prepareAbsentDestination(destination);
  if (within(backupRootPath, target) || within(target, backupRootPath)) {
    throw new WorkspaceBackupError("INVALID_PATH", "Restore destination cannot overlap the backup directory.");
  }
  if ((await readdir(parent, { withFileTypes: true })).some(entry => entry.name.startsWith(".pkm-restore.")
    && entry.name.endsWith(".stage"))) {
    throw new WorkspaceBackupError("RECOVERY_AUTHORITY_REQUIRED", "An unpublished restore stage requires explicit native inspection; it is never auto-published or discarded.");
  }
  const authority = options.nativeRestoreAuthority;
  if (!authority || typeof authority.authorize !== "function" || typeof authority.actorId !== "string"
    || !authority.actorId || authority.actorId.length > 256 || /[\u0000-\u001f\u007f]/u.test(authority.actorId))
    throw new WorkspaceBackupError("AUTHORITY_REQUIRED", "Restore requires an independently trusted native actor and lineage authority.");
  const sourceStat = await lstat(backupRootPath, { bigint: true });
  const request: Readonly<NativeRestoreAuthorityRequest> = Object.freeze({
    schema: "pkm.native-restore-authority-request/v1",
    intent: "workspace-restore", actorId: authority.actorId, workspaceId: backup.manifest.workspaceId,
    sourceRoot: backupRootPath, sourceDevice: String(sourceStat.dev), sourceInode: String(sourceStat.ino),
    manifestSha256: backup.manifestSha256, destination: target, backupErasureEpoch: null,
  });
  const requestSha256 = digest(Buffer.from(JSON.stringify(request)));
  const assertRestoreAuthority = async () => {
    const stat = await lstat(backupRootPath, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || String(stat.dev) !== request.sourceDevice
      || String(stat.ino) !== request.sourceInode)
      throw new WorkspaceBackupError("SOURCE_CHANGED", "Backup source identity changed after native approval.");
    const decision = await authority.authorize(request);
    if (!decision || typeof decision.authorityId !== "string" || !decision.authorityId || decision.authorityId.length > 256
      || /[\u0000-\u001f\u007f]/u.test(decision.authorityId)
      || decision.actorId !== request.actorId || decision.requestSha256 !== requestSha256
      || !Number.isSafeInteger(decision.expiresAt) || decision.expiresAt <= Date.now()
      || !["unrelated", "erasure-protected"].includes(decision.lineage)
      || !(decision.trustedEpoch === null || Number.isSafeInteger(decision.trustedEpoch) && decision.trustedEpoch >= 0))
      throw new WorkspaceBackupError("AUTHORITY_REQUIRED", "Native restore approval is absent, expired, or not bound to the exact request.");
    if (decision.lineage === "erasure-protected" || decision.trustedEpoch !== null)
      throw new WorkspaceBackupError("ERASURE_EPOCH_MISMATCH", "This unpinned legacy backup cannot restore an erasure-protected lineage.");
  };
  const classificationPolicy = classified?.policy;
  const classificationPin = classified?.pin;
  const destinationParentPin = classificationPin ? await directoryPin(parent) : null;
  const sourceBackupPin = classificationPin ? await directoryPin(backupRootPath) : null;
  const sourceClassificationRequest = classificationPin?.request;
  const originalSourceRootPath = sourceClassificationRequest
    ? join(sourceClassificationRequest.workspaceRoot, sourceClassificationRequest.sourceRelative) : null;
  let prepareAdoptionApproval: NativeClassificationAdoptionApproval | null = null;
  const checkClassificationSourceAuthority = () => {
    if (!classificationPin || !classificationPolicy) return;
    if (!!classificationPolicy.originalCompatible !== !!classificationPin.request.originalCompatible
      || classificationPolicy.actorId !== classificationPin.request.actorId
      || classificationPolicy.scope !== "exclusive-native-disposable-fixture"
      || classificationPolicy.sourceRelative !== classificationPin.request.sourceRelative
      || classificationPolicy.sourceRootId !== classificationPin.request.sourceRootId
      || typeof classificationPolicy.assertFixtureOwnership !== "function"
      || typeof classificationPolicy.assertHistoryAnchor !== "function"
      || typeof classificationPolicy.assertAdoptionAnchor !== "function"
      || typeof classificationPolicy.authorize !== "function")
      throw new WorkspaceBackupError("RECOVERY_AUTHORITY_REQUIRED", "Classified restore requires independent source history and adoption authority.");
    classificationPolicy.assertFixtureOwnership();
    const decision = classificationPolicy.authorize(classificationPin.request);
    if (!decision || decision.actorId !== classificationPin.request.actorId
      || decision.requestSha256 !== digest(Buffer.from(JSON.stringify(classificationPin.request)))
      || decision.epoch !== classificationPin.epoch
      || !Number.isSafeInteger(decision.expiresAt) || decision.expiresAt <= Date.now())
      throw new WorkspaceBackupError("RECOVERY_AUTHORITY_REQUIRED", "Classified backup source authority is absent, expired, revoked, or changed epoch.");
  };
  const checkAdoptionApproval = (request: NativeClassificationAdoptionRequest) => {
    const decision = authority.authorizeClassificationAdoption?.(request);
    if (!decision || decision.actorId !== authority.actorId
      || decision.requestSha256 !== digest(Buffer.from(JSON.stringify(request)))
      || typeof decision.authorityId !== "string" || !decision.authorityId || decision.authorityId.length > 256
      || /[\u0000-\u001f\u007f]/u.test(decision.authorityId)
      || typeof decision.policyIdentity !== "string" || !decision.policyIdentity || decision.policyIdentity.length > 256
      || /[\u0000-\u001f\u007f]/u.test(decision.policyIdentity)
      || !Number.isSafeInteger(decision.trustedEpoch) || decision.trustedEpoch < 0
      || !Number.isSafeInteger(decision.expiresAt) || decision.expiresAt <= Date.now())
      throw new WorkspaceBackupError("RECOVERY_AUTHORITY_REQUIRED", "Native classification root adoption approval is absent, expired, or not bound to the exact source and target.");
    return decision;
  };
  const adoptionBase = classificationPin && sourceClassificationRequest && destinationParentPin && sourceBackupPin
    ? {
      ...(sourceClassificationRequest.originalCompatible ? { originalCompatible: true as const } : {}),
      schema: "pkm.native-classification-root-adoption/v1" as const,
      phase: "prepare" as const,
      operationId: randomUUID(),
      actorId: authority.actorId,
      workspaceId: backup.manifest.workspaceId,
      sourceRootId: sourceClassificationRequest.sourceRootId,
      sourceRelative: sourceClassificationRequest.sourceRelative,
      sourceBackupRoot: backupRootPath,
      sourceBackupRootPin: sourceBackupPin,
      sourceManifestSha256: backup.manifestSha256,
      sourceRoot: originalSourceRootPath!,
      sourceRootPin: { dev: sourceClassificationRequest.rootDevice, ino: sourceClassificationRequest.rootInode },
      sourceEpoch: classificationPin.epoch,
      genesisSha256: sourceClassificationRequest.genesisSha256,
      historySha256: sourceClassificationRequest.historySha256,
      receiptCount: 0,
      layoutSha256: sourceClassificationRequest.layoutSha256,
      destination: target,
      destinationParent: destinationParentPin,
      stageWorkspaceRoot: null,
      stageWorkspacePin: null,
      stageRoot: null,
      stageRootPin: null,
      stageParent: null,
    }
    : null;
  if (classificationPin && (!authority.authorizeClassificationAdoption || !adoptionBase))
    throw new WorkspaceBackupError("RECOVERY_AUTHORITY_REQUIRED", "Classified restore requires a native root-adoption approval policy.");
  await assertRestoreAuthority();
  const skillRestoreBase: NativeSkillSourceRestoreRequest | undefined = skillSource ? {
    schema: "pkm.native-skill-source-restore/v1", phase: "prepare", backup: skillSource.pin,
    backupRoot: backupRootPath, backupRootPin: await directoryPin(backupRootPath), manifestSha256: backup.manifestSha256,
    destination: target, destinationParentPin: await directoryPin(parent),
    stage: null, stagePin: null, adoption: null, adoptedSnapshotDigest: null, adoptedHead: null,
  } : undefined;
  if (skillSource && skillRestoreBase) {
    if (authority.actorId !== skillSource.pin.request.actor.id)
      throw new WorkspaceBackupError("RECOVERY_AUTHORITY_REQUIRED", "Generic native restore actor and canonical Skill source actor differ.");
    approveSkillSourceRestore(skillRestoreBase, skillSource.policy);
  }
  if (classificationPin) {
    checkClassificationSourceAuthority();
    prepareAdoptionApproval = checkAdoptionApproval(Object.freeze(adoptionBase!));
  }
  let adoptionPublishRequest: NativeClassificationAdoptionRequest | null = null;
  let adoptedStageRootPin: { dev: string; ino: string } | null = null;
  let adoptedStageWorkspacePin: { dev: string; ino: string } | null = null;
  let adoptedStageParentPin: { dev: string; ino: string } | null = null;
  let adoptedReceiptCount = 0;
  const executable = options.pythonExecutable ?? process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  let retainSkillSourceStage = false;
  let skillPublishRequest: NativeSkillSourceRestoreRequest | undefined;
  return withStagingDirectory(parent, "pkm-restore", async stage => {
    const separatedRestore = !!backup.manifest.modelReconstruction || backup.manifest.directories.includes("runtime-control");
    const restoredRelativePath = (path: string) => separatedRestore
      && ([coreDatabaseFile, codingProcessDatabaseFile].includes(path) || path === "runtime-control" || path.startsWith("runtime-control/"))
      ? `${serverDataDirectory}/${path}` : path;
    for (const directory of backup.manifest.directories) await ensureDirectoryPath(stage, restoredRelativePath(directory));
    for (const item of backup.manifest.files) {
      const { bytes } = await readPinnedFile(backupRootPath, item.path, limits.maxFileBytes);
      if (bytes.length !== item.size || digest(bytes) !== item.sha256) throw new WorkspaceBackupError("HASH_MISMATCH", `Backup changed during restore: ${item.path}`);
      const restoredPath = restoredRelativePath(item.path);
      await ensureBackupDirectoryTree(stage, restoredPath);
      const output = join(stage, ...restoredPath.split("/"));
      const handle = await open(output, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        if (item.mode !== undefined && process.platform !== "win32") await handle.chmod(item.mode);
        await handle.sync();
      } finally { await handle.close(); }
    }
    if (separatedRestore) {
      const control = await open(join(stage, storageLayoutMarker), "wx", 0o600);
      try {
        await control.writeFile(JSON.stringify({ schema: separatedStorageSchema,
          workspaceId: backup.manifest.workspaceId, layout: "separated" }));
        await control.sync();
      } finally { await control.close(); }
      protectWorkspaceGit(stage);
    }
    for (const entry of [...(backup.manifest.archivedDirectoryModes ?? [])].reverse())
      await chmod(join(stage, entry.path), entry.mode);
    restoreFileMtimes(stage, backup.manifest.files.flatMap(file =>
      file.mtimeNs === undefined ? [] : [{ path: restoredRelativePath(file.path), mtimeNs: file.mtimeNs }]), executable);
    if (backup.classificationLayout) {
      await restoreClassificationModes(join(stage, ...classificationPin!.request.sourceRelative.split("/")), backup.classificationLayout);
    }
    const stageMarker = await readPinnedFile(stage, workspaceMarker, limits.maxFileBytes);
    validateMarker(stageMarker.bytes, backup.manifest.workspaceId);
    const stageDb = new DatabaseSync(coreDatabasePath(stage));
    try {
      if (Number(stageDb.prepare("PRAGMA user_version").get()?.user_version) !== backup.manifest.databaseUserVersion
        || stageDb.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
        throw new WorkspaceBackupError("DATABASE_CORRUPT", "Restored SQLite snapshot failed validation.");
      }
      const owner = stageDb.prepare("SELECT lease_until FROM native_runtime_owner WHERE singleton=1").get();
      if (owner && Number(owner.lease_until) !== 0) throw new WorkspaceBackupError("INVALID_BACKUP", "Restore snapshot contains an active owner lease.");
      if (!!legacyTrashReceiptRow(stageDb, backup.manifest.workspaceId) !== hasLegacyTrashReceipt) {
        throw new WorkspaceBackupError("INVALID_BACKUP", "Restore database legacy trash receipt differs from the verified backup.");
      }
      inspectNativeSubscriptionBundles(stageDb, backup.manifest.workspaceId);
      if (backup.manifest.databaseUserVersion >= 13) inspectLegacyControlRecovery(stageDb, backup.manifest.workspaceId);
      if (backup.manifest.databaseUserVersion >= 16) validateLegacyRecipeTrashJournalSchema(stageDb);
      if (backup.manifest.databaseUserVersion >= 17) verifyLegacyNoteWorkItemsWorkspace(stageDb, stage);
      if (backup.manifest.databaseUserVersion >= 18) {
        if (skillSource) verifySkillSourceBackup(stageDb, stage, skillSource.pin, skillSource.policy);
        assertWorkspaceBackupQuiescent(stageDb, classified ? classifiedBackupValidation : undefined, undefined,
          skillSource ? skillSourceBackupValidation : undefined);
        await verifyInlineNoteWorkspace(stageDb, stage);
        if (backup.manifest.databaseUserVersion >= 19) verifyBatch15SkillWorkspace(stageDb, stage, !!skillSource);
      }
      verifyProjectEnvelopeAdoption(stageDb, backup.manifest.workspaceId);
      if (backup.manifest.modelReconstruction) {
        if (process.platform !== "linux")
          throw new WorkspaceBackupError("RECOVERY_AUTHORITY_REQUIRED", "Exact-content model reconstruction currently requires the real Linux stage writer fence.");
        await assertRestoreAuthority();
        const modelFence = await acquireLinuxRootWriterFence(stage, 250);
        try {
          reconstructLegacyRetrievalModels(stageDb, stage, backup.manifest.modelReconstruction,
            options.modelReconstructionSources!, { assertWorkspaceLease: () => modelFence.assertHeld(),
              limits: { maxTotalBytes: limits.maxTotalBytes - backup.manifest.totalBytes } });
          modelFence.assertHeld();
          await assertRestoreAuthority();
        } finally { await modelFence.release(); }
      }
      verifyLegacyRetrievalModels(stageDb, stage);
      verifyLegacyKnowledgeRecovery(stageDb, stage);
      verifyLegacyKnowledgeSnapshots(stageDb, stage);
      verifyLegacyActionArtifacts(stageDb, backup.manifest.workspaceId);
      if (backup.manifest.databaseUserVersion >= 14) readLegacyStateReceipt(stageDb, backup.manifest.workspaceId);
      if (backup.manifest.databaseUserVersion >= 14) assertPortalRecoveryClear(stageDb);
      if (classificationPin && classificationPolicy && backup.classificationLayout) {
        classificationPolicy.assertFixtureOwnership();
        assertRestoreDatabaseOwner(stageDb, stage);
        stageDb.exec("BEGIN IMMEDIATE");
        try {
          stageDb.exec(classificationPolicy.originalCompatible ? LEGACY_CLASSIFICATION_COMMAND_DDL : LEGACY_CLASSIFICATION_ADOPTION_DDL);
          stageDb.exec(`PRAGMA user_version=${Math.max(21, backup.manifest.databaseUserVersion)}`);
          stageDb.exec("COMMIT");
        } catch (error) { if (stageDb.isTransaction) stageDb.exec("ROLLBACK"); throw error; }
        verifyNativeClassificationAdoptionSchema(stageDb);
        const stageRoot = join(stage, ...classificationPin.request.sourceRelative.split("/"));
        const stageRootPin = await directoryPin(stageRoot);
        const stageParentPin = await directoryPin(dirname(stageRoot));
        const stageWorkspacePin = await directoryPin(stage);
        adoptedStageRootPin = stageRootPin;
        adoptedStageParentPin = stageParentPin;
        adoptedStageWorkspacePin = stageWorkspacePin;
        const previousHost = {
          assertOwnedDisposableFixture: () => classificationPolicy.assertFixtureOwnership(),
          assertAdoptionAnchor: classificationPolicy.assertAdoptionAnchor,
          globalReceipt(database: DatabaseSync, id: string) {
            const row = database.prepare("SELECT fingerprint,result FROM receipts WHERE operation_id=?").get(id);
            return row ? { fingerprint: String(row.fingerprint), result: JSON.parse(String(row.result)) } : null;
          },
        } as LegacyClassificationNativeHost;
        const originalHistory = classificationPolicy.originalCompatible
          ? inspectLegacyClassificationCommand(stageDb, originalClassificationBackupHost(classificationPolicy)) : undefined;
        const oldLineage = originalHistory ? { rootPins: originalHistory.rootPins, adoptions: originalHistory.adoptions }
          : validateNativeClassificationAdoptionLineage(stageDb, previousHost, {
          workspaceId: backup.manifest.workspaceId, sourceRootId: classificationPin.request.sourceRootId,
          currentRootPin: { dev: classificationPin.request.rootDevice, ino: classificationPin.request.rootInode },
        });
        if (oldLineage.adoptions.length !== (originalHistory?.adoptions ?? inspectNativeClassificationAdoptions(stageDb)).length
          || JSON.stringify(oldLineage.rootPins.at(-1)) !== JSON.stringify({ dev: classificationPin.request.rootDevice, ino: classificationPin.request.rootInode }))
          throw new WorkspaceBackupError("SOURCE_CHANGED", "Classified adoption lineage changed before restore staging.");
        const receiptCount = Number(stageDb.prepare(`SELECT COUNT(*) AS count FROM ${classificationPolicy.originalCompatible ? "legacy_classification_command_receipt" : "legacy_classification_native_receipt"}`).get()?.count);
        adoptedReceiptCount = receiptCount;
        if (receiptCount < 1)
          throw new WorkspaceBackupError("SOURCE_CHANGED", "Classified receipt history is empty or inconsistent.");
        const publishRequest: NativeClassificationAdoptionRequest = Object.freeze({
          ...adoptionBase!,
          phase: "publish",
          receiptCount,
          stageWorkspaceRoot: stage,
          stageWorkspacePin,
          stageRoot,
          stageRootPin,
          stageParent: stageParentPin,
        });
        const publishApproval = checkAdoptionApproval(publishRequest);
        if (publishApproval.authorityId !== prepareAdoptionApproval?.authorityId
          || publishApproval.policyIdentity !== prepareAdoptionApproval?.policyIdentity
          || publishApproval.trustedEpoch !== prepareAdoptionApproval?.trustedEpoch)
          throw new WorkspaceBackupError("RECOVERY_AUTHORITY_REQUIRED", "Native root-adoption authority changed between preparation and publication.");
        const history = originalHistory ?? inspectNativeClassificationHistory(stageDb, previousHost);
        if (history.pending || history.receipts.length !== receiptCount
          || digest(Buffer.from(JSON.stringify(history.receipts))) !== classificationPin.request.historySha256)
          throw new WorkspaceBackupError("SOURCE_CHANGED", "Classified receipt history changed before adoption.");
        adoptionPublishRequest = publishRequest;
        const record: LegacyClassificationAdoption = {
          schema: "pkm.legacy-classification-root-adoption/v1",
          adoptionId: publishRequest.operationId,
          operationId: publishRequest.operationId,
          workspaceId: publishRequest.workspaceId,
          sourceRootId: publishRequest.sourceRootId,
          sourceRelative: publishRequest.sourceRelative,
          sourceManifestSha256: publishRequest.sourceManifestSha256,
          sourceBackupRoot: publishRequest.sourceBackupRoot,
          sourceBackupRootPin: publishRequest.sourceBackupRootPin,
          sourceRoot: publishRequest.sourceRoot,
          sourceRootPin: publishRequest.sourceRootPin,
          destination: publishRequest.destination,
          destinationParent: publishRequest.destinationParent,
          destinationWorkspacePin: publishRequest.stageWorkspacePin!,
          destinationRootPin: publishRequest.stageRootPin!,
          stageParent: publishRequest.stageParent!,
          genesisSha256: publishRequest.genesisSha256,
          historySha256: publishRequest.historySha256,
          receiptCount,
          layoutSha256: publishRequest.layoutSha256,
          layout: backup.classificationLayout,
          actorId: authority.actorId,
          authorityId: publishApproval.authorityId,
          policyIdentity: publishApproval.policyIdentity,
          sourceEpoch: publishRequest.sourceEpoch,
          trustedEpoch: publishApproval.trustedEpoch,
          expiresAt: Math.min(prepareAdoptionApproval!.expiresAt, publishApproval.expiresAt),
        };
        const payload = JSON.stringify(record);
        classificationPolicy.assertFixtureOwnership();
        assertRestoreDatabaseOwner(stageDb, stage);
        stageDb.exec("BEGIN IMMEDIATE");
        try {
          stageDb.prepare(`INSERT INTO ${classificationPolicy.originalCompatible ? "legacy_classification_command_adoption" : "legacy_classification_native_adoption"} VALUES(?,?,?)`)
            .run(record.adoptionId, payload, digest(Buffer.from(payload)));
          stageDb.exec("COMMIT");
        } catch (error) { if (stageDb.isTransaction) stageDb.exec("ROLLBACK"); throw error; }
        let checked;
        try { checked = verifyClassificationHistory(stageDb, backup.manifest.workspaceId, stageRoot, classificationPolicy); }
        catch (error) {
          const code = error && typeof error === "object" && "code" in error
            && (error as { code?: unknown }).code === "CONFLICT" ? "CONFLICT" : "RECOVERY_AUTHORITY_REQUIRED";
          throw new WorkspaceBackupError(code,
            error instanceof Error ? error.message : "Native adoption lineage validation failed.");
        }
        if (checked.status.status !== "committed" || checked.scan.layoutSha256 !== record.layoutSha256
          || checked.scan.pin.dev !== record.destinationRootPin.dev || checked.scan.pin.ino !== record.destinationRootPin.ino)
          throw new WorkspaceBackupError("SOURCE_CHANGED", "Restored classification root did not validate against its immutable adoption.");
      }
      rebindMigrationTrashBackup(stageDb, stage, target, backup.manifest.workspaceId);
    } finally { stageDb.close(); }
    await rebindWorkspaceLegacyTrash(stage, backup.manifest.workspaceId, hasLegacyTrashReceipt,
      backup.manifestSha256, options.legacyTrash);
    try { await validateWorkspace(stage); }
    catch { throw new WorkspaceBackupError("INVALID_BACKUP", "Restored workspace layout failed validation."); }
    for (const file of backup.manifest.files) await syncFile(join(stage, ...restoredRelativePath(file.path).split("/")));
    await syncDirectoryTree(stage);
    const finalBackup = await verifyBackup(backupRootPath, limits, classified, skillSource, subscriptionIdentity);
    if (finalBackup.manifestSha256 !== backup.manifestSha256) throw new WorkspaceBackupError("SOURCE_CHANGED", "Backup changed while it was being restored.");
    await assertRestoreAuthority();
    const stagePublishPath = await realpath(stage);
    if (skillSource && skillRestoreBase) {
      const adoptionDb = new DatabaseSync(coreDatabasePath(stage));
      try {
        assertRestoreDatabaseOwner(adoptionDb, stage);
        const adoption = prepareSkillSourceAdoption(adoptionDb, stage, target, skillSource.pin, skillSource.policy);
        skillPublishRequest = {
          ...skillRestoreBase, phase: "publish", stage, stagePin: await directoryPin(stage), adoption,
        };
        approveSkillSourceRestore(skillPublishRequest, skillSource.policy);
        retainSkillSourceStage = true;
        const adopted = adoptSkillSourceBackup(adoptionDb, stage, adoption, skillSource.policy);
        skillPublishRequest = {
          ...skillPublishRequest, adoptedSnapshotDigest: adopted.snapshotDigest, adoptedHead: adopted.adoptionHead,
        };
        verifyAdoptedSkillSourceBackup(adoptionDb, stage, skillSource.pin, adoption,
          adopted.snapshotDigest, adopted.adoptionHead, skillSource.policy);
      } finally { adoptionDb.close(); }
      await syncFile(coreDatabasePath(stage));
      await syncDirectoryTree(stage);
    }
    const assertPublicationAuthority = async () => {
      await assertRestoreAuthority();
      if (classificationPin && classificationPolicy && adoptionBase) {
        classificationPolicy.assertFixtureOwnership();
        checkClassificationSourceAuthority();
        const currentSourceBackupPin = await directoryPin(backupRootPath);
        const currentParentPin = await directoryPin(parent);
        const currentStagePin = await directoryPin(stage);
        const stageRoot = join(stage, ...classificationPin.request.sourceRelative.split("/"));
        const currentStageRootPin = await directoryPin(stageRoot);
        const currentStageParentPin = await directoryPin(dirname(stageRoot));
        const publishDb = new DatabaseSync(coreDatabasePath(stage), { readOnly: true });
        try {
          assertRestoreDatabaseOwner(publishDb, stage);
          let checked;
          try { checked = verifyClassificationHistory(publishDb, backup.manifest.workspaceId, stageRoot, classificationPolicy); }
          catch (error) {
            const code = error && typeof error === "object" && "code" in error
              && (error as { code?: unknown }).code === "CONFLICT" ? "CONFLICT" : "RECOVERY_AUTHORITY_REQUIRED";
            throw new WorkspaceBackupError(code,
              error instanceof Error ? error.message : "Native adoption lineage validation failed.");
          }
          if (checked.status.status !== "committed" || checked.scan.layoutSha256 !== classificationPin.request.layoutSha256
            || checked.scan.pin.dev !== currentStageRootPin.dev || checked.scan.pin.ino !== currentStageRootPin.ino
            || JSON.stringify(checked.scan.entries) !== JSON.stringify(backup.classificationLayout))
            throw new WorkspaceBackupError("SOURCE_CHANGED", "Classification stage changed after immutable adoption validation.");
        } finally { publishDb.close(); }
        const targetExists = await lstat(target).then(() => true, error =>
          (error as NodeJS.ErrnoException).code === "ENOENT" ? false : Promise.reject(error));
        if (JSON.stringify(currentSourceBackupPin) !== JSON.stringify(sourceBackupPin)
          || JSON.stringify(currentParentPin) !== JSON.stringify(destinationParentPin)
          || JSON.stringify(currentStagePin) !== JSON.stringify(adoptedStageWorkspacePin)
          || JSON.stringify(currentStageRootPin) !== JSON.stringify(adoptedStageRootPin)
          || JSON.stringify(currentStageParentPin) !== JSON.stringify(adoptedStageParentPin)
          || targetExists || !adoptionPublishRequest || adoptionPublishRequest.receiptCount !== adoptedReceiptCount) {
          throw new WorkspaceBackupError("SOURCE_CHANGED", "Classification source, staging parent, or target identity changed before publication.");
        }
        if (adoptionPublishRequest.stageWorkspaceRoot !== stage || adoptionPublishRequest.stageRoot !== stageRoot
          || JSON.stringify(adoptionPublishRequest.stageWorkspacePin) !== JSON.stringify(currentStagePin)
          || JSON.stringify(adoptionPublishRequest.stageRootPin) !== JSON.stringify(currentStageRootPin)
          || JSON.stringify(adoptionPublishRequest.stageParent) !== JSON.stringify(currentStageParentPin))
          throw new WorkspaceBackupError("SOURCE_CHANGED", "Approved staging identity changed before publication.");
        const finalApproval = checkAdoptionApproval(adoptionPublishRequest);
        if (finalApproval.authorityId !== prepareAdoptionApproval?.authorityId
          || finalApproval.policyIdentity !== prepareAdoptionApproval?.policyIdentity
          || finalApproval.trustedEpoch !== prepareAdoptionApproval?.trustedEpoch)
          throw new WorkspaceBackupError("RECOVERY_AUTHORITY_REQUIRED", "Native root-adoption authority was revoked before publication.");
        checkClassificationSourceAuthority();
        classificationPolicy.assertFixtureOwnership();
        if (classificationPolicy.originalCompatible) {
          const finalDb = new DatabaseSync(coreDatabasePath(stage), { readOnly: true });
          try {
            const checked = verifyOriginalClassificationBackupHistory(finalDb, backup.manifest.workspaceId, stageRoot, classificationPolicy);
            if (checked.scan.layoutSha256 !== classificationPin.request.layoutSha256
              || JSON.stringify(checked.scan.entries) !== JSON.stringify(backup.classificationLayout))
              throw new WorkspaceBackupError("SOURCE_CHANGED", "Original classification bytes or modes changed in final native publication approval.");
          } finally { finalDb.close(); }
        }
        if (JSON.stringify(directoryPinSync(backupRootPath)) !== JSON.stringify(sourceBackupPin)
          || JSON.stringify(directoryPinSync(parent)) !== JSON.stringify(destinationParentPin)
          || JSON.stringify(directoryPinSync(stage)) !== JSON.stringify(adoptedStageWorkspacePin)
          || JSON.stringify(directoryPinSync(stageRoot)) !== JSON.stringify(adoptedStageRootPin)
          || JSON.stringify(directoryPinSync(dirname(stageRoot))) !== JSON.stringify(adoptedStageParentPin))
          throw new WorkspaceBackupError("SOURCE_CHANGED", "Pinned classification source or destination identity changed at publication.");
        try { lstatSync(target); throw new WorkspaceBackupError("DESTINATION_EXISTS", "Destination became occupied; no files were replaced."); }
        catch (error) {
          if (error instanceof WorkspaceBackupError) throw error;
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (skillSource && skillPublishRequest?.adoption && skillPublishRequest.adoptedSnapshotDigest && skillPublishRequest.adoptedHead) {
        const publishDb = new DatabaseSync(coreDatabasePath(stage), { readOnly: true });
        try {
          verifyAdoptedSkillSourceBackup(publishDb, stage, skillSource.pin, skillPublishRequest.adoption,
            skillPublishRequest.adoptedSnapshotDigest, skillPublishRequest.adoptedHead, skillSource.policy);
          approveSkillSourceRestore(skillPublishRequest, skillSource.policy);
          await assertRestoreAuthority();
          verifyAdoptedSkillSourceBackup(publishDb, stage, skillSource.pin, skillPublishRequest.adoption,
            skillPublishRequest.adoptedSnapshotDigest, skillPublishRequest.adoptedHead, skillSource.policy);
        } finally { publishDb.close(); }
        if (JSON.stringify(directoryPinSync(stage)) !== JSON.stringify(skillPublishRequest.stagePin)
          || JSON.stringify(directoryPinSync(parent)) !== JSON.stringify(skillPublishRequest.destinationParentPin)
          || JSON.stringify(directoryPinSync(backupRootPath)) !== JSON.stringify(skillPublishRequest.backupRootPin))
          throw new WorkspaceBackupError("SOURCE_CHANGED", "Canonical Skill source approved stage, backup or publication parent changed.");
        try { lstatSync(target); throw new WorkspaceBackupError("DESTINATION_EXISTS", "Canonical Skill destination became occupied."); }
        catch (error) {
          if (error instanceof WorkspaceBackupError || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const identityPublishDb = new DatabaseSync(coreDatabasePath(stage), { readOnly: true });
      try {
        if (backup.manifest.modelReconstruction) {
          verifyLegacyRetrievalModelReconstruction(identityPublishDb, stage, backup.manifest.modelReconstruction);
          verifyLegacyRetrievalModels(identityPublishDb, stage);
        }
        await verifyNativeSubscriptionIdentity(identityPublishDb, stage, backup.manifest.workspaceId,
          options.subscriptionIdentity, "restore", target);
      } finally { identityPublishDb.close(); }
    };
    await assertPublicationAuthority();
    if (process.platform === "linux") {
      const fence = await acquireLinuxRootWriterFence(stagePublishPath);
      try {
        await fence.publishRootNoReplace(target, async keepAlive => {
          // Fence acquisition and destination marker binding both await external I/O.
          await assertPublicationAuthority();
          fence.assertHeld();
          if (options.nativePublishNoReplace) await options.nativePublishNoReplace(stagePublishPath, target);
          else publishNoReplace(stagePublishPath, target, executable, keepAlive);
        });
      } catch (error) {
        if (error instanceof CoreError && error.code === "CONFLICT")
          throw new WorkspaceBackupError("DESTINATION_EXISTS", error.message);
        throw error;
      } finally { await fence.release(); }
    } else if (options.nativePublishNoReplace) await options.nativePublishNoReplace(stagePublishPath, target);
    else publishNoReplace(stagePublishPath, target, executable);
    await syncDirectory(parent);
    if (skillSource && skillPublishRequest?.adoption && skillPublishRequest.adoptedSnapshotDigest && skillPublishRequest.adoptedHead) {
      if (JSON.stringify(await directoryPin(target)) !== JSON.stringify(skillPublishRequest.stagePin)
        || JSON.stringify(await directoryPin(parent)) !== JSON.stringify(skillPublishRequest.destinationParentPin))
        throw new WorkspaceBackupError("SOURCE_CHANGED", "Canonical Skill source publication identity changed.");
      const publishedDb = new DatabaseSync(coreDatabasePath(target), { readOnly: true });
      try {
        verifyPublishedSkillSourceBackup(publishedDb, target, skillSource.pin, skillPublishRequest.adoption,
          skillPublishRequest.adoptedSnapshotDigest, skillPublishRequest.adoptedHead, skillSource.policy);
      } finally { publishedDb.close(); }
    }
    if (classificationPin && adoptedStageRootPin) {
      const publishedWorkspacePin = await directoryPin(target);
      const publishedRootPin = await directoryPin(join(target, ...classificationPin.request.sourceRelative.split("/")));
      if (JSON.stringify(publishedWorkspacePin) !== JSON.stringify(adoptedStageWorkspacePin)
        || JSON.stringify(publishedRootPin) !== JSON.stringify(adoptedStageRootPin)
        || JSON.stringify(await directoryPin(parent)) !== JSON.stringify(destinationParentPin))
        throw new WorkspaceBackupError("SOURCE_CHANGED", "Published workspace or classification root inode differs from the approved stage identity.");
    }
    await rebindWorkspaceLegacyTrash(target, backup.manifest.workspaceId, hasLegacyTrashReceipt,
      backup.manifestSha256, options.legacyTrash);
    return {
      destination: target, workspaceId: backup.manifest.workspaceId, fileCount: backup.manifest.files.length,
      totalBytes: backup.manifest.totalBytes, manifestSha256: backup.manifestSha256,
    };
  }, () => retainSkillSourceStage);
}
