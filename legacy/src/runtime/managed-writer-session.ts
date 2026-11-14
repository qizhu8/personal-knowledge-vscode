import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { AsyncLocalStorage } from "async_hooks";
import { spawn } from "child_process";
import { withLegacyLinuxRootWriter, withLegacyLinuxRootWriterAsync } from "./linux-root-writer-fence";
import { HostWriterAdmission } from "./host-writer-admission";
import {
  assertLinuxEnvironmentDrainProof, assertPreparedLinuxEnvironmentDrainProof,
  describePreparedLinuxEnvironmentPins, describePreparedLinuxEnvironmentQuery,
  type LinuxEnvironmentDrainBinding, type LinuxEnvironmentDrainProof, type PreparedLinuxEnvironmentQuery,
} from "./linux-environment-supervisor";
import {
  assertOrdinaryEnvironmentRefreshCompletion, type OrdinaryEnvironmentRefreshCompletion,
} from "./ordinary-environment-owner";

const schema = "pkm.managed-writer-session/v1";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const legacyBase = (root: string) => path.join(root, ".pkm", "state", "managed-writer-session");
const compatibleBase = (root: string) => path.join(root, ".pkm", "state", "managed-writer-session-compatible");
const base = (root: string) => {
  const legacy = legacyBase(root), compatible = compatibleBase(root);
  if (present(legacy) && present(compatible)) throw new Error("Multiple managed writer sessions require recovery.");
  return present(compatible) ? compatible : legacy;
};
const lock = (root: string) => path.join(root, ".pkm", "state", "managed-writer-session.lock");
const environmentCompletionLock = new AsyncLocalStorage<{
  root: string; sessionId: string; nonce: string; identity: fs.Stats; record: string; open: boolean;
}>();
const held = <T>(root: string, action: (nonce: string) => T, purpose = "operation"): T => {
  const filename = lock(root), nonce = randomUUID(), staging = `${filename}.${nonce}.entry`;
  const record = { pid: process.pid, nonce, acquiredAt: Date.now(), owner: "Managed writer admission", purpose,
    ...(process.platform === "linux" ? { process: profileProcess() } : {}) };
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  write(staging, record);
  let owned = false;
  let identity: fs.Stats | undefined;
  try {
    const deadline = Date.now() + 2000;
    for (;;) {
      try {
        fs.linkSync(staging, filename);
        identity = fs.lstatSync(filename);
        owned = true;
        fs.unlinkSync(staging);
        syncDirectory(path.dirname(filename));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || owned) throw error;
      }
      try {
        const stat = fs.lstatSync(filename);
        if (stat.isSymbolicLink()) throw new Error("Managed writer admission lock is a symbolic link; recovery required.");
        let ownerFile = filename;
        if (stat.isDirectory()) {
          const entries = fs.readdirSync(filename);
          if (!entries.length) {
            if (Date.now() >= deadline) throw new Error("Managed writer admission: empty lock ownership is unknown; explicit recovery required.");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            continue;
          }
          if (entries.length !== 1 || !/^[a-f0-9-]{36}\.json$/.test(entries[0]))
            throw new Error("Managed writer admission lock is invalid; recovery required.");
          ownerFile = path.join(filename, entries[0]);
        } else if (!stat.isFile()) throw new Error("Managed writer admission lock is invalid; recovery required.");
        const owner = read(ownerFile);
        if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || !uuid.test(owner.nonce))
          throw new Error("Managed writer admission lock owner is invalid; recovery required.");
        if (ownerFile === filename && owner.purpose === "bootstrap" && owner.process?.pid === owner.pid
          && /^\d+$/.test(owner.process.startTicks) && profileStopped(owner)) {
          recoverBootstrapLock(root, owner);
          continue;
        }
        try { process.kill(owner.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH")
            throw new Error("Managed writer admission: abandoned lock ownership is unknown; explicit recovery required.");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (Date.now() >= deadline) throw new Error("Managed writer admission lock timed out; ownership is unknown.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    return action(nonce);
  } finally {
    try { fs.unlinkSync(staging); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (owned) {
      const current = fs.lstatSync(filename);
      if (!identity || !current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev
        || current.ino !== identity.ino || current.nlink !== 1 || JSON.stringify(read(filename)) !== JSON.stringify(record))
        throw new Error("Managed writer admission lock changed; preserve it for recovery.");
      fs.unlinkSync(filename);
      syncDirectory(path.dirname(filename));
    }
  }
};
export class ManagedWriterAdmissionDenied extends Error {}
const active = new AsyncLocalStorage<{ root: string; sessionId: string; operationId: string; open: boolean }>();
export type ManagedWriterKind = "github-sync" | "sync-service" | "mcp-server" | "retrieval-request";
export interface ManagedWriterRegistration { sessionId: string; operationId: string; kind: ManagedWriterKind; launchId?: string; }
export interface ManagedEnvironmentRefreshRegistration { readonly kind: "pkm.managed-environment-refresh/v1"; }
const environmentRegistrations = new WeakMap<ManagedEnvironmentRefreshRegistration, {
  root: string; sessionId: string; operationId: string; prepared: PreparedLinuxEnvironmentQuery;
  binding: LinuxEnvironmentDrainBinding; rootPin: string; profilePin: string;
}>();
const registeredEnvironmentQueries = new WeakSet<PreparedLinuxEnvironmentQuery>();
const completingEnvironmentRegistrations = new WeakSet<ManagedEnvironmentRefreshRegistration>();
interface ProfileProcess { pid: number; pidNamespace: string; bootId: string; startTicks: string; }
export interface ManagedProfileRegistration {
  sessionId: string; operationId: string; profileId: string; process: ProfileProcess; protocol?: string;
}
const issuedProfiles = new WeakMap<ManagedProfileRegistration, { record: string; root: string; rootPin: string }>();
const profileHostAdmissions = new WeakMap<ManagedProfileRegistration, HostWriterAdmission>();
function rememberProfile<T extends ManagedProfileRegistration>(registration: T, root: string): T {
  issuedProfiles.set(registration, { record: JSON.stringify(registration), root,
    rootPin: JSON.stringify(managedDirectoryPin(root)) });
  return registration;
}

function assertIssuedProfile(root: string, registration: ManagedProfileRegistration): void {
  const issued = issuedProfiles.get(registration);
  if (!issued || issued.root !== root || issued.record !== JSON.stringify(registration)
    || issued.rootPin !== JSON.stringify(managedDirectoryPin(root))
    || JSON.stringify(profileProcess()) !== JSON.stringify(registration.process))
    throw new Error("An unchanged, locally issued managed profile registration is required.");
}

function assertBoundProfileDrained(root: string, registration: ManagedProfileRegistration, required = false): void {
  const admission = profileHostAdmissions.get(registration);
  if (required && !admission) throw new Error("A bound managed host admission is required for confirmation.");
  admission?.assertDrainedRoot(root);
}
export const MANAGED_PROFILE_SUCCESSOR_PROTOCOL = "pkm-managed-profile-successor/v1";

function profileProcess(): ProfileProcess {
  const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const pidNamespace = fs.readlinkSync("/proc/self/ns/pid");
  const stat = processStat("/proc/self/stat");
  if (!uuid.test(bootId) || !/^pid:\[\d+\]$/.test(pidNamespace) || !stat)
    throw new Error("Linux profile process identity is unavailable.");
  return { pid: process.pid, pidNamespace, bootId, startTicks: stat.startTicks };
}
function processStat(filename: string): { state: string; startTicks: string } | undefined {
  try {
    const text = fs.readFileSync(filename, "utf8"), close = text.lastIndexOf(")");
    const fields = text.slice(close + 2).trim().split(/\s+/);
    if (close < 0 || !/^[A-Z]$/.test(fields[0]) || !/^\d+$/.test(fields[19])) return undefined;
    return { state: fields[0], startTicks: fields[19] };
  } catch { return undefined; }
}
function profileStopped(value: any): boolean {
  const identity = value?.process;
  if (identity === undefined) return false;
  if (!Number.isSafeInteger(identity?.pid) || identity.pid <= 0
    || !uuid.test(identity?.bootId) || !/^pid:\[\d+\]$/.test(identity?.pidNamespace)
    || identity.startTicks !== undefined && !/^\d+$/.test(identity.startTicks))
    throw new Error("Managed profile process identity is invalid.");
  let local: ProfileProcess;
  try { local = profileProcess(); } catch { return false; }
  if (identity.bootId !== local.bootId || identity.pidNamespace !== local.pidNamespace) return false;
  const stat = processStat(`/proc/${identity.pid}/stat`);
  if (stat && (stat.state === "Z" || stat.state === "X"
    || identity.startTicks !== undefined && stat.startTicks !== identity.startTicks)) return true;
  try { process.kill(identity.pid, 0); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    return false;
  }
}

export function currentManagedWriterRoot(): string | undefined {
  const context = active.getStore();
  if (context && !context.open) throw new Error("Managed writer operation context is no longer valid.");
  return context?.root;
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function present(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function write(file: string, record: object): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}
function read(file: string): any {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) throw new Error("Invalid managed writer record.");
    const result = JSON.parse(fs.readFileSync(fd, "utf8"));
    fs.fsyncSync(fd);
    return result;
  } finally { fs.closeSync(fd); }
}

function recoverBootstrapLock(root: string, observed: any): void {
  const parent = path.dirname(base(root)), filename = lock(root);
  const directory = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const nonce = randomUUID();
  const script = `process.stdout.write(process.argv[1]);process.stdin.once("end",()=>process.exit(0));process.stdin.resume()`;
  const child = spawn("flock", ["-x", "-w", "2", "3", process.execPath, "-e", script, nonce],
    { stdio: ["pipe", "pipe", "ignore", directory] });
  fs.closeSync(directory);
  child.on("error", () => {});
  child.stdin?.on("error", () => {});
  try {
    const fd = (child.stdout as unknown as { _handle?: { fd?: number } })?._handle?.fd;
    if (fd === undefined || !child.pid) throw new Error("Bootstrap recovery lock is unavailable.");
    const result = Buffer.alloc(Buffer.byteLength(nonce)), deadline = Date.now() + 3000;
    let count = 0;
    while (count < result.length && Date.now() < deadline) {
      try {
        const n = fs.readSync(fd, result, count, result.length - count, null);
        if (!n) throw new Error("Bootstrap recovery lock closed.");
        count += n;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    if (result.toString("utf8") !== nonce) throw new Error("Bootstrap recovery lock timed out.");
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || JSON.stringify(read(filename)) !== JSON.stringify(observed)
      || observed.purpose !== "bootstrap" || observed.process?.pid !== observed.pid || !profileStopped(observed))
      throw new Error("Bootstrap lock changed during recovery.");
    const staged = path.join(parent, `managed-writer-session-init.${observed.nonce}`);
    const current = base(root);
    if (present(staged) && present(current)) throw new Error("Ambiguous bootstrap state requires recovery.");
    if (present(current)) {
      const { dir, id } = session(root);
      for (const name of fs.readdirSync(path.join(dir, "operations"))) {
        const match = /^([a-f0-9-]{36})\.(pending|complete)$/.exec(name);
        if (!match || !uuid.test(match[1])) throw new Error("Invalid operation during bootstrap recovery.");
        const value = read(path.join(dir, "operations", name));
        if (value?.schema !== schema || value.sessionId !== id || value.operationId !== match[1]
          || value.phase !== match[2] || typeof value.kind !== "string")
          throw new Error("Incomplete operation during bootstrap recovery.");
      }
    }
    const archive = path.join(parent, "managed-writer-session-recovery");
    try { fs.mkdirSync(archive, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const archiveStat = fs.lstatSync(archive);
    if (!archiveStat.isDirectory() || archiveStat.isSymbolicLink()
      || (process.getuid && archiveStat.uid !== process.getuid()) || (archiveStat.mode & 0o077))
      throw new Error("Bootstrap recovery archive is unsafe.");
    const entry = path.join(archive, observed.nonce);
    try { fs.mkdirSync(entry, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const entryDir = fs.lstatSync(entry);
    if (!entryDir.isDirectory() || entryDir.isSymbolicLink()
      || (process.getuid && entryDir.uid !== process.getuid()) || (entryDir.mode & 0o077))
      throw new Error("Bootstrap recovery entry is unsafe.");
    const archived = fs.readdirSync(entry);
    if (archived.some(name => name !== "staging" && name !== "lock-entry"))
      throw new Error("Bootstrap recovery entry has unknown contents.");
    if (archived.includes("staging")) {
      const archiveStage = fs.lstatSync(path.join(entry, "staging"));
      if (!archiveStage.isDirectory() || archiveStage.isSymbolicLink() || present(staged))
        throw new Error("Bootstrap recovery staging is ambiguous.");
    }
    if (archived.includes("lock-entry")) {
      const archiveEntry = fs.lstatSync(path.join(entry, "lock-entry"));
      if (!archiveEntry.isFile() || archiveEntry.isSymbolicLink() || archiveEntry.dev !== stat.dev || archiveEntry.ino !== stat.ino)
        throw new Error("Bootstrap recovery entry identity changed.");
    }
    syncDirectory(archive);
    if (present(staged)) {
      const stageStat = fs.lstatSync(staged);
      if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) throw new Error("Bootstrap staging is unsafe.");
      fs.renameSync(staged, path.join(entry, "staging"));
    }
    const originalEntry = `${filename}.${observed.nonce}.entry`;
    if (present(originalEntry)) {
      if (archived.includes("lock-entry")) throw new Error("Bootstrap entry is duplicated.");
      const entryStat = fs.lstatSync(originalEntry);
      if (!entryStat.isFile() || entryStat.isSymbolicLink() || entryStat.dev !== stat.dev || entryStat.ino !== stat.ino)
        throw new Error("Bootstrap entry identity changed.");
      fs.renameSync(originalEntry, path.join(entry, "lock-entry"));
    }
    const recheck = fs.lstatSync(filename);
    if (recheck.dev !== stat.dev || recheck.ino !== stat.ino || JSON.stringify(read(filename)) !== JSON.stringify(observed))
      throw new Error("Bootstrap lock changed before recovery.");
    fs.renameSync(filename, path.join(entry, "lock"));
    syncDirectory(entry);
    syncDirectory(parent);
  } finally {
    child.stdin?.end();
  }
}

function preserveOrphanedBootstrapEntries(root: string): void {
  const parent = path.dirname(base(root));
  for (const name of fs.readdirSync(parent)) {
    const match = /^managed-writer-session\.lock\.([a-f0-9-]{36})\.entry$/.exec(name);
    if (!match || !uuid.test(match[1])) continue;
    const file = path.join(parent, name);
    let stat: fs.Stats, owner: any;
    try { stat = fs.lstatSync(file); owner = read(file); } catch { continue; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || owner?.nonce !== match[1]
      || owner.purpose !== "bootstrap" || owner.process?.pid !== owner.pid
      || !/^\d+$/.test(owner.process.startTicks) || !profileStopped(owner)) continue;
    const archive = path.join(parent, "managed-writer-session-recovery");
    try { fs.mkdirSync(archive, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const archiveStat = fs.lstatSync(archive);
    if (!archiveStat.isDirectory() || archiveStat.isSymbolicLink()
      || (process.getuid && archiveStat.uid !== process.getuid()) || (archiveStat.mode & 0o077))
      throw new Error("Bootstrap recovery archive is unsafe.");
    const entry = path.join(archive, match[1]);
    try { fs.mkdirSync(entry, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const entryStat = fs.lstatSync(entry);
    if (!entryStat.isDirectory() || entryStat.isSymbolicLink()
      || (process.getuid && entryStat.uid !== process.getuid()) || (entryStat.mode & 0o077)
      || fs.readdirSync(entry).length) throw new Error("Orphaned bootstrap recovery entry is unsafe.");
    const current = fs.lstatSync(file);
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== 1
      || JSON.stringify(read(file)) !== JSON.stringify(owner))
      throw new Error("Orphaned bootstrap entry changed.");
    fs.renameSync(file, path.join(entry, "lock-entry"));
    syncDirectory(entry);
    syncDirectory(archive);
    syncDirectory(parent);
  }
}
function assertNoPendingBootstrap(root: string): void {
  if (fs.readdirSync(path.dirname(base(root))).some(name => /^managed-writer-session-init\.[a-f0-9-]{36}$/.test(name)))
    throw new Error("Managed writer session initialization is incomplete; recovery is required.");
}
function session(root: string): { dir: string; id: string } {
  assertNoPendingBootstrap(root);
  const dir = base(root), stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Managed writer session is invalid.");
  const value = read(path.join(dir, "session.json"));
  if (value?.schema !== schema || !uuid.test(value.id)) throw new Error("Managed writer session is invalid.");
  const operations = fs.lstatSync(path.join(dir, "operations"));
  if (!operations.isDirectory() || operations.isSymbolicLink()) throw new Error("Managed writer operations are invalid.");
  syncDirectory(dir);
  return { dir, id: value.id };
}
function ready(root: string, expected: string): { dir: string; id: string } {
  const value = session(root);
  if (value.id !== expected) throw new Error("Managed writer session binding changed.");
  return value;
}
function assertDrained(dir: string, id: string): void {
  const operations = path.join(dir, "operations");
  const entries = fs.readdirSync(operations);
  const ids = new Set<string>();
  for (const entry of entries) {
    const match = /^([a-f0-9-]{36})\.(pending|complete)$/.exec(entry);
    if (!match || !uuid.test(match[1])) throw new Error("Managed writer operation is invalid.");
    ids.add(match[1]);
  }
  for (const operationId of ids) {
    let kind: string | undefined, launchId: string | undefined, profileId: string | undefined;
    let ownerProcess: string | undefined, protocol: string | undefined, buildIdentity: string | undefined, existingMcp: string | undefined;
    for (const phase of ["pending", "complete"]) {
      const file = path.join(operations, `${operationId}.${phase}`);
      if (!present(file)) {
        const pending = read(path.join(operations, `${operationId}.pending`));
        if (phase === "complete" && pending?.schema === schema && pending.sessionId === id
          && pending.operationId === operationId && pending.kind === "profile-host"
          && pending.phase === "pending" && /^[a-f0-9]{64}$/.test(pending.profileId) && profileStopped(pending)) continue;
        throw new Error("Managed writer operation is active or has an unknown outcome; recovery required.");
      }
      const value = read(file);
      if (value?.schema !== schema || value.sessionId !== id || value.operationId !== operationId
        || value.phase !== phase || typeof value.kind !== "string"
        || !["github-sync", "sync-service", "mcp-server", "mcp-existing", "retrieval-request", "retrieval-build", "profile-host"].includes(value.kind)) throw new Error("Managed writer operation is invalid.");
      if (kind && kind !== value.kind) throw new Error("Managed writer operation kind changed.");
      if (value.kind === "mcp-server" && !uuid.test(value.launchId)) throw new Error("Managed MCP launch identity is invalid.");
      if (value.kind === "profile-host" && (!/^[a-f0-9]{64}$/.test(value.profileId)
        || phase === "complete" && profileId !== value.profileId)) throw new Error("Managed profile identity is invalid.");
      if (value.kind === "profile-host" && phase === "complete" && ownerProcess !== JSON.stringify(value.process))
        throw new Error("Managed profile process identity changed.");
      if (value.kind === "profile-host" && phase === "complete" && protocol !== value.protocol)
        throw new Error("Managed profile protocol changed.");
      if (value.kind === "retrieval-build" && (!/^[a-f0-9]{64}$/.test(value.revisionHash)
        || !/^[a-f0-9]{64}$/.test(value.workerHash)
        || phase === "complete" && buildIdentity !== `${value.revisionHash}:${value.workerHash}`))
        throw new Error("Managed retrieval build identity changed.");
      if (value.kind === "mcp-existing" && (!uuid.test(value.generation) || !/^[a-f0-9]{32}$/.test(value.instanceId)
        || !/^[a-f0-9]{64}$/.test(value.runtimeBuild)
        || phase === "complete" && existingMcp !== `${value.generation}:${value.instanceId}:${value.runtimeBuild}`))
        throw new Error("Existing MCP identity changed.");
      if (phase === "complete" && launchId !== value.launchId) throw new Error("Managed writer launch identity changed.");
      kind = value.kind;
      launchId = value.launchId;
      profileId = value.profileId;
      ownerProcess = JSON.stringify(value.process);
      buildIdentity = `${value.revisionHash}:${value.workerHash}`;
      existingMcp = `${value.generation}:${value.instanceId}:${value.runtimeBuild}`;
      protocol = value.protocol;
    }
  }
  syncDirectory(operations);
}

/** Provision before launching participating clients. It cannot adopt an already running fleet. */
export function provisionManagedWriterSession(root: string, id: string): void {
  if (process.platform !== "linux" || !path.isAbsolute(root) || fs.realpathSync(root) !== root || !uuid.test(id))
    throw new Error("Managed writer session requires a real absolute Linux root and a valid ID.");
  withLegacyLinuxRootWriter(root, () => held(root, () => {
    const dir = base(root);
    fs.mkdirSync(dir, { mode: 0o700 });
    syncDirectory(path.dirname(dir));
    fs.mkdirSync(path.join(dir, "operations"), { mode: 0o700 });
    syncDirectory(dir);
    write(path.join(dir, "session.json"), { schema, id });
  }));
}

/** Record an activated, explicitly bound profile; this does not enumerate other profiles. */
export function registerManagedProfile(root: string, expected: string, profileId: string, automatic = false): ManagedProfileRegistration {
  if (!uuid.test(expected) || !/^[a-f0-9]{64}$/.test(profileId)) throw new Error("Invalid managed profile identity.");
  const registration = { sessionId: expected, operationId: randomUUID(), profileId, process: profileProcess(),
    ...(automatic ? { protocol: MANAGED_PROFILE_SUCCESSOR_PROTOCOL } : {}) };
  return withLegacyLinuxRootWriter(root, () => held(root, () => {
    const { dir } = ready(root, expected);
    if (present(path.join(dir, "fenced"))) throw new Error("Managed writer session is fenced; profile was not registered.");
    write(path.join(dir, "operations", `${registration.operationId}.pending`),
      { schema, ...registration, kind: "profile-host", phase: "pending" });
    return rememberProfile(registration, root);
  }));
}

/** Atomically bind an ordinary host to an existing accepting session, if present. */
export function enrollExistingManagedProfile(root: string, profileId: string, automatic = false): ManagedProfileRegistration | undefined {
  if (process.platform !== "linux" || !present(base(root))) return undefined;
  if (!path.isAbsolute(root) || fs.realpathSync(root) !== root || !/^[a-f0-9]{64}$/.test(profileId))
    throw new Error("Invalid managed profile identity or Knowledge Root.");
  return withLegacyLinuxRootWriter(root, () => held(root, () => {
    const { dir, id } = session(root);
    if (present(path.join(dir, "fenced")))
      throw new Error("Managed writer session is fenced; a new profile cannot join.");
    const registration = { sessionId: id, operationId: randomUUID(), profileId, process: profileProcess(),
      ...(automatic ? { protocol: MANAGED_PROFILE_SUCCESSOR_PROTOCOL } : {}) };
    write(path.join(dir, "operations", `${registration.operationId}.pending`),
      { schema, ...registration, kind: "profile-host", phase: "pending" });
    return rememberProfile(registration, root);
  }));
}

/** Bootstrap and enroll a managed fleet only after its existing clients can safely bind. */
export function bootstrapManagedProfile(root: string, profileId: string, automatic = false): {
  registration: ManagedProfileRegistration; created: boolean;
} {
  return bootstrapProfile(root, profileId, automatic, false);
}

/** Separate discovery namespace keeps older unbound launchers on their existing behavior. */
export function bootstrapCompatibleManagedProfile(root: string, profileId: string, automatic = false): {
  registration: ManagedProfileRegistration; created: boolean;
} {
  return bootstrapProfile(root, profileId, automatic, true);
}

function bootstrapProfile(root: string, profileId: string, automatic: boolean, compatible: boolean): {
  registration: ManagedProfileRegistration; created: boolean;
} {
  if (process.platform !== "linux" || !path.isAbsolute(root) || fs.realpathSync(root) !== root
    || !/^[a-f0-9]{64}$/.test(profileId)) throw new Error("Invalid managed profile identity or Knowledge Root.");
  return withLegacyLinuxRootWriter(root, () => held(root, nonce => {
    const existing = base(root);
    const dir = compatible && !present(existing) ? compatibleBase(root) : existing, parent = path.dirname(dir);
    preserveOrphanedBootstrapEntries(root);
    assertNoPendingBootstrap(root);
    let created = false;
    if (!present(dir)) {
      const staging = path.join(parent, `managed-writer-session-init.${nonce}`);
      fs.mkdirSync(staging, { mode: 0o700 });
      syncDirectory(parent);
      fs.mkdirSync(path.join(staging, "operations"), { mode: 0o700 });
      syncDirectory(staging);
      write(path.join(staging, "session.json"), { schema, id: randomUUID() });
      if (present(dir)) throw new Error("Managed writer session appeared during initialization; recovery is required.");
      fs.renameSync(staging, dir);
      syncDirectory(parent);
      created = true;
    }
    const { dir: current, id } = session(root);
    if (present(path.join(current, "fenced")))
      throw new Error("Managed writer session is fenced; a new profile cannot join.");
    const registration = { sessionId: id, operationId: randomUUID(), profileId, process: profileProcess(),
      ...(automatic ? { protocol: MANAGED_PROFILE_SUCCESSOR_PROTOCOL } : {}) };
    write(path.join(current, "operations", `${registration.operationId}.pending`),
      { schema, ...registration, kind: "profile-host", phase: "pending" });
    return { registration: rememberProfile(registration, root), created };
  }, "bootstrap"));
}

/** Complete only after the profile's owned resources have actually drained. */
export function completeManagedProfile(root: string, registration: ManagedProfileRegistration): void {
  assertIssuedProfile(root, registration);
  assertBoundProfileDrained(root, registration);
  const { sessionId, operationId, profileId } = registration;
  if (!uuid.test(sessionId) || !uuid.test(operationId) || !/^[a-f0-9]{64}$/.test(profileId))
    throw new Error("Invalid managed profile identity.");
  withLegacyLinuxRootWriter(root, () => held(root, () => {
    assertIssuedProfile(root, registration);
    assertBoundProfileDrained(root, registration);
    const { dir } = ready(root, sessionId);
    const pending = read(path.join(dir, "operations", `${operationId}.pending`));
    if (pending?.schema !== schema || pending.sessionId !== sessionId || pending.operationId !== operationId
      || pending.kind !== "profile-host" || pending.profileId !== profileId || pending.phase !== "pending"
      || pending.protocol !== registration.protocol || JSON.stringify(pending.process) !== JSON.stringify(registration.process))
      throw new Error("Managed profile pending record is invalid.");
    write(path.join(dir, "operations", `${operationId}.complete`),
      { schema, ...registration, kind: "profile-host", phase: "complete" });
  }));
}

function managedDirectoryPin(directory: string): { path: string; device: string; inode: string } {
  if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== directory)
    throw new Error("Managed profile directory is not canonical.");
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Managed profile directory is unavailable.");
  return { path: directory, device: stat.dev.toString(), inode: stat.ino.toString() };
}

export interface ManagedEnvironmentHostFence {
  readonly kind: "pkm.managed-environment-host-fence/v1";
  readonly denySignal: AbortSignal;
}
const environmentHostFences = new WeakMap<ManagedEnvironmentHostFence, () => void>();

/**
 * Current-host check only: this is neither profile exclusivity nor an effect authorization.
 * The session fence is checked on every assertion, not delivered synchronously across processes.
 */
export function createManagedEnvironmentHostFence(options: {
  root: string; profileStorage: string; profileUri: string; registration: ManagedProfileRegistration;
  hostAdmission: HostWriterAdmission; scopeSignal: AbortSignal;
}): ManagedEnvironmentHostFence {
  const { root, profileStorage, profileUri, registration, hostAdmission, scopeSignal } = options;
  const issued = issuedProfiles.get(registration);
  if (!(hostAdmission instanceof HostWriterAdmission) || !scopeSignal
    || !issued || issued.record !== JSON.stringify(registration) || issued.root !== root
    || issued.rootPin !== JSON.stringify(managedDirectoryPin(root))
    || fileURLToPath(profileUri) !== profileStorage
    || createHash("sha256").update(profileUri).digest("hex") !== registration.profileId)
    throw new Error("An actual local managed profile and matching host scope are required.");
  const rootPin = JSON.stringify(managedDirectoryPin(root));
  const profilePin = JSON.stringify(managedDirectoryPin(profileStorage));
  const ownSignal = hostAdmission.denySignal;
  const denySignal = AbortSignal.any([ownSignal, scopeSignal]);
  const check = () => {
    if (denySignal.aborted || issuedProfiles.get(registration) !== issued
      || issued.record !== JSON.stringify(registration)
      || process.env.PKM_MANAGED_WRITER_SESSION !== registration.sessionId
      || JSON.stringify(profileProcess()) !== JSON.stringify(registration.process)
      || JSON.stringify(managedDirectoryPin(root)) !== rootPin
      || JSON.stringify(managedDirectoryPin(profileStorage)) !== profilePin)
      throw new Error("Managed Environment host scope or Root/profile binding is no longer current.");
    hostAdmission.assertCurrentRoot(root);
    const validate = () => {
      const { dir } = ready(root, registration.sessionId);
      const operations = path.join(dir, "operations");
      if (present(path.join(dir, "fenced"))
        || present(path.join(operations, `${registration.operationId}.complete`))
        || JSON.stringify(read(path.join(operations, `${registration.operationId}.pending`)))
          !== JSON.stringify({ schema, ...registration, kind: "profile-host", phase: "pending" }))
        throw new Error("Managed Environment profile registration is no longer accepting.");
    };
    const completionLock = environmentCompletionLock.getStore();
    if (completionLock) {
      const verifyLock = () => {
        const stat = fs.lstatSync(lock(root));
        if (!completionLock.open || completionLock.root !== root || completionLock.sessionId !== registration.sessionId
          || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
          || stat.dev !== completionLock.identity.dev || stat.ino !== completionLock.identity.ino
          || JSON.stringify(read(lock(root))) !== completionLock.record
          || JSON.parse(completionLock.record).nonce !== completionLock.nonce)
          throw new Error("Managed Environment completion lock is no longer current.");
      };
      verifyLock(); validate(); verifyLock();
    } else {
      withLegacyLinuxRootWriter(root, () => held(root, validate));
    }
    hostAdmission.assertCurrentRoot(root);
    if (denySignal.aborted) throw new Error("Managed Environment host scope is revoked.");
  };
  check();
  const result = Object.freeze({ kind: "pkm.managed-environment-host-fence/v1" as const, denySignal });
  environmentHostFences.set(result, check);
  return result;
}

export function assertManagedEnvironmentHostFence(fence: ManagedEnvironmentHostFence): void {
  const check = environmentHostFences.get(fence);
  if (!check) throw new Error("A real managed Environment host fence is required.");
  check();
}

/** Persist this process's independently confirmed, already-drained profile only. */
export function recordConfirmedManagedProfile(root: string, profileStorage: string, registration: ManagedProfileRegistration): void {
  assertIssuedProfile(root, registration);
  assertBoundProfileDrained(root, registration, true);
  const rootPin = managedDirectoryPin(root), profilePin = managedDirectoryPin(profileStorage);
  if (process.env.PKM_MANAGED_WRITER_SESSION !== registration.sessionId
    || JSON.stringify(profileProcess()) !== JSON.stringify(registration.process))
    throw new Error("Managed profile confirmation belongs to another process.");
  withLegacyLinuxRootWriter(root, () => held(root, () => {
    assertIssuedProfile(root, registration);
    assertBoundProfileDrained(root, registration, true);
    if (JSON.stringify(managedDirectoryPin(root)) !== JSON.stringify(rootPin)
      || JSON.stringify(managedDirectoryPin(profileStorage)) !== JSON.stringify(profilePin))
      throw new Error("Managed Root or profile changed during confirmation.");
    const { dir } = ready(root, registration.sessionId);
    const operations = path.join(dir, "operations");
    const pending = read(path.join(operations, `${registration.operationId}.pending`));
    const complete = read(path.join(operations, `${registration.operationId}.complete`));
    const expected = { schema, ...registration, kind: "profile-host" };
    if (JSON.stringify(pending) !== JSON.stringify({ ...expected, phase: "pending" })
      || JSON.stringify(complete) !== JSON.stringify({ ...expected, phase: "complete" }))
      throw new Error("Managed profile has no matching completed drain.");
    const record = { schema: "pkm.managed-profile-confirmation/v1", ...registration, root: rootPin, profile: profilePin };
    if (Buffer.byteLength(JSON.stringify(record)) > 4096) throw new Error("Managed profile confirmation is too large.");
    write(path.join(dir, `confirmed.${registration.operationId}.json`), record);
  }));
}

export interface ManagedDrainedSnapshotHost {
  readonly root: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  assertCurrent(binding: Readonly<{ root: string; profile: string; sessionId: string }>): void;
}

const drainedSnapshotHosts = new WeakMap<ManagedDrainedSnapshotHost, () => void>();

export function bindManagedProfileHostAdmission(root: string, registration: ManagedProfileRegistration, admission: HostWriterAdmission): void {
  const issued = issuedProfiles.get(registration);
  if (!issued || issued.root !== root || issued.record !== JSON.stringify(registration)
    || !(admission instanceof HostWriterAdmission) || profileHostAdmissions.has(registration))
    throw new Error("An unbound issued managed host registration is required.");
  admission.assertCurrentRoot(root);
  profileHostAdmissions.set(registration, admission);
}

/**
 * Same-process identity and deny-only validation for an already drained host.
 * The receipt is not a cross-process grant or proof of external writer coverage.
 */
export function createManagedDrainedSnapshotHost(options: {
  root: string; profileStorage: string; profileUri: string; registration: ManagedProfileRegistration;
  hostAdmission: HostWriterAdmission; scopeSignal: AbortSignal;
}): ManagedDrainedSnapshotHost {
  const { root, profileStorage, profileUri, registration, hostAdmission, scopeSignal } = options;
  const issued = issuedProfiles.get(registration);
  if (!issued || issued.root !== root || issued.record !== JSON.stringify(registration)
    || !(hostAdmission instanceof HostWriterAdmission) || profileHostAdmissions.get(registration) !== hostAdmission || !scopeSignal
    || createHash("sha256").update(profileUri).digest("hex") !== registration.profileId)
    throw new Error("An issued managed registration and its actual host scope are required.");
  const rootPin = JSON.stringify(managedDirectoryPin(root));
  const profilePin = JSON.stringify(managedDirectoryPin(profileStorage));
  const sessionDir = legacyBase(root);
  const sessionPin = JSON.stringify(managedDirectoryPin(sessionDir));
  const readPrivate = (name: string) => {
    const file = path.join(sessionDir, name), before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 4096n
      || (before.mode & 0o7077n) !== 0n || process.getuid === undefined || before.uid !== BigInt(process.getuid()))
      throw new Error("Managed snapshot host session record is unsafe.");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const opened = fs.fstatSync(fd, { bigint: true }), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true });
      const current = fs.lstatSync(file, { bigint: true });
      for (const stat of [opened, after, current]) {
        if (!stat.isFile() || stat.nlink !== 1n || stat.dev !== before.dev || stat.ino !== before.ino
          || stat.mode !== before.mode || stat.uid !== before.uid || stat.size !== before.size
          || stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs)
          throw new Error("Managed snapshot host session record changed.");
      }
      if (BigInt(bytes.length) !== before.size) throw new Error("Managed snapshot host session record changed.");
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } finally { fs.closeSync(fd); }
  };
  const check = () => {
    if (scopeSignal.aborted || issuedProfiles.get(registration) !== issued
      || profileHostAdmissions.get(registration) !== hostAdmission
      || issued.record !== JSON.stringify(registration) || issued.rootPin !== rootPin
      || process.env.PKM_MANAGED_WRITER_SESSION !== registration.sessionId
      || JSON.stringify(profileProcess()) !== JSON.stringify(registration.process)
      || JSON.stringify(managedDirectoryPin(root)) !== rootPin
      || JSON.stringify(managedDirectoryPin(profileStorage)) !== profilePin
      || JSON.stringify(managedDirectoryPin(sessionDir)) !== sessionPin)
      throw new Error("Managed snapshot host binding is no longer current.");
    hostAdmission.assertDrainedRoot(root);
    const stat = fs.lstatSync(sessionDir, { bigint: true });
    if ((stat.mode & 0o7077n) !== 0n || process.getuid === undefined || stat.uid !== BigInt(process.getuid()))
      throw new Error("Managed snapshot host session directory is unsafe.");
    const rotation = readPrivate(`rotation.${registration.sessionId}.json`);
    const current = readPrivate("session.json"), fenced = readPrivate("fenced");
    if (JSON.stringify(rotation) !== JSON.stringify({ schema, previousSessionId: registration.sessionId, nextSessionId: current.id })
      || !uuid.test(current.id) || current.id === registration.sessionId
      || JSON.stringify(current) !== JSON.stringify({ schema, id: current.id })
      || JSON.stringify(fenced) !== JSON.stringify({ schema, sessionId: current.id }))
      throw new Error("Managed snapshot host requires its exact fenced successor rotation.");
    const archive = `operations.${registration.sessionId}`;
    const archivePin = managedDirectoryPin(path.join(sessionDir, archive));
    const archiveStat = fs.lstatSync(archivePin.path, { bigint: true });
    if ((archiveStat.mode & 0o7077n) !== 0n || archiveStat.uid !== BigInt(process.getuid()))
      throw new Error("Managed snapshot host operation archive is unsafe.");
    const expected = { schema, ...registration, kind: "profile-host" };
    if (JSON.stringify(readPrivate(`${archive}/${registration.operationId}.pending`)) !== JSON.stringify({ ...expected, phase: "pending" })
      || JSON.stringify(readPrivate(`${archive}/${registration.operationId}.complete`)) !== JSON.stringify({ ...expected, phase: "complete" })
      || JSON.stringify(readPrivate(`confirmed.${registration.operationId}.json`))
        !== JSON.stringify({ schema: "pkm.managed-profile-confirmation/v1", ...registration,
          root: JSON.parse(rootPin), profile: JSON.parse(profilePin) })
      || JSON.stringify(managedDirectoryPin(archivePin.path)) !== JSON.stringify(archivePin))
      throw new Error("Managed snapshot host has no matching independently confirmed drain.");
    hostAdmission.assertDrainedRoot(root);
    if (scopeSignal.aborted || JSON.stringify(managedDirectoryPin(sessionDir)) !== sessionPin)
      throw new Error("Managed snapshot host scope changed.");
  };
  check();
  const host: ManagedDrainedSnapshotHost = Object.freeze({
    root, sessionId: registration.sessionId, signal: scopeSignal,
    assertCurrent(binding: Readonly<{ root: string; profile: string; sessionId: string }>) {
      if (!binding || binding.root !== root || binding.profile !== profileStorage || binding.sessionId !== registration.sessionId)
        throw new Error("Managed snapshot host binding does not match.");
      check();
    },
  });
  drainedSnapshotHosts.set(host, check);
  return host;
}

export function assertManagedDrainedSnapshotHost(host: ManagedDrainedSnapshotHost): void {
  const check = drainedSnapshotHosts.get(host);
  if (!check) throw new Error("A real drained managed snapshot host is required.");
  check();
}

function fenceConfirmedManagedProfiles(root: string, expected: string, operationIds: readonly string[], requireDrained: boolean): void {
  if (!uuid.test(expected) || !operationIds.length || operationIds.length > 100
    || operationIds.some(id => !uuid.test(id)) || new Set(operationIds).size !== operationIds.length)
    throw new Error("Exact managed profile registrations are required.");
  withLegacyLinuxRootWriter(root, () => held(root, () => {
    const { dir, id } = ready(root, expected), operations = path.join(dir, "operations");
    if (present(path.join(dir, "fenced"))) throw new Error("Managed session is already fenced; inspect its outcome rather than replaying.");
    const profiles = fs.readdirSync(operations).filter(name => /^[a-f0-9-]{36}\.pending$/.test(name))
      .map(name => read(path.join(operations, name))).filter(value => value?.kind === "profile-host");
    const actual = profiles.map(value => value.operationId).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...operationIds].sort()))
      throw new Error("Managed profile registration set changed; no session fence was started.");
    for (const profile of profiles) {
      if (profile.schema !== schema || profile.sessionId !== id || !uuid.test(profile.operationId)
        || profile.phase !== "pending" || !/^[a-f0-9]{64}$/.test(profile.profileId))
        throw new Error("Managed profile registration is invalid.");
      const completionPath = path.join(operations, `${profile.operationId}.complete`);
      if (!present(completionPath)) throw new Error("Managed profile is not independently drained.");
      const completion = read(completionPath);
      const expectedCompletion = { ...profile, phase: "complete" };
      if (JSON.stringify(completion) !== JSON.stringify(expectedCompletion))
        throw new Error("Managed profile is not independently drained.");
      const confirmed = read(path.join(dir, `confirmed.${profile.operationId}.json`));
      const { phase: _phase, kind: _kind, ...registration } = profile;
      if (confirmed?.schema !== "pkm.managed-profile-confirmation/v1"
        || JSON.stringify({ sessionId: confirmed.sessionId, operationId: confirmed.operationId,
          profileId: confirmed.profileId, process: confirmed.process,
          ...(confirmed.protocol ? { protocol: confirmed.protocol } : {}) })
          !== JSON.stringify({ sessionId: registration.sessionId, operationId: registration.operationId,
            profileId: registration.profileId, process: registration.process,
            ...(registration.protocol ? { protocol: registration.protocol } : {}) })
        || JSON.stringify(confirmed.root) !== JSON.stringify(managedDirectoryPin(root))
        || !confirmed.profile || JSON.stringify(confirmed.profile) !== JSON.stringify(managedDirectoryPin(confirmed.profile.path)))
        throw new Error("Managed profile confirmation or Root/profile binding is invalid.");
    }
    if (requireDrained) assertDrained(dir, id);
    write(path.join(dir, "fenced"), { schema, sessionId: id });
  }));
}

/** Fence only the exact independently confirmed host set; pending operations remain unknown. */
export function beginConfirmedManagedProfileFence(root: string, expected: string, operationIds: readonly string[]): Readonly<{
  status: "fenced-pending"; preexistingAndExternalWriters: "unknown"; cutoverAuthorized: false;
}> {
  fenceConfirmedManagedProfiles(root, expected, operationIds, false);
  return { status: "fenced-pending", preexistingAndExternalWriters: "unknown", cutoverAuthorized: false };
}

/** Close only this exact, fully confirmed registered set; this never grants root cutover. */
export function sealConfirmedManagedProfiles(root: string, expected: string, operationIds: readonly string[]): Readonly<{
  registeredWritersDrained: true; preexistingAndExternalWriters: "unknown"; cutoverAuthorized: false;
}> {
  fenceConfirmedManagedProfiles(root, expected, operationIds, true);
  return { registeredWritersDrained: true, preexistingAndExternalWriters: "unknown", cutoverAuthorized: false };
}

/** Durable records are participation evidence, not a census or proof that a process is alive. */
export function discoverManagedProfiles(root: string, expected: string): ReadonlyArray<{
  profileId: string; hostId: string; state: "registered-unverified" | "drained" | "stopped";
}> {
  return withLegacyLinuxRootWriter(root, () => held(root, () => {
    const { dir } = ready(root, expected), operations = path.join(dir, "operations");
    const result: Array<{ profileId: string; hostId: string; state: "registered-unverified" | "drained" | "stopped" }> = [];
    for (const name of fs.readdirSync(operations)) {
      if (!/^[a-f0-9-]{36}\.pending$/.test(name)) continue;
      const pending = read(path.join(operations, name));
      if (pending?.kind !== "profile-host") continue;
      const hostId = name.slice(0, -8);
      if (!uuid.test(hostId) || pending.schema !== schema || pending.sessionId !== expected
        || pending.operationId !== hostId || pending.phase !== "pending" || !/^[a-f0-9]{64}$/.test(pending.profileId))
        throw new Error("Managed profile pending record is invalid.");
      const filename = path.join(operations, `${hostId}.complete`);
      let state: "registered-unverified" | "drained" | "stopped" = profileStopped(pending) ? "stopped" : "registered-unverified";
      if (present(filename)) {
        const complete = read(filename);
        if (complete?.schema !== schema || complete.sessionId !== expected || complete.operationId !== hostId
          || complete.kind !== "profile-host" || complete.profileId !== pending.profileId || complete.phase !== "complete"
          || complete.protocol !== pending.protocol || JSON.stringify(complete.process) !== JSON.stringify(pending.process))
          throw new Error("Managed profile completion record is invalid.");
        state = "drained";
      }
      result.push({ profileId: pending.profileId, hostId, state });
    }
    return result;
  }));
}

/** The environment binding is a launch contract, not evidence that other processes participate. */
export async function withManagedWriterOperation<T>(root: string, kind: ManagedWriterKind, action: () => Promise<T>): Promise<T> {
  return withLegacyLinuxRootWriterAsync(root, () => withManagedWriterOperationTracked(root, kind, action));
}

export function hasManagedRetrievalSession(root: string): boolean {
  return process.platform === "linux"
    && (process.env.PKM_MANAGED_WRITER_SESSION !== undefined || present(base(root)));
}

/** Join an already provisioned session only while its admission remains open. */
export function enrollExistingManagedWriterSession(root: string): string | undefined {
  if (process.platform !== "linux" || !present(base(root))) return undefined;
  return withLegacyLinuxRootWriter(root, () => held(root, () => {
    const { dir, id } = session(root);
    if (present(path.join(dir, "fenced")))
      throw new Error("Managed writer session is fenced; a new profile cannot join.");
    return id;
  }));
}

export async function withManagedRetrievalOperation<T>(root: string, action: () => Promise<T>): Promise<T> {
  if (!hasManagedRetrievalSession(root)) return action();
  return withManagedWriterOperation(root, "retrieval-request", action);
}

/** Register only a process explicitly launched with this session binding. */
export function beginManagedWriterOperation(root: string, kind: ManagedWriterKind, launchId?: string): ManagedWriterRegistration | undefined {
  const configured = process.env.PKM_MANAGED_WRITER_SESSION;
  if (configured === undefined) {
    if (present(base(root))) throw new ManagedWriterAdmissionDenied("Managed writer session exists but this process is not enrolled; no operation was started.");
    return undefined;
  }
  if (process.platform !== "linux" || !uuid.test(configured)
    || !["github-sync", "sync-service", "mcp-server", "retrieval-request"].includes(kind)
    || kind === "mcp-server" && (!launchId || !uuid.test(launchId))
    || kind !== "mcp-server" && launchId !== undefined) throw new Error("Invalid managed writer session binding.");
  if (!path.isAbsolute(root) || fs.realpathSync(root) !== root) throw new Error("Managed writer root is not canonical.");
  const parent = active.getStore();
  if (parent) {
    if (!parent.open || parent.root !== root || parent.sessionId !== configured)
      throw new Error("Managed writer operation context is no longer valid.");
  }
  const operationId = randomUUID();
  const operation = { schema, sessionId: configured, operationId, kind, ...(launchId ? { launchId } : {}) };
  held(root, () => {
    const { dir } = ready(root, configured);
    if (present(path.join(dir, "fenced"))) throw new ManagedWriterAdmissionDenied("Managed writer session is fenced; no operation was started.");
    write(path.join(dir, "operations", `${operationId}.pending`), { ...operation, phase: "pending" });
  });
  return { sessionId: configured, operationId, kind, ...(launchId ? { launchId } : {}) };
}

/** Register an exact prepared Environment launch; this is not profile or migration authority. */
export function beginManagedEnvironmentRefresh(root: string, prepared: PreparedLinuxEnvironmentQuery): ManagedEnvironmentRefreshRegistration {
  const configured = process.env.PKM_MANAGED_WRITER_SESSION;
  if (process.platform !== "linux" || !configured || !uuid.test(configured)
    || !path.isAbsolute(root) || fs.realpathSync(root) !== root)
    throw new Error("Environment refresh requires an explicitly enrolled managed writer session.");
  const trace = describePreparedLinuxEnvironmentQuery(prepared), pins = describePreparedLinuxEnvironmentPins(prepared);
  if (trace.intent.knowledgeRoot !== root || registeredEnvironmentQueries.has(prepared))
    throw new Error("Environment refresh prepared launch is already registered or belongs to another Root.");
  const binding: LinuxEnvironmentDrainBinding = Object.freeze({
    workspaceId: trace.intent.workspaceId, knowledgeRoot: root,
    globalStorageDirectory: trace.intent.globalStorageDirectory, requestId: trace.intent.requestId,
    environmentId: trace.environmentId, probe: trace.kind,
  });
  const operationId = randomUUID(), registration = Object.freeze({ kind: "pkm.managed-environment-refresh/v1" as const });
  registeredEnvironmentQueries.add(prepared);
  withLegacyLinuxRootWriter(root, () => held(root, () => {
    const pin = (directory: string) => {
      const stat = fs.lstatSync(directory, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory)
        throw new Error("Environment refresh Root/profile is no longer canonical.");
      return `${stat.dev}:${stat.ino}`;
    };
    if (pin(root) !== pins.rootPin || pin(binding.globalStorageDirectory) !== pins.profilePin)
      throw new Error("Environment refresh Root/profile identity changed before registration.");
    const { dir } = ready(root, configured);
    if (present(path.join(dir, "fenced")))
      throw new ManagedWriterAdmissionDenied("Managed writer session is fenced; no Environment refresh was started.");
    write(path.join(dir, "operations", `${operationId}.pending`),
      { schema, sessionId: configured, operationId, kind: "environment-refresh", phase: "pending" });
  }));
  environmentRegistrations.set(registration, { root, sessionId: configured, operationId, prepared, binding,
    rootPin: pins.rootPin, profilePin: pins.profilePin });
  return registration;
}

/** Both physical drain and successful enclosing refresh completion are required. */
export function completeManagedEnvironmentRefresh(registration: ManagedEnvironmentRefreshRegistration, proof: LinuxEnvironmentDrainProof,
  completion: OrdinaryEnvironmentRefreshCompletion): void {
  const entry = environmentRegistrations.get(registration);
  if (!entry || process.env.PKM_MANAGED_WRITER_SESSION !== entry.sessionId || completingEnvironmentRegistrations.has(registration))
    throw new Error("Environment refresh registration is invalid or its session changed.");
  const check = () => {
    if (process.env.PKM_MANAGED_WRITER_SESSION !== entry.sessionId)
      throw new Error("Environment refresh session changed.");
    assertLinuxEnvironmentDrainProof(proof, entry.binding);
    assertPreparedLinuxEnvironmentDrainProof(proof, entry.prepared);
    if (proof.rootPin !== entry.rootPin || proof.profilePin !== entry.profilePin)
      throw new Error("Environment refresh Root/profile identity changed.");
    assertOrdinaryEnvironmentRefreshCompletion(completion, entry.prepared);
    assertPreparedLinuxEnvironmentDrainProof(proof, entry.prepared);
    if (process.env.PKM_MANAGED_WRITER_SESSION !== entry.sessionId)
      throw new Error("Environment refresh session changed.");
  };
  completingEnvironmentRegistrations.add(registration);
  try {
    check();
    withLegacyLinuxRootWriter(entry.root, () => held(entry.root, nonce => {
      const filename = lock(entry.root), identity = fs.lstatSync(filename), record = JSON.stringify(read(filename));
      const scope = { root: entry.root, sessionId: entry.sessionId, nonce, identity, record, open: true };
      try {
        return environmentCompletionLock.run(scope, () => {
          const { dir } = ready(entry.root, entry.sessionId);
          const expected = { schema, sessionId: entry.sessionId, operationId: entry.operationId, kind: "environment-refresh" };
          const pending = read(path.join(dir, "operations", `${entry.operationId}.pending`));
          if (JSON.stringify(pending) !== JSON.stringify({ ...expected, phase: "pending" }))
            throw new Error("Managed Environment refresh pending record is invalid.");
          const completed = path.join(dir, "operations", `${entry.operationId}.complete`);
          check();
          ready(entry.root, entry.sessionId);
          if (JSON.stringify(read(path.join(dir, "operations", `${entry.operationId}.pending`)))
            !== JSON.stringify({ ...expected, phase: "pending" }))
            throw new Error("Managed Environment refresh pending record changed.");
          if (present(completed)) {
            if (JSON.stringify(read(completed)) !== JSON.stringify({ ...expected, phase: "complete" }))
              throw new Error("Managed Environment refresh completion record is invalid.");
            syncDirectory(path.dirname(completed));
          } else write(completed, { ...expected, phase: "complete" });
        });
      } finally { scope.open = false; }
    }));
  } finally { completingEnvironmentRegistrations.delete(registration); }
}

/** Bind a newly launched owned MCP to the accepting current session without an inherited environment. */
export function beginUnboundManagedMcpLaunch(root: string, launchId: string): ManagedWriterRegistration {
  if (process.platform !== "linux" || !path.isAbsolute(root) || fs.realpathSync(root) !== root || !uuid.test(launchId))
    throw new Error("Invalid unbound managed MCP launch.");
  return withLegacyLinuxRootWriter(root, () => held(root, () => {
    const { dir, id } = session(root);
    if (present(path.join(dir, "fenced")))
      throw new ManagedWriterAdmissionDenied("Managed writer session is fenced; no MCP launch was started.");
    const operationId = randomUUID(), kind = "mcp-server" as const;
    write(path.join(dir, "operations", `${operationId}.pending`),
      { schema, sessionId: id, operationId, kind, launchId, phase: "pending" });
    return { sessionId: id, operationId, kind, launchId };
  }));
}

export interface ExistingManagedMcpRegistration {
  root: string;
  sessionId: string;
  operationId: string;
  generation: string;
  instanceId: string;
  runtimeBuild: string;
}

/** Register only an existing MCP whose live connection is already owned and verified by the caller. */
export function beginExistingManagedMcp(root: string, sessionId: string,
  identity: { generation: string; instanceId: string; runtimeBuild: string }): ExistingManagedMcpRegistration {
  if (process.platform !== "linux" || !path.isAbsolute(root) || fs.realpathSync(root) !== root
    || process.env.PKM_MANAGED_WRITER_SESSION !== sessionId || !uuid.test(sessionId)
    || !uuid.test(identity.generation) || !/^[a-f0-9]{32}$/.test(identity.instanceId)
    || !/^[a-f0-9]{64}$/.test(identity.runtimeBuild)) throw new Error("Existing MCP registration is invalid.");
  const operationId = randomUUID();
  return withLegacyLinuxRootWriter(root, () => held(root, () => {
    const { dir } = ready(root, sessionId);
    if (present(path.join(dir, "fenced")))
      throw new ManagedWriterAdmissionDenied("Managed writer session is fenced; existing MCP was not registered.");
    const { generation, instanceId, runtimeBuild } = identity;
    write(path.join(dir, "operations", `${operationId}.pending`),
      { schema, sessionId, operationId, kind: "mcp-existing", generation, instanceId, runtimeBuild, phase: "pending" });
    return { root, sessionId, operationId, generation, instanceId, runtimeBuild };
  }));
}

/** Complete only after the same connected instance drains and its owned process tree exits. */
export function completeExistingManagedMcp(registration: ExistingManagedMcpRegistration): void {
  const { root, sessionId, operationId, generation, instanceId, runtimeBuild } = registration;
  if (!path.isAbsolute(root) || fs.realpathSync(root) !== root || process.env.PKM_MANAGED_WRITER_SESSION !== sessionId
    || !uuid.test(sessionId) || !uuid.test(operationId) || !uuid.test(generation)
    || !/^[a-f0-9]{32}$/.test(instanceId) || !/^[a-f0-9]{64}$/.test(runtimeBuild))
    throw new Error("Existing MCP completion is invalid.");
  withLegacyLinuxRootWriter(root, () => held(root, () => {
    const { dir } = ready(root, sessionId);
    const pending = read(path.join(dir, "operations", `${operationId}.pending`));
    if (pending?.schema !== schema || pending.sessionId !== sessionId || pending.operationId !== operationId
      || pending.kind !== "mcp-existing" || pending.generation !== generation || pending.instanceId !== instanceId
      || pending.runtimeBuild !== runtimeBuild || pending.phase !== "pending")
      throw new Error("Existing MCP pending record is invalid.");
    write(path.join(dir, "operations", `${operationId}.complete`),
      { schema, sessionId, operationId, kind: "mcp-existing", generation, instanceId, runtimeBuild, phase: "complete" });
  }));
}

export interface ManagedRetrievalBuildRegistration {
  root: string;
  sessionId: string;
  operationId: string;
  revisionHash: string;
  workerHash: string;
}

/** Persist a build before dispatch, while its admitted retrieval request is still open. */
export function beginManagedRetrievalBuild(revisionHash: string, workerHash: string): ManagedRetrievalBuildRegistration | undefined {
  const context = active.getStore();
  if (!context) return undefined;
  if (!context.open || !/^[a-f0-9]{64}$/.test(revisionHash) || !/^[a-f0-9]{64}$/.test(workerHash))
    throw new Error("Managed retrieval build identity is invalid.");
  const { root, sessionId } = context, operationId = randomUUID();
  held(root, () => {
    const { dir } = ready(root, sessionId);
    write(path.join(dir, "operations", `${operationId}.pending`),
      { schema, sessionId, operationId, kind: "retrieval-build", revisionHash, workerHash, phase: "pending" });
  });
  return { root, sessionId, operationId, revisionHash, workerHash };
}

/** Complete only after the same worker's observed revision has finished. */
export function completeManagedRetrievalBuild(registration: ManagedRetrievalBuildRegistration): void {
  const { root, sessionId, operationId, revisionHash, workerHash } = registration;
  if (!path.isAbsolute(root) || fs.realpathSync(root) !== root || !uuid.test(sessionId) || !uuid.test(operationId)
    || process.env.PKM_MANAGED_WRITER_SESSION !== sessionId || !/^[a-f0-9]{64}$/.test(revisionHash)
    || !/^[a-f0-9]{64}$/.test(workerHash)) throw new Error("Managed retrieval build completion is invalid.");
  withLegacyLinuxRootWriter(root, () => held(root, () => {
    const { dir } = ready(root, sessionId);
    const pending = read(path.join(dir, "operations", `${operationId}.pending`));
    if (pending?.schema !== schema || pending.sessionId !== sessionId || pending.operationId !== operationId
      || pending.kind !== "retrieval-build" || pending.revisionHash !== revisionHash || pending.workerHash !== workerHash
      || pending.phase !== "pending") throw new Error("Managed retrieval build pending record is invalid.");
    write(path.join(dir, "operations", `${operationId}.complete`),
      { schema, sessionId, operationId, kind: "retrieval-build", revisionHash, workerHash, phase: "complete" });
  }));
}

/** Call only after a successfully drained, owned operation; failure remains pending. */
export function completeManagedWriterOperation(root: string, registration: ManagedWriterRegistration): void {
  const { sessionId, operationId, kind, launchId } = registration;
  if (!uuid.test(sessionId) || !uuid.test(operationId) || process.env.PKM_MANAGED_WRITER_SESSION !== sessionId
    || !["github-sync", "sync-service", "mcp-server", "retrieval-request"].includes(kind)
    || kind === "mcp-server" && (!launchId || !uuid.test(launchId))
    || kind !== "mcp-server" && launchId !== undefined) throw new Error("Invalid managed writer completion.");
  held(root, () => {
    const { dir } = ready(root, sessionId);
    const pending = read(path.join(dir, "operations", `${operationId}.pending`));
    if (pending?.schema !== schema || pending.sessionId !== sessionId || pending.operationId !== operationId
      || pending.kind !== kind || pending.launchId !== launchId || pending.phase !== "pending") throw new Error("Managed writer pending record is invalid.");
    write(path.join(dir, "operations", `${operationId}.complete`), { schema, sessionId, operationId, kind, ...(launchId ? { launchId } : {}), phase: "complete" });
  });
}

export function assertManagedMcpLaunchRegistered(root: string, expected: string, launchId: string): void {
  if (!uuid.test(expected) || !uuid.test(launchId)) throw new Error("Managed MCP session binding is invalid.");
  held(root, () => {
    const { dir, id } = ready(root, expected);
    if (present(path.join(dir, "fenced"))) throw new Error("Managed writer session is fenced; no connection was admitted.");
    const operations = path.join(dir, "operations");
    const matching = fs.readdirSync(operations).filter(name => /^[a-f0-9-]{36}\.pending$/.test(name)).filter(name => {
      const value = read(path.join(operations, name));
      return value?.schema === schema && value.sessionId === id && value.operationId === name.slice(0, -8)
        && value.kind === "mcp-server" && value.phase === "pending" && value.launchId === launchId
        && !present(path.join(operations, `${value.operationId}.complete`));
    });
    if (matching.length !== 1) throw new Error("Owned MCP launch did not register a unique pending operation; outcome is unknown.");
  });
}

export function managedWriterAdmissionState(root: string, expected: string): "accepting" | "fenced" {
  const { dir, id } = ready(root, expected), marker = path.join(dir, "fenced");
  if (!present(marker)) return "accepting";
  const value = read(marker);
  if (value?.schema !== schema || value.sessionId !== id) throw new Error("Managed writer fence is invalid.");
  return "fenced";
}

async function withManagedWriterOperationTracked<T>(root: string, kind: ManagedWriterKind, action: () => Promise<T>): Promise<T> {
  const registration = beginManagedWriterOperation(root, kind);
  if (!registration) return action();
  const { sessionId: configured, operationId } = registration;
  const context = { root, sessionId: configured, operationId, open: true };
  let result: T;
  try { result = await active.run(context, action); } finally { context.open = false; }
  completeManagedWriterOperation(root, registration);
  return result;
}

/** Close admission persistently without assuming any participant has already drained. */
export function closeManagedWriterAdmission(root: string, expected: string, requireAutomaticProfiles = false): void {
  withLegacyLinuxRootWriter(root, () => held(root, () => {
    const { dir, id } = ready(root, expected);
    const marker = path.join(dir, "fenced");
    if (requireAutomaticProfiles) {
      const operations = path.join(dir, "operations");
      for (const name of fs.readdirSync(operations)) {
        if (!/^[a-f0-9-]{36}\.pending$/.test(name)) continue;
        const pending = read(path.join(operations, name));
        if (pending?.kind === "profile-host") {
          const operationId = name.slice(0, -8);
          if (!uuid.test(operationId) || pending.schema !== schema || pending.sessionId !== id
            || pending.operationId !== operationId || pending.phase !== "pending" || !/^[a-f0-9]{64}$/.test(pending.profileId))
            throw new Error("Managed profile pending record is invalid.");
          const completion = path.join(operations, `${operationId}.complete`);
          if (present(completion)) {
            const done = read(completion);
            if (done?.schema !== schema || done.sessionId !== id || done.operationId !== operationId
              || done.kind !== "profile-host" || done.phase !== "complete" || done.profileId !== pending.profileId
              || done.protocol !== pending.protocol || JSON.stringify(done.process) !== JSON.stringify(pending.process))
              throw new Error("Managed profile completion record is invalid.");
            continue;
          }
          if (!profileStopped(pending) && pending.protocol !== MANAGED_PROFILE_SUCCESSOR_PROTOCOL)
            throw new Error("An active managed profile cannot automatically restart; no fence was started.");
        }
      }
    }
    if (!present(marker)) write(marker, { schema, sessionId: id });
    else {
      const value = read(marker);
      if (value?.schema !== schema || value.sessionId !== id) throw new Error("Managed writer fence is invalid.");
      syncDirectory(dir);
    }
  }));
}

/** Resolve only a durably published successor chain from an explicitly bound ancestor. */
export function resolveManagedWriterSession(root: string, expected: string): string {
  if (!uuid.test(expected)) throw new Error("Invalid managed writer session binding.");
  return withLegacyLinuxRootWriter(root, () => held(root, () => {
    const { dir, id } = session(root);
    let current = expected;
    const seen = new Set<string>();
    while (current !== id) {
      if (seen.has(current) || seen.size >= 10000) throw new Error("Managed writer successor chain is invalid.");
      seen.add(current);
      const journal = read(path.join(dir, `rotation.${current}.json`));
      if (journal?.schema !== schema || journal.previousSessionId !== current || !uuid.test(journal.nextSessionId)
        || !present(path.join(dir, `operations.${current}`)))
        throw new Error("Managed writer successor chain is incomplete.");
      current = journal.nextSessionId;
    }
    const marker = path.join(dir, "fenced");
    if (present(marker)) {
      const value = read(marker);
      if (value?.schema !== schema || value.sessionId !== id) throw new Error("Managed writer successor is incomplete.");
    }
    return id;
  }));
}

/** Close admission persistently before inspecting durable operations; unknown is never drained. */
export function fenceManagedWriterSession(root: string, expected: string): Readonly<{
  registeredWritersDrained: true; preexistingAndExternalWriters: "unknown"; cutoverAuthorized: false;
}> {
  closeManagedWriterAdmission(root, expected);
  return inspectManagedWriterDrain(root, expected);
}

/** Rotate only a fully drained session. Interrupted rotation remains fenced for recovery. */
export function rotateManagedWriterSession(root: string, expected: string): Readonly<{
  sessionId: string; preexistingAndExternalWriters: "unknown"; cutoverAuthorized: false;
}> {
  if (!uuid.test(expected)) throw new Error("Invalid managed writer session binding.");
  const next = randomUUID();
  withLegacyLinuxRootWriter(root, () => held(root, () => {
    const { dir, id } = ready(root, expected);
    const marker = read(path.join(dir, "fenced"));
    if (marker?.schema !== schema || marker.sessionId !== id) throw new Error("Managed writer fence is invalid.");
    assertDrained(dir, id);
    const archive = path.join(dir, `operations.${id}`);
    const journal = path.join(dir, `rotation.${id}.json`);
    if (present(archive) || present(journal)) throw new Error("Managed writer rotation requires recovery.");
    write(journal, { schema, previousSessionId: id, nextSessionId: next });
    fs.renameSync(path.join(dir, "operations"), archive);
    syncDirectory(dir);
    fs.mkdirSync(path.join(dir, "operations"), { mode: 0o700 });
    syncDirectory(dir);
    const successor = path.join(dir, `session.${next}.pending`);
    write(successor, { schema, id: next });
    fs.renameSync(successor, path.join(dir, "session.json"));
    syncDirectory(dir);
    fs.unlinkSync(path.join(dir, "fenced"));
    syncDirectory(dir);
  }));
  return { sessionId: next, preexistingAndExternalWriters: "unknown", cutoverAuthorized: false };
}

function inspectManagedWriterDrain(root: string, expected: string): Readonly<{
  registeredWritersDrained: true; preexistingAndExternalWriters: "unknown"; cutoverAuthorized: false;
}> {
  held(root, () => {
    const { dir, id } = ready(root, expected);
    const marker = read(path.join(dir, "fenced"));
    if (marker?.schema !== schema || marker.sessionId !== id) throw new Error("Managed writer fence is invalid.");
    assertDrained(dir, id);
  });
  return { registeredWritersDrained: true, preexistingAndExternalWriters: "unknown", cutoverAuthorized: false };
}

export async function waitForManagedWriterDrain(root: string, expected: string, timeoutMs = 30_000): Promise<ReturnType<typeof fenceManagedWriterSession>> {
  closeManagedWriterAdmission(root, expected);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    try { return inspectManagedWriterDrain(root, expected); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes("active or has an unknown outcome")
        || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
    }
  }
}

/** Drain only handles owned by this coordinator; durable records, not callbacks, prove registered completion. */
export async function orchestrateManagedWriterHandoff(
  root: string, expected: string, owned: ReadonlyArray<{ drain: () => Promise<void> }>, timeoutMs = 30_000,
): Promise<ReturnType<typeof fenceManagedWriterSession>> {
  closeManagedWriterAdmission(root, expected);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let timer: NodeJS.Timeout | undefined;
  try {
    const results = await Promise.race([
      Promise.allSettled(owned.map(handle => Promise.resolve().then(() => handle.drain()))),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Owned writer drain timed out; outcome remains unknown.")), Math.max(1, deadline - Date.now()));
      }),
    ]);
    if (results.some(result => result.status === "rejected")) throw new Error("Owned writer drain failed; outcome remains unknown.");
    return await waitForManagedWriterDrain(root, expected, Math.max(0, deadline - Date.now()));
  } finally { if (timer) clearTimeout(timer); }
}
