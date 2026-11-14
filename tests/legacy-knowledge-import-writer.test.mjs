import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { planLegacyImport, importLegacyWorkspace } from "../dist/legacy-import.js";
import { Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { startLegacyNoteMcp } from "../dist/legacy-note-mcp.js";
import { scanMarkdown } from "../dist/markdown.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";

const actor = { id: "mcp:external", canWrite: true };
const pythonExecutable = execFileSync("python3", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
const raw = "---\n# Original comment survives\n"
  + "title: Before\nrevision: 4\naliases: [note:Historical/Before]\n"
  + "created: 2001-02-03T04:05:06.000Z\nhistory: [{event: original}]\nlinks: []\n"
  + "custom: {retain: [one, two]}\n---\nOriginal body\n![pair](Before.assets/opaque.bin)\n";
const bytes = Buffer.from([255, 0, 128, 9]);

test("original path-only import survives atomic MCP write/assets crash, restart, old/new alias reads and relocated backup without rewriting its source",
  { timeout: 90_000 }, async t => {
    const parent = resolve("tests", `.legacy-import-writer-${randomUUID()}`);
    const source = join(parent, "original"), target = join(parent, "target"), relocated = join(parent, "relocated");
    await mkdir(join(source, "notes/Old/Before.assets"), { recursive: true, mode: 0o700 });
    await writeFile(join(source, "notes/Old/Before.md"), raw, { mode: 0o600 });
    await writeFile(join(source, "notes/Old/Before.assets/opaque.bin"), bytes, { mode: 0o600 });
    let storage, runtime, client, server;
    const close = async () => {
      await client?.close(); client = undefined;
      await server?.close(); server = undefined;
      await runtime?.close(); runtime = undefined;
      await storage?.close(); storage = undefined;
    };
    t.after(async () => { try { await close(); } finally { await rm(parent, { recursive: true, force: true }); } });
    const plan = await planLegacyImport(source);
    assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
    await importLegacyWorkspace(plan, target, { pythonExecutable });
    const before = scanMarkdown(target)[0];
    assert.equal(before.metadata.get("knowledgeId"), undefined);
    async function connect(root, recover = false) {
      storage = await Storage.open(root, { deferRecovery: recover });
      runtime = await createNativeRuntime({ storage });
      const [incoming, outgoing] = InMemoryTransport.createLinkedPair();
      server = await startLegacyNoteMcp(storage, outgoing, { core: runtime.core, actor });
      client = new Client({ name: "original-import-writer", version: "1" });
      await client.connect(incoming);
    }
    async function aliases() {
      let identity;
      for (const alias of ["note:Historical/Before", "note:Old/Before", "note:New/After"]) {
        const result = await runtime.core.dispatch("capability_read", {
          operation: "knowledge.note.get", version: 1, arguments: { alias },
        }, actor);
        assert.equal(result.error, undefined, JSON.stringify(result));
        assert.equal(result.result.item.path, "New/After.md");
        assert.equal(result.result.item.documentId, before.record.id);
        assert.equal(result.result.item.revision, 5);
        identity ??= result.result.item.knowledgeId;
        assert.equal(result.result.item.knowledgeId, identity);
      }
      return identity;
    }
    await connect(target);
    const rename = fs.renameSync;
    let interrupted = false;
    fs.renameSync = (...args) => {
      const result = rename(...args);
      if (String(args[0]).endsWith("Before.assets")) {
        interrupted = true; throw new Error("original-import assets interruption");
      }
      return result;
    };
    syncBuiltinESMExports();
    try {
      const response = await client.callTool({ name: "legacy_knowledge_write", arguments: {
        tool: "update_note", arguments: { slug: "Old/Before", title: "After", category: "New" },
      } });
      assert.equal(response.isError, true);
      assert.match(JSON.stringify(response), /interrupted/);
    } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    assert.equal(interrupted, true);
    const database = new DatabaseSync(join(target, "core.sqlite"), { readOnly: true });
    const pending = database.prepare("SELECT * FROM migration_runtime_intents").get();
    assert.equal(pending.operation, "knowledge.note.update");
    assert.equal(database.prepare("SELECT 1 FROM receipts WHERE operation_id=?").get(pending.operation_id), undefined);
    database.close();
    await close();
    await connect(target, true);
    const identity = await aliases();
    const moved = await readFile(join(target, "notes/New/After.md"), "utf8");
    for (const text of ["# Original comment survives", "created: 2001-02-03T04:05:06.000Z",
      "history: [{event: original}]", "custom: {retain: [one, two]}", "links: []", "After.assets/opaque.bin"])
      assert(moved.includes(text), text);
    assert.deepEqual(await readFile(join(target, "notes/New/After.assets/opaque.bin")), bytes);
    const request = JSON.parse(pending.request_json);
    const replay = await runtime.core.dispatch("capability_call", {
      operation: request.operation, version: 1, arguments: request.args,
    }, actor);
    assert.equal(replay.error, undefined, JSON.stringify(replay));
    assert.equal(replay.result.id, before.record.id);
    assert.equal(replay.result.revision, 5);
    const backup = join(parent, "backup");
    await createWorkspaceBackup(storage, backup, {
      acquireQuiescence: async () => ({ assertHeld() {}, release() {} }),
    });
    await close();
    await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority, pythonExecutable });
    await connect(relocated);
    assert.equal(await aliases(), identity);
    assert.equal(await readFile(join(relocated, "notes/New/After.md"), "utf8"), moved);
    assert.deepEqual(await readFile(join(relocated, "notes/New/After.assets/opaque.bin")), bytes);
    assert.equal(await readFile(join(source, "notes/Old/Before.md"), "utf8"), raw);
    assert.deepEqual(await readFile(join(source, "notes/Old/Before.assets/opaque.bin")), bytes);
  });
