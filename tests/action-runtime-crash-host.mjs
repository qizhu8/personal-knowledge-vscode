import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const [rootArgument, runId, code, definitionJson] = process.argv.slice(2);
const root = resolve(rootArgument);
const build = resolve(process.env.PKM_ACTION_BUILD);
const load = path => import(pathToFileURL(resolve(build, path)).href);
const [{ ActionRuntime }, { createActionProcessBridge }, { readActionCompiler },
  { originalDigest }] = await Promise.all([
  load("action-runtime.js"), load("action-runtime-process.js"), load("action-compiler.js"),
  load("domain/action-compiler-validation.js"),
]);
const database = new DatabaseSync(resolve(root, "store.sqlite"));
const definition = JSON.parse(definitionJson);
const source = { kind: "inline", definition };
const compiled = readActionCompiler({ operation: "action.definition.compile", args: { source } });
if (compiled.status !== "valid") throw new Error("Crash fixture Action did not compile.");
const bridge = createActionProcessBridge({
  database, workspaceRoot: root,
  commands: [{
    id: "fixture", executable: process.execPath, cwd: root, directChildOnly: true,
    arguments: [{ literal: "-e" }, { literal: code }],
    outputContractDigest: originalDigest(definition.output_schema),
    authorizationDigest: "a".repeat(64),
    authorizeDefinition: binding => binding.actorId === "alice" && binding.actionId === definition.action_id,
    authorizeData: () => true,
    approve: async () => true,
    redactOutput: output => output,
  }],
  limits: { graceMs: 20, closeDrainMs: 200 },
});
const runtime = new ActionRuntime(database, { workspaceRoot: root, adapters: bridge.adapters });
runtime.create("alice", {
  operationId: randomUUID(), runId, source, expectedDefinitionDigest: compiled.definitionDigest,
  deadline: Date.now() + 30_000, inputs: { value: "fixture" },
});
const ticking = runtime.tick("alice", runId);
for (let index = 0; index < 400; index++) {
  const active = database.prepare("SELECT 1 FROM runtime_process_jobs WHERE state='RUNNING' LIMIT 1").get();
  if (active) {
    process.stdout.write("ACTION_CHILD_RUNNING\n");
    await ticking;
    process.exit(0);
  }
  await new Promise(resolveDelay => setTimeout(resolveDelay, 5));
}
throw new Error("Timed out waiting for the real Action child to start.");
