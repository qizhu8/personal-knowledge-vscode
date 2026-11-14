import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initialize, Storage } from "../dist/storage.js";
import { CoreError } from "../dist/contracts.js";
import { serializeTodoBoard, readTodoBoard } from "../dist/domain/todo-board.js";
import { createLegacyNoteWorkItemsJournal, LEGACY_NOTE_WORKITEMS_JOURNAL_DDL } from "../dist/legacy-note-workitems-journal.js";
import { preflightLegacyNoteWorkItemsAdmission } from "../dist/legacy-note-workitems-admission.js";
import { createHash } from "node:crypto";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../legacy");
const actor = { id: "mcp:external", canWrite: true, collaborationKind: "agent" };
const slug = "Board";
const item = { id: "first", title: "Verify", goal: "Observe", scope: "API", acceptance: ["Checked"], state: "Planning", evidence: [] };
const extra = { id: "second", title: "Next", goal: "Observe", scope: "API", acceptance: ["Checked"], kind: "Task", state: "Planning", evidence: [] };
const note = "---\r\ntitle: Board\r\ndocumentKind: todo-board\r\nunknown:\r\n  preserve: 'exact'\r\n---\r\n# Original retained\r\n";
const first = serializeTodoBoard([item], {});
const hash = value => createHash("sha256").update(value).digest("hex");
const names = { command: "legacy.note.workitems.command", upsert: "legacy.note.workitems.upsert" };

async function setup(t) {
  const parent = join(dirname(fileURLToPath(import.meta.url)), `.legacy-note-workitems-${randomUUID()}`);
  const root = join(parent, "workspace"), original = join(parent, "original");
  await mkdir(parent); await initialize(root);
  await mkdir(join(root, "notes", "Board.assets"), { recursive: true });
  await mkdir(join(root, "boards", slug), { recursive: true });
  await writeFile(join(root, "notes", "Board.md"), note);
  await writeFile(join(root, "notes", "Board.assets", "pkm-todo-board.json"), first);
  await writeFile(join(root, "boards", slug, "pkm-todo-board.json"), first);
  const binding = preflightLegacyNoteWorkItemsAdmission({ slug, sourceMarkdown: note, sourceMarkdownDigest: hash(note),
    sourceBoard: first, sourceBoardDigest: hash(first), nativeBoard: first, nativeBoardDigest: hash(first) });
  assert.equal(binding.status, "eligible-for-native-policy");
  await mkdir(original); await cp(join(root, "notes"), join(original, "notes"), { recursive: true });
  const sessions = [];
  t.after(async () => { for (const session of sessions) await session.close(); await rm(parent, { recursive: true, force: true }); });
  async function open() {
    const storage = await Storage.open(root);
    const db = new DatabaseSync(join(root, "core.sqlite")); db.exec(LEGACY_NOTE_WORKITEMS_JOURNAL_DDL);
    let active = false, fault = false, closed = false;
    const journal = createLegacyNoteWorkItemsJournal(db, {
      async withDurableFence(_id, work) {
        assert(!active, "fixture admission serializes all workspace requests");
        return storage.withWorkspaceExclusive(async () => {
          active = true;
          try { storage.assertWorkspaceLease(); return await work(); } finally { active = false; }
        });
      },
      authorize: (who, _operation, board) => who.id === actor.id && board === slug,
      async readAdmittedBoard(board) {
        assert(active); assert.equal(board, slug);
        assert.equal(await readFile(join(root, "notes", "Board.md"), "utf8"), note);
        assert.equal(await readFile(join(root, "notes", "Board.assets", "pkm-todo-board.json"), "utf8"), first);
        return readFile(join(root, "boards", slug, "pkm-todo-board.json"), "utf8");
      },
      async invokeNative(operation, args, who) {
        assert(active);
        const result = await storage.requestLegacyNoteWorkItems({ operation, args, actorId: who.id }, String(args.operationId));
        if (fault) { fault = false; throw new CoreError("STORAGE_ERROR", "Simulated interruption after native commit", "unknown"); }
        return result;
      },
    });
    const session = { journal, db, storage, failAfterCommit: () => { fault = true; },
      close: async () => { if (!closed) { closed = true; db.close(); await storage.close(); } } };
    sessions.push(session); return session;
  }
  function old(operation, fields, now) {
    const script = `const RealDate=Date;global.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[${JSON.stringify(now)}]))}static now(){return +new RealDate(${JSON.stringify(now)})}};process.argv=[process.execPath,${JSON.stringify(join(repo, "resources/knowledge_mutations.js"))},${JSON.stringify(repo)},${JSON.stringify(original)}];require(process.argv[1]);`;
    const result = spawnSync(process.execPath, ["-e", script], {
      input: JSON.stringify({ operation, area: "notes", path: "Board.md", ...fields }), encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  return { root, original, open, old };
}
test("original worker claim and upsert match native bytes and immutable historical full-snapshot receipts", async t => {
  const { root, original, open, old } = await setup(t);
  const { journal, db } = await open();
  const claim = { slug, expected_digest: readTodoBoard(first).digest, command: { action: "claim", id: item.id }, operationId: randomUUID() };
  const one = await journal.dispatch(names.command, claim, actor);
  assert.deepEqual(await journal.read(slug, actor), one);
  const originalOne = old("work-item-command", { expectedDigest: claim.expected_digest, command: claim.command }, one.items[0].history.at(-1).at);
  assert.deepEqual(one, originalOne);
  assert.equal(await readFile(join(root, "boards", slug, "pkm-todo-board.json"), "utf8"),
    await readFile(join(original, "notes", "Board.assets", "pkm-todo-board.json"), "utf8"));
  const upsert = { slug, expected_digest: one.digest, item: extra, operationId: randomUUID() };
  const two = await journal.dispatch(names.upsert, upsert, actor);
  assert.deepEqual(await journal.read(slug, actor), two);
  const originalTwo = old("work-item-upsert", { expectedDigest: upsert.expected_digest, item: extra }, two.items[1].history.at(-1).at);
  assert.deepEqual(two, originalTwo);
  const edit = { slug, expected_digest: two.digest, operationId: randomUUID(),
    command: { action: "edit", item: { ...two.items[0], links: ["test://checked"] }, reason: "Add evidence link" } };
  const three = await journal.dispatch(names.command, edit, actor);
  assert.deepEqual(three, old("work-item-command", { expectedDigest: edit.expected_digest, command: edit.command },
    three.items[0].history.at(-1).at));
  assert.equal(await readFile(join(root, "boards", slug, "pkm-todo-board.json"), "utf8"),
    await readFile(join(original, "notes", "Board.assets", "pkm-todo-board.json"), "utf8"));
  assert.deepEqual(await journal.dispatch(names.command, claim, actor), one, "replay returns historical full snapshot");
  assert.equal(db.prepare("SELECT count(*) AS n FROM legacy_note_workitems_receipt").get().n, 3);
  assert.throws(() => db.prepare("DELETE FROM legacy_note_workitems_receipt WHERE operation_id=?").run(claim.operationId), /immutable/);
  assert.equal(await readFile(join(root, "notes", "Board.md"), "utf8"), note);
  await assert.rejects(journal.dispatch(names.command, { ...claim, command: { action: "release", id: item.id, reason: "Changed" } }, actor), { code: "CONFLICT" });
  await assert.rejects(journal.dispatch(names.command, { ...claim, actorId: "user:local" }, actor), { code: "INVALID_ARGUMENT" });
  await assert.rejects(journal.dispatch(names.command, { ...claim, operationId: randomUUID() }, actor), /changed/);
  await assert.rejects(journal.dispatch(names.command, { ...claim, operationId: randomUUID(), expected_digest: three.digest,
    command: { action: "accept", id: item.id, reason: "forged" } }, actor), { code: "NOT_AVAILABLE" });
  await assert.rejects(journal.dispatch(names.command, { ...claim, operationId: randomUUID(), expected_digest: three.digest,
    command: { action: "claim", id: extra.id } }, actor), { code: "WORKITEM_FOCUS_CONFLICT" });
  assert.equal(db.prepare("SELECT count(*) AS n FROM legacy_note_workitems_intent").get().n, 0);
  const release = { slug, expected_digest: three.digest, operationId: randomUUID(),
    command: { action: "release", id: item.id, reason: "Handoff" } };
  const four = await journal.dispatch(names.command, release, actor);
  assert.deepEqual(four, old("work-item-command", { expectedDigest: release.expected_digest, command: release.command },
    four.items[0].history.at(-1).at));
  assert.equal(four.items[0].ownerId, undefined);
  assert.deepEqual(await journal.dispatch(names.upsert, upsert, actor), two);
});
test("native commit interruption keeps a durable intent; exact retry after restart creates one full receipt", async t => {
  const { open } = await setup(t);
  const one = await open();
  const args = { slug, expected_digest: readTodoBoard(first).digest, command: { action: "claim", id: item.id }, operationId: randomUUID() };
  one.failAfterCommit();
  await assert.rejects(one.journal.dispatch(names.command, args, actor), { effect: "unknown" });
  assert.equal(one.db.prepare("SELECT count(*) AS n FROM legacy_note_workitems_intent").get().n, 1);
  await assert.rejects(one.journal.read(slug, actor), { code: "BUSY" });
  await one.close();
  const two = await open();
  await assert.rejects(two.journal.dispatch(names.command, { ...args, operationId: randomUUID() }, actor), { code: "BUSY" });
  await two.storage.recover(async () => {
    await two.journal.dispatch(names.command, args, actor);
  });
  const replay = await two.journal.dispatch(names.command, args, actor);
  assert.equal(replay.items[0].ownerId, actor.id);
  assert.equal(replay.items[0].history.length, 1);
  assert.equal(two.db.prepare("SELECT count(*) AS n FROM legacy_note_workitems_intent").get().n, 0);
  assert.equal(two.db.prepare("SELECT count(*) AS n FROM legacy_note_workitems_receipt").get().n, 1);
  assert.deepEqual(await two.journal.dispatch(names.command, args, actor), replay);
});
test("pinned admission refuses changed bytes and never converts inline Markdown", () => {
  const inline = `---\ntitle: Source\nunknown: keep\n---\n~~~pkm-work-item\n${JSON.stringify(item)}\n~~~\n`;
  const base = { slug, sourceMarkdown: inline, sourceMarkdownDigest: hash(inline), nativeBoard: first, nativeBoardDigest: hash(first) };
  const result = preflightLegacyNoteWorkItemsAdmission(base);
  assert.equal(result.status, "inline-unavailable");
  assert.equal(result.itemParity, true);
  assert.throws(() => preflightLegacyNoteWorkItemsAdmission({ ...base, sourceMarkdownDigest: "0".repeat(64) }), { code: "CONFLICT" });
  assert.throws(() => preflightLegacyNoteWorkItemsAdmission({ ...base, sourceBoard: first, sourceBoardDigest: "0".repeat(64) }), { code: "CONFLICT" });
  const different = serializeTodoBoard([{ ...item, title: "Not equivalent" }], {});
  assert.throws(() => preflightLegacyNoteWorkItemsAdmission({ ...base, sourceBoard: different, sourceBoardDigest: hash(different) }), { code: "NOT_AVAILABLE" });
});
