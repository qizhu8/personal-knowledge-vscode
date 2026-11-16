import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { fork, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { runInstalledGitHubUi } from "./native-subscription-github-installed.mjs";

const require = createRequire(import.meta.url), esbuild = require("esbuild"), Module = require("node:module");
const dist = resolve(process.env.PKM_TEST_NEXT_DIST || "dist");
const legacyRoot = resolve(import.meta.dirname, "../legacy");
const { prepareLegacyRootAdoptionExperimental, resumeLegacyRootAdoptionExperimental } =
  await import(pathToFileURL(join(dist, "legacy-root-adoption.js")));
const load = path => {
  const filename = resolve(legacyRoot, path);
  const compiled = esbuild.buildSync({ entryPoints: [filename], bundle: true, platform: "node",
    format: "cjs", packages: "external", write: false }).outputFiles[0].text;
  const module = new Module(filename, require.main);
  module.filename = filename; module.paths = Module._nodeModulePaths(resolve(filename, ".."));
  module._compile(compiled, filename);
  return module.exports;
};
const { SharedMarketManager } = load("src/subscriptions/subscriptions.ts");
const { withCrossProcessLock } = load("src/runtime/cross-process-lock.ts");
const { fetchGitHubRemoteSnapshot, normalizeGitHubSyncTarget, readGitHubRemoteFilesForSubscription } = load("src/sync/github-sync.ts");
const { readStoredGitHubSyncCredentials } = load("src/sync/github-sync-credentials.ts");
const { fetchPrivateGitHubSubscription, privateGitHubSubscriptionEndpoint } = load("src/subscriptions/native-github-snapshot.ts");
function remoteMember() {
  const { privateKey, publicKey: key } = generateKeyPairSync("ed25519");
  const publicKey = key.export({ type: "spki", format: "pem" }).toString();
  const nodeId = createHash("sha256").update(publicKey).digest("hex"), shareId = "synthetic-share";
  const payload = { protocol: "pkmshare:v1", publisher: "remote", publisherUser: "remote", publisherHost: "host",
    nodeId, publicKey, endpoint: "http://127.0.0.1", shareId, secretProtected: true, issuedAt: "test" };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const magicLink = `pkmshare:v1:${encoded}.${sign(null, Buffer.from(encoded), privateKey).toString("base64url")}`;
  const change = { action: "add", publisherNodeId: nodeId, shareId, magicLink,
    alias: "synthetic", endpoint: "http://127.0.0.1:23002", secretSalt: "synthetic-salt-123" };
  const summary = { shareId, name: "Remote", revision: 1, collectionHash: `sha256:${"b".repeat(64)}`,
    updatedAt: "test", counts: { notes: 1 }, topics: [], tags: [], itemCount: 1, metadataOnly: true,
    secretProtected: true, secretSalt: change.secretSalt, snapshotBytes: 10 };
  const signature = sign(null, Buffer.from(JSON.stringify(summary)), privateKey).toString("base64url");
  const record = { id: "member", alias: "synthetic", priority: "normal", nodeId, publisher: "remote", publisherUser: "remote",
    publisherHost: "host", endpoint: change.endpoint, shareId, publicKey, magicLink, revision: 1,
    collectionHash: summary.collectionHash, topics: [], tags: [], counts: { notes: 1 }, itemCount: 1,
    etag: '"synthetic"', status: "current", secretProtected: true, secretSalt: summary.secretSalt, brokerName: "Remote" };
  return { change, record, summary: { ...summary, signature } };
}
const childProgram = `
  const { pathToFileURL } = require("node:url");
  const { join } = require("node:path");
  (async () => {
    const root = process.env.TEST_ROOT, profile = process.env.TEST_PROFILE, dist = process.env.TEST_DIST;
    const { Storage } = await import(pathToFileURL(join(dist, "storage.js")));
    const { createNativeRuntime } = await import(pathToFileURL(join(dist, "native-runtime.js")));
    const storage = await Storage.open(root);
    const runtime = await createNativeRuntime({ storage, experimentalSubscriptionHost: { profile } });
    process.on("message", value => {
      if (value?.type !== "test-read") return;
      void runtime.core.dispatch("capability_read", { operation: value.operation, version: 1, arguments: value.args || {} },
        { id: "local:test", canWrite: false }).then(result => process.send({ id: value.id, result }));
    });
    process.send({ ready: true });
    process.once("disconnect", () => { void runtime.close().then(() => storage.close()).then(() => process.exit(0), () => process.exit(1)); });
  })().catch(error => { process.send?.({ failed: true, code: error?.code || error?.name || "unknown",
    detail: String(error?.stack || "").split("\\n").slice(0, 5).join("\\n") }); process.exit(1); });
`;

function start(root, profile, cli = false) {
  const token = "synthetic-native-subscription-token-0000000000";
  const child = fork(cli ? join(dist, "cli.js") : "-e", cli ? ["http", "--data", root] : [childProgram],
    { execArgv: [], env: { ...process.env, PKM_EXPERIMENTAL_SUBSCRIPTION_HOST: "1",
      PKM_EXPERIMENTAL_SUBSCRIPTION_PROFILE: cli ? profile : "", PKM_NEXT_TOKEN: token,
      TEST_ROOT: root, TEST_PROFILE: profile, TEST_DIST: dist },
    stdio: ["ignore", cli ? "pipe" : "ignore", cli ? "pipe" : "ignore", "ipc"] });
  let exited = false;
  let url, stderr = "";
  if (cli) child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  child.once("exit", () => { exited = true; });
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error("Native host did not start.")), 30000);
    if (cli) {
      let output = "";
      child.stdout.on("data", chunk => {
        output += chunk.toString();
        if (!output.includes("\n")) return;
        try {
          const value = JSON.parse(output.slice(0, output.indexOf("\n")));
          if (!value.ready || typeof value.url !== "string") throw new Error("Missing CLI ready URL.");
          url = value.url; clearTimeout(timer); resolveReady();
        } catch (error) { clearTimeout(timer); reject(error); }
      });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Native CLI exited (${code}) before readiness: ${stderr}`)); });
    } else child.once("message", value => {
        clearTimeout(timer);
        if (value?.ready) resolveReady(); else reject(new Error("Native host denied: " + value?.code + "\\n" + value?.detail));
      });
    child.once("error", reject);
  });
  return {
    async request(phase, extra = {}) {
      const id = randomUUID();
      return await new Promise((resolveReply, reject) => {
        const timer = setTimeout(() => reject(new Error("Native host did not reply.")), 30000);
        const receive = message => {
          if (message?.id !== id) return;
          clearTimeout(timer); child.off("message", receive); resolveReply(message);
        };
        child.on("message", receive);
        child.send({ type: "native-subscription-host/v1", id, phase, ...extra }, error => { if (error) reject(error); });
      });
    },
    async read(operation, args = {}) {
      if (cli) {
        const response = await fetch(`${url}/v1/capability_read`, { method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ operation, version: 1, arguments: args }) });
        return response.json();
      }
      const id = randomUUID();
      return await new Promise((resolveReply, reject) => {
        const timer = setTimeout(() => reject(new Error("Native read did not reply.")), 30000);
        const receive = message => {
          if (message?.id !== id) return;
          clearTimeout(timer); child.off("message", receive); resolveReply(message.result);
        };
        child.on("message", receive);
        child.send({ type: "test-read", id, operation, args }, error => { if (error) reject(error); });
      });
    },
    ready,
    async close() {
      if (exited) return;
      const done = new Promise(resolveExit => child.once("exit", resolveExit));
      if (cli) child.kill("SIGTERM"); else child.disconnect();
      await done;
    },
  };
}

test("experimental CLI rejects absent inherited IPC and absent explicit gate", () => {
  for (const gate of ["", "1"]) {
    const result = spawnSync(process.execPath, [join(dist, "cli.js"), "http", "--data", "unused"],
      { encoding: "utf8", env: { ...process.env, PKM_EXPERIMENTAL_SUBSCRIPTION_HOST: gate,
        PKM_EXPERIMENTAL_SUBSCRIPTION_PROFILE: "/unused", PKM_NEXT_TOKEN: "synthetic-token-0000000000000000000000000" } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /trusted inherited host IPC/);
  }
});

test("same-root profile admission is durable, private and bound to the inherited locked host", async () => {
  const base = resolve(".migration-test-work", `native-subscription-${randomUUID()}`);
  const root = join(base, "root"), profile = join(base, "profile");
  mkdirSync(join(root, "notes"), { recursive: true, mode: 0o700 });
  mkdirSync(profile, { mode: 0o700 });
  writeFileSync(join(root, "notes", "Original.md"), "---\ntitle: Original\ndocumentId: synthetic-note\nrevision: 1\n---\nOriginal.\n", { mode: 0o600 });
  try {
    const manager = new SharedMarketManager(profile, join(base, "unused-gateway.js"), "Synthetic local identity");
    manager.dispose();
    const privateKey = JSON.parse(readFileSync(join(profile, "subscriptions.json"), "utf8")).privateKey;
    await prepareLegacyRootAdoptionExperimental(root, {});
    const adopted = await resumeLegacyRootAdoptionExperimental(root, {});
    await adopted.storage.close();
    const inode = (await import("node:fs")).statSync(root).ino;
    await withCrossProcessLock(join(profile, "subscriptions-state.lock"), "Subscription state mutation", 60_000, async () => {
      let host = start(root, profile);
      try {
        await host.ready;
        assert.deepEqual((await host.request("status")).result, null);
        const admitted = await host.request("admit");
        assert.equal(admitted.ok, true);
        assert.equal(admitted.result.state.subscriptions.length, 0);
        assert.equal(JSON.stringify(admitted.result).includes(privateKey), false);
        assert.equal((await host.request("admit")).result.fingerprint, admitted.result.fingerprint);
        const { change, record, summary } = remoteMember(), operationId = randomUUID();
        assert.equal((await host.request("prepare", { operationId, expectedHead: admitted.result.fingerprint, change })).ok, true);
        await host.close();
        host = start(root, profile);
        await host.ready;
        const reopened = await host.request("status");
        assert.equal(reopened.result.fingerprint, admitted.result.fingerprint);
        assert.equal(reopened.result.pending.operationId, operationId);
        assert.equal((await host.request("check", { operationId, change })).result.targetExists, false);
        const statePath = join(profile, "subscriptions.json"), state = JSON.parse(readFileSync(statePath, "utf8"));
        state.subscriptions.push({ ...record, status: "offline" });
        writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
        assert.equal((await host.request("cancel", { operationId })).ok, false);
        assert.equal((await host.request("check", { operationId, change })).result.targetExists, true);
        state.subscriptions[0] = record;
        writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
        const cache = join(profile, "cache", record.nodeId, record.shareId);
        mkdirSync(cache, { recursive: true, mode: 0o700 });
        const metadata = { subscriptionId: record.id, nodeId: record.nodeId, shareId: record.shareId, alias: record.alias,
          endpoint: record.endpoint, priority: record.priority, revision: record.revision, collectionHash: record.collectionHash };
        for (const [name, value] of Object.entries({ "summary.json": summary, "_subscription.json": metadata,
          "bundle.json": { notes: [{ title: "synthetic" }] } }))
          writeFileSync(join(cache, name), JSON.stringify(value), { mode: 0o600 });
        assert.equal((await host.request("publish", { operationId, change, verifiedPull: false })).ok, false);
        const published = await host.request("publish", { operationId, change, verifiedPull: true });
        assert.equal(published.ok, true);
        assert.equal((await host.request("outcome", { operationId })).result.terminal.head, published.result.head);
        await host.close();
        host = start(root, profile); await host.ready;
        const status = await host.request("status");
        assert.equal(status.result.head, published.result.head);
        assert.equal(status.result.pending, null);
        assert.equal(status.result.state.subscriptions[0].id, record.id);
        const priority = { action: "priority", publisherNodeId: record.nodeId, shareId: record.shareId,
          subscriptionId: record.id, priority: "high" }, priorityId = randomUUID();
        assert.equal((await host.request("prepare", { operationId: priorityId, expectedHead: status.result.head, change: priority })).ok, true);
        const metadataPath = join(cache, "_subscription.json");
        writeFileSync(metadataPath, JSON.stringify({ ...metadata, priority: "high" }, null, 2), { mode: 0o600 });
        await host.close();
        host = start(root, profile); await host.ready;
        assert.equal((await host.request("status")).result.pending.operationId, priorityId);
        assert.equal((await host.request("cancel", { operationId: priorityId })).ok, false);
        assert.equal((await host.request("check", { operationId: priorityId, change: { ...priority, priority: "highest" } })).ok, false);
        writeFileSync(metadataPath, JSON.stringify({ ...metadata, priority: "high", alias: "tampered" }, null, 2), { mode: 0o600 });
        assert.equal((await host.request("check", { operationId: priorityId, change: priority })).ok, false);
        writeFileSync(metadataPath, JSON.stringify({ ...metadata, priority: "high" }, null, 2), { mode: 0o600 });
        assert.equal((await host.request("check", { operationId: priorityId, change: priority })).ok, true);
        assert.equal((await host.request("publish", { operationId: priorityId, change: priority, verifiedPull: false })).ok, false);
        state.subscriptions[0].priority = "high";
        writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
        const priorityPublished = await host.request("publish", { operationId: priorityId, change: priority, verifiedPull: false });
        assert.equal(priorityPublished.ok, true);
        await host.close();
        host = start(root, profile); await host.ready;
        const priorityStatus = await host.request("status");
        assert.equal(priorityStatus.result.pending, null);
        assert.equal(priorityStatus.result.state.subscriptions[0].priority, "high");
        const rename = { action: "rename", publisherNodeId: record.nodeId, shareId: record.shareId,
          subscriptionId: record.id, alias: "Renamed synthetic" }, renameId = randomUUID();
        assert.equal((await host.request("prepare", { operationId: renameId, expectedHead: priorityStatus.result.head, change: rename })).ok, true);
        writeFileSync(metadataPath, JSON.stringify({ ...metadata, priority: "high", alias: rename.alias }, null, 2), { mode: 0o600 });
        await host.close(); host = start(root, profile); await host.ready;
        assert.equal((await host.request("cancel", { operationId: renameId })).ok, false);
        assert.equal((await host.request("check", { operationId: renameId, change: { ...rename, alias: "other" } })).ok, false);
        assert.equal((await host.request("check", { operationId: renameId, change: rename })).ok, true);
        state.subscriptions[0].alias = rename.alias;
        writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
        const renamed = await host.request("publish", { operationId: renameId, change: rename, verifiedPull: false });
        assert.equal(renamed.ok, true);
        const refresh = { action: "refresh", publisherNodeId: record.nodeId, shareId: record.shareId,
          subscriptionId: record.id }, refreshId = randomUUID();
        assert.equal((await host.request("prepare", { operationId: refreshId, expectedHead: renamed.result.head, change: refresh })).ok, true);
        state.subscriptions[0].status = "updating";
        writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
        const staging = join(profile, "cache", record.nodeId, `.${record.shareId}.0123456789.staging`);
        mkdirSync(staging, { mode: 0o700 });
        await host.close(); host = start(root, profile); await host.ready;
        assert.equal((await host.request("status")).result.pending.operationId, refreshId);
        assert.equal((await host.request("recover", { operationId: randomUUID() })).ok, false);
        writeFileSync(join(staging, "partial"), "preserve", { mode: 0o600 });
        assert.equal((await host.request("recover", { operationId: refreshId })).ok, false);
        assert.equal(readFileSync(join(staging, "partial"), "utf8"), "preserve");
        rmSync(join(staging, "partial"));
        rmdirSync(staging);
        symlinkSync(cache, staging, "dir");
        assert.equal((await host.request("recover", { operationId: refreshId })).ok, false);
        rmSync(staging);
        mkdirSync(staging, { mode: 0o700 });
        const materializer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "/synthetic/subscription-materialize-worker.js"]);
        try {
          assert.equal((await host.request("recover", { operationId: refreshId })).ok, false);
          assert.equal(existsSync(staging), true);
        } finally {
          const stopped = new Promise(done => materializer.once("exit", done));
          materializer.kill("SIGTERM"); await stopped;
        }
        writeFileSync(join(cache, "bundle.json"), JSON.stringify({ notes: [{ title: "unknown" }] }), { mode: 0o600 });
        assert.equal((await host.request("recover", { operationId: refreshId })).ok, false);
        assert.equal(existsSync(staging), true);
        writeFileSync(join(cache, "bundle.json"), JSON.stringify({ notes: [{ title: "synthetic" }] }), { mode: 0o600 });
        const recovered = await host.request("recover", { operationId: refreshId });
        assert.deepEqual(recovered.result, { removedEmptyStaging: 1 });
        assert.equal(existsSync(staging), false);
        assert.equal((await host.request("status")).result.pending.operationId, refreshId);
        assert.deepEqual((await host.request("recover", { operationId: refreshId })).result, { removedEmptyStaging: 0 });
        assert.equal((await host.request("cancel", { operationId: refreshId })).ok, false);
        assert.equal((await host.request("check", { operationId: refreshId, change: refresh })).ok, true);
        assert.equal((await host.request("publish", { operationId: refreshId, change: refresh, verifiedPull: false })).ok, false);
        writeFileSync(join(cache, "bundle.json"), JSON.stringify({ notes: [{ title: "unknown" }] }), { mode: 0o600 });
        assert.equal((await host.request("check", { operationId: refreshId, change: refresh })).ok, false);
        writeFileSync(join(cache, "bundle.json"), JSON.stringify({ notes: [{ title: "synthetic" }] }), { mode: 0o600 });
        state.subscriptions[0].status = "current";
        writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
        assert.equal((await host.request("cancel", { operationId: refreshId })).ok, true);
        const remove = { action: "remove", publisherNodeId: record.nodeId, shareId: record.shareId, subscriptionId: record.id };
        const removeId = randomUUID();
        assert.equal((await host.request("prepare", { operationId: removeId, expectedHead: renamed.result.head, change: remove })).ok, true);
        state.subscriptions = [];
        writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
        rmSync(join(profile, "cache", record.nodeId), { recursive: true });
        await host.close();
        host = start(root, profile); await host.ready;
        assert.equal((await host.request("status")).result.pending.operationId, removeId);
        assert.equal((await host.request("check", { operationId: removeId, change: remove })).result.targetExists, false);
        const removed = await host.request("publish", { operationId: removeId, change: remove, verifiedPull: false });
        assert.equal(removed.ok, true);
        assert.equal((await host.request("status")).result.state.subscriptions.length, 0);
        const lock = join(profile, "subscriptions-state.lock"), saved = `${lock}.saved`;
        renameSync(lock, saved);
        try {
          mkdirSync(lock, { mode: 0o700 });
          const nonce = randomUUID();
          writeFileSync(join(lock, `${nonce}.json`), JSON.stringify({ pid: process.pid, nonce, owner: "Subscription state mutation" }), { mode: 0o600 });
          assert.equal((await host.request("status")).ok, false);
        } finally { rmSync(lock, { recursive: true }); renameSync(saved, lock); }
      } finally { await host.close(); }
    });

    assert.equal((await import("node:fs")).statSync(root).ino, inode);
    for (const name of readdirSync(root).filter(name => name.startsWith("core.sqlite")))
      assert.equal(readFileSync(join(root, name)).includes(Buffer.from(privateKey)), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("native IPC coordinates actual legacy protected pull and removal through a local gateway", async t => {
      const base = resolve(".migration-test-work", `native-subscription-gateway-${randomUUID()}`);
      const root = join(base, "root"), profile = join(base, "profile"), publisherRoot = join(base, "publisher-root");
      const publisherProfile = join(base, "publisher-profile"), stage = join(base, "host-dist");
      for (const dir of [join(root, "notes"), join(publisherRoot, "notes"), profile, publisherProfile, join(stage, "subscriptions")])
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(stage, "package.json"), '{"type":"commonjs"}\n', { mode: 0o600 });
      symlinkSync(join(legacyRoot, "node_modules"), join(stage, "node_modules"), "dir");
      writeFileSync(join(root, "notes", "Original.md"), "---\ntitle: Original\ndocumentId: synthetic-note\nrevision: 1\n---\nOriginal.\n", { mode: 0o600 });
      writeFileSync(join(publisherRoot, "notes", "Shared.md"), "# Synthetic protected share\n", { mode: 0o600 });
      const entry = [
        `const legacy = require(${JSON.stringify(resolve(legacyRoot, "src/subscriptions/subscriptions.ts"))});`,
        `const filestore = require(${JSON.stringify(resolve(legacyRoot, "src/knowledge/filestore.ts"))});`,
        `const storage = require(${JSON.stringify(resolve(legacyRoot, "src/knowledge/storage.ts"))});`,
        `const transport = require(${JSON.stringify(resolve(legacyRoot, "src/subscriptions/native-remote-transport.ts"))});`,
        `const proof = require(${JSON.stringify(resolve(legacyRoot, "src/subscriptions/authenticated-pull.ts"))});`,
        "module.exports = { ...legacy, ...transport, ...proof, setRoot: p => { filestore.setStorePath(p); storage.setStorePath(p); } };",
      ].join("\n");
      esbuild.buildSync({ stdin: { contents: entry, resolveDir: resolve("."), loader: "js" }, bundle: true,
        platform: "node", format: "cjs", packages: "external", outfile: join(stage, "subscriptions", "subscriptions.js") });
      for (const [source, output] of [
        ["src/subscriptions/subscription-materialize-worker.ts", "subscription-materialize-worker.js"],
        ["src/subscriptions/subscription-gateway-entry.ts", "subscription-gateway.js"],
      ]) esbuild.buildSync({ entryPoints: [resolve(legacyRoot, source)], bundle: true, platform: "node", format: "cjs",
        packages: "external", outfile: join(stage, output) });
      const legacy = require(join(stage, "subscriptions", "subscriptions.js"));
      const memory = () => {
        const values = new Map();
        return { async get(key) { return values.get(key); }, async store(key, value) { values.set(key, value); },
          async delete(key) { values.delete(key); } };
      };
      const subscriberSecrets = memory(), publisherSecrets = memory(), secret = randomBytes(32).toString("base64url");
      const subscriber = new legacy.SharedMarketManager(profile, join(stage, "subscription-gateway.js"),
        "Synthetic subscriber", {}, subscriberSecrets, { user: "subscriber", host: "local" });
      const publisher = new legacy.SharedMarketManager(publisherProfile, join(stage, "subscription-gateway.js"),
        "Synthetic publisher", {}, publisherSecrets, { user: "publisher", host: "local" });
      const oldEnv = process.env.PKM_EXPERIMENTAL_SUBSCRIPTION_HOST;
      process.env.PKM_EXPERIMENTAL_SUBSCRIPTION_HOST = "1";
      subscriber.connectMqtt = () => {};
      legacy.installNativeRemoteSubscriptionTransport(subscriber, profile, {
        control: url => url.origin === "http://127.0.0.1:23002",
        transfer: url => url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "23002",
      });

await t.test("GitHub journal pins old Skills-only membership and authenticated commit", async () => {
  const base = resolve(".migration-test-work", `pkm-native-subscription-ui-${randomUUID()}`);
  const root = join(base, "root"), profile = join(base, "profile"), bare = join(base, "repository.git");
  const work = join(base, "work"), checkout = join(base, "checkouts"), home = join(base, "home");
  for (const dir of [join(root, "notes"), profile, work, home, join(base, "runtime")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "notes", "Local.md"), "# Synthetic local\n", { mode: 0o600 });
  const saved = new Map(["PATH", "HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_SSL_CAINFO",
    "GIT_TERMINAL_PROMPT", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
    "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1", "GIT_CONFIG_KEY_2", "GIT_CONFIG_VALUE_2", "GIT_CONFIG_KEY_3", "GIT_CONFIG_VALUE_3",
    "PKM_GITHUB_SYNC_TOKEN",
    "PKM_PRIVATE_NATIVE_SUBSCRIPTION", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]
      .map(key => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  delete process.env.HTTP_PROXY; delete process.env.HTTPS_PROXY; delete process.env.ALL_PROXY;
  const git = (cwd, ...args) => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8", env: process.env });
      if (result.status !== 0) throw new Error(`Synthetic git failed: ${result.stderr}`);
      return result.stdout.trim();
  };
  const certificate = join(base, "synthetic-cert.pem"), key = join(base, "synthetic-key.pem");
  const openssl = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  assert.equal(openssl.status, 0);
  process.env.GIT_SSL_CAINFO = certificate;
  let requests = 0, redirectedRequests = 0, authenticatedRedirects = 0, publicAuthRequests = 0, publicMode = false, redirect = "";
  const token = "synthetic-github-host-token-12345";
  const server = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
      requests++;
      if (publicMode && request.headers.authorization) { publicAuthRequests++; response.writeHead(400).end(); return; }
      if (!publicMode && request.headers.authorization !== `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`) {
        response.writeHead(401, { "www-authenticate": 'Basic realm="synthetic-git"' }).end(); return;
      }
      if (redirect) { authenticatedRedirects++; response.writeHead(302, { location: redirect }).end(); return; }
      const name = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      if (!name.startsWith("/repository.git/") || name.includes("..")) { response.writeHead(404).end(); return; }
      try { response.writeHead(200, { "content-type": "application/octet-stream" }).end(readFileSync(join(bare, name.slice("/repository.git/".length)))); }
      catch { response.writeHead(404).end(); }
  });
  const redirected = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (_request, response) => {
    redirectedRequests++; response.writeHead(500).end();
  });
  let manager;
  try {
      git(base, "init", "--bare", bare);
      git(work, "init", "-b", "main");
      git(work, "config", "user.email", "synthetic@example.invalid");
      git(work, "config", "user.name", "Synthetic");
      mkdirSync(join(work, "skills", "Public"), { recursive: true });
      mkdirSync(join(work, "notes"), { recursive: true });
      writeFileSync(join(work, "skills", "Public", "One.md"), "# Skill one\n");
      writeFileSync(join(work, "notes", "not-selected.md"), "# Not selected\n");
      git(work, "add", "."); git(work, "commit", "-m", "initial"); git(work, "remote", "add", "origin", bare);
      git(work, "push", "-u", "origin", "main"); git(base, `--git-dir=${bare}`, "update-server-info");
      await new Promise(done => server.listen(0, "127.0.0.1", done));
      await new Promise(done => redirected.listen(0, "127.0.0.1", done));
      const mockRepository = `https://127.0.0.1:${server.address().port}/repository.git`;
      const repository = "https://github.com/alice/repository.git";
      const publicRepository = "https://github.com/alice/public.git";
      const gitExecutable = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
      assert.ok(gitExecutable.startsWith("/"));
      const mockBin = join(base, "bin"); mkdirSync(mockBin, { mode: 0o700 });
      writeFileSync(join(mockBin, "package.json"), '{"type":"commonjs"}\n', { mode: 0o600 });
      writeFileSync(join(mockBin, "git"), `#!${process.execPath}
const {spawnSync}=require("node:child_process");
const result=spawnSync(${JSON.stringify(gitExecutable)},[
  "-c",${JSON.stringify(`url.${mockRepository}.insteadOf=${repository}`)},
  "-c",${JSON.stringify(`url.${mockRepository}.insteadOf=${publicRepository}`)},
  "-c",${JSON.stringify(`http.sslCAInfo=${certificate}`)},...process.argv.slice(2)
],{stdio:"inherit",env:process.env});
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o700 });
      process.env.PATH = `${mockBin}:${saved.get("PATH")}`;
      for (const denied of ["http://github.com/alice/repository.git", "https://github.com.attacker.invalid/alice/repository.git",
        "https://github.com@attacker.invalid/alice/repository.git", "https://github.com:444/alice/repository.git",
        "https://github.com/alice/repository.git?token=x", "https://github.com/alice/%2e%2e/repository.git",
        mockRepository]) assert.throws(() => privateGitHubSubscriptionEndpoint(denied));
      privateGitHubSubscriptionEndpoint(repository);
      privateGitHubSubscriptionEndpoint("https://GITHUB.COM:443/alice/repository");
      const target = normalizeGitHubSyncTarget({ id: "synthetic-target", name: "Synthetic Git",
        repository, branch: "main", authentication: { method: "vscode", expectedLogin: "alice" } });
      const secret = JSON.stringify({ accountLabel: "alice", accessToken: token });
      const credentials = await readStoredGitHubSyncCredentials(async () => secret, target);
      await assert.rejects(readStoredGitHubSyncCredentials(async () => JSON.stringify({ accountLabel: "bob", accessToken: token }), target),
        /does not match/);
      assert.equal(requests, 0);
      const snapshot = async () => {
        const state = await fetchGitHubRemoteSnapshot(target, checkout, true, credentials);
        const selected = state.files.filter(file => file.path.startsWith("skills/"));
        const content = await readGitHubRemoteFilesForSubscription(target, checkout, state.commit, selected, 512 * 1024 * 1024);
        return { commit: state.commit, files: selected.map(file => ({ path: file.path, size: file.size, content: content.get(file.path) })) };
      };
      const first = await snapshot();
      assert.deepEqual(first.files.map(file => file.path), ["skills/Public/One.md"]);
      manager = new SharedMarketManager(profile, join(base, "unused-gateway.js"), "Synthetic local identity");
      manager.dispose();
      const mount = snapshot => manager.mountGitHubBranch({ name: "Synthetic Git", repository, branch: "main",
        commit: snapshot.commit, credentialTargetId: "account-alice", account: "alice",
        selectedPaths: [], selectedFolders: ["skills"], files: snapshot.files }, "Old Skills");
      const original = await mount(first);
      const publicRecord = await manager.mountGitHubBranch({ name: "Synthetic public", repository: publicRepository,
        branch: "main", commit: first.commit, selectedPaths: [], selectedFolders: ["skills"], files: first.files }, "Public Skills");
      writeFileSync(join(work, "skills", "Public", "One.md"), "# Skill version two\n");
      git(work, "add", "."); git(work, "commit", "-m", "second"); git(work, "push"); git(base, `--git-dir=${bare}`, "update-server-info");
      const second = await snapshot();
      assert.notEqual(first.commit, second.commit);
      process.env.PKM_PRIVATE_NATIVE_SUBSCRIPTION = "1";
      await assert.rejects(fetchPrivateGitHubSubscription(base, original, "bob", credentials), /binding denied/);
      const beforeInvalidToken = requests;
      await assert.rejects(fetchPrivateGitHubSubscription(base, original, "alice", { accessToken: "fake\nhost=attacker.invalid" }), /binding denied/);
      assert.equal(requests, beforeInvalidToken);
      const privatePull = await fetchPrivateGitHubSubscription(base, original, "alice", credentials);
      assert.equal(privatePull.commit, second.commit);
      assert.deepEqual(privatePull.files.map(file => file.path), ["skills/Public/One.md"]);
      assert.deepEqual(privatePull.files[0].content, second.files[0].content);
      await prepareLegacyRootAdoptionExperimental(root, {});
      const adopted = await resumeLegacyRootAdoptionExperimental(root, {}); await adopted.storage.close();
      const changeFor = state => ({ action: "github-refresh", publisherNodeId: original.nodeId, shareId: original.shareId,
        subscriptionId: original.id, repository, branch: "main", commit: state.commit, credentialTargetId: "account-alice",
        files: state.files.map(file => ({ path: file.path, size: file.size, sha256: createHash("sha256").update(file.content).digest("hex") })) });
      let third, pendingChange;
      await withCrossProcessLock(join(profile, "subscriptions-state.lock"), "Subscription state mutation", 60_000, async () => {
        manager.stateMutationDepth = 1;
        let host = start(root, profile);
        try {
          await host.ready;
          const admission = await host.request("admit"), change = changeFor(second), operationId = randomUUID();
          assert.equal(admission.ok, true);
          assert.equal((await host.request("prepare", { operationId: randomUUID(), expectedHead: admission.result.fingerprint,
            change: { ...change, credentialTargetId: "account-bob" } })).ok, false);
          assert.equal((await host.request("prepare", { operationId, expectedHead: admission.result.fingerprint, change })).ok, true);
          assert.equal((await host.request("check", { operationId, change: { ...change, commit: first.commit } })).ok, false);
          await host.close(); host = start(root, profile); await host.ready;
          assert.deepEqual((await host.request("status")).result.pending.githubRequest, change);
          const requestCount = requests;
          assert.equal((await host.request("check", { operationId, change })).ok, true);
          assert.equal(requests, requestCount);
          const again = await snapshot();
          assert.equal(again.commit, change.commit);
          await mount(again);
          assert.equal((await host.request("publish", { operationId, change, verifiedPull: false })).ok, false);
          const mounted = join(profile, "cache", original.nodeId, original.shareId, "content", "skills", "Public", "One.md");
          const mountedBytes = readFileSync(mounted);
          writeFileSync(mounted, "# Unknown concurrent change\n", { mode: 0o600 });
          assert.equal((await host.request("publish", { operationId, change, verifiedPull: true })).ok, false);
          writeFileSync(mounted, mountedBytes, { mode: 0o600 });
          const unexpected = join(profile, "cache", original.nodeId, original.shareId, "content", "skills", "unknown");
          mkdirSync(unexpected, { mode: 0o700 });
          assert.equal((await host.request("publish", { operationId, change, verifiedPull: true })).ok, false);
          rmdirSync(unexpected);
          const published = await host.request("publish", { operationId, change, verifiedPull: true });
          assert.equal(published.ok, true, JSON.stringify(published));
          assert.equal((await host.request("status")).result.state.subscriptions[0].source.commit, second.commit);
          assert.equal(existsSync(join(profile, "cache", original.nodeId, original.shareId, "content", "notes")), false);
          writeFileSync(join(work, "skills", "Public", "One.md"), "# Skill version three\n");
          git(work, "add", "."); git(work, "commit", "-m", "third");
          git(work, "-c", "protocol.file.allow=always", "push");
          git(base, `--git-dir=${bare}`, "update-server-info");
          third = await snapshot();
          pendingChange = changeFor(third);
          const canceledOperation = randomUUID(), beforeCancelRequests = requests;
          assert.equal((await host.request("prepare", { operationId: canceledOperation, expectedHead: published.result.head,
            change: pendingChange })).ok, true);
          assert.equal((await host.request("cancel", { operationId: canceledOperation })).ok, true);
          assert.equal(requests, beforeCancelRequests);
          assert.equal((await host.request("prepare", { operationId: randomUUID(), expectedHead: published.result.head,
            change: pendingChange })).ok, true);
        } finally { manager.stateMutationDepth = 0; await host.close(); }
      });
      const runtime = join(base, "runtime"), serverRuntime = join(runtime, "server"), hostRuntime = join(runtime, "host");
      const grantDir = join(base, "u", "User", "globalStorage", "uone.personal-knowledge");
      mkdirSync(join(hostRuntime, "subscriptions"), { recursive: true, mode: 0o700 });
      writeFileSync(join(hostRuntime, "package.json"), '{"type":"commonjs"}\n', { mode: 0o600 });
      symlinkSync(join(legacyRoot, "node_modules"), join(hostRuntime, "node_modules"), "dir");
      mkdirSync(grantDir, { recursive: true, mode: 0o700 });
      cpSync(dist, join(serverRuntime, "dist"), { recursive: true });
      for (const name of ["compat", "browser"]) cpSync(resolve(dist, "..", name), join(serverRuntime, name), { recursive: true });
      symlinkSync(resolve(dist, "..", "node_modules"), join(serverRuntime, "node_modules"), "dir");
      writeFileSync(join(hostRuntime, "subscription-gateway.js"), "", { mode: 0o600 });
      esbuild.buildSync({ stdin: { contents: `require(${JSON.stringify(resolve(legacyRoot, "src/subscriptions/native-membership-coordinator.ts"))})
        .runNativeSubscriptionCoordinator(JSON.parse(process.env.TEST_BINDING))
        .catch(error => { console.error(error.message); process.exitCode = 1; });`, resolveDir: resolve("."), loader: "js" },
        bundle: true, platform: "node", format: "cjs", packages: "external", outfile: join(hostRuntime, "subscriptions", "controller.js") });
      const rootPin = (await import("node:fs")).lstatSync(root, { bigint: true });
      const profilePin = (await import("node:fs")).lstatSync(profile, { bigint: true });
      writeFileSync(join(base, "native-subscription-fixture.json"), JSON.stringify({
        schema: "pkm.native-subscription-ui-fixture/v1", nonce: randomUUID(),
        root: `${rootPin.dev}:${rootPin.ino}`, profile: `${profilePin.dev}:${profilePin.ino}`,
      }), { mode: 0o600 });
      const grant = join(grantDir, "native-subscription-ui.json");
      process.env.PKM_GITHUB_SYNC_TOKEN = token;
      let controller;
      const startController = async () => {
        controller = spawn(process.execPath, [join(hostRuntime, "subscriptions", "controller.js")], {
          env: { ...process.env, PKM_PRIVATE_NATIVE_SUBSCRIPTION: "1", PKM_EXPERIMENTAL_SUBSCRIPTION_HOST: "1",
            TEST_BINDING: JSON.stringify({ fixture: base, root, profile, cli: join(serverRuntime, "dist", "cli.js"),
              gateway: join(hostRuntime, "subscription-gateway.js"), grant }) }, stdio: ["ignore", "pipe", "pipe"] });
        let diagnostics = "";
        controller.stderr.on("data", chunk => { diagnostics += chunk.toString(); });
        await new Promise((done, reject) => {
          let output = "";
          const timer = setTimeout(() => reject(new Error("GitHub coordinator startup timed out.")), 30000);
          controller.once("exit", () => { clearTimeout(timer); reject(new Error(`GitHub coordinator failed: ${diagnostics}`)); });
          controller.stdout.on("data", chunk => {
            output += chunk.toString();
            if (output.includes("\n")) { clearTimeout(timer); done(); }
          });
        });
      };
      try {
        await startController();
        const rpc = async body => {
          const authority = JSON.parse(readFileSync(grant, "utf8"));
          const response = await fetch(`${authority.endpoint}/subscription`, { method: "POST",
            headers: { authorization: `Bearer ${authority.bearer}`, "content-type": "application/json" }, body: JSON.stringify(body) });
          return { status: response.status, ...(await response.json()) };
        };
        const beforeRequests = requests;
        assert.equal((await rpc({ command: "state" })).result.pending.githubRequest.commit, third.commit);
        assert.equal(requests, beforeRequests, "startup must not replay Git");
        const input = { command: "github-refresh", id: original.id, account: "alice",
          credentialTargetId: "account-alice", token, retry: true };
        assert.equal((await rpc({ ...input, account: "bob" })).status, 409);
        assert.equal(requests, beforeRequests);
        const cached = join(profile, "cache", original.nodeId, original.shareId, "content", "skills", "Public", "One.md");
        const admittedBytes = readFileSync(cached);
        writeFileSync(cached, "unrelated concurrent mutation", { mode: 0o600 });
        assert.equal((await rpc(input)).status, 409);
        assert.equal(requests, beforeRequests);
        writeFileSync(cached, admittedBytes, { mode: 0o600 });
        const children = readFileSync(`/proc/${controller.pid}/task/${controller.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
        assert.equal(children.length, 1);
        const killed = new Promise(done => controller.once("exit", done));
        controller.kill("SIGKILL"); await killed;
        for (let attempt = 0; attempt < 200; attempt++) {
          try {
            const stat = readFileSync(`/proc/${children[0]}/stat`, "utf8");
            if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) break;
          } catch (error) { if (error.code === "ENOENT") break; throw error; }
          if (attempt === 199) throw new Error("Orphaned GitHub host did not exit.");
          await new Promise(done => setTimeout(done, 100));
        }
        await startController();
        assert.equal(requests, beforeRequests);
        assert.equal((await rpc({ command: "state" })).result.pending.githubRequest.commit, third.commit);
        redirect = `https://127.0.0.1:${redirected.address().port}/stolen`;
        assert.equal((await rpc(input)).status, 409);
        assert.ok(authenticatedRedirects > 0);
        assert.equal(redirectedRequests, 0, "Git must not follow redirects or disclose credentials");
        assert.equal((await rpc({ command: "state" })).result.pending.githubRequest.commit, third.commit);
        redirect = "";
        await new Promise(done => server.close(done));
        assert.equal((await rpc(input)).status, 409);
        assert.equal((await rpc({ command: "state" })).result.pending.githubRequest.commit, third.commit);
        await new Promise(done => server.listen(new URL(mockRepository).port, "127.0.0.1", done));
        writeFileSync(join(work, "skills", "Public", "One.md"), "# Skill version four\n");
        git(work, "add", "."); git(work, "commit", "-m", "fourth");
        git(work, "-c", "protocol.file.allow=always", "push");
        git(base, `--git-dir=${bare}`, "update-server-info");
        assert.equal((await rpc(input)).status, 409);
        assert.equal((await rpc({ command: "state" })).result.pending.githubRequest.commit, third.commit);
        assert.deepEqual(readFileSync(cached), admittedBytes);
        git(work, "-c", "protocol.file.allow=always", "push", "--force", "origin", `${third.commit}:refs/heads/main`);
        git(base, `--git-dir=${bare}`, "update-server-info");
        const completed = await rpc(input);
        assert.equal(completed.status, 200, JSON.stringify(completed));
        const current = (await rpc({ command: "state" })).result;
        assert.equal(current.pending, null);
        assert.equal(current.state.subscriptions[0].source.commit, third.commit);
        assert.equal(current.subscriptions[0].source.commit, third.commit);
        const afterCommitRequests = requests;
        assert.equal((await rpc(input)).status, 409);
        assert.equal(requests, afterCommitRequests);
        git(work, "-c", "protocol.file.allow=always", "push", "--force", "origin", "HEAD:refs/heads/main");
        git(base, `--git-dir=${bare}`, "update-server-info");
        if (process.env.PKM_TEST_ACTUAL_GITHUB_UI === "1") {
          const targetsDir = join(grantDir, "github-sync");
          mkdirSync(targetsDir, { mode: 0o700 });
          writeFileSync(join(targetsDir, "targets.json"), JSON.stringify({ schema: 1, targets: [{
            id: "account-alice", name: "Synthetic", repository, branch: "main",
            authentication: { method: "vscode", expectedLogin: "alice" },
          }] }), { mode: 0o600 });
          await runInstalledGitHubUi(base, process.env.PKM_TEST_SUBSCRIPTION_VSIX, serverRuntime,
            git(work, "rev-parse", "HEAD"), () => { publicMode = true; });
        } else assert.equal((await rpc({ ...input, retry: false })).status, 200);
        assert.equal((await rpc({ command: "state" })).result.state.subscriptions[0].source.commit, git(work, "rev-parse", "HEAD"));
        publicMode = true;
        const publicInput = { command: "github-refresh", id: publicRecord.id, account: "github", credentialTargetId: null, retry: false };
        const beforePublic = requests;
        assert.equal((await rpc({ ...publicInput, token })).status, 409);
        assert.equal(requests, beforePublic);
        if (process.env.PKM_TEST_ACTUAL_GITHUB_UI !== "1") assert.equal((await rpc(publicInput)).status, 200);
        assert.equal(publicAuthRequests, 0);
        const publicState = (await rpc({ command: "state" })).result.state.subscriptions.find(item => item.id === publicRecord.id);
        assert.equal(publicState.source.commit, git(work, "rev-parse", "HEAD"));
      } finally {
        if (controller.exitCode === null && controller.signalCode === null) {
          const stopped = new Promise(done => controller.once("exit", done));
          controller.kill("SIGTERM"); await stopped;
        }
      }
      for (const name of readdirSync(root).filter(name => name.startsWith("core.sqlite")))
        assert.equal(readFileSync(join(root, name)).includes(Buffer.from(token)), false);
  } finally {
      manager?.dispose();
      await new Promise(done => server.close(done));
      await new Promise(done => redirected.close(done));
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(base, { recursive: true, force: true });
  }
});
      let gateway;
      const stopGateway = async () => {
        if (!gateway || gateway.exitCode !== null) return;
        const stopped = new Promise(done => gateway.once("exit", done));
        gateway.kill("SIGTERM"); await stopped; gateway = undefined;
      };
      const startGateway = async () => {
        gateway = spawn(process.execPath, [join(stage, "subscription-gateway.js"), join(publisherProfile, "gateway-state.json"), "synthetic"],
          { stdio: "ignore" });
        for (let attempt = 0; attempt < 100; attempt++) {
          if (gateway.exitCode !== null) throw new Error("Synthetic gateway exited.");
          try { if ((await fetch("http://127.0.0.1:23002/.well-known/pkm-node")).ok) return; } catch {}
          await new Promise(done => setTimeout(done, 100));
        }
        throw new Error("Synthetic local gateway did not become ready.");
      };
      try {
        legacy.setRoot(publisherRoot);
        await publisher.configure({ enabled: false, port: 23010, advertisedHost: "127.0.0.1", displayName: "Synthetic publisher" });
        const subscriberId = subscriber.snapshot.nodeId;
        assert.notEqual(publisher.snapshot.nodeId, subscriberId);
        const share = await publisher.upsertShare({ name: "Synthetic protected", protection: "secret-protected", secret,
          contentTypes: ["notes"], selected: { notes: ["Shared"] }, controlPort: 23002,
          accountMode: "white-list", accountRules: [subscriberId] });
        const magicLink = publisher.magicLink(share.shareId), brokerSecret = await publisher.shareSecret(share.shareId);
        const link = legacy.parseShareMagicLink(magicLink);
        const salt = /^pkms:v1:\d+:([A-Za-z0-9_-]+):/.exec(brokerSecret)[1];
        const change = { action: "add", publisherNodeId: link.nodeId, shareId: link.shareId,
          magicLink, alias: "synthetic remote", endpoint: "http://127.0.0.1:23002", secretSalt: salt };
        await prepareLegacyRootAdoptionExperimental(root, {});
        const adopted = await resumeLegacyRootAdoptionExperimental(root, {}); await adopted.storage.close();
        await startGateway();
        await subscriber.withStateMutation(async () => {
          let host = start(root, profile, true);
          try {
            await host.ready;
            const admission = await host.request("admit"), operationId = randomUUID();
            assert.equal(admission.ok, true);
            assert.equal((await host.read("subscription.list")).result.total, 0);
            assert.equal((await host.request("prepare", { operationId, expectedHead: admission.result.fingerprint, change })).ok, true);
            assert.equal((await host.read("subscription.list")).error.code, "RECOVERY_REQUIRED");
            assert.equal((await host.request("check", { operationId, change })).result.targetExists, false);
            await stopGateway();
            await assert.rejects(legacy.withAuthenticatedSubscriptionPull(subscriber,
              { nodeId: link.nodeId, shareId: link.shareId }, () => subscriber.subscribe(magicLink, change.alias, brokerSecret)));
            await host.close();
            host = start(root, profile, true); await host.ready;
            assert.equal((await host.request("status")).result.pending.operationId, operationId);
            assert.equal((await host.request("cancel", { operationId })).ok, false);
            assert.equal((await host.request("check", { operationId, change })).result.targetExists, true);
            await startGateway();
            const record = await legacy.withAuthenticatedSubscriptionPull(subscriber,
              { nodeId: link.nodeId, shareId: link.shareId }, () => subscriber.subscribe(magicLink, change.alias, brokerSecret));
            const published = await host.request("publish", { operationId, change, verifiedPull: true });
            assert.equal(published.ok, true);
            assert.equal((await host.request("status")).result.state.subscriptions[0].id, record.id);
            const list = (await host.read("subscription.list")).result;
            assert.equal(list.total, 1);
            assert.equal(list.items[0].id, record.id);
            assert.equal((await host.read("subscription.get", { id: record.id })).result.subscription.id, record.id);
            const remove = { action: "remove", publisherNodeId: link.nodeId, shareId: link.shareId, subscriptionId: record.id };
            const removeId = randomUUID();
            assert.equal((await host.request("prepare", { operationId: removeId, expectedHead: published.result.head, change: remove })).ok, true);
            assert.equal((await host.request("check", { operationId: removeId, change: remove })).result.targetExists, true);
            subscriber.removeSubscription(record.id);
            rmdirSync(join(profile, "cache", link.nodeId));
            const removed = await host.request("publish", { operationId: removeId, change: remove, verifiedPull: false });
            assert.equal(removed.ok, true);
            await host.close();
            host = start(root, profile, true); await host.ready;
            const status = await host.request("status");
            assert.equal(status.result.head, removed.result.head);
            assert.equal(status.result.state.subscriptions.length, 0);
            assert.equal(status.result.pending, null);
            assert.equal((await host.read("subscription.list")).result.total, 0);
            assert.equal((await host.read("subscription.get", { id: record.id })).error.code, "NOT_FOUND");
            await host.close();
            const db = new DatabaseSync(join(root, "core.sqlite"));
            try {
              db.exec("DROP TRIGGER native_subscription_generation_files_no_update");
              const row = db.prepare("SELECT fingerprint,path FROM native_subscription_generation_files LIMIT 1").get();
              assert.ok(row);
              db.prepare("UPDATE native_subscription_generation_files SET bytes=? WHERE fingerprint=? AND path=?")
                .run(Buffer.from("synthetic corruption"), row.fingerprint, row.path);
            } finally { db.close(); }
            host = start(root, profile, true); await host.ready;
            assert.equal((await host.read("subscription.list")).error.code, "IMPORT_RECEIPT_INVALID");
          } finally { await host.close(); }
        });
        for (const name of readdirSync(root).filter(name => name.startsWith("core.sqlite")))
          assert.equal(readFileSync(join(root, name)).includes(Buffer.from(secret)), false);
      } finally {
        await stopGateway(); subscriber.dispose(); publisher.dispose();
        if (oldEnv === undefined) delete process.env.PKM_EXPERIMENTAL_SUBSCRIPTION_HOST;
        else process.env.PKM_EXPERIMENTAL_SUBSCRIPTION_HOST = oldEnv;
        rmSync(base, { recursive: true, force: true });
      }
    });
