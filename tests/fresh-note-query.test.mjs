import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join, dirname, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modules = process.env.PKM_FRESH_NOTE_MODULE_ROOT
  ? pathToFileURL(`${resolve(process.env.PKM_FRESH_NOTE_MODULE_ROOT)}/`) : new URL("../dist/", import.meta.url);
const extension = process.env.PKM_FRESH_NOTE_MODULE_ROOT?.endsWith("/src") ? "ts" : "js";
const { createFreshRootScanner, scanMarkdown } = await import(new URL(`markdown.${extension}`, modules));
const { createFreshNoteQueryModel, initializeFreshNoteQuerySchema, FRESH_NOTE_QUERY_DERIVED_TABLES } =
  await import(new URL(`fresh-note-query-model.${extension}`, modules));
const { pythonLower, pythonStrip } = await import(new URL(`domain/legacy-note-query-unicode.${extension}`, modules));
const { pythonJson, parseLegacyNote, pythonTimestamp, formatLegacyPathNoteGet } = await import(new URL(`domain/legacy-note-query-original.${extension}`, modules));
const { CoreError } = await import(new URL(`host-composition-legacy-batch15-errors.${extension}`, modules));
const python = process.env.PKM_FRESH_NOTE_PYTHON ?? "python3";
const pythonOptions = root => ({ cwd: root, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });

function fixture(t) {
  const parent = join(process.env.PKM_FRESH_NOTE_FIXTURE_PARENT ?? dirname(fileURLToPath(import.meta.url)), `.fresh-note-${randomUUID()}`);
  fs.mkdirSync(parent, { mode: 0o700 });
  const root = join(parent, "workspace");
  fs.mkdirSync(root, { mode: 0o700 });
  fs.mkdirSync(join(root, "notes"), { mode: 0o700 });
  const database = new DatabaseSync(join(root, "core.sqlite"));
  fs.chmodSync(join(root, "core.sqlite"), 0o600);
  const scanner = createFreshRootScanner(root), binding = { workspaceId: randomUUID(), rootPin: scanner.rootPin };
  let hook = () => {};
  const guard = { assert(phase) { hook(phase); return { ...binding }; } };
  initializeFreshNoteQuerySchema(database, guard);
  const model = createFreshNoteQueryModel({ database, scanner, guard });
  t.after(() => { model.close(); database.close(); fs.rmSync(parent, { recursive: true, force: true }); });
  const write = (path, raw) => {
    fs.mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(root, path), raw, { mode: 0o600 });
  };
  return { parent, root, database, scanner, binding, guard, model, write,
    hook(value) { hook = value; },
    list(args = {}) { return model.executeFresh({ kind: "list", arguments: args }); },
    search(query, limit = 20) { return model.executeFresh({ kind: "legacy-lexical", arguments: { query, limit } }); } };
}
const note = (id, title, body, extra = "") => `---\ndocumentId: ${id}\ntitle: ${title}\n${extra}---\n${body}`;
function oracle(root, tool, args) {
  if (tool === "list") return execFileSync(python, ["-I", "-B", join(repository, "compat/legacy-note-inventory.py"), root],
    { ...pythonOptions(root), input: JSON.stringify(args) });
  return execFileSync(python, ["-I", "-B", "-c", `
import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location("oracle",Path(sys.argv[1])/"compat/legacy-knowledge-mcp.py")
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(sys.argv[2]);files=[]
for area in ("notes","skills","papers"):
 for p in sorted((root/area).rglob("*.md"),key=lambda p:tuple(x.encode() for x in p.parts)):
  if any(x.startswith(".") or x=="_assets" or x.lower().endswith(".assets") for x in p.relative_to(root/area).parts):continue
  files.append({"area":area,"path":p.relative_to(root/area).as_posix(),"raw":p.read_bytes().decode("utf-8"),"mtimeNs":str(p.stat().st_mtime_ns),"size":p.stat().st_size})
for p in (root/"notes").rglob("pkm-todo-board.json"):
 files.append({"area":"notes","path":p.relative_to(root/"notes").as_posix(),"raw":p.read_text(),"mtimeNs":str(p.stat().st_mtime_ns),"size":p.stat().st_size})
result=m.execute({"tool":sys.argv[3],"arguments":json.load(sys.stdin),"files":files,"recipes":[]})
sys.stdout.write(result["text"])
`, repository, root, tool === "get" ? "get_note" : "search_notes"], { ...pythonOptions(root), input: JSON.stringify(args), maxBuffer: 8 * 1024 * 1024 });
}
function populate(f) {
  f.write("notes/Zed.md", note("zed", "Zed", "needle alpha alpha 中文"));
  f.write("notes/A.md", note("a", "Alpha", "needle bravo ΟΣ ΟΣΑ İ 𐵐", "knowledgeId: knowledge_000000000000000000000001\ntype: todo\n"));
  f.write("notes/Nested/复杂.md", note("unicode", "复杂 🧪", "needle 中文", "type: 1.0\n"));
  f.write("notes/System/Upper.MD", note("upper", "Upper", "needle hidden from lexical"));
  f.write("notes/B.md", note("b", "Beta", "needle alpha", "type: [\"general\", \"todo\"]\n"));
}

test("fresh inventory exactly matches immutable Python inventory JSON and pagination revisions", t => {
  const f = fixture(t); populate(f);
  for (const args of [{ limit: 0 }, {}, { directory: "notes/Nested/" }, { recursive: false }, { type: "all" }, { type: "todo" },
    { directory: "pkm://notes/Nested/", limit: 1 }, { directory: "\u0085Nested\u001c" }]) {
    assert.equal(f.list(args).text, oracle(f.root, "list", args), JSON.stringify(args));
  }
  const first = JSON.parse(f.list({ limit: 2 }).text);
  const args = { limit: 2, offset: 2, inventory_revision: first.inventory_revision };
  assert.equal(f.list(args).text, oracle(f.root, "list", args));
  f.write("notes/Added.md", note("added", "Added", "body"));
  assert.throws(() => f.list(args), error => error.code === "CONFLICT");
  for (const bad of [{ offset: 1 }, { offset: -1 }, { limit: -1 }, { recursive: "true" }, { directory: "../escape" }, { inventory_revision: "bad" }])
    assert.throws(() => f.list(bad), error => error.code === "INVALID_ARGUMENT");
});

test("persistent native trigram ranking/ties/fallback match actual captured Python before and after deltas", t => {
  const f = fixture(t); populate(f);
  const queries = ["needle", "alpha", "中文", "ΟΣ", "İ", "𐵐", "q", "", '"', "OR", "*", "-", "NEAR(", "unknown:needle", '"needle alpha"', "needle OR bravo", "absent"];
  const compare = () => { for (const query of queries) for (const limit of [1, 3, 20]) {
    assert.equal(f.search(query, limit).text, oracle(f.root, "search", { query, limit }), `${query}/${limit}`);
  } };
  compare();
  f.write("notes/0-New.md", note("new", "New", "needle alpha"));
  fs.renameSync(join(f.root, "notes/Zed.md"), join(f.root, "notes/0-Zed.md"));
  fs.rmSync(join(f.root, "notes/B.md"));
  compare();
});

test("pure path-local get formatter exactly matches captured Python defaults, body, hash, board and not-found output", t => {
  const f = fixture(t);
  const get = path => {
    const file = join(f.root, "notes", path);
    return formatLegacyPathNoteGet(fs.existsSync(file) ? {
      path, raw: fs.readFileSync(file, "utf8"), mtimeNs: String(fs.statSync(file, { bigint: true }).mtimeNs),
      boardPresent: fs.existsSync(file.replace(/\.md$/, ".assets/pkm-todo-board.json")),
    } : undefined, path.slice(0, -3), []);
  };
  for (const [path, raw] of [
    ["Unicode.md", note("unicode", "复杂 🧪", "Body\r\n中文", "tags: [\"中文\", 1.0]\ntype: todo\n")],
    ["Defaults.md", "Plain content"],
    ["System/Test.md", "---\ntitle: false\ntype: 1.0\ntags: \"one\"\n---\nBody"],
    ["Board.md", "---\ndocumentKind: todo-board\n---\nIgnored board Markdown"],
    ["Backing.md", "Backing board"],
  ]) {
    f.write(`notes/${path}`, raw);
    if (path === "Backing.md") f.write("notes/Backing.assets/pkm-todo-board.json", "{}");
    assert.equal(get(path), oracle(f.root, "get", { slug: path.slice(0, -3) }), path);
  }
  assert.equal(get("Missing.md"), oracle(f.root, "get", { slug: "Missing" }));
});

test("equal-rank FTS ties retain original path order after insertion, rename and deletion", t => {
  const f = fixture(t);
  for (const name of ["CC", "BB", "AA"]) f.write(`notes/${name}.md`, note(name, "Same", "tieword"));
  const compare = () => {
    for (const limit of [1, 2, 20]) assert.equal(f.search("tieword", limit).text,
      oracle(f.root, "search", { query: "tieword", limit }));
  };
  compare();
  f.write("notes/AB.md", note("ab", "Same", "tieword"));
  fs.renameSync(join(f.root, "notes/CC.md"), join(f.root, "notes/AC.md"));
  fs.rmSync(join(f.root, "notes/BB.md"));
  compare();
});

test("zero delta still reads both full roots but never parses, writes, regenerates or rebuilds FTS", t => {
  const f = fixture(t); populate(f);
  const first = f.search("needle");
  const stats = f.model.statistics(), scans = f.scanner.statistics();
  const changes = f.database.prepare("SELECT total_changes() n").get().n;
  assert.equal(f.search("needle").text, first.text);
  assert.equal(f.list({ limit: 0 }).generation, first.generation);
  assert.deepEqual(f.model.statistics(), stats);
  assert.equal(f.database.prepare("SELECT total_changes() n").get().n, changes);
  assert.equal(f.scanner.statistics().parses, scans.parses);
  assert.equal(f.scanner.statistics().identityUpdates, scans.identityUpdates);
  assert.equal(f.scanner.statistics().reads - scans.reads, 4 * 5);
  f.write("notes/A.md", note("a", "Alpha", "needle bravo ΟΣ ΟΣΑ İ 𐵐", "knowledgeId: knowledge_000000000000000000000001\ntype: done\n"));
  f.search("needle");
  assert.equal(f.model.statistics().ftsUpdates, stats.ftsUpdates);
  assert.equal(f.scanner.statistics().parses, scans.parses + 1);
  f.write("notes/A.md", note("a", "Alpha", "changed body needle"));
  f.search("needle");
  assert.equal(f.model.statistics().ftsUpdates, stats.ftsUpdates + 1);
});

test("target and unrelated global races reject and roll back the entire staged FTS generation", t => {
  const f = fixture(t);
  f.write("notes/A.md", note("a", "A", "before"));
  f.write("skills/Other.md", note("other", "Other", "first"));
  f.search("before");
  const generation = f.model.statistics().generations;
  f.write("notes/A.md", note("a", "A", "after!"));
  let mutate = true;
  f.hook(phase => { if (phase === "after-query" && mutate) { mutate = false; f.write("skills/Other.md", note("other", "Other", "second")); } });
  assert.throws(() => f.search("after"), error => error.code === "CONFLICT");
  assert.equal(f.model.statistics().generations, generation);
  assert.equal(f.database.prepare("SELECT content FROM fresh_note_query_fts").get().content, "before");
  assert.equal(f.search("after").text, oracle(f.root, "search", { query: "after", limit: 20 }));
  f.hook(phase => { if (phase === "after-query") f.write("notes/A.md", note("a", "A", randomUUID())); });
  assert.throws(() => f.list(), error => error.code === "CONFLICT");
});

test("global duplicate identities, bad metadata, membership and dependency edits never serve the old cache", t => {
  const f = fixture(t);
  f.write("notes/A.md", note("a", "A", "alpha"));
  f.list();
  f.write("skills/Duplicate.md", note("a", "Dup", "dup"));
  assert.throws(() => f.list(), error => error.code === "CONFLICT");
  fs.rmSync(join(f.root, "skills/Duplicate.md"));
  const identity = "knowledge_000000000000000000000001";
  f.write("notes/A.md", note(identity, "A", "alpha"));
  f.write("skills/Cross.md", note("other", "Other", "other", `knowledgeId: ${identity}\n`));
  assert.throws(() => f.list(), error => error.code === "CONFLICT");
  fs.rmSync(join(f.root, "skills/Cross.md"));
  f.write("notes/A.md", note("a", "A", "alpha"));
  f.write("papers/Bad.md", Buffer.from([0xff, 0x61]));
  assert.throws(() => f.search("alpha"), error => error.code === "INVALID_DOCUMENT");
  f.write("papers/Bad.md", "---\ntitle: Broken\n");
  assert.throws(() => f.search("alpha"), error => error.code === "INVALID_DOCUMENT");
  fs.rmSync(join(f.root, "papers/Bad.md"));
  f.write("notes/A.assets/pkm-todo-board.json", "{}");
  assert.equal(JSON.parse(f.list().text).notes[0].documentKind, "todo-board");
  fs.rmSync(join(f.root, "notes/A.assets/pkm-todo-board.json"));
  assert.equal(JSON.parse(f.list().text).notes[0].documentKind, "markdown");
  fs.symlinkSync(join(f.root, "notes/A.md"), join(f.root, "notes/Link.md"));
  assert.throws(() => f.list(), error => error.code === "INVALID_DOCUMENT");
});

test("trusted private guards fence pending journals, ownership changes and empty bootstrap scope", t => {
  const f = fixture(t); f.write("notes/A.md", note("a", "A", "alpha"));
  f.list();
  f.hook(phase => { if (phase === "after-query") throw new CoreError("RECOVERY_REQUIRED", "pending journal"); });
  assert.throws(() => f.list(), error => error instanceof CoreError && error.code === "RECOVERY_REQUIRED");
  f.hook(phase => { if (phase === "after-query") f.binding.workspaceId = randomUUID(); });
  assert.throws(() => f.search("alpha"), error => error.code === "ACCESS_DENIED");
  assert.throws(() => initializeFreshNoteQuerySchema(f.database, { assert: () => ({ workspaceId: "", rootPin: "" }) }),
    error => error.code === "ACCESS_DENIED");
  assert.throws(() => createFreshNoteQueryModel({ database: f.database, scanner: f.scanner,
    guard: { assert: () => ({ workspaceId: "wrong", rootPin: "wrong" }) } }), error => error.code === "ACCESS_DENIED");
});

test("foreign and same-connection index mutations repair missing/incorrect FTS without trusting persisted rows", t => {
  const f = fixture(t); populate(f);
  const expected = f.search("needle").text;
  f.database.exec("DELETE FROM fresh_note_query_fts");
  assert.equal(f.search("needle").text, expected);
  const other = new DatabaseSync(join(f.root, "core.sqlite"));
  try { other.exec(`UPDATE fresh_note_query_fts SET content='poison'; UPDATE fresh_note_query_notes SET title='forged';
    INSERT INTO fresh_note_query_fts(fresh_note_query_fts,rank) VALUES('rank','bm25(20.0,1.0,0.1)')`); }
  finally { other.close(); }
  assert.equal(f.search("needle").text, expected);
  assert.equal(f.search("poison").text, "[]");
  const scanner = createFreshRootScanner(f.root);
  const guard = { assert: () => ({ workspaceId: f.binding.workspaceId, rootPin: scanner.rootPin }) };
  const cold = createFreshNoteQueryModel({ database: f.database, scanner, guard });
  try {
    assert.equal(cold.executeFresh({ kind: "legacy-lexical", arguments: { query: "needle" } }).text, expected);
    assert.equal(scanner.statistics().parses, 5);
  } finally { cold.close(); }
  f.database.exec("DROP TABLE fresh_note_query_notes");
  assert.throws(() => f.search("needle"), error => error.code === "STORAGE_ERROR");
});

test("full rebuilds avoid per-source identity scans while incremental replacements and removals remain exact", t => {
  const f = fixture(t);
  f.write("notes/A.md", note("a", "Alpha", "needle alpha", "knowledgeId: knowledge_000000000000000000000001\n"));
  f.write("notes/B.md", note("b", "Beta", "needle beta", "knowledgeId: knowledge_000000000000000000000002\n"));
  f.write("skills/Other.md", note("other", "Other", "other"));
  const prepare = f.database.prepare.bind(f.database);
  let identityDeletes = 0;
  t.mock.method(f.database, "prepare", (sql, ...args) => {
    const statement = prepare(sql, ...args);
    if (sql === "DELETE FROM fresh_note_query_identities WHERE area=? AND path=?") {
      const run = statement.run.bind(statement);
      t.mock.method(statement, "run", (...parameters) => { identityDeletes++; return run(...parameters); });
    }
    return statement;
  });
  const identities = () => f.database.prepare(
    "SELECT identity_key,area,path,key_kind FROM fresh_note_query_identities ORDER BY identity_key,area,path,key_kind"
  ).all().map(row => ({ ...row }));
  const expected = f.list({ limit: 0 }).text, original = identities();
  assert.equal(identityDeletes, 0, "an already-cleared rebuild must not scan the growing identity table per source");
  assert.equal(original.length, 5);
  f.database.exec("INSERT INTO fresh_note_query_identities VALUES('forged','notes','Missing.md','document')");
  assert.equal(f.list({ limit: 0 }).text, expected);
  assert.deepEqual(identities(), original);
  assert.equal(identityDeletes, 0, "a foreign-mutation rebuild must also avoid redundant identity scans");
  f.write("notes/A.md", note("replacement", "Replaced", "needle replaced", "knowledgeId: knowledge_000000000000000000000003\n"));
  fs.rmSync(join(f.root, "notes/B.md"));
  const after = JSON.parse(f.list({ limit: 0 }).text);
  assert.equal(after.total, 1);
  assert.equal(after.notes[0].knowledge_id, "knowledge_000000000000000000000003");
  assert.deepEqual(identities(), [
    { identity_key: "knowledge_000000000000000000000003", area: "notes", path: "A.md", key_kind: "knowledge" },
    { identity_key: "other", area: "skills", path: "Other.md", key_kind: "document" },
    { identity_key: "replacement", area: "notes", path: "A.md", key_kind: "document" },
  ]);
  assert(identityDeletes > 0, "incremental replacements and removals must still delete superseded identities");
});

test("rebuild SQL preparation stays bounded and skips cleared FTS deletes without changing incremental repair", t => {
  const f = fixture(t);
  for (let n = 0; n < 24; n++) f.write(`notes/N${String(n).padStart(2, "0")}.md`, note(`note-${n}`, `Note ${n}`, "needle"));
  const prepare = f.database.prepare.bind(f.database);
  let prepares = 0, ftsDeletes = 0, ftsInsertions = 0;
  t.mock.method(f.database, "prepare", (sql, ...args) => {
    prepares++;
    const statement = prepare(sql, ...args);
    if (sql === "DELETE FROM fresh_note_query_fts WHERE rowid=?") {
      const run = statement.run.bind(statement);
      t.mock.method(statement, "run", (...parameters) => { ftsDeletes++; return run(...parameters); });
    }
    if (sql.startsWith("INSERT INTO fresh_note_query_fts(")) {
      const run = statement.run.bind(statement);
      t.mock.method(statement, "run", (...parameters) => { ftsInsertions++; return run(...parameters); });
    }
    return statement;
  });
  const expected = oracle(f.root, "list", { limit: 0 });
  assert.equal(f.list({ limit: 0 }).text, expected);
  assert(prepares < 64, `initial SQL preparation must be bounded, observed ${prepares} for 24 Notes`);
  assert.equal(ftsDeletes, 0, "a rebuilt empty FTS must not delete each nonexistent row");
  assert.equal(ftsInsertions, 1, "a full rebuild must populate FTS with one ordered bulk statement");
  assert.equal(f.database.prepare("SELECT count(*) n FROM fresh_note_query_fts").get().n, 24);
  f.database.exec("DELETE FROM fresh_note_query_fts");
  assert.equal(f.list({ limit: 0 }).text, expected);
  assert.equal(ftsDeletes, 0, "foreign-index repair must retain the same rebuild optimization");
  f.write("notes/N00.md", note("note-0", "Note 0", "changed needle"));
  assert.equal(f.search("changed").text, oracle(f.root, "search", { query: "changed", limit: 20 }));
  assert.equal(ftsDeletes, 1, "incremental replacements still remove old postings");
  fs.rmSync(join(f.root, "notes/N01.md"));
  assert.equal(f.list({ limit: 0 }).text, oracle(f.root, "list", { limit: 0 }));
  assert.equal(ftsDeletes, 2, "incremental removal still deletes its old FTS row");
});

test("repeated list pages reuse serialization only after fresh scans and never bypass revisions or rolled-back deltas", t => {
  const f = fixture(t), title = "Unique cached page serialization marker";
  f.write("notes/A.md", note("a", title, "needle"));
  const first = f.list({ limit: 1 }), reads = f.scanner.statistics().reads;
  const stringify = JSON.stringify.bind(JSON);
  let titleSerializations = 0;
  const hook = t.mock.method(JSON, "stringify", (value, ...args) => {
    if (value === title) titleSerializations++;
    return stringify(value, ...args);
  });
  try {
    assert.equal(f.list({ limit: 1 }).text, first.text);
    assert.equal(f.list({ limit: 1 }).text, first.text);
    assert.equal(titleSerializations, 0, "a validated unchanged page must not reserialize its rows");
    assert.equal(f.scanner.statistics().reads - reads, 4, "serialization reuse must still perform both fresh scans");
  } finally { hook.mock.restore(); }
  assert.throws(() => f.list({ limit: 1, inventory_revision: "0".repeat(64) }), { code: "CONFLICT" });
  f.write("notes/A.md", note("a", "Changed title", "needle"));
  f.hook(phase => { if (phase === "after-query") throw new CoreError("RECOVERY_REQUIRED", "pending journal"); });
  assert.throws(() => f.list({ limit: 1 }), { code: "RECOVERY_REQUIRED" });
  assert.equal(f.model.statistics().generations, first.generation);
  f.hook(() => {});
  const changed = f.list({ limit: 1 });
  assert.equal(JSON.parse(changed.text).notes[0].title, "Changed title");
  assert.notEqual(changed.text, first.text);
  assert.equal(changed.generation, first.generation + 1);
});

test("post-commit foreign mutation is not absorbed into the model's trusted version cursor", t => {
  const f = fixture(t); populate(f);
  const expected = f.search("needle").text;
  const exec = f.database.exec.bind(f.database);
  let poison = true;
  const stub = t.mock.method(f.database, "exec", sql => {
    const result = exec(sql);
    if (sql === "COMMIT" && poison) {
      poison = false;
      const other = new DatabaseSync(join(f.root, "core.sqlite"));
      try { other.exec("DELETE FROM fresh_note_query_fts"); }
      finally { other.close(); }
    }
    return result;
  });
  try {
    assert.equal(f.search("needle").text, expected);
    assert.equal(f.search("needle").text, expected);
  } finally { stub.mock.restore(); }
  assert.equal(f.database.prepare("SELECT count(*) n FROM fresh_note_query_fts").get().n, 4);
});

test("same-connection guard mutations reject and roll back; a different tokenizer never returns altered semantics", t => {
  const f = fixture(t); populate(f);
  const expected = f.search("needle").text, updates = f.model.statistics().ftsUpdates;
  let mutate = true;
  f.hook(phase => { if (phase === "after-query" && mutate) { mutate = false; f.database.exec("DELETE FROM fresh_note_query_fts"); } });
  assert.throws(() => f.search("needle"), error => error.code === "CONFLICT");
  assert.equal(f.search("needle").text, expected);
  assert.equal(f.model.statistics().ftsUpdates, updates);
  f.database.exec("DROP TABLE fresh_note_query_fts; CREATE VIRTUAL TABLE fresh_note_query_fts USING fts5(slug,title,content)");
  assert.throws(() => f.search("needle"), error => error.code === "STORAGE_ERROR");
});

test("derived schema has explicit native FTS shadow inventory and rejects unknown table layouts", t => {
  const f = fixture(t);
  const tables = f.database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
  assert.deepEqual(tables, [...FRESH_NOTE_QUERY_DERIVED_TABLES].sort());
  f.database.exec("DROP TABLE fresh_note_query_sources; CREATE TABLE fresh_note_query_sources(wrong TEXT)");
  assert.throws(() => initializeFreshNoteQuerySchema(f.database, f.guard), error => error.code === "STORAGE_ERROR");
});

test("qualified scanner views stay immutable and existing root-index delta port shares the owner transaction", t => {
  const f = fixture(t); f.write("notes/A.md", note("a", "A", "alpha"));
  const scan = f.scanner.scan();
  assert.equal(scan.sources.set, undefined);
  assert.equal(scan.directories.add, undefined);
  assert.throws(() => { scan.sources.get("notes/A.md").raw = "forged"; }, TypeError);
  const calls = [];
  const model = createFreshNoteQueryModel({ database: f.database, scanner: f.scanner, guard: f.guard,
    reconcileRootIndex(observed, delta) {
      assert.equal(f.database.isTransaction, true);
      assert.equal(observed.rootPin, f.scanner.rootPin);
      calls.push({ rebuild: delta.rebuild, changed: delta.changed.map(source => source.id), removed: delta.removed.map(source => source.id) });
      return undefined;
    } });
  try {
    model.executeFresh({ kind: "list", arguments: {} });
    model.executeFresh({ kind: "list", arguments: {} });
    f.write("notes/A.md", note("a", "A", "omega"));
    model.executeFresh({ kind: "list", arguments: {} });
    assert.deepEqual(calls, [{ rebuild: true, changed: ["a"], removed: [] }, { rebuild: false, changed: ["a"], removed: [] }]);
  } finally { model.close(); }
});

test("frozen Python Unicode, JSON numeric types, whitespace and timestamp behavior use the actual offline oracle", t => {
  const f = fixture(t);
  const values = ["ASCII TITLE 123", "Workflow 中文 OPEN", "İABC", "A𐵐B", "ΟΣ", "ΟΣΑ", "AΣ\u0301", "AΣ\u0301A",
    "AΣ\u02b0", "İ", "𐵐", "Σ\u0345", "AΣ\u0897A", "\u001c \u0085text\u3000"];
  const actual = JSON.parse(execFileSync(python, ["-I", "-B", "-c",
    "import json,sys; print(json.dumps([[x.lower(),x.strip()] for x in json.load(sys.stdin)]))"],
  { ...pythonOptions(f.root), input: JSON.stringify(values) }));
  assert.deepEqual(values.map(value => [pythonLower(value), pythonStrip(value)]), actual);
  const numeric = ["1.0", "-0.0", "1e-7", "1e-4", "1e16", "1e20", "1e21", "999999999999999999999999999999", '{"2":1.0,"1":2}'];
  for (const raw of numeric) {
    const expected = execFileSync(python, ["-I", "-B", "-c",
      "import json,sys;sys.stdout.write(json.dumps(json.loads(sys.argv[1]),ensure_ascii=False))", raw], pythonOptions(f.root));
    assert.equal(pythonJson(parseLegacyNote(`---\ntype: ${raw}\n---\n`).metadata.type), expected);
  }
  for (const ns of ["1700000000123456789", "-1", "1700000000999999999", "1000000000000001", "0"]) {
    const expected = execFileSync(python, ["-I", "-B", "-c",
      "import datetime,sys;s,n=divmod(int(sys.argv[1]),1000000000);sys.stdout.write(datetime.datetime.utcfromtimestamp(s+n*1e-9).isoformat())", ns], pythonOptions(f.root));
    assert.equal(pythonTimestamp(ns), expected);
  }
});

test("real shared mmap+msync edits with pinned stat observations still require fresh hashes", async t => {
  const f = fixture(t);
  f.write("notes/Mapped.md", note("mapped", "Mapped", "alpha"));
  const child = spawn(python, ["-I", "-B", "-u", "-c", `
import mmap,os,sys
with open(sys.argv[1],"r+b") as f:
 with mmap.mmap(f.fileno(),0) as m:
  m[-5:]=b"alpha";m.flush();os.pwrite(f.fileno(),b"alpha",len(m)-5);print("ready",flush=True)
  for line in sys.stdin:
   m[-5:]=line.strip().encode();m.flush();print("done",flush=True)
`, join(f.root, "notes/Mapped.md")], { ...pythonOptions(f.root), stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  try {
    assert.equal((await lines.next()).value, "ready");
    f.search("alpha");
    const before = fs.statSync(join(f.root, "notes/Mapped.md"), { bigint: true });
    child.stdin.write("omega\n");
    assert.equal((await lines.next()).value, "done");
    const after = fs.statSync(join(f.root, "notes/Mapped.md"), { bigint: true });
    assert.deepEqual([after.ino, after.size], [before.ino, before.size]);
    // Kernel timestamp ticks are scheduling-dependent; pin all scanner stat fields deterministically.
    const originalFstat = fs.fstatSync, originalLstat = fs.lstatSync;
    const pinned = value => value?.ino === before.ino ? before : value;
    const fstat = t.mock.method(fs, "fstatSync", (...args) => pinned(originalFstat(...args)));
    const lstat = t.mock.method(fs, "lstatSync", (...args) => {
      const value = originalLstat(...args);
      return args[1]?.bigint ? pinned(value) : value;
    });
    syncBuiltinESMExports();
    try { assert.equal(f.search("omega").text, oracle(f.root, "search", { query: "omega", limit: 20 })); }
    finally { fstat.mock.restore(); lstat.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(f.scanner.statistics().parses, 2);
  } finally {
    child.stdin.end();
    const [code] = await once(child, "close"); assert.equal(code, 0);
  }
});

test("existing rich/snapshot APIs and their private metadata isolation remain unchanged", t => {
  const f = fixture(t); populate(f);
  const rich = scanMarkdown(f.root), snapshot = scanMarkdown(f.root, { metadata: false });
  assert.deepEqual(snapshot, rich.map(({ record, raw }) => ({ record, raw })));
  rich[0].metadata.set("title", "local mutation");
  assert.notEqual(scanMarkdown(f.root)[0].record.title, "local mutation");
  const path = join(f.root, "notes/A.md"), raw = fs.readFileSync(path, "utf8");
  const before = fs.statSync(path);
  fs.writeFileSync(path, raw.replace("Alpha", "Bravo"));
  fs.utimesSync(path, before.atime, before.mtime);
  assert.equal(scanMarkdown(f.root).find(value => value.record.id === "a").record.title, "Bravo");
  assert.equal(scanMarkdown(f.root).find(value => value.record.id === "a").record.sha256,
    createHash("sha256").update(fs.readFileSync(path)).digest("hex"));
});
