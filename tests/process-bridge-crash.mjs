import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createProcessBridge } from "../dist/process-bridge.js";
import { WorkflowExecutor } from "../dist/workflow-executor.js";
import { compileWorkflowDefinitionV1 } from "../dist/domain/project-recipes-workflow-contracts.js";

const root = process.argv[2], script = resolve(root, "child.mjs"), marker = resolve(root, "completed");
const db = new DatabaseSync(resolve(root, "db.sqlite"));
const hash = text => createHash("sha256").update(text).digest("hex");
const bridge = createProcessBridge({
  database: db, workspaceRoot: root, adapterId: "bridge", version: 1,
  outputContractDigest: hash("out"), authorizationDigest: hash("auth"),
  commands: [{ id: "fixture", executable: process.execPath, cwd: root, directChildOnly: true,
    arguments: [{ literal: script }, { literal: marker }], output: z.strictObject({ value: z.number() }) }],
  authorizeDefinition: () => true, authorizeData: () => true, redactOutput: value => value, approve: async () => true,
});
const executor = new WorkflowExecutor(db, { workspaceRoot: root, ownerId: "crash-host", adapters: { "pkm.step.command/v1": bridge.adapter }, leaseMs: 5000 });
const node = { nodeId: "step", kind: "pkm.step.command/v1", config: {
  program: "fixture", args: [script, marker], timeoutSeconds: 3, maxOutputBytes: 1024,
}, dependsOn: [] };
const definition = { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, outputs: {}, nodes: [node], completion: { requiredNodes: ["step"] } } };
const compiled = compileWorkflowDefinitionV1(definition);
executor.create("alice", { operationId: randomUUID(), runId: "crash-run", source: { kind: "inline", definition },
  expectedExecutableDigest: compiled.executableDigest, deadline: Date.now() + 10_000, inputs: {} });
void executor.tick("alice", "crash-run");
for (let i = 0; i < 2000; i++) {
  const row = db.prepare("SELECT record_json FROM runtime_process_jobs").get();
  if (row && JSON.parse(row.record_json).pid) process.exit(0);
  await new Promise(resolve => setTimeout(resolve, 5));
}
console.error(JSON.stringify({
  owner: db.prepare("SELECT * FROM runtime_process_owner").all(),
  jobs: db.prepare("SELECT record_json FROM runtime_process_jobs").all(),
  runs: db.prepare("SELECT actor_id,run_id,snapshot FROM workflow_executor_runs").all(),
}));
process.exit(1);
