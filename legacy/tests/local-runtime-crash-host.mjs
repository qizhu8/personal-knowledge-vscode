import { fork } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import assert from "node:assert/strict";
const [build, root, journalText, handleText, secondText, worker] = process.argv.slice(2);
const { HostLocalEnvironmentWorkflow } = await import(pathToFileURL(join(build, "host-local-environment-workflow.js")));
const journal = JSON.parse(journalText), handle = JSON.parse(handleText), second = JSON.parse(secondText);
if (worker) {
  const service = new HostLocalEnvironmentWorkflow(journal, root, false);
  const runId = service.start(handle, { args: ["crash-once"], waitMs: handle.provider === "node-project/v1" ? 0 : 20000 })[0].runId;
  const timer = setInterval(() => {
    const run = service.status(runId)[0];
    if (run.jobs.some(job => job.state === "RUNNING" && job.stdout.includes("crash-once"))) {
      clearInterval(timer); process.send({ runId });
    }
  }, 20);
} else {
  const child = fork(new URL(import.meta.url), [...process.argv.slice(2), "worker"], { stdio: ["ignore", "ignore", "inherit", "ipc"], env: {} });
  const { runId } = await new Promise((resolve, reject) => {
    child.once("message", resolve); child.once("error", reject);
    child.once("exit", () => reject(new Error("Worker exited before started effect")));
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGKILL"); await exited;
  assert.throws(() => new HostLocalEnvironmentWorkflow(second, root, true), /live owner/);
  await new Promise(resolve => setTimeout(resolve, 4300));
  assert.throws(() => new HostLocalEnvironmentWorkflow(second, root, false), /explicitly choose recovery/);
  const recovered = new HostLocalEnvironmentWorkflow(second, root, true);
  const result = recovered.status(runId)[0];
  assert.equal(result.state, "unknown"); assert.equal(result.effect, "unknown");
  assert.equal(result.jobs.length, 1); assert.equal(result.jobs[0].state, "INTERRUPTED");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(recovered.status(runId)[0].jobs.length, 1);
  await recovered.close();
  const reopened = new HostLocalEnvironmentWorkflow(second, root, false);
  assert.equal(reopened.status(runId)[0].state, "unknown");
  assert.equal(reopened.status(runId)[0].jobs.length, 1);
  await reopened.close();
  console.log("PASS no replay after real SIGKILL, explicit expired-owner recovery and second reopen.");
}
