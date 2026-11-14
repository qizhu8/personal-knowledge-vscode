const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { RetrievalWorkerManager } = require("../dist/retrieval/retrieval-worker");

async function waitFor(check, label) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

async function inventory(directory, sentinel) {
  const result = {};
  async function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes:true })) {
      const filename = path.join(current, entry.name);
      assert(!entry.isSymbolicLink(), "Audit does not follow symlinks");
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile()) {
        const digest = createHash("sha256");
        let tail = Buffer.alloc(0);
        for await (const bytes of fs.createReadStream(filename)) {
          const joined = Buffer.concat([tail, bytes]);
          assert(!joined.includes(sentinel), `Private query persisted in ${path.relative(directory, filename)}`);
          tail = joined.subarray(Math.max(0, joined.length - sentinel.length));
          digest.update(bytes);
        }
        result[path.relative(directory, filename)] = digest.digest("hex");
      }
    }
  }
  await walk(directory);
  return result;
}

test("CTX-M15/M16: actual imported encoder serving is attributed, query-free and weight-immutable across restart", { timeout:300000 }, async t => {
  const python = process.env.PKM_RETRIEVAL_TEST_PYTHON, model = process.env.PKM_RETRIEVAL_TEST_MODEL;
  assert(python && model, "Set PKM_RETRIEVAL_TEST_PYTHON and PKM_RETRIEVAL_TEST_MODEL to the offline runtime and local encoder; this gate never downloads a model.");
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-feedback-audit-"));
  let endpoint;
  const shutdown = async () => {
    if (!endpoint) return;
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/shutdown`, { method:"POST", headers:{ "X-PKM-Retrieval-Token":endpoint.token } });
    assert(response.ok);
    await waitFor(() => !fs.existsSync(path.join(state, "worker.json")), "worker shutdown");
    endpoint = undefined;
  };
  t.after(async () => {
    try { await shutdown(); }
    finally { fs.rmSync(state, { recursive:true, force:true }); }
  });
  const environment = { ...process.env, HF_HUB_OFFLINE:"1", TRANSFORMERS_OFFLINE:"1", OMP_NUM_THREADS:"2", MKL_NUM_THREADS:"2" };
  const identity = execFileSync(python, ["-c", [
    "import sys",
    "from pathlib import Path",
    "from adaptive_skill_retrieval.model_validation import local_model_bundle_fingerprint",
    "from adaptive_skill_retrieval.solution_package import export_package, import_package",
    "root, model = Path(sys.argv[1]), Path(sys.argv[2])",
    "config = dict(model=str(model), model_bundle_sha256=local_model_bundle_fingerprint(model)[1], embedding_enabled=True, retrieval_architecture_id='dense-section')",
    "archive = root / 'fixture.zip'",
    "export_package(archive, name='CTX offline audit', config=config, validation={}, license='Apache-2.0')",
    "print(import_package(archive, root / 'solutions')['package_id'])",
    "archive.unlink()",
  ].join("\n"), state, model], { encoding:"utf8", env:environment, timeout:120000 }).trim();
  assert.match(identity, /^[a-f0-9]{64}$/);
  const sentinel = Buffer.from(`privatequery${randomUUID().replace(/-/g, "").replace(/[0-9]/g, digit => String.fromCharCode(97 + Number(digit)))}`);
  const packagePath = path.join(state, "solutions", identity);
  const baseline = await inventory(packagePath, sentinel);
  assert(Object.keys(baseline).some(name => name.endsWith(".safetensors")));
  const snapshot = { corpus_revision:"ctx-feedback-corpus", documents:[{
    skill_id:"skill:latency", source_id:"pkm://skills/latency", source_revision:"1", title:"Latency benchmark",
    description:"Latency measurement", body:"CPU-only, concurrency 32, version v2, latency 125 ms.",
    content_type:"skill", source_uri:"pkm://skills/latency", metadata:{}, provenance:{ provider:"fixture" },
    read_only:false, visibility:"available", links:[],
  }] };
  const previous = {};
  for (const name of ["HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "OMP_NUM_THREADS", "MKL_NUM_THREADS"]) {
    previous[name] = process.env[name]; process.env[name] = environment[name];
  }
  t.after(() => { for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  let firstPid;
  for (const phase of ["initial", "restart"]) {
    const manager = new RetrievalWorkerManager(state, path.resolve(__dirname, "../resources/retrieval_worker.py"), python, "0.3.0.dev2026100504");
    await manager.sync(snapshot);
    endpoint = JSON.parse(fs.readFileSync(path.join(state, "worker.json"), "utf8"));
    if (phase === "initial") {
      firstPid = endpoint.pid;
      await manager.setSolution("enable", identity);
    } else assert.notEqual(endpoint.pid, firstPid);
    await waitFor(async () => {
      const status = await manager.solutions();
      assert(!status.error, status.error);
      return status.active_package_id === identity && status.state === "ready";
    }, "actual imported encoder publication");
    const snapshotBefore = fs.readFileSync(path.join(state, "snapshot.json"));
    for (const diagnostics of ["none", "summary", "debug"]) {
      const result = await manager.query({ schema:"pkm.retrieval.query/v1", requestId:`${phase}-${diagnostics}`,
        text:`measure latency for ${sentinel}`, level:"l1-source", scope:{ capabilityId:sentinel.toString() },
        topK:5, route:"semantic", generation:{ mode:"latest-ready" }, diagnostics, deadlineMs:30000 });
      assert(result.hits.length > 0);
      for (const hit of result.hits) {
        assert.equal(hit.serving.packageId, identity);
        assert.equal(hit.serving.releaseId, identity);
        assert.equal(hit.serving.fallback, undefined);
        assert.equal(hit.serving.providerVersion, (await manager.status()).engine_version);
        assert.equal(hit.serving.route, [...new Set(hit.contributing_routes)].join("+"));
      }
    }
    assert.deepEqual(fs.readFileSync(path.join(state, "snapshot.json")), snapshotBefore);
    assert.deepEqual(await inventory(packagePath, sentinel), baseline, "Serving queries must never update package/model weights");
    const catalog = await manager.solutions();
    assert.equal(catalog.metrics.query_text_collected, false);
    assert(catalog.metrics.buckets.some(bucket => bucket.requests >= 3));
    await shutdown();
  }
  await inventory(state, sentinel);
  const SQL = await require("sql.js")(), database = new SQL.Database(fs.readFileSync(path.join(state, "solution-metrics.sqlite3")));
  try {
    assert.deepEqual(database.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0].values, [["buckets"], ["latencies"]]);
    assert(database.exec("SELECT SUM(requests) FROM buckets")[0].values[0][0] >= 6);
  } finally { database.close(); }
});
