import "./fixtures/original-mcp-native-chat-rpc-source.mjs";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const { originalApiTaskLiveFixture } = await import("./original-mcp-api-chat-task-live-fixture.mjs");
const { OriginalNativeTaskSemanticError } = await import("../dist/original-mcp-api-chat-task-execution-contracts.js");
const { originalMcpNativeChatPayloadSchemas } = await import("../dist/original-mcp-native-chat-rpc.js");
const require = createRequire(import.meta.url);
const built = await require("esbuild").build({
  stdin: { contents: `export { streamVscodeChat } from "./legacy/src/chat/api-chat-vscode";
    export { createOriginalNativeTaskRetainedHooks } from "./clients/vscode-host/original-mcp-native-task-hooks.ts";
    export * as api from "vscode";`, resolveDir: resolve(".") },
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
  plugins: [{ name: "explicit-retained-model-fixture", setup(plugin) {
    plugin.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "task-model-fixture" }));
    plugin.onLoad({ filter: /.*/, namespace: "task-model-fixture" }, () => ({ contents: `
      export class LanguageModelTextPart { constructor(value) { this.value=value; } }
      export class LanguageModelToolCallPart {}
      export class LanguageModelToolResultPart {}
      export class LanguageModelDataPart {}
      export class LanguageModelThinkingPart {}
      export const LanguageModelChatMessage={
        User: content=>({role:1,content}), Assistant: content=>({role:2,content}) };
      export class CancellationTokenSource {
        constructor() {
          const listeners=new Set();
          this.token={isCancellationRequested:false,onCancellationRequested(fn) {
            listeners.add(fn);return {dispose(){listeners.delete(fn)}};}};
          this.cancel=()=>{this.token.isCancellationRequested=true;for(const listener of listeners)listener()};
          this.dispose=()=>{};
        }
      }`, loader: "js" }));
    plugin.onResolve({ filter: /\/src\/original-mcp-api-chat(?:-task-execution)?-contracts\.js$/ }, args => ({
      path: new URL(`../dist/${args.path.split("/").at(-1)}`, import.meta.url).pathname, external: true,
    }));
  } }],
});
const memory = new Module(resolve("tests/.native-task-retained-memory.cjs"));
memory.filename = memory.id; memory.paths = Module._nodeModulePaths(resolve("."));
memory._compile(built.outputFiles[0].text, memory.filename);
const { streamVscodeChat, createOriginalNativeTaskRetainedHooks, api } = memory.exports;

// Actual signed socket/Core + frozen retained loop; model/UI responses are explicit synthetic fixtures.
test("managed Task RPC preserves its variant deadline through two retained native rounds before stale-ending refusal", {
  timeout: 120000,
}, async t => {
  const f = await originalApiTaskLiveFixture(t);
  let nativeCalls = 0, admissions = 0, reason, seenPlan;
  f.run(async (plan, ports, signal) => {
    seenPlan = structuredClone(plan);
    const hooks = createOriginalNativeTaskRetainedHooks(plan, ports.taskContext);
    let round = -1, inferenceId, pending = Promise.resolve();
    const model = { id: "task-api-fixture-wire", maxInputTokens: 16384, capabilities: { toolCalling: true },
      async countTokens() { return 1; },
      async sendRequest() {
        nativeCalls++;
        return { stream: { async *[Symbol.asyncIterator]() {
          yield new api.LanguageModelTextPart("An unfinished response is not Task acceptance.");
        } } };
      } };
    try {
      await streamVscodeChat(model, {
        messages: structuredClone(plan.messages), tools: [], signal,
        maxOutputTokens: plan.outputTokenCap, timeoutMs: plan.budget.deadlineMs,
        maxToolRounds: plan.hardToolRoundLimit, hardToolRoundLimit: plan.hardToolRoundLimit,
        async beforeRound() {
          await pending; round++;
          inferenceId = await f.infer(plan, ports, round, [], []); admissions++;
        },
        async afterRound() {
          await pending;
          hooks.beginRound({ round, inferenceId, hasToolCalls: false, finalSummary: false });
          await hooks.afterRound();
        },
        beforeFinish() {
          try { return hooks.beforeFinish(); }
          catch (error) {
            if (error instanceof OriginalNativeTaskSemanticError) reason = error.reason;
            throw error;
          }
        },
      }, text => { pending = pending.then(() => ports.text({ inferenceId, text })); }, api);
      await pending; await hooks.settled();
      return { status: "complete", toolRoundLimit: null };
    } catch (error) {
      await pending;
      if (!reason) throw error;
      return { status: "failed", toolRoundLimit: null };
    }
  });
  const submitted = await f.call("api_chat_send", { host_id: f.workspaceId, chat_id: f.created.chatId,
    command_id: "managed-rpc-retained-deadline", prompt: "Start a new task: keep the original objective open without evidence.",
    hard_tool_round_limit: 5 });
  const receipt = await f.receipt(submitted.request_id);
  assert.equal(nativeCalls, 2, "A pre-dispatch failure is not a qualified stale-ending refusal.");
  assert.equal(admissions, 2);
  assert.equal(reason, "GOAL_STALE_ENDINGS");
  assert.equal(receipt.status, "outcome_unknown");
  assert(originalMcpNativeChatPayloadSchemas["execution.task.run"].safeParse(seenPlan).success);
  assert(!originalMcpNativeChatPayloadSchemas["execution.run"].safeParse(seenPlan).success,
    "Ordinary execution must not accept managed Task fields to obtain a timeout.");
  const inspected = await f.receipt((await f.call("api_chat_get", {
    host_id: f.workspaceId, chat_id: f.created.chatId,
  })).request_id);
  assert.equal(inspected.result.managedTask.goal.status, "interrupted");
  assert.equal(inspected.result.managedTask.taskCompletion, "not-claimed");
});
