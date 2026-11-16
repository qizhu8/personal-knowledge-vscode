import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { publishCapture } from "../scripts/capture-output.mjs";
import { captureStatus, checkCaptureRecords, checkQualificationStatus, hash, readOriginalSource } from "../scripts/migration.mjs";

async function archiveFixture(t, members) {
  const root = await mkdtemp(join(import.meta.dirname, ".action-capture-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "originals.zip");
  const result = spawnSync("python", ["-I", "-B", "-c", `
import json,sys,warnings,zipfile
warnings.simplefilter("ignore",UserWarning)
with zipfile.ZipFile(sys.argv[1],"w",compression=zipfile.ZIP_DEFLATED) as archive:
 for member in json.load(sys.stdin):
  info=zipfile.ZipInfo(member["path"])
  info.create_system=3
  info.external_attr=member.get("mode",0o100644)<<16
  archive.writestr(info,member["value"])
`, path], { input: JSON.stringify(members), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return { root, archiveSha256: hash(await readFile(path)) };
}

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

test("ZIP evidence authenticates source and captured roles, rejecting bad archive and member bytes without extraction", async t => {
  const { root, archiveSha256 } = await archiveFixture(t, [
    { path: "source.py", value: "original source" }, { path: "capture.ts", value: "original capture" },
  ]);
  const source = "originals.zip!/source.py", captured = "originals.zip!/capture.ts";
  assert.deepEqual(await checkCaptureRecords([{
    source, captured, sourceSha256: hash("original source"), capturedSha256: hash("original capture"),
    archiveSha256, capturedArchiveSha256: archiveSha256,
  }], root, root), []);
  const options = { root, archiveSha256, sha256: hash("original source") };
  await assert.rejects(readOriginalSource(source, { ...options, archiveSha256: "0".repeat(64) }),
    error => error.evidenceReason === "archive-hash-changed");
  await assert.rejects(readOriginalSource(source, { ...options, sha256: hash("different source") }),
    error => error.evidenceReason === "hash-changed");
  await assert.rejects(readOriginalSource(source, { ...options, archiveSha256: undefined }), /requires its SHA256/);
  await writeFile(join(root, "invalid.zip"), "not a ZIP");
  await assert.rejects(readOriginalSource("invalid.zip!/source.py", {
    ...options, archiveSha256: hash("not a ZIP"),
  }), error => error.evidenceReason === "invalid-archive");
  assert.deepEqual((await readdir(root)).sort(), ["invalid.zip", "originals.zip"]);
});

test("ZIP evidence rejects unsafe, duplicate, non-regular and absent members without fallback", async t => {
  const { root, archiveSha256 } = await archiveFixture(t, [
    { path: "../unsafe", value: "unsafe" },
    { path: "duplicate", value: "first" }, { path: "duplicate", value: "second" },
    { path: "link", value: "outside", mode: 0o120777 },
    { path: "directory", value: "", mode: 0o040755 },
  ]);
  const options = { root, archiveSha256, sha256: hash("unsafe") };
  for (const member of ["../unsafe", "/absolute", "a\\b", "C:/absolute", "a/./b", "a//b"]) {
    await assert.rejects(readOriginalSource(`originals.zip!/${member}`, options), /Invalid capture archive member path/);
  }
  for (const member of ["duplicate", "link", "directory"]) {
    await assert.rejects(readOriginalSource(`originals.zip!/${member}`, options),
      error => error.evidenceReason === "invalid-archive");
  }
  await assert.rejects(readOriginalSource("originals.zip!/absent", options), error => error.evidenceReason === "missing");
  await assert.rejects(readOriginalSource("absent.zip!/source.py", options), { code: "ENOENT" });
  assert.deepEqual(await readdir(root), ["originals.zip"]);
});

test("explicit evidence generations reject role, path, digest and cross-generation substitutions", async () => {
  const path = "resources/action_modules.py";
  const candidate = { dataset: "compiler-candidate-432",
    sha256: "05dc0cdda14163eb41fb713cf69e2069dd99e681df1e721d49f3dbdda3014697" };
  const release = { dataset: "action-mcp-release-4.0.22",
    sha256: "8b939ae9a2de32c5cc0e99538c8ff5722f3a9c7f6f69bd169baf3675788c2a55" };
  assert.notDeepEqual(await readOriginalSource(path, candidate), await readOriginalSource(path, release));
  const captured = "src/domain/action-compiler-original.ts";
  const historical = { dataset: "runtime-historical-3d", kind: "captured",
    sha256: "3d9241d1d182f3066afe092cfe566d5b49f2b0e719cbe177b1435d1f589e06bc" };
  const current = { dataset: "compiler-candidate-432", kind: "captured",
    sha256: "432371f8615140af81599965436a5996afb34b38f060e611ec397f6435e5a302" };
  assert.notDeepEqual(await readOriginalSource(captured, historical), await readOriginalSource(captured, current));
  for (const [member, options] of [
    [path, { ...candidate, dataset: release.dataset }], [path, { ...candidate, kind: "captured" }],
    ["resources/not-the-original.py", candidate], [path, { ...candidate, sha256: "0".repeat(64) }],
    [captured, { ...historical, sha256: current.sha256 }], [captured, { ...current, sha256: historical.sha256 }],
  ]) {
    await assert.rejects(readOriginalSource(member, options), error => error.evidenceReason === "generation-mismatch");
  }
  await assert.rejects(readOriginalSource(path, { ...candidate, dataset: "unknown-generation" }), /Unknown authentication dataset/);
});
