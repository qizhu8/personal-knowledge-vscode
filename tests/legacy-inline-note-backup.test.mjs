import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { actor, item, markdown, hash, fixture, originalCapture } from "./legacy-inline-note-captures.mjs";
import { createNativeLegacyInlineNoteHost } from "../dist/legacy-inline-note-native.js";
import { assertLegacyInlineNoteWorkspaceUnfenced, inspectLegacyInlineNoteHistory } from "../dist/legacy-inline-note-journal.js";

test("fenced native owner backup copies exact Note plus SQLite journal; restored harness replays original receipt and continues lineage", async t => {
  const f = await fixture(t);
  const { result, request } = await f.compareOriginal(item, actor, "legacy.note.workitems.upsert");
  const original = await f.read();
  const restoreRoot = join(f.parent, "restore");
  await mkdir(join(restoreRoot, "notes"), { recursive: true });
  const databasePath = join(restoreRoot, "restored-journal.sqlite");
  await f.withDurableFence("fixture-backup", async () => {
    assertLegacyInlineNoteWorkspaceUnfenced(f.database);
    await writeFile(join(restoreRoot, "notes/Original.md"), await f.read());
    f.database.prepare("VACUUM INTO ?").run(databasePath);
  });
  const restored = new DatabaseSync(databasePath);
  try {
    const runtime = createNativeLegacyInlineNoteHost({
      database: restored, root: restoreRoot, policy: f.policy, withDurableFence: f.withDurableFence,
      now: () => "2026-11-07T16:30:34.625Z",
    });
    const replay = await runtime.journal.dispatch("legacy.note.workitems.upsert", request, actor);
    assert.deepEqual(replay, result);
    assert.equal(await readFile(join(restoreRoot, "notes/Original.md"), "utf8"), original);
    assert.equal(inspectLegacyInlineNoteHistory(restored, "Original", hash(markdown)).head, hash(original));
    const claimed = await runtime.journal.dispatch("legacy.note.workitems.command", {
      slug: "Original", expected_digest: replay.digest, operationId: randomUUID(), command: { action: "claim", id: item.id },
    }, actor);
    const { parser } = originalCapture();
    const expected = parser.commandNoteWorkItem(original, replay.digest, { action: "claim", id: item.id }, { id: actor.id, role: "worker" });
    assert.equal(await readFile(join(restoreRoot, "notes/Original.md"), "utf8"), expected);
    assert.equal(JSON.stringify(claimed), JSON.stringify({ ok: true, ...parser.readNoteWorkItems(expected) }));
  } finally { restored.close(); }
});
