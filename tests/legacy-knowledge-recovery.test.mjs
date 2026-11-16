import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { admitLegacyKnowledgeRecovery, legacyKnowledgeRecovery, reconcileLegacyKnowledgeRecovery,
  verifyLegacyKnowledgeRecovery } from "../dist/legacy-knowledge-recovery.js";

const root = resolve(import.meta.dirname, ".."), repository = resolve(root, "legacy");
const actor = { id: "mcp:external", canWrite: true }, sha = value => createHash("sha256").update(value).digest("hex");
async function fixture(t, rows = [
  { path: "notes/Recovered.md", bytes: Buffer.from("---\r\ntitle: Recovered\r\nunknown: keep\r\n---\r\nExact original recovery.\r\n"), mode: "100644" },
  { path: "skills/Nested/Executable.md", bytes: Buffer.from("---\nname: Executable\n---\nOriginal skill.\n"), mode: "100755" },
]) {
  const parent = join(root, "tests", `.legacy-recovery-${randomUUID()}`);
  await mkdir(parent);
  const data = await initialize(join(parent, "workspace")), evidence = join(parent, "evidence");
  await mkdir(join(evidence, "blobs"), { recursive: true });
  const plan = { schema: "pkm.knowledge-recovery/v1", knowledgeRoot: data,
    files: rows.map(row => ({ path: row.path, sha256: sha(row.bytes), mode: row.mode })) };
  for (const row of rows) await writeFile(join(evidence, "blobs", sha(row.bytes)), row.bytes);
  const bytes = Buffer.from(JSON.stringify(plan));
  await writeFile(join(evidence, "plan.json"), bytes);
  let storage = await Storage.open(data);
  t.after(async () => { try { await storage.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
  const admit = (extra = {}) => admitLegacyKnowledgeRecovery(storage, actor, { evidenceRoot: evidence, auditRoot: evidence,
    expectedPlanSha256: sha(bytes), authorityId: "test-native-reviewed-evidence-and-audit", authorize: () => true, ...extra });
  const invoke = (tool, args = {}, who = actor, checkpoints) => legacyKnowledgeRecovery(storage, who, {
    tool, arguments: { evidence_directory: evidence, ...(tool === "knowledge_recovery_apply" ? { approved_plan_sha256: sha(bytes) } : {}), ...args },
  }, checkpoints);
  const pending = () => {
    const db = storage.connectNative();
    try { return JSON.parse(db.prepare("SELECT payload FROM legacy_knowledge_recovery_intent WHERE singleton=1").get().payload); }
    finally { db.close(); }
  };
  const reconcile = (extra = {}) => reconcileLegacyKnowledgeRecovery(storage, actor, {
    operationId: pending().operationId, authorityId: "test-exact-native-recovery-owner", authorize: () => true, ...extra,
  });
  const original = tool => JSON.parse(execFileSync("python3", ["-c", `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("independent_original_recovery",sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
tools={}
class Mcp:
 def tool(self,**_):
  def decorate(function):tools[function.__name__]=function;return function
  return decorate
module.register_knowledge_recovery_tools(Mcp(),sys.argv[2])
print(json.dumps(tools[sys.argv[4]](sys.argv[3])))
`, join(repository, "resources/knowledge_recovery.py"), data, evidence, tool], { encoding: "utf8" }));
  const restartPending = async () => {
    await storage.close();
    await assert.rejects(Storage.open(data), /explicit native owner reconciliation/);
    storage = await Storage.open(data, { deferRecovery: true });
  };
  return { parent, data, evidence, get storage() { return storage; }, rows, plan, bytes, admit, invoke, pending, reconcile, original, restartPending };
}

test("original recovery requires a host-approved fixed evidence/audit root before reads and returns exact original missing-only preview", async t => {
  const f = await fixture(t);
  await assert.rejects(f.admit({ evidenceRoot: join(f.parent, "not-existing"), auditRoot: join(f.parent, "not-existing"),
    authorize: () => false }), /Native host denied/);
  await assert.rejects(f.invoke("knowledge_recovery_preview"), /No native host-approved/);
  await f.admit();
  const version = f.storage.connectNative();
  try { assert.equal(version.prepare("PRAGMA user_version").get().user_version, 24); }
  finally { version.close(); }
  assert.deepEqual(await f.invoke("knowledge_recovery_preview"), f.original("knowledge_recovery_preview"));
  await assert.rejects(f.invoke("knowledge_recovery_preview", {}, { id: "foreign", canWrite: true }), /not approved/);
  await assert.rejects(f.invoke("knowledge_recovery_apply", {}, { ...actor, canWrite: false }), /write authority/);
  await assert.rejects(f.invoke("knowledge_recovery_apply", { approved_plan_sha256: "0".repeat(64) }), /changed after approval/);
  await assert.rejects(f.invoke("knowledge_recovery_preview", { actorId: "user:local" }));
  const result = await f.invoke("knowledge_recovery_apply");
  assert.equal(result.ok, true);
  assert.equal(result.restored, 2);
  assert.equal(result.identical, 0);
  assert.equal(result.preserved_existing, 0);
  assert.match(result.report, /result-\d{8}T\d{12}\.json$/);
  for (const row of f.rows) {
    assert.deepEqual(await readFile(join(f.data, row.path)), row.bytes);
    assert.equal((await stat(join(f.data, row.path))).mode & 0o777, row.mode === "100755" ? 0o755 : 0o644);
  }
  const audit = JSON.parse(await readFile(result.report, "utf8"));
  assert.equal(audit.schema, "pkm.knowledge-recovery-result/v1");
  assert.deepEqual(audit.restored, f.rows.map(row => row.path));
  assert.equal(audit.plan_sha256, sha(f.bytes));
  assert.deepEqual(await f.invoke("knowledge_recovery_preview"), f.original("knowledge_recovery_preview"));
  const again = await f.invoke("knowledge_recovery_apply");
  assert.equal(again.restored, 0);
  assert.equal(again.identical, 2);
  const db = f.storage.connectNative();
  try {
    verifyLegacyKnowledgeRecovery(db, f.data);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM legacy_knowledge_recovery_receipts").get().n, 2);
    assert.throws(() => db.exec("DELETE FROM legacy_knowledge_recovery_admissions"), /immutable/);
    assert.throws(() => db.exec("DELETE FROM legacy_knowledge_recovery_receipts"), /immutable/);
  } finally { db.close(); }
});

test("recovery preserves different existing bytes and plan/blob changes never become fresh authority", async t => {
  const f = await fixture(t);
  await writeFile(join(f.data, "notes/Recovered.md"), "Preserve existing bytes.\n");
  await f.admit();
  assert.deepEqual(await f.invoke("knowledge_recovery_preview"), f.original("knowledge_recovery_preview"));
  const raw = await readFile(join(f.evidence, "plan.json"));
  await writeFile(join(f.evidence, "plan.json"), Buffer.concat([raw, Buffer.from("\n")]));
  await assert.rejects(f.invoke("knowledge_recovery_apply"), /changed after native approval/);
  assert.equal(await readFile(join(f.data, "notes/Recovered.md"), "utf8"), "Preserve existing bytes.\n");
  await writeFile(join(f.evidence, "plan.json"), raw);
  const result = await f.invoke("knowledge_recovery_apply");
  assert.equal(result.restored, 1);
  assert.equal(result.preserved_existing, 1);
  assert.equal(await readFile(join(f.data, "notes/Recovered.md"), "utf8"), "Preserve existing bytes.\n");
  await writeFile(join(f.evidence, "blobs", f.plan.files[0].sha256), "Changed approved blob.");
  await assert.rejects(f.invoke("knowledge_recovery_preview"), /blob changed/);
});

test("native recovery application matches independent actual-original missing-only results, audit paths and exact bytes/modes", async t => {
  const f = await fixture(t);
  const oracle = join(f.parent, "independent-original"), evidence = join(f.parent, "independent-evidence");
  await mkdir(join(oracle, "notes"), { recursive: true });
  await cp(f.evidence, evidence, { recursive: true });
  const old = Buffer.from("Existing user content is never overwritten.\n");
  await writeFile(join(f.data, "notes/Recovered.md"), old);
  await writeFile(join(oracle, "notes/Recovered.md"), old);
  const plan = Buffer.from(JSON.stringify({ ...f.plan, knowledgeRoot: oracle }));
  await writeFile(join(evidence, "plan.json"), plan);
  const expected = JSON.parse(execFileSync("python3", ["-c", `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("independent_original_apply",sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
tools={}
class Mcp:
 def tool(self,**_):
  def decorate(function):tools[function.__name__]=function;return function
  return decorate
module.register_knowledge_recovery_tools(Mcp(),sys.argv[2])
print(json.dumps(tools["knowledge_recovery_apply"](sys.argv[3],sys.argv[4])))
`, join(repository, "resources/knowledge_recovery.py"), oracle, evidence, sha(plan)], { encoding: "utf8" }));
  await f.admit();
  const actual = await f.invoke("knowledge_recovery_apply");
  const { report: originalPath, ...originalCounts } = expected, { report: nativePath, ...nativeCounts } = actual;
  assert.deepEqual(nativeCounts, originalCounts);
  const originalReport = JSON.parse(await readFile(originalPath, "utf8")), nativeReport = JSON.parse(await readFile(nativePath, "utf8"));
  for (const key of ["schema", "restored", "identical", "preserved_existing"])
    assert.deepEqual(nativeReport[key], originalReport[key], key);
  for (const row of f.rows) {
    assert.deepEqual(await readFile(join(f.data, row.path)), await readFile(join(oracle, row.path)));
    assert.equal((await stat(join(f.data, row.path))).mode & 0o777, (await stat(join(oracle, row.path))).mode & 0o777);
  }
});

for (const boundary of ["after-intent", "after-audit", "after-stage", "after-link", "after-unlink", "before-commit"])
test(`missing-only recovery ${boundary} fault retains native intent and needs explicit exact-owner reconciliation`, async t => {
  const f = await fixture(t, [{ path: "notes/Exact.md", bytes: Buffer.from("---\ntitle: Exact\n---\nNever rewrite identity.\n"), mode: "100644" }]);
  await f.admit();
  await assert.rejects(f.invoke("knowledge_recovery_apply", {}, actor, {
    checkpoint(name) { if (name === boundary) throw new Error(`fault-${boundary}`); },
  }), new RegExp(`fault-${boundary}`));
  const db = f.storage.connectNative();
  try { assert.throws(() => verifyLegacyKnowledgeRecovery(db, f.data), /explicit native owner reconciliation/); }
  finally { db.close(); }
  await assert.rejects(f.invoke("knowledge_recovery_preview"), /explicit native owner reconciliation/);
  await f.restartPending();
  await assert.rejects(f.reconcile({ authorize: () => false }), /Native owner denied/);
  const result = await f.reconcile();
  assert.equal(result.restored, 1);
  assert.deepEqual(await readFile(join(f.data, "notes/Exact.md")), f.rows[0].bytes);
  assert.equal((await readdir(join(f.data, "notes"))).some(name => name.startsWith(".pkm-write-")), false);
  const checked = f.storage.connectNative();
  try { verifyLegacyKnowledgeRecovery(checked, f.data); }
  finally { checked.close(); }
  await f.storage.recover();
});

test("recovery refuses unsafe/unsupported destinations, duplicate identity and links without publishing", async t => {
  const f = await fixture(t, [{ path: "notes/System/Denied.md", bytes: Buffer.from("No System authority.\n"), mode: "100644" }]);
  await assert.rejects(f.admit(), /portable non-System/);
  const second = await fixture(t, [
    { path: "notes/A.md", bytes: Buffer.from("---\nknowledgeId: same-identity\n---\nA\n"), mode: "100644" },
    { path: "notes/B.md", bytes: Buffer.from("---\nknowledgeId: same-identity\n---\nB\n"), mode: "100644" },
  ]);
  await assert.rejects(second.admit(), /duplicate/);
  const third = await fixture(t);
  await rm(join(third.evidence, "blobs", third.plan.files[0].sha256));
  const foreign = join(third.parent, "foreign");
  await writeFile(foreign, third.rows[0].bytes); await chmod(foreign, 0o600);
  await symlink(foreign, join(third.evidence, "blobs", third.plan.files[0].sha256));
  await assert.rejects(third.admit(), /linked or nonregular/);
  await assert.rejects(readFile(join(third.data, "notes/Recovered.md")), { code: "ENOENT" });
});

test("recovery refuses null declared identity, orphan assets and changed native staging before publication", async t => {
  const invalid = await fixture(t, [{ path: "notes/Null.md", bytes: Buffer.from("---\ndocumentId: null\n---\nInvalid native identity.\n"), mode: "100644" }]);
  await assert.rejects(invalid.admit(), /invalid or duplicate native document identity/);
  const orphan = await fixture(t);
  await mkdir(join(orphan.data, "notes/Recovered.assets"));
  await assert.rejects(orphan.admit(), /cannot adopt orphan assets/);
  const staged = await fixture(t);
  await staged.admit();
  await assert.rejects(staged.invoke("knowledge_recovery_apply", {}, actor, {
    checkpoint(name) {
      if (name === "after-stage") writeFileSync(staged.pending().staged.path, "Foreign bytes cannot acquire recovery authority.");
    },
  }), /stage changed/);
  await assert.rejects(readFile(join(staged.data, "notes/Recovered.md")), { code: "ENOENT" });
  await assert.rejects(staged.reconcile(), /stage changed/);
});

test("native recovery receipts and schema24 survive backup while forged valid-hash backup and downgraded owner fail before publication", async t => {
  const f = await fixture(t);
  await f.admit(); await f.invoke("knowledge_recovery_apply");
  const native = await createNativeRuntime({ storage: f.storage }), backup = join(f.parent, "backup");
  try { await createWorkspaceBackup(f.storage, backup, { acquireQuiescence: native.acquireWorkspaceQuiescence }); }
  finally { await native.close(); }
  const manifest = JSON.parse(await readFile(join(backup, ".pkm-workspace-backup.json"), "utf8"));
  assert.equal(manifest.databaseUserVersion, 24);
  const forged = join(f.parent, "forged-backup");
  await cp(backup, forged, { recursive: true });
  const db = new DatabaseSync(join(forged, "core.sqlite"));
  try {
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE name='legacy_knowledge_recovery_receipts_no_update'").get().sql;
    db.exec("DROP TRIGGER legacy_knowledge_recovery_receipts_no_update");
    db.exec("UPDATE legacy_knowledge_recovery_receipts SET payload_sha256=printf('%064d',0)");
    db.exec(trigger);
  } finally { db.close(); }
  const bytes = await readFile(join(forged, "core.sqlite"));
  const record = manifest.files.find(file => file.path === "core.sqlite");
  record.size = bytes.length; record.sha256 = sha(bytes);
  manifest.totalBytes = manifest.files.reduce((sum, file) => sum + file.size, 0);
  await writeFile(join(forged, ".pkm-workspace-backup.json"), JSON.stringify(manifest));
  const denied = join(f.parent, "forged-restored");
  await assert.rejects(restoreWorkspaceBackup(forged, denied, { nativeRestoreAuthority }), /Recovery receipt changed|recovery receipt/i);
  await assert.rejects(readdir(denied), { code: "ENOENT" });
  const guard = await createNativeRuntime({ storage: f.storage });
  try {
    const source = f.storage.connectNative();
    try { source.exec("PRAGMA user_version=23"); }
    finally { source.close(); }
    await assert.rejects(createWorkspaceBackup(f.storage, join(f.parent, "downgraded-backup"),
      { acquireQuiescence: guard.acquireWorkspaceQuiescence }), /schema version 24/);
  } finally { await guard.close(); }
  await f.storage.close();
  await assert.rejects(Storage.open(f.data), /schema version 24/);
});
