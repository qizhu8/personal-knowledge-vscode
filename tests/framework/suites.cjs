"use strict";

const fs = require("node:fs");
const path = require("node:path");

const GROUPS = {
  integration: ["test:chat-context", "test:module-contracts", "test:knowledge-contracts", "test:workflow-contracts",
    "test:memory-engine", "test:smoke"],
  browser: ["test:chat-report-ui", "test:browser:full"],
  e2e: ["test:startup", "test:release"],
};
const FRAMEWORK_SCRIPTS = new Set(["test", "test:list", "test:framework", "test:qualification"]);

function suitesFor(repositoryRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  const suites = [{
    name: "framework", group: "unit", timeoutMs: 120000,
    command: [process.execPath, "--test", "--test-concurrency=2", "tests/framework/framework.test.cjs"],
  }];
  if (fs.existsSync(path.join(repositoryRoot, "tests/test-version-order.js"))) suites.push({
    name: "core-unit", group: "unit", timeoutMs: 60000,
    requires: ["dist/runtime/version-order.js", "dist/knowledge/text-format.js"],
    command: [process.execPath, "--test", "--test-concurrency=2", "tests/test-version-order.js", "tests/test-text-format.js"],
  });
  else if (fs.existsSync(path.join(repositoryRoot, "tests/markdown.test.mjs"))) suites.push({
    name: "core-unit", group: "unit", timeoutMs: 120000, requires: ["dist/storage.js", "dist/markdown.js"],
    command: [process.execPath, "--experimental-transform-types", "--test", "--test-concurrency=2", "tests/markdown.test.mjs"],
  });
  for (const name of Object.keys(manifest.scripts || {}).sort()) {
    if (!name.startsWith("test:") || FRAMEWORK_SCRIPTS.has(name)) continue;
    const group = Object.keys(GROUPS).find(key => GROUPS[key].includes(name)) || "legacy";
    suites.push({ name, group, timeoutMs: 30 * 60 * 1000, command: ["npm", "run", name] });
  }
  return suites;
}

function fileSuite(repositoryRoot, filename) {
  const absolute = path.resolve(repositoryRoot, filename);
  const relative = path.relative(path.join(repositoryRoot, "tests"), absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || !fs.existsSync(absolute) || !/^(?:test[-_].*|.*\.test)\.(?:js|cjs|mjs|py)$/.test(path.basename(absolute)))
    throw new Error("Select an existing test file inside tests/, not a fixture or controller.");
  const target = path.relative(repositoryRoot, absolute);
  return {
    name: target, group: "selected", timeoutMs: 15 * 60 * 1000,
    command: absolute.endsWith(".py")
      ? [process.env.PKM_TEST_PYTHON || process.env.PYTHON || "python3", "-B", target]
      : [process.execPath, ...(absolute.endsWith(".mjs") ? ["--experimental-transform-types"] : []),
        "--test", "--test-concurrency=2", target],
  };
}

module.exports = { suitesFor, fileSuite };
