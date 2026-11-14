import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initialize, Storage } from "../dist/storage.js";
import { Core } from "../dist/core.js";
import { createNativeLegacyNoteWorkItemsHost, legacyNoteWorkItemsDefinitions, legacyNoteWorkItemsSupport } from "../dist/legacy-note-workitems.js";
import { serializeTodoBoard } from "../dist/domain/todo-board.js";
import { todoDefinitions } from "../dist/todo-definitions.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../legacy");
const actor = { id: "mcp:external", canWrite: true, collaborationKind: "agent" };
const item = { id: "a", title: "Verify", goal: "Observe", scope: "API", acceptance: ["Checked"], state: "Planning", evidence: [] };
const md = `---\r\ntitle: Source Note\r\nunknown:\r\n  keep: "yes"\r\n---\r\n# Original\r\n\r\n~~~pkm-work-item\r\n${JSON.stringify(item)}\r\n~~~\r\n`;
const board = serializeTodoBoard([{ ...item, id: "b", history: [{ at: "2026-01-01T00:00:00.000Z", actorId: "user:local", action: "create", to: "Planning" }] }], {});
const names = { read: "legacy.note.workitems.read", notes: "legacy.note.workitems.notes", command: "legacy.note.workitems.command", upsert: "legacy.note.workitems.upsert" };
async function setup(t) {
  const parent = join(dirname(fileURLToPath(import.meta.url)), `.legacy-note-workitems-${randomUUID()}`);
  const root = join(parent, "workspace");
  await mkdir(parent);
  await initialize(root);
  await mkdir(join(root, "notes", "Board.assets"), { recursive: true });
  await writeFile(join(root, "notes", "Note.md"), md);
  await writeFile(join(root, "notes", "Board.md"), "---\ntitle: Board\ndocumentKind: todo-board\nunknown: keep\n---\nManual content\n");
  await writeFile(join(root, "notes", "Board.assets", "pkm-todo-board.json"), board);
  const stores = [];
  t.after(async () => { for (const store of stores) await store.close(); await rm(parent, { recursive: true, force: true }); });
  async function open(path = root, policy = { authorize: () => true }) {
    const storage = await Storage.open(path); stores.push(storage);
    const core = new Core(storage);
    return { storage, core, host: createNativeLegacyNoteWorkItemsHost(storage, policy) };
  }
  function original(operation, path, extra = {}, source = root) {
    const result = spawnSync(process.execPath, [join(repo, "resources/knowledge_mutations.js"), repo, source],
      { input: JSON.stringify({ operation, area: "notes", path, ...extra }), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  return { root, parent, open, original };
}
test("frozen original bridge sources and strict catalog", async () => {
  const provenance = JSON.parse(await readFile(new URL("../src/domain/legacy-note-workitems-provenance.json", import.meta.url), "utf8"));
  for (const [path, hash] of Object.entries(provenance.sha256)) {
    assert.equal(createHash("sha256").update(await readFile(join(repo, path))).digest("hex"), hash, path);
  }
  for (const [path, hash] of Object.entries(provenance.implementationSha256)) {
    assert.equal(createHash("sha256").update(await readFile(join(repo, "next-server", path))).digest("hex"), hash, path);
  }
  assert.equal(legacyNoteWorkItemsDefinitions.length, 4);
  assert.match(legacyNoteWorkItemsSupport.command, /conditional/);
  for (const definition of legacyNoteWorkItemsDefinitions) assert.equal(definition.input.safeParse({ actorId: "user:local" }).success, false);
});
test("original JS bridge and native host agree on actual Markdown and attached Board snapshots", async t => {
  const { open, original, root } = await setup(t);
  const { host } = await open();
  for (const slug of ["Note", "Board"]) {
    const expected = original("work-items-read", `${slug}.md`);
    const actual = await host.dispatch(names.read, { slug }, actor);
    assert.deepEqual(actual, expected);
    assert.equal(actual.items[0].ownerId, undefined);
  }
  assert.equal(await readFile(join(root, "notes", "Note.md"), "utf8"), md);
  assert.equal(await readFile(join(root, "notes", "Board.assets", "pkm-todo-board.json"), "utf8"), board);
  const expected = original("work-item-notes", "_discovery.md", { query: "", limit: 20 });
  assert.deepEqual(await host.dispatch(names.notes, {}, actor), expected);
});
test("original and native readers accept Note Markdown and Board files beyond former byte ceilings", async t => {
  const { open, original, root } = await setup(t);
  const { host } = await open();
  const largeMarkdown = `${md}${"x".repeat(1_048_577)}`;
  await writeFile(join(root, "notes", "Note.md"), largeMarkdown);
  assert.ok(Buffer.byteLength(largeMarkdown) > 1_048_576);
  assert.deepEqual(
    await host.dispatch(names.read, { slug: "Note" }, actor),
    original("work-items-read", "Note.md"),
  );

  const items = Array.from({ length: 600 }, (_, index) => ({
    ...item,
    id: `board-item-${String(index).padStart(4, "0")}`,
    description: "x".repeat(16_000),
  }));
  const largeBoard = serializeTodoBoard(items, {});
  assert.ok(Buffer.byteLength(largeBoard) > 8 * 1024 * 1024);
  await writeFile(join(root, "notes", "Board.assets", "pkm-todo-board.json"), largeBoard);
  assert.deepEqual(
    await host.dispatch(names.read, { slug: "Board" }, actor),
    original("work-items-read", "Board.md"),
  );
});
test("original worker claim and native Board authority diverge; unsupported writes fail closed", async t => {
  const { open, root, parent, original } = await setup(t);
  const { host, core } = await open();
  const before = await host.dispatch(names.read, { slug: "Board" }, actor);
  const old = join(parent, "original"); await mkdir(old);
  await cp(join(root, "notes"), join(old, "notes"), { recursive: true });
  const claimed = original("work-item-command", "Board.md", {
    expectedDigest: before.digest, command: { action: "claim", id: "b" },
  }, old);
  assert.equal(claimed.items[0].ownerId, "mcp:external");
  assert.equal(claimed.items[0].history.at(-1).action, "claim");
  const args = { slug: "Board", expected_digest: before.digest, command: { action: "claim", id: "b" }, operationId: randomUUID() };
  await assert.rejects(host.dispatch(names.command, args, actor), { code: "NOT_AVAILABLE" });
  await assert.rejects(host.dispatch(names.command, { ...args, actorId: "user:local" }, actor), { code: "INVALID_ARGUMENT" });
  await assert.rejects(host.dispatch(names.upsert, { slug: "Note", expected_digest: "0".repeat(64), item, operationId: randomUUID() }, actor), { code: "NOT_AVAILABLE" });
  await assert.rejects(host.dispatch(names.command, args, { ...actor, canWrite: false }), { code: "ACCESS_DENIED" });
  assert.deepEqual(await host.dispatch(names.read, { slug: "Board" }, actor), before);
  assert.equal(await readFile(join(root, "notes", "Note.md"), "utf8"), md);
  assert.equal(await readFile(join(root, "notes", "Board.assets", "pkm-todo-board.json"), "utf8"), board);
  async function native(name, args, who = actor) {
    const definition = todoDefinitions.find(value => value.transportName === name);
    return core.dispatch(definition.readOnly ? "capability_read" : "capability_call",
      { operation: definition.id, version: 1, arguments: args }, who);
  }
  const created = await native("create_board", { board_slug: "Board", operationId: randomUUID() });
  assert(!created.error);
  const createId = randomUUID();
  const addArgs = { board_slug: "Board", expected_digest: created.result.digest,
    item: { id: "b", title: "Verify", goal: "Observe", scope: "API", acceptance: ["Checked"] }, operationId: createId };
  const added = await native("add_workitem", addArgs);
  assert.equal(added.result.item.kind, "Task");
  assert.equal(claimed.items[0].kind, undefined);
  assert.deepEqual((await native("add_workitem", addArgs)).result, added.result);
  assert.equal((await native("add_workitem", addArgs, { ...actor, id: "external:other:other" })).error.code, "CONFLICT");
  assert.deepEqual(await host.dispatch(names.read, { slug: "Board" }, actor), before, "native Board with same slug is not original attached-Board authority");
});
test("policy denial, restart and copied isolated workspace preserve exact read results", async t => {
  const { open, root, parent } = await setup(t);
  const first = await open();
  const expected = await first.host.dispatch(names.read, { slug: "Board" }, actor);
  await first.storage.close();
  const restarted = await open();
  assert.deepEqual(await restarted.host.dispatch(names.read, { slug: "Board" }, actor), expected);
  await restarted.storage.close();
  const backup = join(parent, "backup"); await cp(root, backup, { recursive: true });
  const copied = await open(backup, { authorize: who => who.id === actor.id });
  assert.deepEqual(await copied.host.dispatch(names.read, { slug: "Board" }, actor), expected);
  await assert.rejects(copied.host.dispatch(names.read, { slug: "Board" }, { ...actor, id: "external:other:denied" }), { code: "ACCESS_DENIED" });
});
