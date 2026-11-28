const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const storePath = require.resolve("../dist/knowledge/filestore");
const store = require(storePath);
const extension = path.resolve(__dirname, "..");

function fixture(t) {
  const root = path.resolve(`.pkm-note-body-cas-${randomUUID()}`);
  const file = path.join(root, "notes", "Entry.md");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  store.setStorePath(root);
  return { root, file };
}

test("Original body CAS preserves raw metadata, rejects old drafts after an MCP update and refuses identity changes", t => {
  const { root, file } = fixture(t);
  const prefix = '---\r\ntitle: "Entry"\r\n# retain unknown metadata and exact line endings\r\n---\r\n';
  fs.writeFileSync(file, prefix + "Old body\r\n", { mode: 0o640 });
  const first = store.readOriginalNoteBodyForEdit("Entry.md");
  assert.equal(first.body, "Old body\r\n");
  store.compareAndSwapOriginalNoteBody("Entry.md", first, "Revised body\n");
  assert.equal(fs.readFileSync(file, "utf8"), prefix + "Revised body\n");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o640);

  const draft = store.readOriginalNoteBodyForEdit("Entry.md");
  const written = prefix + "Ordinary MCP write\n";
  execFileSync(process.execPath, [path.join(extension, "resources/knowledge_mutations.js"), extension, root], {
    input: JSON.stringify({ operation: "write-markdown", area: "notes", path: "Entry.md", previous: "Entry.md", content: written }),
    timeout: 5000,
  });
  assert.throws(() => store.compareAndSwapOriginalNoteBody("Entry.md", draft, "Stale edit"), { code: "ORIGINAL_NOTE_EDIT_CONFLICT" });
  assert.equal(fs.readFileSync(file, "utf8"), written);
  fs.unlinkSync(file);
  fs.writeFileSync(file, prefix + "Revised body\n");
  assert.throws(() => store.compareAndSwapOriginalNoteBody("Entry.md", draft, "Replaced file"), { code: "ORIGINAL_NOTE_EDIT_CONFLICT" });
  fs.unlinkSync(file);
  assert.throws(() => store.compareAndSwapOriginalNoteBody("Entry.md", draft, "Do not recreate"), { code: "ORIGINAL_NOTE_EDIT_CONFLICT" });
  assert.equal(fs.existsSync(file), false);
});

test("a known stale draft does not leave a pending migration write", { skip: process.platform !== "linux" }, t => {
  const { root, file } = fixture(t);
  const tracking = require("../dist/knowledge/markdown-migration-fence");
  fs.writeFileSync(file, "Initial");
  const draft = store.readOriginalNoteBodyForEdit("Entry.md");
  const operation = randomUUID();
  tracking.beginMarkdownMigrationTracking(root, operation);
  store.noteUpsert({ slug: "Entry", title: "Entry", type: "general", tags: [], content: "Ordinary update" });
  assert.throws(() => store.compareAndSwapOriginalNoteBody("Entry.md", draft, "Stale edit"), { code: "ORIGINAL_NOTE_EDIT_CONFLICT" });
  tracking.fenceTrackedMarkdownWrites(root, operation);
});

test("the CAS cannot compare early while an ordinary desktop writer holds the same lock", { skip: process.platform !== "linux", timeout: 10_000 }, async t => {
  const { root, file } = fixture(t);
  store.noteUpsert({ slug: "Entry", title: "Entry", type: "general", tags: [], content: "Visible original body" });
  const draft = store.readOriginalNoteBodyForEdit("Entry.md");
  const release = path.join(root, "release");
  const launch = (source, ...args) => {
    const child = spawn(process.execPath, ["-e", source, storePath, root, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    let output = "", stderr = "";
    child.stdout.on("data", bytes => { output += bytes; });
    child.stderr.on("data", bytes => { stderr += bytes; });
    const done = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => {
        if (code !== 0) reject(new Error(stderr || `Process exited with ${code}`));
        else resolve(output);
      });
    });
    // Let fixture assertions report an early exit without an unhandled rejection.
    void done.catch(() => {});
    return { child, done, output: () => output };
  };
  const desktop = launch(`
    const fs = require("node:fs");
    const [modulePath, root, destination, release] = process.argv.slice(1);
    const write = fs.writeFileSync;
    fs.writeFileSync = (filename, ...args) => {
      if (filename === destination) {
        process.stdout.write("at-write\\n");
        const deadline = Date.now() + 3000;
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 10);
        if (!fs.existsSync(release)) throw Error("Competing writer did not reach the lock");
      }
      return write(filename, ...args);
    };
    const store = require(modulePath);
    store.setStorePath(root);
    store.noteUpsert({ slug: "Entry", title: "Entry", type: "general", tags: [], content: "Desktop update" });
  `, file, release);
  const waitFor = async (condition, label) => {
    for (let count = 0; count < 150; count++) {
      if (condition()) return;
      await delay(10);
    }
    assert.fail(label);
  };
  await waitFor(() => desktop.output().includes("at-write"), "ordinary desktop save did not reach its write");
  const attempt = launch(`
    const [modulePath, root, captured] = process.argv.slice(1);
    const store = require(modulePath);
    store.setStorePath(root);
    try { store.compareAndSwapOriginalNoteBody("Entry.md", JSON.parse(captured), "Browser stale draft"); }
    catch (error) {
      if (!(error instanceof store.NoteBodyEditConflict)) throw error;
      process.stdout.write(error.code);
    }
  `, JSON.stringify(draft));
  const state = path.join(root, ".pkm/state");
  await waitFor(() => fs.readdirSync(state).some(name => /^markdown-assets\.lock\..+\.pending$/.test(name)),
    "CAS did not contend on the ordinary writer's lock");
  fs.writeFileSync(release, "");
  await desktop.done;
  assert.equal(await attempt.done, "ORIGINAL_NOTE_EDIT_CONFLICT");
  assert.match(fs.readFileSync(file, "utf8"), /Desktop update/);
});
