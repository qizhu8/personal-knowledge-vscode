import test from "node:test";
import assert from "node:assert/strict";
import { aggregate, comparisonValue, equivalent, pairedSummary, resourceDelta, unwrap, validateResourceAudit } from "../scripts/benchmark-mcp.mjs";

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

test("approved comparison reorders only qualified exact-rank ties and retains every result field", () => {
  const first = { slug: "first", title: "First", type: "general" };
  const a = { slug: "a", title: "A", type: "general" }, b = { slug: "b", title: "B", type: "general" };
  const rows = [first, b, a];
  const fixture = { searchTenRankGroups: { schema: "pkm.benchmark-exact-fts-rank-groups/v1",
    groups: [{ rankHex: "-0x1p+1", slugs: ["first"] }, { rankHex: "-0x1p+0", slugs: ["a", "b"] }] } };
  assert.equal(comparisonValue("search_ten", rows, fixture), rows);
  assert.equal(comparisonValue("search_one", rows, fixture, true), rows);
  const normalized = comparisonValue("search_ten", rows, fixture, true);
  assert.deepEqual(normalized, [first, a, b]);
  assert.equal(normalized[1], a);
  assert.deepEqual(rows, [first, b, a]);
  assert.throws(() => comparisonValue("search_ten", rows, fixture, true, "new"), /stable path order/);
  assert.deepEqual(comparisonValue("search_ten", normalized, fixture, true, "new"), normalized);
  assert.throws(() => comparisonValue("search_ten", [a, first, b], fixture, true), /rank boundary/);
  assert.throws(() => comparisonValue("search_ten", [first, a, a], fixture, true), /membership/);
  assert.throws(() => comparisonValue("search_ten", [...rows, a], fixture, true), /extra search rows/);
  assert.throws(() => comparisonValue("search_ten", rows, {}, true), /Missing exact-rank/);
  const changed = comparisonValue("search_ten", [first, b, { ...a, type: "changed" }], fixture, true);
  assert.notDeepEqual(changed, normalized);
});

test("resource audit retains the immutable baseline and binds a new VSIX to every factory input", () => {
  const baseline = "c8486a6eac170d88b1dea0ac09433de1589424aca3bd5007f532780453a57df8";
  const factorySha256 = "a".repeat(64), nextVsix = "b".repeat(64);
  const dependencies = Object.fromEntries(["managed-migration.mjs", "managed-launch-client.mjs", "managed-launcher.py",
    "python-bootstrap.py", "python-dependencies.py"].map(name => [name, factorySha256]));
  const original = { schema: "pkm.no-tracking-independent-resource-acceptance/v1",
    passed: true, vsixSha256: baseline, factorySha256 };
  validateResourceAudit(original, { vsixSha256: baseline, factorySha256, dependencies });
  const next = { ...original, schema: "pkm.no-tracking-independent-resource-acceptance/v2",
    vsixSha256: nextVsix, factoryDependencies: dependencies };
  validateResourceAudit(next, { vsixSha256: nextVsix, factorySha256, dependencies });
  assert.throws(() => validateResourceAudit({ ...original, vsixSha256: nextVsix },
    { vsixSha256: nextVsix, factorySha256, dependencies }), /requires a v2/);
  assert.throws(() => validateResourceAudit(next, { vsixSha256: baseline, factorySha256, dependencies }), /VSIX must match/);
  assert.throws(() => validateResourceAudit(next, { vsixSha256: nextVsix, factorySha256,
    dependencies: { ...dependencies, "managed-launcher.py": "c".repeat(64) } }), /Factory dependencies must match/);
});

test("resource audit rejects failed, malformed, incomplete or mismatched provisioning evidence", () => {
  const hash = "a".repeat(64);
  const dependencies = Object.fromEntries(["managed-migration.mjs", "managed-launch-client.mjs", "managed-launcher.py",
    "python-bootstrap.py", "python-dependencies.py"].map(name => [name, hash]));
  const input = { vsixSha256: hash, factorySha256: hash, dependencies };
  const audit = { schema: "pkm.no-tracking-independent-resource-acceptance/v2",
    passed: true, vsixSha256: hash, factorySha256: hash, factoryDependencies: dependencies };
  for (const rejected of [null, { ...audit, schema: "unverified" }, { ...audit, passed: false },
    { ...audit, factorySha256: "b".repeat(64) }, { ...audit, factoryDependencies: undefined }])
    assert.throws(() => validateResourceAudit(rejected, input));
  assert.throws(() => validateResourceAudit(audit, { ...input, dependencies: { "managed-migration.mjs": hash } }), /Incomplete/);
  assert.throws(() => validateResourceAudit(audit, { ...input, factorySha256: "invalid" }), /Invalid/);
  assert.throws(() => validateResourceAudit(audit, { ...input, dependencies: { ...dependencies, "managed-migration.mjs": "b".repeat(64) } }),
    /Factory dependency digest disagrees/);
});
