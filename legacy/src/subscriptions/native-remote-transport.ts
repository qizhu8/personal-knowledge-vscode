import { createHmac, randomBytes, scryptSync } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { MAX_SUBSCRIPTION_CACHE_BYTES, SharedMarketManager, verifyShareSummary, type ShareSummary } from "./subscriptions";

export interface NativeSubscriptionNetworkPolicy {
  control(url: URL, nodeId: string, shareId: string): boolean;
  transfer(url: URL, control: URL, nodeId: string, shareId: string): boolean;
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body || Number(response.headers.get("content-length") || 0) > limit)
    throw new Error("Subscription response exceeds its limit.");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.length;
      if (total > limit) throw new Error("Subscription response exceeds its limit.");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

/**
 * Legacy gateways bind protected transfer keys to the subscriber identity.
 * The experimental native host supplies an explicit network policy and keeps
 * the original manager's mutation lock across the entire pull.
 */
export function installNativeRemoteSubscriptionTransport(
  manager: SharedMarketManager, profile: string, policy: NativeSubscriptionNetworkPolicy,
): void {
  if (process.platform !== "linux" || process.env.PKM_EXPERIMENTAL_SUBSCRIPTION_HOST !== "1"
    || path.resolve(profile) !== profile || fs.realpathSync(profile) !== profile
    || typeof policy.control !== "function" || typeof policy.transfer !== "function")
    throw new Error("Native Subscription transport is unavailable.");
  const instance = manager as any;
  const stat = fs.lstatSync(profile), actual = fs.lstatSync(instance.storageDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || (stat.mode & 0o077) !== 0 || !actual.isDirectory() || actual.isSymbolicLink()
    || actual.dev !== stat.dev || actual.ino !== stat.ino) throw new Error("Native Subscription profile is invalid.");
  const original = instance.downloadSnapshot.bind(instance);
  const controlEndpoint = (record: any): URL => {
    const control = new URL(record.endpoint);
    if (!["http:", "https:"].includes(control.protocol) || control.username || control.password
      || control.pathname !== "/" || control.search || control.hash
      || !policy.control(control, record.nodeId, record.shareId)) throw new Error("Subscription endpoint denied.");
    return control;
  };
  instance.refresh = async (id: string, forceDownload = false) => {
    if (!instance.stateMutationDepth) return instance.withStateMutation(() => instance.refresh(id, forceDownload));
    const record = instance.requireSubscription(id);
    if (record.source?.type === "github") throw new Error("GitHub subscriptions require their configured connection.");
    const control = controlEndpoint(record);
    const previousStatus = record.status, previousError = record.error;
    record.status = "updating"; record.error = undefined; instance.save();
    try {
      const proof = instance.subscriberProof(record.shareId);
      const headers: Record<string, string> = { ...(record.etag && !forceDownload ? { "If-None-Match": record.etag } : {}),
        "X-PKM-Subscriber-Proof": proof };
      if (record.secretProtected) {
        const material = await instance.secrets?.get(instance.subscriberSecretKey(record.nodeId, record.shareId));
        if (!material || !record.secretSalt) throw new Error("Secret Protected Broker requires its additional secret.");
        const base = scryptSync(material, Buffer.from(record.secretSalt, "base64url"), 32);
        const verifier = createHmac("sha256", base).update("pkm-share-auth:v1").digest();
        try { headers["X-PKM-Share-Secret-Proof"] = createHmac("sha256", verifier).update(proof).digest("base64url"); }
        finally { base.fill(0); verifier.fill(0); }
      }
      const response = await fetch(`${control.origin}/v1/shares/${encodeURIComponent(record.shareId)}/summary`,
        { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
      record.lastChecked = new Date().toISOString();
      if (response.status === 304 && !forceDownload) {
        record.status = "current"; record.error = undefined; instance.warned.delete(`remote:${record.id}`); instance.save();
        if (previousStatus !== record.status || previousError) instance.changed();
        return record;
      }
      if (!response.ok) throw new Error(`Broker returned ${response.status}.`);
      const summary = await boundedJson(response, 2 * 1024 * 1024) as ShareSummary;
      verifyShareSummary(summary, record.publicKey, record.nodeId, record.shareId);
      if (!!summary.secretProtected !== !!record.secretProtected || summary.secretProtected && summary.secretSalt !== record.secretSalt)
        throw new Error("Broker secret does not match the published protected revision.");
      record.brokerName = summary.name;
      const changed = forceDownload || summary.revision !== record.revision || summary.collectionHash !== record.collectionHash;
      record.etag = response.headers.get("etag") || `"${summary.collectionHash}"`;
      record.topics = summary.topics; record.tags = summary.tags; record.counts = summary.counts; record.itemCount = summary.itemCount;
      if (changed) await instance.downloadSnapshot(record, summary);
      record.revision = summary.revision; record.collectionHash = summary.collectionHash; record.status = "current"; record.error = undefined;
      instance.warned.delete(`remote:${record.id}`); instance.save(); instance.changed(); return record;
    } catch (error) {
      record.status = "offline"; record.error = error instanceof Error ? error.message : String(error); instance.save();
      if (previousStatus !== record.status || previousError !== record.error) instance.changed();
      if (previousStatus !== "offline") instance.warning(`remote:${record.id}`,
        `Subscription "${record.alias || record.publisher || record.shareId}" cannot reach Broker ${record.endpoint}. Cached content remains available.`);
      throw error;
    }
  };
  instance.downloadSnapshot = async (record: any, summary: any) => {
    if (record.nodeId === instance.state.nodeId) return original(record, summary);
    if (!/^[a-f0-9]{64}$/.test(record.nodeId) || !/^[a-f0-9]{64}$/.test(instance.state.nodeId)
      || !/^[A-Za-z0-9_-]{1,128}$/.test(record.shareId)
      || Number(summary.snapshotBytes || 0) > MAX_SUBSCRIPTION_CACHE_BYTES)
      throw new Error("Native Subscription target is invalid.");
    const control = controlEndpoint(record);
    const proof = instance.subscriberProof(record.shareId) as string;
    let verifier: Buffer | undefined, contentKey: Buffer | undefined, transferKey: Buffer | undefined, downloadPath: string | undefined;
    const started = Date.now(), memory = process.memoryUsage();
    try {
      const headers: Record<string, string> = { "X-PKM-Subscriber-Proof": proof };
      if (summary.secretProtected) {
        const secret = await instance.secrets?.get(instance.subscriberSecretKey(record.nodeId, record.shareId));
        if (!secret || !summary.secretSalt) throw new Error("Secret Protected Broker keys are missing.");
        const base = scryptSync(secret, Buffer.from(summary.secretSalt, "base64url"), 32);
        try {
          verifier = createHmac("sha256", base).update("pkm-share-auth:v1").digest();
          contentKey = createHmac("sha256", base).update("pkm-share-content:v1").digest();
        } finally { base.fill(0); }
        headers["X-PKM-Share-Secret-Proof"] = createHmac("sha256", verifier).update(proof).digest("base64url");
      }
      const response = await fetch(`${control.origin}/v1/shares/${encodeURIComponent(record.shareId)}/sync-ticket`,
        { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Sync ticket request returned ${response.status}.`);
      const ticket = await boundedJson(response, 64 * 1024) as { brokerUrl: string; ticket: string; collectionHash: string; revision: number };
      if (typeof ticket.ticket !== "string" || !ticket.ticket || ticket.ticket.length > 4096
        || ticket.collectionHash !== summary.collectionHash || ticket.revision !== summary.revision)
        throw new Error("Broker revision changed before Sync started.");
      const broker = new URL(ticket.brokerUrl);
      if (!["http:", "https:"].includes(broker.protocol) || !broker.port || broker.port === control.port
        || broker.username || broker.password || broker.pathname !== "/" || broker.search || broker.hash
        || !policy.transfer(broker, control, record.nodeId, record.shareId)) throw new Error("Subscription transfer endpoint denied.");
      const bundle = await fetch(`${broker.origin}/sync/bundle`, {
        headers: { Authorization: `Bearer ${ticket.ticket}` }, redirect: "error", signal: AbortSignal.timeout(120_000),
      });
      if (!bundle.ok || !bundle.body || Number(bundle.headers.get("content-length") || 0) > MAX_SUBSCRIPTION_CACHE_BYTES + 64 * 1024)
        throw new Error("Subscription transfer is unavailable or exceeds its limit.");
      const downloads = path.join(profile, "downloads");
      fs.mkdirSync(downloads, { recursive: true, mode: 0o700 });
      const dir = fs.lstatSync(downloads);
      if (!dir.isDirectory() || dir.isSymbolicLink() || fs.realpathSync(downloads) !== downloads)
        throw new Error("Subscription download directory is invalid.");
      downloadPath = path.join(downloads, `${record.shareId}.${randomBytes(6).toString("hex")}.download`);
      const fd = fs.openSync(downloadPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      let downloaded = 0;
      const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        downloaded += chunk.length;
        if (downloaded > MAX_SUBSCRIPTION_CACHE_BYTES + 64 * 1024) callback(new Error("Subscription transfer exceeds its limit."));
        else callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(bundle.body as any), limit, fs.createWriteStream(downloadPath, { fd, autoClose: true }));
      if (summary.secretProtected) {
        if (!verifier || !contentKey) throw new Error("Secret Protected Broker keys are missing.");
        transferKey = createHmac("sha256", verifier)
          .update(`pkm-transfer:v1:${instance.state.nodeId}:${record.shareId}:${summary.revision}:${Number(broker.port)}:${ticket.ticket}`).digest();
      }
      const syncedAt = new Date().toISOString();
      const snapshotBytes = await instance.materializeInChild({ inputPath: downloadPath, storageDir: profile,
        record: { id: record.id, alias: record.alias, priority: record.priority, publisher: record.publisher,
          nodeId: record.nodeId, shareId: record.shareId, endpoint: record.endpoint },
        summary, syncedAt, transferKey: transferKey?.toString("base64url"), contentKey: contentKey?.toString("base64url") });
      record.lastUpdated = syncedAt;
      instance.operationDiagnostic("download", started, memory, { shareId: record.shareId, revision: summary.revision,
        snapshotBytes, transferBytes: downloaded, itemCount: summary.itemCount, isolatedProcess: true });
    } finally {
      if (downloadPath) fs.rmSync(downloadPath, { force: true });
      verifier?.fill(0); contentKey?.fill(0); transferKey?.fill(0);
    }
  };
}
