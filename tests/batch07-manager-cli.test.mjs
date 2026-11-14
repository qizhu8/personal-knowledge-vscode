import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { cliFixture, invocation, sendSse, until } from "./batch07-cli-fixtures.mjs";
import { managerChatManifest } from "./manager-chat-fixtures.mjs";

test("actual configured CLI plans twenty simultaneous socket Chat workers and accepts only the native exact SQLite text manifest", { timeout: 45000 }, async t => {
  const { contract, compact, expected } = managerChatManifest(20);
  const calls = [];
  let active = 0, peak = 0, started = 0, release;
  const workers = new Promise(resolve => { release = resolve; });
  const f = await cliFixture(t, { async respond(payload, response) {
    assert.equal(payload.tools?.length ?? 0, 0, "Manager model turns have no tool/filesystem authority");
    const prompt = JSON.parse(payload.messages.at(-1).content), data = prompt.request;
    const stage = data.schema === "pkm.manager.chat.capsule/v1" ? "worker"
      : data.contract && data.freeze ? "verifier" : data.freeze ? "integrator" : "planner";
    calls.push({ stage, data });
    let output;
    if (stage === "planner") output = compact;
    else if (stage === "worker") {
      active++; peak = Math.max(peak, active);
      if (++started === 20) release();
      await workers;
      await new Promise(resolve => setTimeout(resolve, 20));
      active--;
      const path = `${data.task.writeScope[0]}/result.txt`;
      output = { schema: "pkm.manager.chat.delivery/v1", taskId: data.task.taskId,
        artifacts: [{ path, content: expected[path] }] };
    } else if (stage === "integrator") output = { schema: "pkm.manager.chat.integration/v1",
      freeze: data.freeze, paths: data.artifacts.map(item => item.path) };
    else output = { schema: "pkm.manager.chat.verification/v1", freeze: data.freeze,
      integration: data.integration, acceptanceIds: data.contract.acceptance.map(item => item.id) };
    sendSse(response, { content: JSON.stringify(output) });
  } });
  t.after(() => release());
  const path = resolve(f.root, "manager-text.json");
  await writeFile(path, JSON.stringify({ mode: "pinned-sqlite-text-artifacts/v1", maxConcurrentTurns: 20, contract, expected }), { mode: 0o600 });
  const child = await f.launch(["--human-review", "terminal", "--manager-text-config", path]);
  const runId = "socket-twenty";
  const args = { operationId: randomUUID(), runId, projectId: "socket-text-project", contract,
    budget: { maxWorkers: 20, maxConcurrentWorkers: 20, maxTasks: 23, maxAttemptsPerTask: 2 } };
  const startedRun = await child.rpc("capability_call", invocation("manager.runtime.start", args));
  assert.equal(startedRun.status, 200, JSON.stringify(startedRun));
  const read = () => child.rpc("capability_read", invocation("manager.runtime.get", { runId })).then(value => value.body.result);
  const run = await until(read, value => value && value.state !== "active");
  assert.equal(run.state, "succeeded", JSON.stringify(run));
  assert.equal(peak, 20);
  assert.equal(calls.filter(value => value.stage === "worker").length, 20);
  assert.deepEqual(calls.filter(value => value.stage !== "worker").map(value => value.stage), ["planner", "integrator", "verifier"]);
  assert.equal(run.tasks.filter(task => task.definition.phase === "worker" && task.state === "accepted").length, 20);
  assert.equal(run.checks.filter(check => check.kind === "e2e" && check.result.ok).length, 1);
  const freeze = calls.find(value => value.stage === "integrator").data.freeze;
  const manifest = await child.rpc("capability_read", invocation("manager.chat.artifacts", { runId, freeze }));
  assert.equal(manifest.status, 200, JSON.stringify(manifest));
  assert.equal(manifest.body.result.mode, "pinned-sqlite-text-artifacts/v1");
  assert.deepEqual(Object.fromEntries(manifest.body.result.artifacts.map(item => [item.path, item.content])), expected);
  const forged = await child.rpc("capability_read", invocation("manager.chat.artifacts", { runId, freeze: "0".repeat(64) }));
  assert.ok(forged.status !== 200 || forged.body.error);
  for (const artifactPath of Object.keys(expected))
    await assert.rejects(readFile(resolve(f.workspace, artifactPath)), { code: "ENOENT" });
  assert.equal((await child.rpc("capability_call", invocation("manager.runtime.start", args))).body.result.runId, runId);
  assert.equal(calls.length, 23, "same-ID receipt cannot replay completed model work");
});
