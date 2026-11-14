import { execFile, execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const renameNoReplaceProgram = [
  "import ctypes, os, sys",
  "source, destination = sys.argv[1:3]",
  "if sys.platform == 'win32':",
  " import ntpath",
  " from ctypes import wintypes",
  " def windows_path(path):",
  "  path = ntpath.normpath(path)",
  "  if path.startswith('\\\\\\\\?\\\\'): return path",
  "  if path.startswith('\\\\\\\\'): return '\\\\\\\\?\\\\UNC\\\\' + path[2:]",
  "  return '\\\\\\\\?\\\\' + path",
  " kernel = ctypes.WinDLL('kernel32', use_last_error=True)",
  " move = kernel.MoveFileExW",
  " move.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]",
  " move.restype = wintypes.BOOL",
  " if not move(windows_path(source), windows_path(destination), 8):",
  "  error = ctypes.get_last_error()",
  "  print('winerror=' + str(error), file=sys.stderr)",
  "  sys.exit(17 if error in (80, 183) else 18 if error == 17 else 79)",
  "elif sys.platform.startswith('linux'):",
  " libc = ctypes.CDLL(None, use_errno=True)",
  " try: move = libc.renameat2",
  " except AttributeError: sys.exit(78)",
  " move.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]",
  " move.restype = ctypes.c_int",
  " if move(-100, os.fsencode(source), -100, os.fsencode(destination), 1):",
  "  error = ctypes.get_errno()",
  "  print('errno=' + str(error), file=sys.stderr)",
  "  sys.exit(error if 0 < error < 256 else 79)",
  "else:",
  " sys.exit(77)",
].join("\n");

export class RenameNoReplaceError extends Error {
  constructor(readonly code: "DESTINATION_EXISTS" | "UNAVAILABLE" | "MOVE_FAILED", message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export function noReplacePlatformSupported(platform: string): boolean {
  return platform === "linux" || platform === "win32";
}

function argumentsFor(source: string, destination: string) {
  if (!noReplacePlatformSupported(process.platform)) {
    throw new RenameNoReplaceError("UNAVAILABLE", "Atomic no-replace moves require Linux or Windows.");
  }
  if (!isAbsolute(source) || !isAbsolute(destination) || source === destination) {
    throw new TypeError("Atomic no-replace moves require distinct absolute source and destination paths.");
  }
  return ["-c", renameNoReplaceProgram, source, destination];
}

function failure(error: unknown): never {
  if (!(error instanceof Error)) throw error;
  const status = "status" in error && typeof error.status === "number" ? error.status : "code" in error ? error.code : undefined;
  const diagnostic = "stderr" in error && error.stderr != null ? String(error.stderr).trim() : "";
  if (status === 17) {
    throw new RenameNoReplaceError("DESTINATION_EXISTS", "Destination already exists; no replacement was attempted.", { cause: error });
  }
  if ([77, 78, 38, 95, "ENOENT"].some(code => code === status)) {
    throw new RenameNoReplaceError("UNAVAILABLE", "Atomic no-replace OS API or Python executable is unavailable; no fallback was attempted.", { cause: error });
  }
  throw new RenameNoReplaceError("MOVE_FAILED",
    `Atomic no-replace move failed${diagnostic ? ` (${diagnostic})` : ""}; preserve the source/intent for reconciliation.`,
    { cause: error });
}

const environment = () => ({ ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" });
const defaultPython = () => process.platform === "win32" ? "python" : "python3";

// Windows uses MOVEFILE_WRITE_THROUGH only: no REPLACE_EXISTING or COPY_ALLOWED.
// Linux uses RENAME_NOREPLACE. Both fail rather than copy across volumes.
export function renameNoReplaceSync(source: string, destination: string, pythonExecutable = defaultPython(), keepAlive?: number): void {
  const args = argumentsFor(source, destination);
  try {
    execFileSync(pythonExecutable, args, {
      encoding: "utf8", stdio: keepAlive === undefined ? ["ignore", "ignore", "pipe"] : ["ignore", "ignore", "pipe", keepAlive], timeout: 5000,
      windowsHide: true, env: environment(),
    });
  } catch (error) { failure(error); }
}

export async function renameNoReplace(source: string, destination: string, pythonExecutable = defaultPython()): Promise<void> {
  const args = argumentsFor(source, destination);
  try {
    await exec(pythonExecutable, args, { encoding: "utf8", timeout: 5000, windowsHide: true, env: environment() });
  } catch (error) { failure(error); }
}
