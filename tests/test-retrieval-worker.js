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
  /spawn\(this\.python,[\s\S]{0,300}windowsHide:\s*process\.platform === "win32"/,
  "the detached retrieval Python worker must not create a Windows console window",
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
  try {
    const initialSnapshot = { corpus_revision: "revision-1", documents: [
      { skill_id: "skill:data-prep", title: "AutoLabeling V2 Data Preparation", description: "Prepare grammar and accuracy datasets", body: "S2S S2C normalization splitting", content_type: "skill", source_uri: "pkm://skills/data-prep", metadata: {}, provenance: { provider: "pkm" }, read_only: false },
      { skill_id: "script:language", title: "Language Detection", description: "Scope script", body: "LanguageDetector loads HumpBack", content_type: "script", source_uri: "pkm://scripts/language.script", metadata: {}, provenance: { provider: "pkm" }, read_only: false },
    ] };
    assert.deepStrictEqual(await manager.sync(initialSnapshot), { mode: "full", upserts: 2, deletes: 0 });
    const ready = await waitUntil(async () => { const value = await manager.status(); return value.ready && value.corpus_revision === "revision-1" ? value : undefined; });
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
    assert.deepStrictEqual(await manager.sync(initialSnapshot), { mode: "reused", upserts: 0, deletes: 0 });
    const deltaSnapshot = { corpus_revision: "revision-2", documents: [
      { ...initialSnapshot.documents[0], description: "Updated dataset preparation" },
    ] };
    assert.deepStrictEqual(await manager.sync(deltaSnapshot), { mode: "delta", upserts: 1, deletes: 1 });
    const deltaReady = await waitUntil(async () => { const value = await manager.status(); return value.corpus_revision === "revision-2" ? value : undefined; });
    assert.strictEqual(deltaReady.document_count, 1);
    const restoredSnapshot = { ...initialSnapshot, corpus_revision: "revision-3" };
    assert.deepStrictEqual(await manager.sync(restoredSnapshot), { mode: "delta", upserts: 2, deletes: 0 });
    await waitUntil(async () => (await manager.status()).corpus_revision === "revision-3");
    let endpoint = JSON.parse(fs.readFileSync(path.join(state, "worker.json"), "utf8"));
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
    assert.strictEqual(restored.document_count, 2);
    endpoint = JSON.parse(fs.readFileSync(path.join(state, "worker.json"), "utf8"));
    await fetch(`http://127.0.0.1:${endpoint.port}/shutdown`, { method: "POST", headers: { "X-PKM-Retrieval-Token": endpoint.token } });
    console.log("retrieval worker test: persistent index, atomic ready revision, restart recovery, typed routing, and shared Subscriber PID OK");
  } finally {
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(state, { recursive: true, force: true });
    if (runtime) fs.rmSync(runtime, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
