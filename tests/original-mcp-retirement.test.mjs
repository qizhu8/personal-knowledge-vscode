import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import ts from "typescript";
import { readOriginalSource } from "../scripts/migration.mjs";

const build = new URL(process.env.PKM_RETIREMENT_TEST_DIST ?? "../dist/", import.meta.url);
const load = name => import(new URL(`${name}.js`, build));
const { captureOriginalMcpCustody, openOriginalMcpRoot, acquireOriginalMcpRootFence } = await load("original-mcp-root");
const { captureOriginalMcpRetirementB1, prepareOriginalMcpRetirement, retireOriginalMcpRoot } = await load("original-mcp-retirement");
const { createNativePublicOwnerBackend } = await load("native-public-mcp-owner");
const { createOriginalMcpNativeHost } = await load("original-mcp-native-host");
const { originalPublicMcpContracts } = await load("native-public-original-mcp-contracts");
const { validateWorkspace } = await load("workspace-validation");
const { initializeFreshNoteQuerySchema } = await load("fresh-note-query-model");
const { withOriginalMcpRetirementSqliteJournal, withOriginalMcpColdSqliteRead,
  originalMcpColdSqliteReadDatabase } = await load("original-mcp-cold-sqlite-read");
const { bindBrowserMutationPin } = await load("browser-mutation-receipt");
const hash = value => createHash("sha256").update(value).digest("hex");
const scope = "native-dogfood/v1";
const actor = { id: "mcp:external", canWrite: true };
const limits = { maxEntries: 1000, maxDepth: 32, maxBytes: 67_108_864, maxFileBytes: 33_554_432 };
const expected = opened => Object.fromEntries(["root", "workspaceId", "planSha256", "journalSha256"].map(key => [key, opened[key]]));
const pinnedFiles = ["knowledge.db", ".pkm/content-privacy.json", ".pkm/state/actions/settings.json",
  "notes/Private/Secret.md", "notes/.trash/deleted/content.md", "skills/.trash/deleted/content.md"];
async function pins(root, names = pinnedFiles) {
  const result = {};
  for (const name of names) {
    const stat = await lstat(join(root, name), { bigint: true });
    result[name] = { identity: [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.size, stat.mtimeNs, stat.ctimeNs].map(String),
      sha256: hash(await readFile(join(root, name))) };
  }
  return result;
}
const createdPaths = ["notes/Added/Nested/Created Note.md", "skills/Added/Nested/Created Skill.md", "papers/Added/Nested/Created Paper.md"];
async function fixture(t, update = true, create = false, retrieve = false) {
  const directory = resolve("tests", `.original-retirement-${randomUUID()}`), root = join(directory, "original");
  await mkdir(directory, { mode: 0o700 });
  let owner, backend, writerFence;
  t.after(async () => {
    await backend?.close(); await owner?.close(); await writerFence?.release();
    await rm(directory, { recursive: true, force: true });
  });
  for (const name of ["notes/Private", "notes/.trash/deleted", "skills/.trash/deleted", "papers", ".pkm/state/actions"])
    await mkdir(join(root, name), { recursive: true, mode: 0o700 });
  await writeFile(join(root, ".pkm/content-privacy.json"),
    JSON.stringify({ schema: 1, private: { notes: ["Private"] } }), { mode: 0o600 });
  await writeFile(join(root, ".pkm/state/actions/settings.json"), '{"legacy":"not-authorized"}', { mode: 0o600 });
  await writeFile(join(root, "notes/Entry.md"), '---\ntitle: "Entry"\ntags: ["original"]\n---\nOriginal Note.\n', { mode: 0o600 });
  await writeFile(join(root, "skills/Skill.md"),
    '---\nname: "Skill"\ndescription: "Original description"\ntags: ["original"]\n---\nOriginal Skill.\n', { mode: 0o600 });
  await writeFile(join(root, "papers/Paper.md"),
    '---\ntitle: "Paper"\nauthors: ["Original author"]\nyear: 2026\n---\nOriginal Paper.\n', { mode: 0o600 });
  for (const name of pinnedFiles.filter(name => !["knowledge.db", ".pkm/content-privacy.json", ".pkm/state/actions/settings.json"].includes(name)))
    await writeFile(join(root, name), `Immutable original ${name}.\n`, { mode: 0o600 });
  const old = new DatabaseSync(join(root, "knowledge.db"));
  old.exec("CREATE TABLE history(value TEXT); INSERT INTO history VALUES('original retained');"); old.close();
  const before = await pins(root);
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "b0"), operatorId: "isolated-retirement-fixture",
    profileSha256: hash("isolated-native-profile"), limits });
  const opened = await openOriginalMcpRoot(plan); owner = opened.owner;
  const contracts = originalPublicMcpContracts();
  const host = await createOriginalMcpNativeHost(opened.storage, {
    profileSha256: plan.profileSha256, sourceCatalogSha256: contracts.provenance.metadataSha256,
    authorityId: "isolated-native-fixture", epoch: "retirement-test", signal: new AbortController().signal,
    assertCurrent() {}, async authorizeAdmission() { return true; }, async authorizePublic() { return true; },
    models: { configuration: { aiEndpoint: "https://not-called.invalid/v1", aiModel: "not-called" },
      registryAvailability: {}, async credentialAvailable() { return false; }, async authorizeRequest() { return false; },
      transport: { supports: () => false, async open() { throw new Error("No model/network call is allowed."); } } },
  });
  backend = createNativePublicOwnerBackend(owner, { actor, originalMcpHost: host });
  let retrievalRows;
  if (retrieve) {
    await backend.invoke("original_mcp_public", { tool: "list_notes", arguments: { limit: 10 } });
    const reply = await backend.invoke("original_mcp_public", {
      tool: "search_knowledge", arguments: { query: "Original", limit: 10, route: "lexical" },
    });
    assert.match(JSON.stringify(reply), /Original/);
    const database = opened.storage.connectNative();
    try {
      retrievalRows = database.prepare("SELECT * FROM legacy_retrieval_corpus ORDER BY generation").all();
      assert.equal(retrievalRows.length, 1);
      if (retrieve === "derived") {
        // Exercise coexistence with the exact existing disposable read index,
        // initialized by its real helper under this same canonical owner lease.
        const stat = await lstat(root, { bigint: true });
        initializeFreshNoteQuerySchema(database, { assert() {
          owner.assertWorkspaceLease();
          return { workspaceId: opened.workspaceId, rootPin: `${stat.dev}:${stat.ino}` };
        } });
        assert(database.prepare("SELECT 1 FROM sqlite_master WHERE name='fresh_note_query_fts'").get());
      }
    } finally { database.close(); }
  }
  if (update) for (const [tool, arguments_] of [
    ["update_note", { slug: "Entry", content: "Retained v5 Note content.\n", tags: ["retained-note"] }],
    ["update_skill", { name: "Skill", content: "Retained v5 Skill content.\n", description: "Retained v5 description",
      tags: ["retained-skill"], priority: "high" }],
    ["update_paper", { slug: "Paper", content: "Retained v5 Paper content.\n", authors: ["Retained author"] }],
  ]) await backend.invoke("original_mcp_public", { tool, arguments: arguments_ });
  if (create) for (const [tool, arguments_] of [
    ["add_note", { title: "Created Note", category: "Added/Nested", content: "Created v5 Note content.\n", tags: ["created-note"] }],
    ["add_skill", { name: "Created Skill", category: "Added/Nested", content: "Created v5 Skill content.\n",
      description: "Created v5 description", tags: ["created-skill"], priority: "highest" }],
    ["add_paper", { title: "Created Paper", category: "Added/Nested", content: "Created v5 Paper content.\n",
      authors: ["Created author"], year: 2026 }],
    ["update_note", { slug: "Added/Nested/Created Note", content: "Created then updated v5 Note content.\n" }],
    ["update_skill", { name: "Created Skill", content: "Created then updated v5 Skill content.\n" }],
    ["update_paper", { slug: "Added/Nested/Created Paper", content: "Created then updated v5 Paper content.\n" }],
  ]) await backend.invoke("original_mcp_public", { tool, arguments: arguments_ });
  await backend.close(); await owner.close();
  writerFence = await acquireOriginalMcpRootFence(root);
  return { directory, root, plan, prepared: expected(opened), before, writerFence, retrievalRows,
    options: { writerFence }, b1Request: { scope, backup: join(directory, "b1") } };
}
async function preservation(f) {
  return captureOriginalMcpRetirementB1(f.plan, f.prepared, f.b1Request, f.options);
}
function bindCommittedPublicPins(f) {
  // This direct backend fixture bypasses Core prebinding; retain only real committed request/receipt pairs.
  f.writerFence.assertHeld();
  const database = new DatabaseSync(join(f.root, "core.sqlite"));
  try {
    for (const row of database.prepare(`SELECT k.request_json,r.fingerprint
      FROM migration_runtime_knowledge_commits k JOIN receipts r ON r.operation_id=k.operation_id`).all()) {
      const request = JSON.parse(row.request_json);
      const body = JSON.stringify({ operation: request.operation, version: 1, arguments: request.args });
      bindBrowserMutationPin(database, request, hash(body), row.fingerprint);
    }
  } finally { database.close(); }
}

// Authenticate the actual historical original generator, then execute its reader
// functions unchanged against this test's retained root. No fake legacy backend.
async function originalReader(root, keys = { note: "Entry", skill: "Skill", paper: "Paper" }) {
  const sourceSha256 = "2a5f623b20b71e3d3ce12283db1fbcb01fb5fa4b43ebbf29d2fd9a28a992f948";
  const bytes = await readOriginalSource("src/mcp/mcp.ts", { sha256: sourceSha256, dataset: "linux-candidate-originals" });
  assert.equal(hash(bytes), sourceSha256);
  const discovery = JSON.parse(await readFile(new URL("./fixtures/original-public-mcp-discovery.json", import.meta.url)));
  assert.equal(discovery.producer.extensionVersion, "4.0.22");
  assert.equal(discovery.metadataSha256, originalPublicMcpContracts().provenance.metadataSha256);
  const source = ts.createSourceFile("original-4.0.22-mcp.ts", bytes.toString("utf8"), ts.ScriptTarget.Latest, true);
  let template;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "fs.writeFileSync"
      && node.arguments[0]?.getText(source) === "serverPy" && ts.isTemplateExpression(node.arguments[1])
      && node.arguments[1].head.text.includes("PKM MCP Server"))
      template = node.arguments[1].head.text + node.arguments[1].templateSpans.map(span => `__CAPTURE_ONLY__${span.literal.text}`).join("");
    ts.forEachChild(node, visit);
  }
  visit(source); assert(template);
  const script = `
import ast,datetime,json,re,sys
from pathlib import Path
request=json.load(sys.stdin)
STORE=Path(request["root"])
tree=ast.parse(request["source"])
names={"_parse","_name_of","_cat_of","_mtime","_arr","_year","_norm_cites","_mcp_system_path","_note","_skill_priority","_skill","_paper"}
selected=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names]
assert {node.name for node in selected}==names
exec(compile(ast.Module(body=selected,type_ignores=[]),"<authenticated-legacy4.0.22-reader>","exec"))
note=_note(STORE/("notes/"+request["keys"]["note"]+".md"),request["keys"]["note"])
skill=_skill(STORE/("skills/"+request["keys"]["skill"]+".md"),request["keys"]["skill"])
paper=_paper(STORE/("papers/"+request["keys"]["paper"]+".md"),request["keys"]["paper"])
skill.pop("_path",None)
print(json.dumps({"note":note,"skill":skill,"paper":paper},ensure_ascii=False))
`;
  return JSON.parse(execFileSync("python3", ["-I", "-B", "-c", script], {
    input: JSON.stringify({ root, source: template, keys }), encoding: "utf8", maxBuffer: 8_388_608,
  }));
}
const createdKeys = { note: "Added/Nested/Created Note", skill: "Added/Nested/Created Skill", paper: "Added/Nested/Created Paper" };
function assertCreated(original) {
  for (const value of Object.values(original)) assert.equal(value.category, "Added/Nested");
  assert.equal(original.note.content, "Created then updated v5 Note content.\n");
  assert.equal(original.note.title, "Created Note");
  assert.deepEqual(original.note.tags, ["created-note"]);
  assert.equal(original.skill.content, "Created then updated v5 Skill content.\n");
  assert.equal(original.skill.name, "Created Skill");
  assert.equal(original.skill.description, "Created v5 description");
  assert.equal(original.skill.priority, "highest");
  assert.deepEqual(original.skill.tags, ["created-skill"]);
  assert.equal(original.paper.content, "Created then updated v5 Paper content.\n");
  assert.equal(original.paper.title, "Created Paper");
  assert.deepEqual(original.paper.authors, ["Created author"]);
}

test("real lexical retrieval then six basic creates/updates retire with exact derived state and legacy4.0.22-readable content", {
  timeout: 120_000,
}, async t => {
  const f = await fixture(t, true, true, true), retained = await pins(f.root, ["notes/Entry.md", "skills/Skill.md", "papers/Paper.md", ...createdPaths]);
  bindCommittedPublicPins(f);
  const mutationPins = await withOriginalMcpColdSqliteRead(f.plan, f.writerFence, async context => {
    const pins = originalMcpColdSqliteReadDatabase(context, f.plan)
      .prepare("SELECT * FROM browser_mutation_pins ORDER BY operation_id").all();
    return pins;
  });
  assert(mutationPins.length > 0, "Production pin binding links the actual committed public writes.");
  const b1 = await preservation(f);
  const ticket = await prepareOriginalMcpRetirement(f.plan, f.prepared, { scope, b1 }, f.options);
  const runtime = {};
  for (const name of b1.runtimeNames) runtime[name] = hash(await readFile(join(f.root, name)));
  const result = await retireOriginalMcpRoot(f.plan, f.prepared, ticket, f.options);
  assert.equal(result.retainedPublicUpdates, 3);
  assert.equal(result.retainedPublicCreates, 3);
  for (const [name, digest] of Object.entries(runtime)) {
    assert.equal(hash(await readFile(join(result.archive, name))), digest);
    assert(!(await readdir(f.root)).includes(name), `${name} retired rather than discarded`);
  }
  assert.equal((await lstat(result.archive)).mode & 0o777, 0o700);
  const archivedPath = pathToFileURL(join(result.archive, "core.sqlite")); archivedPath.search = "?immutable=1";
  const archived = new DatabaseSync(archivedPath, { readOnly: true });
  try {
    assert.deepEqual(archived.prepare("SELECT * FROM legacy_retrieval_corpus ORDER BY generation").all(), f.retrievalRows);
    assert.deepEqual(archived.prepare("SELECT * FROM browser_mutation_pins ORDER BY operation_id").all(), mutationPins);
  } finally { archived.close(); }
  assert.deepEqual(await pins(f.root), f.before);
  assert.deepEqual(await pins(f.root, Object.keys(retained)), retained, "Retained public files were not rewritten or restored from B0.");
  const original = await originalReader(f.root);
  assert.equal(original.note.content, "Retained v5 Note content.\n");
  assert.deepEqual(original.note.tags, ["retained-note"]);
  assert.equal(original.skill.content, "Retained v5 Skill content.\n");
  assert.equal(original.skill.description, "Retained v5 description");
  assert.equal(original.skill.priority, "high");
  assert.deepEqual(original.skill.tags, ["retained-skill"]);
  assert.equal(original.paper.content, "Retained v5 Paper content.\n");
  assert.deepEqual(original.paper.authors, ["Retained author"]);
  assertCreated(await originalReader(f.root, createdKeys));
  assert.deepEqual(await retireOriginalMcpRoot(f.plan, f.prepared, ticket, f.options), result);
  assert.equal((await originalReader(f.root)).note.content, original.note.content);
});

test("retirement refuses unsettled, foreign, malformed and unbound transport mutation pins", { timeout: 120_000 }, async t => {
  for (const condition of ["pending", "actor", "operation", "body", "fingerprint", "missing-receipt"])
    await t.test(condition, async t => {
      const f = await fixture(t);
      bindCommittedPublicPins(f);
      const database = new DatabaseSync(join(f.root, "core.sqlite"));
      try {
        assert(database.prepare("SELECT 1 FROM browser_mutation_pins LIMIT 1").get());
        const [column, value] = {
          pending: ["receipt_fingerprint", null],
          actor: ["actor_id", "other-actor"],
          operation: ["operation", "document.create"],
          body: ["body_sha256", "not-a-body-hash"],
          fingerprint: ["receipt_fingerprint", "0".repeat(64)],
          "missing-receipt": ["operation_id", randomUUID()],
        }[condition];
        database.prepare(`UPDATE browser_mutation_pins SET ${column}=?`).run(value);
      } finally { database.close(); }
      const before = await pins(f.root);
      await assert.rejects(preservation(f), /unbound or unsettled basic-write transport pins/);
      assert.deepEqual(await pins(f.root), before);
      assert((await readdir(f.root)).includes("core.sqlite"));
    });
});

test("stale live B1 and tampered independent B1 payloads refuse any retirement root writes", { timeout: 120_000 }, async t => {
  for (const tamper of ["live", "payload", "manifest"]) await t.test(tamper, async t => {
    const f = await fixture(t, true, true), b1 = await preservation(f);
    const retained = await pins(f.root, createdPaths);
    if (tamper === "live") await writeFile(join(f.root, "notes/Entry.md"), '---\ntitle: "Entry"\n---\nLater public write.\n', { mode: 0o600 });
    if (tamper === "payload") {
      const database = new DatabaseSync(join(b1.backup, "inventory.sqlite"), { readOnly: true });
      const row = database.prepare("SELECT blob FROM inventory WHERE path='core.sqlite'").get(); database.close();
      await writeFile(join(b1.backup, "blobs", row.blob), "tampered B1 bytes", { mode: 0o600 });
    }
    if (tamper === "manifest") b1.manifestSha256 = hash("wrong independent pin");
    const before = (await readdir(f.root)).sort(), content = await readFile(join(f.root, "notes/Entry.md"));
    await assert.rejects(prepareOriginalMcpRetirement(f.plan, f.prepared, { scope, b1 }, f.options), /B1|preservation/);
    assert.deepEqual((await readdir(f.root)).sort(), before);
    assert.deepEqual(await readFile(join(f.root, "notes/Entry.md")), content);
    assert.deepEqual(await pins(f.root), f.before);
    assert.deepEqual(await pins(f.root, createdPaths), retained);
  });
});

test("durable retirement intent and mid-archive interruptions resume exactly while writer protection remains until last", { timeout: 120_000 }, async t => {
  const f = await fixture(t, true, true, "derived"), b1 = await preservation(f);
  const retained = await pins(f.root, createdPaths);
  await assert.rejects(prepareOriginalMcpRetirement(f.plan, f.prepared, { scope, b1 }, {
    ...f.options, checkpoint(point) { if (point === "intent-durable") throw new Error("interrupted intent"); },
  }), /interrupted intent/);
  const ticket = await prepareOriginalMcpRetirement(f.plan, f.prepared, { scope, b1 }, f.options);
  let archived = 0;
  await assert.rejects(retireOriginalMcpRoot(f.plan, f.prepared, ticket, {
    ...f.options, checkpoint(point) { if (point === "file-archived" && ++archived === 2) throw new Error("interrupted archive"); },
  }), /interrupted archive/);
  const names = await readdir(f.root);
  assert(names.includes(".pkm-next-workspace"));
  assert(names.includes(".pkm-next-writer-fenced.json"));
  await assert.rejects(validateWorkspace(f.root), /custody|layout|Unknown|original|isolated/i);
  await f.writerFence.release();
  const resumedFence = await acquireOriginalMcpRootFence(f.root);
  t.after(() => resumedFence.release());
  const result = await retireOriginalMcpRoot(f.plan, f.prepared, ticket, { writerFence: resumedFence });
  assert.equal(result.retainedPublicUpdates, 3);
  assert.equal(result.retainedPublicCreates, 3);
  assert(!(await readdir(f.root)).includes(".pkm-next-workspace"));
  assert(!(await readdir(f.root)).includes(".pkm-next-writer-fenced.json"));
  assert.deepEqual(await pins(f.root), f.before);
  assert.deepEqual(await pins(f.root, createdPaths), retained);
  assertCreated(await originalReader(f.root, createdKeys));
});

test("archived-journal cold reads require exact retained retirement evidence; tampering refuses without Root data or SQLite writes", {
  timeout: 120_000,
}, async t => {
  const f = await fixture(t, false), b1 = await preservation(f);
  const ticket = await prepareOriginalMcpRetirement(f.plan, f.prepared, { scope, b1 }, f.options);
  await assert.rejects(retireOriginalMcpRoot(f.plan, f.prepared, ticket, {
    ...f.options, checkpoint(point) {
      if (point === "file-archived"
        && !existsSync(join(f.root, ".pkm-next-original-mcp.json")) && existsSync(join(f.root, "core.sqlite")))
        throw new Error("interrupted after archived original journal");
    },
  }), /interrupted after archived original journal/);
  const archived = join(ticket.archive, ".pkm-next-original-mcp.json");
  const before = await pins(f.root, [...pinnedFiles, "core.sqlite", "notes/Entry.md", "skills/Skill.md", "papers/Paper.md"]);
  await withOriginalMcpRetirementSqliteJournal(f.plan, f.prepared, ticket, f.writerFence, async context => {
    await assert.rejects(withOriginalMcpColdSqliteRead(f.plan, f.writerFence, async () => true, { ...context }),
      { code: "RECOVERY_REQUIRED" });
    await withOriginalMcpColdSqliteRead(f.plan, f.writerFence, async () => true, context);
  });
  assert.deepEqual(await pins(f.root, Object.keys(before)), before);
  assert(!(await readdir(f.root)).some(name => /core\.sqlite-(wal|shm|journal)/.test(name)));
  const changed = JSON.parse(await readFile(archived)); changed.token = randomUUID();
  await writeFile(archived, JSON.stringify(changed), { mode: 0o600 });
  const rootNames = (await readdir(f.root)).sort(), archiveNames = (await readdir(ticket.archive)).sort();
  await assert.rejects(retireOriginalMcpRoot(f.plan, f.prepared, ticket, f.options), /B1|journal|preserv/i);
  assert.deepEqual(await pins(f.root, Object.keys(before)), before);
  assert.deepEqual((await readdir(f.root)).sort(), rootNames);
  assert.deepEqual((await readdir(ticket.archive)).sort(), archiveNames);
});
test("lexical derived admission still refuses altered FTS, weakened corpus immutability and invalid receipts", { timeout: 120_000 }, async t => {
  for (const tamper of ["derived-schema", "trigger", "receipt"]) await t.test(tamper, async t => {
    const f = await fixture(t, false, false, "derived"), database = new DatabaseSync(join(f.root, "core.sqlite"));
    try {
      if (tamper === "derived-schema") database.exec(`DROP TABLE fresh_note_query_fts;
        CREATE VIRTUAL TABLE fresh_note_query_fts USING fts5(slug,title,content, tokenize='unicode61');`);
      else if (tamper === "trigger") database.exec(`DROP TRIGGER legacy_retrieval_corpus_no_delete;
        CREATE TRIGGER legacy_retrieval_corpus_no_delete BEFORE DELETE ON legacy_retrieval_corpus WHEN 0
        BEGIN SELECT RAISE(ABORT,'retrieval generation is immutable'); END;`);
      else database.prepare("INSERT INTO legacy_retrieval_corpus VALUES(?,?,?,?,?)")
        .run(2, hash("corpus"), hash("source"), hash("wrong-engine"), 3);
    } finally { database.close(); }
    const before = (await readdir(f.root)).sort();
    await assert.rejects(preservation(f));
    assert.deepEqual((await readdir(f.root)).sort(), before);
    assert.deepEqual(await pins(f.root), f.before);
  });
});

test("dogfood retirement refuses pending native intents, unenumerated runtime/domain files and forged fences", { timeout: 120_000 }, async t => {
  for (const condition of ["pending", "optional-domain", "unknown", "unknown-public-file", "unknown-public-directory",
    "outside-scope", "fake-fence"]) await t.test(condition, async t => {
    const f = await fixture(t, false, false, condition === "pending");
    if (condition === "pending") {
      const database = new DatabaseSync(join(f.root, "core.sqlite"));
      database.exec(`INSERT INTO pending_write(singleton,operation_id,fingerprint,actor_id,operation,document_id,after_markdown)
        VALUES(1,'pending','fingerprint','mcp:external','document.update','Entry','pending bytes');`);
      database.close();
    }
    if (condition === "optional-domain") await mkdir(join(f.root, ".pkm-next-memory"), { mode: 0o700 });
    if (condition === "unknown") await writeFile(join(f.root, ".pkm-next-unenumerated.json"), "{}", { mode: 0o600 });
    if (condition === "unknown-public-file")
      await writeFile(join(f.root, "notes/Unreceipted.md"), '---\ntitle: "Unreceipted"\n---\nUnknown public create.\n', { mode: 0o600 });
    if (condition === "unknown-public-directory") await mkdir(join(f.root, "notes/Unreceipted"), { mode: 0o700 });
    if (condition === "outside-scope") {
      const database = new DatabaseSync(join(f.root, "core.sqlite"));
      database.exec(`INSERT INTO receipts(operation_id,fingerprint,result,actor_id,operation,committed_at)
        VALUES('outside','fingerprint','{}','mcp:external','document.create','2026-01-01T00:00:00Z');`);
      database.close();
    }
    const options = condition === "fake-fence" ? { writerFence: { root: f.root, mode: "exclusive", assertHeld() {} } } : f.options;
    await assert.rejects(captureOriginalMcpRetirementB1(f.plan, f.prepared, f.b1Request, options),
      condition === "pending" ? /pending durable intents/ : undefined);
    assert((await readdir(f.root)).includes("core.sqlite"));
    assert.deepEqual(await pins(f.root), f.before);
  });
});
