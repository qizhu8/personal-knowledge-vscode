import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import fixture from "./model-provider-original-fixtures.mjs";
import { ModelConfigService } from "../dist/model-config.js";
import { ModelProviderService } from "../dist/model-provider.js";
import { normalizeModelUsage } from "../dist/domain/model-provider.js";
import { checkNativeRecords, packageRoot, readOriginalSource } from "../scripts/migration.mjs";

const declaration = name => fixture.declarations.find(entry => entry.name === name).text;
function compile(source, globals = {}) {
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, Buffer, URL, AbortController, setTimeout, clearTimeout, ...globals }, { timeout: 1000 });
  return exports;
}
const originalModels = compile(declaration("model-functions"));
const clone = value => JSON.parse(JSON.stringify(value));
const enc = new TextEncoder();
const config = new ModelConfigService({
  configuration: { aiEndpoint: "https://example.test/v1", aiModel: "test-model", apiChatModelProfiles: [
    { id: "test-model", status: "active", contextWindow: 8192, maxOutputTokens: 256, includeUsage: true },
  ] },
  secretResolver: { resolveSecret: async () => ({}) }, registryAvailability: { "openai-compatible": true, "azure-openai": true },
});
const base = () => ({ provider: "openai-compatible", endpoint: "https://example.test/v1", apiKey: "synthetic-only",
  model: "test-model", messages: [{ role: "user", content: "Hello" }], signal: new AbortController().signal });
function originalStream(chunks) {
  const observed = { payload: undefined, options: undefined, tools: [], text: "", usage: [], summaries: [] };
  class OpenAI {
    constructor(options) {
      observed.options = options;
      this.chat = { completions: { create: async payload => {
        observed.payload = clone(payload);
        return (async function* () { for (const chunk of chunks) yield clone(chunk); })();
      } } };
    }
  }
  const original = compile(declaration("streamApiChat"), {
    OpenAI,
    ChatToolLoopGuard: class { summarizing = false; async beforeRound() {} },
    ChatInferenceClock: class { activity() {} start() {} publicOutput() {} finish() {} },
    ChatBudgetExceededError: originalModels.ChatBudgetExceededError,
    checkReportedOutput: originalModels.checkReportedOutput,
    reportedReasoningTokens: originalModels.reportedReasoningTokens,
    reportedCopilotUsage: originalModels.reportedCopilotUsage,
    chatInferenceOutputByteLimit: 100_000,
    chatTransportReceipt: () => ({}),
    executeChatToolBatch: async calls => { observed.tools.push(...clone(calls)); },
  });
  return { observed, run: extra => original.streamApiChat({
    ...base(), maxOutputTokens: 256, includeUsage: true, afterTools: () => true,
    onUsage: value => observed.usage.push(clone(value)),
    onReasoningSummary: text => observed.summaries.push(text), ...extra,
  }, text => { observed.text += text; }) };
}
async function migrated(chunks, extra = {}) {
  let payload;
  const service = new ModelProviderService({ modelConfig: config, transport: {
    supports: () => true,
    async open(input) {
      payload = clone(input.payload);
      return new ReadableStream({ start(c) {
        for (const chunk of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n")); c.close();
      } });
    },
  } });
  const events = [];
  for await (const event of service.stream({ messages: base().messages, signal: new AbortController().signal, ...extra })) events.push(event);
  return { payload, events };
}
test("exact source and target hashes match real files under proper roots", async () => {
  const root = new URL("../", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("migration/model-provider-provenance.json", root), "utf8"));
  const hash = value => createHash("sha256").update(value).digest("hex");
  for (const entry of manifest.sourceFiles) assert.equal(hash(await readOriginalSource(entry.path, {
    sha256: entry.sha256, dataset: "runtime-model-provider-historical",
  })), entry.sha256, entry.path);
  assert.deepEqual(await checkNativeRecords(manifest.capturedFiles.map(entry => ({
    file: entry.path, sha256: entry.sha256,
  }))), []);
  for (const entry of fixture.declarations) {
    assert.equal(hash(entry.text), entry.sha256);
    const record = manifest.sourceFiles.find(record => record.path === entry.source);
    assert.ok(record, `Missing original source pin: ${entry.source}`);
    const source = (await readOriginalSource(entry.source, {
      sha256: record.sha256, dataset: "runtime-model-provider-historical",
    })).toString("utf8");
    assert.ok(source.includes(entry.text), `${entry.source}#${entry.name}`);
    assert.equal(source.split("\n").slice(entry.startLine - 1, entry.endLine).join("\n") + (entry.text.endsWith("\n") ? "\n" : ""), entry.text);
  }
  assert.equal(fileURLToPath(root), `${packageRoot}/`);
});

test("captured original fragmentation fixture values stay exact", () => {
  const helpers = compile(declaration("delta-and-done-fixtures") + "\nexport { delta, done };");
  assert.equal(helpers.delta("hello "), 'data: {"choices":[{"delta":{"content":"hello "},"finish_reason":null}]}\n\n');
  assert.ok(helpers.done.endsWith("data: [DONE]\n\n"));
  assert.match(declaration("http-fragmentation-and-usage-fixtures"), /response\.slice\(0, 17\), response\.slice\(17, 43\), response\.slice\(43\)/);
});

test("execute original provider function and compare request/messages/usage/public stream normalization", async () => {
  const chunks = [
    { choices: [{ delta: { reasoning_summary: "Check the inputs.", reasoning_content: "private internal text" }, finish_reason: null }] },
    { choices: [{ delta: { content: "hello " }, finish_reason: null }] },
    { choices: [{ delta: { content: "world" }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 8 },
      completion_tokens_details: { reasoning_tokens: 3 }, copilot_usage: { total_nano_aiu: 2000000001 } } },
  ];
  const original = originalStream(chunks);
  await original.run();
  const next = await migrated(chunks);
  assert.deepEqual(next.payload, original.observed.payload);
  assert.equal(original.observed.options.maxRetries, 0);
  assert.equal(next.events.filter(e => e.type === "text").map(e => e.text).join(""), original.observed.text);
  assert.deepEqual(next.events.filter(e => e.type === "reasoning-summary").map(e => e.text), original.observed.summaries);
  assert.deepEqual(next.events.filter(e => e.type === "usage").map(({ type: _type, ...usage }) => usage), original.observed.usage);
});

test("execute original tool fragmentation and compare complete proposals without executing tools", async () => {
  const tools = [{ name: "lookup", description: "Synthetic only", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }];
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-", type: "function", function: { name: "look", arguments: '{"query":' } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "1", function: { name: "up", arguments: '"synthetic"}' } }] }, finish_reason: "tool_calls" }] },
  ];
  const original = originalStream(chunks);
  await original.run({ tools });
  const next = await migrated(chunks, { tools });
  assert.deepEqual(next.payload, original.observed.payload);
  assert.deepEqual(next.events.filter(e => e.type === "tool").map(e => ({
    id: e.id, type: "function", function: { name: e.name, arguments: JSON.stringify(e.arguments) },
  })), original.observed.tools);
});

test("original output/hidden-reasoning budget and exact usage edge semantics", () => {
  for (const raw of [
    { prompt_tokens: 100, completion_tokens: 20 },
    { prompt_tokens: 100, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 3 }, copilot_usage: { total_nano_aiu: 5 } },
    { prompt_tokens: 100, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 999 } },
  ]) {
    const original = { inputTokens: raw.prompt_tokens, outputTokens: raw.completion_tokens,
      ...clone(originalModels.reportedReasoningTokens(raw)), ...clone(originalModels.reportedCopilotUsage(raw)) };
    assert.deepEqual(normalizeModelUsage(raw), original);
  }
  assert.throws(() => originalModels.checkReportedOutput({ inputTokens: 1, outputTokens: 1059, reasoningTokens: 840 }, 900));
  assert.doesNotThrow(() => originalModels.checkReportedOutput({ inputTokens: 1, outputTokens: 900 }, 900));
});
