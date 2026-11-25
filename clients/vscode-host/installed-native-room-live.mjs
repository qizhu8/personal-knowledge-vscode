import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { connect } from "node:net";
import * as statusRoom from "./installed-native-room.mjs";
import { startInstalledNativeRoomLiveUi } from "./installed-native-room-live-ui.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const load = (installed, name) => import(pathToFileURL(join(installed, "next-runtime/server/dist", `${name}.js`)).href);
const credentials = new WeakMap(), preparations = new WeakMap(), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const callerEnvironmentKey = "PKM_INSTALLED_ROOM_LIVE_REQUESTED_JOIN_SECRET";
const requestedProtocol = "pkm.installed-native-room-requested-credential/v1";
function fail(code) { throw Object.assign(new Error(code), { code }); }
function inside(root, path) {
  const member = relative(root, path);
  return member !== "" && member !== ".." && !member.startsWith(`..${sep}`) && !isAbsolute(member);
}
async function privateDriver(root, installed) {
  if (!isAbsolute(root) || resolve(root) !== root || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)))
    fail("INSTALLED_ROOM_LIVE_PRIVATE_DRIVER_REQUIRED");
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root || stat.uid !== process.getuid()
    || stat.mode & 0o077 || dirname(installed) !== join(root, "x") || await realpath(installed) !== installed)
    fail("INSTALLED_ROOM_LIVE_PRIVATE_DRIVER_REQUIRED");
}
function requestedObserverRequired() {
  if (statusRoom.installedNativeRoomRequestedCredentialProtocol !== requestedProtocol)
    fail("INSTALLED_ROOM_LIVE_REQUESTED_SECRET_OBSERVER_UPGRADE_REQUIRED");
}
async function publish(path, value) {
  const text = JSON.stringify(value);
  if (/pkchat:v1:[A-Za-z0-9_=-]+/.test(text)) fail("INSTALLED_ROOM_LIVE_INVITE_EVIDENCE_FORBIDDEN");
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
}
async function waitJson(path, timeoutMs, check = () => {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    check();
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value.failed) fail(value.code || "INSTALLED_ROOM_LIVE_UI_FAILED");
      return value;
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await delay(20);
  }
  fail("INSTALLED_ROOM_LIVE_EVIDENCE_TIMEOUT");
}
function credentialState(value) {
  const state = credentials.get(value);
  if (!state) fail("INSTALLED_ROOM_LIVE_ACTUAL_CREDENTIAL_PREPARATION_REQUIRED");
  return state;
}
function fixtureState(value) {
  const state = preparations.get(value);
  if (!state) fail("INSTALLED_ROOM_LIVE_ACTUAL_PREPARATION_REQUIRED");
  return state;
}

/**
 * Before the first editor. The generated value is caller input to the ORIGINAL requestedJoinSecret API,
 * never a value read/exported from native SecretStorage. Only its hash is returned or written.
 */
export async function prepareInstalledNativeRoomLiveCredentials({ root, installed, legacyVsix }) {
  await privateDriver(root, installed); requestedObserverRequired();
  const callerSecret = randomBytes(24).toString("base64url"), sha256 = hash(callerSecret);
  const intent = await statusRoom.prepareInstalledNativeRoomCredentials({
    root, installed, legacyVsix, requestedJoinSecretSha256: sha256,
  });
  if (intent.requestedJoinSecretSha256 !== sha256) fail("INSTALLED_ROOM_LIVE_REQUESTED_SECRET_OBSERVER_UPGRADE_REQUIRED");
  const value = Object.freeze({ kind: "pkm.installed-native-room-live-credentials/v1", roomId: intent.roomId,
    requestedJoinSecretSha256: sha256, credentialIntent: intent });
  credentials.set(value, { root, installed, legacyVsix, intent, callerSecret });
  return value;
}
/** Transient editor environment patch only. Never put this in fixture JSON, evidence, arguments or logs. */
export function installedNativeRoomLiveCallerEnvironment(preparation) {
  const state = credentialState(preparation);
  if (!state.callerSecret) fail("INSTALLED_ROOM_LIVE_CALLER_INPUT_RELEASED");
  return Object.freeze({ [callerEnvironmentKey]: state.callerSecret });
}
/** Early actual Production observer wrapper; the existing observer remains the sole credential/context authority. */
export function observeInstalledNativeRoomLiveActivation(options) {
  requestedObserverRequired();
  const requestedJoinSecret = process.env[callerEnvironmentKey]; delete process.env[callerEnvironmentKey];
  if (!requestedJoinSecret) fail("INSTALLED_ROOM_LIVE_TRANSIENT_CALLER_INPUT_REQUIRED");
  return statusRoom.observeInstalledNativeRoomActivation({ ...options, requestedJoinSecret });
}
export async function startInstalledNativeRoomLiveCredentialUi(options) {
  requestedObserverRequired();
  return startInstalledNativeRoomLiveUi({ ...options, mode: "credentials" });
}
/** Existing original Room/Meeting writer and real-context preparation; no second writer/authority is introduced. */
export async function prepareInstalledNativeRoomLiveFixture({ root, installed, componentFixture, legacyVsix, credentialPreparation, python }) {
  const input = credentialState(credentialPreparation);
  if (input.root !== root || input.installed !== installed || input.legacyVsix !== legacyVsix)
    fail("INSTALLED_ROOM_LIVE_SAME_CREDENTIAL_PREPARATION_REQUIRED");
  const base = await statusRoom.prepareInstalledNativeRoomFixture({
    root, installed, componentFixture, legacyVsix, credentialIntent: input.intent, python,
  });
  if (base.roomId !== credentialPreparation.roomId || base.joinSecretHash !== credentialPreparation.requestedJoinSecretSha256)
    fail("INSTALLED_ROOM_LIVE_ORIGINAL_REQUESTED_JOIN_INPUT_REQUIRED");
  const value = Object.freeze({ kind: "pkm.installed-native-room-live-fixture/v1", root: base.root,
    roomId: base.roomId, originalPackageSha256: base.originalPackageSha256, credentialReceiptSha256: base.credentialReceiptSha256,
    requestedJoinSecretSha256: base.joinSecretHash, profileDirectory: base.profileDirectory, files: base.files });
  preparations.set(value, { value, input, base, installed, componentFixture, driverRoot: root, phase: "prepared" });
  return value;
}

const source = { kind: "source", title: "Admit this exact original private Room source?", choice: "Admit this private Room source only" };
const host = { kind: "host", title: "Verify current native-profile Room Host custody?", choice: "Verify current Room Host" };
const effect = choice => ({ kind: "effect", title: "Allow native PKM tool room.session.loopback.open?", choice });
const network = { kind: "network", title: "Open this exact single-client loopback Room session?", choice: "Open this exact loopback Room session" };
const pub = (tool, choice = "Approve this request") => ({ kind: "public", title: `Allow PKM v5 ${tool} for this exact request?`, choice });
/** A UI plan is not a permission receipt. Every click below must occur on the actual installed renderer. */
export function installedNativeRoomLiveUiSteps() {
  const quiet = stage => ({ stage: `native-room-live-${stage}`, kind: "quiet", ack: `native-room-live-${stage}-observed.json` });
  return [
    { stage: "native-room-live-source", dialogs: [source] },
    { stage: "native-room-live-open-deny", session: "denied", dialogs: [host, effect("Deny")] },
    { stage: "native-room-live-open-flow", session: "flow", dialogs: [host, effect("Approve this request"), network] },
    { stage: "native-room-live-join-deny", session: "flow", dialogs: [pub("chat_join", "Deny")] },
    { stage: "native-room-live-join-flow", session: "flow", dialogs: [pub("chat_join")] },
    { stage: "native-room-live-join-flow-replay", session: "flow", dialogs: [pub("chat_join")] },
    quiet("read-baseline"), quiet("refuse-final"),
    { stage: "native-room-live-post-deny", session: "flow", dialogs: [pub("chat_post", "Deny")] },
    { stage: "native-room-live-post-flow", session: "flow", dialogs: [pub("chat_post")] },
    { stage: "native-room-live-post-replay", session: "flow", dialogs: [pub("chat_post")] },
    quiet("read-progress"),
    { stage: "native-room-live-leave", session: "flow", dialogs: [pub("chat_leave")] },
    quiet("after-close"),
    { stage: "native-room-live-open-expiry", session: "expiry", dialogs: [host, effect("Approve this request"), network] },
    { stage: "native-room-live-join-expiry", session: "expiry", dialogs: [pub("chat_join")] },
    quiet("expired-refusal"),
    { stage: "native-room-live-open-revoke", session: "revoke", dialogs: [host, effect("Approve this request"), network] },
    { stage: "native-room-live-join-revoke", session: "revoke", dialogs: [pub("chat_join")] },
    { stage: "native-room-live-source-revoke", kind: "revoke", ack: "native-room-live-source-revoked.json" },
    quiet("revoked-refusal"),
  ];
}
function parseReply(reply) {
  try {
    if (!reply || reply.isError) fail("INSTALLED_ROOM_LIVE_PUBLIC_REPLY_FAILED");
    const wrapped = reply.structuredContent ?? JSON.parse(reply.content?.[0]?.text);
    if (!wrapped || Object.keys(wrapped).join(",") !== "result" || typeof wrapped.result !== "string"
      || JSON.stringify(JSON.parse(reply.content[0].text)) !== JSON.stringify(wrapped))
      fail("INSTALLED_ROOM_LIVE_ORIGINAL_WRAPPER_REQUIRED");
    if (/pkchat:v1:[A-Za-z0-9_=-]+/.test(wrapped.result)) fail("INSTALLED_ROOM_LIVE_INVITE_REPLY_FORBIDDEN");
    return { wrapped, value: JSON.parse(wrapped.result) };
  } catch { fail("INSTALLED_ROOM_LIVE_ORIGINAL_REPLY_INVALID"); }
}
async function unchanged(state, root = state.value.root) {
  for (const file of state.base.files)
    if (hash(await readFile(join(root, file.path))) !== file.sha256) fail("INSTALLED_ROOM_LIVE_ORIGINAL_SOURCE_CHANGED");
}
async function listenerClosed(port, check = () => {}) {
  const until = Date.now() + 10000;
  for (;;) {
    check();
    const closed = await new Promise(resolve => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(false); });
      socket.once("error", error => resolve(error.code === "ECONNREFUSED"));
    });
    if (closed) return;
    if (Date.now() >= until) fail("INSTALLED_ROOM_LIVE_LISTENER_STILL_ACTIVE");
    await delay(20);
  }
}
function journal(database, roomId, sessionIds) {
  const placeholders = sessionIds.map(() => "?").join(",");
  return { room: database.prepare("SELECT source_fingerprint,state_json FROM legacy_room_runtime_rooms WHERE room_id=?").get(roomId),
    session: database.prepare("SELECT * FROM legacy_room_runtime_native_sessions WHERE room_id=?").get(roomId),
    calls: database.prepare(`SELECT * FROM legacy_room_runtime_native_calls WHERE session_id IN (${placeholders}) ORDER BY session_id,call_id`).all(...sessionIds),
    receipts: database.prepare(`SELECT * FROM legacy_room_runtime_native_receipts WHERE session_id IN (${placeholders}) ORDER BY session_id,operation_id`).all(...sessionIds) };
}
function magicLink(endpoint, roomName, roomId, userSecret) {
  const payload = Buffer.from(JSON.stringify({ v: 1, u: `${endpoint}/${encodeURIComponent(roomName)}`, r: roomId, s: userSecret })).toString("base64url");
  return `pkchat:v1:${payload}.${createHash("sha256").update(payload).digest("base64url").slice(0, 16)}`;
}

/**
 * Last signed-session leaf. Parent hooks must route actual public invoke with its stable fourth callId argument.
 * Three DISTINCT explicit effects are used: normal close, real expiry, then actual Room-source UI revocation.
 */
export async function verifyInstalledNativeRoomLive({ root, installed, component, sourceFixture,
  python, env, port, roomPort, directory, payloadBuildId, timeoutMs = 120000 }) {
  const state = fixtureState(sourceFixture);
  if (state.phase !== "prepared" || state.installed !== installed || state.driverRoot !== root
    || component.fixture !== state.componentFixture || component.root !== sourceFixture.root)
    fail("INSTALLED_ROOM_LIVE_SAME_COMPONENT_REQUIRED");
  if (typeof component.openRoomLive !== "function" || typeof component.roomLive !== "function"
    || typeof component.selectRoom !== "function" || typeof component.invoke !== "function")
    fail("INSTALLED_ROOM_LIVE_PARENT_PUBLIC_OWNER_HOOKS_REQUIRED");
  await privateDriver(root, installed);
  if (!Number.isSafeInteger(roomPort) || roomPort < 1024 || roomPort > 65535 || roomPort === port
    || !isAbsolute(directory) || resolve(directory) !== directory || await realpath(directory) !== directory
    || inside(component.root, directory) || (await readdir(directory)).length)
    fail("INSTALLED_ROOM_LIVE_EXACT_PRIVATE_LOOPBACK_FIXTURE_REQUIRED");
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.uid !== process.getuid()
    || directoryStat.mode & 0o077) fail("INSTALLED_ROOM_LIVE_EXACT_PRIVATE_LOOPBACK_FIXTURE_REQUIRED");
  let liveApi;
  try { liveApi = await load(installed, "original-mcp-room-live-session"); }
  catch { fail("INSTALLED_ROOM_LIVE_COHERENT_OWNER_MODULE_REQUIRED"); }
  await (await load(installed, "original-mcp-component-recovery")).assertOriginalMcpColdComponentFixture(component.fixture);
  const actualHost = await component.complete(), full = await component.owner.ensureFull(), lease = { ...component.owner.workspaceLease() };
  (await load(installed, "root-owner")).assertRootOwner(component.owner);
  (await load(installed, "original-mcp-native-host")).assertOriginalMcpNativeHost(actualHost, component.storage);
  assert.equal(full.storage, component.storage);
  assert.equal(actualHost.options.providerTransport.supports("openai-compatible"), false);
  assert.equal(actualHost.options.providerTransport.supports("azure-openai"), false);
  const identity = JSON.parse(await readFile(join(root, "native-identity-first.json"), "utf8"));
  const identityProof = JSON.parse(await readFile(join(root, "native-identity-passed.json"), "utf8"));
  if (dirname(identity.result?.path || "") !== sourceFixture.profileDirectory || identityProof.passed !== true
    || identityProof.realInstalledExtension !== true || identityProof.identitySha256 !== identity.result.sha256)
    fail("INSTALLED_ROOM_LIVE_SAME_NATIVE_PROFILE_REQUIRED");
  (await load(installed, "original-mcp-native-identity")).verifyOriginalMcpNativeIdentity(
    JSON.parse(identity.publicRecord), identity.result.sha256, identity.result.profileSha256);
  assert.equal(await readFile(identity.result.path, "utf8"), identity.publicRecord);
  assert.equal(component.custody.profileSha256, identity.result.profileSha256);
  assert.equal(hash(await readFile(join(root, "native-room-created-credentials.json"))), state.base.credentialReceiptSha256);
  assert.equal(hash(await readFile(join(root, "native-room-credential-observation.json"))), state.base.credentialObservationSha256);
  if (!state.input.callerSecret || hash(state.input.callerSecret) !== sourceFixture.requestedJoinSecretSha256)
    fail("INSTALLED_ROOM_LIVE_CALLER_INPUT_BINDING_REQUIRED");
  const descriptorBytes = await readFile(component.attachmentDescriptorPath), descriptor = JSON.parse(descriptorBytes);
  assert.equal(hash(descriptorBytes), component.attachmentDescriptorSha256);
  assert.equal(descriptor.identitySha256, identity.result.sha256);
  assert.equal(descriptor.binding.root, component.root); assert.equal(descriptor.binding.workspaceId, component.workspaceId);
  assert.equal(descriptor.binding.profileSha256, identity.result.profileSha256);
  assert.equal(descriptor.binding.planSha256, component.custody.planSha256);
  assert.equal(descriptor.binding.payloadBuildId, payloadBuildId);
  assert.equal(descriptor.binding.hostEntrySha256, hash(await readFile(join(installed, "dist/extension.cjs"))));
  assert.equal(actualHost.receipt.authorityId, `native-rpc:${descriptor.brokerId}`);
  const source = await (await load(installed, "original-mcp-room-source")).inspectOriginalMcpRoomSource(
    component.storage, actualHost, sourceFixture.roomId);
  assert.equal(source.joinSecretHash, sourceFixture.requestedJoinSecretSha256);
  assert.equal(source.hostParticipantId, "historic-human"); assert.equal(source.privateNotes, 1);
  const endpoint = `ws://127.0.0.1:${roomPort}`, postText = '@"Historic Human" Installed caller-approved original loopback progress.';
  const selections = Object.fromEntries(["denied","flow","expiry","revoke"].map(label => [label,
    { port: roomPort, alias: `Installed loopback ${label} agent`, postText }]));
  const { originalRoomSessionDigest: digest } = await load(installed, "original-mcp-room-session-contracts");
  const steps = installedNativeRoomLiveUiSteps();
  state.b0Sha256 = component.b0?.sha256;
  if (!/^[a-f0-9]{64}$/.test(state.b0Sha256)) fail("INSTALLED_ROOM_LIVE_ACTUAL_B0_REQUIRED");
  await publish(join(root, "native-room-live-ui-contract.json"), { schema: "pkm.installed-native-room-live-ui-contract/v1",
    source, binding: descriptor.binding, nativeEpoch: actualHost.receipt.epoch, endpoint, selections, steps });
  const ui = await startInstalledNativeRoomLiveUi({ root, python, env, port, timeoutMs });
  const cancelled = new AbortController(); void ui.done.catch(error => cancelled.abort(error));
  const checkUi = () => { if (ui.error) throw ui.error; };
  const stage = name => writeFile(join(root, "progress.json"), JSON.stringify({ stage: `native-room-live-${name}` }), { mode: 0o600 });
  const selected = () => {
    const value = liveApi.getOriginalMcpRoomLiveSession(component.storage, actualHost);
    assert.equal(component.roomLive(), value, "Cold hook must use the exact installed same-Storage/host registry.");
    return value;
  };
  const currentWindow = live => {
    if (live.state !== "active" || live.effectSha256 !== state.currentEffectSha256 || live.expiresAtMs <= Date.now() + 200)
      fail("INSTALLED_ROOM_LIVE_EFFECT_WINDOW_EXHAUSTED_NO_RENEWAL");
  };
  const rawFor = label => ({ magic_link: magicLink(endpoint, source.roomName, sourceFixture.roomId, state.input.callerSecret),
    name: selections[label].alias });
  const publicRequest = async (label, phase, tool, args) => {
    const safe = tool === "chat_join" ? { argumentsSha256: digest(args), magicLinkSha256: hash(args.magic_link),
      suppliedNameSha256: hash(args.name) } : { arguments: args };
    await writeFile(join(root, "native-room-live-public-request.json"), JSON.stringify({
      stage: `native-room-live-${phase}`, session: label, tool, ...safe,
    }), { mode: 0o600 });
    await stage(phase);
  };
  const invoke = async (tool, args, callId) => {
    checkUi();
    const reply = parseReply(await component.invoke(tool, args, cancelled.signal, callId));
    if (reply.wrapped.result.includes(state.input.callerSecret)) fail("INSTALLED_ROOM_LIVE_CALLER_INPUT_REPLY_FORBIDDEN");
    return reply;
  };
  const quiet = async (name, action) => {
    await stage(name);
    const work = Promise.resolve().then(action);
    const value = await Promise.all([work, waitJson(join(root, `native-room-live-${name}-observed.json`), timeoutMs, checkUi)]);
    return value[0];
  };
  const sessions = {}, callIds = {}, links = [];
  let live;
  state.phase = "verifying";
  async function open(label) {
    await stage(`open-${label}`);
    const path = join(directory, label); await mkdir(path, { mode: 0o700 });
    live = await component.openRoomLive(sourceFixture.roomId, selections[label], { directory: path, signal: cancelled.signal });
    assert.equal(selected(), live); assert.equal(live.kind, "pkm.original-mcp-room-live-session/v1");
    assert.equal(live.state, "active"); assert.equal(live.endpoint, endpoint);
    if (!live.sessionId || !live.effectSha256 || !Number.isSafeInteger(live.expiresAtMs)) fail("INSTALLED_ROOM_LIVE_ACTUAL_RESOURCE_REQUIRED");
    state.currentEffectSha256 = live.effectSha256;
    const db = component.storage.connectNative();
    try {
      const row = db.prepare("SELECT * FROM legacy_room_runtime_native_sessions WHERE room_id=?").get(sourceFixture.roomId);
      assert.equal(row.session_id, live.sessionId); assert.equal(row.effect_sha256, live.effectSha256);
      const effect = JSON.parse(row.effect);
      assert.equal(digest(effect), live.effectSha256); assert.equal(effect.selection.alias, selections[label].alias);
      assert.equal(effect.selection.postText, postText); assert.equal(effect.maxClients, 1); assert.equal(effect.temporaryParticipant, true);
    } finally { db.close(); }
    sessions[label] = { sessionId: live.sessionId, effectSha256: live.effectSha256, expiresAtMs: live.expiresAtMs };
    return live;
  }
  async function joinRoom(label) {
    currentWindow(live);
    const args = rawFor(label), callId = randomUUID(); links.push(args.magic_link); callIds[`${label}Join`] = callId;
    await publicRequest(label, `join-${label}`, "chat_join", args);
    const result = await invoke("chat_join", args, callId);
    assert.equal(result.value.ok, true); assert.equal(result.value.status, "connected");
    assert.equal(result.value.alias, selections[label].alias);
    assert(!["historic-human","historic-agent"].includes(result.value.participant_id));
    sessions[label].participantId = result.value.participant_id;
    return result;
  }
  try {
    await waitJson(join(root, "native-room-live-ui-ready.json"), timeoutMs, checkUi);
    await stage("source"); await component.selectRoom(sourceFixture.roomId);
    const deniedPath = join(directory, "denied"); await mkdir(deniedPath, { mode: 0o700 });
    await stage("open-deny");
    await assert.rejects(component.openRoomLive(sourceFixture.roomId, selections.denied,
      { directory: deniedPath, signal: cancelled.signal }));
    assert.equal(selected(), undefined); await unchanged(state);
    await open("flow");
    const deniedArgs = rawFor("flow"), deniedJoin = randomUUID(); links.push(deniedArgs.magic_link);
    await publicRequest("flow", "join-deny", "chat_join", deniedArgs);
    await assert.rejects(invoke("chat_join", deniedArgs, deniedJoin));
    assert.equal(live.state, "active");
    const joined = await joinRoom("flow");
    await publicRequest("flow", "join-flow-replay", "chat_join", rawFor("flow"));
    const joinedReplay = await invoke("chat_join", rawFor("flow"), callIds.flowJoin);
    assert.equal(joinedReplay.wrapped.result, joined.wrapped.result, "Public join replay must not reforward a link or rebind a participant.");
    const baseline = await quiet("read-baseline", () => invoke("chat_read", { name: selections.flow.alias, only_new: false, limit: 0 },
      callIds.baseline = randomUUID()));
    assert(baseline.value.messages.some(message => message.id === "history-human"));
    currentWindow(live);
    await quiet("refuse-final", () => assert.rejects(invoke("chat_post", { name: selections.flow.alias, text: postText })));
    assert.equal(live.state, "active");
    const args = { name: selections.flow.alias, text: postText, continue_working: true, require_reply: false, final_topic_summary: false };
    await publicRequest("flow", "post-deny", "chat_post", args);
    await assert.rejects(invoke("chat_post", args, randomUUID())); currentWindow(live);
    callIds.post = randomUUID();
    await publicRequest("flow", "post-flow", "chat_post", args);
    const post = await invoke("chat_post", args, callIds.post); assert.equal(post.value.posted, true);
    await publicRequest("flow", "post-replay", "chat_post", args);
    const replay = await invoke("chat_post", args, callIds.post);
    assert.equal(replay.wrapped.result, post.wrapped.result, "The same stable public call ID must replay its exact original Core receipt.");
    const progress = await quiet("read-progress", () => invoke("chat_read", { name: selections.flow.alias, only_new: true, limit: 50 },
      callIds.progress = randomUUID()));
    assert(progress.value.messages.some(message => message.id === post.value.message_id && message.text === postText));
    await publicRequest("flow", "leave", "chat_leave", { name: selections.flow.alias });
    const left = await invoke("chat_leave", { name: selections.flow.alias }, callIds.leave = randomUUID());
    assert.equal(left.value.ok, true); assert.deepEqual(left.value.active_aliases, []);
    assert.deepEqual((await invoke("chat_status", {})).value, { ok: true, active_aliases: [], connections: [] });
    const db = component.storage.connectNative();
    try {
      const row = db.prepare("SELECT result FROM legacy_room_runtime_native_calls WHERE session_id=? AND call_id=?").get(live.sessionId, callIds.post);
      assert.equal(row.result, post.wrapped.result);
      assert.equal(db.prepare("SELECT count(*) AS n FROM legacy_room_runtime_native_calls WHERE call_id=?").get(callIds.flowJoin).n, 1);
      const room = JSON.parse(db.prepare("SELECT state_json FROM legacy_room_runtime_rooms WHERE room_id=?").get(sourceFixture.roomId).state_json);
      assert.equal(room.messages.filter(message => message.participantId === sessions.flow.participantId).length, 1);
      assert.equal(room.hostParticipantId, "historic-human");
      assert.equal(db.prepare("SELECT count(*) AS n FROM legacy_room_runtime_native_calls WHERE call_id=?").get(deniedJoin).n, 0);
    } finally { db.close(); }
    await live.close(); await listenerClosed(roomPort, checkUi); assert.equal(selected(), undefined);
    await quiet("after-close", () => assert.rejects(live.invokePublic("chat_status", {})));
    await unchanged(state);
    await open("expiry"); await joinRoom("expiry");
    while (Date.now() <= live.expiresAtMs + 50) { checkUi(); await delay(50); }
    await listenerClosed(roomPort, checkUi); actualHost.assertCurrent();
    assert.equal(selected(), live); assert(["expired","revoked"].includes(live.state));
    await quiet("expired-refusal", () => assert.rejects(invoke("chat_status", {})));
    await live.close(); assert.equal(selected(), undefined); await unchanged(state);
    await open("revoke"); await joinRoom("revoke");
    await stage("source-revoke");
    await waitJson(join(root, "native-room-live-source-revoked.json"), timeoutMs, checkUi);
    const end = Date.now() + timeoutMs;
    while (!actualHost.signal.aborted && Date.now() < end) { checkUi(); await delay(20); }
    assert(actualHost.signal.aborted); await listenerClosed(roomPort, checkUi);
    await quiet("revoked-refusal", async () => {
      await assert.rejects(invoke("chat_status", {})); await assert.rejects(live.invokePublic("chat_read", {}));
    });
    await live.close(); assert.equal(selected(), undefined); await unchanged(state);
    assert.equal((await component.owner.ensureFull()).runtime.core, full.runtime.core);
    assert.deepEqual(component.owner.workspaceLease(), lease);
    const finalDb = component.storage.connectNative();
    try {
      state.journal = journal(finalDb, sourceFixture.roomId, Object.values(sessions).map(item => item.sessionId));
      const room = JSON.parse(state.journal.room.state_json);
      assert.equal(room.state, "stored"); assert.equal(room.hostParticipantId, "historic-human");
      for (const session of Object.values(sessions)) {
        const member = room.identity.memberships.find(item => item.participantId === session.participantId);
        assert(member?.temporary && member.forgottenAt);
      }
      const bytes = JSON.stringify(state.journal);
      if (links.some(link => bytes.includes(link) || bytes.includes(link.slice(10).split(".")[0])))
        fail("INSTALLED_ROOM_LIVE_RAW_LINK_DURABILITY_BREACH");
      if (bytes.includes(state.input.callerSecret)) fail("INSTALLED_ROOM_LIVE_CALLER_SECRET_DURABILITY_BREACH");
      assert.equal(state.journal.session.state, "closed");
      assert(state.journal.calls.every(call => call.result !== null));
      state.hostReceipt = JSON.parse(finalDb.prepare("SELECT payload FROM original_mcp_native_host_admissions WHERE receipt_sha256=?")
        .get(actualHost.receipt.receiptSha256).payload);
    } finally { finalDb.close(); }
    await stage("complete");
    const uiEvidence = await waitJson(join(root, "native-room-live-ui-passed.json"), timeoutMs, checkUi); await ui.done;
    assert.equal(uiEvidence.actualNativeUi, true);
    assert.equal(uiEvidence.dialogs.length, steps.reduce((count, step) => count + (step.dialogs?.length || 0), 0));
    for (const label of ["flow","expiry","revoke"]) {
      assert.equal(uiEvidence.effects[label].effectSha256, sessions[label].effectSha256);
      assert.equal(uiEvidence.effects[label].sessionId, sessions[label].sessionId);
    }
    const evidence = { passed: true, scope: "new synthetic installed exact loopback client/progress/read/close/expiry/revoke only",
      actualInstalledUi: uiEvidence, sameRootOwnerStorageCoreAndLease: true, sessions, callIds,
      requestedJoinSecretSha256: sourceFixture.requestedJoinSecretSha256,
      nativeSecretStorageMaterialExported: false, callerGeneratedRequestedSecretOnly: true,
      originalPackageSha256: sourceFixture.originalPackageSha256, credentialReceiptSha256: sourceFixture.credentialReceiptSha256,
      profileSha256: identity.result.profileSha256, payloadBuildId, custodyPlanSha256: component.custody.planSha256,
      nativeEpoch: actualHost.receipt.epoch, actualOriginalJoinReadProgressPostLeave: true,
      exactUserJoinCoreReceiptReplay: true, exactSinglePostCoreReceiptReplay: true, finalPostNotCoerced: true, actualExpiryAndNoFallback: true,
      actualRoomUiRevocationAndRefusal: true, noHostReproofWithinCurrentEffect: true,
      distinctExplicitEffectsNotRenewals: true, originalRoomMeetingManualNoteUnchanged: true,
      noPlaintextInvitesInCoreOrEvidence: true, journalSha256: hash(JSON.stringify(state.journal)),
      b1AndB0Qualified: false, fullTenQualified: false, full151Qualified: false, fullCutoverQualified: false };
    state.phase = "verified"; state.evidence = evidence; state.input.callerSecret = undefined;
    await publish(join(root, "native-room-live-passed.json"), evidence); return evidence;
  } finally {
    if (state.phase !== "verified") state.phase = "failed";
    cancelled.abort(); await live?.close().catch(() => {}); await ui.stop();
  }
}

/** Reuse the parent's genuine component B1/retire/fresh-B0 framework; never launch another engine or restore keys. */
export async function verifyInstalledNativeRoomLiveRestored(sourceFixture, { retirement, restored }) {
  const state = fixtureState(sourceFixture);
  if (state.phase !== "verified" || !state.journal || !state.hostReceipt)
    fail("INSTALLED_ROOM_LIVE_VERIFIED_EFFECTS_AND_PARENT_RECOVERY_REQUIRED");
  if (retirement?.kind !== "pkm.original-mcp-component-retirement/v1" || retirement.root !== sourceFixture.root
    || retirement.receiptPath !== join(state.componentFixture.directory, "retirement-complete.json")
    || restored?.root !== join(state.componentFixture.directory, "restored-b0")
    || restored.receiptPath !== join(state.componentFixture.directory, "b0-restored.json")
    || restored.newRootIdentity !== true || restored.originalRootOverwritten !== false
    || typeof retirement.archive !== "string" || relative(sourceFixture.root, retirement.archive) !== basename(retirement.archive)
    || !/^\.pkm-next-component-retired-[a-f0-9-]{36}$/.test(basename(retirement.archive)))
    fail("INSTALLED_ROOM_LIVE_ACTUAL_PARENT_RECOVERY_RECEIPTS_REQUIRED");
  const retiredBytes = await readFile(retirement.receiptPath), restoredBytes = await readFile(restored.receiptPath);
  assert.equal(hash(retiredBytes), retirement.receiptSha256); assert.equal(hash(restoredBytes), restored.receiptSha256);
  const prior = JSON.parse(retiredBytes), after = JSON.parse(restoredBytes);
  assert.equal(prior.schema, "pkm.original-mcp-component-retirement/v1"); assert.equal(prior.root, sourceFixture.root);
  assert.equal(after.schema, "pkm.original-mcp-component-b0-restored/v1");
  assert.equal(after.root, restored.root); assert.equal(after.originalRoot, sourceFixture.root);
  assert.equal(prior.b0Sha256, state.b0Sha256); assert.equal(prior.originalPathRetired, true); assert.equal(prior.enginesStopped, true);
  assert.equal(prior.archive, retirement.archive); assert.equal(after.b0Sha256, state.b0Sha256);
  assert.equal(after.retirementSha256, retirement.receiptSha256); assert.equal(after.b1Sha256, prior.b1Sha256);
  assert.equal(after.originalRootOverwritten, false); assert.equal(after.nativeIdentityOrProfileRestored, false);
  for (const root of [retirement.archive, restored.root]) {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) fail("INSTALLED_ROOM_LIVE_CANONICAL_RECOVERY_REQUIRED");
    await unchanged(state, root);
  }
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(join(retirement.archive, "core.sqlite"), { readOnly: true });
  try {
    assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok");
    assert.deepEqual(journal(database, sourceFixture.roomId, Object.values(state.evidence.sessions).map(item => item.sessionId)), state.journal);
    assert.deepEqual(JSON.parse(database.prepare("SELECT payload FROM original_mcp_native_host_admissions WHERE receipt_sha256=?")
      .get(state.hostReceipt.receiptSha256).payload), state.hostReceipt);
  } finally { database.close(); }
  for (const path of ["core.sqlite",".pkm-next-original-mcp.json"]) {
    try { await lstat(join(restored.root, path)); fail("INSTALLED_ROOM_LIVE_FRESH_B0_MUST_NOT_INHERIT_NATIVE_STATE"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { originalRoomMeetingManualNoteB1Preserved: true, originalRoomMeetingManualNoteB0Restored: true,
    actualCanonicalNativeCallAndPostReceiptsB1Preserved: true, freshB0NoNativeStateOrGrant: true,
    nativeKeysCopiedOrRestored: false, fullTenQualified: false, full151Qualified: false, fullCutoverQualified: false };
}
