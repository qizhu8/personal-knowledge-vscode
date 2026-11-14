import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ModelConfigService } from "../dist/model-config.js";
import { ModelProviderService } from "../dist/model-provider.js";
import { createCodingWorkerWorkspace, createCodingWorkerManagerHost, codingWorkerHash } from "../dist/coding-worker.js";
import { validateManagerPlan } from "../dist/manager-plan.js";
import { createManagerRuntime, initializeManagerRuntimeSchema } from "../dist/manager-runtime.js";

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(fn) {
  for (let i = 0; i < 1000; i++) { const value = fn(); if (value) return value; await sleep(5); }
  throw new Error("Coding fixture deadline.");
}
export const addSource = "export function add(a, b) { return a - b; }\n";
export const clampSource = "export function clamp(n) { return n; }\n";
const checkSource = `
import assert from "node:assert/strict";
import { add } from "./add.mjs";
import { clamp } from "./clamp.mjs";
let ok = true;
try {
  const mode = process.argv[2];
  for (let a = -9; a <= 11; a++) for (let b = -7; b <= 13; b++) {
    if (mode === "add" || mode === "e2e") assert.equal(add(a,b), a+b);
    if (mode === "clamp" || mode === "e2e") assert.equal(clamp(a+b), Math.max(0,Math.min(10,a+b)));
    if (mode === "e2e") assert.equal(clamp(add(a,b)), Math.max(0,Math.min(10,a+b)));
  }
} catch { ok = false; }
console.log(JSON.stringify({ok, privateDiagnostic:"redact-this-native-diagnostic"}));
`;
export function codingPlan() {
  const contract = {
    schema: "pkm.manager.completion/v1", goalId: "code-functions", revision: 1,
    objective: "Repair addition and bounded clamp functions, and validate their composition on real source files.",
    scope: ["add.mjs", "clamp.mjs"], nonGoals: ["No production writes, shell tools, or network"],
    acceptance: [{ id: "functional", criterion: "Addition and clamp are correct on representative numeric inputs.",
      verification: "Pinned native Node assertions against actual module imports.", e2e: true }],
    outputs: ["add.mjs", "clamp.mjs"], invariants: ["Only owned source may change", "Native checks remain immutable"],
    stopConditions: ["Unknown effects or conflicts require escalation"],
  };
  const task = (taskId, phase, dependsOn, readScope, writeScope) => ({
    taskId, title: taskId, objective: taskId === "add" ? "Fix arithmetic addition." : taskId === "clamp"
      ? "Clamp numbers to the closed interval 0..10." : `${phase} whole source.`,
    phase, dependsOn, readScope, writeScope, resources: [], acceptanceIds: ["functional"],
    verification: "Host-pinned native functional check.", independence: { traceId: taskId, rationale: "Own isolated source stage." },
    trigger: phase === "repair" ? "verification-failed" : "always",
  });
  const budget = { maxWorkers: 2, maxConcurrentWorkers: 2, maxTasks: 5, maxAttemptsPerTask: 2 };
  const plan = {
    schema: "pkm.manager.plan/v1", planId: "coding-plan", revision: 1, contract, budget,
    assessment: { kind: "parallel", rationale: "Independent source modules.", independentTaskCount: 2 },
    tasks: [
      task("add", "worker", [], ["add.mjs"], ["add.mjs"]),
      task("clamp", "worker", [], ["clamp.mjs"], ["clamp.mjs"]),
      task("integrate", "integrator", ["add", "clamp"], ["add.mjs", "clamp.mjs"], []),
      task("verify", "verifier", ["integrate"], ["add.mjs", "clamp.mjs"], []),
      task("repair", "repair", ["verify"], ["add.mjs", "clamp.mjs"], []),
    ],
  };
  const result = validateManagerPlan(plan);
  assert.equal(result.status, "ready", JSON.stringify(result));
  return { contract, budget, plan, result };
}
export function codingFixture(t, overrides = {}) {
  const root = resolve("tests", `.coding-worker-${randomUUID()}`);
  const sourceRoot = resolve(root, "source"), stageParent = resolve(root, "stages");
  mkdirSync(sourceRoot, { recursive: true }); mkdirSync(stageParent);
  const source = { "add.mjs": addSource, "clamp.mjs": clampSource, "check.mjs": checkSource, ...overrides.source };
  for (const [path, text] of Object.entries(source)) writeFileSync(resolve(sourceRoot, path), text);
  const db = new DatabaseSync(resolve(root, "coding.sqlite"));
  const processDatabase = new DatabaseSync(resolve(root, "coding-process.sqlite"));
  const transaction = fn => {
    db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  transaction(() => initializeManagerRuntimeSchema(db));
  const owner = { actorId: "coding-owner", nativeOwnerId: "coding-native" }, token = {};
  const workspaceId = `coding-${randomUUID()}`;
  const receipts = [], calls = [], approvals = [];
  const workspaceOptions = {
    db, processDatabase, transaction, workspaceId, owner, sourceRoot, stageParent, authorizedDisposable: true,
    files: Object.entries(source).map(([path, text]) => ({ path, beforeHash: codingWorkerHash(text), writable: path !== "check.mjs" })),
    checks: [
      { id: "add-check", script: "check.mjs", args: ["add"], taskIds: ["add"], acceptanceIds: ["functional"], e2e: false },
      { id: "clamp-check", script: "check.mjs", args: ["clamp"], taskIds: ["clamp"], acceptanceIds: ["functional"], e2e: false },
      { id: "e2e-check", script: "check.mjs", args: ["e2e"], taskIds: [], acceptanceIds: ["functional"], e2e: true },
    ],
    authorizeSource: files => !JSON.stringify(files).includes("credential-fixture"),
    authorizeCheck: input => { approvals.push(input); return input.owner.actorId === owner.actorId; },
    redactOutput: output => ({ ok: output.ok }),
    receipt: value => receipts.push(value),
    ...overrides.workspace,
  };
  const workspace = createCodingWorkerWorkspace(workspaceOptions);
  const modelConfig = new ModelConfigService({
    configuration: { aiEndpoint: "http://localhost:1/v1", aiModel: "coding-local",
      apiChatModelProfiles: [{ id: "coding-local", status: "active", contextWindow: 131072, maxOutputTokens: 8192, includeUsage: true }] },
    secretResolver: { resolveSecret: async () => ({ fixtureOnly: true }) },
    registryAvailability: { "openai-compatible": true },
  });
  let active = 0, peak = 0;
  const attempts = new Map();
  const provider = new ModelProviderService({
    modelConfig,
    transport: {
      supports: name => name === "openai-compatible",
      async open(request) {
        assert.equal(db.isTransaction, false);
        const capsule = JSON.parse(request.payload.messages.find(message => message.role === "user").content);
        const call = { capsule, request: request.payload };
        calls.push(call); active++; peak = Math.max(peak, active);
        await overrides.onModel?.(call);
        await sleep(8);
        active--;
        const taskId = capsule.task.taskId, path = capsule.task.writeScope[0];
        const toolMessages = request.payload.messages.filter(message => message.role === "tool");
        let delta, reason;
        if (toolMessages.length === 0) {
          delta = { tool_calls: [{ index: 0, id: "list-source", type: "function", function: { name: "source.list", arguments: "{}" } }] };
          reason = "tool_calls";
        } else if (toolMessages.length === 1) {
          delta = { tool_calls: [{ index: 0, id: "read-source", type: "function", function: { name: "source.read", arguments: JSON.stringify({ path }) } }] };
          reason = "tool_calls";
        } else {
          const read = JSON.parse(toolMessages.at(-1).content);
          assert.equal(read.path, path);
          assert.equal(read.hash, codingWorkerHash(read.content));
          const count = (attempts.get(taskId) ?? 0) + 1; attempts.set(taskId, count);
          let after = taskId === "add" ? read.content.replace("a - b", "a + b")
            : read.content.replace("return n;", "return Math.max(0, Math.min(10, n));");
          if (overrides.badFirst && taskId === "clamp" && count === 1) after = read.content.replace("return n;", "return Math.min(10, n);");
          let proposal = { schema: "pkm.coding.proposal/v1", taskId,
            patches: [{ path, beforeHash: read.hash, edits: [{ before: read.content, after }] }] };
          proposal = overrides.proposal?.(proposal, call) ?? proposal;
          delta = { content: JSON.stringify(proposal) }; reason = "stop";
        }
        if (overrides.delta) ({ delta, reason } = overrides.delta({ delta, reason }, call));
        const wire = `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
          + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`
          + 'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":100}}\n\ndata: [DONE]\n\n';
        const bytes = new TextEncoder().encode(wire);
        return new ReadableStream({ start(controller) {
          for (let index = 0; index < bytes.length; index += 73) controller.enqueue(bytes.slice(index, index + 73));
          controller.close();
        } });
      },
    },
  });
  const definition = codingPlan();
  const composition = createCodingWorkerManagerHost({
    workspace, provider, transaction, resolveOwner: value => value === token ? owner : undefined,
    plan: async () => definition.result,
    authorizeTask: value => value.actorId === owner.actorId,
    bounds: { deadlineMs: 10000, ...overrides.bounds },
    ...overrides.composition,
  });
  const runtime = createManagerRuntime(db, { host: composition.host, leaseMs: 15000 });
  t.after(async () => {
    await runtime.close(); await composition.native.close(); processDatabase.close(); db.close(); rmSync(root, { recursive: true, force: true });
  });
  const signal = new AbortController().signal;
  const task = id => definition.plan.tasks.find(task => task.taskId === id);
  const workerInput = (taskId, extra = {}) => ({
    owner, runId: "direct-run", task: task(taskId), attemptId: `attempt-${randomUUID()}`,
    effectId: `effect-${randomUUID()}`, feedback: [], publish() {}, ...extra,
  });
  const admit = async (runId = "direct-run") => composition.host.plan({
    owner, runId, effectId: randomUUID(), contract: definition.contract, budget: definition.budget,
  }, signal);
  const validate = (input, delivery) => composition.host.validate({
    owner, runId: input.runId, task: input.task, attemptId: input.attemptId, delivery, effectId: randomUUID(),
  }, signal);
  const integratedRoot = () => {
    const row = JSON.parse(db.prepare("SELECT record FROM coding_worker_effects WHERE workspace_id=? ORDER BY rowid LIMIT 1").get(workspaceId).record);
    return resolve(stageParent, row.stage);
  };
  const stageRoot = delivery => {
    const row = JSON.parse(db.prepare("SELECT record FROM coding_worker_records WHERE workspace_id=? AND kind='delivery' AND key=?")
      .get(workspaceId, delivery.pin).record);
    return resolve(stageParent, row.stageId);
  };
  return { root, sourceRoot, stageParent, db, processDatabase, transaction, owner, token, workspaceId, workspace, workspaceOptions, composition,
    provider, runtime, receipts, calls, approvals, peak: () => peak, signal, ...definition, task, workerInput, admit, validate, integratedRoot, stageRoot,
    start(runId = "code-run") { return runtime.start(token, { operationId: randomUUID(), runId, projectId: "code-fixture", contract: definition.contract, budget: definition.budget }); },
    terminal(runId = "code-run") { return until(() => { const run = runtime.get(token, { runId }); return run.state !== "active" && run; }); },
    assertOriginals() { for (const [path, text] of Object.entries(source)) assert.equal(readFileSync(resolve(sourceRoot, path), "utf8"), text); },
  };
}
