import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { capture } from "./legacy-api-chat-recipes-fixtures.mjs";

test("ordinary child composes controlled Recipes without injected test policy; exact review, cancellation and killed-host recovery", {
  timeout: 90000, skip: process.platform !== "linux",
}, async t => {
  const fixture = resolve(`.migration-test-work/managed-recipe-child-${randomUUID()}`);
  const parent = join(fixture, "native"), legacyRoot = join(fixture, "original"), root = join(parent, "workspace");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await mkdir(legacyRoot, { mode: 0o700 });
  await writeFile(join(legacyRoot, "Original.md"), "Synthetic original root must remain untouched.\n");
  const original = capture(legacyRoot), children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined
      : new Promise(resolve => child.once("exit", resolve))));
    await rm(fixture, { recursive: true, force: true });
  });
  async function boot(message, expected = "ready") {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.NODE_CHANNEL_FD;
    const child = fork(fileURLToPath(new URL("../dist/managed-client-child.js", import.meta.url)), [], {
      execArgv: [], env, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(child);
    let stderr = "", decide = () => false;
    const pending = new Map(), queue = [], listeners = [];
    child.stderr.on("data", bytes => { stderr += bytes; });
    child.on("message", value => {
      if (value.type === "recipe-approval-request") {
        child.send({ type: "recipe-approval-result", approvalId: value.approvalId, challenge: value.challenge,
          approved: decide(value) });
      } else if (value.type === "result") {
        const request = pending.get(value.id);
        pending.delete(value.id);
        value.error ? request?.reject(new Error(`${value.error}: ${value.message}`)) : request?.resolve(value.result);
      } else if (listeners.length) listeners.shift()(value); else queue.push(value);
    });
    const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => listeners.push(resolve));
    const exit = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal, stderr })));
    child.send(message);
    const ready = await next();
    assert.equal(ready.type, expected, JSON.stringify(ready) + stderr);
    return {
      child, exit, ready,
      async command(command, approved = false) {
        const id = randomUUID(), approvalId = randomUUID();
        decide = value => {
          assert.equal(value.approvalId, approvalId);
          assert.equal(value.binding.root, root);
          assert.equal(value.binding.actorId, "local:owner");
          return approved;
        };
        const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
        child.send({ type: "recipe-command", id, approvalId, command });
        return result;
      },
      async close() { child.send({ type: "close" }); assert.deepEqual(await exit, { code: 0, signal: null, stderr: "" }); },
    };
  }
  let host = await boot({ type: "start", directory: parent, legacyRoot });
  let state = await host.command({ operation: "state" });
  const { workspaceId, namespace, chatId } = state.binding;
  assert.equal(state.catalog.recipes.length, 0);
  const recipeId = `recipe_${randomUUID()}`, definition = { schema: "pkm.workflow.definition/v1", spec: {
    inputs: {}, outputs: {}, completion: { requiredNodes: ["work"] }, nodes: [
      { nodeId: "gate", kind: "pkm.gate.human/v1", config: { inputKind: "approval", prompt: "Explicitly approve synthetic work?" },
        dependsOn: [], ports: { inputs: [], outputs: ["approved", "rejected"] } },
      { nodeId: "work", kind: "pkm.step.noop/v1", config: {}, dependsOn: [{ from: "gate", accept: ["approved"], required: true }] },
    ],
  } };
  const save = { operation: "save", input: { namespace, chatId, operationId: randomUUID(), expectedDigest: state.state.digest,
    recipeId, expectedRevision: 0, fields: { name: "Ordinary controlled Recipe", category: "", description: "Synthetic only.", definition } } };
  await assert.rejects(host.command(save), /fresh exact private host authority/);
  assert.equal((await host.command({ operation: "state" })).catalog.recipes.length, 0);
  const saved = await host.command(save, true);
  assert.equal(saved.recipe.revision, 1);
  const call = async (name, args, approved = true) => {
    const result = await host.command({ operation: "execute", input: { operation: `mcp.tool.recipe_run_${name}`, args } }, approved);
    assert(!result.error, JSON.stringify(result));
    assert.equal(result.result.ok, true, JSON.stringify(result));
    return result.result;
  };
  const start = { recipe_id: recipeId, command_id: "ordinary-human-wait", inputs_json: '{"synthetic":"global"}', detail: "full" };
  await assert.rejects(call("start", start, false), /decision declined/);
  const started = await call("start", start);
  const gate = await call("next", { run_id: started.run_id, command_id: "ordinary-claim", detail: "full" });
  assert.equal(gate.next_action.kind, "request_user_input");
  const identity = async path => { const stat = await lstat(path, { bigint: true }); return `${stat.dev}:${stat.ino}`; };
  const pin = { schema: "pkm.next-recipe-workspace/v1", parent, workspaceId,
    parentIdentity: await identity(parent), workspaceIdentity: await identity(root),
    databaseIdentity: await identity(join(root, "core.sqlite")), markerIdentity: await identity(join(root, ".pkm-next-workspace")) };
  host.child.kill("SIGKILL");
  assert.equal((await host.exit).signal, "SIGKILL");
  host = await boot({ type: "start-recipe-recovery", pin, legacyRoot });
  state = await host.command({ operation: "state" });
  assert.equal(state.catalog.recipes[0].recipeId, recipeId);
  assert.equal(state.binding.chatId, chatId);
  const resumed = await call("get", { run_id: started.run_id, detail: "full" });
  assert.deepEqual(resumed.next_action, gate.next_action);
  const input = { run_id: started.run_id, node_id: "gate", challenge_id: gate.next_action.challenge_id,
    response_json: '{"approved":true}', command_id: "ordinary-human-decision", detail: "full" };
  await assert.rejects(call("submit_input", input, false), /decision declined/);
  const work = await call("submit_input", input);
  assert.equal(work.next_action.node_id, "work");
  assert.deepEqual(work.next_action.inputs, { synthetic: "global" });
  const cancelled = await call("progress", { run_id: started.run_id, node_id: "work", command_id: "ordinary-request-cancel",
    progress_json: '{"cancellationRequested":true}', detail: "full" });
  assert.match(JSON.stringify(cancelled), /"cancellationRequested":true/);
  assert.equal(cancelled.status, "running", "Cooperative cancellation is not a fabricated terminal result.");
  const failed = await call("report", { run_id: started.run_id, node_id: "work", command_id: "ordinary-report-cancelled",
    outcome: "failed", error: "Caller acknowledged cancellation without performing work.", detail: "full" });
  assert.equal(failed.status, "failed");
  assert.deepEqual(capture(legacyRoot), original);
  host.child.send({ type: "close" });
  const closed = await host.exit;
  assert.equal(closed.code, 0, closed.stderr);
  const refused = await boot({ type: "start-recipe-recovery", pin: { ...pin, markerIdentity: "0:0" }, legacyRoot }, "startup-error");
  assert.match(refused.ready.message, /identity changed/);
  assert.equal((await refused.exit).code, 1);
  assert.equal(JSON.parse(await readFile(join(root, ".pkm-next-workspace"), "utf8")).id, workspaceId);
});
