import * as fs from "fs";
import * as path from "path";
import { createCipheriv, createHash, createHmac, generateKeyPairSync, randomBytes, scryptSync, sign, verify } from "crypto";
import { fork, spawn } from "child_process";
import { hostname } from "os";
import { Readable, Transform, TransformCallback } from "stream";
import { pipeline } from "stream/promises";
import { connect, MqttClient } from "./subscription-mqtt-client";
import { buildSyncBundle, emptySyncSelection, SyncSelection } from "./sync-server";
import { normalizeClientIp, normalizeIpBlockRules } from "./subscription-ip-policy";
import { serverExport } from "./servers";
import { isContentItemPrivate } from "./content-privacy";
import { ChatRoomLock } from "./chat-room-lock";
import { withCrossProcessLock, withCrossProcessLockSync } from "./cross-process-lock";
import { stableUserPort } from "./user-service-ports";

export type SharedContentType = "skills" | "notes" | "papers" | "prompts" | "scripts" | "packages" | "servers";
export const SHARED_CONTENT_TYPES: SharedContentType[] = ["skills", "notes", "papers", "prompts", "scripts", "packages", "servers"];

export interface ShareSummary {
  shareId: string;
  name: string;
  revision: number;
  collectionHash: string;
  updatedAt: string;
  counts: Record<string, number>;
  topics: string[];
  tags: string[];
  itemCount: number;
  snapshotBytes?: number;
  metadataOnly: true;
  secretProtected?: boolean;
  secretSalt?: string;
  signature: string;
}
export interface ShareDefinition {
  shareId: string;
  name: string;
  published?: boolean;
  visibility: "public" | "unlisted";
  revision: number;
  revisionDate: string;
  dailyRevision: number;
  revisionLabel: string;
  contentTypes: SharedContentType[];
  selected: SyncSelection;
  folders: Partial<Record<SharedContentType, string[]>>;
  accessMode: "block-list" | "white-list";
  ipRules: string[];
  accountMode: "open" | "block-list" | "white-list";
  accountRules: string[];
  protection: "open" | "secret-protected";
  controlPort: number;
  dataPort: number;
  secretSalt?: string;
  authVerifier?: string;
  contentHash: string;
  summary: ShareSummary;
  snapshotPath: string;
}
export interface SubscriptionRecord {
  id: string;
  alias: string;
  brokerName?: string;
  nodeId: string;
  publisher: string;
  publisherUser: string;
  publisherHost: string;
  endpoint: string;
  shareId: string;
  publicKey: string;
  magicLink: string;
  revision: number;
  collectionHash: string;
  topics: string[];
  tags: string[];
  counts: Record<string, number>;
  itemCount: number;
  etag: string;
  secretProtected?: boolean;
  secretSalt?: string;
  lastChecked?: string;
  lastUpdated?: string;
  status: "new" | "current" | "updating" | "offline" | "error";
  error?: string;
}
export interface CachedSubscriptionGroup {
  subscriptionId: string;
  alias: string;
  publisher: string;
  nodeId: string;
  shareId: string;
  revision: number;
  syncedAt: string;
  items: { key: string; title: string; path: string; type: SharedContentType; pkmPath: string; packageName?: string }[];
}
export interface CachedForkSource {
  type: SharedContentType;
  brokerName: string;
  publisherUser: string;
  publisherHost: string;
  remotePath: string;
  content?: string;
  folder?: { path: string; files: { path: string; content: string }[] };
  package?: { name: string; files: { path: string; content: string }[] };
}
export interface SharedMarketEvents {
  onChanged?: () => void;
  onWarning?: (message: string) => void;
  onDiagnostic?: (event: Record<string, string | number | boolean>) => void;
}
export interface SubscriptionSecretStorage {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}
interface PersistedState {
  schema: 1;
  nodeId: string;
  displayName: string;
  port: number;
  bindHost: string;
  advertisedHost: string;
  publicKey: string;
  privateKey: string;
  enabled: boolean;
  gatewayPid?: number;
  shares: ShareDefinition[];
  subscriptions: SubscriptionRecord[];
}
interface MagicLinkPayload {
  protocol: "pkmshare:v1";
  publisher: string;
  publisherUser: string;
  publisherHost: string;
  nodeId: string;
  publicKey: string;
  endpoint: string;
  shareId: string;
  secretProtected?: boolean;
  issuedAt: string;
}
interface SubscriberProof {
  schema: 1;
  nodeId: string;
  name: string;
  publicKey: string;
  shareId: string;
  timestamp: number;
  nonce: string;
  signature: string;
}

function hash(value: Buffer | string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function deriveSecretKeys(secret: string, salt: string): { authVerifier: Buffer; contentKey: Buffer } {
  const base = scryptSync(secret, Buffer.from(salt, "base64url"), 32);
  return {
    authVerifier: createHmac("sha256", base).update("pkm-share-auth:v1").digest(),
    contentKey: createHmac("sha256", base).update("pkm-share-content:v1").digest(),
  };
}
function encryptSnapshot(plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.from(JSON.stringify({ v: 1, alg: "A256GCM", iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") }));
}
function unique(values: unknown[], limit = 100): string[] {
  return [...new Set(values.flatMap(value => Array.isArray(value) ? value : [value]).map(value => String(value || "").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right)).slice(0, limit);
}
function tagsOf(value: unknown): string[] {
  if (Array.isArray(value)) return unique(value, 50);
  if (typeof value === "string") { try { return tagsOf(JSON.parse(value)); } catch { return unique(value.split(","), 50); } }
  return [];
}
function normalizeEndpoint(value: string): string {
  const raw = value.trim().replace(/\/$/, "");
  const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  if (!/^https?:$/.test(url.protocol) || !url.hostname || !url.port) throw new Error("Share endpoint must include a valid HTTP(S) hostname and port.");
  url.pathname = ""; url.search = ""; url.hash = "";
  return url.toString().replace(/\/$/, "");
}
function protectedSecret(value: string, expectedPort?: number): { controlPort: number; salt: string; material: string } {
  const match = /^pkms:v1:(\d{4,5}):([A-Za-z0-9_-]{16,}):([A-Za-z0-9_-]{16,})$/.exec(value.trim());
  if (!match) throw new Error("Secret Protected Broker secret must use pkms:v1:<control-port>:<salt>:<secret> format.");
  const controlPort = Number(match[1]);
  if (controlPort < 1024 || controlPort > 65535 || expectedPort && controlPort !== expectedPort) throw new Error("Broker secret contains the wrong Control Port.");
  return { controlPort, salt: match[2], material: match[3] };
}
function protectedSecretCode(controlPort: number, salt: string, material: string): string { return `pkms:v1:${controlPort}:${salt}:${material}`; }
function nodeIdForPublicKey(publicKey: string): string { return hash(Buffer.from(publicKey)).slice("sha256:".length); }
function atomicWrite(filePath: string, content: string | Buffer, mode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, content, mode ? { mode } : undefined);
  fs.renameSync(temporary, filePath);
}
function safeRelativePath(...parts: unknown[]): string {
  const cleaned = parts.flatMap(part => String(part || "").replace(/\\/g, "/").split("/"))
    .map(part => part.trim().replace(/[<>:"|?*\u0000-\u001f]/g, "-")).filter(part => part && part !== "." && part !== "..");
  if (!cleaned.length) return "untitled";
  return cleaned.join("/");
}
export function subscribedContentPath(nodeId: string, shareId: string, type: SharedContentType, contentPath = ""): string {
  const suffix = String(contentPath || "").replace(/\\/g, "/").split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `pkm://subscriptions/${encodeURIComponent(nodeId)}/${encodeURIComponent(shareId)}/${type}${suffix ? `/${suffix}` : ""}`;
}

export function parseSubscribedContentPath(value: string): { nodeId: string; shareId: string; contentType: SharedContentType; path: string } {
  const url = new URL(value);
  if (url.protocol !== "pkm:" || url.hostname !== "subscriptions") throw new Error("Invalid subscribed content path.");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const [nodeId, shareId, contentType, ...contentParts] = parts;
  if (!nodeId || !shareId || !SHARED_CONTENT_TYPES.includes(contentType as SharedContentType)) throw new Error("Invalid subscribed content path.");
  return { nodeId, shareId, contentType: contentType as SharedContentType, path: contentParts.join("/") };
}
function withoutSignature<T extends { signature: string }>(value: T): Omit<T, "signature"> {
  const { signature: _signature, ...unsigned } = value;
  return unsigned;
}

function defaultAdvertisedHost(): string {
  return hostname().trim().replace(/\.$/, "") || "127.0.0.1";
}
function revisionDate(value = new Date().toISOString()): string {
  return String(value || "").slice(0, 10).replace(/-/g, "") || new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

const MAX_CACHED_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_CACHED_SEARCH_RESULTS = 200;
const MAX_SNAPSHOT_DOWNLOAD_BYTES = 512 * 1024 * 1024;

export class SharedMarketManager {
  private state: PersistedState;
  private mqttClients = new Map<string, MqttClient>();
  private pollTimer: NodeJS.Timeout | undefined;
  private healthTimer: NodeJS.Timeout | undefined;
  private backgroundElectionTimer: NodeJS.Timeout | undefined;
  private backgroundLock: ChatRoomLock | undefined;
  private gatewayStatus: "stopped" | "running" | "error" = "stopped";
  private gatewayError = "";
  private gatewayConfigurationId = "";
  private gatewayEnsure: Promise<void> | undefined;
  private warned = new Set<string>();
  private publishedRefresh: Promise<number> | undefined;
  private publishedRefreshAgain = false;
  private readonly publisherUser: string;
  private readonly publisherHost: string;
  private readonly gatewayRuntimeVersion: string;
  private stateMutationDepth = 0;
  private pendingMqttRefreshes = new Set<string>();

  constructor(private readonly storageDir: string, private readonly gatewayScript: string, displayName: string, private readonly events: SharedMarketEvents = {}, private readonly secrets?: SubscriptionSecretStorage, identity?: { user: string; host: string; version?: string }) {
    this.publisherUser = identity?.user.trim() || "";
    this.publisherHost = identity?.host.trim() || "";
    this.gatewayRuntimeVersion = identity?.version?.trim() || "dev";
    fs.mkdirSync(storageDir, { recursive: true });
    const statePath = this.statePath();
    let persisted: PersistedState | undefined;
    if (fs.existsSync(statePath)) {
      try {
        const candidate = JSON.parse(fs.readFileSync(statePath, "utf8")) as PersistedState;
        if (candidate?.schema !== 1 || !candidate.nodeId || !candidate.publicKey || !candidate.privateKey || !Array.isArray(candidate.shares)) {
          throw new Error("Subscription state schema is invalid.");
        }
        persisted = candidate;
      } catch {
        fs.renameSync(statePath, `${statePath}.corrupt-${Date.now()}-${process.pid}`);
      }
    }
    if (persisted) {
      this.state = persisted;
      this.state.bindHost = "0.0.0.0";
      if (!this.state.advertisedHost || this.state.advertisedHost === "127.0.0.1") this.state.advertisedHost = defaultAdvertisedHost();
      for (const share of this.state.shares || []) share.folders ||= {};
      for (const share of this.state.shares || []) {
        share.accessMode ||= "block-list";
        share.ipRules ||= (share as any).blockedIps || [];
        share.accountMode ||= "open";
        share.accountRules ||= [];
        delete (share as any).blockedIps;
        share.protection = (share.protection as string) === "encrypted" ? "secret-protected" : share.protection || "open";
        share.controlPort ||= 0;
        share.dataPort ||= 0;
        share.contentHash ||= "";
        share.revisionDate ||= revisionDate(share.summary?.updatedAt);
        share.dailyRevision = Math.max(1, Number(share.dailyRevision || 1));
        share.revisionLabel = `${share.revisionDate}.r${share.dailyRevision}`;
      }
      this.state.subscriptions ||= [];
      for (const record of this.state.subscriptions || []) record.brokerName ||= this.cachedBrokerName(record);
      this.save();
      this.prunePublishedSnapshots();
    }
    else {
      const keys = generateKeyPairSync("ed25519");
      const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
      this.state = {
        schema: 1, nodeId: nodeIdForPublicKey(publicKey), displayName, port: stableUserPort("subscriptionPort"), bindHost: "0.0.0.0", advertisedHost: defaultAdvertisedHost(),
        publicKey, privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), enabled: false,
        shares: [], subscriptions: [],
      };
      this.save();
    }
    this.pruneStaleDownloads();
  }

  get snapshot(): object {
    if (!this.stateMutationDepth) this.reloadPersistedState();
    return {
      nodeId: this.state.nodeId, displayName: this.state.displayName, port: this.state.port, advertisedHost: this.state.advertisedHost,
      enabled: this.state.enabled, gatewayStatus: this.gatewayStatus, gatewayError: this.gatewayError,
      shares: this.state.shares.map(share => ({ ...share, magicLink: this.magicLink(share.shareId), ...this.brokerTelemetry(share.shareId) })),
      subscriptions: this.state.subscriptions.map(record => ({ ...record, brokerName: record.brokerName || this.cachedBrokerName(record) })),
    };
  }

  private reloadPersistedState(): void {
    try {
      const latest = JSON.parse(fs.readFileSync(this.statePath(), "utf8")) as PersistedState;
      if (latest?.nodeId === this.state.nodeId) this.state = latest;
    } catch { /* retain the last complete atomic snapshot */ }
  }

  private async withStateMutation<T>(action: () => Promise<T>): Promise<T> {
    if (this.stateMutationDepth) return action();
    return withCrossProcessLock(path.join(this.storageDir, "subscriptions-state.lock"), "Subscription state mutation", 10 * 60_000, async () => {
      this.reloadPersistedState();
      this.stateMutationDepth++;
      try { return await action(); }
      finally {
        this.stateMutationDepth--;
        if (!this.stateMutationDepth && this.pendingMqttRefreshes.size) {
          const pending = [...this.pendingMqttRefreshes];
          this.pendingMqttRefreshes.clear();
          setImmediate(() => { for (const id of pending) void this.refresh(id).catch(() => {}); });
        }
      }
    });
  }

  private withStateMutationSync<T>(action: () => T): T {
    if (this.stateMutationDepth) return action();
    return withCrossProcessLockSync(path.join(this.storageDir, "subscriptions-state.lock"), "Subscription state mutation", () => {
      this.reloadPersistedState();
      this.stateMutationDepth++;
      try { return action(); }
      finally { this.stateMutationDepth--; }
    });
  }

  cachedGroups(type: SharedContentType, query = "", maxResults = MAX_CACHED_SEARCH_RESULTS): CachedSubscriptionGroup[] {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    let remaining = Math.max(1, maxResults);
    return this.state.subscriptions.flatMap(record => {
      if (remaining <= 0) return [];
      const root = path.join(this.storageDir, "cache", record.nodeId, record.shareId);
      const contentRoot = path.join(root, "content", type);
      if (!fs.existsSync(contentRoot)) return [];
      let cacheMetadata: any = {};
      try { cacheMetadata = JSON.parse(fs.readFileSync(path.join(root, "_subscription.json"), "utf8")); } catch { /* cache may predate provenance */ }
      const items: CachedSubscriptionGroup["items"] = [];
      const walk = (directory: string, relative: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (remaining <= 0) return;
          if (entry.name.endsWith(".pkm-source.json")) continue;
          const rel = relative ? `${relative}/${entry.name}` : entry.name;
          const full = path.join(directory, entry.name);
          if (entry.isDirectory()) { walk(full, rel); continue; }
          if (!entry.isFile()) continue;
          const label = path.basename(entry.name, path.extname(entry.name));
          if (normalizedQuery) {
            const metadataMatches = [record.alias, record.publisher, rel, label]
              .some(value => String(value || "").toLocaleLowerCase().includes(normalizedQuery));
            if (!metadataMatches) {
              let contentMatches = false;
              try {
                if (fs.statSync(full).size <= MAX_CACHED_SEARCH_FILE_BYTES) {
                  contentMatches = fs.readFileSync(full, "utf8").toLocaleLowerCase().includes(normalizedQuery);
                }
              } catch { /* binary, large, or unreadable entries are metadata-searchable only */ }
              if (!contentMatches) continue;
            }
          }
          const encoded = Buffer.from(JSON.stringify({ subscriptionId: record.id, type, path: rel })).toString("base64url");
          items.push({ key: encoded, title: label, path: rel, type, pkmPath: subscribedContentPath(record.nodeId, record.shareId, type, rel) });
          remaining -= 1;
        }
      };
      walk(contentRoot, "");
      if (type === "packages") {
        const packages = new Map<string, CachedSubscriptionGroup["items"][number]>();
        for (const item of items) {
          const packageName = item.path.split("/")[0];
          if (!packageName || packages.has(packageName)) continue;
          const representative = items.find(candidate => candidate.path.startsWith(`${packageName}/`) && /^readme(?:\.|$)/i.test(path.basename(candidate.path))) || item;
          packages.set(packageName, { ...representative, title: packageName, path: packageName, packageName });
        }
        items.splice(0, items.length, ...packages.values());
      }
      if (type === "servers") {
        const recipes: CachedSubscriptionGroup["items"] = [];
        for (const item of items) {
          const parts = item.path.split("/");
          if (parts.length !== 2 || parts[1] !== "server.link.json") continue;
          const recipePath = path.join(contentRoot, ...parts);
          let title = parts[0];
          try {
            const recipe = JSON.parse(fs.readFileSync(recipePath, "utf8"));
            title = String(recipe?.name || parts[0]).trim() || parts[0];
          } catch { /* retain the stable slug when cached metadata is malformed */ }
          recipes.push({ ...item, title });
        }
        items.splice(0, items.length, ...recipes);
      }
      if (!items.length) return [];
      return [{ subscriptionId: record.id, alias: record.alias || record.brokerName || this.cachedBrokerName(record) || record.publisher, publisher: record.publisher, nodeId: record.nodeId, shareId: record.shareId, revision: record.revision, syncedAt: cacheMetadata.syncedAt || record.lastUpdated || "", items }];
    });
  }

  cachedDetail(key: string): { type: "subscription"; contentType: SharedContentType; title: string; path: string; content: string; provenance: any } {
    let decoded: { subscriptionId: string; type: SharedContentType; path: string };
    try { decoded = JSON.parse(Buffer.from(key, "base64url").toString("utf8")); }
    catch { throw new Error("Invalid subscribed item key."); }
    if (!SHARED_CONTENT_TYPES.includes(decoded.type)) throw new Error("Invalid subscribed content type.");
    const record = this.requireSubscription(decoded.subscriptionId);
    const root = path.resolve(this.storageDir, "cache", record.nodeId, record.shareId, "content", decoded.type);
    const target = path.resolve(root, ...safeRelativePath(decoded.path).split("/"));
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error("Subscribed item was not found.");
    const content = fs.readFileSync(target, "utf8");
    let provenance: any = {};
    try { provenance = JSON.parse(fs.readFileSync(`${target}.pkm-source.json`, "utf8")); } catch { /* older cache */ }
    provenance.brokerName ||= record.brokerName || this.cachedBrokerName(record) || record.alias || record.publisher;
    return { type: "subscription", contentType: decoded.type, title: path.basename(decoded.path, path.extname(decoded.path)), path: decoded.path, content, provenance };
  }

  cachedServerLinks(key: string): { name: string; links: { label: string; url: string }[] } {
    const detail = this.cachedDetail(key);
    if (detail.contentType !== "servers" || !detail.path.endsWith("/server.link.json")) throw new Error("Subscribed item is not a Server link.");
    let parsed: any;
    try { parsed = JSON.parse(detail.content); } catch { throw new Error("Subscribed Server link metadata is invalid."); }
    const links = [parsed?.url].flatMap((value: any) => {
      try {
        const url = new URL(String(value || ""));
        if (!/^https?:$/.test(url.protocol)) return [];
        return [{ label: "Broker Server Link", url: url.toString() }];
      } catch { return []; }
    });
    return { name: String(parsed?.name || detail.title), links };
  }

  forkSource(key: string): CachedForkSource {
    let decoded: { subscriptionId: string; type: SharedContentType; path: string };
    try { decoded = JSON.parse(Buffer.from(key, "base64url").toString("utf8")); }
    catch { throw new Error("Invalid subscribed item key."); }
    const record = this.requireSubscription(decoded.subscriptionId);
    const brokerName = record.brokerName || this.cachedBrokerName(record) || record.alias || record.publisher || record.shareId;
    if (decoded.type === "packages") {
      const packageName = safeRelativePath(decoded.path).split("/")[0];
      const bundlePath = path.join(this.storageDir, "cache", record.nodeId, record.shareId, "bundle.json");
      const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
      const pkg = (bundle.packages || []).find((item: any) => String(item.name || "") === packageName);
      if (!pkg) throw new Error(`Subscribed package was not found: ${packageName}`);
      return { type: "packages", brokerName, publisherUser: record.publisherUser!, publisherHost: record.publisherHost!, remotePath: packageName, package: { name: packageName, files: (pkg.files || []).map((file: any) => ({ path: safeRelativePath(file.path), content: String(file.content || "") })) } };
    }
    if (!(["skills", "notes", "papers", "prompts", "scripts"] as SharedContentType[]).includes(decoded.type)) throw new Error(`Fork is not supported for ${decoded.type}.`);
    const detail = this.cachedDetail(key);
    return { type: decoded.type, brokerName, publisherUser: record.publisherUser!, publisherHost: record.publisherHost!, remotePath: safeRelativePath(detail.path), content: detail.content };
  }

  forkFolderSource(keys: string[], remotePath: string): CachedForkSource {
    if (!keys.length) throw new Error("Subscribed folder is empty.");
    const decoded = keys.map(key => {
      try { return JSON.parse(Buffer.from(key, "base64url").toString("utf8")) as { subscriptionId: string; type: SharedContentType; path: string }; }
      catch { throw new Error("Invalid subscribed item key."); }
    });
    const first = decoded[0];
    if (!("skills notes papers prompts scripts".split(" ") as SharedContentType[]).includes(first.type)) throw new Error(`Folder Fork is not supported for ${first.type}.`);
    if (decoded.some(item => item.subscriptionId !== first.subscriptionId || item.type !== first.type)) throw new Error("Subscribed folder items must come from one Broker and content type.");
    const sources = keys.map(key => this.forkSource(key));
    const wholeCollection = !remotePath.trim();
    const folderPath = wholeCollection ? "" : safeRelativePath(remotePath);
    const prefix = folderPath ? `${folderPath}/` : "";
    if (prefix && sources.some(source => !source.remotePath.startsWith(prefix))) throw new Error("Subscribed item is outside the selected folder.");
    return {
      type: first.type,
      brokerName: sources[0].brokerName,
      publisherUser: sources[0].publisherUser,
      publisherHost: sources[0].publisherHost,
      remotePath: folderPath,
      folder: { path: folderPath, files: sources.map(source => ({ path: prefix ? source.remotePath.slice(prefix.length) : source.remotePath, content: source.content || "" })) },
    };
  }

  async configure(config: { enabled: boolean; port: number; advertisedHost: string; displayName: string }): Promise<void> {
    if (!this.stateMutationDepth) return this.withStateMutation(() => this.configure(config));
    const port = Number(config.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Subscription port must be between 1024 and 65535.");
    const portChanged = this.state.port !== port;
    if (this.state.enabled && portChanged) await this.stopGateway();
    this.state.enabled = !!config.enabled;
    this.state.port = port;
    this.state.bindHost = "0.0.0.0";
    this.state.advertisedHost = config.advertisedHost.trim() || defaultAdvertisedHost();
    this.state.displayName = config.displayName.trim() || this.state.displayName;
    this.save();
    if (this.state.enabled) await this.ensureGateway();
    else await this.stopGateway();
    this.changed();
  }

  async setGatewayOnline(online: boolean): Promise<void> {
    if (!this.stateMutationDepth) return this.withStateMutation(() => this.setGatewayOnline(online));
    this.state.enabled = online;
    this.save();
    if (online) await this.ensureGateway();
    else await this.stopGateway();
    this.changed();
  }

  async upsertShare(input: { shareId?: string; name: string; visibility?: "public" | "unlisted"; contentTypes: SharedContentType[]; selected?: Partial<SyncSelection>; folders?: Partial<Record<SharedContentType, string[]>>; accessMode?: "block-list" | "white-list"; ipRules?: string[]; accountMode?: "open" | "block-list" | "white-list"; accountRules?: string[]; protection?: "open" | "secret-protected"; secret?: string; controlPort?: number; dataPort?: number }): Promise<ShareDefinition> {
    if (!this.stateMutationDepth) return this.withStateMutation(() => this.upsertShare(input));
    const operationStartedAt = Date.now(), memoryBefore = process.memoryUsage();
    const name = input.name.trim();
    if (!name) throw new Error("Share name is required.");
    const contentTypes = input.contentTypes.filter(type => SHARED_CONTENT_TYPES.includes(type));
    if (!contentTypes.length) throw new Error("Select at least one content type.");
    const existing = input.shareId ? this.state.shares.find(share => share.shareId === input.shareId) : undefined;
    const shareId = existing?.shareId || randomBytes(16).toString("base64url");
    const selected = { ...emptySyncSelection(), ...(input.selected || {}) } as SyncSelection;
    const folders = Object.fromEntries(Object.entries(input.folders || {}).map(([type, values]) => [type, unique(Array.isArray(values) ? values : [], 500)])) as Partial<Record<SharedContentType, string[]>>;
    const accessMode = input.accessMode === "white-list" ? "white-list" : "block-list";
    const ipRules = normalizeIpBlockRules(input.ipRules || []);
    const accountMode = input.accountMode === "white-list" ? "white-list" : input.accountMode === "block-list" ? "block-list" : "open";
    const accountRules = unique(input.accountRules || [], 1000).filter(nodeId => /^[a-f0-9]{64}$/i.test(nodeId));
    if (accountRules.length !== unique(input.accountRules || [], 1000).length) throw new Error("Account access rules must use stable 64-character Subscriber node IDs.");
    const bundle = this.buildShareBundle(contentTypes, selected, folders);
    const plaintext = Buffer.from(JSON.stringify(bundle));
    const protection = input.protection === "secret-protected" ? "secret-protected" : "open";
    const controlPort = protection === "secret-protected" ? Number(input.controlPort || existing?.controlPort || 0) : this.state.port;
    if (!Number.isInteger(controlPort) || controlPort < 1024 || controlPort > 65535) throw new Error("Secret Protected Broker requires a Control Port between 1024 and 65535.");
    if (protection === "secret-protected" && controlPort === this.state.port) throw new Error("Secret Protected Broker Control Port must differ from the shared Open Broker Control Port.");
    const dataPort = Number(input.dataPort || 0);
    if (!Number.isInteger(dataPort) || dataPort < 0 || dataPort > 65535 || dataPort > 0 && dataPort < 1024) throw new Error("Broker Data Port must be 0 (random) or between 1024 and 65535.");
    if (dataPort === this.state.port) throw new Error("Broker Data Port must differ from the Common Communication Port.");
    if (dataPort > 0 && dataPort === controlPort) throw new Error("Broker Data Port must differ from its Control Port.");
    const secretSalt = protection === "secret-protected" ? (existing?.secretSalt || randomBytes(16).toString("base64url")) : undefined;
    const secretKey = this.publisherSecretKey(shareId);
    const storedSecret = await this.secrets?.get(secretKey) || "";
    const suppliedSecret = input.secret?.trim() || "";
    const secretMaterial = protection === "secret-protected"
      ? (suppliedSecret ? (suppliedSecret.startsWith("pkms:v1:") ? protectedSecret(suppliedSecret, controlPort).material : suppliedSecret) : storedSecret)
      : "";
    if (protection === "secret-protected" && !secretMaterial) throw new Error("Secret Protected Broker requires an additional secret.");
    const keys = protection === "secret-protected" ? deriveSecretKeys(secretMaterial, secretSalt!) : undefined;
    const snapshot = keys ? encryptSnapshot(plaintext, keys.contentKey) : plaintext;
    if (protection === "secret-protected") await this.secrets?.store(secretKey, secretMaterial);
    else await this.secrets?.delete(secretKey);
    const unchanged = existing && existing.name === name && existing.visibility === (input.visibility || existing.visibility) &&
      existing.contentHash === hash(plaintext) && existing.authVerifier === keys?.authVerifier.toString("base64url") && existing.protection === protection && existing.controlPort === controlPort && existing.dataPort === dataPort && existing.accessMode === accessMode && existing.accountMode === accountMode && JSON.stringify(existing.selected) === JSON.stringify(selected) && JSON.stringify(existing.folders || {}) === JSON.stringify(folders) && JSON.stringify(existing.ipRules || []) === JSON.stringify(ipRules) && JSON.stringify(existing.accountRules || []) === JSON.stringify(accountRules);
    if (unchanged) return existing;
    const snapshotPath = path.join(this.storageDir, "snapshots", `${shareId}-${(existing?.revision || 0) + 1}.json`);
    atomicWrite(snapshotPath, snapshot, 0o600);
    const revision = (existing?.revision || 0) + 1;
    const summary = this.buildSummary(shareId, name, revision, snapshot, bundle, protection === "secret-protected", secretSalt);
    const nextRevisionDate = revisionDate(summary.updatedAt);
    const dailyRevision = existing?.revisionDate === nextRevisionDate ? Math.max(1, Number(existing.dailyRevision || 1)) + 1 : 1;
    const revisionLabel = `${nextRevisionDate}.r${dailyRevision}`;
    const definition: ShareDefinition = { shareId, name, published: existing?.published !== false, visibility: input.visibility || existing?.visibility || "public", revision, revisionDate: nextRevisionDate, dailyRevision, revisionLabel, contentTypes, selected, folders, accessMode, ipRules, accountMode, accountRules, protection, controlPort, dataPort, secretSalt, authVerifier: keys?.authVerifier.toString("base64url"), contentHash: hash(plaintext), summary, snapshotPath };
    this.state.shares = [...this.state.shares.filter(share => share.shareId !== shareId), definition];
    this.save();
    await this.reloadGatewayConfiguration(this.state.port, this.gatewayConfigurationId);
    this.prunePublishedSnapshots(shareId);
    this.operationDiagnostic("publish", operationStartedAt, memoryBefore, { shareId, revision, snapshotBytes: snapshot.length, itemCount: summary.itemCount });
    this.changed();
    return definition;
  }

  async refreshPublishedShares(): Promise<number> {
    if (!this.stateMutationDepth) return this.withStateMutation(() => this.refreshPublishedShares());
    if (this.publishedRefresh) {
      this.publishedRefreshAgain = true;
      return this.publishedRefresh;
    }
    const refresh = this.refreshPublishedSharesUntilCurrent();
    this.publishedRefresh = refresh;
    try { return await refresh; }
    finally { if (this.publishedRefresh === refresh) this.publishedRefresh = undefined; }
  }

  private async refreshPublishedSharesUntilCurrent(): Promise<number> {
    let changed = 0;
    do {
      this.publishedRefreshAgain = false;
      for (const share of [...this.state.shares]) {
        if (share.protection === "secret-protected" && !await this.secrets?.get(this.publisherSecretKey(share.shareId))) {
          this.warning(`protected-secret:${share.shareId}`, `Secret Protected Broker "${share.name}" was not rebuilt because its secret is unavailable. Its existing snapshot remains unchanged; rotate the secret to resume automatic publication.`);
          continue;
        }
        const refreshed = await this.upsertShare({ shareId: share.shareId, name: share.name, visibility: share.visibility, contentTypes: share.contentTypes, selected: share.selected, folders: share.folders || {}, accessMode: share.accessMode, ipRules: share.ipRules || [], accountMode: share.accountMode, accountRules: share.accountRules || [], protection: share.protection, controlPort: share.controlPort, dataPort: share.dataPort });
        if (refreshed.revision !== share.revision) changed += 1;
      }
    } while (this.publishedRefreshAgain);
    return changed;
  }

  async deleteShare(shareId: string): Promise<void> {
    if (!this.stateMutationDepth) return this.withStateMutation(() => this.deleteShare(shareId));
    const share = this.state.shares.find(item => item.shareId === shareId);
    if (!share) return;
    this.state.shares = this.state.shares.filter(item => item.shareId !== shareId);
    await this.secrets?.delete(this.publisherSecretKey(shareId));
    const snapshotsDir = path.join(this.storageDir, "snapshots");
    if (fs.existsSync(snapshotsDir)) {
      for (const name of fs.readdirSync(snapshotsDir)) if (name.startsWith(`${shareId}-`) && name.endsWith(".json")) fs.rmSync(path.join(snapshotsDir, name), { force: true });
    }
    try {
      const stats = JSON.parse(fs.readFileSync(this.subscriberStatsPath(), "utf8"));
      if (stats?.shares) delete stats.shares[shareId];
      if (Array.isArray(stats?.securityEvents)) stats.securityEvents = stats.securityEvents.filter((event: any) => event.shareId !== shareId);
      atomicWrite(this.subscriberStatsPath(), JSON.stringify(stats, null, 2), 0o600);
    } catch { /* no telemetry has been written yet */ }
    this.save();
    await this.reloadGatewayConfiguration(this.state.port, this.gatewayConfigurationId);
    this.changed();
  }

  async setSharePublished(shareId: string, published: boolean): Promise<ShareDefinition> {
    if (!this.stateMutationDepth) return this.withStateMutation(() => this.setSharePublished(shareId, published));
    const share = this.state.shares.find(item => item.shareId === shareId);
    if (!share) throw new Error("Broker not found.");
    if ((share.published !== false) === published) return share;
    share.published = published;
    this.save();
    await this.reloadGatewayConfiguration(this.state.port, this.gatewayConfigurationId);
    this.changed();
    return share;
  }

  async rotateShareSecret(shareId: string, controlPort?: number): Promise<{ share: ShareDefinition; secret: string }> {
    if (!this.stateMutationDepth) return this.withStateMutation(() => this.rotateShareSecret(shareId, controlPort));
    const share = this.state.shares.find(item => item.shareId === shareId);
    if (!share) throw new Error("Share Broker was not found.");
    if (share.protection !== "secret-protected") throw new Error("Only Secret Protected Brokers have a rotatable secret.");
    const nextPort = Number(controlPort || share.controlPort);
    const material = randomBytes(24).toString("base64url");
    share.secretSalt = randomBytes(16).toString("base64url");
    const secret = protectedSecretCode(nextPort, share.secretSalt, material);
    const updated = await this.upsertShare({ shareId, name: share.name, visibility: share.visibility, contentTypes: share.contentTypes, selected: share.selected, folders: share.folders, accessMode: share.accessMode, ipRules: share.ipRules, accountMode: share.accountMode, accountRules: share.accountRules, protection: share.protection, secret, controlPort: nextPort, dataPort: share.dataPort });
    await this.reloadGatewayConfiguration(nextPort, this.gatewayConfigurationId);
    return { share: updated, secret };
  }

  async shareSecret(shareId: string): Promise<string> {
    const share = this.state.shares.find(item => item.shareId === shareId);
    if (!share || share.protection !== "secret-protected") throw new Error("Secret Protected Broker was not found.");
    const material = await this.secrets?.get(this.publisherSecretKey(shareId));
    if (!material) throw new Error("Broker secret is unavailable. Rotate it to create a new secret.");
    return protectedSecretCode(share.controlPort, share.secretSalt!, material);
  }

  async unblockIp(shareId: string, ip: string): Promise<void> {
    const normalized = normalizeClientIp(ip);
    try {
      const stats = JSON.parse(fs.readFileSync(this.subscriberStatsPath(), "utf8"));
      if (stats?.automaticBlocks?.[shareId]) delete stats.automaticBlocks[shareId][normalized];
      if (stats?.secretFailures?.[shareId]) delete stats.secretFailures[shareId][normalized];
      atomicWrite(this.subscriberStatsPath(), JSON.stringify(stats, null, 2), 0o600);
      await this.reloadGatewayConfiguration(this.state.port, this.gatewayConfigurationId);
      this.changed();
    } catch { /* no automatic block state */ }
  }

  magicLink(shareId: string): string {
    const share = this.state.shares.find(item => item.shareId === shareId);
    if (!share) throw new Error("Share was not found.");
    if (!this.publisherUser || !this.publisherHost) throw new Error("Publisher user and hostname identity are required.");
    const host = this.state.advertisedHost || "127.0.0.1";
    const payload: MagicLinkPayload = {
      protocol: "pkmshare:v1", publisher: this.state.displayName, publisherUser: this.publisherUser, publisherHost: this.publisherHost, nodeId: this.state.nodeId, publicKey: this.state.publicKey,
      endpoint: share.protection === "secret-protected" ? `http://${host}` : `http://${host}:${this.state.port}`,
      shareId, secretProtected: share.protection === "secret-protected", issuedAt: new Date().toISOString(),
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = sign(null, Buffer.from(encoded), this.state.privateKey).toString("base64url");
    return `pkmshare:v1:${encoded}.${signature}`;
  }

  async subscribe(magicLink: string, alias = "", secret = ""): Promise<SubscriptionRecord> {
    if (!this.stateMutationDepth) return this.withStateMutation(() => this.subscribe(magicLink, alias, secret));
    const payload = parseShareMagicLink(magicLink);
    let endpoint = payload.endpoint;
    let secretMaterial = "";
    if (payload.secretProtected) {
      const parsedSecret = protectedSecret(secret);
      secretMaterial = parsedSecret.material;
      const url = new URL(endpoint);
      url.port = String(parsedSecret.controlPort);
      endpoint = normalizeEndpoint(url.toString());
    } else endpoint = normalizeEndpoint(endpoint);
    const existing = this.state.subscriptions.find(item => item.nodeId === payload.nodeId && item.shareId === payload.shareId);
    const record: SubscriptionRecord = existing || {
      id: randomBytes(12).toString("base64url"), alias: "", nodeId: payload.nodeId, publisher: payload.publisher,
      publisherUser: payload.publisherUser, publisherHost: payload.publisherHost,
      endpoint, shareId: payload.shareId, publicKey: payload.publicKey, magicLink, revision: 0, collectionHash: "",
      topics: [], tags: [], counts: {}, itemCount: 0, etag: "", status: "new",
    };
    record.alias = alias.trim() || record.alias;
    record.endpoint = endpoint; record.magicLink = magicLink; record.publicKey = payload.publicKey; record.publisher = payload.publisher;
    record.publisherUser = payload.publisherUser; record.publisherHost = payload.publisherHost;
    record.secretProtected = !!payload.secretProtected;
    if (payload.secretProtected) record.secretSalt = protectedSecret(secret).salt;
    if (secretMaterial) await this.secrets?.store(this.subscriberSecretKey(payload.nodeId, payload.shareId), secretMaterial);
    if (!existing) this.state.subscriptions.push(record);
    this.save();
    await this.refresh(record.id, true);
    this.connectMqtt(record);
    return record;
  }

  renameSubscription(id: string, alias: string): void {
    if (!this.stateMutationDepth) return this.withStateMutationSync(() => this.renameSubscription(id, alias));
    const record = this.requireSubscription(id);
    record.alias = alias.trim();
    const metadataPath = path.join(this.storageDir, "cache", record.nodeId, record.shareId, "_subscription.json");
    if (fs.existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
        metadata.alias = record.alias;
        atomicWrite(metadataPath, JSON.stringify(metadata, null, 2), 0o600);
      } catch { /* the next refresh rebuilds metadata */ }
    }
    this.save();
    this.changed();
  }

  removeSubscription(id: string): void {
    if (!this.stateMutationDepth) return this.withStateMutationSync(() => this.removeSubscription(id));
    const record = this.requireSubscription(id);
    this.state.subscriptions = this.state.subscriptions.filter(item => item.id !== id);
    fs.rmSync(path.join(this.storageDir, "cache", record.nodeId, record.shareId), { recursive: true, force: true });
    void this.secrets?.delete(this.subscriberSecretKey(record.nodeId, record.shareId));
    if (!this.state.subscriptions.some(item => item.nodeId === record.nodeId)) { this.mqttClients.get(record.nodeId)?.end(true); this.mqttClients.delete(record.nodeId); }
    this.save();
    this.changed();
  }

  async refresh(id: string, forceDownload = false): Promise<SubscriptionRecord> {
    if (!this.stateMutationDepth) return this.withStateMutation(() => this.refresh(id, forceDownload));
    const record = this.requireSubscription(id);
    const previousStatus = record.status;
    const previousError = record.error;
    record.status = "updating"; record.error = undefined; this.save();
    try {
      const identityProof = this.subscriberProof(record.shareId);
      const headers: Record<string, string> = { ...(record.etag && !forceDownload ? { "If-None-Match": record.etag } : {}), "X-PKM-Subscriber-Proof": identityProof };
      if (record.secretProtected) {
        const material = await this.secrets?.get(this.subscriberSecretKey(record.nodeId, record.shareId));
        if (!material || !record.secretSalt) throw new Error("Secret Protected Broker requires its additional secret.");
        const keys = deriveSecretKeys(material, record.secretSalt);
        headers["X-PKM-Share-Secret-Proof"] = createHmac("sha256", keys.authVerifier).update(identityProof).digest("base64url");
      }
      const response = await fetch(`${record.endpoint}/v1/shares/${encodeURIComponent(record.shareId)}/summary`, {
        headers, signal: AbortSignal.timeout(10_000),
      });
      record.lastChecked = new Date().toISOString();
      if (response.status === 304) {
        record.status = "current"; record.error = undefined; this.warned.delete(`remote:${record.id}`); this.save();
        if (previousStatus !== record.status || previousError) this.changed();
        return record;
      }
      if (!response.ok) throw new Error(`Broker returned ${response.status}.`);
      const summary = await response.json() as ShareSummary;
      verifyShareSummary(summary, record.publicKey, record.nodeId, record.shareId);
      record.brokerName = summary.name;
      if (!!summary.secretProtected !== !!record.secretProtected || summary.secretProtected && summary.secretSalt !== record.secretSalt) throw new Error("Broker secret does not match the published protected revision.");
      const changed = forceDownload || summary.revision !== record.revision || summary.collectionHash !== record.collectionHash;
      record.etag = response.headers.get("etag") || `"${summary.collectionHash}"`;
      record.topics = summary.topics; record.tags = summary.tags; record.counts = summary.counts; record.itemCount = summary.itemCount;
      if (changed) await this.downloadSnapshot(record, summary);
      record.revision = summary.revision; record.collectionHash = summary.collectionHash; record.status = "current"; record.error = undefined;
      this.warned.delete(`remote:${record.id}`);
      this.save(); this.changed(); return record;
    } catch (error) {
      record.status = "offline"; record.error = error instanceof Error ? error.message : String(error); this.save();
      if (previousStatus !== record.status || previousError !== record.error) this.changed();
      if (previousStatus !== "offline") this.warning(`remote:${record.id}`, `Subscription "${record.alias || record.publisher || record.shareId}" cannot reach Broker ${record.endpoint}. Cached content remains available.`);
      throw error;
    }
  }

  startBackground(): void {
    this.tryBecomeBackgroundLeader();
    if (!this.backgroundElectionTimer) {
      this.backgroundElectionTimer = setInterval(() => this.tryBecomeBackgroundLeader(), 15_000);
      this.backgroundElectionTimer.unref?.();
    }
  }

  private tryBecomeBackgroundLeader(): void {
    if (this.backgroundLock) return;
    try { this.backgroundLock = ChatRoomLock.acquire(path.join(this.storageDir, "subscription-background.lock"), this.state.nodeId); }
    catch { return; }
    this.reloadPersistedState();
    for (const record of this.state.subscriptions) this.connectMqtt(record);
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => { for (const record of this.state.subscriptions) void this.refresh(record.id).catch(() => {}); }, 30 * 60_000);
      this.pollTimer.unref?.();
    }
    if (!this.healthTimer) {
      this.healthTimer = setInterval(() => { void this.checkHealth(); }, 5 * 60_000);
      this.healthTimer.unref?.();
    }
    void this.checkHealth();
  }

  async checkHealth(): Promise<void> {
    const previousGatewayStatus = this.gatewayStatus;
    const previousGatewayError = this.gatewayError;
    if (this.state.enabled) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.state.port}/.well-known/pkm-node`, { signal: AbortSignal.timeout(2_000) });
        const node = await response.json() as { nodeId?: string; gatewayVersion?: string; gatewayProtocolVersion?: string };
        if (node.nodeId !== this.state.nodeId) throw new Error(`Port ${this.state.port} is not serving this PKM node.`);
        if (!this.gatewayCompatible(node)) await this.ensureGateway();
        this.gatewayStatus = "running"; this.gatewayError = ""; this.warned.delete("gateway"); this.warned.delete("gateway-restarted");
      } catch (probeError) {
        try {
          await this.ensureGateway();
          this.gatewayStatus = "running"; this.gatewayError = "";
          this.warning("gateway-restarted", `PKM Common Communication Port ${this.state.port} became unavailable and the Node Gateway was restarted.`);
        } catch (restartError) {
          this.gatewayStatus = "error";
          this.gatewayError = restartError instanceof Error ? restartError.message : String(restartError || probeError);
          this.warning("gateway", `PKM Common Communication Port ${this.state.port} is unavailable: ${this.gatewayError}`);
        }
      }
    } else {
      this.gatewayStatus = "stopped"; this.gatewayError = ""; this.warned.delete("gateway"); this.warned.delete("gateway-restarted");
    }
    for (const share of this.state.shares.filter(item => item.protection === "secret-protected")) {
      const key = `protected-control:${share.shareId}`;
      try {
        const response = await fetch(`http://127.0.0.1:${share.controlPort}/.well-known/pkm-node`, { signal: AbortSignal.timeout(2_000) });
        const node = await response.json() as { nodeId?: string; shareId?: string };
        if (node.nodeId !== this.state.nodeId || node.shareId !== share.shareId) throw new Error("listener identity mismatch");
        this.warned.delete(key);
      } catch (error) {
        this.warning(key, `Secret Protected Broker "${share.name}" Control Port ${share.controlPort} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const record of this.state.subscriptions) {
      try { await this.refresh(record.id); }
      catch { /* refresh emits one transition warning and preserves cache */ }
    }
    if (previousGatewayStatus !== this.gatewayStatus || previousGatewayError !== this.gatewayError) this.changed();
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.backgroundElectionTimer) clearInterval(this.backgroundElectionTimer);
    this.backgroundElectionTimer = undefined;
    for (const client of this.mqttClients.values()) client.end(true);
    this.mqttClients.clear();
    this.backgroundLock?.release();
    this.backgroundLock = undefined;
  }

  private buildSummary(shareId: string, name: string, revision: number, snapshot: Buffer, bundle: any, secretProtected = false, secretSalt?: string): ShareSummary {
    const counts: Record<string, number> = {};
    const topics: string[] = [];
    const tags: string[] = [];
    for (const type of SHARED_CONTENT_TYPES) {
      const items = Array.isArray(bundle[type]) ? bundle[type] : [];
      if (!items.length) continue;
      counts[type] = items.length;
      for (const item of items) {
        topics.push(item.topic, item.category, item.metadata?.category, item.metadata?.source_project, item.project, item.lang);
        tags.push(...tagsOf(item.tags), ...tagsOf(item.metadata?.tags));
      }
    }
    const unsigned = {
      shareId, name, revision, collectionHash: hash(snapshot), updatedAt: new Date().toISOString(), counts,
      topics: unique(topics, 100), tags: unique(tags, 100), itemCount: Object.values(counts).reduce((sum, count) => sum + count, 0), metadataOnly: true as const, secretProtected, ...(secretSalt ? { secretSalt } : {}),
      snapshotBytes: snapshot.length,
    };
    const signature = sign(null, Buffer.from(JSON.stringify(unsigned)), this.state.privateKey).toString("base64url");
    return { ...unsigned, signature };
  }

  private buildShareBundle(contentTypes: SharedContentType[], selected: SyncSelection, folders: Partial<Record<SharedContentType, string[]>>): any {
    const result: any = { from: this.state.displayName, created_at: "", version: "3" };
    const identity = (type: SharedContentType, item: any): string => {
      if (type === "skills") return String(item.name || "");
      if (type === "notes" || type === "papers") return String(item.slug || "");
      if (type === "prompts") return `${item.project}/${item.task}`;
      if (type === "scripts") return `${item.category === "(root)" ? "" : `${item.category}/`}${item.file}`;
      if (type === "packages") return String(item.name || "");
      return String(item.slug || "");
    };
    const folder = (type: SharedContentType, item: any): string => {
      if (type === "skills") return String(item.metadata?.category || "");
      if (type === "notes") return String(item.category || "");
      if (type === "papers") return String(item.category || item.topic || "");
      if (type === "prompts") return String(item.project || "");
      if (type === "scripts") return item.category === "(root)" ? "" : String(item.category || "");
      if (type === "servers") return String(item.category || "");
      return "";
    };
    for (const type of contentTypes) {
      const all = type === "servers" ? serverExport([], this.state.advertisedHost) : buildSyncBundle(emptySyncSelection(), [type], this.state.displayName)[type] || [];
      const exact = new Set(selected[type] || []);
      const dynamicFolders = folders[type] || [];
      result[type] = all.filter((item: any) => {
        const itemFolder = folder(type, item);
        if (isContentItemPrivate(type, item)) return false;
        return exact.has(identity(type, item)) || dynamicFolders.some(sharedFolder => sharedFolder === "" || itemFolder === sharedFolder || itemFolder.startsWith(`${sharedFolder}/`));
      });
    }
    return result;
  }

  private async downloadSnapshot(record: SubscriptionRecord, summary: ShareSummary): Promise<void> {
    const operationStartedAt = Date.now(), memoryBefore = process.memoryUsage();
    if (Number(summary.snapshotBytes || 0) > MAX_SNAPSHOT_DOWNLOAD_BYTES) throw new Error(`Subscription snapshot exceeds the ${MAX_SNAPSHOT_DOWNLOAD_BYTES / 1024 / 1024} MB safety limit.`);
    const identityProof = this.subscriberProof(record.shareId);
    let derivedKeys: { authVerifier: Buffer; contentKey: Buffer } | undefined;
    if (summary.secretProtected) {
      const secret = await this.secrets?.get(this.subscriberSecretKey(record.nodeId, record.shareId));
      if (!secret || !summary.secretSalt) throw new Error("Secret Protected Broker requires its additional secret.");
      derivedKeys = deriveSecretKeys(secret, summary.secretSalt);
    }
    const ticketHeaders: Record<string, string> = { "X-PKM-Subscriber-Proof": identityProof };
    if (derivedKeys) ticketHeaders["X-PKM-Share-Secret-Proof"] = createHmac("sha256", derivedKeys.authVerifier).update(identityProof).digest("base64url");
    const ticketResponse = await fetch(`${record.endpoint}/v1/shares/${encodeURIComponent(record.shareId)}/sync-ticket`, { method: "POST", headers: ticketHeaders, signal: AbortSignal.timeout(10_000) });
    if (!ticketResponse.ok) throw new Error(`Sync ticket request returned ${ticketResponse.status}.`);
    const ticket = await ticketResponse.json() as { brokerUrl: string; ticket: string; collectionHash: string; revision: number };
    if (ticket.collectionHash !== summary.collectionHash || ticket.revision !== summary.revision) throw new Error("Broker revision changed before Sync started.");
    const brokerUrl = normalizeEndpoint(ticket.brokerUrl);
    if (new URL(brokerUrl).port === new URL(record.endpoint).port) throw new Error("Broker returned the Common Control Port for content transfer.");
    const bundleResponse = await fetch(`${brokerUrl}/sync/bundle`, { headers: { Authorization: `Bearer ${ticket.ticket}` }, signal: AbortSignal.timeout(120_000) });
    if (!bundleResponse.ok) throw new Error(`Background Sync returned ${bundleResponse.status}.`);
    const contentLength = Number(bundleResponse.headers.get("content-length") || 0);
    if (contentLength > MAX_SNAPSHOT_DOWNLOAD_BYTES + 64 * 1024) throw new Error(`Background Sync payload exceeds the ${MAX_SNAPSHOT_DOWNLOAD_BYTES / 1024 / 1024} MB safety limit.`);
    if (!bundleResponse.body) throw new Error("Background Sync returned an empty payload.");
    const downloadsDir = path.join(this.storageDir, "downloads");
    fs.mkdirSync(downloadsDir, { recursive: true });
    const downloadPath = path.join(downloadsDir, `${record.shareId}.${randomBytes(6).toString("hex")}.download`);
    let downloadedBytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
        downloadedBytes += chunk.length;
        if (downloadedBytes > MAX_SNAPSHOT_DOWNLOAD_BYTES + 64 * 1024) callback(new Error(`Background Sync payload exceeds the ${MAX_SNAPSHOT_DOWNLOAD_BYTES / 1024 / 1024} MB safety limit.`));
        else callback(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(bundleResponse.body as any), limit, fs.createWriteStream(downloadPath, { mode: 0o600 }));
    } catch (error) {
      fs.rmSync(downloadPath, { force: true });
      throw error;
    }
    let transferKey: Buffer | undefined;
    if (summary.secretProtected) {
      if (!derivedKeys) throw new Error("Secret Protected Broker keys are missing.");
      const port = Number(new URL(brokerUrl).port);
      transferKey = createHmac("sha256", derivedKeys.authVerifier).update(`pkm-transfer:v1:${record.nodeId}:${record.shareId}:${summary.revision}:${port}:${ticket.ticket}`).digest();
    }
    const syncedAt = new Date().toISOString();
    const snapshotBytes = await this.materializeInChild({
      inputPath: downloadPath,
      storageDir: this.storageDir,
      record: { id: record.id, alias: record.alias, publisher: record.publisher, nodeId: record.nodeId, shareId: record.shareId, endpoint: record.endpoint },
      summary,
      syncedAt,
      transferKey: transferKey?.toString("base64url"),
      contentKey: derivedKeys?.contentKey.toString("base64url"),
    });
    record.lastUpdated = syncedAt;
    this.operationDiagnostic("download", operationStartedAt, memoryBefore, { shareId: record.shareId, revision: summary.revision, snapshotBytes, transferBytes: downloadedBytes, itemCount: summary.itemCount, isolatedProcess: true });
  }

  private materializeInChild(task: Record<string, unknown>): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = fork(path.join(__dirname, "subscription-materialize-worker.js"), [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      const finish = (error?: Error, snapshotBytes?: number): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (error && child.exitCode === null) child.kill();
        fs.rmSync(String(task.inputPath), { force: true });
        if (error) reject(error); else resolve(Number(snapshotBytes || 0));
      };
      child.once("error", error => finish(error));
      child.once("exit", code => { if (!settled) finish(new Error(`Subscription materializer exited before completion (${code ?? "unknown"}).`)); });
      child.once("message", (message: any) => {
        if (message?.ok) finish(undefined, message.snapshotBytes);
        else finish(new Error(message?.error || "Subscription materializer failed."));
      });
      child.send(task, error => { if (error) finish(error); });
      timeout = setTimeout(() => finish(new Error("Subscription materializer timed out.")), 5 * 60_000);
      timeout.unref();
    });
  }

  private connectMqtt(record: SubscriptionRecord): void {
    if (this.mqttClients.has(record.nodeId)) return;
    const endpoint = new URL(record.endpoint);
    const client = connect(`${endpoint.protocol === "https:" ? "wss" : "ws"}://${endpoint.host}/mqtt`, {
      protocolVersion: 4, clean: true, reconnectPeriod: 15_000 + Math.floor(Math.random() * 15_000), connectTimeout: 10_000,
      clientId: `pkm_${randomBytes(8).toString("hex")}`, username: "pkm-node", password: this.subscriberProof("*"),
    });
    this.mqttClients.set(record.nodeId, client);
    client.on("connect", () => {
      this.warned.delete(`mqtt-node:${record.nodeId}`);
      for (const subscription of this.state.subscriptions.filter(item => item.nodeId === record.nodeId)) {
        const warningKey = `mqtt:${subscription.nodeId}:${subscription.shareId}`;
        client.subscribe(`pkm/v1/nodes/${subscription.nodeId}/shares/${subscription.shareId}/summary`, { qos: 1 }, error => {
          if (error) this.warning(warningKey, `Realtime updates for "${subscription.alias || subscription.brokerName || subscription.publisher}" are unavailable; periodic and manual Refresh remain available.`);
          else this.warned.delete(warningKey);
        });
      }
    });
    client.on("message", (_topic, payload) => {
      try {
        const summary = JSON.parse(payload.toString()) as ShareSummary;
        const subscription = this.state.subscriptions.find(item => item.shareId === summary.shareId && item.nodeId === record.nodeId);
        if (subscription && summary.revision > subscription.revision) {
          if (this.stateMutationDepth) this.pendingMqttRefreshes.add(subscription.id);
          else void this.refresh(subscription.id).catch(() => {});
        }
      } catch { /* polling remains the canonical fallback */ }
    });
    client.on("error", () => {
      this.warning(`mqtt-node:${record.nodeId}`, `Realtime Subscription updates from ${record.publisher} are unavailable; periodic and manual Refresh remain available.`);
    });
  }

  private async ensureGateway(): Promise<void> {
    if (this.gatewayEnsure) return this.gatewayEnsure;
    const pending = this.withGatewayTransitionLock(() => this.ensureGatewayLocked());
    this.gatewayEnsure = pending;
    try { await pending; }
    finally { if (this.gatewayEnsure === pending) this.gatewayEnsure = undefined; }
  }

  private async ensureGatewayLocked(): Promise<void> {
    try {
      const response = await fetch(`http://127.0.0.1:${this.state.port}/.well-known/pkm-node`, { signal: AbortSignal.timeout(1_000) });
      const node = await response.json() as { nodeId?: string; gatewayVersion?: string; gatewayProtocolVersion?: string; gatewayPid?: number };
      if (node.nodeId === this.state.nodeId && this.gatewayCompatible(node)) { this.refreshGatewayPid(); this.gatewayStatus = "running"; this.gatewayError = ""; return; }
      if (node.nodeId === this.state.nodeId) await this.handoffGateway(node.gatewayVersion || "legacy", node.gatewayPid);
      else throw new Error(`Port ${this.state.port} is owned by another PKM node.`);
    } catch (error) {
      if (error instanceof Error && (error.message.includes("another PKM node") || error.message.includes("handoff"))) throw error;
    }
    const child = spawn(process.execPath, [this.gatewayScript, this.gatewayStatePath(), this.gatewayRuntimeVersion], { detached: true, stdio: "ignore" });
    child.unref();
    this.state.gatewayPid = child.pid;
    this.save(false);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.state.port}/.well-known/pkm-node`, { signal: AbortSignal.timeout(500) });
        const node = await response.json() as { nodeId?: string; gatewayVersion?: string; gatewayProtocolVersion?: string };
        if (node.nodeId === this.state.nodeId && this.gatewayCompatible(node)) { this.gatewayStatus = "running"; this.gatewayError = ""; return; }
      } catch { /* retry */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`PKM Node Gateway did not start on port ${this.state.port}.`);
  }

  private gatewayCompatible(node: { gatewayVersion?: string; gatewayProtocolVersion?: string }): boolean {
    return node.gatewayVersion === this.gatewayRuntimeVersion
      && node.gatewayProtocolVersion === "pkm-node-gateway:v2"
      && Number((node as { gatewayPid?: number }).gatewayPid) > 1;
  }

  private refreshGatewayPid(): void {
    try {
      const persisted = JSON.parse(fs.readFileSync(this.statePath(), "utf8")) as PersistedState;
      if (persisted.gatewayPid) this.state.gatewayPid = persisted.gatewayPid;
    } catch { /* retain the in-memory PID */ }
  }

  private async handoffGateway(previousVersion: string, endpointPid?: number): Promise<void> {
    const pid = this.resolveGatewayOwnerPid(endpointPid);
    if (!pid) throw new Error("Gateway handoff refused because the live listener PID could not be uniquely verified.");
    this.state.gatewayPid = pid;
    try { process.kill(pid, "SIGTERM"); }
    catch (error: any) { if (error?.code !== "ESRCH") throw new Error(`Gateway handoff could not stop PID ${pid}: ${error?.message || error}`); }
    const deadline = Date.now() + 5_000;
    let stopped = false;
    while (Date.now() < deadline) {
      if (!this.processAlive(pid) || !await this.gatewayStillServing()) { stopped = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!stopped) throw new Error(`Gateway handoff timed out waiting for PID ${pid}.`);
    this.state.gatewayPid = undefined;
    this.events.onDiagnostic?.({ operation: "gateway-handoff", previousVersion, nextVersion: this.gatewayRuntimeVersion, previousPid: pid });
    this.warning("gateway-upgraded", `PKM Node Gateway ${previousVersion} was gracefully replaced by ${this.gatewayRuntimeVersion}.`);
  }

  private gatewayProcessOwned(pid: number): boolean {
    if (!this.processAlive(pid)) return false;
    const cmdlinePath = `/proc/${pid}/cmdline`;
    if (!fs.existsSync(cmdlinePath)) return true;
    try {
      const command = fs.readFileSync(cmdlinePath, "utf8").replace(/\0/g, " ");
      return command.includes("subscription-gateway") && command.includes(this.gatewayStatePath());
    } catch { return false; }
  }

  private resolveGatewayOwnerPid(endpointPid?: number): number | undefined {
    if (Number(endpointPid) > 1 && this.gatewayProcessOwned(Number(endpointPid))) return Number(endpointPid);
    const candidates = new Set<number>();
    this.refreshGatewayPid();
    if (Number(this.state.gatewayPid) > 1 && this.gatewayProcessOwned(Number(this.state.gatewayPid))) candidates.add(Number(this.state.gatewayPid));
    if (process.platform === "linux") {
      try {
        for (const entry of fs.readdirSync("/proc")) {
          if (!/^\d+$/.test(entry)) continue;
          const pid = Number(entry);
          if (this.gatewayProcessOwned(pid)) candidates.add(pid);
        }
      } catch { /* endpoint PID remains the portable identity source */ }
    }
    return candidates.size === 1 ? [...candidates][0] : undefined;
  }

  private processAlive(pid: number): boolean {
    const statPath = `/proc/${pid}/stat`;
    if (fs.existsSync(statPath)) {
      try {
        const stat = fs.readFileSync(statPath, "utf8");
        const state = stat.slice(stat.lastIndexOf(")") + 2).charAt(0);
        if (state === "Z") return false;
      } catch { /* fall through to the portable signal check */ }
    }
    try { process.kill(pid, 0); return true; }
    catch (error: any) { return error?.code === "EPERM"; }
  }

  private async gatewayStillServing(): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${this.state.port}/.well-known/pkm-node`, { signal: AbortSignal.timeout(250) });
      const node = await response.json() as { nodeId?: string };
      return node.nodeId === this.state.nodeId;
    } catch { return false; }
  }

  private async withGatewayTransitionLock<T>(action: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.storageDir, "gateway-transition.lock");
    const deadline = Date.now() + 7_000;
    let lock: ChatRoomLock | undefined;
    while (!lock) {
      try { lock = ChatRoomLock.acquire(lockPath, this.state.nodeId); }
      catch (error) {
        if (Date.now() >= deadline) throw new Error(`Gateway handoff lock timed out: ${error instanceof Error ? error.message : String(error)}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    try { return await action(); }
    finally { lock.release(); }
  }

  private async stopGateway(): Promise<void> {
    if (!this.state.gatewayPid) return;
    try {
      const response = await fetch(`http://127.0.0.1:${this.state.port}/.well-known/pkm-node`, { signal: AbortSignal.timeout(1_000) });
      const node = await response.json() as { nodeId?: string };
      if (node.nodeId === this.state.nodeId) process.kill(this.state.gatewayPid, "SIGTERM");
    } catch { /* already stopped */ }
    this.state.gatewayPid = undefined;
    this.gatewayStatus = "stopped";
    this.gatewayError = "";
    this.save(false);
  }

  private async reloadGatewayConfiguration(controlPort: number, configurationId: string): Promise<void> {
    if (!this.state.enabled || !this.state.gatewayPid) return;
    let ownerPid = Number(this.state.gatewayPid);
    try {
      const response = await fetch(`http://127.0.0.1:${this.state.port}/.well-known/pkm-node`, { signal: AbortSignal.timeout(1_000) });
      const node = await response.json() as { nodeId?: string; gatewayPid?: number };
      if (node.nodeId === this.state.nodeId && Number(node.gatewayPid) > 1) {
        ownerPid = Number(node.gatewayPid);
        this.state.gatewayPid = ownerPid;
      }
    } catch { /* persisted PID and file watching remain fallback paths */ }
    try { process.kill(ownerPid, "SIGHUP"); } catch { /* file watching remains the fallback */ }
    const deadline = Date.now() + 5_000;
    let expected = configurationId;
    let observed = "";
    while (Date.now() < deadline) {
      try {
        const persisted = JSON.parse(fs.readFileSync(this.gatewayStatePath(), "utf8")) as { configurationId?: string };
        expected = String(persisted.configurationId || expected);
        const response = await fetch(`http://127.0.0.1:${controlPort}/.well-known/pkm-node`, { signal: AbortSignal.timeout(500) });
        const node = await response.json() as { configurationId?: string };
        observed = String(node.configurationId || "");
        if (observed === expected) return;
      } catch { /* retry while the listener reloads */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Broker Gateway configuration reload timed out (expected ${expected || "unknown"}, observed ${observed || "none"}).`);
  }

  private changed(): void { this.events.onChanged?.(); }
  private warning(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.events.onWarning?.(message);
  }

  private requireSubscription(id: string): SubscriptionRecord {
    const record = this.state.subscriptions.find(item => item.id === id);
    if (!record) throw new Error("Subscription was not found.");
    return record;
  }
  private cachedBrokerName(record: SubscriptionRecord): string {
    try {
      const summary = JSON.parse(fs.readFileSync(path.join(this.storageDir, "cache", record.nodeId, record.shareId, "summary.json"), "utf8"));
      return String(summary?.name || "").trim();
    } catch { return ""; }
  }

  private save(writeGateway = true): void {
    atomicWrite(this.statePath(), JSON.stringify(this.state, null, 2), 0o600);
    if (writeGateway) {
      this.gatewayConfigurationId = randomBytes(12).toString("base64url");
      const gateway = {
        schema: 1, configurationId: this.gatewayConfigurationId, extensionVersion: this.gatewayRuntimeVersion, gatewayProtocolVersion: "pkm-node-gateway:v2", ownerNodeId: this.state.nodeId,
        nodeId: this.state.nodeId, displayName: this.state.displayName, port: this.state.port, bindHost: this.state.bindHost, advertisedHost: this.state.advertisedHost,
        publicKey: this.state.publicKey, shares: this.state.shares.map(share => ({ summary: share.summary, snapshotPath: share.snapshotPath, published: share.published !== false, visibility: share.visibility, accessMode: share.accessMode, ipRules: share.ipRules || [], accountMode: share.accountMode, accountRules: share.accountRules || [], protection: share.protection, authVerifier: share.authVerifier, controlPort: share.controlPort, dataPort: share.dataPort || 0 })),
        subscriberStatsPath: this.subscriberStatsPath(), uploadBytesPerSecond: 10 * 1024 * 1024, maxConcurrentTransfers: 2,
      };
      atomicWrite(this.gatewayStatePath(), JSON.stringify(gateway, null, 2), 0o600);
    }
  }
  private prunePublishedSnapshots(onlyShareId?: string): { removed: number; reclaimedBytes: number } {
    const snapshotsDir = path.join(this.storageDir, "snapshots");
    if (!fs.existsSync(snapshotsDir)) return { removed: 0, reclaimedBytes: 0 };
    const activeShares = new Map(this.state.shares.map(share => [share.shareId, share]));
    let removed = 0, reclaimedBytes = 0;
    for (const name of fs.readdirSync(snapshotsDir)) {
      const match = /^(.+)-(\d+)\.json$/.exec(name);
      if (!match || onlyShareId && match[1] !== onlyShareId) continue;
      const share = activeShares.get(match[1]);
      const revision = Number(match[2]);
      if (share && (revision === share.revision || revision === share.revision - 1)) continue;
      const full = path.join(snapshotsDir, name);
      try { reclaimedBytes += fs.statSync(full).size; fs.rmSync(full, { force: true }); removed += 1; } catch { /* retry on next startup/publish */ }
    }
    return { removed, reclaimedBytes };
  }
  private pruneStaleDownloads(): void {
    const downloadsDir = path.join(this.storageDir, "downloads");
    if (!fs.existsSync(downloadsDir)) return;
    const staleBefore = Date.now() - 24 * 60 * 60_000;
    for (const name of fs.readdirSync(downloadsDir)) {
      if (!name.endsWith(".download")) continue;
      const full = path.join(downloadsDir, name);
      try { if (fs.statSync(full).mtimeMs < staleBefore) fs.rmSync(full, { force: true }); } catch { /* retry next startup */ }
    }
  }
  private operationDiagnostic(operation: string, startedAt: number, before: NodeJS.MemoryUsage, fields: Record<string, string | number | boolean>): void {
    const after = process.memoryUsage();
    this.events.onDiagnostic?.({
      operation,
      durationMs: Date.now() - startedAt,
      heapUsedBefore: before.heapUsed,
      heapUsedAfter: after.heapUsed,
      externalBefore: before.external,
      externalAfter: after.external,
      arrayBuffersBefore: before.arrayBuffers,
      arrayBuffersAfter: after.arrayBuffers,
      ...fields,
    });
  }
  private statePath(): string { return path.join(this.storageDir, "subscriptions.json"); }
  private gatewayStatePath(): string { return path.join(this.storageDir, "gateway-state.json"); }
  private subscriberStatsPath(): string { return path.join(this.storageDir, "subscriber-stats.json"); }
  private publisherSecretKey(shareId: string): string { return `personalKnowledge.shareBroker.${shareId}.secret`; }
  private subscriberSecretKey(nodeId: string, shareId: string): string { return `personalKnowledge.subscription.${nodeId}.${shareId}.secret`; }
  private subscriberProof(shareId: string): string {
    const unsigned = { schema: 1 as const, nodeId: this.state.nodeId, name: this.state.displayName, publicKey: this.state.publicKey, shareId, timestamp: Date.now(), nonce: randomBytes(12).toString("base64url") };
    const proof: SubscriberProof = { ...unsigned, signature: sign(null, Buffer.from(JSON.stringify(unsigned)), this.state.privateKey).toString("base64url") };
    return Buffer.from(JSON.stringify(proof)).toString("base64url");
  }
  private brokerTelemetry(shareId: string): { subscribers: any[]; securityEvents: any[]; automaticBlocks: any[] } {
    try {
      const stats = JSON.parse(fs.readFileSync(this.subscriberStatsPath(), "utf8"));
      return {
        subscribers: Object.values(stats?.shares?.[shareId] || {}).sort((left: any, right: any) => String(right.lastSeenAt || "").localeCompare(String(left.lastSeenAt || ""))),
        securityEvents: (stats?.securityEvents || []).filter((event: any) => event.shareId === shareId).slice(-50).reverse(),
        automaticBlocks: Object.values(stats?.automaticBlocks?.[shareId] || {}).sort((left: any, right: any) => String(right.blockedAt || "").localeCompare(String(left.blockedAt || ""))),
      };
    } catch { return { subscribers: [], securityEvents: [], automaticBlocks: [] }; }
  }
}

export function parseShareMagicLink(value: string): MagicLinkPayload {
  const match = /^pkmshare:v1:([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value.trim());
  if (!match) throw new Error("Invalid PKM Share Magic Link.");
  const payload = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")) as MagicLinkPayload;
  if (payload.protocol !== "pkmshare:v1" || !payload.shareId || !payload.publicKey || !payload.publisherUser?.trim() || !payload.publisherHost?.trim()) throw new Error("Invalid PKM Share Magic Link payload.");
  if (payload.nodeId !== nodeIdForPublicKey(payload.publicKey)) throw new Error("PKM Share node identity mismatch.");
  if (!verify(null, Buffer.from(match[1]), payload.publicKey, Buffer.from(match[2], "base64url"))) throw new Error("PKM Share Magic Link signature is invalid.");
  if (payload.secretProtected) {
    const endpoint = new URL(payload.endpoint);
    if (!/^https?:$/.test(endpoint.protocol) || !endpoint.hostname || endpoint.port) throw new Error("Secret Protected Broker Magic Link must contain a host but no Control Port.");
    payload.endpoint = endpoint.toString().replace(/\/$/, "");
  } else payload.endpoint = normalizeEndpoint(payload.endpoint);
  return payload;
}

export function verifyShareSummary(summary: ShareSummary, publicKey: string, nodeId: string, shareId: string): void {
  if (nodeIdForPublicKey(publicKey) !== nodeId || summary.shareId !== shareId || summary.metadataOnly !== true) throw new Error("Share summary identity is invalid.");
  const serialized = JSON.stringify(withoutSignature(summary));
  if (!verify(null, Buffer.from(serialized), publicKey, Buffer.from(summary.signature, "base64url"))) throw new Error("Share summary signature is invalid.");
  if ((summary as any).content !== undefined || (summary as any).items !== undefined) throw new Error("Control summary must not contain shared content.");
}
