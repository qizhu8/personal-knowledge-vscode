import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const dist = resolve(process.env.PKM_TEST_NEXT_DIST || "next-server/dist");
const { validateMembershipChange, validatePendingMembershipRetry, membershipRequestSha256 } =
  await import(pathToFileURL(resolve(dist, "legacy-subscription-membership-change.js")));
const hash = value => createHash("sha256").update(value).digest("hex");
const pin = (path, value) => {
  const bytes = Buffer.from(JSON.stringify(value));
  return { path, sha256: hash(bytes), size: bytes.length, bytes };
};
function fixture() {
  const { privateKey, publicKey: key } = generateKeyPairSync("ed25519");
  const publicKey = key.export({ type: "spki", format: "pem" }).toString(), nodeId = hash(publicKey), shareId = "share-a";
  const payload = { protocol: "pkmshare:v1", publisher: "remote", publisherUser: "other", publisherHost: "host",
    nodeId, publicKey, endpoint: "http://127.0.0.1", shareId, secretProtected: true, issuedAt: "test" };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const magicLink = `pkmshare:v1:${encoded}.${sign(null, Buffer.from(encoded), privateKey).toString("base64url")}`;
  const change = { action: "add", publisherNodeId: nodeId, shareId, magicLink, alias: "  shared  ",
    endpoint: "http://127.0.0.1:23002", secretSalt: "synthetic-salt-123" };
  const summary = { shareId, name: "Remote", revision: 1, collectionHash: `sha256:${"b".repeat(64)}`,
    updatedAt: "test", counts: { notes: 1 }, topics: [], tags: [], itemCount: 1, metadataOnly: true,
    secretProtected: true, secretSalt: change.secretSalt, snapshotBytes: 10 };
  const signature = sign(null, Buffer.from(JSON.stringify(summary)), privateKey).toString("base64url");
  const record = { id: "member", alias: "shared", priority: "normal", nodeId, publisher: "remote", publisherUser: "other",
    publisherHost: "host", endpoint: change.endpoint, shareId, publicKey, magicLink, revision: 1,
    collectionHash: summary.collectionHash, topics: [], tags: [], counts: { notes: 1 }, itemCount: 1,
    etag: '"synthetic"', status: "current", secretProtected: true, secretSalt: summary.secretSalt, brokerName: "Remote" };
  const metadata = { subscriptionId: record.id, nodeId, shareId, alias: record.alias, endpoint: record.endpoint,
    priority: "normal", revision: 1, collectionHash: summary.collectionHash };
  const prefix = `cache/${nodeId}/${shareId}`;
  const before = { state: { schema: 1, nodeId: "local", publicKey: "local-key", shares: [], subscriptions: [] },
    directories: ["subscriptions/cache"], files: [] };
  const after = { state: { ...before.state, subscriptions: [record] },
    directories: [...before.directories, `subscriptions/cache/${nodeId}`, `subscriptions/${prefix}`],
    files: [pin(`${prefix}/summary.json`, { ...summary, signature }), pin(`${prefix}/_subscription.json`, metadata),
      pin(`${prefix}/bundle.json`, { notes: [{ title: "test" }] })] };
  return { before, after, change };
}

test("a signed distinct-publisher add and exact remove preserve unrelated state", () => {
  const { before, after, change } = fixture();
  assert.doesNotThrow(() => validateMembershipChange(before, after, change));
  const withoutCache = structuredClone(before);
  withoutCache.directories = [];
  assert.doesNotThrow(() => validateMembershipChange(withoutCache, after, change));
  assert.doesNotThrow(() => validatePendingMembershipRetry(withoutCache, after, change));
  const remove = { action: "remove", publisherNodeId: change.publisherNodeId, shareId: change.shareId, subscriptionId: "member" };
  assert.doesNotThrow(() => validateMembershipChange(after, before, remove));
  assert.notEqual(membershipRequestSha256(change), membershipRequestSha256({ ...change, alias: "different" }));
  assert.throws(() => membershipRequestSha256({ ...change, secret: "not persisted" }), { code: "CONFLICT" });
});

test("membership changes reject forgery, foreign mutations, stale targets and incomplete caches", () => {
  const { before, after, change } = fixture();
  const denied = mutate => {
    const next = structuredClone(after);
    mutate(next);
    assert.throws(() => validateMembershipChange(before, next, change), { code: "CONFLICT" });
  };
  denied(value => { value.state.subscriptions[0].magicLink += "A"; });
  denied(value => { value.state.shares.push({ shareId: "other" }); });
  denied(value => { value.state.subscriptions[0].alias = "unapproved"; });
  denied(value => { value.files.pop(); });
  denied(value => { value.files[0].bytes = Buffer.from("{}"); });
  denied(value => { value.files.push(pin("cache/foreign/share/summary.json", {})); });
  assert.throws(() => validateMembershipChange(before, after, { ...change, magicLink: change.magicLink + "A" }), { code: "CONFLICT" });
  assert.throws(() => validateMembershipChange(after, before,
    { action: "remove", publisherNodeId: change.publisherNodeId, shareId: change.shareId, subscriptionId: "other" }),
  { code: "CONFLICT" });
});

test("explicit retry verifies the target and rejects unrelated profile or cache changes before network access", () => {
  const { before, after, change } = fixture();
  assert.doesNotThrow(() => validatePendingMembershipRetry(before, before, change));
  assert.doesNotThrow(() => validatePendingMembershipRetry(before, after, change));
  const altered = structuredClone(after);
  altered.state.subscriptions[0].endpoint = "http://127.0.0.1:23001";
  assert.throws(() => validatePendingMembershipRetry(before, altered, change), { code: "CONFLICT" });
  const unexpected = structuredClone(after);
  unexpected.state.subscriptions[0].foreignField = "unknown";
  assert.throws(() => validatePendingMembershipRetry(before, unexpected, change), { code: "CONFLICT" });
  const priority = structuredClone(after);
  priority.state.subscriptions[0].priority = "high";
  assert.throws(() => validatePendingMembershipRetry(before, priority, change), { code: "CONFLICT" });
  const prior = { id: "prior", nodeId: "prior-node", shareId: "prior-share" };
  const withPrior = structuredClone(before);
  withPrior.state.subscriptions.push(prior);
  const inserted = structuredClone(after);
  inserted.state.subscriptions.push(prior);
  assert.throws(() => validatePendingMembershipRetry(withPrior, inserted, change), { code: "CONFLICT" });
  const foreign = structuredClone(after);
  foreign.files.push(pin("cache/foreign/share/bundle.json", {}));
  assert.throws(() => validatePendingMembershipRetry(before, foreign, change), { code: "CONFLICT" });
  const remove = { action: "remove", publisherNodeId: change.publisherNodeId, shareId: change.shareId, subscriptionId: "member" };
  assert.doesNotThrow(() => validatePendingMembershipRetry(after, after, remove));
  assert.doesNotThrow(() => validatePendingMembershipRetry(after, before, remove));
  const partial = structuredClone(after);
  partial.files.pop();
  assert.throws(() => validatePendingMembershipRetry(after, partial, remove), { code: "CONFLICT" });
});
