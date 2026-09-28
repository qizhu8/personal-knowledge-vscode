#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  moveAgentSessionToTrash,
  projectedAgentSessionStatus,
  restoreAgentSessionFromTrash,
  terminalAgentSessionStatus,
} = require("../dist/agent-session-lifecycle");
const { ChatMeetingLifecycle, latestDiscussAfterCompletedMeeting } = require("../dist/chat-meeting-lifecycle");
const { messageAddressesManagedAgent } = require("../dist/chat-managed-agent-routing");
const { MeetingStateStore } = require("../dist/meeting-state");
const { ProjectModelError } = require("../dist/workflows/project-model");
const { ProjectStore, ProjectStoreError } = require("../dist/workflows/project-store");
const {
  CollaborationError,
  COMMUNICATION_RECEIPT_TEMPLATES,
  normalizeCollaborationMessage,
  normalizeCollaborationTaskRecord,
  transitionCollaborationTask,
} = require("../dist/collaboration-model");
const { CHATROOM_PROJECT_SIMULATION_MANIFEST: manifest } = require("./simulation/chatroom-project-manifest");
const { DeterministicSimulationHarness } = require("./simulation/deterministic-harness");

function command(commandId, expectedStoreVersion, fingerprint = `fingerprint:${commandId}`) {
  return { commandId, expectedStoreVersion, fingerprint };
}

function assertCode(action, Type, code) {
  assert.throws(action, error => error instanceof Type && error.code === code);
}

function assertSourceDerivedManifest() {
  assert.strictEqual(manifest.schema, "pkm.chatroom-project-simulation/v1");
  for (const source of Object.values(manifest.sources)) assert(fs.existsSync(path.join(process.cwd(), source)), source);
  const protocol = fs.readFileSync(manifest.sources.chatProtocol, "utf8");
  const hub = fs.readFileSync(manifest.sources.chatHub, "utf8");
  const project = fs.readFileSync(manifest.sources.projectModel, "utf8");
  const store = fs.readFileSync(manifest.sources.projectStore, "utf8");
  const collaboration = fs.readFileSync(manifest.sources.collaborationModel, "utf8");
  const collaborationSimulation = fs.readFileSync(manifest.sources.collaborationSimulation, "utf8");
  const chatroomWebview = fs.readFileSync(manifest.sources.chatroomWebview, "utf8");
  const projectsWebview = fs.readFileSync(manifest.sources.projectsWebview, "utf8");
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  for (const mode of manifest.capabilities.chatroom.message.slice(0, 3)) assert(protocol.includes(`"${mode}"`));
  for (const transition of ["createRoom", "rehostRoom", "adminCloseRoom"]) assert.match(hub, new RegExp(`\\b${transition}\\b`));
  for (const transition of ["createProject", "createThread", "renameThread", "linkThreadChatroom", "moveThread", "createGanttTask", "updateGanttTask", "deleteGanttTask", "createRecipe", "updateRecipe"]) {
    assert.match(project, new RegExp(`export function ${transition}\\b`));
  }
  assert.match(store, /receipt\.fingerprint !== command\.fingerprint/);
  for (const state of manifest.capabilities.project.collaboration.states) assert(collaboration.includes(`"${state}"`), `Collaboration state lacks source coverage: ${state}`);
  for (const action of manifest.capabilities.project.collaboration.actions) assert(collaboration.includes(`"${action}"`), `Collaboration action lacks source coverage: ${action}`);
  assert.deepStrictEqual(Object.keys(manifest.coverage.collaborationActions).sort(), [...manifest.capabilities.project.collaboration.actions].sort(),
    "Every collaboration action must have an executable scenario");
  for (const [action, scenario] of Object.entries(manifest.coverage.collaborationActions)) {
    assert(collaborationSimulation.includes(`"${scenario}"`), `Collaboration action lacks executable coverage: ${action}`);
  }
  for (const [scenario, exactMarker] of Object.entries(manifest.coverage.adversarialConvergence)) {
    assert(collaborationSimulation.includes(exactMarker),
      `Convergence scenario ${scenario} lacks exact executable assertion marker: ${exactMarker}`);
  }
  for (const role of manifest.capabilities.project.collaboration.roles) assert(collaboration.includes(`"${role}"`), `Collaboration role lacks source coverage: ${role}`);
  for (const responsibility of manifest.capabilities.project.collaboration.responsibilities) assert(collaboration.includes(`"${responsibility}"`), `Collaboration responsibility lacks source coverage: ${responsibility}`);
  for (const receipt of manifest.capabilities.chatroom.communicationReceipts) {
    assert(collaboration.includes(`"${receipt}"`), `Communication receipt lacks model coverage: ${receipt}`);
    assert(chatroomWebview.includes(`'${receipt}'`), `Communication receipt lacks selectable UI coverage: ${receipt}`);
  }
  for (const label of ["Objective", "Context / version", "Expected output", "Acceptance criteria", "Primary owner", "Reviewer(s)", "Response policy"]) {
    assert(chatroomWebview.includes(label), `Communication receipt UI is missing ${label}`);
  }
  for (const commandName of ["createCollaborationTask", "transitionCollaborationTask"]) assert.match(store, new RegExp(`\\b${commandName}\\b`));
  assert.match(projectsWebview, /collaborationCreate[\s\S]*collaborationTransition/);
  assert.match(chatroomWebview, /chat-collaboration-state[\s\S]*staleReason/);
  for (const marker of ["Objective:", "Output:", "Criteria:", "Evidence:", "Decision:", "Waiting on:"]) {
    assert(chatroomWebview.includes(marker), `Chatroom convergence UI is missing ${marker}`);
  }
  for (const marker of ["Objective:", "Context\\/version:", "Expected output:", "Acceptance criteria:", "Primary owner:", "Reviewers:", "Convergence:"]) {
    assert(new RegExp(marker).test(projectsWebview), `Projects convergence UI is missing ${marker}`);
  }
  assert(manifest.boundaries.every(boundary => boundary.status === "implemented"));
  assert(packageJson.scripts["test:release"].includes("test:chatroom-project-simulation:run"),
    "release gate must execute the deterministic convergence harness");
}

function assertAbsentContracts() {
  assert(Object.values(manifest.absentContracts).every(contract => contract.status === "absent"));
  const project = fs.readFileSync(manifest.sources.projectModel, "utf8");
  const store = fs.readFileSync(manifest.sources.projectStore, "utf8");
  const protocol = fs.readFileSync(manifest.sources.chatProtocol, "utf8");
  assert.match(project, /export function renameThread\b/);
  assert.match(store, /\brenameThread\s*\(/);
  const threadRecord = project.slice(project.indexOf("export interface ThreadRecord"), project.indexOf("export type GanttTaskStatus"));
  const chatMessage = protocol.slice(protocol.indexOf("export interface ChatMessage"), protocol.indexOf("export interface ReadReceipt"));
  assert.match(threadRecord, /chatroom[\s\S]*roomId/i);
  assert.match(chatMessage, /threadId[\s\S]*projectId|projectId[\s\S]*threadId/);
  assert.match(project, /interface GanttTaskRecord[\s\S]*dependencyIds/);
  assert.match(protocol, /collaboration\?: CollaborationMessageMetadata/);
  assert.doesNotMatch(threadRecord, /objective|output|completion/i);
}

function assertLegacyStructuredTaskFailsClosed() {
  const legacy = normalizeCollaborationTaskRecord({
    collaborationId:"legacy-structured", title:"Legacy", projectId:"project", threadId:"thread",
    version:3, status:"synthesis", phase:"synthesis", lead:"Lead", owners:["Worker"], reviewers:["Reviewer"],
    expectedResponders:[], history:[],
  });
  assert.strictEqual(legacy.convergenceState, "contract-incomplete");
  assertCode(() => transitionCollaborationTask(legacy, {
    collaborationId:"legacy-structured", expectedVersion:3, action:"complete", actor:"Lead", actorRole:"Lead",
    at:"2026-09-27T00:00:00.000Z", completionClaim:true,
  }), CollaborationError, "collaboration-contract-incomplete");
  const contractCompleteButUnapproved = normalizeCollaborationTaskRecord({
    ...legacy, objective:"Deliver", context:"v1", expectedOutput:"Report", artifactType:"report",
    acceptanceCriteria:["verified"], primaryOwner:"Worker", resultArtifact:"report.md", evidenceSummary:"verified",
    decisionRequired:false, completionClaim:true,
  });
  assertCode(() => transitionCollaborationTask(contractCompleteButUnapproved, {
    collaborationId:"legacy-structured", expectedVersion:3, action:"complete", actor:"Lead", actorRole:"Lead",
    at:"2026-09-27T00:00:00.000Z", completionClaim:true,
  }), CollaborationError, "collaboration-review-approval-required");
}

function assertCommunicationReceiptTemplates() {
  assert.deepStrictEqual(Object.keys(COMMUNICATION_RECEIPT_TEMPLATES).sort(), [
    "assign-work", "blocked-escalation", "clarify-question", "completion", "decision-synthesis",
    "handoff", "progress-update", "review-decision", "review-request",
  ]);
  for (const [receiptKind, template] of Object.entries(COMMUNICATION_RECEIPT_TEMPLATES)) {
    const action = template.actions[0];
    const actorRole = action === "handoff" ? "Worker" : action === "approve" || action === "reject" ? "Reviewer" : "Lead";
    const normalized = normalizeCollaborationMessage({
      receiptKind, collaborationId:`receipt-${receiptKind}`, taskVersion:1, actorRole,
      responsibility:"ownership", phase:template.phase,
      ...(action === "none" ? {} : { action }),
      expectedResponders:["Worker"], projectId:"project", threadId:"thread",
      objective:"Objective", context:"v1", expectedOutput:"Output", artifactType:"message",
      acceptanceCriteria:["criterion"], decisionRequired:template.requiresDecision,
      decisionResult:template.requiresDecision ? "decision" : undefined,
      evidenceSummary:template.requiresEvidence ? "evidence" : undefined,
      evidenceLinks:[], primaryOwner:"Worker", ownerPartitions:[], expectedReviewers:["Reviewer"],
      blockedWaitingOn:[], completionClaim:template.completionClaim,
      resolvedResponders:[], reviewerApprovals:[], warnings:[],
    });
    assert.strictEqual(normalized.receiptKind, receiptKind);
  }
  assert.throws(() => normalizeCollaborationMessage({
    receiptKind:"completion", collaborationId:"bad-receipt", taskVersion:1, actorRole:"Lead",
    responsibility:"ownership", phase:"completion", action:"complete", expectedResponders:["Worker"],
    projectId:"project", threadId:"thread",
  }), error => error instanceof CollaborationError && error.code === "collaboration-receipt-incomplete");
}

async function assertFailedActiveRehostIsNonDestructive(harness, room, host, reviewer) {
  const lifecycle = harness.hub.lifecycle;
  const originalRehostRoom = lifecycle.rehostRoom.bind(lifecycle);
  const beforeStored = (await harness.hub.listStoredRooms()).find(item => item.roomId === room.roomId);
  const beforeMembers = harness.hub.adminRooms().find(item => item.roomId === room.roomId).members;
  const beforeHistory = (await harness.hub.persistence.openRoom(room.roomId, room.room)).messages.map(message => message.id);
  let delegatedCalls = 0;
  lifecycle.rehostRoom = async roomId => {
    delegatedCalls++;
    const opened = await lifecycle.persistence.openRoom(roomId, room.room);
    return {
      roomId,
      roomName: room.room,
      joinSecret: room.secret,
      identityState: await lifecycle.persistence.identityState(roomId),
      ...opened,
    };
  };
  try {
    await assert.rejects(harness.hub.rehostRoom(room.roomId), /active Room|already active/i);
  } finally {
    lifecycle.rehostRoom = originalRehostRoom;
  }

  const afterStored = (await harness.hub.listStoredRooms()).find(item => item.roomId === room.roomId);
  assert.deepStrictEqual(afterStored, beforeStored, "failed Rehost must preserve active Room metadata");
  assert.strictEqual(harness.hub.adminRooms().find(item => item.roomId === room.roomId).members, beforeMembers,
    "failed Rehost must preserve Room presence");
  assert.deepStrictEqual(
    (await harness.hub.persistence.openRoom(room.roomId, room.room)).messages.map(message => message.id),
    beforeHistory,
    "failed Rehost must preserve Room history",
  );
  assert.strictEqual(delegatedCalls, 0, "an already-active Room conflict must fail before lifecycle mutation");
  host.send("@Reviewer still connected after failed Rehost", { mode: "ask", recipients: ["Reviewer"] });
  await reviewer.wait(frame => frame.t === "msg" && frame.text.includes("still connected after failed Rehost"),
    "message after failed Rehost");
}

async function exerciseChatroomJourney(harness) {
  await harness.startHub();
  const room = await harness.createRoom("Deterministic Journey", { projectId:"project_simulation", threadId:"thread_simulation" });
  const meetingStore = new MeetingStateStore(harness.chatroomsRoot, harness.notesRoot);
  const meetingLifecycle = new ChatMeetingLifecycle(meetingStore);
  harness.hub.onRoomDeactivating((roomId, reason) => meetingLifecycle.adjournRoom(roomId, `Host:${reason}`));

  const host = harness.actor("Host", "human");
  const reviewer = harness.actor("Reviewer", "agent");
  const worker = harness.actor("Worker", "agent", { temporary: true });
  await host.connect(room, room.hostToken);
  await reviewer.connect(room);
  await worker.connect(room);

  const presence = await host.wait(frame => frame.t === "presence"
    && frame.members?.some(member => member.user === "Worker" && member.temporary), "temporary worker presence");
  assert(presence.members.find(member => member.user === "Host").host);
  assert(messageAddressesManagedAgent({ text: "@Worker proceed", recipients: ["Worker"] }, "Worker"));

  host.send("@Reviewer inspect", { mode: "ask", replyPolicy: "required", recipients: ["Reviewer"] });
  const ask = await reviewer.wait(frame => frame.t === "msg" && frame.mode === "ask", "Ask");
  assert.strictEqual(ask.responseRequired, true);
  assert.deepStrictEqual(ask.recipients, ["reviewer"]);

  host.send("@Reviewer @Worker coordinate", {
    mode: "discuss", replyPolicy: "required", recipients: ["Reviewer", "Worker"], discussionLead: "Reviewer",
  });
  const discuss = await reviewer.wait(frame => frame.t === "msg" && frame.mode === "discuss", "Discuss");
  assert.deepStrictEqual(new Set(discuss.discussionAudience), new Set(["Reviewer", "Worker"]));
  assert.strictEqual(discuss.discussionLead, "Reviewer");

  const startedAt = harness.clock.iso();
  await meetingStore.startMeeting({
    roomId: room.roomId, roomName: room.room, title: "Coordinate", problemStatement: "Coordinate deterministic work",
    owner: "Host", lead: "Reviewer", recorder: "Worker", participants: ["Host", "Reviewer", "Worker"],
    host: "Host", triggerMessageId: discuss.id, requestId: "meeting:start:1", expectedRevision: 0, startedAt,
  });

  host.send("@all release note", { mode: "announce", replyPolicy: "none", recipients: ["all"] });
  const announce = await worker.wait(frame => frame.t === "msg" && frame.mode === "announce", "Announce");
  assert.strictEqual(announce.responseRequired, false);

  const collaborationBase = {
    collaborationId:"collaboration-chat", projectId:"project_simulation", threadId:"thread_simulation",
    responsibility:"ownership", expectedResponders:["Worker"], phase:"assignment",
    objective:"Deliver deterministic result", context:"simulation-v1", expectedOutput:"Result record",
    artifactType:"record", acceptanceCriteria:["record persisted"], decisionRequired:false,
    primaryOwner:"Worker", ownerPartitions:[], evidenceLinks:[], blockedWaitingOn:[],
    completionClaim:false, resolvedResponders:[], reviewerApprovals:[], warnings:[],
  };
  host.send("@Worker assigned structured work", {
    mode:"ask", recipients:["Worker"],
    collaboration:{ ...collaborationBase, taskVersion:1, actorRole:"Lead", action:"assign" },
  });
  const assignment = await worker.wait(frame => frame.t === "msg" && frame.collaboration?.collaborationId === "collaboration-chat", "collaboration assignment");
  assert.strictEqual(assignment.collaboration.stale, undefined);
  host.send("@Worker receipt policy mismatch", {
    recipients:["Worker"], replyPolicy:"none",
    collaboration:{
      ...collaborationBase, receiptKind:"assign-work", collaborationId:"collaboration-receipt",
      taskVersion:1, actorRole:"Lead", action:"assign", expectedReviewers:["Reviewer"],
    },
  });
  const receiptPolicy = await host.wait(frame => frame.t === "error" && frame.code === "collaboration-receipt-reply-policy-mismatch", "receipt policy rejection");
  assert.strictEqual(receiptPolicy.msg, "Assign Work requires required reply policy.");
  host.send("@Reviewer wrong structured recipient", {
    recipients:["Reviewer"],
    collaboration:{ ...collaborationBase, collaborationId:"collaboration-wrong-recipient", taskVersion:1, actorRole:"Lead", action:"assign" },
  });
  const wrongRecipient = await host.wait(frame => frame.t === "error" && frame.code === "collaboration-recipient-mismatch", "wrong-recipient rejection");
  assert.strictEqual(wrongRecipient.msg, "Structured recipients must exactly match required responders: Worker.");
  host.send("@Worker summary without decision", {
    recipients:["Worker"], finalTopicSummary:true,
    collaboration:{
      ...collaborationBase, collaborationId:"collaboration-summary", taskVersion:1, actorRole:"Lead", action:"synthesize",
      phase:"synthesis", decisionRequired:true, resultArtifact:"report.md", evidenceSummary:"Evidence exists.",
      resolvedResponders:["Worker"],
    },
  });
  const missingSummaryDecision = await host.wait(frame => frame.t === "error" && frame.code === "collaboration-summary-decision-required", "summary decision rejection");
  assert.strictEqual(missingSummaryDecision.msg, "Final synthesis requires the contract decision/result.");
  worker.send("@Host stale start", {
    recipients:["Host"],
    collaboration:{ ...collaborationBase, expectedResponders:["Host"], taskVersion:1, actorRole:"Worker", action:"start", phase:"work" },
  });
  const stale = await worker.wait(frame => frame.t === "error" && frame.code === "collaboration-stale-context", "stale collaboration rejection");
  assert.strictEqual(stale.msg, "Stale collaboration context: version 1; current Room version is 1. Refresh and retry.");

  reviewer.send("@Host acknowledgement", {
    recipients:["Host"], replyPolicy:"none", replyToMessageId:announce.id, acknowledgement:true,
  });
  const ackSuppressed = await reviewer.wait(frame => frame.t === "error" && frame.code === "ack-chain-suppressed", "ack-chain suppression");
  assert.strictEqual(ackSuppressed.msg, "Acknowledgement chain suppressed because the referenced message requires no reply.");

  host.send("@Reviewer idempotent request", { recipients:["Reviewer"], clientRequestId:"client-request-1" });
  const accepted = await host.wait(frame => frame.t === "msg.accepted" && frame.clientRequestId === "client-request-1", "request accepted");
  host.send("@Reviewer idempotent request", { recipients:["Reviewer"], clientRequestId:"client-request-1" });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.strictEqual(host.frames.filter(frame => frame.t === "msg.accepted" && frame.clientRequestId === "client-request-1").length, 2);
  assert.strictEqual(host.frames.filter(frame => frame.t === "msg" && frame.id === accepted.messageId).length, 1, "duplicate request is not rebroadcast");
  host.send("@Reviewer conflicting request", { recipients:["Reviewer"], clientRequestId:"client-request-1" });
  const conflict = await host.wait(frame => frame.t === "error" && frame.code === "client-request-conflict", "duplicate request conflict");
  assert.strictEqual(conflict.msg, "Client request ID was already used for different work.");

  for (let index = 0; index < 3; index++) {
    worker.send("@Host exact normalized loop", { recipients:["Host"], clientRequestId:`loop-${index}` });
    await host.waitCount(frame => frame.t === "msg" && frame.text === "@Host exact normalized loop", index + 1,
      `normalized loop delivery ${index + 1}`);
  }
  const loopWarning = await host.wait(frame => frame.t === "msg" && frame.convergenceWarnings?.some(item => item.code === "normalized-message-loop"), "normalized loop warning");
  assert.strictEqual(loopWarning.convergenceWarnings[0].message, "Repeated normalized message loop detected; delivery continued and human review is recommended.");

  await assertFailedActiveRehostIsNonDestructive(harness, room, host, reviewer);

  const reviewerCursor = reviewer.resumeAfter;
  await reviewer.disconnect();
  host.send("@Reviewer queued while disconnected", { mode: "ask", recipients: ["Reviewer"] });
  const queued = await host.wait(frame => frame.t === "msg" && frame.text.includes("queued while disconnected"), "queued message");
  assert.strictEqual(queued.receipt?.total, undefined, "offline recipients are not live receipt targets");
  reviewer.resumeAfter = reviewerCursor;
  await reviewer.connect(room);
  const catchup = await reviewer.wait(frame => frame.t === "history" && frame.mode === "catchup"
    && frame.messages.some(message => message.text.includes("queued while disconnected")), "catchup history");
  assert(catchup.messages.some(message => message.id === queued.id));

  host.send("/stop @Worker", { recipients: ["Worker"] });
  await worker.wait(frame => frame.t === "stopped", "managed-agent stop");

  await harness.hub.adminCloseRoom(room.roomId);
  const completed = meetingStore.snapshot(room.roomId);
  assert.strictEqual(completed.current, null);
  assert.strictEqual(completed.history.length, 1);
  const postBoundaryDiscuss = {
    id: "discuss-after-corrupt-boundary", from: "Host", fromId: "host", text: "Must not revive",
    ts: Date.parse(completed.history[0].endedAt) + 1, kind: "human", mode: "discuss",
  };
  assert.strictEqual(latestDiscussAfterCompletedMeeting({
    ...completed,
    history: [{ ...completed.history[0], endedAt: "not-a-timestamp" }],
  }, [postBoundaryDiscuss]), undefined, "a malformed completed-Meeting boundary must fail closed");
  assert.strictEqual(latestDiscussAfterCompletedMeeting({
    ...completed,
    history: [{ ...completed.history[0], endedAt: undefined }],
  }, [postBoundaryDiscuss]), undefined, "a missing completed-Meeting boundary must fail closed");

  harness.room = await harness.hub.rehostRoom(room.roomId);
  const persisted = (await harness.hub.persistence.openRoom(room.roomId, room.room)).messages;
  assert(persisted.some(message => message.content.includes("queued while disconnected")));
  assert.strictEqual(meetingLifecycle.latestDiscussAfterLastMeeting(room.roomId, [{
    id: discuss.id, from: discuss.from, fromId: discuss.fromId, text: discuss.text, ts: Date.parse(startedAt),
    kind: discuss.kind, mode: "discuss",
  }]), undefined, "Rehost must not revive the completed Meeting trigger");

  await harness.restartHub();
  const restartedHost = harness.actor("Host", "human", { cid: host.cid });
  await restartedHost.connect(harness.room, harness.room.hostToken);
  const baseline = await restartedHost.wait(frame => frame.t === "history"
    && frame.messages.some(message => message.text.includes("release note")), "restart history");
  assert(baseline.messages.some(message => message.text.includes("coordinate")));
  const owned = baseline.messages.find(message => message.text.includes("coordinate"));
  assert.strictEqual(owned.projectId, "project_simulation");
  assert.strictEqual(owned.threadId, "thread_simulation");
  const persistedCollaboration = baseline.messages.find(message => message.collaboration?.collaborationId === "collaboration-chat");
  assert.strictEqual(persistedCollaboration.collaboration.actorRole, "Lead");
  assert.strictEqual(baseline.messages.filter(message => message.clientRequestId === "client-request-1").length, 1,
    "client request dedup record survives restart");
  assert(baseline.messages.some(message => message.convergenceWarnings?.some(item => item.code === "normalized-message-loop")),
    "convergence warnings survive rehost and restart replay");
}

async function exerciseCollaborationJourney(harness) {
  const root = path.join(harness.projectsRoot, "collaboration");
  const ids = ["root-c", "project-c", "general-c", "thread-c", "task-c"];
  const store = new ProjectStore(root, () => ids.shift() || harness.ids.next());
  const project = store.createProject(command("collab-project", 1), "Collaboration");
  const thread = store.createThread(command("collab-thread", 2), project.entityId, "Delivery");
  const gantt = store.createGanttTask(command("collab-gantt", 3), project.entityId, {
    threadId:thread.entityId, title:"Structured delivery", startDate:"2026-09-27", endDate:"2026-09-28",
    progress:0, status:"not-started", owners:[{ name:"Worker A", role:"Worker" }, { name:"Worker B", role:"Worker" }], dependencyIds:[],
  });
  const contract = {
    objective:"Deliver a reviewed artifact", context:"baseline-v1", expectedOutput:"Release report",
    artifactType:"report", acceptanceCriteria:["tests pass", "review approved"], decisionRequired:true,
  };
  assertCode(() => store.createCollaborationTask(command("collab-ambiguous", 4), project.entityId, {
    collaborationId:"collaboration-ambiguous", title:"Ambiguous", threadId:thread.entityId,
    lead:"Lead", owners:["Worker A", "Worker B"], reviewers:["Reviewer"], ...contract,
    at:"2026-09-27T00:00:00.000Z",
  }), ProjectModelError, "collaboration-owner-ambiguous");
  assertCode(() => store.createCollaborationTask(command("collab-incomplete", 4), project.entityId, {
    collaborationId:"collaboration-incomplete", title:"Incomplete", threadId:thread.entityId,
    lead:"Lead", owners:["Worker A"], reviewers:["Reviewer"], at:"2026-09-27T00:00:00.000Z",
  }), ProjectModelError, "collaboration-contract-incomplete");
  const created = store.createCollaborationTask(command("collab-create", 4), project.entityId, {
    collaborationId:"collaboration-delivery", title:"Structured delivery", threadId:thread.entityId, ganttTaskId:gantt.entityId,
    lead:"Lead", owners:["Worker A", "Worker B"], reviewers:["Reviewer"], expectedResponders:["Worker A", "Worker B"],
    ownerPartitions:[{ owner:"Worker A", scope:"implementation" }, { owner:"Worker B", scope:"verification" }],
    ...contract,
    deadlineAt:"2026-09-28T00:00:00.000Z", agentSessionId:"agent_session_real", recipeRunId:"recipe_run_real",
    at:"2026-09-27T00:00:00.000Z",
  });
  assert.deepStrictEqual(created.snapshot.collaborationTasks[0].ownerPartitions,
    [{ owner:"Worker A", scope:"implementation" }, { owner:"Worker B", scope:"verification" }],
    "parallel Worker ownership requires durable explicit partitions");
  let storeVersion = 5;
  let taskVersion = 1;
  let ganttVersion = 1;
  assertCode(() => store.transitionCollaborationTask(command("collab-role-denied", storeVersion), {
    collaborationId:"collaboration-delivery", expectedVersion:taskVersion, action:"start", actorRole:"Reviewer", actor:"Reviewer",
    at:"2026-09-27T00:30:00.000Z", expectedGanttTaskVersion:ganttVersion,
  }), ProjectModelError, "collaboration-role-action-invalid");
  const transition = (id, action, actorRole, actor, extra = {}, at = "2026-09-27T01:00:00.000Z") => {
    const result = store.transitionCollaborationTask(command(id, storeVersion), {
      collaborationId:"collaboration-delivery", expectedVersion:taskVersion, action, actorRole, actor, at,
      expectedGanttTaskVersion:ganttVersion, ...extra,
    });
    storeVersion++; taskVersion++; ganttVersion++;
    return result;
  };
  transition("collab-start", "start", "Worker", "Worker A");
  transition("collab-handoff", "handoff", "Worker", "Worker B", { resolvedResponders:["Worker A", "Worker B"] });
  transition("collab-reject", "reject", "Reviewer", "Reviewer");
  assertCode(() => store.transitionCollaborationTask(command("collab-stale", storeVersion), {
    collaborationId:"collaboration-delivery", expectedVersion:3, action:"handoff", actorRole:"Worker", actor:"Worker A",
    at:"2026-09-27T02:00:00.000Z", expectedGanttTaskVersion:ganttVersion,
  }), ProjectModelError, "collaboration-version-conflict");
  transition("collab-retry-handoff", "handoff", "Worker", "Worker A");
  transition("collab-approve", "approve", "Reviewer", "Reviewer", { resolvedResponders:["Reviewer"] });
  assertCode(() => store.transitionCollaborationTask(command("collab-missing-output", storeVersion), {
    collaborationId:"collaboration-delivery", expectedVersion:taskVersion, action:"synthesize", actorRole:"Lead", actor:"Lead",
    at:"2026-09-27T02:10:00.000Z", expectedGanttTaskVersion:ganttVersion, resolvedResponders:["Lead"],
  }), ProjectModelError, "collaboration-output-required");
  assertCode(() => store.transitionCollaborationTask(command("collab-missing-evidence", storeVersion), {
    collaborationId:"collaboration-delivery", expectedVersion:taskVersion, action:"synthesize", actorRole:"Lead", actor:"Lead",
    at:"2026-09-27T02:11:00.000Z", expectedGanttTaskVersion:ganttVersion, resolvedResponders:["Lead"], resultArtifact:"report.md",
  }), ProjectModelError, "collaboration-acceptance-evidence-required");
  assertCode(() => store.transitionCollaborationTask(command("collab-missing-decision", storeVersion), {
    collaborationId:"collaboration-delivery", expectedVersion:taskVersion, action:"synthesize", actorRole:"Lead", actor:"Lead",
    at:"2026-09-27T02:12:00.000Z", expectedGanttTaskVersion:ganttVersion, resolvedResponders:["Lead"],
    resultArtifact:"report.md", evidenceSummary:"Tests and review passed.",
  }), ProjectModelError, "collaboration-decision-required");
  assertCode(() => store.transitionCollaborationTask(command("collab-unresolved-responder", storeVersion), {
    collaborationId:"collaboration-delivery", expectedVersion:taskVersion, action:"synthesize", actorRole:"Lead", actor:"Lead",
    at:"2026-09-27T02:12:30.000Z", expectedGanttTaskVersion:ganttVersion,
    resultArtifact:"report.md", evidenceSummary:"Tests and review passed.", decisionResult:"ship",
  }), ProjectModelError, "collaboration-responders-unresolved");
  assertCode(() => store.transitionCollaborationTask(command("collab-unrelated-evidence", storeVersion), {
    collaborationId:"collaboration-delivery", expectedVersion:taskVersion, action:"synthesize", actorRole:"Lead", actor:"Lead",
    at:"2026-09-27T02:13:00.000Z", expectedGanttTaskVersion:ganttVersion, resolvedResponders:["Lead"],
    resultArtifact:"report.md", evidenceSummary:"Explicit evidence.", decisionResult:"ship", evidenceMatchesContract:false,
  }), ProjectModelError, "collaboration-evidence-mismatch");
  transition("collab-synthesize", "synthesize", "Lead", "Lead", {
    resolvedResponders:["Lead"], resultArtifact:"report.md", evidenceSummary:"Tests and review passed.", decisionResult:"ship",
  });
  assertCode(() => store.transitionCollaborationTask(command("collab-no-claim", storeVersion), {
    collaborationId:"collaboration-delivery", expectedVersion:taskVersion, action:"complete", actorRole:"Lead", actor:"Lead",
    at:"2026-09-27T02:30:00.000Z", expectedGanttTaskVersion:ganttVersion,
  }), ProjectModelError, "collaboration-completion-claim-required");
  const completed = transition("collab-complete", "complete", "Lead", "Lead", { completionClaim:true });
  const completedTask = completed.snapshot.collaborationTasks[0];
  assert.strictEqual(completedTask.status, "completed");
  assert.strictEqual(completedTask.convergenceState, "converged");
  assert.deepStrictEqual(completedTask.history.map(entry => entry.action), ["assign","start","handoff","reject","handoff","approve","synthesize","complete"]);
  const completedGantt = completed.snapshot.ganttTasks.find(item => item.taskId === gantt.entityId);
  assert.deepStrictEqual({ status:completedGantt.status, progress:completedGantt.progress }, { status:"completed", progress:100 });

  store.createCollaborationTask(command("timeout-create", storeVersion++), project.entityId, {
    collaborationId:"collaboration-timeout", title:"Timeout", threadId:thread.entityId,
    lead:"Lead", owners:["Worker A"], reviewers:["Reviewer"], deadlineAt:"2026-09-27T00:30:00.000Z",
    ...contract, primaryOwner:"Worker A",
    at:"2026-09-27T00:00:00.000Z",
  });
  const timed = store.transitionCollaborationTask(command("timeout-due", storeVersion++), {
    collaborationId:"collaboration-timeout", expectedVersion:1, action:"timeout", actorRole:"Lead", actor:"Lead",
    at:"2026-09-27T00:31:00.000Z",
  });
  assert.strictEqual(timed.snapshot.collaborationTasks.find(item => item.collaborationId === "collaboration-timeout").status, "timed-out");
  assert(timed.snapshot.collaborationTasks.find(item => item.collaborationId === "collaboration-timeout").warnings
    .some(item => item.code === "collaboration-responder-timeout"));
  const resumed = store.transitionCollaborationTask(command("timeout-resume", storeVersion++), {
    collaborationId:"collaboration-timeout", expectedVersion:2, action:"resume", actorRole:"Lead", actor:"Lead",
    at:"2026-09-27T00:32:00.000Z",
  });
  assert.strictEqual(resumed.snapshot.collaborationTasks.find(item => item.collaborationId === "collaboration-timeout").status, "working");
  store.createCollaborationTask(command("blocked-create", storeVersion++), project.entityId, {
    collaborationId:"collaboration-blocked", title:"Blocked path", threadId:thread.entityId,
    lead:"Lead", owners:["Worker B"], reviewers:["Reviewer"], ...contract, primaryOwner:"Worker B", at:"2026-09-27T00:00:00.000Z",
  });
  const blocked = store.transitionCollaborationTask(command("blocked-set", storeVersion++), {
    collaborationId:"collaboration-blocked", expectedVersion:1, action:"block", actorRole:"Lead", actor:"Lead",
    at:"2026-09-27T00:10:00.000Z", note:"Dependency unavailable", blockedWaitingOn:["Worker A"],
  });
  assert.strictEqual(blocked.snapshot.collaborationTasks.find(item => item.collaborationId === "collaboration-blocked").status, "blocked");
  store.createCollaborationTask(command("cycle-create", storeVersion++), project.entityId, {
    collaborationId:"collaboration-cycle", title:"Cycle path", threadId:thread.entityId,
    lead:"Lead", owners:["Worker A"], reviewers:["Reviewer"], ...contract, primaryOwner:"Worker A", at:"2026-09-27T00:00:00.000Z",
  });
  const cycle = store.transitionCollaborationTask(command("cycle-block", storeVersion++), {
    collaborationId:"collaboration-cycle", expectedVersion:1, action:"block", actorRole:"Lead", actor:"Lead",
    at:"2026-09-27T00:21:00.000Z", blockedWaitingOn:["Worker B"],
  });
  assert(cycle.snapshot.collaborationTasks.find(item => item.collaborationId === "collaboration-cycle").warnings
    .some(item => item.code === "collaboration-dependency-cycle"));
  store.transitionCollaborationTask(command("blocked-resume", storeVersion++), {
    collaborationId:"collaboration-blocked", expectedVersion:2, action:"resume", actorRole:"Lead", actor:"Lead",
    at:"2026-09-27T00:22:00.000Z",
  });
  const restarted = new ProjectStore(root).list();
  assert.strictEqual(restarted.collaborationTasks.find(item => item.collaborationId === "collaboration-delivery").history.length, 8,
    "Project Thread collaboration history survives restart");
}

async function exerciseProjectJourney(harness) {
  const idValues = ["root", "alpha", "general-alpha", "beta", "general-beta", "topic", "design", "ship", "recipe"];
  const createId = () => idValues.shift() || harness.ids.next();
  let store = new ProjectStore(harness.projectsRoot, createId);
  const initial = store.list();
  assert.deepStrictEqual(initial.ganttTasks, [], "new Projects expose an explicit empty Gantt collection");
  const alpha = store.createProject(command("project-alpha", 1), "Alpha");
  const beta = store.createProject(command("project-beta", 2), "Beta");
  const thread = store.createThread(command("thread-topic", 3), alpha.entityId, "Topic");
  assertCode(() => store.moveThread(command("move-blocked", 4), {
    threadId: thread.entityId, destinationProjectId: beta.entityId,
    linkedActiveRunIds: ["run-1"], includedRunIds: [], audienceChanges: false, audienceChangeConfirmed: false,
  }), ProjectModelError, "active-run-move-blocked");
  assert.strictEqual(store.list().storeVersion, 4, "blocked mutations must not advance the store");

  const moved = store.moveThread(command("move-retry", 4), {
    threadId: thread.entityId, destinationProjectId: beta.entityId,
    linkedActiveRunIds: ["run-1"], includedRunIds: ["run-1"], audienceChanges: true, audienceChangeConfirmed: true,
  });
  assert.strictEqual(moved.snapshot.threads.find(item => item.threadId === thread.entityId).projectId, beta.entityId);
  const renamed = store.renameThread(command("thread-rename", 5), thread.entityId, "Delivery");
  assert.strictEqual(renamed.snapshot.threads.find(item => item.threadId === thread.entityId).threadId, thread.entityId);
  const linked = store.linkThreadChatroom(command("thread-room", 6), thread.entityId, {
    roomId:"room_simulation", roomName:"Beta · Delivery", linkedAt:"2026-09-27T00:00:00.000Z",
  });
  assert.strictEqual(linked.snapshot.threads.find(item => item.threadId === thread.entityId).chatroom.roomId, "room_simulation");
  const design = store.createGanttTask(command("gantt-design", 7), beta.entityId, {
    threadId:thread.entityId, title:"Design", startDate:"2026-09-27", endDate:"2026-09-28",
    progress:20, status:"in-progress", owners:[{ name:"Host", role:"Owner" }], dependencyIds:[],
  });
  const ship = store.createGanttTask(command("gantt-ship", 8), beta.entityId, {
    title:"Ship", startDate:"2026-09-29", endDate:"2026-09-30", progress:0, status:"not-started",
    owners:[], dependencyIds:[design.entityId],
  });
  assertCode(() => store.updateGanttTask(command("gantt-cycle", 9), design.entityId, {
    threadId:thread.entityId, title:"Design", startDate:"2026-09-27", endDate:"2026-09-28",
    progress:25, status:"in-progress", owners:[], dependencyIds:[ship.entityId],
  }), ProjectModelError, "gantt-dependency-cycle");
  assertCode(() => store.deleteGanttTask(command("gantt-delete", 9), design.entityId),
    ProjectModelError, "gantt-task-dependency-in-use");
  assertCode(() => store.createGanttTask(command("gantt-date", 9), beta.entityId, {
    title:"Malformed", startDate:"2026-02-30", endDate:"2026-03-01", progress:0, status:"not-started",
  }), ProjectModelError, "gantt-date-invalid");
  const updatedShip = store.updateGanttTask(command("gantt-update", 9), ship.entityId, {
    title:"Ship", startDate:"2026-09-29", endDate:"2026-10-01", progress:100, status:"completed",
    owners:[{ name:"Host", role:"Approver" }], dependencyIds:[],
  });
  assert.strictEqual(updatedShip.snapshot.ganttTasks.find(item => item.taskId === ship.entityId).version, 2);
  store.deleteGanttTask(command("gantt-delete-success", 10), design.entityId);

  const recipe = store.createRecipe(command("recipe-create", 11), { kind: "project", projectId: beta.entityId }, "Review");
  const currentRecipe = recipe.snapshot.recipes.find(item => item.recipeId === recipe.entityId);
  const updated = store.updateRecipe(command("recipe-update", 12), recipe.entityId, {
    name: "Review v2", category: "Simulation", description: "Deterministic review.",
    definition: currentRecipe.definition,
  });
  assert.strictEqual(updated.snapshot.recipes.find(item => item.recipeId === recipe.entityId).revision, 2);
  store.moveRecipeToTrash(command("recipe-trash", 13), recipe.entityId);
  const restored = store.restoreRecipeFromTrash(command("recipe-restore", 14), recipe.entityId);
  assert(restored.snapshot.recipes.some(item => item.recipeId === recipe.entityId));

  const replay = store.restoreRecipeFromTrash(command("recipe-restore", 0), "ignored");
  assert.strictEqual(replay.replayed, true);
  assertCode(() => store.restoreRecipeFromTrash(command("recipe-restore", 15, "different"), recipe.entityId),
    ProjectStoreError, "command-conflict");
  assertCode(() => store.createProject(command("stale-write", 1), "Stale"), ProjectStoreError, "store-version-conflict");

  store = new ProjectStore(harness.projectsRoot);
  const restarted = store.list();
  assert.strictEqual(restarted.storeVersion, 15);
  assert(restarted.projects.some(item => item.name === "Alpha"));
  assert(restarted.threads.some(item => item.threadId === thread.entityId && item.projectId === beta.entityId));
  assert.strictEqual(restarted.ganttTasks.length, 1);
  assert.strictEqual(restarted.ganttTasks[0].status, "completed");
  assert.strictEqual(initial.schema, 1);
}

async function exerciseAgentSessionJourney(harness) {
  const sessionId = "agent_session_simulation";
  const directory = path.join(harness.sessionsRoot, "agent-sessions");
  fs.mkdirSync(directory, { recursive: true });
  const recordPath = path.join(directory, `${sessionId}.json`);
  const record = {
    schema: "pkm.agent.session/v1", sessionId, status: "running",
    createdAt: harness.clock.iso(), updatedAt: harness.clock.iso(),
    todos: [{ status: "running" }],
  };
  fs.writeFileSync(recordPath, JSON.stringify(record), { mode: 0o600 });
  assert.strictEqual(projectedAgentSessionStatus(record), "running");
  record.todos[0].status = "succeeded";
  fs.writeFileSync(recordPath, JSON.stringify(record), { mode: 0o600 });
  assert.strictEqual(projectedAgentSessionStatus(record), "completed");
  assert.strictEqual(terminalAgentSessionStatus(record), true);
  harness.clock.tick(1000);
  await moveAgentSessionToTrash(harness.sessionsRoot, sessionId, { now: harness.clock.iso });
  assert(fs.existsSync(path.join(harness.sessionsRoot, "agent-sessions-trash", `${sessionId}.json`)));
  harness.clock.tick(1000);
  restoreAgentSessionFromTrash(harness.sessionsRoot, sessionId, harness.clock.iso);
  const restored = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  assert.strictEqual(restored.updatedAt, harness.clock.iso());
  assert.strictEqual(restored.trashedAt, undefined);
}

async function main() {
  const harness = new DeterministicSimulationHarness();
  try {
    assertSourceDerivedManifest();
    assertAbsentContracts();
    assertLegacyStructuredTaskFailsClosed();
    assertCommunicationReceiptTemplates();
    await exerciseChatroomJourney(harness);
    await exerciseProjectJourney(harness);
    await exerciseCollaborationJourney(harness);
    await exerciseAgentSessionJourney(harness);
    console.log("Chatroom+Project deterministic simulation: manifest, journeys, faults, replay, restart, and absent contracts OK");
  } finally {
    await harness.dispose();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
