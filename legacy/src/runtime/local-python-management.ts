import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { LocalEnvironmentCatalog, inspectLocalEnvironment, type LocalEnvironment } from "./local-environment-catalog";
import { PythonEnvironmentAuthority, type PythonEnvironmentHandle } from "./python-environment-authority";
import type { EnvManager } from "../servers/pyenvs";

function canonicalDirectory(directory: string): void {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || fs.realpathSync(directory) !== directory
    || !fs.lstatSync(directory).isDirectory()) throw new Error("Select an existing canonical environment folder, not a symlink.");
}
function config(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384) throw new Error("Environment configuration is not a bounded regular file.");
    return fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
}

export function inspectPythonFolder(root: string, name: string, id = `local-python-${randomUUID()}`): LocalEnvironment {
  if (process.platform !== "linux") throw new Error("Python folder management is qualified on Linux only.");
  canonicalDirectory(root);
  let manager = "venv";
  if (fs.existsSync(path.join(root, "conda-meta"))) {
    canonicalDirectory(path.join(root, "conda-meta"));
    manager = "conda";
  } else {
    const text = config(path.join(root, "pyvenv.cfg"));
    if (/^\s*uv\s*=/m.test(text)) manager = "uv";
  }
  const entry: LocalEnvironment = { id, name, language: "python", kind: "environment", manager, root,
    executors: [{ id: "python", executable: path.join(root, "bin", "python") }] };
  const status = inspectLocalEnvironment(entry);
  if (!status.available) throw new Error(status.issues.join(" "));
  const authority = new PythonEnvironmentAuthority(() => true, () => [{ id, name, manager: manager as EnvManager,
    path: root, python: entry.executors[0].executable }]);
  try { authority.select("local-folder-inspection", "local:owner", id); }
  finally { authority.revoke(); }
  return entry;
}

export function planPythonCreation(storage: string, name: string, description: string, manager: "venv" | "conda" | "uv" = "venv"): LocalEnvironment {
  if (process.platform !== "linux") throw new Error("Offline Python creation is qualified on Linux only.");
  canonicalDirectory(storage);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/.test(name) || description.length > 8192 || description.includes("\0"))
    throw new Error("Use a 1–50 character environment name (letters, digits, dot, underscore or hyphen) and bounded description.");
  const id = `local-python-${randomUUID()}`, root = path.join(storage, "next-synthetic-python", id);
  return { id, name, description, language: "python", kind: "environment", manager, root,
    executors: [{ id: "python", executable: path.join(root, "bin", "python") }] };
}

export function runOfflinePythonProcess(executable: string, args: string[], cwd: string,
  env: NodeJS.ProcessEnv = {}, signal?: AbortSignal, onSpawn?: () => void): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Offline Python creation cancelled; no process started.")); return; }
    let reason = "", escalation: NodeJS.Timeout | undefined;
    const stop = (why: string) => {
      if (reason) return;
      reason = why; child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 500);
    };
    const cancel = () => stop("Offline Python creation cancelled");
    const child = execFile(executable, args, { cwd, env, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      clearTimeout(deadline); if (escalation) clearTimeout(escalation);
      signal?.removeEventListener("abort", cancel);
      if (reason || error) reject(new Error(`${reason || "Offline Python operation failed"}: ${error?.message ?? ""} ${String(stderr).slice(0, 2048)} ${String(stdout).slice(-4096)}`));
      else resolve(String(stdout));
    });
    const deadline = setTimeout(() => stop("Offline Python creation deadline exceeded"), 60000);
    signal?.addEventListener("abort", cancel, { once: true });
    child.once("spawn", () => {
      try { onSpawn?.(); }
      catch (error) { stop(`Offline Python progress callback failed: ${error instanceof Error ? error.message : "unknown failure"}`); }
    });
    if (signal?.aborted) cancel();
  });
}

/** Provisioning only, not a Workflow adapter or a persisted execution grant. No prefix-removal operation. */
export async function createOfflinePythonEnvironment(options: {
  storage: string; entry: LocalEnvironment; base?: PythonEnvironmentHandle; store: LocalEnvironmentCatalog;
  expected: string; check(): void; signal?: AbortSignal;
  bundledPip?: boolean; report?(phase: string): void;
  provider?: { manager: "conda" | "uv"; provision(root: string, parent: string, signal?: AbortSignal): Promise<void> };
}): Promise<void> {
  const { storage, entry, base, store, expected, check } = options;
  const parent = path.join(storage, "next-synthetic-python");
  if (!/^local-python-[a-f0-9-]{36}$/.test(entry.id) || entry.root !== path.join(parent, entry.id)
    || entry.language !== "python" || entry.kind !== "environment"
    || (options.provider ? entry.manager !== options.provider.manager : entry.manager !== "venv" || !base)
    || entry.executors.length !== 1 || entry.executors[0].id !== "python"
    || entry.executors[0].executable !== path.join(entry.root, "bin", "python")
    || (options.bundledPip && (options.provider || entry.manager !== "venv")))
    throw new Error("Creation is restricted to this profile's synthetic Python directory.");
  canonicalDirectory(storage); check();
  if (store.read().digest !== expected) throw new Error("Catalog changed before creation; no runtime was created.");
  const directory = fs.lstatSync(storage);
  if (directory.uid !== process.getuid?.() || directory.mode & 0o022)
    throw new Error("The synthetic profile storage must be privately owned and not group/world writable.");
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  canonicalDirectory(parent);
  const parentStat = fs.lstatSync(parent);
  if (parentStat.uid !== process.getuid?.() || parentStat.mode & 0o022)
    throw new Error("Synthetic creation directory ownership/permissions changed.");
  fs.mkdirSync(entry.root, { mode: 0o700 });
  try {
    fs.writeFileSync(path.join(entry.root, ".pkm-creation.json"), JSON.stringify({
      schema: "pkm.local-python-creation/v1", environmentId: entry.id, baseEnvironmentId: base?.environmentId,
      name: entry.name, description: entry.description, state: "requested", completionSource: "catalog", automaticReplay: false,
      ...(options.bundledPip ? { bundledPip: true } : {}),
    }), { flag: "wx", mode: 0o600 });
    check();
    if (options.provider) await options.provider.provision(entry.root, parent, options.signal);
    else await runOfflinePythonProcess(base!.executable, ["-I", "-B", "-m", "venv", "--without-pip", entry.root], parent, {}, options.signal);
    check();
    inspectPythonFolder(entry.root, entry.name, entry.id);
    const prefix = await runOfflinePythonProcess(entry.executors[0].executable, ["-I", "-B", "-c", "import sys; print(sys.prefix)"], parent, {}, options.signal);
    check();
    if (prefix.trim() !== entry.root) throw new Error("Created interpreter reports a different prefix; do not bind it.");
    if (options.bundledPip) {
      const work = path.join(entry.root, ".pkm-pip-bootstrap");
      fs.mkdirSync(work, { mode: 0o700 });
      for (const name of ["home", "scratch"]) fs.mkdirSync(path.join(work, name), { mode: 0o700 });
      const env = { HOME: path.join(work, "home"), TMPDIR: path.join(work, "scratch"),
        TMP: path.join(work, "scratch"), TEMP: path.join(work, "scratch"), PYTHONDONTWRITEBYTECODE: "1",
        PYTHONNOUSERSITE: "1", PIP_CONFIG_FILE: "/dev/null", PIP_NO_INDEX: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" };
      options.report?.("Seed new prefix from existing local ensurepip wheels");
      check();
      await runOfflinePythonProcess(entry.executors[0].executable, ["-I", "-B", "-c",
        "import sys\nif sys.prefix != sys.argv[1] or sys.prefix == sys.base_prefix: raise RuntimeError('Bundled pip target changed')\nimport ensurepip\nensurepip.bootstrap(default_pip=True)", entry.root],
      work, env, options.signal);
      check();
      await runOfflinePythonProcess(entry.executors[0].executable, ["-I", "-B", "-c",
        "import sys,os\nif sys.prefix != sys.argv[1]: raise RuntimeError('Pip verification target changed')\nimport pip\nif os.path.commonpath([os.path.realpath(pip.__file__),sys.prefix]) != sys.prefix: raise RuntimeError('Pip is outside the new prefix')\nprint(pip.__version__)", entry.root],
      work, env, options.signal);
      check();
    }
    store.register(entry, expected);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : "Creation outcome unknown."} Files were kept at ${entry.root}. Inspect the catalog before retrying; explicitly register the completed folder or restore its original path. No automatic replay, cleanup or download.`);
  }
}
