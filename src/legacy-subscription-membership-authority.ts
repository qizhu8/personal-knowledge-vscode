import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CoreError } from "./contracts.js";
import { readMembershipIntent } from "./legacy-subscription-membership-intent.js";
import { assertNativeSubscriptionHostProof } from "./native-subscription-host-ipc.js";
import type { Storage } from "./storage.js";

export type MembershipRecoveryPhase = "check" | "publish" | "cancel" | "recover";
type Binding = { root: string; profile: string; nonce: string; operationId: string; phase: MembershipRecoveryPhase;
  workspaceId: string; intentSha256: string; parentPid: number; parentStart: string; pins: string };
type Held = { storage: Storage; binding: Binding } | { storage: Storage; phase: MembershipRecoveryPhase;
  workspaceId: string; operationId: string; fingerprint: string; hostProof: () => void };
const authorities = new WeakMap<object, Held>();
const denied = (): never => { throw new CoreError("FORBIDDEN", "Subscription membership recovery authority is invalid."); };

function stableFile(file: string): { value: Buffer; pin: string } {
  const before = lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!())
    || (Number(before.mode) & 0o7077) !== 0 || before.size > 4096n) return denied();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const pin = (value: typeof before) => `${value.dev}:${value.ino}:${value.mode}:${value.uid}:${value.nlink}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
  try {
    if (pin(fstatSync(fd, { bigint: true })) !== pin(before)) return denied();
    const value = readFileSync(fd);
    if (BigInt(value.length) !== before.size || pin(fstatSync(fd, { bigint: true })) !== pin(before)
      || pin(lstatSync(file, { bigint: true })) !== pin(before)) return denied();
    return { value, pin: pin(before) };
  } finally { closeSync(fd); }
}

function processStart(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), end = stat.lastIndexOf(")");
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  if (end < 0 || !/^\d+$/.test(fields[19] || "")) return denied();
  return fields[19]!;
}

function binding(storage: Storage, profile: string, nonce: string, operationId: string,
  phase: MembershipRecoveryPhase, database: DatabaseSync): Binding {
  const root = storage.workspaceRoot(), fixture = dirname(root), parentPid = process.ppid;
  if (process.platform !== "linux" || process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT !== fixture
    || process.env.PKM_PRIVATE_SUBSCRIPTION_UI !== "1" || resolve(fixture) !== fixture
    || !/^pkm-protected-state-fixture-[a-f0-9-]{36}$/.test(basename(fixture))
    || root !== join(fixture, "imported") || profile !== join(fixture, "profile")
    || !/^[a-f0-9-]{36}$/.test(nonce) || !/^[a-f0-9-]{36}$/.test(operationId)
    || !["check", "publish", "cancel"].includes(phase) || parentPid <= 1) return denied();
  const pins: string[] = [];
  for (const dir of [fixture, root, profile, join(fixture, "original")]) {
    const stat = lstatSync(dir, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(dir) !== dir
      || stat.uid !== BigInt(process.getuid!()) || (Number(stat.mode) & 0o7077) !== 0) return denied();
    pins.push(`${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}`);
  }
  const marker = stableFile(join(fixture, "subscription-state-fixture.json"));
  const fixtureMarker = JSON.parse(marker.value.toString("utf8")) as Record<string, unknown>;
  const source = lstatSync(join(fixture, "original"), { bigint: true }), profileStat = lstatSync(profile, { bigint: true });
  if (Object.keys(fixtureMarker).sort().join(",") !== "nonce,profilePin,rootPin,schema"
    || fixtureMarker.schema !== "pkm.protected-subscription-state-fixture/v1" || fixtureMarker.nonce !== nonce
    || fixtureMarker.rootPin !== `${source.dev}:${source.ino}` || fixtureMarker.profilePin !== `${profileStat.dev}:${profileStat.ino}`)
    return denied();
  const workspace = stableFile(join(root, ".pkm-next-workspace"));
  const identity = JSON.parse(workspace.value.toString("utf8")) as Record<string, unknown>;
  if (identity.schema !== "pkm.next-workspace/v2" || typeof identity.id !== "string"
    || !/^[a-f0-9-]{36}$/i.test(identity.id)) return denied();
  const lock = join(profile, "subscriptions-state.lock"), lockStat = lstatSync(lock, { bigint: true });
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink() || lockStat.uid !== BigInt(process.getuid!())) return denied();
  const names = readdirSync(lock);
  if (names.length !== 1 || !/^[a-f0-9-]{36}\.json$/.test(names[0]!)) return denied();
  const ownerFile = stableFile(join(lock, names[0]!)), owner = JSON.parse(ownerFile.value.toString("utf8"));
  if (owner.pid !== parentPid || owner.owner !== "Subscription state mutation" || `${owner.nonce}.json` !== names[0]) return denied();
  const pending = readMembershipIntent(database, identity.id);
  if (!pending || pending.intent.operationId !== operationId) return denied();
  pins.push(marker.pin, workspace.pin, `${lockStat.dev}:${lockStat.ino}:${lockStat.mode}:${lockStat.uid}`, ownerFile.pin);
  return { root, profile, nonce, operationId, phase, workspaceId: identity.id, intentSha256: pending.fingerprint, parentPid,
    parentStart: processStart(parentPid), pins: JSON.stringify(pins) };
}

/** Issuance is restricted to the same locked synthetic legacy host as the action itself. */
export function issueMembershipRecoveryAuthority(storage: Storage, profile: string, nonce: string,
  operationId: string, phase: MembershipRecoveryPhase): object {
  storage.assertWorkspaceLease();
  const database = storage.connectNative();
  try {
    const captured = binding(storage, profile, nonce, operationId, phase, database), authority = Object.freeze({});
    authorities.set(authority, { storage, binding: captured });
    return authority;
  } finally { database.close(); }
}

/** Native IPC issues an ephemeral recovery capability only for its currently locked host request. */
export function issueNativeMembershipRecoveryAuthority(storage: Storage, hostProof: () => void,
  workspaceId: string, operationId: string, phase: MembershipRecoveryPhase): object {
  if (!["check", "publish", "cancel", "recover"].includes(phase)) return denied();
  storage.assertWorkspaceLease();
  assertNativeSubscriptionHostProof(hostProof);
  const database = storage.connectNative();
  try {
    const pending = readMembershipIntent(database, workspaceId);
    if (!pending || pending.intent.operationId !== operationId) return denied();
    const authority = Object.freeze({});
    authorities.set(authority, { storage, phase, workspaceId, operationId, fingerprint: pending.fingerprint, hostProof });
    return authority;
  } finally { database.close(); }
}

/** Consumed under the writer fence; wrong operation, phase, workspace or host is never recoverable. */
export function consumeMembershipRecoveryAuthority(storage: Storage, database: DatabaseSync,
  authority: unknown, phase: MembershipRecoveryPhase): void {
  if (!authority || typeof authority !== "object") return denied();
  const held = authorities.get(authority);
  authorities.delete(authority);
  if (!held || held.storage !== storage) return denied();
  if ("hostProof" in held) {
    if (held.phase !== phase) return denied();
    storage.assertWorkspaceLease();
    assertNativeSubscriptionHostProof(held.hostProof);
    const workspace = stableFile(join(storage.workspaceRoot(), ".pkm-next-workspace"));
    const marker = JSON.parse(workspace.value.toString("utf8")) as Record<string, unknown>;
    const pending = readMembershipIntent(database, held.workspaceId);
    if (marker.schema !== "pkm.next-workspace/v2" || marker.id !== held.workspaceId
      || !pending || pending.intent.operationId !== held.operationId || pending.fingerprint !== held.fingerprint) return denied();
    return;
  }
  if (held.binding.phase !== phase) return denied();
  const current = binding(storage, held.binding.profile, held.binding.nonce, held.binding.operationId, phase, database);
  if (JSON.stringify(current) !== JSON.stringify(held.binding)) return denied();
}
