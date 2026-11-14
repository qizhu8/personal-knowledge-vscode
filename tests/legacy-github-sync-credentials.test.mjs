import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyVscodeSyncCredentialReader } from "../dist/legacy-github-sync-credentials.js";

test("legacy VS Code credential binding reads the original target key without persisting the secret", async () => {
  const keys = [];
  const reader = legacyVscodeSyncCredentialReader({
    targetId: "target-1", expectedLogin: "Fixture-Account", secretRef: "native-ref",
    readSecret: async key => {
      keys.push(key);
      return JSON.stringify({ accountId: "fixture-account-id", accountLabel: "fixture-account", accessToken: "fixture-token" });
    },
  });
  assert.deepEqual(await reader("native-ref", new AbortController().signal), { login: "fixture-account", accessToken: "fixture-token" });
  assert.deepEqual(keys, ["personalKnowledge.githubSync.vscode.target-1"]);
  await assert.rejects(reader("other-ref", new AbortController().signal), /credential unavailable/);
  assert.equal(keys.length, 1);
});

test("missing, mismatched and failing secret sources are rejected without exposing their contents", async () => {
  for (const readSecret of [
    async () => undefined,
    async () => "invalid fixture-token",
    async () => JSON.stringify({ accountLabel: "other", accessToken: "fixture-token" }),
    async () => { throw new Error("fixture-token"); },
  ]) {
    const reader = legacyVscodeSyncCredentialReader({
      targetId: "target-1", expectedLogin: "fixture", secretRef: "native-ref", readSecret,
    });
    await assert.rejects(reader("native-ref", new AbortController().signal), error =>
      error.message === "Legacy Sync credential unavailable." && !error.message.includes("fixture-token"));
  }
});

test("cancellation prevents late secret results from reaching the caller", async () => {
  let release;
  const reader = legacyVscodeSyncCredentialReader({
    targetId: "target-1", expectedLogin: "fixture", secretRef: "native-ref",
    readSecret: () => new Promise(resolve => { release = resolve; }),
  });
  const controller = new AbortController();
  const result = reader("native-ref", controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(result, /credential unavailable/);
  release(JSON.stringify({ accountLabel: "fixture", accessToken: "fixture-token" }));
});
