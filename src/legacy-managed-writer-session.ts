import { createHash } from "node:crypto";
import {
  constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const schema = "pkm.managed-writer-session/v1";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const basePath = ".pkm/state/managed-writer-session";
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export interface LegacyManagedWriterSessionEntity {
  path: string;
  kind: "file" | "directory";
  sha256?: string;
  size: number;
  mode: number;
  device: string;
  inode: string;
  mtimeNs: string;
  ctimeNs: string;
}

export interface LegacyManagedWriterSession {
  schema: "pkm.legacy-managed-writer-session/v1";
  sessionId: string;
  sourceFingerprint: string;
  files: LegacyManagedWriterSessionEntity[];
  retrieval?: { completedRequests: number; completedBuilds?: number; workerDrain: "unknown" };
}

function unsupported(path: string, message: string): never {
  throw Object.assign(new Error(message), { code: "PKM_STATE_UNSUPPORTED", path });
}

function privateOwned(stat: { mode: bigint; uid: bigint }, path: string): void {
  if ((stat.mode & 0o7000n) !== 0n || (stat.mode & 0o077n) !== 0n
    || process.getuid && stat.uid !== BigInt(process.getuid())) {
    unsupported(path, "Managed writer session records and directories must remain private and owned by the current user.");
  }
}

function directory(root: string, relative: string, files: LegacyManagedWriterSessionEntity[]): string[] {
  const full = join(root, relative), before = lstatSync(full, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink())
    unsupported(relative, "Managed writer session state must use real directories.");
  privateOwned(before, relative);
  const names = readdirSync(full).sort();
  const after = lstatSync(full, { bigint: true });
  if (after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode
    || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
    unsupported(relative, "Managed writer session changed while being inspected.");
  }
  files.push({ path: relative, kind: "directory", size: Number(before.size), mode: Number(before.mode & 0o777n),
    device: before.dev.toString(), inode: before.ino.toString(), mtimeNs: before.mtimeNs.toString(), ctimeNs: before.ctimeNs.toString() });
  return names;
}

function regular(root: string, relative: string, files: LegacyManagedWriterSessionEntity[]): Buffer {
  const full = join(root, relative), before = lstatSync(full, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 4096n)
    unsupported(relative, "Managed writer session records must be bounded, unlinked regular files.");
  privateOwned(before, relative);
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1n)
      unsupported(relative, "Managed writer session record identity changed while opening.");
    const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true }), current = lstatSync(full, { bigint: true });
    if (bytes.length !== Number(before.size) || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
      || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
      || current.size !== before.size || current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs) {
      unsupported(relative, "Managed writer session record changed while reading.");
    }
    files.push({ path: relative, kind: "file", sha256: sha256(bytes), size: bytes.length,
      mode: Number(before.mode & 0o777n), device: before.dev.toString(), inode: before.ino.toString(),
      mtimeNs: before.mtimeNs.toString(), ctimeNs: before.ctimeNs.toString() });
    return bytes;
  } finally { closeSync(fd); }
}

function record(root: string, relative: string, files: LegacyManagedWriterSessionEntity[]): Record<string, any> {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(regular(root, relative, files)));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not a record");
    return value as Record<string, any>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "PKM_STATE_UNSUPPORTED") throw error;
    return unsupported(relative, "Managed writer session record is not valid bounded UTF-8 JSON.");
  }
}

interface ProfileProcess {
  pid: number;
  pidNamespace: string;
  bootId: string;
  startTicks: string;
}

function stoppedProfile(processIdentity: ProfileProcess): boolean {
  if (!Number.isSafeInteger(processIdentity.pid) || processIdentity.pid <= 0
    || !uuid.test(processIdentity.bootId) || !/^pid:\[\d+\]$/.test(processIdentity.pidNamespace)
    || !/^\d+$/.test(processIdentity.startTicks)) return false;
  try {
    if (readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== processIdentity.bootId
      || readlinkSync("/proc/self/ns/pid") !== processIdentity.pidNamespace) return false;
    const stat = (pid: number) => {
      const value = readFileSync(`/proc/${pid}/stat`, "utf8"), close = value.lastIndexOf(")");
      const fields = value.slice(close + 2).trim().split(/\s+/);
      return close < 0 ? undefined : { state: fields[0], startTicks: fields[19] };
    };
    const current = stat(processIdentity.pid);
    if (current && (current.state === "Z" || current.state === "X" || current.startTicks !== processIdentity.startTicks)) return true;
    try { process.kill(processIdentity.pid, 0); return false; }
    catch (error) { return error instanceof Error && "code" in error && error.code === "ESRCH"; }
  } catch { return false; }
}

function validateOperationSet(
  root: string, relative: string, expectedSessionId: string, files: LegacyManagedWriterSessionEntity[],
  completedProfiles: Map<string, Record<string, any>>,
): { requests: number; builds: number } {
  const names = directory(root, relative, files), ids = new Set<string>();
  let retrievalRequests = 0, retrievalBuilds = 0;
  for (const name of names) {
    const match = /^([a-f0-9-]{36})\.(pending|complete)$/.exec(name);
    if (!match || !uuid.test(match[1])) unsupported(`${relative}/${name}`, "Managed writer operation entry is unknown.");
    ids.add(match[1]);
  }
  if (ids.size > 10_000) unsupported(relative, "Managed writer session operation history exceeds its bounded limit.");
  for (const id of ids) {
    const values: Record<string, any> = {};
    for (const phase of ["pending", "complete"] as const) {
      const name = `${relative}/${id}.${phase}`;
      if (!names.includes(`${id}.${phase}`)) continue;
      const value = record(root, name, files);
      if (value.schema !== schema || value.sessionId !== expectedSessionId || value.operationId !== id
        || value.phase !== phase || !["github-sync", "sync-service", "mcp-server", "mcp-existing", "profile-host", "retrieval-request", "retrieval-build"].includes(value.kind))
        unsupported(name, "Managed writer operation identity or phase is invalid.");
      const expectedKeys = value.kind === "profile-host"
        ? ["schema", "sessionId", "operationId", "profileId", "process", ...(value.protocol ? ["protocol"] : []), "kind", "phase"]
        : ["schema", "sessionId", "operationId", "kind", ...(value.kind === "mcp-server" ? ["launchId"] : []),
          ...(value.kind === "mcp-existing" ? ["generation", "instanceId", "runtimeBuild"] : []),
          ...(value.kind === "retrieval-build" ? ["revisionHash", "workerHash"] : []), "phase"];
      if (Object.keys(value).sort().join("\0") !== expectedKeys.sort().join("\0"))
        unsupported(name, "Managed writer operation contains unsupported fields.");
      if (value.kind === "mcp-server" && !uuid.test(value.launchId))
        unsupported(name, "Managed MCP launch identity is invalid.");
      if (value.kind === "retrieval-build" && (!digest.test(value.revisionHash) || !digest.test(value.workerHash)))
        unsupported(name, "Managed retrieval build identity is invalid.");
      if (value.kind === "mcp-existing" && (!uuid.test(value.generation) || !/^[a-f0-9]{32}$/.test(value.instanceId)
        || !digest.test(value.runtimeBuild)))
        unsupported(name, "Existing MCP identity is invalid.");
      if (value.kind === "profile-host" && (!digest.test(value.profileId)
        || !value.process || typeof value.process !== "object" || Array.isArray(value.process)
        || Object.keys(value.process).sort().join("\0") !== ["bootId", "pid", "pidNamespace", "startTicks"].sort().join("\0")
        || !Number.isSafeInteger(value.process.pid) || value.process.pid <= 0
        || !uuid.test(value.process.bootId) || !/^pid:\[\d+\]$/.test(value.process.pidNamespace)
        || !/^\d+$/.test(value.process.startTicks)
        || value.protocol !== undefined && value.protocol !== "pkm-managed-profile-successor/v1"))
        unsupported(name, "Managed profile identity is invalid.");
      values[phase] = value;
    }
    const pending = values.pending, complete = values.complete;
    if (!pending) unsupported(`${relative}/${id}.pending`, "Managed writer completion has no matching pending operation.");
    if (!complete) {
      if (pending.kind !== "profile-host" || !stoppedProfile(pending.process))
        unsupported(`${relative}/${id}.pending`, "Managed writer operation is active or has an unknown outcome.");
      continue;
    }
    if (pending.kind !== complete.kind || pending.launchId !== complete.launchId
      || pending.profileId !== complete.profileId || pending.protocol !== complete.protocol
      || JSON.stringify(pending.process) !== JSON.stringify(complete.process)
      || pending.generation !== complete.generation || pending.instanceId !== complete.instanceId || pending.runtimeBuild !== complete.runtimeBuild
      || pending.revisionHash !== complete.revisionHash || pending.workerHash !== complete.workerHash)
      unsupported(`${relative}/${id}.complete`, "Managed writer completion does not match its pending operation.");
    if (pending.kind === "retrieval-request") retrievalRequests++;
    if (pending.kind === "retrieval-build") retrievalBuilds++;
    if (pending.kind === "profile-host") completedProfiles.set(`${expectedSessionId}:${id}`, pending);
  }
  return { requests: retrievalRequests, builds: retrievalBuilds };
}

function validateConfirmation(
  root: string, name: string, operationId: string, files: LegacyManagedWriterSessionEntity[],
  completedProfiles: Map<string, Record<string, any>>,
): void {
  const relative = `${basePath}/${name}`, value = record(root, relative, files);
  const expectedKeys = ["schema", "sessionId", "operationId", "profileId", "process", "root", "profile",
    ...(value.protocol !== undefined ? ["protocol"] : [])];
  if (Object.keys(value).sort().join("\0") !== expectedKeys.sort().join("\0")
    || value.schema !== "pkm.managed-profile-confirmation/v1" || value.operationId !== operationId
    || typeof value.sessionId !== "string" || !uuid.test(value.sessionId))
    unsupported(relative, "Managed profile confirmation identity is invalid.");
  const pending = completedProfiles.get(`${value.sessionId}:${operationId}`);
  if (!pending || value.profileId !== pending.profileId || value.protocol !== pending.protocol
    || !isDeepStrictEqual(value.process, pending.process))
    unsupported(relative, "Managed profile confirmation has no matching completed registration.");
  const verifyPin = (pin: any, expectedPath?: string) => {
    if (!pin || typeof pin !== "object" || Array.isArray(pin)
      || Object.keys(pin).sort().join("\0") !== ["path", "device", "inode"].sort().join("\0")
      || typeof pin.path !== "string" || !isAbsolute(pin.path)
      || typeof pin.device !== "string" || !/^\d+$/.test(pin.device)
      || typeof pin.inode !== "string" || !/^\d+$/.test(pin.inode)
      || expectedPath !== undefined && pin.path !== expectedPath)
      unsupported(relative, "Managed profile confirmation directory binding is invalid.");
    try {
      const stat = lstatSync(pin.path, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(pin.path) !== pin.path
        || stat.dev.toString() !== pin.device || stat.ino.toString() !== pin.inode)
        unsupported(relative, "Managed profile confirmation directory identity changed.");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "PKM_STATE_UNSUPPORTED") throw error;
      unsupported(relative, "Managed profile confirmation directory is unavailable.");
    }
  };
  verifyPin(value.root, root);
  verifyPin(value.profile);
}

export function inspectLegacyManagedWriterSession(root: string): LegacyManagedWriterSession {
  if (process.platform !== "linux") unsupported(basePath, "Managed writer session adoption is supported only on Linux.");
  const parent = join(root, ".pkm/state");
  if (lstatSync(join(parent, "managed-writer-session-compatible"), { throwIfNoEntry: false }))
    unsupported(".pkm/state/managed-writer-session-compatible", "Compatible managed writer session has no Next adoption receipt.");
  if (lstatSync(join(parent, "managed-writer-session.lock"), { throwIfNoEntry: false }))
    unsupported(`${basePath}.lock`, "Managed writer admission is active or its lock outcome is unknown.");
  const files: LegacyManagedWriterSessionEntity[] = [];
  const sessionNames = directory(root, basePath, files);
  const allowed = new Set(["session.json", "fenced", "operations"]);
  const rotations = new Map<string, string>();
  const archives = new Set<string>();
  const confirmations = new Map<string, string>();
  for (const name of sessionNames) {
    const rotation = /^rotation\.([a-f0-9-]{36})\.json$/.exec(name);
    const archive = /^operations\.([a-f0-9-]{36})$/.exec(name);
    const confirmation = /^confirmed\.([a-f0-9-]{36})\.json$/.exec(name);
    if (rotation && uuid.test(rotation[1])) rotations.set(rotation[1], name);
    else if (archive && uuid.test(archive[1])) archives.add(archive[1]);
    else if (confirmation && uuid.test(confirmation[1])) confirmations.set(confirmation[1], name);
    else if (!allowed.has(name)) unsupported(`${basePath}/${name}`, "Managed writer session contains unknown or incomplete state.");
  }
  if (!rotations.size || rotations.size !== archives.size)
    unsupported(basePath, "Managed writer session must have a complete durable rotation history before adoption.");
  const current = record(root, `${basePath}/session.json`, files);
  if (Object.keys(current).sort().join("\0") !== ["schema", "id"].sort().join("\0")
    || current.schema !== schema || !uuid.test(current.id))
    unsupported(`${basePath}/session.json`, "Managed writer session identity is invalid.");
  const fenced = record(root, `${basePath}/fenced`, files);
  if (Object.keys(fenced).sort().join("\0") !== ["schema", "sessionId"].sort().join("\0")
    || fenced.schema !== schema || fenced.sessionId !== current.id)
    unsupported(`${basePath}/fenced`, "Managed writer session admission must remain durably fenced.");
  const nextByPrevious = new Map<string, string>(), previousIds = new Set<string>(), nextIds = new Set<string>();
  for (const [previous, name] of rotations) {
    const value = record(root, `${basePath}/${name}`, files);
    if (Object.keys(value).sort().join("\0") !== ["schema", "previousSessionId", "nextSessionId"].sort().join("\0")
      || value.schema !== schema || value.previousSessionId !== previous || !uuid.test(value.nextSessionId)
      || value.nextSessionId === previous || !archives.has(previous) || nextIds.has(value.nextSessionId))
      unsupported(`${basePath}/${name}`, "Managed writer rotation chain is invalid.");
    nextByPrevious.set(previous, value.nextSessionId);
    previousIds.add(previous);
    nextIds.add(value.nextSessionId);
  }
  const starts = [...previousIds].filter(id => !nextIds.has(id));
  if (starts.length !== 1) unsupported(basePath, "Managed writer rotation chain is branched or cyclic.");
  let id = starts[0]!, traversed = 0;
  while (id !== current.id && traversed < rotations.size) {
    const next = nextByPrevious.get(id);
    if (!next) break;
    id = next;
    traversed++;
  }
  if (id !== current.id || traversed !== rotations.size)
    unsupported(basePath, "Managed writer rotation chain does not end at the fenced current session.");
  let retrievalRequests = 0, retrievalBuilds = 0;
  const completedProfiles = new Map<string, Record<string, any>>();
  for (const previous of archives) {
    const archivePath = `${basePath}/operations.${previous}`;
    const result = validateOperationSet(root, archivePath, previous, files, completedProfiles);
    retrievalRequests += result.requests;
    retrievalBuilds += result.builds;
  }
  const currentOperations = validateOperationSet(root, `${basePath}/operations`, current.id, files, completedProfiles);
  retrievalRequests += currentOperations.requests;
  retrievalBuilds += currentOperations.builds;
  for (const [operationId, name] of confirmations)
    validateConfirmation(root, name, operationId, files, completedProfiles);
  const stateRootNames = readdirSync(parent);
  const unexpectedLock = stateRootNames.find(name => name === "managed-writer-session.lock"
    || /^managed-writer-session\.[a-f0-9-]+\.entry$/.test(name));
  if (unexpectedLock) unsupported(`.pkm/state/${unexpectedLock}`, "Managed writer admission lock state is incomplete.");
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (files.length > 20_000) unsupported(basePath, "Managed writer session inventory exceeds its bounded limit.");
  const sourceFingerprint = sha256(JSON.stringify(files));
  return { schema: "pkm.legacy-managed-writer-session/v1", sessionId: current.id, sourceFingerprint, files,
    ...(retrievalRequests || retrievalBuilds ? { retrieval: { completedRequests: retrievalRequests,
      ...(retrievalBuilds ? { completedBuilds: retrievalBuilds } : {}), workerDrain: "unknown" as const } } : {}) };
}
