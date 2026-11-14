const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), { randomUUID } = require("node:crypto");
const { fork } = require("node:child_process"), { pathToFileURL } = require("node:url");
const { prepare, open, load, hash } = require("./next-python-recipe-fixture.cjs");
const rootBuild = process.env.PKM_ENV_AUTHORITY_BUILD;
const { PythonEnvironmentAuthority } = require(path.join(rootBuild, "runtime/python-environment-authority.js"));
const { PythonRecipeAuthority, readProfilePythonRegistry } = require(path.join(rootBuild, "runtime/python-recipe-authority.js"));
async function until(read, predicate) {
  const deadline = Date.now() + 30000;
  for (;;) { const value = await read(); if (predicate(value)) return value;
    if (Date.now() >= deadline) assert.fail(JSON.stringify(value)); await new Promise(resolve => setTimeout(resolve, 25)); }
}
const call = (env, operation, args, write = false) => env.runtime.core.dispatch(write ? "capability_call" : "capability_read",
  { operation, version: 1, arguments: args }, env.actor);
async function sdk(url, token) {
  const resolveSdk = name => pathToFileURL(require.resolve(`@modelcontextprotocol/sdk/${name}`,
    { paths: [path.resolve("next-server")] })).href;
  const { Client } = await import(resolveSdk("client/index.js"));
  const { StreamableHTTPClientTransport } = await import(resolveSdk("client/streamableHttp.js"));
  const client = new Client({ name: "genuine-next-python-recipe", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url),
    { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}
async function endpoints(env, t) {
  const token = randomUUID(), http = await (await load("http")).startHttp(env.runtime.core, token, env.actor, 0);
  const mcp = await (await load("recipe-mcp-http")).startRecipeMcpHttp(env.runtime.core, env.actor, token);
  const client = await sdk(mcp.url, token);
  t.after(async () => { await client.close(); await mcp.close(); http.server.closeAllConnections();
    await new Promise(resolve => http.server.close(resolve)); });
  return { client, http: http.url, token };
}
async function post(endpoint, token, operation, args, write = true) {
  const response = await fetch(`${endpoint}/v1/${write ? "capability_call" : "capability_read"}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ operation, version: 1, arguments: args }) });
  return response.json();
}
function rootDecision(metadata, binding, preview) {
  const environments = new PythonEnvironmentAuthority(() => true, () => readProfilePythonRegistry(metadata.registry));
  const authority = new PythonRecipeAuthority({ trusted: () => true, environments, binding, cwd: metadata.workspace });
  return { authority, environments, grant: authority.select(preview),
    close() { authority.revoke(); environments.revoke(); } };
}
function evidence(metadata, name, value) {
  fs.writeFileSync(path.join(metadata.directory, `${name}.json`), JSON.stringify(value, null, 2), { mode: 0o600 });
}

test("genuine SQL library + SDK MCP and HTTP execute the new Python adapter with separate exact native permission", async t => {
  const metadata = prepare(), env = await open(metadata); t.after(() => env.close());
  const transport = await endpoints(env, t), args = await env.args("sdk-value");
  assert((await env.recipes.state(env.binding)).recipes[0].available);
  const catalog = await call(env, "project.recipe.list", {});
  const recipe = catalog.result.items?.find(row => row.recipeId === metadata.recipeId)
    ?? (await env.recipes.catalog(env.binding)).recipes.find(row => row.recipeId === metadata.recipeId);
  assert(recipe);
  assert.equal(env.database.prepare("SELECT count(*) AS n FROM native_recipe_library_records").get().n, 1);
  const general = await call(env, "workflow.executor.get", {});
  assert.equal(general.error.code, "NOT_AVAILABLE", "public Recipe actor cannot bypass via generic Workflow");
  await env.publicRecipes.approve(env.binding, { operation: "recipe.runtime.start", args });
  const onlyPublic = await call(env, "recipe.runtime.start", args, true);
  assert.equal(onlyPublic.error.code, "ACCESS_DENIED"); assert.deepEqual(env.effects(), []);
  const next = await env.args("sdk-value");
  const approved = await env.approvePython(next);
  assert.equal((await env.recipes.state(env.binding)).digest, next.expectedDigest, "Python approval is not catalog eligibility");
  assert.equal((await call(env, "recipe.runtime.start", next, true)).error.code, "ACCESS_DENIED", "Python grant is not public permission");
  await env.publicRecipes.approve(env.binding, { operation: "recipe.runtime.start", args: next });
  const started = await transport.client.callTool({ name: "capability_call",
    arguments: { operation: "recipe.runtime.start", version: 1, arguments: next } });
  assert(!started.isError, JSON.stringify(started));
  const runId = started.structuredContent.result.runId;
  const done = await until(() => call(env, "recipe.runtime.get", { runId }), response => response.result?.state === "succeeded");
  const first = env.jobs()[0];
  assert.equal(first.state, "SUCCEEDED"); assert(first.pid > 0);
  assert.deepEqual(JSON.parse(Buffer.from(first.stdout, "base64").toString()), { prefix: metadata.prefix,
    argv: ["sdk-value", "complete", "--not-cli", "$(touch never-created)", "two words", "中文", ""] });
  assert(!fs.existsSync(path.join(metadata.workspace, "never-created")));
  const again = await post(transport.http, transport.token, "recipe.runtime.start", next);
  assert.equal(again.error.code, "ACCESS_DENIED");
  const httpArgs = await env.args("http-value");
  await env.approvePython(httpArgs);
  await env.publicRecipes.approve(env.binding, { operation: "recipe.runtime.start", args: httpArgs });
  const httpStart = await post(transport.http, transport.token, "recipe.runtime.start", httpArgs);
  assert(!httpStart.error, JSON.stringify(httpStart));
  await until(() => post(transport.http, transport.token, "recipe.runtime.get", { runId: httpStart.result.runId }, false),
    response => response.result?.state === "succeeded");
  assert.deepEqual(env.effects(), [{ value: "sdk-value" }, { value: "http-value" }]);
  assert.equal(hash(fs.readFileSync(metadata.registry)), metadata.originalRegistrySha256);
  evidence(metadata, "sql-sdk-http-result", { source: approved.preview.manifest.source, sdkRun: done.result,
    httpRunId: httpStart.result.runId, jobs: env.jobs(), effects: env.effects(), oldRegistryUnchanged: true,
    publicAndPythonDecisionsIndependent: true, replayDenied: true });
});

test("SQL/source, native-object, inputs, registry and unavailable-prefix failures refuse without effects; explicit repair works", async t => {
  const metadata = prepare(), env = await open(metadata); t.after(() => env.close());
  const args = await env.args(), preview = await env.python.preview({ operation: "recipe.runtime.start", args });
  const decision = rootDecision(metadata, env.binding, preview); t.after(() => decision.close());
  assert.throws(() => decision.authority.approve(structuredClone(decision.grant)), /authority/);
  assert.throws(() => decision.authority.consume(decision.grant), /approval/);
  decision.authority.approve(decision.grant);
  const payload = decision.authority.consume(decision.grant);
  assert.throws(() => decision.authority.consume(decision.grant), /consumed/);
  await assert.rejects(env.python.approve({ ...payload, program: { ...payload.program, inputs: { value: "substitute", mode: "complete" } } }), /binding/);
  await assert.rejects(env.python.approve({ ...payload, program: { ...payload.program, source: { kind: "inline" } } }), /binding/);
  const catalog = await env.recipes.catalog(env.binding), current = catalog.recipes[0];
  await env.recipes.saveLibrary(env.binding, { namespace: env.binding.namespace, chatId: env.binding.chatId,
    operationId: randomUUID(), recipeId: current.recipeId, expectedRevision: current.revision, expectedDigest: args.expectedDigest,
    fields: { name: current.name, category: current.category, description: "SQL revision changed during review.", definition: current.definition } });
  await assert.rejects(env.python.approve(payload), /changed/);
  fs.renameSync(metadata.prefix, `${metadata.prefix}-unavailable`);
  try {
    const freshArgs = await env.args();
    const freshPreview = await env.python.preview({ operation: "recipe.runtime.start", args: freshArgs });
    assert.throws(() => rootDecision(metadata, env.binding, freshPreview), /ENOENT|canonical|changed/);
  } finally { fs.renameSync(`${metadata.prefix}-unavailable`, metadata.prefix); }
  const mappingArgs = await env.args("drift");
  await env.approvePython(mappingArgs);
  const original = fs.readFileSync(metadata.registry), changed = JSON.parse(original);
  changed[0].python = "/not-the-original-interpreter";
  fs.writeFileSync(metadata.registry, JSON.stringify(changed));
  try {
    await env.publicRecipes.approve(env.binding, { operation: "recipe.runtime.start", args: mappingArgs });
    const rejected = await call(env, "recipe.runtime.start", mappingArgs, true);
    assert(rejected.error); assert.deepEqual(env.effects(), []);
  } finally { fs.writeFileSync(metadata.registry, original); }
  const repaired = await env.args("repaired");
  await env.approvePython(repaired); await env.publicRecipes.approve(env.binding, { operation: "recipe.runtime.start", args: repaired });
  const started = await call(env, "recipe.runtime.start", repaired, true);
  assert(!started.error, JSON.stringify(started));
  await until(() => call(env, "recipe.runtime.get", { runId: started.result.runId }), response => response.result?.state === "succeeded");
  assert.deepEqual(env.effects(), [{ value: "repaired" }]);
  decision.authority.revoke(); assert.throws(() => decision.authority.approve(decision.grant), /revoked/);
  evidence(metadata, "negative-and-explicit-repair-result", { repairedRunId: started.result.runId,
    sourceRevision: (await env.recipes.catalog(env.binding)).recipes[0].revision,
    effects: env.effects(), copiedUnapprovedConsumedRevokedRejected: true, inlineInputsAndSqlDriftRejected: true,
    originalRegistryRestored: hash(fs.readFileSync(metadata.registry)) === metadata.originalRegistrySha256 });
});

test("real public HTTP cancellation needs its own host decision and stops the directly owned Python child with UNKNOWN effects", async t => {
  const metadata = prepare(), env = await open(metadata); t.after(() => env.close());
  const transport = await endpoints(env, t), args = await env.args("cancelled", "hold");
  await env.approvePython(args); await env.publicRecipes.approve(env.binding, { operation: "recipe.runtime.start", args });
  const started = await post(transport.http, transport.token, "recipe.runtime.start", args);
  assert(!started.error, JSON.stringify(started)); const runId = started.result.runId;
  await until(() => env.jobs(), jobs => jobs.some(job => job.state === "RUNNING" && Buffer.from(job.stdout, "base64").length));
  const run = (await call(env, "recipe.runtime.get", { runId })).result;
  const cancel = { namespace: env.binding.namespace, chatId: env.binding.chatId, operationId: randomUUID(),
    expectedDigest: (await env.recipes.state(env.binding)).digest, runId, expectedVersion: run.version };
  assert.equal((await post(transport.http, transport.token, "recipe.runtime.cancel", cancel)).error.code, "ACCESS_DENIED");
  env.grantMutation("recipe.runtime.cancel", cancel);
  const response = await post(transport.http, transport.token, "recipe.runtime.cancel", cancel);
  assert(!response.error, JSON.stringify(response));
  const jobs = await until(() => env.jobs(), rows => rows.every(job => !["RUNNING", "QUEUED"].includes(job.state)));
  assert.equal(jobs[0].state, "CANCELLED"); assert.equal(jobs[0].effect, "unknown");
  assert.equal((await call(env, "recipe.runtime.get", { runId })).result.state, "cancelled");
  assert.deepEqual(env.effects(), [{ value: "cancelled" }]);
  evidence(metadata, "public-cancel-result", { runId, jobs, effects: env.effects(), noImplicitCancelPermission: true });
});

async function broker(metadata, recover = false) {
  const log = fs.openSync(path.join(metadata.directory, `broker-${recover ? "recovered" : "initial"}.log`), "a", 0o600);
  const child = fork(path.resolve("tests/next-python-recipe-fixture.cjs"), [metadata.directory, recover ? "recover" : "fresh"],
    { stdio: ["ignore", log, log, "ipc"], env: { ...process.env } });
  fs.closeSync(log);
  const pending = new Map(); let count = 0;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Private broker ready timeout.")), 30000);
    child.on("message", value => {
      if (value.type === "ready") { clearTimeout(timer); resolve(value); }
      if (pending.has(value.id)) { const request = pending.get(value.id); pending.delete(value.id);
        value.error ? request.reject(Error(value.error)) : request.resolve(value.result); }
    });
    child.once("exit", () => { clearTimeout(timer); reject(Error("Private broker exited."));
      for (const request of pending.values()) request.reject(Error("Private broker exited.")); pending.clear(); });
  });
  const endpoint = await ready;
  return { child, endpoint,
    request(method, input, extra = {}) { const id = ++count;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.send({ id, method, input, ...extra }); }); },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise(resolve => child.once("exit", resolve));
      await this.request("close"); await exited;
    } };
}
test("actual broker SIGKILL after SQL Recipe Python effect recovers standard Runtime/Workflow UNKNOWN, never approval or execution", async t => {
  const metadata = prepare(); let host = await broker(metadata), client = await sdk(host.endpoint.mcp, host.endpoint.token);
  t.after(async () => { await client?.close().catch(() => undefined); await host.close(); });
  const approve = async args => {
    const preview = await host.request("preview", { operation: "recipe.runtime.start", args });
    const decision = rootDecision(metadata, host.endpoint.binding, preview);
    try { decision.authority.approve(decision.grant); await host.request("approve-python", decision.authority.consume(decision.grant)); }
    finally { decision.close(); }
    await host.request("approve-public", { operation: "recipe.runtime.start", args });
  };
  const args = await host.request("args", undefined, { value: "crash", mode: "hold" });
  await approve(args);
  const started = await client.callTool({ name: "capability_call",
    arguments: { operation: "recipe.runtime.start", version: 1, arguments: args } });
  assert(!started.isError, JSON.stringify(started)); const runId = started.structuredContent.result.runId;
  const jobs = await until(() => host.request("jobs"), rows => rows.some(row =>
    row.state === "RUNNING" && Buffer.from(row.stdout, "base64").toString().includes("crash")));
  const pythonPid = jobs[0].pid;
  const exited = new Promise(resolve => host.child.once("exit", resolve)); host.child.kill("SIGKILL"); await exited;
  await client.close().catch(() => undefined); client = undefined;
  await until(() => fs.existsSync(`/proc/${pythonPid}`), exists => !exists);
  host = await broker(metadata, true); client = await sdk(host.endpoint.mcp, host.endpoint.token);
  const recovered = await post(host.endpoint.http, host.endpoint.token, "recipe.runtime.get", { runId }, false);
  assert.equal(recovered.result.state, "unknown", JSON.stringify(recovered));
  const interrupted = await host.request("jobs"); assert.equal(interrupted[0].state, "INTERRUPTED");
  assert.equal(interrupted[0].effect, "unknown");
  const replay = await client.callTool({ name: "capability_call",
    arguments: { operation: "recipe.runtime.start", version: 1, arguments: args } });
  assert(replay.isError);
  assert.deepEqual(fs.readFileSync(path.join(metadata.workspace, "effects.jsonl"), "utf8").trim().split("\n").map(JSON.parse), [{ value: "crash" }]);
  const fresh = await host.request("args", undefined, { value: "after-restart", mode: "complete" });
  await approve(fresh);
  const response = await post(host.endpoint.http, host.endpoint.token, "recipe.runtime.start", fresh);
  assert(!response.error, JSON.stringify(response));
  await until(() => post(host.endpoint.http, host.endpoint.token, "recipe.runtime.get", { runId: response.result.runId }, false),
    read => read.result?.state === "succeeded");
  const effects = fs.readFileSync(path.join(metadata.workspace, "effects.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(effects, [{ value: "crash" }, { value: "after-restart" }]);
  evidence(metadata, "actual-sigkill-recovery-result", { runId, recovered: recovered.result, interrupted,
    freshRunId: response.result.runId, effects, oldApprovalRejected: true, noPidReuseSignalling: true, pythonChildExitedAfterParentPipeLoss: true });
});

test("public SQL Python adapter reuses a genuine old-created conda prefix without provisioning or history changes",
  { skip: !process.env.PKM_TEST_EXISTING_CONDA_PREFIX && "Requires an explicitly supplied genuine old-created synthetic conda prefix." }, async t => {
    const prefix = process.env.PKM_TEST_EXISTING_CONDA_PREFIX, history = path.join(prefix, "conda-meta/history");
    const before = hash(fs.readFileSync(history)), metadata = prepare(prefix), env = await open(metadata);
    t.after(() => env.close());
    const transport = await endpoints(env, t), args = await env.args("real-old-conda");
    await env.approvePython(args); await env.publicRecipes.approve(env.binding, { operation: "recipe.runtime.start", args });
    const started = await transport.client.callTool({ name: "capability_call",
      arguments: { operation: "recipe.runtime.start", version: 1, arguments: args } });
    assert(!started.isError, JSON.stringify(started));
    const runId = started.structuredContent.result.runId;
    await until(() => call(env, "recipe.runtime.get", { runId }), response => response.result?.state === "succeeded");
    assert.equal(JSON.parse(Buffer.from(env.jobs()[0].stdout, "base64").toString()).prefix, prefix);
    assert.equal(hash(fs.readFileSync(history)), before);
    assert.deepEqual(env.effects(), [{ value: "real-old-conda" }]);
    evidence(metadata, "real-old-conda-result", { runId, prefix, historySha256: before, jobs: env.jobs(),
      noProvisioning: true, originalRegistryUnchanged: hash(fs.readFileSync(metadata.registry)) === metadata.originalRegistrySha256 });
  });
