const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { PeerSession, validPeerResumeRecord } = require("../dist/chatroom/peer-session");
const { parsePortalObservation, boundPortalToolOutputs, PORTAL_TOOL_OUTPUT_LIMIT, PORTAL_TOOL_OUTPUT_TOTAL } = require("../dist/chatroom/portal-observation");
const { PortalPermissions } = require("../dist/chatroom/portal-permissions");

async function until(predicate, label = "peer state") {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Two Hosts on a switchable in-memory transport; either side can "restart" with its persisted record. */
async function world(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-resume-"));
  const errors = [], pending = [], stored = { controller: undefined, controlled: undefined }, forgotten = [], resumed = [];
  let runs = 0;
  const sessions = {};
  const chatIds = { controller: randomUUID(), controlled: randomUUID() };
  const ids = { controller: "controller-1", controlled: "controlled-1" };
  const deliver = (side, other) => (_target, value) => {
    pending.push(Promise.resolve().then(() => sessions[other]?.receive({ from: ids[side], fromName: side, packet: value })));
  };
  const make = (side, resumeFrom, journal = path.join(directory, side)) => {
    const other = side === "controller" ? "controlled" : "controller";
    sessions[side] = new PeerSession({
      roomId: "resume-room", journalDirectory: journal, connected: () => true,
      changed() {}, error(error) { errors.push(error.message); },
      approvePair: async () => true, approveSwap: async () => false, approveTask: async () => true,
      execute: async (prompt, signal, id) => { runs++; return options.execute ? options.execute(prompt, signal, id) : { content: prompt }; },
      chatId: chatIds[side], chatName: `${side} chat`, machine: `${side}-host`, endpoint: `wss://${side}:443`,
      send: deliver(side, other),
      persist: record => { if (record) stored[side] = JSON.parse(JSON.stringify(record)); else { stored[side] = undefined; forgotten.push(side); } },
      ...(resumeFrom ? { resumeFrom } : {}),
      resumed: binding => resumed.push({ side, binding }),
    });
    return sessions[side];
  };
  make("controller"); make("controlled");
  sessions.controller.pair(ids.controlled, sessions.controlled.invite());
  await until(() => sessions.controller.binding && sessions.controlled.binding, "pairing");
  t.after(async () => { for (const s of Object.values(sessions)) s.dispose(); await Promise.all(pending); await fs.rm(directory, { recursive: true, force: true }); });
  return { sessions, stored, forgotten, resumed, errors, ids, chatIds, make, directory, get runs() { return runs; } };
}

test("pairing persists a secret resume record only when both Hosts advertise resume-v1", async t => {
  const w = await world(t);
  assert.ok(w.sessions.controller.binding.peerCapabilities.includes("resume-v1"));
  for (const side of ["controller", "controlled"]) {
    assert.ok(validPeerResumeRecord(w.stored[side]), `${side} record`);
    assert.equal(w.stored[side].pairId, w.sessions.controller.binding.pairId);
    assert.match(w.stored[side].resumeSecret, /^[a-f0-9]{64}$/);
  }
  assert.equal(w.stored.controller.resumeSecret, w.stored.controlled.resumeSecret);
  assert.equal(w.stored.controller.role, "controller");
  assert.equal(w.stored.controlled.peerChatId, w.chatIds.controller);
  const target = w.sessions.controller.resumeTarget;
  assert.equal(target, undefined, "a live binding is not a resume target");
});

test("controlled restart re-attaches with proof; interrupted running task becomes unknown and is never replayed", async t => {
  let release;
  const w = await world(t, { execute: () => new Promise(resolve => { release = resolve; }) });
  const id = w.sessions.controller.submit("long side effect");
  await until(() => w.runs === 1 && w.sessions.controller.receipts.get(id)?.state === "running", "running receipt");
  const record = w.stored.controlled;
  w.sessions.controlled.dispose();
  assert.deepEqual(w.forgotten, [], "dispose keeps the stored pairing");
  w.ids.controlled = "controlled-2";
  const restarted = w.make("controlled", record);
  assert.equal(restarted.resumeTarget.pairId, record.pairId);
  assert.equal(JSON.stringify(restarted.resumeTarget).includes(record.resumeSecret), false, "resumeTarget never exposes the secret");
  restarted.resume(w.ids.controller);
  await until(() => restarted.binding && w.resumed.length === 2, "resume handshake");
  assert.equal(restarted.binding.pairId, record.pairId);
  assert.equal(w.sessions.controller.binding.peerId, "controlled-2", "live controller binding follows the new participant");
  await until(() => w.sessions.controller.receipts.get(id)?.state === "unknown", "unknown receipt");
  assert.match(w.sessions.controller.receipts.get(id).error, /not replayed/);
  release?.({ content: "late" });
  assert.equal(w.runs, 1);
});

test("controller restart restores outgoing receipts and recovers the completed result from the controlled journal", async t => {
  let release;
  const w = await world(t, { execute: () => new Promise(resolve => { release = resolve; }) });
  const id = w.sessions.controller.submit("finishes while controller is away");
  await until(() => w.runs === 1, "dispatch");
  const record = w.stored.controller;
  assert.deepEqual(record.outgoing.map(([requestId]) => requestId), [id]);
  w.sessions.controller.dispose();
  w.ids.controller = "controller-2";
  release({ content: "done" });
  await until(() => w.sessions.controlled.receipts.get(id)?.state === "completed", "controlled completion");
  const restarted = w.make("controller", record);
  assert.notEqual(restarted.receipts.get(id)?.state, "completed");
  restarted.resume(w.ids.controlled);
  await until(() => restarted.receipts.get(id)?.state === "completed", "recovered completion");
  assert.equal(w.runs, 1);
  restarted.submit("finishes while controller is away", id);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(restarted.receipts.get(id).state, "completed");
  assert.equal(w.runs, 1, "the original id is never re-dispatched");
});

test("wrong proof, wrong Chat and wrong direction are rejected without attaching", async t => {
  const w = await world(t);
  const good = w.stored.controlled;
  w.sessions.controlled.dispose();
  const variants = [
    { ...good, resumeSecret: "0".repeat(64) },
    { ...good, role: "controller" },
  ];
  for (const record of variants) {
    w.errors.length = 0;
    const before = w.sessions.controller.binding.peerId;
    const forged = w.make("controlled", record);
    try { forged.resume(w.ids.controller); } catch { /* local precondition */ }
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(forged.binding, undefined);
    assert.equal(w.sessions.controller.binding.peerId, before);
    forged.dispose();
  }
  const other = w.make("controlled", good);
  other.options.chatId = randomUUID();
  other.resume(w.ids.controller);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(other.binding, undefined, "a different Chat cannot reuse the pairing");
});

test("revoke forgets the stored pairing on both sides", async t => {
  const w = await world(t);
  w.sessions.controller.revoke();
  await until(() => !w.sessions.controlled.binding, "revoke delivery");
  assert.deepEqual(w.forgotten.sort(), ["controlled", "controller"]);
  assert.equal(w.stored.controller, undefined);
});

test("a pre-v2 task journal is still honoured so an upgrade never replays", async t => {
  const w = await world(t);
  const pairId = w.sessions.controller.binding.pairId;
  const { createHash } = require("node:crypto");
  const requestId = randomUUID();
  const legacy = createHash("sha256").update(JSON.stringify(["resume-room", w.ids.controller, pairId, requestId])).digest("hex");
  await fs.mkdir(path.join(w.directory, "controlled"), { recursive: true });
  await fs.writeFile(path.join(w.directory, "controlled", `${legacy}.json`), JSON.stringify({ fingerprint: createHash("sha256").update("legacy").digest("hex"), receipt: { requestId, state: "completed", result: { content: "old" } } }));
  w.sessions.controller.submit("legacy", requestId);
  await until(() => w.sessions.controller.receipts.get(requestId), "legacy receipt");
  assert.equal(w.runs, 0, "legacy journal suppresses execution");
});

test("tool output mirror is bounded and validated", () => {
  const tools = Array.from({ length: 12 }, (_, index) => ({ name: `t${index}`, status: "complete", output: "x".repeat(4000) }));
  const bounded = boundPortalToolOutputs(tools);
  assert.ok(bounded.every(tool => !tool.output || tool.output.length <= PORTAL_TOOL_OUTPUT_LIMIT));
  assert.ok(bounded.reduce((total, tool) => total + (tool.output?.length || 0), 0) <= PORTAL_TOOL_OUTPUT_TOTAL);
  assert.ok(bounded.at(-1).output, "newest output kept first");
  const base = { requestId: randomUUID(), chatId: randomUUID(), at: Date.now(), sequence: 0, state: "running", visibility: "task-only" };
  const parsed = parsePortalObservation({ ...base, tools: [{ name: "read_file", status: "complete", output: "hello" }, { name: "run_process", status: "complete", outputWithheld: true }] });
  assert.equal(parsed.tools[0].output, "hello");
  assert.equal(parsed.tools[1].outputWithheld, true);
  assert.throws(() => parsePortalObservation({ ...base, tools: [{ name: "x", status: "complete", output: "y".repeat(PORTAL_TOOL_OUTPUT_LIMIT + 1) }] }));
  assert.throws(() => parsePortalObservation({ ...base, tools: Array.from({ length: 10 }, () => ({ name: "x", status: "complete", output: "y".repeat(1500) })) }), /budget/);
  assert.equal(parsePortalObservation({ ...base, state: "restricted", visibility: "restricted", tools: [{ name: "x", status: "s", output: "secret" }] }).tools, undefined);
});

test("folder-scoped file grants allow only resources inside the chosen folders", () => {
  const policy = new PortalPermissions({ chatId: randomUUID(), connectionId: randomUUID() });
  policy.grant({ mode: "scoped", permissions: ["files-read", "progress-read"], durationMs: 60_000, scopes: { "files-read": ["/work/project"] } });
  assert.equal(policy.allows("files-read", "/work/project/src/a.ts"), true);
  assert.equal(policy.allows("files-read", "/work/project"), true);
  assert.equal(policy.allows("files-read", "/work/project-other/a.ts"), false);
  assert.equal(policy.allows("files-read", "/work/project/../secret"), false);
  assert.equal(policy.allows("files-read"), false, "scoped grant denies when the resource is unknown");
  assert.equal(policy.allows("progress-read"), true);
  assert.throws(() => policy.grant({ mode: "scoped", permissions: ["files-read"], durationMs: 60_000, scopes: { "files-read": ["/"] } }), /unbounded/);
});
