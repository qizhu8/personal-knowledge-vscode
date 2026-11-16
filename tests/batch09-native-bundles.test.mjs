import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createCipheriv, createHash, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { deriveSecretKeys, encryptSnapshot, hash } from "../dist/domain/subscription-bundle-original.js";
import { signSubscriptionBundleProof, encodeSubscriptionBundleProof } from "../dist/subscription-bundle.js";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { httpCall, nativeWorkspace, invocation } from "./batch06-manager-fixtures.mjs";
import { nativeRestoreAuthority as fixtureRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";

const actor = { id: "native:batch09-owner", canWrite: true };
const markdown = "---\r\ndocumentId: bundle-original\r\nknowledgeId: knowledge_0123456789abcdef01234567\r\naliases: [note:historic]\r\n---\r\n# Original\r\n![asset](A.assets/image.bin)\r\n";
const image = Buffer.from([0, 255, 13, 10]);
const packageBytes = Buffer.from("export const original = 1;\r\n");
async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
async function setup(t, settings = {}) {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const secret = randomBytes(32).toString("base64url"), salt = randomBytes(16).toString("base64url");
  const keys = deriveSecretKeys(secret, salt), transferKey = randomBytes(32);
  const plaintext = Buffer.from(JSON.stringify({
    version: "3", from: "Synthetic", created_at: "",
    notes: [{ slug: "Team/A", content: markdown }],
    packages: [{ name: "Original", files: [{ path: "src/index.js", content: packageBytes.toString() }] }],
    assets: [{ type: "notes", path: "Team/A.assets/image.bin", data: image.toString("base64"), digest: hash(image) }],
  }));
  const snapshot = encryptSnapshot(plaintext, keys.contentKey), iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", transferKey, iv);
  const wire = Buffer.concat([Buffer.from("PKMENC1\n"), iv, cipher.update(snapshot), cipher.final(), cipher.getAuthTag()]);
  const source = { subscriptionId: "fixture-sub", nodeId: hash(publicKey).slice(7), shareId: "fixture-share", capabilityId: "fixture-local-copy",
    brokerName: "Fixture broker", publisherUser: "fixture-user", publisherHost: "fixture-host", revision: 1, collectionHash: hash(snapshot) };
  const unsigned = { shareId: source.shareId, name: source.brokerName, revision: source.revision, collectionHash: source.collectionHash,
    updatedAt: "2026-11-07T00:00:00.000Z", counts: { notes: 1, packages: 1 }, topics: [], tags: [], itemCount: 2,
    metadataOnly: true, secretProtected: true, secretSalt: salt, snapshotBytes: snapshot.length };
  const summary = { ...unsigned, signature: sign(null, Buffer.from(JSON.stringify(unsigned)), pair.privateKey).toString("base64url") };
  const subscriber = generateKeyPairSync("ed25519");
  const subscriberPublicKey = subscriber.publicKey.export({ type: "spki", format: "pem" }).toString();
  const state = { allowed: true, epoch: "epoch-1", revision: "acl-1", interrupted: false, leases: [], requests: [], stages: [], proofs: [] };
  const restorePin = { request: undefined, calls: 0 };
  const nativeRestoreAuthority = {
    actorId: actor.id,
    authorize(request) {
      if (!restorePin.request || JSON.stringify(request) !== JSON.stringify(restorePin.request)) return null;
      restorePin.calls++;
      return fixtureRestoreAuthority.authorize(request);
    },
  };
  let composed;
  const data = createServer((req, res) => {
    state.requests.push(`data:${req.method}:${req.url}`);
    assert.equal(req.headers.authorization, "Bearer fixture_ticket_0123456789");
    const db = composed.storage.connectNative();
    try { assert.equal(db.prepare("SELECT state FROM remote_runtime_intents WHERE kind='remote.subscription.bundle'").get().state, "pending"); }
    finally { db.close(); }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": wire.length });
    res.end(settings.corrupt ? Buffer.concat([wire.subarray(0, wire.length - 1), Buffer.from([wire.at(-1) ^ 1])]) : wire);
  });
  const dataPort = await listen(data);
  const control = createServer((req, res) => {
    state.requests.push(`control:${req.method}:${req.url}`);
    const proof = JSON.parse(Buffer.from(req.headers["x-pkm-subscriber-proof"], "base64url").toString());
    const { signature, ...unsignedProof } = proof;
    assert.equal(proof.publicKey, subscriberPublicKey); assert.equal(proof.shareId, source.shareId);
    assert.equal(proof.nodeId, hash(subscriberPublicKey).slice(7));
    assert(verify(null, Buffer.from(JSON.stringify(unsignedProof)), subscriberPublicKey, Buffer.from(signature, "base64url")));
    res.setHeader("Content-Type", "application/json");
    if (req.url.endsWith("/summary")) {
      res.end(JSON.stringify(settings.badSignature ? { ...summary, signature: "AAAA" } : summary));
    } else {
      res.end(JSON.stringify({ brokerUrl: `http://127.0.0.1:${dataPort}`, ticket: "fixture_ticket_0123456789",
        expiresAt: new Date(Date.now() + 60_000).toISOString(), revision: source.revision, collectionHash: source.collectionHash }));
    }
  });
  const controlPort = await listen(control);
  t.after(async () => {
    data.closeAllConnections(); control.closeAllConnections();
    await Promise.all([data, control].map(server => new Promise(resolve => server.close(resolve))));
    for (const stage of state.stages) await rm(stage, { recursive: true, force: true });
    keys.contentKey.fill(0); keys.authVerifier.fill(0); transferKey.fill(0);
  });
  const pin = () => ({ publisherPublicKey: publicKey, keyEpoch: state.epoch, policyRevision: state.revision });
  const checkSource = given => {
    if (!state.allowed || JSON.stringify(given) !== JSON.stringify(source)) throw new Error("Denied synthetic native source");
  };
  const configure = async root => {
    const stage = resolve(import.meta.dirname, `.batch09-wire-${root.split("/").at(-1)}`);
    const codecStage = resolve(import.meta.dirname, `.batch09-codec-${root.split("/").at(-1)}`);
    for (const path of [stage, codecStage]) { await mkdir(path, { recursive: true, mode: 0o700 }); if (!state.stages.includes(path)) state.stages.push(path); }
    return {
      hostServices: { authorizeBackup: async () => true, backupOptions: { nativeRestoreAuthority } },
      subscriptionBundle: {
        endpoint: { bindingId: "fixture-native-binding", controlUrl: `http://127.0.0.1:${controlPort}/`, connectAddress: "127.0.0.1",
          transferPorts: [dataPort], secretRef: "fixture-proof-reference", publisherPublicKey: publicKey },
        stagingRoot: stage, codecStagingRoot: codecStage,
        secrets: {
          async resolve(_reference, shareId) {
            const proof = await signSubscriptionBundleProof({
              publicKey: subscriberPublicKey,
              async sign(bytes) { return sign(null, bytes, subscriber.privateKey); },
            }, { name: actor.id, shareId, timestamp: Date.now(), nonce: randomUUID() }, new AbortController().signal);
            const encoded = encodeSubscriptionBundleProof(proof); state.proofs.push(encoded);
            return { subscriberProof: encoded };
          },
        },
        async authorizeTransfer(id, given) {
          assert.equal(id, actor.id); checkSource(given);
          return { wireSha256: hash(wire), wireBytes: wire.length };
        },
        nativeHost: {
          async authorize(given) { checkSource(given); return pin(); },
          async resolveKeys() {
            const lease = { epoch: state.epoch, transferKey: Buffer.from(transferKey), contentKey: Buffer.from(keys.contentKey), release() {} };
            state.leases.push(lease); return lease;
          },
        },
        nativePolicy: {
          async authorize(binding) {
            assert.equal(binding.actorId, actor.id); checkSource(binding.source);
            assert.equal(binding.ciphertextSha256, hash(snapshot));
            assert.equal(binding.plaintextSha256, hash(plaintext));
            return pin();
          },
        },
        boundary(event) {
          if (settings.interrupt && event === settings.interrupt && !state.interrupted) {
            state.interrupted = true; throw new Error("Synthetic interruption after durable native boundary");
          }
          if (settings.revoke && event === settings.revoke) state.allowed = false;
        },
      },
    };
  };
  composed = await nativeWorkspace(t, configure);
  const request = { operationId: randomUUID(), source, expiresAt: new Date(Date.now() + 100_000).toISOString() };
  const url = await composed.listen(actor);
  const call = args => httpCall(url, composed.bearer, "capability_call", invocation("remote.runtime.subscription.bundle.run", args));
  return { composed, source, request, wire, snapshot, plaintext, state, configure, call, url, secret, keys, transferKey, restorePin };
}
async function tree(root) {
  const files = [];
  async function walk(path) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const full = join(path, item.name);
      if (item.isDirectory()) await walk(full);
      else if (!["core.sqlite", "core.sqlite-wal", "core.sqlite-shm"].includes(item.name)) files.push([full.slice(root.length), (await readFile(full)).toString("base64")]);
    }
  }
  await walk(root); return files.sort(([a], [b]) => a.localeCompare(b));
}
function dbRead(f, callback) {
  const db = f.composed.storage.connectNative(); try { return callback(db); } finally { db.close(); }
}
test("configured Core HTTP -> local original encrypted transfer -> native journal MD/assets/package exact identity and receipt replay", async t => {
  const f = await setup(t), response = await f.call(f.request);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const result = response.body.result, receipt = result.apply;
  assert.equal(result.wireSha256, hash(f.wire)); assert.equal(receipt.ciphertextSha256, hash(f.snapshot));
  assert.equal(receipt.plaintextSha256, hash(f.plaintext));
  assert.equal(receipt.source.collectionHash, f.source.collectionHash);
  assert.equal(new Set([result.wireSha256, receipt.ciphertextSha256, receipt.plaintextSha256]).size, 3);
  for (const file of receipt.files) assert.equal(hash(await readFile(join(f.composed.root, file.path))), file.sha256);
  assert.equal((await readFile(join(f.composed.root, receipt.files.find(file => file.path.endsWith("Team/A.md")).path))).toString(), markdown);
  assert.deepEqual(await readFile(join(f.composed.root, receipt.files.find(file => file.path.endsWith("image.bin")).path)), image);
  assert.deepEqual(await readFile(join(f.composed.root, receipt.files.find(file => file.path.endsWith("index.js")).path)), packageBytes);
  const read = await httpCall(f.url, f.composed.bearer, "capability_read", invocation("knowledge.document.get", { id: "bundle-original" }));
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.result.content, "# Original\r\n![asset](A.assets/image.bin)\r\n");
  assert.equal(read.body.result.sha256, hash(markdown).slice(7));
  assert.equal(dbRead(f, db => db.prepare("SELECT id FROM documents WHERE id='bundle-original'").get().id), "bundle-original");
  assert(dbRead(f, db => db.prepare("SELECT * FROM remote_subscription_identities WHERE namespace='package'").get()));
  const journal = dbRead(f, db => ({
    apply: db.prepare("SELECT * FROM remote_subscription_apply").get(),
    grant: db.prepare("SELECT * FROM remote_runtime_pins WHERE pin_id LIKE 'native-bundle:%'").get(),
    parent: db.prepare("SELECT * FROM remote_runtime_intents").get(), receipt: db.prepare("SELECT * FROM receipts").get(),
  }));
  assert.equal(journal.parent.state, "complete"); assert.equal(journal.apply.receipt_json, JSON.stringify(receipt));
  assert.equal(journal.receipt.result, JSON.stringify(result));
  for (const secret of [f.secret, f.transferKey.toString("base64"), f.keys.contentKey.toString("base64"), "fixture_ticket_0123456789", ...f.state.proofs, "fixture-proof-reference"])
    assert(!JSON.stringify(journal).includes(secret), "no key, ticket, proof or secret reference persisted");
  for (const lease of f.state.leases) assert(lease.transferKey.every(v => v === 0) && lease.contentKey.every(v => v === 0));
  const before = await tree(f.composed.root), requests = f.state.requests.length;
  assert.deepEqual((await f.call(f.request)).body.result, result);
  assert.equal(f.state.requests.length, requests, "receipt replay does not redownload or resolve keys");
  assert.deepEqual(await tree(f.composed.root), before);
  assert.notEqual((await f.call({ ...f.request, source: { ...f.source, revision: 2 } })).status, 200);
  assert.notEqual((await f.call({ ...f.request, expiresAt: new Date(Date.parse(f.request.expiresAt) - 1000).toISOString() })).status, 200,
    "same owner/source with a changed immutable intent conflicts with the global receipt");
  assert.notEqual((await f.call({ ...f.request, plaintextSha256: receipt.plaintextSha256 })).status, 200, "public plaintext grant injection rejected");
  f.state.allowed = false;
  const revoked = await httpCall(f.url, f.composed.bearer, "capability_call", invocation("remote.runtime.subscription.bundle.recover", { operationId: f.request.operationId }));
  assert.notEqual(revoked.status, 200, "receipt read still checks native ACL"); assert.deepEqual(await tree(f.composed.root), before);
});
test("native interrupted intent blocks sibling effects, restarts with current ACL, exact bytes and no new key resolution", async t => {
  const f = await setup(t, { interrupt: "intent" });
  assert.notEqual((await f.call(f.request)).status, 200);
  assert.equal(dbRead(f, db => db.prepare("SELECT receipt_json FROM remote_subscription_apply").get().receipt_json), null);
  const denied = await f.composed.call("knowledge.note.create", { operationId: randomUUID(), id: "sibling", markdown: "# No\n" }, actor);
  assert(denied.error, "pending bundle fences generic write");
  const leases = f.state.leases.length, requests = f.state.requests.length;
  await f.composed.reopen(f.configure);
  assert.equal(f.state.leases.length, leases); assert.equal(f.state.requests.length, requests);
  assert.equal(dbRead(f, db => db.prepare("SELECT state FROM remote_runtime_intents").get().state), "complete");
  const result = await f.composed.call("remote.runtime.subscription.bundle.recover", { operationId: f.request.operationId }, actor);
  assert(!result.error, JSON.stringify(result));
  for (const file of result.result.apply.files) assert.equal(hash(await readFile(join(f.composed.root, file.path))), file.sha256);
});
test("actual partial package hardlink prefix resumes on restart; post-apply receipt loss is reconciled exactly once", async t => {
  for (const interrupt of ["publish:1", "commit"]) {
    const f = await setup(t, { interrupt });
    assert.notEqual((await f.call(f.request)).status, 200);
    assert.equal(dbRead(f, db => db.prepare("SELECT state FROM remote_runtime_intents").get().state), "pending");
    const requests = f.state.requests.length, leases = f.state.leases.length;
    await f.composed.reopen(f.configure);
    const recovered = await f.composed.call("remote.runtime.subscription.bundle.recover", { operationId: f.request.operationId }, actor);
    assert(!recovered.error, JSON.stringify(recovered));
    assert.equal(f.state.requests.length, requests); assert.equal(f.state.leases.length, leases);
    for (const file of recovered.result.apply.files) assert.equal(hash(await readFile(join(f.composed.root, file.path))), file.sha256);
    assert.equal(dbRead(f, db => db.prepare("SELECT COUNT(*) AS count FROM remote_subscription_apply WHERE receipt_json IS NOT NULL").get().count), 1);
    assert.equal(dbRead(f, db => db.prepare("SELECT COUNT(*) AS count FROM receipts").get().count), 1);
  }
});
test("actual configured native MCP process replays the HTTP/socket native bundle receipt without fetching secrets or keys", async t => {
  const f = await setup(t), applied = await f.call(f.request);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const native = (await f.configure(f.composed.root)).subscriptionBundle;
  const fixture = {
    actor, endpoint: native.endpoint, stagingRoot: native.stagingRoot, codecStagingRoot: native.codecStagingRoot,
    source: f.source, ciphertextSha256: hash(f.snapshot), plaintextSha256: hash(f.plaintext),
    authority: { publisherPublicKey: native.endpoint.publisherPublicKey, keyEpoch: f.state.epoch, policyRevision: f.state.revision },
    transfer: { wireSha256: hash(f.wire), wireBytes: f.wire.length },
  };
  await f.composed.close();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, "batch09-native-bundles-mcp-child.mjs"), f.composed.root, JSON.stringify(fixture)],
    stderr: "pipe",
  });
  const client = new Client({ name: "batch09-native-bundle-fixture", version: "1" });
  try {
    await client.connect(transport);
    const replay = await client.callTool({ name: "capability_call", arguments: invocation("remote.runtime.subscription.bundle.recover", { operationId: f.request.operationId }) });
    assert.equal(replay.isError, false, JSON.stringify(replay));
    assert.deepEqual(replay.structuredContent.result, applied.body.result);
    const read = await client.callTool({ name: "capability_read", arguments: invocation("knowledge.document.get", { id: "bundle-original" }) });
    assert.equal(read.isError, false); assert.equal(read.structuredContent.result.sha256, hash(markdown).slice(7));
  } finally { await client.close(); await transport.close(); }
});
test("configured bundle package bytes and shared grants survive native quiescent backup and absent-destination restore", async t => {
  const f = await setup(t), applied = await f.call(f.request);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const backup = resolve(import.meta.dirname, `.batch09-bundle-backup-${randomUUID()}`);
  const restored = resolve(import.meta.dirname, `.batch09-bundle-restored-${randomUUID()}`);
  f.state.stages.push(backup, restored);
  await f.composed.runtime.services.hostServices.backup(backup);
  await assert.rejects(f.composed.runtime.services.hostServices.restore(backup, restored), { code: "AUTHORITY_REQUIRED" });
  const sourceStat = await lstat(backup, { bigint: true });
  f.restorePin.request = {
    schema: "pkm.native-restore-authority-request/v1", intent: "workspace-restore", actorId: actor.id,
    workspaceId: await f.composed.storage.workspaceId(), sourceRoot: backup, sourceDevice: String(sourceStat.dev),
    sourceInode: String(sourceStat.ino),
    manifestSha256: createHash("sha256").update(await readFile(join(backup, ".pkm-workspace-backup.json"))).digest("hex"),
    destination: restored, backupErasureEpoch: null,
  };
  await f.composed.runtime.services.hostServices.restore(backup, restored);
  assert.equal(f.restorePin.calls, process.platform === "linux" ? 4 : 3,
    "Restore reauthorizes before staging, after validation, before publication and after Linux fence marker binding");
  for (const file of applied.body.result.apply.files) assert.equal(hash(await readFile(join(restored, file.path))), file.sha256);
  const db = new DatabaseSync(join(restored, "core.sqlite"));
  try {
    assert.equal(db.prepare("SELECT result_json FROM remote_runtime_intents").get().result_json, JSON.stringify(applied.body.result));
    assert(db.prepare("SELECT pin_json FROM remote_runtime_pins WHERE pin_id LIKE 'native-bundle:%'").get());
  } finally { db.close(); }
  const storage = await Storage.open(restored, { deferRecovery: true });
  const runtime = await createNativeRuntime({ storage, ...await f.configure(restored) });
  try {
    const replay = await runtime.core.dispatch("capability_call", invocation("remote.runtime.subscription.bundle.recover", { operationId: f.request.operationId }), actor);
    assert(!replay.error, JSON.stringify(replay)); assert.deepEqual(replay.result, applied.body.result);
  } finally { await runtime.close(); await storage.close(); }
});
for (const revoke of ["allowed", "epoch", "revision", "grant", "unknown-state"]) {
  test(`restart native bundle recovery fails before effects on ${revoke}`, async t => {
    const f = await setup(t, { interrupt: "intent" });
    assert.notEqual((await f.call(f.request)).status, 200);
    if (revoke === "allowed") f.state.allowed = false;
    if (revoke === "epoch") f.state.epoch = "epoch-2";
    if (revoke === "revision") f.state.revision = "acl-2";
    if (revoke === "grant") dbRead(f, db => db.prepare("DELETE FROM remote_runtime_pins WHERE pin_id LIKE 'native-bundle:%'").run());
    if (revoke === "unknown-state") dbRead(f, db => db.prepare("UPDATE remote_runtime_intents SET state='mystery'").run());
    const before = await tree(f.composed.root), requests = f.state.requests.length;
    await f.composed.close();
    const storage = await Storage.open(f.composed.root, { deferRecovery: true });
    try { await assert.rejects(createNativeRuntime({ storage, ...await f.configure(f.composed.root) })); }
    finally { await storage.close(); }
    assert.deepEqual(await tree(f.composed.root), before);
    assert.equal(f.state.requests.length, requests);
    const db = new DatabaseSync(join(f.composed.root, "core.sqlite"));
    try {
      assert.equal(db.prepare("SELECT receipt_json FROM remote_subscription_apply").get().receipt_json, null);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM documents").get().count, 0);
    } finally { db.close(); }
  });
}
test("no bundle authority means unavailable Core operation; bad transfer or signature creates no native local intent", async t => {
  const root = resolve(import.meta.dirname, `.batch09-unavailable-${randomUUID()}`);
  await initialize(root);
  const storage = await Storage.open(root);
  const runtime = await createNativeRuntime({ storage });
  try {
    const unavailable = await runtime.core.dispatch("capability_call", invocation("remote.runtime.subscription.bundle.recover", { operationId: randomUUID() }), actor);
    assert(unavailable.error);
  } finally { await runtime.close(); await storage.close(); await rm(root, { recursive: true, force: true }); }
  for (const settings of [{ corrupt: true }, { badSignature: true }]) {
    const f = await setup(t, settings);
    assert.notEqual((await f.call(f.request)).status, 200);
    assert.equal(dbRead(f, db => db.prepare("SELECT COUNT(*) AS count FROM remote_subscription_apply").get().count), 0);
    assert.equal(dbRead(f, db => db.prepare("SELECT COUNT(*) AS count FROM documents").get().count), 0);
  }
});
