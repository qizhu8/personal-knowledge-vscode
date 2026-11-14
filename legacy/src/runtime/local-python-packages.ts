import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { normalizePkgs, type Pkg } from "../servers/pyenvs";
import { LocalEnvironmentCatalog, type LocalEnvironment } from "./local-environment-catalog";
import { inspectPythonFolder, runOfflinePythonProcess } from "./local-python-management";
import { LocalPythonManagerAuthority, type LocalPythonManager } from "./local-python-managers";
import { PythonEnvironmentAuthority, type PythonEnvironmentHandle } from "./python-environment-authority";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function directory(root: string, privateDirectory = true) {
  const stat = fs.lstatSync(root);
  if (!path.isAbsolute(root) || fs.realpathSync(root) !== root || !stat.isDirectory()
    || stat.uid !== process.getuid?.() || stat.mode & (privateDirectory ? 0o022 : 0o002))
    throw new Error("Package snapshots require canonical owned folders and private storage.");
  return `${stat.dev}:${stat.ino}`;
}
function read(file: string, limit = 4_194_304, privateInput = true) {
  if (fs.realpathSync(file) !== file) throw new Error("Linked package snapshot input refused.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > limit || stat.mode & (privateInput ? 0o022 : 0o002))
      throw new Error("Package snapshot input must be private, owned and bounded.");
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== stat.size) throw new Error("Package input changed during inspection.");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function binding(entry: LocalEnvironment) {
  if (entry.language !== "python" || entry.kind !== "environment"
    || !entry.root || entry.executors.length !== 1 || entry.executors[0].id !== "python"
    || entry.executors[0].executable !== path.join(entry.root, "bin/python"))
    throw new Error("Choose a registered Python prefix.");
  return { id: entry.id, root: entry.root, python: entry.executors[0].executable };
}
export function inspectPythonPackageSource(entry: LocalEnvironment) {
  const selected = binding(entry), rootIdentity = directory(selected.root, false);
  const files: string[] = [];
  if (entry.manager === "conda") {
    const meta = path.join(selected.root, "conda-meta");
    if (inspectPythonFolder(selected.root, entry.name, entry.id).manager !== "conda") throw new Error("Registered prefix is no longer conda.");
    directory(meta, false);
    files.push(...fs.readdirSync(meta).filter(name => name.endsWith(".json")).sort().map(name => path.join(meta, name)));
  } else {
    const config = path.join(selected.root, "pyvenv.cfg");
    if (fs.existsSync(config)) files.push(config);
    const lib = path.join(selected.root, "lib");
    if (fs.existsSync(lib)) {
      directory(lib, false);
      for (const name of fs.readdirSync(lib).filter(name => /^python\d+\.\d+$/.test(name)).sort()) {
        const site = path.join(lib, name, "site-packages");
        if (!fs.existsSync(site)) continue;
        directory(site, false);
        for (const name of fs.readdirSync(site).sort()) {
          if (!/\.(dist-info|egg-info)$/.test(name)) continue;
          const item = path.join(site, name);
          if (fs.lstatSync(item).isDirectory()) {
            directory(item, false);
            const metadata = path.join(item, name.endsWith(".dist-info") ? "METADATA" : "PKG-INFO");
            if (fs.existsSync(metadata)) files.push(metadata);
          } else files.push(item);
        }
      }
    }
  }
  if (files.length > 5000) throw new Error("Package metadata exceeds 5000 records.");
  let total = 0;
  const digest = createHash("sha256");
  for (const name of files) {
    const bytes = read(name, 2_000_000, false);
    if ((total += bytes.length) > 33_554_432) throw new Error("Package metadata exceeds 32 MiB.");
    digest.update(JSON.stringify(entry.manager === "conda" ? path.basename(name) : path.relative(selected.root, name))); digest.update(bytes);
  }
  return { ...selected, rootIdentity, metadataSha256: digest.digest("hex") };
}
const inspect = inspectPythonPackageSource;
function packages(value: unknown): Pkg[] {
  if (!Array.isArray(value) || value.length > 5000 || value.some(item => !item || typeof item.name !== "string"
    || typeof item.version !== "string" || !item.name.trim() || !item.version.trim()
    || item.name.length > 256 || item.version.length > 256 || /[\0\r\n]/.test(item.name + item.version)))
    throw new Error("Manager did not return a bounded package name/version table.");
  return normalizePkgs(value);
}
export type PythonPackageSnapshot = {
  schema: "pkm.local-conda-packages/v1" | "pkm.local-pip-packages/v1";
  capturedAt: string; source: ReturnType<typeof inspect>; packages: Pkg[];
};
export function environmentSnapshotFile(storage: string, entry: LocalEnvironment, create = false,
  bucket: "package-snapshots" | "metadata-snapshots" = "package-snapshots") {
  directory(storage); binding(entry);
  const parent = path.join(storage, "next-local-environments"), root = path.join(parent, bucket);
  directory(parent);
  if (create && !fs.existsSync(root)) fs.mkdirSync(root, { mode: 0o700 });
  if (!fs.existsSync(root)) return;
  directory(root);
  return path.join(root, `${hash(entry.id)}.json`);
}
export const readEnvironmentSnapshotInput = read;
export function privateEnvironmentQueryWork(storage: string, operation: "conda-packages" | "pip-packages" | "python-metadata" | "conda-inventory") {
  directory(storage);
  const parent = path.join(storage, "next-environment-maintenance");
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); directory(parent);
  const work = path.join(parent, `${operation}-${randomUUID()}`);
  fs.mkdirSync(work, { mode: 0o700 });
  for (const name of ["home", "cache", "envs", "scratch"]) fs.mkdirSync(path.join(work, name), { mode: 0o700 });
  const config = path.join(work, "condarc");
  fs.writeFileSync(config, "offline: true\nauto_update_conda: false\n", { flag: "wx", mode: 0o600 });
  return { work, config };
}
export function publishEnvironmentSnapshot(storage: string, entry: LocalEnvironment,
  bucket: "package-snapshots" | "metadata-snapshots", bytes: string, work: string, fresh: () => void, published: () => void) {
  if (Buffer.byteLength(bytes) > 4_194_304) throw new Error("Environment snapshot exceeds 4 MiB.");
  const file = environmentSnapshotFile(storage, entry, true, bucket)!;
  try { fs.lstatSync(file); read(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Linked snapshot destination refused."); }
    catch (missing) { if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing; }
  }
  const pending = path.join(work, "snapshot.json"), fd = fs.openSync(pending, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fresh(); fs.renameSync(pending, file); published();
  const folder = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(folder); } finally { fs.closeSync(folder); }
}
export function readPythonPackageSnapshot(storage: string, entry: LocalEnvironment) {
  const file = environmentSnapshotFile(storage, entry);
  if (!file || !fs.existsSync(file)) return;
  const snapshot = JSON.parse(read(file).toString("utf8")) as PythonPackageSnapshot;
  if (snapshot.schema !== (entry.manager === "conda" ? "pkm.local-conda-packages/v1" : "pkm.local-pip-packages/v1") || !snapshot.source
    || !Number.isFinite(Date.parse(snapshot.capturedAt))
    || JSON.stringify(binding(entry)) !== JSON.stringify({
      id: snapshot.source.id, root: snapshot.source.root, python: snapshot.source.python,
    })) throw new Error("Package snapshot belongs to another catalog binding; explicitly refresh.");
  snapshot.packages = packages(snapshot.packages);
  let sourceMatches = false;
  try { sourceMatches = JSON.stringify(inspect(entry)) === JSON.stringify(snapshot.source); } catch { /* Historical cache remains inspectable. */ }
  return { snapshot, sourceMatches };
}
type QueryOptions = {
  storage: string; store: LocalEnvironmentCatalog; entry: LocalEnvironment; expected: string;
  check(): void;
  signal?: AbortSignal; report?(phase: string): void;
};
async function refresh(options: QueryOptions, query: {
  executable: string; argv: string[]; phase: string; validate(): void;
}): Promise<PythonPackageSnapshot> {
  const { storage, entry, expected, store } = options, source = inspect(entry);
  const fresh = () => {
    options.check(); query.validate();
    if (options.signal?.aborted || store.read().digest !== expected
      || JSON.stringify(store.read().catalog.entries.find(item => item.id === entry.id)) !== JSON.stringify(entry)
      || JSON.stringify(inspect(entry)) !== JSON.stringify(source)) throw new Error("Package query was cancelled, changed or revoked; previous snapshot kept.");
  };
  fresh();
  const { work, config } = privateEnvironmentQueryWork(storage, entry.manager === "conda" ? "conda-packages" : "pip-packages");
  let published = false;
  try {
    const output = await runOfflinePythonProcess(query.executable, query.argv, work, {
      PATH: "/usr/bin:/bin", HOME: path.join(work, "home"), CONDARC: config, CONDA_OFFLINE: "true",
      CONDA_NO_PLUGINS: "true", CONDA_SOLVER: "classic", CONDA_PKGS_DIRS: path.join(work, "cache"),
      CONDA_ENVS_PATH: path.join(work, "envs"), PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1",
      TMPDIR: path.join(work, "scratch"), TMP: path.join(work, "scratch"), TEMP: path.join(work, "scratch"),
      PIP_CONFIG_FILE: "/dev/null", PIP_NO_INDEX: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1",
    }, options.signal, () => options.report?.(query.phase));
    fresh();
    const snapshot: PythonPackageSnapshot = { schema: entry.manager === "conda" ? "pkm.local-conda-packages/v1" : "pkm.local-pip-packages/v1",
      capturedAt: new Date().toISOString(), source, packages: packages(JSON.parse(output)) };
    const bytes = JSON.stringify(snapshot);
    if (Buffer.byteLength(bytes) > 4_194_304) throw new Error("Package snapshot exceeds 4 MiB.");
    publishEnvironmentSnapshot(storage, entry, "package-snapshots", bytes, work, fresh, () => { published = true; });
    return snapshot;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : "Package query failed"}. ${published
      ? "Snapshot publication may already be visible; inspect the current cache."
      : "Previous snapshot unchanged."} Inspect retained query work ${work}. No automatic retry or package installation.`);
  }
}
export function refreshCondaPackageSnapshot(options: QueryOptions & {
  authority: LocalPythonManagerAuthority; tool: LocalPythonManager;
}): Promise<PythonPackageSnapshot> {
  if (options.entry.manager !== "conda") throw new Error("Choose a registered conda prefix.");
  return refresh(options, {
    executable: options.tool.executable, argv: ["list", "--json", "-p", options.entry.root!], phase: "conda-package-list",
    validate() {
      options.authority.validate(options.tool);
      if (!options.tool.queryOnly || options.tool.manager !== "conda") throw new Error("Explicit query-only conda selection required.");
    },
  });
}
export const pipPackageArgv = ["-I", "-B", "-m", "pip", "--isolated", "list", "--format=json", "--disable-pip-version-check", "--no-index"];
export function refreshPipPackageSnapshot(options: QueryOptions & {
  authority: PythonEnvironmentAuthority; handle: PythonEnvironmentHandle;
}): Promise<PythonPackageSnapshot> {
  if (options.entry.manager === "conda") throw new Error("Use the explicit conda package query for conda prefixes.");
  return refresh(options, {
    executable: options.handle.executable, argv: [...pipPackageArgv], phase: "pip-package-list",
    validate() {
      const { handle } = options;
      options.authority.validate(handle, handle.workspaceId, handle.actorId);
      if (handle.environmentId !== options.entry.id || handle.root !== options.entry.root
        || handle.executable !== binding(options.entry).python) throw new Error("Interpreter binding changed.");
    },
  });
}
