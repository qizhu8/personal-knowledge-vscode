import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { canonicalJson } from "../workflow-contracts";
import {
  CollaborationTaskRecord,
} from "../collaboration-model";
import {
  GanttTaskRecord,
  ProjectModelState,
  ProjectRecord,
  ThreadRecord,
  initializeProjectModel,
} from "./project-model";

export const PROJECT_FILESYSTEM_STORE_SCHEMA = 1;
export const PROJECT_RECEIPT_LIMIT = 256;

export interface ProjectDomainState {
  rootId: string;
  projects: ProjectRecord[];
  threads: ThreadRecord[];
  ganttTasks: GanttTaskRecord[];
  collaborationTasks: CollaborationTaskRecord[];
}

export interface ProjectFilesystemReceipt {
  commandId: string;
  fingerprint: string;
  operation: string;
  storeVersion: number;
  entityId: string;
}

export type ProjectMigrationPhase = "previewed" | "staged" | "verified" | "cutover" | "rolled-back";

export interface ProjectMigrationReceipt {
  phase: ProjectMigrationPhase;
  sourceDigest: string;
  canonicalDigest: string;
  projects: number;
  threads: number;
  ganttTasks: number;
  collaborationTasks: number;
}

interface ProjectStoreControl {
  schema: 1;
  rootId: string;
  storeVersion: number;
  receipts: ProjectFilesystemReceipt[];
  canonicalDigest: string;
  migration?: ProjectMigrationReceipt;
}

interface MigrationMarker extends ProjectMigrationReceipt {
  hadTarget: boolean;
}

export interface ProjectFilesystemSnapshot extends ProjectDomainState {
  storeVersion: number;
}

export interface ProjectFilesystemMutationResult {
  snapshot: ProjectFilesystemSnapshot;
  entityId: string;
  replayed: boolean;
}

export interface ProjectFilesystemCommand {
  commandId: string;
  fingerprint: string;
  expectedStoreVersion: number;
}

export interface LegacyProjectMigrationSource {
  sourceDigest: string;
  state: ProjectModelState;
  storeVersion: number;
  receipts?: ProjectFilesystemReceipt[];
}

export class ProjectFilesystemStoreError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export class ProjectFilesystemStore {
  readonly knowledgeRoot: string;
  readonly projectRoot: string;
  readonly controlPath: string;
  readonly lockPath: string;
  private readonly migrationRoot: string;
  private readonly markerPath: string;

  constructor(readonly stateDirectory: string) {
    this.knowledgeRoot = path.basename(stateDirectory) === "state" && path.basename(path.dirname(stateDirectory)) === ".pkm"
      ? path.dirname(path.dirname(stateDirectory))
      : stateDirectory;
    this.projectRoot = path.join(this.knowledgeRoot, "project");
    this.controlPath = path.join(stateDirectory, "project-store.json");
    this.lockPath = path.join(stateDirectory, "projects.lock");
    this.migrationRoot = path.join(stateDirectory, "project-store-migration");
    this.markerPath = path.join(this.migrationRoot, "migration.json");
  }

  hasCanonicalStore(): boolean {
    return fs.existsSync(this.controlPath) && fs.existsSync(this.projectRoot);
  }

  initialize(state: ProjectModelState, storeVersion = 1): ProjectFilesystemSnapshot {
    if (this.hasCanonicalStore()) return this.list();
    const domain = projectDomain(state);
    fs.mkdirSync(this.stateDirectory, { recursive: true });
    this.replaceProjectTree(domain);
    this.writeControl(makeControl(domain, storeVersion, []));
    return { ...clone(domain), storeVersion };
  }

  list(): ProjectFilesystemSnapshot {
    const control = this.readControl()!;
    const domain = this.readProjectTree(control.rootId);
    if (domainDigest(domain) !== control.canonicalDigest) {
      fail("store-corrupt", "Project filesystem digest does not match its control state.");
    }
    return { ...clone(domain), storeVersion: control.storeVersion };
  }

  checkCommand(command: ProjectFilesystemCommand): ProjectFilesystemMutationResult | undefined {
    const control = this.readControl()!;
    const replay = control.receipts.find(receipt => receipt.commandId === command.commandId);
    if (replay) {
      if (replay.fingerprint !== command.fingerprint) {
        fail("command-conflict", "Command ID was already used with a different fingerprint.");
      }
      return { snapshot: this.list(), entityId: replay.entityId, replayed: true };
    }
    if (command.expectedStoreVersion !== control.storeVersion) {
      fail("store-version-conflict", "Expected Project store version does not match the current version.");
    }
    return undefined;
  }

  mutate(
    command: ProjectFilesystemCommand,
    operation: string,
    state: ProjectModelState,
    entityId: string,
  ): ProjectFilesystemMutationResult {
    const replay = this.checkCommand(command);
    if (replay) return replay;
    const control = this.readControl()!;
    const domain = projectDomain(state);
    const storeVersion = control.storeVersion + 1;
    const receipts = compactReceipts(control.receipts.concat({
      commandId: command.commandId,
      fingerprint: command.fingerprint,
      operation,
      storeVersion,
      entityId,
    }));
    this.replaceProjectTree(domain);
    this.writeControl({
      ...makeControl(domain, storeVersion, receipts),
      ...(control.migration ? { migration: control.migration } : {}),
    });
    return { snapshot: { ...clone(domain), storeVersion }, entityId, replayed: false };
  }

  recordCompatibilityMutation(
    command: ProjectFilesystemCommand,
    operation: string,
    entityId: string,
  ): ProjectFilesystemMutationResult {
    const current = this.list();
    return this.mutate(command, operation, toModelState(current), entityId);
  }

  previewMigration(source: LegacyProjectMigrationSource): ProjectMigrationReceipt {
    const domain = projectDomain(source.state);
    return migrationReceipt("previewed", source.sourceDigest, domain);
  }

  stageMigration(source: LegacyProjectMigrationSource, expectedSourceDigest?: string): ProjectMigrationReceipt {
    fenceSource(source, expectedSourceDigest);
    const domain = projectDomain(source.state);
    const receipt = migrationReceipt("staged", source.sourceDigest, domain);
    const marker = this.readMarker(false);
    if (marker && marker.sourceDigest === receipt.sourceDigest && marker.canonicalDigest === receipt.canonicalDigest
      && ["staged", "verified"].includes(marker.phase)
      && (fs.existsSync(this.stagingProjectRoot()) || this.targetMatches(marker, source.state.rootId))) {
      return { ...marker, phase: marker.phase as "staged" | "verified" };
    }
    if (marker && marker.sourceDigest !== source.sourceDigest) {
      fail("migration-source-changed", "Legacy Project source changed after migration staging began.");
    }
    fs.rmSync(path.join(this.migrationRoot, "stage"), { recursive: true, force: true });
    fs.rmSync(path.join(this.migrationRoot, "backup"), { recursive: true, force: true });
    fs.rmSync(this.markerPath, { force: true });
    fs.mkdirSync(this.migrationRoot, { recursive: true });
    writeProjectTree(this.stagingProjectRoot(), domain);
    this.writeMarker({ ...receipt, hadTarget: fs.existsSync(this.projectRoot) });
    this.writeControl({
      ...makeControl(domain, source.storeVersion, source.receipts || []),
      migration: receipt,
    });
    return receipt;
  }

  verifyMigration(source: LegacyProjectMigrationSource, expectedSourceDigest?: string): ProjectMigrationReceipt {
    fenceSource(source, expectedSourceDigest);
    const marker = this.requireMarker(source.sourceDigest);
    const verificationRoot = fs.existsSync(this.stagingProjectRoot())
      ? this.stagingProjectRoot()
      : this.targetMatches(marker, source.state.rootId) ? this.projectRoot : "";
    if (!verificationRoot) fail("migration-not-staged", "Project migration staging is missing.");
    const domain = readProjectTreeAt(verificationRoot, source.state.rootId);
    const canonicalDigest = domainDigest(domain);
    if (canonicalDigest !== marker.canonicalDigest) fail("migration-verification-failed", "Staged Project data failed digest verification.");
    const verified = { ...marker, phase: "verified" as const };
    this.writeMarker(verified);
    this.writeControl({
      ...makeControl(projectDomain(source.state), source.storeVersion, source.receipts || []),
      migration: withoutInternalMarker(verified),
    });
    return withoutInternalMarker(verified);
  }

  cutoverMigration(source: LegacyProjectMigrationSource, expectedSourceDigest?: string): ProjectMigrationReceipt {
    fenceSource(source, expectedSourceDigest);
    const existingControl = this.readControl(false);
    if (existingControl?.migration?.phase === "cutover"
      && existingControl.migration.sourceDigest === source.sourceDigest) {
      return existingControl.migration;
    }
    const marker = this.requireMarker(source.sourceDigest);
    if (marker.phase !== "verified") this.verifyMigration(source, expectedSourceDigest);
    if (fs.existsSync(this.projectRoot)) {
      if (this.targetMatches(marker, source.state.rootId)
        && (!existingControl || existingControl.migration?.sourceDigest === source.sourceDigest)) {
        const receipt = { ...withoutInternalMarker(marker), phase: "cutover" as const };
        this.writeControl({
          ...makeControl(projectDomain(source.state), source.storeVersion, source.receipts || []),
          migration: receipt,
        });
        this.writeMarker({ ...marker, phase: "cutover" });
        return receipt;
      }
      if (!existingControl || existingControl.canonicalDigest !== marker.canonicalDigest) {
        fail("migration-target-conflict", "Canonical Project target exists with different or unverified content.");
      }
      fail("migration-target-conflict", "Canonical Project target is already owned by another store.");
    }
    const backupRoot = this.backupProjectRoot();
    fs.rmSync(path.dirname(backupRoot), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(backupRoot), { recursive: true });
    fs.renameSync(this.stagingProjectRoot(), this.projectRoot);
    const receipt = { ...withoutInternalMarker(marker), phase: "cutover" as const };
    this.writeControl({
      ...makeControl(projectDomain(source.state), source.storeVersion, source.receipts || []),
      migration: receipt,
    });
    this.writeMarker({ ...marker, phase: "cutover" });
    return receipt;
  }

  rollbackMigration(source: LegacyProjectMigrationSource, expectedSourceDigest?: string): ProjectMigrationReceipt {
    fenceSource(source, expectedSourceDigest);
    const marker = this.requireMarker(source.sourceDigest);
    if (marker.phase === "rolled-back") return withoutInternalMarker(marker);
    if (marker.phase !== "cutover") {
      fs.rmSync(this.migrationRoot, { recursive: true, force: true });
      const rolledBack = { ...marker, phase: "rolled-back" as const };
      fs.mkdirSync(this.migrationRoot, { recursive: true });
      this.writeMarker(rolledBack);
      return withoutInternalMarker(rolledBack);
    }
    fs.rmSync(this.projectRoot, { recursive: true, force: true });
    if (marker.hadTarget && fs.existsSync(this.backupProjectRoot())) {
      fs.renameSync(this.backupProjectRoot(), this.projectRoot);
    }
    const receipt = { ...withoutInternalMarker(marker), phase: "rolled-back" as const };
    this.writeControl({
      schema: PROJECT_FILESYSTEM_STORE_SCHEMA,
      rootId: source.state.rootId,
      storeVersion: source.storeVersion,
      receipts: [],
      canonicalDigest: marker.canonicalDigest,
      migration: receipt,
    });
    this.writeMarker({ ...marker, phase: "rolled-back" });
    return receipt;
  }

  legacySourceMatchesCutover(state: ProjectModelState): boolean {
    const migration = this.readControl(false)?.migration;
    if (!migration || migration.phase !== "cutover") return true;
    return domainDigest(projectDomain(state)) === migration.canonicalDigest;
  }

  private readControl(required = true): ProjectStoreControl | undefined {
    if (!fs.existsSync(this.controlPath)) {
      if (required) fail("store-missing", "Project filesystem control state is missing.");
      return undefined;
    }
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(this.controlPath, "utf8")); }
    catch { fail("store-corrupt", "Project filesystem control state is corrupt."); }
    if (!isRecord(value) || value.schema !== PROJECT_FILESYSTEM_STORE_SCHEMA
      || typeof value.rootId !== "string" || !Number.isSafeInteger(value.storeVersion) || Number(value.storeVersion) < 1
      || !Array.isArray(value.receipts) || value.receipts.length > PROJECT_RECEIPT_LIMIT
      || typeof value.canonicalDigest !== "string") {
      fail("store-corrupt", "Project filesystem control state is invalid.");
    }
    for (const receipt of value.receipts) validateReceipt(receipt);
    return clone(value as unknown as ProjectStoreControl);
  }

  private readProjectTree(rootId: string): ProjectDomainState {
    return readProjectTreeAt(this.projectRoot, rootId);
  }

  private replaceProjectTree(domain: ProjectDomainState): void {
    const staging = path.join(this.stateDirectory, `.project-store-write-${process.pid}-${randomUUID()}`);
    const stagedProjectRoot = path.join(staging, "project");
    const backup = path.join(staging, "previous");
    try {
      writeProjectTree(stagedProjectRoot, domain);
      const verified = readProjectTreeAt(stagedProjectRoot, domain.rootId);
      if (domainDigest(verified) !== domainDigest(domain)) fail("store-write-verification-failed", "Project write verification failed.");
      if (fs.existsSync(this.projectRoot)) fs.renameSync(this.projectRoot, backup);
      fs.renameSync(stagedProjectRoot, this.projectRoot);
      fs.rmSync(backup, { recursive: true, force: true });
      fsyncDirectory(this.knowledgeRoot);
    } catch (error) {
      if (!fs.existsSync(this.projectRoot) && fs.existsSync(backup)) fs.renameSync(backup, this.projectRoot);
      throw error;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  private writeControl(control: ProjectStoreControl): void {
    atomicWriteJson(this.controlPath, control);
  }

  private stagingProjectRoot(): string {
    return path.join(this.migrationRoot, "stage", "project");
  }

  private backupProjectRoot(): string {
    return path.join(this.migrationRoot, "backup", "project");
  }

  private readMarker(required: boolean): MigrationMarker | undefined {
    if (!fs.existsSync(this.markerPath)) {
      if (required) fail("migration-not-staged", "Project migration state is missing.");
      return undefined;
    }
    try {
      const marker = JSON.parse(fs.readFileSync(this.markerPath, "utf8"));
      if (!isRecord(marker) || typeof marker.sourceDigest !== "string" || typeof marker.canonicalDigest !== "string"
        || typeof marker.hadTarget !== "boolean") throw new Error("invalid");
      return marker as MigrationMarker;
    } catch {
      fail("migration-state-corrupt", "Project migration state is corrupt.");
    }
  }

  private requireMarker(sourceDigest: string): MigrationMarker {
    const marker = this.readMarker(true)!;
    if (marker.sourceDigest !== sourceDigest) fail("migration-source-changed", "Legacy Project source changed after staging.");
    return marker;
  }

  private writeMarker(marker: MigrationMarker): void {
    atomicWriteJson(this.markerPath, marker);
  }

  private targetMatches(marker: MigrationMarker, rootId: string): boolean {
    if (!fs.existsSync(this.projectRoot)) return false;
    try {
      return domainDigest(readProjectTreeAt(this.projectRoot, rootId)) === marker.canonicalDigest;
    } catch {
      return false;
    }
  }
}

export function safeProjectDirectoryName(name: string, projectId: string): string {
  const normalized = String(name || "").normalize("NFKC").trim();
  let segment = normalized
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/[ .-]+$/g, "")
    .replace(/^[ .-]+/g, "");
  if (!segment) segment = "project";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(segment)) segment += "-project";
  segment = segment.slice(0, 80).replace(/[ .-]+$/g, "") || "project";
  const safeId = String(projectId).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 128);
  if (!safeId) fail("project-id-path-invalid", "Project identity cannot be represented as a portable path.");
  return `${segment}.${safeId}`;
}

function projectDomain(state: ProjectModelState): ProjectDomainState {
  return clone({
    rootId: state.rootId,
    projects: state.projects,
    threads: state.threads,
    ganttTasks: state.ganttTasks || [],
    collaborationTasks: state.collaborationTasks || [],
  });
}

function toModelState(domain: ProjectDomainState): ProjectModelState {
  return {
    schema: 1,
    ...clone(domain),
    recipes: [],
    recipeFolders: [],
    recipeTrash: [],
    migrations: [],
    audit: [],
  };
}

function makeControl(
  domain: ProjectDomainState,
  storeVersion: number,
  receipts: ProjectFilesystemReceipt[],
): ProjectStoreControl {
  return {
    schema: PROJECT_FILESYSTEM_STORE_SCHEMA,
    rootId: domain.rootId,
    storeVersion,
    receipts: compactReceipts(receipts),
    canonicalDigest: domainDigest(domain),
  };
}

function compactReceipts(receipts: ProjectFilesystemReceipt[]): ProjectFilesystemReceipt[] {
  return receipts.slice(-PROJECT_RECEIPT_LIMIT);
}

function migrationReceipt(
  phase: ProjectMigrationPhase,
  sourceDigest: string,
  domain: ProjectDomainState,
): ProjectMigrationReceipt {
  return {
    phase,
    sourceDigest,
    canonicalDigest: domainDigest(domain),
    projects: domain.projects.length,
    threads: domain.threads.length,
    ganttTasks: domain.ganttTasks.length,
    collaborationTasks: domain.collaborationTasks.length,
  };
}

function withoutInternalMarker(marker: MigrationMarker): ProjectMigrationReceipt {
  const { hadTarget: _hadTarget, ...receipt } = marker;
  return receipt;
}

function fenceSource(source: LegacyProjectMigrationSource, expected?: string): void {
  if (expected && expected !== source.sourceDigest) {
    fail("migration-source-changed", "Legacy Project source changed since preview.");
  }
}

function domainDigest(domain: ProjectDomainState): string {
  return createHash("sha256").update(canonicalJson(sortDomain(domain)), "utf8").digest("hex");
}

function sortDomain(domain: ProjectDomainState): ProjectDomainState {
  const by = <T>(key: keyof T) => (left: T, right: T) => String(left[key]).localeCompare(String(right[key]));
  return {
    rootId: domain.rootId,
    projects: clone(domain.projects).sort(by<ProjectRecord>("projectId")),
    threads: clone(domain.threads).sort(by<ThreadRecord>("threadId")),
    ganttTasks: clone(domain.ganttTasks).sort(by<GanttTaskRecord>("taskId")),
    collaborationTasks: clone(domain.collaborationTasks).sort(by<CollaborationTaskRecord>("collaborationId")),
  };
}

function writeProjectTree(projectRoot: string, domain: ProjectDomainState): void {
  fs.mkdirSync(projectRoot, { recursive: true });
  for (const project of domain.projects) {
    const directory = path.join(projectRoot, safeProjectDirectoryName(project.name, project.projectId));
    fs.mkdirSync(path.join(directory, "threads"), { recursive: true });
    fs.mkdirSync(path.join(directory, "gantt"), { recursive: true });
    fs.mkdirSync(path.join(directory, "collaboration"), { recursive: true });
    atomicWriteJson(path.join(directory, "project.json"), project);
    for (const thread of domain.threads.filter(candidate => candidate.projectId === project.projectId)) {
      atomicWriteJson(path.join(directory, "threads", `${safeEntityFileName(thread.threadId)}.json`), thread);
    }
    for (const task of domain.ganttTasks.filter(candidate => candidate.projectId === project.projectId)) {
      atomicWriteJson(path.join(directory, "gantt", `${safeEntityFileName(task.taskId)}.json`), task);
    }
    for (const task of domain.collaborationTasks.filter(candidate => candidate.projectId === project.projectId)) {
      atomicWriteJson(path.join(directory, "collaboration", `${safeEntityFileName(task.collaborationId)}.json`), task);
    }
  }
  fsyncDirectory(projectRoot);
}

function readProjectTreeAt(projectRoot: string, rootId: string): ProjectDomainState {
  if (!fs.existsSync(projectRoot)) fail("store-missing", "Canonical Project directory is missing.");
  const domain: ProjectDomainState = { rootId, projects: [], threads: [], ganttTasks: [], collaborationTasks: [] };
  const projectIds = new Set<string>();
  for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(projectRoot, entry.name);
    const project = readEntity<ProjectRecord>(path.join(directory, "project.json"));
    if (projectIds.has(project.projectId)) fail("entity-conflict", "Project identity is duplicated.");
    if (!entry.name.endsWith(`.${project.projectId}`)) fail("entity-corrupt", "Project directory identity does not match project.json.");
    projectIds.add(project.projectId);
    domain.projects.push(project);
    domain.threads.push(...readEntityDirectory<ThreadRecord>(path.join(directory, "threads")));
    domain.ganttTasks.push(...readEntityDirectory<GanttTaskRecord>(path.join(directory, "gantt")));
    domain.collaborationTasks.push(...readEntityDirectory<CollaborationTaskRecord>(path.join(directory, "collaboration")));
  }
  const initialized = initializeProjectModel(toModelState(domain));
  const verified = projectDomain(initialized);
  if (canonicalJson(sortDomain(verified)) !== canonicalJson(sortDomain(domain))) {
    fail("entity-corrupt", "Project entities require repair and cannot be loaded automatically.");
  }
  return sortDomain(domain);
}

function readEntityDirectory<T>(directory: string): T[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
    .map(entry => readEntity<T>(path.join(directory, entry.name)));
}

function readEntity<T>(filePath: string): T {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!isRecord(parsed)) throw new Error("invalid");
    return parsed as T;
  } catch {
    fail("entity-corrupt", `Project entity is corrupt: ${path.basename(filePath)}`);
  }
}

function safeEntityFileName(id: string): string {
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(id) || id === "." || id === "..") {
    fail("entity-id-path-invalid", "Project entity identity is not portable.");
  }
  return id;
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, canonicalJson(value), "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
  fsyncDirectory(path.dirname(filePath));
}

function validateReceipt(value: unknown): void {
  if (!isRecord(value) || typeof value.commandId !== "string" || typeof value.fingerprint !== "string"
    || typeof value.operation !== "string" || !Number.isSafeInteger(value.storeVersion)
    || typeof value.entityId !== "string") {
    fail("store-corrupt", "Project command receipt is invalid.");
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch (error: any) {
    if (!error || !["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string): never {
  throw new ProjectFilesystemStoreError(code, message);
}
