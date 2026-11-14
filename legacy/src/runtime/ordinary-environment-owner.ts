import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, type ChildProcess } from "node:child_process";
import { prepareLinuxEnvironmentQuery, describePreparedLinuxEnvironmentQuery,
  reservePreparedLinuxEnvironmentQuery, startPreparedLinuxEnvironmentQuery, environmentDrainProof } from "./linux-environment-supervisor";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { pyenvPackages, pyenvPyVersion, pyenvSize, type PyEnv, type Pkg,
  type PyenvProbeKind, type PyenvRefreshWorkflow } from "../servers/pyenvs";

export interface EnvironmentOwnerContext {
  workspaceId: string;
  storage: { workspaceRoot(): string };
  assertCurrent(): void;
  registerChildClose(close: () => Promise<void>): () => void;
}

export interface OrdinaryEnvironmentReadBinding {
  workspaceId: string;
  actorId: "local:owner";
  knowledgeRoot: string;
  globalStorageDirectory: string;
  scope: "ordinary-environments:read-cache";
}

export interface OrdinaryEnvironmentReadAuthority extends OrdinaryEnvironmentReadBinding {
  signal: AbortSignal;
  assertCurrent(binding: Readonly<OrdinaryEnvironmentReadBinding>): void;
}

export interface EnvironmentHostSession {
  workspaceId: string;
  signal: AbortSignal;
  signalFor?(scope: "environment"): AbortSignal;
  assertCurrent(scope: "environment"): void;
  registerChildClose(scope: "environment", close: () => Promise<void>): () => void;
}

type Message = { command: string; id?: unknown; refresh?: unknown };
type CacheReply = { command: "envPackages"; id: string; packages: Pkg[];
  capturedAt: string; cached: boolean; error?: string };
type Reply = { command: "envList"; data: PyEnv[]; refreshErrors?: string[] } | CacheReply;
export interface OrdinaryEnvironmentRefreshIntent {
  requestId: string;
  workspaceId: string;
  actorId: "local:owner";
  knowledgeRoot: string;
  globalStorageDirectory: string;
  operation: "packages" | "metadata";
  refresh: boolean;
  environments: readonly Readonly<Pick<PyEnv, "id" | "path" | "python" | "manager">>[];
}
export interface EnvironmentQueryTrace {
  intent: Readonly<OrdinaryEnvironmentRefreshIntent>;
  environmentId: string;
  kind: PyenvProbeKind;
  program: string;
  args: readonly string[];
  environment: Readonly<NodeJS.ProcessEnv>;
  launch?: Readonly<{ program: string; args: readonly string[] }>;
}
export interface OrdinaryEnvironmentRefreshCompletion { readonly kind: "pkm.environment-refresh-transaction/v1" }
const refreshCompletions = new WeakMap<OrdinaryEnvironmentRefreshCompletion, {
  prepared: ReadonlySet<ReturnType<typeof prepareLinuxEnvironmentQuery>>; assertCurrent(): void;
}>();
export function assertOrdinaryEnvironmentRefreshCompletion(completion: OrdinaryEnvironmentRefreshCompletion,
  prepared: ReturnType<typeof prepareLinuxEnvironmentQuery>): void {
  const entry = refreshCompletions.get(completion);
  if (!entry?.prepared.has(prepared))
    throw new Error("Environment transaction completion is not for this exact prepared query.");
  synchronousFence(entry.assertCurrent);
}
/** Issued for one trusted UI request; session/read authority alone cannot create this grant. */
export interface OrdinaryEnvironmentRefreshPermit {
  intent: Readonly<OrdinaryEnvironmentRefreshIntent>;
  expiresAtMs: number;
  signal: AbortSignal;
  environment: NodeJS.ProcessEnv;
  /** Experimental managed effects must independently authorize this installed helper's actual descriptor. */
  supervisorPython?: string;
  registerPreparedExecution?(prepared: ReturnType<typeof prepareLinuxEnvironmentQuery>): void;
  finishRefresh?(completion: OrdinaryEnvironmentRefreshCompletion | undefined): Promise<void>;
  claim(intent: Readonly<OrdinaryEnvironmentRefreshIntent>): void;
  assertCurrent(effect: "probe" | "execute" | "commit", environmentId: string, kind: PyenvProbeKind): void;
  assertProfileWriter(): void;
  assertExecution(trace: Readonly<EnvironmentQueryTrace>): void;
  recordExecution(child: ChildProcess, trace: Readonly<EnvironmentQueryTrace>): void;
  verifyDrained(child: ChildProcess, trace: Readonly<EnvironmentQueryTrace>): Promise<void>;
  withProfileWrite(environmentId: string, kind: PyenvProbeKind, write: () => void): Promise<void>;
}
const consumedRefreshPermits = new WeakSet<OrdinaryEnvironmentRefreshPermit>();
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const pin = (stat: fs.Stats) => `${stat.dev}:${stat.ino}`;

function synchronousFence(check: () => unknown): void {
  const result = check();
  if (result !== undefined) {
    if (result && typeof (result as PromiseLike<unknown>).then === "function")
      void Promise.resolve(result).catch(() => {});
    throw new Error("Environment authority fence must be synchronous and return undefined.");
  }
}

/**
 * Trusted in-process owner adapter for the existing ordinary UI protocol.
 * A Storage lease or MCP transport credential never grants profile access.
 */
export function attachOrdinaryEnvironmentsToOwner(options: {
  owner: EnvironmentOwnerContext;
  hostSession: EnvironmentHostSession;
  authority: OrdinaryEnvironmentReadAuthority;
  onCloseError(error: unknown): void;
}) {
  if (process.platform !== "linux") throw new Error("Pinned ordinary Environment profile reads require Linux.");
  const { owner, hostSession, authority } = options;
  if (!owner || typeof owner.assertCurrent !== "function" || typeof owner.registerChildClose !== "function"
    || typeof owner.storage?.workspaceRoot !== "function" || !authority
    || typeof authority.assertCurrent !== "function" || !authority.signal
    || typeof authority.signal.addEventListener !== "function" || !hostSession
    || typeof hostSession.assertCurrent !== "function" || typeof hostSession.registerChildClose !== "function"
    || !hostSession.signal || typeof hostSession.signal.addEventListener !== "function")
    throw new Error("A trusted owner, host session and independent revocable Environment authority are required.");
  const binding = Object.freeze({ workspaceId: authority.workspaceId, actorId: authority.actorId,
    knowledgeRoot: authority.knowledgeRoot, globalStorageDirectory: authority.globalStorageDirectory,
    scope: authority.scope });
  const environmentSignal = hostSession.signalFor?.("environment") ?? hostSession.signal;
  if (typeof environmentSignal.addEventListener !== "function")
    throw new Error("A revocable Environment session signal is required.");
  if (!binding.workspaceId || binding.workspaceId !== owner.workspaceId || binding.workspaceId !== hostSession.workspaceId
    || binding.actorId !== "local:owner"
    || binding.scope !== "ordinary-environments:read-cache")
    throw new Error("Environment workspace, actor and read-cache scope must match the owner.");
  for (const directory of [binding.knowledgeRoot, binding.globalStorageDirectory]) {
    if (typeof directory !== "string" || directory.includes("\0") || !path.isAbsolute(directory)
      || path.resolve(directory) !== directory || fs.realpathSync(directory) !== directory)
      throw new Error("Environment Root and original profile must be canonical directories.");
  }
  const directory = path.join(binding.globalStorageDirectory, "environments");
  let closed = false, closing: Promise<void> | undefined, directoryFd: number | undefined;
  let unregister = () => {}, unregisterSession = () => {};
  const pending = new Set<Promise<Reply>>();
  const unconfirmedQueries = new Set<() => Promise<void>>();
  const supervisedPreparations = new WeakMap<OrdinaryEnvironmentRefreshPermit, Set<ReturnType<typeof prepareLinuxEnvironmentQuery>>>();
  const ownerFence = owner.assertCurrent.bind(owner), authorityFence = authority.assertCurrent.bind(authority);
  const signal = authority.signal;
  const profileStat = fs.statSync(binding.globalStorageDirectory);
  if (!profileStat.isDirectory() || !fs.statSync(binding.knowledgeRoot).isDirectory())
    throw new Error("Environment Root and original profile must be directories.");
  const profilePin = pin(profileStat);
  function check() {
    if (closed || signal.aborted || hostSession.signal.aborted || environmentSignal.aborted)
      throw new Error("Ordinary Environment attachment is closed.");
    synchronousFence(ownerFence);
    synchronousFence(() => hostSession.assertCurrent("environment"));
    synchronousFence(() => authorityFence(binding));
    if (closed || signal.aborted || hostSession.signal.aborted || environmentSignal.aborted
      || owner.workspaceId !== binding.workspaceId
      || hostSession.workspaceId !== binding.workspaceId
      || owner.storage.workspaceRoot() !== binding.knowledgeRoot)
      throw new Error("Environment owner or profile authorization changed.");
    if (fs.realpathSync(binding.knowledgeRoot) !== binding.knowledgeRoot
      || fs.realpathSync(binding.globalStorageDirectory) !== binding.globalStorageDirectory
      || pin(fs.statSync(binding.globalStorageDirectory)) !== profilePin)
      throw new Error("Original Environment profile binding changed.");
    if (directoryFd !== undefined && (fs.realpathSync(directory) !== directory
      || pin(fs.statSync(directory)) !== pin(fs.fstatSync(directoryFd))))
      throw new Error("Original Environment registry directory changed.");
  }
  function readJson(name: string): unknown {
    check();
    // Resolve through the held directory, never a concurrently substituted profile parent.
    let fd: number;
    try {
      fd = fs.openSync(`/proc/self/fd/${directoryFd}/${name}`,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (error) {
      throw new Error(`Cannot read original Environment metadata ${path.join(directory, name)}: ${String(error)}`);
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 2_000_000) throw new Error("Environment metadata must be a bounded regular file.");
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0, count: number;
      while (length < buffer.length && (count = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
      const after = fs.fstatSync(fd);
      if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
        throw new Error("Environment metadata changed during read; retry against the original profile.");
      check();
      return JSON.parse(buffer.subarray(0, length).toString("utf8"));
    } finally { fs.closeSync(fd); }
  }
  function registry(): PyEnv[] {
    const rows = readJson("registry.json");
    if (!Array.isArray(rows) || rows.length > 10000 || rows.some(row => !row || typeof row !== "object"
      || typeof row.id !== "string" || !safeId.test(row.id) || typeof row.name !== "string" || typeof row.manager !== "string"
      || typeof row.path !== "string" || typeof row.python !== "string")
      || new Set(rows.map(row => row.id)).size !== rows.length)
      throw new Error("Original Environment registry is malformed or has ambiguous IDs; no automatic recovery.");
    return rows;
  }
  function refreshWorkflow(permit: OrdinaryEnvironmentRefreshPermit | undefined, operation: "packages" | "metadata",
    refresh: boolean, entries: PyEnv[]): PyenvRefreshWorkflow {
    if (!permit || typeof permit.claim !== "function" || typeof permit.assertCurrent !== "function"
      || typeof permit.assertProfileWriter !== "function" || typeof permit.assertExecution !== "function" || typeof permit.recordExecution !== "function"
      || typeof permit.verifyDrained !== "function" || typeof permit.withProfileWrite !== "function"
      || !permit.signal || !permit.environment?.PATH || !permit.environment.HOME || !permit.environment.TMPDIR)
      throw new Error("Refresh requires separate authorization: a tracked one-request owner permit and profile writer authority.");
    if (consumedRefreshPermits.has(permit)) throw new Error("Owner Refresh permit was already consumed; no query was replayed.");
    const deadline = permit.expiresAtMs;
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now() + 300_000)
      throw new Error("Owner Refresh permit must have a finite deadline within five minutes.");
    const intent = Object.freeze({ requestId: permit.intent?.requestId, workspaceId: binding.workspaceId,
      actorId: binding.actorId, knowledgeRoot: binding.knowledgeRoot, globalStorageDirectory: binding.globalStorageDirectory,
      operation, refresh, environments: Object.freeze(entries.map(({ id, path, python, manager }) =>
        Object.freeze({ id, path, python, manager }))) });
    if (typeof intent.requestId !== "string" || !intent.requestId || intent.requestId.length > 256 || !isDeepStrictEqual(intent, permit.intent)
      || entries.some(entry => !path.isAbsolute(entry.path) || !path.isAbsolute(entry.python)
        || entry.path.includes("\0") || entry.python.includes("\0")))
      throw new Error("Owner Refresh permit does not match this exact profile, target or UI intent.");
    synchronousFence(() => permit.claim(intent));
    supervisedPreparations.set(permit, new Set());
    consumedRefreshPermits.add(permit);
    const attempts = new Set<string>();
    const environment = Object.freeze({ ...permit.environment, PIP_NO_INDEX: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PYTHONDONTWRITEBYTECODE: "1" });
    const snapshot = (target: string, writable: boolean) => {
      let fd: number;
      try { fd = fs.openSync(target, (writable ? fs.constants.O_RDWR : fs.constants.O_RDONLY)
        | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
      catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; }
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 2_000_000) throw new Error("Refresh target must be bounded regular metadata.");
        const bytes = Buffer.alloc(stat.size + 1);
        let length = 0, count: number;
        while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
        const after = fs.fstatSync(fd);
        if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
          throw new Error("Original profile metadata changed during Refresh snapshot.");
        return { bytes: bytes.subarray(0, length), identity: pin(stat), mode: stat.mode & 0o777 };
      } finally { fs.closeSync(fd); }
    };
    const current = (id: string, kind: PyenvProbeKind, effect: "probe" | "execute" | "commit") => {
      check();
      if (permit.signal.aborted || Date.now() >= deadline) throw new Error("Owner Refresh permit expired or was revoked.");
      const target = intent.environments.find(entry => entry.id === id), found = registry().find(entry => entry.id === id);
      if (!target || !found || found.path !== target.path || found.python !== target.python || found.manager !== target.manager
        || operation === "packages" && kind !== "packages" || operation === "metadata" && kind === "packages")
        throw new Error("Original Environment target binding changed or is outside this Refresh permit.");
      synchronousFence(() => permit.assertCurrent(effect, id, kind));
      check();
      if (permit.signal.aborted || Date.now() >= deadline) throw new Error("Owner Refresh permit expired or was revoked.");
      const after = registry().find(entry => entry.id === id);
      if (!after || after.path !== target.path || after.python !== target.python || after.manager !== target.manager)
        throw new Error("Original Environment target binding changed during authorization.");
    };
    const commit = async (id: string, kind: PyenvProbeKind, name: string, bytes: () => string) => {
      current(id, kind, "commit");
      synchronousFence(() => permit.assertProfileWriter());
      current(id, kind, "commit");
      let invoked = false, writerWindow = true;
      try { await permit.withProfileWrite(id, kind, () => {
        if (invoked || !writerWindow) throw new Error("A Refresh commit cannot be replayed or delayed beyond its writer authority.");
        invoked = true;
        current(id, kind, "commit");
        synchronousFence(() => permit.assertProfileWriter());
        const target = `/proc/self/fd/${directoryFd}/${name}`, temporary = `/proc/self/fd/${directoryFd}/.refresh-${randomUUID()}`;
        const before = snapshot(target, true), mode = before?.mode ?? 0o600;
        const content = bytes();
        if (Buffer.byteLength(content) > 2_000_000) throw new Error("Refresh metadata exceeds the write limit.");
        const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
        try {
          fs.writeFileSync(fd, content); fs.fchmodSync(fd, mode); fs.fsyncSync(fd);
          current(id, kind, "commit");
          synchronousFence(() => permit.assertProfileWriter());
          const existing = snapshot(target, false);
          if (before === undefined ? existing !== undefined : existing === undefined
            || !before.bytes.equals(existing.bytes) || before.identity !== existing.identity || before.mode !== existing.mode)
            throw new Error("Original profile metadata changed before Refresh commit; no overwrite.");
          fs.renameSync(temporary, target);
          fs.fsyncSync(directoryFd!);
        } finally { fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      }); } catch (error) {
        throw new Error(`Cannot commit original Environment metadata ${path.join(directory, name)}: ${String(error)}`);
      } finally { writerWindow = false; }
      if (!invoked) throw new Error("Owner profile writer did not commit this Refresh.");
    };
    return {
      environment,
      get(id) { check(); return registry().find(entry => entry.id === id); },
      readVersionConfig(id, dir) {
        current(id, "version", "probe");
        const fd = fs.openSync(path.join(dir, "pyvenv.cfg"), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          const stat = fs.fstatSync(fd);
          if (!stat.isFile() || stat.size > 65536) throw new Error("Version config must be a bounded regular file.");
          const bytes = Buffer.alloc(stat.size + 1);
          let length = 0, count: number;
          while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
          const after = fs.fstatSync(fd);
          if (length !== stat.size || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs)
            throw new Error("Version config changed during Refresh.");
          current(id, "version", "probe");
          return bytes.subarray(0, length).toString("utf8");
        } finally { fs.closeSync(fd); }
      },
      beforeProbe(id, kind) {
        current(id, kind, "probe");
        const key = `${id}:${kind}`;
        if (attempts.has(key)) throw new Error("A Refresh probe cannot be replayed.");
        attempts.add(key);
      },
      execute(id, kind, program, args, execOptions, done) {
        try { current(id, kind, "execute"); }
        catch (error) { done(error as Error, ""); return; }
        let trace: Readonly<EnvironmentQueryTrace> = Object.freeze({ intent, environmentId: id, kind, program, args: Object.freeze([...args]), environment });
        let prepared: ReturnType<typeof prepareLinuxEnvironmentQuery> | undefined;
        let reservation: ReturnType<typeof reservePreparedLinuxEnvironmentQuery> | undefined;
        try {
          if (permit.supervisorPython !== undefined) {
            prepared = prepareLinuxEnvironmentQuery(trace, { python: permit.supervisorPython,
              timeoutMs: Math.min(execOptions.timeout, Math.max(1, deadline - Date.now())), maxBuffer: execOptions.maxBuffer ?? 1_048_576 });
            reservation = reservePreparedLinuxEnvironmentQuery(prepared);
            supervisedPreparations.get(permit)!.add(prepared);
            trace = describePreparedLinuxEnvironmentQuery(prepared);
          }
        } catch (error) { done(error as Error, ""); return; }
        try { synchronousFence(() => permit.assertExecution(trace)); current(id, kind, "execute"); }
        catch (error) { done(error as Error, ""); return; }
        let ledgerError: unknown;
        let child: ChildProcess;
        const delivered = (error: Error | null, stdout: string) => {
          void (async () => {
            const verify = async () => {
              if (prepared) environmentDrainProof(child, trace);
              await permit.verifyDrained(child, trace); unconfirmedQueries.delete(verify);
            };
            unconfirmedQueries.add(verify);
            try { await verify(); }
            catch (failure) { done(new Error(`Environment query drain is unknown; no replay: ${String(failure)}`), ""); return; }
            try {
              if (ledgerError) throw ledgerError;
              current(id, kind, "execute");
              done(error, String(stdout));
            } catch (failure) { done(failure as Error, ""); }
          })();
        };
        try {
          if (prepared) {
            if (!permit.registerPreparedExecution) throw new Error("Supervised Environment requires an explicit managed registration before spawn.");
            synchronousFence(() => permit.registerPreparedExecution!(prepared!));
            current(id, kind, "execute");
            const execution = startPreparedLinuxEnvironmentQuery(prepared, reservation!);
            child = execution.child;
            void execution.result.then(stdout => delivered(null, stdout), error => delivered(error as Error, ""));
          } else {
            child = execFile(program, args, { ...execOptions, env: environment,
              timeout: Math.min(execOptions.timeout, Math.max(1, deadline - Date.now())) }, delivered);
          }
        } catch (error) { done(error as Error, ""); return; }
        try { synchronousFence(() => permit.recordExecution(child, trace)); }
        catch (error) { ledgerError = error; }
      },
      commitPackages(id, value) { return commit(id, "packages", `${id}.packages.json`, () => JSON.stringify(value, null, 2)); },
      commitMetadata(id, patch) {
        return commit(id, patch.pyVersion !== undefined ? "version" : "size", "registry.json", () =>
          JSON.stringify(registry().map(entry => entry.id === id ? { ...entry, ...patch } : entry), null, 2) + "\n");
      },
    };
  }
  async function close(): Promise<void> {
    closed = true;
    return closing ??= (async () => {
      await Promise.allSettled([...pending]);
      await Promise.all([...unconfirmedQueries].map(verify => verify()));
      if (unconfirmedQueries.size) throw new Error("Environment queries have not drained; retain the owner.");
      if (directoryFd !== undefined) { fs.closeSync(directoryFd); directoryFd = undefined; }
      signal.removeEventListener("abort", onAbort);
      hostSession.signal.removeEventListener("abort", onAbort);
      environmentSignal.removeEventListener("abort", onAbort);
      unregisterSession();
      unregister();
    })().catch(error => { closing = undefined; throw error; });
  }
  function onAbort() {
    void close().catch(error => { try { options.onCloseError(error); } catch {} });
  }
  try {
    check();
    if (fs.realpathSync(directory) !== directory) throw new Error("Original Environment registry must not be redirected.");
    directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    check();
    unregister = owner.registerChildClose(close);
    unregisterSession = hostSession.registerChildClose("environment", close);
    signal.addEventListener("abort", onAbort, { once: true });
    hostSession.signal.addEventListener("abort", onAbort, { once: true });
    environmentSignal.addEventListener("abort", onAbort, { once: true });
    check();
  } catch (error) {
    closed = true;
    if (directoryFd !== undefined) { fs.closeSync(directoryFd); directoryFd = undefined; }
    unregister();
    unregisterSession();
    signal.removeEventListener("abort", onAbort);
    hostSession.signal.removeEventListener("abort", onAbort);
    environmentSignal.removeEventListener("abort", onAbort);
    throw error;
  }
  return Object.freeze({
    binding,
    handleMessage(message: Message, refreshPermit?: OrdinaryEnvironmentRefreshPermit): Promise<Reply> {
      try { check(); } catch (error) { return Promise.reject(error); }
      if (!message || !["envList", "envPackages"].includes(message.command))
        return Promise.reject(new Error("Only ordinary Environment List and cached Packages are admitted."));
      const { command, id, refresh } = message;
      let usedPermit: OrdinaryEnvironmentRefreshPermit | undefined;
      const task = Promise.resolve().then(async (): Promise<Reply> => {
        check();
        if (command === "envList") {
          if (refresh !== undefined && refresh !== false && refresh !== true) throw new Error("Invalid metadata Refresh intent.");
          if (!refresh) return { command, data: registry() };
          const entries = registry(), workflow = refreshWorkflow(refreshPermit, "metadata", true, entries), refreshErrors: string[] = [];
          usedPermit = refreshPermit;
          const failures = new Map<string, { pythonProbeError?: string; sizeProbeError?: string }>();
          for (const entry of entries) {
            const version = await pyenvPyVersion(entry.id, true, workflow);
            if (version.error) refreshErrors.push(`${entry.name || entry.id}: Python version probe failed: ${version.error}`);
            const size = await pyenvSize(entry.id, true, workflow);
            if (size.error) refreshErrors.push(`${entry.name || entry.id}: disk size probe failed: ${size.error}`);
            failures.set(entry.id, { pythonProbeError: version.error, sizeProbeError: size.error });
          }
          return { command, data: registry().map(entry => ({ ...entry, ...failures.get(entry.id),
            probeError: [failures.get(entry.id)?.pythonProbeError, failures.get(entry.id)?.sizeProbeError].filter(Boolean).join("\n") || undefined })), refreshErrors };
        }
        if (typeof id !== "string" || !safeId.test(id)) throw new Error("A registered Environment ID is required.");
        const entry = registry().find(row => row.id === id);
        if (!entry) throw new Error("Environment ID is not in the authorized original profile.");
        if (refresh !== undefined && refresh !== false && refresh !== true) throw new Error("Invalid package Refresh intent.");
        try {
          if (refresh) throw new Error("Explicit package Refresh");
          const value = readJson(`${id}.packages.json`) as { packages?: unknown; capturedAt?: unknown };
          if (!value || !Array.isArray(value.packages) || value.packages.some(pkg => !pkg
            || typeof pkg.name !== "string" || typeof pkg.version !== "string")
            || typeof value.capturedAt !== "string")
            throw new Error("Retained Environment package cache is malformed; no manager was executed.");
          const current = registry().find(row => row.id === id);
          if (!current || current.path !== entry.path || current.python !== entry.python || current.manager !== entry.manager)
            throw new Error("Original Environment ID binding changed during cache read.");
          return { command: "envPackages", id, packages: value.packages, capturedAt: value.capturedAt, cached: true };
        } catch (error) {
          check();
          if (!refreshPermit) return { command: "envPackages", id, packages: [], capturedAt: "", cached: false,
            error: refresh ? "Environment package Refresh requires separate authorization; no manager was executed." : String(error) };
          const workflow = refreshWorkflow(refreshPermit, "packages", !!refresh, [entry]);
          usedPermit = refreshPermit;
          return { command: "envPackages", id, ...await pyenvPackages(id, true, workflow) };
        }
      }).then(async reply => {
        check();
        if (usedPermit?.finishRefresh) {
          const successful = reply.command === "envList" ? !reply.refreshErrors?.length : !reply.error;
          let completion: OrdinaryEnvironmentRefreshCompletion | undefined;
          if (successful) {
            completion = Object.freeze({ kind: "pkm.environment-refresh-transaction/v1" as const });
            const permit = usedPermit;
            refreshCompletions.set(completion, { prepared: new Set(supervisedPreparations.get(permit)),
              assertCurrent() {
                check();
                if (permit.signal.aborted || Date.now() >= permit.expiresAtMs)
                  throw new Error("Environment transaction authority expired or was revoked.");
                synchronousFence(() => permit.assertProfileWriter());
                check();
                if (permit.signal.aborted) throw new Error("Environment transaction was revoked during its completion fence.");
              } });
          }
          try { await usedPermit.finishRefresh(completion); }
          finally { if (completion) refreshCompletions.delete(completion); }
          check();
        }
        return reply;
      }).catch(async error => {
        if (usedPermit?.finishRefresh) {
          try { await usedPermit.finishRefresh(undefined); } catch {}
        }
        throw error;
      });
      pending.add(task);
      void task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    },
    close,
  });
}
