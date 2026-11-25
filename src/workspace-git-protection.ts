import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";

export const workspaceGitIgnoreBlock = [
  "# BEGIN PKM separated private server state",
  "/server-data/", "/runtime/", "/runtime-control/", "/core.sqlite", "/core.sqlite-*",
  "/coding-process.sqlite", "/coding-process.sqlite-*", "/.pkm-*",
  "# END PKM separated private server state", "",
].join("\n");
const probes = ["server-data/.pkm-boundary-probe", "runtime/.pkm-boundary-probe", "core.sqlite",
  "runtime-control/.pkm-boundary-probe",
  "core.sqlite-wal", "coding-process.sqlite", "coding-process.sqlite-wal",
  ".pkm-storage-layout.json", ".pkm-storage-migration.json", ".pkm-next-workspace",
  ".pkm-action-authority/host-authority.json"];
const fail = (message: string): never => { throw new CoreError("RECOVERY_REQUIRED", message); };
function git(root: string, args: string[], input?: string) {
  const result = spawnSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    encoding: "utf8", input, timeout: 5000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" },
  });
  if (result.error || result.signal || ![0, 1].includes(result.status ?? -1))
    fail("The user Git repository could not be inspected without side effects.");
  return result;
}
function assertUntracked(root: string) {
  const result = git(root, ["ls-files", "-z", "--cached", "--", "server-data", "runtime", "runtime-control",
    ".pkm-*", "core.sqlite", "core.sqlite-*", "coding-process.sqlite", "coding-process.sqlite-*"]);
  if (result.status !== 0 || result.stdout.split("\0").some(path => path && path !== ".pkm-github-sync.json"))
    fail("Private server/runtime paths are already tracked by user Git. Explicitly untrack them and review remote history; migration never rewrites the index or history.");
}
export function assertWorkspaceGitProtection(root: string): void {
  const metadata = lstatSync(join(root, ".git"), { throwIfNoEntry: false });
  if (!metadata) return;
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.())
    fail("Native separated storage requires a real owned user Git directory, not a worktree pointer or link.");
  assertUntracked(root);
  const result = git(root, ["check-ignore", "--no-index", "-z", "--stdin"], `${probes.join("\0")}\0`);
  const ignored = new Set(result.stdout.split("\0").filter(Boolean));
  if (result.status !== 0 || probes.some(path => !ignored.has(path)))
    fail("User Git must exclude /server-data/, /runtime/ and private PKM controls. Run storage-migrate --protect-user-git after reviewing the additive ignore block.");
}
/** Explicit initialization/migration only. Existing user bytes remain an exact prefix. */
export function protectWorkspaceGit(root: string): void {
  const metadata = lstatSync(join(root, ".git"), { throwIfNoEntry: false });
  if (metadata) {
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.())
      fail("Git protection does not follow user Git links or worktree pointers.");
    assertUntracked(root);
  }
  const path = join(root, ".gitignore"), before = lstatSync(path, { throwIfNoEntry: false });
  if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.uid !== process.getuid?.() || before.size > 65_536))
    fail("Existing user .gitignore must be an owned bounded regular file.");
  const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const opened = fstatSync(fd);
    if (before && (before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size))
      fail("User .gitignore changed during protection inspection.");
    const bytes = readFileSync(fd);
    let appended = 0;
    if (!bytes.toString("utf8").includes(workspaceGitIgnoreBlock)) {
      const suffix = `${bytes.length && bytes[bytes.length - 1] !== 10 ? "\n" : ""}${workspaceGitIgnoreBlock}`;
      appended = Buffer.byteLength(suffix);
      writeFileSync(fd, suffix);
      fsyncSync(fd);
    }
    const after = lstatSync(path), prefix = Buffer.alloc(bytes.length);
    readSync(fd, prefix, 0, prefix.length, 0);
    if (after.dev !== opened.dev || after.ino !== opened.ino
      || after.size !== bytes.length + appended || !prefix.equals(bytes))
      fail("User .gitignore changed during additive protection.");
  } finally { closeSync(fd); }
  assertWorkspaceGitProtection(root);
}
