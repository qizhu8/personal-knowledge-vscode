"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const ts = require("typescript");

test("native snapshot issuer requires its actual drained, confirmed and rotated managed host", {
  timeout: 30000, skip: process.platform !== "linux",
}, async t => {
  const dist = process.env.PKM_TEST_DIST || path.resolve("dist");
  const session = require(path.join(dist, "runtime/managed-writer-session"));
  const { HostWriterAdmission } = require(path.join(dist, "runtime/host-writer-admission"));
  const { activateManagedProfileWriter } = require(path.join(dist, "runtime/managed-profile-activation"));
  const base = path.resolve(".migration-test-work", `managed-snapshot-host-${randomUUID()}`);
  const root = path.join(base, "root"), storage = path.join(base, "profile");
  fs.mkdirSync(path.join(root, ".pkm"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(storage, { mode: 0o700 });
  fs.writeFileSync(path.join(root, ".pkm/content-privacy.json"),
    '{"schema":1,"private":{"notes":["private"]}}', { mode: 0o600 });
  const id = randomUUID(), profileUri = `file://${storage}`;
  const oldEnvironment = process.env.PKM_MANAGED_WRITER_SESSION;
  process.env.PKM_MANAGED_WRITER_SESSION = id;
  t.after(() => {
    if (oldEnvironment === undefined) delete process.env.PKM_MANAGED_WRITER_SESSION;
    else process.env.PKM_MANAGED_WRITER_SESSION = oldEnvironment;
    fs.rmSync(base, { recursive: true, force: true });
  });
  session.provisionManagedWriterSession(root, id);
  const owner = new HostWriterAdmission(root, () => root);
  const profileId = createHash("sha256").update(profileUri).digest("hex");
  const registration = session.registerManagedProfile(root, id, profileId);
  const profile = activateManagedProfileWriter(root, id, () => owner.drain(), 30000, () => true,
    profileId, undefined, registration, owner);
  t.after(() => profile.dispose());
  assert.throws(() => session.completeManagedProfile(root, { ...registration }), /locally issued/);
  assert.throws(() => session.completeManagedProfile(root, registration), /not completely drained/);
  assert.throws(() => session.recordConfirmedManagedProfile(root, storage, { ...registration }), /locally issued/);
  assert.throws(() => profile.holdSnapshotTransition(), /drained/);
  assert.equal(await profile.confirmLocalDrain(storage, async () => true), "drained");
  profile.holdSnapshotTransition();
  assert.throws(() => profile.snapshotHost(storage, profileUri));
  const hosts = profile.discover();
  session.sealConfirmedManagedProfiles(root, id, hosts.map(item => item.hostId));
  const next = profile.rotate();
  assert.throws(() => profile.snapshotHost(storage, profileUri));
  session.fenceManagedWriterSession(root, next.sessionId);
  const host = profile.snapshotHost(storage, profileUri);
  session.assertManagedDrainedSnapshotHost(host);
  assert.throws(() => session.assertManagedDrainedSnapshotHost({ ...host }), /real drained/);
  const otherOwner = new HostWriterAdmission(root, () => root);
  await otherOwner.drain();
  assert.throws(() => session.createManagedDrainedSnapshotHost({ root, profileStorage: storage, profileUri,
    registration, hostAdmission: otherOwner,
    scopeSignal: new AbortController().signal }), /issued managed registration/);
  const file = path.join(root, ".pkm/state/managed-writer-session", `confirmed.${hosts[0].hostId}.json`);
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, "{}");
  assert.throws(() => session.assertManagedDrainedSnapshotHost(host));
  fs.writeFileSync(file, original);
  session.assertManagedDrainedSnapshotHost(host);

  const event = () => ({ dispose() {} });
  const vscode = {
    workspace: { isTrusted: true, onDidChangeWorkspaceFolders: event, onDidChangeConfiguration: event },
    window: { showWarningMessage: async () => "Allow Selected Snapshot Operations" },
  };
  const context = { subscriptions: [], globalStorageUri: { fsPath: storage }, secrets: { onDidChange: event } };
  const js = ts.transpileModule(fs.readFileSync("src/runtime/legacy-snapshot-vscode-authority.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", js)(name =>
    name === "vscode" ? vscode : name === "../knowledge/filestore" ? { getStorePath: () => root }
      : name === "./managed-writer-session" ? session : require(name), module, module.exports);
  await assert.rejects(module.exports.requestManagedDrainedSnapshotVscodeAuthority(context, { ...host }), /real drained/);
  const authority = await module.exports.requestManagedDrainedSnapshotVscodeAuthority(context, host);
  assert.deepEqual(authority.allowedTools, ["knowledge_snapshot_status"]);
  const stat = fs.statSync(root, { bigint: true });
  const binding = { workspaceId: randomUUID(), workspaceRoot: root, actorId: "mcp:external",
    authorityId: authority.authorityId, privateGitRoot: path.join(root, "packages/knowledge-snapshots/repository.git"),
    rootPin: `${stat.dev}:${stat.ino}`, allowedTools: ["knowledge_snapshot_status"], operation: "knowledge_snapshot_status" };
  assert.equal(authority.authorize(binding), true);
  assert.equal(authority.authorize({ ...binding, operation: "knowledge_snapshot_create" }), false);
  profile.dispose();
  assert.equal(authority.authorize(binding), false);
});
