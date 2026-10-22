const { test } = require("node:test");
const assert = require("node:assert/strict");
const { classifyTaskProgress, taskToolCallSignature, aggregateWorkerQuotas, evaluateDeadlines } = require("../dist/chat/task-progress");

const artifact = (at, hash) => ({ at, kind: "artifact", hash });
const call = (at, id, overrides = {}) => ({ at, kind: "tool-call", call: {
  id, name: "read_file", arguments: '{"path":"a.ts"}', status: "complete", ...overrides,
} });
const repeated = (overrides = {}) => [1, 2, 3].map(at => call(at, `call-${at}`, overrides));
const options = { now: 100, windowMs: 100, repeatThreshold: 3 };

for (const record of [artifact(1, "sha-a"), { at: 1, kind: "content", hash: "sha-b" }, { at: 1, kind: "file", path: "new.ts" }, call(1, "one")]) {
  test(`classifies new ${record.kind} evidence as progressing`, () => {
    const observed = classifyTaskProgress([record], options);
    assert.equal(observed.status, "progressing");
    assert(observed.reasons.length);
    assert.equal(observed.evidence.length, 1);
  });
}

test("normalizes JSON object order and whitespace, preserving array order and string whitespace", () => {
  const signature = arguments => taskToolCallSignature({ name: "read_file", arguments });
  assert.equal(signature('{"b":[1,2],"a":{"y":2,"x":1}}'), signature(' { "a": {"x":1,"y":2}, "b":[1,2] } '));
  assert.notEqual(signature('[1,2]'), signature('[2,1]'));
  assert.notEqual(signature('"a b"'), signature('"a  b"'));
  assert.equal(signature(" malformed "), signature("malformed"));
  assert.notEqual(taskToolCallSignature({ name: "write_file", arguments: "{}" }), signature("{}"));
});

test("same signature loops despite fresh call ids and normalized argument formatting", () => {
  const records = repeated(); records[1].call.arguments = '{ "path": "a.ts" }';
  const observed = classifyTaskProgress(records, options);
  assert.equal(observed.status, "looping");
  assert.equal(observed.evidence.length, 3);
  assert.equal(classifyTaskProgress(records, { ...options, repeatThreshold: 4 }).status, "progressing");
});

test("the same failing result across distinct tool calls also loops", () => {
  const records = repeated({ status: "failed", result: "not found" });
  records.forEach((record, index) => { record.call.arguments = JSON.stringify({ path: `${index}.ts` }); });
  assert.equal(classifyTaskProgress(records, options).status, "looping");
  records.forEach(record => { delete record.call.result; });
  assert.equal(classifyTaskProgress(records, options).status, "progressing", "missing failures are not identical results");
});

test("fresh artifacts reset loop evidence, while already-known hashes do not", () => {
  assert.equal(classifyTaskProgress([...repeated(), artifact(4, "new")], options).status, "progressing");
  assert.equal(classifyTaskProgress([artifact(0, "known"), ...repeated(), artifact(4, "known")], options).status, "looping");
  assert.equal(classifyTaskProgress([artifact(0, "known"), ...repeated(), { at: 4, kind: "content", hash: "known" }], options).status, "looping");
});


test("artifacts reset earlier calls even when all observations share a clock tick", () => {
  const records = repeated().map(record => ({ ...record, at: 1 }));
  assert.equal(classifyTaskProgress([...records, artifact(1, "new")], options).status, "progressing");
  assert.equal(classifyTaskProgress([artifact(1, "new"), ...records], options).status, "looping");
});

test("old repetitions and old artifact hashes do not manufacture current progress", () => {
  assert.equal(classifyTaskProgress(repeated(), { ...options, now: 1000 }).status, "unknown");
  assert.equal(classifyTaskProgress([artifact(0, "old"), artifact(990, "old")], { ...options, now: 1000 }).status, "unknown");
  assert.equal(classifyTaskProgress([call(0, "one"), call(990, "two")], { ...options, now: 1000 }).status, "unknown");
});

test("running and terminal snapshots of one invocation are not repeated calls", () => {
  const records = [call(1, "one", { status: "running" }), call(2, "one"), call(3, "one")];
  assert.equal(classifyTaskProgress(records, options).status, "progressing");
  assert.throws(() => classifyTaskProgress([...records, call(4, "one", { arguments: "{}" })], options), /identity/);
});

for (const reason of ["user", "approval", "external-job"]) {
  test(`pending ${reason} wait takes priority over loops and never becomes idle`, () => {
    const wait = { at: 4, kind: "wait", id: "wait-1", reason, status: "pending" };
    const records = [...repeated(), wait];
    assert.equal(classifyTaskProgress(records, { ...options, now: 100000 }).status, "waiting");
    assert.equal(classifyTaskProgress([...records, { ...wait, at: 5, status: "resolved" }], options).status, "looping");
  });
}

test("resolving one wait does not clear an unrelated pending approval", () => {
  const wait = { at: 1, kind: "wait", id: "one", reason: "user", status: "pending" };
  assert.equal(classifyTaskProgress([wait, { ...wait, at: 2, id: "two", reason: "approval" }, { ...wait, at: 3, status: "resolved" }], options).status, "waiting");
});

for (const status of ["failed", "permission-denied"]) {
  test(`repeated ${status} with explicitly no alternative is blocked`, () => {
    const records = repeated({ status, result: "denied", alternativeAvailable: false });
    assert.equal(classifyTaskProgress(records, options).status, "blocked");
    assert.equal(classifyTaskProgress([...records, artifact(4, "recovered")], options).status, "progressing");
    records.forEach(record => { record.call.alternativeAvailable = true; });
    assert.equal(classifyTaskProgress(records, options).status, "looping", "available alternatives cannot imply blocked");
  });
}

test("steady new artifacts over a long wall time are slow but progressing", () => {
  const records = [artifact(1000, "a"), artifact(1500, "b"), artifact(1900, "c")];
  const opts = { now: 2000, startedAt: 0, slowAfterMs: 1000, windowMs: 1100 };
  assert.equal(classifyTaskProgress(records, opts).status, "slow-but-progressing");
  assert.equal(classifyTaskProgress([artifact(1900, "a")], opts).status, "progressing");
  assert.equal(classifyTaskProgress(repeated(), { ...opts, windowMs: 3000 }).status, "looping");
});

test("only explicit completion can be complete; future completion is ignored", () => {
  assert.equal(classifyTaskProgress([...repeated(), { at: 4, kind: "complete" }], options).status, "complete");
  assert.equal(classifyTaskProgress([{ at: 101, kind: "complete" }], options).status, "unknown");
  assert.equal(classifyTaskProgress([], options).status, "unknown");
  assert.equal(classifyTaskProgress([{ at: 1, kind: "activity" }], options).status, "unknown");
  assert.equal(classifyTaskProgress([call(1, "finished")], options).status, "progressing", "a completed tool is not a completed task");
});

test("classification is deterministic, chronological, and does not mutate observations", () => {
  const records = [artifact(4, "new"), ...repeated()];
  const before = JSON.stringify(records);
  assert.deepEqual(classifyTaskProgress(records), classifyTaskProgress([...records].reverse()));
  assert.equal(JSON.stringify(records), before);
  for (const invalid of [{ now: NaN }, { windowMs: 0 }, { repeatThreshold: 1 }, { slowAfterMs: -1 }]) {
    assert.throws(() => classifyTaskProgress(records, invalid));
  }
});

const round = (roundId, usage) => ({ roundId, usage });
const worker = (workerId, rounds, children = []) => ({ workerId, rounds, children });
const plain = value => JSON.parse(JSON.stringify(value));

test("recursive quotas count own plus children once across duplicate child and grandchild reloads", () => {
  const grand = worker("grand", [round(0, { inputTokens: 5, activeMs: 20 })]);
  const child = worker("child", [round(0, { inputTokens: 10, activeMs: 30 })], [grand]);
  const root = worker("root", [round(0, { inputTokens: 100, activeMs: 100 })], [child, plain(child)]);
  const before = JSON.stringify(root);
  const total = aggregateWorkerQuotas(root);
  assert.deepEqual(plain(total.ownUsage), { inputTokens: 100, activeMs: 100 });
  assert.deepEqual(plain(total.totalUsage), { inputTokens: 115, activeMs: 150 });
  assert.equal(total.children.length, 1);
  assert.equal(total.children[0].children.length, 1);
  assert.equal(JSON.stringify(root), before);
});

test("round ids dedupe per worker; newer cumulative values replace rather than add, stale reloads cannot reduce them", () => {
  const root = worker("root", [round(0, { calls: 1 })], [
    worker("a", [round(0, { calls: 2 }), round("0", { calls: 3 }), round(1, { calls: 4 })]),
    worker("b", [round(0, { calls: 5 })]),
    worker("a", [round(0, { calls: 1 }), round(2, { calls: 6 })]),
  ]);
  const total = aggregateWorkerQuotas(root);
  assert.equal(total.totalUsage.calls, 19);
  assert.equal(total.children[0].roundCount, 3);
  assert.equal(total.children[0].ownUsage.calls, 13);
  assert.deepEqual(aggregateWorkerQuotas({ ...root, children: [...root.children].reverse() }), total);
});

test("quota aggregation rejects cycles, conflicting parents and invalid or unsafe quantities", () => {
  const root = worker("root", []); root.children.push(root);
  assert.throws(() => aggregateWorkerQuotas(root), /cyclic/);
  assert.throws(() => aggregateWorkerQuotas(worker("root", [], [worker("a", [], [worker("c", [])]), worker("b", [], [worker("c", [])])])), /parents/);
  for (const value of [-1, NaN, Infinity]) assert.throws(() => aggregateWorkerQuotas(worker("root", [round(0, { calls: value })])));
  assert.throws(() => aggregateWorkerQuotas(worker("root", [round(0, { calls: Number.MAX_SAFE_INTEGER }), round(1, { calls: 1 })])), /precision/);
});

test("phase deadlines independently report ok, warning and exceeded with remaining time", () => {
  const result = evaluateDeadlines({ foreground: 100, tool: { limitMs: 100, warningMs: 70 }, materialization: 100 },
    { foreground: { startedAt: 950 }, tool: { startedAt: 920 }, materialization: { startedAt: 890 } }, 1000);
  assert.equal(result.foreground.status, "ok"); assert.equal(result.foreground.remainingMs, 50);
  assert.equal(result.tool.status, "warning"); assert.equal(result.tool.remainingMs, 20);
  assert.equal(result.materialization.status, "exceeded"); assert.equal(result.materialization.remainingMs, -10);
  assert.equal(evaluateDeadlines({ foreground: 100 }, { foreground: { startedAt: 0 } }, 100).foreground.status, "exceeded");
});

test("deadlines exclude merged, clamped user/approval intervals, not external-job waits", () => {
  const result = evaluateDeadlines({ foreground: 100 }, { foreground: { startedAt: 100, waits: [
    { startedAt: 0, finishedAt: 120, reason: "user" },
    { startedAt: 130, finishedAt: 180, reason: "approval" },
    { startedAt: 140, finishedAt: 170, reason: "user" },
    { startedAt: 190, reason: "user" },
    { startedAt: 180, finishedAt: 190, reason: "external-job" },
    { startedAt: 400, reason: "approval" },
  ] } }, 300).foreground;
  assert.equal(result.activeMs, 20);
  assert.equal(result.excludedWaitMs, 180);
  assert.equal(result.remainingMs, 80);
  assert.equal(result.status, "ok");
});

test("open approval waits freeze deadlines even as wall time advances", () => {
  const timings = { foreground: { startedAt: 0, waits: [{ startedAt: 50, reason: "approval" }] } };
  for (const now of [100, 1000, 100000]) assert.equal(evaluateDeadlines({ foreground: 100 }, timings, now).foreground.activeMs, 50);
});

test("deadline accounting supports persisted invocation userWaitMs and finished phases", () => {
  const result = evaluateDeadlines({ tool: 100 }, { tool: { startedAt: 100, finishedAt: 1100, userWaitMs: 950 } }, 9000).tool;
  assert.equal(result.activeMs, 50); assert.equal(result.remainingMs, 50);
  const unfinished = evaluateDeadlines({}, { tool: { startedAt: 0 } }, 1000).tool;
  assert.equal(unfinished.remainingMs, undefined); assert.equal(unfinished.activeMs, 1000);
  assert.equal(evaluateDeadlines({ foreground: 100 }, {}, 1000).foreground.activeMs, undefined);
});

test("invalid deadline observations reject rather than inventing capacity", () => {
  assert.throws(() => evaluateDeadlines({ tool: 0 }, {}, 100));
  assert.throws(() => evaluateDeadlines({ tool: { limitMs: 10, warningMs: 20 } }, {}, 100));
  for (const timing of [
    { startedAt: NaN }, { startedAt: 10, finishedAt: 5 }, { startedAt: 0, userWaitMs: 200 },
    { startedAt: 0, userWaitMs: 0, waits: [] }, { startedAt: 0, waits: [{ startedAt: 50, finishedAt: 40, reason: "user" }] },
  ]) assert.throws(() => evaluateDeadlines({ tool: 100 }, { tool: timing }, 100));
});

test("Chat diagnostics expose the latest turn's progress class without paths or tool arguments", () => {
  const { apiChatDiagnostics } = require("../dist/chat/api-chat-store");
  const base = Date.now() - 10_000;
  const call = (id, at) => ({ id, name: "read_file", arguments: JSON.stringify({ path: "/secret/a.txt" }), status: "failed", result: "ENOENT", startedAt: base + at, finishedAt: base + at + 1 });
  const chat = { version: 1, id: "c", messages: [{ id: "u", role: "user", content: "x", status: "complete" },
    { id: "a", role: "assistant", content: "", status: "streaming", progress: { startedAt: base + 1000, status: "running", steps: [] },
      toolCalls: [call("1", 1000), call("2", 2000), call("3", 3000)] }], progress: { startedAt: base + 1000, status: "running", steps: [{ at: base + 3001, status: "active", label: "Generating response" }] } };
  const packet = apiChatDiagnostics(chat);
  assert.equal(packet.turnProgress.status, "looping");
  assert.equal(packet.turnProgress.messageId, "a");
  assert.doesNotMatch(JSON.stringify(packet.turnProgress), /secret|read_file/);
  chat.messages[1] = { ...chat.messages[1], status: "complete", progress: { startedAt: base + 1000, finishedAt: base + 4000, status: "complete", steps: [] } };
  assert.equal(apiChatDiagnostics(chat).turnProgress.status, "complete");
  chat.messages[1] = { ...chat.messages[1], status: "streaming", toolCalls: [] };
  chat.progress = { startedAt: base + 1000, status: "running", steps: [{ at: base + 5000, status: "waiting", label: "Waiting for approval" }] };
  assert.equal(apiChatDiagnostics(chat).turnProgress.status, "waiting");
});
