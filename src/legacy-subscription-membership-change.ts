import { createHash, createPublicKey, verify } from "node:crypto";
import { CoreError } from "./contracts.js";

type Pin = { path: string; sha256: string; size: number };
type Capture = {
  state: Record<string, any>;
  directories: string[];
  files: Array<Pin & { bytes?: Uint8Array }>;
};
export type MembershipChange =
  | { action: "add"; publisherNodeId: string; shareId: string; magicLink: string; alias: string; endpoint: string; secretSalt: string | null }
  | { action: "remove"; publisherNodeId: string; shareId: string; subscriptionId: string };
const json = (value: unknown) => JSON.stringify(value);
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const conflict = (): never => { throw new CoreError("CONFLICT", "Subscription membership change is not the authorized action."); };
const plainObject = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const subscriberKeys = new Set(["id", "alias", "priority", "nodeId", "publisher", "publisherUser", "publisherHost", "endpoint",
  "shareId", "publicKey", "magicLink", "revision", "collectionHash", "topics", "tags", "counts", "itemCount", "etag",
  "status", "secretProtected", "secretSalt", "brokerName", "lastChecked", "lastUpdated", "error"]);

/** Hash only public, explicitly authorized inputs; never include a Broker secret. */
export function membershipRequestSha256(change: MembershipChange): string {
  if (!plainObject(change) || !/^[a-f0-9]{64}$/.test(change.publisherNodeId)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(change.shareId)
    || (change.action === "add" ? json(Object.keys(change).sort()) !== json([
      "action", "alias", "endpoint", "magicLink", "publisherNodeId", "secretSalt", "shareId",
    ]) || typeof change.magicLink !== "string" || change.magicLink.length > 32_768
      || typeof change.alias !== "string" || change.alias.length > 512 || typeof change.endpoint !== "string"
      || change.endpoint.length > 2048 || !(change.secretSalt === null || typeof change.secretSalt === "string"
        && /^[A-Za-z0-9_-]{16,128}$/.test(change.secretSalt))
      : change.action !== "remove" || json(Object.keys(change).sort()) !== json([
        "action", "publisherNodeId", "shareId", "subscriptionId",
      ]) || typeof change.subscriptionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(change.subscriptionId)))
    return conflict();
  if (change.action === "add") validateAddedRequest(change);
  return digest(json(change));
}

function signedLink(link: string): Record<string, any> {
  const match = /^pkmshare:v1:([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(link);
  if (!match || link.length > 32_768) return conflict();
  try {
    const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(match[1]!, "base64url")));
    if (!plainObject(payload) || payload.protocol !== "pkmshare:v1" || typeof payload.publicKey !== "string"
      || digest(payload.publicKey) !== payload.nodeId || createPublicKey(payload.publicKey).asymmetricKeyType !== "ed25519"
      || !verify(null, Buffer.from(match[1]!), payload.publicKey, Buffer.from(match[2]!, "base64url"))
      || typeof payload.publisher !== "string" || typeof payload.publisherUser !== "string" || !payload.publisherUser.trim()
      || typeof payload.publisherHost !== "string" || !payload.publisherHost.trim()
      || typeof payload.shareId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.shareId)
      || typeof payload.endpoint !== "string") return conflict();
    return payload;
  } catch { return conflict(); }
}

function validateAddedRequest(change: Extract<MembershipChange, { action: "add" }>): Record<string, any> {
  const link = signedLink(change.magicLink);
  let linkUrl: URL, endpoint: URL;
  try { linkUrl = new URL(link.endpoint); endpoint = new URL(change.endpoint); }
  catch { return conflict(); }
  if (link.nodeId !== change.publisherNodeId || link.shareId !== change.shareId
    || !["http:", "https:"].includes(linkUrl.protocol) || endpoint.protocol !== linkUrl.protocol
    || endpoint.hostname !== linkUrl.hostname || linkUrl.username || linkUrl.password || endpoint.username || endpoint.password
    || linkUrl.pathname !== "/" || linkUrl.search || linkUrl.hash || endpoint.pathname !== "/" || endpoint.search || endpoint.hash
    || !endpoint.port || (!!link.secretProtected ? !!linkUrl.port || !change.secretSalt
      : endpoint.origin !== linkUrl.origin || change.secretSalt !== null)) return conflict();
  return link;
}

function parseFile(file: Capture["files"][number] | undefined): Record<string, any> {
  if (!file?.bytes || file.bytes.length !== file.size || digest(file.bytes) !== file.sha256) return conflict();
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
    if (!plainObject(value)) return conflict();
    return value;
  } catch { return conflict(); }
}

function validateAddedRecord(record: Record<string, any>, change: Extract<MembershipChange, { action: "add" }>,
  files: Capture["files"]): void {
  const link = validateAddedRequest(change);
  if (record.nodeId !== link.nodeId || record.nodeId !== change.publisherNodeId || record.shareId !== link.shareId
    || record.shareId !== change.shareId || record.magicLink !== change.magicLink || record.publicKey !== link.publicKey
    || record.publisher !== link.publisher || record.publisherUser !== link.publisherUser || record.publisherHost !== link.publisherHost
    || record.endpoint !== change.endpoint || record.alias !== change.alias.trim() || record.priority !== "normal"
    || !!record.secretProtected !== !!link.secretProtected
    || (link.secretProtected ? !change.secretSalt || record.secretSalt !== change.secretSalt
      : change.secretSalt !== null || record.secretSalt !== undefined)
    || record.source !== undefined || record.error !== undefined
    || record.status !== "current" || !Number.isSafeInteger(record.revision) || record.revision < 1
    || typeof record.collectionHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record.collectionHash)
    || typeof record.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(record.id)
    || Object.keys(record).some(key => !subscriberKeys.has(key))) return conflict();
  const prefix = `cache/${record.nodeId}/${record.shareId}/`;
  const summary = parseFile(files.find(file => file.path === `${prefix}summary.json`));
  const metadata = parseFile(files.find(file => file.path === `${prefix}_subscription.json`));
  parseFile(files.find(file => file.path === `${prefix}bundle.json`));
  const { signature, ...unsigned } = summary;
  try {
    if (typeof signature !== "string" || summary.shareId !== record.shareId || summary.metadataOnly !== true
      || summary.revision !== record.revision || summary.collectionHash !== record.collectionHash
      || !!summary.secretProtected !== !!record.secretProtected || summary.secretSalt !== record.secretSalt
      || summary.name !== record.brokerName || summary.itemCount !== record.itemCount
      || json(summary.counts) !== json(record.counts) || json(summary.topics) !== json(record.topics)
      || json(summary.tags) !== json(record.tags)
      || !verify(null, Buffer.from(json(unsigned)), record.publicKey, Buffer.from(signature, "base64url"))
      || metadata.subscriptionId !== record.id || metadata.nodeId !== record.nodeId || metadata.shareId !== record.shareId
      || metadata.alias !== record.alias || metadata.endpoint !== record.endpoint || metadata.priority !== record.priority
      || metadata.revision !== record.revision || metadata.collectionHash !== record.collectionHash) return conflict();
  } catch { return conflict(); }
}

/** A retry can only touch the approved target after all foreign state is still exact. */
export function validatePendingMembershipRetry(before: Capture, observed: Capture, change: MembershipChange): void {
  membershipRequestSha256(change);
  if (!plainObject(before.state) || !plainObject(observed.state)
    || !Array.isArray(before.state.subscriptions) || !Array.isArray(observed.state.subscriptions)) return conflict();
  const { subscriptions: oldMembers, ...oldState } = before.state;
  const { subscriptions: observedMembers, ...observedState } = observed.state;
  if (json(oldState) !== json(observedState)) return conflict();
  const target = (item: Record<string, any>) => item.nodeId === change.publisherNodeId && item.shareId === change.shareId;
  if (!oldMembers.every(plainObject) || !observedMembers.every(plainObject)
    || new Set(observedMembers.map((item: any) => item.id)).size !== observedMembers.length)
    return conflict();
  const oldTargets = oldMembers.filter(target), currentTargets = observedMembers.filter(target);
  if (json(oldMembers.filter((item: any) => !target(item))) !== json(observedMembers.filter((item: any) => !target(item)))
    || currentTargets.length > 1 || (change.action === "add" ? oldTargets.length !== 0 : oldTargets.length !== 1))
    return conflict();
  if (change.action === "add" && currentTargets.length) {
    const record = currentTargets[0], link = validateAddedRequest(change);
    if (observedMembers.at(-1) !== record || typeof record.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(record.id)
      || record.priority !== "normal" || !["new", "current", "offline", "error"].includes(record.status)
      || Object.keys(record).some(key => !subscriberKeys.has(key))
      || record.magicLink !== change.magicLink || record.nodeId !== change.publisherNodeId || record.shareId !== change.shareId
      || record.publicKey !== link.publicKey || record.publisher !== link.publisher
      || record.publisherUser !== link.publisherUser || record.publisherHost !== link.publisherHost
      || record.endpoint !== change.endpoint || record.alias !== change.alias.trim()
      || !!record.secretProtected !== !!link.secretProtected || record.secretSalt !== (change.secretSalt ?? undefined)
      || record.source !== undefined) return conflict();
  }
  if (change.action === "remove") {
    if (oldTargets[0]?.id !== change.subscriptionId
      || currentTargets.length && json(currentTargets[0]) !== json(oldTargets[0])) return conflict();
  }
  const prefix = `cache/${change.publisherNodeId}/${change.shareId}/`;
  const foreignFiles = (files: Capture["files"]) => files.filter(file => !file.path.startsWith(prefix))
    .map(({ path, sha256, size }) => ({ path, sha256, size })).sort((a, b) => a.path.localeCompare(b.path));
  const parent = `subscriptions/cache/${change.publisherNodeId}`;
  const others = oldMembers.some((item: any) => item.nodeId === change.publisherNodeId && !target(item));
  const firstOrLast = oldMembers.length === 0 || observedMembers.length === 0;
  const foreignDirs = (dirs: string[]) => dirs.filter(path => !`${path}/`.startsWith(`subscriptions/${prefix}`)
    && (others || path !== parent) && !(firstOrLast && path === "subscriptions/cache")).sort();
  if (json(foreignFiles(before.files)) !== json(foreignFiles(observed.files))
    || json(foreignDirs(before.directories)) !== json(foreignDirs(observed.directories))) return conflict();
  if (change.action === "remove" && currentTargets.length) {
    const pins = (files: Capture["files"]) => files.map(({ path, sha256, size }) => ({ path, sha256, size }));
    if (json(before.directories) !== json(observed.directories)
      || json(pins(before.files)) !== json(pins(observed.files))) return conflict();
  }
}

/**
 * Validate only the authorized membership delta. For additions this validates the old
 * signed link and summary, but the live trusted host must also have verified/decrypted
 * the downloaded snapshot before calling this function; plaintext cache alone is not proof.
 */
export function validateMembershipChange(before: Capture, after: Capture, change: MembershipChange): void {
  membershipRequestSha256(change);
  if (!plainObject(before.state) || !plainObject(after.state)
    || !Array.isArray(before.state.subscriptions) || !Array.isArray(after.state.subscriptions)
    || !/^[a-f0-9]{64}$/.test(change.publisherNodeId) || !/^[A-Za-z0-9_-]{1,128}$/.test(change.shareId))
    return conflict();
  const { subscriptions: oldMembers, ...oldState } = before.state;
  const { subscriptions: newMembers, ...newState } = after.state;
  if (json(oldState) !== json(newState) || !oldMembers.every(plainObject) || !newMembers.every(plainObject))
    return conflict();
  const validMembers = (members: Record<string, any>[]) =>
    members.every(item => typeof item.id === "string" && typeof item.nodeId === "string" && typeof item.shareId === "string")
    && new Set(members.map(item => item.id)).size === members.length
    && new Set(members.map(item => `${item.nodeId}\0${item.shareId}`)).size === members.length;
  if (!validMembers(oldMembers) || !validMembers(newMembers)) return conflict();
  const matches = (item: Record<string, any>) => item.nodeId === change.publisherNodeId && item.shareId === change.shareId;
  if (change.action === "add") {
    if (oldMembers.some(matches) || newMembers.length !== oldMembers.length + 1
      || json(newMembers.slice(0, -1)) !== json(oldMembers) || !matches(newMembers.at(-1)!)) return conflict();
    validateAddedRecord(newMembers.at(-1)!, change, after.files);
  } else {
    const target = oldMembers.filter(matches);
    if (target.length !== 1 || target[0]!.id !== change.subscriptionId
      || json(oldMembers.filter(item => item !== target[0])) !== json(newMembers)) return conflict();
  }
  const prefix = `cache/${change.publisherNodeId}/${change.shareId}/`;
  const unrelatedFiles = (files: Capture["files"]) => files.filter(file => !file.path.startsWith(prefix))
    .map(({ path, sha256, size }) => ({ path, sha256, size })).sort((a, b) => a.path.localeCompare(b.path));
  const noOtherPublisherMembers = !oldMembers.some(item => item.nodeId === change.publisherNodeId && !matches(item))
    && !newMembers.some(item => item.nodeId === change.publisherNodeId && !matches(item));
  const parent = `subscriptions/cache/${change.publisherNodeId}`;
  const firstOrLast = oldMembers.length === 0 || newMembers.length === 0;
  const unrelatedDirs = (dirs: string[]) => dirs.filter(path => !`${path}/`.startsWith(`subscriptions/${prefix}`)
    && !(noOtherPublisherMembers && path === parent) && !(firstOrLast && path === "subscriptions/cache")).sort();
  if (json(unrelatedFiles(before.files)) !== json(unrelatedFiles(after.files))
    || json(unrelatedDirs(before.directories)) !== json(unrelatedDirs(after.directories))
    || change.action === "remove" && after.files.some(file => file.path.startsWith(prefix))
    || change.action === "remove" && after.directories.some(path => `${path}/`.startsWith(`subscriptions/${prefix}`)))
    return conflict();
}
