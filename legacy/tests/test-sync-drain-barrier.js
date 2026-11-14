const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = process.env.PKM_STABILITY_EXTENSION_ROOT || path.resolve(__dirname, "..");
const { PkmServiceClient, pkmServiceIdentity } = require(path.join(root, "dist/runtime/pkm-service"));
const { GitHubSyncScheduler } = require(path.join(root, "dist/sync/github-sync-scheduler"));

for (const gate of ["shouldExecute", "beforeExecute"]) test(`disposal fences work still awaiting ${gate}`, async () => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const scheduler = new GitHubSyncScheduler({
    [gate]:async () => { entered(); return new Promise(resolve => { release = resolve; }); },
    execute:async () => { calls++; },
  });
  try {
    scheduler.configure([{ id:"target", enabled:true, intervalMinutes:7, syncOnChange:false }]);
    await ready;
    scheduler.dispose();
    release(true);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0, "late admission must not start execution after safe-idle service disposal");
  } finally { release?.(true); scheduler.dispose(); }
});

test("stale persisted syncing display cannot block an idle independent service drain", { timeout:10000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-stale-drain-"));
  const options = {
    knowledgeRoot:path.join(directory, "knowledge"), globalStoragePath:path.join(directory, "storage"),
    extensionVersion:require(path.join(root, "package.json")).version,
    serviceEntryPath:path.join(root, "dist/runtime/pkm-service-entry.js"), onError() {},
  };
  fs.mkdirSync(options.knowledgeRoot); fs.mkdirSync(options.globalStoragePath);
  const identity = pkmServiceIdentity(options);
  fs.mkdirSync(identity.stateDirectory, { recursive:true });
  fs.writeFileSync(path.join(identity.stateDirectory, "coordinator.json"), JSON.stringify({
    schema:1, configurationRevision:0, nextFencingToken:0, nextIntentSequence:0, targets:{}, intents:{}, claims:{}, blocked:{},
    runtime:{ previous:{ status:"syncing", phase:"authenticating", detail:"Historical display only" } },
  }));
  const client = await PkmServiceClient.connect(options);
  const endpoint = path.join(identity.serviceDirectory, "endpoint.json");
  const metadata = JSON.parse(fs.readFileSync(endpoint, "utf8"));
  let timer;
  t.after(async () => {
    clearTimeout(timer); client.dispose();
    if (fs.existsSync(endpoint)) {
      const current = JSON.parse(fs.readFileSync(endpoint, "utf8"));
      assert.equal(current.pid, metadata.pid);
      assert.equal(current.nonce, metadata.nonce);
      try { process.kill(metadata.pid, "SIGTERM"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    for (let i = 0; i < 100 && fs.existsSync(endpoint); i++) await new Promise(resolve => setTimeout(resolve, 10));
    fs.rmSync(directory, { recursive:true, force:true });
  });
  assert.equal(client.snapshot().previous?.status, "syncing", "fixture must contain a stale display state");
  await Promise.race([
    client.drain(),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Idle drain was blocked by persisted display state")), 2000); }),
  ]);
  clearTimeout(timer);
  for (let i = 0; i < 100 && fs.existsSync(endpoint); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(endpoint), false, "successful drain removes its owned endpoint");
  const state = JSON.parse(fs.readFileSync(path.join(identity.stateDirectory, "coordinator.json"), "utf8"));
  assert.deepEqual(state.intents, {}); assert.deepEqual(state.claims, {});
});
