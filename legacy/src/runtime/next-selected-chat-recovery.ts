import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import type { SecretStorageLike } from "../chatroom/chat-room-credentials";

export interface NextSelectedChatRecoveryPin {
  schema: "pkm.next-selected-chat-recovery/v1";
  parent: string; parentIdentity: string; workspaceIdentity: string;
  databaseIdentity: string; markerIdentity: string; legacyRoot: string; legacyIdentity: string;
  workspaceId: string; namespace: string; chatId: string;
  snapshotRoot: string; snapshotParentIdentity: string; snapshotIdentity: string; sourceFingerprint: string;
}

function identity(value: string, directory: boolean, requirePrivate = directory): string {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || fs.realpathSync(value) !== value)
    throw new Error("Selected Chat recovery path is not canonical.");
  const stat = fs.lstatSync(value, { bigint: true });
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n))
    throw new Error("Selected Chat recovery identity is invalid.");
  if (requirePrivate && (Number(stat.uid) !== process.getuid?.() || (Number(stat.mode) & 0o7077) !== 0))
    throw new Error("Selected Chat recovery directory is not owner-private.");
  return `${stat.dev}:${stat.ino}`;
}

function key(parent: string): string {
  return `personalKnowledge.next.selectedChatRecovery.v1.${createHash("sha256").update(parent).digest("hex")}`;
}

export function assertSelectedChatRecoveryPin(pin: NextSelectedChatRecoveryPin, legacyRoot: string): void {
  if (!pin || pin.schema !== "pkm.next-selected-chat-recovery/v1" || typeof pin.parent !== "string"
    || Object.keys(pin).sort().join(",") !== "chatId,databaseIdentity,legacyIdentity,legacyRoot,markerIdentity,namespace,parent,parentIdentity,schema,snapshotIdentity,snapshotParentIdentity,snapshotRoot,sourceFingerprint,workspaceId,workspaceIdentity"
    || pin.legacyRoot !== legacyRoot || !/^[a-f0-9-]{36}$/.test(pin.workspaceId)
    || !/^[a-f0-9]{16}$/.test(pin.namespace) || !/^[a-f0-9-]{36}$/.test(pin.chatId)
    || [pin.parentIdentity, pin.workspaceIdentity, pin.databaseIdentity, pin.markerIdentity,
      pin.legacyIdentity, pin.snapshotParentIdentity, pin.snapshotIdentity].some(value => typeof value !== "string" || !/^\d+:\d+$/.test(value))
    || !/^[a-f0-9]{64}$/.test(pin.sourceFingerprint) || typeof pin.snapshotRoot !== "string")
    throw new Error("Selected Chat recovery pin is invalid.");
  const workspace = path.join(pin.parent, "workspace"), snapshotParent = path.dirname(pin.snapshotRoot);
  if (path.dirname(snapshotParent) !== path.join(pin.parent, "control")
    || !/^selected-chat-[a-f0-9-]{36}$/.test(path.basename(snapshotParent))
    || !/^chat-snapshot-[a-f0-9-]{36}$/.test(path.basename(pin.snapshotRoot)))
    throw new Error("Selected Chat snapshot is outside its original private trial.");
  const relative = path.relative(legacyRoot, pin.parent), reverse = path.relative(pin.parent, legacyRoot);
  if (!relative || !reverse || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    || (!reverse.startsWith(`..${path.sep}`) && reverse !== ".." && !path.isAbsolute(reverse)))
    throw new Error("Selected Chat recovery overlaps the Knowledge Root.");
  if (identity(pin.parent, true) !== pin.parentIdentity || identity(workspace, true) !== pin.workspaceIdentity
    || identity(path.join(workspace, "core.sqlite"), false) !== pin.databaseIdentity
    || identity(path.join(workspace, ".pkm-next-workspace"), false) !== pin.markerIdentity
    || identity(legacyRoot, true, false) !== pin.legacyIdentity
    || identity(snapshotParent, true) !== pin.snapshotParentIdentity
    || identity(pin.snapshotRoot, true) !== pin.snapshotIdentity
    || JSON.parse(fs.readFileSync(path.join(workspace, ".pkm-next-workspace"), "utf8")).id !== pin.workspaceId)
    throw new Error("Selected Chat recovery workspace, snapshot, or Knowledge Root changed.");
}

export async function saveSelectedChatRecoveryPin(secrets: SecretStorageLike, input: {
  workspace: string; legacyRoot: string; workspaceId: string; namespace: string; chatId: string;
  snapshotRoot: string; sourceFingerprint: string;
}): Promise<NextSelectedChatRecoveryPin> {
  const parent = path.dirname(input.workspace);
  if (input.workspace !== path.join(parent, "workspace")) throw new Error("Invalid isolated Chat workspace.");
  const pin: NextSelectedChatRecoveryPin = {
    schema: "pkm.next-selected-chat-recovery/v1", parent,
    parentIdentity: identity(parent, true), workspaceIdentity: identity(input.workspace, true),
    databaseIdentity: identity(path.join(input.workspace, "core.sqlite"), false),
    markerIdentity: identity(path.join(input.workspace, ".pkm-next-workspace"), false),
    legacyRoot: input.legacyRoot, legacyIdentity: identity(input.legacyRoot, true, false),
    workspaceId: input.workspaceId, namespace: input.namespace, chatId: input.chatId,
    snapshotRoot: input.snapshotRoot, snapshotParentIdentity: identity(path.dirname(input.snapshotRoot), true),
    snapshotIdentity: identity(input.snapshotRoot, true), sourceFingerprint: input.sourceFingerprint,
  };
  assertSelectedChatRecoveryPin(pin, input.legacyRoot);
  const previous = await secrets.get(key(parent));
  const pins: NextSelectedChatRecoveryPin[] = previous ? JSON.parse(previous) : [];
  if (!Array.isArray(pins) || pins.length > 128) throw new Error("Selected Chat recovery inventory is invalid.");
  for (const existing of pins) assertSelectedChatRecoveryPin(existing, input.legacyRoot);
  const match = pins.find(existing => existing.namespace === pin.namespace && existing.chatId === pin.chatId);
  if (match && JSON.stringify(match) !== JSON.stringify(pin))
    throw new Error("This Chat already has a different recovery binding.");
  if (!match) {
    if (pins.length >= 128) throw new Error("Too many selected Chat recovery bindings.");
    await secrets.store(key(parent), JSON.stringify([...pins, pin]));
  }
  return pin;
}

export async function loadSelectedChatRecoveryPins(secrets: SecretStorageLike, parent: string,
  legacyRoot: string): Promise<NextSelectedChatRecoveryPin[]> {
  const saved = await secrets.get(key(parent));
  if (!saved) return [];
  let pins: NextSelectedChatRecoveryPin[];
  try { pins = JSON.parse(saved); } catch { throw new Error("Selected Chat recovery inventory is invalid."); }
  if (!Array.isArray(pins) || pins.length > 128
    || new Set(pins.map(pin => `${pin?.namespace}:${pin?.chatId}`)).size !== pins.length)
    throw new Error("Selected Chat recovery inventory is invalid.");
  for (const pin of pins) {
    if (pin.parent !== parent) throw new Error("Selected Chat recovery pin has the wrong trial.");
    assertSelectedChatRecoveryPin(pin, legacyRoot);
  }
  return pins;
}
