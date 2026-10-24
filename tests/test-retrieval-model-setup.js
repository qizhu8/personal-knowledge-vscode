const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const root = process.env.PKM_RETRIEVAL_SETUP_EXTENSION_ROOT || path.resolve(__dirname, "..");
const { downloadRetrievalModel } = require(path.join(root, "dist/retrieval/retrieval-model-download"));
const { stageRetrievalRuntime } = require(path.join(root, "dist/retrieval/retrieval-runtime"));
const { RetrievalWorkerManager } = require(path.join(root, "dist/retrieval/retrieval-worker"));

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-model-setup-"));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  return directory;
}
const bytes = Buffer.from("bounded model bytes");
const model = { repository:"intfloat/multilingual-e5-small", revision:"a".repeat(40),
  manifest:{ files:{ "model.safetensors":{ bytes:bytes.length, sha256:createHash("sha256").update(bytes).digest("hex") } } } };

test("download uses pinned public URLs, real bytes and verified complete payload", async t => {
  const directory = fixture(t), events = [];
  await downloadRetrievalModel(model, directory, new AbortController().signal, (current, total) => events.push([current, total]), async (url, options) => {
    assert.equal(url, `https://huggingface.co/intfloat/multilingual-e5-small/resolve/${"a".repeat(40)}/model.safetensors`);
    assert(options.signal);
    return new Response(bytes);
  });
  assert(fs.readFileSync(path.join(directory, "model.safetensors")).equals(bytes));
  assert.deepEqual(events.at(-1), [bytes.length, bytes.length]);
  assert(events.every(([current, total]) => current >= 0 && current <= total));
});

for (const [name, response, message] of [
  ["truncated", () => new Response(bytes.subarray(0, 3)), /checksum or size mismatch/],
  ["corrupt", () => new Response(Buffer.alloc(bytes.length)), /checksum or size mismatch/],
  ["oversized", () => new Response(Buffer.alloc(bytes.length + 1)), /exceeds its pinned size/],
  ["http-error", () => new Response("denied", { status:403 }), /403/],
]) test(`download rejects ${name} without treating it as a valid model`, async t => {
  await assert.rejects(downloadRetrievalModel(model, fixture(t), new AbortController().signal, () => {}, async () => response()), message);
});

test("aborted download cannot start another request or finish successfully", async t => {
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await assert.rejects(downloadRetrievalModel(model, fixture(t), controller.signal, () => {}, async () => assert.fail("cancelled request started")), /cancelled/);
});

test("owned runtime survives removal of extension helpers and pins different builds", t => {
  const directory = fixture(t), source = path.join(directory, "extension", "resources"), state = path.join(directory, "state");
  fs.mkdirSync(source, { recursive:true });
  fs.writeFileSync(path.join(source, "retrieval_worker.py"), "print('worker')");
  fs.writeFileSync(path.join(source, "retrieval_solution_index.py"), "VERSION=1");
  const first = stageRetrievalRuntime(state, path.join(source, "retrieval_worker.py"));
  fs.writeFileSync(path.join(source, "retrieval_solution_index.py"), "VERSION=2");
  const second = stageRetrievalRuntime(state, path.join(source, "retrieval_worker.py"));
  assert.notEqual(first.build, second.build);
  fs.rmSync(source, { recursive:true });
  assert.equal(fs.readFileSync(path.join(path.dirname(first.script), "retrieval_solution_index.py"), "utf8"), "VERSION=1");
  assert.equal(fs.readFileSync(path.join(path.dirname(second.script), "retrieval_solution_index.py"), "utf8"), "VERSION=2");
});

test("setup cancellation preserves a verified import but never enables it", async t => {
  const directory = fixture(t);
  const manager = new RetrievalWorkerManager(directory, path.join(root, "resources/retrieval_worker.py"), process.execPath, "0.3.0.dev2026100504");
  const controller = new AbortController(), events = [];
  manager.ensure = async () => ({});
  manager.request = async (_endpoint, _route, method) => {
    assert.notEqual(method, "POST", "cancelled configuration cannot enable a model");
    return { selection_revision:0 };
  };
  manager.runPython = async (_python, args) => args.includes("--model-directory") ? { ok:true, package_id:"a".repeat(64) } : { ok:true };
  await assert.rejects(manager.prepareModel("directory", "/fixture/model", "cancel-fixture", controller.signal, value => {
    events.push(value.phase);
    if (value.phase === "verify") controller.abort(new Error("User cancelled setup"));
  }), /User cancelled/);
  assert.equal(events.at(-1), "cancelled");
  assert.equal(manager.setupStatus().failedPhase, "configure");
  assert.equal(fs.existsSync(path.join(directory, "model-setup.lock")), false);
});

test("real worker loads copied code after extension removal and replaces legacy build without replay", { timeout:30000 }, async t => {
  const python = process.env.PKM_RETRIEVAL_TEST_PYTHON;
  if (!python) return t.skip("Set PKM_RETRIEVAL_TEST_PYTHON for real worker test");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-model-worker-")), resources = path.join(directory, "extension", "resources"), state = path.join(directory, "state");
  fs.mkdirSync(resources, { recursive:true });
  for (const name of fs.readdirSync(path.join(root, "resources")).filter(name => /^retrieval.*\.(py|json)$/.test(name))) {
    fs.copyFileSync(path.join(root, "resources", name), path.join(resources, name));
  }
  fs.cpSync(path.join(root, "resources/vendor"), path.join(resources, "vendor"), { recursive:true });
  const manager = new RetrievalWorkerManager(state, path.join(resources, "retrieval_worker.py"), python, "0.3.0.dev2026100504");
  t.after(async () => {
    const endpoint = path.join(state, "worker.json");
    if (fs.existsSync(endpoint)) {
      const value = JSON.parse(fs.readFileSync(endpoint, "utf8"));
      await fetch(`http://127.0.0.1:${value.port}/shutdown`, { method:"POST", headers:{ "X-PKM-Retrieval-Token":value.token } });
      for (let i = 0; i < 200 && fs.existsSync(endpoint); i++) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(fs.existsSync(endpoint), false);
    }
    fs.rmSync(directory, { recursive:true, force:true });
  });
  const legacy = require("node:child_process").spawn(python, [path.join(resources, "retrieval_worker.py"), state], { stdio:"ignore" });
  for (let i = 0; i < 200 && !fs.existsSync(path.join(state, "worker.json")); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert(fs.existsSync(path.join(state, "worker.json")));
  const legacyPid = JSON.parse(fs.readFileSync(path.join(state, "worker.json"), "utf8")).pid;
  await manager.sync({ corpus_revision:"setup-fixture", documents:[{ skill_id:"note:fixture", title:"fixture", description:"", body:"test retrieval runtime",
    content_type:"note", metadata:{}, provenance:{ provider:"pkm" }, read_only:false, visibility:"available", source_uri:"pkm://notes/fixture" }] });
  const initial = await manager.status();
  assert.notEqual(initial.pid, legacyPid, "same-engine legacy worker must be replaced, not reused with missing old helper paths");
  assert.notEqual(legacy.exitCode, null);
  assert(initial.runtime.worker_build);
  fs.rmSync(resources, { recursive:true });
  assert((await manager.status()).runtime.worker_build);
  const runtime = path.join(state, "runtimes", initial.runtime.worker_build);
  assert(fs.existsSync(path.join(runtime, "retrieval_solution_index.py")), "lazy cache fingerprint no longer points to removed extension");
  const { spawnSync } = require("node:child_process");
  const check = spawnSync(python, ["-B", "-c", "import sys;sys.path.insert(0,sys.argv[1]);import retrieval_solution_index;from pathlib import Path;print(Path(retrieval_solution_index.__file__).read_bytes()[:10])", runtime], { encoding:"utf8" });
  assert.equal(check.status, 0, check.stderr);
});

for (const source of ["directory", "huggingface"]) test(`real ${source} setup reaches semantic ready using default weights`, { timeout:1200000 }, async t => {
  const python = process.env.PKM_MODEL_TEST_PYTHON;
  if (!python || (source === "directory" ? !process.env.PKM_DEFAULT_MODEL_DIRECTORY : process.env.PKM_TEST_MODEL_HF !== "1")) {
    return t.skip("Requires explicit existing model Python, weights or opt-in Hugging Face test");
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-default-setup-"));
  const manager = new RetrievalWorkerManager(directory, path.join(root, "resources/retrieval_worker.py"), python, "0.3.0.dev2026100504");
  t.after(async () => {
    const file = path.join(directory, "worker.json");
    if (fs.existsSync(file)) {
      const endpoint = JSON.parse(fs.readFileSync(file, "utf8"));
      await fetch(`http://127.0.0.1:${endpoint.port}/shutdown`, { method:"POST", headers:{ "X-PKM-Retrieval-Token":endpoint.token } });
      for (let i=0; i<400 && fs.existsSync(file); i++) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(fs.existsSync(file), false);
    }
    fs.rmSync(directory, { recursive:true, force:true });
  });
  await manager.sync({ corpus_revision:"default-model-fixture", documents:[
    { skill_id:"note:python", title:"Python testing", description:"Fix Python import errors", body:"Use pytest to reproduce import errors and inspect sys.path.",
      content_type:"note", metadata:{}, provenance:{ provider:"pkm" }, read_only:false, visibility:"available", source_uri:"pkm://notes/python" },
    { skill_id:"note:plants", title:"Plant care", description:"Water garden plants", body:"Keep the soil moist and prune dead leaves.",
      content_type:"note", metadata:{}, provenance:{ provider:"pkm" }, read_only:false, visibility:"available", source_uri:"pkm://notes/plants" },
  ] });
  const events = [];
  await manager.prepareModel(source, process.env.PKM_DEFAULT_MODEL_DIRECTORY, `fixture-${source}`, new AbortController().signal,
    value => { events.push(value); });
  assert.deepEqual([...new Set(events.map(event => event.phase))], ["runtime","acquire","verify","configure","index"]);
  if (source === "huggingface") {
    const download = events.filter(event => event.total);
    assert(download.length > 3);
    assert.equal(download.at(-1).current, 492795290);
    assert.equal(download.at(-1).current, download.at(-1).total);
  }
  const deadline = Date.now() + 120000;
  let catalog;
  do {
    catalog = await manager.solutions();
    assert(!catalog.error, catalog.error);
    if (catalog.state === "ready") break;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  assert.equal(catalog.state, "ready");
  const query = await manager.query({ schema:"pkm.retrieval.query/v1", requestId:"default-model-query", text:"fix problems importing modules in Python",
    contentTypeFilter:["note"], scope:{ capabilityId:"pkm.search_notes" }, topK:2, route:"semantic", generation:{ mode:"latest-ready" }, diagnostics:"summary" });
  assert.equal(query.hits[0].skill_id, "note:python");
  assert.equal(fs.readdirSync(directory).some(name => name.startsWith(".model-download-")), false, "download staging is removed after verified import");
});
