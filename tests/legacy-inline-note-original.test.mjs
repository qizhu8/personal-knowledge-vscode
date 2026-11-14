import { test } from "node:test";
import assert from "node:assert/strict";
import { actor, human, item, markdown, fixture, originalCapture } from "./legacy-inline-note-captures.mjs";

test("original actual writer -> native inline harness: complete source-qualified command/YAML/body/history set", async t => {
  const f = await fixture(t);
  await f.compareOriginal(item, actor, "legacy.note.workitems.upsert");
  await f.compareOriginal({ action: "claim", id: item.id });
  const { parser } = originalCapture();
  let value = parser.readNoteWorkItems(await f.read()).items[0];
  await f.compareOriginal({ ...value, links: ["evidence://capture"], evidence: ["unit://passed"],
    verification: [{ layer: "unit", status: "passed", evidence: ["unit://passed"] }] }, actor, "legacy.note.workitems.upsert");
  await f.compareOriginal({ action: "comment", id: item.id, text: "Opaque <script> ``` text" });
  await f.compareOriginal({ action: "transition", id: item.id, state: "Blocked", blockedReason: "Explicit prerequisite" });
  await f.compareOriginal({ action: "transition", id: item.id, state: "OnHold", reason: "Wait, do not take over" });
  await f.compareOriginal({ action: "release", id: item.id, reason: "Explicit release" });
  await f.compareOriginal({ action: "assign", id: item.id, ownerId: actor.id, reason: "Human assignment" }, human);
  await f.compareOriginal({ action: "claim", id: item.id });
  await f.compareOriginal({ action: "transition", id: item.id, state: "Done", outcome: "Unsure", evidence: ["functional://inconclusive"] });
  value = parser.readNoteWorkItems(await f.read()).items[0];
  assert.equal(value.acceptanceDecision, undefined);
  await f.compareOriginal({ action: "accept", id: item.id, reason: "Human reviewed explicit evidence" }, human);
  await f.compareOriginal({ action: "reopen", id: item.id, reason: "Human requests follow-up" }, human);
  value = parser.readNoteWorkItems(await f.read()).items[0];
  await f.compareOriginal({ action: "edit", item: { ...value, title: "Human contract change" }, reason: "Explicit contract" }, human);
  await f.compareOriginal({ action: "delete", id: item.id, reason: "Human soft delete" }, human);
  await f.compareOriginal({ action: "restore", id: item.id, reason: "Human restore" }, human);
  await f.compareOriginal({ action: "create", item: { ...item, id: "second" } });
  const saved = await f.read();
  assert(saved.startsWith(markdown));
  assert(!/(?<!\r)\n/.test(saved));
  assert.equal(JSON.stringify(parser.readNoteWorkItems(saved).items.map(value => value.id)), JSON.stringify(["one", "second"]));
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM legacy_inline_note_receipt").get().n, 16);
});

test("original LF/plain-body captures retain explicit Failed/Success/Unsure and transitions never imply acceptance", async t => {
  for (const outcome of ["Failed", "Success", "Unsure"]) {
    const f = await fixture(t, "# Original plain body\n\nManual unknown section.\n");
    await f.compareOriginal({ action: "create", item });
    await f.compareOriginal({ action: "claim", id: item.id });
    await f.compareOriginal({ action: "transition", id: item.id, state: "Planning" });
    await f.compareOriginal({ action: "transition", id: item.id, state: "WIP" });
    const { result } = await f.compareOriginal({ action: "transition", id: item.id, state: "Done", outcome, evidence: [`actual://${outcome}`] });
    assert.equal(result.items[0].outcome, outcome);
    assert.equal(result.items[0].acceptanceDecision, undefined);
    assert((await f.read()).startsWith("# Original plain body\n\nManual unknown section.\n"));
    assert.equal((await f.read()).includes("\r"), false);
  }
});

test("genuine backtick fixture keeps other blocks and suffix bytes, and human stale audit stripping matches original", async t => {
  const { parser } = originalCapture();
  const other = { ...item, id: "untouched" };
  const before = markdown + "````pkm-work-item\r\n" + JSON.stringify(item) + "\r\n````\r\n"
    + parser.upsertNoteWorkItem("", parser.noteWorkItemDigest(""), other).replace(/\n/g, "\r\n")
    + "\r\n## Unknown body suffix\r\n";
  const f = await fixture(t, before);
  const { result } = await f.compareOriginal({ action: "edit", item: { ...item, title: "Renamed", history: [],
    comments: [], acceptanceDecision: { by: "user:stale", at: "2026-01-01T00:00:00.000Z", decision: "accepted" } } }, human);
  const output = await f.read();
  assert.equal(result.items[0].title, "Renamed");
  assert.deepEqual(result.items[1], other);
  assert(output.endsWith(before.slice(before.indexOf("\r\n\r\n~~~pkm-work-item"))));
});
