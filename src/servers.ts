// Server manager: each server is an isolated "package" the extension owns, living
// under <store>/servers/<slug>/ (code + a server.json manifest, git-tracked and
// syncable). Servers are started as detached OS processes so they survive VS Code
// restarts; runtime status (pid/port) is tracked machine-locally in globalStorage
// and reconciled on activation. A fixed-port reverse proxy maps stable
// /s/<slug>/ URLs to each server's current port so Notes links never break.
import { spawn, spawnSync, execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as net from "net";
import { hostname, networkInterfaces } from "os";

export interface ServerManifest {
  name: string;
  command: string;          // supports {python} and {port} placeholders
  port: number;
  python?: string;          // interpreter path (or blank -> python3)
  autostart?: boolean;
  category?: string;        // slash-separated dashboard group path
  pinned?: boolean;         // sort first within its immediate group
  tags?: string[];          // searchable labels
}

interface RunState {
  pid: number;              // process-group leader pid (spawned detached)
  port: number;
  startedAt: string;
  logFile: string;
  command: string;
}

export interface ServerListenerProcess { pid: number; name: string; command: string; }
export interface SharedServerLink {
  slug: string;
  name: string;
  category: string;
  tags: string[];
  url: string;
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
  ensureUniqueConfiguredPorts();
  for (const slug of listSlugs()) {
    const manifest = readManifest(slug);
    if (manifest) writeProxyGuide(slug, manifest);
  }
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

export interface ServerNetworkAddress { interface: string; address: string; kind: "interface" | "hostname"; }
export function serverNetworkAddresses(interfaces = networkInterfaces(), hostName = hostname()): ServerNetworkAddress[] {
  const virtual = /^(docker|br-|veth|virbr|vmnet|zt|tailscale|tun|tap)/i;
  const rows: ServerNetworkAddress[] = [];
  const seen = new Set<string>();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.internal || entry.family !== "IPv4" || seen.has(entry.address)) continue;
      seen.add(entry.address);
      rows.push({ interface: name, address: entry.address, kind: "interface" });
    }
  }
  rows.sort((left, right) => Number(virtual.test(left.interface)) - Number(virtual.test(right.interface)) || left.interface.localeCompare(right.interface));
  const host = String(hostName || "").trim().replace(/\.$/, "");
  if (host && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) && !seen.has(host)) {
    rows.push({ interface: "Hostname", address: host, kind: "hostname" });
  }
  return rows;
}

/** Absolute path to a server's managed folder (its code + any data it writes). */
export function serverDir(slug: string): string { return serverDirOf(slug); }

export function serverExport(selectedSlugs: string[] = [], advertisedHost = ""): SharedServerLink[] {
  const selected = new Set(selectedSlugs);
  const host = advertisedHost.trim();
  const state = readState();
  return listSlugs().filter(slug => !selected.size || selected.has(slug)).flatMap(slug => {
    const manifest = readManifest(slug);
    if (!manifest) return [];
    const port = state[slug] && isAlive(state[slug].pid) ? state[slug].port : manifest.port;
    const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    return [{
      slug,
      name: manifest.name,
      category: manifest.category || "",
      tags: manifest.tags || [],
      url: urlHost ? `http://${urlHost}:${port}/` : "",
    }];
  });
}

// ── Store-backed registry (one folder per server) ────────────────────────────
function listSlugs(): string[] {
  try {
    return fs.readdirSync(_serversDir)
      .filter(n => !n.startsWith(".") && fs.existsSync(path.join(_serversDir, n, "server.json")));
  } catch { return []; }
}
function serverDirOf(slug: string): string { return path.join(_serversDir, slug); }
function manifestPath(slug: string): string { return path.join(serverDirOf(slug), "server.json"); }
function groupsPath(): string { return path.join(_serversDir, ".groups.json"); }
function readManifest(slug: string): ServerManifest | null {
  try {
    const j = JSON.parse(fs.readFileSync(manifestPath(slug), "utf-8"));
    return {
      name: String(j.name || slug),
      command: String(j.command || "{python} -m http.server {port}"),
      port: Number(j.port) || 8000,
      python: j.python ? String(j.python) : "",
      autostart: !!j.autostart,
      category: normalizeCategory(j.category),
      pinned: !!j.pinned,
      tags: Array.isArray(j.tags) ? [...new Set<string>(j.tags.map((tag: unknown) => String(tag || "").trim()).filter(Boolean))] : [],
    };
  } catch { return null; }
}
function writeManifest(slug: string, m: ServerManifest): void {
  fs.mkdirSync(serverDirOf(slug), { recursive: true });
  fs.writeFileSync(manifestPath(slug), JSON.stringify(m, null, 2) + "\n");
  writeProxyGuide(slug, m);
}

function normalizeCategory(category: unknown): string {
  const parts = String(category || "").split("/").map(part => part.trim()).filter(Boolean);
  if (parts[0]?.toLowerCase() === "hidden") parts[0] = "Hidden";
  return parts.join("/");
}

function categoryPrefixes(category: string): string[] {
  const parts = normalizeCategory(category).split("/").filter(Boolean);
  return parts.map((_part, index) => parts.slice(0, index + 1).join("/"));
}

function readRegisteredGroups(): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(groupsPath(), "utf8"));
    return [...new Set<string>((Array.isArray(parsed?.groups) ? parsed.groups : []).map(normalizeCategory).filter(Boolean))];
  } catch { return []; }
}

function writeRegisteredGroups(groups: string[]): void {
  const normalized = [...new Set(groups.flatMap(categoryPrefixes).filter(group => group !== "Hidden"))].sort();
  fs.writeFileSync(groupsPath(), JSON.stringify({ groups: normalized }, null, 2) + "\n");
}

function registerServerGroup(category: string): void {
  const normalized = normalizeCategory(category);
  if (!normalized || normalized === "Hidden") return;
  const current = readRegisteredGroups();
  if (!categoryPrefixes(normalized).every(group => current.includes(group))) writeRegisteredGroups([...current, normalized]);
}

export function serverGroupList(): string[] {
  const groups = new Set<string>(["Hidden", ...readRegisteredGroups()]);
  for (const slug of listSlugs()) {
    const manifest = readManifest(slug);
    if (manifest?.category) categoryPrefixes(manifest.category).forEach(group => groups.add(group));
  }
  return [...groups].sort((left, right) => left === "Hidden" ? -1 : right === "Hidden" ? 1 : left.localeCompare(right));
}

export function serverCreateGroup(category: string): { ok: boolean; group?: string; error?: string } {
  const normalized = normalizeCategory(category);
  if (!normalized) return { ok: false, error: "group path is required" };
  if (serverGroupList().includes(normalized)) return { ok: false, error: "group already exists" };
  writeRegisteredGroups([...readRegisteredGroups(), normalized]);
  return { ok: true, group: normalized };
}

function validServerPort(port: unknown): number | undefined {
  const value = Number(port);
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : undefined;
}

/** Return the other managed Server that reserves this configured or active port. */
export function serverPortOwner(port: number, excludeSlug = ""): string | undefined {
  const value = validServerPort(port);
  if (!value || value === _proxyPort) return value === _proxyPort ? "PKM Server proxy" : undefined;
  const state = readState();
  for (const slug of listSlugs()) {
    if (slug === excludeSlug) continue;
    const manifest = readManifest(slug);
    if (manifest?.port === value) return slug;
    const run = state[slug];
    if (run?.port === value && isAlive(run.pid)) return slug;
  }
  return undefined;
}

/** Pick a unique managed Server port, preferring the requested value then scanning upward. */
export function nextServerPort(preferred = 8000, excludeSlug = ""): number {
  const start = validServerPort(preferred) || 8000;
  for (let port = start; port <= 65535; port++) if (!serverPortOwner(port, excludeSlug)) return port;
  for (let port = 1024; port < start; port++) if (!serverPortOwner(port, excludeSlug)) return port;
  throw new Error("no free managed Server port");
}

function ensureUniqueConfiguredPorts(): void {
  const used = new Set<number>([_proxyPort]);
  for (const slug of listSlugs().sort()) {
    const manifest = readManifest(slug);
    if (!manifest) continue;
    let port = validServerPort(manifest.port) || 8000;
    while (used.has(port) && port < 65535) port++;
    if (used.has(port)) { port = 1024; while (used.has(port) && port < 65535) port++; }
    if (port !== manifest.port) writeManifest(slug, { ...manifest, port });
    used.add(port);
  }
}

function writeProxyGuide(slug: string, manifest: ServerManifest): void {
  const guidePath = path.join(serverDirOf(slug), "PKM_SERVER_PROXY.md");
  const content = `# PKM Managed Server Proxy Guide

This server is managed by Personal Knowledge Manager.

## Endpoints

- Server Link: \`http://localhost:${manifest.port}/\`
- Stable Link: \`http://<selected-network-ip>:${manifest.port}/\`

The Servers dashboard lists every non-loopback IPv4 interface and applies one shared selected address to every managed server. Stable Link changes only the host portion; it connects directly to the service and does not depend on VS Code port forwarding.

Under Remote SSH, Server Link points to localhost on the remote machine and requires VS Code port forwarding when opened from a local browser. Stable Link uses the selected remote LAN/global IP directly, subject to routing and firewall policy.

## Binding Requirements

1. Listen on \`127.0.0.1\` or \`0.0.0.0\`, never on a remote-only interface.
2. Respect the \`{port}\` argument supplied by the managed command.
3. Serve the application root at \`/\` and avoid hard-coded external origins.
4. Permit the selected network interface through the host firewall when LAN/global access is intended.
5. Prefer relative asset/API URLs so both localhost and network links work unchanged.
6. If using the optional legacy \`/s/${slug}/\` reverse proxy, additionally verify base paths, redirects, WebSockets, and SSE.

## Agent Checklist

- Test both Server Link and the selected Stable Link.
- On Remote SSH, do not persist VS Code's temporary local forwarded port as the Stable Link.
- Inspect browser network failures for absolute paths, redirects, WebSockets, or missing Referer headers.
- Do not change the stable slug; it is the server folder name.
- Keep \`server.json\`, startup scripts, and this guide with the server source.
`;
  try { fs.writeFileSync(guidePath, content); } catch { /* best-effort documentation */ }
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
function probePortSync(port: number): boolean {
  const script = "const n=require('net'),s=n.connect({host:'127.0.0.1',port:+process.argv[1]});s.setTimeout(350);s.on('connect',()=>{s.destroy();process.exit(0)});const no=()=>{s.destroy();process.exit(1)};s.on('error',no);s.on('timeout',no)";
  try { return spawnSync(process.execPath, ["-e", script, String(port)], { timeout: 1000, stdio: "ignore" }).status === 0; }
  catch { return false; }
}
export function serverListenerProcesses(port: number): ServerListenerProcess[] {
  const value = validServerPort(port);
  if (!value) return [];
  const pids = new Set<number>();
  const names = new Map<number, string>();
  if (process.platform === "win32") {
    const script = `$p=(Get-NetTCPConnection -State Listen -LocalPort ${value} -ErrorAction SilentlyContinue).OwningProcess|Sort-Object -Unique; $p|ForEach-Object{Write-Output (\"$($_)|\"+(Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName)}`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 2500 });
    for (const line of String(result.stdout || "").split(/\r?\n/)) {
      const match = /^(\d+)\|(.*)$/.exec(line.trim());
      if (match) { pids.add(Number(match[1])); names.set(Number(match[1]), match[2]); }
    }
  } else {
    const lsof = spawnSync("lsof", ["-nP", "-a", `-iTCP:${value}`, "-sTCP:LISTEN", "-Fpc"], { encoding: "utf8", timeout: 2500 });
    let currentPid = 0;
    for (const line of String(lsof.stdout || "").split(/\r?\n/)) {
      if (line.startsWith("p") && /^p\d+$/.test(line)) { currentPid = Number(line.slice(1)); pids.add(currentPid); }
      else if (line.startsWith("c") && currentPid) names.set(currentPid, line.slice(1));
    }
    if (!pids.size) {
      const ss = spawnSync("ss", ["-ltnp", "sport", "=", `:${value}`], { encoding: "utf8", timeout: 2500 });
      for (const match of String(ss.stdout || "").matchAll(/\(\("([^"]+)"[^)]*pid=(\d+)/g)) {
        const pid = Number(match[2]); pids.add(pid); names.set(pid, match[1]);
      }
    }
  }
  return [...pids].filter(pid => pid > 1).sort((a, b) => a - b).map(pid => {
    let command = names.get(pid) || "unknown process";
    if (process.platform !== "win32") {
      const ps = spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8", timeout: 1500 });
      command = String(ps.stdout || "").trim() || command;
    }
    return { pid, name: names.get(pid) || path.basename(command.split(/\s+/)[0] || "process"), command };
  });
}

export async function forceStopExternalServer(slug: string, expectedPids: number[] = []): Promise<{ ok: boolean; pids?: number[]; error?: string }> {
  const manifest = readManifest(slug);
  if (!manifest) return { ok: false, error: "unknown server" };
  const tracked = readState()[slug];
  if (tracked && isAlive(tracked.pid)) return { ok: false, error: "this Server is managed by PKM; use Stop instead" };
  const listeners = serverListenerProcesses(manifest.port);
  if (!listeners.length) return { ok: false, error: `no listener process could be identified on port ${manifest.port}` };
  const actualPids = listeners.map(listener => listener.pid);
  const expected = [...new Set(expectedPids.map(Number).filter(pid => pid > 1))].sort((a, b) => a - b);
  if (expected.length && (expected.length !== actualPids.length || expected.some((pid, index) => pid !== actualPids[index]))) {
    return { ok: false, error: "listener process changed; refresh and confirm again" };
  }
  if (actualPids.includes(process.pid)) return { ok: false, error: "refusing to terminate the VS Code extension host" };
  for (const pid of actualPids) {
    try {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 5000, stdio: "ignore" });
      else process.kill(pid, "SIGTERM");
    } catch (error: any) { return { ok: false, error: `could not terminate PID ${pid}: ${error?.message || error}` }; }
  }
  await new Promise(resolve => setTimeout(resolve, 700));
  if (process.platform !== "win32") {
    const remaining = serverListenerProcesses(manifest.port).filter(listener => actualPids.includes(listener.pid));
    for (const listener of remaining) { try { process.kill(listener.pid, "SIGKILL"); } catch { /* process already exited */ } }
    if (remaining.length) await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (await probePort(manifest.port)) return { ok: false, pids: actualPids, error: `port ${manifest.port} is still listening` };
  return { ok: true, pids: actualPids };
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
export function serverImport(sourceDir: string, name?: string): { ok: boolean; slug?: string; port?: number; error?: string } {
  const src = String(sourceDir || "").trim();
  if (!src || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) return { ok: false, error: "not a folder" };
  const nm = (name || path.basename(src)).trim();
  const slug = uniqueSlug(nm);
  const dest = serverDirOf(slug);
  fs.mkdirSync(_serversDir, { recursive: true });
  try { fs.renameSync(src, dest); }
  catch { try { copyDir(src, dest); fs.rmSync(src, { recursive: true, force: true }); } catch (e: any) { return { ok: false, error: String(e?.message || e) }; } }
  const det = detectInDir(dest);
  const port = nextServerPort(det.port, slug);
  writeManifest(slug, { name: nm, command: det.command, port, python: "", autostart: false });
  return { ok: true, slug, port };
}

/** Create a new empty server package with a starter index.html. */
export function serverCreate(name: string): { ok: boolean; slug?: string; port?: number } {
  const slug = uniqueSlug(name || "server");
  const dir = serverDirOf(slug);
  fs.mkdirSync(dir, { recursive: true });
  const idx = path.join(dir, "index.html");
  if (!fs.existsSync(idx)) {
    fs.writeFileSync(idx, `<!doctype html><meta charset="utf-8"><title>${name || slug}</title>\n<body style="font:16px system-ui;margin:40px"><h1>${name || slug}</h1><p>Put your app here.</p></body>\n`);
  }
  const port = nextServerPort(8000, slug);
  writeManifest(slug, { name: name || slug, command: "{python} -m http.server {port}", port, python: "", autostart: false });
  return { ok: true, slug, port };
}

export function serverUpdate(slug: string, patch: Partial<ServerManifest>): boolean {
  const m = readManifest(slug);
  if (!m) return false;
  const requestedPort = patch.port !== undefined ? validServerPort(patch.port) : m.port;
  if (!requestedPort || serverPortOwner(requestedPort, slug)) return false;
  writeManifest(slug, {
    name: patch.name !== undefined ? String(patch.name).trim() : m.name,
    command: patch.command !== undefined ? String(patch.command).trim() : m.command,
    port: requestedPort,
    python: patch.python !== undefined ? String(patch.python).trim() : m.python,
    autostart: patch.autostart !== undefined ? !!patch.autostart : m.autostart,
    category: patch.category !== undefined ? normalizeCategory(patch.category) : m.category,
    pinned: patch.pinned !== undefined ? !!patch.pinned : m.pinned,
    tags: patch.tags !== undefined ? [...new Set((Array.isArray(patch.tags) ? patch.tags : []).map(tag => String(tag || "").trim()).filter(Boolean))] : m.tags,
  });
  if (patch.category !== undefined) registerServerGroup(normalizeCategory(patch.category));
  return true;
}

/** Rename or remove one group path without deleting any servers. */
export function serverMoveGroup(oldPrefix: string, newPrefix: string): { ok: boolean; count: number; error?: string } {
  const oldCategory = normalizeCategory(oldPrefix);
  const newCategory = normalizeCategory(newPrefix);
  if (!oldCategory) return { ok: false, count: 0, error: "root group cannot be moved" };
  if (newCategory === oldCategory || newCategory.startsWith(oldCategory + "/")) {
    return { ok: false, count: 0, error: "group cannot be moved into itself" };
  }
  let count = 0;
  for (const slug of listSlugs()) {
    const manifest = readManifest(slug);
    if (!manifest) continue;
    const category = normalizeCategory(manifest.category);
    if (category !== oldCategory && !category.startsWith(oldCategory + "/")) continue;
    const suffix = category.slice(oldCategory.length).replace(/^\//, "");
    writeManifest(slug, { ...manifest, category: [newCategory, suffix].filter(Boolean).join("/") });
    count++;
  }
  const movedGroups = readRegisteredGroups().map(group => {
    if (group !== oldCategory && !group.startsWith(oldCategory + "/")) return group;
    const suffix = group.slice(oldCategory.length).replace(/^\//, "");
    return [newCategory, suffix].filter(Boolean).join("/");
  }).filter(Boolean);
  writeRegisteredGroups(movedGroups);
  return { ok: true, count };
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
  const owner = serverPortOwner(m.port, slug);
  if (owner) return { ok: false, error: `port ${m.port} is reserved by ${owner}` };
  const dir = serverDirOf(slug);
  if (!fs.existsSync(dir)) return { ok: false, error: `directory not found: ${dir}` };
  const st = readState();
  if (st[slug] && isAlive(st[slug].pid)) return { ok: true };
  if (probePortSync(m.port)) return { ok: false, error: `port ${m.port} already has an external listener; stop it or choose another unique port` };

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
  const owner = serverPortOwner(port, slug);
  if (owner) return { ok: false, error: `port ${port} is reserved by ${owner}` };
  if (!serverUpdate(slug, { port })) return { ok: false, error: "invalid port or unknown server" };
  const wasRunning = !!readState()[slug];
  return wasRunning ? restartServer(slug) : { ok: true };
}

// ── Status / logs / python envs ──────────────────────────────────────────────
export async function serverList(): Promise<any[]> {
  const st = readState();
  const proxyRunning = await probePort(_proxyPort);
  const networkAddresses = serverNetworkAddresses();
  const suggestedPort = nextServerPort();
  const out: any[] = [];
  for (const slug of listSlugs().sort()) {
    const m = readManifest(slug);
    if (!m) continue;
    const run = st[slug];
    let status = "stopped", pid = 0, activePort = m.port, startedAt = "";
    if (run && isAlive(run.pid)) {
      pid = run.pid; activePort = run.port; startedAt = run.startedAt;
      status = (await probePort(activePort)) ? "running" : "starting";
    } else if (await probePort(m.port)) {
      status = "external";
    }
    out.push({
      slug, name: m.name, dir: serverDirOf(slug), command: m.command, port: m.port,
      python: m.python || "", autostart: !!m.autostart, status, pid, activePort, startedAt,
      category: m.category || "", pinned: !!m.pinned,
      tags: m.tags || [],
      suggestedPort,
      externalProcesses: status === "external" ? serverListenerProcesses(m.port) : [],
      stableUrl: `http://localhost:${_proxyPort}/s/${slug}/`,
      localUrl: `http://localhost:${activePort}/`,
      proxyRunning,
      networkLinks: networkAddresses.map(item => ({ ...item, url: `http://${item.address}:${activePort}/` })),
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
export function rewriteProxyHtml(body: string, slug: string): string {
  const base = `/s/${slug}/`;
  const withoutBase = body.replace(/<base\b[^>]*>/gi, "");
  const rewritten = withoutBase.replace(/((?:src|href|action)\s*=\s*["'])(\/(?!\/)[^"']*)/gi, (_match, prefix, value) =>
    `${prefix}${value.startsWith(base) ? value : base + value.slice(1)}`);
  return rewritten.replace(/(<head[^>]*>)/i, `$1<base href="${base}">`);
}

function rewriteProxyHeaders(headers: http.IncomingHttpHeaders, slug: string): http.IncomingHttpHeaders {
  const next = { ...headers };
  const base = `/s/${slug}/`;
  const location = String(next.location || "");
  if (location.startsWith("/") && !location.startsWith("//") && !location.startsWith(base)) {
    next.location = base + location.slice(1);
  }
  return next;
}

function proxyTo(slug: string, targetPath: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  const run = readState()[slug];
  const man = readManifest(slug);
  const port = (run && isAlive(run.pid)) ? run.port : (man ? man.port : 0);
  if (!port) { res.writeHead(502, { "Content-Type": "text/plain" }); res.end(`Server "${slug}" is not running`); return; }
  const headers = { ...req.headers, host: `127.0.0.1:${port}` };
  const preq = http.request({ host: "127.0.0.1", port, path: targetPath, method: req.method, headers }, pres => {
    const ct = String(pres.headers["content-type"] || "");
    const responseHeaders = rewriteProxyHeaders(pres.headers, slug);
    if (/text\/html/i.test(ct)) {
      const chunks: Buffer[] = [];
      pres.on("data", c => chunks.push(c));
      pres.on("end", () => {
        const body = rewriteProxyHtml(Buffer.concat(chunks).toString("utf-8"), slug);
        delete responseHeaders["content-length"];
        res.writeHead(pres.statusCode || 200, responseHeaders);
        res.end(body);
      });
    } else {
      res.writeHead(pres.statusCode || 200, responseHeaders);
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
  return `<!doctype html><meta charset="utf-8"><title>Personal Knowledge Manager — Servers</title>` +
    `<body style="font:15px system-ui;max-width:640px;margin:40px auto"><h2>Registered servers</h2>` +
    `<ul>${rows || "<li><em>none</em></li>"}</ul></body>`;
}
