const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const Module = require("node:module");
const fixtures = require("./fixtures/chat-context");

const originalLoad = Module._load;
const host = {
  workspace: { isTrusted: true, workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  lm: { tools: [] },
};
let ApiChatView;
try {
  Module._load = function(name, ...args) {
    return name === "vscode" ? host : originalLoad.call(this, name, ...args);
  };
  ({ ApiChatView } = require("../dist/chat/api-chat-view"));
} finally {
  Module._load = originalLoad;
}
const { ApiChatStore } = require("../dist/chat/api-chat-store");
const { captureExecutionContext } = require("../dist/chat/execution-context");
const { chatMemorySegments, retrieveChatMemory } = require("../dist/chat/chat-memory");
const { chatRetrievalReceipt } = require("../dist/chat/chat-retrieval");
const { estimateInputTokens, validateBudget } = require("../dist/chat/api-chat-models");
const { fitChatContext } = require("../dist/chat/chat-context");

const profile = {
  id: "synthetic-context-model", model: "synthetic-context-model", label: "Synthetic context model",
  status: "active", contextWindow: 262144, maxOutputTokens: 4096,
  currency: "USD", includeUsage: false, outputTokenParameter: "max_tokens",
};

function requestMessages(chat, query) {
  return ApiChatView.prototype.requestMessages.call({
    store: { namespace: fixtures.namespace }, toolGroups: () => [{ tools: [] }],
  }, chat, query);
}

function text(messages) {
  return messages.map(item => item.content).join("\n");
}

test("CTX-U01: the synthetic original tool history exceeds 100,000 characters", () => {
  const chat = fixtures.largeToolHistory();
  const originalHistory = chat.messages.slice(-20).map(item =>
    item.content + JSON.stringify(item.toolCalls || [])).join("\n");
  assert(originalHistory.length > 100000);
  assert(chat.messages.length > 20);
  assert.equal(chat.messages.at(-1).toolCalls.length, 17);
  assert(originalHistory.includes(fixtures.evidence.beta));
});

test("CTX-U02: input plus reserved output is accepted exactly at the budget boundary", () => {
  const messages = [{ role: "user", content: "x".repeat(500) }];
  const input = estimateInputTokens(messages);
  assert.equal(validateBudget(profile, input + 128, 128, messages), input);
  assert.throws(() => validateBudget(profile, input + 127, 128, messages), /budget exceeded/);
});

test("CTX-U03: Chinese, tool arguments and tool schemas contribute to the input budget", () => {
  const plain = [{ role: "user", content: "ab" }];
  const chinese = [{ role: "user", content: "\u4f60\u597d" }];
  assert.equal(estimateInputTokens(chinese) - estimateInputTokens(plain), 4);
  const calls = [{ role: "assistant", content: "", tool_calls: [
    { id: "one", type: "function", function: { name: "inspect", arguments: JSON.stringify({ value: "x".repeat(500) }) } },
  ] }];
  assert(estimateInputTokens(calls) > estimateInputTokens([{ role: "assistant", content: "" }]) + 500);
  const schema = { role: "system", content: JSON.stringify({ name: "inspect", parameters: { type: "object" } }) };
  const input = estimateInputTokens([...plain, schema]);
  assert.throws(() => validateBudget(profile, input + 127, 128, [...plain, schema]), /budget exceeded/);
});

test("CTX-U04: different questions retrieve different older evidence subsets", () => {
  const chat = fixtures.olderEvidence();
  const alpha = retrieveChatMemory(chat, "alpha");
  const beta = retrieveChatMemory(chat, "beta");
  assert(alpha.length > 0 && beta.length > 0);
  assert(alpha.every(segment => segment.content === fixtures.evidence.alpha));
  assert(beta.every(segment => segment.content === fixtures.evidence.beta));
});

test("CTX-U05: explicit history exclusion prevents automatic history retrieval", () => {
  const chat = { ...fixtures.olderEvidence(), includeHistory: false };
  assert.deepEqual(retrieveChatMemory(chat, "docker-beta"), []);
  assert(!text(requestMessages(chat, "new question")).includes(fixtures.evidence.beta));
});

test("CTX-U06: explicit context and current input are preserved without rewriting", () => {
  const content = "Pinned evidence: NOT approved; QPS=1250, concurrency=32, version=v2.";
  const query = "Do not execute anything. Explain the evidence.";
  const chat = fixtures.conversation({ context: [{ id: "pinned", label: "Explicit reference", content }] });
  const before = JSON.stringify(chat);
  const messages = requestMessages(chat, query);
  assert(text(messages).includes(content));
  assert.equal(messages.at(-1).content, query);
  assert.equal(JSON.stringify(chat), before);
});

test("CTX-U07: constructing context does not modify original tool evidence", () => {
  const chat = fixtures.largeToolHistory();
  const before = JSON.stringify(chat);
  requestMessages(chat, "docker-beta QPS");
  chatMemorySegments(chat);
  retrieveChatMemory(chat, "docker-beta");
  chatRetrievalReceipt(chat, "docker-beta", profile.id);
  assert.equal(JSON.stringify(chat), before);
});

test("CTX-U08: optional context fits exactly, drops one byte over, and never changes required input", () => {
  const required = { role: "user", content: "required question" };
  const optional = { role: "system", content: "exact original evidence" };
  const schema = [{ role: "system", content: '{"tools":[]}' }];
  const automatic = new Map([[optional, { ids: ["evidence"], priority: 1 }]]);
  const budget = estimateInputTokens([required, optional, ...schema]);
  const exact = [optional, required];
  assert.deepEqual([...fitChatContext(exact, automatic, budget, schema)], ["evidence"]);
  assert.deepEqual(exact, [optional, required]);
  const over = [optional, required];
  assert.deepEqual([...fitChatContext(over, automatic, budget - 1, schema)], []);
  assert.deepEqual(over, [required]);
  assert.equal(optional.content, "exact original evidence");
  assert.throws(() => fitChatContext([required], automatic, 1, schema), /required input/);
});

test("CTX-U09: budgeting preserves live tool call/result pairing and removes only historical references", () => {
  const evidence = { role: "system", content: "old optional evidence".repeat(100) };
  const call = { role: "assistant", content: "", tool_calls: [
    { id: "live", type: "function", function: { name: "read_file", arguments: "{}" } },
  ] };
  const outcome = { role: "tool", content: "NOT_SAVED: disk full", tool_call_id: "live" };
  const messages = [evidence, call, outcome];
  const selected = fitChatContext(messages, new Map([[evidence, { ids: ["old"], priority: 1 }]]), estimateInputTokens([call, outcome]));
  assert.equal(selected.size, 0);
  assert.deepEqual(messages, [call, outcome]);
});

test("CTX-U10: tool chunks retain reproducible ranges, status and content-sensitive identities", () => {
  const source = fixtures.failedToolHistory();
  const segments = chatMemorySegments(source).filter(segment => segment.sourceKind === "tool");
  assert(segments.some(segment => /status=failed/.test(segment.content) && segment.content.includes("NOT_SAVED")));
  assert(segments.some(segment => /status=complete/.test(segment.content) && segment.content.includes(fixtures.evidence.beta)));
  for (const segment of segments) {
    assert(segment.sourceRevision.length === 64);
    assert(segment.end > segment.start);
  }
  const changed = structuredClone(source);
  changed.messages[0].toolCalls[0].status = "failed";
  assert.notEqual(chatMemorySegments(changed)[0].id, segments[0].id);
});

test("CTX-R01: recent tool evidence remains retrievable instead of being excluded by position", () => {
  const chat = fixtures.largeToolHistory();
  const selected = retrieveChatMemory(chat, "docker-beta QPS");
  assert(selected.some(segment => segment.content.includes(fixtures.evidence.beta)),
    "Recent evidence must be eligible for retrieval once full tool history is no longer replayed");
});

for (const status of ["failed", "cancelled", "interrupted"]) {
  test(`CTX-R02/${status}: completed tool evidence survives failure of its containing response`, () => {
    const selected = retrieveChatMemory(fixtures.failedToolHistory(status), "docker-beta QPS");
    assert(selected.some(segment => segment.content.includes(fixtures.evidence.beta)),
      "Response status must not erase evidence from an independently completed tool");
  });
}

test("CTX-R03: failed tool outcomes remain available without becoming successful facts", () => {
  const chat = fixtures.failedToolHistory();
  const segments = chatMemorySegments(chat);
  assert(segments.some(segment => segment.content.includes("NOT_SAVED: disk full")),
    "Failed operation evidence is needed to prevent false success claims and unsafe retries");
});

test("CTX-R04: changed source content cannot reuse an old segment identity", () => {
  const chat = fixtures.conversation({ messages: [fixtures.message("assistant", "Original QPS=700")] });
  const original = chatMemorySegments(chat);
  const changed = chatMemorySegments({
    ...chat, messages: [{ ...chat.messages[0], content: "Corrected QPS=1250" }],
  });
  assert.notEqual(original[0].id, changed[0].id,
    "Feedback must identify an immutable source version, not just a mutable message position");
});

async function transportFixture(t, source, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-context-contract-"));
  const requests = [];
  const retrievalQueries = [];
  const errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(payload);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "Synthetic response" }, finish_reason: null }] })}\n\n`
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    } catch (error) {
      errors.push(error);
      res.writeHead(500);
      res.end("Synthetic transport fixture failed");
    }
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const extension = { secrets: { get: async () => "synthetic-key" } };
  const provider = new ApiChatView(extension, async query => {
    retrievalQueries.push(query);
    if (options.retrievalError) throw options.retrievalError;
    if (options.retrievalHang) return new Promise(() => {});
    return options.candidates || [];
  });
  t.after(() => provider.dispose());
  provider.store = new ApiChatStore(path.join(directory, ".pkm", "state"), fixtures.namespace);
  provider.store.save(source);
  provider.chat = provider.store.load(source.id, false);
  provider.chats.set(source.id, provider.chat);
  provider.publish = () => {};
  provider.toolGroups = () => [{ id: "builtin", tools: [] }];
  provider.captureExecution = chat => captureExecutionContext(
    provider.executionHostId, [], directory, true, chat.permissionMode || "ask");
  provider.settings = () => ({
    provider: "openai-compatible", selectedProfile: profile, profiles: [profile],
    endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: profile.model,
    contextWindow: options.contextWindow || profile.contextWindow,
    maxOutputTokens: 1024, timeoutMs: 10000, maxToolRounds: 3, loopReviewAfterMs: 60000,
  });
  return { provider, requests, retrievalQueries, errors };
}

test("CTX-T01: small context uses the real controller, disk store and HTTP transport", async t => {
  const fixture = await transportFixture(t, fixtures.conversation());
  await fixture.provider.send("Small synthetic question");
  const reply = fixture.provider.chat.messages.at(-1);
  assert.equal(reply.status, "complete", reply.error);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.retrievalQueries.length, 1);
  assert.equal(fixture.requests[0].messages.at(-1).content, "Small synthetic question");
  assert.equal(fixture.provider.store.load(fixture.provider.chat.id, false).messages.at(-1).content, "Synthetic response");
  const activity = reply.retrievalActivity;
  assert.equal(activity.attempts.length, 2);
  assert.deepEqual(activity.attempts.map(attempt => attempt.kind), ["memory", "knowledge"]);
  assert.equal(activity.rounds.length, 1);
  assert.equal(activity.rounds[0].index, 0);
  assert.equal(activity.rounds[0].countingMethod, "utf8-byte-estimate");
  assert.deepEqual(activity.rounds[0].receipt, reply.retrieval);
  assert.deepEqual(fixture.provider.store.load(fixture.provider.chat.id, false).messages.at(-1).retrievalActivity, activity);
  assert.deepEqual(fixture.errors, []);
});

test("CTX-T02: an empty knowledge result adds no reference context", async t => {
  const fixture = await transportFixture(t, fixtures.conversation());
  await fixture.provider.send("Small synthetic question");
  assert.equal(fixture.requests.length, 1);
  assert(!text(fixture.requests[0].messages).includes("Automatically retrieved PKM references"));
  assert.equal(fixture.provider.chat.messages.at(-1).retrieval.selectedCount, 0);
});

test("CTX-T04: retrieval failure is isolated from the primary Chat request", async t => {
  const fixture = await transportFixture(t, fixtures.conversation(), {
    retrievalError: new Error("synthetic retrieval model failure"),
  });
  await fixture.provider.send("Continue without automatic references");
  const reply = fixture.provider.chat.messages.at(-1);
  assert.equal(reply.status, "complete", reply.error);
  assert.equal(fixture.requests.length, 1);
  assert(!text(fixture.requests[0].messages).includes("Automatically retrieved PKM references"));
  assert.match(reply.retrieval.warning, /retrieval unavailable/i);
  assert.deepEqual(fixture.errors, []);
});
  test("CTX-T05: malformed retrieval is rejected while a valid candidate still reaches HTTP", async t => {
    const candidate = {
      id: "valid-evidence", kind: "note", label: "Valid reference", sourceUri: "pkm://fixture/valid",
      score: 1, method: "synthetic:test", selected: true, reason: "fixture", content: "VALID_EXTERNAL_EVIDENCE",
    };
    const fixture = await transportFixture(t, fixtures.conversation(), {
      candidates: [null, { ...candidate, id: "invalid-score", score: NaN }, { ...candidate, id: "invalid-range", range: null }, candidate],
    });
    await fixture.provider.send("Continue with validated references only");
    const reply = fixture.provider.chat.messages.at(-1);
    assert.equal(reply.status, "complete", reply.error);
    assert.equal(fixture.requests.length, 1);
    assert(text(fixture.requests[0].messages).includes(candidate.content));
    assert.equal(reply.retrieval.selectedCount, 1);
    assert.match(reply.retrieval.warning, /degraded/i);
  });

  test("CTX-T06: an unresponsive retriever times out without blocking the primary answer", async t => {
    const fixture = await transportFixture(t, fixtures.conversation(), { retrievalHang: true });
    const started = Date.now();
    await fixture.provider.send("Answer without stalled retrieval");
    const reply = fixture.provider.chat.messages.at(-1);
    assert.equal(reply.status, "complete", reply.error);
    assert.equal(fixture.requests.length, 1);
    assert.match(reply.retrieval.warning, /deadline/i);
    assert(Date.now() - started < 8000, "Five-second retrieval deadline must bound dispatch delay");
  });

  test("CTX-T07: cancelling an unresponsive retriever promptly cancels Chat without model dispatch", async t => {
    const fixture = await transportFixture(t, fixtures.conversation(), { retrievalHang: true });
    const send = fixture.provider.send("Cancel stalled retrieval");
    const deadline = Date.now() + 2000;
    while (!fixture.retrievalQueries.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(fixture.retrievalQueries.length, 1);
    const started = Date.now();
    fixture.provider.running.get(fixture.provider.chat.id).abort();
    await send;
    assert(Date.now() - started < 1000);
    assert.equal(fixture.provider.chat.messages.at(-1).status, "cancelled");
    assert.equal(fixture.requests.length, 0);
  });

  test("CTX-T08: receipt selection matches budgeted HTTP context; oversized sources are not cut", async t => {
    const candidates = Array.from({ length: 3 }, (_, index) => ({
      id: `reference-${index}`, kind: "note", label: `Reference ${index}`, sourceUri: `pkm://fixture/reference-${index}`,
      score: 10 - index, method: "synthetic:test", selected: true, reason: "fixture",
      content: `REFERENCE_${index}:` + "x".repeat(index === 2 ? 5000 : 3500),
    }));
    const fixture = await transportFixture(t, fixtures.largeToolHistory(), { contextWindow: 8192, candidates });
    await fixture.provider.send("docker-beta QPS concurrency=32 version=v2");
    const reply = fixture.provider.chat.messages.at(-1);
    assert.equal(reply.status, "complete", reply.error);
    const transmitted = text(fixture.requests[0].messages);
    assert(transmitted.includes(fixtures.evidence.beta));
    assert(!transmitted.includes("REFERENCE_2:"));
    const sourceSegments = new Map(chatMemorySegments(fixture.provider.chat).map(segment => [segment.id, segment]));
    for (const candidate of reply.retrieval.candidates) {
      assert.equal(candidate.selected, candidate.kind === "memory" ? transmitted.includes(sourceSegments.get(candidate.id).content) : transmitted.includes(candidate.sourceUri));
    }
    assert.equal(reply.retrieval.selectedCount, reply.retrieval.candidates.filter(candidate => candidate.selected).length);
    assert.match(reply.retrieval.candidates.find(candidate => candidate.id === "reference-2").reason, /L2/);
    assert.equal(candidates[0].reason, "fixture", "Provider-owned candidates must not be mutated");
    validateBudget(profile, 8192, 1024, fixture.requests[0].messages);
  });
test("CTX-R05: large tool history reaches HTTP with relevant evidence and History still enabled", async t => {
  const source = fixtures.largeToolHistory();
  const originalMessages = JSON.stringify(source.messages);
  const fixture = await transportFixture(t, source);
  await fixture.provider.send("What is docker-beta QPS at concurrency=32 and version=v2?");
  const reply = fixture.provider.chat.messages.at(-1);
  assert.equal(reply.status, "complete", reply.error);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.provider.chat.includeHistory, true);
  const payload = fixture.requests[0];
  assert(text(payload.messages).includes(fixtures.evidence.beta));
  assert(!text(payload.messages).includes("unrelated-result-"),
    "Passing by raising/removing the character limit is not retrieval-first context management");
  validateBudget(profile, profile.contextWindow, 1024, payload.messages);
  assert.equal(JSON.stringify(fixture.provider.store.load(source.id, false).messages.slice(0, source.messages.length)), originalMessages);
  assert.deepEqual(fixture.errors, []);
});

test("CTX-R06: relevant history fits a smaller model budget without turning History off", async t => {
  const fixture = await transportFixture(t, fixtures.largeToolHistory(), { contextWindow: 8192 });
  await fixture.provider.send("What is docker-beta QPS at concurrency=32 and version=v2?");
  const reply = fixture.provider.chat.messages.at(-1);
  assert.equal(reply.status, "complete", reply.error);
  assert.equal(fixture.requests.length, 1);
  assert(text(fixture.requests[0].messages).includes(fixtures.evidence.beta));
  validateBudget(profile, 8192, 1024, fixture.requests[0].messages);
});

test("CTX-T03: oversized pinned input is rejected before any HTTP model call", async t => {
  const source = fixtures.conversation({
    context: [{ id: "pinned", label: "Required pinned reference", content: "x".repeat(10000) }],
  });
  const fixture = await transportFixture(t, source, { contextWindow: 4096 });
  await fixture.provider.send("Explain the pinned reference");
  assert.equal(fixture.provider.chat.messages.at(-1).status, "failed");
  assert.match(fixture.provider.chat.messages.at(-1).error, /budget exceeded/);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.provider.store.load(source.id, false).context[0].content, source.context[0].content);
});

const pendingMechanisms = [
  ["CTX-M01", "below/exactly at budget: one retrieval, no refinement, no compression, no LLM rewrite"],
  ["CTX-M02", "one token over: refinement starts only after the selected subset is measured"],
  ["CTX-M03", "first refined subset fits: stop refinement and make exactly one answer request"],
  ["CTX-M04", "duplicate-only re-retrieval: bounded no-progress stop, not repeated identical attempts"],
  ["CTX-M05", "candidate/attempt/time limits: stop before the next operation and report unresolved evidence"],
  ["CTX-M06", "JSON/table refinement: preserve entity, metric, unit, header and shared test conditions"],
  ["CTX-M07", "unknown text: no destructive word deletion and no automatic LLM shortening"],
  ["CTX-M08", "explicitly unavailable deterministic path: LLM fallback remains off without separate approval"],
  ["CTX-M09", "source revision changes: reject stale chunks and cached projections before injection"],
  ["CTX-M10", "fresh semantic boundary: child IDs, original ranges and parent links remain reproducible"],
  ["CTX-M11", "tool rounds: replan every request while retaining call/result pairing and execution outcomes"],
  ["CTX-M12", "steering: failed planning leaves input queued; accepted input is consumed once"],
  ["CTX-M13", "retry/delegation: use the same planner without sharing foreign history or replaying tools"],
  ["CTX-M14", "receipt: final selected IDs/ranges/counts match the actual transmitted payload"],
  ["CTX-M15", "feedback: actual serving package/version/fallback recorded, not just requested route"],
  ["CTX-M16", "feedback collection off: no training events, raw query capture or serving-weight update"],
  ["CTX-M17", "store restart/crash: original references resolve or explicitly report missing data"],
  ["CTX-M18", "host/browser E2E: installed extension persists evidence and displays actual mechanism triggers"],
];
for (const [id, requirement] of pendingMechanisms) test.todo(`${id}: ${requirement}`);
