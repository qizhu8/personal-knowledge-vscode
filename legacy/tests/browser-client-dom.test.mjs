import test from "node:test";
import assert from "node:assert/strict";
import { ProtocolClient, OPERATIONS } from "../next-server/browser/protocol.mjs";
import { mount, renderText } from "../next-server/browser/workspace.mjs";
import { fixtureDOM, syntheticServer, field, action, find, submit, click, until, hostile, runRecord } from "./browser-client-fixture.mjs";

async function setup(options = {}) {
  const server = await syntheticServer(options);
  const dom = fixtureDOM();
  const workspace = mount(dom.root, { client: new ProtocolClient({ origin: server.origin }), intervalMs: 5 });
  const token = field(dom.root, "Access token");
  token.value = server.token;
  submit(token);
  await until(() => dom.root.textContent.includes("Connected · isolated shared server"));
  await until(() => dom.root.textContent.includes("Native Knowledge"));
  return { ...dom, server, workspace, async close() { workspace.dispose(); await server.close(); } };
}

test("literal hostile Markdown never becomes markup, links or resource requests", () => {
  const { document } = fixtureDOM();
  const rendered = renderText(document, hostile);
  assert.equal(rendered.tagName, "PRE");
  assert.equal(rendered.textContent, hostile);
  assert.equal(rendered.children.length, 0);
});

test("authenticated Knowledge and Chat operate over shared server with safe DOM and cleanup", async () => {
  const fixture = await setup();
  const oldToken = field(fixture.root, "Access token");
  try {
    assert.equal(field(fixture.root, "Access token").value, "");
    click(action(fixture.root, "Native Knowledge"));
    await until(() => fixture.root.textContent.includes(hostile));
    click(action(fixture.root, "First Chat"));
    await until(() => fixture.root.textContent.includes("First Chat · ready"));
    await until(() => action(fixture.root, "Send").disabled === false);
    field(fixture.root, "Message").value = "Native request";
    submit(field(fixture.root, "Message"));
    await until(() => fixture.root.textContent.includes("Native model output"));
    const start = fixture.server.calls.find(call => call.path === "/v1/capability_call" && call.body.operation === "chat.turn.start");
    assert.equal(start.path, "/v1/capability_call");
    assert.equal(start.body.arguments.sessionId, "chat-1");
    assert.equal(start.body.arguments.messages.at(-1).content, "Native request");
    assert.match(start.body.arguments.operationId, /^[a-f0-9-]{36}$/);
    assert.equal(fixture.root.querySelectorAll("img").length, 0);
    assert.equal(fixture.root.querySelectorAll("script").length, 0);
    click(action(fixture.root, "Disconnect"));
    assert.equal(fixture.root.textContent.includes(hostile), false);
    assert.equal(field(fixture.root, "Message").value, "");
    assert.equal(action(fixture.root, "Send").disabled, true);
    const calls = fixture.server.calls.length;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(fixture.server.calls.length, calls);
    fixture.workspace.dispose();
    assert.equal(fixture.root.children.length, 0);
    submit(oldToken);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fixture.server.calls.length, calls);
  } finally { await fixture.close(); }
});

test("Manager shows early worker delivery while running, queues targeted feedback without cancel", async () => {
  const fixture = await setup();
  try {
    field(fixture.root, "Project ID").value = "project-1";
    field(fixture.root, "Run ID").value = "run-1";
    submit(field(fixture.root, "Run ID"));
    await until(() => fixture.root.textContent.includes("worker.delivery"));
    const result = find(fixture.root, element => element.className === "result-card");
    assert.ok(result.textContent.includes(hostile));
    assert.ok(fixture.root.textContent.includes("state: active"));
    assert.ok(fixture.root.textContent.includes("Native worker"));
    assert.ok(fixture.root.textContent.includes("Delivery ≠ verification ≠ E2E acceptance"));
    const secondary = find(fixture.root, element => element.tagName === "DETAILS" && element.textContent.startsWith("Detailed activity"));
    assert.ok(secondary);
    assert.notEqual(secondary.open, true);
    click(action(fixture.root, "Discuss this result"));
    assert.equal(field(fixture.root, "Worker task ID (optional)").value, "worker-1");
    field(fixture.root, "Feedback to Manager").value = "Keep this result, improve its tests.";
    submit(field(fixture.root, "Feedback to Manager"));
    await until(() => fixture.server.calls.some(call => call.path === "/v1/capability_call" && call.body.operation === "manager.runtime.feedback"));
    const feedback = fixture.server.calls.find(call => call.path === "/v1/capability_call" && call.body.operation === "manager.runtime.feedback").body.arguments;
    assert.deepEqual(Object.keys(feedback).sort(), ["expectedVersion", "message", "operationId", "runId", "taskId"]);
    assert.equal(feedback.taskId, "worker-1");
    assert.equal(feedback.expectedVersion, 1);
    assert.equal(fixture.server.calls.some(call => call.path === "/v1/capability_call" && call.body.operation === "manager.runtime.cancel"), false);
    await until(() => fixture.root.textContent.includes("pending checkpoint is not applied success"));
    assert.equal(find(fixture.root, element => element.className === "result-feed").children.filter(element => element.className === "result-card").length, 1);
  } finally { await fixture.close(); }
});

test("Manager prevents cross-project attachment and unavailable features do not claim success", async () => {
  const fixture = await setup();
  try {
    field(fixture.root, "Project ID").value = "different-project";
    field(fixture.root, "Run ID").value = "run-1";
    submit(field(fixture.root, "Run ID"));
    await until(() => fixture.root.textContent.includes("RUN_SCOPE_MISMATCH"));
    assert.equal(find(fixture.root, element => element.className === "result-card"), undefined);
  } finally { await fixture.close(); }
  const unavailable = await setup({ supported: new Set(["knowledge.document.list", "knowledge.document.get", "chat.session.list"]) });
  try {
    assert.ok(unavailable.root.textContent.includes("Manager capability unavailable"));
    assert.ok(unavailable.root.textContent.includes("Chat generation capability unavailable"));
    assert.equal(action(unavailable.root, "Plan and start").disabled, true);
    assert.equal(action(unavailable.root, "Send feedback").disabled, true);
    assert.equal(unavailable.server.calls.some(call => call.path === "/v1/capability_call"), false);
  } finally { await unavailable.close(); }
});

test("new native Manager start passes user completion contract and budget without fabricated plan", async () => {
  let received;
  const fixture = await setup({ handle: (operation, args) => {
    if (operation === "manager.runtime.start") {
      received = args;
      return { ...runRecord(), runId: args.runId, projectId: args.projectId };
    }
    if (operation === "manager.runtime.get" && received) return { ...runRecord(), runId: received.runId, projectId: received.projectId };
  } });
  try {
    const contract = { schema: "pkm.manager.completion/v1", goalId: "goal-1", revision: 1,
      objective: "Run native verification", scope: ["project-1"], nonGoals: [],
      acceptance: [{ id: "e2e", criterion: "Native acceptance passes", verification: {}, e2e: true }],
      outputs: ["artifact"], invariants: [], stopConditions: [] };
    const budget = { maxWorkers: 4, maxConcurrentWorkers: 2, maxTasks: 16, maxAttemptsPerTask: 2 };
    field(fixture.root, "Project ID").value = "project-1";
    field(fixture.root, "Completion contract (JSON)").value = JSON.stringify(contract);
    field(fixture.root, "Worker budget (JSON)").value = JSON.stringify(budget);
    submit(field(fixture.root, "Completion contract (JSON)"));
    await until(() => received !== undefined);
    assert.deepEqual(received.contract, contract);
    assert.deepEqual(received.budget, budget);
    assert.equal("plan" in received, false);
    assert.equal("actorId" in received, false);
    assert.match(received.operationId, /^[a-f0-9-]{36}$/);
  } finally { await fixture.close(); }
});

test("canonical progress overview/result cursor and pinned feedback are preferred when configured", async () => {
  const requests = [];
  const supported = new Set(Object.values(OPERATIONS).map(value => value.operation));
  const pin = "b".repeat(64);
  const fixture = await setup({ supported, handle: (operation, args) => {
    if (!operation.startsWith("manager.progress.")) return;
    requests.push({ operation, args });
    if (operation === "manager.progress.get") return {
      schema: "pkm.manager.progress/v1", runId: "run-1", projectId: "project-1", version: 2,
      state: "active", phase: { id: "workers", label: "Workers running" },
      doing: [{ taskId: "worker-1", title: "Projected worker", state: "doing" }],
      completed: [], remaining: [], blockers: [{ id: "blocker-1", kind: "task", label: "Awaiting native check" }],
      updatedAt: "2026-11-07T03:19:32Z", budget: runRecord().budget, freshness: "fresh", lastHeartbeatAt: null,
    };
    if (operation === "manager.progress.events") return {
      schema: "pkm.manager.progress.events/v1", runId: "run-1",
      events: args.cursor ? [] : [{
        eventId: "delivery-1", sequence: 1, kind: "result", time: "2026-11-07T03:19:32Z",
        taskId: "worker-1", attemptId: "attempt-1",
        result: { id: "result-1", summary: "Native intermediate delivery", verificationGrade: "delivery",
          artifact: { id: "artifact-1", sourcePin: { algorithm: "sha256", value: pin } } },
      }],
      nextSeq: 1, nextCursor: "opaque-cursor-1", hasMore: false, gaps: [], freshness: "fresh",
    };
    return { status: "applied", runId: "run-1", version: 2, target: args.target };
  } });
  try {
    field(fixture.root, "Project ID").value = "project-1";
    field(fixture.root, "Run ID").value = "run-1";
    submit(field(fixture.root, "Run ID"));
    await until(() => fixture.root.textContent.includes("Native intermediate delivery"));
    assert.ok(fixture.root.textContent.includes("Projected worker"));
    assert.ok(fixture.root.textContent.includes("Awaiting native check"));
    assert.ok(fixture.root.textContent.includes("Freshness: fresh"));
    await until(() => requests.some(request => request.operation === "manager.progress.events" && request.args.cursor));
    const resume = requests.find(request => request.operation === "manager.progress.events" && request.args.cursor).args;
    assert.equal(resume.cursor, "opaque-cursor-1");
    assert.equal("afterSeq" in resume, false);
    click(action(fixture.root, "Discuss this result"));
    field(fixture.root, "Feedback to Manager").value = "Please verify this exact pinned delivery";
    submit(field(fixture.root, "Feedback to Manager"));
    await until(() => requests.some(request => request.operation === "manager.progress.feedback"));
    const feedback = requests.find(request => request.operation === "manager.progress.feedback").args;
    assert.deepEqual(feedback.target, { kind: "result", taskId: "worker-1", attemptId: "attempt-1", resultId: "result-1" });
    assert.equal(feedback.expectedVersion, 2);
    assert.equal("actorId" in feedback, false);
    assert.equal("urgent" in feedback, false);
    assert.equal(fixture.server.calls.some(call => call.path === "/v1/capability_call" && call.body.operation === "manager.runtime.cancel"), false);
  } finally { await fixture.close(); }
});
