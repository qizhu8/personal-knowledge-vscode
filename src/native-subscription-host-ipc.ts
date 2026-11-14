import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { CoreError } from "./contracts.js";
import { nativeSubscriptionChangeSha256, type NativeSubscriptionChange } from "./native-subscription-priority.js";

type Phase = "admit" | "status" | "prepare" | "check" | "publish" | "cancel" | "outcome" | "recover";
export type NativeSubscriptionHostRequest = {
  id: string; phase: Phase; operationId?: string; expectedHead?: string | null;
  change?: NativeSubscriptionChange; verifiedPull?: boolean;
};
export interface NativeSubscriptionHostService {
  dispatch(request: Readonly<NativeSubscriptionHostRequest>, assertHostHeld: () => void): Promise<unknown>;
}
type Pin = { dev: bigint; ino: bigint; mode: bigint; uid: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint };
const uuid = (value: unknown): value is string => typeof value === "string"
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const denied = (): never => { throw new CoreError("FORBIDDEN", "Native Subscription host binding is invalid."); };
const activeAssertions = new WeakSet<() => void>();
export function assertNativeSubscriptionHostProof(assertion: () => void): void {
  if (!activeAssertions.has(assertion)) return denied();
  assertion();
}
const same = (left: Pin, right: Pin) => left.dev === right.dev && left.ino === right.ino
  && left.mode === right.mode && left.uid === right.uid && left.size === right.size
  && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;

function directory(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path
    || stat.uid !== BigInt(process.getuid!()) || (Number(stat.mode) & 0o077) !== 0) return denied();
  return stat;
}
function file(path: string): { bytes: Buffer; pin: Pin } {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.uid !== BigInt(process.getuid!()) || (Number(before.mode) & 0o077) !== 0 || before.size > 4096n) return denied();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = readFileSync(fd);
    if (!same(before, fstatSync(fd, { bigint: true })) || !same(before, lstatSync(path, { bigint: true }))
      || BigInt(bytes.length) !== before.size) return denied();
    return { bytes, pin: before };
  } finally { closeSync(fd); }
}
function startTime(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), close = stat.lastIndexOf(")");
  const value = stat.slice(close + 2).trim().split(/\s+/)[19];
  if (close < 0 || !value || !/^\d+$/.test(value)) return denied();
  return value;
}

/**
 * An inherited Node IPC channel is the authority: paths and host identity are
 * fixed by the native launcher, never by a request received over the channel.
 * The legacy host must hold its actual mutation lock until dispatch completes.
 */
export function attachNativeSubscriptionHostIpc(
  root: string, profile: string, service: NativeSubscriptionHostService,
): { close(): Promise<void> } {
  if (process.platform !== "linux" || process.env.PKM_EXPERIMENTAL_SUBSCRIPTION_HOST !== "1"
    || typeof process.send !== "function" || !process.connected || process.ppid <= 1
    || resolve(root) !== root || resolve(profile) !== profile || root === profile
    || typeof service.dispatch !== "function") return denied();
  const rootPin = directory(root), profilePin = directory(profile), hostPid = process.ppid, hostStart = startTime(hostPid);
  const seen = new Set<string>();
  let closed = false, tail = Promise.resolve();
  let sessionLock: { directory: Pin; name: string; file: Pin; bytes: Buffer } | undefined;
  const assertRoots = () => {
    const currentRoot = directory(root), currentProfile = directory(profile);
    if (currentRoot.dev !== rootPin.dev || currentRoot.ino !== rootPin.ino
      || currentProfile.dev !== profilePin.dev || currentProfile.ino !== profilePin.ino
      || process.ppid !== hostPid || startTime(hostPid) !== hostStart || !process.connected) return denied();
  };
  const lockBinding = () => {
    assertRoots();
    const lockPath = join(profile, "subscriptions-state.lock"), lock = directory(lockPath), names = readdirSync(lockPath);
    if (names.length !== 1 || !/^[a-f0-9-]{36}\.json$/.test(names[0]!)) return denied();
    const ownerFile = file(join(lockPath, names[0]!));
    const owner = JSON.parse(ownerFile.bytes.toString("utf8")) as Record<string, unknown>;
    if (owner.pid !== hostPid || owner.owner !== "Subscription state mutation" || `${owner.nonce}.json` !== names[0])
      return denied();
    if (sessionLock && (sessionLock.directory.dev !== lock.dev || sessionLock.directory.ino !== lock.ino
      || sessionLock.name !== names[0] || !same(sessionLock.file, ownerFile.pin) || !sessionLock.bytes.equals(ownerFile.bytes)))
      return denied();
    sessionLock ??= { directory: lock, name: names[0]!, file: ownerFile.pin, bytes: ownerFile.bytes };
    return () => {
      assertRoots();
      const current = directory(lockPath), currentNames = readdirSync(lockPath), currentFile = file(join(lockPath, names[0]!));
      if (current.dev !== lock.dev || current.ino !== lock.ino || currentNames.length !== 1
        || currentNames[0] !== names[0] || !same(currentFile.pin, ownerFile.pin)
        || !currentFile.bytes.equals(ownerFile.bytes)) return denied();
    };
  };
  const parse = (raw: unknown): NativeSubscriptionHostRequest => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return denied();
    const value = raw as Record<string, unknown>;
    if (!uuid(value.id) || !["admit", "status", "prepare", "check", "publish", "cancel", "outcome", "recover"].includes(String(value.phase)))
      return denied();
    const phase = value.phase as Phase;
    if (phase !== "admit" && phase !== "status" && !uuid(value.operationId)) return denied();
    const keys = phase === "admit" || phase === "status" ? ["id", "phase", "type"]
      : phase === "prepare" ? ["change", "expectedHead", "id", "operationId", "phase", "type"]
      : phase === "check" ? ["change", "id", "operationId", "phase", "type"]
      : phase === "publish" ? ["change", "id", "operationId", "phase", "type", "verifiedPull"]
      : ["id", "operationId", "phase", "type"];
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)) return denied();
    if (phase === "prepare" && value.expectedHead !== null
      && (typeof value.expectedHead !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedHead))) return denied();
    if (phase === "publish" && typeof value.verifiedPull !== "boolean") return denied();
    if (["prepare", "check", "publish"].includes(phase)) nativeSubscriptionChangeSha256(value.change as NativeSubscriptionChange);
    return value as NativeSubscriptionHostRequest;
  };
  const receive = (raw: unknown) => {
    if (closed || !raw || typeof raw !== "object" || Array.isArray(raw)
      || (raw as Record<string, unknown>).type !== "native-subscription-host/v1") return;
    tail = tail.then(async () => {
      let id: string | undefined;
      try {
        const request = parse(raw);
        id = request.id;
        if (seen.has(id) || seen.size >= 4096) return denied();
        seen.add(id);
        const assertHostHeld = lockBinding();
        activeAssertions.add(assertHostHeld);
        let result: unknown;
        try {
          result = await service.dispatch(Object.freeze(request), assertHostHeld);
          assertHostHeld();
        } finally { activeAssertions.delete(assertHostHeld); }
        if (!closed && process.connected) process.send!({ id, ok: true, result });
      } catch (error) {
        if (!closed && process.connected && id) process.send!({ id, ok: false,
          code: error instanceof CoreError ? error.code : "HOST_ACTION_UNKNOWN" });
        else void close();
      }
    }).catch(() => { void close(); });
  };
  const close = async () => {
    if (!closed) { closed = true; process.off("message", receive); process.off("disconnect", close); }
    await tail;
  };
  process.on("message", receive);
  process.once("disconnect", close);
  return { close };
}
