#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { RetrievalWorkerManager } = require("../dist/retrieval-worker.js");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "retrieval-worker.ts"), "utf8");
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
    const wheel = path.join(__dirname, "..", "resources", "vendor", "adaptive_skill_retrieval-0.3.0.dev2026091601-py3-none-any.whl");
    execFileSync(python, ["-m", "pip", "install", "--no-deps", wheel], { stdio: "ignore" });
  }
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-retrieval-worker-"));
  const script = path.join(__dirname, "..", "resources", "retrieval_worker.py");
  const manager = new RetrievalWorkerManager(state, script, python, "0.3.0.dev2026091601");
  const second = new RetrievalWorkerManager(state, script, python, "0.3.0.dev2026091601");
  let endpoint;
  try {
    const initialSnapshot = { corpus_revision: "revision-1", documents: [
      { skill_id: "skill:data-prep", source_id: dataSourceId, source_revision: "1", title: "AutoLabeling V2 Data Preparation", description: "Prepare grammar and accuracy datasets", body: "S2S S2C normalization splitting", content_type: "skill", source_uri: "pkm://skills/data-prep", metadata: {}, provenance: { provider: "pkm" }, read_only: false, visibility: "available", links: [{ relation: "supports", target: languageSourceId, mode: "floating", required: true }] },
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
    assert(ready.supported_routes.includes("graph") && ready.unsupported_routes.includes("semantic"));
    const reused = await second.status();
    assert.strictEqual(reused.pid, ready.pid, "all MCP clients on one Subscriber must reuse one worker PID");
    assert.strictEqual(reused.configuration_hash, "exact-bm25-academic-v1");
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
    await assert.rejects(() => manager.query({
      schema: "pkm.retrieval.query/v1",
      requestId: "request-semantic",
      text: "Language",
      scope: { capabilityId: "test" },
      topK: 5,
      route: "semantic",
      generation: { mode: "latest-ready" },
      diagnostics: "summary",
    }), /Semantic retrieval is not supported/);
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
    endpoint = JSON.parse(fs.readFileSync(path.join(state, "worker.json"), "utf8"));
    await fetch(`http://127.0.0.1:${endpoint.port}/shutdown`, { method: "POST", headers: { "X-PKM-Retrieval-Token": endpoint.token } });
    await waitUntil(async () => !fs.existsSync(path.join(state, "worker.json")) || undefined);
    fs.writeFileSync(path.join(state, "worker.json"), JSON.stringify(endpoint));
    const restarted = new RetrievalWorkerManager(state, script, python, "0.3.0.dev2026091601");
    assert.deepStrictEqual(await restarted.sync(restoredSnapshot), { mode: "reused", upserts: 0, deletes: 0 },
      "an unchanged corpus must still recover a stale endpoint before reporting reuse");
    const recoveredEndpoint = JSON.parse(fs.readFileSync(path.join(state, "worker.json"), "utf8"));
    assert.notStrictEqual(recoveredEndpoint.pid, endpoint.pid, "stale endpoint recovery must start a replacement worker");
    const restored = await waitUntil(async () => { const value = await restarted.status(); return value.ready ? value : undefined; });
    assert.strictEqual(restored.corpus_revision, "revision-3", "restart must restore the last successfully merged snapshot");
    assert.strictEqual(restored.document_count, 4);
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
