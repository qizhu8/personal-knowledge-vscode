import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const dist = resolve(process.env.PKM_TEST_NEXT_DIST || "next-server/dist");
const { validateNativePriorityChange, validateNativeRefreshRetry, nativeSubscriptionChangeSha256 } =
  await import(pathToFileURL(join(dist, "native-subscription-priority.js")));
const hash = value => createHash("sha256").update(value).digest("hex");
const pin = (path, text) => { const bytes = Buffer.from(text); return { path, size: bytes.length, sha256: hash(bytes), bytes }; };

test("priority recovery accepts only exact target writes and never unrelated state or cache", () => {
  const node = "a".repeat(64), change = { action: "priority", publisherNodeId: node, shareId: "share",
    subscriptionId: "one", priority: "highest" };
  const path = `cache/${node}/share/_subscription.json`;
  const metadata = { subscriptionId: "one", priority: "normal", revision: 1 };
  const state = { nodeId: "local", subscriptions: [
    { id: "one", nodeId: node, shareId: "share", priority: "normal", alias: "original" },
    { id: "two", nodeId: "b".repeat(64), shareId: "other", priority: "normal" },
  ] };
  const before = { state, directories: ["subscriptions/cache"], files: [
    pin(path, JSON.stringify(metadata)), pin("cache/other/content.md", "foreign"),
  ] };
  const updatedMeta = pin(path, JSON.stringify({ ...metadata, priority: "highest" }, null, 2));
  const newState = structuredClone(state); newState.subscriptions[0].priority = "highest";
  const partial = { ...before, files: [updatedMeta, before.files[1]] };
  const finished = { ...partial, state: newState };
  assert.doesNotThrow(() => validateNativePriorityChange(before, partial, change, false));
  assert.throws(() => validateNativePriorityChange(before, partial, change, true));
  assert.doesNotThrow(() => validateNativePriorityChange(before, finished, change, true));
  const foreign = structuredClone(finished); foreign.state.subscriptions[1].priority = "highest";
  assert.throws(() => validateNativePriorityChange(before, foreign, change, false));
  assert.throws(() => validateNativePriorityChange(before, { ...finished,
    files: [updatedMeta, pin("cache/other/content.md", "changed")] }, change, true));
  assert.throws(() => validateNativePriorityChange(before, { ...finished,
    files: [pin(path, JSON.stringify({ ...metadata, priority: "highest", revision: 2 }, null, 2)), before.files[1]] }, change, true));
  assert.throws(() => nativeSubscriptionChangeSha256({ ...change, priority: "admin" }));
  assert.throws(() => nativeSubscriptionChangeSha256({ ...change, extra: true }));
});

test("refresh retry preserves identity and refuses unknown target cache changes", () => {
  const node = "a".repeat(64), change = { action: "refresh", publisherNodeId: node, shareId: "share", subscriptionId: "one" };
  const before = { state: { subscriptions: [{ id: "one", nodeId: node, shareId: "share",
    status: "current", revision: 1, collectionHash: "hash", endpoint: "http://127.0.0.1" }] },
    directories: ["subscriptions/cache"], files: [pin(`cache/${node}/share/bundle.json`, "old")] };
  const interrupted = structuredClone(before);
  interrupted.state.subscriptions[0].status = "updating";
  assert.doesNotThrow(() => validateNativeRefreshRetry(before, interrupted, change));
  const changed = structuredClone(interrupted);
  changed.state.subscriptions[0].endpoint = "http://elsewhere";
  assert.throws(() => validateNativeRefreshRetry(before, changed, change));
  assert.throws(() => validateNativeRefreshRetry(before, { ...interrupted,
    files: [pin(`cache/${node}/share/bundle.json`, "unknown")] }, change));
  assert.throws(() => nativeSubscriptionChangeSha256({ ...change, shareId: 123 }));
});
