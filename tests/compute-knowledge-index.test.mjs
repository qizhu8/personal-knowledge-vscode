import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ChatMemoryWorker, ComputeError } from "../dist/compute/chat-memory-worker.js";
import {
  KnowledgeIndexError, KnowledgeIndexRebuilder, knowledgeIndexCanonical, knowledgeIndexScope,
  rebuildKnowledgeIndex, recheckKnowledgeIndexSources,
} from "../dist/compute/knowledge-index.js";
import { decodeMarkdown, scanMarkdown } from "../dist/markdown.js";

const server = fileURLToPath(new URL("../", import.meta.url));
const python = process.env.COMPUTE_TEST_PYTHON || execFileSync("python3",
  ["-I", "-S", "-B", "-c", "import sys; print(sys.executable)"], {
    encoding: "utf8", cwd: server, env: { ...process.env, TMPDIR: join(server, "tests"), TEMP: join(server, "tests"), TMP: join(server, "tests") },
  }).trim();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const error = code => value => value instanceof KnowledgeIndexError && value.code === code;
const missing = async path => assert.rejects(access(path), { code: "ENOENT" });
const knowledge = n => `knowledge_${String(n).padStart(24, "0")}`;
const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };

async function fixture(t) {
  const directory = join(server, "tests", `.knowledge-index-${randomUUID()}`);
  const root = join(directory, "markdown");
  await Promise.all(["notes", "skills", "papers"].map(area => mkdir(join(root, area), { recursive: true })));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scope = { partition: "fixture-account/root-1", namespace: "explicit-knowledge" };
  let stage = 0;
  async function document(area, path, id, body, metadata = {}) {
    const raw = `---\n${JSON.stringify({ documentId: id, knowledgeId: knowledge(id.replace(/\D/g, "") || 1),
      revision: 1, title: `${area} source ${id}`, ...metadata })}\n---\n${body}`;
    await writeFile(join(root, area, path), raw);
    return decodeMarkdown(id, raw, path, area);
  }
  function options(documents, extras = {}) {
    const runtimeDirectory = join(directory, `staging-${++stage}`);
    return { root, documents, scope, worker: {
      python, runtimeDirectory, database: join(runtimeDirectory, "index.sqlite3"),
      identity: knowledgeIndexScope(root, scope).workerIdentity, maxPendingRequests: 1,
    }, ...extras };
  }
  const note = await document("notes", "note.md", "doc1", "Authoritative Note 中文 🧠", { tags: ["memory"], nested: { score: 3 } });
  const skill = await document("skills", "skill.md", "doc2", "Run a bounded computation", {
    description: "Skill metadata", triggers: ["rebuild"], links: [
      { relation: "implements", target: `pkm://knowledge/${knowledge(1)}`, mode: "pinned", targetRevision: "1", required: true },
    ],
  });
  const paper = await document("papers", "paper.md", "doc3", "Paper abstract and full body", {
    conclusions: ["Do not invent vectors"], implementation: ["Explicit workers"], assumptions: ["Disposable computation"],
    links: [{ relation: "abstracts", target: `pkm://knowledge/${knowledge(2)}`, mode: "floating", required: true }],
  });
  return { directory, root, scope, document, options, documents: [note, skill, paper] };
}
function intercept(client, methods) {
  return new Proxy(client, { get(target, key) {
    if (key in methods) return methods[key];
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
async function inspect(result, action) {
  const client = await ChatMemoryWorker.open(result.worker);
  try { return await action(client); } finally { await client.close(); }
}

test("transformed knowledge-index provenance is repeatable and has correct source/captured paths", async () => {
  const before = await readFile(join(server, "migration/knowledge-index-provenance.json"));
  const output = execFileSync(process.execPath, [join(server, "scripts/capture-knowledge-index.mjs"), "--check"], {
    encoding: "utf8", cwd: join(server, "tests"),
  });
  assert.match(output, /8 source\/capture hash pairs/);
  assert.deepEqual(await readFile(join(server, "migration/knowledge-index-provenance.json")), before);
  const manifest = JSON.parse(await readFile(join(server, "migration/knowledge-index-provenance.json"), "utf8"));
  const originalSources = [
    "modules/pkm-memory-engine/src/pkm_memory_engine/engine.py",
    "modules/pkm-memory-engine/src/pkm_memory_engine/memory.py",
    "src/memory/chat-memory-service.ts",
    "src/retrieval/retrieval-snapshot.ts",
  ];
  const nativeReferences = [
    "next-server/src/domain/knowledge-contracts.ts",
    "next-server/src/knowledge-snapshot.ts",
    "next-server/src/links.ts",
    "next-server/src/compute/contracts.ts",
  ];
  const nativeWorker = "next-server/src/compute/chat-memory-worker.ts";
  assert.equal(manifest.files.length, 8);
  assert.deepEqual(manifest.files.map(file => file.source).sort(), [...originalSources, ...nativeReferences].sort());
  assert.deepEqual(manifest.files.filter(file => !file.source.startsWith("next-server/")).map(file => file.source), originalSources);
  assert.deepEqual(manifest.files.filter(file => file.source.startsWith("next-server/")).map(file => file.source), nativeReferences);
  assert(!manifest.files.some(file => file.source === nativeWorker));
  assert.match(manifest.transformation, /Reviewed TypeScript bridge, not byte-identical extraction/);
  assert.match(manifest.transformation, /native ChatMemoryWorker is pinned separately and is not represented as an original source capture/);
  assert.deepEqual(manifest.sourceHistory, [{
    source: nativeWorker,
    previousSourceSha256: "1c9023df5d900ad2d7af149c4116cfa7d942bb65439f38f41dc14e4684db9fbf",
    captured: "src/compute/knowledge-index.ts",
    capturedSha256: "5d124574f9923b66ea3f7816f86f4f1fc15dbce97114de51bc8dae878c930e3b",
    supersededIn: "Batch18",
    reason: "This native worker was extended for paired engine backup and restore; the captured hash is an archival Batch18 value, not a claim about the current file. Current bytes are recorded by the active capture and separately pinned as native implementation.",
  }]);
  const nativeQualification = JSON.parse(await readFile(join(server, "migration/native-qualification.json"), "utf8"));
  const workerPins = nativeQualification.native.filter(file => file.file === "src/compute/chat-memory-worker.ts");
  assert.deepEqual(workerPins, [{
    file: "src/compute/chat-memory-worker.ts",
    sha256: "78118937bc28fc2f9e5eb088dd266bcad19903522e6d591b4bf18fa2414468b2",
  }]);
  const nativeV5 = JSON.parse(await readFile(join(server, "migration/compute-native-v5-qualification.json"), "utf8"));
  assert.equal(nativeV5.schema, "pkm.compute-native-qualification/v5");
  assert.equal(nativeV5.scope, "bounded-compute-accounting-fixture-regression-only");
  assert.deepEqual(nativeV5.historicalNative, {
    qualification: "migration/native-qualification.json",
    commit: "709b71263c4d31f6aae6523525c8bc12b2c16535",
    path: nativeWorker,
    blob: "eba61f0d14cd54c0b0514cb0db0196765219bd69",
    archive: "migration/evidence/compute-chat-memory-worker-78118937.ts.txt",
    bytes: 20562,
    sha256: workerPins[0].sha256,
  });
  const historicalWorker = await readFile(join(server, nativeV5.historicalNative.archive));
  assert.equal(hash(historicalWorker), workerPins[0].sha256);
  assert.equal(historicalWorker.length, nativeV5.historicalNative.bytes);
  assert.equal(createHash("sha1").update(`blob ${historicalWorker.length}\0`).update(historicalWorker).digest("hex"),
    nativeV5.historicalNative.blob);
  assert.deepEqual(Buffer.from(new TextDecoder("utf-8", { fatal: true }).decode(historicalWorker)), historicalWorker);
  assert.equal(historicalWorker.at(-1), 10);
  assert.notEqual(workerPins[0].sha256, manifest.sourceHistory[0].previousSourceSha256);
  assert.deepEqual(nativeV5.native.map(pin => pin.file).sort(), [
    "src/compute/chat-memory-worker.ts", "src/compute/memory-accounting.ts",
  ]);
  for (const pin of nativeV5.native) {
    assert.equal(hash(await readFile(join(server, pin.file))), pin.sha256);
  }
  assert.notEqual(nativeV5.native.find(pin => pin.file === workerPins[0].file).sha256, workerPins[0].sha256);
  const { sourceCommit } = JSON.parse(await readFile(join(server, "migration/compute-provenance.json"), "utf8"));
  for (const file of manifest.files) {
    const sourcePath = file.source.startsWith("next-server/")
      ? join(server, file.source.slice("next-server/".length))
      : join(server, "legacy", file.source);
    const source = file.source === "src/retrieval/retrieval-snapshot.ts"
      ? execFileSync("git", ["show", `${sourceCommit}:${file.source}`], { cwd: server })
      : await readFile(sourcePath);
    assert.equal(hash(source), file.sourceSha256);
    assert.equal(hash(await readFile(join(server, file.captured))), file.capturedSha256);
  }
});

test("historical native worker archive verifies without session Git objects", async () => {
  const { historicalNative } = JSON.parse(await readFile(join(server, "migration/compute-native-v5-qualification.json"), "utf8"));
  const original = JSON.parse(await readFile(join(server, historicalNative.qualification), "utf8"));
  const pin = original.native.find(item => item.file === "src/compute/chat-memory-worker.ts");
  const archived = await readFile(join(server, historicalNative.archive));
  const unavailableGit = join(server, "tests", `.absent-archive-git-${randomUUID()}`);
  await missing(unavailableGit);
  const blob = execFileSync("git", ["hash-object", "--no-filters", "--stdin"], {
    cwd: server, input: archived, encoding: "utf8",
    env: { ...process.env, GIT_DIR: unavailableGit, GIT_OBJECT_DIRECTORY: join(unavailableGit, "objects") },
  }).trim();
  assert.equal(blob, historicalNative.blob);
  assert.equal(hash(archived), pin.sha256);
});

test("real persistent rebuild preserves Note/Skill/Paper bodies, metadata, exact pins and directed edges", async t => {
  const f = await fixture(t), options = f.options(f.documents);
  const before = await Promise.all(f.documents.map(item => readFile(join(f.root, item.record.area, item.record.path))));
  const result = await rebuildKnowledgeIndex(options);
  assert.deepEqual(result.artifact.counts, { documents: 3, pieces: 3, statements: 3, sources: 3, edges: 2,
    bytes: result.artifact.counts.bytes });
  assert.equal(result.artifact.state, "validated-staging");
  assert.equal(result.artifact.mode, "rebuild-only");
  assert.equal(result.artifact.databaseSha256, hash(await readFile(result.worker.database)));
  assert.deepEqual(JSON.parse(await readFile(result.artifactPath, "utf8")), result.artifact);
  await recheckKnowledgeIndexSources(result.artifact);
  await inspect(result, async client => {
    assert.equal(client.ready.identity, result.artifact.workerIdentity);
    for (const pin of result.artifact.sourcePins) {
      assert.equal(pin.source.chat, result.artifact.scope);
      assert(pin.piece.startsWith(`${result.artifact.scope}|k|`));
      const page = await client.readPiece({ piece_id: pin.piece, limit: 100 });
      assert.equal(page.piece.kind, "piece");
      assert.equal(page.summary, null);
      const projection = JSON.parse(page.statements.map(item => item.body).join(""));
      const source = f.documents.find(item => item.record.id === pin.documentId);
      assert.equal(projection.body, source.record.content);
      assert.deepEqual(projection.metadata, source.metadata.toJS());
      assert.equal(projection.kind, pin.kind);
      assert.equal(pin.bodySha256, hash(projection.body));
      assert.equal(pin.projectionSha256, hash(knowledgeIndexCanonical(projection)));
      assert.deepEqual(await client.sources({ statement_id: page.statements[0].id }), [pin.source]);
      assert.deepEqual(await client.embedding({ piece_id: pin.piece, space: "never-synthesized" }),
        { piece: pin.piece, embedding: null, status: "unavailable" });
    }
    const note = result.artifact.sourcePins.find(item => item.kind === "note");
    const skill = result.artifact.sourcePins.find(item => item.kind === "skill");
    const paper = result.artifact.sourcePins.find(item => item.kind === "research");
    assert.deepEqual(await client.neighbors({ piece_id: note.piece }), [{ parent: skill.piece, child: note.piece, relation: "implements" }]);
    assert((await client.neighbors({ piece_id: paper.piece })).some(edge => edge.parent === paper.piece && edge.child === skill.piece && edge.relation === "abstracts"));
  });
  const db = new DatabaseSync(result.worker.database);
  try {
    for (const table of ["explicit_memories", "summaries", "piece_embeddings", "turns"]) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
    }
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { db.close(); }
  assert.deepEqual(await Promise.all(f.documents.map(item => readFile(join(f.root, item.record.area, item.record.path)))), before);
});

test("fresh rebuilds are semantically deterministic and receipts are idempotent without duplicate statements", async t => {
  const f = await fixture(t);
  const a = await rebuildKnowledgeIndex(f.options(f.documents));
  const b = await rebuildKnowledgeIndex(f.options([...f.documents].reverse()));
  assert.equal(a.artifact.sourceDigest, b.artifact.sourceDigest);
  assert.equal(a.artifact.contentDigest, b.artifact.contentDigest);
  assert.deepEqual(a.artifact.counts, b.artifact.counts);
  assert.deepEqual(a.artifact.sourcePins, b.artifact.sourcePins);
  await inspect(a, async client => {
    const pin = a.artifact.sourcePins[0];
    const page = await client.readPiece({ piece_id: pin.piece });
    const db = new DatabaseSync(a.worker.database);
    let operation;
    try { operation = db.prepare("SELECT id FROM operations WHERE result LIKE ?").get(`%${page.statements[0].id}%`); }
    finally { db.close(); }
    const params = { piece: pin.piece, statement_id: page.statements[0].id, expected_revision: 0,
      body: page.statements[0].body, status: "observation", sources: [pin.source] };
    const replay = await client.appendStatement(operation.id, params);
    assert.equal(replay.statement_id, page.statements[0].id);
    assert.equal((await client.readPiece({ piece_id: pin.piece })).statements.length, 1);
    await assert.rejects(client.appendStatement(operation.id, { ...params, body: "conflicting retry" }),
      value => value instanceof ComputeError && value.code === "CONFLICT");
  });
});

test("16,000 code-point chunking round-trips astral Unicode and byte-bounded worker pagination", async t => {
  const f = await fixture(t);
  const long = await f.document("notes", "long.md", "doc4", "🧠".repeat(49_900));
  const result = await rebuildKnowledgeIndex(f.options([long]));
  assert(result.artifact.counts.statements >= 4);
  await inspect(result, async client => {
    let after = 0, text = "", pages = 0;
    for (;;) {
      const page = await client.readPiece({ piece_id: result.artifact.sourcePins[0].piece, after, limit: 100 });
      if (!page.statements.length) break;
      text += page.statements.map(item => item.body).join("");
      after = page.next; pages++;
      for (const item of page.statements) assert(Array.from(item.body).length <= 16_000);
    }
    assert(pages > 1);
    assert.equal(JSON.parse(text).body, long.record.content);
  });
});

test("source pins include actual body and all projected metadata even without a revision bump", async t => {
  const f = await fixture(t);
  const a = await rebuildKnowledgeIndex(f.options([f.documents[0]]));
  const changed = await f.document("notes", "note.md", "doc1", "Changed without revision bump", { nested: { score: 4 } });
  const b = await rebuildKnowledgeIndex(f.options([changed]));
  assert.equal(a.artifact.sourcePins[0].revision, b.artifact.sourcePins[0].revision);
  assert.equal(a.artifact.sourcePins[0].piece, b.artifact.sourcePins[0].piece);
  assert.notEqual(a.artifact.sourcePins[0].source.id, b.artifact.sourcePins[0].source.id);
  assert.notEqual(a.artifact.sourceDigest, b.artifact.sourceDigest);
  assert.notEqual(a.artifact.contentDigest, b.artifact.contentDigest);
  await assert.rejects(recheckKnowledgeIndexSources(a.artifact), error("STALE_SOURCE"));
});

test("stale supplied raw/body/metadata and changed disk sources fail before opening a worker", async t => {
  const f = await fixture(t);
  let opened = 0;
  const options = f.options([f.documents[0]], { openWorker: async () => { opened++; throw new Error("not allowed"); } });
  const forged = { ...f.documents[0], record: { ...f.documents[0].record, content: "not the actual raw body" } };
  await assert.rejects(rebuildKnowledgeIndex({ ...options, documents: [forged] }), error("STALE_SOURCE"));
  const forgedMetadata = { ...f.documents[0], metadata: f.documents[0].metadata.clone() };
  forgedMetadata.metadata.set("untracked", "projection mutation");
  await assert.rejects(rebuildKnowledgeIndex({ ...options, documents: [forgedMetadata] }), error("STALE_SOURCE"));
  await writeFile(join(f.root, "notes", "note.md"), `${f.documents[0].raw}\nchanged on disk`);
  await assert.rejects(rebuildKnowledgeIndex(options), error("STALE_SOURCE"));
  assert.equal(opened, 0);
  await missing(options.worker.runtimeDirectory);
});

test("source changes during a real persistent rebuild discard staging, never corrupt an existing live index", async t => {
  const f = await fixture(t), live = await rebuildKnowledgeIndex(f.options([f.documents[0]]));
  const liveBytes = await readFile(live.worker.database);
  const options = f.options([f.documents[0]], { openWorker: async config => {
    const client = await ChatMemoryWorker.open(config);
    return intercept(client, { appendStatement: async (...args) => {
      const result = await client.appendStatement(...args);
      await writeFile(join(f.root, "notes", "note.md"), `${f.documents[0].raw}\nexternal edit`);
      return result;
    } });
  } });
  await assert.rejects(rebuildKnowledgeIndex(options), error("STALE_SOURCE"));
  await missing(options.worker.runtimeDirectory);
  assert.deepEqual(await readFile(live.worker.database), liveBytes);
});

test("stale target pins, required out-of-snapshot targets and abstraction cycles reject atomically", async t => {
  const f = await fixture(t);
  const stale = await f.document("skills", "skill.md", "doc2", "stale", { links: [
    { relation: "implements", target: `pkm://knowledge/${knowledge(1)}`, mode: "pinned", targetRevision: "old", required: true },
  ] });
  const options = f.options([f.documents[0], stale]);
  await assert.rejects(rebuildKnowledgeIndex(options), error("STALE_PIN"));
  await missing(options.worker.runtimeDirectory);
  await assert.rejects(rebuildKnowledgeIndex(f.options([stale])), error("INVALID_ARGUMENT"));
  const cycleNote = await f.document("notes", "note.md", "doc1", "cycle", { links: [
    { relation: "abstracts", target: `pkm://knowledge/${knowledge(3)}`, mode: "floating", required: true },
  ] });
  const cycleSkill = await f.document("skills", "skill.md", "doc2", "cycle", { links: [
    { relation: "abstracts", target: `pkm://knowledge/${knowledge(1)}`, mode: "floating", required: true },
  ] });
  await assert.rejects(rebuildKnowledgeIndex(f.options([cycleNote, cycleSkill, f.documents[2]])), error("INVALID_ARGUMENT"));
});

test("optional unsupported links are explicit warnings, not invented semantic edges", async t => {
  const f = await fixture(t);
  const note = await f.document("notes", "note.md", "doc1", "content", { links: [
    { relation: "cites", target: `pkm://knowledge/${knowledge(3)}`, mode: "floating", required: false },
  ] });
  const result = await rebuildKnowledgeIndex(f.options([note, f.documents[2], f.documents[1]]));
  assert.equal(result.artifact.warnings.length, 1);
  assert.match(result.artifact.warnings[0], /omitted optional cites/);
  assert.equal(result.artifact.counts.edges, 2);
});

test("scope, namespace, root identity and immutable IDs never leak between partitions", async t => {
  const f = await fixture(t), a = await rebuildKnowledgeIndex(f.options([f.documents[0]]));
  const scope = { ...f.scope, partition: "other-account/root-1" };
  const other = f.options([f.documents[0]], { scope });
  other.worker.identity = knowledgeIndexScope(f.root, scope).workerIdentity;
  const b = await rebuildKnowledgeIndex(other);
  assert.notEqual(a.artifact.scope, b.artifact.scope);
  assert.notEqual(a.artifact.sourcePins[0].piece, b.artifact.sourcePins[0].piece);
  assert.notEqual(a.artifact.sourcePins[0].source.id, b.artifact.sourcePins[0].source.id);
  await inspect(a, async client => {
    assert.deepEqual(await client.listPieces({ scope: b.artifact.scope, kind: "piece" }), []);
    await assert.rejects(client.readPiece({ piece_id: b.artifact.sourcePins[0].piece }));
  });
  assert.notEqual(knowledgeIndexScope(f.directory, f.scope).scope, a.artifact.scope);
  for (const partition of ["", "other|scope", "../escape", "a//b", " leading", "a\nb"]) {
    await assert.rejects(rebuildKnowledgeIndex(f.options([f.documents[0]], { scope: { ...f.scope, partition } })), error("INVALID_ARGUMENT"));
  }
  const wrong = f.options([f.documents[0]]);
  wrong.worker.identity = b.artifact.workerIdentity;
  await assert.rejects(rebuildKnowledgeIndex(wrong), error("INVALID_ARGUMENT"));
});

test("staging must be absent and outside root; existing data and symlinks are never removed", async t => {
  const f = await fixture(t), options = f.options([f.documents[0]]);
  await mkdir(options.worker.runtimeDirectory);
  await writeFile(options.worker.database, "live data sentinel");
  await assert.rejects(rebuildKnowledgeIndex(options), error("STAGING_EXISTS"));
  assert.equal(await readFile(options.worker.database, "utf8"), "live data sentinel");
  const nested = f.options([f.documents[0]]);
  nested.worker.runtimeDirectory = join(f.root, "nested");
  nested.worker.database = join(nested.worker.runtimeDirectory, "index.sqlite3");
  await assert.rejects(rebuildKnowledgeIndex(nested), error("INVALID_ARGUMENT"));
  await missing(nested.worker.runtimeDirectory);
  if (process.platform !== "win32") {
    const linked = f.options([f.documents[0]]);
    await symlink(options.worker.runtimeDirectory, linked.worker.runtimeDirectory);
    await assert.rejects(rebuildKnowledgeIndex(linked), error("STAGING_EXISTS"));
    assert.equal(await readFile(options.worker.database, "utf8"), "live data sentinel");
  }
});

test("serial bounded queue rejects overflow and cancels queued jobs without launching or replaying", async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), builder = new KnowledgeIndexRebuilder({ maxPendingRebuilds: 2 });
  let starts = 0;
  const firstOptions = f.options([f.documents[0]], { openWorker: async config => {
    starts++; entered.resolve(); await release.promise; return ChatMemoryWorker.open(config);
  } });
  const first = builder.rebuild(firstOptions);
  await entered.promise;
  const controller = new AbortController();
  const secondOptions = f.options([f.documents[0]], { signal: controller.signal, openWorker: async config => {
    starts++; return ChatMemoryWorker.open(config);
  } });
  const second = builder.rebuild(secondOptions);
  const rejected = assert.rejects(second, error("CANCELLED"));
  await assert.rejects(builder.rebuild(f.options([f.documents[0]])), error("BUSY"));
  controller.abort();
  await rejected;
  release.resolve();
  await first;
  assert.equal(starts, 1);
  await missing(secondOptions.worker.runtimeDirectory);
  const third = await builder.rebuild(f.options([f.documents[0]]));
  assert.equal(third.artifact.state, "validated-staging");
  assert.throws(() => new KnowledgeIndexRebuilder({ maxPendingRebuilds: 9 }), error("INVALID_ARGUMENT"));
});

test("active cancellation closes the actual subprocess, discards owned staging and never resubmits mutations", async t => {
  const f = await fixture(t), controller = new AbortController();
  let appends = 0, starts = 0, client;
  const options = f.options([f.documents[0]], { signal: controller.signal, openWorker: async config => {
    starts++; client = await ChatMemoryWorker.open(config);
    return intercept(client, { appendStatement: async (...args) => {
      appends++;
      const result = await client.appendStatement(...args);
      controller.abort();
      return result;
    } });
  } });
  await assert.rejects(rebuildKnowledgeIndex(options), error("CANCELLED"));
  assert.equal(starts, 1);
  assert.equal(appends, 1);
  assert.equal(client.state, "closed");
  assert.equal(client.processId, undefined);
  await missing(options.worker.runtimeDirectory);
});

test("uncertain committed mutation failure and process death fail closed, clean staging, never auto-replay", async t => {
  const f = await fixture(t);
  let starts = 0, appends = 0, client;
  const options = f.options([f.documents[0]], { openWorker: async config => {
    starts++; client = await ChatMemoryWorker.open(config);
    return intercept(client, { appendStatement: async (...args) => {
      appends++;
      await client.appendStatement(...args);
      process.kill(client.processId, "SIGKILL");
      throw new ComputeError("PROCESS_EXIT", "Outcome uncertain after commit.", "unknown");
    } });
  } });
  await assert.rejects(rebuildKnowledgeIndex(options), value => {
    assert(error("WORKER_FAILED")(value));
    assert.equal(value.cause.outcome, "unknown");
    return true;
  });
  assert.equal(starts, 1); assert.equal(appends, 1);
  assert.equal(client.state, "closed");
  await missing(options.worker.runtimeDirectory);
});

test("worker launch failure removes only owned staging; source remains authoritative", async t => {
  const f = await fixture(t), options = f.options([f.documents[0]]);
  options.worker.python = join(f.directory, "missing-python");
  await assert.rejects(rebuildKnowledgeIndex(options), error("WORKER_FAILED"));
  await missing(options.worker.runtimeDirectory);
  assert.equal(await readFile(join(f.root, "notes", "note.md"), "utf8"), f.documents[0].raw);
});

test("worker validation rejects tampered bodies/pins and wrong identity before publishing any artifact", async t => {
  const f = await fixture(t);
  for (const failure of ["body", "source", "identity"]) {
    let client;
    const options = f.options([f.documents[0]], { openWorker: async config => {
      client = await ChatMemoryWorker.open(config);
      return intercept(client, failure === "identity" ? { ready: { ...client.ready, identity: "other-partition" } } : failure === "body" ? {
        readPiece: async params => {
          const value = await client.readPiece(params);
          if (value.statements.length) value.statements[0].body = "corrupted projection";
          return value;
        },
      } : {
        sources: async params => (await client.sources(params)).map(source => ({ ...source, chat: "other-partition" })),
      });
    } });
    await assert.rejects(rebuildKnowledgeIndex(options), error("VALIDATION_FAILED"));
    assert.equal(client.state, "closed");
    await missing(options.worker.runtimeDirectory);
  }
});

test("optional snapshot-membership fence detects source additions after staging computation", async t => {
  const f = await fixture(t);
  let checks = 0;
  const options = f.options(f.documents, { recheckDocuments: async () => {
    if (++checks === 2) await f.document("notes", "extra.md", "doc4", "new source");
    return scanMarkdown(f.root);
  } });
  await assert.rejects(rebuildKnowledgeIndex(options), error("STALE_SOURCE"));
  assert.equal(checks, 2);
  await missing(options.worker.runtimeDirectory);
});

test("bounded snapshots, duplicate identities and malformed Unicode refuse partial rebuilds", async t => {
  const f = await fixture(t);
  await assert.rejects(rebuildKnowledgeIndex(f.options(Array(129).fill(f.documents[0]))), error("LIMIT"));
  await assert.rejects(rebuildKnowledgeIndex(f.options([f.documents[0], f.documents[0]])), error("INVALID_ARGUMENT"));
  const malformed = { ...f.documents[0], raw: `${f.documents[0].raw}\ud800` };
  await assert.rejects(rebuildKnowledgeIndex(f.options([malformed])), error("LIMIT"));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(rebuildKnowledgeIndex(f.options([], { signal: controller.signal })), error("CANCELLED"));
});

test("empty or deleted explicit snapshots produce a valid empty derivative without inventing state", async t => {
  const f = await fixture(t);
  const deleted = await f.document("notes", "gone.md", "doc4", "Deleted source", { deleted: true });
  const result = await rebuildKnowledgeIndex(f.options([deleted]));
  assert.deepEqual(result.artifact.counts, { documents: 0, pieces: 0, statements: 0, sources: 0, edges: 0, bytes: 0 });
  await inspect(result, async client => assert.deepEqual(await client.usage(), { pieces: 0, bytes: 0 }));
});
