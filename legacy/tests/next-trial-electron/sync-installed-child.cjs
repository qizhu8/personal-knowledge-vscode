"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
let nextId = 0;
const pending = new Map();
process.on("message", message => {
  if (message.kind === "secret-result") {
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message.value); }
  }
});
const readSecret = key => new Promise(resolve => {
  const id = ++nextId;
  pending.set(id, resolve);
  process.send({ kind: "secret", id, key });
});
process.once("message", async message => {
  if (message.kind !== "start") return;
  let storage, host;
  try {
    const runtime = message.runtime;
    const load = name => import(pathToFileURL(path.join(runtime, "dist", `${name}.js`)).href);
    const { Storage } = await load("storage");
    const { openExperimentalLegacySyncHost } = await load("legacy-github-sync-experimental-host");
    const { localGitSyncProvider } = await import(pathToFileURL(message.providerScript).href);
    const provider = localGitSyncProvider(message.directory, message.bare, message.policy);
    storage = await Storage.open(message.root, { deferRecovery: message.action === "resume" });
    host = await openExperimentalLegacySyncHost({
      mode: "isolated-experiment", storage, globalStorage: message.globalStorage,
      targetId: "fixture-target", actorId: "installed-sync-fixture", transport: provider.host,
      publisherPolicy: { policyId: message.policy.policyId, enforcement: "all-repository-ref-writers" },
      readSecret,
    });
    if (message.action === "crash") {
      provider.loseNextPushResponse();
      await assert.rejects(host.sync(), /transport network/);
      assert.equal(host.status().phase, "publishing");
      assert.equal(provider.pushes, 1);
      process.exit(77);
    }
    const result = await (message.action === "resume" ? host.resume() : host.sync());
    process.send({ kind: "result", result, pushes: provider.pushes });
    await host.close(); host = undefined;
    await storage.close(); storage = undefined;
    process.disconnect();
  } catch (error) {
    process.send?.({ kind: "error", message: String(error?.message ?? error) });
    try { await host?.close(); } finally { await storage?.close(); }
    process.exitCode = 1;
    process.disconnect();
  }
});
