#!/usr/bin/env node
const assert = require("assert");
const { compareVersionOrder } = require("../dist/version-order.js");

assert.strictEqual(compareVersionOrder("2.7.10", "2.7.9"), 1, "semantic versions must not be compared as decimals");
assert.strictEqual(compareVersionOrder("2.7.9", "2.7.10"), -1);
assert.strictEqual(compareVersionOrder("2.8.0", "2.7.99"), 1);
assert.strictEqual(compareVersionOrder("v2.8.1", "2.8.1"), 0);
assert.strictEqual(compareVersionOrder("2.8.1-rc.1", "2.8.1"), -1);
assert.strictEqual(compareVersionOrder("2.8.1-rc.2", "2.8.1-rc.1"), 1);
assert.strictEqual(compareVersionOrder("legacy", "2.8.1"), undefined);
console.log("version order test: numeric SemVer ordering and prerelease precedence OK");
