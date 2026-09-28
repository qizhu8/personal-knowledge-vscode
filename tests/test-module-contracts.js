#!/usr/bin/env node
const assert = require("assert");
const {
  MODULE_USAGE_SCHEMA,
  compileModuleUsageEventV1,
  summarizeModuleUsage,
} = require("../dist/module-contracts.js");

const measured = {
  schema: MODULE_USAGE_SCHEMA,
  eventId: "usage_measured_1",
  sourceModule: "recipe-runtime",
  occurredAt: "2026-09-28T02:00:00.000Z",
  attribution: {
    recipeRunId: "recipe_run_alpha",
    nodeId: "implement",
    attemptId: "attempt_1",
  },
  measurement: {
    kind: "measured",
    provider: "openai-compatible",
    model: "model-a",
    inputTokens: 120,
    outputTokens: 30,
    cachedInputTokens: 20,
    reasoningTokens: 5,
    totalTokens: 150,
  },
  derivedCost: {
    currency: "USD",
    amountMicros: 250,
    priceVersion: "2026-09-01",
  },
};

const compiled = compileModuleUsageEventV1(measured);
assert.strictEqual(compiled.ok, true);
assert.strictEqual(compiled.model.measurement.kind, "measured");
assert.strictEqual(compiled.digest.length, 64);
assert.strictEqual(JSON.parse(compiled.canonicalBytes.toString("utf8")).eventId, measured.eventId);

const estimated = compileModuleUsageEventV1({
  ...measured,
  eventId: "usage_estimated_1",
  derivedCost: undefined,
  measurement: {
    kind: "estimated",
    estimator: "cl100k-compatible",
    estimatorVersion: "1",
    confidence: "medium",
    estimatedTokens: 90,
  },
});
assert.strictEqual(estimated.ok, true);

const unknown = compileModuleUsageEventV1({
  ...measured,
  eventId: "usage_unknown_1",
  derivedCost: undefined,
  measurement: {
    kind: "unknown",
    reason: "host-not-reported",
    modelCalls: 2,
  },
});
assert.strictEqual(unknown.ok, true);

const summary = summarizeModuleUsage([compiled.model, compiled.model, estimated.model, unknown.model]);
assert.deepStrictEqual(summary, {
  events: 3,
  measuredEvents: 1,
  estimatedEvents: 1,
  unknownEvents: 1,
  measuredInputTokens: 120,
  measuredOutputTokens: 30,
  measuredTotalTokens: 150,
  estimatedTokens: 90,
  unknownModelCalls: 2,
  derivedCostMicros: { USD: 250 },
});

const invalidCached = compileModuleUsageEventV1({
  ...measured,
  measurement: { ...measured.measurement, cachedInputTokens: 121 },
});
assert.strictEqual(invalidCached.ok, false);
assert(invalidCached.diagnostics.some(item => item.code === "cached-input-range"));

const invalidEstimate = compileModuleUsageEventV1({
  ...measured,
  measurement: { kind: "estimated", estimator: "", estimatorVersion: "1", confidence: "certain", estimatedTokens: -1 },
});
assert.strictEqual(invalidEstimate.ok, false);
assert.deepStrictEqual(
  invalidEstimate.diagnostics.map(item => item.code).sort(),
  ["confidence", "non-negative-integer", "text"]
);

const invalidUnknown = compileModuleUsageEventV1({
  ...measured,
  measurement: { kind: "unknown", reason: "not-sure", modelCalls: 1 },
});
assert.strictEqual(invalidUnknown.ok, false);
assert(invalidUnknown.diagnostics.some(item => item.code === "unknown-reason"));

const unknownField = compileModuleUsageEventV1({ ...measured, tokenGuess: 123 });
assert.strictEqual(unknownField.ok, false);
assert(unknownField.diagnostics.some(item => item.pointer === "/tokenGuess"));

console.log("Module usage contracts: measured, estimated, unknown, cost, dedupe, and validation OK");
