import { createHmac, randomBytes, scryptSync } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { MAX_SUBSCRIPTION_CACHE_BYTES, SharedMarketManager } from "../subscriptions/subscriptions";

/** Correct the historical transfer-key identity only inside the isolated remote fixture. */
export function installRemoteSubscriptionFixtureTransport(manager: SharedMarketManager, fixture: string): void {
  if (process.platform !== "linux" || process.env.PKM_PRIVATE_SUBSCRIPTION_REMOTE !== "1"
    || process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT !== fixture || path.resolve(fixture) !== fixture
    || !/^pkm-protected-state-fixture-[a-f0-9-]{36}$/.test(path.basename(fixture))) {
    throw new Error("Private remote Subscription transport denied.");
  }
  const instance = manager as any;
  const rawStorageDir = instance.storageDir as string;
  const storageDir = fs.realpathSync(rawStorageDir);
  const expected = path.join(fixture, "profile");
  const mounted = path.join(fixture, "u/User/globalStorage/uone.personal-knowledge/subscriptions");
  const fixtureStat = fs.lstatSync(fixture);
  const source = fs.lstatSync(expected), actual = fs.lstatSync(storageDir);
  if (!fixtureStat.isDirectory() || fixtureStat.isSymbolicLink() || fs.realpathSync(fixture) !== fixture
    || fixtureStat.uid !== process.getuid?.() || (fixtureStat.mode & 0o7077) !== 0
    || !actual.isDirectory() || actual.isSymbolicLink() || ![expected, mounted].includes(storageDir)
    || !source.isDirectory() || source.isSymbolicLink() || fs.realpathSync(expected) !== expected
    || source.uid !== process.getuid?.() || (source.mode & 0o7077) !== 0
    || actual.dev !== source.dev || actual.ino !== source.ino) {
    throw new Error("Private remote Subscription transport denied.");
  }
  const original = instance.downloadSnapshot.bind(instance);
  instance.downloadSnapshot = async (record: any, summary: any) => {
    if (record.nodeId === instance.state.nodeId) return original(record, summary);
    const started = Date.now(), memory = process.memoryUsage();
    if (Number(summary.snapshotBytes || 0) > MAX_SUBSCRIPTION_CACHE_BYTES)
      throw new Error("Subscription snapshot exceeds the safety limit.");
    if (!/^[a-f0-9]{64}$/.test(record.nodeId) || !/^[A-Za-z0-9_-]{1,128}$/.test(record.shareId))
      throw new Error("Private remote identity denied.");
    const endpoint = new URL(record.endpoint);
    if (endpoint.origin !== "http://127.0.0.1:23002" || endpoint.username || endpoint.password
      || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) throw new Error("Private remote endpoint denied.");
    const proof = instance.subscriberProof(record.shareId) as string;
    let verifier: Buffer | undefined, contentKey: Buffer | undefined, transferKey: Buffer | undefined;
    let downloadPath: string | undefined;
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
      const ticketResponse = await fetch(`${record.endpoint}/v1/shares/${encodeURIComponent(record.shareId)}/sync-ticket`,
        { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!ticketResponse.ok) throw new Error(`Sync ticket request returned ${ticketResponse.status}.`);
      const ticket = await ticketResponse.json() as { brokerUrl: string; ticket: string; collectionHash: string; revision: number };
      if (ticket.collectionHash !== summary.collectionHash || ticket.revision !== summary.revision)
        throw new Error("Broker revision changed before Sync started.");
      const broker = new URL(ticket.brokerUrl);
      if (broker.protocol !== "http:" || broker.hostname !== "127.0.0.1" || !broker.port
        || broker.port === endpoint.port || broker.username || broker.password || broker.pathname !== "/"
        || broker.search || broker.hash) throw new Error("Private remote transfer endpoint denied.");
      const response = await fetch(`${broker.origin}/sync/bundle`, {
        headers: { Authorization: `Bearer ${ticket.ticket}` }, redirect: "error", signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`Background Sync returned ${response.status}.`);
      if (Number(response.headers.get("content-length") || 0) > MAX_SUBSCRIPTION_CACHE_BYTES + 64 * 1024 || !response.body)
        throw new Error("Background Sync payload is unavailable or exceeds the safety limit.");
      const downloads = path.join(storageDir, "downloads");
      fs.mkdirSync(downloads, { recursive: true });
      const downloadsStat = fs.lstatSync(downloads);
      if (!downloadsStat.isDirectory() || downloadsStat.isSymbolicLink() || fs.realpathSync(downloads) !== downloads)
        throw new Error("Private remote download directory denied.");
      const file = path.join(downloads, `${record.shareId}.${randomBytes(6).toString("hex")}.download`);
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      downloadPath = file;
      let downloadedBytes = 0;
      const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        downloadedBytes += chunk.length;
        if (downloadedBytes > MAX_SUBSCRIPTION_CACHE_BYTES + 64 * 1024)
          callback(new Error("Background Sync payload exceeds the safety limit."));
        else callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body as any), limit, fs.createWriteStream(downloadPath, { fd, autoClose: true }));
      if (summary.secretProtected) {
        if (!verifier || !contentKey) throw new Error("Secret Protected Broker keys are missing.");
        transferKey = createHmac("sha256", verifier)
          .update(`pkm-transfer:v1:${instance.state.nodeId}:${record.shareId}:${summary.revision}:${Number(broker.port)}:${ticket.ticket}`).digest();
      }
      const syncedAt = new Date().toISOString();
      const snapshotBytes = await instance.materializeInChild({
        inputPath: downloadPath, storageDir, record: {
          id: record.id, alias: record.alias, priority: ["normal", "high", "highest"].includes(record.priority) ? record.priority : "normal",
          publisher: record.publisher, nodeId: record.nodeId, shareId: record.shareId, endpoint: record.endpoint,
        },
        summary, syncedAt, transferKey: transferKey?.toString("base64url"), contentKey: contentKey?.toString("base64url"),
      });
      record.lastUpdated = syncedAt;
      instance.operationDiagnostic("download", started, memory, { shareId: record.shareId, revision: summary.revision,
        snapshotBytes, transferBytes: downloadedBytes, itemCount: summary.itemCount, isolatedProcess: true });
    } finally {
      if (downloadPath) fs.rmSync(downloadPath, { force: true });
      verifier?.fill(0); contentKey?.fill(0); transferKey?.fill(0);
    }
  };
}
