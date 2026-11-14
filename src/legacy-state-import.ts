import { createDecipheriv, createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readAgentSnapshots } from "./agent-snapshot-reads.js";
import { readSubscriptions } from "./subscription-reads.js";
import { agentSnapshotReadDefinitions } from "./agent-snapshot-reads-contracts.js";
import { snapshotReadProjection } from "./domain/agent-snapshot-reads-projection.js";
import {
  approveSubscriptionIdentity, inspectSubscriptionIdentity, projectOriginalSubscriptionIdentity,
  storeSubscriptionIdentity, type LegacySubscriptionIdentityImport, type SubscriptionIdentityBinding,
} from "./legacy-subscription-identity.js";
import { inspectLegacyCacheFile, inspectLegacySubscriptionCache } from "./legacy-subscription-cache-import.js";
import { validateLegacySkillMaintenanceArtifact } from "./legacy-skill-maintenance.js";
import { inspectLegacyProtectedSnapshotFixture, readLegacyProtectedSnapshotFixture,
  type LegacyProtectedSnapshotAuthority } from "./legacy-protected-snapshot-fixture.js";
import { assertLinuxLegacyWritersQuiescent } from "./linux-legacy-writer-quiescence.js";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const snapshotName = /^agent_snapshot_[A-Za-z0-9_-]+\.json$/;
const secretKey = /^(?:(?:(?:access|refresh|id|api|bearer)[_-]?)?tokens?|authorization|passwords?|(?:client[_-]?)?secrets?|(?:api|private)[_-]?keys?|credentials?|authVerifier|recovery|verifier)$/i;
const secretValue = /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|(?:pkms:v1:|Bearer\s+[A-Za-z0-9._~+/-]{8,}|[?&](?:access_token|token|key|secret|password)=)/i;
const limit = 2 * 1024 * 1024;
export class LegacyStateImportError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function fail(code: string, message: string): never { throw new LegacyStateImportError(code, message); }
type StateEntry = { source: string; destination: string; sha256: string; size: number; sourceSha256?: string; sourceSize?: number;
  projection?: "protected-subscription" };
export interface LegacyStateImportPlan {
  schema: "pkm.legacy-state-import/v1";
  sourceRoot: string;
  subscriptionRoot?: string;
  keyEpoch?: string;
  subscriptionIdentity?: SubscriptionIdentityBinding;
  protectedSubscriptions?: {
    authorityId: string; epoch: string; gatewaySha256: string | null; emptyDownloads?: true;
    snapshots: Array<{ name: string; sha256: string; status: "authenticated-current" | "unverified" }>;
  };
  entries: StateEntry[];
  directories?: string[];
  planSha256: string;
}
/** Native-only reader for the original publisher SecretStorage secret. */
export interface LegacyProtectedSubscriptionImport {
  /** Explicit private synthetic fixture; never a production profile. */
  fixture: string;
  nonce: string;
  authorityId: string;
  epoch: string;
  authority: LegacyProtectedSnapshotAuthority;
  authorizeState(binding: Readonly<{
    root: string; profile: string; stateSha256: string; ciphertextSha256: string;
    nodeId: string; shareId: string; revision: number; authorityId: string; epoch: string;
  }>): Promise<boolean>;
}
/** Host-only policy; epoch is a non-secret version, never a Magic Code or public input. */
export interface LegacySnapshotKeyAuthority {
  epoch(): Promise<string | undefined>;
  key(algorithm: string, epoch: string): Promise<Uint8Array | undefined>;
}
export const LEGACY_SUBSCRIPTION_SECRET_POLICY = Object.freeze({
  originalPrivateKey: "native-host-only",
  requiredAuthority: "external-native-secret-store",
  artifactContainsSecret: false,
  subscriptionStateImport: "explicit-durable-native-authority",
} as const);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function inspectJson(value: unknown, depth = 0, budget = { count: 0 }): void {
  if (++budget.count > 100_000 || depth > 32) fail("LIMIT", "State JSON exceeds safety bounds.");
  if (typeof value === "string" && secretValue.test(value)) fail("SECRET", "Secret material is not supported.");
  if (Array.isArray(value)) for (const item of value) inspectJson(item, depth + 1, budget);
  else if (object(value)) for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key) || secretKey.test(key)) {
      fail("SECRET", "Sensitive or unsafe state fields require separate authority.");
    }
    inspectJson(item, depth + 1, budget);
  }
}
async function realDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) fail("UNSAFE_PATH", "Source and staging directories must be absolute.");
  const root = resolve(path);
  let current: string = sep;
  for (const component of root.slice(1).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("UNSAFE_PATH", "Directory path contains a link or non-directory.");
  }
  if (await realpath(root) !== root) fail("UNSAFE_PATH", "Directory path is not canonical.");
  return root;
}
async function checkedBytes(path: string, maxBytes = limit): Promise<Buffer> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maxBytes)) {
    fail("UNSAFE_SOURCE", "State input must be a bounded, unlinked regular file.");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat({ bigint: true });
    const same = (s: typeof before) => s.dev === before.dev && s.ino === before.ino && s.size === before.size
      && s.mtimeNs === before.mtimeNs && s.ctimeNs === before.ctimeNs && s.nlink === 1n;
    if (!same(opened)) fail("SOURCE_CHANGED", "State input changed while opening.");
    const bytes = await file.readFile();
    if (bytes.length !== Number(before.size) || !same(await file.stat({ bigint: true }))
      || !same(await lstat(path, { bigint: true }))) fail("SOURCE_CHANGED", "State input changed while reading.");
    return bytes;
  } finally { await file.close(); }
}
function parse(bytes: Buffer, originalIdentity = false): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return fail("INVALID_STATE", "State input is not UTF-8 JSON."); }
  if (!object(value)) fail("INVALID_STATE", "State input must be an object.");
  if (originalIdentity && "privateKey" in value) {
    const { privateKey, ...publicState } = value;
    inspectJson(publicState);
    void privateKey;
  } else inspectJson(value);
  return value;
}
function parseCacheMetadata(bytes: Buffer): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return fail("INVALID_STATE", "Cache metadata is not UTF-8 JSON."); }
  if (!object(value)) fail("INVALID_STATE", "Cache metadata must be an object.");
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string" && secretValue.test(item)) fail("SECRET", "Cache metadata contains secret material.");
    if (Array.isArray(item)) for (const child of item) pending.push(child);
    else if (object(item)) for (const [key, child] of Object.entries(item)) {
      if (["__proto__", "prototype", "constructor"].includes(key) || secretKey.test(key)) fail("SECRET", "Cache metadata contains unsafe fields.");
      pending.push(child);
    }
  }
  return value;
}
async function checkSnapshot(value: Record<string, unknown>, name: string, authority?: LegacySnapshotKeyAuthority, epoch?: string): Promise<void> {
  if (value.schema !== "pkm.agent.snapshot/v1" || value.snapshotId !== name.slice(0, -5)
    || typeof value.magicCode !== "string" || !/^PKM-SNAP-[A-Z0-9-]+$/.test(value.magicCode)
    || !object(value.payload)) fail("INVALID_STATE", "Snapshot schema or identity is invalid.");
  const payload = "algorithm" in value.payload
    ? await decryptSnapshot(value, authority, epoch)
    : value.payload;
  if (!object(payload.session) || !Array.isArray(payload.recipeRuns)) {
    fail("INVALID_STATE", "Snapshot is not a canonical original Session capture.");
  }
  if (object(payload.session.nativeChat) && "messageHistory" in payload.session.nativeChat) {
    fail("UNKNOWN_STATE", "Packed conversation history requires a separate adapter.");
  }
  inspectJson(payload);
  if (object(value.capture)) {
    const checkpoints = payload.session.checkpoints ?? [];
    const todos = payload.session.todos ?? [];
    if (!Array.isArray(checkpoints) || !Array.isArray(todos)
      || value.capture.todoCount !== todos.length || value.capture.recipeRunCount !== payload.recipeRuns.length) {
      fail("INVALID_STATE", "Original capture counts do not match authenticated payload.");
    }
    const latest = checkpoints.at(-1);
    if (latest !== undefined) {
      if (!object(latest) || !object(value.capture.checkpoint)
        || value.capture.checkpoint.checkpointId !== String(latest.checkpointId || "")
        || value.capture.checkpoint.sequence !== Number(latest.sequence || checkpoints.length)
        || value.capture.checkpoint.createdAt !== String(latest.createdAt || "")
        || value.capture.checkpoint.reason !== String(latest.reason || "")) {
        fail("INVALID_STATE", "Original capture checkpoint does not match authenticated history.");
      }
    } else if (value.capture.checkpoint !== undefined && value.capture.checkpoint !== null) {
      fail("INVALID_STATE", "Original capture checkpoint does not match authenticated history.");
    }
  }
  try {
    const result = snapshotReadProjection(value, payload, 12);
    const schema = agentSnapshotReadDefinitions.find(item => item.id === "agent.snapshot.read")!.output;
    if (!schema.safeParse({ ...result, snapshotRevision: "0".repeat(64), adapters: {
      encryptedPayload: "unavailable", networkRecovery: "unavailable", vscode: "unavailable", restore: "unavailable",
    } }).success) fail("INVALID_STATE", "Snapshot read projection is invalid.");
  } catch (error) {
    if (error instanceof LegacyStateImportError) throw error;
    fail("INVALID_STATE", "Snapshot read projection is invalid.");
  }
}
const algorithms = new Set(["A256GCM-PKM-LOCAL-OBFUSCATION/v1", "A256GCM-PKM-INTERNAL/v1"]);
async function assertEpoch(authority: LegacySnapshotKeyAuthority | undefined, epoch: string | undefined): Promise<void> {
  if (!authority || !epoch) fail("KEY_AUTHORITY_REQUIRED", "Snapshot key authority is unavailable or stale.");
  let actual: string | undefined;
  try { actual = await authority.epoch(); }
  catch { fail("KEY_AUTHORITY_REQUIRED", "Snapshot key authority is unavailable or stale."); }
  if (actual !== epoch) fail("KEY_AUTHORITY_REQUIRED", "Snapshot key authority is unavailable or stale.");
}
async function decryptSnapshot(snapshot: Record<string, unknown>, authority?: LegacySnapshotKeyAuthority, epoch?: string): Promise<Record<string, unknown>> {
  let payload: unknown = snapshot.payload;
  for (let depth = 0; object(payload) && "algorithm" in payload; depth++) {
    if (depth >= 4 || typeof payload.algorithm !== "string" || !algorithms.has(payload.algorithm)) {
      fail("UNKNOWN_STATE", "Snapshot encryption envelope is unsupported.");
    }
    if (Object.keys(payload).some(key => !["algorithm", "iv", "tag", "ciphertext"].includes(key))) {
      fail("UNKNOWN_STATE", "Snapshot encryption envelope contains unsupported fields.");
    }
    await assertEpoch(authority, epoch);
    let supplied: Uint8Array | undefined;
    try { supplied = await authority!.key(payload.algorithm, epoch!); }
    catch { fail("KEY_AUTHORITY_REQUIRED", "Snapshot key authority did not grant a key."); }
    if (!(supplied instanceof Uint8Array) || supplied.byteLength !== 32) fail("KEY_AUTHORITY_REQUIRED", "Snapshot key authority did not grant a key.");
    const key = Buffer.from(supplied);
    try {
      const { iv, tag, ciphertext } = payload;
      if (typeof iv !== "string" || typeof tag !== "string" || typeof ciphertext !== "string"
        || !/^[A-Za-z0-9_-]+$/.test(iv) || !/^[A-Za-z0-9_-]+$/.test(tag) || !/^[A-Za-z0-9_-]+$/.test(ciphertext)) {
        fail("INVALID_STATE", "Snapshot encryption envelope is malformed.");
      }
      const ivBytes = Buffer.from(iv, "base64url"), tagBytes = Buffer.from(tag, "base64url");
      if (ivBytes.length !== 12 || tagBytes.length !== 16) fail("INVALID_STATE", "Snapshot encryption envelope is malformed.");
      const decipher = createDecipheriv("aes-256-gcm", key, ivBytes);
      decipher.setAAD(Buffer.from(`pkm.agent.snapshot/v1:${snapshot.snapshotId}:${snapshot.magicCode}`, "utf8"));
      decipher.setAuthTag(tagBytes);
      const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]);
      try { payload = parse(plaintext); } finally { plaintext.fill(0); }
    } catch (error) {
      if (error instanceof LegacyStateImportError) throw error;
      fail("INVALID_STATE", "Snapshot authentication or decoding failed.");
    } finally { key.fill(0); }
    await assertEpoch(authority, epoch);
  }
  if (!object(payload)) fail("INVALID_STATE", "Snapshot payload is invalid.");
  return payload;
}
async function optionalDirectory(root: string, parts: string[]): Promise<string | undefined> {
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("UNSAFE_PATH", "State directory must be real.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  return path;
}
function digest(plan: Omit<LegacyStateImportPlan, "planSha256">): string { return hash(JSON.stringify(plan)); }

export async function inspectImportedSubscriptionCache(subscriptionRoot: string) {
  const state = parse(await checkedBytes(join(subscriptionRoot, "subscriptions.json")));
  return inspectLegacySubscriptionCache(subscriptionRoot, state, { read: path => checkedBytes(path, Number.MAX_SAFE_INTEGER), json: parseCacheMetadata, fail });
}

function protectedSubscriptionState(bytes: Buffer, allowEmptyShares = false, updatingTarget?: string): { state: Record<string, unknown>; projection: Record<string, unknown> } {
  let state: unknown;
  try { state = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return fail("INVALID_STATE", "Original Subscription state is invalid."); }
  if (!object(state) || state.schema !== 1 || state.enabled !== false || state.gatewayPid !== undefined
    || !Array.isArray(state.shares) || !allowEmptyShares && state.shares.length === 0 || !Array.isArray(state.subscriptions)
    || typeof state.privateKey !== "string" || typeof state.publicKey !== "string" || typeof state.nodeId !== "string")
    fail("INVALID_STATE", "Original Subscription identity is unavailable.");
  try {
    if (createPrivateKey(state.privateKey).asymmetricKeyType !== "ed25519"
      || createPublicKey(state.publicKey).asymmetricKeyType !== "ed25519"
      || createPublicKey(state.privateKey).export({ type: "spki", format: "pem" }).toString() !== state.publicKey
      || hash(state.publicKey) !== state.nodeId) throw new Error();
  } catch { fail("INVALID_STATE", "Original Subscription identity does not match."); }
  const shares = state.shares.map(share => {
    if (!object(share) || share.protection !== "secret-protected"
      || typeof share.shareId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(share.shareId)
      || !Number.isSafeInteger(share.revision) || (share.revision as number) < 1
      || typeof share.secretSalt !== "string" || typeof share.authVerifier !== "string"
      || typeof share.contentHash !== "string" || typeof share.snapshotPath !== "string"
      || !object(share.summary) || typeof share.name !== "string" || share.summary.name !== share.name)
      fail("INVALID_STATE", "Original protected Subscription share is invalid.");
    const { authVerifier, snapshotPath, ...publicShare } = share;
    void authVerifier; void snapshotPath;
    return publicShare;
  });
  if (new Set(shares.map(share => share.shareId)).size !== shares.length) fail("INVALID_STATE", "Duplicate Subscription share.");
  for (const record of state.subscriptions) {
    if (!object(record) || !["new", "current", "offline", "error"].includes(String(record.status))
      && !(updatingTarget && record.id === updatingTarget && record.status === "updating"))
      fail("UNKNOWN_STATE", "Subscription status is pending or unsupported.");
  }
  const projection = { schema: state.schema, nodeId: state.nodeId, publicKey: state.publicKey,
    shares, subscriptions: state.subscriptions };
  const { privateKey, ...publicState } = state;
  void privateKey;
  inspectJson({ ...publicState, shares });
  inspectJson(projection);
  return { state, projection };
}

/** Capture one stable, sanitized old-client cache while the trusted host holds its state lock. */
export async function captureProtectedSubscriptionRefresh(subscriptionRoot: string,
  options: { allowEmptyShares?: boolean; allowAbsentEmptyCache?: boolean; updatingTarget?: string;
    emptyStagingFor?: { nodeId: string; shareId: string } } = {}) {
  const root = await realDirectory(subscriptionRoot);
  const source = await checkedBytes(join(root, "subscriptions.json"));
  try {
    const stateSha256 = hash(source);
    const { projection } = protectedSubscriptionState(source, options.allowEmptyShares === true, options.updatingTarget);
    const inspectCache = async () => {
      try {
        return await inspectLegacySubscriptionCache(root, projection, {
          read: path => checkedBytes(path, Number.MAX_SAFE_INTEGER), json: parseCacheMetadata, fail,
          emptyStagingFor: options.emptyStagingFor,
        });
      } catch (error) {
        if (!options.allowAbsentEmptyCache || !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        try { await lstat(join(root, "cache")); } catch (missing) {
          if (missing instanceof Error && "code" in missing && missing.code === "ENOENT")
            return { files: [], directories: [], emptyStaging: [] };
          throw missing;
        }
        throw error;
      }
    };
    const cache = await inspectCache();
    const files: Array<{ path: string; sha256: string; bytes: Buffer }> = [];
    for (const entry of cache.files) {
      const bytes = await checkedBytes(entry.source, Number.MAX_SAFE_INTEGER);
      if (bytes.length !== entry.size || hash(bytes) !== entry.sha256)
        fail("SOURCE_CHANGED", "Subscription cache changed during refresh capture.");
      files.push({ path: entry.relative, sha256: entry.sha256, bytes });
    }
    const after = await checkedBytes(join(root, "subscriptions.json"));
    try {
      if (hash(after) !== stateSha256) fail("SOURCE_CHANGED", "Subscription state changed during refresh capture.");
    } finally { after.fill(0); }
    const verified = await inspectCache();
    if (JSON.stringify(cache.directories) !== JSON.stringify(verified.directories)
      || JSON.stringify(cache.emptyStaging) !== JSON.stringify(verified.emptyStaging)
      || JSON.stringify(cache.files.map(({ relative, sha256, size }) => ({ relative, sha256, size })))
        !== JSON.stringify(verified.files.map(({ relative, sha256, size }) => ({ relative, sha256, size }))))
      fail("SOURCE_CHANGED", "Subscription cache changed during refresh capture.");
    return { projection, directories: cache.directories, files, emptyStaging: cache.emptyStaging };
  } finally { source.fill(0); }
}

function protectedAuthority(policy: LegacyProtectedSubscriptionImport, binding: Parameters<LegacyProtectedSubscriptionImport["authorizeState"]>[0]): LegacyProtectedSnapshotAuthority {
  const pinned = Object.freeze({ ...binding });
  const { fixture, nonce, authorityId, epoch, authority, authorizeState } = policy;
  const authorize = authority.authorize, secret = authority.secret;
  const unchanged = () => policy.fixture === fixture && policy.nonce === nonce && policy.authorityId === authorityId
    && policy.epoch === epoch && policy.authority === authority && policy.authorizeState === authorizeState
    && authority.authorize === authorize && authority.secret === secret;
  return {
    async authorize(snapshot, signal) {
      try { return unchanged() && await authorizeState.call(policy, pinned) && unchanged()
        && await authorize.call(authority, snapshot, signal) && unchanged(); }
      catch { return false; }
    },
    async secret(snapshot, signal) {
      if (!unchanged()) return undefined;
      const value = await secret.call(authority, snapshot, signal);
      if (unchanged()) return value;
      value?.fill(0);
      return undefined;
    },
  };
}

async function planProtectedSubscriptions(sourceRoot: string, subscriptionRoot: string,
  policy: LegacyProtectedSubscriptionImport): Promise<{
    entries: StateEntry[]; protectedSubscriptions: NonNullable<LegacyStateImportPlan["protectedSubscriptions"]>;
  }> {
  if (!policy || typeof policy.fixture !== "string" || resolve(policy.fixture) !== policy.fixture
    || process.platform !== "linux" || process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT !== policy.fixture
    || !/^pkm-protected-state-fixture-[a-f0-9-]{36}$/.test(policy.fixture.split(sep).at(-1)!)
    || sourceRoot !== join(policy.fixture, "original") || subscriptionRoot !== join(policy.fixture, "profile")
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(policy.nonce)
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(policy.authorityId)
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(policy.epoch) || !policy.authority || typeof policy.authorizeState !== "function")
    fail("KEY_AUTHORITY_REQUIRED", "Original Subscription secret authority is unavailable.");
  const initialPolicy = { fixture: policy.fixture, nonce: policy.nonce, authorityId: policy.authorityId,
    epoch: policy.epoch, authority: policy.authority, authorizeState: policy.authorizeState,
    authorize: policy.authority.authorize, secret: policy.authority.secret };
  const unchangedPolicy = () => policy.fixture === initialPolicy.fixture && policy.nonce === initialPolicy.nonce
    && policy.authorityId === initialPolicy.authorityId && policy.epoch === initialPolicy.epoch
    && policy.authority === initialPolicy.authority && policy.authorizeState === initialPolicy.authorizeState
    && policy.authority.authorize === initialPolicy.authorize && policy.authority.secret === initialPolicy.secret;
  for (const dir of [policy.fixture, sourceRoot, subscriptionRoot]) {
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(dir) !== dir
      || stat.uid !== process.getuid?.() || (stat.mode & 0o7077) !== 0)
      fail("UNSAFE_PATH", "Protected Subscription fixture directory is unsafe.");
  }
  const markerBytes = await checkedBytes(join(policy.fixture, "subscription-state-fixture.json"), 4096);
  const marker = parse(markerBytes);
  const rootStat = await lstat(sourceRoot, { bigint: true }), profileStat = await lstat(subscriptionRoot, { bigint: true });
  if (JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify(["nonce", "profilePin", "rootPin", "schema"])
    || marker.schema !== "pkm.protected-subscription-state-fixture/v1" || marker.nonce !== policy.nonce
    || marker.rootPin !== `${rootStat.dev}:${rootStat.ino}` || marker.profilePin !== `${profileStat.dev}:${profileStat.ino}`)
    fail("UNSAFE_PATH", "Protected Subscription fixture binding changed.");
  await assertLinuxLegacyWritersQuiescent(sourceRoot);
  await assertLinuxLegacyWritersQuiescent(subscriptionRoot);
  const names = (await readdir(subscriptionRoot)).sort();
  if (names.some(name => !["subscriptions.json", "subscriber-stats.json", "cache", "snapshots", "gateway-state.json", "downloads"].includes(name))
    || !names.includes("subscriptions.json") || !names.includes("snapshots"))
    fail("UNKNOWN_STATE", "Original Subscription inventory contains unsupported state.");
  if (names.includes("downloads")) {
    const downloads = await optionalDirectory(subscriptionRoot, ["downloads"]);
    if (!downloads) fail("UNSAFE_PATH", "Original downloads directory is unsafe.");
    const before = await lstat(downloads, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) fail("UNSAFE_PATH", "Original downloads directory is unsafe.");
    if ((await readdir(downloads)).length) fail("UNKNOWN_STATE", "Pending Subscription downloads require recovery.");
    const after = await lstat(downloads, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs)
      fail("SOURCE_CHANGED", "Original downloads directory changed.");
  }
  const statePath = join(subscriptionRoot, "subscriptions.json"), bytes = await checkedBytes(statePath);
  try {
    const sourceSha256 = hash(bytes), { state, projection } = protectedSubscriptionState(bytes);
    const publicBytes = Buffer.from(JSON.stringify(projection));
    const entries: StateEntry[] = [{ source: statePath, destination: "subscriptions/subscriptions.json",
      sha256: hash(publicBytes), size: publicBytes.length, sourceSha256, sourceSize: bytes.length,
      projection: "protected-subscription" }];
    const snapshotDir = await optionalDirectory(subscriptionRoot, ["snapshots"]);
    if (!snapshotDir) fail("INVALID_STATE", "Original Subscription snapshots are missing.");
    const snapshotNames = (await readdir(snapshotDir)).sort();
    if (snapshotNames.length > 512) fail("LIMIT", "Subscription snapshot inventory exceeds safety bounds.");
    const remaining = new Set(snapshotNames);
    const snapshots: NonNullable<LegacyStateImportPlan["protectedSubscriptions"]>["snapshots"] = [];
    let total = 0;
    for (const raw of state.shares as Record<string, unknown>[]) {
      const shareId = raw.shareId as string, revision = raw.revision as number;
      const current = `${shareId}-${revision}.json`;
      if (raw.snapshotPath !== join(snapshotDir, current) || !remaining.has(current))
        fail("INVALID_STATE", "Original current Subscription snapshot path does not match.");
      const currentBytes = await checkedBytes(join(snapshotDir, current), 16 * 1024 * 1024);
      if (!unchangedPolicy()) fail("KEY_AUTHORITY_REQUIRED", "Original Subscription secret authority changed.");
      const currentAuthority = protectedAuthority(policy, { root: sourceRoot, profile: subscriptionRoot,
        stateSha256: sourceSha256, ciphertextSha256: hash(currentBytes), nodeId: state.nodeId as string,
        shareId, revision, authorityId: policy.authorityId, epoch: policy.epoch });
      await inspectLegacyProtectedSnapshotFixture({
        root: sourceRoot, profile: subscriptionRoot, nodeId: state.nodeId as string, shareId, revision,
        publicKey: state.publicKey as string, secretSalt: raw.secretSalt as string,
        authVerifier: raw.authVerifier as string, plaintextHash: raw.contentHash as string,
        summary: raw.summary as Record<string, unknown>,
      }, currentBytes, currentAuthority);
      for (const name of snapshotNames) {
        const match = /^([A-Za-z0-9_-]+)-(\d+)\.json$/.exec(name);
        if (!match || match[1] !== shareId) continue;
        if (!Number.isSafeInteger(Number(match[2])) || String(Number(match[2])) !== match[2] || Number(match[2]) < 1
          || Number(match[2]) > revision || !remaining.delete(name))
          fail("INVALID_STATE", "Original historical Subscription snapshot name is unsupported.");
        const content = name === current ? currentBytes : await checkedBytes(join(snapshotDir, name), 16 * 1024 * 1024);
        total += content.length;
        if (total > 32 * 1024 * 1024) fail("LIMIT", "Subscription snapshots exceed safety bounds.");
        const sha256 = hash(content);
        snapshots.push({ name, sha256, status: name === current ? "authenticated-current" : "unverified" });
        entries.push({ source: join(snapshotDir, name), destination: `subscriptions/snapshots/${name}`, sha256, size: content.length });
      }
    }
    if (remaining.size) fail("UNKNOWN_STATE", "Original Subscription snapshot has no share.");
    let gatewaySha256: string | null = null;
    if (names.includes("gateway-state.json")) {
      const gateway = await checkedBytes(join(subscriptionRoot, "gateway-state.json"));
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(gateway)); }
      catch { fail("INVALID_STATE", "Original gateway state is invalid."); }
      if (!object(value) || value.schema !== 1 || value.nodeId !== state.nodeId || value.ownerNodeId !== state.nodeId
        || value.publicKey !== state.publicKey
        || !Array.isArray(value.shares) || value.shares.length !== (state.shares as unknown[]).length)
        fail("INVALID_STATE", "Original gateway state does not match the publisher.");
      for (const share of state.shares as Record<string, unknown>[]) {
        const matching = value.shares.filter(item => object(item) && object(item.summary) && item.summary.shareId === share.shareId);
        if (matching.length !== 1 || !object(matching[0]) || matching[0].snapshotPath !== share.snapshotPath
          || matching[0].authVerifier !== share.authVerifier || JSON.stringify(matching[0].summary) !== JSON.stringify(share.summary))
          fail("INVALID_STATE", "Original gateway share does not match the publisher.");
      }
      gatewaySha256 = hash(gateway);
    }
    snapshots.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (!unchangedPolicy()) fail("KEY_AUTHORITY_REQUIRED", "Original Subscription secret authority changed.");
    return { entries, protectedSubscriptions: { authorityId: initialPolicy.authorityId, epoch: initialPolicy.epoch, gatewaySha256,
      ...(names.includes("downloads") ? { emptyDownloads: true as const } : {}), snapshots } };
  } finally { bytes.fill(0); }
}

/** Source is a quiescent disposable original copy, never a live Knowledge Root. */
export async function planLegacyStateImport(source: string, subscriptionSource?: string, authority?: LegacySnapshotKeyAuthority,
  identityPolicy?: LegacySubscriptionIdentityImport, protectedPolicy?: LegacyProtectedSubscriptionImport): Promise<LegacyStateImportPlan> {
  const sourceRoot = await realDirectory(source);
  const subscriptionRoot = subscriptionSource === undefined ? undefined : await realDirectory(subscriptionSource);
  if (protectedPolicy && !subscriptionRoot) fail("KEY_AUTHORITY_REQUIRED", "Original Subscription profile is required.");
  const entries: StateEntry[] = [];
  let directories: string[] | undefined;
  for (const [rootName, allowed] of [
    ["_feedback", new Set(["skill-usage.jsonl"])],
    ["_proposals", new Set(["skills"])],
  ] as const) {
    const root = await optionalDirectory(sourceRoot, [rootName]);
    if (!root) continue;
    directories ??= [];
    directories.push(rootName);
    for (const name of (await readdir(root)).sort()) {
      if (rootName === "_feedback" && !allowed.has(name) || rootName === "_proposals" && name !== "skills") {
        fail("UNKNOWN_STATE", "Unknown original Skill maintenance artifact state.");
      }
      const parent = rootName === "_proposals" ? await optionalDirectory(root, ["skills"]) : root;
      if (!parent) fail("INVALID_STATE", "Original Skill proposal area must be a real directory.");
      if (rootName === "_proposals") directories.push("_proposals/skills");
      for (const artifact of rootName === "_proposals" ? (await readdir(parent)).sort() : [name]) {
        const path = join(parent, artifact);
        const destination = `${rootName}/${rootName === "_proposals" ? "skills/" : ""}${artifact}`;
        const bytes = await checkedBytes(path, Number.MAX_SAFE_INTEGER);
        validateLegacySkillMaintenanceArtifact(destination, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        entries.push({ source: path, destination, sha256: hash(bytes), size: bytes.length });
      }
    }
  }
  const magicCodes = new Set<string>();
  let epoch: string | undefined;
  try { epoch = authority ? await authority.epoch() : undefined; }
  catch { fail("KEY_AUTHORITY_REQUIRED", "Snapshot key authority is unavailable."); }
  if (epoch !== undefined && (typeof epoch !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(epoch))) {
    fail("KEY_AUTHORITY_REQUIRED", "Snapshot key authority epoch is invalid.");
  }
  let usesKey = false;
  let subscriptionIdentity: SubscriptionIdentityBinding | undefined;
  let protectedSubscriptions: LegacyStateImportPlan["protectedSubscriptions"];
  let bytesTotal = 0;
  const add = async (path: string, target: string, snapshot: boolean): Promise<void> => {
    const bytes = await checkedBytes(path);
    const value = parse(bytes, !!identityPolicy && target === "subscriptions/subscriptions.json");
    if (snapshot) {
      if (object(value.payload) && "algorithm" in value.payload) usesKey = true;
      await checkSnapshot(value, path.split(sep).at(-1)!, authority, epoch);
      if (magicCodes.has(value.magicCode as string)) fail("INVALID_STATE", "Duplicate Snapshot Magic Code.");
      magicCodes.add(value.magicCode as string);
    } else {
      if (value.schema !== 1) fail("INVALID_STATE", "Subscription schema is unsupported.");
      if (target.endsWith("/subscriptions.json")) {
        if (!Array.isArray(value.subscriptions) || !Array.isArray(value.shares)) {
          fail("INVALID_STATE", "Subscription state requires shares and subscriptions arrays.");
        }
        for (const record of value.subscriptions) {
          if (!object(record) || !["new", "current", "offline", "error"].includes(String(record.status))) {
            fail("UNKNOWN_STATE", "Subscription status is pending or unsupported.");
          }
        }
      }
    }
    bytesTotal += bytes.length;
    if (bytesTotal > 32 * 1024 * 1024 || entries.filter(entry => !entry.destination.startsWith("_")).length >= 512) fail("LIMIT", "State inventory exceeds safety bounds.");
    if (!snapshot && target === "subscriptions/subscriptions.json" && "privateKey" in value && identityPolicy) {
      if (entries.filter(entry => !entry.destination.startsWith("_")).length > 510) fail("LIMIT", "State inventory exceeds safety bounds.");
      const projected = projectOriginalSubscriptionIdentity(value, sourceRoot, subscriptionRoot!, hash(bytes), identityPolicy,
        entries.find(entry => entry.destination === "subscriptions/subscriber-stats.json")?.sha256 ?? null);
      subscriptionIdentity = projected.binding;
      await approveSubscriptionIdentity(subscriptionIdentity, identityPolicy.authority);
      const publicBytes = Buffer.from(JSON.stringify(projected.projection));
      inspectJson(projected.projection);
      const sidecar = Buffer.from(JSON.stringify(subscriptionIdentity));
      for (const [destination, output] of [[target, publicBytes], ["subscriptions/native-identity.json", sidecar]] as const) {
        entries.push({ source: path, destination, sha256: hash(output), size: output.length,
          sourceSha256: hash(bytes), sourceSize: bytes.length });
      }
    } else entries.push({ source: path, destination: target, sha256: hash(bytes), size: bytes.length });
  };
  const snapshots = await optionalDirectory(sourceRoot, [".pkm", "state", "agent-snapshots"]);
  if (snapshots) {
    for (const name of (await readdir(snapshots)).sort()) {
      if (!snapshotName.test(name) || name.length > 165) fail("UNKNOWN_STATE", "Snapshot inventory contains an unsupported entry.");
      await add(join(snapshots, name), `agent-snapshot-reads/.pkm/state/agent-snapshots/${name}`, true);
    }
    const sessions = await optionalDirectory(sourceRoot, [".pkm", "state", "agent-sessions"]);
    if (sessions && (await readdir(sessions)).length) {
      fail("UNKNOWN_STATE", "Recovery Session history requires separate complete migration; Snapshot recovery counts cannot be omitted.");
    }
  }
  if (subscriptionRoot) {
    if (protectedPolicy) {
      if (identityPolicy) fail("INVALID_STATE", "Protected Subscription association cannot export the original private identity.");
      const protectedPlan = await planProtectedSubscriptions(sourceRoot, subscriptionRoot, protectedPolicy);
      entries.push(...protectedPlan.entries);
      bytesTotal += protectedPlan.entries.reduce((sum, entry) => sum + entry.size, 0);
      if (bytesTotal > 32 * 1024 * 1024 || entries.filter(entry => !entry.destination.startsWith("_")).length > 512)
        fail("LIMIT", "State inventory exceeds safety bounds.");
      protectedSubscriptions = protectedPlan.protectedSubscriptions;
      directories = [...(directories ?? []), "subscriptions/snapshots"];
    }
    for (const name of (await readdir(subscriptionRoot)).sort()) {
      if (name === "cache") continue;
      if (protectedPolicy && ["subscriptions.json", "snapshots", "gateway-state.json", "downloads"].includes(name)) continue;
      if (!["subscriptions.json", "subscriber-stats.json"].includes(name)) {
        fail("UNKNOWN_STATE", "Subscription inventory contains unsupported cache, snapshot, or pending state.");
      }
      await add(join(subscriptionRoot, name), `subscriptions/${name}`, false);
    }
    if (entries.some(item => item.destination === "subscriptions/subscriber-stats.json")
      && !entries.some(item => item.destination === "subscriptions/subscriptions.json")) {
      fail("INVALID_STATE", "Subscription statistics require original state.");
    }
    if ((await readdir(subscriptionRoot)).includes("cache")) {
      const stateEntry = entries.find(entry => entry.destination === "subscriptions/subscriptions.json");
      if (!stateEntry) fail("INVALID_STATE", "Subscription cache requires exact native subscriber state.");
      const stateBytes = await checkedBytes(stateEntry.source);
      let state: Record<string, unknown>;
      try {
        if (hash(stateBytes) !== (stateEntry.sourceSha256 ?? stateEntry.sha256)) fail("SOURCE_CHANGED", "Subscription membership changed before cache admission.");
        state = protectedPolicy ? protectedSubscriptionState(stateBytes).projection : parse(stateBytes, !!identityPolicy);
      } finally { stateBytes.fill(0); }
      const cache = await inspectLegacySubscriptionCache(subscriptionRoot, state, { read: path => checkedBytes(path, Number.MAX_SAFE_INTEGER), json: parseCacheMetadata, fail });
      directories = [...(directories ?? []), ...cache.directories];
      for (const file of cache.files) {
        entries.push({ source: file.source, destination: `subscriptions/${file.relative}`,
          sha256: file.sha256, size: file.size });
      }
    }
  }
  const original = { schema: "pkm.legacy-state-import/v1" as const, sourceRoot,
    ...(subscriptionRoot === undefined ? {} : { subscriptionRoot }), ...(usesKey ? { keyEpoch: epoch! } : {}),
    ...(subscriptionIdentity ? { subscriptionIdentity } : {}), ...(protectedSubscriptions ? { protectedSubscriptions } : {}),
    entries, ...(directories ? { directories } : {}) };
  if (usesKey) await assertEpoch(authority, epoch);
  return { ...original, planSha256: digest(original) };
}

/**
 * Writes only into the unpublished workspace owned by the outer legacy importer.
 * The outer importer must discard that entire stage on any error and must replan
 * immediately before its existing atomic no-replace publication.
 */
export async function stageLegacyStateImport(plan: LegacyStateImportPlan, stagingRoot: string, authority?: LegacySnapshotKeyAuthority,
  identityPolicy?: LegacySubscriptionIdentityImport, protectedPolicy?: LegacyProtectedSubscriptionImport): Promise<void> {
  const { planSha256, ...input } = plan;
  if (digest(input) !== planSha256) fail("PLAN_CHANGED", "State plan was modified.");
  if (plan.keyEpoch) await assertEpoch(authority, plan.keyEpoch);
  const current = await planLegacyStateImport(plan.sourceRoot, plan.subscriptionRoot, authority, identityPolicy, protectedPolicy);
  if (current.planSha256 !== planSha256) fail("SOURCE_CHANGED", "State inventory changed before staging.");
  const stage = await realDirectory(stagingRoot);
  if (protectedPolicy) {
    const rel = relative(protectedPolicy.fixture, stage);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      fail("UNSAFE_PATH", "Protected Subscription staging must remain inside its isolated fixture.");
  }
  for (const root of [plan.sourceRoot, ...(plan.subscriptionRoot ? [plan.subscriptionRoot] : [])]) {
    const rel = relative(root, stage);
    const reverse = relative(stage, root);
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
      || (!reverse.startsWith(`..${sep}`) && reverse !== ".." && !isAbsolute(reverse))) {
      fail("UNSAFE_PATH", "Staging and source directories must be disjoint.");
    }
  }
  if (protectedPolicy && plan.subscriptionRoot) {
    await assertLinuxLegacyWritersQuiescent(plan.sourceRoot);
    await assertLinuxLegacyWritersQuiescent(plan.subscriptionRoot);
  }
  const written: string[] = [];
  try {
    for (const directory of current.directories ?? []) {
      let path = stage;
      for (const part of directory.split("/")) {
        path = join(path, part);
        try { await mkdir(path, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail("UNSAFE_PATH", "State stage directory changed.");
      }
    }
    const prepared: Array<{ path: string; bytes: Buffer }> = [];
    for (const entry of current.entries) {
      if (entry.destination.startsWith("subscriptions/cache/") || entry.destination.startsWith("subscriptions/snapshots/")
        || entry.destination.startsWith("_feedback/") || entry.destination.startsWith("_proposals/")) {
        const path = join(stage, ...entry.destination.split("/"));
        const file = await open(path, "wx", 0o600);
        written.push(path);
        try {
          const pin = await inspectLegacyCacheFile(entry.source, file);
          if (pin.sha256 !== entry.sha256 || pin.size !== entry.size) fail("SOURCE_CHANGED", "Cache source changed during staged copy.");
          await file.sync();
        } finally { await file.close(); }
        continue;
      }
      let bytes = await checkedBytes(entry.source);
      if (hash(bytes) !== (entry.sourceSha256 ?? entry.sha256) || bytes.length !== (entry.sourceSize ?? entry.size)) {
        bytes.fill(0);
        fail("SOURCE_CHANGED", "State bytes changed during staging.");
      }
      if (entry.sourceSha256) {
        const sourceBytes = bytes;
        try {
          if (entry.projection === "protected-subscription") {
            if (!protectedPolicy || !plan.protectedSubscriptions) fail("ACCESS_DENIED", "Original Subscription secret authority is required.");
            const projection = protectedSubscriptionState(sourceBytes).projection;
            bytes = Buffer.from(JSON.stringify(projection));
            if (hash(bytes) !== entry.sha256 || bytes.length !== entry.size) fail("PLAN_CHANGED", "Subscription projection differs from its approval.");
          } else {
            if (!identityPolicy || !plan.subscriptionIdentity) fail("ACCESS_DENIED", "Native subscription identity authority is required.");
            const original = parse(sourceBytes, true);
            const projected = projectOriginalSubscriptionIdentity(original, plan.sourceRoot, plan.subscriptionRoot!, hash(sourceBytes), identityPolicy,
              current.entries.find(item => item.destination === "subscriptions/subscriber-stats.json")?.sha256 ?? null);
            if (entry.destination === "subscriptions/subscriptions.json") {
              await storeSubscriptionIdentity(projected.binding, projected.privateKey, identityPolicy.authority);
            }
            bytes = Buffer.from(JSON.stringify(entry.destination.endsWith("native-identity.json") ? projected.binding : projected.projection));
            if (hash(bytes) !== entry.sha256 || bytes.length !== entry.size) fail("PLAN_CHANGED", "Subscription identity projection differs from its exact approval.");
          }
        } finally {
          sourceBytes.fill(0);
        }
      }
      const path = join(stage, ...entry.destination.split("/"));
      prepared.push({ path, bytes });
    }
    for (const { path, bytes } of prepared) {
      let directory = stage;
      for (const component of relative(stage, dirname(path)).split(sep)) {
        directory = join(directory, component);
        try { await mkdir(directory, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail("UNSAFE_PATH", "Staging path contains a link or non-directory.");
      }
      const file = await open(path, "wx", 0o600);
      written.push(path);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    }
    await verifyLegacyStateImport(plan, stage, authority, identityPolicy, protectedPolicy);
  } catch (error) {
    for (const path of written.reverse()) await unlink(path).catch(() => undefined);
    throw error;
  }
}

/** Call again under the outer importer's exclusive stage immediately before publication. */
export async function verifyLegacyStateImport(plan: LegacyStateImportPlan, stagingRoot: string, authority?: LegacySnapshotKeyAuthority,
  identityPolicy?: LegacySubscriptionIdentityImport, protectedPolicy?: LegacyProtectedSubscriptionImport): Promise<void> {
  const { planSha256, ...input } = plan;
  if (digest(input) !== planSha256) fail("PLAN_CHANGED", "State plan was modified.");
  if (plan.keyEpoch) await assertEpoch(authority, plan.keyEpoch);
  const current = await planLegacyStateImport(plan.sourceRoot, plan.subscriptionRoot, authority, identityPolicy, protectedPolicy);
  if (current.planSha256 !== planSha256) fail("SOURCE_CHANGED", "State inventory changed.");
  const stage = await realDirectory(stagingRoot);
  if (protectedPolicy) {
    const rel = relative(protectedPolicy.fixture, stage);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      fail("UNSAFE_PATH", "Protected Subscription stage must remain inside its isolated fixture.");
  }
  if (plan.subscriptionIdentity && await inspectSubscriptionIdentity(plan.subscriptionIdentity, identityPolicy?.authority) !== "committed") {
    fail("UNKNOWN_EFFECT", "Native subscription secret reference is not durably confirmed.");
  }
  const expected = new Map(current.entries.map(entry => [entry.destination, entry]));
  const directories = new Set<string>(current.directories ?? []);
  for (const path of expected.keys()) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  const visited = new Set<string>();
  async function walk(path: string): Promise<void> {
    const full = join(stage, ...path.split("/"));
    let stat;
    try { stat = await lstat(full); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) fail("UNSAFE_PATH", "Staged state contains a link.");
    if (stat.isDirectory() && directories.has(path)) {
      for (const name of await readdir(full)) await walk(`${path}/${name}`);
    } else {
      const entry = expected.get(path);
      if (!entry || !stat.isFile()) fail("UNKNOWN_STATE", "Staged state contains an unexpected entry.");
      if (entry.destination.startsWith("subscriptions/cache/") || entry.destination.startsWith("subscriptions/snapshots/")
        || entry.destination.startsWith("_feedback/") || entry.destination.startsWith("_proposals/")) {
        const pin = await inspectLegacyCacheFile(full);
        if (pin.sha256 !== entry.sha256 || pin.size !== entry.size) fail("STAGE_CHANGED", "Staged cache bytes changed.");
      } else {
        const bytes = await checkedBytes(full);
        if (hash(bytes) !== entry.sha256 || bytes.length !== entry.size) fail("STAGE_CHANGED", "Staged state bytes changed.");
      }
      visited.add(path);
    }
  }
  await walk("agent-snapshot-reads");
  await walk("subscriptions");
  await walk("_feedback");
  await walk("_proposals");
  if (visited.size !== expected.size) fail("STAGE_CHANGED", "Staged state is incomplete.");
  const actorId = "legacy-state-import-validation";
  if (current.entries.some(entry => entry.destination.startsWith("agent-snapshot-reads/"))) {
    await readAgentSnapshots(stage, { operation: "agent.snapshot.list", args: {}, actorId } as never);
  }
  if (current.entries.some(entry => entry.destination.startsWith("subscriptions/"))) {
    await readSubscriptions(stage, { operation: "subscription.list", args: {}, actorId });
  }
  const after = await planLegacyStateImport(plan.sourceRoot, plan.subscriptionRoot, authority, identityPolicy, protectedPolicy);
  if (after.planSha256 !== planSha256) fail("SOURCE_CHANGED", "State inventory changed during verification.");
}

/** Native-only; the returned plaintext buffer belongs to the caller and must be cleared. */
export async function readImportedProtectedSubscriptionSnapshot(
  plan: LegacyStateImportPlan, stagingRoot: string, shareId: string, policy: LegacyProtectedSubscriptionImport,
  authority?: LegacySnapshotKeyAuthority,
): Promise<{ plaintext: Buffer; plaintextSha256: string; itemCount: number }> {
  if (!plan.protectedSubscriptions || !plan.subscriptionRoot || !/^[A-Za-z0-9_-]{1,128}$/.test(shareId))
    fail("INVALID_STATE", "A protected Subscription import and share are required.");
  await verifyLegacyStateImport(plan, stagingRoot, authority, undefined, policy);
  const stateEntry = plan.entries.find(entry => entry.projection === "protected-subscription");
  if (!stateEntry) fail("INVALID_STATE", "Original Subscription identity is unavailable.");
  const bytes = await checkedBytes(stateEntry.source);
  try {
    if (hash(bytes) !== stateEntry.sourceSha256) fail("SOURCE_CHANGED", "Original Subscription state changed.");
    const { state } = protectedSubscriptionState(bytes);
    const matches = (state.shares as Record<string, unknown>[]).filter(share => share.shareId === shareId);
    if (matches.length !== 1) fail("INVALID_STATE", "Original Subscription share is unavailable.");
    const share = matches[0], revision = share.revision as number;
    const entry = plan.protectedSubscriptions.snapshots.find(item => item.name === `${shareId}-${revision}.json`
      && item.status === "authenticated-current");
    if (!entry) fail("INVALID_STATE", "Authenticated current Subscription snapshot is unavailable.");
    const wire = await checkedBytes(join(await realDirectory(stagingRoot), "subscriptions", "snapshots", entry.name), 16 * 1024 * 1024);
    if (hash(wire) !== entry.sha256) fail("STAGE_CHANGED", "Imported Subscription snapshot changed.");
    const readAuthority = protectedAuthority(policy, { root: plan.sourceRoot, profile: plan.subscriptionRoot,
      stateSha256: stateEntry.sourceSha256!, ciphertextSha256: entry.sha256, nodeId: state.nodeId as string,
      shareId, revision, authorityId: policy.authorityId, epoch: policy.epoch });
    const result = await readLegacyProtectedSnapshotFixture({
      root: plan.sourceRoot, profile: plan.subscriptionRoot, nodeId: state.nodeId as string, shareId, revision,
      publicKey: state.publicKey as string, secretSalt: share.secretSalt as string, authVerifier: share.authVerifier as string,
      plaintextHash: share.contentHash as string, summary: share.summary as Record<string, unknown>,
    }, wire, readAuthority);
    try {
      const after = await planLegacyStateImport(plan.sourceRoot, plan.subscriptionRoot, authority, undefined, policy);
      if (after.planSha256 !== plan.planSha256) fail("SOURCE_CHANGED", "Original Subscription changed during read.");
      return result;
    } catch (error) { result.plaintext.fill(0); throw error; }
  } finally { bytes.fill(0); }
}

/**
 * Host-only read seam. Host must authorize actor and bind this plan to its
 * verified import receipt; neither Magic Code nor a public argument grants keys.
 * The existing native list/get still expose encrypted metadata without keys.
 */
export async function readImportedEncryptedSnapshot(
  plan: LegacyStateImportPlan, stagingRoot: string,
  request: { actorId: string; args: unknown }, authority: LegacySnapshotKeyAuthority,
): Promise<unknown> {
  const { planSha256, ...input } = plan;
  if (digest(input) !== planSha256 || !plan.keyEpoch) fail("PLAN_CHANGED", "Encrypted import receipt is invalid.");
  if (typeof request.actorId !== "string" || !request.actorId.trim()) fail("FORBIDDEN", "A trusted actor is required.");
  const definition = agentSnapshotReadDefinitions.find(item => item.id === "agent.snapshot.read")!;
  const args = definition.input.safeParse(request.args);
  if (!args.success) fail("INVALID_INPUT", "Snapshot read arguments are invalid.");
  await assertEpoch(authority, plan.keyEpoch);
  const stage = await realDirectory(stagingRoot);
  const listed = await readAgentSnapshots(stage, { operation: "agent.snapshot.list", args: { limit: 100 }, actorId: request.actorId } as never) as {
    snapshotRevision: string;
  };
  if (args.data.snapshotRevision !== undefined && args.data.snapshotRevision !== listed.snapshotRevision) {
    fail("STAGE_CHANGED", "Snapshot revision changed.");
  }
  let match: { snapshot: Record<string, unknown>; entry: StateEntry } | undefined;
  for (const entry of plan.entries.filter(item => item.destination.startsWith("agent-snapshot-reads/"))) {
    if (!/^agent-snapshot-reads\/\.pkm\/state\/agent-snapshots\/agent_snapshot_[A-Za-z0-9_-]+\.json$/.test(entry.destination)) {
      fail("PLAN_CHANGED", "Snapshot receipt path is invalid.");
    }
    const bytes = await checkedBytes(join(stage, ...entry.destination.split("/")));
    if (hash(bytes) !== entry.sha256 || bytes.length !== entry.size) fail("STAGE_CHANGED", "Snapshot bytes differ from the import receipt.");
    const snapshot = parse(bytes);
    if (snapshot.magicCode === args.data.magic_code) {
      if (match) fail("INVALID_STATE", "Duplicate Snapshot Magic Code.");
      match = { snapshot, entry };
    }
  }
  if (!match) fail("NOT_FOUND", "Snapshot does not exist in the imported receipt.");
  await checkSnapshot(match.snapshot, match.entry.destination.split("/").at(-1)!, authority, plan.keyEpoch);
  if (!object(match.snapshot.payload) || !("algorithm" in match.snapshot.payload)) {
    fail("INVALID_STATE", "Snapshot is not an encrypted original.");
  }
  const payload = await decryptSnapshot(match.snapshot, authority, plan.keyEpoch);
  const projection = snapshotReadProjection(match.snapshot, payload, args.data.recent_messages);
  const result = definition.output.safeParse({ ...projection, snapshotRevision: listed.snapshotRevision,
    adapters: { encryptedPayload: "unavailable", networkRecovery: "unavailable", vscode: "unavailable", restore: "unavailable" } });
  if (!result.success) fail("INVALID_STATE", "Snapshot read projection is invalid.");
  const after = await readAgentSnapshots(stage, { operation: "agent.snapshot.list", args: {
    snapshotRevision: listed.snapshotRevision,
  }, actorId: request.actorId } as never);
  void after;
  await assertEpoch(authority, plan.keyEpoch);
  return result.data;
}
