import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Run with tests/framework/isolate.py; no quiescence bypass.");
process.umask(0o077);
const root = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(import.meta.url);
const hash = value => createHash("sha256").update(value).digest("hex");
async function fixture(t, { nativeUi = false } = {}) {
  const directory = join(root, ".migration-test-work", `original-room-${randomUUID()}`);
  const sourceRoot = join(directory, "root"), extension = join(directory, "original-extension");
  const endpoint = join(root, `.room-${randomBytes(5).toString("hex")}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let opened, host, authority, server, socket, nativeProducer;
  const nativeLifetime = new AbortController(), nativeChoices = [], nativePrompts = [];
  const nativeRequests = new Map();
  t.after(async () => {
    nativeLifetime.abort(); nativeProducer?.dispose();
    authority?.dispose(); socket?.destroy(); await server?.close();
    await host?.close(); await opened?.owner.close();
    await rm(endpoint, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  const { buildSync } = require("esbuild");
  buildSync({ entryPoints: [join(root, "src/storage-worker.ts")], bundle: true, platform: "node", format: "esm",
    packages: "external", outfile: join(directory, "storage-worker.js"), logLevel: "silent" });
  buildSync({ stdin: { contents: `
    export {captureOriginalMcpCustody,openOriginalMcpRoot} from "./src/original-mcp-root";
    export {inspectOriginalMcpRoomSource} from "./src/original-mcp-room-source";
    export {createOriginalMcpNativeRoomAuthority,assertOriginalMcpNativeRoomAuthority,assertOriginalMcpNativeRoomHostGrant} from "./src/original-mcp-native-room-authority";
    export {createOriginalMcpRoomPublicPort} from "./src/original-mcp-room-public";
    export {createNativePublicOwnerBackend} from "./src/native-public-mcp-owner";
    export {consumeLegacyChatroomHostGrant} from "./src/legacy-chatroom-host-authority";
    export {originalNativeRoomMethods,originalNativeRoomHostPurpose} from "./src/original-mcp-native-room-contracts";
    export {startOriginalMcpNativeAttachmentServer} from "./src/original-mcp-native-attachment";
    export {originalMcpNativeIdentity,originalMcpNativeAttestationMessage} from "./src/original-mcp-native-identity";
    export {originalMcpNativeRequestMethods,originalMcpNativeRequestProtocol,originalMcpNativeRequestSession,
      originalMcpNativeResult,originalMcpNativeErrorResult,createOriginalMcpNativeRequestPolicy,waitForOriginalMcpNativeSupport} from "./src/original-mcp-native-request";
    export {createOriginalMcpNativeHost,withOriginalMcpPublicRequest,originalMcpRequestDigest} from "./src/original-mcp-native-host";
    export {originalPublicMcpContracts} from "./src/native-public-original-mcp-contracts";
    `.replace(/from "\.\/src\/([^"]+)"/g, (_match, name) =>
      `from "${pathToFileURL(join(root, "dist", `${name}.js`)).href}"`),
    resolveDir: root }, bundle: false, platform: "node", format: "esm", packages: "external",
    outfile: join(directory, "native.mjs"), logLevel: "silent" });
  const api = await import(pathToFileURL(join(directory, "native.mjs")));
  const baseline = process.env.PKM_LEGACY_VSIX || join(root, "../personal-knowledge-vscode/personal-knowledge-4.0.22.vsix");
  assert.equal(hash(await readFile(baseline)), "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
  for (const name of ["chat-persistence.js", "chat-persistence-worker.js", "chatroom/chat-persistence.js",
    "chatroom/chat-persistence-worker.js", "chatroom/meeting-state.js", "chatroom/chat-room-credentials.js",
    "runtime/cross-process-lock.js", "sql-wasm.js", "sql-wasm.wasm"]) {
    const target = join(extension, "dist", name);
    await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
    await writeFile(target, execFileSync("unzip", ["-p", baseline, `extension/dist/${name}`]));
  }
  await writeFile(join(extension, "package.json"), '{"type":"commonjs"}');
  const originalCredentials = require(join(extension, "dist/chatroom/chat-room-credentials.js"));
  const values = new Map(), listeners = new Set(), changed = key => { for (const listener of listeners) listener({ key }); };
  const profile = { async get(key) { return values.get(key); },
    async store(key, value) { values.set(key, value); changed(key); }, async delete(key) { values.delete(key); changed(key); },
    onDidChange(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; } };
  const credentials = new originalCredentials.ChatRoomCredentialStore(profile);
  const originalRoom = require("../legacy/tests/next-trial-electron/chatroom-live-fixture.cjs");
  await mkdir(sourceRoot, { mode: 0o700 });
  await originalRoom.create({ extension, root: sourceRoot, credentials: await credentials.create(originalRoom.roomId),
    hostParticipantId: "historic-human" });
  const Store = require(join(extension, "dist/chatroom/meeting-state.js")).MeetingStateStore;
  const meetings = new Store(join(sourceRoot, "chatrooms"), join(sourceRoot, "notes"));
  const active = await meetings.startMeeting({ roomId: originalRoom.roomId, roomName: "Original private Room",
    title: "Native original private Room", problemStatement: "Retain exact private source", owner: "Historic Human",
    lead: "Historic Human", recorder: "Historic Human", participants: ["Historic Human", "Historic Agent"],
    host: "Historic Human", triggerMessageId: "history-human", requestId: "private-start", expectedRevision: 0 });
  await meetings.adjournMeeting({ roomId: originalRoom.roomId, meetingId: active.id, actor: "Historic Human",
    requestId: "private-adjourn", expectedRevision: active.revision });
  const notePath = join(sourceRoot, "notes", active.markdownPath);
  await writeFile(notePath, Buffer.concat([await readFile(notePath), Buffer.from("\nOriginal private manual annotation — preserve bytes.\n")]));
  await mkdir(join(sourceRoot, ".pkm"), { mode: 0o700 });
  await writeFile(join(sourceRoot, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}');
  const originalDb = await readFile(join(sourceRoot, "chatrooms", originalRoom.roomId, "chatroom.db"));
  const originalNote = await readFile(notePath);
  const profileSha256 = hash("original-room-private-fixture-profile");
  const plan = await api.captureOriginalMcpCustody({ root: sourceRoot, backup: join(directory, "custody"),
    operatorId: "original-room-fixture", profileSha256,
    limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16777216, maxFileBytes: 8388608 } });
  opened = await api.openOriginalMcpRoot(plan);
  const keys = generateKeyPairSync("ed25519");
  const identity = api.originalMcpNativeIdentity(
    createPublicKey(keys.privateKey).export({ format: "der", type: "spki" }).toString("base64"), profileSha256);
  await mkdir(endpoint, { mode: 0o700 });
  const binding = { root: sourceRoot, workspaceId: opened.workspaceId, planSha256: plan.planSha256,
    catalogSha256: api.originalPublicMcpContracts().provenance.metadataSha256, profileSha256,
    payloadBuildId: hash("Room-fixture-payload"), hostEntrySha256: hash("Room-fixture-host") };
  server = await api.startOriginalMcpNativeAttachmentServer({ directory: endpoint, identity, identitySha256: identity.sha256,
    binding, maxPacketBytes: 65536,     heartbeatIntervalMs: 100, heartbeatTimeoutMs: nativeUi ? 10000 : 1000 });
  socket = connect(join(endpoint, "n"));
  let buffer = "", attachedResolve, replyFailure;
  const frames = [], controls = { sourceAllowed: true };
  const attached = new Promise(resolve => { attachedResolve = resolve; });
  const sourceDecisionId = randomUUID();
  const send = value => socket.write(JSON.stringify(value) + "\n");
  async function reply(frame) {
    frames.push(frame);
    let result;
    if (frame.method === "admission.approve" || frame.method === "public.approve") result = { decision: "approve" };
    else if (nativeProducer && frame.method.startsWith("room.")) {
      const cancellation = new AbortController(); nativeRequests.set(frame.requestId, cancellation);
      try {
        result = await nativeProducer.handle(frame.method, frame.payload, frame.requestId,
          AbortSignal.any([cancellation.signal, nativeLifetime.signal]));
      } catch (error) {
        if (!socket.destroyed) send(api.originalMcpNativeErrorResult(frame,
          error?.code === "NATIVE_ROOM_CANCELLED" ? "NATIVE_REQUEST_CANCELLED" : "NATIVE_HANDLER_FAILED"));
        return;
      } finally { nativeRequests.delete(frame.requestId); }
    }
    else if (frame.method === "room.source.approve") result = controls.sourceAllowed
      ? { decisionId: sourceDecisionId, expiresAtMs: Date.now() + 60000 } : null;
    else if (frame.method === "room.host.prove") {
      const { source, challenge } = frame.payload;
      assert.equal(await credentials.verifyHost(source.roomId, source.hostCredentialHash), true);
      const proof = await credentials.createHostProof(source.roomId, api.originalNativeRoomHostPurpose(frame.payload));
      result = { challenge, sourceDecisionId, sourceSha256: source.sourceSha256,
        hostParticipantId: source.hostParticipantId, hostCredentialHash: source.hostCredentialHash,
        joinSecretHash: source.joinSecretHash, proof };
    } else throw new Error(`Unexpected method ${frame.method}`);
    send(api.originalMcpNativeResult(frame, result));
  }
  socket.on("error", () => socket.destroy());
  socket.once("close", () => nativeLifetime.abort());
  socket.on("data", chunk => {
    buffer += chunk.toString("utf8");
    let boundary;
    while ((boundary = buffer.indexOf("\n")) >= 0) {
      const frame = JSON.parse(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1);
      if (frame.type === "challenge") {
        const { body, message } = api.originalMcpNativeAttestationMessage(frame.challenge, identity.sha256, randomUUID());
        send({ type: "attestation", attestation: { ...body, signature: sign(null, message, keys.privateKey).toString("base64") } });
      } else if (frame.type === "attached") attachedResolve();
      else if (frame.type === "ping") send({ type: "pong", nonce: frame.nonce });
      else if (frame.type === "native-cancel") nativeRequests.get(frame.requestId)?.abort();
      else if (frame.type === "native-request") void reply(frame).catch(error => { replyFailure = error; socket.destroy(); });
    }
  });
  await attached;
  const session = await server.waitForSession({ timeoutMs: 1000 });
  let statusOracle;
  if (nativeUi) {
    const resources = join(extension, "next-runtime/server/legacy/resources"), files = {};
    await mkdir(resources, { recursive: true, mode: 0o700 });
    for (const name of ["chat_server.py.template", "mcp_call_guard.py"]) {
      const bytes = execFileSync("unzip", ["-p", baseline, `extension/resources/${name}`]);
      await writeFile(join(resources, name), bytes);
      files[`server/legacy/resources/${name}`] = hash(bytes);
    }
    await writeFile(join(extension, "next-runtime/manifest.json"), JSON.stringify({ files }));
    const build = await require("esbuild").build({
      entryPoints: [join(root, "clients/vscode-host/original-mcp-native-room.ts")],
      bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false, logLevel: "silent",
      plugins: [{ name: "original-room-native-ui-fixture", setup(plugin) {
        plugin.onResolve({ filter: /original-mcp-native-identity\.js$/ }, () => ({ path: "room-signed-ui-fixture", external: true }));
        plugin.onResolve({ filter: /chat-room-credentials\.js$/ }, () => ({ path: "room-original-ui-credentials", external: true }));
      } }],
    });
    const load = Module._load, name = join(directory, "native-room-ui-memory.cjs");
    let producerApi;
    try {
      Module._load = function (id, ...args) {
        if (id === "room-signed-ui-fixture") return { originalMcpNativeSigner: async () => ({
          activationId: session.activationId, identity, payloadBuildId: binding.payloadBuildId,
          hostEntrySha256: binding.hostEntrySha256, signal: nativeLifetime.signal,
          assertCurrent() { if (nativeLifetime.signal.aborted) throw new Error("Native UI fixture revoked."); },
        }) };
        if (id === "room-original-ui-credentials") return originalCredentials;
        if (id === "vscode") return {
          workspace: { isTrusted: true, onDidChangeWorkspaceFolders() { return { dispose() {} }; } },
          commands: { registerCommand() { return { dispose() {} }; } }, StatusBarAlignment: { Left: 1 },
          window: { showWarningMessage(title, options) {
            nativePrompts.push({ title, detail: JSON.parse(options.detail) }); return nativeChoices.shift();
          }, showErrorMessage() {}, createStatusBarItem() { return { show() {}, dispose() {} }; } },
        };
        return load.call(this, id, ...args);
      };
      const compiled = new Module(name); compiled.filename = name; compiled.paths = Module._nodeModulePaths(root);
      compiled._compile(build.outputFiles[0].text, name); producerApi = compiled.exports;
    } finally { Module._load = load; }
    nativeProducer = await producerApi.createOriginalMcpNativeRoomProducer(
      { extensionPath: extension, secrets: profile, subscriptions: [] },
      { session: api.originalMcpNativeRequestSession(session), signal: nativeLifetime.signal,
        assertCurrent() { if (nativeLifetime.signal.aborted) throw new Error("Actual fixture attachment revoked."); },
        async close() { socket.destroy(); } });
    assert(nativeProducer.methods.includes("room.status.read"), "The actual original status payload must exist before advertising it.");
    statusOracle = args => execFileSync("python3", ["-I", "-B", "-c",
      "import asyncio,json,runpy,sys;sys.path.insert(0,sys.argv[1]);m=runpy.run_path(sys.argv[1]+'/chat_server.py.template');f=m['chat_status'];f=getattr(f,'fn',f);sys.stdout.write(asyncio.run(f(**json.loads(sys.argv[2]))))",
      resources, JSON.stringify(args)], { encoding: "utf8", env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" } });
  }
  send({ type: "native-supports", protocol: api.originalMcpNativeRequestProtocol,
    session: api.originalMcpNativeRequestSession(session), methods: [...api.originalMcpNativeRequestMethods], maxPacketBytes: 65536 });
  await api.waitForOriginalMcpNativeSupport(session, { timeoutMs: 1000 });
  host = await api.createOriginalMcpNativeHost(opened.storage, api.createOriginalMcpNativeRequestPolicy(session));
  authority = api.createOriginalMcpNativeRoomAuthority(opened.storage, host, session);
  return { api, sourceRoot, originalRoom, notePath, originalNote, originalDb, plan, opened, host, authority,
    session, frames, controls, values, profile, nativeProducer, nativeChoices, nativePrompts, statusOracle,
    failure: () => replyFailure };
}

test("same RootOwner/Core Room custody pins original participants and private manual Meeting Notes; missing shared methods stay closed",
  { timeout: 120000 }, async t => {
    const f = await fixture(t), { storage } = f.opened;
    const full = await f.opened.owner.ensureFull();
    assert.equal(full.storage, storage, "Room must reuse the actual canonical RootOwner/Storage, not a second owner.");
    const info = await full.runtime.core.dispatch("server_info", {}, { id: "mcp:external", canWrite: false });
    assert.equal(info.result.workspaceId, f.opened.workspaceId);
    f.api.assertOriginalMcpNativeRoomAuthority(f.authority, storage, f.host);
    assert.throws(() => f.api.assertOriginalMcpNativeRoomAuthority({ ...f.authority }, storage, f.host), /AUTHORITY_REQUIRED/);
    assert.throws(() => f.api.assertOriginalMcpNativeRoomHostGrant({}, storage, f.host, f.originalRoom.roomId), /CURRENT_HOST_GRANT_REQUIRED/);
    const source = await f.api.inspectOriginalMcpRoomSource(storage, f.host, f.originalRoom.roomId);
    assert.equal(source.hostParticipantId, "historic-human");
    assert.equal(source.ownerInstallationId, "synthetic-old-live");
    assert.equal(source.messages, 3); assert.equal(source.participants, 2);
    assert.equal(source.meetings, 1); assert.equal(source.privateNotes, 1);
    assert(source.files.some(file => file.path.startsWith("notes/Chatroom Meetings/") && file.sha256 === hash(f.originalNote)));
    assert(!JSON.stringify(source).includes("Original private manual annotation"));
    await assert.rejects(f.authority.proveHost(f.originalRoom.roomId), /SOURCE_REQUIRED/);
    const integrated = f.api.originalNativeRoomMethods.every(method => f.api.originalMcpNativeRequestMethods.includes(method));
    if (!integrated) {
      await assert.rejects(f.authority.admit(f.originalRoom.roomId), { code: "MISSING_NATIVE_METHOD" });
      assert.throws(() => f.authority.assertSource(f.originalRoom.roomId), /SOURCE_REQUIRED/);
      assert.equal(f.frames.filter(frame => frame.method.startsWith("room.")).length, 0);
      t.diagnostic("Shared Room signed methods are not composed: exact source/proof admission is implemented but held, not installed/full Room evidence.");
    } else {
      await f.authority.admit(f.originalRoom.roomId);
      assert.equal(f.authority.assertSource(f.originalRoom.roomId).sourceSha256, source.sourceSha256);
      const grant = await f.authority.proveHost(f.originalRoom.roomId);
      f.api.assertOriginalMcpNativeRoomHostGrant(grant, storage, f.host, f.originalRoom.roomId);
      assert.equal(await f.api.consumeLegacyChatroomHostGrant(grant, {
        root: f.sourceRoot, workspaceId: f.opened.workspaceId, actorId: "mcp:external", roomId: f.originalRoom.roomId,
        sourceFingerprint: source.sourceFingerprint, operation: "reopen",
      }), undefined, "A new native proof grant must never become raw legacy rehost credentials.");
      assert.throws(() => f.api.assertOriginalMcpNativeRoomHostGrant({ ...grant }, storage, f.host, f.originalRoom.roomId),
        /CURRENT_HOST_GRANT_REQUIRED/);
      f.authority.revoke(f.originalRoom.roomId);
      assert.equal(grant.signal.aborted, true);
      assert.throws(() => f.api.assertOriginalMcpNativeRoomHostGrant(grant, storage, f.host, f.originalRoom.roomId), /SOURCE_REVOKED/);
      await f.authority.admit(f.originalRoom.roomId);
      f.controls.sourceAllowed = false;
      await assert.rejects(f.authority.admit(f.originalRoom.roomId), /SOURCE_DENIED/);
      assert.throws(() => f.authority.assertSource(f.originalRoom.roomId), /SOURCE_REQUIRED/);
      f.controls.sourceAllowed = true; await f.authority.admit(f.originalRoom.roomId);
    }
    assert.equal(f.failure(), undefined);
    assert.deepEqual(await readFile(join(f.sourceRoot, "chatrooms", f.originalRoom.roomId, "chatroom.db")), f.originalDb);
    assert.deepEqual(await readFile(f.notePath), f.originalNote);
    await writeFile(f.notePath, Buffer.concat([f.originalNote, Buffer.from("\nLater private manual edit, never overwrite.\n")]));
    await assert.rejects(f.api.inspectOriginalMcpRoomSource(storage, f.host, f.originalRoom.roomId), /changed/i);
    assert((await readFile(f.notePath)).includes(Buffer.from("Later private manual edit")));
    await f.session.close();
    assert.throws(() => f.authority.assertSource(f.originalRoom.roomId));
  });

test("exact public status uses actual original producer over the signed source/current-native credential path; no joined client is invented",
  { timeout: 120000 }, async t => {
    const f = await fixture(t, { nativeUi: true }), { storage } = f.opened, roomId = f.originalRoom.roomId;
    const full = await f.opened.owner.ensureFull();
    assert.equal(full.storage, storage);
    const info = await full.runtime.core.dispatch("server_info", {}, { id: "mcp:external", canWrite: false });
    assert.equal(info.result.workspaceId, f.opened.workspaceId);
    f.nativeChoices.push("Admit this private Room source only");
    await f.authority.admit(roomId);
    const port = f.api.createOriginalMcpRoomPublicPort(storage, f.host, f.authority, roomId);
    const backend = f.api.createNativePublicOwnerBackend(f.opened.owner,
      { actor: { id: "mcp:external", canWrite: false }, originalMcpHost: f.host });
    t.after(() => backend.close());
    await assert.rejects(port.dispatch("mcp.tool.chat_status", {}), { code: "NATIVE_ROOM_EXACT_PUBLIC_REQUEST_REQUIRED" });
    const dispatch = async args => (await backend.invoke("original_mcp_public",
      { tool: "chat_status", arguments: args })).structuredContent;
    for (const args of [{}, { name: "Historic Agent 雪 'not rejoined'" }]) {
      f.nativeChoices.push("Verify current Room Host", "Read this exact Room client status");
      const result = await dispatch(args);
      assert.deepEqual(result, { result: f.statusOracle(args) });
      const request = f.frames.filter(frame => frame.method === "room.status.read").at(-1);
      assert.deepEqual(request.payload.arguments, args);
      assert.equal(request.payload.noNetwork, true); assert.equal(request.payload.noRehost, true);
      assert.equal(request.payload.noParticipantChange, true);
    }
    assert.equal(f.nativePrompts.filter(prompt => prompt.title === "Read this exact original Room client status?").length, 2);
    const bytes = JSON.stringify(f.frames);
    for (const [key, secret] of f.values) if (/\.host$|\.join$/.test(key))
      assert(!bytes.includes(secret), "No native Host/join secret may reach the Node signed protocol.");
    f.nativeChoices.push("Verify current Room Host");
    const grant = await f.authority.proveHost(roomId);
    const scoped = work => f.api.withOriginalMcpPublicRequest(storage, f.host, {
      operation: "mcp.tool.chat_status", version: 1, tool: "chat_status", readOnly: true,
      arguments: {}, argumentsDigest: f.api.originalMcpRequestDigest({}),
    }, work);
    f.nativeChoices.push("Deny");
    await assert.rejects(scoped(() => f.authority.readStatus(roomId, grant, {})), /NATIVE_ROOM_STATUS_DENIED/);
    await assert.rejects(scoped(() => f.authority.readStatus(roomId, grant, {})), /HOST_EXECUTION_REPLAY/);
    const consumed = f.frames.filter(frame => frame.method === "room.status.read").at(-1);
    await assert.rejects(f.nativeProducer.handle("room.status.read", { ...consumed.payload, challenge: randomUUID() },
      randomUUID(), new AbortController().signal), /CURRENT_HOST_GRANT_REQUIRED/);
    let late;
    f.nativeChoices.push("Verify current Room Host", new Promise(resolve => { late = resolve; }));
    const before = f.nativePrompts.length, pending = dispatch({});
    const refused = assert.rejects(pending);
    while (f.nativePrompts.length < before + 2) await new Promise(resolve => setImmediate(resolve));
    await f.profile.delete(`personalKnowledge.chatroom.${roomId}.host`);
    await refused; late("Read this exact Room client status");
    assert.throws(() => f.authority.assertSource(roomId));
    const promptsAfterRevocation = f.nativePrompts.length;
    await assert.rejects(dispatch({}));
    assert.equal(f.nativePrompts.length, promptsAfterRevocation, "A cached public port must not reuse revoked source/Host authority.");
    assert.deepEqual(await readFile(join(f.sourceRoot, "chatrooms", roomId, "chatroom.db")), f.originalDb);
    assert.deepEqual(await readFile(f.notePath), f.originalNote);
    assert.equal(f.failure(), undefined);
  });
