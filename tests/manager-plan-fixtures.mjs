export function managerPlanFixture(kind = "migration", k = 24) {
  const objectives = {
    migration: "Migrate the entire server surface and verify every migrated endpoint end to end.",
    feature: "Deliver the complete collaboration feature including browser, API, recovery and acceptance.",
    research: "Research the complete question, synthesize independent source reviews and deliver a cited answer.",
    cleanup: "Clean every authorized dataset partition, preserve original records and verify the combined output.",
    small: "Fix the single bounded parser trace and verify the original symptom.",
  };
  const contract = {
    schema: "pkm.manager.completion/v1", goalId: `goal-${kind}`, revision: 1,
    objective: objectives[kind], scope: ["The whole requested outcome; no unreported remainder"],
    nonGoals: ["No production mutation or private knowledge access"],
    acceptance: [
      { id: "whole", criterion: objectives[kind], verification: "Run whole-objective acceptance against the integrated pinned output", e2e: true },
      { id: "preserve", criterion: "Preserve existing behavior and the authorized data boundary", verification: "Run regression and authorization-boundary checks", e2e: false },
    ],
    outputs: ["Integrated deliverable and repeatable acceptance report"],
    invariants: ["Never lower the goal or treat worker claims as final completion"],
    stopConditions: ["Stop successfully only after all whole-goal checks pass; stop blocked on missing critical input"],
  };
  const task = (taskId, phase, dependsOn, acceptanceIds = ["whole", "preserve"]) => ({
    taskId, title: taskId, objective: contract.objective, phase, dependsOn,
    readScope: [], writeScope: phase === "verifier" ? [] : [`deliverables/${taskId}`],
    resources: [], acceptanceIds, verification: "Produce a version-pinned handoff with current-attempt verification evidence",
    independence: { traceId: taskId, rationale: "Owns an independent partition with no cross-worker writes or undeclared shared inputs" },
    trigger: phase === "repair" ? "verification-failed" : "always",
  });
  const workers = Array.from({ length: k }, (_, index) => task(`worker-${index + 1}`, "worker", []));
  return {
    schema: "pkm.manager.plan/v1", planId: `plan-${kind}`, revision: 1, contract,
    budget: { maxWorkers: k, maxConcurrentWorkers: Math.min(k, 6), maxTasks: k + 3, maxAttemptsPerTask: 3 },
    assessment: { kind: k === 1 ? "serial" : "parallel", rationale: k === 1 ? "One continuous bounded trace; no delegation split" : "Disjoint independent partitions; k follows the explicit task budget", independentTaskCount: k },
    tasks: [...workers, task("integrate", "integrator", workers.map(item => item.taskId)),
      task("verify", "verifier", ["integrate"]), task("repair", "repair", ["verify"])],
  };
}
