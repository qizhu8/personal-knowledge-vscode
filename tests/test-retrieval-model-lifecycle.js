const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { RetrievalWorkerManager } = require("../dist/retrieval/retrieval-worker");

test("in-flight model status cannot rearm or publish after extension disposal", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
  const start = source.indexOf("function scheduleRetrievalSolutionStatus(");
  const end = source.indexOf("function scheduleRetrievalRefresh(", start);
  const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let callback, completeCatalog, statusReads = 0, published = 0;
  const worker = { solutions: () => new Promise(resolve => { completeCatalog = resolve; }),
    status: async () => { statusReads++; return {}; } };
  const context = vm.createContext({
    retrievalSolutionDisposed: false, retrievalSolutionTimer: undefined,
    setTimeout: fn => { callback = fn; return { unref() {} }; }, clearTimeout() {},
    requireRetrievalWorker: async () => worker, panels: { instances: new Set([1]) },
    postToPanel: () => { published++; }, log: { warn: message => assert.fail(message) },
    retrievalSolutionTask: { running: () => assert.fail("disposed task updated"), idle: () => assert.fail("disposed task updated") },
  });
  vm.runInContext(code, context);
  context.scheduleRetrievalSolutionStatus({});
  const pending = callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof completeCatalog, "function");
  context.retrievalSolutionDisposed = true;
  completeCatalog({ state: "building" });
  await pending;
  assert.equal(statusReads, 0);
  assert.equal(published, 0);
  assert.equal(context.retrievalSolutionTimer, undefined);
});

test("model selection validates probe identities before writing configuration", async t => {
  const python = process.env.PKM_RETRIEVAL_TEST_PYTHON;
  if (!python) return t.skip("Set PKM_RETRIEVAL_TEST_PYTHON to an existing Python executable");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-model-probe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new RetrievalWorkerManager(root, path.join(root, "worker.py"), python, "0.3.0.dev2026100504");
  fs.writeFileSync(path.join(root, "retrieval_runtime.py"), 'print(\'{"ok":true,"engine_version":"wrong","python":"/python","engine_file":"/engine.py"}\')');
  await assert.rejects(manager.configureModelRuntime(python), /invalid or incompatible engine identity/);
  assert.equal(fs.existsSync(path.join(root, "model-runtime.json")), false);
  fs.writeFileSync(path.join(root, "retrieval_solution.py"), 'print(\'{"ok":true,"package_id":"bad","name":"fixture"}\')');
  const updated = new RetrievalWorkerManager(root, path.join(root, "worker.py"), python, "0.3.0.dev2026100504");
  await assert.rejects(updated.importSolution("/unused.zip"), /invalid package identity/);
  fs.writeFileSync(path.join(root, "model-runtime.json"), '{"schema":1,"python":"relative"}');
  assert.throws(() => manager.modelRuntime(), /Invalid retrieval model runtime selection/);
});

test("two clients persist and reuse an explicitly selected model Python after graceful replacement", async t => {
  const python = process.env.PKM_RETRIEVAL_TEST_PYTHON;
  const modelPython = process.env.PKM_MODEL_TEST_PYTHON;
  if (!python || !modelPython) return t.skip("Requires existing lightweight and model Python runtimes");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-model-lifecycle-"));
  t.after(async () => {
    if (fs.existsSync(path.join(root, "worker.json"))) {
      const endpoint = JSON.parse(fs.readFileSync(path.join(root, "worker.json"), "utf8"));
      await fetch(`http://127.0.0.1:${endpoint.port}/shutdown`, { method: "POST",
        headers: { "X-PKM-Retrieval-Token": endpoint.token } });
      await waitFor(() => !fs.existsSync(path.join(root, "worker.json")));
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const script = path.join(__dirname, "../resources/retrieval_worker.py");
  const manager = new RetrievalWorkerManager(root, script, python, "0.3.0.dev2026100504");
  const snapshot = { corpus_revision: "runtime-fixture", documents: [{ skill_id: "note:fixture",
    title: "Runtime fixture", description: "", body: "persistent model runtime selection", content_type: "note",
    source_uri: "pkm://notes/fixture", metadata: {}, provenance: { provider: "pkm" }, read_only: false, visibility: "available" }] };
  await manager.sync(snapshot);
  const before = await waitFor(async () => { const status = await manager.status(); return status.ready && status; });
  await manager.configureModelRuntime(modelPython, 4);
  const after = await waitFor(async () => { const status = await manager.status(); return status.ready && status; });
  assert.notEqual(after.pid, before.pid);
  assert.equal(after.runtime.python, modelPython);
  assert.equal(after.runtime.engine_version, "0.3.0.dev2026100504");
  assert.equal(after.runtime.cpu_threads, 4);
  assert(fs.existsSync(after.runtime.engine_file), "Fingerprinting requires extracted real engine sources");
  assert.equal(after.corpus_revision, snapshot.corpus_revision);
  const second = new RetrievalWorkerManager(root, script, python, "0.3.0.dev2026100504");
  assert.deepEqual(second.modelRuntime(), { configured: true, python: modelPython, cpuThreads: 4 });
  assert.equal((await second.status()).pid, after.pid, "The MCP Python must not cause a restart loop");
  assert.equal((await second.search("runtime", 5, ["note"])).hits.length, 1);
});

async function waitFor(read) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Runtime did not reach its expected state");
}
