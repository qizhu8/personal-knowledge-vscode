import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { originalNativeChatDigest } from "../../dist/original-mcp-api-chat-contracts.js";

const require = createRequire(import.meta.url), { build } = require("esbuild");
const allow = "Allow this native model request", adopt = "Adopt this exact goal and reset acceptance";
async function fixture(t) {
  const directory = resolve(".pkm-test-evidence", `native-adoption-producer-${randomUUID()}`);
  await mkdir(join(directory, "next-runtime/server/dist"), { recursive: true, mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "package.json"), '{"type":"commonjs"}');
  await writeFile(join(directory, "next-runtime/server/dist/original-mcp-native-chat-rpc.js"),
    "exports.createOriginalMcpNativeChatProducerChannel = options => options;");
  await build({ entryPoints: [resolve("src/managed-chat-task-adoption-contracts.ts")],
    outfile: join(directory, "next-runtime/server/dist/managed-chat-task-adoption-contracts.js"),
    bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
  let revision = 0, executions = 0;
  const epoch = randomUUID(), questions = [], choices = [], controller = new AbortController();
  const metadata = { id: "vscode:fixture:model", nativeModelId: "fixture-model", label: "Fixture model",
    vendor: "fixture", family: "fixture", version: "1", maxInputTokens: 200000, maxOutputTokens: 8192 };
  const producer = { models: {
    async catalogue() { return { source: "vscode.lm", epoch, registryRevision: String(revision), models: [metadata] }; },
  }, execution: { async run() { executions++; throw new Error("No adoption review may invoke inference."); } } };
  const bundled = await build({ entryPoints: [resolve("clients/vscode-host/original-mcp-native-chat-session.ts")],
    bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false, metafile: true, logLevel: "silent",
    plugins: [{ name: "fixture-only-native-producer", setup(plugin) {
      plugin.onResolve({ filter: /\/?original-mcp-native-chat\.js$/ }, () => ({ path: "fixture-native-producer", external: true }));
    } }],
  });
  assert(Object.keys(bundled.metafile.inputs).every(path => !/managed-chat-task-(?:original|adoption-contracts)\.ts$/.test(path)),
    "The host bundle must not pull the Core Goal evaluator through adoption DTOs.");
  const load = Module._load; let api;
  try {
    Module._load = function (id, ...args) {
      if (id === "vscode") return { window: { async showWarningMessage(title, options, ...buttons) {
        questions.push({ title, options, buttons }); return choices.shift();
      } } };
      if (id === "fixture-native-producer") return { createOriginalMcpNativeChatProducer: async () => producer };
      return load.call(this, id, ...args);
    };
    const compiled = new Module(join(directory, "adoption.cjs"));
    compiled.filename = join(directory, "adoption.cjs"); compiled.paths = Module._nodeModulePaths(directory);
    compiled._compile(bundled.outputFiles[0].text, compiled.filename); api = compiled.exports;
  } finally { Module._load = load; }
  choices.push(allow);
  const channel = await api.enableOriginalMcpNativeChatSession({ extensionPath: directory, subscriptions: [] }, {
    session: { epoch, activationId: epoch, binding: { root: "/isolated-fixture/library", workspaceId: randomUUID(), profileSha256: "a".repeat(64) } },
    signal: controller.signal, assertCurrent() {}, async send() {}, async close() {},
  });
  const requestId = "c".repeat(64), chatId = randomUUID(), chatUrl = `pkm://chats/0123456789abcdef/${chatId}`;
  const resolveRequest = { requestId, requestedModelId: metadata.id, chatUrl, sourcePlanSha256: "b".repeat(64), expectedSelection: null };
  choices.push(allow);
  const selection = await channel.apiChat.resolve(resolveRequest, controller.signal);
  const originalInput = randomUUID();
  const request = { schema: "pkm.chat.original-task-adoption-review/v1", requestId, commandId: "adopt-original",
    chatUrl, sourcePlanSha256: "b".repeat(64), sourceSha256: "d".repeat(64),
    original: { schema: "pkm.chat.original-task-adoption-source/v1", chatId, namespace: "0123456789abcdef",
      taskId: `agent_session_${randomUUID().replaceAll("-", "")}`, chatTitle: "Original Chat", taskTitle: "Original Task", sessionStatus: "paused",
      metadataSha256: "1".repeat(64), sessionSha256: "2".repeat(64), historySha256: "3".repeat(64), sourceInputIds: [originalInput],
      goal: { id: randomUUID(), inputId: originalInput, attemptInputId: originalInput,
        objective: "Start a new task: preserve actual original identity.", executionDigest: "4".repeat(64), status: "resolved",
        acceptance: [{ criterion: "The original user objective and all subsequent requirements are satisfied.",
          verified: true, evidenceCallIds: ["historical-only"] }] } },
    selection, prompt: "Continue the same exact original objective.", argumentsSha256: "5".repeat(64),
    previousExecutionDigest: "4".repeat(64), nextExecutionDigest: "6".repeat(64),
    resetCurrentAcceptance: true, importOldPermissions: false, historicalEvidenceOnly: true, taskCompletion: "not-claimed" };
  return { channel, choices, questions, controller, request, executions: () => executions, invalidate() { revision++; } };
}
test("native producer requires the distinct adoption button and still needs independent exact send consent", async t => {
  // Real producer and native-ledger logic; labelled UI/LM doubles are not installed/Core qualification.
  const f = await fixture(t);
  f.choices.push(adopt);
  const decision = await f.channel.apiChat.adopt(f.request, f.controller.signal);
  assert.equal(decision.decision, "adopt-and-revalidate");
  assert.equal(decision.bindingSha256, originalNativeChatDigest(f.request));
  assert.equal(decision.requestId, f.request.requestId);
  assert.deepEqual(f.questions.at(-1).buttons, [adopt, "Deny"]);
  const shown = JSON.parse(f.questions.at(-1).options.detail);
  assert.deepEqual(shown.original, f.request.original);
  assert.equal(shown.importOldPermissions, false); assert.equal(shown.resetCurrentAcceptance, true);
  const send = { operation: "send", requestId: f.request.requestId, commandId: f.request.commandId,
    chatUrl: f.request.chatUrl, sourcePlanSha256: f.request.sourcePlanSha256, sourceUncertain: false,
    argumentsSha256: f.request.argumentsSha256, selection: f.request.selection };
  await assert.rejects(f.channel.apiChat.authorize({ ...send, argumentsSha256: "f".repeat(64) }, f.controller.signal), /BINDING/);
  f.choices.push("Deny");
  await assert.rejects(f.channel.apiChat.authorize(send, f.controller.signal), /denied/);
  assert.equal(f.executions(), 0);
});
test("native producer denial cannot be promoted by generic allow text or a copied source/selection binding", async t => {
  const f = await fixture(t);
  await assert.rejects(f.channel.apiChat.adopt({ ...f.request, selection: { ...f.request.selection, outputTokenCap: 1 } }, f.controller.signal), /ADOPTION_BINDING/);
  f.choices.push(allow);
  const denied = await f.channel.apiChat.adopt(f.request, f.controller.signal);
  assert.equal(denied.decision, "deny", "Only the distinct adopt-and-reset native choice can approve.");
  assert.equal(f.executions(), 0);
  await assert.rejects(f.channel.apiChat.adopt(f.request, f.controller.signal), /ADOPTION_BINDING/);
});
test("late adoption clicks after cancellation or registry changes never grant a current decision", async t => {
  const cancelled = await fixture(t);
  let click;
  cancelled.choices.push(new Promise(resolve => { click = resolve; }));
  const pending = cancelled.channel.apiChat.adopt(cancelled.request, cancelled.controller.signal);
  while (!cancelled.questions.some(question => question.title.startsWith("Adopt this exact"))) await new Promise(resolve => setImmediate(resolve));
  cancelled.controller.abort(); click(adopt);
  await assert.rejects(pending, /CANCELLED/);
  const stale = await fixture(t); let staleClick;
  stale.choices.push(new Promise(resolve => { staleClick = resolve; }));
  const review = stale.channel.apiChat.adopt(stale.request, stale.controller.signal);
  while (!stale.questions.some(question => question.title.startsWith("Adopt this exact"))) await new Promise(resolve => setImmediate(resolve));
  stale.invalidate(); staleClick(adopt);
  await assert.rejects(review, /STALE_MODEL/);
  assert.equal(stale.executions(), 0); assert.equal(cancelled.executions(), 0);
});
