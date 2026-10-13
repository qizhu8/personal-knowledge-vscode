import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as net from "net";
import { spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import {
  canonicalKnowledgeRoot, githubSyncCoordinatorDirectory, GitHubSyncCoordinator,
  GitHubSyncCoordinatorOptions,
} from "../sync/github-sync-coordinator";
import {
  AutomaticGitHubSyncTarget, GitHubSyncBlockedError, GitHubSyncReason, GitHubSyncRuntimeState,
} from "../sync/github-sync-scheduler";
import {
  GitHubSyncCatalog, GitHubSyncConflictError, GitHubSyncCredentials,
  GitHubSyncExecutionOptions, GitHubSyncExtensionCompatibilityError, GitHubSyncResult,
  GitHubSyncTarget, syncGitHubTarget,
} from "../sync/github-sync";
import { compareVersionOrder } from "./version-order";
import { GitHubSyncContentRepairError } from "../sync/github-sync-content-repair";

export const PKM_SERVICE_PROTOCOL = "pkm-github-sync/1";
export const PKM_SERVICE_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const LONG_TIMEOUT = 15 * 60 * 1000;
const SHORT_TIMEOUT = 30 * 1000;
type Phase = Parameters<GitHubSyncCoordinator["report"]>[1];
type Progress = Parameters<typeof syncGitHubTarget>[5];

export interface PkmServiceClientOptions {
  globalStoragePath: string;
  stateDirectory?: string;
  knowledgeRoot: string;
  extensionVersion: string;
  serviceEntryPath?: string;
  shouldExecute?: GitHubSyncCoordinatorOptions["shouldExecute"];
  execute: GitHubSyncCoordinatorOptions["execute"];
  shouldRetryFailure?: GitHubSyncCoordinatorOptions["shouldRetryFailure"];
  compatibilityBlock?: GitHubSyncCoordinatorOptions["compatibilityBlock"];
  onAutoPaused?: (targetId: string) => void | Promise<void>;
  onState?: GitHubSyncCoordinatorOptions["onState"];
  onError?: (error: Error) => void;
}

export class PkmServiceVersionError extends Error {
  constructor(readonly requiredVersion: string, readonly installedVersion: string) {
    super(`PKM service ${requiredVersion} requires a matching extension window; this window is ${installedVersion}. Reload or upgrade this window. No sync was submitted.`);
    this.name = "PkmServiceVersionError";
  }
}

export class PkmServiceOfflineError extends Error {
  constructor(message = "PKM service has no connected matching-version extension host to provide authentication and sync orchestration.") {
    super(message);
    this.name = "PkmServiceOfflineError";
  }
}

export class PkmServiceRecoveryPersistenceError extends Error {
  readonly recoveryAvailable = false;
  readonly serviceShouldRetry = false;
  constructor(
    readonly operationId: string,
    readonly targetId: string,
    readonly outcome: "success" | "error",
    readonly primaryError: Error | undefined,
    readonly persistenceError: Error,
    readonly persistenceStage: string,
    readonly transactionReceiptPath: string,
    readonly transactionId?: string,
    readonly commit?: string,
  ) {
    super(`${primaryError ? `GitHub Sync failed: ${primaryError.message}` : "GitHub Sync completed and may already have changed files or pushed"}; recovery record was NOT saved (${persistenceStage}): ${persistenceError.message}. Operation ${operationId}, target ${targetId}. Do not blindly retry. Inspect ${transactionReceiptPath}${transactionId ? ` for transaction ${transactionId}` : "; an older receipt is not evidence for this operation"}.`);
    this.name = "PkmServiceRecoveryPersistenceError";
  }
}

interface ServiceIdentity {
  identity: string;
  knowledgeRoot: string;
  globalStoragePath: string;
  stateDirectory: string;
  serviceDirectory: string;
  endpoint: string;
  ipcDirectory?: string;
}
interface EndpointMetadata extends ServiceIdentity {
  protocol: string;
  extensionVersion: string;
  pid: number;
  nonce: string;
}
export interface PkmServiceBootOptions {
  globalStoragePath: string;
  knowledgeRoot: string;
  stateDirectory?: string;
  extensionVersion: string;
}
interface WireMessage {
  protocol: string;
  extensionVersion: string;
  identity: string;
  nonce: string;
  kind: "request" | "response" | "event";
  id?: string;
  method?: string;
  value?: any;
  error?: any;
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: any) { return error?.code === "EPERM"; }
}
function validVersion(version: unknown): version is string {
  return typeof version === "string" && compareVersionOrder(version, version) === 0;
}
function account(): string {
  return process.getuid ? String(process.getuid()) : os.userInfo().username;
}
function owned(file: string, directory = false): fs.Stats {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory && !stat.isDirectory())
    || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("PKM service path is not owned by the current account or is a symbolic link.");
  }
  return stat;
}
function privateDirectory(directory: string): void {
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error: any) { if (error?.code !== "EEXIST") throw error; }
  owned(directory, true);
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
}
function privateFile(file: string): void {
  const stat = owned(file);
  if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
    throw new Error("PKM service metadata/result is not a private regular file.");
  }
}

export function pkmServiceIdentity(options: PkmServiceBootOptions): ServiceIdentity {
  if (!validVersion(options.extensionVersion)) throw new Error("PKM service extensionVersion must be a valid version.");
  const knowledgeRoot = canonicalKnowledgeRoot(options.knowledgeRoot);
  fs.mkdirSync(options.globalStoragePath, { recursive: true });
  const globalStoragePath = fs.realpathSync.native(path.resolve(options.globalStoragePath));
  owned(globalStoragePath, true);
  const identity = createHash("sha256").update(JSON.stringify([account(), knowledgeRoot, canonicalKnowledgeRoot(globalStoragePath)])).digest("hex");
  const serviceDirectory = path.join(globalStoragePath, "pkm-service", identity);
  const stateDirectory = githubSyncCoordinatorDirectory(globalStoragePath, knowledgeRoot);
  if (options.stateDirectory) fs.mkdirSync(options.stateDirectory, { recursive: true });
  const suppliedStateDirectory = options.stateDirectory ? fs.realpathSync.native(options.stateDirectory) : stateDirectory;
  if (path.resolve(suppliedStateDirectory) !== path.resolve(stateDirectory)) {
    throw new Error("PKM service must share the legacy GitHub Sync coordinator directory.");
  }
  if (process.platform === "win32") {
    return { identity, knowledgeRoot, globalStoragePath, stateDirectory, serviceDirectory, endpoint: `\\\\.\\pipe\\pkm-sync-${identity}` };
  }
  // Avoid world-writable temp directories and Unix's small sockaddr_un path limit.
  const local = path.join(serviceDirectory, "ipc");
  const ipcDirectory = Buffer.byteLength(path.join(local, "s")) < 100
    ? local : path.join(os.homedir(), ".pkm-ipc", identity.slice(0, 24));
  const endpoint = path.join(ipcDirectory, "s");
  if (Buffer.byteLength(endpoint) >= 100) throw new Error("PKM private IPC path exceeds the Unix socket path limit.");
  return { identity, knowledgeRoot, globalStoragePath, stateDirectory, serviceDirectory, endpoint, ipcDirectory };
}

function prepareDirectories(identity: ServiceIdentity): void {
  privateDirectory(path.join(identity.globalStoragePath, "pkm-service"));
  privateDirectory(identity.serviceDirectory);
  if (identity.ipcDirectory) {
    if (path.dirname(identity.ipcDirectory) !== identity.serviceDirectory) privateDirectory(path.dirname(identity.ipcDirectory));
    privateDirectory(identity.ipcDirectory);
  }
}
function encode(value: any): any {
  if (Buffer.isBuffer(value)) return { $pkm: "buffer", data: value.toString("base64") };
  if (value === undefined) return { $pkm: "undefined" };
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === "object") {
    // Wrap objects as entries so user content cannot impersonate a codec tag.
    return { $pkm: "object", entries: Object.entries(value).map(([key, item]) => [key, encode(item)]) };
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new Error("Unsupported PKM service payload.");
  return value;
}
function decode(value: any): any {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    if (value.$pkm === "undefined") return undefined;
    if (value.$pkm === "buffer" && typeof value.data === "string") return Buffer.from(value.data, "base64");
    if (value.$pkm === "object" && Array.isArray(value.entries)) {
      return Object.fromEntries(value.entries.map(([key, item]: [string, any]) => [key, decode(item)]));
    }
    throw new Error("Invalid PKM service value encoding.");
  }
  return value;
}
function errorData(error: any): any {
  return {
    name: error?.name || "Error", message: String(error?.message || error),
    ...(typeof error?.stack === "string" ? { stack: error.stack } : {}),
    ...(error?.cause !== undefined ? { cause: errorData(error.cause) } : {}),
    ...Object.fromEntries(Object.entries(error || {}).map(([key, value]) => [key, value instanceof Error ? errorData(value) : value])),
  };
}
function redactError(error: unknown, credentials?: GitHubSyncCredentials): any {
  const token = credentials?.accessToken;
  function scrub(value: any): any {
    if (typeof value === "string" && token) return value.split(token).join("[REDACTED]");
    if (Buffer.isBuffer(value)) return value;
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
    return value;
  }
  return scrub(errorData(error));
}
function reviveError(data: any): Error {
  let error: Error;
  switch (data?.name) {
    case "GitHubSyncContentRepairError":
      error = new GitHubSyncContentRepairError(data.targetId, data.issues, data.attemptId); break;
    case "GitHubSyncConflictError":
      error = new GitHubSyncConflictError(data.remoteCommit, data.conflicts, data.pulled, data.deletedLocal, data.privateTopLevels, data.recipePulls, data.recipeDeletes, data.resolutionReport); break;
    case "GitHubSyncExtensionCompatibilityError":
      error = new GitHubSyncExtensionCompatibilityError(data.requiredVersion, data.installedVersion); break;
    case "GitHubSyncBlockedError":
      error = new GitHubSyncBlockedError(data.requiredVersion, data.installedVersion, data.originalReason); break;
    case "PkmServiceVersionError":
      error = new PkmServiceVersionError(data.requiredVersion, data.installedVersion); break;
    case "PkmServiceOfflineError":
      error = new PkmServiceOfflineError(data.message); break;
    case "PkmServiceRecoveryPersistenceError":
      error = new PkmServiceRecoveryPersistenceError(data.operationId, data.targetId, data.outcome,
        data.primaryError ? reviveError(data.primaryError) : undefined, reviveError(data.persistenceError),
        data.persistenceStage, data.transactionReceiptPath, data.transactionId, data.commit); break;
    default: error = new Error(data?.message || "PKM service request failed."); error.name = data?.name || "Error";
  }
  for (const [key, value] of Object.entries(data || {})) {
    if (error instanceof PkmServiceRecoveryPersistenceError && ["primaryError", "persistenceError"].includes(key)) continue;
    if (!["__proto__", "constructor", "prototype", "stack"].includes(key)) Object.defineProperty(error, key, { value, enumerable: true, configurable: true });
  }
  if (typeof data?.stack === "string") error.stack = data.stack;
  return error;
}

class RpcPeer {
  private buffered: Buffer = Buffer.alloc(0);
  private expected = 0;
  private closed = false;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  handler?: (method: string, value: any, message: WireMessage) => any;
  event?: (method: string, value: any) => void;
  onClose?: () => void;
  constructor(readonly socket: net.Socket, readonly metadata: EndpointMetadata, readonly version: string, private readonly acceptVersion: (version: string) => boolean, private readonly onError: (error: Error) => void = () => {}) {
    socket.on("data", data => {
      try { this.receive(typeof data === "string" ? Buffer.from(data) : data); }
      catch (error) { this.close(error instanceof Error ? error : new Error("Invalid PKM IPC frame.")); }
    });
    socket.on("error", error => this.close(error));
    socket.on("close", () => this.close(new PkmServiceOfflineError("PKM service connection closed. Submitted mutations were not retried; inspect sync recovery records before retrying.")));
  }
  get connected(): boolean { return !this.closed && !this.socket.destroyed; }
  request(method: string, value?: any, timeout = SHORT_TIMEOUT): Promise<any> {
    if (!this.connected) return Promise.reject(new PkmServiceOfflineError());
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`PKM service ${method} timed out. It was not retried; the operation may still be running.`);
        reject(error);
        // A timed-out reverse execution must not leave a live stale host executing.
        if (method === "execute" || method === "shouldExecute") this.close(error);
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ kind: "request", id, method, value }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  emit(method: string, value: any): void {
    try { this.send({ kind: "event", method, value }); }
    catch (error) { this.onError(error instanceof Error ? error : new Error("PKM event delivery failed.")); }
  }
  close(error = new PkmServiceOfflineError()): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    this.socket.destroy();
    this.onClose?.();
  }
  private send(message: Partial<WireMessage>): void {
    if (!this.connected) throw new PkmServiceOfflineError();
    const data = Buffer.from(JSON.stringify(encode({
      ...message, protocol: PKM_SERVICE_PROTOCOL, extensionVersion: this.version,
      identity: this.metadata.identity, nonce: this.metadata.nonce,
    })));
    if (data.length > PKM_SERVICE_MAX_MESSAGE_BYTES) throw new Error("PKM IPC message exceeds the 64 MiB limit.");
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    // Bound queued bytes too; do not accumulate arbitrarily many 64 MiB frames.
    if (this.socket.writableLength + data.length > 2 * PKM_SERVICE_MAX_MESSAGE_BYTES) throw new Error("PKM IPC output queue is full.");
    this.socket.write(Buffer.concat([size, data]));
  }
  private receive(chunk: Buffer): void {
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
    while (true) {
      if (!this.expected) {
        if (this.buffered.length < 4) return;
        this.expected = this.buffered.readUInt32BE(0);
        this.buffered = this.buffered.subarray(4);
        if (!this.expected || this.expected > PKM_SERVICE_MAX_MESSAGE_BYTES) throw new Error("PKM IPC frame exceeds the 64 MiB limit.");
      }
      if (this.buffered.length < this.expected) return;
      const frame = this.buffered.subarray(0, this.expected);
      this.buffered = this.buffered.subarray(this.expected);
      this.expected = 0;
      const message = decode(JSON.parse(frame.toString("utf8"))) as WireMessage;
      if (message.protocol !== PKM_SERVICE_PROTOCOL || message.identity !== this.metadata.identity
        || message.nonce !== this.metadata.nonce || !validVersion(message.extensionVersion) || !this.acceptVersion(message.extensionVersion)) {
        throw new Error("PKM IPC identity/protocol/version validation failed.");
      }
      if (message.kind === "response" && message.id) {
        const pending = this.pending.get(message.id);
        if (pending) {
          clearTimeout(pending.timer); this.pending.delete(message.id);
          if (message.error) pending.reject(reviveError(message.error)); else pending.resolve(message.value);
        }
      } else if (message.kind === "event" && message.method) {
        try { this.event?.(message.method, message.value); }
        catch (error) { this.onError(error instanceof Error ? error : new Error("PKM event callback failed.")); }
      } else if (message.kind === "request" && message.id && message.method) {
        void this.respond(message);
      } else throw new Error("Invalid PKM IPC message.");
    }
  }
  private async respond(message: WireMessage): Promise<void> {
    try {
      if (!this.handler) throw new Error("PKM IPC request handler is unavailable.");
      const value = await this.handler(message.method!, message.value, message);
      this.send({ kind: "response", id: message.id, value });
    } catch (error) {
      if (!this.connected) return;
      try { this.send({ kind: "response", id: message.id, error: errorData(error) }); }
      catch (failure) { this.close(failure instanceof Error ? failure : new Error("PKM response delivery failed.")); }
    }
  }
}

function metadataPath(identity: ServiceIdentity): string { return path.join(identity.serviceDirectory, "endpoint.json"); }
function pinnedVersion(identity: ServiceIdentity): string | undefined {
  const file = path.join(identity.serviceDirectory, "service-version.json");
  try {
    privateFile(file);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value.identity !== identity.identity || value.protocol !== PKM_SERVICE_PROTOCOL || !validVersion(value.extensionVersion)) {
      throw new Error("PKM service version pin failed identity validation.");
    }
    return value.extensionVersion;
  } catch (error: any) { if (error?.code === "ENOENT") return undefined; throw error; }
}
function checkVersionPin(identity: ServiceIdentity, version: string): void {
  const pinned = pinnedVersion(identity);
  if (!pinned) return;
  const order = compareVersionOrder(pinned, version);
  if (order === undefined || order > 0 || (order === 0 && pinned !== version)) throw new PkmServiceVersionError(pinned, version);
}
function pinVersion(identity: ServiceIdentity, version: string): void {
  checkVersionPin(identity, version);
  const file = path.join(identity.serviceDirectory, "service-version.json");
  const staging = `${file}.${randomUUID()}.staging`;
  fs.writeFileSync(staging, JSON.stringify({ identity: identity.identity, protocol: PKM_SERVICE_PROTOCOL, extensionVersion: version }), { mode: 0o600, flag: "wx" });
  try { fs.renameSync(staging, file); } finally { fs.rmSync(staging, { force: true }); }
}
function readMetadata(identity: ServiceIdentity): EndpointMetadata | undefined {
  try {
    privateFile(metadataPath(identity));
    const value = JSON.parse(fs.readFileSync(metadataPath(identity), "utf8")) as EndpointMetadata;
    if (value.identity !== identity.identity || value.endpoint !== identity.endpoint
      || value.knowledgeRoot !== identity.knowledgeRoot || value.globalStoragePath !== identity.globalStoragePath
      || value.stateDirectory !== identity.stateDirectory || value.serviceDirectory !== identity.serviceDirectory
      || value.protocol !== PKM_SERVICE_PROTOCOL || !validVersion(value.extensionVersion)
      || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(value.nonce)) {
      throw new Error("PKM service endpoint metadata failed identity validation.");
    }
    return value;
  } catch (error: any) { if (error?.code === "ENOENT") return undefined; throw error; }
}
async function connectPeer(metadata: EndpointMetadata, version: string): Promise<RpcPeer> {
  if (process.platform !== "win32") {
    const stat = owned(metadata.endpoint);
    if (!stat.isSocket()) throw new Error("PKM endpoint is not a private Unix socket.");
    const directory = owned(path.dirname(metadata.endpoint), true);
    if ((directory.mode & 0o077) !== 0) throw new Error("PKM IPC directory is not private.");
  }
  const socket = net.createConnection(metadata.endpoint);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("PKM endpoint connection timed out.")); }, 3000);
    socket.once("connect", () => { clearTimeout(timer); socket.removeListener("error", rejectConnection); resolve(); });
    function rejectConnection(error: Error): void { clearTimeout(timer); reject(error); }
    socket.once("error", rejectConnection);
  });
  return new RpcPeer(socket, metadata, version, value => value === metadata.extensionVersion);
}

async function lifecycleLock<T>(identity: ServiceIdentity, action: () => Promise<T>, lockName = "lifecycle.lock"): Promise<T> {
  const directory = path.join(identity.serviceDirectory, lockName);
  const recordPath = path.join(directory, "owner.json");
  const nonce = randomUUID(), deadline = Date.now() + LONG_TIMEOUT + SHORT_TIMEOUT;
  while (true) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      fs.writeFileSync(recordPath, JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600, flag: "wx" });
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const stat = owned(directory, true);
      let owner: { pid: number; nonce: string } | undefined;
      try { privateFile(recordPath); owner = JSON.parse(fs.readFileSync(recordPath, "utf8")); }
      catch (failure: any) { if (failure?.code !== "ENOENT") throw failure; }
      // Never expire a lock while its owner is alive, including long idle-upgrade drains.
      if (owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && !alive(owner.pid)) {
        fs.rmSync(directory, { recursive: true });
      } else if (!owner && Date.now() - stat.mtimeMs > SHORT_TIMEOUT) {
        fs.rmdirSync(directory);
      } else if (Date.now() >= deadline) throw new Error("PKM service lifecycle lock timed out.");
      else await delay(50);
    }
  }
  try { return await action(); }
  finally {
    try {
      const owner = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      if (owner.nonce === nonce) { fs.unlinkSync(recordPath); fs.rmdirSync(directory); }
    } catch { /* A subsequent start will recover a dead owner, without stealing a live lock. */ }
  }
}
function cleanupEndpoint(identity: ServiceIdentity, metadata: EndpointMetadata): void {
  if (alive(metadata.pid)) throw new Error("Refusing to unlink a live PKM service endpoint.");
  if (identity.ipcDirectory && fs.existsSync(identity.endpoint)) {
    const stat = owned(identity.endpoint);
    if (!stat.isSocket()) throw new Error("Refusing to unlink an unexpected PKM endpoint file.");
    fs.unlinkSync(identity.endpoint);
  }
  const current = readMetadata(identity);
  if (current?.nonce === metadata.nonce) fs.unlinkSync(metadataPath(identity));
}
async function ensureService(options: PkmServiceClientOptions): Promise<RpcPeer> {
  const identity = pkmServiceIdentity(options);
  prepareDirectories(identity);
  return lifecycleLock(identity, async () => {
    checkVersionPin(identity, options.extensionVersion);
    let existing = readMetadata(identity);
    if (existing) {
      const order = compareVersionOrder(existing.extensionVersion, options.extensionVersion);
      if (order === undefined || order > 0 || (order === 0 && existing.extensionVersion !== options.extensionVersion)) {
        throw new PkmServiceVersionError(existing.extensionVersion, options.extensionVersion);
      }
    }
    if (existing && alive(existing.pid)) {
      const peer = await connectPeer(existing, options.extensionVersion);
      try {
        const health = await peer.request("health");
        if (health.pid !== existing.pid || health.nonce !== existing.nonce) throw new Error("PKM service health identity mismatch.");
        const order = compareVersionOrder(existing.extensionVersion, options.extensionVersion);
        if (order === 0 && existing.extensionVersion === options.extensionVersion) return peer;
        if (order === undefined || order >= 0) throw new PkmServiceVersionError(existing.extensionVersion, options.extensionVersion);
        await peer.request("drain", undefined, LONG_TIMEOUT);
      } catch (error) { peer.close(); throw error; }
      finally { if (existing.extensionVersion !== options.extensionVersion) peer.close(); }
      const deadline = Date.now() + SHORT_TIMEOUT;
      while (alive(existing.pid)) {
        if (Date.now() >= deadline) throw new Error("PKM service drained but did not exit; no replacement was started.");
        await delay(50);
      }
    }
    if (existing) cleanupEndpoint(identity, existing);
    else if (identity.ipcDirectory && fs.existsSync(identity.endpoint)) {
      throw new Error("PKM endpoint has no ownership metadata; refusing to unlink it.");
    }
    const entry = options.serviceEntryPath || path.join(__dirname, "pkm-service-entry.js");
    if (!fs.statSync(entry).isFile()) throw new Error("Bundled PKM service entry is missing.");
    const logPath = path.join(identity.serviceDirectory, "service.log");
    if (fs.existsSync(logPath)) privateFile(logPath);
    const log = fs.openSync(logPath, "a", 0o600);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [entry, JSON.stringify({
        globalStoragePath: identity.globalStoragePath, knowledgeRoot: identity.knowledgeRoot,
        stateDirectory: identity.stateDirectory, extensionVersion: options.extensionVersion,
      })], {
        detached: true, windowsHide: true, stdio: ["ignore", log, log],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        cwd: path.dirname(entry),
      });
    } finally { fs.closeSync(log); }
    let failure: Error | undefined;
    child.on("error", error => { failure = error; });
    child.unref();
    const deadline = Date.now() + SHORT_TIMEOUT;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (child.exitCode !== null) throw new Error("PKM service failed to start; inspect the private service log.");
      existing = readMetadata(identity);
      if (existing) {
        const peer = await connectPeer(existing, options.extensionVersion);
        try {
          const health = await peer.request("health");
          if (health.pid !== existing.pid || health.nonce !== existing.nonce || health.extensionVersion !== options.extensionVersion) throw new Error("PKM service startup identity mismatch.");
          return peer;
        } catch (error) { peer.close(); throw error; }
      }
      await delay(40);
    }
    throw new Error("PKM service startup timed out. No second daemon was started.");
  });
}

interface ExecuteContext { executionId: string; targetId: string; reason: GitHubSyncReason; fencingToken: number; }

export interface PkmServiceRecoveryReceipt {
  operationId: string;
  targetId: string;
  outcome: "success" | "error";
  receiptPath: string;
  reason?: GitHubSyncReason;
  repository?: string;
  branch?: string;
}

/**
 * Independent, account/root-scoped Sync client. Disposal closes this window's
 * connection only; the daemon deliberately survives all extension hosts.
 */
export class PkmServiceClient {
  private peer?: RpcPeer;
  private disposed = false;
  private readonly ready: Promise<void>;
  private reconnecting?: Promise<void>;
  private intentionalDrain = false;
  private runtime: Record<string, GitHubSyncRuntimeState> = {};
  private readonly execution = new AsyncLocalStorage<ExecuteContext>();
  private readonly progress = new Map<string, Progress>();
  constructor(private readonly options: PkmServiceClientOptions) {
    this.ready = this.initialize();
    void this.ready.catch(error => this.handleError(error));
  }
  static async connect(options: PkmServiceClientOptions): Promise<PkmServiceClient> {
    const client = new PkmServiceClient(options);
    await client.ready;
    return client;
  }
  async configure(targets: AutomaticGitHubSyncTarget[]): Promise<void> { await this.rpc("configure", targets, LONG_TIMEOUT); }
  async request(targetId: string, reason: GitHubSyncReason): Promise<boolean> { return this.rpc("request", { targetId, reason }, LONG_TIMEOUT); }
  report(targetId: string, phase: Phase, detail?: string): void {
    const active = this.execution.getStore();
    void this.rpc("report", { targetId, phase, detail, executionId: active?.executionId }).catch(error => this.handleError(error));
  }
  notifyContentChanged(excludedTargetId?: string): void {
    void this.rpc("notifyContentChanged", { excludedTargetId }, LONG_TIMEOUT).catch(error => this.handleError(error));
  }
  snapshot(): Record<string, GitHubSyncRuntimeState> {
    return JSON.parse(JSON.stringify(this.runtime));
  }
  async sync(target: GitHubSyncTarget, catalog: GitHubSyncCatalog, checkoutRoot: string, credentials?: GitHubSyncCredentials, storeRoot?: string, onProgress?: Progress, options?: GitHubSyncExecutionOptions): Promise<GitHubSyncResult> {
    const active = this.execution.getStore();
    if (!active || target.id !== active.targetId) throw new Error("PKM sync is allowed only inside this client's assigned active execute callback.");
    const operationId = randomUUID();
    this.progress.set(operationId, onProgress ? (phase, detail) =>
      this.execution.run(active, () => onProgress(phase, detail)) : undefined);
    try {
      return await this.rpc("sync", { ...active, operationId, target, catalog, checkoutRoot, credentials, storeRoot, options }, LONG_TIMEOUT);
    } finally { this.progress.delete(operationId); }
  }
  async listRecoverableResults(): Promise<PkmServiceRecoveryReceipt[]> {
    return this.rpc("listRecoverableResults");
  }
  async recoverSyncResult(operationId: string): Promise<GitHubSyncResult> { return this.rpc("recoverSyncResult", { operationId }); }
  async acknowledgeRecoveredResult(operationId: string): Promise<void> { await this.rpc("acknowledgeRecoveredResult", { operationId }); }
  async acknowledgeExecutionErrors(targetId: string): Promise<void> {
    const active = this.execution.getStore();
    await this.rpc("acknowledgeExecutionErrors", { targetId, executionId: active?.executionId });
  }
  /** Administrative safe-idle shutdown, intended for upgrades and tests, not host disposal. */
  async drain(): Promise<void> {
    this.intentionalDrain = true;
    try { await this.rpc("drain", undefined, LONG_TIMEOUT); }
    catch (error) { this.intentionalDrain = false; throw error; }
  }
  dispose(): void { this.disposed = true; this.peer?.close(); this.progress.clear(); }
  private handleError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (this.options.onError) { try { this.options.onError(normalized); } catch { /* Error callbacks must not reject the transport. */ } }
    else console.error("[PKM service] operation failed; configure onError to receive details.");
  }
  private async initialize(): Promise<void> {
    const peer = await ensureService(this.options);
    if (this.disposed) { peer.close(); throw new PkmServiceOfflineError("PKM client was disposed during startup."); }
    this.peer = peer;
    peer.handler = async (method, value) => {
      if (this.disposed) throw new PkmServiceOfflineError();
      switch (method) {
        case "shouldExecute": return this.options.shouldExecute ? this.options.shouldExecute(value.targetId, value.reason) : true;
        case "execute":
          return this.execution.run(value, async () => {
            try { await this.options.execute(value.targetId, value.reason, value.fencingToken); }
            catch (error) {
              const detail = errorData(error);
              if (this.options.shouldRetryFailure) detail.serviceShouldRetry = this.options.shouldRetryFailure(error);
              if (this.options.compatibilityBlock) detail.serviceCompatibilityBlock = this.options.compatibilityBlock(error);
              throw reviveError(detail);
            }
          });
        case "onAutoPaused": return this.options.onAutoPaused?.(value.targetId);
        default: throw new Error("Unknown PKM reverse callback.");
      }
    };
    peer.event = (method, value) => {
      if (method === "onState") {
        this.runtime[value.targetId] = value.state;
        this.options.onState?.(value.targetId, value.state);
      } else if (method === "progress") {
        this.progress.get(value.operationId)?.(value.phase, value.detail);
      } else if (method === "onError") this.handleError(reviveError(value));
    };
    try { this.runtime = await peer.request("register", undefined, LONG_TIMEOUT); }
    catch (error) { peer.close(); throw error; }
    peer.onClose = () => {
      if (this.disposed || this.intentionalDrain) return;
      this.handleError(new PkmServiceOfflineError("PKM service disconnected. Pending operations failed explicitly and were not retried; an idle connection restart is being attempted."));
      if (!this.reconnecting) {
        this.reconnecting = delay(100).then(async () => {
          if (!this.disposed) await this.initialize();
        }).catch(error => this.handleError(error)).finally(() => { this.reconnecting = undefined; });
      }
    };
  }
  private async rpc(method: string, value?: any, timeout = SHORT_TIMEOUT): Promise<any> {
    await this.ready;
    await this.reconnecting;
    if (this.disposed || !this.peer) throw new PkmServiceOfflineError("PKM client is disposed.");
    return this.peer.request(method, value, timeout);
  }
}

interface Connection { peer: RpcPeer; registered: boolean; version?: string; }
interface ActiveExecution extends ExecuteContext {
  connection: Connection;
  syncs: Set<Promise<any>>;
  operations: Set<string>;
  persistedOperations: Set<string>;
  persistenceFailure?: PkmServiceRecoveryPersistenceError;
  accepting: boolean;
}
interface RecoveryRecord {
  schema: 1;
  operationId: string;
  targetId: string;
  outcome: "success" | "error";
  reason?: GitHubSyncReason;
  repository?: string;
  branch?: string;
  result?: GitHubSyncResult;
  error?: any;
}

/** Daemon-only runtime: never instantiate in the extension host. */
export async function startPkmService(options: PkmServiceBootOptions): Promise<{ metadata: EndpointMetadata; stopped: Promise<void> }> {
  const identity = pkmServiceIdentity(options);
  prepareDirectories(identity);
  // A second lock protects the child startup gap if the spawning host exits
  // before publication. It does not depend on that host's lifecycle lock.
  return lifecycleLock(identity, () => startPkmServiceRuntime(options), "startup.lock");
}

async function startPkmServiceRuntime(options: PkmServiceBootOptions): Promise<{ metadata: EndpointMetadata; stopped: Promise<void> }> {
  const identity = pkmServiceIdentity(options);
  prepareDirectories(identity);
  checkVersionPin(identity, options.extensionVersion);
  const previous = readMetadata(identity);
  if (previous && alive(previous.pid)) throw new Error("A PKM service already owns this endpoint.");
  if (previous) cleanupEndpoint(identity, previous);
  if (identity.ipcDirectory && fs.existsSync(identity.endpoint)) throw new Error("Refusing to overwrite a PKM socket without owner metadata.");
  const metadata: EndpointMetadata = { ...identity, protocol: PKM_SERVICE_PROTOCOL, extensionVersion: options.extensionVersion, pid: process.pid, nonce: randomUUID() };
  pinVersion(identity, options.extensionVersion);
  const connections = new Set<Connection>();
  const selected = new Map<string, Connection>();
  const initiating = new Map<string, { connection: Connection; reason: GitHubSyncReason }>();
  const active = new Map<string, ActiveExecution>();
  const recoveryDirectory = path.join(identity.serviceDirectory, "results");
  privateDirectory(recoveryDirectory);
  const drainWaiters = new Set<(stopped: boolean) => void>();
  let draining = false, reverseCount = 0;
  let stopResolve!: () => void;
  const stopped = new Promise<void>(resolve => { stopResolve = resolve; });
  function notifyError(connection: Connection, error: unknown): void { connection.peer.emit("onError", errorData(error)); }
  function matching(connection: Connection): boolean {
    return connection.registered && connection.version === options.extensionVersion && connection.peer.connected;
  }
  function choose(targetId: string, reason: GitHubSyncReason): Connection {
    if (draining) throw new PkmServiceOfflineError("PKM service is draining for a safe-idle upgrade; new sync callbacks are suspended.");
    if (reason === "manual" || reason === "force-local-authority") {
      const requester = initiating.get(targetId);
      if (!requester || requester.reason !== reason || !matching(requester.connection)) throw new PkmServiceOfflineError("The extension host that requested this manual/force sync is disconnected. Resubmit explicitly from a live matching-version window.");
      return requester.connection;
    }
    const client = [...connections].find(matching);
    if (!client) throw new PkmServiceOfflineError();
    return client;
  }
  async function reverse(connection: Connection, method: string, value: any): Promise<any> {
    reverseCount++;
    try { return await connection.peer.request(method, value, LONG_TIMEOUT); }
    finally { reverseCount--; }
  }
  const coordinatorOptions: GitHubSyncCoordinatorOptions & { independentService: boolean } = {
    stateDirectory: identity.stateDirectory, knowledgeRoot: identity.knowledgeRoot,
    extensionVersion: options.extensionVersion, independentService: true,
    shouldExecute: async (targetId, reason) => {
      if (draining) return new Promise<boolean>((resolve, reject) => {
        drainWaiters.add(stopped => {
          if (stopped) resolve(false);
          else void coordinatorOptions.shouldExecute!(targetId, reason).then(resolve, reject);
        });
      });
      const connection = choose(targetId, reason);
      selected.set(targetId, connection);
      try {
        const result = await reverse(connection, "shouldExecute", { targetId, reason });
        if (typeof result !== "boolean") throw new Error("PKM shouldExecute callback must return a boolean.");
        if (!result) {
          selected.delete(targetId);
          if (initiating.get(targetId)?.connection === connection && initiating.get(targetId)?.reason === reason) initiating.delete(targetId);
        }
        return result;
      } catch (error) { selected.delete(targetId); throw error; }
    },
    execute: async (targetId, reason, fencingToken) => {
      const connection = selected.get(targetId);
      selected.delete(targetId);
      if (!connection || !matching(connection)) throw new PkmServiceOfflineError("The selected Sync host disconnected before execution.");
      if (initiating.get(targetId)?.connection === connection && initiating.get(targetId)?.reason === reason) initiating.delete(targetId);
      const execution: ActiveExecution = { executionId: randomUUID(), targetId, reason, fencingToken, connection, syncs: new Set(), operations: new Set(), persistedOperations: new Set(), accepting: true };
      active.set(execution.executionId, execution);
      let succeeded = false;
      try {
        await reverse(connection, "execute", { executionId: execution.executionId, targetId, reason, fencingToken });
        succeeded = true;
      } finally {
        execution.accepting = false;
        // A push cannot be cancelled safely on host disconnect. Keep the lease
        // and drain barrier until raw sync settles and its result is durable.
        await Promise.allSettled([...execution.syncs]);
        active.delete(execution.executionId);
        if (succeeded) for (const operationId of execution.persistedOperations) fs.rmSync(resultPath(operationId), { force: true });
        else if (execution.persistedOperations.size) {
          const records = [...execution.persistedOperations].map(operationId => {
            const record = readResult(operationId);
            return `${record.outcome === "success" ? "Sync completed but host postprocessing did not complete" : "Sync failed; its original error is saved"}: operation ${operationId}, recovery record ${resultPath(operationId)}`;
          });
          for (const client of connections) if (matching(client)) notifyError(client, new Error(`${records.join("; ")}. Inspect the checkout's GitHub Sync transaction receipt before retrying.`));
        }
        if (execution.persistenceFailure) throw execution.persistenceFailure;
      }
    },
    shouldRetryFailure: error => {
      const detail = error as any;
      if (detail?.name === "GitHubSyncConflictError" || detail?.name === "PkmServiceRecoveryPersistenceError") return false;
      return detail?.serviceShouldRetry !== false;
    },
    compatibilityBlock: error => {
      if (error instanceof GitHubSyncExtensionCompatibilityError) return { requiredVersion: error.requiredVersion, installedVersion: error.installedVersion };
      return (error as any)?.serviceCompatibilityBlock;
    },
    onAutoPaused: targetId => {
      const connection = [...connections].find(matching);
      if (connection) void reverse(connection, "onAutoPaused", { targetId }).catch(error => notifyError(connection, error));
    },
    onState: (targetId, state) => {
      for (const connection of connections) if (matching(connection)) connection.peer.emit("onState", { targetId, state: executorState(state) });
    },
  };
  const coordinator = new GitHubSyncCoordinator(coordinatorOptions);
  function executorState(state: GitHubSyncRuntimeState): GitHubSyncRuntimeState {
    return { ...state, service: { pid: process.pid, version: options.extensionVersion, protocol: PKM_SERVICE_PROTOCOL } } as GitHubSyncRuntimeState;
  }
  function snapshot(): Record<string, GitHubSyncRuntimeState> {
    return Object.fromEntries(Object.entries(coordinator.snapshot()).map(([targetId, state]) => [targetId, executorState(state)]));
  }
  async function leadership(): Promise<void> {
    const deadline = Date.now() + LONG_TIMEOUT;
    while (!coordinator.isLeader()) {
      if (draining) throw new PkmServiceOfflineError("PKM service is draining.");
      if (Date.now() >= deadline) throw new Error("PKM service is still waiting for legacy Sync leadership; nothing was submitted.");
      await delay(100);
    }
    if (draining) throw new PkmServiceOfflineError("PKM service is draining.");
  }
  function resultPath(operationId: string): string {
    if (!/^[a-f0-9-]{36}$/.test(operationId)) throw new Error("Invalid PKM recovery operation ID.");
    return path.join(recoveryDirectory, `${operationId}.json`);
  }
  function readResult(operationId: string): RecoveryRecord {
    const file = resultPath(operationId);
    privateFile(file);
    if (fs.statSync(file).size > PKM_SERVICE_MAX_MESSAGE_BYTES) throw new Error("PKM recovery record exceeds the 64 MiB limit.");
    const record = decode(JSON.parse(fs.readFileSync(file, "utf8"))) as RecoveryRecord;
    if (record.schema !== 1 || record.operationId !== operationId) throw new Error("Invalid PKM recovery record.");
    return record;
  }
  function persistResult(record: RecoveryRecord, credentials?: GitHubSyncCredentials): void {
    let json = JSON.stringify(encode(record));
    if (credentials?.accessToken) json = json.split(credentials.accessToken).join("[REDACTED]");
    if (Buffer.byteLength(json) > PKM_SERVICE_MAX_MESSAGE_BYTES) throw new Error("PKM result exceeds the 64 MiB recovery limit; inspect the checkout transaction receipt.");
    const file = resultPath(record.operationId), staging = `${file}.${randomUUID()}.staging`;
    let fd: number | undefined;
    let stage = "create";
    let failure: Error | undefined;
    const capture = (error: unknown): void => {
      const detail = error instanceof Error ? error : new Error(String(error));
      failure = failure ? Object.assign(new Error(`${failure.message}; cleanup failed: ${detail.message}`),
        { primaryError: failure, cleanupError: detail }) : detail;
      Object.defineProperty(failure, "persistenceStage", { value: stage, enumerable: true, configurable: true });
    };
    try {
      fd = fs.openSync(staging, "wx", 0o600);
      stage = "write";
      fs.writeFileSync(fd, json, "utf8");
      stage = "fsync";
      fs.fsyncSync(fd);
      stage = "close";
      fs.closeSync(fd);
      fd = undefined;
      stage = "rename";
      fs.renameSync(staging, file);
    } catch (error) {
      capture(error);
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch (error) { stage = "close"; capture(error); }
      }
      try { fs.rmSync(staging, { force: true }); } catch (error) { stage = "cleanup"; capture(error); }
    }
    if (failure) throw failure;
  }
  function assignment(connection: Connection, value: any): ActiveExecution {
    const execution = active.get(value?.executionId);
    if (!execution || execution.connection !== connection || execution.targetId !== value.targetId
      || !execution.accepting || !matching(connection)) throw new Error("PKM request is not authorized by an active assigned execute callback.");
    return execution;
  }
  let drainPromise: Promise<void> | undefined;
  function drain(): Promise<void> {
    if (drainPromise) return drainPromise;
    draining = true;
    drainPromise = (async () => {
      const deadline = Date.now() + LONG_TIMEOUT;
      while (active.size || reverseCount || Object.values(coordinator.snapshot()).some(state => state.status === "syncing")) {
        if (Date.now() >= deadline) {
          draining = false; drainPromise = undefined;
          for (const resume of drainWaiters) resume(false);
          drainWaiters.clear();
          throw new Error("PKM safe-idle upgrade timed out; active Sync was not killed and no replacement may start.");
        }
        await delay(50);
      }
      coordinator.dispose();
      for (const resume of drainWaiters) resume(true);
      drainWaiters.clear();
      // Give the drain response a turn to flush before closing its connection.
      setTimeout(() => {
        for (const connection of connections) connection.peer.close();
        server.close(() => {
          const current = readMetadata(identity);
          if (current?.nonce === metadata.nonce) fs.unlinkSync(metadataPath(identity));
          if (identity.ipcDirectory) {
            if (fs.existsSync(identity.endpoint)) { owned(identity.endpoint); fs.unlinkSync(identity.endpoint); }
            try { fs.rmdirSync(identity.ipcDirectory); } catch { /* An unexpected file is never removed. */ }
          }
          stopResolve();
        });
      }, 25);
    })();
    return drainPromise;
  }
  const server = net.createServer(socket => {
    const peer = new RpcPeer(socket, metadata, options.extensionVersion, version => validVersion(version) && (!connection.version || connection.version === version));
    const connection: Connection = { peer, registered: false };
    connections.add(connection);
    peer.onClose = () => { connections.delete(connection); };
    peer.handler = async (method, value, message) => {
      if (connection.version && connection.version !== message.extensionVersion) throw new Error("PKM client changed its version within a connection.");
      connection.version = message.extensionVersion;
      if (method === "health") return { pid: process.pid, nonce: metadata.nonce, extensionVersion: options.extensionVersion, draining, activeExecutions: active.size };
      if (method === "drain") {
        const order = compareVersionOrder(message.extensionVersion, options.extensionVersion);
        if (order === undefined || order < 0) throw new PkmServiceVersionError(options.extensionVersion, message.extensionVersion);
        await drain(); return undefined;
      }
      if (message.extensionVersion !== options.extensionVersion) throw new PkmServiceVersionError(options.extensionVersion, message.extensionVersion);
      if (method === "register") {
        if (draining) throw new PkmServiceOfflineError("PKM service is draining.");
        await leadership();
        connection.registered = true;
        return snapshot();
      }
      if (!connection.registered) throw new Error("PKM client must register before submitting operations.");
      if (draining && !["sync", "report"].includes(method)) throw new PkmServiceOfflineError("PKM service is draining; no new mutations were accepted.");
      switch (method) {
        case "configure":
          await leadership();
          if (!Array.isArray(value)) throw new Error("PKM configure requires target definitions.");
          coordinator.configure(value);
          for (const client of connections) if (matching(client)) for (const [targetId, state] of Object.entries(snapshot())) client.peer.emit("onState", { targetId, state });
          return undefined;
        case "request": {
          await leadership();
          if (!["startup", "interval", "change", "configuration", "manual", "force-local-authority"].includes(value?.reason) || typeof value.targetId !== "string") throw new Error("Invalid PKM Sync request.");
          const accepted = coordinator.request(value.targetId, value.reason);
          if (accepted && (value.reason === "manual" || value.reason === "force-local-authority")) initiating.set(value.targetId, { connection, reason: value.reason });
          return accepted;
        }
        case "report":
          assignment(connection, value);
          coordinator.report(value.targetId, value.phase, value.detail); return undefined;
        case "acknowledgeExecutionErrors": {
          const execution = assignment(connection, value);
          for (const operationId of [...execution.persistedOperations]) {
            if (readResult(operationId).outcome !== "error") continue;
            fs.unlinkSync(resultPath(operationId));
            execution.persistedOperations.delete(operationId);
          }
          return undefined;
        }
        case "notifyContentChanged":
          await leadership(); coordinator.notifyContentChanged(value?.excludedTargetId); return undefined;
        case "sync": {
          const execution = assignment(connection, value);
          if (value.fencingToken !== execution.fencingToken || value.target?.id !== execution.targetId) throw new Error("PKM sync fencing token or target mismatch.");
          if (execution.syncs.size) throw new Error("Only one raw Sync operation may run per execute callback at a time.");
          resultPath(value.operationId);
          if (execution.operations.has(value.operationId) || fs.existsSync(resultPath(value.operationId))) throw new Error("PKM raw Sync operation was already submitted; it will not be retried.");
          if (canonicalKnowledgeRoot(value.storeRoot || identity.knowledgeRoot) !== identity.knowledgeRoot) throw new Error("PKM sync storeRoot differs from the service's canonical Knowledge Root.");
          const task = (async () => {
            execution.operations.add(value.operationId);
            const receipt = {
              schema: 1 as const, operationId: value.operationId, targetId: execution.targetId,
              reason: execution.reason, repository: value.target.repository, branch: value.target.branch,
            };
            const persistenceFailure = (error: unknown, primaryError?: Error, result?: GitHubSyncResult): PkmServiceRecoveryPersistenceError => {
              const secondary = reviveError(redactError(error, value.credentials));
              const stage = "persistenceStage" in secondary && typeof secondary.persistenceStage === "string" ? secondary.persistenceStage : "serialization";
              const failure = new PkmServiceRecoveryPersistenceError(value.operationId, execution.targetId,
                primaryError ? "error" : "success", primaryError, secondary, stage,
                path.join(value.checkoutRoot, execution.targetId, "transactions", "latest.json"), result?.transactionId, result?.commit);
              console.error("PKM_SERVICE_RECOVERY_PERSISTENCE_FAILED", JSON.stringify(errorData(failure)));
              execution.persistenceFailure = failure;
              return failure;
            };
            let result: GitHubSyncResult;
            try {
              result = await syncGitHubTarget(value.target, value.catalog, value.checkoutRoot, value.credentials, identity.knowledgeRoot,
                (phase, detail) => peer.emit("progress", { operationId: value.operationId, phase, detail }), value.options);
            } catch (error) {
              const safeError = redactError(error, value.credentials);
              try {
                persistResult({ ...receipt, outcome: "error", error: safeError }, value.credentials);
                execution.persistedOperations.add(value.operationId);
              } catch (persistenceError) {
                throw persistenceFailure(persistenceError, reviveError(safeError));
              }
              throw reviveError(safeError);
            }
            try {
              persistResult({ ...receipt, outcome: "success", result }, value.credentials);
              execution.persistedOperations.add(value.operationId);
            } catch (error) {
              throw persistenceFailure(error, undefined, result);
            }
            return result;
          })();
          execution.syncs.add(task);
          try { return await task; } finally { execution.syncs.delete(task); }
        }
        case "listRecoverableResults":
          return fs.readdirSync(recoveryDirectory).filter(file => /^[a-f0-9-]{36}\.json$/.test(file)
            && ![...active.values()].some(execution => execution.operations.has(file.slice(0, -5)))).map(file => {
            const record = readResult(file.slice(0, -5));
            return {
              operationId: record.operationId, targetId: record.targetId, outcome: record.outcome,
              receiptPath: path.join(recoveryDirectory, file),
              reason: record.reason, repository: record.repository, branch: record.branch,
            };
          });
        case "recoverSyncResult": {
          if ([...active.values()].some(execution => execution.operations.has(value.operationId))) throw new Error("Cannot recover a result while its original execute callback is active.");
          const record = readResult(value.operationId);
          if (record.error) throw reviveError(record.error);
          return record.result;
        }
        case "acknowledgeRecoveredResult":
          if ([...active.values()].some(execution => execution.operations.has(value.operationId))) throw new Error("Cannot acknowledge a result while its execute callback is active.");
          privateFile(resultPath(value.operationId)); fs.unlinkSync(resultPath(value.operationId)); return undefined;
        default: throw new Error("Unknown PKM service operation.");
      }
    };
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(identity.endpoint, () => { server.removeListener("error", reject); resolve(); });
    });
    if (identity.ipcDirectory) fs.chmodSync(identity.endpoint, 0o600);
    const staging = path.join(identity.serviceDirectory, `endpoint.${metadata.nonce}.staging`);
    fs.writeFileSync(staging, JSON.stringify(metadata), { mode: 0o600, flag: "wx" });
    try {
      if (fs.existsSync(metadataPath(identity))) throw new Error("PKM endpoint metadata already has an owner.");
      fs.renameSync(staging, metadataPath(identity));
    } finally { fs.rmSync(staging, { force: true }); }
  } catch (error) {
    coordinator.dispose(); server.close(); throw error;
  }
  server.on("error", () => { for (const connection of connections) notifyError(connection, new Error("PKM private IPC listener failed.")); });
  return { metadata, stopped };
}
