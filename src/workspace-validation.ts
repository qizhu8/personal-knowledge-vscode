import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, readdir, writeFile, lstat, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { knowledgeArea } from "./document-path.js";
import { coreDatabaseFile, coreDatabaseFiles, codingProcessDatabaseFiles, coreDatabasePath,
  workspaceStoragePaths, storageLayoutMarker, serverDataDirectory, managedRuntimeDirectory, separatedStorageSchema } from "./workspace-storage-paths.js";
import { assertLinuxRootOwnerMarker } from "./linux-root-writer-fence.js";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, type BigIntStats } from "node:fs";
import type { LinuxRootWriterFence } from "./linux-root-writer-fence.js";
import { assertWorkspaceGitProtection, protectWorkspaceGit } from "./workspace-git-protection.js";
import { inspectWorkspaceRuntimeControls } from "./workspace-runtime-control.js";

export const marker = ".pkm-next-workspace";
export const rootAdoptionJournal = ".pkm-next-root-adoption.json";
const rootAdoptionCommit = ".pkm-next-root-adoption.commit.json";
const jsonSha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const privateRoomRecovery = Symbol("private-room-recovery");
export const storageMigrationGitInspection = Symbol("offline-storage-migration-git-inspection");
export type PrivateRoomRecovery = { root: string; archives: { roomId: string; sourceFingerprint: string }[] };
export interface WorkspaceValidationOptions {
  adoptionToken?: string;
  originalMcpToken?: string;
  originalMcpReadFence?: LinuxRootWriterFence;
  [privateRoomRecovery]?: PrivateRoomRecovery;
  [storageMigrationGitInspection]?: true;
}
const plainEntries = new Set([marker, "notes", "skills", "papers", ...coreDatabaseFiles,
  storageLayoutMarker, serverDataDirectory, managedRuntimeDirectory,
  ...(process.platform === "linux" ? [".pkm-next-writer-fenced.json"] : [])]);
export function isPlainWorkspaceLayout(entries: readonly string[], options: WorkspaceValidationOptions = {}): boolean {
  return options.adoptionToken === undefined && options[privateRoomRecovery] === undefined
    && entries.every(name => plainEntries.has(name) || name === ".gitignore" && entries.includes(storageLayoutMarker));
}
export function parseWorkspaceIdentity(text: string): { schema: "pkm.next-workspace/v2"; id: string } {
  const identity: unknown = JSON.parse(text);
  if (!identity || typeof identity !== "object" || !("schema" in identity) || identity.schema !== "pkm.next-workspace/v2")
    throw new CoreError("INVALID_WORKSPACE", "Initialize a new Markdown-authoritative v2 workspace. Database-only prototype v1 workspaces are not automatically adopted.");
  if (!("id" in identity) || typeof identity.id !== "string" || !/^[0-9a-f-]{36}$/i.test(identity.id))
    throw new CoreError("INVALID_WORKSPACE", "Workspace identity is invalid.");
  return identity as { schema: "pkm.next-workspace/v2"; id: string };
}
export interface PlainWorkspaceControls { readonly rootPin: string; readonly workspaceId: string; readonly digest: string }
/** Consistency pins after canonical validation, not a substitute for root/actor admission. */
export function capturePlainWorkspaceControls(root: string): PlainWorkspaceControls | undefined {
  const entries = readdirSync(root).sort();
  if (!isPlainWorkspaceLayout(entries)) return;
  const rootStat = lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(root) !== root)
    throw new CoreError("INVALID_WORKSPACE", "Workspace symlinks are not supported.");
  const hash = createHash("sha256");
  const pin = (stat: BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.uid, stat.nlink].map(String);
  hash.update(JSON.stringify([String(rootStat.dev), String(rootStat.ino), String(rootStat.mode), String(rootStat.uid)]));
  let workspaceId: string | undefined;
  for (const name of entries) {
    const path = join(root, name), before = lstatSync(path, { bigint: true });
    const directory = knowledgeArea.options.some(area => area === name)
      || name === serverDataDirectory || name === managedRuntimeDirectory;
    if (before.isSymbolicLink() || !(directory ? before.isDirectory() : before.isFile()))
      throw new CoreError("INVALID_WORKSPACE", "Workspace entries must be regular files or knowledge/boards directories.");
    hash.update(JSON.stringify([name, ...pin(before)]));
    if (name === serverDataDirectory) {
      for (const child of readdirSync(path).sort()) {
        if (child === "runtime-control") {
          for (const control of inspectWorkspaceRuntimeControls(root)) {
            const full = join(path, child, control), stat = lstatSync(full, { bigint: true });
            hash.update(JSON.stringify([child, control, ...pin(stat)]));
            if (control.endsWith(".json") || control.endsWith(".pending")) hash.update(readFileSync(full));
          }
          continue;
        }
        const stat = lstatSync(join(path, child), { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
          throw new CoreError("INVALID_WORKSPACE", "Server data must contain only owned regular database files.");
        hash.update(JSON.stringify([name, child, ...pin(stat)]));
      }
    }
    if (name !== marker && name !== ".pkm-next-writer-fenced.json" && name !== storageLayoutMarker && name !== ".gitignore") continue;
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const bytes = readFileSync(fd), opened = fstatSync(fd, { bigint: true }), current = lstatSync(path, { bigint: true });
      if (JSON.stringify(pin(before)) !== JSON.stringify(pin(opened)) || JSON.stringify(pin(before)) !== JSON.stringify(pin(current))
        || before.size !== opened.size || before.mtimeNs !== opened.mtimeNs || before.ctimeNs !== opened.ctimeNs
        || before.size !== current.size || before.mtimeNs !== current.mtimeNs || before.ctimeNs !== current.ctimeNs)
        throw new CoreError("CONFLICT", "Workspace control changed during the read.");
      hash.update(bytes);
      if (name === marker) workspaceId = parseWorkspaceIdentity(bytes.toString("utf8")).id;
    } finally { closeSync(fd); }
  }
  workspaceStoragePaths(root);
  if (!workspaceId) throw new CoreError("INVALID_WORKSPACE", "Workspace identity is invalid.");
  return Object.freeze({ rootPin: `${rootStat.dev}:${rootStat.ino}`, workspaceId, digest: hash.digest("hex") });
}
export async function initialize(directory: string, options: { storageLayout?: "flat" | "separated" } = {}) {
  const root = resolve(directory);
  await mkdir(root, { mode: 0o700 });
  const id = randomUUID();
  await writeFile(join(root, marker), JSON.stringify({ schema: "pkm.next-workspace/v2", id }), { flag: "wx", mode: 0o600 });
  await mkdir(join(root, "notes"), { mode: 0o700 });
  if (options.storageLayout === "separated") {
    await mkdir(join(root, serverDataDirectory), { mode: 0o700 });
    await writeFile(join(root, serverDataDirectory, coreDatabaseFile), "", { flag: "wx", mode: 0o600 });
    await writeFile(join(root, storageLayoutMarker), JSON.stringify({
      schema: separatedStorageSchema, workspaceId: id, layout: "separated",
    }), { flag: "wx", mode: 0o600 });
    protectWorkspaceGit(root);
  }
  return root;
}
export async function validateWorkspace(directory: string, options: WorkspaceValidationOptions = {}) {
  const root = resolve(directory);
  if ((await lstat(root)).isSymbolicLink()) throw new CoreError("INVALID_WORKSPACE", "Workspace symlinks are not supported.");
  const entries = await readdir(root);
  const storagePaths = workspaceStoragePaths(root);
  const nativeUserGit = storagePaths.layout === "separated" || options[storageMigrationGitInspection] === true;
  if (nativeUserGit && entries.includes(rootAdoptionJournal))
    throw new CoreError("RECOVERY_REQUIRED", "Native separated Git admission does not authorize an in-place legacy adoption.");
  if (nativeUserGit) assertWorkspaceGitProtection(root);
  if (entries.includes(".pkm-next-original-mcp.rollback.json"))
    throw new CoreError("RECOVERY_REQUIRED", "Original MCP rollback must finish before an owner or workers may start.");
  if (entries.includes(".pkm-next-original-mcp.json")) {
    const { validateOriginalMcpWorkspace } = await import("./original-mcp-root.js");
    return validateOriginalMcpWorkspace(root, options.originalMcpToken, options.originalMcpReadFence);
  }
  if (options.originalMcpToken !== undefined)
    throw new CoreError("RECOVERY_REQUIRED", "Original MCP recovery requires its durable custody journal.");
  const full = isPlainWorkspaceLayout(entries, options) ? undefined : await import("./workspace-validation-full.js");
  const directories = new Set<string>([...knowledgeArea.options, "prompts", "scripts", "actions", "components",
    "packages", "boards", "project", "recipes", "subscriptions", "agent-snapshot-reads", "recipe-usage-reads",
    "knowledge-read-config", "legacy-import-evidence", "legacy-code-archive", ".pkm", ".pkm-action-authority", ".pkm-plugin-authority", ".pkm-room-admission",
    ".pkm-action-sources", ".pkm-action-builds", ".git", "chatrooms", "mcp-server", "servers", "runtime-control", managedRuntimeDirectory,
    ...(storagePaths.layout === "separated" ? [serverDataDirectory] : [])]);
  const inertRootFiles = new Set([".gitignore", "fixture-sentinel.txt"]);
  for (const area of ["profiles", "action-module-sets"] as const) {
    if (entries.includes(area)) {
      full!.verifyNativeSyncRootContent(root, area);
      directories.add(area);
    }
  }
  for (const name of ["_feedback", "_proposals"]) {
    if (!entries.includes(name)) continue;
    const rootStat = await lstat(join(root, name));
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new CoreError("INVALID_WORKSPACE", "Skill maintenance root must be a real directory.");
    const children = await readdir(join(root, name));
    if (name === "_feedback" && children.some(child => child !== "skill-usage.jsonl" && !/^\.pkm-write-[a-fA-F0-9-]{36}$/.test(child))
      || name === "_proposals" && children.some(child => child !== "skills")) {
      throw new CoreError("INVALID_WORKSPACE", "Unknown Skill maintenance artifact state.");
    }
    if (name === "_proposals" && children.includes("skills")) {
      const stat = await lstat(join(root, name, "skills"));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoreError("INVALID_WORKSPACE", "Skill proposal area must be a real directory.");
    }
    directories.add(name);
  }
  let inertInventory: ReturnType<typeof import("./workspace-validation-full.js").inspectLegacyRootInertInventory>;
  try {
    if (!full && await realpath(root) !== root) throw new Error("Noncanonical root.");
    inertInventory = full ? full.inspectLegacyRootInertInventory(root, { nativeUserGit })
      : { schema: "pkm.legacy-root-inert-inventory/v1", paths: [] };
  }
  catch { throw new CoreError("INVALID_WORKSPACE", "Legacy inert root metadata changed or is unsafe."); }
  for (const name of inertInventory.paths) {
    if (!name.includes("/") && name.endsWith(".postcommit")) directories.add(name);
  }
  const allowed = new Set([marker, rootAdoptionJournal, rootAdoptionCommit, ...(process.platform === "linux" ? [".pkm-next-writer-fenced.json"] : []),
    ...(storagePaths.layout === "separated" ? [storageLayoutMarker] : []),
    ".legacy-trash-import.json", ...directories, ...inertRootFiles, ...coreDatabaseFiles,
    ".pkm-paired-memory-backup.json", ".pkm-native-memory-adoption.json", ".pkm-native-memory-publication.json",
    ...codingProcessDatabaseFiles]);
  if (entries.some(name => !allowed.has(name))) throw new CoreError("INVALID_WORKSPACE", "Not an isolated next-server workspace. Legacy data directories must not be used.");
  if (entries.includes(".pkm-next-writer-fenced.json")) await assertLinuxRootOwnerMarker(root);
  if (entries.includes(".pkm-room-admission") && !options[privateRoomRecovery])
    throw new CoreError("RECOVERY_REQUIRED", "Private Room/Note admission requires explicit independent profile-pin recovery before workers start.");
  if (entries.includes(".pkm-room-admission")) {
    const stat = await lstat(join(root, ".pkm-room-admission"));
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new CoreError("INVALID_WORKSPACE", "Private Room/Note admission directory is unsafe.");
  }
  if (options[privateRoomRecovery] || inertInventory.chatroomArchives?.length && !entries.includes(rootAdoptionJournal)) {
    const admission = options[privateRoomRecovery], archives = inertInventory.chatroomArchives ?? [];
    if (!admission || admission.root !== root || archives.length !== admission.archives.length
      || archives.some(archive => !admission.archives.some(pin =>
        pin.roomId === archive.roomId && pin.sourceFingerprint === archive.sourceFingerprint)))
      throw new CoreError("INVALID_WORKSPACE", "Non-empty legacy Chatroom archives require an exact in-place adoption journal.");
  }
  for (const name of entries) {
    const stat = await lstat(join(root, name));
    if (stat.isSymbolicLink() || !(directories.has(name) ? stat.isDirectory() : stat.isFile())) throw new CoreError("INVALID_WORKSPACE", "Workspace entries must be regular files or knowledge/boards directories.");
  }
  if (storagePaths.layout === "separated") {
    for (const name of await readdir(storagePaths.serverData)) {
      if (name === "runtime-control") continue;
      const stat = await lstat(join(storagePaths.serverData, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
        throw new CoreError("INVALID_WORKSPACE", "Server databases must be private, owned regular files.");
    }
  }
  inspectWorkspaceRuntimeControls(root);
  if (entries.includes(managedRuntimeDirectory)) {
    const stat = await lstat(storagePaths.runtime);
    if (stat.isSymbolicLink() || !stat.isDirectory()
      || process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
      throw new CoreError("INVALID_WORKSPACE", "Managed runtime directory must be private, owned and real.");
  }
  for (const name of [".pkm-action-sources", ".pkm-action-builds"]) {
    if (!entries.includes(name)) continue;
    const stat = await lstat(join(root, name));
    if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()))
      throw new CoreError("INVALID_WORKSPACE", "Action build directories must be private and owned.");
  }
  for (const authorityDirectory of [".pkm-action-authority", ".pkm-plugin-authority"]) {
    if (!entries.includes(authorityDirectory)) continue;
    const directory = join(root, authorityDirectory), stat = await lstat(directory);
    const files = await readdir(directory);
    if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid())
      || files.some(name => name !== "host-authority.json"))
      throw new CoreError("INVALID_WORKSPACE", "Native authority directory is unsafe.");
    if (files.length) {
      const file = await lstat(join(directory, files[0]));
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 8192
        || process.platform !== "win32" && ((file.mode & 0o077) !== 0 || process.getuid && file.uid !== process.getuid()))
        throw new CoreError("INVALID_WORKSPACE", "Native authority record is unsafe.");
    }
  }
  if (entries.includes(".pkm")) {
    if (entries.includes(rootAdoptionJournal) && !entries.includes(rootAdoptionCommit) && options.adoptionToken === undefined) {
      throw new CoreError("RECOVERY_REQUIRED", "An interrupted in-place root adoption must be resumed before workers can start.");
    }
    if (options.adoptionToken === undefined || !entries.includes(rootAdoptionJournal) || entries.includes(rootAdoptionCommit)) {
      let database: DatabaseSync | undefined;
      try {
        const databasePath = coreDatabasePath(root);
        const stat = await lstat(databasePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unowned native database.");
        database = new DatabaseSync(databasePath, { readOnly: true });
        full!.assertLegacyKnowledgeSnapshotPrivacyRoot(database, root);
      } catch {
        throw new CoreError("INVALID_WORKSPACE", "Legacy data directories must not be used without explicit native private snapshot authority.");
      } finally { database?.close(); }
    }
  }
  if (entries.includes(".pkm-native-memory-adoption.json") || entries.includes(".pkm-paired-memory-backup.json")) {
    if (!entries.includes(".pkm-native-memory-publication.json"))
      throw new CoreError("RECOVERY_REQUIRED", "Paired native memory publication requires explicit durable reconciliation.");
    const publication = JSON.parse(await readFile(join(root, ".pkm-native-memory-publication.json"), "utf8"));
    if (publication.state !== "committed")
      throw new CoreError("RECOVERY_REQUIRED", "Unknown paired native memory publication must not start workers or replay effects.");
  }
  if (!entries.includes(marker)) {
    throw new CoreError("INVALID_WORKSPACE", "This is not an initialized next-server workspace. Legacy roots require separate read-only adoption inspection.");
  }
  const identity = parseWorkspaceIdentity(await readFile(join(root, marker), "utf8"));
  if (!entries.includes("notes")) throw new CoreError("INVALID_WORKSPACE", "Workspace notes directory is missing.");
  const canonicalRoot = await realpath(root);
  if (entries.includes(rootAdoptionCommit) && !entries.includes(rootAdoptionJournal))
    throw new CoreError("RECOVERY_REQUIRED", "Root adoption commit has no matching durable plan.");
  if (entries.includes(rootAdoptionJournal)) {
    try {
      const journalStat = await lstat(join(root, rootAdoptionJournal));
      if (!journalStat.isFile() || journalStat.isSymbolicLink() || journalStat.nlink !== 1 || journalStat.size > 16_777_216)
        throw new Error("Unsafe adoption journal.");
      const journal: unknown = JSON.parse(await readFile(join(root, rootAdoptionJournal), "utf8"));
      if (!journal || typeof journal !== "object") throw new Error("Malformed adoption journal.");
      const value = journal as Record<string, unknown>;
      const { journalSha256, ...body } = value;
      if (value.schema !== "pkm.legacy-root-adoption-journal/v1" || value.state !== "prepared"
        || value.sourceRoot !== canonicalRoot || value.workspaceId !== identity.id
        || typeof value.token !== "string" || !/^[0-9a-f-]{36}$/i.test(value.token)
        || typeof value.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint)
        || typeof journalSha256 !== "string" || !/^[a-f0-9]{64}$/.test(journalSha256)
        || jsonSha256(body) !== journalSha256
        || !value.rootIdentity || typeof value.rootIdentity !== "object"
        || !value.inventoryPlan || typeof value.inventoryPlan !== "object"
        || !Array.isArray(value.sourceEntries)) throw new Error("Invalid adoption journal binding.");
      const rootIdentity = value.rootIdentity as Record<string, unknown>;
      if (typeof rootIdentity.device !== "string" || typeof rootIdentity.inode !== "string"
        || !/^\d+$/.test(rootIdentity.device) || !/^\d+$/.test(rootIdentity.inode)) throw new Error("Invalid root identity.");
      const plan = full!.legacyImportPlanSchema.parse(value.inventoryPlan);
      if (plan.schema !== "pkm.legacy-import-plan/v1" || plan.ready !== true || plan.planSha256 !== value.planSha256)
        throw new Error("Invalid bound inventory plan.");
      const canonicalArchives = (archives: NonNullable<typeof inertInventory.chatroomArchives>) => JSON.stringify(
        archives.map(archive => ({
          roomId: archive.roomId,
          sourceFingerprint: archive.sourceFingerprint,
          files: [...archive.files].sort((left, right) => left.path.localeCompare(right.path)).map(file => ({
            path: file.path, sha256: file.sha256, size: file.size, mode: file.mode,
            dev: file.dev, ino: file.ino, mtimeMs: file.mtimeMs,
          })),
        })).sort((left, right) => left.roomId.localeCompare(right.roomId)),
      );
      if (canonicalArchives(inertInventory.chatroomArchives ?? []) !== canonicalArchives(plan.inPlaceChatroomArchives ?? []))
        throw new Error("Chatroom archive identity differs from its adoption inventory binding.");
      if (!entries.includes(rootAdoptionCommit) && entries.includes(".pkm")
        && (plan.inPlaceOnly !== true || typeof plan.inPlacePkmPrivacySha256 !== "string"
          || !/^[a-f0-9]{64}$/.test(plan.inPlacePkmPrivacySha256)
          || !value.snapshotAdmission || typeof value.snapshotAdmission !== "object"))
        throw new Error("Pending .pkm adoption has no exact privacy or host-authority binding.");
      if (value.planSha256 === undefined || typeof value.planSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.planSha256))
        throw new Error("Invalid import plan digest.");
      const rootStat = await lstat(root, { bigint: true });
      if (rootStat.dev.toString() !== rootIdentity.device || rootStat.ino.toString() !== rootIdentity.inode)
        throw new Error("Root identity changed.");
      if (entries.includes(rootAdoptionCommit)) {
        const commitStat = await lstat(join(root, rootAdoptionCommit));
        if (!commitStat.isFile() || commitStat.isSymbolicLink() || commitStat.nlink !== 1 || commitStat.size > 4096)
          throw new Error("Unsafe adoption commit.");
        const commit: unknown = JSON.parse(await readFile(join(root, rootAdoptionCommit), "utf8"));
        if (!commit || typeof commit !== "object") throw new Error("Malformed adoption commit.");
        const record = commit as Record<string, unknown>;
        const { receiptSha256, ...receiptBody } = record;
        if (record.schema !== "pkm.legacy-root-adoption-commit/v1" || record.token !== value.token
          || record.sourceRoot !== value.sourceRoot || record.workspaceId !== value.workspaceId
          || record.sourceFingerprint !== value.sourceFingerprint || record.journalSha256 !== journalSha256
          || typeof receiptSha256 !== "string" || !/^[a-f0-9]{64}$/.test(receiptSha256)
          || jsonSha256(receiptBody) !== receiptSha256) throw new Error("Adoption commit does not match its journal.");
      } else if (options.adoptionToken !== value.token) {
        throw new CoreError("RECOVERY_REQUIRED", "An interrupted in-place root adoption must be resumed before workers can start.");
      }
      if (plan.inPlaceUiBootstrap) {
        const actual = full!.inspectLegacyUiBootstrapCompatibility(canonicalRoot);
        if (!actual || !isDeepStrictEqual(actual, plan.inPlaceUiBootstrap))
          throw new Error("UI bootstrap compatibility differs from its prepared source.");
        if (entries.includes(coreDatabaseFile)) {
          const database = new DatabaseSync(coreDatabasePath(root), { readOnly: true });
          try { full!.verifyLegacyUiBootstrapCompatibility(database, String(value.workspaceId), plan.inPlaceUiBootstrap, !entries.includes(rootAdoptionCommit)); }
          finally { database.close(); }
        } else if (entries.includes(rootAdoptionCommit)) throw new Error("Committed UI compatibility has no native receipt database.");
      }
      const oldLayoutBoards = plan.entries.filter(entry => entry.kind === "board-backing" && entry.destination !== entry.source);
      if (oldLayoutBoards.length && value.todoProjection === undefined)
        throw new Error("Old-layout Todo authority has no bound native publication.");
      if (value.todoProjection !== undefined) {
        const projection = full!.validateLegacyTodoRootProjection(value.todoProjection);
        if (projection.boards.length !== oldLayoutBoards.length) throw new Error("Incomplete old-layout Todo publication coverage.");
        if (projection.boards.some(board => !plan.entries.some(entry => entry.kind === "board-backing"
          && entry.source === board.source && entry.destination === board.destination && entry.sha256 === board.sha256
          && entry.boardSlug === board.slug && entry.size === board.size)
          || !plan.entries.some(entry => entry.source === board.markdown && entry.sha256 === board.markdownSha256)))
          throw new Error("Todo projection differs from its source inventory.");
        full!.verifyLegacyTodoProjectionSource(canonicalRoot, projection, false);
        if (entries.includes(rootAdoptionCommit)) {
          const database = new DatabaseSync(coreDatabasePath(root), { readOnly: true });
          try { full!.verifyLegacyTodoProjectionReceipt(database, canonicalRoot, String(value.workspaceId), projection); }
          finally { database.close(); }
        }
      }
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError("RECOVERY_REQUIRED", "Root adoption journal is invalid or requires exact recovery.");
    }
  } else if (options.adoptionToken !== undefined) {
    throw new CoreError("RECOVERY_REQUIRED", "Adoption recovery token has no matching journal.");
  }
  return canonicalRoot;
}
