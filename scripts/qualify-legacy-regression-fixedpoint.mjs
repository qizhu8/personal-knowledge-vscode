import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { packageRoot } from "./migration.mjs";

const reports = [
  "tests/legacy-regression-oracle.report.json",
  "tests/legacy-regression-batch12.report.json",
  "tests/legacy-read-race.report.json",
];
const orderedFiles = [
  "tests/legacy-regression-oracle.test.mjs",
  "tests/legacy-regression-batch12.test.mjs",
  "tests/legacy-read-race.test.mjs",
];
const concurrentFiles = orderedFiles;
const sha256 = value => createHash("sha256").update(value).digest("hex");

function runTest(file) {
  const result = spawnSync(process.execPath, [
    "--test", "--test-concurrency=4", file,
  ], {
    cwd: packageRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error([
      `Source-bound qualification failed: ${file}`,
      result.error?.stack,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
}

function runConcurrent() {
  const command = ["--test", "--test-concurrency=4", ...concurrentFiles];
  const result = spawnSync(process.execPath, command, {
    cwd: packageRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error([
      `Concurrent source-bound qualification failed: node ${command.join(" ")}`,
      result.error?.stack,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  const tests = Number(result.stdout.match(/^# tests (\d+)$/m)?.[1]);
  const passed = Number(result.stdout.match(/^# pass (\d+)$/m)?.[1]);
  const failed = Number(result.stdout.match(/^# fail (\d+)$/m)?.[1]);
  assert(Number.isSafeInteger(tests) && Number.isSafeInteger(passed) && Number.isSafeInteger(failed),
    "Concurrent runner must report exact TAP test counts.");
  assert.equal(failed, 0, "Concurrent qualification must have no failed tests.");
  return { command: `node ${command.join(" ")}`, tests, passed, failed };
}

async function reportBytes() {
  return Promise.all(reports.map(path => readFile(resolve(packageRoot, path))));
}

for (const file of orderedFiles) runTest(file);
const orderedBytes = await reportBytes();
const firstConcurrentRun = runConcurrent();
const firstConcurrentBytes = await reportBytes();
assert.deepEqual(firstConcurrentBytes, orderedBytes, "Concurrent run 1 must preserve the ordered producer/consumer report bytes.");
const secondConcurrentRun = runConcurrent();
const finalBytes = await reportBytes();
assert.deepEqual(finalBytes, orderedBytes, "Concurrent run 2 must preserve the ordered producer/consumer report bytes.");

const [oracle, batch12, readRace] = await Promise.all(finalBytes.map(bytes => JSON.parse(bytes.toString("utf8"))));
assert.equal(readRace.originalOracle.sha256, sha256(finalBytes[0]), "Read-race report must pin the final original-oracle bytes.");
assert.equal(readRace.originalOracle.priorBatch12Report.sha256, sha256(finalBytes[1]),
  "Read-race report must pin the final Batch12 report bytes.");
console.log(JSON.stringify({
  fixedPoint: "stable",
  orderedGeneration: orderedFiles,
  concurrentInvocations: [firstConcurrentRun, secondConcurrentRun],
  reports: reports.map((path, index) => ({ path, sha256: sha256(finalBytes[index]) })),
  sourceMaps: {
    originalOracle: {
      aggregateSha256: oracle.nativeSourceSetSha256,
      nativeSourceCount: Object.keys(oracle.nativeSources).length,
      originalSourceCount: Object.keys(oracle.originalSources).length,
    },
    batch12: {
      aggregateSha256: batch12.nativeSourceSetSha256,
      nativeSourceCount: Object.keys(batch12.nativeSources).length,
      originalSourceCount: Object.keys(batch12.originalSources).length,
    },
    readRace: {
      sourceMapCount: Object.keys(readRace.sourceHashes).length,
      oracleReportSha256: readRace.originalOracle.sha256,
      batch12ReportSha256: readRace.originalOracle.priorBatch12Report.sha256,
    },
  },
}, null, 2));
