const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const srcDir = path.join(__dirname, "../src/chatroom");
const cache = new Map();
function load(file) {
  const sourcePath = path.join(srcDir, file);
  if (cache.has(sourcePath)) return cache.get(sourcePath).exports;
  const { outputText } = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: sourcePath,
  });
  const mod = new Module(sourcePath);
  mod.filename = sourcePath;
  cache.set(sourcePath, mod);
  mod.require = request => request.startsWith("./") ? load(`${request.slice(2)}.ts`) : require(request);
  mod._compile(outputText, sourcePath);
  return mod.exports;
}
const S = load("portal-endpoint-store.ts");

class Memento {
  constructor(data = {}) { this.data = data; this.fail = false; this.updates = 0; }
  get(key) { return this.data[key] === undefined ? undefined : JSON.parse(JSON.stringify(this.data[key])); }
  async update(key, value) {
    await new Promise(resolve => setImmediate(resolve));
    if (this.fail) throw new Error("state write failed");
    this.updates++;
    this.data[key] = JSON.parse(JSON.stringify(value));
  }
}
class Secrets {
  constructor() { this.data = new Map(); this.failStore = false; this.failDelete = false; }
  async get(key) { return this.data.get(key); }
  async store(key, value) { if (this.failStore) throw new Error("secret store failed"); this.data.set(key, value); }
  async delete(key) { if (this.failDelete) throw new Error("secret delete failed"); this.data.delete(key); }
}
const SECRET = "abcdefghijklmnop_-0123456789ABCD";
const binding = (over = {}) => ({ pairId: "11111111-2222-4333-8444-555555555555", peerId: "peer-1", peerName: "Remote",
  role: "controller", peerChatId: "remote-chat", peerCapabilities: ["observations-v1", "persistent-v1"], ...over });
const transport = (over = {}) => ({ url: "wss://relay.example.com/pkm/portal", roomId: "room-1", user: "alice", cid: "c1", host: false, ...over });
function fixture() {
  const state = new Memento(); const secrets = new Secrets();
  return { state, secrets, store: new S.PortalEndpointStore(state, secrets) };
}
const base = { name: "Lab", root: "/work/lab", localMachine: "box", chatId: "chat-a", chatName: "Chat A" };

test("create persists defaults and restores in a new store with deep copies", async () => {
  const { state, secrets, store } = fixture();
  const created = await store.create(base);
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.equal(created.acceptsIncoming, false);
  assert.deepEqual(created.permissions, []);
  assert.equal(created.revision, 1);
  assert.equal(created.deleted, false);
  const restored = new S.PortalEndpointStore(state, secrets);
  assert.deepEqual(restored.list(), [created]);
  const copy = restored.get(created.id);
  copy.permissions.push("chat-read");
  assert.deepEqual(restored.get(created.id).permissions, []);
  assert.ok(Object.keys(state.data).every(key => key === S.PORTAL_ENDPOINT_STATE_KEY));
  assert.notEqual(S.PORTAL_ENDPOINT_STATE_KEY, "pkm.portal.endpoints.v2");
  assert.ok(!S.PORTAL_ENDPOINT_SECRET_PREFIX.startsWith("pkm.portal.endpoint.secret."));
  await assert.rejects(store.create({ ...base, root: "/other" }), /already exists/);
  await assert.rejects(store.create({ ...base, name: "X", extra: 1 }), /Unknown/);
});

test("pair stores secret only in SecretStorage and resets grants", async () => {
  const { state, secrets, store } = fixture();
  const ep = await store.create(base);
  await store.update(ep.id, { acceptsIncoming: true, permissions: ["chat-read"] });
  const paired = await store.pair(ep.id, binding(), transport({ host: true, port: 4443 }), SECRET);
  assert.equal(paired.acceptsIncoming, false);
  assert.deepEqual(paired.permissions, []);
  assert.equal(paired.revision, 3);
  assert.ok(!JSON.stringify(state.data).includes(SECRET));
  assert.ok(!JSON.stringify(store.list()).includes(SECRET));
  assert.equal(secrets.data.get(S.PORTAL_ENDPOINT_SECRET_PREFIX + ep.id), SECRET);
  assert.equal(await new S.PortalEndpointStore(state, secrets).credential(ep.id), SECRET);
  await store.update(ep.id, { deleted: true });
  assert.equal(await new S.PortalEndpointStore(state, secrets).credential(ep.id), SECRET);
  const unpaired = await store.create({ ...base, name: "Unpaired" });
  assert.equal(await store.credential(unpaired.id), undefined);
});

test("pair validation: persistent-v1, safe URLs, cid, secret, UUIDs", async () => {
  const { store, secrets } = fixture();
  const ep = await store.create(base);
  await assert.rejects(store.pair(ep.id, binding({ peerCapabilities: ["commands-v1"] }), transport(), SECRET), /persistent-v1/);
  await assert.rejects(store.pair(ep.id, binding(), transport({ url: "ws://relay.example.com/x" }), SECRET), /WSS/);
  await assert.rejects(store.pair(ep.id, binding(), transport({ url: "wss://u:p@relay.example.com/x" }), SECRET), /credentials/);
  await assert.rejects(store.pair(ep.id, binding({ peerEndpoint: "wss://h/x?token=1" }), transport(), SECRET), /query/);
  await assert.rejects(store.pair(ep.id, binding(), transport({ cid: "x".repeat(65) }), SECRET), /cid/);
  await assert.rejects(store.pair(ep.id, binding(), transport({ cid: "" }), SECRET), /cid/);
  await assert.rejects(store.pair(ep.id, binding(), transport({ port: 70000 }), SECRET), /port/);
  await assert.rejects(store.pair(ep.id, binding(), transport(), "short"), /secret/);
  await assert.rejects(store.pair(ep.id, binding(), transport(), "a".repeat(257)), /secret/);
  await assert.rejects(store.pair(ep.id, binding(), transport(), "has+plus/slash=pad="), /secret/);
  await assert.rejects(store.pair(ep.id, binding({ pairId: "11111111-2222-4333-8444-55555555555X" }), transport(), SECRET), /pairId/);
  assert.throws(() => store.get(ep.id.toUpperCase()), /id/);
  assert.equal(secrets.data.size, 0);
  assert.equal(store.get(ep.id).paired, undefined);
  await store.pair(ep.id, binding(), transport({ url: "ws://localhost:9000/pkm/portal" }), SECRET);
});

test("pair failures do not publish success", async () => {
  const { state, secrets, store } = fixture();
  const ep = await store.create(base);
  secrets.failStore = true;
  await assert.rejects(store.pair(ep.id, binding(), transport(), SECRET), /secret store failed/);
  assert.equal(store.get(ep.id).paired, undefined);
  secrets.failStore = false;
  await store.pair(ep.id, binding(), transport(), SECRET);
  const before = store.get(ep.id);
  state.fail = true;
  await assert.rejects(store.pair(ep.id, binding({ pairId: "99999999-2222-4333-8444-555555555555" }), transport(), "Z".repeat(32)), /state write failed/);
  state.fail = false;
  assert.deepEqual(store.get(ep.id), before);
  assert.equal(await store.credential(ep.id), SECRET);
  const fresh = await store.create({ ...base, name: "Fresh" });
  state.fail = true;
  await assert.rejects(store.pair(fresh.id, binding(), transport(), SECRET), /state write failed/);
  state.fail = false;
  assert.equal(secrets.data.has(S.PORTAL_ENDPOINT_SECRET_PREFIX + fresh.id), false);
});

test("chat rebind and deletion clear grants and bump revision; name does not", async () => {
  const { store } = fixture();
  const ep = await store.create(base);
  const renamed = await store.update(ep.id, { name: "Lab 2", chatName: "Renamed" });
  assert.equal(renamed.revision, 1);
  const granted = await store.update(ep.id, { acceptsIncoming: true, permissions: ["chat-read", "files-read"] });
  assert.equal(granted.revision, 2);
  assert.equal((await store.update(ep.id, { permissions: ["chat-read", "files-read"] })).revision, 2);
  const rebound = await store.update(ep.id, { chatId: "chat-b" });
  assert.equal(rebound.revision, 3);
  assert.equal(rebound.acceptsIncoming, false);
  assert.deepEqual(rebound.permissions, []);
  await assert.rejects(store.update(ep.id, { chatId: "chat-c", acceptsIncoming: true }), /separate update/);
  await store.update(ep.id, { acceptsIncoming: true, permissions: ["git-read"] });
  const deleted = await store.update(ep.id, { deleted: true });
  assert.equal(deleted.revision, 5);
  assert.equal(deleted.acceptsIncoming, false);
  assert.deepEqual(deleted.permissions, []);
  await assert.rejects(store.update(ep.id, { acceptsIncoming: true }), /deleted/);
  await assert.rejects(store.pair(ep.id, binding(), transport(), SECRET), /deleted/);
  await assert.rejects(store.update(ep.id, { permissions: ["file-transfer"] }), /File transfer/);
  await assert.rejects(store.update(ep.id, { permissions: ["root"] }), /permissions/);
  await assert.rejects(store.update(ep.id, { revision: 9 }), /Unknown/);
});

test("refreshPeer preserves transport, secret and grants unless identity changes", async () => {
  const { store } = fixture();
  const ep = await store.create(base);
  await store.pair(ep.id, binding(), transport(), SECRET);
  await store.update(ep.id, { acceptsIncoming: true, permissions: ["chat-read"] });
  const same = await store.refreshPeer(ep.id, binding());
  assert.equal(same.revision, 3);
  const renamed = await store.refreshPeer(ep.id, binding({ peerName: "Remote 2" }));
  assert.equal(renamed.acceptsIncoming, true);
  assert.equal(renamed.revision, 3);
  assert.equal(renamed.paired.binding.peerName, "Remote 2");
  const replaced = await store.refreshPeer(ep.id, binding({ peerChatId: "remote-chat-2" }));
  assert.equal(replaced.acceptsIncoming, false);
  assert.deepEqual(replaced.permissions, []);
  assert.equal(replaced.revision, 4);
  assert.deepEqual(replaced.paired.transport, transport());
  assert.equal(await store.credential(ep.id), SECRET);
  await assert.rejects(store.refreshPeer(ep.id, binding({ peerId: "other" })), /pair again/);
  await assert.rejects(store.refreshPeer(ep.id, binding({ peerCapabilities: [] })), /persistent-v1/);
});

test("remove deletes secret first and keeps the record if secret deletion fails", async () => {
  const { secrets, store } = fixture();
  const ep = await store.create(base);
  await store.pair(ep.id, binding(), transport(), SECRET);
  secrets.failDelete = true;
  await assert.rejects(store.remove(ep.id), /secret delete failed/);
  assert.ok(store.get(ep.id));
  secrets.failDelete = false;
  await store.remove(ep.id);
  assert.equal(store.get(ep.id), undefined);
  assert.equal(secrets.data.size, 0);
  await assert.rejects(store.remove(ep.id), /Unknown/);
});

test("writes are serialized and bounded", async () => {
  const { store } = fixture();
  const all = await Promise.all(Array.from({ length: S.PORTAL_ENDPOINT_MAX }, (_, i) => store.create({ ...base, name: `E${i}` })));
  assert.equal(store.list().length, S.PORTAL_ENDPOINT_MAX);
  assert.equal(new Set(all.map(e => e.id)).size, S.PORTAL_ENDPOINT_MAX);
  await assert.rejects(store.create({ ...base, name: "overflow" }), /At most/);
  const id = all[0].id;
  await Promise.all([store.update(id, { acceptsIncoming: true }), store.update(id, { permissions: ["chat-read"] })]);
  const after = store.get(id);
  assert.equal(after.acceptsIncoming, true);
  assert.deepEqual(after.permissions, ["chat-read"]);
  assert.equal(after.revision, 3);
});

test("malformed stored data is rejected without fallback", async () => {
  const { state, secrets, store } = fixture();
  const ep = await store.create(base);
  const good = state.data[S.PORTAL_ENDPOINT_STATE_KEY];
  const variants = [
    { version: 2, endpoints: [] },
    [],
    { version: 1, endpoints: [{ ...good.endpoints[0], secret: SECRET }] },
    { version: 1, endpoints: [{ ...good.endpoints[0], revision: 0 }] },
    { version: 1, endpoints: [{ ...good.endpoints[0], permissions: ["file-transfer"] }] },
    { version: 1, endpoints: [{ ...good.endpoints[0], deleted: true, acceptsIncoming: true }] },
    { version: 1, endpoints: [good.endpoints[0], good.endpoints[0]] },
    { version: 1, endpoints: [{ ...good.endpoints[0], paired: { binding: binding({ peerCapabilities: [] }), transport: transport() } }] },
    { version: 1, endpoints: [{ ...good.endpoints[0], paired: { binding: binding(), transport: transport({ url: "http://x" }) } }] },
  ];
  for (const bad of variants) {
    state.data[S.PORTAL_ENDPOINT_STATE_KEY] = bad;
    const reopened = new S.PortalEndpointStore(state, secrets);
    assert.throws(() => reopened.list(), /Portal endpoint/);
    await assert.rejects(reopened.create({ ...base, name: "New" }), /Portal endpoint/);
    assert.deepEqual(state.data[S.PORTAL_ENDPOINT_STATE_KEY], bad);
  }
  state.data[S.PORTAL_ENDPOINT_STATE_KEY] = good;
  assert.equal(store.get(ep.id).name, "Lab");
  secrets.data.set(S.PORTAL_ENDPOINT_SECRET_PREFIX + ep.id, "bad secret");
  assert.equal(await store.credential(ep.id), undefined);
  await store.pair(ep.id, binding(), transport(), SECRET);
  secrets.data.set(S.PORTAL_ENDPOINT_SECRET_PREFIX + ep.id, "bad secret");
  await assert.rejects(store.credential(ep.id), /secret/);
});

test("accepts real PeerSession capability advertisements and keeps strict limits", async () => {
  const { store } = fixture();
  const ep = await store.create(base);
  const advertised = ["observations-v1", "persistent-v1", "attempts-v1", "commands-v1", "platform:linux", "program:sh", "program:bash",
    "program:pwsh", "platform:win32", "profiles-v1", "files-v1", "review-mode-v1", "auto-review-v1", "commands-v1"];
  const paired = await store.pair(ep.id, binding({ peerCapabilities: advertised }), transport(), SECRET);
  assert.deepEqual(paired.paired.binding.peerCapabilities, [...new Set(advertised)]);
  assert.deepEqual(store.get(ep.id).paired.binding.peerCapabilities, [...new Set(advertised)]);
  for (const bad of [["persistent-v1", "has space"], ["persistent-v1", ""], ["persistent-v1", "x".repeat(65)], ["persistent-v1", 7],
    ["persistent-v1", ":leading"], Array.from({ length: 65 }, (_, i) => i ? `c${i}` : "persistent-v1")]) {
    await assert.rejects(store.pair(ep.id, binding({ peerCapabilities: bad }), transport(), SECRET), /capabilities/);
  }
});
