const assert = require("node:assert/strict");
const { execFileSync, execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const execute = require("node:util").promisify(execFile);
const store = require("../dist/knowledge/filestore");
const { bindOriginalBrowserNotes } = require("../dist/runtime/pkm-browser-original-notes");

function fixture(t, changes = {}) {
  const root = path.resolve(`.browser-original-notes-${randomUUID()}`);
  fs.mkdirSync(path.join(root, "notes"), { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  store.setStorePath(root);
  let allowed = true, writerCalls = 0;
  const read = bindOriginalBrowserNotes({
    root, expiresAt: Date.now() + 60_000, allowWrite: true,
    assertCurrent() { if (!allowed) throw Error(`private diagnostic: ${root}`); },
    withWriter(work) { writerCalls++; return work(); },
    ...changes,
  });
  return { root, read: input => read(input, () => allowed), revoke() { allowed = false; },
    writerCalls: () => writerCalls };
}
const create = (overrides = {}) => ({ command: "saveNote", operationId: randomUUID(), title: "Entry",
  content: "Visible original body", type: "general", category: "", tags: ["browser"], ...overrides });
const detail = { command: "detail", path: "Entry.md" };
const update = (item, overrides = {}) => ({ command: "updateNote", operationId: randomUUID(),
  ...item.editPin, content: "Edited browser body", ...overrides });
const code = value => error => {
  assert.equal(error.code, value);
  assert.equal(error.message, "Original Notes request refused.");
  return true;
};

test("the private bridge reads/searches/creates/edits the exact Original filestore and preserves metadata", async t => {
  const f = fixture(t);
  const request = create({ category: "Research" });
  const result = await f.read(request);
  assert.deepEqual(result, { path: "Research/Entry.md", slug: "Research/Entry" });
  assert.equal(store.noteGet("Research/Entry").content, request.content);
  const file = path.join(f.root, "notes", result.path);
  const raw = fs.readFileSync(file, "utf8");
  const prefix = raw.slice(0, raw.indexOf(request.content));
  assert.deepEqual(await f.read({ command: "list", q: "visible ORIGINAL", caseSensitive: false }),
    { items: [(await f.read({ command: "list", q: "", caseSensitive: false })).items[0]], total: 1 });
  assert.equal((await f.read({ command: "list", q: "visible ORIGINAL", caseSensitive: true })).total, 0);
  const item = await f.read({ command: "detail", path: result.path });
  assert.match(item.editPin.id, /^[a-f0-9]{48}$/);
  assert.equal(typeof item.editPin.expectedRevision, "number");
  assert.equal(item.content, request.content);
  await f.read(update(item));
  assert.equal(fs.readFileSync(file, "utf8"), prefix + "Edited browser body");
  assert.equal(store.noteGet("Research/Entry").content, "Edited browser body");
  assert.equal(f.writerCalls(), 2);
});

test("request IDs replay exactly once, reject mismatched payloads, and never retry failed writes", async t => {
  const f = fixture(t);
  const request = create();
  const [a, b] = await Promise.all([f.read(request), f.read({ ...request })]);
  assert.deepEqual(a, b);
  assert.equal(f.writerCalls(), 1);
  await assert.rejects(f.read({ ...request, content: "Different" }), code("ORIGINAL_NOTES_OPERATION"));
  const collision = create({ content: "Do not replace" });
  await assert.rejects(f.read(collision), code("ORIGINAL_NOTE_EXISTS"));
  await assert.rejects(f.read(collision), code("ORIGINAL_NOTE_EXISTS"));
  assert.equal(f.writerCalls(), 2);
  assert.equal(store.noteGet("Entry").content, request.content);
  const item = await f.read(detail), edit = update(item);
  assert.deepEqual(await f.read(edit), await f.read({ ...edit }));
  await assert.rejects(f.read(update(item)), code("ORIGINAL_NOTE_EDIT_CONFLICT"));
});

test("ordinary desktop and actual MCP writes invalidate browser drafts rather than overwriting them", async t => {
  const f = fixture(t);
  await f.read(create());
  const old = await f.read(detail);
  store.noteUpsert({ slug: "Entry", title: "Entry", type: "general", tags: [], content: "Desktop update" });
  await assert.rejects(f.read(update(old)), code("ORIGINAL_NOTE_EDIT_CONFLICT"));
  const draft = await f.read(detail);
  const raw = fs.readFileSync(path.join(f.root, "notes/Entry.md"), "utf8").replace("Desktop update", "MCP update");
  execFileSync(process.execPath, [path.resolve(__dirname, "../resources/knowledge_mutations.js"), path.resolve(__dirname, ".."), f.root], {
    input: JSON.stringify({ operation: "write-markdown", area: "notes", path: "Entry.md", previous: "Entry.md", content: raw }),
    timeout: 5000,
  });
  await assert.rejects(f.read(update(draft)), code("ORIGINAL_NOTE_EDIT_CONFLICT"));
  assert.equal(store.noteGet("Entry").content, "MCP update");
});

test("revocation, expiry, root reselection and read-only consent deny mutations and replays", async t => {
  const f = fixture(t);
  const request = create();
  await f.read(request);
  f.revoke();
  await assert.rejects(f.read(request), code("ORIGINAL_NOTES_DENIED"));
  await assert.rejects(f.read(detail), code("ORIGINAL_NOTES_DENIED"));
  const readonly = fixture(t, { allowWrite: false });
  store.noteUpsert({ slug: "Entry", title: "Entry", type: "general", tags: [], content: "Read only" });
  assert.equal((await readonly.read(detail)).editPin, null);
  await assert.rejects(readonly.read(create()), code("ORIGINAL_NOTES_DENIED"));
  const expiring = fixture(t, { expiresAt: Date.now() + 150 });
  await new Promise(resolve => setTimeout(resolve, 175));
  await assert.rejects(expiring.read(detail), code("ORIGINAL_NOTES_DENIED"));
  const selected = fixture(t);
  store.setStorePath(f.root);
  await assert.rejects(selected.read(create()), code("ORIGINAL_NOTES_DENIED"));
});

test("authorization is rechecked inside the writer and immediately before the filestore commit", async t => {
  let current = true;
  const f = fixture(t, {
    assertCurrent() { if (!current) throw Error("revoked"); },
    withWriter(work) { current = false; return work(); },
  });
  await assert.rejects(f.read(create()), code("ORIGINAL_NOTES_DENIED"));
  assert.equal(fs.existsSync(path.join(f.root, "notes/Entry.md")), false);
  current = true;
  let checks = 0;
  const second = fixture(t, { assertCurrent() { if (++checks >= 4) throw Error("revoked under asset lock"); } });
  await assert.rejects(second.read(create()), code("ORIGINAL_NOTES_DENIED"));
  assert.equal(fs.existsSync(path.join(second.root, "notes/Entry.md")), false);
});

test("root fences refuse outside paths, symlink reads, hardlinks, renamed roots and surprising filenames", async t => {
  const f = fixture(t);
  await f.read(create());
  await assert.rejects(f.read({ command: "detail", path: "../outside.md" }), code("ORIGINAL_NOTES_INVALID"));
  await assert.rejects(f.read(create({ title: "Not/a filename" })), code("ORIGINAL_NOTES_INVALID"));
  const file = path.join(f.root, "notes/Entry.md"), linked = path.join(f.root, "notes/Linked.md");
  fs.symlinkSync(file, linked);
  await assert.rejects(f.read({ command: "list", q: "", caseSensitive: false }), code("ORIGINAL_NOTES_INVALID"));
  fs.unlinkSync(linked);
  fs.linkSync(file, linked);
  await assert.rejects(f.read(detail), code("ORIGINAL_NOTES_INVALID"));
  fs.unlinkSync(linked);
  const previous = f.root + "-previous";
  fs.renameSync(f.root, previous);
  t.after(() => fs.rmSync(previous, { force: true, recursive: true }));
  fs.mkdirSync(f.root);
  await assert.rejects(f.read(detail), code("ORIGINAL_NOTES_DENIED"));
});

test("edit preconditions are opaque, bounded, and do not authorize a different Note", async t => {
  const f = fixture(t);
  await f.read(create());
  await f.read(create({ title: "Other", content: "Other body" }));
  const item = await f.read(detail);
  await assert.rejects(f.read(update(item, { expectedRevision: item.editPin.expectedRevision + 1 })),
    code("ORIGINAL_NOTE_EDIT_CONFLICT"));
  await assert.rejects(f.read(update(item, { expectedSha256: "0".repeat(64) })), code("ORIGINAL_NOTE_EDIT_CONFLICT"));
  for (let index = 0; index < 512; index++) await f.read(detail);
  await assert.rejects(f.read(update(item)), code("ORIGINAL_NOTE_EDIT_CONFLICT"));
  assert.equal(store.noteGet("Other").content, "Other body");
});

test("two actual filestore creators serialize without replacing the winning title-derived filename", async t => {
  const f = fixture(t);
  const source = `
    const store = require(process.argv[1]);
    store.setStorePath(process.argv[2]);
    try {
      store.createOriginalNoteNoOverwrite({ title: "Entry", category: "", type: "general", tags: [], content: process.argv[3] });
      process.stdout.write("created");
    } catch (error) {
      if (error.code !== "ORIGINAL_NOTE_EXISTS") throw error;
      process.stdout.write("exists");
    }
  `;
  const results = await Promise.all(["First writer", "Second writer"].map(content =>
    execute(process.execPath, ["-e", source, require.resolve("../dist/knowledge/filestore"), f.root, content], { timeout: 5000 })));
  assert.deepEqual(results.map(result => result.stdout).sort(), ["created", "exists"]);
  const winner = results[0].stdout === "created" ? "First writer" : "Second writer";
  assert.equal(store.noteGet("Entry").content, winner);
  assert.deepEqual(fs.readdirSync(path.join(f.root, "notes")), ["Entry.md"]);
});
