const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { fitChatContext, ChatContextPlanner, ContextCandidateLimitError, AUTOMATIC_KNOWLEDGE_INPUT_BUDGET } = require("../dist/chat/chat-context");
const { estimateInputTokens } = require("../dist/chat/api-chat-models");
const { ChatToolLoopGuard } = require("../dist/chat/api-chat-client");
const required = () => ({ role:"user", content:"Preserve all constraints. Do not deploy." });
const hash = message => createHash("sha256").update(JSON.stringify(message)).digest("hex");

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
