import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { cliFixture, invocation, until } from "./batch07-cli-fixtures.mjs";
import { codingPlan, addSource, clampSource } from "./coding-worker-fixtures.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const checkSource = `
import assert from "node:assert/strict";
import { add } from "./add.mjs";
import { clamp } from "./clamp.mjs";
const mode = process.argv[2];
for (let a = -9; a <= 11; a++) for (let b = -7; b <= 13; b++) {
  if (mode === "add" || mode === "e2e") assert.equal(add(a,b), a+b);
  if (mode === "clamp" || mode === "e2e") assert.equal(clamp(a+b), Math.max(0,Math.min(10,a+b)));
  if (mode === "e2e") assert.equal(clamp(add(a,b)), Math.max(0,Math.min(10,a+b)));
}
console.log(JSON.stringify({ok:true}));
`;
async function sqliteFiles(root) {
  const found = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && /\.sqlite(?:3)?$/.test(entry.name)) found.push(child);
    }
  }
  await visit(root);
  return found.sort();
}
function fragmentedSse(response, delta, finish) {
  const wire = `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
    + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`
    + 'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":100}}\n\ndata: [DONE]\n\n';
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (let offset = 0; offset < wire.length; offset += 73) response.write(wire.slice(offset, offset + 73));
  response.end();
}

test("configured CLI runs native coding workers through local SSE, isolated Node checks, repair, merge and E2E", { timeout: 60_000 }, async t => {
  const calls = [], attempts = new Map();
  const f = await cliFixture(t, { async respond(payload, response) {
    const user = payload.messages.find(message => message.role === "user")?.content;
    assert.equal(typeof user, "string");
    const capsule = JSON.parse(user);
    const taskId = capsule.task.taskId;
    const path = capsule.task.writeScope[0];
    const toolMessages = payload.messages.filter(message => message.role === "tool");
    calls.push({ taskId, capsule, toolMessages: toolMessages.length, tools: payload.tools });
    assert.deepEqual((payload.tools ?? []).map(tool => tool.function.name).sort(), ["source.list", "source.read"]);
    let delta, finish;
    if (toolMessages.length === 0) {
      delta = { tool_calls: [{ index: 0, id: `list-${calls.length}`, type: "function",
        function: { name: "source.list", arguments: "{}" } }] };
      finish = "tool_calls";
    } else if (toolMessages.length === 1) {
      delta = { tool_calls: [{ index: 0, id: `read-${calls.length}`, type: "function",
        function: { name: "source.read", arguments: JSON.stringify({ path }) } }] };
      finish = "tool_calls";
    } else {
      const source = JSON.parse(toolMessages.at(-1).content);
      assert.equal(source.path, path);
      assert.equal(source.hash, hash(source.content));
      const attempt = (attempts.get(taskId) ?? 0) + 1;
      attempts.set(taskId, attempt);
      let after = taskId === "add" ? source.content.replace("a - b", "a + b")
        : source.content.replace("return n;", "return Math.max(0, Math.min(10, n));");
      if (taskId === "clamp" && attempt === 1) after = source.content.replace("return n;", "return Math.min(10, n);");
      delta = { content: JSON.stringify({ schema: "pkm.coding.proposal/v1", taskId,
        patches: [{ path, beforeHash: source.hash, edits: [{ before: source.content, after }] }] }) };
      finish = "stop";
    }
    fragmentedSse(response, delta, finish);
  } });

  const { plan } = codingPlan();
  const sourceRoot = resolve(f.root, "disposable-source");
  const stageParent = resolve(f.root, "disposable-stages");
  await mkdir(sourceRoot, { mode: 0o700 });
  await mkdir(stageParent, { mode: 0o700 });
  const sourceFiles = {
    "add.mjs": addSource,
    "clamp.mjs": clampSource,
    "check.mjs": checkSource,
  };
  for (const [path, content] of Object.entries(sourceFiles))
    await writeFile(resolve(sourceRoot, path), content, { mode: path === "check.mjs" ? 0o400 : 0o600 });
  const codingConfigPath = resolve(f.root, "coding-host.json");
  await writeFile(codingConfigPath, JSON.stringify({
    schema: "pkm.coding-host/v1",
    plan,
    files: Object.entries(sourceFiles).map(([path, content]) => ({
      path, beforeHash: hash(content), writable: path !== "check.mjs",
    })),
    checks: [
      { id: "add-check", script: "check.mjs", args: ["add"], taskIds: ["add"], acceptanceIds: ["functional"], e2e: false },
      { id: "clamp-check", script: "check.mjs", args: ["clamp"], taskIds: ["clamp"], acceptanceIds: ["functional"], e2e: false },
      { id: "e2e-check", script: "check.mjs", args: ["e2e"], taskIds: [], acceptanceIds: ["functional"], e2e: true },
    ],
  }), { mode: 0o600 });

  const child = await f.launch([
    "--human-review", "terminal",
    "--coding-config", codingConfigPath,
    "--authorized-disposable-coding-source", sourceRoot,
    "--authorized-coding-stage-parent", stageParent,
    "--allow-coding-check", "add-check",
    "--allow-coding-check", "clamp-check",
    "--allow-coding-check", "e2e-check",
  ]);
  const runId = "configured-coding";
  const started = await child.rpc("capability_call", invocation("manager.runtime.start", {
    operationId: randomUUID(), runId, projectId: "isolated-coding",
    contract: plan.contract, budget: plan.budget,
  }));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const read = () => child.rpc("capability_read", invocation("manager.runtime.get", { runId }))
    .then(value => value.body.result);
  const run = await until(read, value => value && value.state !== "active");
  assert.equal(run.state, "succeeded", JSON.stringify(run));
  assert.equal(run.tasks.find(task => task.definition.taskId === "clamp").attempts.length, 2);
  assert(run.checks.some(check => check.kind === "e2e" && check.result.ok));
  assert(calls.some(call => call.taskId === "add" && call.toolMessages === 0));
  assert(calls.some(call => call.taskId === "clamp" && call.capsule.repairReason?.includes("Native coding check failed")));
  assert(calls.every(call => call.tools.every(tool => ["source.list", "source.read"].includes(tool.function.name))));
  for (const [path, content] of Object.entries(sourceFiles))
    assert.equal(await readFile(resolve(sourceRoot, path), "utf8"), content, "only the disposable stage may be patched");
  assert.deepEqual([...attempts.keys()].sort(), ["add", "clamp"]);
  await child.stop();

  const databases = await sqliteFiles(f.workspace);
  assert(databases.length >= 2, `expected separate core and coding-process databases; found ${databases.map(path => relative(f.workspace, path)).join(", ")}`);
  const inspected = databases.map(path => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
      return { path, tables, userVersion: db.prepare("PRAGMA user_version").get().user_version,
        quickCheck: db.prepare("PRAGMA quick_check").get().quick_check };
    } finally { db.close(); }
  });
  assert(inspected.some(item => item.tables.includes("runtime_process_jobs")), JSON.stringify(inspected));
  assert(inspected.every(item => item.quickCheck === "ok"));
  const processDb = inspected.find(item => item.tables.includes("runtime_process_jobs"));
  const coreDb = inspected.find(item => item.tables.includes("coding_worker_effects"));
  assert.notEqual(processDb.path, coreDb.path);
  assert(relative(f.workspace, processDb.path).split(sep)[0] !== "..");
  assert(processDb.userVersion > 0, JSON.stringify(inspected));

  const core = new DatabaseSync(coreDb.path, { readOnly: true });
  let integration;
  try {
    const row = core.prepare("SELECT record FROM coding_worker_effects ORDER BY rowid LIMIT 1").get();
    assert(row, "durable coding journal records the merge effect");
    integration = JSON.parse(row.record);
  } finally { core.close(); }
  const integrationRoot = resolve(stageParent, integration.stage);
  assert.match(await readFile(resolve(integrationRoot, "add.mjs"), "utf8"), /a \+ b/);
  assert.match(await readFile(resolve(integrationRoot, "clamp.mjs"), "utf8"), /Math\.max/);

  const backupPath = resolve(f.root, "isolated-backup");
  const backup = spawnSync(process.execPath, ["dist/cli.js", "backup", "--data", f.workspace, "--destination", backupPath], {
    cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 15_000,
  });
  assert.notEqual(backup.status, 0, `${backup.stdout}\n${backup.stderr}`);
  assert.match(`${backup.stdout}\n${backup.stderr}`, /CODING_BACKUP_UNSUPPORTED/);
  assert.equal(existsSync(backupPath), false, "refusal precedes destination creation; no partial core-only snapshot");
});
