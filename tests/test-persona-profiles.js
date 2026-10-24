const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { PersonaProfileStore, capturePersona, personaMessage, validPersonaSnapshot, portalPersonaSnapshot } = require("../dist/chat/persona-profiles");
const { ChatContextPlanner } = require("../dist/chat/chat-context");
const { ApiChatStore } = require("../dist/chat/api-chat-store");
const { PeerSession } = require("../dist/chatroom/peer-session");
const { PEER_PROTOCOL } = require("../dist/chatroom/peer-protocol");
const card = (preferences = "Be concise") => ({ name: "Developer", role: "SDE", focus: "Correctness", preferences, boundaries: "No extra authority" });
function fixture(t) {
  const directory = path.join(__dirname, `.profile-fixture-${randomUUID()}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "knowledge");
  return { directory, root, store: new PersonaProfileStore(path.join(directory, "host-private"), root) };
}

test("Profiles are private Host/user scoped, Agents root scoped, bounded and CAS revisioned across windows", t => {
  const { directory, root, store } = fixture(t);
  assert.equal(store.capture(), undefined);
  const user = store.save("user", card());
  const agent = store.save("agent", card("Test behavior"));
  const otherWindow = new PersonaProfileStore(path.join(directory, "host-private"), root);
  const otherRoot = new PersonaProfileStore(path.join(directory, "host-private"), path.join(directory, "other-root"));
  const otherHost = new PersonaProfileStore(path.join(directory, "other-host"), root);
  assert.deepEqual(otherRoot.user(), user);
  assert.throws(() => otherRoot.get("agent", agent.id), /unavailable/);
  assert.equal(otherHost.user(), undefined);
  assert(!store.userDirectory.startsWith(root)); assert(!store.agentDirectory.startsWith(root));
  assert.equal(otherWindow.user().id, user.id);
  const edited = otherWindow.save("user", card("Ask first"), user);
  assert.equal(edited.revision, 2);
  assert.throws(() => store.save("user", card("Stale"), user), /changed in another window/);
  assert.throws(() => store.delete(user), /changed in another window/);
  assert.throws(() => store.save("user", card()), /created in another window/);
  assert.throws(() => store.save("user", card("x".repeat(2000)), edited), /2,000|2000-character/);
  assert.throws(() => store.save("agent", card("x".repeat(4000)), agent), /4,000|4000-character/);
  assert.deepEqual(store.user(), edited);
  assert.throws(() => store.get("agent", "../escape"), /identity/);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(store.userDirectory, `${user.id}.json`)).mode & 0o777, 0o600);
});

test("Deleting stops future use, never resurrects stale cards and leaves captured history unchanged", t => {
  const { directory, store } = fixture(t);
  const user = store.save("user", card()), agent = store.save("agent", card("Tests"));
  const snapshot = store.capture(agent.id), encoded = JSON.stringify(snapshot);
  store.save("user", card("New preference"), user);
  store.delete(agent);
  assert.throws(() => store.capture(agent.id), /unavailable or deleted/);
  assert.throws(() => store.save("agent", card("Resurrect"), agent), /unavailable or deleted/);
  assert.equal(store.list("agent").length, 0);
  assert.equal(JSON.stringify(snapshot), encoded);
  assert(personaMessage(snapshot).content.includes("Tests"));
  const tombstone = JSON.parse(fs.readFileSync(path.join(store.agentDirectory, `${agent.id}.json`), "utf8"));
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.preferences, "");
  const chats = new ApiChatStore(path.join(directory, "chat-state"), "a".repeat(16));
  const chat = chats.create();
  chat.messages.push({ id: randomUUID(), role: "assistant", content: "Historical answer", status: "complete", profileContext: snapshot });
  chats.save(chat);
  assert.deepEqual(chats.load(chat.id, false).messages[0].profileContext, snapshot);
  chat.messages[0].profileContext = capturePersona(store.user());
  assert.throws(() => chats.save(chat), /immutable/);
});

test("Snapshots hash exact mandatory model messages and cannot be silently omitted to meet budget", t => {
  const { store } = fixture(t);
  store.save("user", card());
  const snapshot = store.capture(), message = personaMessage(snapshot);
  assert.equal(snapshot.messageHash, createHash("sha256").update(JSON.stringify(message)).digest("hex"));
  const messages = [{ role: "system", content: "Policy" }, message, { role: "user", content: "Task" }];
  const planner = new ChatContextPlanner(messages, new Map(), []);
  const plan = planner.plan(messages, 10000, "Task");
  assert(plan.receipt.manifest.some(item => item.hash === snapshot.messageHash));
  assert.throws(() => planner.plan(messages, 50, "Task"), /Context budget exceeded/);
  assert.equal(validPersonaSnapshot({ ...snapshot, user: { ...snapshot.user, preferences: "Mutated" } }), false);
  assert.throws(() => personaMessage({ ...snapshot, hash: "0".repeat(64) }), /corrupt/);
  assert.equal(portalPersonaSnapshot(undefined), undefined);
  assert.equal(portalPersonaSnapshot(snapshot).source, "portal-explicit");
  assert.throws(() => portalPersonaSnapshot({ ...snapshot, unexpected: "secret" }), /Invalid explicit/);
});

test("Corrupt private storage is an explicit error, never interpreted as no Profile", t => {
  const { store } = fixture(t);
  const user = store.save("user", card());
  const file = path.join(store.userDirectory, `${user.id}.json`);
  fs.writeFileSync(file, "{broken");
  assert.throws(() => store.capture(), /JSON|Unexpected|property/i);
});

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Profile Portal fixture timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
test("Portal transmits only explicit bounded snapshots, binds deduplication to snapshot and fails closed on unsupported Hosts", async t => {
  const { directory, store } = fixture(t);
  store.save("user", card("Private controller preference"));
  const snapshot = portalPersonaSnapshot(store.capture()), errors = [], runs = [], approvals = [], pending = [];
  let a, b;
  const options = {
    roomId: "profiles", journalDirectory: path.join(directory, "peer-journal"), connected: () => true,
    changed() {}, error: error => errors.push(error.message), approvePair: async () => true, approveSwap: async () => true,
    approveTask: async (_name, _prompt, snapshot) => { approvals.push(snapshot); return true; },
    execute: async (_prompt, _signal, _id, snapshot) => { runs.push(snapshot); return { content: "Done" }; },
  };
  const deliver = (from, target) => (_to, packet) => pending.push(Promise.resolve().then(() => target().receive({ from, fromName: from, packet })));
  a = new PeerSession({ ...options, send: deliver("controller", () => b) });
  b = new PeerSession({ ...options, profileSnapshots: true, send: deliver("controlled", () => a) });
  t.after(async () => { a.dispose(); b.dispose(); await Promise.all(pending); });
  a.pair("controlled", b.invite()); await until(() => a.binding && b.binding);
  const plain = a.submit("No private Profile by default");
  await until(() => a.receipts.get(plain)?.state === "completed");
  assert.equal(runs[0], undefined); assert.equal(approvals[0], undefined);
  const explicit = a.submit("Explicit Profile attempt", randomUUID(), snapshot);
  await until(() => a.receipts.get(explicit)?.state === "completed");
  assert.deepEqual(runs[1], snapshot); assert.deepEqual(approvals[1], snapshot);
  assert.throws(() => a.submit("Explicit Profile attempt", explicit), /different content/);
  a.submit("Explicit Profile attempt", explicit, snapshot);
  await until(() => !b.processing.size);
  await Promise.all(pending);
  assert.equal(runs.length, 2);
  a.binding.peerCapabilities = [];
  assert.throws(() => a.submit("Unsupported", randomUUID(), snapshot), /cannot apply/);
  b.options.profileSnapshots = false;
  a.binding.peerCapabilities = ["profiles-v1"];
  const rejected = a.submit("Must not silently discard snapshot", randomUUID(), snapshot);
  await until(() => a.receipts.get(rejected)?.state === "failed");
  assert.equal(runs.length, 2);
  assert.deepEqual(errors, []);
});
