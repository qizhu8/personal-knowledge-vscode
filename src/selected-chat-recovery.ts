import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep, dirname, basename } from "node:path";

export interface SelectedChatRecoveryPin {
  schema: "pkm.next-selected-chat-recovery/v1";
  parent: string; parentIdentity: string; workspaceIdentity: string; databaseIdentity: string; markerIdentity: string;
  legacyRoot: string; legacyIdentity: string; workspaceId: string; namespace: string; chatId: string;
  snapshotRoot: string; snapshotParentIdentity: string; snapshotIdentity: string; sourceFingerprint: string;
}

function identity(value: string, directory: boolean, privateDirectory = directory): string {
  if (!isAbsolute(value) || resolve(value) !== value || realpathSync(value) !== value)
    throw new Error("Selected Chat recovery path is not canonical.");
  const stat = lstatSync(value, { bigint: true });
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)
    || privateDirectory && (Number(stat.uid) !== process.getuid?.() || (Number(stat.mode) & 0o7077) !== 0))
    throw new Error("Selected Chat recovery identity is invalid.");
  return `${stat.dev}:${stat.ino}`;
}

export function assertSelectedChatRecovery(pin: SelectedChatRecoveryPin, legacyRoot: string): void {
  if (!pin || pin.schema !== "pkm.next-selected-chat-recovery/v1" || typeof pin.parent !== "string"
    || Object.keys(pin).sort().join(",") !== "chatId,databaseIdentity,legacyIdentity,legacyRoot,markerIdentity,namespace,parent,parentIdentity,schema,snapshotIdentity,snapshotParentIdentity,snapshotRoot,sourceFingerprint,workspaceId,workspaceIdentity"
    || pin.legacyRoot !== legacyRoot || !/^[a-f0-9-]{36}$/.test(pin.workspaceId)
    || !/^[a-f0-9]{16}$/.test(pin.namespace) || !/^[a-f0-9-]{36}$/.test(pin.chatId)
    || !/^[a-f0-9]{64}$/.test(pin.sourceFingerprint) || typeof pin.snapshotRoot !== "string"
    || [pin.parentIdentity, pin.workspaceIdentity, pin.databaseIdentity, pin.markerIdentity,
      pin.legacyIdentity, pin.snapshotParentIdentity, pin.snapshotIdentity].some(value => typeof value !== "string" || !/^\d+:\d+$/.test(value)))
    throw new Error("Selected Chat recovery pin is invalid.");
  const workspace = join(pin.parent, "workspace"), snapshotParent = dirname(pin.snapshotRoot);
  const inside = (a: string, b: string) => {
    const delta = relative(a, b);
    return !delta || (delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta));
  };
  if (inside(legacyRoot, pin.parent) || inside(pin.parent, legacyRoot)
    || dirname(snapshotParent) !== join(pin.parent, "control")
    || !/^selected-chat-[a-f0-9-]{36}$/.test(basename(snapshotParent))
    || !/^chat-snapshot-[a-f0-9-]{36}$/.test(basename(pin.snapshotRoot)))
    throw new Error("Selected Chat recovery paths are invalid.");
  if (identity(pin.parent, true) !== pin.parentIdentity || identity(workspace, true) !== pin.workspaceIdentity
    || identity(join(workspace, "core.sqlite"), false) !== pin.databaseIdentity
    || identity(join(workspace, ".pkm-next-workspace"), false) !== pin.markerIdentity
    || identity(legacyRoot, true, false) !== pin.legacyIdentity
    || identity(snapshotParent, true) !== pin.snapshotParentIdentity || identity(pin.snapshotRoot, true) !== pin.snapshotIdentity
    || JSON.parse(readFileSync(join(workspace, ".pkm-next-workspace"), "utf8")).id !== pin.workspaceId)
    throw new Error("Selected Chat recovery workspace or snapshot changed.");
}
