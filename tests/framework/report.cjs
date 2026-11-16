"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomUUID } = require("node:crypto");
const { outsideCheckout } = require("./workspace.cjs");

const LIMIT = 64 * 1024;
const CODES = { passed: "p", failed: "f", blocked: "b", cancelled: "c", timed_out: "t", cleanup_error: "e" };
const reference = name => createHash("sha256").update(name).digest("hex");

function summarize(plan, results, durationMs, retainedWorkspace) {
  const counts = Object.fromEntries(Object.keys(CODES).map(key => [key, 0]));
  for (const result of results) {
    if (!Object.hasOwn(counts, result.outcome)) throw new Error(`Unknown test outcome: ${result.outcome}`);
    counts[result.outcome]++;
  }
  return {
    schema: "pkm.test-run/v1", profile: plan.profile, catalogFingerprint: plan.fingerprint,
    completedAt: new Date().toISOString(),
    scope: "isolated fixture regression; not production/native-upgrade qualification",
    ...(plan.selectionPolicy ? { selectionPolicy: plan.selectionPolicy } : {}),
    successful: results.length === plan.entries.length && counts.passed === results.length && !retainedWorkspace,
    selected: plan.entries.length, counts, durationMs, retainedWorkspace: retainedWorkspace || null,
  };
}

function encodeFailure(summary, results) {
  const failed = results.map((result, index) => ({ result, index })).filter(item => item.result.outcome !== "passed");
  const report = {
    ...summary, taskReferences: results.map(result => reference(result.suite)),
    outcomes: results.map(result => CODES[result.outcome]).join(""),
    details: failed.slice(0, 8).map(({ result, index }) => ({
      index, name: result.suite, error: (result.error || result.cleanupError || "").slice(0, 2048),
      tapFailures: (result.tapFailures || "").slice(0, 4096),
      stdout: (result.stdout || "").slice(-4096), stderr: (result.stderr || "").slice(-4096),
    })),
    omittedDetails: Math.max(0, failed.length - 8),
  };
  let text = JSON.stringify(report, null, 2) + "\n";
  while (Buffer.byteLength(text) > LIMIT && report.details.length) {
    const detail = report.details[report.details.length - 1];
    if (detail.stdout || detail.stderr) {
      detail.stdout = ""; detail.stderr = "";
    } else {
      report.details.pop();
      report.omittedDetails++;
    }
    text = JSON.stringify(report, null, 2) + "\n";
  }
  if (Buffer.byteLength(text) > LIMIT) throw new Error("Run identity metadata exceeds the 64 KiB report budget.");
  return text;
}

function writeRunFailure(repositoryRoot, summary, results, reportDirectory) {
  const id = createHash("sha256").update(fs.realpathSync(repositoryRoot)).digest("hex").slice(0, 12);
  const directory = path.resolve(reportDirectory || process.env.PKM_TEST_REPORTS || path.join(os.homedir(), ".cache", "pkm-tests", id));
  let ancestor = directory;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  outsideCheckout(repositoryRoot, ancestor);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  outsideCheckout(repositoryRoot, directory);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
    throw new Error("Failure reports require an owned non-symlink directory.");
  const temporary = path.join(directory, `report-${randomUUID()}.tmp`);
  const destination = path.join(directory, "last-failure.json");
  try {
    fs.writeFileSync(temporary, encodeFailure(summary, results), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return destination;
}

module.exports = { summarize, encodeFailure, writeRunFailure, reference };
