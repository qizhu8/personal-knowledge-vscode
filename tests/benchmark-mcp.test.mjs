import test from "node:test";
import assert from "node:assert/strict";
import { aggregate, equivalent, pairedSummary, resourceDelta, unwrap } from "../scripts/benchmark-mcp.mjs";

test("nearest-rank aggregation preserves tails and rejects fast failures", () => {
  const samples = Array.from({ length: 30 }, (_, i) => ({ ms: i + 1 }));
  assert.deepEqual(aggregate(samples), { n: 30, p50Ms: 15, p95Ms: 29, minMs: 1, maxMs: 30, madMs: 7 });
  assert.throws(() => aggregate([...samples, { ms: 0, error: "timeout" }]));
  assert.throws(() => unwrap({ isError: true, content: [{ type: "text", text: "{}" }] }));
});
test("ratios pair by explicit identity rather than run order or pooled requests", () => {
  const runs = [{ pairId: "a", variant: "old", order: 0, ms: 10 },
    { pairId: "b", variant: "new", order: 0, ms: 8 },
    { pairId: "a", variant: "new", order: 1, ms: 20 },
    { pairId: "b", variant: "old", order: 1, ms: 16 }];
  const summary = pairedSummary(runs, r => r.ms);
  assert.deepEqual(summary.pairs.map(p => [p.order, p.newOverOld]), [["AB", 2], ["BA", 0.5]]);
  assert.equal(summary.nPairs, 2);
  assert.equal(summary.minChangePercent, -50);
  assert.equal(summary.maxChangePercent, 100);
  assert.throws(() => pairedSummary(runs.slice(0, 3), r => r.ms), /Incomplete/);
});
test("equivalence rejects incomplete pagination, wrong search hits, and changed bodies", () => {
  const row = { slug: "one", title: "One" };
  const fixture = { ...row, body: "Same body", all: [row], one: [row], ten: [row] };
  assert.equal(equivalent("list_notes", { items: [row], total: 1, next_offset: null }, fixture).count, 1);
  assert.throws(() => equivalent("list_notes", { items: [], total: 1, next_offset: 1 }, fixture));
  assert.throws(() => equivalent("list_notes", { items: [row], total: 1, next_offset: 1 }, fixture));
  assert.throws(() => equivalent("search_one", [{ slug: "wrong", title: "One" }], fixture));
  assert.throws(() => equivalent("get_note", { ...row, content: "Changed" }, fixture));
});
test("resource deltas exclude recycled PIDs and expose short-lived-child limitation", () => {
  const before = { elapsedMs: 0, processes: [{ pid: 1, startTicks: "a", cpuTicks: 10, io: { read_bytes: 20 } },
    { pid: 2, startTicks: "b", cpuTicks: 100 }] };
  const after = { elapsedMs: 3000, processes: [{ pid: 1, startTicks: "a", cpuTicks: 12, io: { read_bytes: 25 } },
    { pid: 2, startTicks: "c", cpuTicks: 500 }] };
  const delta = resourceDelta(before, after, 100);
  assert.equal(delta.cpuMs, 20);
  assert.equal(delta.io.read_bytes, 5);
  assert.deepEqual(delta.matched, ["1:a"]);
  assert.equal(delta.excludesExitedBeforeEndpoint, true);
});
