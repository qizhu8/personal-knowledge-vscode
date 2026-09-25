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
const privacy = require("../dist/content-privacy");
const { ProjectStore } = require("../dist/workflows/project-store");
const { SharedMarketManager, parseShareMagicLink, parseSubscribedContentPath, verifyShareSummary } = require("../dist/subscriptions");

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

async function testMqttRefreshWaitsForActiveMutation() {
  const manager = Object.create(SharedMarketManager.prototype);
  manager.stateMutationDepth = 1;
  manager.mqttRefreshesInFlight = new Set();
  let refreshes = 0;
  manager.refresh = async () => { refreshes++; };
  manager.queueMqttRefresh("subscription");
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.strictEqual(refreshes, 0, "MQTT refresh must not run inside an unrelated state mutation");
  manager.stateMutationDepth = 0;
  await waitUntil(() => refreshes === 1);
  assert.strictEqual(manager.mqttRefreshesInFlight.size, 0);
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

function testMalformedStateRecovery() {
  for (const malformed of ["{not-json", JSON.stringify({ schema: 1, shares: "not-an-array" })]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-subscriptions-corrupt-"));
    try {
      fs.writeFileSync(path.join(root, "subscriptions.json"), malformed);
      const manager = new SharedMarketManager(root, path.join(__dirname, "..", "dist", "subscription-gateway.js"), "Recovery Test");
      const recovered = JSON.parse(fs.readFileSync(path.join(root, "subscriptions.json"), "utf8"));
      assert.strictEqual(recovered.schema, 1);
      assert(Array.isArray(recovered.shares) && Array.isArray(recovered.subscriptions));
      const quarantined = fs.readdirSync(root).filter(name => name.startsWith("subscriptions.json.corrupt-"));
      assert.strictEqual(quarantined.length, 1, "malformed Subscription state must be quarantined for diagnosis");
      assert.strictEqual(fs.readFileSync(path.join(root, quarantined[0]), "utf8"), malformed, "quarantine must preserve the malformed state exactly");
      manager.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

async function testGitHubBranchMount() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-github-mount-test-"));
  const manager = new SharedMarketManager(root, path.join(__dirname, "..", "dist", "subscription-gateway.js"), "GitHub Mount Test");
  try {
    const first = await manager.mountGitHubBranch({
      credentialTargetId: "team-credential", name: "Team Knowledge", repository: "https://github.com/example/knowledge.git", branch: "main",
      commit: "1".repeat(40), account: "team-user",
      selectedPaths: ["notes/Research/Status.md"], selectedFolders: ["skills/Coding", "packages/tools"],
      files: [
        { path: "skills/Coding/Review.md", content: Buffer.from("# Review\nMounted skill\n") },
        { path: "notes/Research/Status.md", content: Buffer.from("# Status\nMounted note\n") },
        { path: "packages/tools/README.md", content: Buffer.from("# Tools\n") },
        { path: "packages/tools/src/tool.js", content: Buffer.from("export const value = 1;\n") },
      ],
    }, "Remote Team");
    assert.strictEqual(first.source.type, "github");
    assert.strictEqual(first.source.targetId, undefined, "direct subscriptions do not require a GitHub Sync target");
    assert.strictEqual(first.source.credentialTargetId, "team-credential");
    assert.strictEqual(first.priority, "normal");
    assert.deepStrictEqual(first.source.selectedFolders, ["skills/Coding", "packages/tools"]);
    assert.strictEqual(first.publisherHost, "github.com");
    assert.deepStrictEqual(first.counts, { skills: 1, notes: 1, packages: 2 });
    const skills = manager.cachedGroups("skills");
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0].alias, "Remote Team");
    const detail = manager.cachedDetail(skills[0].items[0].key);
    assert.match(detail.content, /Mounted skill/);
    assert.strictEqual(detail.provenance.commit, "1".repeat(40));
    manager.setSubscriptionPriority(first.id, "highest");
    assert.strictEqual(manager.snapshot.subscriptions[0].priority, "highest");
    assert.strictEqual(manager.cachedGroups("skills")[0].priority, "highest");
    const packageGroup = manager.cachedGroups("packages")[0];
    const packageSource = manager.forkSource(packageGroup.items[0].key);
    assert.deepStrictEqual(packageSource.package.files.map(file => file.path).sort(), ["README.md", "src/tool.js"]);

    const refreshed = await manager.mountGitHubBranch({
      credentialTargetId: "team-credential", name: "Team Knowledge", repository: "https://github.com/example/knowledge.git", branch: "main",
      commit: "2".repeat(40), account: "team-user",
      selectedPaths: ["notes/Research/Status.md"], selectedFolders: ["skills/Coding", "packages/tools"],
      files: [{ path: "notes/Research/Status.md", content: Buffer.from("# Status\nUpdated note\n") }],
    }, "Remote Team");
    assert.strictEqual(refreshed.id, first.id, "refresh must retain the mounted subscription identity");
    assert.strictEqual(refreshed.priority, "highest", "GitHub refresh must retain Subscriber source priority");
    assert.strictEqual(refreshed.revision, 2);
    assert.strictEqual(manager.cachedGroups("skills").length, 0, "refresh must remove files deleted from the remote commit");
    assert.match(manager.cachedDetail(manager.cachedGroups("notes")[0].items[0].key).content, /Updated note/);
  } finally {
    manager.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  testMalformedStateRecovery();
  await testGitHubBranchMount();
  await testMqttRefreshWaitsForActiveMutation();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-subscriptions-test-"));
  const store = path.join(root, "store");
  const state = path.join(root, "state");
  fs.mkdirSync(store, { recursive: true });
  filestore.setStorePath(store);
  storage.setStorePath(store);
  privacy.setPrivacyStoreRoot(store);
  const serversRoot = path.join(store, "servers");
  const sampleServer = path.join(serversRoot, "sample-api");
  const sampleServerPort = await freePort();
  fs.mkdirSync(sampleServer, { recursive: true });
  fs.writeFileSync(path.join(sampleServer, "server.json"), JSON.stringify({ name: "Sample API", command: "{python} app.py --port {port}", port: sampleServerPort, python: "/private/machine/python", autostart: true, category: "Team/APIs", tags: ["api"] }));
  fs.writeFileSync(path.join(sampleServer, "app.py"), "print('portable server source')\n");
  servers.initServers(serversRoot, path.join(root, "server-state"), await freePort());
  filestore.skillUpsert({ name: "Shared Skill", description: "Metadata only summary", category: "Research/AAGL", tags: ["aagl", "pipeline"], content: "SECRET BODY MUST NOT ENTER CONTROL SIGNAL" });
  filestore.noteUpsert({ slug: "", title: "Indexed Note", type: "general", tags: [], content: "INDEXED NOTE BODY" });
  filestore.noteUpsert({ slug: "", title: "Shared Note", category: "Team", type: "general", tags: ["shared"], content: "UNIQUE SUBSCRIBED NOTE BODY" });
  storage.promptImport([{ project: "Ads", task: "Review", version: "v1", file: "prompt.md", content: "UNIQUE SUBSCRIBED PROMPT BODY" }]);
  storage.scriptImport([{ category: "Team", file: "check.script", content: "UNIQUE SUBSCRIBED SCRIPT BODY" }]);
  const projectStore = new ProjectStore(path.join(store, ".pkm", "state"), () => "shared-recipe-id");
  const projectSnapshot = projectStore.list();
  const recipeResult = projectStore.createRecipe({
    commandId: "create-shared-recipe", fingerprint: "create-shared-recipe",
    expectedStoreVersion: projectSnapshot.storeVersion,
  }, { kind: "global" }, "Shared Release Recipe", "Operations/Sharing");
  const sharedRecipe = recipeResult.snapshot.recipes.find(recipe => recipe.recipeId === recipeResult.entityId);
  assert(sharedRecipe, "test fixture must create a canonical Recipe Library entry");
  assert.strictEqual(filestore.noteList(undefined, 10).find(note => note.title === "Indexed Note").content, undefined, "noteList must remain metadata-only by default");
  assert.strictEqual(filestore.noteList(undefined, 10, true).find(note => note.title === "Indexed Note").content, "INDEXED NOTE BODY", "internal link indexing may opt into parsed content");
  fs.mkdirSync(path.join(store, "packages", "shared-tool", "src"), { recursive: true });
  fs.writeFileSync(path.join(store, "packages", "shared-tool", "README.md"), "# Shared Tool\n");
  fs.writeFileSync(path.join(store, "packages", "shared-tool", "src", "tool.py"), "VALUE = 42\n");
  const warnings = [];
  const diagnostics = [];
  let changedEvents = 0;
  const secretStorage = new MemorySecretStorage();
  const manager = new SharedMarketManager(state, path.join(__dirname, "..", "dist", "subscription-gateway.js"), "PKM Test Node", {
    onWarning: message => warnings.push(message),
    onChanged: () => { changedEvents += 1; },
    onDiagnostic: event => diagnostics.push(event),
  }, secretStorage, { user: "alice", host: "host-a" });
  const port = await freePort();
  try {
    await manager.configure({ enabled: false, port, advertisedHost: "127.0.0.1", displayName: "PKM Test Node" });
    const sharedContentTypes = ["skills", "notes", "prompts", "scripts", "packages", "servers", "recipes"];
    const sharedSelection = { skills: ["Shared Skill"], notes: ["Team/Shared Note"], prompts: ["Ads/Review"], scripts: ["Team/check.script"], packages: ["shared-tool"], servers: ["sample-api"], recipes: [sharedRecipe.recipeId] };
    const share = await manager.upsertShare({ name: "AAGL Context", visibility: "public", contentTypes: sharedContentTypes, selected: sharedSelection });
    assert.strictEqual(share.revision, 1);
    assert.match(share.revisionLabel, /^\d{8}\.r1$/, "first Broker snapshot of a day must use YYYYMMDD.r1");
    assert.strictEqual(share.summary.snapshotBytes, fs.statSync(share.snapshotPath).size);
    assert.deepStrictEqual(share.summary.counts, { skills: 1, notes: 1, prompts: 1, scripts: 1, packages: 1, servers: 1, recipes: 1 });
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
    assert.strictEqual(subscribed.priority, "normal");
    assert.strictEqual(subscribed.publisherUser, "alice");
    assert.strictEqual(subscribed.publisherHost, "host-a");
    assert(diagnostics.some(event => event.operation === "publish" && event.snapshotBytes > 0));
    assert(diagnostics.some(event => event.operation === "download" && event.snapshotBytes > 0));
    assert(diagnostics.some(event => event.operation === "download" && event.isolatedProcess === true && event.transferBytes > 0));
    assert(!JSON.stringify(diagnostics).includes("SECRET BODY"));
    assert.strictEqual(manager.snapshot.subscriptions[0].brokerName, "AAGL Context");
    manager.state.subscriptions[0].brokerName = undefined;
    assert.strictEqual(manager.snapshot.subscriptions[0].brokerName, "AAGL Context", "legacy records must recover Broker name from cached summary");
    manager.state.subscriptions[0].brokerName = "AAGL Context";
    manager.renameSubscription(subscribed.id, "My Creative Context");
    assert.strictEqual(manager.snapshot.subscriptions[0].alias, "My Creative Context");
    assert.strictEqual(manager.snapshot.subscriptions[0].brokerName, "AAGL Context", "Subscriber rename must not alter the published Broker name");
    manager.setSubscriptionPriority(subscribed.id, "high");
    assert.strictEqual(manager.snapshot.subscriptions[0].priority, "high");
    assert.strictEqual(manager.cachedGroups("skills")[0].priority, "high");
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(state, "subscriptions.json"), "utf8")).subscriptions[0].priority, "high");
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(state, "cache", subscribed.nodeId, subscribed.shareId, "_subscription.json"), "utf8")).priority, "high");
    assert.throws(() => manager.setSubscriptionPriority(subscribed.id, "urgent"), /normal, high, or highest/);
    const cached = path.join(state, "cache", subscribed.nodeId, subscribed.shareId, "bundle.json");
    assert(fs.existsSync(cached), "background Sync must populate the machine-local subscription cache");
    assert.deepStrictEqual(fs.readdirSync(path.join(state, "downloads")), [], "completed Sync must remove temporary downloads");
    assert(JSON.parse(fs.readFileSync(cached, "utf8")).skills[0].content.includes("SECRET BODY"));
    assert.strictEqual(JSON.parse(fs.readFileSync(cached, "utf8")).recipes[0].executableDigest, sharedRecipe.executableDigest);
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
    const cachedScripts = path.join(state, "cache", subscribed.nodeId, subscribed.shareId, "content", "scripts");
    fs.mkdirSync(cachedScripts, { recursive: true });
    fs.writeFileSync(path.join(cachedScripts, "large-search-guard.script"), `UNIQUE_LARGE_BODY_TERM\n${"x".repeat(300 * 1024)}`);
    assert.strictEqual(manager.cachedGroups("scripts", "UNIQUE_LARGE_BODY_TERM").length, 0,
      "large cached bodies must not be synchronously loaded for content search");
    assert.strictEqual(manager.cachedGroups("scripts", "large-search-guard")[0].items.length, 1,
      "large files must remain searchable by metadata");
    for (let index = 0; index < 250; index++) fs.writeFileSync(path.join(cachedScripts, `bounded-${String(index).padStart(3, "0")}.script`), "small");
    assert.strictEqual(manager.cachedGroups("scripts")[0].items.length, 200,
      "subscription navigation must cap raw results to bound webview payloads");
    const packageGroups = manager.cachedGroups("packages");
    assert.strictEqual(packageGroups.length, 1);
    assert.strictEqual(packageGroups[0].alias, "My Creative Context", "subscribed groups must use the Subscriber-local name");
    assert.strictEqual(manager.cachedGroups("skills")[0].alias, "My Creative Context");
    const searchableTypes = [
      ["skills", "SECRET BODY", "Research/AAGL/Shared Skill.md"],
      ["notes", "UNIQUE SUBSCRIBED NOTE", "Team/Shared Note.md"],
      ["prompts", "UNIQUE SUBSCRIBED PROMPT", "Ads/Review/v1/prompt.md"],
      ["scripts", "UNIQUE SUBSCRIBED SCRIPT", "Team/check.script"],
      ["servers", "Sample API", "sample-api/server.link.json"],
      ["recipes", "Shared Release Recipe", `Operations/Sharing/${sharedRecipe.recipeId}.json`],
    ];
    for (const [type, query, expectedPath] of searchableTypes) {
      const group = manager.cachedGroups(type, query)[0];
      assert(group, `subscribed ${type} must be searchable by downloaded content`);
      const item = group.items.find(candidate => candidate.path === expectedPath);
      assert(item, `subscribed ${type} search must return ${expectedPath}`);
      assert.deepStrictEqual(parseSubscribedContentPath(item.pkmPath), {
        nodeId: subscribed.nodeId, shareId: subscribed.shareId, contentType: type, path: expectedPath,
      }, `subscribed ${type} Copy Path must round-trip into MCP read arguments`);
      assert.strictEqual(manager.cachedDetail(item.key).path, expectedPath);
    }
    const serverGroups = manager.cachedGroups("servers");
    assert.strictEqual(serverGroups[0].alias, "My Creative Context");
    assert.strictEqual(serverGroups[0].items.length, 1, "each subscribed Server must aggregate into one link row");
    assert.strictEqual(serverGroups[0].items[0].title, "Sample API");
    assert.strictEqual(serverGroups[0].items[0].path, "sample-api/server.link.json");
    const recipeGroups = manager.cachedGroups("recipes");
    assert.strictEqual(recipeGroups[0].items[0].title, "Shared Release Recipe");
    assert.strictEqual(JSON.parse(manager.cachedDetail(recipeGroups[0].items[0].key).content).recipeId, sharedRecipe.recipeId);
    const recipeFork = manager.forkSource(recipeGroups[0].items[0].key);
    assert.strictEqual(recipeFork.type, "recipes");
    assert.strictEqual(recipeFork.brokerName, "AAGL Context");
    assert.strictEqual(recipeFork.publisherUser, "alice");
    assert.strictEqual(JSON.parse(recipeFork.content).executableDigest, sharedRecipe.executableDigest);
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
    const mqttClient = manager.mqttClients.get(subscribed.nodeId);
    await waitUntil(() => mqttClient?.connected, 6000);
    const mqttTopic = `pkm/v1/nodes/${subscribed.nodeId}/shares/${subscribed.shareId}/summary`;
    assert(mqttClient._resubscribeTopics?.[mqttTopic], "Subscriber must retain its Broker revision topic");
    const paused = await manager.setSharePublished(share.shareId, false);
    assert.strictEqual(paused.published, false);
    assert.strictEqual(manager.snapshot.shares.find(item => item.shareId === share.shareId).published, false, "paused Broker definition must remain available locally");
    const pausedSummary = await fetch(`http://127.0.0.1:${port}/v1/shares/${share.shareId}/summary`, { headers: { "X-PKM-Subscriber-Proof": subscriberProof(statePath, share.shareId) } });
    assert.strictEqual(pausedSummary.status, 404, "paused Broker must not expose metadata through an existing link");
    const pausedTicket = await fetch(`http://127.0.0.1:${port}/v1/shares/${share.shareId}/sync-ticket`, { method: "POST", headers: { "X-PKM-Subscriber-Proof": subscriberProof(statePath, share.shareId) } });
    assert.strictEqual(pausedTicket.status, 404, "paused Broker must not issue transfer tickets");
    const pausedCatalog = await (await fetch(`http://127.0.0.1:${port}/v1/catalog`)).json();
    assert(!(pausedCatalog.shares || []).some(item => item.shareId === share.shareId), "paused Broker must leave public discovery");
    const resumed = await manager.setSharePublished(share.shareId, true);
    assert.strictEqual(resumed.published, true);
    const resumedSummary = await fetch(`http://127.0.0.1:${port}/v1/shares/${share.shareId}/summary`, { headers: { "X-PKM-Subscriber-Proof": subscriberProof(statePath, share.shareId) } });
    assert.strictEqual(resumedSummary.status, 200, "resuming must publish the retained Broker definition again");
    assert(mqttClient._resubscribeTopics?.[mqttTopic], "pause/resume must preserve an existing Subscriber MQTT topic");
    filestore.skillUpsert({ name: "Shared Skill", description: "Updated", category: "Research/AAGL", tags: ["aagl", "updated"], content: "REVISION TWO" });
    filestore.noteUpsert({ slug: "", title: "Broker Added Note", category: "Team", type: "general", tags: ["new"], content: "NEW FILE DISCOVERED BY MANUAL REFRESH" });
    const updatedSelection = { ...sharedSelection, notes: [...sharedSelection.notes, "Team/Broker Added Note"] };
    const updated = await manager.upsertShare({ shareId: share.shareId, name: share.name, contentTypes: sharedContentTypes, selected: updatedSelection });
    assert.strictEqual(updated.revision, 2);
    assert.strictEqual(updated.revisionLabel, `${share.revisionDate}.r2`, "same-day Broker snapshots must increment the readable daily revision");
    await waitUntil(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/shares/${share.shareId}/summary`);
      return response.ok && (await response.json()).revision === 2;
    });
    await waitUntil(() => manager.snapshot.subscriptions[0].revision === 2, 6000);
    assert.strictEqual(manager.snapshot.subscriptions[0].revision, 2);
    assert(fs.readFileSync(cached, "utf8").includes("REVISION TWO"));
    const addedNote = manager.cachedGroups("notes", "NEW FILE DISCOVERED BY MANUAL REFRESH")[0]?.items.find(item => item.path === "Team/Broker Added Note.md");
    assert(addedNote, "forced Subscriber refresh must discover a newly published Broker file");
    assert.deepStrictEqual(parseSubscribedContentPath(addedNote.pkmPath), {
      nodeId: subscribed.nodeId, shareId: subscribed.shareId, contentType: "notes", path: "Team/Broker Added Note.md",
    });
    for (const client of manager.mqttClients.values()) client.end(true);
    manager.mqttClients.clear();
    filestore.noteUpsert({ slug: "", title: "Manual Refresh Note", category: "Team", type: "general", tags: ["manual"], content: "ONLY DISCOVERED BY FORCED REFRESH" });
    const manualSelection = { ...updatedSelection, notes: [...updatedSelection.notes, "Team/Manual Refresh Note"] };
    const manualUpdate = await manager.upsertShare({ shareId: share.shareId, name: share.name, contentTypes: sharedContentTypes, selected: manualSelection });
    assert.strictEqual(manualUpdate.revision, 3);
    assert.strictEqual(manager.snapshot.subscriptions[0].revision, 2, "without MQTT, Subscriber must remain stale until manual refresh");
    await manager.refresh(subscribed.id, true);
    assert.strictEqual(manager.snapshot.subscriptions[0].revision, 3);
    assert(manager.cachedGroups("notes", "ONLY DISCOVERED BY FORCED REFRESH")[0]?.items.some(item => item.path === "Team/Manual Refresh Note.md"),
      "manual force refresh must discover a Broker file missed while realtime notification is unavailable");
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
    assert.strictEqual(exactShare.revision, 3, "exact file Share must not change when a sibling is added");
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
    filestore.skillUpsert({ name: "Second Concurrent Skill", category: "Research/AAGL", tags: ["future"], content: "REVISION FOUR" });
    await manager.refreshPublishedShares();
    const retainedFolderShare = manager.snapshot.shares.find(item => item.shareId === folderShare.shareId);
    assert.strictEqual(retainedFolderShare.revision, 4);
    const retainedSnapshots = fs.readdirSync(path.join(state, "snapshots"))
      .filter(name => name.startsWith(`${folderShare.shareId}-`)).sort();
    assert.deepStrictEqual(retainedSnapshots, [`${folderShare.shareId}-3.json`, `${folderShare.shareId}-4.json`],
      "published snapshots must retain only current and previous revisions");

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
    await manager.unblockIp(protectedShare.shareId, "127.0.0.1");

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
    await manager.unblockIp(protectedShare.shareId, "127.0.0.1");
    protectedTelemetry = manager.snapshot.shares.find(item => item.shareId === protectedShare.shareId);
    assert(!protectedTelemetry.automaticBlocks.some(block => block.ip === "127.0.0.1"), "unblock must complete before protected access resumes");
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
    const protectedMqttClient = manager.mqttClients.get(protectedSubscription.nodeId);
    protectedMqttClient.end(true);
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
    const rotatedSummaryPayload = Buffer.from(JSON.stringify(rotated.share.summary));
    for (let duplicate = 0; duplicate < 3; duplicate++) protectedMqttClient.emit("message", mqttTopic, rotatedSummaryPayload);
    await waitUntil(() => manager.snapshot.subscriptions.find(item => item.id === protectedSubscription.id)?.status === "offline");
    protectedTelemetry = manager.snapshot.shares.find(item => item.shareId === protectedShare.shareId);
    assert(!protectedTelemetry.automaticBlocks.some(block => block.ip === "127.0.0.1"),
      "duplicate QoS 1 rotation notifications must coalesce into one failed old-secret refresh");
    await assert.rejects(manager.refresh(protectedSubscription.id, true), /secret proof|401|Broker/i, "rotated Broker secret must invalidate the subscriber's old secret");
    const refreshedProtected = await manager.subscribe(protectedLink, "Protected Alias", rotated.secret);
    assert.strictEqual(refreshedProtected.revision, rotated.share.revision, "new rotated secret must restore protected synchronization");
    manager.removeSubscription(refreshedProtected.id);

    privacy.setTopLevelPrivacy("skills", "Research", true);
    const privacyRefreshCount = await manager.refreshPublishedShares();
    assert(privacyRefreshCount >= 2, "making a shared top-level folder private must rebuild affected Broker snapshots");
    for (const published of manager.snapshot.shares.filter(item => item.contentTypes.includes("skills") && item.protection === "open")) {
      const publishedBundle = JSON.parse(fs.readFileSync(published.snapshotPath, "utf8"));
      assert.deepStrictEqual(publishedBundle.skills, [], "private top-level folders must be physically absent even from existing selections");
    }
    privacy.setTopLevelPrivacy("skills", "Research", false);

    const persistedState = JSON.parse(fs.readFileSync(path.join(state, "subscriptions.json"), "utf8"));
    process.kill(persistedState.gatewayPid, "SIGTERM");
    await waitUntil(async () => {
      try { await fetch(`http://127.0.0.1:${port}/.well-known/pkm-node`, { signal: AbortSignal.timeout(100) }); return false; }
      catch { return true; }
    });
    await manager.checkHealth();
    assert(warnings.some(message => message.includes("Common Communication Port") && message.includes("restarted")), "Gateway loss must emit a recovery warning");
    assert.strictEqual(manager.snapshot.gatewayStatus, "running", "Gateway health check must self-recover when the port is available");

    const apostropheShare = await manager.upsertShare({ name: "Yu Wang's Work", contentTypes: ["skills"], selected: { skills: ["Shared Skill"] } });
    assert(manager.snapshot.shares.some(item => item.shareId === apostropheShare.shareId));
    await manager.deleteShare(apostropheShare.shareId);
    assert(!manager.snapshot.shares.some(item => item.shareId === apostropheShare.shareId), "Broker names with apostrophes must not prevent deletion");

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
  const diagnostics = [];
  const warnings = [];
  const first = new SharedMarketManager(state, gatewayScript, "Persistent Gateway Test", {}, undefined, { user: "test", host: "host", version: "2.6.1" });
  let resumed;
  let resumedPeer;
  let observer;
  try {
    assert.strictEqual(first.snapshot.advertisedHost, os.hostname().replace(/\.$/, ""), "new Broker Invite interface must default to hostname");
    await first.configure({ enabled: false, port, advertisedHost: "", displayName: "Persistent Gateway Test" });
    await first.setGatewayOnline(true);
    const pid = JSON.parse(fs.readFileSync(path.join(state, "subscriptions.json"), "utf8")).gatewayPid;
    assert(pid > 1, "online Gateway must persist its detached daemon PID");
    first.dispose();
    const response = await fetch(`http://127.0.0.1:${port}/.well-known/pkm-node`);
    assert.strictEqual(response.status, 200, "Gateway daemon must survive manager/Extension Host disposal");
    const legacyNode = await response.json();
    assert.strictEqual(legacyNode.gatewayVersion, "2.6.1", "detached Gateway must report its launch-time runtime version");
    assert.strictEqual(legacyNode.gatewayPid, pid, "Gateway endpoint must report its actual runtime PID");
    const staleState = JSON.parse(fs.readFileSync(path.join(state, "subscriptions.json"), "utf8"));
    staleState.gatewayPid = 99999999;
    fs.writeFileSync(path.join(state, "subscriptions.json"), JSON.stringify(staleState, null, 2));
    resumed = new SharedMarketManager(state, gatewayScript, "Persistent Gateway Test", {
      onDiagnostic: event => diagnostics.push(event),
      onWarning: message => warnings.push(message),
    }, undefined, { user: "test", host: "host", version: "2.7.20" });
    resumedPeer = new SharedMarketManager(state, gatewayScript, "Persistent Gateway Test", {
      onDiagnostic: event => diagnostics.push(event),
      onWarning: message => warnings.push(message),
    }, undefined, { user: "test", host: "host", version: "2.7.20" });
    const [windowAShare, windowBShare] = await Promise.all([
      resumed.upsertShare({ name: "Window A Broker", contentTypes: ["notes"], selected: { notes: [] } }),
      resumedPeer.upsertShare({ name: "Window B Broker", contentTypes: ["skills"], selected: { skills: [] } }),
    ]);
    const concurrentState = JSON.parse(fs.readFileSync(path.join(state, "subscriptions.json"), "utf8"));
    assert(concurrentState.shares.some(share => share.shareId === windowAShare.shareId), "Window A mutation must survive Window B save");
    assert(concurrentState.shares.some(share => share.shareId === windowBShare.shareId), "Window B mutation must rebase on and preserve Window A state");
    await Promise.all([resumed.setGatewayOnline(true), resumedPeer.setGatewayOnline(true)]);
    const upgradedState = JSON.parse(fs.readFileSync(path.join(state, "subscriptions.json"), "utf8"));
    assert.notStrictEqual(upgradedState.gatewayPid, pid, "upgrade handoff must replace the detached N-1 process");
    const upgradedResponse = await fetch(`http://127.0.0.1:${port}/.well-known/pkm-node`);
    const upgradedNode = await upgradedResponse.json();
    assert.strictEqual(upgradedNode.gatewayVersion, "2.7.20", "replacement Gateway must report the current extension version");
    assert.strictEqual(upgradedNode.gatewayPid, upgradedState.gatewayPid, "replacement endpoint and persisted state must agree on owner PID");
    assert.strictEqual(upgradedNode.gatewayProtocolVersion, "pkm-node-gateway:v2");
    observer = new SharedMarketManager(state, gatewayScript, "Persistent Gateway Test", {}, undefined, { user: "test", host: "host", version: "2.7.20" });
    assert.strictEqual(observer.snapshot.gatewayStatus, "stopped", "a new window starts without process-local Gateway status");
    await observer.refreshGatewayStatus();
    assert.strictEqual(observer.snapshot.gatewayStatus, "running", "a new window must detect the already-running persistent Gateway");
    assert(diagnostics.some(event => event.operation === "gateway-handoff" && event.previousVersion === "2.6.1" && event.nextVersion === "2.7.20"));
    assert(warnings.some(message => message.includes("2.6.1") && message.includes("2.7.20")), "upgrade handoff must emit one visible transition warning");
    const gatewayState = JSON.parse(fs.readFileSync(path.join(state, "gateway-state.json"), "utf8"));
    assert.strictEqual(gatewayState.extensionVersion, "2.7.20");

    assert.strictEqual(gatewayState.gatewayProtocolVersion, "pkm-node-gateway:v2");
    assert.strictEqual(gatewayState.ownerNodeId, upgradedNode.nodeId);
    await resumedPeer.setGatewayOnline(false);
    await waitUntil(async () => {
      try { await fetch(`http://127.0.0.1:${port}/.well-known/pkm-node`, { signal: AbortSignal.timeout(100) }); return false; }
      catch { return true; }
    });
  } finally {
    await resumed?.setGatewayOnline(false).catch(() => {});
    await resumedPeer?.setGatewayOnline(false).catch(() => {});
    first.dispose();
    resumed?.dispose();
    resumedPeer?.dispose();
    observer?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });