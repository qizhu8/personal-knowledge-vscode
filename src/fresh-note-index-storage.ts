import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { workspaceStoragePaths } from "./workspace-storage-paths.js";

/** Flat compatibility keeps its original transaction connection; separated caches are rebuildable. */
export function openFreshNoteIndex(root: string, core: DatabaseSync) {
  const paths = workspaceStoragePaths(root);
  if (paths.layout === "flat") return { database: core, separate: false, assertHeld() {}, close() {} };
  const directories = [paths.runtime, join(paths.runtime, "indexes")];
  for (const directory of directories) {
    let stat = lstatSync(directory, { throwIfNoEntry: false });
    if (!stat) { mkdirSync(directory, { mode: 0o700 }); stat = lstatSync(directory); }
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory
      || process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
      throw new CoreError("INVALID_WORKSPACE", "Fresh Note cache parents must be private, owned real directories.");
  }
  const path = paths.freshNoteIndex;
  if (!lstatSync(path, { throwIfNoEntry: false }))
    closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600));
  const pin = (file: string) => {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || (file === path ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())
      || process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
      throw new CoreError("INVALID_WORKSPACE", "Fresh Note cache paths must remain private and owned.");
    return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}`;
  };
  const before = [pin(paths.runtime), pin(dirname(path)), pin(path)];
  const assertHeld = () => {
    if ([pin(paths.runtime), pin(dirname(path)), pin(path)].some((value, index) => value !== before[index]))
      throw new CoreError("CONFLICT", "The Fresh Note derived database path changed.");
  };
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    assertHeld();
  } catch (error) { database.close(); throw error; }
  return { database, separate: true, assertHeld, close() { database.close(); } };
}
