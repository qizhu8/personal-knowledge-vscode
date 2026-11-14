const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { readNoteWorkItems, upsertNoteWorkItem, validateNoteWorkItem } = require("../dist/knowledge/note-work-items");
const store = require("../dist/knowledge/filestore");

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

function bridge(root, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, "../resources/knowledge_mutations.js"),
      path.resolve(__dirname, ".."), root], { stdio:["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(request));
  });
}

test("Note bridge serializes concurrent writers, rejects stale manual edits and preserves lifecycle/resources", async t => {
  const root = fs.mkdtempSync(path.join(__dirname, ".note-work-items-"));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  store.setStorePath(root);
  store.noteUpsert({ slug:"Plan", title:"Plan", content:"# Scope\n\nManual prose.", type:"todo", tags:[] });
  const full = path.join(root, "notes", "Plan.md");
  const original = fs.readFileSync(full, "utf8");
  const before = store.noteWorkItemsRead("Plan");
  const requests = [item, { ...item, id:"other" }].map(value => bridge(root, {
    operation:"work-item-upsert", area:"notes", path:"Plan.md", expectedDigest:before.digest, item:value,
  }));
  const results = await Promise.all(requests);
  assert.equal(results.filter(result => result.code === 0).length, 1, JSON.stringify(results));
  assert.match(results.find(result => result.code !== 0).stderr, /Note changed/);
  const committed = store.noteWorkItemsRead("Plan");
  assert.equal(committed.items.length, 1);
  assert(fs.readFileSync(full, "utf8").startsWith(original));
  fs.appendFileSync(full, "\nManual edit after read.\n");
  assert.throws(() => store.noteWorkItemUpsert("Plan", committed.digest, item), /changed/);
  const saved = fs.readFileSync(full, "utf8");
  const readback = await bridge(root, { operation:"work-items-read", area:"notes", path:"Plan.md" });
  assert.equal(readback.code, 0, readback.stderr);
  assert.deepEqual(JSON.parse(readback.stdout).items, committed.items);
  const assetDirectory = path.join(root, "notes", "Plan.assets");
  fs.mkdirSync(assetDirectory);
  fs.writeFileSync(path.join(assetDirectory, "evidence.txt"), "verification evidence");
  store.writeKnowledgeMarkdown("notes", "Moved/Plan.md", "Plan.md", saved);
  assert.equal(fs.readFileSync(path.join(root, "notes", "Moved", "Plan.assets", "evidence.txt"), "utf8"), "verification evidence");
  assert.deepEqual(store.noteWorkItemsRead("Moved/Plan").items, committed.items);
  const moved = path.join(root, "notes", "Moved", "Plan.md");
  const movedMarkdown = fs.readFileSync(moved, "utf8");
  const trash = store.knowledgePathMoveToTrash("notes", "Moved/Plan.md");
  assert(trash);
  assert.throws(() => store.noteWorkItemsRead("Moved/Plan"), /ENOENT/);
  assert.equal(store.knowledgeTrashRestore("notes", trash.id).ok, true);
  assert.equal(fs.readFileSync(moved, "utf8"), movedMarkdown);
  assert.deepEqual(store.noteWorkItemsRead("Moved/Plan").items, committed.items);
  assert.equal(fs.readFileSync(path.join(root, "notes", "Moved", "Plan.assets", "evidence.txt"), "utf8"), "verification evidence");
  assert.throws(() => store.noteWorkItemsRead("../outside"), /Invalid|escape/);
  const link = path.join(root, "notes", "Linked.md");
  fs.symlinkSync(moved, link);
  assert.throws(() => store.noteWorkItemsRead("Linked"), /Symbolic links/);
  assert.throws(() => store.noteWorkItemUpsert("Linked", store.noteWorkItemsRead("Moved/Plan").digest, item), /Symbolic links/);
  const deniedLink = await bridge(root, { operation:"work-items-read", area:"notes", path:"Linked.md" });
  assert.notEqual(deniedLink.code, 0);
  assert.match(deniedLink.stderr, /Symlink/);
  const deniedTraversal = await bridge(root, { operation:"work-items-read", area:"notes", path:"../outside.md" });
  assert.notEqual(deniedTraversal.code, 0);
  assert.match(deniedTraversal.stderr, /Unsafe/);
  fs.mkdirSync(path.join(root, "notes", "System"), { recursive:true });
  fs.writeFileSync(path.join(root, "notes", "System", "Rules.md"), "Protected");
  assert.throws(() => store.noteWorkItemUpsert("System/Rules", readNoteWorkItems("Protected").digest, item), /read-only/);
});
