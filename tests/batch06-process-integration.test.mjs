import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { z } from "zod";
import { compileWorkflowDefinitionV1 } from "../dist/domain/project-recipes-workflow-contracts.js";
import { httpCall, invocation, managerActor, nativeWorkspace, until } from "./batch06-manager-fixtures.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const commandKind = "pkm.step.command/v1";
async function processFixture(t) {
  const approvals = [];
  const secret = `ephemeral-${randomUUID()}`;
  let script;
  const f = await nativeWorkspace(t, root => {
    writeFileSync(resolve(root, "notes", "Command.md"), "# Command\n");
    const assets = resolve(root, "notes", "Command.assets");
    mkdirSync(assets, { recursive: true });
    script = resolve(assets, "fixture.mjs");
    writeFileSync(script, `
const mode = process.argv[2];
if (mode === "stdin") {
  let input = ""; for await (const chunk of process.stdin) input += chunk;
  console.log(JSON.stringify({value:42,secret:input}));
  console.error("stderr-never-persisted:"+input);
}
if (mode === "hang") { process.stdout.write("ready"); setInterval(() => {}, 1000); }
`);
    return { workflow: { adapters: {}, leaseMs: 5000, process: {
      adapterId: "native-command", version: 1, outputContractDigest: hash("integer-only"), authorizationDigest: hash("synthetic-policy"),
      commands: [{ id: "synthetic-child", executable: process.execPath, cwd: assets, directChildOnly: true,
        arguments: [{ literal: script }, { pattern: /^(stdin|hang)$/, maxBytes: 5 }],
        output: z.strictObject({ value: z.number().int() }) }],
      authorizeDefinition: binding => binding.actorId === managerActor.id,
      authorizeData: () => true, redactOutput: output => ({ value: output.value }),
      resolveStdin: async () => Buffer.from(secret),
      approve: async request => { approvals.push(request); return true; },
      limits: { graceMs: 30, closeDrainMs: 100 },
    } } };
  });
  const create = mode => {
    const definition = { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, outputs: {}, nodes: [{
      nodeId: "command", kind: commandKind, config: { program: "synthetic-child", args: [script, mode],
        timeoutSeconds: 5, maxOutputBytes: 1024 }, dependsOn: [],
    }], completion: { requiredNodes: ["command"] } } };
    const compiled = compileWorkflowDefinitionV1(definition);
    assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
    return { operationId: randomUUID(), runId: `native-process-${randomUUID()}`, source: { kind: "inline", definition },
      expectedExecutableDigest: compiled.executableDigest, deadline: Date.now() + 15_000, inputs: {} };
  };
  return { f, approvals, secret, script, create };
}

test("actual native HTTP configured workflow launches direct child with ephemeral stdin and persists only sanitized output", async t => {
  const { f, approvals, secret, script, create } = await processFixture(t);
  const url = await f.listen();
  const input = create("stdin");
  const started = await httpCall(url, f.bearer, "capability_call", invocation("workflow.executor.create", input));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const completed = await until(async () => {
    const response = await httpCall(url, f.bearer, "capability_read", invocation("workflow.executor.get", { runId: input.runId }));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.result.state === "succeeded" && response.body.result;
  }, "real direct child workflow");
  assert.deepEqual(completed.nodes[0].outputs, { value: 42 });
  assert.equal(approvals.length, 1);
  assert.deepEqual({ ...approvals[0], invocationId: undefined }, {
    actorId: managerActor.id, executableDigest: input.expectedExecutableDigest, nodeId: "command", invocationId: undefined,
    commandId: "synthetic-child", arguments: [script, "stdin"],
  });
  assert.deepEqual((await httpCall(url, f.bearer, "capability_call", invocation("workflow.executor.create", input))).body.result, started.body.result);
  assert.equal(approvals.length, 1, "immutable receipt must not replay the child");
  const database = new DatabaseSync(resolve(f.root, "core.sqlite"));
  try {
    const records = database.prepare("SELECT record_json FROM runtime_process_jobs").all();
    assert.equal(records.length, 1);
    const job = JSON.parse(records[0].record_json);
    assert.equal(job.state, "SUCCEEDED");
    assert.equal(job.stdin, undefined);
    assert.equal(job.stderr, "");
    assert.equal(job.stdout, "", "raw child stdout is ephemeral; sanitized output belongs to workflow receipt");
    for (const table of ["runtime_process_jobs", "runtime_process_events", "workflow_executor_runs", "workflow_executor_events", "receipts"]) {
      assert.equal(JSON.stringify(database.prepare(`SELECT * FROM ${table}`).all()).includes(secret), false, table);
    }
  } finally { database.close(); }
  await f.close();
  const bytes = await readFile(resolve(f.root, "core.sqlite"));
  assert.equal(bytes.includes(Buffer.from(secret)), false, "stdin/output secret absent from SQLite bytes");
});

test("reopening the native runtime resumes a durable ready workflow", async t => {
  const { f, create } = await processFixture(t);
  const input = create("stdin");
  const created = f.runtime.services.workflow.create(managerActor.id, input);
  assert.equal(created.state, "ready");
  await f.reopen();
  const completed = await until(async () => {
    const current = f.runtime.services.workflow.get(managerActor.id, input.runId);
    return current.state === "succeeded" && current;
  }, "recovered native workflow");
  assert.deepEqual(completed.nodes[0].outputs, { value: 42 });
});

test("actual native cancellation drains the owned direct child and hides public spawn/completion/approval", async t => {
  const { f, create } = await processFixture(t);
  const url = await f.listen();
  const input = create("hang");
  const started = await httpCall(url, f.bearer, "capability_call", invocation("workflow.executor.create", input));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const database = new DatabaseSync(resolve(f.root, "core.sqlite"));
  try {
    await until(() => database.prepare("SELECT 1 FROM runtime_process_jobs WHERE state='RUNNING'").get(), "owned child started");
    const run = (await httpCall(url, f.bearer, "capability_read", invocation("workflow.executor.get", { runId: input.runId }))).body.result;
    const cancelled = await httpCall(url, f.bearer, "capability_call", invocation("workflow.executor.cancel", {
      operationId: randomUUID(), runId: input.runId, expectedVersion: run.version,
    }));
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    await until(() => !database.prepare("SELECT 1 FROM runtime_process_jobs WHERE state='RUNNING'").get(), "cancelled child reaped");
    const job = JSON.parse(database.prepare("SELECT record_json FROM runtime_process_jobs").get().record_json);
    assert.equal(job.state, "CANCELLED");
    assert.equal(job.effect, "unknown");
    for (const operation of ["runtime.process.launch", "workflow.executor.run.complete", "execution.approve"]) {
      assert.equal((await httpCall(url, f.bearer, "capabilities_describe", { operation })).body.error.code, "NOT_FOUND", operation);
    }
  } finally { database.close(); }
  await f.close();
});
