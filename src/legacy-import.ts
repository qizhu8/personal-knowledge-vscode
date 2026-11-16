import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { RenameNoReplaceError, renameNoReplaceSync } from "./rename-no-replace.js";
import { lstat, mkdir, open, readdir, realpath, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { scanBoards } from "./boards.js";
import {
  legacyImportLimitsSchema, legacyImportNoReplacePlatformError, legacyImportOutcomeSchema, legacyImportPlanSchema, legacyImportReceiptSchema,
  type LegacyImportBoard, type LegacyImportEntry, type LegacyImportLimits, type LegacyImportOutcome, type LegacyImportPlan, type LegacyImportReceipt,
} from "./domain/legacy-import.js";
import { todoBoardFilename, readTodoBoard } from "./domain/todo-board.js";
import { initialize, Storage } from "./storage.js";
import { scanMarkdown } from "./markdown.js";
import { migrationPreflight, type MigrationPreflightReport } from "./migration-preflight.js";
import { resourcePath } from "./document-path.js";
import {
  describeLegacySkillsHistoryArchive, isArchivedCodePath, isInertLegacyPath, isLegacySkillsHistoryArchivePath,
  isLegacyActionStatePath, isLegacyLibraryResourcePath, legacyLibraryDestination, legacySkillsHistoryArchive,
} from "./legacy-library.js";
import { restoreFileMtimes } from "./file-mtime.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { planLegacyStateImport, stageLegacyStateImport, verifyLegacyStateImport, type LegacySnapshotKeyAuthority,
  type LegacyProtectedSubscriptionImport } from "./legacy-state-import.js";
import { insertLegacyStateReceipt, readLegacyStateReceipt, verifyBoundLegacyStateBytes } from "./host-composition-legacy-state.js";
import { validateProjectRecipeExport } from "./import-parity-project.js";
import {
  insertLegacyControlSnapshot, parseLegacyProjectControl, parseLegacyRecipeControl,
  readLegacyProjectControl, readLegacyRecipeControl, type ImportedProjectControl, type ImportedRecipeControl,
  type ProjectRecipeExportSummary,
} from "./legacy-control-import.js";
import {
  LegacyTrashImportError, legacyTrashStageReceiptPath, populateLegacyTrashImportStage,
  qualifyLegacyTrashSnapshotScope, validateLegacyTrashImportPlan, verifyLegacyTrashSource,
  type LegacyTrashImportPlan, type LegacyTrashLayoutAuthority, type LegacyTrashParentStageAuthority,
  type LegacyTrashSnapshotScope,
} from "./legacy-trash-import.js";
import {
  planLegacyRecipeTrashImport, stageLegacyRecipeTrashImport, verifyLegacyRecipeTrashImportSource,
  verifyLegacyRecipeTrashImportStage, type LegacyRecipeTrashImportAuthority,
} from "./legacy-recipe-trash.js";
import {
  planLegacyMemoryImport, stageLegacyMemoryImport, persistLegacyMemoryImport, readLegacyMemoryImportReceipt,
  type LegacyMemoryImportPlan,
} from "./memory-import.js";
import {
  approvedMemoryScopeContinuitySchema, persistMemoryScopeContinuity, readMemoryScopeContinuity,
  type ApprovedMemoryScopeContinuity, type MemoryScopeContinuity, type MemoryScopeContinuityAuthorizer,
} from "./memory-scope-continuity.js";
import {
  LegacyProjectEnvelopeError, planLegacyProjectEnvelope, prepareLegacyProjectEnvelopeAdoption,
  readLegacyProjectEnvelopeAdoption, recordLegacyProjectEnvelopeAdoption, stageLegacyProjectEnvelope,
  verifyLegacyProjectEnvelopeStage, initializeLegacyProjectEnvelopeSchema,
  type LegacyProjectEnvelopeAdoptionPayload, type LegacyProjectEnvelopePlan,
} from "./legacy-project-envelope.js";
import { inspectLegacyRouterConfig, type LegacyRouterConfigPlan } from "./legacy-router-config.js";
import { planLegacyRetrievalHistory, inspectLegacyRetrievalHistory, type LegacyRetrievalHistoryAuthorizer } from "./legacy-retrieval-history-import.js";
import { persistLegacyRetrievalLearningGenesis } from "./legacy-retrieval-learning.js";
import { admitLegacyRetrievalModel, selectLegacyRetrievalModel } from "./legacy-retrieval-model.js";
import { legacyRetrievalSources } from "./legacy-retrieval-index.js";
import { legacyRetrievalSubscriptions } from "./legacy-retrieval-subscriptions.js";
import { inspectLegacyRootPkmPrivacyState } from "./legacy-root-pkm-state.js";
import { inspectLegacyRootInertInventory } from "./legacy-root-inert-state.js";
import { acquireLinuxRootWriterFence } from "./linux-root-writer-fence.js";
import { CoreError } from "./contracts.js";

const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const ownerSchema = "pkm.legacy-import-stage/v1";
const outcomeSchema = "pkm.legacy-import-outcome/v1";
const maxOutcomeBytes = 32 * 1024 * 1024;
const projectControlPath = ".pkm/state/project-store.json";
const recipeControlPath = ".pkm/state/recipe-store.json";
const controlFileTables = new Map([
  [projectControlPath, "legacy_project_control" as const],
  [recipeControlPath, "legacy_recipe_control" as const],
]);
const controlDirectories = new Set([".pkm", ".pkm/state"]);
const recipeUsageRoot = ".pkm/state/recipe-runs";
function recipeUsageDestination(path: string): string | undefined {
  return path === recipeUsageRoot || /^\.pkm\/state\/recipe-runs\/recipe_run_[^/\\\u0000-\u001f\u007f]*\.json$/u.test(path)
    ? `recipe-usage-reads/${path}` : undefined;
}

interface StageOwner {
  schema: typeof ownerSchema;
  token: string;
  pid: number;
  destination: string;
  stage: string;
  workspaceId?: string;
}

export class LegacyImportError extends Error {
  constructor(readonly code: string, message: string, readonly blockers: MigrationPreflightReport["blockers"] = []) {
    super(message);
  }
}

export interface LegacyImportOptions {
  pythonExecutable?: string;
  /** Trusted host atomic NO-REPLACE publication; never overwrites an existing target. */
  nativePublishNoReplace?(stage: string, destination: string): Promise<void>;
  snapshotAuthority?: LegacySnapshotKeyAuthority;
  protectedSubscription?: LegacyProtectedSubscriptionImport;
  subscriptionIdentity?: import("./legacy-subscription-identity.js").LegacySubscriptionIdentityImport;
  trashImport?: { actorId: string; nativeScope: LegacyTrashSnapshotScope };
  recipeTrashAuthority?: LegacyRecipeTrashImportAuthority;
  memoryActorId?: string;
  authorizeMemoryScopeContinuity?: MemoryScopeContinuityAuthorizer;
  authorizeRetrievalHistory?: LegacyRetrievalHistoryAuthorizer;
}

export type LegacyImportRecovery =
  | { status: "published"; receipt: LegacyImportReceipt }
  | { status: "in-progress" | "not-published" | "unknown"; receipt?: LegacyImportReceipt; reason: string };

export interface LegacyRootAdoptionInspection {
  schema: "pkm.legacy-root-adoption-inspection/v1";
  sourceRoot: string;
  rootIdentity: { device: string; inode: string };
  ready: false;
  sourceFingerprint: string | null;
  inventoryPlan: LegacyImportPlan;
  blockers: MigrationPreflightReport["blockers"];
  inspectionSha256: string;
}

function planDigest(plan: Omit<LegacyImportPlan, "planSha256">): string {
  return sha256(JSON.stringify(plan));
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function assertRealDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  let current: string = sep;
  for (const part of absolute.slice(sep.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new LegacyImportError("UNSAFE_PATH", "Source and destination parents must be real directories without symlink components.");
  }
  const canonical = await realpath(absolute);
  if (canonical !== absolute) throw new LegacyImportError("UNSAFE_PATH", "Source and destination parents must not resolve through aliases.");
  return canonical;
}

async function readStableFile(root: string, path: string, expectedSize?: number): Promise<Buffer> {
  const full = join(root, ...path.split("/"));
  const before = await lstat(full);
  if (!before.isFile() || before.isSymbolicLink() || (expectedSize !== undefined && before.size !== expectedSize)) {
    throw new LegacyImportError("SOURCE_CHANGED", `Source entry changed during import planning: ${path}`);
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(full, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new LegacyImportError("SOURCE_CHANGED", `Source entry changed during import planning: ${path}`);
    }
    const data = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(full);
    if (data.length !== before.size || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || pathAfter.isSymbolicLink() || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino) {
      throw new LegacyImportError("SOURCE_CHANGED", `Source entry changed during import planning: ${path}`);
    }
    return data;
  } finally {
    await handle.close();
  }
}

async function hashStableFile(root: string, path: string, maximumBytes: number): Promise<{ size: number; sha256: string }> {
  const full = join(root, ...path.split("/"));
  const before = await lstat(full);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) {
    throw new LegacyImportError("STAGING_INVALID", "Parent stage file is not a bounded regular file.");
  }
  const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new LegacyImportError("SOURCE_CHANGED", "Parent stage file changed before hashing.");
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > maximumBytes) throw new LegacyImportError("STAGING_INVALID", "Parent stage inventory exceeds its byte limit.");
      hash.update(chunk);
    }
    const after = await handle.stat(), pathAfter = await lstat(full);
    if (size !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || pathAfter.isSymbolicLink() || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino) {
      throw new LegacyImportError("SOURCE_CHANGED", "Parent stage file changed while hashing.");
    }
    return { size, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}

function associatedBoardDocuments(report: MigrationPreflightReport): Map<string, string> {
  const documents = report.entries.filter(entry => entry.kind === "document" && entry.path.startsWith("notes/"));
  const backingOwners = new Map<string, string>();
  for (const document of documents) {
    backingOwners.set(`${document.path.replace(/\.md$/i, ".assets")}/${todoBoardFilename}`, document.path);
  }
  return backingOwners;
}

function handledBoardDiagnostic(path: string, boardFiles: Set<string>, boardDocuments: Set<string>): boolean {
  return boardFiles.has(path) || boardDocuments.has(path);
}

function isLegacyControlPath(path: string): boolean {
  return controlFileTables.has(path);
}

function inspectLegacyControlInventory(preflight: MigrationPreflightReport, allowBoundedPkmPrivacy = false): MigrationPreflightReport["blockers"] {
  const entries = preflight.entries.filter(entry => entry.path === ".pkm" || entry.path.startsWith(".pkm/"));
  if (!entries.length) return [];
  if (allowBoundedPkmPrivacy) return [];
  // Original Prompt/Script writers leave these empty lock-parent directories.
  if (entries.every(entry => controlDirectories.has(entry.path) && entry.kind === "directory")) return [];
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  const blockers: MigrationPreflightReport["blockers"] = [];
  for (const entry of entries) {
    if (controlDirectories.has(entry.path) && entry.kind === "directory") continue;
    if (isLegacyActionStatePath(entry.path)
      && (entry.kind === "directory" || entry.path !== ".pkm/state/actions" && entry.kind === "library-file")) continue;
    if (entry.path === recipeUsageRoot && entry.kind === "directory"
      || recipeUsageDestination(entry.path) && entry.path !== recipeUsageRoot
      && entry.kind === "unsupported" && entry.size !== undefined) continue;
    if (isLegacyControlPath(entry.path) && entry.kind === "unsupported" && entry.size !== undefined
      && entry.size <= 2 * 1024 * 1024) continue;
    const code = entry.path === ".pkm/state/project-store-intent.json"
      ? "pending-project-intent"
      : entry.path === ".pkm/state/actions" || entry.path.startsWith(".pkm/state/actions/")
        ? "legacy-action-state-requires-review"
      : entry.path.includes("migration") ? "pending-project-migration"
        : entry.path === ".pkm/state/projects.lock" ? "pending-project-lock"
          : "unknown-project-control";
    blockers.push({
      code, path: entry.path,
      message: code === "pending-project-intent" ? "Pending Project intent requires original-store recovery before import."
        : code === "pending-project-migration" ? "Project/Recipe migration markers are not a quiescent import source."
          : code === "pending-project-lock" ? "A Project control lock is not valid in a quiescent import source."
            : code === "legacy-action-state-requires-review"
              ? "Legacy Action state (trust, validation, runs or grants) is not imported or activated. Preserve it separately for explicit state migration; inert library import cannot authorize it."
              : "Only the exact original Project/Recipe controls are supported; unknown control state is preserved for review.",
    });
  }
  if (!byPath.has(".pkm/state") || !entries.some(entry => isLegacyControlPath(entry.path) || recipeUsageDestination(entry.path)
    || entry.path === ".pkm/state/actions" && entry.kind === "directory")) {
    blockers.push({
      code: "unsupported-project-control", path: ".pkm",
      message: "The original control directory does not contain a supported Project or Recipe control file.",
    });
  }
  return blockers;
}

function blockedPlan(sourceRoot: string, limits: LegacyImportLimits, preflight: MigrationPreflightReport, blockers: MigrationPreflightReport["blockers"]): LegacyImportPlan {
  const body: Omit<LegacyImportPlan, "planSha256"> = {
    schema: "pkm.legacy-import-plan/v1", sourceRoot, ready: false, limits, preflight, blockers,
    entries: [], boards: [], fingerprint: null,
  };
  return legacyImportPlanSchema.parse({ ...body, planSha256: planDigest(body) });
}

/**
 * Plan an import from a quiescent, disposable legacy copy. This only reads that
 * caller-supplied copy; it never consults the configured production Knowledge Root.
 */
export async function planLegacyImport(
  source: string, options: Partial<LegacyImportLimits> = {},
  policy: { snapshotAuthority?: LegacySnapshotKeyAuthority;
    subscriptionIdentity?: import("./legacy-subscription-identity.js").LegacySubscriptionIdentityImport;
    protectedSubscription?: LegacyProtectedSubscriptionImport;
    subscriptionRoot?: string; trashPlan?: LegacyTrashImportPlan;
    recipeTrashAuthority?: LegacyRecipeTrashImportAuthority; memoryEngine?: string; memoryActorId?: string; routerConfig?: string;
    retrievalHistory?: { stateRoot: string; actorId: string };
    memoryContinuityScopeSha256?: string; inPlaceAdoption?: boolean } = {},
): Promise<LegacyImportPlan> {
  const limits = legacyImportLimitsSchema.parse(options);
  if (!isAbsolute(source)) throw new TypeError("Provide an absolute path to a quiescent disposable legacy copy.");
  const suppliedRoot = resolve(source);
  const inPlacePkmPrivacy = policy.inPlaceAdoption ? inspectLegacyRootPkmPrivacyState(suppliedRoot) : undefined;
  const inPlaceInertInventory = policy.inPlaceAdoption
    ? inspectLegacyRootInertInventory(suppliedRoot, limits) : undefined;
  const inPlaceInertPaths = new Set([...(inPlaceInertInventory?.paths ?? []),
    ...(inPlacePkmPrivacy?.apiChatArchive?.files.map(file => file.path) ?? []),
    ...(inPlacePkmPrivacy?.managedWriterSession?.files.map(file => file.path) ?? []),
    ...(inPlacePkmPrivacy?.uiBootstrap?.files.map(file => file.path) ?? []),
    ...(inPlacePkmPrivacy?.emptyActionSettingsSha256
      ? [".pkm/state/actions", ".pkm/state/actions/settings.json"] : [])]);
  const inPlaceChatroomArchives = inPlaceInertInventory?.chatroomArchives;
  let projectEnvelopePlan: LegacyProjectEnvelopePlan | undefined;
  try {
    await lstat(join(suppliedRoot, ".pkm", "state", "projects.json"));
    if (!inPlacePkmPrivacy?.uiBootstrap) projectEnvelopePlan = await planLegacyProjectEnvelope(suppliedRoot);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      const report = migrationPreflight(suppliedRoot, {
        maxEntries: limits.maxEntries, maxDepth: limits.maxDepth, maxReadBytes: limits.maxReadBytes,
      });
      const code = error instanceof LegacyProjectEnvelopeError ? error.code : "project-envelope-invalid";
      return blockedPlan(suppliedRoot, limits, report, [{
        code: `project-envelope-${code.toLowerCase()}`, path: ".pkm/state/projects.json",
        message: "Original ProjectStore envelope is unsupported or changed; preserve its exact source bytes for review.",
      }]);
    }
  }
  let trashPlan: LegacyTrashImportPlan | undefined;
  const trashBlockers: MigrationPreflightReport["blockers"] = [];
  let recipeTrashPlan: LegacyImportPlan["recipeTrashPlan"];
  if (policy.recipeTrashAuthority) {
    if (policy.recipeTrashAuthority.sourceControlPath
      && policy.recipeTrashAuthority.sourceControlPath !== projectControlPath) {
      throw new LegacyImportError("AUTHORITY_REQUIRED", "Shared Recipe trash import binds only the normal original Project control.");
    }
    recipeTrashPlan = planLegacyRecipeTrashImport(suppliedRoot, policy.recipeTrashAuthority);
  } else {
    try {
      await lstat(join(suppliedRoot, "recipes/.trash"));
      trashBlockers.push({ code: "recipe-trash-authority-required", path: "recipes/.trash",
        message: "Original Recipe trash requires its independently qualified source control, bytes and ordered receipt plan." });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  if (policy.trashPlan) {
    try {
      trashPlan = validateLegacyTrashImportPlan(policy.trashPlan);
      if (trashPlan.source !== suppliedRoot) throw new LegacyTrashImportError("AUTHORITY_REQUIRED", "Trash plan belongs to a different source root.");
      await verifyLegacyTrashSource(trashPlan);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "invalid-legacy-trash-plan";
      trashBlockers.push({ code, path: ".trash", message: "Original trash inventory requires an exact recognized quiescent plan." });
      trashPlan = undefined;
    }
  }
  const excludedPaths = [
    ...(trashPlan ? [
    "notes/.trash", "skills/.trash", "papers/.trash", ".pkm/state/knowledge-deletions.json",
    ] : []),
    ...(projectEnvelopePlan ? [".pkm/state/projects.json"] : []),
  ];
  if (recipeTrashPlan) excludedPaths.push("recipes/.trash");
  const preflight = migrationPreflight(suppliedRoot, {
    maxEntries: limits.maxEntries,
    maxDepth: limits.maxDepth,
    maxReadBytes: limits.maxReadBytes,
    excludedPaths,
  });
  let sourceRoot = suppliedRoot;
  if (preflight.complete) {
    try { sourceRoot = await assertRealDirectory(suppliedRoot); }
    catch {
      const blockers = [{ code: "unsafe-root", path: ".", message: "Supply an existing real directory whose path contains no symlinks." }, ...trashBlockers];
      return blockedPlan(suppliedRoot, limits, preflight, blockers);
    }
  }

  let memoryPlan: LegacyMemoryImportPlan | undefined;
  let routerConfigPlan: LegacyRouterConfigPlan | undefined;
  const memoryDiagnostics: MigrationPreflightReport["blockers"] = [];
  if (policy.routerConfig !== undefined) {
    try { routerConfigPlan = (await inspectLegacyRouterConfig(policy.routerConfig, sourceRoot)).plan; }
    catch {
      memoryDiagnostics.push({ code: "invalid-router-config", path: ".",
        message: "Selected original router config must be an independent canonical private schema-2 snapshot; no fallback is permitted for malformed supplied state." });
    }
  }
  if (policy.memoryContinuityScopeSha256 !== undefined && !policy.memoryEngine) {
    memoryDiagnostics.push({
      code: "memory-continuity-import-required", path: ".",
      message: "Memory scope continuity can only approve one exact scope from an explicit original Memory import.",
    });
  }
  if (!!policy.memoryEngine !== !!policy.memoryActorId) {
    memoryDiagnostics.push({
      code: "memory-import-authority-required", path: ".",
      message: "Original explicit-memory migration requires both an independent read-only engine snapshot and an explicit current native actor ID.",
    });
  }
  if (policy.memoryEngine && policy.memoryActorId) {
    try { memoryPlan = await planLegacyMemoryImport(policy.memoryEngine, sourceRoot, policy.memoryActorId, policy.memoryContinuityScopeSha256); }
    catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "invalid-memory-engine";
      memoryDiagnostics.push({
        code: `memory-${code.toLowerCase()}`, path: ".",
        message: "Original explicit Memory requires a closed, exact, private source-engine snapshot and an explicit actor binding; no records were imported.",
      });
    }
  }

  const ownerByBoardPath = associatedBoardDocuments(preflight);
  const projectRecipeRoots = new Set(preflight.entries
    .filter(entry => entry.kind === "directory" && (entry.path === "project" || entry.path === "recipes"))
    .map(entry => entry.path));
  if (projectEnvelopePlan) {
    for (const file of projectEnvelopePlan.projectionFiles) {
      const root = file.path.split("/")[0];
      if (root === "project" || root === "recipes") projectRecipeRoots.add(root);
    }
  }
  let statePlan: LegacyImportPlan["statePlan"];
  let retrievalHistoryPlan: LegacyImportPlan["retrievalHistoryPlan"];
  const statePaths = new Set<string>();
  const stateDiagnostics: MigrationPreflightReport["blockers"] = [];
  if (policy.retrievalHistory) {
    try {
      retrievalHistoryPlan = await planLegacyRetrievalHistory(policy.retrievalHistory.stateRoot, policy.retrievalHistory.actorId);
      if (isWithin(sourceRoot, retrievalHistoryPlan.stateRoot) || isWithin(retrievalHistoryPlan.stateRoot, sourceRoot)) {
        throw new LegacyImportError("UNSAFE_PATH", "Original retrieval state snapshot must be separate from the Knowledge Root copy.");
      }
    } catch (error) {
      stateDiagnostics.push({ code: error instanceof Error && "code" in error ? String(error.code) : "invalid-retrieval-history",
        path: "retrieval-learning.sqlite3", message: "Original learner migration requires a complete closed current-schema state snapshot." });
    }
  }
  if (preflight.complete && (policy.retrievalHistory || policy.subscriptionRoot || preflight.entries.some(entry =>
    [".pkm/state/agent-snapshots", "_feedback", "_proposals"].includes(entry.path)))) {
    try {
      statePlan = await planLegacyStateImport(sourceRoot, policy.subscriptionRoot, policy.snapshotAuthority, policy.subscriptionIdentity, policy.protectedSubscription);
      for (const entry of statePlan.entries) {
        if (isWithin(sourceRoot, entry.source)) statePaths.add(relative(sourceRoot, entry.source).split(sep).join("/"));
      }
      for (const directory of statePlan.directories ?? []) {
        if (directory === "_feedback" || directory === "_proposals" || directory === "_proposals/skills") statePaths.add(directory);
      }
      for (const path of [".pkm/state/agent-snapshots", ".pkm/state/agent-sessions"]) {
        if (preflight.entries.some(entry => entry.path === path && entry.kind === "directory")) statePaths.add(path);
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "legacy-state-invalid";
      stateDiagnostics.push({ code, path: ".pkm/state/agent-snapshots", message: "Original state requires complete validated inventory and explicit native key authority." });
    }
  }
  const controlInventoryBlockers = inspectLegacyControlInventory({
    ...preflight, entries: preflight.entries.filter(entry => !statePaths.has(entry.path)
      && !inPlacePkmPrivacy?.uiBootstrap?.files.some(file => file.path === entry.path)),
  }, inPlacePkmPrivacy !== undefined).filter(blocker => !(statePlan && blocker.code === "unsupported-project-control")
    && !(trashPlan && blocker.code === "unsupported-project-control")
    && !(projectEnvelopePlan && blocker.code === "unsupported-project-control"));
  const projectRecipeEntries = [
    ...preflight.entries.filter(entry =>
      [...projectRecipeRoots].some(root => entry.path === root || entry.path.startsWith(`${root}/`))),
    ...(projectEnvelopePlan?.projectionFiles.filter(file => /^(project|recipes)(\/|$)/.test(file.path)).map(file => ({
      path: file.path, kind: "unsupported" as const, size: Buffer.from(file.base64, "base64").length,
    })) ?? []),
  ];
  // Original uploads use category-local content-addressed files; the Skills
  // bundle contract also permits portable, referenced trees under _assets.
  const sharedRoots = preflight.entries.filter(entry =>
    entry.kind === "directory" && /^(notes|skills|papers)\/(?:[^/]+\/)*_assets$/.test(entry.path)
    && preflight.blockers.some(diagnostic => diagnostic.code === "legacy-assets" && diagnostic.path === entry.path));
  const sharedPaths = new Set<string>();
  const sharedDiagnostics: MigrationPreflightReport["blockers"] = [];
  let sharedCount = 0, sharedBytes = 0;
  for (const root of sharedRoots) {
    const areaPath = root.path.slice(root.path.indexOf("/") + 1);
    if (!resourcePath.safeParse(`${areaPath}/placeholder.bin`).success) {
      sharedDiagnostics.push({ code: "unsafe-shared-assets", path: root.path, message: "Shared asset path is not portable." });
      continue;
    }
    sharedPaths.add(root.path);
    const skillTree = root.path.startsWith("skills/");
    for (const entry of preflight.entries.filter(item => item.path.startsWith(`${root.path}/`))) {
      const name = entry.path.slice(root.path.length + 1);
      if (skillTree && entry.kind === "directory" && resourcePath.safeParse(`${areaPath}/${name}/placeholder.bin`).success) {
        sharedPaths.add(entry.path);
        sharedCount++;
      } else if (entry.kind !== "unsupported" || entry.size === undefined
        || !skillTree && !/^[a-f0-9]{16}\.[a-z0-9]+$/.test(name)
        || entry.size > 16_777_216 || !resourcePath.safeParse(`${areaPath}/${name}`).success
        || name.split("/").at(-1)?.toLowerCase() === "pkm-todo-board.json") {
        sharedDiagnostics.push({ code: "unsupported-shared-asset", path: entry.path, message: skillTree
          ? "Skills shared assets require portable regular files/directories and cannot contain Todo authority."
          : "Only regular original content-addressed shared asset files are supported." });
      } else {
        sharedPaths.add(entry.path);
        sharedCount++;
        sharedBytes += entry.size;
      }
    }
    const portableSharedPaths = new Map<string, string>();
    for (const entry of preflight.entries) {
      const key = entry.path.normalize("NFC").toLowerCase(), previous = portableSharedPaths.get(key);
      if (previous !== undefined && previous !== entry.path && (sharedPaths.has(previous) || sharedPaths.has(entry.path))) {
        sharedDiagnostics.push({ code: "shared-asset-path-collision", path: entry.path,
          message: "Shared resource paths collide after portable Unicode/case normalization; no file is selected or overwritten.",
          relatedPath: previous });
      } else portableSharedPaths.set(key, entry.path);
    }
  }
  // Conservative global limits also bound a document referencing multiple trees.
  const pairedAssets = preflight.entries.filter(entry => entry.kind === "asset" || entry.kind === "board-backing"
    || entry.kind === "directory" && entry.path.split("/").some(part => /\.assets$/i.test(part)));
  if (sharedRoots.length && (sharedCount + sharedRoots.length + pairedAssets.length > 2048
    || sharedBytes + pairedAssets.reduce((total, entry) => total + (entry.size ?? 0), 0) > 67_108_864)) {
    sharedDiagnostics.push({ code: "shared-assets-limit", path: ".", message: "Shared asset inventory exceeds conservative catalog limits." });
  }
  const boardFiles = new Set(preflight.entries.filter(entry => entry.kind === "board-backing").map(entry => entry.path));
  const boardDocuments = new Set([...boardFiles].map(path => ownerByBoardPath.get(path)).filter((path): path is string => path !== undefined));
  const boards: LegacyImportBoard[] = [];
  const boardDigests = new Map<string, { size: number; sha256: string }>();
  const boardDiagnostics: MigrationPreflightReport["blockers"] = [];

  for (const path of [...boardFiles].sort(compare)) {
    const documentPath = ownerByBoardPath.get(path);
    if (!path.startsWith("notes/") || !documentPath) {
      boardDiagnostics.push({
        code: "unsupported-board-location", path,
        message: "Only a validated Notes Board backing paired with its Markdown Note can be migrated.",
      });
    }
  }
  const allowedBoardDiagnostics = preflight.blockers.filter(diagnostic =>
    diagnostic.code === "board-migration" && handledBoardDiagnostic(diagnostic.path, boardFiles, boardDocuments));
  const allowed = new Set([...allowedBoardDiagnostics, ...preflight.blockers.filter(diagnostic =>
    diagnostic.code === "legacy-assets" && sharedPaths.has(diagnostic.path)
    || diagnostic.code === "unsupported-surface" && statePaths.has(diagnostic.path)
    || diagnostic.code === "unsupported-surface" && projectRecipeRoots.has(diagnostic.path)
    || policy.inPlaceAdoption && inPlaceInertPaths.has(diagnostic.path)
      && ["metadata", "unsupported-surface", "unsupported-entry"].includes(diagnostic.code)
    || policy.inPlaceAdoption && diagnostic.code === "deletion-journal"
      && diagnostic.path === ".pkm/state/knowledge-deletions.json"
      && inPlaceInertPaths.has(diagnostic.path)
      && !!inPlacePkmPrivacy?.uiBootstrap?.knowledgeDeletions
      && inPlacePkmPrivacy.uiBootstrap.knowledgeDeletions.sha256
        === inPlacePkmPrivacy.uiBootstrap.files.find(file => file.path === diagnostic.path)?.sha256
    || diagnostic.code === "metadata" && diagnostic.path === ".pkm" && controlInventoryBlockers.length === 0)]);
  const preflightBlockers = preflight.blockers.filter(diagnostic => !allowed.has(diagnostic));
  preflightBlockers.push(...controlInventoryBlockers, ...stateDiagnostics, ...memoryDiagnostics, ...trashBlockers);
  if (!preflight.complete || preflightBlockers.length || boardDiagnostics.length || sharedDiagnostics.length) {
    const unvalidatedRoots = preflight.blockers.filter(diagnostic =>
      diagnostic.code === "unsupported-surface" && projectRecipeRoots.has(diagnostic.path));
    return blockedPlan(sourceRoot, limits, preflight, [...preflightBlockers, ...boardDiagnostics, ...sharedDiagnostics, ...unvalidatedRoots]
      .sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code) || compare(a.relatedPath ?? "", b.relatedPath ?? "")));
  }

  for (const path of [...boardFiles].sort(compare)) {
    const documentPath = ownerByBoardPath.get(path)!;
    const document = preflight.entries.find(entry => entry.path === documentPath && entry.kind === "document");
    const slug = documentPath.slice("notes/".length).replace(/\.md$/i, "");
    if (!document?.documentId || !slug || slug.split("/").some(part => part.startsWith("."))) {
      boardDiagnostics.push({ code: "invalid-board-identity", path, message: "The Board must have a valid paired Note identity and portable path." });
      continue;
    }
    try {
      const bytes = await readStableFile(sourceRoot, path);
      const raw = bytes.toString("utf8");
      if (!Buffer.from(raw, "utf8").equals(bytes)) throw new Error("invalid UTF-8");
      const validated = readTodoBoard(raw);
      boardDigests.set(path, { size: bytes.length, sha256: sha256(bytes) });
      boards.push({ source: path, slug, digest: validated.digest, itemCount: validated.items.length });
    } catch {
      boardDiagnostics.push({ code: "invalid-board", path, message: "Review and repair the Board backing using a verified snapshot." });
    }
  }

  if (boardDiagnostics.length) return blockedPlan(sourceRoot, limits, preflight, boardDiagnostics);

  const mappedBoards = new Map(boards.map(board => [board.source, board]));
  const entries: LegacyImportEntry[] = [];
  const blockers: MigrationPreflightReport["blockers"] = [];
  const controlBytes = new Map<string, Buffer>();
  const usageRuns: Array<{ source: string; seconds: number; bytes: Buffer }> = [];
  const controlEntries = preflight.entries.filter(entry => entry.path === ".pkm" || entry.path.startsWith(".pkm/"));
  const emptyControlShell = controlEntries.length > 0
    && controlEntries.every(entry => controlDirectories.has(entry.path) && entry.kind === "directory");
  let totalBytes = 0;
  for (const entry of preflight.entries) {
    if (inPlacePkmPrivacy && entry.path === ".pkm/content-privacy.json") continue;
    if (inPlaceInertPaths.has(entry.path)) {
      if (entry.kind === "directory") {
        const stat = await lstat(join(sourceRoot, entry.path));
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7000) !== 0) {
          blockers.push({ code: "unsafe-inert-legacy-root-state", path: entry.path, message: "Legacy inert root directory changed during planning." });
        } else entries.push({ source: entry.path, kind: "directory", mode: stat.mode & 0o777 });
      } else {
        if (entry.size === undefined || entry.size > 268_435_456 || totalBytes + entry.size > limits.maxTotalBytes
          || totalBytes + entry.size > limits.maxReadBytes) {
          blockers.push({ code: "inert-legacy-root-limit", path: entry.path, message: "Legacy inert root file exceeds the bounded adoption read limit." });
          continue;
        }
        try {
          const bytes = await readStableFile(sourceRoot, entry.path, entry.size);
          const stat = await lstat(join(sourceRoot, entry.path));
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o7000) !== 0)
            throw new Error("unsafe inert file");
          totalBytes += bytes.length;
          entries.push({ source: entry.path, kind: "asset", size: bytes.length, mode: stat.mode & 0o777,
            sha256: sha256(bytes), destination: entry.path });
        } catch {
          blockers.push({ code: "read-failed", path: entry.path, message: "Legacy inert root bytes or permissions changed during planning." });
        }
      }
      continue;
    }
    if (controlDirectories.has(entry.path) || statePaths.has(entry.path)) {
      if (emptyControlShell && controlDirectories.has(entry.path))
        entries.push({ source: entry.path, kind: "directory", destination: `legacy-import-evidence/${entry.path}` });
      continue;
    }
    const usageDestination = recipeUsageDestination(entry.path);
    if (usageDestination) {
      if (entry.kind === "directory" && entry.path === recipeUsageRoot) {
        entries.push({ source: entry.path, kind: "directory", destination: usageDestination });
      } else {
        try {
          const before = await lstat(join(sourceRoot, entry.path), { bigint: true });
          const bytes = await readStableFile(sourceRoot, entry.path, entry.size);
          const after = await lstat(join(sourceRoot, entry.path), { bigint: true });
          if (before.ino !== after.ino || before.dev !== after.dev
            || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("changed");
          totalBytes += bytes.length;
          entries.push({ source: entry.path, kind: "asset", size: bytes.length, sha256: sha256(bytes),
            destination: usageDestination, mtimeNs: after.mtimeNs.toString() });
          usageRuns.push({ source: entry.path, bytes,
            seconds: Number(after.mtimeNs / 1_000_000_000n) + Number(after.mtimeNs % 1_000_000_000n) / 1e9 });
        } catch {
          blockers.push({ code: "invalid-recipe-usage", path: entry.path, message: "Recipe usage requires unchanged regular original run bytes and modification times." });
        }
      }
      continue;
    }
    if (isLegacyControlPath(entry.path)) {
      try {
        const bytes = await readStableFile(sourceRoot, entry.path, entry.size);
        totalBytes += bytes.length;
        controlBytes.set(entry.path, bytes);
        entries.push({ source: entry.path, kind: "asset", size: bytes.length, sha256: sha256(bytes) });
      } catch {
        blockers.push({ code: "read-failed", path: entry.path, message: "Original control bytes changed or could not be read safely." });
      }
      continue;
    }
    if (projectRecipeEntries.includes(entry) && entry.kind === "unsupported") {
      if (entry.size === undefined || entry.size > 2 * 1024 * 1024 || totalBytes + entry.size > limits.maxTotalBytes) {
        blockers.push({ code: "project-recipe-limit", path: entry.path, message: "Project/Recipe file exceeds the bounded import limits." });
        continue;
      }
      try {
        const bytes = await readStableFile(sourceRoot, entry.path, entry.size);
        totalBytes += bytes.length;
        // The v1 receipt's asset bucket denotes byte-preserved non-Markdown files.
        entries.push({ source: entry.path, kind: "asset", size: bytes.length, sha256: sha256(bytes), destination: entry.path });
      } catch {
        blockers.push({ code: "read-failed", path: entry.path, message: "Project/Recipe entry changed or is not a regular file." });
      }
      continue;
    }
    if (sharedPaths.has(entry.path) && entry.kind === "unsupported") {
      try {
        const bytes = await readStableFile(sourceRoot, entry.path, entry.size);
        totalBytes += bytes.length;
        entries.push({ source: entry.path, kind: "asset", size: bytes.length, sha256: sha256(bytes), destination: entry.path });
      } catch {
        blockers.push({ code: "read-failed", path: entry.path, message: "The shared asset changed or could not be read safely." });
      }
      continue;
    }
    if (entry.kind === "library-file") {
      if (entry.size === undefined || entry.size > 268435456 || totalBytes + entry.size > limits.maxTotalBytes
        || totalBytes + entry.size > limits.maxReadBytes) {
        blockers.push({ code: "library-byte-limit", path: entry.path,
          message: "Original library bytes exceed the 256 MiB readable file limit or the selected import/read budget; no partial library is approved." });
        continue;
      }
      try {
        const bytes = await readStableFile(sourceRoot, entry.path, entry.size);
        const stat = await lstat(join(sourceRoot, entry.path));
        if (!isLegacyLibraryResourcePath(entry.path) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o7000) !== 0
          || entry.mode !== undefined && (stat.mode & 0o777) !== entry.mode) throw new Error("changed");
        totalBytes += bytes.length;
        entries.push({ source: entry.path, kind: "asset", size: bytes.length,
          ...(entry.mode === undefined ? {} : { mode: entry.mode }), sha256: sha256(bytes), destination: legacyLibraryDestination(entry.path) });
      } catch {
        blockers.push({ code: "read-failed", path: entry.path, message: "Original library bytes or permissions changed during planning." });
      }
      continue;
    }
    if (entry.kind === "unsupported" || entry.kind === "symlink") {
      blockers.push({ code: entry.kind, path: entry.path, message: "Unsupported legacy data must be explicitly reconciled before import." });
      continue;
    }
    if (entry.kind === "directory") {
      entries.push({ source: entry.path, kind: "directory",
        ...(entry.mode === undefined ? {} : { mode: entry.mode }),
        destination: legacyLibraryDestination(entry.path, "directory") });
      continue;
    }
    if (entry.kind === "board-backing") {
      const board = mappedBoards.get(entry.path);
      const backing = boardDigests.get(entry.path);
      if (!board || !backing) {
        blockers.push({ code: "unmapped-board", path: entry.path, message: "This Board backing has no validated destination." });
        continue;
      }
      totalBytes += backing.size;
      entries.push({
        source: entry.path, kind: "board-backing", size: backing.size, sha256: backing.sha256,
        destination: `boards/${board.slug}/${todoBoardFilename}`, boardSlug: board.slug,
      });
      continue;
    }
    if (entry.kind !== "document" && entry.kind !== "asset") {
      blockers.push({ code: "unsupported-entry", path: entry.path, message: "Only Markdown documents, paired resources and validated Board backings are importable." });
      continue;
    }
    try {
      const before = entry.kind === "document" ? await lstat(join(sourceRoot, entry.path), { bigint: true }) : undefined;
      const bytes = await readStableFile(sourceRoot, entry.path, entry.size);
      const after = before ? await lstat(join(sourceRoot, entry.path), { bigint: true }) : undefined;
      if (before && after && (!before.isFile() || !after.isFile() || before.ino !== after.ino || before.dev !== after.dev
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)) throw new Error("changed");
      totalBytes += bytes.length;
      entries.push({
        source: entry.path, kind: entry.kind, size: bytes.length, sha256: sha256(bytes),
        destination: entry.path, ...(entry.documentId === undefined ? {} : { documentId: entry.documentId }),
        ...(after ? { mtimeNs: after.mtimeNs.toString() } : {}),
      });
    } catch {
      blockers.push({ code: "read-failed", path: entry.path, message: "The source changed or could not be read safely; retry with a quiescent copy." });
    }
  }
  usageRuns.sort((left, right) => right.seconds - left.seconds);
  if (usageRuns.length > 5000 && usageRuns[4999]!.seconds === usageRuns[5000]!.seconds) {
    blockers.push({ code: "ambiguous-recipe-usage-order", path: recipeUsageRoot,
      message: "Original Recipe usage has a modification-time tie across its 5000-run read boundary; source filesystem order cannot be rebound safely." });
  }
  const usageNames = new Map<string, { seconds: number; name: string }>();
  for (const run of usageRuns.slice(0, 5000)) {
    try {
      const value = JSON.parse(run.bytes.toString("utf8"));
      if (value?.schema !== "pkm.recipe.run/v1") continue;
      const key = JSON.stringify([String(value.recipeId || ""), value.recipeRevision ?? null]);
      const name = String(value.recipeName || value.recipeId || "").slice(0, 256);
      const first = usageNames.get(key);
      if (!first) usageNames.set(key, { seconds: run.seconds, name });
      else if (first.seconds === run.seconds && first.name !== name) {
        blockers.push({ code: "ambiguous-recipe-usage-order", path: run.source,
          message: "Equal-time original Recipe runs disagree on the first usage-group name; preserve source order for reconciliation." });
      }
    } catch { /* Original Recipe usage skips corrupt run JSON without rewriting it. */ }
  }
  if (projectEnvelopePlan) {
    for (const file of projectEnvelopePlan.projectionFiles) {
      const bytes = Buffer.from(file.base64, "base64");
      totalBytes += bytes.length;
      if (isLegacyControlPath(file.path)) {
        controlBytes.set(file.path, bytes);
        entries.push({ source: file.path, kind: "asset", size: bytes.length, sha256: sha256(bytes) });
      } else {
        entries.push({ source: file.path, kind: "asset", size: bytes.length, sha256: sha256(bytes), destination: file.path });
      }
    }
    totalBytes += projectEnvelopePlan.sourceStat.size;
  }
  totalBytes += statePlan?.entries.reduce((sum, entry) => sum + entry.size, 0) ?? 0;
  totalBytes += memoryPlan?.sourceSize ?? 0;
  totalBytes += routerConfigPlan?.size ?? 0;
  totalBytes += trashPlan?.inventory.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.size : 0), 0) ?? 0;
  totalBytes += recipeTrashPlan?.totalBytes ?? 0;
  if (preflight.entries.length + (projectEnvelopePlan?.projectionFiles.length ?? 0)
    + (routerConfigPlan ? 1 : 0) + (memoryPlan?.records ?? 0) + (trashPlan?.inventory.length ?? 0) + (recipeTrashPlan?.trashFiles.length ?? 0) > limits.maxEntries) {
    blockers.push({ code: "entry-limit", path: ".", message: "Combined standard and original-trash inventories exceed the configured entry limit." });
  }
  const cacheBytes = statePlan?.entries.filter(entry => entry.destination.startsWith("subscriptions/cache/"))
    .reduce((sum, entry) => sum + entry.size, 0) ?? 0;
  if (totalBytes - cacheBytes > limits.maxTotalBytes) blockers.push({
    code: "total-byte-limit", path: ".", message: `The import exceeds the configured ${limits.maxTotalBytes}-byte total copy limit.`,
  });
  let projectModel: ProjectRecipeExportSummary = {
    projects: [], threads: [], ganttTasks: [], collaborationTasks: [], recipes: [],
  };
  if (projectRecipeEntries.length && !blockers.length && !projectEnvelopePlan) {
    try {
      projectModel = validateProjectRecipeExport(
        sourceRoot, projectRecipeEntries.map(entry => ({ source: entry.path, kind: entry.kind, size: entry.size })),
      );
    }
    catch {
      blockers.push({ code: "unsupported-project-recipe", path: ".", message: "Project/Recipe export failed canonical layout, identity, binding or runtime validation; preserve it for review." });
    }
  }
  if (!blockers.length) {
    const projectBytes = controlBytes.get(projectControlPath);
    if (projectBytes) {
      try {
        if (!projectRecipeEntries.length) throw new Error("Project control has no source Project tree.");
        if (!projectEnvelopePlan) parseLegacyProjectControl(projectBytes, projectModel);
      } catch (error) {
        const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "invalid-control";
        blockers.push({
          code, path: projectControlPath,
          message: "Original Project control bytes, identity, digest or quiescent migration state failed validation.",
        });
      }
    }
    const recipeBytes = controlBytes.get(recipeControlPath);
    if (recipeBytes) {
      try { parseLegacyRecipeControl(recipeBytes, projectModel); }
      catch (error) {
        const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "invalid-control";
        blockers.push({
          code, path: recipeControlPath,
          message: "Original Recipe control bytes or quiescent migration state failed validation.",
        });
      }
    }
  }
  const archivedSkillsHistory = entries.filter(entry => entry.destination !== undefined
    && isLegacySkillsHistoryArchivePath(entry.destination) && entry.destination !== legacySkillsHistoryArchive);
  if (archivedSkillsHistory.length) {
    const sourceDirectories = new Set<string>();
    for (const entry of archivedSkillsHistory) {
      let directory = entry.kind === "directory" ? entry.source : dirname(entry.source).replaceAll("\\", "/");
      while (directory === "skills" || directory.startsWith("skills/")) {
        sourceDirectories.add(directory);
        if (directory === "skills") break;
        directory = dirname(directory).replaceAll("\\", "/");
      }
    }
    for (const sourceDirectory of [...sourceDirectories].sort(compare)) {
      const destination = `${legacySkillsHistoryArchive}/${sourceDirectory}`;
      if (entries.some(entry => entry.destination === destination)) continue;
      try {
        const stat = await lstat(join(sourceRoot, ...sourceDirectory.split("/")));
        const preflightDirectory = preflight.entries.some(entry => entry.path === sourceDirectory && entry.kind === "directory");
        if (!stat.isDirectory() || stat.isSymbolicLink() || !preflightDirectory
          || (stat.mode & 0o7000) !== 0) {
          throw new Error("unsafe archive parent");
        }
        entries.push({ source: sourceDirectory, kind: "directory", mode: stat.mode & 0o777, destination });
      } catch {
        blockers.push({ code: "skills-history-parent-invalid", path: sourceDirectory,
          message: "An inert Skills history archive parent changed or is not a safe real directory." });
      }
      if (entries.length > limits.maxEntries) {
        blockers.push({ code: "entry-limit", path: ".", message: "The Skills history archive exceeds the bounded import entry limit." });
        break;
      }
    }
  }
  if (blockers.length) return blockedPlan(sourceRoot, limits, preflight, blockers.sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code)));

  entries.sort((a, b) => compare(a.source, b.source) || compare(a.destination ?? "", b.destination ?? ""));
  const skillsHistoryArchive = describeLegacySkillsHistoryArchive(entries);
  boards.sort((a, b) => compare(a.slug, b.slug));
  const entryFingerprint = entries.map(({ source: path, kind, size, sha256: digest, mode, mtimeNs }) => ({
    path, kind, size, sha256: digest, ...(mode === undefined ? {} : { mode }),
    ...(mtimeNs === undefined ? {} : { mtimeNs }),
  }));
  if (trashPlan) {
    try { await verifyLegacyTrashSource(trashPlan); }
    catch {
      return blockedPlan(sourceRoot, limits, preflight, [{
        code: "SOURCE_CHANGED", path: ".trash", message: "Original trash inventory changed while the shared import plan was being qualified.",
      }]);
    }
  }
  const fingerprint = sha256(JSON.stringify({
    entries: entryFingerprint,
    ...(policy.inPlaceAdoption ? { inPlaceOnly: true } : {}),
    ...(inPlacePkmPrivacy ? { inPlacePkmPrivacySha256: inPlacePkmPrivacy.privacySha256 } : {}),
    ...(inPlacePkmPrivacy?.emptyActionSettingsSha256
      ? { inPlaceEmptyActionSettingsSha256: inPlacePkmPrivacy.emptyActionSettingsSha256 } : {}),
    ...(inPlacePkmPrivacy?.apiChatArchive ? { inPlaceApiChatArchive: inPlacePkmPrivacy.apiChatArchive } : {}),
    ...(inPlacePkmPrivacy?.managedWriterSession ? { inPlaceManagedWriterSession: inPlacePkmPrivacy.managedWriterSession } : {}),
    ...(inPlacePkmPrivacy?.uiBootstrap ? { inPlaceUiBootstrap: inPlacePkmPrivacy.uiBootstrap } : {}),
    ...(inPlaceChatroomArchives?.length ? { inPlaceChatroomArchives } : {}),
    ...(statePlan ? { statePlan } : {}),
    ...(memoryPlan ? { memoryPlan } : {}),
    ...(routerConfigPlan ? { routerConfigPlan } : {}),
    ...(retrievalHistoryPlan ? { retrievalHistoryPlan } : {}),
    ...(trashPlan ? { trashPlanSha256: trashPlan.planSha256 } : {}),
    ...(recipeTrashPlan ? { recipeTrashPlanSha256: recipeTrashPlan.planSha256 } : {}),
    ...(skillsHistoryArchive ? { skillsHistoryArchive } : {}),
    ...(projectEnvelopePlan ? { projectEnvelopePlanSha256: projectEnvelopePlan.planSha256 } : {}),
  }));
  const body: Omit<LegacyImportPlan, "planSha256"> = {
    schema: "pkm.legacy-import-plan/v1", sourceRoot, ready: true,
    ...(policy.inPlaceAdoption ? { inPlaceOnly: true } : {}),
    ...(inPlacePkmPrivacy ? { inPlacePkmPrivacySha256: inPlacePkmPrivacy.privacySha256 } : {}),
    ...(inPlacePkmPrivacy?.emptyActionSettingsSha256
      ? { inPlaceEmptyActionSettingsSha256: inPlacePkmPrivacy.emptyActionSettingsSha256 } : {}),
    ...(inPlacePkmPrivacy?.apiChatArchive ? { inPlaceApiChatArchive: inPlacePkmPrivacy.apiChatArchive } : {}),
    ...(inPlacePkmPrivacy?.managedWriterSession ? { inPlaceManagedWriterSession: inPlacePkmPrivacy.managedWriterSession } : {}),
    ...(inPlacePkmPrivacy?.uiBootstrap ? { inPlaceUiBootstrap: inPlacePkmPrivacy.uiBootstrap } : {}),
    ...(inPlaceChatroomArchives?.length ? { inPlaceChatroomArchives } : {}),
    limits, preflight,
    blockers: [], entries, boards, fingerprint, ...(statePlan ? { statePlan } : {}),
    ...(memoryPlan ? { memoryPlan } : {}),
    ...(routerConfigPlan ? { routerConfigPlan } : {}),
    ...(retrievalHistoryPlan ? { retrievalHistoryPlan } : {}),
    ...(trashPlan ? { trashPlan } : {}),
    ...(recipeTrashPlan ? { recipeTrashPlan } : {}),
    ...(skillsHistoryArchive ? { skillsHistoryArchive } : {}),
    ...(projectEnvelopePlan ? { projectEnvelopePlan } : {}),
  };
  return legacyImportPlanSchema.parse({ ...body, planSha256: planDigest(body) });
}

/**
 * Read-only inventory for a possible in-place legacy-root transition.
 *
 * This deliberately never authorizes or performs adoption. The bounded import
 * inventory is not evidence of full workflow parity, writer isolation, or a
 * recoverable same-root cutover, so `ready` is always false.
 */
export async function inspectLegacyRootForAdoption(
  root: string, limits: Partial<LegacyImportLimits> = {},
): Promise<LegacyRootAdoptionInspection> {
  if (!isAbsolute(root)) throw new TypeError("Provide an absolute path to the legacy Knowledge Root.");
  const sourceRoot = await assertRealDirectory(root);
  const before = await lstat(sourceRoot, { bigint: true });
  const inventoryPlan = await planLegacyImport(sourceRoot, limits);
  const after = await lstat(sourceRoot, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
    throw new LegacyImportError("SOURCE_CHANGED", "Legacy Knowledge Root identity changed during read-only inspection.");
  }

  const rootIdentity = { device: before.dev.toString(), inode: before.ino.toString() };
  const sourceFingerprint = inventoryPlan.fingerprint === null ? null : sha256(JSON.stringify({
    schema: "pkm.legacy-root-source/v1",
    sourceRoot,
    rootIdentity,
    importFingerprint: inventoryPlan.fingerprint,
  }));
  const blockers: MigrationPreflightReport["blockers"] = [
    ...inventoryPlan.blockers,
    {
      code: "direct-adoption-unqualified",
      path: ".",
      message: "This read-only inspection cannot authorize or perform an in-place root cutover.",
    },
    {
      code: "writer-isolation-unverified",
      path: ".",
      message: "The inspector cannot prove that legacy extension, MCP, or other writers are quiescent.",
    },
    {
      code: "complete-workflow-parity-unverified",
      path: ".",
      message: "A bounded import inventory is not proof that every legacy workflow and its identity are preserved.",
    },
    {
      code: "recovery-and-rollback-unqualified",
      path: ".",
      message: "Same-root cutover journal, restart recovery, and rollback are not qualified for production.",
    },
  ];
  const body = {
    schema: "pkm.legacy-root-adoption-inspection/v1" as const,
    sourceRoot,
    rootIdentity,
    ready: false as const,
    sourceFingerprint,
    inventoryPlan,
    blockers,
  };
  return { ...body, inspectionSha256: sha256(JSON.stringify(body)) };
}

function checkedPlan(input: LegacyImportPlan): LegacyImportPlan {
  const plan = legacyImportPlanSchema.parse(input);
  const { planSha256: digest, ...body } = plan;
  if (planDigest(body) !== digest) throw new LegacyImportError("INVALID_PLAN", "The import plan was modified; create a fresh plan.");
  if (!plan.ready || !plan.fingerprint || plan.blockers.length) {
    throw new LegacyImportError("IMPORT_BLOCKED", "The bounded preflight found unsupported or unresolved legacy data.", plan.blockers);
  }
  return plan;
}

async function destinationPaths(destination: string, sourceRoot: string): Promise<{ target: string; parent: string }> {
  const target = resolve(destination);
  const parent = await assertRealDirectory(dirname(target));
  if (isWithin(sourceRoot, parent)) {
    throw new LegacyImportError("UNSAFE_PATH", "Keep the import destination and disposable source copy in separate, non-overlapping directory trees.");
  }
  try {
    await lstat(target);
    throw new LegacyImportError("DESTINATION_EXISTS", "Import destination already exists; no files were overwritten.");
  } catch (error) {
    if (error instanceof LegacyImportError) throw error;
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return { target, parent };
}

function makeReceipt(
  plan: LegacyImportPlan, destination: string, trash?: { markerSha256: string; authority: LegacyTrashLayoutAuthority },
  memoryImport?: import("./domain/memory-import-contracts.js").LegacyMemoryImportReceipt,
  projectEnvelope?: LegacyProjectEnvelopeAdoptionPayload["receipt"],
  memoryScopeContinuity?: MemoryScopeContinuity,
): LegacyImportReceipt {
  if (plan.trashPlan && !trash) {
    throw new LegacyImportError("STAGING_INVALID", "Original trash plan is missing its exact staged receipt binding.");
  }
  const documents = plan.entries.filter(entry => entry.kind === "document").map(entry => ({
    path: entry.destination!, documentId: entry.documentId!, sha256: entry.sha256!,
  }));
  const assets = plan.entries.filter(entry => entry.kind === "asset" && !isLegacyControlPath(entry.source)).map(entry => ({
    path: entry.destination!, sha256: entry.sha256!, size: entry.size!, ...(entry.mode === undefined ? {} : { mode: entry.mode }),
  }));
  if (plan.routerConfigPlan) assets.push({
    path: plan.routerConfigPlan.destination, sha256: plan.routerConfigPlan.sha256, size: plan.routerConfigPlan.size,
  });
  for (const file of plan.recipeTrashPlan?.trashFiles ?? []) {
    assets.push({ path: file.path, sha256: file.sha256, size: Buffer.from(file.base64, "base64").length });
  }
  const controls = plan.entries.filter(entry => isLegacyControlPath(entry.source)).map(entry => ({
    path: entry.source,
    table: controlFileTables.get(entry.source)!,
    sha256: entry.sha256!,
    size: entry.size!,
  }));
  const archivedDirectories = new Map<string, number>();
  for (const entry of plan.entries) {
    if (entry.kind === "directory" && entry.destination && isArchivedCodePath(entry.destination))
      archivedDirectories.set(entry.destination, entry.mode ?? 0o700);
  }
  if (plan.skillsHistoryArchive) archivedDirectories.set(legacySkillsHistoryArchive, 0o700);
  const base = {
    schema: "pkm.legacy-import-receipt/v1" as const, destination, fingerprint: plan.fingerprint!,
    documentCount: documents.length, assetCount: assets.length, boardCount: plan.boards.length,
    totalBytes: plan.entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0)
      + (plan.statePlan?.entries.reduce((sum, entry) => sum + entry.size, 0) ?? 0)
      + (plan.memoryPlan?.sourceSize ?? 0)
      + (plan.routerConfigPlan?.size ?? 0)
      + (plan.retrievalHistoryPlan?.source.size ?? 0)
      + (plan.retrievalHistoryPlan?.files.reduce((sum, file) => sum + file.size, 0) ?? 0)
      + (projectEnvelope?.sourceBytes ?? 0)
      + (plan.trashPlan?.inventory.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.size : 0), 0) ?? 0)
      + (plan.recipeTrashPlan?.totalBytes ?? 0),
    documents, assets, boards: plan.boards, ...(controls.length ? { controls } : {}),
    ...(archivedDirectories.size ? {
      archivedDirectories: [...archivedDirectories].sort(([left], [right]) => compare(left, right))
        .map(([path, mode]) => ({ path, mode })),
    } : {}),
    ...(plan.statePlan ? { statePlan: plan.statePlan } : {}),
    ...(memoryImport ? { memoryImport } : {}),
    ...(plan.routerConfigPlan ? { routerConfigPlan: plan.routerConfigPlan } : {}),
    ...(plan.retrievalHistoryPlan ? { retrievalHistoryPlan: plan.retrievalHistoryPlan } : {}),
    ...(memoryScopeContinuity ? { memoryScopeContinuity } : {}),
    ...(plan.statePlan || projectEnvelope ? { importPlanSha256: plan.planSha256 } : {}),
    ...(plan.recipeTrashPlan ? { recipeTrashPlan: plan.recipeTrashPlan } : {}),
    ...(plan.skillsHistoryArchive ? { skillsHistoryArchive: plan.skillsHistoryArchive } : {}),
    ...(projectEnvelope ? { projectEnvelope } : {}),
    ...(plan.trashPlan && trash ? { legacyTrash: {
      planSha256: plan.trashPlan.planSha256, sourceSha256: plan.trashPlan.sourceSha256,
      markerSha256: trash.markerSha256, authority: trash.authority,
    } } : {}),
  };
  const parsed = legacyImportReceiptSchema.parse({ ...base, receiptSha256: "0".repeat(64) });
  const { receiptSha256: _receiptSha256, ...body } = parsed;
  return legacyImportReceiptSchema.parse({ ...body, receiptSha256: sha256(JSON.stringify(body)) });
}

async function ensureDirectory(root: string, relativePath: string): Promise<void> {
  const parts = relativePath.split("/");
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LegacyImportError("STAGING_INVALID", "Import staging paths must remain real directories.");
  }
}

async function writeOwnedFile(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function inventoryLegacyImportStage(stage: string, createdAreas: readonly string[], maximumBytes: number): Promise<string> {
  const entries: Array<Record<string, string | number>> = [];
  let count = 0, bytes = 0;
  const ignoredTrashPath = (path: string) => path === legacyTrashStageReceiptPath
    || /^(?:notes|skills|papers)\/\.trash(?:\/|$)/.test(path);
  async function walk(path: string): Promise<void> {
    if (ignoredTrashPath(path)) return;
    if (++count > 20_000) throw new LegacyImportError("STAGING_INVALID", "Parent stage inventory exceeds the bounded entry limit.");
    const full = join(stage, ...path.split("/"));
    const stat = await lstat(full);
    if (stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory())) {
      throw new LegacyImportError("STAGING_INVALID", "Parent stage contains a symlink or special entry.");
    }
    if (stat.isDirectory()) {
      if (!createdAreas.includes(path)) entries.push({ path, kind: "directory", dev: stat.dev, ino: stat.ino });
      let names = (await readdir(full)).sort(compare);
      if (new Set(names.map(name => name.toLowerCase())).size !== names.length) {
        throw new LegacyImportError("STAGING_INVALID", "Parent stage contains case-colliding paths.");
      }
      const visibleNames = names.filter(name => !ignoredTrashPath(path ? `${path}/${name}` : name));
      for (const name of names) await walk(path ? `${path}/${name}` : name);
      const after = await lstat(full);
      const afterNames = (await readdir(full)).filter(name => !ignoredTrashPath(path ? `${path}/${name}` : name)).sort(compare);
      if (after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino
        || JSON.stringify(afterNames) !== JSON.stringify(visibleNames)) {
        throw new LegacyImportError("SOURCE_CHANGED", "Parent stage changed during inventory verification.");
      }
      return;
    }
    if (stat.size > maximumBytes || bytes + stat.size > maximumBytes) {
      throw new LegacyImportError("STAGING_INVALID", "Parent stage exceeds its bounded inventory byte limit.");
    }
    const content = await hashStableFile(stage, path, maximumBytes - bytes);
    bytes += content.size;
    entries.push({ path, kind: "file", dev: stat.dev, ino: stat.ino, size: content.size, sha256: content.sha256 });
  }
  const root = await lstat(stage);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new LegacyImportError("STAGING_INVALID", "Parent stage root is not a real directory.");
  let roots = (await readdir(stage)).sort(compare);
  if (new Set(roots.map(name => name.toLowerCase())).size !== roots.length) {
    throw new LegacyImportError("STAGING_INVALID", "Parent stage contains case-colliding root paths.");
  }
  const visibleRoots = roots.filter(name => !ignoredTrashPath(name) && !createdAreas.includes(name));
  for (const name of roots) await walk(name);
  const rootAfter = await lstat(stage);
  const afterRoots = (await readdir(stage)).filter(name => !ignoredTrashPath(name) && !createdAreas.includes(name)).sort(compare);
  if (!rootAfter.isDirectory() || rootAfter.isSymbolicLink() || rootAfter.dev !== root.dev || rootAfter.ino !== root.ino
    || JSON.stringify(visibleRoots) !== JSON.stringify(afterRoots)) {
    throw new LegacyImportError("SOURCE_CHANGED", "Parent stage root listing changed during inventory verification.");
  }
  entries.sort((a, b) => compare(String(a.path), String(b.path)));
  return sha256(JSON.stringify(entries));
}

async function parentStageAuthority(
  stage: string, nativeScope: LegacyTrashSnapshotScope, maxBytes: number,
): Promise<LegacyTrashParentStageAuthority> {
  const stat = await lstat(stage);
  const missingAreas: string[] = [];
  for (const area of ["notes", "skills", "papers"]) {
    try {
      const areaStat = await lstat(join(stage, area));
      if (!areaStat.isDirectory() || areaStat.isSymbolicLink()) throw new LegacyImportError("STAGING_INVALID", "Knowledge area root must be a real directory.");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") missingAreas.push(area);
      else throw error;
    }
  }
  const inventorySha256 = await inventoryLegacyImportStage(stage, missingAreas, maxBytes);
  return {
    stage, dev: stat.dev, ino: stat.ino, inventorySha256,
    excludedRootNames: [...nativeScope.excludedRootNames],
    verifyInventory: () => inventoryLegacyImportStage(stage, missingAreas, maxBytes),
  };
}

function publishNoReplace(stage: string, target: string, pythonExecutable: string, keepAlive?: number): void {
  const unsupported = legacyImportNoReplacePlatformError(process.platform);
  if (unsupported) throw new LegacyImportError("NO_REPLACE_UNAVAILABLE", unsupported);
  if (!isAbsolute(pythonExecutable)) {
    throw new LegacyImportError("PYTHON_PATH_REQUIRED", "Provide an explicit absolute path to the Python executable for atomic no-replace publication.");
  }
  try {
    renameNoReplaceSync(stage, target, pythonExecutable, keepAlive);
  } catch (error) {
    if (!(error instanceof RenameNoReplaceError)) throw error;
    if (error.cause instanceof Error && "code" in error.cause && error.cause.code === "ENOENT") {
      throw new LegacyImportError("PYTHON_UNAVAILABLE", "The explicit Python executable could not be started.");
    }
    if (error.code === "UNAVAILABLE") throw new LegacyImportError("NO_REPLACE_UNAVAILABLE", error.message);
    if (error.code === "DESTINATION_EXISTS") throw new LegacyImportError("DESTINATION_EXISTS", error.message);
    throw new LegacyImportError("PUBLISH_FAILED", error.message);
  }
}

async function readOwner(path: string, token: string, destination: string, stage: string): Promise<StageOwner | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return;
    const bytes = await readStableFile(dirname(path), path.slice(dirname(path).length + 1), stat.size);
    const owner = JSON.parse(bytes.toString("utf8")) as StageOwner;
    if (owner.schema !== ownerSchema || owner.token !== token || owner.destination !== destination || owner.stage !== stage
      || !Number.isInteger(owner.pid) || owner.pid < 1
      || owner.workspaceId !== undefined && !/^[0-9a-f-]{36}$/.test(owner.workspaceId)) return;
    return owner;
  } catch { return; }
}

async function updateOwner(path: string, initial: StageOwner, updated: StageOwner): Promise<void> {
  const existing = await readOwner(path, initial.token, initial.destination, initial.stage);
  if (!existing || existing.workspaceId !== initial.workspaceId) throw new LegacyImportError("STAGING_INVALID", "Import ownership record changed during staging.");
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new LegacyImportError("STAGING_INVALID", "Import ownership record is not a regular file.");
  const handle = await open(path, constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new LegacyImportError("STAGING_INVALID", "Import ownership record changed during staging.");
    }
    await handle.writeFile(Buffer.from(JSON.stringify(updated), "utf8"));
    await handle.sync();
  } finally { await handle.close(); }
  if (await readOwner(path, updated.token, updated.destination, updated.stage) === undefined) {
    throw new LegacyImportError("STAGING_INVALID", "Import ownership record could not be verified after update.");
  }
}

function outcomePath(destination: string): string {
  const target = resolve(destination);
  return join(dirname(target), `.${target.split(sep).at(-1)}.pkm-legacy-import.outcome.json`);
}

async function writeOutcome(path: string, outcome: LegacyImportOutcome): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(outcome, null, 2)}\n`, "utf8");
  if (bytes.length > maxOutcomeBytes)
    throw new LegacyImportError("OUTCOME_TOO_LARGE", "Import receipt exceeds the bounded recoverable outcome size; no destination was published.");
  await writeOwnedFile(path, bytes);
  await syncDirectory(dirname(path));
}

async function readWorkspaceId(destination: string): Promise<string | undefined> {
  try {
    const markerPath = join(destination, ".pkm-next-workspace");
    const markerStat = await lstat(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 4096) return;
    const bytes = await readStableFile(destination, ".pkm-next-workspace", markerStat.size);
    const marker: unknown = JSON.parse(bytes.toString("utf8"));
    if (!marker || typeof marker !== "object" || !("schema" in marker) || marker.schema !== "pkm.next-workspace/v2"
      || !("id" in marker) || typeof marker.id !== "string" || !/^[0-9a-f-]{36}$/.test(marker.id)) return;
    return marker.id;
  } catch { return; }
}

async function prepareOwnedArchiveRemoval(stage: string): Promise<void> {
  let count = 0;
  async function visit(path: string, depth: number) {
    if (++count > 20000 || depth > 64) throw new LegacyImportError("STAGING_INVALID", "Owned archive cleanup exceeds safe traversal limits.");
    const before = await lstat(path);
    if (!before.isDirectory() || before.isSymbolicLink()) return;
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const actual = await handle.stat();
      if (!actual.isDirectory() || actual.dev !== before.dev || actual.ino !== before.ino)
        throw new LegacyImportError("STAGING_INVALID", "Owned archive directory changed before cleanup.");
      // Only an already-owned, soon-to-be-deleted stage may relax original read-only modes.
      if ((actual.mode & 0o700) !== 0o700) await handle.chmod((actual.mode & 0o777) | 0o700);
      for (const name of await readdir(path)) await visit(join(path, name), depth + 1);
      const after = await lstat(path);
      if (after.dev !== actual.dev || after.ino !== actual.ino || after.isSymbolicLink())
        throw new LegacyImportError("STAGING_INVALID", "Owned archive directory changed during cleanup.");
    } finally { await handle.close(); }
  }
  try { await visit(join(stage, "legacy-code-archive"), 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

async function removeOwnedStage(stage: string, ownerPath: string, owner: StageOwner): Promise<boolean> {
  if (!owner.workspaceId || await readOwner(ownerPath, owner.token, owner.destination, stage) === undefined
    || await readWorkspaceId(stage) !== owner.workspaceId) return false;
  {
    try {
      const stat = await lstat(stage);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await prepareOwnedArchiveRemoval(stage);
        await rm(stage, { recursive: true, force: false });
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    try { await unlink(ownerPath); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return true;
}

/**
 * Copy a verified plan into a new workspace and publish it by same-parent rename.
 * Existing destinations are never intentionally replaced. Keep source and target
 * trees disjoint and quiescent for the duration of this operation.
 */
export async function importLegacyWorkspace(
  input: LegacyImportPlan,
  destination: string,
  options: LegacyImportOptions,
): Promise<LegacyImportReceipt> {
  const plan = checkedPlan(input);
  if (plan.inPlaceOnly) {
    throw new LegacyImportError("IN_PLACE_PLAN_NOT_IMPORTABLE",
      "An in-place adoption inventory binds source state only; it is not a copy/import authorization.");
  }
  const unsupported = legacyImportNoReplacePlatformError(process.platform);
  if (unsupported) throw new LegacyImportError("NO_REPLACE_UNAVAILABLE", unsupported);
  if (!options || (!options.nativePublishNoReplace && (!options.pythonExecutable || !isAbsolute(options.pythonExecutable)))) {
    throw new LegacyImportError("PYTHON_PATH_REQUIRED", "Provide an explicit absolute path to the Python executable for atomic no-replace publication.");
  }
  if (!!plan.trashPlan !== !!options.trashImport) {
    throw new LegacyImportError("AUTHORITY_REQUIRED", "Composed original trash imports require both the digest-bound trash plan and explicit native scope/actor policy.");
  }
  if (!!plan.recipeTrashPlan !== !!options.recipeTrashAuthority) {
    throw new LegacyImportError("AUTHORITY_REQUIRED", "Recipe trash import requires the same explicit original control authority used for planning.");
  }
  if (plan.recipeTrashPlan) {
    verifyLegacyRecipeTrashImportSource(plan.sourceRoot, options.recipeTrashAuthority!, plan.recipeTrashPlan);
  }
  let nativeScope: LegacyTrashSnapshotScope | undefined;
  if (options.trashImport) {
    if (!options.trashImport.actorId || options.trashImport.actorId.length > 500) {
      throw new LegacyImportError("AUTHORITY_REQUIRED", "Original trash import requires an explicit bounded actor identity.");
    }
    try { nativeScope = qualifyLegacyTrashSnapshotScope(options.trashImport.nativeScope, true); }
    catch { throw new LegacyImportError("AUTHORITY_REQUIRED", "Original trash import requires an exact trusted native snapshot scope."); }
  }
  const current = await planLegacyImport(plan.sourceRoot, plan.limits, {
    snapshotAuthority: options.snapshotAuthority, ...(plan.trashPlan ? { trashPlan: plan.trashPlan } : {}),
    subscriptionRoot: plan.statePlan?.subscriptionRoot, subscriptionIdentity: options.subscriptionIdentity, protectedSubscription: options.protectedSubscription,
    ...(options.recipeTrashAuthority ? { recipeTrashAuthority: options.recipeTrashAuthority } : {}),
    ...(plan.memoryPlan ? { memoryEngine: plan.memoryPlan.sourceDatabase, memoryActorId: plan.memoryPlan.actorId,
      memoryContinuityScopeSha256: plan.memoryPlan.continuityScopeSha256 } : {}),
    ...(plan.routerConfigPlan ? { routerConfig: plan.routerConfigPlan.source } : {}),
    ...(plan.retrievalHistoryPlan ? { retrievalHistory: { stateRoot: plan.retrievalHistoryPlan.stateRoot, actorId: plan.retrievalHistoryPlan.actorId } } : {}),
  });
  if (!current.ready || current.planSha256 !== plan.planSha256) {
    throw new LegacyImportError("SOURCE_CHANGED", "The source copy no longer matches the complete planned fingerprint; no target was created.", current.blockers);
  }
  const { target, parent } = await destinationPaths(destination, plan.sourceRoot);
  if (plan.retrievalHistoryPlan && (!options.authorizeRetrievalHistory
    || isWithin(plan.retrievalHistoryPlan.stateRoot, target) || isWithin(target, plan.retrievalHistoryPlan.stateRoot))) {
    throw new LegacyImportError("ACCESS_DENIED", "Original learner migration requires native approval and a destination separate from its snapshot.");
  }
  if (plan.statePlan?.subscriptionIdentity?.destination !== undefined
    && plan.statePlan.subscriptionIdentity.destination !== target) {
    throw new LegacyImportError("ACCESS_DENIED", "Native subscription identity approval belongs to a different destination.");
  }
  if (!!plan.memoryPlan !== !!options.memoryActorId
    || plan.memoryPlan && options.memoryActorId !== plan.memoryPlan.actorId) {
    throw new LegacyImportError("AUTHORITY_REQUIRED", "Original Memory import requires the exact current actor binding approved by its plan.");
  }
  const token = randomUUID();
  const base = target.split(sep).at(-1)!;
  const stage = join(parent, `.${base}.pkm-legacy-import-${token}`);
  const projectEnvelopePlan = plan.projectEnvelopePlan as LegacyProjectEnvelopePlan | undefined;
  const ownerPath = `${stage}.owner.json`;
  const lockPath = join(parent, `.${base}.pkm-legacy-import.lock`);
  const outcomeFile = outcomePath(target);
  let owner: StageOwner = { schema: ownerSchema, token, pid: process.pid, destination: target, stage };
  let stageCreated = false;
  let published = false;
  let lockCreated = false;
  let outcomeCreated = false;
  try {
    await writeOwnedFile(ownerPath, Buffer.from(JSON.stringify(owner), "utf8"));
    try { await writeOwnedFile(lockPath, Buffer.from(JSON.stringify(owner), "utf8")); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new LegacyImportError("DESTINATION_BUSY", "Another bounded import owns the destination lock; no target was changed.");
      }
      throw error;
    }
    lockCreated = true;
    try {
      await lstat(target);
      throw new LegacyImportError("DESTINATION_EXISTS", "Import destination already exists; no files were overwritten.");
    } catch (error) {
      if (error instanceof LegacyImportError) throw error;
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    try { await lstat(stage); throw new LegacyImportError("STAGING_COLLISION", "The unique staging path already exists; no staging files were modified."); }
    catch (error) {
      if (error instanceof LegacyImportError) throw error;
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await initialize(stage);
    const workspaceId = await readWorkspaceId(stage);
    if (!workspaceId) throw new LegacyImportError("STAGING_INVALID", "Initialized stage has no valid next-workspace identity marker.");
    const initialOwner = owner;
    owner = { ...owner, workspaceId };
    await updateOwner(ownerPath, initialOwner, owner);
    stageCreated = true;
    await updateOwner(lockPath, initialOwner, owner);
    if (plan.statePlan) await stageLegacyStateImport(plan.statePlan, stage, options.snapshotAuthority, options.subscriptionIdentity, options.protectedSubscription);
    const stagedMemoryImport = plan.memoryPlan ? await stageLegacyMemoryImport(plan.memoryPlan, stage) : undefined;
    let memoryContinuity: ApprovedMemoryScopeContinuity | undefined;
    if (plan.memoryPlan?.continuityScopeSha256 && stagedMemoryImport) {
      const request = Object.freeze({
        schema: "pkm.memory-scope-continuity/v2" as const, workspaceId,
        scope: plan.memoryPlan.scopes.find(scope => sha256(scope) === plan.memoryPlan!.continuityScopeSha256)!,
        sourceScopeSha256: plan.memoryPlan.continuityScopeSha256,
        sourceDatabaseSha256: plan.memoryPlan.sourceSha256,
        importPlanSha256: plan.planSha256,
        importReceiptSha256: stagedMemoryImport.receipt.receiptSha256, actorId: plan.memoryPlan.actorId,
      });
      const approval = await options.authorizeMemoryScopeContinuity?.(request);
      if (!approval || approval.actorId !== request.actorId || !approval.decisionId
        || approval.decisionId.length > 256 || /[\u0000-\u001f\u007f]/u.test(approval.decisionId)
        || !Number.isSafeInteger(approval.expiresAtMs) || approval.expiresAtMs <= Date.now()
        || approval.expiresAtMs > Date.now() + 30 * 60 * 1000) {
        throw new LegacyImportError("AUTHORITY_REQUIRED", "Native approval of the exact source scope, target workspace, import receipt and actor is required.");
      }
      memoryContinuity = approvedMemoryScopeContinuitySchema.parse({
        ...request, decisionId: approval.decisionId, expiresAtMs: approval.expiresAtMs,
      });
    }
    let projectEnvelopeStage: string | undefined;
    let projectEnvelopeStageReceipt: Awaited<ReturnType<typeof stageLegacyProjectEnvelope>> | undefined;
    let projectEnvelopePayload: LegacyProjectEnvelopeAdoptionPayload | undefined;
    if (projectEnvelopePlan) {
      projectEnvelopeStage = join(stage, ".pkm-project-envelope-stage");
      projectEnvelopeStageReceipt = await stageLegacyProjectEnvelope(projectEnvelopePlan, projectEnvelopeStage);
      await verifyLegacyProjectEnvelopeStage(projectEnvelopePlan, projectEnvelopeStage, projectEnvelopeStageReceipt);
      projectEnvelopePayload = await prepareLegacyProjectEnvelopeAdoption(
        projectEnvelopePlan, projectEnvelopeStage, projectEnvelopeStageReceipt, workspaceId,
      );
    }
    for (const entry of plan.entries) {
      if (entry.kind === "directory") await ensureDirectory(stage, entry.destination!);
    }
    if (plan.routerConfigPlan) {
      const currentRouter = await inspectLegacyRouterConfig(plan.routerConfigPlan.source, plan.sourceRoot);
      if (JSON.stringify(currentRouter.plan) !== JSON.stringify(plan.routerConfigPlan)) {
        throw new LegacyImportError("SOURCE_CHANGED", "Original router config changed before owned staging.");
      }
      await ensureDirectory(stage, dirname(plan.routerConfigPlan.destination));
      await writeOwnedFile(join(stage, plan.routerConfigPlan.destination), currentRouter.bytes);
    }
    if (plan.boards.length) await ensureDirectory(stage, "boards");
    const stagedControlBytes = new Map<string, Buffer>();
    const projectedFiles = new Map((projectEnvelopePlan?.projectionFiles ?? []).map(file =>
      [file.path, Buffer.from(file.base64, "base64")]));
    for (const entry of plan.entries) {
      if (entry.kind === "directory") continue;
      const bytes = projectedFiles.get(entry.source) ?? await readStableFile(plan.sourceRoot, entry.source, entry.size);
      if (sha256(bytes) !== entry.sha256) throw new LegacyImportError("SOURCE_CHANGED", `Source bytes changed during staging: ${entry.source}`);
      if (isLegacyControlPath(entry.source)) {
        stagedControlBytes.set(entry.source, bytes);
        continue;
      }
      const destinationPath = entry.destination!;
      const parentPath = dirname(destinationPath).replaceAll("\\", "/");
      await ensureDirectory(stage, parentPath === "." ? "" : parentPath);
      await writeOwnedFile(join(stage, ...destinationPath.split("/")), bytes);
      if (entry.mode !== undefined) {
        const source = await lstat(join(plan.sourceRoot, entry.source));
        if (!isLegacyLibraryResourcePath(entry.source) || source.isSymbolicLink() || !source.isFile() || source.nlink !== 1 || (source.mode & 0o7000) !== 0
          || (source.mode & 0o777) !== entry.mode) throw new LegacyImportError("SOURCE_CHANGED", "Original library permissions changed during staging.");
        const handle = await open(join(stage, destinationPath), constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await handle.chmod(entry.mode); await handle.sync(); } finally { await handle.close(); }
      }
    }
    // Apply original inert directory modes only after all children have been written.
    for (const entry of [...plan.entries].reverse()) {
      if (entry.kind !== "directory" || entry.mode === undefined) continue;
      const source = await lstat(join(plan.sourceRoot, entry.source));
      if ((!isInertLegacyPath(entry.source, "directory")
        && (!entry.destination || !isArchivedCodePath(entry.destination)))
        || !source.isDirectory() || source.isSymbolicLink()
        || (source.mode & 0o777) !== entry.mode || (source.mode & 0o7000) !== 0)
        throw new LegacyImportError("SOURCE_CHANGED", "Original inert directory permissions changed during staging.");
      const handle = await open(join(stage, entry.destination!), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.chmod(entry.mode); await handle.sync(); } finally { await handle.close(); }
    }
    restoreFileMtimes(stage, plan.entries.flatMap(entry =>
      entry.mtimeNs !== undefined && entry.destination ? [{ path: entry.destination, mtimeNs: entry.mtimeNs }] : []),
      options.pythonExecutable ?? process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3"));
    if (projectEnvelopeStage) {
      await rm(projectEnvelopeStage, { recursive: true, force: false });
      projectEnvelopeStage = undefined;
    }

    const markdown = scanMarkdown(stage);
    const expectedDocuments = [
      ...plan.entries.filter(entry => entry.kind === "document"),
      ...(stagedMemoryImport?.receipt.documents.map(document => ({
        kind: "document" as const, destination: document.path, documentId: document.id, sha256: document.sha256,
      })) ?? []),
    ];
    if (markdown.length !== expectedDocuments.length || markdown.some(document => {
      const expected = expectedDocuments.find(entry => entry.destination === `${document.record.area}/${document.record.path}`);
      return !expected || expected.documentId !== document.record.id || expected.sha256 !== document.record.sha256;
    })) {
      throw new LegacyImportError("STAGING_INVALID", "The initialized target scanner did not reproduce every source Markdown identity and byte digest.");
    }
    const migratedBoards = scanBoards(stage);
    if (migratedBoards.size !== plan.boards.length || plan.boards.some(board => {
      const migrated = migratedBoards.get(board.slug);
      if (!migrated) return true;
      try {
        const validated = readTodoBoard(migrated.raw);
        return validated.digest !== board.digest || validated.items.length !== board.itemCount;
      } catch { return true; }
    })) throw new LegacyImportError("STAGING_INVALID", "The target Board validator did not reproduce every validated Board history and digest.");
    const projectRecipeEntries = plan.entries.filter(entry => /^(project|recipes)(\/|$)/.test(entry.source));
    let stagedProjectModel: ProjectRecipeExportSummary = {
      projects: [], threads: [], ganttTasks: [], collaborationTasks: [], recipes: [],
    };
    if (projectRecipeEntries.length) {
      try { stagedProjectModel = validateProjectRecipeExport(stage, projectRecipeEntries); }
      catch { throw new LegacyImportError("STAGING_INVALID", "The staged Project/Recipe export failed canonical and binding validation."); }
    }
    if (plan.recipeTrashPlan) {
      verifyLegacyRecipeTrashImportSource(plan.sourceRoot, options.recipeTrashAuthority!, plan.recipeTrashPlan);
      stageLegacyRecipeTrashImport(plan.recipeTrashPlan, stage);
      verifyLegacyRecipeTrashImportStage(plan.recipeTrashPlan, stage);
    }
    let importedProjectControl: ImportedProjectControl | undefined;
    let importedRecipeControl: ImportedRecipeControl | undefined;
    try {
      const projectBytes = stagedControlBytes.get(projectControlPath);
      if (projectBytes) importedProjectControl = parseLegacyProjectControl(projectBytes, stagedProjectModel);
      const recipeBytes = stagedControlBytes.get(recipeControlPath);
      if (recipeBytes) importedRecipeControl = parseLegacyRecipeControl(recipeBytes, stagedProjectModel);
    } catch {
      throw new LegacyImportError("STAGING_INVALID", "The staged original control bytes no longer match their validated Project/Recipe state.");
    }
    if (plan.recipeTrashPlan && (!importedProjectControl
      || importedProjectControl.rootId !== plan.recipeTrashPlan.sourceRootId
      || importedProjectControl.storeVersion !== plan.recipeTrashPlan.sourceStoreVersion
      || importedProjectControl.controlSha256 !== plan.recipeTrashPlan.sourceControlSha256
      || importedProjectControl.controlBytes.toString("base64") !== plan.recipeTrashPlan.sourceControlBytes
      || JSON.stringify(importedProjectControl.receipts) !== JSON.stringify(plan.recipeTrashPlan.receipts))) {
      throw new LegacyImportError("STAGING_INVALID", "Recipe trash bytes and history are not bound to the same original Project control.");
    }

    let trashAuthority: LegacyTrashLayoutAuthority | undefined;
    let trashMarkerSha256: string | undefined;
    if (plan.trashPlan) {
      if (!nativeScope) throw new LegacyImportError("AUTHORITY_REQUIRED", "Native trash scope was not retained for shared-stage population.");
      trashAuthority = {
        source: plan.trashPlan.source, destination: target, stage, workspaceId,
        actorId: options.trashImport!.actorId, planSha256: plan.trashPlan.planSha256,
        layoutVersion: "pkm.trash-lifecycle/v1",
      };
      const parentAuthority = await parentStageAuthority(stage, nativeScope, Math.max(plan.limits.maxTotalBytes, 536_870_912));
      await populateLegacyTrashImportStage(plan.trashPlan, target, trashAuthority, nativeScope, parentAuthority);
      const markerBytes = await readStableFile(stage, legacyTrashStageReceiptPath);
      trashMarkerSha256 = sha256(markerBytes);
    }
    const receipt = makeReceipt(plan, target, trashAuthority && trashMarkerSha256
      ? { markerSha256: trashMarkerSha256, authority: trashAuthority } : undefined,
      stagedMemoryImport?.receipt, projectEnvelopePayload?.receipt, memoryContinuity);
    const outcome: LegacyImportOutcome = {
      schema: outcomeSchema, token, destination: target, workspaceId, fingerprint: plan.fingerprint!,
      state: "prepared", receipt,
    };
    const storage = await Storage.open(stage, { deferRecovery: !!plan.statePlan?.entries.some(entry =>
      entry.destination.startsWith("_feedback/") || entry.destination.startsWith("_proposals/")) });
    try {
      const workspaceId = await storage.workspaceId();
      const database = storage.connectNative();
      try {
        await storage.withWorkspaceExclusive(() => {
          storage.assertWorkspaceLease();
          database.exec("BEGIN IMMEDIATE");
          try {
            insertLegacyControlSnapshot(database, workspaceId, importedProjectControl, importedRecipeControl);
            if (projectEnvelopePayload) {
              initializeLegacyProjectEnvelopeSchema(database);
              recordLegacyProjectEnvelopeAdoption(database, projectEnvelopePayload);
            }
            if (stagedMemoryImport) persistLegacyMemoryImport(database, workspaceId, stagedMemoryImport);
            if (memoryContinuity) persistMemoryScopeContinuity(database, memoryContinuity);
            insertLegacyStateReceipt(database, plan, outcome);
            storage.assertWorkspaceLease();
            database.exec("COMMIT");
          } catch (error) {
            if (database.isTransaction) database.exec("ROLLBACK");
            throw error;
          }
        });
        const storedProject = importedProjectControl ? readLegacyProjectControl(database, workspaceId) : undefined;
        const storedRecipe = importedRecipeControl ? readLegacyRecipeControl(database, workspaceId) : undefined;
        const hasEnvelopeTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_project_envelope'").get();
        const storedEnvelope = hasEnvelopeTable ? readLegacyProjectEnvelopeAdoption(database, workspaceId) : undefined;
        if (projectEnvelopePayload && (!storedEnvelope
          || canonicalJson(storedEnvelope.receipt) !== canonicalJson(projectEnvelopePayload.receipt)
          || !storedEnvelope.sourceBytes.equals(projectEnvelopePayload.sourceBytes))
          || (!projectEnvelopePayload && storedEnvelope)) {
          throw new LegacyImportError("STAGING_INVALID", "Durable opaque ProjectStore bytes or adoption receipt failed readback.");
        }
        if (plan.statePlan && JSON.stringify(readLegacyStateReceipt(database, workspaceId)?.outcome) !== JSON.stringify(outcome)) {
          throw new LegacyImportError("STAGING_INVALID", "Durable original state receipt failed readback.");
        }
        if (stagedMemoryImport
          && JSON.stringify(readLegacyMemoryImportReceipt(database, workspaceId)) !== JSON.stringify(receipt.memoryImport)) {
          throw new LegacyImportError("STAGING_INVALID", "Durable original Memory import receipt failed readback.");
        }
        if (JSON.stringify(readMemoryScopeContinuity(database, workspaceId)) !== JSON.stringify(memoryContinuity)) {
          throw new LegacyImportError("STAGING_INVALID", "Native-approved Memory scope continuity failed durable readback.");
        }
        if ((importedProjectControl && (!storedProject
          || !storedProject.controlBytes.equals(importedProjectControl.controlBytes)
          || storedProject.controlSha256 !== importedProjectControl.controlSha256
          || storedProject.rootId !== importedProjectControl.rootId
          || storedProject.storeVersion !== importedProjectControl.storeVersion
          || storedProject.canonicalDigest !== importedProjectControl.canonicalDigest
          || JSON.stringify(storedProject.receipts.map(({ ordinal: _ordinal, ...receipt }) => receipt)) !== JSON.stringify(
            importedProjectControl.receipts)))
          || (!importedProjectControl && storedProject)
          || (importedRecipeControl && (!storedRecipe
            || !storedRecipe.controlBytes.equals(importedRecipeControl.controlBytes)
            || storedRecipe.controlSha256 !== importedRecipeControl.controlSha256))
          || (!importedRecipeControl && storedRecipe)) {
          throw new LegacyImportError("STAGING_INVALID", "Durable Project/Recipe control bytes or ordered command receipts failed readback.");
        }
      } finally { database.close(); }
      if (plan.retrievalHistoryPlan) {
        const history = plan.retrievalHistoryPlan;
        const snapshot = await inspectLegacyRetrievalHistory(history.source.sourceDatabase);
        if (JSON.stringify(snapshot.source) !== JSON.stringify(history.source)) throw new LegacyImportError("SOURCE_CHANGED", "Original learner snapshot changed before native approval.");
        const db = storage.connectNative();
        let corpus: string;
        try {
          corpus = await storage.withWorkspaceExclusive(async () => legacyRetrievalSources(storage, db,
            await legacyRetrievalSubscriptions(stage)).snapshot.corpus_revision as string);
        } finally { db.close(); }
        const request = Object.freeze({ actorId: history.actorId, workspaceId, sourceSha256: history.source.sha256,
          historyPlanSha256: history.planSha256, selectedPackageId: history.selectedPackageId, currentCorpusSha256: corpus });
        const approval = await options.authorizeRetrievalHistory!(request);
        if (!approval || approval.actorId !== history.actorId || !approval.decisionId?.trim()) {
          throw new LegacyImportError("ACCESS_DENIED", "Native learner history approval did not bind the exact actor and migration.");
        }
        if (JSON.stringify(await planLegacyRetrievalHistory(history.stateRoot, history.actorId)) !== JSON.stringify(history)) {
          throw new LegacyImportError("SOURCE_CHANGED", "Original retrieval state changed during native approval.");
        }
        const actor = { id: history.actorId, canWrite: true };
        const enabled = snapshot.state.settings.find(row => row[0] === "enabled")?.[1] === "true";
        const packageIds = history.directories.filter(path => /^solutions\/[a-f0-9]{64}$/.test(path)).map(path => path.split("/")[1]!);
        for (const packageId of packageIds) await admitLegacyRetrievalModel(storage, actor, {
          sourceRoot: join(history.stateRoot, "solutions", packageId), packageId,
          authorityId: approval.decisionId, authorize: () => true, learningEnabled: enabled, userFeedback: false,
        });
        if (history.frozenRelease) await admitLegacyRetrievalModel(storage, actor, {
          sourceRoot: join(history.stateRoot, "solutions", history.frozenRelease.packageId),
          packageId: history.frozenRelease.packageId, frozenReleaseFile: join(history.stateRoot, "serving-release.json"),
          authorityId: approval.decisionId, authorize: () => true, learningEnabled: enabled, userFeedback: false,
        });
        else if (packageIds.length) await selectLegacyRetrievalModel(storage, actor, {
          packageId: history.selectedPackageId, authorityId: approval.decisionId, authorize: () => true,
          learningEnabled: enabled, userFeedback: false,
        });
        const nativeDb = storage.connectNative();
        try {
          await storage.withWorkspaceExclusive(async () => {
            const currentCorpus = legacyRetrievalSources(storage, nativeDb, await legacyRetrievalSubscriptions(stage)).snapshot.corpus_revision;
            if (currentCorpus !== corpus) throw new LegacyImportError("SOURCE_CHANGED", "Staged source corpus changed during learner migration.");
            storage.assertWorkspaceLease();
            nativeDb.exec("BEGIN IMMEDIATE");
            try {
              persistLegacyRetrievalLearningGenesis(nativeDb, { workspaceId, actorId: history.actorId,
                sourceSha256: history.source.sha256, approvalId: approval.decisionId,
                selectedPackageId: history.selectedPackageId, currentCorpusSha256: corpus, tables: snapshot.state });
              storage.assertWorkspaceLease(); nativeDb.exec("COMMIT");
            } catch (error) { if (nativeDb.isTransaction) nativeDb.exec("ROLLBACK"); throw error; }
          });
        } finally { nativeDb.close(); }
        const verification = storage.connectNative();
        try {
          await storage.withWorkspaceExclusive(() => verifyBoundLegacyStateBytes(verification, stage, workspaceId));
        } finally { verification.close(); }
      }
      await storage.recover();
    } finally { await storage.close(); }

    const rechecked = await planLegacyImport(plan.sourceRoot, plan.limits, {
      snapshotAuthority: options.snapshotAuthority, ...(plan.trashPlan ? { trashPlan: plan.trashPlan } : {}),
      subscriptionRoot: plan.statePlan?.subscriptionRoot, subscriptionIdentity: options.subscriptionIdentity, protectedSubscription: options.protectedSubscription,
      ...(options.recipeTrashAuthority ? { recipeTrashAuthority: options.recipeTrashAuthority } : {}),
      ...(plan.memoryPlan ? { memoryEngine: plan.memoryPlan.sourceDatabase, memoryActorId: plan.memoryPlan.actorId,
        memoryContinuityScopeSha256: plan.memoryPlan.continuityScopeSha256 } : {}),
      ...(plan.routerConfigPlan ? { routerConfig: plan.routerConfigPlan.source } : {}),
      ...(plan.retrievalHistoryPlan ? { retrievalHistory: { stateRoot: plan.retrievalHistoryPlan.stateRoot, actorId: plan.retrievalHistoryPlan.actorId } } : {}),
    });
    if (!rechecked.ready || rechecked.planSha256 !== plan.planSha256) {
      throw new LegacyImportError("SOURCE_CHANGED", "The source changed during staging; the owned staging directory was discarded.", rechecked.blockers);
    }
    if (plan.recipeTrashPlan) verifyLegacyRecipeTrashImportStage(plan.recipeTrashPlan, stage);
    await assertRealDirectory(parent);
    if (await readWorkspaceId(stage) !== workspaceId) throw new LegacyImportError("STAGING_INVALID", "Staging workspace identity changed before publication.");
    try { await writeOutcome(outcomeFile, outcome); outcomeCreated = true; }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new LegacyImportError("OUTCOME_EXISTS", "A sibling import outcome record already exists; recover or explicitly preserve it before retrying.");
      }
      throw error;
    }
    await syncDirectory(stage);
    if (plan.statePlan) await verifyLegacyStateImport(plan.statePlan, stage, options.snapshotAuthority, options.subscriptionIdentity, options.protectedSubscription);
    if (plan.memoryPlan) {
      const verified = await planLegacyMemoryImport(plan.memoryPlan.sourceDatabase, plan.sourceRoot, plan.memoryPlan.actorId,
        plan.memoryPlan.continuityScopeSha256);
      if (verified.planSha256 !== plan.memoryPlan.planSha256) {
        throw new LegacyImportError("SOURCE_CHANGED", "Original Memory Engine changed before no-replace publication.");
      }
    }
    if (plan.routerConfigPlan) {
      const checkedRouter = await inspectLegacyRouterConfig(plan.routerConfigPlan.source, plan.sourceRoot);
      if (JSON.stringify(checkedRouter.plan) !== JSON.stringify(plan.routerConfigPlan)
        || sha256(await readStableFile(stage, plan.routerConfigPlan.destination, plan.routerConfigPlan.size)) !== plan.routerConfigPlan.sha256) {
        throw new LegacyImportError("SOURCE_CHANGED", "Original router config or its owned projection changed before publication.");
      }
    }
    if (!await readOwner(ownerPath, token, target, stage) || !await readOwner(lockPath, token, target, stage)
      || await readWorkspaceId(stage) !== workspaceId) throw new LegacyImportError("STAGING_INVALID", "Stage ownership changed before publication.");
    if (plan.statePlan?.keyEpoch) {
      let epoch: string | undefined;
      try { epoch = await options.snapshotAuthority?.epoch(); } catch { /* Unavailable native policy denies publication. */ }
      if (epoch !== plan.statePlan.keyEpoch) throw new LegacyImportError("KEY_AUTHORITY_REQUIRED", "Native snapshot key policy changed before publication.");
    }
    if (plan.retrievalHistoryPlan && JSON.stringify(await planLegacyRetrievalHistory(
      plan.retrievalHistoryPlan.stateRoot, plan.retrievalHistoryPlan.actorId)) !== JSON.stringify(plan.retrievalHistoryPlan)) {
      throw new LegacyImportError("SOURCE_CHANGED", "Original retrieval state changed before no-replace publication.");
    }
    if (process.platform === "linux") {
      const fence = await acquireLinuxRootWriterFence(stage);
      try {
        await fence.publishRootNoReplace(target, keepAlive => options.nativePublishNoReplace
          ? options.nativePublishNoReplace(stage, target)
          : publishNoReplace(stage, target, options.pythonExecutable!, keepAlive));
      } catch (error) {
        if (error instanceof CoreError && error.code === "CONFLICT")
          throw new LegacyImportError("DESTINATION_EXISTS", error.message);
        throw error;
      } finally { await fence.release(); }
    } else if (options.nativePublishNoReplace) await options.nativePublishNoReplace(stage, target);
    else publishNoReplace(stage, target, options.pythonExecutable!);
    published = true;
    await syncDirectory(parent);
    try { await unlink(ownerPath); } catch { /* A verified target is already published; a stale owner record is harmless. */ }
    try { await unlink(lockPath); } catch { /* A published target is never removed to repair a stale lock. */ }
    return receipt;
  } catch (error) {
    let stageExists = false;
    try {
      const stat = await lstat(stage);
      stageExists = stat.isDirectory() && !stat.isSymbolicLink();
    } catch { /* A missing path is not a staging tree to remove. */ }
    if ((stageCreated || stageExists) && !published) {
      try { await removeOwnedStage(stage, ownerPath, owner); } catch { /* Preserve any path that no longer proves ownership. */ }
    } else if (!stageCreated) {
      try { await unlink(ownerPath); } catch { /* No staging directory was initialized. */ }
    }
    if (outcomeCreated && !published) {
      try {
        const bytes = await readStableFile(dirname(outcomeFile), outcomeFile.slice(dirname(outcomeFile).length + 1));
        const found = legacyImportOutcomeSchema.safeParse(JSON.parse(bytes.toString("utf8")));
        if (found.success && found.data.token === token && found.data.destination === target) await unlink(outcomeFile);
      } catch { /* Preserve any outcome record whose ownership can no longer be proved. */ }
    }
    if (lockCreated && await readOwner(lockPath, token, target, stage)) {
      try { await unlink(lockPath); } catch { /* Keep any lock whose ownership can no longer be proved. */ }
    }
    throw error;
  }
}

export async function recoverLegacyImportOutcome(destination: string): Promise<LegacyImportRecovery> {
  const target = resolve(destination);
  const parent = await assertRealDirectory(dirname(target));
  const path = outcomePath(target);
  let parsed: LegacyImportOutcome;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxOutcomeBytes) {
      return { status: "unknown", reason: "Sibling outcome record is not a bounded regular file." };
    }
    const bytes = await readStableFile(parent, path.slice(parent.length + 1), stat.size);
    const result = legacyImportOutcomeSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!result.success || result.data.destination !== target) {
      return { status: "unknown", reason: "Sibling outcome record is malformed or names a different destination." };
    }
    parsed = result.data;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { status: "unknown", reason: "No persisted import outcome record exists." };
    }
    return { status: "unknown", reason: "Sibling outcome record could not be read safely." };
  }
  let destinationExists = false;
  try {
    const stat = await lstat(target);
    destinationExists = true;
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { status: "unknown", receipt: parsed.receipt, reason: "Destination exists but is not a real directory." };
    if (await readWorkspaceId(target) === parsed.workspaceId) {
      const { receiptSha256, ...receiptBody } = parsed.receipt;
      if (sha256(JSON.stringify(receiptBody)) !== receiptSha256) return { status: "unknown", reason: "Import outcome receipt hash is invalid." };
      {
        const { DatabaseSync } = await import("node:sqlite");
        const stat = await lstat(join(target, "core.sqlite"));
        if (!stat.isFile() || stat.isSymbolicLink()) return { status: "unknown", reason: "Imported workspace database is not a regular file." };
        const database = new DatabaseSync(join(target, "core.sqlite"), { readOnly: true });
        try {
          const hasStateTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_state_import_receipt'").get();
          const binding = hasStateTable ? readLegacyStateReceipt(database, parsed.workspaceId) : undefined;
          if (parsed.receipt.statePlan && !binding || binding && JSON.stringify(binding.outcome) !== JSON.stringify(parsed)) {
            return { status: "unknown", reason: "Original state import outcome does not match its complete durable binding." };
          }
          if (binding) await verifyBoundLegacyStateBytes(database, target, parsed.workspaceId);
          const hasMemoryTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_memory_imports'").get();
          const memoryReceipt = hasMemoryTable ? readLegacyMemoryImportReceipt(database, parsed.workspaceId) : undefined;
          if (JSON.stringify(readMemoryScopeContinuity(database, parsed.workspaceId))
            !== JSON.stringify(parsed.receipt.memoryScopeContinuity)) {
            return { status: "unknown", reason: "Original Memory scope continuity differs from its native-approved import receipt." };
          }
          if (parsed.receipt.memoryImport && (!memoryReceipt
            || JSON.stringify(memoryReceipt) !== JSON.stringify(parsed.receipt.memoryImport))
            || memoryReceipt && !parsed.receipt.memoryImport) {
            return { status: "unknown", reason: "Original explicit Memory import is missing its exact durable receipt." };
          }
          if (memoryReceipt) {
            const count = Number(database.prepare("SELECT COUNT(*) AS count FROM legacy_memory_import_operations").get()?.count);
            if (count !== memoryReceipt.operations) {
              return { status: "unknown", reason: "Original explicit Memory operation receipts are incomplete." };
            }
            for (const document of memoryReceipt.documents) {
              const bytes = await readStableFile(target, document.path);
              if (sha256(bytes) !== document.sha256) {
                return { status: "unknown", reason: "Imported explicit Memory Markdown differs from its durable receipt." };
              }
            }
          }
          const hasProjectEnvelope = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_project_envelope'").get();
          const projectEnvelope = hasProjectEnvelope ? readLegacyProjectEnvelopeAdoption(database, parsed.workspaceId) : undefined;
          if (parsed.receipt.projectEnvelope && (!projectEnvelope
            || canonicalJson(projectEnvelope.receipt) !== canonicalJson(parsed.receipt.projectEnvelope))
            || projectEnvelope && !parsed.receipt.projectEnvelope) {
            return { status: "unknown", reason: "Opaque ProjectStore source does not match its durable envelope adoption." };
          }
        } finally { database.close(); }
      }
      return { status: "published", receipt: parsed.receipt };
    }
    return { status: "unknown", receipt: parsed.receipt, reason: "Destination identity does not match the recorded staged workspace; it was not modified." };
  } catch (error) {
    if (destinationExists || !(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      return { status: "unknown", receipt: parsed.receipt, reason: "Destination state could not be checked safely." };
    }
  }

  const base = target.split(sep).at(-1)!;
  const stage = join(parent, `.${base}.pkm-legacy-import-${parsed.token}`);
  const lockPath = join(parent, `.${base}.pkm-legacy-import.lock`);
  const owner = await readOwner(lockPath, parsed.token, target, stage);
  if (owner) {
    try {
      process.kill(owner.pid, 0);
      return { status: "in-progress", receipt: parsed.receipt, reason: "The recorded importer process is still alive." };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EPERM") {
        return { status: "in-progress", receipt: parsed.receipt, reason: "Importer liveness cannot be disproved." };
      }
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
        return { status: "unknown", receipt: parsed.receipt, reason: "Importer liveness could not be established." };
      }
    }
  }
  return { status: "not-published", receipt: parsed.receipt, reason: "The recorded workspace identity is absent and no live owner lock was found." };
}

/**
 * Remove abandoned same-target staging directories only when their external
 * ownership records match and their recorded process is no longer alive.
 */
export async function cleanupInterruptedLegacyImportStages(destination: string): Promise<{ removed: string[]; retained: string[] }> {
  const target = resolve(destination);
  const parent = await assertRealDirectory(dirname(target));
  const base = target.split(sep).at(-1)!;
  const prefix = `.${base}.pkm-legacy-import-`;
  const removed: string[] = [], retained: string[] = [];
  for (const name of (await readdir(parent)).filter(value => value.startsWith(prefix)).sort(compare)) {
    const stage = join(parent, name.replace(/\.owner\.json$/, ""));
    const token = name.slice(prefix.length).replace(/\.owner\.json$/, "");
    if (!/^[a-f0-9-]{36}$/.test(token) || !name.endsWith(".owner.json")) continue;
    const ownerPath = join(parent, name);
    const owner = await readOwner(ownerPath, token, target, stage);
    if (!owner) continue;
    try {
      process.kill(owner.pid, 0);
      retained.push(stage);
      continue;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code !== "ESRCH") {
        retained.push(stage);
        continue;
      }
    }
    if (!await removeOwnedStage(stage, ownerPath, owner)) {
      retained.push(stage);
      continue;
    }
    const lockPath = join(parent, `.${base}.pkm-legacy-import.lock`);
    if (await readOwner(lockPath, token, target, stage)) {
      try { await unlink(lockPath); } catch { retained.push(stage); continue; }
    }
    removed.push(stage);
  }
  return { removed, retained };
}

export type { LegacyImportBoard, LegacyImportEntry, LegacyImportLimits, LegacyImportPlan, LegacyImportReceipt };
