import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { CoreError } from "./contracts.js";
import { BrokerAcl } from "./domain/subscription-reads-acl.js";
import { normalizeClientIp } from "./domain/subscription-reads-ip-policy.js";
import { persistedBrokerAclPolicy } from "./domain/subscription-reads-policy.js";
import { subscriptionPriority } from "./domain/subscription-reads-record.js";
import {
  subscriptionMetadata, subscriptionReadDefinitions, type SubscriptionReadRequest,
} from "./subscription-reads-contracts.js";
import { subscriptionBrokerDefinitions } from "./subscription-broker-contracts.js";
import { brokerShareMarkers, sharedContentFolder, sharedContentIdentity } from "./domain/subscription-broker-share-markers.js";
import { openProtectedRefresh, type RefreshView } from "./legacy-subscription-refresh.js";

export { subscriptionReadDefinitions } from "./subscription-reads-contracts.js";
export type { SubscriptionReadRequest } from "./subscription-reads-contracts.js";

export const SUBSCRIPTION_READ_LIMITS = Object.freeze({
  fileBytes: 2 * 1024 * 1024, snapshotBytes: 8 * 1024 * 1024, files: 128,
  records: 4096, rules: 128, policyEntries: 4096, page: 100,
});
const text = z.string().max(2048);
const identity = subscriptionMetadata.shape.id;
const texts = z.array(text).max(SUBSCRIPTION_READ_LIMITS.records);
const rules = z.array(text).max(SUBSCRIPTION_READ_LIMITS.rules);
const number = z.number().int().safe().nonnegative();
const record = z.object({
  id: identity, alias: text, priority: z.unknown().optional(), brokerName: text.optional(),
  nodeId: identity, publisher: text, publisherUser: text, publisherHost: text,
  endpoint: z.string().max(8192), shareId: identity, publicKey: z.string().max(16384),
  magicLink: z.string().max(16384), revision: number, collectionHash: text,
  topics: texts, tags: texts, counts: z.record(text, number), itemCount: number,
  etag: text, secretProtected: z.boolean().optional(), secretSalt: text.optional(),
  lastChecked: text.optional(), lastUpdated: text.optional(),
  status: subscriptionMetadata.shape.status, error: text.optional(),
  source: z.object({
    type: z.literal("github"), targetId: text.optional(), credentialTargetId: text.optional(),
    repository: text, branch: text, commit: text, selectedPaths: texts.optional(), selectedFolders: texts.optional(),
  }).optional(),
});
const share = z.object({
  shareId: identity, summary: z.object({ shareId: identity }),
  published: z.boolean().optional(),
  accessMode: z.enum(["block-list", "white-list"]).optional(),
  ipRules: rules.optional(), blockedIps: rules.optional(),
  accountMode: z.enum(["open", "block-list", "white-list"]).optional(),
  accountRules: rules.optional(),
}).refine(value => value.shareId === value.summary.shareId);
const stateSchema = z.object({
  schema: z.literal(1), nodeId: identity,
  shares: z.array(share).max(SUBSCRIPTION_READ_LIMITS.records),
  subscriptions: z.array(record).max(SUBSCRIPTION_READ_LIMITS.records).default([]),
});
const markerShare = z.object({
  shareId: identity, name: text, published: z.boolean().optional(),
  contentTypes: texts.optional(),
  selected: z.record(text, texts).optional(),
  folders: z.record(text, texts).optional(),
});
const block = z.object({ ip: text, reason: text, failedAttempts: number, blockedAt: text });
const statsSchema = z.object({
  schema: z.literal(1),
  automaticBlocks: z.record(identity, z.record(text, block)).default({}),
});
const cacheSummary = z.object({ name: text.optional() });

function failure(code: string, message: string): never { throw new CoreError(code, message); }
function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) failure("INVALID_DATA", `Invalid persisted subscription ${label}.`);
  return parsed.data;
}
function same(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function missing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

class Snapshot {
  private readonly paths = new Map<string, BigIntStats | undefined>();
  private readonly contents = new Map<string, Buffer | undefined>();
  private bytes = 0;
  private readonly refresh: RefreshView | undefined;
  private readonly refreshConnection: ReturnType<typeof openProtectedRefresh>;
  constructor(private readonly root: string, private readonly native?: () => RefreshView) {
    let connection: ReturnType<typeof openProtectedRefresh> | undefined;
    try {
      const stat = lstatSync(root, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root) {
        failure("INVALID_WORKSPACE", "Subscription reads require a non-symlink isolated workspace.");
      }
      this.refreshConnection = connection = openProtectedRefresh(root);
      const fixture = this.refreshConnection.read();
      if (fixture && native) failure("IMPORT_RECEIPT_INVALID", "Subscription snapshot authorities conflict.");
      this.refresh = native ? native() : fixture;
      const after = lstatSync(root, { bigint: true });
      if (after.dev !== stat.dev || after.ino !== stat.ino || !after.isDirectory() || after.isSymbolicLink())
        failure("REVISION_CONFLICT", "Subscription workspace changed while opening.");
      this.paths.set(root, after);
    } catch (error) {
      connection?.close();
      if (error instanceof CoreError) throw error;
      failure("NOT_AVAILABLE", "Isolated subscription workspace is not available.");
    }
    try {
      const marker = this.json([".pkm-next-workspace"]);
      if (!marker || typeof marker !== "object" || !("schema" in marker) || marker.schema !== "pkm.next-workspace/v2")
        failure("INVALID_WORKSPACE", "Subscription reads require an initialized isolated v2 workspace.");
    } catch (error) { this.refreshConnection.close(); throw error; }
  }
  json(parts: string[]): unknown | undefined {
    if (parts.some(part => !part || part === "." || part === ".." || /[/\\\0]/.test(part))) {
      failure("INVALID_DATA", "Unsafe persisted subscription identifier.");
    }
    const path = join(this.root, ...parts);
    if (this.contents.has(path)) return this.decode(this.contents.get(path));
    if (this.contents.size >= SUBSCRIPTION_READ_LIMITS.files) failure("LIMIT_EXCEEDED", "Subscription snapshot file limit exceeded.");
    if (this.native && parts.length === 2 && parts[0] === "subscriptions" && parts[1] === "subscriber-stats.json") {
      this.contents.set(path, undefined);
      return undefined;
    }
    if (this.refresh && parts[0] === "subscriptions"
      && (parts.length === 2 && parts[1] === "subscriptions.json" || parts[1] === "cache")) {
      const bytes = parts[1] === "subscriptions.json" ? Buffer.from(JSON.stringify(this.refresh.state))
        : this.refresh.files.find(file => file.path === parts.slice(1).join("/"))?.bytes;
      if (bytes && bytes.length > SUBSCRIPTION_READ_LIMITS.fileBytes) failure("LIMIT_EXCEEDED", "Subscription file byte limit exceeded.");
      this.bytes += bytes?.length ?? 0;
      if (this.bytes > SUBSCRIPTION_READ_LIMITS.snapshotBytes) failure("LIMIT_EXCEEDED", "Subscription snapshot byte limit exceeded.");
      this.contents.set(path, bytes);
      return this.decode(bytes);
    }
    try {
      for (let index = 1; index < parts.length; index++) {
        const directory = join(this.root, ...parts.slice(0, index));
        const stat = lstatSync(directory, { bigint: true });
        if (stat.isSymbolicLink() || !stat.isDirectory()) failure("INVALID_DATA", "Subscription directories must not be symlinks or special files.");
        const previous = this.paths.get(directory);
        if (previous && !same(previous, stat)) failure("REVISION_CONFLICT", "Subscription snapshot changed during reading.");
        this.paths.set(directory, stat);
      }
      const stat = lstatSync(path, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) {
        failure("INVALID_DATA", "Subscription metadata must be regular unlinked files, not links or special files.");
      }
      if (stat.size > BigInt(SUBSCRIPTION_READ_LIMITS.fileBytes)) failure("LIMIT_EXCEEDED", "Subscription file byte limit exceeded.");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes: Buffer;
      try {
        if (!same(stat, fstatSync(fd, { bigint: true }))) failure("REVISION_CONFLICT", "Subscription file changed before reading.");
        bytes = Buffer.alloc(Number(stat.size) + 1);
        let length = 0;
        while (length < bytes.length) {
          const count = readSync(fd, bytes, length, bytes.length - length, null);
          if (!count) break;
          length += count;
        }
        if (length !== Number(stat.size) || !same(stat, fstatSync(fd, { bigint: true }))) {
          failure("REVISION_CONFLICT", "Subscription file changed during reading.");
        }
        bytes = bytes.subarray(0, length);
      } finally { closeSync(fd); }
      this.bytes += bytes.length;
      if (this.bytes > SUBSCRIPTION_READ_LIMITS.snapshotBytes) failure("LIMIT_EXCEEDED", "Subscription snapshot byte limit exceeded.");
      this.paths.set(path, stat);
      this.contents.set(path, bytes);
      return this.decode(bytes);
    } catch (error) {
      if (missing(error)) {
        // Pin every missing ancestor as well as the leaf, so absence cannot race a later file.
        for (let index = 1; index <= parts.length; index++) {
          const candidate = join(this.root, ...parts.slice(0, index));
          if (!this.paths.has(candidate)) this.paths.set(candidate, undefined);
        }
        this.contents.set(path, undefined);
        return undefined;
      }
      if (error instanceof CoreError) throw error;
      failure("INVALID_DATA", "Subscription metadata could not be read safely.");
    }
  }
  private decode(bytes: Buffer | undefined): unknown | undefined {
    if (!bytes) return undefined;
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { failure("INVALID_DATA", "Subscription metadata is not valid UTF-8 JSON."); }
  }
  finish(): string {
    if (((this.native ? this.native() : this.refreshConnection.read())?.head ?? null) !== (this.refresh?.head ?? null))
      failure("REVISION_CONFLICT", "Subscription refresh changed during reading.");
    for (const [path, before] of this.paths) {
      let after: BigIntStats | undefined;
      try { after = lstatSync(path, { bigint: true }); }
      catch (error) { if (!missing(error)) failure("INVALID_DATA", "Subscription snapshot could not be verified."); }
      if (before ? !after || !same(before, after) : after !== undefined) {
        failure("REVISION_CONFLICT", "Subscription snapshot changed; retry from the first page.");
      }
    }
    const digest = createHash("sha256").update("pkm.subscription-snapshot/v1\0");
    for (const [path, bytes] of [...this.contents].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
      const relative = path.slice(this.root.length + 1);
      digest.update(JSON.stringify([relative, bytes ? createHash("sha256").update(bytes).digest("hex") : null]));
    }
    return digest.digest("hex");
  }
  close(): void { this.refreshConnection.close(); }
}

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) failure("INVALID_DATA", `Duplicate persisted subscription ${label}.`);
}

/** Reads only explicit isolated copies of the original globalStorage/subscriptions layout. */
export async function readSubscriptions(root: string, request: SubscriptionReadRequest, native?: () => RefreshView): Promise<unknown> {
  const definition = [...subscriptionReadDefinitions, ...subscriptionBrokerDefinitions].find(item => item.id === request.operation);
  if (!definition) failure("UNKNOWN_OPERATION", "Unknown subscription read operation.");
  if (typeof request.actorId !== "string" || !request.actorId || request.actorId.length > 256) {
    failure("FORBIDDEN", "A trusted actorId is required for subscription reads.");
  }
  const parsedArgs = definition.input.safeParse(request.args);
  if (!parsedArgs.success) failure("INVALID_INPUT", "Invalid subscription read arguments.");
  const args = parsedArgs.data;
  const snapshot = new Snapshot(resolve(root), native);
  try {
  const rawState = snapshot.json(["subscriptions", "subscriptions.json"]);
  const rawStats = snapshot.json(["subscriptions", "subscriber-stats.json"]);
  if (rawState === undefined && rawStats !== undefined) failure("INVALID_DATA", "Subscription statistics have no persisted state.");
  const state = rawState === undefined
    ? { schema: 1 as const, nodeId: "", shares: [], subscriptions: [] }
    : parse(stateSchema, rawState, "state");
  const stats: z.infer<typeof statsSchema> = rawStats === undefined
    ? { schema: 1, automaticBlocks: {} } : parse(statsSchema, rawStats, "statistics");
  unique(state.subscriptions.map(item => item.id), "ids");
  unique(state.shares.map(item => item.shareId), "share ids");
  if (request.operation === "subscription.broker.share-markers" && "type" in args && "items" in args) {
    const rawShares = rawState === undefined ? [] : (rawState as { shares: unknown[] }).shares;
    const shares = parse(z.array(markerShare).max(SUBSCRIPTION_READ_LIMITS.records), rawShares, "share markers");
    const items = args.items.map(item => ({
      id: sharedContentIdentity(args.type, item), folder: sharedContentFolder(args.type, item).replace(/\\/g, "/"),
    }));
    if (items.some(item => item.id.length > 2048 || item.folder.length > 2048))
      failure("INVALID_INPUT", "Subscription marker identity or folder is too long.");
    const depth = (folder: string) => folder.split("/").filter(Boolean).length;
    let work = 0, outputEstimate = 0;
    for (const share of shares) {
      if (!(share.contentTypes ?? []).includes(args.type)) continue;
      const folders = share.folders?.[args.type] ?? [];
      work += items.length * (folders.length + 1);
      for (const folder of folders) {
        work += depth(folder);
        outputEstimate += depth(folder) * (folder.length + share.name.length + share.shareId.length + 64);
      }
      for (const item of items) {
        work += depth(item.folder);
        outputEstimate += (depth(item.folder) + 1) * (item.folder.length + item.id.length + share.name.length + share.shareId.length + 64);
      }
      if (work > 1_000_000 || outputEstimate > 2 * 1024 * 1024)
        failure("LIMIT_EXCEEDED", "Subscription marker projection exceeds local safety limits.");
    }
    const revision = snapshot.finish();
    if (args.expectedRevision !== undefined && args.expectedRevision !== revision) {
      failure("REVISION_CONFLICT", "Subscription snapshot changed; retry from the first page.");
    }
    const result = { revision, ...brokerShareMarkers(args.type, args.items, shares) };
    if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) failure("LIMIT_EXCEEDED", "Subscription marker output limit exceeded.");
    return definition.output.parse(result);
  }
  if (Object.keys(stats.automaticBlocks).length > SUBSCRIPTION_READ_LIMITS.records
    || Object.values(stats.automaticBlocks).some(value => Object.keys(value).length > SUBSCRIPTION_READ_LIMITS.rules)) {
    failure("LIMIT_EXCEEDED", "Subscription automatic block count exceeded.");
  }
  const items = state.subscriptions.map(value => {
    let brokerName = value.brokerName || "";
    if (!brokerName) {
      const cached = snapshot.json(["subscriptions", "cache", value.nodeId, value.shareId, "summary.json"]);
      if (cached !== undefined) brokerName = (parse(cacheSummary, cached, "cached summary").name || "").trim();
    }
    return parse(subscriptionMetadata, {
      id: value.id, alias: value.alias, priority: subscriptionPriority(value.priority), brokerName,
      nodeId: value.nodeId, publisher: value.publisher, publisherUser: value.publisherUser,
      publisherHost: value.publisherHost, shareId: value.shareId, revision: value.revision,
      collectionHash: value.collectionHash, topics: value.topics, tags: value.tags, counts: value.counts,
      itemCount: value.itemCount, status: value.status,
      ...(value.lastChecked === undefined ? {} : { lastChecked: value.lastChecked }),
      ...(value.lastUpdated === undefined ? {} : { lastUpdated: value.lastUpdated }),
    }, "projection");
  });
  const revision = snapshot.finish();
  if (args.expectedRevision !== undefined && args.expectedRevision !== revision) {
    failure("REVISION_CONFLICT", "Subscription snapshot changed; retry from the first page.");
  }
  if (request.operation === "subscription.list" && "offset" in args) {
    const page = items.slice(args.offset, args.offset + args.limit);
    return definition.output.parse({
      revision, total: items.length, items: page,
      nextOffset: args.offset + page.length < items.length ? args.offset + page.length : null,
    });
  }
  if (request.operation === "subscription.get" && "id" in args) {
    const subscription = items.find(item => item.id === args.id);
    if (!subscription) failure("NOT_FOUND", "Subscription does not exist in this isolated snapshot.");
    return definition.output.parse({ revision, subscription });
  }
  if ("shareId" in args) {
    if (rawState === undefined) failure("NOT_AVAILABLE", "No original broker policy snapshot is available.");
    const selected = state.shares.find(item => item.shareId === args.shareId && item.published !== false);
    if (!selected) failure("NOT_FOUND", "Published broker policy does not exist in this isolated snapshot.");
    const policy = persistedBrokerAclPolicy({
      ...selected, ipRules: selected.ipRules || selected.blockedIps,
    }, stats);
    const accounts = policy.accountMode === "white-list" ? policy.accountRules.length : 1;
    const networks = policy.networkMode === "white-list" ? policy.ipRules.length : 1;
    if (accounts * networks * 5 > SUBSCRIPTION_READ_LIMITS.policyEntries) {
      failure("LIMIT_EXCEEDED", "Subscription policy expansion limit exceeded.");
    }
    const allowed = await (await BrokerAcl.create(policy)).enforce({
      accountId: request.actorId, sourceIp: args.sourceIp, shareId: args.shareId, action: args.action,
    });
    snapshot.finish();
    // The local policy simulation never verifies remote identity proofs or protected-share secrets.
    return definition.output.parse({
      revision, shareId: args.shareId, actorId: request.actorId, action: args.action,
      sourceIp: normalizeClientIp(args.sourceIp), allowed, policy, evaluationOnly: true,
    });
  }
  failure("UNKNOWN_OPERATION", "Unknown subscription read operation.");
  } finally { snapshot.close(); }
}
