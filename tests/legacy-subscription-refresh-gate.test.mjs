import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { publishProtectedRefreshFixture, validateProtectedRefreshChange } from "../dist/legacy-subscription-refresh.js";

test("refresh publication cannot be enabled by ordinary workspace or public arguments", async () => {
  const fixture = resolve(".migration-test-work", `pkm-protected-state-fixture-${randomUUID()}`);
  const profile = join(fixture, "profile"), workspace = join(fixture, "imported");
  let entered = false;
  const store = { workspaceRoot: () => workspace, withWorkspaceExclusive: () => { entered = true; } };
  const oldFixture = process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT;
  const oldUi = process.env.PKM_PRIVATE_SUBSCRIPTION_UI;
  try {
    delete process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT;
    delete process.env.PKM_PRIVATE_SUBSCRIPTION_UI;
    await assert.rejects(publishProtectedRefreshFixture(store, profile, null, "fixture-share", randomUUID()), { code: "FORBIDDEN" });
    process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT = fixture;
    await assert.rejects(publishProtectedRefreshFixture(store, profile, null, "fixture-share", randomUUID()), { code: "FORBIDDEN" });
    process.env.PKM_PRIVATE_SUBSCRIPTION_UI = "1";
    await assert.rejects(publishProtectedRefreshFixture(store, resolve("production-profile"), null, "fixture-share", randomUUID()), { code: "FORBIDDEN" });
    assert.equal(entered, false);
  } finally {
    if (oldFixture === undefined) delete process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT;
    else process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT = oldFixture;
    if (oldUi === undefined) delete process.env.PKM_PRIVATE_SUBSCRIPTION_UI;
    else process.env.PKM_PRIVATE_SUBSCRIPTION_UI = oldUi;
  }
});

test("a multi-subscription publication isolates its target and rejects unrelated external writes", () => {
  const member = (id, shareId, revision) => ({
    id, nodeId: "publisher", shareId, publicKey: "key", magicLink: shareId, endpoint: "http://127.0.0.1",
    status: "current", revision, collectionHash: `hash-${shareId}-${revision}`, priority: "normal",
  });
  const genesis = { schema: 1, nodeId: "publisher", publicKey: "key", shares: [],
    subscriptions: [member("one", "share-a", 1), member("two", "share-b", 3)] };
  const path = share => `cache/publisher/${share}/content/notes/n.md`;
  const pin = (share, sha256) => ({ path: path(share), sha256, size: 1 });
  const previous = { state: structuredClone(genesis),
    directories: ["subscriptions/cache", "subscriptions/cache/publisher",
      "subscriptions/cache/publisher/share-a", "subscriptions/cache/publisher/share-b"],
    files: [pin("share-a", "a1"), pin("share-b", "b3")] };
  const next = structuredClone(previous);
  next.state.subscriptions[0].revision = 2;
  next.state.subscriptions[0].collectionHash = "hash-share-a-2";
  next.files[0] = pin("share-a", "a2");
  assert.doesNotThrow(() => validateProtectedRefreshChange(genesis, previous, next, "share-a"));
  const denied = mutate => {
    const changed = structuredClone(next);
    mutate(changed);
    assert.throws(() => validateProtectedRefreshChange(genesis, previous, changed, "share-a"), { code: "CONFLICT" });
  };
  denied(value => { value.state.subscriptions[1].priority = "highest"; });
  denied(value => { value.files[1].sha256 = "foreign"; });
  denied(value => { value.directories.push("subscriptions/cache/publisher/share-b/content"); });
  denied(value => { value.state.subscriptions[0].shareId = "share-b"; });
  denied(value => { value.state.subscriptions.reverse(); });
  denied(value => { value.state.subscriptions[0].revision = 0; });
  denied(value => { value.state.subscriptions[0].priority = "highest"; });
  denied(value => {
    value.state.subscriptions[0].revision = 1;
    value.state.subscriptions[0].collectionHash = "hash-share-a-1";
  });
  assert.throws(() => validateProtectedRefreshChange(genesis, previous, next, "unknown"), { code: "CONFLICT" });
  const priority = structuredClone(previous);
  priority.state.subscriptions[0].priority = "high";
  assert.doesNotThrow(() => validateProtectedRefreshChange(genesis, previous, priority, "share-a", false, true));
  priority.files[0].sha256 = "unrelated";
  assert.throws(() => validateProtectedRefreshChange(genesis, previous, priority, "share-a", false, true), { code: "CONFLICT" });
});

test("a failed refresh publishes only the known offline outcome without changing any cached data", () => {
  const record = { id: "one", nodeId: "publisher", shareId: "share-a", status: "current",
    revision: 1, collectionHash: "same", lastChecked: "old" };
  const genesis = { schema: 1, nodeId: "publisher", publicKey: "key", shares: [], subscriptions: [record] };
  const previous = { state: structuredClone(genesis), directories: ["subscriptions/cache"],
    files: [{ path: "cache/publisher/share-a/content/notes/a.md", sha256: "old", size: 1 }] };
  const next = structuredClone(previous);
  Object.assign(next.state.subscriptions[0], { status: "offline", error: "Broker returned 403.", lastChecked: "new" });
  assert.doesNotThrow(() => validateProtectedRefreshChange(genesis, previous, next, "share-a", true));
  assert.throws(() => validateProtectedRefreshChange(genesis, previous, next, "share-a"), { code: "CONFLICT" });
  const denied = mutate => {
    const changed = structuredClone(next);
    mutate(changed);
    assert.throws(() => validateProtectedRefreshChange(genesis, previous, changed, "share-a", true), { code: "CONFLICT" });
  };
  denied(value => { value.state.subscriptions[0].error = "unrecognized external error"; });
  denied(value => { value.state.subscriptions[0].revision = 2; });
  denied(value => { value.state.subscriptions[0].priority = "high"; });
  denied(value => { value.files[0].sha256 = "new"; });
});

test("publisher identity disambiguates identical share IDs without altering another publisher", () => {
  const member = (id, nodeId) => ({ id, nodeId, shareId: "shared", status: "current",
    revision: 1, collectionHash: `hash-${nodeId}` });
  const genesis = { schema: 1, nodeId: "subscriber", publicKey: "key", shares: [],
    subscriptions: [member("a", "publisher-a"), member("b", "publisher-b")] };
  const previous = { state: structuredClone(genesis),
    directories: ["subscriptions/cache", "subscriptions/cache/publisher-a", "subscriptions/cache/publisher-b",
      "subscriptions/cache/publisher-a/shared", "subscriptions/cache/publisher-b/shared"],
    files: ["publisher-a", "publisher-b"].map(nodeId => ({
      path: `cache/${nodeId}/shared/content/notes/a.md`, sha256: nodeId, size: 1,
    })) };
  const next = structuredClone(previous);
  next.state.subscriptions[1].revision = 2;
  next.state.subscriptions[1].collectionHash = "new";
  next.files[1].sha256 = "new";
  assert.doesNotThrow(() => validateProtectedRefreshChange(genesis, previous, next, "shared", false, false, "publisher-b"));
  assert.throws(() => validateProtectedRefreshChange(genesis, previous, next, "shared", false, false, "publisher-a"), { code: "CONFLICT" });
  assert.throws(() => validateProtectedRefreshChange(genesis, previous, next, "shared"), { code: "CONFLICT" });
});
