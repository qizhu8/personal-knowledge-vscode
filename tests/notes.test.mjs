import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm, utimes, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { initialize, Storage } from "../dist/storage.js";
import { Core } from "../dist/core.js";
import { scanMarkdown, sha256 } from "../dist/markdown.js";
import { readNotes } from "../dist/notes.js";
import { serializeTodoBoard } from "../dist/domain/todo-board.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startMcp } from "../dist/mcp.js";
import { startHttp } from "../dist/http.js";

async function fixture(t) {
  const parent = join(dirname(fileURLToPath(import.meta.url)), `.notes-${randomUUID()}`);
  const directory = join(parent, "workspace");
  await mkdir(parent, { recursive: true });
  await initialize(directory);
  const storage = await Storage.open(directory), core = new Core(storage);
  t.after(async () => { try { await storage.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
  const query = (operation, args = {}) => core.dispatch("capability_read",
    { operation: `knowledge.note.${operation}`, version: 1, arguments: args }, { id: "local:reader", canWrite: false });
  async function note(path, fields = {}, body = "Note body", time = 1000) {
    const metadata = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
    const raw = metadata ? `---\n${metadata}\n---\n${body}` : body;
    await mkdir(join(directory, "notes", path, ".."), { recursive: true });
    await writeFile(join(directory, "notes", path), raw);
    await utimes(join(directory, "notes", path), new Date(time), new Date(time));
    return raw;
  }
  return { directory, query, note, core };
}

test("Note lists return more than 100 and limit zero returns the remainder through Core, HTTP and MCP", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  for (let index = 0; index < 251; index++) await f.note(`Note-${String(index).padStart(3, "0")}.md`, {}, "Note", 1000 + index * 1000);
  const first = (await f.query("list", { limit: 150 })).result;
  assert.equal(first.total, 251);
  assert.equal(first.items.length, 150);
  assert.equal(first.nextOffset, 150);
  const rest = (await f.query("list", { offset: 150, limit: 0, snapshotRevision: first.snapshotRevision })).result;
  assert.equal(rest.items.length, 101);
  assert.equal(rest.nextOffset, null);
  assert.equal(new Set([...first.items, ...rest.items].map(note => note.path)).size, 251);
  assert.equal((await f.query("list", { limit: 1000 })).result.items.length, 251);
  assert.equal((await f.query("list", { offset: 1000, limit: 0, snapshotRevision: first.snapshotRevision })).result.items.length, 0);
  assert.equal((await f.query("list", { limit: -1 })).error.code, "INVALID_ARGUMENT");
  assert.equal((await f.query("list", { limit: 1.5 })).error.code, "INVALID_ARGUMENT");
  const actor = { id: "local:reader", canWrite: false };
  const token = randomUUID() + randomUUID();
  const http = await startHttp(f.core, token, actor);
  t.after(() => new Promise((resolve, reject) => http.server.close(error => error ? reject(error) : resolve())));
  const invocation = { operation: "knowledge.note.list", version: 1, arguments: { limit: 0 } };
  const response = await fetch(`${http.url}/v1/capability_read`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(invocation),
  });
  assert.equal(response.status, 200);
  const httpResult = await response.json();
  assert.equal(httpResult.result.items.length, 251);
  assert.equal(httpResult.result.snapshotRevision, first.snapshotRevision);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startMcp(f.core, actor, serverTransport);
  const client = new Client({ name: "note-limit-test", version: "1.0.0" });
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const mcp = await client.callTool({ name: "capability_read", arguments: invocation });
  assert.equal(mcp.isError, false);
  assert.equal(mcp.structuredContent.result.items.length, 251);
  assert.equal(mcp.structuredContent.result.snapshotRevision, first.snapshotRevision);
  await f.note("Changed.md");
  assert.equal((await f.query("list", { offset: 150, limit: 0, snapshotRevision: first.snapshotRevision })).error.code, "CONFLICT");
});

test("Note projection preserves original metadata, plain defaults and body-free update-time ordering", async t => {
  const f = await fixture(t);
  const raw = await f.note("Team/Legacy.MD", {
    title: "Display title", type: "decision", tags: ["one", "one"], pinned: true,
    description: "Description", created: "Original date", custom: { retained: true },
  }, "Private body", 2000);
  await f.note("Fallback.md", {}, "Fallback body", 1000);
  const first = (await f.query("list", { limit: 1 })).result;
  assert.equal(first.total, 2);
  const item = first.items[0];
  assert.equal(item.slug, "Team/Legacy");
  assert.equal(item.title, "Display title");
  assert.equal(item.type, "decision");
  assert.equal(item.tags, '["one","one"]');
  assert.equal(item.category, "Team");
  assert.equal(item.pinned, true);
  assert.equal(item.created_at, "Original date");
  assert.equal(item.documentKind, "markdown");
  assert(!Object.hasOwn(item, "content"));
  const get = (await f.query("get", { path: item.path, snapshotRevision: first.snapshotRevision })).result;
  assert.equal(get.item.content, "Private body");
  assert.deepEqual((await f.query("get", { id: item.documentId })).result, get);
  const second = (await f.query("list", { offset: first.nextOffset, snapshotRevision: first.snapshotRevision })).result;
  assert.equal(second.nextOffset, null);
  assert.equal(second.items[0].type, "general");
  assert.equal(second.items[0].title, "Fallback");
  assert.equal(second.items[0].tags, "[]");
  assert.equal((await f.query("list", { type: "decision" })).result.total, 1);
  assert.equal((await f.query("list", { type: "all" })).result.total, 2);
  assert.equal((await f.query("list", { type: "DECISION" })).result.total, 0);
  assert.equal(await readFile(join(f.directory, "notes/Team/Legacy.MD"), "utf8"), raw);
});

test("legacy Note Board classification incorporates checked backing digest and update time without exposing grants", async t => {
  const f = await fixture(t);
  await f.note("Board.MD", { type: "todo" }, "", 1000);
  await f.note("Recent.md", {}, "Recent", 2000);
  await mkdir(join(f.directory, "notes/Board.assets"));
  const boardPath = join(f.directory, "notes/Board.assets/pkm-todo-board.json");
  const raw = serializeTodoBoard([], { "external:copilot:agent": "a".repeat(64) });
  await writeFile(boardPath, raw);
  await utimes(boardPath, new Date(3000), new Date(3000));
  const list = (await f.query("list")).result;
  assert.equal(list.items[0].slug, "Board");
  assert.equal(list.items[0].documentKind, "todo-board");
  assert.equal(list.items[0].boardDigest, sha256(raw));
  assert.equal(list.items[0].updated_at, new Date(3000).toISOString());
  assert.equal(list.items[0].created_at, new Date(1000).toISOString());
  assert(!JSON.stringify(list).includes("a".repeat(64)), "Worker grants remain private backing state.");
  await writeFile(boardPath, serializeTodoBoard([]));
  const stale = await f.query("get", { path: "Board.MD", snapshotRevision: list.snapshotRevision });
  assert.equal(stale.error.code, "CONFLICT");
  assert.equal(await readFile(join(f.directory, "notes/Board.MD"), "utf8"), "---\ntype: \"todo\"\n---\n");
});

test("Board descriptors without backing retain original classification; unsafe/malformed backing fails explicitly", async t => {
  const f = await fixture(t);
  await f.note("Board.md", { documentKind: "todo-board" }, "");
  const descriptor = (await f.query("get", { path: "Board.md" })).result.item;
  assert.equal(descriptor.documentKind, "todo-board");
  assert(!Object.hasOwn(descriptor, "boardDigest"));
  await mkdir(join(f.directory, "notes/Board.assets"));
  const path = join(f.directory, "notes/Board.assets/pkm-todo-board.json");
  for (const bytes of [Buffer.from("{"), Buffer.from([0xff, 0xfe]), Buffer.from('{"schema":"wrong","items":[]}')]) {
    await writeFile(path, bytes);
    assert.equal((await f.query("list")).error.code, "INVALID_DOCUMENT");
    assert.deepEqual(await readFile(path), bytes);
  }
  await rm(path);
  await symlink(join(f.directory, "notes/Board.md"), path);
  assert.equal((await f.query("get", { path: "Board.md" })).error.code, "INVALID_DOCUMENT");
});

test("Note pins detect unknown metadata/body changes, stable IDs resolve aliases and selectors are strict", async t => {
  const f = await fixture(t);
  await f.note("Note.md", { documentId: "stable-note", knowledgeId: "knowledge_0123456789abcdef01234567" });
  const first = (await f.query("list")).result;
  assert.equal((await f.query("get", { id: "knowledge_0123456789abcdef01234567" })).result.item.documentId, "stable-note");
  await mkdir(join(f.directory, "skills"));
  await writeFile(join(f.directory, "skills/Other.md"), "Other Skill");
  assert.equal((await f.query("list", { snapshotRevision: first.snapshotRevision })).result.snapshotRevision, first.snapshotRevision);
  await f.note("Note.md", { documentId: "stable-note", knowledgeId: "knowledge_0123456789abcdef01234567", custom: 1 });
  assert.equal((await f.query("list", { snapshotRevision: first.snapshotRevision })).error.code, "CONFLICT");
  const pin = (await f.query("list")).result.snapshotRevision;
  const path = join(f.directory, "notes/Note.md");
  await writeFile(path, (await readFile(path, "utf8")).replace("---\n", "---\n# Preserved comment\n"));
  assert.equal((await f.query("get", { id: "stable-note", snapshotRevision: pin })).error.code, "CONFLICT");
  for (const args of [{}, { id: "stable-note", path: "Note.md" }, { path: "../unsafe.md" }]) {
    assert.equal((await f.query("get", args)).error.code, "INVALID_ARGUMENT");
  }
  assert.equal((await f.query("get", { id: "missing" })).error.code, "NOT_FOUND");
});

test("Note-specific invalid values are rejected before original dynamic sorting/filtering", async t => {
  const f = await fixture(t);
  for (const fields of [{ description: [] }, { type: 42 }, { tags: [{}] }, { created: 123 }]) {
    await f.note("Bad.md", fields);
    assert.equal((await f.query("list")).error.code, "INVALID_DOCUMENT");
    assert.equal((await f.query("get", { path: "Bad.md" })).error.code, "INVALID_DOCUMENT");
  }
});

test("Note snapshot has no aggregate count or byte ceiling", async t => {
  const f = await fixture(t);
  await f.note("A.md");
  const record = scanMarkdown(f.directory)[0];
  const request = { operation: "knowledge.note.list", args: { offset: 0, limit: 1 }, actorId: "local:reader" };
  const large = { ...record, raw: "x".repeat(1_048_576) };
  assert.equal(readNotes(f.directory, Array(33).fill(large), request).total, 33);
  assert.equal(readNotes(f.directory, Array(4097).fill(record), request).total, 4097);
  assert.equal(readNotes(f.directory, Array(100_001).fill(record), request).total, 100_001);
});

test("Note Board backing has no per-file or aggregate size ceiling", async t => {
  const f = await fixture(t);
  await f.note("Board.md", { documentKind: "todo-board" }, "");
  await mkdir(join(f.directory, "notes/Board.assets"));
  const path = join(f.directory, "notes/Board.assets/pkm-todo-board.json");
  const valid = serializeTodoBoard([]);
  const large = valid + " ".repeat(8_388_609 - Buffer.byteLength(valid));
  await writeFile(path, large);
  assert.equal((await f.query("get", { path: "Board.md" })).result.item.boardDigest, sha256(large));
  const source = { ...scanMarkdown(f.directory)[0], raw: "" };
  const request = { operation: "knowledge.note.list", args: { offset: 0, limit: 1 }, actorId: "local:reader" };
  assert.equal(readNotes(f.directory, Array(5).fill(source), request).total, 5);
  await writeFile(path, large + " ");
  assert.equal((await f.query("get", { path: "Board.md" })).result.item.boardDigest, sha256(large + " "));
});
