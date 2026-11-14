import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { LocalEnvironmentCatalog, type LocalEnvironment } from "./local-environment-catalog";
import { LocalPythonManagerAuthority, type LocalPythonManager } from "./local-python-managers";
import { inspectPythonFolder, runOfflinePythonProcess } from "./local-python-management";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function pathExists(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function directory(root: string, privateDirectory = false): string {
  const stat = fs.lstatSync(root);
  if (!path.isAbsolute(root) || path.resolve(root) !== root || fs.realpathSync(root) !== root
    || !stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & (privateDirectory ? 0o022 : 0o002))
    throw new Error("Conda lifecycle needs canonical owned local folders, not symlinks or writable shared profile storage.");
  return `${stat.dev}:${stat.ino}`;
}
function read(file: string, limit = 262_144): Buffer {
  if (fs.realpathSync(file) !== file) throw new Error("Conda input must be canonical.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o002 || info.size > limit)
      throw new Error("Conda input must be owned and bounded.");
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0, count: number;
    while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length !== info.size) throw new Error("Conda input changed.");
    return bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
type Archive = { name: string; sha256?: string; md5?: string };
export type CondaPrefixSnapshot = Readonly<{ root: string; identity: string; digest: string; archives: Archive[] }>;
export function inspectCondaPrefix(entry: LocalEnvironment): CondaPrefixSnapshot {
  if (process.platform !== "linux" || entry.language !== "python" || entry.kind !== "environment"
    || entry.manager !== "conda" || !entry.root || entry.executors.length !== 1
    || entry.executors[0].id !== "python" || entry.executors[0].executable !== path.join(entry.root, "bin", "python"))
    throw new Error("Select a registered Linux conda Python prefix, not a venv or C# executor set.");
  const root = entry.root, identity = directory(root), meta = path.join(root, "conda-meta");
  directory(meta); read(path.join(meta, "history"));
  inspectPythonFolder(root, entry.name, entry.id);
  const names = fs.readdirSync(meta).filter(name => name.endsWith(".json")).sort();
  if (!names.length || names.length > 256) throw new Error("Conda lifecycle supports 1–256 installed package records.");
  const archives: Archive[] = names.map(name => {
    const record = JSON.parse(read(path.join(meta, name), 2_000_000).toString("utf8"));
    if (record.name === "conda") throw new Error("Conda base/tool-containing prefixes are refused.");
    if (typeof record.fn !== "string" || !/^[A-Za-z0-9._+-]+\.(conda|tar\.bz2)$/.test(record.fn)
      || !(typeof record.sha256 === "string" && /^[a-f0-9]{64}$/.test(record.sha256)
        || typeof record.md5 === "string" && /^[a-f0-9]{32}$/.test(record.md5)))
      throw new Error("Installed conda record needs an exact cached archive digest; no network resolution.");
    return { name: record.fn, ...(record.sha256 ? { sha256: record.sha256 } : { md5: record.md5 }) };
  });
  if (new Set(archives.map(item => item.name)).size !== archives.length) throw new Error("Ambiguous conda archive records.");
  const digest = createHash("sha256");
  let count = 0, total = 0;
  const walk = (folder: string) => {
    directory(folder);
    for (const name of fs.readdirSync(folder).sort()) {
      if (++count > 20_000) throw new Error("Conda tree exceeds 20,000 entries.");
      const file = path.join(folder, name), stat = fs.lstatSync(file);
      digest.update(JSON.stringify([path.relative(root, file), stat.mode, stat.size]));
      if (stat.isSymbolicLink()) { digest.update(fs.readlinkSync(file)); continue; }
      if (stat.isDirectory()) { walk(file); continue; }
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o002
        || stat.size > 67_108_864 || (total += stat.size) > 536_870_912) throw new Error("Conda tree exceeds owned/bounded lifecycle limits.");
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const buffer = Buffer.alloc(32_768);
        let length = 0, size: number;
        while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
          length += size;
          if (length > stat.size) throw new Error("Conda tree grew during review.");
          digest.update(buffer.subarray(0, size));
        }
        if (length !== stat.size) throw new Error("Conda tree changed during review.");
      } finally { fs.closeSync(fd); }
    }
  };
  walk(root);
  return Object.freeze({ root, identity, digest: digest.digest("hex"), archives });
}
export function validateCondaPrefix(snapshot: CondaPrefixSnapshot, entry: LocalEnvironment): void {
  if (JSON.stringify(inspectCondaPrefix(entry)) !== JSON.stringify(snapshot))
    throw new Error("Conda prefix/package/activation inputs changed; review again.");
}
type Plan = Readonly<{ operationId: string; source: CondaPrefixSnapshot; target: string; operation: "clone" | "remove" }>;
export function planCondaLifecycle(storage: string, entry: LocalEnvironment, operation: "clone" | "remove"): Plan {
  directory(storage, true);
  const source = inspectCondaPrefix(entry), parent = path.join(storage, "next-synthetic-python"), operationId = randomUUID();
  if (operation === "remove" && (path.dirname(source.root) !== parent || !/^conda-[a-f0-9-]{36}$/.test(path.basename(source.root))))
    throw new Error("Manager removal only accepts this profile's managed conda clones; never external/original prefixes.");
  return Object.freeze({ operationId, source, operation,
    target: path.join(parent, `${operation === "clone" ? "conda-" : ".conda-recovery-"}${operationId}`) });
}
function work(storage: string, operationId: string) {
  directory(storage, true);
  const ledger = path.join(storage, "next-environment-maintenance");
  fs.mkdirSync(ledger, { recursive: true, mode: 0o700 }); directory(ledger, true);
  const root = path.join(ledger, `conda-work-${operationId}`);
  fs.mkdirSync(root, { mode: 0o700 });
  for (const name of ["home", "cache", "envs", "scratch"]) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const config = path.join(root, "condarc");
  fs.writeFileSync(config, "offline: true\nauto_activate_base: false\nauto_update_conda: false\n", { flag: "wx", mode: 0o600 });
  const env = { HOME: path.join(root, "home"), PATH: "/usr/bin:/bin", CONDARC: config,
    CONDA_PKGS_DIRS: path.join(root, "cache"), CONDA_ENVS_PATH: path.join(root, "envs"), CONDA_OFFLINE: "true",
    CONDA_NO_PLUGINS: "true", CONDA_SOLVER: "classic", CONDA_AUTO_UPDATE_CONDA: "false",
    PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1",
    TMPDIR: path.join(root, "scratch"), TMP: path.join(root, "scratch"), TEMP: path.join(root, "scratch") };
  return { root, ledger, env };
}
function receipt(file: string, value: unknown): void {
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > 65_536) throw new Error("Lifecycle receipt exceeds bounded recovery capacity; no operation admitted.");
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dir = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
async function clone(options: {
  snapshot: CondaPrefixSnapshot; target: string; authority: LocalPythonManagerAuthority; tool: LocalPythonManager;
  context: ReturnType<typeof work>; signal?: AbortSignal; check(): void; report?(phase: string): void;
}): Promise<void> {
  const { snapshot, tool, authority, context, target } = options;
  authority.validate(tool); options.check();
  if (tool.manager !== "conda" || !tool.cache) throw new Error("An explicitly selected installed conda and cache are required.");
  directory(path.dirname(target), true);
  if (pathExists(target)) throw new Error("Clone destination exists; inspect it, never overwrite.");
  let total = 0;
  for (const archive of snapshot.archives) {
    if (options.signal?.aborted) throw new Error("Conda clone cancelled.");
    const bytes = read(path.join(tool.cache, archive.name), 268_435_456);
    if ((total += bytes.length) > 536_870_912) throw new Error("Cached archives exceed 512 MiB.");
    const matches = archive.sha256 ? hash(bytes) === archive.sha256
      : createHash("md5").update(bytes).digest("hex") === archive.md5;
    if (!matches) throw new Error("Selected cached archive digest differs from installed package; no download.");
    fs.writeFileSync(path.join(context.root, "cache", archive.name), bytes, { flag: "wx", mode: 0o600 });
  }
  authority.validate(tool); options.check();
  directory(path.dirname(target), true);
  if (pathExists(target)) throw new Error("Clone destination exists; inspect it, never overwrite.");
  const response = JSON.parse(await runOfflinePythonProcess(tool.executable,
    ["create", "--offline", "--copy", "--yes", "--json", "--prefix", target, "--clone", snapshot.root],
    context.root, context.env, options.signal, () => options.report?.("conda-clone")));
  if (response.success !== true || response.src_prefix !== snapshot.root || response.dst_prefix !== target)
    throw new Error("Conda clone result is not the exact requested prefix.");
  authority.validate(tool); options.check();
  const prefix = await runOfflinePythonProcess(path.join(target, "bin", "python"),
    ["-I", "-B", "-c", "import sys; print(sys.prefix)"], context.root, context.env, options.signal);
  if (prefix.trim() !== target) throw new Error("Cloned Python reports another prefix.");
}
type Options = { storage: string; entry: LocalEnvironment; plan: Plan; store: LocalEnvironmentCatalog;
  expected: string; authority: LocalPythonManagerAuthority; tool: LocalPythonManager;
  check(): void; signal?: AbortSignal; report?(phase: string): void };
export async function executeCondaLifecycle(options: Options): Promise<void> {
  const { storage, entry, plan, store, expected, authority, tool } = options;
  const parent = path.join(storage, "next-synthetic-python");
  if (!uuid.test(plan.operationId) || !["clone", "remove"].includes(plan.operation)
    || plan.target !== path.join(parent, `${plan.operation === "clone" ? "conda-" : ".conda-recovery-"}${plan.operationId}`)
    || plan.operation === "remove" && (path.dirname(entry.root!) !== parent || !/^conda-[a-f0-9-]{36}$/.test(path.basename(entry.root!))))
    throw new Error("Conda destination/removal is not this profile's synthetic lifecycle scope.");
  const fresh = () => {
    options.check(); authority.validate(tool);
    if (options.signal?.aborted) throw new Error("Conda lifecycle cancelled.");
    if (store.read().digest !== expected) throw new Error("Catalog changed; inspect retained lifecycle data.");
    validateCondaPrefix(plan.source, entry);
  };
  if (JSON.stringify(store.read().catalog.entries.find(item => item.id === entry.id)) !== JSON.stringify(entry))
    throw new Error("Registered conda entry changed; no lifecycle operation admitted.");
  fresh(); fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); directory(parent, true);
  const context = work(storage, plan.operationId);
  receipt(path.join(context.ledger, `conda-${plan.operationId}.json`), {
    schema: "pkm.local-conda-lifecycle/v1", plan, entry, revision: store.read().catalog.revision,
    state: "requested", completionSource: "catalog", automaticReplay: false, sourceRemovalRequested: plan.operation === "remove",
  });
  try {
    await clone({ snapshot: plan.source, target: plan.target, authority, tool, context, check: fresh,
      signal: options.signal, report: options.report });
    fresh();
    if (plan.operation === "clone") { store.rebindPython(entry.id, plan.target, expected); return; }
    const backup = inspectCondaPrefix({ ...entry, root: plan.target, executors: [{ id: "python", executable: path.join(plan.target, "bin", "python") }] });
    receipt(path.join(context.ledger, `conda-backup-${plan.operationId}.json`), { schema: "pkm.local-conda-backup/v1", backup });
    fresh();
    const result = JSON.parse(await runOfflinePythonProcess(tool.executable,
      ["env", "remove", "--yes", "--json", "--prefix", plan.source.root],
      context.root, context.env, options.signal, () => options.report?.("conda-remove")));
    if (result.success !== true || fs.existsSync(plan.source.root)) throw new Error("Conda removal did not finish; backup kept, no false unregister.");
    options.check(); authority.validate(tool);
    if (options.signal?.aborted) throw new Error("Conda removal cancelled after effects; outcome requires inspection.");
    store.unregister(entry.id, expected);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : "Conda outcome unknown."} Lifecycle ${plan.operationId}, target ${plan.target} and work/receipts ${context.root} retained. Inspect catalog/prefixes; no automatic replay, cleanup or rollback. External source deletion is never admitted.`);
  }
}
export function listCondaRecoveries(storage: string): string[] {
  const ledger = path.join(storage, "next-environment-maintenance");
  if (!fs.existsSync(ledger)) return [];
  directory(ledger, true);
  return fs.readdirSync(ledger).filter(name => /^conda-[a-f0-9-]{36}\.json$/.test(name)).flatMap(name => {
    const data = JSON.parse(read(path.join(ledger, name), 65_536).toString("utf8"));
    return data.schema === "pkm.local-conda-lifecycle/v1" && data.plan?.operation === "remove" ? [data.plan.operationId] : [];
  });
}
export async function restoreCondaLifecycle(options: Omit<Options, "entry" | "plan"> & { operationId: string }): Promise<void> {
  const { storage, operationId, store, expected, authority, tool } = options;
  if (!uuid.test(operationId)) throw new Error("Select a recorded conda removal.");
  const ledger = path.join(storage, "next-environment-maintenance");
  directory(storage, true); directory(ledger, true);
  const record = JSON.parse(read(path.join(ledger, `conda-${operationId}.json`), 65_536).toString("utf8"));
  const { plan, entry } = record as { plan: Plan; entry: LocalEnvironment };
  if (record.schema !== "pkm.local-conda-lifecycle/v1" || plan?.operation !== "remove" || plan.operationId !== operationId
    || plan.target !== path.join(storage, "next-synthetic-python", `.conda-recovery-${operationId}`)
    || entry.root !== plan.source.root || path.dirname(entry.root!) !== path.join(storage, "next-synthetic-python")
    || !/^conda-[a-f0-9-]{36}$/.test(path.basename(entry.root!)))
    throw new Error("Removal receipt is outside synthetic scope.");
  if (JSON.stringify(store.read(record.revision).catalog.entries.find(item => item.id === entry.id)) !== JSON.stringify(entry))
    throw new Error("Conda recovery receipt/history differs.");
  const data = JSON.parse(read(path.join(ledger, `conda-backup-${operationId}.json`), 65_536).toString("utf8"));
  if (data.schema !== "pkm.local-conda-backup/v1" || data.backup?.root !== plan.target) throw new Error("Verified backup receipt unavailable.");
  const existing = store.read().catalog.entries.find(item => item.id === entry.id);
  if (existing && (existing.root !== entry.root || existing.manager !== "conda"
    || JSON.stringify(existing.executors) !== JSON.stringify(entry.executors))) throw new Error("Environment ID rebound elsewhere; no restore.");
  const backupEntry = { ...entry, root: plan.target, executors: [{ id: "python", executable: path.join(plan.target, "bin", "python") }] };
  const fresh = () => {
    options.check(); authority.validate(tool);
    if (store.read().digest !== expected || options.signal?.aborted) throw new Error("Conda restore decision became stale/cancelled.");
    validateCondaPrefix(data.backup, backupEntry);
  };
  fresh();
  if (pathExists(entry.root!)) throw new Error("Original path still exists or is partial; inspect/quarantine it manually, never overwrite.");
  const context = work(storage, randomUUID());
  try {
    await clone({ snapshot: data.backup, target: entry.root!, authority, tool, context, check: fresh,
      signal: options.signal, report: options.report });
    fresh();
    if (!existing) store.register(entry, expected);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : "Restore unknown."} Inspect restored prefix and catalog; backup/work kept. Never automatically retry, remove partial files or grant execution.`);
  }
}
export async function prepareCondaActivation(storage: string, entry: LocalEnvironment,
  authority: LocalPythonManagerAuthority, tool: LocalPythonManager, check: () => void) {
  const snapshot = inspectCondaPrefix(entry), context = work(storage, randomUUID());
  check(); authority.validate(tool);
  const hook = await runOfflinePythonProcess(tool.executable, ["shell.bash", "hook"], context.root, context.env);
  if (!hook || Buffer.byteLength(hook) > 65_536 || hook.includes("\0")) throw new Error("Conda Bash hook is not bounded reviewable text.");
  check(); authority.validate(tool); validateCondaPrefix(snapshot, entry);
  const scripts: { path: string; source: string }[] = [];
  const activation = path.join(entry.root!, "etc", "conda", "activate.d");
  if (fs.existsSync(activation)) {
    directory(activation);
    for (const name of fs.readdirSync(activation).filter(name => name.endsWith(".sh")).sort())
      scripts.push({ path: path.join(activation, name), source: read(path.join(activation, name), 65_536).toString("utf8") });
  }
  return { snapshot, hook, scripts, env: context.env, work: context.root };
}
