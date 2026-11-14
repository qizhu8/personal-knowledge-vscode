// Python Environments registry: tracks conda / venv / uv (or other) environments,
// their interpreter + folder paths, and cached package snapshots (name+version)
// for reproducibility and cross-environment comparison. Machine-local
// (globalStorage) since interpreter paths / conda names are host-specific.
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

export type EnvManager = "conda" | "venv" | "uv" | "other";

export interface PyEnv {
  id: string;
  name: string;
  manager: EnvManager;
  python: string;         // interpreter path
  path: string;           // env folder / prefix
  condaName?: string;     // for conda envs
  description?: string;    // free-text: important tags / crucial packages
  sizeBytes?: number;      // last computed on-disk size
  sizeAt?: string;         // ISO timestamp of the size computation
  pyVersion?: string;      // detected Python version, e.g. "3.11.5"
}

export interface Pkg { name: string; version: string; }

let _dir = "";            // globalStorage/environments
let _log: (m: string) => void = () => {};

export function initPyenvs(dir: string, logger?: (m: string) => void): void {
  _dir = dir;
  if (logger) _log = logger;
  try { fs.mkdirSync(_dir, { recursive: true }); } catch { /* ignore */ }
}

function regPath(): string { return path.join(_dir, "registry.json"); }
function pkgCachePath(id: string): string { return path.join(_dir, `${id}.packages.json`); }

function readReg(): PyEnv[] {
  try { const j = JSON.parse(fs.readFileSync(regPath(), "utf-8")); return Array.isArray(j) ? j : []; }
  catch { return []; }
}
function writeReg(list: PyEnv[]): void {
  try { fs.mkdirSync(_dir, { recursive: true }); fs.writeFileSync(regPath(), JSON.stringify(list, null, 2) + "\n"); } catch { /* ignore */ }
}

function slugify(s: string): string {
  return String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "env";
}
function uniqueId(name: string, used: Set<string>): string {
  let id = slugify(name);
  if (used.has(id)) { let i = 2; while (used.has(`${id}-${i}`)) i++; id = `${id}-${i}`; }
  return id;
}

export function pyenvList(): PyEnv[] { return readReg(); }
export function pyenvRegistryReady(): boolean { return !!_dir && path.isAbsolute(_dir); }
export function pyenvGet(id: string): PyEnv | undefined { return readReg().find(e => e.id === id); }

export function pyenvAdd(input: Partial<PyEnv>): PyEnv {
  const list = readReg();
  const used = new Set(list.map(e => e.id));
  const env: PyEnv = {
    id: uniqueId(input.name || input.condaName || "env", used),
    name: (input.name || input.condaName || "env").trim(),
    manager: (input.manager as EnvManager) || "other",
    python: (input.python || "").trim(),
    path: (input.path || "").trim(),
    condaName: input.condaName ? String(input.condaName).trim() : undefined,
    description: input.description ? String(input.description).trim() : undefined,
  };
  if (!env.pyVersion && env.path) { const v = readVenvCfgVersion(env.path); if (v) env.pyVersion = v; }
  list.push(env);
  writeReg(list);
  return env;
}

export function pyenvUpdate(id: string, patch: Partial<PyEnv>): boolean {
  const list = readReg();
  const i = list.findIndex(e => e.id === id);
  if (i < 0) return false;
  list[i] = { ...list[i], ...patch, id: list[i].id };
  writeReg(list);
  return true;
}

export interface PyEnvDeleteResult {
  ok: boolean;
  id: string;
  path: string;
  unregistered: boolean;
  filesRequested: boolean;
  filesRemoved: boolean;
  pathStillExists: boolean;
  stale?: boolean;
  error?: string;
}

export function pyenvDelete(id: string, removeFiles = false): Promise<PyEnvDeleteResult> {
  return new Promise(resolve => {
    const env = pyenvGet(id);
    if (!env) return resolve({ ok: false, id, path: "", unregistered: false, filesRequested: removeFiles, filesRemoved: false, pathStillExists: false, error: "Environment is not registered." });
    const envPath = env.path || "";
    const finish = (filesRemoved: boolean) => {
      writeReg(readReg().filter(e => e.id !== id));
      try { fs.rmSync(pkgCachePath(id), { force: true }); } catch { /* ignore */ }
      const pathStillExists = !!envPath && fs.existsSync(envPath);
      resolve({ ok: true, id, path: envPath, unregistered: true, filesRequested: removeFiles, filesRemoved: removeFiles && filesRemoved && !pathStillExists, pathStillExists });
    };
    if (!removeFiles) return finish(false);
    if (envPath && !fs.existsSync(envPath)) {
      return resolve({
        ok: false, id, path: envPath, unregistered: false, filesRequested: true,
        filesRemoved: false, pathStillExists: false, stale: true,
        error: `Environment path does not exist on disk: ${envPath}`,
      });
    }
    if (env.manager === "conda") {
      if (!env.path || !/[\\/]envs[\\/]/.test(env.path)) {
        return resolve({ ok: false, id, path: envPath, unregistered: false, filesRequested: true, filesRemoved: false, pathStillExists: !!envPath && fs.existsSync(envPath), error: "Refusing to delete a conda base/root environment from disk." });
      }
      execFile("conda", ["env", "remove", "-y", "-p", env.path], { timeout: 120000, windowsHide: process.platform === "win32" }, (err) => {
        if (err) return resolve({ ok: false, id, path: envPath, unregistered: false, filesRequested: true, filesRemoved: false, pathStillExists: fs.existsSync(env.path), error: `conda env remove failed: ${err.message}` });
        finish(true);
      });
    } else if (env.path) {
      // Safety: only delete something that actually looks like a virtualenv.
      const looksVenv = fs.existsSync(path.join(env.path, "pyvenv.cfg")) || fs.existsSync(path.join(env.path, "bin", "python")) || fs.existsSync(path.join(env.path, "Scripts", "python.exe"));
      if (!looksVenv) return resolve({ ok: false, id, path: envPath, unregistered: false, filesRequested: true, filesRemoved: false, pathStillExists: fs.existsSync(env.path), error: "Path does not look like a virtualenv; files were not deleted." });
      try { fs.rmSync(env.path, { recursive: true, force: true }); finish(true); }
      catch (e: any) { resolve({ ok: false, id, path: envPath, unregistered: false, filesRequested: true, filesRemoved: false, pathStillExists: fs.existsSync(env.path), error: String(e?.message || e) }); }
    } else {
      finish(false);
    }
  });
}

/** Create a new conda / venv / uv environment, then register it. */
export function pyenvCreate(input: {
  manager: EnvManager; name: string; pythonVersion?: string; parentDir?: string; baseInterpreter?: string; description?: string;
}): Promise<{ ok: boolean; env?: PyEnv; error?: string; log?: string }> {
  return new Promise(resolve => {
    const name = String(input.name || "").trim();
    if (!name) return resolve({ ok: false, error: "name is required" });
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return resolve({ ok: false, error: "name may only contain letters, digits, . _ -" });
    const ver = String(input.pythonVersion || "").trim();
    const desc = input.description ? String(input.description).trim() : undefined;
    const run = (cmd: string, args: string[], then: (err: any, out: string) => void) =>
      execFile(cmd, args, { timeout: 600000, maxBuffer: 1 << 24, windowsHide: process.platform === "win32" }, (err, so, se) => then(err, String(so || "") + String(se || "")));

    if (input.manager === "conda") {
      const args = ["create", "-y", "-n", name, ver ? `python=${ver}` : "python"];
      run("conda", args, (err, out) => {
        if (err) return resolve({ ok: false, error: `conda create failed: ${err.message}`, log: out });
        execFile("conda", ["env", "list", "--json"], { timeout: 8000, windowsHide: process.platform === "win32" }, (_e, so) => {
          let prefix = "";
          try { const j = JSON.parse(String(so || "{}")); prefix = (j.envs || []).find((p: string) => path.basename(p) === name) || ""; } catch { /* ignore */ }
          const python = prefix ? path.join(prefix, "bin", "python") : "";
          const env = pyenvAdd({ name, manager: "conda", path: prefix, python, condaName: name, description: desc });
          resolve({ ok: true, env, log: out });
        });
      });
    } else if (input.manager === "venv" || input.manager === "uv") {
      const parent = String(input.parentDir || "").trim();
      if (!parent) return resolve({ ok: false, error: "parent directory is required" });
      if (!fs.existsSync(parent)) return resolve({ ok: false, error: `parent directory not found: ${parent}` });
      const dir = path.join(parent, name);
      if (fs.existsSync(dir)) return resolve({ ok: false, error: `target already exists: ${dir}` });
      const finish = (err: any, out: string) => {
        if (err) return resolve({ ok: false, error: `${input.manager} create failed: ${err.message}`, log: out });
        const python = process.platform === "win32" ? path.join(dir, "Scripts", "python.exe") : path.join(dir, "bin", "python");
        const env = pyenvAdd({ name, manager: input.manager, path: dir, python, description: desc });
        resolve({ ok: true, env, log: out });
      };
      if (input.manager === "venv") {
        run(String(input.baseInterpreter || "python3").trim() || "python3", ["-m", "venv", dir], finish);
      } else {
        const args = ["venv", dir]; if (ver) { args.push("--python", ver); }
        run("uv", args, finish);
      }
    } else {
      resolve({ ok: false, error: "unsupported manager" });
    }
  });
}

// ── Detection ─────────────────────────────────────────────────────────────────
/** List conda environments via `conda env list --json`. */
export function condaEnvs(): Promise<{ name: string; prefix: string; python: string }[]> {
  return new Promise(resolve => {
    execFile("conda", ["env", "list", "--json"], { timeout: 8000, windowsHide: process.platform === "win32" }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const j = JSON.parse(String(stdout || "{}"));
        const out = (j.envs || []).map((p: string) => ({
          name: path.basename(p) || p,
          prefix: p,
          python: path.join(p, "bin", "python"),
        })).filter((e: any) => fs.existsSync(e.python));
        resolve(out);
      } catch { resolve([]); }
    });
  });
}

/** Inspect a folder and classify it as a venv/uv environment. */
export function detectFolderEnv(dir: string): { ok: boolean; manager?: EnvManager; python?: string; error?: string } {
  const d = String(dir || "").trim();
  if (!d || !fs.existsSync(d)) return { ok: false, error: "folder not found" };
  const py = fs.existsSync(path.join(d, "bin", "python")) ? path.join(d, "bin", "python")
    : (fs.existsSync(path.join(d, "Scripts", "python.exe")) ? path.join(d, "Scripts", "python.exe") : "");
  if (!py) return { ok: false, error: "no interpreter (bin/python) under this folder" };
  let manager: EnvManager = "venv";
  const cfg = path.join(d, "pyvenv.cfg");
  if (fs.existsSync(cfg)) {
    try { if (/^\s*uv\s*=/m.test(fs.readFileSync(cfg, "utf-8"))) manager = "uv"; } catch { /* ignore */ }
  }
  return { ok: true, manager, python: py };
}

// ── Packages ──────────────────────────────────────────────────────────────────
export function normalizePkgs(arr: any[]): Pkg[] {
  return (arr || [])
    .map(p => ({ name: String(p.name || "").trim(), version: String(p.version || "").trim() }))
    .filter(p => p.name)
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

// Preserve PATH wrappers/failures; a missing command may use the registered installation.
function condaPackageExecutable(prefix: string, searchPath = process.env.PATH ?? "/usr/bin:/bin"): string {
  if (process.platform !== "linux" || !path.isAbsolute(prefix)) return "conda";
  for (const directory of searchPath.split(path.delimiter)) {
    try {
      fs.lstatSync(path.join(directory || ".", "conda"));
      return "conda";
    } catch (error: any) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return "conda";
    }
  }
  const associated = (candidatePrefix: string): string | undefined => {
    const parent = path.dirname(candidatePrefix);
    const root = path.basename(parent) === "envs" ? path.dirname(parent) : candidatePrefix;
    for (const relative of ["bin/conda", "condabin/conda"]) {
      const executable = path.join(root, relative);
      try {
        fs.lstatSync(executable);
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
        continue;
      }
      if (!fs.statSync(executable).isFile())
        throw new Error(`Associated conda manager is not a regular file: ${executable}`);
      fs.accessSync(executable, fs.constants.X_OK);
      return executable;
    }
    return undefined;
  };
  const logical = associated(prefix);
  if (logical) return logical;
  // Prefix aliases can live outside their installation; never bypass a logical-path error.
  let physical: string;
  try { physical = fs.realpathSync(prefix); }
  catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    return "conda";
  }
  return physical === path.resolve(prefix) ? "conda" : associated(physical) ?? "conda";
}

export type PyenvProbeKind = "packages" | "version" | "size";
export interface PyenvRefreshWorkflow {
  get(id: string): PyEnv | undefined;
  beforeProbe(id: string, kind: PyenvProbeKind): void;
  environment: NodeJS.ProcessEnv;
  readVersionConfig?(id: string, directory: string): string;
  execute(id: string, kind: PyenvProbeKind, program: string, args: string[],
    options: { timeout: number; maxBuffer?: number; windowsHide: boolean },
    done: (error: Error | null, stdout: string) => void): void;
  commitPackages(id: string, value: { capturedAt: string; packages: Pkg[] }): Promise<void>;
  commitMetadata(id: string, patch: Partial<PyEnv>): Promise<void>;
}

/** Read/refresh packages. A scoped workflow supplies its own registry and effect fences. */
export function pyenvPackages(id: string, refresh = false, workflow?: PyenvRefreshWorkflow): Promise<{ packages: Pkg[]; capturedAt: string; cached: boolean; error?: string }> {
  return new Promise(resolve => {
    const env = workflow ? workflow.get(id) : pyenvGet(id);
    if (!env) return resolve({ packages: [], capturedAt: "", cached: false, error: "unknown environment" });
    const cacheFile = pkgCachePath(id);
    if (workflow && !refresh) return resolve({ packages: [], capturedAt: "", cached: false, error: "Scoped package queries require a refresh intent." });
    if (!workflow && !refresh && fs.existsSync(cacheFile)) {
      try { const j = JSON.parse(fs.readFileSync(cacheFile, "utf-8")); return resolve({ packages: j.packages || [], capturedAt: j.capturedAt || "", cached: true }); }
      catch { /* fall through to refresh */ }
    }
    const done = async (packages: Pkg[], error?: string) => {
      const capturedAt = new Date().toISOString();
      if (!error) {
        if (workflow) {
          try { await workflow.commitPackages(id, { capturedAt, packages }); }
          catch (failure) { error = String(failure); }
        } else { try { fs.writeFileSync(cacheFile, JSON.stringify({ capturedAt, packages }, null, 2)); } catch { /* ignore */ } }
      }
      resolve({ packages, capturedAt, cached: false, error });
    };
    try { workflow?.beforeProbe(id, "packages"); }
    catch (error) { void done([], String(error)); return; }
    const execute = (program: string, args: string[], callback: (error: Error | null, stdout: string) => void) => {
      const options = { timeout: 20000, maxBuffer: 1 << 24, windowsHide: process.platform === "win32" };
      if (workflow) workflow.execute(id, "packages", program, args, options, callback);
      else execFile(program, args, options, callback);
    };
    if (env.manager === "conda" && env.path) {
      let executable: string;
      try { executable = condaPackageExecutable(env.path, workflow?.environment.PATH); }
      catch (error: any) { return done([], `conda list failed: ${String(error?.message || error)}`); }
      execute(executable, ["list", "--json", "-p", env.path], (err, stdout) => {
        if (err) return done([], `conda list failed: ${err.message}`);
        try { done(normalizePkgs(JSON.parse(String(stdout || "[]")))); } catch (e: any) { done([], String(e?.message || e)); }
      });
    } else {
      const py = env.python || "python3";
      execute(py, ["-m", "pip", "list", "--format=json"], (err, stdout) => {
        if (err) return done([], `pip list failed: ${err.message}`);
        try { done(normalizePkgs(JSON.parse(String(stdout || "[]")))); } catch (e: any) { done([], String(e?.message || e)); }
      });
    }
  });
}

/** Rough version comparison: compare numeric components left-to-right. */
function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = b.split(/[^0-9]+/).filter(Boolean).map(Number);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x < y ? -1 : 1; }
  return 0;
}

/** Compare two environments -> a union table with a per-package status
 *  (same / upgrade / downgrade / added / deleted). "b" is the target env. */
export async function pyenvCompare(idA: string, idB: string): Promise<any> {
  const a = await pyenvPackages(idA, false);
  const b = await pyenvPackages(idB, false);
  return comparePackageSets(a.packages, b.packages, pyenvGet(idA)?.name || idA, pyenvGet(idB)?.name || idB);
}

export function comparePackageSets(packagesA: Pkg[], packagesB: Pkg[], nameA: string, nameB: string) {
  const a = { packages: packagesA }, b = { packages: packagesB };
  const mapA = new Map(a.packages.map(p => [p.name.toLowerCase(), p]));
  const mapB = new Map(b.packages.map(p => [p.name.toLowerCase(), p]));
  const names = new Set([...mapA.keys(), ...mapB.keys()]);
  const counts: Record<string, number> = { same: 0, upgrade: 0, downgrade: 0, added: 0, deleted: 0 };
  const rows: { name: string; va: string; vb: string; status: string }[] = [];
  for (const k of names) {
    const pa = mapA.get(k), pb = mapB.get(k);
    const va = pa ? pa.version : "", vb = pb ? pb.version : "";
    let status: string;
    if (!pb) status = "deleted";
    else if (!pa) status = "added";
    else if (va === vb) status = "same";
    else { let c = cmpVersion(va, vb); if (c === 0) c = va < vb ? -1 : 1; status = c < 0 ? "upgrade" : "downgrade"; }
    counts[status]++;
    rows.push({ name: (pa || pb)!.name, va, vb, status });
  }
  const order: Record<string, number> = { added: 0, deleted: 1, upgrade: 2, downgrade: 3, same: 4 };
  rows.sort((x, y) => (order[x.status] - order[y.status]) || x.name.toLowerCase().localeCompare(y.name.toLowerCase()));
  return {
    a: { name: nameA, count: a.packages.length },
    b: { name: nameB, count: b.packages.length },
    counts, rows,
  };
}

/** Cross-environment similarity: pairwise compare every registered env by its
 *  package sets to surface near-duplicate environments that could be merged to
 *  reclaim disk space. Pairs on different Python minor versions are skipped
 *  (they can't be merged). Score = Jaccard overlap on package names. */
export async function pyenvSimilarity(): Promise<any> {
  const envs = pyenvList();
  const data: { env: PyEnv; map: Map<string, string> }[] = [];
  for (const e of envs) {
    const pk = await pyenvPackages(e.id, false);
    data.push({ env: e, map: new Map(pk.packages.map(p => [p.name.toLowerCase(), p.version])) });
  }
  return similarPackageSets(data);
}

export function similarPackageSets(data: { env: PyEnv; map: Map<string, string> }[]) {
  const pairs: any[] = [];
  let skipped = 0;
  for (let i = 0; i < data.length; i++) {
    for (let j = i + 1; j < data.length; j++) {
      const A = data[i], B = data[j];
      const mmA = majorMinor(A.env.pyVersion), mmB = majorMinor(B.env.pyVersion);
      if (mmA && mmB && mmA !== mmB) { skipped++; continue; } // different Python -> not mergeable
      const namesA = A.map, namesB = B.map;
      const union = new Set([...namesA.keys(), ...namesB.keys()]);
      let shared = 0, sameVer = 0, diffVer = 0;
      for (const n of namesA.keys()) {
        if (namesB.has(n)) { shared++; if (namesA.get(n) === namesB.get(n)) sameVer++; else diffVer++; }
      }
      const score = union.size ? shared / union.size : 0;
      const exactScore = union.size ? sameVer / union.size : 0;
      const sizeA = A.env.sizeBytes || 0, sizeB = B.env.sizeBytes || 0;
      pairs.push({
        a: { id: A.env.id, name: A.env.name, manager: A.env.manager, size: sizeA, count: namesA.size },
        b: { id: B.env.id, name: B.env.name, manager: B.env.manager, size: sizeB, count: namesB.size },
        py: mmA || mmB || "", score, exactScore, shared, sameVer, diffVer,
        onlyA: namesA.size - shared, onlyB: namesB.size - shared,
        saving: Math.min(sizeA, sizeB), // reclaimable if the smaller is merged away
      });
    }
  }
  pairs.sort((x, y) => (y.score - x.score) || (y.exactScore - x.exactScore));
  return { pairs, count: data.length, skipped };
}

/** Major.minor of a version string, e.g. "3.11.5" -> "3.11". */
function majorMinor(v?: string): string {
  const m = String(v || "").match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : "";
}

export function planPackageMerge(a: PyEnv, b: PyEnv, packagesA: Pkg[], packagesB: Pkg[]) {
  if (a.id === b.id) throw new Error("Pick two different environments.");
  if (majorMinor(a.pyVersion) && majorMinor(b.pyVersion) && majorMinor(a.pyVersion) !== majorMinor(b.pyVersion))
    throw new Error("Different Python minor versions are not mergeable.");
  const mapA = new Map(packagesA.map(p => [p.name.toLowerCase(), p]));
  const mapB = new Map(packagesB.map(p => [p.name.toLowerCase(), p]));
  const swap = mapB.size > mapA.size || (mapB.size === mapA.size && (b.sizeBytes || 0) > (a.sizeBytes || 0));
  const keep = swap ? b : a, drop = swap ? a : b, keepMap = swap ? mapB : mapA, dropMap = swap ? mapA : mapB;
  return { keep, drop, missing: [...dropMap].filter(([key]) => !keepMap.has(key)).map(([, p]) => p),
    differences: [...dropMap].filter(([key, p]) => keepMap.has(key) && keepMap.get(key)!.version !== p.version)
      .map(([key, p]) => ({ name: p.name, keep: keepMap.get(key)!.version, drop: p.version })) };
}

/** Generate a script (never executed by the extension) that merges two similar
 *  environments: keeps the larger one, installs the packages missing from it,
 *  and ends with the command to remove the redundant one. */
export async function pyenvMergeScript(idA: string, idB: string): Promise<{ script?: string; keep?: string; drop?: string; error?: string }> {
  const a = pyenvGet(idA), b = pyenvGet(idB);
  if (!a || !b) return { error: "unknown environment" };
  if (a.id === b.id) return { error: "pick two different environments" };
  const mmA = majorMinor(a.pyVersion), mmB = majorMinor(b.pyVersion);
  if (mmA && mmB && mmA !== mmB) return { error: `different Python versions (${a.pyVersion} vs ${b.pyVersion}) — not mergeable` };
  const pkA = await pyenvPackages(idA, false), pkB = await pyenvPackages(idB, false);
  const { keep, drop, missing: onlyInDrop, differences: verDiff } = planPackageMerge(a, b, pkA.packages, pkB.packages);
  const act = pyenvActivateScript(keep.id).script.split("\n").filter(l => l && !l.startsWith("#")).join("\n");
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `# Merge "${drop.name}" INTO "${keep.name}"  (keeps the larger env, then removes the other)`,
    `# Review carefully — the extension does NOT run this for you.`,
    "",
    `# 1) Activate the environment to KEEP: ${keep.name}`,
    act || "# (no activation command available)",
    "",
    `# 2) Install the ${onlyInDrop.length} package(s) that exist only in "${drop.name}":`,
  ];
  if (onlyInDrop.length) {
    const specs = onlyInDrop.sort((x, y) => x.name.localeCompare(y.name)).map(p => `"${p.name}==${p.version}"`).join(" ");
    lines.push(`python -m pip install ${specs}`);
    if (keep.manager === "conda") lines.push("#   (some may be conda-managed — use `conda install` if pip cannot resolve them)");
  } else {
    lines.push(`#   none — "${keep.name}" already contains every package in "${drop.name}".`);
  }
  lines.push("");
  if (verDiff.length) {
    lines.push(`# 3) ${verDiff.length} package(s) differ in version (keeping "${keep.name}"'s). Review if you need "${drop.name}"'s versions:`);
    for (const d of verDiff.sort((x, y) => x.name.localeCompare(y.name)).slice(0, 300)) {
      lines.push(`#    ${d.name}: keep ${d.keep}  vs  drop ${d.drop}`);
    }
    lines.push("");
  }
  lines.push(`# ${verDiff.length ? 4 : 3}) After verifying "${keep.name}" works, delete the redundant environment "${drop.name}":`);
  if (drop.manager === "conda") {
    if (drop.path && drop.path.includes("/envs/")) lines.push(`conda env remove -y -p "${drop.path}"`);
    else lines.push(`# refusing to generate removal of a conda base/root env: ${drop.path}`);
  } else if (drop.path) {
    lines.push(`rm -rf "${drop.path}"`);
  }
  return { script: lines.join("\n") + "\n", keep: keep.name, drop: drop.name };
}

// ── Size & activation ─────────────────────────────────────────────────────────
export function humanSize(b: number): string {
  if (!b || b < 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 || n >= 100 ? 0 : 1)} ${u[i]}`;
}

/** Compute (or read cached) on-disk size of the environment folder via `du`. */
export function pyenvSize(id: string, refresh = false, workflow?: PyenvRefreshWorkflow): Promise<{ bytes: number; human: string; at: string; cached: boolean; error?: string }> {
  return new Promise(resolve => {
    const env = workflow ? workflow.get(id) : pyenvGet(id);
    if (!env || !env.path) return resolve({ bytes: 0, human: "", at: "", cached: false, error: "unknown environment" });
    if (!refresh && typeof env.sizeBytes === "number") {
      return resolve({ bytes: env.sizeBytes, human: humanSize(env.sizeBytes), at: env.sizeAt || "", cached: true });
    }
    try { workflow?.beforeProbe(id, "size"); }
    catch (error) { resolve({ bytes: 0, human: "", at: "", cached: false, error: String(error) }); return; }
    const done = async (err: Error | null, stdout: string) => {
      if (err) return resolve({ bytes: 0, human: "", at: "", cached: false, error: `du failed: ${err.message}` });
      const kb = parseInt(String(stdout).split(/\s+/)[0], 10) || 0;
      const bytes = kb * 1024;
      const at = new Date().toISOString();
      if (workflow) {
        try { await workflow.commitMetadata(id, { sizeBytes: bytes, sizeAt: at }); }
        catch (error) { resolve({ bytes: 0, human: "", at: "", cached: false, error: String(error) }); return; }
      } else pyenvUpdate(id, { sizeBytes: bytes, sizeAt: at });
      resolve({ bytes, human: humanSize(bytes), at, cached: false });
    };
    const options = { timeout: 120000, maxBuffer: 1 << 20, windowsHide: process.platform === "win32" };
    if (workflow) workflow.execute(id, "size", "du", ["-sk", env.path], options, done);
    else execFile("du", ["-sk", env.path], options, done);
  });
}

/** Read the Python version (X.Y.Z) from a venv/uv's pyvenv.cfg, if present. */
function readVenvCfgVersion(dir: string, read?: () => string): string {
  try {
    const cfg = read ? read() : fs.readFileSync(path.join(dir, "pyvenv.cfg"), "utf-8");
    const m = cfg.match(/^\s*version(?:_info)?\s*=\s*([0-9]+\.[0-9]+(?:\.[0-9]+)?)/mi);
    if (m) return m[1];
  } catch { /* ignore */ }
  return "";
}

/** Detect (or read cached) Python version for an environment. */
export function pyenvPyVersion(id: string, refresh = false, workflow?: PyenvRefreshWorkflow): Promise<{ version: string; cached: boolean; error?: string }> {
  return new Promise(resolve => {
    const env = workflow ? workflow.get(id) : pyenvGet(id);
    if (!env) return resolve({ version: "", cached: false, error: "unknown environment" });
    if (!refresh && env.pyVersion) return resolve({ version: env.pyVersion, cached: true });
    try { workflow?.beforeProbe(id, "version"); }
    catch (error) { resolve({ version: "", cached: false, error: String(error) }); return; }
    const done = async (version: string, error?: string) => {
      if (version) {
        if (workflow) {
          try { await workflow.commitMetadata(id, { pyVersion: version }); }
          catch (failure) { error = String(failure); version = ""; }
        } else pyenvUpdate(id, { pyVersion: version });
      }
      resolve(error === undefined ? { version, cached: false } : { version, cached: false, error });
    };
    if (env.path) {
      const v = readVenvCfgVersion(env.path, workflow?.readVersionConfig ? () => workflow.readVersionConfig!(id, env.path) : undefined);
      if (v) { void done(v); return; }
    }
    const py = env.python || (env.path ? path.join(env.path, "bin", "python") : "python3");
    const completed = (err: Error | null, stdout: string) => {
      if (err) return resolve({ version: "", cached: false, error: err.message });
      const v = String(stdout || "").trim();
      void done(v);
    };
    const args = ["-c", "import platform;print(platform.python_version())"];
    const options = { timeout: 8000, windowsHide: process.platform === "win32" };
    if (workflow) workflow.execute(id, "version", py, args, options, completed);
    else execFile(py, args, options, completed);
  });
}

/** A bash snippet that activates this environment (conda activate / source activate). */
export function pyenvActivateScript(id: string): { script: string; error?: string } {
  const env = pyenvGet(id);
  if (!env) return { script: "", error: "unknown environment" };
  const lines = ["#!/usr/bin/env bash", `# Activate: ${env.name} (${env.manager})`];
  if (env.manager === "conda" && env.path) {
    const root = env.path.includes("/envs/") ? env.path.slice(0, env.path.indexOf("/envs/")) : env.path;
    lines.push(`source "${root}/etc/profile.d/conda.sh"`, `conda activate "${env.path}"`);
  } else if (env.path) {
    lines.push(`source "${env.path}/bin/activate"`);
  } else if (env.python) {
    lines.push(`export PATH="${path.dirname(env.python)}:$PATH"`);
  }
  return { script: lines.join("\n") + "\n" };
}

/** Conda install root for a prefix (strips a trailing /envs/<name> or \envs\<name>). */
function condaRoot(prefix: string): string {
  const i1 = prefix.indexOf("/envs/"), i2 = prefix.indexOf("\\envs\\");
  const i = i1 >= 0 ? i1 : i2;
  return i >= 0 ? prefix.slice(0, i) : prefix;
}

/** Platform-aware activation commands to send to an interactive terminal.
 *  Windows → PowerShell (Activate.ps1 / conda-hook.ps1); otherwise POSIX bash. */
export function pyenvActivateCommands(id: string): { lines: string[]; display: string; shell: "powershell" | "posix"; error?: string } {
  const env = pyenvGet(id);
  if (!env) return { lines: [], display: "", shell: "posix", error: "unknown environment" };
  const win = process.platform === "win32";
  const lines: string[] = [];
  if (env.manager === "conda" && env.path) {
    const root = condaRoot(env.path);
    if (win) {
      lines.push(`& "${root}\\shell\\condabin\\conda-hook.ps1"`, `conda activate "${env.path}"`);
    } else {
      lines.push(`source "${root}/etc/profile.d/conda.sh"`, `conda activate "${env.path}"`);
    }
  } else if (env.path) {
    if (win) lines.push(`& "${env.path}\\Scripts\\Activate.ps1"`);
    else lines.push(`source "${env.path}/bin/activate"`);
  } else if (env.python) {
    if (win) lines.push(`$env:Path = "${path.dirname(env.python)};" + $env:Path`);
    else lines.push(`export PATH="${path.dirname(env.python)}:$PATH"`);
  }
  const header = win ? `# PowerShell — activate ${env.name} (${env.manager})` : `#!/usr/bin/env bash\n# Activate ${env.name} (${env.manager})`;
  return { lines, display: header + "\n" + lines.join("\n") + "\n", shell: win ? "powershell" : "posix" };
}
export function pyenvDeleteScript(id: string): { script: string; error?: string } {
  const env = pyenvGet(id);
  if (!env) return { script: "", error: "unknown environment" };
  const lines = ["#!/usr/bin/env bash", "set -e", `# Delete environment: ${env.name} (${env.manager})`];
  if (env.manager === "conda") {
    if (!env.path || !env.path.includes("/envs/")) {
      return { script: "", error: "refusing to generate a delete script for the conda base environment" };
    }
    lines.push(`conda env remove -y -p "${env.path}"`);
  } else if (env.path) {
    lines.push(`# This permanently removes the environment folder.`, `rm -rf "${env.path}"`);
  } else {
    return { script: "", error: "environment has no folder path to delete" };
  }
  return { script: lines.join("\n") + "\n" };
}

// ── Migration (move into the extension-managed location) ──────────────────────
/** Rewrite hard-coded old paths to the new path inside a venv's bin/* scripts
 *  and pyvenv.cfg (skips symlinks and binary files). */
function fixupVenvPaths(root: string, oldPath: string, newPath: string): void {
  const targets: string[] = [];
  const binDir = path.join(root, "bin");
  try { for (const f of fs.readdirSync(binDir)) targets.push(path.join(binDir, f)); } catch { /* ignore */ }
  targets.push(path.join(root, "pyvenv.cfg"));
  for (const f of targets) {
    try {
      const st = fs.lstatSync(f);
      if (!st.isFile()) continue;            // skip symlinks (e.g. bin/python)
      if (st.size > 2_000_000) continue;      // skip large binaries
      const buf = fs.readFileSync(f);
      if (buf.includes(0)) continue;          // skip binary files
      const txt = buf.toString("utf-8");
      if (!txt.includes(oldPath)) continue;
      fs.writeFileSync(f, txt.split(oldPath).join(newPath));
    } catch { /* ignore */ }
  }
}

/** Move an environment into `destRoot`. conda envs are cloned (relocatable),
 *  venv/uv envs are moved with in-place path fixups. Registry is updated. */
export async function pyenvMigrate(id: string, destRoot: string): Promise<{ ok: boolean; error?: string; log?: string; env?: PyEnv }> {
  const env = pyenvGet(id);
  if (!env) return { ok: false, error: "unknown environment" };
  if (!destRoot) return { ok: false, error: "no target directory configured" };
  if (!env.path) return { ok: false, error: "environment has no folder path" };
  const dest = path.join(destRoot, slugify(env.name) || env.id);
  if (path.resolve(env.path) === path.resolve(dest)) return { ok: false, error: "already in the managed location" };
  if (fs.existsSync(dest)) return { ok: false, error: `target already exists: ${dest}` };
  try { fs.mkdirSync(destRoot, { recursive: true }); } catch { /* ignore */ }

  const runP = (cmd: string, args: string[]) => new Promise<{ err: any; out: string }>(res =>
    execFile(cmd, args, { timeout: 1800000, maxBuffer: 1 << 24, windowsHide: process.platform === "win32" }, (err, so, se) => res({ err, out: String(so || "") + String(se || "") })));

  if (env.manager === "conda") {
    if (!env.path.includes("/envs/")) return { ok: false, error: "refusing to migrate the conda base environment" };
    const c = await runP("conda", ["create", "-y", "-p", dest, "--clone", env.path]);
    if (c.err) { try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ } return { ok: false, error: `conda clone failed: ${c.err.message}`, log: c.out }; }
    const r = await runP("conda", ["env", "remove", "-y", "-p", env.path]);
    pyenvUpdate(id, { path: dest, python: path.join(dest, "bin", "python"), condaName: undefined, sizeBytes: undefined, sizeAt: undefined });
    return { ok: true, env: pyenvGet(id), log: c.out + (r.err ? `\n[warn] old env not removed: ${r.err.message}` : "") };
  }

  // venv / uv: move the folder, then fix up hard-coded paths.
  if (!fs.existsSync(env.path)) return { ok: false, error: "env folder not found" };
  const src = env.path;
  try {
    try { fs.renameSync(src, dest); }
    catch { fs.cpSync(src, dest, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); }
    fixupVenvPaths(dest, src, dest);
    pyenvUpdate(id, { path: dest, python: path.join(dest, "bin", "python"), sizeBytes: undefined, sizeAt: undefined });
    return { ok: true, env: pyenvGet(id) };
  } catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
}

