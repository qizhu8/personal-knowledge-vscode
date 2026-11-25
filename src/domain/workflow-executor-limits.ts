export const WORKFLOW_EXECUTOR_LIMITS = Object.freeze({
  steps: 1024, iterations: 64, outputBytes: 65_536, snapshotBytes: 1_048_576,
  events: 8192, runs: 4096, receipts: 16_384, assignmentsPerRun: 2048,
  leaseMs: 300_000, deadlineMs: 86_400_000,
  treeSteps: 1000, treeDepth: 16, treeRuns: 32,
});
