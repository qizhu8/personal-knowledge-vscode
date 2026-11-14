#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");
const { ProjectStore } = require("../dist/workflows/project-store");
const { projectCockpit, projectCockpits } = require("../dist/workflows/project-cockpit");
const root = path.join(__dirname, ".project-cockpit-work", crypto.randomUUID());
const state = path.join(root, ".pkm", "state");
let nextId = 0, nextCommand = 0;
const store = new ProjectStore(state, () => `fixture-${++nextId}`);
const command = () => {
  const id = `command-${++nextCommand}`;
  return { commandId: id, fingerprint: id, expectedStoreVersion: store.list().storeVersion };
};
const write = (relative, value) => {
  const file = path.join(state, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
};
const byId = id => store.list().projects.find(project => project.projectId === id);
const expectCode = (callback, code) => assert.throws(callback, error => error.code === code);
try {
  const blankCommand = command();
  const blank = store.createProject(blankCommand, "Blank");
  assert.strictEqual(blank.snapshot.projects.at(-1).goal, undefined, "Capture needs no intent form");
  assert.strictEqual(store.createProject(blankCommand, "Blank").replayed, true);
  const created = store.createProject(command(), "Research", {}, "research");
  const id = created.entityId;
  assert.strictEqual(byId(id).currentMilestone, "Scope and collect");
  expectCode(() => store.updateProject(command(), id, { goal: "Changed silently" }, ""), "project-decision-reason-required");
  const before = byId(id);
  store.updateProject(command(), id, { goal: "Review selected papers", successCriteria: ["Trace claims"], owner: "Researcher", deadline: "2026-10-30", autonomyPolicyReference: "policy:research", status: "active" }, "Narrow scope to selected papers");
  const changed = byId(id);
  assert.strictEqual(changed.decisions.length, before.decisions.length + 1);
  assert.strictEqual(changed.decisions.at(-1).changes[0].before, before.goal);
  assert.strictEqual(changed.decisions.at(-1).reason, "Narrow scope to selected papers");
  assert.strictEqual(changed.timeline.at(-1).kind, "decision");
  expectCode(() => store.updateProject(command(), id, { status: "waiting" }, "x"), "project-status-invalid");
  expectCode(() => store.updateProject(command(), id, { deadline: "2026-02-30" }, ""), "project-deadline-invalid");
  expectCode(() => store.updateProject(command(), id, { successCriteria: "wrong" }, "x"), "project-summary-invalid");
  const promoted = store.createProject(command(), "Chat promotion", {}, "", { kind: "chat", id: "chat_fixture" });
  assert.strictEqual(byId(promoted.entityId).links[0].id, "chat_fixture");
  assert.strictEqual(store.createProject(command(), "Concurrent Chat promotion", {}, "", { kind: "chat", id: "chat_fixture" }).entityId, promoted.entityId);
  const beforeFailedPromotion = store.list().projects.length;
  expectCode(() => store.createProject(command(), "Invalid promotion", {}, "", [{ kind: "chat", id: "chat_invalid" }, { kind: "agent-session", id: "../unsafe" }]), "project-source-invalid");
  assert.strictEqual(store.list().projects.length, beforeFailedPromotion, "Invalid optional link cannot leave a partial promoted Project");
  const runId = `action_run_${"a".repeat(32)}`;
  const runPath = write(`actions/runs/${runId}/run.json`, {
    run_id: runId, action_id: "fixture.research", state: "waiting",
    capability_hash: "must-not-be-in-project-projection",
    execution: { phase: "waiting", owner: "user", reasonCode: "awaiting-review", receipts: [{ operation: "waiting", at: 1792000000 }],
      checkpoint: { checkpoint_id: "cp_1", run_id: runId, kind: "artifact-review", state: "waiting", owner: "Reviewer",
        proposal: { title: "Review paper selection", revision: "r1" }, proposal_digest: "digest-r1",
        evidence: [{ artifact_id: "artifact_fixture", sha256: "source-digest" }], deadline: 1792100000,
        timeout_behavior: "review", resume_token: "do-not-copy-authorization", options: ["accept", "reject"] } },
    artifacts: [{ artifact_id: "artifact_fixture", kind: "proposal", revision: "r1", provenance: ["paper:one"] }],
  });
  const digest = () => crypto.createHash("sha256").update(fs.readFileSync(runPath)).digest("hex");
  const originalDigest = digest();
  store.linkProject(command(), id, "action-run", runId);
  store.linkProject(command(), id, "action-run", runId);
  assert.strictEqual(byId(id).links.length, 1, "Source link is idempotent");
  let cockpit = projectCockpit(root, byId(id));
  assert.strictEqual(cockpit.now.waiting[0].projection.state, "Waiting");
  assert.strictEqual(cockpit.reviewInbox.length, 1);
  assert.strictEqual(cockpit.reviewInbox[0].owner, "Reviewer");
  assert.strictEqual(cockpit.reviewInbox[0].checkpoint.proposal_digest, "digest-r1");
  assert(!JSON.stringify(cockpit).includes("do-not-copy-authorization"));
  assert(!JSON.stringify(cockpit).includes("must-not-be-in-project-projection"));
  assert(cockpit.artifacts.some(item => item.sourceId === runId && item.kind === "proposal"));
  assert(cockpit.timeline.some(event => event.kind === "execution-receipt"));
  assert(cockpit.hasActiveRuns);
  expectCode(() => store.lifecycleProject(command(), id, "archive"), "project-active-runs");
  assert.strictEqual(digest(), originalDigest, "Project reads/links never mutate execution");
  const run = JSON.parse(fs.readFileSync(runPath));
  run.state = "outcome_unknown"; run.execution.phase = "reconciling";
  fs.writeFileSync(runPath, JSON.stringify(run));
  assert.strictEqual(projectCockpit(root, byId(id)).now.review[0].projection.state, "Reconciling");
  run.state = "succeeded"; run.execution.phase = "completed";
  run.execution.checkpoint.state = "resolved"; run.execution.checkpoint.answer = "accept";
  fs.writeFileSync(runPath, JSON.stringify(run));
  const terminalDigest = digest();
  cockpit = projectCockpit(root, byId(id));
  assert.strictEqual(cockpit.reviewInbox.length, 0);
  assert(cockpit.decisions.some(decision => decision.checkpointId === "cp_1" && decision.answer === "accept"));
  assert.strictEqual(cockpit.hasActiveRuns, false);
  expectCode(() => store.lifecycleProject(command(), id, "delete", true), "project-delete-confirmation-required");
  store.lifecycleProject(command(), id, "archive");
  expectCode(() => store.updateProject(command(), id, { owner: "Changed" }, ""), "project-inactive");
  expectCode(() => store.lifecycleProject(command(), id, "delete", false), "project-delete-confirmation-required");
  store.lifecycleProject(command(), id, "delete", true);
  assert(byId(id).deletedAt);
  assert(fs.existsSync(runPath));
  store.lifecycleProject(command(), id, "restore");
  assert(!byId(id).archivedAt && !byId(id).deletedAt);
  assert.strictEqual(digest(), terminalDigest);
  assert.strictEqual(new ProjectStore(state).list().projects.find(project => project.projectId === id).decisions.length, changed.decisions.length);
  assert.strictEqual(byId(id).timeline.at(-1).kind, "project-restore");
  const missing = `action_run_${"b".repeat(32)}`;
  store.linkProject(command(), blank.entityId, "action-run", missing);
  assert(projectCockpit(root, byId(blank.entityId)).hasActiveRuns);
  expectCode(() => store.lifecycleProject(command(), blank.entityId, "archive"), "project-active-runs");
  const defaultId = store.list().projects.find(project => project.systemKind).projectId;
  expectCode(() => store.lifecycleProject(command(), defaultId, "archive"), "system-project-protected");

  write("agent-sessions/agent_session_fixture.json", { schema: "pkm.agent.session/v1", sessionId: "agent_session_fixture", projectId: id, status: "running", task: "Research", recipeRunIds: ["recipe_fixture"], checkpoints: [{ sequence: 1, at: "2026-10-14T00:00:00Z" }] });
  write("recipe-runs/recipe_fixture.json", { schema: "pkm.recipe.run/v1", runId: "recipe_fixture", status: "running", recipeName: "Synthesis", nodes: {
    review: { state: "running", progress: { waitingOn: "human review" } }, broken: { state: "blocked" },
  }, definition: { spec: { nodes: [{ nodeId: "review", kind: "pkm.gate.human/v1" }] } } });
  const collaboration = [{ projectId: id, collaborationId: "collab_fixture", title: "Review synthesis", status: "review", convergenceState: "awaiting-review",
    resultArtifact: "proposal:fixture", artifactType: "proposal", evidenceLinks: ["source:fixture"], evidenceSummary: "Source backed", history: [{ action: "submit", at: "2026-10-14T00:00:00Z" }] }];
  cockpit = projectCockpits(root, store.list().projects, collaboration)[id];
  assert(cockpit.now.running.some(item => item.kind === "agent-session"));
  assert(cockpit.now.waiting.some(item => item.kind === "recipe-node"));
  assert(cockpit.now.blocked.some(item => item.kind === "recipe-node"));
  assert(cockpit.reviewInbox.some(item => item.kind === "collaboration"));
  assert(cockpit.artifacts.some(item => item.sourceId === "collab_fixture"));
  assert(cockpit.timeline.some(event => event.kind === "agent-checkpoint"));
  assert(cockpit.timeline.some(event => event.kind === "collaboration-transition"));
  const source = fs.readFileSync(path.join(__dirname, "../src/webview/panel/15-projects.js"), "utf8");
  const viewSource = source.slice(source.indexOf("function projectCockpitAsk("), source.indexOf("\nfunction projectNewThread("));
  const messages = [], fields = {};
  const context = { projectSnapshot: { cockpits: { [id]: cockpit } }, projectRoute: { projectId: id },
    esc: value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    projectZero: (title, description) => `${title}:${description}`,
    document: { getElementById: key => fields[key] }, ask: (type, data) => messages.push({ type, data }),
    window: { addEventListener() {} }, vscode: { getState: () => ({}), setState() {} },
  };
  vm.createContext(context); vm.runInContext(viewSource, context);
  const overview = context.projectCockpitOverview(byId(id));
  for (const label of ["Goal", "Success criteria", "Status", "Current milestone", "Owner", "Deadline", "Autonomy policy reference", "Decision reason"]) assert(overview.includes(label));
  const now = context.projectCockpitNow(byId(id));
  assert.strictEqual((now.match(/<h3>Review inbox<\/h3>/g) || []).length, 1);
  assert(now.includes("Next owner:"));
  assert(context.projectCockpitEvidence(byId(id), "Artifacts").includes(runId));
  assert(context.projectCockpitEvidence(byId(id), "Decisions").includes("Narrow scope"));
  assert(context.projectCockpitEvidence(byId(id), "Timeline").includes("not debug logs"));
  fields["cockpit-goal"] = { value: "Goal" }; fields["cockpit-success"] = { value: "One\nTwo" }; fields["cockpit-status"] = { value: "active" };
  context.projectSaveOverview({ preventDefault() {}, currentTarget: { dataset: { version: "1" } } });
  assert.strictEqual(messages.at(-1).type, "projectOverview");
  assert.deepStrictEqual(Array.from(messages.at(-1).data.overview.successCriteria), ["One", "Two"]);
  console.log("P2 synthetic acceptance: progressive creation, explicit decisions, durable evidence, canonical inbox, restart preservation and active Run lifecycle guards passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  const parent = path.dirname(root);
  if (fs.existsSync(parent) && !fs.readdirSync(parent).length) fs.rmdirSync(parent);
}
