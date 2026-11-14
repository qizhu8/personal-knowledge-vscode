import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile, symlink, link } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { inspectLegacyRetrievalHistory } from "../dist/legacy-retrieval-history-import.js";
import { planLegacyImport, importLegacyWorkspace } from "../dist/legacy-import.js";
import { Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { readLegacyRetrievalLearning, authorizeLegacyRetrievalFeedback } from "../dist/legacy-retrieval-learning.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";

async function fixture(t, predecessor) {
  const root = resolve(`.retrieval-history-import-${randomUUID()}`), source = join(root, "original"), stateRoot = join(root, "state");
  await mkdir(join(source, "notes"), { recursive: true }); await mkdir(stateRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  const pythonExecutable = spawnSync("which", ["python3"], { encoding: "utf8" }).stdout.trim();
  const result = spawnSync(pythonExecutable, ["-c", `
import ast,hashlib,json,math,os,re,secrets,sqlite3,sys,threading
from pathlib import Path
source=Path("resources/retrieval_solutions.py")
node,=[n for n in ast.parse(source.read_text()).body if isinstance(n,ast.ClassDef) and n.name=="RetrievalLearning"]
exec(compile(ast.Module(body=[node],type_ignores=[]),"<actual-original-learner>","exec"))
learner=RetrievalLearning(Path(sys.argv[1]));learner.configure(True)
response={"ok":True,"model_invoked":True,"semantic_status":"ready","route":"semantic",
 "model_attempt_package_id":"a"*64,"corpus_revision":"original-corpus",
 "hits":[{"source_id":"pkm://notes/Original","score":0.9},{"source_id":"pkm://notes/Other","score":0.1}]}
learner.observe(response,2.5,query="raw-private-query")
with learner.connect() as db: receipt=db.execute("SELECT receipt FROM calls").fetchone()[0]
learner.feedback(receipt,["pkm://notes/Original"],True,"user")
expected=None
if len(sys.argv)>2:
 profile=json.loads(sys.argv[2]);modelwidth,callwidth,optin,version=profile[:4]
 with learner.connect() as db:
  for table,width in [("models",modelwidth),("calls",callwidth)]:
   names=[row[1] for row in db.execute("PRAGMA table_info("+table+")")]
   for column in reversed(names[width:]):db.execute("ALTER TABLE "+table+" DROP COLUMN "+column)
  if not optin:db.execute("DELETE FROM settings WHERE key='online_learning_opt_in_version'")
  if not version:db.execute("DELETE FROM settings WHERE key='learner_version'")
  if len(profile)>4 and profile[4]:db.execute("DROP TABLE query_judgments")
  db.execute("UPDATE models SET slope=99,bias=88,samples=42,safe_streak=42")
 with learner.connect() as db:
  memory=sqlite3.connect(":memory:");db.backup(memory)
 from types import SimpleNamespace
 os=SimpleNamespace(chmod=lambda *_:None)
 class Root:
  def __truediv__(self,_):return ":memory:"
 class IndependentOriginal(RetrievalLearning):
  def connect(self):return memory
 IndependentOriginal(Root())
 expected={name:[list(row) for row in memory.execute("SELECT * FROM "+name+" ORDER BY "+order)]
  for name,order in [("settings","key"),("models","context"),("calls","id"),("query_judgments","context,query_key")]}
 memory.close()
print(json.dumps({"receipt":receipt,"expected":expected}))
`, stateRoot, ...(predecessor ? [JSON.stringify(predecessor)] : [])], { cwd: resolve(import.meta.dirname, "../legacy"), encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(result.status, 0, result.stderr);
  await writeFile(join(stateRoot, "solution-selection.json"), JSON.stringify({ schema: 1, package_id: null }));
  return { root, source, stateRoot, pythonExecutable, receipt: JSON.parse(result.stdout).receipt, expected: JSON.parse(result.stdout).expected,
    target: join(root, "target"), policy: { retrievalHistory: { stateRoot, actorId: "mcp:external" } } };
}
const approve = request => ({ actorId: request.actorId, decisionId: "native-original-history-decision" });

test("actual original learner state imports exact salt/history/user labels without minting old feedback authority and survives relocated backup", async t => {
  const f = await fixture(t), original = await inspectLegacyRetrievalHistory(join(f.stateRoot, "retrieval-learning.sqlite3"));
  const bytes = await readFile(original.source.sourceDatabase);
  const plan = await planLegacyImport(f.source, {}, f.policy);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.equal(plan.retrievalHistoryPlan.source.stateSha256, original.source.stateSha256);
  assert.equal(JSON.stringify(plan).includes("raw-private-query"), false);
  await importLegacyWorkspace(plan, f.target, { pythonExecutable: f.pythonExecutable, authorizeRetrievalHistory: approve });
  const storage = await Storage.open(f.target), native = await createNativeRuntime({ storage });
  const backup = join(f.root, "backup"), relocated = join(f.root, "relocated");
  const check = async store => {
    const db = store.connectNative();
    try {
      const authority = { actorId: "mcp:external", workspaceId: await store.workspaceId(),
        packageId: "a".repeat(64), selectionRevision: "b".repeat(64), corpusRevision: "c".repeat(64), pinsDigest: "d".repeat(64) };
      assert.deepEqual(readLegacyRetrievalLearning(db, authority).state, original.state);
      assert.throws(() => authorizeLegacyRetrievalFeedback(db, authority, f.receipt), /native actor-bound model receipt/);
      assert.equal(Number(db.prepare("SELECT count(*) n FROM legacy_original_learning_receipts").get().n), 0);
    } finally { db.close(); }
  };
  try { await check(storage); await createWorkspaceBackup(storage, backup, { acquireQuiescence: native.acquireWorkspaceQuiescence }); }
  finally { await native.close(); await storage.close(); }
  await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority });
  const restored = await Storage.open(relocated), restoredNative = await createNativeRuntime({ storage: restored });
  try { await check(restored); } finally { await restoredNative.close(); await restored.close(); }
  assert.deepEqual(await readFile(original.source.sourceDatabase), bytes);
  assert.deepEqual((await readdir(f.stateRoot)).sort(), ["retrieval-learning.sqlite3", "solution-selection.json"]);
});

for (const attack of ["wal", "shm", "journal", "unknown-table", "trigger", "unknown-column", "missing-query-table",
  "missing-middle-column", "missing-salt", "unknown-setting", "wrong-column-type", "wrong-default",
  "unknown-state", "missing-selected-package", "null-selected-frozen", "symlink", "hardlink"]) {
  test(`closed original learner migration rejects ${attack} explicitly`, async t => {
    const f = await fixture(t);
    if (["wal", "shm", "journal"].includes(attack)) await writeFile(join(f.stateRoot, `retrieval-learning.sqlite3-${attack}`), "");
    if (attack === "unknown-state") await writeFile(join(f.stateRoot, "pending.json"), "{}");
    if (attack === "missing-selected-package") await writeFile(join(f.stateRoot, "solution-selection.json"), JSON.stringify({ schema: 1, package_id: "a".repeat(64) }));
    if (attack === "null-selected-frozen") await writeFile(join(f.stateRoot, "serving-release.json"), JSON.stringify({
      sha256: "a".repeat(64), release: { schema: "pkm.skill-serving/v1", config: { model: join(f.stateRoot, "solutions", "a".repeat(64), "model") } },
    }));
    const mutations = {
      "unknown-table": "CREATE TABLE unexpected(value)",
      trigger: "CREATE TRIGGER unexpected AFTER INSERT ON calls BEGIN SELECT 1; END",
      "unknown-column": "ALTER TABLE calls RENAME COLUMN judged TO unsupported_judged",
      "missing-query-table": "DROP TABLE query_judgments",
      "missing-middle-column": "ALTER TABLE models DROP COLUMN revision",
      "missing-salt": "DELETE FROM settings WHERE key='salt'",
      "unknown-setting": "INSERT INTO settings VALUES ('unexpected','1')",
      "wrong-column-type": "PRAGMA writable_schema=ON; UPDATE sqlite_master SET sql=replace(sql,'slope REAL','slope TEXT') WHERE name='models'; PRAGMA schema_version=999",
      "wrong-default": "PRAGMA writable_schema=ON; UPDATE sqlite_master SET sql=replace(sql,'DEFAULT ''[]''','DEFAULT ''{}''') WHERE name='models'; PRAGMA schema_version=999",
    };
    if (mutations[attack]) {
      const db = new DatabaseSync(join(f.stateRoot, "retrieval-learning.sqlite3"));
      try { db.exec(mutations[attack]); }
      finally { db.close(); }
    }
    if (attack === "symlink") {
      await rm(join(f.stateRoot, "solution-selection.json"));
      await writeFile(join(f.root, "linked-selection.json"), JSON.stringify({ schema: 1, package_id: null }));
      await symlink(join(f.root, "linked-selection.json"), join(f.stateRoot, "solution-selection.json"));
    }
    if (attack === "hardlink") await link(join(f.stateRoot, "retrieval-learning.sqlite3"), join(f.root, "linked.sqlite"));
    const plan = await planLegacyImport(f.source, {}, f.policy);
    assert.equal(plan.ready, false);
    await assert.rejects(readdir(f.target), { code: "ENOENT" });
  });
}

for (const [label, profile] of [["base", [9, 11, false, false]], ["base-missing-query-table", [9, 11, false, false, true]],
  ["partial", [11, 14, true, false]], ["current-missing-version", [14, 19, true, false]]]) {
  test(`closed ${label} original learner upgrades only in memory and imports exact original normalization through restart and relocated backup`, async t => {
      const f = await fixture(t, profile), sourceDatabase = join(f.stateRoot, "retrieval-learning.sqlite3");
      const rawBytes = await readFile(sourceDatabase);
      const inspected = await inspectLegacyRetrievalHistory(sourceDatabase);
      assert.deepEqual(inspected.state, f.expected);
      assert.notEqual(inspected.source.rawStateSha256, inspected.source.stateSha256);
      assert.equal(inspected.source.schemaProfile.models.length, profile[0]);
      assert.equal(inspected.source.schemaProfile.calls.length, profile[1]);
      assert.equal(inspected.source.schemaProfile.query_judgments.length, profile[4] ? 0 : 9);
      assert.equal(inspected.state.settings.find(row => row[0] === "enabled")[1], profile[2] ? "true" : "false");
      assert.equal(inspected.state.models[0][4], 4);
      assert.equal(inspected.state.models[0][7], 0);
      const plan = await planLegacyImport(f.source, {}, f.policy);
      assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
      await importLegacyWorkspace(plan, f.target, { pythonExecutable: f.pythonExecutable, authorizeRetrievalHistory: approve });
      const backup = join(f.root, "backup"), relocated = join(f.root, "relocated");
      const storage = await Storage.open(f.target), native = await createNativeRuntime({ storage });
      const check = async store => {
        const db = store.connectNative();
        try {
          const authority = { actorId: "mcp:external", workspaceId: await store.workspaceId(),
            packageId: "a".repeat(64), selectionRevision: "b".repeat(64), corpusRevision: "c".repeat(64), pinsDigest: "d".repeat(64) };
          assert.deepEqual(readLegacyRetrievalLearning(db, authority).state, f.expected);
          assert.throws(() => authorizeLegacyRetrievalFeedback(db, authority, f.receipt), /native actor-bound model receipt/);
        } finally { db.close(); }
      };
      try { await check(storage); await createWorkspaceBackup(storage, backup, { acquireQuiescence: native.acquireWorkspaceQuiescence }); }
      finally { await native.close(); await storage.close(); }
      const restarted = await Storage.open(f.target);
      try { await check(restarted); } finally { await restarted.close(); }
      await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority });
      const restored = await Storage.open(relocated), restoredNative = await createNativeRuntime({ storage: restored });
      try { await check(restored); } finally { await restoredNative.close(); await restored.close(); }
      assert.deepEqual(await readFile(sourceDatabase), rawBytes);
      assert.deepEqual((await inspectLegacyRetrievalHistory(sourceDatabase)).source, inspected.source);
      assert.deepEqual((await readdir(f.stateRoot)).sort(), ["retrieval-learning.sqlite3", "solution-selection.json"]);
  });
}

test("native approval is mandatory and a source mutation inside approval never publishes", async t => {
  const f = await fixture(t), plan = await planLegacyImport(f.source, {}, f.policy);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  await assert.rejects(importLegacyWorkspace(plan, f.target, { pythonExecutable: f.pythonExecutable }), /native approval/);
  await assert.rejects(importLegacyWorkspace(plan, f.target, { pythonExecutable: f.pythonExecutable,
    authorizeRetrievalHistory: () => ({ actorId: "foreign", decisionId: "wrong-actor" }) }), /exact actor/);
  await assert.rejects(importLegacyWorkspace(plan, f.target, { pythonExecutable: f.pythonExecutable,
    authorizeRetrievalHistory: async request => {
      await writeFile(join(f.stateRoot, "solution-selection.json"), JSON.stringify({ schema: 1, package_id: "a".repeat(64) }));
      return approve(request);
    } }));
  await assert.rejects(readdir(f.target), { code: "ENOENT" });
});
