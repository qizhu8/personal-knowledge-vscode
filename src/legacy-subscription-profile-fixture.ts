import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync,
  readdirSync, realpathSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { acquireLinuxRootWriterFence } from "./linux-root-writer-fence.js";
import { assertLinuxLegacyWritersQuiescent } from "./linux-legacy-writer-quiescence.js";
import { readLegacyProtectedSnapshotFixture, type LegacyProtectedSnapshotBinding } from "./legacy-protected-snapshot-fixture.js";

type Phase = "pending-created" | "pending-synced" | "linked";
export interface LegacySubscriptionProfileAuthorityBinding {
  readonly root: string;
  readonly profile: string;
  readonly rootPin: string;
  readonly profilePin: string;
  readonly stateSha256: string;
  readonly nodeId: string;
  readonly shareId: string;
  readonly revision: number;
  readonly snapshotSha256: string;
  readonly authorityId: string;
  readonly epoch: string;
}
export interface LegacySubscriptionProfileAuthority {
  readonly authorityId: string;
  readonly epoch: string;
  authorize(binding: Readonly<LegacySubscriptionProfileAuthorityBinding>): Promise<boolean>;
  /** Returns a disposable copy of personalKnowledge.shareBroker.<shareId>.secret. */
  secret(binding: Readonly<LegacySubscriptionProfileAuthorityBinding>): Promise<Buffer | undefined>;
}
export interface LegacySubscriptionProfileFixtureOptions {
  nonce: string;
  shareId: string;
  operation: "associate" | "read" | "recover";
  authority: LegacySubscriptionProfileAuthority;
  checkpoint?(phase: Phase): void;
}

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
function privateDirectory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path
    || stat.uid !== process.getuid?.() || (stat.mode & 0o7077) !== 0)
    fail("FIXTURE_DENIED", "Private fixture directory is unsafe.");
  return `${stat.dev}:${stat.ino}`;
}
function readStable(path: string, limit: number, allowedLinks = 1): Buffer {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== BigInt(allowedLinks)
    || before.uid !== BigInt(process.getuid!()) || (Number(before.mode) & 0o7077) !== 0 || before.size > BigInt(limit))
    fail("UNSAFE_SOURCE", "Fixture file must be private, owned and bounded.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = readFileSync(fd);
    for (const stat of [fstatSync(fd, { bigint: true }), lstatSync(path, { bigint: true })])
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== before.nlink
        || stat.mode !== before.mode || stat.size !== before.size || stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs)
        fail("SOURCE_CHANGED", "Fixture file changed while reading.");
    if (BigInt(bytes.length) !== before.size) fail("SOURCE_CHANGED", "Fixture file changed while reading.");
    return bytes;
  } finally { closeSync(fd); }
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function optional(path: string) {
  try { return lstatSync(path); } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function parse(bytes: Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (object(value)) return value;
  } catch { /* Do not expose source contents. */ }
  return fail("INVALID_STATE", "Original Subscription state is invalid.");
}

async function inspect(root: string, options: LegacySubscriptionProfileFixtureOptions) {
  const parent = dirname(root), profile = join(parent, "profile"), subscription = join(profile, "subscriptions");
  if (process.platform !== "linux" || resolve(root) !== root || basename(root) !== "knowledge"
    || process.env.PKM_PRIVATE_SUBSCRIPTION_FIXTURE !== parent
    || !/^pkm-subscription-fixture-[a-f0-9-]{36}$/.test(basename(parent))
    || !uuid(options.nonce) || !/^[A-Za-z0-9_-]{1,128}$/.test(options.shareId)
    || !validId(options.authority?.authorityId) || !validId(options.authority?.epoch))
    fail("FIXTURE_DENIED", "Only an explicit private Subscription fixture is supported.");
  privateDirectory(parent);
  const rootPin = privateDirectory(root), profilePin = privateDirectory(profile);
  const subscriptionPin = privateDirectory(subscription);
  if (optional(join(root, ".pkm-next-workspace")))
    fail("FIXTURE_DENIED", "The fixture bridge does not replace adopted-workspace ownership.");
  const snapshots = join(subscription, "snapshots");
  const snapshotsPin = privateDirectory(snapshots);
  const marker = parse(readStable(join(parent, "subscription-fixture.json"), 4096));
  if (JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify(["nonce", "profilePin", "rootPin", "schema"])
    || marker.schema !== "pkm.subscription-fixture/v1" || marker.nonce !== options.nonce
    || marker.rootPin !== rootPin || marker.profilePin !== profilePin)
    fail("FIXTURE_DENIED", "Private Subscription fixture binding changed.");
  const statePath = join(subscription, "subscriptions.json");
  const stateStat = lstatSync(statePath);
  const stateBytes = readStable(statePath, 2 * 1024 * 1024);
  const stateSha256 = sha(stateBytes);
  let state: Record<string, unknown>;
  try { state = parse(stateBytes); } finally { stateBytes.fill(0); }
  if (state.schema !== 1 || state.enabled !== false || state.gatewayPid !== undefined || !Array.isArray(state.shares)
    || !Array.isArray(state.subscriptions) || typeof state.privateKey !== "string"
    || typeof state.publicKey !== "string" || typeof state.nodeId !== "string")
    fail("INVALID_STATE", "Original Subscription identity is unavailable.");
  try {
    if (createPrivateKey(state.privateKey).asymmetricKeyType !== "ed25519"
      || createPublicKey(state.publicKey).asymmetricKeyType !== "ed25519"
      || createPublicKey(state.privateKey).export({ type: "spki", format: "pem" }).toString() !== state.publicKey
      || sha(state.publicKey) !== state.nodeId) throw new Error();
  } catch { fail("INVALID_STATE", "Original Subscription identity does not match."); }
  const matches = state.shares.filter(share => object(share) && share.shareId === options.shareId);
  if (matches.length !== 1 || !object(matches[0])) fail("INVALID_STATE", "Original share membership is ambiguous.");
  const share = matches[0];
  if (share.protection !== "secret-protected" || !Number.isSafeInteger(share.revision) || (share.revision as number) < 1
    || typeof share.secretSalt !== "string" || typeof share.authVerifier !== "string"
    || typeof share.contentHash !== "string" || !object(share.summary)
    || typeof share.name !== "string" || share.summary.name !== share.name)
    fail("INVALID_STATE", "Original protected share is invalid.");
  const snapshotName = `${options.shareId}-${share.revision}.json`, currentPath = join(snapshots, snapshotName);
  if (share.snapshotPath !== currentPath) fail("INVALID_STATE", "Original snapshot path does not match its share.");
  const beforeDirectory = lstatSync(snapshots, { bigint: true });
  const names = readdirSync(snapshots).sort();
  if (names.length > 512 || !names.includes(snapshotName)) fail("INVALID_STATE", "Original current snapshot is missing.");
  const history: Array<{ name: string; sha256: string; status: "unverified" }> = [];
  let total = 0;
  for (const name of names) {
    if (!name.startsWith(`${options.shareId}-`) || name === snapshotName) continue;
    const match = new RegExp(`^${options.shareId}-(\\d+)\\.json$`).exec(name);
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1
      || Number(match[1]) >= (share.revision as number)) fail("INVALID_STATE", "Original historical snapshot name is unsupported.");
    const bytes = readStable(join(snapshots, name), 16 * 1024 * 1024);
    total += bytes.length;
    if (total > 32 * 1024 * 1024) fail("LIMIT", "Original snapshot history exceeds the fixture limit.");
    history.push({ name, sha256: sha(bytes), status: "unverified" });
  }
  const snapshotStat = lstatSync(currentPath);
  const wire = readStable(currentPath, 16 * 1024 * 1024);
  const snapshotSha256 = sha(wire);
  const binding: LegacySubscriptionProfileAuthorityBinding = Object.freeze({
    root, profile, rootPin, profilePin, stateSha256, nodeId: state.nodeId, shareId: options.shareId,
    revision: share.revision as number, snapshotSha256, authorityId: options.authority.authorityId, epoch: options.authority.epoch,
  });
  const protectedBinding: LegacyProtectedSnapshotBinding = {
    root, profile, nodeId: state.nodeId, shareId: options.shareId, revision: share.revision as number,
    publicKey: state.publicKey, secretSalt: share.secretSalt, authVerifier: share.authVerifier,
    plaintextHash: share.contentHash, summary: share.summary,
  };
  const verified = await readLegacyProtectedSnapshotFixture(protectedBinding, wire, {
    async authorize() { return await options.authority.authorize(binding); },
    async secret() { return await options.authority.secret(binding); },
  });
  try {
    const afterDirectory = lstatSync(snapshots, { bigint: true }), stateAfter = lstatSync(statePath), snapshotAfter = lstatSync(currentPath);
    const stateAgain = readStable(statePath, 2 * 1024 * 1024);
    let unchangedState: boolean;
    try { unchangedState = sha(stateAgain) === stateSha256; } finally { stateAgain.fill(0); }
    if (privateDirectory(root) !== rootPin || privateDirectory(profile) !== profilePin
      || privateDirectory(subscription) !== subscriptionPin || privateDirectory(snapshots) !== snapshotsPin
      || beforeDirectory.dev !== afterDirectory.dev || beforeDirectory.ino !== afterDirectory.ino
      || beforeDirectory.mtimeNs !== afterDirectory.mtimeNs || beforeDirectory.ctimeNs !== afterDirectory.ctimeNs
      || stateAfter.dev !== stateStat.dev || stateAfter.ino !== stateStat.ino || !unchangedState
      || snapshotAfter.dev !== snapshotStat.dev || snapshotAfter.ino !== snapshotStat.ino
      || sha(readStable(currentPath, 16 * 1024 * 1024)) !== snapshotSha256
      || history.some(entry => sha(readStable(join(snapshots, entry.name), 16 * 1024 * 1024)) !== entry.sha256))
      fail("SOURCE_CHANGED", "Original Subscription source changed during validation.");
    const receipt = { schema: "pkm.private-subscription-association/v1", ...binding, subscriptionPin, snapshotsPin,
      statePin: `${stateStat.dev}:${stateStat.ino}`, snapshotPin: `${snapshotStat.dev}:${snapshotStat.ino}`,
      plaintextSha256: verified.plaintextSha256, itemCount: verified.itemCount, history };
    return { receipt, plaintext: verified.plaintext };
  } catch (error) {
    verified.plaintext.fill(0);
    throw error;
  }
}

/**
 * Explicit offline fixture association, not Storage adoption or an extension host.
 * The host must authorize the original publisher secret and actor independently.
 */
export async function legacySubscriptionProfileFixture(root: string, options: LegacySubscriptionProfileFixtureOptions) {
  if (!options || !["associate", "read", "recover"].includes(options.operation)) fail("FIXTURE_DENIED", "Unknown fixture operation.");
  // Bad keys and corrupted source fail before creating any lock or association file.
  const preflight = await inspect(root, options);
  preflight.plaintext.fill(0);
  const fence = await acquireLinuxRootWriterFence(root);
  try {
    fence.assertHeld();
    await assertLinuxLegacyWritersQuiescent(root);
    await assertLinuxLegacyWritersQuiescent(preflight.receipt.profile);
    const current = await inspect(root, options);
    try {
      if (JSON.stringify(current.receipt) !== JSON.stringify(preflight.receipt))
        fail("SOURCE_CHANGED", "Original Subscription source changed before association.");
      const suffix = sha(options.shareId).slice(0, 32);
      const target = join(root, `.pkm-next-subscription-${suffix}.json`), pending = `${target}.pending`;
      const expected = Buffer.from(JSON.stringify(current.receipt));
      const targetStat = optional(target), pendingStat = optional(pending);
      if (targetStat && pendingStat && (targetStat.dev !== pendingStat.dev || targetStat.ino !== pendingStat.ino))
        fail("RECOVERY_CONFLICT", "Subscription association has unrelated pending state.");
      if (targetStat) {
        const bytes = readStable(target, 65536, pendingStat ? 2 : 1);
        if (!bytes.equals(expected)) fail("RECOVERY_CONFLICT", "Subscription association differs from its original source.");
      }
      fence.assertHeld();
      await assertLinuxLegacyWritersQuiescent(root);
      await assertLinuxLegacyWritersQuiescent(current.receipt.profile);
      if (options.operation === "read") {
        if (pendingStat) fail("RECOVERY_REQUIRED", "Complete the pending association before reading.");
        if (!targetStat) fail("NOT_FOUND", "Subscription association has not been committed.");
        await assertLinuxLegacyWritersQuiescent(root);
        await assertLinuxLegacyWritersQuiescent(current.receipt.profile);
        return { receipt: current.receipt, plaintext: Buffer.from(current.plaintext) };
      }
      if (!targetStat && !pendingStat && options.operation === "recover") fail("NOT_FOUND", "No pending Subscription association exists.");
      if (!targetStat && !pendingStat) {
        const fd = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          options.checkpoint?.("pending-created");
          writeFileSync(fd, expected); fsyncSync(fd);
        } finally { closeSync(fd); }
        syncDirectory(root);
        options.checkpoint?.("pending-synced");
      }
      if (!targetStat) {
        const bytes = readStable(pending, 65536);
        if (!expected.subarray(0, bytes.length).equals(bytes)) fail("RECOVERY_CONFLICT", "Pending association bytes are foreign.");
        if (bytes.length !== expected.length) {
          const fd = openSync(pending, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
          try { writeFileSync(fd, expected.subarray(bytes.length)); fsyncSync(fd); } finally { closeSync(fd); }
        }
        fence.assertHeld();
        await assertLinuxLegacyWritersQuiescent(root);
        await assertLinuxLegacyWritersQuiescent(current.receipt.profile);
        const final = await inspect(root, options);
        try {
          if (JSON.stringify(final.receipt) !== JSON.stringify(current.receipt)) fail("SOURCE_CHANGED", "Original Subscription source changed before publication.");
        } finally { final.plaintext.fill(0); }
        linkSync(pending, target); syncDirectory(root);
        options.checkpoint?.("linked");
      }
      if (optional(pending)) {
        fence.assertHeld();
        await assertLinuxLegacyWritersQuiescent(root);
        await assertLinuxLegacyWritersQuiescent(current.receipt.profile);
        unlinkSync(pending); syncDirectory(root);
      }
      return { receipt: current.receipt };
    } finally { current.plaintext.fill(0); }
  } finally { await fence.release(); }
}
