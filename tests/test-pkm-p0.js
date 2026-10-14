const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { PKM_OBJECT_KINDS, PKM_USER_STATES, PKM_ENTRY_POINTS, projectExecution } = require("../dist/runtime/pkm-projection");
const { BASELINE_PERSONAS, recordBaselineEvent, baselineReport, summarizeBaseline } = require("../dist/runtime/pkm-baseline");
const { RUN_STATES, NODE_STATES, ATTEMPT_STATES } = require("../dist/workflows/runtime-model");
const { BackgroundTaskRegistry } = require("../dist/runtime/background-task-registry");
const { ApiChatStore, apiChatProjection } = require("../dist/chat/api-chat-store");

assert.deepStrictEqual(PKM_OBJECT_KINDS, ["Action", "Recipe", "Run", "Project", "Collaboration"]);
assert.deepStrictEqual(PKM_USER_STATES, ["Planned", "Ready", "Running", "Waiting", "Needs review", "Blocked", "Completed", "Failed", "Cancelled", "Reconciling"]);
assert.deepStrictEqual([...new Set(Object.values(PKM_ENTRY_POINTS))].sort(), [...PKM_OBJECT_KINDS].sort());
const cases = {
  "recipe-runtime": [...RUN_STATES, ...NODE_STATES, ...ATTEMPT_STATES],
  "agent-session": ["running", "paused", "completed", "stopped", "failed"],
  "action-validation": ["queued", "running", "completed", "failed", "cancelled"],
  "action-runtime": ["running", "succeeded", "failed", "outcome_unknown", "cancelled"],
  "chat-worker": ["idle", "pending", "running", "awaiting-input", "waiting-input", "awaiting-result", "sleeping", "complete", "completed", "new-result", "interrupted", "failed", "cancelled", "paused", "stopped"],
  project: ["not-started", "in-progress", "blocked", "completed"],
  collaboration: ["assigned", "working", "review", "synthesis", "completed", "blocked", "timed-out", "contract-incomplete", "awaiting-work", "awaiting-responders", "awaiting-review", "awaiting-decision", "ready-to-complete", "converged", "escalated"],
};
for (const [source, states] of Object.entries(cases)) for (const state of states) {
  const projection = projectExecution(source, state);
  assert(PKM_USER_STATES.includes(projection.state), `${source}/${state}`);
  assert(!projection.reason.includes("not mapped"), `${source}/${state}`);
  assert(projection.reason && projection.resume);
  assert.strictEqual(projection.nextOwner === "none", projection.terminal);
}
assert.strictEqual(projectExecution("action-runtime", "outcome_unknown").state, "Reconciling");
assert.strictEqual(projectExecution("action-runtime", "succeeded", { executionPhase: "reconciling" }).state, "Reconciling");
assert.strictEqual(projectExecution("action-runtime", "running", { executionPhase: "created" }).state, "Ready");
assert.strictEqual(projectExecution("action-runtime", "running", { executionPhase: "dispatched", waiting: true }).state, "Waiting");
assert.strictEqual(projectExecution("recipe-runtime", "locked").nextOwner, "dependency");
assert.strictEqual(projectExecution("recipe-runtime", "paused").nextOwner, "user");
assert.strictEqual(projectExecution("action-runtime", "running", { approvalRequired: true }).nextOwner, "user");
assert.strictEqual(projectExecution("action-runtime", "running", { approvalRequired: true, unknownEffect: true }).state, "Reconciling");
assert.strictEqual(projectExecution("agent-session", "running", { interrupted: true }).state, "Reconciling");
assert.strictEqual(projectExecution("chat-worker", "awaiting-input").nextOwner, "user");
assert.strictEqual(projectExecution("recipe-runtime", "succeeded", { waiting: true }).state, "Completed");
assert.strictEqual(projectExecution("project", "a-new-state").state, "Needs review");
assert.strictEqual(projectExecution("recipe-runtime", "closed-indeterminate").terminal, false);

const directory = path.join(__dirname, "fixtures", `.p0-validation-${process.pid}`);
fs.mkdirSync(directory);
try {
  recordBaselineEvent(directory, false, { kind: "start-request", source: "action-runtime", evidence: "observed" });
  assert(!fs.existsSync(path.join(directory, "p0-baseline.json")));
  const missing = baselineReport(directory, true);
  assert.strictEqual(missing.observed.startSuccess.value, null);
  assert.strictEqual(missing.observed.unknownEffects, null);
  assert.strictEqual(missing.observed.nextStepMs.mean, null);
  assert(missing.personas.every(row => row.humanUxEvidence === "unavailable"));
  recordBaselineEvent(directory, true, { kind: "start-request", source: "chat-worker", evidence: "observed",
    prompt: "NEVER-STORE-ME", input: "NEVER-STORE-ME", output: "NEVER-STORE-ME", body: "NEVER-STORE-ME", id: "NEVER-STORE-ME" });
  recordBaselineEvent(directory, true, { kind: "start-success", source: "chat-worker", evidence: "observed" });
  assert(!fs.readFileSync(path.join(directory, "p0-baseline.json"), "utf8").includes("NEVER-STORE-ME"));
  assert.strictEqual(baselineReport(directory, true).observed.startSuccess.value, 1);
  assert.strictEqual(baselineReport(directory, true).observed.cancellation.value, null, "No observed cancellation is not proof of zero cancellation");
  for (const event of [
    { kind: "untrusted-body", source: "chat-worker", evidence: "observed" },
    { kind: "approval", source: "untrusted-body", evidence: "observed" },
    { kind: "approval", source: "chat-worker", evidence: "untrusted-body" },
    { kind: "approval", source: "chat-worker", evidence: "observed", count: 0 },
    { kind: "approval", source: "chat-worker", evidence: "observed", durationMs: -1 },
  ]) recordBaselineEvent(directory, true, event);
  assert.strictEqual(baselineReport(directory, true).observed.samples, 2);
  assert.strictEqual(baselineReport(directory, false).observed.samples, 0, "Disabled report does not read retained evidence");

  for (const failure of ["lock-failed", "write-failed"]) {
    const faultDirectory = path.join(directory, failure);
    for (const kind of ["start-request", "start-success"]) assert.strictEqual(
      recordBaselineEvent(faultDirectory, true, { kind, source: "action-runtime", evidence: "observed" }).status, "recorded");
    const saved = fs.readFileSync(path.join(faultDirectory, "p0-baseline.json"), "utf8");
    const original = failure === "lock-failed" ? fs.openSync : fs.writeFileSync;
    const method = failure === "lock-failed" ? "openSync" : "writeFileSync";
    try {
      fs[method] = function(file, ...args) {
        if (typeof file === "string" && file.endsWith(failure === "lock-failed" ? "p0-baseline.lock" : ".tmp")) {
          throw Object.assign(new Error("PRIVATE-PATH-AND-IDENTITY"), { code: "EIO" });
        }
        return original.call(fs, file, ...args);
      };
      assert.deepStrictEqual(recordBaselineEvent(faultDirectory, true, { kind: "completed", source: "action-runtime", evidence: "observed" }),
        { status: "unavailable", reasonCode: failure }, "Measurement failure returns a bounded outcome without throwing");
    } finally { fs[method] = original; }
    assert.strictEqual(fs.readFileSync(path.join(faultDirectory, "p0-baseline.json"), "utf8"), saved);
    const faultReport = baselineReport(faultDirectory, true);
    assert.strictEqual(faultReport.available, false);
    assert.deepStrictEqual(faultReport.collection, { status: "incomplete", reasonCode: failure });
    assert.strictEqual(faultReport.observed.startSuccess.value, null, "Incomplete recording cannot report trustworthy rates");
    assert(!JSON.stringify(faultReport).includes("PRIVATE-PATH-AND-IDENTITY"));
    assert.strictEqual(recordBaselineEvent(faultDirectory, true, { kind: "completed", source: "action-runtime", evidence: "observed" }).status, "recorded");
    assert.strictEqual(baselineReport(faultDirectory, true).collection.status, "incomplete", "A later success does not erase a lost observation");
    assert.strictEqual(baselineReport(faultDirectory, false).collection.status, "disabled");
  }
  const corruptDirectory = path.join(directory, "corrupt");
  fs.mkdirSync(corruptDirectory);
  fs.writeFileSync(path.join(corruptDirectory, "p0-baseline.json"), "{invalid");
  assert.deepStrictEqual(baselineReport(corruptDirectory, true).storage, { status: "unavailable", reasonCode: "invalid-storage" });
  assert.deepStrictEqual(recordBaselineEvent(corruptDirectory, true, { kind: "completed", source: "action-runtime", evidence: "observed" }),
    { status: "unavailable", reasonCode: "invalid-storage" });
  assert.strictEqual(fs.readFileSync(path.join(corruptDirectory, "p0-baseline.json"), "utf8"), "{invalid", "Corrupt evidence is not silently overwritten");

  const fixture = require("./fixtures/p0-baseline-scenarios.json");
  assert.strictEqual(fixture.evidence, "synthetic");
  assert.deepStrictEqual(fixture.scenarios.map(scenario => scenario.persona), BASELINE_PERSONAS);
  for (const scenario of fixture.scenarios) {
    for (const event of scenario.events) recordBaselineEvent(directory, true, {
      ...event, persona: scenario.persona, source: scenario.source, evidence: fixture.evidence,
    });
    const report = baselineReport(directory, true).personas.find(row => row.persona === scenario.persona);
    assert.strictEqual(report.synthetic.startSuccess.value, 1, scenario.persona);
    assert.strictEqual(report.human.samples, 0, `${scenario.persona}: fixture must not claim human evaluation`);
    assert.strictEqual(report.humanUxEvidence, "unavailable", scenario.persona);
  }
  const report = baselineReport(directory, true);
  assert.strictEqual(report.personas.find(row => row.persona === "researcher").synthetic.restartLoss.value, null);
  assert.strictEqual(report.personas.find(row => row.persona === "pm").synthetic.repeatedApproval.value, 0.5);
  assert.strictEqual(report.personas.find(row => row.persona === "developer").synthetic.cancellation.value, 0.5);
  assert.strictEqual(report.personas.find(row => row.persona === "student").synthetic.nextStepMs.mean, 30000);
  assert.strictEqual(report.personas.find(row => row.persona === "designer").synthetic.promotions.project.value, 1);
  recordBaselineEvent(directory, true, { kind: "next-step-found", source: "project", evidence: "human", persona: "student" });
  assert.strictEqual(baselineReport(directory, true).personas[0].humanUxEvidence, "unavailable", "A human event without timing does not provide timed UX evidence");
  recordBaselineEvent(directory, true, { kind: "next-step-found", source: "project", evidence: "human", persona: "student", durationMs: 54000 });
  const human = baselineReport(directory, true);
  assert.strictEqual(human.personas[0].humanUxEvidence, "available");
  assert.strictEqual(human.personas[0].human.nextStepMs.mean, 54000);
  assert.strictEqual(human.personas[0].synthetic.nextStepMs.mean, 30000);
  assert.strictEqual(human.observed.nextStepMs.mean, null);

  const transitions = [];
  const registry = new BackgroundTaskRegistry(() => new Date(0), (task, previous) => transitions.push([task.status, previous?.status]));
  const producer = registry.producer({ id: "fixture", kind: "action-validation", label: "Private input title" });
  producer.queued(); producer.queued(); producer.running(); producer.running();
  assert.deepStrictEqual(transitions, [["queued", undefined], ["running", "queued"]]);
  assert.strictEqual(registry.snapshot().tasks[0].projection.objectKind, "Action");
  producer.idle(); assert.strictEqual(registry.snapshot().tasks.length, 0);

  let enabled = true;
  const store = new ApiChatStore(path.join(directory, "state"), "0123456789abcdef", () => enabled, path.join(directory, "chat-baseline"));
  const chat = store.create();
  chat.progress = { startedAt: 100, status: "running", model: "fixture", steps: [] };
  store.save(chat); store.save(chat);
  assert.strictEqual(apiChatProjection(chat).state, "Running");
  assert.strictEqual(apiChatProjection(chat, true).state, "Needs review");
  chat.progress.status = "complete"; chat.progress.finishedAt = 200;
  store.save(chat); store.save(chat);
  let chatReport = baselineReport(path.join(directory, "chat-baseline"), true);
  assert.strictEqual(chatReport.observed.samples, 4, "Create, request, dispatch, completion once each");
  assert.strictEqual(chatReport.observed.startSuccess.value, 1);
  chat.messages.push({ id: "interrupted", role: "assistant", content: "Private output", status: "interrupted" });
  assert.strictEqual(apiChatProjection(chat).state, "Reconciling");
  enabled = false;
  chat.progress = { startedAt: 300, status: "running", model: "fixture", steps: [] };
  store.save(chat);
  assert.strictEqual(apiChatProjection(chat).state, "Running", "A new attempt is not reconciled merely because the preceding message was interrupted");
  assert.strictEqual(baselineReport(path.join(directory, "chat-baseline"), true).observed.samples, 4);
  assert(!fs.readFileSync(path.join(directory, "chat-baseline", "p0-baseline.json"), "utf8").includes("Private"));
} finally { fs.rmSync(directory, { recursive: true, force: true }); }

const source = fs.readFileSync(path.join(__dirname, "../src/webview/panel/15-projects.js"), "utf8");
const context = { vscode: { getState: () => ({}) }, RecipeGraph: { moduleTemplates: [] }, esc: String, setInterval: () => 0 };
vm.createContext(context); vm.runInContext(source, context);
const projection = projectExecution("agent-session", "running", { interrupted: true });
assert.strictEqual(context.agentSessionDisplayStatus({ status: "running", projection }).label, "Reconciling");
assert(context.agentSessionStatusIndicator({ status: "running", projection }).includes("Next: user"));
assert(context.pkmExecutionDetails(projection).includes("last reliable checkpoint"));
assert.strictEqual(summarizeBaseline([]).startSuccess.available, false);
console.log("P0 taxonomy, privacy, lifecycle, five synthetic persona fixtures and UI projection tests passed; human UX baseline remains unavailable.");
