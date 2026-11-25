import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { RootOwner } from "../dist/root-owner.js";
import { initialize } from "../dist/storage.js";

function document(id, title = id, content = `${id} body`) {
  return `---\ndocumentId: ${id}\ntitle: ${title}\nrevision: 1\ndeleted: false\n---\n${content}\n`;
}
async function fixture(t, options = {}, count = 2) {
  const directory = resolve(".migration-test-work", `fresh-store-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await initialize(join(directory, "root"));
  for (let index = 0; index < count; index++)
    await writeFile(join(root, "notes", `entry-${index}.md`), document(`entry-${index}`, `Title ${index}`, `needle body ${index}`));
  const owner = await RootOwner.open(root, options);
  const full = await owner.ensureFull();
  t.after(async () => { await owner.close(); await rm(directory, { recursive: true, force: true }); });
  const read = query => owner.withReadScope(scope => full.storage.readLegacyNotes(scope, query));
  return { root, owner, full, read };
}
function connection(root) { return new DatabaseSync(join(root, "core.sqlite")); }
function listArguments(extra = {}) { return { kind: "list", arguments: { limit: 100, ...extra } }; }

test("actual private Store port cold-builds exact text, reuses the worker and writes nothing on zero delta", async t => {
  const f = await fixture(t, { prepareNative: async () => ({
    trash: { layoutVersion: "pkm.trash-lifecycle/v1" },
  }) });
  await mkdir(join(f.root, "skills"), { recursive: true, mode: 0o700 });
  await writeFile(join(f.root, "skills/skill.md"), document("skill-id", "Strict Skill"));
  const workerId = f.full.storage.worker.threadId, lease = { ...f.owner.workspaceLease() };
  const first = await f.read(listArguments());
  assert.equal(first.kind, "fresh");
  assert.equal(first.generation, 1);
  assert.match(first.text, /Title 0/);
  const db = connection(f.root);
  try {
    const version = db.prepare("PRAGMA data_version").get().data_version;
    const rows = db.prepare("SELECT * FROM documents ORDER BY id").all();
    assert.equal(rows.find(row => row.id === "skill-id").area, "skills");
    const warm = await f.read(listArguments());
    assert.equal(warm.kind, "fresh");
    assert.equal(warm.text, first.text);
    assert.equal(warm.generation, first.generation);
    assert.equal(db.prepare("PRAGMA data_version").get().data_version, version);
    assert.deepEqual(db.prepare("SELECT * FROM documents ORDER BY id").all(), rows);
    assert.equal(f.full.storage.worker.threadId, workerId);
    assert.deepEqual(f.owner.workspaceLease(), lease);
  } finally { db.close(); }
});

test("actual worker reconciles renamed/removed/changed documents by qualified delta and foreign FTS/index edits by rebuild", async t => {
  const f = await fixture(t);
  const first = await f.read({ kind: "legacy-lexical", arguments: { query: "needle" } });
  assert.equal(first.kind, "fresh");
  assert.match(first.text, /entry-0/);
  await rename(join(f.root, "notes/entry-0.md"), join(f.root, "notes/renamed.md"));
  await rm(join(f.root, "notes/entry-1.md"));
  await writeFile(join(f.root, "notes/renamed.md"), document("changed-id", "Changed title", "needle changed"));
  const changed = await f.read(listArguments());
  assert.equal(changed.kind, "fresh");
  assert.equal(changed.generation, first.generation + 1);
  assert.match(changed.text, /Changed title/);
  const db = connection(f.root);
  try {
    assert.deepEqual(db.prepare("SELECT id,title,path,deleted FROM documents").all().map(row => ({ ...row })), [
      { id: "changed-id", title: "Changed title", path: "renamed.md", deleted: 0 },
    ]);
    db.exec("BEGIN IMMEDIATE; UPDATE documents SET title='forged-cache'; DELETE FROM fresh_note_query_fts; COMMIT;");
    const repaired = await f.read({ kind: "legacy-lexical", arguments: { query: "needle" } });
    assert.equal(repaired.kind, "fresh");
    assert.equal(repaired.generation, changed.generation + 1);
    assert.deepEqual(JSON.parse(repaired.text), [{ slug: "renamed", title: "Changed title", type: "general" }]);
    assert.equal(db.prepare("SELECT title FROM documents WHERE id='changed-id'").get().title, "Changed title");
    const stable = await f.read({ kind: "legacy-lexical", arguments: { query: "needle" } });
    assert.equal(stable.kind, "fresh");
    assert.equal(stable.generation, repaired.generation);
  } finally { db.close(); }
});

test("private Store port rejects serialized/expired scopes and explicitly delegates complex native context", async t => {
  const f = await fixture(t);
  await assert.rejects(f.full.storage.readLegacyNotes({
    root: f.root, workspaceId: await f.owner.workspaceId(), full: f.full, assertHeld() {},
  }, listArguments()), { code: "STORAGE_UNAVAILABLE" });
  let retained;
  await f.owner.withReadScope(scope => { retained = scope; });
  await assert.rejects(f.full.storage.readLegacyNotes(retained, listArguments()), { code: "STORAGE_UNAVAILABLE" });
  const db = connection(f.root);
  try { assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='fresh_note_query_meta'").get(), undefined); }
  finally { db.close(); }
  const advanced = await fixture(t, { native: {} });
  assert.deepEqual(await advanced.read(listArguments()), { kind: "canonical-required", reason: "native-context" });
  const contextDb = connection(advanced.root);
  try { assert.equal(contextDb.prepare("SELECT 1 FROM sqlite_master WHERE name='fresh_note_query_meta'").get(), undefined); }
  finally { contextDb.close(); }
});

test("private Store port catches real SQL lease expiry before publishing the actual worker result", { skip: process.platform !== "linux" }, async t => {
  const directory = resolve(".migration-test-work", `fresh-store-expiry-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await initialize(join(directory, "root"));
  await writeFile(join(root, "notes/entry.md"), document("entry"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, ["-e", `
    (async()=>{
    const {DatabaseSync}=await import("node:sqlite");
    const {join}=await import("node:path");
    const {RootOwner}=await import(process.argv[1]);
    const root=process.argv[2], owner=await RootOwner.open(root), full=await owner.ensureFull();
    full.storage.worker.prependListener("message",message=>{
      if(message.result?.kind!=="fresh") return;
      const db=new DatabaseSync(join(root,"core.sqlite"));
      try { db.exec("UPDATE native_runtime_owner SET lease_until=0 WHERE singleton=1"); } finally { db.close(); }
    });
    try { await owner.withReadScope(scope=>full.storage.readLegacyNotes(scope,{kind:"list",arguments:{}})); console.log('{"unexpected":true}'); }
    catch(error) { console.log(JSON.stringify({code:error.code,effect:error.effect})); }
    await new Promise(()=>{});
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `, new URL("../dist/root-owner.js", import.meta.url).href, root], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise(resolveExit => child.once("close", resolveExit));
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  try {
    const message = await new Promise((resolveMessage, reject) => {
      child.stdout.once("data", data => resolveMessage(JSON.parse(data.toString())));
      child.once("error", reject);
      child.once("close", code => reject(new Error(`Owner exited ${code}: ${stderr}`)));
    });
    assert.deepEqual(message, { code: "STORAGE_UNAVAILABLE", effect: "unknown" });
  } finally { child.kill("SIGKILL"); await exited; }
  const reopened = await RootOwner.open(root);
  await reopened.close();
});

test("private Store result cannot publish after global journals or native private root controls change", async t => {
  for (const privateRoot of [false, true]) {
    const f = await fixture(t);
    const change = message => {
      if (message.result?.kind !== "fresh") return;
      if (privateRoot) mkdirSync(join(f.root, ".pkm-room-admission"), { mode: 0o700 });
      else {
        const db = connection(f.root);
        try { db.exec("INSERT INTO pending_todo VALUES(1,'pending','f','actor','todo.item.add','board',NULL,'{}','{}')"); }
        finally { db.close(); }
      }
    };
    f.full.storage.worker.prependListener("message", change);
    await assert.rejects(f.read(listArguments()), { code: "RECOVERY_REQUIRED" });
    f.full.storage.worker.removeListener("message", change);
    if (!privateRoot) {
      const db = connection(f.root);
      try { assert.equal(db.prepare("SELECT operation_id FROM pending_todo").get().operation_id, "pending"); }
      finally { db.close(); }
    }
  }
});

test("actual external source race invalidates global A/B reads without publishing or advancing cache generation", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t, {}, 350);
  const baseline = await f.read(listArguments());
  assert.equal(baseline.kind, "fresh");
  const target = join(f.root, "notes/entry-0.md");
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {writeFileSync,renameSync} from "node:fs";
    const target=process.argv[1]; let n=0;
    const write=()=>{writeFileSync(target+".swap","---\\ndocumentId: entry-0\\ntitle: race "+(++n)+"\\nrevision: 1\\ndeleted: false\\n---\\nbody "+n+"\\n");renameSync(target+".swap",target);};
    write();process.stdout.write("ready\\n");setInterval(write,1);
  `, target], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise(resolveExit => child.once("close", resolveExit));
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  await new Promise((resolveReady, reject) => {
    child.stdout.once("data", resolveReady);
    child.once("error", reject);
    child.once("close", code => reject(new Error(`Writer exited ${code}: ${stderr}`)));
  });
  try {
    await assert.rejects(f.read(listArguments()), { code: "CONFLICT" });
  } finally { child.kill("SIGTERM"); await exited; await rm(`${target}.swap`, { force: true }); }
  const db = connection(f.root);
  try { assert.equal(db.prepare("SELECT generation FROM fresh_note_query_meta").get().generation, baseline.generation); }
  finally { db.close(); }
  const after = await f.read(listArguments());
  assert.equal(after.kind, "fresh");
  assert.equal(after.generation, baseline.generation + 1);
  assert.match(await readFile(target, "utf8"), /race/);
});
