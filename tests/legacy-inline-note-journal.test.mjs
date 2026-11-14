import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { actor, human, item, markdown, hash, fixture } from "./legacy-inline-note-captures.mjs";
import { createLegacyInlineNoteJournal, assertLegacyInlineNoteWorkspaceUnfenced,
  inspectLegacyInlineNoteFence, inspectLegacyInlineNoteHistory } from "../dist/legacy-inline-note-journal.js";

const operation = "legacy.note.workitems.command";
const request = () => ({ slug: "Original", expected_digest: hash(markdown), operationId: randomUUID(), command: { action: "create", item } });

test("restart returns immutable exact full-snapshot receipt; changed request or actor conflicts, historical receipt survives external edits", async t => {
  const f = await fixture(t);
  const input = request();
  const first = await f.runtime.journal.dispatch(operation, input, actor);
  const saved = await f.read();
  f.restart();
  assert.deepEqual(await f.runtime.journal.dispatch(operation, input, actor), first);
  await assert.rejects(f.runtime.journal.dispatch(operation, { ...input, command: { action: "create", item: { ...item, title: "different" } } }, actor), { code: "CONFLICT" });
  await assert.rejects(f.runtime.journal.dispatch(operation, input, human), { code: "CONFLICT" });
  assert.throws(() => f.database.prepare("UPDATE legacy_inline_note_receipt SET payload='{}'").run(), /immutable/);
  assert.throws(() => f.database.prepare("DELETE FROM legacy_inline_note_receipt").run(), /immutable/);
  await f.overwrite(saved + "external edit");
  assert.deepEqual(await f.runtime.journal.dispatch(operation, input, actor), first);
  await assert.rejects(f.runtime.journal.dispatch(operation, {
    slug: "Original", expected_digest: hash(await f.read()), operationId: randomUUID(), command: { action: "claim", id: item.id },
  }, actor), { code: "CONFLICT" });
  assert.equal(inspectLegacyInlineNoteHistory(f.database, "Original", hash(markdown)).head, first.digest);
});

test("before-write unknown interruption leaves workspace-wide durable fence; reopen and resume exact original effect", async t => {
  const f = await fixture(t);
  const input = request();
  const interrupted = createLegacyInlineNoteJournal(f.database, {
    ...f.runtime.host, writeExactNote: async () => { throw new Error("Interrupted before FS effects"); },
  });
  await assert.rejects(interrupted.dispatch(operation, input, actor), { code: "RECOVERY_REQUIRED", effect: "unknown" });
  assert.equal(await f.read(), markdown);
  const second = new DatabaseSync(f.databasePath);
  try {
    assert.equal(inspectLegacyInlineNoteFence(second).operationId, input.operationId);
    assert.throws(() => assertLegacyInlineNoteWorkspaceUnfenced(second), { code: "RECOVERY_REQUIRED", effect: "unknown" });
  } finally { second.close(); }
  f.restart();
  await assert.rejects(f.runtime.journal.dispatch(operation, input, actor), { code: "RECOVERY_REQUIRED" });
  await assert.rejects(f.runtime.journal.resume(input.operationId, human), { code: "ACCESS_DENIED" });
  const result = await f.runtime.journal.resume(input.operationId, actor);
  assert.equal(result.items[0].history.at(-1).actorId, actor.id);
  assert.equal(result.digest, hash(await f.read()));
  assert.equal(f.runtime.journal.inspect(), undefined);
  assert.deepEqual(await f.runtime.journal.dispatch(operation, input, actor), result);
});

test("after-write interruption recovers receipt without rewriting; partial/unknown bytes stay fenced with no silent rollback", async t => {
  const f = await fixture(t);
  const input = request();
  let writes = 0;
  const interrupted = createLegacyInlineNoteJournal(f.database, {
    ...f.runtime.host, writeExactNote: async (...args) => { writes++; await f.runtime.host.writeExactNote(...args); throw new Error("Lost receipt boundary"); },
  });
  await assert.rejects(interrupted.dispatch(operation, input, actor), { effect: "unknown" });
  const after = await f.read();
  f.restart();
  const noRewrite = createLegacyInlineNoteJournal(f.database, {
    ...f.runtime.host, writeExactNote: async () => { throw new Error("must not rewrite exact after"); },
  });
  assert.equal((await noRewrite.resume(input.operationId, actor)).digest, hash(after));
  assert.equal(writes, 1);
  const partial = await fixture(t);
  const partialInput = request();
  const bad = createLegacyInlineNoteJournal(partial.database, {
    ...partial.runtime.host, writeExactNote: async () => { await partial.overwrite("~~~pkm-work-item\n{\"id\":"); throw new Error("Partial native FS write"); },
  });
  await assert.rejects(bad.dispatch(operation, partialInput, actor), { effect: "unknown" });
  partial.restart();
  const unknown = await partial.read();
  await assert.rejects(partial.runtime.journal.resume(partialInput.operationId, actor), { code: "RECOVERY_REQUIRED", effect: "unknown" });
  assert.equal(await partial.read(), unknown);
  assert(partial.runtime.journal.inspect());
  // Explicit host restore of reviewed exact before, never an automatic rollback.
  await partial.overwrite(markdown);
  await partial.runtime.journal.resume(partialInput.operationId, actor);
  assert.equal(partial.runtime.journal.inspect(), undefined);
});

test("corrupt durable intent fails source replay validation before recovery or any new admission", async t => {
  const f = await fixture(t);
  const input = request();
  const interrupted = createLegacyInlineNoteJournal(f.database, {
    ...f.runtime.host, writeExactNote: async () => { throw new Error("before"); },
  });
  await assert.rejects(interrupted.dispatch(operation, input, actor), { effect: "unknown" });
  const original = f.database.prepare("SELECT payload FROM legacy_inline_note_intent").get().payload;
  for (const patch of [value => { value.after += "external"; }, value => { value.actor.id = "forged"; },
    value => { value.result.items[0].history[0].reason = "forged"; }, value => { value.before += "stale"; }]) {
    const value = JSON.parse(original);
    patch(value);
    f.database.prepare("UPDATE legacy_inline_note_intent SET payload=?").run(JSON.stringify(value));
    await assert.rejects(f.runtime.journal.resume(input.operationId, actor), { code: "STORAGE_ERROR", effect: "unknown" });
    assert.throws(() => assertLegacyInlineNoteWorkspaceUnfenced(f.database), { code: "STORAGE_ERROR" });
    assert.equal(await f.read(), markdown);
  }
  f.database.prepare("UPDATE legacy_inline_note_intent SET payload=?").run(original);
  await f.runtime.journal.resume(input.operationId, actor);
});

test("corrupt stored receipt and disconnected source lineage fail closed rather than accepting stale snapshots", async t => {
  const f = await fixture(t);
  const input = request();
  await f.runtime.journal.dispatch(operation, input, actor);
  const beforeCorruption = await f.read();
  const original = f.database.prepare("SELECT payload FROM legacy_inline_note_receipt").get().payload;
  f.database.exec("DROP TRIGGER legacy_inline_note_receipt_no_update");
  const corrupt = JSON.parse(original);
  corrupt.result.digest = "a".repeat(64);
  f.database.prepare("UPDATE legacy_inline_note_receipt SET payload=?").run(JSON.stringify(corrupt));
  await assert.rejects(f.runtime.journal.dispatch(operation, input, actor), { code: "STORAGE_ERROR", effect: "unknown" });
  assert.equal(await f.read(), beforeCorruption);
  f.database.prepare("UPDATE legacy_inline_note_receipt SET payload=?").run(original);
  assert.throws(() => inspectLegacyInlineNoteHistory(f.database, "Original", "b".repeat(64)), { code: "STORAGE_ERROR", effect: "unknown" });
});
