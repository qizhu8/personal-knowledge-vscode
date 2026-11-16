import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readCollaborationCaptureSource } from "../scripts/lib/collaboration-capture-source.mjs";
import {
  actors, mutation, taskInput, loadCollaborationModules, loadOriginalPure,
  createCollaborationFixture, serverRoot,
} from "./collaboration-state-fixtures.mjs";

test("historical source identities and relocated captures remain repeatable", () => {
  const manifest = resolve(serverRoot, "migration/collaboration-state-provenance.json");
  const before = readFileSync(manifest);
  execFileSync(process.execPath, [resolve(serverRoot, "scripts/capture-collaboration-state.mjs"), "--check"], {
    cwd: resolve(serverRoot, "tests"),
  });
  assert.deepEqual(readFileSync(manifest), before);
  const provenance = JSON.parse(before.toString("utf8"));
  const captureRoot = resolve(serverRoot, "migration", provenance.captureRoot);
  const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");
  for (const entry of provenance.captures) {
    assert.equal(createHash("sha256").update(readCollaborationCaptureSource(entry.source)).digest("hex"), entry.sourceSha256);
    assert.equal(digest(resolve(captureRoot, entry.destination)), entry.captureSha256);
  }
});

for (const order of ["store-first", "contracts-first"]) test(`isolated ESM import order: ${order}`, async () => {
  const modules = await loadCollaborationModules(order);
  assert.deepEqual(modules.store.collaborationStateDefinitions.map(item => item.id),
    ["collaboration.state.list", "collaboration.state.read", "collaboration.state.leave"]);
  assert.equal(modules.contracts.collaborationStateDefinitions, modules.store.collaborationStateDefinitions);
  const file = readFileSync(resolve(serverRoot, "src/collaboration-state-contracts.ts"), "utf8");
  assert.doesNotMatch(file, /from ["']\.\/(?:contracts|collaboration-state)\.js/);
});

test("original reducer accepted/rejected transitions match the migrated capture", async () => {
  const original = loadOriginalPure("src/chatroom/collaboration-model.ts");
  const { model } = await loadCollaborationModules();
  const input = taskInput();
  let left = original.createCollaborationTask(input), right = model.createCollaborationTask(input);
  assert.deepEqual(right, left);
  const transitions = [
    { action: "start", actor: "worker", actorRole: "Worker" },
    { action: "handoff", actor: "worker", actorRole: "Worker" },
    { action: "approve", actor: "reviewer", actorRole: "Reviewer" },
    { action: "synthesize", actor: "lead", actorRole: "Lead", resolvedResponders: ["lead", "worker", "reviewer"], evidenceSummary: "Fixture verified", resultArtifact: "fixture:result" },
    { action: "complete", actor: "lead", actorRole: "Lead", completionClaim: true },
  ];
  for (const transition of transitions) {
    const request = { ...transition, collaborationId: left.collaborationId, expectedVersion: left.version, at: input.at };
    left = original.transitionCollaborationTask(left, request);
    right = model.transitionCollaborationTask(right, request);
    assert.deepEqual(right, left);
  }
  const initial = original.createCollaborationTask(input);
  for (const rejected of [
    { action: "start", actor: "unknown", actorRole: "Worker" },
    { action: "complete", actor: "lead", actorRole: "Lead" },
    { action: "start", actor: "worker", actorRole: "Lead" },
    { action: "timeout", actor: "lead", actorRole: "Lead" },
  ]) {
    const request = { collaborationId: initial.collaborationId, expectedVersion: 1, at: input.at, ...rejected };
    let expected;
    try { original.transitionCollaborationTask(initial, request); assert.fail("Original must reject"); } catch (error) { expected = error.code; }
    assert.throws(() => model.transitionCollaborationTask(initial, request), error => error.code === expected);
  }
});

test("durable reopen, actor isolation, CAS and UUID receipts commit atomically", async () => {
  const f = await createCollaborationFixture({ durable: true });
  try {
    f.seedRoom();
    const op = mutation("fixture-room", 3, { text: "Hello Worker", recipients: ["Worker"] });
    const accepted = f.store.recordMessage(actors.host, op);
    const durable = f.store.read(actors.host, "fixture-room");
    f.reopen();
    assert.deepEqual(f.store.read(actors.host, "fixture-room"), durable);
    assert.deepEqual(f.store.recordMessage(actors.host, op), accepted);
    assert.throws(() => f.store.recordMessage(actors.host, { ...op, text: "Changed" }), { code: "OPERATION_CONFLICT" });
    assert.throws(() => f.store.recordMessage(actors.worker, op), { code: "OPERATION_CONFLICT" });
    assert.throws(() => f.store.read(actors.outsider, "fixture-room"), { code: "FORBIDDEN" });
    assert.equal(f.store.list(actors.outsider).total, 0);
    assert.throws(() => f.store.leave(actors.worker, mutation("fixture-room", 3)), { code: "REVISION_CONFLICT" });
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM collaboration_receipts").get().n, 4);
    // A receipt write failure must roll back the already-written parent Room.
    f.db.exec("CREATE TRIGGER collaboration_fixture_fail BEFORE INSERT ON collaboration_receipts BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END");
    assert.throws(() => f.store.leave(actors.worker, mutation("fixture-room", 4)), /fixture receipt failure/);
    assert.deepEqual(f.store.read(actors.host, "fixture-room"), durable);
    f.db.exec("DROP TRIGGER collaboration_fixture_fail");
    const { contracts } = await loadCollaborationModules();
    const read = contracts.collaborationStateDefinitions.find(item => item.id.endsWith(".read"));
    assert.deepEqual(read.output.parse(durable), durable);
  } finally { f.cleanup(); }
});

test("explicit routing, mute, host broadcast and input bounds have no side effects on rejection", async () => {
  const f = await createCollaborationFixture();
  try {
    const room = f.seedRoom();
    const rejected = [
      [actors.worker, { text: "@all cannot broadcast", recipients: ["Host"] }, "host-only-broadcast"],
      [actors.worker, { text: "Unknown", recipients: ["Unknown"] }, "structured-recipient-invalid"],
      [actors.worker, { text: "/stop", recipients: ["Host"] }, "INVALID_ARGUMENT"],
      [actors.worker, { text: "x".repeat(8001), recipients: ["Host"] }, "INVALID_ARGUMENT"],
      [actors.worker, { text: "x", recipients: [], role: "host" }, "INVALID_ARGUMENT"],
    ];
    for (const [actor, extra, code] of rejected) {
      assert.throws(() => f.store.recordMessage(actor, mutation(room.roomId, 3, extra)), { code });
      assert.equal(f.store.read(actors.host, room.roomId).revision, 3);
    }
    const message = f.store.recordMessage(actors.worker, mutation(room.roomId, 3, { text: "`@all` is quoted", recipients: ["HOST"], mode: "discuss" }));
    assert.equal(message.mode, undefined);
    assert.deepEqual(message.recipients, ["host"]);
    assert.throws(() => f.store.recordMessage(actors.host, mutation(room.roomId, 4, {
      text: "@all everyone", recipients: ["all", "everyone"],
    })), { code: "structured-recipient-invalid" });
    assert.equal(f.store.read(actors.host, room.roomId).revision, 4);
    assert.throws(() => f.store.setMuted(actors.worker, mutation(room.roomId, 4, { participantId: room.members[0].participantId, muted: true })), { code: "FORBIDDEN" });
    f.store.setMuted(actors.host, mutation(room.roomId, 4, { participantId: room.members[1].participantId, muted: true }));
    assert.throws(() => f.store.recordMessage(actors.worker, mutation(room.roomId, 5, { text: "No", recipients: ["Host"] })), { code: "muted" });
  } finally { f.cleanup(); }
});

test("assigned identities derive reducer roles, reject unknown owners and prevent overrides", async () => {
  const f = await createCollaborationFixture();
  try {
    const room = f.seedRoom(), [host, worker, reviewer] = room.members;
    const task = taskInput(host.participantId, worker.participantId, reviewer.participantId);
    assert.throws(() => f.store.createTask(actors.host, mutation(room.roomId, 3, { task: { ...task, owners: ["unknown"] } })), { code: "UNKNOWN_OWNER" });
    f.store.createTask(actors.host, mutation(room.roomId, 3, { task }));
    const transition = { collaborationId: task.collaborationId, expectedVersion: 1, action: "start" };
    assert.throws(() => f.store.transitionTask(actors.reviewer, mutation(room.roomId, 4, { transition })), { code: "collaboration-not-owner" });
    assert.throws(() => f.store.transitionTask(actors.reviewer, mutation(room.roomId, 4, { transition: { ...transition, actorRole: "Worker", actor: worker.participantId } })), { code: "INVALID_ARGUMENT" });
    const result = f.store.transitionTask(actors.worker, mutation(room.roomId, 4, { transition }));
    assert.equal(result.status, "working");
    assert.equal(result.history.at(-1).actor, worker.participantId);
    assert.equal(result.history.at(-1).actorRole, "Worker");
  } finally { f.cleanup(); }
});

test("human authority defaults deny; meeting lifecycle follows Discuss/active/adjourn semantics", async () => {
  const denied = await createCollaborationFixture({ authorizeHuman: undefined });
  // The fixture convenience default authorizes explicitly; create a default-deny store directly.
  try {
    const store = new denied.module.CollaborationStateStore(denied.db);
    assert.throws(() => store.create(actors.host, { operationId: randomUUID(), roomId: "room", name: "Room", alias: "Host" }), { code: "HUMAN_AUTHORITY_REQUIRED" });
  } finally { denied.cleanup(); }
  const f = await createCollaborationFixture();
  try {
    const room = f.seedRoom();
    assert.throws(() => f.store.startMeeting(actors.host, mutation(room.roomId, 3, { triggerMessageId: "unknown", leadParticipantId: room.members[0].participantId })), { code: "TRIGGER_REQUIRED" });
    const trigger = f.store.recordMessage(actors.host, mutation(room.roomId, 3, { text: "@all discuss", recipients: ["all"], mode: "discuss" }));
    const meeting = f.store.startMeeting(actors.host, mutation(room.roomId, 4, { triggerMessageId: trigger.id, leadParticipantId: room.members[0].participantId }));
    assert.equal(meeting.status, "active");
    assert.throws(() => f.store.adjournMeeting(actors.host, mutation(room.roomId, 5, { expectedMeetingRevision: 7 })), { code: "REVISION_CONFLICT" });
    f.store.leave(actors.host, mutation(room.roomId, 5));
    const closed = f.store.read(actors.host, room.roomId);
    assert.equal(closed.status, "closed");
    assert.equal(closed.meeting.phase, "adjourned");
    assert.equal(closed.meeting.revision, 2);
    assert.throws(() => f.store.join(actors.worker, mutation(room.roomId, 6, { alias: "Worker" })), { code: "ROOM_CLOSED" });
  } finally { f.cleanup(); }
});

test("Portal pairing identity, reconnect visibility, fixed expiry and disconnect never persist grants", async () => {
  const { permissions: P, connections: C, routing: R } = await loadCollaborationModules();
  const original = loadOriginalPure("src/chatroom/portal-permissions.ts");
  let now = 100;
  for (const module of [original, P]) {
    const policy = new module.PortalPermissions({ chatId: "fixture-chat", connectionId: "pair-1", now: () => now });
    policy.grant({ mode: "scoped", permissions: ["chat-read"], durationMs: 100 });
    assert.equal(C.portalConnectionAccess("wrong-pair", policy.snapshot()).permissions, undefined);
    assert.equal(policy.allows("file-transfer"), false);
    now += 100;
    assert.equal(policy.allows("chat-read"), false);
    policy.grant({ mode: "all", durationMs: null });
    policy.invalidate("disconnect");
    assert.equal(policy.allows("chat-read"), false);
    assert.equal(new module.PortalPermissions({ chatId: "fixture-chat", connectionId: "pair-1" }).allows("chat-read"), false);
  }
  const journal = new C.PortalConnectionJournal();
  journal.observe({ chatId: "local", chatLabel: "Local", external: false, localMachine: "fixture" },
    { pairId: "pair-1", role: "controller", peerName: "Peer", peerEndpoint: "ws://localhost:9000/private?token=redacted" });
  assert.equal(journal.snapshot(new Map([["local", { pairId: "wrong", connected: true }]])).connections.length, 0);
  const reconnect = journal.snapshot(new Map([["local", { pairId: "pair-1", connected: false, reconnecting: { since: 1, deadline: 2 } }]]));
  assert.equal(reconnect.connections[0].resumable, false);
  assert.equal(reconnect.active, 0);
  assert.equal(reconnect.connections[0].endpoint, "ws://localhost:9000");
  journal.forget("pair-1"); // Grace expiry is delivered by the owning transport; no timers/network here.
  assert.equal(journal.snapshot(new Map()).connections.length, 0);
  assert.throws(() => R.selectPortalRoute([], { platform: "linux" }), /no command or model was invoked/);
});

test("membership reuses only offline stable identity and preserves mute across reconnect", async () => {
  const f = await createCollaborationFixture();
  try {
    const room = f.seedRoom(), worker = room.members[1];
    f.store.setMuted(actors.host, mutation(room.roomId, 3, { participantId: worker.participantId, muted: true }));
    assert.throws(() => f.store.join(actors.worker, mutation(room.roomId, 4, { alias: "Worker" })), { code: "IDENTITY_CONFLICT" });
    f.store.leave(actors.worker, mutation(room.roomId, 4));
    f.store.join(actors.worker, mutation(room.roomId, 5, { alias: "Worker renamed" }));
    const rejoined = f.store.read(actors.worker, room.roomId).members[1];
    assert.equal(rejoined.participantId, worker.participantId);
    assert.equal(rejoined.muted, true);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'collaboration_%' AND type='table'").get().n, 2);
    const source = readFileSync(resolve(serverRoot, "src/collaboration-state.ts"), "utf8");
    assert.doesNotMatch(source, /from ["'](?:node:)?(?:http|https|net|child_process|ws)["']/);
  } finally { f.cleanup(); }
});

test("roster and non-evicting receipt limits reject without a parent revision change", async () => {
  const f = await createCollaborationFixture();
  try {
    let room = f.seedRoom();
    for (let index = 3; index < f.module.COLLABORATION_STATE_LIMITS.members; index++) {
      f.store.join({ actorId: `fixture-human-${index}`, kind: "human" },
        mutation(room.roomId, index, { alias: `Human-${index}` }));
    }
    room = f.store.read(actors.host, room.roomId);
    assert.equal(room.members.length, 64);
    assert.throws(() => f.store.join(actors.outsider, mutation(room.roomId, 64, { alias: "Outsider" })), { code: "LIMIT" });
    assert.equal(f.store.read(actors.host, room.roomId).revision, 64);
    const fill = f.db.prepare("INSERT INTO collaboration_receipts VALUES (?, ?, ?, ?, ?)");
    f.db.exec("BEGIN");
    for (let index = 64; index < f.module.COLLABORATION_STATE_LIMITS.receiptsPerRoom; index++) {
      fill.run(randomUUID(), actors.host.actorId, room.roomId, "fixture-only", "{}");
    }
    f.db.exec("COMMIT");
    assert.throws(() => f.store.leave(actors.worker, mutation(room.roomId, 64)), { code: "LIMIT" });
    assert.equal(f.store.read(actors.host, room.roomId).revision, 64);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM collaboration_receipts").get().n, 10000);
  } finally { f.cleanup(); }
});
