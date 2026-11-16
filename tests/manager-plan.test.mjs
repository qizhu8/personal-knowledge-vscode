import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  validateManagerPlan, validateManagerCompletionContract, managerTaskAttemptId, managerPlanDefinitionHash,
  createManagerPlan, assertManagerContractPreserved, assertManagerPlanDefinitionsFrozen,
} from "../dist/manager-plan.js";
import { assertIndependentWorkerScopes, workerLimits, rootWorkCriterion } from "../dist/domain/manager-plan-original.js";
import { managerPlanFixture } from "./manager-plan-fixtures.mjs";

const invalid = (plan, code) => {
  const result = validateManagerPlan(plan);
  assert.equal(result.status, "invalid", JSON.stringify(result));
  assert.ok(result.errors.some(issue => issue.code === code), JSON.stringify(result.errors));
};
for (const [kind, k] of [["migration", 24], ["feature", 5], ["research", 4], ["cleanup", 8], ["small", 1]]) {
  test(`complete ${kind} plan preserves the goal and explicit ${k}-worker budget`, () => {
    const plan = managerPlanFixture(kind, k);
    const result = validateManagerPlan(plan);
    assert.equal(result.status, "ready", JSON.stringify(result));
    assert.equal(result.plan.tasks.filter(task => task.phase === "worker").length, k);
    assert.equal(result.plan.contract.objective, plan.contract.objective);
    assert.equal(result.definitionHash.length, 64);
    assert.equal(Object.keys(result.taskDefinitionHashes).length, k + 3);
    assert.ok(Object.isFrozen(result.plan.tasks[0].dependsOn));
    plan.tasks[0].title = "mutated external proposal";
    assert.notEqual(result.plan.tasks[0].title, plan.tasks[0].title);
    assert.throws(() => { result.plan.contract.scope.push("lower scope"); }, TypeError);
  });
}
test("critical missing acceptance explicitly needs clarification and never calls a model", async () => {
  for (const field of ["objective", "scope", "acceptance", "outputs", "invariants", "stopConditions"]) {
    const plan = managerPlanFixture();
    delete plan.contract[field];
    const result = await createManagerPlan({ ...plan, contract: plan.contract }, async () => { assert.fail("must not invoke model"); });
    assert.equal(result.status, "needsClarification");
    assert.ok(result.questions.some(question => question.includes(field)));
  }
  const plan = managerPlanFixture();
  plan.contract.acceptance.forEach(item => { item.e2e = false; });
  assert.equal(validateManagerPlan(plan).status, "needsClarification");
  plan.contract.acceptance[0].verification = "";
  assert.equal(validateManagerPlan(plan).status, "needsClarification");
});
test("ambiguous completion cannot be represented by worker reports or verified booleans", () => {
  const plan = managerPlanFixture();
  plan.contract.acceptance[0].verified = true;
  plan.contract.acceptance[0].evidenceCallIds = ["self-report"];
  invalid(plan, "schema");
  assert.equal(validateManagerCompletionContract({ objective: "Do everything" }).status, "needsClarification");
});
test("task and criterion identities, missing prerequisites, cycles and quotas are checked", () => {
  for (const [edit, code] of [
    [plan => { plan.tasks[1].taskId = plan.tasks[0].taskId; }, "duplicate-task"],
    [plan => { plan.contract.acceptance[1].id = plan.contract.acceptance[0].id; }, "duplicate-criterion"],
    [plan => { plan.tasks[0].dependsOn = ["missing"]; }, "dependency"],
    [plan => { plan.tasks[0].dependsOn = ["worker-2"]; plan.tasks[1].dependsOn = ["worker-1"]; }, "cycle"],
    [plan => { plan.budget.maxConcurrentWorkers = plan.budget.maxWorkers + 1; }, "quota"],
    [plan => { plan.budget.maxWorkers--; }, "quota"],
    [plan => { plan.budget.maxTasks--; }, "quota"],
    [plan => { plan.budget.maxAttemptsPerTask = 0; }, "schema"],
    [plan => { plan.tasks[0].dependsOn = ["worker-2", "worker-2"]; }, "duplicate"],
  ]) { const plan = managerPlanFixture(); edit(plan); invalid(plan, code); }
});
test("unordered writes, ancestor paths, exclusive resources and read-after-write inputs are not independent", () => {
  for (const [edit, code] of [
    [plan => { plan.tasks[1].writeScope = plan.tasks[0].writeScope; }, "overlap"],
    [plan => { plan.tasks[0].writeScope = ["src"]; plan.tasks[1].writeScope = ["src/file.ts"]; }, "overlap"],
    [plan => { plan.tasks[0].resources = ["database"]; plan.tasks[1].resources = ["database"]; }, "overlap"],
    [plan => { plan.tasks[1].readScope = plan.tasks[0].writeScope; }, "read-write-overlap"],
    [plan => { plan.tasks[1].independence.traceId = plan.tasks[0].independence.traceId; }, "continuous-trace"],
    [plan => { plan.tasks[0].writeScope = ["src/**/*.ts"]; }, "scope"],
    [plan => { plan.tasks[0].writeScope = ["../escape"]; }, "scope"],
    [plan => { plan.tasks[0].writeScope = ["src\\file.ts"]; }, "scope"],
  ]) { const plan = managerPlanFixture(); edit(plan); invalid(plan, code); }
});
test("a genuinely dependent trace is serial and permits an ordered ownership handoff", () => {
  const plan = managerPlanFixture("small", 2);
  plan.tasks[1].dependsOn = [plan.tasks[0].taskId];
  plan.tasks[1].writeScope = [...plan.tasks[0].writeScope];
  plan.tasks[1].readScope = [...plan.tasks[0].writeScope];
  plan.tasks[1].independence.traceId = plan.tasks[0].independence.traceId;
  plan.assessment.kind = "serial";
  plan.assessment.independentTaskCount = 1;
  assert.equal(validateManagerPlan(plan).status, "ready");
  plan.assessment.kind = "parallel";
  invalid(plan, "independence");
});
test("coverage reaches integration, whole-goal E2E verification and conditional repair", () => {
  for (const phase of ["worker", "integrator", "verifier", "repair"]) {
    const plan = managerPlanFixture();
    plan.tasks.filter(task => task.phase === phase).forEach(task => { task.acceptanceIds = ["whole"]; });
    invalid(plan, "coverage");
  }
  for (const edit of [
    plan => { plan.tasks.find(task => task.phase === "integrator").dependsOn = []; },
    plan => { plan.tasks.find(task => task.phase === "verifier").dependsOn = ["worker-1"]; },
    plan => { plan.tasks.find(task => task.phase === "verifier").writeScope = ["deliverables"]; },
    plan => { plan.tasks.find(task => task.phase === "repair").dependsOn = ["integrate"]; },
    plan => { plan.tasks.find(task => task.phase === "repair").trigger = "always"; },
    plan => { plan.tasks = plan.tasks.filter(task => task.phase !== "repair"); },
  ]) { const plan = managerPlanFixture(); edit(plan); invalid(plan, "phase"); }
});
test("injected native planner is schema-constrained, host contract immutable, no fake fallback", async () => {
  const plan = managerPlanFixture("feature", 3);
  const request = { planId: plan.planId, revision: plan.revision, contract: plan.contract, budget: plan.budget };
  let calls = 0;
  const result = await createManagerPlan(request, async input => {
    calls++;
    assert.match(input.instructions, /not a hard-coded target of 20/);
    assert.match(input.instructions, /single dependency trace directly/);
    assert.ok(Object.isFrozen(input.request.contract.acceptance));
    assert.ok(input.outputSchema.safeParse(plan).success);
    return structuredClone(plan);
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "ready");
  await assert.rejects(createManagerPlan(request, undefined), /callback must be injected/);
  const lowered = structuredClone(plan); lowered.contract.objective = "Only deliver one endpoint";
  assert.equal((await createManagerPlan(request, async () => lowered)).errors[0].code, "authority");
  const expanded = structuredClone(plan); expanded.budget.maxWorkers++;
  assert.equal((await createManagerPlan(request, async () => expanded)).errors[0].code, "authority");
});
test("native planner can expose semantic ambiguity without fabricating a reduced plan", async () => {
  const plan = managerPlanFixture("feature", 2);
  const request = { planId: plan.planId, revision: plan.revision, contract: plan.contract, budget: plan.budget };
  const result = await createManagerPlan(request, async ({ outputSchema }) => {
    const clarification = { status: "needsClarification", questions: ["Which public browser acceptance covers offline recovery?"] };
    assert.ok(outputSchema.safeParse(clarification).success);
    return clarification;
  });
  assert.equal(result.status, "needsClarification");
  assert.equal("plan" in result, false);
  assert.equal((await createManagerPlan(request, async () => ({ status: "needsClarification", questions: [] }))).status, "invalid");
  request.budget.maxConcurrentWorkers = request.budget.maxWorkers + 1;
  assert.equal((await createManagerPlan(request, async () => assert.fail("invalid host budget must not invoke native model"))).status, "invalid");
});
test("native bounded scope rules also apply to single serial workers and ordered tasks", () => {
  const plan = managerPlanFixture("small", 1);
  plan.tasks[0].resources = ["x".repeat(257)];
  invalid(plan, "scope");
  plan.tasks[0].resources = [];
  plan.tasks[0].writeScope = ["x".repeat(257)];
  invalid(plan, "scope");
});
test("stable attempt identities and canonical hashes exclude caller object-key ordering", () => {
  assert.equal(managerTaskAttemptId("plan", "task", 1), managerTaskAttemptId("plan", "task", 1));
  assert.notEqual(managerTaskAttemptId("plan", "task", 1), managerTaskAttemptId("plan", "task", 2));
  assert.notEqual(managerTaskAttemptId("plan", "task", 1), managerTaskAttemptId("plan", "other", 1));
  assert.throws(() => managerTaskAttemptId("plan", "task", 0));
  assert.throws(() => managerTaskAttemptId("plan", "task", 101));
  assert.equal(managerPlanDefinitionHash({ a: 1, b: 2 }), managerPlanDefinitionHash({ b: 2, a: 1 }));
});
test("revision cannot edit frozen tasks or omit original whole-goal requirements", async () => {
  const previous = managerPlanFixture("small", 1);
  const next = structuredClone(previous); next.revision++; next.contract.revision++;
  assert.doesNotThrow(() => assertManagerPlanDefinitionsFrozen(previous, next));
  assert.doesNotThrow(() => assertManagerContractPreserved(previous.contract, next.contract));
  next.tasks[0].title = "reassigned under same ID";
  assert.throws(() => assertManagerPlanDefinitionsFrozen(previous, next), /Frozen task/);
  const result = await createManagerPlan({
    planId: next.planId, revision: next.revision, contract: next.contract, budget: next.budget, previousPlan: previous,
  }, async () => next);
  assert.equal(result.status, "invalid"); assert.equal(result.errors[0].code, "frozen-definition");
  for (const field of ["scope", "nonGoals", "acceptance", "outputs", "invariants", "stopConditions"]) {
    const changed = structuredClone(previous.contract); changed.revision++; changed[field] = [];
    assert.throws(() => assertManagerContractPreserved(previous.contract, changed), /preserve/);
  }
});
test("bounded JSON definitions reject oversized and circular records", () => {
  const circular = {}; circular.contract = circular;
  invalid(circular, "boundary");
  const plan = managerPlanFixture(); plan.large = "x".repeat(2_000_001);
  invalid(plan, "boundary");
});
test("provenance references actual repository native Manager source and exact captured guards", async () => {
  const root = new URL("../", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("migration/manager-plan-provenance.json", root), "utf8"));
  assert.equal(manifest.sourceRoot, "..");
  assert.equal(manifest.capturedRoot, ".");
  const hash = value => createHash("sha256").update(value).digest("hex");
  for (const entry of manifest.files) {
    assert.equal(hash(await readFile(new URL(`legacy/${entry.source}`, root))), entry.sourceSha256);
    assert.equal(hash(await readFile(new URL(entry.captured, root))), entry.capturedSha256);
  }
  assert.match(rootWorkCriterion, /original user objective/);
  assert.doesNotThrow(() => workerLimits(24, 40));
  assert.throws(() => workerLimits(40, 24));
  assert.throws(() => assertIndependentWorkerScopes([{ writeScope: ["src"] }, { writeScope: ["src/a.ts"] }]), /overlap/);
});
