import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { inspectLegacyApiChatArchive } from "./legacy-api-chat-archive.js";
import { inspectLegacyManagedWriterSession } from "./legacy-managed-writer-session.js";
import {
  inspectLegacyUiBootstrapCompatibility, recordLegacyUiBootstrapCompatibility, verifyLegacyUiBootstrapCompatibility,
} from "./legacy-ui-bootstrap-compatibility.js";
import { constants, lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Storage } from "./storage.js";
import { LegacyImportError, planLegacyImport, type LegacyImportPlan, type LegacyImportLimits } from "./legacy-import.js";
import { legacyImportPlanSchema } from "./domain/legacy-import.js";
import {
  admitLegacyKnowledgeSnapshots, type LegacyKnowledgeSnapshotBinding, type LegacyKnowledgeSnapshotHost,
} from "./legacy-knowledge-snapshots.js";
import {
  acquireLinuxRootWriterFence, type LinuxRootWriterFence,
} from "./linux-root-writer-fence.js";
import {
  assertLinuxLegacyWritersQuiescent, assertLinuxManagedSnapshotHostPermit, type LinuxManagedSnapshotHostPermit,
} from "./linux-legacy-writer-quiescence.js";
import { prepareExperimentalInPlaceSkillTrash } from "./legacy-inplace-skill-trash.js";
import { legacyRollbackDatabaseFingerprint } from "./legacy-root-rollback-baseline.js";

const journalName = ".pkm-next-root-adoption.json";
const commitName = ".pkm-next-root-adoption.commit.json";
const workspaceMarker = ".pkm-next-workspace";
const rollbackMarker = ".pkm-next-root-adoption-rollback.json";
const writerMarkerName = ".pkm-next-writer-fenced.json";
const lockDirectoryName = ".pkm-next-root-adoption-locks";
const maximumJournalBytes = 16_777_216;
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const jsonSha256 = (value: unknown) => sha256(JSON.stringify(value));
const snapshotTools = new Set([
  "knowledge_snapshot_status", "knowledge_snapshot_create", "knowledge_snapshot_configure",
  "knowledge_snapshot_restore_preview", "knowledge_snapshot_restore_apply",
]);
type LegacySnapshotTool = LegacyKnowledgeSnapshotBinding["allowedTools"][number];

export interface LegacyRootWriterQuiescence {
  assertHeld(): void;
  release(): Promise<void> | void;
}

export interface LegacyRootAdoptionOptions {
  limits?: Partial<LegacyImportLimits>;
  experimentalPostCommitRollbackBaseline?: true;
  acquireWriterQuiescence?: () => Promise<LegacyRootWriterQuiescence>;
  experimentalOriginalSkillTrash?: {
    mode: "isolated-experiment";
    sidecar: string;
    targetId: string;
    faultInjector?: (point: string) => void;
  };
  snapshotAdmission?: {
    authorityId: string;
    authorize: LegacyKnowledgeSnapshotHost["authorize"];
    allowedTools: readonly LegacySnapshotTool[];
  };
  experimentalManagedSnapshotHost?: LinuxManagedSnapshotHostPermit;
}

export interface LegacyRootAdoptionSourceEntry {
  path: string;
  kind: "file" | "directory";
  device: string;
  inode: string;
  mode: number;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  sha256?: string;
}

import {
  legacyTodoProjectionPaths, planLegacyTodoRootProjection, publishLegacyTodoRootProjection,
  recordLegacyTodoProjection, validateLegacyTodoRootProjection, verifyLegacyTodoProjectionReceipt,
  verifyLegacyTodoProjectionSource, type LegacyTodoRootProjection,
} from "./legacy-todo-root-projection.js";

interface LegacyRootAdoptionJournal {
  schema: "pkm.legacy-root-adoption-journal/v1";
  state: "prepared";
  token: string;
  sourceRoot: string;
  rootIdentity: { device: string; inode: string };
  workspaceId: string;
  sourceFingerprint: string;
  planSha256: string;
  inventoryPlan: LegacyImportPlan;
  sourceEntries: LegacyRootAdoptionSourceEntry[];
  todoProjection?: LegacyTodoRootProjection;
  snapshotAdmission?: { authorityId: string; allowedTools: string[] };
  journalSha256: string;
}

export interface LegacyRootAdoptionPrepared {
  schema: "pkm.legacy-root-adoption-prepared/v1";
  sourceRoot: string;
  workspaceId: string;
  sourceFingerprint: string;
  planSha256: string;
  recoveredPendingPlan: boolean;
}

export interface LegacyRootAdoptionResult extends Omit<LegacyRootAdoptionPrepared, "schema"> {
  schema: "pkm.legacy-root-adoption-result/v1";
  storage: Storage;
  state: "committed";
  qualification: "experimental-unqualified";
}

export interface LegacyRootAdoptionRollbackOptions extends LegacyRootAdoptionOptions {
  experimentalRollbackCheckpoint?: (point: "intent-published" | "journal-removed") => void;
}

async function assertRealRoot(path: string): Promise<string> {
  const absolute = resolve(path);
  let current: string = sep;
  for (const part of absolute.slice(sep.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new LegacyImportError("UNSAFE_PATH", "Legacy root and its parent components must be real directories.");
    }
  }
  const canonical = await realpath(absolute);
  if (canonical !== absolute) throw new LegacyImportError("UNSAFE_PATH", "Legacy root must not resolve through path aliases.");
  return canonical;
}

async function safeNonLinuxLockDatabase(root: string): Promise<{ assertHeld(): void; release(): void }> {
  const lockDirectory = join(dirname(root), lockDirectoryName);
  try { await mkdir(lockDirectory, { mode: 0o700 }); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const directoryStat = await lstat(lockDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || process.platform !== "win32" && ((directoryStat.mode & 0o077) !== 0
      || process.getuid && directoryStat.uid !== process.getuid()))
    throw new LegacyImportError("UNSAFE_PATH", "The private root-adoption lock directory is unsafe.");
  const lockPath = join(lockDirectory, `${sha256(root).slice(0, 40)}.sqlite`);
  try {
    const handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const fileStat = await lstat(lockPath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1
    || process.platform !== "win32" && ((fileStat.mode & 0o077) !== 0
      || process.getuid && fileStat.uid !== process.getuid()))
    throw new LegacyImportError("UNSAFE_PATH", "The root-adoption lock database is unsafe.");
  await chmod(lockPath, 0o600);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(lockPath);
    database.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE;");
  } catch {
    try { database?.close(); } catch { /* Preserve the lock acquisition failure. */ }
    throw new LegacyImportError("BUSY", "Another root-adoption transaction owns this root.");
  }
  return {
    assertHeld() {
      if (!database!.isTransaction) throw new LegacyImportError("BUSY", "The root-adoption transaction lock was lost.");
    },
    release() {
      try { if (database!.isTransaction) database!.exec("ROLLBACK"); }
      finally { database!.close(); }
    },
  };
}

async function withAdoptionFence<T>(
  root: string,
  options: LegacyRootAdoptionOptions,
  work: (
    root: string,
    assertHeld: () => void,
    assertQuiescent: () => Promise<void>,
    writerFence: LinuxRootWriterFence,
  ) => Promise<T>,
): Promise<T> {
  const canonicalRoot = await assertRealRoot(root);
  const lock = process.platform === "linux" ? undefined : await safeNonLinuxLockDatabase(canonicalRoot);
  let writerFence: LinuxRootWriterFence | undefined;
  let writers: LegacyRootWriterQuiescence | undefined;
  try {
    writerFence = await acquireLinuxRootWriterFence(canonicalRoot);
    if (options.experimentalManagedSnapshotHost)
      assertLinuxManagedSnapshotHostPermit(canonicalRoot, options.experimentalManagedSnapshotHost, options.snapshotAdmission);
    await assertLinuxLegacyWritersQuiescent(canonicalRoot, options.experimentalManagedSnapshotHost);
    if (options.acquireWriterQuiescence) {
      writers = await options.acquireWriterQuiescence();
      if (!writers || typeof writers.assertHeld !== "function" || typeof writers.release !== "function") {
        throw new LegacyImportError("WRITER_QUIESCENCE_REQUIRED", "The host did not provide a valid supplemental legacy writer drain resource.");
      }
    }
    const assertHeld = () => {
      writerFence!.assertHeld();
      writers?.assertHeld();
      lock?.assertHeld();
    };
    const assertQuiescent = async () => {
      assertHeld();
      if (options.experimentalManagedSnapshotHost)
        assertLinuxManagedSnapshotHostPermit(canonicalRoot, options.experimentalManagedSnapshotHost, options.snapshotAdmission);
      await assertLinuxLegacyWritersQuiescent(canonicalRoot, options.experimentalManagedSnapshotHost);
      assertHeld();
    };
    assertHeld();
    const result = await work(canonicalRoot, assertHeld, assertQuiescent, writerFence!);
    if (result && typeof result === "object" && "storage" in result
      && (result as { storage?: unknown }).storage instanceof Storage) {
      if (writers) (result as { storage: Storage }).storage.retainResource(writers);
      writerFence = undefined;
      if (writers) writers = undefined;
    }
    return result;
  } finally {
    try { await writers?.release(); }
    finally {
      try { await writerFence?.release(); } finally { lock?.release(); }
    }
  }
}

function sourcePath(root: string, path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new LegacyImportError("UNSAFE_PATH", "Legacy inventory contains a nonportable path.");
  }
  const full = resolve(root, ...path.split("/"));
  const rel = relative(root, full);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new LegacyImportError("UNSAFE_PATH", "Legacy inventory path escapes its root.");
  }
  return full;
}

async function hashStableFile(
  root: string, path: string, maximumBytes: number,
): Promise<{ size: number; sha256: string }> {
  const full = sourcePath(root, path);
  const before = await lstat(full);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximumBytes) {
    throw new LegacyImportError("SOURCE_CHANGED", `Legacy source file is unsafe or exceeds its bound: ${path}`);
  }
  const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new LegacyImportError("SOURCE_CHANGED", `Legacy source file changed before hashing: ${path}`);
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > maximumBytes) throw new LegacyImportError("SOURCE_CHANGED", `Legacy source file exceeded its bound while hashing: ${path}`);
      hash.update(chunk);
    }
    const after = await handle.stat();
    const pathAfter = await lstat(full);
    if (size !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || pathAfter.isSymbolicLink() || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino) {
      throw new LegacyImportError("SOURCE_CHANGED", `Legacy source file changed while hashing: ${path}`);
    }
    return { size, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}

async function inspectSourceEntries(root: string, plan: LegacyImportPlan): Promise<LegacyRootAdoptionSourceEntry[]> {
  const importEntries = new Map<string, LegacyImportPlan["entries"][number]>();
  for (const entry of plan.entries) {
    if (entry.kind !== "directory" && entry.sha256) importEntries.set(entry.source, entry);
  }
  const result: LegacyRootAdoptionSourceEntry[] = [];
  let totalBytes = 0;
  if (!plan.preflight.complete || !plan.ready || plan.blockers.length) {
    throw new LegacyImportError("IMPORT_BLOCKED", "Only a complete blocker-free original inventory may enter experimental in-place adoption.", plan.blockers);
  }
  for (const entry of plan.preflight.entries) {
    const full = sourcePath(root, entry.path);
    const before = await lstat(full, { bigint: true });
    if (before.isSymbolicLink() || (entry.kind === "directory" ? !before.isDirectory() : !before.isFile())) {
      throw new LegacyImportError("SOURCE_CHANGED", `Legacy root entry changed during adoption planning: ${entry.path}`);
    }
    if ((before.mode & 0o7000n) !== 0n || entry.mode !== undefined && Number(before.mode & 0o777n) !== entry.mode) {
      throw new LegacyImportError("UNSAFE_PATH", `Legacy entry mode changed or uses special permission bits: ${entry.path}`);
    }
    const base = {
      path: entry.path,
      kind: entry.kind === "directory" ? "directory" as const : "file" as const,
      device: before.dev.toString(),
      inode: before.ino.toString(),
      mode: Number(before.mode & 0o777n),
      size: before.size.toString(),
      mtimeNs: before.mtimeNs.toString(),
      ctimeNs: before.ctimeNs.toString(),
    };
    if (before.isDirectory()) {
      result.push(base);
      continue;
    }
    if (before.nlink !== 1n) throw new LegacyImportError("UNSAFE_PATH", `Hardlinked source file requires separate reconciliation: ${entry.path}`);
    const imported = importEntries.get(entry.path);
    const inPlacePrivacySha256 = plan.inPlaceOnly && entry.path === ".pkm/content-privacy.json"
      ? plan.inPlacePkmPrivacySha256 : undefined;
    if ((!imported?.sha256 && !inPlacePrivacySha256)
      || imported && imported.size !== Number(before.size)) {
      throw new LegacyImportError("IMPORT_BLOCKED", `Original importer does not bind source bytes for ${entry.path}.`);
    }
    totalBytes += Number(before.size);
    if (totalBytes > plan.limits.maxTotalBytes) throw new LegacyImportError("IMPORT_BLOCKED", "Legacy root exceeds the bounded adoption source limit.");
    const hashed = await hashStableFile(root, entry.path, plan.limits.maxTotalBytes);
    if (hashed.sha256 !== (imported?.sha256 ?? inPlacePrivacySha256) || hashed.size !== Number(before.size)) {
      throw new LegacyImportError("SOURCE_CHANGED", `Legacy source bytes changed during adoption planning: ${entry.path}`);
    }
    const after = await lstat(full, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new LegacyImportError("SOURCE_CHANGED", `Legacy source identity changed during adoption planning: ${entry.path}`);
    }
    result.push({ ...base, sha256: hashed.sha256 });
  }
  const sorted = result.sort((left, right) => left.path.localeCompare(right.path));
  verifyApiChatArchive(root, plan, sorted);
  const expectedUi = plan.inPlaceUiBootstrap;
  if (expectedUi && !isDeepStrictEqual(inspectLegacyUiBootstrapCompatibility(root), expectedUi))
    throw new LegacyImportError("SOURCE_CHANGED", "Original UI bootstrap semantics changed after planning.");
  verifyManagedWriterSession(root, plan, sorted);
  return sorted;
}

function verifyApiChatArchive(root: string, plan: LegacyImportPlan, entries: LegacyRootAdoptionSourceEntry[]): void {
  const expected = plan.inPlaceApiChatArchive;
  if (!expected) return;
  let actual;
  try { actual = inspectLegacyApiChatArchive(root); }
  catch { throw new LegacyImportError("SOURCE_CHANGED", "Original API Chat archive changed or became unsafe."); }
  if (!actual || actual.sourceFingerprint !== expected.sourceFingerprint
    || !isDeepStrictEqual(actual.files, expected.files))
    throw new LegacyImportError("SOURCE_CHANGED", "Original API Chat archive no longer matches its dedicated receipt.");
  for (const file of expected.files) {
    const entry = entries.find(candidate => candidate.path === file.path);
    if (!entry || entry.kind !== file.kind || entry.device !== file.device || entry.inode !== file.inode
      || entry.mode !== file.mode || entry.size !== String(file.size)
      || entry.mtimeNs !== file.mtimeNs || entry.ctimeNs !== file.ctimeNs || entry.sha256 !== file.sha256)
      throw new LegacyImportError("SOURCE_CHANGED", "Original API Chat receipt does not match the adoption source entries.");
  }
}

function verifyManagedWriterSession(root: string, plan: LegacyImportPlan, entries: LegacyRootAdoptionSourceEntry[]): void {
  if (lstatSync(join(root, ".pkm", "state", "managed-writer-session-compatible"), { throwIfNoEntry: false }))
    throw new LegacyImportError("IMPORT_BLOCKED", "Compatible managed writer session has no Next adoption receipt.");
  const expected = plan.inPlaceManagedWriterSession;
  if (!expected) return;
  let actual;
  try { actual = inspectLegacyManagedWriterSession(root); }
  catch { throw new LegacyImportError("SOURCE_CHANGED", "Original managed writer session changed or became unsafe."); }
  if (actual.retrieval?.workerDrain === "unknown")
    throw new LegacyImportError("IMPORT_BLOCKED", "Managed retrieval request completion does not prove that the shared worker or its background work has drained.");
  if (!isDeepStrictEqual(actual, expected))
    throw new LegacyImportError("SOURCE_CHANGED", "Original managed writer session no longer matches its adoption receipt.");
  for (const file of expected.files) {
    const entry = entries.find(candidate => candidate.path === file.path);
    if (!entry || entry.kind !== file.kind || entry.device !== file.device || entry.inode !== file.inode
      || entry.mode !== file.mode || entry.size !== String(file.size)
      || entry.mtimeNs !== file.mtimeNs || entry.ctimeNs !== file.ctimeNs || entry.sha256 !== file.sha256) {
      throw new LegacyImportError("SOURCE_CHANGED", "Original managed writer session receipt does not match the adoption source entries.");
    }
  }
}

async function actualSourcePaths(root: string, includeManaged: boolean, additions = new Set<string>(), archiveName?: string): Promise<string[]> {
  const managed = new Set([workspaceMarker, journalName, commitName, writerMarkerName, "core.sqlite", "core.sqlite-wal", "core.sqlite-shm"]);
  const result: string[] = [];
  async function walk(directory: string, prefix = ""): Promise<void> {
    const before = await lstat(directory, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) throw new LegacyImportError("SOURCE_CHANGED", "Legacy root directory changed during verification.");
    const names = (await readdir(directory)).sort();
    const after = await lstat(directory, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new LegacyImportError("SOURCE_CHANGED", "Legacy root directory changed during verification.");
    }
    for (const name of names) {
      if (!prefix && managed.has(name) && includeManaged) {
        const stat = await lstat(join(directory, name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
          throw new LegacyImportError("RECOVERY_REQUIRED", `Adoption metadata entry is unsafe: ${name}`);
        }
        continue;
      }
      const path = prefix ? `${prefix}/${name}` : name;
      const full = join(directory, name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) {
        throw new LegacyImportError("SOURCE_CHANGED", `Unsupported entry appeared during adoption: ${path}`);
      }
      if (!prefix && path === archiveName && stat.isDirectory()) {
        if ((stat.mode & 0o077) !== 0 || process.getuid === undefined || stat.uid !== process.getuid())
          throw new LegacyImportError("RECOVERY_REQUIRED", "Rollback archive directory is unsafe.");
        continue;
      }
      if (!additions.has(path)) result.push(path);
      if (stat.isDirectory()) await walk(full, path);
    }
  }
  await walk(root);
  return result.sort();
}

async function verifySourceEntries(root: string, journal: LegacyRootAdoptionJournal, rollbackPending = false): Promise<void> {
  const expectedPaths = journal.sourceEntries.map(entry => entry.path).sort();
  const projected = journal.todoProjection ? legacyTodoProjectionPaths(journal.todoProjection, journal.token) : new Set<string>();
  const additions = new Set([...projected].filter(path => !expectedPaths.includes(path)));
  const archiveName = `${sha256(root).slice(0, 40)}.${journal.workspaceId}.postcommit`;
  if (rollbackPending) additions.add(rollbackMarker);
  if (journal.todoProjection) verifyLegacyTodoProjectionSource(root, journal.todoProjection, false);
  const actualPaths = await actualSourcePaths(root, true, additions, expectedPaths.includes(archiveName) ? undefined : archiveName);
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
    throw new LegacyImportError("SOURCE_CHANGED", "Legacy root inventory changed after adoption was prepared; original data was not replaced.");
  }
  for (const entry of journal.sourceEntries) {
    const full = sourcePath(root, entry.path);
    const stat = await lstat(full, { bigint: true });
    if (stat.isSymbolicLink() || stat.dev.toString() !== entry.device || stat.ino.toString() !== entry.inode
      || Number(stat.mode & 0o777n) !== entry.mode
      || !(entry.kind === "directory" && projected.has(entry.path)) && (stat.size.toString() !== entry.size
        || stat.mtimeNs.toString() !== entry.mtimeNs || stat.ctimeNs.toString() !== entry.ctimeNs)
      || (entry.kind === "directory" ? !stat.isDirectory() : !stat.isFile())) {
      throw new LegacyImportError("SOURCE_CHANGED", `Original legacy entry identity changed: ${entry.path}`);
    }
    if (entry.kind === "file") {
      const actual = await hashStableFile(root, entry.path, journal.inventoryPlan.limits.maxTotalBytes);
      if (actual.sha256 !== entry.sha256 || actual.size !== Number(entry.size)) {
        throw new LegacyImportError("SOURCE_CHANGED", `Original legacy bytes changed: ${entry.path}`);
      }
      verifyApiChatArchive(root, journal.inventoryPlan, journal.sourceEntries);
    }
  }
  verifyManagedWriterSession(root, journal.inventoryPlan, journal.sourceEntries);
}

function validateJournal(input: unknown, root: string): LegacyRootAdoptionJournal {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new LegacyImportError("RECOVERY_REQUIRED", "Root adoption journal is malformed.");
  const value = input as Record<string, unknown>;
  const { journalSha256, ...body } = value;
  if (value.schema !== "pkm.legacy-root-adoption-journal/v1" || value.state !== "prepared"
    || value.sourceRoot !== root || typeof value.token !== "string" || !/^[0-9a-f-]{36}$/i.test(value.token)
    || typeof value.workspaceId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.workspaceId)
    || typeof value.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint)
    || typeof value.planSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.planSha256)
    || typeof journalSha256 !== "string" || !/^[a-f0-9]{64}$/.test(journalSha256)
    || jsonSha256(body) !== journalSha256 || !value.rootIdentity || typeof value.rootIdentity !== "object"
    || !Array.isArray(value.sourceEntries)) {
    throw new LegacyImportError("RECOVERY_REQUIRED", "Root adoption journal binding is invalid.");
  }
  let inventoryPlan: LegacyImportPlan;
  try { inventoryPlan = legacyImportPlanSchema.parse(value.inventoryPlan); }
  catch { throw new LegacyImportError("RECOVERY_REQUIRED", "Root adoption inventory plan is invalid."); }
  if (!inventoryPlan.ready || inventoryPlan.sourceRoot !== root || inventoryPlan.planSha256 !== value.planSha256
    || !inventoryPlan.fingerprint) throw new LegacyImportError("RECOVERY_REQUIRED", "Root adoption plan no longer binds this source.");
  let snapshotAdmission: LegacyRootAdoptionJournal["snapshotAdmission"];
  if (value.snapshotAdmission !== undefined) {
    if (!value.snapshotAdmission || typeof value.snapshotAdmission !== "object" || Array.isArray(value.snapshotAdmission))
      throw new LegacyImportError("RECOVERY_REQUIRED", "Root adoption snapshot authority binding is malformed.");
    const admission = value.snapshotAdmission as Record<string, unknown>;
    if (typeof admission.authorityId !== "string" || !admission.authorityId.trim()
      || !Array.isArray(admission.allowedTools) || !admission.allowedTools.length
      || admission.allowedTools.some(tool => typeof tool !== "string" || !snapshotTools.has(tool))
      || new Set(admission.allowedTools).size !== admission.allowedTools.length) {
      throw new LegacyImportError("RECOVERY_REQUIRED", "Root adoption snapshot authority binding is invalid.");
    }
    snapshotAdmission = { authorityId: admission.authorityId, allowedTools: admission.allowedTools as string[] };
  }
  if (!!inventoryPlan.inPlacePkmPrivacySha256 !== !!snapshotAdmission)
    throw new LegacyImportError("RECOVERY_REQUIRED", "Original .pkm privacy requires its bound immutable host snapshot authority.");
  const identity = value.rootIdentity as Record<string, unknown>;
  if (typeof identity.device !== "string" || !/^\d+$/.test(identity.device)
    || typeof identity.inode !== "string" || !/^\d+$/.test(identity.inode)) {
    throw new LegacyImportError("RECOVERY_REQUIRED", "Root adoption identity is invalid.");
  }
  if (!Array.isArray(value.sourceEntries) || value.sourceEntries.length > inventoryPlan.limits.maxEntries) {
    throw new LegacyImportError("RECOVERY_REQUIRED", "Root adoption source inventory exceeds its recorded limit.");
  }
  const sourceEntries: LegacyRootAdoptionSourceEntry[] = [];
  for (const entry of value.sourceEntries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new LegacyImportError("RECOVERY_REQUIRED", "Root adoption source inventory is malformed.");
    const item = entry as Record<string, unknown>;
    if (typeof item.path !== "string" || (item.kind !== "file" && item.kind !== "directory")
      || typeof item.device !== "string" || !/^\d+$/.test(item.device)
      || typeof item.inode !== "string" || !/^\d+$/.test(item.inode)
      || typeof item.mode !== "number" || !Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777
      || typeof item.size !== "string" || !/^\d+$/.test(item.size)
      || typeof item.mtimeNs !== "string" || !/^-?\d+$/.test(item.mtimeNs)
      || typeof item.ctimeNs !== "string" || !/^-?\d+$/.test(item.ctimeNs)
      || item.kind === "file" && (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256))) {
      throw new LegacyImportError("RECOVERY_REQUIRED", "Root adoption source entry is invalid.");
    }
    sourceEntries.push(item as unknown as LegacyRootAdoptionSourceEntry);
  }
  const todoProjection = value.todoProjection === undefined ? undefined : validateLegacyTodoRootProjection(value.todoProjection);
  const sourceFingerprint = jsonSha256({
    schema: "pkm.legacy-root-adoption-source/v1",
    sourceRoot: root,
    rootIdentity: identity,
    importFingerprint: inventoryPlan.fingerprint,
    sourceEntries,
    ...(todoProjection ? { todoProjection } : {}),
  });
  if (sourceFingerprint !== value.sourceFingerprint) throw new LegacyImportError("RECOVERY_REQUIRED", "Root adoption source fingerprint is invalid.");
  const oldLayoutBoards = inventoryPlan.entries.filter(entry => entry.kind === "board-backing" && entry.destination !== entry.source);
  if (oldLayoutBoards.length !== (todoProjection?.boards.length ?? 0))
    throw new LegacyImportError("RECOVERY_REQUIRED", "Every original old-layout Board requires its bound native publication plan.");
  if (todoProjection?.boards.some(board => !inventoryPlan.entries.some(entry => entry.kind === "board-backing"
    && entry.source === board.source && entry.destination === board.destination && entry.sha256 === board.sha256
    && entry.size === board.size && entry.boardSlug === board.slug)
    || !inventoryPlan.entries.some(entry => entry.source === board.markdown && entry.sha256 === board.markdownSha256)))
    throw new LegacyImportError("RECOVERY_REQUIRED", "Todo projection is not bound to its original import inventory.");
  return {
    schema: "pkm.legacy-root-adoption-journal/v1", state: "prepared", token: value.token,
    sourceRoot: root, rootIdentity: identity as LegacyRootAdoptionJournal["rootIdentity"],
    workspaceId: value.workspaceId, sourceFingerprint, planSha256: value.planSha256,
    inventoryPlan, sourceEntries, ...(todoProjection ? { todoProjection } : {}), ...(snapshotAdmission ? { snapshotAdmission } : {}), journalSha256,
  };
}

function bindSnapshotAdmission(
  options: LegacyRootAdoptionOptions, plan: LegacyImportPlan,
): LegacyRootAdoptionJournal["snapshotAdmission"] {
  if (!plan.inPlacePkmPrivacySha256) {
    if (options.snapshotAdmission) throw new LegacyImportError("SNAPSHOT_AUTHORITY_UNEXPECTED", "Snapshot admission may only be supplied for an inventoried original .pkm privacy policy.");
    return undefined;
  }
  const admission = options.snapshotAdmission;
  if (!admission || typeof admission.authorize !== "function" || !admission.authorityId?.trim()
    || !Array.isArray(admission.allowedTools) || !admission.allowedTools.length
    || admission.allowedTools.some(tool => !snapshotTools.has(tool))
    || new Set(admission.allowedTools).size !== admission.allowedTools.length) {
    throw new LegacyImportError("SNAPSHOT_HOST_AUTHORITY_REQUIRED",
      "Original .pkm privacy requires explicit host snapshot authority and a non-empty fixed tool scope before adoption.");
  }
  return { authorityId: admission.authorityId, allowedTools: [...admission.allowedTools] };
}

function assertSnapshotAdmissionRequest(
  journal: LegacyRootAdoptionJournal, options: LegacyRootAdoptionOptions,
): void {
  if (!journal.snapshotAdmission) return;
  const supplied = options.snapshotAdmission;
  if (!supplied || typeof supplied.authorize !== "function"
    || supplied.authorityId !== journal.snapshotAdmission.authorityId
    || JSON.stringify(supplied.allowedTools) !== JSON.stringify(journal.snapshotAdmission.allowedTools)) {
    throw new LegacyImportError("SNAPSHOT_HOST_AUTHORITY_REQUIRED",
      "Pending .pkm recovery requires the exact original host authority ID and immutable tool scope.");
  }
}

async function readJournal(root: string): Promise<LegacyRootAdoptionJournal | undefined> {
  try {
    const path = join(root, journalName);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximumJournalBytes
      || process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid())) {
      throw new LegacyImportError("RECOVERY_REQUIRED", "Root adoption journal is unsafe.");
    }
    return validateJournal(JSON.parse(await readFile(path, "utf8")), root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readRollbackMarker(root: string): Promise<{ id: string; journal?: LegacyRootAdoptionJournal } | undefined> {
  try {
    const path = join(root, rollbackMarker);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximumJournalBytes
      || process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()))
      throw new LegacyImportError("RECOVERY_REQUIRED", "Root adoption rollback marker is unsafe.");
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (value && typeof value === "object" && "schema" in value && value.schema === "pkm.legacy-root-adoption-journal/v1") {
      const journal = validateJournal(value, root);
      return { id: journal.workspaceId, journal };
    }
    if (!value || typeof value !== "object" || !("schema" in value) || value.schema !== "pkm.next-workspace/v2"
      || stat.size > 4096 || !("id" in value) || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/i.test(value.id))
      throw new LegacyImportError("RECOVERY_REQUIRED", "Root adoption rollback marker is invalid.");
    return { id: value.id };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function verifyRootIdentity(root: string, journal: LegacyRootAdoptionJournal): Promise<void> {
  const stat = await lstat(root, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()
    || stat.dev.toString() !== journal.rootIdentity.device || stat.ino.toString() !== journal.rootIdentity.inode) {
    throw new LegacyImportError("SOURCE_CHANGED", "Legacy root identity changed; adoption is blocked.");
  }
}

async function writeNoReplace(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function ensureWorkspaceMarker(root: string, journal: LegacyRootAdoptionJournal): Promise<void> {
  const path = join(root, workspaceMarker);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) {
      throw new LegacyImportError("RECOVERY_REQUIRED", "Existing workspace marker is unsafe.");
    }
    const marker: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!marker || typeof marker !== "object" || !("schema" in marker) || marker.schema !== "pkm.next-workspace/v2"
      || !("id" in marker) || marker.id !== journal.workspaceId) {
      throw new LegacyImportError("RECOVERY_REQUIRED", "Existing workspace marker does not match the pending root adoption.");
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    await writeNoReplace(path, Buffer.from(JSON.stringify({ schema: "pkm.next-workspace/v2", id: journal.workspaceId }), "utf8"));
    await syncDirectory(root);
  }
}

async function hasCommitReceipt(root: string, journal: LegacyRootAdoptionJournal, directory = root): Promise<boolean> {
  const path = join(directory, commitName);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096
      || process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid())) {
      throw new LegacyImportError("RECOVERY_REQUIRED", "Root adoption commit receipt is unsafe.");
    }
    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const { receiptSha256, ...body } = record;
    if (record.schema !== "pkm.legacy-root-adoption-commit/v1" || record.token !== journal.token
      || record.sourceRoot !== journal.sourceRoot || record.workspaceId !== journal.workspaceId
      || record.sourceFingerprint !== journal.sourceFingerprint || record.journalSha256 !== journal.journalSha256
      || typeof receiptSha256 !== "string" || !/^[a-f0-9]{64}$/.test(receiptSha256)
      || record.rollbackBaselineSha256 !== undefined
        && (typeof record.rollbackBaselineSha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.rollbackBaselineSha256))
      || jsonSha256(body) !== receiptSha256) {
      throw new LegacyImportError("RECOVERY_REQUIRED", "Root adoption commit receipt does not match its journal.");
    }
    return true;
  } catch (error) {
    if (error instanceof LegacyImportError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw new LegacyImportError("RECOVERY_REQUIRED", "Root adoption commit receipt is malformed.");
  }
}

async function writePreparedJournal(
  root: string, plan: LegacyImportPlan, sourceEntries: LegacyRootAdoptionSourceEntry[],
  snapshotAdmission?: LegacyRootAdoptionJournal["snapshotAdmission"],
): Promise<LegacyRootAdoptionJournal> {
  const rootStat = await lstat(root, { bigint: true });
  const rootIdentity = { device: rootStat.dev.toString(), inode: rootStat.ino.toString() };
  const todoProjection = await planLegacyTodoRootProjection(root, plan);
  const body = {
    schema: "pkm.legacy-root-adoption-journal/v1" as const,
    state: "prepared" as const,
    token: randomUUID(),
    sourceRoot: root,
    rootIdentity,
    workspaceId: randomUUID(),
    sourceFingerprint: jsonSha256({
      schema: "pkm.legacy-root-adoption-source/v1",
      sourceRoot: root,
      rootIdentity,
      importFingerprint: plan.fingerprint,
      sourceEntries,
      ...(todoProjection ? { todoProjection } : {}),
    }),
    planSha256: plan.planSha256,
    inventoryPlan: plan,
    sourceEntries,
    ...(todoProjection ? { todoProjection } : {}),
    ...(snapshotAdmission ? { snapshotAdmission } : {}),
  };
  const journal = { ...body, journalSha256: jsonSha256(body) };
  const bytes = Buffer.from(JSON.stringify(journal), "utf8");
  if (bytes.length > maximumJournalBytes) throw new LegacyImportError("ADOPTION_JOURNAL_TOO_LARGE", "The bounded recovery journal exceeds its safe size limit.");
  await writeNoReplace(join(root, journalName), bytes);
  await syncDirectory(root);
  return validateJournal(journal, root);
}

async function prepareLocked(
  root: string, options: LegacyRootAdoptionOptions, assertHeld: () => void,
  assertQuiescent: () => Promise<void>, writerFence: LinuxRootWriterFence,
): Promise<{ journal: LegacyRootAdoptionJournal; recoveredPendingPlan: boolean }> {
  assertHeld();
  if (await readRollbackMarker(root))
    throw new LegacyImportError("RECOVERY_REQUIRED", "A prepared root adoption rollback must be completed before adoption can resume.");
  const prior = await readJournal(root);
  if (prior) {
    if (options.experimentalOriginalSkillTrash)
      throw new LegacyImportError("RECOVERY_REQUIRED", "Original Skill Trash preparation is not yet bound to an existing adoption journal.");
    await verifyRootIdentity(root, prior);
    assertSnapshotAdmissionRequest(prior, options);
    if (!await hasCommitReceipt(root, prior)) await verifySourceEntries(root, prior);
    await assertQuiescent();
    await ensureWorkspaceMarker(root, prior);
    return { journal: prior, recoveredPendingPlan: true };
  }
  try {
    const notes = await lstat(join(root, "notes"));
    if (notes.isSymbolicLink() || !notes.isDirectory()) throw new Error("unsafe notes root");
  } catch {
    throw new LegacyImportError("IMPORT_BLOCKED", "The existing root must already contain a real notes directory; adoption will not create or relocate it.");
  }
  for (const name of [workspaceMarker, "core.sqlite", "core.sqlite-wal", "core.sqlite-shm", commitName]) {
    try {
      await lstat(join(root, name));
      throw new LegacyImportError("INVALID_WORKSPACE", "A legacy root with existing Next state cannot be newly adopted.");
    } catch (error) {
      if (error instanceof LegacyImportError) throw error;
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  if (options.experimentalOriginalSkillTrash) {
    await prepareExperimentalInPlaceSkillTrash({
      ...options.experimentalOriginalSkillTrash, root, fence: writerFence, adoptionReceipt: "in-place-v2",
    });
    await assertQuiescent();
    throw new LegacyImportError("IMPORT_BLOCKED",
      "Original Skill Trash is prepared, but adoption journal and Sync recovery binding are not yet qualified.");
  }
  const plan = await planLegacyImport(root, options.limits ?? {}, { inPlaceAdoption: true });
  if (!plan.ready || !plan.fingerprint || plan.blockers.length) {
    throw new LegacyImportError("IMPORT_BLOCKED", "The existing bounded importer does not qualify every legacy root entry for this minimal in-place slice.", plan.blockers);
  }
  const snapshotAdmission = bindSnapshotAdmission(options, plan);
  if (!plan.preflight.entries.some(entry => entry.kind === "document" && /^(?:notes|skills)\//.test(entry.path))) {
    throw new LegacyImportError("IMPORT_BLOCKED", "The minimal in-place slice requires an original Note or Skill document.");
  }
  const sourceEntries = await inspectSourceEntries(root, plan);
  assertHeld();
  const rechecked = await planLegacyImport(root, plan.limits, { inPlaceAdoption: true });
  if (!rechecked.ready || rechecked.planSha256 !== plan.planSha256) {
    throw new LegacyImportError("SOURCE_CHANGED", "Legacy bytes changed while the in-place adoption plan was being qualified.");
  }
  const recheckedEntries = await inspectSourceEntries(root, rechecked);
  if (jsonSha256(sourceEntries) !== jsonSha256(recheckedEntries)) {
    throw new LegacyImportError("SOURCE_CHANGED", "Legacy filesystem identity changed while the adoption plan was being qualified.");
  }
  await assertQuiescent();
  const journal = await writePreparedJournal(root, plan, sourceEntries, snapshotAdmission);
  await ensureWorkspaceMarker(root, journal);
  return { journal, recoveredPendingPlan: false };
}

async function writeCommitReceipt(root: string, journal: LegacyRootAdoptionJournal, rollbackBaselineSha256?: string): Promise<void> {
  const body = {
    schema: "pkm.legacy-root-adoption-commit/v1",
    token: journal.token,
    sourceRoot: journal.sourceRoot,
    workspaceId: journal.workspaceId,
    sourceFingerprint: journal.sourceFingerprint,
    journalSha256: journal.journalSha256,
    ...(rollbackBaselineSha256 ? { rollbackBaselineSha256 } : {}),
  };
  const receipt = { ...body, receiptSha256: jsonSha256(body) };
  const path = join(root, commitName);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096
      || JSON.stringify(JSON.parse(await readFile(path, "utf8"))) !== JSON.stringify(receipt)) {
      throw new LegacyImportError("RECOVERY_REQUIRED", "Existing adoption commit does not match the prepared journal.");
    }
    return;
  } catch (error) {
    if (error instanceof LegacyImportError) throw error;
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await writeNoReplace(path, Buffer.from(JSON.stringify(receipt), "utf8"));
  await syncDirectory(root);
}

async function resumeLocked(
  root: string, journal: LegacyRootAdoptionJournal, assertHeld: () => void,
  assertQuiescent: () => Promise<void>,
  recoveredPendingPlan: boolean, options: LegacyRootAdoptionOptions, writerFence: LinuxRootWriterFence,
): Promise<LegacyRootAdoptionResult> {
  await verifyRootIdentity(root, journal);
  const alreadyCommitted = await hasCommitReceipt(root, journal);
  if (alreadyCommitted) {
    const storage = await Storage.open(root, { writerFence });
    return {
      schema: "pkm.legacy-root-adoption-result/v1",
      sourceRoot: root,
      workspaceId: journal.workspaceId,
      sourceFingerprint: journal.sourceFingerprint,
      planSha256: journal.planSha256,
      recoveredPendingPlan,
      storage,
      state: "committed",
      qualification: "experimental-unqualified",
    };
  }
  if (options.experimentalPostCommitRollbackBaseline && journal.todoProjection)
    throw new LegacyImportError("RECOVERY_REQUIRED", "Post-commit rollback does not yet support Todo projections.");
  await verifySourceEntries(root, journal);
  await assertQuiescent();
  await ensureWorkspaceMarker(root, journal);
  if (journal.todoProjection) {
    await publishLegacyTodoRootProjection(root, journal.todoProjection, journal.token);
    await verifySourceEntries(root, journal);
    await assertQuiescent();
  }
  assertHeld();
  const storage = await Storage.open(root, {
    adoptionToken: journal.token, deferRecovery: true, writerFence,
  });
  try {
    if (await storage.workspaceId() !== journal.workspaceId) {
      throw new LegacyImportError("RECOVERY_REQUIRED", "Initialized workspace identity does not match its adoption journal.");
    }
    if (journal.snapshotAdmission) {
      assertSnapshotAdmissionRequest(journal, options);
      const admission = options.snapshotAdmission!;
      await admitLegacyKnowledgeSnapshots(storage, { id: "mcp:external", canWrite: true }, {
        authorityId: admission.authorityId,
        authorize: admission.authorize,
        allowedTools: [...journal.snapshotAdmission.allowedTools] as LegacySnapshotTool[],
      });
    }
    await storage.recover();
    if (journal.inventoryPlan.inPlaceUiBootstrap || journal.todoProjection) {
      await storage.withWorkspaceExclusive(async () => {
        await verifySourceEntries(root, journal);
        await assertQuiescent();
        const database = storage.connectNative();
        try {
          storage.assertWorkspaceLease();
          database.exec("BEGIN IMMEDIATE");
          if (journal.inventoryPlan.inPlaceUiBootstrap)
            recordLegacyUiBootstrapCompatibility(database, journal.workspaceId, journal.inventoryPlan.inPlaceUiBootstrap);
          if (journal.todoProjection) recordLegacyTodoProjection(database, root, journal.workspaceId, journal.todoProjection);
          storage.assertWorkspaceLease();
          database.exec("COMMIT");
          if (journal.inventoryPlan.inPlaceUiBootstrap)
            verifyLegacyUiBootstrapCompatibility(database, journal.workspaceId, journal.inventoryPlan.inPlaceUiBootstrap);
          if (journal.todoProjection) verifyLegacyTodoProjectionReceipt(database, root, journal.workspaceId, journal.todoProjection);
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          throw error;
        } finally { database.close(); }
      });
    }
    await verifySourceEntries(root, journal);
    await assertQuiescent();
    let rollbackBaselineSha256: string | undefined;
    if (options.experimentalPostCommitRollbackBaseline) {
      const database = storage.connectNative();
      try { rollbackBaselineSha256 = legacyRollbackDatabaseFingerprint(database); }
      finally { database.close(); }
      await verifySourceEntries(root, journal);
      await assertQuiescent();
    }
    await writeCommitReceipt(root, journal, rollbackBaselineSha256);
    return {
      schema: "pkm.legacy-root-adoption-result/v1",
      sourceRoot: root,
      workspaceId: journal.workspaceId,
      sourceFingerprint: journal.sourceFingerprint,
      planSha256: journal.planSha256,
      recoveredPendingPlan,
      storage,
      state: "committed",
      qualification: "experimental-unqualified",
    };
  } catch (error) {
    try { await storage.close(); } catch { /* Preserve the recovery failure and leave the journal for a later attempt. */ }
    throw error;
  }
}

export async function prepareLegacyRootAdoptionExperimental(
  root: string, options: LegacyRootAdoptionOptions,
): Promise<LegacyRootAdoptionPrepared> {
  return withAdoptionFence(root, options, async (canonicalRoot, assertHeld, assertQuiescent, writerFence) => {
    const prepared = await prepareLocked(canonicalRoot, options, assertHeld, assertQuiescent, writerFence);
    return {
      schema: "pkm.legacy-root-adoption-prepared/v1",
      sourceRoot: canonicalRoot,
      workspaceId: prepared.journal.workspaceId,
      sourceFingerprint: prepared.journal.sourceFingerprint,
      planSha256: prepared.journal.planSha256,
      recoveredPendingPlan: prepared.recoveredPendingPlan,
    };
  });
}

export async function resumeLegacyRootAdoptionExperimental(
  root: string, options: LegacyRootAdoptionOptions,
): Promise<LegacyRootAdoptionResult> {
  return withAdoptionFence(root, options, async (canonicalRoot, assertHeld, assertQuiescent, writerFence) => {
    const prepared = await prepareLocked(canonicalRoot, options, assertHeld, assertQuiescent, writerFence);
    return resumeLocked(canonicalRoot, prepared.journal, assertHeld, assertQuiescent,
      prepared.recoveredPendingPlan, options, writerFence);
  });
}

export async function adoptLegacyRootInPlaceExperimental(
  root: string, options: LegacyRootAdoptionOptions,
): Promise<LegacyRootAdoptionResult> {
  return withAdoptionFence(root, options, async (canonicalRoot, assertHeld, assertQuiescent, writerFence) => {
    const prepared = await prepareLocked(canonicalRoot, options, assertHeld, assertQuiescent, writerFence);
    return resumeLocked(canonicalRoot, prepared.journal, assertHeld, assertQuiescent,
      prepared.recoveredPendingPlan, options, writerFence);
  });
}

/**
 * Cancel only the prepared, unpublished fixture slice. Once Storage.open has
 * claimed the root, or Todo projection has begun, its effects need a separate
 * qualified recovery protocol and are never removed here.
 */
export async function rollbackPreparedLegacyRootAdoptionExperimental(
  root: string, options: LegacyRootAdoptionRollbackOptions = {},
): Promise<{ schema: "pkm.legacy-root-adoption-rollback/v1"; sourceRoot: string; workspaceId: string; qualification: "experimental-unqualified" }> {
  return withAdoptionFence(root, options, async (canonicalRoot, assertHeld, assertQuiescent, writerFence) => {
    const journalOnDisk = await readJournal(canonicalRoot);
    let intent = await readRollbackMarker(canonicalRoot);
    if (journalOnDisk && intent?.journal)
      throw new LegacyImportError("RECOVERY_REQUIRED", "Multiple root adoption journals require manual recovery.");
    const journal = journalOnDisk ?? intent?.journal;
    if (!journal && !intent)
      throw new LegacyImportError("RECOVERY_REQUIRED", "There is no prepared root adoption rollback to complete.");
    const assertNoPublishedState = async () => {
      const ownedMarker = join(canonicalRoot, writerMarkerName);
      for (const path of [join(canonicalRoot, commitName), join(canonicalRoot, "core.sqlite"),
        join(canonicalRoot, "core.sqlite-wal"), join(canonicalRoot, "core.sqlite-shm"), ownedMarker]) {
        try {
          await lstat(path);
          throw new LegacyImportError("RECOVERY_REQUIRED", "Published or initialized Next state cannot be rolled back by the prepared-only protocol.");
        } catch (error) {
          if (error instanceof LegacyImportError) throw error;
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
      }
    };
    const assertWorkspaceMarkerAbsent = async () => {
      try {
        await lstat(join(canonicalRoot, workspaceMarker));
        throw new LegacyImportError("RECOVERY_REQUIRED", "A workspace marker remains during rollback.");
      } catch (error) {
        if (error instanceof LegacyImportError) throw error;
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    };
    await assertNoPublishedState();
    if (journal) {
      await verifyRootIdentity(canonicalRoot, journal);
      if (journal.todoProjection)
        throw new LegacyImportError("RECOVERY_REQUIRED", "Todo projection requires a separate qualified rollback protocol.");
      if (intent && intent.id !== journal.workspaceId)
        throw new LegacyImportError("RECOVERY_REQUIRED", "Rollback marker does not match the prepared journal.");
      await verifySourceEntries(canonicalRoot, journal, !!intent);
      await assertQuiescent();
      if (!intent) {
        const markerPath = join(canonicalRoot, workspaceMarker);
        let markerStat;
        try {
          markerStat = await lstat(markerPath);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        if (markerStat) {
          if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1 || markerStat.size > 4096
            || process.platform !== "win32" && ((markerStat.mode & 0o077) !== 0 || process.getuid && markerStat.uid !== process.getuid()))
            throw new LegacyImportError("RECOVERY_REQUIRED", "Prepared workspace marker is unsafe.");
          const marker: unknown = JSON.parse(await readFile(markerPath, "utf8"));
          if (!marker || typeof marker !== "object" || !("schema" in marker) || marker.schema !== "pkm.next-workspace/v2"
            || !("id" in marker) || marker.id !== journal.workspaceId)
            throw new LegacyImportError("RECOVERY_REQUIRED", "Prepared workspace marker does not match the journal.");
          writerFence.renameNoReplaceWithinRoot(markerPath, join(canonicalRoot, rollbackMarker));
        } else {
          await assertWorkspaceMarkerAbsent();
          writerFence.renameNoReplaceWithinRoot(join(canonicalRoot, journalName), join(canonicalRoot, rollbackMarker));
        }
        await syncDirectory(canonicalRoot);
        intent = await readRollbackMarker(canonicalRoot);
        if (!intent || intent.id !== journal.workspaceId) throw new LegacyImportError("RECOVERY_REQUIRED", "Rollback marker was not published.");
        options.experimentalRollbackCheckpoint?.("intent-published");
      }
      await verifySourceEntries(canonicalRoot, journal, true);
      await assertQuiescent();
      await assertNoPublishedState();
      await assertWorkspaceMarkerAbsent();
      assertHeld();
      if (!intent.journal) {
        await unlink(join(canonicalRoot, journalName));
        await syncDirectory(canonicalRoot);
      }
      options.experimentalRollbackCheckpoint?.("journal-removed");
    }
    if (!intent) throw new LegacyImportError("RECOVERY_REQUIRED", "Rollback marker is missing.");
    await assertWorkspaceMarkerAbsent();
    await assertQuiescent();
    await assertNoPublishedState();
    assertHeld();
    const rechecked = await readRollbackMarker(canonicalRoot);
    if (!rechecked || rechecked.id !== intent.id)
      throw new LegacyImportError("RECOVERY_REQUIRED", "Rollback marker changed.");
    await unlink(join(canonicalRoot, rollbackMarker));
    await syncDirectory(canonicalRoot);
    return { schema: "pkm.legacy-root-adoption-rollback/v1", sourceRoot: canonicalRoot,
      workspaceId: intent.id, qualification: "experimental-unqualified" };
  });
}

interface PostCommitArchiveFile {
  name: string;
  size: number;
  mode: number;
  device: string;
  inode: string;
  sha256: string;
}

interface PostCommitArchive {
  schema: "pkm.legacy-root-postcommit-rollback/v1";
  root: string;
  workspaceId: string;
  journalSha256: string;
  baselineSha256: string;
  files: PostCommitArchiveFile[];
  manifestSha256: string;
}

async function readPrivateRollbackJson(path: string, maximumBytes: number): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes)
      || (before.mode & 0o077n) !== 0n || process.getuid === undefined || before.uid !== BigInt(process.getuid()))
      throw new Error("unsafe rollback metadata");
    const content = await file.readFile();
    const after = await file.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mode !== before.mode || after.uid !== before.uid || after.nlink !== before.nlink
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
      || named.dev !== before.dev || named.ino !== before.ino || BigInt(content.length) !== before.size)
      throw new Error("rollback metadata changed");
    return JSON.parse(content.toString("utf8")) as unknown;
  } finally { await file.close(); }
}

async function postCommitFile(directory: string, name: string): Promise<PostCommitArchiveFile> {
  const path = join(directory, name);
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 536_870_912n
    || (before.mode & 0o7002n) !== 0n || process.getuid === undefined || before.uid !== BigInt(process.getuid()))
    throw new LegacyImportError("RECOVERY_REQUIRED", `Post-commit rollback file is unsafe: ${name}`);
  const hashed = await hashStableFile(directory, name, 536_870_912);
  const after = await lstat(path, { bigint: true });
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
    || after.mode !== before.mode || after.uid !== before.uid || after.mtimeNs !== before.mtimeNs
    || after.ctimeNs !== before.ctimeNs)
    throw new LegacyImportError("SOURCE_CHANGED", `Post-commit rollback file changed: ${name}`);
  return { name, size: hashed.size, mode: Number(before.mode & 0o777n), device: String(before.dev),
    inode: String(before.ino), sha256: hashed.sha256 };
}

async function readPostCommitArchive(path: string, root: string, workspaceId: string): Promise<PostCommitArchive | undefined> {
  try {
    const value = await readPrivateRollbackJson(path, 16384);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid manifest");
    const record = value as Record<string, unknown>, { manifestSha256, ...body } = record;
    if (record.schema !== "pkm.legacy-root-postcommit-rollback/v1" || record.root !== root
      || record.workspaceId !== workspaceId || typeof record.journalSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(record.journalSha256) || typeof record.baselineSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(record.baselineSha256) || typeof manifestSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(manifestSha256) || jsonSha256(body) !== manifestSha256
      || !Array.isArray(record.files) || record.files.length !== 5) throw new Error("invalid archive binding");
    const names = [workspaceMarker, journalName, commitName, "core.sqlite", "writer-fenced.json"];
    if (record.files.some((item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true;
      const file = item as Record<string, unknown>;
      return Object.keys(file).sort().join("\0") !== ["device", "inode", "mode", "name", "sha256", "size"].join("\0")
        || typeof file.name !== "string" || !names.includes(file.name)
        || !Number.isSafeInteger(file.size) || Number(file.size) < 0 || Number(file.size) > 536_870_912
        || !Number.isInteger(file.mode) || Number(file.mode) < 0 || Number(file.mode) > 0o777
        || typeof file.device !== "string" || !/^\d+$/.test(file.device)
        || typeof file.inode !== "string" || !/^\d+$/.test(file.inode)
        || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256);
    }) || new Set(record.files.map((file: PostCommitArchiveFile) => file.name)).size !== names.length)
      throw new Error("invalid archive files");
    return record as unknown as PostCommitArchive;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new LegacyImportError("RECOVERY_REQUIRED", "Post-commit rollback archive manifest is invalid or unsafe.");
  }
}

async function verifyPostCommitCompletion(path: string, manifest: PostCommitArchive): Promise<void> {
  try {
    const value = await readPrivateRollbackJson(path, 4096);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid receipt");
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join("\0") !== "manifestSha256\0schema"
      || record.schema !== "pkm.legacy-root-postcommit-rollback-complete/v1"
      || record.manifestSha256 !== manifest.manifestSha256) throw new Error("invalid receipt");
  } catch {
    throw new LegacyImportError("RECOVERY_REQUIRED", "Post-commit rollback completion is invalid or unsafe.");
  }
}

export async function rollbackCommittedLegacyRootAdoptionExperimental(
  root: string, options: {
    workspaceId: string;
    experimentalRollbackCheckpoint?: (point: "intent-published" | "journal-archived" | "owner-archived" | "completed") => void;
  },
): Promise<{ schema: "pkm.legacy-root-postcommit-rollback-result/v1"; sourceRoot: string; workspaceId: string;
  archive: string; qualification: "experimental-unqualified" }> {
  if (process.platform !== "linux" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(options.workspaceId))
    throw new LegacyImportError("RECOVERY_REQUIRED", "Post-commit rollback needs a Linux root and exact workspace identity.");
  return withAdoptionFence(root, {}, async (canonicalRoot, assertHeld, assertQuiescent, writerFence) => {
    const locks = legacyRootAdoptionLockDirectory(canonicalRoot);
    const rootHash = sha256(canonicalRoot).slice(0, 40);
    const owner = join(locks, writerMarkerName);
    const archive = join(locks, `${rootHash}.${options.workspaceId}.postcommit`);
    let archiveExists = false;
    try {
      const info = await lstat(archive);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
        || process.getuid === undefined || info.uid !== process.getuid())
        throw new LegacyImportError("RECOVERY_REQUIRED", "Post-commit rollback archive directory is unsafe.");
      archiveExists = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    let manifest = archiveExists ? await readPostCommitArchive(join(archive, "manifest.json"), canonicalRoot, options.workspaceId) : undefined;
    let journal = await readJournal(canonicalRoot);
    if (!journal && manifest) {
      try { journal = validateJournal(JSON.parse(await readFile(join(archive, journalName), "utf8")), canonicalRoot); }
      catch { throw new LegacyImportError("RECOVERY_REQUIRED", "Archived adoption journal is unavailable or invalid."); }
    }
    if (!journal || journal.workspaceId !== options.workspaceId || journal.todoProjection)
      throw new LegacyImportError("RECOVERY_REQUIRED", "Post-commit rollback requires its exact journal and no Todo projection.");
    await verifyRootIdentity(canonicalRoot, journal);
    const intent = await readRollbackMarker(canonicalRoot);
    if (intent && (intent.journal || intent.id !== options.workspaceId))
      throw new LegacyImportError("RECOVERY_REQUIRED", "Rollback intent does not match the committed workspace.");
    if (!manifest) {
      if (intent || !await hasCommitReceipt(canonicalRoot, journal))
        throw new LegacyImportError("RECOVERY_REQUIRED", "Post-commit rollback requires a committed baseline before publishing intent.");
      const receipt = JSON.parse(await readFile(join(canonicalRoot, commitName), "utf8")) as Record<string, unknown>;
      if (typeof receipt.rollbackBaselineSha256 !== "string" || !/^[a-f0-9]{64}$/.test(receipt.rollbackBaselineSha256))
        throw new LegacyImportError("RECOVERY_REQUIRED", "This commit has no post-commit rollback baseline.");
      for (const name of ["core.sqlite-wal", "core.sqlite-shm", "core.sqlite-journal"]) {
        try { await lstat(join(canonicalRoot, name)); throw new LegacyImportError("RECOVERY_REQUIRED", "SQLite sidecars require separate recovery before rollback."); }
        catch (error) {
          if (error instanceof LegacyImportError) throw error;
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
      }
      await verifySourceEntries(canonicalRoot, journal);
      await assertQuiescent();
      const databaseBefore = await postCommitFile(canonicalRoot, "core.sqlite");
      const databaseUrl = pathToFileURL(join(canonicalRoot, "core.sqlite"));
      databaseUrl.search = "?immutable=1";
      const database = new DatabaseSync(databaseUrl, { readOnly: true });
      try {
        if (legacyRollbackDatabaseFingerprint(database) !== receipt.rollbackBaselineSha256)
          throw new LegacyImportError("SOURCE_CHANGED", "Next database changed after adoption; rollback preserves it for reconciliation.");
      } finally { database.close(); }
      const files: PostCommitArchiveFile[] = [];
      for (const name of [workspaceMarker, journalName, commitName, "core.sqlite"])
        files.push(await postCommitFile(canonicalRoot, name));
      if (!isDeepStrictEqual(databaseBefore, files.find(file => file.name === "core.sqlite")))
        throw new LegacyImportError("SOURCE_CHANGED", "Next database changed while its rollback baseline was inspected.");
      files.push({ ...await postCommitFile(locks, writerMarkerName), name: "writer-fenced.json" });
      const ownerValue = JSON.parse(await readFile(owner, "utf8")) as Record<string, unknown>;
      if (ownerValue.schema !== "pkm.linux-root-writer-fence/v1" || ownerValue.root !== canonicalRoot
        || ownerValue.device !== journal.rootIdentity.device || ownerValue.inode !== journal.rootIdentity.inode
        || ownerValue.owner !== "next-server")
        throw new LegacyImportError("RECOVERY_REQUIRED", "Next writer ownership marker is not bound to this root.");
      const marker = JSON.parse(await readFile(join(canonicalRoot, workspaceMarker), "utf8")) as Record<string, unknown>;
      if (marker.schema !== "pkm.next-workspace/v2" || marker.id !== options.workspaceId)
        throw new LegacyImportError("RECOVERY_REQUIRED", "Committed workspace identity changed.");
      if (!archiveExists) {
        await mkdir(archive, { mode: 0o700 });
        await syncDirectory(locks);
      } else if ((await readdir(archive)).some(name => name !== ".gitignore"))
        throw new LegacyImportError("RECOVERY_REQUIRED", "Incomplete rollback archive needs reconciliation.");
      const ignore = join(archive, ".gitignore");
      try { await writeNoReplace(ignore, Buffer.from("*\n")); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      await syncDirectory(archive);
      const ignoreStat = await lstat(ignore);
      if (!ignoreStat.isFile() || ignoreStat.isSymbolicLink() || ignoreStat.nlink !== 1
        || process.getuid === undefined || ignoreStat.uid !== process.getuid() || (ignoreStat.mode & 0o077) !== 0
        || await readFile(ignore, "utf8") !== "*\n")
        throw new LegacyImportError("RECOVERY_REQUIRED", "Rollback archive Git exclusion is missing or unsafe.");
      const body = { schema: "pkm.legacy-root-postcommit-rollback/v1" as const, root: canonicalRoot,
        workspaceId: options.workspaceId, journalSha256: journal.journalSha256,
        baselineSha256: receipt.rollbackBaselineSha256, files };
      await writeNoReplace(join(archive, "manifest.json"), Buffer.from(JSON.stringify({ ...body, manifestSha256: jsonSha256(body) })));
      await syncDirectory(archive);
      manifest = await readPostCommitArchive(join(archive, "manifest.json"), canonicalRoot, options.workspaceId);
      if (!manifest) throw new LegacyImportError("RECOVERY_REQUIRED", "Post-commit rollback manifest was not persisted.");
    }
    if (manifest.journalSha256 !== journal.journalSha256)
      throw new LegacyImportError("RECOVERY_REQUIRED", "Post-commit archive is bound to another adoption.");
    const ignore = join(archive, ".gitignore");
    const checkIgnore = async () => {
      const info = await lstat(ignore);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
        || process.getuid === undefined || info.uid !== process.getuid() || (info.mode & 0o077) !== 0
        || await readFile(ignore, "utf8") !== "*\n")
        throw new LegacyImportError("RECOVERY_REQUIRED", "Rollback archive Git exclusion is missing or unsafe.");
    };
    await checkIgnore();
    const allowed = new Set([".gitignore", "manifest.json", "complete.json", ...manifest.files.map(file => file.name)]);
    if ((await readdir(archive)).some(name => !allowed.has(name)))
      throw new LegacyImportError("RECOVERY_REQUIRED", "Post-commit rollback archive contains unknown files.");
    const exists = async (path: string) => {
      try { await lstat(path); return true; }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
    };
    const assertNoSqliteSidecars = async () => {
      for (const name of ["core.sqlite-wal", "core.sqlite-shm", "core.sqlite-journal"])
        if (await exists(join(canonicalRoot, name)))
          throw new LegacyImportError("RECOVERY_REQUIRED", "SQLite sidecars require separate recovery before rollback.");
    };
    const sourcePathFor = async (name: string) => name === "writer-fenced.json" ? owner
      : name === workspaceMarker && await exists(join(canonicalRoot, rollbackMarker)) ? join(canonicalRoot, rollbackMarker)
        : join(canonicalRoot, name);
    const verifyFiles = async () => {
      for (const expected of manifest!.files) {
        const source = await sourcePathFor(expected.name), target = join(archive, expected.name);
        const inSource = await exists(source), inArchive = await exists(target);
        if (inSource === inArchive) throw new LegacyImportError("RECOVERY_REQUIRED", `Rollback file location is ambiguous: ${expected.name}`);
        const path = inSource ? source : target;
        const actual = await postCommitFile(dirname(path), path.slice(dirname(path).length + 1));
        if (actual.size !== expected.size || actual.mode !== expected.mode || actual.device !== expected.device
          || actual.inode !== expected.inode || actual.sha256 !== expected.sha256)
          throw new LegacyImportError("SOURCE_CHANGED", `Rollback file changed: ${expected.name}`);
      }
    };
    await verifyFiles();
    await assertNoSqliteSidecars();
    const completed = await exists(join(archive, workspaceMarker));
    if (!completed) {
      await verifySourceEntries(canonicalRoot, journal, !!intent);
      await assertQuiescent();
      if (!intent) {
        writerFence.renameNoReplaceWithinRoot(join(canonicalRoot, workspaceMarker), join(canonicalRoot, rollbackMarker));
        await syncDirectory(canonicalRoot);
        options.experimentalRollbackCheckpoint?.("intent-published");
      }
      for (const name of [journalName, commitName, "core.sqlite", "writer-fenced.json"]) {
        const expected = manifest.files.find(file => file.name === name)!;
        await verifyFiles();
        await assertNoSqliteSidecars();
        await verifySourceEntries(canonicalRoot, journal, true);
        await assertQuiescent();
        const source = await sourcePathFor(name);
        if (await exists(source)) {
          assertHeld();
          await checkIgnore();
          await writerFence.archiveFileToPrivateDirectory(source, archive, expected.name);
          await syncDirectory(dirname(source));
          await syncDirectory(archive);
        }
        if (name === journalName) options.experimentalRollbackCheckpoint?.("journal-archived");
        if (name === "writer-fenced.json") options.experimentalRollbackCheckpoint?.("owner-archived");
      }
      await verifyFiles();
      await assertNoSqliteSidecars();
      await verifySourceEntries(canonicalRoot, journal, true);
      await assertQuiescent();
      const completePath = join(archive, "complete.json");
      if (!await exists(completePath)) {
        await writeNoReplace(completePath, Buffer.from(JSON.stringify({
          schema: "pkm.legacy-root-postcommit-rollback-complete/v1", manifestSha256: manifest.manifestSha256,
        })));
        await syncDirectory(archive);
      }
      await verifyPostCommitCompletion(completePath, manifest);
      await writerFence.archiveFileToPrivateDirectory(join(canonicalRoot, rollbackMarker), archive, workspaceMarker);
      await syncDirectory(canonicalRoot);
      await syncDirectory(archive);
      options.experimentalRollbackCheckpoint?.("completed");
    } else {
      await verifyPostCommitCompletion(join(archive, "complete.json"), manifest);
      if (await exists(join(canonicalRoot, rollbackMarker)))
        throw new LegacyImportError("RECOVERY_REQUIRED", "Completed rollback receipt is inconsistent.");
    }
    return { schema: "pkm.legacy-root-postcommit-rollback-result/v1", sourceRoot: canonicalRoot,
      workspaceId: options.workspaceId, archive, qualification: "experimental-unqualified" };
  });
}

export function legacyRootAdoptionLockDirectory(root: string): string {
  return process.platform === "linux" ? resolve(root) : join(dirname(resolve(root)), lockDirectoryName);
}
