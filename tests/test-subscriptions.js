#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { createHmac, randomBytes, scryptSync, sign } = require("crypto");
const filestore = require("../dist/filestore");
const storage = require("../dist/storage");
const servers = require("../dist/servers");
const { SharedMarketManager, parseShareMagicLink, verifyShareSummary } = require("../dist/subscriptions");

class MemorySecretStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async store(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitUntil(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Condition timed out");
}

function subscriberProof(statePath, shareId) {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const unsigned = { schema: 1, nodeId: state.nodeId, name: state.displayName, publicKey: state.publicKey, shareId, timestamp: Date.now(), nonce: randomBytes(12).toString("base64url") };
  return Buffer.from(JSON.stringify({ ...unsigned, signature: sign(null, Buffer.from(JSON.stringify(unsigned)), state.privateKey).toString("base64url") })).toString("base64url");
}

function secretProof(material, salt, identityProof) {
  const base = scryptSync(material, Buffer.from(salt, "base64url"), 32);
  const verifier = createHmac("sha256", base).update("pkm-share-auth:v1").digest();
  return createHmac("sha256", verifier).update(identityProof).digest("base64url");
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-subscriptions-test-"));
  const store = path.join(root, "store");
  const state = path.join(root, "state");
  fs.mkdirSync(store, { recursive: true });
  filestore.setStorePath(store);
  storage.setStorePath(store);
  const serversRoot = path.join(store, "servers");
  const sampleServer = path.join(serversRoot, "sample-api");
  const sampleServerPort = await freePort();
  fs.mkdirSync(sampleServer, { recursive: true });
  fs.writeFileSync(path.join(sampleServer, "server.json"), JSON.stringify({ name: "Sample API", command: "{python} app.py --port {port}", port: sampleServerPort, python: "/private/machine/python", autostart: true, category: "Team/APIs", tags: ["api"] }));
  fs.writeFileSync(path.join(sampleServer, "app.py"), "print('portable server source')\n");
  servers.initServers(serversRoot, path.join(root, "server-state"), await freePort());
  filestore.skillUpsert({ name: "Shared Skill", description: "Metadata only summary", category: "Research/AAGL", tags: ["aagl", "pipeline"], content: "SECRET BODY MUST NOT ENTER CONTROL SIGNAL" });
  filestore.noteUpsert({ slug: "", title: "Indexed Note", type: "general", tags: [], content: "INDEXED NOTE BODY" });
  assert.strictEqual(filestore.noteList(undefined, 10)[0].content, undefined, "noteList must remain metadata-only by default");
  assert.strictEqual(filestore.noteList(undefined, 10, true)[0].content, "INDEXED NOTE BODY", "internal link indexing may opt into parsed content");
  fs.mkdirSync(path.join(store, "packages", "shared-tool", "src"), { recursive: true });
  fs.writeFileSync(path.join(store, "packages", "shared-tool", "README.md"), "# Shared Tool\n");
  fs.writeFileSync(path.join(store, "packages", "shared-tool", "src", "tool.py"), "VALUE = 42\n");
  const warnings = [];
  let changedEvents = 0;
  const secretStorage = new MemorySecretStorage();
  const manager = new SharedMarketManager(state, path.join(__dirname, "..", "dist", "subscription-gateway.js"), "PKM Test Node", {
    onWarning: message => warnings.push(message),
    onChanged: () => { changedEvents += 1; },
  }, secretStorage, { user: "alice", host: "host-a" });
  const port = await freePort();
  try {
    await manager.configure({ enabled: false, port, advertisedHost: "127.0.0.1", displayName: "PKM Test Node" });
    const share = await manager.upsertShare({ name: "AAGL Context", visibility: "public", contentTypes: ["skills", "packages", "servers"], selected: { skills: ["Shared Skill"], packages: ["shared-tool"], servers: ["sample-api"] } });
    assert.strictEqual(share.revision, 1);
    assert.deepStrictEqual(share.summary.counts, { skills: 1, packages: 1, servers: 1 });
    assert(share.summary.topics.includes("Research/AAGL"));
    assert(share.summary.tags.includes("aagl"));
    assert.strictEqual(share.summary.metadataOnly, true);
    assert(!JSON.stringify(share.summary).includes("SECRET BODY"), "control summary must not contain content");

    const magicLink = manager.magicLink(share.shareId);
    const parsed = parseShareMagicLink(magicLink);
    assert.strictEqual(parsed.shareId, share.shareId);
    verifyShareSummary(share.summary, parsed.publicKey, parsed.nodeId, parsed.shareId);

    await manager.setGatewayOnline(true);
    const nodeResponse = await fetch(`http://127.0.0.1:${port}/.well-known/pkm-node`);
    assert.strictEqual(nodeResponse.status, 200);
    const node = await nodeResponse.json();
    assert.strictEqual(node.nodeId, parsed.nodeId);
    const commonDataResponse = await fetch(`http://127.0.0.1:${port}/sync/bundle`);
    assert.strictEqual(commonDataResponse.status, 404, "Common Communication Port must never serve content bundles");
    const statePath = path.join(state, "subscriptions.json");
    const unauthorizedTicket = await fetch(`http://127.0.0.1:${port}/v1/shares/${share.shareId}/sync-ticket`, { method: "POST" });
    assert.strictEqual(unauthorizedTicket.status, 401, "Data Broker discovery requires signed Subscriber identity");
    const transferResponse = await fetch(`http://127.0.0.1:${port}/v1/shares/${share.shareId}/sync-ticket`, { method: "POST", headers: { "X-PKM-Subscriber-Proof": subscriberProof(statePath, share.shareId) } });
    assert.strictEqual(transferResponse.status, 200);
    const transfer = await transferResponse.json();
    const transferUrl = new URL(transfer.brokerUrl);
    assert.notStrictEqual(Number(transferUrl.port), port, "Common Port must return a separate temporary Data Broker port");
    const directBundle = await fetch(`${transfer.brokerUrl}/sync/bundle`, { headers: { Authorization: `Bearer ${transfer.ticket}` } });
    assert.strictEqual(directBundle.status, 200);
    assert.strictEqual(Buffer.from(await directBundle.arrayBuffer()).length > 0, true);
    await waitUntil(async () => {
      try { await fetch(`${transfer.brokerUrl}/sync/bundle`, { signal: AbortSignal.timeout(100) }); return false; }
      catch { return true; }
    });

    const subscribed = await manager.subscribe(manager.magicLink(share.shareId), "AAGL Team Context");
    assert.strictEqual(subscribed.alias, "AAGL Team Context");
    assert.strictEqual(subscribed.revision, 1);
    assert.strictEqual(subscribed.status, "current");
    assert.strictEqual(subscribed.brokerName, "AAGL Context");
    assert.strictEqual(subscribed.publisherUser, "alice");
    assert.strictEqual(subscribed.publisherHost, "host-a");
    assert.strictEqual(manager.snapshot.subscriptions[0].brokerName, "AAGL Context");
    manager.state.subscriptions[0].brokerName = undefined;
    assert.strictEqual(manager.snapshot.subscriptions[0].brokerName, "AAGL Context", "legacy records must recover Broker name from cached summary");
    manager.state.subscriptions[0].brokerName = "AAGL Context";
    manager.renameSubscription(subscribed.id, "My Creative Context");
    assert.strictEqual(manager.snapshot.subscriptions[0].alias, "My Creative Context");
    assert.strictEqual(manager.snapshot.subscriptions[0].brokerName, "AAGL Context", "Subscriber rename must not alter the published Broker name");
    const cached = path.join(state, "cache", subscribed.nodeId, subscribed.shareId, "bundle.json");
    assert(fs.existsSync(cached), "background Sync must populate the machine-local subscription cache");
    assert(JSON.parse(fs.readFileSync(cached, "utf8")).skills[0].content.includes("SECRET BODY"));
    const cachedSkill = path.join(state, "cache", subscribed.nodeId, subscribed.shareId, "content", "skills", "Research", "AAGL", "Shared Skill.md");
    assert(fs.existsSync(cachedSkill), "subscribed Skills must be materialized as isolated Markdown files");
    const provenance = JSON.parse(fs.readFileSync(`${cachedSkill}.pkm-source.json`, "utf8"));
    assert.strictEqual(provenance.subscriptionAlias, "AAGL Team Context");
    assert.strictEqual(provenance.publisher, "PKM Test Node");
    assert.strictEqual(provenance.brokerName, "AAGL Context");
    assert.strictEqual(provenance.shareId, share.shareId);
    assert.strictEqual(provenance.revision, 1);
    assert(provenance.syncedAt);
    assert(!fs.existsSync(path.join(store, "skills", "_subscriptions")), "subscription refresh must never write into the Knowledge Root");
    const packageGroups = manager.cachedGroups("packages");
    assert.strictEqual(packageGroups.length, 1);
    assert.strictEqual(packageGroups[0].alias, "My Creative Context", "subscribed groups must use the Subscriber-local name");
    assert.strictEqual(manager.cachedGroups("skills")[0].alias, "My Creative Context");
    const serverGroups = manager.cachedGroups("servers");
    assert.strictEqual(serverGroups[0].alias, "My Creative Context");
    assert.strictEqual(serverGroups[0].items.length, 1, "each subscribed Server must aggregate into one link row");
    assert.strictEqual(serverGroups[0].items[0].title, "Sample API");
    assert.strictEqual(serverGroups[0].items[0].path, "sample-api/server.link.json");
    assert.strictEqual(packageGroups[0].items.length, 1, "subscribed package files must aggregate into one package row");
    assert.strictEqual(packageGroups[0].items[0].title, "shared-tool");
    const packageFork = manager.forkSource(packageGroups[0].items[0].key);
    assert.strictEqual(packageFork.brokerName, "AAGL Context");
    assert.strictEqual(packageFork.publisherUser, "alice");
    assert.strictEqual(packageFork.publisherHost, "host-a");
    assert.deepStrictEqual(packageFork.package.files.map(file => file.path).sort(), ["README.md", "src/tool.py"]);
    const skillKey = manager.cachedGroups("skills")[0].items[0].key;
    const skillFork = manager.forkSource(skillKey);
    assert.strictEqual(skillFork.brokerName, "AAGL Context");
    assert.strictEqual(skillFork.publisherUser, "alice");
    assert.strictEqual(skillFork.publisherHost, "host-a");
    assert.strictEqual(skillFork.remotePath, "Research/AAGL/Shared Skill.md");
    const skillFolderFork = manager.forkFolderSource([skillKey], "Research/AAGL");
    assert.strictEqual(skillFolderFork.remotePath, "Research/AAGL");
    assert.strictEqual(skillFolderFork.publisherUser, "alice");
    assert.strictEqual(skillFolderFork.publisherHost, "host-a");
    assert.deepStrictEqual(skillFolderFork.folder.files, [{ path: "Shared Skill.md", content: "SECRET BODY MUST NOT ENTER CONTROL SIGNAL" }]);
    const wholeBrokerFork = manager.forkFolderSource(manager.cachedGroups("skills")[0].items.map(item => item.key), "");
    assert.strictEqual(wholeBrokerFork.folder.path, "");
    assert.deepStrictEqual(wholeBrokerFork.folder.files, [{ path: "Research/AAGL/Shared Skill.md", content: "SECRET BODY MUST NOT ENTER CONTROL SIGNAL" }]);
    assert.throws(() => manager.forkFolderSource([skillKey], "Research/Other"), /outside the selected folder/);
    const cachedLink = path.join(state, "cache", subscribed.nodeId, subscribed.shareId, "content", "servers", "sample-api", "server.link.json");
    const linkMetadata = JSON.parse(fs.readFileSync(cachedLink, "utf8"));
    assert.strictEqual(linkMetadata.name, "Sample API");
    assert.strictEqual(linkMetadata.url, `http://127.0.0.1:${sampleServerPort}/`);
    assert.strictEqual(linkMetadata.links, undefined, "Server subscriptions must expose only one Broker-address link");
    assert.strictEqual(linkMetadata.command, undefined, "Server subscriptions must not expose commands");
    assert.strictEqual(linkMetadata.files, undefined, "Server subscriptions must not expose source files");
    assert.strictEqual(fs.existsSync(path.join(path.dirname(cachedLink), "app.py")), false, "Server source code must not enter the subscription cache");
    const trustedLinks = manager.cachedServerLinks(serverGroups[0].items[0].key);
    assert.strictEqual(trustedLinks.name, "Sample API");
    assert.deepStrictEqual(trustedLinks.links, [{ label: "Broker Server Link", url: `http://127.0.0.1:${sampleServerPort}/` }]);
    const cachedBundleJson = JSON.parse(fs.readFileSync(cached, "utf8"));
    assert.strictEqual(cachedBundleJson.servers[0].command, undefined);
    assert.strictEqual(cachedBundleJson.servers[0].files, undefined);
    const brokerStats = manager.snapshot.shares.find(item => item.shareId === share.shareId);
    assert.strictEqual(brokerStats.subscribers.length, 1, "Broker must maintain a stable Subscriber node list");
    assert.strictEqual(brokerStats.subscribers[0].name, "PKM Test Node");
    assert(brokerStats.subscribers[0].syncCount >= 2, "Broker must count successful background Sync transfers");
    assert(brokerStats.subscribers[0].lastIp);

    manager.renameSubscription(subscribed.id, "Renamed Alias");
    assert.strictEqual(manager.snapshot.subscriptions[0].alias, "Renamed Alias");
    assert.strictEqual(manager.cachedGroups("skills")[0].alias, "Renamed Alias");
    assert.strictEqual(manager.cachedGroups("packages")[0].alias, "Renamed Alias");
    assert.strictEqual(manager.cachedGroups("servers")[0].alias, "Renamed Alias");
    manager.renameSubscription(subscribed.id, "");
    assert.strictEqual(manager.cachedGroups("skills")[0].alias, "AAGL Context", "clearing the local name must restore the published Broker name");
    manager.renameSubscription(subscribed.id, "Renamed Alias");
    filestore.skillUpsert({ name: "Shared Skill", description: "Updated", category: "Research/AAGL", tags: ["aagl", "updated"], content: "REVISION TWO" });
    const updated = await manager.upsertShare({ shareId: share.shareId, name: share.name, contentTypes: ["skills"], selected: { skills: ["Shared Skill"] } });
    assert.strictEqual(updated.revision, 2);
    await waitUntil(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/shares/${share.shareId}/summary`);
      return response.ok && (await response.json()).revision === 2;
    });
    await manager.refresh(subscribed.id, true);
    assert.strictEqual(manager.snapshot.subscriptions[0].revision, 2);
    assert(fs.readFileSync(cached, "utf8").includes("REVISION TWO"));
    assert(!JSON.stringify(updated.summary).includes("REVISION TWO"));

    const folderShare = await manager.upsertShare({ name: "Dynamic AAGL Folder", contentTypes: ["skills"], selected: {}, folders: { skills: ["Research/AAGL"] } });
    filestore.skillUpsert({ name: "Future Folder Skill", category: "Research/AAGL", tags: ["future"], content: "ADDED AFTER FOLDER SHARE" });
    filestore.skillUpsert({ name: "Outside Skill", category: "Research/Other", tags: [], content: "MUST STAY OUTSIDE" });
    const changed = await manager.refreshPublishedShares();
    assert.strictEqual(changed, 1, "only the dynamic folder Share should publish a new revision");
    const refreshedFolderShare = manager.snapshot.shares.find(item => item.shareId === folderShare.shareId);
    assert.strictEqual(refreshedFolderShare.revision, 2);
    const folderBundle = JSON.parse(fs.readFileSync(refreshedFolderShare.snapshotPath, "utf8"));
    assert(folderBundle.skills.some(item => item.name === "Future Folder Skill"), "folder-level Share must include future files");
    assert(!folderBundle.skills.some(item => item.name === "Outside Skill"), "folder-level Share must not escape its folder");
    const exactShare = manager.snapshot.shares.find(item => item.shareId === share.shareId);
    assert.strictEqual(exactShare.revision, 2, "exact file Share must not change when a sibling is added");
    const exactBundle = JSON.parse(fs.readFileSync(exactShare.snapshotPath, "utf8"));
    assert(!exactBundle.skills.some(item => item.name === "Future Folder Skill"), "partial file Share must not include future siblings");

    filestore.skillUpsert({ name: "Concurrent Future Skill", category: "Research/AAGL", tags: ["future"], content: "ADDED BEFORE CONCURRENT REFRESH" });
    const [firstConcurrentRefresh, secondConcurrentRefresh] = await Promise.all([
      manager.refreshPublishedShares(),
      manager.refreshPublishedShares(),
    ]);
    assert.strictEqual(firstConcurrentRefresh, 1);
    assert.strictEqual(secondConcurrentRefresh, 1, "concurrent refresh callers must share the active publication result");
    const concurrentFolderShare = manager.snapshot.shares.find(item => item.shareId === folderShare.shareId);
    assert.strictEqual(concurrentFolderShare.revision, 3, "concurrent automatic refreshes must publish exactly one new revision");

    const protectedControlPort = await freePort();
    const protectedDataPort = await freePort();
    const protectedShare = await manager.upsertShare({
      name: "Protected Team Context", contentTypes: ["skills"], selected: { skills: ["Shared Skill"] },
      protection: "secret-protected", secret: "initial-protected-material", controlPort: protectedControlPort, dataPort: protectedDataPort,
    });
    await waitUntil(async () => {
      try { const response = await fetch(`http://127.0.0.1:${protectedControlPort}/.well-known/pkm-node`); return response.ok && (await response.json()).shareId === protectedShare.shareId; }
      catch { return false; }
    });
    const protectedLink = manager.magicLink(protectedShare.shareId);
    const protectedPayload = parseShareMagicLink(protectedLink);
    assert.strictEqual(new URL(protectedPayload.endpoint).port, "", "Secret Protected Magic Link must not reveal its Control Port");
    assert.strictEqual(protectedPayload.secretProtected, true);
    const protectedSecret = await manager.shareSecret(protectedShare.shareId);
    assert(protectedSecret.startsWith(`pkms:v1:${protectedControlPort}:`), "Broker secret must carry the private Control Port");
    const secretParts = protectedSecret.split(":");
    const secretSalt = secretParts[3];
    const secretMaterial = secretParts[4];
    assert.strictEqual(secretSalt, protectedShare.secretSalt, "Broker secret must carry the proof-derivation salt");
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/v1/shares/${protectedShare.shareId}/summary`)).status, 404, "shared Open Control Port must not route Secret Protected Brokers");
    const unauthenticatedMetadata = await fetch(`http://127.0.0.1:${protectedControlPort}/v1/shares/${protectedShare.shareId}/summary`);
    assert.strictEqual(unauthenticatedMetadata.status, 401, "private Control Port must not expose protected metadata without the separate secret");
    manager.unblockIp(protectedShare.shareId, "127.0.0.1");

    for (let attempt = 1; attempt <= 3; attempt++) {
      const identity = subscriberProof(statePath, protectedShare.shareId);
      const response = await fetch(`http://127.0.0.1:${protectedControlPort}/v1/shares/${protectedShare.shareId}/sync-ticket`, { method: "POST", headers: { "X-PKM-Subscriber-Proof": identity, "X-PKM-Share-Secret-Proof": "incorrect" } });
      assert.strictEqual(response.status, attempt < 3 ? 401 : 403);
    }
    let protectedTelemetry = manager.snapshot.shares.find(item => item.shareId === protectedShare.shareId);
    assert(protectedTelemetry.automaticBlocks.some(block => block.ip === "127.0.0.1" && block.failedAttempts === 3), "three wrong secrets must persistently auto-block the source IP");
    const blockedIdentity = subscriberProof(statePath, protectedShare.shareId);
    const blockedCorrect = await fetch(`http://127.0.0.1:${protectedControlPort}/v1/shares/${protectedShare.shareId}/sync-ticket`, { method: "POST", headers: { "X-PKM-Subscriber-Proof": blockedIdentity, "X-PKM-Share-Secret-Proof": secretProof(secretMaterial, secretSalt, blockedIdentity) } });
    assert.strictEqual(blockedCorrect.status, 403, "automatic block must override a subsequently correct secret");
    manager.unblockIp(protectedShare.shareId, "127.0.0.1");
    const allowedIdentity = subscriberProof(statePath, protectedShare.shareId);
    const allowedTicketResponse = await fetch(`http://127.0.0.1:${protectedControlPort}/v1/shares/${protectedShare.shareId}/sync-ticket`, { method: "POST", headers: { "X-PKM-Subscriber-Proof": allowedIdentity, "X-PKM-Share-Secret-Proof": secretProof(secretMaterial, secretSalt, allowedIdentity) } });
    assert.strictEqual(allowedTicketResponse.status, 200);
    const allowedTicket = await allowedTicketResponse.json();
    assert.strictEqual(Number(new URL(allowedTicket.brokerUrl).port), protectedDataPort, "configured Data Port must be discovered through the private Control Port");
    const encryptedTransfer = await fetch(`${allowedTicket.brokerUrl}/sync/bundle`, { headers: { Authorization: `Bearer ${allowedTicket.ticket}` } });
    assert.strictEqual(encryptedTransfer.status, 200);
    assert.strictEqual(Buffer.from(await encryptedTransfer.arrayBuffer()).subarray(0, 8).toString("ascii"), "PKMENC1\n");

    const protectedSubscription = await manager.subscribe(protectedLink, "Protected Alias", protectedSecret);
    assert.strictEqual(protectedSubscription.status, "current");
    const rotated = await manager.rotateShareSecret(protectedShare.shareId, protectedControlPort);
    assert.notStrictEqual(rotated.secret, protectedSecret);
    const rotatedParts = rotated.secret.split(":");
    let rotationProbe = "no response";
    try {
      await waitUntil(async () => {
        try {
          const identity = subscriberProof(statePath, protectedShare.shareId);
          const response = await fetch(`http://127.0.0.1:${protectedControlPort}/v1/shares/${protectedShare.shareId}/summary`, { headers: { "X-PKM-Subscriber-Proof": identity, "X-PKM-Share-Secret-Proof": secretProof(rotatedParts[4], rotatedParts[3], identity) } });
          const body = await response.json();
          rotationProbe = `${response.status}: ${JSON.stringify(body)}`;
          return response.ok && body.revision === rotated.share.revision;
        }
        catch (error) { rotationProbe = String(error); return false; }
      });
    } catch { throw new Error(`Rotated Broker did not accept its new secret (${rotationProbe}).`); }
    await assert.rejects(manager.refresh(protectedSubscription.id, true), /secret proof|401|Broker/i, "rotated Broker secret must invalidate the subscriber's old secret");
    const refreshedProtected = await manager.subscribe(protectedLink, "Protected Alias", rotated.secret);
    assert.strictEqual(refreshedProtected.revision, rotated.share.revision, "new rotated secret must restore protected synchronization");
    manager.removeSubscription(refreshedProtected.id);

    const persistedState = JSON.parse(fs.readFileSync(path.join(state, "subscriptions.json"), "utf8"));
    process.kill(persistedState.gatewayPid, "SIGTERM");
    await waitUntil(async () => {
      try { await fetch(`http://127.0.0.1:${port}/.well-known/pkm-node`, { signal: AbortSignal.timeout(100) }); return false; }
      catch { return true; }
    });
    await manager.checkHealth();
    assert(warnings.some(message => message.includes("Common Communication Port") && message.includes("restarted")), "Gateway loss must emit a recovery warning");
    assert.strictEqual(manager.snapshot.gatewayStatus, "running", "Gateway health check must self-recover when the port is available");

    await manager.configure({ enabled: false, port, advertisedHost: "127.0.0.1", displayName: "PKM Test Node" });
    await assert.rejects(manager.refresh(subscribed.id), /fetch|Broker|connect/i);
    assert.strictEqual(manager.snapshot.subscriptions[0].status, "offline");
    assert(warnings.some(message => message.includes("Renamed Alias") && message.includes("cannot reach Broker")), "remote Broker loss must emit a current-alias-specific warning");
    assert(fs.existsSync(cached), "offline Broker warning must preserve the last verified cache");
    const beforeRemoveEvents = changedEvents;
    manager.removeSubscription(subscribed.id);
    assert(!fs.existsSync(path.join(state, "cache", subscribed.nodeId, subscribed.shareId)), "removing a subscription must delete its machine-local cache");
    assert(changedEvents > beforeRemoveEvents, "removing a subscription must notify every virtual view immediately");

    console.log("Subscription test: metadata-only control, alias, isolated cache, exact files, dynamic folders, Gateway, and background Sync OK");
  } finally {
    await manager.configure({ enabled: false, port, advertisedHost: "127.0.0.1", displayName: "PKM Test Node" }).catch(() => {});
    manager.dispose();
    servers.disposeServers();
    fs.rmSync(root, { recursive: true, force: true });
  }
  await testPersistentGatewayLifecycle();
}

async function testPersistentGatewayLifecycle() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-persistent-gateway-test-"));
  const state = path.join(root, "state");
  const gatewayScript = path.join(__dirname, "..", "dist", "subscription-gateway.js");
  const port = await freePort();
  const first = new SharedMarketManager(state, gatewayScript, "Persistent Gateway Test");
  let resumed;
  try {
    assert.strictEqual(first.snapshot.advertisedHost, os.hostname().replace(/\.$/, ""), "new Broker Invite interface must default to hostname");
    await first.configure({ enabled: false, port, advertisedHost: "", displayName: "Persistent Gateway Test" });
    await first.setGatewayOnline(true);
    const pid = JSON.parse(fs.readFileSync(path.join(state, "subscriptions.json"), "utf8")).gatewayPid;
    assert(pid > 1, "online Gateway must persist its detached daemon PID");
    first.dispose();
    const response = await fetch(`http://127.0.0.1:${port}/.well-known/pkm-node`);
    assert.strictEqual(response.status, 200, "Gateway daemon must survive manager/Extension Host disposal");
    resumed = new SharedMarketManager(state, gatewayScript, "Persistent Gateway Test");
    await resumed.setGatewayOnline(false);
    await waitUntil(async () => {
      try { await fetch(`http://127.0.0.1:${port}/.well-known/pkm-node`, { signal: AbortSignal.timeout(100) }); return false; }
      catch { return true; }
    });
  } finally {
    await resumed?.setGatewayOnline(false).catch(() => {});
    first.dispose();
    resumed?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });