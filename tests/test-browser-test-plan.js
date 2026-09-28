#!/usr/bin/env node
const assert = require("assert");
const { selectTasks } = require("../scripts/run-browser-test-plan");

assert.deepStrictEqual(
  selectTasks("smoke", {}).map(task => ({ name: task.name, env: task.env })),
  [
    { name: "panel", env: {} },
    { name: "startup", env: { PKM_STARTUP_ONLY: "clean-install" } },
  ],
);

assert.deepStrictEqual(
  selectTasks("full", {}).map(task => task.name),
  ["plan", "contract", "standalone", "panel", "startup"],
);

assert.deepStrictEqual(
  selectTasks("targeted", { PKM_BROWSER_SUITES: "panel,startup,panel" }).map(task => task.name),
  ["panel", "startup"],
);

assert.deepStrictEqual(
  selectTasks("full", { PKM_BROWSER_SHARD_COUNT: "2", PKM_BROWSER_SHARD_INDEX: "2" }).map(task => task.name),
  ["contract", "panel"],
);

assert.throws(
  () => selectTasks("targeted", {}),
  /PKM_BROWSER_SUITES is required/,
);
assert.throws(
  () => selectTasks("targeted", { PKM_BROWSER_SUITES: "missing" }),
  /Unknown browser suites: missing/,
);
assert.throws(
  () => selectTasks("full", { PKM_BROWSER_SHARD_COUNT: "2", PKM_BROWSER_SHARD_INDEX: "3" }),
  /cannot exceed/,
);

console.log("Browser test plan contracts passed");
