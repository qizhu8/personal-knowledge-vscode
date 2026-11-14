import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publishCapture } from "../scripts/capture-output.mjs";
import { captureStatus, checkCaptureRecords, checkQualificationStatus, hash } from "../scripts/migration.mjs";

test("Action capture check reports every stale output without writing any output", async t => {
  const root = await mkdtemp(join(import.meta.dirname, ".action-capture-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, "first");
  const second = join(root, "second");
  await writeFile(first, "old first");
  await writeFile(second, "old second");
  const outputs = [[first, "new first"], [second, "new second"]];
  await assert.rejects(publishCapture(outputs, true), error =>
    error.message.includes(first) && error.message.includes(second));
  assert.equal(await readFile(first, "utf8"), "old first");
  assert.equal(await readFile(second, "utf8"), "old second");
  await publishCapture(outputs, false);
  await publishCapture(outputs, true);
  await rm(second);
  await assert.rejects(publishCapture(outputs, true), /capture differs/);
  await assert.rejects(readFile(second), { code: "ENOENT" });
});

test("matching capture hashes cannot qualify an explicitly unqualified candidate", async t => {
  const root = await mkdtemp(join(import.meta.dirname, ".action-capture-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "source"), "current");
  await writeFile(join(root, "capture"), "current");
  assert.deepEqual(await checkCaptureRecords([{ source: "source", captured: "capture",
    sourceSha256: hash("current"), capturedSha256: hash("current") }], root, root), []);
  const marker = { qualificationStatus: { state: "unqualified", reason: "not yet reviewed" } };
  assert.deepEqual(checkQualificationStatus(marker, "action-compiler-provenance.json"), [{
    kind: "qualification", path: "migration/action-compiler-provenance.json", reason: "unqualified",
  }]);
  assert.deepEqual(checkQualificationStatus({}, "older.json"), []);
  assert.throws(() => checkQualificationStatus({ qualificationStatus: { state: "qualified" } }, "bad.json"), /Malformed/);
  assert((await captureStatus()).issues.some(issue => issue.kind === "qualification"
    && issue.path === "migration/action-compiler-provenance.json" && issue.reason === "unqualified"));
});
