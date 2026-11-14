import * as fs from "fs";
import * as path from "path";
import { LocalEnvironmentCatalog, type LocalEnvironment } from "./local-environment-catalog";
import { PythonEnvironmentAuthority, type PythonEnvironmentHandle } from "./python-environment-authority";
import { LocalPythonManagerAuthority, type LocalPythonManager } from "./local-python-managers";
import { runOfflinePythonProcess } from "./local-python-management";
import { inspectPythonPackageSource, environmentSnapshotFile, readEnvironmentSnapshotInput,
  privateEnvironmentQueryWork, publishEnvironmentSnapshot } from "./local-python-packages";

type Frame = { storage: string; store: LocalEnvironmentCatalog; expected: string; check(): void;
  signal?: AbortSignal; report?(phase: string): void };
export type PythonMetadataSnapshot = { schema: "pkm.local-python-metadata/v1"; capturedAt: string;
  source: ReturnType<typeof inspectPythonPackageSource>; pyVersion: string; sizeBytes: number };
export function readPythonMetadataSnapshot(storage: string, entry: LocalEnvironment) {
  const file = environmentSnapshotFile(storage, entry, false, "metadata-snapshots");
  if (!file || !fs.existsSync(file)) return;
  const snapshot = JSON.parse(readEnvironmentSnapshotInput(file).toString("utf8")) as PythonMetadataSnapshot;
  if (snapshot.schema !== "pkm.local-python-metadata/v1" || !snapshot.source
    || snapshot.source.id !== entry.id || snapshot.source.root !== entry.root
    || snapshot.source.python !== entry.executors[0]?.executable || !/^\d+\.\d+\.\d+$/.test(snapshot.pyVersion)
    || !Number.isSafeInteger(snapshot.sizeBytes) || snapshot.sizeBytes < 0 || !Number.isFinite(Date.parse(snapshot.capturedAt)))
    throw new Error("Metadata snapshot binding/content changed; explicitly refresh.");
  let sourceMatches = false;
  try { sourceMatches = JSON.stringify(inspectPythonPackageSource(entry)) === JSON.stringify(snapshot.source); } catch { /* Historical only. */ }
  return { snapshot, sourceMatches };
}
const metadataProbe = `import os,sys,json
root=sys.argv[1]
seen=set()
blocks=0
count=0
def failed(error):
    raise error
for base,dirs,files in os.walk(root,followlinks=False,onerror=failed):
    for item in [base]+[os.path.join(base,n) for n in dirs+files]:
        stat=os.lstat(item)
        key=(stat.st_dev,stat.st_ino)
        if key in seen: continue
        seen.add(key)
        blocks+=stat.st_blocks
        count+=1
        if count>250000: raise RuntimeError("size inspection exceeds 250000 filesystem objects")
print(json.dumps({"pyVersion":".".join(map(str,sys.version_info[:3])),"sizeBytes":((blocks*512+1023)//1024)*1024}))
`;
export async function refreshPythonMetadata(options: Frame & { entry: LocalEnvironment;
  authority: PythonEnvironmentAuthority; handle: PythonEnvironmentHandle }): Promise<PythonMetadataSnapshot> {
  const { entry, authority, handle } = options, source = inspectPythonPackageSource(entry);
  const fresh = () => {
    options.check(); authority.validate(handle, handle.workspaceId, handle.actorId);
    if (options.signal?.aborted || options.store.read().digest !== options.expected || handle.environmentId !== entry.id
      || handle.root !== entry.root || handle.executable !== entry.executors[0].executable
      || JSON.stringify(options.store.read().catalog.entries.find(e => e.id === entry.id)) !== JSON.stringify(entry)
      || JSON.stringify(inspectPythonPackageSource(entry)) !== JSON.stringify(source))
      throw new Error("Metadata query cancelled or catalog/prefix changed.");
  };
  fresh();
  const { work } = privateEnvironmentQueryWork(options.storage, "python-metadata");
  let published = false;
  try {
    const output = await runOfflinePythonProcess(handle.executable, ["-I", "-B", "-c", metadataProbe, source.root], work,
      { PATH: "/usr/bin:/bin", HOME: path.join(work, "home"), TMPDIR: path.join(work, "scratch") },
      options.signal, () => options.report?.("python-version-and-allocated-size"));
    fresh();
    const data = JSON.parse(output);
    if (!/^\d+\.\d+\.\d+$/.test(data.pyVersion) || !Number.isSafeInteger(data.sizeBytes) || data.sizeBytes < 0)
      throw new Error("Interpreter did not return valid version/allocated size.");
    const snapshot: PythonMetadataSnapshot = { schema: "pkm.local-python-metadata/v1", capturedAt: new Date().toISOString(),
      source, pyVersion: data.pyVersion, sizeBytes: data.sizeBytes };
    publishEnvironmentSnapshot(options.storage, entry, "metadata-snapshots", JSON.stringify(snapshot), work, fresh, () => { published = true; });
    return snapshot;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : "Metadata query failed"}. ${published
      ? "Publication may already be visible; inspect cached metadata." : "Previous metadata unchanged."} Retained work ${work}. No automatic retry/install.`);
  }
}
export async function listInstalledCondaEnvironments(options: Frame & {
  authority: LocalPythonManagerAuthority; tool: LocalPythonManager; inventoryFile?: string;
  envsDirectory?: string;
}) {
  if (process.getuid?.() === 0 || process.geteuid?.() === 0)
    throw new Error("Conda inventory is unavailable for administrator/root sessions: conda may enumerate other accounts despite HOME. Use a non-admin profile; nothing queried.");
  const fresh = () => {
    options.check(); options.authority.validate(options.tool);
    if (!options.tool.queryOnly || options.tool.manager !== "conda" || options.signal?.aborted
      || options.store.read().digest !== options.expected) throw new Error("Inventory selection cancelled, changed or revoked.");
  };
  fresh();
  if (options.envsDirectory) {
    const stat = fs.lstatSync(options.envsDirectory);
    if (!path.isAbsolute(options.envsDirectory) || fs.realpathSync(options.envsDirectory) !== options.envsDirectory
      || !stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o002)
      throw new Error("Select a canonical owned, non-world-writable conda envs directory.");
  }
  const { work, config } = privateEnvironmentQueryWork(options.storage, "conda-inventory");
  if (options.inventoryFile) {
    const inventory = readEnvironmentSnapshotInput(options.inventoryFile, 1_048_576, false);
    fs.mkdirSync(path.join(work, "home/.conda"), { mode: 0o700 });
    fs.writeFileSync(path.join(work, "home/.conda/environments.txt"), inventory, { flag: "wx", mode: 0o600 });
  }
  const output = await runOfflinePythonProcess(options.tool.executable, ["env", "list", "--json"], work, {
    PATH: "/usr/bin:/bin", HOME: path.join(work, "home"), CONDARC: config, CONDA_OFFLINE: "true",
    CONDA_NO_PLUGINS: "true", CONDA_SOLVER: "classic", CONDA_PKGS_DIRS: path.join(work, "cache"),
    CONDA_ENVS_PATH: [options.envsDirectory, path.join(work, "envs")].filter(Boolean).join(path.delimiter),
    TMPDIR: path.join(work, "scratch"), PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
  }, options.signal, () => options.report?.("conda-env-list"));
  fresh();
  const data = JSON.parse(output);
  if (!Array.isArray(data.envs) || data.envs.length > 5000
    || data.envs.some((root: unknown) => typeof root !== "string" || root.length > 4096 || /[\0\r\n]/.test(root) || !path.isAbsolute(root)))
    throw new Error("Installed conda returned invalid inventory.");
  return { roots: [...new Set<string>(data.envs)], retainedWork: work,
    scope: "Selected installed tool base/default discovery plus explicitly selected inventory copy; no implicit real HOME/legacy registry read or source inventory write" };
}
