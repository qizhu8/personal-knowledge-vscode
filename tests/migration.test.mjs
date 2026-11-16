import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { captureStatus, checkCaptureRecords, checkNativeRecords, filesUnder, hash, packageRoot } from "../scripts/migration.mjs";

const tests = dirname(fileURLToPath(import.meta.url));

test("implementation test inventory excludes hidden fixture trees but retains nested sources and reports", async t => {
  const root = await mkdtemp(join(tests, ".migration-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "nested"));
  await mkdir(join(root, ".foreign-fixture"));
  const source = join(root, "nested", "guard.test.mjs");
  const report = join(root, "oracle.report.json");
  const fixture = join(root, ".foreign-fixture", "core.sqlite");
  await writeFile(source, "source");
  await writeFile(report, "report");
  await writeFile(fixture, "live database");
  const snapshot = async () => Promise.all((await filesUnder(root, { excludeHiddenDirectories: true }))
    .map(async path => [path, hash(await readFile(path))]));
  const before = await snapshot();
  const unfilteredBefore = hash(JSON.stringify(await Promise.all((await filesUnder(root))
    .map(async path => [path, hash(await readFile(path))]))));
  assert.deepEqual(before.map(([path]) => path).sort(), [source, report].sort());
  await writeFile(fixture, "another process changed its database");
  assert.deepEqual(await snapshot(), before);
  assert.notEqual(hash(JSON.stringify(await Promise.all((await filesUnder(root))
    .map(async path => [path, hash(await readFile(path))])))), unfilteredBefore);
  assert((await filesUnder(root)).includes(fixture));
  await writeFile(source, "changed guard");
  assert.notDeepEqual(await snapshot(), before);
  await writeFile(source, "source");
  await writeFile(report, "changed report");
  assert.notDeepEqual(await snapshot(), before);
});

test("domain provenance checks original and captured bytes rather than trusting a refreshed inventory", async t => {
  const root = await mkdtemp(join(tests, ".migration-provenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "original.ts"), "original");
  await writeFile(join(root, "captured.ts"), "captured");
  const records = [{ source: "original.ts", captured: "captured.ts", sourceSha256: hash("original"), capturedSha256: hash("captured") }];
  assert.deepEqual(await checkCaptureRecords(records, root, root), []);
  await writeFile(join(root, "original.ts"), "new original business rules");
  assert.deepEqual(await checkCaptureRecords(records, root, root), [{ kind: "source", path: "original.ts", reason: "hash-changed" }]);
  await writeFile(join(root, "captured.ts"), "unrecorded manual edit");
  assert.equal((await checkCaptureRecords(records, root, root)).length, 2);
  await rm(join(root, "captured.ts"));
  assert((await checkCaptureRecords(records, root, root)).some(issue => issue.kind === "captured" && issue.reason === "missing"));
});

test("capture provenance rejects malformed records and escaping paths without reading them", async () => {
  await assert.rejects(checkCaptureRecords([{ source: "../outside", captured: "inside", sourceSha256: hash("x"), capturedSha256: hash("x") }]), /escapes/);
  await assert.rejects(checkCaptureRecords([{ source: "missing-fields" }]), /Malformed/);
});

test("native provenance detects stale implementation pins before full verification without rewriting bytes", async t => {
  const root = await mkdtemp(join(tests, ".migration-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "implementation.ts");
  await writeFile(file, "qualified native");
  const records = [{ file: "implementation.ts", sha256: hash("qualified native") }];
  assert.deepEqual(await checkNativeRecords(records, root), []);
  await writeFile(file, "lease guard added after capture");
  assert.deepEqual(await checkNativeRecords(records, root),
    [{ kind: "native", path: "implementation.ts", reason: "hash-changed" }]);
  assert.equal(await readFile(file, "utf8"), "lease guard added after capture");
  await rm(file);
  assert.deepEqual(await checkNativeRecords(records, root),
    [{ kind: "native", path: "implementation.ts", reason: "missing" }]);
  await assert.rejects(checkNativeRecords([{ file: "../outside", sha256: hash("x") }], root), /escapes/);
  await assert.rejects(checkNativeRecords([{ file: "missing-fields" }], root), /Malformed/);
});

test("every curated domain/regression capture matches its recorded original and captured file hashes", async () => {
  const status = await captureStatus();
  assert(status.records >= 10);
  const unsupported = process.env.PKM_TEST_QUALIFICATION === "linux-candidate" ? [{
    kind: "qualification", path: "migration/action-compiler-provenance.json", reason: "unqualified",
  }] : [];
  assert.deepEqual(status.issues, unsupported);
});

test("agent-runtime provenance is a repeatable, root-qualified domain capture", async () => {
  const path = resolve(packageRoot, "migration/agent-runtime-provenance.json");
  const provenance = JSON.parse(await readFile(path, "utf8"));
  assert.equal(provenance.sourceRoot, "..");
  assert.equal(provenance.capturedRoot, ".");
  assert(provenance.files.length > 0);
  for (const sourcePath of [
    "src/agent-sessions/agent-session-lifecycle.ts",
    "src/chat/worker-scope.ts",
    "src/chat/worker-tree.ts",
    "src/chatroom/peer-protocol.ts",
    "src/agent-sessions/agent-snapshots.ts",
    "tests/test-agent-session-lifecycle.js",
    "tests/test-chat-workers.js",
    "tests/test-agent-session-pkm-only.js",
    "tests/test-portal-duplex.js",
    "src/chatroom/peer-session.ts",
  ]) {
    assert(provenance.sources.some(source => source.path === sourcePath),
      `retain the recorded source hash for ${sourcePath}`);
  }
  assert.deepEqual(await checkCaptureRecords(
    provenance.files,
    resolve(packageRoot, "legacy"),
    resolve(packageRoot, provenance.capturedRoot),
  ), []);
  const capture = spawnSync(process.execPath, ["scripts/capture-agent-runtime.mjs", "--check"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  assert.equal(capture.status, 0, capture.stderr || capture.stdout);
});
