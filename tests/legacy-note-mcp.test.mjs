import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash, randomUUID } from "node:crypto";
import { initialize, Storage } from "../dist/storage.js";
import { Core } from "../dist/core.js";
import { CapabilityRegistry, todoCapabilities } from "../dist/domain/legacy-mcp-registry.js";
import { externalMemoryCapabilities } from "../dist/domain/legacy-mcp-memory-contract.js";
import { authenticateBoardWorker, planTodo } from "../dist/boards.js";
import { readTodoBoard, serializeTodoBoard, todoBoardWorkers } from "../dist/domain/todo-board.js";
import ts from "typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "legacy");

test("actual compact compatibility MCP initializes as pkm-v5 in a disposable separate workspace", { timeout: 30_000 }, async t => {
  const directory = resolve("tests", `.compact-identity-${randomUUID()}`);
  await initialize(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new Client({ name: "compact-identity-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.env.PKM_TEST_PYTHON || "python3",
    args: ["-B", resolve("compat/legacy-compact-mcp.py"), "--data", directory, "--node", process.execPath],
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PKM_CAPABILITY_PROFILE: "compact" },
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", chunk => { diagnostics += chunk; });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, "pkm-v5");
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    assert(tools.includes("capabilities_search"));
    assert(!tools.includes("add_note"));
  } catch (error) {
    throw new Error(`Compact identity failed: ${diagnostics}`, { cause: error });
  } finally { await client.close(); }
});

test("legacy MCP catalog captures still match their original source", () => {
  execFileSync(process.execPath, [join(packageRoot, "scripts/capture-legacy-mcp-contracts.mjs"), "--check"]);
});
const oracle = String.raw`
import datetime, json, pathlib, re, sys
root = pathlib.Path(sys.argv[1])
source = pathlib.Path(sys.argv[2]).read_text()
def section(start, end):
    return source[source.index(start):source.index(end, source.index(start))].replace("\\\\", "\\")
code = (section("def _parse(text):", "def _serialize(fm, body):")
    + section("def _cat_of(key):", "def _assert_mcp_writable(")
    + section("def _name_of(key):", "def _walk(root):")
    + section("def _mtime(p):", "def _all_notes():"))
namespace = {"datetime": datetime, "json": json, "re": re, "Path": pathlib.Path, "STORE": root}
exec(code, namespace)
sys.path.insert(0, str(pathlib.Path(sys.argv[2]).parents[2] / "resources"))
from note_inventory import note_inventory_page
args = json.loads(sys.argv[3])
result = note_inventory_page(root / "notes", namespace["_note"], directory=args.get("directory"),
    recursive=args.get("recursive", True), offset=args.get("offset", 0), limit=args.get("limit", 50),
    note_type=args.get("type"), inventory_revision=args.get("inventory_revision"))
print(json.dumps(result, ensure_ascii=False))
`;

test("isolated read-only stdio Note inventory matches the generated legacy executor", { timeout: 60_000 }, async t => {
  const parent = await mkdtemp(join(tmpdir(), "pkm-legacy-note-mcp-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "workspace");
  await initialize(root);
  for (const [flags, error] of [
    [["mcp", "--data", root, "--experimental-legacy-note-mcp"], /requires mcp --read-only/],
    [["http", "--data", root, "--read-only", "--experimental-legacy-note-mcp"], /requires mcp --read-only/],
    [["init", "--data", join(parent, "unexpected"), "--read-only", "--experimental-legacy-note-mcp"],
      /Option --read-only is not supported by init\./],
  ]) {
    const denied = spawnSync(process.execPath, [join(packageRoot, "dist/cli.js"), ...flags], { encoding: "utf8" });
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, error);
  }
  assert.equal(existsSync(join(parent, "unexpected")), false);
  for (let index = 0; index < 251; index++) {
    const directory = join(root, "notes", index % 2 ? "Team/Sub" : "Team");
    await mkdir(directory, { recursive: true });
    const identity = index === 2 ? null : index.toString(16).padStart(24, "0");
    await writeFile(join(directory, `Note ${String(index).padStart(3, "0")}.md`),
      `---\ntitle: "Note ${index}"\ntype: "general"\n${identity ? `knowledgeId: "knowledge_${identity}"\n` : ""}---\nBody\n`);
  }
  await mkdir(join(root, "notes", "System"), { recursive: true });
  await writeFile(join(root, "notes", "System", "系统.md"), "---\ndocumentKind: todo-board\n---\nBoard\n");
  await mkdir(join(root, "notes", "Empty"));
  const client = new Client({ name: "legacy-note-compat-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(packageRoot, "dist/cli.js"), "mcp", "--data", root, "--read-only", "--experimental-legacy-note-mcp"],
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", chunk => { diagnostics += chunk.toString(); });
  try { await client.connect(transport); }
  catch (error) { throw new Error(`MCP startup failed: ${diagnostics}`, { cause: error }); }
  assert.equal(client.getServerVersion().name, "pkm-v5");
  t.after(() => client.close());
  for (const [index, directory] of [[0, "Team"], [1, "Team/Sub"]]) {
    await writeFile(join(root, "notes", directory, `Note ${String(index).padStart(3, "0")}.md`),
      `---\ntitle: "Note ${index}"\ntype: "general"\nknowledgeId: "knowledge_${"a".repeat(24)}"\n---\nBody\n`);
  }
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["list_notes"]);
  const call = async args => client.callTool({ name: "list_notes", arguments: args });
  assert.equal((await client.callTool({ name: "add_note", arguments: { title: "Not allowed" } })).isError, true);
  const expected = args => JSON.parse(execFileSync("python3", ["-c", oracle, root,
    join(repositoryRoot, "src/mcp/mcp.ts"), JSON.stringify(args)], { encoding: "utf8" }));
  for (const args of [{}, { limit: 0 }, { limit: 250 }, { directory: "pkm://notes/Team/", recursive: false },
    { directory: "Empty" }, { directory: "System" }, { type: "unknown" }]) {
    const actual = await call(args);
    assert.notEqual(actual.isError, true);
    assert.deepEqual(actual.structuredContent, expected(args));
  }
  const first = (await call({ directory: "Team", limit: 100 })).structuredContent;
  const next = { directory: "Team", offset: 100, limit: 0, inventory_revision: first.inventory_revision };
  assert.deepEqual((await call(next)).structuredContent, expected(next));
  assert.equal(first.duplicate_identity_count, 2);
  assert.equal(first.missing_identity_count, 1);
  assert.equal((await call({ directory: "Team", offset: 1 })).isError, true);
  await writeFile(join(root, "notes", "Team", "new.md"), "New\n");
  assert.equal((await call(next)).isError, true);
  await symlink(join(root, "notes", "Team", "new.md"), join(root, "notes", "link.md"));
  assert.equal((await call({})).isError, true);
});

test("legacy compact discovery and dispatch call the isolated Note server", { timeout: 60_000 }, async t => {
  const parent = await mkdtemp(join(tmpdir(), "pkm-legacy-compact-mcp-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "workspace");
  await initialize(root);
  await writeFile(join(root, "notes", "Example.md"), "---\ntitle: Example\n---\nBody\n");
  const transport = new StdioClientTransport({
    command: "python3",
    args: [join(packageRoot, "compat/legacy-compact-mcp.py"), "--data", root, "--node", process.execPath],
    env: { ...process.env, PKM_CAPABILITY_PROFILE: "compact" },
    stderr: "pipe",
  });

  for (const { writable, profile } of [
    { writable: false, profile: "compact" }, { writable: true, profile: "compact" },
    { writable: false, profile: "legacy" }, { writable: true, profile: "legacy" },
  ]) {
    await t.test(`${profile} canonical Todo/Memory preserves old schemas, envelopes and ${writable ? "write" : "read-only"} authority`,
      { timeout: 60_000 }, async t => {
        const parent = await mkdtemp(join(tmpdir(), "pkm-legacy-canonical-mcp-"));
        let client;
        t.after(async () => { try { await client?.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
        const root = join(parent, "workspace");
        await initialize(root);
        const storage = await Storage.open(root);
        try {
          const created = await new Core(storage).dispatch("capability_call", {
            operation: "todo.board.create", version: 1,
            arguments: { board_slug: "Team/Board", operationId: randomUUID() },
          }, { id: "local:owner", canWrite: true });
          assert(!created.error, JSON.stringify(created));
        } finally { await storage.close(); }
        const workerToken = "1".repeat(64), workerActor = "external:copilot:compat-worker";
        const boardFile = join(root, "boards", "Team", "Board", "pkm-todo-board.json");
        await writeFile(boardFile, serializeTodoBoard([], {
          [workerActor]: createHash("sha256").update(workerToken).digest("hex"),
        }));
        const transport = new StdioClientTransport({
          command: "python3",
          args: [join(packageRoot, "compat/legacy-compact-mcp.py"), "--data", root, "--node", process.execPath,
            ...(writable ? ["--allow-writes"] : [])],
          env: { ...process.env, PKM_CAPABILITY_PROFILE: profile },
          stderr: "pipe",
        });
        let diagnostics = "";
        transport.stderr?.on("data", chunk => { diagnostics += chunk.toString(); });
        client = new Client({ name: "legacy-canonical-test", version: "1.0.0" });
        try { await client.connect(transport); }
        catch (error) { throw new Error(`MCP startup failed: ${diagnostics}`, { cause: error }); }
        const call = (name, args) => client.callTool({ name, arguments: args });
        const registry = new CapabilityRegistry([...todoCapabilities, ...externalMemoryCapabilities]
          .filter(operation => writable || operation.readOnly));
        for (const path of ["todo", "memory"]) {
          const args = { path, query: "", offset: 0, limit: 3 };
          assert.deepEqual((await call("capabilities_search", args)).structuredContent, registry.discover(args, true));
          const first = registry.discover({ path, offset: 0, limit: 10 });
          assert.deepEqual((await call("capabilities_list", { path })).structuredContent, first);
          assert.equal((await call("capabilities_list", { path, revision: "0".repeat(64) })).isError, true);
        }
        const toolNames = (await client.listTools()).tools.map(tool => tool.name);
        assert.equal(toolNames.includes("get_board"), profile === "legacy");
        assert.equal(toolNames.includes("add_workitem"), profile === "legacy" && writable);
        const described = (await call("capabilities_describe", { operation: "todo.board.get" })).structuredContent;
        assert.deepEqual(described, { ...registry.describe("todo.board.get"), catalogRevision: registry.revision });
        const invoke = async (operation, args, mutation = false) => call(mutation ? "capability_call" : "capability_read",
          { operation, version: 1, arguments: args });
        const boardResult = await invoke("todo.board.get", { board_slug: "Team/Board" });
        assert.notEqual(boardResult.isError, true, JSON.stringify(boardResult));
        const board = boardResult.structuredContent;
        assert.equal(board.schema, "pkm.capability-result/v1");
        assert.equal(board.catalogRevision, registry.revision);
        assert.equal(board.result.actorId, "mcp:external");
        assert.equal(board.requestId, undefined);
        const authenticated = await call("get_board", { board_slug: "Team/Board", worker_token: workerToken });
        assert.notEqual(authenticated.isError, true, JSON.stringify(authenticated));
        assert.equal(authenticated.structuredContent.actorId, workerActor);
        assert.equal((await call("capability_read", { operation: "todo.board.get", version: 1,
          arguments: { board_slug: "Team/Board" }, worker_token: workerToken })).structuredContent.result.actorId, workerActor);
        assert.equal((await call("capability_read", { operation: "mcp.tool.get_board", version: 1,
          arguments: { board_slug: "Team/Board" }, worker_token: workerToken })).structuredContent.actorId, workerActor);
        assert.equal((await call("get_board", { board_slug: "Other", worker_token: workerToken })).isError, true);
        assert.equal((await call("capability_read", { operation: "todo.board.list", version: 1,
          arguments: {}, worker_token: workerToken })).isError, true);
        assert.deepEqual((await call("get_board", { board_slug: "Team/Board" })).structuredContent, board.result);
        assert.deepEqual((await call("capability_read", { operation: "mcp.tool.get_board", version: 1,
          arguments: { board_slug: "Team/Board" } })).structuredContent, board.result);
        const task = { board_slug: "Team/Board", expected_digest: board.result.digest,
          item: { id: "task", title: "Task", goal: "Legacy compatibility", scope: "Isolated", acceptance: ["Pass"] } };
        const proposal = { content: "Use source-matched MCP contracts.", operation_id: "legacy-compat-proposal",
          sources: [{ id: "source", chat: "fixture", revision: "r1", locator: "message/1" }] };
        assert.equal((await invoke("todo.workitem.create", task)).isError, true);
        for (const id of ["memory.record.confirm", "memory.record.revise", "memory.record.revoke"]) {
          assert.equal((await call("capabilities_describe", { operation: id })).isError, true);
          assert.equal((await invoke(id, {}, true)).isError, true);
        }
        assert.equal((await call("capability_read", { operation: "todo.board.get", version: 1,
          arguments: { board_slug: "Team/Board" }, worker_token: "untrusted" })).isError, true);
        assert.equal((await call("get_board", { board_slug: "Team/Board", worker_token: "untrusted" })).isError, true);
        const created = await invoke("todo.workitem.create", task, true);
        const memory = await invoke("memory.record.propose", proposal, true);
        if (!writable) {
          assert.equal(created.isError, true);
          assert.equal(memory.isError, true);
          assert.equal((await call("add_workitem", task)).isError, true);
          assert.equal((await call("add_workitem", { ...task, worker_token: workerToken })).isError, true);
        } else {
          assert.notEqual(created.isError, true, JSON.stringify(created));
          assert.equal(created.structuredContent.result.item.id, "task");
          assert.equal((await invoke("todo.workitem.create", task, true)).isError, true,
            "original digest-CAS requests are not silently replayed as new-server receipt successes");
          assert.notEqual(memory.isError, true, JSON.stringify(memory));
          assert.equal(memory.structuredContent.result.status, "pending");
          assert.deepEqual((await invoke("memory.record.propose", proposal, true)).structuredContent, memory.structuredContent);
          const read = await invoke("memory.record.get", { id: memory.structuredContent.result.id });
          assert.deepEqual(read.structuredContent.result, memory.structuredContent.result);
          assert.deepEqual((await invoke("memory.record.search", { query: "MCP" })).structuredContent.result, { records: [] });
          const current = (await call("get_board", { board_slug: "Team/Board" })).structuredContent;
          const secondTask = { ...task, expected_digest: current.digest, item: { ...task.item, id: "named-task" } };
          const named = await call("add_workitem", secondTask);
          assert.notEqual(named.isError, true, JSON.stringify(named));
          assert.equal(named.structuredContent.item.id, "named-task");
          assert.equal(named.structuredContent.schema, undefined);
          const rawCurrent = (await call("get_board", { board_slug: "Team/Board" })).structuredContent;
          const deferred = await call("capability_call", { operation: "mcp.tool.add_workitem", version: 1,
            arguments: { ...task, expected_digest: rawCurrent.digest, item: { ...task.item, id: "deferred-task" } } });
          assert.notEqual(deferred.isError, true, JSON.stringify(deferred));
          assert.equal(deferred.structuredContent.item.id, "deferred-task");
          const claimArgs = { board_slug: "Team/Board", id: "task", expected_digest: deferred.structuredContent.digest };
          const claimed = await call("claim_workitem", claimArgs);
          assert.notEqual(claimed.isError, true, JSON.stringify(claimed));
          assert.equal(claimed.structuredContent.item.ownerId, "mcp:external");
          const submitted = await call("submit_workitem_result", {
            ...claimArgs, expected_digest: claimed.structuredContent.digest, outcome: "Success", evidence: ["Fixture verified"],
          });
          assert.notEqual(submitted.isError, true, JSON.stringify(submitted));
          assert.equal((await call("accept_workitem", { ...claimArgs,
            expected_digest: submitted.structuredContent.digest, reason: "Self approval is not delegated" })).isError, true);
          const workerClaim = await call("claim_workitem", { ...claimArgs, id: "named-task",
            expected_digest: submitted.structuredContent.digest, worker_token: workerToken });
          assert.notEqual(workerClaim.isError, true, JSON.stringify(workerClaim));
          assert.equal(workerClaim.structuredContent.actorId, workerActor);
          assert.equal(workerClaim.structuredContent.item.ownerId, workerActor);
          assert.equal((await call("accept_workitem", { ...claimArgs, id: "named-task",
            expected_digest: workerClaim.structuredContent.digest, worker_token: workerToken,
            reason: "Worker is not human" })).isError, true);
          const workerSubmit = await call("capability_call", { operation: "todo.workitem.submit", version: 1,
            arguments: { ...claimArgs, id: "named-task", expected_digest: workerClaim.structuredContent.digest,
              outcome: "Success", evidence: ["Worker identity retained"] }, worker_token: workerToken });
          assert.notEqual(workerSubmit.isError, true, JSON.stringify(workerSubmit));
          assert.equal(workerSubmit.structuredContent.result.actorId, workerActor);
        }
        const latestBoard = JSON.parse(await readFile(boardFile, "utf8"));
        await writeFile(boardFile, serializeTodoBoard(latestBoard.items, {}));
        assert.equal((await call("get_board", { board_slug: "Team/Board", worker_token: workerToken })).isError, true);
        assert.equal((await call("get_board", { board_slug: "Team/Board" })).structuredContent.actorId, "mcp:external");
      });

      test("Board worker authentication is pinned until native dispatch and does not widen transport authority", async t => {
        const parent = await mkdtemp(join(tmpdir(), "pkm-legacy-worker-authority-"));
        t.after(() => rm(parent, { recursive: true, force: true }));
        const root = await initialize(join(parent, "workspace"));
        const boardDirectory = join(root, "boards", "Board");
        await mkdir(boardDirectory, { recursive: true });
        const file = join(boardDirectory, "pkm-todo-board.json"), token = "2".repeat(64);
        const actorId = "external:claude:board-worker";
        const raw = serializeTodoBoard([], { [actorId]: createHash("sha256").update(token).digest("hex") });
        await writeFile(file, raw);
        const legacyNotes = join(parent, "legacy-notes");
        await mkdir(join(legacyNotes, "Board.assets"), { recursive: true });
        await writeFile(join(legacyNotes, "Board.md"), "---\ndocumentKind: todo-board\n---\n");
        const legacyFile = join(legacyNotes, "Board.assets", "pkm-todo-board.json");
        await writeFile(legacyFile, raw);
        const original = await readFile(join(repositoryRoot, "src/knowledge/filestore.ts"), "utf8");
        const start = original.indexOf("export function noteWorkItemExternalActor(");
        const end = original.indexOf("export function noteWorkItemNotes(", start);
        assert(start >= 0 && end > start);
        const source = ts.transpileModule(original.slice(start, end), {
          compilerOptions: { module: ts.ModuleKind.CommonJS },
        }).outputText;
        const originalActor = new Function("notesRoot", "checkedMarkdownPath", "existsSync", "readFileSync",
          "todoBoardPath", "readTodoBoard", "todoBoardWorkers", "createHash", "exports",
          `${source}\nreturn exports.noteWorkItemExternalActor;`)(
          () => legacyNotes, (root, path) => join(root, path), existsSync, readFileSync,
          () => legacyFile, readTodoBoard, todoBoardWorkers, createHash, {},
        );
        const authority = authenticateBoardWorker(root, "Board", token);
        assert.equal(authority.id, originalActor("Board", token));
        assert.equal(originalActor("Board"), "mcp:external");
        for (const invalid of ["bad", "F".repeat(64), "3".repeat(64)]) {
          assert.throws(() => originalActor("Board", invalid));
          assert.throws(() => authenticateBoardWorker(root, "Board", invalid));
        }
        const request = { operation: "todo.board.get", args: { board_slug: "Board" }, actorId, boardWorker: authority.boardWorker };
        assert.equal(planTodo(root, request).result.actorId, actorId);
        assert.throws(() => planTodo(root, { ...request, args: { board_slug: "Other" } }), /authority changed/);
        const storage = await Storage.open(root);
        try {
          const core = new Core(storage), actor = { ...authority, canWrite: false };
          const read = await core.dispatch("capability_read", {
            operation: "todo.board.get", version: 1, arguments: { board_slug: "Board" },
          }, actor);
          assert.equal(read.result.actorId, actorId);
          for (const [operation, args] of [
            ["todo.board.get", { board_slug: "Other" }],
            ["memory.record.search", { query: "worker" }],
          ]) {
            const denied = await core.dispatch("capability_read", { operation, version: 1, arguments: args }, actor);
            assert.equal(denied.error.code, "ACCESS_DENIED");
          }
          const denied = await core.dispatch("capability_call", {
            operation: "todo.workitem.create", version: 1, arguments: {},
          }, actor);
          assert.equal(denied.error.code, "ACCESS_DENIED");
          await writeFile(file, serializeTodoBoard([], {}));
          const rotated = await core.dispatch("capability_read", {
            operation: "todo.board.get", version: 1, arguments: { board_slug: "Board" },
          }, actor);
          assert.equal(rotated.error.code, "ACCESS_DENIED", "worker thread must receive and enforce the authenticated Board pin");
          const mutation = await core.dispatch("capability_call", {
            operation: "todo.workitem.create", version: 1, arguments: {
              board_slug: "Board", expected_digest: authority.boardWorker.digest, operationId: randomUUID(),
              item: { id: "denied", title: "Denied", goal: "No effects", scope: "Fixture", acceptance: ["No write"] },
            },
          }, { ...authority, canWrite: true });
          assert.equal(mutation.error.code, "ACCESS_DENIED");
          assert.deepEqual(JSON.parse(await readFile(file, "utf8")).items, []);
        } finally { await storage.close(); }
        await writeFile(legacyFile, serializeTodoBoard([], {}));
        assert.throws(() => originalActor("Board", token), /rotated/);
        assert.throws(() => planTodo(root, request), /authority changed/);
        assert.throws(() => authenticateBoardWorker(root, "Board", token), /rotated/);
        assert.throws(() => authenticateBoardWorker(root, "../Board", token), /safe Board slug/);
        assert.throws(() => authenticateBoardWorker(root, "Board", token.toUpperCase() + "a"), /Invalid Board worker token/);
      });
  }
  let diagnostics = "";
  transport.stderr?.on("data", chunk => { diagnostics += chunk.toString(); });
  const client = new Client({ name: "legacy-compact-compat-test", version: "1.0.0" });
  try { await client.connect(transport); }
  catch (error) { throw new Error(`MCP startup failed: ${diagnostics}`, { cause: error }); }
  t.after(() => client.close());
  const toolDefinitions = (await client.listTools()).tools;
  const tools = toolDefinitions.map(tool => tool.name).sort();
  assert.deepEqual(tools, ["capabilities_describe", "capabilities_inventory", "capabilities_list",
    "capabilities_search", "capability_call", "capability_read"]);
  assert.match(toolDefinitions.find(tool => tool.name === "capability_read").description, /original MCP middleware is not active/);
  const invoke = async (name, args) => client.callTool({ name, arguments: args });
  const discovered = (await invoke("capabilities_search", { query: "list_notes" })).structuredContent;
  assert.equal(discovered.schema, "pkm.capabilities/v1");
  assert.equal(discovered.total, 1);
  assert.equal(discovered.operations[0].id, "mcp.tool.list_notes");
  assert.match(discovered.operations[0].authorization, /original MCP middleware is not active/);
  assert.deepEqual((await invoke("capabilities_describe", { operation: "mcp.tool.list_notes" })).structuredContent,
    { revision: discovered.revision, ...discovered.operations[0] });
  const listed = [];
  let nextOffset = 0;
  while (nextOffset !== null) {
    const listing = (await invoke("capabilities_list", { revision: discovered.revision, offset: nextOffset })).structuredContent;
    listed.push(...listing.operations);
    nextOffset = listing.nextOffset;
  }
  assert(listed.some(operation => operation.id === "mcp.tool.list_notes"));
  assert.equal((await invoke("capabilities_inventory", {})).structuredContent.total, 6);
  const directResult = await invoke("list_notes", { limit: 0 });
  const direct = directResult.structuredContent;
  const viaRead = await invoke("capability_read", { operation: "mcp.tool.list_notes", version: 1, arguments: { limit: 0 } });
  assert.deepEqual(viaRead.structuredContent, direct);
  assert.deepEqual(viaRead.content, directResult.content);
  const expected = JSON.parse(execFileSync("python3", ["-c", oracle, root,
    join(repositoryRoot, "src/mcp/mcp.ts"), JSON.stringify({ limit: 0 })], { encoding: "utf8" }));
  assert.deepEqual(direct, expected);
  for (const [name, args] of [
    ["capability_call", { operation: "mcp.tool.list_notes", version: 1, arguments: {} }],
    ["capability_read", { operation: "mcp.tool.add_note", version: 1, arguments: {} }],
    ["capability_read", { operation: "todo.board.get", version: 1, arguments: {} }],
    ["capability_read", { operation: "mcp.tool.list_notes", version: 1, arguments: {}, worker_token: "not-supported" }],
    ["capability_read", { operation: "mcp.tool.list_notes", version: 2, arguments: {} }],
    ["capabilities_list", { revision: "0".repeat(64) }],
  ]) {
    assert.equal((await invoke(name, args)).isError, true, name);
  }
});
