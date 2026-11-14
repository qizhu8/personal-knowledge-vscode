#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { suitesFor, fileSuite } = require("./suites.cjs");
const { executeSuite } = require("./workspace.cjs");

async function main(arguments_) {
  const repositoryRoot = path.resolve(__dirname, "../..");
  const catalog = suitesFor(repositoryRoot);
  let group, timeoutMs, list = false;
  const selected = [];
  for (let index = 0; index < arguments_.length; index++) {
    const flag = arguments_[index];
    if (flag === "--list") { list = true; continue; }
    if (!["--suite", "--group", "--file", "--timeout"].includes(flag) || !arguments_[index + 1])
      throw new Error("Usage: npm test -- [--list | --group NAME | --suite NAME | --file tests/test-name.js] [--timeout SECONDS]");
    const value = arguments_[++index];
    if (flag === "--group") {
      if (group || selected.length) throw new Error("Choose one group or explicit suites/files, not both.");
      group = value;
    } else if (flag === "--timeout") {
      if (!/^[1-9]\d*$/.test(value) || Number(value) > 3600) throw new Error("Timeout must be 1-3600 seconds.");
      timeoutMs = Number(value) * 1000;
    } else {
      if (group) throw new Error("Choose one group or explicit suites/files, not both.");
      const suite = flag === "--file" ? fileSuite(repositoryRoot, value) : catalog.find(item => item.name === value);
      if (!suite) throw new Error(`Unknown test suite: ${value}. Use npm run test:list.`);
      if (!selected.some(item => item.name === suite.name)) selected.push(suite);
    }
  }
  if (list) {
    if (group || selected.length || timeoutMs) throw new Error("--list cannot be combined with run selectors.");
    for (const suite of catalog) console.log(`${suite.group.padEnd(12)} ${suite.name}`);
    return;
  }
  const suites = selected.length ? selected : catalog.filter(suite => suite.group === (group || "unit"));
  if (!suites.length) throw new Error(`Unknown or empty test group: ${group}.`);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let failures = 0;
  try {
    for (const suite of suites) {
      if (controller.signal.aborted) break;
      console.log(`RUN ${suite.name} (${suite.group})`);
      const result = await executeSuite(suite, { repositoryRoot, timeoutMs, signal: controller.signal });
      console.log(`${result.status.toUpperCase()} ${suite.name} ${result.durationMs}ms; workspace ${result.cleaned ? "removed" : "RETAINED"}`);
      if (result.status !== "passed") {
        failures++;
        console.error(result.error || result.cleanupError);
        if (result.stdout) console.error(result.stdout);
        if (result.stderr) console.error(result.stderr);
        if (result.cleanupError) console.error(`Cleanup failed: ${result.cleanupError}; retained ${result.workspace}`);
        console.error(`Bounded failure summary: ${result.report}`);
      }
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  console.log("Scope: isolated fixture regressions only; no production/native-upgrade qualification.");
  if (failures || controller.signal.aborted) process.exitCode = 1;
}

module.exports = { main };
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
