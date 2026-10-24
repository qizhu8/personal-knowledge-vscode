import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { managedMcpLifecycleStatus } from "../mcp/mcp-lifecycle";
import { ExtensionBuild } from "./extension-host-runtime";
import { compareVersionOrder } from "./version-order";

export interface BackgroundProcessRuntime {
  source: "managed-registry";
  fresh: boolean;
  observedAt?: string;
  extensionVersion?: string;
  serverVersion?: string;
  generation?: string;
  configuredGeneration?: string;
  runtimeBuild?: string;
  phase?: string;
  inFlight?: number;
  uncertainCalls?: number;
}

export interface BackgroundProcessAssessment {
  state: "test-leftover" | "test" | "missing-entry" | "superseded" | "older" | "current" | "newer" | "unverified";
  basis: "runtime-report" | "entry-path" | "unknown";
}

export interface BackgroundProcess {
  pid: number;
  parentPid: number;
  kind: "mcp" | "service" | "retrieval";
  entryPath: string;
  entryExists?: boolean;
  pathVersion?: string;
  fixture: boolean;
  elapsedSeconds: number;
  rssBytes: number;
  parentName?: string;
  parentObserved?: boolean;
  startedAt?: string;
  runtime?: BackgroundProcessRuntime;
  runtimeError?: string;
  assessment?: BackgroundProcessAssessment;
}

export interface BackgroundProcessSnapshot {
  sampledAt: string;
  host: string;
  platform: string;
  processes: BackgroundProcess[];
  error?: string;
  installedExtension?: ExtensionBuild;
  loadedExtension?: ExtensionBuild;
}

interface ProcessObservation {
  pid: number;
  parentPid: number;
  elapsedSeconds: number;
  rssBytes: number;
  command: string;
}

export function parseProcessTable(output: string): ProcessObservation[] {
  return output.split(/\r?\n/).flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d:.-]+)\s+(\d+)\s+(.+)$/);
    if (!match) return [];
    const elapsed = match[3].match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
    if (!elapsed) return [];
    return [{
      pid: Number(match[1]), parentPid: Number(match[2]),
      elapsedSeconds: Number(elapsed[1] || 0) * 86400 + Number(elapsed[2] || 0) * 3600
        + Number(elapsed[3]) * 60 + Number(elapsed[4]),
      rssBytes: Number(match[4]) * 1024, command: match[5],
    }];
  });
}

export function assessBackgroundProcess(process: BackgroundProcess, installedVersion?: string): BackgroundProcessAssessment {
  if (process.fixture) return { state: process.entryExists === false ? "test-leftover" : "test", basis: "entry-path" };
  if (process.entryExists === false) return { state: "missing-entry", basis: "entry-path" };
  const runtime = process.runtime;
  const fresh = runtime?.fresh && !process.runtimeError;
  if (fresh && ((runtime.generation && runtime.configuredGeneration && runtime.generation !== runtime.configuredGeneration)
    || ["draining", "drained", "action-required"].includes(runtime.phase || ""))) {
    return { state: "superseded", basis: "runtime-report" };
  }
  const reportedVersion = fresh ? runtime.extensionVersion : undefined;
  const version = reportedVersion || process.pathVersion;
  const basis = reportedVersion ? "runtime-report" : process.pathVersion ? "entry-path" : "unknown";
  const order = version && installedVersion ? compareVersionOrder(version, installedVersion) : undefined;
  return { state: order === -1 ? "older" : order === 1 ? "newer"
    : order === 0 && basis === "runtime-report" ? "current" : "unverified", basis };
}

export function describeBackgroundProcesses(
  rows: ProcessObservation[],
  stat: (file: string) => unknown = fs.statSync,
  evidence: {
    installedVersion?: string;
    now?: number;
    mcpStatus?: typeof managedMcpLifecycleStatus;
  } = {},
): BackgroundProcess[] {
  const result: BackgroundProcess[] = [];
  const now = evidence.now ?? Date.now();
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const mcpReports = new Map<string, ReturnType<typeof managedMcpLifecycleStatus>>();
  for (const row of rows) {
    // Only known PKM entrypoints are exposed; never send full command lines to the webview.
    const tokens = [...row.command.matchAll(/"([^"]+)"|'([^']+)'|([^\s"']+)/g)].map(m => m[1] || m[2] || m[3]);
    const executable = tokens[0]?.split(/[/\\]/).pop() || "";
    if (!/^(?:python(?:[\d.]+)?|node|code(?:-insiders)?)(?:\.exe)?$/i.test(executable)
      || tokens.some(token => ["-c", "-e", "--eval", "-Command"].includes(token))) continue;
    const entry = tokens.find(token => /(?:^|[/\\])(?:retrieval_worker\.py|pkm-service-entry\.js)$/.test(token)
      || /(?:^|[/\\])mcp-server[/\\]server\.py$/.test(token));
    if (!entry || !/^(?:\/|[A-Za-z]:[/\\])/.test(entry)) continue;
    let entryExists: boolean | undefined;
    try { stat(entry); entryExists = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") entryExists = false;
      else throw new Error(`Cannot inspect PKM process ${row.pid} entry (${(error as NodeJS.ErrnoException).code || "unknown error"}).`);
    }
    const parent = byPid.get(row.parentPid);
    const process: BackgroundProcess = {
      pid: row.pid, parentPid: row.parentPid, elapsedSeconds: row.elapsedSeconds, rssBytes: row.rssBytes,
      entryPath: entry, entryExists,
      kind: /retrieval_worker\.py$/.test(entry) ? "retrieval" : /pkm-service-entry\.js$/.test(entry) ? "service" : "mcp",
      pathVersion: entry.match(/uone\.personal-knowledge-([\d.]+)(?:[/\\]|$)/)?.[1],
      fixture: /(?:^|[/\\])pkm-(?:startup|ctx-host)-[^/\\]+[/\\]/.test(entry),
      parentObserved: !!parent,
      parentName: parent?.command.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/)?.slice(1).find(Boolean)?.split(/[/\\]/).pop(),
      startedAt: new Date(now - row.elapsedSeconds * 1000).toISOString(),
    };
    if (process.kind === "mcp") {
      const directory = (entry.includes("\\") ? path.win32 : path).dirname(entry);
      try {
        let report = mcpReports.get(directory);
        if (!report) {
          report = (evidence.mcpStatus || managedMcpLifecycleStatus)(directory, now);
          mcpReports.set(directory, report);
        }
        const matches = report.instances.filter(instance => instance.pid === row.pid);
        if (matches.length > 1) throw new Error("Multiple MCP instance records match this PID; runtime ownership is ambiguous.");
        const record = matches[0];
        if (record) {
          const string = (key: string): string | undefined =>
            typeof record[key] === "string" ? record[key].slice(0, 256) : undefined;
          const count = (key: string): number | undefined =>
            Number.isSafeInteger(record[key]) && record[key] >= 0 ? record[key] : undefined;
          process.runtime = {
            source: "managed-registry", fresh: record.heartbeatFresh === true,
            observedAt: Number.isFinite(record.heartbeatAt) ? new Date(record.heartbeatAt * 1000).toISOString() : undefined,
            extensionVersion: string("extensionVersion"), serverVersion: string("version"),
            generation: string("generation"), configuredGeneration: report.configuredGeneration,
            runtimeBuild: string("runtimeBuild"), phase: string("phase"),
            inFlight: count("inFlight"), uncertainCalls: count("uncertainCalls"),
          };
        }
      } catch (error) {
        process.runtimeError = `MCP runtime evidence unavailable: ${(error as Error).message}`;
      }
    }
    process.assessment = assessBackgroundProcess(process, evidence.installedVersion);
    result.push(process);
  }
  return result.sort((a, b) => Number(a.entryExists !== false) - Number(b.entryExists !== false) || a.pid - b.pid);
}

const run = promisify(execFile);
const windowsInventory = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$items = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match '^(python[\\d.]*|node|code)\\.exe$' -and
  $_.CommandLine -match '(mcp-server[\\\\/]server\\.py|retrieval_worker\\.py|pkm-service-entry\\.js)'
} | ForEach-Object {
  $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid
  if ($owner.ReturnValue -ne 0) { throw 'Cannot determine process owner' }
  if ($owner.Sid -eq $sid) {
    [pscustomobject]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId
      elapsedSeconds = [Math]::Max(0, ((Get-Date) - $_.CreationDate).TotalSeconds)
      rssBytes = $_.WorkingSetSize; command = $_.CommandLine }
  }
})
ConvertTo-Json -InputObject $items -Compress
`;

export class BackgroundProcessInventory {
  private pending?: Promise<BackgroundProcessSnapshot>;
  private cached?: BackgroundProcessSnapshot;

  snapshot(installedExtension?: ExtensionBuild): Promise<BackgroundProcessSnapshot> {
    if (this.pending) return this.pending;
    if (this.cached && this.cached.installedExtension?.buildId === installedExtension?.buildId
      && Date.now() - Date.parse(this.cached.sampledAt) < 5000) return Promise.resolve(this.cached);
    this.pending = this.collect(installedExtension).then(snapshot => this.cached = snapshot).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async collect(installedExtension?: ExtensionBuild): Promise<BackgroundProcessSnapshot> {
    let rows: ProcessObservation[];
    const options = { timeout: 10_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true };
    if (process.platform === "win32") {
      const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsInventory], options);
      const value: unknown = JSON.parse(stdout);
      if (!Array.isArray(value)) throw new Error("Invalid Windows process inventory.");
      rows = value.map((row: unknown) => {
        if (!row || typeof row !== "object") throw new Error("Invalid Windows process observation.");
        const p = row as Record<string, unknown>;
        if (![p.pid, p.parentPid, p.elapsedSeconds, p.rssBytes].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)
          || typeof p.command !== "string") throw new Error("Invalid Windows process observation.");
        return { pid: Number(p.pid), parentPid: Number(p.parentPid), elapsedSeconds: Number(p.elapsedSeconds),
          rssBytes: Number(p.rssBytes), command: p.command };
      });
    } else if (process.platform === "linux" || process.platform === "darwin") {
      const uid = process.getuid?.();
      if (uid === undefined) throw new Error("Current-user identity is unavailable for process inventory.");
      const { stdout } = await run("ps", ["-u", String(uid), "-ww", "-o", "pid=,ppid=,etime=,rss=,args="], options);
      rows = parseProcessTable(stdout);
      if (stdout.trim() && !rows.length) throw new Error("Unrecognized process inventory format.");
    } else {
      throw new Error(`Background process inventory is unavailable on ${process.platform}.`);
    }
    return { sampledAt: new Date().toISOString(), host: os.hostname(), platform: process.platform,
      installedExtension, processes: describeBackgroundProcesses(rows, fs.statSync, { installedVersion: installedExtension?.version }) };
  }
}
