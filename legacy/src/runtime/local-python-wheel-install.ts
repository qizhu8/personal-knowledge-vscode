import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import type { LocalEnvironment } from "./local-environment-catalog";
import { LocalEnvironmentCatalog } from "./local-environment-catalog";
import { cachedPythonPackages, pythonAnalysisEntry, planPythonPackageMerge } from "./local-python-analytics";
import { readPythonMetadataSnapshot } from "./local-python-inspection";
import { inspectPythonPackageSource } from "./local-python-packages";
import { runOfflinePythonProcess } from "./local-python-management";
import { PythonEnvironmentAuthority, type PythonEnvironmentHandle } from "./python-environment-authority";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function ownedDirectory(root: string) {
  const stat = fs.lstatSync(root);
  if (!path.isAbsolute(root) || fs.realpathSync(root) !== root || !stat.isDirectory()
    || stat.uid !== process.getuid?.() || stat.mode & 0o022) throw new Error("Use canonical privately owned trial directories.");
}
function fileBytes(file: string, limit: number) {
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file) throw new Error("Linked input refused.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o022 || stat.size > limit)
      throw new Error("Select a bounded owned read-only input.");
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count !== stat.size) throw new Error("Input changed.");
    return bytes.subarray(0, count);
  } finally { fs.closeSync(fd); }
}
function snapshot(storage: string, entry: LocalEnvironment) {
  const cached = cachedPythonPackages(storage, entry);
  if (!cached.sourceMatches) throw new Error("Refresh historical package snapshots before planning installation.");
  return { cached, fingerprint: digest(JSON.stringify(cached.snapshot)) };
}
export function planMissingWheelInstall(storage: string, a: LocalEnvironment, b: LocalEnvironment) {
  const ca = snapshot(storage, a), cb = snapshot(storage, b);
  const metadata = (entry: LocalEnvironment) => readPythonMetadataSnapshot(storage, entry)?.snapshot;
  const merge = planPythonPackageMerge(pythonAnalysisEntry(a, metadata(a)), pythonAnalysisEntry(b, metadata(b)),
    ca.cached.snapshot.packages, cb.cached.snapshot.packages);
  const keep = merge.keep.id === a.id ? a : b, drop = keep.id === a.id ? b : a;
  ownedDirectory(storage);
  const parent = path.join(storage, "next-synthetic-python");
  ownedDirectory(parent); ownedDirectory(keep.root!);
  if (keep.manager !== "venv" || !/^local-python-[a-f0-9-]{36}$/.test(keep.id)
    || keep.root !== path.join(parent, keep.id)) throw new Error("Installation accepts only this trial's created synthetic venv, never external/conda prefixes.");
  const creation = JSON.parse(fileBytes(path.join(keep.root, ".pkm-creation.json"), 16384).toString("utf8"));
  if (creation.schema !== "pkm.local-python-creation/v1" || creation.environmentId !== keep.id)
    throw new Error("Created synthetic prefix receipt required.");
  const kept = keep.id === a.id ? ca : cb;
  if (!kept.cached.snapshot.packages.some(p => p.name.toLowerCase() === "pip"))
    throw new Error("Refresh an existing prefix-local pip snapshot first; never bootstrap during package installation.");
  if (merge.missing.length > 8 || merge.missing.some(p => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(p.name)
    || !/^\d+(?:\.\d+)*$/.test(p.version))) throw new Error("This offline adapter accepts at most eight simple pure-Python distributions with numeric versions.");
  return { keep, drop, missing: merge.missing, differences: merge.differences,
    sources: [{ entry: a, fingerprint: ca.fingerprint }, { entry: b, fingerprint: cb.fingerprint }] };
}
export type MissingWheelPlan = ReturnType<typeof planMissingWheelInstall>;
export function selectMissingWheels(plan: MissingWheelPlan, files: string[]) {
  if (files.length !== plan.missing.length) throw new Error("Select exactly one local wheel for each missing pinned package.");
  const wheels = plan.missing.map(pkg => {
    const name = `${pkg.name.toLowerCase()}-${pkg.version}-py3-none-any.whl`;
    const matches = files.filter(file => path.basename(file).toLowerCase() === name);
    if (matches.length !== 1) throw new Error(`Expected one ${name}; no download, version substitution or source build.`);
    const file = matches[0], bytes = fileBytes(file, 4_194_304);
    return { file, name: pkg.name, version: pkg.version, sha256: digest(bytes) };
  });
  return wheels;
}

// Wheel payloads cannot provide startup hooks, scripts, native code or existing namespaces.
const installer = String.raw`
import sys, os, json, zipfile, stat, hashlib, csv, io, email.parser, subprocess, sysconfig, ast
prefix, manifest = sys.argv[1:]
if sys.prefix != prefix or sys.prefix == sys.base_prefix:
    raise RuntimeError("Installer prefix changed")
site = sysconfig.get_path("purelib")
if os.path.realpath(site) != site or os.path.commonpath([site, prefix]) != prefix:
    raise RuntimeError("Site-packages must be canonical inside the approved prefix")
import pip
if os.path.commonpath([os.path.realpath(pip.__file__), prefix]) != prefix:
    raise RuntimeError("Installed pip is outside the prefix")
wheels = json.loads(manifest)
destinations = set()
for wheel in wheels:
    file, name, version = wheel["staged"], wheel["name"].lower(), wheel["version"]
    if name in ("sitecustomize", "usercustomize"):
        raise RuntimeError("Python startup modules are not admitted")
    with open(file, "rb") as stream:
        data = stream.read(4194305)
    if len(data) > 4194304 or hashlib.sha256(data).hexdigest() != wheel["sha256"]:
        raise RuntimeError("Staged wheel changed")
    dist = name + "-" + version + ".dist-info"
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        infos = archive.infolist()
        if len(infos) > 1000 or sum(i.file_size for i in infos) > 8388608:
            raise RuntimeError("Wheel expansion exceeds bounds")
        names, contents = set(), {}
        for item in infos:
            parts = item.filename.rstrip("/").split("/")
            if item.filename in names or any(p in ("", ".", "..") for p in parts) or "\\" in item.filename:
                raise RuntimeError("Duplicate or unsafe wheel path")
            names.add(item.filename)
            mode = stat.S_IFMT(item.external_attr >> 16)
            if mode not in (0, stat.S_IFDIR if item.is_dir() else stat.S_IFREG):
                raise RuntimeError("Linked or special wheel payload")
            top = parts[0]
            allowed = top == dist and (item.is_dir() and len(parts) == 1 or len(parts) == 2 and parts[1] in ("METADATA", "WHEEL", "RECORD"))
            allowed = allowed or top == name and (item.is_dir() or item.filename.endswith(".py"))
            allowed = allowed or item.filename == name + ".py"
            if not allowed:
                raise RuntimeError("Only a new Python module and minimal dist-info are admitted; no .data/entrypoints/hooks/native payload")
            destinations.add(top)
            if not item.is_dir():
                if item.file_size > 1048576:
                    raise RuntimeError("Wheel member exceeds bounds")
                contents[item.filename] = archive.read(item)
                if item.filename.endswith(".py"):
                    try:
                        compile(contents[item.filename], item.filename, "exec", ast.PyCF_ONLY_AST)
                    except (SyntaxError, ValueError):
                        raise RuntimeError("Invalid Python wheel payload")
        for top in destinations:
            if os.path.lexists(os.path.join(site, top)):
                raise RuntimeError("Wheel would overwrite an existing namespace")
        metadata = email.parser.BytesParser().parsebytes(contents[dist + "/METADATA"])
        header = email.parser.BytesParser().parsebytes(contents[dist + "/WHEEL"])
        if metadata.get_all("Name") != [wheel["name"]] or metadata.get_all("Version") != [version]:
            raise RuntimeError("Wheel does not match missing pinned metadata")
        if header.get_all("Root-Is-Purelib") != ["true"] or header.get_all("Tag") != ["py3-none-any"]:
            raise RuntimeError("Only py3-none-any pure wheels are admitted")
        records = list(csv.reader(io.StringIO(contents[dist + "/RECORD"].decode("utf-8"))))
        if any(len(r) != 3 for r in records) or len({r[0] for r in records}) != len(records) or {r[0] for r in records} != set(contents):
            raise RuntimeError("RECORD must name exactly the contained files")
args = [sys.executable, "-I", "-B", "-m", "pip", "install", "--no-index", "--no-deps",
        "--only-binary=:all:", "--no-compile", "--ignore-installed",
        "--disable-pip-version-check", "--no-cache-dir"] + [w["staged"] for w in wheels]
# ignore-installed prevents pip's uninstall phase; absent namespace checks reject ordinary overwrites.
subprocess.run(args, check=True)
from importlib import metadata
for wheel in wheels:
    installed = metadata.distribution(wheel["name"])
    if installed.version != wheel["version"] or os.path.commonpath([os.path.realpath(installed.locate_file("")), prefix]) != prefix:
        raise RuntimeError("Installed distribution verification failed")
`;

export async function installMissingWheels(options: {
  storage: string; store: LocalEnvironmentCatalog; expected: string; plan: MissingWheelPlan;
  wheels: ReturnType<typeof selectMissingWheels>; authority: PythonEnvironmentAuthority; handle: PythonEnvironmentHandle;
  check(): void; signal?: AbortSignal;
}) {
  const { storage, plan, authority, handle } = options;
  if (!plan.missing.length) throw new Error("No missing packages; no installer operation.");
  const fresh = () => {
    options.check(); authority.validate(handle, handle.workspaceId, handle.actorId);
    if (options.signal?.aborted || options.store.read().digest !== options.expected)
      throw new Error("Installation cancelled or catalog changed.");
    for (const source of plan.sources) {
      const registered = options.store.read().catalog.entries.find(e => e.id === source.entry.id);
      if (!registered || registered.root !== source.entry.root || registered.manager !== source.entry.manager
        || registered.kind !== source.entry.kind || registered.language !== source.entry.language
        || JSON.stringify(registered.executors) !== JSON.stringify(source.entry.executors))
        throw new Error("Installation source is not the current catalog binding.");
      if (snapshot(storage, source.entry).fingerprint !== source.fingerprint) throw new Error("Package plan changed; review again.");
    }
    if (handle.environmentId !== plan.keep.id || handle.root !== plan.keep.root || handle.executable !== plan.keep.executors[0].executable)
      throw new Error("Interpreter does not match the approved installation target.");
    const current = planMissingWheelInstall(storage, plan.sources[0].entry, plan.sources[1].entry);
    if (current.keep.id !== plan.keep.id || JSON.stringify(current.missing) !== JSON.stringify(plan.missing))
      throw new Error("Missing-package merge plan changed.");
  };
  fresh();
  const wheels = selectMissingWheels(plan, options.wheels.map(w => w.file));
  if (JSON.stringify(wheels) !== JSON.stringify(options.wheels)) throw new Error("Selected wheel changed; review its digest again.");
  const parent = path.join(storage, "next-environment-maintenance");
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); ownedDirectory(parent);
  const work = path.join(parent, `wheel-install-${randomUUID()}`);
  fs.mkdirSync(work, { mode: 0o700 });
  for (const name of ["home", "scratch"]) fs.mkdirSync(path.join(work, name), { mode: 0o700 });
  try {
    const staged = wheels.map(w => {
      const bytes = fileBytes(w.file, 4_194_304);
      if (digest(bytes) !== w.sha256) throw new Error("Wheel changed during staging.");
      const file = path.join(work, `${w.name.toLowerCase()}-${w.version}-py3-none-any.whl`);
      fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
      return { ...w, staged: file };
    });
    const receipt = { schema: "pkm.local-python-wheel-install/v1", state: "requested", target: plan.keep.root,
      environmentId: plan.keep.id, wheels: staged, automaticReplay: false };
    fs.writeFileSync(path.join(work, "receipt.json"), JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
    fresh();
    const output = await runOfflinePythonProcess(handle.executable,
      ["-I", "-B", "-c", installer, plan.keep.root!, JSON.stringify(staged)], work,
      { HOME: path.join(work, "home"), TMPDIR: path.join(work, "scratch"), TMP: path.join(work, "scratch"),
        TEMP: path.join(work, "scratch"), PIP_CONFIG_FILE: "/dev/null", PIP_NO_INDEX: "1",
        PYTHONDONTWRITEBYTECODE: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" }, options.signal);
    fs.writeFileSync(path.join(work, "outcome.json"), JSON.stringify({ state: "installer-returned-success", output }),
      { flag: "wx", mode: 0o600 });
    options.check(); authority.validate(handle, handle.workspaceId, handle.actorId);
    if (options.store.read().digest !== options.expected) throw new Error("Catalog changed during installation.");
    return { work, source: inspectPythonPackageSource(plan.keep) };
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : "Installer outcome unknown"} Files may be partially installed; no rollback, unregister, deletion or automatic retry. Inspect retained work ${work}.`);
  }
}
