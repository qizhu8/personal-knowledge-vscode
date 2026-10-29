import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { createHash } from "crypto";
import { exec, execFile, execFileSync, execSync } from "child_process";
import { getStorePath } from "../knowledge/filestore";
import { condaEnvs, pyenvAdd, pyenvCreate, pyenvDelete, pyenvList, pyenvUpdate } from "../servers/pyenvs";
import { managedEnvironmentsRoot } from "../runtime/environment-paths";
import { isAbsoluteForPlatform, isForeignAbsolutePath } from "../knowledge/store-path";
import { compareVersionOrder } from "../runtime/version-order";
import { ensureRecipeCompiler } from "./recipe-compiler";
import { mcpStdioCommand } from "./mcp-stdio-command";
import { hasNewerMcpRuntime } from "./mcp-version-policy";
import { withCrossProcessLock } from "../runtime/cross-process-lock";
import { bundledMcpBuildIdentity, managedMcpLauncher, managedMcpLifecycleStatus, publishManagedMcpGeneration, readManagedMcpManifest, stageManagedMcpGeneration, withManagedMcpGenerationLock } from "./mcp-lifecycle";
export { handshakeManagedMcpConnection, readManagedMcpManifest, verifyManagedMcpHandshake, waitForManagedMcpDrain } from "./mcp-lifecycle";

export async function trashKnowledgeFileViaMcp(
  extensionRoot: string, storeRoot: string, area: string, relative: string, expectedSha256: string,
): Promise<void> {
  const script = `
import asyncio, json, sys
from fastmcp import Client
from fastmcp.client.transports import StdioTransport
async def main():
    helper, root, node, extension, area, relative, digest = sys.argv[1:]
    transport = StdioTransport(command=sys.executable, args=[helper, "--root", root, "--node", node, "--extension-root", extension])
    async with Client(transport, timeout=60) as client:
        result = await client.call_tool("knowledge_file_trash", {"area": area, "path": relative, "expected_sha256": digest})
        value = result.structured_content or json.loads(result.content[0].text)
        if value.get("ok") is not True or not value.get("trash"):
            raise RuntimeError("MCP did not confirm the file was moved to Trash.")
        print(json.dumps(value))
asyncio.run(main())
`;
  await new Promise<void>((resolve, reject) => {
    execFile(resolveMcpPython(), ["-c", script, path.join(extensionRoot, "resources", "knowledge_mutations.py"),
      storeRoot, process.execPath, extensionRoot, area, relative, expectedSha256],
    { timeout: 90_000, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } },
    (error, stdout, stderr) => {
      if (error) { reject(new Error(`MCP Trash failed: ${stderr.trim() || error.message}`)); return; }
      try {
        const result: unknown = JSON.parse(stdout);
        if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !("trash" in result) || !result.trash) {
          throw new Error("MCP did not confirm the Trash result.");
        }
        resolve();
      } catch (failure) { reject(failure); }
    });
  });
}

// ── MCP server scaffold ────────────────────────────────────────────────────
export const UNIFIED_MCP_VERSION = "2.19.0";
const PROMPT_MANAGER_WHEEL = "uone_prompt_manager-0.1.0-py3-none-any.whl";
const PROMPT_MANAGER_WHEEL_SHA256 = "eb9fd76058134f9ab9711d8e7604c75f761db5762d93e67f65740dc07fdc1518";
const RETRIEVAL_ENGINE_WHEEL = "adaptive_skill_retrieval-0.3.0.dev2026100504-py3-none-any.whl";
const RETRIEVAL_ENGINE_WHEEL_SHA256 = "332e434272a3cc88410eb50c7e4bfc3e3f69c5bf1e13f7f9a799087c37124f89";
const KNOWLEDGE_MCP_VERSION = "1.6.0";
const CHAT_MCP_VERSION = "2.3.6";
const RECIPE_MCP_VERSION = "1.8.2";
const AGENT_SESSION_MCP_VERSION = "2.0.0";

interface McpServerStatus {
  installed: boolean;
  serverPath: string;
  expectedVersion: string;
  installedVersion: string;
  current: boolean;
  knowledgeVersion: string;
  chatVersion: string;
  installedKnowledgeVersion: string;
  installedChatVersion: string;
  recipeVersion: string;
  installedRecipeVersion: string;
  agentSessionVersion: string;
  installedAgentSessionVersion: string;
  newerThanExpected: boolean;
  lifecycle?: ReturnType<typeof managedMcpLifecycleStatus>;
}

function readMcpVersion(serverPath: string): string {
  if (!fs.existsSync(serverPath)) return "";
  try { return /^SERVER_VERSION\s*=\s*["']([^"']+)["']/m.exec(fs.readFileSync(serverPath, "utf-8"))?.[1] || "legacy"; }
  catch { return "unknown"; }
}

function readMcpComponentVersion(serverPath: string, constant: string): string {
  if (!fs.existsSync(serverPath)) return "";
  try {
    const source = fs.readFileSync(serverPath, "utf-8");
    return new RegExp(`^${constant}\\s*=\\s*["']([^"']+)["']`, "m").exec(source)?.[1] || "legacy";
  } catch { return "unknown"; }
}

interface McpPythonStatus { path: string; version: string; valid: boolean; source: string; error: string; }
interface McpPythonCandidate { path: string; version: string; source: string; label: string; }
interface McpRuntimeStatus { path: string; python: string; exists: boolean; healthy: boolean; version: string; error: string; registered: boolean; }
export interface McpProcessStatus { running: boolean; pid: string; checkedAt: number; available: boolean; detail: string; }
export const MCP_FEATURE_DOMAINS = ["knowledge", "automation", "skillRouter"] as const;
export type McpFeatureDomain = typeof MCP_FEATURE_DOMAINS[number];

export function configuredMcpFeatureDomains(): McpFeatureDomain[] {
  const configured = vscode.workspace.getConfiguration("personalKnowledge").get<string[]>("mcpEnabledFeatureDomains");
  if (!Array.isArray(configured)) return [...MCP_FEATURE_DOMAINS];
  const enabled = new Set(configured);
  return MCP_FEATURE_DOMAINS.filter(domain => enabled.has(domain));
}

export function writeMcpFeatureDomainConfig(domains = configuredMcpFeatureDomains(), directory = managedMcpServerDirectory()): string {
  const destination = path.join(directory, "feature-domains.json");
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ schema: 1, enabled: domains }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, destination);
  return destination;
}

export function writeActionWorkspaceConfig(): void {
  const store = getStorePath();
  if (!store) return;
  const roots = vscode.workspace.getConfiguration("personalKnowledge").get<Record<string, string>>("actions.workspaceRoots", {});
  const toolchains = vscode.workspace.getConfiguration("personalKnowledge").get<Record<string, Record<string, string>>>("actions.toolchains", {});
  const directory = path.join(store, ".pkm", "state", "actions");
  const destination = path.join(directory, "settings.json");
  const current = fs.existsSync(destination) ? JSON.parse(fs.readFileSync(destination, "utf8")) : { workspace_roots: {} };
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ ...current, workspace_roots: { ...current.workspace_roots, ...roots }, toolchains }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, destination);
}

export function managedMcpServerDirectory(): string {
  const configured = vscode.workspace.getConfiguration("personalKnowledge").get<string>("mcpServerPath", "").trim();
  const normalized = configured && isAbsoluteForPlatform(configured) && !isForeignAbsolutePath(configured) ? path.normalize(configured) : "";
  const extensionRoot = path.resolve(require("path").resolve(__dirname, ".."), "..");
  const insideInstalledExtension = normalized === extensionRoot || normalized.startsWith(extensionRoot + path.sep);
  return normalized && !insideInstalledExtension ? normalized : path.join(getStorePath(), "mcp-server");
}

export function managedMcpRuntimePath(): string {
  const configured = vscode.workspace.getConfiguration("personalKnowledge").get<string>("mcpRuntimePath", "").trim();
  return configured && isAbsoluteForPlatform(configured) && !isForeignAbsolutePath(configured)
    ? path.normalize(configured)
    : path.join(managedEnvironmentsRoot(), "pkm-mcp");
}

export function mcpProcessStatus(includeRuntimeUsers = false): McpProcessStatus {
  const serverPath = path.join(managedMcpServerDirectory(), "server.py");
  if (process.platform === "win32") {
    return {
      running: false,
      pid: "",
      checkedAt: Date.now(),
      available: false,
      detail: "Passive MCP process inspection is disabled on Windows to avoid opening a PowerShell console.",
    };
  }
  try {
    const output = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", timeout: 3000, windowsHide: true });
    const normalizedPath = serverPath.replace(/\\/g, "/").toLowerCase();
    const lines = output.split(/\r?\n/);
    const generationPrefix = path.join(managedMcpServerDirectory(), "generations").replace(/\\/g, "/").toLowerCase() + "/";
    const runtimePython = mcpRuntimePythonPath().replace(/\\/g, "/").toLowerCase();
    const match = lines.find(line => {
      const command = String(line).replace(/\\/g, "/").toLowerCase();
      return command.includes(normalizedPath) || (command.includes(generationPrefix) && command.includes("/server.py"))
        || (includeRuntimeUsers && command.includes(runtimePython));
    });
    const pid = match ? /^\s*(\d+)/.exec(String(match))?.[1] || "" : "";
    return { running: !!match, pid, checkedAt: Date.now(), available: true, detail: match ? "Generated server process detected." : "No generated server process detected." };
  } catch (error: any) {
    return { running: false, pid: "", checkedAt: Date.now(), available: false, detail: `Process detection unavailable: ${error?.message || String(error)}` };
  }
}

function mcpRuntimePath(): string { return managedMcpRuntimePath(); }
function mcpRuntimeBaseMarker(): string { return path.join(mcpRuntimePath(), ".pkm-base-python.json"); }
function mcpRuntimePythonPath(): string {
  return process.platform === "win32" ? path.join(mcpRuntimePath(), "Scripts", "python.exe") : path.join(mcpRuntimePath(), "bin", "python");
}

// Python probes are child processes: ~15 ms on a warm Linux host but seconds on a cold Windows host (Defender scans every
// .pyd/.pyc on first import). Startup used to run them synchronously several times on the Extension Host thread, which
// froze PKM (health pings unanswered, Chat rename/copy waiting). Results are cached by executable identity, and the
// startup paths warm the cache with the async variants first so the synchronous callers only read the cache.
const PYTHON_PROBE_OK_TTL_MS = 5 * 60_000, PYTHON_PROBE_ERROR_TTL_MS = 15_000, RUNTIME_PROBE_TTL_MS = 60_000;
const pythonProbes = new Map<string, { at: number; value: { path: string; version: string; error: string } }>();
let runtimeProbe: { at: number; key: string; value: McpRuntimeStatus } | undefined;
let runtimeProbeInFlight: Promise<McpRuntimeStatus> | undefined;
let pathPythonProbe: { at: number; value: string[] } | undefined;
export function invalidateMcpPythonProbes(): void { pythonProbes.clear(); runtimeProbe = undefined; pathPythonProbe = undefined; }
function executableIdentity(file: string): string {
  try { const stat = fs.statSync(file); return `${file}\0${stat.size}\0${stat.mtimeMs}`; } catch { return `${file}\0missing`; }
}
function cachedProbe(key: string): { path: string; version: string; error: string } | undefined {
  const hit = pythonProbes.get(key);
  return hit && Date.now() - hit.at < (hit.value.error ? PYTHON_PROBE_ERROR_TTL_MS : PYTHON_PROBE_OK_TTL_MS) ? hit.value : undefined;
}
function pythonVersionResult(executable: string, version: string): { path: string; version: string; error: string } {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (!match || Number(match[1]) < 3 || (Number(match[1]) === 3 && Number(match[2]) < 10)) {
    return { path: executable, version, error: `Python 3.10+ is required (found ${version || "unknown"}).` };
  }
  return { path: executable, version, error: "" };
}
function precheckPython(candidate: string): { value: string; result?: { path: string; version: string; error: string } } {
  const value = String(candidate || "").trim();
  if (!value || !path.isAbsolute(value)) return { value, result: { path: value, version: "", error: "Enter an absolute Python executable path." } };
  if (!fs.existsSync(value) || fs.statSync(value).isDirectory()) return { value, result: { path: value, version: "", error: "Python executable was not found." } };
  return { value };
}

export function validateMcpPython(candidate: string): { path: string; version: string; error: string } {
  const { value, result } = precheckPython(candidate);
  if (result) return result;
  const executable = path.normalize(value), key = executableIdentity(executable);
  const cached = cachedProbe(key);
  if (cached) return cached;
  let validated: { path: string; version: string; error: string };
  try {
    const version = execFileSync(executable, ["-c", "import platform;print(platform.python_version())"], {
      encoding: "utf-8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"], windowsHide: process.platform === "win32",
    }).trim();
    validated = pythonVersionResult(executable, version);
  } catch (error: any) {
    validated = { path: value, version: "", error: `Could not run Python: ${error?.message || String(error)}` };
  }
  pythonProbes.set(key, { at: Date.now(), value: validated });
  return validated;
}

export async function validateMcpPythonAsync(candidate: string): Promise<{ path: string; version: string; error: string }> {
  const { value, result } = precheckPython(candidate);
  if (result) return result;
  const executable = path.normalize(value), key = executableIdentity(executable);
  const cached = cachedProbe(key);
  if (cached) return cached;
  const validated = await new Promise<{ path: string; version: string; error: string }>(resolve => execFile(executable, ["-c", "import platform;print(platform.python_version())"],
    { encoding: "utf-8", timeout: 8000, windowsHide: process.platform === "win32" },
    (error, stdout) => resolve(error ? { path: value, version: "", error: `Could not run Python: ${error.message}` } : pythonVersionResult(executable, String(stdout).trim()))));
  pythonProbes.set(key, { at: Date.now(), value: validated });
  return validated;
}

function pathPythonCommand(): string { return process.platform === "win32" ? "where python" : "command -v python3 || command -v python"; }
function pathPythonCandidates(): string[] {
  if (pathPythonProbe && Date.now() - pathPythonProbe.at < PYTHON_PROBE_OK_TTL_MS) return pathPythonProbe.value;
  let value: string[] = [];
  try { value = execSync(pathPythonCommand(), { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], windowsHide: process.platform === "win32" }).split(/\r?\n/); }
  catch { /* no executable on PATH */ }
  pathPythonProbe = { at: Date.now(), value };
  return value;
}
async function pathPythonCandidatesAsync(): Promise<string[]> {
  if (pathPythonProbe && Date.now() - pathPythonProbe.at < PYTHON_PROBE_OK_TTL_MS) return pathPythonProbe.value;
  const value = await new Promise<string[]>(resolve => exec(pathPythonCommand(), { encoding: "utf-8", windowsHide: process.platform === "win32", timeout: 10_000 },
    (error, stdout) => resolve(error && !stdout ? [] : String(stdout).split(/\r?\n/))));
  pathPythonProbe = { at: Date.now(), value };
  return value;
}
function detectionCandidates(pathCandidates: string[]): string[] {
  const prefixes = [process.env.CONDA_PREFIX, process.env.VIRTUAL_ENV].filter(Boolean).map(String);
  const candidates: string[] = [];
  for (const prefix of prefixes) {
    if (process.platform === "win32") candidates.push(path.join(prefix, "python.exe"), path.join(prefix, "Scripts", "python.exe"));
    else candidates.push(path.join(prefix, "bin", "python"), path.join(prefix, "bin", "python3"));
  }
  candidates.push(...pathCandidates);
  return [...new Set(candidates.map(value => value.trim()).filter(Boolean))];
}

/** Non-blocking warm-up of every probe startup needs; later synchronous callers then read cached results. */
export async function warmMcpPythonProbes(): Promise<void> {
  const configured = vscode.workspace.getConfiguration("personalKnowledge").get<string>("mcpPythonPath", "").trim();
  if (configured) await validateMcpPythonAsync(configured);
  else for (const candidate of detectionCandidates(await pathPythonCandidatesAsync())) if (!(await validateMcpPythonAsync(candidate)).error) break;
  await mcpRuntimeStatusAsync();
}

export function detectMcpPython(ignoreConfigured = false): McpPythonStatus {
  const configured = vscode.workspace.getConfiguration("personalKnowledge").get<string>("mcpPythonPath", "").trim();
  if (configured && !ignoreConfigured) {
    const result = validateMcpPython(configured);
    return { ...result, valid: !result.error, source: "configured" };
  }
  for (const candidate of detectionCandidates(pathPythonCandidates())) {
    const result = validateMcpPython(candidate);
    if (!result.error) return { ...result, valid: true, source: "detected" };
  }
  return { path: configured, version: "", valid: false, source: configured ? "configured" : "none", error: configured ? validateMcpPython(configured).error : "Python 3.10+ was not found on this machine." };
}

async function listMcpPythonCandidates(): Promise<McpPythonCandidate[]> {
  const raw: { path: string; source: string; label: string }[] = [];
  const add = (candidate: unknown, source: string, label: string) => {
    const value = String(candidate || "").trim();
    if (value) raw.push({ path: value, source, label });
  };
  const configured = vscode.workspace.getConfiguration("personalKnowledge").get<string>("mcpPythonPath", "").trim();
  add(configured, "configured", "Current MCP selection");
  for (const env of pyenvList()) add(env.python, "pkm-env", `PKM Env · ${env.name}`);
  for (const [variable, label] of [["CONDA_PREFIX", "Active conda"], ["VIRTUAL_ENV", "Active virtualenv"]] as const) {
    const prefix = process.env[variable];
    if (!prefix) continue;
    if (process.platform === "win32") { add(path.join(prefix, "python.exe"), "active-env", label); add(path.join(prefix, "Scripts", "python.exe"), "active-env", label); }
    else add(path.join(prefix, "bin", "python"), "active-env", label);
  }
  for (const env of await condaEnvs()) add(env.python, "conda", `Conda · ${env.name}`);
  const pythonConfig = vscode.workspace.getConfiguration("python");
  for (const key of ["defaultInterpreterPath", "interpreterPath"]) {
    let value = pythonConfig.get<string>(key, "").trim();
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspace) value = value.replace(/\$\{workspaceFolder\}/g, workspace);
    add(value, "vscode-python", `VS Code Python · ${key}`);
  }
  try {
    if (process.platform === "win32") {
      for (const command of ["where python", "where python3"]) {
        try { execSync(command, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).split(/\r?\n/).forEach(value => add(value, "path", "PATH")); } catch { /* absent */ }
      }
      try {
        execSync("py -0p", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).split(/\r?\n/).forEach(line => {
          const match = /([A-Za-z]:\\[^*]+python\.exe)\s*$/i.exec(line.trim()); if (match) add(match[1], "py-launcher", "Python Launcher");
        });
      } catch { /* py launcher absent */ }
    } else {
      const names = ["python3", "python", "python3.14", "python3.13", "python3.12", "python3.11", "python3.10"];
      execSync(`which -a ${names.join(" ")} 2>/dev/null || true`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
        .split(/\r?\n/).forEach(value => add(value, "path", "PATH"));
    }
  } catch { /* no PATH candidates */ }
  const seen = new Set<string>(), candidates: McpPythonCandidate[] = [];
  for (const candidate of raw) {
    const validated = validateMcpPython(candidate.path);
    if (validated.error || seen.has(validated.path)) continue;
    seen.add(validated.path);
    candidates.push({ path: validated.path, version: validated.version, source: candidate.source, label: candidate.label });
  }
  const versionParts = (version: string) => version.split(".").map(Number);
  candidates.sort((left, right) => {
    if (left.path === configured) return -1;
    if (right.path === configured) return 1;
    const a = versionParts(left.version), b = versionParts(right.version);
    return (b[0] - a[0]) || (b[1] - a[1]) || ((b[2] || 0) - (a[2] || 0)) || left.label.localeCompare(right.label);
  });
  return candidates;
}

let mcpPythonScanGeneration = 0;
export function cancelMcpPythonScan(): void { mcpPythonScanGeneration++; }
export async function streamMcpPythonCandidates(respond: (message: object) => void): Promise<void> {
  const generation = ++mcpPythonScanGeneration;
  const seen = new Set<string>(); let count = 0;
  const emit = (candidatePath: unknown, source: string, label: string) => {
    if (generation !== mcpPythonScanGeneration) return;
    const result = validateMcpPython(String(candidatePath || "").trim());
    if (result.error || seen.has(result.path)) return;
    seen.add(result.path); count++;
    respond({ command: "mcpPythonCandidate", data: { candidate: { path: result.path, version: result.version, source, label }, count } });
  };
  respond({ command: "mcpPythonScanStarted", data: { text: "Scanning configured Python, PKM Envs, PATH, conda, and miniconda…" } });
  const configured = vscode.workspace.getConfiguration("personalKnowledge").get<string>("mcpPythonPath", "").trim();
  emit(configured, "configured", "Current MCP selection");
  for (const env of pyenvList()) emit(env.python, "pkm-env", `PKM Env · ${env.name}`);
  for (const [variable, label] of [["CONDA_PREFIX", "Active conda"], ["VIRTUAL_ENV", "Active virtualenv"]] as const) {
    const prefix = process.env[variable]; if (!prefix) continue;
    emit(process.platform === "win32" ? path.join(prefix, "python.exe") : path.join(prefix, "bin", "python"), "active-env", label);
  }
  const pythonConfig = vscode.workspace.getConfiguration("python");
  for (const key of ["defaultInterpreterPath", "interpreterPath"]) {
    let value = pythonConfig.get<string>(key, "").trim(); const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspace) value = value.replace(/\$\{workspaceFolder\}/g, workspace);
    emit(value, "vscode-python", `VS Code Python · ${key}`);
  }
  try {
    const command = process.platform === "win32" ? "where python" : "which -a python3 python python3.14 python3.13 python3.12 python3.11 python3.10 2>/dev/null || true";
    execSync(command, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], windowsHide: process.platform === "win32" }).split(/\r?\n/).forEach(value => emit(value, "path", "PATH"));
  } catch { /* no PATH Python */ }
  if (generation !== mcpPythonScanGeneration) return;
  respond({ command: "mcpPythonScanProgress", data: { text: `Scanning conda/miniconda installations… ${count} found`, count } });
  const condaRoots = new Set<string>();
  for (const root of [process.env.CONDA_PREFIX, process.env.CONDA_EXE ? path.dirname(path.dirname(process.env.CONDA_EXE)) : "", path.join(os.homedir(), "miniconda3"), path.join(os.homedir(), "anaconda3")].filter(Boolean).map(String)) condaRoots.add(root);
  try {
    const raw = await new Promise<string>((resolve) => execFile("conda", ["env", "list", "--json"], { timeout: 20000, maxBuffer: 1 << 20, windowsHide: process.platform === "win32" }, (_error, stdout) => resolve(String(stdout || ""))));
    const parsed = JSON.parse(raw || "{}");
    for (const prefix of parsed.envs || []) {
      const base = String(prefix); if (!/[\\/]envs[\\/]/.test(base)) condaRoots.add(base);
      emit(process.platform === "win32" ? path.join(base, "python.exe") : path.join(base, "bin", "python"), "conda", /[\\/]envs[\\/]/.test(base) ? `Conda Env · ${path.basename(base)}` : `Conda Base · ${path.basename(base)}`);
      respond({ command: "mcpPythonScanProgress", data: { text: `Scanning conda/miniconda installations… ${count} found`, count } });
    }
  } catch { /* invalid/no conda JSON */ }
  for (const root of condaRoots) emit(process.platform === "win32" ? path.join(root, "python.exe") : path.join(root, "bin", "python"), "conda-base", `Conda/Miniconda Base · ${path.basename(root)}`);
  if (generation !== mcpPythonScanGeneration) return;
  respond({ command: "mcpPythonScanComplete", data: { count, text: count ? `Scan complete · ${count} usable Python 3.10+ runtime(s)` : "Scan complete · no usable Python 3.10+ runtimes found" } });
}

export function resolveMcpPython(): string {
  const runtimePython = validateMcpPython(mcpRuntimePythonPath());
  if (!runtimePython.error) return runtimePython.path;
  throw new Error("Managed PKM MCP runtime is missing or broken. Create or Repair it in the Config tab.");
}

export function mcpServerDefinitionData(): { label: string; command: string; args: string[]; env?: Record<string, string>; cwd: string; version: string } {
  const cwd = managedMcpServerDirectory();
  const python = mcpRuntimePythonPath();
  if (!fs.existsSync(python) || !fs.existsSync(path.join(cwd, "server.py"))) {
    throw new Error("Managed PKM MCP runtime or generated server is missing. Finish setup in Config.");
  }
  // Discovery must not synchronously spawn Python; runtime health is checked on explicit startup.
  const launch = mcpStdioCommand(python, [path.join(cwd, "server.py")]);
  return {
    label: "pkm",
    command: launch.command,
    args: launch.args,
    env: launch.env,
    cwd,
    version: UNIFIED_MCP_VERSION,
  };
}

const RUNTIME_IMPORT_PROBE = "import fastmcp, prompt_manager, websockets, adaptive_skill_retrieval, cryptography; from adaptive_skill_retrieval import ContentType, RetrievalEngine, SkillDocument, academic_bm25_benchmark_route, exact_match_route";
function runtimeProbeKey(): string {
  return `${executableIdentity(mcpRuntimePythonPath())}\0${executableIdentity(mcpRuntimeBaseMarker())}\0${pyenvList().some(env => env.path && path.resolve(env.path) === path.resolve(mcpRuntimePath()))}`;
}
function runtimeStatusFrom(validation: { path: string; version: string; error: string }, importError: string | undefined): McpRuntimeStatus {
  const runtimePath = mcpRuntimePath(), python = mcpRuntimePythonPath();
  const exists = fs.existsSync(runtimePath);
  const registered = pyenvList().some(env => env.path && path.resolve(env.path) === path.resolve(runtimePath));
  if (validation.error) return { path: runtimePath, python, exists, healthy: false, version: validation.version, error: exists ? validation.error : "Managed MCP runtime has not been created.", registered };
  if (importError !== undefined) return { path: runtimePath, python: validation.path, exists: true, healthy: false, version: validation.version, error: `MCP dependencies are missing or broken: ${importError}`, registered };
  return { path: runtimePath, python: validation.path, exists: true, healthy: true, version: validation.version, error: "", registered };
}
function cachedRuntimeStatus(key: string): McpRuntimeStatus | undefined {
  return runtimeProbe && runtimeProbe.key === key && Date.now() - runtimeProbe.at < RUNTIME_PROBE_TTL_MS ? runtimeProbe.value : undefined;
}

export function mcpRuntimeStatus(): McpRuntimeStatus {
  const key = runtimeProbeKey();
  const cached = cachedRuntimeStatus(key);
  if (cached) return cached;
  if (runtimeProbe?.key === key) {
    void mcpRuntimeStatusAsync().catch(() => undefined);
    return runtimeProbe.value;
  }
  const validation = validateMcpPython(mcpRuntimePythonPath());
  let importError: string | undefined;
  if (!validation.error) {
    try { execFileSync(validation.path, ["-c", RUNTIME_IMPORT_PROBE], { timeout: 10000, stdio: ["ignore", "pipe", "pipe"], windowsHide: process.platform === "win32" }); }
    catch (error: any) { importError = error?.message || String(error); }
  }
  const value = runtimeStatusFrom(validation, importError);
  runtimeProbe = { at: Date.now(), key, value };
  return value;
}

export function mcpRuntimeStatusAsync(): Promise<McpRuntimeStatus> {
  const key = runtimeProbeKey();
  const cached = cachedRuntimeStatus(key);
  if (cached) return Promise.resolve(cached);
  return runtimeProbeInFlight ||= (async () => {
    const validation = await validateMcpPythonAsync(mcpRuntimePythonPath());
    const importError = validation.error ? undefined : await new Promise<string | undefined>(resolve => execFile(validation.path, ["-c", RUNTIME_IMPORT_PROBE],
      { timeout: 30_000, windowsHide: process.platform === "win32" }, error => resolve(error ? error.message : undefined)));
    const value = runtimeStatusFrom(validation, importError);
    runtimeProbe = { at: Date.now(), key, value };
    return value;
  })().finally(() => { runtimeProbeInFlight = undefined; });
}

export async function ensureMcpRuntime(context: vscode.ExtensionContext): Promise<McpRuntimeStatus> {
  const directory = managedMcpServerDirectory();
  return withCrossProcessLock(`${mcpRuntimePath()}.pkm-maintenance-lock`, "MCP runtime maintenance", 2_000, async () => {
    fs.mkdirSync(directory, { recursive: true });
    const marker = path.join(directory, "runtime-maintenance.json");
    const runtimeMarker = `${mcpRuntimePath()}.pkm-maintenance.json`;
    const record = JSON.stringify({ schema: "pkm.mcp.maintenance/v1", pid: process.pid }) + "\n";
    fs.writeFileSync(runtimeMarker, record, { mode: 0o600 });
    try {
      fs.writeFileSync(marker, record, { mode: 0o600 });
      {
        const processes = mcpProcessStatus(true);
        const instances = managedMcpLifecycleStatus(directory).instances;
        const observedInstances = instances.some(instance => {
          if (!Number.isSafeInteger(instance.pid) || instance.pid <= 0) return true;
          try { process.kill(instance.pid, 0); return true; }
          catch (error: any) { return error?.code !== "ESRCH"; }
        });
        const mayHaveExistingRuntime = fs.existsSync(mcpRuntimePath()) || fs.existsSync(path.join(directory, "server.py"));
        if ((!processes.available && mayHaveExistingRuntime) || processes.running || observedInstances) {
          throw new Error("PKM MCP runtime repair is action-required: close/reconnect all managed PKM clients and let in-flight writes finish before changing shared Python dependencies. "
            + "Legacy/uninstrumented processes have unknown drain state. No process was killed and no call was replayed. "
            + (!processes.available ? "Process inspection is unavailable; choose a new empty managed runtime path instead of modifying a possibly active environment." : processes.detail));
        }
      }
      return await ensureMcpRuntimeFiles(context);
    } finally {
      fs.rmSync(marker, { force: true });
      fs.rmSync(runtimeMarker, { force: true });
    }
  });
}

async function ensureMcpRuntimeFiles(context: vscode.ExtensionContext): Promise<McpRuntimeStatus> {
  invalidateMcpPythonProbes();
  await warmMcpPythonProbes();
  const base = detectMcpPython();
  if (!base.valid) throw new Error(base.error);
  const runtimePath = mcpRuntimePath(), root = path.dirname(runtimePath);
  const runtimeName = path.basename(runtimePath);
  if (!/^[A-Za-z0-9._-]+$/.test(runtimeName)) throw new Error("Managed MCP Runtime folder name may only contain letters, digits, . _ -");
  fs.mkdirSync(root, { recursive: true });
  let validation = validateMcpPython(mcpRuntimePythonPath());
  let baseChanged = false;
  const markerExists = fs.existsSync(mcpRuntimeBaseMarker());
  try {
    const marker = JSON.parse(fs.readFileSync(mcpRuntimeBaseMarker(), "utf-8"));
    baseChanged = marker.path !== base.path || marker.version !== base.version;
  } catch { baseChanged = fs.existsSync(runtimePath); }
  if (validation.error || baseChanged) {
    if (fs.existsSync(runtimePath) && !markerExists) {
      throw new Error(`Refusing to replace unrecognized directory: ${runtimePath}. Choose an empty path or an existing PKM-managed runtime.`);
    }
    const stale = pyenvList().find(env => env.name === "PKM MCP Runtime" || (env.path && path.resolve(env.path) === path.resolve(runtimePath)));
    if (stale) await pyenvDelete(stale.id, false);
    if (fs.existsSync(runtimePath)) fs.rmSync(runtimePath, { recursive: true, force: true });
    const created = await pyenvCreate({
      manager: "venv", name: runtimeName, parentDir: root, baseInterpreter: base.path,
      description: "Managed runtime for the unified PKM MCP server",
    });
    if (!created.ok) throw new Error(created.error || "Could not create the managed MCP runtime.");
    if (created.env) pyenvUpdate(created.env.id, { name: "PKM MCP Runtime", description: "Managed runtime for the unified PKM MCP server" });
    validation = validateMcpPython(mcpRuntimePythonPath());
    if (validation.error) throw new Error(validation.error);
  }
  generateMcpServer(context);
  const requirements = path.join(managedMcpServerDirectory(), "requirements.txt");
  const pipInstall = (args: string[]) => new Promise<void>((resolve, reject) => execFile(validation.path, ["-m", "pip", "install", ...args], {
    timeout: 600000, maxBuffer: 1 << 24, windowsHide: process.platform === "win32",
  }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${String(stdout || "")}\n${String(stderr || "")}`.trim())) : resolve()));
  try {
    await pipInstall(["-r", requirements]);
  } catch (initialError: any) {
    const detail = initialError?.message || String(initialError);
    const promptManagerDownloadFailure = /uone[-_]prompt[-_]manager/i.test(detail)
      && /(No matching distribution|Could not find a version|SSL|TLS|HTTPSConnectionPool|files\.pythonhosted\.org)/i.test(detail);
    if (!promptManagerDownloadFailure) throw initialError;
    const wheel = path.join(context.extensionPath, "resources", "vendor", PROMPT_MANAGER_WHEEL);
    if (!fs.existsSync(wheel)) throw new Error(`Prompt Manager download failed and the bundled fallback wheel is missing: ${wheel}\n${detail}`);
    const digest = createHash("sha256").update(fs.readFileSync(wheel)).digest("hex");
    if (digest !== PROMPT_MANAGER_WHEEL_SHA256) throw new Error("Bundled Prompt Manager wheel failed integrity verification.");
    await pipInstall(["--no-deps", wheel]);
    await pipInstall(["-r", requirements]);
  }
  const retrievalWheel = path.join(context.extensionPath, "resources", "vendor", RETRIEVAL_ENGINE_WHEEL);
  if (!fs.existsSync(retrievalWheel)) throw new Error(`Bundled retrieval engine wheel is missing: ${retrievalWheel}`);
  const retrievalDigest = createHash("sha256").update(fs.readFileSync(retrievalWheel)).digest("hex");
  if (retrievalDigest !== RETRIEVAL_ENGINE_WHEEL_SHA256) throw new Error("Bundled retrieval engine wheel failed integrity verification.");
  await pipInstall(["--no-deps", "--upgrade", retrievalWheel]);
  fs.writeFileSync(mcpRuntimeBaseMarker(), JSON.stringify({ path: base.path, version: base.version }, null, 2) + "\n");
  const existing = pyenvList().find(env => env.path && path.resolve(env.path) === path.resolve(runtimePath));
  if (existing) pyenvUpdate(existing.id, { name: "PKM MCP Runtime", manager: "venv", python: validation.path, description: "Managed runtime for the unified PKM MCP server" });
  else pyenvAdd({ name: "PKM MCP Runtime", manager: "venv", path: runtimePath, python: validation.path, description: "Managed runtime for the unified PKM MCP server" });
  invalidateMcpPythonProbes();
  return mcpRuntimeStatusAsync();
}

export function mcpRuntimeManualCommands(basePython: string): string[] {
  const runtime = mcpRuntimePath();
  const python = mcpRuntimePythonPath();
  const mcpDir = managedMcpServerDirectory();
  const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;
  return [
    `${quote(basePython)} -m venv ${quote(runtime)}`,
    `${quote(python)} -m pip install -r ${quote(path.join(mcpDir, "requirements.txt"))}`,
  ];
}

export function combinedMcpRegistry(): string {
  const mcpDir = managedMcpServerDirectory();
  const launch = mcpStdioCommand(resolveMcpPython(), [path.join(mcpDir, "server.py")]);
  return JSON.stringify({
    servers: {
      pkm: { type: "stdio", command: launch.command, args: launch.args, ...(launch.env ? { env: launch.env } : {}) },
    },
  }, null, 2);
}

export function combinedMcpInstallInstruction(nativeProvider = true): string {
  const storePath = getStorePath();
  const mcpDir = managedMcpServerDirectory();
  const runtimePython = mcpRuntimePythonPath();
  const serverPath = path.join(mcpDir, "server.py");
  const launch = mcpStdioCommand(runtimePython, [serverPath]);
  const requirementsPath = path.join(mcpDir, "requirements.txt");
  const chatServerPath = chatMcpStatus().serverPath;
  const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;
  if (nativeProvider) return [
    "Verify the unified pkm server supplied by the Personal Knowledge Manager extension's native MCP provider.",
    "This registration belongs to the target machine and OS account, not this workspace.",
    "Do not add duplicate registrations to MCP Agency, workspace .vscode/mcp.json, or user MCP configuration.",
    "Do not delete or modify existing registrations without the user's explicit approval.",
    "On Remote SSH, use the remote account's runtime; do not launch its paths on the Windows client.",
    "",
    `Knowledge Root: ${storePath}`,
    `Managed runtime Python: ${runtimePython}`,
    `pkm server: ${serverPath}`,
    "",
    "1. Use PKM Config to check or repair the managed runtime and generated server if necessary.",
    "2. With user approval, start the provider's pkm entry using PKM: Start PKM MCP or MCP: List Servers. Preserve native trust and tool consent.",
    `3. Discover and call pkm.check_version through the actual agent tool surface; expected unified version ${UNIFIED_MCP_VERSION}.`,
    "4. Call pkm.chat_capabilities and verify chat_join, chat_standby, and chat_post.",
    "5. Verify the same provider is discoverable in a second workspace on this target/account without a project MCP file.",
    "Report configured, discovered, trusted, started, tools-listed, and agent-visible separately. Provider presence alone is not successful tool access.",
  ].join("\n");
  return [
    "Use a manual account-level adapter only when it is the explicitly selected registration owner or this client lacks native provider support.",
    "A manual adapter requires explicit user approval; native provider registration remains the preferred VS Code path.",
    "Select exactly one registration owner. Do not register the same server through both an extension provider and a manual adapter.",
    "IMPORTANT: these paths were generated for this machine. Preserve all unrelated MCP server registrations.",
    "On Remote SSH, configure the remote user's MCP settings; never launch Linux paths on the Windows client.",
    "",
    `Store: ${storePath}`,
    `Managed runtime Python: ${runtimePython}`,
    `pkm server: ${serverPath}`,
    `Internal chat module: ${chatServerPath}`,
    "",
    `1. Verify the managed runtime exists and can import fastmcp, prompt_manager, and websockets: ${quote(runtimePython)} -c "import fastmcp, prompt_manager, websockets"`,
    `2. Verify the generated entry and chat module exist at ${serverPath} and ${chatServerPath}. If missing or outdated, regenerate them from the extension Config tab.`,
    "3. Inventory any existing pkm, pkm-chat, and pkm-chat-live registrations. Do not remove user-authored entries automatically.",
    "4. After approval, import this Local/stdio server into this target account's user-level MCP configuration. Do not create a workspace MCP file:",
    "",
    "```json",
    JSON.stringify({
      servers: {
        pkm: { type: "stdio", command: launch.command, args: launch.args, ...(launch.env ? { env: launch.env } : {}) },
      },
    }, null, 2),
    "```",
    "",
    "5. The Config tab normally installs dependencies automatically. If Repair reported an install failure, run:",
    `   ${quote(runtimePython)} -m pip install -r ${quote(requirementsPath)}`,
    "6. With user approval, start the selected manual pkm registration using the client's native MCP controls.",
    "7. Refresh tool discovery without automatically restarting or reloading other windows.",
    `8. Discover pkm.check_version and verify unified version ${UNIFIED_MCP_VERSION}.`,
    "9. Call pkm.chat_capabilities and verify its chat_tools includes chat_join, chat_standby, and chat_post.",
    "Report any missing file, dependency error, start failure, or version mismatch with the exact error text.",
  ].join("\n");
}

export function mcpStatus(): McpServerStatus {
  const serverPath = path.join(managedMcpServerDirectory(), "server.py");
  const manifest = readManagedMcpManifest(managedMcpServerDirectory());
  const installedVersion = manifest?.version || readMcpVersion(serverPath);
  const installedKnowledgeVersion = manifest?.components.knowledge || readMcpComponentVersion(serverPath, "KNOWLEDGE_SCHEMA_VERSION");
  const installedChatVersion = manifest?.components.chat || readMcpComponentVersion(serverPath, "CHAT_SCHEMA_VERSION");
  const installedRecipeVersion = manifest?.components.recipes || readMcpComponentVersion(serverPath, "RECIPE_SCHEMA_VERSION");
  const installedAgentSessionVersion = manifest?.components.agent_sessions || readMcpComponentVersion(serverPath, "AGENT_SESSION_SCHEMA_VERSION");
  let bundledBuild = "";
  let newerExtensionGeneration = false;
  if (manifest) {
    try {
      const extensionRoot = path.resolve(__dirname, "..", "..");
      bundledBuild = bundledMcpBuildIdentity(extensionRoot);
      const extensionVersion = JSON.parse(fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8")).version;
      newerExtensionGeneration = (compareVersionOrder(manifest.extensionVersion, extensionVersion) || 0) > 0;
    }
    catch { /* Missing bundled artifacts are not a current managed runtime. */ }
  }
  const newerThanExpected = newerExtensionGeneration || hasNewerMcpRuntime(
    {
      unified: installedVersion,
      knowledge: installedKnowledgeVersion,
      chat: installedChatVersion,
      recipe: installedRecipeVersion,
      agentSession: installedAgentSessionVersion,
    },
    {
      unified: UNIFIED_MCP_VERSION,
      knowledge: KNOWLEDGE_MCP_VERSION,
      chat: CHAT_MCP_VERSION,
      recipe: RECIPE_MCP_VERSION,
      agentSession: AGENT_SESSION_MCP_VERSION,
    },
  );
  return {
    installed: !!installedVersion, serverPath,
    expectedVersion: UNIFIED_MCP_VERSION, installedVersion,
    current: !!manifest && manifest.runtimeBuild === bundledBuild && installedVersion === UNIFIED_MCP_VERSION && installedKnowledgeVersion === KNOWLEDGE_MCP_VERSION
      && installedChatVersion === CHAT_MCP_VERSION && installedRecipeVersion === RECIPE_MCP_VERSION
      && installedAgentSessionVersion === AGENT_SESSION_MCP_VERSION,
    knowledgeVersion: KNOWLEDGE_MCP_VERSION,
    chatVersion: CHAT_MCP_VERSION,
    recipeVersion: RECIPE_MCP_VERSION,
    agentSessionVersion: AGENT_SESSION_MCP_VERSION,
    installedKnowledgeVersion,
    installedChatVersion,
    installedRecipeVersion,
    installedAgentSessionVersion,
    newerThanExpected,
    lifecycle: managedMcpLifecycleStatus(managedMcpServerDirectory()),
  };
}

export function generateMcpServer(context: vscode.ExtensionContext): { serverPath: string; configSnippet: string } {
  const directory = managedMcpServerDirectory();
  return withManagedMcpGenerationLock(directory, () => {
    const previous = readManagedMcpManifest(directory);
    if (fs.existsSync(path.join(directory, "active-generation.json")) && !previous) {
      throw new Error("Managed MCP generation ownership is unreadable. Preserve existing generations and repair the control file explicitly before upgrading.");
    }
    const extensionVersion = JSON.parse(fs.readFileSync(path.join(context.extensionPath, "package.json"), "utf8")).version;
    if (previous && (compareVersionOrder(previous.extensionVersion, extensionVersion) || 0) > 0) {
      throw new Error(`Refusing to downgrade managed MCP generation from extension ${previous.extensionVersion} using ${extensionVersion}. Upgrade this extension window before regenerating.`);
    }
    const manifest = stageManagedMcpGeneration(directory, context.extensionPath, {
      version: UNIFIED_MCP_VERSION,
      components: { knowledge: KNOWLEDGE_MCP_VERSION, chat: CHAT_MCP_VERSION, recipes: RECIPE_MCP_VERSION, agent_sessions: AGENT_SESSION_MCP_VERSION },
      runtimeMaintenance: `${mcpRuntimePath()}.pkm-maintenance.json`,
    }, target => {
      const snapshotContext: vscode.ExtensionContext = Object.create(context);
      Object.defineProperty(snapshotContext, "extensionPath", { value: path.join(target, "runtime") });
      generateMcpServerFiles(snapshotContext, target);
    });
    const serverPath = path.join(directory, "server.py");
    const temporary = `${serverPath}.${manifest.generation}.tmp`;
    try {
      fs.writeFileSync(temporary, managedMcpLauncher(manifest), { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, serverPath);
      fs.copyFileSync(path.join(directory, "generations", manifest.generation, "requirements.txt"), path.join(directory, "requirements.txt"));
      publishManagedMcpGeneration(directory, manifest);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    const launch = mcpStdioCommand(resolveMcpPython(), [serverPath]);
    return { serverPath, configSnippet: JSON.stringify({ servers: { pkm: { type: "stdio", ...launch } } }, null, 2) };
  });
}

function generateMcpServerFiles(context: vscode.ExtensionContext, mcpDir: string): { serverPath: string; configSnippet: string } {
  const storePath = getStorePath();
  const serverPy  = path.join(mcpDir, "server.py");
  const recipeRuntimePy = path.join(mcpDir, "recipe_runtime.py");
  const recipeHealthPy = path.join(mcpDir, "recipe_health.py");
  const agentSessionRuntimePy = path.join(mcpDir, "agent_session_runtime.py");
  const callGuardPy = path.join(mcpDir, "mcp_call_guard.py");
  const reqTxt    = path.join(mcpDir, "requirements.txt");
  const storeFwd  = storePath.replace(/\\/g, "/");
  const subscriptionCacheFwd = path.join(context.globalStorageUri.fsPath, "subscriptions", "cache").replace(/\\/g, "/");
  const environmentsRegistryFwd = path.join(context.globalStorageUri.fsPath, "environments", "registry.json").replace(/\\/g, "/");
  const retrievalIdentity = createHash("sha256").update(path.resolve(storePath)).digest("hex").slice(0, 16);
  const retrievalStateFwd = path.join(context.globalStorageUri.fsPath, "retrieval", retrievalIdentity).replace(/\\/g, "/");

  const existingStatus = mcpStatus();
  if (existingStatus.newerThanExpected) {
    throw new Error(
      `Refusing to downgrade the installed PKM MCP runtime with the older runtime bundled by this extension. `
      + `Installed unified/components: ${existingStatus.installedVersion || "unknown"} / `
      + `${existingStatus.installedKnowledgeVersion || "unknown"} / ${existingStatus.installedChatVersion || "unknown"} / `
      + `${existingStatus.installedRecipeVersion || "unknown"} / ${existingStatus.installedAgentSessionVersion || "unknown"}; `
      + `bundled: ${UNIFIED_MCP_VERSION} / ${KNOWLEDGE_MCP_VERSION} / ${CHAT_MCP_VERSION} / `
      + `${RECIPE_MCP_VERSION} / ${AGENT_SESSION_MCP_VERSION}. The newer runtime was preserved. `
      + `Upgrade Personal Knowledge Manager before regenerating or repairing the MCP server.`,
    );
  }

  fs.mkdirSync(mcpDir, { recursive: true });
  writeMcpFeatureDomainConfig(configuredMcpFeatureDomains(), mcpDir);
  writeActionWorkspaceConfig();
  generateChatMcpServer(context, mcpDir);
  fs.copyFileSync(path.join(context.extensionPath, "resources", "recipe_runtime.py"), recipeRuntimePy);
  fs.copyFileSync(path.join(context.extensionPath, "resources", "recipe_compiler_bridge.js"), path.join(mcpDir, "recipe_compiler_bridge.js"));
  ensureRecipeCompiler(context.extensionPath, mcpDir, process.execPath);
  fs.copyFileSync(path.join(context.extensionPath, "resources", "action_runtime.py"), path.join(mcpDir, "action_runtime.py"));
  fs.copyFileSync(path.join(context.extensionPath, "resources", "action_modules.py"), path.join(mcpDir, "action_modules.py"));
  fs.copyFileSync(path.join(context.extensionPath, "resources", "action_authoring.py"), path.join(mcpDir, "action_authoring.py"));
  fs.copyFileSync(path.join(context.extensionPath, "resources", "action_monitoring.py"), path.join(mcpDir, "action_monitoring.py"));
  fs.copyFileSync(path.join(context.extensionPath, "resources", "action_azuredevops.py"), path.join(mcpDir, "action_azuredevops.py"));
  fs.copyFileSync(path.join(context.extensionPath, "resources", "action_run_store.py"), path.join(mcpDir, "action_run_store.py"));
  fs.copyFileSync(path.join(context.extensionPath, "resources", "action_recovery.py"), path.join(mcpDir, "action_recovery.py"));
  fs.copyFileSync(path.join(context.extensionPath, "resources", "action_components.py"), path.join(mcpDir, "action_components.py"));
  fs.copyFileSync(path.join(context.extensionPath, "resources", "action_components.js"), path.join(mcpDir, "action_components.js"));
  fs.copyFileSync(path.join(context.extensionPath, "dist", "components", "action-components.js"), path.join(mcpDir, "action_components_ts.js"));
  fs.copyFileSync(path.join(context.extensionPath, "resources", "recipe_health.py"), recipeHealthPy);
  fs.copyFileSync(path.join(context.extensionPath, "resources", "agent_session_runtime.py"), agentSessionRuntimePy);
  fs.copyFileSync(path.join(context.extensionPath, "resources", "api_chat_control.py"), path.join(mcpDir, "api_chat_control.py"));
  fs.copyFileSync(path.join(context.extensionPath, "resources", "knowledge_recovery.py"), path.join(mcpDir, "knowledge_recovery.py"));
  for (const resource of ["knowledge_mutations.py", "knowledge_mutations.js", "knowledge_snapshots.py", "asset_classification.py", "asset_classification.js"]) {
    fs.copyFileSync(path.join(context.extensionPath, "resources", resource), path.join(mcpDir, resource));
  }
  fs.copyFileSync(path.join(context.extensionPath, "resources", "mcp_call_guard.py"), callGuardPy);
  fs.copyFileSync(path.join(context.extensionPath, "resources", "diagnostic_log.py"), path.join(mcpDir, "diagnostic_log.py"));

  fs.writeFileSync(serverPy, `#!/usr/bin/env python3
"""
PKM MCP Server — auto-generated by Personal Knowledge Manager.
Exposes your skills and notes to AI assistants via the Model Context Protocol.

Skills and notes are stored as plain markdown files under skills/ and notes/ —
the files are the single source of truth (there is no database). Writes made by
this server appear immediately in the VS Code panel via its file watcher, and
show up in git history as readable .md diffs.

Read tools:  search_knowledge, retrieval_status,
             list_skills, search_skills, get_skill, list_notes, search_notes, get_note,
             list_papers, search_papers, get_paper, paper_graph,
             list_subscriptions, search_subscribed_content, get_subscribed_content
Write tools: add_note, update_note, delete_note, add_skill, update_skill, delete_skill,
             add_paper, update_paper, delete_paper

Search builds an in-memory FTS5 'trigram' index (CJK-friendly, ranked) at call
time, falling back to substring matching when FTS5 is unavailable.

Install:  pip install fastmcp
Run:      python server.py
"""
import inspect, json, re, sqlite3, datetime, hashlib, uuid, os, socket, time, urllib.request, urllib.parse
from pathlib import Path

SERVER_VERSION = "${UNIFIED_MCP_VERSION}"
KNOWLEDGE_SCHEMA_VERSION = "${KNOWLEDGE_MCP_VERSION}"
CHAT_SCHEMA_VERSION = "${CHAT_MCP_VERSION}"
RECIPE_SCHEMA_VERSION = "${RECIPE_MCP_VERSION}"
AGENT_SESSION_SCHEMA_VERSION = "${AGENT_SESSION_MCP_VERSION}"
MODEL_BASED_ROUTING_ENABLED = False
from typing import Any, Optional, List

try:
    from fastmcp import FastMCP
    from fastmcp.server.middleware import Middleware
except ImportError:
    raise SystemExit("fastmcp not found. Run: pip install fastmcp")

STORE  = Path(r"${storeFwd}")
NOTES  = STORE / "notes"
SKILLS = STORE / "skills"
SUBSCRIPTIONS = Path(r"${subscriptionCacheFwd}")
ENVIRONMENTS = Path(r"${environmentsRegistryFwd}")
RETRIEVAL_STATE = Path(r"${retrievalStateFwd}")
mcp = FastMCP("pkm")


def _enabled_feature_domains():
  try:
    payload = json.loads(Path(__file__).with_name("feature-domains.json").read_text(encoding="utf-8"))
    return set(str(item) for item in (payload.get("enabled") or []))
  except FileNotFoundError:
    return {"knowledge", "automation", "skillRouter"}
  except Exception:
    return set()


_FEATURE_DOMAINS = _enabled_feature_domains()


def _feature_tool(*domains, read_only=False):
  def decorator(function):
    if any(domain in _FEATURE_DOMAINS for domain in domains):
      def wrapper(*args, **kwargs):
        try:
          value = function(*args, **kwargs)
        except PermissionError as error:
          return {"ok": False, "code": "read-only-content", "error": str(error)}
        if not isinstance(value, str):
          return value
        try:
          return json.loads(value)
        except json.JSONDecodeError:
          return value
      wrapper.__name__ = function.__name__
      wrapper.__doc__ = function.__doc__
      wrapper.__annotations__ = {**getattr(function, "__annotations__", {}), "return": Any}
      wrapper.__signature__ = inspect.signature(function).replace(return_annotation=Any)
      mcp.tool(annotations={"readOnlyHint": read_only})(wrapper)
    return function
  return decorator


from agent_session_runtime import register_agent_session_tools
from api_chat_control import register_api_chat_tools
from knowledge_recovery import register_knowledge_recovery_tools
from knowledge_mutations import trash_file, write_markdown, register_knowledge_mutation_tools
from knowledge_snapshots import register_knowledge_snapshot_tools
from asset_classification import register_asset_classification_tools
_KNOWLEDGE_NODE = ${JSON.stringify(process.execPath)}
_KNOWLEDGE_EXTENSION = str(Path(__file__).resolve().parent / "runtime") if (Path(__file__).resolve().parent / "runtime").is_dir() else ${JSON.stringify(context.extensionPath.replace(/\\/g, "/"))}
from mcp_call_guard import McpCallGuardMiddleware, McpDiagnosticsMiddleware, ManagedMcpLifecycle, run_managed_stdio
_MCP_LIFECYCLE = ManagedMcpLifecycle.from_directory(Path(__file__).resolve().parent)
from diagnostic_log import DiagnosticLog
_MCP_DIAGNOSTICS = DiagnosticLog(STORE / ".pkm" / "state" / "diagnostics" / "mcp")
_MCP_DIAGNOSTICS.record("runtime.started", component="unified-mcp", parentPid=os.getppid())


@mcp.tool(annotations={"readOnlyHint": True})
def diagnostics_latest(limit: int = 100) -> dict:
  """Read 1-1000 recent metadata-only diagnostic events from this MCP process; not chat transcripts."""
  if not 1 <= limit <= 1000:
    raise ValueError("limit must be between 1 and 1000; use local diagnostic_log.py export for 100000 rows")
  return {"ok": True, "writer_id": _MCP_DIAGNOSTICS.writer_id,
      "directory": str(_MCP_DIAGNOSTICS.directory), "max_rows": _MCP_DIAGNOSTICS.max_rows,
      "dropped_records": _MCP_DIAGNOSTICS.dropped,
          "records": _MCP_DIAGNOSTICS.latest(limit)}


_AGENT_SESSION_TOOLS = {}
if "knowledge" in _FEATURE_DOMAINS:
  register_knowledge_recovery_tools(mcp, STORE)
  register_knowledge_mutation_tools(mcp, STORE, _KNOWLEDGE_NODE, _KNOWLEDGE_EXTENSION)
  register_knowledge_snapshot_tools(mcp, STORE, _KNOWLEDGE_NODE, _KNOWLEDGE_EXTENSION)
  register_asset_classification_tools(mcp, STORE, _KNOWLEDGE_NODE, _KNOWLEDGE_EXTENSION)
if "automation" in _FEATURE_DOMAINS:
  _AGENT_SESSION_TOOLS = register_agent_session_tools(mcp, STORE)
  register_api_chat_tools(mcp, STORE)
from recipe_runtime import register_recipe_tools, related_recipes
from action_runtime import register_action_tools
if "automation" in _FEATURE_DOMAINS:
  register_action_tools(mcp, STORE)
  register_recipe_tools(mcp, STORE, SUBSCRIPTIONS, ENVIRONMENTS)


def _router_config():
  try:
    return json.loads((RETRIEVAL_STATE / "router-config.json").read_text(encoding="utf-8"))
  except Exception:
    return {"enabledSolutions": ["copilot_default", "l1_online"],
        "sourcePriority": ["pkm-personal", "agent-native"]}


def _enabled_router_solutions():
  enabled = _router_config().get("enabledSolutions") or []
  return set(str(item) for item in enabled)


def _router_source_priority():
  configured = [str(item) for item in (_router_config().get("sourcePriority") or [])
          if str(item).strip()]
  result = []
  for source_id in configured + ["pkm-personal", "agent-native"]:
    if source_id not in result:
      result.append(source_id)
  return result


def _disabled_router_response(tool_name):
  return json.dumps({"ok": False, "disabled": True, "tool": tool_name,
             "fallback": "copilot_default",
             "message": "PKM Exact + BM25 is disabled. Continue with Copilot default search."})

@mcp.tool(annotations={"readOnlyHint": True})
def check_version() -> dict:
  """Return the unified server version and its component schema versions."""
  capabilities = []
  if "knowledge" in _FEATURE_DOMAINS:
    capabilities.extend(["personal-knowledge", "papers", "subscriptions"])
  if "skillRouter" in _FEATURE_DOMAINS:
    capabilities.append("pkm-skills")
  if "automation" in _FEATURE_DOMAINS:
    capabilities.extend(["pkm-chatroom", "pkm-recipes", "agent-snapshot-read"])
  result = {"name": "pkm", "version": SERVER_VERSION,
       "components": {"knowledge": KNOWLEDGE_SCHEMA_VERSION, "chat": CHAT_SCHEMA_VERSION, "recipes": RECIPE_SCHEMA_VERSION,
                "agent_sessions": AGENT_SESSION_SCHEMA_VERSION},
       "enabled_feature_domains": sorted(_FEATURE_DOMAINS),
       "capabilities": capabilities + (["managed-lifecycle-v1"] if _MCP_LIFECYCLE else [])}
  if _MCP_LIFECYCLE:
    result["runtime"] = _MCP_LIFECYCLE.status()
  if "automation" in _FEATURE_DOMAINS:
    result.update({"chat_discovery_tool": "chat_capabilities", "recipe_discovery_tool": "recipe_capabilities",
             "agent_session_discovery_tool": "agent_session_capabilities"})
  if "skillRouter" in _FEATURE_DOMAINS:
    result["skill_discovery_tool"] = "skill_capabilities"
  return result


@mcp.tool(annotations={"readOnlyHint": True})
def mcp_lifecycle_status() -> dict:
  """Report actual runtime ownership, admission and in-flight drain state. Never replays a write."""
  return _MCP_LIFECYCLE.status() if _MCP_LIFECYCLE else {
      "schema": "pkm.mcp.lifecycle/v1", "phase": "unmanaged", "acceptingNewCalls": False,
      "action": "reconnect-required", "message": "No managed generation ownership; reconnect explicitly."}


@mcp.tool(annotations={"readOnlyHint": False})
def mcp_lifecycle_quiesce() -> dict:
  """Fence only this managed process before its owning client drains/closes it. Never cancels or replays tools."""
  return _MCP_LIFECYCLE.quiesce() if _MCP_LIFECYCLE else {
      "schema": "pkm.mcp.lifecycle/v1", "phase": "unmanaged", "acceptingNewCalls": False,
      "action": "reconnect-required", "message": "Legacy drain state is unknown; explicit client action required."}


def _now() -> str:
    return datetime.datetime.utcnow().isoformat()


def _retrieval_request(route, payload=None):
  try:
    endpoint = json.loads((RETRIEVAL_STATE / "worker.json").read_text(encoding="utf-8"))
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"X-PKM-Retrieval-Token": endpoint["token"]}
    if body is not None: headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
      "http://127.0.0.1:{}{}".format(endpoint["port"], route),
      data=body, headers=headers, method="POST" if body is not None else "GET")
    deadline_at_ms = payload.get("deadline_at_ms") if isinstance(payload, dict) else None
    timeout = 30
    if isinstance(deadline_at_ms, (int, float)):
      timeout = max(0.1, min(timeout, (deadline_at_ms - int(time.time() * 1000)) / 1000))
    with urllib.request.urlopen(request, timeout=timeout) as response:
      return json.loads(response.read().decode("utf-8"))
  except urllib.error.HTTPError as error:
    try:
      result = json.loads(error.read().decode("utf-8"))
      if isinstance(result, dict) and result.get("ok") is False:
        return result
    except (ValueError, OSError):
      pass
    finally:
      error.close()
    return {"ok": False, "code": "worker-http-error", "error": str(error)}
  except Exception as error:
    return {"ok": False, "error": "Subscriber retrieval worker unavailable: " + str(error)}


@_feature_tool("knowledge", "skillRouter", read_only=True)
def retrieval_status() -> str:
  """Return the Subscriber-owned persistent retrieval worker and ready corpus revision."""
  return json.dumps(_retrieval_request("/status"), ensure_ascii=False)


@_feature_tool("knowledge", "skillRouter")
def retrieval_feedback(retrieval_id: str, relevant_source_ids: List[str], complete: bool = False,
                       provenance: str = "model") -> str:
  """Submit complete relevance judgments for a model retrieval receipt.

  Include all known relevant canonical source IDs, including missed results.
  complete=true asserts complete judgments; task success, usage and silence are
  not relevance labels. Model self-evaluation trains the local online ranker and
  calibrator by default; embeddings remain frozen. Use provenance="user" only for
  explicit user judgments, which supersede model labels and replay training.
  """
  return json.dumps(_retrieval_request("/retrieval-feedback", {
    "retrieval_id": retrieval_id, "relevant_source_ids": relevant_source_ids, "complete": complete, "provenance": provenance,
  }), ensure_ascii=False)


@_feature_tool("knowledge", "skillRouter", read_only=True)
def search_knowledge(query: str, limit: int = 5, content_type_filter: Optional[List[str]] = None,
             request_id: str = "", debug: bool = False, route: str = "lexical",
             generation_mode: str = "latest-ready", generation: int = 0,
             graph_max_depth: int = 2, graph_max_nodes: int = 100, graph_max_edges: int = 500,
             graph_relations: Optional[List[str]] = None, graph_direction: str = "both",
             capability_source_ids: Optional[List[str]] = None, deadline_ms: int = 5000) -> str:
  """Search one typed index containing local Skills/Notes/Research/Scripts/Recipes and subscribed content.

  Routes lexical / semantic / dual are explicit. No embedding configuration means
  semantic_status=off without loading an encoder. Dual uses RRF and preserves path evidence.
  Query text is passed unchanged so mixed exact syntax remains observable. An explicit
  content_type_filter is strict; type words in query text are only soft preferences. Graph
  traversal is bounded and filtered before unavailable targets can enter the result.
  """
  started_at = time.perf_counter()
  if "l1_online" not in _enabled_router_solutions():
    _collect_search_invocation("pkm.search_knowledge", started_at, [], False, ["copilot-fallback"])
    disabled = json.loads(_disabled_router_response("pkm.search_knowledge"))
    disabled.update({"search_mode": route, "semantic_status": "unavailable", "semantic_reason": "Unified retrieval is disabled"})
    return json.dumps(disabled, ensure_ascii=False)
  if not str(query or "").strip():
    _collect_search_invocation("pkm.search_knowledge", started_at, [], False, ["exact", "bm25"])
    return json.dumps({"ok": False, "error": "query is required"})
  allowed = {"skill", "note", "research", "script", "recipe", "subscription"}
  if content_type_filter is not None and (not isinstance(content_type_filter, list) or not content_type_filter
                                         or any(str(value) not in allowed for value in content_type_filter)):
    _collect_search_invocation("pkm.search_knowledge", started_at, [], False, ["exact", "bm25"])
    return json.dumps({"ok": False, "error": "Invalid content_type_filter"})
  requested_limit = max(1, min(int(limit or 5), 100))
  if route not in {"lexical", "semantic", "dual", "graph", "hybrid"}:
    return json.dumps({"ok": False, "error": "Invalid route"})
  if generation_mode not in {"latest-ready", "exact", "minimum"}:
    return json.dumps({"ok": False, "error": "Invalid generation_mode"})
  if generation_mode != "latest-ready" and int(generation or 0) < 1:
    return json.dumps({"ok": False, "error": "generation must be positive for exact or minimum policy"})
  if graph_direction not in {"forward", "backlink", "both"}:
    return json.dumps({"ok": False, "error": "Invalid graph_direction"})
  deadline_at_ms = int(time.time() * 1000) + max(1, min(int(deadline_ms or 5000), 300000))
  result = _retrieval_request("/search", {
    "query": query, "limit": min(100, max(requested_limit, requested_limit * 5)),
    **({"output_limit": requested_limit} if route in {"semantic", "dual"} else {}),
    "content_type_filter": content_type_filter, "request_id": request_id,
    "route": route,
    "generation": {"mode": generation_mode, **({"generation": int(generation)} if generation_mode != "latest-ready" else {})},
    "scope": {"capability_id": "mcp.search_knowledge", "source_ids": capability_source_ids},
    "graph": {
      "max_depth": max(1, min(int(graph_max_depth or 2), 32)),
      "max_nodes": max(1, min(int(graph_max_nodes or 100), 10000)),
      "max_edges": max(1, min(int(graph_max_edges or 500), 50000)),
      "relations": graph_relations, "direction": graph_direction,
    },
    "deadline_at_ms": deadline_at_ms,
  })
  if not result.get("ok"):
    result = {**result, "search_mode": route, "semantic_status": "unavailable",
              "semantic_reason": result.get("error") or "Retrieval worker unavailable"}
  if result.get("ok"):
    def priority_multiplier(hit):
      metadata = hit.get("metadata") or {}
      provenance = hit.get("provenance") or {}
      priority = _skill_priority(metadata.get("source_priority") or metadata.get("priority")
                                 or provenance.get("source_priority"))
      return {"normal": 1.0, "high": 1.12, "highest": 1.24}[priority]
    result = dict(result)
    ranked_hits = [dict(hit) for hit in (result.get("hits") or [])
                   if _matches_retrieval_types(hit, content_type_filter)]
    ranked_hits.sort(key=lambda hit: (
      -(float(hit.get("score") or 0) * (1.0 if route in {"dual", "semantic"} else priority_multiplier(hit))),
      int(hit.get("rank") or 0),
      str(hit.get("skill_id") or ""),
    ))
    for index, hit in enumerate(ranked_hits[:requested_limit], 1):
      hit["rank"] = index
    result["truncated"] = bool(result.get("truncated")) or len(ranked_hits) > requested_limit
    result["limit_reached"] = bool(result.get("limit_reached")) or len(ranked_hits) >= min(100, requested_limit * 5)
    result["incomplete"] = bool(result.get("incomplete")) or result["truncated"] or result["limit_reached"]
    result["hits"] = ranked_hits[:requested_limit]
    result["result_count"] = len(result["hits"])
    result["groups"] = {}
    for hit in result["hits"]:
      result["groups"].setdefault(hit.get("content_type"), []).append(hit.get("source_id") or hit.get("skill_id"))
    result["counts"] = {kind: len(source_ids) for kind, source_ids in result["groups"].items()}
  result_ids = [hit.get("content_hash") or hit.get("skill_id") for hit in (result.get("hits") or [])]
  _collect_search_invocation("pkm.search_knowledge", started_at, result_ids, bool(result.get("ok")), ["exact", "bm25"])
  if debug or not result.get("ok"):
    return json.dumps(result, ensure_ascii=False)
  hits = []
  for hit in result.get("hits") or []:
    provenance = hit.get("provenance") or {}
    compact_provenance = {key: provenance.get(key) for key in
      ["provider", "broker", "subscription_id", "revision", "source_priority"] if provenance.get(key) is not None}
    compact_hit = {
      "rank": hit.get("rank"), "score": float(hit.get("score") or 0) if hit.get("score_semantics") == "rrf" else round(float(hit.get("score") or 0), 6),
      "skill_id": hit.get("skill_id"), "content_hash": hit.get("content_hash"),
      "source_id": hit.get("source_id"), "source_revision": hit.get("source_revision"),
      "score_components": hit.get("score_components") or {},
      "sources": hit.get("sources"), "source_label": hit.get("source_label"),
      "path_evidence": hit.get("path_evidence"), "score_semantics": hit.get("score_semantics"),
      "content_type": hit.get("content_type"), "source_uri": hit.get("source_uri"),
      "title": hit.get("title"), "description": hit.get("description"),
      "read_only": bool(hit.get("read_only")), "provenance": compact_provenance,
    }
    linkage = _retrieval_hit_linkage(hit)
    if linkage:
      compact_hit["linkage"] = linkage
    hits.append(compact_hit)
  compact = {key: result.get(key) for key in [
    "schema", "ok", "request_id", "corpus_revision", "ready_generation", "route", "query_intent", "exact_terms",
    "search_mode", "semantic_status", "semantic_reason", "solution", "skill_serving",
    "retrieval_id", "adaptive", "learning_error", "model_invoked",
    "lexical_anchors", "requested_content_types", "content_type_routing", "stale", "incomplete", "diagnostics",
    "truncated", "limit_reached", "result_count", "groups", "counts"]}
  compact["hits"] = hits
  return json.dumps(compact, ensure_ascii=False)


def _matches_retrieval_types(hit, requested):
  return (not requested or hit.get("content_type") in requested
          or ("subscription" in requested and ((hit.get("provenance") or {}).get("provider") == "broker"
              or str(hit.get("source_uri") or "").startswith("pkm://subscriptions/"))))


def _knowledge_read_key(identifier, legacy_key=None):
  if identifier and legacy_key and identifier != legacy_key:
    return "", json.dumps({"ok": False, "error": "id and legacy name/slug must identify the same item"})
  key = str(identifier or legacy_key or "").strip()
  if not key:
    return "", json.dumps({"ok": False, "error": "id is required"})
  return key, None


def _canonical_knowledge_id(identifier):
  return identifier.startswith(("pkm://knowledge/", "pkm://script/", "pkm://subscriptions/", "knowledge_", "script_"))


@_feature_tool("knowledge", read_only=True)
def get_knowledge(id: str, content_type_filter: Optional[List[str]] = None) -> str:
  """Read the indexed revision by search result source_id, preserving its hash, type, provenance and read-only status."""
  if not str(id or "").strip():
    return json.dumps({"ok": False, "error": "id is required"})
  allowed = {"skill", "note", "research", "script", "recipe", "subscription"}
  if content_type_filter is not None and (not isinstance(content_type_filter, list) or not content_type_filter
                                         or any(value not in allowed for value in content_type_filter)):
    return json.dumps({"ok": False, "error": "Invalid content_type_filter"})
  return json.dumps(_retrieval_request("/get", {"source_id": id.strip(), "content_type_filter": content_type_filter}), ensure_ascii=False)


@_feature_tool("knowledge", read_only=True)
def get_script(id: str) -> str:
  """Read only a Script by stable source_id; this never executes the Script."""
  return get_knowledge(id, content_type_filter=["script"])


def _search_typed_knowledge(query, content_type, limit, detail, tool_name, route="lexical"):
  if detail not in {"legacy", "standard"}:
    return json.dumps({"ok": False, "error": "detail must be legacy or standard"})
  if route not in {"lexical", "semantic", "dual", "graph", "hybrid"}:
    return json.dumps({"ok": False, "error": "Invalid route"})
  if route in {"semantic", "dual"} and detail == "legacy":
    detail = "standard"  # Zero hits and model/transport failure must retain their status.
  started_at = time.perf_counter()
  result = json.loads(search_knowledge(query, limit=limit, content_type_filter=[content_type], debug=detail == "legacy", route=route))
  _collect_search_invocation(tool_name, started_at,
      [hit.get("content_hash") or hit.get("source_id") for hit in result.get("hits") or []],
      bool(result.get("ok")), ["unified-retrieval"])
  if detail == "standard":
    return json.dumps(result, ensure_ascii=False)
  if not result.get("ok"):
    return None
  rows = []
  for hit in result.get("hits") or []:
    row = {key: hit.get(key) for key in ["rank", "score", "source_id", "source_revision", "content_hash",
           "content_type", "source_uri", "title", "description", "read_only", "provenance",
           "sources", "source_label", "path_evidence", "score_semantics"]}
    row.update({key: result.get(key) for key in ["search_mode", "semantic_status", "semantic_reason"]})
    key = str(hit.get("skill_id") or "").removeprefix(content_type + ":")
    if content_type == "skill":
      skill = _skill_by_id(key)
      row.update({"skill_id": key, "name": hit.get("title"), "skill_serving": result.get("skill_serving")})
      if skill:
        priority = _router_source_priority()
        row.update({"name": skill["name"], "category": skill["category"], "source": skill.get("source", "local"),
                    "source_key": _skill_source_key(skill), "source_rank": _skill_source_rank(skill, priority) + 1,
                    "priority": skill.get("priority", "normal"), "content_hash": _skill_hash(skill),
                    "linkage": _skill_linkage(skill)})
    elif content_type == "note":
      note = next((value for value in _all_notes() if value["slug"] == key), None)
      row.update({"slug": key, "type": note["type"] if note else (hit.get("metadata") or {}).get("type", "general")})
    elif content_type == "research":
      papers = _all_papers()
      paper = next((value for value in papers if value["slug"] == key), None)
      row.update({"slug": key, "year": paper.get("year") if paper else None,
                  "topic": paper.get("topic", "") if paper else "", "citation_count": _citation_counts(papers).get(key, 0)})
    rows.append(row)
  return json.dumps(rows, ensure_ascii=False)


@_feature_tool("knowledge", read_only=True)
def search_scripts(query: str, limit: int = 20, detail: str = "legacy", route: str = "lexical") -> str:
  """Search only Scripts. Semantic/dual routes always expose model status; lexical defaults preserve legacy arrays."""
  result = _search_typed_knowledge(query, "script", limit, detail, "pkm.search_scripts", route=route)
  return result if result is not None else json.dumps({"ok": False, "error": "Subscriber retrieval worker unavailable"})


_COLLECTOR_SESSION_ID = os.environ.get("PKM_COLLECTOR_SESSION_ID") or (
  f"{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:8]}"
)


def _collector_post(event_type, interaction_id, payload):
  """Best-effort observation; collector availability never affects PKM tools."""
  try:
    payload = dict(payload)
    payload["collector_session_id"] = _COLLECTOR_SESSION_ID
    event = {"event_id": str(uuid.uuid4()), "interaction_id": interaction_id,
         "event_type": event_type, "occurred_at": _now(),
         "source_node_id": os.environ.get("PKM_COLLECTOR_NODE_ID") or socket.gethostname(),
         "observation_source": "live_agent", "schema_version": 1,
         "payload": payload}
    request = urllib.request.Request(
      os.environ.get("PKM_COLLECTOR_URL", "http://127.0.0.1:8766/api/collector/events"),
      data=json.dumps(event, ensure_ascii=False).encode("utf-8"),
      headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=0.2):
      pass
  except Exception:
    pass


def _collect_search_invocation(tool_name, started_at, result_ids, success=True, routes=None, interaction_id=""):
  """Collect search behavior without collecting query text or query-derived terms."""
  hashed_results = [hashlib.sha256(str(value).encode("utf-8")).hexdigest()
            for value in (result_ids or []) if value is not None]
  _collector_post("search_invocation", interaction_id or str(uuid.uuid4()), {
    "tool_name": tool_name,
    "duration_ms": max(0, round((time.perf_counter() - started_at) * 1000, 3)),
    "success": bool(success),
    "result_count": len(hashed_results),
    "result_hashes": hashed_results,
    "routes": list(routes or []),
    "model_based_routing_enabled": False,
  })


_SKILL_ROUTER_TOOLS = {
  "skill_capabilities", "skill_context", "skill_feedback", "propose_skill_update",
  "search_knowledge", "search_skills", "get_skill", "retrieval_status",
}


def _tool_domain(tool_name):
  if tool_name.startswith("agent_session_") or tool_name.startswith("recipe_") or tool_name.startswith("action_") or tool_name.startswith("chat_") or tool_name.startswith("api_chat_") or tool_name == "check_chat_version":
    return "automation"
  if tool_name in _SKILL_ROUTER_TOOLS:
    return "skillRouter"
  return "knowledge"


def _plain_value(value):
  if hasattr(value, "model_dump"):
    try:
      return value.model_dump()
    except Exception:
      pass
  if isinstance(value, dict):
    return {str(key): _plain_value(item) for key, item in value.items()}
  if isinstance(value, (list, tuple)):
    return [_plain_value(item) for item in value]
  if isinstance(value, (str, int, float, bool)) or value is None:
    return value
  return str(value)


def _usage_metrics(value):
  reported = {"input": 0, "output": 0}
  result_count = 0

  def visit(item):
    nonlocal result_count
    if isinstance(item, str):
      text = item.strip()
      if text.startswith("{") or text.startswith("["):
        try:
          visit(json.loads(text))
        except Exception:
          pass
      return
    if isinstance(item, list):
      for child in item:
        visit(child)
      return
    if not isinstance(item, dict):
      return
    for key in ("hits", "skills", "results", "items"):
      if isinstance(item.get(key), list):
        result_count = max(result_count, len(item[key]))
    usage = item.get("usage")
    if isinstance(usage, dict):
      reported["input"] += int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0)
      reported["output"] += int(usage.get("output_tokens") or usage.get("completion_tokens") or 0)
    for child in item.values():
      visit(child)

  visit(value)
  return result_count, reported


def _active_todo_attribution(context, arguments):
  try:
    fastmcp_context = getattr(context, "fastmcp_context", None)
    transport_id = str(getattr(fastmcp_context, "session_id", "") or "")
    if not transport_id:
      return {}
    transport_key = hashlib.sha256(transport_id.encode("utf-8")).hexdigest()
    active_path = STORE / ".pkm" / "state" / "agent-sessions" / "active" / (transport_key + ".json")
    active = json.loads(active_path.read_text(encoding="utf-8"))
    agent_session_id = str(active.get("sessionId") or "")
    if not re.fullmatch(r"agent_session_[A-Za-z0-9_-]+", agent_session_id):
      return {}
    session_path = STORE / ".pkm" / "state" / "agent-sessions" / (agent_session_id + ".json")
    session = json.loads(session_path.read_text(encoding="utf-8"))
    if session.get("schema") != "pkm.agent.session/v1":
      return {}
    todos = [todo for todo in (session.get("todos") or []) if isinstance(todo, dict)]
    plain_arguments = _plain_value(arguments)
    requested_todo_id = str(plain_arguments.get("todo_id") or "") if isinstance(plain_arguments, dict) else ""
    todo = next((item for item in todos if item.get("todoId") == requested_todo_id), None)
    if todo is None:
      todo = next((item for item in todos if item.get("status") == "running"), None)
    todo_id = str((todo or {}).get("todoId") or "")
    if not re.fullmatch(r"todo_[A-Za-z0-9_-]+", todo_id):
      return {}
    attribution = {"agentSessionId": agent_session_id, "todoId": todo_id}
    run_id = str(plain_arguments.get("run_id") or "") if isinstance(plain_arguments, dict) else ""
    node_id = str(plain_arguments.get("node_id") or "") if isinstance(plain_arguments, dict) else ""
    if (re.fullmatch(r"recipe_run_[A-Za-z0-9_-]+", run_id)
        and node_id and run_id in (session.get("recipeRunIds") or [])):
      try:
        run = json.loads((STORE / ".pkm" / "state" / "recipe-runs" / (run_id + ".json")).read_text(encoding="utf-8"))
        if run.get("schema") == "pkm.recipe.run/v1" and run.get("runId") == run_id and node_id in (run.get("nodes") or {}):
          attribution.update({"recipeRunId": run_id, "nodeId": node_id})
      except (OSError, ValueError):
        pass
    return attribution
  except Exception:
    return {}


def _increment_usage_bucket(buckets, name, input_bytes, output_bytes, duration_ms, success):
  if not name or (name not in buckets and len(buckets) >= 128):
    return
  bucket = buckets.setdefault(name, {
    "calls": 0, "successes": 0, "inputBytes": 0, "outputBytes": 0, "durationMs": 0,
  })
  bucket["calls"] = int(bucket.get("calls") or 0) + 1
  bucket["successes"] = int(bucket.get("successes") or 0) + int(bool(success))
  bucket["inputBytes"] = int(bucket.get("inputBytes") or 0) + input_bytes
  bucket["outputBytes"] = int(bucket.get("outputBytes") or 0) + output_bytes
  bucket["durationMs"] = round(float(bucket.get("durationMs") or 0) + duration_ms, 3)


def _record_todo_usage(attribution, event):
  agent_session_id = str((attribution or {}).get("agentSessionId") or "")
  todo_id = str((attribution or {}).get("todoId") or "")
  if (not re.fullmatch(r"agent_session_[A-Za-z0-9_-]+", agent_session_id)
      or not re.fullmatch(r"todo_[A-Za-z0-9_-]+", todo_id)):
    return
  directory = STORE / ".pkm" / "state" / "mcp-usage" / "todos" / agent_session_id
  directory.mkdir(parents=True, exist_ok=True)
  destination = directory / (todo_id + ".json")
  lock = directory / (todo_id + ".lock")
  deadline = time.monotonic() + 2
  while True:
    try:
      descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
      os.close(descriptor)
      break
    except FileExistsError:
      try:
        if time.time() - lock.stat().st_mtime > 30:
          lock.unlink(missing_ok=True)
          continue
      except FileNotFoundError:
        continue
      if time.monotonic() >= deadline:
        return
      time.sleep(0.01)
  try:
    try:
      aggregate = json.loads(destination.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
      aggregate = {}
    if (aggregate.get("schema") != "pkm.mcp.todo-usage/v1"
        or aggregate.get("agentSessionId") != agent_session_id
        or aggregate.get("todoId") != todo_id):
      aggregate = {
        "schema": "pkm.mcp.todo-usage/v1", "agentSessionId": agent_session_id, "todoId": todo_id,
        "calls": 0, "successes": 0, "inputBytes": 0, "outputBytes": 0, "durationMs": 0,
        "estimatedTokens": 0, "firstUsedAt": event["occurredAt"], "lastUsedAt": event["occurredAt"],
        "domains": {}, "tools": {},
      }
    input_bytes = int(event["inputBytes"])
    output_bytes = int(event["outputBytes"])
    duration_ms = float(event["durationMs"])
    aggregate["calls"] = int(aggregate.get("calls") or 0) + 1
    aggregate["successes"] = int(aggregate.get("successes") or 0) + int(bool(event["success"]))
    aggregate["inputBytes"] = int(aggregate.get("inputBytes") or 0) + input_bytes
    aggregate["outputBytes"] = int(aggregate.get("outputBytes") or 0) + output_bytes
    aggregate["durationMs"] = round(float(aggregate.get("durationMs") or 0) + duration_ms, 3)
    aggregate["estimatedTokens"] = int(aggregate.get("estimatedTokens") or 0) + int(event["estimatedTokenEquivalent"])
    aggregate["lastUsedAt"] = event["occurredAt"]
    _increment_usage_bucket(aggregate.setdefault("domains", {}), event["domain"],
                            input_bytes, output_bytes, duration_ms, event["success"])
    _increment_usage_bucket(aggregate.setdefault("tools", {}), event["toolName"],
                            input_bytes, output_bytes, duration_ms, event["success"])
    if attribution.get("recipeRunId") and attribution.get("nodeId"):
      module_key = attribution["recipeRunId"] + ":" + attribution["nodeId"]
      modules = aggregate.setdefault("modules", {})
      _increment_usage_bucket(modules, module_key, input_bytes, output_bytes, duration_ms, event["success"])
      if module_key in modules:
        bucket = modules[module_key]
        bucket["estimatedTokens"] = int(bucket.get("estimatedTokens") or 0) + int(event["estimatedTokenEquivalent"])
    temporary = directory / (todo_id + "." + str(os.getpid()) + "." + str(uuid.uuid4()) + ".tmp")
    with open(temporary, "x", encoding="utf-8") as handle:
      handle.write(json.dumps(aggregate, ensure_ascii=False, sort_keys=True))
      handle.flush()
      os.fsync(handle.fileno())
    os.replace(temporary, destination)
  finally:
    lock.unlink(missing_ok=True)


def _record_tool_usage(tool_name, arguments, result, duration_ms, success, attribution=None):
  try:
    plain_arguments = _plain_value(arguments)
    plain_result = _plain_value(result)
    input_bytes = len(json.dumps(plain_arguments, ensure_ascii=False, default=str).encode("utf-8"))
    output_bytes = len(json.dumps(plain_result, ensure_ascii=False, default=str).encode("utf-8"))
    result_count, reported = _usage_metrics(plain_result)
    event_id = str(uuid.uuid4())
    event = {
      "schema": 1, "eventId": event_id, "sessionId": _COLLECTOR_SESSION_ID,
      "occurredAt": _now(), "toolName": tool_name, "domain": _tool_domain(tool_name),
      "inputBytes": input_bytes, "outputBytes": output_bytes,
      "durationMs": max(0, round(duration_ms, 3)), "success": bool(success),
      "resultCount": result_count,
      "estimatedTokenEquivalent": (input_bytes + output_bytes + 3) // 4,
      "reportedTokens": reported,
    }
    if attribution:
      event["agentSessionId"] = attribution["agentSessionId"]
      event["todoId"] = attribution["todoId"]
      if attribution.get("recipeRunId") and attribution.get("nodeId"):
        event["recipeRunId"] = attribution["recipeRunId"]
        event["nodeId"] = attribution["nodeId"]
    directory = STORE / ".pkm" / "state" / "mcp-usage" / "events"
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / (event_id + ".json")
    temporary = directory / (event_id + "." + str(os.getpid()) + ".tmp")
    with open(temporary, "x", encoding="utf-8") as handle:
      handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True))
      handle.flush()
      os.fsync(handle.fileno())
    os.replace(temporary, destination)
    _record_todo_usage(attribution, event)
  except Exception:
    pass


class ToolUsageMiddleware(Middleware):
  async def on_call_tool(self, context, call_next):
    started_at = time.perf_counter()
    message = getattr(context, "message", None)
    tool_name = str(getattr(message, "name", "") or "")
    arguments = getattr(message, "arguments", None) or {}
    attribution_before = _active_todo_attribution(context, arguments)
    try:
      result = await call_next(context)
    except Exception:
      _record_tool_usage(tool_name, arguments, {}, (time.perf_counter() - started_at) * 1000, False,
                         attribution_before)
      raise
    plain_result = _plain_value(result)
    success = not (isinstance(plain_result, dict) and (plain_result.get("ok") is False or plain_result.get("error")))
    attribution = attribution_before or _active_todo_attribution(context, arguments)
    _record_tool_usage(tool_name, arguments, plain_result, (time.perf_counter() - started_at) * 1000, success,
                       attribution)
    return result


if _MCP_LIFECYCLE:
  mcp.add_middleware(_MCP_LIFECYCLE)
mcp.add_middleware(McpDiagnosticsMiddleware(_MCP_DIAGNOSTICS))
mcp.add_middleware(ToolUsageMiddleware())
mcp.add_middleware(McpCallGuardMiddleware(mcp))


# ── Frontmatter (matches the extension's minimal YAML subset) ────────────────
def _parse(text):
    m = re.match(r"^---\\r?\\n(.*?)\\r?\\n---\\r?\\n?", text, re.S)
    if not m:
        return {}, text
    fm = {}
    for line in m.group(1).splitlines():
        i = line.find(":")
        if i < 0:
            continue
        k = line[:i].strip()
        raw = line[i + 1:].strip()
        if not k:
            continue
        try:
            fm[k] = json.loads(raw)
        except Exception:
            fm[k] = raw.strip("\\"'")
    return fm, text[m.end():]


def _serialize(fm, body):
    lines = ["---"]
    for k, v in fm.items():
        if v is None:
            continue
        if isinstance(v, bool):
            lines.append(f"{k}: {'true' if v else 'false'}")
        elif isinstance(v, (list, str)):
            lines.append(f"{k}: {json.dumps(v, ensure_ascii=False)}")
        else:
            lines.append(f"{k}: {v}")
    lines += ["---", ""]
    return "\\n".join(lines) + (body or "")


# ── Paths / identity (identity = relative path w/o .md; category = folders) ──
def _safe_name(s):
    s = re.sub(r'[/\\\\:*?"<>|]', "", s or "")
    s = "".join(ch for ch in s if ord(ch) >= 32).strip()
    return s or "untitled"


def _safe_cat(cat):
    if not cat or not cat.strip():
        return ""
    return "/".join(_safe_name(p.strip()) for p in cat.split("/") if p.strip())


def _cat_of(key):
    return key.rsplit("/", 1)[0] if "/" in key else ""

def _mcp_system_path(file_path):
    for candidate, root in [(Path(file_path).absolute(), STORE.absolute()),
                            (Path(file_path).resolve(), STORE.resolve())]:
        try:
            parts = candidate.relative_to(root).parts
        except ValueError:
            continue
        if len(parts) > 1 and parts[0].casefold() in {"notes", "skills", "prompts", "recipes"} and parts[1].casefold() == "system":
            return True
    return False


def _assert_mcp_writable(content_root, *file_paths):
    for file_path in file_paths:
        if file_path is None:
            continue
        if _mcp_system_path(file_path):
            raise PermissionError("System files and folders are read-only for Agent MCP writes.")
        try:
            Path(file_path).resolve().relative_to(content_root.resolve())
            Path(file_path).resolve().relative_to(STORE.resolve())
        except ValueError:
            raise PermissionError("MCP writes must remain inside their content directory.")


def _name_of(key):
    return key.rsplit("/", 1)[-1]


def _walk(root):
    out = []
    if not root.exists():
        return out
    for p in root.rglob("*.md"):
        rel = p.relative_to(root)
        if any(part.startswith(".") or part == "_assets" or part.lower().endswith(".assets") for part in rel.parts):
            continue
        out.append((p, rel.as_posix()[:-3]))
    return out


def _mtime(p):
    return datetime.datetime.utcfromtimestamp(p.stat().st_mtime).isoformat()


# ── Notes ────────────────────────────────────────────────────────────────────
def _note(p, key):
    fm, body = _parse(p.read_text(encoding="utf-8"))
    return {"slug": key, "title": fm.get("title") or _name_of(key),
            "type": fm.get("type") or "general", "tags": fm.get("tags") or [],
            "category": _cat_of(key), "content": body, "updated_at": _mtime(p),
            "read_only": _mcp_system_path(p)}


def _all_notes():
    return [_note(p, k) for p, k in _walk(NOTES)]


def _note_get(slug):
    p = NOTES / (slug + ".md")
    return _note(p, slug) if p.exists() else None


def _note_write(slug, title, content, type_, tags, category, created=None):
    cat = _safe_cat(category or "")
    fname = _safe_name(title or _name_of(slug)) + ".md"
    rel = (cat + "/" + fname) if cat else fname
    full = NOTES / rel
    old = NOTES / (slug + ".md")
    _assert_mcp_writable(NOTES, full, old)
    fm = {"title": title, "type": type_ or "general", "tags": tags or [],
          "created": created or _now()}
    write_markdown(STORE, "notes", rel, old.relative_to(NOTES).as_posix() if old.exists() else None,
                   _serialize(fm, content or ""), _KNOWLEDGE_NODE, _KNOWLEDGE_EXTENSION)
    return rel[:-3]


# ── Skills ───────────────────────────────────────────────────────────────────
def _skill_priority(value, strict=False):
    normalized = str(value or "normal").strip().lower()
    if normalized in {"normal", "high", "highest"}:
        return normalized
    if strict:
        raise ValueError("Skill priority must be normal, high, or highest.")
    return "normal"


def _skill(p, key):
    fm, body = _parse(p.read_text(encoding="utf-8"))
    return {"name": fm.get("name") or _name_of(key), "description": fm.get("description") or "",
            "category": _cat_of(key), "tags": fm.get("tags") or [],
      "source_project": fm.get("source_project"), "recipe_required": fm.get("recipe_required") is True,
      "recipe_hint": str(fm.get("recipe_hint") or ""),
      "related_skills": _arr(fm.get("related_skills")),
      "priority": _skill_priority(fm.get("priority")),
      "content": body, "updated_at": _mtime(p), "read_only": _mcp_system_path(p)}


def _all_skills():
    rows = [_skill(p, k) for p, k in _walk(SKILLS)]
    for record in _subscription_records():
      root = Path(record["cache_root"]) / "content" / "skills"
      for skill_path, key in _walk(root):
        row = _skill(skill_path, key)
        relative_path = key + ".md"
        encoded_path = "/".join(urllib.parse.quote(part, safe="") for part in relative_path.split("/"))
        pkm_path = "pkm://subscriptions/{}/{}/skills/{}".format(
          urllib.parse.quote(str(record.get("nodeId") or ""), safe=""),
          urllib.parse.quote(str(record.get("shareId") or ""), safe=""), encoded_path)
        source_priority = _skill_priority(record.get("priority"))
        effective_priority = max([row.get("priority", "normal"), source_priority],
                     key=lambda value: {"normal": 0, "high": 1, "highest": 2}.get(value, 0))
        row.update({"skill_id": pkm_path, "source": "subscription", "read_only": True,
          "priority": effective_priority,
          "provenance": {"subscription_id": record.get("subscriptionId"), "alias": record.get("alias"),
            "publisher": record.get("publisher"), "node_id": record.get("nodeId"), "share_id": record.get("shareId"),
            "revision": record.get("revision"), "synced_at": record.get("syncedAt"),
            "source_priority": _skill_priority(record.get("priority")), "pkm_path": pkm_path}})
        rows.append(row)
    return rows


def _find_skill(name):
    for p, k in _walk(SKILLS):
        fm, _ = _parse(p.read_text(encoding="utf-8"))
        if (fm.get("name") or _name_of(k)) == name:
            return p, k
    return None, None


def _skill_get(name):
    p, k = _find_skill(name)
    return _skill(p, k) if p else None


def _skill_write(name, content, description, category, tags, source_project=None, created=None,
                 recipe_required=False, recipe_hint="", related_skills=None, priority="normal"):
    cat = _safe_cat(category or "")
    fname = _safe_name(name) + ".md"
    rel = (cat + "/" + fname) if cat else fname
    full = SKILLS / rel
    oldp, _ = _find_skill(name)
    _assert_mcp_writable(SKILLS, full, oldp)
    normalized_priority = _skill_priority(priority, strict=True)
    fm = {"name": name, "description": description or "", "tags": tags or [],
          "source_project": source_project, "recipe_required": True if recipe_required else None,
          "recipe_hint": recipe_hint or None, "related_skills": related_skills or None,
          "priority": normalized_priority if normalized_priority != "normal" else None,
          "created": created or _now()}
    write_markdown(STORE, "skills", rel, oldp.relative_to(SKILLS).as_posix() if oldp else None,
                   _serialize(fm, content or ""), _KNOWLEDGE_NODE, _KNOWLEDGE_EXTENSION)
    return name


# ── Papers ───────────────────────────────────────────────────────────────────
PAPERS = STORE / "papers"

def _arr(x):
    return x if isinstance(x, list) else ([x] if x else [])

def _year(v):
    if isinstance(v, int): return v
    try: return int(str(v))
    except Exception: return None

def _norm_cites(v):
    out = []
    if isinstance(v, list):
        for e in v:
            if isinstance(e, str):
                if e.strip(): out.append({"paper": e.strip(), "note": ""})
            elif isinstance(e, dict):
                p = str(e.get("paper") or e.get("key") or "").strip()
                if p: out.append({"paper": p, "note": str(e.get("note") or e.get("comment") or "")})
    return out

def _paper(p, key):
    fm, body = _parse(p.read_text(encoding="utf-8"))
    return {"slug": key, "title": fm.get("title") or _name_of(key),
            "kind": "idea" if fm.get("kind") == "idea" else "paper",
            "group": (str(fm.get("group")).strip() if fm.get("group") else "") or "Papers",
            "pinned": fm.get("pinned") is True,
            "authors": _arr(fm.get("authors")), "year": _year(fm.get("year")),
            "topic": fm.get("topic") or "", "publisher": fm.get("publisher") or "",
            "tags": _arr(fm.get("tags")), "url": fm.get("url") or "", "file": fm.get("file") or "",
            "conclusions": _arr(fm.get("conclusions")), "cites": _norm_cites(fm.get("cites")),
            "category": _cat_of(key), "content": body, "updated_at": _mtime(p)}

def _all_papers():
    return [_paper(p, k) for p, k in _walk(PAPERS)]

def _paper_get(slug):
    p = PAPERS / (slug + ".md")
    return _paper(p, slug) if p.exists() else None

def _paper_resolver(all_p):
    by_key = {p["slug"].lower(): p["slug"] for p in all_p}
    by_title = {p["title"].lower(): p["slug"] for p in all_p}
    def r(ref):
        k = str(ref or "").lower()
        if k.endswith(".md"): k = k[:-3]
        return by_key.get(k) or by_title.get(k)
    return r

def _citation_counts(all_p):
    resolve = _paper_resolver(all_p)
    counts = {}
    for p in all_p:
        for c in p["cites"]:
            t = resolve(c["paper"])
            if t: counts[t] = counts.get(t, 0) + 1
    return counts

def _paper_write(slug, title, content, authors, year, topic, publisher, tags, url, file, conclusions, cites, category, created=None, kind=None, group=None, pinned=None):
    cat = _safe_cat(category or "")
    fname = _safe_name(title or _name_of(slug)) + ".md"
    rel = (cat + "/" + fname) if cat else fname
    full = PAPERS / rel
    old = PAPERS / (slug + ".md")
    _assert_mcp_writable(PAPERS, full, old)
    # Preserve user-set kind/group/pinned when the caller doesn't specify them.
    if (kind is None or group is None or pinned is None) and old.exists():
        prev, _ = _parse(old.read_text(encoding="utf-8"))
        if kind is None: kind = prev.get("kind")
        if group is None: group = prev.get("group")
        if pinned is None: pinned = prev.get("pinned")
    fm = {"title": title,
          "kind": "idea" if kind == "idea" else None,
          "group": (str(group).strip() if group and str(group).strip() != "Papers" else None),
          "pinned": True if pinned is True else None,
          "authors": authors or [], "year": _year(year), "topic": topic or "",
          "publisher": publisher or "", "tags": tags or [], "url": url or "", "file": file or "",
          "conclusions": conclusions or [], "cites": _norm_cites(cites or []), "created": created or _now()}
    write_markdown(STORE, "papers", rel, old.relative_to(PAPERS).as_posix() if old.exists() else None,
                   _serialize(fm, content or ""), _KNOWLEDGE_NODE, _KNOWLEDGE_EXTENSION)
    return rel[:-3]


# ── In-memory FTS5 index (built from files at call time) ─────────────────────
def _index(skills, notes):
    try:
        c = sqlite3.connect(":memory:")
        c.execute("CREATE VIRTUAL TABLE s USING fts5(name, content, description, tokenize='trigram')")
        c.execute("CREATE VIRTUAL TABLE n USING fts5(slug, title, content, tokenize='trigram')")
        for r in skills:
            c.execute("INSERT INTO s VALUES(?,?,?)", [r["name"], r["content"], r["description"]])
        for r in notes:
            c.execute("INSERT INTO n VALUES(?,?,?)", [r["slug"], r["title"], r["content"]])
        return c
    except sqlite3.OperationalError:
        return None


# ── Read tools ──────────────────────────────────────────────────────────────
def _skill_id(row):
  return row.get("skill_id") or ((row.get("category") or "") + "/" + row["name"]).strip("/")


def _skill_source_key(row):
  if row.get("source") == "subscription":
    subscription_id = str((row.get("provenance") or {}).get("subscription_id") or "").strip()
    return "subscriber:" + subscription_id if subscription_id else "subscriber:unknown"
  return "pkm-personal"


def _skill_source_rank(row, source_priority=None):
  priority = source_priority or _router_source_priority()
  source_key = _skill_source_key(row)
  try:
    return priority.index(source_key)
  except ValueError:
    return len(priority)


def _skill_hash(row):
  value = json.dumps({"name": row["name"], "description": row.get("description", ""),
            "category": row.get("category", ""), "tags": row.get("tags", []),
            "recipe_required": row.get("recipe_required", False),
            "recipe_hint": row.get("recipe_hint", ""), "related_skills": row.get("related_skills", []),
            "content": row.get("content", "")}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
  return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _note_hash(row):
  value = json.dumps({"title": row["title"], "type": row.get("type", "general"),
            "category": row.get("category", ""), "tags": row.get("tags", []),
            "content": row.get("content", "")}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
  return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _skill_by_id(skill_id):
  wanted = str(skill_id or "").strip("/").casefold()
  for row in _all_skills():
    if _skill_id(row).casefold() == wanted or row["name"].casefold() == wanted:
      return row
  return None


def _skill_linkage(row):
  skill_id = _skill_id(row)
  recipes = related_recipes(STORE, skill_id, "skill")
  required = bool(row.get("recipe_required"))
  hint = str(row.get("recipe_hint") or row.get("description") or row.get("name") or "").strip()
  linkage = {"recipe_required": required, "recipe_hint": hint if required else str(row.get("recipe_hint") or ""),
             "related_skills": row.get("related_skills") or [], "related_recipes": recipes}
  if required:
    linkage["next_action"] = ({"kind": "use_related_recipe", "recipe_ids": [item["recipe_id"] for item in recipes]}
      if recipes else {"kind": "search_or_create_recipe", "search_query": hint,
        "search_tool": "recipe_search", "create_tool": "recipe_create_from_skill",
        "instruction": "Search for a qualified Recipe. If none matches, proactively design and create a reusable Library Recipe from this Skill before continuing."})
  return linkage


def _retrieval_hit_linkage(hit):
  content_type = hit.get("content_type")
  identifier = str(hit.get("skill_id") or "")
  if content_type == "skill" and identifier.startswith("skill:"):
    row = _skill_by_id(identifier[6:])
    return _skill_linkage(row) if row else None
  if content_type == "note" and identifier.startswith("note:"):
    return {"related_recipes": related_recipes(STORE, identifier[5:], "note")}
  return None


_SKILL_STOP_WORDS = set("a an and are as at be by debug debugging for from how in into is it local member members name no not of on or problem substantial that the this to use using with workspace file files src code coding task issue".split())


def _skill_terms(value):
  text = re.sub(r"([a-z0-9])([A-Z])", r"\\1 \\2", str(value or ""))
  return set(term for term in re.findall(r"[\\w]{2,}", text.casefold(), re.UNICODE)
         if term not in _SKILL_STOP_WORDS and not term.isdigit())


@_feature_tool("skillRouter", read_only=True)
def skill_capabilities() -> str:
  """Discover the PKM secondary-Skill workflow for finding, using, and maintaining reusable knowledge."""
  return json.dumps({
    "ok": True,
    "capability": "pkm-skills",
    "workflow": ["skill_context", "get_skill for selected candidates", "perform task", "skill_feedback", "propose_skill_update"],
    "tools": ["skill_context", "skill_feedback", "propose_skill_update", "search_skills", "get_skill"],
    "maintenance_policy": "Use proposals for reusable changes; do not overwrite formal Skills automatically.",
  })


@_feature_tool("skillRouter", read_only=True)
def skill_context(task: str, workspace: str = "", files: Optional[List[str]] = None,
          diagnostics: str = "", limit: int = 3, detail: str = "compact") -> str:
  """Find and activate the smallest relevant PKM Skill set for a substantial task.

  Call before coding, research, debugging, or operational workflows that may
  depend on personal conventions or domain knowledge. Compact output is the
  default; call get_skill with a selected skill_id to load its full body.
  """
  started_at = time.perf_counter()
  detail = str(detail or "compact").strip().lower()
  if detail not in {"compact", "full"}:
    return json.dumps({"ok": False, "error": "detail must be compact or full"})
  if "l1_online" not in _enabled_router_solutions():
    _collect_search_invocation("pkm.skill_context", started_at, [], False, ["copilot-fallback"])
    return _disabled_router_response("pkm.skill_context")
  if not str(task or "").strip():
    _collect_search_invocation("pkm.skill_context", started_at, [], False, ["metadata-threshold"])
    return json.dumps({"ok": False, "error": "task is required"})
  task_terms = _skill_terms(task)
  context_terms = _skill_terms(" ".join([str(workspace or ""), " ".join(files or []), str(diagnostics or "")]))
  normalized_context = re.sub(r"[^\\w]+", " ", " ".join([
    str(task or ""), str(workspace or ""), " ".join(files or []), str(diagnostics or "")
  ]).casefold()).strip()
  boundary = _retrieval_request("/search", {
    "query": task,
    "limit": max(10, min(int(limit or 3) * 10, 100)),
    "content_type_filter": ["skill"],
    "request_id": str(uuid.uuid4()),
    "route": "lexical",
    "generation": {"mode": "latest-ready"},
    "scope": {"capability_id": "pkm.skill_context"},
    "deadline_at_ms": int(time.time() * 1000) + 5000,
  })
  boundary_rank = {
    str(hit.get("skill_id") or "").removeprefix("skill:"): index
    for index, hit in enumerate(boundary.get("hits") or [])
  } if boundary.get("ok") else {}
  rows = _all_skills()
  metadata_documents = []
  for candidate in rows:
    metadata_documents.append(_skill_terms(" ".join([
      candidate["name"], candidate.get("description") or "", candidate.get("category") or "",
      " ".join(candidate.get("tags") or []), candidate.get("source_project") or ""])))
  rare_limit = max(1, int(len(rows) * 0.05))
  rare_task_terms = set(term for term in task_terms
             if sum(1 for document in metadata_documents if term in document) <= rare_limit)
  source_priority = _router_source_priority()
  ranked = []
  for row in rows:
    fields = {
      "name": _skill_terms(row["name"]),
      "description": _skill_terms(row.get("description")),
      "tag": _skill_terms(" ".join(row.get("tags") or [])),
      "category": _skill_terms(row.get("category")),
      "source_project": _skill_terms(row.get("source_project")),
      "content": _skill_terms(row.get("content")),
    }
    weights = {"name": 12, "description": 8, "tag": 8, "category": 6, "source_project": 10}
    score, matched, metadata_hits = 0, [], set()
    for field, weight in weights.items():
      hits = task_terms & fields[field]
      if hits:
        score += weight * len(hits)
        metadata_hits.update(hits)
        matched.extend(field + ":" + term for term in sorted(hits))
    content_hits = task_terms & fields["content"]
    coverage = len(metadata_hits) / max(1, min(len(task_terms), 8))
    # Context may distinguish already-relevant Skills, but can never make an
    # unrelated Skill eligible on its own.
    context_metadata = set().union(*(context_terms & fields[field] for field in weights))
    # Body and execution context are tie-breakers only. They cannot increase
    # admission coverage or turn an unrelated Skill into a candidate.
    score += min(len(content_hits), 4) + min(len(context_metadata) * 2, 8)
    if _skill_id(row) in boundary_rank:
      score += max(1, 20 - boundary_rank[_skill_id(row)])
      matched.insert(0, "retrieval-boundary")
    matched.extend("content:" + term for term in sorted(content_hits)[:3])
    matched.extend("context:" + term for term in sorted(context_metadata)[:2])
    enough_metadata = len(metadata_hits) >= (1 if len(task_terms) <= 2 else 2)
    enough_coverage = coverage >= (0.5 if len(task_terms) <= 2 else 0.34)
    anchor_matched = not rare_task_terms or bool(metadata_hits & rare_task_terms)
    priority = row.get("priority") if row.get("priority") in {"high", "highest"} else "normal"
    identifiers = [row.get("name") or "", _skill_id(row)]
    exact_identifier = any(
      len(re.sub(r"[^\\w]+", " ", str(identifier).casefold()).strip()) >= 4
      and re.sub(r"[^\\w]+", " ", str(identifier).casefold()).strip() in normalized_context
      for identifier in identifiers
    )
    priority_admission = priority in {"high", "highest"} and len(metadata_hits) >= 2 and coverage >= 0.12 and anchor_matched
    if exact_identifier or (enough_metadata and enough_coverage and anchor_matched) or priority_admission:
      priority_boost = {"normal": 0, "high": 30, "highest": 60}[priority]
      score += priority_boost
      if exact_identifier:
        score += 80
        matched.insert(0, "exact-identifier")
      if priority != "normal":
        matched.insert(0, "priority:" + priority)
      source_rank = _skill_source_rank(row, source_priority)
      matched.insert(0, "source-priority:" + str(source_rank + 1))
      protected = exact_identifier or priority == "highest"
      ranked.append((0 if protected else 1, source_rank, score, coverage, len(metadata_hits), row, matched[:8]))
  frozen_serving = bool(boundary.get("skill_serving", {}).get("used"))
  ranked.sort(key=lambda item: (
    item[0], item[1],
    boundary_rank.get(_skill_id(item[5]), 1000) if frozen_serving else 0,
    -item[2], -item[3], -item[4], _skill_id(item[5]).casefold()))
  selected = ranked[:max(1, min(int(limit or 3), 5))]
  skills = []
  for index, (_, source_rank, score, coverage, metadata_count, row, reasons) in enumerate(selected):
    skills.append({"skill_id": _skill_id(row), "name": row["name"],
             "description": row.get("description", ""), "category": row.get("category", ""),
             "tags": row.get("tags", []), "source_project": row.get("source_project"),
             "source": row.get("source", "local"), "read_only": row.get("read_only", False),
             "source_key": _skill_source_key(row), "source_rank": source_rank + 1,
             "skill_priority": row.get("priority", "normal"),
             "provenance": row.get("provenance"),
             "content_hash": _skill_hash(row), "score": score, "task_coverage": round(coverage, 3),
             "priority": "required" if row.get("priority") == "highest" or (index == 0 and metadata_count >= 2 and coverage >= 0.5) else "recommended",
             "match_reason": reasons, "linkage": _skill_linkage(row)})
  no_match = not skills
  if detail == "compact":
    skills = [{
      key: value for key, value in skill.items()
      if key in {
        "skill_id", "name", "description", "source", "read_only", "source_key",
        "source_rank", "skill_priority", "provenance", "content_hash", "priority", "linkage",
        "task_coverage", "match_reason",
      } and value not in [None, [], {}]
    } for skill in skills]
  interaction_id = str(uuid.uuid4())
  candidates = []
  for index, (_, source_rank, score, coverage, metadata_count, row, reasons) in enumerate(ranked):
    candidates.append({"skill_id": _skill_id(row), "name": row["name"],
               "description": row.get("description", ""), "category": row.get("category", ""),
               "tags": row.get("tags", []), "source_project": row.get("source_project"),
               "source": row.get("source", "local"), "read_only": row.get("read_only", False),
               "source_key": _skill_source_key(row), "source_rank": source_rank + 1,
               "skill_priority": row.get("priority", "normal"),
               "provenance": row.get("provenance"),
               "content_hash": _skill_hash(row), "rank": index + 1, "score": score,
               "task_coverage": round(coverage, 3), "metadata_match_count": metadata_count,
               "match_reason": reasons, "linkage": _skill_linkage(row)})
  _collect_search_invocation("pkm.skill_context", started_at,
        [item.get("content_hash") for item in skills], True, ["metadata-threshold", "retrieval-boundary"],
        interaction_id=interaction_id)
  source_instruction = "Respect source_priority when relevant Skills overlap. Agent Native is host-managed and has no synthetic PKM candidate or score."
  if source_priority and source_priority[0] == "agent-native":
    source_instruction = "Evaluate applicable Agent Native Skills before the returned PKM candidates. Agent Native is host-managed and has no synthetic PKM candidate or score."
  response = {"ok": True, "interaction_id": interaction_id, "count": len(skills), "no_match": no_match,
             "retrieval": "summary", "retrieval_generation": boundary.get("ready_generation") if boundary.get("ok") else None,
             "skill_serving": boundary.get("skill_serving"),
             "source_priority": source_priority, "source_policy": source_instruction,
             "skills": skills,
             "instruction": source_instruction + " No relevant PKM Skill met the threshold; continue without a PKM Skill."
               if no_match else source_instruction + " Fetch only candidates you will apply, passing this interaction_id to get_skill and skill_feedback. Follow required Skills and linkage.next_action."}
  if detail == "full":
    response["task"] = task
  return json.dumps(response, ensure_ascii=False)


@_feature_tool("skillRouter")
def skill_feedback(task: str, used_skills: List[str], outcome: str,
           observations: Optional[List[str]] = None, evidence: Optional[List[str]] = None,
           interaction_id: str = "") -> str:
  """Record which PKM Skills were used, the outcome, and reusable observations without modifying formal Skills."""
  directory = STORE / "_feedback"
  directory.mkdir(parents=True, exist_ok=True)
  entry = {"id": str(uuid.uuid4()), "created": _now(),
       "task_hash": hashlib.sha256(task.encode("utf-8")).hexdigest(),
       "used_skills": used_skills or [], "outcome": outcome,
       "observations": observations or [], "evidence": evidence or []}
  with (directory / "skill-usage.jsonl").open("a", encoding="utf-8") as handle:
    handle.write(json.dumps(entry, ensure_ascii=False) + "\\n")
  outcome_label = outcome if outcome in ["success", "failure", "partial", "cancelled"] else "other"
  _collector_post("outcome", interaction_id or entry["id"], {"feedback": {
      "used_skill_count": len(used_skills or []), "outcome": outcome_label,
      "observation_count": len(observations or []),
       "evidence_count": len(evidence or [])}})
  return json.dumps({"ok": True, "feedback_id": entry["id"]})


@_feature_tool("skillRouter")
def propose_skill_update(skill_id: str, base_hash: str, reason: str,
             evidence: Optional[List[str]] = None, proposed_content: str = "",
             confidence: float = 0.0) -> str:
  """Create a reviewable PKM Skill maintenance proposal; never directly changes the formal Skill."""
  row = _skill_by_id(skill_id)
  if not row:
    return json.dumps({"ok": False, "error": "Skill not found", "skill_id": skill_id})
  if row.get("read_only"):
    return json.dumps({"ok": False, "error": "This Skill is read-only", "skill_id": skill_id})
  current_hash = _skill_hash(row)
  proposal_id = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
  directory = STORE / "_proposals" / "skills"
  directory.mkdir(parents=True, exist_ok=True)
  safe = re.sub(r"[^A-Za-z0-9._-]+", "-", _skill_id(row)).strip("-").lower() or "skill"
  target = directory / (proposal_id + "-" + safe + ".md")
  conflict = bool(base_hash and base_hash != current_hash)
  body = ["---", "proposal_id: " + proposal_id,
      "skill_id: " + json.dumps(_skill_id(row), ensure_ascii=False),
      "base_hash: " + json.dumps(base_hash or current_hash),
      "current_hash: " + json.dumps(current_hash),
      "conflict: " + ("true" if conflict else "false"),
      "confidence: " + str(max(0.0, min(float(confidence or 0), 1.0))),
      "created: " + _now(), "---", "", "# Skill Update Proposal", "",
      "## Reason", "", reason or "No reason supplied.", "", "## Evidence", ""]
  body.extend(["- " + item for item in (evidence or [])] or ["- No evidence supplied."])
  body.extend(["", "## Proposed Content", "", proposed_content or "No replacement content supplied.", ""])
  target.write_text("\\n".join(body), encoding="utf-8")
  return json.dumps({"ok": True, "proposal_id": proposal_id,
             "proposal_path": str(target), "skill_id": _skill_id(row),
             "current_hash": current_hash, "conflict": conflict})


@_feature_tool("knowledge", read_only=True)
def list_skills(category: Optional[str] = None) -> str:
    """List personal skills, optionally filtered by category (a slash-separated folder path)."""
    rows = _all_skills()
    if category:
        rows = [r for r in rows if r["category"] == category]
    rows.sort(key=lambda r: (r["category"], r["name"]))
    return json.dumps([{"skill_id": _skill_id(r), "name": r["name"], "description": r["description"],
              "category": r["category"], "tags": r["tags"],
              "priority": r.get("priority", "normal"),
              "source": r.get("source", "local"), "read_only": r.get("read_only", False),
              "provenance": r.get("provenance")} for r in rows], ensure_ascii=False)


@_feature_tool("knowledge", "skillRouter", read_only=True)
def search_skills(query: str, limit: int = 20, detail: str = "legacy", route: str = "lexical") -> str:
    """Search only Skills. Semantic/dual routes always expose model status; lexical defaults preserve arrays and offline fallback."""
    standard = _search_typed_knowledge(query, "skill", limit, detail, "pkm.search_skills", route=route)
    if standard is not None:
        return standard
    limit = max(1, min(int(limit or 20), 100))
    skills = _all_skills(); started_at = time.perf_counter()
    hits = []
    idx = _index(skills, [])
    if idx is not None:
        try:
            names = [x[0] for x in idx.execute(
                "SELECT name FROM s WHERE s MATCH ? ORDER BY rank LIMIT ?", [query, limit])]
            by = {}
            for s in skills:
                by.setdefault(s["name"], s)
            hits = [by[n] for n in names if n in by]
        except sqlite3.OperationalError:
            hits = []
    if not hits:
        q = query.lower()
        hits = [s for s in skills if q in s["name"].lower()
                or q in (s["content"] or "").lower() or q in (s["description"] or "").lower()][:limit]
    source_priority = _router_source_priority()
    hits.sort(key=lambda skill: _skill_source_rank(skill, source_priority))
    _collect_search_invocation("pkm.search_skills", started_at,
            [_skill_hash(skill) for skill in hits], True,
            ["legacy-fts5", "substring-fallback"])
    return json.dumps([{"skill_id": _skill_id(s), "name": s["name"], "description": s["description"],
              "category": s["category"], "source": s.get("source", "local"),
              "source_key": _skill_source_key(s), "source_rank": _skill_source_rank(s, source_priority) + 1,
              "priority": s.get("priority", "normal"),
              "content_hash": _skill_hash(s),
              "skill_serving": None,
              "read_only": s.get("read_only", False), "provenance": s.get("provenance"),
              "linkage": _skill_linkage(s)}
               for s in hits], ensure_ascii=False)


@_feature_tool("knowledge", "skillRouter", read_only=True)
def get_skill(id: str = "", interaction_id: str = "", name: Optional[str] = None) -> str:
  """Read a Skill by stable source_id, skill_id or exact name; the old name parameter remains accepted."""
  key, error = _knowledge_read_key(id, name)
  if error:
    return error
  if _canonical_knowledge_id(key):
    result = json.loads(get_knowledge(key, content_type_filter=["skill"]))
    if result.get("ok"):
      _collector_post("skill_load", interaction_id or str(uuid.uuid4()), {"skill": {
          "content_hash": result.get("content_hash"), "source": (result.get("provenance") or {}).get("provider"),
          "read_only": bool(result.get("read_only"))}})
    if result.get("ok") or not key.startswith("pkm://subscriptions/") or result.get("code") not in {None, "index-not-ready"}:
      return json.dumps(result, ensure_ascii=False)
  r = _skill_by_id(key)
  if not r:
    return f"Skill '{key}' not found. Use list_skills or search_skills to find it."
  result = {"skill_id": _skill_id(r), "content_hash": _skill_hash(r),
             "name": r["name"], "content": r["content"], "description": r["description"],
             "category": r["category"], "tags": r["tags"], "updated_at": r["updated_at"],
             "priority": r.get("priority", "normal"),
             "source": r.get("source", "local"), "read_only": r.get("read_only", False),
             "provenance": r.get("provenance"), "linkage": _skill_linkage(r)}
  _collector_post("skill_load", interaction_id or str(uuid.uuid4()), {"skill": {
       "content_hash": result["content_hash"], "source": result["source"],
       "read_only": result["read_only"]}})
  return json.dumps(result)


@_feature_tool("knowledge")
def list_notes(type: Optional[str] = None) -> str:
    """List notes. type can be: general, todo, done, observation, data-path."""
    rows = _all_notes()
    if type and type != "all":
        rows = [r for r in rows if r["type"] == type]
    rows.sort(key=lambda r: r["updated_at"], reverse=True)
    return json.dumps([{"slug": r["slug"], "title": r["title"], "type": r["type"],
                        "category": r["category"], "updated_at": r["updated_at"]} for r in rows[:50]])


@_feature_tool("knowledge", read_only=True)
def search_notes(query: str, limit: int = 20, detail: str = "legacy", route: str = "lexical") -> str:
    """Search Notes with lexical/semantic/dual routes. Standard returns status even for zero hits.

    The default legacy lexical shape preserves arrays and offline fallback; detail=standard
    returns the shared envelope. Semantic/dual always return the envelope.
    """
    standard = _search_typed_knowledge(query, "note", limit, detail, "pkm.search_notes", route=route)
    if standard is not None:
        return standard
    limit = max(1, min(int(limit or 20), 100))
    notes = _all_notes(); started_at = time.perf_counter()
    hits = []
    idx = _index([], notes)
    if idx is not None:
        try:
            slugs = [x[0] for x in idx.execute(
                "SELECT slug FROM n WHERE n MATCH ? ORDER BY rank LIMIT ?", [query, limit])]
            by = {r["slug"]: r for r in notes}
            hits = [by[s] for s in slugs if s in by]
        except sqlite3.OperationalError:
            hits = []
    if not hits:
        q = query.lower()
        hits = [r for r in notes if q in r["title"].lower() or q in (r["content"] or "").lower()][:limit]
    _collect_search_invocation("pkm.search_notes", started_at,
            [hashlib.sha256(r["slug"].encode("utf-8")).hexdigest() for r in hits],
            True, ["legacy-fts5", "substring-fallback"])
    return json.dumps([{"slug": r["slug"], "title": r["title"], "type": r["type"]} for r in hits])


@_feature_tool("knowledge", read_only=True)
def get_note(id: str = "", slug: Optional[str] = None) -> str:
  """Read a Note by stable source_id or relative slug; the old slug parameter remains accepted."""
  key, error = _knowledge_read_key(id, slug)
  if error:
    return error
  if _canonical_knowledge_id(key):
    return get_knowledge(key, content_type_filter=["note"])
  r = _note_get(key)
  if not r:
    return f"Note '{key}' not found. Use list_notes or search_notes to find it."
  return json.dumps({"slug": r["slug"], "content_hash": _note_hash(r), "title": r["title"], "content": r["content"],
                     "type": r["type"], "tags": r["tags"], "category": r["category"],
                     "read_only": r.get("read_only", False), "updated_at": r["updated_at"],
                     "linkage": {"related_recipes": related_recipes(STORE, r["slug"], "note")}})


# ── Write tools ─────────────────────────────────────────────────────────────
@_feature_tool("knowledge")
def add_note(title: str, content: str, type: str = "general", tags: Optional[List[str]] = None,
             category: Optional[str] = None, slug: Optional[str] = None) -> str:
    """Create a new note. 'category' is a slash-separated path (e.g. Project/AutoLabeling/C2 Guideline)
    used to organize the note in the sidebar tree. 'type' is one of general/todo/done/observation/data-path.
    The note's identity ('slug') is its relative path without .md and is returned on success."""
    cat = _safe_cat(category or "")
    key = (cat + "/" + title) if cat else title
    if _note_get(key):
        return json.dumps({"error": f"Note '{key}' already exists. Use update_note instead."})
    new_slug = _note_write(key, title or key, content, type, tags or [], cat)
    return json.dumps({"ok": True, "slug": new_slug})


@_feature_tool("knowledge")
def update_note(slug: str, title: Optional[str] = None, content: Optional[str] = None,
                type: Optional[str] = None, category: Optional[str] = None, tags: Optional[List[str]] = None) -> str:
    """Update fields of an existing note by slug. Only provided fields are changed.
    Changing title/category moves the underlying file; the new slug is returned."""
    row = _note_get(slug)
    if not row:
        return json.dumps({"error": f"Note '{slug}' not found."})
    new_slug = _note_write(
        slug,
        title if title is not None else row["title"],
        content if content is not None else row["content"],
        type if type is not None else row["type"],
        tags if tags is not None else row["tags"],
        category if category is not None else row["category"],
    )
    return json.dumps({"ok": True, "slug": new_slug})


@_feature_tool("knowledge")
def delete_note(slug: str) -> str:
    """Move a note to PKM Trash and record durable deletion intent; never permanently unlink it."""
    p = NOTES / (slug + ".md")
    _assert_mcp_writable(NOTES, p)
    return json.dumps(trash_file(STORE, "notes", p.relative_to(NOTES).as_posix(), _KNOWLEDGE_NODE, _KNOWLEDGE_EXTENSION))


@_feature_tool("knowledge")
def add_skill(name: str, content: str, description: str = "", category: str = "",
              tags: Optional[List[str]] = None, source_project: str = "", recipe_required: bool = False,
              recipe_hint: str = "", related_skills: Optional[List[str]] = None,
              priority: str = "normal") -> str:
    """Create or overwrite a skill. 'category' is a slash-separated folder path
    (e.g. General/DLIS/docker); 'name' is the skill's unique identifier."""
    created = None
    existing = _skill_get(name)
    _skill_write(name, content, description, category, tags or [], source_project or None, created,
           recipe_required, recipe_hint, related_skills or [], priority)
    return json.dumps({"ok": True, "name": name})


@_feature_tool("knowledge")
def update_skill(name: str, content: Optional[str] = None, description: Optional[str] = None,
                 category: Optional[str] = None, tags: Optional[List[str]] = None,
                 recipe_required: Optional[bool] = None, recipe_hint: Optional[str] = None,
                 related_skills: Optional[List[str]] = None, priority: Optional[str] = None) -> str:
    """Update fields of an existing skill by name. Only provided fields are changed."""
    row = _skill_get(name)
    if not row:
        return json.dumps({"error": f"Skill '{name}' not found. Use add_skill to create it."})
    _skill_write(
        name,
        content if content is not None else row["content"],
        description if description is not None else row["description"],
        category if category is not None else row["category"],
        tags if tags is not None else row["tags"],
        row["source_project"],
        recipe_required=row["recipe_required"] if recipe_required is None else recipe_required,
        recipe_hint=row["recipe_hint"] if recipe_hint is None else recipe_hint,
        related_skills=row["related_skills"] if related_skills is None else related_skills,
        priority=row["priority"] if priority is None else priority,
    )
    return json.dumps({"ok": True, "name": name})


@_feature_tool("knowledge")
def delete_skill(name: str) -> str:
    """Move a Skill to PKM Trash and record durable deletion intent; never permanently unlink it."""
    p, _ = _find_skill(name)
    if p is not None:
        _assert_mcp_writable(SKILLS, p)
        return json.dumps(trash_file(STORE, "skills", p.relative_to(SKILLS).as_posix(), _KNOWLEDGE_NODE, _KNOWLEDGE_EXTENSION))
    return json.dumps({"ok": True, "name": name, "absent": True})


# ── Paper tools ──────────────────────────────────────────────────────────────
@_feature_tool("knowledge")
def list_papers(topic: Optional[str] = None) -> str:
    """List papers (optionally filtered by topic), sorted by citation count (popularity)."""
    all_p = _all_papers(); counts = _citation_counts(all_p)
    rows = [p for p in all_p if (not topic or p["topic"] == topic)]
    rows.sort(key=lambda p: (-(counts.get(p["slug"], 0)), -(p["year"] or 0), p["title"]))
    return json.dumps([{"slug": p["slug"], "title": p["title"], "year": p["year"],
                        "authors": p["authors"], "topic": p["topic"], "publisher": p["publisher"],
                        "tags": p["tags"], "citation_count": counts.get(p["slug"], 0)} for p in rows])


@_feature_tool("knowledge", read_only=True)
def search_research(query: str, limit: int = 20, detail: str = "legacy", route: str = "lexical") -> str:
  """Search only Research. Semantic/dual routes always expose model status; lexical defaults preserve arrays and offline fallback."""
  standard = _search_typed_knowledge(query, "research", limit, detail, "pkm.search_research", route=route)
  if standard is not None:
    return standard
  return _search_papers_legacy(query, limit)


@_feature_tool("knowledge", read_only=True)
def search_papers(query: str, limit: int = 50, detail: str = "legacy", route: str = "lexical") -> str:
  """Compatibility alias for search_research; preserves the historical default limit of 50."""
  started_at = time.perf_counter()
  result = search_research(query, limit=limit, detail=detail, route=route)
  observed = json.loads(result)
  _collect_search_invocation("pkm.search_papers", started_at, [], not isinstance(observed, dict) or observed.get("ok") is True,
                            ["research-compatibility-alias"])
  return result


def _search_papers_legacy(query, limit):
    limit = max(1, min(int(limit or 20), 100))
    q = query.lower(); started_at = time.perf_counter(); all_p = _all_papers(); counts = _citation_counts(all_p)
    hits = [p for p in all_p if q in p["title"].lower() or q in p["topic"].lower()
            or q in p["publisher"].lower() or q in " ".join(p["authors"]).lower()
            or q in " ".join(p["tags"]).lower() or q in str(p["year"] or "")]
    limited = hits[:limit]
    _collect_search_invocation("pkm.search_papers", started_at,
            [hashlib.sha256(p["slug"].encode("utf-8")).hexdigest() for p in limited],
            True, ["legacy-metadata-substring"])
    return json.dumps([{"slug": p["slug"], "title": p["title"], "year": p["year"],
                        "topic": p["topic"], "citation_count": counts.get(p["slug"], 0)} for p in limited])


@_feature_tool("knowledge", read_only=True)
def get_research(id: str = "", slug: Optional[str] = None) -> str:
  """Read Research by stable source_id or relative slug; slug compatibility preserves the full paper record."""
  key, error = _knowledge_read_key(id, slug)
  if error:
    return error
  if _canonical_knowledge_id(key):
    return get_knowledge(key, content_type_filter=["research"])
  paper = _paper_get(key)
  if not paper:
    return f"Paper '{key}' not found. Use list_research or search_research to find it."
  paper["citation_count"] = _citation_counts(_all_papers()).get(key, 0)
  return json.dumps(paper)


@_feature_tool("knowledge", read_only=True)
def get_paper(slug: str = "", id: str = "") -> str:
  """Compatibility alias for get_research accepting both the historical slug and stable id."""
  return get_research(id=id, slug=slug or None)


@_feature_tool("knowledge", read_only=True)
def list_research(topic: Optional[str] = None) -> str:
  """Canonical Research listing; preserves the existing Paper listing metadata and order."""
  return list_papers(topic=topic)


@_feature_tool("knowledge")
def add_paper(title: str, authors: Optional[List[str]] = None, year: Optional[int] = None,
              topic: str = "", publisher: str = "", tags: Optional[List[str]] = None,
              url: str = "", conclusions: Optional[List[str]] = None,
              cites: Optional[List[dict]] = None, category: str = "", content: str = "") -> str:
    """Create a paper. 'cites' is a list of {paper, note}: paper is a cited paper's title or slug,
    note explains how this paper uses it ('A cites B' means A is a child of B). 'category' is a
    slash-separated folder path; 'conclusions' is a list shown in the citation graph."""
    cat = _safe_cat(category or "")
    key = (cat + "/" + title) if cat else title
    if _paper_get(key):
        return json.dumps({"error": f"Paper '{key}' already exists. Use update_paper instead."})
    new = _paper_write(key, title, content, authors or [], year, topic, publisher, tags or [],
                       url, "", conclusions or [], cites or [], cat)
    return json.dumps({"ok": True, "slug": new})


@_feature_tool("knowledge")
def update_paper(slug: str, title: Optional[str] = None, authors: Optional[List[str]] = None,
                 year: Optional[int] = None, topic: Optional[str] = None, publisher: Optional[str] = None,
                 tags: Optional[List[str]] = None, url: Optional[str] = None,
                 conclusions: Optional[List[str]] = None, cites: Optional[List[dict]] = None,
                 category: Optional[str] = None, content: Optional[str] = None) -> str:
    """Update fields of an existing paper by slug. Only provided fields are changed."""
    p = _paper_get(slug)
    if not p:
        return json.dumps({"error": f"Paper '{slug}' not found."})
    new = _paper_write(slug,
        title if title is not None else p["title"],
        content if content is not None else p["content"],
        authors if authors is not None else p["authors"],
        year if year is not None else p["year"],
        topic if topic is not None else p["topic"],
        publisher if publisher is not None else p["publisher"],
        tags if tags is not None else p["tags"],
        url if url is not None else p["url"],
        p["file"],
        conclusions if conclusions is not None else p["conclusions"],
        cites if cites is not None else p["cites"],
        category if category is not None else p["category"])
    return json.dumps({"ok": True, "slug": new})


@_feature_tool("knowledge")
def delete_paper(slug: str) -> str:
    """Move a Research paper to PKM Trash and record durable deletion intent."""
    _assert_mcp_writable(PAPERS, PAPERS / (slug + ".md"))
    return json.dumps(trash_file(STORE, "papers", slug + ".md", _KNOWLEDGE_NODE, _KNOWLEDGE_EXTENSION))


@_feature_tool("knowledge")
def paper_graph(topic: Optional[str] = None, limit: int = 10, neighbors: bool = False) -> str:
    """Citation graph of the top papers. Returns {nodes, edges}: each edge is
    {from: cited_parent, to: citing_child, note}. 'limit' keeps the top-N by citations
    (optionally within 'topic'); set neighbors=true to also include directly-connected papers."""
    all_p = _all_papers(); resolve = _paper_resolver(all_p); counts = _citation_counts(all_p)
    by = {p["slug"]: p for p in all_p}
    filtered = [p for p in all_p if (not topic or p["topic"] == topic)]
    filtered.sort(key=lambda p: (-(counts.get(p["slug"], 0)), -(p["year"] or 0)))
    node_set = set(p["slug"] for p in filtered[:max(1, limit)])
    if neighbors:
        for s in list(node_set):
            p = by.get(s)
            if not p: continue
            for c in p["cites"]:
                t = resolve(c["paper"])
                if t: node_set.add(t)
            for q in all_p:
                for c in q["cites"]:
                    if resolve(c["paper"]) == s: node_set.add(q["slug"])
    nodes = [{"key": by[s]["slug"], "title": by[s]["title"], "year": by[s]["year"],
              "topic": by[s]["topic"], "citation_count": counts.get(s, 0),
              "conclusions": by[s]["conclusions"]} for s in node_set if s in by]
    edges = []
    for p in all_p:
        if p["slug"] not in node_set: continue
        for c in p["cites"]:
            t = resolve(c["paper"])
            if t and t in node_set:
                edges.append({"from": t, "to": p["slug"], "note": c["note"]})
    return json.dumps({"nodes": nodes, "edges": edges, "total": len(filtered), "shown": len(nodes)})


def _subscription_records():
    rows = []
    if not SUBSCRIPTIONS.exists():
      return rows
    for metadata_path in SUBSCRIPTIONS.glob("*/*/_subscription.json"):
      try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata["priority"] = _skill_priority(metadata.get("priority"))
        metadata["cache_root"] = str(metadata_path.parent)
        rows.append(metadata)
      except Exception:
        continue
    return rows


@_feature_tool("knowledge")
def list_subscriptions() -> str:
    """List physically isolated, machine-local PKM subscriptions and their provenance.
    This does not search or modify the user's local Knowledge Root."""
    rows = []
    for record in _subscription_records():
      rows.append({k: record.get(k) for k in ["subscriptionId", "alias", "priority", "publisher", "nodeId", "shareId", "revision", "collectionHash", "syncedAt"]})
    return json.dumps(rows, ensure_ascii=False)


@_feature_tool("knowledge")
def search_subscribed_content(query: str, content_type: Optional[str] = None,
                  alias: Optional[str] = None, limit: int = 20) -> str:
    """Explicitly search downloaded subscription caches. Results remain read-only and
    separate from local Skills/Notes/Papers/Prompts/Scripts/Packages/Servers."""
    started_at = time.perf_counter()
    needle = (query or "").casefold()
    wanted_type = (content_type or "").strip().lower()
    wanted_alias = (alias or "").casefold()
    results = []
    candidate_limit = min(500, max(100, max(1, min(limit, 100)) * 5))
    for record in _subscription_records():
      if len(results) >= candidate_limit:
        break
      if wanted_alias and wanted_alias not in str(record.get("alias") or record.get("publisher") or "").casefold():
        continue
      root = Path(record["cache_root"]) / "content"
      if not root.exists():
        continue
      for file_path in root.rglob("*"):
        if len(results) >= candidate_limit:
          break
        if not file_path.is_file() or file_path.name.endswith(".pkm-source.json"):
          continue
        relative = file_path.relative_to(root)
        item_type = relative.parts[0] if relative.parts else ""
        if wanted_type and item_type != wanted_type:
          continue
        try:
          text = file_path.read_text(encoding="utf-8")
        except Exception:
          continue
        if needle and needle not in str(relative).casefold() and needle not in text.casefold():
          continue
        index = text.casefold().find(needle) if needle else 0
        snippet = text[max(0, index - 100):index + max(160, len(needle) + 100)].replace("\\n", " ")
        results.append({
          "node_id": record.get("nodeId"), "share_id": record.get("shareId"),
          "alias": record.get("alias") or record.get("publisher"), "content_type": item_type,
          "path": "/".join(relative.parts[1:]), "snippet": snippet,
          "source_priority": record.get("priority"),
          "revision": record.get("revision"), "synced_at": record.get("syncedAt"),
          "_path_match": bool(needle and needle in str(relative).casefold()),
        })
    results.sort(key=lambda item: (
      -((4 if item.pop("_path_match", False) else 0)
        + {"normal": 0, "high": 1, "highest": 2}[_skill_priority(item.get("source_priority"))]),
      str(item.get("alias") or "").casefold(), str(item.get("path") or "").casefold(),
    ))
    results = results[:max(1, min(limit, 100))]
    _collect_search_invocation("pkm.search_subscribed_content", started_at,
                  ["{}:{}:{}:{}".format(item.get("node_id"), item.get("share_id"), item.get("content_type"), item.get("path")) for item in results],
                  True, ["subscription-substring"])
    return json.dumps(results, ensure_ascii=False)


@_feature_tool("knowledge")
def get_subscribed_content(node_id: str, share_id: str, content_type: str, path: str) -> str:
    """Read one explicit subscribed cache item returned by search_subscribed_content.
    Returns content plus its publisher/subscriber provenance; never writes local content."""
    base = (SUBSCRIPTIONS / node_id / share_id / "content" / content_type).resolve()
    target = (base / path).resolve()
    if base not in target.parents or not target.is_file() or target.name.endswith(".pkm-source.json"):
      return json.dumps({"error": "Subscribed item not found."})
    try:
      content = target.read_text(encoding="utf-8")
      provenance_path = Path(str(target) + ".pkm-source.json")
      provenance = json.loads(provenance_path.read_text(encoding="utf-8")) if provenance_path.exists() else {}
      metadata_path = SUBSCRIPTIONS / node_id / share_id / "_subscription.json"
      metadata = json.loads(metadata_path.read_text(encoding="utf-8")) if metadata_path.exists() else {}
      provenance["sourcePriority"] = _skill_priority(metadata.get("priority"))
      return json.dumps({"content": content, "provenance": provenance}, ensure_ascii=False)
    except Exception as error:
      return json.dumps({"error": str(error)})


@_feature_tool("knowledge")
def get_subscribed_content_by_path(pkm_path: str) -> str:
    """Read a subscribed item directly from its canonical Copy Path URI."""
    try:
      parsed = urllib.parse.urlparse(str(pkm_path or ""))
      parts = [urllib.parse.unquote(part) for part in parsed.path.split("/") if part]
      if parsed.scheme != "pkm" or parsed.netloc != "subscriptions" or len(parts) < 4:
        raise ValueError("Invalid subscribed content path.")
      node_id, share_id, content_type = parts[:3]
      if content_type not in {"skills", "notes", "papers", "prompts", "scripts", "packages", "servers"}:
        raise ValueError("Invalid subscribed content type.")
      return get_subscribed_content(node_id, share_id, content_type, "/".join(parts[3:]))
    except Exception as error:
      return json.dumps({"error": str(error)})


if "automation" in _FEATURE_DOMAINS:
  from chat_server import mcp as chat_mcp
  mcp.mount(chat_mcp)

if __name__ == "__main__":
    import asyncio
    asyncio.run(run_managed_stdio(mcp, _MCP_LIFECYCLE))
`);

  fs.writeFileSync(reqTxt, "fastmcp>=2.0.0,<4.0.0\nuone-prompt-manager==0.1.0\nwebsockets>=12.0\nPyYAML>=6\ncryptography>=42.0.0\n");
  fs.rmSync(path.join(mcpDir, "chat_requirements.txt"), { force: true });

  const requiredSkillTools = ["skill_capabilities", "skill_context", "skill_feedback", "propose_skill_update"];
  const generatedServer = fs.readFileSync(serverPy, "utf8");
  const missingSkillTools = requiredSkillTools.filter(tool => !generatedServer.includes(`def ${tool}(`));
  if (missingSkillTools.length) throw new Error(`Unified MCP server is missing required Skill tools: ${missingSkillTools.join(", ")}`);

  const launch = mcpStdioCommand(resolveMcpPython(), [serverPy]);
  const configSnippet = JSON.stringify({
    servers: {
      "pkm": {
        type: "stdio",
        command: launch.command,
        args: launch.args,
        ...(launch.env ? { env: launch.env } : {}),
      }
    }
  }, null, 2);

  return { serverPath: serverPy, configSnippet };
}

// ── Agent-Room MCP server (Phase C) ─────────────────────────────────────────
// A standalone MCP server that lets an AI agent join a chatroom over WebSocket.
// The server config is room-agnostic; each invitation supplies a one-paste Magic
// Link plus the alias the agent should use for that meeting.
export function chatMcpStatus(): McpServerStatus {
  const directory = managedMcpServerDirectory();
  const manifest = readManagedMcpManifest(directory);
  const serverPath = manifest
    ? path.join(directory, "generations", manifest.generation, "chat_server.py")
    : path.join(directory, "chat_server.py");
  const installedVersion = readMcpVersion(serverPath);
  return {
    installed: !!installedVersion, serverPath,
    expectedVersion: CHAT_MCP_VERSION, installedVersion,
    current: installedVersion === CHAT_MCP_VERSION,
    knowledgeVersion: KNOWLEDGE_MCP_VERSION,
    chatVersion: CHAT_MCP_VERSION,
    recipeVersion: RECIPE_MCP_VERSION,
    agentSessionVersion: AGENT_SESSION_MCP_VERSION,
    installedKnowledgeVersion: readMcpComponentVersion(serverPath, "KNOWLEDGE_SCHEMA_VERSION"),
    installedChatVersion: readMcpComponentVersion(serverPath, "CHAT_SCHEMA_VERSION"),
    installedRecipeVersion: readMcpComponentVersion(serverPath, "RECIPE_SCHEMA_VERSION"),
    installedAgentSessionVersion: readMcpComponentVersion(serverPath, "AGENT_SESSION_SCHEMA_VERSION"),
    newerThanExpected: (compareVersionOrder(installedVersion, CHAT_MCP_VERSION) || 0) > 0,
  };
}

export function generateChatMcpServer(context: vscode.ExtensionContext, outputDirectory?: string): { serverPath: string; configSnippet: string } {
  const storePath = getStorePath();
  const mcpDir    = outputDirectory || managedMcpServerDirectory();
  const serverPy  = path.join(mcpDir, "chat_server.py");
  const extensionRoot = context?.extensionPath || path.join(require("path").resolve(__dirname, ".."), "..");
  fs.mkdirSync(mcpDir, { recursive: true });
  fs.copyFileSync(path.join(extensionRoot, "resources", "mcp_call_guard.py"), path.join(mcpDir, "mcp_call_guard.py"));

  fs.writeFileSync(serverPy, `#!/usr/bin/env python3
"""
pkm-chat MCP Server — lets an AI agent join a Personal Knowledge Manager chatroom.

Connects to a self-hosted chat hub over WebSocket and exposes tools so an agent
can join a room, read directed messages, post replies, and leave — collaborating
with humans and other agents in real time.

The host shares one Magic Link containing the room URL and key, then separately
assigns the agent an alias. Call chat_join(magic_link=..., name=...).

Install:  pip install fastmcp websockets
Run:      python chat_server.py
"""
import os, json, asyncio, re, base64, hashlib
import secrets as _secrets
from typing import Optional

try:
    from fastmcp import FastMCP
except ImportError:
    raise SystemExit("fastmcp not found. Run: pip install fastmcp websockets")
try:
    import websockets
except ImportError:
    raise SystemExit("websockets not found. Run: pip install fastmcp websockets")

mcp = FastMCP("pkm-chat")
SERVER_VERSION = "${CHAT_MCP_VERSION}"

@mcp.tool()
def check_chat_version() -> dict:
  """Return the internal chat module's schema version."""
  return {"name": "pkm-chat", "version": SERVER_VERSION}

def _load_cid():
    # Stable identity across restarts so teammates recognize this agent. Stored
    # next to this file; falls back to an ephemeral id if the file isn't writable.
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".chat_cid")
    try:
        if os.path.exists(p):
            v = open(p).read().strip()
            if v:
                return v
        v = _secrets.token_hex(4)
        with open(p, "w") as f:
            f.write(v)
        return v
    except Exception:
        return _secrets.token_hex(4)

_CID = _load_cid()
_state = {
    "ws": None, "task": None,
    "url": "", "room": "", "name": "",
  "token": "", "closing": False, "runtime_state": "idle",
    "status": "disconnected", "detail": "",
    "members": [], "messages": [], "cursor": 0,
    "standby_cursor": 0,
}
_message_event = asyncio.Event()
_seen_ids = set()   # message ids already recorded — dedup history backfill on reconnect


def _parse_magic_link(value):
  raw = str(value or "").strip()
  if not raw.startswith("pkchat:v1:"):
    raise ValueError("Chat Magic Link must start with pkchat:v1:")
  try:
    payload, checksum = raw[len("pkchat:v1:"):].split(".", 1)
  except ValueError:
    raise ValueError("Chat Magic Link format is invalid or incomplete.")
  expected = base64.urlsafe_b64encode(hashlib.sha256(payload.encode()).digest()).decode().rstrip("=")[:16]
  if checksum != expected:
    raise ValueError("Chat Magic Link checksum failed. It may have been copied incorrectly.")
  try:
    decoded = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)).decode())
  except Exception:
    raise ValueError("Chat Magic Link payload is invalid.")
  url, secret = str(decoded.get("u") or "").strip(), str(decoded.get("s") or "").strip()
  from urllib.parse import urlparse
  parsed = urlparse(url)
  if decoded.get("v") != 1 or parsed.scheme not in ("ws", "wss") or not parsed.netloc or not parsed.path.strip("/") or not secret:
    raise ValueError("Chat Magic Link is missing valid room credentials.")
  return url, secret


def _norm(m):
    return {"id": m.get("id", ""), "from": m.get("from", ""), "text": m.get("text", ""),
            "ts": m.get("ts", 0), "kind": m.get("kind", "human"),
            "system": bool(m.get("system"))}


def _record(nm):
    # Append a normalized message unless we've already seen it (by id).
    mid = nm.get("id")
    if mid:
        if mid in _seen_ids:
            return
        _seen_ids.add(mid)
    _state["messages"].append(nm)
    _message_event.set()


def _mentions(text, name):
  value = str(text or "")
  target = str(name or "")
  return (bool(re.search(r"@(all|everyone)\\b", value, re.I)) or
      bool(target and re.search(r'@(?:"' + re.escape(target) + r'"|' + re.escape(target) + r')(?=\\s|$|[,.!?;:])', value, re.I)))


async def _reader(ws):
    try:
        async for raw in ws:
            try:
                f = json.loads(raw)
            except Exception:
                continue
            t = f.get("t")
            if t == "presence":
                _state["members"] = f.get("members", [])
            elif t == "history":
                for m in f.get("messages", []):
                    _record(_norm(m))
            elif t == "msg":
                receipt = f.get("receipt") or {}
                if receipt.get("ack") and f.get("id"):
                    try:
                        await ws.send(json.dumps({"t": "msg.read", "room": _state["room"], "messageId": f["id"]}))
                    except Exception:
                        pass
                _record(_norm(f))
            elif t == "system":
                _state["messages"].append({"from": "", "text": f.get("text", ""),
                                            "ts": f.get("ts", 0), "kind": "system", "system": True})
            elif t == "file.offer":
                fm = f.get("file", {})
                _state["messages"].append({"from": f.get("from", ""),
                                            "text": "[shared a file: " + fm.get("name", "") + "]",
                                            "ts": f.get("ts", 0), "kind": f.get("kind", "human")})
            elif t == "closed":
                _state["messages"].append({"from": "", "text": "Room closed (" + f.get("reason", "") + ").",
                                            "ts": 0, "kind": "system", "system": True})
                _state["status"] = "disconnected"; _state["detail"] = "room closed"
                _state["closing"] = True
            elif t == "kicked":
                _state["messages"].append({"from": "", "text": f.get("reason", "Removed by the host."),
                                            "ts": 0, "kind": "system", "system": True})
                _state["status"] = "disconnected"; _state["detail"] = "removed by host"
                _state["closing"] = True
            elif t == "renamed":
                _state["name"] = f.get("name", _state["name"])
                _state["messages"].append({"from": "", "text": 'The host renamed you to "' + f.get("name", "") + '".',
                                            "ts": 0, "kind": "system", "system": True})
            elif t == "error":
                # Mute/moderation notices are informational — keep the connection.
                if f.get("code") in ("muted", "moderation"):
                    _state["messages"].append({"from": "", "text": f.get("msg", ""),
                                                "ts": 0, "kind": "system", "system": True})
                else:
                    _state["status"] = "error"; _state["detail"] = f.get("msg", "")
                    if f.get("code") in ("auth", "name-taken", "no-room"):
                        _state["closing"] = True
    except Exception as e:
        _state["detail"] = str(e)
    finally:
        if _state.get("ws") is ws:
            _state["status"] = "disconnected"
            _state["ws"] = None


async def _send_state(state):
    _state["runtime_state"] = state
    ws = _state.get("ws")
    if ws is not None and _state["status"] == "connected":
        try:
            await ws.send(json.dumps({"t": "agent.state", "room": _state["room"], "state": state}))
        except Exception:
            pass


async def _connection_loop():
    backoff = 1
    while not _state["closing"]:
        try:
            ws = await websockets.connect(_state["url"], open_timeout=8, max_size=8 * 1024 * 1024)
            _state.update(ws=ws, status="connected", detail="")
            await ws.send(json.dumps({"t": "join", "room": _state["room"], "user": _state["name"],
                                      "token": _state["token"], "kind": "agent", "cid": _CID}))
            await _send_state(_state["runtime_state"])
            backoff = 1
            await _reader(ws)
        except asyncio.CancelledError:
            return
        except Exception as error:
            _state["detail"] = str(error)
        if _state["closing"]:
            return
        _state["status"] = "reconnecting"
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 30)


async def _do_leave():
    _state["closing"] = True
    ws = _state.get("ws")
    if ws is not None:
        try:
            await ws.send(json.dumps({"t": "leave", "room": _state.get("room", "")}))
        except Exception:
            pass
        try:
            await ws.close()
        except Exception:
            pass
    task = _state.get("task")
    if task is not None:
        task.cancel()
    _state.update(ws=None, task=None, status="disconnected", members=[])


async def _do_join(url, room, name, token):
    await _do_leave()
    _state.update(ws=None, url=url, room=room, name=name, token=token, closing=False,
                  status="connecting", detail="", members=[], messages=[], cursor=0,
                  standby_cursor=0, runtime_state="standby")
    _state["task"] = asyncio.create_task(_connection_loop())
    await asyncio.sleep(0.4)   # collect initial presence/history or an auth error
    _state["cursor"] = len(_state["messages"])
    _state["standby_cursor"] = len(_state["messages"])
    if _state["status"] == "error":
        raise RuntimeError(_state["detail"] or "join rejected")
    return True


@mcp.tool()
async def chat_join(magic_link: str, name: str) -> str:
  """Join using the host's Magic Link and assigned alias.

  Preferred call: chat_join(magic_link="pkchat:v1:...", name="assigned alias").
  The Magic Link contains the room URL and key. The alias must be unique in the
  room.
  Ask the user for this agent's alias before joining; never invent a name.
  core.chatroom-alias is the preinstalled durable input Action. In PKM Chat the
  transport collects its inline form automatically before dispatching this tool.
  """
  try:
    url, token = _parse_magic_link(magic_link)
  except ValueError as error:
    return json.dumps({"ok": False, "error": str(error)})
  room = ""
  name = str(name or "").strip()
  if not name:
    return json.dumps({"ok": False, "error": "The host must assign this agent an alias."})
  from urllib.parse import urlparse, unquote
  parsed = urlparse(url)
  room = unquote((parsed.path or "").strip("/").split("/")[-1])
  hub_url = parsed.scheme + "://" + parsed.netloc
  try:
    await _do_join(hub_url, room, name, token)
  except Exception as e:
    return json.dumps({"ok": False, "error": str(e)})
  return json.dumps({"ok": True, "room": room, "name": name, "members": _state["members"]})


@mcp.tool()
async def chat_post(text: str) -> str:
    """Post a message to the joined chatroom (visible to all humans and agents)."""
    ws = _state.get("ws")
    if ws is None or _state["status"] != "connected":
        return json.dumps({"ok": False, "error": "Not connected. Call chat_join first."})
    try:
        await _send_state("sending")
        await ws.send(json.dumps({"t": "msg", "room": _state["room"],
                                  "from": _state["name"], "text": text, "kind": "agent"}))
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})
    finally:
        await _send_state("standby")
    return json.dumps({"ok": True})


@mcp.tool()
async def chat_read(limit: int = 50, only_new: bool = True) -> str:
    """Read messages from the joined room. By default returns only messages that
    arrived since your last chat_read; set only_new=false for the latest 'limit'
    messages. Each message has from, text, ts, and kind (human/agent/system)."""
    msgs = _state["messages"]
    start = _state["cursor"] if only_new else max(0, len(msgs) - max(1, limit))
    items = msgs[start:]
    if len(items) > limit:
        items = items[-limit:]
    _state["cursor"] = len(msgs)
    return json.dumps({"ok": True, "count": len(items), "messages": items, "status": _state["status"]})


@mcp.tool()
async def chat_history(limit: int = 50) -> str:
    """Read recent room history on demand without changing the new-message cursor.

    Joining ignores old history by default. Call this only when the user asks
    you to read or summarize earlier Chatroom messages.
    """
    limit = max(1, min(int(limit or 50), 500))
    return json.dumps({"ok": True, "count": min(limit, len(_state["messages"])),
               "messages": _state["messages"][-limit:]})


@mcp.tool()
async def chat_standby(timeout: int = 300) -> str:
  """Block until a directed @message or timeout; call again after each result."""
    timeout = max(1, min(int(timeout or 300), 1800))
    await _send_state("standby")
    while True:
      _message_event.clear()
      pending = _state["messages"][_state["standby_cursor"]:]
      for message in pending:
        text = str(message.get("text") or "").strip()
        low = text.lower()
        _state["standby_cursor"] += 1
        if message.get("from") == _state["name"]:
          continue
        directed = _mentions(text, _state["name"])
        direct_message = message.get("from") != "roombot" and directed
        if direct_message:
          await _send_state("thinking")
          return json.dumps({"ok": True, "event": "message", "messages": pending,
                     "instruction": "Respond with chat_post, then immediately call chat_standby again."})
      try:
        await asyncio.wait_for(_message_event.wait(), timeout=timeout)
      except asyncio.TimeoutError:
        return json.dumps({"ok": True, "event": "timeout", "messages": [],
                   "instruction": "Still in standby. Call chat_standby again to keep waiting."})


@mcp.tool()
async def chat_members() -> str:
    """List who is in the room. 'present' are connected now; 'left' is roster history
    (people who were here and disconnected). Each entry carries a stable 'sid'
    identity id (verified for extension/MCP, best-effort for browser)."""
    everyone = _state["members"]
    present = [m for m in everyone if m.get("present", True)]
    left = [m for m in everyone if not m.get("present", True)]
    return json.dumps({"ok": True, "present": present, "left": left,
                       "members": present, "status": _state["status"]})


@mcp.tool()
async def chat_status() -> str:
    """Report the current connection status (room, name, status, member count)."""
    present = [m for m in _state["members"] if m.get("present", True)]
    return json.dumps({"ok": True, "room": _state["room"], "name": _state["name"],
                       "status": _state["status"], "detail": _state["detail"],
                       "members": len(present)})


@mcp.tool()
async def chat_leave() -> str:
    """Leave the chatroom and close the connection."""
    await _do_leave()
    return json.dumps({"ok": True})


if __name__ == "__main__":
    mcp.run()
`);

  const templatePath = path.join(extensionRoot, "resources", "chat_server.py.template");
  const template = fs.readFileSync(templatePath, "utf-8")
    .replace(/%%CHAT_MCP_VERSION%%/g, CHAT_MCP_VERSION);
  const requiredChatTools = ["chat_capabilities", "chat_join", "chat_standby", "chat_post", "chat_status"];
  const missingChatTools = requiredChatTools.filter(tool => !template.includes(`def ${tool}(`));
  if (missingChatTools.length) throw new Error(`Chat MCP template is missing required tools: ${missingChatTools.join(", ")}`);
  fs.writeFileSync(serverPy, template);

  const launch = mcpStdioCommand(resolveMcpPython(), [path.join(mcpDir, "server.py")]);
  const configSnippet = JSON.stringify({
    servers: {
      "pkm": {
        type: "stdio",
        command: launch.command,
        args: launch.args,
        ...(launch.env ? { env: launch.env } : {}),
      }
    }
  }, null, 2);

  return { serverPath: serverPy, configSnippet };
}
