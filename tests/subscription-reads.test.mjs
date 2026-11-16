import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, symlink, link, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { readSubscriptions, SUBSCRIPTION_READ_LIMITS } from "../dist/subscription-reads.js";
import { subscriptionReadDefinitions } from "../dist/subscription-reads-contracts.js";
import { BrokerAcl } from "../dist/domain/subscription-reads-acl.js";
import { normalizeClientIp, ipMatchesBlockRule } from "../dist/domain/subscription-reads-ip-policy.js";
import { subscriptionPriority } from "../dist/domain/subscription-reads-record.js";
import { checkCaptureRecords, packageRoot } from "../scripts/migration.mjs";
import {
  installSubscriptionReadTransportFixtures, subscriptionReadTransportFixtures,
} from "./subscription-reads-fixtures.mjs";

const fixtures = resolve(packageRoot, "tests", `.subscription-reads-${randomUUID()}`);
let sequence = 0;
const sample = (id = "sub-1", extra = {}) => ({
  id, alias: `Alias ${id}`, nodeId: "remote-node", publisher: "Publisher",
  publisherUser: "publisher-user", publisherHost: "publisher-host",
  endpoint: "https://private-host:1234?token=DO-NOT-EXPOSE", shareId: "share-1",
  publicKey: "PRIVATE-PROVIDER-KEY", magicLink: "pkm://secret/DO-NOT-EXPOSE",
  revision: 3, collectionHash: "sha256:abc", topics: ["topic"], tags: ["tag"],
  counts: { notes: 2 }, itemCount: 2, etag: "private-etag", status: "current",
  ...extra,
});
const sampleShare = (extra = {}) => ({
  shareId: "share-1", summary: { shareId: "share-1" }, ...extra,
});
const state = (extra = {}) => ({
  schema: 1, nodeId: "local-node", privateKey: "DO-NOT-EXPOSE-PRIVATE-KEY",
  shares: [sampleShare()], subscriptions: [sample()], ...extra,
});
const request = (operation, args = {}, actorId = "account-a") => ({ operation, args, actorId });
const call = (root, operation, args = {}, actorId = "account-a") =>
  readSubscriptions(root, request(operation, args, actorId));
async function fixture(t, data = state()) {
  const root = join(fixtures, String(++sequence));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, ".pkm-next-workspace"), JSON.stringify({ schema: "pkm.next-workspace/v2", id: "fixture" }));
  if (data !== undefined && data !== null) {
    await mkdir(join(root, "subscriptions"));
    await writeState(root, data);
  }
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function writeState(root, value) {
  await writeFile(join(root, "subscriptions", "subscriptions.json"), JSON.stringify(value));
}
async function stats(root, value) {
  await writeFile(join(root, "subscriptions", "subscriber-stats.json"), JSON.stringify(value));
}
const deny = code => error => error.code === code && !error.message.includes("DO-NOT-EXPOSE");
test.after(() => rm(fixtures, { recursive: true, force: true }));

test("schema-only canonical read definitions reject caller authority and expose bounded pages", () => {
  assert.deepEqual(subscriptionReadDefinitions.map(item => [item.id, item.readOnly]), [
    ["subscription.list", true], ["subscription.get", true], ["subscription.acl.evaluate", true],
    ["subscription.identity.get", true],
  ]);
  for (const item of subscriptionReadDefinitions) assert.ok(item.description);
  assert.equal(subscriptionReadDefinitions[0].input.safeParse({ limit: 101 }).success, false);
  assert.equal(subscriptionReadDefinitions[0].input.safeParse({ offset: -1 }).success, false);
  assert.equal(subscriptionReadDefinitions[2].input.safeParse({
    shareId: "share-1", action: "download", sourceIp: "10.0.0.1", accountId: "owner",
  }).success, false);
  assert.equal(subscriptionReadDefinitions[3].input.safeParse({ secretRef: "caller-reference", actorId: "owner" }).success, false);
});

test("absent optional original directories return empty without creating files", async t => {
  const root = await fixture(t, null);
  const before = await readdir(root);
  const result = await call(root, "subscription.list");
  assert.deepEqual(result, { revision: result.revision, total: 0, items: [], nextOffset: null });
  assert.match(result.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(await readdir(root), before);
  await assert.rejects(call(root, "subscription.get", { id: "missing" }), deny("NOT_FOUND"));
  await assert.rejects(call(root, "subscription.acl.evaluate", {
    shareId: "share-1", sourceIp: "10.0.0.1", action: "download",
  }), deny("NOT_AVAILABLE"));
});

test("only explicit marked isolated workspaces can be read", async t => {
  const root = await fixture(t);
  await rm(join(root, ".pkm-next-workspace"));
  await assert.rejects(call(root, "subscription.list"), deny("INVALID_WORKSPACE"));
});

test("metadata projection redacts credentials, provider payload and non-metadata errors", async t => {
  const root = await fixture(t, state({
    subscriptions: [sample("sub-1", {
      priority: "HIGHEST", brokerName: "Broker",
      secretSalt: "DO-NOT-EXPOSE-SALT", error: "DO-NOT-EXPOSE-TOKEN",
      source: {
        type: "github", repository: "private/repo", branch: "secret-branch", commit: "secret-commit",
        credentialTargetId: "DO-NOT-EXPOSE-CREDENTIAL", providerPayload: "DO-NOT-EXPOSE-PAYLOAD",
      },
    })],
  }));
  const result = await call(root, "subscription.get", { id: "sub-1" });
  assert.equal(result.subscription.priority, "highest");
  assert.equal(result.subscription.brokerName, "Broker");
  const serialized = JSON.stringify(result);
  for (const value of ["DO-NOT-EXPOSE", "private/repo", "private-host", "publicKey", "magicLink", "secretSalt", "source", "error", "etag"]) {
    assert.ok(!serialized.includes(value), value);
  }
  assert.equal(subscriptionReadDefinitions[1].output.safeParse(result).success, true);
});

test("original priority normalization and cached broker-name fallback are retained", async t => {
  assert.equal(subscriptionPriority(undefined), "normal");
  assert.equal(subscriptionPriority(" HIGH "), "high");
  assert.equal(subscriptionPriority("unsupported"), "normal");
  assert.throws(() => subscriptionPriority("unsupported", true), /priority/);
  const root = await fixture(t, state({
    subscriptions: [sample("sub-1", { priority: "unsupported" }), sample("sub-2", { priority: "HIGH" })],
  }));
  const cache = join(root, "subscriptions", "cache", "remote-node", "share-1");
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, "summary.json"), JSON.stringify({ name: "  Cached Broker  ", privatePayload: "DO-NOT-EXPOSE" }));
  const result = await call(root, "subscription.list");
  assert.deepEqual(result.items.map(item => [item.id, item.priority, item.brokerName]), [
    ["sub-1", "normal", "Cached Broker"], ["sub-2", "high", "Cached Broker"],
  ]);
});

test("original persisted order, pinned pagination, get and stable revision", async t => {
  const root = await fixture(t, state({ subscriptions: [sample("z"), sample("a"), sample("m")] }));
  const first = await call(root, "subscription.list", { limit: 1 });
  assert.equal(first.items[0].id, "z");
  assert.equal(first.nextOffset, 1);
  const second = await call(root, "subscription.list", { limit: 2, offset: 1, expectedRevision: first.revision });
  assert.deepEqual(second.items.map(item => item.id), ["a", "m"]);
  assert.equal(second.nextOffset, null);
  assert.equal(second.revision, first.revision);
  const detail = await call(root, "subscription.get", { id: "a", expectedRevision: first.revision });
  assert.deepEqual(detail.subscription, second.items[0]);
  const beyond = await call(root, "subscription.list", { offset: 99 });
  assert.deepEqual(beyond.items, []);
  assert.equal(beyond.nextOffset, null);
  await writeState(root, state({ subscriptions: [sample("z", { alias: "changed" }), sample("a"), sample("m")] }));
  await assert.rejects(call(root, "subscription.list", { offset: 1, expectedRevision: first.revision }), deny("REVISION_CONFLICT"));
});

test("ACL: original defaults, trusted actorId, action/resource default deny and no owner bypass", async t => {
  const root = await fixture(t);
  const args = { shareId: "share-1", action: "download", sourceIp: "::ffff:10.2.3.4" };
  const open = await call(root, "subscription.acl.evaluate", args, "local-node");
  assert.equal(open.allowed, true);
  assert.equal(open.actorId, "local-node");
  assert.equal(open.sourceIp, "10.2.3.4");
  assert.equal(open.evaluationOnly, true);
  assert.deepEqual(open.policy, {
    shareId: "share-1", accountMode: "open", accountRules: [], networkMode: "block-list", ipRules: [], automaticBlocks: [],
  });
  const unknown = await call(root, "subscription.acl.evaluate", { ...args, action: "unknown-action" });
  assert.equal(unknown.allowed, false);
  await assert.rejects(call(root, "subscription.acl.evaluate", { ...args, shareId: "unknown" }), deny("NOT_FOUND"));
  await writeState(root, state({
    shares: [sampleShare({ accountMode: "block-list", accountRules: ["local-node"] })],
  }));
  assert.equal((await call(root, "subscription.acl.evaluate", args, "local-node")).allowed, false);
  for (const injected of [{ role: "owner" }, { actorId: "local-node" }, { accountId: "local-node" }, { policy: {} }]) {
    await assert.rejects(call(root, "subscription.acl.evaluate", { ...args, ...injected }), deny("INVALID_INPUT"));
  }
  await assert.rejects(call(root, "subscription.list", {}, ""), deny("FORBIDDEN"));
});

test("ACL: account/network white-lists intersect; block-lists and automatic blocks deny override", async t => {
  const args = { shareId: "share-1", action: "request-sync", sourceIp: "10.2.3.4" };
  const root = await fixture(t, state({
    shares: [sampleShare({ accountMode: "white-list", accountRules: ["account-a"], accessMode: "white-list", ipRules: ["10.2.0.0/16"] })],
  }));
  assert.equal((await call(root, "subscription.acl.evaluate", args)).allowed, true);
  assert.equal((await call(root, "subscription.acl.evaluate", args, "account-b")).allowed, false);
  assert.equal((await call(root, "subscription.acl.evaluate", { ...args, sourceIp: "10.3.3.4" })).allowed, false);
  const before = await call(root, "subscription.acl.evaluate", args);
  await stats(root, {
    schema: 1,
    automaticBlocks: { "share-1": {
      "10.2.3.4": { ip: "10.2.3.4", reason: "three-secret-failures", failedAttempts: 3, blockedAt: "2026-01-01" },
    } },
  });
  assert.equal((await call(root, "subscription.acl.evaluate", args)).allowed, false);
  await assert.rejects(call(root, "subscription.acl.evaluate", { ...args, expectedRevision: before.revision }), deny("REVISION_CONFLICT"));
  await rm(join(root, "subscriptions", "subscriber-stats.json"));
  await writeState(root, state({ shares: [sampleShare({ accountMode: "white-list", accountRules: [] })] }));
  assert.equal((await call(root, "subscription.acl.evaluate", args)).allowed, false);
  await writeState(root, state({ shares: [sampleShare({ accessMode: "white-list", ipRules: [] })] }));
  assert.equal((await call(root, "subscription.acl.evaluate", args)).allowed, false);
  await writeState(root, state({ shares: [sampleShare({ blockedIps: ["10.*.*.*"] })] }));
  assert.equal((await call(root, "subscription.acl.evaluate", args)).allowed, false);
});

test("ACL: exact wildcard account semantics, IPv6 normalization, unknown resource and anonymous fallback", async () => {
  const policy = { shareId: "s", accountMode: "white-list", accountRules: ["*"], networkMode: "block-list", ipRules: [], automaticBlocks: [] };
  const acl = await BrokerAcl.create(policy);
  assert.equal(await acl.enforce({ shareId: "s", action: "read-metadata", sourceIp: "unknown" }), true);
  assert.equal(await acl.enforce({ shareId: "other", action: "read-metadata", sourceIp: "unknown" }), false);
  const anonymous = await BrokerAcl.create({ ...policy, accountRules: ["anonymous"] });
  assert.equal(await anonymous.enforce({ shareId: "s", action: "discover", sourceIp: "unknown" }), true);
  assert.equal(normalizeClientIp("[fe80::1%eth0]"), "fe80:0:0:0:0:0:0:1");
  assert.equal(ipMatchesBlockRule("::ffff:10.2.3.4", "10.2.0.0/16"), true);
  assert.equal(ipMatchesBlockRule("2001:db8::1", "2001:db8::/32"), true);
  assert.equal(ipMatchesBlockRule("invalid", "invalid"), false);
  assert.equal(ipMatchesBlockRule("10.2.3.4", "999.*.*.*"), false);
  assert.equal(ipMatchesBlockRule("10.2.3.4", "10.2.3.4/32"), true);
});

test("ACL rechecks source files and missing statistics after asynchronous policy evaluation", { concurrency: false }, async t => {
  const args = { shareId: "share-1", action: "download", sourceIp: "192.0.2.1" };
  const originalCreate = BrokerAcl.create;
  t.after(() => { BrokerAcl.create = originalCreate; });
  for (const change of ["state", "statistics"]) {
    const root = await fixture(t);
    BrokerAcl.create = async policy => {
      const acl = await originalCreate.call(BrokerAcl, policy);
      return {
        async enforce(input) {
          const result = await acl.enforce(input);
          if (change === "state") {
            writeFileSync(join(root, "subscriptions", "subscriptions.json"), JSON.stringify(
              state({ shares: [sampleShare({ accountMode: "white-list", accountRules: [] })] }),
            ));
          } else {
            writeFileSync(join(root, "subscriptions", "subscriber-stats.json"), '{"schema":1,"automaticBlocks":{}}');
          }
          return result;
        },
      };
    };
    await assert.rejects(call(root, "subscription.acl.evaluate", args), deny("REVISION_CONFLICT"));
  }
});

test("unpublished shares are not selectable and cached broker names pin revisions", async t => {
  const root = await fixture(t, state({ shares: [sampleShare({ published: false })] }));
  await assert.rejects(call(root, "subscription.acl.evaluate", {
    shareId: "share-1", action: "download", sourceIp: "127.0.0.1",
  }), deny("NOT_FOUND"));
  const first = await call(root, "subscription.list");
  const cache = join(root, "subscriptions", "cache", "remote-node", "share-1");
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, "summary.json"), '{"name":"new broker name"}');
  await assert.rejects(call(root, "subscription.list", { expectedRevision: first.revision }), deny("REVISION_CONFLICT"));
});

test("malformed records, duplicate ids, bad policy schemas and orphan stats fail explicitly", async t => {
  const cases = [
    { schema: 2, shares: [], subscriptions: [] },
    state({ subscriptions: [sample("a"), { id: "broken" }] }),
    state({ subscriptions: [sample("a"), sample("a")] }),
    state({ shares: [sampleShare(), sampleShare()] }),
    state({ shares: [sampleShare({ accountMode: "owner" })] }),
    state({ shares: [sampleShare({ ipRules: "10.*.*.*" })] }),
    state({ subscriptions: [sample("a", { nodeId: "../outside" })] }),
    state({ subscriptions: [sample("a", { counts: { notes: -1 } })] }),
    state({ subscriptions: [sample("a", { status: "invented" })] }),
  ];
  for (const value of cases) {
    const root = await fixture(t, value);
    await assert.rejects(call(root, "subscription.list"), deny("INVALID_DATA"));
  }
  const root = await fixture(t, null);
  await mkdir(join(root, "subscriptions"));
  await stats(root, { schema: 1 });
  await assert.rejects(call(root, "subscription.list"), deny("INVALID_DATA"));
});

test("invalid UTF-8/JSON, malformed caches and stats are errors, never silently skipped", async t => {
  const root = await fixture(t);
  for (const value of [Buffer.from([0xff, 0xfe]), Buffer.from("{bad")]) {
    await writeFile(join(root, "subscriptions", "subscriptions.json"), value);
    await assert.rejects(call(root, "subscription.list"), deny("INVALID_DATA"));
  }
  await writeState(root, state());
  const cache = join(root, "subscriptions", "cache", "remote-node", "share-1");
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, "summary.json"), '{"name":3}');
  await assert.rejects(call(root, "subscription.list"), deny("INVALID_DATA"));
  await rm(join(root, "subscriptions", "cache"), { recursive: true });
  await stats(root, { schema: 1, automaticBlocks: { "share-1": { "10.0.0.1": "bad" } } });
  await assert.rejects(call(root, "subscription.list"), deny("INVALID_DATA"));
});

test("file, record, cache-file and policy expansion limits are bounded", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "subscriptions", "subscriptions.json"), " ".repeat(SUBSCRIPTION_READ_LIMITS.fileBytes + 1));
  await assert.rejects(call(root, "subscription.list"), deny("LIMIT_EXCEEDED"));
  await writeState(root, state({
    subscriptions: Array.from({ length: SUBSCRIPTION_READ_LIMITS.records + 1 }, (_, index) => sample(String(index))),
  }));
  await assert.rejects(call(root, "subscription.list"), error => ["INVALID_DATA", "LIMIT_EXCEEDED"].includes(error.code));
  await writeState(root, state({
    shares: [sampleShare({
      accountMode: "white-list", accountRules: Array.from({ length: 64 }, (_, index) => `account-${index}`),
      accessMode: "white-list", ipRules: Array.from({ length: 64 }, (_, index) => `10.0.0.${index}`),
    })],
  }));
  await assert.rejects(call(root, "subscription.acl.evaluate", {
    shareId: "share-1", action: "download", sourceIp: "10.0.0.1",
  }), deny("LIMIT_EXCEEDED"));
  await writeState(root, state({
    subscriptions: Array.from({ length: SUBSCRIPTION_READ_LIMITS.files }, (_, index) =>
      sample(String(index), { nodeId: `node-${index}` })),
  }));
  await assert.rejects(call(root, "subscription.list"), deny("LIMIT_EXCEEDED"));
});

test("aggregate snapshot byte limit applies across individually bounded cached summaries", async t => {
  const records = Array.from({ length: 5 }, (_, index) => sample(String(index), { nodeId: `node-${index}` }));
  const root = await fixture(t, state({ subscriptions: records }));
  for (const item of records) {
    const cache = join(root, "subscriptions", "cache", item.nodeId, item.shareId);
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "summary.json"), JSON.stringify({
      name: "Broker", ignoredPrivatePayload: "x".repeat(1_800_000),
    }));
  }
  await assert.rejects(call(root, "subscription.list"), deny("LIMIT_EXCEEDED"));
});

test("directory/file/root/cache symlinks and hardlinks cannot escape the isolated snapshot", async t => {
  const root = await fixture(t);
  const elsewhere = await fixture(t);
  await rm(join(root, "subscriptions"), { recursive: true });
  await symlink(join(elsewhere, "subscriptions"), join(root, "subscriptions"), "dir");
  await assert.rejects(call(root, "subscription.list"), deny("INVALID_DATA"));
  await rm(join(root, "subscriptions"));
  await mkdir(join(root, "subscriptions"));
  await symlink(join(elsewhere, "subscriptions", "subscriptions.json"), join(root, "subscriptions", "subscriptions.json"));
  await assert.rejects(call(root, "subscription.list"), deny("INVALID_DATA"));
  await rm(join(root, "subscriptions", "subscriptions.json"));
  await link(join(elsewhere, "subscriptions", "subscriptions.json"), join(root, "subscriptions", "subscriptions.json"));
  await assert.rejects(call(root, "subscription.list"), deny("INVALID_DATA"));
  await rm(join(root, "subscriptions", "subscriptions.json"));
  await writeState(root, state());
  await symlink(elsewhere, join(root, "subscriptions", "cache"), "dir");
  await assert.rejects(call(root, "subscription.list"), deny("INVALID_DATA"));
  const rootLink = join(fixtures, "root-link");
  await symlink(elsewhere, rootLink, "dir");
  t.after(() => rm(rootLink, { force: true }));
  await assert.rejects(call(rootLink, "subscription.list"), deny("INVALID_WORKSPACE"));
});

test("read-only projection leaves original bytes and directory entries unchanged", async t => {
  const root = await fixture(t);
  const path = join(root, "subscriptions", "subscriptions.json");
  const before = await readFile(path);
  await call(root, "subscription.list");
  await call(root, "subscription.get", { id: "sub-1" });
  await call(root, "subscription.acl.evaluate", { shareId: "share-1", action: "download", sourceIp: "127.0.0.1" });
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(await readdir(join(root, "subscriptions")), ["subscriptions.json"]);
});

test("reusable source files and exact result fields cover actual transport fixture operations", async t => {
  const root = await fixture(t, null);
  await installSubscriptionReadTransportFixtures(root);
  for (const item of subscriptionReadTransportFixtures()) {
    const { revision, ...result } = await call(root, item.operation, item.args, "local:owner");
    assert.match(revision, /^[a-f0-9]{64}$/);
    assert.deepEqual(result, item.result);
  }
});

test("capture provenance uses repository source root and next-server captured root with exact hashes", async () => {
  const provenance = JSON.parse(await readFile(join(packageRoot, "migration", "subscription-reads-provenance.json"), "utf8"));
  assert.ok(provenance.files.length >= 4);
  assert.deepEqual(await checkCaptureRecords(provenance.files, resolve(packageRoot, "legacy"), packageRoot), []);
  for (const item of provenance.files) {
    assert.equal(item.source.startsWith("next-server/"), false);
    assert.equal(item.captured.startsWith("next-server/"), false);
    assert.equal(createHash("sha256").update(await readFile(join(packageRoot, item.captured))).digest("hex"), item.capturedSha256);
  }
  const contractSource = await readFile(join(packageRoot, "src", "subscription-reads-contracts.ts"), "utf8");
  assert.doesNotMatch(contractSource, /CoreError|from ["']\.\/contracts/);
});
