"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { test } = require("node:test");
const esbuild = require("esbuild");

test("private native UI registers the original panel and never replays pending actions on open", async () => {
  const fixture = path.resolve(".migration-test-work", `pkm-native-subscription-ui-${randomUUID()}`);
  const root = path.join(fixture, "root"), profile = path.join(fixture, "profile");
  const global = path.join(fixture, "u", "User", "globalStorage", "uone.personal-knowledge");
  for (const dir of [root, profile, global]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(root, { bigint: true }), profileStat = fs.lstatSync(profile, { bigint: true });
  const grant = path.join(global, "native-subscription-ui.json");
  const processStat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  fs.writeFileSync(grant, JSON.stringify({ schema: "pkm.native-subscription-ui/v1", nonce: randomUUID(), fixture, root, profile,
    rootPin: `${rootStat.dev}:${rootStat.ino}`, profilePin: `${profileStat.dev}:${profileStat.ino}`,
    endpoint: "http://127.0.0.1:12345", bearer: "a".repeat(43), ownerPid: process.pid,
    ownerStart: processStat.slice(processStat.lastIndexOf(")") + 2).trim().split(/\s+/)[19],
    pidNamespace: fs.readlinkSync("/proc/self/ns/pid") }), { mode: 0o600 });
  const commands = new Map(), posts = [], calls = [], values = new Map(), warnings = [];
  let handler, html, pendingAction = "priority", denyRefresh = false, github = false;
  let githubRepository = "https://github.com/alice/repository.git", githubTarget = "account-alice", secretReads = 0;
  const view = { webview: { set html(value) { html = value; }, onDidReceiveMessage(cb) { handler = cb; },
    async postMessage(value) { posts.push(value); } }, onDidDispose() {}, reveal() {}, dispose() {} };
  const vscode = { Uri: { file: fsPath => ({ fsPath }), joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
    ViewColumn: { One: 1 }, window: { createWebviewPanel: () => view, async showWarningMessage(value) { warnings.push(value); } },
    commands: { registerCommand(name, cb) { commands.set(name, cb); return { dispose() {} }; } } };
  const filename = path.resolve("src/subscriptions/native-membership-ui.ts");
  const compiled = esbuild.buildSync({ entryPoints: [filename], bundle: true, platform: "node", format: "cjs",
    packages: "external", write: false }).outputFiles[0].text;
  const loaded = new Module(filename, require.main);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalLoad = Module._load, originalFetch = globalThis.fetch;
  const oldGate = process.env.PKM_PRIVATE_NATIVE_SUBSCRIPTION, oldGrant = process.env.PKM_PRIVATE_NATIVE_SUBSCRIPTION_GRANT;
  try {
    Module._load = function(request, ...args) { return request === "vscode" ? vscode : originalLoad.call(this, request, ...args); };
    loaded._compile(compiled, filename); Module._load = originalLoad;
    process.env.PKM_PRIVATE_NATIVE_SUBSCRIPTION = "1"; process.env.PKM_PRIVATE_NATIVE_SUBSCRIPTION_GRANT = grant;
    globalThis.fetch = async (_url, input) => {
      const request = JSON.parse(input.body); calls.push(request);
      if (request.command === "state") return new Response(JSON.stringify({ result: {
        state: { nodeId: "a".repeat(64), shares: [], subscriptions: [{ id: "old", nodeId: "b".repeat(64), shareId: "share", secretProtected: true,
          ...(github ? { publisherUser: "alice", source: { type: "github", repository: githubRepository, credentialTargetId: githubTarget } } : {}) }] },
        subscriptions: [{ id: "old", alias: "Original membership" }],
        pending: { action: pendingAction, operationId: "synthetic", publisherNodeId: "b".repeat(64), shareId: "share", subscriptionId: "old" },
        recoveryBlocked: true,
      } }), { status: 200 });
      if (request.command === "priority") pendingAction = "remove";
      if (request.command === "inspect-recovery") return new Response(JSON.stringify({ result: {
        action: "refresh", operationId: "synthetic", nodeId: "b".repeat(64), shareId: "share",
        entries: [".share.0123456789.staging"], canRetry: calls.some(value => value.command === "recheck-recovery"),
      } }), { status: 200 });
      if (request.command === "recheck-recovery") return new Response(JSON.stringify({ result: { canRetry: true } }), { status: 200 });
      if (request.command === "refresh" && denyRefresh)
        return new Response(JSON.stringify({ error: "failed", code: "BROKER_FORBIDDEN" }), { status: 409 });
      return new Response(JSON.stringify({ result: { completed: true } }), { status: 200 });
    };
    const context = { extensionPath: fixture, extensionUri: { fsPath: fixture }, globalStorageUri: { fsPath: global }, subscriptions: [],
      secrets: { async get(key) { secretReads++; return values.get(key); }, async store(key, value) { values.set(key, value); },
        async delete(key) { values.delete(key); } } };
    delete process.env.PKM_PRIVATE_NATIVE_SUBSCRIPTION_GRANT;
    assert.throws(() => loaded.exports.activateNativeSubscriptionUi(context, () => root, () => ""), /requires its controller grant/);
    process.env.PKM_PRIVATE_NATIVE_SUBSCRIPTION_GRANT = grant;
    assert.throws(() => loaded.exports.activateNativeSubscriptionUi(context, () => profile, () => ""), /fixture binding denied/);
    assert.equal(loaded.exports.activateNativeSubscriptionUi(context, () => root, (_view, currentRoot) => `original-panel:${currentRoot}`), true);
    commands.get("personalKnowledge.openSubscriptions")();
    assert.equal(html, `original-panel:${root}`);
    handler({ command: "ready" });
    for (let attempt = 0; attempt < 100 && !posts.some(value => value.command === "subscriptionState"); attempt++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls.filter(value => value.command !== "state").length, 0);
    assert.match(warnings[0], /Preserve the profile and cached data/);
    assert.equal(posts.find(value => value.command === "subscriptionState").data.subscriptions[0].alias, "Original membership");
    handler({ command: "subscriptionSetPriority", id: "old", priority: "highest" });
    for (let attempt = 0; attempt < 100 && !calls.some(value => value.command === "priority"); attempt++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(calls.find(value => value.command === "priority"), { command: "priority", id: "old", priority: "highest", retry: true });
    handler({ command: "subscriptionRemove", id: "old" });
    for (let attempt = 0; attempt < 100 && !calls.some(value => value.command === "remove"); attempt++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(calls.find(value => value.command === "remove"), { command: "remove", id: "old", retry: true });
    pendingAction = "rename";
    handler({ command: "subscriptionRename", id: "old", alias: "Renamed" });
    for (let attempt = 0; attempt < 100 && !calls.some(value => value.command === "rename"); attempt++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(calls.find(value => value.command === "rename"), { command: "rename", id: "old", alias: "Renamed", retry: true });
    pendingAction = "refresh";
    handler({ command: "subscriptionRefresh", id: "old", force: true });
    for (let attempt = 0; attempt < 100 && !posts.some(value => value.command === "subscriptionError"); attempt++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls.some(value => value.command === "refresh"), false);
    values.set(`personalKnowledge.subscription.${"b".repeat(64)}.share.secret`, "synthetic-material-1234567890");
    handler({ command: "subscriptionRefresh", id: "old", force: true });
    for (let attempt = 0; attempt < 100 && !calls.some(value => value.command === "refresh"); attempt++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(calls.find(value => value.command === "refresh"),
      { command: "refresh", id: "old", material: "synthetic-material-1234567890", retry: true });
    denyRefresh = true;
    handler({ command: "subscriptionRefresh", id: "old", force: true });
    for (let attempt = 0; attempt < 100 && !posts.some(value => value.command === "subscriptionError" && value.data.error.includes("(403)")); attempt++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(posts.some(value => value.command === "subscriptionError" && value.data.error.includes("(403)")));
    assert.equal(posts.at(-2).command, "subscriptionState");
    assert.equal(posts.at(-1).command, "subscriptionError");
    const refreshCalls = calls.filter(value => value.command === "github-refresh").length;
    github = true;
    const targetsDirectory = path.join(global, "github-sync");
    fs.mkdirSync(targetsDirectory, { mode: 0o700 });
    fs.writeFileSync(path.join(targetsDirectory, "targets.json"), JSON.stringify({ schema: 1, targets: [{
      id: "account-alice", name: "Synthetic", repository: "https://github.com/alice/repository.git", branch: "main",
      authentication: { method: "vscode", expectedLogin: "alice" },
    }] }), { mode: 0o600 });
    values.set("personalKnowledge.githubSync.vscode.account-alice", JSON.stringify({ accountLabel: "bob", accessToken: "wrong" }));
    handler({ command: "subscriptionRefresh", id: "old", force: true });
    for (let attempt = 0; attempt < 100 && !posts.some(value => value.command === "subscriptionError" && value.data.error.includes("does not match")); attempt++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(posts.some(value => value.command === "subscriptionError" && value.data.error.includes("does not match")));
    assert.equal(calls.filter(value => value.command === "github-refresh").length, refreshCalls);
    values.set("personalKnowledge.githubSync.vscode.account-alice", JSON.stringify({ accountLabel: "alice", accessToken: "synthetic-github-token" }));
    githubRepository = "https://github.com.attacker.invalid/alice/repository.git";
    const readsBeforeUntrusted = secretReads;
    handler({ command: "subscriptionRefresh", id: "old", force: true });
    for (let attempt = 0; attempt < 100 && !posts.some(value => value.command === "subscriptionError" && value.data.error.includes("endpoint denied")); attempt++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(posts.some(value => value.command === "subscriptionError" && value.data.error.includes("endpoint denied")));
    assert.equal(secretReads, readsBeforeUntrusted);
    assert.equal(calls.filter(value => value.command === "github-refresh").length, refreshCalls);
    githubRepository = "https://github.com/alice/repository.git";
    handler({ command: "subscriptionRefresh", id: "old", force: true });
    for (let attempt = 0; attempt < 100 && !calls.some(value => value.command === "github-refresh"); attempt++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(calls.find(value => value.command === "github-refresh"), { command: "github-refresh", id: "old",
      account: "alice", credentialTargetId: "account-alice", token: "synthetic-github-token", retry: true });
    githubTarget = undefined;
    const readsBeforePublic = secretReads;
    handler({ command: "subscriptionRefresh", id: "old", force: true });
    for (let attempt = 0; attempt < 100 && !calls.some(value => value.command === "github-refresh" && value.credentialTargetId === null); attempt++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(calls.find(value => value.command === "github-refresh" && value.credentialTargetId === null),
      { command: "github-refresh", id: "old", account: "alice", credentialTargetId: null, retry: true });
    assert.equal(secretReads, readsBeforePublic);
    handler({ command: "subscriptionReviewRecovery" });
    for (let attempt = 0; attempt < 100 && !posts.some(value => value.command === "subscriptionState" && value.data.nativeRecovery?.inspection); attempt++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(posts.some(value => value.command === "subscriptionState"
      && value.data.nativeRecovery?.inspection?.entries.includes(".share.0123456789.staging")));
    handler({ command: "subscriptionRecheckRecovery" });
    for (let attempt = 0; attempt < 100 && !posts.some(value => value.command === "subscriptionState" && value.data.nativeRecovery?.inspection?.rechecked); attempt++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(posts.some(value => value.command === "subscriptionState" && value.data.nativeRecovery?.inspection?.canRetry));
  } finally {
    Module._load = originalLoad; globalThis.fetch = originalFetch;
    if (oldGate === undefined) delete process.env.PKM_PRIVATE_NATIVE_SUBSCRIPTION; else process.env.PKM_PRIVATE_NATIVE_SUBSCRIPTION = oldGate;
    if (oldGrant === undefined) delete process.env.PKM_PRIVATE_NATIVE_SUBSCRIPTION_GRANT; else process.env.PKM_PRIVATE_NATIVE_SUBSCRIPTION_GRANT = oldGrant;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
