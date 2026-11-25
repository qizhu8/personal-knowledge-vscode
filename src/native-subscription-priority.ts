import { createHash } from "node:crypto";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { membershipRequestSha256, type MembershipChange } from "./legacy-subscription-membership-change.js";
import { resourcePath } from "./document-path.js";

export type PriorityChange = { action: "priority"; publisherNodeId: string; shareId: string;
  subscriptionId: string; priority: "normal" | "high" | "highest" };
export type RenameChange = { action: "rename"; publisherNodeId: string; shareId: string;
  subscriptionId: string; alias: string };
export type RefreshChange = { action: "refresh"; publisherNodeId: string; shareId: string; subscriptionId: string };
export type GitHubRefreshChange = { action: "github-refresh"; publisherNodeId: string; shareId: string;
  subscriptionId: string; repository: string; branch: string; commit: string; credentialTargetId: string | null;
  files: { path: string; size: number; sha256: string }[] };
export type NativeSubscriptionChange = MembershipChange | PriorityChange | RenameChange | RefreshChange | GitHubRefreshChange;
type File = { path: string; sha256: string; size: number; bytes?: Uint8Array };
type Capture = { state: Record<string, any>; directories: string[]; files: File[] };
const json = (value: unknown) => JSON.stringify(value);
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const conflict = (): never => { throw new CoreError("CONFLICT", "Subscription action is not the authorized change."); };

export function nativeSubscriptionChangeSha256(change: NativeSubscriptionChange): string {
  if (change?.action === "github-refresh") {
    if (json(Object.keys(change).sort()) !== json(["action", "branch", "commit", "credentialTargetId", "files",
      "publisherNodeId", "repository", "shareId", "subscriptionId"])
      || typeof change.repository !== "string" || !change.repository || change.repository.length > 2048 || /[\0\r\n]/.test(change.repository)
      || typeof change.branch !== "string" || !change.branch || change.branch.length > 512 || change.branch.startsWith("-")
      || change.branch.endsWith(".") || change.branch.includes("..") || /[\s~^:?*[\\\x00-\x1f\x7f]/.test(change.branch)
      || !/^[a-f0-9]{40}$/.test(change.commit)
      || change.publisherNodeId !== `github-${hash(change.repository).slice(0, 24)}`
      || change.shareId !== `branch-${hash(`${change.repository}\n${change.branch}`).slice(0, 24)}`
      || typeof change.subscriptionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(change.subscriptionId)
      || change.credentialTargetId !== null && (typeof change.credentialTargetId !== "string"
        || !/^[A-Za-z0-9._-]{1,128}$/.test(change.credentialTargetId))
      || !Array.isArray(change.files) || !change.files.length || change.files.length > 10_000) return conflict();
    const seen = new Set<string>();
    let total = 0;
    for (const file of change.files) {
      if (!file || json(Object.keys(file).sort()) !== json(["path", "sha256", "size"])
        || typeof file.path !== "string" || !resourcePath.safeParse(file.path).success
        || !/^(?:skills|notes|papers|prompts|scripts|packages|servers|recipes)\//.test(file.path)
        || file.path.endsWith(".pkm-source.json") || !Number.isSafeInteger(file.size) || file.size < 0
        || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)
        || seen.has(file.path.normalize("NFC").toLowerCase())) return conflict();
      seen.add(file.path.normalize("NFC").toLowerCase());
      total += file.size;
      if (!Number.isSafeInteger(total) || total > 512 * 1024 * 1024) return conflict();
    }
    return hash(json(change));
  }
  if (!["priority", "rename", "refresh"].includes(change?.action)) return membershipRequestSha256(change as MembershipChange);
  if (change.action !== "priority" && change.action !== "rename" && change.action !== "refresh") return conflict();
  const keys = change.action === "priority" ? ["action", "priority", "publisherNodeId", "shareId", "subscriptionId"]
    : change.action === "rename" ? ["action", "alias", "publisherNodeId", "shareId", "subscriptionId"]
      : ["action", "publisherNodeId", "shareId", "subscriptionId"];
  if (json(Object.keys(change).sort()) !== json(keys)
    || typeof change.publisherNodeId !== "string" || !/^[a-f0-9]{64}$/.test(change.publisherNodeId)
    || typeof change.shareId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(change.shareId)
    || typeof change.subscriptionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(change.subscriptionId)
    || change.action === "priority" && !["normal", "high", "highest"].includes(change.priority)
    || change.action === "rename" && (typeof change.alias !== "string" || change.alias.length > 512 || change.alias !== change.alias.trim()))
    return conflict();
  return hash(json(change));
}

/** Allows only the exact old or requested target state at the legacy write boundary. */
export function validateNativePriorityChange(before: Capture, after: Capture, change: PriorityChange | RenameChange, complete: boolean): void {
  nativeSubscriptionChangeSha256(change);
  const oldMembers = before.state.subscriptions, newMembers = after.state.subscriptions;
  const { subscriptions: _old, ...oldState } = before.state, { subscriptions: _new, ...newState } = after.state;
  if (!Array.isArray(oldMembers) || !Array.isArray(newMembers) || json(oldState) !== json(newState)
    || oldMembers.length !== newMembers.length || json(before.directories) !== json(after.directories)) return conflict();
  const indexes = oldMembers.map((item: any, index: number) =>
    item?.nodeId === change.publisherNodeId && item?.shareId === change.shareId && item?.id === change.subscriptionId ? index : -1)
    .filter((index: number) => index >= 0);
  if (indexes.length !== 1) return conflict();
  const field = change.action === "priority" ? "priority" : "alias";
  const value = change.action === "priority" ? change.priority : change.alias;
  const index = indexes[0]!, old = oldMembers[index], updated = { ...old, [field]: value };
  if (newMembers.some((item: any, i: number) => i === index
    ? json(item) !== json(updated) && (complete || json(item) !== json(old))
    : json(item) !== json(oldMembers[i]))) return conflict();
  const metadataPath = `cache/${change.publisherNodeId}/${change.shareId}/_subscription.json`;
  const pins = (files: File[]) => files.filter(file => file.path !== metadataPath)
    .map(({ path, sha256, size }) => ({ path, sha256, size })).sort((a, b) => a.path.localeCompare(b.path));
  if (json(pins(before.files)) !== json(pins(after.files))) return conflict();
  const oldMeta = before.files.filter(file => file.path === metadataPath);
  const newMeta = after.files.filter(file => file.path === metadataPath);
  if (oldMeta.length !== newMeta.length || oldMeta.length > 1) return conflict();
  if (!oldMeta.length) return;
  const source = oldMeta[0]!, result = newMeta[0]!;
  if (!source.bytes || source.bytes.length !== source.size || hash(source.bytes) !== source.sha256) return conflict();
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.bytes));
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return conflict();
  } catch { return conflict(); }
  metadata[field] = value;
  const target = Buffer.from(JSON.stringify(metadata, null, 2));
  if ((result.sha256 !== hash(target) || result.size !== target.length)
    && (complete || result.sha256 !== source.sha256 || result.size !== source.size)) return conflict();
}

/** Never overwrite an unknown or partially materialized target cache during a refresh retry. */
export function validateNativeRefreshRetry(before: Capture, after: Capture, change: RefreshChange): void {
  nativeSubscriptionChangeSha256(change);
  const { subscriptions: oldMembers, ...oldState } = before.state;
  const { subscriptions: newMembers, ...newState } = after.state;
  if (!Array.isArray(oldMembers) || !Array.isArray(newMembers) || oldMembers.length !== newMembers.length
    || json(oldState) !== json(newState) || json(before.directories) !== json(after.directories)) return conflict();
  const indexes = oldMembers.map((item: any, index: number) =>
    item?.nodeId === change.publisherNodeId && item?.shareId === change.shareId && item?.id === change.subscriptionId ? index : -1)
    .filter((index: number) => index >= 0);
  if (indexes.length !== 1) return conflict();
  const index = indexes[0]!, old = oldMembers[index], current = newMembers[index];
  if (!current || !["new", "current", "offline", "error", "updating"].includes(current.status)
    || current.revision !== old.revision || current.collectionHash !== old.collectionHash) return conflict();
  const mutable = new Set(["status", "error", "lastChecked", "brokerName", "etag", "topics", "tags", "counts", "itemCount"]);
  const fixed = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).filter(([key]) => !mutable.has(key)));
  if (json(fixed(old)) !== json(fixed(current))
    || newMembers.some((item: any, i: number) => i !== index && json(item) !== json(oldMembers[i]))) return conflict();
  const pins = (files: File[]) => files.map(({ path, sha256, size }) => ({ path, sha256, size }))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (json(pins(before.files)) !== json(pins(after.files))) return conflict();
}
