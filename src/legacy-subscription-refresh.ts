import { createHash } from "node:crypto";
import { coreDatabasePath } from "./workspace-storage-paths.js";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoreError } from "./contracts.js";
import { readLegacyStateReceipt } from "./host-composition-legacy-state.js";
import { finishMembershipIntent, prepareMembershipIntent, readMembershipIntent, readMembershipOutcome } from "./legacy-subscription-membership-intent.js";
import { issueMembershipRecoveryAuthority, type MembershipRecoveryPhase } from "./legacy-subscription-membership-authority.js";
import { membershipRequestSha256, validateMembershipChange, validatePendingMembershipRetry,
  type MembershipChange } from "./legacy-subscription-membership-change.js";
import { captureProtectedSubscriptionRefresh } from "./legacy-state-import.js";
import type { Storage } from "./storage.js";

type FilePin = { path: string; sha256: string; size: number };
type Body = {
  schema: "pkm.fixture-subscription-refresh/v1"; workspaceId: string; genesis: string;
  parent: string | null; state: Record<string, unknown>; directories: string[]; files: FilePin[];
  membership?: { operationId: string; intentSha256: string };
};
type RefreshCapture = { state: Record<string, any>; directories: string[]; files: FilePin[] };
export type RefreshView = { head: string; state: Record<string, unknown>; directories: string[];
  files: Array<FilePin & { bytes: Buffer }> };
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const invalid = (): never => { throw new CoreError("IMPORT_RECEIPT_INVALID", "Subscription refresh receipt or cache is invalid."); };
const json = (value: unknown) => JSON.stringify(value);
const captureSha256 = (value: RefreshCapture) => hash(json({ state: value.state, directories: value.directories,
  files: value.files.map(({ path, sha256, size }) => ({ path, sha256, size })) }));
const sql = `
  CREATE TABLE IF NOT EXISTS fixture_subscription_refresh (
    sequence INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE,
    parent TEXT, body TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fixture_subscription_refresh_files (
    fingerprint TEXT NOT NULL, path TEXT NOT NULL, bytes BLOB NOT NULL,
    PRIMARY KEY(fingerprint,path)
  );
  CREATE TRIGGER IF NOT EXISTS fixture_subscription_refresh_no_update BEFORE UPDATE ON fixture_subscription_refresh
    BEGIN SELECT RAISE(ABORT,'Immutable Subscription refresh'); END;
  CREATE TRIGGER IF NOT EXISTS fixture_subscription_refresh_no_delete BEFORE DELETE ON fixture_subscription_refresh
    BEGIN SELECT RAISE(ABORT,'Immutable Subscription refresh'); END;
  CREATE TRIGGER IF NOT EXISTS fixture_subscription_refresh_files_no_update BEFORE UPDATE ON fixture_subscription_refresh_files
    BEGIN SELECT RAISE(ABORT,'Immutable Subscription refresh file'); END;
  CREATE TRIGGER IF NOT EXISTS fixture_subscription_refresh_files_no_delete BEFORE DELETE ON fixture_subscription_refresh_files
    BEGIN SELECT RAISE(ABORT,'Immutable Subscription refresh file'); END;
`;
const anchorOperation = "fixture.subscription.refresh";
const actor = "native:fixture-subscription-refresh";

/** A host action may publish only its own subscriber; unrelated durable writes require explicit reconciliation. */
export function validateProtectedRefreshChange(genesis: Record<string, any>, previous: RefreshCapture,
  next: RefreshCapture, shareId: string, failure = false, priority = false, publisherNodeId = genesis.nodeId): void {
  const conflict = (message: string): never => { throw new CoreError("CONFLICT", message); };
  const state = next.state;
  if (state.nodeId !== genesis.nodeId || state.publicKey !== genesis.publicKey
    || json(state.shares) !== json(genesis.shares)
    || previous.state.nodeId !== genesis.nodeId || previous.state.publicKey !== genesis.publicKey
    || json(previous.state.shares) !== json(genesis.shares) || !Array.isArray(genesis.subscriptions)
    || !Array.isArray(previous.state.subscriptions) || !Array.isArray(state.subscriptions)
    || state.subscriptions.length !== previous.state.subscriptions.length)
    return conflict("Subscription refresh identity changed.");
  const valid = (record: any) => record && typeof record === "object" && !Array.isArray(record)
    && typeof record.id === "string" && typeof record.nodeId === "string" && typeof record.shareId === "string";
  const before = previous.state.subscriptions as any[], original = before, after = state.subscriptions as any[];
  if (!original.every(valid) || !before.every(valid) || !after.every(valid)
    || new Set(original.map(item => item.id)).size !== original.length
    || new Set(original.map(item => `${item.nodeId}\0${item.shareId}`)).size !== original.length)
    return conflict("Subscription refresh membership changed.");
  const targets = original.filter(item => item.shareId === shareId && item.nodeId === publisherNodeId);
  if (targets.length !== 1) return conflict("Subscription refresh target is ambiguous.");
  const target = targets[0], fixed = ["id", "nodeId", "shareId", "publicKey", "magicLink", "endpoint",
    "secretProtected", "secretSalt", "publisherUser", "publisherHost"];
  for (let i = 0; i < original.length; i++) {
    if (fixed.some(key => before[i][key] !== original[i][key] || after[i][key] !== original[i][key]))
      return conflict("Subscription refresh membership changed.");
    if (original[i].id !== target.id && json(before[i]) !== json(after[i]))
      return conflict("Another Subscription changed outside this host action.");
  }
  const index = original.findIndex(item => item.id === target.id), old = before[index], updated = after[index];
  if (failure && priority) return conflict("Subscription action is invalid.");
  if (updated.status !== (failure ? "offline" : "current") || !Number.isSafeInteger(updated.revision)
    || !Number.isSafeInteger(old.revision) || updated.revision < old.revision)
    return conflict("Subscription revision or status is invalid.");
  const mutable = new Set(failure ? ["status", "error", "lastChecked"] : priority ? ["priority"]
    : ["status", "error", "lastChecked", "lastUpdated", "brokerName", "etag", "topics", "tags", "counts",
      "itemCount", "revision", "collectionHash"]);
  const unchanged = (record: Record<string, unknown>) => Object.fromEntries(
    Object.entries(record).filter(([key]) => !mutable.has(key)));
  if (json(unchanged(old)) !== json(unchanged(updated)))
    return conflict("Subscription has unrelated changes outside this host action.");
  const prefix = `cache/${target.nodeId}/${target.shareId}/`;
  const pins = (files: FilePin[], select: (path: string) => boolean) => files.filter(file => select(file.path))
    .map(({ path, sha256, size }) => ({ path, sha256, size })).sort((a, b) => a.path.localeCompare(b.path));
  const foreign = (path: string) => !path.startsWith(prefix);
  const otherDirectories = (dirs: string[]) => dirs.filter(path => !`${path}/`.startsWith(`subscriptions/${prefix}`)).sort();
  if (json(pins(previous.files, foreign)) !== json(pins(next.files, foreign))
    || json(otherDirectories(previous.directories)) !== json(otherDirectories(next.directories)))
    return conflict("Another Subscription cache changed outside this host action.");
  if (failure) {
    if (!["Broker returned 403.", "Broker returned 401.", "fetch failed", "The operation was aborted due to timeout"].includes(updated.error)
      || json(pins(previous.files, () => true)) !== json(pins(next.files, () => true))
      || json([...previous.directories].sort()) !== json([...next.directories].sort()))
      return conflict("Failed Subscription refresh changed cache or metadata.");
  }
  if (priority) {
    const metadata = `${prefix}_subscription.json`;
    if (!["normal", "high", "highest"].includes(updated.priority)
      || json(pins(previous.files, path => path !== metadata)) !== json(pins(next.files, path => path !== metadata))
      || json([...previous.directories].sort()) !== json([...next.directories].sort()))
      return conflict("Subscription priority action changed unrelated cache.");
  }
  if (updated.revision === old.revision) {
    const content = (path: string) => path.startsWith(`${prefix}content/`) && !path.endsWith(".pkm-source.json");
    if (updated.collectionHash !== old.collectionHash
      || json(pins(previous.files, content)) !== json(pins(next.files, content)))
      return conflict("Subscription revision has conflicting content.");
  }
}

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("cache/") && !value.includes("\\")
    && value.split("/").every(part => !!part && part !== "." && part !== ".." && !part.includes("\0"));
}
function marker(root: string): string {
  const file = join(root, ".pkm-next-workspace"), before = lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 4096n) return invalid();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const same = (stat: BigIntStats) => stat.dev === before.dev && stat.ino === before.ino
      && stat.size === before.size && stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs && stat.nlink === 1n;
    if (!same(fstatSync(fd, { bigint: true }))) return invalid();
    const bytes = readFileSync(fd);
    if (BigInt(bytes.length) !== before.size || !same(fstatSync(fd, { bigint: true }))
      || !same(lstatSync(file, { bigint: true }))) return invalid();
    const data = JSON.parse(bytes.toString("utf8")) as { schema?: unknown; id?: unknown };
    if (data.schema !== "pkm.next-workspace/v2" || typeof data.id !== "string"
      || !/^[a-f0-9-]{36}$/i.test(data.id)) return invalid();
    return data.id;
  } finally { closeSync(fd); }
}

function verifySubscriptionGenesis(root: string, database: DatabaseSync, workspaceId: string): void {
  const receipt = readLegacyStateReceipt(database, workspaceId);
  const plan = receipt?.plan.statePlan;
  if (!plan?.protectedSubscriptions) return invalid();
  const base = join(root, "subscriptions"), baseStat = lstatSync(base, { bigint: true });
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink() || realpathSync(base) !== base) return invalid();
  const entries = plan.entries.filter(entry => entry.destination.startsWith("subscriptions/"));
  const expectedNames = [...new Set(entries.map(entry => entry.destination.split("/")[1]!))];
  if (plan.directories?.some(dir => dir.startsWith("subscriptions/cache"))) expectedNames.push("cache");
  if (json([...new Set(expectedNames)].sort()) !== json(readdirSync(base).sort())) return invalid();
  const expected = new Map(entries.map(entry => [entry.destination.slice("subscriptions/".length), entry]));
  const expectedDirs = new Set((plan.directories ?? []).filter(path => path.startsWith("subscriptions/cache"))
    .map(path => path.slice("subscriptions/".length)));
  const seen = new Set<string>(), seenDirs = new Set<string>();
  const same = (a: BigIntStats, b: BigIntStats) =>
    a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
  const walk = (relative: string): void => {
    const full = join(base, ...relative.split("/")), before = lstatSync(full, { bigint: true });
    if (before.isSymbolicLink() || realpathSync(full) !== full) return invalid();
    if (before.isDirectory()) {
      if (relative === "cache" || relative.startsWith("cache/")) {
        if (!expectedDirs.has(relative)) return invalid();
        seenDirs.add(relative);
      } else if (relative !== "snapshots") return invalid();
      for (const name of readdirSync(full).sort()) walk(`${relative}/${name}`);
      if (!same(before, lstatSync(full, { bigint: true }))) return invalid();
      return;
    }
    const entry = expected.get(relative);
    if (!entry || !before.isFile() || before.nlink !== 1n || before.size !== BigInt(entry.size)) return invalid();
    const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!same(before, fstatSync(fd, { bigint: true }))) return invalid();
      const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
      let total = 0, count: number;
      while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) { digest.update(buffer.subarray(0, count)); total += count; }
      if (total !== entry.size || digest.digest("hex") !== entry.sha256
        || !same(before, fstatSync(fd, { bigint: true })) || !same(before, lstatSync(full, { bigint: true }))) return invalid();
    } finally { closeSync(fd); }
    seen.add(relative);
  };
  for (const name of readdirSync(base).sort()) walk(name);
  if (seen.size !== expected.size || seenDirs.size !== expectedDirs.size
    || !same(baseStat, lstatSync(base, { bigint: true }))) return invalid();
}

/** Revalidates the immutable genesis, every chained receipt and all cached bytes. */
export function readProtectedRefresh(database: DatabaseSync, workspaceId: string): RefreshView | undefined {
  database.exec("SAVEPOINT pkm_fixture_refresh_read");
  try { return readProtectedRefreshSnapshot(database, workspaceId); }
  finally { database.exec("RELEASE pkm_fixture_refresh_read"); }
}

function readProtectedRefreshSnapshot(database: DatabaseSync, workspaceId: string): RefreshView | undefined {
  const names = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('fixture_subscription_refresh','fixture_subscription_refresh_files')").all();
  const receipts = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='receipts'").get();
  if (!receipts) {
    if (!names.length) return undefined;
    return invalid();
  }
  const anchors = database.prepare("SELECT operation_id,fingerprint,result,actor_id FROM receipts WHERE operation=? ORDER BY operation_id").all(anchorOperation);
  if (!names.length && !anchors.length) return undefined;
  if (names.length !== 2 || !anchors.length) return invalid();
  const receipt = readLegacyStateReceipt(database, workspaceId);
  if (!receipt?.plan.statePlan?.protectedSubscriptions) return invalid();
  const genesis = receipt.outcome.receipt.receiptSha256;
  const rows = database.prepare("SELECT sequence,workspace_id,fingerprint,parent,body FROM fixture_subscription_refresh ORDER BY sequence").all();
  if (rows.length !== anchors.length || !rows.length) return invalid();
  const blobs = database.prepare("SELECT fingerprint,path,bytes FROM fixture_subscription_refresh_files ORDER BY fingerprint,path").all();
  const byKey = new Map(blobs.map(row => [`${row.fingerprint}\0${row.path}`, row.bytes]));
  if (byKey.size !== blobs.length) return invalid();
  let parent: string | null = null, view: RefreshView | undefined, count = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!, fingerprint = String(row.fingerprint);
    let body: Body;
    try { body = JSON.parse(String(row.body)) as Body; } catch { return invalid(); }
    if (!body || body.schema !== "pkm.fixture-subscription-refresh/v1" || body.workspaceId !== workspaceId
      || body.genesis !== genesis || body.parent !== parent || row.parent !== parent || row.workspace_id !== workspaceId
      || row.sequence !== index + 1 || hash(json(body)) !== fingerprint || json(body) !== row.body
      || !body.state || typeof body.state !== "object" || Array.isArray(body.state)
      || !Array.isArray(body.directories) || !Array.isArray(body.files)) return invalid();
    const anchor = anchors.find(item => item.operation_id === `fixture:subscription-refresh:${fingerprint}`);
    if (!anchor || anchor.actor_id !== actor || anchor.fingerprint !== fingerprint
      || anchor.result !== json({ fingerprint })) return invalid();
    const seen = new Set<string>(), files: RefreshView["files"] = [];
    for (const pin of body.files) {
      if (!pin || !safePath(pin.path) || !/^[a-f0-9]{64}$/.test(pin.sha256)
        || !Number.isSafeInteger(pin.size) || pin.size < 0 || seen.has(pin.path)) return invalid();
      seen.add(pin.path);
      const value = byKey.get(`${fingerprint}\0${pin.path}`);
      if (!(value instanceof Uint8Array)) return invalid();
      const bytes = Buffer.from(value);
      if (bytes.length !== pin.size || hash(bytes) !== pin.sha256) return invalid();
      files.push({ ...pin, bytes }); count++;
    }
    if (new Set(body.directories).size !== body.directories.length
      || body.directories.some(path => typeof path !== "string"
        || !(path === "subscriptions/cache" || safePath(path.slice("subscriptions/".length))))) return invalid();
    if (body.membership) {
      const membership = body.membership;
      if (Object.keys(membership).sort().join(",") !== "intentSha256,operationId"
        || !/^[a-f0-9-]{36}$/.test(membership.operationId) || !/^[a-f0-9]{64}$/.test(membership.intentSha256))
        return invalid();
      const result = readMembershipOutcome(database, workspaceId, membership.operationId);
      if (!result?.terminal || result.terminal.outcome !== "committed" || result.terminal.head !== fingerprint
        || result.terminal.intentSha256 !== membership.intentSha256 || result.intent.expectedHead !== parent
        || result.terminal.stateSha256 !== captureSha256({ state: body.state, directories: body.directories, files: body.files }))
        return invalid();
    }
    parent = fingerprint;
    view = { head: fingerprint, state: body.state, directories: body.directories, files };
  }
  if (count !== blobs.length) return invalid();
  return view;
}

/** Direct readers use the same receipt checks as native workspace recovery. */
export function readProtectedRefreshAtRoot(root: string): RefreshView | undefined {
  const connection = openProtectedRefresh(root);
  try { return connection.read(); } finally { connection.close(); }
}

export function openProtectedRefresh(root: string): { read(): RefreshView | undefined; close(): void } {
  const file = coreDatabasePath(root);
  if (!existsSync(file)) return { read: () => undefined, close: () => {} };
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return invalid();
  const db = new DatabaseSync(file, { readOnly: true });
  return { read: () => {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fixture_subscription_refresh'").get();
    const files = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fixture_subscription_refresh_files'").get();
    const receipts = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='receipts'").get();
    const anchor = receipts && db.prepare("SELECT 1 FROM receipts WHERE operation=? LIMIT 1").get(anchorOperation);
    if (!table && !files && !anchor) return undefined;
    const workspaceId = marker(root), result = readProtectedRefresh(db, workspaceId);
    if (result) verifySubscriptionGenesis(root, db, workspaceId);
    return result;
  }, close: () => db.close() };
}

async function withProtectedFixtureSession<T>(storage: Storage, profile: string, nonce: string,
  action: (context: {
    db: DatabaseSync; workspaceId: string;
    receipt: NonNullable<ReturnType<typeof readLegacyStateReceipt>>;
    current: RefreshView | undefined;
    capture: Awaited<ReturnType<typeof captureProtectedSubscriptionRefresh>>;
    original: Record<string, any>;
  }) => Promise<T>, recovery?: { operationId: string; phase: MembershipRecoveryPhase }): Promise<T> {
  const root = storage.workspaceRoot();
  const fixture = dirname(root);
  if (process.platform !== "linux" || process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT !== fixture
    || process.env.PKM_PRIVATE_SUBSCRIPTION_UI !== "1" || resolve(fixture) !== fixture
    || !/^pkm-protected-state-fixture-[a-f0-9-]{36}$/.test(basename(fixture))
    || root !== join(fixture, "imported") || profile !== join(fixture, "profile")
    || !/^[a-f0-9-]{36}$/.test(nonce))
    throw new CoreError("FORBIDDEN", "Private Subscription refresh is not authorized.");
  for (const dir of [fixture, root, profile, join(fixture, "original")]) {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(dir) !== dir
      || stat.uid !== process.getuid?.() || (stat.mode & 0o7077) !== 0)
      throw new CoreError("FORBIDDEN", "Private Subscription refresh binding is invalid.");
  }
  const markerFile = join(fixture, "subscription-state-fixture.json"), markerStat = lstatSync(markerFile);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1
    || markerStat.uid !== process.getuid?.() || (markerStat.mode & 0o7077) !== 0 || markerStat.size > 4096)
    throw new CoreError("FORBIDDEN", "Private Subscription refresh binding is invalid.");
  const fixtureMarker = JSON.parse(readFileSync(markerFile, "utf8")) as Record<string, unknown>;
  const sourceStat = lstatSync(join(fixture, "original"), { bigint: true }), profileStat = lstatSync(profile, { bigint: true });
  if (Object.keys(fixtureMarker).sort().join(",") !== "nonce,profilePin,rootPin,schema"
    || fixtureMarker.schema !== "pkm.protected-subscription-state-fixture/v1" || fixtureMarker.nonce !== nonce
    || fixtureMarker.rootPin !== `${sourceStat.dev}:${sourceStat.ino}`
    || fixtureMarker.profilePin !== `${profileStat.dev}:${profileStat.ino}`)
    throw new CoreError("FORBIDDEN", "Private Subscription refresh binding is invalid.");
  const lock = join(profile, "subscriptions-state.lock"), lockStat = lstatSync(lock, { bigint: true });
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink() || lockStat.uid !== BigInt(process.getuid!()))
    throw new CoreError("FORBIDDEN", "Subscription refresh requires its original host lock.");
  const lockFiles = requireLockFiles(lock);
  const lockFile = join(lock, lockFiles[0]!), ownerStat = lstatSync(lockFile, { bigint: true });
  if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.nlink !== 1n
    || ownerStat.uid !== BigInt(process.getuid!()) || (Number(ownerStat.mode) & 0o7077) !== 0 || ownerStat.size > 4096n)
    throw new CoreError("FORBIDDEN", "Subscription refresh host lock is invalid.");
  const owner = JSON.parse(readFileSync(lockFile, "utf8")) as { pid?: unknown; owner?: unknown; nonce?: unknown };
  if (owner.pid !== process.ppid || owner.owner !== "Subscription state mutation" || `${owner.nonce}.json` !== lockFiles[0])
    throw new CoreError("FORBIDDEN", "Subscription refresh requires its original host lock.");
  const authority = recovery && issueMembershipRecoveryAuthority(storage, profile, nonce, recovery.operationId, recovery.phase);
  return storage.withWorkspaceExclusive(async () => {
    const db = new DatabaseSync(coreDatabasePath(root));
    try {
      db.exec("PRAGMA synchronous=FULL");
      const workspaceId = marker(root), receipt = readLegacyStateReceipt(db, workspaceId);
      if (!receipt?.plan.statePlan?.protectedSubscriptions || receipt.plan.statePlan.subscriptionRoot !== profile)
        return invalid();
      verifySubscriptionGenesis(root, db, workspaceId);
      const current = readProtectedRefresh(db, workspaceId);
      const capture = await captureProtectedSubscriptionRefresh(profile);
      const afterLock = lstatSync(lock, { bigint: true });
      const afterOwner = lstatSync(lockFile, { bigint: true });
      const profileAfter = lstatSync(profile, { bigint: true });
      const rootAfter = lstatSync(join(fixture, "original"), { bigint: true });
      if (afterLock.dev !== lockStat.dev || afterLock.ino !== lockStat.ino || json(requireLockFiles(lock)) !== json(lockFiles)
        || afterOwner.dev !== ownerStat.dev || afterOwner.ino !== ownerStat.ino
        || afterOwner.size !== ownerStat.size || afterOwner.mtimeNs !== ownerStat.mtimeNs || afterOwner.ctimeNs !== ownerStat.ctimeNs
        || profileAfter.dev !== profileStat.dev || profileAfter.ino !== profileStat.ino
        || rootAfter.dev !== sourceStat.dev || rootAfter.ino !== sourceStat.ino)
        throw new CoreError("FORBIDDEN", "Subscription refresh host lock changed.");
      const original = JSON.parse(readFileSync(join(root, "subscriptions", "subscriptions.json"), "utf8")) as Record<string, any>;
      return await action({ db, workspaceId, receipt, current, capture, original });
    } finally { db.close(); }
  }, recovery && authority ? { authority, phase: recovery.phase } : undefined);
}

function admittedMembershipBaseline(context: {
  receipt: NonNullable<ReturnType<typeof readLegacyStateReceipt>>;
  current: RefreshView | undefined; original: Record<string, any>;
}): RefreshCapture {
  const plan = context.receipt.plan.statePlan;
  if (!plan) return invalid();
  return {
    state: (context.current?.state ?? context.original) as Record<string, any>,
    directories: context.current?.directories ?? (plan.directories ?? []).filter(dir => dir.startsWith("subscriptions/cache")),
    files: context.current?.files ?? plan.entries.filter(entry => entry.destination.startsWith("subscriptions/cache/"))
      .map(entry => ({ path: entry.destination.slice("subscriptions/".length), sha256: entry.sha256, size: entry.size })),
  };
}

function capturedMembership(context: { capture: Awaited<ReturnType<typeof captureProtectedSubscriptionRefresh>> }): RefreshCapture {
  return { state: context.capture.projection as Record<string, any>, directories: context.capture.directories,
    files: context.capture.files.map(file => ({ path: file.path, sha256: file.sha256, size: file.bytes.length })) };
}

/** Prepare before invoking the original host; neither the intent nor the receipt stores the Broker secret. */
export async function prepareProtectedMembershipFixture(storage: Storage, profile: string, nonce: string,
  operationId: string, expectedHead: string | null, change: MembershipChange): Promise<void> {
  const requestSha256 = membershipRequestSha256(change);
  return withProtectedFixtureSession(storage, profile, nonce, async context => {
    const { db, workspaceId, current } = context;
    const baseline = admittedMembershipBaseline(context);
    if (captureSha256(baseline) !== captureSha256(capturedMembership(context)))
      throw new CoreError("CONFLICT", "Subscription profile differs from its admitted baseline.");
    const members = baseline.state.subscriptions;
    if (!Array.isArray(members)) return invalid();
    const targets = members.filter((record: any) => record.nodeId === change.publisherNodeId && record.shareId === change.shareId);
    if (change.action === "add" ? targets.length !== 0 : targets.length !== 1 || targets[0].id !== change.subscriptionId)
      throw new CoreError("CONFLICT", "Subscription membership target changed.");
    db.exec("BEGIN IMMEDIATE");
    try {
      storage.assertWorkspaceLease();
      const latest = readProtectedRefresh(db, workspaceId);
      prepareMembershipIntent(db, { schema: "pkm.subscription-membership-intent/v1", workspaceId, operationId,
        action: change.action, publisherNodeId: change.publisherNodeId, shareId: change.shareId,
        subscriptionId: change.action === "remove" ? change.subscriptionId : null,
        expectedHead, baselineSha256: captureSha256(baseline), requestSha256 },
      latest?.head ?? null, () => storage.assertWorkspaceLease());
      if ((current?.head ?? null) !== (latest?.head ?? null))
        throw new CoreError("CONFLICT", "Subscription membership head changed.");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  });
}

/** Recheck the approved target and all foreign state before an explicit retry can reach the old client. */
export async function inspectProtectedMembershipRetryFixture(storage: Storage, profile: string, nonce: string,
  operationId: string, change: MembershipChange): Promise<{ targetExists: boolean }> {
  const requestSha256 = membershipRequestSha256(change);
  return withProtectedFixtureSession(storage, profile, nonce, async context => {
    const pending = readMembershipIntent(context.db, context.workspaceId), baseline = admittedMembershipBaseline(context);
    if (!pending || pending.intent.operationId !== operationId || pending.intent.requestSha256 !== requestSha256
      || pending.intent.expectedHead !== (context.current?.head ?? null)
      || pending.intent.baselineSha256 !== captureSha256(baseline))
      throw new CoreError("CONFLICT", "Subscription membership requires exact explicit recovery.");
    const observed = capturedMembership(context);
    validatePendingMembershipRetry(baseline, observed, change);
    return { targetExists: observed.state.subscriptions.some((record: any) =>
      record.nodeId === change.publisherNodeId && record.shareId === change.shareId) };
  }, { operationId, phase: "check" });
}

/**
 * Publish only the exact pending action. A live trusted host must set verifiedPull after
 * the original client's authenticated pull completes; an unverified add is never accepted.
 */
export async function publishProtectedMembershipFixture(storage: Storage, profile: string, nonce: string,
  operationId: string, change: MembershipChange, verifiedPull: boolean,
  crashAfterFirstFile = false, crashAfterCommit = false): Promise<string> {
  const requestSha256 = membershipRequestSha256(change);
  return withProtectedFixtureSession(storage, profile, nonce, async context => {
    const { db, workspaceId, receipt, current, capture } = context;
    const pending = readMembershipIntent(db, workspaceId), baseline = admittedMembershipBaseline(context);
    if (!pending || pending.intent.operationId !== operationId || pending.intent.action !== change.action
      || pending.intent.publisherNodeId !== change.publisherNodeId || pending.intent.shareId !== change.shareId
      || pending.intent.requestSha256 !== requestSha256 || pending.intent.expectedHead !== (current?.head ?? null)
      || pending.intent.baselineSha256 !== captureSha256(baseline)
      || change.action === "add" && !verifiedPull)
      throw new CoreError("CONFLICT", "Subscription membership requires exact explicit recovery.");
    const files = capture.files.map(file => ({ path: file.path, sha256: file.sha256, size: file.bytes.length }));
    const after = { state: capture.projection as Record<string, any>, directories: capture.directories, files };
    validateMembershipChange(baseline, { ...after, files: capture.files.map(file =>
      ({ path: file.path, sha256: file.sha256, size: file.bytes.length, bytes: file.bytes })) }, change);
    const body: Body = { schema: "pkm.fixture-subscription-refresh/v1", workspaceId,
      genesis: receipt.outcome.receipt.receiptSha256, parent: current?.head ?? null,
      state: after.state, directories: after.directories, files,
      membership: { operationId, intentSha256: pending.fingerprint } };
    const fingerprint = hash(json(body));
    db.exec("BEGIN IMMEDIATE");
    try {
      storage.assertWorkspaceLease();
      if ((readProtectedRefresh(db, workspaceId)?.head ?? null) !== pending.intent.expectedHead
        || readMembershipIntent(db, workspaceId)?.fingerprint !== pending.fingerprint)
        throw new CoreError("CONFLICT", "Subscription membership head or intent changed.");
      db.exec(sql);
      db.prepare("INSERT INTO fixture_subscription_refresh(sequence,workspace_id,fingerprint,parent,body) VALUES(?,?,?,?,?)")
        .run((db.prepare("SELECT COUNT(*) AS n FROM fixture_subscription_refresh").get()?.n as number) + 1,
          workspaceId, fingerprint, body.parent, json(body));
      const insert = db.prepare("INSERT INTO fixture_subscription_refresh_files(fingerprint,path,bytes) VALUES(?,?,?)");
      for (const [index, file] of capture.files.entries()) {
        insert.run(fingerprint, file.path, file.bytes);
        if (crashAfterFirstFile && index === 0) process.exit(80);
      }
      db.prepare("INSERT INTO receipts(operation_id,fingerprint,result,actor_id,operation,committed_at) VALUES(?,?,?,?,?,?)")
        .run(`fixture:subscription-refresh:${fingerprint}`, fingerprint, json({ fingerprint }), actor, anchorOperation, new Date().toISOString());
      finishMembershipIntent(db, workspaceId, operationId, "committed", fingerprint, captureSha256(after),
        () => storage.assertWorkspaceLease());
      db.exec("COMMIT");
      if (crashAfterCommit) process.exit(81);
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return fingerprint;
  }, { operationId, phase: "publish" });
}

/** An explicit cancellation is safe only while the profile exactly matches the admitted baseline. */
export async function cancelProtectedMembershipFixture(storage: Storage, profile: string, nonce: string,
  operationId: string): Promise<void> {
  return withProtectedFixtureSession(storage, profile, nonce, async context => {
    const { db, workspaceId, current } = context;
    const pending = readMembershipIntent(db, workspaceId), baseline = admittedMembershipBaseline(context);
    if (!pending || pending.intent.operationId !== operationId
      || pending.intent.expectedHead !== (current?.head ?? null)
      || pending.intent.baselineSha256 !== captureSha256(baseline)
      || captureSha256(capturedMembership(context)) !== pending.intent.baselineSha256)
      throw new CoreError("CONFLICT", "Subscription membership outcome is unknown.");
    db.exec("BEGIN IMMEDIATE");
    try {
      storage.assertWorkspaceLease();
      if ((readProtectedRefresh(db, workspaceId)?.head ?? null) !== pending.intent.expectedHead)
        throw new CoreError("CONFLICT", "Subscription membership head changed.");
      finishMembershipIntent(db, workspaceId, operationId, "cancelled", pending.intent.expectedHead,
        pending.intent.baselineSha256, () => storage.assertWorkspaceLease());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }, { operationId, phase: "cancel" });
}

/**
 * The caller is the gated native fixture host, holding the original client's state lock.
 * The real workspace fence and one SQLite transaction protect the complete publication.
 */
export async function publishProtectedRefreshFixture(storage: Storage, profile: string, expectedHead: string | null,
  shareId: string, nonce: string, crashAfterFirstFile = false, replayOnly = false, crashAfterCommit = false,
  failure = false, priority = false, publisherNodeId?: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(shareId)
    || publisherNodeId !== undefined && !/^[a-f0-9]{64}$/.test(publisherNodeId)
    || expectedHead !== null && !/^[a-f0-9]{64}$/.test(expectedHead))
    throw new CoreError("FORBIDDEN", "Private Subscription refresh is not authorized.");
  const root = storage.workspaceRoot();
  return withProtectedFixtureSession(storage, profile, nonce, async ({ db, workspaceId, receipt, current, capture, original }) => {
      if (readMembershipIntent(db, workspaceId))
        throw new CoreError("CONFLICT", "Subscription membership action requires explicit recovery.");
      const statePlan = receipt.plan.statePlan;
      if (!statePlan) return invalid();
      const state = capture.projection as Record<string, any>;
      const files = capture.files.map(file => ({ path: file.path, sha256: file.sha256, size: file.bytes.length }));
      validateProtectedRefreshChange(original, {
        state: (current?.state ?? original) as Record<string, any>,
        directories: current?.directories ?? (statePlan.directories ?? [])
          .filter(dir => dir.startsWith("subscriptions/cache")),
        files: current?.files ?? statePlan.entries
          .filter(entry => entry.destination.startsWith("subscriptions/cache/"))
          .map(entry => ({ path: entry.destination.slice("subscriptions/".length), sha256: entry.sha256, size: entry.size })),
      }, { state, directories: capture.directories, files }, shareId, failure, priority, publisherNodeId ?? original.nodeId);
      if (priority) {
        const target = state.subscriptions.find((record: any) => record.nodeId === (publisherNodeId ?? original.nodeId) && record.shareId === shareId);
        const path = `cache/${target.nodeId}/${target.shareId}/_subscription.json`;
        const nextMetadata = capture.files.find(file => file.path === path);
        const oldMetadata = current?.files.find(file => file.path === path);
        const oldPin = statePlan.entries.find(entry => entry.destination === `subscriptions/${path}`);
        const previousBytes = oldMetadata?.bytes ?? (!current && oldPin ? readFileSync(join(root, "subscriptions", path)) : undefined);
        if (!!previousBytes !== !!nextMetadata) throw new CoreError("CONFLICT", "Subscription priority cache changed.");
        if (previousBytes && nextMetadata) {
          if (!current && (!oldPin || hash(previousBytes) !== oldPin.sha256)) return invalid();
          let previousValue: any, nextValue: any;
          try { previousValue = JSON.parse(previousBytes.toString("utf8")); nextValue = JSON.parse(nextMetadata.bytes.toString("utf8")); }
          catch { throw new CoreError("CONFLICT", "Subscription priority cache changed."); }
          if (!previousValue || typeof previousValue !== "object" || Array.isArray(previousValue)
            || !nextValue || typeof nextValue !== "object" || Array.isArray(nextValue)
            || nextValue.priority !== target.priority)
            throw new CoreError("CONFLICT", "Subscription priority cache changed.");
          delete previousValue.priority; delete nextValue.priority;
          if (json(previousValue) !== json(nextValue)) throw new CoreError("CONFLICT", "Subscription priority cache changed.");
        }
      }
      const body: Body = { schema: "pkm.fixture-subscription-refresh/v1", workspaceId,
        genesis: receipt.outcome.receipt.receiptSha256, parent: current?.head ?? null, state,
        directories: capture.directories, files };
      if (current && json(current.state) === json(state) && json(current.directories) === json(body.directories)
        && json(current.files.map(({ path, sha256, size }) => ({ path, sha256, size }))) === json(files)) return current.head;
      if (replayOnly) throw new CoreError("CONFLICT", "Subscription refresh replay differs from its committed receipt.");
      if ((current?.head ?? null) !== expectedHead) throw new CoreError("CONFLICT", "Subscription refresh head changed.");
      const fingerprint = hash(json(body));
      db.exec("BEGIN IMMEDIATE");
      try {
        storage.assertWorkspaceLease();
        if (readMembershipIntent(db, workspaceId))
          throw new CoreError("CONFLICT", "Subscription membership action requires explicit recovery.");
        const latest = readProtectedRefresh(db, workspaceId);
        if ((latest?.head ?? null) !== expectedHead) throw new CoreError("CONFLICT", "Subscription refresh head changed.");
        db.exec(sql);
        db.prepare("INSERT INTO fixture_subscription_refresh(sequence,workspace_id,fingerprint,parent,body) VALUES(?,?,?,?,?)")
          .run((db.prepare("SELECT COUNT(*) AS n FROM fixture_subscription_refresh").get()?.n as number) + 1,
            workspaceId, fingerprint, body.parent, json(body));
        const insert = db.prepare("INSERT INTO fixture_subscription_refresh_files(fingerprint,path,bytes) VALUES(?,?,?)");
        for (const [index, file] of capture.files.entries()) {
          insert.run(fingerprint, file.path, file.bytes);
          if (crashAfterFirstFile && index === 0) process.exit(80);
        }
        db.prepare("INSERT INTO receipts(operation_id,fingerprint,result,actor_id,operation,committed_at) VALUES(?,?,?,?,?,?)")
          .run(`fixture:subscription-refresh:${fingerprint}`, fingerprint, json({ fingerprint }), actor, anchorOperation, new Date().toISOString());
        db.exec("COMMIT");
        if (crashAfterCommit) process.exit(81);
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return fingerprint;
  });
}

function requireLockFiles(lock: string): string[] {
  const names = readdirSync(lock);
  if (names.length !== 1 || !/^[a-f0-9-]{36}\.json$/.test(names[0]!))
    throw new CoreError("FORBIDDEN", "Subscription refresh host lock is invalid.");
  return names;
}
