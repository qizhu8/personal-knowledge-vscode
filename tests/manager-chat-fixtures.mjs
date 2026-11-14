import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { ModelConfigService } from "../dist/model-config.js";
import { ModelProviderService } from "../dist/model-provider.js";
import { createManagerChatExactComposition } from "../dist/manager-chat.js";
import { createManagerRuntime, initializeManagerRuntimeSchema } from "../dist/manager-runtime.js";
import { managerPlanDefinitionHash } from "../dist/manager-plan.js";

export const hash = managerPlanDefinitionHash;
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(fn) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const value = fn();
    if (value) return value;
    await sleep(5);
  }
  throw new Error("Manager Chat fixture deadline exceeded");
}
export function managerChatManifest(count = 20) {
  const contract = {
    schema: "pkm.manager.completion/v1", goalId: "text-manifest", revision: 1,
    objective: `Generate exactly ${count} independently scoped UTF-8 text artifacts.`,
    scope: ["deliverables"], nonGoals: ["No filesystem or network tools"],
    acceptance: [{ id: "exact", criterion: "Every artifact equals the admitted exact expected bytes",
      verification: "Native equality of complete path/content manifest", e2e: true }],
    outputs: ["Native persisted text artifact manifest"], invariants: ["No out-of-scope artifacts"],
    stopConditions: ["Any unknown effect or failed exact manifest check"],
  };
  const expected = Object.fromEntries(Array.from({ length: count }, (_, index) =>
    [`deliverables/worker-${index + 1}/result.txt`, `Result ${index + 1}`]));
  const compact = {
    kind: count === 1 ? "serial" : "parallel", rationale: "Disjoint artifacts",
    tasks: [
      ...Array.from({ length: count }, (_, index) => ({
        id: `worker-${index + 1}`, objective: `Generate Result ${index + 1}`, phase: "worker",
        writeScope: [`deliverables/worker-${index + 1}`], acceptanceIds: ["exact"], rationale: "Own artifact",
      })),
      { id: "integrate", objective: "Integrate all artifacts", phase: "integrator",
        dependsOn: Array.from({ length: count }, (_, index) => `worker-${index + 1}`),
        acceptanceIds: ["exact"], rationale: "Whole manifest" },
      { id: "verify", objective: "Verify all artifacts", phase: "verifier", dependsOn: ["integrate"],
        acceptanceIds: ["exact"], rationale: "Native whole manifest" },
      { id: "repair", objective: "Repair exact owner", phase: "repair", dependsOn: ["verify"],
        acceptanceIds: ["exact"], rationale: "Bounded repair" },
    ],
  };
  return { contract, expected, compact };
}
export function managerChatFixture(t, options = {}) {
  const count = options.count ?? 20;
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  transaction(() => initializeManagerRuntimeSchema(db));
  const { contract, expected, compact } = managerChatManifest(count);
  const calls = [];
  let active = 0, peak = 0, workspaceVersion = "v1";
  const profiles = new ModelConfigService({
    configuration: { aiEndpoint: "https://local-memory.invalid/v1", aiModel: "local-memory",
      apiChatModelProfiles: [{ id: "local-memory", status: "active", contextWindow: 131072,
        maxOutputTokens: 8192, includeUsage: true }] },
    secretResolver: { resolveSecret: async () => ({ localOnly: true }) },
    registryAvailability: { "openai-compatible": true },
  });
  const transport = {
    supports: provider => provider === "openai-compatible",
    async open(request) {
      if (db.isTransaction) throw new Error("Inference inside transaction");
      if (request.payload.tools?.length) throw new Error("Unexpected model tool authority");
      const prompt = JSON.parse(request.payload.messages.at(-1).content);
      const data = prompt.request;
      const stage = data.schema === "pkm.manager.chat.capsule/v1" ? "worker"
        : data.contract && data.freeze ? "verifier" : data.freeze ? "integrator" : "planner";
      const call = { stage, request: request.payload, data, repairing: Boolean(prompt.repair) };
      calls.push(call);
      active++; peak = Math.max(peak, active);
      let output;
      try {
        await options.onOpen?.(call, calls);
        await sleep(3);
        if (stage === "planner") output = structuredClone(compact);
        else if (stage === "worker") {
          const path = `${data.task.writeScope[0]}/result.txt`;
          output = { schema: "pkm.manager.chat.delivery/v1", taskId: data.task.taskId,
            artifacts: [{ path, content: expected[path] }] };
        } else if (stage === "integrator") output = {
          schema: "pkm.manager.chat.integration/v1", freeze: data.freeze, paths: data.artifacts.map(item => item.path),
        };
        else output = { schema: "pkm.manager.chat.verification/v1", freeze: data.freeze,
          integration: data.integration, acceptanceIds: data.contract.acceptance.map(item => item.id) };
        output = options.output ? options.output(output, call, calls) : output;
      } finally { active--; }
      const text = typeof output === "string" ? output : JSON.stringify(output);
      const tool = options.toolRequest && stage === "worker";
      const delta = tool ? { tool_calls: [{ index: 0, id: "untrusted-tool", type: "function",
        function: { name: "create_document", arguments: '{"content":"must not execute"}' } }] } : { content: text };
      const sse = `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\n`
        + 'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":100}}\n\ndata: [DONE]\n\n';
      const bytes = new TextEncoder().encode(sse);
      return new ReadableStream({ start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 97) controller.enqueue(bytes.slice(offset, offset + 97));
        controller.close();
      } });
    },
  };
  const provider = new ModelProviderService({ modelConfig: profiles, transport });
  const owner = { actorId: "local-manager", nativeOwnerId: "native-text-owner" }, token = {};
  const composition = createManagerChatExactComposition({
    db, transaction, provider, workspaceId: "local-text-workspace", workspaceVersion: () => workspaceVersion,
    contract, expected, resolveOwner: value => value === token ? owner : undefined,
    bounds: { maxConcurrentTurns: 4, deadlineMs: 10000, ...options.bounds },
    ...options.composition,
  });
  const runtime = createManagerRuntime(db, { host: composition.host, leaseMs: 15000 });
  const budget = { maxWorkers: count, maxConcurrentWorkers: 4 > count ? count : 4,
    maxTasks: count + 3, maxAttemptsPerTask: 2 };
  const start = runId => runtime.start(token, { operationId: randomUUID(), runId, projectId: "text-project", contract, budget });
  t.after(async () => { await runtime.close(); await composition.close(); db.close(); });
  return { db, transaction, provider, contract, expected, compact, owner, token, composition, runtime, start, calls,
    peak: () => peak, version: value => { workspaceVersion = value; },
    terminal: runId => until(() => {
      const run = runtime.get(token, { runId });
      return run.state !== "active" && run;
    }),
  };
}
