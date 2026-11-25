import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync, fork } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect } from "node:net";
import test from "node:test";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Run in the existing private Linux framework.");
process.umask(0o077);
const project = resolve("."), require = createRequire(import.meta.url), build = require("esbuild").buildSync;
const hash = value => createHash("sha256").update(value).digest("hex");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 10000) {
  const end = Date.now() + timeout;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() >= end) throw new Error("Fixture condition timed out"); await wait(10); }
}
async function listenerClosed(port) {
  await until(() => new Promise(resolve => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", error => resolve(error.code === "ECONNREFUSED"));
  }));
}
function link(endpoint, roomId, secret) {
  const data = Buffer.from(JSON.stringify({ v: 1, u: `${endpoint}/Historical%20multi-participant%20room`, r: roomId, s: secret })).toString("base64url");
  return `pkchat:v1:${data}.${createHash("sha256").update(data).digest("base64url").slice(0, 16)}`;
}
async function fixture(t) {
  const directory = join(project, ".migration-test-work", `room-live-${randomUUID()}`);
  const extension = join(directory, "original"), root = join(directory, "root");
  const endpoint = join(project, `.rla-${randomBytes(4).toString("hex")}`), persistence = join(project, `.rlp-${randomBytes(4).toString("hex")}`);
  for (const path of [directory, endpoint, persistence]) await mkdir(path, { recursive: true, mode: 0o700 });
  let child, opened, host, authority, server, resource;
  const requests = new Map(), events = new Map();
  t.after(async () => {
    await resource?.close().catch(() => {});
    authority?.dispose(); await host?.close(); await server?.close(); await opened?.owner.close();
    if (child) {
      if (child.connected) child.disconnect();
      if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once("exit", resolve));
    }
    for (const path of [endpoint, persistence, directory]) await rm(path, { recursive: true, force: true });
  });
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  build({ entryPoints: [join(project, "src/storage-worker.ts")], bundle: true, platform: "node", format: "esm",
    packages: "external", outfile: join(directory, "storage-worker.js"), logLevel: "silent" });
  build({ stdin: { contents: `
    export {captureOriginalMcpCustody,openOriginalMcpRoot} from "./src/original-mcp-root";
    export {createOriginalMcpNativeRoomAuthority} from "./src/original-mcp-native-room-authority";
    export {openOriginalMcpRoomLiveSession,getOriginalMcpRoomLiveSession} from "./src/original-mcp-room-live-session";
    export {startOriginalMcpNativeAttachmentServer} from "./src/original-mcp-native-attachment";
    export {originalMcpNativeIdentity,originalMcpNativeAttestationMessage} from "./src/original-mcp-native-identity";
    export {originalMcpNativeRequestMethods,originalMcpNativeRequestProtocol,originalMcpNativeResult,
      originalMcpNativeErrorResult,createOriginalMcpNativeRequestPolicy,waitForOriginalMcpNativeSupport} from "./src/original-mcp-native-request";
    export {originalNativeRoomHostPurpose} from "./src/original-mcp-native-room-contracts";
    export {originalRoomSessionDigest} from "./src/original-mcp-room-session-contracts";
    export {createOriginalMcpNativeHost} from "./src/original-mcp-native-host";
    export {createOriginalMcpPublicDispatcher} from "./src/original-mcp-public";
    export {createLegacyNoteBackend} from "./src/legacy-note-mcp";
    export {originalPublicMcpContracts} from "./src/native-public-original-mcp-contracts";
    `.replace(/from "\.\/src\/([^"]+)"/g, (_match, name) =>
      `from "${pathToFileURL(join(project, "dist", `${name}.js`)).href}"`),
    resolveDir: project }, bundle: false, platform: "node", format: "esm", packages: "external",
    outfile: join(directory, "api.mjs"), logLevel: "silent" });
  const api = await import(pathToFileURL(join(directory, "api.mjs")));
  const baseline = process.env.PKM_LEGACY_VSIX || resolve("../personal-knowledge-vscode/personal-knowledge-4.0.22.vsix");
  assert.equal(hash(await readFile(baseline)), "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
  for (const name of ["chat-persistence.js", "chat-persistence-worker.js", "chatroom/chat-persistence.js",
    "chatroom/chat-persistence-worker.js", "chatroom/chat-room-credentials.js",
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
    export {ChatJoinApprovalManager} from "./src/chatroom/chat-join-approval";export {WebSocketServer} from "ws";`,
    resolveDir: join(project, "legacy") }, bundle: true, platform: "node", format: "cjs", outfile: retained, logLevel: "silent" });
  const native = join(directory, "native.cjs");
  build({ entryPoints: [join(project, "clients/vscode-host/original-mcp-native-room-session-hub.ts")],
    bundle: true, platform: "node", format: "cjs", packages: "external", outfile: native, logLevel: "silent" });
  const roomId = randomUUID(), userSecret = `USER_SUPPLIED_${randomBytes(24).toString("base64url")}`;
  const profileSha256 = hash(`room-live-fixture:${randomUUID()}`), activationId = randomUUID();
  child = fork(fileURLToPath(new URL("./original-mcp-room-live-session-native-child.mjs", import.meta.url)), [JSON.stringify({
    api: join(directory, "api.mjs"), native, retained, extension, directory, roomId, profileSha256, activationId,
  })], { cwd: directory, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Native peer startup timed out")), 10000);
    child.once("error", reject);
    child.once("exit", () => {
      clearTimeout(timer); reject(new Error("Native peer exited"));
      for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(new Error("Native peer exited")); }
      requests.clear();
    });
    child.on("message", message => {
      if (message.ready) { clearTimeout(timer); resolve(); return; }
      if (message.event) { events.set(message.event, message); return; }
      const pending = requests.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); requests.delete(message.id);
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
    });
  });
  const ask = (operation, args = {}) => new Promise((resolve, reject) => {
    const id = randomUUID(), timer = setTimeout(() => { requests.delete(id); reject(new Error(`Native control timed out: ${operation}`)); }, 15000);
    requests.set(id, { resolve, reject, timer }); child.send({ id, operation, ...args });
  });
  const prepared = await ask("prepare", { userSecret });
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "notes/Entry.md"), "---\ntitle: Owner live fixture\n---\nAuthoritative original fixture Note.\n");
  const original = require("../legacy/tests/next-trial-electron/chatroom-live-fixture.cjs");
  await original.create({ extension, root, roomId, credentials: prepared, hostParticipantId: "historic-human" });
  await mkdir(join(root, ".pkm"), { mode: 0o700 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{"notes":["Chatroom Meetings"]}}');
  const originalDb = await readFile(join(root, "chatrooms", roomId, "chatroom.db"));
  const plan = await api.captureOriginalMcpCustody({ root, backup: join(directory, "custody"),
    operatorId: "private-room-live-orchestrator", profileSha256,
    limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16777216, maxFileBytes: 8388608 } });
  opened = await api.openOriginalMcpRoot(plan);
  const binding = { root, workspaceId: opened.workspaceId, planSha256: plan.planSha256,
    catalogSha256: api.originalPublicMcpContracts().provenance.metadataSha256, profileSha256,
    payloadBuildId: hash("room-live-fixture-build"), hostEntrySha256: hash("room-live-fixture-entry") };
  server = await api.startOriginalMcpNativeAttachmentServer({ directory: endpoint, identity: prepared.identity,
    identitySha256: prepared.identity.sha256, binding, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 3000 });
  await ask("attach", { path: join(endpoint, "n"), binding });
  const session = await server.waitForSession({ timeoutMs: 3000 });
  await api.waitForOriginalMcpNativeSupport(session, { timeoutMs: 3000 });
  host = await api.createOriginalMcpNativeHost(opened.storage, api.createOriginalMcpNativeRequestPolicy(session));
  authority = api.createOriginalMcpNativeRoomAuthority(opened.storage, host, session); await authority.admit(roomId);
  const selection = { port: 18000 + Number.parseInt(randomBytes(2).toString("hex"), 16) % 40000,
    alias: "Owner live Straße agent", postText: '@"Historic Human" One owner-orchestrated original progress post.' };
  return { api, root, opened, host, authority, session, roomId, originalDb, userSecret, selection, persistence, ask, events,
    open(signal) {
      return api.openOriginalMcpRoomLiveSession(opened.owner, host, session, authority, roomId, selection,
        { directory: persistence, signal }).then(value => { resource = value; return value; });
    },
    get() { return api.getOriginalMcpRoomLiveSession(opened.storage, host); },
    capture() { resource = api.getOriginalMcpRoomLiveSession(opened.storage, host); return resource; },
  };
}
test("actual public dispatcher routes signed live Room calls before raw capture, preserves replay and approvals, and drains explicit close", { timeout: 90000 }, async t => {
  const f = await fixture(t), full = await f.opened.owner.ensureFull(), lease = { ...f.opened.owner.workspaceLease() };
  const actor = Object.freeze({ id: "mcp:external", canWrite: true });
  const dispatcher = await f.api.createOriginalMcpPublicDispatcher(f.opened.owner, actor, f.host,
    f.api.createLegacyNoteBackend(f.opened.storage, { core: full.runtime.core, actor }));
  async function invoke(tool, args, signal, callId) {
    const response = await dispatcher.invoke({ tool, arguments: args }, signal, callId);
    assert(!response.isError);
    return response.structuredContent;
  }
  assert.equal(f.get(), undefined);
  const live = await f.open();
  assert.equal(f.get(), live); assert.equal(live.state, "active");
  assert(!JSON.stringify(live).includes("transportToken")); assert(!("storage" in live));
  await assert.rejects(f.open(), /SELECTION_MUST_BE_CLOSED_OR_RECONCILED/);
  assert.throws(() => f.api.getOriginalMcpRoomLiveSession(f.opened.storage, { ...f.host }), /SAME_HOST_REQUIRED/);
  const before = await f.ask("stats");
  await assert.rejects(invoke("chat_post", { text: f.selection.postText }), /ARGUMENTS_NOT_SUPPORTED/);
  assert.equal((await f.ask("stats")).publicCalls, before.publicCalls);
  const magic_link = link(live.endpoint, f.roomId, f.userSecret), args = { magic_link, name: f.selection.alias }, id = randomUUID();
  const joined = await invoke("chat_join", args, undefined, id);
  assert.equal(JSON.parse(joined.result).status, "connected");
  assert.equal((await invoke("chat_join", args, undefined, id)).result, joined.result);
  assert.equal((await f.ask("stats")).joins, 1);
  await f.ask("controls", { controls: { denyPublic: true } });
  await assert.rejects(invoke("chat_read", { only_new: true }), /Fresh exact native approval/);
  assert.equal(live.state, "active");
  const status = JSON.parse((await invoke("chat_status", { name: f.selection.alias.replace("Straße", "STRASSE").toUpperCase() })).result);
  assert.equal(status.members, 1);
  const post = JSON.parse((await invoke("chat_post", { name: f.selection.alias, text: f.selection.postText,
    continue_working: true, require_reply: false })).result);
  assert.equal(post.ok, true);
  assert.equal(JSON.parse((await invoke("chat_leave", { name: f.selection.alias })).result).ok, true);
  assert.deepEqual(JSON.parse((await invoke("chat_status", {})).result), { ok: true, active_aliases: [], connections: [] });
  const db = f.opened.storage.connectNative();
  try {
    const rows = db.prepare("SELECT request,result FROM legacy_room_runtime_native_calls").all();
    assert(!JSON.stringify(rows).includes(magic_link)); assert(!JSON.stringify(rows).includes(f.userSecret));
    assert(rows.some(row => JSON.parse(row.request).userLink?.magicLinkSha256));
  } finally { db.close(); }
  assert.equal((await f.opened.owner.ensureFull()).runtime.core, full.runtime.core); assert.deepEqual(f.opened.owner.workspaceLease(), lease);
  await live.close(); await listenerClosed(f.selection.port);
  assert.equal(f.get(), undefined); assert.equal(live.state, "closed");
  await assert.rejects(live.invokePublic("chat_status", {}), /CLOSED/);
  assert.deepEqual(await readdir(f.persistence), []);
  assert.deepEqual(await readFile(join(f.root, "chatrooms", f.roomId, "chatroom.db")), f.originalDb);
});
test("cancellation during native open cleans Core reservations and retains an uncertain no-fallback selection", { timeout: 90000 }, async t => {
  const f = await fixture(t), signal = new AbortController();
  await f.ask("controls", { controls: { holdOpen: true } });
  const opening = f.open(signal.signal), rejected = assert.rejects(opening);
  await until(() => f.events.get("open-request"));
  const selected = f.capture(); assert.equal(selected.state, "opening");
  signal.abort(); await rejected;
  assert.equal(f.get(), selected); assert.equal(selected.state, "uncertain");
  await assert.rejects(selected.invokePublic("chat_status", {}), /UNCERTAIN/);
  await selected.close();
  assert.equal(f.get(), selected, "Explicit drain cannot invent resolution of an uncertain open.");
  assert.equal((await f.ask("stats")).baseConnected, true);
  assert.deepEqual(await readdir(f.persistence), []);
});
test("a cancelled reply after a real post preserves committed Core receipt and an uncertain tombstone without fallback", { timeout: 90000 }, async t => {
  const f = await fixture(t), live = await f.open();
  await live.invokePublic("chat_join", { magic_link: link(live.endpoint, f.roomId, f.userSecret), name: f.selection.alias });
  await f.ask("controls", { controls: { holdNextInvoke: true } });
  const cancelled = new AbortController(), id = randomUUID();
  const pending = live.invokePublic("chat_post", { name: f.selection.alias, text: f.selection.postText,
    continue_working: true, require_reply: false }, cancelled.signal, id);
  const refused = assert.rejects(pending);
  await until(() => f.events.get("invoke-committed"));
  cancelled.abort(); await refused; await live.close(); await listenerClosed(f.selection.port);
  assert.equal(f.get(), live); assert.equal(live.state, "uncertain");
  await assert.rejects(live.invokePublic("chat_status", {}), /UNCERTAIN/);
  const db = f.opened.storage.connectNative();
  try {
    const row = db.prepare("SELECT result FROM legacy_room_runtime_native_calls WHERE call_id=?").get(id);
    assert.equal(JSON.parse(row.result).posted, true);
    assert.equal(JSON.parse(db.prepare("SELECT state_json FROM legacy_room_runtime_rooms WHERE room_id=?").get(f.roomId).state_json).state, "stored");
  } finally { db.close(); }
  f.host.assertCurrent();
});
test("real effect expiry fails closed without fallback and explicit close still drains over the live base attachment", { timeout: 90000 }, async t => {
  const f = await fixture(t), live = await f.open();
  await wait(Math.max(0, live.expiresAtMs - Date.now()) + 100);
  await until(() => live.state === "expired" || live.state === "revoked");
  assert.equal(f.get(), live);
  await assert.rejects(live.invokePublic("chat_status", {}), /EXPIRED|REVOKED/);
  await listenerClosed(f.selection.port); f.host.assertCurrent();
  await live.close();
  assert.equal(f.get(), undefined); assert.equal(live.state, "closed");
  const stats = await f.ask("stats"); assert(stats.closeCalls > 0); assert.equal(stats.baseConnected, true);
});
