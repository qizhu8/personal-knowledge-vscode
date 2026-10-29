#!/usr/bin/env node
/**
 * Release gate: build once, run independent test groups in parallel, then package and verify the VSIX.
 * Each group keeps its own commands serial; output is buffered per group so failures stay readable.
 */
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;
const python = process.env.PYTHON || "python";

const groups = {
  "action-builtins": [[python, "-B", "tests/test-action-builtins.py"]],
  "action-component-languages": [[python, "-B", "tests/test-action-component-languages.py"]],
  "action-authoring": [[python, "-B", "tests/test-action-authoring.py"]],
  "action-monitoring": [[python, "-B", "tests/test-action-monitoring.py"]],
  "action-library": [[python, "-B", "tests/test-action-library.py",
    "LibraryTests.test_host_trust_buttons_request_native_review_without_automatic_execution",
    "LibraryTests.test_unverified_drag_highlights_flask_and_validation_reports_outcomes_without_browser_confirm",
    "LibraryTests.test_pending_actions_are_visible_in_tree_with_validation_guidance_and_exact_proposal"]],
  "action-browser": [[node, "tests/test-action-browser.js"]],
  "portal-lifecycle": [[node, "--test", "--test-concurrency=2", "tests/test-peer-collaboration.js", "tests/test-portal-direct-command.js", "tests/test-portal-command-activity.js", "tests/test-portal-files.js", "tests/test-chat-portal.js", "tests/test-portal-attempts.js", "tests/test-portal-duplex.js", "tests/test-portal-endpoint-store.js"], [python, "-B", "tests/test-api-chat-control.py"]],
  "chat-accounting": [[node, "scripts/run-memory-engine-tests.js"]],
  "chat-retrieval": [[node, "--test", "tests/test-chat-retrieval-integration.js", "tests/test-chat-online-learning.js", "tests/test-knowledge-source-ranges.js", "tests/test-chat-work-goal.js",
    "tests/test-api-chat.js", "tests/test-copilot-sdk-responsiveness.js", "tests/test-chat-activity-browser.js"]],
  "stability": [[node, "--test", "tests/test-mcp-lifecycle.js", "tests/test-chat-managed-mcp.js", "tests/test-sync-drain-barrier.js",
    "tests/test-mcp-warning-boundary.js", "tests/test-pkm-service-compatibility.js"],
    [node, "tests/test-mcp-version-ui.js"], [python, "-B", "tests/test-mcp-lifecycle.py"]],
  "retrieval-setup": [[node, "--test", "tests/test-retrieval-model-setup.js", "tests/test-retrieval-materialization.js"], [python, "-B", "tests/test-retrieval-default-model.py"], [python, "-B", "tests/test-retrieval-learning.py"],
    [node, "tests/test-skill-router-ui.js"], [node, "tests/test-retrieval-solutions-browser.js"]],
  "core-and-sync": [[node, "tests/test-pkm-p0.js"], [node, "tests/test-github-sync-remote-authority.js"], [node, "tests/test-github-sync-ui.js"],
    [node, "--test", "tests/test-github-sync-scheduler.js", "tests/test-github-sync-coordinator.js",
      "tests/test-github-sync-feedback.js", "tests/test-github-sync-recovery.js", "tests/test-pkm-service-integration.js"]],
  "portal-and-chat-units": [[node, "--test", "--test-concurrency=2", "tests/test-github-sync-intent-admission.js", "tests/test-portal-transport.js",
    "tests/test-chat-portal.js", "tests/test-portal-native-interaction.js", "tests/test-portal-profile-wiring.js", "tests/test-portal-permissions.js",
    "tests/test-portal-files.js", "tests/test-portal-resume.js", "tests/test-chat-stored-rooms-ui.js", "tests/test-portal-connections.js", "tests/test-portal-connections-browser.js",
    "tests/test-github-sync-credentials.js", "tests/test-retained-jsonl-log.js", "tests/test-chat-context-contracts.js", "tests/test-chat-workers.js",
    "tests/test-chat-history-storage.js", "tests/test-chat-process-runtime.js", "tests/test-chat-process-tools.js", "tests/test-chat-budget-ledger.js",
    "tests/test-chat-transport-receipts.js", "tests/test-chat-harness-records.js"]],
  "mcp-and-webview": [[node, "tests/test-mcp-stdio-smoke.js"], [node, "tests/test-native-mcp-remote-location.js"],
    [node, "tests/test-webview-restoration.js"], [node, "tests/test-ui-build-artifacts.js"], [node, "tests/test-browser-markdown-preview.js"]],
};

function run(command, args, capture) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: root, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", windowsHide: true });
    let output = "";
    if (capture) {
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
    }
    child.on("error", error => resolve({ code: 1, output: output + String(error) }));
    child.on("close", code => resolve({ code: code ?? 1, output }));
  });
}

async function runGroup(name, commands) {
  const started = Date.now();
  let log = "";
  for (const [command, ...args] of commands) {
    log += `$ ${[path.basename(command), ...args].join(" ")}\n`;
    const result = await run(command, args, true);
    log += result.output;
    if (result.code !== 0) return { name, ok: false, seconds: (Date.now() - started) / 1000, log };
  }
  return { name, ok: true, seconds: (Date.now() - started) / 1000, log };
}

async function parallel(entries, limit) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < entries.length) {
      const [name, commands] = entries[next++];
      const result = await runGroup(name, commands);
      console.log(`${result.ok ? "PASS" : "FAIL"} ${name} (${result.seconds.toFixed(1)}s)`);
      results.push(result);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, worker));
  return results;
}

async function main() {
  const started = Date.now();
  const selected = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
  const unknown = selected.filter(name => !groups[name]);
  if (unknown.length) throw new Error(`Unknown gate group(s): ${unknown.join(", ")}. Known: ${Object.keys(groups).join(", ")}`);
  const skipPackage = process.argv.includes("--no-package") || selected.length > 0;
  if ((await run(npm, ["run", "build"], false)).code !== 0) process.exit(1);
  const limit = Math.max(1, Number(process.env.PKM_GATE_CONCURRENCY) || Math.min(os.cpus().length, Object.keys(groups).length));
  const entries = Object.entries(groups).filter(([name]) => !selected.length || selected.includes(name));
  console.log(`Running ${entries.length} test groups with concurrency ${limit}...`);
  const results = await parallel(entries, limit);
  const failed = results.filter(result => !result.ok);
  for (const result of failed) console.error(`\n===== ${result.name} failed =====\n${result.log}`);
  if (failed.length) {
    console.error(`\n${failed.length} test group(s) failed: ${failed.map(result => result.name).join(", ")}`);
    process.exit(1);
  }
  if (!skipPackage && (await run(node, [path.join(__dirname, "package-extension.js"), "--prebuilt"], false)).code !== 0) process.exit(1);
  console.log(`Package gate passed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch(error => { console.error(error); process.exit(1); });
