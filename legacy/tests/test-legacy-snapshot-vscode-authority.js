"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const ts = require("typescript");

function fixture(t) {
  const base = path.resolve(".migration-test-work", `snapshot-vscode-authority-${randomUUID()}`);
  const root = path.join(base, "root"), profile = path.join(base, "profile");
  fs.mkdirSync(path.join(root, ".pkm"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(profile, { mode: 0o700 });
  const privacy = path.join(root, ".pkm/content-privacy.json");
  fs.writeFileSync(privacy, '{"schema":1,"private":{"notes":["private"]}}', { mode: 0o600 });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const subscriptions = [], listeners = { config: [], folders: [], secrets: [] };
  const event = name => callback => {
    listeners[name].push(callback);
    return { dispose() { const i = listeners[name].indexOf(callback); if (i >= 0) listeners[name].splice(i, 1); } };
  };
  let prompt = async () => "Allow Selected Snapshot Operations";
  const vscode = {
    workspace: { isTrusted: true, onDidChangeWorkspaceFolders: event("folders"), onDidChangeConfiguration: event("config") },
    window: { showWarningMessage: (...args) => prompt(...args) },
  };
  const js = ts.transpileModule(fs.readFileSync("src/runtime/legacy-snapshot-vscode-authority.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", js)(name =>
    name === "vscode" ? vscode : name === "../knowledge/filestore" ? { getStorePath: () => root } : require(name), module, module.exports);
  const context = { subscriptions, globalStorageUri: { fsPath: profile }, secrets: { onDidChange: event("secrets") } };
  const hostSignal = new AbortController(), workspaceId = randomUUID(), sessionId = randomUUID();
  let current = true;
  function assertCurrent(binding) {
    if (!current || binding.root !== root || binding.profile !== profile || binding.sessionId !== sessionId
      || binding.snapshot && binding.snapshot.workspaceId !== workspaceId) throw new Error("Host is stale.");
  }
  const host = { root, sessionId, signal: hostSignal.signal, assertCurrent };
  const binding = authority => ({ workspaceId, workspaceRoot: root, actorId: "mcp:external", authorityId: authority.authorityId,
    privateGitRoot: path.join(root, "packages/knowledge-snapshots/repository.git"), allowedTools: [...authority.allowedTools],
    operation: "admit" });
  return { ...module.exports, root, profile, privacy, context, vscode, host, hostSignal, workspaceId, binding, listeners,
    prompt(value) { prompt = value; }, invalidate() { current = false; } };
}

test("native confirmation creates only exact branded status authority, not mutation or recovery authority", async t => {
  const f = fixture(t);
  let promptDetails;
  f.prompt(async (message, options) => { promptDetails = `${message} ${options.detail}`; return "Allow Selected Snapshot Operations"; });
  const authority = await f.requestLegacySnapshotVscodeAuthority(f.context, {
    host: f.host, allowedTools: ["knowledge_snapshot_status"],
  });
  t.after(() => authority.dispose());
  assert.match(promptDetails, /does not authorize snapshot creation, restoration, interrupted snapshot recovery/i);
  f.assertLegacySnapshotVscodeAuthority(authority, f.context, f.host);
  assert.throws(() => f.assertLegacySnapshotVscodeAuthority({ ...authority }, f.context, f.host), /does not belong/);
  const selected = f.binding(authority);
  assert.equal(authority.authorize(selected), true);
  assert.equal(authority.authorize({ ...selected, operation: "knowledge_snapshot_status" }), false);
  const stat = fs.statSync(f.root, { bigint: true }), rootPin = `${stat.dev}:${stat.ino}`;
  assert.equal(authority.authorize({ ...selected, operation: "knowledge_snapshot_status", rootPin }), true);
  assert.equal(authority.authorize({ ...selected, operation: "knowledge_snapshot_create", rootPin }), false);
  assert.equal(authority.authorize({ ...selected, operation: "reconcile", rootPin }), false);
  assert.equal(authority.authorize({ ...selected, workspaceId: randomUUID(), rootPin }), false);
  assert.equal(authority.authorize({ ...selected, actorId: "local:owner", rootPin }), false);
  assert.equal(authority.authorize({ ...selected, allowedTools: ["knowledge_snapshot_status", "knowledge_snapshot_create"] }), false);
  await assert.rejects(f.requestLegacySnapshotVscodeAuthority(f.context, {
    host: f.host, allowedTools: ["knowledge_snapshot_create"],
  }), /exact snapshot scope/);
});

test("cancellation, trust loss and asynchronous host fences cannot issue authority", async t => {
  const f = fixture(t);
  f.prompt(async () => undefined);
  assert.equal(await f.requestLegacySnapshotVscodeAuthority(f.context, {
    host: f.host, allowedTools: ["knowledge_snapshot_status"],
  }), undefined);
  f.vscode.workspace.isTrusted = false;
  const savedPrivacy = `${f.privacy}-saved`;
  fs.renameSync(f.privacy, savedPrivacy); fs.symlinkSync(savedPrivacy, f.privacy);
  await assert.rejects(f.requestLegacySnapshotVscodeAuthority(f.context, {
    host: f.host, allowedTools: ["knowledge_snapshot_status"],
  }), /revoked/);
  fs.unlinkSync(f.privacy); fs.renameSync(savedPrivacy, f.privacy);
  f.vscode.workspace.isTrusted = true;
  await assert.rejects(f.requestLegacySnapshotVscodeAuthority(f.context, {
    host: { ...f.host, assertCurrent: async () => {} }, allowedTools: ["knowledge_snapshot_status"],
  }), /synchronously/);
});

test("changed privacy, host and secret events revoke approval, including during a pending modal", async t => {
  const f = fixture(t);
  const authority = await f.requestLegacySnapshotVscodeAuthority(f.context, {
    host: f.host, allowedTools: ["knowledge_snapshot_status"],
  });
  f.listeners.secrets[0]();
  assert.equal(authority.signal.aborted, true);
  assert.equal(authority.authorize(f.binding(authority)), false);
  assert.throws(() => f.assertLegacySnapshotVscodeAuthority(authority, f.context, f.host), /does not belong/);
  f.prompt(() => new Promise(() => {}));
  const pending = f.requestLegacySnapshotVscodeAuthority(f.context, { host: f.host, allowedTools: ["knowledge_snapshot_status"] });
  fs.writeFileSync(f.privacy, '{"schema":1,"private":{}}');
  const keepAlive = setTimeout(() => {}, 2_500);
  try { await assert.rejects(pending, /revoked/); } finally { clearTimeout(keepAlive); }
  assert.equal(f.context.subscriptions.length, 0);
});

test("the approved object remains bound to its original host callback and profile identity", async t => {
  const f = fixture(t), authority = await f.requestLegacySnapshotVscodeAuthority(f.context, {
    host: f.host, allowedTools: ["knowledge_snapshot_status"],
  });
  assert.throws(() => f.assertLegacySnapshotVscodeAuthority(authority, f.context, { ...f.host, assertCurrent() {} }),
    /does not belong/);
  fs.renameSync(f.profile, `${f.profile}-previous`); fs.mkdirSync(f.profile, { mode: 0o700 });
  assert.equal(authority.authorize(f.binding(authority)), false);
  assert.equal(authority.signal.aborted, true);
});

test("privacy substitution and untrusted host identity cannot become snapshot approval", async t => {
  const f = fixture(t);
  f.invalidate();
  await assert.rejects(f.requestLegacySnapshotVscodeAuthority(f.context, {
    host: f.host, allowedTools: ["knowledge_snapshot_status"],
  }), /stale/);
  const target = `${f.privacy}-target`;
  fs.renameSync(f.privacy, target); fs.symlinkSync(target, f.privacy);
  await assert.rejects(f.requestLegacySnapshotVscodeAuthority(f.context, {
    host: f.host, allowedTools: ["knowledge_snapshot_status"],
  }), /unsafe/);
});

test("replacing privacy policy with identical bytes revokes the existing approval", async t => {
  const f = fixture(t);
  const authority = await f.requestLegacySnapshotVscodeAuthority(f.context, {
    host: f.host, allowedTools: ["knowledge_snapshot_status"],
  });
  const bytes = fs.readFileSync(f.privacy);
  fs.renameSync(f.privacy, `${f.privacy}-previous`);
  fs.writeFileSync(f.privacy, bytes, { mode: 0o600 });
  assert.equal(authority.authorize(f.binding(authority)), false);
  assert.equal(authority.signal.aborted, true);
});

test("rewriting an unchanged privacy policy revokes the existing approval", async t => {
  const f = fixture(t);
  const authority = await f.requestLegacySnapshotVscodeAuthority(f.context, {
    host: f.host, allowedTools: ["knowledge_snapshot_status"],
  });
  const bytes = fs.readFileSync(f.privacy);
  fs.writeFileSync(f.privacy, bytes);
  assert.equal(authority.authorize(f.binding(authority)), false);
  assert.equal(authority.signal.aborted, true);
});

test("replacing the privacy directory revokes approval even when the file inode is retained", async t => {
  const f = fixture(t);
  const authority = await f.requestLegacySnapshotVscodeAuthority(f.context, {
    host: f.host, allowedTools: ["knowledge_snapshot_status"],
  });
  const previous = path.join(f.root, ".pkm-previous"), current = path.dirname(f.privacy);
  fs.renameSync(current, previous);
  fs.mkdirSync(current, { mode: 0o700 });
  fs.renameSync(path.join(previous, "content-privacy.json"), f.privacy);
  assert.equal(authority.authorize(f.binding(authority)), false);
  assert.equal(authority.signal.aborted, true);
});

test("profile and Knowledge Root must not contain one another", async t => {
  const f = fixture(t);
  const profile = path.dirname(f.root);
  await assert.rejects(f.requestLegacySnapshotVscodeAuthority({
    ...f.context, globalStorageUri: { fsPath: profile },
  }, { host: f.host, allowedTools: ["knowledge_snapshot_status"] }), /separate/);
});
