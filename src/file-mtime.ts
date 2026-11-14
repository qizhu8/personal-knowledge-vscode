import { execFileSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

export const mtimeNanosecondsPattern = /^-?(?:0|[1-9][0-9]{0,19})$/;

const program = [
  "import json, os, stat, sys",
  "for item in json.load(sys.stdin):",
  " path, ns = item",
  " fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))",
  " try:",
  "  before = os.fstat(fd)",
  "  if not stat.S_ISREG(before.st_mode): raise ValueError('not a regular file: ' + path)",
  "  os.utime(fd, ns=(before.st_atime_ns, int(ns)))",
  "  os.fsync(fd)",
  "  if os.fstat(fd).st_mtime_ns != int(ns): raise ValueError('filesystem did not preserve modification time: ' + path)",
  " finally: os.close(fd)",
].join("\n");

export function restoreFileMtimes(root: string, entries: Array<{ path: string; mtimeNs: string }>, python: string): void {
  if (!entries.length) return;
  if (!isAbsolute(root) || entries.some(({ path, mtimeNs }) =>
    !path || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")
    || !mtimeNanosecondsPattern.test(mtimeNs))) throw new Error("Invalid file modification time restoration request.");
  execFileSync(python, ["-c", program], {
    input: JSON.stringify(entries.map(({ path, mtimeNs }) => [join(root, ...path.split("/")), mtimeNs])),
    encoding: "utf8", stdio: ["pipe", "ignore", "pipe"], windowsHide: true,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  });
}
