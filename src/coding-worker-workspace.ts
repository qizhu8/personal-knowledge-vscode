import { createHash, randomUUID } from "node:crypto";
import {
  constants, closeSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ManagerOwner } from "./manager-runtime.js";
import { toolArgumentsDigest } from "./tool-gateway.js";
import {
  CODING_WORKER_LIMITS as L, codingWorkerPath,
  type CodingWorkerChange, type CodingWorkerFile, type CodingWorkerReceipt,
} from "./domain/coding-worker-contracts.js";

export const codingWorkerHash = (text: string) => createHash("sha256").update(text).digest("hex");
export const codingWorkerPin = (value: unknown) => toolArgumentsDigest(value);
export const codingWorkerFail = (code: string): never => { throw new Error(`CODING_WORKER_${code}`); };
export interface CodingWorkerWorkspaceCapability { readonly kind: "host-disposable-coding-workspace" }
export interface CodingWorkerCheckCommand {
  id: string; script: string; args: readonly string[]; taskIds: readonly string[]; acceptanceIds: readonly string[]; e2e: boolean;
}
export interface CodingWorkerWorkspaceOptions {
  db: DatabaseSync;
  /** Dedicated host-owned process journal; never take over another runtime's singleton process lease. */
  processDatabase: DatabaseSync;
  transaction<T>(fn: () => T): T;
  workspaceId: string;
  owner: Readonly<ManagerOwner>;
  /** Host attestation: both directories belong to disposable source fixtures, not KnowledgeRoot or a checkout target. */
  authorizedDisposable: true;
  sourceRoot: string;
  stageParent: string;
  files: readonly { path: string; beforeHash: string; writable: boolean }[];
  checks: readonly CodingWorkerCheckCommand[];
  /** Called before source context/journal persistence and before running native checks. */
  authorizeSource(files: readonly CodingWorkerFile[], owner: Readonly<ManagerOwner>): boolean;
  authorizeCheck(input: Readonly<{ owner: ManagerOwner; runId: string; taskId?: string; commandId: string; sourcePin: string }>): boolean;
  redactOutput(output: unknown, commandId: string): unknown;
  assertLease?(): void;
  receipt?(receipt: Readonly<CodingWorkerReceipt>): void;
  /** Fault injection is host-only; throwing leaves durable intent and never enables replay. */
  fault?(point: "intent" | "after-file" | "after-files", effectId: string): void;
}
export interface CodingWorkerStage {
  id: string; root: string; before: CodingWorkerFile[];
}
interface FileIntent {
  owner: ManagerOwner; workspaceId: string; runId: string; taskId?: string;
  effectId: string; stage: string; changes: CodingWorkerChange[];
  state: "intent" | "complete" | "unknown"; observation?: "before" | "after" | "mixed" | "other";
}
export interface CodingWorkerWorkspaceState {
  options: CodingWorkerWorkspaceOptions; parent: string; originals: CodingWorkerFile[];
  writable: Set<string>; stages: Map<string, CodingWorkerStage>;
  integrator: CodingWorkerStage; fenced: Set<string>; hostBound?: boolean;
}
const capabilities = new WeakMap<object, CodingWorkerWorkspaceState>();
export function codingWorkerState(capability: CodingWorkerWorkspaceCapability): CodingWorkerWorkspaceState {
  const value = capabilities.get(capability);
  if (!value) return codingWorkerFail("CAPABILITY_REQUIRED");
  value.options.assertLease?.();
  assertRoot(value.parent);
  return value;
}
function assertRoot(root: string) {
  if (!isAbsolute(root) || realpathSync(root) !== root || !lstatSync(root).isDirectory()
    || lstatSync(root).isSymbolicLink()) codingWorkerFail("ROOT_CHANGED");
}
function canonicalDirectory(path: string) {
  if (!isAbsolute(path)) codingWorkerFail("ABSOLUTE_HOST_ROOT_REQUIRED");
  const actual = realpathSync(path);
  // Reject symlinks in every component, including ancestors of an otherwise canonical root.
  let current = resolve(path);
  while (true) {
    if (lstatSync(current).isSymbolicLink()) codingWorkerFail("SYMLINK");
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  if (actual !== resolve(path) || !statSync(actual).isDirectory()) codingWorkerFail("ROOT");
  return actual;
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function filePath(root: string, path: string, createParents = false) {
  assertRoot(root);
  if (!codingWorkerPath(path)) codingWorkerFail("PATH");
  const parts = path.split("/");
  let directory = root;
  for (const part of parts.slice(0, -1)) {
    directory = resolve(directory, part);
    if (createParents && !existsSync(directory)) {
      mkdirSync(directory, { mode: 0o700 });
      syncDirectory(resolve(directory, ".."));
    }
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()
      || realpathSync(directory) !== directory) codingWorkerFail("SYMLINK");
  }
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) codingWorkerFail("PATH");
  if (existsSync(target) || (() => { try { lstatSync(target); return true; } catch { return false; } })()) {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > L.fileBytes)
      codingWorkerFail("UNSAFE_FILE");
  }
  return target;
}
export function codingWorkerRead(root: string, path: string): CodingWorkerFile {
  const target = filePath(root, path);
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > L.fileBytes) codingWorkerFail("UNSAFE_FILE");
    const raw = readFileSync(fd);
    if (raw.byteLength > L.fileBytes) codingWorkerFail("SOURCE_LIMIT");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    if (content.includes("\0")) codingWorkerFail("BINARY_SOURCE");
    return { path, content, hash: codingWorkerHash(content) };
  } finally { closeSync(fd); }
}
export function codingWorkerSnapshot(state: CodingWorkerWorkspaceState, stage: CodingWorkerStage) {
  state.options.assertLease?.();
  const files = state.originals.map(file => codingWorkerRead(stage.root, file.path));
  if (Buffer.byteLength(JSON.stringify(files)) > L.sourceBytes
    || state.options.authorizeSource(files, state.options.owner) !== true) codingWorkerFail("SOURCE_POLICY");
  return files;
}
export function codingWorkerAtomic<T>(state: CodingWorkerWorkspaceState, fn: () => T): T {
  state.options.assertLease?.();
  if (state.options.db.isTransaction) codingWorkerFail("TRANSACTION_BOUNDARY");
  const value = state.options.transaction(fn);
  if (value && typeof (value as { then?: unknown }).then === "function") codingWorkerFail("ASYNC_TRANSACTION");
  return value;
}
export function initializeCodingWorkerSchema(db: DatabaseSync): void {
  if (!db.isTransaction) codingWorkerFail("TRANSACTION_REQUIRED");
  db.exec(`
    CREATE TABLE IF NOT EXISTS coding_worker_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);
    INSERT OR IGNORE INTO coding_worker_schema VALUES(1,1);
    CREATE TABLE IF NOT EXISTS coding_worker_effects(
      workspace_id TEXT NOT NULL,effect_id TEXT NOT NULL,state TEXT NOT NULL,record TEXT NOT NULL,
      PRIMARY KEY(workspace_id,effect_id));
    CREATE TABLE IF NOT EXISTS coding_worker_records(
      workspace_id TEXT NOT NULL,kind TEXT NOT NULL,key TEXT NOT NULL,record TEXT NOT NULL,
      PRIMARY KEY(workspace_id,kind,key));
    CREATE TABLE IF NOT EXISTS coding_worker_budget(
      workspace_id TEXT NOT NULL,run_id TEXT NOT NULL,turns INTEGER NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,
      PRIMARY KEY(workspace_id,run_id));
  `);
  if (db.prepare("SELECT version FROM coding_worker_schema WHERE singleton=1").get()?.version !== 1)
    codingWorkerFail("UNSUPPORTED_SCHEMA");
}
function receipt(state: CodingWorkerWorkspaceState, intent: FileIntent, outcome: CodingWorkerReceipt["outcome"]) {
  const result: unknown = state.options.receipt?.(Object.freeze({
    workspaceId: intent.workspaceId, runId: intent.runId, ...(intent.taskId ? { taskId: intent.taskId } : {}),
    effectId: intent.effectId, kind: outcome === "intent" ? "file-intent" : "file-complete",
    pin: codingWorkerPin(intent.changes), outcome,
  }));
  if (result && typeof (result as { then?: unknown }).then === "function") codingWorkerFail("ASYNC_RECEIPT");
}
function putIntent(state: CodingWorkerWorkspaceState, intent: FileIntent, insert: boolean) {
  codingWorkerAtomic(state, () => {
    if (insert) state.options.db.prepare("INSERT INTO coding_worker_effects VALUES(?,?,?,?)")
      .run(state.options.workspaceId, intent.effectId, intent.state, JSON.stringify(intent));
    else state.options.db.prepare("UPDATE coding_worker_effects SET state=?,record=? WHERE workspace_id=? AND effect_id=?")
      .run(intent.state, JSON.stringify(intent), state.options.workspaceId, intent.effectId);
    receipt(state, intent, intent.state);
  });
}
/** Exact synchronous replacement; journal commit always precedes the first directory/file effect. */
export function codingWorkerWrite(
  state: CodingWorkerWorkspaceState, stage: CodingWorkerStage, changes: CodingWorkerChange[],
  binding: { runId: string; taskId?: string; effectId: string }, signal: AbortSignal, creating = false,
) {
  if (state.options.db.prepare("SELECT 1 FROM coding_worker_effects WHERE workspace_id=? AND effect_id=?")
    .get(state.options.workspaceId, binding.effectId)) codingWorkerFail("EFFECT_REPLAY_FORBIDDEN");
  if (signal.aborted || state.fenced.has(binding.runId)) codingWorkerFail("FENCED");
  if (!changes.length || new Set(changes.map(file => file.path)).size !== changes.length) codingWorkerFail("CHANGES");
  for (const change of changes) {
    if (!codingWorkerPath(change.path) || !state.originals.some(file => file.path === change.path)
      || change.afterHash !== codingWorkerHash(change.after) || change.beforeHash !== codingWorkerHash(change.before)
      || Buffer.byteLength(change.after) > L.fileBytes) codingWorkerFail("CHANGES");
    if (!creating && codingWorkerRead(stage.root, change.path).hash !== change.beforeHash) codingWorkerFail("BEFORE_HASH");
  }
  const intent: FileIntent = {
    owner: { ...state.options.owner }, workspaceId: state.options.workspaceId, ...binding,
    stage: stage.id, changes, state: "intent",
  };
  putIntent(state, intent, true);
  try {
    state.options.fault?.("intent", binding.effectId);
    if (creating) {
      assertRoot(state.parent);
      mkdirSync(stage.root, { mode: 0o700 });
      syncDirectory(state.parent);
    }
    for (const change of changes) {
      if (signal.aborted || state.fenced.has(binding.runId)) codingWorkerFail("FENCED");
      if (!creating && codingWorkerRead(stage.root, change.path).hash !== change.beforeHash) codingWorkerFail("BEFORE_HASH");
      const target = filePath(stage.root, change.path, creating);
      const staging = resolve(stage.root, `.coding-${randomUUID()}`);
      const fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, change.after, "utf8"); fsyncSync(fd); }
      finally { closeSync(fd); }
      try {
        filePath(stage.root, change.path);
        if (!creating && codingWorkerRead(stage.root, change.path).hash !== change.beforeHash) codingWorkerFail("BEFORE_HASH");
        renameSync(staging, target);
        syncDirectory(resolve(target, ".."));
      } finally { if (existsSync(staging)) unlinkSync(staging); }
      state.options.fault?.("after-file", binding.effectId);
    }
    state.options.fault?.("after-files", binding.effectId);
    if (signal.aborted || state.fenced.has(binding.runId)) codingWorkerFail("FENCED");
    intent.state = "complete"; putIntent(state, intent, false);
  } catch (error) {
    // Files may have changed. Never roll back or repair them from an interrupted journal.
    state.fenced.add(binding.runId);
    throw error;
  }
}
export function codingWorkerClone(state: CodingWorkerWorkspaceState, binding: { runId: string; taskId?: string; effectId: string }, signal: AbortSignal) {
  const id = `stage-${randomUUID()}`;
  const stage: CodingWorkerStage = { id, root: resolve(state.parent, id), before: structuredClone(state.originals) };
  codingWorkerWrite(state, stage, state.originals.map(file => ({
    path: file.path, before: "", after: file.content, beforeHash: codingWorkerHash(""), afterHash: file.hash,
  })), binding, signal, true);
  state.stages.set(id, stage);
  return stage;
}
export function createCodingWorkerWorkspace(options: CodingWorkerWorkspaceOptions): CodingWorkerWorkspaceCapability {
  if (options.authorizedDisposable !== true || !options.processDatabase || options.processDatabase === options.db
    || !options.owner.actorId || !options.owner.nativeOwnerId
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.workspaceId)
    || !options.files.length || options.files.length > L.files
    || new Set(options.files.map(file => file.path)).size !== options.files.length
    || !options.checks.length || options.checks.length > 32
    || new Set(options.checks.map(check => check.id)).size !== options.checks.length
    || typeof options.authorizeSource !== "function" || typeof options.authorizeCheck !== "function"
    || typeof options.redactOutput !== "function") codingWorkerFail("HOST_CAPABILITY");
  const source = canonicalDirectory(options.sourceRoot), parent = canonicalDirectory(options.stageParent);
  const journal = options.db.prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file;
  const processJournal = options.processDatabase.prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file;
  if (!journal || !processJournal || journal === processJournal
    || Number(options.db.prepare("PRAGMA synchronous").get()?.synchronous) < 2
    || Number(options.processDatabase.prepare("PRAGMA synchronous").get()?.synchronous) < 2)
    codingWorkerFail("DURABLE_DISTINCT_JOURNALS_REQUIRED");
  // A source or stage root may never itself be the agent's working checkout or an ancestor.
  const cwd = realpathSync(process.cwd());
  for (const root of [source, parent])
    if (root === cwd || cwd.startsWith(`${root}${sep}`) || existsSync(resolve(root, ".git"))) codingWorkerFail("REAL_WORKTREE");
  if (source === parent || source.startsWith(`${parent}${sep}`) || parent.startsWith(`${source}${sep}`))
    codingWorkerFail("DISTINCT_DISPOSABLE_ROOTS_REQUIRED");
  const originals = options.files.map(file => {
    const actual = codingWorkerRead(source, file.path);
    if (actual.hash !== file.beforeHash) codingWorkerFail("SOURCE_PIN");
    return actual;
  });
  if (Buffer.byteLength(JSON.stringify(originals)) > L.sourceBytes || options.authorizeSource(originals, options.owner) !== true)
    codingWorkerFail("SOURCE_POLICY");
  for (const check of options.checks) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(check.id)
      || !codingWorkerPath(check.script) || !options.files.some(file => file.path === check.script && !file.writable)
      || !check.acceptanceIds.length || check.acceptanceIds.some(id => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))
      || check.args.length > 16 || check.args.some(arg => typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg) > 256))
      codingWorkerFail("CHECK_ALLOWLIST");
  }
  const savedOptions = { ...options, owner: Object.freeze({ ...options.owner }),
    files: structuredClone(options.files), checks: structuredClone(options.checks) };
  const state = {
    options: savedOptions, parent, originals, writable: new Set(options.files.filter(file => file.writable).map(file => file.path)),
    stages: new Map<string, CodingWorkerStage>(), fenced: new Set<string>(),
  } as CodingWorkerWorkspaceState;
  codingWorkerAtomic(state, () => initializeCodingWorkerSchema(options.db));
  // An existing workspace identity cannot be silently reopened as a fresh capability.
  if (options.db.prepare("SELECT 1 FROM coding_worker_effects WHERE workspace_id=? LIMIT 1").get(options.workspaceId))
    codingWorkerFail("RESTART_REQUIRES_NEW_CAPABILITY");
  state.integrator = codingWorkerClone(state, { runId: "workspace-init", effectId: `clone-${randomUUID()}` }, new AbortController().signal);
  const capability = Object.freeze({ kind: "host-disposable-coding-workspace" as const });
  capabilities.set(capability, state);
  return capability;
}
/** Read-only reconciliation of exact journals, followed by durable unknown fencing. No filesystem writes. */
export function recoverCodingWorkerEffects(options: Pick<CodingWorkerWorkspaceOptions, "db" | "transaction" | "owner" | "workspaceId" | "stageParent" | "receipt">) {
  const parent = canonicalDirectory(options.stageParent);
  const result: { effectId: string; outcome: "unknown"; observation: "before" | "after" | "mixed" | "other" }[] = [];
  const rows = options.db.prepare("SELECT record FROM coding_worker_effects WHERE workspace_id=? AND state='intent'").all(options.workspaceId);
  for (const row of rows) {
    const intent = JSON.parse(String(row.record)) as FileIntent;
    if (intent.workspaceId !== options.workspaceId || codingWorkerPin(intent.owner) !== codingWorkerPin(options.owner)
      || !/^stage-[0-9a-f-]{36}$/.test(intent.stage)) codingWorkerFail("RECOVERY_OWNER");
    const states = intent.changes.map(change => {
      try {
        const hash = codingWorkerRead(resolve(parent, intent.stage), change.path).hash;
        return hash === change.afterHash ? "after" : hash === change.beforeHash ? "before" : "other";
      } catch {
        return !existsSync(resolve(parent, intent.stage)) && change.before === "" ? "before" : "other";
      }
    });
    const observation = states.every(value => value === "before") ? "before"
      : states.every(value => value === "after") ? "after" : states.includes("other") ? "other" : "mixed";
    intent.state = "unknown"; intent.observation = observation;
    options.transaction(() => {
      options.db.prepare("UPDATE coding_worker_effects SET state='unknown',record=? WHERE workspace_id=? AND effect_id=?")
        .run(JSON.stringify(intent), options.workspaceId, intent.effectId);
      const notified: unknown = options.receipt?.({ workspaceId: options.workspaceId, runId: intent.runId, taskId: intent.taskId,
        effectId: intent.effectId, kind: "recovery", pin: codingWorkerPin(intent.changes), outcome: "unknown" });
      if (notified && typeof (notified as { then?: unknown }).then === "function") codingWorkerFail("ASYNC_RECEIPT");
    });
    result.push({ effectId: intent.effectId, outcome: "unknown", observation });
  }
  return result;
}
