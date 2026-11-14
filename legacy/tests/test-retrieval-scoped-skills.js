const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { createHash } = require("node:crypto");
const build = path.resolve(process.env.PKM_SYNC_TEST_BUILD || "dist");
const { retrievalTestPython } = require("./retrieval-test-runtime");
const { RetrievalWorkerManager } = require(path.join(build, "retrieval/retrieval-worker"));
const { RetrievalIndexEventStore } = require(path.join(build, "retrieval/retrieval-index-events"));
const { createRetrievalSnapshot } = require(path.join(build, "retrieval/retrieval-snapshot"));
const filestore = require(path.join(build, "knowledge/filestore"));
const storage = require(path.join(build, "knowledge/storage"));
const { referencedMarkdownAssets } = require(path.join(build, "knowledge/markdown-assets"));
const script = path.join(process.cwd(), "resources/retrieval_worker.py");
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const skill = (name, body, id) => `---\nname: ${name}\nknowledgeId: knowledge_${id.repeat(24)}\nrevision: 1\n---\n${body}\n`;
const wait = async check => {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Retrieval worker timed out");
};
const snapshot = skills => createRetrievalSnapshot({
  skills, notes: [], papers: [], scripts: [], recipes: [], subscriptionGroups: [],
  readSubscription() { throw new Error("unexpected subscription access"); },
});
const localSkills = () => filestore.skillList().flatMap(row => {
  const detail = filestore.skillGet(row.name);
  if (!detail) throw new Error("Missing Skill fixture");
  const file = filestore.knowledgeFilePath("skills", row.name);
  const relative = path.relative(path.join(filestore.getStorePath(), "skills"), file).replace(/\\/g, "/");
  const assets = referencedMarkdownAssets(filestore.getStorePath(), "skills", relative, detail.content);
  const resourceDigest = assets.length
    ? createHash("sha256").update(JSON.stringify(assets.map(asset => [asset.path, asset.digest]))).digest("hex") : undefined;
  return [{ ...row, ...detail, ...(resourceDigest ? { resourceDigest } : {}) }];
});

test("first Skills sync initializes a real index without touching other areas and survives restart", async t => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".skills-first-fixture-"));
  const store = path.join(root, "store"), state = path.join(root, "state");
  fs.mkdirSync(store);
  put(path.join(store, "skills/Fresh.md"), skill("Fresh", "first searchable skill", "7"));
  put(path.join(store, "scripts/example.py"), "print('not indexed')\n");
  put(path.join(store, "notes/Note.md"), "not indexed\n");
  filestore.setStorePath(store); storage.setStorePath(store);
  const sidecar = storage.scriptIdentityFile("example.py");
  const stop = async () => {
    const file = path.join(state, "worker.json");
    if (!fs.existsSync(file)) return;
    const endpoint = JSON.parse(fs.readFileSync(file, "utf8"));
    try { await fetch(`http://127.0.0.1:${endpoint.port}/shutdown`, { method: "POST", headers: { "X-PKM-Retrieval-Token": endpoint.token } }); } catch {}
    await wait(() => !fs.existsSync(file));
  };
  t.after(async () => { await stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const python = retrievalTestPython(t);
  let manager = new RetrievalWorkerManager(state, script, python, "0.3.0.dev2026100504");
  const forbidden = ["notes", "scripts"].map(area => path.join(store, area));
  const methods = ["readFileSync", "readdirSync", "statSync", "lstatSync", "realpathSync"];
  const originals = Object.fromEntries(methods.map(method => [method, fs[method]]));
  const reads = [];
  for (const method of methods) fs[method] = function(file, ...args) {
    if (typeof file === "string" && forbidden.some(dir => file === dir || file.startsWith(dir + path.sep))) reads.push(`${method}:${file}`);
    return originals[method].call(this, file, ...args);
  };
  try {
    const result = await manager.syncSkills(snapshot(localSkills()));
    assert.deepEqual([result.upserts, result.deletes], [1, 0]);
    assert.equal((await manager.search("first searchable skill", 5, ["skill"])).hits[0].source_id,
      "pkm://knowledge/knowledge_" + "7".repeat(24));
    const indexed = JSON.parse(fs.readFileSync(path.join(state, "snapshot.json")));
    assert.deepEqual(indexed.documents.map(doc => doc.skill_id), ["skill:Fresh"]);
    assert(!fs.existsSync(path.join(state, "skills-index-pending.json")));
    await stop();
    manager = new RetrievalWorkerManager(state, script, python, "0.3.0.dev2026100504");
    await wait(async () => { const status = await manager.status(); return status.ready && status.corpus_revision === result.revision; });
    assert.equal((await manager.search("first searchable skill", 5, ["skill"])).hits.length, 1);
    assert.deepEqual(reads, []);
    assert(!fs.existsSync(sidecar));
  } finally { for (const method of methods) fs[method] = originals[method]; }
});

test("incomplete or leftover retrieval indexes cannot be initialized as fresh", async t => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".skills-partial-fixture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = ["client-index.json", "snapshot.json", "index-events.json"];
  for (let mask = 1; mask < 7; mask++) {
    const state = path.join(root, `partial-${mask}`);
    fs.mkdirSync(state);
    for (let i = 0; i < files.length; i++) if (mask & (1 << i)) put(path.join(state, files[i]), `original-${i}`);
    const manager = new RetrievalWorkerManager(state, script, process.execPath, "0.3.0.dev2026100504");
    await assert.rejects(() => manager.syncSkills(snapshot([])), /complete existing retrieval index/);
    for (let i = 0; i < files.length; i++) if (mask & (1 << i)) {
      assert.equal(fs.readFileSync(path.join(state, files[i]), "utf8"), `original-${i}`);
    }
  }
  for (const artifact of ["client-index.json.123.tmp", "snapshot.json.tmp-123", "solution-indexes"]) {
    const state = path.join(root, artifact.replaceAll(".", "-"));
    fs.mkdirSync(state);
    put(path.join(state, artifact), "leftover");
    const manager = new RetrievalWorkerManager(state, script, process.execPath, "0.3.0.dev2026100504");
    await assert.rejects(() => manager.syncSkills(snapshot([])), /incomplete index artifacts/);
    assert.equal(fs.readFileSync(path.join(state, artifact), "utf8"), "leftover");
  }
  const corrupt = path.join(root, "corrupt");
  fs.mkdirSync(corrupt);
  for (const file of files) put(path.join(corrupt, file), "{}");
  await assert.rejects(() => new RetrievalWorkerManager(corrupt, script, process.execPath, "0.3.0.dev2026100504")
    .syncSkills(snapshot([])), /incomplete or inconsistent/);
  for (const file of files) assert.equal(fs.readFileSync(path.join(corrupt, file), "utf8"), "{}");
  if (process.platform !== "win32") {
    const linked = path.join(root, "linked");
    fs.mkdirSync(linked);
    fs.symlinkSync(path.join(root, "missing"), path.join(linked, "snapshot.json"));
    await assert.rejects(() => new RetrievalWorkerManager(linked, script, process.execPath, "0.3.0.dev2026100504")
      .syncSkills(snapshot([])), /not a regular file/);
    assert(fs.lstatSync(path.join(linked, "snapshot.json")).isSymbolicLink());
  }
});

test("real worker updates only Skills, retains other sources, and restores after restart", async t => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".skills-index-fixture-"));
  const store = path.join(root, "store"), state = path.join(root, "state");
  fs.mkdirSync(store); fs.mkdirSync(state);
  put(path.join(store, "skills/A.md"), skill("A", "alpha-old", "1"));
  put(path.join(store, "skills/B.md"), skill("B", "beta-old", "2"));
  put(path.join(store, "scripts/example.py"), "print('untouched')\n");
  put(path.join(store, "notes/Note.md"), "---\ntitle: Note\n---\nuntouched\n");
  filestore.setStorePath(store); storage.setStorePath(store);
  const sidecar = storage.scriptIdentityFile("example.py");
  const initial = createRetrievalSnapshot({
    skills: localSkills(),
    notes: [{ slug: "Note", title: "Note", content: "unchanged note", knowledgeId: "knowledge_" + "3".repeat(24) }],
    scripts: [{ path: "example.py", file: "example.py", content: "unchanged script", knowledgeId: "script_" + "4".repeat(24) }],
    papers: [], recipes: [], subscriptionGroups: [],
    readSubscription() { throw new Error("unexpected subscription access"); },
  });
  let endpoint;
  const stop = async () => {
    const endpointPath = path.join(state, "worker.json");
    if (!fs.existsSync(endpointPath)) return;
    endpoint = JSON.parse(fs.readFileSync(endpointPath, "utf8"));
    try { await fetch(`http://127.0.0.1:${endpoint.port}/shutdown`, { method: "POST", headers: { "X-PKM-Retrieval-Token": endpoint.token } }); } catch {}
    await wait(() => !fs.existsSync(endpointPath));
  };
  t.after(async () => { await stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const python = retrievalTestPython(t);
  const manager = new RetrievalWorkerManager(state, script, python, "0.3.0.dev2026100504");
  await manager.sync(initial);
  await wait(async () => { const status = await manager.status(); return status.ready && status.corpus_revision === initial.corpus_revision; });
  const before = JSON.parse(fs.readFileSync(path.join(state, "snapshot.json")));
  const beforeEvents = JSON.parse(fs.readFileSync(path.join(state, "index-events.json")));
  const untouched = before.documents.filter(doc => doc.content_type !== "skill");
  const untouchedEvents = Object.fromEntries(untouched.map(doc => [doc.source_id, beforeEvents.sources[doc.source_id]]));
  const beforeManifest = JSON.parse(fs.readFileSync(path.join(state, "client-index.json")));
  fs.rmSync(path.join(store, "skills/A.md"));
  put(path.join(store, "skills/B.md"), skill("B", "beta-new", "2"));
  put(path.join(store, "skills/C.md"), skill("C", "gamma-new", "5"));
  const forbidden = ["notes", "scripts"].map(area => path.join(store, area));
  const methods = ["readFileSync", "readdirSync", "statSync", "lstatSync", "realpathSync"];
  const originals = Object.fromEntries(methods.map(method => [method, fs[method]]));
  const reads = [];
  for (const method of methods) fs[method] = function(file, ...args) {
    if (typeof file === "string" && forbidden.some(dir => file === dir || file.startsWith(dir + path.sep))) reads.push(`${method}:${file}`);
    return originals[method].call(this, file, ...args);
  };
  let update;
  try { update = await manager.syncSkills(snapshot(localSkills())); }
  finally { for (const method of methods) fs[method] = originals[method]; }
  assert.deepEqual(reads, []);
  assert(!fs.existsSync(sidecar));
  assert.deepEqual([update.upserts, update.deletes], [2, 1]);
  const after = JSON.parse(fs.readFileSync(path.join(state, "snapshot.json")));
  const afterEvents = JSON.parse(fs.readFileSync(path.join(state, "index-events.json")));
  const afterManifest = JSON.parse(fs.readFileSync(path.join(state, "client-index.json")));
  assert.deepEqual(after.documents.filter(doc => doc.content_type !== "skill"), untouched);
  for (const doc of untouched) {
    assert.deepEqual(afterEvents.sources[doc.source_id], untouchedEvents[doc.source_id]);
    assert.equal(afterManifest.hashes[doc.skill_id], beforeManifest.hashes[doc.skill_id]);
    assert.equal(afterManifest.source_ids[doc.skill_id], beforeManifest.source_ids[doc.skill_id]);
  }
  assert.deepEqual(after.documents.filter(doc => doc.content_type === "skill").map(doc => doc.skill_id).sort(), ["skill:B", "skill:C"]);
  assert(after.documents.find(doc => doc.skill_id === "skill:B").body.includes("beta-new"));
  assert.equal((await manager.search("unchanged script", 5, ["script"])).hits[0].source_id, untouched.find(doc => doc.content_type === "script").source_id);
  fs.renameSync(path.join(store, "skills/C.md"), path.join(store, "skills/D.md"));
  put(path.join(store, "skills/D.md"), skill("D", "gamma-moved ![chart](D.assets/chart.png)", "5"));
  const asset = path.join(store, "skills/D.assets/chart.png");
  put(asset, Buffer.from([137, 80, 78, 71, 1]));
  put(path.join(store, "skills/B.md"), skill("B", "beta-new-identity", "6"));
  const apply = RetrievalIndexEventStore.prototype.apply;
  RetrievalIndexEventStore.prototype.apply = function() { throw new Error("fixture event commit interruption"); };
  try {
    await assert.rejects(() => manager.syncSkills(snapshot(localSkills())), /fixture event commit interruption/);
  } finally { RetrievalIndexEventStore.prototype.apply = apply; }
  const pending = JSON.parse(fs.readFileSync(path.join(state, "skills-index-pending.json")));
  const pendingSnapshot = JSON.parse(fs.readFileSync(path.join(state, "snapshot.json")));
  assert.equal(pendingSnapshot.corpus_revision, pending.journal.revision);
  assert.deepEqual(pendingSnapshot.documents.filter(doc => doc.content_type !== "skill"), untouched);
  await stop();
  const restarted = new RetrievalWorkerManager(state, script, python, "0.3.0.dev2026100504");
  await wait(async () => { const status = await restarted.status(); return status.ready && status.corpus_revision === pending.journal.revision; });
  assert.equal((await restarted.syncSkills(snapshot(localSkills()))).upserts, 0);
  assert(!fs.existsSync(path.join(state, "skills-index-pending.json")));
  let recovered = JSON.parse(fs.readFileSync(path.join(state, "snapshot.json")));
  assert.deepEqual(recovered.documents.filter(doc => doc.content_type !== "skill"), untouched);
  assert.deepEqual(recovered.documents.filter(doc => doc.content_type === "skill").map(doc => doc.skill_id).sort(), ["skill:B", "skill:D"]);
  const eventsAfterRecovery = JSON.parse(fs.readFileSync(path.join(state, "index-events.json")));
  assert(!eventsAfterRecovery.sources["pkm://knowledge/knowledge_" + "2".repeat(24)]);
  assert(eventsAfterRecovery.sources["pkm://knowledge/knowledge_" + "5".repeat(24)]);
  assert(eventsAfterRecovery.sources["pkm://knowledge/knowledge_" + "6".repeat(24)]);
  for (const [id, source] of Object.entries(untouchedEvents)) assert.deepEqual(eventsAfterRecovery.sources[id], source);
  const assetDigest = recovered.documents.find(doc => doc.skill_id === "skill:D").metadata.resource_digest;
  assert(assetDigest);
  put(asset, Buffer.from([137, 80, 78, 71, 2]));
  const resourceUpdate = await restarted.syncSkills(snapshot(localSkills()));
  assert.deepEqual([resourceUpdate.upserts, resourceUpdate.deletes], [1, 0]);
  recovered = JSON.parse(fs.readFileSync(path.join(state, "snapshot.json")));
  assert.notEqual(recovered.documents.find(doc => doc.skill_id === "skill:D").metadata.resource_digest, assetDigest);
  assert.deepEqual(recovered.documents.filter(doc => doc.content_type !== "skill"), untouched);
  const preserved = fs.readFileSync(path.join(state, "snapshot.json"));
  endpoint = JSON.parse(fs.readFileSync(path.join(state, "worker.json")));
  const attack = await fetch(`http://127.0.0.1:${endpoint.port}/update`, {
    method: "POST", headers: { "X-PKM-Retrieval-Token": endpoint.token, "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "local-skills-v1", base_revision: recovered.corpus_revision,
      corpus_revision: "invalid-scoped-update", generation: recovered.generation + 1,
      upserts: [], deletes: [untouched[0].skill_id] }),
  });
  assert.equal(attack.status, 202);
  const rejected = await wait(async () => { const status = await restarted.status(); return status.error ? status : undefined; });
  assert.match(rejected.error, /delete a non-Skill/);
  assert(fs.readFileSync(path.join(state, "snapshot.json")).equals(preserved));
  const intactManifest = fs.readFileSync(path.join(state, "client-index.json"));
  const broken = JSON.parse(fs.readFileSync(path.join(state, "client-index.json")));
  broken.hashes[untouched[0].skill_id] = "0".repeat(64);
  put(path.join(state, "client-index.json"), JSON.stringify(broken));
  await assert.rejects(() => restarted.syncSkills(snapshot(localSkills())), /baseline identity or digest mismatch/i);
  assert(fs.readFileSync(path.join(state, "snapshot.json")).equals(preserved));
  put(path.join(state, "client-index.json"), intactManifest);
  await stop();
  put(path.join(state, "serving-release.json"), '{"release":{},"sha256":"invalid"}');
  const semantic = new RetrievalWorkerManager(state, script, python, "0.3.0.dev2026100504");
  await wait(async () => { const status = await semantic.status(); return status.ready && status.semantic_status !== "off"; });
  put(path.join(store, "skills/B.md"), skill("B", "semantic change", "6"));
  await assert.rejects(() => semantic.syncSkills(snapshot(localSkills())), /need-full-reindex/);
  assert(fs.readFileSync(path.join(state, "snapshot.json")).equals(preserved));
});
