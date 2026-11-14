import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { pathToFileURL } from "url";
import { runOfflinePythonProcess } from "./local-python-management";

type Manager = "conda" | "uv";
export type LocalPythonManager = Readonly<{
  manager: Manager; executable: string; target: string; identity: string; cache?: string; cacheIdentity?: string; queryOnly?: true;
}>;
const fingerprint = (file: string, link = false) => {
  const stat = link ? fs.lstatSync(file, { bigint: true }) : fs.statSync(file, { bigint: true });
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
};
function boundedJson(file: string): any {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 262144) throw new Error("Local package metadata must be a bounded regular file.");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
}

/** Native installed-tool identities; query-only selections cannot provision. Catalog metadata and PATH never grant execution. */
export class LocalPythonManagerAuthority {
  private readonly handles = new Set<LocalPythonManager>();
  constructor(private readonly trusted: () => boolean) {}
  select(manager: Manager, executable: string, cache?: string): LocalPythonManager {
    return this.selectTool(manager, executable, cache);
  }
  selectCondaQuery(executable: string): LocalPythonManager {
    return this.selectTool("conda", executable, undefined, true);
  }
  private selectTool(manager: Manager, executable: string, cache?: string, queryOnly = false): LocalPythonManager {
    if (!["conda", "uv"].includes(manager)) throw new Error("Only explicitly selected installed conda/uv tools are supported.");
    if (!this.trusted()) throw new Error("Current trusted native manager approval is required.");
    try {
      if (!path.isAbsolute(executable) || path.resolve(executable) !== executable
        || fs.realpathSync(path.dirname(executable)) !== path.dirname(executable)) throw new Error();
      const target = fs.realpathSync(executable);
      if (!fs.statSync(target).isFile()) throw new Error();
      fs.accessSync(executable, fs.constants.X_OK);
      if (manager === "conda" && !queryOnly && (!cache || !path.isAbsolute(cache) || path.resolve(cache) !== cache
        || fs.realpathSync(cache) !== cache || !fs.lstatSync(cache).isDirectory())) throw new Error();
      const handle = Object.freeze({ manager, executable, target,
        identity: `${fingerprint(executable, true)}|${fingerprint(target)}`,
        ...(manager === "conda" && !queryOnly ? { cache, cacheIdentity: fingerprint(cache!) } : {}),
        ...(queryOnly ? { queryOnly: true as const } : {}) });
      this.handles.add(handle); return handle;
    } catch { throw new Error(`Selected local ${manager} tool/cache is unavailable or invalid. Nothing was installed or downloaded.`); }
  }
  validate(handle: LocalPythonManager): void {
    if (!this.trusted()) { this.handles.clear(); throw new Error("Native manager authority was revoked."); }
    try {
      if (!this.handles.has(handle) || fs.realpathSync(handle.executable) !== handle.target
        || `${fingerprint(handle.executable, true)}|${fingerprint(handle.target)}` !== handle.identity
        || handle.cache && (fs.realpathSync(handle.cache) !== handle.cache || fingerprint(handle.cache) !== handle.cacheIdentity))
        throw new Error();
    } catch { this.handles.delete(handle); throw new Error("Local manager identity/cache changed or grant is not native; select and approve it again."); }
  }
  revoke(): void { this.handles.clear(); }
  provider(handle: LocalPythonManager, options: { pythonVersion?: string; baseExecutable?: string; report?(phase: string): void }) {
    this.validate(handle);
    if (handle.queryOnly) throw new Error("Package-query selection cannot provision an environment.");
    if (handle.manager === "conda" && !/^3\.\d{1,2}(?:\.\d{1,2})?$/.test(options.pythonVersion ?? ""))
      throw new Error("Select an explicit cached Python version such as 3.11; no latest/network resolution.");
    if (handle.manager === "uv" && (!options.baseExecutable || !path.isAbsolute(options.baseExecutable)))
      throw new Error("uv requires an explicitly registered local Python; no Python download or PATH fallback.");
    return {
      manager: handle.manager,
      provision: async (root: string, parent: string, signal?: AbortSignal) => {
        this.validate(handle);
        const work = path.join(parent, `${path.basename(root)}-provision`);
        fs.mkdirSync(work, { mode: 0o700 });
        for (const name of ["home", "cache", "envs"]) fs.mkdirSync(path.join(work, name), { mode: 0o700 });
        if (handle.manager === "uv") {
          await runOfflinePythonProcess(handle.executable,
            ["--offline", "--no-python-downloads", "--no-config", "venv", "--python", options.baseExecutable!, root],
            work, { HOME: path.join(work, "home"), UV_CACHE_DIR: path.join(work, "cache"), UV_NO_PROGRESS: "1" },
            signal, () => options.report?.("uv-create"));
          this.validate(handle); return;
        }
        const channel = path.join(work, "channel"), packages = new Map<string, { file: string; subdir: string; pin: string; sha256?: string; md5?: string }>();
        const indexes: Record<string, any> = {};
        for (const subdir of ["linux-64", "noarch"]) {
          fs.mkdirSync(path.join(channel, subdir), { recursive: true, mode: 0o700 });
          indexes[subdir] = { info: { subdir }, packages: {}, "packages.conda": {}, repodata_version: 1 };
        }
        const names = fs.readdirSync(handle.cache!);
        if (names.length > 5000) throw new Error("Selected local conda cache exceeds the bounded snapshot capacity.");
        for (const name of names) {
          const directory = path.join(handle.cache!, name);
          if (!fs.lstatSync(directory).isDirectory()) continue;
          if (fs.realpathSync(directory) !== directory) throw new Error("Conda cache package directory must not be a symlink.");
          const metadata = path.join(directory, "info", "repodata_record.json");
          if (!fs.existsSync(metadata)) continue;
          if (fs.realpathSync(path.dirname(metadata)) !== path.dirname(metadata)) throw new Error("Conda package metadata directory is linked.");
          const data = boundedJson(metadata), subdir = data.subdir, fn = data.fn;
          if (!Object.prototype.hasOwnProperty.call(indexes, subdir) || typeof fn !== "string" || path.basename(fn) !== fn
            || !/^[A-Za-z0-9._+-]+\.(conda|tar\.bz2)$/.test(fn) || !fs.existsSync(path.join(handle.cache!, fn))) continue;
          const archive = path.join(handle.cache!, fn), stat = fs.lstatSync(archive);
          if (!stat.isFile() || stat.size > 268435456 || stat.size < 1) throw new Error("Invalid or oversized local package archive.");
          if (packages.has(fn)) throw new Error("Ambiguous cached conda package filename.");
          const record: Record<string, unknown> = {};
          for (const key of ["name", "version", "build", "build_number", "depends", "constrains", "subdir", "md5", "sha256", "size", "timestamp"])
            if (Object.prototype.hasOwnProperty.call(data, key)) record[key] = data[key];
          indexes[subdir][fn.endsWith(".conda") ? "packages.conda" : "packages"][fn] = record;
          packages.set(fn, { file: archive, subdir, pin: fingerprint(archive), sha256: data.sha256, md5: data.md5 });
        }
        for (const [subdir, index] of Object.entries(indexes))
          fs.writeFileSync(path.join(channel, subdir, "repodata.json"), JSON.stringify(index), { flag: "wx", mode: 0o600 });
        const condarc = path.join(work, "condarc");
        fs.writeFileSync(condarc, "offline: true\nadd_pip_as_python_dependency: false\nauto_update_conda: false\n", { flag: "wx", mode: 0o600 });
        const env = { HOME: path.join(work, "home"), PATH: "/usr/bin:/bin", CONDARC: condarc,
          CONDA_PKGS_DIRS: path.join(work, "cache"), CONDA_ENVS_PATH: path.join(work, "envs"), CONDA_OFFLINE: "true",
          CONDA_NO_PLUGINS: "true", CONDA_SOLVER: "classic", CONDA_AUTO_UPDATE_CONDA: "false",
          PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" };
        const args = ["create", "--offline", "--no-default-packages", "--override-channels", "--channel", pathToFileURL(channel).href,
          "--prefix", root, "--copy", "--yes", "--json", `python=${options.pythonVersion}`];
        const plan = JSON.parse(await runOfflinePythonProcess(handle.executable, [...args, "--dry-run"], work, env, signal,
          () => options.report?.("conda-plan")));
        if (plan.success !== true || !Array.isArray(plan.actions?.FETCH) || plan.actions.FETCH.length > 100)
          throw new Error("Offline conda plan is unavailable; no cached Python/dependencies can satisfy this request.");
        let copied = 0;
        for (const item of plan.actions.FETCH) {
          if (signal?.aborted) throw new Error("Offline conda creation cancelled; no automatic replay.");
          const source = packages.get(item.fn);
          if (!source || item.subdir !== source.subdir || fingerprint(source.file) !== source.pin)
            throw new Error("Conda plan does not match the selected local cache snapshot.");
          const bytes = fs.readFileSync(source.file);
          copied += bytes.length;
          if (copied > 536870912 || fingerprint(source.file) !== source.pin) throw new Error("Conda cache copy changed or exceeded its bounded capacity.");
          if (source.sha256 ? createHash("sha256").update(bytes).digest("hex") !== source.sha256
            : !source.md5 || createHash("md5").update(bytes).digest("hex") !== source.md5)
            throw new Error("Cached conda archive digest changed; no package was trusted or downloaded.");
          fs.writeFileSync(path.join(channel, source.subdir, item.fn), bytes, { flag: "wx", mode: 0o600 });
        }
        this.validate(handle);
        await runOfflinePythonProcess(handle.executable, args, work, env, signal, () => options.report?.("conda-create"));
        this.validate(handle);
      },
    };
  }
}
