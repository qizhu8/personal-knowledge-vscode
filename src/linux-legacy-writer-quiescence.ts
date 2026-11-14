import { constants } from "node:fs";
import { readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { CoreError } from "./contracts.js";

const procRoot = "/proc";
const maximumProcesses = 16_384;
const maximumDescriptorsPerProcess = 4_096;
const openAccessModeMask = 3;

export interface LinuxManagedSnapshotHostPermit { readonly kind: "pkm.linux-managed-snapshot-host/v1"; }
const permits = new WeakMap<LinuxManagedSnapshotHostPermit, {
  root: string; authority: { authorityId: string; authorize: unknown; allowedTools: readonly string[] }; check(): void;
}>();

/**
 * Same-process only: require the actual installed extension's own module
 * brands and native consent, rather than accepting a PID or callback whitelist.
 */
export function bindLinuxManagedSnapshotHost(options: {
  root: string; context: any; host: any; authority: any;
}): LinuxManagedSnapshotHostPermit {
  const require = createRequire(import.meta.url);
  const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const vscode = require("vscode"), context = options?.context, host = options?.host;
  const authority = options?.authority, root = options?.root;
  const extension = context?.extension && vscode.extensions.getExtension(context.extension.id);
  if (process.platform !== "linux" || !extension?.isActive || extension.extensionPath !== extensionPath
    || context.extensionPath !== extensionPath || root !== host?.root
    || typeof authority?.authorityId !== "string")
    throw new CoreError("LEGACY_WRITER_INVENTORY_UNAVAILABLE", "A live installed managed VS Code host is required.");
  const payload = require(join(extensionPath, "dist/runtime/next-payload-verifier.js")).verifyNextPayload(extensionPath);
  if (resolve(payload.root, "server/dist") !== dirname(fileURLToPath(import.meta.url)))
    throw new CoreError("LEGACY_WRITER_INVENTORY_UNAVAILABLE", "The installed Next payload binding changed.");
  const session = require(join(extensionPath, "dist/runtime/managed-writer-session.js"));
  const snapshot = require(join(extensionPath, "dist/runtime/legacy-snapshot-vscode-authority.js"));
  const check = () => {
    if (!extension.isActive || context.extensionPath !== extensionPath || host.root !== root)
      throw new CoreError("LEGACY_WRITER_INVENTORY_UNAVAILABLE", "The managed VS Code host changed.");
    session.assertManagedDrainedSnapshotHost(host);
    snapshot.assertLegacySnapshotVscodeAuthority(authority, context, host);
  };
  check();
  const permit = Object.freeze({ kind: "pkm.linux-managed-snapshot-host/v1" as const });
  permits.set(permit, { root, authority, check });
  return permit;
}

export function assertLinuxManagedSnapshotHostPermit(
  root: string, permit: LinuxManagedSnapshotHostPermit,
  admission: { authorityId: string; authorize: unknown; allowedTools: readonly string[] } | undefined,
): void {
  const binding = permits.get(permit);
  if (!binding || binding.root !== root || !admission || admission.authorityId !== binding.authority.authorityId
    || admission.authorize !== binding.authority.authorize
    || JSON.stringify(admission.allowedTools) !== JSON.stringify(binding.authority.allowedTools))
    throw new CoreError("LEGACY_WRITER_INVENTORY_UNAVAILABLE", "Managed snapshot host permit is not bound to this admission.");
  binding.check();
}

export interface LinuxLegacyWriterProcess {
  pid: number;
  parentPid: number;
  startTimeTicks: string;
  kind: "vscode-extension-host" | "vscode-host-process" | "legacy-mcp" | "pkm-service" | "writable-root-handle" | "root-working-directory" | "uninspectable";
}

export interface LinuxLegacyWriterQuiescenceReport {
  schema: "pkm.linux-legacy-writer-quiescence/v1";
  root: string;
  scannedAt: string;
  ownerPid: number;
  allowedExtensionHostPids: number[];
  blockers: LinuxLegacyWriterProcess[];
}

interface ProcessRecord {
  pid: number;
  parentPid: number;
  uid: number;
  startTimeTicks: string;
  state: string;
  comm: string;
  command: string[];
}

function processGone(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error
    && ["ENOENT", "ESRCH"].includes(String(error.code));
}

async function processRecord(pid: number, uid: number): Promise<ProcessRecord | undefined> {
  const directory = join(procRoot, String(pid));
  try {
    const owner = await stat(directory);
    if (owner.uid !== uid) return undefined;
    const [status, processStat, commandLine] = await Promise.all([
      readFile(join(directory, "status"), "utf8"),
      readFile(join(directory, "stat"), "utf8"),
      readFile(join(directory, "cmdline")),
    ]);
    const statusUid = /^Uid:\s+(\d+)/m.exec(status);
    const parent = /^PPid:\s+(\d+)/m.exec(status);
    const close = processStat.lastIndexOf(")");
    if (!statusUid || !parent || close < 0 || Number(statusUid[1]) !== uid)
      throw new Error("Process identity could not be verified.");
    const fields = processStat.slice(close + 1).trim().split(/\s+/);
    if (fields.length < 20 || !/^\d+$/.test(fields[19]!))
      throw new Error("Process start identity could not be verified.");
    const command = commandLine.toString("utf8").split("\0").filter(Boolean);
    const confirmation = await readFile(join(directory, "stat"), "utf8");
    const confirmClose = confirmation.lastIndexOf(")");
    const confirmFields = confirmation.slice(confirmClose + 1).trim().split(/\s+/);
    if (confirmFields[19] !== fields[19]) return undefined;
    return {
      pid, parentPid: Number(parent[1]), uid, startTimeTicks: fields[19]!,
      state: fields[0]!, comm: processStat.slice(processStat.indexOf("(") + 1, close), command,
    };
  } catch (error) {
    if (processGone(error)) return undefined;
    const owner = await stat(directory).catch(() => undefined);
    if (!owner || owner.uid !== uid) return undefined;
    return {
      pid, parentPid: 0, uid, startTimeTicks: "unknown", state: "?",
      comm: "", command: [],
    };
  }
}

function isWithinRoot(root: string, value: string): boolean {
  const normalized = value.replace(/ \(deleted\)$/, "");
  if (!isAbsolute(normalized)) return false;
  const path = resolve(normalized);
  const rel = relative(root, path);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function legacyMcpPath(root: string, command: readonly string[]): boolean {
  const directory = resolve(root, "mcp-server");
  return command.some(token => {
    const normalized = token.replace(/\\/g, sep);
    if (!isAbsolute(normalized)) return false;
    const path = resolve(normalized);
    const rel = relative(directory, path);
    return (rel === "server.py" || rel === "chat_server.py"
      || rel.endsWith(`${sep}server.py`) || rel.endsWith(`${sep}chat_server.py`))
      && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  });
}

function serviceUsesRoot(root: string, command: readonly string[]): boolean {
  if (!command.some(token => /(?:^|[/\\])pkm-service-entry\.js$/.test(token))) return false;
  for (const token of command) {
    if (Buffer.byteLength(token) > 65_536 || !token.startsWith("{")) continue;
    try {
      const value = JSON.parse(token);
      if (typeof value?.knowledgeRoot === "string" && resolve(value.knowledgeRoot) === root) return true;
    } catch { /* Other command arguments are not service identity records. */ }
  }
  return false;
}

function subscriptionGatewayUsesRoot(root: string, command: readonly string[]): boolean {
  return command.some(token => /(?:^|[/\\])subscription-gateway\.js$/.test(token))
    && command.some(token => isWithinRoot(root, token) && /(?:^|[/\\])gateway-state\.json$/.test(token));
}

async function hasWritableRootDescriptor(pid: number, root: string): Promise<boolean> {
  const directory = join(procRoot, String(pid), "fd");
  let descriptors: string[];
  try { descriptors = await readdir(directory); }
  catch (error) {
    if (processGone(error)) return false;
    throw error;
  }
  if (descriptors.length > maximumDescriptorsPerProcess)
    throw new CoreError("LEGACY_WRITER_INVENTORY_UNAVAILABLE", `Cannot bound file-descriptor inventory for process ${pid}.`);
  for (const descriptor of descriptors) {
    const file = join(directory, descriptor);
    let target: string;
    try { target = await readlink(file); }
    catch (error) { if (processGone(error)) continue; throw error; }
    if (!isWithinRoot(root, target)) continue;
    let info: string;
    try { info = await readFile(join(procRoot, String(pid), "fdinfo", descriptor), "utf8"); }
    catch (error) { if (processGone(error)) return false; throw error; }
    const flags = /^flags:\s+([0-7]+)/m.exec(info);
    if (!flags) throw new CoreError("LEGACY_WRITER_INVENTORY_UNAVAILABLE", `Cannot verify a writable descriptor for process ${pid}.`);
    const access = Number.parseInt(flags[1]!, 8) & openAccessModeMask;
    if (access !== constants.O_RDONLY) return true;
  }
  return false;
}

async function workingDirectoryIsRooted(pid: number, root: string): Promise<boolean> {
  try { return isWithinRoot(root, await readlink(join(procRoot, String(pid), "cwd"))); }
  catch (error) { if (processGone(error)) return false; throw error; }
}

export function isLinuxVscodeUtilityPotentialExtensionHost(command: readonly string[]): boolean {
  const commandText = command.join(" ");
  return commandText.includes("--type=utility")
    && commandText.includes("--utility-sub-type=node.mojom.NodeService")
    && commandText.includes("--standard-schemes=vscode-webview");
}

function extensionHost(record: ProcessRecord): boolean {
  return isLinuxVscodeUtilityPotentialExtensionHost(record.command)
    || record.command.some(token => /(?:^|\s)--type=extensionhost(?:\s|$)/i.test(token))
    || record.command.some(token => /(?:^|\s)--type[^ ]*\s*extensionhost(?:\s|$)/i.test(token));
}

function vscodeHostProcess(record: ProcessRecord): boolean {
  return extensionHost(record) || record.command.some(token =>
    token.includes("--standard-schemes=") && token.includes("vscode-webview"));
}

export async function inspectLinuxLegacyWriterQuiescence(root: string, managedHost?: LinuxManagedSnapshotHostPermit): Promise<LinuxLegacyWriterQuiescenceReport> {
  if (process.platform !== "linux" || process.getuid === undefined)
    throw new CoreError("LEGACY_WRITER_INVENTORY_UNAVAILABLE", "Legacy writer process inventory is only qualified on Linux.");
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== resolve(root) || !(await stat(canonicalRoot)).isDirectory())
    throw new CoreError("INVALID_WORKSPACE", "Legacy writer inventory requires a canonical real Knowledge Root.");
  const currentUser = process.getuid();
  const binding = managedHost && permits.get(managedHost);
  if (managedHost && (!binding || binding.root !== canonicalRoot))
    throw new CoreError("LEGACY_WRITER_INVENTORY_UNAVAILABLE", "Managed snapshot host permit is invalid.");
  binding?.check();
  let entries: string[];
  try { entries = await readdir(procRoot); }
  catch { throw new CoreError("LEGACY_WRITER_INVENTORY_UNAVAILABLE", "Linux process inventory is unavailable."); }
  const pids = entries.filter(entry => /^\d+$/.test(entry)).map(Number);
  if (pids.length > maximumProcesses)
    throw new CoreError("LEGACY_WRITER_INVENTORY_UNAVAILABLE", "Linux process inventory exceeds its bounded process limit.");
  const processes = (await Promise.all(pids.map(pid => processRecord(pid, currentUser))))
    .filter((record): record is ProcessRecord => !!record && record.state !== "Z");
  const allowedExtensionHostPids: number[] = [];
  const blockers: LinuxLegacyWriterProcess[] = [];
  for (const processRecord of processes) {
    const base = {
      pid: processRecord.pid, parentPid: processRecord.parentPid,
      startTimeTicks: processRecord.startTimeTicks,
    };
    if (processRecord.startTimeTicks === "unknown") {
      blockers.push({ ...base, kind: "uninspectable" });
      continue;
    }
    if (processRecord.pid === process.pid && binding) {
      binding.check();
      allowedExtensionHostPids.push(processRecord.pid);
      continue;
    }
    if (vscodeHostProcess(processRecord) && (!binding || extensionHost(processRecord))) {
      blockers.push({ ...base, kind: extensionHost(processRecord) ? "vscode-extension-host" : "vscode-host-process" });
      continue;
    }
    if (legacyMcpPath(canonicalRoot, processRecord.command)) {
      blockers.push({ ...base, kind: "legacy-mcp" });
      continue;
    }
    if (serviceUsesRoot(canonicalRoot, processRecord.command)
      || subscriptionGatewayUsesRoot(canonicalRoot, processRecord.command)) {
      blockers.push({ ...base, kind: "pkm-service" });
      continue;
    }
    if (processRecord.pid === process.pid) continue;
    try {
      if (await workingDirectoryIsRooted(processRecord.pid, canonicalRoot)) {
        blockers.push({ ...base, kind: "root-working-directory" });
        continue;
      }
      if (await hasWritableRootDescriptor(processRecord.pid, canonicalRoot))
        blockers.push({ ...base, kind: "writable-root-handle" });
    } catch {
      blockers.push({ ...base, kind: "uninspectable" });
    }
  }
  binding?.check();
  if (binding && !allowedExtensionHostPids.includes(process.pid))
    throw new CoreError("LEGACY_WRITER_INVENTORY_UNAVAILABLE", "The admitted VS Code extension host is not inspectable.");
  return {
    schema: "pkm.linux-legacy-writer-quiescence/v1",
    root: canonicalRoot,
    scannedAt: new Date().toISOString(),
    ownerPid: process.pid,
    allowedExtensionHostPids,
    blockers: blockers.sort((left, right) => left.pid - right.pid || left.kind.localeCompare(right.kind)),
  };
}

export async function assertLinuxLegacyWritersQuiescent(root: string, managedHost?: LinuxManagedSnapshotHostPermit): Promise<LinuxLegacyWriterQuiescenceReport> {
  const report = await inspectLinuxLegacyWriterQuiescence(root, managedHost);
  if (report.blockers.length) {
    const summary = report.blockers.map(blocker => `${blocker.kind}:${blocker.pid}`).join(", ");
    throw new CoreError("LEGACY_WRITERS_ACTIVE",
      `Legacy writers or unverified VS Code hosts are still present (${summary}). Close/drain those hosts and retry; no process was terminated.`);
  }
  return report;
}
