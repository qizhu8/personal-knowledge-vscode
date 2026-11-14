import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SubscriptionBundleHost } from "../dist/subscription-bundle.js";
import {
  SubscriptionBundleApplyHost, deserializeSubscriptionBundleApplyPlan, serializeSubscriptionBundleApplyPlan,
} from "../dist/subscription-bundle-apply.js";
import { bundleApplyStage } from "../dist/subscription-bundle-apply-files.js";
import { deriveSecretKeys, encryptSnapshot, hash, forkPackage } from "../dist/domain/subscription-bundle-original.js";
import { scanMarkdown } from "../dist/markdown.js";
import { subscriptionReadSourceFiles } from "./subscription-reads-fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const markdown = "---\r\ndocumentId: original-id\r\nknowledgeId: knowledge_0123456789abcdef01234567\r\naliases: [note:historical]\r\n---\r\n# Original\r\n![asset](A.assets/image.bin)\r\n";
const image = Buffer.from([0, 255, 13, 10]);
function durable(path, bytes) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const dir = openSync(dirname(path), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
function fixture(t) {
  const root = resolve(here, `subscription-bundle-apply-work-${randomUUID()}`);
  mkdirSync(root, { mode: 0o700 });
  for (const area of ["notes", "subscriptions", "global-journal", "codec-stage"]) mkdirSync(join(root, area), { mode: 0o700 });
  writeFileSync(join(root, ".pkm-next-workspace"), JSON.stringify({ schema: "pkm.next-workspace/v2" }));
  for (const [file, content] of Object.entries(subscriptionReadSourceFiles)) writeFileSync(join(root, "subscriptions", file), JSON.stringify(content));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pair = generateKeyPairSync("ed25519"), publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const secret = randomBytes(32).toString("base64url"), salt = randomBytes(16).toString("base64url"), keys = deriveSecretKeys(secret, salt);
  const transferKey = randomBytes(32);
  const bundle = {
    version: "3", from: "Synthetic", created_at: "",
    notes: [{ slug: "Team/A", content: markdown }, { slug: "Team/B", content: "# Implicit original\n" }],
    packages: [{ name: "Example", files: [{ path: "README.md", content: "# Example\n" }, { path: "src/index.js", content: "export const value = 1;\n" }] }],
    assets: [{ type: "notes", path: "Team/A.assets/image.bin", data: image.toString("base64"), digest: hash(image) }],
  };
  const plaintext = Buffer.from(JSON.stringify(bundle)), snapshot = encryptSnapshot(plaintext, keys.contentKey), iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", transferKey, iv);
  const wire = Buffer.concat([Buffer.from("PKMENC1\n"), iv, cipher.update(snapshot), cipher.final(), cipher.getAuthTag()]);
  const source = {
    subscriptionId: "fixture-sub", nodeId: hash(publicKey).slice(7), shareId: "fixture-share", capabilityId: "fixture-local-copy",
    brokerName: "Fixture broker", publisherUser: "fixture-user", publisherHost: "fixture-host", revision: 1, collectionHash: hash(snapshot),
  };
  const unsigned = {
    shareId: source.shareId, name: source.brokerName, revision: 1, collectionHash: source.collectionHash,
    updatedAt: "2026-11-07T00:00:00.000Z", counts: { notes: 2, packages: 1 }, topics: [], tags: [], itemCount: 3,
    metadataOnly: true, secretProtected: true, secretSalt: salt, snapshotBytes: snapshot.length,
  };
  const request = { source, mode: "fork", summary: { ...unsigned, signature: sign(null, Buffer.from(JSON.stringify(unsigned)), pair.privateKey).toString("base64url") }, wire };
  const pin = { publisherPublicKey: publicKey, keyEpoch: "native-key-1", policyRevision: "native-acl-1" };
  const state = { allowed: true, keyEpoch: pin.keyEpoch, policyRevision: pin.policyRevision, commits: 0, nativeCalls: 0, leases: [] };
  const codec = new SubscriptionBundleHost({
    async authorize(sourcePin) {
      if (!state.allowed || JSON.stringify(sourcePin) !== JSON.stringify(source)) throw new Error(secret);
      return { ...pin, keyEpoch: state.keyEpoch, policyRevision: state.policyRevision };
    },
    async resolveKeys() {
      const lease = { epoch: state.keyEpoch, transferKey: Buffer.from(transferKey), contentKey: Buffer.from(keys.contentKey), async release() {} };
      state.leases.push(lease); return lease;
    },
  });
  // Synthetic trusted native grant: source/ciphertext/plaintext triple set outside public operations.
  // A real integrator maps this lookup to its authenticated subscription/source/secret-policy state.
  const nativePolicy = {
    async authorize(binding) {
      state.nativeCalls++;
      if (state.onAuthorize) await state.onAuthorize(binding);
      if (!state.allowed || binding.actorId !== "fixture:reader" || JSON.stringify(binding.source) !== JSON.stringify(source)
        || binding.ciphertextSha256 !== hash(snapshot) || binding.plaintextSha256 !== hash(plaintext)) throw new Error(secret);
      return { ...pin, keyEpoch: state.keyEpoch, policyRevision: state.policyRevision };
    },
  };
  const journalRoot = join(root, "global-journal");
  const journal = {
    async runExclusive(work) {
      const fd = openSync(join(journalRoot, "writer.lock"), "wx", 0o600);
      try {
        return await work({
          async load(id) {
            const intent = join(journalRoot, `${id}.intent`), receipt = join(journalRoot, `${id}.receipt`);
            return existsSync(intent) ? { intent: readFileSync(intent, "utf8"), receipt: existsSync(receipt) ? JSON.parse(readFileSync(receipt, "utf8")) : null } : undefined;
          },
          async persistIntent(id, serialized) { durable(join(journalRoot, `${id}.intent`), serialized); },
          async commit(id, digest, receipt) {
            assert.equal(deserializeSubscriptionBundleApplyPlan(readFileSync(join(journalRoot, `${id}.intent`), "utf8")).planSha256, digest);
            durable(join(journalRoot, `${id}.receipt`), JSON.stringify(receipt)); state.commits++;
          },
        });
      } finally { closeSync(fd); rmSync(join(journalRoot, "writer.lock")); }
    },
  };
  const makeHost = (policy = nativePolicy) => new SubscriptionBundleApplyHost(root, journal, policy, "fixture:reader");
  t.after(() => { keys.authVerifier.fill(0); keys.contentKey.fill(0); transferKey.fill(0); });
  return {
    root, request, bundle, plaintext, snapshot, state, secret, pin, nativePolicy, makeHost, host: makeHost(), codec,
    stage: join(root, "codec-stage"), journalRoot,
    intent(id) { return join(journalRoot, `${id}.intent`); },
    receipt(id) { return join(journalRoot, `${id}.receipt`); },
  };
}
async function run(f, id = randomUUID(), boundary = () => {}) {
  return f.host.apply(f.codec, f.request, f.stage, id, new AbortController().signal, boundary);
}
function zeroed(f) {
  for (const lease of f.state.leases) assert(lease.transferKey.every(v => v === 0) && lease.contentKey.every(v => v === 0));
}
test("original encrypted bundle -> actual global journal MD/assets/packages apply preserves separate pins, bytes, identities and original package provenance", async t => {
  const f = fixture(t), id = randomUUID(), receipt = await run(f, id);
  assert.equal(receipt.source.collectionHash, hash(f.snapshot));
  assert.equal(receipt.ciphertextSha256, hash(f.snapshot)); assert.equal(receipt.plaintextSha256, hash(f.plaintext));
  assert.notEqual(receipt.ciphertextSha256, receipt.plaintextSha256);
  for (const file of receipt.files) assert.equal(hash(readFileSync(join(f.root, file.path))), file.sha256);
  const docs = scanMarkdown(f.root);
  assert.equal(docs.length, 2); assert.equal(docs.find(d => d.record.id === "original-id").raw, markdown);
  assert.equal(receipt.identities.find(i => i.documentId === "original-id").knowledgeId, "knowledge_0123456789abcdef01234567");
  assert(receipt.identities.find(i => i.documentId === "original-id").aliases.includes("note:historical"));
  assert.deepEqual(readFileSync(join(f.root, receipt.files.find(v => v.path.endsWith("image.bin")).path)), image);
  const packageIdentity = receipt.identities.find(i => i.area === "packages");
  assert.equal(packageIdentity.path, "Example_Fixture_broker"); assert.equal(packageIdentity.packageName, "Example");
  const originalRoot = join(f.root, "original-fixture"); mkdirSync(originalRoot);
  const target = forkPackage(originalRoot, { package: f.bundle.packages[0], ...f.request.source });
  assert.deepEqual(readFileSync(join(originalRoot, target, ".pkm-package.json")), readFileSync(join(f.root, "packages", packageIdentity.path, ".pkm-package.json")));
  assert.deepEqual(await f.makeHost().recover(id), receipt);
  assert.deepEqual(await run(f, id), receipt); assert.equal(f.state.commits, 1);
  assert.deepEqual(readdirSync(f.stage), []);
  const serialized = readFileSync(f.intent(id), "utf8");
  assert.equal(serializeSubscriptionBundleApplyPlan(deserializeSubscriptionBundleApplyPlan(serialized)), serialized);
  for (const bytes of [serialized, JSON.stringify(receipt)]) {
    assert(!bytes.includes(f.secret)); assert(!bytes.includes("transferKey")); assert(!bytes.includes("contentKey")); assert(!bytes.includes("secretSalt"));
  }
  assert(!JSON.stringify(receipt).includes("keyEpoch")); zeroed(f);
});
test("every observable mkdir/stage/fsync/publish/unlink/commit interruption recovers exact ordered before/after states with one receipt", async t => {
  const reference = fixture(t), events = [], expected = await run(reference, randomUUID(), event => events.push(event));
  assert(events.includes("intent") && events.includes("publish:0") && events.includes("before-commit") && events.includes("commit"));
  for (let stop = 0; stop < events.length; stop++) {
    const f = fixture(t), id = randomUUID(); let seen = 0;
    await assert.rejects(run(f, id, () => { if (seen++ === stop) throw new Error("synthetic interruption"); }), { code: "NATIVE_ADAPTER_FAILED" });
    const result = await f.makeHost().recover(id);
    assert.deepEqual(result.identities, expected.identities, `boundary ${stop}:${events[stop]}`);
    assert.deepEqual(result.files, expected.files);
    assert.deepEqual(await f.makeHost().recover(id), result);
    assert.equal(f.state.commits, 1); assert.deepEqual(readdirSync(f.stage), []);
    zeroed(f);
  }
});
test("revoked ACL, stale secret epoch, changed policy and cancelled recovery never replay or bypass through prior receipt", async t => {
  for (const committed of [false, true]) for (const change of [
    s => { s.allowed = false; }, s => { s.keyEpoch = "native-key-2"; }, s => { s.policyRevision = "native-acl-2"; },
  ]) {
    const f = fixture(t), id = randomUUID();
    if (committed) await run(f, id);
    else await assert.rejects(run(f, id, event => { if (event === "intent") throw new Error("stop"); }));
    const before = readdirSync(join(f.root, "notes")); change(f.state);
    await assert.rejects(f.makeHost().recover(id));
    assert.deepEqual(readdirSync(join(f.root, "notes")), before); assert.equal(f.state.commits, committed ? 1 : 0);
  }
  const f = fixture(t), id = randomUUID();
  await assert.rejects(run(f, id, event => { if (event === "publish:0") throw new Error("stop"); }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.host.recover(id, controller.signal), { code: "CANCELLED" }); assert.equal(f.state.commits, 0);
});
test("native revocation during publish fencing prevents commit and restart remains fenced", async t => {
  const f = fixture(t), id = randomUUID();
  await assert.rejects(run(f, id, event => { if (event === "publish:0") f.state.allowed = false; }));
  assert.equal(f.state.commits, 0);
  await assert.rejects(f.host.recover(id), { code: "ACCESS_DENIED" });
  f.state.allowed = true;
  const result = await f.makeHost().recover(id); assert.equal(result.files.length, 6); assert.equal(f.state.commits, 1);
});
test("unknown bytes/stages/hardlinks/out-of-order destinations/baseline changes are reconciliation-only", async t => {
  for (const mutate of [
    (f, plan) => { mkdirSync(dirname(join(f.root, plan.changes[0].path)), { recursive: true }); writeFileSync(join(f.root, plan.changes[0].path), "unknown"); },
    (f, plan) => { const stage = join(f.root, bundleApplyStage(plan, 0)); mkdirSync(dirname(stage), { recursive: true }); writeFileSync(stage, "unknown"); },
    (f, plan) => { const path = join(f.root, plan.changes[1].path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, Buffer.from(plan.changes[1].afterBase64, "base64")); },
    f => { writeFileSync(join(f.root, "notes", "unrelated.md"), "# mutation"); },
    (f, plan) => {
      const path = join(f.root, plan.changes[0].path); mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(plan.changes[0].afterBase64, "base64")); linkSync(path, join(f.root, "unknown-hardlink"));
    },
    (f, plan) => {
      const path = join(f.root, plan.changes[0].path); mkdirSync(dirname(path), { recursive: true }); symlinkSync(join(f.root, "notes"), path);
    },
  ]) {
    const f = fixture(t), id = randomUUID();
    await assert.rejects(run(f, id, event => { if (event === "intent") throw new Error("stop"); }));
    const plan = deserializeSubscriptionBundleApplyPlan(readFileSync(f.intent(id), "utf8")); mutate(f, plan);
    await assert.rejects(f.host.recover(id), error => ["RECOVERY_CONFLICT", "UNSAFE_PATH"].includes(error.code)); assert.equal(f.state.commits, 0);
  }
});
test("strict canonical semantic plans reject forged hashes, paths, source identities and unknown fields; public pins never grant policy", async t => {
  const f = fixture(t), id = randomUUID();
  await assert.rejects(run(f, id, event => { if (event === "intent") throw new Error("stop"); }));
  const canonical = readFileSync(f.intent(id), "utf8"), plan = deserializeSubscriptionBundleApplyPlan(canonical);
  for (const mutate of [
    p => { p.extra = true; },
    p => { p.changes[0].path = "packages/../../outside"; },
    p => { p.changes[0].afterBase64 = Buffer.from("forged").toString("base64"); p.changes[0].afterSha256 = hash("forged"); },
    p => { p.identities[0].packageName = "forged"; },
    p => { p.ciphertextSha256 = p.plaintextSha256; },
  ]) {
    const altered = structuredClone(plan); mutate(altered);
    const { planSha256: _old, ...body } = altered; altered.planSha256 = hash(JSON.stringify(body));
    assert.throws(() => deserializeSubscriptionBundleApplyPlan(JSON.stringify(altered)), { code: "RECOVERY_CONFLICT" });
  }
  assert.throws(() => deserializeSubscriptionBundleApplyPlan(JSON.stringify(plan, null, 2)), { code: "RECOVERY_CONFLICT" });
  const denied = f.makeHost({ async authorize() { throw new Error(f.secret); } });
  await assert.rejects(denied.recover(id), { code: "ACCESS_DENIED" }); assert.equal(f.state.commits, 0);
  const forged = structuredClone(plan); forged.source.publisherHost = "forged-host";
  // Even a journal plan with matching recomputed digests cannot obtain a native authenticated grant.
  const { planSha256: _hash, ...body } = forged; forged.planSha256 = hash(JSON.stringify(body));
  assert.throws(() => deserializeSubscriptionBundleApplyPlan(JSON.stringify(forged)));
});
test("existing document identity collisions deny before intent; original package suffix rules preserve existing package", async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "notes", "existing.md"), "---\ndocumentId: original-id\n---\n# Existing\n");
  const id = randomUUID(); await assert.rejects(run(f, id)); assert(!existsSync(f.intent(id)));
  rmSync(join(f.root, "notes", "existing.md"));
  mkdirSync(join(f.root, "packages", "Example_Fixture_broker"), { recursive: true });
  writeFileSync(join(f.root, "packages", "Example_Fixture_broker", "keep.txt"), "existing package");
  const result = await run(f);
  assert.equal(result.identities.find(i => i.area === "packages").path, "Example_Fixture_broker1");
  assert.equal(readFileSync(join(f.root, "packages", "Example_Fixture_broker", "keep.txt"), "utf8"), "existing package");
});
test("filesystem mutation across the final native authorization fence cannot commit a stale baseline", async t => {
  const f = fixture(t), id = randomUUID();
  await assert.rejects(run(f, id, event => {
    if (event === "before-commit") {
      f.state.onAuthorize = () => { writeFileSync(join(f.root, "notes", "unexpected.md"), "# unexpected"); };
    }
  }), { code: "NATIVE_ADAPTER_FAILED" });
  assert.equal(f.state.commits, 0);
  f.state.onAuthorize = undefined;
  await assert.rejects(f.makeHost().recover(id), { code: "RECOVERY_CONFLICT" });
});
test("forged native conversion object cannot grant ciphertext/plaintext binding or secret authority", async t => {
  const f = fixture(t), id = randomUUID(), snapshot = JSON.stringify({ version: "3", notes: [{ slug: "Forged", content: "# Forged" }] });
  const fakeCodec = {
    async consume(_request, _stage, adapter, signal) {
      return adapter.consume({
        source: f.request.source, mode: "fork", encrypted: true, snapshot, plaintextSha256: hash(snapshot), files: [],
      }, f.stage, signal, f.pin);
    },
  };
  await assert.rejects(f.host.apply(fakeCodec, f.request, f.stage, id), { code: "ACCESS_DENIED" });
  assert(!existsSync(f.intent(id))); assert.deepEqual(readdirSync(join(f.root, "notes")), []);
});
test("native intent pin metadata never appears in receipts and tampered committed receipt is not a replay grant", async t => {
  const f = fixture(t), id = randomUUID(), result = await run(f, id);
  const tampered = structuredClone(result); tampered.plaintextSha256 = tampered.ciphertextSha256;
  writeFileSync(f.receipt(id), JSON.stringify(tampered));
  await assert.rejects(f.host.recover(id), { code: "RECOVERY_CONFLICT" });
  assert.equal(f.state.commits, 1);
});
