#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "publish-marketplace.yml"), "utf8");
const scripts = require("../package.json").scripts;

assert(workflow.includes("run: npm run test:release"), "Marketplace must execute the release lifecycle, including its prerequisite gate");
for (const name of ["pretest:release", "package"]) {
  const steps = scripts[name].split(" && ");
  const accounting = steps.indexOf("npm run test:chat-accounting:run");
  assert(accounting > steps.indexOf("npm run build") && accounting >= 0,
    `${name} must run accounting against a complete build`);
  const boundary = steps.findIndex(step => /verify-version-bump|package-extension/.test(step));
  assert(accounting < boundary, `${name} must fail closed on accounting before version/publication or packaging`);
  const retrieval = steps.indexOf("npm run test:chat-retrieval:run");
  assert(retrieval > accounting && retrieval < boundary, `${name} must require retrieval and checkpoint regressions after accounting and before packaging`);
}
for (const file of ["test-chat-retrieval-integration.js", "test-chat-context-contracts.js", "test-chat-work-goal.js",
  "test-chat-harness-records.js", "test-api-chat.js", "test-chat-activity-browser.js"]) {
  assert(scripts["test:chat-retrieval:run"].includes(`tests/${file}`), `mandatory retrieval gate must retain ${file}`);
}
assert(scripts["test:chat-context"].includes("tests/test-chat-retrieval-integration.js"));
assert.equal(scripts["test:chat-accounting:run"],
  "node --test tests/test-chat-budget-ledger.js && node scripts/run-memory-engine-tests.js",
  "the shared mandatory gate must execute Credit ledger and nested Memory accounting without rebuilding bundles");
const memoryRunner = fs.readFileSync(path.join(__dirname, "..", "scripts", "run-memory-engine-tests.js"), "utf8");
for (const required of ['"discover"', '"test-memory-engine-client.js"', '"test-chat-memory-service.js"', '"test-memory-accounting.js"']) {
  assert(memoryRunner.includes(required), `mandatory Memory accounting runner must retain ${required}`);
}

for (const action of ["actions/checkout@v7", "actions/setup-node@v7", "actions/setup-python@v7", "azure/login@v3"]) {
  assert(workflow.includes(`uses: ${action}`), `release workflow must use ${action}`);
}
assert(!workflow.includes("azure/login@v2"), "release workflow must not regress to the Node 20 Azure Login action");
assert(workflow.includes('"fastmcp>=2.0.0,<4.0.0"'),
  "release validation must exclude incompatible FastMCP major versions");
assert(workflow.includes('"playwright>=1.47.0,<2.0.0"'),
  "release validation must install the Python Playwright dependency used by browser tests");
assert(workflow.includes("python -m playwright install --with-deps chromium"),
  "release validation must install Chromium and its runner dependencies");
assert(workflow.includes("PKM_STARTUP_SCENARIO_BUDGET_MS: 20000"),
  "release validation must allow bounded cold-runner startup overhead");

const packageStep = workflow.indexOf("- name: Package VSIX");
const verifyStep = workflow.indexOf("- name: Verify VSIX metadata and boundaries");
const publishStep = workflow.indexOf("- name: Publish with Microsoft Entra ID");
assert(packageStep >= 0 && packageStep < verifyStep && verifyStep < publishStep,
  "release workflow must package and verify the VSIX before publishing");

console.log("Release workflow test: supported action majors and package/verify/publish order OK");