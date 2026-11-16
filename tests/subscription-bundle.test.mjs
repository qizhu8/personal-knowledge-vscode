import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SubscriptionBundleHost, signSubscriptionBundleProof, encodeSubscriptionBundleProof } from "../dist/subscription-bundle.js";
import { deriveSecretKeys, encryptSnapshot, decryptSnapshot, decryptTransfer, forkPackage, hash } from "../dist/domain/subscription-bundle-original.js";
import { SubscriptionApplyHost } from "../dist/subscription-apply.js";
import { subscriptionReadSourceFiles } from "./subscription-reads-fixtures.mjs";
import { scanMarkdown } from "../dist/markdown.js";
import { authenticateContextSources, readContextOriginal } from "./context-original-source-captures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const originalContent = "---\r\ndocumentId: source-original\r\naliases: [note:historical]\r\n---\r\n# Original\r\n";
function fixture(t, options = {}) {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const salt = randomBytes(16).toString("base64url");
  // No stored key fixtures or native secrets: every secret and signing key is generated here.
  const secret = randomBytes(32).toString("base64url");
  const keys = deriveSecretKeys(secret, salt);
  const transferKey = createHmac("sha256", keys.authVerifier)
    .update(`pkm-transfer:v1:synthetic-subscriber:fixture-share:1:23456:${randomBytes(12).toString("base64url")}`).digest();
  const bundle = options.bundle ?? {
    from: "Synthetic", created_at: "", version: "3",
    notes: [{ slug: "Team/A", content: originalContent }],
    packages: [{ name: "Example", files: [{ path: "README.md", content: "# Example\n" }, { path: "src/index.js", content: "export const value = 1;\n" }] }],
  };
  const plaintext = Buffer.from(JSON.stringify(bundle));
  const encrypted = options.encrypted !== false;
  const snapshot = encrypted ? encryptSnapshot(plaintext, keys.contentKey) : plaintext;
  function transfer(value) {
    if (!encrypted) return Buffer.from(value);
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", transferKey, iv);
    return Buffer.concat([Buffer.from("PKMENC1\n"), iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
  }
  const source = {
    subscriptionId: "fixture-sub", nodeId: hash(publicKey).slice(7), shareId: "fixture-share", capabilityId: "fixture-local-copy",
    brokerName: "Fixture broker", publisherUser: "fixture-user", publisherHost: "fixture-host", revision: 1, collectionHash: hash(snapshot),
  };
  const counts = Object.fromEntries(["notes", "skills", "papers", "packages", "prompts", "scripts", "servers", "recipes"]
    .filter(k => bundle[k]?.length).map(k => [k, bundle[k].length]));
  const unsigned = {
    shareId: source.shareId, name: source.brokerName, revision: 1, collectionHash: source.collectionHash,
    updatedAt: "2026-11-07T00:00:00.000Z", counts, topics: [], tags: [], itemCount: Object.values(counts).reduce((a, b) => a + b, 0),
    metadataOnly: true, secretProtected: encrypted, ...(encrypted ? { secretSalt: salt } : {}), snapshotBytes: snapshot.length,
  };
  const signed = value => ({ ...value, signature: sign(null, Buffer.from(JSON.stringify(value)), pair.privateKey).toString("base64url") });
  const request = { source, mode: options.mode ?? "readonly-mirror", summary: signed(unsigned), wire: transfer(snapshot) };
  const state = { allowed: true, policyRevision: "native-acl-1", keyEpoch: "native-key-1", calls: 0, resolved: 0, released: 0, leases: [] };
  const native = {
    async authorize(sourcePin, mode, signal) {
      assert.equal(sourcePin.nodeId, source.nodeId); assert.equal(mode, request.mode);
      state.calls++;
      if (state.onAuthorize) await state.onAuthorize(state.calls, signal);
      if (!state.allowed) throw new Error(`private failure ${secret}`);
      return { publisherPublicKey: state.publicKey ?? publicKey, policyRevision: state.policyRevision, keyEpoch: state.keyEpoch };
    },
    async resolveKeys(_source, authority, signal) {
      state.resolved++;
      const lease = {
        epoch: state.leaseEpoch ?? authority.keyEpoch,
        transferKey: Buffer.from(state.wrongTransfer ? randomBytes(32) : transferKey),
        contentKey: Buffer.from(state.wrongContent ? randomBytes(32) : keys.contentKey),
        async release() { state.released++; if (state.onRelease) await state.onRelease(); },
      };
      state.leases.push(lease);
      if (state.onResolve) await state.onResolve(signal);
      return lease;
    },
  };
  t.after(() => { keys.authVerifier.fill(0); keys.contentKey.fill(0); transferKey.fill(0); });
  return { request, state, host: new SubscriptionBundleHost(native), signed, unsigned, plaintext, snapshot, transfer, keys, transferKey, publicKey, pair, secret };
}
function scratch(t) {
  const root = resolve(here, `subscription-bundle-work-${randomUUID()}`);
  mkdirSync(root, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function zeroed(f) {
  assert.equal(f.state.released, f.state.leases.length);
  for (const lease of f.state.leases) {
    assert(lease.transferKey.every(v => v === 0));
    assert(lease.contentKey.every(v => v === 0));
  }
}
test("original captured encrypt/decrypt interoperates with native Buffer-only bounded conversion; source identity remains original", async t => {
  const f = fixture(t);
  assert.deepEqual(decryptTransfer(f.request.wire, f.transferKey.toString("base64url")), f.snapshot);
  assert.deepEqual(decryptSnapshot(f.snapshot, f.keys.contentKey.toString("base64url")), f.plaintext);
  const result = await f.host.inspect(f.request);
  assert.equal(result.snapshot, f.plaintext.toString());
  assert.equal(result.plaintextSha256, hash(f.plaintext));
  assert.equal(result.source.collectionHash, hash(f.snapshot));
  assert.notEqual(result.source.collectionHash, result.plaintextSha256);
  assert.equal(result.mode, "readonly-mirror");
  assert.equal(result.files[0].content, originalContent);
  assert.equal(result.files[2].stagePath, "content/packages/Example/src/index.js");
  assert(Object.isFrozen(result) && Object.isFrozen(result.files) && Object.isFrozen(result.source));
  assert(!JSON.stringify(result).includes(f.secret));
  assert(!Object.keys(result).some(k => /key|epoch|authority|handle|signature/i.test(k)));
  zeroed(f);
});
test("native signer uses exact original schema/order; verification and sanitized failure", async t => {
  const f = fixture(t);
  const signal = new AbortController().signal;
  const proof = await signSubscriptionBundleProof({
    publicKey: f.publicKey,
    async sign(bytes) {
      const value = JSON.parse(Buffer.from(bytes).toString());
      assert.deepEqual(Object.keys(value), ["schema", "nodeId", "name", "publicKey", "shareId", "timestamp", "nonce"]);
      return sign(null, bytes, f.pair.privateKey);
    },
  }, { name: "Synthetic", shareId: "fixture-share", timestamp: 1, nonce: randomBytes(12).toString("base64url") }, signal);
  const { signature, ...unsigned } = proof;
  assert.equal(proof.schema, 1);
  assert.deepEqual(JSON.parse(Buffer.from(encodeSubscriptionBundleProof(proof), "base64url").toString()), proof);
  assert(verify(null, Buffer.from(JSON.stringify(unsigned)), f.publicKey, Buffer.from(signature, "base64url")));
  await assert.rejects(signSubscriptionBundleProof({ publicKey: f.publicKey, async sign() { throw new Error(f.secret); } },
    { name: "Synthetic", shareId: "fixture-share", timestamp: 1, nonce: "fixture" }, signal), { code: "AUTHENTICATION_FAILED" });
});
test("signature tamper, wrong publisher, source revision/hash/name and membership pins fail closed", async t => {
  for (const mutate of [
    f => { f.request.summary.signature = "AAAA"; },
    f => { f.request.summary.counts.notes = 8; },
    f => { f.request.source.revision++; },
    f => { f.request.source.collectionHash = `sha256:${"0".repeat(64)}`; },
    f => { f.request.source.brokerName = "Other"; },
    f => { f.state.publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString(); },
    f => { f.request.summary = f.signed({ ...f.unsigned, counts: { notes: 9, packages: 1 }, itemCount: 10 }); },
    f => { f.request.summary = f.signed({ ...f.unsigned, itemCount: 99 }); },
  ]) {
    const f = fixture(t); mutate(f);
    await assert.rejects(f.host.inspect(f.request));
    zeroed(f);
  }
});
test("transfer and snapshot GCM tampering, wrong keys, stale native epochs zero leases without leaking", async t => {
  for (const mutate of [
    f => { f.request.wire[f.request.wire.length - 1] ^= 1; },
    f => { f.state.wrongTransfer = true; },
    f => { f.state.wrongContent = true; },
    f => { f.state.leaseEpoch = "old-native-key"; },
    f => { f.state.onResolve = () => { f.state.keyEpoch = "rotated-native-key"; }; },
    f => {
      const envelope = JSON.parse(f.snapshot.toString()), tag = Buffer.from(envelope.tag, "base64url");
      tag[0] ^= 1; envelope.tag = tag.toString("base64url");
      const snapshot = Buffer.from(JSON.stringify(envelope));
      f.request.source.collectionHash = hash(snapshot);
      f.request.summary = f.signed({ ...f.unsigned, collectionHash: hash(snapshot), snapshotBytes: snapshot.length });
      f.request.wire = f.transfer(snapshot);
    },
  ]) {
    const f = fixture(t); mutate(f);
    await assert.rejects(f.host.inspect(f.request), error => {
      assert(!error.message.includes(f.secret)); return true;
    });
    zeroed(f);
  }
});
test("revocation, policy changes and cancellation fence resolution/release/staging", async t => {
  for (const point of ["resolve", "release", "before", "stage"]) {
    const f = fixture(t), controller = new AbortController();
    if (point === "before") controller.abort();
    if (point === "resolve") f.state.onResolve = () => controller.abort();
    if (point === "release") f.state.onRelease = () => controller.abort();
    if (point === "stage") f.state.onAuthorize = calls => { if (calls === 5) controller.abort(); };
    const root = scratch(t);
    await assert.rejects(f.host.consume(f.request, root, { async consume() { assert.fail("No consumption after cancellation"); } }, controller.signal), { code: "CANCELLED" });
    assert.deepEqual(readdirSync(root), []); zeroed(f);
  }
  for (const change of [s => { s.allowed = false; }, s => { s.policyRevision = "native-policy-2"; }]) {
    const f = fixture(t); f.state.onResolve = () => change(f.state);
    await assert.rejects(f.host.inspect(f.request), { code: "ACCESS_DENIED" }); zeroed(f);
  }
});
test("original v3 package file arrays safely stage then cleanup; native hooks preserve source IDs in fork and mirror", async t => {
  for (const mode of ["fork", "readonly-mirror"]) {
    const f = fixture(t, { mode }), root = scratch(t);
    const result = await f.host.consume(f.request, root, {
      async consume(bundle, stage) {
        assert.equal(bundle.mode, mode);
        assert.equal(bundle.source.collectionHash, f.request.source.collectionHash);
        assert.equal(readFileSync(join(stage, "content/notes/Team/A.md"), "utf8"), originalContent);
        assert.equal(readFileSync(join(stage, "content/packages/Example/src/index.js"), "utf8"), "export const value = 1;\n");
        assert.equal(readdirSync(root).length, 1);
        return { readOnly: mode === "readonly-mirror", identity: bundle.source.nodeId };
      },
    });
    assert.equal(result.identity, f.request.source.nodeId);
    assert.equal(result.readOnly, mode === "readonly-mirror");
    assert.deepEqual(readdirSync(root), []); zeroed(f);
  }
});
test("executable original package fork preserves name/publisher provenance and exact extracted UTF-8 file bytes", async t => {
  const f = fixture(t, { mode: "fork" }), root = scratch(t);
  const pkg = JSON.parse(f.plaintext.toString()).packages[0];
  const target = forkPackage(root, {
    package: pkg, brokerName: f.request.source.brokerName,
    publisherUser: f.request.source.publisherUser, publisherHost: f.request.source.publisherHost,
  });
  const verified = await f.host.inspect(f.request);
  for (const file of verified.files.filter(file => file.area === "packages")) {
    assert.equal(readFileSync(join(root, target, file.path.slice(pkg.name.length + 1)), "utf8"), file.content);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(root, target, ".pkm-package.json"), "utf8")), {
    schema: 1, kind: "subscription-fork", originalName: pkg.name, brokerName: f.request.source.brokerName,
    publisherUser: f.request.source.publisherUser, publisherHost: f.request.source.publisherHost,
  });
  assert.equal(forkPackage(root, {
    package: pkg, brokerName: f.request.source.brokerName,
    publisherUser: f.request.source.publisherUser, publisherHost: f.request.source.publisherHost,
  }), `${target}1`);
  zeroed(f);
});
test("staging rejects symlink root/ancestor and cleans up on adapter failure", async t => {
  const f = fixture(t), root = scratch(t), real = join(root, "real"), link = join(root, "link");
  mkdirSync(real, { mode: 0o700 }); symlinkSync(real, link);
  await assert.rejects(f.host.consume(f.request, link, { async consume() { assert.fail(); } }), { code: "UNSAFE_STAGE" });
  mkdirSync(join(real, "nested"));
  await assert.rejects(f.host.consume(f.request, join(link, "nested"), { async consume() { assert.fail(); } }), { code: "UNSAFE_STAGE" });
  await assert.rejects(f.host.consume(f.request, real, { async consume() { throw new Error(`fixture interruption ${f.secret}`); } }), { code: "NATIVE_ADAPTER_FAILED" });
  assert.deepEqual(readdirSync(real), ["nested"]); zeroed(f);
});
test("caller mutation across native suspension does not replace signed bundle bytes or identity pins", async t => {
  const f = fixture(t);
  f.state.onAuthorize = calls => {
    if (calls === 1) {
      f.request.wire.fill(0);
      f.request.summary.signature = "AAAA";
      f.request.source.brokerName = "Mutated";
    }
  };
  const verified = await f.host.inspect(f.request);
  assert.equal(verified.source.brokerName, "Fixture broker");
  assert.equal(verified.files[0].content, originalContent);
  zeroed(f);
});
test("initial revocation and release-time policy/key rotation forbid consumption", async t => {
  for (const change of [
    s => { s.allowed = false; },
    s => { s.policyRevision = "rotated-policy"; },
    s => { s.keyEpoch = "rotated-key"; },
  ]) {
    const f = fixture(t), root = scratch(t);
    f.state.onRelease = () => change(f.state);
    await assert.rejects(f.host.consume(f.request, root, { async consume() { assert.fail(); } }));
    assert.deepEqual(readdirSync(root), []); zeroed(f);
  }
  const f = fixture(t); f.state.allowed = false;
  await assert.rejects(f.host.inspect(f.request), { code: "ACCESS_DENIED" });
  assert.equal(f.state.resolved, 0);
});
test("package traversal, absolute paths, normalized collisions, symlink metadata and prefix collisions rejected", async t => {
  for (const files of [
    [{ path: "../outside", content: "x" }], [{ path: "/outside", content: "x" }], [{ path: "a\\b", content: "x" }],
    [{ path: "con.txt", content: "x" }], [{ path: "file ", content: "x" }],
    [{ path: "A.txt", content: "x" }, { path: "a.txt", content: "y" }],
    [{ path: "a", content: "x" }, { path: "a/b", content: "y" }],
    [{ path: "x", content: "x", symlink: "../../outside" }],
  ]) {
    const f = fixture(t, { bundle: { version: "3", packages: [{ name: "Example", files }] } });
    await assert.rejects(f.host.inspect(f.request)); zeroed(f);
  }
});
test("uncapped Note payloads and unsupported prior/envelope/archive versions", async t => {
  for (const bundle of [
    { version: "2", packages: [] }, { version: "1", notes: [] },
    { version: "3", scripts: [{ file: "x", content: "x" }] },
  ]) {
    const f = fixture(t, { bundle });
    await assert.rejects(f.host.inspect(f.request)); zeroed(f);
  }
  const large = fixture(t, { bundle: { version: "3", notes: [{ slug: "large", content: "x".repeat(1_048_577) }] } });
  await assert.doesNotReject(large.host.inspect(large.request));
  zeroed(large);
  const many = fixture(t, { bundle: {
    version: "3", notes: Array.from({ length: 4097 }, (_, index) => ({ slug: `note-${index}`, content: "x" })),
  } });
  await assert.doesNotReject(many.host.inspect(many.request));
  zeroed(many);
  const largeSkill = fixture(t, { bundle: {
    version: "3", skills: [{ name: "Large", content: "x".repeat(1_048_577) }],
  } });
  await assert.rejects(largeSkill.host.inspect(largeSkill.request), { code: "QUOTA_EXCEEDED" });
  zeroed(largeSkill);
  const manySkills = fixture(t, { bundle: {
    version: "3", skills: Array.from({ length: 4097 }, (_, index) => ({ name: `skill-${index}`, content: "x" })),
  } });
  await assert.rejects(manySkills.host.inspect(manySkills.request), { code: "QUOTA_EXCEEDED" });
  zeroed(manySkills);
  const open = fixture(t, { encrypted: false });
  open.request.wire = Buffer.from("PK\u0003\u0004synthetic-zip-header");
  open.request.source.collectionHash = hash(open.request.wire);
  open.request.summary = open.signed({ ...open.unsigned, collectionHash: open.request.source.collectionHash, snapshotBytes: open.request.wire.length });
  await assert.rejects(open.host.inspect(open.request), { code: "INVALID_FORMAT" });
  const unsupported = fixture(t);
  const envelope = Buffer.from(JSON.stringify({ v: 2, alg: "A256GCM" }));
  unsupported.request.wire = unsupported.transfer(envelope);
  unsupported.request.source.collectionHash = hash(envelope);
  unsupported.request.summary = unsupported.signed({ ...unsupported.unsigned, collectionHash: hash(envelope), snapshotBytes: envelope.length });
  await assert.rejects(unsupported.host.inspect(unsupported.request), { code: "UNSUPPORTED_FORMAT" }); zeroed(unsupported);
});
test("actual existing apply adapter accepts open Markdown without replacing source hash; encrypted/package adapters fail closed", async t => {
  const f = fixture(t, { encrypted: false, mode: "fork", bundle: { version: "3", notes: [{ slug: "Team/A", content: originalContent }] } });
  const root = scratch(t);
  mkdirSync(join(root, "notes")); mkdirSync(join(root, "subscriptions"));
  writeFileSync(join(root, ".pkm-next-workspace"), JSON.stringify({ schema: "pkm.next-workspace/v2" }));
  const records = structuredClone(subscriptionReadSourceFiles);
  Object.assign(records["subscriptions.json"].subscriptions[0], f.request.source, { id: f.request.source.subscriptionId, publicKey: f.publicKey });
  for (const [name, value] of Object.entries(records)) writeFileSync(join(root, "subscriptions", name), JSON.stringify(value));
  const intents = new Map(), receipts = new Map();
  const journal = {
    async runExclusive(work) {
      return work({
        async load(id) { return intents.has(id) ? { intent: intents.get(id), receipt: receipts.get(id) ?? null } : undefined; },
        async persistIntent(id, value) { assert(!intents.has(id)); intents.set(id, value); },
        async commit(id, receipt) { receipts.set(id, receipt); },
      });
    },
  };
  const apply = new SubscriptionApplyHost(root, journal, {
    actorId: "fixture:reader", sourceIp: "192.0.2.10", subscriptionId: f.request.source.subscriptionId, capabilityId: f.request.source.capabilityId,
  });
  const preview = await apply.preview({ source: f.request.source, snapshot: f.plaintext.toString(), area: "notes", paths: ["Team/A.md"] });
  const selection = { area: "notes", paths: ["Team/A.md"], operationId: randomUUID(), expectedWorkspaceRevision: preview.workspaceRevision };
  const receipt = await f.host.applyOpenMarkdown(f.request, apply, selection);
  assert.equal(receipt.result.source.collectionHash, f.request.source.collectionHash);
  assert.equal(scanMarkdown(root)[0].raw, originalContent);
  assert.equal(scanMarkdown(root)[0].record.id, "source-original");
  for (const options of [{ mode: "fork" }, { encrypted: false, mode: "fork" }]) {
    const blocked = fixture(t, options);
    await assert.rejects(blocked.host.applyOpenMarkdown(blocked.request, apply, selection), { code: "NATIVE_ADAPTER_REQUIRED" });
    zeroed(blocked);
  }
  assert.equal(receipts.size, 1);
});
test("subscription bundle authenticates historical sources and the producer's actual original script bytes", async () => {
  const root = resolve(here, "..");
  const provenance = JSON.parse(readFileSync(join(root, "migration/subscription-bundle-provenance.json"), "utf8"));
  await authenticateContextSources([...provenance.files, ...provenance.sourceReferences]);
  const producer = provenance.native.find(file => file.file === "scripts/capture-subscription-bundle.mjs");
  assert(producer, "Original producer pin is required");
  const bytes = await readContextOriginal(producer.file, { sha256: producer.sha256 });
  assert.equal(hash(bytes).slice(7), producer.sha256);
});
test("capture and native SHA comparisons remain exact and have no secret fixtures", async () => {
  const { checkNativeRecords } = await import("../scripts/migration.mjs");
  const root = resolve(here, "..");
  const provenance = JSON.parse(readFileSync(join(root, "migration/subscription-bundle-provenance.json"), "utf8"));
  assert.equal(hash(readFileSync(join(root, provenance.captured))).slice(7), provenance.capturedSha256);
  assert.deepEqual(await checkNativeRecords(provenance.native), []);
  assert(!existsSync(join(root, "tests/subscription-bundle-private-key.pem")));
});
