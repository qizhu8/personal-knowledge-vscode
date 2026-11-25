import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync, fork } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect } from "node:net";
import test from "node:test";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Use the existing private Linux PID/network framework.");
process.umask(0o077);
const project = resolve("."), require = createRequire(import.meta.url), build = require("esbuild").buildSync;
const hash = value => createHash("sha256").update(value).digest("hex");
function userMagicLink(endpoint, room, secret, roomId) {
  const payload = Buffer.from(JSON.stringify({ v: 1, u: `${endpoint}/${encodeURIComponent(room)}`, s: secret, r: roomId })).toString("base64url");
  return `pkchat:v1:${payload}.${createHash("sha256").update(payload).digest("base64url").slice(0, 16)}`;
}
async function listenerClosed(port) {
  const until = Date.now() + 6000;
  for (;;) {
    const closed = await new Promise(resolve => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(false); });
      socket.once("error", error => resolve(error.code === "ECONNREFUSED"));
    });
    if (closed) return;
    assert(Date.now() < until, "Losing the authenticated persistence watch must close the actual native listener promptly.");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture(t, { userProvidedJoinSecret } = {}) {
  const directory = join(project, ".migration-test-work", `room-session-${randomUUID()}`);
  const extension = join(directory, "original"), root = join(directory, "root");
  const endpoint = join(project, `.rsa-${randomBytes(4).toString("hex")}`);
  const persistenceEndpoint = join(project, `.rsp-${randomBytes(4).toString("hex")}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(endpoint, { mode: 0o700 }); await mkdir(persistenceEndpoint, { mode: 0o700 });
  let child, opened, host, authority, server, corePort, coreServer;
  const requests = new Map();
  t.after(async () => {
    try { await coreServer?.close(); } finally {
      await corePort?.close(); authority?.dispose(); await host?.close(); await server?.close(); await opened?.owner.close();
    }
    if (child) {
      if (child.connected) child.disconnect();
      if (child.exitCode === null && child.signalCode === null)
        await new Promise(resolve => child.once("exit", resolve));
    }
    for (const path of [endpoint, persistenceEndpoint, directory]) await rm(path, { recursive: true, force: true });
  });
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  build({ entryPoints: [join(project, "src/storage-worker.ts")], bundle: true, platform: "node", format: "esm",
    packages: "external", outfile: join(directory, "storage-worker.js"), logLevel: "silent" });
  build({ stdin: { contents: `
    export {captureOriginalMcpCustody,openOriginalMcpRoot} from "./src/original-mcp-root";
    export {createOriginalMcpNativeRoomAuthority} from "./src/original-mcp-native-room-authority";
    export {LegacyChatroomRuntime} from "./src/legacy-chatroom-runtime";
    export {approveOriginalRoomLoopbackSession} from "./src/original-mcp-room-session-authority";
    export {createOriginalRoomSessionPersistence,startOriginalRoomSessionPersistenceServer} from "./src/original-mcp-room-session-persistence";
    export {startOriginalMcpNativeAttachmentServer} from "./src/original-mcp-native-attachment";
    export {originalMcpNativeIdentity,originalMcpNativeAttestationMessage} from "./src/original-mcp-native-identity";
    export {originalMcpNativeRequestMethods,originalMcpNativeRequestProtocol,originalMcpNativeRequestSession,
      originalMcpNativeResult,createOriginalMcpNativeRequestPolicy,waitForOriginalMcpNativeSupport} from "./src/original-mcp-native-request";
    export {originalNativeRoomHostPurpose} from "./src/original-mcp-native-room-contracts";
    export {originalRoomSessionDigest} from "./src/original-mcp-room-session-contracts";
    export {prepareOriginalRoomUserJoin,consumeOriginalRoomUserJoin,discardOriginalRoomUserJoin,
      originalRoomUserJoinPublicApproval} from "./src/original-mcp-room-session-user-link";
    export {createOriginalMcpNativeHost} from "./src/original-mcp-native-host";
    export {originalPublicMcpContracts} from "./src/native-public-original-mcp-contracts";
    `, resolveDir: project }, bundle: true, platform: "node", format: "esm", packages: "external",
    outfile: join(directory, "api.mjs"), logLevel: "silent" });
  const api = await import(pathToFileURL(join(directory, "api.mjs")));
  const baseline = process.env.PKM_LEGACY_VSIX || resolve("../personal-knowledge-vscode/personal-knowledge-4.0.22.vsix");
  assert.equal(hash(await readFile(baseline)), "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
  for (const name of ["chat-persistence.js", "chat-persistence-worker.js", "chatroom/chat-persistence.js",
    "chatroom/chat-persistence-worker.js", "chatroom/chat-room-credentials.js", "chatroom/meeting-state.js",
    "runtime/cross-process-lock.js", "sql-wasm.js", "sql-wasm.wasm"]) {
    const target = join(extension, "dist", name); await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
    await writeFile(target, execFileSync("unzip", ["-p", baseline, `extension/dist/${name}`]));
  }
  await mkdir(join(extension, "resources"), { mode: 0o700 });
  for (const name of ["chat_server.py.template", "mcp_call_guard.py"])
    await writeFile(join(extension, "resources", name), execFileSync("unzip", ["-p", baseline, `extension/resources/${name}`]));
  await writeFile(join(extension, "package.json"), '{"type":"commonjs"}');
  const retained = join(directory, "retained.cjs");
  build({ stdin: { contents: `
    export {ChatHub} from "./src/chatroom/chatroom-hub";
    export {ChatJoinApprovalManager} from "./src/chatroom/chat-join-approval";
    export {WebSocketServer} from "ws";`, resolveDir: join(project, "legacy") },
    bundle: true, platform: "node", format: "cjs", outfile: retained, logLevel: "silent" });
  const native = join(directory, "native.cjs");
  const nativeBuild = build({ entryPoints: [join(project, "clients/vscode-host/original-mcp-native-room-session-hub.ts")],
    bundle: true, platform: "node", format: "cjs", packages: "external", metafile: true, outfile: native, logLevel: "silent" });
  assert(!Object.keys(nativeBuild.metafile.inputs).some(path =>
    /src\/(?:root-owner|storage|core|original-mcp-room-session-authority)\.ts$/.test(path)),
  "Native user-link parsing must not embed Node owner/Core authority brands.");
  const roomId = randomUUID(), profileSha256 = hash(`native-only-fixture-profile:${randomUUID()}`), activationId = randomUUID();
  child = fork(fileURLToPath(new URL("./original-mcp-room-session-native-child.mjs", import.meta.url)), [JSON.stringify({
    api: join(directory, "api.mjs"), native, retained, extension, directory, roomId, profileSha256, activationId,
  })], { cwd: directory, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Native-process fixture did not become ready.")), 10000);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer); const error = new Error(`Native-process fixture exited ${code}/${signal}`); reject(error);
      for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(error); }
      requests.clear();
    });
    child.on("message", message => {
      if (message.ready) { clearTimeout(timer); resolve(); return; }
      const pending = requests.get(message.id); if (!pending) return;
      requests.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(Object.assign(new Error(message.error.code), { code: message.error.code }));
      else pending.resolve(message.result);
    });
  });
  const ask = (operation, args = {}) => new Promise((resolve, reject) => {
    const id = randomUUID(), timer = setTimeout(() => { requests.delete(id); reject(new Error(`Native fixture timeout: ${operation}`)); }, 15000);
    requests.set(id, { resolve, reject, timer }); child.send({ id, operation, ...args });
  });
  const prepared = await ask("prepare", userProvidedJoinSecret ? { requestedJoinSecret: userProvidedJoinSecret } : {});
  assert.deepEqual(Object.keys(prepared).sort(), ["hostCredentialHash", "identity", "joinSecretHash"]);
  const original = require("../legacy/tests/next-trial-electron/chatroom-live-fixture.cjs");
  await mkdir(root, { mode: 0o700 });
  await original.create({ extension, root, roomId, credentials: prepared, hostParticipantId: "historic-human" });
  const Store = require(join(extension, "dist/chatroom/meeting-state.js")).MeetingStateStore;
  const store = new Store(join(root, "chatrooms"), join(root, "notes"));
  const meeting = await store.startMeeting({ roomId, roomName: "Original private Room", title: "Keep private original Note",
    problemStatement: "No loopback client may publish or rewrite this Meeting Note", owner: "Historic Human",
    lead: "Historic Human", recorder: "Historic Human", participants: ["Historic Human", "Historic Agent"],
    host: "Historic Human", triggerMessageId: "history-human", requestId: "private-start", expectedRevision: 0 });
  await store.adjournMeeting({ roomId, meetingId: meeting.id, actor: "Historic Human", requestId: "private-end",
    expectedRevision: meeting.revision });
  const notePath = join(root, "notes", meeting.markdownPath);
  const originalNote = Buffer.concat([await readFile(notePath), Buffer.from("\nPrivate manual Note annotation — preserve exact bytes.\n")]);
  await writeFile(notePath, originalNote);
  await mkdir(join(root, ".pkm"), { mode: 0o700 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{"notes":["Chatroom Meetings"]}}');
  const originalDb = await readFile(join(root, "chatrooms", roomId, "chatroom.db"));
  const plan = await api.captureOriginalMcpCustody({ root, backup: join(directory, "custody"),
    operatorId: "private-native-room-session-fixture", profileSha256,
    limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16777216, maxFileBytes: 8388608 } });
  opened = await api.openOriginalMcpRoot(plan);
  const binding = { root, workspaceId: opened.workspaceId, planSha256: plan.planSha256,
    catalogSha256: api.originalPublicMcpContracts().provenance.metadataSha256, profileSha256,
    payloadBuildId: hash("fixture-native-room-session"), hostEntrySha256: hash("fixture-native-room-session-entry") };
  server = await api.startOriginalMcpNativeAttachmentServer({ directory: endpoint, identity: prepared.identity,
    identitySha256: prepared.identity.sha256, binding, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 3000 });
  await ask("attach", { path: join(endpoint, "n"), binding });
  const session = await server.waitForSession({ timeoutMs: 3000 });
  await api.waitForOriginalMcpNativeSupport(session, { timeoutMs: 3000 });
  host = await api.createOriginalMcpNativeHost(opened.storage, api.createOriginalMcpNativeRequestPolicy(session));
  authority = api.createOriginalMcpNativeRoomAuthority(opened.storage, host, session);
  await authority.admit(roomId);
  const selection = { port: 18000 + Number.parseInt(randomBytes(2).toString("hex"), 16) % 40000,
    alias: "Fresh native Straße loopback agent", postText: '@"Historic Human" One exact original progress post — canonical Core.' };
  const approve = async () => api.approveOriginalRoomLoopbackSession(opened.owner, host, authority, roomId,
    await authority.proveHost(roomId), selection);
  const joinErrorOracle = args => JSON.parse(execFileSync("python3", ["-I", "-B", "-c", `
import asyncio,json,runpy,sys
sys.path.insert(0,sys.argv[1]);module=runpy.run_path(sys.argv[1]+"/chat_server.py.template")
method=module["chat_join"];method=getattr(method,"fn",method)
print(json.dumps([asyncio.run(method(**args)) for args in json.load(sys.stdin)]))
`, join(extension, "resources")], { input: JSON.stringify(args), encoding: "utf8", timeout: 10000,
    env: { PATH: process.env.PATH || "", PYTHONDONTWRITEBYTECODE: "1" } }));
  return { api, root, roomId, originalDb, notePath, originalNote, retained, opened, host, authority, ask, approve, selection, persistenceEndpoint, joinErrorOracle,
    async open(grant) {
      corePort = await api.createOriginalRoomSessionPersistence(opened.owner, host, grant);
      coreServer = await api.startOriginalRoomSessionPersistenceServer(corePort, persistenceEndpoint);
      await ask("open", { effect: grant.effect, persistence: coreServer.descriptor });
      return { corePort, coreServer };
    } };
}
test("Room effects are default-off, native tool denial grants no canonical state, and source/Host proof cannot be a persistence capability", {
  timeout: 90000,
}, async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.ask("credential-facts"), { hostBytes: 32, joinBytes: 24,
    twoGeneratedHostsDiffer: true, twoGeneratedJoinsDiffer: true });
  const full = await f.opened.owner.ensureFull();
  const info = await full.runtime.core.dispatch("server_info", {}, { id: "mcp:external", canWrite: false });
  assert.equal(info.result.workspaceId, f.opened.workspaceId);
  const proof = await f.authority.proveHost(f.roomId);
  await assert.rejects(f.api.createOriginalRoomSessionPersistence(f.opened.owner, f.host, proof),
    { code: "ROOM_SESSION_EXACT_EFFECT_GRANT_REQUIRED" });
  await assert.rejects(f.api.approveOriginalRoomLoopbackSession(f.opened.owner, f.host, f.authority, f.roomId, proof,
    { ...f.selection, alias: "Historic Human" }), { code: "ROOM_SESSION_NEW_ALIAS_REQUIRED" });
  await f.ask("allow-effects", { allow: false });
  await assert.rejects(f.approve(), { code: "ROOM_SESSION_EFFECT_DENIED" });
  const db = f.opened.storage.connectNative();
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='legacy_room_runtime_native_sessions'").get().n, 0); }
  finally { db.close(); }
  assert.deepEqual(await readFile(join(f.root, "chatrooms", f.roomId, "chatroom.db")), f.originalDb);
  assert.deepEqual(await readFile(f.notePath), f.originalNote);
});
test("native-only original client joins a fresh participant, persists read/post receipts idempotently in the actual Core, then leaves/revokes/closes", {
  timeout: 90000,
}, async t => {
  const f = await fixture(t), full = await f.opened.owner.ensureFull(), lease = { ...f.opened.owner.workspaceLease() };
  const grant = await f.approve(), { corePort, coreServer } = await f.open(grant);
  await assert.rejects(f.api.createOriginalRoomSessionPersistence(f.opened.owner, f.host, { ...grant }),
    { code: "ROOM_SESSION_EXACT_EFFECT_GRANT_REQUIRED" });
  const obsolete = new f.api.LegacyChatroomRuntime({ storage: f.opened.storage, actorId: "mcp:external",
    retained: require(f.retained), authorize: async () => false });
  try { await assert.rejects(obsolete.reopen(f.roomId), /reserved by its native-owned credential\/persistence session/); }
  finally { await obsolete.drain(); }
  const call = (tool, args, callId = randomUUID()) => f.ask("call", { callId, call: { tool, arguments: args } });
  const joined = JSON.parse((await call("chat_join", { name: f.selection.alias })).result);
  assert.equal(joined.ok, true, JSON.stringify(joined)); assert.equal(joined.status, "connected");
  assert(!["historic-human", "historic-agent"].includes(joined.participant_id));
  const status = JSON.parse((await call("chat_status", { name: f.selection.alias.replace("Straße", "STRASSE").toUpperCase() })).result);
  assert.equal(status.participant_id, joined.participant_id); assert.equal(status.members, 1);
  const baseline = JSON.parse((await call("chat_read", { name: f.selection.alias, only_new: false, limit: 0 })).result);
  assert(baseline.messages.some(message => message.id === "history-human"));
  assert.equal(JSON.parse((await call("chat_read", { name: f.selection.alias, only_new: true })).result).count, 0);
  const postId = randomUUID(), postArgs = { name: f.selection.alias, text: `  ${f.selection.postText}  `,
    continue_working: true, require_reply: false, final_topic_summary: false };
  const posted = await call("chat_post", postArgs, postId), body = JSON.parse(posted.result);
  assert.equal(body.ok, true, JSON.stringify(body)); assert.equal(body.posted, true);
  assert.equal((await call("chat_post", postArgs, postId)).result, posted.result, "Exact original response is replayed from the Core receipt.");
  await assert.rejects(call("chat_status", { name: f.selection.alias }, postId), /CLIENT_CALL_CONFLICT/);
  const readId = randomUUID(), readArgs = { name: f.selection.alias, only_new: true, limit: 50 };
  const read = await call("chat_read", readArgs, readId);
  assert(JSON.parse(read.result).messages.some(message => message.id === body.message_id && message.text === f.selection.postText));
  assert.equal((await call("chat_read", readArgs, readId)).result, read.result);
  assert.equal(JSON.parse((await call("chat_read", readArgs)).result).count, 0);
  const snapshot = await corePort.dispatch(randomUUID(), { operation: "room.snapshot" });
  assert.equal(snapshot.hostParticipantId, "historic-human");
  assert.equal(snapshot.messages.filter(message => message.participantId === joined.participant_id).length, 1);
  const persisted = snapshot.messages.find(message => message.id === body.message_id);
  assert.equal(persisted.metadata.clientRequestId, body.client_request_id);
  const replayId = randomUUID();
  await corePort.dispatch(replayId, { operation: "message.append", message: persisted });
  await corePort.dispatch(replayId, { operation: "message.append", message: persisted });
  await assert.rejects(corePort.dispatch(replayId, { operation: "message.append", message: { ...persisted, content: "changed" } }),
    /OPERATION_CONFLICT/);
  await assert.rejects(corePort.dispatch(randomUUID(), { operation: "join.resolve",
    resolution: { requestId: "historic-join-0", outcome: "reuse", participantId: "historic-human", resolvedAt: Date.now() } }));
  const left = JSON.parse((await call("chat_leave", { name: f.selection.alias })).result);
  assert.equal(left.ok, true); assert.deepEqual(left.active_aliases, []);
  assert.deepEqual(JSON.parse((await call("chat_status", {})).result), { ok: true, active_aliases: [], connections: [] });
  assert.equal((await f.opened.owner.ensureFull()).runtime.core, full.runtime.core);
  assert.deepEqual(f.opened.owner.workspaceLease(), lease);
  const db = f.opened.storage.connectNative();
  let ownerBytes;
  try {
    const calls = db.prepare("SELECT * FROM legacy_room_runtime_native_calls WHERE session_id=?").all(grant.effect.sessionId);
    assert(calls.some(row => row.call_id === readId && row.result === read.result && row.cursor_after > row.cursor_before));
    assert(calls.some(row => row.call_id === postId && row.result === posted.result));
    ownerBytes = JSON.stringify({ calls, snapshot, effect: grant.effect, descriptor: coreServer.descriptor });
  } finally { db.close(); }
  assert.equal((await f.ask("audit", { ownerBytes })).rawKeysPresent, false);
  grant.revoke();
  await coreServer.close();
  assert.equal(grant.signal.aborted, true);
  await assert.rejects(corePort.dispatch(randomUUID(), { operation: "room.snapshot" }), /CLOSED|REVOKED/);
  await listenerClosed(f.selection.port);
  assert.deepEqual(await f.ask("closed-state"), { effectRevoked: true, baseConnected: true });
  f.host.assertCurrent();
  assert.equal(f.host.signal.aborted, false, "Effect-only revocation is independent from source/Host identity admission.");
  assert.equal(f.authority.assertSource(f.roomId).roomId, f.roomId);
  await assert.rejects(call("chat_status", {}), /REVOKED|CLOSED/);
  const end = f.opened.storage.connectNative();
  try {
    assert.equal(end.prepare("SELECT state FROM legacy_room_runtime_native_sessions WHERE room_id=?").get(f.roomId).state, "closed");
    const final = JSON.parse(end.prepare("SELECT state_json FROM legacy_room_runtime_rooms WHERE room_id=?").get(f.roomId).state_json);
    assert.equal(final.state, "stored"); assert.equal(final.hostParticipantId, "historic-human");
  } finally { end.close(); }
  assert.deepEqual(await readFile(join(f.root, "chatrooms", f.roomId, "chatroom.db")), f.originalDb);
  assert.deepEqual(await readFile(f.notePath), f.originalNote);
});
test("revoking a still-joined native client closes its real transport and retires only that new participant under the same owner", {
  timeout: 90000,
}, async t => {
  const f = await fixture(t), grant = await f.approve(), { coreServer } = await f.open(grant);
  const result = await f.ask("call", { callId: randomUUID(), call: { tool: "chat_join", arguments: { name: f.selection.alias } } });
  const joined = JSON.parse(result.result); assert.equal(joined.ok, true, result.result);
  grant.revoke(); await coreServer.close(); await listenerClosed(f.selection.port);
  assert.deepEqual(await f.ask("closed-state"), { effectRevoked: true, baseConnected: true });
  f.host.assertCurrent();
  const db = f.opened.storage.connectNative();
  try {
    const state = JSON.parse(db.prepare("SELECT state_json FROM legacy_room_runtime_rooms WHERE room_id=?").get(f.roomId).state_json);
    assert.equal(state.state, "stored"); assert.equal(state.hostParticipantId, "historic-human");
    const fresh = state.identity.memberships.find(member => member.participantId === joined.participant_id);
    assert(fresh.temporary && fresh.forgottenAt);
    assert(state.identity.aliases.filter(alias => alias.participantId === joined.participant_id).every(alias => alias.releasedAt));
    assert.equal(state.identity.memberships.find(member => member.participantId === "historic-human").forgottenAt, undefined);
  } finally { db.close(); }
  assert.deepEqual(await readFile(join(f.root, "chatrooms", f.roomId, "chatroom.db")), f.originalDb);
  assert.deepEqual(await readFile(f.notePath), f.originalNote);
});
test("unchanged public user Magic Link input is forwarded once to the real original join producer, with only redacted digests durable in Core", {
  timeout: 90000,
}, async t => {
  // This is caller-originated input supplied to the original optional requestedJoinSecret contract,
  // not a value exported from native SecretStorage. The Host credential is still generated only natively.
  const userSecret = `USER_SUPPLIED_${randomBytes(24).toString("base64url")}`;
  const f = await fixture(t, { userProvidedJoinSecret: userSecret }), grant = await f.approve();
  const { corePort, coreServer } = await f.open(grant);
  const before = await corePort.dispatch(randomUUID(), { operation: "room.snapshot" });
  const valid = userMagicLink(grant.effect.endpoint, before.roomName, userSecret, f.roomId);
  const badChecksum = valid.slice(0, -1) + (valid.endsWith("a") ? "b" : "a");
  const invalid = [
    { magic_link: "not-an-original-magic-link-PRIVATE_CANARY", name: f.selection.alias },
    { magic_link: badChecksum, name: f.selection.alias },
    { magic_link: valid, name: "  " },
  ];
  const expected = f.joinErrorOracle(invalid);
  let forwards = 0;
  const transient = async (args, callId = randomUUID()) => {
    const ingress = f.api.prepareOriginalRoomUserJoin(grant, args, callId);
    const approval = f.api.originalRoomUserJoinPublicApproval(ingress);
    const evidence = JSON.stringify({ ingress, approval });
    assert(!evidence.includes(args.magic_link)); assert(!evidence.includes(userSecret));
    await f.host.authorizePublic(approval);
    const packet = f.api.consumeOriginalRoomUserJoin(ingress);
    const result = packet.kind === "forward"
      ? await f.ask("join-user", packet)
      : await f.ask("call", packet);
    if (packet.kind === "forward") forwards++;
    return { ingress, result };
  };
  for (const [index, args] of invalid.entries()) {
    const id = randomUUID(), { result } = await transient(args, id);
    assert.equal(result.result, expected[index], "Original alias/format/checksum error bytes must be preserved.");
    assert.equal((await transient(args, id)).result.result, result.result);
    assert.deepEqual(await f.ask("user-link-count"), { count: forwards });
  }
  const wrongSecret = userMagicLink(grant.effect.endpoint, before.roomName, randomBytes(24).toString("base64url"), f.roomId);
  const rejected = await transient({ magic_link: wrongSecret, name: f.selection.alias });
  assert.equal(JSON.parse(rejected.result.result).ok, false);
  assert.equal(JSON.parse(rejected.result.result).error_code, "auth", "Original Room secret verification must remain active.");
  for (const endpoint of [`ws://127.0.0.1:${f.selection.port === 65535 ? 65534 : f.selection.port + 1}`, "ws://10.23.14.9:18000"]) {
    const other = userMagicLink(endpoint, before.roomName, userSecret, f.roomId);
    assert.throws(() => f.api.prepareOriginalRoomUserJoin(grant, { magic_link: other, name: f.selection.alias }),
      /ENDPOINT_APPROVAL_REQUIRED/);
  }
  assert.throws(() => f.api.prepareOriginalRoomUserJoin(grant, { magic_link: valid, name: "Historic Human" }),
    /PARTICIPANT_APPROVAL_REQUIRED/);
  const discarded = f.api.prepareOriginalRoomUserJoin(grant, { magic_link: valid, name: f.selection.alias });
  f.api.discardOriginalRoomUserJoin(discarded);
  assert.throws(() => f.api.consumeOriginalRoomUserJoin(discarded), /INGRESS_DISCARDED/);
  const args = { magic_link: `  ${valid}  `, name: `  ${f.selection.alias}  ` }, id = randomUUID();
  const joined = await transient(args, id), value = JSON.parse(joined.result.result);
  assert.equal(value.ok, true, joined.result.result); assert.equal(value.status, "connected");
  assert.equal(value.alias, f.selection.alias);
  assert(!["historic-human", "historic-agent"].includes(value.participant_id));
  assert.equal((await transient(args, id)).result.result, joined.result.result);
  assert.deepEqual(await f.ask("user-link-count"), { count: forwards }, "Retries use safe Core receipts, never reforward the link.");
  assert.throws(() => f.api.prepareOriginalRoomUserJoin(grant, { ...args, magic_link: wrongSecret }, id), /CALL_CONFLICT/);
  await assert.rejects(corePort.dispatch(randomUUID(), { operation: "client.begin", callId: randomUUID(),
    call: { tool: "chat_join", arguments: args } }));
  await assert.rejects(corePort.dispatch(randomUUID(), { operation: "client.complete", callId: id,
    result: JSON.stringify({ ok: false, error: valid }), cursorBefore: 0, cursorAfter: 0 }), /RAW_LINK_NOT_DURABLE/);
  const db = f.opened.storage.connectNative();
  try {
    const calls = db.prepare("SELECT request,result FROM legacy_room_runtime_native_calls WHERE session_id=?").all(grant.effect.sessionId);
    const receipts = db.prepare("SELECT result FROM legacy_room_runtime_native_receipts WHERE session_id=?").all(grant.effect.sessionId);
    const states = db.prepare("SELECT state_json FROM legacy_room_runtime_rooms").all();
    const durable = JSON.stringify({ calls, receipts, states });
    for (const text of [valid, valid.slice(10).split(".")[0], wrongSecret, userSecret, args.magic_link, ...invalid.map(args => args.magic_link)])
      assert(!durable.includes(text), "Neither encoded invitation nor plaintext caller secret may enter durable Core state.");
    assert(durable.includes(joined.ingress.call.userLink.magicLinkSha256));
    assert(durable.includes(grant.effect.endpoint));
  } finally { db.close(); }
  await f.ask("call", { callId: randomUUID(), call: { tool: "chat_leave", arguments: { name: f.selection.alias } } });
  grant.revoke(); await coreServer.close(); await listenerClosed(f.selection.port);
  assert.deepEqual(await readFile(join(f.root, "chatrooms", f.roomId, "chatroom.db")), f.originalDb);
  assert.deepEqual(await readFile(f.notePath), f.originalNote);
});
