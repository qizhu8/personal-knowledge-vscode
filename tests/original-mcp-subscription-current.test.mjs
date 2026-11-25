import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { createHash, createCipheriv, createHmac, scryptSync, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { acquireOriginalMcpRootFence, captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { bootstrapOriginalMcpNativeRuntime } from "../dist/original-mcp-native-bootstrap.js";
import { originalMcpProfileBinding } from "../dist/original-mcp-profile-binding.js";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../dist/original-mcp-native-identity.js";
import { startOriginalMcpNativeAttachmentServer } from "../dist/original-mcp-native-attachment.js";
import { createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { createOriginalMcpCurrentSubscriptionSource } from "../dist/original-mcp-subscription-current-source.js";
import { originalMcpNativeRequestProtocol, originalMcpNativeRequestSession, parseOriginalMcpNativeRequest,
  originalMcpNativeResult, originalMcpNativeErrorResult, createOriginalMcpNativeRequestPolicy,
  waitForOriginalMcpNativeSupport } from "../dist/original-mcp-native-request.js";
import { createNativePublicOwnerBackend } from "../dist/native-public-mcp-owner.js";
import { createNativePublicFacade } from "../dist/native-public-mcp.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";

assert(process.env.PKM_TEST_WORKSPACE, "Use the isolated managed Linux runner.");
process.umask(0o077);
const hash = value => createHash("sha256").update(value).digest("hex"), catalog = originalPublicMcpContracts();
const require = createRequire(import.meta.url);
const built = await require("esbuild").build({
  entryPoints: [resolve("clients/vscode-host/original-mcp-native-subscription.ts")],
  bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false, logLevel: "silent",
  plugins: [{ name: "current-signer", setup(plugin) {
    plugin.onResolve({ filter: /original-mcp-native-identity\.js$/ }, () => ({ path: "current-signer", external: true }));
  } }],
});

function publicProvider(protectedSource = false) {
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const nodeId = hash(publicKey), shareId = "fresh-public", endpoint = "http://127.0.0.1:23003";
  const secretSalt = protectedSource ? randomBytes(16).toString("base64url") : undefined;
  const material = protectedSource ? randomBytes(24).toString("base64url") : undefined;
  const link = { protocol: "pkmshare:v1", nodeId, shareId, endpoint: protectedSource ? "http://127.0.0.1" : endpoint, publicKey,
    publisher: "Current native provider", publisherUser: "local-source", publisherHost: "fixture", secretProtected: protectedSource };
  const encoded = Buffer.from(JSON.stringify(link)).toString("base64url");
  const magicLink = `pkmshare:v1:${encoded}.${sign(null, Buffer.from(encoded), keys.privateKey).toString("base64url")}`;
  const content = "Fresh native-profile public subscription evidence.";
  const bundle = JSON.stringify({ schema: 1, notes: [{ slug: "Public", content }] });
  let encrypted;
  if (protectedSource) {
    const base = scryptSync(material, Buffer.from(secretSalt, "base64url"), 32);
    const key = createHmac("sha256", base).update("pkm-share-content:v1").digest(), iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(bundle), cipher.final()]);
    encrypted = JSON.stringify({ v: 1, alg: "A256GCM", iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") });
  }
  const collectionHash = `sha256:${hash(encrypted ?? bundle)}`;
  const member = { id: "current-member", nodeId, shareId, endpoint, publicKey, magicLink,
    alias: "Current native provider", priority: "normal", publisher: link.publisher, publisherUser: link.publisherUser,
    publisherHost: link.publisherHost, revision: 1, collectionHash, topics: [], tags: [], counts: { notes: 1 },
    itemCount: 1, etag: "fresh", status: "current", brokerName: "Current native provider",
    secretProtected: protectedSource, ...(secretSalt ? { secretSalt } : {}) };
  const unsigned = { shareId, name: member.brokerName, revision: member.revision, collectionHash,
    metadataOnly: true, counts: member.counts, topics: member.topics, tags: member.tags, itemCount: member.itemCount,
    secretProtected: protectedSource, ...(secretSalt ? { secretSalt } : {}) };
  const summary = { ...unsigned, signature: sign(null, Buffer.from(JSON.stringify(unsigned)), keys.privateKey).toString("base64url") };
  const prefix = `cache/${nodeId}/${shareId}`;
  return { nodeId, shareId, member, content, material, files: [
    { path: `${prefix}/_subscription.json`, raw: JSON.stringify({ subscriptionId: member.id, nodeId, shareId, revision: 1, collectionHash,
      alias: member.alias, endpoint: member.endpoint, priority: member.priority }) },
    { path: `${prefix}/summary.json`, raw: JSON.stringify(summary) },
    { path: `${prefix}/bundle.json`, raw: bundle },
    ...(encrypted ? [{ path: `${prefix}/bundle.encrypted.json`, raw: encrypted }] : []),
    { path: `${prefix}/content/notes/Public.md`, raw: content },
    { path: `${prefix}/content/notes/Public.md.pkm-source.json`, raw: JSON.stringify({ subscriptionId: member.id, nodeId, shareId,
      revision: 1, contentHash: `sha256:${hash(content)}` }) },
  ] };
}

async function fixture(t, configured = true, protectedSource = false) {
  const directory = resolve("tests", `.current-subscription-${randomUUID()}`);
  const root = join(directory, "root"), profile = join(directory, "profile"), cleanup = [];
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, ".pkm"), { mode: 0o700 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  await writeFile(join(root, "notes/Owned.md"), "Original-owned Root fixture.", { mode: 0o600 });
  const lifetime = new AbortController();
  t.after(async () => {
    lifetime.abort();
    for (const close of cleanup.reverse()) await close();
    await rm(directory, { recursive: true, force: true });
  });
  const keys = generateKeyPairSync("ed25519"), profileSha256 = originalMcpProfileBinding(profile).sha256;
  const identity = originalMcpNativeIdentity(keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"), profileSha256);
  const activationId = randomUUID(), payloadBuildId = hash("current-product-build"), hostEntrySha256 = hash("current-product-host");
  const fence = await acquireOriginalMcpRootFence(root);
  cleanup.push(() => fence.release());
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"), operatorId: "current-fixture",
    profileSha256, limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16_777_216, maxFileBytes: 8_388_608 } }, { writerFence: fence });
  const socketDirectory = join(homedir(), ".local/state/pkm-v5-recovery", `r-${randomBytes(4).toString("hex")}`);
  await mkdir(socketDirectory, { mode: 0o700 });
  const ownedSocketDirectory = await lstat(socketDirectory, { bigint: true });
  cleanup.push(async () => {
    const now = await lstat(socketDirectory, { bigint: true });
    assert.equal(now.ino, ownedSocketDirectory.ino); assert.equal(now.dev, ownedSocketDirectory.dev);
    await rm(socketDirectory, { recursive: true });
  });
  let opened, bootstrap, server, descriptor;
  if (process.env.PKM_SUBSCRIPTION_COMBINED_BASELINE === "1") {
    opened = await openOriginalMcpRoot(plan, { writerFence: fence });
    cleanup.push(() => opened.owner.close());
    server = await startOriginalMcpNativeAttachmentServer({ directory: socketDirectory, identity, identitySha256: identity.sha256,
      binding: { root, workspaceId: opened.workspaceId, planSha256: plan.planSha256, profileSha256,
        catalogSha256: catalog.provenance.metadataSha256, payloadBuildId, hostEntrySha256 } });
    cleanup.push(() => server.close());
    descriptor = JSON.parse(await readFile(server.descriptorPath, "utf8"));
  } else {
    bootstrap = await bootstrapOriginalMcpNativeRuntime({ plan, writerFence: fence,
      attachment: { directory: socketDirectory, identity, identitySha256: identity.sha256, payloadBuildId, hostEntrySha256 } });
    cleanup.push(() => bootstrap.close());
    descriptor = JSON.parse(await readFile(bootstrap.attachmentDescriptorPath, "utf8"));
    opened = bootstrap;
  }
  const provider = publicProvider(protectedSource), publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  let currentProfile = { schema: "pkm.original-native-subscription-profile/v1", root, workspaceId: opened.workspaceId,
    profileSha256, identitySha256: identity.sha256, sourceEpoch: randomUUID(), revision: 1,
    state: { schema: 1, nodeId: hash(publicKey), publicKey, shares: [], subscriptions: [provider.member] },
    files: provider.files.map(file => ({ path: file.path, sha256: hash(file.raw), size: Buffer.byteLength(file.raw) })) };
  const publish = async () => {
    for (const file of provider.files) {
      const path = join(profile, "native-subscriptions", file.path);
      await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
      await writeFile(path, file.raw, { mode: 0o600 });
    }
    await writeFile(join(profile, "native-subscriptions/current.json"), JSON.stringify(currentProfile), { mode: 0o600 });
  };
  if (configured) await publish();
  const session = { brokerId: descriptor.brokerId, activationId, epoch: activationId,
    identitySha256: identity.sha256, binding: descriptor.binding };
  const prompts = [], secretProbes = [], context = { globalStorageUri: { fsPath: profile }, subscriptions: [],
    secrets: { async get(id) { secretProbes.push(id);
      return id === `personalKnowledge.subscription.${provider.nodeId}.${provider.shareId}.secret` ? provider.material : undefined; } } };
  let revoke, readHook = async () => {}, sourceChoice = true;
  const signer = { activationId, identity, payloadBuildId, hostEntrySha256,
    signal: lifetime.signal, assertCurrent() { assert(!lifetime.signal.aborted); } };
  const loader = Module._load, memory = new Module(resolve("clients/vscode-host/current-subscription-memory.cjs"));
  memory.filename = resolve("clients/vscode-host/current-subscription-memory.cjs");
  memory.paths = Module._nodeModulePaths(resolve("clients/vscode-host"));
  try {
    Module._load = function(id, ...args) {
      if (id === "current-signer") return { originalMcpNativeSigner: async () => signer };
      if (id === "vscode") return { workspace: { isTrusted: true, onDidChangeWorkspaceFolders() { return { dispose() {} }; } },
        commands: { registerCommand(_name, callback) { revoke = callback; return { dispose() {} }; } },
        window: { async showWarningMessage(_title, options, label) {
          prompts.push(JSON.parse(options.detail));
          if (label.startsWith("Enroll") && !sourceChoice) return "Deny";
          if (label.startsWith("Read")) await readHook();
          return label;
        } } };
      return loader.call(this, id, ...args);
    };
    memory._compile(built.outputFiles[0].text, memory.filename);
  } finally { Module._load = loader; }
  const socket = connect(descriptor.socketPath);
  cleanup.push(async () => { socket.destroy(); });
  const producer = await memory.exports.createOriginalMcpNativeSubscriptionProducer(context,
    { session, signal: lifetime.signal, assertCurrent() { assert(!lifetime.signal.aborted); }, async close() { lifetime.abort(); socket.destroy(); } });
  cleanup.push(async () => producer.dispose());
  let buffer = "", ready;
  const attached = new Promise(resolve => { ready = resolve; });
  const requests = [], send = frame => socket.write(`${JSON.stringify(frame)}\n`);
  const dispatch = async frame => {
    const request = parseOriginalMcpNativeRequest(frame, session); requests.push(request);
    try {
      const result = request.method === "subscription.profile.current"
        ? await producer.handleProfile(request.payload, request.requestId, lifetime.signal)
        : request.method === "subscription.read.approve"
          ? await producer.handle(request.payload, request.requestId, lifetime.signal) : { decision: "approve" };
      send(originalMcpNativeResult(request, result));
    } catch { send(originalMcpNativeErrorResult(request, "NATIVE_DENIED")); }
  };
  socket.on("error", () => socket.destroy());
  socket.on("data", chunk => {
    buffer += chunk.toString("utf8");
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (frame.type === "challenge") {
        const { body, message } = originalMcpNativeAttestationMessage(frame.challenge, identity.sha256, activationId);
        send({ type: "attestation", attestation: { ...body, signature: sign(null, message, keys.privateKey).toString("base64") } });
      } else if (frame.type === "attached") {
        assert.equal(frame.activationId, activationId);
        send({ type: "native-supports", protocol: originalMcpNativeRequestProtocol, session,
          methods: ["admission.approve", "public.approve", ...producer.methods], maxPacketBytes: 65536 });
        ready();
      } else if (frame.type === "ping") send({ type: "pong", nonce: frame.nonce });
      else if (frame.type === "native-request") void dispatch(frame);
    }
  });
  await attached;
  let host;
  if (server) {
    const nativeSession = await server.waitForSession({ timeoutMs: 1000 });
    await waitForOriginalMcpNativeSupport(nativeSession, { timeoutMs: 1000 });
    host = await createOriginalMcpNativeHost(opened.storage, createOriginalMcpNativeRequestPolicy(nativeSession));
    const { receiptSha256, ...binding } = host.receipt;
    const view = await createOriginalMcpCurrentSubscriptionSource(opened.storage, nativeSession).capture(binding, lifetime.signal);
    assert.equal(view.state.subscriptions.length, 1, "Actual signed producer and immutable source admission succeeded before the facade baseline.");
    const db = opened.storage.connectNative();
    try {
      assert.equal(db.prepare("SELECT count(*) AS total FROM receipts WHERE operation='native.subscription.original-profile.admit'").get().total, 1);
    } finally { db.close(); }
    console.log(JSON.stringify({ schema: "pkm.subscription-combined-baseline-authority/v1",
      nativeSessionAuthenticated: true, originalCustodyPlanSha256: plan.planSha256, profileSha256,
      currentProfileHead: view.head, immutableSourceAdmissions: 1, legacyAdoptionMarker: false }));
  } else host = await bootstrap.complete({ enableModels: false });
  const backend = createNativePublicOwnerBackend(opened.owner, { actor: { id: "mcp:external", canWrite: true }, originalMcpHost: host });
  cleanup.push(() => backend.close());
  const facade = createNativePublicFacade(backend, { writable: true, catalogProfile: "original-full",
    manifest: { managedRoot: directory, generation: "current-fixture", version: "0.1.0", components: {} }, closeBackend: async () => {} });
  await writeFile(join(directory, "active-generation.json"), '{"schema":"pkm.mcp.lifecycle/v1","generation":"current-fixture"}', { mode: 0o600 });
  const call = (tool, args = {}) => facade.invoke(catalog.contracts.find(item => item.transportName === tool).readOnly
    ? "capability_read" : "capability_call", { operation: `mcp.tool.${tool}`, version: 1, arguments: args });
  const receipts = () => {
    const db = opened.storage.connectNative();
    try { return db.prepare("SELECT * FROM receipts WHERE operation='native.subscription.original-profile.admit'").all(); }
    finally { db.close(); }
  };
  return { root, profile, opened, host, producer, provider, prompts, requests, secretProbes, call, receipts, publish,
    currentProfile, revoke: () => revoke(), setReadHook: hook => { readHook = hook; }, denySource: () => { sourceChoice = false; } };
}

test("default delivered native profile composition provides public list search get and path from actual original custody", async t => {
  const f = await fixture(t);
  const schema = () => {
    const db = f.opened.storage.connectNative();
    try { return hash(JSON.stringify(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all())); }
    finally { db.close(); }
  };
  const before = schema();
  assert.match(JSON.stringify(await f.call("list_subscriptions")), /Current native provider/);
  assert.match(JSON.stringify(await f.call("search_subscribed_content", { query: "native-profile", limit: 1 })), /Public/);
  assert.match(JSON.stringify(await f.call("get_subscribed_content", { node_id: f.provider.nodeId,
    share_id: f.provider.shareId, content_type: "notes", path: "Public.md" })), /Fresh native-profile/);
  assert.match(JSON.stringify(await f.call("get_subscribed_content_by_path", {
    pkm_path: `pkm://subscriptions/${f.provider.nodeId}/${f.provider.shareId}/notes/Public.md` })), /Fresh native-profile/);
  assert.equal(f.receipts().length, 1);
  assert.equal(schema(), before, "Source admission reuses receipts without changing durable table definitions.");
  assert.equal(f.secretProbes.length, 0);
  assert(f.prompts.some(prompt => prompt.manifest?.stateFileSha256));
  await assert.rejects(lstat(join(f.root, ".pkm-next-root-adoption.commit.json")), { code: "ENOENT" });
});

test("unconfigured delivered profile enrolls only an empty current identity; legacy state and private caches are never fallback sources", async t => {
  if (process.env.PKM_SUBSCRIPTION_COMBINED_BASELINE) return;
  const f = await fixture(t, false);
  await writeFile(join(f.profile, "subscriptions.json"), '{"privateKey":"excluded-history","subscriptions":[{"alias":"old-private"}]}', { mode: 0o600 });
  const result = JSON.stringify(await f.call("list_subscriptions"));
  assert(!result.includes("old-private") && !result.includes("excluded-history"));
  assert.equal(f.receipts().length, 1);
  assert(f.prompts.some(prompt => prompt.manifest?.defaultEmpty));
});

test("current native profile rejects changed key corpus membership and source epoch during an approved read", async t => {
  if (process.env.PKM_SUBSCRIPTION_COMBINED_BASELINE) return;
  for (const mutation of [
    profile => { profile.state.subscriptions[0].publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString(); },
    profile => { profile.files[2].sha256 = hash("changed corpus"); },
    profile => { profile.state.subscriptions = []; },
    profile => { profile.sourceEpoch = randomUUID(); },
  ]) await t.test(mutation.toString().slice(0, 100), async child => {
    const f = await fixture(child);
    f.setReadHook(async () => { mutation(f.currentProfile); await f.publish(); });
    await assert.rejects(f.call("list_subscriptions"));
  });
});

test("source-specific consent, protected key availability, revocation and corrupted immutable receipts fail closed", async t => {
  if (process.env.PKM_SUBSCRIPTION_COMBINED_BASELINE) return;
  await t.test("denied source enrollment", async child => {
    const f = await fixture(child); f.denySource(); await assert.rejects(f.call("list_subscriptions"));
    assert.equal(f.receipts().length, 0); assert.equal(f.secretProbes.length, 0);
  });
  await t.test("opaque protected key is unavailable", async child => {
    const f = await fixture(child); f.currentProfile.state.subscriptions[0].secretProtected = true; await f.publish();
    await assert.rejects(f.call("list_subscriptions")); assert.equal(f.receipts().length, 0);
    assert.equal(f.secretProbes.length, 1);
  });
  await t.test("native source revocation", async child => {
    const f = await fixture(child); await f.call("list_subscriptions"); f.revoke(); await assert.rejects(f.call("list_subscriptions"));
  });
  await t.test("current immutable receipt corruption", async child => {
    const f = await fixture(child); await f.call("list_subscriptions");
    const db = f.opened.storage.connectNative();
    try { db.prepare("UPDATE receipts SET result='{}' WHERE operation='native.subscription.original-profile.admit'").run(); }
    finally { db.close(); }
    await assert.rejects(f.call("list_subscriptions"));
  });
  await t.test("expired source cannot be silently re-enrolled during a pending read", async child => {
    const f = await fixture(child); await f.call("list_subscriptions");
    const { receiptSha256, ...binding } = f.host.receipt;
    const manifest = JSON.parse(f.receipts()[0].result).manifest, now = Date.now;
    try {
      Date.now = () => now() + 300001;
      await assert.rejects(f.producer.handleProfile({ binding, expectedHead: manifest.head },
        randomUUID(), f.host.signal), /SOURCE_EXPIRED/);
    } finally { Date.now = now; }
  });
  await t.test("same-revision changed corpus and older admitted revisions are never replayed", async child => {
    const f = await fixture(child); await f.call("list_subscriptions");
    f.currentProfile.state.subscriptions[0].alias = "Changed without revision";
    const metadata = JSON.parse(f.provider.files[0].raw);
    metadata.alias = f.currentProfile.state.subscriptions[0].alias;
    f.provider.files[0].raw = JSON.stringify(metadata);
    Object.assign(f.currentProfile.files[0], { sha256: hash(f.provider.files[0].raw), size: Buffer.byteLength(f.provider.files[0].raw) });
    await f.publish();
    await assert.rejects(f.call("list_subscriptions"));
    f.currentProfile.revision = 2; await f.publish();
    await f.call("list_subscriptions");
    f.currentProfile.revision = 1; await f.publish();
    await assert.rejects(f.call("list_subscriptions"));
    assert.equal(f.receipts().length, 2, "Earlier durable admissions remain intact.");
  });
  await t.test("private-key fields and nonmember traversal pins never enter current source custody", async child => {
    const f = await fixture(child);
    f.currentProfile.state.privateKey = "explicitly excluded fixture field"; await f.publish();
    await assert.rejects(f.call("list_subscriptions")); assert.equal(f.receipts().length, 0);
    delete f.currentProfile.state.privateKey;
    f.currentProfile.files[0].path = "cache/../../subscriptions.json"; await f.publish();
    await assert.rejects(f.call("list_subscriptions")); assert.equal(f.receipts().length, 0);
  });
  await t.test("signed protected corpus is locally verified with its current opaque key, never exported", async child => {
    const f = await fixture(child, true, true);
    const result = JSON.stringify(await f.call("get_subscribed_content", {
      node_id: f.provider.nodeId, share_id: f.provider.shareId, content_type: "notes", path: "Public.md" }));
    assert.match(result, /Fresh native-profile/);
    assert(!result.includes(f.provider.material));
    assert(!JSON.stringify(f.receipts()).includes(f.provider.material));
    assert(!JSON.stringify(f.requests).includes(f.provider.material));
  });
  for (const replacement of [undefined, "wrong-current-key-material"]) await t.test("protected key changed during the read", async child => {
    const f = await fixture(child, true, true);
    f.setReadHook(async () => { f.provider.material = replacement; });
    await assert.rejects(f.call("get_subscribed_content", {
      node_id: f.provider.nodeId, share_id: f.provider.shareId, content_type: "notes", path: "Public.md" }));
    assert.equal(f.receipts().length, 1);
  });
  await t.test("self-hashed cache content cannot claim a different signed Broker corpus", async child => {
    const f = await fixture(child);
    const file = f.provider.files.find(file => file.path.endsWith("/Public.md"));
    file.raw = "Not the content signed by this provider.";
    const pin = f.currentProfile.files.find(pin => pin.path === file.path);
    Object.assign(pin, { sha256: hash(file.raw), size: Buffer.byteLength(file.raw) });
    await f.publish();
    await assert.rejects(f.call("list_subscriptions")); assert.equal(f.receipts().length, 0);
  });
});
