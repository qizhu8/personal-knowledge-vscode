import * as fs from "fs";
import * as path from "path";
import type { SecretStorageLike } from "./chat-room-credentials";
import { ChatRoomCredentialStore } from "./chat-room-credentials";
import type { NextRoomHostBinding } from "./next-room-host-bridge";

const key = "personalKnowledge.next.isolatedRoomRecovery.v1";
const multiKey = "personalKnowledge.next.isolatedRoomRecovery.v2";

export interface NextRoomRecoveryPin {
  schema: "pkm.next-isolated-room-recovery/v1";
  parent: string;
  parentIdentity: string;
  workspaceIdentity: string;
  databaseIdentity: string;
  markerIdentity: string;
  legacyRoot: string;
  legacyIdentity: string;
  workspaceId: string;
  roomId: string;
  sourceFingerprint: string;
  hostCredentialHash: string;
  origin?: "native";
  nativeName?: string;
  nativeHostName?: string;
  roomName?: string;
}
let pendingSave: Promise<void> = Promise.resolve();

function identity(value: string, directory: boolean): string {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || fs.realpathSync(value) !== value)
    throw new Error("Room recovery path is not a canonical real path.");
  const stat = fs.lstatSync(value, { bigint: true });
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))
    throw new Error("Room recovery path identity is invalid.");
  return `${stat.dev}:${stat.ino}`;
}

export function assertRoomRecoveryPin(pin: NextRoomRecoveryPin, legacyRoot: string): void {
  if (!pin || pin.schema !== "pkm.next-isolated-room-recovery/v1"
    || !/^[a-f0-9-]{36}$/.test(pin.workspaceId) || !/^[A-Za-z0-9_-]{6,80}$/.test(pin.roomId)
    || !/^[a-f0-9]{64}$/.test(pin.sourceFingerprint) || !/^[a-f0-9]{64}$/.test(pin.hostCredentialHash)
    || pin.origin !== undefined && pin.origin !== "native"
    || pin.origin === "native" && (typeof pin.nativeName !== "string" || !pin.nativeName
      || Array.from(pin.nativeName).length > 80 || pin.nativeName !== pin.nativeName.normalize("NFKC").trim().replace(/\s+/g, " ")
      || typeof pin.nativeHostName !== "string" || !pin.nativeHostName || pin.nativeHostName.length > 60 || pin.nativeHostName.trim() !== pin.nativeHostName)
    || pin.origin !== "native" && (pin.nativeName !== undefined || pin.nativeHostName !== undefined)
    || pin.roomName !== undefined && (typeof pin.roomName !== "string" || !pin.roomName || pin.roomName.length > 200)
    || typeof pin.parent !== "string" || typeof pin.legacyRoot !== "string" || pin.legacyRoot !== legacyRoot)
    throw new Error("Room recovery profile pin is invalid.");
  const root = path.join(pin.parent, "workspace");
  const delta = path.relative(pin.legacyRoot, pin.parent), reverse = path.relative(pin.parent, pin.legacyRoot);
  if (!delta || !reverse || (!delta.startsWith(`..${path.sep}`) && delta !== ".." && !path.isAbsolute(delta))
    || (!reverse.startsWith(`..${path.sep}`) && reverse !== ".." && !path.isAbsolute(reverse)))
    throw new Error("Room recovery and the current Knowledge Root overlap.");
  const parentStat = fs.lstatSync(pin.parent);
  if (parentStat.uid !== process.getuid?.() || (parentStat.mode & 0o077) !== 0
    || identity(pin.parent, true) !== pin.parentIdentity || identity(root, true) !== pin.workspaceIdentity
    || identity(path.join(root, "core.sqlite"), false) !== pin.databaseIdentity
    || identity(path.join(root, ".pkm-next-workspace"), false) !== pin.markerIdentity
    || identity(legacyRoot, true) !== pin.legacyIdentity
    || JSON.parse(fs.readFileSync(path.join(root, ".pkm-next-workspace"), "utf8")).id !== pin.workspaceId)
    throw new Error("Room recovery workspace, database, or Knowledge Root changed.");
}

export async function saveRoomRecoveryPin(secrets: SecretStorageLike, binding: NextRoomHostBinding, legacyRoot: string,
  nativeName?: string, nativeHostName?: string, roomName?: string): Promise<void> {
  const parent = path.dirname(binding.root);
  if (binding.root !== path.join(parent, "workspace") || binding.actorId !== "local:owner" || binding.operation !== "reopen")
    throw new Error("Invalid isolated Room recovery binding.");
  const credentials = await new ChatRoomCredentialStore(secrets).load(binding.roomId);
  if (!credentials) throw new Error("Room Host credentials are unavailable.");
  const pin: NextRoomRecoveryPin = {
    schema: "pkm.next-isolated-room-recovery/v1", parent,
    parentIdentity: identity(parent, true), workspaceIdentity: identity(binding.root, true),
    databaseIdentity: identity(path.join(binding.root, "core.sqlite"), false),
    markerIdentity: identity(path.join(binding.root, ".pkm-next-workspace"), false),
    legacyRoot, legacyIdentity: identity(legacyRoot, true), workspaceId: binding.workspaceId,
    roomId: binding.roomId, sourceFingerprint: binding.sourceFingerprint, hostCredentialHash: credentials.hostCredentialHash,
    ...(nativeName === undefined ? {} : { origin: "native" as const, nativeName, nativeHostName }),
    ...(roomName === undefined ? {} : { roomName }),
  };
  assertRoomRecoveryPin(pin, legacyRoot);
  const save = pendingSave.then(async () => {
    const stored = await readPins(secrets);
    for (const previous of stored.filter(item => item.parent === parent)) {
      assertRoomRecoveryPin(previous, legacyRoot);
      if (previous.workspaceId !== pin.workspaceId || previous.workspaceIdentity !== pin.workspaceIdentity
        || previous.databaseIdentity !== pin.databaseIdentity || previous.markerIdentity !== pin.markerIdentity
        || previous.parentIdentity !== pin.parentIdentity || previous.legacyIdentity !== pin.legacyIdentity)
        throw new Error("The existing Room recovery workspace pin changed.");
    }
    const previous = stored.find(item => item.parent === parent && item.roomId === pin.roomId);
    if (previous && (previous.sourceFingerprint !== pin.sourceFingerprint || previous.hostCredentialHash !== pin.hostCredentialHash
      || previous.origin !== pin.origin || previous.nativeName !== pin.nativeName || previous.nativeHostName !== pin.nativeHostName))
      throw new Error("The existing Room recovery authority changed.");
    const next = [...stored.filter(item => item.parent !== parent || item.roomId !== pin.roomId), pin];
    if (next.length > 128) throw new Error("Too many independently pinned isolated Rooms.");
    if (next.length === 1 && !await secrets.get(multiKey)) await secrets.store(key, JSON.stringify(pin));
    else await secrets.store(multiKey, JSON.stringify({ schema: "pkm.next-isolated-room-recoveries/v2", pins: next }));
  });
  pendingSave = save.catch(() => undefined);
  await save;
}

async function readPins(secrets: SecretStorageLike): Promise<NextRoomRecoveryPin[]> {
  const saved = await secrets.get(multiKey);
  let pins: unknown;
  try {
    if (saved) {
      const value = JSON.parse(saved);
      if (!value || value.schema !== "pkm.next-isolated-room-recoveries/v2" || !Array.isArray(value.pins))
        throw new Error();
      pins = value.pins;
    } else {
      const single = await secrets.get(key);
      pins = single ? [JSON.parse(single)] : [];
    }
  } catch { throw new Error("Room recovery profile pin is invalid."); }
  if (!Array.isArray(pins) || pins.length > 128 || pins.some(pin => !pin || typeof pin !== "object"
    || pin.schema !== "pkm.next-isolated-room-recovery/v1" || typeof pin.parent !== "string"
    || typeof pin.roomId !== "string") || new Set(pins.map(pin => `${pin.parent}\0${pin.roomId}`)).size !== pins.length)
    throw new Error("Room recovery profile pin is invalid.");
  return pins as NextRoomRecoveryPin[];
}

export async function loadRoomRecoveryPins(secrets: SecretStorageLike, parent: string, legacyRoot: string): Promise<NextRoomRecoveryPin[]> {
  const pins = (await readPins(secrets)).filter(pin => pin.parent === parent);
  for (const pin of pins) assertRoomRecoveryPin(pin, legacyRoot);
  return pins;
}

export async function verifyRoomRecoveryCredential(secrets: SecretStorageLike, pin: NextRoomRecoveryPin): Promise<void> {
  const credentials = await new ChatRoomCredentialStore(secrets).load(pin.roomId);
  if (!credentials || credentials.hostCredentialHash !== pin.hostCredentialHash)
    throw new Error("The original Room Host credential is missing or changed.");
}

export async function loadRoomRecoveryPin(secrets: SecretStorageLike, parent: string, legacyRoot: string): Promise<NextRoomRecoveryPin | undefined> {
  const pin = (await loadRoomRecoveryPins(secrets, parent, legacyRoot))[0];
  if (pin) await verifyRoomRecoveryCredential(secrets, pin);
  return pin;
}
