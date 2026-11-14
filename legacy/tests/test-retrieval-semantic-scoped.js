const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const { retrievalTestPython } = require("./retrieval-test-runtime");
const build = path.resolve(process.env.PKM_SYNC_TEST_BUILD || "dist");
const { RetrievalWorkerManager } = require(path.join(build, "retrieval/retrieval-worker"));
const { createRetrievalSnapshot } = require(path.join(build, "retrieval/retrieval-snapshot"));
const resources = path.join(__dirname, "../resources");

const setup = `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from retrieval_runtime import activate_engine
activate_engine()
from adaptive_skill_retrieval.model_validation import local_model_bundle_fingerprint
from adaptive_skill_retrieval.solution_package import export_package, import_package
state = Path(sys.argv[2])
model = state / "model-fixture"
model.mkdir()
(model / "config.json").write_text("{}")
(model / "modules.json").write_text('[{"idx":0,"name":"0","path":"","type":"sentence_transformers.models.Transformer"}]')
(model / "model.safetensors").write_bytes(b"fixture")
config = {"model": str(model), "model_bundle_sha256": local_model_bundle_fingerprint(model)[1],
          "embedding_enabled": True, "retrieval_architecture_id": "pca-dense-section", "retained_dimension_ratio": 0.5}
archive = state / "solution.zip"
export_package(archive, name="Offline fixture", config=config, validation={}, license="MIT")
identity = import_package(archive, state / "solutions")["package_id"]
(state / "solution-selection.json").write_text(json.dumps({"schema": 1, "package_id": identity}))
print(identity)
`;

const inspect = `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from retrieval_runtime import activate_engine
activate_engine()
from adaptive_skill_retrieval import SkillDocument
from adaptive_skill_retrieval.architecture_retriever import _sections, _document_text
from retrieval_solution_index import cache_key
import numpy as np
state, identity = Path(sys.argv[2]), sys.argv[3]
snapshot = json.loads((state / "snapshot.json").read_text())
documents = [SkillDocument.create(skill_id=v["skill_id"], title=v.get("title") or "", description=v.get("description") or "",
    body=v.get("body") or "", content_type=v.get("content_type") or "skill", source_uri=v.get("source_uri") or "",
    metadata=v.get("metadata") or {}, provenance=v.get("provenance") or {}, read_only=bool(v.get("read_only"))) for v in snapshot["documents"]]
documents.sort(key=lambda d: str(d.version))
target = state / "solution-indexes" / identity / (cache_key(identity, documents) + ".npz")
with np.load(target, allow_pickle=False) as index:
    units, offset = {}, 0
    for i, document in enumerate(documents):
        count = len(_sections(document))
        units[document.version.skill_id] = {"document": index["document_vectors"][i].tolist(),
            "units": index["unit_vectors"][offset:offset+count].tolist()}
        offset += count
    print(json.dumps({"documents": units, "pca": index["pca_components"].tolist(), "mean": index["pca_mean"].tolist()}))
`;

const wait = async check => {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Semantic worker timed out");
};
const row = (name, body, digit) => ({ name, content: body, knowledgeId: "knowledge_" + digit.repeat(24) });
const snapshot = (skills, others = false) => createRetrievalSnapshot({
  skills, notes: others ? [{ slug: "note", title: "note", content: "unchanged note", knowledgeId: "knowledge_" + "3".repeat(24) }] : [],
  scripts: others ? [{ path: "demo.py", file: "demo.py", content: "unchanged script", knowledgeId: "script_" + "4".repeat(24) }] : [],
  papers: [], recipes: [], subscriptionGroups: [], readSubscription() { throw new Error("unexpected subscription access"); },
});

function fixtureScript(root) {
  const fixtureResources = path.join(root, "resources");
  fs.mkdirSync(path.join(fixtureResources, "vendor"), { recursive: true });
  for (const name of fs.readdirSync(resources).filter(name => /^retrieval.*\.py$/.test(name))) {
    fs.copyFileSync(path.join(resources, name), path.join(fixtureResources, name));
  }
  fs.copyFileSync(path.join(resources, "retrieval_worker.py"), path.join(fixtureResources, "retrieval_actual_worker.py"));
  fs.copyFileSync(path.join(__dirname, "retrieval-semantic-fixture-worker.py"), path.join(fixtureResources, "retrieval_worker.py"));
  fs.copyFileSync(path.join(resources, "vendor/adaptive_skill_retrieval-0.3.0.dev2026100504-py3-none-any.whl"),
    path.join(fixtureResources, "vendor/adaptive_skill_retrieval-0.3.0.dev2026100504-py3-none-any.whl"));
  return path.join(fixtureResources, "retrieval_worker.py");
}

test("first Skills index builds a healthy selected semantic model", async t => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".semantic-first-fixture-"));
  const state = path.join(root, "state");
  fs.mkdirSync(state);
  const script = fixtureScript(root);
  const stop = async () => {
    const file = path.join(state, "worker.json");
    if (!fs.existsSync(file)) return;
    const endpoint = JSON.parse(fs.readFileSync(file, "utf8"));
    try { await fetch(`http://127.0.0.1:${endpoint.port}/shutdown`, { method: "POST", headers: { "X-PKM-Retrieval-Token": endpoint.token } }); } catch {}
    await wait(() => !fs.existsSync(file));
  };
  t.after(async () => { await stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const python = retrievalTestPython(t);
  const identity = execFileSync(python, ["-c", setup, resources, state], { encoding: "utf8" }).trim();
  let manager = new RetrievalWorkerManager(state, script, python, "0.3.0.dev2026100504");
  const first = snapshot([row("First", "# First\nsemantic first", "9")]);
  const write = RetrievalWorkerManager.prototype.writeScopedJson;
  RetrievalWorkerManager.prototype.writeScopedJson = function(destination, ...args) {
    if (destination.endsWith("client-index.json")) throw new Error("fixture initial manifest interruption");
    return write.call(this, destination, ...args);
  };
  try { await assert.rejects(() => manager.syncSkills(first), /fixture initial manifest interruption/); }
  finally { RetrievalWorkerManager.prototype.writeScopedJson = write; }
  assert(fs.existsSync(path.join(state, "skills-index-pending.json")));
  assert(fs.existsSync(path.join(state, "index-events.json")));
  assert(!fs.existsSync(path.join(state, "client-index.json")));
  assert.equal((await manager.status()).semantic_status, "ready");
  assert.equal((await manager.status()).skill_serving.release_id, identity);
  await stop();
  manager = new RetrievalWorkerManager(state, script, python, "0.3.0.dev2026100504");
  const result = await manager.syncSkills(first);
  assert.deepEqual([result.upserts, result.deletes], [0, 0]);
  assert(!fs.existsSync(path.join(state, "skills-index-pending.json")));
  await wait(async () => { const s = await manager.status(); return s.corpus_revision === result.revision && s.semantic_status === "ready" && !s.building_revision; });
  assert.equal((await manager.search("semantic first", 5, ["skill"])).hits.length, 1);
});

test("real worker keeps non-Skill semantic vectors and model across scoped updates, failure and restart", async t => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".semantic-scoped-fixture-"));
  const state = path.join(root, "state");
  fs.mkdirSync(state);
  const script = fixtureScript(root);
  const stop = async () => {
    const endpointPath = path.join(state, "worker.json");
    if (!fs.existsSync(endpointPath)) return;
    const endpoint = JSON.parse(fs.readFileSync(endpointPath, "utf8"));
    try { await fetch(`http://127.0.0.1:${endpoint.port}/shutdown`, { method: "POST", headers: { "X-PKM-Retrieval-Token": endpoint.token } }); } catch {}
    await wait(() => !fs.existsSync(endpointPath));
  };
  t.after(async () => { await stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const python = retrievalTestPython(t);
  const identity = execFileSync(python, ["-c", setup, resources, state], { encoding: "utf8" }).trim();
  const vectors = () => JSON.parse(execFileSync(python, ["-c", inspect, resources, state, identity], { encoding: "utf8" }));
  const semanticSearch = async () => {
    const endpoint = JSON.parse(fs.readFileSync(path.join(state, "worker.json"), "utf8"));
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/search`, {
      method: "POST", headers: { "X-PKM-Retrieval-Token": endpoint.token, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "new B", route: "semantic", limit: 20 }),
    });
    const value = await response.json();
    assert.equal(value.ok, true);
    assert.equal(value.semantic_status, "ready");
    assert(value.hits.some(hit => hit.source_id === "pkm://knowledge/knowledge_" + "2".repeat(24)));
    assert(!value.hits.some(hit => hit.source_id === "pkm://knowledge/knowledge_" + "1".repeat(24)));
  };
  let manager = new RetrievalWorkerManager(state, script, python, "0.3.0.dev2026100504");
  const initial = snapshot([row("A", "# First\nold A", "1"), row("B", "# First\nold B", "2")], true);
  await manager.sync(initial);
  await wait(async () => { const s = await manager.status(); return s.corpus_revision === initial.corpus_revision && s.semantic_status === "ready" && !s.building_revision; });
  const before = vectors();
  const beforeSnapshot = JSON.parse(fs.readFileSync(path.join(state, "snapshot.json")));
  const untouched = beforeSnapshot.documents.filter(value => value.content_type !== "skill");
  const beforeEvents = JSON.parse(fs.readFileSync(path.join(state, "index-events.json")));
  const beforeManifest = JSON.parse(fs.readFileSync(path.join(state, "client-index.json")));
  const previousLog = fs.readFileSync(path.join(state, "encoded.jsonl"), "utf8");
  const updated = snapshot([row("B", "# First\nnew B", "2"), row("C", "# First\nnew C", "5")]);
  const result = await manager.syncSkills(updated);
  assert.deepEqual([result.upserts, result.deletes], [2, 1]);
  const after = vectors();
  for (const doc of untouched) assert.deepEqual(after.documents[doc.skill_id], before.documents[doc.skill_id]);
  assert.deepEqual(after.pca, before.pca);
  assert.deepEqual(after.mean, before.mean);
  assert(!after.documents["skill:A"]);
  assert(after.documents["skill:B"] && after.documents["skill:C"]);
  const log = fs.readFileSync(path.join(state, "encoded.jsonl"), "utf8").slice(previousLog.length);
  assert(!log.includes("unchanged note") && !log.includes("unchanged script"));
  const status = await manager.status();
  assert.equal(status.semantic_status, "ready");
  assert.equal(status.skill_serving.release_id, identity);
  await semanticSearch();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, "snapshot.json"))).documents.filter(value => value.content_type !== "skill"), untouched);
  const events = JSON.parse(fs.readFileSync(path.join(state, "index-events.json")));
  const manifest = JSON.parse(fs.readFileSync(path.join(state, "client-index.json")));
  for (const doc of untouched) {
    assert.deepEqual(events.sources[doc.source_id], beforeEvents.sources[doc.source_id]);
    assert.equal(manifest.hashes[doc.skill_id], beforeManifest.hashes[doc.skill_id]);
    assert.equal(manifest.source_ids[doc.skill_id], beforeManifest.source_ids[doc.skill_id]);
  }

  const baseFiles = ["snapshot.json", "client-index.json", "index-events.json"].map(file => fs.readFileSync(path.join(state, file)));
  fs.writeFileSync(path.join(state, "fail-embedding"), "1");
  const retry = snapshot([row("B", "# First\nprovider failure edit", "2"), row("C", "# First\nnew C", "5")]);
  await assert.rejects(() => manager.syncSkills(retry), /fixture embedding provider failure/);
  for (const [i, file] of ["snapshot.json", "client-index.json", "index-events.json"].entries()) {
    assert(fs.readFileSync(path.join(state, file)).equals(baseFiles[i]), `${file} must remain at the base`);
  }
  assert.deepEqual(vectors(), after);
  assert.equal((await manager.status()).semantic_status, "ready");
  await stop();
  manager = new RetrievalWorkerManager(state, script, python, "0.3.0.dev2026100504");
  await wait(async () => { const s = await manager.status(); return s.semantic_status === "ready" && !s.building_revision; });
  assert.deepEqual(vectors(), after);
  fs.unlinkSync(path.join(state, "fail-embedding"));
  await manager.syncSkills(retry);
  if (process.platform !== "win32") {
    const baseFiles = ["snapshot.json", "client-index.json", "index-events.json"].map(file => fs.readFileSync(path.join(state, file)));
    const baseVectors = vectors();
    fs.writeFileSync(path.join(state, "fail-dir-fsync"), "1");
    const diskEdit = snapshot([row("B", "# First\nfsync failure edit", "2"), row("C", "# First\nnew C", "5")]);
    await assert.rejects(() => manager.syncSkills(diskEdit), /fixture directory fsync failure/);
    for (const [i, file] of ["snapshot.json", "client-index.json", "index-events.json"].entries()) {
      assert(fs.readFileSync(path.join(state, file)).equals(baseFiles[i]), `${file} must remain at the base after fsync failure`);
    }
    assert.deepEqual(vectors(), baseVectors);
    fs.unlinkSync(path.join(state, "fail-dir-fsync"));
    await manager.syncSkills(diskEdit);
  }
  const modelFile = path.join(state, "solutions", identity, "model", "model.safetensors");
  const modelBytes = fs.readFileSync(modelFile);
  fs.writeFileSync(modelFile, "corrupt fixture");
  const next = snapshot([row("B", "# First\nmodel integrity edit", "2"), row("C", "# First\nnew C", "5")]);
  const safeBase = fs.readFileSync(path.join(state, "snapshot.json"));
  await assert.rejects(() => manager.syncSkills(next), /need-full-reindex.*integrity/i);
  assert(fs.readFileSync(path.join(state, "snapshot.json")).equals(safeBase));
  fs.writeFileSync(modelFile, modelBytes);
  await manager.syncSkills(next);
  const committed = vectors();
  for (const doc of untouched) assert.deepEqual(committed.documents[doc.skill_id], before.documents[doc.skill_id]);
  await stop();
  manager = new RetrievalWorkerManager(state, script, python, "0.3.0.dev2026100504");
  await wait(async () => { const s = await manager.status(); return s.semantic_status === "ready" && !s.building_revision; });
  assert.equal((await manager.status()).skill_serving.release_id, identity);
  assert.deepEqual(vectors(), committed);
  await semanticSearch();
});
