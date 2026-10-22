#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { randomUUID } = require("crypto");
const extensionRoot = path.resolve(process.env.PKM_TEST_EXTENSION_PATH || path.join(__dirname, ".."));
const { RetrievalWorkerManager, retrievalWorkerStartupTimeoutMs } = require(path.join(extensionRoot, "dist/retrieval/retrieval-worker.js"));
const { retrievalDocumentForSource, retrievalSourceValidation } = require(path.join(extensionRoot, "dist/retrieval/retrieval-snapshot.js"));

assert.strictEqual(retrievalWorkerStartupTimeoutMs(undefined, 0, "linux"), 10000);
assert.strictEqual(retrievalWorkerStartupTimeoutMs(undefined, 701, "linux"), 14000,
  "larger corpora must receive a larger cold-start budget");
assert.strictEqual(retrievalWorkerStartupTimeoutMs(undefined, 0, "win32"), 20000,
  "Windows process startup must have a safer initial floor");
assert.strictEqual(retrievalWorkerStartupTimeoutMs({
  schema: 1, successfulStartupMs: [4000, 8000, 12000], consecutiveTimeouts: 0,
}, 0, "linux"), 32000, "recent slow starts must expand the safety budget");
assert.strictEqual(retrievalWorkerStartupTimeoutMs({
  schema: 1, successfulStartupMs: [], consecutiveTimeouts: 3,
}, 0, "linux"), 80000, "repeated timeouts must use bounded exponential backoff");
assert.strictEqual(retrievalWorkerStartupTimeoutMs({
  schema: 1, successfulStartupMs: [90000], consecutiveTimeouts: 9,
}, 100000, "win32"), 90000, "adaptive startup budgets must remain bounded");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "retrieval/retrieval-worker.ts"), "utf8");
assert.match(
  source,
  /const launch = mcpStdioCommand\(this\.python,[\s\S]{0,200}spawn\(launch\.command, launch\.args,[\s\S]{0,200}windowsHide:\s*true/,
  "the detached retrieval Python worker must use the Windows no-console stdio proxy instead of python.exe directly",
);

async function waitUntil(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for retrieval index.");
}

async function main() {
  const dataSourceId = "pkm://knowledge/knowledge_111111111111111111111111";
  const languageSourceId = "pkm://knowledge/knowledge_222222222222222222222222";
  let python = process.env.PKM_RETRIEVAL_TEST_PYTHON;
  let runtime;
  if (!python) {
    runtime = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-retrieval-runtime-"));
    execFileSync(process.env.PYTHON || "python3", ["-m", "venv", "--system-site-packages", runtime]);
    python = process.platform === "win32" ? path.join(runtime, "Scripts", "python.exe") : path.join(runtime, "bin", "python");
    const wheel = path.join(extensionRoot, "resources", "vendor", "adaptive_skill_retrieval-0.3.0.dev2026100504-py3-none-any.whl");
    execFileSync(python, ["-m", "pip", "install", "--no-deps", wheel], { stdio: "ignore" });
  }
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-retrieval-worker-"));
  const script = path.join(extensionRoot, "resources", "retrieval_worker.py");
  const manager = new RetrievalWorkerManager(state, script, python, "0.3.0.dev2026100504");
  const second = new RetrievalWorkerManager(state, script, python, "0.3.0.dev2026100504");
  let endpoint;
  try {
    const initialSnapshot = { corpus_revision: "revision-1", documents: [
      { skill_id: "skill:data-prep", source_id: dataSourceId, source_revision: "1", title: "AutoLabeling V2 Data Preparation", description: "Prepare grammar and accuracy datasets", body: "S2S S2C normalization splitting", content_type: "skill", source_uri: "pkm://skills/data-prep", metadata: { "10":"ten", "2":"two", "\ud83d\udc26":"bird", "\uffff":"last", "\u6761\u4ef6":"\u4e0d\u5141\u8bb8" }, provenance: { provider: "pkm" }, read_only: false, visibility: "available", links: [{ relation: "supports", target: languageSourceId, mode: "floating", required: true }] },
      { skill_id: "script:language", source_id: languageSourceId, source_revision: "1", title: "Language Detection", description: "Scope script", body: "LanguageDetector loads HumpBack", content_type: "script", source_uri: "pkm://scripts/language.script", metadata: {}, provenance: { provider: "pkm" }, read_only: false, visibility: "available", links: [] },
      { skill_id: "note:private", title: "Private Retrieval Secret", description: "must not leak", body: "PRIVATE-RETRIEVAL-TOKEN", content_type: "note", source_uri: "pkm://notes/private", metadata: {}, provenance: { provider: "pkm" }, read_only: false, visibility: "private" },
      { skill_id: "subscription:readonly", title: "Read Only Retrieval", description: "capability filtered", body: "READONLY-RETRIEVAL-TOKEN", content_type: "subscription", source_uri: "pkm://subscriptions/read-only", metadata: {}, provenance: { provider: "broker" }, read_only: true },
    ] };
    assert.deepStrictEqual(await manager.sync(initialSnapshot), { mode: "full", upserts: 4, deletes: 0 });
    const ready = await waitUntil(async () => { const value = await manager.status(); return value.ready && value.corpus_revision === "revision-1" ? value : undefined; });
    assert.strictEqual(ready.ready_generation, 1);
    assert.strictEqual(ready.update_mode, "persistent-delta-events-with-full-in-memory-rebuild");
    assert.deepStrictEqual(ready.schema, {
      query: "pkm.retrieval.query/v1",
      result: "pkm.retrieval.result/v1",
      index_event: "pkm.retrieval.index-event/v1",
    });
    assert(ready.supported_routes.includes("graph") && ready.supported_routes.includes("semantic") && ready.supported_routes.includes("dual"));
    const reused = await second.status();
    assert.strictEqual(reused.pid, ready.pid, "all MCP clients on one Subscriber must reuse one worker PID");
    assert.strictEqual(reused.configuration_hash, "exact-bm25-fuzzy-dual-rrf-v1");
    endpoint = JSON.parse(fs.readFileSync(path.join(state, "worker.json"), "utf8"));
    const readSource = async (sourceId, extra = {}) => {
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/get`, {
        method: "POST",
        headers: { "X-PKM-Retrieval-Token": endpoint.token, "Content-Type": "application/json" },
        body: JSON.stringify({ source_id: sourceId, ...extra }),
      });
      return response.json();
    };
    const readSkill = await readSource(dataSourceId, { content_type_filter: ["skill"] });
    assert.strictEqual(readSkill.ok, true);
    assert.strictEqual(readSkill.source_id, dataSourceId);
    assert.match(readSkill.source_revision, /^1:[0-9a-f]{64}$/);
    const skillHit = (await manager.search("Data Preparation", 5, ["skill"])).hits[0];
    const materializedSource = retrievalDocumentForSource(initialSnapshot, skillHit.source_id, skillHit.source_revision, skillHit.content_hash);
    assert(materializedSource, "Actual worker revisions must resolve to physical Chat evidence, not silently become unavailable.");
    assert.strictEqual(materializedSource.body, readSkill.content);
    const validation = retrievalSourceValidation(() => initialSnapshot);
    const evidence = { id:skillHit.source_id, level:"l1-source", kind:skillHit.content_type,
      sourceUri:skillHit.source_uri, sourceId:skillHit.source_id, sourceRevision:skillHit.source_revision,
      contentHash:skillHit.content_hash, content:materializedSource.body };
    validation.admit(evidence, materializedSource);
    validation.refreshSourceValidation();
    assert(validation.sourceIsCurrent(evidence), "The actual worker identity must survive send-time revalidation.");
    assert.strictEqual(skillHit.serving.providerVersion, ready.engine_version);
    assert.strictEqual(skillHit.serving.route, [...new Set(skillHit.contributing_routes)].join("+") || "unreported");
    assert.strictEqual(skillHit.serving.packageId, undefined, "The default worker must not invent an imported package identity");
    assert.strictEqual(readSkill.source_revision, skillHit.source_revision);
    assert.strictEqual(readSkill.content_hash, skillHit.content_hash);
    assert.strictEqual(readSkill.content, initialSnapshot.documents[0].body);
    assert(readSkill.content_hash && readSkill.provenance.provider === "pkm");
    assert.strictEqual((await readSource(dataSourceId, { content_type_filter: ["note"] })).code, "not-found");
    assert.strictEqual((await readSource("pkm://notes/private")).code, "not-found");
    assert.strictEqual((await readSource(dataSourceId, { scope: { source_ids: [languageSourceId] } })).code, "not-found");
    assert.strictEqual((await readSource("pkm://subscriptions/read-only")).read_only, true);
    assert.strictEqual((await readSource("pkm://subscriptions/read-only", { scope: { include_read_only: false } })).code, "not-found");
    assert.strictEqual((await readSource(dataSourceId, { content_type_filter: ["invalid"] })).code, "invalid-filter");
    const older = new RetrievalWorkerManager(state, script, python, "0.2.0");
    assert.strictEqual((await older.status()).pid, ready.pid, "an older window must reuse, never replace, a newer compatible worker");
    const olderDifferentConfig = new RetrievalWorkerManager(state, script, python, "0.2.0", "legacy-config");
    await assert.rejects(() => olderDifferentConfig.status(), /newer PKM retrieval worker.*Reload this VS Code window/);
    assert.strictEqual((await manager.status()).pid, ready.pid, "an incompatible old window must leave the newer worker running");
    const result = await second.search("find the LanguageDetector script using $HumpBack$", 5, undefined, "request-1");
    assert.strictEqual(result.request_id, "request-1");
    assert.strictEqual(result.corpus_revision, "revision-1");
    assert.strictEqual(result.content_type_routing, "prefer");
    assert.strictEqual(result.hits[0].skill_id, "script:language");
    assert.strictEqual(result.hits[0].content_type, "script");
    assert.strictEqual(result.schema, "pkm.retrieval.result/v1");
    assert.strictEqual(result.readyGeneration, 1);
    const scoped = await manager.query({
      schema: "pkm.retrieval.query/v1",
      requestId: "request-scoped",
      text: "Data Language",
      scope: { capabilityId: "test", sourceIds: [dataSourceId] },
      topK: 5,
      route: "lexical",
      generation: { mode: "exact", generation: 1 },
      diagnostics: "debug",
    });
    assert(scoped.hits.every(hit => hit.sourceId === dataSourceId), "worker must filter before returning unauthorized hits");
    const graphResult = await manager.query({
      schema: "pkm.retrieval.query/v1",
      requestId: "request-graph",
      text: "AutoLabeling Data Preparation",
      scope: { capabilityId: "test", sourceIds: [dataSourceId, languageSourceId] },
      topK: 5,
      route: "hybrid",
      generation: { mode: "exact", generation: 1 },
      graph: { maxDepth: 2, maxNodes: 10, maxEdges: 10, relations: ["supports"], direction: "forward" },
      diagnostics: "debug",
    });
    assert(graphResult.hits.some(hit => hit.sourceId === languageSourceId && hit.scoreComponents.graph === 1),
      "bounded graph route must add the canonical forward target");
    const typedGraph = await manager.query({
      schema: "pkm.retrieval.query/v1", requestId: "request-typed-graph", text: "AutoLabeling Data Preparation",
      contentTypeFilter: ["skill"], scope: { capabilityId: "test" }, topK: 5, route: "hybrid",
      generation: { mode: "latest-ready" }, graph: { maxDepth: 2, maxNodes: 10, maxEdges: 10, direction: "forward" },
      diagnostics: "summary",
    });
    assert(typedGraph.hits.every(hit => hit.contentType === "skill"), "strict type filtering must also apply to graph targets");
    const privateResult = await manager.query({
      schema: "pkm.retrieval.query/v1",
      requestId: "request-private",
      text: "PRIVATE-RETRIEVAL-TOKEN",
      scope: { capabilityId: "test" },
      topK: 5,
      route: "lexical",
      generation: { mode: "latest-ready" },
      diagnostics: "debug",
    });
    assert.deepStrictEqual(privateResult.hits, [], "private sources must be filtered before serialization");
    const readOnlyResult = await manager.query({
      schema: "pkm.retrieval.query/v1",
      requestId: "request-read-only",
      text: "READONLY-RETRIEVAL-TOKEN",
      scope: { capabilityId: "test", includeReadOnly: false },
      topK: 5,
      route: "lexical",
      generation: { mode: "latest-ready" },
      diagnostics: "none",
    });
    assert.deepStrictEqual(readOnlyResult.hits, [], "read-only sources must honor capability scope");
    assert.deepStrictEqual(readOnlyResult.diagnostics, []);
    const privateQuery = `PRIVATE_QUERY_${randomUUID()}`;
    const beforeFeedback = await manager.status();
    const snapshotBeforeFeedback = fs.readFileSync(path.join(state, "snapshot.json"));
    const solutionBeforeFeedback = await manager.solutions();
    for (const diagnostics of ["none", "summary", "debug"]) {
      await manager.query({
        schema:"pkm.retrieval.query/v1", requestId:`privacy-${diagnostics}`, text:privateQuery,
        scope:{ capabilityId:privateQuery }, topK:5, route:"lexical",
        generation:{ mode:"latest-ready" }, diagnostics,
      });
    }
    const afterFeedback = await manager.solutions();
    assert.strictEqual(afterFeedback.metrics.query_text_collected, false);
    assert(!JSON.stringify(afterFeedback.metrics).includes(privateQuery));
    assert.strictEqual(afterFeedback.requested_package_id, solutionBeforeFeedback.requested_package_id);
    assert.strictEqual(afterFeedback.active_package_id, solutionBeforeFeedback.active_package_id);
    assert.deepStrictEqual(fs.readFileSync(path.join(state, "snapshot.json")), snapshotBeforeFeedback,
      "Query/diagnostic activity cannot modify corpus or serving configuration");
    assert.strictEqual((await manager.status()).ready_generation, beforeFeedback.ready_generation);
    const SQL = await require("sql.js")();
    const metricsBytes = fs.readFileSync(path.join(state, "solution-metrics.sqlite3"));
    const metrics = new SQL.Database(metricsBytes);
    try {
      assert.deepStrictEqual(metrics.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0].values,
        [["buckets"], ["latencies"]], "Local operational metrics must not grow training or feedback-event tables");
      const rows = metrics.exec("SELECT entry,reason,requests FROM buckets WHERE entry='other'");
      assert(rows[0].values.some(row => row[2] >= 3), "The audit exercised actual persistence, not an unused telemetry path");
    } finally { metrics.close(); }
    const auditFiles = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes:true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) auditFiles(filename);
        else if (entry.isFile()) assert(!fs.readFileSync(filename).includes(Buffer.from(privateQuery)),
          `Feedback-off raw query/capability must not persist in ${path.relative(state, filename)}`);
      }
    };
    auditFiles(state);
    const offSemantic = await manager.query({
      schema: "pkm.retrieval.query/v1",
      requestId: "request-semantic",
      text: "Language",
      scope: { capabilityId: "test" },
      topK: 5,
      route: "semantic",
      generation: { mode: "latest-ready" },
      diagnostics: "summary",
    });
    assert.strictEqual(offSemantic.semantic_status, "off");
    assert.deepStrictEqual(offSemantic.hits, []);
    assert.strictEqual(skillHit.source_label, "from keyword search");
    assert(skillHit.path_evidence.length > 0);
    const cancelled = new AbortController();
    cancelled.abort(new Error("test cancellation"));
    await assert.rejects(() => manager.query({
      schema: "pkm.retrieval.query/v1",
      requestId: "request-cancelled",
      text: "Language",
      scope: { capabilityId: "test" },
      topK: 5,
      route: "lexical",
      generation: { mode: "latest-ready" },
      diagnostics: "summary",
    }, cancelled.signal), /test cancellation/);
    await assert.rejects(() => manager.query({
      schema: "pkm.retrieval.query/v1",
      requestId: "request-deadline",
      text: "Language",
      scope: { capabilityId: "test" },
      topK: 5,
      route: "lexical",
      generation: { mode: "minimum", generation: 999 },
      diagnostics: "summary",
      deadlineMs: 25,
    }), /not satisfied before the deadline/);
    assert.deepStrictEqual(await manager.sync(initialSnapshot), { mode: "reused", upserts: 0, deletes: 0 });
    const deltaSnapshot = { corpus_revision: "revision-2", documents: [
      { ...initialSnapshot.documents[0], source_revision: "2", description: "Updated dataset preparation" },
    ] };
    assert.deepStrictEqual(await manager.sync(deltaSnapshot), { mode: "delta", upserts: 1, deletes: 3 });
    const cutover = await manager.status();
    assert(["revision-1", "revision-2"].includes(cutover.corpus_revision));
    if (cutover.building_generation === 2) {
      assert.strictEqual(cutover.corpus_revision, "revision-1", "building generation must not be published as ready");
      assert.strictEqual(cutover.ready_generation, 1);
    }
    const deltaReady = await waitUntil(async () => { const value = await manager.status(); return value.corpus_revision === "revision-2" ? value : undefined; });
    assert.strictEqual(deltaReady.document_count, 1);
    assert.strictEqual(deltaReady.ready_generation, 2);
    await assert.rejects(() => manager.query({
      schema: "pkm.retrieval.query/v1",
      requestId: "request-old-generation",
      text: "data",
      scope: { capabilityId: "test" },
      topK: 5,
      route: "lexical",
      generation: { mode: "exact", generation: 1 },
      diagnostics: "summary",
      deadlineMs: 100,
    }), /unavailable/);
    const restoredSnapshot = {
      ...initialSnapshot,
      corpus_revision: "revision-3",
      documents: initialSnapshot.documents.map((document, index) => index === 0 ? { ...document, source_revision: "3" } : document),
    };
    assert.deepStrictEqual(await manager.sync(restoredSnapshot), { mode: "delta", upserts: 4, deletes: 0 });
    await waitUntil(async () => (await manager.status()).corpus_revision === "revision-3");
    const brokerSnapshot = { ...restoredSnapshot, corpus_revision: "revision-broker-types", documents: [
      ...restoredSnapshot.documents,
      { skill_id: "pkm://subscriptions/typed-skill", source_id: "pkm://subscriptions/typed-skill", source_revision: "1",
        title: "Broker Typed Skill", description: "Broker typed search fixture", body: "BROKER-TYPED-TOKEN",
        content_type: "subscription", source_uri: "pkm://subscriptions/typed-skill", metadata: { upstream_type: "skills" },
        provenance: { provider: "broker", subscription_id: "typed-sub" }, read_only: true },
    ] };
    await manager.sync(brokerSnapshot);
    await waitUntil(async () => (await manager.status()).corpus_revision === "revision-broker-types");
    const brokerSkill = await manager.search("BROKER-TYPED-TOKEN", 10, ["skill"]);
    assert.strictEqual(brokerSkill.hits[0].content_type, "skill");
    assert.strictEqual(brokerSkill.hits[0].read_only, true);
    const brokerHit = brokerSkill.hits[0];
    const brokerDocument = retrievalDocumentForSource(brokerSnapshot, brokerHit.source_id, brokerHit.source_revision, brokerHit.content_hash);
    assert(brokerDocument, "Typed subscription hits resolve to their actual physical content hash and immutable revision");
    assert.equal(brokerDocument.content_type, "skill");
    const brokerValidation = retrievalSourceValidation(() => brokerSnapshot);
    const brokerEvidence = { id:brokerHit.source_id, level:"l1-source", kind:brokerHit.content_type,
      sourceUri:brokerHit.source_uri, sourceId:brokerHit.source_id, sourceRevision:brokerHit.source_revision,
      contentHash:brokerHit.content_hash, content:brokerDocument.body };
    brokerValidation.admit(brokerEvidence, brokerDocument); brokerValidation.refreshSourceValidation();
    assert(brokerValidation.sourceIsCurrent(brokerEvidence), "Subscription evidence survives the same send-time validation as local sources");
    assert.strictEqual((await manager.search("BROKER-TYPED-TOKEN", 10, ["note"])).hits.length, 0);
    assert((await manager.search("BROKER-TYPED-TOKEN", 10, ["subscription"])).hits.some(hit => hit.skill_id === "pkm://subscriptions/typed-skill"));
    assert.strictEqual((await readSource("pkm://subscriptions/typed-skill", { content_type_filter: ["skill"] })).read_only, true);
    assert.strictEqual((await readSource("pkm://subscriptions/typed-skill", { content_type_filter: ["note"] })).code, "not-found");
    await manager.sync(restoredSnapshot);
    await waitUntil(async () => (await manager.status()).corpus_revision === "revision-3");
    endpoint = JSON.parse(fs.readFileSync(path.join(state, "worker.json"), "utf8"));
    await fetch(`http://127.0.0.1:${endpoint.port}/shutdown`, { method: "POST", headers: { "X-PKM-Retrieval-Token": endpoint.token } });
    await waitUntil(async () => !fs.existsSync(path.join(state, "worker.json")) || undefined);
    fs.writeFileSync(path.join(state, "worker.json"), JSON.stringify(endpoint));
    fs.writeFileSync(path.join(state, "serving-release.json"), '{"release":{},"sha256":"invalid"}');
    const restarted = new RetrievalWorkerManager(state, script, python, "0.3.0.dev2026100504");
    assert.deepStrictEqual(await restarted.sync(restoredSnapshot), { mode: "reused", upserts: 0, deletes: 0 },
      "an unchanged corpus must still recover a stale endpoint before reporting reuse");
    const recoveredEndpoint = JSON.parse(fs.readFileSync(path.join(state, "worker.json"), "utf8"));
    assert.notStrictEqual(recoveredEndpoint.pid, endpoint.pid, "stale endpoint recovery must start a replacement worker");
    const restored = await waitUntil(async () => { const value = await restarted.status(); return value.ready ? value : undefined; });
    assert.strictEqual(restored.corpus_revision, "revision-3", "restart must restore the last successfully merged snapshot");
    assert.strictEqual(restored.document_count, 4);
    const fallback = await waitUntil(async () => {
      const value = await restarted.status();
      return value.skill_serving.error ? value : undefined;
    });
    assert.strictEqual(fallback.skill_serving.ready, false, "invalid/missing serving dependencies must keep BM25 ready");
    const fallbackResult = await restarted.query({ schema: "pkm.retrieval.query/v1", requestId: "fallback-dual",
      text: "Data Preparation", topK: 5, contentTypeFilter: ["skill"], route: "dual",
      scope: { capabilityId: "test" }, generation: { mode: "latest-ready" }, diagnostics: "summary" });
    assert.strictEqual(fallbackResult.semantic_status, "fallback");
    assert.strictEqual(fallbackResult.hits[0].serving.scoreSemantics, "rrf");
    assert(fallbackResult.hits.length > 0);
    assert(fallbackResult.hits[0].serving.fallback, "Actual worker fallback reason must survive normalization");
    assert.strictEqual(fallbackResult.hits[0].serving.packageId, undefined);
    assert.strictEqual(fallbackResult.hits[0].serving.releaseId, undefined);
    endpoint = JSON.parse(fs.readFileSync(path.join(state, "worker.json"), "utf8"));
    await fetch(`http://127.0.0.1:${endpoint.port}/shutdown`, { method: "POST", headers: { "X-PKM-Retrieval-Token": endpoint.token } });
    console.log("retrieval worker test: persistent index, atomic ready revision, restart recovery, typed routing, and shared Subscriber PID OK");
  } finally {
    if (endpoint) {
      try {
        await fetch(`http://127.0.0.1:${endpoint.port}/shutdown`, {
          method: "POST",
          headers: { "X-PKM-Retrieval-Token": endpoint.token },
        });
      } catch { /* the test may already have stopped or replaced this worker */ }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(state, { recursive: true, force: true });
    if (runtime) fs.rmSync(runtime, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
