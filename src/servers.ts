// Server manager: each server is an isolated "package" the extension owns, living
// under <store>/servers/<slug>/ (code + a server.json manifest, git-tracked and
// syncable). Servers are started as detached OS processes so they survive VS Code
// restarts; runtime status (pid/port) is tracked machine-locally in globalStorage
// and reconciled on activation. A fixed-port reverse proxy maps stable
// /s/<slug>/ URLs to each server's current port so Notes links never break.
import { spawn, execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as net from "net";

export interface ServerManifest {
  name: string;
  command: string;          // supports {python} and {port} placeholders
  port: number;
  python?: string;          // interpreter path (or blank -> python3)
  autostart?: boolean;
}

interface RunState {
  pid: number;              // process-group leader pid (spawned detached)
  port: number;
  startedAt: string;
  logFile: string;
  command: string;
}

let _serversDir = "";       // <store>/servers  (code + manifests; git-tracked)
let _stateDir = "";         // globalStorage/servers  (state + logs; machine-local)
let _proxyPort = 39501;
let _proxy: http.Server | undefined;
let _log: (m: string) => void = () => {};

export function initServers(serversDir: string, stateDir: string, proxyPort: number, logger?: (m: string) => void): void {
  _serversDir = serversDir;
  _stateDir = stateDir;
  _proxyPort = proxyPort || 39501;
  if (logger) _log = logger;
  try { fs.mkdirSync(_serversDir, { recursive: true }); } catch { /* ignore */ }
  try { fs.mkdirSync(path.join(_stateDir, "logs"), { recursive: true }); } catch { /* ignore */ }
  reconcile();
  startProxy();
  for (const slug of listSlugs()) {
    const m = readManifest(slug);
    if (m?.autostart) { const st = readState()[slug]; if (!st || !isAlive(st.pid)) { try { startServer(slug); } catch { /* ignore */ } } }
  }
}

export function setServersDir(dir: string): void {
  _serversDir = dir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

export function disposeServers(): void {
  // Managed servers keep running across VS Code restarts (reconciled on next
  // activation). Only the proxy (tied to the extension host) is torn down.
  try { _proxy?.close(); } catch { /* ignore */ }
  _proxy = undefined;
}

export function proxyPort(): number { return _proxyPort; }

/** Absolute path to a server's managed folder (its code + any data it writes). */
export function serverDir(slug: string): string { return serverDirOf(slug); }

// ── Store-backed registry (one folder per server) ────────────────────────────
function listSlugs(): string[] {
  try {
    return fs.readdirSync(_serversDir)
      .filter(n => !n.startsWith(".") && fs.existsSync(path.join(_serversDir, n, "server.json")));
  } catch { return []; }
}
function serverDirOf(slug: string): string { return path.join(_serversDir, slug); }
function manifestPath(slug: string): string { return path.join(serverDirOf(slug), "server.json"); }
function readManifest(slug: string): ServerManifest | null {
  try {
    const j = JSON.parse(fs.readFileSync(manifestPath(slug), "utf-8"));
    return {
      name: String(j.name || slug),
      command: String(j.command || "{python} -m http.server {port}"),
      port: Number(j.port) || 8000,
      python: j.python ? String(j.python) : "",
      autostart: !!j.autostart,
    };
  } catch { return null; }
}
function writeManifest(slug: string, m: ServerManifest): void {
  fs.mkdirSync(serverDirOf(slug), { recursive: true });
  fs.writeFileSync(manifestPath(slug), JSON.stringify(m, null, 2) + "\n");
}

// ── Machine-local runtime state ──────────────────────────────────────────────
function statePath(): string { return path.join(_stateDir, "state.json"); }
function readState(): Record<string, RunState> {
  try { const j = JSON.parse(fs.readFileSync(statePath(), "utf-8")); return (j && typeof j === "object") ? j : {}; }
  catch { return {}; }
}
function writeState(s: Record<string, RunState>): void {
  try { fs.mkdirSync(_stateDir, { recursive: true }); fs.writeFileSync(statePath(), JSON.stringify(s, null, 2) + "\n"); } catch { /* ignore */ }
}
function isAlive(pid: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function probePort(port: number): Promise<boolean> {
  return new Promise(resolve => {
    if (!port) return resolve(false);
    const sock = net.connect({ host: "127.0.0.1", port, timeout: 600 });
    const done = (up: boolean) => { try { sock.destroy(); } catch { /* ignore */ } resolve(up); };
    sock.on("connect", () => done(true));
    sock.on("error", () => done(false));
    sock.on("timeout", () => done(false));
  });
}
function reconcile(): void {
  const st = readState();
  let changed = false;
  for (const slug of Object.keys(st)) if (!isAlive(st[slug].pid)) { delete st[slug]; changed = true; }
  if (changed) writeState(st);
}

function slugify(s: string): string {
  return String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "server";
}
function uniqueSlug(name: string): string {
  const used = new Set(listSlugs());
  let slug = slugify(name);
  if (used.has(slug)) { let i = 2; while (used.has(`${slug}-${i}`)) i++; slug = `${slug}-${i}`; }
  return slug;
}

// Inspect a directory for a serve script and default port.
function detectInDir(dir: string): { command: string; port: number } {
  let command = "{python} -m http.server {port}";
  let port = 8000;
  try {
    for (const name of ["serve.sh", "start_server.sh", "run.sh"]) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) {
        command = `bash ${name} {port}`;
        const m = /(?:PORT|DEFAULT_PORT)\s*=\s*(\d{2,5})/.exec(fs.readFileSync(p, "utf-8"));
        if (m) port = Number(m[1]);
        break;
      }
    }
  } catch { /* ignore */ }
  return { command, port };
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name), d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isSymbolicLink()) { try { fs.symlinkSync(fs.readlinkSync(s), d); } catch { /* ignore */ } }
    else fs.copyFileSync(s, d);
  }
}

// ── Registry operations ──────────────────────────────────────────────────────
/** Move an existing folder into the store as a managed server package. */
export function serverImport(sourceDir: string, name?: string): { ok: boolean; slug?: string; error?: string } {
  const src = String(sourceDir || "").trim();
  if (!src || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) return { ok: false, error: "not a folder" };
  const nm = (name || path.basename(src)).trim();
  const slug = uniqueSlug(nm);
  const dest = serverDirOf(slug);
  fs.mkdirSync(_serversDir, { recursive: true });
  try { fs.renameSync(src, dest); }
  catch { try { copyDir(src, dest); fs.rmSync(src, { recursive: true, force: true }); } catch (e: any) { return { ok: false, error: String(e?.message || e) }; } }
  const det = detectInDir(dest);
  writeManifest(slug, { name: nm, command: det.command, port: det.port, python: "", autostart: false });
  return { ok: true, slug };
}

/** Create a new empty server package with a starter index.html. */
export function serverCreate(name: string): { ok: boolean; slug?: string } {
  const slug = uniqueSlug(name || "server");
  const dir = serverDirOf(slug);
  fs.mkdirSync(dir, { recursive: true });
  const idx = path.join(dir, "index.html");
  if (!fs.existsSync(idx)) {
    fs.writeFileSync(idx, `<!doctype html><meta charset="utf-8"><title>${name || slug}</title>\n<body style="font:16px system-ui;margin:40px"><h1>${name || slug}</h1><p>Put your app here.</p></body>\n`);
  }
  writeManifest(slug, { name: name || slug, command: "{python} -m http.server {port}", port: 8000, python: "", autostart: false });
  return { ok: true, slug };
}

export function serverUpdate(slug: string, patch: Partial<ServerManifest>): boolean {
  const m = readManifest(slug);
  if (!m) return false;
  writeManifest(slug, {
    name: patch.name !== undefined ? String(patch.name).trim() : m.name,
    command: patch.command !== undefined ? String(patch.command).trim() : m.command,
    port: patch.port !== undefined ? (Number(patch.port) || m.port) : m.port,
    python: patch.python !== undefined ? String(patch.python).trim() : m.python,
    autostart: patch.autostart !== undefined ? !!patch.autostart : m.autostart,
  });
  return true;
}

export function serverDelete(slug: string): boolean {
  stopServer(slug);
  try { fs.rmSync(serverDirOf(slug), { recursive: true, force: true }); } catch { /* ignore */ }
  const st = readState(); if (st[slug]) { delete st[slug]; writeState(st); }
  return true;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
function resolvePython(m: ServerManifest): string {
  const py = (m.python || "").trim();
  return py || "python3";
}

export function startServer(slug: string): { ok: boolean; error?: string } {
  const m = readManifest(slug);
  if (!m) return { ok: false, error: "unknown server" };
  const dir = serverDirOf(slug);
  if (!fs.existsSync(dir)) return { ok: false, error: `directory not found: ${dir}` };
  const st = readState();
  if (st[slug] && isAlive(st[slug].pid)) return { ok: true };

  const port = Number(m.port) || 8000;
  const cmd = m.command.replace(/\{python\}/g, resolvePython(m)).replace(/\{port\}/g, String(port));
  const logFile = path.join(_stateDir, "logs", `${slug}.log`);
  let fd: number;
  try { fd = fs.openSync(logFile, "a"); } catch (e: any) { return { ok: false, error: `cannot open log: ${e?.message}` }; }
  try {
    fs.writeSync(fd, `\n=== start ${new Date().toISOString()} :: ${cmd}  (cwd=${dir}, PORT=${port}) ===\n`);
    const child = spawn("bash", ["-c", cmd], {
      cwd: dir,
      detached: true,                                       // own process group
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", fd, fd],
    });
    child.on("error", err => { try { fs.writeSync(fd, `spawn error: ${err}\n`); } catch { /* ignore */ } });
    child.unref();
    if (!child.pid) return { ok: false, error: "failed to spawn" };
    st[slug] = { pid: child.pid, port, startedAt: new Date().toISOString(), logFile, command: cmd };
    writeState(st);
    _log(`server start: ${slug} pid=${child.pid} port=${port}`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

export function stopServer(slug: string): { ok: boolean } {
  const st = readState();
  const run = st[slug];
  if (!run) return { ok: true };
  const pid = run.pid;
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ } }
  setTimeout(() => { if (isAlive(pid)) { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ } } } }, 1500);
  delete st[slug];
  writeState(st);
  _log(`server stop: ${slug} pid=${pid}`);
  return { ok: true };
}

export async function restartServer(slug: string): Promise<{ ok: boolean; error?: string }> {
  stopServer(slug);
  await new Promise(r => setTimeout(r, 1600));
  return startServer(slug);
}

export async function setServerPort(slug: string, port: number): Promise<{ ok: boolean; error?: string }> {
  if (!serverUpdate(slug, { port })) return { ok: false, error: "unknown server" };
  const wasRunning = !!readState()[slug];
  return wasRunning ? restartServer(slug) : { ok: true };
}

// ── Status / logs / python envs ──────────────────────────────────────────────
export async function serverList(): Promise<any[]> {
  const st = readState();
  const out: any[] = [];
  for (const slug of listSlugs().sort()) {
    const m = readManifest(slug);
    if (!m) continue;
    const run = st[slug];
    let status = "stopped", pid = 0, activePort = m.port, startedAt = "";
    if (run && isAlive(run.pid)) {
      pid = run.pid; activePort = run.port; startedAt = run.startedAt;
      status = (await probePort(activePort)) ? "running" : "starting";
    }
    out.push({
      slug, name: m.name, dir: serverDirOf(slug), command: m.command, port: m.port,
      python: m.python || "", autostart: !!m.autostart, status, pid, activePort, startedAt,
      stableUrl: `http://localhost:${_proxyPort}/s/${slug}/`,
      localUrl: `http://localhost:${activePort}/`,
    });
  }
  return out;
}

export function serverLog(slug: string, lines = 300): string {
  const file = readState()[slug]?.logFile || path.join(_stateDir, "logs", `${slug}.log`);
  try { return fs.readFileSync(file, "utf-8").split("\n").slice(-lines).join("\n"); }
  catch { return "(no log yet)"; }
}

/** Detect available Python interpreters (conda envs, current python3). */
export function listPythonEnvs(): Promise<{ label: string; path: string }[]> {
  return new Promise(resolve => {
    const out: { label: string; path: string }[] = [];
    const seen = new Set<string>();
    const add = (label: string, p: string) => { if (p && !seen.has(p) && fs.existsSync(p)) { seen.add(p); out.push({ label, path: p }); } };
    execFile("bash", ["-lc", "command -v python3 || true"], { timeout: 4000 }, (_e, sysOut) => {
      const sys = String(sysOut || "").trim().split("\n")[0];
      if (sys) add("system python3", sys);
      execFile("conda", ["env", "list", "--json"], { timeout: 6000 }, (err, condaOut) => {
        if (!err) {
          try {
            const j = JSON.parse(String(condaOut || "{}"));
            for (const p of (j.envs || [])) {
              const py = path.join(p, "bin", "python");
              add("conda: " + (path.basename(p) || p), py);
            }
          } catch { /* ignore */ }
        }
        resolve(out);
      });
    });
  });
}

// ── Reverse proxy: stable /s/<slug>/ → the server's current port ──────────────
function proxyTo(slug: string, targetPath: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  const run = readState()[slug];
  const man = readManifest(slug);
  const port = (run && isAlive(run.pid)) ? run.port : (man ? man.port : 0);
  if (!port) { res.writeHead(502, { "Content-Type": "text/plain" }); res.end(`Server "${slug}" is not running`); return; }
  const headers = { ...req.headers, host: `127.0.0.1:${port}` };
  const preq = http.request({ host: "127.0.0.1", port, path: targetPath, method: req.method, headers }, pres => {
    const ct = String(pres.headers["content-type"] || "");
    if (/text\/html/i.test(ct)) {
      const chunks: Buffer[] = [];
      pres.on("data", c => chunks.push(c));
      pres.on("end", () => {
        let body = Buffer.concat(chunks).toString("utf-8");
        const base = `/s/${slug}/`;
        body = body.replace(/(<head[^>]*>)/i, `$1<base href="${base}">`);
        body = body.replace(/((?:src|href|action)\s*=\s*["'])\/(?!\/)/gi, `$1${base}`);
        const h = { ...pres.headers }; delete h["content-length"];
        res.writeHead(pres.statusCode || 200, h);
        res.end(body);
      });
    } else {
      res.writeHead(pres.statusCode || 200, pres.headers);
      pres.pipe(res);
    }
  });
  preq.on("error", () => { if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" }); res.end(`Cannot reach "${slug}" on port ${port}`); });
  req.pipe(preq);
}

// Attribute a root-absolute request (e.g. an app's fetch('/api/…')) back to the
// server whose page issued it, using the Referer header.
function slugFromReferer(req: http.IncomingMessage): string | undefined {
  const rm = /\/s\/([^/]+)\//.exec(String(req.headers.referer || ""));
  return rm ? decodeURIComponent(rm[1]) : undefined;
}

function startProxy(): void {
  if (_proxy) return;
  _proxy = http.createServer((req, res) => {
    const url = req.url || "/";
    const m = /^\/s\/([^/]+)(\/.*)?$/.exec(url);
    if (m) {
      const slug = decodeURIComponent(m[1]);
      if (m[2] === undefined || m[2] === "") { res.writeHead(302, { Location: `/s/${slug}/` }); res.end(); return; }
      return proxyTo(slug, m[2], req, res);
    }
    // Not a /s/<slug>/ path: route via Referer so absolute app paths work.
    const refSlug = slugFromReferer(req);
    if (refSlug) return proxyTo(refSlug, url, req, res);
    if (url === "/" || url === "") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(indexPage()); return; }
    res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found");
  });
  _proxy.on("error", e => _log(`servers proxy error: ${e}`));
  _proxy.listen(_proxyPort, "127.0.0.1", () => _log(`servers proxy on http://127.0.0.1:${_proxyPort}`));
}

function indexPage(): string {
  const st = readState();
  const rows = listSlugs().sort().map(slug => {
    const m = readManifest(slug);
    const up = st[slug] && isAlive(st[slug].pid);
    return `<li><a href="/s/${encodeURIComponent(slug)}/">${m?.name || slug}</a> <small>(${up ? "running" : "stopped"} · ${slug})</small></li>`;
  }).join("");
  return `<!doctype html><meta charset="utf-8"><title>Personal Knowledge — Servers</title>` +
    `<body style="font:15px system-ui;max-width:640px;margin:40px auto"><h2>Registered servers</h2>` +
    `<ul>${rows || "<li><em>none</em></li>"}</ul></body>`;
}
