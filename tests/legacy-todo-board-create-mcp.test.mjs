import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { legacyManagedFixture, closeLegacyManagedFixture } from "./legacy-managed-fixture.mjs";
import { legacyTodoBoardCreateSlug } from "../dist/legacy-todo-board-create-contracts.js";

const root = resolve(import.meta.dirname, ".."), repository = resolve(root, "legacy");
const originalContract = JSON.parse(execFileSync("python3", ["-c", `
import ast,asyncio,json,sys
from fastmcp import FastMCP
mcp=FastMCP("independent-original-board-contract")
tree=ast.parse(sys.stdin.read())
node,=[node for node in ast.walk(tree) if isinstance(node,ast.FunctionDef) and node.name=="todo_board_create"]
exec(compile(ast.Module(body=[node],type_ignores=[]),"<actual-original-board-create>","exec"))
async def main():
 tool,=await mcp.list_tools()
 print(json.dumps(tool.to_mcp_tool().model_dump(mode="json")))
asyncio.run(main())
`], { input: await readFile(join(repository, "resources/knowledge_mutations.py"), "utf8"), encoding: "utf8" }));

test("original Todo Board raw title/category matching rejects rather than sanitizes caller paths", () => {
  for (const [title, category] of [["Board", ""], ["Board", "Project/Phase"], ["Unicode 检验", "研究"]])
    assert.equal(legacyTodoBoardCreateSlug({ title, category }), category ? `${category}/${title}` : title);
  for (const args of [
    { title: "" }, { title: " " }, { title: " Board" }, { title: "Board " },
    { title: "Bad/Board" }, { title: "Bad:Board" }, { title: "Board", category: " Leading" },
    { title: "Board", category: "Nested//Gap" }, { title: "Board", category: "Bad\\Path" },
    { title: "Board", category: null }, { title: "Board", actorId: "user:local" },
  ]) assert.throws(() => legacyTodoBoardCreateSlug(args));
});

for (const profile of ["compact", "legacy"])
test(`source-captured original Todo Board creation uses native descriptor/admission and survives restart/relocated backup (${profile})`,
  { timeout: 90_000 }, async t => {
    const parent = join(root, "tests", `.legacy-board-create-${randomUUID()}`);
    await mkdir(parent);
    const data = await initialize(join(parent, "workspace")), oracle = join(parent, "oracle");
    await mkdir(join(oracle, "notes"), { recursive: true });
    const managed = await legacyManagedFixture(parent);
    let client;
    t.after(async () => { try { await client?.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
    const connect = async (target, allowWrites = true) => {
      client = new Client({ name: "original-board-creator", version: "1" });
      await client.connect(new StdioClientTransport({ command: "python3",
        args: [join(root, "compat/legacy-compact-mcp.py"), "--data", target, "--node", process.execPath,
          "--managed-generation", managed, ...(allowWrites ? ["--allow-writes"] : [])],
        env: { ...process.env, PKM_CAPABILITY_PROFILE: profile, PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe" }));
    };
    const invoke = async (name, args, write = false) => {
      const response = await client.callTool(profile === "legacy" ? { name, arguments: args } : {
        name: write ? "capability_call" : "capability_read",
        arguments: { operation: `mcp.tool.${name}`, version: 1, arguments: args },
      });
      assert.notEqual(response.isError, true, JSON.stringify(response));
      return response.structuredContent;
    };
    const assertDiscovery = async () => {
      const listing = await invoke("list_notes", { limit: 0 });
      assert(listing.notes.some(note => note.slug === "Project/Board" && note.documentKind === "todo-board" && note.type === "todo"));
      const result = await client.callTool(profile === "legacy" ? { name: "get_note", arguments: { slug: "Project/Board" } } : {
        name: "capability_read", arguments: { operation: "mcp.tool.get_note", version: 1, arguments: { slug: "Project/Board" } },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const note = JSON.parse(result.content[0].text);
      assert.equal(note.slug, "Project/Board");
      assert.equal(note.documentKind, "todo-board");
      assert.match(note.message, /note_work_items.*note_work_item_command/);
    };
    await connect(data);
    const described = await client.callTool({ name: "capabilities_describe", arguments: { operation: "mcp.tool.todo_board_create" } });
    assert.notEqual(described.isError, true, JSON.stringify(described));
    for (const [key, expected] of [["inputSchema", originalContract.inputSchema],
      ["outputSchema", originalContract.outputSchema ?? null], ["description", originalContract.description],
      ["readOnly", false]]) assert.deepEqual(described.structuredContent[key], expected, key);
    const expected = JSON.parse(execFileSync(process.execPath, [join(repository, "resources/knowledge_mutations.js"), repository, oracle], {
      input: JSON.stringify({ operation: "todo-board-create", area: "notes", path: "Project/Board.md", title: "Board", category: "Project" }),
      encoding: "utf8",
    }));
    const created = await invoke("todo_board_create", { title: "Board", category: "Project" }, true);
    assert.deepEqual(created, expected);
    await assertDiscovery();
    assert.deepEqual(await invoke("note_work_items", { slug: "Project/Board" }), { ok: true, items: [], digest: created.digest });
    const descriptor = await readFile(join(data, "notes/Project/Board.md"), "utf8");
    assert.match(descriptor, /documentKind: ["']?todo-board/);
    assert.match(descriptor, /type: ["']?todo/);
    assert.match(descriptor, /knowledgeId:/);
    const discovery = await invoke("note_work_item_notes", {});
    assert(discovery.notes.some(note => note.slug === "Project/Board" && note.digest === created.digest));
    const duplicate = await client.callTool({ name: "capability_call", arguments: {
      operation: "mcp.tool.todo_board_create", version: 1, arguments: { title: "Board", category: "Project" },
    } });
    assert.equal(duplicate.isError, true);
    assert.equal(await readFile(join(data, "notes/Project/Board.md"), "utf8"), descriptor);
    for (const args of [{ title: "Bad/Board" }, { title: "Hidden", category: ".hidden" },
      { title: "Traversal", category: "../outside" }, { title: "System Board", category: "System" },
      { title: "Spoof", actorId: "user:local" }, { title: "Spoof", worker_token: "0".repeat(64) }]) {
      const denied = await client.callTool({ name: "capability_call", arguments: {
        operation: "mcp.tool.todo_board_create", version: 1, arguments: args,
      } });
      assert.equal(denied.isError, true, JSON.stringify(args));
    }
    await writeFile(join(data, "notes/Existing.md"), "---\ntitle: Existing\n---\nPreserve original bytes.\n");
    assert.equal((await client.callTool({ name: "capability_call", arguments: {
      operation: "mcp.tool.todo_board_create", version: 1, arguments: { title: "Existing" },
    } })).isError, true);
    await closeLegacyManagedFixture(client);
    await connect(data);
    await assertDiscovery();
    const next = await invoke("note_work_item_command", { slug: "Project/Board", expected_digest: created.digest,
      command: { action: "create", item: { id: "native-created", title: "Verify Board authority",
        goal: "Continue with fixed worker", scope: "Board", acceptance: ["Native admission"], kind: "Task",
        state: "Planning", evidence: [] } } }, true);
    assert.equal(next.ok, true);
    assert.equal(next.items[0].id, "native-created");
    await closeLegacyManagedFixture(client);
    const storage = await Storage.open(data), native = await createNativeRuntime({ storage });
    const backup = join(parent, "backup"), relocated = join(parent, "relocated");
    try { await createWorkspaceBackup(storage, backup, { acquireQuiescence: native.acquireWorkspaceQuiescence }); }
    finally { await native.close(); await storage.close(); }
    await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority });
    await connect(relocated);
    await assertDiscovery();
    assert.equal((await invoke("note_work_items", { slug: "Project/Board" })).items[0].id, "native-created");
    assert.equal(await readFile(join(relocated, "notes/Project/Board.md"), "utf8"), descriptor);
    await closeLegacyManagedFixture(client);
    await connect(relocated, false);
    const readonly = await client.callTool({ name: "capabilities_describe", arguments: { operation: "mcp.tool.todo_board_create" } });
    assert.equal(readonly.isError, true);
    await closeLegacyManagedFixture(client);
    assert.deepEqual((await readdir(join(relocated, "notes"))).sort(), [".trash", "Existing.md", "Project"]);
  });
