import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";

export const storageLayoutMarker = ".pkm-storage-layout.json";
export const storageMigrationJournal = ".pkm-storage-migration.json";
export const serverDataDirectory = "server-data";
export const managedRuntimeDirectory = "runtime";
export const separatedStorageSchema = "pkm.workspace-storage/v1";

// These are durable workspace journals, not disposable runtime/cache databases.
export const coreDatabaseFile = "core.sqlite";
export const codingProcessDatabaseFile = "coding-process.sqlite";
export const coreDatabaseSidecarFiles = Object.freeze([
  `${coreDatabaseFile}-wal`, `${coreDatabaseFile}-shm`,
]);
export const coreDatabaseFiles = Object.freeze([
  coreDatabaseFile, ...coreDatabaseSidecarFiles,
]);
export const coreDatabaseAuxiliaryFiles = Object.freeze([
  ...coreDatabaseSidecarFiles, `${coreDatabaseFile}-journal`,
]);
export const codingProcessDatabaseFiles = Object.freeze([
  codingProcessDatabaseFile, `${codingProcessDatabaseFile}-wal`, `${codingProcessDatabaseFile}-shm`,
]);

export function workspaceStoragePaths(root: string) {
  if (lstatSync(join(root, storageMigrationJournal), { throwIfNoEntry: false }))
    throw new CoreError("RECOVERY_REQUIRED", "Resume the explicit offline storage migration before opening this workspace.");
  const marker = lstatSync(join(root, storageLayoutMarker), { throwIfNoEntry: false });
  let separated = false;
  if (marker) {
    if (!marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1 || marker.size > 4096)
      throw new CoreError("INVALID_WORKSPACE", "Storage layout marker must be an unlinked regular file.");
    try {
      const layout = JSON.parse(readFileSync(join(root, storageLayoutMarker), "utf8"));
      const workspace = JSON.parse(readFileSync(join(root, ".pkm-next-workspace"), "utf8"));
      if (layout.schema !== separatedStorageSchema || layout.layout !== "separated"
        || typeof layout.workspaceId !== "string" || layout.workspaceId !== workspace.id
        || Object.keys(layout).sort().join(",") !== "layout,schema,workspaceId") throw new Error("Invalid layout.");
      separated = true;
    } catch { throw new CoreError("INVALID_WORKSPACE", "Storage layout is invalid or belongs to another workspace."); }
    if ([...coreDatabaseFiles, `${coreDatabaseFile}-journal`, ...codingProcessDatabaseFiles, `${codingProcessDatabaseFile}-journal`]
      .some(name => lstatSync(join(root, name), { throwIfNoEntry: false })))
      throw new CoreError("RECOVERY_REQUIRED", "Both flat and separated database paths exist; explicit reconciliation is required.");
    const data = lstatSync(join(root, serverDataDirectory), { throwIfNoEntry: false });
    if (!data?.isDirectory() || data.isSymbolicLink()
      || process.platform !== "win32" && ((data.mode & 0o077) !== 0 || data.uid !== process.getuid?.()))
      throw new CoreError("INVALID_WORKSPACE", "Server data directory must be private, owned and real.");
    const allowed = new Set([...coreDatabaseFiles, `${coreDatabaseFile}-journal`,
      ...codingProcessDatabaseFiles, `${codingProcessDatabaseFile}-journal`, "runtime-control"]);
    if (readdirSync(join(root, serverDataDirectory)).some(name => !allowed.has(name)))
      throw new CoreError("INVALID_WORKSPACE", "Unknown server-data entries require explicit storage migration support.");
  } else if (lstatSync(join(root, serverDataDirectory), { throwIfNoEntry: false })) {
    throw new CoreError("RECOVERY_REQUIRED", "An unmarked server-data directory must be inspected; it is never adopted automatically.");
  }
  const serverData = separated ? join(root, serverDataDirectory) : root;
  if (separated && lstatSync(join(root, "runtime-control"), { throwIfNoEntry: false }))
    throw new CoreError("RECOVERY_REQUIRED", "Flat runtime controls coexist with separated server data; reconcile the old location explicitly.");
  const runtime = join(root, managedRuntimeDirectory);
  return {
    layout: separated ? "separated" as const : "flat" as const, serverData, runtime,
    runtimeControl: join(serverData, "runtime-control"),
    retrievalModels: join(runtime, "retrieval-models"),
    retrievalIndex: join(runtime, "indexes", "retrieval.sqlite"),
    freshNoteIndex: join(runtime, "indexes", "fresh-note.sqlite"),
  };
}
export function managedRuntimePath(root: string, ...parts: string[]): string {
  return join(workspaceStoragePaths(root).runtime, ...parts);
}
export function retrievalModelsPath(root: string): string {
  return workspaceStoragePaths(root).retrievalModels;
}
export function coreDatabasePath(root: string): string {
  return join(workspaceStoragePaths(root).serverData, coreDatabaseFile);
}
/** Resolve only the admitted fixed layout, never an arbitrary parent-name heuristic. */
export function workspaceRootForDatabase(databasePath: string): string {
  const path = resolve(databasePath), parent = dirname(path);
  if (basename(parent) === serverDataDirectory && lstatSync(join(dirname(parent), storageLayoutMarker), { throwIfNoEntry: false })) {
    const root = dirname(parent);
    if (coreDatabasePath(root) !== path && codingProcessDatabasePath(root) !== path)
      throw new CoreError("INVALID_WORKSPACE", "Database is not an admitted workspace journal.");
    return root;
  }
  return parent;
}
export function codingProcessDatabasePath(root: string): string {
  return join(workspaceStoragePaths(root).serverData, codingProcessDatabaseFile);
}
