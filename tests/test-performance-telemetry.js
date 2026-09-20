#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { recordPerformanceMetric, performanceSummary } = require('../dist/performance-telemetry.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkm-performance-'));
try {
  for (let value = 1; value <= 250; value++) recordPerformanceMetric(root, 'startup.activation_ms', value, 10);
  recordPerformanceMetric(root, 'invalid metric with path /secret', 1);
  const summary = performanceSummary(root);
  assert.strictEqual(summary['startup.activation_ms'].samples, 200);
  assert.strictEqual(summary['startup.activation_ms'].latest, 250);
  assert.strictEqual(summary['startup.activation_ms'].p50, 150);
  assert.strictEqual(summary['startup.activation_ms'].p95, 240);
  assert.strictEqual(summary['invalid metric with path /secret'], undefined);
  const raw = fs.readFileSync(path.join(root, 'metrics.json'), 'utf8');
  assert.doesNotMatch(raw, /path|query|content|secret/i);
  console.log('performance telemetry test: bounded privacy-safe samples and p50/p95 summaries OK');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
