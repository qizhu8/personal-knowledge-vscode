"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const Module = require("node:module");
const esbuild = require("esbuild");

const source = fs.readFileSync(path.join(__dirname, "../src/subscriptions/authenticated-pull.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exportsObject = {};
new Function("exports", compiled)(exportsObject);
const { withAuthenticatedSubscriptionPull } = exportsObject;
const target = { nodeId: "a".repeat(64), shareId: "share" };

test("only a completed exact authenticated download admits a successful pull", async () => {
  const instance = { async downloadSnapshot(record) { assert.deepEqual(record, target); return "materialized"; } };
  const original = instance.downloadSnapshot;
  assert.equal(await withAuthenticatedSubscriptionPull(instance, target,
    () => instance.downloadSnapshot(target, {})), "materialized");
  assert.equal(instance.downloadSnapshot, original);
  await assert.rejects(withAuthenticatedSubscriptionPull(instance, target, async () => "304"),
    /did not complete/);
  assert.equal(instance.downloadSnapshot, original);
  await assert.rejects(withAuthenticatedSubscriptionPull(instance, target,
    () => instance.downloadSnapshot({ ...target, shareId: "other" }, {})), /target changed/);
  assert.equal(instance.downloadSnapshot, original);
  const inherited = Object.create({ async downloadSnapshot() { return "inherited"; } });
  assert.equal(await withAuthenticatedSubscriptionPull(inherited, target,
    () => inherited.downloadSnapshot(target, {})), "inherited");
  assert.equal(Object.hasOwn(inherited, "downloadSnapshot"), false);
});

test("failed, repeated and overlapping downloads cannot authorize publication", async () => {
  const instance = { async downloadSnapshot() { throw new Error("decryption failed"); } };
  const original = instance.downloadSnapshot;
  await assert.rejects(withAuthenticatedSubscriptionPull(instance, target,
    () => instance.downloadSnapshot(target, {})), /decryption failed/);
  assert.equal(instance.downloadSnapshot, original);
  instance.downloadSnapshot = async () => {};
  await assert.rejects(withAuthenticatedSubscriptionPull(instance, target, async () => {
    await instance.downloadSnapshot(target, {});
    await instance.downloadSnapshot(target, {});
  }), /target changed/);
  await assert.rejects(withAuthenticatedSubscriptionPull(instance, target, async () => {
    await instance.downloadSnapshot(target, {});
    await instance.downloadSnapshot(target, {}).catch(() => {});
  }), /did not complete/);
  await withAuthenticatedSubscriptionPull(instance, target, async () => {
    await assert.rejects(withAuthenticatedSubscriptionPull(instance, target, async () => {}), /unavailable/);
    await instance.downloadSnapshot(target, {});
  });
});

test("the actual legacy forced-refresh 304 path does not prove a download", async () => {
    const filename = path.join(__dirname, "../src/subscriptions/subscriptions.ts");
    const bundle = esbuild.buildSync({ entryPoints: [filename], bundle: true, platform: "node",
      format: "cjs", packages: "external", write: false });
    const module = new Module(filename, require.main);
    module.filename = filename;
    module.paths = Module._nodeModulePaths(path.dirname(filename));
    module._compile(bundle.outputFiles[0].text, filename);
    const manager = Object.create(module.exports.SharedMarketManager.prototype);
    const record = { id: "member", ...target, endpoint: "http://127.0.0.1:23001", status: "current",
      etag: '"prior"', secretProtected: false };
    Object.assign(manager, { stateMutationDepth: 1, state: { subscriptions: [record] }, warned: new Set(),
      events: {}, save() {}, subscriberProof() { return "synthetic-proof"; } });
    const originalFetch = global.fetch;
    global.fetch = async (_url, options) => {
      assert.equal(options.headers["If-None-Match"], undefined);
      return { status: 304 };
    };
    try {
      await assert.rejects(withAuthenticatedSubscriptionPull(manager, target,
        () => manager.refresh("member", true)), /did not complete/);
      assert.equal(record.status, "current");
    } finally { global.fetch = originalFetch; }
});
