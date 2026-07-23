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

export function pyenvDelete(id: string, removeFiles = false): Promise<{ ok: boolean; error?: string }> {
  return new Promise(resolve => {
    const env = pyenvGet(id);
    const unregister = () => {
      writeReg(readReg().filter(e => e.id !== id));
      try { fs.rmSync(pkgCachePath(id), { force: true }); } catch { /* ignore */ }
      resolve({ ok: true });
    };
    if (!removeFiles || !env) return unregister();
    if (env.manager === "conda") {
      if (!env.path || !env.path.includes("/envs/")) {
        return resolve({ ok: false, error: "refusing to delete the conda base environment from disk" });
      }
      execFile("conda", ["env", "remove", "-y", "-p", env.path], { timeout: 120000 }, (err) => {
        if (err) return resolve({ ok: false, error: `conda env remove failed: ${err.message}` });
        unregister();
      });
    } else if (env.path) {
      // Safety: only delete something that actually looks like a virtualenv.
      const looksVenv = fs.existsSync(path.join(env.path, "pyvenv.cfg")) || fs.existsSync(path.join(env.path, "bin", "python"));
      if (!looksVenv) return resolve({ ok: false, error: "path does not look like a virtualenv — not deleting" });
      try { fs.rmSync(env.path, { recursive: true, force: true }); unregister(); }
      catch (e: any) { resolve({ ok: false, error: String(e?.message || e) }); }
    } else {
      unregister();
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
      execFile(cmd, args, { timeout: 600000, maxBuffer: 1 << 24 }, (err, so, se) => then(err, String(so || "") + String(se || "")));

    if (input.manager === "conda") {
      const args = ["create", "-y", "-n", name, ver ? `python=${ver}` : "python"];
      run("conda", args, (err, out) => {
        if (err) return resolve({ ok: false, error: `conda create failed: ${err.message}`, log: out });
        execFile("conda", ["env", "list", "--json"], { timeout: 8000 }, (_e, so) => {
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
        const env = pyenvAdd({ name, manager: input.manager, path: dir, python: path.join(dir, "bin", "python"), description: desc });
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
    execFile("conda", ["env", "list", "--json"], { timeout: 8000 }, (err, stdout) => {
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
function normalizePkgs(arr: any[]): Pkg[] {
  return (arr || [])
    .map(p => ({ name: String(p.name || "").trim(), version: String(p.version || "").trim() }))
    .filter(p => p.name)
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

/** Read/refresh the package list for an environment. */
export function pyenvPackages(id: string, refresh = false): Promise<{ packages: Pkg[]; capturedAt: string; cached: boolean; error?: string }> {
  return new Promise(resolve => {
    const env = pyenvGet(id);
    if (!env) return resolve({ packages: [], capturedAt: "", cached: false, error: "unknown environment" });
    const cacheFile = pkgCachePath(id);
    if (!refresh && fs.existsSync(cacheFile)) {
      try { const j = JSON.parse(fs.readFileSync(cacheFile, "utf-8")); return resolve({ packages: j.packages || [], capturedAt: j.capturedAt || "", cached: true }); }
      catch { /* fall through to refresh */ }
    }
    const done = (packages: Pkg[], error?: string) => {
      const capturedAt = new Date().toISOString();
      if (!error) { try { fs.writeFileSync(cacheFile, JSON.stringify({ capturedAt, packages }, null, 2)); } catch { /* ignore */ } }
      resolve({ packages, capturedAt, cached: false, error });
    };
    if (env.manager === "conda" && env.path) {
      execFile("conda", ["list", "--json", "-p", env.path], { timeout: 20000, maxBuffer: 1 << 24 }, (err, stdout) => {
        if (err) return done([], `conda list failed: ${err.message}`);
        try { done(normalizePkgs(JSON.parse(String(stdout || "[]")))); } catch (e: any) { done([], String(e?.message || e)); }
      });
    } else {
      const py = env.python || "python3";
      execFile(py, ["-m", "pip", "list", "--format=json"], { timeout: 20000, maxBuffer: 1 << 24 }, (err, stdout) => {
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
  const envA = pyenvGet(idA), envB = pyenvGet(idB);
  return {
    a: { name: envA?.name || idA, count: a.packages.length },
    b: { name: envB?.name || idB, count: b.packages.length },
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
  return { pairs, count: envs.length, skipped };
}

/** Major.minor of a version string, e.g. "3.11.5" -> "3.11". */
function majorMinor(v?: string): string {
  const m = String(v || "").match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : "";
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
  const mapA = new Map(pkA.packages.map(p => [p.name.toLowerCase(), p]));
  const mapB = new Map(pkB.packages.map(p => [p.name.toLowerCase(), p]));
  // Keep the env with more packages (tie-break: larger on disk).
  let keep = a, drop = b, keepMap = mapA, dropMap = mapB;
  if (mapB.size > mapA.size || (mapB.size === mapA.size && (b.sizeBytes || 0) > (a.sizeBytes || 0))) {
    keep = b; drop = a; keepMap = mapB; dropMap = mapA;
  }
  const onlyInDrop: Pkg[] = [];
  const verDiff: { name: string; keep: string; drop: string }[] = [];
  for (const [k, p] of dropMap) {
    const q = keepMap.get(k);
    if (!q) onlyInDrop.push(p);
    else if (q.version !== p.version) verDiff.push({ name: p.name, keep: q.version, drop: p.version });
  }
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
export function pyenvSize(id: string, refresh = false): Promise<{ bytes: number; human: string; at: string; cached: boolean; error?: string }> {
  return new Promise(resolve => {
    const env = pyenvGet(id);
    if (!env || !env.path) return resolve({ bytes: 0, human: "", at: "", cached: false, error: "unknown environment" });
    if (!refresh && typeof env.sizeBytes === "number") {
      return resolve({ bytes: env.sizeBytes, human: humanSize(env.sizeBytes), at: env.sizeAt || "", cached: true });
    }
    execFile("du", ["-sk", env.path], { timeout: 120000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return resolve({ bytes: 0, human: "", at: "", cached: false, error: `du failed: ${err.message}` });
      const kb = parseInt(String(stdout).split(/\s+/)[0], 10) || 0;
      const bytes = kb * 1024;
      const at = new Date().toISOString();
      pyenvUpdate(id, { sizeBytes: bytes, sizeAt: at });
      resolve({ bytes, human: humanSize(bytes), at, cached: false });
    });
  });
}

/** Read the Python version (X.Y.Z) from a venv/uv's pyvenv.cfg, if present. */
function readVenvCfgVersion(dir: string): string {
  try {
    const cfg = fs.readFileSync(path.join(dir, "pyvenv.cfg"), "utf-8");
    const m = cfg.match(/^\s*version(?:_info)?\s*=\s*([0-9]+\.[0-9]+(?:\.[0-9]+)?)/mi);
    if (m) return m[1];
  } catch { /* ignore */ }
  return "";
}

/** Detect (or read cached) Python version for an environment. */
export function pyenvPyVersion(id: string, refresh = false): Promise<{ version: string; cached: boolean; error?: string }> {
  return new Promise(resolve => {
    const env = pyenvGet(id);
    if (!env) return resolve({ version: "", cached: false, error: "unknown environment" });
    if (!refresh && env.pyVersion) return resolve({ version: env.pyVersion, cached: true });
    if (env.path) {
      const v = readVenvCfgVersion(env.path);
      if (v) { pyenvUpdate(id, { pyVersion: v }); return resolve({ version: v, cached: false }); }
    }
    const py = env.python || (env.path ? path.join(env.path, "bin", "python") : "python3");
    execFile(py, ["-c", "import platform;print(platform.python_version())"], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve({ version: "", cached: false, error: err.message });
      const v = String(stdout || "").trim();
      if (v) pyenvUpdate(id, { pyVersion: v });
      resolve({ version: v, cached: false });
    });
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

/** A bash snippet that deletes this environment. The extension never runs it —
 *  it is shown to the user to review and execute manually. */
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
    execFile(cmd, args, { timeout: 1800000, maxBuffer: 1 << 24 }, (err, so, se) => res({ err, out: String(so || "") + String(se || "") })));

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


