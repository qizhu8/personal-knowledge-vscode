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
const { ensureRetrievalModelEnvironment, runModelEnvironmentCommand } = require(path.join(root, "dist/retrieval/retrieval-model-environment"));

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-model-setup-"));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  return directory;
}
const bytes = Buffer.from("bounded model bytes");
const model = { repository:"intfloat/multilingual-e5-small", revision:"a".repeat(40),
  manifest:{ files:{ "model.safetensors":{ bytes:bytes.length, sha256:createHash("sha256").update(bytes).digest("hex") } } } };

for (const outcome of ["ready", "failed", "cancelled"]) test(`model setup notifications expose lifecycle only: ${outcome}`, async () => {
  const source = fs.readFileSync(path.join(root, "src/extension.ts"), "utf8");
  const start = source.indexOf('const task = backgroundTaskRegistry.producer({ id:"retrieval:setup"');
  const ending = "} finally { task.idle(); }";
  assert(start >= 0);
  const end = source.indexOf(ending, start);
  assert(end > start);
  const body = source.slice(start, end + ending.length);
  const run = new (Object.getPrototypeOf(async function() {}).constructor)(
    "vscode", "backgroundTaskRegistry", "worker", "source", "selected", "msg", "postToPanel", body);
  const notifications = [], reports = [], internal = [], tasks = [];
  let cancel, disposed = false, idle = false;
  const failure = new Error(outcome === "cancelled" ? "Model setup cancelled" : "private detailed pip failure");
  const vscode = { ProgressLocation:{Notification:15}, window:{
    withProgress:async (options, callback) => {
      notifications.push(options.title);
      assert.equal(options.cancellable, true);
      return callback({report:value=>reports.push(value)}, {
        onCancellationRequested:listener => { cancel=listener; return {dispose:()=>{disposed=true;}}; },
      });
    },
    showInformationMessage:message=>notifications.push(message),
    showErrorMessage:message=>notifications.push(message),
  } };
  const worker = {prepareModel:async (_source, _path, _id, signal, report)=>{
    for (let index=0; index<100; index++) report({
      phase:"runtime", detail:`Collecting dependency ${index} from private local path`,
    });
    report({phase:"acquire",current:100,total:200,detail:"model download bytes"});
    if (outcome === "cancelled") { cancel(); assert.equal(signal.aborted, true); }
    if (outcome !== "ready") throw failure;
    report({phase:"ready",detail:"index ready"});
  }};
  const operation = run(vscode, {producer:()=>({
    running:value=>tasks.push(value), idle:()=>{idle=true;},
  })}, worker, "huggingface", undefined, {requestId:"fixture"}, message=>internal.push(message));
  if (outcome === "ready") await operation;
  else await assert.rejects(operation, error=>error === failure, "detailed failure still reaches the existing panel/log handler");
  assert.deepEqual(notifications, [
    "Embedding model loading started. See PKM for details.",
    outcome === "ready" ? "Embedding model loading complete." : "Embedding model loading failed. See PKM for details.",
  ]);
  assert.deepEqual(reports, [], "pip output and byte progress never reach notification text");
  assert(internal.length >= 101, "detailed events remain available inside PKM");
  assert.equal(internal[0].data.detail, "Collecting dependency 0 from private local path");
  assert.equal(tasks.length, internal.length, "background task details are preserved");
  assert(disposed && idle, "cancellation subscription and task are cleaned up");
});

test("one-click runtime creates an isolated PKM environment, installs CPU dependencies and reuses verified preparation", async t => {
  const directory = path.join(fixture(t), "pkm-retrieval"), calls = [], progress = [];
  const requirements = path.join(root, "resources/retrieval-model-requirements.txt");
  let probes = 0, missing = false;
  const options = {
    directory, basePython:"/fixture/mcp/python", requirements, signal:new AbortController().signal,
    report:detail => progress.push(detail),
    verify:async () => {
      probes++;
      if (missing) { missing = false; throw new Error("ModuleNotFoundError: No module named 'torch'"); }
    },
    run:async (python, args) => {
      calls.push({python, args});
      if (args[1] === "venv") {
        const executable = path.join(directory, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
        fs.mkdirSync(path.dirname(executable), {recursive:true}); fs.writeFileSync(executable, "");
      }
    },
  };
  const python = await ensureRetrievalModelEnvironment(options);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0], {python:options.basePython, args:["-m","venv",directory]});
  assert(calls.slice(1).every(call => call.python === python), "dependency installation never targets the base/MCP/system Python");
  assert.deepEqual(calls[1].args, ["-m","ensurepip","--upgrade"]);
  assert.deepEqual(calls[2].args, ["-m","pip","install","--no-input","--no-deps","torch==2.6.0+cpu",
    "--index-url","https://download.pytorch.org/whl/cpu"], "only the torch wheel bypasses the user's pip index; its dependencies use pip config");
  assert(!calls[3].args.includes("--index-url"), "requirements honor IT-configured pip mirrors");
  assert.deepEqual(calls[3].args, ["-m","pip","install","--no-input","-r",requirements]);
  assert.equal(probes, 1);
  assert.equal(await ensureRetrievalModelEnvironment(options), python);
  assert.equal(calls.length, 4, "a verified setup does not reinstall or redownload dependencies");
  missing = true;
  await ensureRetrievalModelEnvironment(options);
  assert.equal(calls.length, 7, "a missing torch import repairs only the managed environment automatically");
  assert(progress.some(detail => detail.includes("Repairing missing")));
});

test("runtime preparation rejects unowned directories and preserves cancellation without a ready marker", async t => {
  const directory = fixture(t), controller = new AbortController();
  const options = {directory, basePython:"/fixture/python", requirements:path.join(root, "resources/retrieval-model-requirements.txt"),
    signal:controller.signal, report() {}, verify:async () => assert.fail("cancelled setup must not verify"),
    run:async () => { controller.abort(new Error("cancel setup")); controller.signal.throwIfAborted(); }};
  await assert.rejects(ensureRetrievalModelEnvironment(options), /unrecognized environment/);
  await assert.rejects(ensureRetrievalModelEnvironment({...options, directory:path.join(directory, "owned")}), /cancel setup/);
  const marker = JSON.parse(fs.readFileSync(path.join(directory, "owned", ".pkm-retrieval-environment.json"), "utf8"));
  assert.equal(marker.fingerprint, undefined);
});

test("runtime subprocess cancellation is observed before running any command", async () => {
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await assert.rejects(runModelEnvironmentCommand("missing-python", [], controller.signal, () => {}), /cancelled/);
});

test("blocked package downloads explain how to use a pip mirror", async () => {
  const script = "import sys; sys.stderr.write(\"SSLError(SSLError(1, '[SSL: SSLV3_ALERT_HANDSHAKE_FAILURE]'))\\n\"); sys.exit(1)";
  await assert.rejects(runModelEnvironmentCommand(process.env.PYTHON || "python3", ["-c", script], new AbortController().signal, () => {}),
    error => /HANDSHAKE_FAILURE/.test(error.message) && /index-url in pip\.ini\/pip\.conf/.test(error.message));
});

test("runtime subprocess cancellation stops the active command and exposes its failure", async () => {
  const controller = new AbortController();
  const running = runModelEnvironmentCommand(process.execPath, ["-e","setInterval(()=>{},1000)"], controller.signal, () => {});
  const rejected = assert.rejects(running, /cancelled/);
  controller.abort();
  await rejected;
  await assert.rejects(runModelEnvironmentCommand(process.execPath, ["-e","console.error('install failed');process.exit(1)"],
    new AbortController().signal, () => {}), /install failed/);
});

for (const outcome of ["ready", "blocked", "superseded"]) test(`one action carries setup through runtime and index: ${outcome}`, async t => {
  const directory = fixture(t), events = [], writes = [];
  const manager = new RetrievalWorkerManager(directory, path.join(root, "resources/retrieval_worker.py"), process.execPath, "0.3.0.dev2026100504");
  manager.ensure = async () => ({});
  manager.prepareModelEnvironment = async (_managed, _signal, report) => report("Installing CPU dependencies");
  manager.runPython = async () => ({ok:true, package_id:"a".repeat(64)});
  manager.request = async (_endpoint, route, method, value) => {
    assert.equal(route, "/solutions");
    if (method === "POST") {
      writes.push(value);
      assert.equal(value.expected_revision, 7, "the selection fence is captured before potentially lengthy environment provisioning");
      if (outcome === "superseded") throw new Error("Selection revision changed");
    }
    return {selection_revision:7};
  };
  manager.solutions = async () => outcome === "blocked"
    ? {state:"blocked", error:"Index build failed", requested_package_id:"a".repeat(64)}
    : {state:"ready", active_package_id:"a".repeat(64)};
  const operation = manager.prepareModel("directory", "/fixture/model", `fixture-${outcome}`, new AbortController().signal,
    setup => events.push(setup));
  if (outcome === "ready") {
    await operation;
    assert.deepEqual([...new Set(events.map(setup => setup.phase))], ["runtime","acquire","verify","configure","index","ready"]);
    assert.equal(manager.setupStatus().phase, "ready");
  } else {
    await assert.rejects(operation, outcome === "blocked" ? /Index build failed/ : /Selection revision changed/);
    assert.equal(manager.setupStatus().phase, "failed");
    assert.equal(manager.setupStatus().failedPhase, outcome === "blocked" ? "index" : "configure");
    assert(!events.some(setup => setup.phase === "ready"));
  }
  assert.equal(writes.length, 1, "setup automatically enables and starts one build without extra actions");
});

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
  manager.prepareModelEnvironment = async () => {};
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
  for (const name of fs.readdirSync(path.join(root, "resources")).filter(name => /^retrieval.*\.(py|json|txt)$/.test(name))) {
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
  assert(fs.existsSync(path.join(runtime, "retrieval-model-requirements.txt")), "automatic environment preparation survives extension replacement too");
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
  const manager = new RetrievalWorkerManager(directory, path.join(root, "resources/retrieval_worker.py"), python, "0.3.0.dev2026100504",
    "exact-bm25-fuzzy-dual-rrf-v1", process.env.PKM_MANAGED_MODEL_ENVIRONMENT);
  if (source === "huggingface" && !process.env.PKM_MANAGED_MODEL_ENVIRONMENT) {
    assert.equal(fs.existsSync(path.join(directory, "model-environment")), false, "start from a genuinely fresh model environment with no torch");
  }
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
  assert.deepEqual([...new Set(events.map(event => event.phase))], ["runtime","acquire","verify","configure","index","ready"]);
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
  assert.equal(manager.setupStatus().phase, "ready", "the one-click action does not complete before index readiness");
  const runtime = manager.modelRuntime();
  assert.equal((await manager.status()).runtime.python, runtime.python, "the running worker actually uses the prepared model environment");
  const query = await manager.query({ schema:"pkm.retrieval.query/v1", requestId:"default-model-query", text:"fix problems importing modules in Python",
    contentTypeFilter:["note"], scope:{ capabilityId:"pkm.search_notes" }, topK:2, route:"semantic", generation:{ mode:"latest-ready" }, diagnostics:"summary" });
  assert.equal(query.hits[0].skill_id, "note:python");
  assert.equal(query.semantic_status, "ready");
  assert.equal(query.model_invoked, true, "semantic acceptance must exercise the model, not lexical fallback");
  assert.equal(query.hits[0].serving.packageId, catalog.active_package_id);
  console.log(`One-click model acceptance: ${JSON.stringify({phases:[...new Set(events.map(event => event.phase))],
    downloadBytes:events.find(event => event.total)?.total, python:runtime.python,
    packageId:catalog.active_package_id, semanticStatus:query.semantic_status, modelInvoked:query.model_invoked})}`);
  assert.equal(fs.readdirSync(directory).some(name => name.startsWith(".model-download-")), false, "download staging is removed after verified import");
});
