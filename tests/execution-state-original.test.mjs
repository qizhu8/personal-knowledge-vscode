import test from "node:test";
import assert from "node:assert/strict";
import { settleProgressSteps } from "../dist/domain/execution-state-progress.js";

test("activity tool steps stay running through approvals and later stages until their own result", () => {
  const steps = [];
  const push = (label, step = {}) => { settleProgressSteps(steps, { label, ...step }, steps.length + 10); steps.push({ label, at:steps.length, status:"running", ...step }); };
  push("Running tool: run_process", { kind:"tool", toolCallId:"call-1" });
  push("Waiting for approval: Run program", { status:"waiting" });
  assert.equal(steps[0].status, "running", "an approval wait must not mark the running tool complete");
  push("Generating response", { kind:"model", round:0 });
  assert.equal(steps[0].status, "running", "unrelated later stages must not mark the running tool complete");
  assert.equal(steps[1].status, "complete", "non-tool stages still settle when the next stage starts");
  push("Completed tool: run_process", { kind:"tool", toolCallId:"call-1", status:"complete" });
  assert.equal(steps[0].status, "complete");
  assert.equal(steps[0].finishedAt, 13);
  push("Running tool: run_process", { kind:"tool", toolCallId:"call-2" });
  push("Failed tool: run_process", { kind:"tool", toolCallId:"call-2", status:"failed" });
  assert.equal(steps[4].status, "failed", "a failed result settles the tool's running step as failed");
  push("Model round", { operation:"inference" });
  push("Counting tokens", { operation:"token-count" });
  assert.equal(steps[6].status, "running", "token counting still does not settle an in-flight inference");
});
