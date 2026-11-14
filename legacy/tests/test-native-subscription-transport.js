"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const esbuild = require("esbuild");
const Module = require("node:module");

test("experimental legacy refresh denies forced 304, redirects and policy-denied control endpoints", async () => {
  const filename = path.resolve("src/subscriptions/native-remote-transport.ts");
  const entry = `module.exports = {
    ...require(${JSON.stringify(filename)}),
    ...require(${JSON.stringify(path.resolve("src/subscriptions/subscriptions.ts"))}),
    ...require(${JSON.stringify(path.resolve("src/subscriptions/authenticated-pull.ts"))})
  };`;
  const bundle = esbuild.buildSync({ stdin: { contents: entry, resolveDir: process.cwd(), loader: "js" },
    bundle: true, platform: "node", format: "cjs", packages: "external", write: false });
  const module = new Module(filename, require.main);
  module.filename = filename; module.paths = Module._nodeModulePaths(path.dirname(filename));
  module._compile(bundle.outputFiles[0].text, filename);
  const { SharedMarketManager, installNativeRemoteSubscriptionTransport, withAuthenticatedSubscriptionPull } = module.exports;
  const profile = path.resolve(".migration-test-work", `transport-${randomUUID()}`);
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const priorGate = process.env.PKM_EXPERIMENTAL_SUBSCRIPTION_HOST, originalFetch = global.fetch;
  process.env.PKM_EXPERIMENTAL_SUBSCRIPTION_HOST = "1";
  try {
    const nodeId = "a".repeat(64), target = { nodeId, shareId: "share" };
    const record = { id: "member", ...target, endpoint: "http://127.0.0.1:23001", status: "current",
      etag: '"prior"', secretProtected: false };
    const manager = Object.create(SharedMarketManager.prototype);
    Object.assign(manager, { storageDir: profile, stateMutationDepth: 1,
      state: { nodeId: "b".repeat(64), subscriptions: [record] }, warned: new Set(), events: {},
      save() {}, changed() {}, warning() {}, subscriberProof() { return "synthetic-proof"; } });
    installNativeRemoteSubscriptionTransport(manager, profile, {
      control: url => url.origin === "http://127.0.0.1:23001", transfer: () => false,
    });
    let calls = 0;
    global.fetch = async (_url, options) => {
      calls++;
      assert.equal(options.redirect, "error");
      assert.equal(options.headers["If-None-Match"], undefined);
      return new Response(null, { status: 304 });
    };
    await assert.rejects(withAuthenticatedSubscriptionPull(manager, target,
      () => manager.refresh("member", true)), /304/);
    assert.equal(record.status, "offline");
    record.endpoint = "http://127.0.0.1:23002";
    await assert.rejects(manager.refresh("member", true), /endpoint denied/);
    assert.equal(calls, 1);
    record.endpoint = "http://127.0.0.1:23001";
    global.fetch = async (_url, options) => {
      assert.equal(options.redirect, "error");
      throw new TypeError("fetch failed: unexpected redirect");
    };
    await assert.rejects(withAuthenticatedSubscriptionPull(manager, target,
      () => manager.refresh("member", true)), /redirect/);
  } finally {
    global.fetch = originalFetch;
    if (priorGate === undefined) delete process.env.PKM_EXPERIMENTAL_SUBSCRIPTION_HOST;
    else process.env.PKM_EXPERIMENTAL_SUBSCRIPTION_HOST = priorGate;
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
