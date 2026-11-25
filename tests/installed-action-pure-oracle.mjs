import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { originalPureActionOracleProgram } from "./original-mcp-action-pure-oracle.mjs";

const originalSha256 = "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27";
const members = [
  "resources/action_modules.py", "resources/action_runtime.py", "resources/action_authoring.py",
  "resources/action_components.py", "resources/action_run_store.py", "resources/action_recovery.py",
  "resources/action_monitoring.py", "resources/recipe_runtime.py", "resources/recipe_health.py",
  "resources/action_components.js", "dist/components/action-components.js",
];
const noAuthority = `
import sys
def no_authority(event,args):
 if event in {"subprocess.Popen","os.system","os.exec","os.posix_spawn","os.fork","os.forkpty",
              "socket.connect","socket.bind","socket.getaddrinfo","socket.gethostbyname","socket.sendto"}:
  raise PermissionError("Closed Original oracle grants no process or network authority")
sys.addaudithook(no_authority)
`;

/** Reuses the source test's actual closed handlers, not an installed/native substitute. */
export async function createInstalledActionPureOracle({ directory, legacyVsix, python }) {
  const stat = await lstat(directory);
  assert(isAbsolute(directory) && resolve(directory) === directory && await realpath(directory) === directory
    && stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077),
  "A canonical private disposable oracle directory is required.");
  assert(isAbsolute(python ?? "") && isAbsolute(legacyVsix ?? ""), "Explicit Original archive and Python paths are required.");
  const archiveStat = await lstat(legacyVsix);
  assert(archiveStat.isFile() && !archiveStat.isSymbolicLink() && archiveStat.size < 256 * 1024 * 1024);
  const archive = await readFile(legacyVsix);
  assert.equal(createHash("sha256").update(archive).digest("hex"), originalSha256, "Actual sealed Original22 is mandatory.");
  const root = join(directory, "action-pure-original22-oracle");
  await mkdir(root, { mode: 0o700 });
  const home = join(root, "home"), scratch = join(root, "scratch");
  await mkdir(home, { mode: 0o700 }); await mkdir(scratch, { mode: 0o700 });
  const env = {
    PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home,
    TMPDIR: scratch, TMP: scratch, TEMP: scratch, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
    XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home, XDG_STATE_HOME: home,
    APPDATA: home, LOCALAPPDATA: home,
    HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1",
  };
  execFileSync(python, ["-I", "-B", "-c", `
import io,json,stat,sys,zipfile
from pathlib import Path,PurePosixPath
root=Path(sys.argv[1]).resolve();total=0
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
 metadata=json.loads(archive.read("extension/package.json"))
 if (metadata["publisher"],metadata["name"],metadata["version"])!=("Uone","personal-knowledge","4.0.22"):
  raise ValueError("Unexpected Original release")
 for member in sys.argv[2:]:
  path=PurePosixPath(member);name="extension/"+member
  if path.is_absolute() or ".." in path.parts or "\\\\" in member or ":" in member or archive.namelist().count(name)!=1:
   raise ValueError("Unsafe/missing Original member")
  info=archive.getinfo(name);total+=info.file_size
  if info.is_dir() or stat.S_ISLNK(info.external_attr>>16) or info.file_size>2*1024*1024 or total>8*1024*1024:
   raise ValueError("Unbounded/non-file Original member")
  target=root.joinpath(*path.parts);target.resolve().relative_to(root)
  target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  with target.open("xb") as out:out.write(archive.read(info))
`, root, ...members], { input: archive, cwd: root, env, timeout: 30000, maxBuffer: 65536 });
  return Object.freeze({
    root, originalPackageSha256: originalSha256,
    invoke(cases) {
      return JSON.parse(execFileSync(python, ["-I", "-B", "-c", noAuthority + originalPureActionOracleProgram,
        join(root, "resources")], {
        input: JSON.stringify(cases), encoding: "utf8", cwd: root, env, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      }));
    },
  });
}
