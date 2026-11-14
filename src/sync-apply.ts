import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { githubSyncIgnoredPath, githubSyncSafeRelativePath } from "./domain/sync-plan-original.js";
import { syncApplyPlanSchema, syncApplyReceiptSchema, syncApplyRequestSchema, type SyncApplyPlan, type SyncApplyReceipt } from "./sync-apply-contracts.js";
import { syncPlanInputSchema, syncPlanManifestSchema, syncPlanSessionSchema } from "./sync-plan-contracts.js";
import { planSync, syncPlanHash, syncRemoteRestoreMembers } from "./sync-plan.js";
import { SyncPlanStore } from "./sync-plan-store.js";

type File = ReturnType<typeof syncPlanManifestSchema.parse>["files"][number];
type Deletion = ReturnType<typeof syncPlanManifestSchema.parse>["deletions"][number];
type State = { kind: "live"; files: File[] } | { kind: "deleted"; deletion: Deletion } | { kind: "absent" };
type Action = SyncApplyPlan["actions"][number];
type FaultInjector = (action: Action, index: number, phase?: "before-mode-change") => void;
export type SyncApplyOptions = {
  faultInjector?: FaultInjector;
  /** Shared host receipt/index/intent commit. Runs inside the journal's final transaction. */
  beforeCommit?: (receipt: SyncApplyReceipt) => void;
};
type ApplyOptions = SyncApplyOptions;
type JournalRow = {
  apply_id: string; apply_key: string; session_id: string; actor_id: string; root_path: string;
  plan_hash: string; session_hash: string; input_json: string; plan_json: string;
  state: "prepared" | "completed" | "needs-review"; receipt_json: string | null;
};

const digest = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const keyOf = (value: { type: string; itemId: string }): string => JSON.stringify([value.type, value.itemId]);
const portable = (value: string): string => value.normalize("NFC").toLocaleLowerCase("en-US");
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const allowedTypes = new Set(["notes", "papers", "prompts", "skills"]);
const assets = new Set([".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".pdf", ".png", ".svg", ".tif", ".tiff", ".webp"]);
const protectedWords = new Set(["todo", "todos", "memory", "memories"]);

class PermissionOnlyTransitionError extends CoreError {
  constructor(relative: string) {
    super("CONFLICT", `Historic byte-only public-to-private sync transition has no permission intent in its v1 journal; manual review is required and no changes were applied: ${relative}`);
  }
}

const isModeAction = (action: Action): boolean => action.afterMode !== undefined;
const requiresPrivateMode = (action: Action): boolean =>
  action.privacy === "private" && action.afterSha256 !== null;

function applyIntentHash(value: { actions: Action[] }): string {
  const unsigned = { ...value } as unknown as Record<string, unknown>;
  delete unsigned.planHash;
  delete unsigned.modeBaselineHash;
  unsigned.actions = value.actions.map(({ beforeMode: _beforeMode, ...action }) => action);
  return syncPlanHash(unsigned);
}

function modeBaselineHash(actions: Action[]): string {
  return syncPlanHash(actions.filter(isModeAction).map(action => ({
    path: action.path, beforeSha256: action.beforeSha256, afterSha256: action.afterSha256,
    beforeMode: action.beforeMode, afterMode: action.afterMode,
  })));
}

function verifyModeBaseline(plan: SyncApplyPlan, requireCaptured: boolean): void {
  const modes = plan.actions.filter(isModeAction);
  if (!modes.length) {
    if (plan.modeBaselineHash !== undefined) throw new NeedsReviewError("Unexpected permission baseline in the sync apply journal.");
    return;
  }
  const captured = modes.every(action => action.beforeMode !== undefined);
  if (!captured) {
    if (requireCaptured || plan.modeBaselineHash !== undefined) throw new NeedsReviewError("Sync apply permission baseline is incomplete.");
    return;
  }
  if (plan.modeBaselineHash !== modeBaselineHash(plan.actions)) {
    throw new NeedsReviewError("Sync apply permission baseline hash is invalid.");
  }
}

function hasLegacyPermissionTransition(stored: SyncApplyPlan, current: SyncApplyPlan): Action | undefined {
  const storedPaths = new Set(stored.actions.filter(isModeAction).map(action => action.path));
  return current.actions.find(action => isModeAction(action) && !storedPaths.has(action.path));
}

function completedHistoricalReceipt(row: JournalRow, root: string, receiptJson: string | null): SyncApplyReceipt {
  const receipt = syncApplyReceiptSchema.parse(JSON.parse(String(receiptJson)));
  if (row.root_path !== root || row.apply_key !== syncPlanHash({ planHash: row.plan_hash, root })) {
    throw new Error("Completed sync apply journal root or key is invalid.");
  }
  const plan = syncApplyPlanSchema.parse(JSON.parse(row.plan_json));
  verifyModeBaseline(plan, true);
  if (applyIntentHash(plan) !== plan.planHash || row.plan_hash !== plan.planHash || row.session_hash !== plan.sessionHash
    || row.session_id !== plan.sessionId || row.actor_id !== plan.actorId
    || receipt.applyId !== row.apply_id || receipt.planHash !== plan.planHash
    || receipt.sessionId !== plan.sessionId || receipt.actorId !== plan.actorId
    || receipt.rootPath !== root) {
    throw new Error("Completed sync apply receipt does not match its journaled operation.");
  }
  const expectedOperations = plan.actions.map(action => ({
    path: action.path, beforeSha256: action.beforeSha256, afterSha256: action.afterSha256,
    ...(isModeAction(action) ? { beforeMode: action.beforeMode, afterMode: action.afterMode } : {}),
  }));
  if (JSON.stringify(receipt.operations) !== JSON.stringify(expectedOperations)
    || JSON.stringify(receipt.tombstones) !== JSON.stringify(plan.tombstones)) {
    throw new Error("Completed sync apply receipt does not match its journaled result.");
  }
  return receipt;
}

function databaseOf(store: SyncPlanStore): DatabaseSync {
  if (!(store instanceof SyncPlanStore)) throw new Error("A caller-created sync approval is not accepted; read the persisted sync plan session.");
  const db = (store as unknown as { db?: DatabaseSync }).db;
  if (!db || typeof db.exec !== "function" || typeof db.prepare !== "function") throw new Error("Sync plan store has no host database connection.");
  return db;
}

function validatePath(value: string, type: string, itemId: string, category: string, member: string): string {
  if (!allowedTypes.has(type)) throw new Error(`Offline apply is restricted to Markdown and attachment entities, not ${type}.`);
  const safe = githubSyncSafeRelativePath(value);
  const segments = safe.split("/");
  if (safe !== value || value.startsWith("/") || value.includes("\\") || value !== value.normalize("NFC")
    || segments[0] !== type || segments.some(segment => portable(segment) === ".git")
    || githubSyncIgnoredPath(value) || githubSyncIgnoredPath(portable(value))) throw new Error(`Unsafe or ignored sync apply path: ${value}`);
  const protectedIdentity = `${itemId}/${category}/${member}`.toLocaleLowerCase("en-US");
  if ([...protectedWords].some(word => protectedIdentity.split(/[^a-z0-9]+/).includes(word))
    || segments.some(segment => protectedWords.has(portable(segment).replace(/\.md$/i, "")))
    || /(?:^|\/)pkm-todo-board\.json$/i.test(value)
    || /(?:^|\/)research\/pkm\/migration\/migration board\.md$/i.test(value)) {
    throw new Error("Generic Todo/memory descriptors and the canonical Todo Board cannot be raw filesystem apply targets.");
  }
  const extension = path.posix.extname(value).toLocaleLowerCase("en-US");
  if (extension !== ".md" && !assets.has(extension)) throw new Error(`Unsupported sync apply file type: ${value}`);
  return safe;
}

function validateContent(file: File): void {
  validatePath(file.path, file.type, file.itemId, file.category, file.member);
  if (file.contentBase64 === undefined) return;
  const bytes = Buffer.from(file.contentBase64, "base64");
  if (bytes.toString("base64") !== file.contentBase64 || digest(bytes) !== file.digest) {
    throw new Error(`Invalid staged sync content: ${file.path}`);
  }
  if (path.posix.extname(file.path).toLocaleLowerCase("en-US") === ".md") {
    if (bytes.includes(0)) throw new Error(`Markdown contains a NUL byte: ${file.path}`);
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error(`Markdown is not valid UTF-8: ${file.path}`); }
  }
}

function stateMap(manifest: ReturnType<typeof syncPlanManifestSchema.parse>): Map<string, State> {
  const result = new Map<string, State>();
  for (const file of manifest.files) {
    const key = keyOf(file);
    const prior = result.get(key);
    if (prior?.kind === "live") prior.files.push(file);
    else result.set(key, { kind: "live", files: [file] });
  }
  for (const deletion of manifest.deletions) result.set(keyOf(deletion), { kind: "deleted", deletion });
  for (const state of result.values()) if (state.kind === "live") state.files.sort((a, b) => compare(a.member, b.member));
  return result;
}

function sourceSession(store: SyncPlanStore, request: ReturnType<typeof syncApplyRequestSchema.parse>) {
  const current = store.get(request.sessionId);
  if (!current) throw new Error("Sync plan session not found.");
  const session = syncPlanSessionSchema.parse(current);
  const owner = databaseOf(store).prepare("SELECT actor_id FROM sync_plan_owners WHERE session_id = ?").get(request.sessionId);
  if (!owner || String(owner.actor_id) !== request.actorId) throw new Error("Only the persisted sync plan owner may serialize its apply.");
  const input = syncPlanInputSchema.parse(request.input);
  const recomputed = planSync(input);
  if (syncPlanHash(recomputed) !== syncPlanHash(session.plan)
    || input.base.sha256 !== session.plan.pins.base || input.local.sha256 !== session.plan.pins.local
    || input.remote.sha256 !== session.plan.pins.remote) {
    throw new Error("Sync source pins no longer reproduce the persisted plan.");
  }
  const decisions = new Map<string, (typeof session.decisions)[number]>();
  for (const decision of session.decisions) {
    const conflict = session.plan.conflicts.find(item => item.id === decision.conflictId);
    if (!conflict) throw new Error("Persisted sync decision refers to a different plan.");
    const expectedConflictId = syncPlanHash({ pins: session.plan.pins, key: keyOf(conflict) });
    if (expectedConflictId !== decision.conflictId) throw new Error("Persisted decision source pins are invalid.");
    const previous = decisions.get(decision.conflictId);
    if (!previous || decision.revision > previous.revision) decisions.set(decision.conflictId, decision);
  }
  if (session.plan.conflicts.some(conflict => !decisions.has(conflict.id))) {
    throw new Error("Every sync conflict must have a persisted explicit decision before apply.");
  }
  if ([...decisions.values()].some(decision => decision.actorId !== request.actorId)) {
    throw new Error("The authenticated plan owner must be the actor on every accepted conflict decision.");
  }
  return { session, input, decisions };
}

function serializeVerifiedPlan(store: SyncPlanStore, request: ReturnType<typeof syncApplyRequestSchema.parse>): SyncApplyPlan {
  const { session, input, decisions } = sourceSession(store, request);
  const local = stateMap(syncPlanManifestSchema.parse(input.local.manifest));
  const selected = new Map<string, { type: File["type"]; itemId: string; state: State; source: "proposal" | "decision"; conflictId?: string }>();
  for (const proposal of session.plan.proposals) {
    selected.set(keyOf(proposal), { type: proposal.type, itemId: proposal.itemId, state: proposal.state, source: "proposal" });
  }
  const accepted = [...decisions.entries()].map(([conflictId, decision]) => {
    const conflict = session.plan.conflicts.find(item => item.id === conflictId)!;
    if (decision.choice === "remote") {
      let members: File[] | undefined;
      try { members = syncRemoteRestoreMembers(conflict); }
      catch (error) {
        if (!(error instanceof Error)) throw error;
        throw new CoreError("CONFLICT", error.message);
      }
      if (members) for (const file of members) {
        validateContent(file);
        if (file.contentBase64 === undefined) throw new CoreError("CONFLICT", `Remote entity member has no staged bytes: ${file.path}`);
      }
    }
    const state: State = decision.choice === "delete" ? { kind: "absent" } : conflict[decision.choice];
    selected.set(keyOf(conflict), { type: conflict.type, itemId: conflict.itemId, state, source: "decision", conflictId });
    return {
      conflictId, operationId: decision.operationId, actorId: decision.actorId,
      revision: decision.revision, choice: decision.choice, reason: decision.reason,
    };
  }).sort((a, b) => compare(a.conflictId, b.conflictId));

  const currentFiles = new Map<string, File>();
  const desiredFiles = new Map<string, File>();
  const guards = new Map<string, string | null>();
  const tombstones: SyncApplyPlan["tombstones"] = [];
  for (const [key, choice] of selected) {
    const prior = local.get(key) ?? { kind: "absent" as const };
    if (prior.kind === "live") for (const file of prior.files) {
      validateContent(file);
      currentFiles.set(file.path, file);
      guards.set(file.path, file.digest);
    }
    if (choice.state.kind === "live") {
      for (const file of choice.state.files) {
        validateContent(file);
        desiredFiles.set(file.path, file);
      }
    } else if (choice.state.kind === "deleted") {
      tombstones.push({
        type: choice.type, itemId: choice.itemId, deletedAt: choice.state.deletion.deletedAt, source: choice.source,
        ...(choice.conflictId ? { conflictId: choice.conflictId } : {}),
      });
    } else if (choice.source === "decision") {
      tombstones.push({
        type: choice.type, itemId: choice.itemId, source: "decision", conflictId: choice.conflictId,
      });
    }
  }

  const owners = new Map<string, string>();
  const desiredPaths = [...desiredFiles.keys()].sort((a, b) => compare(portable(a), portable(b)));
  for (const value of desiredPaths) {
    const owner = keyOf(desiredFiles.get(value)!);
    const portablePath = portable(value);
    const previous = owners.get(portablePath);
    if (previous) throw new Error("Accepted sync choices create a portable path collision.");
    owners.set(portablePath, owner);
  }
  for (let i = 0; i < desiredPaths.length; i++) {
    for (let j = i + 1; j < desiredPaths.length && portable(desiredPaths[j]).startsWith(portable(desiredPaths[i])); j++) {
      if (portable(desiredPaths[j]).startsWith(`${portable(desiredPaths[i])}/`)) throw new Error("Accepted sync choices create a file/directory collision.");
    }
  }

  const actions: SyncApplyPlan["actions"] = [];
  for (const [value, oldFile] of currentFiles) {
    const next = desiredFiles.get(value);
    if (!next) {
      actions.push({
        path: value, type: oldFile.type, itemId: oldFile.itemId, member: oldFile.member, privacy: oldFile.privacy,
        beforeSha256: oldFile.digest, afterSha256: null,
      });
    } else if (next.digest === oldFile.digest && oldFile.privacy === "public" && next.privacy === "private") {
      actions.push({
        path: value, type: next.type, itemId: next.itemId, member: next.member, privacy: next.privacy,
        beforeSha256: oldFile.digest, afterSha256: next.digest, afterMode: 0o600,
      });
    } else if (next.digest !== oldFile.digest) {
      if (next.contentBase64 === undefined) throw new Error(`Chosen replacement has no staged bytes: ${next.path}`);
      actions.push({
        path: value, type: next.type, itemId: next.itemId, member: next.member, privacy: next.privacy,
        beforeSha256: oldFile.digest, afterSha256: next.digest, contentBase64: next.contentBase64,
      });
    }
  }
  for (const [value, next] of desiredFiles) {
    if (currentFiles.has(value)) continue;
    guards.set(value, null);
    if (next.contentBase64 === undefined) throw new Error(`Chosen addition has no staged bytes: ${next.path}`);
    actions.push({
      path: value, type: next.type, itemId: next.itemId, member: next.member, privacy: next.privacy,
      beforeSha256: null, afterSha256: next.digest, contentBase64: next.contentBase64,
    });
  }
  actions.sort((a, b) => compare(a.path, b.path));
  const sessionHash = syncPlanHash({
    sessionId: session.sessionId, revision: session.revision, plan: session.plan, decisions: session.decisions,
  });
  const unsigned = {
    schema: "pkm.sync-apply-plan/v1" as const,
    sessionId: session.sessionId, revision: session.revision, actorId: request.actorId,
    sourcePins: session.plan.pins, sessionHash, decisions: accepted,
    guards: [...guards.entries()].map(([path, sha256]) => ({ path, sha256 })).sort((a, b) => compare(a.path, b.path)),
    actions, tombstones: tombstones.sort((a, b) => compare(keyOf(a), keyOf(b))),
  };
  return syncApplyPlanSchema.parse({ ...unsigned, planHash: applyIntentHash(unsigned) });
}

/** Rebuilds the proposal from persisted decisions and pinned snapshots; actorId must come from host auth. */
export function serializeSyncApplyPlan(
  store: SyncPlanStore,
  request: { sessionId: string; actorId: string; input: unknown },
): SyncApplyPlan {
  return serializeVerifiedPlan(store, syncApplyRequestSchema.parse(request));
}

export function initializeSyncApplyJournal(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_apply_journal (
      apply_id TEXT PRIMARY KEY,
      apply_key TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      root_path TEXT NOT NULL,
      plan_hash TEXT NOT NULL,
      session_hash TEXT NOT NULL,
      input_json TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('prepared', 'completed', 'needs-review')),
      receipt_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    ) STRICT;
  `);
}

function validatedRoot(rootPath: string): string {
  const root = path.resolve(rootPath);
  let info: fs.Stats;
  try { info = fs.lstatSync(root); }
  catch { throw new Error("Sync apply root must already exist as a real directory."); }
  if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(root) !== root) {
    throw new Error("Sync apply root must not be a symlink.");
  }
  return root;
}

function inspect(root: string, relative: string): { bytes?: Buffer; mode?: number; dev?: number; ino?: number } {
  const segments = relative.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    let info: fs.Stats;
    try { info = fs.lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`Symlink in sync apply path: ${relative}`);
    if (index < segments.length - 1) {
      if (!info.isDirectory()) throw new Error(`Non-directory parent in sync apply path: ${relative}`);
    } else {
      if (!info.isFile()) throw new Error(`Non-regular sync apply target: ${relative}`);
      return { bytes: fs.readFileSync(current), mode: info.mode & 0o777, dev: info.dev, ino: info.ino };
    }
  }
  return {};
}

function bindModeBaseline(root: string, plan: SyncApplyPlan): SyncApplyPlan {
  const actions = plan.actions.map(action => {
    if (!isModeAction(action)) return action;
    const observed = inspect(root, action.path);
    if ((observed.bytes ? digest(observed.bytes) : null) !== action.beforeSha256 || observed.mode === undefined) {
      throw new NeedsReviewError(`External write detected before private permission transition: ${action.path}`);
    }
    return { ...action, beforeMode: observed.mode };
  });
  if (!actions.some(isModeAction)) return plan;
  const baselineHash = modeBaselineHash(actions);
  return syncApplyPlanSchema.parse({ ...plan, actions, modeBaselineHash: baselineHash });
}

function ensureParents(root: string, relative: string): string {
  let current = root;
  const segments = relative.split("/");
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try { fs.mkdirSync(current, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe parent in sync apply path: ${relative}`);
  }
  return path.join(current, segments[segments.length - 1]);
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function applyModeChange(root: string, action: Action): void {
  const before = inspect(root, action.path);
  if ((before.bytes ? digest(before.bytes) : null) !== action.beforeSha256
    || before.mode !== action.beforeMode || before.dev === undefined || before.ino === undefined) {
    throw new NeedsReviewError(`External write detected before permission change: ${action.path}`);
  }
  const target = path.join(root, ...action.path.split("/"));
  const entry = fs.lstatSync(target);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.dev !== before.dev || entry.ino !== before.ino) {
    throw new NeedsReviewError(`Sync apply target changed before permission change: ${action.path}`);
  }
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let failure: unknown;
  try {
    const opened = fs.fstatSync(descriptor);
    const openedBytes = fs.readFileSync(descriptor);
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino
      || (opened.mode & 0o777) !== action.beforeMode || digest(openedBytes) !== action.beforeSha256) {
      throw new NeedsReviewError(`Sync apply target changed before permission change: ${action.path}`);
    }
    try {
      fs.fchmodSync(descriptor, action.afterMode!);
      fs.fsyncSync(descriptor);
    } catch (error) {
      throw new NeedsReviewError(`Private permission change failed or has unknown durability: ${action.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const after = inspect(root, action.path);
    const finalInfo = fs.fstatSync(descriptor);
    if ((after.bytes ? digest(after.bytes) : null) !== action.afterSha256
      || after.mode !== action.afterMode || after.dev !== opened.dev || after.ino !== opened.ino
      || (finalInfo.mode & 0o777) !== action.afterMode || finalInfo.dev !== opened.dev || finalInfo.ino !== opened.ino) {
      throw new NeedsReviewError(`Private permission change could not be verified: ${action.path}`);
    }
  } catch (error) {
    failure = error;
  }
  try { fs.closeSync(descriptor); }
  catch (error) { failure ??= new NeedsReviewError(`Could not close permission-change target: ${action.path}: ${error instanceof Error ? error.message : String(error)}`); }
  if (failure instanceof NeedsReviewError) throw failure;
  if (failure) throw new NeedsReviewError(`Private permission change outcome is unknown: ${action.path}: ${failure instanceof Error ? failure.message : String(failure)}`);
}

function writeAtomic(root: string, action: Action, expectedBefore: string | null): void {
  const before = inspect(root, action.path);
  if ((before.bytes ? digest(before.bytes) : null) !== expectedBefore) throw new NeedsReviewError(`External write detected before sync apply: ${action.path}`);
  const target = ensureParents(root, action.path);
  const rechecked = inspect(root, action.path);
  if ((rechecked.bytes ? digest(rechecked.bytes) : null) !== expectedBefore) throw new NeedsReviewError(`External write detected before sync apply: ${action.path}`);
  if (action.afterSha256 === null) {
    if (rechecked.bytes) fs.unlinkSync(target);
    syncDirectory(path.dirname(target));
    return;
  }
  const bytes = Buffer.from(action.contentBase64!, "base64");
  if (digest(bytes) !== action.afterSha256) throw new Error(`Staged content digest changed: ${action.path}`);
  const mode = action.privacy === "private" ? 0o600 : rechecked.mode === undefined ? 0o644 : (rechecked.mode & 0o666);
  const temporary = path.join(path.dirname(target), `.pkm-sync-${randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, "wx", mode);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  try {
    const finalCheck = inspect(root, action.path);
    if ((finalCheck.bytes ? digest(finalCheck.bytes) : null) !== expectedBefore) throw new NeedsReviewError(`External write detected before sync apply: ${action.path}`);
    fs.renameSync(temporary, target);
    syncDirectory(path.dirname(target));
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

class NeedsReviewError extends CoreError {
  constructor(message: string) { super("RECOVERY_CONFLICT", message, "unknown"); }
}

function markNeedsReview(db: DatabaseSync, row: JournalRow, error: string): void {
  db.prepare("UPDATE sync_apply_journal SET state = 'needs-review', error = ? WHERE apply_id = ?")
    .run(error.slice(0, 2000), row.apply_id);
}

function executeJournal(store: SyncPlanStore, db: DatabaseSync, row: JournalRow, root: string, options: ApplyOptions = {}): SyncApplyReceipt {
  const existing = db.prepare("SELECT state, receipt_json FROM sync_apply_journal WHERE apply_id = ?").get(row.apply_id);
  if (!existing) {
    db.exec("ROLLBACK");
    throw new Error("Sync apply journal entry disappeared.");
  }
  if (existing.state === "completed") {
    try {
      // This is the immutable outcome of the original operation, not a claim about
      // the filesystem now. Later legitimate changes must not invalidate replay.
      const receipt = completedHistoricalReceipt(row, root, existing.receipt_json as string | null);
      options.beforeCommit?.(receipt);
      db.exec("COMMIT");
      return receipt;
    }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  if (existing.state === "needs-review") {
    db.exec("COMMIT");
    throw new Error("Sync apply journal requires manual review; no further writes were attempted.");
  }
  if (row.root_path !== root) {
    db.exec("ROLLBACK");
    throw new Error("Sync apply recovery root does not match the journal.");
  }
  try {
    let plan: SyncApplyPlan, currentPlan: SyncApplyPlan;
    try {
      plan = syncApplyPlanSchema.parse(JSON.parse(row.plan_json));
      const request = syncApplyRequestSchema.parse({
        sessionId: row.session_id, actorId: row.actor_id, input: JSON.parse(row.input_json),
      });
      currentPlan = serializeVerifiedPlan(store, request);
    } catch (error) {
      throw new NeedsReviewError(`Persisted sync apply source validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    verifyModeBaseline(plan, true);
    const historicTransition = hasLegacyPermissionTransition(plan, currentPlan);
    if (historicTransition) {
      throw new NeedsReviewError(`Historic byte-only public-to-private sync transition has no permission intent in its v1 journal; manual review is required: ${historicTransition.path}`);
    }
    if (currentPlan.planHash !== plan.planHash || currentPlan.sessionHash !== plan.sessionHash) {
      throw new NeedsReviewError("Persisted actor decision or source pins changed after sync apply was prepared.");
    }
    if (row.plan_hash !== plan.planHash || row.session_hash !== plan.sessionHash
      || row.apply_key !== syncPlanHash({ planHash: plan.planHash, root })) {
      throw new NeedsReviewError("Sync apply journal identity or source pins changed.");
    }
    if (applyIntentHash(plan) !== plan.planHash) throw new NeedsReviewError("Sync apply journal plan hash is invalid.");
    for (const guard of plan.guards) {
      validatePath(guard.path, plan.actions.find(action => action.path === guard.path)?.type
        ?? currentPlan.actions.find(action => action.path === guard.path)?.type
        ?? inferType(guard.path), "", "", "");
      const observed = inspect(root, guard.path).bytes;
      const observedHash = observed ? digest(observed) : null;
      const action = plan.actions.find(item => item.path === guard.path);
      if (observedHash !== guard.sha256 && (!action || observedHash !== action.afterSha256)) {
        throw new NeedsReviewError(`External write detected for ${guard.path}.`);
      }
    }
    for (const [index, action] of plan.actions.entries()) {
      const observed = inspect(root, action.path);
      const currentHash = observed.bytes ? digest(observed.bytes) : null;
      if (isModeAction(action)) {
        const alreadyPrivate = currentHash === action.afterSha256 && observed.mode === action.afterMode;
        if (alreadyPrivate) {
          options.faultInjector?.(action, index);
          continue;
        }
        if (currentHash !== action.beforeSha256 || observed.mode !== action.beforeMode) {
          throw new NeedsReviewError(`Unknown before/after bytes or mode for ${action.path}; recovery is fail-closed.`);
        }
        try { options.faultInjector?.(action, index, "before-mode-change"); }
        catch (error) {
          throw new NeedsReviewError(`Private permission change was interrupted before execution: ${action.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
        applyModeChange(root, action);
        const afterMode = inspect(root, action.path);
        if ((afterMode.bytes ? digest(afterMode.bytes) : null) !== action.afterSha256 || afterMode.mode !== action.afterMode) {
          throw new NeedsReviewError(`Applied permission mode does not match the journal: ${action.path}`);
        }
        options.faultInjector?.(action, index);
        continue;
      }
      if (currentHash === action.afterSha256) {
        if (requiresPrivateMode(action) && observed.mode !== 0o600) {
          throw new NeedsReviewError(`Private sync result has an unexpected permission mode: ${action.path}`);
        }
        options.faultInjector?.(action, index);
        continue;
      }
      if (currentHash !== action.beforeSha256) throw new NeedsReviewError(`Unknown before/after hash for ${action.path}; recovery is fail-closed.`);
      writeAtomic(root, action, action.beforeSha256);
      const after = inspect(root, action.path);
      if ((after.bytes ? digest(after.bytes) : null) !== action.afterSha256
        || (requiresPrivateMode(action) && after.mode !== 0o600)) {
        throw new NeedsReviewError(`Applied file bytes or permission mode does not match the journal: ${action.path}`);
      }
      options.faultInjector?.(action, index);
    }
    for (const guard of plan.guards) {
      const action = plan.actions.find(item => item.path === guard.path);
      const expected = action ? action.afterSha256 : guard.sha256;
      const observed = inspect(root, guard.path);
      if ((observed.bytes ? digest(observed.bytes) : null) !== expected
        || (action && isModeAction(action) && observed.mode !== action.afterMode)
        || (action && requiresPrivateMode(action) && observed.mode !== 0o600)) {
        throw new NeedsReviewError(`External write detected before sync apply receipt: ${guard.path}.`);
      }
    }
    const receipt = syncApplyReceiptSchema.parse({
      schema: "pkm.sync-apply-receipt/v1",
      applyId: row.apply_id,
      planHash: plan.planHash,
      sessionId: plan.sessionId,
      actorId: plan.actorId,
      rootPath: root,
      operations: plan.actions.map(action => ({
        path: action.path, beforeSha256: action.beforeSha256, afterSha256: action.afterSha256,
        ...(isModeAction(action) ? { beforeMode: action.beforeMode, afterMode: action.afterMode } : {}),
      })),
      tombstones: plan.tombstones,
      completedAt: new Date().toISOString(),
    });
    db.prepare("UPDATE sync_apply_journal SET state = 'completed', receipt_json = ?, error = NULL WHERE apply_id = ?")
      .run(JSON.stringify(receipt), row.apply_id);
    options.beforeCommit?.(receipt);
    db.exec("COMMIT");
    return receipt;
  } catch (error) {
    if (error instanceof NeedsReviewError) {
      markNeedsReview(db, row, error.message);
      db.exec("COMMIT");
      throw error;
    }
    db.exec("ROLLBACK");
    throw error;
  }
}

function inferType(relative: string): string {
  return relative.split("/")[0];
}

function ensureJournal(db: DatabaseSync): void {
  const result = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_apply_journal'").get();
  if (!result) throw new Error("Initialize the host sync apply journal before applying or recovering.");
}

/** Applies only decisions in the shared host store; actorId must come from host auth, never request JSON. */
export function applySyncPlan(
  store: SyncPlanStore,
  request: { sessionId: string; actorId: string; input: unknown },
  rootPath: string,
  options: ApplyOptions = {},
): SyncApplyReceipt {
  const db = databaseOf(store);
  if (db.isTransaction) throw new Error("Sync apply requires the host database connection outside an open transaction.");
  ensureJournal(db);
  const root = validatedRoot(rootPath);
  const parsed = syncApplyRequestSchema.parse(request);
  inspectSyncApplyRecovery(store, root);
  db.exec("BEGIN IMMEDIATE");
  let row: JournalRow;
  try {
    const plan = serializeVerifiedPlan(store, parsed);
    const inputJson = JSON.stringify(parsed.input);
    const applyKey = syncPlanHash({ planHash: plan.planHash, root });
    const previous = db.prepare("SELECT * FROM sync_apply_journal WHERE apply_key = ?").get(applyKey) as JournalRow | undefined;
    if (previous) {
      row = previous;
      if (row.plan_hash !== plan.planHash || row.session_hash !== plan.sessionHash) throw new Error("Existing journal has different sync plan pins.");
    } else {
      const journalPlan = bindModeBaseline(root, plan);
      row = {
        apply_id: randomUUID(), apply_key: applyKey, session_id: plan.sessionId, actor_id: plan.actorId,
        root_path: root, plan_hash: plan.planHash, session_hash: plan.sessionHash,
        input_json: inputJson, plan_json: JSON.stringify(journalPlan), state: "prepared", receipt_json: null,
      };
      db.prepare(`INSERT INTO sync_apply_journal
        (apply_id, apply_key, session_id, actor_id, root_path, plan_hash, session_hash, input_json, plan_json, state, receipt_json, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, NULL, ?)`)
        .run(row.apply_id, row.apply_key, row.session_id, row.actor_id, row.root_path, row.plan_hash,
          row.session_hash, row.input_json, row.plan_json, new Date().toISOString());
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.exec("BEGIN IMMEDIATE");
  return executeJournal(store, db, row, root, options);
}

/** Rolls forward prepared applications from the host journal after revalidating their stored source pins and decisions. */
export function recoverSyncApply(store: SyncPlanStore, rootPath: string): SyncApplyReceipt[] {
  const db = databaseOf(store);
  if (db.isTransaction) throw new Error("Sync apply recovery requires the host database connection outside an open transaction.");
  ensureJournal(db);
  const root = validatedRoot(rootPath);
  const rows = db.prepare("SELECT * FROM sync_apply_journal WHERE root_path = ? AND state = 'prepared' ORDER BY created_at, apply_id")
    .all(root) as unknown as JournalRow[];
  const receipts: SyncApplyReceipt[] = [];
  for (const row of rows) {
    db.exec("BEGIN IMMEDIATE");
    receipts.push(executeJournal(store, db, row, root));
  }
  return receipts;
}

export function readSyncApplyReceipt(
  store: SyncPlanStore,
  planHash: string,
  rootPath: string,
): SyncApplyReceipt | undefined {
  if (!/^[a-f0-9]{64}$/.test(planHash)) throw new Error("Invalid sync apply plan hash.");
  const db = databaseOf(store);
  ensureJournal(db);
  const root = validatedRoot(rootPath);
  const applyKey = syncPlanHash({ planHash, root });
  const row = db.prepare("SELECT * FROM sync_apply_journal WHERE apply_key = ?").get(applyKey) as JournalRow | undefined;
  if (!row || row.state !== "completed" || typeof row.receipt_json !== "string") return undefined;
  return completedHistoricalReceipt(row, root, row.receipt_json);
}

export const applySyncApplyPlan = applySyncPlan;

/** No filesystem effects. Preflights every prepared v1 journal on the owner's DB connection.
 * Outside a transaction classification autocommits; an existing transaction remains caller-owned. */
export function inspectSyncApplyRecovery(store: SyncPlanStore, rootPath: string): void {
  const db = databaseOf(store), root = validatedRoot(rootPath);
  ensureJournal(db);
  const rows = db.prepare("SELECT * FROM sync_apply_journal WHERE state != 'completed'").all() as unknown as JournalRow[];
  for (const row of rows) {
    if (row.state !== "prepared" || row.root_path !== root) throw new Error("Sync journal requires manual review; preserve all pending effects.");
    const plan = syncApplyPlanSchema.parse(JSON.parse(row.plan_json));
    let current: SyncApplyPlan;
    try {
      current = serializeVerifiedPlan(store, syncApplyRequestSchema.parse({
        sessionId: row.session_id, actorId: row.actor_id, input: JSON.parse(row.input_json),
      }));
    } catch (error) {
      if (error instanceof PermissionOnlyTransitionError) markNeedsReview(db, row, error.message);
      throw error;
    }
    const historicTransition = hasLegacyPermissionTransition(plan, current);
    if (historicTransition) {
      const error = new PermissionOnlyTransitionError(historicTransition.path);
      markNeedsReview(db, row, error.message);
      throw error;
    }
    try { verifyModeBaseline(plan, true); }
    catch (error) {
      markNeedsReview(db, row, error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (applyIntentHash(plan) !== plan.planHash || current.planHash !== plan.planHash
      || row.plan_hash !== plan.planHash || row.session_hash !== plan.sessionHash
      || row.apply_key !== syncPlanHash({ planHash: plan.planHash, root })) {
      throw new Error("Sync journal identity or source pins changed.");
    }
    for (const guard of plan.guards) {
      validatePath(guard.path, inferType(guard.path), "", "", "");
      const observed = inspect(root, guard.path).bytes;
      const hash = observed ? digest(observed) : null;
      const action = plan.actions.find(item => item.path === guard.path);
      if (hash !== guard.sha256 && (!action || hash !== action.afterSha256)) throw new Error("Unknown sync journal effect; preserve intent.");
    }
    for (const action of plan.actions) {
      validateContent({ ...action, category: "", digest: action.afterSha256 ?? action.beforeSha256! });
      const observed = inspect(root, action.path), hash = observed.bytes ? digest(observed.bytes) : null;
      if (isModeAction(action)) {
        const before = hash === action.beforeSha256 && observed.mode === action.beforeMode;
        const after = hash === action.afterSha256 && observed.mode === action.afterMode;
        if (!before && !after) {
          const error = new NeedsReviewError(`Unknown sync journal bytes or permission mode; preserve intent: ${action.path}`);
          markNeedsReview(db, row, error.message);
          throw error;
        }
      } else if (hash === action.afterSha256 && requiresPrivateMode(action) && observed.mode !== 0o600) {
        const error = new NeedsReviewError(`Private sync result has an unexpected permission mode; preserve intent: ${action.path}`);
        markNeedsReview(db, row, error.message);
        throw error;
      } else if (hash !== action.beforeSha256 && hash !== action.afterSha256) {
        throw new Error("Unknown sync journal effect; preserve intent.");
      }
    }
  }
}
