"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const ts = require("typescript");

test("status-only native intent binds real adopted owner, and restart does not revive revoked consent", { timeout: 60_000 }, async t => {
  const dist = process.env.PKM_TEST_NEXT_DIST;
  assert(dist && path.isAbsolute(dist));
  const load = name => import(pathToFileURL(path.join(dist, `${name}.js`)).href);
  const { prepareLegacyRootAdoptionExperimental, resumeLegacyRootAdoptionExperimental,
    legacyRootAdoptionLockDirectory } = await load("legacy-root-adoption");
  const { startAdoptedRootUnifiedHost } = await load("managed-client-host");
  const { legacyKnowledgeWrite } = await load("legacy-knowledge-write");
  const { assertLegacyKnowledgeSnapshotHost } = await load("legacy-knowledge-snapshots");
  const base = path.resolve(".migration-test-work", `snapshot-vscode-owner-${randomUUID()}`);
  const root = path.join(base, "root"), profile = path.join(base, "profile"), config = path.join(base, "host.json");
  const source = process.env.PKM_REAL_LEGACY_ROOT_SOURCE;
  if (source) {
    assert(path.isAbsolute(source));
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    fs.cpSync(source, root, { recursive: true, errorOnExist: true, preserveTimestamps: true });
    console.log("ISOLATED_ORIGINAL_COPY", root);
  } else {
    fs.mkdirSync(path.join(root, "notes"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(root, ".pkm"), { mode: 0o700 });
    fs.writeFileSync(path.join(root, ".pkm/content-privacy.json"),
      '{"schema":1,"private":{"notes":["private"]}}', { mode: 0o600 });
    fs.writeFileSync(path.join(root, "notes/Existing.md"),
      "---\ntitle: Existing\ndocumentId: synthetic-note\nrevision: 1\n---\nOriginal synthetic content.\n", { mode: 0o600 });
  }
  fs.mkdirSync(profile, { mode: 0o700 });
  const privacyBefore = fs.readFileSync(path.join(root, ".pkm/content-privacy.json"));
  const endpoint = "http://127.0.0.1:9/v1";
  fs.writeFileSync(config, JSON.stringify({ schema: "pkm.native-host-config/v1", provider: "openai-compatible",
    endpoint, secretRef: "secret:fixture/model", model: "fixture", contextWindow: 16384, maxOutputTokens: 4096,
    outputTokenParameter: "max_tokens", includeUsage: true, tools: ["knowledge.document.list"] }), { mode: 0o600 });
  t.after(() => {
    if (source) return;
    fs.rmSync(base, { recursive: true, force: true });
    const locks = legacyRootAdoptionLockDirectory(root);
    const prefix = createHash("sha256").update(root).digest("hex").slice(0, 40);
    for (const suffix of [".sqlite", ".writer.lock", ".writer-fenced.json"]) fs.rmSync(path.join(locks, prefix + suffix), { force: true });
    try { fs.rmdirSync(locks); } catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; }
  });
  await assert.rejects(prepareLegacyRootAdoptionExperimental(root, {}), { code: "SNAPSHOT_HOST_AUTHORITY_REQUIRED" });
  let expectedWorkspace;
  const event = () => ({ dispose() {} }), vscode = {
    workspace: { isTrusted: true, onDidChangeWorkspaceFolders: event, onDidChangeConfiguration: event },
    window: { showWarningMessage: async () => "Allow Selected Snapshot Operations" },
  };
  const js = ts.transpileModule(fs.readFileSync("src/runtime/legacy-snapshot-vscode-authority.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", js)(name =>
    name === "vscode" ? vscode : name === "../knowledge/filestore" ? { getStorePath: () => root } : require(name), mod, mod.exports);
  const context = { subscriptions: [], globalStorageUri: { fsPath: profile }, secrets: { onDidChange: event } };
  const hostSignal = new AbortController();
  const host = { root, sessionId: randomUUID(), signal: hostSignal.signal, assertCurrent(binding) {
    assert.equal(binding.root, root); assert.equal(binding.profile, profile);
    if (binding.snapshot) assert.equal(binding.snapshot.workspaceId, expectedWorkspace);
  } };
  const authority = await mod.exports.requestLegacySnapshotVscodeAuthority(context, {
    host, allowedTools: ["knowledge_snapshot_status"],
  });
  t.after(() => authority.dispose());
  mod.exports.assertLegacySnapshotVscodeAuthority(authority, context, host);
  const snapshotAdmission = { authorityId: authority.authorityId,
    allowedTools: authority.allowedTools, authorize: authority.authorize };
  const prepared = await prepareLegacyRootAdoptionExperimental(root, { snapshotAdmission });
  expectedWorkspace = prepared.workspaceId;
  const adoption = await resumeLegacyRootAdoptionExperimental(root, { snapshotAdmission });
  let managed;
  try {
    const unified = await startAdoptedRootUnifiedHost({ optIn: true, dataPath: root, configPath: config,
      expectedWorkspaceId: adoption.workspaceId, policy: { authorizedConfigPath: config,
        allowedProviders: ["openai-compatible"], allowedEndpoints: [endpoint], allowedModels: ["fixture"],
        allowedTools: ["knowledge.document.list"], allowInsecureLoopback: true }, resolveSecret: async () => "fixture" }, adoption);
    managed = unified.managed;
    const result = await unified.ownerResourceContext().storage.request({
      operation: "knowledge.note.get", args: { id: source ? "Existing" : "synthetic-note" }, actorId: "local:owner",
    });
    assert.match(result.item.content, source ? /Original isolated Root/ : /Original synthetic content/);
    const written = await legacyKnowledgeWrite(unified.ownerResourceContext().core, unified.ownerResourceContext().storage,
      { id: "local:owner", canWrite: true }, {
        tool: "update_note", arguments: { slug: "Existing", content: "Updated by isolated adopted owner.\n" },
      });
    assert.deepEqual(JSON.parse(written.text), { ok: true, slug: "Existing" });
    const stat = fs.statSync(root, { bigint: true });
    const binding = { workspaceId: prepared.workspaceId, workspaceRoot: root, actorId: "mcp:external",
      authorityId: authority.authorityId, privateGitRoot: path.join(root, "packages/knowledge-snapshots/repository.git"),
      rootPin: `${stat.dev}:${stat.ino}`, allowedTools: ["knowledge_snapshot_status"], operation: "knowledge_snapshot_status" };
    assert.equal(authority.authorize(binding), true);
    const snapshotActor = { id: "mcp:external", canWrite: true };
    const verify = (storage, issuer, operation) => {
      const database = storage.connectNative();
      try { return assertLegacyKnowledgeSnapshotHost(storage, database, snapshotActor, issuer, operation); }
      finally { database.close(); }
    };
    assert.doesNotThrow(() => verify(unified.ownerResourceContext().storage, authority, "knowledge_snapshot_status"));
    assert.throws(() => verify(unified.ownerResourceContext().storage, authority, "knowledge_snapshot_create"), { code: "ACCESS_DENIED" });
    hostSignal.abort();
    assert.equal(authority.authorize(binding), false);
    assert.throws(() => verify(unified.ownerResourceContext().storage, authority, "knowledge_snapshot_status"), { code: "ACCESS_DENIED" });
    await managed.close(); managed = undefined;
    const reopened = await resumeLegacyRootAdoptionExperimental(root, { snapshotAdmission });
    try {
      assert.equal(reopened.workspaceId, prepared.workspaceId);
      assert.equal(authority.authorize(binding), false);
      assert.throws(() => verify(reopened.storage, authority, "knowledge_snapshot_status"), { code: "ACCESS_DENIED" });
      const after = await reopened.storage.request({
        operation: "knowledge.note.get", args: { id: source ? "Existing" : "synthetic-note" }, actorId: "local:owner",
      });
      assert.match(after.item.content, /Updated by isolated adopted owner/);
      const newHost = { ...host, sessionId: randomUUID(), signal: new AbortController().signal };
      const renewed = await mod.exports.requestLegacySnapshotVscodeAuthority(context, {
        host: newHost, allowedTools: ["knowledge_snapshot_status"], recoveryAuthorityId: authority.authorityId,
      });
      try { assert.doesNotThrow(() => verify(reopened.storage, renewed, "knowledge_snapshot_status")); }
      finally { renewed.dispose(); }
    } finally { await reopened.storage.close(); }
    assert.deepEqual(fs.readFileSync(path.join(root, ".pkm/content-privacy.json")), privacyBefore);
  } finally { if (managed) await managed.close(); }
});
