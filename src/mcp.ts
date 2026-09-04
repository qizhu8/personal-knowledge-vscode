import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execFile, execFileSync, execSync } from "child_process";
import { getStorePath } from "./filestore";
import { condaEnvs, pyenvAdd, pyenvCreate, pyenvDelete, pyenvList, pyenvUpdate } from "./pyenvs";
import { managedEnvironmentsRoot } from "./environment-paths";
import { isAbsoluteForPlatform, isForeignAbsolutePath } from "./store-path";

// ── MCP server scaffold ────────────────────────────────────────────────────
export const UNIFIED_MCP_VERSION = "2.6.0";
const KNOWLEDGE_MCP_VERSION = "1.0.0";
const CHAT_MCP_VERSION = "2.3.1";

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

export function managedMcpServerDirectory(): string {
  const configured = vscode.workspace.getConfiguration("personalKnowledge").get<string>("mcpServerPath", "").trim();
  return configured && isAbsoluteForPlatform(configured) && !isForeignAbsolutePath(configured)
    ? path.normalize(configured)
    : path.join(getStorePath(), "mcp-server");
}

export function managedMcpRuntimePath(): string {
  const configured = vscode.workspace.getConfiguration("personalKnowledge").get<string>("mcpRuntimePath", "").trim();
  return configured && isAbsoluteForPlatform(configured) && !isForeignAbsolutePath(configured)
    ? path.normalize(configured)
    : path.join(managedEnvironmentsRoot(), "pkm-mcp");
}

export function mcpProcessStatus(): McpProcessStatus {
  const serverPath = path.join(managedMcpServerDirectory(), "server.py");
  try {
    const output = process.platform === "win32"
      ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"], { encoding: "utf8", timeout: 3000 })
      : execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", timeout: 3000 });
    const normalizedPath = serverPath.replace(/\\/g, "/").toLowerCase();
    const lines = process.platform === "win32"
      ? (() => { const parsed = JSON.parse(output || "[]"); return (Array.isArray(parsed) ? parsed : [parsed]).map(item => `${item.ProcessId || ""} ${item.CommandLine || ""}`); })()
      : output.split(/\r?\n/);
    const match = lines.find(line => String(line).replace(/\\/g, "/").toLowerCase().includes(normalizedPath));
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

export function validateMcpPython(candidate: string): { path: string; version: string; error: string } {
  const value = String(candidate || "").trim();
  if (!value || !path.isAbsolute(value)) return { path: value, version: "", error: "Enter an absolute Python executable path." };
  if (!fs.existsSync(value) || fs.statSync(value).isDirectory()) return { path: value, version: "", error: "Python executable was not found." };
  try {
    const executable = path.normalize(value);
    const version = execFileSync(executable, ["-c", "import platform;print(platform.python_version())"], {
      encoding: "utf-8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
    if (!match || Number(match[1]) < 3 || (Number(match[1]) === 3 && Number(match[2]) < 10)) {
      return { path: executable, version, error: `Python 3.10+ is required (found ${version || "unknown"}).` };
    }
    return { path: executable, version, error: "" };
  } catch (error: any) {
    return { path: value, version: "", error: `Could not run Python: ${error?.message || String(error)}` };
  }
}

export function detectMcpPython(ignoreConfigured = false): McpPythonStatus {
  const configured = vscode.workspace.getConfiguration("personalKnowledge").get<string>("mcpPythonPath", "").trim();
  if (configured && !ignoreConfigured) {
    const result = validateMcpPython(configured);
    return { ...result, valid: !result.error, source: "configured" };
  }
  const prefixes = [process.env.CONDA_PREFIX, process.env.VIRTUAL_ENV].filter(Boolean).map(String);
  const candidates: string[] = [];
  for (const prefix of prefixes) {
    if (process.platform === "win32") candidates.push(path.join(prefix, "python.exe"), path.join(prefix, "Scripts", "python.exe"));
    else candidates.push(path.join(prefix, "bin", "python"), path.join(prefix, "bin", "python3"));
  }
  try {
    const command = process.platform === "win32" ? "where python" : "command -v python3 || command -v python";
    candidates.push(...execSync(command, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/));
  } catch { /* no executable on PATH */ }
  for (const candidate of [...new Set(candidates.map(value => value.trim()).filter(Boolean))]) {
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
        try { execSync(command, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).forEach(value => add(value, "path", "PATH")); } catch { /* absent */ }
      }
      try {
        execSync("py -0p", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).forEach(line => {
          const match = /([A-Za-z]:\\[^*]+python\.exe)\s*$/i.exec(line.trim()); if (match) add(match[1], "py-launcher", "Python Launcher");
        });
      } catch { /* py launcher absent */ }
    } else {
      const names = ["python3", "python", "python3.14", "python3.13", "python3.12", "python3.11", "python3.10"];
      execSync(`which -a ${names.join(" ")} 2>/dev/null || true`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
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
    execSync(command, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).forEach(value => emit(value, "path", "PATH"));
  } catch { /* no PATH Python */ }
  if (generation !== mcpPythonScanGeneration) return;
  respond({ command: "mcpPythonScanProgress", data: { text: `Scanning conda/miniconda installations… ${count} found`, count } });
  const condaRoots = new Set<string>();
  for (const root of [process.env.CONDA_PREFIX, process.env.CONDA_EXE ? path.dirname(path.dirname(process.env.CONDA_EXE)) : "", path.join(os.homedir(), "miniconda3"), path.join(os.homedir(), "anaconda3")].filter(Boolean).map(String)) condaRoots.add(root);
  try {
    const raw = await new Promise<string>((resolve) => execFile("conda", ["env", "list", "--json"], { timeout: 20000, maxBuffer: 1 << 20 }, (_error, stdout) => resolve(String(stdout || ""))));
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

function resolveMcpPython(): string {
  const runtimePython = validateMcpPython(mcpRuntimePythonPath());
  if (!runtimePython.error) return runtimePython.path;
  throw new Error("Managed PKM MCP runtime is missing or broken. Create or Repair it in the Config tab.");
}

export function mcpServerDefinitionData(): { label: string; command: string; args: string[]; cwd: string; version: string } {
  const cwd = managedMcpServerDirectory();
  return {
    label: "pkm",
    command: resolveMcpPython(),
    args: [path.join(cwd, "server.py")],
    cwd,
    version: UNIFIED_MCP_VERSION,
  };
}

export function mcpRuntimeStatus(): McpRuntimeStatus {
  const runtimePath = mcpRuntimePath(), python = mcpRuntimePythonPath();
  const exists = fs.existsSync(runtimePath);
  const validation = validateMcpPython(python);
  const registered = pyenvList().some(env => env.path && path.resolve(env.path) === path.resolve(runtimePath));
  if (validation.error) return { path: runtimePath, python, exists, healthy: false, version: validation.version, error: exists ? validation.error : "Managed MCP runtime has not been created.", registered };
  try {
    execFileSync(validation.path, ["-c", "import fastmcp, websockets"], { timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
    return { path: runtimePath, python: validation.path, exists: true, healthy: true, version: validation.version, error: "", registered };
  } catch (error: any) {
    return { path: runtimePath, python: validation.path, exists: true, healthy: false, version: validation.version, error: `MCP dependencies are missing or broken: ${error?.message || String(error)}`, registered };
  }
}

export async function ensureMcpRuntime(context: vscode.ExtensionContext): Promise<McpRuntimeStatus> {
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
  await new Promise<void>((resolve, reject) => execFile(validation.path, ["-m", "pip", "install", "-r", requirements], {
    timeout: 600000, maxBuffer: 1 << 24,
  }, (error, _stdout, stderr) => error ? reject(new Error(`${error.message}\n${String(stderr || "")}`.trim())) : resolve()));
  fs.writeFileSync(mcpRuntimeBaseMarker(), JSON.stringify({ path: base.path, version: base.version }, null, 2) + "\n");
  const existing = pyenvList().find(env => env.path && path.resolve(env.path) === path.resolve(runtimePath));
  if (existing) pyenvUpdate(existing.id, { name: "PKM MCP Runtime", manager: "venv", python: validation.path, description: "Managed runtime for the unified PKM MCP server" });
  else pyenvAdd({ name: "PKM MCP Runtime", manager: "venv", path: runtimePath, python: validation.path, description: "Managed runtime for the unified PKM MCP server" });
  return mcpRuntimeStatus();
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
  const python = resolveMcpPython();
  return JSON.stringify({
    servers: {
      pkm: { type: "stdio", command: python, args: [path.join(mcpDir, "server.py")] },
    },
  }, null, 2);
}

export function combinedMcpInstallInstruction(): string {
  const storePath = getStorePath();
  const mcpDir = managedMcpServerDirectory();
  const runtimePython = mcpRuntimePythonPath();
  const serverPath = path.join(mcpDir, "server.py");
  const requirementsPath = path.join(mcpDir, "requirements.txt");
  const chatServerPath = path.join(mcpDir, "chat_server.py");
  const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;
  return [
    "Please register the unified local stdio MCP server named pkm in MCP Agency.",
    "Do the installation yourself; do not ask me to manually edit the registry unless Agency blocks you.",
    "IMPORTANT: these paths were generated for this machine. Preserve all unrelated MCP server registrations.",
    "",
    `Store: ${storePath}`,
    `Managed runtime Python: ${runtimePython}`,
    `pkm server: ${serverPath}`,
    `Internal chat module: ${chatServerPath}`,
    "",
    `1. Verify the managed runtime exists and can import fastmcp and websockets: ${quote(runtimePython)} -c "import fastmcp, websockets"`,
    `2. Verify the generated entry and chat module exist at ${serverPath} and ${chatServerPath}. If missing or outdated, regenerate them from the extension Config tab.`,
    "3. Remove obsolete pkm-chat and pkm-chat-live registrations; their chat tools are now exposed by pkm.",
    "4. In MCP Agency, add/import this Local/stdio server. Preserve all unrelated servers:",
    "",
    "```json",
    JSON.stringify({
      servers: {
        pkm: { type: "stdio", command: runtimePython, args: [serverPath] },
      },
    }, null, 2),
    "```",
    "",
    "5. The Config tab normally installs dependencies automatically. If Repair reported an install failure, run:",
    `   ${quote(runtimePython)} -m pip install -r ${quote(requirementsPath)}`,
    "6. Start or restart pkm in Agency. In VS Code, merge the same entry into .vscode/mcp.json, then click Start or run MCP: List Servers.",
    "7. Start a new agent chat session so tool discovery is refreshed.",
    `8. Discover pkm.check_version and verify unified version ${UNIFIED_MCP_VERSION}.`,
    "9. Call pkm.chat_capabilities and verify its chat_tools includes chat_join, chat_standby, and chat_post.",
    "Report any missing file, dependency error, start failure, or version mismatch with the exact error text.",
  ].join("\n");
}

export function mcpStatus(): McpServerStatus {
  const serverPath = path.join(managedMcpServerDirectory(), "server.py");
  const installedVersion = readMcpVersion(serverPath);
  const installedKnowledgeVersion = readMcpComponentVersion(serverPath, "KNOWLEDGE_SCHEMA_VERSION");
  const installedChatVersion = readMcpComponentVersion(serverPath, "CHAT_SCHEMA_VERSION");
  return {
    installed: !!installedVersion, serverPath,
    expectedVersion: UNIFIED_MCP_VERSION, installedVersion,
    current: installedVersion === UNIFIED_MCP_VERSION && installedKnowledgeVersion === KNOWLEDGE_MCP_VERSION && installedChatVersion === CHAT_MCP_VERSION,
    knowledgeVersion: KNOWLEDGE_MCP_VERSION,
    chatVersion: CHAT_MCP_VERSION,
    installedKnowledgeVersion,
    installedChatVersion,
  };
}

export function generateMcpServer(context: vscode.ExtensionContext): { serverPath: string; configSnippet: string } {
  const storePath = getStorePath();
  const mcpDir    = managedMcpServerDirectory();
  const serverPy  = path.join(mcpDir, "server.py");
  const reqTxt    = path.join(mcpDir, "requirements.txt");
  const storeFwd  = storePath.replace(/\\/g, "/");
  const subscriptionCacheFwd = path.join(context.globalStorageUri.fsPath, "subscriptions", "cache").replace(/\\/g, "/");

  fs.mkdirSync(mcpDir, { recursive: true });
  generateChatMcpServer(context);

  fs.writeFileSync(serverPy, `#!/usr/bin/env python3
"""
PKM MCP Server — auto-generated by Personal Knowledge Manager.
Exposes your skills and notes to AI assistants via the Model Context Protocol.

Skills and notes are stored as plain markdown files under skills/ and notes/ —
the files are the single source of truth (there is no database). Writes made by
this server appear immediately in the VS Code panel via its file watcher, and
show up in git history as readable .md diffs.

Read tools:  list_skills, search_skills, get_skill, list_notes, search_notes, get_note,
             list_papers, search_papers, get_paper, paper_graph,
             list_subscriptions, search_subscribed_content, get_subscribed_content
Write tools: add_note, update_note, delete_note, add_skill, update_skill, delete_skill,
             add_paper, update_paper, delete_paper

Search builds an in-memory FTS5 'trigram' index (CJK-friendly, ranked) at call
time, falling back to substring matching when FTS5 is unavailable.

Install:  pip install fastmcp
Run:      python server.py
"""
import json, re, sqlite3, datetime, hashlib, uuid
from pathlib import Path

SERVER_VERSION = "${UNIFIED_MCP_VERSION}"
KNOWLEDGE_SCHEMA_VERSION = "${KNOWLEDGE_MCP_VERSION}"
CHAT_SCHEMA_VERSION = "${CHAT_MCP_VERSION}"
from typing import Optional, List

try:
    from fastmcp import FastMCP
except ImportError:
    raise SystemExit("fastmcp not found. Run: pip install fastmcp")

STORE  = Path(r"${storeFwd}")
NOTES  = STORE / "notes"
SKILLS = STORE / "skills"
SUBSCRIPTIONS = Path(r"${subscriptionCacheFwd}")
mcp = FastMCP("pkm")

@mcp.tool()
def check_version() -> dict:
  """Return the unified server version and its component schema versions."""
  return {"name": "pkm", "version": SERVER_VERSION,
          "components": {"knowledge": KNOWLEDGE_SCHEMA_VERSION, "chat": CHAT_SCHEMA_VERSION},
          "capabilities": ["personal-knowledge", "papers", "pkm-chatroom", "pkm-skills", "subscriptions"],
          "chat_discovery_tool": "chat_capabilities",
          "skill_discovery_tool": "skill_capabilities"}


def _now() -> str:
    return datetime.datetime.utcnow().isoformat()


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


def _name_of(key):
    return key.rsplit("/", 1)[-1]


def _walk(root):
    out = []
    if not root.exists():
        return out
    for p in root.rglob("*.md"):
        rel = p.relative_to(root)
        if any(part.startswith(".") or part == "_assets" for part in rel.parts):
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
            "category": _cat_of(key), "content": body, "updated_at": _mtime(p)}


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
    if old.exists() and rel[:-3] != slug:
        try: old.unlink()
        except Exception: pass
    full.parent.mkdir(parents=True, exist_ok=True)
    fm = {"title": title, "type": type_ or "general", "tags": tags or [],
          "created": created or _now()}
    full.write_text(_serialize(fm, content or ""), encoding="utf-8")
    return rel[:-3]


# ── Skills ───────────────────────────────────────────────────────────────────
def _skill(p, key):
    fm, body = _parse(p.read_text(encoding="utf-8"))
    return {"name": fm.get("name") or _name_of(key), "description": fm.get("description") or "",
            "category": _cat_of(key), "tags": fm.get("tags") or [],
            "source_project": fm.get("source_project"), "content": body, "updated_at": _mtime(p)}


def _all_skills():
    return [_skill(p, k) for p, k in _walk(SKILLS)]


def _find_skill(name):
    for p, k in _walk(SKILLS):
        fm, _ = _parse(p.read_text(encoding="utf-8"))
        if (fm.get("name") or _name_of(k)) == name:
            return p, k
    return None, None


def _skill_get(name):
    p, k = _find_skill(name)
    return _skill(p, k) if p else None


def _skill_write(name, content, description, category, tags, source_project=None, created=None):
    cat = _safe_cat(category or "")
    fname = _safe_name(name) + ".md"
    rel = (cat + "/" + fname) if cat else fname
    full = SKILLS / rel
    oldp, _ = _find_skill(name)
    if oldp is not None and str(oldp) != str(full):
        try: oldp.unlink()
        except Exception: pass
    full.parent.mkdir(parents=True, exist_ok=True)
    fm = {"name": name, "description": description or "", "tags": tags or [],
          "source_project": source_project, "created": created or _now()}
    full.write_text(_serialize(fm, content or ""), encoding="utf-8")
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
    # Preserve user-set kind/group/pinned when the caller doesn't specify them.
    if (kind is None or group is None or pinned is None) and old.exists():
        prev, _ = _parse(old.read_text(encoding="utf-8"))
        if kind is None: kind = prev.get("kind")
        if group is None: group = prev.get("group")
        if pinned is None: pinned = prev.get("pinned")
    if old.exists() and rel[:-3] != slug:
        try: old.unlink()
        except Exception: pass
    full.parent.mkdir(parents=True, exist_ok=True)
    fm = {"title": title,
          "kind": "idea" if kind == "idea" else None,
          "group": (str(group).strip() if group and str(group).strip() != "Papers" else None),
          "pinned": True if pinned is True else None,
          "authors": authors or [], "year": _year(year), "topic": topic or "",
          "publisher": publisher or "", "tags": tags or [], "url": url or "", "file": file or "",
          "conclusions": conclusions or [], "cites": _norm_cites(cites or []), "created": created or _now()}
    full.write_text(_serialize(fm, content or ""), encoding="utf-8")
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
  return ((row.get("category") or "") + "/" + row["name"]).strip("/")


def _skill_hash(row):
  value = json.dumps({"name": row["name"], "description": row.get("description", ""),
            "category": row.get("category", ""), "tags": row.get("tags", []),
            "content": row.get("content", "")}, ensure_ascii=False, sort_keys=True)
  return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _skill_by_id(skill_id):
  wanted = str(skill_id or "").strip("/").casefold()
  for row in _all_skills():
    if _skill_id(row).casefold() == wanted or row["name"].casefold() == wanted:
      return row
  return None


_SKILL_STOP_WORDS = set("a an and are as at be by debug debugging for from how in into is it local member members name no not of on or problem substantial that the this to use using with workspace file files src code coding task issue".split())


def _skill_terms(value):
  text = re.sub(r"([a-z0-9])([A-Z])", r"\\1 \\2", str(value or ""))
  return set(term for term in re.findall(r"[\\w]{2,}", text.casefold(), re.UNICODE)
         if term not in _SKILL_STOP_WORDS and not term.isdigit())


@mcp.tool()
def skill_capabilities() -> str:
  """Discover the PKM secondary-Skill workflow for finding, using, and maintaining reusable knowledge."""
  return json.dumps({
    "ok": True,
    "capability": "pkm-skills",
    "workflow": ["skill_context", "get_skill for selected candidates", "perform task", "skill_feedback", "propose_skill_update"],
    "tools": ["skill_context", "skill_feedback", "propose_skill_update", "search_skills", "get_skill"],
    "maintenance_policy": "Use proposals for reusable changes; do not overwrite formal Skills automatically.",
  })


@mcp.tool()
def skill_context(task: str, workspace: str = "", files: Optional[List[str]] = None,
          diagnostics: str = "", limit: int = 3) -> str:
  """Find and activate the smallest relevant PKM Skill set for a substantial task.

  Call before coding, research, debugging, or operational workflows that may
  depend on personal conventions or domain knowledge. Returns thresholded Skill
  summaries; call get_skill with a selected skill_id to load its full body.
  """
  if not str(task or "").strip():
    return json.dumps({"ok": False, "error": "task is required"})
  task_terms = _skill_terms(task)
  context_terms = _skill_terms(" ".join([str(workspace or ""), " ".join(files or []), str(diagnostics or "")]))
  rows = _all_skills()
  metadata_documents = []
  for candidate in rows:
    metadata_documents.append(_skill_terms(" ".join([
      candidate["name"], candidate.get("description") or "", candidate.get("category") or "",
      " ".join(candidate.get("tags") or []), candidate.get("source_project") or ""])))
  rare_limit = max(1, int(len(rows) * 0.05))
  rare_task_terms = set(term for term in task_terms
             if sum(1 for document in metadata_documents if term in document) <= rare_limit)
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
    coverage = len(metadata_hits) / max(1, len(task_terms))
    # Context may distinguish already-relevant Skills, but can never make an
    # unrelated Skill eligible on its own.
    context_metadata = set().union(*(context_terms & fields[field] for field in weights))
    # Body and execution context are tie-breakers only. They cannot increase
    # admission coverage or turn an unrelated Skill into a candidate.
    score += min(len(content_hits), 4) + min(len(context_metadata) * 2, 8)
    matched.extend("content:" + term for term in sorted(content_hits)[:3])
    matched.extend("context:" + term for term in sorted(context_metadata)[:2])
    enough_metadata = len(metadata_hits) >= (1 if len(task_terms) <= 2 else 2)
    enough_coverage = coverage >= (0.5 if len(task_terms) <= 2 else 0.34)
    anchor_matched = not rare_task_terms or bool(metadata_hits & rare_task_terms)
    if enough_metadata and enough_coverage and anchor_matched:
      ranked.append((score, coverage, len(metadata_hits), row, matched[:8]))
  ranked.sort(key=lambda item: (-item[0], -item[1], -item[2], _skill_id(item[3]).casefold()))
  selected = ranked[:max(1, min(int(limit or 3), 5))]
  skills = []
  for index, (score, coverage, metadata_count, row, reasons) in enumerate(selected):
    skills.append({"skill_id": _skill_id(row), "name": row["name"],
             "description": row.get("description", ""), "category": row.get("category", ""),
             "tags": row.get("tags", []), "source_project": row.get("source_project"),
             "content_hash": _skill_hash(row), "score": score, "task_coverage": round(coverage, 3),
             "priority": "required" if index == 0 and metadata_count >= 2 and coverage >= 0.5 else "recommended",
             "match_reason": reasons})
  no_match = not skills
  return json.dumps({"ok": True, "task": task, "count": len(skills), "no_match": no_match,
             "retrieval": "summary", "skills": skills,
             "instruction": "No relevant PKM Skill met the threshold; continue without one."
               if no_match else "Call get_skill with the skill_id of each candidate you choose to apply. Follow required Skills, then report outcomes with skill_feedback."}, ensure_ascii=False)


@mcp.tool()
def skill_feedback(task: str, used_skills: List[str], outcome: str,
           observations: Optional[List[str]] = None, evidence: Optional[List[str]] = None) -> str:
  """Record which PKM Skills were used, the outcome, and reusable observations without modifying formal Skills."""
  directory = STORE / "_feedback"
  directory.mkdir(parents=True, exist_ok=True)
  entry = {"id": str(uuid.uuid4()), "created": _now(), "task": task,
       "used_skills": used_skills or [], "outcome": outcome,
       "observations": observations or [], "evidence": evidence or []}
  with (directory / "skill-usage.jsonl").open("a", encoding="utf-8") as handle:
    handle.write(json.dumps(entry, ensure_ascii=False) + "\\n")
  return json.dumps({"ok": True, "feedback_id": entry["id"]})


@mcp.tool()
def propose_skill_update(skill_id: str, base_hash: str, reason: str,
             evidence: Optional[List[str]] = None, proposed_content: str = "",
             confidence: float = 0.0) -> str:
  """Create a reviewable PKM Skill maintenance proposal; never directly changes the formal Skill."""
  row = _skill_by_id(skill_id)
  if not row:
    return json.dumps({"ok": False, "error": "Skill not found", "skill_id": skill_id})
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


@mcp.tool()
def list_skills(category: Optional[str] = None) -> str:
    """List personal skills, optionally filtered by category (a slash-separated folder path)."""
    rows = _all_skills()
    if category:
        rows = [r for r in rows if r["category"] == category]
    rows.sort(key=lambda r: (r["category"], r["name"]))
    return json.dumps([{"name": r["name"], "description": r["description"],
                        "category": r["category"], "tags": r["tags"]} for r in rows])


@mcp.tool()
def search_skills(query: str) -> str:
    """Ranked full-text search across skill names, content, and descriptions (CJK-friendly)."""
    skills = _all_skills()
    hits = []
    idx = _index(skills, [])
    if idx is not None:
        try:
            names = [x[0] for x in idx.execute(
                "SELECT name FROM s WHERE s MATCH ? ORDER BY rank LIMIT 20", [query])]
            by = {}
            for s in skills:
                by.setdefault(s["name"], s)
            hits = [by[n] for n in names if n in by]
        except sqlite3.OperationalError:
            hits = []
    if not hits:
        q = query.lower()
        hits = [s for s in skills if q in s["name"].lower()
                or q in (s["content"] or "").lower() or q in (s["description"] or "").lower()][:20]
    return json.dumps([{"name": s["name"], "description": s["description"], "category": s["category"]} for s in hits])


@mcp.tool()
def get_skill(name: str) -> str:
  """Get the full content of a skill by stable skill_id or exact name."""
  r = _skill_by_id(name)
  if not r:
    return f"Skill '{name}' not found. Use list_skills or search_skills to find it."
  return json.dumps({"skill_id": _skill_id(r), "content_hash": _skill_hash(r),
             "name": r["name"], "content": r["content"], "description": r["description"],
             "category": r["category"], "tags": r["tags"], "updated_at": r["updated_at"]})


@mcp.tool()
def list_notes(type: Optional[str] = None) -> str:
    """List notes. type can be: general, todo, done, observation, data-path."""
    rows = _all_notes()
    if type and type != "all":
        rows = [r for r in rows if r["type"] == type]
    rows.sort(key=lambda r: r["updated_at"], reverse=True)
    return json.dumps([{"slug": r["slug"], "title": r["title"], "type": r["type"],
                        "category": r["category"], "updated_at": r["updated_at"]} for r in rows[:50]])


@mcp.tool()
def search_notes(query: str) -> str:
    """Ranked full-text search across note titles and content (CJK-friendly)."""
    notes = _all_notes()
    hits = []
    idx = _index([], notes)
    if idx is not None:
        try:
            slugs = [x[0] for x in idx.execute(
                "SELECT slug FROM n WHERE n MATCH ? ORDER BY rank LIMIT 20", [query])]
            by = {r["slug"]: r for r in notes}
            hits = [by[s] for s in slugs if s in by]
        except sqlite3.OperationalError:
            hits = []
    if not hits:
        q = query.lower()
        hits = [r for r in notes if q in r["title"].lower() or q in (r["content"] or "").lower()][:20]
    return json.dumps([{"slug": r["slug"], "title": r["title"], "type": r["type"]} for r in hits])


@mcp.tool()
def get_note(slug: str) -> str:
    """Get the full content of a note by slug (its relative path without .md)."""
    r = _note_get(slug)
    if not r:
        return f"Note '{slug}' not found. Use list_notes or search_notes to find it."
    return json.dumps({"slug": r["slug"], "title": r["title"], "content": r["content"],
                       "type": r["type"], "tags": r["tags"], "category": r["category"],
                       "updated_at": r["updated_at"]})


# ── Write tools ─────────────────────────────────────────────────────────────
@mcp.tool()
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


@mcp.tool()
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


@mcp.tool()
def delete_note(slug: str) -> str:
    """Delete a note by slug (its relative path without .md)."""
    p = NOTES / (slug + ".md")
    try: p.unlink(missing_ok=True)
    except Exception: pass
    return json.dumps({"ok": True, "slug": slug})


@mcp.tool()
def add_skill(name: str, content: str, description: str = "", category: str = "",
              tags: Optional[List[str]] = None, source_project: str = "") -> str:
    """Create or overwrite a skill. 'category' is a slash-separated folder path
    (e.g. General/DLIS/docker); 'name' is the skill's unique identifier."""
    created = None
    existing = _skill_get(name)
    _skill_write(name, content, description, category, tags or [], source_project or None, created)
    return json.dumps({"ok": True, "name": name})


@mcp.tool()
def update_skill(name: str, content: Optional[str] = None, description: Optional[str] = None,
                 category: Optional[str] = None, tags: Optional[List[str]] = None) -> str:
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
    )
    return json.dumps({"ok": True, "name": name})


@mcp.tool()
def delete_skill(name: str) -> str:
    """Delete a skill by name."""
    p, _ = _find_skill(name)
    if p is not None:
        try: p.unlink()
        except Exception: pass
    return json.dumps({"ok": True, "name": name})


# ── Paper tools ──────────────────────────────────────────────────────────────
@mcp.tool()
def list_papers(topic: Optional[str] = None) -> str:
    """List papers (optionally filtered by topic), sorted by citation count (popularity)."""
    all_p = _all_papers(); counts = _citation_counts(all_p)
    rows = [p for p in all_p if (not topic or p["topic"] == topic)]
    rows.sort(key=lambda p: (-(counts.get(p["slug"], 0)), -(p["year"] or 0), p["title"]))
    return json.dumps([{"slug": p["slug"], "title": p["title"], "year": p["year"],
                        "authors": p["authors"], "topic": p["topic"], "publisher": p["publisher"],
                        "tags": p["tags"], "citation_count": counts.get(p["slug"], 0)} for p in rows])


@mcp.tool()
def search_papers(query: str) -> str:
    """Search papers by title, authors, topic, publisher, tags, or year."""
    q = query.lower(); all_p = _all_papers(); counts = _citation_counts(all_p)
    hits = [p for p in all_p if q in p["title"].lower() or q in p["topic"].lower()
            or q in p["publisher"].lower() or q in " ".join(p["authors"]).lower()
            or q in " ".join(p["tags"]).lower() or q in str(p["year"] or "")]
    return json.dumps([{"slug": p["slug"], "title": p["title"], "year": p["year"],
                        "topic": p["topic"], "citation_count": counts.get(p["slug"], 0)} for p in hits[:50]])


@mcp.tool()
def get_paper(slug: str) -> str:
    """Get a paper's full record (metadata, conclusions, cites with notes, body) by slug."""
    p = _paper_get(slug)
    if not p:
        return f"Paper '{slug}' not found. Use list_papers or search_papers to find it."
    p["citation_count"] = _citation_counts(_all_papers()).get(slug, 0)
    return json.dumps(p)


@mcp.tool()
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


@mcp.tool()
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


@mcp.tool()
def delete_paper(slug: str) -> str:
    """Delete a paper by slug."""
    try: (PAPERS / (slug + ".md")).unlink(missing_ok=True)
    except Exception: pass
    return json.dumps({"ok": True, "slug": slug})


@mcp.tool()
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
        metadata["cache_root"] = str(metadata_path.parent)
        rows.append(metadata)
      except Exception:
        continue
    return rows


@mcp.tool()
def list_subscriptions() -> str:
    """List physically isolated, machine-local PKM subscriptions and their provenance.
    This does not search or modify the user's local Knowledge Root."""
    rows = []
    for record in _subscription_records():
      rows.append({k: record.get(k) for k in ["subscriptionId", "alias", "publisher", "nodeId", "shareId", "revision", "collectionHash", "syncedAt"]})
    return json.dumps(rows, ensure_ascii=False)


@mcp.tool()
def search_subscribed_content(query: str, content_type: Optional[str] = None,
                  alias: Optional[str] = None, limit: int = 20) -> str:
    """Explicitly search downloaded subscription caches. Results remain read-only and
    separate from local Skills/Notes/Papers/Prompts/Scripts/Packages/Servers."""
    needle = (query or "").casefold()
    wanted_type = (content_type or "").strip().lower()
    wanted_alias = (alias or "").casefold()
    results = []
    for record in _subscription_records():
      if wanted_alias and wanted_alias not in str(record.get("alias") or record.get("publisher") or "").casefold():
        continue
      root = Path(record["cache_root"]) / "content"
      if not root.exists():
        continue
      for file_path in root.rglob("*"):
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
          "revision": record.get("revision"), "synced_at": record.get("syncedAt"),
        })
        if len(results) >= max(1, min(limit, 100)):
          return json.dumps(results, ensure_ascii=False)
    return json.dumps(results, ensure_ascii=False)


@mcp.tool()
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
      return json.dumps({"content": content, "provenance": provenance}, ensure_ascii=False)
    except Exception as error:
      return json.dumps({"error": str(error)})


from chat_server import mcp as chat_mcp
mcp.mount(chat_mcp)

if __name__ == "__main__":
    mcp.run()
`);

  fs.writeFileSync(reqTxt, "fastmcp>=2.0.0\nwebsockets>=12.0\n");
  fs.rmSync(path.join(mcpDir, "chat_requirements.txt"), { force: true });

  const configSnippet = JSON.stringify({
    servers: {
      "pkm": {
        type: "stdio",
        command: resolveMcpPython(),
        args: [serverPy],
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
  const serverPath = path.join(managedMcpServerDirectory(), "chat_server.py");
  const installedVersion = readMcpVersion(serverPath);
  return {
    installed: !!installedVersion, serverPath,
    expectedVersion: CHAT_MCP_VERSION, installedVersion,
    current: installedVersion === CHAT_MCP_VERSION,
    knowledgeVersion: KNOWLEDGE_MCP_VERSION,
    chatVersion: CHAT_MCP_VERSION,
    installedKnowledgeVersion: readMcpComponentVersion(serverPath, "KNOWLEDGE_SCHEMA_VERSION"),
    installedChatVersion: readMcpComponentVersion(serverPath, "CHAT_SCHEMA_VERSION"),
  };
}

export function generateChatMcpServer(context: vscode.ExtensionContext): { serverPath: string; configSnippet: string } {
  const storePath = getStorePath();
  const mcpDir    = managedMcpServerDirectory();
  const serverPy  = path.join(mcpDir, "chat_server.py");
  fs.mkdirSync(mcpDir, { recursive: true });

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

  const extensionRoot = context?.extensionPath || path.join(__dirname, "..");
  const templatePath = path.join(extensionRoot, "resources", "chat_server.py.template");
  const template = fs.readFileSync(templatePath, "utf-8")
    .replace(/%%CHAT_MCP_VERSION%%/g, CHAT_MCP_VERSION);
  const requiredChatTools = ["chat_capabilities", "chat_join", "chat_standby", "chat_post", "chat_status"];
  const missingChatTools = requiredChatTools.filter(tool => !template.includes(`def ${tool}(`));
  if (missingChatTools.length) throw new Error(`Chat MCP template is missing required tools: ${missingChatTools.join(", ")}`);
  const requiredSkillTools = ["skill_capabilities", "skill_context", "skill_feedback", "propose_skill_update"];
  const missingSkillTools = requiredSkillTools.filter(tool => !fs.readFileSync(path.join(__dirname, "mcp.js"), "utf8").includes(`def ${tool}(`));
  if (missingSkillTools.length) throw new Error(`Unified MCP server is missing required Skill tools: ${missingSkillTools.join(", ")}`);
  fs.writeFileSync(serverPy, template);

  const configSnippet = JSON.stringify({
    servers: {
      "pkm": {
        type: "stdio",
        command: resolveMcpPython(),
        args: [path.join(mcpDir, "server.py")],
      }
    }
  }, null, 2);

  return { serverPath: serverPy, configSnippet };
}

