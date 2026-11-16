import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile, chmod, symlink, link, cp, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { initialize, Storage } from "../dist/storage.js";
import { admitLegacyKnowledgeSnapshots, legacyKnowledgeSnapshot, invokeAdmittedLegacyKnowledgeSnapshot, reconcileLegacyKnowledgeSnapshots, verifyLegacyKnowledgeSnapshots } from "../dist/legacy-knowledge-snapshots.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { createNativeLegacyTodoBoard } from "../dist/legacy-todo-board-create.js";
import { admitLegacyKnowledgeRecovery, legacyKnowledgeRecovery } from "../dist/legacy-knowledge-recovery.js";
const actor = { id: "mcp:external", canWrite: true };
const sha = value => createHash("sha256").update(value).digest("hex");
async function fixture(t, allowedTools = ["knowledge_snapshot_status", "knowledge_snapshot_create", "knowledge_snapshot_configure",
  "knowledge_snapshot_restore_preview", "knowledge_snapshot_restore_apply"]) {
  const root = resolve(`.knowledge-snapshots-${randomUUID()}`);
  await mkdir(root);
  const data = join(root, "data"); await initialize(data);
  await writeFile(join(data, "notes/Original.md"), "---\r\ntitle: Original\r\ncustom: preserved\r\n---\r\nOld exact body.\r\n");
  await mkdir(join(data, "prompts"));
  await writeFile(join(data, "prompts/Prompt.txt"), "Keep prompt raw\n");
  const stores = [], runtimes = [];
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    for (const storage of stores) await storage.close();
    await rm(root, { recursive: true, force: true });
  });
  const open = async (directory = data, options) => { const storage = await Storage.open(directory, options); stores.push(storage); return storage; };
  const host = { authorize: request => request.actorId === actor.id && request.workspaceRoot === data
    && request.privateGitRoot === join(data, "packages/knowledge-snapshots/repository.git") && request.authorityId === "fixture-explicit-native-snapshot" };
  const storage = await open();
  await storage.provisionTrash();
  await admitLegacyKnowledgeSnapshots(storage, actor, { authorityId: "fixture-explicit-native-snapshot", authorize: host.authorize,
    allowedTools });
  const call = (tool, args = {}, operationId = randomUUID(), runtimeHost = host, who = actor, store = storage) =>
    legacyKnowledgeSnapshot(store, who, { tool: `knowledge_snapshot_${tool}`, args, operationId }, runtimeHost);
  return { root, data, storage, open, host, call, runtimes };
}
function originalOracle(root, state, operation, args = {}) {
  const output = execFileSync("python3", ["-c", `
import ast,contextlib,hashlib,json,os,re,stat,subprocess,sys,uuid
from pathlib import Path
from datetime import datetime,timedelta,timezone
from zoneinfo import ZoneInfo
AREAS=("skills","notes","papers","prompts","scripts");UTC=timezone.utc
source=Path("resources/knowledge_snapshots.py").read_text()
nodes=[n for n in ast.parse(source).body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in ("_sha","_json","_lock","next_run","KnowledgeSnapshots")]
exec(compile(ast.Module(body=nodes,type_ignores=[]),"<independent-original-snapshot-oracle>","exec"))
request=json.load(sys.stdin);snapshots=KnowledgeSnapshots(Path(request["root"]));snapshots.state=Path(request["state"]);snapshots.repository=snapshots.state/"repository.git"
operation=request["operation"]
if operation=="inventory":
 files=snapshots.inventory()
 print(json.dumps({"fingerprint":snapshots.fingerprint(files),"files":{path:{"sha256":row["sha256"],"mode":row["mode"]} for path,row in files.items()}}))
elif operation=="preview":
 print(json.dumps(snapshots.restore_preview(request["args"]["tag"])))
elif operation=="timing":print(json.dumps(next_run(request["args"]["local_time"],request["args"]["timezone"],datetime.fromisoformat(request["args"]["now"]))))
elif operation=="restore":
 sys.path.insert(0,str(Path("resources").resolve()))
 from knowledge_mutations import trash_file
 snapshots.node=request["args"]["node"];snapshots.extension_root=str(Path.cwd())
 destination=snapshots.root/"notes/Original.md";destination.write_bytes(request["args"]["original"].encode());destination.chmod(0o755)
 created=snapshots._create("independent-original-restore")
 destination.write_bytes(request["args"]["changed"].encode());destination.chmod(0o644)
 (snapshots.root/"notes/Extra.md").write_bytes(request["args"]["extra"].encode())
 preview=snapshots.restore_preview(created["tag"])
 result=snapshots.restore_apply(preview["preview_id"],preview["approved_sha256"])
 result["actual_bytes"]=destination.read_bytes().hex();result["actual_mode"]=stat.S_IMODE(destination.stat().st_mode)
 result["actual_trash_files"]=sorted(str(p.relative_to(snapshots.root)) for p in (snapshots.root/"notes/.trash").rglob("*") if p.is_file())
 print(json.dumps(result))
`, ], { cwd: resolve(import.meta.dirname, "../legacy"), input: JSON.stringify({ root, state, operation, args }),
    encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", TMPDIR: state,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  return JSON.parse(output);
}

test("resuming a journalled-but-unstarted native Trash operation rejects target-phase spoofing before any file is moved", async t => {
  const f = await fixture(t), path = join(f.data, "notes/Original.md"), original = await readFile(path), created = await f.call("create");
  const changed = Buffer.from("# New exact before-restore source\n");
  await writeFile(path, changed);
  const preview = await f.call("restore_preview", { tag: created.tag });
  await assert.rejects(f.call("restore_apply", { preview_id: preview.preview_id, approved_sha256: preview.approved_sha256 },
    randomUUID(), { ...f.host, checkpoint(phase) {
      if (phase === "trash-prepared") { writeFileSync(path, original); throw new Error("before-trash-dispatch-crash"); }
    } }), /before-trash-dispatch-crash/);
  await assert.rejects(reconcileLegacyKnowledgeSnapshots(f.storage, actor, f.host), /journalled Trash operation began/);
  const db = f.storage.connectNative();
  try { assert.equal(db.prepare("SELECT count(*) n FROM migration_runtime_trash").get().n, 0); }
  finally { db.close(); }
  assert.deepEqual(await readFile(path), original);
  await writeFile(path, changed);
  await reconcileLegacyKnowledgeSnapshots(f.storage, actor, f.host);
  assert.deepEqual(await readFile(path), original);
});

test("current content changing during private Git publication cannot acquire a completed restore receipt or index mutation", async t => {
  const f = await fixture(t), path = join(f.data, "notes/Original.md"), original = await readFile(path), created = await f.call("create");
  await writeFile(path, "# Before restore\n");
  const preview = await f.call("restore_preview", { tag: created.tag }), foreign = Buffer.from("# Concurrent source change after publication\n");
  await assert.rejects(f.call("restore_apply", { preview_id: preview.preview_id, approved_sha256: preview.approved_sha256 },
    randomUUID(), { ...f.host, checkpoint(phase) { if (phase === "published") writeFileSync(path, foreign); } }),
  error => error.effect === "unknown" && /during private Git publication/.test(error.message));
  assert.deepEqual(await readFile(path), foreign);
  const db = f.storage.connectNative();
  try {
    assert.equal(db.prepare("SELECT count(*) n FROM legacy_knowledge_snapshot_events").get().n, 2);
    assert.equal(db.prepare("SELECT count(*) n FROM legacy_knowledge_snapshot_intent").get().n, 1);
  } finally { db.close(); }
  await assert.rejects(reconcileLegacyKnowledgeSnapshots(f.storage, actor, f.host), /exact committed restore phase/);
  await writeFile(path, original);
  await reconcileLegacyKnowledgeSnapshots(f.storage, actor, f.host);
});

test("actual pre-intent process death leaves a registered stage, fences startup and only its admitted host discards owned preparation", async t => {
  const f = await fixture(t);
  await f.call("create");
  await f.storage.close();
  assert.throws(() => execFileSync(process.execPath, ["--eval", `(async()=>{
    const { Storage } = await import("./dist/storage.js");
    const { legacyKnowledgeSnapshot } = await import("./dist/legacy-knowledge-snapshots.js");
    const { randomUUID } = await import("node:crypto");
    const root=process.argv[1], storage=await Storage.open(root);
    await legacyKnowledgeSnapshot(storage,{id:"mcp:external",canWrite:true},
      {tool:"knowledge_snapshot_create",args:{},operationId:randomUUID()},
      {authorize:binding=>binding.workspaceRoot===root&&binding.actorId==="mcp:external",
       checkpoint:phase=>{if(phase==="staged")process.exit(71);}});
    })().catch(error=>{console.error(error);process.exit(1);});
  `, f.data], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", stdio: "pipe", env: { ...process.env, NODE_NO_WARNINGS: "1" } }),
  error => error.status === 71);
  if (process.platform !== "linux") {
    const owner = new DatabaseSync(join(f.data, "core.sqlite"));
    let expires;
    try { expires = Number(owner.prepare("SELECT lease_until FROM native_runtime_owner WHERE singleton=1").get().lease_until); }
    finally { owner.close(); }
    await new Promise(resolve => setTimeout(resolve, Math.max(0, expires - Date.now() + 50)));
  }
  await assert.rejects(f.open(), /preparation/);
  const deferred = await f.open(f.data, { deferRecovery: true });
  await assert.rejects(reconcileLegacyKnowledgeSnapshots(deferred, actor, { authorize: () => false }), /host-admitted/);
  assert((await readdir(join(f.data, "packages"))).some(name => name.startsWith(".snapshot-stage-")));
  await reconcileLegacyKnowledgeSnapshots(deferred, actor, f.host);
  assert(!(await readdir(join(f.data, "packages"))).some(name => name.startsWith(".snapshot-stage-")));
  await deferred.recover();
  assert.equal((await f.call("status", {}, randomUUID(), f.host, actor, deferred)).tags.length, 1);
});

test("no-change original restore may be reapproved with a new operation while historical exact result remains replayable", async t => {
  const f = await fixture(t), created = await f.call("create"), preview = await f.call("restore_preview", { tag: created.tag });
  assert.deepEqual(preview.changes, []);
  const args = { preview_id: preview.preview_id, approved_sha256: preview.approved_sha256 }, firstId = randomUUID();
  const first = await f.call("restore_apply", args, firstId), second = await f.call("restore_apply", args);
  assert.notEqual(first.before_snapshot, second.before_snapshot);
  assert.deepEqual(await f.call("restore_apply", args, firstId), first);
  assert.equal((await f.call("status")).tags.length, 3);
});

test("admitted public status waits for an active staged snapshot writer but never accepts an orphaned or pending mutation", async t => {
  const f = await fixture(t);
  let concurrent, premature = false, writerFinished = false;
  const created = await f.call("create", {}, randomUUID(), { ...f.host, checkpoint(phase) {
    if (phase === "staged") {
      concurrent = invokeAdmittedLegacyKnowledgeSnapshot(f.storage, actor, {
        tool: "knowledge_snapshot_status", args: {}, operationId: randomUUID(),
      }).then(value => {
        if (!writerFinished) premature = true;
        return { value };
      }, error => ({ error }));
    }
  } });
  writerFinished = true;
  const outcome = await concurrent;
  assert.equal(outcome.error, undefined);
  assert.equal(premature, false);
  assert.equal(outcome.value.latest.tag, created.tag);
  await assert.rejects(f.call("create", {}, randomUUID(), { ...f.host, checkpoint(phase) {
    if (phase === "intent") throw new Error("durable-orphan-is-not-an-active-writer");
  } }), /durable-orphan/);
  await assert.rejects(invokeAdmittedLegacyKnowledgeSnapshot(f.storage, actor, {
    tool: "knowledge_snapshot_status", args: {}, operationId: randomUUID(),
  }), /reconciliation/);
  await reconcileLegacyKnowledgeSnapshots(f.storage, actor, f.host);
  const foreign = { id: "another-actor", canWrite: true };
  await assert.rejects(invokeAdmittedLegacyKnowledgeSnapshot(f.storage, foreign, {
    tool: "knowledge_snapshot_status", args: {}, operationId: randomUUID(),
  }), /host-admitted/);
});

test("admitted snapshot core revalidates the actor and exact approved enrollment after the preflight lock is released", async t => {
  for (const change of ["actor", "admission"]) {
    const f = await fixture(t), who = { ...actor };
    const exclusive = f.storage.withWorkspaceExclusive.bind(f.storage);
    let first = true, originalAdmission, trigger;
    f.storage.withWorkspaceExclusive = async work => {
      const value = await exclusive(work);
      if (first) {
        first = false;
        if (change === "actor") who.id = "foreign-between-phases";
        else {
          const db = f.storage.connectNative();
          try {
            originalAdmission = db.prepare("SELECT payload,sha256 FROM legacy_knowledge_snapshot_admission WHERE singleton=1").get();
            trigger = db.prepare("SELECT sql FROM sqlite_master WHERE name='legacy_knowledge_snapshot_admission_no_update'").get().sql;
            const admission = JSON.parse(originalAdmission.payload);
            admission.authorityId = "different-between-phases";
            const payload = JSON.stringify(admission);
            db.exec("DROP TRIGGER legacy_knowledge_snapshot_admission_no_update");
            db.prepare("UPDATE legacy_knowledge_snapshot_admission SET payload=?,sha256=? WHERE singleton=1").run(payload, sha(payload));
            db.exec(trigger);
          } finally { db.close(); }
        }
      }
      return value;
    };
    try {
      await assert.rejects(invokeAdmittedLegacyKnowledgeSnapshot(f.storage, who, {
        tool: "knowledge_snapshot_status", args: {}, operationId: randomUUID(),
      }), /host-admitted/);
    } finally {
      f.storage.withWorkspaceExclusive = exclusive;
      if (originalAdmission) {
        const db = f.storage.connectNative();
        try {
          db.exec("DROP TRIGGER legacy_knowledge_snapshot_admission_no_update");
          db.prepare("UPDATE legacy_knowledge_snapshot_admission SET payload=?,sha256=? WHERE singleton=1")
            .run(originalAdmission.payload, originalAdmission.sha256);
          db.exec(trigger);
        } finally { db.close(); }
      }
    }
  }
});

test("private local Git creates exact original five-area content inventory, tag metadata and previews without user index or runtime state", async t => {
  const f = await fixture(t);
  const status = await f.call("status");
  assert.equal(status.enabled, false); assert.deepEqual(status.tags, []); assert.equal(status.latest, null);
  const bytes = await readFile(join(f.data, "notes/Original.md"));
  const operationId = randomUUID(), created = await f.call("create", { reason: "oracle exact bytes" }, operationId);
  const state = join(f.data, "packages/knowledge-snapshots");
  const original = originalOracle(f.data, state, "inventory");
  assert.equal(created.inventory_sha256, original.fingerprint);
  assert.deepEqual(created.areas, ["skills", "notes", "papers", "prompts", "scripts"]);
  assert.equal(created.private, true);
  const repository = join(state, "repository.git");
  const git = (...args) => execFileSync("git", [`--git-dir=${repository}`, ...args], { encoding: "utf8" }).trim();
  assert.equal(git("rev-parse", `${created.tag}^{commit}`), created.commit);
  assert.equal(JSON.parse(git("show", "-s", "--format=%B", created.commit)).inventory_sha256, original.fingerprint);
  assert.equal(git("show", `${created.commit}:notes/Original.md`), bytes.toString().trim());
  assert(!git("ls-tree", "-r", "--name-only", created.commit).includes("core.sqlite"));
  assert(!git("remote").length);
  assert.deepEqual(await f.call("create", { reason: "oracle exact bytes" }, operationId), created);
  await assert.rejects(f.call("create", { reason: "different" }, operationId), /different immutable request/);
  await writeFile(join(f.data, "notes/Original.md"), "---\ntitle: Original\n---\nChanged\n");
  await writeFile(join(f.data, "notes/Extra.md"), "# Extra\n");
  const preview = await f.call("restore_preview", { tag: created.tag });
  const oracleState = join(f.root, "oracle");
  await mkdir(oracleState);
  const { cp } = await import("node:fs/promises");
  await cp(repository, join(oracleState, "repository.git"), { recursive: true });
  const oracle = originalOracle(f.data, oracleState, "preview", { tag: created.tag });
  assert.deepEqual(preview.changes, oracle.changes);
  assert.equal(preview.privacy_policy, oracle.privacy_policy);
  assert.deepEqual(await readFile(join(f.data, "notes/Original.md")), Buffer.from("---\ntitle: Original\n---\nChanged\n"));
});

test("original-approved restore safety snapshot preserves exact bytes/modes and moves replaced/extra documents through native original-format Trash", async t => {
  const f = await fixture(t), old = await readFile(join(f.data, "notes/Original.md"));
  await chmod(join(f.data, "notes/Original.md"), 0o755);
  const created = await f.call("create");
  await writeFile(join(f.data, "notes/Original.md"), "---\ntitle: Original\n---\nNewer contents\n");
  await chmod(join(f.data, "notes/Original.md"), 0o644);
  await writeFile(join(f.data, "notes/Extra.md"), "---\ntitle: Extra\n---\nExtra contents\n");
  const preview = await f.call("restore_preview", { tag: created.tag });
  await assert.rejects(f.call("restore_apply", { preview_id: preview.preview_id, approved_sha256: "0".repeat(64) }), /changed/);
  const id = randomUUID(), result = await f.call("restore_apply", { preview_id: preview.preview_id, approved_sha256: preview.approved_sha256 }, id);
  assert.equal(result.status, "completed"); assert.equal(result.privacy_preserved, true);
  assert.deepEqual(await readFile(join(f.data, "notes/Original.md")), old);
  await assert.rejects(readFile(join(f.data, "notes/Extra.md")), { code: "ENOENT" });
  const { stat } = await import("node:fs/promises");
  assert.equal((await stat(join(f.data, "notes/Original.md"))).mode & 0o777, 0o755);
  const db = f.storage.connectNative();
  try {
    const trash = db.prepare("SELECT * FROM migration_runtime_trash").all();
    assert.equal(trash.length, 2);
    assert(trash.every(row => /^\d+-[a-f0-9]{10}$/.test(row.entry_id)));
    assert.equal(db.prepare("SELECT count(*) n FROM migration_runtime_deletions").get().n, 2);
    verifyLegacyKnowledgeSnapshots(db, f.data);
  } finally { db.close(); }
  assert.deepEqual(await f.call("restore_apply", { preview_id: preview.preview_id, approved_sha256: preview.approved_sha256 }, id), result);
  const status = await f.call("status");
  assert.equal(status.tags.length, 2);
  assert.match(status.latest.reason, /^before-restore:/);
  const oracle = join(f.root, "actual-original-restore"), oracleState = join(oracle, ".pkm/state/knowledge-snapshots");
  await mkdir(join(oracle, "notes"), { recursive: true }); await mkdir(oracleState, { recursive: true });
  const originalResult = originalOracle(oracle, oracleState, "restore", { node: process.execPath, original: old.toString(),
    changed: "---\ntitle: Original\n---\nNewer contents\n", extra: "---\ntitle: Extra\n---\nExtra contents\n" });
  for (const key of ["schema", "status", "applied", "privacy_preserved"]) assert.deepEqual(result[key], originalResult[key]);
  assert.equal(originalResult.actual_bytes, old.toString("hex")); assert.equal(originalResult.actual_mode, 0o755);
  assert.equal(originalResult.actual_trash_files.filter(path => path.endsWith("/payload")).length, 2);
});

test("private snapshot access refuses actor/root/worker tampering, linked source content, changed CAS and unsupported paired authorities", async t => {
  const f = await fixture(t), created = await f.call("create");
  for (const who of [{ id: "foreign", canWrite: true }, { ...actor, boardWorker: { boardSlug: "Board", digest: "a".repeat(64) } }]) {
    await assert.rejects(f.call("status", {}, randomUUID(), f.host, who), /host-admitted/);
  }
  await assert.rejects(f.call("status", {}, randomUUID(), { authorize: () => false }), /host-admitted/);
  const preview = await f.call("restore_preview", { tag: created.tag });
  await writeFile(join(f.data, "notes/Original.md"), "# Changed after preview\n");
  await assert.rejects(f.call("restore_apply", { preview_id: preview.preview_id, approved_sha256: preview.approved_sha256 }), /changed after preview/);
  await symlink(join(f.root, "secret"), join(f.data, "notes/Unsafe.md"));
  await assert.rejects(f.call("create"), /linked/);
  await rm(join(f.data, "notes/Unsafe.md"));
  await link(join(f.data, "notes/Original.md"), join(f.data, "notes/Linked.md"));
  await assert.rejects(f.call("create"), /linked/);
  await rm(join(f.data, "notes/Linked.md"));
  const bytes = await readFile(join(f.data, "packages/knowledge-snapshots/repository.git/config"));
  await writeFile(join(f.data, "packages/knowledge-snapshots/repository.git/config"), Buffer.concat([bytes, Buffer.from("\n[remote \"forged\"]\nurl = https://never.invalid\n")]));
  await assert.rejects(f.call("status"), /differs from its committed/);
});

test("persistent scheduling is denied without actual native host scheduler authority and original time-zone calculations are preserved", async t => {
  const f = await fixture(t);
  await assert.rejects(f.call("configure", { enabled: false }), /explicitly authorized native scheduler/);
  const applied = [];
  const host = { ...f.host, configureSchedule: async request => {
    applied.push(request);
    await mkdir(join(f.root, "host-scheduler"), { recursive: true });
    await writeFile(join(f.root, "host-scheduler", `${request.unit}.json`), JSON.stringify(request));
  } };
  const configured = await f.call("configure", { enabled: true, local_time: "17:00", timezone: "America/Los_Angeles" }, randomUUID(), host);
  assert.equal(configured.enabled, true); assert.equal(applied.length, 1);
  assert.equal(applied[0].privateGitRoot, join(f.data, "packages/knowledge-snapshots/repository.git"));
  const timing = originalOracle(f.data, join(f.data, "packages/knowledge-snapshots"), "timing", {
    local_time: "17:00", timezone: "America/Los_Angeles", now: configured.updated_utc,
  });
  for (const key of ["next_run_utc", "next_run_local", "timezone", "local_time", "abbreviation"]) assert.equal(configured[key], timing[key]);
  assert.equal((await f.call("status")).enabled, true);
  assert.equal(JSON.parse(await readFile(join(f.root, "host-scheduler", `${configured.unit}.json`))).enabled, true);
  await assert.rejects(f.call("configure", { local_time: "25:00" }, randomUUID(), host), /HH:MM/);
});

test("original current privacy is captured as original Git content but changed current policy survives restore and relocated schema25 backup", async t => {
  const f = await fixture(t);
  await chmod(join(f.data, "prompts/Prompt.txt"), 0o751);
  await mkdir(join(f.data, ".pkm"), { mode: 0o700 });
  const policy = Buffer.from('{"schema":1,"private":{"notes":["Original"]}}\r\n');
  await writeFile(join(f.data, ".pkm/content-privacy.json"), policy, { mode: 0o600 });
  const created = await f.call("create"), state = join(f.data, "packages/knowledge-snapshots");
  assert.deepEqual(execFileSync("git", [`--git-dir=${state}/repository.git`, "show", `${created.commit}:.pkm/content-privacy.json`]), policy);
  const stricter = Buffer.from('{"schema":1,"private":{"notes":["Original","More private notes"]}}\n');
  await writeFile(join(f.data, ".pkm/content-privacy.json"), stricter);
  await writeFile(join(f.data, "notes/Original.md"), "# Current\n");
  const preview = await f.call("restore_preview", { tag: created.tag });
  assert(!preview.changes.some(change => change.path.startsWith(".pkm/")));
  await f.call("restore_apply", { preview_id: preview.preview_id, approved_sha256: preview.approved_sha256 });
  assert.deepEqual(await readFile(join(f.data, ".pkm/content-privacy.json")), stricter);
  await f.storage.close();
  const restarted = await f.open();
  assert.equal((await f.call("status", {}, randomUUID(), f.host, actor, restarted)).tags.length, 2);
  const runtime = await createNativeRuntime({ storage: restarted }), backup = join(f.root, "backup");
  try { await createWorkspaceBackup(restarted, backup, { acquireQuiescence: runtime.acquireWorkspaceQuiescence }); }
  finally { await runtime.close(); }
  const manifest = JSON.parse(await readFile(join(backup, ".pkm-workspace-backup.json")));
  assert.equal(manifest.databaseUserVersion, 25);
  assert.equal((await lstat(join(backup, "prompts/Prompt.txt"))).mode & 0o777, 0o600);
  assert.equal(manifest.files.find(file => file.path === "prompts/Prompt.txt").mode, 0o751);
  for (const file of [...manifest.files, { path: ".pkm-workspace-backup.json" }])
    assert.equal((await lstat(join(backup, file.path))).mode & 0o777, 0o600, `Private archive stores non-executable bytes: ${file.path}`);
  const relocated = join(f.root, "relocated");
  await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority });
  const restored = await f.open(relocated), db = restored.connectNative();
  try { verifyLegacyKnowledgeSnapshots(db, relocated); } finally { db.close(); }
  assert.deepEqual(await readFile(join(relocated, ".pkm/content-privacy.json")), stricter);
  assert.equal((await lstat(join(relocated, "prompts/Prompt.txt"))).mode & 0o777, 0o751);
  const changedModes = structuredClone(manifest);
  changedModes.files.find(file => file.path === "packages/knowledge-snapshots/repository.git/config").mode = 0o777;
  await writeFile(join(backup, ".pkm-workspace-backup.json"), JSON.stringify(changedModes));
  await assert.rejects(restoreWorkspaceBackup(backup, join(f.root, "forged-source-mode"), { nativeRestoreAuthority }), /snapshot repository|snapshot.*receipt/i);
  await writeFile(join(backup, ".pkm-workspace-backup.json"), JSON.stringify(manifest));
  await assert.rejects(f.call("status", {}, randomUUID(), { authorize: () => true }, actor, restored), /host-admitted/);
  await assert.rejects(admitLegacyKnowledgeSnapshots(restored, actor, {
    authorityId: "cannot-rebind-relocation", authorize: () => true,
  }), /host-admitted/);
  const forged = join(f.root, "forged");
  await cp(backup, forged, { recursive: true });
  const bad = new DatabaseSync(join(forged, "core.sqlite"));
  try {
    const sql = bad.prepare("SELECT sql FROM sqlite_master WHERE name='legacy_knowledge_snapshot_events_no_update'").get().sql;
    bad.exec("DROP TRIGGER legacy_knowledge_snapshot_events_no_update");
    bad.exec("UPDATE legacy_knowledge_snapshot_events SET sha256=printf('%064d',0) WHERE sequence=1");
    bad.exec(sql);
  } finally { bad.close(); }
  const bytes = await readFile(join(forged, "core.sqlite"));
  Object.assign(manifest.files.find(file => file.path === "core.sqlite"), { size: bytes.length, sha256: sha(bytes) });
  manifest.totalBytes = manifest.files.reduce((sum, file) => sum + file.size, 0);
  await writeFile(join(forged, ".pkm-workspace-backup.json"), JSON.stringify(manifest));
  await assert.rejects(restoreWorkspaceBackup(forged, join(f.root, "forged-restored"), { nativeRestoreAuthority }), /Snapshot event digest|snapshot/i);
});

for (const boundary of ["intent", "trashed", "restored", "published"]) {
  test(`durable original restore ${boundary} fault denies ordinary startup/backup and only exact native host reconciles`, async t => {
    const f = await fixture(t), original = await readFile(join(f.data, "notes/Original.md")), created = await f.call("create");
    const runtime = await createNativeRuntime({ storage: f.storage });
    await writeFile(join(f.data, "notes/Original.md"), "# Changed before restore\n");
    await writeFile(join(f.data, "notes/Extra.md"), "# Extra\n");
    const preview = await f.call("restore_preview", { tag: created.tag }), operationId = randomUUID();
    const fault = { ...f.host, checkpoint(phase) { if (phase === boundary) throw new Error(`fault-${phase}`); } };
    await assert.rejects(f.call("restore_apply", {
      preview_id: preview.preview_id, approved_sha256: preview.approved_sha256,
    }, operationId, fault), error => error.effect === "unknown" && error.message.includes(`fault-${boundary}`));
    const db = f.storage.connectNative();
    try { assert.throws(() => verifyLegacyKnowledgeSnapshots(db, f.data), /reconciliation/); }
    finally { db.close(); }
    try {
      await assert.rejects(createWorkspaceBackup(f.storage, join(f.root, "pending-backup"), {
        acquireQuiescence: runtime.acquireWorkspaceQuiescence,
      }), /reconciliation/);
    } finally { await runtime.close(); }
    await f.storage.close();
    await assert.rejects(f.open(), /reconciliation/);
    const storage = await f.open(f.data, { deferRecovery: true });
    await assert.rejects(reconcileLegacyKnowledgeSnapshots(storage, actor, { authorize: () => false }), /host-admitted/);
    const reconciled = await reconcileLegacyKnowledgeSnapshots(storage, actor, f.host);
    assert.equal(reconciled.status, "completed");
    assert.deepEqual(await readFile(join(f.data, "notes/Original.md")), original);
    await assert.rejects(readFile(join(f.data, "notes/Extra.md")), { code: "ENOENT" });
    assert.deepEqual(await f.call("restore_apply", {
      preview_id: preview.preview_id, approved_sha256: preview.approved_sha256,
    }, operationId, f.host, actor, storage), reconciled);
    await storage.recover();
  });
}

test("pending original create safely resumes exact journal-owned partial temporary/hardlink publication but denies unowned stages", async t => {
  const f = await fixture(t), operationId = randomUUID();
  await assert.rejects(f.call("create", {}, operationId, { ...f.host, checkpoint(phase) {
    if (phase === "intent") throw new Error("known-publication-fault");
  } }), /known-publication-fault/);
  const state = join(f.data, "packages/knowledge-snapshots");
  await mkdir(state);
  await writeFile(join(state, `.pkm-snapshot-${operationId}`), "partial journal-owned publication");
  await reconcileLegacyKnowledgeSnapshots(f.storage, actor, f.host);
  assert.equal((await f.call("status")).tags.length, 1);
  const secondId = randomUUID();
  await assert.rejects(f.call("create", {}, secondId, { ...f.host, checkpoint(phase) {
    if (phase === "intent") throw new Error("linked-publication-fault");
  } }), /linked-publication-fault/);
  const db = f.storage.connectNative();
  let added;
  try {
    const intent = JSON.parse(db.prepare("SELECT payload FROM legacy_knowledge_snapshot_intent WHERE singleton=1").get().payload);
    added = intent.after.files.find(row => !intent.before.files.some(prior => prior.path === row.path));
  } finally { db.close(); }
  const destination = join(state, added.path), temporary = join(dirname(destination), `.pkm-snapshot-${secondId}`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(temporary, Buffer.from(added.bytes, "base64")); await chmod(temporary, added.mode);
  await link(temporary, destination);
  await reconcileLegacyKnowledgeSnapshots(f.storage, actor, f.host);
  assert.equal((await f.call("status")).tags.length, 2);
  const unknown = join(f.data, "packages", `.snapshot-stage-${randomUUID()}`);
  await mkdir(unknown);
  await writeFile(join(unknown, "unowned"), "Never generically deleted");
  await assert.rejects(reconcileLegacyKnowledgeSnapshots(f.storage, actor, f.host), /unowned private snapshot stage/);
  assert.equal((await readFile(join(unknown, "unowned"))).toString(), "Never generically deleted");
});

test("configuration effect ambiguity reconciles the exact durable idempotency key and host schedule, never silently disables", async t => {
  const f = await fixture(t), operationId = randomUUID(), schedule = join(f.root, "persistent-host-schedule.json"), observed = [];
  let fault = true;
  const host = { ...f.host, configureSchedule: async request => {
    observed.push(request.operationId);
    await writeFile(schedule, JSON.stringify(request));
    if (fault) { fault = false; throw new Error("host-schedule-installed-before-crash"); }
  } };
  await assert.rejects(f.call("configure", { enabled: true }, operationId, host), error => error.effect === "unknown");
  assert.equal(JSON.parse(await readFile(schedule)).enabled, true);
  await assert.rejects(reconcileLegacyKnowledgeSnapshots(f.storage, actor, f.host), /scheduler reconciliation/);
  const result = await reconcileLegacyKnowledgeSnapshots(f.storage, actor, host);
  assert.equal(result.enabled, true); assert.deepEqual(observed, [operationId, operationId]);
  assert.equal((await f.call("status")).enabled, true);
  const disabled = await f.call("configure", { enabled: false }, randomUUID(), host);
  assert.equal(disabled.enabled, false);
  assert.equal(JSON.parse(await readFile(schedule)).enabled, false);
});

test("native identity collisions are rejected before creating original snapshots, safety tags, intents or Trash", async t => {
  const f = await fixture(t);
  await writeFile(join(f.data, "notes/Original.md"), "---\ndocumentId: duplicate\nknowledgeId: duplicate\n---\nOld\n");
  await f.call("create");
  await writeFile(join(f.data, "notes/Extra.md"), "---\ndocumentId: duplicate\nknowledgeId: duplicate\n---\nNew\n");
  await assert.rejects(f.call("create"), /Duplicate/);
  const db = f.storage.connectNative();
  try {
    assert.equal(db.prepare("SELECT count(*) n FROM legacy_knowledge_snapshot_events").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM legacy_knowledge_snapshot_intent").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM migration_runtime_trash").get().n, 0);
  } finally { db.close(); }
});

test("native MCP consumer consumes only explicitly enrolled operation scope without fabricating a live scheduler or authority", async t => {
  const f = await fixture(t, ["knowledge_snapshot_status", "knowledge_snapshot_create"]);
  const invoke = (tool, args = {}, who = actor) => invokeAdmittedLegacyKnowledgeSnapshot(f.storage, who, {
    tool: `knowledge_snapshot_${tool}`, args, operationId: randomUUID(),
  });
  assert.equal((await invoke("status")).enabled, false);
  assert.equal((await invoke("status", {}, { ...actor, canWrite: false })).enabled, false);
  await assert.rejects(invoke("create", {}, { ...actor, canWrite: false }), /host-admitted/);
  const created = await invoke("create");
  assert.equal(created.private, true);
  await assert.rejects(invoke("restore_preview", { tag: created.tag }), /host-admitted/);
  await assert.rejects(invoke("configure", { enabled: false }), /host-admitted/);
  await assert.rejects(invoke("status", {}, { id: "another", canWrite: true }), /host-admitted/);
  const full = await fixture(t);
  await assert.rejects(invokeAdmittedLegacyKnowledgeSnapshot(full.storage, actor, {
    tool: "knowledge_snapshot_configure", args: { enabled: false }, operationId: randomUUID(),
  }), /explicitly authorized native scheduler/);
  await mkdir(join(f.data, ".pkm"));
  await writeFile(join(f.data, ".pkm/NOT-content-privacy.json"), "No old runtime-state admission");
  await assert.rejects(invoke("status"), { code: "INVALID_WORKSPACE" });
});

test("original Board Note, missing-only recovery and private Git owners coexist without downgrading schema25 through restart/backup", async t => {
    const f = await fixture(t);
    const board = await createNativeLegacyTodoBoard(f.storage, actor, {
      title: "Snapshot Board 检验", category: "Native", operationId: randomUUID(),
    }, (who, operation) => who.id === actor.id && operation === "todo.board.create");
    assert(board);
    const evidence = join(f.root, "evidence"), recoveredBytes = Buffer.from("---\r\ntitle: Recovery\r\n---\r\nMissing-only recovered.\r\n");
    await mkdir(join(evidence, "blobs"), { recursive: true });
    const plan = Buffer.from(JSON.stringify({ schema: "pkm.knowledge-recovery/v1", knowledgeRoot: f.data,
      files: [{ path: "notes/Recovered.md", sha256: sha(recoveredBytes), mode: "100644" }] }));
    await writeFile(join(evidence, "plan.json"), plan);
    await writeFile(join(evidence, "blobs", sha(recoveredBytes)), recoveredBytes);
    await admitLegacyKnowledgeRecovery(f.storage, actor, { evidenceRoot: evidence, auditRoot: evidence,
      expectedPlanSha256: sha(plan), authorityId: "snapshot-coexistence-exact-evidence",
      authorize: binding => binding.evidenceRoot === evidence && binding.actorId === actor.id && binding.planSha256 === sha(plan) });
    await legacyKnowledgeRecovery(f.storage, actor, { tool: "knowledge_recovery_apply",
      arguments: { evidence_directory: evidence, approved_plan_sha256: sha(plan) } });
    const created = await f.call("create");
    assert(created.files >= 4);
    const db = f.storage.connectNative();
    try { assert.equal(db.prepare("PRAGMA user_version").get().user_version, 25); } finally { db.close(); }
    await rm(evidence, { recursive: true });
    await f.storage.close();
    const storage = await f.open(), runtime = await createNativeRuntime({ storage });
    const backup = join(f.root, "coexistence-backup");
    try { await createWorkspaceBackup(storage, backup, { acquireQuiescence: runtime.acquireWorkspaceQuiescence }); }
    finally { await runtime.close(); }
    const relocated = join(f.root, "coexistence-relocated");
    await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority });
    const restored = await f.open(relocated), check = restored.connectNative();
    try { assert.equal(check.prepare("PRAGMA user_version").get().user_version, 25); } finally { check.close(); }
    assert.deepEqual(await readFile(join(relocated, "notes/Recovered.md")), recoveredBytes);
});
