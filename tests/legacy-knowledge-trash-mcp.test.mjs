import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { legacyKnowledgeTrash } from "../dist/legacy-knowledge-trash.js";
import { MigrationRuntime, readOriginalTrashDeletionHistory } from "../dist/migration-runtime.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { legacyManagedFixture, closeLegacyManagedFixture } from "./legacy-managed-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "legacy");
const hash = text => createHash("sha256").update(text).digest("hex");
const actor = { id: "mcp:external", canWrite: true };
const bytes = Buffer.from([255, 0, 128, 13, 10, 9]);
function content(id, name) {
  return `---\r\ndocumentId: ${id}\r\nknowledgeId: knowledge_${hash(id).slice(0, 24)}\r\nrevision: 7\r\ntitle: ${name}\r\nname: ${name}\r\naliases: [note:${id}-old]\r\nlinks: []\r\ncustom: exact\r\n---\r\n![pair](${name}.assets/bytes.bin)\r\n`;
}
async function put(data, area, name, raw) {
  await mkdir(join(data, area, "Folder", `${name}.assets`), { recursive: true });
  await writeFile(join(data, area, "Folder", `${name}.md`), raw);
  await writeFile(join(data, area, "Folder", `${name}.assets/bytes.bin`), bytes);
}
function original(root, area, path, entry) {
  return JSON.parse(execFileSync(process.execPath, ["-e", `
    const crypto=require("node:crypto"), NativeDate=Date;
    global.Date=class extends NativeDate {
      constructor(...args){ super(...(args.length?args:[Number(process.argv[4])])); }
      static now(){return Number(process.argv[4]);}
    };
    crypto.randomBytes=n=>n===5?Buffer.from(process.argv[5],"hex"):Buffer.alloc(n,1);
    const store=require(process.argv[1]+"/dist/knowledge/filestore");
    store.setStorePath(process.argv[2]);
    console.log(JSON.stringify({ok:true,trash:store.knowledgePathMoveToTrash(process.argv[3],process.argv[6])}));
  `, repository, root, area, entry.id.split("-")[0], entry.id.split("-")[1], path], { encoding: "utf8" }));
}

for (const profile of ["compact", "legacy"]) test(`original Trash transport, metadata/oracle, journal restart and byte-preserving restore (${profile})`,
  { timeout: 90_000 }, async t => {
    const parent = join(root, "tests", `.legacy-trash-mcp-${randomUUID()}`);
    await mkdir(parent);
    let client;
    t.after(async () => { try { await client?.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
    const data = await initialize(join(parent, "workspace"));
    const oracle = join(parent, "original");
    await mkdir(oracle);
    const managed = await legacyManagedFixture(parent);
    const originals = [];
    for (const [area, name] of [["notes", "Note"], ["skills", "Skill"], ["papers", "Paper"], ["notes", "Reviewed"]]) {
      const raw = content(`${area}-${name}`, name).replace(/^(?:documentId|knowledgeId):[^\r\n]*\r?\n/gm, "");
      originals.push({ area, name, raw });
      await put(data, area, name, raw);
      await put(oracle, area, name, raw);
    }
    const connect = async () => {
      client = new Client({ name: "original-trash", version: "1.0.0" });
      await client.connect(new StdioClientTransport({ command: "python3",
        args: [join(root, "compat/legacy-compact-mcp.py"), "--data", data, "--node", process.execPath,
          "--allow-writes", "--managed-generation", managed],
        env: { ...process.env, PKM_CAPABILITY_PROFILE: profile, PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe" }));
    };
    await connect();
    const entries = [];
    for (const { area, name, raw } of originals) {
      const reviewed = name === "Reviewed";
      const tool = reviewed ? "knowledge_file_trash" : `delete_${area === "notes" ? "note" : area === "skills" ? "skill" : "paper"}`;
      const args = reviewed ? { area, path: `Folder/${name}.md`, expected_sha256: hash(raw) }
        : area === "skills" ? { name } : { slug: `Folder/${name}` };
      const result = await client.callTool({ name: "capability_call", arguments: {
        operation: `mcp.tool.${tool}`, version: 1, arguments: args,
      } });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const value = reviewed ? result.structuredContent : JSON.parse(result.content[0].text);
      assert.equal(value.ok, true);
      assert.match(value.trash.id, /^[0-9]+-[a-f0-9]{10}$/);
      assert.deepEqual(value, original(oracle, area, `Folder/${name}.md`, value.trash));
      assert.equal(await readFile(join(data, area, ".trash", value.trash.id, "payload"), "utf8"), raw);
      assert.deepEqual(await readFile(join(data, area, ".trash", value.trash.id, "assets/bytes.bin")), bytes);
      const originalList = JSON.parse(execFileSync(process.execPath, ["-e", `
        const store=require(process.argv[1]+"/dist/knowledge/filestore");store.setStorePath(process.argv[2]);
        console.log(JSON.stringify(process.argv[3]==="skills"?store.skillTrashList():store.knowledgeTrashList(process.argv[3])));
      `, repository, data, area], { encoding: "utf8" }));
      assert(originalList.some(entry => entry.id === value.trash.id), "Actual original UI list must see native Trash identities");
      entries.push(value.trash);
    }
    const absent = await client.callTool({ name: "delete_skill", arguments: { name: "missing" } });
    assert.deepEqual(JSON.parse(absent.content[0].text), { ok: true, name: "missing", absent: true });
    for (const [name, args] of [
      ["delete_note", { slug: "../escape" }],
      ["knowledge_file_trash", { area: "notes", path: "missing.md", expected_sha256: "0".repeat(64) }],
      ["delete_note", { slug: "System/Protected" }],
      ["delete_note", { slug: "missing", actorId: "user:local" }],
    ]) assert.equal((await client.callTool({ name, arguments: args })).isError, true);
    await closeLegacyManagedFixture(client);
    await connect();
    const afterRestart = await client.callTool({ name: "delete_note", arguments: { slug: "Folder/Note" } });
    assert.deepEqual(JSON.parse(afterRestart.content[0].text), { ok: true, absent: true });
    await closeLegacyManagedFixture(client);
    client = undefined;
    const storage = await Storage.open(data);
    const native = await createNativeRuntime({ storage, trash: { layoutVersion: "pkm.trash-lifecycle/v1" } });
    try {
      const database = new DatabaseSync(join(data, "core.sqlite"), { readOnly: true });
      try {
        const rows = database.prepare("SELECT entry_id,plan_json FROM migration_runtime_trash").all();
        assert.equal(rows.length, 4);
        for (const row of rows) {
          const plan = JSON.parse(row.plan_json);
          assert.notEqual(plan.operationId, row.entry_id);
          assert.equal(plan.entryId, row.entry_id);
          assert.equal(database.prepare("SELECT actor_id FROM receipts WHERE operation_id=?").get(plan.operationId).actor_id, actor.id);
          const arguments_ = { operationId: plan.operationId, area: plan.area, path: plan.path, kind: plan.targetKind,
            expectedTreeSha256: plan.expectedTreeSha256, expectedScanRevision: plan.expectedScanRevision, entryIdFormat: "original" };
          const replay = await native.core.dispatch("capability_call", { operation: "knowledge.trash.move", version: 1, arguments: arguments_ }, actor);
          assert.equal(replay.error, undefined, JSON.stringify(replay));
          assert.equal(replay.result.entryId, plan.entryId);
          const spoof = await native.core.dispatch("capability_call", { operation: "knowledge.trash.move", version: 1, arguments: arguments_ },
            { id: "other:actor", canWrite: true });
          assert.equal(spoof.error.code, "CONFLICT");
        }
        const workspaceId = database.prepare("SELECT workspace_id FROM migration_runtime_trash LIMIT 1").get().workspace_id;
        const originalHistory = JSON.parse(await readFile(join(oracle, ".pkm/state/knowledge-deletions.json"), "utf8"));
        assert.deepEqual(readOriginalTrashDeletionHistory(database, workspaceId), originalHistory);
      } finally { database.close(); }
      for (let index = 0; index < entries.length; index++) {
        const { scanMarkdown } = await import("../dist/markdown.js");
        const pins = scanMarkdown(data).map(d => ({ id: d.record.id, area: d.record.area, path: d.record.path,
          revision: d.record.revision, sha256: d.record.sha256 }));
        const response = await native.core.dispatch("capability_call", { operation: "knowledge.trash.restore", version: 1,
          arguments: { entryId: entries[index].id, operationId: randomUUID(), expectedScanRevision: hash(JSON.stringify(pins)) } }, actor);
        assert.equal(response.error, undefined, JSON.stringify(response));
        const { area, name, raw } = originals[index];
        assert.equal(await readFile(join(data, area, "Folder", `${name}.md`), "utf8"), raw);
        assert.deepEqual(await readFile(join(data, area, "Folder", `${name}.assets/bytes.bin`)), bytes);
      }
      const restoredDatabase = new DatabaseSync(join(data, "core.sqlite"), { readOnly: true });
      try { assert.equal(restoredDatabase.prepare("SELECT COUNT(*) AS count FROM migration_runtime_deletions").get().count, 0); }
      finally { restoredDatabase.close(); }
    } finally { await native.close(); await storage.close(); }
  });

test("original Trash selection CAS refuses competing edits and never retries a mutation", async t => {
  const parent = join(root, "tests", `.legacy-trash-race-${randomUUID()}`);
  await mkdir(parent);
  const data = await initialize(join(parent, "workspace"));
  const raw = content("race", "Pinned");
  await put(data, "notes", "Pinned", raw);
  const storage = await Storage.open(data);
  const native = await createNativeRuntime({ storage, trash: { layoutVersion: "pkm.trash-lifecycle/v1" } });
  t.after(async () => { try { await native.close(); await storage.close(); }
    finally { await rm(parent, { recursive: true, force: true }); } });
  let mutations = 0;
  const racingCore = { async dispatch(method, request, principal) {
    if (method === "capability_call") {
      mutations++;
      await writeFile(join(data, "notes/Folder/Pinned.md"), raw + "Concurrent");
    }
    return native.core.dispatch(method, request, principal);
  } };
  await assert.rejects(legacyKnowledgeTrash(racingCore, storage, actor, {
    tool: "delete_note", arguments: { slug: "Folder/Pinned" },
  }), error => error.code === "CONFLICT");
  assert.equal(mutations, 1);
  assert.equal(await readFile(join(data, "notes/Folder/Pinned.md"), "utf8"), raw + "Concurrent");
  assert.deepEqual(await readdir(join(data, "notes/.trash")), []);
});

test("authenticated relocated backup retains original Trash identity/history and re-pins exact payload for native restore",
  { timeout: 60_000 }, async t => {
    const parent = join(root, "tests", `.legacy-trash-backup-${randomUUID()}`);
    await mkdir(parent);
    t.after(() => rm(parent, { recursive: true, force: true }));
    const data = await initialize(join(parent, "workspace"));
    const raw = content("portable", "Portable");
    await put(data, "notes", "Portable", raw);
    const storage = await Storage.open(data);
    const native = await createNativeRuntime({ storage, trash: { layoutVersion: "pkm.trash-lifecycle/v1" } });
    const deleted = await legacyKnowledgeTrash(native.core, storage, actor, {
      tool: "delete_note", arguments: { slug: "Folder/Portable" },
    });

    const entry = deleted.value.trash;
    await native.close();
    try { await createWorkspaceBackup(storage, join(parent, "backup"), {
      acquireQuiescence: async () => ({ assertHeld() {}, release() {} }),
    }); } finally { await storage.close(); }
    const restored = join(parent, "relocated");
    await restoreWorkspaceBackup(join(parent, "backup"), restored, { nativeRestoreAuthority,
      pythonExecutable: execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim() });
    const reopened = await Storage.open(restored);
    const runtime = await createNativeRuntime({ storage: reopened, trash: { layoutVersion: "pkm.trash-lifecycle/v1" } });
    try {
      const database = new DatabaseSync(join(restored, "core.sqlite"), { readOnly: true });
      try {
        const row = database.prepare("SELECT * FROM migration_runtime_trash").get();
        assert.equal(row.entry_id, entry.id);
        assert.equal(row.root_path, restored);
        assert.deepEqual(readOriginalTrashDeletionHistory(database, row.workspace_id), { schema: 1, records: [
          { path: "notes/Folder/Portable.md", deletedAt: entry.deletedAt },
          { path: "notes/Folder/Portable.assets/bytes.bin", deletedAt: entry.deletedAt },
        ] });
      } finally { database.close(); }
      const response = await runtime.core.dispatch("capability_call", { operation: "knowledge.trash.restore", version: 1,
        arguments: { operationId: randomUUID(), entryId: entry.id, expectedScanRevision: hash("[]") } }, actor);
      assert.equal(response.error, undefined, JSON.stringify(response));
      assert.equal(await readFile(join(restored, "notes/Folder/Portable.md"), "utf8"), raw);
      assert.deepEqual(await readFile(join(restored, "notes/Folder/Portable.assets/bytes.bin")), bytes);
    } finally { await runtime.close(); await reopened.close(); }
  });

test("interrupted original Trash publication recovers one UUID receipt and one ordered deletion history", async t => {
  const parent = join(root, "tests", `.legacy-trash-recovery-${randomUUID()}`);
  await mkdir(parent);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const data = await initialize(join(parent, "workspace"));
  const raw = content("interrupted", "Interrupted");
  await put(data, "notes", "Interrupted", raw);
  const storage = await Storage.open(data);
  await storage.provisionTrash();
  const database = storage.connectNative();
  const workspaceId = JSON.parse(await readFile(join(data, ".pkm-next-workspace"), "utf8")).id;
  const migration = new MigrationRuntime({ database, root: data, workspaceId, trash: { layoutVersion: "pkm.trash-lifecycle/v1" },
    fingerprint: request => hash(JSON.stringify({ operation: request.operation, actorId: request.actorId, args: request.args })),
    assertOperationAvailable() {}, reconcileIndex() {},
    transaction(work) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = work();
        if (database.prepare("SELECT 1 FROM migration_runtime_trash").get()) throw new Error("publication interrupted");
        database.exec("COMMIT"); return result;
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  });
  let plan;
  try {
    const preview = await migration.read({ operation: "knowledge.trash.lifecycle.preview", actorId: actor.id,
      args: { area: "notes", path: "Folder/Interrupted.md", kind: "document" } });
    await assert.rejects(migration.mutate({ operation: "knowledge.trash.move", actorId: actor.id, args: {
      operationId: randomUUID(), area: "notes", path: "Folder/Interrupted.md", kind: "document",
      expectedTreeSha256: preview.treeSha256, expectedScanRevision: preview.scanRevision, entryIdFormat: "original",
    } }), /publication interrupted/);
    plan = JSON.parse(database.prepare("SELECT plan_json FROM migration_runtime_intents").get().plan_json);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM migration_runtime_deletions").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM receipts").get().count, 0);
    assert.equal(await readFile(join(data, "notes/.trash", plan.entryId, "payload"), "utf8"), raw);
  } finally { migration.close(); database.close(); await storage.close(); }
  const managed = await legacyManagedFixture(parent);
  const client = new Client({ name: "original-trash-recovery", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: "python3",
    args: [join(root, "compat/legacy-compact-mcp.py"), "--data", data, "--node", process.execPath,
      "--allow-writes", "--managed-generation", managed],
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe" }));
  try {
    const absent = await client.callTool({ name: "delete_note", arguments: { slug: "Folder/Interrupted" } });
    assert.notEqual(absent.isError, true, JSON.stringify(absent));
    assert.deepEqual(JSON.parse(absent.content[0].text), { ok: true, absent: true });
  } finally { await closeLegacyManagedFixture(client); }
  const reopened = await Storage.open(data);
  const runtime = await createNativeRuntime({ storage: reopened, trash: { layoutVersion: "pkm.trash-lifecycle/v1" } });
  try {
    const database = new DatabaseSync(join(data, "core.sqlite"), { readOnly: true });
    try {
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM migration_runtime_intents").get().count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM receipts WHERE operation_id=?").get(plan.operationId).count, 1);
      assert.deepEqual(readOriginalTrashDeletionHistory(database, workspaceId), { schema: 1, records: [
        { path: "notes/Folder/Interrupted.md", deletedAt: plan.deletedAt },
        { path: "notes/Folder/Interrupted.assets/bytes.bin", deletedAt: plan.deletedAt },
      ] });
      assert.equal(database.prepare("SELECT entry_id FROM migration_runtime_trash").get().entry_id, plan.entryId);
    } finally { database.close(); }
  } finally { await runtime.close(); await reopened.close(); }
});
