import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { fork, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { test, mock } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root = resolve(`.migration-test-work/pkm-protected-state-fixture-${crypto.randomUUID()}`);
const source = join(root, "original"), profile = join(root, "profile"), stage = join(root, "stage");
const statePath = join(profile, "subscriptions.json");
let virtualState;
const statWithSize = stat => {
  const result = Object.create(stat);
  Object.defineProperty(result, "size", { value: typeof stat.size === "bigint" ? BigInt(virtualState.length) : virtualState.length });
  return result;
};
const patched = {
  ...fs,
  async lstat(path, options) {
    const stat = await fs.lstat(path, options);
    return path === statePath ? statWithSize(stat) : stat;
  },
  async open(path, ...args) {
    if (path !== statePath) return fs.open(path, ...args);
    return {
      async stat(options) { return statWithSize(await fs.lstat(path, options)); },
      async readFile() { return Buffer.from(virtualState); },
      async close() {},
    };
  },
};
mock.module("node:fs/promises", { namedExports: patched, defaultExport: patched });
const importer = await import("../dist/legacy-state-import.js");
const { initialize } = await import("../dist/storage.js");

async function originalHelpers() {
  const text = await fs.readFile(resolve("src/subscriptions/subscriptions.ts"), "utf8");
  const file = ts.createSourceFile("subscriptions.ts", text, ts.ScriptTarget.Latest, true);
  const names = ["hash", "deriveSecretKeys", "encryptSnapshot", "unique", "tagsOf"];
  const declarations = names.map(name => file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)?.getText(file));
  assert(declarations.every(Boolean));
  const contentTypes = file.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(item => item.name.getText(file) === "SHARED_CONTENT_TYPES")).getText(file);
  const cls = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "SharedMarketManager");
  const summary = cls.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(file) === "buildSummary").getText(file);
  const program = `${contentTypes}\n${declarations.join("\n")}\nclass Original {state; constructor(privateKey) {this.state={privateKey};} ${summary} }\nglobalThis.original={hash,deriveSecretKeys,encryptSnapshot,Original};`;
  const output = ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const sandbox = { ...crypto, Buffer, exports: {} };
  runInNewContext(output, sandbox);
  return sandbox.original;
}

test("protected legacy state enters the importer without writing keys, and survives verification", { timeout: 60000 }, async t => {
  t.after(async () => { delete process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT; virtualState?.fill(0); await fs.rm(root, { recursive: true, force: true }); mock.reset(); });
  await fs.mkdir(source, { recursive: true, mode: 0o700 });
  await fs.mkdir(join(profile, "snapshots"), { recursive: true, mode: 0o700 });
  process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT = root;
  const nonce = crypto.randomUUID(), rootStat = await fs.lstat(source, { bigint: true }), profileStat = await fs.lstat(profile, { bigint: true });
  await fs.writeFile(join(root, "subscription-state-fixture.json"), JSON.stringify({
    schema: "pkm.protected-subscription-state-fixture/v1", nonce,
    rootPin: `${rootStat.dev}:${rootStat.ino}`, profilePin: `${profileStat.dev}:${profileStat.ino}`,
  }), { mode: 0o600 });
  await fs.writeFile(statePath, "virtual-state-placeholder", { mode: 0o600 });
  await initialize(stage);
  const original = await originalHelpers(), keys = crypto.generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const secret = crypto.randomBytes(32).toString("base64url"), salt = crypto.randomBytes(16).toString("base64url");
  const derived = original.deriveSecretKeys(secret, salt);
  const bundle = { from: "Synthetic fixture", created_at: "", version: "3",
    notes: [{ slug: "Fixture", content: "# Synthetic shared knowledge\n" }] };
  const plain = Buffer.from(JSON.stringify(bundle));
  const current = original.encryptSnapshot(plain, derived.contentKey);
  const historical = original.encryptSnapshot(Buffer.from(JSON.stringify({ notes: [] })), derived.contentKey);
  const id = "synthetic-share", revision = 2, summary = new original.Original(privateKey).buildSummary(id, "Synthetic", revision, current, bundle, true, salt);
  const nodeId = crypto.createHash("sha256").update(publicKey).digest("hex");
  const share = { shareId: id, name: "Synthetic", revision, protection: "secret-protected", secretSalt: salt,
    authVerifier: derived.authVerifier.toString("base64url"), contentHash: original.hash(plain),
    snapshotPath: join(profile, "snapshots", `${id}-${revision}.json`), summary };
  const state = { schema: 1, enabled: false, nodeId, publicKey, privateKey, shares: [share], subscriptions: [] };
  virtualState = Buffer.from(JSON.stringify(state));
  derived.authVerifier.fill(0); derived.contentKey.fill(0); plain.fill(0);
  await fs.writeFile(join(profile, "snapshots", `${id}-1.json`), historical, { mode: 0o600 });
  await fs.writeFile(share.snapshotPath, current, { mode: 0o600 });
  const gatewayPath = join(profile, "gateway-state.json");
  await fs.writeFile(gatewayPath, JSON.stringify({ schema: 1, ownerNodeId: nodeId, nodeId, publicKey,
    shares: [{ summary, snapshotPath: share.snapshotPath, authVerifier: share.authVerifier }] }), { mode: 0o600 });
  const gatewayBefore = await fs.readFile(gatewayPath);
  const initial = await fs.readFile(share.snapshotPath), sourcePlaceholder = await fs.readFile(statePath);
  let supplied = secret;
  const policy = { fixture: root, nonce, authorityId: "in-memory-test-authority", epoch: "one",
    async authorizeState(binding) { return binding.root === source && binding.profile === profile && binding.nodeId === nodeId
      && binding.shareId === id && binding.stateSha256 === crypto.createHash("sha256").update(virtualState).digest("hex")
      && binding.ciphertextSha256 === crypto.createHash("sha256").update(current).digest("hex"); },
    authority: {
    async authorize(binding) { return binding.root === source && binding.profile === profile && binding.nodeId === nodeId && binding.shareId === id; },
    async secret() { return supplied === undefined ? undefined : Buffer.from(supplied); },
  } };
  const writer = spawn(process.execPath, ["-e", "process.send('ready'); setInterval(() => {}, 1000)"], {
    cwd: profile, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    await new Promise((resolveReady, reject) => {
      writer.once("message", resolveReady); writer.once("error", reject);
      writer.once("exit", () => reject(new Error("Fixture writer exited early.")));
    });
    await assert.rejects(importer.planLegacyStateImport(source, profile, undefined, undefined, policy), { code: "LEGACY_WRITERS_ACTIVE" });
    assert.deepEqual(await fs.readFile(statePath), sourcePlaceholder);
    assert.deepEqual(await fs.readFile(share.snapshotPath), initial);
  } finally {
    if (writer.exitCode === null && writer.signalCode === null) {
      const exited = new Promise(resolveExit => writer.once("exit", resolveExit));
      writer.kill("SIGTERM");
      await exited;
    }
  }
  await assert.rejects(importer.planLegacyStateImport(source, profile), { code: "UNKNOWN_STATE" });
  await assert.rejects(importer.planLegacyStateImport(source, profile, undefined, undefined,
    { ...policy, async authorizeState() { return false; } }), { code: "SNAPSHOT_DENIED" });
  let issued;
  const changing = { ...policy, authority: { ...policy.authority,
    async secret() { changing.epoch = "two"; issued = Buffer.from(secret); return issued; },
  } };
  await assert.rejects(importer.planLegacyStateImport(source, profile, undefined, undefined, changing), { code: "SNAPSHOT_DENIED" });
  assert(issued.every(byte => byte === 0));
  supplied = "wrong";
  await assert.rejects(importer.planLegacyStateImport(source, profile, undefined, undefined, policy), { code: "SNAPSHOT_DENIED" });
  assert.deepEqual(await fs.readFile(statePath), sourcePlaceholder);
  assert.deepEqual(await fs.readFile(gatewayPath), gatewayBefore);
  supplied = secret;
  const intactState = Buffer.from(virtualState);
  virtualState.fill(0);
  virtualState = Buffer.from(JSON.stringify({ ...state, shares: [{ ...share, authVerifier: crypto.randomBytes(32).toString("base64url") }] }));
  await assert.rejects(importer.planLegacyStateImport(source, profile, undefined, undefined, policy), { code: "SNAPSHOT_DENIED" });
  virtualState.fill(0); virtualState = intactState;
  assert.deepEqual(await fs.readFile(share.snapshotPath), initial);
  assert.deepEqual((await fs.readdir(stage)).sort(), [".pkm-next-workspace", "notes"]);
  supplied = secret;
  const damaged = Buffer.from(current); damaged[30] ^= 1;
  await fs.writeFile(share.snapshotPath, damaged);
  await assert.rejects(importer.planLegacyStateImport(source, profile, undefined, undefined, policy), { code: "SNAPSHOT_DENIED" });
  assert.deepEqual(await fs.readFile(share.snapshotPath), damaged);
  assert.deepEqual(await fs.readFile(statePath), sourcePlaceholder);
  await fs.writeFile(share.snapshotPath, current);
  const downloads = join(profile, "downloads");
  await fs.mkdir(downloads, { mode: 0o700 });
  await fs.writeFile(join(downloads, "pending.download"), "synthetic pending transfer");
  await assert.rejects(importer.planLegacyStateImport(source, profile, undefined, undefined, policy), { code: "UNKNOWN_STATE" });
  assert.equal(await fs.readFile(join(downloads, "pending.download"), "utf8"), "synthetic pending transfer");
  await fs.unlink(join(downloads, "pending.download"));
  await fs.rmdir(downloads);
  await fs.symlink(join(profile, "cache"), downloads);
  await assert.rejects(importer.planLegacyStateImport(source, profile, undefined, undefined, policy), { code: "UNSAFE_PATH" });
  await fs.unlink(downloads);
  await fs.mkdir(downloads, { mode: 0o700 });
  const plan = await importer.planLegacyStateImport(source, profile, undefined, undefined, policy);
  assert.equal(plan.protectedSubscriptions.emptyDownloads, true);
  assert.deepEqual(plan.protectedSubscriptions.snapshots.map(row => row.status), ["unverified", "authenticated-current"]);
  const historyPath = join(profile, "snapshots", `${id}-1.json`);
  await fs.writeFile(historyPath, Buffer.from("changed historical bytes"));
  await assert.rejects(importer.stageLegacyStateImport(plan, stage, undefined, undefined, policy), { code: "SOURCE_CHANGED" });
  assert.deepEqual((await fs.readdir(stage)).sort(), [".pkm-next-workspace", "notes"]);
  await fs.writeFile(historyPath, historical);
  supplied = "wrong";
  await assert.rejects(importer.stageLegacyStateImport(plan, stage, undefined, undefined, policy), { code: "SNAPSHOT_DENIED" });
  assert.deepEqual((await fs.readdir(stage)).sort(), [".pkm-next-workspace", "notes"]);
  supplied = secret;
  await importer.stageLegacyStateImport(plan, stage, undefined, undefined, policy);
  await importer.verifyLegacyStateImport(plan, stage, undefined, undefined, policy);
  const read = await importer.readImportedProtectedSubscriptionSnapshot(plan, stage, id, policy);
  try { assert.equal(JSON.parse(read.plaintext).notes[0].content, "# Synthetic shared knowledge\n"); }
  finally { read.plaintext.fill(0); }
  assert.deepEqual(await fs.readFile(join(stage, "subscriptions/snapshots", `${id}-1.json`)), historical);
  assert.deepEqual(await fs.readFile(join(stage, "subscriptions/snapshots", `${id}-2.json`)), current);
  const projected = await fs.readFile(join(stage, "subscriptions/subscriptions.json"), "utf8");
  assert(!projected.includes(secret) && !projected.includes("PRIVATE KEY") && !projected.includes("authVerifier"));
  assert(!JSON.stringify(plan).includes(secret) && !JSON.stringify(plan).includes("PRIVATE KEY") && !JSON.stringify(plan).includes(share.authVerifier));
  assert.deepEqual(await fs.readFile(statePath), sourcePlaceholder);
  const child = fork(resolve("next-server/tests/legacy-protected-state-import-child.mjs"), [], {
    execArgv: ["--experimental-test-module-mocks"], stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const reopened = await new Promise((resolveResult, reject) => {
    let response;
    child.on("message", value => { response = value; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolveResult(response) : reject(new Error("Isolated verification child failed.")));
    child.send({ plan, stage, state: virtualState.toString("utf8"), secret, shareId: id, nonce });
  });
  assert.deepEqual(reopened, { ok: true, hash: share.contentHash, itemCount: 1 });
  supplied = secret;
  await fs.mkdir(join(source, "notes"));
  await fs.writeFile(join(source, "notes", "Fixture.md"), "# Synthetic original note\n");
  const outer = await import("../dist/legacy-import.js");
  const outerPlan = await outer.planLegacyImport(source, {}, { subscriptionRoot: profile, protectedSubscription: policy });
  assert.equal(outerPlan.ready, true, JSON.stringify(outerPlan.blockers));
  assert.deepEqual(outerPlan.statePlan.protectedSubscriptions, plan.protectedSubscriptions);
  const destination = join(root, "imported");
  await outer.importLegacyWorkspace(outerPlan, destination, { pythonExecutable: "/usr/bin/python3", protectedSubscription: policy });
  assert.deepEqual(await fs.readFile(join(destination, "subscriptions/snapshots", `${id}-1.json`)), historical);
  const importedRead = await importer.readImportedProtectedSubscriptionSnapshot(outerPlan.statePlan, destination, id, policy);
  try { assert.equal(importedRead.plaintextSha256, share.contentHash); }
  finally { importedRead.plaintext.fill(0); }
  const { Storage } = await import("../dist/storage.js");
  const { createWorkspaceBackup, restoreWorkspaceBackup } = await import("../dist/workspace-backup.js");
  const { nativeRestoreAuthority } = await import("./host-composition-legacy-batch16-restore-fixture.mjs");
  const backup = join(root, "backup"), restored = join(root, "restored");
  const storage = await Storage.open(destination);
  try {
    let held = false;
    await createWorkspaceBackup(storage, backup, { acquireQuiescence: async () => {
      held = true;
      return { assertHeld() { assert.equal(held, true); }, release() { held = false; } };
    } });
  } finally { await storage.close(); }
  await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority });
  assert.deepEqual(await fs.readFile(join(restored, "subscriptions/snapshots", `${id}-1.json`)), historical);
  const restoredRead = await importer.readImportedProtectedSubscriptionSnapshot(outerPlan.statePlan, restored, id, policy);
  try { assert.equal(restoredRead.plaintextSha256, share.contentHash); }
  finally { restoredRead.plaintext.fill(0); }
  const unexpected = join(destination, "subscriptions/snapshots/unknown-1.json");
  await fs.writeFile(unexpected, "unlisted");
  const reopenedStorage = await Storage.open(destination);
  try {
    await assert.rejects(createWorkspaceBackup(reopenedStorage, join(root, "bad-backup"), { acquireQuiescence: async () => ({
      assertHeld() {}, release() {},
    }) }), { code: "IMPORT_RECEIPT_INVALID" });
  } finally { await reopenedStorage.close(); await fs.unlink(unexpected); }
  async function noKeys(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await noKeys(path);
      else if (entry.isFile()) {
        const content = await fs.readFile(path);
        assert(!content.includes(Buffer.from(secret)));
        assert(!content.includes(Buffer.from(privateKey)));
      }
    }
  }
  await noKeys(root);
  supplied = "wrong";
  await assert.rejects(importer.readImportedProtectedSubscriptionSnapshot(plan, stage, id, policy), { code: "SNAPSHOT_DENIED" });
  assert.deepEqual(await fs.readFile(share.snapshotPath), initial);
  assert.deepEqual(await fs.readFile(join(stage, "subscriptions/snapshots", `${id}-2.json`)), current);
  assert.deepEqual(await fs.readFile(statePath), sourcePlaceholder);
  assert.deepEqual(await fs.readFile(gatewayPath), gatewayBefore);
});
