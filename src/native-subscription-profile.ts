import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CoreError } from "./contracts.js";
import { captureProtectedSubscriptionRefresh } from "./legacy-state-import.js";
import { issueNativeMembershipRecoveryAuthority, type MembershipRecoveryPhase } from "./legacy-subscription-membership-authority.js";
import { finishMembershipIntent, prepareMembershipIntent, readMembershipIntent, readMembershipOutcome } from "./legacy-subscription-membership-intent.js";
import { validateMembershipChange, validatePendingMembershipRetry } from "./legacy-subscription-membership-change.js";
import { nativeSubscriptionChangeSha256, validateNativePriorityChange, validateNativeRefreshRetry } from "./native-subscription-priority.js";
import { validateProtectedRefreshChange } from "./legacy-subscription-refresh.js";
import { validateNativeGitHubRefresh, validateNativeGitHubTarget } from "./native-subscription-github.js";
import { assertNativeSubscriptionHostProof, type NativeSubscriptionHostRequest,
  type NativeSubscriptionHostService } from "./native-subscription-host-ipc.js";
import type { Storage } from "./storage.js";
import type { RefreshView } from "./legacy-subscription-refresh.js";

type Capture = Awaited<ReturnType<typeof captureProtectedSubscriptionRefresh>>;
type Pin = { path: string; sha256: string; size: number };
type Body = { schema: "pkm.native-subscription-profile/v1"; workspaceId: string; root: string;
  rootDevice: string; rootInode: string; profile: string; profileDevice: string; profileInode: string;
  state: Record<string, unknown>; directories: string[]; files: Pin[] };
type Generation = { schema: "pkm.native-subscription-generation/v1"; workspaceId: string; genesis: string; parent: string;
  state: Record<string, unknown>; directories: string[]; files: Pin[];
  membership: { operationId: string; intentSha256: string } };
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value);
const operation = "native.subscription.profile.admit";
const actor = "native:subscription-profile";
const generationOperation = "native.subscription.profile.generation";
const invalid = (): never => { throw new CoreError("IMPORT_RECEIPT_INVALID", "Native Subscription profile admission is invalid."); };
function assertNoSubscriptionMaterializer(): void {
  const entries = readdirSync("/proc").filter(name => /^\d+$/.test(name));
  if (entries.length > 16_384) throw new CoreError("CONFLICT", "Subscription materializer inventory is unavailable.");
  for (const pid of entries) {
    try {
      if (statSync(`/proc/${pid}`).uid !== process.getuid!()) continue;
      const before = readFileSync(`/proc/${pid}/stat`, "utf8"), end = before.lastIndexOf(")");
      if (end < 0) throw new Error();
      const fields = before.slice(end + 2).trim().split(/\s+/);
      if (fields[0] === "Z") continue;
      const command = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0");
      const after = readFileSync(`/proc/${pid}/stat`, "utf8"), afterEnd = after.lastIndexOf(")");
      if (afterEnd < 0 || !fields[19] || fields[19] !== after.slice(afterEnd + 2).trim().split(/\s+/)[19]) throw new Error();
      if (command.some(item => /(?:^|\/)subscription-materialize-worker\.js$/.test(item)))
        throw new CoreError("CONFLICT", "A Subscription materializer is still running.");
    } catch (error: any) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") continue;
      if (error instanceof CoreError) throw error;
      throw new CoreError("CONFLICT", "Subscription materializer inventory is unavailable.");
    }
  }
}
const pinCapture = (capture: Capture) => ({
  state: capture.projection, directories: capture.directories,
  files: capture.files.map(file => ({ path: file.path, sha256: file.sha256, size: file.bytes.length })),
});
const ddl = `
  CREATE TABLE IF NOT EXISTS native_subscription_profile (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), body TEXT NOT NULL, fingerprint TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS native_subscription_profile_files (
    path TEXT PRIMARY KEY, bytes BLOB NOT NULL
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS native_subscription_profile_no_update BEFORE UPDATE ON native_subscription_profile
    BEGIN SELECT RAISE(ABORT,'Immutable Subscription profile'); END;
  CREATE TRIGGER IF NOT EXISTS native_subscription_profile_no_delete BEFORE DELETE ON native_subscription_profile
    BEGIN SELECT RAISE(ABORT,'Immutable Subscription profile'); END;
  CREATE TRIGGER IF NOT EXISTS native_subscription_profile_files_no_update BEFORE UPDATE ON native_subscription_profile_files
    BEGIN SELECT RAISE(ABORT,'Immutable Subscription profile file'); END;
  CREATE TRIGGER IF NOT EXISTS native_subscription_profile_files_no_delete BEFORE DELETE ON native_subscription_profile_files
    BEGIN SELECT RAISE(ABORT,'Immutable Subscription profile file'); END;
  CREATE TABLE IF NOT EXISTS native_subscription_generations (
    sequence INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, body TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS native_subscription_generation_files (
    fingerprint TEXT NOT NULL, path TEXT NOT NULL, bytes BLOB NOT NULL,
    PRIMARY KEY(fingerprint,path)
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS native_subscription_generations_no_update BEFORE UPDATE ON native_subscription_generations
    BEGIN SELECT RAISE(ABORT,'Immutable Subscription generation'); END;
  CREATE TRIGGER IF NOT EXISTS native_subscription_generations_no_delete BEFORE DELETE ON native_subscription_generations
    BEGIN SELECT RAISE(ABORT,'Immutable Subscription generation'); END;
  CREATE TRIGGER IF NOT EXISTS native_subscription_generation_files_no_update BEFORE UPDATE ON native_subscription_generation_files
    BEGIN SELECT RAISE(ABORT,'Immutable Subscription generation file'); END;
  CREATE TRIGGER IF NOT EXISTS native_subscription_generation_files_no_delete BEFORE DELETE ON native_subscription_generation_files
    BEGIN SELECT RAISE(ABORT,'Immutable Subscription generation file'); END;
`;

function workspace(root: string): string {
  const file = join(root, ".pkm-next-workspace"), stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) return invalid();
  const marker = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  if (marker.schema !== "pkm.next-workspace/v2" || typeof marker.id !== "string"
    || !/^[a-f0-9-]{36}$/i.test(marker.id)) return invalid();
  return marker.id;
}

function binding(storage: Storage, profile: string): Omit<Body, "state" | "directories" | "files"> {
  const root = storage.workspaceRoot();
  const overlaps = (parent: string, child: string) => {
    const path = relative(parent, child);
    return !path || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  };
  if (process.platform !== "linux" || process.env.PKM_EXPERIMENTAL_SUBSCRIPTION_HOST !== "1"
    || resolve(profile) !== profile || realpathSync(profile) !== profile
    || realpathSync(root) !== root || overlaps(root, profile) || overlaps(profile, root)
    || !existsSync(join(root, ".pkm-next-root-adoption.commit.json")))
    throw new CoreError("FORBIDDEN", "Native Subscription profile requires experimental same-root adoption.");
  const rootStat = lstatSync(root, { bigint: true }), profileStat = lstatSync(profile, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !profileStat.isDirectory() || profileStat.isSymbolicLink()
    || profileStat.uid !== BigInt(process.getuid!()) || (Number(profileStat.mode) & 0o077) !== 0
    || rootStat.dev === profileStat.dev && rootStat.ino === profileStat.ino) return invalid();
  return { schema: "pkm.native-subscription-profile/v1", workspaceId: workspace(root), root,
    rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino), profile,
    profileDevice: String(profileStat.dev), profileInode: String(profileStat.ino) };
}

function readAdmission(db: DatabaseSync, expected: ReturnType<typeof binding>) {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_subscription_profile'").get();
  const fileTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_subscription_profile_files'").get();
  const anchors = db.prepare("SELECT operation_id,fingerprint,actor_id,result FROM receipts WHERE operation=?").all(operation);
  if (!table && !fileTable && !anchors.length) return undefined;
  if (!table || !fileTable || anchors.length !== 1) return invalid();
  const rows = db.prepare("SELECT body,fingerprint FROM native_subscription_profile").all();
  if (rows.length !== 1) return invalid();
  const raw = String(rows[0]!.body), fingerprint = String(rows[0]!.fingerprint);
  let body: Body;
  try { body = JSON.parse(raw) as Body; } catch { return invalid(); }
  const { state, directories, files, ...actualBinding } = body;
  if (json(actualBinding) !== json(expected) || json(body) !== raw || hash(raw) !== fingerprint
    || !state || typeof state !== "object" || Array.isArray(state) || !Array.isArray(directories) || !Array.isArray(files)
    || anchors[0]!.operation_id !== `native-subscription-profile:${expected.workspaceId}`
    || anchors[0]!.fingerprint !== fingerprint || anchors[0]!.actor_id !== actor
    || anchors[0]!.result !== json({ fingerprint })) return invalid();
  const stored = db.prepare("SELECT path,bytes FROM native_subscription_profile_files ORDER BY path").all();
  if (stored.length !== files.length || new Set(files.map(item => item.path)).size !== files.length) return invalid();
  const bytes = new Map(stored.map(item => [String(item.path), item.bytes]));
  for (const item of files) {
    if (!item || typeof item !== "object" || typeof item.path !== "string" || typeof item.sha256 !== "string") return invalid();
    const data = bytes.get(item.path);
    if (!item.path.startsWith("cache/") || item.path.includes("\\") || item.path.split("/").some(part => !part || part === "." || part === "..")
      || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0
      || !(data instanceof Uint8Array) || data.length !== item.size || hash(data) !== item.sha256) return invalid();
  }
  return { fingerprint, state, directories, files };
}

function captureDigest(capture: { state: Record<string, unknown>; directories: string[]; files: Pin[] }): string {
  return hash(json({ state: capture.state, directories: capture.directories,
    files: capture.files.map(({ path, sha256, size }) => ({ path, sha256, size })) }));
}

function currentGeneration(db: DatabaseSync, initial: ReturnType<typeof binding>) {
  const genesis = readAdmission(db, initial);
  if (!genesis) throw new CoreError("NOT_AVAILABLE", "Subscription profile has not been admitted.");
  const rows = db.prepare("SELECT sequence,fingerprint,body FROM native_subscription_generations ORDER BY sequence").all();
  const anchors = db.prepare("SELECT operation_id,fingerprint,actor_id,result FROM receipts WHERE operation=?").all(generationOperation);
  const blobs = db.prepare("SELECT fingerprint,path,bytes FROM native_subscription_generation_files").all();
  if (rows.length !== anchors.length) return invalid();
  const byKey = new Map(blobs.map(row => [`${row.fingerprint}\0${row.path}`, row.bytes]));
  if (byKey.size !== blobs.length) return invalid();
  let head = genesis.fingerprint, state = genesis.state, directories = genesis.directories, files = genesis.files, total = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!, fingerprint = String(row.fingerprint), raw = String(row.body);
    let body: Generation;
    try { body = JSON.parse(raw) as Generation; } catch { return invalid(); }
    if (!body || body.schema !== "pkm.native-subscription-generation/v1" || body.workspaceId !== initial.workspaceId
      || body.genesis !== genesis.fingerprint || body.parent !== head || row.sequence !== index + 1
      || json(body) !== raw || hash(raw) !== fingerprint || !body.state || typeof body.state !== "object"
      || Array.isArray(body.state) || !Array.isArray(body.directories) || !Array.isArray(body.files)
      || !body.membership || !/^[a-f0-9-]{36}$/i.test(body.membership.operationId)
      || !/^[a-f0-9]{64}$/.test(body.membership.intentSha256)) return invalid();
    const anchor = anchors.find(item => item.operation_id === `native-subscription-generation:${fingerprint}`);
    if (!anchor || anchor.actor_id !== actor || anchor.fingerprint !== fingerprint
      || anchor.result !== json({ fingerprint })) return invalid();
    const outcome = readMembershipOutcome(db, initial.workspaceId, body.membership.operationId);
    if (!outcome?.terminal || outcome.terminal.outcome !== "committed" || outcome.terminal.head !== fingerprint
      || outcome.terminal.intentSha256 !== body.membership.intentSha256 || outcome.intent.expectedHead !== head
      || outcome.terminal.stateSha256 !== captureDigest(body)) return invalid();
    const seen = new Set<string>();
    for (const item of body.files) {
      if (!item || typeof item.path !== "string" || !item.path.startsWith("cache/") || item.path.includes("\\")
        || item.path.split("/").some(part => !part || part === "." || part === "..")
        || seen.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256)
        || !Number.isSafeInteger(item.size) || item.size < 0) return invalid();
      seen.add(item.path);
      const value = byKey.get(`${fingerprint}\0${item.path}`);
      if (!(value instanceof Uint8Array) || value.length !== item.size || hash(value) !== item.sha256) return invalid();
      total++;
    }
    head = fingerprint; state = body.state; directories = body.directories; files = body.files;
  }
  if (total !== blobs.length) return invalid();
  return { genesis: genesis.fingerprint, head, state, directories, files };
}

/** Read the receipt-bound native head without consulting the mutable legacy profile. */
export function readNativeSubscriptionProfile(storage: Storage, profile: string): RefreshView {
  storage.assertWorkspaceLease();
  const initial = binding(storage, profile), db = storage.connectNative();
  try {
    db.exec("BEGIN");
    if (readMembershipIntent(db, initial.workspaceId))
      throw new CoreError("RECOVERY_REQUIRED", "Subscription membership requires explicit recovery.", "unknown");
    const current = currentGeneration(db, initial);
    const rows = current.head === current.genesis
      ? db.prepare("SELECT path,bytes FROM native_subscription_profile_files").all()
      : db.prepare("SELECT path,bytes FROM native_subscription_generation_files WHERE fingerprint=?").all(current.head);
    const bytes = new Map(rows.map(row => [String(row.path), row.bytes]));
    const files = current.files.map(pin => {
      const value = bytes.get(pin.path);
      if (!(value instanceof Uint8Array) || value.length !== pin.size || hash(value) !== pin.sha256) return invalid();
      return { ...pin, bytes: Buffer.from(value) };
    });
    if (json(binding(storage, profile)) !== json(initial)) return invalid();
    storage.assertWorkspaceLease();
    db.exec("COMMIT");
    return { head: current.head, state: current.state, directories: current.directories, files };
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  finally { db.close(); }
}

/** Service is usable only through an explicitly provisioned native host; it never starts an old writer. */
export function createNativeSubscriptionProfileService(storage: Storage, profile: string): NativeSubscriptionHostService {
  const initial = binding(storage, profile);
  const guard = (assertHostHeld: () => void) => {
    storage.assertWorkspaceLease();
    assertNativeSubscriptionHostProof(assertHostHeld);
    if (json(binding(storage, profile)) !== json(initial)) return invalid();
  };
  const capture = (updatingTarget?: string, emptyStagingFor?: { nodeId: string; shareId: string }) =>
    captureProtectedSubscriptionRefresh(profile,
      { allowEmptyShares: true, allowAbsentEmptyCache: true, ...(updatingTarget ? { updatingTarget } : {}),
        ...(emptyStagingFor ? { emptyStagingFor } : {}) });
  return {
    async dispatch(request: Readonly<NativeSubscriptionHostRequest>, assertHostHeld: () => void) {
      if (request.phase === "status" || request.phase === "outcome") {
        guard(assertHostHeld);
        const db = storage.connectNative();
        try {
          db.exec("BEGIN");
          const admitted = readAdmission(db, initial);
          const result = request.phase === "outcome"
            ? readMembershipOutcome(db, initial.workspaceId, request.operationId!)
            : admitted ? { ...currentGeneration(db, initial), fingerprint: admitted.fingerprint,
              pending: readMembershipIntent(db, initial.workspaceId)?.intent ?? null } : null;
          guard(assertHostHeld);
          db.exec("COMMIT");
          return result ?? null;
        } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
        finally { db.close(); }
      }
      const phase = request.phase === "check" || request.phase === "publish" || request.phase === "cancel" || request.phase === "recover"
        ? request.phase as MembershipRecoveryPhase : undefined;
      const authority = phase && issueNativeMembershipRecoveryAuthority(storage, assertHostHeld, initial.workspaceId, request.operationId!, phase);
      return storage.withWorkspaceExclusive(async () => {
        guard(assertHostHeld);
        const db = storage.connectNative();
        try {
          const existing = readAdmission(db, initial);
          if (request.phase === "admit") {
            const captured = await capture();
            guard(assertHostHeld);
            const body: Body = { ...initial, ...pinCapture(captured) }, fingerprint = hash(json(body));
            if (existing) {
              if (existing.fingerprint !== fingerprint) throw new CoreError("CONFLICT", "Subscription profile differs from its admitted baseline.");
              return existing;
            }
            db.exec("BEGIN IMMEDIATE");
            try {
              guard(assertHostHeld);
              if (readAdmission(db, initial)) throw new CoreError("CONFLICT", "Subscription profile was concurrently admitted.");
              db.exec(ddl);
              db.prepare("INSERT INTO native_subscription_profile VALUES(1,?,?)").run(json(body), fingerprint);
              const insert = db.prepare("INSERT INTO native_subscription_profile_files(path,bytes) VALUES(?,?)");
              for (const file of captured.files) insert.run(file.path, file.bytes);
              db.prepare("INSERT INTO receipts(operation_id,fingerprint,result,actor_id,operation,committed_at) VALUES(?,?,?,?,?,?)")
                .run(`native-subscription-profile:${initial.workspaceId}`, fingerprint, json({ fingerprint }), actor, operation, new Date().toISOString());
              guard(assertHostHeld); db.exec("COMMIT");
            } catch (error) { db.exec("ROLLBACK"); throw error; }
            return { fingerprint, state: body.state, directories: body.directories, files: body.files };
          }
          const current = currentGeneration(db, initial), priorIntent = readMembershipIntent(db, initial.workspaceId);
          if (request.phase === "recover" && (!priorIntent || priorIntent.intent.action !== "refresh"
            || priorIntent.intent.operationId !== request.operationId))
            throw new CoreError("CONFLICT", "Subscription refresh recovery requires its exact pending intent.");
          const recoveryTarget = request.phase === "recover" && priorIntent
            ? { nodeId: priorIntent.intent.publisherNodeId, shareId: priorIntent.intent.shareId } : undefined;
          if (recoveryTarget) assertNoSubscriptionMaterializer();
          const captured = await capture(priorIntent?.intent.action === "refresh" ? priorIntent.intent.subscriptionId ?? undefined : undefined,
            recoveryTarget);
          const observed = pinCapture(captured);
          guard(assertHostHeld);
          const bytesRows = current.head === current.genesis
            ? db.prepare("SELECT path,bytes FROM native_subscription_profile_files").all()
            : db.prepare("SELECT path,bytes FROM native_subscription_generation_files WHERE fingerprint=?").all(current.head);
          const baselineBytes = new Map(bytesRows.map(row => [String(row.path), row.bytes]));
          const baseline = { state: current.state, directories: current.directories, files: current.files.map(file => {
            const bytes = baselineBytes.get(file.path);
            if (!(bytes instanceof Uint8Array)) return invalid();
            return { ...file, bytes };
          }) };
          if (request.phase === "prepare") {
            const change = request.change!, members = current.state.subscriptions;
            if (!Array.isArray(members) || captureDigest(observed) !== captureDigest(baseline)
              || request.expectedHead !== current.head) throw new CoreError("CONFLICT", "Subscription profile differs from its admitted head.");
            const targets = members.filter((record: any) => record.nodeId === change.publisherNodeId && record.shareId === change.shareId);
            if (change.action === "add" ? targets.length !== 0 : targets.length !== 1 || targets[0].id !== change.subscriptionId)
              throw new CoreError("CONFLICT", "Subscription membership target changed.");
            if (change.action === "github-refresh") validateNativeGitHubTarget(baseline, change);
            db.exec("BEGIN IMMEDIATE");
            try {
              guard(assertHostHeld);
              prepareMembershipIntent(db, { schema: "pkm.subscription-membership-intent/v1", workspaceId: initial.workspaceId,
                operationId: request.operationId!, action: change.action, publisherNodeId: change.publisherNodeId, shareId: change.shareId,
                subscriptionId: change.action === "add" ? null : change.subscriptionId, expectedHead: current.head,
                baselineSha256: captureDigest(baseline), requestSha256: nativeSubscriptionChangeSha256(change),
                ...(change.action === "github-refresh" ? { githubRequest: change } : {}) },
              currentGeneration(db, initial).head, () => guard(assertHostHeld));
              guard(assertHostHeld); db.exec("COMMIT");
            } catch (error) { db.exec("ROLLBACK"); throw error; }
            return { prepared: true };
          }
          const pending = readMembershipIntent(db, initial.workspaceId);
          if (!pending || pending.intent.operationId !== request.operationId || pending.intent.expectedHead !== current.head
            || pending.intent.baselineSha256 !== captureDigest(baseline))
            throw new CoreError("CONFLICT", "Subscription membership requires exact explicit recovery.");
          if (request.phase === "recover") {
            const change = { action: "refresh" as const, publisherNodeId: pending.intent.publisherNodeId,
              shareId: pending.intent.shareId, subscriptionId: pending.intent.subscriptionId! };
            if (nativeSubscriptionChangeSha256(change) !== pending.intent.requestSha256)
              throw new CoreError("CONFLICT", "Subscription refresh recovery request changed.");
            validateNativeRefreshRetry(baseline, observed, change);
            if (captured.emptyStaging.length) {
              assertNoSubscriptionMaterializer();
              const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
              const opened: number[] = [];
              try {
                const profileFd = openSync(profile, flags); opened.push(profileFd);
                const pinned = fstatSync(profileFd, { bigint: true });
                if (`${pinned.dev}` !== initial.profileDevice || `${pinned.ino}` !== initial.profileInode) return invalid();
                const cacheFd = openSync(`/proc/self/fd/${profileFd}/cache`, flags); opened.push(cacheFd);
                const nodeFd = openSync(`/proc/self/fd/${cacheFd}/${change.publisherNodeId}`, flags); opened.push(nodeFd);
                for (const relativePath of captured.emptyStaging) {
                  guard(assertHostHeld);
                  const name = relativePath.split("/")[2]!;
                  const directory = `/proc/self/fd/${nodeFd}/${name}`;
                  const fd = openSync(directory, flags); opened.push(fd);
                  if (readdirSync(`/proc/self/fd/${fd}`).length) throw new CoreError("CONFLICT", "Subscription staging is no longer empty.");
                  const before = fstatSync(fd, { bigint: true }), entry = lstatSync(directory, { bigint: true });
                  if (before.dev !== entry.dev || before.ino !== entry.ino || !entry.isDirectory())
                    throw new CoreError("CONFLICT", "Subscription staging changed during recovery.");
                  rmdirSync(directory);
                }
                guard(assertHostHeld);
              } finally { for (const fd of opened.reverse()) closeSync(fd); }
            }
            return { removedEmptyStaging: captured.emptyStaging.length };
          }
          if (request.phase === "cancel") {
            if (captureDigest(observed) !== pending.intent.baselineSha256)
              throw new CoreError("CONFLICT", "Subscription membership outcome is unknown.");
            db.exec("BEGIN IMMEDIATE");
            try {
              finishMembershipIntent(db, initial.workspaceId, request.operationId!, "cancelled", current.head,
                pending.intent.baselineSha256, () => guard(assertHostHeld));
              guard(assertHostHeld); db.exec("COMMIT");
            } catch (error) { db.exec("ROLLBACK"); throw error; }
            return { cancelled: true };
          }
          const change = request.change!;
          if (nativeSubscriptionChangeSha256(change) !== pending.intent.requestSha256)
            throw new CoreError("CONFLICT", "Subscription membership request changed.");
          if (request.phase === "check") {
            if (change.action === "priority" || change.action === "rename") validateNativePriorityChange(baseline, observed, change, false);
            else if (change.action === "refresh") validateNativeRefreshRetry(baseline, observed, change);
            else if (change.action === "github-refresh") {
              validateNativeGitHubTarget(baseline, change);
              if (captureDigest(observed) !== captureDigest(baseline))
                throw new CoreError("CONFLICT", "GitHub Subscription outcome is unknown.");
            }
            else validatePendingMembershipRetry(baseline, observed, change);
            return { targetExists: (observed.state.subscriptions as any[]).some(record =>
              record.nodeId === change.publisherNodeId && record.shareId === change.shareId) };
          }
          if (request.phase !== "publish" || (change.action === "add" || change.action === "refresh" || change.action === "github-refresh") && !request.verifiedPull)
            throw new CoreError("CONFLICT", "Authenticated Subscription pull is required.");
          const next = { ...observed, files: captured.files.map(file =>
            ({ path: file.path, sha256: file.sha256, size: file.bytes.length, bytes: file.bytes })) };
          if (change.action === "priority" || change.action === "rename") validateNativePriorityChange(baseline, next, change, true);
          else if (change.action === "refresh") validateProtectedRefreshChange(baseline.state, baseline, next,
            change.shareId, false, false, change.publisherNodeId);
          else if (change.action === "github-refresh") validateNativeGitHubRefresh(baseline, next, change);
          else validateMembershipChange(baseline, next, change);
          const body: Generation = { schema: "pkm.native-subscription-generation/v1", workspaceId: initial.workspaceId,
            genesis: current.genesis, parent: current.head, ...observed,
            membership: { operationId: request.operationId!, intentSha256: pending.fingerprint } };
          const fingerprint = hash(json(body));
          db.exec("BEGIN IMMEDIATE");
          try {
            guard(assertHostHeld);
            if (currentGeneration(db, initial).head !== current.head
              || readMembershipIntent(db, initial.workspaceId)?.fingerprint !== pending.fingerprint)
              throw new CoreError("CONFLICT", "Subscription membership head or intent changed.");
            db.prepare("INSERT INTO native_subscription_generations(sequence,fingerprint,body) VALUES(?,?,?)")
              .run(Number(db.prepare("SELECT COUNT(*) AS n FROM native_subscription_generations").get()!.n) + 1, fingerprint, json(body));
            const insert = db.prepare("INSERT INTO native_subscription_generation_files(fingerprint,path,bytes) VALUES(?,?,?)");
            for (const file of captured.files) insert.run(fingerprint, file.path, file.bytes);
            db.prepare("INSERT INTO receipts(operation_id,fingerprint,result,actor_id,operation,committed_at) VALUES(?,?,?,?,?,?)")
              .run(`native-subscription-generation:${fingerprint}`, fingerprint, json({ fingerprint }), actor, generationOperation, new Date().toISOString());
            finishMembershipIntent(db, initial.workspaceId, request.operationId!, "committed", fingerprint,
              captureDigest(observed), () => guard(assertHostHeld));
            guard(assertHostHeld); db.exec("COMMIT");
          } catch (error) { db.exec("ROLLBACK"); throw error; }
          return { head: fingerprint };
        } finally { db.close(); }
      }, phase && authority ? { authority, phase } : undefined);
    },
  };
}
