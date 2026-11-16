import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const releaseSha256 = "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27";
const fixtures = new Map();
const members = [
  "resources/action_modules.py", "resources/action_runtime.py", "resources/action_authoring.py",
  "resources/action_components.py", "resources/action_run_store.py", "resources/action_recovery.py",
  "resources/action_monitoring.py", "resources/recipe_runtime.py", "resources/recipe_health.py",
  "resources/action_components.js", "dist/components/action-components.js",
];
const noAuthority = `
import sys
def fixture_audit(event, arguments):
 if event in {"subprocess.Popen","os.system","os.exec","os.posix_spawn","os.fork","os.forkpty",
              "socket.connect","socket.bind","socket.getaddrinfo","socket.gethostbyname","socket.gethostbyaddr","socket.sendto"}:
  raise PermissionError("Original Action fixture grants no process or network authority")
sys.addaudithook(fixture_audit)
`;

export function originalActionFixture(parent) {
  const canonical = realpathSync(parent);
  const local = relative(realpathSync(join(root, "tests")), canonical);
  if (canonical !== resolve(parent) || !local || isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) {
    throw new Error("Original Action oracle requires an owned canonical workspace under tests/.");
  }
  if (fixtures.has(canonical)) return fixtures.get(canonical);
  const identity = process.env.PKM_ACTION_SOURCE_IDENTITY ?? "compiler-capture-v1";
  if (!["compiler-capture-v1", "frozen-original-v2"].includes(identity)) {
    throw new Error("Unknown original Action oracle generation.");
  }
  const directory = mkdtempSync(join(canonical, ".original-action-release-"));
  const home = join(directory, "home"), temporary = join(directory, "scratch");
  const env = {
    PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
    XDG_RUNTIME_DIR: join(home, "run"), TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
    HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1",
  };
  for (const path of [home, temporary, env.APPDATA, env.LOCALAPPDATA,
    env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME, env.XDG_RUNTIME_DIR]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  let resources;
  if (identity === "frozen-original-v2") {
    // Explicit fixture-only generation; never a fallback for missing release evidence.
    resources = join(root, "legacy", "resources");
    if (createHash("sha256").update(readFileSync(join(resources, "action_modules.py"))).digest("hex")
      !== "ec347620aa94e8ff56db91e66382542262bade79907b617968ffeae69a1c72d5") {
      throw new Error("Frozen fixture-only v2 Action source changed.");
    }
  } else {
    const archive = process.env.PKM_LEGACY_VSIX;
    if (!archive) throw new Error(`Set PKM_LEGACY_VSIX to original 4.0.22, SHA256 ${releaseSha256}; no legacy fallback.`);
    const stat = statSync(archive);
    if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error("Original Action VSIX must be a bounded regular file.");
    const bytes = readFileSync(archive);
    if (createHash("sha256").update(bytes).digest("hex") !== releaseSha256) {
      throw new Error(`Original Action VSIX SHA256 must equal ${releaseSha256}.`);
    }
    execFileSync("python3", ["-I", "-B", "-c", `
import io,json,stat,sys,zipfile
from pathlib import Path,PurePosixPath
root=Path(sys.argv[1]).resolve()
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
 names=archive.namelist()
 metadata=json.loads(archive.read("extension/package.json"))
 if (metadata["publisher"],metadata["name"],metadata["version"])!=("Uone","personal-knowledge","4.0.22"):
  raise ValueError("Unexpected original Action release")
 total=0
 for member in sys.argv[2:]:
  path=PurePosixPath(member)
  if path.is_absolute() or ".." in path.parts or "\\\\" in member or ":" in member:
   raise ValueError("Unsafe original Action member")
  name="extension/"+member
  if names.count(name)!=1: raise ValueError("Missing or duplicate original Action member: "+member)
  info=archive.getinfo(name)
  total+=info.file_size
  if info.is_dir() or stat.S_ISLNK(info.external_attr>>16) or info.file_size>2*1024*1024 or total>8*1024*1024:
   raise ValueError("Unbounded or non-file original Action member")
  target=root.joinpath(*path.parts)
  target.resolve().relative_to(root)
  target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  with target.open("xb") as output: output.write(archive.read(info))
`, directory, ...members], { input: bytes, cwd: directory, env, timeout: 30_000, maxBuffer: 1024 * 1024 });
    resources = join(directory, "resources");
  }
  const fixture = {
    json(script, args = [], input) {
      return JSON.parse(execFileSync("python3", ["-I", "-B", "-c", noAuthority + script, resources, ...args], {
        input, encoding: "utf8", cwd: directory, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      }));
    },
  };
  fixtures.set(canonical, fixture);
  return fixture;
}
