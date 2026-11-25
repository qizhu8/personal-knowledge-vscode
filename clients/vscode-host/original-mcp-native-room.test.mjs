import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url)), require = createRequire(import.meta.url);
const { build } = require("esbuild");
const built = await build({
  entryPoints: [join(root, "clients/vscode-host/original-mcp-native-room.ts")],
  bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false, metafile: true, logLevel: "silent",
  plugins: [{ name: "room-native-fixture", setup(plugin) {
    plugin.onResolve({ filter: /original-mcp-native-identity\.js$/ }, () => ({ path: "room-fixture-signer", external: true }));
    plugin.onResolve({ filter: /chat-room-credentials\.js$/ }, () => ({ path: "room-original-credentials", external: true }));
  } }],
});
assert(!Object.keys(built.metafile.inputs).some(path =>
  /(?:storage|original-mcp-native-host|original-mcp-native-room-authority|retained-runtime)\.ts$/.test(path)));
const contractBuild = await build({ entryPoints: [join(root, "src/original-mcp-native-room-contracts.ts")],
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent" });
function compile(text, name) {
  const compiled = new Module(name);
  compiled.filename = name; compiled.paths = Module._nodeModulePaths(root);
  compiled._compile(text, name); return compiled.exports;
}
const contracts = compile(contractBuild.outputFiles[0].text, join(root, "room-contracts-memory.cjs"));
const baseline = process.env.PKM_LEGACY_VSIX || join(root, "../personal-knowledge-vscode/personal-knowledge-4.0.22.vsix");
assert.equal(createHash("sha256").update(readFileSync(baseline)).digest("hex"),
  "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
const original = compile(execFileSync("unzip", ["-p", baseline, "extension/dist/chatroom/chat-room-credentials.js"]).toString(),
  join(root, "room-original-credentials-memory.cjs"));
const sourceYes = "Admit this private Room source only", hostYes = "Verify current Room Host";
async function fixture(t) {
  const choices = [], prompts = [], commands = new Map(), bars = [], attachment = new AbortController(), signed = new AbortController();
  const values = new Map(), secretAccess = [], secretListeners = new Set();
  const secretChanged = key => { for (const listener of secretListeners) listener({ key }); };
  const secrets = { async get(key) { secretAccess.push(key); return values.get(key); },
    async store(key, value) { values.set(key, value); secretChanged(key); },
    async delete(key) { values.delete(key); secretChanged(key); },
    onDidChange(listener) { secretListeners.add(listener); return { dispose() { secretListeners.delete(listener); } }; } };
  const store = new original.ChatRoomCredentialStore(secrets), roomId = randomUUID();
  const keys = await store.create(roomId);
  const epoch = randomUUID(), session = {
    brokerId: randomUUID(), activationId: epoch, epoch, identitySha256: "a".repeat(64),
    binding: { root: "/private/original-room", workspaceId: randomUUID(), planSha256: "b".repeat(64),
      catalogSha256: "c".repeat(64), profileSha256: "d".repeat(64), payloadBuildId: "e".repeat(64), hostEntrySha256: "f".repeat(64) },
  };
  const binding = { schema: "pkm.original-mcp-native-host-admission/v1", root: session.binding.root,
    workspaceId: session.binding.workspaceId, planSha256: session.binding.planSha256, profileSha256: session.binding.profileSha256,
    sourceCatalogSha256: session.binding.catalogSha256, authorityId: `native-rpc:${session.brokerId}`,
    epoch, actorId: "mcp:external", domains: ["mcp-public"], configurationSha256: "1".repeat(64) };
  const body = { schema: "pkm.original-native-room-source/v1", root: binding.root, workspaceId: binding.workspaceId,
    custodyPlanSha256: binding.planSha256, profileSha256: binding.profileSha256, nativeHostReceiptSha256: contracts.originalNativeRoomDigest(binding),
    roomId, roomName: "Original private Room", sourceFingerprint: "2".repeat(64), meetingSha256: "3".repeat(64),
    participantSha256: "4".repeat(64), ownerInstallationId: "original-installation", hostParticipantId: "original-host",
    projectId: "original-project", threadId: "original-thread", hostCredentialHash: keys.hostCredentialHash,
    joinSecretHash: keys.joinSecretHash, messages: 3, participants: 2, meetings: 1, privateNotes: 1,
    files: [{ path: `chatrooms/${roomId}/chatroom.db`, sha256: "5".repeat(64) },
      { path: "notes/Chatroom Meetings/private.md", sha256: "6".repeat(64) }] };
  const source = { ...body, sourceSha256: contracts.originalNativeRoomDigest(body) };
  let trusted = true, changed, alive = true, closes = 0;
  const signer = { activationId: epoch, identity: { sha256: session.identitySha256, profileSha256: session.binding.profileSha256 },
    payloadBuildId: session.binding.payloadBuildId, hostEntrySha256: session.binding.hostEntrySha256, signal: signed.signal,
    assertCurrent() { if (!alive) throw new Error("Signer changed."); } };
  const load = Module._load, context = { secrets, subscriptions: [] };
  let api;
  try {
    Module._load = function (id, ...args) {
      if (id === "room-fixture-signer") return { originalMcpNativeSigner: async () => signer };
      if (id === "room-original-credentials") return original;
      if (id === "vscode") return {
        StatusBarAlignment: { Left: 1 }, commands: { registerCommand(name, callback) {
          commands.set(name, callback); return { dispose() { commands.delete(name); } };
        } },
        workspace: { get isTrusted() { return trusted; }, onDidChangeWorkspaceFolders(callback) {
          changed = callback; return { dispose() {} };
        } },
        window: { showWarningMessage(title, options) {
          prompts.push({ title, detail: JSON.parse(options.detail) }); return choices.shift();
        }, showErrorMessage() {}, createStatusBarItem() {
          const bar = { show() {}, dispose() { bar.disposed = true; } }; bars.push(bar); return bar;
        } },
      };
      return load.call(this, id, ...args);
    };
    api = compile(built.outputFiles[0].text, join(root, "clients/vscode-host/room-producer-memory.cjs"));
  } finally { Module._load = load; }
  const producer = await api.createOriginalMcpNativeRoomProducer(context, { session, signal: attachment.signal,
    assertCurrent() { if (!alive) throw new Error("Attachment changed."); },
    async close() { closes++; attachment.abort(); } });
  t.after(() => producer.dispose());
  const payload = { binding, source, noExecution: true };
  const handle = (method, value, id = randomUUID(), signal = new AbortController().signal) => producer.handle(method, value, id, signal);
  const admit = async () => { choices.push(sourceYes); return handle("room.source.approve", payload); };
  const host = decision => ({ ...payload, sourceDecisionId: decision.decisionId, challenge: randomUUID() });
  return { producer, handle, admit, host, payload, session, source, values, secrets, secretAccess, keys, store,
    choices, prompts, commands, bars, signed, attachment, closes: () => closes, changed: () => changed(),
    untrust: () => { trusted = false; }, invalidate: () => { alive = false; } };
}

test("Room custody and Host authority require separate UI decisions using actual pinned original credential proofs", async t => {
  const f = await fixture(t);
  assert.equal(f.prompts.length, 0);
  await assert.rejects(f.handle("room.host.prove", f.host({ decisionId: randomUUID() })), /SOURCE_REQUIRED/);
  const admitted = await f.admit();
  assert.equal(f.prompts.length, 1);
  assert.deepEqual(f.prompts[0].detail.source, f.source);
  assert.equal(f.prompts[0].detail.noExecution, true);
  f.choices.push(hostYes);
  const payload = f.host(admitted), proof = await f.handle("room.host.prove", payload);
  assert.equal(proof.sourceDecisionId, admitted.decisionId);
  assert.equal(proof.hostParticipantId, "original-host");
  assert.equal(await f.store.verifyHostProof(f.source.roomId, f.source.hostCredentialHash,
    contracts.originalNativeRoomHostPurpose(payload), proof.proof), true);
  assert.equal(await f.store.verifyHostProof(f.source.roomId, f.source.hostCredentialHash,
    contracts.originalNativeRoomHostPurpose({ ...payload, challenge: randomUUID() }), proof.proof), false);
  const result = JSON.stringify(proof);
  assert(!result.includes(f.keys.hostCredential)); assert(!result.includes(f.keys.joinSecret));
  assert(f.secretAccess.every(key => /^personalKnowledge\.chatroom\.[a-z0-9-]+\.(host|join)$/.test(key)));
  assert.equal(f.prompts.length, 2);
  assert.equal(Object.keys(proof).sort().join(","), "challenge,hostCredentialHash,hostParticipantId,joinSecretHash,proof,sourceDecisionId,sourceSha256");
});

test("join secret, old Host token, client ID and copied source receipts cannot impersonate current Host custody", async t => {
  const f = await fixture(t), admitted = await f.admit();
  const key = `personalKnowledge.chatroom.${f.source.roomId}.host`;
  for (const impostor of [f.keys.joinSecret, "old-Hub-host-token", "historic-client-0"]) {
    f.values.set(key, impostor);
    await assert.rejects(f.handle("room.host.prove", f.host(admitted)), /CURRENT_PROFILE_HOST_REQUIRED/);
  }
  f.values.set(key, f.keys.hostCredential);
  const changed = structuredClone(f.host(admitted)); changed.source.hostParticipantId = "historic-client-0";
  const { sourceSha256: _old, ...body } = changed.source;
  changed.source.sourceSha256 = contracts.originalNativeRoomDigest(body);
  await assert.rejects(f.handle("room.host.prove", changed), /SOURCE_REQUIRED/);
  await assert.rejects(f.handle("room.host.prove", { ...f.host(admitted), hostToken: "old-token" }));
  assert.equal(f.prompts.length, 1);
});

test("native profile credential removal during Host approval is rechecked and cannot produce a stale grant", async t => {
  const f = await fixture(t), admitted = await f.admit();
  let answer;
  f.choices.push(new Promise(resolve => { answer = resolve; }));
  const waiting = f.handle("room.host.prove", f.host(admitted));
  while (f.prompts.length < 2) await new Promise(resolve => setImmediate(resolve));
  f.values.delete(`personalKnowledge.chatroom.${f.source.roomId}.host`);
  answer(hostYes);
  await assert.rejects(waiting, /CURRENT_PROFILE_HOST_REQUIRED/);
});

test("Room cancellation/revocation closes the actual signed session and discards late UI decisions", async t => {
  const f = await fixture(t), admitted = await f.admit();
  let answer; f.choices.push(new Promise(resolve => { answer = resolve; }));
  const waiting = f.handle("room.host.prove", f.host(admitted)), rejected = assert.rejects(waiting, /CANCELLED/);
  while (f.prompts.length < 2) await new Promise(resolve => setImmediate(resolve));
  await f.commands.get(f.bars[0].command)(); await rejected; answer(hostYes);
  assert.equal(f.closes(), 1); assert.equal(f.attachment.signal.aborted, true);
  assert.equal(f.bars[0].disposed, true);
  await assert.rejects(f.admit(), /CANCELLED/);
});

test("native SecretStorage Host/join changes revoke the signed session; unrelated credentials do not", async t => {
  for (const key of ["host", "join"]) {
    const f = await fixture(t); await f.admit();
    await f.secrets.store("unrelated.native-profile.setting", "unchanged Room authority");
    assert.equal(f.closes(), 0);
    await f.secrets.delete(`personalKnowledge.chatroom.${f.source.roomId}.${key}`);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.closes(), 1); assert.equal(f.attachment.signal.aborted, true);
    await assert.rejects(f.admit(), /CANCELLED/);
  }
});

test("Room contracts reject changed root/profile/participant/Meeting source and never truncate exact approval", async t => {
  const f = await fixture(t);
  for (const key of ["root", "profileSha256", "custodyPlanSha256", "nativeHostReceiptSha256"]) {
    const changed = structuredClone(f.payload); changed.source[key] = key === "root" ? "/other-root" : "0".repeat(64);
    await assert.rejects(f.handle("room.source.approve", changed), /BINDING_MISMATCH/);
  }
  for (const key of ["hostParticipantId", "ownerInstallationId", "participantSha256", "meetingSha256"]) {
    const changed = structuredClone(f.payload); changed.source[key] = "0".repeat(64);
    await assert.rejects(f.handle("room.source.approve", changed), /SOURCE_CHANGED/);
  }
  const large = structuredClone(f.payload);
  large.source.files = Array.from({ length: 2000 }, (_, index) =>
    ({ path: `notes/Chatroom Meetings/private-${index}.md`, sha256: "9".repeat(64) }));
  const { sourceSha256: _old, ...body } = large.source; large.source.sourceSha256 = contracts.originalNativeRoomDigest(body);
  await assert.rejects(f.handle("room.source.approve", large), { code: "NATIVE_REQUEST_TOO_LARGE" });
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(f.handle("room.source.approve", f.payload, randomUUID(), cancelled.signal), /CANCELLED/);
  assert.equal(f.prompts.length, 0);
});

test("native producer restart retains credentials but never source or Host permission", async t => {
  const first = await fixture(t), decision = await first.admit(), second = await fixture(t);
  await assert.rejects(second.handle("room.host.prove", { ...second.payload,
    sourceDecisionId: decision.decisionId, challenge: randomUUID() }), /SOURCE_REQUIRED/);
  assert.equal(second.prompts.length, 0);
  await first.producer.revoke();
});

test("status is not advertised without its retained producer and the new read DTO cannot smuggle execution/credential authority", async t => {
  const f = await fixture(t);
  assert(!f.producer.methods.includes("room.status.read"));
  const { noExecution: _noExecution, ...base } = f.payload;
  const payload = { ...base, sourceDecisionId: randomUUID(), hostChallenge: randomUUID(), challenge: randomUUID(),
    operation: "mcp.tool.chat_status", arguments: { name: "original alias" },
    argumentsSha256: contracts.originalNativeRoomDigest({ name: "original alias" }),
    noNetwork: true, noRehost: true, noParticipantChange: true };
  assert.doesNotThrow(() => contracts.parseOriginalNativeRoomPayload("room.status.read", payload, f.session));
  assert.throws(() => contracts.parseOriginalNativeRoomPayload("room.status.read",
    { ...payload, arguments: { name: "different alias" } }, f.session), /ARGUMENTS_CHANGED/);
  for (const change of [{ noNetwork: false }, { noRehost: false }, { noParticipantChange: false },
    { hostCredential: f.keys.hostCredential }, { operation: "mcp.tool.chat_join" }])
    assert.throws(() => contracts.parseOriginalNativeRoomPayload("room.status.read", { ...payload, ...change }, f.session));
  await assert.rejects(f.handle("room.status.read", payload), { code: "MISSING_NATIVE_METHOD" });
  assert.equal(f.prompts.length, 0);
});
