import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import nodePath, { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { initialize, Storage } from "../dist/storage.js";
import { legacyIndexedKnowledgeRead, legacyRetrievalSources } from "../dist/legacy-retrieval-index.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { legacyKnowledgeWrite } from "../dist/legacy-knowledge-write.js";
import { LegacyMcpPythonWorker } from "../dist/legacy-mcp-python-worker.js";
import { readOriginalSource } from "../scripts/migration.mjs";

const root = resolve(import.meta.dirname, ".."), repository = resolve(root, "legacy");
const hash = value => createHash("sha256").update(value).digest("hex");
const id = "knowledge_000000000000000000000001";
const note = `---\nschema: pkm.knowledge/v1\nknowledgeId: ${id}\nrevision: 3\ntitle: Index Evidence\ntags: [reliable]\ncreated: "2001-02-03"\n---\nExact search Evidence and lexical receipts.\n`;
async function originalEvidence(path, provenance, field = "files") {
  const metadata = JSON.parse(await readFile(join(root, "migration", provenance), "utf8"));
  const pin = metadata[field].find(row => (row.source ?? row.path) === path);
  assert.ok(pin, `Missing original retrieval source pin: ${path}`);
  return (await readOriginalSource(path, {
    sha256: pin.sourceSha256 ?? pin.sha256, dataset: "linux-candidate-originals",
  })).toString("utf8");
}
const originalSnapshotSource = await originalEvidence("src/retrieval/retrieval-snapshot.ts", "links-provenance.json");
const snapshotAst = ts.createSourceFile("snapshot.ts", originalSnapshotSource, ts.ScriptTarget.Latest, true);
const noImports = snapshotAst.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(snapshotAst)).join("\n");
const oracleSnapshot = await import(`data:text/javascript;base64,${Buffer.from(
  `import {createHash} from "node:crypto";import {compileKnowledgeLinksV1} from ${JSON.stringify(pathToFileURL(join(root, "dist/domain/knowledge-contracts.js")).href)};\n`
  + ts.transpileModule(noImports, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText).toString("base64")}`);
const extensionSource = ts.createSourceFile("extension.ts",
  await originalEvidence("src/extension.ts", "legacy-state-import-provenance.json", "originalSources"), ts.ScriptTarget.Latest, true);
const originalSourceAdmission = extensionSource.statements.find(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === "currentRetrievalSnapshot");
assert(originalSourceAdmission);
const originalAdmission = new Function("skillList", "skillGet", "noteList", "paperList", "paperGet",
  "scriptList", "scriptGet", "sharedMarket", "SHARED_CONTENT_TYPES", "currentProjectStore", "getSharedMarket",
  "createRetrievalSnapshot", "path", ts.transpileModule(originalSourceAdmission.getText(extensionSource),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + "\nreturn currentRetrievalSnapshot();");

async function fixture(t) {
  const parent = join(root, "tests", `.retrieval-index-${randomUUID()}`), data = join(parent, "workspace");
  await mkdir(parent);
  await initialize(data);
  await writeFile(join(data, "notes/Evidence.md"), note);
  await mkdir(join(data, "scripts/Tools"), { recursive: true });
  await writeFile(join(data, "scripts/Tools/check.py"), "print('Evidence from immutable Script')\n");
  await writeFile(join(data, "scripts/Tools/.check.py.pkm.json"), JSON.stringify({
    schema: "pkm.script/v1", knowledgeId: "script_000000000000000000000002",
    aliases: ["pkm://scripts/Old/check.py"],
  }));
  const storage = await Storage.open(data);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await storage.close(); } };
  t.after(async () => { try { await close(); } finally { await rm(parent, { recursive: true, force: true }); } });
  const read = async (tool, args) => (await legacyIndexedKnowledgeRead(storage, { tool, arguments: args })).value;
  const rows = () => {
    const database = new DatabaseSync(join(data, "core.sqlite"), { readOnly: true });
    try { return database.prepare("SELECT * FROM legacy_retrieval_corpus ORDER BY generation").all(); }
    finally { database.close(); }
  };
  return { parent, data, storage, close, read, rows };
}
const normalized = value => {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "timings_ms").map(([key, child]) => [key, normalized(child)]));
  return value;
};

test("retrieval captures are exact and real pinned worker get/search match an independent original source oracle", async t => {
  execFileSync(process.execPath, [join(root, "scripts/capture-legacy-retrieval.mjs"), "--check"]);
  const f = await fixture(t);
  const before = await f.storage.withWorkspaceExclusive(() => {
    const database = f.storage.connectNative();
    try { return legacyRetrievalSources(f.storage, database); } finally { database.close(); }
  });
  const original = oracleSnapshot.createRetrievalSnapshot({
    skills: [], notes: [{ slug: "Evidence", knowledgeId: id, revision: 3, title: "Index Evidence",
      tags: '["reliable"]', created_at: "2001-02-03", content: "Exact search Evidence and lexical receipts.\n" }],
    papers: [], recipes: [], scripts: [{ path: "Tools/check.py", file: "check.py", category: "Tools",
      content: "print('Evidence from immutable Script')\n", lang: "Python", extension: ".py", knowledgeId: "script_000000000000000000000002" }],
    subscriptionGroups: [], readSubscription() { throw Error("not configured"); },
  });
  // The actual original Note reader supplies these defaults before projection.
  const projected = originalAdmission(() => [], () => null, () => [
    { slug: "Evidence", knowledgeId: id, revision: 3, title: "Index Evidence",
      tags: '["reliable"]', created_at: "2001-02-03", type: "general", description: "", links: [],
      content: "Exact search Evidence and lexical receipts.\n" },
  ], () => [], () => null, () => [{ path: "Tools/check.py", file: "check.py", category: "Tools", lang: "Python" }],
  () => ({ content: "print('Evidence from immutable Script')\n", knowledgeId: "script_000000000000000000000002" }),
  null, [], () => ({ list: () => ({ recipes: [] }) }), () => { throw Error("not configured"); },
  oracleSnapshot.createRetrievalSnapshot, nodePath);
  assert.notEqual(original.corpus_revision, projected.corpus_revision);
  assert.deepEqual(before.snapshot, { ...projected, documents: projected.documents.map(oracleSnapshot.indexedRetrievalDocument) });
  const workerSource = await originalEvidence("resources/retrieval_worker.py", "retrieval-runtime-provenance.json", "sourceEvidence");
  const oracleCode = `
import ast,json,sys,math,re,time,threading
from pathlib import Path
from types import SimpleNamespace
from difflib import SequenceMatcher
request=json.load(sys.stdin)
sys.path.insert(0,request["wheel"])
from adaptive_skill_retrieval import ContentType,RetrievalEngine,SkillDocument,academic_bm25_benchmark_route,exact_match_route
tree=ast.parse(request["source"])
names={"source_content_type","matches_content_types","make_document","get_source","lexical_match_evidence","dual_path_hits","search_unmeasured"}
exec(compile(ast.Module(body=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names],type_ignores=[]),"<independent-original-worker>","exec"))
documents=[make_document(value) for value in request["snapshot"]["documents"]]
ready_engine=RetrievalEngine([exact_match_route(),academic_bm25_benchmark_route()])
ready_engine.index(documents)
ready_documents={document.version:document for document in documents}
ready_source_values={document.version:{**value,"content_type":source_content_type(value),"content_hash":document.version.content_hash} for document,value in zip(documents,request["snapshot"]["documents"])}
ready_revision=request["snapshot"]["corpus_revision"];ready_generation=1;building_revision=""
ready_forward={};ready_backlinks={};engine_lock=threading.Lock();frozen_skill_path=None;serving_ready=False;serving_error=""
solutions=SimpleNamespace(managed=False,capture=lambda:(0,None,None,""))
class NoProvider:
 def __truediv__(self,key): return self
 def is_file(self): return False
state_dir=NoProvider()
result=search_unmeasured(request["payload"]);result.pop("_learning_candidates",None);result.pop("_learning_output_limit",None)
print(json.dumps({"search":result,"get":get_source({"source_id":request["id"]})}))
`;
  const expected = JSON.parse(execFileSync("python3", ["-c", oracleCode], {
    input: JSON.stringify({ source: workerSource, snapshot: before.snapshot,
      wheel: join(repository, "resources/vendor/adaptive_skill_retrieval-0.3.0.dev2026100504-py3-none-any.whl"),
      id: `pkm://knowledge/${id}`, payload: { query: "Evidence", limit: 25, content_type_filter: null,
        route: "lexical", generation: { mode: "latest-ready" }, scope: { source_ids: null }, graph: {} } }),
    encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  }));
  const actual = await f.read("search_knowledge", { query: "Evidence", debug: true });
  assert.equal(actual.ok, true, JSON.stringify(actual));
  const { groups, counts, result_count, ...workerFields } = actual;
  assert.deepEqual(normalized(workerFields), normalized(expected.search));
  assert.deepEqual(await f.read("get_knowledge", { id: `pkm://knowledge/${id}` }), expected.get);
  const script = await f.read("get_script", { id: "pkm://script/script_000000000000000000000002" });
  assert.equal(script.content, "print('Evidence from immutable Script')\n");
  assert.equal(script.content_type, "script");
  assert.equal((await f.read("get_script", { id: `pkm://knowledge/${id}` })).code, "not-found");
  assert.deepEqual(await f.read("get_knowledge", { id: "knowledge_ffffffffffffffffffffffff" }),
    { ok: false, code: "not-found", error: "Knowledge source not found" });
  assert.deepEqual(await f.read("get_knowledge", { id: "" }), { ok: false, error: "id is required" });
  assert.equal((await f.read("search_scripts", { query: "Evidence", detail: "standard" })).hits.length, 1);
  assert.equal(f.rows().length, 1);
  assert(!JSON.stringify(f.rows()).includes("immutable Script"));
});

test("corpus updates, deletes, semantic-off, generations and relocated backup rebuild never serve stale bytes", async t => {
  const f = await fixture(t);
  const first = await f.read("search_knowledge", { query: "Evidence", debug: true });
  assert.equal(first.ready_generation, 1);
  const off = await f.read("search_knowledge", { query: "Evidence", route: "semantic" });
  assert.equal(off.semantic_status, "off");
  assert.deepEqual(off.hits, []);
  assert.equal(off.model_invoked, false);
  const dual = await f.read("search_knowledge", { query: "Evidence", route: "dual" });
  assert.equal(dual.semantic_status, "off");
  assert(dual.hits.length > 0);
  await writeFile(join(f.data, "notes/Evidence.md"), note.replace("lexical receipts", "changed fresh bytes"));
  const changed = await f.read("get_knowledge", { id });
  assert.equal(changed.ready_generation, 2);
  assert(changed.content.includes("changed fresh bytes"));
  const stale = await f.read("search_knowledge", { query: "Evidence", generation_mode: "exact", generation: 1 });
  assert.equal(stale.code, "generation-not-ready");
  await rm(join(f.data, "notes/Evidence.md"));
  assert.equal((await f.read("get_knowledge", { id })).code, "not-found");
  assert.equal(f.rows().length, 3);
  const backup = join(f.parent, "backup"), relocated = join(f.parent, "relocated");
  await createWorkspaceBackup(f.storage, backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) });
  await f.close();
  await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority });
  const storage = await Storage.open(relocated);
  try {
    const result = await legacyIndexedKnowledgeRead(storage, { tool: "search_knowledge", arguments: { query: "Evidence", debug: true } });
    assert.equal(result.value.ready_generation, 4);
    assert.equal(result.value.hits.some(hit => hit.source_id === `pkm://knowledge/${id}`), false);
    assert(result.value.hits.some(hit => hit.content_type === "script"));
  } finally { await storage.close(); }
});

test("external writes during the actual engine subprocess refuse result and generation publication", async t => {
  const f = await fixture(t);
  await f.read("get_knowledge", { id });
  const original = childProcess.spawn;
  let injected = false;
  childProcess.spawn = (...args) => {
    const child = original(...args);
    if (args[1].some(value => String(value).endsWith("legacy-knowledge-mcp.py"))) child.once("close", () => {
      injected = true;
      execFileSync(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1],process.argv[2])",
        join(f.data, "notes/Evidence.md"), note.replace("lexical receipts", "raced replacement")]);
    });
    return child;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(f.read("search_knowledge", { query: "Evidence" }), /changed during retrieval/); }
  finally { childProcess.spawn = original; syncBuiltinESMExports(); }
  assert.equal(injected, true);
  assert.equal(f.rows().length, 1);
  assert((await f.read("get_knowledge", { id })).content.includes("raced replacement"));
  assert.equal(f.rows().length, 2);
});

test("failed engine or index-schema tampering never publishes a replacement generation", async t => {
  const f = await fixture(t);
  await f.read("get_knowledge", { id });
  await writeFile(join(f.data, "scripts/Tools/check.py"), Buffer.from([255, 254]));
  await assert.rejects(f.read("search_knowledge", { query: "Evidence" }), /UTF-8/);
  assert.equal(f.rows().length, 1);
  const database = new DatabaseSync(join(f.data, "core.sqlite"));
  try {
    assert.throws(() => database.exec("DELETE FROM legacy_retrieval_corpus"), /immutable/);
    database.exec("DROP TRIGGER legacy_retrieval_corpus_no_update");
  } finally { database.close(); }
  await assert.rejects(f.read("search_knowledge", { query: "Evidence" }), /immutability/);
});

test("generation transaction failure rolls back publication without storing source bytes", async t => {
  const f = await fixture(t);
  const connect = f.storage.connectNative.bind(f.storage);
  f.storage.connectNative = () => {
    const database = connect(), exec = database.exec.bind(database);
    database.exec = sql => {
      if (sql === "COMMIT") throw new Error("Injected generation commit interruption");
      return exec(sql);
    };
    return database;
  };
  try { await assert.rejects(f.read("get_knowledge", { id }), /Injected generation commit interruption/); }
  finally { f.storage.connectNative = connect; }
  assert.equal(f.rows().length, 0);
  const complete = await f.read("get_knowledge", { id });
  assert.equal(complete.ready_generation, 1);
  assert.equal(f.rows().length, 1);
});

test("native subscriber authorization is revalidated before any indexed result is released", async t => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(legacyIndexedKnowledgeRead(f.storage, {
    tool: "get_knowledge", arguments: { id },
  }, async () => ({ authorityRevision: ++calls })), /authority or membership changed/);
  assert.equal(calls, 2);
  assert.equal((await f.read("get_knowledge", { id })).content, "Exact search Evidence and lexical receipts.\n");
});

test("owned original persistent worker reports its actual PID, source generations, delta rebuilds and explicit shutdown", async t => {
  const f = await fixture(t);
  const worker = new LegacyMcpPythonWorker(join(root, "compat/legacy-knowledge-mcp.py"));
  t.after(() => worker.close());
  const call = (tool, args = {}) => legacyIndexedKnowledgeRead(f.storage, { tool, arguments: args }, undefined,
    input => worker.execute(input));
  const first = (await call("retrieval_status")).value;
  assert.equal(first.ok, true);
  assert.equal(first.ready, true);
  assert.equal(first.document_count, 2);
  assert.equal(first.semantic_status, "off");
  assert.equal(first.solution.state, "disabled");
  assert.equal(first.skill_serving.enabled, false);
  assert.equal(first.update_mode, "persistent-delta-events-with-full-in-memory-rebuild");
  assert.equal(first.engine_version, "0.3.0.dev2026100504");
  assert(first.pid > 0);
  process.kill(first.pid, 0);
  assert.equal((await call("get_knowledge", { id })).value.content, "Exact search Evidence and lexical receipts.\n");
  assert.equal((await call("retrieval_status")).value.pid, first.pid);
  await writeFile(join(f.data, "notes/Evidence.md"), note.replace("Exact search", "Changed real corpus"));
  const changed = (await call("retrieval_status")).value;
  assert.equal(changed.pid, first.pid);
  assert.notEqual(changed.corpus_revision, first.corpus_revision);
  assert(changed.ready_generation > first.ready_generation);
  assert.equal((await call("get_knowledge", { id })).value.content, "Changed real corpus Evidence and lexical receipts.\n");
  await rm(join(f.data, "notes/Evidence.md"));
  assert.equal((await call("retrieval_status")).value.document_count, 1);
  assert.equal((await call("get_knowledge", { id })).value.code, "not-found");
  await worker.close();
  await assert.rejects(call("retrieval_status"), /exited|write after end/);
  assert.throws(() => process.kill(first.pid, 0), /ESRCH/);
});

test("persistent worker shutdown closes admission, drains actual work and leaves the peer worker alive", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const script = join(f.parent, "owned-worker.py"), gate = join(f.parent, "release");
  await writeFile(script, `
import json, os, sys, time
for line in sys.stdin:
    request = json.loads(line)
    if request.get("gate"):
        with open(request["gate"] + ".started", "w") as started:
            started.write("running")
        while not os.path.exists(request["gate"]):
            time.sleep(0.01)
    print(json.dumps({"result": {"pid": os.getpid()}}), flush=True)
`);
  const worker = new LegacyMcpPythonWorker(script), peer = new LegacyMcpPythonWorker(script);
  try {
    const ownPid = (await worker.execute({})).pid, peerPid = (await peer.execute({})).pid;
    assert.notEqual(ownPid, peerPid);
    const running = worker.execute({ gate });
    for (let count = 0; ; count++) {
      try { await readFile(`${gate}.started`); break; }
      catch (error) {
        if (error.code !== "ENOENT" || count >= 500) throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    let closed = false;
    const closing = worker.close().then(() => { closed = true; });
    await assert.rejects(worker.execute({}), /closing/);
    assert.equal(closed, false);
    process.kill(ownPid, 0);
    assert.equal((await peer.execute({})).pid, peerPid);
    await writeFile(gate, "release");
    assert.equal((await running).pid, ownPid);
    await closing;
    assert.throws(() => process.kill(ownPid, 0), /ESRCH/);
    assert.equal((await peer.execute({})).pid, peerPid);
    await peer.close();
    assert.throws(() => process.kill(peerPid, 0), /ESRCH/);
  } finally {
    await writeFile(gate, "release");
    await Promise.all([worker.close(), peer.close()]);
  }
});

for (const failure of ["exit", "protocol"]) test(`persistent worker ${failure} failure cannot become a successful close`, async t => {
  const f = await fixture(t), script = join(f.parent, "failed-worker.py");
  await writeFile(script, `
import json, os, sys
for line in sys.stdin:
    request = json.loads(line)
    if request.get("fail"):
        if request["fail"] == "exit":
            os._exit(7)
        print("not-json", flush=True)
    else:
        print(json.dumps({"result": {"pid": os.getpid()}}), flush=True)
`);
  const worker = new LegacyMcpPythonWorker(script);
  t.after(() => worker.close().catch(() => {}));
  const { pid } = await worker.execute({});
  await assert.rejects(worker.execute({ fail: failure }), /exited|response is invalid/);
  await assert.rejects(worker.close(), /shutdown is unconfirmed|response is invalid/);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  await assert.rejects(worker.close(), /shutdown is unconfirmed|response is invalid/);
});

test("configured model sources fail explicitly before worker execution, never silently download or fall back", async t => {
  const f = await fixture(t);
  const directory = join(f.data, "knowledge-read-config/retrieval");
  await mkdir(directory, { recursive: true });
  let executions = 0;
  for (const name of ["serving-release.json", "solution-selection.json"]) {
    await writeFile(join(directory, name), JSON.stringify({ model: "https://not-called.invalid/model", embedding_enabled: true }));
    await assert.rejects(legacyIndexedKnowledgeRead(f.storage, { tool: "retrieval_status", arguments: {} }, undefined,
      async () => { executions++; throw Error("Provider must not execute without native model admission."); }), /Configured retrieval providers/);
    await rm(join(directory, name));
  }
  assert.equal(executions, 0);
  assert.equal(f.rows().length, 0);
});

test("actual concurrent canonical writer waits for the indexed read fence then publishes fresh retrieval", async t => {
  const f = await fixture(t);
  const runtime = await createNativeRuntime({ storage: f.storage });
  t.after(() => runtime.close());
  const original = childProcess.spawn;
  let arrived, release;
  const atExit = new Promise(resolve => { arrived = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  childProcess.spawn = (...args) => {
    const child = original(...args);
    if (args[1].some(value => String(value).endsWith("legacy-knowledge-mcp.py"))) {
      const once = child.once.bind(child);
      child.once = (event, listener) => once(event, event === "close"
        ? (...values) => { arrived(); hold.then(() => listener(...values)); } : listener);
    }
    return child;
  };
  syncBuiltinESMExports();
  let write;
  try {
    const reading = f.read("get_knowledge", { id });
    await atExit;
    let completed = false;
    write = legacyKnowledgeWrite(runtime.core, f.storage, { id: "mcp:external", canWrite: true }, {
      tool: "update_note", arguments: { slug: "Evidence", content: "Published by the canonical writer.\n" },
    }).then(result => { completed = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false);
    release();
    assert.equal((await reading).content, "Exact search Evidence and lexical receipts.\n");
    await write;
  } finally { release(); childProcess.spawn = original; syncBuiltinESMExports(); await write; }
  const fresh = await f.read("get_knowledge", { id });
  assert.equal(fresh.content, "Published by the canonical writer.\n");
  assert.equal(fresh.ready_generation, 2);
});

test("typed scope and bounded graph traverse real canonical links without granting System or Memory authority", async t => {
  const f = await fixture(t);
  const other = "knowledge_000000000000000000000003";
  await writeFile(join(f.data, "notes/Evidence.md"), note.replace("title: Index Evidence",
    `links: [{relation: supports, target: "pkm://knowledge/${other}", mode: floating, required: false}]\ntitle: Index Evidence`));
  await writeFile(join(f.data, "notes/Graph.md"),
    `---\nschema: pkm.knowledge/v1\nknowledgeId: ${other}\nrevision: 1\ntitle: Graph target\n---\nConnected target.\n`);
  await mkdir(join(f.data, "notes/System"));
  await writeFile(join(f.data, "notes/System/Private.md"), "---\nknowledgeId: knowledge_000000000000000000000004\n---\nForbidden secret.\n");
  await writeFile(join(f.data, "notes/Memory.md"), "---\nknowledgeId: knowledge_000000000000000000000005\nmemory: true\n---\nForbidden memory.\n");
  const graph = await f.read("search_knowledge", { query: "Evidence", route: "graph", debug: true });
  assert.equal(graph.ok, true);
  assert(graph.hits.some(hit => hit.source_id === `pkm://knowledge/${other}` && hit.contributing_routes.includes("graph")));
  const scope = await f.read("search_knowledge", {
    query: "Evidence", route: "hybrid", capability_source_ids: [`pkm://knowledge/${id}`], debug: true,
  });
  assert(scope.hits.every(hit => hit.source_id === `pkm://knowledge/${id}`));
  for (const hidden of ["knowledge_000000000000000000000004", "knowledge_000000000000000000000005"])
    assert.equal((await f.read("get_knowledge", { id: hidden })).code, "not-found");
  const results = await f.read("search_knowledge", { query: "Forbidden", debug: true });
  assert.equal(results.hits.length, 0);
  assert(!JSON.stringify(f.rows()).includes("Forbidden"));
});

for (const unsupported of ["subscription", "configured-model", "reused-script-identity"])
test(`unadmitted ${unsupported} corpus fails closed rather than returning misleading unified success`, async t => {
  const f = await fixture(t);
  if (unsupported === "subscription") {
    await mkdir(join(f.data, "subscriptions/cache/node/share"), { recursive: true });
    await writeFile(join(f.data, "subscriptions/cache/node/share/summary.json"), "{}");
  } else if (unsupported === "configured-model") {
    await mkdir(join(f.data, "knowledge-read-config/retrieval"), { recursive: true });
    await writeFile(join(f.data, "knowledge-read-config/retrieval/serving-release.json"), "{}");
  } else {
    await writeFile(join(f.data, "scripts/Tools/.check.py.pkm.json"), JSON.stringify({
      schema: "pkm.script/v1", knowledgeId: "script_000000000000000000000002",
      aliases: ["pkm://scripts/Tools/new.py"],
    }));
    await writeFile(join(f.data, "scripts/Tools/new.py"), "Never allocate a replacement identity silently.");
  }
  await assert.rejects(f.read("search_knowledge", { query: "Evidence" }), /NOT_AVAILABLE|not admitted|Subscriber|Subscription|Subscribed|providers|migration|subscribed/i);
  assert.equal(f.rows().length, 0);
});
