const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { fitChatContext, ChatContextPlanner, ContextCandidateLimitError, AUTOMATIC_KNOWLEDGE_INPUT_BUDGET, sdkInputBound } = require("../dist/chat/chat-context");
const { estimateInputTokens } = require("../dist/chat/api-chat-models");
const { ChatToolLoopGuard, chatToolRoundLimit, chatToolRoundBudgetNotice } = require("../dist/chat/api-chat-client");
const required = () => ({ role:"user", content:"Preserve all constraints. Do not deploy." });
const hash = message => createHash("sha256").update(JSON.stringify(message)).digest("hex");

test("hard-round budget notice is bounded advisory with exact inference boundaries", () => {
  assert.equal(chatToolRoundBudgetNotice(0), undefined);
  assert.equal(chatToolRoundBudgetNotice(NaN, undefined), undefined);
  for (const limit of [1, 2, 4, 1000]) {
    assert.equal(chatToolRoundLimit(limit), limit);
    for (let remaining = 0; remaining <= Math.min(4, limit); remaining++) {
      const completed = limit - remaining;
      const notice = chatToolRoundBudgetNotice(completed, limit);
      assert.equal(notice, chatToolRoundBudgetNotice(completed, limit));
      assert.ok(Buffer.byteLength(notice, "utf8") < 1000);
      assert.ok(notice.includes(`total=${limit}, completed=${completed}, remaining=${remaining}.`));
      assert.match(notice, /Remaining includes the coming inference, not calls\/tools/);
      assert.match(notice, /No extra reporting allowance after the boundary/);
      assert.match(notice, /Advisory only; does not change caps\/guards or authorize tools, permissions or acceptance/);
      assert.equal(notice.includes("Tools stopped; only summary allowed"), remaining === 0);
      assert.equal(notice.includes("explicitly save applied edits, verify saved files with focused tests, then report_work with actual evidence"), remaining > 0 && remaining <= 3);
      if (remaining > 0 && remaining <= 3) {
        assert.match(notice, /Stop new edits and rereading/);
        assert.match(notice, /report blocked with saved versus unsaved paths and unrun checks/);
        assert.match(notice, /Unverified criteria stay unverified/);
      }
      assert.match(notice, /final model summary may not fit the input budget/);
    }
  }
  for (const limit of [0, -1, 1.5, NaN, Infinity, 1001, Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.throws(() => chatToolRoundBudgetNotice(0, limit), /Choose a tool round limit of 1-1000/);
    assert.throws(() => chatToolRoundLimit(limit), /Choose a tool round limit of 1-1000/);
  }
  for (const completed of [-1, 0.5, NaN, Infinity, 5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => chatToolRoundBudgetNotice(completed, 4), /Completed inference rounds must be a safe integer from 0 to the hard limit/);
  }
  assert.equal(chatToolRoundLimit(), 30); // Existing cap validation remains unchanged.
});

function reference(content, id, priority, refine) {
  return { message:{ role:"system", content }, reference:{ ids:[id], priority, refine } };
}
function fit(entries, budget, options = {}) {
  const messages = [...entries.map(item => item.message), required()];
  const automatic = new Map(entries.map(item => [item.message, item.reference]));
  let receipt;
  const selected = fitChatContext(messages, automatic, budget, [], { ...options, report:value => { receipt = value; } });
  return { messages, selected, receipt };
}

test("SDK provider input baseline avoids charging a known schema's bytes as tokens again", () => {
  const prompt = required(), schema = [{ role:"system", content:"tool schema ".repeat(5500) }];
  const messages = [prompt], planner = new ChatContextPlanner(messages, new Map(), schema);
  const baseline = { inputTokens:16000, outputTokens:300, messageHashes:[hash(prompt)] };
  const call = { role:"assistant", content:"", tool_calls:[{ id:"read", type:"function", function:{ name:"read_file", arguments:"{}" } }] };
  const result = { role:"tool", content:"source ".repeat(1800), tool_call_id:"read" };
  const round = [prompt, call, result];
  assert.throws(() => planner.plan([...round], 75000, ""), /required input/);
  const plan = planner.plan(round, 75000, "", undefined, baseline);
  assert(round.includes(result), "the latest complete result remains mandatory and intact");
  assert.equal(plan.receipt.measuredInput.countingMethod, "provider-usage-plus-byte-bound");
  assert.equal(plan.receipt.measuredInput.inputTokens, sdkInputBound(round, baseline));
  assert(plan.receipt.measuredInput.inputTokens < 31000);
  assert(plan.receipt.estimatedAfter > 75000, "raw byte estimate remains separately visible, not relabeled as actual tokens");
  assert.throws(() => planner.plan([...round], 20000, "", undefined, baseline), /required input/);
});

test("SDK baseline accounts for changed messages and never reclaims already consumed runtime context", () => {
  const message = required(), baseline = { inputTokens:2000, outputTokens:100, messageHashes:[hash(message)] };
  assert.equal(sdkInputBound([message], baseline), 2132);
  assert.equal(sdkInputBound([], baseline), 2132, "removing a shadow message does not remove it from the SDK session");
  assert(sdkInputBound([message, { ...message }], baseline) > 2132, "a duplicate new message is not free just because its hash is known");
  message.content += " New required instruction.";
  assert(sdkInputBound([message], baseline) > 2132, "mutated content must be charged again");
  assert.throws(() => sdkInputBound([message], { ...baseline, inputTokens:NaN }), /Invalid SDK/);
  assert.throws(() => sdkInputBound([{ ...message, images:[{}] }], baseline), /New images/);
});

test("automatic PKM reference budget admits exactly 8k and rejects one byte over independently of the model window", () => {
  assert.equal(AUTOMATIC_KNOWLEDGE_INPUT_BUDGET, 8000);
  for (const [size, admitted] of [[7936, true], [7937, false]]) {
    const entry = reference("x".repeat(size), "automatic-source", 1);
    entry.reference.budget = "knowledge";
    const pinned = { role:"system", content:"Pinned manual context ".repeat(3000) };
    const memory = reference("Organized memory ".repeat(200), "memory", 200);
    const messages = [pinned, memory.message, entry.message, required()];
    const automatic = new Map([[entry.message, entry.reference], [memory.message, memory.reference]]);
    let receipt;
    fitChatContext(messages, automatic, 500000, [], { report:value => { receipt = value; } });
    assert.equal(messages.includes(entry.message), admitted);
    assert(messages.includes(pinned) && messages.includes(memory.message), "manual context and separate Memory context must not be charged to the knowledge budget");
    assert.equal(receipt.automaticKnowledge.inputBudget, 8000);
    assert(receipt.automaticKnowledge.estimatedAfter <= 8000);
    assert.equal(receipt.automaticKnowledge.estimatedAfter, admitted ? 8000 : 32);
    assert.equal(receipt.stopReason, admitted ? "fits" : "selected-subset");
    assert.deepEqual(receipt.omittedIds, admitted ? [] : ["automatic-source"]);
  }
});

test("automatic PKM long sources refine query-matched evidence even in a large model window and stay bounded across rounds", () => {
  const original = "Unrelated source body ".repeat(20000);
  const entry = reference(original, "source", 1, query =>
    [reference(`Exact matched ${query} passage. `.repeat(20), `range:${query}`, 1)]);
  Object.assign(entry.reference, { budget:"knowledge", preferRefinement:true });
  const messages = [entry.message, required()];
  const planner = new ChatContextPlanner(messages, new Map([[entry.message, entry.reference]]), []);
  for (const query of ["first", "second", "third"]) {
    const next = [...messages];
    const plan = planner.plan(next, 1000000, query);
    assert.deepEqual([...plan.selected], [`range:${query}`], "steering must refine against the current query without reusing stale passages");
    assert.equal(plan.receipt.refinements, 1);
    assert(plan.receipt.automaticKnowledge.estimatedAfter <= 8000);
    assert(next.some(message => message.content.includes(`Exact matched ${query}`)));
    assert(!next.some(message => message.content.includes("Unrelated source body")));
    assert.equal(entry.message.content, original, "full evidence is retained unchanged locally");
  }
});

test("automatic knowledge aggregate budget cannot be bypassed by many sources or dependent evidence groups", () => {
  const entries = Array.from({ length:20 }, (_, index) => {
    const entry = reference("Bounded source ".repeat(100), `source-${index}`, 50 - index);
    entry.reference.budget = "knowledge";
    return entry;
  });
  const result = fit(entries, 1000000);
  assert(result.selected.size > 0 && result.selected.size < entries.length);
  assert(estimateInputTokens(result.messages.filter(message => message !== result.messages.at(-1))) <= 8000);
  assert(result.receipt.automaticKnowledge.estimatedAfter <= 8000);
  const dependent = entries.slice(0, 2);
  for (const entry of dependent) {
    entry.message.content = "x".repeat(4000);
    entry.reference.groupId = "atomic-dependent-pair";
  }
  assert.equal(fit(dependent, 1000000).selected.size, 0, "a dependent group must not be partially included to fit the budget");
});

test("CTX-M01: below/exact budget never invokes refinement or rewrites references", () => {
  const entry = reference("Original conditions: NOT approved; 125 ms.", "source", 1, () => { throw new Error("Must not refine fitting context"); });
  const exact = estimateInputTokens([entry.message, required()]);
  for (const budget of [exact, exact + 1]) {
    const result = fit([entry], budget);
    assert.equal(result.receipt.refinements, 0);
    assert.equal(result.receipt.stopReason, "fits");
    assert(result.messages.includes(entry.message));
    assert.deepEqual([...result.selected], ["source"]);
  }
});

test("CTX-M02/M03: one byte over is measured first; first fitting refinement stops after one operation", () => {
  let operations = 0;
  const child = reference("Tail evidence: NOT approved; 125 ms.", "range", 1);
  const entry = reference("Original source ".repeat(100), "source", 1, () => { operations++; return [child]; });
  const budget = estimateInputTokens([entry.message, required()]) - 1;
  const result = fit([entry], budget);
  assert.equal(result.receipt.estimatedBefore, budget + 1);
  assert.equal(operations, 1);
  assert.equal(result.receipt.refinements, 1);
  assert.deepEqual([...result.selected], ["range"]);
  assert(result.messages.includes(child.message));
  assert.equal(result.messages.at(-1).content, required().content);
  assert(result.receipt.estimatedAfter <= budget);
});

test("CTX-M04: duplicate-only refinement stops without reissuing the same operation", () => {
  let operations = 0;
  const entry = reference("Original source ".repeat(100), "source", 1, () => { operations++; return [entry]; });
  const result = fit([entry], estimateInputTokens([required()]) + 50);
  assert.equal(operations, 1);
  assert.equal(result.receipt.stopReason, "no-progress");
  assert.deepEqual(result.receipt.unresolved, ["source"]);
  assert.equal(result.messages.length, 1);
});

test("CTX-M04: duplicated child evidence in one refinement is measured and injected only once", () => {
  const child = reference("Original tail evidence, NOT approved.", "range", 1);
  const duplicate = { message:{ ...child.message }, reference:{ ...child.reference } };
  const entry = reference("Long original ".repeat(500), "parent", 1, () => [child, duplicate]);
  const result = fit([entry], 1024);
  assert.equal(result.receipt.refinements, 1);
  assert.equal(result.messages.filter(message => message.content === child.message.content).length, 1);
  assert.deepEqual([...result.selected], ["range"]);
  assert.equal(result.receipt.estimatedAfter, estimateInputTokens([child.message, required()]));
});

test("CTX-M05: attempt/deadline limits are checked before another refinement, with explicit unresolved IDs", () => {
  let operations = 0;
  const entries = Array.from({ length:3 }, (_, index) => reference("large source ".repeat(500), `source-${index}`, 10 - index,
    () => { operations++; return [reference("small", `child-${index}`, 1)]; }));
  const budget = estimateInputTokens([required()]) + 300;
  const limited = fit(entries, budget, { maxRefinements:1 });
  assert.equal(operations, 1);
  assert.equal(limited.receipt.stopReason, "refinement-limit");
  assert.deepEqual(limited.receipt.unresolved, ["source-1", "source-2"]);
  operations = 0;
  const expired = fit(entries, budget, { deadlineMs:0 });
  assert.equal(operations, 0);
  assert.equal(expired.receipt.stopReason, "deadline");
  assert.deepEqual(expired.receipt.unresolved, entries.map(item => item.reference.ids[0]));
});

test("CTX-M04/M05: duplicate sources and total candidate work are bounded, including duplicate-only outputs", () => {
  let operations = 0;
  const entry = reference("Long original ".repeat(500), "same-source", 1, () => { operations++; return []; });
  const duplicate = { message:{ ...entry.message }, reference:{ ...entry.reference } };
  const repeated = fit([entry, duplicate], 1024);
  assert.equal(operations, 1);
  assert.equal(repeated.receipt.stopReason, "no-progress");
  assert.deepEqual(repeated.receipt.unresolved, ["same-source"]);
  const child = reference("NOT approved", "child", 1);
  const entries = Array.from({ length:3 }, (_, index) => reference("Long original ".repeat(500), `source-${index}`, 10 - index,
    () => { operations++; return [child, child]; }));
  operations = 0;
  const bounded = fit(entries, 1024, { maxCandidates:2 });
  assert.equal(operations, 1);
  assert.equal(bounded.receipt.stopReason, "candidate-limit");
  assert.deepEqual(bounded.receipt.unresolved, ["source-1", "source-2"]);
  assert.deepEqual([...bounded.selected], ["child"]);
  operations = 0;
  const oversized = fit(entries, 1024, { maxCandidates:1 });
  assert.equal(operations, 1);
  assert.equal(oversized.receipt.stopReason, "candidate-limit");
  assert.deepEqual(oversized.receipt.unresolved, ["source-0", "source-1", "source-2"]);
  assert.deepEqual([...oversized.selected], []);
  assert.equal(oversized.messages.length, 1);
});

test("CTX-M05: an operation reaching the deadline cannot inject late evidence or start the next operation", () => {
  let clock = 0, operations = 0;
  const entries = Array.from({ length:2 }, (_, index) => reference("Long original ".repeat(500), `source-${index}`, 10 - index,
    () => { operations++; clock = 10; return [reference("Late evidence", `child-${index}`, 1)]; }));
  const result = fit(entries, 1024, { deadlineMs:10, now:() => clock });
  assert.equal(operations, 1);
  assert.equal(result.receipt.stopReason, "deadline");
  assert.deepEqual(result.receipt.unresolved, ["source-0", "source-1"]);
  assert.equal(result.messages.length, 1);
  for (const maxCandidates of [-1, 1.5, NaN]) assert.throws(() => fit(entries, 1024, { maxCandidates }), /Invalid/);
});

test("CTX-M05: provider candidate exhaustion is explicit and prevents every subsequent refinement", () => {
  let operations = 0;
  const entries = Array.from({ length:3 }, (_, index) => reference("Long source ".repeat(1000), `source-${index}`, 10 - index,
    () => { operations++; throw new ContextCandidateLimitError("Provider candidate boundary"); }));
  const result = fit(entries, 1024);
  assert.equal(operations, 1);
  assert.equal(result.receipt.stopReason, "candidate-limit");
  assert.deepEqual(result.receipt.unresolved, ["source-0", "source-1", "source-2"]);
  const broken = reference("Long source ".repeat(1000), "broken", 1, () => { throw new Error("Actual provider failure"); });
  assert.throws(() => fit([broken], 1024), /Actual provider failure/);
});

test("CTX-M07/M08: unsupported deterministic refinement leaves text intact and never calls an LLM", () => {
  const body = "Unrecognized binary-like text NOT approved ".repeat(200);
  const entry = reference(body, "unknown", 1, () => []);
  const result = fit([entry], estimateInputTokens([required()]) + 100);
  assert.equal(entry.message.content, body);
  assert.deepEqual(result.receipt.omittedIds, ["unknown"]);
  assert.deepEqual(result.receipt.unresolved, ["unknown"]);
  assert.equal(result.receipt.stopReason, "no-progress");
  assert.equal(result.messages.length, 1);
});

test("CTX-M09: a previously selected reference is revalidated and excluded before a later inference", () => {
  let current = true;
  const entry = reference("revision-one evidence", "r1", 1);
  entry.reference.isCurrent = () => current;
  const messages = [entry.message, required()];
  const planner = new ChatContextPlanner(messages, new Map([[entry.message, entry.reference]]), []);
  assert(planner.plan(messages, 4096, "evidence").selected.has("r1"));
  current = false;
  const stale = planner.plan(messages, 4096, "evidence");
  assert.equal(stale.receipt.stopReason, "stale-source");
  assert(!stale.selected.has("r1"));
  assert(!messages.some(item => item.content.includes("revision-one")));
  assert.deepEqual(stale.receipt.unresolved, ["r1"]);
});

function tools(id, content) {
  return [{ role:"assistant", content:"", tool_calls:[{ id, type:"function", function:{ name:"read_file", arguments:"{}" } }] },
    { role:"tool", content, tool_call_id:id }];
}

test("CTX-M11: completed tool groups replan atomically; omitted evidence can be reselected without replay", () => {
  const original = required(), first = tools("first", "alpha ".repeat(500)), second = tools("second", "beta evidence");
  const messages = [original], planner = new ChatContextPlanner(messages, new Map(), []);
  planner.plan(messages, 4096, "alpha");
  messages.push(...first);
  planner.plan(messages, 4096, "alpha");
  messages.push(...second);
  const small = planner.plan(messages, 1024, "beta");
  assert(!messages.some(message => message.tool_call_id === "first"));
  assert(messages.includes(second[0]) && messages.includes(second[1]));
  assert(small.receipt.omittedIds.some(id => id.startsWith("tool:first:")));
  assert.equal(messages.filter(message => message.content.includes("execution is not undone")).length, 1);
  planner.plan(messages, 1024, "beta");
  assert.equal(messages.filter(message => message.content.includes("execution is not undone")).length, 1, "Safety ledger does not accumulate on replan");
  const restored = planner.plan(messages, 8192, "alpha");
  assert(messages.includes(first[0]) && messages.includes(first[1]));
  assert(restored.selected.size > small.selected.size);
  assert.equal(first[1].content, "alpha ".repeat(500));
  const malformed = [required(), ...tools("missing", "outcome").slice(0, 1)];
  assert.throws(() => new ChatContextPlanner(malformed, new Map(), []).plan(malformed, 4096, ""), /incomplete/);
});

test("CTX-M12: rolling back a prepared but uncommitted plan does not retain removed steering", () => {
  const messages = [required()], planner = new ChatContextPlanner(messages, new Map(), []);
  const rollback = planner.checkpoint();
  const failed = [...messages, { role:"user", content:"Removed after persistence failure" }];
  planner.plan(failed, 4096, "removed");
  rollback();
  const accepted = [...messages, { role:"user", content:"Accepted replacement" }];
  planner.plan(accepted, 4096, "accepted");
  assert(!accepted.some(message => message.content.includes("Removed after")));
  assert.equal(accepted.filter(message => message.content === "Accepted replacement").length, 1);
});

test("native measured planning retains fitting tool evidence before byte estimates can evict it", async () => {
  const first = tools("first", "alpha ".repeat(1200)), second = tools("second", "beta ".repeat(1200));
  const messages = [required(), ...first, ...second], automatic = new Map();
  const schema = [{ role:"system", content:"tool schema ".repeat(500) }];
  const planner = new ChatContextPlanner(messages, automatic, schema);
  let measurements = 0;
  const counter = {
    countMessage:async message => { measurements++; return Math.ceil(Buffer.byteLength(JSON.stringify(message)) / 6) + 32; },
    countTools:async () => 400,
  };
  const measured = await planner.measure(messages, 4096, counter);
  assert(measured, "byte overflow must be measured before dropping evidence");
  const result = planner.plan(messages, 4096, "alpha beta", measured);
  assert(messages.includes(first[1]) && messages.includes(second[1]));
  assert.equal(result.receipt.stopReason, "fits");
  assert.equal(result.receipt.omittedIds.length, 0);
  assert(result.receipt.estimatedAfter > 4096, "byte estimates remain estimates, not measured token usage");
  assert(result.receipt.measuredInput.inputTokens <= 4096);
  assert.equal(result.receipt.measuredInput.countingMethod, "vscode-countTokens-plus-overhead");
  const calls = measurements;
  assert.equal(await planner.measure(messages, 100000, counter), undefined);
  assert.equal(measurements, calls, "a fitting byte bound must not invoke a tokenizer");
  assert.deepEqual(result.receipt.manifest.map(item => item.hash), messages.map(hash));
});

test("measured planning still rejects required overflow and atomically evicts genuinely oversized old evidence", async () => {
  const messages = [required(), ...tools("first", "old ".repeat(3000)), ...tools("second", "current evidence")];
  const planner = new ChatContextPlanner(messages, new Map(), []);
  const countMessage = async message => Math.ceil(Buffer.byteLength(JSON.stringify(message)) / 2) + 32;
  const measurement = await planner.measure(messages, 1500, { countMessage, countTools:async () => 0 });
  const result = planner.plan(messages, 1500, "current", measurement);
  assert(!messages.some(message => message.tool_call_id === "first"));
  assert(messages.some(message => message.tool_call_id === "second"));
  assert(result.receipt.measuredInput.inputTokens <= 1500);
  const pinned = [{ role:"user", content:"x".repeat(10000) }];
  const mandatory = new ChatContextPlanner(pinned, new Map(), []);
  const cost = await mandatory.measure(pinned, 1000, { countMessage, countTools:async () => 0 });
  assert.throws(() => mandatory.plan(pinned, 1000, "", cost), /required input/);
  await assert.rejects(mandatory.measure(pinned, 1000, { countMessage:async () => NaN, countTools:async () => 0 }), /token count/);
  await assert.rejects(mandatory.measure(pinned, 1000, { countMessage:async () => { throw new Error("Tokenizer unavailable"); }, countTools:async () => 0 }), /Tokenizer unavailable/);
});

test("changed or newly inserted context uses labeled conservative bounds instead of stale measured counts", async () => {
  const prompt = required(), messages = [prompt, ...tools("current", "evidence ".repeat(1200))];
  const planner = new ChatContextPlanner(messages, new Map(), []);
  const counter = { countMessage:async () => 64, countTools:async () => 0 };
  const measured = await planner.measure(messages, 1000, counter);
  messages.push({ role:"user", content:"New steering" });
  const result = planner.plan(messages, 1000, "current", measured);
  assert.equal(result.receipt.measuredInput.countingMethod, "mixed-token-counts-and-byte-bounds");
  assert(result.receipt.measuredInput.inputTokens > 32 + messages.length * 32);
  const stale = await planner.measure(messages, 1000, counter);
  prompt.content = "Changed mandatory input ".repeat(500);
  assert.throws(() => planner.plan(messages, 1000, "current", stale), /required input/);
});

test("native measured planning retains evidence across rounds without widening automatic knowledge limits", async () => {
  const knowledge = reference("Automatic knowledge ".repeat(1000), "knowledge", 50);
  knowledge.reference.budget = "knowledge";
  const messages = [required(), knowledge.message], automatic = new Map([[knowledge.message, knowledge.reference]]);
  const planner = new ChatContextPlanner(messages, automatic, []);
  const counter = { countMessage:async () => 64, countTools:async () => 0 };
  for (let round = 0; round < 6; round++) {
    messages.push(...tools(`round-${round}`, "Source evidence ".repeat(1000)));
    const measured = await planner.measure(messages, 2000, counter);
    const result = planner.plan(messages, 2000, "source evidence", measured);
    assert.equal(messages.filter(message => message.role === "tool").length, round + 1);
    assert(!messages.includes(knowledge.message));
    assert(result.receipt.omittedIds.includes("knowledge"));
    assert.equal(result.receipt.automaticKnowledge.inputBudget, 8000);
    assert.equal(result.receipt.automaticKnowledge.estimatedAfter, 32);
    assert(!result.receipt.omittedIds.some(id => id.startsWith("tool:")));
  }
});

test("refined projections use the current query, do not duplicate whole sources, and have bounded lifetime", () => {
  const queries = [];
  const entry = reference("Long source ".repeat(1000), "source", 1, query => {
    queries.push(query);
    return [reference(`Original evidence for ${query}`, `range:${query}`, 1)];
  });
  const messages = [entry.message, required()], automatic = new Map([[entry.message, entry.reference]]);
  const planner = new ChatContextPlanner(messages, automatic, []);
  for (const query of ["alpha", "beta", "gamma"]) {
    const result = planner.plan(messages, 1024, query);
    assert.deepEqual([...result.selected], [`range:${query}`]);
    assert.equal(messages.filter(message => message.role === "system").length, 1);
    assert.equal(automatic.size, 2, "Only source and this round's derived projection are retained");
  }
  assert.deepEqual(queries, ["alpha", "beta", "gamma"]);
  planner.plan(messages, 32768, "full source");
  assert(messages.includes(entry.message));
  assert.equal(messages.filter(message => message.role === "system").length, 1, "A fitting source is not also injected as cached child evidence");
  assert.equal(automatic.size, 1);
  assert.equal(queries.length, 3, "A fitting source does not trigger refinement");
});

test("CTX-M14: final canonical message manifest matches exact roles, hashes, IDs and tool pairs", () => {
  const entry = reference("Original range [50, 90); NOT approved", "range:50:90", 1);
  const messages = [entry.message, required(), ...tools("call", "NOT_SAVED: disk full")];
  const planner = new ChatContextPlanner(messages, new Map([[entry.message, entry.reference]]), []);
  const result = planner.plan(messages, 4096, "disk full");
  assert.equal(result.receipt.manifest.length, messages.length);
  for (const [index, message] of messages.entries()) {
    assert.equal(result.receipt.manifest[index].hash, hash(message));
    assert.equal(result.receipt.manifest[index].role, message.role);
  }
  assert.deepEqual(result.receipt.manifest[0].referenceIds, ["range:50:90"]);
  assert.deepEqual(result.receipt.manifest.slice(-2).map(item => item.callIds), [["call"], ["call"]]);
  assert.equal(result.receipt.estimatedAfter, estimateInputTokens(messages));
});

test("loop evidence pauses before the fourth identical effect without waiting for the time review window", async () => {
  const notices = [], guard = new ChatToolLoopGuard({ loopReviewAfterMs:1800000, loopReviewClock:() => 0,
    onToolLoopNotice:async notice => { notices.push(notice); return "summarize"; } });
  for (let index = 0; index < 3; index++) guard.record(undefined, "read_file", '{"path":"same"}', "no change");
  await guard.beforeRound(1, new AbortController().signal);
  assert.equal(guard.summarizing, true);
  assert.equal(notices[0].reason, "stalled");
  assert.equal(notices[0].repeats, 3);
});

test("alternating call/argument cycles are bounded while genuinely changing results remain progress", async () => {
  const notices = [], guard = new ChatToolLoopGuard({ loopReviewAfterMs:1800000,
    onToolLoopNotice:async notice => { notices.push(notice); return "continue"; } });
  const signal = new AbortController().signal;
  for (let index = 0; index < 5; index++) {
    guard.record(undefined, "search", JSON.stringify({ query:index % 2 ? "beta" : "alpha" }), "same evidence");
    await guard.beforeRound(index, signal);
  }
  assert.equal(notices.length, 1);
  for (let index = 0; index < 10; index++) {
    guard.record(undefined, "read_file", "{}", `new progress ${index}`);
    await guard.beforeRound(index, signal);
  }
  assert.equal(notices.length, 1);
});
