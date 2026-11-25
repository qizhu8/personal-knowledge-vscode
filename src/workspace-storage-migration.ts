import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { acquireLinuxRootWriterFence } from "./linux-root-writer-fence.js";
import { validateWorkspace, parseWorkspaceIdentity, marker, storageMigrationGitInspection } from "./workspace-validation.js";
import { protectWorkspaceGit, workspaceGitIgnoreBlock } from "./workspace-git-protection.js";
import { acquireWorkspaceRuntimeControlSnapshot } from "./workspace-runtime-control.js";
import { codingProcessDatabaseFile, coreDatabaseFile, coreDatabaseFiles, codingProcessDatabaseFiles,
  managedRuntimeDirectory, separatedStorageSchema, serverDataDirectory, storageLayoutMarker,
  storageMigrationJournal, workspaceStoragePaths } from "./workspace-storage-paths.js";

interface MigrationFile { name: string; sha256: string; size: number }
type MigrationDirectory = ({ source: "packages/retrieval-models"; destination: "runtime/retrieval-models" }
  | { source: "runtime-control"; destination: "server-data/runtime-control" }) & { sha256: string };
interface MigrationJournal {
  schema: "pkm.workspace-storage-migration/v1";
  workspaceId: string;
  rootPin: string;
  files: MigrationFile[];
  directories?: MigrationDirectory[];
}
const fail = (message: string): never => { throw new CoreError("RECOVERY_REQUIRED", message); };
const migrationBlockers = [".pkm-next-root-adoption.json", ".pkm-next-original-mcp.json",
  ".pkm-next-original-mcp.rollback.json", ".pkm", ".pkm-room-admission",
  ".pkm-native-memory-adoption.json", ".pkm-native-memory-publication.json", ".pkm-paired-memory-backup.json"];
function exists(path: string) { return lstatSync(path, { throwIfNoEntry: false }); }
function privateDirectory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    fail("Storage migration requires private, owned real directories.");
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeControl(path: string, value: unknown) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
}
function identity(root: string) {
  if (resolve(root) !== root || realpathSync(root) !== root) fail("Storage migration requires a canonical root.");
  privateDirectory(root);
  const stat = lstatSync(root, { bigint: true });
  const control = lstatSync(join(root, marker));
  if (!control.isFile() || control.isSymbolicLink() || control.nlink !== 1 || control.size > 4096)
    fail("Workspace identity is unsafe.");
  return { workspaceId: parseWorkspaceIdentity(readFileSync(join(root, marker), "utf8")).id,
    rootPin: `${stat.dev}:${stat.ino}` };
}
function filePin(path: string): { sha256: string; size: number } {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid?.())
    fail("Migration database must be an owned unlinked regular file.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd), digest = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0, count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) !== 0) { digest.update(buffer.subarray(0, count)); size += count; }
    const after = lstatSync(path), final = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || size !== after.size)
      fail("Database changed during migration inspection.");
    if (final.size !== after.size || final.mtimeMs !== after.mtimeMs || final.ctimeMs !== after.ctimeMs || size !== after.size)
      fail("Database changed during migration inspection.");
    return { sha256: digest.digest("hex"), size };
  } finally { closeSync(fd); }
}
function directoryDigest(directory: string): string {
  const digest = createHash("sha256");
  let entries = 0;
  const visit = (path: string, relative: string, depth: number) => {
    if (++entries > 100_000 || depth > 64) fail("Model relocation inventory exceeds its bounded inspection limits.");
    const before = lstatSync(path);
    if (before.isSymbolicLink() || before.uid !== process.getuid?.())
      fail("Model relocation does not follow links or foreign-owned paths.");
    if (before.isDirectory()) {
      digest.update(JSON.stringify([relative, "directory", before.mode]));
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`, depth + 1);
      const after = lstatSync(path);
      if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
        fail("Model directory changed during relocation inspection.");
    } else {
      const file = filePin(path);
      digest.update(JSON.stringify([relative, "file", before.mode, file]));
    }
  };
  visit(directory, "", 0);
  return digest.digest("hex");
}
function verifyFile(path: string, expected: MigrationFile) {
  const actual = filePin(path);
  if (actual.sha256 !== expected.sha256 || actual.size !== expected.size)
    fail("Migration database bytes changed. Preserve both locations and reconcile explicitly.");
}
function assertNativeLayout(root: string) {
  if (migrationBlockers.some(name => exists(join(root, name))))
    fail("Adopted, original-custody, private snapshot and paired-memory roots retain fixed legacy path contracts; storage relocation is not admitted.");
}
export function inspectWorkspaceStorage(directory: string) {
  const root = resolve(directory), binding = identity(root);
  if (exists(join(root, storageMigrationJournal)))
    return { ...binding, layout: "migration-pending" as const, migrationRequired: true };
  const paths = workspaceStoragePaths(root);
  return { ...binding, ...paths, migrationRequired: paths.layout === "flat",
    migrationBlockers: migrationBlockers.filter(name => exists(join(root, name))) };
}

/** Offline, resumable physical relocation. No schema, receipt or transaction domain is split. */
export async function migrateWorkspaceStorage(directory: string, options: { protectUserGit?: boolean } = {}) {
  if (process.platform !== "linux") fail("Offline storage relocation currently requires the real Linux exclusive writer fence.");
  const root = resolve(directory), fence = await acquireLinuxRootWriterFence(root, 250);
  let controlLease: Awaited<ReturnType<typeof acquireWorkspaceRuntimeControlSnapshot>> | undefined;
  try {
    fence.assertHeld();
    const binding = identity(root);
    assertNativeLayout(root);
    const ignore = exists(join(root, ".gitignore"));
    if (exists(join(root, ".git")) || ignore) {
      const generatedIgnore = ignore?.isFile() && !ignore.isSymbolicLink()
        && ignore.size === Buffer.byteLength(workspaceGitIgnoreBlock)
        && readFileSync(join(root, ".gitignore"), "utf8") === workspaceGitIgnoreBlock;
      if (!options.protectUserGit && !exists(join(root, storageLayoutMarker))
        && !exists(join(root, storageMigrationJournal)) && (exists(join(root, ".git")) || !generatedIgnore))
        fail("Existing user Git/.gitignore requires explicit storage-migrate --protect-user-git consent. User ignore bytes and repository history are never overwritten.");
    }
    if (options.protectUserGit || !exists(join(root, ".gitignore"))) protectWorkspaceGit(root);
    const journalPath = join(root, storageMigrationJournal), data = join(root, serverDataDirectory);
    let journal: MigrationJournal;
    if (exists(journalPath)) {
      const stat = lstatSync(journalPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192
        || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) fail("Storage migration journal is unsafe.");
      journal = JSON.parse(readFileSync(journalPath, "utf8")) as MigrationJournal;
      if (journal.schema !== "pkm.workspace-storage-migration/v1" || journal.workspaceId !== binding.workspaceId
        || journal.rootPin !== binding.rootPin || !Array.isArray(journal.files)
        || journal.files.length > 2 || new Set(journal.files.map(file => file.name)).size !== journal.files.length
        || journal.files.some(file => ![coreDatabaseFile, codingProcessDatabaseFile].includes(file.name)
          || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0)
        || journal.directories !== undefined && (!Array.isArray(journal.directories) || journal.directories.length > 1
          || journal.directories.some(directory => !(
            directory.source === "packages/retrieval-models" && directory.destination === "runtime/retrieval-models"
            || directory.source === "runtime-control" && directory.destination === "server-data/runtime-control")
            || !/^[a-f0-9]{64}$/.test(directory.sha256))))
        fail("Storage migration journal does not match this root.");
      if (!exists(data)) mkdirSync(data, { mode: 0o700 });
      if (journal.directories?.some(directory => directory.source === "runtime-control")) {
        const source = join(root, "runtime-control"), destination = join(data, "runtime-control");
        if (exists(source) && exists(destination)) fail("Both durable control locations exist; reconcile explicitly.");
        controlLease = await acquireWorkspaceRuntimeControlSnapshot(root, exists(source) ? source : destination);
      }
    } else {
      await validateWorkspace(root, { [storageMigrationGitInspection]: true });
      if (workspaceStoragePaths(root).layout === "separated") return inspectWorkspaceStorage(root);
      if (exists(data)) fail("Existing server-data is never merged or overwritten.");
      const directories: MigrationDirectory[] = [];
      if (exists(join(root, "runtime-control"))) {
        controlLease = await acquireWorkspaceRuntimeControlSnapshot(root);
        directories.push({ source: "runtime-control", destination: "server-data/runtime-control",
          sha256: directoryDigest(join(root, "runtime-control")) });
      }
      if (exists(join(root, "packages", "retrieval-models"))) {
        privateDirectory(join(root, "packages"));
        if (exists(join(root, managedRuntimeDirectory))) privateDirectory(join(root, managedRuntimeDirectory));
        if (exists(join(root, "runtime", "retrieval-models"))) fail("Both model locations exist; migration will not merge or overwrite them.");
        directories.push({ source: "packages/retrieval-models", destination: "runtime/retrieval-models",
          sha256: directoryDigest(join(root, "packages", "retrieval-models")) });
      }
      const files: MigrationFile[] = [];
      for (const name of [coreDatabaseFile, codingProcessDatabaseFile]) {
        const path = join(root, name);
        if (!exists(path)) continue;
        filePin(path);
        const db = new DatabaseSync(path);
        try {
          db.exec("PRAGMA busy_timeout=0");
          const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
          if (Number(checkpoint?.busy ?? 0) !== 0) fail("A database reader/writer blocks the offline migration checkpoint.");
          if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
            fail("Database integrity check failed; no relocation was performed.");
          if (db.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode !== "delete")
            fail("A live database connection blocks offline relocation.");
        } finally { db.close(); }
        files.push({ name, ...filePin(path) });
      }
      journal = { schema: "pkm.workspace-storage-migration/v1", ...binding, files, directories };
      writeControl(journalPath, journal);
      syncDirectory(root);
      mkdirSync(data, { mode: 0o700 });
    }
    privateDirectory(data);
    const allowed = new Set([...journal.files.map(file => file.name),
      ...(journal.directories?.some(directory => directory.source === "runtime-control") ? ["runtime-control"] : [])]);
    if (readdirSync(data).some(name => !allowed.has(name))) fail("Unexpected server-data files require reconciliation.");
    for (const file of journal.files) {
      fence.assertHeld();
      const source = join(root, file.name), destination = join(data, file.name);
      if (exists(source) && exists(destination)) fail("Both migration paths contain a database; neither will be overwritten.");
      if (exists(source)) {
        verifyFile(source, file);
        fence.renameNoReplaceWithinRoot(source, destination);
        syncDirectory(data);
        syncDirectory(root);
      } else if (!exists(destination)) fail("A migration database is missing from both locations.");
      verifyFile(destination, file);
      chmodSync(destination, 0o600);
    }
    for (const directory of journal.directories ?? []) {
      const source = join(root, directory.source), destination = join(root, directory.destination);
      const parent = dirname(destination);
      if (!exists(parent)) mkdirSync(parent, { mode: 0o700 });
      privateDirectory(parent);
      if (exists(source) && exists(destination)) fail("Both model locations exist; migration will not merge or overwrite them.");
      if (exists(source)) {
        privateDirectory(dirname(source));
        if (directoryDigest(source) !== directory.sha256) fail("Model bytes changed before relocation.");
        fence.renameNoReplaceWithinRoot(source, destination);
        syncDirectory(dirname(source));
        syncDirectory(parent);
        syncDirectory(root);
      } else if (!exists(destination)) fail("Migration model directory is missing from both locations.");
      if (directoryDigest(destination) !== directory.sha256) fail("Model bytes changed during relocation.");
    }
    if ([...coreDatabaseFiles.slice(1), `${coreDatabaseFile}-journal`,
      ...codingProcessDatabaseFiles.slice(1), `${codingProcessDatabaseFile}-journal`]
      .some(name => exists(join(root, name)))) fail("Unexpected SQLite sidecars appeared; keep the journal and reconcile before resuming.");
    const layout = { schema: separatedStorageSchema, workspaceId: binding.workspaceId, layout: "separated" };
    const layoutPath = join(root, storageLayoutMarker);
    if (exists(layoutPath)) {
      const stat = lstatSync(layoutPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096
        || JSON.stringify(JSON.parse(readFileSync(layoutPath, "utf8"))) !== JSON.stringify(layout))
        fail("An interrupted migration has a conflicting layout marker.");
    } else writeControl(layoutPath, layout);
    syncDirectory(root);
    unlinkSync(journalPath);
    syncDirectory(root);
    await validateWorkspace(root);
    return inspectWorkspaceStorage(root);
  } finally {
    try { await controlLease?.release(); } finally { await fence.release(); }
  }
}

/** Call only after closing the backend; the same real writer fence prevents online deletion. */
export async function resetFreshNoteIndex(directory: string) {
  const root = resolve(directory), fence = await acquireLinuxRootWriterFence(root, 250);
  try {
    await validateWorkspace(root);
    const paths = workspaceStoragePaths(root);
    if (paths.layout !== "separated") fail("Flat-layout derived tables share the durable database and cannot be removed as runtime files.");
    const runtime = join(root, managedRuntimeDirectory), indexes = join(runtime, "indexes");
    for (const path of [runtime, indexes]) {
      if (!exists(path)) return { removed: [] as string[] };
      privateDirectory(path);
    }
    const names = ["fresh-note.sqlite", "fresh-note.sqlite-wal", "fresh-note.sqlite-shm", "fresh-note.sqlite-journal"];
    for (const name of names) if (exists(join(indexes, name))) filePin(join(indexes, name));
    const removed: string[] = [];
    for (const name of names) if (exists(join(indexes, name))) {
      fence.assertHeld(); unlinkSync(join(indexes, name)); removed.push(name);
    }
    syncDirectory(indexes);
    return { removed };
  } finally { await fence.release(); }
}
