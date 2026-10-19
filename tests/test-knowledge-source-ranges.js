const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readChatKnowledge, automaticChatSkills } = require("../dist/chat/knowledge-reader");
const { getStorePath, setStorePath, noteUpsert, noteGet, paperUpsert, paperGet } = require("../dist/knowledge/filestore");
const storage = require("../dist/knowledge/storage");
const { createRetrievalSnapshot } = require("../dist/retrieval/retrieval-snapshot");

test("real local knowledge handles fetch exact tail ranges and reject stale revision/hash/Unicode boundaries", () => {
  const previous = getStorePath(), directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-source-ranges-"));
  try {
    setStorePath(directory);
    const body = "\uFEFF" + "background.\r\n".repeat(14000) + "\ud83d\udc26 latency must not exceed 125 ms.\r\n";
    noteUpsert({ slug:"range-test", title:"range-test", content:body, type:"observation", tags:[] });
    const full = noteGet("range-test").content;
    const initial = JSON.parse(readChatKnowledge("pkm_read", "note", "range-test"));
    assert.equal(initial.truncated, true);
    const start = full.indexOf("\ud83d\udc26"), end = full.length;
    assert(start > 160000);
    const handle = { sourceRevision:initial.sourceRevision, contentHash:initial.contentHash };
    const tail = JSON.parse(readChatKnowledge("pkm_read", "note", "range-test", { ...handle, start, end }));
    assert.equal(tail.content, full.slice(start, end));
    assert.equal(tail.truncated, false);
    assert.deepEqual(tail.range, { start, end, unit:"characters" });
    assert.equal(tail.offsetEncoding, "utf16");
    assert.equal(tail.nextStart, null);
    assert.throws(() => readChatKnowledge("pkm_read", "note", "range-test", { ...handle, start:start + 1, end }), /surrogate/);
    assert.throws(() => readChatKnowledge("pkm_read", "note", "range-test", { start, end }), /revision and contentHash/);
    noteUpsert({ slug:"range-test", title:"range-test", content:full + "changed", type:"observation", tags:[] });
    assert.throws(() => readChatKnowledge("pkm_read", "note", "range-test", { ...handle, start, end }), /revision changed|hash changed/);
    const updated = JSON.parse(readChatKnowledge("pkm_read", "note", "range-test"));
    assert.throws(() => readChatKnowledge("pkm_read", "note", "range-test", { ...handle, sourceRevision:updated.sourceRevision, start, end }), /hash changed/);
    assert.equal(automaticChatSkills("latency").length, 0);
  } finally {
    setStorePath(previous);
    fs.rmSync(directory, { recursive:true, force:true });
  }
});

test("Research exact ranges include structured conclusions, implementation and assumptions in retrieval order", () => {
  const previous = getStorePath(), directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-research-ranges-"));
  try {
    setStorePath(directory);
    paperUpsert({ slug:"research-test", title:"research-test", content:"background\r\n".repeat(14000),
      conclusions:["No deployment."], implementation:["Use the offline fixture."], assumptions:["\ud83d\udc26 Valid only at 125 ms."] });
    const found = JSON.parse(readChatKnowledge("pkm_search", "research", "research-test"));
    assert.equal(found.items[0].id, "research-test");
    assert(!JSON.stringify(found).includes("No deployment."));
    const source = paperGet("research-test");
    const indexed = createRetrievalSnapshot({ skills:[], notes:[], papers:[source], scripts:[],
      subscriptionGroups:[], readSubscription() { throw new Error("No subscription reads"); } }).documents[0];
    const initial = JSON.parse(readChatKnowledge("pkm_read", "research", found.items[0].id));
    assert.equal(initial.kind, "research");
    assert.equal(initial.sourceId, indexed.source_id);
    assert.equal(initial.totalCharacters, indexed.body.length);
    assert.equal(initial.truncated, true);
    const start = indexed.body.indexOf("No deployment."), end = indexed.body.length;
    assert(start > 160000);
    const handle = { sourceRevision:initial.sourceRevision, contentHash:initial.contentHash };
    const tail = JSON.parse(readChatKnowledge("pkm_read", "research", found.items[0].id, { ...handle, start, end }));
    assert.equal(tail.content, indexed.body.slice(start, end));
    assert(tail.content.endsWith("\ud83d\udc26 Valid only at 125 ms."));
    paperUpsert({ slug:"research-test", title:"research-test", assumptions:["Changed shared conditions."] });
    assert.throws(() => readChatKnowledge("pkm_read", "research", found.items[0].id, { ...handle, start, end }), /revision changed|hash changed/);
    fs.renameSync(path.join(directory, "papers", "research-test.md"), path.join(directory, "removed.md"));
    assert.throws(() => readChatKnowledge("pkm_read", "research", found.items[0].id, { ...handle, start, end }), /existing local knowledge/);
  } finally {
    setStorePath(previous);
    fs.rmSync(directory, { recursive:true, force:true });
  }
});

test("Script discovery and pinned ranges read text without execution or following symlinks", () => {
  const previous = getStorePath(), directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-script-ranges-"));
  try {
    setStorePath(directory); storage.setStorePath(directory);
    const base = path.join(directory, "scripts"), folder = path.join(base, "nested");
    fs.mkdirSync(folder, { recursive:true });
    const body = "# background\r\n".repeat(14000) + "\ud83d\udc26 DO_NOT_EXECUTE\r\n";
    const file = path.join(folder, "fixture.sh");
    fs.writeFileSync(file, body);
    fs.writeFileSync(path.join(directory, "outside.sh"), "PRIVATE_OUTSIDE");
    fs.symlinkSync(directory, path.join(base, "escape"), "dir");
    fs.symlinkSync(base, path.join(base, "loop"), "dir");
    fs.symlinkSync(path.join(directory, "outside.sh"), path.join(base, "outside.sh"));
    const found = JSON.parse(readChatKnowledge("pkm_search", "script", "fixture"));
    assert.equal(found.items[0].id, "nested/fixture.sh");
    assert.deepEqual(JSON.parse(readChatKnowledge("pkm_search", "script", "outside")).items, []);
    const initial = JSON.parse(readChatKnowledge("pkm_read", "script", found.items[0].id));
    assert.match(initial.sourceId, /^pkm:\/\/script\/script_/);
    assert.equal(initial.sourceRevision, `sha256:${initial.contentHash}`);
    const handle = { sourceRevision:initial.sourceRevision, contentHash:initial.contentHash };
    const start = body.indexOf("\ud83d\udc26"), end = body.length;
    const tail = JSON.parse(readChatKnowledge("pkm_read", "script", found.items[0].id, { ...handle, start, end }));
    assert.equal(tail.content, body.slice(start, end));
    assert.throws(() => readChatKnowledge("pkm_read", "script", "outside.sh"), /existing local knowledge/);
    assert.throws(() => readChatKnowledge("pkm_read", "script", "../outside.sh"), /existing local knowledge/);
    fs.writeFileSync(file, body + "changed");
    assert.throws(() => readChatKnowledge("pkm_read", "script", found.items[0].id, { ...handle, start, end }), /revision changed|hash changed/);
    fs.unlinkSync(file);
    assert.throws(() => readChatKnowledge("pkm_read", "script", found.items[0].id, { ...handle, start, end }), /existing local knowledge/);
  } finally {
    setStorePath(previous); storage.setStorePath(previous);
    fs.rmSync(directory, { recursive:true, force:true });
  }
});

test("preview ranges have exact resumable Unicode boundaries even under JSON escape pressure", () => {
  const previous = getStorePath(), directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-preview-ranges-"));
  try {
    setStorePath(directory);
    for (const body of ["x".repeat(3999) + "\ud83d\udc26tail", "\u0001".repeat(3999) + "\ud83d\udc26tail"]) {
      noteUpsert({ slug:"preview", title:"preview", content:body, type:"observation", tags:[] });
      const full = noteGet("preview").content;
      const raw = readChatKnowledge("pkm_read", "note", "preview");
      const preview = JSON.parse(raw);
      assert(raw.length <= 16000);
      assert.equal(preview.content, full.slice(0, preview.range.end));
      assert.equal(preview.nextStart, preview.range.end);
      assert(!/[\uD800-\uDBFF]$/.test(preview.content));
      const rest = JSON.parse(readChatKnowledge("pkm_read", "note", "preview", {
        sourceRevision:preview.sourceRevision, contentHash:preview.contentHash,
        start:preview.nextStart, end:full.length,
      }));
      assert.equal(preview.content + rest.content, full);
    }
  } finally {
    setStorePath(previous);
    fs.rmSync(directory, { recursive:true, force:true });
  }
});

test("cached subscription ranges retain source identity and reject changed, private or removed cache entries", () => {
  const sourceId = "pkm://subscriptions/node/share/notes/" + "nested/".repeat(75) + "fixture.md";
  let snapshot = { corpus_revision:"initial", documents:[{
    source_id:sourceId, source_revision:"7", content_type:"subscription", visibility:"available",
    title:"Cached fixture", metadata:{ category:"nested" }, provenance:{ broker:"fixture" },
    body:"background\r\n".repeat(14000) + "\ud83d\udc26 do not deploy\r\n",
  }] };
  const read = () => snapshot;
  assert(sourceId.length > 512, "Real source locators must not be shortened to search-query limits.");
  const found = JSON.parse(readChatKnowledge("pkm_search", "subscription", "Cached", {}, read));
  assert.equal(found.items[0].id, sourceId);
  assert(!JSON.stringify(found).includes("do not deploy"));
  const preview = JSON.parse(readChatKnowledge("pkm_read", "subscription", sourceId, {}, read));
  assert.equal(preview.readOnly, true);
  assert.equal(preview.sourceId, sourceId);
  const content = snapshot.documents[0].body;
  const handle = { sourceRevision:preview.sourceRevision, contentHash:preview.contentHash };
  const start = content.indexOf("\ud83d\udc26"), end = content.length;
  assert.equal(JSON.parse(readChatKnowledge("pkm_read", "subscription", sourceId, { ...handle, start, end }, read)).content, content.slice(start, end));
  snapshot = { ...snapshot, documents:[{ ...snapshot.documents[0], body:content + "same-revision-change" }] };
  assert.throws(() => readChatKnowledge("pkm_read", "subscription", sourceId, { ...handle, start, end }, read), /hash changed/);
  snapshot = { ...snapshot, documents:[{ ...snapshot.documents[0], visibility:"private" }] };
  assert.deepEqual(JSON.parse(readChatKnowledge("pkm_search", "subscription", "Cached", {}, read)).items, []);
  assert.throws(() => readChatKnowledge("pkm_read", "subscription", sourceId, {}, read), /existing local knowledge/);
  snapshot = { ...snapshot, documents:[] };
  assert.throws(() => readChatKnowledge("pkm_read", "subscription", sourceId, {}, read), /existing local knowledge/);
  assert.throws(() => readChatKnowledge("pkm_search", "subscription", "Cached"), /unavailable in this Chat host/);
});

test("local Note discovery and reads do not lose identities beyond the first 1,000 records", () => {
  const previous = getStorePath(), directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-large-note-list-"));
  try {
    setStorePath(directory);
    const notes = path.join(directory, "notes");
    fs.mkdirSync(notes);
    fs.writeFileSync(path.join(notes, "old-target.md"), "---\ntitle: old-target\ncreated: 2020-01-01T00:00:00Z\n---\nold exact evidence");
    for (let index = 0; index < 1001; index++) fs.writeFileSync(path.join(notes, `new-${index}.md`),
      `---\ntitle: new-${index}\ncreated: 2026-01-01T00:00:00Z\n---\nnew evidence`);
    fs.utimesSync(path.join(notes, "old-target.md"), new Date("2020-01-01"), new Date("2020-01-01"));
    const result = JSON.parse(readChatKnowledge("pkm_search", "note", "old-target"));
    assert.equal(result.items[0].id, "old-target");
    assert.equal(JSON.parse(readChatKnowledge("pkm_read", "note", "old-target")).content, "old exact evidence");
  } finally {
    setStorePath(previous);
    fs.rmSync(directory, { recursive:true, force:true });
  }
});

test("Script root escapes fail explicitly while a linked Knowledge Root retains normal local reads", () => {
  const previous = getStorePath(), directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-script-root-"));
  try {
    const actual = path.join(directory, "actual"), linked = path.join(directory, "linked");
    fs.mkdirSync(path.join(actual, "scripts"), { recursive:true });
    fs.writeFileSync(path.join(actual, "scripts", "fixture.py"), "text only");
    fs.symlinkSync(actual, linked, "dir");
    setStorePath(linked); storage.setStorePath(linked);
    assert.equal(JSON.parse(readChatKnowledge("pkm_read", "script", "fixture.py")).content, "text only");
    fs.renameSync(path.join(actual, "scripts"), path.join(actual, "elsewhere"));
    fs.symlinkSync(path.join(actual, "elsewhere"), path.join(actual, "scripts"), "dir");
    assert.throws(() => readChatKnowledge("pkm_search", "script", "fixture"), /Script root resolves outside/);
  } finally {
    setStorePath(previous); storage.setStorePath(previous);
    fs.rmSync(directory, { recursive:true, force:true });
  }
});
