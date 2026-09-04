import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { createReadStream, existsSync, readFileSync, renameSync, statSync, unwatchFile, watch, watchFile, writeFileSync } from "fs";
import { basename, dirname } from "path";
import { createCipheriv, createHash, createHmac, randomBytes, timingSafeEqual, verify } from "crypto";
import { Transform, TransformCallback } from "stream";
import { Aedes } from "aedes";
import { WebSocketServer, createWebSocketStream } from "ws";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { normalizeClientIp } from "./subscription-ip-policy";
import { BrokerAcl, BrokerAction } from "./subscription-acl";

interface ShareSummary {
  shareId: string;
  name: string;
  revision: number;
  collectionHash: string;
  updatedAt: string;
  counts: Record<string, number>;
  topics: string[];
  tags: string[];
  itemCount: number;
  metadataOnly: true;
  signature: string;
}
interface GatewayShare {
  summary: ShareSummary;
  snapshotPath: string;
  visibility: "public" | "unlisted";
  accessMode: "block-list" | "white-list";
  ipRules: string[];
  accountMode: "open" | "block-list" | "white-list";
  accountRules: string[];
  protection: "open" | "secret-protected";
  authVerifier?: string;
  controlPort: number;
  dataPort: number;
}
interface GatewayState {
  schema: 1;
  configurationId?: string;
  nodeId: string;
  displayName: string;
  port: number;
  bindHost: string;
  advertisedHost: string;
  publicKey: string;
  shares: GatewayShare[];
  subscriberStatsPath: string;
  uploadBytesPerSecond?: number;
  maxConcurrentTransfers?: number;
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
interface SubscriberStat {
  nodeId: string;
  name: string;
  names: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  lastSyncAt?: string;
  lastIp: string;
  requestCount: number;
  ticketCount: number;
  syncCount: number;
  abnormal: string[];
}
interface SubscriberStats {
  schema: 1;
  shares: Record<string, Record<string, SubscriberStat>>;
  securityEvents: { at: string; shareId: string; ip: string; reason: string }[];
  secretFailures: Record<string, Record<string, number>>;
  automaticBlocks: Record<string, Record<string, { ip: string; reason: string; failedAttempts: number; blockedAt: string }>>;
}
class GatewayRequestError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter?: string) { super(message); }
}
const statePath = process.argv[2];
if (!statePath) throw new Error("Subscription gateway state path is required.");
let state = readState();
const requestLimiter = new RateLimiterMemory({ points: 60, duration: 60, blockDuration: 30 });
const controlLimiter = new RateLimiterMemory({ points: 120, duration: 60, blockDuration: 15 });
let activeTransfers = 0;
const recentTickets = new Map<string, number[]>();
const aclCache = new Map<string, Promise<BrokerAcl>>();

function readState(): GatewayState {
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as GatewayState;
  if (parsed.schema !== 1 || !parsed.nodeId || !Number.isInteger(parsed.port)) throw new Error("Invalid subscription gateway state.");
  return parsed;
}
function clientKey(req: IncomingMessage): string { return req.socket.remoteAddress || "unknown"; }
function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)), "Cache-Control": "no-store", ...headers });
  res.end(payload);
}
function findShare(shareId: string): GatewayShare | undefined { return state.shares.find(share => share.summary.shareId === shareId); }
function loadStats(): SubscriberStats {
  try {
    const stats = JSON.parse(readFileSync(state.subscriberStatsPath, "utf8"));
    stats.shares ||= {}; stats.securityEvents ||= []; stats.secretFailures ||= {}; stats.automaticBlocks ||= {};
    return stats;
  } catch { return { schema: 1, shares: {}, securityEvents: [], secretFailures: {}, automaticBlocks: {} }; }
}
function saveStats(stats: SubscriberStats): void {
  const temporary = `${state.subscriberStatsPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(stats, null, 2), { mode: 0o600 });
  renameSync(temporary, state.subscriberStatsPath);
}
function securityEvent(shareId: string, ip: string, reason: string): void {
  const stats = loadStats();
  stats.securityEvents.push({ at: new Date().toISOString(), shareId, ip: normalizeClientIp(ip), reason });
  stats.securityEvents = stats.securityEvents.slice(-200);
  saveStats(stats);
}
async function aclAllowed(share: GatewayShare, accountId: string | undefined, clientIp: string, action: BrokerAction): Promise<boolean> {
  const stats = loadStats();
  const policy = {
    shareId: share.summary.shareId,
    accountMode: share.accountMode || "open",
    accountRules: share.accountRules || [],
    networkMode: share.accessMode || "block-list",
    ipRules: share.ipRules || [],
    automaticBlocks: Object.keys(stats.automaticBlocks[share.summary.shareId] || {}),
  } as const;
  const key = JSON.stringify(policy);
  let compiled = aclCache.get(key);
  if (!compiled) { compiled = BrokerAcl.create(policy); aclCache.set(key, compiled); }
  return (await compiled).enforce({ accountId, sourceIp: clientIp, shareId: share.summary.shareId, action });
}
function secretFailure(shareId: string, clientIp: string): boolean {
  const ip = normalizeClientIp(clientIp);
  const stats = loadStats();
  const failures = stats.secretFailures[shareId] ||= {};
  failures[ip] = (failures[ip] || 0) + 1;
  if (failures[ip] >= 3) {
    const blocked = stats.automaticBlocks[shareId] ||= {};
    blocked[ip] = { ip, reason: "three-secret-failures", failedAttempts: failures[ip], blockedAt: new Date().toISOString() };
  }
  saveStats(stats);
  return failures[ip] >= 3;
}
function clearSecretFailures(shareId: string, clientIp: string): void {
  const ip = normalizeClientIp(clientIp);
  const stats = loadStats();
  if (!stats.secretFailures[shareId]?.[ip]) return;
  delete stats.secretFailures[shareId][ip];
  saveStats(stats);
}
function verifyProtectedSecret(req: IncomingMessage, share: GatewayShare): void {
  if (share.protection !== "secret-protected") return;
  const supplied = String(req.headers["x-pkm-share-secret-proof"] || "");
  const identityProof = String(req.headers["x-pkm-subscriber-proof"] || "");
  if (!share.authVerifier || !supplied) {
    const blocked = secretFailure(share.summary.shareId, clientKey(req));
    throw new GatewayRequestError(blocked ? "IP blocked after three incorrect Broker secrets." : "Secret Protected Broker requires its additional secret.", blocked ? 403 : 401);
  }
  const expected = createHmac("sha256", Buffer.from(share.authVerifier, "base64url")).update(identityProof).digest();
  let actual: Buffer;
  try { actual = Buffer.from(supplied, "base64url"); } catch { actual = Buffer.alloc(0); }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    const blocked = secretFailure(share.summary.shareId, clientKey(req));
    throw new GatewayRequestError(blocked ? "IP blocked after three incorrect Broker secrets." : "Broker secret proof is invalid.", blocked ? 403 : 401);
  }
  clearSecretFailures(share.summary.shareId, clientKey(req));
}
function parseSubscriberProof(encoded: string, shareId: string, required: boolean): SubscriberProof | undefined {
  if (!encoded) {
    if (required) throw new GatewayRequestError("Subscriber identity proof is required.", 401);
    return undefined;
  }
  let proof: SubscriberProof;
  try { proof = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { throw new GatewayRequestError("Subscriber identity proof is malformed.", 401); }
  const unsigned = { schema: proof.schema, nodeId: proof.nodeId, name: proof.name, publicKey: proof.publicKey, shareId: proof.shareId, timestamp: proof.timestamp, nonce: proof.nonce };
  const expectedNodeId = createHash("sha256").update(Buffer.from(proof.publicKey || "")).digest("hex");
  if (proof.schema !== 1 || proof.shareId !== shareId || proof.nodeId !== expectedNodeId || Math.abs(Date.now() - Number(proof.timestamp)) > 5 * 60_000 ||
      !verify(null, Buffer.from(JSON.stringify(unsigned)), proof.publicKey, Buffer.from(proof.signature || "", "base64url"))) {
    throw new GatewayRequestError("Subscriber identity proof is invalid or expired.", 401);
  }
  return proof;
}
function subscriberProof(req: IncomingMessage, shareId: string, required: boolean): SubscriberProof | undefined {
  return parseSubscriberProof(String(req.headers["x-pkm-subscriber-proof"] || ""), shareId, required);
}
function recordSubscriber(req: IncomingMessage, proof: SubscriberProof, action: "request" | "ticket" | "sync"): SubscriberStat {
  const stats = loadStats();
  const byShare = stats.shares[proof.shareId] ||= {};
  const now = new Date().toISOString();
  const current = byShare[proof.nodeId] ||= { nodeId: proof.nodeId, name: proof.name, names: [], firstSeenAt: now, lastSeenAt: now, lastIp: "", requestCount: 0, ticketCount: 0, syncCount: 0, abnormal: [] };
  current.name = String(proof.name || proof.nodeId).slice(0, 120);
  current.names = [...new Set([...current.names, current.name])].slice(-10);
  current.lastSeenAt = now;
  current.lastIp = normalizeClientIp(clientKey(req));
  if (action === "request") current.requestCount += 1;
  if (action === "ticket") current.ticketCount += 1;
  if (action === "sync") { current.syncCount += 1; current.lastSyncAt = now; }
  byShare[proof.nodeId] = current;
  saveStats(stats);
  return current;
}
function checkTicketRate(proof: SubscriberProof): void {
  const key = `${proof.shareId}:${proof.nodeId}`;
  const cutoff = Date.now() - 60_000;
  const recent = (recentTickets.get(key) || []).filter(timestamp => timestamp >= cutoff);
  recent.push(Date.now());
  recentTickets.set(key, recent);
  if (recent.length <= 10) return;
  const stats = loadStats();
  const current = stats.shares[proof.shareId]?.[proof.nodeId];
  if (current && !current.abnormal.includes("high-ticket-rate")) current.abnormal.push("high-ticket-rate");
  saveStats(stats);
  throw new GatewayRequestError("Subscriber ticket request rate is abnormal.", 429, "60");
}
function safeEqualHash(filePath: string, expected: string): boolean {
  if (!existsSync(filePath)) return false;
  const digest = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  return expected === `sha256:${digest}`;
}

class ByteThrottle extends Transform {
  private available: number;
  private lastRefill = Date.now();
  constructor(private readonly bytesPerSecond: number) { super(); this.available = bytesPerSecond; }
  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    const now = Date.now();
    this.available = Math.min(this.bytesPerSecond, this.available + (now - this.lastRefill) * this.bytesPerSecond / 1000);
    this.lastRefill = now;
    const waitMs = this.available >= chunk.length ? 0 : Math.ceil((chunk.length - this.available) * 1000 / this.bytesPerSecond);
    this.available = Math.max(0, this.available - chunk.length);
    if (!waitMs) { this.push(chunk); callback(); return; }
    setTimeout(() => { this.push(chunk); callback(); }, waitMs).unref?.();
  }
}

async function createTransferBroker(share: GatewayShare, proof: SubscriberProof): Promise<{ brokerUrl: string; ticket: string; expiresAt: string }> {
  const maxConcurrent = Math.max(1, state.maxConcurrentTransfers || 2);
  if (activeTransfers >= maxConcurrent) throw new Error("Transfer capacity is busy.");
  const ticket = randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + 2 * 60_000;
  let consumed = false;
  let closed = false;
  let actualPort = 0;
  activeTransfers += 1;
  const dataServer = createServer((req, res) => { void (async () => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method !== "GET" || req.url !== "/sync/bundle") { json(res, 404, { error: "Not found." }); return; }
    const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (consumed || Date.now() >= expiresAt || supplied !== ticket) { json(res, 401, { error: "Invalid or expired transfer ticket." }); return; }
    if (!await aclAllowed(share, proof.nodeId, clientKey(req), "download")) { securityEvent(share.summary.shareId, clientKey(req), "acl-deny-download"); json(res, 403, { error: "Access denied by Broker ACL." }); close(); return; }
    if (!safeEqualHash(share.snapshotPath, share.summary.collectionHash)) { json(res, 409, { error: "Share changed before transfer." }); close(); return; }
    consumed = true;
    recordSubscriber(req, proof, "sync");
    const size = statSync(share.snapshotPath).size;
    const source = createReadStream(share.snapshotPath, { highWaterMark: 64 * 1024 });
    const throttle = new ByteThrottle(Math.max(64 * 1024, state.uploadBytesPerSecond || 10 * 1024 * 1024));
    source.once("error", close);
    res.once("finish", close);
    res.once("close", close);
    if (share.protection === "secret-protected") {
      if (!share.authVerifier) { json(res, 503, { error: "Secret Protected Broker verifier is unavailable." }); close(); return; }
      const iv = randomBytes(12);
      const transferKey = createHmac("sha256", Buffer.from(share.authVerifier, "base64url")).update(`pkm-transfer:v1:${proof.nodeId}:${share.summary.shareId}:${share.summary.revision}:${actualPort}:${ticket}`).digest();
      const cipher = createCipheriv("aes-256-gcm", transferKey, iv);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(size + 36), "Cache-Control": "no-store" });
      res.write(Buffer.concat([Buffer.from("PKMENC1\n"), iv]));
      throttle.pipe(res, { end: false });
      throttle.once("end", () => res.end(cipher.getAuthTag()));
      source.pipe(cipher).pipe(throttle);
    } else {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(size), "Cache-Control": "no-store" });
      source.pipe(throttle).pipe(res);
    }
  })().catch(error => json(res, 500, { error: error instanceof Error ? error.message : String(error) })); });
  dataServer.headersTimeout = 5_000;
  dataServer.requestTimeout = 120_000;
  dataServer.keepAliveTimeout = 2_000;
  const close = (): void => {
    if (closed) return;
    closed = true;
    activeTransfers = Math.max(0, activeTransfers - 1);
    try { dataServer.close(); } catch { /* already closed */ }
  };
  const expiry = setTimeout(close, Math.max(0, expiresAt - Date.now()));
  expiry.unref?.();
  dataServer.once("close", () => clearTimeout(expiry));
  await new Promise<void>((resolve, reject) => {
    dataServer.once("error", error => { close(); reject(error); });
    dataServer.listen(share.dataPort || 0, state.bindHost || "0.0.0.0", resolve);
  });
  const address = dataServer.address();
  if (!address || typeof address === "string") { close(); throw new Error("Temporary Sync Broker did not expose a TCP port."); }
  actualPort = address.port;
  return { brokerUrl: `http://${state.advertisedHost || "127.0.0.1"}:${address.port}`, ticket, expiresAt: new Date(expiresAt).toISOString() };
}

type ControlScope = "open" | string;
function inControlScope(share: GatewayShare, scope: ControlScope): boolean {
  return scope === "open" ? share.protection === "open" : share.protection === "secret-protected" && share.summary.shareId === scope;
}

async function handle(req: IncomingMessage, res: ServerResponse, scope: ControlScope): Promise<void> {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Access-Control-Allow-Origin", "*");
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const control = req.method === "HEAD" || url.pathname === "/.well-known/pkm-node" || url.pathname.endsWith("/summary");
  try { await (control ? controlLimiter : requestLimiter).consume(clientKey(req)); }
  catch { json(res, 429, { error: "Rate limit exceeded." }, { "Retry-After": "30" }); return; }

  if (req.method === "GET" && url.pathname === "/.well-known/pkm-node") {
    json(res, 200, { protocol: "pkm-node:v1", nodeId: state.nodeId, displayName: state.displayName, publicKey: state.publicKey, configurationId: state.configurationId, broker: scope === "open" ? "open" : "secret-protected", ...(scope === "open" ? {} : { shareId: scope }), capabilities: { sharedMarket: "v1", mqtt: "3.1.1-websocket" } });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/catalog") {
    if (scope !== "open") { json(res, 404, { error: "Not found." }); return; }
    const visible = [];
    for (const share of state.shares) if (inControlScope(share, scope) && share.visibility === "public" && share.accountMode === "open" && await aclAllowed(share, undefined, clientKey(req), "discover")) visible.push(share.summary);
    json(res, 200, { nodeId: state.nodeId, shares: visible });
    return;
  }
  const summaryMatch = /^\/v1\/shares\/([a-zA-Z0-9_-]{8,128})\/summary$/.exec(url.pathname);
  if (summaryMatch && (req.method === "GET" || req.method === "HEAD")) {
    const share = findShare(summaryMatch[1]);
    if (!share || !inControlScope(share, scope)) { json(res, 404, { error: "Share not found." }); return; }
    try {
      const proof = subscriberProof(req, share.summary.shareId, share.accountMode !== "open");
      if (!await aclAllowed(share, proof?.nodeId, clientKey(req), "read-metadata")) { securityEvent(share.summary.shareId, clientKey(req), "acl-deny-metadata"); json(res, 403, { error: "Access denied by Broker ACL." }); return; }
      verifyProtectedSecret(req, share);
      if (proof) recordSubscriber(req, proof, "request");
    }
    catch (error) { securityEvent(share.summary.shareId, clientKey(req), "invalid-subscriber-proof"); json(res, 401, { error: error instanceof Error ? error.message : String(error) }); return; }
    const etag = `"${share.summary.collectionHash}"`;
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, { ETag: etag, "X-PKM-Revision": String(share.summary.revision) }); res.end(); return; }
    if (req.method === "HEAD") { res.writeHead(200, { ETag: etag, "X-PKM-Revision": String(share.summary.revision), "Content-Length": "0" }); res.end(); return; }
    json(res, 200, share.summary, { ETag: etag, "X-PKM-Revision": String(share.summary.revision) });
    return;
  }
  const ticketMatch = /^\/v1\/shares\/([a-zA-Z0-9_-]{8,128})\/sync-ticket$/.exec(url.pathname);
  if (ticketMatch && req.method === "POST") {
    const share = findShare(ticketMatch[1]);
    if (!share || !inControlScope(share, scope)) { json(res, 404, { error: "Share not found." }); return; }
    if (!safeEqualHash(share.snapshotPath, share.summary.collectionHash)) { json(res, 409, { error: "Share snapshot is unavailable." }); return; }
    try {
      const proof = subscriberProof(req, share.summary.shareId, true)!;
      if (!await aclAllowed(share, proof.nodeId, clientKey(req), "request-sync")) throw new GatewayRequestError("Access denied by Broker ACL.", 403);
      verifyProtectedSecret(req, share);
      checkTicketRate(proof);
      recordSubscriber(req, proof, "ticket");
      const transfer = await createTransferBroker(share, proof);
      json(res, 200, { ...transfer, revision: share.summary.revision, collectionHash: share.summary.collectionHash });
    } catch (error) {
      securityEvent(share.summary.shareId, clientKey(req), error instanceof Error ? error.message : String(error));
      const status = error instanceof GatewayRequestError ? error.status : 429;
      const retryAfter = error instanceof GatewayRequestError ? error.retryAfter : "15";
      json(res, status, { error: error instanceof Error ? error.message : String(error) }, retryAfter ? { "Retry-After": retryAfter } : {});
    }
    return;
  }
  json(res, 404, { error: "Not found." });
}

async function main(): Promise<void> {
  const broker = await Aedes.createBroker({ drainTimeout: 15_000 });
  let publishedShareIds = new Set<string>();
  const listeners = new Map<string, { port: number; server: Server; webSockets: WebSocketServer }>();
  broker.authenticate = (client, _username, password, callback) => {
    try {
      const proof = parseSubscriberProof(Buffer.from(password || "").toString("utf8"), "*", true)!;
      (client as any).pkmSubscriberProof = proof;
      callback(null, true);
    } catch { callback(null, false); }
  };
  broker.authorizePublish = (client, _packet, callback) => callback(client ? new Error("Remote publishing is disabled.") : null);
  broker.authorizeSubscribe = (_client, subscription, callback) => {
    const match = /^pkm\/v1\/nodes\/[a-zA-Z0-9:_-]+\/shares\/([a-zA-Z0-9_-]{8,128})\/summary$/.exec(subscription.topic);
    const share = match ? findShare(match[1]) : undefined;
    const remoteIp = String((_client as any)?.conn?.remoteAddress || "");
    const localPort = Number((_client as any)?.conn?.localPort || 0);
    const expectedPort = share?.protection === "secret-protected" ? share.controlPort : state.port;
    const identity = (_client as any)?.pkmSubscriberProof as SubscriberProof | undefined;
    void (async () => {
      const allowed = !!share && localPort === expectedPort && await aclAllowed(share, identity?.nodeId, remoteIp, "mqtt-subscribe");
      if (share && !allowed) securityEvent(share.summary.shareId, remoteIp, "acl-deny-mqtt-subscribe");
      callback(null, allowed ? subscription : null);
    })().catch(() => callback(null, null));
  };

  const startListener = async (scope: ControlScope, port: number): Promise<void> => {
    const server = createServer((req, res) => { void handle(req, res, scope).catch(error => json(res, 500, { error: error instanceof Error ? error.message : String(error) })); });
    server.headersTimeout = 5_000; server.requestTimeout = 15_000; server.keepAliveTimeout = 5_000;
    const webSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname !== "/mqtt" || !String(req.headers["sec-websocket-protocol"] || "").split(/\s*,\s*/).includes("mqtt")) { socket.destroy(); return; }
      webSockets.handleUpgrade(req, socket, head, ws => broker.handle(createWebSocketStream(ws), req));
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, state.bindHost || "0.0.0.0", resolve); });
    listeners.set(scope, { port, server, webSockets });
  };
  const stopListener = async (scope: string): Promise<void> => {
    const listener = listeners.get(scope); if (!listener) return;
    listeners.delete(scope); listener.webSockets.close();
    await new Promise<void>(resolve => listener.server.close(() => resolve()));
  };
  const reconcileListeners = async (): Promise<void> => {
    const desired = new Map<string, number>([["open", state.port]]);
    for (const share of state.shares) if (share.protection === "secret-protected") desired.set(share.summary.shareId, share.controlPort);
    for (const [scope, listener] of [...listeners]) if (desired.get(scope) !== listener.port) await stopListener(scope);
    for (const [scope, port] of desired) if (!listeners.has(scope)) await startListener(scope, port);
  };

  const publishSummaries = (): void => {
    const currentShareIds = new Set(state.shares.map(share => share.summary.shareId));
    for (const previousShareId of publishedShareIds) {
      if (!currentShareIds.has(previousShareId)) broker.publish({ cmd: "publish", topic: `pkm/v1/nodes/${state.nodeId}/shares/${previousShareId}/summary`, payload: Buffer.alloc(0), qos: 1, retain: true, dup: false }, () => {});
    }
    for (const share of state.shares) broker.publish({ cmd: "publish", topic: `pkm/v1/nodes/${state.nodeId}/shares/${share.summary.shareId}/summary`, payload: Buffer.from(JSON.stringify(share.summary)), qos: 1, retain: true, dup: false }, () => {});
    publishedShareIds = currentShareIds;
  };
  const reload = async (): Promise<void> => { state = readState(); await reconcileListeners(); publishSummaries(); };
  let reloadTimer: NodeJS.Timeout | undefined;
  const scheduleReload = (): void => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { reloadTimer = undefined; void reload().catch(() => { /* retain last valid state */ }); }, 250);
    reloadTimer.unref?.();
  };
  let stateWatcher: ReturnType<typeof watch> | undefined;
  let pollingFallback = false;
  try {
    stateWatcher = watch(dirname(statePath), (_event, filename) => {
      if (!filename || filename.toString() === basename(statePath)) scheduleReload();
    });
  } catch {
    pollingFallback = true;
    watchFile(statePath, { interval: 10_000 }, scheduleReload);
  }
  await reconcileListeners();
  publishSummaries();
  process.stdout.write(`READY ${state.nodeId} ${state.port}\n`);

  const shutdown = () => { stateWatcher?.close(); if (pollingFallback) unwatchFile(statePath, scheduleReload); if (reloadTimer) clearTimeout(reloadTimer); void Promise.all([...listeners.keys()].map(stopListener)).then(() => broker.close(() => process.exit(0))); setTimeout(() => process.exit(1), 5_000).unref(); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", () => { void reload().catch(() => { /* the file watcher provides a retry */ }); });
}

void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`); process.exit(1); });
