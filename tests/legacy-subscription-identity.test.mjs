import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runInThisContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { importLegacyWorkspace, planLegacyImport, recoverLegacyImportOutcome } from "../dist/legacy-import.js";
import { reconcileSubscriptionIdentity, subscriptionIdentityBindingSchema } from "../dist/legacy-subscription-identity.js";
import { Storage } from "../dist/storage.js";
import { Core } from "../dist/core.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { startHttp } from "../dist/http.js";
import { startMcp } from "../dist/mcp.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { subscriptionReadSourceFiles } from "./subscription-reads-fixtures.mjs";
import { actor, nativePolicy, initializeVault, changePolicy, sha } from "./legacy-subscription-identity-fixture.mjs";
import { legacyIndexedKnowledgeRead } from "../dist/legacy-retrieval-index.js";

async function originalWriter() {
  const require = createRequire(import.meta.url);
  const load = async (url, imports) => {
    const source = await readFile(url, "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const mod = { exports: {} };
    runInThisContext(`(function(require,module,exports){${code}\n})`)(
      name => name.startsWith(".") ? imports[name] ?? {} : require(name), mod, mod.exports);
    return mod.exports;
  };
  const ports = await load(new URL("../legacy/src/runtime/user-service-ports.ts", import.meta.url), {});
  return load(new URL("../legacy/src/subscriptions/subscriptions.ts", import.meta.url), { "../runtime/user-service-ports": ports });
}
async function fixture(t, shares = subscriptionReadSourceFiles["subscriptions.json"].shares) {
  const root = resolve(`.batch23-subscription-${randomUUID()}`);
  const source = join(root, "source"), subscriptionRoot = join(root, "subscription-source");
  const writerRoot = join(root, "original-writer"), target = join(root, "target");
  const vault = join(root, "native-vault"), backup = join(root, "backup"), restored = join(root, "restored");
  await mkdir(join(source, "notes"), { recursive: true });
  await mkdir(subscriptionRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  const { SharedMarketManager } = await originalWriter();
  const writer = new SharedMarketManager(writerRoot, "unused-synthetic-gateway", "Original fixture", {}, undefined,
    { user: "fixture-user", host: "fixture-host" });
  writer.state.shares = structuredClone(shares);
  writer.state.subscriptions = structuredClone(subscriptionReadSourceFiles["subscriptions.json"].subscriptions);
  writer.save(false);
  const bytes = await readFile(join(writerRoot, "subscriptions.json"));
  await writeFile(join(subscriptionRoot, "subscriptions.json"), bytes, { mode: 0o600 });
  await writeFile(join(subscriptionRoot, "subscriber-stats.json"),
    JSON.stringify(subscriptionReadSourceFiles["subscriber-stats.json"]));
  const original = JSON.parse(bytes);
  const projection = { schema: original.schema, nodeId: original.nodeId, publicKey: original.publicKey,
    shares: original.shares, subscriptions: original.subscriptions };
  const binding = subscriptionIdentityBindingSchema.parse({
    schema: "pkm.native-subscription-identity/v1", sourceRoot: source, subscriptionRoot,
    sourceSha256: createHash("sha256").update(bytes).digest("hex"), destination: target,
    stateSha256: sha(projection), statisticsSha256: sha(subscriptionReadSourceFiles["subscriber-stats.json"]),
    actorId: actor.id, ownerEpoch: "native-owner-1", authorityId: "native-vault-fixture",
    secretRef: "native-secret:original-subscription-identity", nodeId: original.nodeId, publicKey: original.publicKey,
  });
  await initializeVault(vault, { bindingSha256: sha(binding), ownerEpoch: binding.ownerEpoch,
    fixtureRoot: root, target, backup, restored, readRoots: [target, restored], revoked: false });
  const policy = nativePolicy(vault);
  const identityImport = { destination: target, actorId: actor.id, ownerEpoch: binding.ownerEpoch,
    authorityId: binding.authorityId, secretRef: binding.secretRef, authority: policy.authority };
  const plan = () => planLegacyImport(source, {}, { subscriptionRoot, subscriptionIdentity: identityImport });
  const pythonExecutable = spawnSync("which", ["python3"], { encoding: "utf8" }).stdout.trim();
  const apply = async plan => {
    const receipt = await importLegacyWorkspace(plan, target, { subscriptionIdentity: identityImport, pythonExecutable });
    const workspaceId = JSON.parse(await readFile(join(target, ".pkm-next-workspace"))).id;
    await changePolicy(vault, { workspaceId });
    return receipt;
  };
  return { root, source, subscriptionRoot, target, vault, backup, restored, original, binding, policy, identityImport, plan, apply };
}
const invocation = (operation, args = {}) => ({ operation, version: 1, arguments: args });
async function open(f, policy = nativePolicy(f.vault)) {
  const storage = await Storage.open(f.target);
  const native = await createNativeRuntime({ storage, ...(policy ? { subscriptionIdentity: policy } : {}) });
  return { storage, native, backupHost: { acquireQuiescence: native.acquireWorkspaceQuiescence },
    async close() { await native.close(); await storage.close(); } };
}
async function read(core, operation, args = {}, who = actor) {
  return core.dispatch("capability_read", invocation(operation, args), who);
}
async function assertSecretFree(path, original) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) await assertSecretFree(full, original);
    else {
      const bytes = await readFile(full);
      assert.equal(bytes.includes(original.privateKey), false, "Private key must not enter a model/persistent artifact.");
      assert.equal(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(bytes.toString()), false);
    }
  }
}

test("native Core and MCP share markers use the admitted original snapshot without exposing broker secrets", async t => {
      const shares = [
        { shareId: "active", name: "Alpha", summary: { shareId: "active" }, published: true,
          contentTypes: ["skills"], selected: { skills: ["direct"] }, folders: { skills: ["Team/Future"] },
          secretSalt: "DO-NOT-EXPOSE-SALT" },
        { shareId: "paused", name: "Beta", summary: { shareId: "paused" }, published: false,
          contentTypes: ["skills"], selected: { skills: ["direct"] } },
      ];
      const f = await fixture(t, shares);
      const plan = await f.plan();
      assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
      await f.apply(plan);
      const opened = await open(f);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcp = await startMcp(opened.native.core, actor, serverTransport);
      const client = new Client({ name: "marker-fixture", version: "1" });
      await client.connect(clientTransport);
      const args = { type: "skills", items: [
        { name: "direct", metadata: { category: "Team/Current" }, extra: "DO-NOT-EXPOSE-ITEM" },
        { name: "folder", category: "Team/Future" }, { name: "other", category: "Private" },
      ] };
      try {
        const described = await opened.native.core.dispatch("capabilities_describe", { operation: "subscription.broker.share-markers" }, actor);
        assert.equal(described.result.operation, "subscription.broker.share-markers");
        const envelope = await read(opened.native.core, "subscription.broker.share-markers", args);
        assert.equal(envelope.error, undefined);
        const result = envelope.result;
        assert.deepEqual(result.items.direct.brokers, [
          { id: "active", name: "Alpha", published: true }, { id: "paused", name: "Beta", published: false },
        ]);
        assert.deepEqual(result.items.folder.brokers, [{ id: "active", name: "Alpha", published: true }]);
        assert.deepEqual(result.folders.Team.brokers, result.items.direct.brokers);
        assert.equal(result.items.other, undefined);
        const mcpResult = await client.callTool({ name: "capability_read", arguments: invocation(
          "subscription.broker.share-markers", { ...args, expectedRevision: result.revision }) });
        assert.deepEqual(mcpResult.structuredContent.result, result);
        for (const secret of [f.original.privateKey, "DO-NOT-EXPOSE-VERIFIER", "DO-NOT-EXPOSE-SALT", "DO-NOT-EXPOSE-ITEM"]) {
          assert.equal(JSON.stringify(mcpResult).includes(secret), false);
        }
        assert.equal((await read(opened.native.core, "subscription.broker.share-markers",
          { ...args, expectedRevision: "0".repeat(64) })).error.code, "REVISION_CONFLICT");
        assert.equal((await read(opened.native.core, "subscription.broker.share-markers", { ...args, actorId: actor.id })).error.code, "INVALID_ARGUMENT");
        assert.equal((await read(opened.native.core, "subscription.broker.share-markers", args,
          { id: "local:other", canWrite: false })).error.code, "ACCESS_DENIED");
        await changePolicy(f.vault, { inspectUnknown: true });
        assert.equal((await read(opened.native.core, "subscription.broker.share-markers", args)).error.code, "UNKNOWN_EFFECT");
        await changePolicy(f.vault, { inspectUnknown: false });
        const path = join(f.target, "subscriptions/subscriptions.json");
        await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), shares: [] }));
        assert.equal((await read(opened.native.core, "subscription.broker.share-markers", args)).error.code, "IMPORT_RECEIPT_INVALID");
      } finally { await client.close(); await mcp.close(); await opened.close(); }
});

test("packaged compact MCP rejects imported subscription identity without native host authority", { timeout: 60_000 }, async t => {
  const f = await fixture(t, [{
    shareId: "fixture-share", name: "Fixture", summary: { shareId: "fixture-share" },
    contentTypes: ["notes"], folders: { notes: ["Team"] },
  }]);
  const plan = await f.plan();
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  await f.apply(plan);
  const client = new Client({ name: "subscription-identity-denial", version: "1" });
  const transport = new StdioClientTransport({
    command: process.env.PKM_TEST_PYTHON || "python3",
    args: [resolve("compat/legacy-compact-mcp.py"), "--data", f.target, "--node", process.execPath],
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe",
  });
  let errors = "";
  transport.stderr?.on("data", chunk => { errors += chunk; });
  try {
    try { await client.connect(transport); } catch (error) { throw new Error(errors, { cause: error }); }
    const result = await client.callTool({ name: "capability_read", arguments: {
      operation: "mcp.tool.subscription_broker_share_markers", version: 1,
      arguments: { type: "notes", items: [{ slug: "note", category: "Team" }] },
    } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /ACCESS_DENIED/);
    assert.equal(JSON.stringify(result).includes(f.original.privateKey), false);
  } finally { await client.close(); }
});
function restart(root, vault) {
  const child = spawnSync(process.execPath, [new URL("./legacy-subscription-identity-child.mjs", import.meta.url).pathname, root, vault],
    { encoding: "utf8", timeout: 30000 });
  assert.equal(child.status, 0, "Fresh native process must successfully use its independently durable authority.");
  const result = JSON.parse(child.stdout);
  assert.equal(result.startupError, undefined, "Native restart must not hide a startup failure.");
  return result;
}

test("actual original writer -> secret-free atomic native HTTP/MCP -> process restart -> backup/fresh restore", async t => {
  const f = await fixture(t);
  const plan = await f.plan();
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal(JSON.stringify(plan).includes(f.original.privateKey), false);
  const receipt = await f.apply(plan);
  assert.equal((await recoverLegacyImportOutcome(f.target)).status, "published");
  assert.equal(JSON.stringify(receipt).includes(f.original.privateKey), false);
  const persisted = JSON.parse(await readFile(join(f.target, "subscriptions/subscriptions.json")));
  assert.equal("privateKey" in persisted, false);
  assert.equal("privateKeyRef" in persisted, false);
  assert.equal(persisted.publicKey, f.original.publicKey);
  assert.equal(persisted.nodeId, f.original.nodeId);
  const opened = await open(f);
  const bearer = "synthetic-subscription-http-authentication-000000000";
  const http = await startHttp(opened.native.core, bearer, actor, 0);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = await startMcp(opened.native.core, actor, serverTransport);
  const client = new Client({ name: "batch23-fixture", version: "1" });
  await client.connect(clientTransport);
  try {
    const unauthenticated = await fetch(`${http.url}/v1/capability_read`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(invocation("subscription.identity.get")) });
    assert.equal(unauthenticated.status, 401);
    const response = await fetch(`${http.url}/v1/capability_read`, { method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(invocation("subscription.identity.get")) });
    const identity = await response.json();
    assert.equal(identity.error, undefined);
    assert.equal(identity.result.publicKey, f.original.publicKey);
    assert.equal(identity.result.secretRef, f.binding.secretRef);
    assert.equal(identity.result.signing, "unavailable");
    const metadata = await client.callTool({ name: "capability_read", arguments: invocation("subscription.get", { id: "fixture-sub" }) });
    assert.equal(JSON.parse(metadata.content[0].text).result.subscription.id, "fixture-sub");
    const allowed = await read(opened.native.core, "subscription.acl.evaluate",
      { shareId: "fixture-share", action: "download", sourceIp: "192.0.2.10" });
    const denied = await read(opened.native.core, "subscription.acl.evaluate",
      { shareId: "fixture-share", action: "download", sourceIp: "203.0.113.10" });
    assert.equal(allowed.result.allowed, true);
    assert.equal(denied.result.allowed, false);
    assert.equal(allowed.result.evaluationOnly, true);
    for (const artifact of [identity, metadata, allowed, denied]) {
      assert.equal(JSON.stringify(artifact).includes(f.original.privateKey), false);
    }
  } finally { await client.close(); await mcp.close(); await new Promise(resolve => http.server.close(resolve)); await opened.close(); }
  assert.equal(restart(f.target, f.vault).identity.result.nodeId, f.original.nodeId);
  const backupHost = await open(f);
  try {
    await assert.rejects(createWorkspaceBackup(backupHost.storage, f.backup, backupHost.backupHost),
      error => error.code === "ACCESS_DENIED");
    await createWorkspaceBackup(backupHost.storage, f.backup, backupHost.backupHost,
      { subscriptionIdentity: nativePolicy(f.vault) });
  } finally { await backupHost.close(); }
  await assert.rejects(restoreWorkspaceBackup(f.backup, f.restored, { nativeRestoreAuthority }),
    error => error.code === "ACCESS_DENIED");
  await restoreWorkspaceBackup(f.backup, f.restored,
    { nativeRestoreAuthority, subscriptionIdentity: nativePolicy(f.vault) });
  assert.equal(restart(f.restored, f.vault).identity.result.publicKey, f.original.publicKey);
  assert.equal(restart(f.restored, f.vault).list.result.total, 1);
  await assertSecretFree(f.target, f.original);
  await assertSecretFree(f.backup, f.original);
  await assertSecretFree(f.restored, f.original);
  for (const name of await readdir(f.root)) {
    if (name.startsWith(".")) {
      const bytes = await readFile(join(f.root, name));
      assert.equal(bytes.includes(f.original.privateKey), false);
    }
  }
});

test("original current cache stays receipt-bound alongside externally held native identity through relocated restore", async t => {
  const f = await fixture(t);
  const relative = "cache/fixture-remote/fixture-share/content/notes/Shared.md";
  await mkdir(join(f.subscriptionRoot, "cache/fixture-remote/fixture-share/content/notes"), { recursive: true });
  const raw = "Exact original subscribed evidence.\n";
  await writeFile(join(f.subscriptionRoot, relative), raw);
  const plan = await f.plan();
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  await f.apply(plan);
  const host = await open(f);
  try {
    const request = { tool: "get_knowledge", arguments: { id: "pkm://subscriptions/fixture-remote/fixture-share/notes/Shared.md" } };
    await assert.rejects(legacyIndexedKnowledgeRead(host.storage, request),
      error => error.code === "ACCESS_DENIED" && /native fixed-actor read authority/.test(error.message));
    const authorize = async () => {
      const result = await read(host.native.core, "subscription.list");
      if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      return result.result;
    };
    const indexed = await legacyIndexedKnowledgeRead(host.storage, request, authorize);
    assert.equal(indexed.value.content, raw);
    assert.equal(indexed.value.read_only, true);
    await changePolicy(f.vault, { revoked: true });
    await assert.rejects(legacyIndexedKnowledgeRead(host.storage, request, authorize),
      error => error.code === "ACCESS_DENIED");
    await changePolicy(f.vault, { revoked: false });
    await createWorkspaceBackup(host.storage, f.backup, host.backupHost, { subscriptionIdentity: nativePolicy(f.vault) });
  } finally { await host.close(); }
  await restoreWorkspaceBackup(f.backup, f.restored, { nativeRestoreAuthority, subscriptionIdentity: nativePolicy(f.vault) });
  assert.equal(await readFile(join(f.restored, "subscriptions", relative), "utf8"), raw);
  assert.equal(restart(f.restored, f.vault).list.result.total, 1);
  await assertSecretFree(f.restored, f.original);
  await writeFile(join(f.target, "subscriptions", relative), "forged cache");
  const tampered = await open(f);
  try {
    await assert.rejects(createWorkspaceBackup(tampered.storage, join(f.root, "tampered-backup"), tampered.backupHost,
      { subscriptionIdentity: nativePolicy(f.vault) }),
      error => error.code === "IMPORT_RECEIPT_INVALID");
  } finally { await tampered.close(); }
});

test("missing native authority, source mutation, incorrect ref/actor/epoch and running gateway fail before publication", async t => {
  const f = await fixture(t);
  const blocked = await planLegacyImport(f.source, {}, { subscriptionRoot: f.subscriptionRoot });
  assert.equal(blocked.ready, false);
  assert.equal(JSON.stringify(blocked).includes(f.original.privateKey), false);
  for (const [field, value] of [["ownerEpoch", "native-owner-stale"], ["actorId", "local:other"], ["secretRef", "native-secret:other"]]) {
    const plan = await planLegacyImport(f.source, {}, { subscriptionRoot: f.subscriptionRoot,
      subscriptionIdentity: { ...f.identityImport, [field]: value } });
    assert.equal(plan.ready, false);
  }
  const plan = await f.plan();
  await writeFile(join(f.subscriptionRoot, "subscriptions.json"), `${JSON.stringify(f.original)}\n`);
  await assert.rejects(f.apply(plan), error => error.code === "SOURCE_CHANGED");
  await assert.rejects(readFile(join(f.vault, "secret.json")), error => error.code === "ENOENT");
  await writeFile(join(f.subscriptionRoot, "subscriptions.json"), JSON.stringify({ ...f.original, enabled: true }));
  assert.equal((await f.plan()).ready, false);
  assert.equal((await recoverLegacyImportOutcome(f.target)).status, "unknown");
  await assert.rejects(readFile(join(f.target, ".pkm-next-workspace")), error => error.code === "ENOENT");
});

test("ambiguous durable store effect is explicitly reconciled; retry does not re-store and startup does not apply", async t => {
  const f = await fixture(t);
  const plan = await f.plan();
  await changePolicy(f.vault, { unknownAfterStore: true });
  await assert.rejects(f.apply(plan), error => error.code === "UNKNOWN_EFFECT");
  assert.equal((await recoverLegacyImportOutcome(f.target)).status, "unknown");
  await assert.rejects(readFile(join(f.target, ".pkm-next-workspace")), error => error.code === "ENOENT");
  assert.equal(await reconcileSubscriptionIdentity(f.binding, nativePolicy(f.vault).authority), "committed");
  await changePolicy(f.vault, { unknownAfterStore: false });
  await f.apply(plan);
  assert.deepEqual(JSON.parse(await readFile(join(f.vault, "store-call.json"))), { calls: 1 });
  assert.equal(restart(f.target, f.vault).identity.result.nodeId, f.original.nodeId);
  await changePolicy(f.vault, { inspectUnknown: true });
  const unknown = restart(f.target, f.vault).identity.error;
  assert.equal(unknown.code, "UNKNOWN_EFFECT");
  assert.equal(unknown.effect, "unknown");
  assert.deepEqual(JSON.parse(await readFile(join(f.vault, "store-call.json"))), { calls: 1 });
  await assertSecretFree(f.target, f.original);
});

test("revocation, owner epoch changes, denied actors and unapproved fresh roots cannot use reference", async t => {
  const f = await fixture(t);
  await f.apply(await f.plan());
  const opened = await open(f);
  try {
    assert.equal((await read(opened.native.core, "subscription.identity.get", {}, { id: "local:other", canWrite: false })).error.code, "ACCESS_DENIED");
    await changePolicy(f.vault, { ownerEpoch: "native-owner-2" });
    assert.equal((await read(opened.native.core, "subscription.get", { id: "fixture-sub" })).error.code, "ACCESS_DENIED");
    await changePolicy(f.vault, { ownerEpoch: "native-owner-1", revoked: true });
    assert.equal((await read(opened.native.core, "subscription.identity.get")).error.code, "ACCESS_DENIED");
  } finally { await opened.close(); }
  await changePolicy(f.vault, { revoked: false });
  const plain = await Storage.open(f.target);
  try { assert.equal((await read(new Core(plain), "subscription.identity.get")).error.code, "NOT_AVAILABLE"); }
  finally { await plain.close(); }
  const absent = await open(f, null);
  try { assert.equal((await read(absent.native.core, "subscription.identity.get")).error.code, "NOT_AVAILABLE"); }
  finally { await absent.close(); }
  const backupHost = await open(f);
  try { await createWorkspaceBackup(backupHost.storage, f.backup, backupHost.backupHost, { subscriptionIdentity: nativePolicy(f.vault) }); }
  finally { await backupHost.close(); }
  await changePolicy(f.vault, { denyRestore: true });
  await assert.rejects(restoreWorkspaceBackup(f.backup, f.restored, { nativeRestoreAuthority, subscriptionIdentity: nativePolicy(f.vault) }),
    error => error.code === "ACCESS_DENIED");
});

test("source mutation and revocation inside native store callbacks are fenced without publishing key bytes", async t => {
  for (const control of ["mutateSource", "revokeDuringStore"]) {
    const f = await fixture(t);
    const plan = await f.plan();
    await changePolicy(f.vault, { [control]: true });
    await assert.rejects(f.apply(plan), error => ["SOURCE_CHANGED", "ACCESS_DENIED"].includes(error.code));
    assert.equal((await recoverLegacyImportOutcome(f.target)).status, "unknown");
    await assert.rejects(readFile(join(f.target, ".pkm-next-workspace")), error => error.code === "ENOENT");
    for (const name of await readdir(f.root)) {
      assert.equal(name.includes("pkm-legacy-import-"), false, "Failed unpublished stage must be discarded.");
    }
  }
});

test("unknown pre-store inspection never writes; explicit absent reconciliation permits an approved import", async t => {
  const f = await fixture(t);
  const plan = await f.plan();
  await changePolicy(f.vault, { inspectUnknown: true });
  await assert.rejects(f.apply(plan), error => error.code === "UNKNOWN_EFFECT" && error.effect === "unknown");
  await assert.rejects(readFile(join(f.vault, "secret.json")), error => error.code === "ENOENT");
  assert.equal(await reconcileSubscriptionIdentity(f.binding, nativePolicy(f.vault).authority), "unknown");
  await changePolicy(f.vault, { inspectUnknown: false });
  assert.equal(await reconcileSubscriptionIdentity(f.binding, nativePolicy(f.vault).authority), "absent");
  await f.apply(plan);
  assert.equal(restart(f.target, f.vault).identity.result.secretRef, f.binding.secretRef);
});

test("complete native metadata fences reject public identity, ACL-statistics, sidecar and unbound inventory tampering", async t => {
  const f = await fixture(t);
  await f.apply(await f.plan());
  const opened = await open(f);
  try {
    for (const name of ["subscriptions.json", "subscriber-stats.json", "native-identity.json"]) {
      const path = join(f.target, "subscriptions", name);
      const bytes = await readFile(path);
      await writeFile(path, Buffer.concat([bytes, Buffer.from("\n")]));
      assert.equal((await read(opened.native.core, "subscription.identity.get")).error.code, "IMPORT_RECEIPT_INVALID");
      await assert.rejects(createWorkspaceBackup(opened.storage, f.backup, opened.backupHost,
        { subscriptionIdentity: nativePolicy(f.vault) }), error => error.code === "IMPORT_RECEIPT_INVALID");
      await writeFile(path, bytes);
    }
    const unbound = join(f.target, "subscriptions", "unbound.json");
    await writeFile(unbound, "{}");
    assert.equal((await read(opened.native.core, "subscription.get", { id: "fixture-sub" })).error.code, "IMPORT_RECEIPT_INVALID");
    await rm(unbound);
    await changePolicy(f.vault, { workspaceId: randomUUID() });
    assert.equal((await read(opened.native.core, "subscription.identity.get")).error.code, "ACCESS_DENIED");
  } finally { await opened.close(); }
  await assertSecretFree(f.target, f.original);
});
