import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { syncBuiltinESMExports } from "node:module";

const modules = process.env.PKM_FRESH_NOTE_MODULE_ROOT
  ? pathToFileURL(`${resolve(process.env.PKM_FRESH_NOTE_MODULE_ROOT)}/`) : new URL("../dist/", import.meta.url);
const extension = process.env.PKM_FRESH_NOTE_MODULE_ROOT?.endsWith("/src") ? "ts" : "js";
const read = await import(new URL(`markdown-read.${extension}`, modules));
const old = await import(new URL(`markdown.${extension}`, modules));
const schemas = await import(new URL(`document-read-contracts.${extension}`, modules));
const contracts = await import(new URL(`contracts.${extension}`, modules));
const { CoreError } = await import(new URL(`host-composition-legacy-batch15-errors.${extension}`, modules));

function fixture(t) {
  const parent = join(process.env.PKM_FRESH_NOTE_FIXTURE_PARENT ?? dirname(fileURLToPath(import.meta.url)), `.markdown-read-${randomUUID()}`);
  const root = join(parent, "workspace");
  fs.mkdirSync(join(root, "notes"), { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const write = (path, raw) => {
    fs.mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(root, path), raw, { mode: 0o600 });
  };
  return { parent, root, write };
}
const raw = "---\ndocumentId: note-a\ntitle: Before\nrevision: 1\ndeleted: false\n---\nBefore\n";
const invalidDocument = error => error instanceof CoreError && error.code === "INVALID_DOCUMENT";
const conflict = error => error instanceof CoreError && error.code === "CONFLICT";

test("fresh read-leaf runtime closure excludes Core/contracts/file-write/Store and has five local modules", t => {
  const f = fixture(t);
  const probe = `
import {Session} from "node:inspector";
const session=new Session(),urls=new Set();session.connect();
session.on("Debugger.scriptParsed",({params})=>urls.add(params.url));
await new Promise((ok,bad)=>session.post("Debugger.enable",e=>e?bad(e):ok()));
await import(process.argv[1]);
session.disconnect();
console.log(JSON.stringify([...urls].filter(url=>url.startsWith(process.argv[2])).sort()));
`;
  const output = execFileSync(process.execPath, [
    ...process.execArgv.filter(argument => !argument.startsWith("--test")),
    "--input-type=module", "-e", probe, new URL(`markdown-read.${extension}`, modules).href, modules.href,
  ], { cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."), encoding: "utf8", env: process.env });
  const actual = JSON.parse(output).map(url => url.slice(modules.href.length));
  assert.deepEqual(actual, [
    `document-path.${extension}`, `document-read-contracts.${extension}`, `fresh-note-query-contracts.${extension}`,
    `host-composition-legacy-batch15-errors.${extension}`, `markdown-read.${extension}`,
  ]);
});

test("legacy exports and light readers use the same canonical functions, schema objects and error class", t => {
  const f = fixture(t);
  for (const name of ["decodeMarkdownPath", "readKnowledgePathSnapshot", "decodeMarkdown", "readMarkdown", "scanMarkdown", "createFreshRootScanner"])
    assert.equal(old[name], read[name], name);
  assert.equal(contracts.documentId, schemas.documentId);
  assert.equal(contracts.documentSchema, schemas.documentSchema);
  assert.equal(contracts.CoreError, CoreError);
  f.write("notes/Example.md", raw);
  assert.deepEqual(read.readMarkdown(f.root, "note-a", "Example.md"), old.readMarkdown(f.root, "note-a", "Example.md"));
  const nested = read.decodeMarkdownPath("Body", "Nested/研究.md");
  assert.equal(nested.record.id, `legacy_${old.sha256("Nested/研究.md").slice(0, 32)}`);
  assert.equal(read.decodeMarkdownPath("---\nschema: pkm.knowledge/v1\nrevision: 1\ndeleted: false\naliases: [note:prototype-id]\n---\nBody",
    "Nested/Prototype.md").record.id, "prototype-id");
});

test("canonical strict decoding retains YAML/identity/type errors and resource snapshots retain raw bytes", t => {
  const f = fixture(t);
  for (const text of [
    "---\ntitle: Broken\n",
    "---\ntitle: First\ntitle: Duplicate\n---\nBody",
    "---\ncustom: &custom [one, two]\ncopy: *custom\n---\nBody",
    "---\ndocumentId: invalid/identity\n---\nBody",
    "---\ntitle: 42\n---\nBody",
    "---\nrevision: 0\n---\nBody",
    "---\ndeleted: no\n---\nBody",
  ]) assert.throws(() => read.decodeMarkdownPath(text, "Example.md"), invalidDocument);
  f.write("notes/Example.md", Buffer.from([0xff, 0x61]));
  assert.throws(() => read.readMarkdown(f.root, "note-a", "Example.md"), invalidDocument);
  assert.throws(() => read.scanMarkdown(f.root, { metadata: false }), invalidDocument);
  f.write("notes/Example.md", raw);
  f.write("notes/Example.assets/pkm-todo-board.json", Buffer.from([0xff, 0x61]));
  const resource = read.readKnowledgePathSnapshot(f.root, "Example.assets/pkm-todo-board.json", "notes");
  assert.deepEqual(resource.file.bytes, Buffer.from([0xff, 0x61]));
});

test("descriptor path read scope ignores unrelated duplicate Notes but fences membership, symlinks and backing changes", t => {
  const f = fixture(t);
  f.write("notes/Nested/Example.md", raw);
  const before = read.readKnowledgePathSnapshot(f.root, "Nested/Example.md", "notes", true);
  assert.equal(before.file.bytes.toString(), raw);
  f.write("notes/Other.md", raw);
  assert.deepEqual(read.readKnowledgePathSnapshot(f.root, "Nested/Example.md", "notes", true), before);
  assert.throws(() => read.scanMarkdown(f.root), error => error.code === "CONFLICT");
  for (const path of ["../escape.md", "/absolute.md", ".hidden.md", "Nested//Example.md"])
    assert.throws(() => read.readKnowledgePathSnapshot(f.root, path, "notes", true), invalidDocument);
  const absent = read.readKnowledgePathSnapshot(f.root, "Missing/Example.md", "notes", true);
  assert.equal(absent.file, undefined);
  assert.match(absent.parents.at(-1), /missing$/);
  const missingBacking = read.readKnowledgePathSnapshot(f.root, "Nested/Example.assets/pkm-todo-board.json", "notes");
  assert.equal(missingBacking.file, undefined);
  f.write("notes/Nested/Example.assets/pkm-todo-board.json", "{}");
  assert.notDeepEqual(read.readKnowledgePathSnapshot(f.root, "Nested/Example.assets/pkm-todo-board.json", "notes"), missingBacking);
  fs.symlinkSync(join(f.root, "notes/Nested/Example.md"), join(f.root, "notes/Link.md"));
  assert.throws(() => read.readKnowledgePathSnapshot(f.root, "Link.md", "notes", true), invalidDocument);
  fs.symlinkSync(join(f.root, "notes/Nested"), join(f.root, "notes/Linked"));
  assert.throws(() => read.readKnowledgePathSnapshot(f.root, "Linked/Example.md", "notes", true), invalidDocument);
});

test("descriptor reads detect target replacement and parent rename while closing every owned descriptor", t => {
  const f = fixture(t);
  f.write("notes/Nested/Example.md", raw);
  const file = join(f.root, "notes/Nested/Example.md"), inode = fs.statSync(file, { bigint: true }).ino;
  const originalRead = fs.readFileSync, originalClose = fs.closeSync, originalOpen = fs.openSync;
  for (const mode of ["target", "parent"]) {
    let replaced = false;
    const descriptors = new Set();
    const open = t.mock.method(fs, "openSync", (...args) => { const fd = originalOpen(...args); descriptors.add(fd); return fd; });
    const close = t.mock.method(fs, "closeSync", fd => { descriptors.delete(fd); return originalClose(fd); });
    const sourceInode = mode === "target" ? inode : fs.statSync(file, { bigint: true }).ino;
    const hook = t.mock.method(fs, "readFileSync", (...args) => {
      const value = originalRead(...args);
      if (!replaced && typeof args[0] === "number" && fs.fstatSync(args[0], { bigint: true }).ino === sourceInode) {
        replaced = true;
        if (mode === "target") {
          fs.renameSync(file, `${file}.old`);
          fs.writeFileSync(file, raw);
        } else {
          fs.renameSync(join(f.root, "notes/Nested"), join(f.root, "notes/Moved"));
          f.write("notes/Nested/Example.md", raw);
        }
      }
      return value;
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => read.readKnowledgePathSnapshot(f.root, "Nested/Example.md", "notes", true), conflict);
      assert.equal(replaced, true);
      assert.equal(descriptors.size, 0);
    } finally { hook.mock.restore(); close.mock.restore(); open.mock.restore(); syncBuiltinESMExports(); }
  }
});

test("moved rich/snapshot caches retain cloning and fresh SHA checks with an identical stat fingerprint", t => {
  const f = fixture(t);
  f.write("notes/Example.md", raw);
  const first = old.scanMarkdown(f.root);
  first[0].metadata.set("title", "Local mutation");
  assert.equal(read.scanMarkdown(f.root)[0].record.title, "Before");
  const snapshot = read.scanMarkdown(f.root, { metadata: false });
  assert(Object.isFrozen(snapshot));
  assert(Object.isFrozen(snapshot[0].record));
  assert(!Object.hasOwn(snapshot[0], "metadata"));
  const path = join(f.root, "notes/Example.md"), original = fs.lstatSync;
  const pin = original(path, { bigint: true });
  const hook = t.mock.method(fs, "lstatSync", (named, options) => named === path && options?.bigint ? pin : original(named, options));
  syncBuiltinESMExports();
  try {
    fs.writeFileSync(path, raw.replaceAll("Before", "After!").replace("note-a", "note-b"));
    const changed = old.scanMarkdown(f.root, { metadata: false });
    assert.equal(changed[0].record.id, "note-b");
    assert.equal(changed[0].record.title, "After!");
    assert.notEqual(changed[0].record.sha256, snapshot[0].record.sha256);
    assert.deepEqual(changed, read.scanMarkdown(f.root).map(({ record, raw: source }) => ({ record, raw: source })));
  } finally { hook.mock.restore(); syncBuiltinESMExports(); }
});

function withScannerIo(t, f, hooks, action) {
  const scanner = read.createFreshRootScanner(f.root), descriptors = new Set();
  const original = Object.fromEntries(["openSync", "closeSync", "readSync", "fstatSync"].map(name => [name, fs[name]]));
  const mocks = [
    t.mock.method(fs, "openSync", (...args) => { const fd = original.openSync(...args); descriptors.add(fd); return fd; }),
    t.mock.method(fs, "closeSync", fd => { const value = original.closeSync(fd); descriptors.delete(fd); return value; }),
    t.mock.method(fs, "readSync", (...args) => hooks.read ? hooks.read(original.readSync, ...args) : original.readSync(...args)),
    t.mock.method(fs, "fstatSync", (...args) => {
      const value = original.fstatSync(...args);
      return hooks.stat ? hooks.stat(value, ...args) : value;
    }),
  ];
  syncBuiltinESMExports();
  try { return action(scanner); }
  finally {
    const leaked = [...descriptors];
    for (const mock of mocks.reverse()) mock.mock.restore();
    syncBuiltinESMExports();
    for (const fd of leaked) original.closeSync(fd);
    assert.deepEqual(leaked, [], "scanner must close source, area and root descriptors");
  }
}

test("scanner treats a listed entry disappearing before metadata read as a conflict without leaking descriptors", t => {
  const f = fixture(t);
  f.write("notes/Example.md", raw);
  const original = fs.readdirSync;
  let removed = false;
  const hook = t.mock.method(fs, "readdirSync", (...args) => {
    const names = original(...args);
    if (!removed && names.some(name => name.toString() === "Example.md")) {
      fs.unlinkSync(join(f.root, "notes/Example.md"));
      removed = true;
    }
    return names;
  });
  syncBuiltinESMExports();
  try {
    withScannerIo(t, f, {}, scanner => {
      assert.throws(() => scanner.scan(), conflict);
      assert.equal(removed, true);
      assert.equal(scanner.scan().sources.size, 0);
    });
  } finally { hook.mock.restore(); syncBuiltinESMExports(); }
});

test("scanner exact reads preserve short-chunk UTF8, real empty files and incomplete UTF8 rejection", t => {
  const f = fixture(t), content = `${raw}中文 🧪`;
  f.write("notes/Example.md", content);
  withScannerIo(t, f, { read: (original, fd, buffer, offset, length, position) =>
    original(fd, buffer, offset, Math.min(length, 3), position) }, scanner => {
    const source = scanner.scan().sources.get("notes/Example.md");
    assert.equal(source.raw, content);
    assert.equal(source.sha256, old.sha256(Buffer.from(content)));
  });
  f.write("notes/Example.md", "");
  withScannerIo(t, f, {}, scanner => assert.equal(scanner.scan().sources.get("notes/Example.md").raw, ""));
  f.write("notes/Example.md", Buffer.concat([Buffer.from(raw), Buffer.from([0xf0, 0x9f])]));
  withScannerIo(t, f, { read: (original, fd, buffer, offset, length, position) =>
    original(fd, buffer, offset, Math.min(length, 1), position) }, scanner => {
    assert.throws(() => scanner.scan(), invalidDocument);
  });
});

test("scanner rejects early EOF, grow/shrink races and preserves IO errors with no descriptor leaks", t => {
  for (const mode of ["early-eof", "grow", "shrink", "empty-grow", "EIO", "EINTR"]) {
    const f = fixture(t), path = join(f.root, "notes/Example.md");
    f.write("notes/Example.md", mode === "empty-grow" ? "" : raw);
    const failure = Object.assign(new Error(mode), { code: mode });
    let first = true;
    withScannerIo(t, f, { read: (original, ...args) => {
      if (first) {
        first = false;
        if (mode === "early-eof") return 0;
        if (mode === "EIO" || mode === "EINTR") throw failure;
        if (mode === "grow" || mode === "empty-grow") fs.appendFileSync(path, "X");
        if (mode === "shrink") fs.truncateSync(path, 0);
      }
      return original(...args);
    } }, scanner => assert.throws(() => scanner.scan(),
      mode === "EIO" || mode === "EINTR" ? error => error === failure : conflict, mode));
  }
});

test("scanner retains full named-file replacement, permission and hardlink pins after descriptor observations", t => {
  for (const mode of ["replace", "permissions", "hardlink"]) {
    const f = fixture(t), path = join(f.root, "notes/Example.md");
    f.write("notes/Example.md", raw);
    const inode = fs.statSync(path, { bigint: true }).ino;
    let observations = 0;
    withScannerIo(t, f, { stat: value => {
      if (value.ino === inode && ++observations === 2) {
        if (mode === "replace") { fs.renameSync(path, `${path}.old`); fs.writeFileSync(path, raw); }
        if (mode === "permissions") fs.chmodSync(path, 0o400);
        if (mode === "hardlink") fs.linkSync(path, join(f.parent, "Outside.md"));
      }
      return value;
    } }, scanner => assert.throws(() => scanner.scan(), conflict, mode));
    assert.equal(observations, 2);
  }
});

test("scanner bounds large-file allocation and rejects nonregular descriptors before reading bytes", t => {
  const f = fixture(t), path = join(f.root, "notes/Example.md");
  f.write("notes/Example.md", raw);
  let bytesRead = false;
  const inode = fs.statSync(path, { bigint: true }).ino;
  withScannerIo(t, f, {
    read: (original, ...args) => { bytesRead = true; return original(...args); },
    stat: value => value.ino === inode ? Object.assign(Object.create(value), { isFile: () => false }) : value,
  }, scanner => assert.throws(() => scanner.scan(), invalidDocument));
  assert.equal(bytesRead, false);
  fs.truncateSync(path, 0x80000000);
  withScannerIo(t, f, {}, scanner => assert.throws(() => scanner.scan(), error => error.code === "ERR_FS_FILE_TOO_LARGE"));
});
