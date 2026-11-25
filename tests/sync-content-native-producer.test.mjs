import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../dist/original-mcp-native-identity.js";
import { originalMcpNativeRequestProtocol, originalMcpNativeResult } from "../dist/original-mcp-native-request.js";
import { bootstrapOriginalMcpNativeRuntime } from "../dist/original-mcp-native-bootstrap.js";
import { originalNativeSyncMethod } from "../dist/original-mcp-native-sync-contracts.js";
import { acquireOriginalMcpRootFence, captureOriginalMcpCustody } from "../dist/original-mcp-root.js";
import { typedSyncFiles } from "./sync-content-fixtures.mjs";
import { syncPlanHash } from "../dist/sync-plan.js";
import { httpCall, invocation } from "./batch06-manager-fixtures.mjs";
import { startHttp } from "../dist/http.js";
import { signedActionPackageClient } from "./fixtures/original-mcp-action-package-native-client.mjs";
import { portableActionArchive, portableActionManifest } from "./legacy-action-catalog-fixture.mjs";
import { createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { createOriginalMcpNativeRequestPolicy } from "../dist/original-mcp-native-request.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { createNativePublicOwnerBackend } from "../dist/native-public-mcp-owner.js";
import { verifyNativeSyncRootContent } from "../dist/sync-root-content-custody.js";
import { coreDatabasePath } from "../dist/workspace-storage-paths.js";
import { originalMcpJournal } from "../dist/original-mcp-root-custody.js";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url), { build } = require("esbuild");
const rootPath = resolve("."), hash = value => createHash("sha256").update(value).digest("hex");
const built = await build({ entryPoints: [join(rootPath, "clients/vscode-host/original-mcp-native-sync.ts")],
  bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false, metafile: true, logLevel: "silent",
  plugins: [{ name: "test-native-profile-signer", setup(plugin) {
    plugin.onResolve({ filter: /original-mcp-native-identity\.js$/ }, () => ({ path: "test-native-profile-signer", external: true }));
  } }],
});
assert(!Object.keys(built.metafile.inputs).some(path => /(?:storage|original-mcp-native-host|native-runtime)\.ts$/.test(path)));
const snapshots = files => {
  const manifest = { schema: 3, capabilities: { storage: "pkm.github.publication/v1",
    required: ["explicit-deletions", "stable-entity-identity", "action-library-assets", "profile-cards"] }, files, deletions: [] };
  return { manifest, sha256: syncPlanHash(manifest) };
};
async function fixture(t, options = {}) {
  assert(process.env.PKM_TEST_WORKSPACE, "Use managed private Linux lane.");
  const directory = options.reuse?.directory ?? join(process.env.PKM_TEST_WORKSPACE, `sync-producer-${randomUUID()}`);
  const root = join(directory, "root");
  if (!options.reuse) {
    await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
    await mkdir(join(root, ".pkm"), { mode: 0o700 });
    await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
    await writeFile(join(root, "notes/Owned.md"), "Synthetic owned native Sync source.", { mode: 0o600 });
    if (options.serverArea) await mkdir(join(root, "servers"), { mode: 0o700 });
  }
  let bootstrap, fence, runtime, socket, producer, http, endpoint;
  const lifetime = new AbortController();
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    producer?.dispose(); lifetime.abort(); socket?.destroy();
    if (http) await new Promise(resolve => http.server.close(resolve));
    await bootstrap?.close(); await fence?.release();
    if (endpoint) await rm(endpoint, { recursive: true, force: true });
    if (!options.retainDirectory) await rm(directory, { recursive: true, force: true });
  };
  t.after(close);
  const profileSha256 = hash("synthetic signed current Sync profile");
  fence = await acquireOriginalMcpRootFence(root);
  const plan = options.reuse?.plan ?? await captureOriginalMcpCustody({
    root, backup: join(directory, "custody"), operatorId: "synthetic-sync-producer", profileSha256,
    limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 1048576, maxFileBytes: 1048576 },
  }, { writerFence: fence });
  const keys = generateKeyPairSync("ed25519"), identity = originalMcpNativeIdentity(
    createPublicKey(keys.privateKey).export({ format: "der", type: "spki" }).toString("base64"), profileSha256);
  endpoint = join(homedir(), ".local/state/pkm-v5-recovery", `sy-${randomBytes(4).toString("hex")}`);
  await mkdir(endpoint, { mode: 0o700 });
  bootstrap = await bootstrapOriginalMcpNativeRuntime({ plan, writerFence: fence,
    attachment: { directory: endpoint, identity, identitySha256: identity.sha256,
      payloadBuildId: hash("synthetic-payload"), hostEntrySha256: hash("synthetic-entry") } });
  const descriptor = JSON.parse(await readFile(bootstrap.attachmentDescriptorPath, "utf8")), activationId = randomUUID();
  const signedSession = { brokerId: descriptor.brokerId, activationId, epoch: activationId,
    identitySha256: identity.sha256, binding: descriptor.binding };
  socket = connect(descriptor.socketPath);
  const send = value => socket.write(JSON.stringify(value) + "\n");
  const controls = { answer: "Deny", revokeDuringReview: false }, frames = [], prompts = [];
  let buffer = "", attachedResolve;
  const attached = new Promise(resolve => { attachedResolve = resolve; });
  socket.on("error", () => socket.destroy());
  socket.on("data", chunk => {
    buffer += chunk.toString("utf8");
    let boundary;
    while ((boundary = buffer.indexOf("\n")) >= 0) {
      const frame = JSON.parse(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1);
      if (frame.type === "challenge") {
        const { body, message } = originalMcpNativeAttestationMessage(frame.challenge, identity.sha256, activationId);
        send({ type: "attestation", attestation: { ...body, signature: sign(null, message, keys.privateKey).toString("base64") } });
      } else if (frame.type === "attached") attachedResolve();
      else if (frame.type === "ping") send({ type: "pong", nonce: frame.nonce });
      else if (frame.type === "native-request") {
        frames.push(frame);
        if (["admission.approve", "public.approve"].includes(frame.method))
          send(originalMcpNativeResult(frame, { decision: "approve" }));
        else if (frame.method === originalNativeSyncMethod) {
          void producer.handle(frame.method, frame.payload, frame.requestId, lifetime.signal)
            .then(async result => {
              await controls.beforeReply?.(frame);
              if (!socket.destroyed) send(originalMcpNativeResult(frame, controls.result ? controls.result(result) : result));
            }).catch(() => socket.destroy());
        }
      }
    }
  });
  const load = Module._load;
  let api;
  try {
    Module._load = function(id, ...args) {
      if (id === "test-native-profile-signer") return { originalMcpNativeSigner: async () => ({
        activationId, identity, signal: lifetime.signal,
        payloadBuildId: descriptor.binding.payloadBuildId, hostEntrySha256: descriptor.binding.hostEntrySha256,
        assertCurrent() { if (lifetime.signal.aborted) throw new Error("NATIVE_SYNC_SESSION_REVOKED"); },
      }) };
      if (id === "vscode") return { window: { async showWarningMessage(title, options) {
        prompts.push({ title, detail: JSON.parse(options.detail) });
        if (controls.revokeDuringReview) socket.destroy();
        return controls.answer;
      } } };
      return load.call(this, id, ...args);
    };
    const name = join(rootPath, "clients/vscode-host", `.sync-producer-memory-${randomUUID()}.cjs`), compiled = new Module(name);
    compiled.filename = name; compiled.paths = Module._nodeModulePaths(join(rootPath, "clients/vscode-host"));
    compiled._compile(built.outputFiles[0].text, name); api = compiled.exports;
  } finally { Module._load = load; }
  producer = await api.createOriginalMcpNativeSyncProducer({ subscriptions: [] }, {
    session: signedSession, signal: lifetime.signal,
    assertCurrent() { if (lifetime.signal.aborted) throw new Error("NATIVE_SYNC_SESSION_REVOKED"); },
  });
  await attached;
  send({ type: "native-supports", protocol: originalMcpNativeRequestProtocol, session: signedSession,
    methods: ["admission.approve", "public.approve", originalNativeSyncMethod], maxPacketBytes: 65536 });
  await bootstrap.complete({ enableModels: false });
  runtime = (await bootstrap.owner.ensureFull()).runtime;
  const bearer = randomUUID() + randomUUID();
  http = await startHttp(runtime.core, bearer, { id: "mcp:external", canWrite: true }, 0);
  return { directory, plan, bootstrap, close, root, runtime, controls, frames, prompts, socket, url: http.url, bearer,
    async call(operation, args, readOnly = false) {
      return httpCall(http.url, bearer, readOnly ? "capability_read" : "capability_call", invocation(operation, args));
    } };
}
test("shipped signed native Sync UI producer grants exact current typed source to public HTTP apply, never a fixture callback", { timeout: 120000 }, async t => {
  const f = await fixture(t), files = typedSyncFiles(), input = { base: snapshots([]), local: snapshots([]), remote: snapshots(files) };
  const sessionId = randomUUID();
  assert.equal((await f.call("sync.plan.create", { operationId: randomUUID(), sessionId, input })).status, 200);
  const review = () => f.call("sync.apply.preview", { sessionId, input }, true);
  assert.notEqual((await review()).status, 200);
  f.controls.answer = "Review this exact Sync source";
  const preview = await review();
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(f.prompts.at(-1).detail.review.entities.map(value => value.type).sort(),
    ["action-module-sets", "actions", "packages", "profiles", "recipes", "servers"]);
  assert.equal(f.prompts.at(-1).detail.privateMetadata, true);
  assert.equal(f.prompts.at(-1).detail.publication, "local-only");
  const operationId = randomUUID(), args = { operationId, sessionId, input, expectedPlanHash: preview.body.result.planHash };
  assert.notEqual((await f.call("sync.apply", args)).status, 200, "preview affirmative cannot approve Apply");
  f.controls.answer = "Apply this exact inert Sync plan";
  const applied = await f.call("sync.apply", args);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  for (const file of files) assert.deepEqual(await readFile(join(f.root, file.path)), Buffer.from(file.contentBase64, "base64"));
  const calls = f.frames.filter(frame => frame.method === originalNativeSyncMethod).length;
  f.controls.answer = "Deny";
  assert.deepEqual((await f.call("sync.apply", args)).body.result, applied.body.result);
  assert.equal(f.frames.filter(frame => frame.method === originalNativeSyncMethod).length, calls, "completed historical result replay is not reapproval");
  assert.notEqual((await review()).status, 200, "a completed request does not retain source authority");
  assert(!JSON.stringify(f.frames.filter(frame => frame.method === originalNativeSyncMethod)).includes("contentBase64"));
});

test("signed public Sync review rejects changed source, expired/foreign decisions and post-review target races", { timeout: 120000 }, async t => {
  const f = await fixture(t), files = [typedSyncFiles()[0]];
  const input = { base: snapshots([]), local: snapshots([]), remote: snapshots(files) }, sessionId = randomUUID();
  assert.equal((await f.call("sync.plan.create", { operationId: randomUUID(), sessionId, input })).status, 200);
  f.controls.answer = "Review this exact Sync source";
  const preview = await f.call("sync.apply.preview", { sessionId, input }, true);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const other = structuredClone(input);
  other.remote.manifest.files[0].digest = hash("changed after plan");
  other.remote.manifest.files[0].contentBase64 = Buffer.from("changed after plan").toString("base64");
  other.remote.sha256 = syncPlanHash(other.remote.manifest);
  const reviewed = f.prompts.length;
  assert.notEqual((await f.call("sync.apply.preview", { sessionId, input: other }, true)).status, 200);
  assert.equal(f.prompts.length, reviewed, "persisted plan must match before UI review");
  const args = { operationId: randomUUID(), sessionId, input, expectedPlanHash: preview.body.result.planHash };
  f.controls.answer = "Apply this exact inert Sync plan";
  for (const change of [
    result => ({ ...result, epoch: randomUUID() }),
    result => ({ ...result, expiresAtMs: Date.now() - 1 }),
    result => ({ ...result, requestSha256: "f".repeat(64) }),
  ]) {
    f.controls.result = change;
    assert.notEqual((await f.call("sync.apply", args)).status, 200);
    await assert.rejects(access(join(f.root, files[0].path)));
  }
  f.controls.result = undefined;
  f.controls.beforeReply = async () => {
    await mkdir(join(f.root, "packages/synthetic"), { recursive: true, mode: 0o700 });
    await writeFile(join(f.root, files[0].path), "foreign target bytes", { mode: 0o600 });
  };
  assert.notEqual((await f.call("sync.apply", args)).status, 200);
  assert.equal(await readFile(join(f.root, files[0].path), "utf8"), "foreign target bytes");
});

test("native session revocation during review never admits or replays typed source", { timeout: 120000 }, async t => {
  const f = await fixture(t), files = [typedSyncFiles()[0]];
  const input = { base: snapshots([]), local: snapshots([]), remote: snapshots(files) }, sessionId = randomUUID();
  assert.equal((await f.call("sync.plan.create", { operationId: randomUUID(), sessionId, input })).status, 200);
  f.controls.answer = "Review this exact Sync source"; f.controls.revokeDuringReview = true;
  assert.notEqual((await f.call("sync.apply.preview", { sessionId, input }, true)).status, 200);
  await assert.rejects(access(join(f.root, files[0].path)));
});

async function authorPackage(f) {
  const catalog = originalPublicMcpContracts().provenance.metadataSha256;
  const signed = await signedActionPackageClient(f.bootstrap.storage, f.plan, catalog);
  const host = await createOriginalMcpNativeHost(f.bootstrap.storage, createOriginalMcpNativeRequestPolicy(signed.session));
  const backend = createNativePublicOwnerBackend(f.bootstrap.owner, {
    actor: { id: "mcp:external", canWrite: true }, originalMcpHost: host,
  });
  try {
    const source = join(f.directory, "explicit-current-package.zip");
    await writeFile(source, portableActionArchive(), { mode: 0o600 });
    const call = (tool, args) => backend.invoke("original_mcp_public", { tool, arguments: args });
    await call("action_module_set_import", { local_path: source });
    await call("action_module_set_load", { module_set_id: portableActionManifest.module_set_id, version: portableActionManifest.version });
    assert(signed.requests.some(value => value.method === "action.package.source.approve"));
    const db = f.bootstrap.storage.connectNative();
    try {
      assert.equal(db.prepare("SELECT count(*) n FROM legacy_action_catalog_admissions").get().n, 1);
      assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='original_mcp_action_footprints'").get(), undefined);
      assert.equal(db.prepare("SELECT count(*) n FROM action_runtime_runs").get().n, 0);
    } finally { db.close(); }
  } finally { await backend.close(); }
}
async function syncServer(f) {
  const files = [typedSyncFiles()[1]], input = { base: snapshots([]), local: snapshots([]), remote: snapshots(files) };
  const sessionId = randomUUID();
  assert.equal((await f.call("sync.plan.create", { operationId: randomUUID(), sessionId, input })).status, 200);
  f.controls.answer = "Review this exact Sync source";
  const preview = await f.call("sync.apply.preview", { sessionId, input }, true);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  f.controls.answer = "Apply this exact inert Sync plan";
  const result = await f.call("sync.apply", {
    operationId: randomUUID(), sessionId, input, expectedPlanHash: preview.body.result.planHash,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return files[0];
}
test("fresh signed Action authoring without historical footprint coexists with privileged public Sync and actual Root reopen", { timeout: 120000 }, async t => {
  const f = await fixture(t, { retainDirectory: true, serverArea: true });
  let reopened;
  t.after(async () => { await reopened?.close(); await f.close(); await rm(f.directory, { recursive: true, force: true }); });
  await authorPackage(f);
  const file = await syncServer(f);
  assert.doesNotThrow(() => verifyNativeSyncRootContent(f.root, "servers"));
  await f.close();
  reopened = await fixture(t, { reuse: f, retainDirectory: true });
  assert.deepEqual(await readFile(join(f.root, file.path)), Buffer.from(file.contentBase64, "base64"));
  assert.doesNotThrow(() => verifyNativeSyncRootContent(f.root, "servers"));
});

test("Action-aware Sync custody rejects unknown schema, altered catalog custody and changed original journal", { timeout: 120000 }, async t => {
  const f = await fixture(t, { serverArea: true });
  await authorPackage(f); await syncServer(f);
  const db = new DatabaseSync(coreDatabasePath(f.root));
  try {
    db.exec("CREATE TABLE unrelated_unadmitted_extra(value TEXT)");
    assert.throws(() => verifyNativeSyncRootContent(f.root, "servers"));
    db.exec("DROP TABLE unrelated_unadmitted_extra");
    assert.doesNotThrow(() => verifyNativeSyncRootContent(f.root, "servers"));
    const journal = join(f.root, originalMcpJournal), before = await readFile(journal);
    await writeFile(journal, before.toString().replace(f.plan.planSha256, "e".repeat(64)), { mode: 0o600 });
    assert.throws(() => verifyNativeSyncRootContent(f.root, "servers"));
    await writeFile(journal, before, { mode: 0o600 });
    assert.doesNotThrow(() => verifyNativeSyncRootContent(f.root, "servers"));
    const hostRow = db.prepare("SELECT * FROM original_mcp_native_host_admissions LIMIT 1").get();
    const hostTrigger = db.prepare("SELECT sql FROM sqlite_master WHERE name='original_mcp_native_host_admissions_no_update'").get().sql;
    const replaceHost = payload => {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("DROP TRIGGER original_mcp_native_host_admissions_no_update");
        db.prepare("UPDATE original_mcp_native_host_admissions SET payload=? WHERE receipt_sha256=?")
          .run(payload, hostRow.receipt_sha256);
        db.exec(hostTrigger); db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    };
    replaceHost(JSON.stringify({ ...JSON.parse(hostRow.payload), workspaceId: randomUUID() }));
    assert.throws(() => verifyNativeSyncRootContent(f.root, "servers"));
    replaceHost(hostRow.payload);
    assert.doesNotThrow(() => verifyNativeSyncRootContent(f.root, "servers"));
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DROP TRIGGER legacy_action_catalog_admissions_no_update");
      db.exec("UPDATE legacy_action_catalog_admissions SET payload_sha256='" + "f".repeat(64) + "'");
      db.exec("CREATE TRIGGER legacy_action_catalog_admissions_no_update BEFORE UPDATE ON legacy_action_catalog_admissions BEGIN SELECT RAISE(ABORT,'original Action package admission immutable'); END");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    assert.throws(() => verifyNativeSyncRootContent(f.root, "servers"), /catalog|admission|custody|digest/i);
  } finally { db.close(); }
});
