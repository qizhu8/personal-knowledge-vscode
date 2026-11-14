import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { checkCaptureRecords } from "../scripts/migration.mjs";
import {
  parseProcessTable, assessBackgroundProcess, compareVersionOrder,
  PkmServiceExecutionUncertainError, PkmServiceRecoveryPersistenceError,
} from "../dist/domain/runtime-process-original.js";

test("exact original pure parser, process assessment and version contracts without process discovery", () => {
  const rows = parseProcessTable(" 17 2 1-02:03:04 5 node /synthetic/entry.js\ninvalid\n18 2 00:01 2 node example");
  assert.deepEqual(rows[0], { pid: 17, parentPid: 2, elapsedSeconds: 93784, rssBytes: 5120, command: "node /synthetic/entry.js" });
  assert.equal(rows[1].elapsedSeconds, 1);
  const row = { pid: 17, parentPid: 2, kind: "service", entryPath: "/synthetic/entry.js", fixture: false, elapsedSeconds: 0, rssBytes: 0 };
  assert.deepEqual(assessBackgroundProcess({ ...row, entryExists: false }, "1.2.3"), { state: "missing-entry", basis: "entry-path" });
  assert.equal(assessBackgroundProcess({ ...row, fixture: true }, "1.2.3").state, "test");
  assert.equal(assessBackgroundProcess({ ...row, pathVersion: "1.2.2" }, "1.2.3").state, "older");
  assert.equal(assessBackgroundProcess({ ...row, runtime: { source: "managed-registry", fresh: true, extensionVersion: "1.2.3" } }, "1.2.3").state, "current");
  assert.equal(assessBackgroundProcess({ ...row, runtime: { source: "managed-registry", fresh: true, generation: "old", configuredGeneration: "new" } }, "1.2.3").state, "superseded");
  assert.equal(compareVersionOrder("1.2.3-beta.2", "1.2.3"), -1);
  assert.equal(compareVersionOrder("1.2.3-beta.10", "1.2.3-beta.2"), 1);
  assert.equal(compareVersionOrder("invalid", "1.0"), undefined);
});
test("original uncertainty and failed recovery contracts prohibit automatic replay", () => {
  const uncertain = new PkmServiceExecutionUncertainError();
  assert.equal(uncertain.serviceShouldRetry, false);
  assert.match(uncertain.message, /automatic replay is blocked/);
  const failure = new PkmServiceRecoveryPersistenceError("op", "target", "success", undefined, new Error("synthetic"), "receipt", "synthetic.json");
  assert.equal(failure.recoveryAvailable, false);
  assert.equal(failure.serviceShouldRetry, false);
  assert.match(failure.message, /Do not blindly retry/);
});
test("source and capture hashes verified by the shared checker; drift is detected", async () => {
  const provenance = JSON.parse(await readFile(new URL("../migration/runtime-process-provenance.json", import.meta.url), "utf8"));
  assert.deepEqual(await checkCaptureRecords(provenance.files), []);
  const drift = structuredClone(provenance.files[0]);
  drift.capturedSha256 = "0".repeat(64);
  const issues = await checkCaptureRecords([drift]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "captured");
});
