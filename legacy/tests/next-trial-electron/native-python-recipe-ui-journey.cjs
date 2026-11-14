"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawn } = require("node:child_process"), { once } = require("node:events");
const { createServer } = require("node:http"), { DatabaseSync } = require("node:sqlite");
const { createHash } = require("node:crypto");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
exports.run = async context => {
  const { fixture, root, target, nonce, actorId, prepared, archive, descriptor, rootStat,
    env, processes, startCode, stopCode } = context;
  const old = JSON.parse(fs.readFileSync(path.join(fixture, "native-python-recipe-old-environment.json")));
  const originalRegistry = fs.readFileSync(old.registry);
  const manager = archive.chats.find(item => item.id === descriptor.workerManager);
  const identity = { namespace: manager.namespace, chatId: manager.id };
  let broker, grant, driver, modelCalls = 0, lifetimes = 0, uiCounter = 0;
  const provider = createServer((_request, response) => { modelCalls++; response.writeHead(500); response.end("Python Recipe must not invoke a model."); });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const grantFile = path.join(fixture, "u/User/globalStorage/uone.personal-knowledge/next-chat-ui-experiment.json");
  function databaseRead() {
    const database = new DatabaseSync(path.join(root, "core.sqlite"), { readOnly: true });
    try { return { jobs: database.prepare("SELECT record_json FROM runtime_process_jobs ORDER BY rowid").all()
      .map(row => JSON.parse(row.record_json)), recipes: database.prepare("SELECT record FROM native_recipe_library_records").all()
      .map(row => JSON.parse(row.record)) }; } finally { database.close(); }
  }
  const effects = () => {
    const file = path.join(fixture, "workspace/native-python-recipe-effects.jsonl");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  };
  async function waitFor(read, predicate) {
    const deadline = Date.now() + 30000;
    for (;;) { const value = await read(); if (predicate(value)) return value;
      if (Date.now() > deadline) throw Error(JSON.stringify(value)); await sleep(50); }
  }
  async function child(command, parameters) {
    const process = spawn(command, parameters, { cwd: fixture, env, stdio: "inherit" });
    processes.add(process); process.once("exit", () => processes.delete(process));
    const timer = setTimeout(() => process.kill("SIGTERM"), 120000);
    try { const result = await once(process, "exit"); assert.deepEqual(result, [0, null], parameters.join(" ")); }
    finally { clearTimeout(timer); }
  }
  async function ui(stage) {
    if (!driver) {
      for (const name of ["python-ui-ready", "python-ui-command.json", "python-ui-result.json"])
        fs.rmSync(path.join(fixture, name), { force: true });
      driver = spawn("python3", ["-B", path.resolve(__dirname, "../native_python_recipe_ui.py"),
        "http://127.0.0.1:9333", path.join(fixture, "api-chat-fixture.json"), "serve"],
      { cwd: fixture, env, stdio: "inherit" });
      processes.add(driver); driver.once("exit", () => processes.delete(driver));
      await waitFor(() => {
        assert(driver.exitCode === null && driver.signalCode === null, "Actual UI driver exited before readiness.");
        return fs.existsSync(path.join(fixture, "python-ui-ready"));
      }, ready => ready);
    }
    const id = ++uiCounter;
    const pending = path.join(fixture, "python-ui-command.next");
    fs.writeFileSync(pending, JSON.stringify({ id, stage }), { mode: 0o600 });
    fs.renameSync(pending, path.join(fixture, "python-ui-command.json"));
    const result = await waitFor(() => {
      const file = path.join(fixture, "python-ui-result.json");
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
    }, row => row.id === id);
    assert(!result.error, result.error);
  }
  const request = stage => path.join(fixture, `python-request-${stage}.json`);
  const results = [];
  async function protocol(mode, stage) {
    const output = path.join(fixture, `python-public-${mode}-${stage}-result.json`);
    await child(process.execPath, [path.join(__dirname, "native-python-recipe-public-client.cjs"), fixture, mode, request(stage), output]);
    const result = JSON.parse(fs.readFileSync(output)); results.push(result); return result;
  }
  async function rpc(method, extra = {}) {
    const response = await fetch(`${grant.endpoint}/rpc`, { method: "POST",
      headers: { authorization: `Bearer ${grant.bearer}`, "x-pkm-native-actor": actorId, "content-type": "application/json" },
      body: JSON.stringify({ method, ...identity, ...extra }) });
    const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data.value;
  }
  async function start(recover = false) {
    fs.writeFileSync(path.join(fixture, "native-managed-host.json"), JSON.stringify({
      root, nonce, workspaceId: prepared.workspaceId, actorId, sourceFingerprint: archive.sourceFingerprint,
      sourceSessionId: manager.metadata.sessionId, chat: identity, chatRecipe: true, recipeLibrary: true,
      recipePublic: true, recipePython: true, recipePythonRecover: recover,
      providerEndpoint: `http://127.0.0.1:${provider.address().port}/v1` }), { mode: 0o600 });
    broker = spawn(process.execPath, [path.join(__dirname, "native-managed-chat-ui-host.cjs"), fixture, root, target, nonce],
      { cwd: fixture, env: { ...env, PKM_NATIVE_UI_PRIVATE_FIXTURE: nonce }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    processes.add(broker); broker.once("exit", () => processes.delete(broker));
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Python Recipe broker startup timeout.")), 30000);
      broker.on("message", item => { if (item.type === "ready") { clearTimeout(timer); resolve(item); } });
      broker.once("error", reject); broker.once("exit", code => { clearTimeout(timer); reject(Error(`Python broker exited ${code}`)); });
    });
    grant = { schema: "pkm.private-native-chat-ui/v1", kind: "synthetic-only", fixture, root,
      rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino), nonce, workspaceId: prepared.workspaceId,
      actorId, sourceFingerprint: archive.sourceFingerprint, endpoint: ready.endpoint, bearer: ready.bearer };
    fs.writeFileSync(grantFile, JSON.stringify(grant), { mode: 0o600 });
    await rpc("recipe-state");
    await startCode({ PKM_PRIVATE_NATIVE_CHAT_UI_GRANT: grantFile }); lifetimes++;
  }
  async function stop(signal = "SIGTERM") {
    if (driver) {
      if (driver.exitCode === null && driver.signalCode === null) {
        const exited = once(driver, "exit"), pending = path.join(fixture, "python-ui-command.next");
        fs.writeFileSync(pending, JSON.stringify({ id: ++uiCounter, stage: "stop" }), { mode: 0o600 });
        fs.renameSync(pending, path.join(fixture, "python-ui-command.json"));
        const timer = setTimeout(() => driver?.kill("SIGKILL"), 5000);
        try { await exited; } finally { clearTimeout(timer); }
      }
      driver = undefined;
    }
    await stopCode();
    if (broker && broker.exitCode === null && broker.signalCode === null) {
      const exited = once(broker, "exit"); broker.kill(signal); const result = await exited;
      if (signal === "SIGTERM") assert.deepEqual(result, [0, null]);
    }
    broker = undefined;
  }
  try {
    await start();
    await ui("author"); assert.equal(databaseRead().recipes.length, 1);
    await ui("decline"); assert.deepEqual(effects(), []); assert.equal(databaseRead().jobs.length, 0);
    fs.renameSync(old.prefix, `${old.prefix}-unavailable`);
    try { await ui("missing"); assert.deepEqual(effects(), []); }
    finally { fs.renameSync(`${old.prefix}-unavailable`, old.prefix); }
    await ui("registry-drift");
    const changed = JSON.parse(originalRegistry); changed[0].python = "/not-the-approved-interpreter";
    fs.writeFileSync(old.registry, JSON.stringify(changed));
    try { await protocol("deny-mcp", "registry-drift"); assert.deepEqual(effects(), []); assert.equal(databaseRead().jobs.length, 0); }
    finally { fs.writeFileSync(old.registry, originalRegistry); }
    await ui("source-drift"); await ui("edit-source");
    await protocol("deny-http", "source-drift"); assert.deepEqual(effects(), []);
    await ui("sdk"); const sdkRun = await protocol("mcp", "sdk");
    await ui("http"); const httpRun = await protocol("http", "http");
    assert.deepEqual(effects(), [{ value: "installed-sdk" }, { value: "installed-http" }]);
    const first = databaseRead().jobs[0];
    assert.deepEqual(JSON.parse(Buffer.from(first.stdout, "base64").toString()), { prefix: old.prefix,
      argv: ["installed-sdk", "complete", "--not-cli", "$(touch never-created)", "two words", "中文", ""] });
    assert(!fs.existsSync(path.join(fixture, "workspace/never-created")));
    await ui("native-cancel");
    await waitFor(databaseRead, data => data.jobs.every(job => !["RUNNING", "QUEUED"].includes(job.state)));
    assert(databaseRead().jobs.some(job => job.state === "CANCELLED" && job.effect === "unknown"));
    await stop(); await start();
    assert.equal((await protocol("read-mcp", "sdk")).run.state, "succeeded");
    assert.equal((await protocol("read-http", "http")).run.state, "succeeded");
    await ui("crash"); const crashRun = await protocol("mcp-start-only", "crash");
    const atCrash = await waitFor(databaseRead, data => data.jobs.some(job => job.state === "RUNNING"
      && Buffer.from(job.stdout, "base64").toString().includes("installed-crash")));
    const pythonPid = atCrash.jobs.find(job => job.state === "RUNNING").pid;
    await stop("SIGKILL");
    await waitFor(() => fs.existsSync(`/proc/${pythonPid}`), exists => !exists);
    await start(true);
    const reopened = await protocol("read-http", "crash"); assert.equal(reopened.run.state, "unknown");
    assert(databaseRead().jobs.some(job => job.state === "INTERRUPTED" && job.effect === "unknown"));
    assert.equal(effects().filter(row => row.value === "installed-crash").length, 1);
    await ui("fresh"); const fresh = await protocol("mcp", "fresh");
    assert.deepEqual(effects(), [{ value: "installed-sdk" }, { value: "installed-http" },
      { value: "installed-native-cancel" }, { value: "installed-crash" }, { value: "installed-fresh" }]);
    assert.equal(createHash("sha256").update(fs.readFileSync(old.registry)).digest("hex"), old.registrySha256);
    assert.equal(modelCalls, 0);
    const final = { kind: "actual-installed-same-root-sql-public-next-python", root, installedExtension: target,
      workspaceId: prepared.workspaceId, actorId, originalEnvironment: old.record, originalRegistryUnchanged: true,
      sdkRunId: sdkRun.runId, httpRunId: httpRun.runId, crashRunId: crashRun.runId, freshRunId: fresh.runId,
      jobsAndSql: databaseRead(), effects: effects(), protocols: results, nextCodeLifetimes: lifetimes,
      distinctNativePythonModal: true, distinctPublicStartModal: true, declineMissingRegistryAndSqlDriftRejected: true,
      realOwnedPythonCancel: true, actualBrokerSIGKILL: true, restartUnknownWithoutReplayOrApproval: true,
      modelCalls, uvPositiveQualification: false, fullRecipeParity: false, migrationQualified: false,
      finalRootAndInstalledIdentityVerified: false };
    fs.writeFileSync(path.join(fixture, "native-recipe-installed-evidence.json"), JSON.stringify(final), { mode: 0o600 });
    console.log("PASS installed original profile -> same-root SQL/public Next Python, real native approvals + MCP/HTTP, parameters, cancel, drift, three Next Code lifetimes and broker SIGKILL UNKNOWN/no replay.");
  } finally { await stop(); await new Promise(resolve => provider.close(resolve)); }
};
