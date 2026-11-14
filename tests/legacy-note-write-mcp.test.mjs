import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { planLegacyImport, importLegacyWorkspace } from "../dist/legacy-import.js";
import { serializeTodoBoard, readTodoBoard } from "../dist/domain/todo-board.js";
import { Storage } from "../dist/storage.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { legacyManagedFixture, closeLegacyManagedFixture } from "./legacy-managed-fixture.mjs";

const root = resolve(import.meta.dirname, ".."), repository = resolve(root, "..");
const pythonExecutable = execFileSync("python3", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
const note = "---\r\ntitle: Board\r\ndocumentKind: todo-board\r\nunknown: {retain: exact}\r\n---\r\nOriginal descriptor.\r\n";
const first = { id: "first", title: "Verify migrated authority", goal: "Use exact original policy", scope: "Migration",
  acceptance: ["One durable receipt"], state: "Planning", evidence: [] };
const second = { id: "second", title: "Continue safely", goal: "No role escalation", scope: "Migration",
  acceptance: ["Original result matches"], kind: "Task", state: "Planning", evidence: [] };
const board = serializeTodoBoard([first], {});
const originalContracts = JSON.parse(execFileSync(pythonExecutable, ["-c", `
import ast,asyncio,json,sys
from fastmcp import FastMCP
mcp=FastMCP("independent-original-note-contracts")
tree=ast.parse(sys.stdin.read())
selected={"note_work_items","note_work_item_command","note_work_item_upsert"}
body=[node for node in ast.walk(tree) if isinstance(node,ast.FunctionDef) and node.name in selected]
exec(compile(ast.Module(body=body,type_ignores=[]),"<original-knowledge-mutations>","exec"))
async def main():
    print(json.dumps({tool.name:tool.to_mcp_tool().model_dump(mode="json") for tool in await mcp.list_tools()}))
asyncio.run(main())
`], { input: await readFile(join(repository, "resources/knowledge_mutations.py"), "utf8"), encoding: "utf8" }));

for (const profile of ["compact", "legacy"])
test(`original imported Work Item writes use admitted native worker authority, source oracle, restart and relocated backup (${profile})`,
  { timeout: 90_000 }, async t => {
    const parent = join(root, "tests", `.legacy-note-write-${randomUUID()}`);
    const source = join(parent, "source"), oracle = join(parent, "oracle"), target = join(parent, "target");
    await mkdir(join(source, "notes/Board.assets"), { recursive: true, mode: 0o700 });
    await writeFile(join(source, "notes/Board.md"), note, { mode: 0o600 });
    await writeFile(join(source, "notes/Board.assets/pkm-todo-board.json"), board, { mode: 0o600 });
    await cp(source, oracle, { recursive: true });
    let client;
    t.after(async () => { try { await client?.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
    const plan = await planLegacyImport(source);
    assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
    await importLegacyWorkspace(plan, target, { pythonExecutable });
    const managed = await legacyManagedFixture(parent);
    async function connect(data, write = true) {
      client = new Client({ name: "original-note-writer", version: "1" });
      const transport = new StdioClientTransport({ command: pythonExecutable,
        args: [join(root, "compat/legacy-compact-mcp.py"), "--data", data, "--node", process.execPath,
          "--managed-generation", managed, ...(write ? ["--allow-writes"] : [])],
        env: { ...process.env, PKM_CAPABILITY_PROFILE: profile, PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe" });
      let diagnostics = "";
      transport.stderr?.on("data", data => { diagnostics += data.toString(); });
      try { await client.connect(transport); }
      catch (error) { throw new Error(`${error.message}\n${diagnostics}`, { cause: error }); }
    }
    async function invoke(name, args, write = false) {
      const response = await client.callTool(profile === "legacy"
        ? { name, arguments: args }
        : { name: write ? "capability_call" : "capability_read",
          arguments: { operation: `mcp.tool.${name}`, version: 1, arguments: args } });
      assert.notEqual(response.isError, true, JSON.stringify(response));
      return response.structuredContent;
    }
    function original(operation, values, now) {
      const script = `const RealDate=Date;global.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[${JSON.stringify(now)}]))}static now(){return +new RealDate(${JSON.stringify(now)})}};process.argv=[process.execPath,${JSON.stringify(join(repository, "resources/knowledge_mutations.js"))},${JSON.stringify(repository)},${JSON.stringify(oracle)}];require(process.argv[1]);`;
      return JSON.parse(execFileSync(process.execPath, ["-e", script], {
        input: JSON.stringify({ operation, area: "notes", path: "Board.md", ...values }), encoding: "utf8",
      }));
    }
    await connect(target);
    for (const [name, contract] of Object.entries(originalContracts)) {
      const description = await client.callTool({ name: "capabilities_describe", arguments: { operation: `mcp.tool.${name}` } });
      assert.notEqual(description.isError, true, JSON.stringify(description));
      assert.deepEqual(description.structuredContent.inputSchema, contract.inputSchema, name);
      assert.deepEqual(description.structuredContent.outputSchema, contract.outputSchema ?? null, name);
      assert.equal(description.structuredContent.description, contract.description, name);
      assert.equal(description.structuredContent.readOnly, contract.annotations.readOnlyHint, name);
    }
    const before = await invoke("note_work_items", { slug: "Board" });
    assert.equal(before.digest, readTodoBoard(board).digest);
    const command = { action: "claim", id: "first" };
    const one = await invoke("note_work_item_command", { slug: "Board", expected_digest: before.digest, command }, true);
    assert.equal(one.items[0].ownerId, "mcp:external");
    assert.deepEqual(one, original("work-item-command", { expectedDigest: before.digest, command }, one.items[0].history.at(-1).at));
    assert.deepEqual(await invoke("note_work_items", { slug: "Board" }), one, "Reads must follow admitted native authority, not the frozen imported source Board.");
    const two = await invoke("note_work_item_upsert", { slug: "Board", expected_digest: one.digest, item: second }, true);
    assert.deepEqual(two, original("work-item-upsert", { expectedDigest: one.digest, item: second }, two.items[1].history.at(-1).at));
    for (const args of [
      { slug: "Board", expected_digest: two.digest, command: { action: "accept", id: "first", reason: "No user authority" } },
      { slug: "Board", expected_digest: two.digest, command: { action: "claim", id: "second" }, worker_token: "0".repeat(64) },
      { slug: "Board", expected_digest: before.digest, command: { action: "claim", id: "second" } },
      { slug: "Board", expected_digest: two.digest, command: { action: "claim", id: "second" }, actorId: "user:local" },
    ]) {
      const denied = await client.callTool({ name: "capability_call",
        arguments: { operation: "mcp.tool.note_work_item_command", version: 1, arguments: args } });
      assert.equal(denied.isError, true, JSON.stringify(denied));
    }
    assert.deepEqual(await invoke("note_work_items", { slug: "Board" }), two);
    const released = await client.callTool({ name: "capability_call", arguments: {
      operation: "todo.workitem.release", version: 1, arguments: {
        board_slug: "Board", expected_digest: two.digest, id: "first", reason: "Release through the named native API",
      },
    } });
    assert.notEqual(released.isError, true, JSON.stringify(released));
    const final = await invoke("note_work_items", { slug: "Board" });
    assert.deepEqual(final, original("work-item-command", { expectedDigest: two.digest,
      command: { action: "release", id: "first", reason: "Release through the named native API" } }, final.items[0].history.at(-1).at));
    const discovery = await invoke("note_work_item_notes", { query: "Board" });
    assert.deepEqual(discovery.notes.map(({ slug, count, digest, error }) => ({ slug, count, digest, error })),
      [{ slug: "Board", count: final.items.length, digest: final.digest, error: undefined }]);
    await closeLegacyManagedFixture(client); client = undefined;
    await connect(target);
    assert.deepEqual(await invoke("note_work_items", { slug: "Board" }), final);
    await closeLegacyManagedFixture(client); client = undefined;
    const storage = await Storage.open(target);
    const backup = join(parent, "backup"), relocated = join(parent, "relocated");
    try { await createWorkspaceBackup(storage, backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) }); }
    finally { await storage.close(); }
    await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority, pythonExecutable });
    await connect(relocated, false);
    assert.deepEqual(await invoke("note_work_items", { slug: "Board" }), final);
    assert.equal((await invoke("note_work_item_notes", { query: "Board" })).notes[0].digest, final.digest);
    await closeLegacyManagedFixture(client); client = undefined;
    assert.equal(await readFile(join(source, "notes/Board.md"), "utf8"), note);
    assert.equal(await readFile(join(source, "notes/Board.assets/pkm-todo-board.json"), "utf8"), board);
    await assert.rejects(readFile(join(target, "notes/Board.assets/pkm-todo-board.json")), { code: "ENOENT" });
    assert.equal(await readFile(join(relocated, "boards/Board/pkm-todo-board.json"), "utf8"),
      await readFile(join(oracle, "notes/Board.assets/pkm-todo-board.json"), "utf8"));
  });
