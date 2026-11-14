import { createHash } from "node:crypto";
import { CoreError } from "./contracts.js";
import { nativeSubscriptionChangeSha256, type GitHubRefreshChange } from "./native-subscription-priority.js";

type File = { path: string; sha256: string; size: number; bytes?: Uint8Array };
type Capture = { state: Record<string, any>; directories: string[]; files: File[] };
const json = (value: unknown) => JSON.stringify(value);
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const conflict = (): never => { throw new CoreError("CONFLICT", "GitHub Subscription refresh differs from its pinned intent."); };

export function validateNativeGitHubTarget(before: Capture, change: GitHubRefreshChange): void {
  nativeSubscriptionChangeSha256(change);
  const members = before.state.subscriptions;
  if (!Array.isArray(members)) return conflict();
  const matches = members.filter((value: any) => value?.id === change.subscriptionId
    && value.nodeId === change.publisherNodeId && value.shareId === change.shareId);
  if (matches.length !== 1) return conflict();
  const record = matches[0], source = record.source;
  if (!source || source.type !== "github" || source.repository !== change.repository || source.branch !== change.branch
    || record.endpoint !== change.repository
    || !/^[a-f0-9]{40}$/.test(source.commit || "") || record.collectionHash !== source.commit
    || (source.credentialTargetId || source.targetId || null) !== change.credentialTargetId) return conflict();
  const paths = source.selectedPaths ?? [], folders = source.selectedFolders ?? [];
  if (!Array.isArray(paths) || !Array.isArray(folders) || [...paths, ...folders].some(value => typeof value !== "string"))
    return conflict();
  if ((paths.length || folders.length) && change.files.some(file => !paths.includes(file.path)
    && !folders.some((folder: string) => file.path.startsWith(`${folder}/`)))) return conflict();
}

/** Validate the completed legacy mount against the exact content and commit pinned before mutation. */
export function validateNativeGitHubRefresh(before: Capture, after: Capture, change: GitHubRefreshChange): void {
  validateNativeGitHubTarget(before, change);
  const { subscriptions: oldMembers, ...oldState } = before.state;
  const { subscriptions: newMembers, ...newState } = after.state;
  if (!Array.isArray(oldMembers) || !Array.isArray(newMembers) || oldMembers.length !== newMembers.length
    || json(oldState) !== json(newState)) return conflict();
  const matches = oldMembers.map((value: any, index: number) => value?.id === change.subscriptionId
    && value.nodeId === change.publisherNodeId && value.shareId === change.shareId ? index : -1)
    .filter((index: number) => index >= 0);
  if (matches.length !== 1) return conflict();
  const index = matches[0]!, old = oldMembers[index], next = newMembers[index];
  if (newMembers.some((item: any, i: number) => i !== index && json(item) !== json(oldMembers[i]))
    || !old?.source || old.source.type !== "github" || old.source.repository !== change.repository
    || old.source.branch !== change.branch || (old.source.credentialTargetId || old.source.targetId || null) !== change.credentialTargetId
    || !next?.source || json(next.source) !== json({ ...old.source, commit: change.commit })
    || next.status !== "current" || next.collectionHash !== change.commit || next.etag !== change.commit
    || !Number.isSafeInteger(old.revision) || old.revision < 0
    || next.revision !== old.revision + (old.collectionHash === change.commit ? 0 : 1)
    || next.itemCount !== change.files.length) return conflict();
  const mutable = new Set(["source", "status", "error", "lastChecked", "lastUpdated", "brokerName", "etag",
    "counts", "itemCount", "revision", "collectionHash"]);
  const fixed = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).filter(([key]) => !mutable.has(key)));
  if (json(fixed(old)) !== json(fixed(next))) return conflict();
  const prefix = `cache/${change.publisherNodeId}/${change.shareId}/`;
  const pins = (files: File[]) => files.filter(file => !file.path.startsWith(prefix))
    .map(({ path, sha256, size }) => ({ path, sha256, size })).sort((a, b) => a.path.localeCompare(b.path));
  const foreignDirs = (dirs: string[]) => dirs.filter(path => !`${path}/`.startsWith(`subscriptions/${prefix}`)).sort();
  if (json(pins(before.files)) !== json(pins(after.files))
    || json(foreignDirs(before.directories)) !== json(foreignDirs(after.directories))) return conflict();
  const target = new Map(after.files.filter(file => file.path.startsWith(prefix)).map(file => [file.path.slice(prefix.length), file]));
  const expectedDirectories = new Set([`subscriptions/${prefix.slice(0, -1)}`]);
  const bytes = (path: string): Uint8Array => {
    const file = target.get(path);
    if (!file?.bytes || file.bytes.length !== file.size || digest(file.bytes) !== file.sha256) return conflict();
    return file.bytes;
  };
  const metadata = (path: string): Record<string, any> => {
    try {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes(path)));
      if (!value || typeof value !== "object" || Array.isArray(value)) return conflict();
      return value;
    } catch { return conflict(); }
  };
  const expected = new Set(["summary.json", "_subscription.json"]), counts: Record<string, number> = {};
  const paths = old.source.selectedPaths ?? [], folders = old.source.selectedFolders ?? [];
  if (!Array.isArray(paths) || !Array.isArray(folders)
    || [...paths, ...folders].some(value => typeof value !== "string")) return conflict();
  for (const file of change.files) {
    if ((paths.length || folders.length) && !paths.includes(file.path)
      && !folders.some((folder: string) => file.path.startsWith(`${folder}/`))) return conflict();
    const path = `content/${file.path}`, actual = target.get(path);
    if (!actual || actual.size !== file.size || actual.sha256 !== file.sha256 || digest(bytes(path)) !== file.sha256)
      return conflict();
    const [type, ...remaining] = file.path.split("/");
    const components = path.split("/");
    for (let length = 1; length < components.length; length++)
      expectedDirectories.add(`subscriptions/${prefix}${components.slice(0, length).join("/")}`);
    const sidecar = metadata(`${path}.pkm-source.json`);
    if (json(Object.keys(sidecar).sort()) !== json(["branch", "brokerName", "commit", "publisherHost", "publisherUser", "remotePath", "repository"])
      || sidecar.repository !== change.repository || sidecar.branch !== change.branch || sidecar.commit !== change.commit
      || sidecar.brokerName !== next.brokerName
      || sidecar.remotePath !== remaining.join("/") || sidecar.publisherUser !== next.publisherUser
      || sidecar.publisherHost !== next.publisherHost) return conflict();
    counts[type!] = (counts[type!] || 0) + 1;
    expected.add(path); expected.add(`${path}.pkm-source.json`);
  }
  if (target.size !== expected.size || [...target.keys()].some(path => !expected.has(path))
    || json(next.counts) !== json(counts)
    || json(after.directories.filter(path => `${path}/`.startsWith(`subscriptions/${prefix}`)).sort())
      !== json([...expectedDirectories].sort())) return conflict();
  const summary = metadata("summary.json"), provenance = metadata("_subscription.json");
  if (json(Object.keys(summary).sort()) !== json(["collectionHash", "counts", "itemCount", "metadataOnly", "name", "revision", "updatedAt"])
    || json(Object.keys(provenance).sort()) !== json(["alias", "endpoint", "id", "nodeId", "priority", "publisher", "shareId", "source", "syncedAt"])
    || summary.name !== next.brokerName || summary.updatedAt !== next.lastUpdated || next.lastUpdated !== next.lastChecked
    || provenance.syncedAt !== next.lastUpdated || provenance.publisher !== "GitHub"
    || summary.collectionHash !== change.commit || summary.revision !== next.revision || summary.itemCount !== change.files.length
    || summary.metadataOnly !== true || json(summary.counts) !== json(counts)
    || provenance.id !== next.id || provenance.nodeId !== next.nodeId || provenance.shareId !== next.shareId
    || provenance.alias !== next.alias || provenance.priority !== next.priority || provenance.endpoint !== change.repository
    || json(provenance.source) !== json(next.source)) return conflict();
}
