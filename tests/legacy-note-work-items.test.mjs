import { test } from "node:test";
import assert from "node:assert/strict";
import { commandNoteWorkItem, readNoteWorkItems, upsertNoteWorkItem, validateNoteWorkItem, workItemIcons } from "../dist/domain/note-work-items.js";

const item = { id:"verify-1", title:"Verify endpoint", goal:"Return the documented response", scope:"GET /health",
  acceptance:["HTTP 200 and exact response body"], state:"Planning", evidence:[] };

test("Work Items round-trip without rewriting surrounding Markdown, including CRLF and fenced examples", () => {
  const markdown = "---\r\ntitle: Plan\r\n---\r\n# Project\r\n\r\n````markdown\r\n~~~pkm-work-item\r\nnot JSON\r\n~~~\r\n````\r\n";
  const initial = readNoteWorkItems(markdown);
  assert.deepEqual(initial.items, []);
  const appended = upsertNoteWorkItem(markdown, initial.digest, item);
  assert(appended.startsWith(markdown));
  assert(!/(?<!\r)\n/.test(appended));
  assert.deepEqual(readNoteWorkItems(appended).items, [item]);
  const suffix = "\r\nKeep this manual section.\r\n";
  const before = appended + suffix;
  const updated = upsertNoteWorkItem(before, readNoteWorkItems(before).digest, {
    ...item, state:"Done", outcome:"Failed", evidence:["test-run:health failed (HTTP 503)"],
  });
  assert(updated.startsWith(markdown));
  assert(updated.endsWith(suffix));
  assert.equal(readNoteWorkItems(updated).items[0].outcome, "Failed", "Done does not imply Success");
  assert.throws(() => upsertNoteWorkItem(updated, initial.digest, item), /changed/);
});

test("Malformed or ambiguous Work Items fail instead of disappearing or guessing completion", () => {
  for (const invalid of [{ ...item, id:"../escape" }, { ...item, acceptance:[] }, { ...item, state:"Done" },
    { ...item, state:"Blocked" }, { ...item, outcome:"Success" }, { ...item, extra:"silently dropped" },
    { ...item, state:["Planning"] }, { ...item, state:"Done", outcome:["Success"], evidence:["report"] }]) {
    assert.throws(() => validateNoteWorkItem(invalid));
  }
  assert.throws(() => readNoteWorkItems("~~~pkm-work-item\n{}"), /Unclosed/);
  assert.throws(() => readNoteWorkItems("~~~pkm-work-item\nnot json\n~~~\n"), /Invalid Work Item JSON/);
  const single = upsertNoteWorkItem("", readNoteWorkItems("").digest, item);
  assert.throws(() => readNoteWorkItems(single + single), /Duplicate/);
});

test("Only explicit body blocks are updated and all terminal outcomes remain distinct", () => {
  const header = "---\ndescription: |\n  ~~~pkm-work-item\n  this is a YAML scalar, not a Work Item\n  ~~~\n---\n";
  assert.deepEqual(readNoteWorkItems(header).items, []);
  const first = upsertNoteWorkItem(header, readNoteWorkItems(header).digest, {
    ...item, title:"Keep ```backticks``` and ~~~ tildes\non a new line",
  });
  const both = upsertNoteWorkItem(first, readNoteWorkItems(first).digest, { ...item, id:"second" });
  for (const outcome of ["Success", "Failed", "Unsure"]) {
    const updated = upsertNoteWorkItem(both, readNoteWorkItems(both).digest, {
      ...item, id:"second", state:"Done", outcome, evidence:["verification-log"],
    });
    assert(updated.startsWith(first), "another item's bytes must be preserved");
    const records = readNoteWorkItems(updated).items;
    assert.equal(records[1].outcome, outcome);
    const reopened = upsertNoteWorkItem(updated, readNoteWorkItems(updated).digest, {
      ...item, id:"second", state:"Blocked", blockedReason:"Needs review",
    });
    assert.equal(readNoteWorkItems(reopened).items[1].state, "Blocked");
  }
  assert.throws(() => upsertNoteWorkItem(first.replace("description:", "summary:"), readNoteWorkItems(first).digest, item), /changed/);
  const backtick = "````pkm-work-item\n" + JSON.stringify(item) + "\n````\n";
  assert.deepEqual(readNoteWorkItems(backtick).items, [item]);
});
