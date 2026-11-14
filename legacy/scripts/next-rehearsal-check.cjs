#!/usr/bin/env node
// Checks only the explicitly tested offline import and read-only HTTP profile.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

function check(python, probeParent) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || major === 22 && minor < 18) throw new Error("Node >=22.18.0 is required");
  if (!["linux", "win32"].includes(process.platform)) throw new Error("Linux or Windows is required");
  if (!python || !path.isAbsolute(python)) throw new Error("An absolute Python executable path is required");
  const probe = spawnSync(python, ["-I", "-B", "-c", [
    "import ctypes, sys, json, pathlib, hashlib, re, datetime, sqlite3",
    "assert sys.version_info >= (3, 10), 'Python >=3.10 required'",
    "assert hasattr(pathlib.PurePath, 'is_relative_to'), 'pathlib.is_relative_to required'",
    "assert hasattr(ctypes.CDLL(None), 'renameat2') if sys.platform.startswith('linux') else hasattr(ctypes.WinDLL('kernel32', use_last_error=True), 'MoveFileExW')",
    "print(sys.version.split()[0])",
  ].join("\n")], { encoding: "utf8", timeout: 5000 });
  if (probe.error || probe.status !== 0) throw new Error(`Python >=3.10, standard library or ctypes no-replace API unavailable: ${probe.error?.message || probe.stderr}`);
  const defaultPython = process.platform === "win32" ? "python" : "python3";
  const defaultProbe = spawnSync(defaultPython, ["-I", "-B", "-c", "import ctypes, sys, json, pathlib, hashlib, re, datetime, sqlite3; assert sys.version_info >= (3, 10); print(sys.executable)"], {
    encoding: "utf8", timeout: 5000,
  });
  if (defaultProbe.error || defaultProbe.status !== 0)
    throw new Error(`PATH ${defaultPython} >=3.10 with the standard library is required for compatibility subprocesses: ${defaultProbe.error?.message || defaultProbe.stderr}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));
  if (!(manifest.schema === "pkm.next-rehearsal-runtime/v1" && manifest.experimental === true)
      && manifest.schema !== "pkm.next-payload/v1") throw new Error("Invalid next-server payload manifest");
  if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) throw new Error("Invalid runtime inventory");
  for (const name of ["check.cjs", "server/dist/cli.js", "server/dist/legacy-import-cli.js",
    "server/dist/storage-worker.js", "server/compat/legacy-note-inventory.py", "resources/note_inventory.py",
    "resources/action_components.js",
    "server/node_modules/zod/package.json", "server/browser/integration.mjs"]) {
    if (!manifest.files[name]) throw new Error(`Missing runtime inventory entry: ${name}`);
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (!name || name.split("/").some(part => !part || part === "." || part === ".." || part.includes("\\"))) throw new Error("Unsafe runtime manifest path");
    const file = path.join(__dirname, ...name.split("/"));
    let bytes;
    try {
      if (!fs.lstatSync(file).isFile()) throw new Error("not a regular file");
      bytes = fs.readFileSync(file);
    } catch { throw new Error(`Missing runtime dependency: ${name}`); }
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error(`Runtime digest mismatch: ${name}`);
  }
  require("node:sqlite");
  console.log(`Next-server payload and interpreter prerequisites verified (Node ${process.versions.node}, selected Python ${probe.stdout.trim()}, PATH Python ${defaultProbe.stdout.trim()}).`);
  if (probeParent) {
    if (process.platform !== "linux") throw new Error("Filesystem probe is Linux-only");
    if (!path.isAbsolute(probeParent) || fs.realpathSync(probeParent) !== path.resolve(probeParent)
      || !fs.lstatSync(probeParent).isDirectory()) throw new Error("Probe parent must be an existing absolute real directory without symlinks");
    const scratch = fs.mkdtempSync(path.join(probeParent, ".pkm-next-probe-"));
    try {
      const code = [
        "import ctypes, errno, os, sys",
        "root = sys.argv[1]",
        "libc = ctypes.CDLL(None, use_errno=True)",
        "rename = libc.renameat2",
        "rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]",
        "rename.restype = ctypes.c_int",
        "def move(a, b):",
        " return rename(-100, os.fsencode(os.path.join(root, a)), -100, os.fsencode(os.path.join(root, b)), 1)",
        "os.mkdir(os.path.join(root, 'first'))",
        "if move('first', 'published'): raise OSError(ctypes.get_errno(), 'renameat2 publication failed')",
        "os.mkdir(os.path.join(root, 'second'))",
        "if move('second', 'published') != -1 or ctypes.get_errno() != errno.EEXIST: raise RuntimeError('renameat2 collision did not refuse replacement')",
        "fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)",
        "try: os.fsync(fd)",
        "finally: os.close(fd)",
      ].join("\n");
      const result = spawnSync(python, ["-I", "-B", "-c", code, scratch], { encoding: "utf8", timeout: 5000 });
      if (result.error || result.status !== 0) throw new Error(`Linux filesystem publication probe failed: ${result.error?.message || result.stderr}`);
      console.log("Disposable target-parent filesystem probe passed: no-replace publication, collision and directory fsync.");
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  } else console.log("Filesystem no-replace behavior and directory fsync are NOT checked; use --probe-parent on a disposable directory.");
  console.log("Free space, source quiescence, real data compatibility and recovery authority are NOT checked.");
}

try {
  if (process.argv.length !== 3 && !(process.argv.length === 5 && process.argv[3] === "--probe-parent"))
    throw new Error("Usage: node check.cjs /absolute/python [--probe-parent /absolute/disposable-directory]");
  check(process.argv[2], process.argv[4]);
} catch (error) {
  console.error(`Rehearsal prerequisite failure: ${error.message}`);
  process.exitCode = 1;
}
