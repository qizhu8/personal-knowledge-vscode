import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile, readdir, rename, symlink, link, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize, Storage } from "../dist/storage.js";
import { admitLegacyRetrievalModel, verifyLegacyRetrievalModels, selectLegacyRetrievalModel,
  inspectLegacyRetrievalModelRecovery, legacyRetrievalPackageArchitectures } from "../dist/legacy-retrieval-model.js";
import { legacyIndexedKnowledgeRead } from "../dist/legacy-retrieval-index.js";
import { LegacyMcpPythonWorker } from "../dist/legacy-mcp-python-worker.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { legacyManagedFixture, closeLegacyManagedFixture } from "./legacy-managed-fixture.mjs";
import { persistLegacyRetrievalLearningGenesis, readLegacyRetrievalLearning,
  verifyLegacyRetrievalLearning } from "../dist/legacy-retrieval-learning.js";
import { planLegacyImport, importLegacyWorkspace } from "../dist/legacy-import.js";
import { inspectLegacyRetrievalHistory } from "../dist/legacy-retrieval-history-import.js";

const root = resolve(import.meta.dirname, ".."), actor = { id: "mcp:external", canWrite: true };
async function fixture(t) {
  const parent = join(root, "tests", `.retrieval-model-${randomUUID()}`), data = join(parent, "workspace");
  await mkdir(parent); await initialize(data);
  await writeFile(join(data, "notes/Evidence.md"), "---\ntitle: Evidence\n---\nReliable evidence alpha model proof.\n");
  const model = JSON.parse(execFileSync("python3", [join(root, "tests/legacy-retrieval-tiny-model.py"), join(parent, "source")],
    { encoding: "utf8", env: { ...process.env, TMPDIR: parent, PYTHONDONTWRITEBYTECODE: "1",
      HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", OMP_NUM_THREADS: "1" } }));
  const storage = await Storage.open(data);
  const worker = new LegacyMcpPythonWorker(join(root, "compat/legacy-knowledge-mcp.py"));
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await worker.close(); await storage.close(); } };
  t.after(async () => { try { await close(); } finally { await rm(parent, { recursive: true, force: true }); } });
  const admit = (extra = {}) => admitLegacyRetrievalModel(storage, actor, {
    sourceRoot: model.root, packageId: model.packageId, authorityId: "test-native-owner", authorize: () => true, ...extra });
  const read = async (tool, args = {}, who = actor) => (await legacyIndexedKnowledgeRead(storage,
    { tool, arguments: args }, undefined, input => worker.execute(input), who)).value;
  const select = extra => selectLegacyRetrievalModel(storage, actor, { packageId: model.packageId,
    authorityId: "test-native-owner", authorize: () => true, ...extra });
  return { parent, data, model, storage, worker, admit, read, select, close };
}
test("actual random offline BERT package admits exact original manifest and executes original semantic search with native model receipts", { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const admitted = await f.admit({ learningEnabled: true });
  assert.equal(admitted.packageId, f.model.packageId);
  const status = await f.read("retrieval_status");
  assert.equal(status.semantic_status, "ready", JSON.stringify(status));
  assert.equal(status.solution.active_package_id, f.model.packageId);
  assert.equal(status.solution.index.persistent, false);
  const result = await f.read("search_knowledge", { query: "model evidence", route: "semantic", debug: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.semantic_status, "ready");
  assert.equal(result.model_invoked, true);
  assert.match(result.retrieval_id, /^[a-f0-9]{48}$/);
  assert(result.hits.length > 0);
  assert.equal(result.online_learning.enabled, true);
  const feedbackArgs = { retrieval_id: result.retrieval_id,
    relevant_source_ids: [result.hits[0].source_id], complete: true, provenance: "model" };
  const learningState = () => {
    const db = f.storage.connectNative();
    try { return JSON.parse(db.prepare("SELECT payload FROM legacy_original_learning_heads").get().payload); }
    finally { db.close(); }
  };
  const oracle = JSON.parse(execFileSync("python3", [join(root, "tests/legacy-retrieval-learning-oracle.py")],
    { input: JSON.stringify({ state: learningState(), feedback: feedbackArgs }), encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", TMPDIR: f.parent } }));
  assert.deepEqual(oracle.connections, [":memory:"]);
  const feedback = await f.read("retrieval_feedback", feedbackArgs);
  assert.deepEqual(feedback, oracle.result);
  assert.deepEqual(learningState(), oracle.state);
  assert.equal(feedback.ok, true, JSON.stringify(feedback));
  assert.equal(feedback.trained, true);
  const duplicate = await f.read("retrieval_feedback", { retrieval_id: result.retrieval_id,
    relevant_source_ids: [result.hits[0].source_id], complete: true, provenance: "model" });
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(f.read("retrieval_feedback", { retrieval_id: result.retrieval_id,
    relevant_source_ids: [], complete: true, provenance: "user" }), /user-judgment authority/);
  await assert.rejects(f.read("retrieval_feedback", { retrieval_id: result.retrieval_id,
    relevant_source_ids: [], complete: true }, { id: "foreign", canWrite: true }), /actor-bound/);
  const database = f.storage.connectNative();
  try {
    assert.equal(verifyLegacyRetrievalModels(database, f.data).active.packageId, f.model.packageId);
    const state = database.prepare("SELECT payload FROM legacy_original_learning_heads").get().payload;
    assert(!state.includes("model evidence"));
    assert(!JSON.stringify(database.prepare("SELECT * FROM legacy_original_learning_receipts").all()).includes(f.model.root));
  } finally { database.close(); }
});

test("all ten original portable architectures execute real offline operators with independent original ranking, scoped filtering and receipt selection CAS", { timeout: 180_000 }, async t => {
  const f = await fixture(t);
  for (const [name, text] of Object.entries({
    Alpha: "# Alpha\n\nAlpha model note evidence.\n\n## Proof\n\nShared alpha proof.\n",
    Beta: "# Beta\n\nBeta remote reliable proof.\n\n## Model\n\nBeta query model.\n",
    Gamma: "# Gamma\n\nGamma evidence script.\n\n## Query\n\nReliable gamma evidence.\n",
  })) await writeFile(join(f.data, `notes/${name}.md`), `---\ntitle: ${name}\n---\n${text}`);
  const originalManifest = JSON.parse(await readFile(join(f.model.root, "manifest.json"), "utf8"));
  let priorReceipt;
  for (const architecture of legacyRetrievalPackageArchitectures) {
    const manifest = { ...originalManifest, architecture, name: `Offline original ${architecture} execution fixture`,
      parameters: { query_prompt: "", document_prompt: "", retained_dimension_ratio: 0.5,
        candidate_tokens: 32, compression_bits: 2 } };
    const identity = execFileSync("python3", ["-c", "import hashlib,json,sys;print(hashlib.sha256(json.dumps(json.load(sys.stdin),sort_keys=True,ensure_ascii=False,allow_nan=False).encode()).hexdigest())"],
      { input: JSON.stringify(manifest), encoding: "utf8" }).trim();
    const source = join(f.parent, identity);
    await cp(f.model.root, source, { recursive: true, errorOnExist: true });
    await writeFile(join(source, "manifest.json"), JSON.stringify(manifest));
    await f.admit({ sourceRoot: source, packageId: identity, learningEnabled: false });
    if (priorReceipt) await assert.rejects(f.read("retrieval_feedback", {
      retrieval_id: priorReceipt, relevant_source_ids: [], complete: true,
    }), /model selection changed/);
    let input;
    const result = await legacyIndexedKnowledgeRead(f.storage, {
      tool: "search_knowledge", arguments: { query: "model evidence", route: "semantic", debug: true, limit: 20 },
    }, undefined, request => { input = request; return f.worker.execute(request); }, actor);
    assert.equal(result.value.model_invoked, true, architecture);
    assert.equal(result.value.semantic_status, "ready", architecture);
    assert.match(result.value.retrieval_id, /^[a-f0-9]{48}$/);
    priorReceipt = result.value.retrieval_id;
    const oracle = args => JSON.parse(execFileSync("python3", [join(root, "tests/legacy-retrieval-architecture-oracle.py")], {
      input: JSON.stringify({ snapshot: input.retrievalSnapshot, model: input.retrievalModel, query: "model evidence", ...args }),
      encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", TMPDIR: f.parent, OMP_NUM_THREADS: "1",
        HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_DATASETS_OFFLINE: "1" },
    }));
    const expected = oracle({});
    assert.deepEqual(expected.architectures, [...legacyRetrievalPackageArchitectures].sort());
    assert.deepEqual(result.value.hits.map(({ source_id, score, rank }) => ({ source_id, score, rank })), expected.hits, architecture);
    if (architecture.includes("pca")) assert(expected.pcaComponents > 0, architecture);
    if (architecture.includes("late-interaction")) assert(expected.tokenVectors > 0, architecture);
    const scope = result.value.hits.slice(-2).map(hit => hit.source_id);
    const scoped = await f.read("search_knowledge", { query: "model evidence", route: "semantic", debug: true,
      limit: 20, capability_source_ids: scope });
    assert.equal(scoped.model_invoked, true, architecture);
    assert.deepEqual(scoped.hits.map(({ source_id, score, rank }) => ({ source_id, score, rank })), oracle({ scope }).hits, `${architecture} scoped`);
    const status = await f.read("retrieval_status");
    assert.equal(status.solution.active_package_id, identity);
  }
});

test("exact original frozen Skill release admits evaluated corpus/config/weights without rewriting identity and executes after source removal/relocation", { timeout: 180_000 }, async t => {
  const f = await fixture(t);
  await mkdir(join(f.data, "skills"));
  await writeFile(join(f.data, "skills/Evidence.md"),
    "---\nname: Evidence Skill\ndescription: Model evidence skill\n---\n# Evidence\n\nReliable alpha model skill proof.\n");
  let input;
  await legacyIndexedKnowledgeRead(f.storage, { tool: "retrieval_status", arguments: {} }, undefined, request => {
    input = request; return f.worker.execute(request);
  }, actor);
  const originalBytes = execFileSync("python3", [join(root, "tests/legacy-retrieval-frozen-fixture.py")],
    { input: JSON.stringify({ root: f.model.root, snapshot: input.retrievalSnapshot }), encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", TMPDIR: f.parent, OMP_NUM_THREADS: "1",
        HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_DATASETS_OFFLINE: "1" } }).trim();
  const envelope = JSON.parse(originalBytes);
  const release = join(f.parent, "serving-release.json");
  for (const attack of ["digest", "corpus", "weights", "model-path"]) {
    const changed = execFileSync("python3", ["-c", `
import hashlib,json,sys
value=json.load(sys.stdin);attack=sys.argv[1]
if attack=="corpus":value["release"]["validation"]["corpus_revision"]="f"*64
if attack=="weights":value["release"]["weights"]["unauthorized-route"]=1
if attack=="model-path":value["release"]["config"]["model"]="/not-an-authorized-model"
value["sha256"]=hashlib.sha256(json.dumps(value["release"],sort_keys=True,ensure_ascii=False).encode()).hexdigest() if attack!="digest" else "0"*64
print(json.dumps(value,ensure_ascii=False))
`, attack], { input: originalBytes, encoding: "utf8" });
    await writeFile(release, changed);
    await assert.rejects(f.admit({ frozenReleaseFile: release }), attack);
    const db = f.storage.connectNative();
    try { assert.equal(verifyLegacyRetrievalModels(db, f.data).packages.length, 0); } finally { db.close(); }
  }
  await writeFile(release, originalBytes);
  await f.admit({ frozenReleaseFile: release, learningEnabled: true });
  const found = await f.read("search_knowledge", { query: "model evidence", route: "semantic", debug: true });
  assert.equal(found.model_invoked, true, JSON.stringify(found));
  assert.equal(found.semantic_status, "ready");
  assert.equal(found.skill_serving.release_id, envelope.sha256);
  assert(found.hits.every(hit => hit.content_type === "skill"));
  assert.match(found.retrieval_id, /^[a-f0-9]{48}$/);
  await t.test("original frozen release plus partial predecessor learner imports with bound configuration and relocated native model receipts", async () => {
    const source = join(f.parent, "frozen-original-source"), originalState = join(f.parent, "frozen-original-state");
    await mkdir(join(source, "skills"), { recursive: true }); await mkdir(join(source, "notes"));
    await mkdir(join(originalState, "solutions"), { recursive: true });
    await writeFile(join(source, "skills/Evidence.md"), await readFile(join(f.data, "skills/Evidence.md")));
    await cp(f.model.root, join(originalState, "solutions", f.model.packageId), { recursive: true });
    await writeFile(join(originalState, "solution-selection.json"), JSON.stringify({ schema: 1, package_id: f.model.packageId }));
    const originalRelease = execFileSync("python3", ["-c", `
import hashlib,json,sys
value=json.load(sys.stdin);value["release"]["config"]["model"]=sys.argv[1]
value["sha256"]=hashlib.sha256(json.dumps(value["release"],sort_keys=True,ensure_ascii=False).encode()).hexdigest()
print(json.dumps(value,ensure_ascii=False))
`, join(originalState, "solutions", f.model.packageId, "model")], { input: originalBytes, encoding: "utf8" }).trim();
    await writeFile(join(originalState, "serving-release.json"), originalRelease);
    const db = f.storage.connectNative();
    let history;
    try { history = readLegacyRetrievalLearning(db, { actorId: actor.id, workspaceId: await f.storage.workspaceId() }).state; }
    finally { db.close(); }
    execFileSync("python3", [join(root, "tests/legacy-retrieval-history-fixture.py"), originalState], {
      input: JSON.stringify({ state: history, predecessor: true }), encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", TMPDIR: f.parent },
    });
    const sourceDb = await readFile(join(originalState, "retrieval-learning.sqlite3"));
    const plan = await planLegacyImport(source, {}, { retrievalHistory: { stateRoot: originalState, actorId: actor.id } });
    assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
    const target = join(f.parent, "frozen-imported"), relocated = join(f.parent, "frozen-imported-relocated"), backup = join(f.parent, "frozen-imported-backup");
    const pythonExecutable = execFileSync("python3", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
    const approve = request => ({ actorId: request.actorId, decisionId: "test-original-frozen-import" });
    for (const attack of ["digest", "foreign-model", "corpus"]) {
      const changed = execFileSync("python3", ["-c", `
import hashlib,json,sys
value=json.load(sys.stdin);attack=sys.argv[1]
if attack=="foreign-model":value["release"]["config"]["model"]="/foreign/model"
if attack=="corpus":value["release"]["validation"]["corpus_revision"]="f"*64
value["sha256"]=hashlib.sha256(json.dumps(value["release"],sort_keys=True,ensure_ascii=False).encode()).hexdigest() if attack!="digest" else "0"*64
print(json.dumps(value,ensure_ascii=False))
`, attack], { input: originalRelease, encoding: "utf8" });
      await writeFile(join(originalState, "serving-release.json"), changed);
      const denied = await planLegacyImport(source, {}, { retrievalHistory: { stateRoot: originalState, actorId: actor.id } });
      assert.equal(denied.ready, false, `${attack}: ${JSON.stringify(denied.blockers)}`);
      await assert.rejects(readdir(target), { code: "ENOENT" });
    }
    await writeFile(join(originalState, "serving-release.json"), originalRelease);
    await assert.rejects(importLegacyWorkspace(plan, target, { pythonExecutable,
      authorizeRetrievalHistory: async request => {
        await writeFile(join(originalState, "serving-release.json"), `${originalRelease}\n`);
        return approve(request);
      } }));
    await assert.rejects(readdir(target), { code: "ENOENT" });
    await writeFile(join(originalState, "serving-release.json"), originalRelease);
    const skill = join(source, "skills/Evidence.md"), skillBytes = await readFile(skill);
    await writeFile(skill, `${skillBytes.toString()}\nUnexpected corpus modification.\n`);
    const incompatible = await planLegacyImport(source, {}, { retrievalHistory: { stateRoot: originalState, actorId: actor.id } });
    assert.equal(incompatible.ready, true, JSON.stringify(incompatible.blockers));
    await assert.rejects(importLegacyWorkspace(incompatible, target, { pythonExecutable, authorizeRetrievalHistory: approve }),
      /frozen|corpus|compatible/i);
    await assert.rejects(readdir(target), { code: "ENOENT" });
    await writeFile(skill, skillBytes);
    const restoredPlan = await planLegacyImport(source, {}, { retrievalHistory: { stateRoot: originalState, actorId: actor.id } });
    assert.equal(restoredPlan.ready, true, JSON.stringify(restoredPlan.blockers));
    await importLegacyWorkspace(restoredPlan, target, { pythonExecutable,
      authorizeRetrievalHistory: approve });
    let storage = await Storage.open(target), native = await createNativeRuntime({ storage });
    let worker = new LegacyMcpPythonWorker(join(root, "compat/legacy-knowledge-mcp.py"));
    const read = async (tool, args) => (await legacyIndexedKnowledgeRead(storage, { tool, arguments: args }, undefined,
      request => worker.execute(request), actor)).value;
    try {
      const current = await read("search_knowledge", { query: "evidence", route: "semantic" });
      assert.equal(current.model_invoked, true, JSON.stringify(current));
      assert.equal(current.skill_serving.release_id, JSON.parse(originalRelease).sha256);
      await assert.rejects(read("retrieval_feedback", { retrieval_id: found.retrieval_id,
        relevant_source_ids: [], complete: true }), /actor-bound model receipt/);
      await worker.close(); await native.close(); await storage.close();
      storage = await Storage.open(target); native = await createNativeRuntime({ storage });
      worker = new LegacyMcpPythonWorker(join(root, "compat/legacy-knowledge-mcp.py"));
      assert.equal((await read("search_knowledge", { query: "evidence", route: "semantic" })).model_invoked, true);
      assert.deepEqual(await readFile(join(originalState, "retrieval-learning.sqlite3")), sourceDb);
      assert.equal(await readFile(join(originalState, "serving-release.json"), "utf8"), originalRelease);
      await rm(originalState, { recursive: true }); await rm(source, { recursive: true });
      await createWorkspaceBackup(storage, backup, { acquireQuiescence: native.acquireWorkspaceQuiescence });
      await worker.close(); await native.close(); await storage.close();
      await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority });
      storage = await Storage.open(relocated); native = await createNativeRuntime({ storage });
      worker = new LegacyMcpPythonWorker(join(root, "compat/legacy-knowledge-mcp.py"));
      assert.equal((await read("search_knowledge", { query: "evidence", route: "semantic" })).model_invoked, true);
      assert.equal((await read("retrieval_feedback", { retrieval_id: current.retrieval_id,
        relevant_source_ids: [current.hits[0].source_id], complete: true })).ok, true);
    } finally { await worker.close(); await native.close(); await storage.close(); }
  });
  await rm(f.model.root, { recursive: true }); await rm(release);
  assert.equal((await f.read("search_knowledge", { query: "evidence", route: "semantic" })).model_invoked, true);
  const db = f.storage.connectNative();
  try {
    const stored = db.prepare("SELECT * FROM legacy_retrieval_frozen_releases").get();
    assert.equal(stored.envelope_json, originalBytes);
    assert.equal(stored.release_id, envelope.sha256);
    assert.throws(() => db.exec("DELETE FROM legacy_retrieval_frozen_releases"), /immutable model admission/);
  } finally { db.close(); }
  const native = await createNativeRuntime({ storage: f.storage }), backup = join(f.parent, "frozen-backup"), relocated = join(f.parent, "frozen-relocated");
  try { await createWorkspaceBackup(f.storage, backup, { acquireQuiescence: native.acquireWorkspaceQuiescence }); }
  finally { await native.close(); }
  await f.close();
  await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority });
  const storage = await Storage.open(relocated), worker = new LegacyMcpPythonWorker(join(root, "compat/legacy-knowledge-mcp.py"));
  const read = async (tool, args) => (await legacyIndexedKnowledgeRead(storage, { tool, arguments: args }, undefined,
    request => worker.execute(request), actor)).value;
  try {
    const response = await read("search_knowledge", { query: "evidence", route: "semantic" });
    assert.equal(response.model_invoked, true);
    assert.equal(response.skill_serving.release_id, envelope.sha256);
    assert.equal((await read("retrieval_feedback", { retrieval_id: found.retrieval_id,
      relevant_source_ids: [found.hits[0].source_id], complete: true, provenance: "model" })).ok, true);
    await writeFile(join(relocated, "skills/Evidence.md"), "---\nname: Evidence Skill\n---\nChanged skill corpus.\n");
    await assert.rejects(read("search_knowledge", { query: "evidence", route: "semantic" }), /Frozen release no longer matches/);
    const damaged = storage.connectNative();
    try { damaged.exec("DROP TABLE legacy_retrieval_frozen_releases"); } finally { damaged.close(); }
    await assert.rejects(read("retrieval_status", {}), /no immutable release admission/);
  } finally { await worker.close(); await storage.close(); }
  await assert.rejects(Storage.open(relocated), /no immutable release admission/);
});

test("admitted model with unavailable runtime dependency explicitly refuses rather than serving lexical success", { timeout: 120_000 }, async t => {
  const f = await fixture(t); await f.admit({ learningEnabled: true });
  const unavailable = new LegacyMcpPythonWorker(join(root, "tests/legacy-retrieval-no-model-deps.py"));
  try {
    await assert.rejects(legacyIndexedKnowledgeRead(f.storage, {
      tool: "search_knowledge", arguments: { query: "model evidence", route: "semantic" },
    }, undefined, input => unavailable.execute(input), actor), /failed to execute.*missing sentence_transformers/);
    const db = f.storage.connectNative();
    try {
      assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_original_learning_heads'").get(), undefined);
      assert.equal(db.prepare("SELECT count(*) AS count FROM legacy_retrieval_corpus").get().count, 0);
    } finally { db.close(); }
  } finally { await unavailable.close(); }
});

test("native admission rejects symlink/hardlink/code members and final source races without publishing authority", { timeout: 120_000 }, async t => {
  const f = await fixture(t), config = join(f.model.root, "model/config.json"), bytes = await readFile(config);
  for (const kind of ["symlink", "hardlink", "code", "race"]) {
    if (kind === "symlink") { await rename(config, join(f.parent, "config.json")); await symlink(join(f.parent, "config.json"), config); }
    if (kind === "hardlink") await link(config, join(f.parent, "linked-config.json"));
    if (kind === "code") await writeFile(join(f.model.root, "model/attack.py"), "raise RuntimeError('must never execute')\n");
    let authorizations = 0;
    await assert.rejects(f.admit({ authorize: () => {
      if (kind === "race" && ++authorizations === 2) writeFileSync(config, "changed during native final authorization");
      return true;
    } }), kind);
    if (kind === "symlink") { await rm(config); await rename(join(f.parent, "config.json"), config); }
    if (kind === "hardlink") await rm(join(f.parent, "linked-config.json"));
    if (kind === "code") await rm(join(f.model.root, "model/attack.py"));
    if (kind === "race") await writeFile(config, bytes);
    const db = f.storage.connectNative();
    try { assert.equal(verifyLegacyRetrievalModels(db, f.data).packages.length, 0); }
    finally { db.close(); }
  }
  await f.admit();
});

test("native selection grants bind exact user/model precedence and source/model CAS without retaining raw query", { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.admit({ authorize: () => false }), /admission authority/);
  let authorizations = 0;
  await assert.rejects(f.admit({ authorize: () => ++authorizations === 1 }), /revoked/);
  await f.admit({ learningEnabled: true, userFeedback: true });
  const query = await f.read("search_knowledge", { query: "private raw model evidence", route: "dual", debug: true });
  assert.equal(query.model_invoked, true);
  const args = { retrieval_id: query.retrieval_id, relevant_source_ids: [query.hits[0].source_id], complete: true };
  assert.equal((await f.read("retrieval_feedback", { ...args, provenance: "user" })).ok, true);
  const lower = await f.read("retrieval_feedback", { ...args, provenance: "model" });
  assert.equal(lower.ok, true);
  assert.equal(lower.ignored, true);
  assert.equal(lower.reason, "user-precedence");
  const incomplete = await f.read("retrieval_feedback", { ...args, complete: false });
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.error, /complete/);
  await writeFile(join(f.data, "notes/Evidence.md"), "---\ntitle: Evidence\n---\nChanged native source evidence.\n");
  await assert.rejects(f.read("retrieval_feedback", args), /source corpus/);
  const fresh = await f.read("search_knowledge", { query: "model evidence", route: "semantic" });
  await f.select({ learningEnabled: false });
  await assert.rejects(f.read("retrieval_feedback", { ...args, retrieval_id: fresh.retrieval_id }), /model selection changed/);
  const disabled = await f.read("search_knowledge", { query: "evidence", route: "semantic" });
  assert.match(disabled.retrieval_id, /^[a-f0-9]{48}$/);
  assert.equal((await f.read("retrieval_feedback", { ...args, retrieval_id: disabled.retrieval_id })).error,
    "Online retrieval learning is disabled");
  await assert.rejects(f.select({ packageId: "f".repeat(64) }), /admitted native package/);
  await f.select({ packageId: null });
  const revoked = await f.read("search_knowledge", { query: "model evidence", route: "semantic" });
  assert.notEqual(revoked.model_invoked, true);
  assert.equal(revoked.retrieval_id, null);
  await assert.rejects(f.read("retrieval_feedback", args), /current admitted native model selection/);
});

test("admitted model package verifies full empty-directory membership, missing member and bytes before execution or backup", { timeout: 120_000 }, async t => {
  const f = await fixture(t); await f.admit();
  const packageRoot = join(f.data, "packages/retrieval-models", f.model.packageId);
  const native = await createNativeRuntime({ storage: f.storage });
  try {
    for (const attack of ["empty-directory", "bytes", "missing"]) {
      const file = join(packageRoot, "model/config.json"), original = await readFile(file);
      if (attack === "empty-directory") await mkdir(join(packageRoot, "model/unknown-empty-directory"));
      if (attack === "bytes") await writeFile(file, "tampered");
      if (attack === "missing") await rename(file, join(f.parent, "saved-config.json"));
      await assert.rejects(f.read("search_knowledge", { query: "evidence", route: "semantic" }), /membership or bytes changed/);
      await assert.rejects(createWorkspaceBackup(f.storage, join(f.parent, `deny-${attack}`),
        { acquireQuiescence: native.acquireWorkspaceQuiescence }), /membership or bytes changed/);
      if (attack === "empty-directory") await rm(join(packageRoot, "model/unknown-empty-directory"), { recursive: true });
      if (attack === "bytes") await writeFile(file, original);
      if (attack === "missing") await rename(join(f.parent, "saved-config.json"), file);
    }
  } finally { await native.close(); }
  await f.close();
  for (const attack of ["empty-directory", "bytes", "missing", "deleted-package"]) {
    const file = join(packageRoot, "model/config.json"), original = await readFile(file);
    if (attack === "empty-directory") await mkdir(join(packageRoot, "model/unknown-empty-directory"));
    if (attack === "bytes") await writeFile(file, "tampered");
    if (attack === "missing") await rename(file, join(f.parent, "saved-config.json"));
    if (attack === "deleted-package") await rename(packageRoot, join(f.parent, f.model.packageId));
    await assert.rejects(Storage.open(f.data), attack === "deleted-package" ? /missing or incomplete/ : /membership or bytes changed/);
    if (attack === "empty-directory") await rm(join(packageRoot, "model/unknown-empty-directory"), { recursive: true });
    if (attack === "bytes") await writeFile(file, original);
    if (attack === "missing") await rename(join(f.parent, "saved-config.json"), file);
    if (attack === "deleted-package") await rename(join(f.parent, f.model.packageId), packageRoot);
  }
});

test("model execution never publishes source/model-raced receipts and corrupt native learning blocks startup/backup", { timeout: 120_000 }, async t => {
  const f = await fixture(t); await f.admit({ learningEnabled: true });
  const config = join(f.data, "packages/retrieval-models", f.model.packageId, "model/config.json"), configBytes = await readFile(config);
  for (const race of ["source", "model"]) {
    await assert.rejects(legacyIndexedKnowledgeRead(f.storage, {
      tool: "search_knowledge", arguments: { query: "private proof query", route: "semantic" },
    }, undefined, async input => {
      const result = await f.worker.execute(input);
      if (race === "source") await writeFile(join(f.data, "notes/Evidence.md"), "---\ntitle: Evidence\n---\nChanged native source evidence.\n");
      else await writeFile(config, "{}");
      return result;
    }, actor), race === "source" ? /sources changed/ : /membership or bytes changed/);
    if (race === "model") await writeFile(config, configBytes);
    const db = f.storage.connectNative();
    try { assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_original_learning_heads'").get(), undefined); }
    finally { db.close(); }
  }
  const found = await f.read("search_knowledge", { query: "evidence", route: "semantic" });
  assert.match(found.retrieval_id, /^[a-f0-9]{48}$/);
  const native = await createNativeRuntime({ storage: f.storage });
  const db = f.storage.connectNative();
  try {
    assert.throws(() => db.exec("DELETE FROM legacy_original_learning_receipts"), /immutable original learning/);
    db.exec("UPDATE legacy_original_learning_heads SET payload='{}'");
  } finally { db.close(); }
  await assert.rejects(f.read("retrieval_status"), /head differs/);
  try {
    await assert.rejects(createWorkspaceBackup(f.storage, join(f.parent, "deny-learning-corruption"),
      { acquireQuiescence: native.acquireWorkspaceQuiescence }), /head differs/);
  } finally { await native.close(); }
  await f.close();
  await assert.rejects(Storage.open(f.data), /head differs/);
});

test("exact original historical learner genesis preserves salt/user authority without manufacturing feedback envelopes and continues native model calls", { timeout: 120_000 }, async t => {
  const f = await fixture(t); await f.admit({ learningEnabled: true, userFeedback: true });
  await writeFile(join(f.data, "notes/Evidence.md"),
    "---\ntitle: Evidence\ncreated: 2026-01-02T03:04:05.000Z\n---\nReliable evidence alpha model proof.\n");
  const query = await f.read("search_knowledge", { query: "private model evidence", route: "semantic" });
  const feedbackArgs = { retrieval_id: query.retrieval_id, relevant_source_ids: [query.hits[0].source_id], complete: true, provenance: "user" };
  assert.equal((await f.read("retrieval_feedback", feedbackArgs)).ok, true);
  let historical;
  const original = f.storage.connectNative();
  try { historical = readLegacyRetrievalLearning(original, { actorId: actor.id, workspaceId: await f.storage.workspaceId() }).state; }
  finally { original.close(); }
  assert(historical.calls.length > 0);
  assert(historical.query_judgments.length > 0);
  const target = join(f.parent, "historical-successor");
  await initialize(target);
  await writeFile(join(target, "notes/Evidence.md"), await readFile(join(f.data, "notes/Evidence.md")));
  const storage = await Storage.open(target), worker = new LegacyMcpPythonWorker(join(root, "compat/legacy-knowledge-mcp.py"));
  const db = storage.connectNative(), workspaceId = await storage.workspaceId();
  try {
    await admitLegacyRetrievalModel(storage, actor, {
      sourceRoot: f.model.root, packageId: f.model.packageId, authorityId: "test-bound-import-approval", authorize: () => true,
      learningEnabled: true, userFeedback: true,
    });

    for (const predecessor of [false, true])
    await t.test(`actual original ${predecessor ? "partial predecessor" : "current"} selected-model state and historical user judgments import atomically, execute native receipts and survive restart/relocated backup`, { timeout: 120_000 }, async t => {
      const f = await fixture(t);
      await writeFile(join(f.data, "notes/Evidence.md"),
        "---\ntitle: Evidence\ncreated: 2026-01-02T03:04:05.000Z\n---\nReliable evidence alpha model proof.\n");
      await f.admit({ learningEnabled: true, userFeedback: true });
      const originalQuery = await f.read("search_knowledge", { query: "private original model query", route: "semantic" });
      await f.read("retrieval_feedback", { retrieval_id: originalQuery.retrieval_id,
        relevant_source_ids: [originalQuery.hits[0].source_id], complete: true, provenance: "user" });
      const nativeDb = f.storage.connectNative();
      let state;
      try { state = readLegacyRetrievalLearning(nativeDb, { actorId: actor.id, workspaceId: await f.storage.workspaceId() }).state; }
      finally { nativeDb.close(); }
      const source = join(f.parent, "original-source"), originalState = join(f.parent, "original-state");
      await mkdir(join(source, "notes"), { recursive: true }); await mkdir(join(originalState, "solutions"), { recursive: true });
      await writeFile(join(source, "notes/Evidence.md"), await readFile(join(f.data, "notes/Evidence.md")));
      await cp(f.model.root, join(originalState, "solutions", f.model.packageId), { recursive: true });
      const inactiveManifest = { ...JSON.parse(await readFile(join(f.model.root, "manifest.json"), "utf8")),
        name: "Original inactive dense-document fixture", architecture: "dense-document" };
      const inactiveId = execFileSync("python3", ["-c", "import hashlib,json,sys;print(hashlib.sha256(json.dumps(json.load(sys.stdin),sort_keys=True,ensure_ascii=False,allow_nan=False).encode()).hexdigest())"],
        { input: JSON.stringify(inactiveManifest), encoding: "utf8" }).trim();
      await cp(f.model.root, join(originalState, "solutions", inactiveId), { recursive: true });
      await writeFile(join(originalState, "solutions", inactiveId, "manifest.json"), JSON.stringify(inactiveManifest));
      await writeFile(join(originalState, "solution-selection.json"), JSON.stringify({ schema: 1, package_id: f.model.packageId }));
      execFileSync("python3", ["-c", `
    import ast,hashlib,json,math,os,re,secrets,sqlite3,sys,threading
    from pathlib import Path
    node,=[n for n in ast.parse(Path("resources/retrieval_solutions.py").read_text()).body if isinstance(n,ast.ClassDef) and n.name=="RetrievalLearning"]
    exec(compile(ast.Module(body=[node],type_ignores=[]),"<actual-original-source-history-fixture>","exec"))
    learner=RetrievalLearning(Path(sys.argv[1]))
    with learner.connect() as db:
     for name,rows in json.load(sys.stdin).items():
      assert name in {"settings","models","calls","query_judgments"}
      db.execute("DELETE FROM "+name)
      if rows:db.executemany("INSERT INTO "+name+" VALUES ("+",".join("?" for _ in rows[0])+")",rows)
    `.replace(/^ {4}/gm, ""), originalState], { cwd: resolve(root, ".."), input: JSON.stringify(state), encoding: "utf8",
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", TMPDIR: f.parent } });
      if (predecessor) execFileSync("python3", ["-c", `
import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
 for table,width in [("models",11),("calls",14)]:
  names=[row[1] for row in db.execute("PRAGMA table_info("+table+")")]
  for column in reversed(names[width:]):db.execute("ALTER TABLE "+table+" DROP COLUMN "+column)
 db.execute("DELETE FROM settings WHERE key='learner_version'")
`, join(originalState, "retrieval-learning.sqlite3")], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
      const originalSnapshot = await inspectLegacyRetrievalHistory(join(originalState, "retrieval-learning.sqlite3"));
      const originalBytes = await readFile(join(originalState, "retrieval-learning.sqlite3"));
      const target = join(f.parent, "imported-successor"), relocated = join(f.parent, "history-relocated"), backup = join(f.parent, "history-backup");
      const plan = await planLegacyImport(source, {}, { retrievalHistory: { stateRoot: originalState, actorId: actor.id } });
      assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
      assert.equal(JSON.stringify(plan).includes("private original model query"), false);
      const pythonExecutable = execFileSync("python3", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
      await importLegacyWorkspace(plan, target, { pythonExecutable, authorizeRetrievalHistory: request => {
        assert.equal(request.selectedPackageId, f.model.packageId);
        assert.equal(request.sourceSha256, plan.retrievalHistoryPlan.source.sha256);
        return { actorId: request.actorId, decisionId: "test-real-selected-original-history" };
      } });
      let storage = await Storage.open(target), native = await createNativeRuntime({ storage });
      let worker = new LegacyMcpPythonWorker(join(root, "compat/legacy-knowledge-mcp.py"));
      const read = async (tool, args) => (await legacyIndexedKnowledgeRead(storage, { tool, arguments: args }, undefined,
        input => worker.execute(input), actor)).value;
      let successor;
      try {
        const db = storage.connectNative();
        try {
          assert.deepEqual(readLegacyRetrievalLearning(db, { actorId: actor.id, workspaceId: await storage.workspaceId() }).state, originalSnapshot.state);
          const models = verifyLegacyRetrievalModels(db, target);
          assert.equal(models.active.packageId, f.model.packageId);
          assert.deepEqual(models.packages.map(row => row.package_id).sort(), [f.model.packageId, inactiveId].sort());
          assert.equal(db.prepare("SELECT count(*) AS count FROM legacy_original_learning_receipts").get().count, 0);
        } finally { db.close(); }
        await assert.rejects(read("retrieval_feedback", { retrieval_id: originalQuery.retrieval_id,
          relevant_source_ids: [], complete: true }), /actor-bound model receipt/);
        successor = await read("search_knowledge", { query: "private original model query", route: "semantic" });
        assert.equal(successor.model_invoked, true);
        assert.match(successor.retrieval_id, /^[a-f0-9]{48}$/);
        const dbAfter = storage.connectNative();
        try {
          const current = readLegacyRetrievalLearning(dbAfter, { actorId: actor.id, workspaceId: await storage.workspaceId() }).state;
          assert.equal(current.settings.find(row => row[0] === "salt")[1], state.settings.find(row => row[0] === "salt")[1]);
          assert.equal(current.calls.length, state.calls.length + 1);
          assert.equal(current.query_judgments.length, state.query_judgments.length);
        } finally { dbAfter.close(); }
        await createWorkspaceBackup(storage, backup, { acquireQuiescence: native.acquireWorkspaceQuiescence });
        await worker.close(); await native.close(); await storage.close();
        await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority });
        storage = await Storage.open(relocated); native = await createNativeRuntime({ storage });
        worker = new LegacyMcpPythonWorker(join(root, "compat/legacy-knowledge-mcp.py"));
        const result = await read("retrieval_feedback", { retrieval_id: successor.retrieval_id,
          relevant_source_ids: [successor.hits[0].source_id], complete: true, provenance: "model" });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal((await read("search_knowledge", { query: "evidence", route: "semantic" })).model_invoked, true);
        assert.deepEqual(await readFile(join(originalState, "retrieval-learning.sqlite3")), originalBytes);
        assert(!JSON.stringify(await readdir(relocated)).includes("retrieval-learning.sqlite3"));
      } finally { await worker.close(); await native.close(); await storage.close(); }
      const disabledState = join(f.parent, "original-disabled-state"), disabledTarget = join(f.parent, "disabled-successor");
      await cp(originalState, disabledState, { recursive: true });
      await writeFile(join(disabledState, "solution-selection.json"), JSON.stringify({ schema: 1, package_id: null }));
      const disabledPlan = await planLegacyImport(source, {}, { retrievalHistory: { stateRoot: disabledState, actorId: actor.id } });
      assert.equal(disabledPlan.ready, true, JSON.stringify(disabledPlan.blockers));
      await importLegacyWorkspace(disabledPlan, disabledTarget, { pythonExecutable,
        authorizeRetrievalHistory: request => ({ actorId: request.actorId, decisionId: "test-disabled-original-history" }) });
      const disabled = await Storage.open(disabledTarget), disabledDb = disabled.connectNative();
      try {
        const models = verifyLegacyRetrievalModels(disabledDb, disabledTarget);
        assert.equal(models.active, undefined);
        assert.equal(models.selection.package_id, null);
        assert.equal(models.packages.length, 2);
        assert.deepEqual(readLegacyRetrievalLearning(disabledDb, { actorId: actor.id, workspaceId: await disabled.workspaceId() }).state,
          originalSnapshot.state);
      } finally { disabledDb.close(); await disabled.close(); }
    });
    const request = { workspaceId, actorId: actor.id, sourceSha256: "1".repeat(64), approvalId: "test-bound-import-approval",
      selectedPackageId: f.model.packageId, currentCorpusSha256: "2".repeat(64), tables: historical };
    assert.throws(() => persistLegacyRetrievalLearningGenesis(db, request), /authorized native import transaction/);
    db.exec("BEGIN IMMEDIATE");
    const receipt = persistLegacyRetrievalLearningGenesis(db, request);
    db.exec("COMMIT");
    assert.equal(receipt.revision, 1);
    assert.deepEqual(readLegacyRetrievalLearning(db, { workspaceId, actorId: actor.id }).state, historical);
    assert.equal(db.prepare("SELECT count(*) AS count FROM legacy_original_learning_receipts").get().count, 0);
    assert.throws(() => verifyLegacyRetrievalLearning(db, "foreign-workspace"), /genesis has no exact initial/);
    db.exec("BEGIN IMMEDIATE");
    assert.throws(() => persistLegacyRetrievalLearningGenesis(db, request), /cannot replace/);
    db.exec("ROLLBACK");
    const read = async (tool, args) => (await legacyIndexedKnowledgeRead(storage, { tool, arguments: args }, undefined,
      input => worker.execute(input), actor)).value;
    await assert.rejects(read("retrieval_feedback", feedbackArgs), /actor-bound model receipt/);
    const next = await read("search_knowledge", { query: "private model evidence", route: "semantic" });
    assert.equal(next.model_invoked, true);
    assert.notEqual(next.retrieval_id, query.retrieval_id);
    const state = readLegacyRetrievalLearning(db, { workspaceId, actorId: actor.id }).state;
    assert.equal(state.settings.find(row => row[0] === "salt")[1], historical.settings.find(row => row[0] === "salt")[1]);
    assert.equal(state.calls.length, historical.calls.length + 1);
    const deniedModelLabel = await read("retrieval_feedback", { ...feedbackArgs, retrieval_id: next.retrieval_id, provenance: "model" });
    assert.equal(deniedModelLabel.ignored, true);
    assert.equal(deniedModelLabel.reason, "user-precedence");
    assert.throws(() => db.exec("DELETE FROM legacy_original_learning_genesis"), /immutable original learning/);
    verifyLegacyRetrievalLearning(db, workspaceId);
  } finally { db.close(); await worker.close(); await storage.close(); }
});

test("committed complete local-model publication recovers data-only on restart and survives backup relocation with exact learning authority", { timeout: 120_000 }, async t => {
  const f = await fixture(t), originalLease = f.storage.assertWorkspaceLease.bind(f.storage);
  f.storage.assertWorkspaceLease = () => {
    originalLease();
    if (new Error().stack.includes("modelState")) throw new Error("test committed publication interruption");
  };
  await assert.rejects(f.admit({ learningEnabled: true }), /committed publication interruption/);
  f.storage.assertWorkspaceLease = originalLease;
  const db = f.storage.connectNative();
  try {
    assert.equal(inspectLegacyRetrievalModelRecovery(db, f.data).pending.length, 1);
    assert.throws(() => verifyLegacyRetrievalModels(db, f.data), /requires native publication/);
  } finally { db.close(); }
  await f.close();
  let storage = await Storage.open(f.data), worker = new LegacyMcpPythonWorker(join(root, "compat/legacy-knowledge-mcp.py"));
  const invoke = async (tool, args) => (await legacyIndexedKnowledgeRead(storage, { tool, arguments: args }, undefined,
    input => worker.execute(input), actor)).value;
  let native = await createNativeRuntime({ storage });
  try {
    assert(!(await readdir(join(f.data, "packages/retrieval-models"))).some(name => name.startsWith(".stage-")));
    const before = await invoke("search_knowledge", { query: "evidence model", route: "semantic", debug: true });
    const backup = join(f.parent, "backup"), relocated = join(f.parent, "relocated");
    await createWorkspaceBackup(storage, backup, { acquireQuiescence: native.acquireWorkspaceQuiescence });
    await worker.close(); await native.close(); await storage.close();
    await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority });
    storage = await Storage.open(relocated); native = await createNativeRuntime({ storage });
    worker = new LegacyMcpPythonWorker(join(root, "compat/legacy-knowledge-mcp.py"));
    const feedback = await invoke("retrieval_feedback", { retrieval_id: before.retrieval_id,
      relevant_source_ids: [before.hits[0].source_id], complete: true });
    assert.equal(feedback.ok, true, JSON.stringify(feedback));
    assert.equal((await invoke("search_knowledge", { query: "evidence model", route: "semantic" })).model_invoked, true);
  } finally { await worker.close(); await native.close(); await storage.close(); }
});

for (const profile of ["compact", "legacy"])
test(`actual original search and write-authorized retrieval_feedback traverse ${profile} MCP with persistent model worker across restart`,
  { timeout: 120_000 }, async t => {
    const f = await fixture(t); await f.admit({ learningEnabled: true }); await f.close();
    const managed = await legacyManagedFixture(f.parent);
    let client;
    t.after(async () => { if (client) await closeLegacyManagedFixture(client); });
    const connect = async write => {
      client = new Client({ name: "original-local-model-proof", version: "1" });
      await client.connect(new StdioClientTransport({ command: "python3", args: [
        join(root, "compat/legacy-compact-mcp.py"), "--data", f.data, "--node", process.execPath,
        "--managed-generation", managed, ...(write ? ["--allow-writes"] : []),
      ], env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PKM_CAPABILITY_PROFILE: profile,
        OMP_NUM_THREADS: "1", TMPDIR: f.parent }, stderr: "pipe" }));
    };
    const invoke = async (name, args, write = false) => {
      const raw = await client.callTool(profile === "legacy" ? { name, arguments: args } : {
        name: write ? "capability_call" : "capability_read",
        arguments: { operation: `mcp.tool.${name}`, version: 1, arguments: args },
      });
      assert.notEqual(raw.isError, true, JSON.stringify(raw));
      return raw.structuredContent ?? JSON.parse(raw.content[0].text);
    };
    await connect(true);
    const status = await invoke("retrieval_status", {});
    assert.equal(status.semantic_status, "ready");
    const search = await invoke("search_knowledge", { query: "evidence model", route: "semantic", debug: true });
    assert.equal(search.model_invoked, true);
    const feedbackArgs = { retrieval_id: search.retrieval_id, relevant_source_ids: [search.hits[0].source_id], complete: true };
    const feedback = await invoke("retrieval_feedback", feedbackArgs, true);
    assert.equal(feedback.ok, true, JSON.stringify(feedback));
    assert.equal((await invoke("retrieval_status", {})).pid, status.pid);
    await closeLegacyManagedFixture(client); client = undefined;
    await connect(true);
    assert.notEqual((await invoke("retrieval_status", {})).pid, status.pid);
    assert.equal((await invoke("retrieval_feedback", feedbackArgs, true)).duplicate, true);
    await closeLegacyManagedFixture(client); client = undefined;
    await connect(false);
    const denied = await client.callTool(profile === "legacy" ? { name: "retrieval_feedback", arguments: feedbackArgs } : {
      name: "capability_call", arguments: { operation: "mcp.tool.retrieval_feedback", version: 1, arguments: feedbackArgs },
    });
    assert.equal(denied.isError, true);
    await closeLegacyManagedFixture(client); client = undefined;
  });
