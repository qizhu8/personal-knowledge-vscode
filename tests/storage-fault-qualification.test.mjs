import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { DatabaseSync } from "node:sqlite";
import { encodeMarkdown, sha256 } from "../dist/markdown.js";
import { initialize, Storage } from "../dist/storage.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";

const hash = data => createHash("sha256").update(data).digest("hex");
const owner = "test:fault-owner";
const host = { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) };
const request = operationId => ({ operation: "knowledge.document.create", actorId: owner,
  args: { id: "fault-document", operationId, title: "Fault fixture", content: "synthetic recovery body" } });

async function child(root, point, operationId, temp) {
  const proc = spawn(process.execPath, [resolve("tests/storage-fault-qualification-child.mjs"), root, point, operationId], {
    cwd: resolve("."), env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", diagnostics = "";
  proc.stdout.on("data", data => { stdout += data; });
  proc.stderr.on("data", data => { diagnostics += data; });
  const [code, signal] = await once(proc, "close");
  assert.equal(signal, null, diagnostics);
  assert.equal(code, 86, diagnostics);
  assert.match(stdout.trim(), /^[a-f0-9]{64}$/);
  return stdout.trim();
}

test("isolated boundary exits: real journal replay, receipt identity, conflict preservation and backup restore", { timeout: 45_000 }, async t => {
  const parent = resolve("tests", `.storage-fault-qualification-${randomUUID()}`);
  await mkdir(parent, { recursive: false });
  t.after(() => rm(parent, { recursive: true, force: true }));
  const sources = {};
  for (const path of ["src/storage.ts", "src/storage-worker.ts", "src/markdown.ts", "src/workspace-backup.ts",
    "src/file-write.ts", "dist/storage.js", "dist/storage-worker.js", "dist/markdown.js",
    "dist/workspace-backup.js", "dist/file-write.js", "tests/storage-fault-qualification-child.mjs",
    "tests/storage-fault-qualification.test.mjs"]) {
    sources[path] = hash(await readFile(path));
  }
  const outcomes = [];
  for (const point of ["dbcommit", "write", "fsync", "rename", "receipt-close"]) {
    const root = join(parent, point);
    await initialize(root);
    const initial = await Storage.open(root);
    await initial.close();
    const temp = join(parent, `temp-${point}`);
    await mkdir(temp);
    const operationId = randomUUID();
    const expectedHash = await child(root, point, operationId, temp);
    const recovered = await Storage.open(root);
    try {
      if (point === "dbcommit") {
        await assert.rejects(recovered.request({ operation: "knowledge.document.get", actorId: owner, args: { id: "fault-document" } }), /not found/i);
        outcomes.push({ point, outcome: "uncommitted-intent-absent" });
      } else {
        const replay = await recovered.request(request(operationId));
        const again = await recovered.request(request(operationId));
        assert.deepEqual(replay, again);
        const raw = await readFile(join(root, "notes", "fault-document.md"));
        assert.equal(hash(raw), expectedHash);
        const db = recovered.connectNative();
        try {
          assert.equal(db.prepare("SELECT count(*) AS n FROM pending_write").get().n, 0);
          assert.equal(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation_id=?").get(operationId).n, 1);
        } finally { db.close(); }
        outcomes.push({ point, outcome: "replayed-once", markdownSha256: hash(raw) });
      }
    } finally { await recovered.close(); }
  }

  const conflictRoot = join(parent, "conflict");
  await initialize(conflictRoot);
  const bootstrap = await Storage.open(conflictRoot);
  await bootstrap.close();
  const existing = encodeMarkdown("fault-document", "Existing", "must not overwrite", 1, false);
  const existingPath = join(conflictRoot, "notes", "fault-document.md");
  await writeFile(existingPath, existing);
  const operationId = randomUUID(), pending = request(operationId);
  const db = new DatabaseSync(join(conflictRoot, "core.sqlite"));
  db.prepare("INSERT INTO pending_write(singleton,operation_id,fingerprint,actor_id,operation,document_id,before_sha256,after_markdown) VALUES(1,?,?,?,?,?,?,?)")
    .run(operationId, sha256(JSON.stringify(pending)), owner, pending.operation, pending.args.id, null,
      encodeMarkdown(pending.args.id, pending.args.title, pending.args.content, 1, false));
  db.close();
  await assert.rejects(Storage.open(conflictRoot));
  assert.equal(hash(await readFile(existingPath)), hash(existing));
  const check = new DatabaseSync(join(conflictRoot, "core.sqlite"));
  assert.equal(check.prepare("SELECT count(*) AS n FROM pending_write").get().n, 1);
  check.close();

  const root = join(parent, "backup-source");
  await initialize(root);
  const store = await Storage.open(root);
  try {
    const operationId = randomUUID();
    const created = await store.request(request(operationId));
    const asset = join(root, "notes", "fault-document.assets");
    await mkdir(asset);
    const bytes = Buffer.from([0, 1, 2, 255]);
    await writeFile(join(asset, "fixture.bin"), bytes);
    const backup = join(parent, "backup"), restored = join(parent, "restored");
    await createWorkspaceBackup(store, backup, host);
    await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority });
    assert.equal(hash(await readFile(join(restored, "notes", "fault-document.assets", "fixture.bin"))), hash(bytes));
    const reopened = await Storage.open(restored);
    try { assert.deepEqual(await reopened.request(request(operationId)), created); }
    finally { await reopened.close(); }
    await assert.rejects(restoreWorkspaceBackup(backup, restored), { code: "DESTINATION_EXISTS" });
    const pendingDb = store.connectNative();
    pendingDb.exec("CREATE TABLE pending_qualification_unknown(value TEXT); INSERT INTO pending_qualification_unknown VALUES('unknown');");
    pendingDb.close();
    await assert.rejects(createWorkspaceBackup(store, join(parent, "unknown-backup"), host), { code: "PENDING_JOURNAL" });
    const unknownCheck = store.connectNative();
    assert.equal(unknownCheck.prepare("SELECT count(*) AS n FROM pending_qualification_unknown").get().n, 1);
    unknownCheck.close();
    for (const [path, digest] of Object.entries(sources)) assert.equal(hash(await readFile(path)), digest, `source changed: ${path}`);
    const report = {
      schema: "pkm.storage-fault-qualification/v1", node: process.version, sources, outcomes,
      conflictPreservedSha256: hash(existing), backupRestore: "verified", assetSha256: hash(bytes),
      unknownPendingBackup: "refused-and-preserved",
      scope: "synthetic staged child boundaries and actual journal recovery; not production I/O hooks",
      exclusions: ["physical power loss", "production fsync/rename/commit fault injection", "disk full", "permissions",
        "Todo", "trash", "folder move", "Sync", "coding worker pending effects"],
      readinessApproval: false,
    };
    console.log("STORAGE_FAULT_QUALIFICATION " + JSON.stringify(report));
    if (process.env.STORAGE_QUALIFICATION_SAVE === "1") {
      await writeFile("tests/storage-fault-qualification-fault-report.json", JSON.stringify(report, null, 2) + "\n");
    }
  } finally { await store.close(); }
});
